/**
 * Where each lamp physically sits on the room plate.
 *
 * Normalized (x, y) over the plate image, read off a photograph of the room and
 * documented in docs/design/room-map/README.md. Defaults only — the point is
 * that the map is useful before anyone opens a placement editor, not that these
 * are right forever.
 */

export const PLATE_WIDTH = 896;
export const PLATE_HEIGHT = 1200;

export type Point = { x: number; y: number };

const DEFAULTS: Record<string, Point> = {
  "light.abajour": { x: 0.215, y: 0.795 }, // side table, near end of the sofa
  "light.floor_lamp": { x: 0.215, y: 0.445 }, // arc lamp head, over the sofa
  "light.shelf_lamp": { x: 0.185, y: 0.235 }, // on the ladder shelf
  // Far side of the TV. The bulb has never been renamed in Zigbee2MQTT, so it
  // answers to its raw IEEE address; both keys are listed so the lamp lands in
  // the right place before and after someone finally names it.
  "light.tv_lamp": { x: 0.795, y: 0.435 },
  "light.0x7cb94c68286a0000": { x: 0.795, y: 0.435 },
};

/**
 * Anything unplaced lands on a tidy arc along the bottom rather than on top of
 * something else. A new bulb appearing in the middle of the sofa is confusing;
 * a new bulb in a row along the bottom reads as "not placed yet".
 */
export function placementFor(entityId: string, index: number, total: number): Point {
  const known = DEFAULTS[entityId];
  if (known) return known;
  const spread = Math.min(0.8, Math.max(total, 1) * 0.18);
  const start = 0.5 - spread / 2;
  const step = total > 1 ? spread / (total - 1) : 0;
  return { x: start + step * index, y: 0.93 };
}

/** True when the lamp is sitting on the fallback arc, not on real furniture. */
export function isPlaced(entityId: string): boolean {
  return entityId in DEFAULTS;
}
