/** Bounded inputs for the named historical reads; no method or path is caller-controlled. */
export class HistoryInputError extends Error {}

const DAY_MS = 86_400_000;
const ROOMS = ["living", "bedroom", "unassigned"] as const;
export type HistoryRoom = (typeof ROOMS)[number];

export type HistoryOptions = {
  entity_id?: string;
  room?: HistoryRoom;
  start: string;
  end: string;
  limit: number;
  cursor?: string;
};

export type RoomInsightOptions = { room?: HistoryRoom; days: number };

const roomSchema = {
  type: "string", enum: ROOMS,
  description: "Optional room filter: living, bedroom or unassigned.",
};

export function historyInputSchema(kind: "light" | "climate") {
  const domain = kind === "light" ? "light" : "(?:sensor|climate)";
  return {
    type: "object", additionalProperties: false,
    properties: {
      entity_id: {
        type: "string", pattern: `^${domain}\\.[a-z0-9_]+$`, maxLength: 255,
        description: kind === "light"
          ? "Optional exact light entity id; omit for all recorded lamps."
          : "Optional exact sensor or climate entity id; omit for all recorded climate entities.",
      },
      room: roomSchema,
      start: {
        type: "string", format: "date-time",
        description: "Inclusive ISO timestamp with timezone; defaults to seven days before end. Maximum window: 31 days.",
      },
      end: {
        type: "string", format: "date-time",
        description: "Exclusive ISO timestamp with timezone; defaults to now. Reuse the returned window when paging.",
      },
      limit: { type: "integer", minimum: 1, maximum: 1000, default: 500, description: "Page size, 1–1000 (default 500)." },
      cursor: {
        type: "string", minLength: 1, maxLength: 2048, pattern: "^[A-Za-z0-9_-]+$",
        description: "Opaque nextCursor from the previous page; keep the same filters and start/end.",
      },
    },
  };
}

export const roomInsightInputSchema = {
  type: "object", additionalProperties: false,
  properties: {
    room: roomSchema,
    days: { type: "integer", minimum: 1, maximum: 90, default: 30, description: "Days of observations to summarize, 1–90 (default 30)." },
  },
};

function allowedKeys(args: Record<string, unknown>, allowed: string[]) {
  const unexpected = Object.keys(args).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new HistoryInputError(`Unknown argument: ${unexpected}.`);
}

function optionalString(args: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.length || value.length > maxLength) {
    throw new HistoryInputError(`${key} must be a nonempty string of at most ${maxLength} characters.`);
  }
  return value;
}

function room(args: Record<string, unknown>): HistoryRoom | undefined {
  const value = optionalString(args, "room", 32);
  if (value !== undefined && !ROOMS.includes(value as HistoryRoom)) {
    throw new HistoryInputError("room must be living, bedroom or unassigned.");
  }
  return value as HistoryRoom | undefined;
}

function integer(args: Record<string, unknown>, key: string, fallback: number, maximum: number): number {
  const value = args[key] === undefined ? fallback : args[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new HistoryInputError(`${key} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function timestamp(args: Record<string, unknown>, key: string): number | undefined {
  const value = optionalString(args, key, 64);
  if (value === undefined) return undefined;
  // Date.parse alone accepts missing zones and rolls 30 February into March.
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,6})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) throw new HistoryInputError(`${key} must be an ISO timestamp with an explicit timezone.`);
  const [, year, month, day] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) || !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
  ) {
    throw new HistoryInputError(`${key} must be a valid calendar timestamp.`);
  }
  return parsed;
}

export function parseHistoryOptions(args: Record<string, unknown>, kind: "light" | "climate"): HistoryOptions {
  allowedKeys(args, ["entity_id", "room", "start", "end", "limit", "cursor"]);
  const domain = kind === "light" ? "light" : "(?:sensor|climate)";
  const entityId = optionalString(args, "entity_id", 255);
  if (entityId !== undefined && !new RegExp(`^${domain}\\.[a-z0-9_]+$`).test(entityId)) {
    throw new HistoryInputError(kind === "light"
      ? "entity_id must be an exact light entity id, such as light.living_room."
      : "entity_id must be an exact sensor or climate entity id, such as sensor.living_room_temperature.");
  }
  const end = timestamp(args, "end") ?? Date.now();
  const start = timestamp(args, "start") ?? end - 7 * DAY_MS;
  if (end <= start || end - start > 31 * DAY_MS) {
    throw new HistoryInputError("end must follow start, with a history window of at most 31 days.");
  }
  const cursor = optionalString(args, "cursor", 2048);
  if (cursor !== undefined && !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new HistoryInputError("cursor must be the opaque nextCursor returned by a previous page.");
  }
  return {
    entity_id: entityId, room: room(args),
    // Keep explicit microseconds intact. JS Date only retains milliseconds,
    // while PostgreSQL and Home Assistant preserve finer event boundaries.
    start: typeof args.start === "string" ? args.start : new Date(start).toISOString(),
    end: typeof args.end === "string" ? args.end : new Date(end).toISOString(),
    limit: integer(args, "limit", 500, 1000), cursor,
  };
}

export function parseRoomInsightOptions(args: Record<string, unknown>): RoomInsightOptions {
  allowedKeys(args, ["room", "days"]);
  return { room: room(args), days: integer(args, "days", 30, 90) };
}
