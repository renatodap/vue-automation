# History audit operations

Historical observations are stored permanently in the **PWA database**, never
used as current lamp state. There is no retention job or cascading deletion for
the history tables. Database backups are still necessary: no application can
make a deleted database permanent.

## Deploy after reviewing `history-audit`

No application was deployed or branch pushed during implementation. The additive
migration and real backfill were run against the app's existing database.

1. Apply/reapply the idempotent migration before the new app/connector:

   ```bash
   /Users/renatodaprado/dev/Persimmon/infra/bin/infra db exec vue-automation -- \
     bash -c 'psql "${DATABASE_URL%%\?*}" -v ON_ERROR_STOP=1 -f -' \
     < homeassistant/migrations/2026-11-03_history-audit.sql
   ```

2. In the existing Coolify web application, use Node **22 or newer**, build
   `npm ci && npm run build`, start **`npm run start:history`**, and keep one
   replica. This starts Next and the collector together. A failed collector
   restarts independently with backoff, so a database outage cannot take light
   controls down. If Next exits, the container exits so Coolify can restart it.
   Keep the container restart policy enabled. Existing `HA_BASE_URL`, `HA_TOKEN`,
   and `DATABASE_URL` are used. Keep
   `NEXT_BASE_PATH=/vue-automation` and `is_stripprefix_enabled=false`.
3. Deploy the reviewed branch through the normal Coolify workflow, then deploy
   `mcp/` with its existing build/start commands. Existing `MCP_INTERNAL_SECRET`
   and `APP_INTERNAL_URL` work unchanged. No token is sent to the browser.
4. Confirm `history_live_connected` and `history_reconciled` in container logs,
   `/api/history/lamps` reports current sync, and `history_sync` contains both
   `recorder` and `events` with recent success times. Watch for an open
   `history_gap` and errors after restarts. Ensure the app database is included
   in the server's backup policy and verify restore separately.

The worker subscribes to HA `state_changed`, pings the connection, reconnects
with backoff, and reconciles the recorder every **3 minutes**. A session advisory
lock permits only one worker; a separate lock prevents simultaneous backfills.
It observes the house and does not issue light or other HA service commands.
An alternative deployment is a separate no-domain Coolify worker with base dir
`web/` and start `npm run history:watch`; then leave the web command `npm start`.

For installations intentionally using only polling, Coolify Scheduled Tasks can
run `npm run history:sync` in the app container every `*/3 * * * *`. The guarded
`POST /api/internal/history-sync` is an alternative for an external scheduler;
send `x-internal-secret: $MCP_INTERNAL_SECRET`. The route takes no arbitrary
query or HA operation. **Polling alone cannot preserve fields HA omits from its
recorder**, which the live November 3 inventory demonstrated. The websocket
worker is the full-attribute collection path.

## Backfill and recovery

With normal server environment variables loaded, from `web/`:

```bash
npm run history:sync -- --discover
npm run history:sync -- --backfill
# Explicit replay, including a prior period (idempotent):
npm run history:sync -- --backfill --start 2026-10-24T00:00:00Z --end 2026-11-03T00:00:00Z
```

The first run finds the oldest available retained observation with a compact
discovery query, then imports full responses one day at a time. Normal runs
resume from a committed checkpoint with a 15-minute overlap and a 2-minute
recorder-latency allowance, at most three days per run. Re-run `--backfill` after
a long outage to catch up immediately. Each day and its cursor commit together;
failed days roll back. Rich websocket data survives poorer REST replays.

History REST uses `significant_changes_only=0`, no minimal/no-attributes option
on import, and `skip_initial_state` to avoid synthetic midnight events. Keys use
`last_updated`, preserving attribute changes and PostgreSQL microseconds. Scene
keys use HA's activation timestamp so reloading a scene does not create another
application. Current snapshots enrich only their original timestamp. Unknown
values remain null; `unavailable`/`unknown` observations are retained. °F and K
are converted to °C only when the source unit is known. Raw attributes remain.

Old scene taps are copied out of the table whose rows cascade with scene metadata
deletion. New app applications capture HA's activation/context where available.
Raw observations are preserved; the timeline/insights coalesce a legacy tap only
if the same scene has a recorder/app observation within five seconds. Context
source is unknown unless supported by a user id, a positively observed
automation trigger, or an unambiguous exact scene context. It does not identify
the physical person and does not prove every lamp received the command.

The archive cannot recover already purged changes, attributes excluded by HA,
or a device/sensor HA never recorded. Disconnected websocket intervals are
retained as `history_gap`, even after REST fills the surviving state changes,
because omitted color/context cannot be assumed recovered. If the Pi is offline,
the worker retries and the app displays stale collection status; light controls
still operate independently whenever HA itself is reachable.

## Recorder retention and raw database inspection

