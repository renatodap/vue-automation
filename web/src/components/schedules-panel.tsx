"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, Trash2 } from "lucide-react";
import { apiUrl, postJson } from "@/lib/client";
import type { AutomationView, AutomationsResponse, SceneView } from "@/lib/types";
import { useHouse } from "./house";
import { Chip, Disconnected, Empty, Section } from "./ui";

/**
 * Schedules — Home Assistant automations, listed and switched.
 *
 * Read from /api/automations rather than off the shared /api/state poll, and
 * deliberately not polled on a timer: a lamp changes under you, a schedule only
 * changes when somebody changes it. Re-reading it every six seconds would be
 * tailnet traffic answering a question nobody asked.
 */
export function SchedulesPanel() {
  const { state, flash } = useHouse();
  const [automations, setAutomations] = useState<AutomationsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/automations"), { cache: "no-store" });
      if (response.status === 401) {
        window.location.href = apiUrl("/login");
        return;
      }
      setAutomations((await response.json()) as AutomationsResponse);
    } catch {
      setAutomations({
        ok: false,
        reason: "unreachable",
        message: "No connection. Check that you're online.",
      });
    }
  }, []);

  // On mount and on every return to the app. A schedule created on another
  // device, or disabled in Home Assistant's own editor, should be here when you
  // come back — but nothing needs to watch for it second by second.
  useEffect(() => {
    void load();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [load]);

  /** Every mutation ends with a re-read: HA is the source of truth, not us. */
  const run = useCallback(
    async (key: string, action: () => Promise<void>, message?: string) => {
      setBusy(key);
      try {
        await action();
        if (message) flash(message);
      } catch (error) {
        flash(error instanceof Error ? error.message : "That didn't go through");
      } finally {
        setBusy(null);
        await load();
      }
    },
    [flash, load],
  );

  const toggle = (a: AutomationView) =>
    run(a.entityId, async () => {
      const response = await fetch(apiUrl("/api/automations"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId: a.entityId, enabled: !a.enabled }),
      });
      if (!response.ok) throw new Error("Couldn't change that schedule");
    });

  const remove = (a: AutomationView) => {
    if (!a.id) return Promise.resolve();
    return run(a.entityId, async () => {
      const response = await fetch(
        apiUrl(`/api/automations?id=${encodeURIComponent(a.id!)}`),
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("Couldn't delete that schedule");
      flash(`Deleted ${a.name}`);
    });
  };

  const create = (payload: Record<string, unknown>) =>
    run("new", async () => {
      await postJson("/api/automations", payload);
      setAdding(false);
      flash(`Scheduled: ${payload.name}`);
    });

  if (automations && !automations.ok) {
    return <Disconnected message={automations.message} onRetry={load} />;
  }

  const list = automations?.ok ? automations.automations : [];
  const scenes: SceneView[] = state?.ok ? state.scenes : [];
  const paused = list.filter((a) => !a.enabled).length;

  return (
    <Section
      title={automations ? `Schedules (${list.length})` : "Schedules"}
      action={
        paused > 0 ? (
          <span className="text-[12px]" style={{ color: "var(--warning)" }}>
            {paused} off
          </span>
        ) : null
      }
    >
      <div className="flex flex-col gap-2">
        {automations && list.length === 0 && (
          <Empty
            title="No schedules yet."
            hint="Lights at sunset, off at bedtime — that sort of thing."
          />
        )}

        {list.map((a) => (
          <div
            key={a.entityId}
            className="flex items-center gap-2.5 p-2.5 rounded-[var(--r-md)]"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
            }}
          >
            <button
              onClick={() => void toggle(a)}
              disabled={busy === a.entityId}
              role="switch"
              aria-checked={a.enabled}
              aria-label={`${a.enabled ? "Disable" : "Enable"} ${a.name}`}
              className="shrink-0 rounded-[var(--r-pill)] transition-colors"
              style={{
                width: 42,
                height: 26,
                minHeight: 26,
                padding: 3,
                background: a.enabled ? "var(--accent)" : "var(--neutral-bg)",
                border: a.enabled ? "none" : "1px solid var(--border-strong)",
              }}
            >
              <span
                className="block rounded-[var(--r-pill)] transition-transform"
                style={{
                  width: 20,
                  height: 20,
                  background: "var(--surface)",
                  transform: a.enabled ? "translateX(16px)" : "none",
                }}
              />
            </button>

            <div className="flex-1 min-w-0">
              <div
                className="text-[14px] break-words"
                style={{ color: a.enabled ? "var(--text-primary)" : "var(--text-secondary)" }}
              >
                {a.name}
              </div>
              {/* An automation whose state is "off" still exists — it simply
                  will not fire. Dimming the row to 55% made that look identical
                  to a row that was merely stale, so the distinction is written
                  out in words instead. */}
              <div
                className="text-[12px]"
                style={{ color: a.enabled ? "var(--positive)" : "var(--warning)" }}
              >
                {a.enabled ? "Enabled" : "Off — kept, but won't fire"}
              </div>
            </div>

            {a.id && (
              <button
                onClick={() => void remove(a)}
                disabled={busy === a.entityId}
                aria-label={`Delete ${a.name}`}
                className="shrink-0"
                style={{ minWidth: 34, color: "var(--text-muted)" }}
              >
                <Trash2 size={14} className="mx-auto" />
              </button>
            )}
          </div>
        ))}

        {adding ? (
          <ScheduleForm
            scenes={scenes}
            busy={busy === "new"}
            onCancel={() => setAdding(false)}
            onSave={(p) => void create(p)}
          />
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center justify-center gap-1.5 rounded-[var(--r-md)] text-[13px] font-medium"
            style={{
              minHeight: 44,
              border: "1px dashed var(--border-strong)",
              color: "var(--text-secondary)",
            }}
          >
            <Clock size={14} /> Add schedule
          </button>
        )}

        {list.some((a) => !a.id) && (
          <p className="text-[12px] text-[var(--text-muted)] m-0">
            Schedules without a delete button were hand-written in YAML without
            an <code>id</code>, so Home Assistant's API can't edit them.
          </p>
        )}
      </div>
    </Section>
  );
}

