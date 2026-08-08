import { NextRequest, NextResponse } from "next/server";
import {
  deleteScene,
  getStates,
  saveScene,
  snapshotForScene,
  toLamps,
} from "@/lib/ha";
import { errorResponse } from "../state/route";

export const dynamic = "force-dynamic";

/** Stable, readable, and collision-proof enough for one household. */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return base || "scene";
}

/**
 * Save the room as it is right now.
 *
 * Snapshotting beats a form: the user has already arranged the light by eye,
 * and asking them to re-enter those values in a dialog is both more work and
 * less accurate than reading what the lamps actually settled on.
 */
export async function POST(request: NextRequest) {
  let name = "";
  let id: string | undefined;
  try {
    const body = await request.json();
    name = typeof body?.name === "string" ? body.name.trim() : "";
    if (typeof body?.id === "string" && body.id) id = body.id;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  if (!name) {
    return NextResponse.json({ error: "A scene needs a name" }, { status: 400 });
  }

  try {
    const lamps = toLamps(await getStates());
    const entities = snapshotForScene(lamps);

    if (Object.keys(entities).length === 0) {
      return NextResponse.json(
        { error: "No reachable lamps to capture" },
        { status: 409 },
      );
    }

    // Reuse the id when overwriting, so "save over this scene" updates in place
    // rather than leaving a duplicate with the same name behind.
    const sceneId = id ?? `${slugify(name)}_${Math.floor(Date.now() / 1000)}`;
    await saveScene(sceneId, name, entities);

    return NextResponse.json({
      ok: true,
      id: sceneId,
      captured: Object.keys(entities).length,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });
  try {
    await deleteScene(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
