/**
 * Configuration, read at CALL time rather than at module load.
 *
 * Same rule as `web/src/lib/env.ts`: a missing variable must fail the request
 * that needs it, never the process. A boot that dies because MQTT_URL is unset
 * would take the whole connector offline over a feature nobody was using.
 */

export class ConfigError extends Error {
  constructor(key: string, why?: string) {
    super(
      `Missing required environment variable: ${key}.${why ? ` ${why}` : ""} ` +
        `Set it on the connector service (Coolify → vue-automation-mcp → Environment) and redeploy.`,
    );
    this.name = "ConfigError";
  }
}

/** Where the PWA lives. Every read and write about the house goes through it. */
export const appInternalUrl = () =>
  (process.env.APP_INTERNAL_URL || "https://renatodap.me/vue-automation").replace(/\/+$/, "");

/** Shared secret for the app's `/api/internal/*` routes. Set on BOTH apps. */
export const internalSecret = () => process.env.MCP_INTERNAL_SECRET || "";

/** The passphrase that gates the OAuth consent screen. */
export const mcpPassphrase = () =>
  process.env.MCP_PASSPHRASE || process.env.APP_PASSPHRASE || "";

/**
 * OAuth state, the audit trail and pending proposals — and nothing else.
 *
 * Scene metadata is NOT read or written here; that belongs to the app, which
 * owns its database. `registry.json` records no database for this service, so
 * `infra db *` must never target it.
 */
export const databaseUrl = () => {
  const raw = process.env.DATABASE_URL || "";
  // Strip the query string. The app's own URL carries Prisma's `?schema=public`,
  // and postgres.js forwards unknown query params to the server as connection
  // options — where `schema` is not a GUC, so the connection dies with a FATAL
  // `unrecognized configuration parameter "schema"` and every OAuth call answers
  // temporarily_unavailable. Copying that value across is the obvious thing to
  // do, so tolerate it here rather than relying on whoever sets the env var
  // remembering; homeassistant/README.md strips it the same way for psql.
  const q = raw.indexOf("?");
  return q === -1 ? raw : raw.slice(0, q);
};

/**
 * Home Assistant, direct, over the tailnet — REQUIRED by the Zigbee tools.
 *
 * Two things live only here. The entity and device registries are WebSocket-
 * only commands with no REST equivalent, which the Next app cannot reach
 * without taking a dependency for a feature it does not have. And `mqtt.publish`
 * is how a Zigbee2MQTT bridge request gets onto the broker at all: Mosquitto's
 * credentials sit in the add-on configuration behind the Supervisor, which
 * refuses a long-lived token, while Home Assistant is already authenticated to
 * it. Port 80 over the tailnet, not 8123.
 *
 * Without these, `get_room` and every scene, lamp and schedule tool still work
 * — they go through the app — but the four Zigbee device tools cannot.
 */
export const haBaseUrl = () => (process.env.HA_BASE_URL || "").replace(/\/+$/, "");
export const haToken = () => process.env.HA_TOKEN || "";

/**
 * Mosquitto on the Pi, over the tailnet: `mqtt://100.85.128.101:1883`.
 *
 * OPTIONAL ENRICHMENT ONLY. When it connects, `poll_pairing` gains live
 * interview progress off `bridge/event` and the device list gains the z2m-only
 * fields; when it does not — the ordinary case, because the broker's password
 * is not obtainable from here — every Zigbee tool still works through Home
 * Assistant and simply reports those fields as unknown.
 */
export const mqttUrl = () => process.env.MQTT_URL || "";
export const mqttUsername = () => process.env.MQTT_USERNAME || undefined;
export const mqttPassword = () => process.env.MQTT_PASSWORD || undefined;

/** Zigbee2MQTT's topic root. Only different if z2m was reconfigured. */
export const z2mBaseTopic = () =>
  (process.env.Z2M_BASE_TOPIC || "zigbee2mqtt").replace(/\/+$/, "");
