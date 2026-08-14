import { NextResponse } from "next/server";
import { HaAuthError, HaUnreachableError } from "@/lib/ha";
import { ConfigError } from "@/lib/env";
import { MetaUnavailableError } from "./scene-meta";

/**
 * The shared failure shape for the internal surface.
 *
 * Mirrors `/api/state`'s `errorResponse` rather than importing it: that one is
 * typed to the PWA's `StateResponse` union and carries copy written for a
 * banner in the UI. The reader here is a model, so the message says what was
 * and was not changed, and the status code says whether a retry could help at
 * all.
 */
export function internalError(error: unknown): Response {
  if (error instanceof HaUnreachableError) {
    return NextResponse.json(
      {
        error:
          "Can't reach Home Assistant — the Pi may be off, or the tailnet is down. " +
          "Nothing was changed, and the current state of the lamps is unknown.",
        reason: "unreachable",
      },
      { status: 503 },
    );
  }
  if (error instanceof HaAuthError) {
    return NextResponse.json(
      {
        error:
          "Home Assistant rejected the access token — it may have been revoked. " +
          "HA_TOKEN needs reissuing on the app.",
        reason: "ha_auth",
      },
      { status: 502 },
    );
  }
  if (error instanceof ConfigError) {
    return NextResponse.json({ error: error.message, reason: "config" }, { status: 503 });
  }
  if (error instanceof MetaUnavailableError) {
    // 409, not 500: Home Assistant is fine and the lamps are fine — only the
    // decoration failed. The distinction decides whether the caller should say
    // "the lights did not change" or "the lights changed, the label did not".
    return NextResponse.json({ error: error.message, reason: "metadata_unavailable" }, { status: 409 });
  }
  const message =
    error instanceof Error ? error.message : "Something went wrong talking to the house.";
  return NextResponse.json({ error: message, reason: "unknown" }, { status: 500 });
}
