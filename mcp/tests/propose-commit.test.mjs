/**
 * Propose → commit: a destructive change needs a diff and a second call.
 *
 * ## Why not elicitation
 *
 * MCP elicitation is OPTIONAL for clients. A client that does not implement it
 * silently skips the question and the destructive call goes straight through —
 * the confirmation would be present in the protocol and absent in practice.
 * Two tool calls with a token in between cannot be skipped by anybody: without
 * a commit there is no delete. This file pins that property.
 *
 * What has to hold:
 *   1. propose_* changes NOTHING — no delete reaches the app.
 *   2. The diff names what would be lost, including schedules that would break.
 *   3. The token is opaque, and only a token this server minted is accepted.
 *   4. It is SINGLE USE. A replay must not delete something a second time.
 *   5. commit_change actually performs the change the token described.
 *
 * Runs with DATABASE_URL unset, which exercises the in-memory path — the one
 * that has to keep working during a database outage, because the lights must
 * (invariant #2). The Postgres path is the same code with an atomic UPDATE in
 * front of it.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFakeApp, stateFixture } from "./_fake-app.mjs";

delete process.env.DATABASE_URL;

const { handleRpc } = await import("../dist/rpc.js");
const { createProposal, consumeProposal, pendingProposals } = await import("../dist/propose.js");

let app;
let sceneCalls = [];
let scheduleCalls = [];

before(async () => {
  app = await startFakeApp({
    "GET /api/internal/state": () => [200, stateFixture()],
    "GET /api/internal/scene": (_b, url) => [
      200,
      {
        ok: true,
        id: url.searchParams.get("id"),
        config: {
          name: "Cozy Cinema",
          entities: {
            "light.shelf_lamp": { state: "on", brightness: 76, color_temp_kelvin: 2700 },
            "light.floor_lamp": { state: "on", brightness: 25, color_temp_kelvin: 2200 },
          },
        },
      },
    ],
    "GET /api/internal/schedule": (_b, url) => [
      200,
      {
        ok: true,
        id: url.searchParams.get("id"),
        // This schedule applies the scene, so deleting the scene breaks it.
        config: {
          id: url.searchParams.get("id"),
          alias: "Evening lights",
          triggers: [{ trigger: "sun", event: "sunset", offset: "-00:30:00" }],
          actions: [{ action: "scene.turn_on", target: { entity_id: "scene.cozy_cinema" } }],
        },
      },
    ],
    "POST /api/internal/scene": (body) => {
      sceneCalls.push(body);
      if (body.action === "delete") return [200, { ok: true, deleted: body.id, was: { name: "Cozy Cinema" } }];
      if (body.action === "save") {
        return [200, {
          ok: true, id: body.id ?? "new_scene_1", name: body.name, captured: 1,
          entities: { "light.shelf_lamp": { state: "on", brightness: 102 } },
          replaced: { name: "Cozy Cinema" }, skipped: ["Floor lamp"],
        }];
      }
      return [400, { error: `unexpected action ${body.action}` }];
    },
    "POST /api/internal/schedule": (body) => {
      scheduleCalls.push(body);
      if (body.action === "delete") return [200, { ok: true, deleted: body.id, was: { alias: "Evening lights" } }];
      return [400, { error: `unexpected action ${body.action}` }];
    },
  });
});

after(async () => {
  await app.close();
});

beforeEach(() => {
  sceneCalls = [];
  scheduleCalls = [];
});

const call = (name, args = {}) =>
  handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

test("propose_delete_scene changes nothing and returns a diff naming what breaks", async () => {
  const res = await call("propose_delete_scene", { scene_id: "movie mode" });
  assert.equal(res.result.isError, false);
  const data = res.result.structuredContent;

  assert.equal(
    sceneCalls.filter((c) => c.action === "delete").length,
    0,
    "PROPOSING deleted something — the whole point is that nothing happens until commit",
  );

  assert.ok(data.change_token.startsWith("chg_"), "the token should be recognisable as one");
  assert.match(data.diff, /DELETE the scene "Cozy Cinema"/);
  assert.match(data.diff, /light\.shelf_lamp/, "the diff must say what the scene currently sets");
  assert.match(data.diff, /cannot be undone/i);
  assert.deepEqual(
    data.breaks_schedules,
    ["Evening lights"],
    "a schedule left pointing at a deleted scene fails silently at sunset every day — the diff " +
      "has to surface it while there is still a decision to make",
  );
});

test("the token is opaque — it carries none of the change it authorizes", async () => {
  const res = await call("propose_delete_scene", { scene_id: "scene.cozy_cinema" });
  const token = res.result.structuredContent.change_token;
  const body = token.slice("chg_".length);
  for (const leak of ["cozy", "cinema", "scene", "delete"]) {
    assert.equal(
      body.toLowerCase().includes(leak),
      false,
      `the token leaks "${leak}" — a token must be a random handle, not an encoded instruction`,
    );
  }
  assert.ok(body.length >= 32, "a guessable token is a bypass of the whole mechanism");
});

test("commit_change applies exactly the change the token described", async () => {
  const proposed = await call("propose_delete_scene", { scene_id: "scene.cozy_cinema" });
  const token = proposed.result.structuredContent.change_token;

  const committed = await call("commit_change", { token });
  assert.equal(committed.result.isError, false);
  assert.equal(committed.result.structuredContent.change, "delete_scene");

  const deletes = sceneCalls.filter((c) => c.action === "delete");
  assert.equal(deletes.length, 1, "exactly one delete should have reached the app");
  assert.equal(deletes[0].id, "cozy_cinema_1754600000", "it must delete the scene that was proposed");
});

test("a token is SINGLE USE — a replay deletes nothing a second time", async () => {
  const proposed = await call("propose_delete_scene", { scene_id: "scene.cozy_cinema" });
  const token = proposed.result.structuredContent.change_token;

  await call("commit_change", { token });
  const before = sceneCalls.filter((c) => c.action === "delete").length;

  const replay = await call("commit_change", { token });
  assert.equal(replay.result.isError, true, "a replayed token must be refused");
  assert.match(replay.result.content[0].text, /unknown or has expired|already applied/i);
  assert.equal(
    sceneCalls.filter((c) => c.action === "delete").length,
    before,
    "the replay reached the app — the token was not consumed",
  );
});

test("a token this server never minted is refused", async () => {
  for (const bogus of ["chg_" + "A".repeat(32), "not-a-token", "", "chg_"]) {
    const res = await call("commit_change", { token: bogus });
    assert.equal(res.result.isError, true, `"${bogus}" should not commit anything`);
  }
  assert.equal(sceneCalls.length, 0, "no forged token may reach the app");
});

test("consumeProposal is atomic at the unit level too", async () => {
  const { token } = await createProposal("delete_scene", { scene_config_id: "x" }, "diff text");
  const first = await consumeProposal(token);
  assert.equal(first.tool, "delete_scene");
  assert.equal(first.diff, "diff text");
  await assert.rejects(() => consumeProposal(token), /unknown or has expired/i);
});

test("two proposals never collide, and each redeems only itself", async () => {
  const a = await createProposal("delete_scene", { scene_config_id: "a" }, "A");
  const b = await createProposal("delete_scene", { scene_config_id: "b" }, "B");
  assert.notEqual(a.token, b.token);
  assert.equal((await consumeProposal(b.token)).args.scene_config_id, "b");
  assert.equal((await consumeProposal(a.token)).args.scene_config_id, "a");
});

test("list_pending_changes shows the diff but never hands back a token", async () => {
  const proposed = await call("propose_delete_schedule", { schedule_id: "Evening lights" });
  const token = proposed.result.structuredContent.change_token;

  const listed = await call("list_pending_changes");
  const pending = listed.result.structuredContent.pending;
  assert.ok(pending.length > 0, "a fresh proposal should be listed");
  assert.equal(
    JSON.stringify(pending).includes(token),
    false,
    "listing the tokens would let one be committed without anybody having read its diff",
  );
  assert.ok(pending.some((p) => p.diff.includes("Evening lights")));
  assert.ok(pendingProposals().every((p) => typeof p.expires_in_seconds === "number"));

  // Clean up so the assertion above stays meaningful for later runs.
  await call("commit_change", { token });
  assert.equal(scheduleCalls.filter((c) => c.action === "delete").length, 1);
});

test("propose_delete_schedule offers pausing as the reversible alternative", async () => {
  const res = await call("propose_delete_schedule", { schedule_id: "automation.evening_lights" });
  assert.match(
    res.result.structuredContent.diff,
    /set_schedule_enabled/,
    "people usually mean pause; the diff should say so before they approve a delete",
  );
});

test("propose_overwrite_scene shows what each lamp would become, and flags what can't be captured", async () => {
  const res = await call("propose_overwrite_scene", { scene_id: "scene.cozy_cinema" });
  const diff = res.result.structuredContent.diff;
  assert.match(diff, /Shelf lamp/, "each lamp should appear by name");
  assert.match(diff, /→/, "the diff should be a before → after, not just an after");
  assert.match(
    diff,
    /UNREACHABLE — cannot be captured/,
    "a lamp with no power silently drops OUT of the scene on save; that has to be visible first",
  );
  assert.equal(sceneCalls.filter((c) => c.action === "save").length, 0, "proposing must not save");
});

test("save_scene refuses to shadow an existing name and points at the propose flow", async () => {
  const res = await call("save_scene", { name: "Cozy Cinema", from_current: true });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /propose_overwrite_scene/);
  assert.equal(sceneCalls.filter((c) => c.action === "save").length, 0);
});

test("save_scene requires from_current, so a scene is never invented from a description", async () => {
  const res = await call("save_scene", { name: "Something New", from_current: false });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /snapshot of the room/i);
});
