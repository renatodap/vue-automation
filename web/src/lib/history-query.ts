import "server-only";
import { db } from "./db";
import { isRoomId, roomOf } from "./rooms";
import { historyCursor, type HistoryQuery } from "./history-params";
import type { ClimateHistoryEvent, HistoryEntity, HistoryMeta, HistoryPage, HistorySource, LampHistoryEvent, SceneHistoryEvent } from "./history-types";

export class HistoryUnavailableError extends Error {
  constructor() { super("History is unavailable. The history database may be unconfigured, unreachable, or awaiting its migration. Live light controls still work independently."); }
}
export class HistoryTooLargeError extends Error {
  constructor() { super("This window contains too many observations to analyze safely. Choose fewer days."); }
}
type RawRow = Record<string, unknown>;
export type HistoryKind = "lamps" | "climate" | "scenes";
const tables = { lamps: "lamp_state_history", climate: "climate_history", scenes: "scene_application" } as const;
const kinds = { lamps: ["light"], climate: ["temperature", "humidity", "climate"], scenes: ["scene"] };

/** Same activation observed by two sources, with the raw audit rows retained. */
function coalescedScene(sql: NonNullable<ReturnType<typeof db>>) {
  return sql`(h.origin <> 'legacy_tap' OR NOT EXISTS (
    SELECT 1 FROM scene_application observed WHERE observed.entity_id = h.entity_id
      AND observed.origin <> 'legacy_tap'
      AND observed.at BETWEEN h.at - interval '5 seconds' AND h.at + interval '5 seconds'
  ))`;
}


const instant = (value: unknown): string | null => value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null;
const number = (value: unknown): number | null => value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
const pair = (value: unknown): [number, number] | null => Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number" && Number.isFinite(n)) ? [value[0], value[1]] : null;
const source = (value: unknown): HistorySource => value === "user" || value === "automation" || value === "scene" ? value : "unknown";
const context = (row: RawRow) => ({ source: source(row.source), contextId: row.context_id as string | null, contextParentId: row.context_parent_id as string | null, contextUserId: row.context_user_id as string | null });
export function mapHistoryEntity(row: RawRow): HistoryEntity {
  const entityId = String(row.entity_id);
  return { entityId, kind: row.kind as HistoryEntity["kind"], name: String(row.name), room: isRoomId(row.room_id) ? row.room_id : row.kind === "light" ? roomOf(entityId) : "unassigned", unit: typeof row.unit === "string" ? row.unit : null };
}
export function mapLampEvent(row: RawRow): LampHistoryEvent {
  return { ...context(row), entityId: String(row.entity_id), at: instant(row.at)!, state: String(row.state), brightness: number(row.brightness), kelvin: number(row.color_temp_kelvin), hs: pair(row.hs_color), xy: pair(row.xy_color), sceneId: typeof row.scene_id === "string" ? row.scene_id : null };
}
export function mapClimateEvent(row: RawRow): ClimateHistoryEvent {
  return { ...context(row), entityId: String(row.entity_id), at: instant(row.at)!, state: String(row.state), temperatureC: number(row.temperature_c), humidity: number(row.humidity), targetTemperatureC: number(row.target_temperature_c), targetTemperatureLowC: number(row.target_temperature_low_c), targetTemperatureHighC: number(row.target_temperature_high_c) };
}
export function mapSceneEvent(row: RawRow): SceneHistoryEvent {
  return { ...context(row), entityId: String(row.entity_id), at: instant(row.at)!, roomIds: Array.isArray(row.room_ids) ? row.room_ids.filter(isRoomId) : [], origin: row.origin as SceneHistoryEvent["origin"] };
}

export function historyTimeZone(configured?: unknown): string {
  for (const candidate of [process.env.HISTORY_TIME_ZONE, configured, "America/Indiana/Indianapolis"]) {
    if (typeof candidate !== "string" || !candidate) continue;
    try { new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(); return candidate; } catch { /* Try the discovered HA timezone next. */ }
  }
  return "UTC";
}

