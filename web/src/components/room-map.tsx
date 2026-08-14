"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronsLeftRight,
  Copy,
  Minus,
  Plus,
  Power,
  Snowflake,
  Sun,
  Target,
  X,
} from "lucide-react";
import { assetUrl, postJson } from "@/lib/client";
import { lampCss } from "@/lib/light-color";
import { PLATE_HEIGHT, PLATE_WIDTH, isPlaced, placementFor } from "@/lib/placement";
import type { LampView } from "@/lib/types";
import { patchFromLamp, useHouse } from "./house";
import { Controls, Disconnected } from "./ui";

/**
 * The room, seen from above, with the lamps where they physically are.
 *
 * The plate is a static image with no lamp, no fixture and no glow baked into
 * it (see docs/design/room-map/README.md). Every state-bearing pixel is drawn
 * live on top, tinted from the bulb's real colour, because a picture with light
 * painted into it disagrees with the room the moment anything changes — the
 * same failure as rendering a cached state as current.
 *
 * The gesture vocabulary, all on one marker:
 *
 *   tap                 toggle that lamp
 *   double tap          solo — this one on, everything else off
 *   drag                scrub its brightness, live
 *   hold                lift it; release in place to open its controls
 *   hold, drag, drop    copy this lamp's exact settings onto another
 *
 * They coexist because the decision is made once, early, and never revisited:
 * movement before the hold timer means brightness, movement after it means
 * carry. An axis that can flip under the thumb feels broken, and three of these
 * four lamps sit in a vertical line, so "vertical means brightness, horizontal
 * means copy" would have made the most common copy impossible.
 */

/** Below this much travel, a press is still a press. */
const MOVE_SLOP = 10;
/** Long enough not to fire on a tap, short enough not to feel stuck. */
const HOLD_MS = 400;
/** A second tap inside this window is a double tap. */
const DOUBLE_TAP_MS = 300;
/** Full brightness range per this much finger travel. */
const SCRUB_TRAVEL = 220;
/**
 * Zigbee manages a handful of messages a second. Forwarding every frame leaves
 * the lamp chasing a queue of stale values seconds after the thumb stopped.
 */
const SCRUB_COMMIT_MS = 250;
/** How close to a marker's centre counts as being over it. */
const DROP_RADIUS_PX = 38;

type Gesture = {
  pointerId: number;
  lamp: LampView;
  startX: number;
  startY: number;
  anchorBrightness: number;
  holdTimer: ReturnType<typeof setTimeout> | null;
  mode: "undecided" | "scrub" | "carry";
  lastCommit: number;
};

