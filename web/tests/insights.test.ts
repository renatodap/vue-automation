import test from "node:test";
import assert from "node:assert/strict";
import { buildInsights, climateProfiles, historicalOffEvidence, localTime, rankScenes, typicalTime, usagePatterns } from "../src/lib/insights";
import type { InsightsInput } from "../src/lib/history-query";
import type { ClimateHistoryEvent, HistoryEntity, LampHistoryEvent, SceneHistoryEvent } from "../src/lib/history-types";

const lamp: HistoryEntity = { entityId: "light.example", kind: "light", name: "Example", room: "living", unit: null };
const context = { source: "unknown" as const, contextId: null, contextParentId: null, contextUserId: null };
function light(at: string, state: string, entityId = lamp.entityId): LampHistoryEvent {
  return { ...context, at, state, entityId, brightness: null, kelvin: null, hs: null, xy: null, sceneId: null };
}
function input(overrides: Partial<InsightsInput> = {}): InsightsInput {
  return { meta: { start: "2026-10-01T00:00:00Z", end: "2026-11-03T23:59:59Z", timeZone: "UTC", generatedAt: "2026-11-03T22:00:00Z", sync: { status: "current", cursorAt: "2026-11-03T22:00:00Z", lastSuccessAt: "2026-11-03T22:00:00Z", lagSeconds: 0 }, coverage: { firstAt: null, lastAt: null, recorderStartAt: null, retentionDays: null, complete: false, gaps: [] } }, entities: [lamp], lamps: [], scenes: [], climate: [], ...overrides };
}
function weeklyLights(): LampHistoryEvent[] {
  return [light("2026-09-30T00:00:00Z", "off"), ...[6, 13, 20, 27].flatMap((day) => [light(`2026-10-${day.toString().padStart(2, "0")}T18:00:00Z`, "on"), light(`2026-10-${day.toString().padStart(2, "0")}T21:00:00Z`, "off")])];
}

test("local hours follow HA timezone and the repeated DST hour without inventing dates", () => {
  assert.deepEqual(localTime("2026-11-01T05:30:00Z", "America/New_York"), { date: "2026-11-01", weekday: 0, hour: 1, minute: 90 });
  assert.deepEqual(localTime("2026-11-01T06:30:00Z", "America/New_York"), { date: "2026-11-01", weekday: 0, hour: 1, minute: 90 });
  assert.equal(localTime("2026-11-03T02:00:00Z", "America/New_York").date, "2026-11-02");
});

test("sparse samples make no typical-time claim and times around midnight remain near midnight", () => {
  assert.equal(typicalTime([20, 30]).minute, null);
  const midnight = typicalTime([1435, 5, 0, 1438]);
  assert.ok(midnight.minute! < 10 || midnight.minute! > 1430);
  assert.equal(midnight.confidence, "medium");
  assert.equal(typicalTime([1, 2, 3, 4], 20).confidence, "low");
});

test("usage counts distinct switching days; snapshots, brightness updates and unavailable are not switches", () => {
  const data = input({ lamps: weeklyLights() });
  data.lamps.push(light("2026-10-06T18:05:00Z", "on"), light("2026-10-07T20:00:00Z", "unavailable"), light("2026-10-07T21:00:00Z", "off"));
  const result = usagePatterns(data);
  const tuesday = result.find((p) => p.scope === "lamp" && p.weekday === 2)!;
  assert.equal(tuesday.on.minute, 18 * 60);
  assert.equal(tuesday.on.sampleCount, 4);
  assert.equal(tuesday.off.minute, 21 * 60);
  assert.equal(result.find((p) => p.scope === "lamp" && p.weekday === 3)?.off.sampleCount, 0);
  assert.equal(result.find((p) => p.scope === "room" && p.weekday === 2)?.off.sampleCount, 4);
});

test("room turns off only when every known member is off; an unknown lamp prevents the claim", () => {
  const other = { ...lamp, entityId: "light.other", name: "Other" };
  const data = input({ entities: [lamp, other], lamps: weeklyLights() });
  assert.equal(usagePatterns(data).find((p) => p.scope === "room" && p.weekday === 2)?.off.sampleCount, 0);
  data.lamps.push(light("2026-09-30T00:00:00Z", "off", other.entityId));
  assert.equal(usagePatterns(data).find((p) => p.scope === "room" && p.weekday === 2)?.off.sampleCount, 4);
});

test("known ingestion gaps break switch continuity", () => {
  const data = input({ lamps: weeklyLights() });
  data.meta.coverage.gaps = [{ start: "2026-10-06T19:00:00Z", end: "2026-10-06T20:30:00Z", reason: "offline" }];
  assert.equal(usagePatterns(data).find((p) => p.scope === "lamp" && p.weekday === 2)?.off.sampleCount, 3);
});

test("usually-off anomalies require a fresh live on state; historical on and unavailable live never substitute", () => {
  const data = input({ lamps: weeklyLights() });
  const now = new Date("2026-11-03T22:00:00Z");
  const fresh = { checkedAt: now.toISOString(), states: [{ entity_id: lamp.entityId, state: "on", attributes: {} }] };
  assert.equal(buildInsights(data, fresh, now).anomalies.length, 1);
  assert.equal(buildInsights(data, null, now).anomalies.length, 0);
  assert.equal(buildInsights(data, { ...fresh, checkedAt: "2026-11-03T21:00:00Z" }, now).anomalies.length, 0);
  assert.equal(buildInsights(data, { ...fresh, states: [{ ...fresh.states[0], state: "unavailable" }] }, now).anomalies.length, 0);
  assert.equal(buildInsights(data, fresh, new Date("2026-11-03T22:00:31Z")).liveAvailable, false);
});