HA's REST history reads the recorder directly; there is no separate fixed API
lookback limit in the inspected HA **2026.8.1** implementation. The configured
purge policy and exclusions determine what survives. HA normally defaults to
10 days for detailed history and retains long-term sensor statistics separately.
Statistics are aggregates, not exact historical events, so do not insert them as
raw readings. See [Recorder](https://www.home-assistant.io/integrations/recorder/),
[History](https://www.home-assistant.io/integrations/history/), and the
[versioned REST implementation](https://github.com/home-assistant/core/blob/2026.8.1/homeassistant/components/history/__init__.py).

Live access found a ten-day retained range but could not inspect the configured
`recorder:` block: HA REST config does not expose `purge_keep_days`, Supervisor
access returned 401, and Pi SSH rejected the available local keys. **Ten days is
consistent with the default, not a verified configuration value.** The stored
`retention_days` remains null. Do not change HA retention just to populate an app.

With authorized Pi shell/backup access, read `/config/configuration.yaml` and
included YAML for `recorder`, `db_url`, `purge_keep_days`, `auto_purge`, `include`
and `exclude`. Do not print `db_url` credentials. For default SQLite, make a
consistent backup using SQLite's backup API (copying only the live `.db` without
its WAL is unsafe):

```bash
sqlite3 /config/home-assistant_v2.db ".backup '/share/recorder-audit.db'"
sqlite3 -readonly /share/recorder-audit.db <<'SQL'
SELECT datetime(min(last_updated_ts),'unixepoch') AS first_utc,
       datetime(max(last_updated_ts),'unixepoch') AS last_utc, count(*)
FROM states;
SELECT m.entity_id, min(s.last_updated_ts), max(s.last_updated_ts), count(*)
FROM states s JOIN states_meta m ON m.metadata_id=s.metadata_id
WHERE m.entity_id LIKE 'light.%' OR m.entity_id LIKE 'climate.%'
   OR m.entity_id LIKE 'sensor.%' OR m.entity_id LIKE 'scene.%'
GROUP BY m.entity_id;
SELECT m.entity_id, s.last_updated_ts, s.state, a.shared_attrs,
       hex(s.context_id_bin), hex(s.context_parent_id_bin), hex(s.context_user_id_bin)
FROM states s JOIN states_meta m ON m.metadata_id=s.metadata_id
LEFT JOIN state_attributes a ON a.attributes_id=s.attributes_id
WHERE m.entity_id LIKE 'light.%'
ORDER BY s.last_updated_ts;
SQL
```

Inspect the installed schema first (`.schema states`) because HA migrations vary.
Use the configured MariaDB/Postgres database instead if `db_url` overrides SQLite.
Compare raw rows with REST: extra surviving attributes/context can be recovered
from a read-only export; binary context identifiers require HA's ULID conversion,
not guessing that hex equals the REST context string. Older backups may contain
purged rows. Import a reviewed export through the same normalization/upsert path;
never copy the HA database over the app's database.

## Room mapping, APIs and suggestions

Lamp grouping stays override → compiled static map → Unassigned. Sensor rooms
use explicit `HISTORY_CLIMATE_ROOMS` JSON if configured, otherwise HA entity/device
areas named Living Room/Living/Bedroom, otherwise Unassigned. A sensor assigned to
Unassigned is visible; its readings are not silently attributed to both rooms.
No room is created dynamically. Insight timezone defaults to HA's discovered
timezone, optionally overridden by `HISTORY_TIME_ZONE`.

- Session-protected GET `/api/history/lamps`, `/api/history/climate`,
  `/api/history/scenes`: `start`, `end`, optional `entity_id`, `room_id`, `limit`,
  `cursor`; at most 31 days and 1,000 rows per page.
  The PWA requests `transitions_only=true` for its lamp timeline; the default
  API/MCP history retains attribute-only observations as well.
- GET `/api/insights`: optional `room_id`, `days` (1–90). Data-heavy windows fail
  explicitly instead of silently sampling. Responses include coverage, sync
  freshness, gaps, timezone, sample counts and confidence.
- MCP `get_lamp_history`, `get_climate_history`, `get_room_insights` use named
  authenticated internal GET routes and the existing per-call audit mechanism.
  Existing `get_history` remains the scene-tap tool.

Typical timing counts switching dates, not repeated brightness messages. Room
off means all known lamps are off. Climate baselines weight each observed
day/hour equally; unobserved intervals are not filled. “Usually off” needs at
least four prior matching weekdays explicitly off at the current minute and
80% agreement. Anomalies require fresh HA reads. No AI model or automated light
actuation is involved.

## Verification

```bash
cd web && npm test && npx tsc --noEmit && npm run build
cd ../mcp && npm run build && npm test
```

Ingestion tests start/stop an isolated temporary PostgreSQL cluster if
`initdb`/`pg_ctl` are available. Query integration can also run against a separate
disposable database with `HISTORY_TEST_DATABASE_URL`; **never point that variable
at the live app database**. Tests cover microsecond storage/pagination, JSON,
rollback/replay, units, context ambiguity, gaps, DST, false-positive suppression,
authentication, and the MCP transport. Screenshots and the real inventory/count
report are recorded in the accompanying validation report.
