import { NextRequest, NextResponse } from "next/server";
import { applyLightPatches, lampRanges, type LightPatch } from "@/lib/ha";
import { errorResponse } from "../state/route";

export const dynamic = "force-dynamic";

/**
 * Everything that changes a lamp.
 *
 * Three body shapes, because three things ask:
 *   { entityId, ...patch }    one lamp
 *   { entityIds, ...patch }   the same change to several — master controls
 *   { patches: [...] }        a DIFFERENT change per lamp — copy, undo, solo
 *
 * The third is what makes undo possible: restoring four lamps to four different
 * states is one request, so a revert lands as one event rather than as four
 * lamps changing in sequence while the user watches.
 *
 * Kelvin is clamped per bulb, against the range that bulb reports, not against
 * a constant. Home Assistant rejects an out-of-range value in silence — the
 * lamp simply doesn't move — which is indistinguishable from a dead tap.
 *
 * Partial application is reported by the client rather than here: it re-reads
 * state immediately after this returns anyway, and comparing what it asked for
 * against what came back is both cheaper and more honest than a second
 * server-side read that would still be racing the Zigbee mesh.
 */
export async function POST(request: NextRequest) {
  let patches: LightPatch[] = [];

  try {
    const body = await request.json();

    if (Array.isArray(body?.patches)) {
      patches = body.patches
        .filter((p: unknown): p is Record<string, unknown> => !!p && typeof p === "object")
        .map((p: Record<string, unknown>) => readPatch(String(p.entityId ?? ""), p))
        .filter((p: LightPatch | null): p is LightPatch => p !== null);
    } else {
      // Accepts one entity or many. The master controls drive every lamp in a
      // single call — four sequential round trips over a tailnet is visibly
      // staggered, and the lamps change one at a time like a wave.
      const ids: string[] = [];
      if (typeof body?.entityId === "string") ids.push(body.entityId);
      if (Array.isArray(body?.entityIds)) {
        ids.push(...body.entityIds.filter((e: unknown) => typeof e === "string"));
      }
      patches = ids
        .map((id) => readPatch(id, body as Record<string, unknown>))
        .filter((p): p is LightPatch => p !== null);
    }
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  if (patches.length === 0 || !patches.every((p) => p.entityId.startsWith("light."))) {
    return NextResponse.json({ error: "not a light entity" }, { status: 400 });
  }

  try {
    await applyLightPatches(patches, await lampRanges());
    return NextResponse.json({ ok: true, applied: patches.map((p) => p.entityId) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Reads one patch out of untrusted JSON. Returns null when there's no id. */
function readPatch(entityId: string, source: Record<string, unknown>): LightPatch | null {
  if (!entityId) return null;
  const patch: LightPatch = { entityId };
  if (typeof source.on === "boolean") patch.on = source.on;
  if (typeof source.brightness === "number") patch.brightness = source.brightness;
  if (typeof source.kelvin === "number") patch.kelvin = source.kelvin;
  if (typeof source.effect === "string" && source.effect) patch.effect = source.effect;
  if (
    Array.isArray(source.hs) &&
    source.hs.length === 2 &&
    source.hs.every((n: unknown) => typeof n === "number")
  ) {
    patch.hs = source.hs as [number, number];
  }
  return patch;
}
