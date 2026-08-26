# vue-automation — agent context

Home Assistant on a Pi 5 driving thirteen Zigbee lights across two rooms — nine
bulbs and four LED strips — with a wall remote per room, plus a Next.js PWA
(`web/`) that presents them as tappable scenes, a SwiftUI app (`ios/`), and a
Claude MCP connector (`mcp/`, designed in
`docs/architecture/mcp-connector.md`).

Checks before committing:

```bash
cd web && npx tsc --noEmit && npm run build
cd mcp && npm run build && npm test    # if mcp/ was touched
```

## Invariants

1. **Never call Home Assistant from the browser.** Every HA call goes through a
   server route. The token is full control of the house, and the instance is
   only reachable over the tailnet from the server anyway.
2. **Home Assistant owns scenes and device state.** Postgres stores labels,
   accents, ordering and tap history — nothing authoritative. If the database
   is down the app must still turn on the lights, so every read has a fallback
   and every write is best-effort.
3. **Never render a cached light state as current.** A stale reading is worse
   than an error because the user acts on it. `/api/*` is never served from the
   service worker cache.
4. **Report partial application.** Home Assistant applies a scene to what it
   can reach and stays silent about the rest; silence reads as success. The
   scene route re-reads state and names the lamps it couldn't reach.
5. **No `config.matcher` in `middleware.ts`.** A matcher can never match the
   exact basePath root — every pattern needs a literal `/` after the prefix —
   so the canonical URL silently skips auth. Exclude paths inline instead.
6. **`fetch()` in client components must go through `apiUrl()`.** Next only
   prepends `basePath` to its own internals; a raw `fetch("/api/…")` escapes
   the app entirely on a path-mounted deploy.
7. **The MCP connector stays a standalone service on its own subdomain.** It
   cannot be a route in `web/`: Traefik only sends `/vue-automation/*` there, so
   the app can never serve `/.well-known/*`, and RFC 8414 requires the OAuth
   `issuer` to be byte-identical to the URL its metadata is served from. Emit the
   `401` + `WWW-Authenticate: … resource_metadata="…"` at the HTTP layer, before
   the JSON-RPC dispatcher — on a `200` Claude ignores the header and the user
   gets no Connect button and no way to proceed.
8. **Nothing a model calls gets an unconstrained mutation path.** Named, typed
   tools only — no generic `call_service`, no SQL writer — propose→commit for
   deletes and `permit_join`, and an audit row per call. Tool annotations
   (`readOnlyHint`, `destructiveHint`) are hints a client may distrust, never the
   reason a write is safe. Reads may be broad only where writes are
   *structurally* impossible; Home Assistant offers no such guarantee, so the HA
   side is named tools only.

9. **Room assignment resolves override → static map → "Unassigned", and the
   static map is the floor.** `ASSIGNMENTS` in `web/src/lib/rooms.ts` is
   compiled in; `lamp_room` in Postgres may shadow it per-bulb, written only
   through `/api/internal/lamp-room` (the connector's `set_lamp_room`). The
   order is what matters: `loadRoomOverrides` swallows every failure and returns
   `{}`, so an unreachable database falls through to the static map and the
   grouping is unchanged — Home never collapses into one undifferentiated list,
   which is what invariant 2 promises. Never invert this into "read the rooms
   from Postgres, fall back to nothing". The state routes resolve the room
   server-side and attach it to each lamp; `groupByRoom` still falls back to the
   static map for any lamp that arrives without one. Anything in neither lands
   in "Unassigned" rather than vanishing, so a bulb paired at 2am can still be
   switched off. Rooms themselves stay a closed set in source — assigning a bulb
   is bookkeeping, adding a room is a layout decision. See
   `docs/superpowers/specs/2026-08-23-room-overrides-design.md`.

10. **Bulbs lie about their range, and answer late.** The Third Reality ZL1
    advertises a 2000K floor it cannot physically reach: ask for 2000K and it
    settles at 2202K and reports that back — that IS its warmest white. Only the
    Tuya strip really reaches 2000. Worse, these bulbs report state lazily, so a
    read taken a second after a write echoes the OLD value and a naive check
    calls a change that landed a failure. Verify a write against a FRESH read a
    few seconds later, never against the response to the write itself.

11. **An effect the bulb never advertised is dropped in silence.** Same
    failure shape as invariant 10's Kelvin: Home Assistant accepts the call,
    the lamp does not move, and the caller is told it worked. `effect_list` is
    per-bulb and is the only honest source — the ZL1 offers `blink`, `breathe`,
    `okay`, `channel_change`, `finish_effect`, `stop_effect`, `colorloop`,
    `stop_colorloop`. `/api/internal/lamp` refuses an unadvertised effect
    before writing, and `set_lamp` refuses it before even calling the app.
    Most of these are Zigbee *Identify* animations: they run a short fixed
    sequence and stop by themselves, so none of them is a mode the lamp sits
    in — `colorloop` is the only sustained one. Never offer `breathe` as a
    lasting candle setting; a real flicker needs an automation that nudges
    brightness, not an effect. The bulb also reports `effect` lazily, so a
    `null` read straight after the write is not evidence it failed.

12. **The Tuya strip discards brightness sent alongside colour.** Brightness and
    a colour temperature in one command — which is how every scene and every
    one-tap look applies — and it takes the colour and keeps its old brightness.
    Sent alone, it obeys instantly. `SPLIT_BRIGHTNESS` in `web/src/lib/ha.ts`
    names the lamps this applies to; `applyLightPatches` and `/api/scene` both
    send them a second, brightness-only command, and so do the remote's
    automations. Anything new that drives lamps must do the same.

## PWA rules that must not be undone

- **Never `100vh`** — it resolves against the largest viewport, so the bottom
  row starts below the fold. The shell is `100dvh` with three grid rows.
- **The header and footer are grid rows, not `position: fixed`.** Fixed
  elements detach from the layout viewport and iOS moves them independently.
- **Exactly one scrolling element** (`.app > main`). `body` must not scroll.
- **Inputs stay ≥16px** or iOS zooms on focus and never zooms back.
- **Safe-area insets need a `max()` fallback** — the raw value is `0px` on a
  device without one, putting the footer against the screen edge.
- `theme_color` in the manifest route and `themeColor` in `layout.tsx` must
  stay identical.

## Deploy

Path-mounted at `renatodap.me/vue-automation` via Coolify. `NEXT_BASE_PATH` is
set as an env var there and `is_stripprefix_enabled` must stay `false` — Next
owns the prefix, Traefik passes it through. See Persimmon `infra/README.md`.

**The Pi needs internet, not the home Wi-Fi.** `HA_BASE_URL` is a Tailscale
address, so a phone hotspot is a full recovery path when the apartment network is
the broken thing. Two traps first: the SSID is case-sensitive and a wrong one
fails identically to a wrong password, and the HA CLI cannot join a WPA3-only
network at all. See the README outage section.
