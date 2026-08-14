/**
 * Zigbee2MQTT, over Mosquitto on the Pi.
 *
 * This is the one domain with no equivalent anywhere in the web app: the PWA
 * has never needed to see the Zigbee mesh, only the lights Home Assistant
 * exposes from it. Pairing a new bulb, listing what is actually joined, and
 * renaming a device all happen a layer below Home Assistant, so they talk to
 * the broker directly.
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
 * Retained topics (`bridge/devices`, `bridge/info`) come back immediately on
 * (re)subscribe, so the device list survives a reconnect with no bookkeeping.
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

let client: MqttClient | null = null;
let connecting: Promise<MqttClient> | null = null;
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
      new MqttError(
        "MQTT_URL is not set on the connector, so the Zigbee mesh cannot be reached. " +
          "Pairing and device naming need it; everything else works without it.",
      ),
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

/** Connect if not already, so the event buffer starts filling. */
export async function ensureConnected(): Promise<void> {
  await connect();
}

/**
 * A retained topic's payload.
 *
 * Retained messages arrive on subscribe, so this only ever waits on the FIRST
 * call after a connect. `bridge/devices` is retained by Zigbee2MQTT precisely
 * so a late subscriber learns the mesh without asking.
 */
async function retainedValue(topic: string, timeoutMs = 5_000): Promise<unknown> {
  await connect();
  if (retained.has(topic)) return retained.get(topic);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (retained.has(topic)) return retained.get(topic);
  }
  throw new MqttError(
    `Zigbee2MQTT never published ${topic}. Either z2m is not running, or its base topic ` +
      `is not "${z2mBaseTopic()}" — set Z2M_BASE_TOPIC if it was reconfigured.`,
  );
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

/** Everything joined to the mesh, coordinator included. */
export async function listDevices(): Promise<Z2mDevice[]> {
  const raw = await retainedValue(topics().devices);
  if (!Array.isArray(raw)) return [];
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

/** The bridge's own view: version, and whether joining is currently open. */
export async function bridgeInfo(): Promise<Record<string, unknown>> {
  const raw = await retainedValue(topics().info);
  return (raw ?? {}) as Record<string, unknown>;
}

/** Bridge events seen since the process started, newest last. */
export function recentEvents(sinceIso?: string): BridgeEvent[] {
  if (!sinceIso) return [...events];
  return events.filter((e) => e.received_at > sinceIso);
}

async function publish(topic: string, payload: unknown): Promise<void> {
  const c = await connect();
  await new Promise<void>((resolve, reject) => {
    c.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) =>
      err ? reject(new MqttError(`Publish to ${topic} failed: ${err.message}`)) : resolve());
  });
}

/**
 * Publish a bridge request and wait for the matching response.
 *
 * Zigbee2MQTT echoes a `transaction` field back on `bridge/response/*`, which
 * is the only reliable way to tell your answer from somebody else's — the
 * response topic carries no other correlation, and the HA integration is
 * publishing on the same broker.
 */
async function requestResponse(
  request: string,
  payload: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  await connect();
  const transaction = `vuemcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const answered = new Promise<Record<string, unknown>>((resolve, reject) => {
    waiters.set(transaction, resolve);
    setTimeout(() => {
      if (waiters.delete(transaction)) {
        reject(
          new MqttError(
            `Zigbee2MQTT did not answer ${request} within ${Math.round(timeoutMs / 1000)}s. ` +
              `It may have applied anyway — read the device list before retrying.`,
          ),
        );
      }
    }, timeoutMs);
  });
  await publish(`${z2mBaseTopic()}/bridge/request/${request}`, { ...payload, transaction });
  const res = await answered;
  if (res.status === "error") {
    throw new MqttError(String(res.error ?? `Zigbee2MQTT refused ${request}.`));
  }
  return res;
}

/** Open the mesh to new devices for `seconds`. Pass 0 to close it again. */
export async function permitJoin(seconds: number): Promise<Record<string, unknown>> {
  return requestResponse("permit_join", { time: Math.max(0, Math.min(600, Math.round(seconds))) });
}

/** Rename a device in Zigbee2MQTT. Half of `name_device` — see ha-registry.ts
 *  for why the other half is needed. */
export async function renameDevice(from: string, to: string): Promise<Record<string, unknown>> {
  return requestResponse("device/rename", { from, to });
}

export async function closeMqtt(): Promise<void> {
  const c = client;
  client = null;
  connecting = null;
  if (c) await new Promise<void>((resolve) => c.end(false, {}, () => resolve()));
}
