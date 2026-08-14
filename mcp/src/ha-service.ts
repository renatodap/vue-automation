/**
 * Home Assistant's REST API — service calls and single-entity state reads.
 *
 * The counterpart to ha-registry.ts, which speaks WebSocket because the
 * registries have no REST surface at all. This file exists for the mirror-image
 * reason: `mqtt.publish` is a SERVICE, and services are REST.
 *
 * ## Why the connector publishes to Zigbee2MQTT through Home Assistant
 *
 * Zigbee2MQTT sits behind Mosquitto on the Pi, and Mosquitto requires
 * credentials this service cannot be given. They live in the Mosquitto /
 * Zigbee2MQTT add-on configuration behind Home Assistant's Supervisor, and a
 * long-lived access token — even an admin one — is refused by `/api/hassio/*`
 * with HTTP 401; Home Assistant also never exposes a config entry's `data` over
 * any API. There is no path from a token to that password, so a connector that
 * needs one is a connector that stays broken.
 *
 * Home Assistant, though, is ALREADY authenticated to that broker: the MQTT
 * integration owns the connection, and `mqtt.publish` puts an arbitrary payload
 * on an arbitrary topic through it. So every bridge request goes
 * `connector → HA → Mosquitto → z2m` instead of `connector → Mosquitto`, using
 * the token this service already has for everything else.
 *
 * What is lost is the RETURN path: a publish is fire-and-forget, and
 * Zigbee2MQTT answers on `bridge/response/*`, which nobody here is subscribed
 * to. That is why the direct broker connection survives as optional enrichment
 * (mqtt.ts) and why every result that could not be confirmed says so rather
 * than assuming.
 *
 * Stateless, like the rest of the service.
 */
import { haBaseUrl, haToken } from "./env.js";
import { haConfigured } from "./ha-registry.js";

export class HaServiceError extends Error {}

const TIMEOUT_MS = 15_000;

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!haConfigured()) {
    throw new HaServiceError(
      "HA_BASE_URL / HA_TOKEN are not set on the connector, so Home Assistant cannot be asked to " +
        "publish to the Zigbee2MQTT broker. Nothing was sent.",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await globalThis.fetch(`${haBaseUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${haToken()}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      // Invariant #3: a stale reading presented as current is worse than an
      // error, because the user acts on it.
      cache: "no-store",
    });
  } catch (e) {
    throw new HaServiceError(
      (e as Error).name === "AbortError"
        ? "Home Assistant took too long to answer. Nothing is known to have been sent — re-read " +
          "before retrying rather than assuming it did not land."
        : "Couldn't reach Home Assistant over the tailnet. Nothing was sent.",
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body — fall through to the status message */
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new HaServiceError(
        "Home Assistant rejected HA_TOKEN. It may have been revoked, or it may not be an ADMIN " +
          "token — the registries and service calls both need one.",
      );
    }
    const detail =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : text.slice(0, 300);
    throw new HaServiceError(
      `Home Assistant returned HTTP ${res.status} for ${path}${detail ? `: ${detail}` : "."}`,
    );
  }
  return parsed as T;
}

/**
 * Call a Home Assistant service.
 *
 * DELIBERATELY NOT EXPORTED. Invariant #8: nothing a model calls gets an
 * unconstrained mutation path, and a generic `call_service` reachable from the
 * tool layer is exactly that — one argument away from every switch, lock and
 * heater in the house. The only caller is `mqttPublish` below, which is fenced
 * to Zigbee2MQTT's bridge topics by the tools that use it.
 */
async function callService(
  domain: string,
  service: string,
  data: Record<string, unknown>,
): Promise<unknown> {
  return request("POST", `/api/services/${domain}/${service}`, data);
}

/**
 * Put a payload on an MQTT topic, through Home Assistant's broker connection.
 *
 * The payload is serialised here because `mqtt.publish` takes a STRING; passing
 * an object leaves Home Assistant to stringify it in a shape Zigbee2MQTT does
 * not parse. Only `topic` and `payload` are sent — the two fields verified
 * against the live instance — so no optional field can be the thing a given
 * Home Assistant version rejects.
 */
export async function mqttPublish(topic: string, payload: unknown): Promise<void> {
  await callService("mqtt", "publish", {
    topic,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

/** One entity's state, or null if it does not exist. Never throws for a 404:
 *  "no such entity" is an answer, not an outage. */
export async function entityState(entityId: string): Promise<Record<string, unknown> | null> {
  try {
    return await request<Record<string, unknown>>("GET", `/api/states/${encodeURIComponent(entityId)}`);
  } catch (e) {
    if (e instanceof HaServiceError && /HTTP 404/.test(e.message)) return null;
    throw e;
  }
}
