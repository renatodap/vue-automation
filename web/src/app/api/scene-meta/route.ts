import { NextRequest, NextResponse } from "next/server";
import { setSpotlight } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Scene presentation metadata the user can change from the app.
 *
 * Only spotlight for now. Unlike the tap counter this one reports failure: a
 * counter that misses a row costs nothing, but a spotlight switch that flips on
 * screen and never reaches Postgres is a control that lies, and the user finds
 * out by reloading Home and seeing the scene gone from the top.
 */
export async function POST(request: NextRequest) {
  let entityId = "";
  let spotlight = false;
  try {
    const body = await request.json();
    entityId = typeof body?.entityId === "string" ? body.entityId : "";
    spotlight = body?.spotlight === true;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  if (!entityId.startsWith("scene.")) {
    return NextResponse.json({ error: "not a scene" }, { status: 400 });
  }

  try {
    await setSpotlight(entityId, spotlight);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        message:
          "Couldn't save that — the database that stores labels and spotlight isn't answering. The scene itself is fine.",
      },
      { status: 503 },
    );
  }
}
