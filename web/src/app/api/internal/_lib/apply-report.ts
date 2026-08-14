import type { Lamp } from "@/lib/ha";

/**
 * Did the scene actually land?
 *
 * Home Assistant applies a scene to whatever it can reach and stays SILENT
 * about the rest, and silence reads as success. The PWA's `/api/scene` route
 * answers that by naming the lamps that were unreachable when it was tapped.
 * This is the same rule taken one step further for a caller that has no screen
 * to look at: it compares the scene's stored targets against the lamps as they
 * are AFTERWARDS, so a lamp that was reachable but did not follow — the case a
 * before-only check cannot see — is named too.
 *
 * Pure on purpose. The one implementation of invariant #4's judgement lives
 * here, in the app, and the connector relays what it says.
 */

export type ApplyReport = {
  applied: string[];
  unreachable: string[];
  did_not_match: Array<{ lamp: string; wanted: string; got: string }>;
  fully_applied: boolean;
  /** How the caller should say it out loud. */
  summary: string;
};

/** Bulbs round their own dimming; a 1/255 disagreement is not a failure. */
const BRIGHTNESS_TOLERANCE = 4;
/** Bulbs snap colour temperature to their nearest supported mired step. */
const KELVIN_TOLERANCE = 80;

function describeTarget(target: Record<string, unknown>): string {
  if (target.state === "off") return "off";
  const bits: string[] = ["on"];
  if (typeof target.brightness === "number") {
    bits.push(`${Math.round((target.brightness / 255) * 100)}%`);
  }
  if (typeof target.color_temp_kelvin === "number") bits.push(`${target.color_temp_kelvin}K`);
  if (Array.isArray(target.hs_color)) bits.push(`hue ${(target.hs_color as number[])[0]}`);
  return bits.join(" · ");
}

function describeLamp(lamp: Lamp): string {
  if (!lamp.reachable) return "unreachable";
  if (!lamp.on) return "off";
  const bits: string[] = ["on"];
  if (lamp.brightness != null) bits.push(`${lamp.brightness}%`);
  if (lamp.kelvin != null) bits.push(`${lamp.kelvin}K`);
  else if (lamp.hs) bits.push(`hue ${Math.round(lamp.hs[0])}`);
  return bits.join(" · ");
}

/**
 * @param targets the scene's stored `entities` dict. When HA cannot hand one
 *   back — a YAML scene with no `id:` — the caller passes every lamp's entity
 *   id mapped to `{}`, and this degrades to reachability reporting, which is
 *   less precise but still honest.
 * @param after the lamps as they are once the scene has been applied.
 */
export function applyReport(
  targets: Record<string, unknown>,
  after: Lamp[],
): ApplyReport {
  const byId = new Map(after.map((l) => [l.entityId, l]));
  const applied: string[] = [];
  const unreachable: string[] = [];
  const didNotMatch: Array<{ lamp: string; wanted: string; got: string }> = [];

  for (const [entityId, rawTarget] of Object.entries(targets)) {
    const target =
      rawTarget && typeof rawTarget === "object"
        ? (rawTarget as Record<string, unknown>)
        : {};
    const lamp = byId.get(entityId);

    if (!lamp) {
      // The scene names an entity HA no longer reports. Not silence to pass
      // over: the scene is pointing at something that no longer exists.
      didNotMatch.push({
        lamp: entityId,
        wanted: describeTarget(target),
        got: "no such entity in Home Assistant",
      });
      continue;
    }
    if (!lamp.reachable) {
      unreachable.push(lamp.name);
      continue;
    }

    // With no stored target there is nothing to compare against; reachable is
    // the whole verdict available.
    if (Object.keys(target).length === 0) {
      applied.push(lamp.name);
      continue;
    }

    const wantOn = target.state !== "off";
    let ok = lamp.on === wantOn;

    if (ok && wantOn) {
      if (typeof target.brightness === "number" && lamp.brightness != null) {
        const got255 = Math.round((lamp.brightness / 100) * 255);
        if (Math.abs(got255 - target.brightness) > BRIGHTNESS_TOLERANCE) ok = false;
      }
      if (ok && typeof target.color_temp_kelvin === "number" && lamp.kelvin != null) {
        if (Math.abs(lamp.kelvin - target.color_temp_kelvin) > KELVIN_TOLERANCE) ok = false;
      }
    }

    if (ok) applied.push(lamp.name);
    else {
      didNotMatch.push({
        lamp: lamp.name,
        wanted: describeTarget(target),
        got: describeLamp(lamp),
      });
    }
  }

  const fully = unreachable.length === 0 && didNotMatch.length === 0;
  const parts: string[] = [];
  if (applied.length) {
    parts.push(`${applied.length} lamp${applied.length === 1 ? "" : "s"} followed`);
  }
  if (unreachable.length) {
    parts.push(
      `${unreachable.join(", ")} ${unreachable.length === 1 ? "is" : "are"} unreachable ` +
        "(a smart bulb is only smart while it has power — check the lamp switch)",
    );
  }
  if (didNotMatch.length) {
    parts.push(`${didNotMatch.map((d) => d.lamp).join(", ")} did not end up where the scene asked`);
  }

  return {
    applied,
    unreachable,
    did_not_match: didNotMatch,
    fully_applied: fully,
    summary: fully
      ? `Applied cleanly — ${applied.length} lamp${applied.length === 1 ? "" : "s"}.`
      : `Applied PARTIALLY: ${parts.join("; ")}. Say this out loud — do not report it as a clean apply.`,
  };
}
