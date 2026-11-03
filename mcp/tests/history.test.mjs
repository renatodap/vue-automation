/**
 * Historical reads must stay bounded and read-only, and must preserve unknown
 * coverage rather than turn an outage into apparent zero usage. Exercise the
 * real RPC dispatcher and transport against a controllable app.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startFakeApp, SECRET } from "./_fake-app.mjs";

delete process.env.DATABASE_URL;
delete process.env.MQTT_URL;

const { handleRpc } = await import("../dist/rpc.js");
const { TOOL_DEFS } = await import("../dist/tools.js");

const START = "2026-10-01T00:00:00.000Z";
const END = "2026-10-08T00:00:00.000Z";
const CURSOR = Buffer.from(JSON.stringify({ at: "2026-10-04T12:00:00.000Z", entityId: "light.shelf_lamp" })).toString("base64url");
const HISTORY_TOOLS = ["get_lamp_history", "get_climate_history"];
const NEW_TOOLS = [...HISTORY_TOOLS, "get_room_insights"];

let app;
let haTrap;
let haCalls = 0;
let unavailable = false;

function response(kind) {
  return {
    ok: true, kind, start: START, end: END,
    observations: kind === "climate" ? [{ value: 22.1, unit: "°C", observedAt: START }] : [],
    nextCursor: CURSOR,
    coverage: {
      status: "partial", observedFrom: START,
      gaps: [{ start: "2026-10-02T03:00:00Z", end: "2026-10-02T06:00:00Z", reason: "collector_offline" }],
    },
    note: "Missing observations are unknown, not proof that a lamp was off.",
  };
}

before(async () => {
  const historyRoute = (kind) => () => unavailable
    ? [503, { ok: false, reason: "history_unavailable", message: "History storage is unavailable; observations are unknown." }]
    : [200, response(kind)];
  app = await startFakeApp({
    "GET /api/internal/lamp-history": historyRoute("lamp"),
    "GET /api/internal/climate-history": historyRoute("climate"),
    "GET /api/internal/room-insights": historyRoute("insights"),
    "GET /api/internal/history": (_body, url) => [200, { scene_taps: true, days: Number(url.searchParams.get("days")) }],
  });
  // Any direct HA request would bypass the app's historical read contract.
  // Trap both REST and WebSocket connections, even if a future tool catches
  // their errors and otherwise returns a convincing result.
  haTrap = createServer((_req, res) => {
    haCalls++;
    res.writeHead(500);
    res.end();
  });
  haTrap.on("upgrade", (_req, socket) => { haCalls++; socket.destroy(); });
  await new Promise((resolve) => haTrap.listen(0, "127.0.0.1", resolve));
  process.env.HA_BASE_URL = `http://127.0.0.1:${haTrap.address().port}`;
  process.env.HA_TOKEN = "history-must-never-use-this";
});

beforeEach(() => { app.requests.length = 0; haCalls = 0; unavailable = false; });
after(async () => {
  await app.close();
  await new Promise((resolve) => haTrap.close(resolve));
});

const call = (name, args = {}) => handleRpc({
  jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
});

function successful(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.result.isError, false, result.result.content?.[0]?.text);
  return result.result.structuredContent;
}

test("lamp and climate reads send bounded filters and a cursor over authenticated GET only", async () => {
  for (const [name, entityId, path] of [
    ["get_lamp_history", "light.shelf_lamp", "/api/internal/lamp-history"],
    ["get_climate_history", "sensor.living_room_temperature", "/api/internal/climate-history"],
  ]) {
    successful(await call(name, {
      entity_id: entityId, room: "living", start: START, end: END, limit: 1000, cursor: CURSOR,
    }));
    const request = app.requests.at(-1);
    assert.equal(request.method, "GET");
    assert.equal(request.path, path);
    assert.equal(request.secret, SECRET);
    assert.equal(request.body, null);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(request.search)), {
      start: START, end: END, limit: "1000", entity_id: entityId, room: "living", cursor: CURSOR,
    });
  }
  assert.equal(app.requests.length, 2, "historical reads must not fetch live state or call another endpoint");
  assert.equal(haCalls, 0, "historical reads may not contact Home Assistant");
});

test("history defaults to an explicit seven-day window and a bounded 500-row page", async () => {
  for (const name of HISTORY_TOOLS) {
    const before = Date.now();
    successful(await call(name));
    const params = new URLSearchParams(app.requests.at(-1).search);
    const end = Date.parse(params.get("end"));
    assert.ok(end >= before && end <= Date.now());
    assert.equal(end - Date.parse(params.get("start")), 7 * 86_400_000);
    assert.equal(params.get("limit"), "500");
    assert.equal(params.has("entity_id"), false);
    assert.equal(params.has("room"), false);
  }
});

test("offset timestamps preserve the requested instants", async () => {
  successful(await call("get_lamp_history", {
    start: "2026-10-01T05:30:00+05:30", end: "2026-10-08T05:30:00+05:30",
  }));
  const params = new URLSearchParams(app.requests[0].search);
  assert.equal(Date.parse(params.get("start")), Date.parse(START));
  assert.equal(Date.parse(params.get("end")), Date.parse(END));
});

test("explicit microsecond boundaries survive transport without millisecond truncation", async () => {
  const start = "2026-10-01T00:00:00.123456Z";
  const end = "2026-10-08T00:00:00.654321Z";
  successful(await call("get_lamp_history", { start, end }));
  const params = new URLSearchParams(app.requests[0].search);
  assert.equal(params.get("start"), start);
  assert.equal(params.get("end"), end);
});

test("the 31-day boundary is allowed; no input is silently rounded or clamped", async () => {
  successful(await call("get_lamp_history", { start: START, end: "2026-11-01T00:00:00Z", limit: 1 }));
  assert.equal(new URLSearchParams(app.requests[0].search).get("limit"), "1");
});

test("invalid history inputs fail before any app or HA request", async () => {
  const badArguments = [
    { start: "2026-10-01" },
    { start: "2026-10-01T00:00:00" },
    { start: "2026-02-30T00:00:00Z", end: "2026-03-03T00:00:00Z" },
    { start: START, end: START },
    { start: END, end: START },
    { start: START, end: "2026-11-01T00:00:00.001Z" },
    { start: "not a date" },
    { end: "2026-13-01T00:00:00Z" },
    { room: "kitchen" }, { room: null },
    { entity_id: "switch.heater" },
    { entity_id: "light.lamp&method=POST" },
    { limit: 0 }, { limit: 1001 }, { limit: 2.5 },
    { limit: true }, { limit: "100" }, { limit: null },
    { cursor: "" }, { cursor: "x".repeat(2049) }, { cursor: "a&method=POST" },
    { method: "POST" }, { action: "delete" }, { query: "DELETE FROM lamp_state_history" },
  ];
  for (const name of HISTORY_TOOLS) {
    for (const args of badArguments) {
      const result = await call(name, args);
      assert.equal(result.error, undefined, `${name} bad input must remain a model-readable result`);
      assert.equal(result.result.isError, true, `${name} accepted ${JSON.stringify(args)}`);
      assert.equal(app.requests.length, 0, `${name} made an app request for ${JSON.stringify(args)}`);
      assert.equal(haCalls, 0);
    }
  }
});

test("entity domains cannot be exchanged between lamp and climate history", async () => {
  for (const [name, entityId] of [["get_lamp_history", "sensor.bedroom_temperature"], ["get_climate_history", "light.shelf_lamp"]]) {
    assert.equal((await call(name, { entity_id: entityId })).result.isError, true);
  }
  assert.equal(app.requests.length, 0);
});

test("climate entities such as thermostats can be filtered alongside sensors", async () => {
  successful(await call("get_climate_history", { entity_id: "climate.living_room" }));
  assert.equal(new URLSearchParams(app.requests[0].search).get("entity_id"), "climate.living_room");
});

test("room insights defaults to 30 days and sends only the bounded room/day filters", async () => {
  successful(await call("get_room_insights"));
  assert.equal(app.requests[0].search, "?days=30");
  successful(await call("get_room_insights", { room: "bedroom", days: 90 }));
  assert.deepEqual(app.requests[1], {
    method: "GET", path: "/api/internal/room-insights", search: "?days=90&room=bedroom", body: null, secret: SECRET,
  });
  assert.equal(haCalls, 0);
});

test("room insights rejects unbounded periods and unknown mutation arguments", async () => {
  for (const args of [{ days: 0 }, { days: 91 }, { days: 1.2 }, { days: "30" }, { days: null }, { room: "outside" }, { action: "reset" }]) {
    assert.equal((await call("get_room_insights", args)).result.isError, true, JSON.stringify(args));
  }
  assert.equal(app.requests.length, 0);
  assert.equal(haCalls, 0);
});

test("observations, units, coverage gaps and cursor survive in structured and text results", async () => {
  for (const [name, kind] of [["get_lamp_history", "lamp"], ["get_climate_history", "climate"], ["get_room_insights", "insights"]]) {
    const result = await call(name);
    assert.deepEqual(successful(result), response(kind));
    assert.deepEqual(JSON.parse(result.result.content[0].text), response(kind));
  }
});

test("history storage failure is an explicit tool error, never empty history", async () => {
  unavailable = true;
  for (const name of NEW_TOOLS) {
    const result = await call(name);
    assert.equal(result.error, undefined);
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /History storage is unavailable; observations are unknown/);
    assert.equal(result.result.structuredContent, undefined);
  }
  assert.equal(haCalls, 0);
});

test("the existing get_history remains scene-tap history", async () => {
  assert.deepEqual(successful(await call("get_history", { days: 14 })), { scene_taps: true, days: 14 });
  assert.equal(app.requests[0].path, "/api/internal/history");
});

test("named history tools advertise read-only annotations and disallow extra properties", () => {
  for (const name of NEW_TOOLS) {
    const tool = TOOL_DEFS.find((item) => item.name === name);
    assert.ok(tool, `${name} is missing`);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});