export function RoomMap() {
  const { state, lamps, reachable, lit, pending, load, flash, setAll, setLamp, solo, copyTo } =
    useHouse();

  const plateRef = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ entityId: string; at: number } | null>(null);

  const [sheetId, setSheetId] = useState<string | null>(null);
  const [carryId, setCarryId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [scrub, setScrub] = useState<{ entityId: string; value: number } | null>(null);
  const [paintFrom, setPaintFrom] = useState<string | null>(null);

  const placed = useMemo(
    () =>
      lamps.map((lamp, index) => ({
        lamp,
        at: placementFor(lamp.entityId, index, lamps.length),
      })),
    [lamps],
  );

  const sheetLamp = lamps.find((l) => l.entityId === sheetId) ?? null;
  const paintLamp = lamps.find((l) => l.entityId === paintFrom) ?? null;

  // A lamp that disappears from Home Assistant must not leave a panel open over
  // a lamp that no longer exists.
  useEffect(() => {
    if (sheetId && !lamps.some((l) => l.entityId === sheetId)) setSheetId(null);
    if (paintFrom && !lamps.some((l) => l.entityId === paintFrom)) setPaintFrom(null);
  }, [lamps, paintFrom, sheetId]);

  const confirm = useCallback((entityId: string) => {
    setFlashId(entityId);
    setTimeout(() => setFlashId((c) => (c === entityId ? null : c)), 700);
  }, []);

  /** Which lamp, if any, the pointer is currently over. */
  const lampUnder = useCallback(
    (clientX: number, clientY: number): LampView | null => {
      const rect = plateRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return null;
      let best: { lamp: LampView; distance: number } | null = null;
      for (const { lamp, at } of placed) {
        const dx = rect.left + at.x * rect.width - clientX;
        const dy = rect.top + at.y * rect.height - clientY;
        const distance = Math.hypot(dx, dy);
        if (distance <= DROP_RADIUS_PX && (!best || distance < best.distance)) {
          best = { lamp, distance };
        }
      }
      return best?.lamp ?? null;
    },
    [placed],
  );

  const tap = useCallback(
    (lamp: LampView) => {
      if (paintFrom && paintLamp && paintFrom !== lamp.entityId) {
        // Eyedropper: the tap paints instead of toggling. For the three-of-four
        // case where "match all" is too blunt.
        if (!lamp.reachable) {
          flash(`${lamp.name} has no power — nothing to paint`);
          return;
        }
        confirm(lamp.entityId);
        // Undo was armed when the eyedropper was picked up, so the whole pass
        // reverts as one action rather than one lamp at a time.
        void copyTo(paintLamp, [lamp], { remember: false });
        return;
      }

      if (!lamp.reachable) {
        // Never let a tap land silently. An unreachable bulb is a real, common
        // state and saying so is the difference between "broken app" and "go
        // flip the switch".
        flash(`${lamp.name} has no power — check the switch on the lamp`);
        return;
      }

      const now = Date.now();
      const previous = lastTap.current;
      lastTap.current = { entityId: lamp.entityId, at: now };

      if (previous?.entityId === lamp.entityId && now - previous.at < DOUBLE_TAP_MS) {
        lastTap.current = null;
        confirm(lamp.entityId);
        // The first tap already toggled, and solo puts it back on. One extra
        // message to the mesh buys a toggle that answers on the first tap
        // instead of waiting to find out whether a second one is coming —
        // which is the wrong trade in a dark room.
        void solo(lamp);
        return;
      }

      void setLamp(lamp, { on: !lamp.on });
    },
    [confirm, copyTo, flash, paintFrom, paintLamp, setLamp, solo],
  );

  const onPointerDown = useCallback(
    (lamp: LampView, event: React.PointerEvent<HTMLButtonElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      const holdTimer = setTimeout(() => {
        const g = gesture.current;
        if (!g || g.mode !== "undecided") return;
        g.mode = "carry";
        setCarryId(g.lamp.entityId);
        // A lift you can feel. Silent on anything without a vibrator, which is
        // every desktop browser and iOS Safari.
        navigator.vibrate?.(8);
      }, HOLD_MS);

      gesture.current = {
        pointerId: event.pointerId,
        lamp,
        startX: event.clientX,
        startY: event.clientY,
        anchorBrightness: lamp.on ? (lamp.brightness ?? 100) : 0,
        holdTimer,
        mode: "undecided",
        lastCommit: 0,
      };
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const g = gesture.current;
      if (!g || g.pointerId !== event.pointerId) return;

      const dx = event.clientX - g.startX;
      const dy = event.clientY - g.startY;

      if (g.mode === "undecided") {
        if (Math.hypot(dx, dy) < MOVE_SLOP) return;
        if (g.holdTimer) clearTimeout(g.holdTimer);
        g.holdTimer = null;
        if (!g.lamp.reachable) {
          // Nothing to scrub on a bulb with no power, and pretending otherwise
          // leaves a number on screen that no lamp is holding.
          g.mode = "carry";
          setCarryId(g.lamp.entityId);
          return;
        }
        g.mode = "scrub";
      }

      if (g.mode === "carry") {
        const over = lampUnder(event.clientX, event.clientY);
        setHoverId(over && over.entityId !== g.lamp.entityId ? over.entityId : null);
        return;
      }

      // Up is brighter, which is the only direction that needs no explanation.
      const level = Math.max(
        1,
        Math.min(100, Math.round(g.anchorBrightness + (-dy / SCRUB_TRAVEL) * 100)),
      );
      setScrub({ entityId: g.lamp.entityId, value: level });

      const now = Date.now();
      if (now - g.lastCommit > SCRUB_COMMIT_MS) {
        g.lastCommit = now;
        // Deliberately not through the house's act(): an intermediate frame
        // must not trigger a full state re-read, and a dropped one is corrected
        // by the final commit a moment later.
        void postJson("/api/light", {
          patches: [{ entityId: g.lamp.entityId, on: true, brightness: level }],
        }).catch(() => {});
      }
    },
    [lampUnder],
  );

  const finish = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const g = gesture.current;
      if (!g || g.pointerId !== event.pointerId) return;
      if (g.holdTimer) clearTimeout(g.holdTimer);
      gesture.current = null;
      setCarryId(null);
      setHoverId(null);

      // The lamp captured at pointer-down can be seconds old by release — a
      // poll or a scene may have moved it underneath the thumb. Only the id is
      // reliably still true, so re-read the rest from the current room.
      const lamp = lamps.find((l) => l.entityId === g.lamp.entityId) ?? g.lamp;

      if (g.mode === "scrub") {
        const dy = event.clientY - g.startY;
        const level = Math.max(
          1,
          Math.min(100, Math.round(g.anchorBrightness + (-dy / SCRUB_TRAVEL) * 100)),
        );
        setScrub(null);
        // Final value, unthrottled, so the lamp lands exactly where the thumb
        // left it rather than wherever the last throttled tick was.
        void setLamp(lamp, { on: true, brightness: level });
        return;
      }

      if (g.mode === "carry") {
        const over = lampUnder(event.clientX, event.clientY);
        if (over && over.entityId !== lamp.entityId) {
          confirm(over.entityId);
          void copyTo(lamp, [over]);
        } else {
          // Lifted and put back down: they wanted the controls.
          setSheetId(lamp.entityId);
        }
        return;
      }

      tap(lamp);
    },
    [confirm, copyTo, lamps, lampUnder, setLamp, tap],
  );

  const cancel = useCallback(() => {
    const g = gesture.current;
    if (g?.holdTimer) clearTimeout(g.holdTimer);
    gesture.current = null;
    setCarryId(null);
    setHoverId(null);
    setScrub(null);
  }, []);

  if (state && !state.ok) {
    return (
      <div className="room-page">
        <Disconnected message={state.message} onRetry={load} />
      </div>
    );
  }

  return (
    <div className="room-page">
      <div className="room-stage">
        <div className="room-plate" ref={plateRef}>
          {/* Decorative: the markers carry every piece of information. */}
          <img
            src={assetUrl("/room-plate-dark.png")}
            width={PLATE_WIDTH}
            height={PLATE_HEIGHT}
            alt=""
            aria-hidden
            draggable={false}
          />
          {placed.map(({ lamp, at }) => (
            <Marker
              key={lamp.entityId}
              lamp={lamp}
              at={at}
              busy={pending === lamp.entityId}
              carrying={carryId === lamp.entityId}
              // Everything else is a target while a lamp is in the air, and
              // while the eyedropper is armed.
              target={
                (carryId !== null && carryId !== lamp.entityId) ||
                (paintFrom !== null && paintFrom !== lamp.entityId)
              }
              hovered={hoverId === lamp.entityId}
              flashing={flashId === lamp.entityId}
              selected={sheetId === lamp.entityId || paintFrom === lamp.entityId}
              scrubbing={scrub?.entityId === lamp.entityId ? scrub.value : null}
              onPointerDown={(e) => onPointerDown(lamp, e)}
              onPointerMove={onPointerMove}
              onPointerUp={finish}
              onPointerCancel={cancel}
              onActivate={() => tap(lamp)}
            />
          ))}
        </div>
      </div>

      {paintLamp ? (
        <div className="room-strip">
          <div className="flex items-center gap-2">
            <span
              className="shrink-0 rounded-full"
              style={{ width: 14, height: 14, background: lampCss(paintLamp) }}
            />
            <span className="text-[13px] flex-1 min-w-0">
              Painting from <strong>{paintLamp.name}</strong> — tap lamps to match it
            </span>
            <button
              onClick={() => setPaintFrom(null)}
              className="px-3 rounded-[var(--r-sm)] text-[13px] font-medium shrink-0"
              style={{
                minHeight: 40,
                background: "var(--accent)",
                color: "var(--text-on-accent)",
              }}
            >
              Done
            </button>
          </div>
        </div>
      ) : sheetLamp ? (
        <LampSheet
          lamp={sheetLamp}
          onClose={() => setSheetId(null)}
          onPaint={() => {
            setPaintFrom(sheetLamp.entityId);
            setSheetId(null);
          }}
        />
      ) : (
        <div className="room-strip">
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => void setAll({ on: true })}
              disabled={pending === "master" || !reachable.length}
              className="flex items-center justify-center gap-1.5 rounded-[var(--r-sm)] text-[14px] font-medium disabled:opacity-35"
              style={{
                minHeight: 44,
                background: lit.length ? "var(--accent-subtle)" : "var(--accent)",
                color: lit.length ? "var(--accent)" : "var(--text-on-accent)",
                border: "1px solid var(--accent-border)",
              }}
            >
              <Sun size={15} /> All on
            </button>
            <button
              onClick={() => void setAll({ on: false })}
              disabled={pending === "master" || !lit.length}
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

          <MasterNudges />

          <p className="text-[12px] text-[var(--text-muted)] m-0 mt-2 text-center">
            {state === null
              ? "Reading the room…"
              : lamps.length === 0
                ? "No lamps paired yet — pair them in Zigbee2MQTT."
                : "Tap to switch · drag to dim · hold to open · drop on another to copy"}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Room brightness and warmth, as nudges rather than as sliders.
 *
 * Buttons beat sliders for precision with a thumb, and — more importantly —
 * these are RELATIVE. Every lit lamp scales by the same factor, so a room built
 * lamp by lamp keeps its shape and only changes level. An absolute master would
 * flatten it to a single value, which is the classic way to destroy a scene
 * somebody spent five minutes arranging.
 */
function MasterNudges() {
  const { lit, pending, scaleBrightness, shiftWarmth } = useHouse();
  const busy = pending === "master";

  return (
    <div className="grid grid-cols-4 gap-1.5 mt-2">
      <NudgeButton
        label="Dimmer"
        disabled={busy || !lit.length}
        onClick={() => void scaleBrightness(1 / 1.25)}
      >
        <Minus size={13} />
        <Sun size={13} />
      </NudgeButton>
      <NudgeButton
        label="Brighter"
        disabled={busy || !lit.length}
        onClick={() => void scaleBrightness(1.25)}
      >
        <Plus size={13} />
        <Sun size={13} />
      </NudgeButton>
      <NudgeButton
        label="Warmer"
        disabled={busy || !lit.length}
        onClick={() => void shiftWarmth(-250)}
      >
        <Sun size={13} style={{ color: "#ffb765" }} />
      </NudgeButton>
      <NudgeButton
        label="Cooler"
        disabled={busy || !lit.length}
        onClick={() => void shiftWarmth(250)}
      >
        <Snowflake size={13} style={{ color: "#cfdcff" }} />
      </NudgeButton>
    </div>
  );
}

function NudgeButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex flex-col items-center justify-center gap-0.5 rounded-[var(--r-sm)] text-[11px] font-medium disabled:opacity-35 active:scale-95 transition-transform"
      style={{
        minHeight: 44,
        background: "var(--surface-sunken)",
        color: "var(--text-secondary)",
        border: "1px solid var(--border)",
      }}
    >
      <span className="flex items-center gap-0.5">{children}</span>
      {label}
    </button>
  );
}

