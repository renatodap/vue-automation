import { NextResponse } from "next/server";
import { callService, getStates, toLamps } from "@/lib/ha";
import { internalSecretOk, unauthorized, badRequest } from "../_lib/guard";
import { internalError } from "../_lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  entity_id?: string;
  entity_ids?: string[];
  on?: boolean;
  brightness?: number;
  kelvin?: number;
  hs?: [number, number];
  effect?: string;
  transition?: number;
};

/**
 * Per-lamp control — the escape hatch behind the scene picker, for the moment
 * when a scene is nearly right and one lamp is too bright.
 *
 * Mirrors `/api/light` including its clamping, and adds one thing that route
 * doesn't need: it re-reads the lamps afterwards and returns them. A caller
 * with no screen has no other way to find out that the bulb it just addressed
 * has no power, and reporting "done" over a lamp that never moved is the exact
 * failure this codebase refuses to have.
 *
 * `effect` is checked against the bulb's OWN advertised list for the same
 * reason Kelvin is clamped against the bulb's own range: Home Assistant drops
 * an effect the bulb never offered without saying so, and a silent drop is
 * indistinguishable from a call that never landed.
 */
export async function POST(req: Request): Promise<Response> {
  if (!internalSecretOk(req)) return unauthorized();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return badRequest("Expected a JSON body.");
  }

  const entityIds = [
    ...(typeof body.entity_id === "string" ? [body.entity_id] : []),
    ...(Array.isArray(body.entity_ids) ? body.entity_ids.filter((e) => typeof e === "string") : []),
  ];
  if (entityIds.length === 0 || !entityIds.every((e) => e.startsWith("light."))) {
    return badRequest("entity_id (or entity_ids) must name light.* entities.");
  }

  try {
    const before = toLamps(await getStates());
    const known = new Set(before.map((l) => l.entityId));
    const unknown = entityIds.filter((e) => !known.has(e));
    if (unknown.length) {
      return NextResponse.json(
        {
          error:
            `Home Assistant does not report ${unknown.join(", ")}. Read the room again — ` +
            `the entity id may have changed.`,
        },
        { status: 404 },
      );
    }

    // What the addressed bulbs were doing before the write. Kept because the
    // effect check below needs each bulb's own advertised list.
    const addressed = before.filter((l) => entityIds.includes(l.entityId));

    // The master controls drive every lamp in a SINGLE call: four sequential
    // round trips over a tailnet is visibly staggered, and the lamps change one
    // at a time like a wave.
    const entityId = entityIds.length === 1 ? entityIds[0] : entityIds;
    const transition =
      typeof body.transition === "number" && Number.isFinite(body.transition)
        ? Math.max(0, Math.min(300, body.transition))
        : undefined;
    const effect =
      typeof body.effect === "string" && body.effect.length > 0 ? body.effect : undefined;

    // Refuse an effect the bulb does not advertise, BEFORE writing. Home
    // Assistant accepts the call and drops the unknown effect in silence, so
    // the lamp sits there unchanged and the caller is told it worked.
    if (effect) {
      const lacking = addressed.filter((l) => !l.effects.includes(effect));
      if (lacking.length) {
        const offered = [...new Set(addressed.flatMap((l) => l.effects))];
        return badRequest(
          `${lacking.map((l) => l.name).join(", ")} ` +
            `${lacking.length === 1 ? "does" : "do"} not offer the "${effect}" effect. ` +
            (offered.length ? `Offered here: ${offered.join(", ")}.` : "That bulb offers none at all."),
        );
      }
    }

    if (body.on === false) {
      await callService("light", "turn_off", {
        entity_id: entityId,
        ...(transition !== undefined ? { transition } : {}),
      });
    } else {
      const data: Record<string, unknown> = { entity_id: entityId };
      if (transition !== undefined) data.transition = transition;
      if (effect !== undefined) data.effect = effect;
      if (body.brightness !== undefined) {
        // Clamp before converting: HA silently rejects out-of-range values and
        // the lamp just doesn't change, which looks like the call didn't land.
        data.brightness_pct = Math.max(1, Math.min(100, Math.round(body.brightness)));
      }
      // Colour temperature and hue are mutually exclusive modes on the bulb.
      // Sending both lets HA pick, and which wins is not predictable — so hue
      // wins explicitly when it was asked for.
      if (Array.isArray(body.hs) && body.hs.length === 2) {
        data.hs_color = [
          ((Math.round(body.hs[0]) % 360) + 360) % 360,
          Math.max(0, Math.min(100, Math.round(body.hs[1]))),
        ];
      } else if (body.kelvin !== undefined) {
        // Clamped per-bulb to the range the bulb itself reports, never a
        // hardcoded 2700–6500: a value outside it is rejected the same silent
        // way and the light simply doesn't move.
        const lamp = before.find((l) => l.entityId === entityIds[0]);
        const min = lamp?.minKelvin ?? 2000;
        const max = lamp?.maxKelvin ?? 6500;
        data.color_temp_kelvin = Math.max(min, Math.min(max, Math.round(body.kelvin)));
      }
      await callService("light", "turn_on", data);
    }

    const after = toLamps(await getStates());
    const touched = after.filter((l) => entityIds.includes(l.entityId));
    const unreachable = touched.filter((l) => !l.reachable).map((l) => l.name);

    return NextResponse.json({
      ok: true,
      read_at: new Date().toISOString(),
      lamps: touched,
      unreachable,
      fully_applied: unreachable.length === 0,
      // An effect is not a setting the bulb holds; most of these are Zigbee
      // Identify animations that run once and stop by themselves. The bulb also
      // reports `effect` lazily, so the reading above may still say null even
      // though the lamp is visibly moving — do not call that a failure.
      ...(effect
        ? {
            effect_note:
              `Sent the "${effect}" effect. blink, breathe, okay and channel_change are Zigbee ` +
              `Identify animations: they run a short fixed sequence and stop on their own, so this ` +
              `is not a mode the lamp stays in. colorloop runs until stop_colorloop. The bulb ` +
              `reports its effect lazily, so \`effect\` above may still read null — say what was ` +
              `sent, not that it is still running.`,
          }
        : {}),
      summary: unreachable.length
        ? `${unreachable.join(", ")} could not be reached — a smart bulb is only smart while ` +
          `it has power. Say so rather than reporting the change as done.`
        : "Done.",
    });
  } catch (error) {
    return internalError(error);
  }
}