test("scene ranking retains unknown attribution and repeated taps on one date do not establish confidence", () => {
  const scene: SceneHistoryEvent = { ...context, entityId: "scene.warm", at: "2026-10-06T18:00:00Z", roomIds: [], origin: "recorder" };
  const data = input({ scenes: Array.from({ length: 20 }, (_, i) => ({ ...scene, at: `2026-10-06T18:${i.toString().padStart(2, "0")}:00Z` })) });
  const rank = rankScenes(data)[0];
  assert.equal(rank.count, 20);
  assert.equal(rank.observedDays, 1);
  assert.equal(rank.confidence, "insufficient");
  assert.deepEqual(rank.roomIds, []);
  assert.equal(data.scenes[0].source, "unknown");
  assert.equal(buildInsights(data, null).suggestions.length, 0);
});

function climate(at: string, temperatureC: number | null, state = "20"): ClimateHistoryEvent {
  return { ...context, at, entityId: "sensor.temp", state, temperatureC, humidity: null, targetTemperatureC: null, targetTemperatureLowC: null, targetTemperatureHighC: null };
}
test("climate profile weights each date/hour equally, excludes unavailable, and never fabricates absent sensors", () => {
  const sensor: HistoryEntity = { entityId: "sensor.temp", kind: "temperature", name: "Room temperature", room: "unassigned", unit: "°C" };
  const data = input({ entities: [sensor], climate: [climate("2026-10-01T10:00:00Z", 10), ...Array.from({ length: 20 }, (_, i) => climate(`2026-10-02T10:${String(i).padStart(2, "0")}:00Z`, 30)), climate("2026-10-03T10:00:00Z", 90, "unavailable")] });
  const profile = climateProfiles(data)[0];
  assert.equal(profile.mean, 20);
  assert.equal(profile.sampleCount, 2);
  assert.equal(profile.confidence, "insufficient");
  assert.equal(profile.room, "unassigned");
  assert.equal(buildInsights(input(), null).climateAvailability, "no_sensors");
  assert.deepEqual(buildInsights(input(), null).climate, []);
});

test("climate anomaly converts fresh Fahrenheit state and needs at least seven distinct historical days", () => {
  const sensor: HistoryEntity = { entityId: "sensor.temp", kind: "temperature", name: "Temperature", room: "living", unit: "°F" };
  const data = input({ entities: [sensor], climate: Array.from({ length: 7 }, (_, i) => climate(`2026-10-${String(i + 1).padStart(2, "0")}T10:00:00Z`, 20)) });
  const now = new Date("2026-11-03T10:00:00Z");
  const live = { checkedAt: now.toISOString(), states: [{ entity_id: sensor.entityId, state: "86", attributes: { unit_of_measurement: "°F" } }] };
  assert.equal(buildInsights(data, live, now).anomalies[0]?.kind, "temperature_outside_usual");
  data.climate.pop();
  assert.equal(buildInsights(data, live, now).anomalies.length, 0);
});


test("a repeated later-on interval defeats the daily off-time hint", () => {
  const rows = [light("2026-09-30T00:00:00Z", "off"), ...[6, 13, 20, 27].flatMap((day) => [
    light(`2026-10-${String(day).padStart(2, "0")}T18:00:00Z`, "on"),
    light(`2026-10-${String(day).padStart(2, "0")}T21:00:00Z`, "off"),
    light(`2026-10-${String(day).padStart(2, "0")}T21:30:00Z`, "on"),
    light(`2026-10-${String(day + 1).padStart(2, "0")}T00:30:00Z`, "off"),
  ])];
  const data = input({ lamps: rows });
  const now = new Date("2026-11-03T22:00:00Z");
  const current = localTime(now.toISOString(), "UTC");
  assert.deepEqual(historicalOffEvidence(data, lamp.entityId, current), { observedDays: 4, offDays: 0 });
  const live = { checkedAt: now.toISOString(), states: [{ entity_id: lamp.entityId, state: "on", attributes: {} }] };
  assert.equal(buildInsights(data, live, now).anomalies.length, 0);
  // The summarized 21:00 off-time still exists; it is insufficient alone.
  assert.equal(usagePatterns(data).find((p) => p.scope === "lamp" && p.weekday === 2)?.off.minute, 21 * 60);
});

test("usual-off evidence excludes unknown intervals, ingestion gaps, and today's partial history", () => {
  const data = input({ lamps: weeklyLights() });
  data.lamps.push(light("2026-10-06T21:30:00Z", "unknown"), light("2026-11-03T21:00:00Z", "off"));
  data.meta.coverage.gaps = [{ start: "2026-10-13T21:15:00Z", end: "2026-10-13T22:15:00Z", reason: "offline" }];
  const current = localTime("2026-11-03T22:00:00Z", "UTC");
  assert.deepEqual(historicalOffEvidence(data, lamp.entityId, current), { observedDays: 2, offDays: 2 });
  const live = { checkedAt: "2026-11-03T22:00:00Z", states: [{ entity_id: lamp.entityId, state: "on", attributes: {} }] };
  assert.equal(buildInsights(data, live, new Date(live.checkedAt)).anomalies.length, 0);
});
