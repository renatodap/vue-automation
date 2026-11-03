"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, LayoutGrid, Lightbulb, LightbulbOff, RefreshCw, WifiOff } from "lucide-react";
import { apiUrl } from "@/lib/client";
import type {
  ClimateHistoryEvent,
  HistoryEntity,
  HistoryFailure,
  HistoryMeta,
  HistoryPage,
  LampHistoryEvent,
  SceneHistoryEvent,
} from "@/lib/history-types";
import { ROOMS, type RoomId } from "@/lib/rooms";
import { useHouse } from "./house";
import { Banner, Empty, Section } from "./ui";

const DAY_MS = 86_400_000;
type TimedEvent = { entityId: string; at: string };

/** Pages are explicit: neither a busy lamp nor a sensor silently loses rows. */
function useHistoryPage<T extends TimedEvent>(kind: "lamps" | "scenes" | "climate", query: string) {
  const [page, setPage] = useState<HistoryPage<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const request = useRef<AbortController | null>(null);

  const read = useCallback(async (cursor?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams(query);
      params.set("limit", kind === "climate" ? "1000" : "100");
      if (kind === "lamps") params.set("transitions_only", "true");
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(apiUrl(`/api/history/${kind}?${params}`), {
        cache: "no-store", signal: controller.signal,
      });
      if (response.status === 401) {
        window.location.href = apiUrl("/login");
        return;
      }
      const data = (await response.json()) as HistoryPage<T> | HistoryFailure;
      if (!data.ok) throw new Error(data.message);
      if (!response.ok) throw new Error("History is unavailable. Try again shortly.");
      if (controller.signal.aborted) return;
      setPage((previous) => {
        if (!cursor || !previous) return data;
        const rows = new Map(previous.rows.map((row) => [`${row.entityId}:${row.at}`, row]));
        for (const row of data.rows) rows.set(`${row.entityId}:${row.at}`, row);
        return { ...data, rows: [...rows.values()] };
      });
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error && cause.message !== "Failed to fetch"
          ? cause.message : "History is unavailable. Check your connection and try again.");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [kind, query]);

  useEffect(() => {
    void read();
    return () => request.current?.abort();
  }, [read]);

  return { page, error, loading, reload: () => read(), more: () => page?.nextCursor ? read(page.nextCursor) : Promise.resolve() };
}

export function HistoryPanel() {
  const [period, setPeriod] = useState<1 | 7>(1);
  const [room, setRoom] = useState<RoomId | "all">("all");
  const [anchor, setAnchor] = useState(() => Date.now());
  const [offset, setOffset] = useState(0);
  const end = new Date(anchor - offset * period * DAY_MS).toISOString();
  const start = new Date(anchor - (offset + 1) * period * DAY_MS).toISOString();
  const params = new URLSearchParams({ start, end });
  if (room !== "all") params.set("room_id", room);
  const query = params.toString();

  return (
    <div className="history-view">
      <div className="history-filters">
        <label className="history-room-label">
          <span className="sr-only">Room</span>
          <select value={room} onChange={(event) => setRoom(event.target.value as RoomId | "all")}>
            <option value="all">All rooms</option>
            {ROOMS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <div className="history-period" aria-label="History period">
          {([1, 7] as const).map((days) => (
            <button key={days} aria-pressed={period === days} onClick={() => {
              setPeriod(days); setOffset(0); setAnchor(Date.now());
            }}>{days === 1 ? "Day" : "Week"}</button>
          ))}
        </div>
      </div>
      <div className="history-range">
        <button aria-label={`Previous ${period === 1 ? "day" : "week"}`} onClick={() => setOffset((value) => value + 1)}><ChevronLeft size={18} aria-hidden /></button>
        <span className="text-[13px] text-[var(--text-secondary)]">
          {offset === 0 ? `Past ${period === 1 ? "24 hours" : "7 days"}` : `${offset} ${period === 1 ? (offset === 1 ? "day" : "days") : (offset === 1 ? "week" : "weeks")} earlier`}
        </span>
        <button aria-label={`Next ${period === 1 ? "day" : "week"}`} disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 1))}><ChevronRight size={18} aria-hidden /></button>
        <button className="history-refresh" aria-label="Refresh history" onClick={() => setAnchor(Date.now())}><RefreshCw size={15} aria-hidden /></button>
      </div>
      <HistoryContents key={query} query={query} period={period} room={room} />
    </div>
  );
}