/**
 * Create a schedule.
 *
 * Sun triggers are offered first and default to sunset, because "at 6pm" is
 * wrong for most of the year — dark at 5pm in December, broad daylight at 8pm
 * in June. "At sunset" is what people mean, and HA already tracks it.
 */
function ScheduleForm({
  scenes,
  busy,
  onCancel,
  onSave,
}: {
  scenes: SceneView[];
  busy: boolean;
  onCancel: () => void;
  onSave: (payload: {
    name: string;
    when: "time" | "sunset" | "sunrise";
    time: string;
    offsetMinutes: number;
    doWhat: "scene" | "allOff";
    sceneEntityId?: string;
  }) => void;
}) {
  const [when, setWhen] = useState<"time" | "sunset" | "sunrise">("sunset");
  const [time, setTime] = useState("19:00");
  const [offset, setOffset] = useState(0);
  const [doWhat, setDoWhat] = useState<"scene" | "allOff">(
    scenes.length ? "scene" : "allOff",
  );
  const [sceneId, setSceneId] = useState(scenes[0]?.entityId ?? "");

  // A name nobody has to type. Most schedules are "<scene> at <when>", and
  // making the user invent a label is pure friction on the common path.
  const auto = (() => {
    const what =
      doWhat === "allOff"
        ? "All off"
        : (scenes.find((s) => s.entityId === sceneId)?.label ?? "Scene");
    const w =
      when === "time"
        ? `at ${time}`
        : offset === 0
          ? `at ${when}`
          : `${Math.abs(offset)}m ${offset < 0 ? "before" : "after"} ${when}`;
    return `${what} ${w}`;
  })();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          name: auto,
          when,
          time,
          offsetMinutes: offset,
          doWhat,
          sceneEntityId: doWhat === "scene" ? sceneId : undefined,
        });
      }}
      className="rounded-[var(--r-md)] p-3 flex flex-col gap-3"
      style={{ background: "var(--surface)", border: "1px solid var(--accent-border)" }}
    >
      <div>
        <div className="text-[12px] text-[var(--text-secondary)] mb-1.5">When</div>
        <div className="grid grid-cols-3 gap-1.5">
          {(["sunset", "sunrise", "time"] as const).map((w) => (
            <Chip key={w} active={when === w} onClick={() => setWhen(w)}>
              {w === "time" ? "Clock" : w[0].toUpperCase() + w.slice(1)}
            </Chip>
          ))}
        </div>
      </div>

      {when === "time" ? (
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          aria-label="Time"
          style={{ minHeight: 44 }}
        />
      ) : (
        <div className="grid grid-cols-3 gap-1.5">
          {[-30, 0, 30].map((o) => (
            <Chip key={o} active={offset === o} onClick={() => setOffset(o)}>
              {o === 0 ? "Exactly" : o < 0 ? "30m before" : "30m after"}
            </Chip>
          ))}
        </div>
      )}

      <div>
        <div className="text-[12px] text-[var(--text-secondary)] mb-1.5">Do</div>
        <div className="flex flex-col gap-1.5">
          {scenes.length > 0 && (
            <div className="flex gap-1.5">
              <Chip active={doWhat === "scene"} onClick={() => setDoWhat("scene")}>
                Apply scene
              </Chip>
              <Chip active={doWhat === "allOff"} onClick={() => setDoWhat("allOff")}>
                All off
              </Chip>
            </div>
          )}
          {doWhat === "scene" && scenes.length > 0 && (
            <select
              value={sceneId}
              onChange={(e) => setSceneId(e.target.value)}
              aria-label="Scene"
              className="rounded-[var(--r-md)] px-3"
              style={{
                minHeight: 44,
                // Under 16px iOS zooms the whole page on focus and never zooms
                // back. This outranks the type scale.
                fontSize: 16,
                background: "var(--surface-sunken)",
                border: "1px solid var(--border-strong)",
                color: "var(--text-primary)",
              }}
            >
              {scenes.map((s) => (
                <option key={s.entityId} value={s.entityId}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="text-[12px] text-[var(--text-muted)]">
        Will be saved as “{auto}”
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="flex-1 rounded-[var(--r-md)] text-[14px] font-medium disabled:opacity-40"
          style={{
            minHeight: 44,
            background: "var(--accent)",
            color: "var(--text-on-accent)",
          }}
        >
          Create schedule
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 text-[14px]"
          style={{ minHeight: 44, color: "var(--text-muted)" }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
