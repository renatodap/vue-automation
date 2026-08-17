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
 * Home answers "is the room right"; this tab answers "what is this bulb". The
 * diagnostics that distinction implies — the reported tunable range, the colour
 * mode, the entity id — are one line at the bottom of an opened lamp rather
 * than six chips under every closed one. Six chips × nine bulbs is a screen of
 * facts nobody is reading on the way to a light switch.
 */
export function DevicesPanel() {
  const { state, lamps, pending, load, setLamp, solo, copyTo } = useHouse();
  const [openLamp, setOpenLamp] = useState<string | null>(null);

  if (state && !state.ok) return <Disconnected message={state.message} onRetry={load} />;

  const unreachable = lamps.filter((l) => !l.reachable);

  return (
    <Section title={`Lamps (${lamps.length})`}>
      <div className="flex flex-col gap-1.5">
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
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button
          onClick={onToggle}
          disabled={!lamp.reachable || busy}
          aria-label={lamp.on ? `Turn off ${lamp.name}` : `Turn on ${lamp.name}`}
          className="shrink-0 active:scale-90 transition-transform"
          style={{
            minWidth: 40,
            // The icon carries the bulb's real colour when it is lit, so the
            // list reads at a glance.
            color: lamp.reachable && lamp.on ? lampCss(lamp) : "var(--text-muted)",
          }}
        >
          {lamp.reachable ? (
            lamp.on ? (
              <Lightbulb size={18} />
            ) : (
              <LightbulbOff size={18} />
            )
          ) : (
            <WifiOff size={18} />
          )}
        </button>

        <button
          onClick={onOpen}
          disabled={!canAdjust}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left disabled:cursor-default"
          style={{ minHeight: 38 }}
        >
          {/* Never truncate a device name — wrap instead. */}
          <div className="text-[13px] leading-tight break-words">{lamp.name}</div>
          <div className="text-[11px] text-[var(--text-muted)] leading-tight">
            {!lamp.reachable
              ? "No power at the lamp — check its switch"
              : lamp.on
                ? `${lamp.brightness ?? 100}% · ${lamp.kelvin && lamp.colorMode === "color_temp" ? `${lamp.kelvin}K` : "colour"}`
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
        <div className="px-2.5 pb-2.5 flex flex-col gap-2.5">
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

          {/* One scrolling row rather than a wrapping block. Eight effects wrap
              to three rows on a phone, which is taller than every control above
              it for a feature almost nobody opens this tab to use. */}
          {lamp.effects.length > 0 && (
            <div className="hscroll flex gap-1.5">
              {lamp.effects.map((effect) => (
                <button
                  key={effect}
                  onClick={() => onEffect(effect)}
                  className="rounded-[var(--r-pill)] text-[12px] font-medium px-2.5 shrink-0"
                  style={{
                    minHeight: 32,
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
          )}

          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={onSolo}
              disabled={!hasOthers}
              className="flex items-center justify-center gap-1.5 rounded-[var(--r-sm)] text-[12px] font-medium disabled:opacity-35"
              style={{
                minHeight: 38,
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
                minHeight: 38,
                background: "var(--surface-sunken)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border)",
              }}
            >
              <ChevronsLeftRight size={14} /> Match all
            </button>
          </div>

          {/* The diagnostics, once, at the bottom of the one lamp being looked
              at. The kelvin range is the bulb's OWN reported envelope: asking a
              lamp for a value outside it fails silently — the light does not
              move, which reads as the app being broken. */}
          <p
            className="text-[11px] m-0 break-all"
            style={{
              color: "var(--text-muted)",
              userSelect: "text",
              WebkitUserSelect: "text",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          >
            {lamp.minKelvin}–{lamp.maxKelvin}K ·{" "}
            {lamp.supportsColor ? "white + colour" : "white only"} ·{" "}
            {lamp.colorMode ?? "off"} · {lamp.entityId}
          </p>
        </div>
      )}
    </div>
  );
}
