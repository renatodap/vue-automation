import 'server-only';
import { db, loadRoomOverrides } from './db';
import { isRoomId, roomOf } from './rooms';
import { historyGet, historyRegistry, recorderPeriod } from './history-ha';
import { historyKind, normalizeHistory, type HistoryKind, type RecordedState } from './history-normalize';

type Writer = Pick<NonNullable<ReturnType<typeof db>>, 'unsafe'>;
export type HistoryInventory = {
  states: RecordedState[];
  entities: Map<string, { kind: HistoryKind; room: string; attributes: Record<string, unknown> }>;
  timeZone: string;
  temperatureUnit: string;
};

/** Catalog deleted/disabled registered entities too; their recorder rows still matter. */
export async function discoverHistory(): Promise<HistoryInventory> {
  const sql = db();
  if (!sql) throw new Error('History database is not configured');
  const [states, config, overrides, registries] = await Promise.all([
    historyGet<RecordedState[]>('/api/states'),
    historyGet<{ time_zone: string; unit_system: { temperature: string } }>('/api/config'),
    loadRoomOverrides(),
    Promise.allSettled([
      historyRegistry('config/entity_registry/list'),
      historyRegistry('config/device_registry/list'),
      historyRegistry('config/area_registry/list'),
    ]),
  ]);
  const [entityRegistry, devices, areas] = registries.map(r => r.status === 'fulfilled' ? r.value : []);
  const entries = new Map(states.map(s => [s.entity_id, s]));
  for (const entry of entityRegistry) {
    const id = String(entry.entity_id);
    if (!entries.has(id)) entries.set(id, { entity_id: id, state: 'unknown', last_changed: '', attributes: {
      friendly_name: entry.name ?? entry.original_name ?? id,
      device_class: entry.device_class ?? entry.original_device_class,
    } });
  }
  const climateRooms: Record<string, unknown> = process.env.HISTORY_CLIMATE_ROOMS ? JSON.parse(process.env.HISTORY_CLIMATE_ROOMS) : {};
  const entities: HistoryInventory['entities'] = new Map();
  for (const s of entries.values()) {
    const kind = historyKind(s);
    if (!kind) continue;
    const registry = entityRegistry.find(r => r.entity_id === s.entity_id);
    const device = devices.find(r => r.id === registry?.device_id);
    const area = areas.find(r => r.area_id === (registry?.area_id ?? device?.area_id));
    const areaName = String(area?.name ?? '').toLowerCase();
    const areaRoom = ['living room','living'].includes(areaName) ? 'living' : areaName === 'bedroom' ? 'bedroom' : 'unassigned';
    const configured = climateRooms[s.entity_id];
    const room = kind === 'light' ? roomOf(s.entity_id, overrides) : isRoomId(configured) ? configured : areaRoom;
    const attributes = JSON.parse(JSON.stringify(s.attributes)) as Record<string, unknown>;
    entities.set(s.entity_id, { kind, room, attributes });
    await sql`INSERT INTO history_entity (entity_id,kind,name,room_id,unit,attributes)
      VALUES (${s.entity_id},${kind},${String(s.attributes.friendly_name ?? s.entity_id)},${room},
        ${typeof s.attributes.unit_of_measurement === 'string' ? s.attributes.unit_of_measurement : kind === 'climate' ? config.unit_system.temperature : null},${JSON.stringify(attributes)}::text::jsonb)
      ON CONFLICT (entity_id) DO UPDATE SET kind=excluded.kind,name=excluded.name,room_id=excluded.room_id,
        unit=COALESCE(excluded.unit,history_entity.unit),attributes=history_entity.attributes || excluded.attributes,updated_at=now()`;
  }
  // Keep importing IDs seen on previous runs even if no longer in the registry.
  const retained = await sql<{ entity_id: string; kind: HistoryKind; room_id: string; attributes: Record<string, unknown> }[]>`SELECT entity_id,kind,room_id,attributes FROM history_entity`;
  for (const row of retained) if (!entities.has(row.entity_id)) entities.set(row.entity_id, {kind: row.kind,room: row.room_id,attributes: row.attributes});
  await sql`INSERT INTO history_settings(id,time_zone,temperature_unit) VALUES ('ha',${config.time_zone},${config.unit_system.temperature})
    ON CONFLICT(id) DO UPDATE SET time_zone=excluded.time_zone,temperature_unit=excluded.temperature_unit,discovered_at=now()`;
  return { states, entities, timeZone: config.time_zone, temperatureUnit: config.unit_system.temperature };
}

