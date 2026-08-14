/**
 * Zigbee2MQTT, straight off Mosquitto on the Pi — OPTIONAL ENRICHMENT ONLY.
 *
 * This used to be the primary path for the four device tools. It no longer is,
 * and the reason is not preference: Mosquitto requires credentials that live in
 * the Zigbee2MQTT / Mosquitto add-on configuration behind Home Assistant's
 * Supervisor, `/api/hassio/*` refuses a long-lived token with HTTP 401, and
 * Home Assistant never exposes a config entry's `data`. There is no path from
 * the credentials this service HAS to the credentials the broker WANTS, so
 * `Connection refused: Not authorized` at boot was permanent rather than a
 * misconfiguration.
 *
 * So Home Assistant is the primary path now (ha-registry.ts for reading the
 * mesh, ha-service.ts for publishing to it), and everything here is a bonus
 * that must never be required:
 *
 *   • `bridge/event` gives live interview progress during a pairing — the one
 *     signal Home Assistant genuinely does not have, because a device that
 *     fails its interview never reaches the device registry at all.
 *   • The retained `bridge/devices` / `bridge/info` topics add the z2m-only
 *     fields (`supported`, `power_source`, `interview_completed`).
 *   • A `bridge/response/*` subscription can CONFIRM a request that was
 *     published through Home Assistant, by transaction id.
 *
 * Nothing here throws into a tool. `tryConnect()` answers true or false, and a
 * failure is remembered for a few minutes so a broker that is refusing
 * credentials does not add nine seconds and a log line to every single call.
 *
 * ## Why a long-lived client under a stateless server
 *
 * Every HTTP request here is stateless — but the PROCESS is not, and pairing is
 * asynchronous by nature. A bulb announces itself somewhere between two and
 * ninety seconds after the reset, long after the `start_pairing` request has
 * returned. Subscribing per request would mean listening only during the exact
 * window nobody is watching. So one client stays connected and keeps a small
 * ring buffer of bridge events, and `poll_pairing` reads what has accumulated.
 *
 * Retained topics come back immediately on (re)subscribe, so the device list
 * survives a reconnect with no bookkeeping.
 */
import mqtt, { type MqttClient } from "mqtt";
import { mqttPassword, mqttUrl, mqttUsername, z2mBaseTopic } from "./env.js";

export class MqttError extends Error {}

export const mqttConfigured = () => Boolean(mqttUrl());

export type BridgeEvent = {
  received_at: string;
  type: string;
  data: Record<string, unknown>;
};

/** Bounded on purpose: this is a pairing scratchpad, not a log. */
const EVENT_BUFFER = 100;

/** How long a failed connect suppresses the next attempt. Long enough that a
 *  broker refusing credentials costs one attempt rather than one per call,
 *  short enough that fixing the credentials takes effect without a redeploy. */
const RETRY_AFTER_MS = 5 * 60_000;

let client: MqttClient | null = null;
let connecting: Promise<MqttClient> | null = null;
let lastFailureAt = 0;
const retained = new Map<string, unknown>();
const events: BridgeEvent[] = [];
/** Correlates a request with its `bridge/response/*`, by transaction id. */
const waiters = new Map<string, (msg: Record<string, unknown>) => void>();

function topics(): { devices: string; info: string; event: string; response: string } {
  const base = z2mBaseTopic();
  return {
    devices: `${base}/bridge/devices`,
    info: `${base}/bridge/info`,
    event: `${base}/bridge/event`,
    response: `${base}/bridge/response/#`,
  };
}

function connect(): Promise<MqttClient> {
  if (client?.connected) return Promise.resolve(client);
  if (connecting) return connecting;
  const url = mqttUrl();
  if (!url) {
    return Promise.reject(
      new MqttError("MQTT_URL is not set, so the broker cannot be used to enrich the Zigbee tools."),
    );
  }

  connecting = new Promise<MqttClient>((resolve, reject) => {
    const c = mqtt.connect(url, {
      username: mqttUsername(),
      password: mqttPassword(),
      connectTimeout: 8_000,
      reconnectPeriod: 5_000,
      clientId: `vue-mcp-${Math.random().toString(16).slice(2, 10)}`,
    });

    const fail = (e: Error) => {
      connecting = null;
      try {
        c.end(true);
      } catch {
        /* already ending */
      }
      reject(new MqttError(`Could not reach the MQTT broker on the Pi: ${e.message}`));
    };
    const timer = setTimeout(() => fail(new Error("timed out")), 9_000);

    c.once("error", (e: Error) => {
      clearTimeout(timer);
      fail(e);
    });
    // A permanent sink under the `once` above. mqtt.js retries on its own
    // schedule, and an 'error' event with no listener is thrown by the
    // EventEmitter itself — which would take down the whole connector over an
    // optional subsystem that is allowed to be unavailable.
    c.on("error", () => {});

    c.on("connect", () => {
      clearTimeout(timer);
      const t = topics();
      c.subscribe([t.devices, t.info, t.event, t.response], (err) => {
        if (err) return fail(err);
        client = c;
        connecting = null;
        resolve(c);
      });
    });

    c.on("message", (topic: string, payload: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString());
      } catch {
        parsed = payload.toString();
      }
      const t = topics();
      if (topic === t.devices || topic === t.info) {
        retained.set(topic, parsed);
        return;
      }
      if (topic === t.event) {
        const obj = (parsed ?? {}) as Record<string, unknown>;
        events.push({
          received_at: new Date().toISOString(),
          type: typeof obj.type === "string" ? obj.type : "unknown",
          data: (obj.data ?? {}) as Record<string, unknown>,
        });
        while (events.length > EVENT_BUFFER) events.shift();
        return;
      }
      if (topic.startsWith(`${z2mBaseTopic()}/bridge/response/`)) {
        const obj = (parsed ?? {}) as Record<string, unknown>;
        const tx = typeof obj.transaction === "string" ? obj.transaction : "";
        const waiter = tx ? waiters.get(tx) : undefined;
        if (waiter) {
          waiters.delete(tx);
          waiter(obj);
        }
      }
    });
  });

  return connecting;
}

