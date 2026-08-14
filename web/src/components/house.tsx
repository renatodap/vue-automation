"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiUrl, postJson } from "@/lib/client";
import type { CopyResponse, LampPatch, LampView, StateResponse } from "@/lib/types";

/** How often to re-read state while the app is actually on screen. */
const POLL_MS = 6_000;

/**
 * How long an optimistic value is allowed to stand before the server has to
 * agree with it. Long enough for a Zigbee round trip plus HA's own state write;
 * short enough that a lamp which ignored the command is called out while the
 * user still remembers asking.
 */
const RECONCILE_MS = 2_500;

/** How long a bulk action stays revertible. */
const UNDO_MS = 30_000;

type Overlay = { patch: LampPatch; at: number };

export type Undoable = { label: string; patches: LampPatch[]; at: number };

type House = {
  /** null until the first read lands — "Connecting…", not "everything is off". */
  state: StateResponse | null;
  /** Server truth with any in-flight intent painted on top. */
  lamps: LampView[];
  reachable: LampView[];
  lit: LampView[];
  pending: string | null;
  notice: string | null;
  undo: Undoable | null;
  avgBrightness: number;
  avgKelvin: number;
  minKelvin: number;
  maxKelvin: number;
  masterHs: [number, number] | null;
  load: () => Promise<void>;
  flash: (message: string) => void;
  act: (key: string, run: () => Promise<void>, message?: string) => Promise<void>;
  /** Remember the room, so whatever happens next can be taken back. */
  remember: (label: string) => void;
  revert: () => Promise<void>;
  dismissUndo: () => void;
  setLamp: (lamp: LampView, patch: Omit<LampPatch, "entityId">) => Promise<void>;
  setAll: (patch: Omit<LampPatch, "entityId">) => Promise<void>;
  sendPatches: (key: string, patches: LampPatch[]) => Promise<void>;
  solo: (lamp: LampView) => Promise<void>;
  copyTo: (
    from: LampView,
    to: LampView[] | "all",
    options?: { remember?: boolean },
  ) => Promise<void>;
  /** Multiply every lit lamp's brightness — keeps the scene's shape. */
  scaleBrightness: (factor: number) => Promise<void>;
  /** Shift every white lamp's colour temperature, clamped per bulb. */
  shiftWarmth: (deltaK: number) => Promise<void>;
};

const HouseContext = createContext<House | null>(null);

export function useHouse(): House {
  const house = useContext(HouseContext);
  if (!house) throw new Error("useHouse must be used inside <HouseProvider>");
  return house;
}

/**
 * One poller, one copy of the room, one undo stack — shared by all four tabs.
 *
 * Mounted in the tab layout rather than in each page so switching tabs is
 * instant and silent: a per-page fetch would flash "Connecting…" every time the
 * user moved between Room and Devices, and would quadruple the tailnet traffic
 * for a house whose state has not changed.
 *
 * Nothing here is persisted across a reload. Rendering a cached light state as
 * current is worse than showing nothing, because the user acts on it.
 */
