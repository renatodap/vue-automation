import test from "node:test";
import assert from "node:assert/strict";
import { HistoryQueryError, historyCursor, isHistoryInstant, parseHistoryQuery, parseInsightsQuery } from "../src/lib/history-params";

test("history query has bounded explicit instants and strict pagination", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  const query = parseHistoryQuery(new URLSearchParams(), now);
  assert.equal(query.start, "2026-10-27T12:00:00.000Z");
  assert.equal(query.end, now.toISOString());
  assert.equal(query.limit, 500);
  assert.equal(query.transitionsOnly, false);
  assert.equal(parseHistoryQuery(new URLSearchParams("transitions_only=true"), now).transitionsOnly, true);
  for (const search of ["transitions_only=1", "limit=0", "limit=1001", "limit=1.5", "room=kitchen", "room=living&room_id=bedroom", "entity_id=light.example%27", "start=2026-10-01T00:00:00Z&end=2026-11-03T00:00:00Z", "start=2026-11-03T00:00:00Z&end=2026-11-03T00:00:00Z", "start=2026-11-03T00:00:00"]) assert.throws(() => parseHistoryQuery(new URLSearchParams(search), now), HistoryQueryError);
});

test("timestamps reject impossible calendar dates and accept offsets and microseconds", () => {
  for (const value of ["2026-02-30T00:00:00Z", "2026-11-01T24:00:00Z", "2026-11-01T10:00:00", "2026-11-01T10:00:00+99:00"]) assert.equal(isHistoryInstant(value), false, value);
  assert.equal(isHistoryInstant("2028-02-29T01:30:00.123456-05:00"), true);
});

test("cursor retains sub-millisecond ordering and rejects out-of-window or malformed payloads", () => {
  const event = { at: "2026-11-02T12:00:00.123456Z", entityId: "light.example" };
  const params = new URLSearchParams({ start: "2026-11-01T00:00:00Z", end: "2026-11-03T00:00:00Z", cursor: historyCursor(event) });
  assert.deepEqual(parseHistoryQuery(params).cursor, event);
  params.set("cursor", historyCursor({ ...event, at: "2026-10-01T00:00:00Z" }));
  assert.throws(() => parseHistoryQuery(params), HistoryQueryError);
  params.set("cursor", "*invalid*");
  assert.throws(() => parseHistoryQuery(params), HistoryQueryError);
});

test("insights lookback is bounded to ninety days", () => {
  for (const value of ["0", "91", "Infinity", "2.5"]) assert.throws(() => parseInsightsQuery(new URLSearchParams({ days: value })), HistoryQueryError);
  assert.equal(parseInsightsQuery(new URLSearchParams({ days: "90", room: "unassigned" })).days, 90);
});
