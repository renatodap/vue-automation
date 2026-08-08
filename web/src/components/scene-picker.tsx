"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Lightbulb,
  LightbulbOff,
  Plus,
  Power,
  RefreshCw,
  Sun,
  Trash2,
  WifiOff,
} from "lucide-react";
import { apiUrl, postJson } from "@/lib/client";
import type { LampView, SceneView, StateResponse } from "@/lib/types";

/** How often to re-read state while the app is actually on screen. */
const POLL_MS = 6_000;

export function ScenePicker() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openLamp, setOpenLamp] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sceneName, setSceneName] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/state"), { cache: "no-store" });
      if (response.status === 401) {
        window.location.href = apiUrl("/login");
        return;
      }
      setState((await response.json()) as StateResponse);
    } catch {
      setState({
        ok: false,
        reason: "unreachable",
        message: "No connection. Check that you're online.",
      });
    }
  }, []);

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

  const flash = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);

  const lamps = state?.ok ? state.lamps : [];
  const reachable = useMemo(() => lamps.filter((l) => l.reachable), [lamps]);
  const lit = useMemo(() => reachable.filter((l) => l.on), [reachable]);
  const anyOn = lit.length > 0;

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

  const activate = (scene: SceneView) =>
    act(
      scene.entityId,
      async () => {
        const r = await postJson<{ unreachable: string[] }>("/api/scene", {
          entityId: scene.entityId,
        });
        // Report partial application — HA applies a scene to what it can reach
        // and stays silent about the rest, and silence reads as success.
        flash(
          r.unreachable.length
            ? `${scene.label} — couldn't reach ${r.unreachable.join(", ")}`
            : scene.label,
        );
      },
    );

  const saveCurrent = () =>
    act(
      "save",
      async () => {
        const r = await postJson<{ captured: number }>("/api/scenes", {
          name: sceneName.trim(),
        });
        setSaving(false);
        setSceneName("");
        flash(`Saved "${sceneName.trim()}" — ${r.captured} lamps captured`);
      },
    );

  const removeScene = (scene: SceneView) => {
    if (!scene.id) return Promise.resolve();
    return act(scene.entityId, async () => {
      const response = await fetch(
        apiUrl(`/api/scenes?id=${encodeURIComponent(scene.id!)}`),
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("Couldn't delete that scene");
      flash(`Deleted ${scene.label}`);
    });
  };

  const setAll = (patch: {
    on?: boolean;
    brightness?: number;
    kelvin?: number;
    hs?: [number, number];
  }) => {
    const targets = (patch.on === false ? lit : reachable).map((l) => l.entityId);
    if (!targets.length) return Promise.resolve();
    return act("master", () => postJson("/api/light", { entityIds: targets, ...patch }));
  };

  const setLamp = (
    lamp: LampView,
    patch: { on?: boolean; brightness?: number; kelvin?: number; hs?: [number, number] },
  ) => act(lamp.entityId, () => postJson("/api/light", { entityId: lamp.entityId, ...patch }));

  return (
    <div className="app">
      <header className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[25px] font-semibold tracking-tight m-0">Living Room</h1>
          <p className="text-[13px] text-[var(--text-muted)] m-0 mt-0.5 truncate">
            {state === null
              ? "Connecting…"
              : state.ok
                ? summarize(state.lamps)
                : "Disconnected"}
          </p>
        </div>
        <button
          onClick={() => void load()}
          aria-label="Refresh"
          className="text-[var(--text-muted)] active:scale-90 transition-transform shrink-0"
          style={{ minWidth: 44 }}
        >
          <RefreshCw size={17} />
        </button>
      </header>

      <main>
        {state && !state.ok && <Disconnected message={state.message} onRetry={load} />}

        {state?.ok && (
          <div className="panels">
            <div className="flex flex-col gap-4 min-w-0">
              {state.unreachableCount > 0 && (
                <Banner>
                  {state.unreachableCount === 1
                    ? "1 lamp unreachable — check its switch."
                    : `${state.unreachableCount} lamps unreachable — check their switches.`}
                </Banner>
              )}

              <Section title="Scenes">
                <div className="grid grid-cols-2 gap-2">
                  {state.scenes.map((s) => (
                    <div key={s.entityId} className="relative">
                      <button
                        onClick={() => void activate(s)}
                        disabled={pending === s.entityId}
                        className="w-full flex items-center gap-2 px-3 rounded-[var(--r-md)] text-left transition-all active:scale-[0.97]"
                        style={{
                          minHeight: 52,
                          paddingRight: editing ? 34 : 12,
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          boxShadow:
                            pending === s.entityId ? "var(--glow-accent)" : "none",
                        }}
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ background: s.accent ?? "var(--accent)" }}
                        />
                        <span className="text-[14px] font-medium leading-tight break-words">
                          {s.label}
                        </span>
                      </button>
                      {/* Delete only appears in edit mode. A destructive control
                          permanently next to the one you tap in the dark is how
                          scenes get lost. */}
                      {editing && s.id && (
                        <button
                          onClick={() => void removeScene(s)}
                          aria-label={`Delete ${s.label}`}
                          className="absolute top-1 right-1 rounded-[var(--r-sm)]"
                          style={{
                            minHeight: 28,
                            minWidth: 28,
                            color: "var(--negative)",
                            background: "var(--negative-bg)",
                          }}
                        >
                          <Trash2 size={13} className="mx-auto" />
                        </button>
                      )}
                    </div>
                  ))}

                  {saving ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveCurrent();
                      }}
                      className="col-span-2 flex gap-2"
                    >
                      <input
                        value={sceneName}
                        onChange={(e) => setSceneName(e.target.value)}
                        placeholder="Scene name"
                        aria-label="Scene name"
                        autoFocus
                        style={{ minHeight: 44 }}
                      />
                      <button
                        type="submit"
                        disabled={!sceneName.trim() || pending === "save"}
                        className="px-4 rounded-[var(--r-md)] text-[14px] font-medium shrink-0 disabled:opacity-40"
                        style={{
                          minHeight: 44,
                          background: "var(--accent)",
                          color: "var(--text-on-accent)",
                        }}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSaving(false);
                          setSceneName("");
                        }}
                        className="px-3 rounded-[var(--r-md)] text-[14px] shrink-0"
                        style={{ minHeight: 44, color: "var(--text-muted)" }}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <button
                      onClick={() => setSaving(true)}
                      className="flex items-center justify-center gap-1.5 rounded-[var(--r-md)] text-[13px] font-medium"
                      style={{
                        minHeight: 52,
                        background: "transparent",
                        border: "1px dashed var(--border-strong)",
                        color: "var(--text-secondary)",
                      }}
                    >
                      <Plus size={15} /> Save current
                    </button>
                  )}

                  {state.scenes.some((s) => s.id) && !saving && (
                    <button
                      onClick={() => setEditing((v) => !v)}
                      className="text-[13px]"
                      style={{ minHeight: 52, color: "var(--text-muted)" }}
                    >
                      {editing ? "Done" : "Edit"}
                    </button>
                  )}
                </div>
              </Section>

              {/* Master. This is the section that removes the most work: warming
                  or dimming the whole room used to mean opening four lamps. */}
              <Section title="All lamps">
                <div
                  className="rounded-[var(--r-md)] p-3 flex flex-col gap-3.5"
                  style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
                >
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => void setAll({ on: true, brightness: avgBrightness })}
                      disabled={pending === "master" || !reachable.length}
                      className="flex items-center justify-center gap-1.5 rounded-[var(--r-sm)] text-[14px] font-medium disabled:opacity-35"
                      style={{
                        minHeight: 44,
                        background: anyOn ? "var(--accent-subtle)" : "var(--accent)",
                        color: anyOn ? "var(--accent)" : "var(--text-on-accent)",
                        border: "1px solid var(--accent-border)",
                      }}
                    >
                      <Sun size={15} /> All on
                    </button>
                    <button
                      onClick={() => void setAll({ on: false })}
                      disabled={pending === "master" || !anyOn}
                      className="flex items-center justify-center gap-1.5 rounded-[var(--r-sm)] text-[14px] font-medium disabled:opacity-35"
                      style={{
                        minHeight: 44,
                        background: "var(--neutral-bg)",
                        color: "var(--neutral-fg)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      <Power size={15} /> All off
                    </button>
                  </div>

                  <Controls
                    idPrefix="All lamps"
                    brightness={avgBrightness}
                    kelvin={avgKelvin}
                    minKelvin={minKelvin}
                    maxKelvin={maxKelvin}
                    hs={masterHs}
                    supportsColor={reachable.some((l) => l.supportsColor)}
                    inColorMode={lit.length > 0 && lit.every((l) => l.colorMode !== "color_temp")}
                    disabled={!reachable.length}
                    onBrightness={(v) => void setAll({ brightness: v })}
                    onKelvin={(v) => void setAll({ kelvin: v })}
                    onHs={(v) => void setAll({ hs: v })}
                  />
                </div>
              </Section>
            </div>

            <div className="min-w-0">
              <Section title={`Lamps (${lamps.length})`}>
                <div className="flex flex-col gap-2">
                  {lamps.length === 0 && <Empty />}
                  {lamps.map((lamp) => (
                    <LampRow
                      key={lamp.entityId}
                      lamp={lamp}
                      busy={pending === lamp.entityId}
                      open={openLamp === lamp.entityId}
                      onOpen={() =>
                        setOpenLamp((c) => (c === lamp.entityId ? null : lamp.entityId))
                      }
                      onToggle={() => void setLamp(lamp, { on: !lamp.on })}
                      onBrightness={(v) => void setLamp(lamp, { brightness: v })}
                      onKelvin={(v) => void setLamp(lamp, { kelvin: v })}
                      onHs={(v) => void setLamp(lamp, { hs: v })}
                    />
                  ))}
                </div>
              </Section>
            </div>
          </div>
        )}
      </main>

      <footer className="flex items-center">
        <span
          className="text-[13px] truncate transition-colors"
          style={{ color: notice ? "var(--accent)" : "var(--text-muted)" }}
        >
          {notice ?? (state?.ok ? "Tap a scene, or adjust everything above" : "")}
        </span>
      </footer>
    </div>
  );
}

