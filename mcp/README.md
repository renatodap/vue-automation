# Living-room lights — MCP connector

A small **remote MCP server** so Claude (phone or desktop) can drive the living
room: read what the lamps are actually doing, apply and author scenes, set
sunset schedules, and pair and name a new Zigbee bulb end to end.

## Why a separate service

The Next app is basePath-mounted at `renatodap.me/vue-automation`, so it does
not own the domain root and cannot serve `/.well-known/*` — and an OAuth issuer
cannot live under a path. So this is a standalone Node service on its own
subdomain (`lights-mcp.renatodap.me`), same as `finance-mcp` and `fitness-mcp`.

## Why it owns no lighting logic

The PWA already implements the entity projections, the scene snapshot rules,
the clamping, and — the one that matters — the judgement in invariant #4 about
reporting a scene that only partly applied. Two implementations of a safety
behaviour is two implementations that drift, and the one that drifts is the one
nobody is looking at.

So every read and write about the house calls a secret-gated `/api/internal/*`
route on the vue-automation app over `MCP_INTERNAL_SECRET`, and this service
owns exactly three things in Postgres: its `mcp_oauth_*` tables, `mcp_audit`,
and `mcp_change_proposal`.

`registry.json` deliberately records **no database** for this app. It has no
database of its own — it borrows the app's — so **`infra db *` must never target
it**. Apply migrations against `vue-automation`.

One exception, structural rather than preference: **the Zigbee mesh and the
Home Assistant registries**, used by `list_zigbee_devices`, `start_pairing`,
`poll_pairing` and `name_device`. The web app has never needed to see the mesh,
so there is nothing there to reuse, and the registries are WebSocket-only —
`config/device_registry/list` and `config/entity_registry/update` have no REST
equivalent at all, and the Next app cannot reach them without taking a
WebSocket dependency for a feature it does not have.

```
Claude ──HTTPS──► lights-mcp.renatodap.me ──HTTP──► renatodap.me/vue-automation ──tailnet──► HA (Pi)
                          │
                          ├──tailnet──► HA WebSocket  [device + entity registries]
                          ├──tailnet──► HA REST       [mqtt.publish → z2m bridge requests]
                          └──tailnet──► Mosquitto :1883 (Pi)   [OPTIONAL enrichment only]
```

Anthropic's cloud can reach this service. It can never reach the Pi.

## Why Zigbee goes through Home Assistant, not through the broker

This connector used to open its own connection to Mosquitto. It cannot, and the
reason is permanent rather than a misconfiguration:

- Mosquitto requires credentials. They live in the Mosquitto / Zigbee2MQTT
  **add-on configuration behind Home Assistant's Supervisor**.
- A long-lived access token — **including an admin one** — is refused by
  `/api/hassio/*` with **HTTP 401**. Verified against the live instance.
- Home Assistant never exposes a config entry's `data` over any API either.

There is no path from the credentials this service *has* to the credentials the
broker *wants*, so `Connection refused: Not authorized` at boot was the end
state, and all four device tools were permanently broken.

Home Assistant, however, is **already authenticated to that broker** — the MQTT
integration owns the connection — and it holds a device registry entry for
every Zigbee device. So it is the bridge, in both directions:

| Need | Through Home Assistant |
|---|---|
| what is joined to the mesh | `config/device_registry/list` — the IEEE address is inside each device's `identifiers`, the z2m friendly name is its `name`, and `config/entity_registry/list` joins the entities on `device_id` |
| open pairing | `POST /api/services/mqtt/publish` → `zigbee2mqtt/bridge/request/permit_join` |
| did anything join | a device reaches the registry only **after** its interview finishes, so `start_pairing` snapshots the registry and `poll_pairing` diffs it. No subscription needed. |
| rename in z2m | `mqtt.publish` → `zigbee2mqtt/bridge/request/device/rename` |
| rename in HA | `config/entity_registry/update` (unchanged) |

**MQTT is optional enrichment now**, and is expected to be unavailable. When a
`MQTT_URL` with working credentials *is* present it adds exactly three things:
live `bridge/event` interview progress on `poll_pairing`, the z2m-only device
fields (`interview_completed`, `supported`, `power_source`), and confirmation
of a bridge request published through Home Assistant. Without it those come
back **null — meaning unknown, not false** — and every tool still works. A
refused broker costs one log line at boot and is then remembered, so it is not
re-attempted on every call.

What the HA path genuinely loses is the **return channel**: a publish is
fire-and-forget, and Zigbee2MQTT answers on `bridge/response/*`, which nobody
is subscribed to. Results carry `confirmed: false` for that, and the tool copy
tells the model to describe it as *unconfirmed* rather than as *failed*.

## Design

- **Stateless Streamable HTTP**, JSON only, `POST /mcp`. One POST in, one JSON
  object out — no SSE, no daemon, no session ids. `GET`/`DELETE` → 405.
