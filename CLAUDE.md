# vue-automation — agent context

Home Assistant on a Pi 5 driving four Zigbee bulbs in the living room, plus a
Next.js PWA (`web/`) that presents them as tappable scenes.

Checks before committing:

```bash
cd web && npx tsc --noEmit && npm run build
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
