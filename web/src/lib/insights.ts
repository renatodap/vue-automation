import { ROOMS, type RoomId } from "./rooms";
import { celsius } from "./history-normalize";
import type { InsightsInput } from "./history-query";
import type { ClimateProfile, Confidence, HistoryAnomaly, HistoryEntity, InsightsResponse, LampHistoryEvent, SceneRanking, TypicalTime, UsagePattern } from "./history-types";

type LocalTime = { date: string; weekday: number; hour: number; minute: number };
const formatters = new Map<string, Intl.DateTimeFormat>();
export function localTime(at: string, timeZone: string): LocalTime {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, formatter);
  }
  const values = Object.fromEntries(formatter.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const hour = Number(values.hour);
  return { date: `${values.year}-${values.month}-${values.day}`, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday), hour, minute: hour * 60 + Number(values.minute) };
}
export function quantile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
const rounded = (n: number) => Math.round(n * 100) / 100;
const circularDistance = (a: number, b: number) => Math.abs(((a - b + 2160) % 1440) - 720);
const confidenceFor = (days: number): Confidence => days < 3 ? "insufficient" : days < 4 ? "low" : days < 8 ? "medium" : "high";

/** Local clock values near midnight belong together; 23:55 and 00:05 average to midnight. */
export function typicalTime(minutes: number[], expectedDays = minutes.length): TypicalTime {
  const count = minutes.length;
  if (count < 3) return { minute: null, sampleCount: count, observedDays: count, confidence: "insufficient" };
  const angle = Math.atan2(minutes.reduce((sum, m) => sum + Math.sin(m * Math.PI / 720), 0), minutes.reduce((sum, m) => sum + Math.cos(m * Math.PI / 720), 0));
  const anchor = ((angle * 720 / Math.PI) + 1440) % 1440;
  const unwrapped = minutes.map((m) => anchor + ((m - anchor + 2160) % 1440) - 720);
  const median = ((Math.round(quantile(unwrapped, .5)) % 1440) + 1440) % 1440;
  const spread = quantile(minutes.map((m) => circularDistance(m, median)), .75);
  const confidence = spread > 90 || count / Math.max(1, expectedDays) < .6 ? "low" : confidenceFor(count);
  return { minute: median, sampleCount: count, observedDays: count, confidence };
}

