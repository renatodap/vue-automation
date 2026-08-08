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
  let kelvin: number | undefined;

  try {
    const body = await request.json();
    entityId = typeof body?.entityId === "string" ? body.entityId : "";
    if (typeof body?.on === "boolean") on = body.on;
    if (typeof body?.brightness === "number") brightness = body.brightness;
    if (typeof body?.kelvin === "number") kelvin = body.kelvin;
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
      data.brightness_pct = Math.max(1, Math.min(100, Math.round(brightness)));
    }
    if (kelvin !== undefined) {
      // Clamped to the ZL1's envelope. A value outside the bulb's real range is
      // rejected the same silent way — the light simply doesn't move.
      data.color_temp_kelvin = Math.max(2000, Math.min(6500, Math.round(kelvin)));
    }
    await callService("light", "turn_on", data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
