import { NextRequest, NextResponse } from "next/server";
import { callService, getStates, toLamps } from "@/lib/ha";
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
    const before = toLamps(await getStates());
    const unreachableBefore = before.filter((l) => !l.reachable);

    await callService("scene", "turn_on", { entity_id: entityId });

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
