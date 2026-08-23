/**
 * `set_lamp_room` moves a bulb between rooms — and must not be able to do more.
 *
 * ## What this pins
 *
 * The room override layer is allowed to exist only because it SHADOWS the
 * static map in `web/src/lib/rooms.ts` rather than replacing it (invariant 9).
 * The connector's half of that bargain is narrow and worth holding still:
 *
 *   - it resolves a spoken lamp name to an entity id before writing, so a
 *     write never lands on a lamp nobody checked existed;
 *   - it sends `room_id` through untouched, INCLUDING `null`, which is the
 *     documented way to clear an override and fall back to the built-in
 *     assignment — a `null` quietly dropped or coerced to "unassigned" would
 *     silently do the opposite of what was asked;
 *   - it relays the app's refusal of an invented room instead of softening it,
 *     because rooms are a closed set and a model that believes it created
 *     "livingroom" will keep referring to a room nothing renders;
 *   - it does not claim to be read-only. A client auto-approving this would be
 *     auto-approving a write.
 *
 * Needs no database, no Home Assistant and no broker: the far side of the wire
 * is the controllable fake app.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeApp, stateFixture } from "./_fake-app.mjs";

delete process.env.DATABASE_URL;

const { handleRpc } = await import("../dist/rpc.js");
const { TOOL_DEFS } = await import("../dist/tools.js");

let app;
let roomCalls = [];

/** The app's answer for a lamp that actually moved. */
function moved(body) {
  return {
    ok: true,
    entity_id: body.entity_id,
    lamp: "Shelf lamp",
    room: body.room_id ?? "living",
    room_name: body.room_id === "bedroom" ? "Bedroom" : "Living Room",
    previous_room: "living",
    note: "Shelf lamp moved from \"living\" to \"bedroom\". This is how the app groups it; " +
      "Home Assistant's own areas are unchanged.",
  };
}

before(async () => {
  app = await startFakeApp({
    "GET /api/internal/state": () => [200, stateFixture()],
    "POST /api/internal/lamp-room": (body) => {
      roomCalls.push(body);
      // The real route validates the room against the closed RoomId set.
      const known = ["living", "bedroom", "unassigned"];
      if (body.room_id !== null && !known.includes(body.room_id)) {
        return [400, {
          error: `"${body.room_id}" is not a room. Use one of "living", "bedroom", "unassigned", ` +
            `or null to clear the override. Rooms are defined in the app and cannot be created here.`,
        }];
      }
      return [200, moved(body)];
    },
  });
});

after(async () => {
  await app.close();
});

const call = (name, args = {}) =>
  handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

test("a lamp named the way a person says it is resolved to an entity id before the write", async () => {
  roomCalls = [];
  const res = await call("set_lamp_room", { entity_id: "shelf lamp", room_id: "bedroom" });

  assert.equal(res.error, undefined, "should not be a protocol error");
  assert.equal(roomCalls.length, 1, "should have written exactly once");
  assert.equal(
    roomCalls[0].entity_id,
    "light.shelf_lamp",
    "the spoken name must be resolved before the write, not passed through raw",
  );
  assert.equal(roomCalls[0].room_id, "bedroom");
});

test("room_id: null reaches the app as null, so an override can actually be cleared", async () => {
  roomCalls = [];
  const res = await call("set_lamp_room", { entity_id: "light.shelf_lamp", room_id: null });

  assert.equal(res.error, undefined);
  assert.equal(roomCalls.length, 1);
  assert.strictEqual(
    roomCalls[0].room_id,
    null,
    'null must survive as null — dropping it or coercing it to "unassigned" clears nothing',
  );
});

test("an invented room is refused, and the app's reason reaches the model intact", async () => {
  roomCalls = [];
  const res = await call("set_lamp_room", { entity_id: "light.shelf_lamp", room_id: "livingroom" });

  const text = JSON.stringify(res);
  assert.match(text, /is not a room/, "the app's refusal must be relayed, not softened");
  assert.match(text, /cannot be created here/, "the reason rooms are closed must survive");
});

test("a lamp that does not exist is refused before anything is written", async () => {
  roomCalls = [];
  const res = await call("set_lamp_room", { entity_id: "porch light", room_id: "bedroom" });

  assert.equal(roomCalls.length, 0, "nothing may be written for a lamp that was never found");
  assert.match(JSON.stringify(res), /No lamp matches/);
});

test("set_lamp_room is not annotated read-only", () => {
  const tool = TOOL_DEFS.find((t) => t.name === "set_lamp_room");
  assert.ok(tool, "set_lamp_room is not registered");
  assert.notEqual(
    tool.annotations?.readOnlyHint,
    true,
    "a write annotated read-only would be auto-approved by a client",
  );
});

test("get_room carries the room set, so a caller can use a real room id", async () => {
  const res = await call("get_room", {});
  const text = JSON.stringify(res);
  assert.match(text, /"rooms"/, "get_room must list the rooms set_lamp_room refers to");
  assert.match(text, /bedroom/);
});
