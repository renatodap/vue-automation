import { NextResponse } from "next/server";
import { internalSecretOk, unauthorized } from "../_lib/guard";
import { internalError } from "../_lib/errors";
import { history } from "../_lib/scene-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which scenes get used, and when.
 *
 * Tap history is the one thing in this database worth reading back as analysis
 * — it is what lets the picker float frequent scenes to the top, and what
 * answers "what do I actually use in the evening". It says nothing about what
 * the lamps are doing right now; that is Home Assistant's to answer.
 */
export async function GET(req: Request): Promise<Response> {
  if (!internalSecretOk(req)) return unauthorized();

  const raw = Number(new URL(req.url).searchParams.get("days") ?? 30);
  const days = Math.max(1, Math.min(Number.isFinite(raw) ? Math.round(raw) : 30, 365));

  try {
    const rows = await history(days);
    if (!rows) {
      // Explicitly NOT an empty history. Reporting zero taps when the real
      // answer is "the database did not answer" states a fact that isn't one.
      return NextResponse.json(
        {
          ok: false,
          reason: "metadata_unavailable",
          error:
            "The tap-history database is unavailable, so there is no history to report. " +
            "This says nothing about the lamps — Home Assistant is a separate system and " +
            "the lights still work.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, ...rows });
  } catch (error) {
    return internalError(error);
  }
}