export function HouseProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<StateResponse | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undoable | null>(null);
  const [overlay, setOverlay] = useState<Map<string, Overlay>>(new Map());
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read inside load(), which is memoized and must not close over a stale map.
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;

  const flash = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);
  const flashRef = useRef(flash);
  flashRef.current = flash;

  /**
   * Reconcile intent against truth.
   *
   * An optimistic value that the lamp never took is a lie the user acts on, so
   * every projected change is checked against the next read and then either
   * dropped silently (it landed) or dropped loudly (it did not). Values younger
   * than one Zigbee round trip are left alone — complaining about a lamp that
   * simply hasn't answered yet would cry wolf on every single tap.
   */
  const reconcile = useCallback((fresh: StateResponse) => {
    const current = overlayRef.current;
    if (current.size === 0) return;

    const now = Date.now();
    const next = new Map<string, Overlay>();
    const stubborn: string[] = [];

    for (const [entityId, entry] of current) {
      const lamp = fresh.ok ? fresh.lamps.find((l) => l.entityId === entityId) : undefined;
      if (!lamp) continue; // Gone from HA: nothing left to be optimistic about.
      if (matches(entry.patch, lamp)) continue; // Landed.
      if (now - entry.at > RECONCILE_MS) {
        stubborn.push(lamp.name);
        continue;
      }
      next.set(entityId, entry);
    }

    setOverlay(next);
    if (stubborn.length) {
      flashRef.current(
        stubborn.length === 1
          ? `${stubborn[0]} didn't take that`
          : `${stubborn.join(", ")} didn't take that`,
      );
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/state"), { cache: "no-store" });
      if (response.status === 401) {
        window.location.href = apiUrl("/login");
        return;
      }
      const fresh = (await response.json()) as StateResponse;
      setState(fresh);
      reconcile(fresh);
    } catch {
      setState({
        ok: false,
        reason: "unreachable",
        message: "No connection. Check that you're online.",
      });
    }
  }, [reconcile]);

  // Poll only while visible. A phone in a pocket polling a tailnet every six
  // seconds burns battery answering a question nobody is asking.
  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (!timer) timer = setInterval(() => void load(), POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void load();
        start();
      } else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  // An offer to undo something the user has long forgotten is worse than no
  // offer: it invites a tap that resurrects a room from half a minute ago.
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [undo]);

  const baseLamps = useMemo(() => (state?.ok ? state.lamps : []), [state]);
  const lamps = useMemo(
    () => baseLamps.map((lamp) => project(lamp, overlay.get(lamp.entityId)?.patch)),
    [baseLamps, overlay],
  );
  const reachable = useMemo(() => lamps.filter((l) => l.reachable), [lamps]);
  const lit = useMemo(() => reachable.filter((l) => l.on), [reachable]);

  // The master sliders show where the room actually is, averaged over what's
  // lit. Averaging over *all* lamps would drag the number toward zero every
  // time one is off, and the control would lie about the room.
  const avgBrightness = lit.length
    ? Math.round(lit.reduce((s, l) => s + (l.brightness ?? 100), 0) / lit.length)
    : 60;
  const avgKelvin = (() => {
    const withK = lit.filter((l) => l.kelvin);
    return withK.length
      ? Math.round(withK.reduce((s, l) => s + (l.kelvin ?? 0), 0) / withK.length)
      : 2700;
  })();
  // Intersect the ranges so the master slider can never ask a bulb for a value
  // it cannot reach — that fails silently and the lamp just doesn't move.
  const minKelvin = Math.max(2000, ...lamps.map((l) => l.minKelvin));
  const maxKelvin = Math.min(6500, ...lamps.map((l) => l.maxKelvin));
  const masterHs = lit.find((l) => l.hs)?.hs ?? null;

  const act = useCallback(
    async (key: string, run: () => Promise<void>, message?: string) => {
      setPending(key);
      try {
        await run();
        if (message) flash(message);
      } catch (error) {
        flash(error instanceof Error ? error.message : "That didn't go through");
      } finally {
        setPending(null);
        void load();
      }
    },
    [flash, load],
  );

  /** Paint intent on screen now; the next read is what makes it true. */
  const projectPatches = useCallback((patches: LampPatch[]) => {
    setOverlay((prev) => {
      const next = new Map(prev);
      const at = Date.now();
      for (const patch of patches) {
        const merged = { ...(next.get(patch.entityId)?.patch ?? {}), ...patch };
        // One colour key at a time, here as well as on the wire: an overlay
        // holding both would tint the dot from whichever the renderer happened
        // to read first.
        if (patch.hs) delete merged.kelvin;
        if (patch.kelvin !== undefined) delete merged.hs;
        next.set(patch.entityId, { patch: merged, at });
      }
      return next;
    });
  }, []);

  const sendPatches = useCallback(
    (key: string, patches: LampPatch[]) => {
      if (!patches.length) return Promise.resolve();
      projectPatches(patches);
      return act(key, () => postJson("/api/light", { patches }));
    },
    [act, projectPatches],
  );

  const setLamp = useCallback(
    (lamp: LampView, patch: Omit<LampPatch, "entityId">) =>
      sendPatches(lamp.entityId, [{ entityId: lamp.entityId, ...patch }]),
    [sendPatches],
  );

  const setAll = useCallback(
    (patch: Omit<LampPatch, "entityId">) => {
      const targets = patch.on === false ? lit : reachable;
      if (!targets.length) return Promise.resolve();
      return sendPatches(
        "master",
        targets.map((l) => ({ entityId: l.entityId, ...patch })),
      );
    },
    [lit, reachable, sendPatches],
  );

  const remember = useCallback(
    (label: string) => {
      // Snapshot server truth, not the optimistic overlay: undo has to restore
      // the room that actually was, not the one we were mid-way through asking
      // for.
      const patches = baseLamps.filter((l) => l.reachable).map(patchFromLamp);
      if (patches.length) setUndo({ label, patches, at: Date.now() });
    },
    [baseLamps],
  );

  const revert = useCallback(async () => {
    if (!undo) return;
    const { patches, label } = undo;
    setUndo(null);
    await sendPatches("undo", patches);
    flash(`Put back: ${label}`);
  }, [flash, sendPatches, undo]);

  const solo = useCallback(
    (lamp: LampView) => {
      remember(`solo ${lamp.name}`);
      const patches: LampPatch[] = reachable.map((l) =>
        l.entityId === lamp.entityId
          ? { ...patchFromLamp(l), on: true }
          : { entityId: l.entityId, on: false },
      );
      // A lamp that was off has no remembered brightness to solo at, so give it
      // the room's current level rather than whatever it happened to hold last.
      const self = patches.find((p) => p.entityId === lamp.entityId);
      if (self && self.brightness === undefined) self.brightness = avgBrightness;
      return sendPatches(lamp.entityId, patches);
    },
    [avgBrightness, reachable, remember, sendPatches],
  );

  const copyTo = useCallback(
    async (from: LampView, to: LampView[] | "all", options?: { remember?: boolean }) => {
      const targets = to === "all" ? reachable.filter((l) => l.entityId !== from.entityId) : to;
      if (!targets.length) return;
      // Opt-out exists for the eyedropper: painting four lamps one tap at a
      // time is ONE action, and re-snapshotting per tap would leave undo able
      // to take back only the last lamp.
      if (options?.remember !== false) remember(`copy from ${from.name}`);
      // Project the source's look onto the targets immediately — the whole
      // point of dragging one lamp onto another is watching it take. Only onto
      // the ones that can take it: painting a dead bulb on screen and then
      // announcing it didn't work is two lies for the price of one.
      projectPatches(
        targets
          .filter((l) => l.reachable)
          .map((l) => ({ ...patchFromLamp(from), entityId: l.entityId })),
      );
      await act(from.entityId, async () => {
        const result = await postJson<CopyResponse>("/api/copy", {
          from: from.entityId,
          to: to === "all" ? "all" : targets.map((l) => l.entityId),
        });
        // Report partial application: HA applies what it can reach and stays
        // silent about the rest, and silence reads as success.
        flash(
          result.unreachable.length
            ? `Copied to ${result.copied.length} — couldn't reach ${result.unreachable.join(", ")}`
            : result.copied.length === 1
              ? `${result.copied[0]} now matches ${result.source}`
              : `${result.copied.length} lamps now match ${result.source}`,
        );
      });
    },
    [act, flash, projectPatches, reachable, remember],
  );

  const scaleBrightness = useCallback(
    (factor: number) => {
      if (!lit.length) return Promise.resolve();
      remember("brightness");
      // Multiplicative, not "set everything to N". An absolute master flattens
      // a scene that was built lamp by lamp into one flat value; scaling keeps
      // the shape and only changes the level.
      return sendPatches(
        "master",
        lit.map((l) => ({
          entityId: l.entityId,
          brightness: Math.max(1, Math.min(100, Math.round((l.brightness ?? 100) * factor))),
        })),
      );
    },
    [lit, remember, sendPatches],
  );

  const shiftWarmth = useCallback(
    (deltaK: number) => {
      // Only lamps actually holding a white. Sending a colour temperature to a
      // bulb showing green would silently drag it back to white — a mode change
      // nobody asked for. The colour mode is the test, not the presence of a
      // kelvin value: a bulb in hs mode can still be reporting the temperature
      // it held last time it was white.
      const whites = lit.filter((l) => l.colorMode === "color_temp");
      if (!whites.length) {
        flash("No lamps are on white right now");
        return Promise.resolve();
      }
      remember("warmth");
      return sendPatches(
        "master",
        whites.map((l) => ({
          entityId: l.entityId,
          // Clamped to each bulb's OWN reported range: a value past the end is
          // rejected in silence and the lamp simply doesn't move.
          kelvin: Math.max(
            l.minKelvin,
            Math.min(l.maxKelvin, (l.kelvin ?? 2700) + deltaK),
          ),
        })),
      );
    },
    [flash, lit, remember, sendPatches],
  );

  const value: House = {
    state,
    lamps,
    reachable,
    lit,
    pending,
    notice,
    undo,
    avgBrightness,
    avgKelvin,
    minKelvin,
    maxKelvin,
    masterHs,
    load,
    flash,
    act,
    remember,
    revert,
    dismissUndo: () => setUndo(null),
    setLamp,
    setAll,
    sendPatches,
    solo,
    copyTo,
    scaleBrightness,
    shiftWarmth,
  };

  return <HouseContext.Provider value={value}>{children}</HouseContext.Provider>;
}

