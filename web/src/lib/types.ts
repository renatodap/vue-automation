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
