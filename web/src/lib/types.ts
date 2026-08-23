export type SceneView = {
  entityId: string;
  name: string;
  id: string | null;
  label: string;
  accent: string | null;
  sortOrder: number | null;
  tapCount: number;
  lastActivated: string | null;
  lastTappedAt: string | null;
  /** Also shown at the top of Home. False when the metadata db didn't answer. */
  spotlight: boolean;
};

/**
 * One lamp's line in a scene's STORED definition — what the scene will do,
 * not what the lamp is doing now.
 *
 * The distinction is the whole reason the editor reads this rather than the
 * room: editing a scene by looking at the live lamps means you can only ever
 * change it to what is already happening.
 */
export type SceneLampSetting = {
  entityId: string;
  /** The lamp's friendly name, resolved server-side for display. */
  name: string;
  on: boolean;
  /** 1–100. Meaningless when `on` is false, kept so toggling back is lossless. */
  brightness: number;
  kelvin: number | null;
  hs: [number, number] | null;
};

export type SceneConfigResponse =
  | { ok: true; id: string; name: string; lamps: SceneLampSetting[] }
  | {
      ok: false;
      reason: "unreachable" | "ha_auth" | "config" | "not_editable" | "unknown";
      message: string;
    };

export type LampView = {
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
  /** Effects the bulb advertises — blink, breathe, colorloop, … */
  effects: string[];
  /** The effect it is running, null when idle. */
  effect: string | null;
  /**
   * The room, already resolved by the state route (override, then the static
   * map). Optional and typed as a plain string on purpose: it arrives as JSON,
   * so `isRoomId` narrows it, and a lamp that reaches the client without one
   * still groups via the compiled-in map.
   */
  room?: string;
};

/** One lamp's settings, in the shape that reproduces them. */
export type LampPatch = {
  entityId: string;
  on?: boolean;
  brightness?: number;
  kelvin?: number;
  hs?: [number, number];
  effect?: string;
};

/** Shape of POST /api/copy. */
export type CopyResponse = {
  ok: true;
  source: string;
  copied: string[];
  unreachable: string[];
};

export type AutomationView = {
  entityId: string;
  name: string;
  id: string | null;
  /**
   * false means the automation exists but will not fire — it is not deleted.
   * That distinction has to survive all the way to the UI, or a paused schedule
   * looks identical to a missing one.
   */
  enabled: boolean;
};

/** Shape of GET /api/automations. */
export type AutomationsResponse =
  | { ok: true; automations: AutomationView[] }
  | {
      ok: false;
      reason: "unreachable" | "ha_auth" | "config" | "unknown";
      message: string;
    };

export type StateResponse =
  | {
      ok: true;
      scenes: SceneView[];
      lamps: LampView[];
      automations: AutomationView[];
      unreachableCount: number;
    }
  | {
      ok: false;
      reason: "unreachable" | "ha_auth" | "config" | "unknown";
      message: string;
    };
