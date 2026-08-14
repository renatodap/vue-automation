"use client";

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

/**
 * The controls every surface shares.
 *
 * Lifted out of scene-picker.tsx unchanged when the app grew tabs: the lamp
 * sliders on Devices, on the room map and behind "All lamps" have to behave
 * identically, and three copies would drift apart within a week.
 */

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
export function Controls({
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

/**
 * Commits on release, not on every input event.
 *
 * A slider fires continuously while dragging; forwarding each frame to Zigbee
 * floods a mesh that manages a few messages a second, and the lamp ends up
 * chasing a queue of stale values seconds after your thumb stopped.
 */
export function Slider({
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

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[12px] uppercase tracking-wide text-[var(--text-muted)] m-0 font-medium">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Chip({
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

export function Banner({ children }: { children: React.ReactNode }) {
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

export function Disconnected({
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

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div
      className="py-8 px-5 text-center rounded-[var(--r-md)]"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
    >
      <p className="text-[13px] text-[var(--text-secondary)] m-0">{title}</p>
      {hint && <p className="text-[12px] text-[var(--text-muted)] m-0 mt-1">{hint}</p>}
    </div>
  );
}
