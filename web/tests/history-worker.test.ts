import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';

// Reuse the connector's existing fake-HA dependency; no production dependency
// is added to the web app just to run a websocket server in tests.
let WebSocketServer: any;
try { WebSocketServer = createRequire(resolve('../mcp/package.json'))('ws').WebSocketServer; } catch { /* optional integration prerequisite */ }
const enabled = Boolean(WebSocketServer) && ['initdb', 'pg_ctl'].every((name) => spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0);
let cluster: string;
let clusterStarted = false;
let sql: ReturnType<typeof postgres>;
let databaseUrl: string;
let haUrl: string;
let server: ReturnType<typeof createServer>;
let sockets: any;
let rejectAuth = false;
let failSnapshot = false;
let stateReads = 0;
let pings = 0;
const children: Array<{ child: ChildProcess; done: Promise<number | null>; output: () => string }> = [];

function command(executable: string, args: string[]) {
  const result = spawnSync(executable, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, `${executable}: ${result.stderr || result.stdout}`);
}

async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 15));
  }
  assert.fail(`Timed out: ${label}\n${children.map((child) => child.output()).join('\n')}`);
}

function worker(fastClock = false) {
  let output = '';
  const child = spawn(process.execPath, [
    '--conditions=react-server', '--import', 'tsx',
    ...(fastClock ? ['--import', resolve('tests/_worker-fast-clock.mjs')] : []),
    'scripts/history-worker.ts',
  ], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: databaseUrl, HA_BASE_URL: haUrl, HA_TOKEN: 'worker-test-secret' },
  });
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', (chunk) => { output += String(chunk); });
  const handle = { child, done: new Promise<number | null>((done) => child.once('exit', done)), output: () => output };
  children.push(handle);
  return handle;
}

async function stopChildren() {
  for (const child of children) if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill('SIGTERM');
  await Promise.all(children.map(async ({ child, done }) => {
    const fallback = setTimeout(() => child.kill('SIGKILL'), 3000);
    await done; clearTimeout(fallback);
  }));
  children.length = 0;
}

