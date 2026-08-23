import { NextResponse } from "next/server";
import {
  HaAuthError,
  HaUnreachableError,
  getStates,
  toAutomations,
  toLamps,
  toScenes,
} from "@/lib/ha";
import { loadRoomOverrides, loadSceneMeta } from "@/lib/db";
import { roomOf } from "@/lib/rooms";
import { ConfigError } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * One round trip that returns everything the picker renders: scenes (ordered),
 * lamps, and a health verdict.
 *
 * Deliberately one endpoint rather than three. The client polls this while the
 * app is visible, and three polls would triple the tailnet round trips for a
 * screen that always shows all of it at once.
 */
export async function GET() {
  try {
    const [states, meta, roomOverrides] = await Promise.all([
      getStates(),
      loadSceneMeta(),
      loadRoomOverrides(),
    ]);

    // The room is resolved HERE, once, so the client never has to know that an
    // override layer exists. An unreachable Postgres yields no overrides and
    // every lamp falls back to the static map — the grouping is unchanged.
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
        // Absent metadata means no spotlight rather than every scene in it —
        // a database outage must not fill the top of Home with ten buttons.
        spotlight: m?.spotlight ?? false,
        tapCount: m?.tapCount ?? 0,
        lastTappedAt: m?.lastTappedAt ?? null,
      };
    });

    // Explicit sort_order wins; otherwise most-tapped floats up, then name.
    // A picker whose order changes under the user's thumb is worse than one
    // that's slightly wrong, so this only re-sorts between loads, never live.
    scenes.sort((a, b) => {
      if (a.sortOrder !== null && b.sortOrder !== null) {
        return a.sortOrder - b.sortOrder;
      }
      if (a.sortOrder !== null) return -1;
      if (b.sortOrder !== null) return 1;
      if (a.tapCount !== b.tapCount) return b.tapCount - a.tapCount;
      return a.label.localeCompare(b.label);
    });

    return NextResponse.json({
      ok: true,
      scenes,
      lamps,
      automations: toAutomations(states),
      unreachableCount: lamps.filter((l) => !l.reachable).length,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export function errorResponse(error: unknown) {
  if (error instanceof HaUnreachableError) {
    return NextResponse.json(
      {
        ok: false,
        reason: "unreachable",
        message:
          "Can't reach Home Assistant. The Pi may be off, or the tailnet is down.",
      },
      { status: 503 },
    );
  }
  if (error instanceof HaAuthError) {
    return NextResponse.json(
      {
        ok: false,
        reason: "ha_auth",
        message: "Home Assistant rejected the access token. It may have been revoked.",
      },
      { status: 502 },
    );
  }
  if (error instanceof ConfigError) {
    return NextResponse.json(
      { ok: false, reason: "config", message: error.message },
      { status: 503 },
    );
  }
  return NextResponse.json(
    { ok: false, reason: "unknown", message: "Something went wrong talking to the house." },
    { status: 500 },
  );
}