/** Same-key upserts enrich a REST row; replay must never erase websocket details. */
export async function storeHistoryStates(sql: Writer, states: RecordedState[], inventory: HistoryInventory): Promise<number> {
  let count = 0;
  for (const state of states) {
    const entity = inventory.entities.get(state.entity_id);
    const kind = entity?.kind ?? historyKind(state);
    if (!kind) continue;
    const normalized = normalizeHistory(state, kind, inventory.temperatureUnit);
    if (!normalized) continue;
    const r = normalized.row;
    const contextValues = [r.source,r.context_id,r.context_parent_id,r.context_user_id];
    if (normalized.kind === 'scene') {
      const targetIds = entity?.attributes.entity_id;
      const rooms = Array.isArray(targetIds) ? [...new Set(targetIds.map(id => inventory.entities.get(String(id))?.room).filter((room): room is string => !!room))] : [];
      await sql.unsafe(`INSERT INTO scene_application(entity_id,at,source,context_id,context_parent_id,context_user_id,origin,room_ids)
        VALUES ($1,$2::text::timestamptz,$3,$4,$5,$6,'recorder',$7::text::text[])
        ON CONFLICT(entity_id,at) DO UPDATE SET
          source=CASE WHEN excluded.source='unknown' THEN scene_application.source ELSE excluded.source END,
          context_id=COALESCE(scene_application.context_id,excluded.context_id),
          context_parent_id=COALESCE(scene_application.context_parent_id,excluded.context_parent_id),
          context_user_id=COALESCE(scene_application.context_user_id,excluded.context_user_id),
          room_ids=CASE WHEN cardinality(excluded.room_ids)>0 THEN excluded.room_ids ELSE scene_application.room_ids END`,
        [r.entity_id,r.at,...contextValues,`{${rooms.join(',')}}`]);
    } else if (normalized.kind === 'light') {
      const l = normalized.row;
      await sql.unsafe(`INSERT INTO lamp_state_history(entity_id,at,state,source,context_id,context_parent_id,context_user_id,attributes,brightness,color_temp_kelvin,hs_color,xy_color)
        VALUES ($1,$2::text::timestamptz,$3,$4,$5,$6,$7,$8::text::jsonb,$9,$10,$11::text::jsonb,$12::text::jsonb)
        ON CONFLICT(entity_id,at) DO UPDATE SET
          attributes=lamp_state_history.attributes || excluded.attributes,
          brightness=COALESCE(excluded.brightness,lamp_state_history.brightness),
          color_temp_kelvin=COALESCE(excluded.color_temp_kelvin,lamp_state_history.color_temp_kelvin),
          hs_color=COALESCE(excluded.hs_color,lamp_state_history.hs_color),xy_color=COALESCE(excluded.xy_color,lamp_state_history.xy_color),
          source=CASE WHEN excluded.source='unknown' THEN lamp_state_history.source ELSE excluded.source END,
          context_id=COALESCE(excluded.context_id,lamp_state_history.context_id),
          context_parent_id=COALESCE(excluded.context_parent_id,lamp_state_history.context_parent_id),
          context_user_id=COALESCE(excluded.context_user_id,lamp_state_history.context_user_id)`,
        [r.entity_id,r.at,r.state,...contextValues,JSON.stringify(r.attributes),l.brightness,l.color_temp_kelvin,
          l.hs_color ? JSON.stringify(l.hs_color) : null,l.xy_color ? JSON.stringify(l.xy_color) : null]);
    } else {
      const c = normalized.row;
      await sql.unsafe(`INSERT INTO climate_history(entity_id,at,state,source,context_id,context_parent_id,context_user_id,attributes,
          temperature_c,humidity,target_temperature_c,target_temperature_low_c,target_temperature_high_c)
        VALUES ($1,$2::text::timestamptz,$3,$4,$5,$6,$7,$8::text::jsonb,$9,$10,$11,$12,$13)
        ON CONFLICT(entity_id,at) DO UPDATE SET
          attributes=climate_history.attributes || excluded.attributes,
          temperature_c=COALESCE(excluded.temperature_c,climate_history.temperature_c),humidity=COALESCE(excluded.humidity,climate_history.humidity),
          target_temperature_c=COALESCE(excluded.target_temperature_c,climate_history.target_temperature_c),
          target_temperature_low_c=COALESCE(excluded.target_temperature_low_c,climate_history.target_temperature_low_c),
          target_temperature_high_c=COALESCE(excluded.target_temperature_high_c,climate_history.target_temperature_high_c),
          source=CASE WHEN excluded.source='unknown' THEN climate_history.source ELSE excluded.source END,
          context_id=COALESCE(excluded.context_id,climate_history.context_id),
          context_parent_id=COALESCE(excluded.context_parent_id,climate_history.context_parent_id),
          context_user_id=COALESCE(excluded.context_user_id,climate_history.context_user_id)`,
        [r.entity_id,r.at,r.state,...contextValues,JSON.stringify(r.attributes),c.temperature_c,c.humidity,c.target_temperature_c,c.target_temperature_low_c,c.target_temperature_high_c]);
    }
    count++;
  }
  // Require exactly one matching scene. A context shared by several scene
  // calls is ambiguous and must not attribute every lamp to an arbitrary one.
  await sql.unsafe(`UPDATE lamp_state_history l SET scene_id=NULL,source=CASE WHEN context_user_id IS NULL THEN 'unknown' ELSE 'user' END
    WHERE scene_id IS NOT NULL AND context_id IN (SELECT context_id FROM scene_application
      WHERE context_id IS NOT NULL GROUP BY context_id HAVING count(DISTINCT entity_id)>1)`);
  await sql.unsafe(`UPDATE lamp_state_history l SET scene_id=s.entity_id,source='scene'
    FROM (SELECT context_id,min(entity_id) AS entity_id FROM scene_application
      WHERE context_id IS NOT NULL GROUP BY context_id HAVING count(DISTINCT entity_id)=1) s
    WHERE l.context_id=s.context_id AND l.scene_id IS NULL`);
  for (const table of ['lamp_state_history','climate_history','scene_application']) {
    await sql.unsafe(`UPDATE ${table} h SET source='automation' FROM history_context c
      WHERE h.source='unknown' AND (h.context_id=c.context_id OR h.context_parent_id=c.context_id)`);
  }
  return count;
}

