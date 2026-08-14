# Claude MCP connector — architecture

**Date:** 2026-08-14
**Status:** Design, ahead of the implementation. `mcp/` currently holds a scaffold
(`package.json`, `src/env.ts`, `src/db.ts`) and no server; this is the shape it
has to take, written before the code so the constraints aren't rediscovered.
**Question:** let Claude (phone, desktop, Cowork) drive the apartment — read lamp
state, apply scenes, author new ones, and pair a new bulb — without ever handing
a model an unconstrained path to the house.

Every protocol claim below is checked against the MCP specification revision
**2026-07-28** (the current one) or against a primary vendor source. Where the
fleet's existing connectors disagree with the current spec, the disagreement is
stated rather than smoothed over.

---

## 0. What already exists, and what this borrows from

Two connectors in this fleet already do the OAuth-and-tools dance, and the third
should copy them rather than re-derive:

| | `dap-fitness/mcp` | Aslan `aslan-mcp-connector` | this |
|---|---|---|---|
| Runtime | Node, standalone, `fitness-mcp.renatodap.me` | PHP on cPanel, in-app | Node, standalone, `lights-mcp.renatodap.me` |
| Backing store | Postgres | MySQL | Postgres **+ Home Assistant + Mosquitto** |
| Read surface | broad (`query_sql` + named tools) | named tools only | named tools + a constrained read |
| Writes | named, typed | none | named, typed, **propose→commit for destructive** |

The third column is the one that is different in kind. The other two connectors
read and write *rows*. This one actuates *hardware in a room a person is standing
in*, and it can permit an unknown Zigbee device to join a network. That is why
the write-safety section (§5) is the longest one here.

**Scope note, in the spirit of the Swift research doc's §0:** at the time of
writing, Home Assistant holds two paired lamps and the `scene_meta` / `scene_tap`
tables exist. A connector that assumes five scenes and four bulbs will ship
against a room that does not exist yet. Design against `/api/states`, not against
`README.md`.

---

## 1. Why a standalone service on its own subdomain

The short version: **the Next app does not own the domain root, so it cannot
serve `/.well-known/*`, so it cannot be an OAuth issuer.**

The app is path-mounted at `renatodap.me/vue-automation` (see `CLAUDE.md`
"Deploy"). Traefik routes only `/vue-automation/*` to that container, and
`is_stripprefix_enabled` stays `false` so Next owns the prefix. Consequently:

- A request for `https://renatodap.me/.well-known/oauth-protected-resource`
  never reaches the app. There is no route rule that would send it there, and
  adding one would mean the app claims paths at the domain root — which is the
  whole thing the path-mount arrangement exists to avoid.
- Serving the document at `renatodap.me/vue-automation/.well-known/…` does not
  help. RFC 8414 §3.3 requires the `issuer` value to be byte-identical to the
  base URL the document is served from, and RFC 9728 derives the protected
  resource metadata path from the resource identifier. A conformant client
  rejects the *entire* document on a mismatch, and the failure is silent: the
  connector simply never finishes authorizing, with nothing in any log.

A subdomain makes the issuer a bare origin — `https://lights-mcp.renatodap.me` —
with no path component, which is the case every OAuth library gets right by
default. `dap-fitness/mcp` is standalone for exactly this reason and says so in
its README: *"an OAuth issuer can't live under a path."*

Secondary benefits, none of which are the reason but all of which are real: the
connector can be deployed and restarted without touching the PWA; its blast
radius is its own container; and it can hold a long-lived MQTT subscription,
which a Next route handler on a serverless-shaped runtime cannot.

**Cost accepted:** two services now hold `HA_TOKEN`, and two services now need
the tailnet. Rotating the token is a two-place edit. That is cheaper than the
alternative, which is not having a working connector.

---

## 2. The reachability matrix — the constraint that forces the design

Claude's custom connectors "connect to your remote MCP server from Anthropic's
cloud infrastructure, rather than from your local device", and that server "must
be reachable over the public internet"
([Claude Help Center](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)).
That single sentence determines the whole topology.

