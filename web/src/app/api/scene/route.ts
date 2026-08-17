import { NextRequest, NextResponse } from "next/server";
import {
  SPLIT_BRIGHTNESS,
  callService,
  getSceneConfig,
  getStates,
  toLamps,
  toScenes,
  type HaState,
} from "@/lib/ha";
import { recordTap } from "@/lib/db";
import { errorResponse } from "../state/route";

export const dynamic = "force-dynamic";

/**
 * Activate a scene, then report honestly on what it could and couldn't reach.
 *
 * Home Assistant applies a scene to the lights it can talk to and stays quiet
 * about the ones it can't. Silence reads as success, so the user taps "Cozy
 * Cinema", one lamp stays dark, and nothing explains why. Re-reading state
 * afterwards is what turns that into "applied — floor lamp is unreachable".
 */
export async function POST(request: NextRequest) {
  let entityId = "";
  try {
    const body = await request.json();
    entityId = typeof body?.entityId === "string" ? body.entityId : "";
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  if (!entityId.startsWith("scene.")) {
    return NextResponse.json({ error: "not a scene entity" }, { status: 400 });
  }

  try {
    const states = await getStates();
    const before = toLamps(states);
    const unreachableBefore = before.filter((l) => !l.reachable);

    await callService("scene", "turn_on", { entity_id: entityId });
    await reapplySplitBrightness(entityId, states);

    // Best-effort, never blocking the response.
    void recordTap(entityId);

    return NextResponse.json({
      ok: true,
      applied: entityId,
      unreachable: unreachableBefore.map((l) => l.name),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Re-send brightness for the lamps that throw it away when it arrives with a
 * colour — see SPLIT_BRIGHTNESS in lib/ha.ts.
 *
 * A scene is applied by Home Assistant in one shot, so this is the only place
 * the correction can happen for a scene tap: read what the scene MEANT that
 * lamp to be, then say it again on its own. Without it the strip keeps whatever
 * brightness it happened to be on and the scene is quietly wrong every time.
 *
 * Never throws. The scene has already been applied by this point, and failing
 * the request over a follow-up correction would report a scene that did work as
 * a scene that did not.
 */
async function reapplySplitBrightness(
  sceneEntityId: string,
  states: HaState[],
): Promise<void> {
  try {
    const scene = toScenes(states).find((s) => s.entityId === sceneEntityId);
    // A hand-written YAML scene with no `id:` has no readable definition, so
    // there is nothing to correct towards.
    if (!scene?.id) return;

    const config = await getSceneConfig(scene.id);
    const targets = Object.entries(config.entities).filter(
      ([entity, entry]) =>
        SPLIT_BRIGHTNESS.has(entity) &&
        entry["state"] !== "off" &&
        typeof entry["brightness"] === "number",
    );
    if (!targets.length) return;

    // Let the scene's own command land first; these bulbs are not instant and a
    // correction that overtakes it would simply be overwritten.
    await new Promise((resolve) => setTimeout(resolve, 400));

    await Promise.allSettled(
      targets.map(([entity, entry]) =>
        callService("light", "turn_on", {
          entity_id: entity,
          brightness: entry["brightness"],
        }),
      ),
    );
  } catch {
    // Intentionally swallowed — see the note above.
  }
}
