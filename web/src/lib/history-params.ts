import { isRoomId, type RoomId } from "./rooms";

export class HistoryQueryError extends Error {}
export type HistoryQuery = {
  start: string;
  end: string;
  entityId: string | null;
  room: RoomId | null;
  limit: number;
  transitionsOnly: boolean;
  cursor: { at: string; entityId: string } | null;
};
const DAY = 86_400_000;
const ENTITY = /^(light|sensor|climate|scene)\.[a-z0-9_]+$/;

/** ISO instants must include an offset; reject calendar normalization such as Feb 30. */
export function isHistoryInstant(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, offset] = match;
  const yearN = Number(year), monthN = Number(month), dayN = Number(day);
  const maxDay = new Date(Date.UTC(yearN, monthN, 0)).getUTCDate();
  return yearN >= 1970 && monthN >= 1 && monthN <= 12 && dayN >= 1 && dayN <= maxDay &&
    Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60 &&
    (offset === "Z" || (Number(offset.slice(1, 3)) < 24 && Number(offset.slice(4)) < 60));
}

export function parseHistoryQuery(params: URLSearchParams, now = new Date()): HistoryQuery {
  const end = params.get("end") ?? now.toISOString();
  if (!isHistoryInstant(end)) throw new HistoryQueryError("end must be an ISO timestamp with a timezone.");
  const start = params.get("start") ?? new Date(Date.parse(end) - 7 * DAY).toISOString();
  if (!isHistoryInstant(start)) throw new HistoryQueryError("start must be an ISO timestamp with a timezone.");
  const range = Date.parse(end) - Date.parse(start);
  if (range <= 0 || range > 31 * DAY) throw new HistoryQueryError("Choose a history window greater than zero and no longer than 31 days.");
  const entityId = params.get("entity_id");
  if (entityId !== null && !ENTITY.test(entityId)) throw new HistoryQueryError("entity_id must name a light, sensor, climate, or scene entity.");
  const room = parseRoom(params);
  const rawLimit = params.get("limit") ?? "500";
  const limit = Number(rawLimit);
  if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new HistoryQueryError("limit must be an integer from 1 to 1000.");
  const transitionsOnly = params.get("transitions_only") ?? "false";
  if (transitionsOnly !== "true" && transitionsOnly !== "false") throw new HistoryQueryError("transitions_only must be true or false.");
  const rawCursor = params.get("cursor");
  let cursor: HistoryQuery["cursor"] = null;
  if (rawCursor !== null) {
    try {
      if (!rawCursor || rawCursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(rawCursor)) throw new Error();
      const parsed: unknown = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8"));
      if (!parsed || typeof parsed !== "object") throw new Error();
      const c = parsed as Record<string, unknown>;
      if (typeof c.at !== "string" || !isHistoryInstant(c.at) || typeof c.entityId !== "string" || !ENTITY.test(c.entityId)) throw new Error();
      if (Date.parse(c.at) < Date.parse(start) || Date.parse(c.at) >= Date.parse(end)) throw new Error();
      cursor = { at: c.at, entityId: c.entityId };
    } catch { throw new HistoryQueryError("cursor is invalid for this history window."); }
  }
  return { start, end, entityId, room, limit, transitionsOnly: transitionsOnly === "true", cursor };
}

export function parseRoom(params: URLSearchParams): RoomId | null {
  const room = params.get("room") ?? params.get("room_id");
  if (params.has("room") && params.has("room_id") && params.get("room") !== params.get("room_id")) throw new HistoryQueryError("room and room_id must agree.");
  if (room !== null && !isRoomId(room)) throw new HistoryQueryError("room must be living, bedroom, or unassigned.");
  return room;
}

export function parseInsightsQuery(params: URLSearchParams, now = new Date()) {
  const rawDays = params.get("days") ?? "30";
  const days = Number(rawDays);
  if (!/^\d+$/.test(rawDays) || !Number.isSafeInteger(days) || days < 1 || days > 90) throw new HistoryQueryError("days must be an integer from 1 to 90.");
  return { start: new Date(now.getTime() - days * DAY).toISOString(), end: now.toISOString(), room: parseRoom(params), days };
}

export function historyCursor(row: { at: string; entityId: string }): string {
  return Buffer.from(JSON.stringify({ at: row.at, entityId: row.entityId })).toString("base64url");
}
