import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  issueSession,
  passphraseMatches,
  sessionCookieOptions,
} from "@/lib/auth";
import { appPassphrase, authSecret } from "@/lib/env";

export async function POST(request: NextRequest) {
  let passphrase = "";
  try {
    const body = await request.json();
    passphrase = typeof body?.passphrase === "string" ? body.passphrase : "";
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  // Gate disabled — nothing to log in to.
  if (!process.env.APP_PASSPHRASE) return NextResponse.json({ ok: true });

  let expected: string;
  let secret: string;
  try {
    expected = appPassphrase();
    secret = authSecret();
  } catch {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  if (!passphraseMatches(passphrase, expected)) {
    // Deliberately vague and deliberately slow-ish. There is one passphrase
    // and no account to enumerate, so there is nothing useful to say.
    await new Promise((r) => setTimeout(r, 400));
    return NextResponse.json({ error: "wrong passphrase" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, await issueSession(secret), {
    ...sessionCookieOptions,
    // Scoped to the app, not the whole shared domain — but with NO trailing
    // slash. "/vue-automation/" fails to match a request for
    // "/vue-automation", and Next 308-redirects the slashed form to the bare
    // one, so the cookie is dropped on the very next hop and the app loops
    // back to login forever. Without the slash it matches both the bare path
    // and everything under it.
    path: process.env.NEXT_PUBLIC_BASE_PATH || "/",
  });
  return response;
}