/**
 * One lamp's settings as the patch that would reproduce them.
 *
 * Mirrors patchFromLamp in lib/ha.ts, which is server-only. Same rule: exactly
 * one colour key, because a payload carrying both lets HA choose which wins.
 */
export function patchFromLamp(lamp: LampView): LampPatch {
  if (!lamp.on) return { entityId: lamp.entityId, on: false };
  const patch: LampPatch = {
    entityId: lamp.entityId,
    on: true,
    brightness: lamp.brightness ?? 100,
  };
  if (lamp.colorMode === "color_temp" && lamp.kelvin) patch.kelvin = lamp.kelvin;
  else if (lamp.hs) patch.hs = lamp.hs;
  else if (lamp.kelvin) patch.kelvin = lamp.kelvin;
  return patch;
}

/** Server truth with the user's intent painted on top. */
function project(lamp: LampView, patch: LampPatch | undefined): LampView {
  if (!patch) return lamp;
  const next: LampView = { ...lamp };
  if (patch.on !== undefined) next.on = patch.on;
  if (patch.brightness !== undefined) next.brightness = patch.brightness;
  if (patch.kelvin !== undefined) {
    next.kelvin = patch.kelvin;
    next.colorMode = "color_temp";
    next.hs = null;
    // rgb outranks hs and kelvin when the renderer tints the lamp, so a stale
    // one would keep the dot green while the bulb goes to white.
    next.rgb = null;
  }
  if (patch.hs !== undefined) {
    next.hs = patch.hs;
    next.colorMode = "hs";
    next.rgb = null;
  }
  if (patch.effect !== undefined) next.effect = patch.effect;
  return next;
}