- **Both protocol generations.** The handshake era (`initialize`, up to
  2025-11-25) is what Claude's connector speaks in production today and is kept
  working. The 2026-07-28 revision removed protocol-level sessions and the
  handshake with them, so `server/discover` is implemented, the
  `Mcp-Method` / `Mcp-Name` / `MCP-Protocol-Version` routing headers are
  validated against the body (`-32020` on a mismatch), and per-request `_meta`
  is read where present. The transport never had to change: stateless JSON with
  no session id started as a constraint and is now the specified shape.
- **OAuth 2.1** — public client + PKCE (S256 only), dynamic registration,
  passphrase consent, opaque bearer tokens with rotating refresh. Dynamic client
  registration is deprecated by 2026-07-28 in favour of Client ID Metadata
  Documents and is kept working anyway, because deprecated is not removed and
  Claude still uses it. **CIMD is deliberately not implemented**: it would have
  this server fetch an arbitrary caller-supplied URL, and this server sits on the
  tailnet with a route to the Pi. That is an SSRF surface to add on purpose with
  an address allow-list, not casually.
- **Tool failures are successful JSON-RPC results carrying `isError`**, so the
  model reads them and corrects itself. An unknown tool *name* is the one
  genuine protocol error.
- **Every result carries `structuredContent` and a mirrored text block.**

## Tools

Reads (all `readOnlyHint: true`, so a client can auto-approve them):

| Tool | What it answers |
|---|---|
| `get_room` | every lamp: on/off, brightness, Kelvin, colour, **reachability** |
| `get_scenes` | scenes merged with label, accent, order, tap count, aliases |
| `get_lamp(entity_id)` | one lamp, including the range that bulb can actually tune to |
| `get_schedules(include_config?)` | automations, enabled state, last fired |
| `get_history(days)` | tap history: per scene, by hour, most recent |
| `list_zigbee_devices` | the mesh itself, from HA's device registry |
| `poll_pairing(since?)` | devices that appeared since `start_pairing` snapshotted the registry |
| `list_pending_changes` | proposals awaiting approval — diffs, never tokens |
| `query_sql(query, max_rows?)` | last-resort read-only SQL over the three metadata tables |

Writes — named mutations with typed arguments, no generic writer:

| Tool | Notes |
|---|---|
| `apply_scene(scene_id, transition?)` | reports partial application by name |
| `set_lamp(entity_id, on?, brightness?, kelvin?, hs?, transition?)` | `entity_id: "all"` drives every lamp in one call |
| `save_scene(name, from_current)` | via `POST /api/config/scene/config/{id}`, the durable endpoint |
| `rename_scene(entity_id, label)` | the display label; `null` restores HA's own name |
| `set_scene_accent(entity_id, accent)` | hex, or `null` |
| `reorder_scenes(entity_ids[])` | send the FULL order; omitted scenes are unpinned |
| `set_scene_aliases(entity_id, aliases[])` | replaces the set |
| `set_schedule(name, when, …)` | time or sunrise/sunset offset; pass `id` to edit in place |
| `set_schedule_enabled(entity_id, enabled)` | pause without deleting |
| `start_pairing(seconds)` | `permit_join` via `mqtt.publish`; snapshots the registry; returns before anything has joined |
| `name_device(ieee_address, friendly_name, entity_id?)` | renames in **both** systems |

Destructive changes go through **propose → commit**:

`propose_overwrite_scene` · `propose_delete_scene` · `propose_delete_schedule`
→ each returns a human-readable diff and an opaque single-use token with a
10-minute TTL → `commit_change(token)` applies it.

Not MCP elicitation: elicitation is optional for clients, so a client that does
not implement it skips the question and the destructive call goes straight
through. Two tool calls with a token in between cannot be skipped by anybody.

### The three tools that carry the real rules

- **`apply_scene`** — Home Assistant applies a scene to the lamps it can reach
  and stays silent about the rest, and silence reads as success. The result
  carries `fully_applied`, `unreachable` and `did_not_match`, compared against
  what the scene actually stores, so the model names the lamps that did not
  follow. "Cozy Cinema is on" while the floor lamp sits dark is the failure this
  connector exists to prevent, and the fix is usually physical.
