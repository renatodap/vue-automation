import { NextResponse } from "next/server";
import { getStates, toAutomations, toLamps, toScenes } from "@/lib/ha";
import { db, loadRoomOverrides, loadSceneMeta } from "@/lib/db";
import { ROOMS, roomOf } from "@/lib/rooms";
import { internalSecretOk, unauthorized } from "../_lib/guard";
import { internalError } from "../_lib/errors";
import { loadAliases } from "../_lib/scene-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the connector reads about the house, in one round trip.
 *
 * The same projections and the same ordering rule the picker uses, because the
 * app and Claude must never report different numbers — that is the whole point
 * of the connector talking to this route instead of to Home Assistant.
 *
 * Never served from a cache and never cacheable downstream: a stale reading
 * presented as current is worse than an error, because the user acts on it.
 */
export async function GET(req: Request): Promise<Response> {
  if (!internalSecretOk(req)) return unauthorized();

  try {
    const [states, meta, aliases, roomOverrides, metaOnline] = await Promise.all([
      getStates(),
      loadSceneMeta(),
      loadAliases(),
      loadRoomOverrides(),
      metadataReachable(),
    ]);

    // Resolved the same way and in the same order as /api/state, so the room
    // the connector names and the room the picker draws are the same room.
    const lamps = toLamps(states).map((lamp) => ({
      ...lamp,
      room: roomOf(lamp.entityId, roomOverrides),
    }));
    const scenes = toScenes(states).map((scene) => {
      const m = meta.get(scene.entityId);
      return {
        ...scene,
        label: m?.label ?? scene.name,
        accent: m?.accent ?? null,
        sortOrder: m?.sortOrder ?? null,
        tapCount: m?.tapCount ?? 0,
        lastTappedAt: m?.lastTappedAt ?? null,
        aliases: aliases.get(scene.entityId) ?? [],
      };
    });

    // Explicit sort_order wins; otherwise most-tapped floats up, then name.
    // Identical to /api/state, so the connector's idea of "the first scene" and
    // the picker's are the same scene.
    scenes.sort((a, b) => {
      if (a.sortOrder !== null && b.sortOrder !== null) return a.sortOrder - b.sortOrder;
      if (a.sortOrder !== null) return -1;
      if (b.sortOrder !== null) return 1;
      if (a.tapCount !== b.tapCount) return b.tapCount - a.tapCount;
      return a.label.localeCompare(b.label);
    });

    return NextResponse.json({
      ok: true,
      read_at: new Date().toISOString(),
      scenes,
      lamps,
      automations: toAutomations(states),
      unreachableCount: lamps.filter((l) => !l.reachable).length,
      // The rooms that exist, so a caller can offer the real set rather than
      // guess one, and the overrides that are currently shadowing the static
      // map — an empty object means "none set", or that Postgres was down.
      rooms: ROOMS,
      room_overrides: roomOverrides,
      // Says which of the two stores answered. A scene list whose labels all
      // fell back to Home Assistant's names is not the same thing as a scene
      // list whose labels were cleared, and the caller has to be able to tell.
      metadata: metaOnline ? "ok" : "unavailable",
    });
  } catch (error) {
    return internalError(error);
  }
}

/** One cheap probe, so "no rows" and "no database" stay distinguishable. */
async function metadataReachable(): Promise<boolean> {
  const sql = db();
  if (!sql) return false;
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
