/**
 * The one Home Assistant call this connector makes directly.
 *
 * Everything else about the house goes through the app's `/api/internal`
 * routes, so there is exactly one implementation of each behaviour. The entity
 * registry is the exception, for a structural reason rather than a preference:
 * it has NO REST surface at all — `config/entity_registry/update` exists only
 * on Home Assistant's WebSocket API — and the Next app cannot reach it without
 * taking a WebSocket dependency for a feature it does not have.
 *
 * It belongs here anyway, because it is one half of `name_device`: Zigbee2MQTT
 * runs with `homeassistant_rename: false`, so renaming a device in z2m does NOT
 * rename the Home Assistant entity. Both halves in one place is the whole point
 * of that tool.
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
      "HA_BASE_URL / HA_TOKEN are not set on the connector, so the Home Assistant entity " +
        "registry cannot be reached. Everything else still works — only entity renaming needs them.",
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
};

/** Every entity the registry knows, with its platform and unique id — the map
 *  from a Zigbee device to the `light.*` that represents it. */
export async function entityRegistryList(): Promise<RegistryEntry[]> {
  const out = await wsCommand("config/entity_registry/list");
  return Array.isArray(out) ? (out as RegistryEntry[]) : [];
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
