import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

/**
 * Gate every request behind the shared passphrase.
 *
 * NOTE: there is deliberately no `export const config = { matcher }`.
 *
 * A middleware matcher can never match the exact basePath root — every matcher
 * pattern requires a literal "/" after the prefix — so under a path-mounted
 * deploy the canonical URL (no trailing slash) silently skips the auth check
 * and serves the authenticated app to anyone. Running on every request and
 * excluding paths inline against the already-stripped pathname is the only
 * version that actually holds.
 */

const PUBLIC_PREFIXES = [
  "/login",
  "/api/login",
  "/_next",
  "/manifest.webmanifest",
  "/sw.js",
  "/icon-",
  "/apple-touch-icon",
  "/favicon",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p),
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // With the gate off, /login is a dead end that should not exist. Devices
  // holding a cached shell from when the gate WAS on will still navigate here,
  // and a 200 keeps showing them a form for a passphrase that no longer does
  // anything. Bounce them into the app instead of asking them to clear caches.
  if (pathname === "/login" && !process.env.APP_PASSPHRASE) {
    const home = request.nextUrl.clone();
    home.pathname = "/";
    home.search = "";
    return NextResponse.redirect(home);
  }

  if (isPublic(pathname)) return NextResponse.next();

  // No passphrase configured = the gate is deliberately off, and the app is
  // open to anyone with the URL. This is an explicit operator choice made by
  // clearing APP_PASSPHRASE, not a fallback for a missing value — setting the
  // variable again restores the gate with no code change.
  if (!process.env.APP_PASSPHRASE) return NextResponse.next();

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    // With a passphrase set but no signing key, fail closed rather than
    // silently serving the app unauthenticated.
    return new NextResponse("Server not configured", { status: 503 });
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySession(token, secret)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // clone() keeps the basePath that Next stripped on the way in. Building the
  // URL by hand loses it and redirects to the wrong app on a shared domain.
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}
