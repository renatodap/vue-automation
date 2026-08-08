import { NextRequest, NextResponse } from "next/server";
import { callService, deleteAutomation, saveAutomation } from "@/lib/ha";
import { errorResponse } from "../state/route";

export const dynamic = "force-dynamic";

/**
 * Schedules, expressed in the two shapes a lighting setup actually needs:
 * a clock time, or an offset from sunrise/sunset.
 *
 * Sun triggers matter more than they look. "Lights at 6pm" is wrong for most
 * of the year — it's pitch dark at 5pm in December and broad daylight at 8pm
 * in June. "At sunset" is the thing people actually mean, and HA already
 * tracks it for these coordinates.
 *
 * Anything more complex (conditions, presence, multi-step) stays in Home
 * Assistant's own editor. Reproducing that here would mean rebuilding a
 * general automation UI to control four lamps.
 */

type Body = {
  name?: string;
  when?: "time" | "sunset" | "sunrise";
  time?: string; // "HH:MM"
  offsetMinutes?: number; // negative = before the sun event
  doWhat?: "scene" | "allOff";
  sceneEntityId?: string;
};

function offsetToHa(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(minutes);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `${sign}${h}:${m}:00`;
}

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "A schedule needs a name" }, { status: 400 });

  // --- trigger ---
  let trigger: Record<string, unknown>;
  if (body.when === "time") {
    if (!/^\d{2}:\d{2}$/.test(body.time ?? "")) {
      return NextResponse.json({ error: "Pick a time" }, { status: 400 });
    }
    trigger = { trigger: "time", at: `${body.time}:00` };
  } else if (body.when === "sunset" || body.when === "sunrise") {
    trigger = {
      trigger: "sun",
      event: body.when,
      offset: offsetToHa(body.offsetMinutes ?? 0),
    };
  } else {
    return NextResponse.json({ error: "Pick when it should run" }, { status: 400 });
  }

  // --- action ---
  let action: Record<string, unknown>;
  if (body.doWhat === "scene") {
    if (!body.sceneEntityId?.startsWith("scene.")) {
      return NextResponse.json({ error: "Pick a scene" }, { status: 400 });
    }
    action = { action: "scene.turn_on", target: { entity_id: body.sceneEntityId } };
  } else if (body.doWhat === "allOff") {
    action = { action: "light.turn_off", target: { entity_id: "all" } };
  } else {
    return NextResponse.json({ error: "Pick what it should do" }, { status: 400 });
  }

  try {
    const id = `vue_${Math.floor(Date.now() / 1000)}`;
    await saveAutomation(id, {
      id,
      alias: name,
      description: "",
      triggers: [trigger],
      conditions: [],
      actions: [action],
      // "single" so a schedule that somehow fires twice doesn't stack runs.
      mode: "single",
    });
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Enable / disable without deleting — a paused schedule keeps its config. */
export async function PUT(request: NextRequest) {
  let entityId = "";
  let enabled = true;
  try {
    const body = await request.json();
    entityId = typeof body?.entityId === "string" ? body.entityId : "";
    enabled = body?.enabled !== false;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (!entityId.startsWith("automation.")) {
    return NextResponse.json({ error: "not an automation" }, { status: 400 });
  }
  try {
    await callService("automation", enabled ? "turn_on" : "turn_off", {
      entity_id: entityId,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });
  try {
    await deleteAutomation(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