function HistoryContents({ query, period, room }: { query: string; period: 1 | 7; room: RoomId | "all" }) {
  const { state } = useHouse();
  const lamps = useHistoryPage<LampHistoryEvent>("lamps", query);
  const scenes = useHistoryPage<SceneHistoryEvent>("scenes", query);
  const climate = useHistoryPage<ClimateHistoryEvent>("climate", query);
  const meta = lamps.page ?? scenes.page ?? climate.page;
  const timelineLoading = lamps.loading || scenes.loading;
  const timelineMore = Boolean(lamps.page?.nextCursor || scenes.page?.nextCursor);
  const timelineError = lamps.error ?? scenes.error;

  const entities = useMemo(() => new Map(
    [...(lamps.page?.entities ?? []), ...(scenes.page?.entities ?? [])].map((entity) => [entity.entityId, entity]),
  ), [lamps.page?.entities, scenes.page?.entities]);
  const events = useMemo(() => {
    // Each stream pages independently. Hold older rows behind the unfinished
    // stream's frontier so a busy lamp cannot leave invisible holes between
    // two already-loaded scenes in what looks like a continuous timeline.
    const frontiers = [lamps.page, scenes.page].flatMap((page) =>
      page?.nextCursor && page.rows.length
        ? [page.rows.reduce((oldest, row) => Math.min(oldest, Date.parse(row.at)), Infinity)] : [],
    );
    const frontier = frontiers.length ? Math.max(...frontiers) : -Infinity;
    return [
      ...(lamps.page?.rows ?? []).map((row) => ({ kind: "lamp" as const, row })),
      ...(scenes.page?.rows ?? []).map((row) => ({ kind: "scene" as const, row })),
    ].filter((event) => Date.parse(event.row.at) >= frontier)
      .sort((a, b) => Date.parse(b.row.at) - Date.parse(a.row.at) || a.row.entityId.localeCompare(b.row.entityId));
  }, [lamps.page, scenes.page]);

  return (
    <>
      {state && !state.ok && <Banner>Live Home Assistant is unavailable. This view shows recorded history.</Banner>}
      {meta && <HistoryStatus meta={meta} />}
      {meta && meta.coverage.gaps.length > 0 && <Banner>{meta.coverage.gaps.length === 1 ? "A collection gap overlaps this period." : `${meta.coverage.gaps.length} collection gaps overlap this period.`} Some events may be missing.</Banner>}
      <div className="history-columns">
        <Section title="Room temperature">
          {climate.page ? (
            <TemperatureChart page={climate.page} period={period} room={room} />
          ) : climate.loading ? <HistoryLoading label="Loading temperature history…" /> : null}
          {climate.error && <HistoryError message={climate.error} retry={climate.reload} />}
          {climate.page?.nextCursor && (
            <div className="history-pagination">
              <p>Chart shows {climate.page.rows.length.toLocaleString()} loaded readings. More are available.</p>
              <button disabled={climate.loading} onClick={() => void climate.more()}>{climate.loading ? "Loading…" : "Load more readings"}</button>
            </div>
          )}
        </Section>
        <Section title="Lights & scenes">
          {events.length > 0 ? (
            <ol className="history-timeline">
              {events.map((event, index) => {
                const timeZone = meta?.timeZone ?? "UTC";
                const date = formatTime(event.row.at, timeZone, { month: "short", day: "numeric", weekday: "short" });
                const previous = index > 0 ? formatTime(events[index - 1].row.at, timeZone, { month: "short", day: "numeric", weekday: "short" }) : null;
                return <TimelineEvent key={`${event.kind}:${event.row.entityId}:${event.row.at}`} event={event} entity={entities.get(event.row.entityId)} timeZone={timeZone} heading={date !== previous ? date : null} showRoom={room === "all"} />;
              })}
            </ol>
          ) : timelineLoading ? <HistoryLoading label="Loading lights and scenes…" /> : !timelineError ? (
            <Empty title="No recorded events in this period." hint="A gap in history does not mean the lights were off." />
          ) : null}
          {timelineError && <HistoryError message={timelineError} retry={() => Promise.all([lamps.reload(), scenes.reload()])} />}
          {timelineMore && (
            <div className="history-pagination">
              <p>{events.length.toLocaleString()} observations loaded. More are available.</p>
              <button disabled={timelineLoading} onClick={() => void Promise.all([lamps.more(), scenes.more()])}>{timelineLoading ? "Loading…" : "Load more events"}</button>
            </div>
          )}
        </Section>
      </div>
      {meta && <HistoryDetails meta={meta} />}
    </>
  );
}

function HistoryStatus({ meta }: { meta: HistoryMeta }) {
  if (meta.sync.status === "current") return null;
  const last = meta.sync.lastSuccessAt
    ? ` Last synced ${formatTime(meta.sync.lastSuccessAt, meta.timeZone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`
    : " No successful sync yet.";
  return <Banner>{meta.sync.status === "pending" ? "History is still being collected." : "History sync is delayed; recent events may be missing."}{last}</Banner>;
}

