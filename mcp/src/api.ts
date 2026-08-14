/**
 * Client for the vue-automation app's `/api/internal` surface.
 *
 * Every read and write about the house goes through here rather than straight
 * to Home Assistant, so the entity projections, the scene snapshot rules, the
 * clamping and — above all — the partial-application judgement of invariant #4
 * keep exactly ONE implementation: the app's. Two implementations of a safety
 * behaviour is two implementations that drift, and the one that drifts is the
 * one nobody is looking at.
 *
 * This file is transport, not logic.
 */
import { appInternalUrl, internalSecret } from "./env.js";

export class ApiError extends Error {
  /** The app's own HTTP status, so a caller can tell input from outage. */
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const TIMEOUT_MS = 20_000;

async function request<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const secret = internalSecret();
  if (!secret) {
    throw new ApiError(
      "The connector is missing MCP_INTERNAL_SECRET, so it cannot reach the app that " +
        "talks to the house. Nothing was read or changed.",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await globalThis.fetch(`${appInternalUrl()}/api/internal${path}`, {
      method,
      headers: {
        "x-internal-secret": secret,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      // Never cached, at any layer. A stale reading presented as current is
      // worse than an error, because the user acts on it (invariant #3).
      cache: "no-store",
    });
  } catch (e) {
    throw new ApiError(
      (e as Error).name === "AbortError"
        ? "The lighting app took too long to answer. Nothing was changed — try again."
        : "Couldn't reach the lighting app. Nothing was read or changed.",
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body — fall through to the status message */
  }

  if (!res.ok) {
    const msg =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `The lighting app returned HTTP ${res.status}.`;
    // A 4xx here is nearly always the caller's input (an entity that no longer
    // exists, a malformed colour, a scene with no editable id) — surfacing the
    // app's own message lets the model fix it and retry rather than guess.
    throw new ApiError(msg, res.status);
  }
  return parsed as T;
}

// ------------------------------------------------------------------- shapes

export type Lamp = {
  entityId: string;
  name: string;
  reachable: boolean;
  on: boolean;
  brightness: number | null;
  kelvin: number | null;
  minKelvin: number;
  maxKelvin: number;
  rgb: [number, number, number] | null;
  hs: [number, number] | null;
  supportsColor: boolean;
  colorMode: string | null;
};

export type SceneRow = {
  entityId: string;
  name: string;
  id: string | null;
  label: string;
  accent: string | null;
  sortOrder: number | null;
  tapCount: number;
  lastActivated: string | null;
  lastTappedAt: string | null;
  aliases: string[];
};

export type AutomationRow = {
  entityId: string;
  name: string;
  id: string | null;
  enabled: boolean;
  lastTriggered: string | null;
};

export type StateResponse = {
  ok: true;
  read_at: string;
  scenes: SceneRow[];
  lamps: Lamp[];
  automations: AutomationRow[];
  unreachableCount: number;
  metadata: "ok" | "unavailable";
};

export type ApplyResponse = {
  ok: true;
  applied_entity_id: string;
  scene: string;
  read_at: string;
  /** The lamp NAMES that ended up where the scene asked. */
  applied: string[];
  unreachable: string[];
  did_not_match: Array<{ lamp: string; wanted: string; got: string }>;
  fully_applied: boolean;
  summary: string;
  lamps: Lamp[];
};

export const api = {
  /** Everything about the house, in one round trip. */
  state: () => request<StateResponse>("GET", "/state"),

  sceneConfig: (id: string) =>
    request<{ ok: true; id: string; config: { name?: string; entities?: Record<string, unknown> } | null }>(
      "GET",
      `/scene?id=${encodeURIComponent(id)}`,
    ),

  applyScene: (entityId: string, transition?: number) =>
    request<ApplyResponse>("POST", "/scene", { action: "apply", entity_id: entityId, transition }),

  saveScene: (name: string, id?: string) =>
    request<{
      ok: true; id: string; name: string; captured: number;
      entities: Record<string, unknown>; replaced: unknown; skipped: string[];
    }>("POST", "/scene", { action: "save", name, id }),

  deleteScene: (id: string) =>
    request<{ ok: true; deleted: string; was: unknown }>("POST", "/scene", { action: "delete", id }),

  setLamp: (body: Record<string, unknown>) =>
    request<{
      ok: true; read_at: string; lamps: Lamp[]; unreachable: string[];
      fully_applied: boolean; summary: string;
    }>("POST", "/lamp", body),

  sceneMeta: (body: Record<string, unknown>) =>
    request<Record<string, unknown>>("POST", "/scene-meta", body),

  scheduleConfig: (id: string) =>
    request<{ ok: true; id: string; config: Record<string, unknown> | null }>(
      "GET",
      `/schedule?id=${encodeURIComponent(id)}`,
    ),

  saveSchedule: (body: Record<string, unknown>) =>
    request<{ ok: true; id: string; name: string; replaced: unknown }>("POST", "/schedule", {
      action: "save",
      ...body,
    }),

  enableSchedule: (entityId: string, enabled: boolean) =>
    request<{ ok: true; entity_id: string; enabled: boolean; was: boolean }>("POST", "/schedule", {
      action: "enable",
      entity_id: entityId,
      enabled,
    }),

  deleteSchedule: (id: string) =>
    request<{ ok: true; deleted: string; was: unknown }>("POST", "/schedule", { action: "delete", id }),

  history: (days: number) =>
    request<Record<string, unknown>>("GET", `/history?days=${encodeURIComponent(String(days))}`),

  query: (query: string, maxRows: number) =>
    request<Record<string, unknown>>("POST", "/query", { query, max_rows: maxRows }),
};
