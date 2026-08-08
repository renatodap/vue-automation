import "server-only";
import { haBaseUrl, haToken } from "./env";

/**
 * Home Assistant REST client. Server-side only — the browser never talks to
 * Home Assistant directly.
 *
 * Two reasons that isn't just a preference:
 *   1. HA lives on a private LAN behind Tailscale. A phone on cellular has no
 *      route to it, and an HTTPS page cannot call a plaintext LAN address
 *      anyway — browsers block mixed content.
 *   2. The HA token is a full-control credential. Shipping it to the client
 *      would hand anyone with devtools the ability to drive the house.
 */

export type HaState = {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
};

export class HaUnreachableError extends Error {
  constructor(cause?: unknown) {
    super("Home Assistant is unreachable");
    this.name = "HaUnreachableError";
    this.cause = cause;
  }
}

export class HaAuthError extends Error {
  constructor() {
    super("Home Assistant rejected the access token");
    this.name = "HaAuthError";
  }
}

/** How long to wait on HA before giving up and telling the user plainly. */
const TIMEOUT_MS = 8_000;

async function haFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${haBaseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${haToken()}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
      // Light state is never cacheable — a stale reading rendered as current is
      // worse than an error, because the user acts on it.
      cache: "no-store",
    });
  } catch (cause) {
    throw new HaUnreachableError(cause);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) throw new HaAuthError();
  if (!response.ok) {
    throw new Error(`Home Assistant returned ${response.status} for ${path}`);
  }

  return (await response.json()) as T;
}

export async function getStates(): Promise<HaState[]> {
  return haFetch<HaState[]>("/api/states");
}

export async function callService(
  domain: string,
  service: string,
  data: Record<string, unknown>,
): Promise<HaState[]> {
  return haFetch<HaState[]>(`/api/services/${domain}/${service}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/** Cheap liveness probe used by the connection banner. */
export async function ping(): Promise<boolean> {
  try {
    await haFetch<{ message: string }>("/api/");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- projections

export type Lamp = {
  entityId: string;
  name: string;
  /** false when the bulb has lost power — someone flipped the lamp switch. */
  reachable: boolean;
  on: boolean;
  /** 0–100, null when off or not reported. */
  brightness: number | null;
  /** Mired-derived Kelvin, null when the bulb is in colour mode or off. */
  kelvin: number | null;
  /** The bulb's own reported tunable range — never hardcode 2700–6500. */
  minKelvin: number;
  maxKelvin: number;
  rgb: [number, number, number] | null;
};

export type Scene = {
  entityId: string;
  name: string;
  /** ISO timestamp of when HA last applied it, or null if never this boot. */
  lastActivated: string | null;
};

function friendlyName(state: HaState, fallback: string): string {
  const name = state.attributes["friendly_name"];
  return typeof name === "string" && name.length > 0 ? name : fallback;
}

export function toLamps(states: HaState[]): Lamp[] {
  return states
    .filter((s) => s.entity_id.startsWith("light."))
    .map((s) => {
      // HA reports "unavailable" for a bulb whose power was cut, and
      // "unknown" before it has ever reported in. Both mean "don't pretend
      // you know what this light is doing".
      const reachable = s.state !== "unavailable" && s.state !== "unknown";
      const raw = s.attributes["brightness"];
      const brightness =
        typeof raw === "number" ? Math.round((raw / 255) * 100) : null;
      const kelvinRaw = s.attributes["color_temp_kelvin"];
      const rgbRaw = s.attributes["rgb_color"];

      const minK = s.attributes["min_color_temp_kelvin"];
      const maxK = s.attributes["max_color_temp_kelvin"];

      return {
        entityId: s.entity_id,
        name: friendlyName(s, s.entity_id.replace(/^light\./, "")),
        reachable,
        on: s.state === "on",
        brightness: s.state === "on" ? brightness : null,
        kelvin: typeof kelvinRaw === "number" ? kelvinRaw : null,
        // Fall back to the ZL1's range only if the bulb doesn't report its own.
        minKelvin: typeof minK === "number" ? minK : 2000,
        maxKelvin: typeof maxK === "number" ? maxK : 6500,
        rgb: Array.isArray(rgbRaw) && rgbRaw.length === 3
          ? (rgbRaw as [number, number, number])
          : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function toScenes(states: HaState[]): Scene[] {
  return states
    .filter((s) => s.entity_id.startsWith("scene."))
    .map((s) => ({
      entityId: s.entity_id,
      name: friendlyName(s, s.entity_id.replace(/^scene\./, "")),
      // HA stores a scene's `state` as the timestamp it was last applied, or
      // "unknown" if it hasn't been since the last restart.
      lastActivated: s.state === "unknown" ? null : s.state,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
