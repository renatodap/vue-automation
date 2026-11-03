import test from "node:test";
import assert from "node:assert/strict";
import { GET as lampHistory } from "../src/app/api/internal/lamp-history/route";
import { GET as climateHistory } from "../src/app/api/internal/climate-history/route";
import { GET as roomInsights } from "../src/app/api/internal/room-insights/route";
import { historyResponse } from "../src/lib/history-http";

test("all internal history surfaces fail closed before parsing or querying", async () => {
  const original = process.env.MCP_INTERNAL_SECRET;
  delete process.env.MCP_INTERNAL_SECRET;
  try {
    for (const handler of [lampHistory, climateHistory, roomInsights]) {
      assert.equal((await handler(new Request("https://example.test/api/internal/history?limit=invalid"))).status, 401);
    }
  } finally {
    if (original === undefined) delete process.env.MCP_INTERNAL_SECRET;
    else process.env.MCP_INTERNAL_SECRET = original;
  }
});

test("history API distinguishes invalid queries from database unavailability and never caches either", async () => {
  const invalid = await historyResponse(new Request("https://example.test/api/history/lamps?limit=1001"), "lamps");
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).reason, "invalid_query");
  assert.match(invalid.headers.get("cache-control")!, /no-store/);
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const unavailable = await historyResponse(new Request("https://example.test/api/history/lamps"), "lamps");
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).reason, "history_unavailable");
    assert.match(unavailable.headers.get("cache-control")!, /no-store/);
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
});
