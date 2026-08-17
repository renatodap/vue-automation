"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  Lightbulb,
  LightbulbOff,
  Star,
  Trash2,
} from "lucide-react";
import { apiUrl, postJson } from "@/lib/client";
import { cssRgb, rgbFromHs, rgbFromKelvin } from "@/lib/light-color";
import type { SceneConfigResponse, SceneLampSetting, SceneView } from "@/lib/types";
import { useHouse } from "./house";
import { Controls, Disconnected, Section } from "./ui";

/**
 * Edit what a scene DOES, without touching the room.
 *
 * Everything here is a copy of the scene's stored definition, edited locally
 * and written on Save. Nothing is applied on the way through — you can rebuild
 * an evening scene at noon, and the lamps stay where they are until you tap it.
 *
 * Rendered in place of the scene grid rather than as an overlay. A fixed-
 * position sheet would be a second scrolling element and would detach from the
 * layout viewport, which is the thing iOS then moves on its own.
 */
export function SceneEditor({
  scene,
  onBack,
  onChanged,
}: {
  scene: SceneView;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { lamps, flash } = useHouse();

  const [name, setName] = useState(scene.label);
  const [rows, setRows] = useState<SceneLampSetting[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [spotlight, setSpotlight] = useState(scene.spotlight);

  const load = useCallback(async () => {
    if (!scene.id) {
      setError(
        "Home Assistant has no editable copy of this scene — it was written by hand in scenes.yaml.",
      );
      return;
    }
    setError(null);
    try {
      const response = await fetch(
        apiUrl(`/api/scene-config?id=${encodeURIComponent(scene.id)}`),
        { cache: "no-store" },
      );
      const data = (await response.json()) as SceneConfigResponse;
      if (!data.ok) {
        setError(data.message);
        return;
      }
      setRows(data.lamps);
      setName(data.name || scene.label);
    } catch {
      setError("Couldn't read that scene. Check the connection and try again.");
    }
  }, [scene.id, scene.label]);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = (entityId: string, patch: Partial<SceneLampSetting>) => {
    setDirty(true);
    setRows((prev) =>
      prev?.map((r) => (r.entityId === entityId ? { ...r, ...patch } : r)) ?? prev,
    );
  };

  const save = async () => {
    if (!rows || !scene.id) return;
    setBusy(true);
    try {
      await postJson("/api/scene-config", { id: scene.id, name: name.trim(), lamps: rows });
      setDirty(false);
      flash(`Saved ${name.trim()}`);
      onChanged();
    } catch (e) {
      flash(e instanceof Error ? e.message : "That didn't save");
    } finally {
      setBusy(false);
    }
  };

  const toggleSpotlight = async () => {
    const next = !spotlight;
    setSpotlight(next); // Optimistic; reverted below if the write is refused.
    try {
      await postJson("/api/scene-meta", { entityId: scene.entityId, spotlight: next });
      flash(next ? `${scene.label} is on Home` : `${scene.label} taken off Home`);
      onChanged();
    } catch (e) {
      setSpotlight(!next);
      flash(e instanceof Error ? e.message : "Couldn't save that");
    }
  };

  const remove = async () => {
    if (!scene.id) return;
    setBusy(true);
    try {
      const response = await fetch(
        apiUrl(
          `/api/scenes?id=${encodeURIComponent(scene.id)}&entityId=${encodeURIComponent(scene.entityId)}`,
        ),
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("Couldn't delete that scene");
      flash(`Deleted ${scene.label}`);
      onChanged();
      onBack();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Couldn't delete that scene");
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1">
        <button
          onClick={onBack}
          className="flex items-center gap-0.5 text-[14px] text-[var(--text-secondary)] shrink-0"
          style={{ minWidth: 44 }}
        >
          <ChevronLeft size={18} /> Scenes
        </button>
      </div>

      <label className="block">
        <span className="text-[12px] uppercase tracking-wide text-[var(--text-muted)]">
          Name
        </span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          aria-label="Scene name"
          className="mt-1"
          // Renaming here renames it in Home Assistant, so HomeKit, Siri and the
          // connector all follow. The definition is read and rewritten around
          // the new name rather than re-snapshotted, so nothing else moves.
          disabled={!scene.id}
        />
      </label>

      {error ? (
        <Disconnected message={error} onRetry={() => void load()} />
      ) : !rows ? (
        <p className="text-[13px] text-[var(--text-muted)]">Reading the scene…</p>
      ) : (
        <Section title={`Lamps in this scene (${rows.length})`}>
          <div className="flex flex-col gap-1.5">
            {rows.map((row) => {
              const live = lamps.find((l) => l.entityId === row.entityId);
              const isOpen = open === row.entityId;
              const swatch = row.hs
                ? cssRgb(rgbFromHs(row.hs[0], row.hs[1]))
                : cssRgb(rgbFromKelvin(row.kelvin ?? 2700));

              return (
                <div
                  key={row.entityId}
                  className="rounded-[var(--r-md)]"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <div className="flex items-center gap-2 px-2.5 py-1.5">
                    <button
                      onClick={() => edit(row.entityId, { on: !row.on })}
                      aria-label={
                        row.on
                          ? `${row.name} is on in this scene`
                          : `${row.name} is off in this scene`
                      }
                      className="shrink-0 active:scale-90 transition-transform"
                      style={{
                        minWidth: 40,
                        color: row.on ? swatch : "var(--text-muted)",
                      }}
                    >
                      {row.on ? <Lightbulb size={18} /> : <LightbulbOff size={18} />}
                    </button>

                    <button
                      onClick={() =>
                        setOpen((c) => (c === row.entityId ? null : row.entityId))
                      }
                      disabled={!row.on}
                      aria-expanded={isOpen}
                      className="min-w-0 flex-1 text-left disabled:cursor-default"
                      style={{ minHeight: 38 }}
                    >
                      <div className="text-[13px] leading-tight break-words">
                        {row.name}
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)] leading-tight">
                        {row.on
                          ? `${row.brightness}% · ${row.hs ? "colour" : `${row.kelvin ?? 2700}K`}`
                          : "Off in this scene"}
                      </div>
                    </button>

                    {row.on && (
                      <ChevronDown
                        size={15}
                        className="shrink-0 text-[var(--text-muted)] transition-transform"
                        style={{ transform: isOpen ? "rotate(180deg)" : "none" }}
                      />
                    )}
                  </div>

                  {isOpen && row.on && (
                    <div className="px-3 pb-3">
                      <Controls
                        idPrefix={`${row.name} in ${name}`}
                        brightness={row.brightness}
                        kelvin={row.kelvin ?? 2700}
                        // The bulb's own envelope when it is paired. A scene can
                        // outlive the bulb it names, and a missing one gets the
                        // widest safe range rather than a guess at its model.
                        minKelvin={live?.minKelvin ?? 2000}
                        maxKelvin={live?.maxKelvin ?? 6500}
                        hs={row.hs}
                        supportsColor={live?.supportsColor ?? true}
                        inColorMode={row.hs !== null}
                        onBrightness={(v) => edit(row.entityId, { brightness: v })}
                        // One colour key at a time, exactly as the wire format
                        // demands: setting a temperature clears the hue and the
                        // other way round, so the saved scene can't carry both.
                        onKelvin={(v) => edit(row.entityId, { kelvin: v, hs: null })}
                        onHs={(v) => edit(row.entityId, { hs: v, kelvin: null })}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {rows && (
        <button
          onClick={() => void save()}
          disabled={busy || !dirty || !name.trim()}
          className="rounded-[var(--r-md)] text-[15px] font-medium disabled:opacity-40"
          style={{
            minHeight: 48,
            background: "var(--accent)",
            color: "var(--text-on-accent)",
          }}
        >
          {dirty ? "Save changes" : "Saved"}
        </button>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => void toggleSpotlight()}
          className="flex items-center justify-center gap-1.5 rounded-[var(--r-md)] text-[13px] font-medium"
          style={{
            minHeight: 44,
            background: spotlight ? "var(--accent-subtle)" : "var(--surface)",
            color: spotlight ? "var(--accent)" : "var(--text-secondary)",
            border: `1px solid ${spotlight ? "var(--accent-border)" : "var(--border)"}`,
          }}
        >
          <Star size={15} fill={spotlight ? "currentColor" : "none"} />
          {spotlight ? "On Home" : "Spotlight"}
        </button>

        {confirmingDelete ? (
          <div className="flex gap-1.5">
            <button
              onClick={() => void remove()}
              disabled={busy}
              className="flex-1 rounded-[var(--r-md)] text-[13px] font-medium"
              style={{
                minHeight: 44,
                background: "var(--negative)",
                color: "var(--text-on-accent)",
              }}
            >
              Delete
            </button>
            <button
              onClick={() => setConfirmingDelete(false)}
              className="px-3 rounded-[var(--r-md)] text-[13px]"
              style={{ minHeight: 44, color: "var(--text-muted)" }}
            >
              No
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingDelete(true)}
            disabled={!scene.id}
            className="flex items-center justify-center gap-1.5 rounded-[var(--r-md)] text-[13px] font-medium disabled:opacity-35"
            style={{
              minHeight: 44,
              background: "var(--negative-bg)",
              color: "var(--negative)",
              border: "1px solid var(--border)",
            }}
          >
            <Trash2 size={15} /> Delete
          </button>
        )}
      </div>

      {!scene.id && (
        <p className="text-[12px] text-[var(--text-muted)] m-0">
          This scene has no Home Assistant id, so it can't be renamed, edited or
          deleted from here — only on the Pi.
        </p>
      )}
    </div>
  );
}