async function metadata(sql: NonNullable<ReturnType<typeof db>>, start: string, end: string, now: Date): Promise<HistoryMeta> {
  const [syncRows, settingsRows, gapRows] = await Promise.all([
    sql`SELECT cursor_at, last_success_at, last_error FROM history_sync WHERE id = 'recorder'`,
    sql`SELECT time_zone, recorder_start_at, retention_days FROM history_settings WHERE id = 'ha'`,
    sql`SELECT started_at, ended_at, reason FROM history_gap WHERE started_at < ${end}::text::timestamptz AND COALESCE(ended_at, ${now.toISOString()}::text::timestamptz) > ${start}::text::timestamptz ORDER BY started_at`,
  ]);
  const sync = syncRows[0];
  const settings = settingsRows[0];
  const cursorAt = instant(sync?.cursor_at);
  const lastSuccessAt = instant(sync?.last_success_at);
  const lagSeconds = cursorAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(cursorAt)) / 1000)) : null;
  return {
    start, end, timeZone: historyTimeZone(settings?.time_zone), generatedAt: now.toISOString(),
    sync: { status: sync?.last_error ? "error" : !lastSuccessAt ? "pending" : lagSeconds !== null && lagSeconds > 900 ? "delayed" : "current", lastSuccessAt, cursorAt, lagSeconds },
    coverage: { firstAt: null, lastAt: null, recorderStartAt: instant(settings?.recorder_start_at), retentionDays: number(settings?.retention_days), complete: false, gaps: gapRows.map((r) => ({ start: instant(r.started_at)!, end: instant(r.ended_at), reason: String(r.reason) })) },
  };
}

export async function queryHistory<K extends HistoryKind>(kind: K, query: HistoryQuery): Promise<HistoryPage<K extends "lamps" ? LampHistoryEvent : K extends "climate" ? ClimateHistoryEvent : SceneHistoryEvent>> {
  try {
    const sql = db();
    if (!sql) throw new HistoryUnavailableError();
    const { start, end, entityId, room, limit, cursor } = query;
    const tableName: string = tables[kind];
    const entityKinds: string[] = kinds[kind];
    const roomFilter = kind === "scenes"
      ? sql`(${room}::text IS NULL OR ${room} = ANY(h.room_ids))`
      : sql`(${room}::text IS NULL OR COALESCE(e.room_id, 'unassigned') = ${room})`;
    // Keep the legacy tap audit row, but do not count a nearby recorder/app
    // observation of that same activation twice in the displayed timeline.
    const coalesced = kind === "scenes"
      ? coalescedScene(sql)
      : sql`TRUE`;
    // The archive retains attribute-only observations. The timeline may request
    // state changes; look before the window/cursor too so page boundaries never
    // turn an unchanged observation into a false switch. The entity/time primary
    // key supports this predecessor lookup without losing timestamp precision.
    const transitionFilter = kind === "lamps" && query.transitionsOnly
      ? sql`h.state IS DISTINCT FROM (SELECT previous.state FROM lamp_state_history previous WHERE previous.entity_id = h.entity_id AND previous.at < h.at ORDER BY previous.at DESC LIMIT 1)`
      : sql`TRUE`;
    const baseFilter = sql`h.at >= ${start}::text::timestamptz AND h.at < ${end}::text::timestamptz AND (${entityId}::text IS NULL OR h.entity_id = ${entityId}) AND ${roomFilter} AND ${coalesced} AND ${transitionFilter}`;
    const [rawEntities, rawRows, bounds, meta] = await Promise.all([
      sql`SELECT * FROM history_entity WHERE kind IN ${sql(entityKinds)} AND (${entityId}::text IS NULL OR entity_id = ${entityId}) AND (${room}::text IS NULL OR COALESCE(room_id, 'unassigned') = ${room} OR kind = 'scene') ORDER BY entity_id`,
      sql`SELECT h.*, to_char(h.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM ${sql(tableName)} h LEFT JOIN history_entity e ON e.entity_id = h.entity_id WHERE ${baseFilter} ${cursor ? sql`AND (h.at, h.entity_id) < (${cursor.at}::text::timestamptz, ${cursor.entityId})` : sql``} ORDER BY h.at DESC, h.entity_id DESC LIMIT ${limit + 1}`,
      sql`SELECT MIN(h.at) AS first_at, MAX(h.at) AS last_at FROM ${sql(tableName)} h LEFT JOIN history_entity e ON e.entity_id = h.entity_id WHERE ${baseFilter}`,
      metadata(sql, start, end, new Date()),
    ]);
    const entities = rawEntities.map(mapHistoryEntity);
    const map = kind === "lamps" ? mapLampEvent : kind === "climate" ? mapClimateEvent : mapSceneEvent;
    const rows = rawRows.slice(0, limit).map((row) => map(row));
    return {
      ...meta, ok: true, entities, rows, nextCursor: rawRows.length > limit && rows.length ? historyCursor(rows[rows.length - 1]) : null,
      coverage: { ...meta.coverage, firstAt: instant(bounds[0]?.first_at), lastAt: instant(bounds[0]?.last_at) },
      availability: !entities.length ? kind === "climate" ? "no_sensors" : "no_entities" : !bounds[0]?.first_at ? "no_history" : "available",
    } as HistoryPage<K extends "lamps" ? LampHistoryEvent : K extends "climate" ? ClimateHistoryEvent : SceneHistoryEvent>;
  } catch (error) {
    if (error instanceof HistoryUnavailableError) throw error;
    throw new HistoryUnavailableError();
  }
}