const TEMP_GRADIENT =
  "linear-gradient(90deg,#ff9329 0%,#ffb765 18%,#ffd6aa 38%,#fff4e8 55%,#f2f4ff 74%,#cfdcff 100%)";

/** Full hue wheel laid flat. 0 and 360 are both red so the ends meet. */
const HUE_GRADIENT =
  "linear-gradient(90deg,#ff0000 0%,#ffff00 17%,#00ff00 33%,#00ffff 50%,#0000ff 67%,#ff00ff 83%,#ff0000 100%)";

/**
 * Named white points, one tap each.
 *
 * Dragging a slider across ~4500 kelvin on a phone means a millimetre of thumb
 * is a couple of hundred degrees, which is why the control felt twitchy. Almost
 * every real adjustment is "warmer" or "cooler", not a specific number — so the
 * presets are the primary control and the slider is the fine tune.
 */
const WHITE_PRESETS: { name: string; k: number }[] = [
  { name: "Candle", k: 2200 },
  { name: "Warm", k: 2700 },
  { name: "Soft", k: 3000 },
  { name: "Neutral", k: 4000 },
  { name: "Cool", k: 5000 },
  { name: "Daylight", k: 6200 },
];

/** Same idea for brightness — the common values without a drag. */
const LEVELS = [10, 25, 50, 75, 100];

