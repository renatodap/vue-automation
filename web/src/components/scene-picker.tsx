"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Lightbulb,
  LightbulbOff,
  Power,
  RefreshCw,
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
  const [showLamps, setShowLamps] = useState(false);
  const [openLamp, setOpenLamp] = useState<string | null>(null);
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
  // seconds burns battery to answer a question nobody is asking.
  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => void load(), POLL_MS);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void load();
        start();
      } else {
        stop();
      }
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
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  const activate = useCallback(
    async (scene: SceneView) => {
      setPending(scene.entityId);
      try {
        const result = await postJson<{ unreachable: string[] }>("/api/scene", {
          entityId: scene.entityId,
        });
        // Report the partial application rather than letting silence read as
        // success — this is the whole reason the route re-reads state.
        if (result.unreachable.length > 0) {
          flash(
            `${scene.label} applied — couldn't reach ${result.unreachable.join(", ")}`,
          );
        } else {
          flash(`${scene.label}`);
        }
      } catch (error) {
        flash(error instanceof Error ? error.message : "Couldn't apply that scene");
      } finally {
        setPending(null);
        void load();
      }
    },
    [flash, load],
  );

  const allOff = useCallback(async () => {
    setPending("all-off");
    try {
      const lamps = state?.ok ? state.lamps.filter((l) => l.reachable) : [];
      await Promise.all(
        lamps.map((l) => postJson("/api/light", { entityId: l.entityId, on: false })),
      );
      flash("Everything off");
    } catch {
      flash("Couldn't turn everything off");
    } finally {
      setPending(null);
      void load();
    }
  }, [state, flash, load]);

  const setLamp = useCallback(
    async (
      lamp: LampView,
      patch: { on?: boolean; brightness?: number; kelvin?: number },
    ) => {
      setPending(lamp.entityId);
      try {
        await postJson("/api/light", { entityId: lamp.entityId, ...patch });
      } catch (error) {
        flash(error instanceof Error ? error.message : "Couldn't change that lamp");
      } finally {
        setPending(null);
        void load();
      }
    },
    [flash, load],
  );

  const anyOn = state?.ok ? state.lamps.some((l) => l.on) : false;

  return (
    <div className="app">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight m-0">Living Room</h1>
          <p className="text-[13px] text-[var(--text-muted)] m-0 mt-0.5">
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
          className="text-[var(--text-muted)] active:text-[var(--accent)] active:scale-90 transition-transform"
          style={{ minWidth: 44 }}
        >
          <RefreshCw size={18} />
        </button>
      </header>

      <main>
        {state && !state.ok && <Disconnected message={state.message} onRetry={load} />}

        {state?.ok && (
          <>
            {state.unreachableCount > 0 && (
              <Banner>
                {state.unreachableCount === 1
                  ? "1 lamp is unreachable — check its switch is on."
                  : `${state.unreachableCount} lamps are unreachable — check their switches are on.`}
              </Banner>
            )}

            {state.scenes.length === 0 ? (
              <EmptyScenes />
            ) : (
              <div className="grid grid-cols-2 gap-3 mt-1">
                {state.scenes.map((scene) => (
                  <SceneCard
                    key={scene.entityId}
                    scene={scene}
                    busy={pending === scene.entityId}
                    onTap={() => void activate(scene)}
                  />
                ))}
              </div>
            )}

            <button
              onClick={() => setShowLamps((v) => !v)}
              className="mt-6 mb-1 text-[13px] text-[var(--text-muted)] active:text-[var(--text-primary)] w-full text-left"
              style={{ minHeight: 32 }}
            >
              {showLamps ? "Hide lamps" : `Lamps (${state.lamps.length})`}
            </button>

            {showLamps && (
              <div className="flex flex-col gap-2">
                {state.lamps.map((lamp) => (
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
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      <footer className="flex items-center justify-between gap-3">
        <span
          className="text-[13px] truncate"
          style={{ color: notice ? "var(--accent)" : "var(--text-muted)" }}
        >
          {notice ?? (state?.ok ? "Tap a scene" : "")}
        </span>
        <button
          onClick={() => void allOff()}
          disabled={!anyOn || pending === "all-off"}
          className="flex items-center gap-1.5 px-3.5 rounded-[var(--r-pill)] text-[14px] font-medium transition-colors disabled:opacity-35"
          style={{
            minHeight: 40,
            background: "var(--neutral-bg)",
            color: "var(--neutral-fg)",
          }}
        >
          <Power size={15} />
          All off
        </button>
      </footer>
    </div>
  );
}

function summarize(lamps: LampView[]): string {
  const on = lamps.filter((l) => l.on).length;
  const out = lamps.filter((l) => !l.reachable).length;
  if (lamps.length === 0) return "No lights paired yet";
  const parts = [on === 0 ? "All off" : `${on} of ${lamps.length} on`];
  if (out > 0) parts.push(`${out} unreachable`);
  return parts.join(" · ");
}

function SceneCard({
  scene,
  busy,
  onTap,
}: {
  scene: SceneView;
  busy: boolean;
  onTap: () => void;
}) {
  return (
    <button
      onClick={onTap}
      disabled={busy}
      className="relative flex flex-col justify-end text-left p-4 rounded-[var(--r-lg)] transition-all duration-150 active:scale-[0.97]"
      style={{
        minHeight: 104,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        boxShadow: busy ? "var(--glow-accent)" : "var(--shadow-sm)",
        opacity: busy ? 0.85 : 1,
      }}
    >
      <span
        className="absolute top-3.5 left-4 w-2 h-2 rounded-full"
        style={{ background: scene.accent ?? "var(--accent)" }}
      />
      <span className="text-[15px] font-medium leading-tight">{scene.label}</span>
      {scene.tapCount > 0 && (
        <span className="text-[12px] text-[var(--text-muted)] mt-0.5">
          {scene.tapCount} {scene.tapCount === 1 ? "use" : "uses"}
        </span>
      )}
    </button>
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
}: {
  lamp: LampView;
  busy: boolean;
  open: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onBrightness: (value: number) => void;
  onKelvin: (value: number) => void;
}) {
  const canAdjust = lamp.reachable && lamp.on;

  return (
    <div
      className="rounded-[var(--r-md)] overflow-hidden"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        opacity: lamp.reachable ? 1 : 0.5,
      }}
    >
      <div className="flex items-center gap-3 p-3">
        <button
          onClick={onToggle}
          disabled={!lamp.reachable || busy}
          aria-label={lamp.on ? `Turn off ${lamp.name}` : `Turn on ${lamp.name}`}
          className="shrink-0 active:scale-90 transition-transform"
          style={{
            minWidth: 44,
            color: lamp.on ? "var(--accent)" : "var(--text-muted)",
          }}
        >
          {lamp.reachable ? (
            lamp.on ? <Lightbulb size={20} /> : <LightbulbOff size={20} />
          ) : (
            <WifiOff size={20} />
          )}
        </button>

        <button
          onClick={onOpen}
          disabled={!canAdjust}
          className="min-w-0 flex-1 text-left disabled:cursor-default"
          aria-expanded={open}
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
            size={16}
            className="shrink-0 text-[var(--text-muted)] transition-transform"
            style={{ transform: open ? "rotate(180deg)" : "none" }}
          />
        )}
      </div>

      {open && canAdjust && (
        <div className="px-3 pb-3.5 pt-1 flex flex-col gap-3.5">
          <Slider
            label="Intensity"
            value={lamp.brightness ?? 100}
            min={1}
            max={100}
            suffix="%"
            onCommit={onBrightness}
            ariaLabel={`${lamp.name} brightness`}
          />
          <Slider
            label="Temperature"
            value={lamp.kelvin ?? 2700}
            min={lamp.minKelvin}
            max={lamp.maxKelvin}
            suffix="K"
            step={50}
            // The track is the scale: warm on the left, cool on the right, so
            // the control looks like what it does before you read the number.
            trackImage="linear-gradient(90deg,#ff9329 0%,#ffb765 18%,#ffd6aa 38%,#fff4e8 55%,#f2f4ff 74%,#cfdcff 100%)"
            onCommit={onKelvin}
            ariaLabel={`${lamp.name} colour temperature`}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Commit on release, not on every input event.
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
  onCommit: (value: number) => void;
  ariaLabel: string;
}) {
  const [local, setLocal] = useState(value);

  // Follow the lamp when it changes underneath us (a scene fired, another
  // device moved it) — but never while the user is mid-drag.
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) setLocal(value);
  }, [value, dragging]);

  return (
    <label className="block">
      <span className="flex items-baseline justify-between mb-1.5">
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
        className={trackImage ? "temp-range" : ""}
        style={{
          width: "100%",
          minHeight: 44,
          padding: 0,
          accentColor: "var(--accent)",
          ...(trackImage ? { ["--track-image" as string]: trackImage } : {}),
        }}
      />
    </label>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-[13px] px-3.5 py-2.5 rounded-[var(--r-md)] mb-3"
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

function Disconnected({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center text-center gap-3 py-14 px-6 rounded-[var(--r-lg)]"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
    >
      <WifiOff size={26} className="text-[var(--text-muted)]" />
      <p className="text-[14px] text-[var(--text-secondary)] m-0 max-w-[36ch]">
        {message}
      </p>
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

function EmptyScenes() {
  return (
    <div
      className="py-12 px-6 text-center rounded-[var(--r-lg)]"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
    >
      <p className="text-[14px] text-[var(--text-secondary)] m-0">
        No scenes yet.
      </p>
      <p className="text-[13px] text-[var(--text-muted)] m-0 mt-1.5 max-w-[38ch] mx-auto">
        Add them to Home Assistant and they'll appear here — the app reads the
        scene list rather than keeping its own.
      </p>
    </div>
  );
}
