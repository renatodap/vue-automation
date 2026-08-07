import { SignJWT, jwtVerify } from "jose";

/**
 * Single shared passphrase, exchanged for a signed cookie.
 *
 * There is one user. Accounts, password resets and a users table would all be
 * machinery serving nobody. What this does have to do is fail closed: the app
 * is on the public internet and it turns on the lights in someone's home.
 */

export const SESSION_COOKIE = "vue_session";
const ISSUER = "vue-automation";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days — this is a light switch

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function issueSession(secret: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(key(secret));
}

export async function verifySession(
  token: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!token) return false;
  try {
    await jwtVerify(token, key(secret), { issuer: ISSUER });
    return true;
  } catch {
    return false;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: MAX_AGE_SECONDS,
};

/**
 * Constant-time-ish comparison. Not defending against a remote timing attack
 * over the internet — that's not a realistic channel here — but there is no
 * reason to write the naive version.
 */
export function passphraseMatches(input: string, expected: string): boolean {
  if (input.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < input.length; i++) {
    diff |= input.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
