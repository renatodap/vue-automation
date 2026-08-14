"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronsLeftRight,
  Lightbulb,
  LightbulbOff,
  Target,
  WifiOff,
} from "lucide-react";
import { lampCss } from "@/lib/light-color";
import type { LampView } from "@/lib/types";
import { useHouse } from "./house";
import { Controls, Disconnected, Empty, Section } from "./ui";

/**
 * Every bulb, and what it is actually doing.
 *
 * The Room tab answers "is the room right"; this one answers "what is this
 * bulb". That means the numbers the map deliberately hides — the reported
 * tunable range, the colour mode the bulb is holding, the entity id — belong
 * here, where someone is diagnosing rather than lighting a room.
 */
export function DevicesPanel() {
  const { state, lamps, pending, load, setLamp, solo, copyTo } = useHouse();
  const [openLamp, setOpenLamp] = useState<string | null>(null);

  if (state && !state.ok) return <Disconnected message={state.message} onRetry={load} />;

  const unreachable = lamps.filter((l) => !l.reachable);

  return (
    <Section title={`Lamps (${lamps.length})`}>
      <div className="flex flex-col gap-2">
        {state?.ok && lamps.length === 0 && (
          <Empty
            title="No lamps paired yet."
            hint="Pair them in Zigbee2MQTT and they appear here."
          />
        )}

        {lamps.map((lamp) => (
          <LampRow
            key={lamp.entityId}
            lamp={lamp}
            busy={pending === lamp.entityId}
            open={openLamp === lamp.entityId}
            hasOthers={lamps.some((l) => l.entityId !== lamp.entityId && l.reachable)}
            onOpen={() =>
              setOpenLamp((c) => (c === lamp.entityId ? null : lamp.entityId))
            }
            onToggle={() => void setLamp(lamp, { on: !lamp.on })}
            onBrightness={(v) => void setLamp(lamp, { brightness: v })}
            onKelvin={(v) => void setLamp(lamp, { kelvin: v })}
            onHs={(v) => void setLamp(lamp, { hs: v })}
            onEffect={(effect) => void setLamp(lamp, { effect })}
            onSolo={() => void solo(lamp)}
            onMatchAll={() => void copyTo(lamp, "all")}
          />
        ))}

        {unreachable.length > 0 && (
          <p className="text-[12px] text-[var(--text-muted)] m-0 mt-1">
            A bulb reports unreachable when its power is cut — almost always a
            wall switch or a lamp switch, not the mesh.
          </p>
        )}
      </div>
    </Section>
  );
}

function LampRow({
  lamp,
  busy,
  open,
  hasOthers,
  onOpen,
  onToggle,
  onBrightness,
  onKelvin,
  onHs,
  onEffect,
  onSolo,
  onMatchAll,
}: {
  lamp: LampView;
  busy: boolean;
  open: boolean;
  hasOthers: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onBrightness: (value: number) => void;
  onKelvin: (value: number) => void;
  onHs: (value: [number, number]) => void;
  onEffect: (effect: string) => void;
  onSolo: () => void;
  onMatchAll: () => void;
}) {
  const canAdjust = lamp.reachable && lamp.on;

  return (
    <div
      className="rounded-[var(--r-md)]"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        opacity: lamp.reachable ? 1 : 0.72,
      }}
    >
      <div className="flex items-center gap-2 p-2.5">
        <button
          onClick={onToggle}
          disabled={!lamp.reachable || busy}
          aria-label={lamp.on ? `Turn off ${lamp.name}` : `Turn on ${lamp.name}`}
          className="shrink-0 active:scale-90 transition-transform"
          style={{
            minWidth: 44,
            // The icon carries the bulb's real colour when it is lit, so the
            // list reads at a glance the same way the map does.
            color: lamp.reachable
              ? lamp.on
                ? lampCss(lamp)
                : "var(--text-muted)"
              : "var(--text-muted)",
          }}
        >
          {lamp.reachable ? (
            lamp.on ? (
              <Lightbulb size={19} />
            ) : (
              <LightbulbOff size={19} />
            )
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
              ? "No power at the lamp — check its switch"
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

      <div className="px-2.5 pb-2.5 flex flex-wrap gap-1.5">
        <Tag tone={lamp.reachable ? "ok" : "bad"}>
          {lamp.reachable ? "Reachable" : "Unreachable"}
        </Tag>
        {/* The bulb's OWN reported envelope. Hardcoding 2700–6500 here would be
            a lie about a bulb that reports something else, and asking a lamp
            for a value outside its range fails silently — the light simply does
            not move, which reads as the app being broken. */}
        <Tag>
          {lamp.minKelvin}–{lamp.maxKelvin} K
        </Tag>
        <Tag>{lamp.supportsColor ? "White + colour" : "White only"}</Tag>
        {lamp.reachable && lamp.on && lamp.colorMode && (
          <Tag>mode: {lamp.colorMode}</Tag>
        )}
        {lamp.reachable && lamp.effect && <Tag tone="ok">effect: {lamp.effect}</Tag>}
        {lamp.reachable && lamp.on && lamp.hs && (
          <Tag>
            {Math.round(lamp.hs[0])}° · {Math.round(lamp.hs[1])}%
          </Tag>
        )}
        <Tag mono>{lamp.entityId}</Tag>
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

          {lamp.effects.length > 0 && (
            <div className="mt-3">
              <div className="text-[12px] text-[var(--text-secondary)] mb-1.5">Effects</div>
              <div className="flex gap-1.5 flex-wrap">
                {lamp.effects.map((effect) => (
                  <button
                    key={effect}
                    onClick={() => onEffect(effect)}
                    className="rounded-[var(--r-pill)] text-[12px] font-medium px-2.5"
                    style={{
                      minHeight: 30,
                      background:
                        lamp.effect === effect
                          ? "var(--accent-subtle)"
                          : "var(--surface-sunken)",
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

          {/* The list's answer to dragging one lamp onto another. */}
          <div className="grid grid-cols-2 gap-1.5 mt-3">
            <button
              onClick={onSolo}
              disabled={!hasOthers}
              className="flex items-center justify-center gap-1.5 rounded-[var(--r-sm)] text-[12px] font-medium disabled:opacity-35"
              style={{
                minHeight: 44,
                background: "var(--surface-sunken)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border)",
              }}
            >
              <Target size={14} /> Solo
            </button>
            <button
              onClick={onMatchAll}
              disabled={!hasOthers}
              className="flex items-center justify-center gap-1.5 rounded-[var(--r-sm)] text-[12px] font-medium disabled:opacity-35"
              style={{
                minHeight: 44,
                background: "var(--surface-sunken)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border)",
              }}
            >
              <ChevronsLeftRight size={14} /> Match all to this
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Tag({
  children,
  tone = "neutral",
  mono,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "ok" | "bad";
  mono?: boolean;
}) {
  const palette = {
    neutral: { bg: "var(--surface-sunken)", fg: "var(--text-muted)" },
    ok: { bg: "var(--positive-bg)", fg: "var(--positive)" },
    bad: { bg: "var(--negative-bg)", fg: "var(--negative)" },
  }[tone];

  return (
    <span
      className="text-[11px] px-1.5 py-0.5 rounded-[var(--r-sm)] break-all"
      style={{
        background: palette.bg,
        color: palette.fg,
        fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined,
        // Chrome is un-selectable app furniture; an entity id is content, and
        // copying one into Home Assistant is a real workflow.
        userSelect: "text",
        WebkitUserSelect: "text",
      }}
    >
      {children}
    </span>
  );
}