/**
 * One lamp: a dot in its real colour, with a glow that tracks brightness.
 *
 * The glow IS the brightness readout. You should be able to see what the room
 * is doing without reading a number off anything.
 */
function Marker({
  lamp,
  at,
  busy,
  carrying,
  target,
  hovered,
  flashing,
  selected,
  scrubbing,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onActivate,
}: {
  lamp: LampView;
  at: { x: number; y: number };
  busy: boolean;
  carrying: boolean;
  target: boolean;
  hovered: boolean;
  flashing: boolean;
  selected: boolean;
  scrubbing: number | null;
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: () => void;
  onActivate: () => void;
}) {
  const colour = lampCss(lamp);
  // While a thumb is down the glow follows the thumb, not the mesh: the lamp
  // reports back a few hundred milliseconds late and the light would lag the
  // finger by a visible beat.
  const shown = scrubbing ?? (lamp.on ? (lamp.brightness ?? 100) : 0);
  const level = shown / 100;
  const glowing = lamp.reachable && (lamp.on || scrubbing !== null);

  return (
    <button
      className="lamp-marker"
      data-selected={selected || undefined}
      data-carrying={carrying || undefined}
      data-target={target || undefined}
      data-hovered={hovered || undefined}
      data-flashing={flashing || undefined}
      style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
      disabled={busy}
      aria-label={lamp.name}
      aria-pressed={lamp.reachable ? lamp.on : undefined}
      title={[
        lamp.name,
        lamp.reachable
          ? lamp.on
            ? `on, ${Math.round(shown)}%`
            : "off"
          : "no power at the lamp",
        // Anything unplaced is parked on the arc along the bottom rather than
        // dropped on top of the furniture. Say so, so it doesn't read as the
        // map being wrong about where the lamp is.
        isPlaced(lamp.entityId) ? null : "position not set",
      ]
        .filter(Boolean)
        .join(" — ")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      // A keyboard produces no pointer events at all, so without this the
      // marker is a button that cannot be pressed. Enter and Space toggle;
      // everything past that lives in the list on the Devices tab.
      onKeyUp={(e) => {
        if (e.key === "Enter" || e.key === " ") onActivate();
      }}
      // Long-press on iOS otherwise raises the callout menu over the lamp.
      onContextMenu={(e) => e.preventDefault()}
    >
      {glowing && (
        <span
          className="lamp-glow"
          aria-hidden
          style={{
            width: 92 + 96 * level,
            height: 92 + 96 * level,
            background: `radial-gradient(circle, ${lampCss(lamp, 0.55 * level + 0.15)} 0%, ${lampCss(lamp, 0)} 70%)`,
            // No easing while the thumb is driving it — the glow should track
            // the finger, not chase it.
            transition: scrubbing === null ? undefined : "none",
          }}
        />
      )}
      <span
        className="lamp-dot"
        aria-hidden
        style={{
          background: glowing ? colour : "transparent",
          borderStyle: lamp.reachable ? "solid" : "dashed",
          borderColor: lamp.reachable
            ? glowing
              ? "rgba(0,0,0,0.35)"
              : colour
            : "var(--text-muted)",
          opacity: lamp.reachable ? 1 : 0.7,
          boxShadow: glowing ? `0 0 10px ${lampCss(lamp, 0.6)}` : "none",
        }}
      />
      <span className="lamp-label">
        {scrubbing !== null ? `${Math.round(scrubbing)}%` : lamp.name}
      </span>
    </button>
  );
}

/** The held lamp's own controls, in the strip under the map. */
function LampSheet({
  lamp,
  onClose,
  onPaint,
}: {
  lamp: LampView;
  onClose: () => void;
  onPaint: () => void;
}) {
  const { pending, reachable, setLamp, solo, copyTo, remember } = useHouse();
  const canAdjust = lamp.reachable && lamp.on;
  const busy = pending === lamp.entityId;
  const others = reachable.filter((l) => l.entityId !== lamp.entityId);

  const nudgeBrightness = (delta: number) =>
    void setLamp(lamp, {
      on: true,
      brightness: Math.max(1, Math.min(100, (lamp.brightness ?? 100) + delta)),
    });

  const nudgeKelvin = (delta: number) =>
    void setLamp(lamp, {
      on: true,
      // The bulb's OWN range, never a hardcoded 2700–6500: a value past the end
      // is rejected in silence and the lamp just doesn't move.
      kelvin: Math.max(
        lamp.minKelvin,
        Math.min(lamp.maxKelvin, (lamp.kelvin ?? 2700) + delta),
      ),
    });

  return (
    <div className="room-strip">
      <div className="flex items-center gap-2 mb-2.5">
        <button
          onClick={() => void setLamp(lamp, { on: !lamp.on })}
          disabled={!lamp.reachable || busy}
          className="rounded-[var(--r-sm)] text-[13px] font-medium px-3 disabled:opacity-40"
          style={{
            minHeight: 40,
            background: lamp.on ? "var(--accent-subtle)" : "var(--neutral-bg)",
            color: lamp.on ? "var(--accent)" : "var(--neutral-fg)",
            border: `1px solid ${lamp.on ? "var(--accent-border)" : "var(--border)"}`,
          }}
        >
          {lamp.on ? "On" : "Off"}
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] leading-tight break-words">{lamp.name}</div>
          <div className="text-[12px] text-[var(--text-muted)]">
            {!lamp.reachable
              ? "No power at the lamp — check its switch"
              : lamp.on
                ? `${lamp.brightness ?? 100}% · ${lamp.kelvin ? `${lamp.kelvin}K` : "colour"}`
                : "Off"}
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 text-[var(--text-muted)]"
          style={{ minWidth: 40 }}
        >
          <X size={16} className="mx-auto" />
        </button>
      </div>

      {/* Nudges first: a thumb is bad at hitting a specific value on a slider,
          and almost every real correction is "a bit more" or "a bit warmer". */}
      <div className="grid grid-cols-4 gap-1.5 mb-2.5">
        <NudgeButton label="−10%" disabled={!canAdjust} onClick={() => nudgeBrightness(-10)}>
          <Minus size={13} />
          <Sun size={13} />
        </NudgeButton>
        <NudgeButton label="+10%" disabled={!canAdjust} onClick={() => nudgeBrightness(10)}>
          <Plus size={13} />
          <Sun size={13} />
        </NudgeButton>
        <NudgeButton label="Warmer" disabled={!canAdjust} onClick={() => nudgeKelvin(-200)}>
          <Sun size={13} style={{ color: "#ffb765" }} />
        </NudgeButton>
        <NudgeButton label="Cooler" disabled={!canAdjust} onClick={() => nudgeKelvin(200)}>
          <Snowflake size={13} style={{ color: "#cfdcff" }} />
        </NudgeButton>
      </div>

      <Controls
        idPrefix={lamp.name}
        brightness={lamp.brightness ?? 100}
        kelvin={lamp.kelvin ?? 2700}
        minKelvin={lamp.minKelvin}
        maxKelvin={lamp.maxKelvin}
        hs={lamp.hs}
        supportsColor={lamp.supportsColor}
        inColorMode={lamp.colorMode !== null && lamp.colorMode !== "color_temp"}
        disabled={!canAdjust}
        onBrightness={(v) => void setLamp(lamp, { brightness: v })}
        onKelvin={(v) => void setLamp(lamp, { kelvin: v })}
        onHs={(v) => void setLamp(lamp, { hs: v })}
      />

      {/* The bulb's own vocabulary, which the app has never exposed. */}
      {lamp.effects.length > 0 && (
        <div className="mt-2.5">
          <div className="text-[12px] text-[var(--text-secondary)] mb-1.5">Effects</div>
          <div className="flex gap-1.5 flex-wrap">
            {lamp.effects.map((effect) => (
              <button
                key={effect}
                disabled={!canAdjust}
                onClick={() => void setLamp(lamp, { effect })}
                className="rounded-[var(--r-pill)] text-[12px] font-medium px-2.5 disabled:opacity-40"
                style={{
                  minHeight: 30,
                  background:
                    lamp.effect === effect ? "var(--accent-subtle)" : "var(--surface-sunken)",
                  color: lamp.effect === effect ? "var(--accent)" : "var(--text-muted)",
                  border: `1px solid ${lamp.effect === effect ? "var(--accent-border)" : "transparent"}`,
                }}
              >
                {effect.replace(/_/g, " ")}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-1.5 mt-2.5">
        <SheetAction
          label="Solo"
          disabled={!lamp.reachable || !others.length}
          onClick={() => void solo(lamp)}
        >
          <Target size={14} />
        </SheetAction>
        <SheetAction
          label="Match all"
          disabled={!lamp.reachable || !others.length}
          onClick={() => void copyTo(lamp, "all")}
        >
          <ChevronsLeftRight size={14} />
        </SheetAction>
        <SheetAction
          label="Copy to…"
          disabled={!lamp.reachable || !others.length}
          onClick={() => {
            // Undo is armed here rather than per tap, so a whole painting pass
            // reverts as one action instead of needing four taps back.
            remember(`copy from ${lamp.name}`);
            onPaint();
          }}
        >
          <Copy size={14} />
        </SheetAction>
      </div>

      {/* Nothing to copy to, and a disabled row with no explanation reads as a
          bug rather than as a room with one bulb in it. */}
      {!others.length && (
        <p className="text-[11px] text-[var(--text-muted)] m-0 mt-1.5 text-center">
          Copying needs a second reachable lamp.
        </p>
      )}

      {/* Kept honest: this is what the bulb says it can do, not what we assume. */}
      <p className="text-[11px] text-[var(--text-muted)] m-0 mt-1.5 text-center">
        {lamp.minKelvin}–{lamp.maxKelvin} K
        {lamp.supportsColor ? " · colour" : " · white only"}
      </p>

      {/* Present so a mis-drop is recoverable without hunting for the pill. */}
      <UndoInline />
    </div>
  );
}

function SheetAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center justify-center gap-1.5 rounded-[var(--r-sm)] text-[12px] font-medium disabled:opacity-35 active:scale-95 transition-transform"
      style={{
        minHeight: 44,
        background: "var(--surface-sunken)",
        color: "var(--text-secondary)",
        border: "1px solid var(--border)",
      }}
    >
      {children}
      {label}
    </button>
  );
}

function UndoInline() {
  const { undo, revert } = useHouse();
  if (!undo) return null;
  return (
    <button
      onClick={() => void revert()}
      className="w-full rounded-[var(--r-sm)] text-[12px] font-medium mt-1.5"
      style={{
        minHeight: 36,
        background: "var(--warning-bg)",
        color: "var(--warning)",
        border: "1px solid var(--accent-border)",
      }}
    >
      Undo {undo.label}
    </button>
  );
}
