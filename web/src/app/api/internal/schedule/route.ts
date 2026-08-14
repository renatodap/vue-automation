import { NextResponse } from "next/server";
import {
  callService,
  deleteAutomation,
  getStates,
  saveAutomation,
  toAutomations,
  toScenes,
} from "@/lib/ha";
import { internalSecretOk, unauthorized, badRequest } from "../_lib/guard";
import { internalError } from "../_lib/errors";
import { getAutomationConfig } from "../_lib/ha-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Schedules, expressed in the two shapes a lighting setup actually needs: a
 * clock time, or an offset from sunrise/sunset.
 *
 * Sun triggers matter more than they look. "Lights at 6pm" is wrong for most of
 * the year — pitch dark at 5pm in December, broad daylight at 8pm in June. "At
 * sunset" is what people mean, and Home Assistant already tracks it for these
 * coordinates.
 *
 * Anything more complex (conditions, presence, multi-step) stays in Home
 * Assistant's own editor. Reproducing that here would mean rebuilding a general
 * automation UI to control four lamps.
 */

type Body = {
  action?: "save" | "enable" | "delete";
  id?: string;
  name?: string;
  when?: "time" | "sunset" | "sunrise";
  time?: string;
  offset_minutes?: number;
  do_what?: "scene" | "allOff";
  scene_entity_id?: string;
  entity_id?: string;
  enabled?: boolean;
};

function offsetToHa(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(minutes);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `${sign}${h}:${m}:00`;
}

export async function GET(req: Request): Promise<Response> {
  if (!internalSecretOk(req)) return unauthorized();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return badRequest("Pass ?id= the automation's Home Assistant config id.");
  try {
    return NextResponse.json({ ok: true, id, config: await getAutomationConfig(id) });
  } catch (error) {
    return internalError(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!internalSecretOk(req)) return unauthorized();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return badRequest("Expected a JSON body.");
  }

  try {
    switch (body.action) {
      case "save":
        return await save(body);
      case "enable":
        return await enable(body);
      case "delete":
        return await remove(body);
      default:
        return badRequest('action must be one of "save", "enable", "delete".');
    }
  } catch (error) {
    return internalError(error);
  }
}

async function save(body: Body): Promise<Response> {
  const name = (body.name ?? "").trim();
  if (!name) return badRequest("A schedule needs a name.");

  let trigger: Record<string, unknown>;
  if (body.when === "time") {
    if (!/^\d{2}:\d{2}$/.test(body.time ?? "")) {
      return badRequest('time must be "HH:MM" on a 24-hour clock, e.g. "18:30".');
    }
    trigger = { trigger: "time", at: `${body.time}:00` };
  } else if (body.when === "sunset" || body.when === "sunrise") {
    const offset = Math.trunc(body.offset_minutes ?? 0);
    if (!Number.isFinite(offset) || Math.abs(offset) > 720) {
      return badRequest("offset_minutes must be within ±720 (negative = before the sun event).");
    }
    trigger = { trigger: "sun", event: body.when, offset: offsetToHa(offset) };
  } else {
    return badRequest('when must be "time", "sunset" or "sunrise".');
  }

  let action: Record<string, unknown>;
  if (body.do_what === "scene") {
    const sceneId = body.scene_entity_id ?? "";
    if (!sceneId.startsWith("scene.")) return badRequest("scene_entity_id must be a scene.* entity.");
    const known = new Set(toScenes(await getStates()).map((s) => s.entityId));
    if (!known.has(sceneId)) {
      return NextResponse.json(
        {
          error:
            `Home Assistant has no scene called ${sceneId}, so this schedule would fire ` +
            `into nothing. Read the scene list again.`,
        },
        { status: 404 },
      );
    }
    action = { action: "scene.turn_on", target: { entity_id: sceneId } };
  } else if (body.do_what === "allOff") {
    action = { action: "light.turn_off", target: { entity_id: "all" } };
  } else {
    return badRequest('do_what must be "scene" or "allOff".');
  }

  // Reuse the id to EDIT in place; a new one creates a new schedule.
  const id = body.id?.trim() || `vue_${Math.floor(Date.now() / 1000)}`;
  const previous = body.id?.trim() ? await getAutomationConfig(id) : null;

  await saveAutomation(id, {
    id,
    alias: name,
    description: "",
    triggers: [trigger],
    conditions: [],
    actions: [action],
    // "single" so a schedule that somehow fires twice doesn't stack runs.
    mode: "single",
    // Pin the enabled state across reloads and restarts. Without this an
    // automation can come back DISABLED after a reload and silently never fire
    // again — the failure mode where nothing errors, the schedule just stops
    // happening, and it goes unnoticed for weeks.
    initial_state: true,
  });

  return NextResponse.json({ ok: true, id, name, replaced: previous });
}

/** Enable / disable without deleting — a paused schedule keeps its config. */
async function enable(body: Body): Promise<Response> {
  const entityId = body.entity_id ?? "";
  if (!entityId.startsWith("automation.")) return badRequest("entity_id must be an automation.* entity.");
  const known = toAutomations(await getStates()).find((a) => a.entityId === entityId);
  if (!known) {
    return NextResponse.json(
      { error: `Home Assistant has no automation called ${entityId}.` },
      { status: 404 },
    );
  }
  const enabled = body.enabled !== false;
  await callService("automation", enabled ? "turn_on" : "turn_off", { entity_id: entityId });
  return NextResponse.json({ ok: true, entity_id: entityId, enabled, was: known.enabled });
}

async function remove(body: Body): Promise<Response> {
  const id = body.id?.trim();
  if (!id) return badRequest("Pass the automation's Home Assistant config id.");
  const previous = await getAutomationConfig(id);
  if (!previous) {
    return NextResponse.json(
      {
        error:
          `Home Assistant has no editable automation with id "${id}". Automations written ` +
          `by hand in automations.yaml without an \`id:\` cannot be deleted over the API.`,
      },
      { status: 404 },
    );
  }
  await deleteAutomation(id);
  return NextResponse.json({ ok: true, deleted: id, was: previous });
}
