/**
 * The Zigbee mesh, as seen THROUGH Home Assistant.
 *
 * The four device tools (`list_zigbee_devices`, `start_pairing`,
 * `poll_pairing`, `name_device`) used to talk to Mosquitto directly. They
 * cannot: the broker's credentials are held in the Zigbee2MQTT / Mosquitto
 * add-on configuration behind Home Assistant's Supervisor, `/api/hassio/*`
 * refuses a long-lived token with HTTP 401, and Home Assistant never exposes a
 * config entry's `data`. Nothing this service can be given unlocks that broker.
 *
 * Home Assistant is already authenticated to it, so it acts as the bridge in
 * both directions:
 *
 *   • READ — the device registry has a row per joined device, with the IEEE
 *     address in `identifiers` and the Zigbee2MQTT friendly name in `name`.
 *     The entity registry joins on `device_id` to give each device its
 *     `light.*`. No retained topic, no subscription.
 *   • WRITE — `mqtt.publish` puts a bridge request on `zigbee2mqtt/bridge/
 *     request/*` through Home Assistant's own broker connection.
 *   • PAIRING — a device reaches the device registry only after its interview
 *     finishes and discovery is published, so a row APPEARING is itself the
 *     completion signal. Snapshot the registry when pairing opens, diff it when
 *     polled. That is the whole mechanism, and it needs no broker.
 *
 * The direct broker connection survives as strictly optional enrichment
 * (mqtt.ts): live interview progress, the z2m-only device fields, and
 * confirmation of a request published through Home Assistant. Every one of
 * those degrades to "unknown", never to an error.
 */
import { z2mBaseTopic } from "./env.js";
import {
  deviceRegistryList, entityRegistryList, haConfigured,
  type DeviceEntry, type RegistryEntry,
} from "./ha-registry.js";
import { entityState, mqttPublish } from "./ha-service.js";
import { awaitBridgeResponse, bridgeInfo, listDevices, newTransaction, tryConnect, type Z2mDevice } from "./mqtt.js";

/** A failure the model should read and act on, not an outage. */
export class ZigbeeError extends Error {}

// ------------------------------------------------------------ IEEE addresses

/** `zigbee2mqtt_0x00124b0022a1b2c3` → `0x00124b0022a1b2c3`. */
const IEEE_HEX = /0x[0-9a-fA-F]{16}/;
/** ZHA spells the same address `00:12:4b:00:22:a1:b2:c3`. */
const IEEE_COLONS = /(?:[0-9a-fA-F]{2}:){7}[0-9a-fA-F]{2}/;

/**
 * The IEEE address hidden in a device registry row, or null if it has none.
 *
 * This doubles as the filter for "is this a Zigbee device at all" — the
 * registry also holds the sun, the weather and every other integration, and
 * none of those carry an 8-byte address anywhere. Both spellings are read
 * because the identifier format belongs to whichever integration wrote it.
 */
export function ieeeAddressOf(device: DeviceEntry): string | null {
  const parts: string[] = [];
  for (const pair of device.identifiers ?? []) {
    for (const p of pair) if (typeof p === "string") parts.push(p);
  }
  for (const pair of device.connections ?? []) {
    for (const p of pair) if (typeof p === "string") parts.push(p);
  }
  for (const p of parts) {
    const hex = IEEE_HEX.exec(p);
    if (hex) return hex[0].toLowerCase();
  }
  for (const p of parts) {
    const colons = IEEE_COLONS.exec(p);
    if (colons) return `0x${colons[0].replace(/:/g, "").toLowerCase()}`;
  }
  return null;
}

/** Zigbee2MQTT publishes its own bridge as a device, and it is not a bulb. */
function looksLikeCoordinator(device: DeviceEntry): boolean {
  const parts = (device.identifiers ?? []).flat().filter((p): p is string => typeof p === "string");
  return parts.some((p) => /bridge|coordinator/i.test(p)) ||
    /bridge|coordinator/i.test(device.name ?? "");
}

// --------------------------------------------------------------- the survey

export type ZigbeeDevice = {
  ieee_address: string;
  /** What a person sees: the Home Assistant override if there is one. */
  friendly_name: string;
  /** What ZIGBEE2MQTT calls it, which is what a rename must be addressed to.
   *  `name_by_user` is a Home-Assistant-side override z2m has never heard of. */
  zigbee2mqtt_name: string;
  ha_device_id: string;
  manufacturer: string | null;
  model: string | null;
  is_coordinator: boolean;
  disabled: boolean;
  /** Every entity Home Assistant projects from this device. */
  entities: string[];
  /** The one a person means by "the lamp". */
  primary_entity: string | null;
  /** Broker-only fields. Null when the broker was not readable — which is not
   *  the same as false, and is reported as unknown rather than guessed. */
  interview_completed: boolean | null;
  supported: boolean | null;
  power_source: string | null;
};

export type ZigbeeSurvey = {
  read_at: string;
  devices: ZigbeeDevice[];
  source: "home_assistant_device_registry";
  enrichment: "zigbee2mqtt" | "unavailable";
  /** True, false, or null when neither the broker nor a permit-join entity
   *  could say. Null is an honest answer; false would be a guess. */
  pairing_open: boolean | null;
};