/** Has the lamp actually arrived where it was asked to go? */
function matches(patch: LampPatch, lamp: LampView): boolean {
  if (patch.on !== undefined && patch.on !== lamp.on) return false;
  // Nothing else is meaningful on a lamp that was asked to switch off.
  if (patch.on === false) return true;
  if (
    patch.brightness !== undefined &&
    Math.abs((lamp.brightness ?? 0) - patch.brightness) > 4
  ) {
    // 0–255 round-trips through 0–100, so exact equality never holds.
    return false;
  }
  if (patch.kelvin !== undefined) {
    if (lamp.colorMode !== "color_temp") return false;
    // Kelvin round-trips through mireds; neighbouring values collapse.
    if (Math.abs((lamp.kelvin ?? 0) - patch.kelvin) > 80) return false;
  }
  if (patch.hs !== undefined) {
    if (!lamp.hs) return false;
    if (Math.abs(lamp.hs[0] - patch.hs[0]) > 6) return false;
    if (Math.abs(lamp.hs[1] - patch.hs[1]) > 8) return false;
  }
  if (patch.effect !== undefined && lamp.effect !== patch.effect) return false;
  return true;
}

/** One line describing the room, for the header. */
export function summarize(lamps: LampView[]): string {
  if (!lamps.length) return "No lamps paired yet";
  const on = lamps.filter((l) => l.on).length;
  const out = lamps.filter((l) => !l.reachable).length;
  const parts = [on === 0 ? "All off" : `${on} of ${lamps.length} on`];
  if (out) parts.push(`${out} unreachable`);
  return parts.join(" · ");
}
