import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import postgres from 'postgres';
import { recorderPeriod } from '../src/lib/history-ha';
import { db } from '../src/lib/db';
import { storeHistoryStates, syncHistory, type HistoryInventory } from '../src/lib/history-ingest';
import type { RecordedState } from '../src/lib/history-normalize';

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalHaUrl = process.env.HA_BASE_URL;
const originalHaToken = process.env.HA_TOKEN;
let requests: Array<{ url: URL; init?: RequestInit }> = [];
let historyReplies: RecordedState[][] = [];
let catalog: RecordedState[] = [];
let sql: ReturnType<typeof postgres>;
let cluster: string | undefined;
let clusterStarted = false;
const hasPostgres = ['initdb', 'pg_ctl'].every((name) => spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0);

const START = '2026-10-01T00:00:00.000Z';
const DAY_ONE = '2026-10-02T00:00:00.000Z';
const END = '2026-10-03T00:00:00.000Z';
function lamp(at = '2026-10-01T18:00:00.123456Z', overrides: Partial<RecordedState> = {}): RecordedState {
  return { entity_id: 'light.shelf_lamp', state: 'on', attributes: {}, last_changed: at, last_updated: at, ...overrides };
}
function inventory(): HistoryInventory {
  return {
    states: [], timeZone: 'America/New_York', temperatureUnit: '°C',
    entities: new Map([
      ['light.shelf_lamp', { kind: 'light', room: 'living', attributes: {} }],
      ['scene.movie', { kind: 'scene', room: 'living', attributes: { entity_id: ['light.shelf_lamp'] } }],
      ['scene.dinner', { kind: 'scene', room: 'living', attributes: { entity_id: ['light.shelf_lamp'] } }],
    ]),
  };
}

// Discovery tolerates unavailable registries; fail immediately instead of
// contacting a real Home Assistant websocket while testing the REST importer.
class UnavailableRegistry {
  addEventListener(type: string, callback: () => void) { if (type === 'error') queueMicrotask(callback); }
  close() {}
}

function command(executable: string, args: string[]) {
  const result = spawnSync(executable, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, `${executable} failed: ${result.stderr || result.stdout}`);
}

