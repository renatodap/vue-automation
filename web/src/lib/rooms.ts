import type { LampPatch, LampView } from "./types";

/**
 * Which room each bulb is in, and the three looks the whole app agrees on.
 *
 * Deliberately a static map rather than a table. Home Assistant owns areas but
 * does not expose them over the REST API, and putting this in Postgres would
 * mean the grouping collapses whenever the metadata database is down — the one
 * thing invariant 2 promises will never take the lights with it. Nine bulbs in
 * two rooms change roughly never; when one moves, this is a one-line edit.
 *
 * Anything not listed lands in "Unassigned" rather than disappearing, so a bulb
 * paired at 2am still shows up and can still be switched off.
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
};

export function roomOf(entityId: string): RoomId {
  return ASSIGNMENTS[entityId] ?? "unassigned";
}

/** Rooms that actually have a bulb in them, in display order. */
export function groupByRoom(lamps: LampView[]): { room: Room; lamps: LampView[] }[] {
  return ROOMS.map((room) => ({
    room,
    lamps: lamps.filter((l) => roomOf(l.entityId) === room.id),
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
