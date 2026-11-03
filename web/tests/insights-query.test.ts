import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { db } from "../src/lib/db";
import { parseHistoryQuery } from "../src/lib/history-params";
import { queryHistory, queryInsights } from "../src/lib/history-query";

// Run only against a disposable, explicitly selected local database.
const testUrl = process.env.HISTORY_TEST_DATABASE_URL;
test("Postgres history queries preserve cursor precision, filter rooms, and coalesce only matching legacy observations", { skip: !testUrl }, async () => {
  process.env.DATABASE_URL = testUrl;
  const sql = db()!;
  try {
    const migration = await readFile(new URL("../../homeassistant/migrations/2026-11-03_history-audit.sql", import.meta.url), "utf8");
    const connection = await sql.reserve();
    try {
      await connection.unsafe(migration);
      await connection.unsafe(migration);
    } finally { connection.release(); }
    await sql`INSERT INTO history_settings(id,time_zone,temperature_unit) VALUES ('ha','America/New_York','°F')`;
    await sql`INSERT INTO history_sync(id,cursor_at,last_success_at) VALUES ('recorder',now(),now())`;
    await sql`INSERT INTO history_entity(entity_id,kind,name,room_id) VALUES ('light.test','light','Test light','living'),('light.other','light','Other light','bedroom'),('scene.test','scene','Test scene',NULL),('sensor.test','temperature','Test sensor','unassigned')`;
    await sql`INSERT INTO lamp_state_history(entity_id,at,state,brightness) VALUES ('light.test','2026-11-02T12:00:00.123456Z','on',128),('light.test','2026-11-02T12:00:00.123457Z','on',200),('light.test','2026-11-02T12:00:00.123458Z','off',NULL),('light.other','2026-11-02T13:00:00Z','off',NULL)`;
    await sql`INSERT INTO climate_history(entity_id,at,state,temperature_c) VALUES ('sensor.test','2026-11-02T13:00:00Z','68',20)`;
    await sql`INSERT INTO scene_application(entity_id,at,origin,room_ids) VALUES ('scene.test','2026-11-02T14:00:00Z','recorder',ARRAY['living']),('scene.test','2026-11-02T14:00:00.200000Z','legacy_tap',ARRAY['living']),('scene.test','2026-11-02T14:05:00Z','legacy_tap',ARRAY['living'])`;
    await sql`INSERT INTO history_gap(started_at,ended_at,reason) VALUES ('2026-11-02T11:00:00Z','2026-11-02T11:30:00Z','test disconnect')`;
    const params = new URLSearchParams({ start: "2026-11-01T00:00:00Z", end: "2026-11-03T00:00:00Z", room: "living", limit: "1" });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      if (cursor) params.set("cursor", cursor);
      const page = await queryHistory("lamps", parseHistoryQuery(params));
      assert.equal(page.timeZone, "America/New_York");
      assert.equal(page.coverage.gaps.length, 1);
      assert.equal(page.entities.length, 1);
      seen.push(...page.rows.map((row) => row.at));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, ["2026-11-02T12:00:00.123458Z", "2026-11-02T12:00:00.123457Z", "2026-11-02T12:00:00.123456Z"]);
    params.delete("cursor"); params.set("limit", "1"); params.set("transitions_only", "true");
    const transitions = await queryHistory("lamps", parseHistoryQuery(params));
    assert.equal(transitions.rows[0].state, "off");
    assert.ok(transitions.nextCursor);
    params.set("cursor", transitions.nextCursor!);
    const previousTransition = await queryHistory("lamps", parseHistoryQuery(params));
    assert.deepEqual(previousTransition.rows.map((row) => row.at), ["2026-11-02T12:00:00.123456Z"]);
    assert.equal(previousTransition.nextCursor, null);
    // A prior observation outside the requested window is still the baseline.
    await sql`INSERT INTO lamp_state_history(entity_id,at,state) VALUES ('light.test','2026-10-31T12:00:00Z','on')`;
    params.delete("cursor");
    const withBaseline = await queryHistory("lamps", parseHistoryQuery(params));
    assert.equal(withBaseline.rows.length, 1);
    assert.equal(withBaseline.rows[0].state, "off");
    assert.equal(withBaseline.nextCursor, null);
    await sql`DELETE FROM lamp_state_history WHERE entity_id='light.test' AND at='2026-10-31T12:00:00Z'`;
    assert.equal((await sql`SELECT * FROM lamp_state_history WHERE entity_id='light.test'`).length, 3, "duplicate state observations remain in the archive");
    params.delete("transitions_only"); params.set("limit", "100");
    const scenes = await queryHistory("scenes", parseHistoryQuery(params));
    assert.equal(scenes.rows.length, 2);
    assert.deepEqual(scenes.rows.map((row) => row.origin), ["legacy_tap", "recorder"]);
    assert.equal((await sql`SELECT * FROM scene_application`).length, 3, "raw observations remain intact");
    const insights = await queryInsights(params.get("start")!, params.get("end")!, "living");
    assert.equal(insights.scenes.length, 2);
    assert.equal(insights.lamps.length, 2, "brightness-only event is removed before analysis");
    const climate = await queryHistory("climate", parseHistoryQuery(new URLSearchParams({ start: params.get("start")!, end: params.get("end")!, room: "unassigned" })));
    assert.equal(climate.rows[0].temperatureC, 20);
    assert.equal(climate.entities[0].room, "unassigned");
    const none = await queryHistory("climate", parseHistoryQuery(new URLSearchParams({ start: params.get("start")!, end: params.get("end")!, room: "living" })));
    assert.equal(none.availability, "no_sensors");
  } finally { await sql.end({ timeout: 1 }); }
});
