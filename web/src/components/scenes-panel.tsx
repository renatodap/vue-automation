"use client";

import { useRef, useState } from "react";
import { Plus, Power, Sun, Trash2 } from "lucide-react";
import { apiUrl, postJson } from "@/lib/client";
import type { LampPatch, SceneView } from "@/lib/types";
import { patchFromLamp, useHouse } from "./house";
import { Banner, Controls, Disconnected, Section } from "./ui";

/** Hold a scene this long and it becomes a preview instead of a commitment. */
const PREVIEW_MS = 400;

/**
 * Scenes, and the master control over every lamp at once.
 *
 * Unchanged from the single-screen version of the app beyond being lifted into
 * its own tab: the scene grid, the edit-mode delete, save-current, and the
 * partial-application reporting all behave exactly as they did.
 */
export function ScenesPanel() {
  const {
    state,
    lamps,
    reachable,
    lit,
    pending,
    avgBrightness,
    avgKelvin,
    minKelvin,
    maxKelvin,
    masterHs,
    load,
    flash,
    act,
    remember,
    setAll,
  } = useHouse();

  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sceneName, setSceneName] = useState("");
  const [previewing, setPreviewing] = useState<string | null>(null);
  /** What the room was before a preview started, so release puts it back. */
  const preview = useRef<{ entityId: string; patches: LampPatch[] } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const anyOn = lit.length > 0;

  const activate = (scene: SceneView) => {
    // Snapshot before, not after: a scene is the most destructive single tap in
    // the app, and being able to take it back is what makes trying one cheap.
    remember(scene.label);
    return act(scene.entityId, async () => {
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
    });
  };

  /**
   * Press and hold to try a scene; release to put the room back.
   *
   * Non-committal exploration. Nothing is written that a release does not undo,
   * so "what does Cinema look like" costs nothing and needs no decision — which
   * is the difference between five scenes you know and five you never tap.
   */
  // Deliberately not memoized: both close over `lamps`, which changes on every
  // poll, and a stale closure here would snapshot a room from six seconds ago
  // and "restore" it on release.
  const startHold = (scene: SceneView) => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      const patches = lamps.filter((l) => l.reachable).map(patchFromLamp);
      if (!patches.length) return;
      preview.current = { entityId: scene.entityId, patches };
      setPreviewing(scene.entityId);
      navigator.vibrate?.(8);
      void postJson("/api/scene", { entityId: scene.entityId })
        .then(() => load())
        .catch(() => {});
    }, PREVIEW_MS);
  };

  const endHold = (scene: SceneView, apply = true) => {
    if (holdTimer.current) {
      // Released before the hold matured: an ordinary tap, applied for real.
      // Unless the gesture was cancelled out from under us — the browser taking
      // the pointer away is not somebody asking for a scene.
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
      if (apply) void activate(scene);
      return;
    }
    const held = preview.current;
    preview.current = null;
    setPreviewing(null);
    if (!held) return;
    void postJson("/api/light", { patches: held.patches })
      .then(() => load())
      .catch(() => flash("Couldn't put the room back — try Undo"));
  };

  const saveCurrent = () =>
    act("save", async () => {
      const r = await postJson<{ captured: number }>("/api/scenes", {
        name: sceneName.trim(),
      });
      setSaving(false);
      setSceneName("");
      flash(`Saved "${sceneName.trim()}" — ${r.captured} lamps captured`);
    });

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

  if (state && !state.ok) return <Disconnected message={state.message} onRetry={load} />;
  if (!state?.ok) return null;

  return (
    <div className="panels">
      <div className="flex flex-col gap-4 min-w-0">
        {state.unreachableCount > 0 && (
          <Banner>
            {state.unreachableCount === 1
              ? "1 lamp unreachable — check its switch."
              : `${state.unreachableCount} lamps unreachable — check their switches.`}
          </Banner>
        )}

        <Section
          title="Scenes"
          action={
            state.scenes.some((s) => s.id) && !saving ? (
              <button
                onClick={() => setEditing((v) => !v)}
                className="text-[12px] font-medium px-2 rounded-[var(--r-sm)]"
                style={{
                  minHeight: 28,
                  color: editing ? "var(--accent)" : "var(--text-muted)",
                  background: editing ? "var(--accent-subtle)" : "transparent",
                }}
              >
                {editing ? "Done" : "Edit"}
              </button>
            ) : null
          }
        >
          <div className="grid grid-cols-2 gap-2">
            {state.scenes.map((s) => (
              <div key={s.entityId} className="relative">
                <button
                  // Pointer events rather than onClick: a tap applies the
                  // scene, a hold previews it and the release puts the room
                  // back. Capture so the release is heard even if the thumb
                  // slid off the button.
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    startHold(s);
                  }}
                  onPointerUp={() => endHold(s)}
                  onPointerCancel={() => endHold(s, false)}
                  // Pointer events skip the keyboard entirely, and this is the
                  // app's primary control — it has to work from a keyboard.
                  onKeyUp={(e) => {
                    if (e.key === "Enter" || e.key === " ") void activate(s);
                  }}
                  disabled={pending === s.entityId}
                  className="w-full flex items-center gap-2 px-3 rounded-[var(--r-md)] text-left transition-all active:scale-[0.97]"
                  style={{
                    minHeight: 52,
                    paddingRight: editing ? 34 : 12,
                    background: "var(--surface)",
                    border: `1px solid ${previewing === s.entityId ? "var(--accent)" : "var(--border)"}`,
                    boxShadow:
                      pending === s.entityId || previewing === s.entityId
                        ? "var(--glow-accent)"
                        : "none",
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
          </div>

          {state.scenes.length > 0 && (
            <p className="text-[12px] text-[var(--text-muted)] m-0 mt-2">
              Hold a scene to try it — the room goes back when you let go.
            </p>
          )}
        </Section>
      </div>

      {/* Master. This is the section that removes the most work: warming or
          dimming the whole room used to mean opening four lamps. */}
      <div className="min-w-0">
        <Section title="All lamps">
          <div
            className="rounded-[var(--r-md)] p-3 flex flex-col gap-3.5"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
          >
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => {
                  remember("all lamps");
                  void setAll({ on: true, brightness: avgBrightness });
                }}
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
                onClick={() => {
                  remember("all lamps");
                  void setAll({ on: false });
                }}
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
              // These are the absolute masters — every lamp to one value. They
              // flatten a scene by design, which is exactly why each one arms
              // undo before it fires.
              onBrightness={(v) => {
                remember("all lamps");
                void setAll({ brightness: v });
              }}
              onKelvin={(v) => {
                remember("all lamps");
                void setAll({ kelvin: v });
              }}
              onHs={(v) => {
                remember("all lamps");
                void setAll({ hs: v });
              }}
            />
          </div>
        </Section>

        {lamps.length === 0 && (
          <p className="text-[12px] text-[var(--text-muted)] mt-2">
            No lamps paired yet — pair them in Zigbee2MQTT and they appear here.
          </p>
        )}
      </div>
    </div>
  );
}
