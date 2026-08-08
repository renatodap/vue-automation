export type SceneView = {
  entityId: string;
  name: string;
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
};

export type StateResponse =
  | {
      ok: true;
      scenes: SceneView[];
      lamps: LampView[];
      unreachableCount: number;
    }
  | {
      ok: false;
      reason: "unreachable" | "ha_auth" | "config" | "unknown";
      message: string;
    };