function entitiesByDevice(entities: RegistryEntry[]): Map<string, RegistryEntry[]> {
  const out = new Map<string, RegistryEntry[]>();
  for (const e of entities) {
    if (!e.device_id) continue;
    const list = out.get(e.device_id);
    if (list) list.push(e);
    else out.set(e.device_id, [e]);
  }
  return out;
}

/** A person says "the lamp" and means the light, not its link-quality sensor
 *  or its firmware-update entity. */
function primaryOf(entities: RegistryEntry[]): string | null {
  const order = ["light.", "switch.", "cover.", "fan.", "sensor."];
  for (const prefix of order) {
    const hit = entities.find((e) => e.entity_id.startsWith(prefix));
    if (hit) return hit.entity_id;
  }
  return entities[0]?.entity_id ?? null;
}

/** Whether the mesh is open to new devices, asked of whatever can answer.
 *  Never throws — an unknown here must not fail a tool. */
async function readPairingOpen(
  info: Record<string, unknown> | null,
  entities: RegistryEntry[],
): Promise<boolean | null> {
  if (info && typeof info.permit_join === "boolean") return info.permit_join;
  // Zigbee2MQTT publishes a permit-join switch through Home Assistant
  // discovery. It is the only reading of this available without the broker.
  const entity = entities.find((e) => /permit_join/i.test(e.entity_id));
  if (!entity) return null;
  try {
    const state = await entityState(entity.entity_id);
    const value = state?.state;
    if (value === "on") return true;
    if (value === "off") return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * Every Zigbee device Home Assistant knows, with its entities.
 *
 * Home Assistant is the source. The broker is asked afterwards and only adds
 * fields; if it is unreachable — the ordinary case — the survey is complete
 * apart from three nullable columns.
 */
export async function surveyZigbee(): Promise<ZigbeeSurvey> {
  if (!haConfigured()) {
    throw new ZigbeeError(
      "HA_BASE_URL / HA_TOKEN are not set on the connector, so the Zigbee mesh cannot be read. " +
        "Home Assistant is the only path to it — the broker's credentials live behind the " +
        "Supervisor and cannot be reached from here. get_room still reports the lights that are " +
        "already set up.",
    );
  }

  const [devices, entities] = await Promise.all([
    deviceRegistryList(),
    entityRegistryList().catch(() => [] as RegistryEntry[]),
  ]);

  // Enrichment, in one place and never fatal.
  const z2mList = await listDevices().catch(() => null);
  const z2mByIeee = new Map<string, Z2mDevice>();
  for (const d of z2mList ?? []) {
    if (d.ieee_address) z2mByIeee.set(d.ieee_address.toLowerCase(), d);
  }

  const byDevice = entitiesByDevice(entities);
  const out: ZigbeeDevice[] = [];
  for (const device of devices) {
    const ieee = ieeeAddressOf(device);
    if (!ieee) continue;
    const mine = byDevice.get(device.id) ?? [];
    const z2m = z2mByIeee.get(ieee) ?? null;
    const discoveryName = z2m?.friendly_name || device.name || ieee;
    out.push({
      ieee_address: ieee,
      friendly_name: device.name_by_user || device.name || discoveryName,
      zigbee2mqtt_name: discoveryName,
      ha_device_id: device.id,
      manufacturer: device.manufacturer ?? z2m?.manufacturer ?? null,
      model: device.model ?? z2m?.model ?? null,
      is_coordinator: looksLikeCoordinator(device) || z2m?.type === "Coordinator",
      disabled: Boolean(device.disabled_by) || z2m?.disabled === true,
      entities: mine.map((e) => e.entity_id).sort(),
      primary_entity: primaryOf(mine),
      interview_completed: z2m ? z2m.interview_completed : null,
      supported: z2m ? z2m.supported : null,
      power_source: z2m?.power_source ?? null,
    });
  }
  out.sort((a, b) => a.friendly_name.localeCompare(b.friendly_name));

  const info = await bridgeInfo().catch(() => null);
  return {
    read_at: new Date().toISOString(),
    devices: out,
    source: "home_assistant_device_registry",
    enrichment: z2mList ? "zigbee2mqtt" : "unavailable",
    pairing_open: await readPairingOpen(info, entities),
  };
}

/** Resolve what a person or a model said into one device. */
export function findZigbeeDevice(devices: ZigbeeDevice[], needle: string): ZigbeeDevice | undefined {
  const n = needle.trim().toLowerCase();
  return (
    devices.find((d) => d.ieee_address.toLowerCase() === n) ??
    devices.find((d) => d.zigbee2mqtt_name.toLowerCase() === n) ??
    devices.find((d) => d.friendly_name.toLowerCase() === n) ??
    devices.find((d) => d.ha_device_id === needle) ??
    devices.find((d) => d.entities.some((e) => e.toLowerCase() === n))
  );
}

// ------------------------------------------------------------ bridge requests

export type Z2mRequestResult = {
  published: true;
  /** Whether Zigbee2MQTT itself said it worked. False means "Home Assistant
   *  accepted the publish and nobody was listening for the answer", NOT that it
   *  failed — the difference matters and every caller reports it. */
  confirmed: boolean;
  via: "home_assistant_mqtt_publish";
  response: Record<string, unknown> | null;
};

/**
 * Publish a Zigbee2MQTT bridge request through Home Assistant.
 *
 * A transaction id goes out with every payload even though nothing usually
 * reads it back: it costs nothing, Zigbee2MQTT echoes it, and when the broker
 * happens to be reachable it turns a fire-and-forget publish into a confirmed
 * one. Throws only when Zigbee2MQTT explicitly REFUSED — a silent absence of
 * confirmation comes back as `confirmed: false`.
 */
export async function z2mRequest(
  request: string,
  payload: Record<string, unknown>,
): Promise<Z2mRequestResult> {
  const transaction = newTransaction();
  await tryConnect();
  const answer = awaitBridgeResponse(transaction);
  await mqttPublish(`${z2mBaseTopic()}/bridge/request/${request}`, { ...payload, transaction });
  const response = await answer;
  if (response && response.status === "error") {
    throw new ZigbeeError(String(response.error ?? `Zigbee2MQTT refused ${request}.`));
  }
  return {
    published: true,
    confirmed: Boolean(response && response.status === "ok"),
    via: "home_assistant_mqtt_publish",
    response,
  };
}

// ---------------------------------------------------------- pairing snapshot

export type PairingSnapshot = {
  at: string;
  open_for_seconds: number;
  device_ids: string[];
  ieee_addresses: string[];
};

/**
 * The baseline `poll_pairing` diffs against.
 *
 * In memory, like the bridge-event buffer, and for the same reason: pairing is
 * a conversation inside one process lifetime. A restart between opening and
 * polling loses the baseline, and `poll_pairing` says so rather than reporting
 * every bulb in the house as newly joined.
 */
let snapshot: PairingSnapshot | null = null;

/**
 * Zigbee's own ceiling on how long a mesh can be held open.
 *
 * The permit-join duration is an 8-bit field, so 254 is the protocol's limit
 * and NOT a policy choice here. Asking Zigbee2MQTT for more is rejected
 * SILENTLY: `mqtt.publish` still returns 200, nothing opens, and no error is
 * readable from this side because nothing is subscribed to bridge/response.
 * This tool was capped at 600 once; a request for 300 looked exactly like
 * success and sent someone off to reset a bulb into a mesh that was shut.
 */
export const MAX_PERMIT_JOIN_SECONDS = 254;

/** Zigbee2MQTT publishes a permit-join switch through Home Assistant discovery,
 *  and it hangs off the coordinator device. It is the only readable fact about
 *  whether the mesh is actually open. */
export function permitJoinEntity(devices: ZigbeeDevice[]): string | null {
  for (const device of devices) {
    const hit = device.entities.find((e) => /permit_join/i.test(e));
    if (hit) return hit;
  }
  return null;
}

const CONFIRM_ATTEMPTS = 4;
const CONFIRM_DELAY_MS = 1000;

/**
 * Read the permit-join switch back until it agrees with what was asked for.
 *
 * A publish proves only that Home Assistant accepted it. Zigbee2MQTT answers on
 * bridge/response/*, which nothing here subscribes to, so "sent" and "worked"
 * are indistinguishable without reading state — and this is the same rule as
 * invariant 10: verify a write against a FRESH read, never against the response
 * to the write itself.
 *
 * Returns null when the switch could not be read at all. Null is an honest
 * "unknown"; false would claim the mesh is shut on no evidence.
 */
export async function confirmPermitJoin(
  entityId: string | null,
  want: boolean,
): Promise<boolean | null> {
  if (!entityId) return null;
  let last: boolean | null = null;
  for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
    try {
      const value = (await entityState(entityId))?.state;
      last = value === "on" ? true : value === "off" ? false : null;
      if (last === want) return last;
    } catch {
      last = null;
    }
    if (attempt < CONFIRM_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_DELAY_MS));
    }
  }
  return last;
}

export function takePairingSnapshot(devices: ZigbeeDevice[], openForSeconds: number): PairingSnapshot {
  snapshot = {
    at: new Date().toISOString(),
    open_for_seconds: openForSeconds,
    device_ids: devices.map((d) => d.ha_device_id),
    ieee_addresses: devices.map((d) => d.ieee_address.toLowerCase()),
  };
  return snapshot;
}

export function pairingSnapshot(): PairingSnapshot | null {
  return snapshot;
}

/** Exported for the tests, which need a process with no pairing in flight. */
export function clearPairingSnapshot(): void {
  snapshot = null;
}

/** Devices in the registry now that were not in it when pairing opened. */
export function devicesSinceSnapshot(
  devices: ZigbeeDevice[],
  since: PairingSnapshot,
): ZigbeeDevice[] {
  const ids = new Set(since.device_ids);
  const ieee = new Set(since.ieee_addresses);
  return devices.filter((d) => !ids.has(d.ha_device_id) && !ieee.has(d.ieee_address.toLowerCase()));
}
