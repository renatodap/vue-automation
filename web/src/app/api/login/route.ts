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
    // The cookie must be scoped to the app, not the whole shared domain.
    path: `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/`,
  });
  return response;
}
