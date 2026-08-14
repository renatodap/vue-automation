/**
 * Home Assistant's WebSocket API — the registries, and nothing else.
 *
 * Everything about scenes, lamps and schedules goes through the app's
 * `/api/internal` routes, so there is exactly one implementation of each
 * behaviour. The REGISTRIES are the exception, for a structural reason rather
 * than a preference: they have NO REST surface at all — `config/*_registry/*`
 * exists only on the WebSocket API — and the Next app cannot reach them without
 * taking a WebSocket dependency for a feature it does not have.
 *
 * Two registries are read here, for two different halves of the same job:
 *
 *   • The ENTITY registry is one half of `name_device`. Zigbee2MQTT runs with
 *     `homeassistant_rename: false`, so renaming a device in z2m does NOT
 *     rename the Home Assistant entity. Both halves in one place is the whole
 *     point of that tool.
 *   • The DEVICE registry is how the Zigbee mesh is discovered at all. Reading
 *     it from the broker needs Mosquitto credentials this service cannot
 *     obtain (see ha-service.ts), but Home Assistant already holds a row for
 *     every joined device, with the IEEE address in its `identifiers` and the
 *     Zigbee2MQTT friendly name in `name`. Everything the four device tools
 *     need is here, one authenticated hop away, and it needs no broker.
 *
 * Stateless, like the rest of the service: connect, authenticate, send one
 * command, close.
 */
import WebSocket from "ws";
import { haBaseUrl, haToken } from "./env.js";

const TIMEOUT_MS = 8_000;

export class HaRegistryError extends Error {}

/** True when this connector has been given a way to reach Home Assistant. */
export const haConfigured = () => Boolean(haBaseUrl() && haToken());

async function wsCommand(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  if (!haConfigured()) {
    throw new HaRegistryError(
      "HA_BASE_URL / HA_TOKEN are not set on the connector, so the Home Assistant registries " +
        "cannot be reached. The lights, scenes and schedules still work — these are needed by the " +
        "Zigbee device tools (list_zigbee_devices, start_pairing, poll_pairing, name_device) only.",
    );
  }
  const url = haBaseUrl().replace(/^http/, "ws") + "/api/websocket";

  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      reject(new HaRegistryError(`Could not open a WebSocket to Home Assistant: ${(e as Error).message}`));
      return;
    }

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new HaRegistryError("Home Assistant did not answer in time."))),
      TIMEOUT_MS,
    );

    const id = 1;
    socket.on("error", (e: Error) =>
      finish(() => reject(new HaRegistryError(`Could not reach Home Assistant: ${e.message}`))));
    socket.on("close", () =>
      finish(() => reject(new HaRegistryError("Home Assistant closed the connection before answering."))));

    socket.on("message", (raw: unknown) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "auth_required") {
        socket.send(JSON.stringify({ type: "auth", access_token: haToken() }));
        return;
      }
      if (msg.type === "auth_invalid") {
        finish(() =>
          reject(new HaRegistryError("Home Assistant rejected HA_TOKEN — it may have been revoked.")));
        return;
      }
      if (msg.type === "auth_ok") {
        socket.send(JSON.stringify({ id, type, ...payload }));
        return;
      }
      if (msg.type === "result" && msg.id === id) {
        if (msg.success === true) finish(() => resolve(msg.result));
        else {
          const err = msg.error as { message?: string } | undefined;
          finish(() =>
            reject(
              new HaRegistryError(
                err?.message ??
                  `Home Assistant refused ${type}. The registry needs an ADMIN token; a ` +
                    `non-admin one is refused here even though it can read states.`,
              ),
            ));
        }
      }
    });
  });
}

export type RegistryEntry = {
  entity_id: string;
  name: string | null;
  original_name: string | null;
  platform: string;
  unique_id?: string;
  /** The device this entity belongs to. The join key for the device registry,
   *  and a far better match than guessing at `unique_id` substrings. */
  device_id?: string | null;
  disabled_by?: string | null;
};

/** Every entity the registry knows, with its platform, device and unique id —
 *  the map from a Zigbee device to the `light.*` that represents it. */
export async function entityRegistryList(): Promise<RegistryEntry[]> {
  const out = await wsCommand("config/entity_registry/list");
  return Array.isArray(out) ? (out as RegistryEntry[]) : [];
}

export type DeviceEntry = {
  id: string;
  /** What the integration called it — for a Zigbee2MQTT device, the z2m
   *  friendly name. This is the one to send back to z2m as a rename `from`. */
  name: string | null;
  /** A Home-Assistant-side override. Shown to people, unknown to z2m. */
  name_by_user: string | null;
  manufacturer: string | null;
  model: string | null;
  /** `[["mqtt", "zigbee2mqtt_0x00124b00…"]]` — where the IEEE address lives. */
  identifiers?: string[][];
  connections?: string[][];
  via_device_id?: string | null;
  disabled_by?: string | null;
  area_id?: string | null;
};

/**
 * Every device Home Assistant knows, across every integration.
 *
 * This is the primary source for the Zigbee mesh. A device only reaches this
 * registry once Home Assistant knows what it IS, which for a Zigbee2MQTT
 * device means the interview finished and discovery was published — so a row
 * appearing here is itself the signal that a pairing completed.
 */
export async function deviceRegistryList(): Promise<DeviceEntry[]> {
  const out = await wsCommand("config/device_registry/list");
  return Array.isArray(out) ? (out as DeviceEntry[]) : [];
}

/**
 * Set an entity's friendly name.
 *
 * `new_entity_id` is deliberately NOT offered. Every scene, automation and
 * Siri shortcut in the house references the entity id, and changing it breaks
 * all of them silently — the friendly name is the part a person actually reads.
 */
export async function renameEntity(entityId: string, name: string): Promise<unknown> {
  return wsCommand("config/entity_registry/update", { entity_id: entityId, name });
}