function HistoryDetails({ meta }: { meta: HistoryMeta }) {
  return (
    <details className="history-details">
      <summary>About this history</summary>
      <p>{formatTime(meta.start, meta.timeZone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} – {formatTime(meta.end, meta.timeZone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {meta.timeZone}</p>
      <p>Recorded observations, not current device state. Missing events do not prove a lamp was off or a temperature stayed constant. Context labels describe Home Assistant metadata; they do not identify a person or prove every lamp received a scene.</p>
      <p>{meta.coverage.retentionDays !== null ? `Home Assistant retains about ${meta.coverage.retentionDays} days of recorder history.` : "Home Assistant’s recorder retention is not known."} {meta.coverage.recorderStartAt ? `Recorder coverage starts ${formatTime(meta.coverage.recorderStartAt, meta.timeZone, { month: "short", day: "numeric", year: "numeric" })}.` : "The start of recorder coverage is not known."} Older events that were never collected cannot be recovered here.</p>
      <p>{meta.sync.lastSuccessAt ? `Last successful sync: ${formatTime(meta.sync.lastSuccessAt, meta.timeZone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.` : "No successful sync recorded."}</p>
      {meta.coverage.gaps.map((gap, index) => <p key={`${gap.start}:${index}`}>Collection gap: {formatTime(gap.start, meta.timeZone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} – {gap.end ? formatTime(gap.end, meta.timeZone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "ongoing"}.</p>)}
    </details>
  );
}

type TimelineItem = { kind: "lamp"; row: LampHistoryEvent } | { kind: "scene"; row: SceneHistoryEvent };

function TimelineEvent({ event, entity, timeZone, heading, showRoom }: {
  event: TimelineItem; entity?: HistoryEntity; timeZone: string; heading: string | null; showRoom: boolean;
}) {
  const name = entity?.name ?? event.row.entityId;
  const lamp = event.kind === "lamp" ? event.row : null;
  const scene = event.kind === "scene" ? event.row : null;
  const on = lamp?.state === "on";
  const unavailable = lamp?.state === "unavailable" || lamp?.state === "unknown";
  const Icon = scene ? LayoutGrid : unavailable ? WifiOff : on ? Lightbulb : LightbulbOff;
  const source = { user: "User context", automation: "Automation context", scene: "Scene context", unknown: "Source unknown" }[event.row.source];
  const rooms = scene ? scene.roomIds.map(roomName).join(", ") || "Room not recorded" : roomName(entity?.room ?? "unassigned");
  const description = scene ? (scene.origin === "legacy_tap" ? "App tap recorded" : "Scene activated")
    : lamp?.state === "on" ? `On${lamp.brightness !== null ? ` · ${Math.round(lamp.brightness / 255 * 100)}%` : ""}`
    : lamp?.state === "off" ? "Off" : unavailable ? "Unavailable" : lamp?.state ?? "State not recorded";
  return (
    <li>
      {heading && <h3 className="history-date">{heading}</h3>}
      <div className="history-event">
        <span className="history-event-icon" style={{ color: on || scene ? "var(--accent)" : "var(--text-muted)" }}><Icon size={16} aria-hidden /></span>
        <div className="min-w-0">
          <div className="text-[13px] font-medium break-words">{name}</div>
          <div className="text-[12px] text-[var(--text-secondary)]">{description}</div>
          <div className="text-[11px] text-[var(--text-muted)] break-words">{showRoom ? `${rooms} · ` : ""}{source}</div>
        </div>
        <time className="history-event-time" dateTime={event.row.at} title={formatTime(event.row.at, timeZone, { dateStyle: "full", timeStyle: "long" })}>{formatTime(event.row.at, timeZone, { hour: "numeric", minute: "2-digit" })}</time>
      </div>
    </li>
  );
}

function TemperatureChart({ page, period, room }: { page: HistoryPage<ClimateHistoryEvent>; period: 1 | 7; room: RoomId | "all" }) {
  const [selected, setSelected] = useState("");
  const chartId = useId();
  const sensors = page.entities.filter((entity) => entity.kind === "temperature" || entity.kind === "climate");
  const entity = sensors.find((sensor) => sensor.entityId === selected)
    ?? sensors.find((sensor) => page.rows.some((row) => row.entityId === sensor.entityId && row.temperatureC !== null))
    ?? sensors[0];
  const readings = useMemo(() => page.rows.filter((row) => row.entityId === entity?.entityId)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), [page.rows, entity?.entityId]);
  const hasTemperature = (row: ClimateHistoryEvent): row is ClimateHistoryEvent & { temperatureC: number } =>
    row.state !== "unavailable" && row.state !== "unknown" && row.temperatureC !== null && Number.isFinite(row.temperatureC);
  const values = readings.flatMap((row) => hasTemperature(row) ? [row.temperatureC] : []);

  if (page.availability === "no_sensors" || sensors.length === 0) {
    return <Empty title={room === "all" ? "No temperature sensor found." : "No temperature sensor in this room."} hint="A temperature sensor or thermostat in Home Assistant is needed to chart room temperature." />;
  }
  const low = values.length ? values.reduce((min, value) => Math.min(min, value), Infinity) : 0;
  const high = values.length ? values.reduce((max, value) => Math.max(max, value), -Infinity) : 0;
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const floor = Math.floor((low - 0.5) * 2) / 2;
  const ceiling = Math.ceil((high + 0.5) * 2) / 2;
  const start = Date.parse(page.start);
  const end = Date.parse(page.end);
  const x = (at: string) => 42 + (Date.parse(at) - start) / Math.max(1, end - start) * 310;
  const y = (value: number) => 156 - (value - floor) / Math.max(1, ceiling - floor) * 130;
  const segments: string[][] = [];
  const points: { x: number; y: number }[] = [];
  let segment: string[] = [];
  let previousAt: number | null = null;
  for (const row of readings) {
    const at = Date.parse(row.at);
    const crossesGap = previousAt !== null && page.coverage.gaps.some((gap) =>
      Date.parse(gap.start) <= at && Date.parse(gap.end ?? page.end) > previousAt!,
    );
    if (!hasTemperature(row) || crossesGap || (previousAt !== null && at - previousAt > 90 * 60_000)) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (hasTemperature(row)) {
      const point = { x: x(row.at), y: y(row.temperatureC) };
      segment.push(`${point.x.toFixed(2)},${point.y.toFixed(2)}`);
      points.push(point);
    }
    previousAt = at;
  }
  if (segment.length) segments.push(segment);

  return (
    <div className="history-chart-card">
      {sensors.length > 1 ? <label className="block mb-3"><span className="sr-only">Temperature sensor</span><select className="history-sensor" value={entity?.entityId ?? ""} onChange={(event) => setSelected(event.target.value)}>{sensors.map((sensor) => <option key={sensor.entityId} value={sensor.entityId}>{sensor.name}</option>)}</select></label>
        : <p className="text-[13px] font-medium m-0">{entity?.name}</p>}
      {!values.length ? <p className="text-[13px] text-[var(--text-muted)] my-5">{page.nextCursor ? "No temperature readings loaded for this sensor yet. More readings are available below." : "No temperature readings recorded in this period."}</p> : (
        <>
          <p className="history-chart-summary"><strong>{low.toFixed(1)}–{high.toFixed(1)}°C</strong><span>Average {average.toFixed(1)}°C</span></p>
          <svg viewBox="0 0 370 198" className="history-chart" role="img" aria-labelledby={`${chartId}-title ${chartId}-description`}>
            <title id={`${chartId}-title`}>{entity?.name}: recorded temperature over {period === 1 ? "24 hours" : "7 days"}</title>
            <desc id={`${chartId}-description`}>{values.length} readings between {low.toFixed(1)} and {high.toFixed(1)} degrees Celsius; average {average.toFixed(1)}. Dots are recorded readings. Lines connect readings at most 90 minutes apart; gaps are not filled.{page.nextCursor ? " More readings are available to load." : ""}</desc>
            {[floor, (floor + ceiling) / 2, ceiling].map((value) => <g key={value}><line x1="42" x2="352" y1={y(value)} y2={y(value)} stroke="var(--border)" /><text x="34" y={y(value) + 4} textAnchor="end">{value.toFixed(1)}°</text></g>)}
            {segments.map((items, index) => <polyline key={index} points={items.join(" ")} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />)}
            {points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={points.length > 300 ? 1.2 : 2.2} fill="var(--accent)" />)}
            {[start, (start + end) / 2, end].map((at, index) => <text key={at} x={42 + index * 155} y="184" textAnchor={index === 0 ? "start" : index === 2 ? "end" : "middle"}>{formatTime(new Date(at).toISOString(), page.timeZone, period === 1 ? { hour: "numeric" } : { month: "short", day: "numeric" })}</text>)}
          </svg>
          <p className="text-[11px] text-[var(--text-muted)] m-0">{values.length.toLocaleString()} recorded readings · °C · gaps are not filled</p>
        </>
      )}
    </div>
  );
}

function HistoryLoading({ label }: { label: string }) {
  return <p role="status" className="history-loading">{label}</p>;
}

function HistoryError({ message, retry }: { message: string; retry: () => Promise<unknown> }) {
  return <div className="history-error" role="status"><p>{message}</p><button onClick={() => void retry()}>Try again</button></div>;
}

function roomName(room: RoomId) { return ROOMS.find((item) => item.id === room)?.name ?? "Unassigned"; }

function formatTime(at: string, timeZone: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(new Date(at));
}