before(async () => {
  process.env.HA_BASE_URL = 'http://history-test.invalid';
  process.env.HA_TOKEN = 'history-test-token';
  globalThis.WebSocket = UnavailableRegistry as unknown as typeof WebSocket;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname === '/api/states') return Response.json(catalog);
    if (url.pathname === '/api/config') return Response.json({ time_zone: 'America/New_York', unit_system: { temperature: '°C' } });
    if (url.pathname.startsWith('/api/history/period/')) return Response.json([historyReplies.shift() ?? []]);
    throw new Error(`Unexpected request: ${url}`);
  };
  if (!hasPostgres) return;
  cluster = await mkdtemp(join(tmpdir(), 'vue-history-test-'));
  const data = join(cluster, 'data');
  command('initdb', ['-D', data, '-A', 'trust', '--no-locale', '-E', 'UTF8']);
  const reservePort = createServer();
  await new Promise<void>((done) => reservePort.listen(0, '127.0.0.1', done));
  const address = reservePort.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((done) => reservePort.close(() => done()));
  command('pg_ctl', ['-D', data, '-l', join(cluster, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${cluster}`, '-w', 'start']);
  clusterStarted = true;
  process.env.DATABASE_URL = `postgres://${encodeURIComponent(userInfo().username)}@127.0.0.1:${port}/postgres`;
  sql = db()!;
  const migrationConnection = await sql.reserve();
  try {
    await migrationConnection.unsafe(await readFile(resolve('..', 'homeassistant', 'migrations', '2026-11-03_history-audit.sql'), 'utf8'));
  } finally { migrationConnection.release(); }
  await sql`CREATE TABLE IF NOT EXISTS lamp_room(entity_id text PRIMARY KEY, room_id text)`;
  await sql`CREATE TABLE IF NOT EXISTS scene_tap(entity_id text, tapped_at timestamptz)`;
});

beforeEach(async () => {
  requests = []; historyReplies = []; catalog = [];
  if (!hasPostgres) return;
  await sql`TRUNCATE history_entity, lamp_state_history, climate_history, scene_application, history_sync, history_settings, history_gap, scene_tap, lamp_room`;
  await sql`INSERT INTO history_entity(entity_id,kind,name,room_id) VALUES ('light.shelf_lamp','light','Shelf lamp','living')`;
});

after(async () => {
  try { if (sql) await sql.end({ timeout: 1 }); }
  finally {
    if (cluster && clusterStarted) command('pg_ctl', ['-D', join(cluster, 'data'), '-m', 'immediate', '-w', 'stop']);
    if (cluster) await rm(cluster, { recursive: true, force: true });
    globalThis.fetch = originalFetch; globalThis.WebSocket = originalWebSocket;
    for (const [key, value] of Object.entries({ DATABASE_URL: originalDatabaseUrl, HA_BASE_URL: originalHaUrl, HA_TOKEN: originalHaToken })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('full recorder requests include attribute changes, suppress synthetic initial states, and stay GET-only', async () => {
  historyReplies = [[lamp()]];
  const rows = await recorderPeriod(['light.shelf_lamp'], START, END);
  assert.equal(rows.length, 1);
  assert.equal(requests.length, 1);
  const { url, init } = requests[0];
  assert.equal(decodeURIComponent(url.pathname), `/api/history/period/${START}`);
  assert.equal(url.searchParams.get('filter_entity_id'), 'light.shelf_lamp');
  assert.equal(url.searchParams.get('end_time'), END);
  assert.equal(url.searchParams.get('significant_changes_only'), '0');
  assert.equal(url.searchParams.has('skip_initial_state'), true);
  assert.equal(url.searchParams.has('minimal_response'), false);
  assert.equal(url.searchParams.has('no_attributes'), false);
  assert.equal(init?.method ?? 'GET', 'GET');
  assert.equal(init?.body, undefined);
  assert.equal(init?.cache, 'no-store');
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer history-test-token');
});

test('minimal recorder format is used only when explicitly requested and keeps entity ids on reduced rows', async () => {
  historyReplies = [[lamp(), { state: 'off', last_changed: DAY_ONE } as RecordedState]];
  const rows = await recorderPeriod(['light.shelf_lamp'], START, END, true);
  assert.equal(requests[0].url.searchParams.has('minimal_response'), true);
  assert.equal(rows[1].entity_id, 'light.shelf_lamp');
});

test('large entity sets are batched without dropping identifiers', async () => {
  const ids = Array.from({ length: 81 }, (_, i) => `light.lamp_${i}`);
  await recorderPeriod(ids, START, END);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.flatMap(({ url }) => url.searchParams.get('filter_entity_id')!.split(',')), ids);
});

test('replaying poorer REST rows preserves rich websocket attributes and context in Postgres', { skip: !hasPostgres }, async () => {
  const rich = lamp(undefined, { attributes: { brightness: 128, color_temp_kelvin: 2700, hs_color: [20, 50], extra: 'preserved' }, context: { id: 'ctx', user_id: 'user' } });
  await storeHistoryStates(sql, [rich], inventory());
  await storeHistoryStates(sql, [lamp(undefined, { attributes: { friendly_name: 'Shelf lamp' } })], inventory());
  const rows = await sql`SELECT * FROM lamp_state_history`;
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].brightness), 128);
  assert.equal(Number(rows[0].color_temp_kelvin), 2700);
  assert.deepEqual(rows[0].hs_color, [20, 50]);
  assert.equal(rows[0].attributes.extra, 'preserved');
  assert.equal(rows[0].attributes.friendly_name, 'Shelf lamp');
  assert.equal(rows[0].source, 'user');
  assert.equal(rows[0].context_id, 'ctx');
});

test('two same-entity observations within one millisecond remain distinct', { skip: !hasPostgres }, async () => {
  await storeHistoryStates(sql, [lamp('2026-10-01T18:00:00.123456Z'), lamp('2026-10-01T18:00:00.123457Z')], inventory());
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM lamp_state_history`;
  assert.equal(count, 2);
});

test('failed importer day rolls back its observations and cursor; a retry preserves the committed day', { skip: !hasPostgres }, async () => {
  const first = lamp('2026-10-01T18:00:00.123456Z');
  const second = lamp('2026-10-02T18:00:00.123456Z', { state: 'off' });
  const invalid = lamp('invalid timestamp');
  historyReplies = [[first], [second, invalid]];
  await assert.rejects(syncHistory({ start: START, end: END, maxDays: 2 }), /timestamp/);
  const [checkpoint] = await sql`SELECT cursor_at,last_error FROM history_sync WHERE id='recorder'`;
  assert.equal(checkpoint.cursor_at.toISOString(), DAY_ONE);
  assert.ok(checkpoint.last_error);
  assert.equal((await sql`SELECT * FROM lamp_state_history`).length, 1, 'the failed second-day insert must roll back');
  historyReplies = [[first, second], []];
  await syncHistory({ end: END, maxDays: 2 });
  const [repaired] = await sql`SELECT cursor_at,last_error FROM history_sync WHERE id='recorder'`;
  assert.equal(repaired.cursor_at.toISOString(), END);
  assert.equal(repaired.last_error, null);
  assert.equal((await sql`SELECT * FROM lamp_state_history`).length, 2, 'overlap must upsert rather than duplicate observations');
});

test('scene reload cannot overwrite the original activation context', { skip: !hasPostgres }, async () => {
  const activatedAt = '2026-10-01T18:00:00.123456Z';
  const activation = lamp(activatedAt, { entity_id: 'scene.movie', state: activatedAt, context: { id: 'activation-context', user_id: 'user' } });
  const reload = { ...activation, last_updated: '2026-10-02T12:00:00Z', context: { id: 'reload-context' } };
  await storeHistoryStates(sql, [activation], inventory());
  await storeHistoryStates(sql, [reload], inventory());
  const rows = await sql`SELECT * FROM scene_application`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].context_id, 'activation-context');
});

test('a later second scene in one context removes a previously unambiguous lamp attribution', { skip: !hasPostgres }, async () => {
  const at = '2026-10-01T18:00:00.123456Z';
  const scene = lamp(at, { entity_id: 'scene.movie', state: at, context: { id: 'shared-context' } });
  const light = lamp('2026-10-01T18:00:01.123456Z', { context: { id: 'shared-context' } });
  await storeHistoryStates(sql, [scene, light], inventory());
  assert.equal((await sql`SELECT scene_id FROM lamp_state_history`)[0].scene_id, 'scene.movie');
  const secondAt = '2026-10-01T18:00:02.123456Z';
  await storeHistoryStates(sql, [lamp(secondAt, { entity_id: 'scene.dinner', state: secondAt, context: { id: 'shared-context' } })], inventory());
  const [ambiguous] = await sql`SELECT scene_id,source FROM lamp_state_history`;
  assert.equal(ambiguous.scene_id, null);
  assert.equal(ambiguous.source, 'unknown');
});