before(async () => {
  if (!enabled) return;
  cluster = await mkdtemp(join(tmpdir(), 'vue-worker-test-'));
  command('initdb', ['-D', join(cluster, 'data'), '-A', 'trust', '--no-locale', '-E', 'UTF8']);
  const reserve = createServer();
  await new Promise<void>((done) => reserve.listen(0, '127.0.0.1', done));
  const address = reserve.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done) => reserve.close(() => done()));
  command('pg_ctl', ['-D', join(cluster, 'data'), '-l', join(cluster, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${address.port} -k ${cluster}`, '-w', 'start']);
  clusterStarted = true;
  databaseUrl = `postgres://${encodeURIComponent(userInfo().username)}@127.0.0.1:${address.port}/postgres`;
  sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });
  const migration = await sql.reserve();
  try { await migration.unsafe(await readFile(resolve('../homeassistant/migrations/2026-11-03_history-audit.sql'), 'utf8')); }
  finally { migration.release(); }
  await sql`CREATE TABLE lamp_room(entity_id text PRIMARY KEY,room_id text)`;
  await sql`CREATE TABLE scene_tap(entity_id text,tapped_at timestamptz)`;

  server = createServer((req, res) => {
    const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/api/states') {
      stateReads++;
      if (failSnapshot && stateReads > 1) { res.statusCode = 503; return json({ error: 'snapshot failed' }); }
      return json([]);
    }
    if (req.url === '/api/config') return json({ time_zone: 'UTC', unit_system: { temperature: '°C' } });
    if (req.url?.startsWith('/api/history/period/')) return json([]);
    res.statusCode = 404; json({ error: 'unexpected path' });
  });
  sockets = new WebSocketServer({ server, path: '/api/websocket' });
  sockets.on('connection', (socket: any) => {
    socket.send(JSON.stringify({ type: 'auth_required' }));
    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'auth') return socket.send(JSON.stringify({ type: rejectAuth ? 'auth_invalid' : 'auth_ok' }));
      if (message.type === 'ping') { pings++; return; } // Deliberately half-open: never pong.
      socket.send(JSON.stringify({ type: 'result', id: message.id, success: true, result: message.type === 'subscribe_events' ? null : [] }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const ha = server.address();
  assert.ok(ha && typeof ha !== 'string');
  haUrl = `http://127.0.0.1:${ha.port}`;
});

beforeEach(async () => {
  if (!enabled) return;
  await stopChildren();
  for (const socket of sockets.clients) socket.terminate();
  rejectAuth = false; failSnapshot = false; stateReads = 0; pings = 0;
  await sql`TRUNCATE history_entity,lamp_state_history,climate_history,scene_application,history_sync,history_settings,history_gap,history_context`;
});

after(async () => {
  if (!enabled) return;
  await stopChildren();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>((done) => sockets.close(() => done()));
  await new Promise<void>((done) => server.close(() => done()));
  if (sql) await sql.end({ timeout: 1 });
  if (clusterStarted) command('pg_ctl', ['-D', join(cluster, 'data'), '-m', 'immediate', '-w', 'stop']);
  if (cluster) await rm(cluster, { recursive: true, force: true });
});

test('a duplicate worker exits without corrupting the active worker status or gaps', { skip: !enabled }, async () => {
  const lock = await sql.reserve();
  await lock`SELECT pg_advisory_lock(984217604)`;
  try {
    await sql`INSERT INTO history_sync(id,last_success_at) VALUES ('events','2026-10-01T00:00:00Z')`;
    const duplicate = worker();
    assert.equal(await duplicate.done, 0, duplicate.output());
    assert.match(duplicate.output(), /history_worker_already_running/);
    const [status] = await sql`SELECT last_error,last_success_at FROM history_sync WHERE id='events'`;
    assert.equal(status.last_error, null);
    assert.equal(status.last_success_at.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal((await sql`SELECT * FROM history_gap`).length, 0);
  } finally { await lock`SELECT pg_advisory_unlock(984217604)`; lock.release(); }
});

test('rejected HA authentication leaves a visible gap and never reports the stream connected', { skip: !enabled }, async () => {
  rejectAuth = true;
  const running = worker();
  await until(() => running.output().includes('ha_auth_rejected'), 'HA authentication refusal');
  assert.doesNotMatch(running.output(), /history_live_connected|worker-test-secret/);
  const gaps = await sql`SELECT * FROM history_gap`;
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].ended_at, null);
  assert.equal((await sql`SELECT * FROM history_sync WHERE id='events'`).length, 0);
});

test('subscription acknowledgement cannot close a gap before the snapshot persists', { skip: !enabled }, async () => {
  failSnapshot = true;
  const running = worker();
  assert.equal(await running.done, 1, running.output());
  assert.doesNotMatch(running.output(), /history_live_connected/);
  const gaps = await sql`SELECT * FROM history_gap`;
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].ended_at, null);
});

test('unanswered pings cannot advance success or conceal the beginning of a connection gap', { skip: !enabled }, async () => {
  const running = worker(true);
  await until(() => running.output().includes('history_live_connected'), 'initial durable subscription');
  const [connected] = await sql`SELECT last_success_at FROM history_sync WHERE id='events'`;
  await until(() => pings >= 2, 'two unanswered heartbeats');
  const [afterPings] = await sql`SELECT last_success_at FROM history_sync WHERE id='events'`;
  assert.equal(afterPings.last_success_at.toISOString(), connected.last_success_at.toISOString());
  await until(async () => (await sql`SELECT * FROM history_gap WHERE ended_at IS NULL`).length === 1, 'detected half-open gap');
  const [gap] = await sql`SELECT started_at FROM history_gap WHERE ended_at IS NULL`;
  assert.equal(gap.started_at.toISOString(), connected.last_success_at.toISOString());
});