/**
 * Connect if it is possible to, and say whether it worked. NEVER throws.
 *
 * Every caller of this is doing something optional, so the answer is a boolean
 * rather than an exception: a `false` means "carry on through Home Assistant",
 * not "tell the user something is broken".
 */
export async function tryConnect(): Promise<boolean> {
  if (!mqttUrl()) return false;
  if (client?.connected) return true;
  if (lastFailureAt && Date.now() - lastFailureAt < RETRY_AFTER_MS) return false;
  try {
    await connect();
    lastFailureAt = 0;
    return true;
  } catch {
    lastFailureAt = Date.now();
    return false;
  }
}

/**
 * A retained topic's payload, or null.
 *
 * Retained messages arrive on subscribe, so this only ever waits on the FIRST
 * call after a connect. Short timeout and a null rather than a throw: this is
 * enrichment, and a broker that is connected but silent must not slow a tool
 * down or fail it.
 */
async function retainedValue(topic: string, timeoutMs = 2_500): Promise<unknown> {
  if (retained.has(topic)) return retained.get(topic);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (retained.has(topic)) return retained.get(topic);
  }
  return null;
}

export type Z2mDevice = {
  ieee_address: string;
  friendly_name: string;
  type: string;
  manufacturer: string | null;
  model: string | null;
  supported: boolean;
  interviewing: boolean;
  interview_completed: boolean;
  power_source: string | null;
  disabled: boolean;
};

/** Everything joined to the mesh, coordinator included — or null when the
 *  broker is not available, which is the ordinary case. */
export async function listDevices(): Promise<Z2mDevice[] | null> {
  if (!(await tryConnect())) return null;
  const raw = await retainedValue(topics().devices);
  if (!Array.isArray(raw)) return null;
  return raw.map((d) => {
    const o = d as Record<string, unknown>;
    const def = (o.definition ?? null) as Record<string, unknown> | null;
    return {
      ieee_address: String(o.ieee_address ?? ""),
      friendly_name: String(o.friendly_name ?? ""),
      type: String(o.type ?? "Unknown"),
      manufacturer: typeof def?.vendor === "string" ? def.vendor : null,
      model: typeof def?.model === "string" ? def.model : null,
      supported: o.supported !== false,
      interviewing: o.interviewing === true,
      interview_completed: o.interview_completed !== false,
      power_source: typeof o.power_source === "string" ? o.power_source : null,
      disabled: o.disabled === true,
    };
  });
}

/** The bridge's own view: version, and whether joining is currently open.
 *  Null when the broker is not available. */
export async function bridgeInfo(): Promise<Record<string, unknown> | null> {
  if (!(await tryConnect())) return null;
  const raw = await retainedValue(topics().info);
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

/**
 * Bridge events seen since this process connected, newest last — or null when
 * the broker is not available.
 *
 * Null and `[]` are different answers and the tools report them differently:
 * `[]` means "listening, nothing happened", null means "not listening", and
 * only the first is evidence that nothing joined.
 */
export async function bridgeEvents(sinceIso?: string): Promise<BridgeEvent[] | null> {
  if (!(await tryConnect())) return null;
  if (!sinceIso) return [...events];
  return events.filter((e) => e.received_at > sinceIso);
}

/** A transaction id Zigbee2MQTT will echo back on `bridge/response/*`. */
export function newTransaction(): string {
  return `vuemcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Wait for the bridge's answer to a transaction, or give up quietly.
 *
 * The request itself is published through Home Assistant, which cannot report
 * what Zigbee2MQTT said back. When the broker happens to be reachable, this
 * recovers that half — the transaction id travels in the published payload, and
 * is the only correlation `bridge/response/*` carries (the Home Assistant MQTT
 * integration is publishing on the same broker, so "the next response" is not
 * good enough).
 *
 * Resolves to null when there is no connection, or when nothing answered in
 * time. Neither is a failure: Home Assistant accepted the publish either way,
 * and the caller reports the result as unconfirmed rather than as broken.
 */
export function awaitBridgeResponse(
  transaction: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown> | null> {
  if (!client?.connected) return Promise.resolve(null);
  return new Promise((resolve) => {
    waiters.set(transaction, resolve);
    setTimeout(() => {
      if (waiters.delete(transaction)) resolve(null);
    }, timeoutMs);
  });
}

export async function closeMqtt(): Promise<void> {
  const c = client;
  client = null;
  connecting = null;
  if (c) await new Promise<void>((resolve) => c.end(false, {}, () => resolve()));
}