export type InsightsInput = {
  meta: HistoryMeta;
  entities: HistoryEntity[];
  lamps: LampHistoryEvent[];
  climate: ClimateHistoryEvent[];
  scenes: SceneHistoryEvent[];
};

/** Filter brightness-only changes in SQL before applying the bounded analysis. */
export async function queryInsights(start: string, end: string, room: string | null): Promise<InsightsInput> {
  try {
    const sql = db();
    if (!sql) throw new HistoryUnavailableError();
    const [rawEntities, lamps, climate, scenes, meta] = await Promise.all([
      sql`SELECT * FROM history_entity WHERE (${room}::text IS NULL OR COALESCE(room_id, 'unassigned') = ${room} OR kind = 'scene') ORDER BY entity_id`,
      sql`WITH observations AS (
        SELECT h.* FROM lamp_state_history h JOIN history_entity e USING(entity_id) WHERE h.at >= ${start}::text::timestamptz AND h.at < ${end}::text::timestamptz AND (${room}::text IS NULL OR COALESCE(e.room_id, 'unassigned') = ${room})
        UNION ALL
        SELECT baseline.* FROM history_entity e CROSS JOIN LATERAL (SELECT h.* FROM lamp_state_history h WHERE h.entity_id = e.entity_id AND h.at < ${start}::text::timestamptz ORDER BY at DESC LIMIT 1) baseline WHERE e.kind = 'light' AND (${room}::text IS NULL OR COALESCE(e.room_id, 'unassigned') = ${room})
      ), changes AS (SELECT *, LAG(state) OVER (PARTITION BY entity_id ORDER BY at) AS previous_state FROM observations)
      SELECT * FROM changes WHERE previous_state IS DISTINCT FROM state ORDER BY at, entity_id LIMIT 100001`,
      sql`SELECT h.* FROM climate_history h JOIN history_entity e USING(entity_id) WHERE h.at >= ${start}::text::timestamptz AND h.at < ${end}::text::timestamptz AND (${room}::text IS NULL OR COALESCE(e.room_id, 'unassigned') = ${room}) ORDER BY at, entity_id LIMIT 100001`,
      sql`SELECT h.* FROM scene_application h WHERE h.at >= ${start}::text::timestamptz AND h.at < ${end}::text::timestamptz AND (${room}::text IS NULL OR ${room} = ANY(h.room_ids)) AND ${coalescedScene(sql)} ORDER BY h.at, h.entity_id LIMIT 100001`,
      metadata(sql, start, end, new Date()),
    ]);
    if ([lamps, climate, scenes].some((rows) => rows.length > 100000)) throw new HistoryTooLargeError();
    const firsts = [lamps.find((r) => Date.parse(instant(r.at)!) >= Date.parse(start)), climate[0], scenes[0]].map((r) => instant(r?.at)).filter((at): at is string => at !== null).sort();
    const lasts = [lamps.at(-1), climate.at(-1), scenes.at(-1)].map((r) => instant(r?.at)).filter((at): at is string => at !== null && Date.parse(at) >= Date.parse(start)).sort();
    return { meta: { ...meta, coverage: { ...meta.coverage, firstAt: firsts[0] ?? null, lastAt: lasts.at(-1) ?? null } }, entities: rawEntities.map(mapHistoryEntity), lamps: lamps.map(mapLampEvent), climate: climate.map(mapClimateEvent), scenes: scenes.map(mapSceneEvent) };
  } catch (error) {
    if (error instanceof HistoryUnavailableError || error instanceof HistoryTooLargeError) throw error;
    throw new HistoryUnavailableError();
  }
}