- **`save_scene`** — writes through HA's scene-editor API, not `scene.create`.
  Scenes made by `scene.create` live in memory and vanish on restart
  ([core#133912](https://github.com/home-assistant/core/issues/133912)). The
  config endpoint writes to `scenes.yaml` and reloads, so the scene survives a
  reboot. It is undocumented ([core#68453](https://github.com/home-assistant/core/issues/68453)),
  which is why every call to it lives in one adapter in the app.
- **`name_device`** — Zigbee2MQTT runs with `homeassistant_rename: false`, so
  renaming in z2m does **not** rename the HA entity. This does the z2m rename
  (`bridge/request/device/rename`, published through `mqtt.publish`) *and* the
  entity-registry update, and reports `fully_renamed: false` with the reason
  when only one half lands. **Both halves always run**: a failure in the first
  does not abandon the second, because skipping it would *guarantee* the two
  systems disagree — the exact outcome the tool exists to prevent. z2m is
  addressed by `zigbee2mqtt_name` (the device registry's `name`), never by
  `name_by_user`, which is a Home-Assistant-side override z2m has never heard of.

## Audit trail

Every call — reads included — lands in `mcp_audit` with the arguments verbatim,
before/after state for mutations, duration and any error. Reads are logged
because they are the part that explains *why* a write happened. The write runs
on its own connection pool and never throws; a failed audit write must not turn
a working tool into a broken one.

## Degradation

The lights must work when the database does not (invariant #2).

| Down | What still works |
|---|---|
| Postgres | every tool. Labels fall back to HA's names, history reports *unavailable* rather than zero, proposals fall back to memory. Only NEW authorizations are refused; a live token keeps working through a short outage. |
| MQTT | **everything.** This is the expected state. `interview_completed`, `supported`, `power_source` and `bridge_events` come back null (unknown), and bridge requests are reported as unconfirmed rather than as verified. |
| `HA_BASE_URL`/`HA_TOKEN` unset | scenes, lamps, schedules and history. The four Zigbee tools refuse, naming those variables and pointing at `get_room` for the lights that already exist. |
| Home Assistant / tailnet | nothing about the house can be read or changed, and the connector says so instead of guessing. |

## Migrations

`homeassistant/migrations/2026-08-14_mcp-connector.sql` creates `scene_alias`
(the app's) plus this service's four tables. Safe to run twice. The connector
also creates its own tables at boot, so a fresh deploy works before anyone
remembers to run it.

```bash
/Users/renatodaprado/dev/Persimmon/infra/bin/infra db exec vue-automation -- \
  bash -c 'psql "${DATABASE_URL%%\?*}" -f -' < ../homeassistant/migrations/2026-08-14_mcp-connector.sql
```

## Deploy (Coolify on persimmon-eu)

**Prerequisite, and it is a human step: DNS.** `renatodap.me` is registered at
Namecheap and is *not* on Cloudflare — there are no API credentials for it — so
the record has to be added by hand before anything else will work:

> `lights-mcp.renatodap.me` → **A** → `168.119.159.112`

Once it resolves, `docker restart coolify-proxy` so Traefik retries the Let's
Encrypt challenge; it caches a self-signed fallback from before DNS pointed
here and will otherwise keep serving it.

Then:

- **App**: repo `renatodap/vue-automation`, **base directory `mcp/`**, Nixpacks
  (build `npm run build`, start `npm start`), port **3000**, domain
  `lights-mcp.renatodap.me`.
- **Env on this app**: `APP_INTERNAL_URL`, `MCP_INTERNAL_SECRET`,
  `DATABASE_URL` (same value as the vue-automation app's), `MCP_PASSPHRASE`,
  and `HA_BASE_URL` + `HA_TOKEN` (an **admin** token — the registries refuse a
  non-admin one). `MQTT_URL` is optional enrichment and can be left unset. See
  `.env.example`.
- **Env on the vue-automation app**: `MCP_INTERNAL_SECRET`, the **same value**.
  Without it every internal call 401s and every tool fails.
- `middleware.ts` already lists `/api/internal` under `PUBLIC_PREFIXES` — those
  routes carry their own bearer secret and check it themselves.

## Add to Claude

Settings → Connectors → Add custom connector →
`https://lights-mcp.renatodap.me/mcp` → authorize with the passphrase.

## Local dev

```bash
cp .env.example .env   # fill APP_INTERNAL_URL, MCP_INTERNAL_SECRET, DATABASE_URL, MCP_PASSPHRASE
npm install && npm run dev
```

```bash
npm run build && npm test
```

The tests need no database, no Home Assistant and no broker: the far side of
the wire is a controllable fake app (`tests/_fake-app.mjs`) and a controllable
fake Home Assistant (`tests/_fake-ha.mjs`, WebSocket registries plus the REST
service surface on one port), and the 401 path is tested precisely in the state
where nothing is configured. They cover the 401 and the discovery chain,
propose→commit token handling, the relaying of a partial scene application, and
the Zigbee tools in the two states that matter: `MQTT_URL` entirely absent
(`zigbee-ha.test.mjs`) and `MQTT_URL` set with the broker refusing
(`mqtt-optional.test.mjs`). `name_device`'s three partial outcomes — z2m only,
Home Assistant only, neither — each have a test, because a half-done rename
reported as done is the failure that tool exists to prevent.