type DayUsage = { weekday: number; on: number | null; off: number | null };
function addUsage(days: Map<string, DayUsage>, at: string, state: string, timeZone: string) {
  const local = localTime(at, timeZone);
  const day = days.get(local.date) ?? { weekday: local.weekday, on: null, off: null };
  if (state === "on") day.on = day.on === null ? local.minute : Math.min(day.on, local.minute);
  if (state === "off") day.off = day.off === null ? local.minute : Math.max(day.off, local.minute);
  days.set(local.date, day);
}
function weekdayCounts(start: string, end: string, timeZone: string): number[] {
  const dates = new Map<string, number>();
  // Hour steps capture every date even across DST and partial boundary days.
  for (let at = Date.parse(start); at < Date.parse(end); at += 3_600_000) {
    const local = localTime(new Date(at).toISOString(), timeZone);
    dates.set(local.date, local.weekday);
  }
  const last = localTime(new Date(Date.parse(end) - 1).toISOString(), timeZone);
  dates.set(last.date, last.weekday);
  const counts = Array<number>(7).fill(0);
  for (const weekday of dates.values()) counts[weekday]++;
  return counts;
}
function patternsFor(days: Map<string, DayUsage>, identity: Pick<UsagePattern, "scope" | "entityId" | "room" | "name">, expectedDays: number[]): UsagePattern[] {
  return Array.from({ length: 7 }, (_, weekday) => {
    const matching = [...days.values()].filter((d) => d.weekday === weekday);
    return { ...identity, weekday, on: typicalTime(matching.flatMap((d) => d.on === null ? [] : [d.on]), expectedDays[weekday]), off: typicalTime(matching.flatMap((d) => d.off === null ? [] : [d.off]), expectedDays[weekday]) };
  });
}
export function usagePatterns(input: InsightsInput): UsagePattern[] {
  const { entities, meta } = input;
  const lamps = entities.filter((e) => e.kind === "light");
  const byId = new Map(lamps.map((e) => [e.entityId, e]));
  const state = new Map<string, string>();
  const lampDays = new Map<string, Map<string, DayUsage>>();
  const roomDays = new Map<RoomId, Map<string, DayUsage>>();
  const expectedDays = weekdayCounts(meta.start, meta.end, meta.timeZone);
  const start = Date.parse(meta.start), end = Date.parse(meta.end);
  const roomState = (room: RoomId): string => {
    const members = lamps.filter((e) => e.room === room);
    if (members.some((e) => state.get(e.entityId) === "on")) return "on";
    return members.length > 0 && members.every((e) => state.get(e.entityId) === "off") ? "off" : "unknown";
  };
  const rows = [...input.lamps].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.entityId.localeCompare(b.entityId));
  let previousAt = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < rows.length;) {
    const at = rows[index].at;
    const timestamp = Date.parse(at);
    // Missing observations break continuity; never infer a switch across a gap.
    if (meta.coverage.gaps.some((gap) => Date.parse(gap.start) <= timestamp && Date.parse(gap.end ?? meta.end) > previousAt)) state.clear();
    previousAt = timestamp;
    const batch: LampHistoryEvent[] = [];
    while (index < rows.length && rows[index].at === at) batch.push(rows[index++]);
    const roomBefore = new Map(ROOMS.map((room) => [room.id, roomState(room.id)]));
    for (const row of batch) {
      const entity = byId.get(row.entityId);
      if (!entity) continue;
      const previous = state.get(row.entityId);
      state.set(row.entityId, row.state);
      if (Date.parse(at) < start || Date.parse(at) >= end) continue;
      // Initial snapshots, reconnects, and attribute-only changes are not switch events.
      if ((previous === "on" && row.state === "off") || (previous === "off" && row.state === "on")) {
        const days = lampDays.get(row.entityId) ?? new Map<string, DayUsage>();
        addUsage(days, at, row.state, meta.timeZone);
        lampDays.set(row.entityId, days);
      }
    }
    if (Date.parse(at) < start || Date.parse(at) >= end) continue;
    for (const room of ROOMS) {
      const previous = roomBefore.get(room.id), current = roomState(room.id);
      if ((previous === "off" && current === "on") || (previous === "on" && current === "off")) {
        const days = roomDays.get(room.id) ?? new Map<string, DayUsage>();
        addUsage(days, at, current, meta.timeZone);
        roomDays.set(room.id, days);
      }
    }
  }
  return [
    ...lamps.flatMap((entity) => patternsFor(lampDays.get(entity.entityId) ?? new Map(), { scope: "lamp", entityId: entity.entityId, room: entity.room, name: entity.name }, expectedDays)),
    ...ROOMS.filter((room) => lamps.some((e) => e.room === room.id)).flatMap((room) => patternsFor(roomDays.get(room.id) ?? new Map(), { scope: "room", entityId: null, room: room.id, name: room.name }, expectedDays)),
  ];
}
export function timeOfDay(hour: number): SceneRanking["period"] {
  return hour < 6 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}
export function rankScenes(input: InsightsInput): SceneRanking[] {
  const groups = new Map<string, { entityId: string; period: SceneRanking["period"]; count: number; dates: Set<string>; rooms: Set<RoomId> }>();
  for (const row of input.scenes) {
    const local = localTime(row.at, input.meta.timeZone), period = timeOfDay(local.hour);
    const key = `${row.entityId}/${period}`;
    const group = groups.get(key) ?? { entityId: row.entityId, period, count: 0, dates: new Set<string>(), rooms: new Set<RoomId>() };
    group.count++; group.dates.add(local.date);
    row.roomIds.forEach((room) => group.rooms.add(room));
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => ({ entityId: g.entityId, name: input.entities.find((e) => e.entityId === g.entityId)?.name ?? g.entityId, period: g.period, count: g.count, observedDays: g.dates.size, confidence: confidenceFor(g.dates.size), roomIds: [...g.rooms].sort() })).sort((a, b) => b.count - a.count || a.entityId.localeCompare(b.entityId) || a.period.localeCompare(b.period));
}