export async function syncHistory(options: { start?: string; end?: string; maxDays?: number; onProgress?: (value: unknown) => void } = {}) {
  const sql = db();
  if (!sql) throw new Error('History database is not configured');
  const connection = await sql.reserve();
  const [lock] = await connection`SELECT pg_try_advisory_lock(984217603) AS acquired`;
  if (!lock.acquired) { connection.release(); return { skipped: true, reason: 'already_running' }; }
  try {
    const inventory = await discoverHistory();
    const end = options.end ? new Date(options.end) : new Date(Date.now() - 120_000);
    if (!Number.isFinite(end.getTime()) || end.getTime() > Date.now()) throw new Error('Invalid history end');
    const [checkpoint] = await sql<{ cursor_at: Date | null }[]>`SELECT cursor_at FROM history_sync WHERE id='recorder'`;
    let start: Date;
    if (options.start) start = new Date(options.start);
    else if (checkpoint?.cursor_at) start = new Date(checkpoint.cursor_at.getTime() - 15 * 60_000);
    else {
      // One compact discovery request finds the actual oldest retained event.
      // The import itself always fetches full-fidelity, one-day windows.
      const observations = await recorderPeriod([...inventory.entities.keys()], '1970-01-01T00:00:00Z', end.toISOString(), true);
      const times = observations.map(s => Date.parse(s.last_updated || s.last_changed)).filter(Number.isFinite);
      start = new Date(times.length ? times.reduce((oldest, at) => Math.min(oldest, at), Infinity) - 1 : end.getTime());
      await sql`UPDATE history_settings SET recorder_start_at=${times.length ? start.toISOString() : null} WHERE id='ha'`;
    }
    if (!Number.isFinite(start.getTime()) || start > end) throw new Error('Invalid history start');
    await sql`INSERT INTO history_sync(id) VALUES ('recorder') ON CONFLICT DO NOTHING`;
    let days = 0, observations = 0;
    while (start < end && days < (options.maxDays ?? 3)) {
      const until = new Date(Math.min(start.getTime() + 86_400_000,end.getTime()));
      // HA's start comparison is strict; a small overlap protects boundaries.
      const rows = await recorderPeriod([...inventory.entities.keys()],new Date(start.getTime() - 1).toISOString(),until.toISOString());
      await sql.begin(async tx => {
        observations += await storeHistoryStates(tx,rows,inventory);
        await tx`UPDATE history_sync SET cursor_at=GREATEST(COALESCE(cursor_at,${until.toISOString()}),${until.toISOString()}),
          last_success_at=now(),last_error=NULL WHERE id='recorder'`;
      });
      days++;
      options.onProgress?.({ through: until.toISOString(), observations: rows.length });
      start = until;
    }
    // Rich currently reported attributes can enrich a retained observation at
    // its ORIGINAL last_updated; they are never copied backwards to older rows.
    await sql.begin(tx => storeHistoryStates(tx,inventory.states,inventory));
    // Decouple old taps from scene_meta's cascading delete; never guess user vs automation.
    await sql`INSERT INTO scene_application(entity_id,at,source,origin)
      SELECT entity_id,tapped_at,'unknown','legacy_tap' FROM scene_tap
      ON CONFLICT(entity_id,at) DO NOTHING`;
    await sql`UPDATE history_sync SET last_success_at=now(),last_error=NULL WHERE id='recorder'`;
    return { skipped: false, days, observations, caughtUp: start >= end, through: start.toISOString(),
      entities: inventory.entities.size, timeZone: inventory.timeZone };
  } catch (error) {
    // Error text stays generic; driver errors can contain connection details.
    await sql`INSERT INTO history_sync(id,last_error) VALUES ('recorder','History ingestion failed; retry required')
      ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error`.catch(() => {});
    throw error;
  } finally {
    try { await connection`SELECT pg_advisory_unlock(984217603)`; } finally { connection.release(); }
  }
}
