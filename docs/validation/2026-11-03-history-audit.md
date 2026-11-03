# History audit validation — 2026-11-03

Branch: `history-audit`. No push or application deployment. The additive SQL
migration and backfill were applied to the **existing PWA database** through the
Persimmon SSH tunnel. Credentials came from the deployed app configuration and
were not printed or committed. No HA service/lighting mutation was performed.

## Live entity discovery

`GET /api/states`: **186 entities**. HA **2026.8.1**, timezone
**America/New_York**, household temperature unit °F. **15 lights**, **9 scenes**,
**0 climate entities**, **0 temperature sensors**, **0 humidity sensors**.
All 57 `sensor.*` entities were inspected by `device_class`; entity/device/area
registries were also checked. The weather entity is not a room sensor.

| Light entity | Name | Resolved room |
|---|---|---|
| `light.abajour` | Abajour | Living |
| `light.floor_lamp` | Floor Lamp | Living |
| `light.shelf_lamp` | Shelf Lamp | Living |
| `light.tv_lamp` | TV Lamp | Living |
| `light.0xb4e8428fd6070000` | kitchen pendant 1 | Living |
| `light.0xb4e8428ffab10000` | kitchen pendant 2 | Living |
| `light.0xa4c138939b2d0b23` | keyboard strip | Living |
| `light.0xa4c138f7081797c5` | tv console strip | Living |
| `light.0xa4c1381575d783a5` | counter strip | Living |
| `light.0xa4c13804ed12c941` | TV LED | Living (existing override) |
| `light.0xb4e8428f428b0000` | bedroom lamp | Bedroom |
| `light.0xb4e84290af510000` | bedroom floor lamp | Bedroom |
| `light.0xb4e842918a2f0000` | bedroom bedside lamp | Bedroom |
| `light.0xa4c13898403028f1` | bedroom tv strip | Bedroom |
| `light.0xb4e84290c5df0000` | kitchen light | Unassigned |

The nine scene IDs are `scene.warm_20`, `scene.orange_70`, `scene.bright`,
`scene.room_tv`, `scene.romantic`, `scene.living_room_tv_2`,
`scene.warm_living_room_no_floor`, `scene.purple_orange`, and
`scene.p_o_with_floor_lamp`.

## Real backfill and replay

| Table | Rows | Entities with observations | First UTC | Last UTC |
|---|---:|---:|---|---|
| `lamp_state_history` | **653** | 15 | 2026-10-24 11:50:44.870969 | 2026-11-03 12:01:48.877409 |
| `climate_history` | **0** | 0 | — | — |
| `scene_application` | **96** | 8 | 2026-08-25 02:37:16.973264 | 2026-11-02 20:31:10.391928 |

The scene table contains **79 legacy taps** and **17 recorder/current-activation
observations**. These are raw observation counts, not 96 distinct successful
physical scene applications. Some overlap; the presentation coalesces matching
legacy taps. Current scene entities can report an activation older than retained
recorder rows, which accounts for the September activation coverage. The ninth
scene has no known activation in the sources examined.

The initial import fetched **664 REST observations across 11 daily windows**.
A second full replay used midnight-aligned windows from October 24 through
November 3 13:06:11.975 UTC, again fetched 664 observations, and left all three
row counts **unchanged**. This also exercised different day boundaries. SQL
confirmed every lamp attributes value is a JSON object; microseconds are intact.

The live recorder response contains only `friendly_name` for historical lights,
even with `significant_changes_only=0` and full attributes requested. It also
omits context. Current snapshots enriched their original last-updated rows:
6 lamp rows have brightness and 15 have context. Earlier brightness/color and
source remain null/unknown; they were not fabricated. A ten-day retention range
is observed, but the configured purge policy is **unverified** because Pi SSH
rejected available keys and Supervisor access returned 401. See the
[raw-recorder recovery instructions](../history-audit.md#recorder-retention-and-raw-database-inspection).

The live collector authenticated, subscribed and logged
`history_live_connected`; its heartbeat reached 13:19:48 UTC. It was then
stopped intentionally, leaving an open collection gap. It is **not running in
production** until deployed. The smoke test changed no lamps and added no
synthetic climate data. Historical room views use the currently resolved room
assignments; past moves before this archive cannot be reconstructed.

## Verification

- Web TypeScript, web production build with `NEXT_BASE_PATH=/vue-automation`,
  MCP build and MCP tests.
  MCP: 89 passed. Web: 48 passed plus one separately exercised optional
  PostgreSQL query-integration test.
- Web tests cover normalization, PostgreSQL timestamp/JSON fidelity,
  rollback/resume, poorer replay, scene ambiguity, query validation, gaps,
  DST, conservative hints, scheduler auth, and worker lifecycle. Six supervisor
  checks verify independent collector retries, capped backoff, recovery, Next
  failure and orderly shutdown. Temporary PostgreSQL clusters are removed
  afterward.
- Optional query integration ran separately against a disposable local
  database and passed migration reapplication, microsecond pagination, room
  filtering, transition-only views, and duplicate coalescing. Its normal
  environment-gated test is skipped when no disposable DB URL is supplied.
- Browser: 390×844 and 1440×1000, room/day/week filters, one main scroller,
  no body/horizontal overflow, visible footer; missing sensor, collection gap,
  unavailable database/retry, and accessible chart states.
  A production-server browser pass confirmed every history/live-state API call
  retained `/vue-automation/api/` under the path-mounted build.
- Suggested scene button used the normal action and offered `Undo Purple/orange`;
  its POST was intercepted and validated as `{entityId:'scene.purple_orange'}`.
  No physical scene was applied by this test.

## Screenshots

Real HA/PWA history: [phone](2026-11-03-history-audit/history-phone-real.png),
[desktop](2026-11-03-history-audit/history-desktop-real.png).

Browser-only fixtures, explicitly not real sensor readings:
[temperature, phone](2026-11-03-history-audit/history-phone-climate-fixture.png),
[temperature, desktop](2026-11-03-history-audit/history-desktop-climate-fixture.png),
[Home suggestions](2026-11-03-history-audit/home-suggestions-fixture.png),
[Scenes suggestion](2026-11-03-history-audit/scenes-suggestions-fixture.png).

## Changed areas and remaining operator work

- `homeassistant/migrations/2026-11-03_history-audit.sql`: append-only archive,
  discovery, progress, gap and context tables.
- `web/src/lib/history-*.ts`, `insights.ts`: discovery, normalization,
  ingestion, bounded queries and deterministic analysis.
- `web/scripts/history-*`, `start-with-history.mjs`, `package*.json`,
  `.env.example`: backfill CLI, collector and supervised production startup.
- `web/src/app/api/history/*`, `api/insights`, internal history routes:
  uncached session/shared-secret read surfaces and bounded scheduled ingestion.
- History page/panel, suggestions, house provider, room/scene panels, shell,
  tab bar and CSS: matching phone/desktop UI and ordinary-action suggestions.
- `web/src/lib/db.ts`, `ha.ts`, scene application routes: preserve activation
  context and durable scene observations, normalize the known DB URL suffix.
- `mcp/src/{api,history-input,rpc,tools}.ts`, MCP README/tests: three named,
  bounded, audited read tools.
- Web tests, README, operations/design/validation docs and screenshots.

Renato: review/deploy with `npm run start:history`, confirm database backups,
and connect a room temperature/humidity sensor if climate history is desired.
Optionally assign the currently Unassigned kitchen light through the existing
room-assignment tool. Pi recorder access or a backup is only needed to verify
retention/exclusions or attempt recovery beyond the accessible API data.
