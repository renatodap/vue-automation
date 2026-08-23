import type { LampPatch, LampView } from "./types";

/**
 * Which room each bulb is in, and the three looks the whole app agrees on.
 *
 * The map below is the BASELINE, compiled into the bundle. Postgres may shadow
 * it per-bulb (`lamp_room`, written by the connector's `set_lamp_room`), and
 * resolution runs most-specific-first:
 *
 *     override ?? ASSIGNMENTS[entityId] ?? "unassigned"
 *
 * Keeping the static map underneath is what lets invariant 9 survive a database
 * outage: no override rows means resolution falls straight through to this map
 * and the grouping is identical to what it would have been. Home Assistant owns
 * areas but exposes them only over the WebSocket API, which this app does not
 * speak — see the 2026-08-23 design doc for why they are not the source here.
 *
 * This is still the right place to record a PERMANENT assignment; the override
 * table exists so a bulb can be moved without a deploy. Anything in neither
 * lands in "Unassigned" rather than disappearing, so a bulb paired at 2am still
 * shows up and can still be switched off.
 */

export type RoomId = "living" | "bedroom" | "unassigned";

export type Room = { id: RoomId; name: string };

export const ROOMS: Room[] = [
  { id: "living", name: "Living Room" },
  { id: "bedroom", name: "Bedroom" },
  { id: "unassigned", name: "Unassigned" },
];

const ASSIGNMENTS: Record<string, RoomId> = {
  "light.abajour": "living",
  "light.floor_lamp": "living",
  "light.shelf_lamp": "living",
  "light.tv_lamp": "living",
  "light.0xb4e8428fd6070000": "living", // kitchen pendant 1
  "light.0xb4e8428ffab10000": "living", // kitchen pendant 2
  "light.0xa4c138939b2d0b23": "living", // keyboard strip — the LED strip
  "light.0xb4e84290af510000": "bedroom", // bedroom floor lamp
  "light.0xb4e8428f428b0000": "bedroom", // bedroom lamp
  "light.0xb4e842918a2f0000": "bedroom", // bedroom bedside lamp
};

/** True for a room the app can actually render. Rooms are a closed set. */
export function isRoomId(value: unknown): value is RoomId {
  return typeof value === "string" && ROOMS.some((r) => r.id === value);
}

/**
 * Which room a bulb is in.
 *
 * `overrides` is whatever `lamp_room` held at read time, and is expected to be
 * absent or empty whenever Postgres could not be reached. Unknown room ids in
 * it are ignored rather than trusted, so a value written before a room was
 * renamed cannot strand a lamp in a room nothing renders.
 */
export function roomOf(entityId: string, overrides?: Record<string, string>): RoomId {
  const override = overrides?.[entityId];
  if (isRoomId(override)) return override;
  return ASSIGNMENTS[entityId] ?? "unassigned";
}

/**
 * Rooms that actually have a bulb in them, in display order.
 *
 * Prefers the `room` the state route already resolved, and falls back to the
 * static map for any lamp that arrived without one. The fallback is what keeps
 * the compiled-in map a real floor rather than a decorative one — a LampView
 * built by some future path that does not go through a state route still lands
 * in the right room.
 */
export function groupByRoom(lamps: LampView[]): { room: Room; lamps: LampView[] }[] {
  const roomFor = (lamp: LampView): RoomId =>
    isRoomId(lamp.room) ? lamp.room : roomOf(lamp.entityId);

  return ROOMS.map((room) => ({
    room,
    lamps: lamps.filter((l) => roomFor(l) === room.id),
  })).filter((g) => g.lamps.length > 0);
}

// ------------------------------------------------------------------- looks

/**
 * The LED strip runs at full brightness in the two dim looks.
 *
 * It sits behind a desk rather than in the open, so the level that reads as
 * "dim" on a lamp in the middle of the room reads as "off" on this one.
 */
const STRIP = "light.0xa4c138939b2d0b23";

export type LookId = "orange" | "white" | "warm";

export type Look = {
  id: LookId;
  label: string;
  /** The swatch the button paints itself with. */
  css: string;
};

export const LOOKS: Look[] = [
  { id: "orange", label: "Orange", css: "rgb(255 123 0)" },
  { id: "white", label: "White", css: "rgb(255 206 166)" },
  { id: "warm", label: "Warm", css: "rgb(255 146 39)" },
];

/**
 * One lamp's settings for a look, in the shape that reproduces them.
 *
 * These are the same numbers the Orange 70% / Bright / Warm 20% scenes store,
 * and that is the point: tapping Orange on a room has to land somewhere the
 * Orange scene would also have put it, or the two controls quietly disagree.
 *
 * Kelvin is what we ASK for. The Third Reality bulbs advertise a 2000K floor
 * they cannot physically reach and settle at 2202K instead — asking for 2000
 * is how you get the warmest white each bulb actually has, including the strip,
 * which really does reach 2000.
 */
export function lookPatch(look: LookId, entityId: string): LampPatch {
  const strip = entityId === STRIP;
  switch (look) {
    case "orange":
      return {
        entityId,
        on: true,
        brightness: strip ? 100 : 70,
        hs: [28.941, 100],
      };
    case "white":
      return { entityId, on: true, brightness: 60, kelvin: 4000 };
    case "warm":
      return {
        entityId,
        on: true,
        brightness: strip ? 100 : 20,
        kelvin: 2000,
      };
  }
}