| From ↓ / To → | `lights-mcp` (Persimmon) | HA (Pi, `100.85.128.101`) | Postgres (Persimmon) | Mosquitto (Pi) |
|---|---|---|---|---|
| **Anthropic's cloud** | ✅ HTTPS, public | ❌ **never** | ❌ never | ❌ never |
| **`lights-mcp` (Persimmon)** | — | ✅ tailnet | ✅ localhost/internal | ✅ tailnet |
| **The phone / browser** | ✅ (but doesn't) | ❌ | ❌ | ❌ |

Read the top row again. **Anthropic can reach exactly one thing, and it is a
service we wrote.** Nothing about the house is exposed publicly; the Pi has no
port forward, no public DNS record, and no inbound path from the internet. The
connector is the entire attack surface, and everything it will not do is
something that cannot be done.

This is the same argument as invariant #1 ("never call Home Assistant from the
browser"), one layer out: the untrusted party is now a model in someone else's
datacenter instead of a browser, and the token still never leaves Persimmon.

The corollary that costs money if forgotten: **the connector is useless while
Persimmon is down or the tailnet is broken, and it degrades independently of the
PWA.** Both fail together only because they share the tailnet, not because they
share code.

---

## 3. Transport — stateless Streamable HTTP, JSON only

`POST /mcp`. One JSON-RPC message in, one JSON object out. No SSE, no session
IDs, no daemon holding state between requests.

This started life as a shared-hosting workaround (the Aslan connector runs on
shell-less cPanel, where nothing long-lived is possible). As of MCP revision
**2026-07-28 it is simply the specified shape**: that revision explicitly
*removed* the GET stream endpoint and removed protocol-level sessions
([Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).
Building stateless is now the mainstream choice, not the constrained one.

The rules, each of which is a silent failure if broken:

- **`GET` and `DELETE` on `/mcp` → `405 Method Not Allowed`.** Don't advertise a
  stream you can't hold open. An older client that opens a GET stream is told no,
  clearly.
- **Never mint an `Mcp-Session-Id`; ignore one if a legacy client sends it.**
  Nothing is stored between requests, so there is nothing a session could name.
  Consequently do **not** enforce "initialize must come first" — answer each POST
  on its own merits.
- **A notification (no `id`) → `202 Accepted` with an *empty* body.** Serializing
  anything at all, even `{}`, is a protocol violation that some clients hang on.
- **Reject an unrecognized `Origin` with 403; ALLOW an absent one.** The spec
  requires `Origin` validation against DNS rebinding, and requires 403 when a
  present `Origin` is invalid. But Claude calls server-to-server from Anthropic's
  backend (§2) and sends no `Origin` at all — rejecting an absent header rejects
  every real client.
- **Support both protocol eras.** Revisions ≤ `2025-11-25` do the `initialize`
  handshake; `2026-07-28` carries `io.modelcontextprotocol/protocolVersion` in
  each request's `_meta`, mirrors it into an `MCP-Protocol-Version` header, and
  offers `server/discover` in place of the handshake. A server that speaks only
  the modern era must answer an unknown version with `400` and an
  `UnsupportedProtocolVersionError` listing what it supports — an empty or
  unrecognized 400 body is the signal that tells a client to fall back to
  `initialize`, so returning a bare 400 makes modern clients downgrade.
- **Validate the mirrored headers against the body.** `2026-07-28` requires
  `Mcp-Method`, and `Mcp-Name` on `tools/call` / `resources/read` / `prompts/get`.
  A mismatch **MUST** be `400` with JSON-RPC error `-32020` (`HeaderMismatch`).
  The reason is worth internalizing: an intermediary may route on the header while
  the server executes on the body, and a divergence between the two is a
  confused-deputy bug waiting to happen.
- **Declare only the capabilities you implement.** Advertising `resources` or
  `logging` obliges you to answer those methods; `listChanged: true` promises
  pushes that a stateless server cannot send.
- **A failed tool is a *successful* JSON-RPC result carrying `isError`** —
  including input validation — so the model sees the message and retries with
  better arguments. A JSON-RPC error surfaces an opaque failure to the human
  instead. The one exception is an unknown tool *name*, which is a genuine
  protocol error.

---

## 4. The 401 is the most important line in the service

The discovery chain, in order, every link required:

```
POST /mcp  (no token)
  └─ 401 + WWW-Authenticate: Bearer resource_metadata="…", scope="…"
       └─ GET /.well-known/oauth-protected-resource        (RFC 9728)
            └─ GET /.well-known/oauth-authorization-server (RFC 8414)
                 └─ client id: metadata document | pre-registered | DCR
                      └─ GET /oauth/authorize  + PKCE S256 + resource=…
                           └─ POST /oauth/token
                                └─ POST /mcp  Authorization: Bearer …
```

**The 401 must be emitted at the HTTP layer, before the JSON-RPC dispatcher
runs.** This is not a style preference. Once a tool handler has returned, the
response is already committed to being a `200`, and Claude does **not** honor
`WWW-Authenticate` on a 200. Return a polite
`{"isError": true, "content": "please sign in"}` instead and that text is handed
to the model as a tool result: the user sees Claude say "you need to sign in",
with **no Connect button and no way to proceed**. The connector looks broken and
is unfixable from the client side.

The rest of the chain, with the traps:

- **MCP servers MUST implement RFC 9728 protected resource metadata**, and
  clients MUST use it for authorization-server discovery. Serve it at both
  `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-protected-resource/mcp` — RFC 9728 inserts the resource
  path, and clients differ on which they request.
- **`issuer` byte-identical to the base URL** (RFC 8414 §3.3). On a subdomain
  this is free; see §1 for why that was the point.
- **State `token_endpoint_auth_methods_supported: ["none"]` explicitly.** RFC
  8414 defaults it to `client_secret_basic`, and a public client holding no
  secret will then attempt Basic auth against an endpoint with no secret.
- **Advertise `S256` only.** Offering `plain` invites a downgrade.
- **Only the first entry of `authorization_servers` is read.** One issuer, no
  fallback list.
- **Include `scope` in the challenge**, per RFC 6750 §3 — the spec now SHOULDs
  this, and it stops the client from requesting more than the connector needs.
- **`offline_access` belongs only in authorization-server metadata**, never in
  protected-resource metadata or the challenge. The spec is explicit: refresh
  tokens are a client convenience, not a resource requirement.
- **Accept an absent `resource` parameter but refuse one naming a different
  resource.** Shipping clients vary; a request naming someone else's resource is
  asking you to mint a token for another server.
- **Dynamic Client Registration is deprecated** as of `2026-07-28`, retained only
  for authorization servers that don't support Client ID Metadata Documents.
  Implement DCR because today's Claude uses it; don't build anything that assumes
  it is the only path.
- **Opaque random tokens, SHA-256 hashed at rest — not JWT.** A token issued by
  any other server has no row in the table, so MCP's hardest requirement (never
  accept a token that wasn't issued for you) becomes *structural* instead of a
  check someone can forget. Revocation is one `UPDATE`; there is no signing key
  to lose. Stamp the audience anyway.
- **Every auth failure returns the same 401** — missing, malformed, expired,
  revoked, wrong audience. Distinguishing them tells an attacker which guess was
  closer.
- **Verify on every request.** There is no session to trust (§3), which for once
  makes the secure thing and the easy thing the same thing.

Consent is a single passphrase, as in `dap-fitness/mcp` — one user, no accounts,
matching the PWA's `APP_PASSPHRASE` model. But note the asymmetry: **dynamic
registration is open to the internet, so a live session is authentication, never
authorization.** Require explicit consent on every authorize, and name the
verified `redirect_uri` host on the screen rather than the client's
self-asserted name.

---

## 5. Write safety — named typed mutations, and nothing else

This connector can turn on a light in a room someone is sleeping in, delete a
scene they spent an evening tuning, and open the Zigbee network to joins. The
model authoring those calls is reading text it did not write. So:

### 5.1 The rules

1. **Named, typed mutations only.** Every write is a tool with a schema, a
   tested implementation, and a bounded effect: `apply_scene(scene_id)`,
   `set_light(entity_id, brightness?, color_temp_k?, transition?)`,
   `create_scene(name, entities[])`, `rename_scene(id, label)`. No tool takes
   free-form YAML, a service-call passthrough, or a raw entity dict.
   **In particular: no generic `call_service(domain, service, data)`.** It is the
   easiest tool to build and it silently re-exposes the entire 62-domain HA
   service registry — including `hassio.*`, `shell_command.*` and
   `homeassistant.restart` — behind one schema-free `data` blob. Every constraint
   in this section evaporates the moment it exists.
2. **Propose → commit for anything destructive or irreversible.**
   `delete_scene` and `permit_join` do not write; they return a description of
   what *would* happen plus a short-lived token, and a second named tool commits
   it. This is the shape `dap-finance` already uses (`process_receipt` proposes,
   `confirm_receipt` writes), and the reason is the same: accepting the model's
   *reasoning* is not approval of its *action*.
3. **An append-only audit table.** Every tool call gets a row: tool name, the
   arguments, the caller, whether the tool was declared read-only, the outcome,
   and — for writes — the verbatim user request and the model's stated reasoning.
   `dap-fitness/mcp` writes this on a **separate connection** (`auditSql`) and
   **never throws** from the audit path, so a failed audit write cannot turn a
   working tool into a broken one. Copy both properties.
4. **Physical actions report what they actually did.** Invariant #4 applies here
   with more force than it does in the PWA: HA applies a scene to what it can
   reach and stays silent about the rest, and silence read by a model becomes a
   confident "done ✓". Re-read state and name the lamps that didn't answer.

### 5.2 The `run_sql` contradiction, and how it resolves

The Aslan skill says: **"No `run_sql` / generic query tool. Ever."** And
`dap-fitness/mcp` ships `query_sql`. Both are in this fleet, both were written
deliberately, and a new connector needs to know which one it is following.

They are not actually in conflict, because they are not making the same claim.
The Aslan rule's stated harm is *epistemic*: "the model invents a join,
confidently reports a wrong number to someone who acts on it, and nobody catches
it." The `dap-fitness` tool is fenced so that the only thing it can do wrong is
be wrong — five layers, and the last three are enforced by Postgres rather than
by string inspection:

1. the statement must begin with `SELECT` / `WITH` / `TABLE` / `EXPLAIN`;
2. a write-keyword scan — **not** redundant with (1), because a data-modifying
   CTE (`WITH d AS (DELETE … RETURNING id) SELECT * FROM d`) passes the prefix
   check legitimately, and this is the layer that stops it;
3. `app.user_id` is set on the transaction, so row-level security filters every
   table the statement touches;
4. `SET TRANSACTION READ ONLY`, which Postgres enforces itself — and which the
   code *verifies took effect* rather than assuming, because a silently
   read-write transaction is indistinguishable from a safe one until something
   writes;
5. a `SELECT`-only role on the connection when `READONLY_DATABASE_URL` is set,
   so a write is impossible even if (1)–(4) were all bypassed.

Plus `SET LOCAL statement_timeout = '20s'` and a hard row cap.

**So the real rule is: no unconstrained mutation path.** Reads may be broad if
writes are *structurally* impossible — enforced by the engine, not by a regex and
a promise. A broad read still owes the user honesty about uncertainty, which is
why the Aslan rule remains the right default for anything a client will act on
financially. Here, a broad read over `scene_meta` / `scene_tap` is genuinely
useful ("which scene do I actually use on weekday evenings?") and cannot hurt
anybody, so it is allowed **on those terms and no others**.

For Home Assistant there is no equivalent of a READ ONLY transaction. HA's REST
API has no read-only mode and no scoped tokens — `HA_TOKEN` is admin (verified in
the Swift research doc: `/api/config/scene/config/*` answers, which requires
admin). **Therefore the HA side gets named tools only.** The structural guarantee
that makes a broad SQL read acceptable simply does not exist there, so the
permissive branch of the rule does not apply.

### 5.3 Annotations are not a security boundary

MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) are
worth setting: they are what lets a client auto-approve a read instead of
prompting on every call, which is the difference between a connector someone uses
and one they turn off.

They are **not** a control. The spec is explicit that annotations "are not
guaranteed to faithfully describe tool behavior, and clients **must** treat them
as untrusted unless they come from a trusted server", and the MCP blog's
treatment puts it plainly: an untrusted server can lie, annotations don't make a
model resist prompt injection, and *"if you need a guarantee that a tool can't
exfiltrate data, that's a job for network controls or sandboxing, not a boolean
hint"* — clients should "lean on them for UX, but keep your actual safety
guarantees in deterministic controls."
([Tool Annotations as Risk Vocabulary, 2026-03-16](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/))

Concretely, for this connector: `readOnlyHint: true` on `get_state` is a UX
affordance. The thing that makes `get_state` read-only is that its implementation
issues a `GET`. Mark the annotations, log what they claimed (`dap-fitness/mcp`
records `readOnlyHint` per call in the audit row precisely so the log can say
whether a call *could* have changed anything), and never let a hint be the reason
a write is safe.

---

## 6. Device discovery via Zigbee2MQTT

The payoff: **"Claude, I'm putting a new bulb in the corner lamp"** — permit
joins, watch the interview, name the thing, done, without opening a single admin
UI.

> **Amended 2026-08-14, after the first deploy.** This section originally had the
> connector holding its own MQTT connection to Mosquitto. It does not, because it
> cannot: the broker answered `Connection refused: Not authorized`, and its
> credentials are **unobtainable from here**. They live in the add-on
> configuration behind the Supervisor, and `/api/hassio/*` rejects a long-lived
> token — verified, `401`, with a token that `config/auth/list` confirms is
> admin. Home Assistant does not expose config-entry `data` over any API either.
>
> **Home Assistant is the bridge instead**, because it is already authenticated to
> that broker. `permit_join` and the Z2M half of a rename publish through the
> `mqtt.publish` service; the device list and the pairing signal come from HA's
> device registry, since a device completing its Zigbee interview *is* a new
> registry entry. All of it verified live: `mqtt.publish` drove a real device
> rename, and the registry resolved IEEE addresses to Z2M friendly names.
>
> A direct broker connection survives as **optional enrichment** — live
> `bridge/event` interview progress if credentials ever exist — never as a
> dependency. Two distinctions this forces into the tool surface: `null` is not
> `false` (`interview_completed` is unknown, not negative, when the broker is
> unreadable, and `bridge_events: null` "not listening" differs from `[]`
> "watched, saw nothing"), and **unconfirmed is not failed** — a publish through
> HA has no return channel, so a request is reported as sent-but-unconfirmed
> rather than as an error.
>
> The topic reference below is still correct and still the authority on payload
> shapes; only the transport changed. The rename trap that follows is unaffected
> and remains the reason `name_device` exists at all.

Z2M's bridge API is MQTT topics under `zigbee2mqtt/bridge/`
([MQTT topics and messages](https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html)):

| Topic | Direction | Payload | Notes |
|---|---|---|---|
| `bridge/request/permit_join` | publish | `{"time": 254}` / `{"time": 0}` / `{"time": 60, "device": "shelf_lamp"}` | Seconds, not a boolean. `device` scopes the join to one router, which is how you pair a bulb *near the far lamp* instead of near the coordinator. Pre-2.0 examples use `{"value": true}` — that form is gone. |
| `bridge/devices` | **retained** | array of `{ieee_address, type, friendly_name, supported, definition, …}` | Retained, so a subscriber gets the full inventory on connect with no request at all. Republished on every join and leave. This is the device list. |
| `bridge/event` | subscribe | `{"type": "device_joined" \| "device_interview" \| "device_leave" \| "device_announce", …}` | **`device_joined` is not "ready".** The interview is what determines the definition and the exposed features; a bulb that joined but failed its interview is present and useless. Wait for `device_interview` to reach a successful status before reporting success. |
| `bridge/request/device/rename` | publish | `{"from": "0x…", "to": "corner_lamp", "homeassistant_rename": true}` | See the trap below. |

Responses come back on the matching `bridge/response/*` topic with a
`transaction` field echoed from the request — set one, and correlate, or a
concurrent operation's response gets read as yours.

### The rename trap — two steps, always

This instance runs Z2M with **`homeassistant_rename: false`**, recorded in the
bring-up gotchas of the design doc. Consequently **a Z2M rename does not rename
the Home Assistant entity.** Rename `0x…` to `corner_lamp` in Z2M and HA still
holds `light.old_name`; the friendly name in one system and the entity id in the
other drift apart permanently, and every scene YAML in this repo references the
entity id.

Both steps are required:

1. **Z2M:** publish to `bridge/request/device/rename`. Passing
   `"homeassistant_rename": true` in the request payload asks Z2M to update the
   discovered entity too, and is documented as the way to do this — but it acts
   through MQTT discovery, so it is the *config* path, not the entity registry.
2. **Home Assistant:** update the entity registry so the entity id becomes
   `light.corner_lamp` — `config/entity_registry/update` over the WebSocket API.
   This is the step that makes the name usable in `scenes.yaml`.

A `rename_device` tool that does step 1 and reports success is worse than no tool
at all, because it leaves the two systems disagreeing and tells the user it
worked. Make the tool do both, verify the entity id afterward, and report the
final `entity_id` in its result.

### Safety, given what §5 says

`permit_join` opens the mesh to any device in radio range. It is the one
operation here with a security consequence outside the apartment's walls, and it
gets the full propose→commit treatment: a bounded duration (never `254` by
default — 60 s is plenty for a bulb you are holding), a scope to a specific
router where possible, an audit row, and an unconditional close afterward rather
than trusting the timer.

---

## Confidence

| Finding | Confidence | Basis |
|---|---|---|
| A path-mounted Next app cannot serve `/.well-known/*` under this Traefik setup | **High** | The repo's own deploy invariant + `dap-fitness/mcp` shipping standalone for the stated reason |
| `issuer` must be byte-identical to the base URL; mismatch rejects the document | **High** | RFC 8414 §3.3, restated in the Aslan skill from a real failure |
| Anthropic's cloud reaches the connector and nothing else | **High** | Claude Help Center states connections originate from Anthropic's cloud infrastructure and require public reachability |
| `2026-07-28` removed the GET stream and protocol-level sessions | **High** | Spec page states it in a revision note |
| Required `Mcp-Method` / `Mcp-Name` headers and `-32020` on mismatch | **High** | Spec, normative MUST |
| DCR deprecated in favor of Client ID Metadata Documents | **High** | Spec, stated in Overview §3 |
| Claude does not honor `WWW-Authenticate` on a 200 | **Medium-High** | Aslan skill, from a debugged incident; not a documented vendor guarantee |
| Claude sends no `Origin` on connector calls | **Medium-High** | Same source; consistent with server-to-server origination |
| Annotations are hints, not a boundary | **High** | MCP spec language + the MCP blog post, quoted |
| Z2M bridge topics and payload shapes | **High** | Z2M documentation, read directly |
| `homeassistant_rename: false` on this instance | **High** | Recorded in this repo's bring-up gotchas |
| `HA_TOKEN` is admin and HA has no read-only token scope | **Medium-High** | Admin verified live in the Swift research doc; the absence of scoping is an absence-of-evidence claim |
| Five-layer `query_sql` fencing as described | **High** | `dap-fitness/mcp/src/analytics.ts`, read directly |

## Open questions

- **Whether to ship a broad read at all.** §5.2 says it is permissible over
  `scene_meta` / `scene_tap`. It is not yet clear it is *worth it* — the tap
  history is one small table, and three named tools may cover every question
  anyone will ask. Default to named tools; add the fenced reader only when a real
  question can't be answered without it.
- **Long-lived MQTT subscription vs. connect-per-call.** `bridge/devices` is
  retained, so a connect → subscribe → read → disconnect cycle gets the full
  inventory in one round trip and keeps the service genuinely stateless. But
  `bridge/event` during a pairing is a *stream*, and a stateless HTTP tool call
  has nowhere to put it. Likely answer: hold a subscription for the duration of
  a `permit_join` window only, keyed to the propose→commit token.
- **Whether the connector should write scenes via `/api/config/scene/config/{id}`.**
  The Swift research doc establishes it works and persists, and flags that it is
  undocumented with no compatibility promise. Same mitigation applies: one adapter
  module, one round-trip integration test against a throwaway scene.
- **Token audience when a second resource appears.** Stamping the audience now
  costs nothing; nothing validates it until there is a second server.
- **Whether HA exposes anything resembling a scoped token by the time this
  ships.** If it ever does, §5.2's "named tools only" conclusion for the HA side
  should be revisited.

## Sources

MCP — primary:
[Versioning](https://modelcontextprotocol.io/specification/versioning) ·
[Streamable HTTP (2026-07-28)](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) ·
[Authorization (2026-07-28)](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) ·
[Tool Annotations as Risk Vocabulary (2026-03-16)](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)

OAuth — primary:
[RFC 8414 — Authorization Server Metadata](https://datatracker.ietf.org/doc/html/rfc8414) ·
[RFC 9728 — Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728) ·
[RFC 8707 — Resource Indicators](https://www.rfc-editor.org/rfc/rfc8707.html) ·
[RFC 6750 — Bearer Token Usage](https://datatracker.ietf.org/doc/html/rfc6750) ·
[RFC 9207 — Authorization Server Issuer Identification](https://datatracker.ietf.org/doc/html/rfc9207)

Anthropic — primary:
[Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) ·
[Build custom connectors via remote MCP servers](https://support.claude.com/en/articles/11503834-build-custom-connectors-via-remote-mcp-servers)

Zigbee2MQTT — primary:
[MQTT topics and messages](https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html) ·
[Zigbee2MQTT 2.0.0 breaking changes](https://github.com/Koenkk/zigbee2mqtt/discussions/24198)

In-fleet:
`dap-fitness/mcp/README.md` ·
`dap-fitness/mcp/src/analytics.ts` (the five-layer `query_sql` fencing) ·
`dap-fitness/mcp/src/rpc.ts` (audit on a separate connection, never throws) ·
Aslan `skills/aslan-mcp-connector/SKILL.md` ·
`docs/research/2026-08-07-swift-app-and-siri.md` (HA scene config API, admin token) ·
`docs/superpowers/specs/2026-08-07-vue-automation-design.md` (`homeassistant_rename: false`)
