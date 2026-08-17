"use client";

import { Lightbulb, LightbulbOff, Power, WifiOff } from "lucide-react";
import { postJson } from "@/lib/client";
import { lampCss } from "@/lib/light-color";
import { LOOKS, groupByRoom, lookPatch, type LookId } from "@/lib/rooms";
import type { LampPatch, LampView, SceneView } from "@/lib/types";
import { useHouse } from "./house";
import { Banner, Disconnected, Empty, Section } from "./ui";

/** Four is what fits across a phone without the buttons becoming targets. */
const MAX_SPOTLIT = 4;

/**
 * Home: the rooms, the bulbs in them, and the scenes worth one tap.
 *
 * This replaced a photographic map of the living room. The map was the fastest
 * way to reach a lamp you could see, and exactly the wrong shape once the house
 * grew a second room and nine bulbs — a plate photographed from one doorway has
 * nowhere to put a bedroom. A list scales; a photograph does not.
 */
export function RoomsPanel() {
  const { state, lamps, pending, load, flash, remember, act, sendPatches } = useHouse();

  if (state && !state.ok) return <Disconnected message={state.message} onRetry={load} />;

  const spotlit = state?.ok
    ? state.scenes.filter((s) => s.spotlight).slice(0, MAX_SPOTLIT)
    : [];
  const groups = groupByRoom(lamps);

  const applyScene = (scene: SceneView) => {
    remember(scene.label);
    return act(scene.entityId, async () => {
      const r = await postJson<{ unreachable: string[] }>("/api/scene", {
        entityId: scene.entityId,
      });
      // Home Assistant applies a scene to what it can reach and says nothing
      // about the rest, and silence reads as success.
      flash(
        r.unreachable.length
          ? `${scene.label} — couldn't reach ${r.unreachable.join(", ")}`
          : scene.label,
      );
    });
  };

  /** One look across a set of lamps, as a single grouped call. */
  const applyLook = (key: string, targets: LampView[], look: LookId, what: string) => {
    const reachable = targets.filter((l) => l.reachable);
    if (!reachable.length) {
      flash(`Nothing reachable in ${what} — check the switches`);
      return;
    }
    remember(what);
    const patches: LampPatch[] = reachable.map((l) => lookPatch(look, l.entityId));
    void sendPatches(key, patches);
    const out = targets.length - reachable.length;
    if (out) flash(`${what}: ${out} lamp${out === 1 ? "" : "s"} has no power`);
  };

  const togglePower = (key: string, targets: LampView[], what: string) => {
    const reachable = targets.filter((l) => l.reachable);
    if (!reachable.length) {
      flash(`Nothing reachable in ${what} — check the switches`);
      return;
    }
    const anyOn = reachable.some((l) => l.on);
    remember(what);
    void sendPatches(
      key,
      // Plain on, with no brightness or colour: the bulbs come back to whatever
      // they were last doing rather than being flattened to one value.
      reachable.map((l) => ({ entityId: l.entityId, on: !anyOn })),
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {state?.ok && state.unreachableCount > 0 && (
        <Banner>
          {state.unreachableCount === 1
            ? "1 lamp unreachable — check its switch."
            : `${state.unreachableCount} lamps unreachable — check their switches.`}
        </Banner>
      )}

      {/* The scenes worth reaching without changing tabs. Deliberately at the
          very top and deliberately small: this is a shortcut, not the scene
          list, and it should never out-shout the room it sits above. */}
      {spotlit.length > 0 && (
        <div className="flex gap-1.5">
          {spotlit.map((s) => (
            <button
              key={s.entityId}
              onClick={() => void applyScene(s)}
              disabled={pending === s.entityId}
              className="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 rounded-[var(--r-pill)] text-[12px] font-medium transition-all active:scale-95 disabled:opacity-50"
              style={{
                minHeight: 38,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                boxShadow: pending === s.entityId ? "var(--glow-accent)" : "none",
              }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: s.accent ?? "var(--accent)" }}
              />
              <span className="truncate">{s.label}</span>
            </button>
          ))}
        </div>
      )}

      {state?.ok && lamps.length === 0 && (
        <Empty
          title="No lamps paired yet."
          hint="Pair them in Zigbee2MQTT and they appear here."
        />
      )}

      {groups.map(({ room, lamps: inRoom }) => {
        const reachable = inRoom.filter((l) => l.reachable);
        const on = reachable.filter((l) => l.on).length;
        const busy = pending === room.id;

        return (
          <Section key={room.id} title={room.name}>
            <div
              className="rounded-[var(--r-md)] overflow-hidden"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
            >
              <div
                className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-2"
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                <span className="text-[12px] text-[var(--text-muted)]">
                  {on === 0 ? "All off" : `${on} of ${inRoom.length} on`}
                </span>
              </div>

              {/* The room as one thing: power, then the three looks. */}
              <div className="grid grid-cols-4 gap-1.5 p-2.5">
                <button
                  onClick={() => togglePower(room.id, inRoom, room.name)}
                  disabled={busy || !reachable.length}
                  className="flex items-center justify-center gap-1 rounded-[var(--r-sm)] text-[12px] font-medium disabled:opacity-35 active:scale-95 transition-transform"
                  style={{
                    minHeight: 44,
                    background: on ? "var(--neutral-bg)" : "var(--accent)",
                    color: on ? "var(--neutral-fg)" : "var(--text-on-accent)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <Power size={14} /> {on ? "Off" : "On"}
                </button>

                {LOOKS.map((look) => (
                  <button
                    key={look.id}
                    onClick={() => applyLook(room.id, inRoom, look.id, room.name)}
                    disabled={busy || !reachable.length}
                    className="flex items-center justify-center gap-1.5 rounded-[var(--r-sm)] text-[12px] font-medium disabled:opacity-35 active:scale-95 transition-transform"
                    style={{
                      minHeight: 44,
                      background: "var(--surface-sunken)",
                      color: "var(--text-secondary)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ background: look.css }}
                    />
                    {look.label}
                  </button>
                ))}
              </div>

              <div style={{ borderTop: "1px solid var(--border)" }}>
                {inRoom.map((lamp) => (
                  <LampRow
                    key={lamp.entityId}
                    lamp={lamp}
                    busy={pending === lamp.entityId}
                    onLook={(look) => applyLook(lamp.entityId, [lamp], look, lamp.name)}
                  />
                ))}
              </div>
            </div>
          </Section>
        );
      })}
    </div>
  );
}

/**
 * One bulb: what it is doing, a switch, and the same three looks.
 *
 * The switch is the fourth control. A separate Off button beside a switch that
 * already turns the lamp off is a dead target competing with a live one.
 */
function LampRow({
  lamp,
  busy,
  onLook,
}: {
  lamp: LampView;
  busy: boolean;
  onLook: (look: LookId) => void;
}) {
  const { setLamp } = useHouse();

  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1.5"
      style={{ opacity: lamp.reachable ? 1 : 0.6 }}
    >
      <button
        onClick={() => void setLamp(lamp, { on: !lamp.on })}
        disabled={!lamp.reachable || busy}
        aria-label={lamp.on ? `Turn off ${lamp.name}` : `Turn on ${lamp.name}`}
        className="shrink-0 active:scale-90 transition-transform"
        style={{
          minWidth: 40,
          // Lit bulbs carry their real colour, so the list reads at a glance.
          color: lamp.reachable && lamp.on ? lampCss(lamp) : "var(--text-muted)",
        }}
      >
        {!lamp.reachable ? (
          <WifiOff size={18} />
        ) : lamp.on ? (
          <Lightbulb size={18} />
        ) : (
          <LightbulbOff size={18} />
        )}
      </button>

      <div className="min-w-0 flex-1">
        {/* Never truncate a device name — wrap instead. */}
        <div className="text-[13px] leading-tight break-words">{lamp.name}</div>
        <div className="text-[11px] text-[var(--text-muted)] leading-tight">
          {!lamp.reachable
            ? "No power — check its switch"
            : lamp.on
              ? `${lamp.brightness ?? 100}%${lamp.kelvin && lamp.colorMode === "color_temp" ? ` · ${lamp.kelvin}K` : lamp.colorMode && lamp.colorMode !== "color_temp" ? " · colour" : ""}`
              : "Off"}
        </div>
      </div>

      <div className="flex gap-1 shrink-0">
        {LOOKS.map((look) => (
          <button
            key={look.id}
            onClick={() => onLook(look.id)}
            disabled={!lamp.reachable || busy}
            aria-label={`${look.label} on ${lamp.name}`}
            title={look.label}
            className="rounded-[var(--r-sm)] active:scale-90 transition-transform disabled:opacity-35"
            style={{
              width: 34,
              minHeight: 38,
              background: look.css,
              border: "1px solid var(--border-strong)",
            }}
          />
        ))}
      </div>
    </div>
  );
}
