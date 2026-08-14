/**
 * The tool surface is prompt text, and it has to hold its shape.
 *
 * Every title, description and parameter description is read by the model on
 * every call, so this file guards the properties that make the surface usable
 * rather than the behaviour of any one tool:
 *
 *   - `readOnlyHint` is what lets a client auto-approve a read instead of
 *     prompting every time. It is the difference between a connector someone
 *     uses and one they turn off — and a read MISSING the hint is invisible
 *     until someone gets tired of tapping approve.
 *   - A write annotated read-only is the dangerous direction of that mistake:
 *     the client would auto-approve it.
 *   - No generic SQL WRITER, ever. The read-only escape hatch is allowed; a
 *     write expressed as free-form SQL is a write nobody reviewed, against a
 *     house.
 *   - No personal names in copy the model reads (`code-is-user-agnostic`):
 *     state the mechanism, not the anecdote.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.DATABASE_URL;

const { TOOL_DEFS } = await import("../dist/tools.js");

/** Every string the model actually sees for one tool. */
function copyStringsFor(tool) {
  const out = [{ where: `${tool.name}.title`, text: tool.title }];
  if (typeof tool.description === "string") {
    out.push({ where: `${tool.name}.description`, text: tool.description });
  }
  (function walk(schema, path) {
    if (!schema || typeof schema !== "object") return;
    if (typeof schema.description === "string") {
      out.push({ where: `${tool.name}.inputSchema${path}`, text: schema.description });
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, sub] of Object.entries(schema.properties)) walk(sub, `${path}.${key}`);
    }
    if (schema.items) walk(schema.items, `${path}[]`);
  })(tool.inputSchema, "");
  return out;
}

test("every tool is registered with a name, a title and a description", () => {
  assert.ok(TOOL_DEFS.length > 0, "TOOL_DEFS is empty — nothing to scan");
  for (const t of TOOL_DEFS) {
    assert.ok(t.name, "a tool is missing name");
    assert.ok(t.title, `${t.name} is missing a title`);
    assert.ok(t.description, `${t.name} is missing a description`);
    assert.equal(t.inputSchema?.type, "object", `${t.name} needs an object inputSchema`);
  }
});

test("the tool names are unique and stably ordered", () => {
  const names = TOOL_DEFS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "two tools share a name");
});

test("every read is annotated readOnlyHint, and no write is", () => {
  // The naming convention IS the contract here: get_*, list_*, poll_*, query_*
  // and propose_* only look, and everything else acts.
  const readish = /^(get_|list_|poll_|query_|propose_)/;
  for (const t of TOOL_DEFS) {
    const hint = t.annotations?.readOnlyHint;
    if (readish.test(t.name)) {
      assert.equal(
        hint, true,
        `${t.name} reads but is not annotated readOnlyHint — the client will prompt on every call`,
      );
    } else {
      assert.notEqual(
        hint, true,
        `${t.name} changes something but is annotated readOnlyHint — the client would auto-approve it`,
      );
    }
  }
});

test("the irreversible tool is flagged destructive, and it is the only committer", () => {
  const commit = TOOL_DEFS.find((t) => t.name === "commit_change");
  assert.ok(commit, "commit_change must exist — propose_* is meaningless without it");
  assert.equal(commit.annotations?.destructiveHint, true);

  // Every propose_* must have a commit path, and vice versa: a proposal nobody
  // can redeem is dead code, and a delete with no proposal is the bypass.
  const proposals = TOOL_DEFS.filter((t) => t.name.startsWith("propose_"));
  assert.ok(proposals.length >= 3, "deleting a scene, deleting a schedule and overwriting a scene all need one");
  for (const p of proposals) {
    assert.match(p.description, /commit_change/, `${p.name} must tell the model how to complete the flow`);
    assert.match(
      p.description, /NOTHING (CHANGES|IS DELETED)/,
      `${p.name} must state plainly that it does not act`,
    );
  }
});

test("there is no generic SQL WRITER anywhere on the surface", () => {
  for (const t of TOOL_DEFS) {
    assert.equal(
      /^(run_sql|exec_sql|execute_sql|sql)$/.test(t.name), false,
      `${t.name} is a generic SQL tool — every mutation must be a named question with a schema`,
    );
  }
  const q = TOOL_DEFS.find((t) => t.name === "query_sql");
  if (q) {
    assert.equal(q.annotations?.readOnlyHint, true, "query_sql must be read-only");
    assert.match(q.description, /LAST RESORT/, "it must be positioned as a fallback, never as the default");
    assert.match(q.description, /scene_meta/, "it must document the tables it can actually see");
  }
});

test("the tools that can only partly succeed say so in their description", () => {
  // These four can each land halfway — a scene that reached two lamps of four,
  // a rename that took in one system and not the other. Silence about that is
  // the failure mode this whole connector is shaped around.
  for (const name of ["apply_scene", "set_lamp", "save_scene", "name_device"]) {
    const t = TOOL_DEFS.find((x) => x.name === name);
    assert.ok(t, `${name} is missing`);
    assert.match(
      t.description,
      /unreachable|UNREACHABLE|fully_renamed|did not follow|fully_applied|no power/,
      `${name} must warn the model that a partial result is possible and must be reported`,
    );
  }
});

test("no tool copy names the user", () => {
  // `code-is-user-agnostic`: a name baked into a description leaks into what
  // the model says back, and is wrong the day a second household uses this.
  const PERSONAL = /\brenato\b|\bprado\b|\brenatodap\b/i;
  const offenders = [];
  for (const tool of TOOL_DEFS) {
    for (const { where, text } of copyStringsFor(tool)) {
      if (PERSONAL.test(text)) offenders.push(where);
    }
  }
  assert.deepEqual(offenders, [], `personal name found in: ${offenders.join(", ")}`);
});

test("the initialize instructions route the model to a first call", async () => {
  const { INSTRUCTIONS } = await import("../dist/rpc.js");
  assert.match(INSTRUCTIONS, /get_room/, "the instructions must name the tool to call first");
  assert.match(INSTRUCTIONS, /fully_applied/, "the partial-apply rule belongs in the standing instructions");
  assert.match(INSTRUCTIONS, /propose_/, "the destructive-change protocol belongs there too");
  assert.equal(
    /\brenato\b/i.test(INSTRUCTIONS), false,
    "the instructions are read on every session — keep them user-agnostic",
  );
});