/** One tap for the colours people actually reach for. */
const SWATCHES: { name: string; hs: [number, number] }[] = [
  { name: "Red", hs: [0, 100] },
  { name: "Orange", hs: [28, 100] },
  { name: "Yellow", hs: [52, 95] },
  { name: "Green", hs: [120, 90] },
  { name: "Teal", hs: [175, 85] },
  { name: "Blue", hs: [225, 95] },
  { name: "Violet", hs: [275, 85] },
  { name: "Pink", hs: [320, 75] },
];

function hsToCss([h, s]: [number, number], light = 50): string {
  return `hsl(${h} ${s}% ${light}%)`;
}

/**
 * The full control surface for one lamp or for every lamp at once.
 *
 * White and colour are separate modes because the bulb treats them that way —
 * it is either holding a colour temperature or holding a hue, never both. A UI
 * that showed all three sliders at once would imply they compose, and the user
 * would keep discovering that moving one silently discards another.
 */
function Controls({
  brightness,
  kelvin,
  minKelvin,
  maxKelvin,
  hs,
  supportsColor,
  inColorMode,
  disabled,
  onBrightness,
  onKelvin,
  onHs,
  idPrefix,
}: {
  brightness: number;
  kelvin: number;
  minKelvin: number;
  maxKelvin: number;
  hs: [number, number] | null;
  supportsColor: boolean;
  inColorMode: boolean;
  disabled?: boolean;
  onBrightness: (v: number) => void;
  onKelvin: (v: number) => void;
  onHs: (v: [number, number]) => void;
  idPrefix: string;
}) {
  const [mode, setMode] = useState<"white" | "color">(inColorMode ? "color" : "white");
  const hue = hs?.[0] ?? 30;
  const sat = hs?.[1] ?? 80;

  // Follow the lamp when a scene or another device switches its mode, so the
  // tab always describes what the light is actually doing.
  useEffect(() => setMode(inColorMode ? "color" : "white"), [inColorMode]);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Slider
          label="Intensity"
          value={brightness}
          min={1}
          max={100}
          step={5}
          suffix="%"
          disabled={disabled}
          onCommit={onBrightness}
          ariaLabel={`${idPrefix} brightness`}
        />
        <div className="flex gap-1.5 mt-1.5">
          {LEVELS.map((v) => (
            <Chip
              key={v}
              active={Math.abs(brightness - v) < 3}
              disabled={disabled}
              onClick={() => onBrightness(v)}
            >
              {v}%
            </Chip>
          ))}
        </div>
      </div>

      {supportsColor && (
        <div
          className="grid grid-cols-2 gap-1 p-0.5 rounded-[var(--r-sm)]"
          style={{ background: "var(--surface-sunken)" }}
          role="tablist"
        >
          {(["white", "color"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              disabled={disabled}
              className="rounded-[var(--r-xs,4px)] text-[13px] font-medium transition-colors"
              style={{
                minHeight: 34,
                background: mode === m ? "var(--surface)" : "transparent",
                color: mode === m ? "var(--text-primary)" : "var(--text-muted)",
                boxShadow: mode === m ? "var(--shadow-sm)" : "none",
              }}
            >
              {m === "white" ? "White" : "Colour"}
            </button>
          ))}
        </div>
      )}

      {mode === "white" || !supportsColor ? (
        <div>
          <Slider
            label="Temperature"
            value={kelvin}
            min={minKelvin}
            max={maxKelvin}
            step={100}
            suffix="K"
            disabled={disabled}
            trackImage={TEMP_GRADIENT}
            onCommit={onKelvin}
            ariaLabel={`${idPrefix} colour temperature`}
          />
          <div className="flex gap-1.5 mt-1.5 flex-wrap">
            {WHITE_PRESETS.filter((p) => p.k >= minKelvin && p.k <= maxKelvin).map((p) => (
              <Chip
                key={p.name}
                active={Math.abs(kelvin - p.k) < 120}
                disabled={disabled}
                onClick={() => onKelvin(p.k)}
              >
                {p.name}
              </Chip>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="flex gap-1.5 flex-wrap">
            {SWATCHES.map((s) => (
              <button
                key={s.name}
                onClick={() => onHs(s.hs)}
                disabled={disabled}
                aria-label={s.name}
                title={s.name}
                className="rounded-[var(--r-pill)] active:scale-90 transition-transform"
                style={{
                  width: 32,
                  height: 32,
                  minHeight: 32,
                  background: hsToCss(s.hs),
                  border:
                    hs && Math.abs(hs[0] - s.hs[0]) < 8
                      ? "2px solid var(--text-primary)"
                      : "1px solid var(--border-strong)",
                }}
              />
            ))}
          </div>
          <Slider
            label="Hue"
            value={hue}
            min={0}
            max={360}
            step={5}
            suffix="°"
            disabled={disabled}
            trackImage={HUE_GRADIENT}
            onCommit={(v) => onHs([v, sat])}
            ariaLabel={`${idPrefix} hue`}
          />
          <Slider
            label="Saturation"
            value={sat}
            min={0}
            max={100}
            step={5}
            suffix="%"
            disabled={disabled}
            trackImage={`linear-gradient(90deg,#ffffff 0%,${hsToCss([hue, 100])} 100%)`}
            onCommit={(v) => onHs([hue, v])}
            ariaLabel={`${idPrefix} saturation`}
          />
        </>
      )}
    </div>
  );
}

function summarize(lamps: LampView[]): string {
  if (!lamps.length) return "No lamps paired yet";
  const on = lamps.filter((l) => l.on).length;
  const out = lamps.filter((l) => !l.reachable).length;
  const parts = [on === 0 ? "All off" : `${on} of ${lamps.length} on`];
  if (out) parts.push(`${out} unreachable`);
  return parts.join(" · ");
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-[12px] uppercase tracking-wide text-[var(--text-muted)] m-0 mb-2 font-medium">
        {title}
      </h2>
      {children}
    </section>
  );
}

function LampRow({
  lamp,
  busy,
  open,
  onOpen,
  onToggle,
  onBrightness,
  onKelvin,
  onHs,
}: {
  lamp: LampView;
  busy: boolean;
  open: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onBrightness: (value: number) => void;
  onKelvin: (value: number) => void;
  onHs: (value: [number, number]) => void;
}) {
  const canAdjust = lamp.reachable && lamp.on;

  return (
    <div
      className="rounded-[var(--r-md)]"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        opacity: lamp.reachable ? 1 : 0.5,
      }}
    >
      <div className="flex items-center gap-2 p-2.5">
        <button
          onClick={onToggle}
          disabled={!lamp.reachable || busy}
          aria-label={lamp.on ? `Turn off ${lamp.name}` : `Turn on ${lamp.name}`}
          className="shrink-0 active:scale-90 transition-transform"
          style={{ minWidth: 44, color: lamp.on ? "var(--accent)" : "var(--text-muted)" }}
        >
          {lamp.reachable ? (
            lamp.on ? <Lightbulb size={19} /> : <LightbulbOff size={19} />
          ) : (
            <WifiOff size={19} />
          )}
        </button>

        <button
          onClick={onOpen}
          disabled={!canAdjust}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left disabled:cursor-default"
          style={{ minHeight: 40 }}
        >
          {/* Never truncate a device name — wrap instead. */}
          <div className="text-[14px] leading-tight break-words">{lamp.name}</div>
          <div className="text-[12px] text-[var(--text-muted)]">
            {!lamp.reachable
              ? "Unreachable — switch may be off"
              : lamp.on
                ? `${lamp.brightness ?? 100}% · ${lamp.kelvin ? `${lamp.kelvin}K` : "colour"}`
                : "Off"}
          </div>
        </button>

        {canAdjust && (
          <ChevronDown
            size={15}
            className="shrink-0 text-[var(--text-muted)] transition-transform"
            style={{ transform: open ? "rotate(180deg)" : "none" }}
          />
        )}
      </div>

      {open && canAdjust && (
        <div className="px-3 pb-3">
          <Controls
            idPrefix={lamp.name}
            brightness={lamp.brightness ?? 100}
            kelvin={lamp.kelvin ?? 2700}
            minKelvin={lamp.minKelvin}
            maxKelvin={lamp.maxKelvin}
            hs={lamp.hs}
            supportsColor={lamp.supportsColor}
            inColorMode={lamp.colorMode !== null && lamp.colorMode !== "color_temp"}
            onBrightness={onBrightness}
            onKelvin={onKelvin}
            onHs={onHs}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Commits on release, not on every input event.
 *
 * A slider fires continuously while dragging; forwarding each frame to Zigbee
 * floods a mesh that manages a few messages a second, and the lamp ends up
 * chasing a queue of stale values seconds after your thumb stopped.
 */
function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  trackImage,
  disabled,
  onCommit,
  ariaLabel,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  trackImage?: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
  ariaLabel: string;
}) {
  const [local, setLocal] = useState(value);
  const [dragging, setDragging] = useState(false);

  // Follow the lamp when it moves underneath us (a scene fired, another device
  // changed it) — but never while a thumb is down, which would fight the user.
  useEffect(() => {
    if (!dragging) setLocal(value);
  }, [value, dragging]);

  return (
    <label className="block" style={{ opacity: disabled ? 0.4 : 1 }}>
      <span className="flex items-baseline justify-between mb-1">
        <span className="text-[12px] text-[var(--text-secondary)]">{label}</span>
        <span className="text-[12px] tabular-nums text-[var(--text-muted)]">
          {Math.round(local)}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => {
          setDragging(true);
          setLocal(Number(e.currentTarget.value));
        }}
        onPointerUp={(e) => {
          setDragging(false);
          onCommit(Number(e.currentTarget.value));
        }}
        onKeyUp={(e) => {
          setDragging(false);
          onCommit(Number(e.currentTarget.value));
        }}
        className={trackImage ? "temp-range" : "plain-range"}
        style={{
          width: "100%",
          minHeight: 40,
          padding: 0,
          accentColor: "var(--accent)",
          ...(trackImage ? { ["--track-image" as string]: trackImage } : {}),
        }}
      />
    </label>
  );
}

