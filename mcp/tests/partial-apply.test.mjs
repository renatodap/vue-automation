/**
 * A scene that only partly applied must be REPORTED as only partly applied.
 *
 * ## The failure this pins
 *
 * Home Assistant applies a scene to the lamps it can reach and stays silent
 * about the rest. Silence reads as success, so the user taps "Cozy Cinema",
 * one lamp stays dark, and nothing explains why. Invariant #4 exists for that,
 * and the judgement lives in the app (`_lib/apply-report.ts`) so there is only
 * one implementation of it.
 *
 * Which makes the CONNECTOR's obligation a relaying obligation, and that is
 * what is tested here: the app's verdict must reach the model intact, in
 * `structuredContent` and in the mirrored text block, as a SUCCESSFUL JSON-RPC
 * result — not softened into "done", not lost in a summary, and not turned
 * into a protocol error the model cannot read.
 *
 * Needs no database, no Home Assistant and no broker. The far side of the wire
 * is a controllable fake app (tests/_fake-app.mjs).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeApp, stateFixture, lampFixture, SECRET } from "./_fake-app.mjs";

delete process.env.DATABASE_URL;

const { handleRpc } = await import("../dist/rpc.js");

let app;
let applyCalls = [];
let lampCalls = [];

/** The report the app returns for a scene that reached one lamp of two. */
function partialReport() {
  const after = lampFixture();
  return {
    ok: true,
    applied_entity_id: "scene.cozy_cinema",
    scene: "Cozy Cinema",
    read_at: new Date().toISOString(),
    applied: ["Shelf lamp"],
    unreachable: ["Floor lamp"],
    did_not_match: [],
    fully_applied: false,
    summary:
      "Applied PARTIALLY: 1 lamp followed; Floor lamp is unreachable (a smart bulb is only smart " +
      "while it has power — check the lamp switch). Say this out loud — do not report it as a clean apply.",
    lamps: after,
  };
}

before(async () => {
  app = await startFakeApp({
    "GET /api/internal/state": () => [200, stateFixture()],
    "POST /api/internal/scene": (body) => {
      applyCalls.push(body);
      if (body.action !== "apply") return [400, { error: `unexpected action ${body.action}` }];
      return [200, partialReport()];
    },
    "POST /api/internal/lamp": (body) => {
      lampCalls.push(body);
      const lamps = lampFixture().filter((l) => (body.entity_ids ?? []).includes(l.entityId));
      return [
        200,
        {
          ok: true,
          read_at: new Date().toISOString(),
          lamps,
          unreachable: lamps.filter((l) => !l.reachable).map((l) => l.name),
          fully_applied: lamps.every((l) => l.reachable),
          summary: "Done.",
          ...(body.effect
            ? {
                effect_note:
                  `Sent the "${body.effect}" effect. blink, breathe, okay and channel_change are ` +
                  `Zigbee Identify animations: they run a short fixed sequence and stop on their own.`,
              }
            : {}),
        },
      ];
    },
  });
});

after(async () => {
  await app.close();
});

const call = (name, args = {}) =>
  handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

test("apply_scene relays a partial application as a successful result carrying the whole verdict", async () => {
  applyCalls = [];
  const res = await call("apply_scene", { scene_id: "scene.cozy_cinema" });

  // A tool that "failed" in the sense of not fully applying is NOT a JSON-RPC
  // error — the model has to be able to read it and say so.
  assert.equal(res.error, undefined, "a partial apply is not a protocol error");
  assert.equal(res.result.isError, false);

  const structured = res.result.structuredContent;
  assert.equal(structured.fully_applied, false, "the partial verdict must survive to the model");
  assert.deepEqual(structured.unreachable, ["Floor lamp"], "the unreachable lamp must be NAMED");
  assert.deepEqual(structured.applied, ["Shelf lamp"]);
  assert.match(
    structured.summary,
    /do not report it as a clean apply/i,
    "the app's instruction to the model must not be stripped on the way through",
  );

  // The mirrored text block matters: older clients read only that, and a
  // structuredContent-only answer would be invisible to them.
  const text = res.result.content.find((c) => c.type === "text")?.text ?? "";
  assert.ok(text.length > 0, "there must be a text mirror alongside structuredContent");
  assert.ok(text.includes("Floor lamp"), "the text mirror must name the unreachable lamp too");
  assert.ok(text.includes("fully_applied"), "the text mirror must carry the verdict, not just prose");
});

test("the connector sends the shared secret on every internal call", async () => {
  applyCalls = [];
  await call("apply_scene", { scene_id: "scene.cozy_cinema" });
  assert.ok(app.requests.length >= 2, "apply reads state first, then applies");
  for (const r of app.requests) {
    assert.equal(r.secret, SECRET, `${r.method} ${r.path} went out without x-internal-secret`);
  }
});

test("apply_scene resolves a scene by alias, label and name — not just by entity id", async () => {
  for (const needle of ["movie mode", "Cozy Cinema", "cozy_cinema_1754600000", "scene.cozy_cinema"]) {
    applyCalls = [];
    const res = await call("apply_scene", { scene_id: needle });
    assert.equal(res.result.isError, false, `"${needle}" should resolve`);
    assert.equal(
      applyCalls[0].entity_id,
      "scene.cozy_cinema",
      `"${needle}" must resolve to the entity id before the app is called`,
    );
  }
});