/** Each date/hour gets equal weight, so a chatty sensor cannot inflate confidence. */
export function climateProfiles(input: InsightsInput): ClimateProfile[] {
  const entities = new Map(input.entities.map((e) => [e.entityId, e]));
  const byDay = new Map<string, { entity: HistoryEntity; hour: number; metric: "temperatureC" | "humidity"; date: string; values: number[] }>();
  for (const row of input.climate) {
    if (row.state === "unavailable" || row.state === "unknown") continue;
    const entity = entities.get(row.entityId);
    if (!entity) continue;
    const local = localTime(row.at, input.meta.timeZone);
    for (const metric of ["temperatureC", "humidity"] as const) {
      const value = row[metric];
      if (value === null || !Number.isFinite(value)) continue;
      const key = `${row.entityId}/${metric}/${local.date}/${local.hour}`;
      const group = byDay.get(key) ?? { entity, hour: local.hour, metric, date: local.date, values: [] };
      group.values.push(value); byDay.set(key, group);
    }
  }
  const groups = new Map<string, { entity: HistoryEntity; hour: number; metric: "temperatureC" | "humidity"; values: number[] }>();
  for (const day of byDay.values()) {
    const key = `${day.entity.entityId}/${day.metric}/${day.hour}`;
    const group = groups.get(key) ?? { entity: day.entity, hour: day.hour, metric: day.metric, values: [] };
    group.values.push(day.values.reduce((sum, v) => sum + v, 0) / day.values.length); groups.set(key, group);
  }
  return [...groups.values()].map((g) => ({ entityId: g.entity.entityId, name: g.entity.name, room: g.entity.room, hour: g.hour, metric: g.metric, mean: rounded(g.values.reduce((sum, v) => sum + v, 0) / g.values.length), low: rounded(quantile(g.values, .1)), high: rounded(quantile(g.values, .9)), sampleCount: g.values.length, observedDays: g.values.length, confidence: confidenceFor(g.values.length) })).sort((a, b) => a.entityId.localeCompare(b.entityId) || a.metric.localeCompare(b.metric) || a.hour - b.hour);
}
/**
 * Daily first-on/latest-off is a schedule summary, not an occupancy interval.
 * Require known historical state at today's local minute before saying "usually
 * off": a repeated later on-transition must defeat that claim. We deliberately
 * exclude today, unknown states, gaps, and days near a timezone offset change.
 */
export function historicalOffEvidence(input: InsightsInput, entityId: string, current: LocalTime): { observedDays: number; offDays: number } {
  const latest = new Map<string, { row: LampHistoryEvent; local: LocalTime }>();
  for (const row of input.lamps) {
    if (row.entityId !== entityId || Date.parse(row.at) < Date.parse(input.meta.start)) continue;
    const local = localTime(row.at, input.meta.timeZone);
    if (local.date >= current.date || local.weekday !== current.weekday || local.minute > current.minute) continue;
    const previous = latest.get(local.date);
    if (!previous || Date.parse(row.at) > Date.parse(previous.row.at)) latest.set(local.date, { row, local });
  }
  const offsetAt = (at: number): number => {
    const local = localTime(new Date(at).toISOString(), input.meta.timeZone);
    return Date.parse(`${local.date}T00:00:00Z`) + local.minute * 60_000 - Math.floor(at / 60_000) * 60_000;
  };
  let observedDays = 0, offDays = 0;
  for (const { row, local } of latest.values()) {
    if (row.state !== "on" && row.state !== "off") continue;
    const rowAt = Date.parse(row.at);
    const targetAt = rowAt + (current.minute - local.minute) * 60_000;
    if (targetAt >= Date.parse(input.meta.end)) continue;
    // Avoid ambiguous/nonexistent local times around DST rather than guessing
    // which repeated hour matches today's clock minute.
    if (offsetAt(targetAt - 36 * 3_600_000) !== offsetAt(targetAt + 36 * 3_600_000)) continue;
    if (input.meta.coverage.gaps.some((gap) => Date.parse(gap.start) <= targetAt && Date.parse(gap.end ?? input.meta.end) > rowAt)) continue;
    observedDays++;
    if (row.state === "off") offDays++;
  }
  return { observedDays, offDays };
}

