"use client";

import { ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { isRoomId, roomOf, type RoomId } from "@/lib/rooms";
import { useHouse } from "./house";

/** A suggestion is only a shortcut to the ordinary, explicit scene action. */
export function SuggestedScene() {
  const { state, insights, pending, activateScene } = useHouse();
  if (!state?.ok || !insights) return null;
  const suggestion = insights.suggestions.find((item) =>
    (item.confidence === "medium" || item.confidence === "high") &&
    item.sampleCount >= 3 && state.scenes.some((scene) => scene.entityId === item.entityId),
  );
  const scene = state.scenes.find((item) => item.entityId === suggestion?.entityId);
  if (!suggestion || !scene) return null;

  return (
    <button
      className="history-suggestion"
      onClick={() => void activateScene(scene)}
      disabled={pending !== null}
      aria-label={`Apply suggested scene ${scene.label}. ${suggestion.reason}. Based on ${suggestion.sampleCount} recorded days, ${suggestion.confidence} confidence.`}
    >
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">Suggested · {scene.label}</span>
        <span className="block text-[11px] text-[var(--text-muted)] mt-0.5">
          {suggestion.reason} · {suggestion.confidence} confidence
        </span>
      </span>
      <ArrowUpRight size={16} className="shrink-0" aria-hidden />
    </button>
  );
}

/** Current claims require fresh HA reads; history supplies only the baseline. */
export function RoomHistoryNote({ room }: { room: RoomId }) {
  const { state, stateReadAt, insights, insightsReadAt, pending, lamps } = useHouse();
  const [, expire] = useState(0);
  const now = Date.now();
  const note = insights?.liveAvailable && insightsReadAt !== null && now - insightsReadAt <= 75_000 ? [...insights.anomalies]
    .sort((a, b) => Number(a.kind === "usually_off_by_now") - Number(b.kind === "usually_off_by_now"))
    .find((item) => {
      if (item.room !== room || item.sampleCount < 3 ||
          (item.confidence !== "medium" && item.confidence !== "high")) return false;
      const checkedAt = Date.parse(item.checkedAt);
      if (!Number.isFinite(checkedAt) || now - checkedAt > 75_000) return false;
      // Sensors are freshly read by /api/insights itself. House state only
      // contains lamps, so it must never masquerade as a sensor recheck.
      if (item.kind !== "usually_off_by_now") return true;
      if (!state?.ok || pending || stateReadAt === null || now - stateReadAt > 12_000) return false;
      const lamp = state.lamps.find((candidate) => candidate.entityId === item.entityId);
      return lamp?.reachable && lamp.on && lamps.some((candidate) => candidate.entityId === lamp.entityId && candidate.on) &&
        (isRoomId(lamp.room) ? lamp.room : roomOf(lamp.entityId)) === room;
    }) : undefined;
  // Expire the note even if the next live request stalls. Returning to the app
  // also rechecks time immediately, before the next HA response arrives.
  useEffect(() => {
    const check = () => expire((version) => version + 1);
    const deadline = note ? Math.min(Date.parse(note.checkedAt) + 75_001,
      insightsReadAt !== null ? insightsReadAt + 75_001 : Infinity,
      note.kind === "usually_off_by_now" && stateReadAt !== null ? stateReadAt + 12_001 : Infinity) : null;
    const timer = deadline === null ? null : setTimeout(check, Math.max(0, deadline - Date.now()));
    document.addEventListener("visibilitychange", check);
    return () => {
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [stateReadAt, insightsReadAt, note?.checkedAt, note?.kind]);
  if (!note) return null;
  const checkedTime = new Intl.DateTimeFormat(undefined, {
    hour: "numeric", minute: "2-digit", timeZone: insights?.timeZone,
  }).format(new Date(note.checkedAt));
  return (
    <p className="m-0 px-3 pb-2 text-[12px] text-[var(--text-secondary)]">
      {note.name} · {note.message}
      <span className="block text-[11px] text-[var(--text-muted)] mt-0.5">
        Checked {checkedTime} · {note.sampleCount} days · {note.confidence} confidence
      </span>
    </p>
  );
}
