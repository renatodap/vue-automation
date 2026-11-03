/** Long-lived Coolify worker: live full-fidelity observations + recorder repair. */
import { loadEnvConfig } from '@next/env';
import { db } from '../src/lib/db';
import { haBaseUrl, haToken } from '../src/lib/env';
import { discoverHistory, storeHistoryStates, syncHistory, type HistoryInventory } from '../src/lib/history-ingest';
import { historyKind, type RecordedState } from '../src/lib/history-normalize';

loadEnvConfig(process.cwd());
let socket: WebSocket | null = null;
let stopping = false;
let queue = Promise.resolve();
let pending = 0;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let gapId: number | null = null;
let inventory: HistoryInventory;
let reconnectAttempt = 0;
let subscribed = false;
let lastPong = Date.now();
let pingId = 100;
const log = (event: string) => console.log(JSON.stringify({at:new Date().toISOString(),event}));
const sql = db();
if (!sql) throw new Error('History database is not configured');
const database = sql;

async function openGap(reason: string) {
  if (gapId !== null) return;
  const [gap] = await database`INSERT INTO history_gap(started_at,reason)
    VALUES (COALESCE((SELECT last_success_at FROM history_sync WHERE id='events'),now()),${reason}) RETURNING id`;
  gapId = Number(gap.id);
}
async function fail() {
  if (stopping) return;
  stopping = true;
  log('history_worker_failed_restart_required');
  socket?.close(); clearTimeout(reconnect);
  await openGap('Live history persistence failed; restart and recorder repair required').catch(() => {});
  await database`UPDATE history_sync SET last_error='Live history worker failed; restart required' WHERE id='events'`.catch(() => {});
  await database.end({timeout:5});
  process.exit(1);
}
function enqueue(task: () => Promise<void>) {
  pending++;
  if (pending > 10_000) { void fail(); return; }
  queue = queue.then(task).then(() => {pending--;}).catch(fail);
}
function connect() {
  if (stopping) return;
  subscribed = false;
  socket = new WebSocket(haBaseUrl().replace(/^http/,'ws') + '/api/websocket');
  const current = socket;
  const authTimeout = setTimeout(() => current.close(), 15_000);
  current.addEventListener('message', event => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(String(event.data)); } catch { current.close(); return; }
    const receivedAt = new Date().toISOString();
    if (msg.type === 'auth_required') current.send(JSON.stringify({type:'auth',access_token:haToken()}));
    if (msg.type === 'auth_invalid') { log('ha_auth_rejected'); current.close(); }
    if (msg.type === 'auth_ok') current.send(JSON.stringify({id:1,type:'subscribe_events',event_type:'state_changed'}));
    if (msg.type === 'pong' && subscribed && current === socket) {
      lastPong = Date.now();
      // Sending a ping proves nothing. Only an acknowledged message can move
      // the durable success marker used as the start of a connection gap.
      enqueue(async () => { await database`UPDATE history_sync SET last_success_at=${receivedAt}::text::timestamptz WHERE id='events'`; });
    }
    if (msg.type === 'result' && msg.id === 1) {
      if (!msg.success) { current.close(); return; }
      clearTimeout(authTimeout); subscribed = true; reconnectAttempt = 0; lastPong = Date.now();
      enqueue(async () => {
        // Keep the gap open until the first durable snapshot succeeds. Events
        // received during discovery stay behind this task in the same queue.
        inventory = await discoverHistory();
        await database.begin(async tx => {
          await storeHistoryStates(tx,inventory.states,inventory);
          if (gapId !== null) await tx`UPDATE history_gap SET ended_at=${receivedAt}::text::timestamptz WHERE id=${gapId}`;
          await tx`INSERT INTO history_sync(id,last_success_at) VALUES ('events',${receivedAt}::text::timestamptz) ON CONFLICT(id)
            DO UPDATE SET last_success_at=excluded.last_success_at,last_error=NULL`;
        });
        gapId = null;
        log('history_live_connected');
      });
    }
    if (msg.type === 'event') {
      const eventData = msg.event as { data?: { new_state?: RecordedState | null }; time_fired?: string };
      const state = eventData?.data?.new_state;
      if (!state) return;
      enqueue(async () => {
        if (state.entity_id.startsWith('automation.') && state.context?.id &&
          typeof state.attributes.last_triggered === 'string' &&
          Math.abs(Date.parse(state.attributes.last_triggered) - Date.parse(state.last_updated || state.last_changed)) < 1000) {
          await database`INSERT INTO history_context(context_id,entity_id,at,source)
            VALUES (${state.context.id},${state.entity_id},${state.last_updated || state.last_changed}::text::timestamptz,'automation') ON CONFLICT DO NOTHING`;
        }
        const kind = historyKind(state);
        if (kind) {
          if (!inventory.entities.has(state.entity_id)) inventory = await discoverHistory();
          await database.begin(tx => storeHistoryStates(tx,[state],inventory));
        }
        await database`UPDATE history_sync SET last_success_at=${receivedAt}::text::timestamptz,
          cursor_at=${eventData.time_fired ?? receivedAt}::text::timestamptz,last_error=NULL WHERE id='events'`;
      });
    }
  });
  current.addEventListener('error', () => current.close());
  current.addEventListener('close', () => {
    clearTimeout(authTimeout); subscribed = false;
    if (stopping) return;
    enqueue(() => openGap('Live HA connection interrupted; REST may omit attributes or context during this interval'));
    reconnect = setTimeout(connect,Math.min(60_000,1000 * 2 ** Math.min(reconnectAttempt++,6)));
  });
}

async function main() {
  // A second replica must not mark the first replica's healthy stream as a gap.
  const lockConnection = await database.reserve();
  const [lock] = await lockConnection`SELECT pg_try_advisory_lock(984217604) AS acquired`;
  if (!lock.acquired) {
    // A spare replica has no authority to mark the owner's stream unhealthy.
    lockConnection.release(); log('history_worker_already_running');
    await database.end({timeout:5}); return;
  }
  inventory = await discoverHistory();
  const [oldGap] = await database`SELECT id FROM history_gap WHERE ended_at IS NULL ORDER BY id LIMIT 1`;
  gapId = oldGap ? Number(oldGap.id) : null;
  await openGap('History worker was not connected; REST may omit attributes or context');
  connect();
  let syncing = false;
  const reconcile = async () => {
    if (syncing || stopping) return;
    syncing = true;
    try {
      await syncHistory({maxDays:3});
      if (!stopping) enqueue(async () => { inventory = await discoverHistory(); });
      log('history_reconciled');
    }
    catch { log('history_reconciliation_failed_will_retry'); }
    finally { syncing = false; }
  };
  void reconcile();
  const syncTimer = setInterval(() => void reconcile(),180_000);
  const heartbeat = setInterval(() => {
    if (!subscribed || !socket) return;
    if (Date.now() - lastPong > 90_000) { socket.close(); return; }
    socket.send(JSON.stringify({id:pingId++,type:'ping'}));
  },30_000);
  const stop = async () => {
    stopping = true; clearInterval(syncTimer); clearInterval(heartbeat); clearTimeout(reconnect);
    socket?.close(); await queue; await openGap('History worker stopped; REST may omit attributes or context');
    await lockConnection`SELECT pg_advisory_unlock(984217604)`; lockConnection.release();
    await database.end({timeout:5}); process.exit(0);
  };
  process.once('SIGTERM',() => void stop()); process.once('SIGINT',() => void stop());
}
main().catch(() => void fail());