function Chip({
  children,
  active,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex-1 rounded-[var(--r-pill)] text-[12px] font-medium transition-colors active:scale-95"
      style={{
        minHeight: 30,
        padding: "0 8px",
        background: active ? "var(--accent-subtle)" : "var(--surface-sunken)",
        color: active ? "var(--accent)" : "var(--text-muted)",
        border: `1px solid ${active ? "var(--accent-border)" : "transparent"}`,
      }}
    >
      {children}
    </button>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-[13px] px-3 py-2 rounded-[var(--r-sm)]"
      style={{
        background: "var(--warning-bg)",
        color: "var(--warning)",
        border: "1px solid var(--accent-border)",
      }}
    >
      {children}
    </div>
  );
}

function Disconnected({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="flex flex-col items-center text-center gap-3 py-14 px-6 rounded-[var(--r-lg)]"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
    >
      <WifiOff size={26} className="text-[var(--text-muted)]" />
      <p className="text-[14px] text-[var(--text-secondary)] m-0 max-w-[36ch]">{message}</p>
      <button
        onClick={onRetry}
        className="px-4 rounded-[var(--r-pill)] text-[14px] font-medium"
        style={{
          minHeight: 40,
          background: "var(--accent)",
          color: "var(--text-on-accent)",
        }}
      >
        Try again
      </button>
    </div>
  );
}

function Empty() {
  return (
    <div
      className="py-8 px-5 text-center rounded-[var(--r-md)]"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
    >
      <p className="text-[13px] text-[var(--text-secondary)] m-0">
        No lamps paired yet.
      </p>
      <p className="text-[12px] text-[var(--text-muted)] m-0 mt-1">
        Pair them in Zigbee2MQTT and they appear here.
      </p>
    </div>
  );
}
