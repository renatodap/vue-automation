/**
 * Server-only configuration.
 *
 * Every value here is read at call time rather than at module load: Next
 * evaluates modules during `next build`, and a missing env var must fail the
 * request, not the build. A build that dies because production secrets aren't
 * present in the build container is the classic self-inflicted deploy failure.
 */

export class ConfigError extends Error {
  constructor(key: string) {
    super(`Missing required environment variable: ${key}`);
    this.name = "ConfigError";
  }
}

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new ConfigError(key);
  return value;
}

/** Base URL of Home Assistant, reachable from the server over the tailnet. */
export const haBaseUrl = () => required("HA_BASE_URL").replace(/\/+$/, "");

/** Long-lived access token minted in HA under the user's profile. */
export const haToken = () => required("HA_TOKEN");

/** Shared passphrase gating the whole app. */
export const appPassphrase = () => required("APP_PASSPHRASE");

/** Secret used to sign the session cookie. Rotating it logs everyone out. */
export const authSecret = () => required("AUTH_SECRET");

export const databaseUrl = () => process.env.DATABASE_URL || "";

/** Path prefix when mounted under renatodap.me/<name>; "" at a domain root. */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
