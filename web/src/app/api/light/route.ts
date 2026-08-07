import { NextRequest, NextResponse } from "next/server";
import { callService } from "@/lib/ha";
import { errorResponse } from "../state/route";

export const dynamic = "force-dynamic";

/**
 * Per-lamp control: on/off and brightness.
 *
 * The picker is the primary surface and this is the escape hatch behind it —
 * for the moment when a scene is nearly right and one lamp is too bright.
 */
export async function POST(request: NextRequest) {
  let entityId = "";
  let on: boolean | undefined;
  let brightness: number | undefined;

  try {
    const body = await request.json();
    entityId = typeof body?.entityId === "string" ? body.entityId : "";
    if (typeof body?.on === "boolean") on = body.on;
    if (typeof body?.brightness === "number") brightness = body.brightness;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  if (!entityId.startsWith("light.")) {
    return NextResponse.json({ error: "not a light entity" }, { status: 400 });
  }

  try {
    if (on === false) {
      await callService("light", "turn_off", { entity_id: entityId });
      return NextResponse.json({ ok: true });
    }

    const data: Record<string, unknown> = { entity_id: entityId };
    if (brightness !== undefined) {
      // Clamp before converting: HA silently rejects out-of-range values and
      // the lamp just doesn't change, which looks like the tap didn't register.
      const pct = Math.max(1, Math.min(100, Math.round(brightness)));
      data.brightness_pct = pct;
    }
    await callService("light", "turn_on", data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