test("an unknown scene is an isError result naming what DOES exist", async () => {
  const res = await call("apply_scene", { scene_id: "scene.does_not_exist" });
  assert.equal(res.error, undefined, "bad input is a result, not a protocol error — the model must read it");
  assert.equal(res.result.isError, true);
  const text = res.result.content[0].text;
  assert.match(text, /No scene matches/);
  assert.match(text, /scene\.cozy_cinema/, "the refusal must list the real options so the model can retry");
});

test("get_room reports the unreachable lamp and stamps when it was read", async () => {
  const res = await call("get_room");
  const data = res.result.structuredContent;
  assert.deepEqual(data.unreachable, ["Floor lamp"]);
  assert.equal(data.all_reachable, false);
  assert.ok(data.read_at, "a reading with no timestamp cannot be judged stale");
  assert.match(
    data.note,
    /live reading/i,
    "every read must carry the instruction not to repeat it later as current",
  );
});

test("set_lamp refuses a Kelvin the bulb cannot reach, before touching the app", async () => {
  // Home Assistant rejects an out-of-range value SILENTLY and the lamp simply
  // does not move — which is indistinguishable from the call never landing. So
  // the refusal has to happen here, with the bulb's real range in the message.
  const before = app.requests.length;
  const res = await call("set_lamp", { entity_id: "light.shelf_lamp", kelvin: 9000 });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /2000K and 6493K/, "the refusal must quote the bulb's own range");
  const wrote = app.requests.slice(before).filter((r) => r.path === "/api/internal/lamp");
  assert.equal(wrote.length, 0, "nothing should have been sent to the app");
});

test("set_lamp with no change to make is refused rather than sent as a no-op", async () => {
  const res = await call("set_lamp", { entity_id: "light.shelf_lamp" });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /get_lamp/, "it should point at the read tool instead");
});

test("set_lamp refuses an effect the bulb does not advertise, before touching the app", async () => {
  // Identical failure shape to an out-of-range Kelvin: Home Assistant accepts
  // the call, drops the unknown effect in silence, and the lamp sits still
  // while the caller is told it worked. So it has to be refused here.
  const before = app.requests.length;
  const res = await call("set_lamp", { entity_id: "light.shelf_lamp", effect: "candle" });
  assert.equal(res.result.isError, true);
  assert.match(
    res.result.content[0].text, /advertises: blink, breathe/,
    "the refusal must quote the bulb's own list, not a generic message",
  );
  const wrote = app.requests.slice(before).filter((r) => r.path === "/api/internal/lamp");
  assert.equal(wrote.length, 0, "nothing should have been sent to the app");
});

test("set_lamp sends an advertised effect through to the app", async () => {
  lampCalls = [];
  const res = await call("set_lamp", { entity_id: "light.shelf_lamp", effect: "breathe" });
  assert.equal(res.result.isError, false, "an effect the bulb offers is not an error");
  assert.equal(lampCalls.length, 1, "the write must actually reach the app");
  assert.equal(lampCalls[0].effect, "breathe", "the effect must survive the relay");
  assert.deepEqual(lampCalls[0].entity_ids, ["light.shelf_lamp"]);
});

test("an effect alone is a change — it is not treated as an empty call", async () => {
  // `effect` was added after on/brightness/kelvin/hs, and the guard that
  // rejects an empty patch is exactly where a new field gets forgotten.
  lampCalls = [];
  const res = await call("set_lamp", { entity_id: "light.shelf_lamp", effect: "stop_effect" });
  assert.equal(res.result.isError, false, "effect on its own must be accepted");
  assert.equal(lampCalls.length, 1);
});

test("the app's note about an effect being momentary reaches the model", async () => {
  // The model must not offer `breathe` as a lasting candle mode. That warning
  // only works if it survives the relay into structuredContent.
  const res = await call("set_lamp", { entity_id: "light.shelf_lamp", effect: "breathe" });
  assert.match(
    res.result.structuredContent.effect_note ?? "",
    /stop on their own/,
    "the momentary-effect warning must not be dropped on the way to the model",
  );
});

test("an unknown tool NAME is the one genuine protocol error", async () => {
  const res = await handleRpc({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "turn_on_the_oven", arguments: {} },
  });
  assert.equal(res.result, undefined);
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /apply_scene/, "the error should list the tools that do exist");
});

test("server/discover answers without any handshake, and initialize still works", async () => {
  const discovered = await handleRpc({ jsonrpc: "2.0", id: 1, method: "server/discover" });
  assert.ok(discovered.result.tools.length > 0, "discovery must carry the tool list");
  assert.ok(discovered.result.instructions.length > 0);
  assert.ok(discovered.result.protocolVersions.includes("2026-07-28"));

  const initialized = await handleRpc({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  assert.equal(
    initialized.result.protocolVersion, "2025-06-18",
    "a recognised version must be echoed back, not overridden with ours",
  );
  assert.equal(initialized.result.capabilities.tools.listChanged, false,
    "listChanged:true promises pushes this server cannot send without an open stream");
});

test("a notification is answered with null so the transport can send an empty 202", async () => {
  const res = await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res, null, "serialising anything at all, even {}, is a protocol violation some clients hang on");
});
