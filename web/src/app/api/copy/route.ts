import { NextRequest, NextResponse } from "next/server";
import {
  applyLightPatches,
  getStates,
  lampRanges,
  patchFromLamp,
  toLamps,
} from "@/lib/ha";
import { errorResponse } from "../state/route";

export const dynamic = "force-dynamic";

/**
 * Make one lamp look like another.
 *
 * Server-side rather than "read the source in the browser and post its numbers
 * back", for two reasons that are not style preferences:
 *
 *   1. The browser's copy of the source lamp is up to six seconds old. Copying
 *      from it propagates a stale colour to a second lamp and the two disagree
 *      with each other on screen until the next poll.
 *   2. Exactly one colour key may be sent — a payload carrying both a colour
 *      temperature and a hue lets Home Assistant choose, and the room comes
 *      back subtly wrong. That rule lives next to the projection that encodes
 *      it (patchFromLamp), not in four call sites.
 *
 * Kelvin is re-clamped per TARGET: two bulbs of different models do not share a
 * tunable range, and a value the source can hold may be one the target rejects
 * in silence.
 */
export async function POST(request: NextRequest) {
  let from = "";
  let to: string[] | "all" = [];

  try {
    const body = await request.json();
    from = typeof body?.from === "string" ? body.from : "";
    if (body?.to === "all") to = "all";
    else if (Array.isArray(body?.to)) {
      to = body.to.filter((e: unknown): e is string => typeof e === "string");
    }
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  if (!from.startsWith("light.")) {
    return NextResponse.json({ error: "not a light entity" }, { status: 400 });
  }
  if (to !== "all" && (to.length === 0 || !to.every((e) => e.startsWith("light.")))) {
    return NextResponse.json({ error: "no targets" }, { status: 400 });
  }

  try {
    const lamps = toLamps(await getStates());
    const source = lamps.find((l) => l.entityId === from);

    if (!source) {
      return NextResponse.json({ error: "No such lamp" }, { status: 404 });
    }
    if (!source.reachable) {
      // Copying from a bulb with no power would propagate "unknown" to lamps
      // that were fine. Refuse, and say which lamp is the problem.
      return NextResponse.json(
        { error: `${source.name} has no power — nothing to copy from it` },
        { status: 409 },
      );
    }

    const wanted =
      to === "all"
        ? lamps.filter((l) => l.entityId !== from)
        : lamps.filter((l) => to.includes(l.entityId) && l.entityId !== from);

    const reachable = wanted.filter((l) => l.reachable);
    const unreachable = wanted.filter((l) => !l.reachable);

    if (reachable.length === 0) {
      return NextResponse.json(
        {
          ok: true,
          copied: [],
          // Nothing applied, and saying so beats a silent success — the whole
          // point of naming these is that HA stays quiet about them.
          unreachable: unreachable.map((l) => l.name),
          source: source.name,
        },
        { status: 200 },
      );
    }

    const template = patchFromLamp(source, from);
    await applyLightPatches(
      reachable.map((l) => ({ ...template, entityId: l.entityId })),
      await lampRanges(),
    );

    return NextResponse.json({
      ok: true,
      source: source.name,
      copied: reachable.map((l) => l.name),
      unreachable: unreachable.map((l) => l.name),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
