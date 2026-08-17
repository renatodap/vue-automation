import { NextRequest, NextResponse } from "next/server";
import {
  getSceneConfig,
  getStates,
  sceneEntities,
  sceneLamps,
  saveScene,
  toLamps,
  type SceneLamp,
} from "@/lib/ha";
import { errorResponse } from "../state/route";

export const dynamic = "force-dynamic";

/**
 * A scene's stored definition, read and written directly.
 *
 * Separate from /api/scenes, which snapshots the live room. Both write a scene;
 * they differ in where the values come from, and that difference is the whole
 * feature: snapshotting can only save the light you are already sitting in,
 * while this can change what a scene does without touching a single bulb.
 */
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "missing id" }, { status: 400 });
  }

  try {
    const [config, states] = await Promise.all([getSceneConfig(id), getStates()]);
    return NextResponse.json({
      ok: true,
      id,
      name: config.name ?? "",
      lamps: sceneLamps(config, toLamps(states)),
    });
  } catch (error) {
    // A scene written by hand in scenes.yaml without an `id:` is not addressable
    // over this API at all. That is a permanent property of the scene, not a
    // failure to reach Home Assistant, and saying so is the difference between
    // "try again" and "this one can only be edited on the Pi".
    if (error instanceof Error && /returned 404/.test(error.message)) {
      return NextResponse.json(
        {
          ok: false,
          reason: "not_editable",
          message:
            "Home Assistant has no editable copy of this scene — it was written by hand in scenes.yaml.",
        },
        { status: 404 },
      );
    }
    return errorResponse(error);
  }
}

type Body = { id?: string; name?: string; lamps?: SceneLamp[] };

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const id = (body.id ?? "").trim();
  const name = (body.name ?? "").trim();
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "A scene needs a name" }, { status: 400 });

  const lamps = Array.isArray(body.lamps) ? body.lamps : [];
  if (lamps.length === 0) {
    return NextResponse.json(
      { error: "A scene with no lamps in it would do nothing" },
      { status: 400 },
    );
  }

  try {
    // Read-modify-write rather than a blind POST. The scene may hold entities
    // this editor does not render — a switch, a media player — and a save that
    // sent only the lamps would delete them without ever having shown them.
    const existing = await getSceneConfig(id).catch(() => ({ entities: {} }));
    const untouched = Object.fromEntries(
      Object.entries(existing.entities).filter(([e]) => !e.startsWith("light.")),
    );

    await saveScene(id, name, { ...untouched, ...sceneEntities(lamps) });
    return NextResponse.json({ ok: true, id, name, captured: lamps.length });
  } catch (error) {
    return errorResponse(error);
  }
}
