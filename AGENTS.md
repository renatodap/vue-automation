# vue-automation — agent context

Home Assistant on a Pi 5 driving four Zigbee bulbs in the living room, plus a
Next.js PWA (`web/`) that presents them as tappable scenes, a SwiftUI app
(`ios/`), and a Claude MCP connector (`mcp/`, designed in
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
