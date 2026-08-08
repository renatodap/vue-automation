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
  let entityIds: string[] = [];
  let on: boolean | undefined;
  let brightness: number | undefined;
  let kelvin: number | undefined;
  let hs: [number, number] | undefined;

  try {
    const body = await request.json();
    // Accepts one entity or many. The master controls drive every lamp in a
    // single call — four sequential round trips over a tailnet is visibly
    // staggered, and the lamps change one at a time like a wave.
    if (typeof body?.entityId === "string") entityIds = [body.entityId];
    if (Array.isArray(body?.entityIds)) {
      entityIds = body.entityIds.filter((e: unknown) => typeof e === "string");
    }
    if (typeof body?.on === "boolean") on = body.on;
    if (typeof body?.brightness === "number") brightness = body.brightness;
    if (typeof body?.kelvin === "number") kelvin = body.kelvin;
    if (
      Array.isArray(body?.hs) &&
      body.hs.length === 2 &&
      body.hs.every((n: unknown) => typeof n === "number")
    ) {
      hs = body.hs as [number, number];
    }
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  if (entityIds.length === 0 || !entityIds.every((e) => e.startsWith("light."))) {
    return NextResponse.json({ error: "not a light entity" }, { status: 400 });
  }
  const entityId = entityIds.length === 1 ? entityIds[0] : entityIds;

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
    // Colour temperature and hue are mutually exclusive modes on the bulb.
    // Sending both lets HA pick, and which one wins is not something the user
    // can predict — so hue wins explicitly when it was asked for.
    if (hs !== undefined) {
      data.hs_color = [
        ((Math.round(hs[0]) % 360) + 360) % 360,
        Math.max(0, Math.min(100, Math.round(hs[1]))),
      ];
    } else if (kelvin !== undefined) {
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
