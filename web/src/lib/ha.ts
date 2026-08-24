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

/**
 * Write a persistent scene through HA's own scene-editor API.
 *
 * `scene.create` would be the obvious service, but the scenes it makes vanish
 * on restart — they live in memory only. This endpoint is what the built-in
 * scene editor posts to, so the result survives reboots and shows up in
 * scenes.yaml like any hand-written one.
 */
export async function saveScene(
  id: string,
  name: string,
  entities: Record<string, Record<string, unknown>>,
): Promise<void> {
  await haFetch(`/api/config/scene/config/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ id, name, entities }),
  });
}

export async function deleteScene(id: string): Promise<void> {
  await haFetch(`/api/config/scene/config/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export type SceneConfig = {
  id?: string;
  name?: string;
  entities: Record<string, Record<string, unknown>>;
};

/**
 * A scene's STORED definition — what it will do, not what the room is doing.
 *
 * This is the read the editor is built on. Editing a scene by looking at the
 * live lamps can only ever change it to what is already happening, which makes
 * "turn this scene's strip up" impossible without first turning the strip up.
 */
export async function getSceneConfig(id: string): Promise<SceneConfig> {
  const raw = await haFetch<SceneConfig>(
    `/api/config/scene/config/${encodeURIComponent(id)}`,
  );
  return { ...raw, entities: raw.entities ?? {} };
}

/**
 * One lamp's line in a scene, in the shape the editor renders.
 *
 * `brightness` comes back 0–255 from Home Assistant and goes out 1–100, the
 * same conversion toLamps does, so the editor's sliders and the Devices tab's
 * sliders are showing the same units.
 */
export type SceneLamp = {
  entityId: string;
  name: string;
  on: boolean;
  brightness: number;
  kelvin: number | null;
  hs: [number, number] | null;
};

export function sceneLamps(config: SceneConfig, lamps: Lamp[]): SceneLamp[] {
  const named = new Map(lamps.map((l) => [l.entityId, l.name]));

  return Object.entries(config.entities)
    .filter(([entityId]) => entityId.startsWith("light."))
    .map(([entityId, entry]) => {
      const raw = entry["brightness"];
      const kelvin = entry["color_temp_kelvin"];
      const hs = entry["hs_color"];
      return {
        entityId,
        // A scene can name a lamp that has since been unpaired; the entity id
        // is a worse label than a name but far better than dropping the row and
        // silently rewriting the scene without it on the next save.
        name: named.get(entityId) ?? entityId.replace(/^light\./, ""),
        on: entry["state"] !== "off",
        brightness: typeof raw === "number" ? Math.round((raw / 255) * 100) : 100,
        kelvin: typeof kelvin === "number" ? kelvin : null,
        hs:
          Array.isArray(hs) && hs.length === 2 ? ([hs[0], hs[1]] as [number, number]) : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The inverse — the editor's rows back into what scenes.yaml stores. */
export function sceneEntities(lamps: SceneLamp[]): Record<string, Record<string, unknown>> {
  const entities: Record<string, Record<string, unknown>> = {};
  for (const lamp of lamps) {
    if (!lamp.on) {
      entities[lamp.entityId] = { state: "off" };
      continue;
    }
    const entry: Record<string, unknown> = {
      state: "on",
      brightness: Math.round((Math.max(1, Math.min(100, lamp.brightness)) / 100) * 255),
    };
    // Exactly one colour key, as everywhere else: a scene carrying both lets
    // Home Assistant pick which wins and the room comes back subtly wrong.
    if (lamp.hs) entry.hs_color = lamp.hs;
    else if (lamp.kelvin) entry.color_temp_kelvin = lamp.kelvin;
    entities[lamp.entityId] = entry;
  }
  return entities;
}

/**
 * Snapshot what the lamps are doing right now, in the shape a scene wants.
 *
 * Only one colour key is written per lamp. A scene carrying both a colour
 * temperature and a hue would let HA pick which wins, and the room would come
 * back subtly different from the one that was saved.
 */
export function snapshotForScene(lamps: Lamp[]): Record<string, Record<string, unknown>> {
  const entities: Record<string, Record<string, unknown>> = {};
  for (const lamp of lamps) {
    if (!lamp.reachable) continue; // Can't capture what we can't read.
    if (!lamp.on) {
      entities[lamp.entityId] = { state: "off" };
      continue;
    }
    const entry: Record<string, unknown> = {
      state: "on",
      brightness: Math.round(((lamp.brightness ?? 100) / 100) * 255),
    };
    if (lamp.colorMode === "color_temp" && lamp.kelvin) {
      entry.color_temp_kelvin = lamp.kelvin;
    } else if (lamp.hs) {
      entry.hs_color = lamp.hs;
    }
    entities[lamp.entityId] = entry;
  }
  return entities;
}

// ---------------------------------------------------------------- automations

export type Automation = {
  entityId: string;
  name: string;
  id: string | null;
  enabled: boolean;
};

export function toAutomations(states: HaState[]): Automation[] {
  return states
    .filter((s) => s.entity_id.startsWith("automation."))
    .map((s) => ({
      entityId: s.entity_id,
      name: friendlyName(s, s.entity_id.replace(/^automation\./, "")),
      id: typeof s.attributes["id"] === "string" ? s.attributes["id"] : null,
      // "off" means the automation exists but will not fire. It is not deleted,
      // and that distinction has to survive to the UI or a disabled schedule
      // looks identical to a missing one.
      enabled: s.state === "on",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveAutomation(
  id: string,
  config: Record<string, unknown>,
): Promise<void> {
  await haFetch(`/api/config/automation/config/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export async function deleteAutomation(id: string): Promise<void> {
  await haFetch(`/api/config/automation/config/${encodeURIComponent(id)}`, {
    method: "DELETE",
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
  /** [hue 0–360, saturation 0–100] when the bulb is in a colour mode. */
  hs: [number, number] | null;
  /** True when the bulb can do colour at all, not just white balance. */
  supportsColor: boolean;
  /** "color_temp" | "xy" | "hs" | … — what the bulb is doing right now. */
  colorMode: string | null;
  /** Effects the bulb itself advertises — blink, breathe, colorloop, … */
  effects: string[];
  /** The effect it is running, null when idle. HA spells idle as "None". */
  effect: string | null;
};

export type Scene = {
  entityId: string;
  name: string;
  /**
   * HA's own scene id — the key the config API uses, distinct from the entity
   * id. Only present on scenes created through the editor; hand-written YAML
   * scenes without an `id:` can't be edited or deleted over the API.
   */
  id: string | null;
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
      const hsRaw = s.attributes["hs_color"];
      const modes = s.attributes["supported_color_modes"];
      const colorMode = s.attributes["color_mode"];
      const effectList = s.attributes["effect_list"];
      const effect = s.attributes["effect"];

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
        hs: Array.isArray(hsRaw) && hsRaw.length === 2
          ? (hsRaw as [number, number])
          : null,
        // xy and hs both mean "this bulb does colour" — the ZL1 reports xy.
        supportsColor: Array.isArray(modes)
          ? modes.some((m) => m === "xy" || m === "hs" || m === "rgb" || m === "rgbw" || m === "rgbww")
          : false,
        colorMode: typeof colorMode === "string" ? colorMode : null,
        effects: Array.isArray(effectList)
          ? effectList.filter((e): e is string => typeof e === "string")
          : [],
        // "None" is HA's word for "no effect running". Passing it through as a
        // running effect would light up an Off chip as if it were an effect.
        effect: typeof effect === "string" && effect !== "None" ? effect : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------------ commands

export type LightPatch = {
  entityId: string;
  on?: boolean;
  /** 0–100. */
  brightness?: number;
  kelvin?: number;
  /** [hue 0–360, saturation 0–100]. */
  hs?: [number, number];
  effect?: string;
};

export type LampRange = { minKelvin: number; maxKelvin: number };

const RANGE_TTL_MS = 5 * 60_000;
let rangeCache: { at: number; ranges: Map<string, LampRange> } | null = null;

/**
 * Each bulb's own tunable envelope, cached for a few minutes.
 *
 * This is CAPABILITY, not state, and the difference is the whole reason caching
 * it is allowed: min/max kelvin are burned into the bulb and do not change
 * while it is on the mesh, whereas what the lamp is DOING must never be served
 * from a cache. Worth caching because the alternative is a full /api/states
 * read on the hot path of every slider release, purely to clamp one number.
 *
 * Never throws: if the read fails we fall back to the last known ranges, or to
 * none at all, and the physical envelope below is what keeps the command sane.
 */
export async function lampRanges(): Promise<Map<string, LampRange>> {
  if (rangeCache && Date.now() - rangeCache.at < RANGE_TTL_MS) return rangeCache.ranges;
  try {
    const ranges = new Map(
      toLamps(await getStates()).map((l) => [
        l.entityId,
        { minKelvin: l.minKelvin, maxKelvin: l.maxKelvin },
      ]),
    );
    rangeCache = { at: Date.now(), ranges };
    return ranges;
  } catch {
    return rangeCache?.ranges ?? new Map();
  }
}

/**
 * The widest envelope any lighting bulb has. Only used when the bulb's own
 * range is unknown — clamping to a hardcoded 2700–6500 would be a lie about a
 * bulb that reports 2000–6493, and a value outside a bulb's real range is
 * rejected silently: the lamp simply doesn't move, which reads as a dead tap.
 */
const PHYSICAL_MIN_K = 1500;
const PHYSICAL_MAX_K = 10_000;

/** The service call one patch turns into, clamped to what that bulb can do. */
export function lightCommand(
  patch: LightPatch,
  range: LampRange | undefined,
): { service: "turn_on" | "turn_off"; data: Record<string, unknown> } {
  if (patch.on === false) return { service: "turn_off", data: {} };

  const data: Record<string, unknown> = {};
  if (patch.brightness !== undefined) {
    // Clamp before converting: HA silently rejects out-of-range values and the
    // lamp just doesn't change, which looks like the tap didn't register.
    data.brightness_pct = Math.max(1, Math.min(100, Math.round(patch.brightness)));
  }
  // Colour temperature and hue are mutually exclusive modes on the bulb.
  // Sending both lets HA pick, and which one wins is not something the user can
  // predict — so hue wins explicitly when it was asked for.
  if (patch.hs !== undefined) {
    data.hs_color = [
      ((Math.round(patch.hs[0]) % 360) + 360) % 360,
      Math.max(0, Math.min(100, Math.round(patch.hs[1]))),
    ];
  } else if (patch.kelvin !== undefined) {
    const min = range?.minKelvin ?? PHYSICAL_MIN_K;
    const max = range?.maxKelvin ?? PHYSICAL_MAX_K;
    data.color_temp_kelvin = Math.max(min, Math.min(max, Math.round(patch.kelvin)));
  }
  if (patch.effect !== undefined) data.effect = patch.effect;
  return { service: "turn_on", data };
}

/**
 * Lamps that DROP the brightness component when brightness and colour arrive in
 * the same command.
 *
 * Both Tuya RGB+CCT strips do exactly this, and it is not a timing artefact:
 * send it brightness on its own and it dims instantly; send brightness together
 * with a colour temperature — which is how every scene and every one-tap look
 * applies — and it takes the colour while silently keeping its old brightness.
 * The only fix is a second command carrying brightness alone, afterwards.
 *
 * Keyed by entity id rather than sniffed from the model, because the entity id
 * is what every call site already has.
 */
export const SPLIT_BRIGHTNESS = new Set([
  "light.0xa4c138939b2d0b23", // keyboard strip — behind the desk
  "light.0xa4c13898403028f1", // bedroom tv strip
]);

function needsSplitBrightness(patch: LightPatch): boolean {
  return (
    SPLIT_BRIGHTNESS.has(patch.entityId) &&
    patch.brightness !== undefined &&
    (patch.kelvin !== undefined || patch.hs !== undefined)
  );
}

/** Group patches into as few service calls as possible, and fire them. */
async function sendGrouped(
  patches: LightPatch[],
  ranges: Map<string, LampRange>,
): Promise<void> {
  if (!patches.length) return;

  const groups = new Map<string, { service: string; data: Record<string, unknown>; ids: string[] }>();

  for (const patch of patches) {
    const { service, data } = lightCommand(patch, ranges.get(patch.entityId));
    const key = `${service}:${JSON.stringify(data)}`;
    const existing = groups.get(key);
    if (existing) existing.ids.push(patch.entityId);
    else groups.set(key, { service, data, ids: [patch.entityId] });
  }

  const calls = [...groups.values()].map((g) =>
    callService("light", g.service, {
      ...g.data,
      entity_id: g.ids.length === 1 ? g.ids[0] : g.ids,
    }),
  );

  // One failing group must not hide the others, but the caller still has to
  // hear that something failed.
  const results = await Promise.allSettled(calls);
  const failed = results.find((r) => r.status === "rejected");
  if (failed && failed.status === "rejected") throw failed.reason;
}

/**
 * Apply a batch of per-lamp patches in as few service calls as possible.
 *
 * Grouping matters over a tailnet: four sequential round trips are visibly
 * staggered and the lamps change one at a time, like a wave. Patches that
 * resolve to the same payload — which is every "match all to this" and most
 * undos — collapse into a single call carrying a list of entity ids.
 *
 * The one exception is the split above: those lamps get their colour with
 * everyone else and their brightness in a second round, because sending both
 * together means the brightness is thrown away.
 */
export async function applyLightPatches(
  patches: LightPatch[],
  ranges: Map<string, LampRange>,
): Promise<void> {
  const primary: LightPatch[] = [];
  const followUp: LightPatch[] = [];

  for (const patch of patches) {
    if (needsSplitBrightness(patch)) {
      const { brightness, ...colourOnly } = patch;
      primary.push(colourOnly);
      followUp.push({ entityId: patch.entityId, brightness });
    } else {
      primary.push(patch);
    }
  }

  await sendGrouped(primary, ranges);
  await sendGrouped(followUp, ranges);
}

/**
 * What one lamp is doing, as the patch that would reproduce it.
 *
 * The single-colour-key rule from snapshotForScene applies here too, and for
 * the same reason: a payload carrying both a colour temperature and a hue lets
 * Home Assistant decide which wins, and the room comes back subtly wrong.
 */
export function patchFromLamp(lamp: Lamp, entityId: string): LightPatch {
  if (!lamp.on) return { entityId, on: false };
  const patch: LightPatch = { entityId, on: true, brightness: lamp.brightness ?? 100 };
  if (lamp.colorMode === "color_temp" && lamp.kelvin) patch.kelvin = lamp.kelvin;
  else if (lamp.hs) patch.hs = lamp.hs;
  else if (lamp.kelvin) patch.kelvin = lamp.kelvin;
  return patch;
}

export function toScenes(states: HaState[]): Scene[] {
  return states
    .filter((s) => s.entity_id.startsWith("scene."))
    .map((s) => ({
      entityId: s.entity_id,
      name: friendlyName(s, s.entity_id.replace(/^scene\./, "")),
      id: typeof s.attributes["id"] === "string" ? s.attributes["id"] : null,
      // HA stores a scene's `state` as the timestamp it was last applied, or
      // "unknown" if it hasn't been since the last restart.
      lastActivated: s.state === "unknown" ? null : s.state,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
