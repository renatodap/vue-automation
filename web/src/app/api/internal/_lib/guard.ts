import { timingSafeEqual } from "crypto";

/**
 * Shared-secret gate for `/api/internal/*` — the surface the MCP connector calls.
 *
 * These routes sit outside the session cookie (the connector has no browser
 * session, and `middleware.ts` lists `/api/internal` under PUBLIC_PREFIXES for
 * exactly that reason) but they are not public: they turn on the lights in
 * someone's home and rewrite their scenes. Nothing upstream checks anything, so
 * every route here must call `internalSecretOk` as its first statement.
 *
 * Absent config fails CLOSED. An unset secret means nobody gets in — the
 * alternative, treating "no secret configured" as "no gate", turns a forgotten
 * environment variable into an open door onto the house.
 */
const HEADER = "x-internal-secret";

export function internalSecretOk(req: Request): boolean {
  const expected = process.env.MCP_INTERNAL_SECRET ?? "";
  if (!expected) return false;
  const got = req.headers.get(HEADER) ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so the lengths are compared
  // first. That leaks the secret's length, which is not worth defending here:
  // the value is a machine-generated random string set on both sides.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** One 401 shape for every internal route, so the client only parses one. */
export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

/** One 400 shape, carrying a message written to be read by a model. */
export function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}
