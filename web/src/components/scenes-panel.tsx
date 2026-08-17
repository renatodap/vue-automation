"use client";

import { useRef, useState } from "react";
import { Pencil, Plus, Star } from "lucide-react";
import { postJson } from "@/lib/client";
import type { LampPatch, SceneView } from "@/lib/types";
import { patchFromLamp, useHouse } from "./house";
import { SceneEditor } from "./scene-editor";
import { Disconnected } from "./ui";

/** Hold a scene this long and it becomes a preview instead of a commitment. */
const PREVIEW_MS = 400;

/**
 * Scenes, and nothing else.
 *
 * The master lamp controls used to live here; they belong to a room, and Home
 * now has them per room. What is left is the one question this tab answers:
 * which scene, and what does it do.
 */
export function ScenesPanel() {
  const { state, lamps, pending, load, flash, act, remember } = useHouse();

  const [saving, setSaving] = useState(false);
  const [sceneName, setSceneName] = useState("");
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [editing, setEditing] = useState<SceneView | null>(null);
  /** What the room was before a preview started, so release puts it back. */
  const preview = useRef<{ entityId: string; patches: LampPatch[] } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
   * so "what does Bright look like" costs nothing and needs no decision.
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

  if (state && !state.ok) return <Disconnected message={state.message} onRetry={load} />;
  if (!state?.ok) return null;

  if (editing) {
    // Re-read from the live list so the editor sees a rename or a spotlight
    // change made on its own previous visit rather than a stale copy.
    const current = state.scenes.find((s) => s.entityId === editing.entityId) ?? editing;
    return (
      <SceneEditor
        scene={current}
        onBack={() => setEditing(null)}
        onChanged={() => void load()}
      />
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {state.scenes.map((s) => (
        <div key={s.entityId} className="relative">
          <button
            // Pointer events rather than onClick: a tap applies the scene, a
            // hold previews it and the release puts the room back. Capture so
            // the release is heard even if the thumb slid off the button.
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              startHold(s);
            }}
            onPointerUp={() => endHold(s)}
            onPointerCancel={() => endHold(s, false)}
            // Pointer events skip the keyboard entirely, and this is the app's
            // primary control — it has to work from a keyboard.
            onKeyUp={(e) => {
              if (e.key === "Enter" || e.key === " ") void activate(s);
            }}
            disabled={pending === s.entityId}
            className="w-full flex items-center gap-2 pl-3 rounded-[var(--r-md)] text-left transition-all active:scale-[0.97]"
            style={{
              minHeight: 56,
              paddingRight: 40,
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
            <span className="min-w-0">
              <span className="block text-[14px] font-medium leading-tight break-words">
                {s.label}
              </span>
              {s.spotlight && (
                <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] mt-0.5">
                  <Star size={10} fill="currentColor" /> On Home
                </span>
              )}
            </span>
          </button>

          {/* Opens the scene itself — rename, per-lamp settings, spotlight,
              delete. Separate from the card so a tap in the dark still just
              turns the lights on. */}
          <button
            onClick={() => setEditing(s)}
            aria-label={`Edit ${s.label}`}
            className="absolute top-0 right-0 flex items-center justify-center rounded-[var(--r-md)] text-[var(--text-muted)] active:scale-90 transition-transform"
            style={{ minHeight: 40, minWidth: 38 }}
          >
            <Pencil size={14} />
          </button>
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
            minHeight: 56,
            background: "transparent",
            border: "1px dashed var(--border-strong)",
            color: "var(--text-secondary)",
          }}
        >
          <Plus size={15} /> Save current
        </button>
      )}

      {state.scenes.length > 0 && (
        <p className="col-span-2 text-[12px] text-[var(--text-muted)] m-0 mt-1">
          Hold a scene to try it — the room goes back when you let go.
        </p>
      )}
    </div>
  );
}