export type LiveObservation = { checkedAt: string; states: { entity_id: string; state: string; attributes: Record<string, unknown> }[] };
const finite = (value: unknown): number | null => (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value)) ? Number(value) : null;
function liveMetric(state: LiveObservation["states"][number], entity: HistoryEntity, metric: ClimateProfile["metric"]): number | null {
  if (state.state === "unavailable" || state.state === "unknown") return null;
  let value: number | null;
  if (entity.kind === "climate") value = finite(state.attributes[metric === "temperatureC" ? "current_temperature" : "current_humidity"]);
  else if (entity.kind === "temperature" && metric === "temperatureC" || entity.kind === "humidity" && metric === "humidity") value = finite(state.state);
  else return null;
  if (value === null) return null;
  if (metric === "humidity") return value >= 0 && value <= 100 ? value : null;
  const unit = state.attributes.unit_of_measurement ?? entity.unit;
  return celsius(value, unit);
}

export function buildInsights(input: InsightsInput, live: LiveObservation | null, now = new Date()): Extract<InsightsResponse, { ok: true }> {
  const patterns = usagePatterns(input), scenes = rankScenes(input), climate = climateProfiles(input);
  const current = localTime(now.toISOString(), input.meta.timeZone);
  const fresh = live && Date.parse(live.checkedAt) <= now.getTime() && now.getTime() - Date.parse(live.checkedAt) <= 30_000 ? live : null;
  const states = new Map(fresh?.states.map((s) => [s.entity_id, s]) ?? []);
  const anomalies: HistoryAnomaly[] = [];
  if (fresh) {
    for (const pattern of patterns) {
      if (pattern.scope !== "lamp" || pattern.weekday !== current.weekday || !pattern.entityId || pattern.off.minute === null || !["medium", "high"].includes(pattern.off.confidence)) continue;
      const minutesSince = current.minute - pattern.off.minute;
      // A narrow two-hour window avoids calling a normal next-day/on period an anomaly.
      if (states.get(pattern.entityId)?.state !== "on" || minutesSince < 30 || minutesSince > 120) continue;
      if (pattern.on.minute !== null && pattern.on.minute > pattern.off.minute && current.minute >= pattern.on.minute) continue;
      const evidence = historicalOffEvidence(input, pattern.entityId, current);
      if (evidence.offDays < 4 || evidence.offDays / evidence.observedDays < .8) continue;
      const hhmm = `${String(Math.floor(pattern.off.minute / 60)).padStart(2, "0")}:${String(pattern.off.minute % 60).padStart(2, "0")}`;
      anomalies.push({ kind: "usually_off_by_now", entityId: pattern.entityId, name: pattern.name, room: pattern.room, message: `Usually off around ${hhmm} on this weekday; currently on.`, checkedAt: fresh.checkedAt, confidence: pattern.off.confidence, sampleCount: evidence.offDays });
    }
    for (const profile of climate) {
      if (profile.hour !== current.hour || profile.observedDays < 7) continue;
      const state = states.get(profile.entityId), entity = input.entities.find((e) => e.entityId === profile.entityId);
      if (!state || !entity) continue;
      const value = liveMetric(state, entity, profile.metric), margin = profile.metric === "temperatureC" ? 1.5 : 10;
      if (value === null || value >= profile.low - margin && value <= profile.high + margin) continue;
      const unit = profile.metric === "temperatureC" ? "°C" : "%";
      anomalies.push({ kind: profile.metric === "temperatureC" ? "temperature_outside_usual" : "humidity_outside_usual", entityId: profile.entityId, name: profile.name, room: profile.room, message: `${rounded(value)}${unit} now; the usual range at this hour is ${profile.low}–${profile.high}${unit}.`, checkedAt: fresh.checkedAt, confidence: profile.confidence, sampleCount: profile.sampleCount });
    }
  }
  const suggestions = scenes.filter((s) => s.period === timeOfDay(current.hour) && s.observedDays >= 3 && states.has(s.entityId)).slice(0, 3).map((s) => ({ entityId: s.entityId, name: s.name, roomIds: s.roomIds, reason: `Used ${s.count} times across ${s.observedDays} ${s.period === "night" ? "nights" : `${s.period}s`} in this history window.`, confidence: s.confidence, sampleCount: s.observedDays }));
  return { ...input.meta, ok: true, entities: input.entities, patterns, scenes, climate, anomalies, suggestions, liveAvailable: fresh !== null, checkedAt: fresh?.checkedAt ?? null, climateAvailability: !input.entities.some((e) => ["climate", "temperature", "humidity"].includes(e.kind)) ? "no_sensors" : input.climate.length ? "available" : "no_history" };
}
