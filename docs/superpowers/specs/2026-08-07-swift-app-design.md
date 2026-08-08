# Vue Lights — native iOS app

**Date:** 2026-08-07
**Status:** design, pending approval
**Research:** `docs/research/2026-08-07-swift-app-and-siri.md`
**References:** `dap-fitness-swift` (architecture), `dap-fitness/web` (API conventions)

## Baseline — what exists as of today

Verified against the live instance, not the docs.

| | |
|---|---|
| Home Assistant | 2026.8.1 on the Pi, reachable from Persimmon over the tailnet |
| Lamps | **4, all paired and named** — `abajour`, `floor_lamp`, `shelf_lamp`, `tv_lamp` |
| Lamp capability | 2000–6493 K, `color_temp` + `xy`, 8 effects, ThirdReality ZL1 |
| Scenes | **7** — Bright, Evening, Focus, Guitar, Host, Late, Movie |
| Automations | **2** — "Evening at sunset", "Late at 23:30" |
| Web app | scene capture, schedule authoring, per-lamp and master control |
| Passphrase gate | **off** — `APP_PASSPHRASE` unset, app is open to anyone with the URL. Operator's explicit choice; recorded here as fact, not as a recommendation |

The web app grew scene and schedule authoring while this was being designed. This
spec is written against that app, not the earlier scene-picker-only one.

## Why a native app at all

The PWA already controls the lights well. A Swift app is only worth building for
what a browser structurally cannot do:

1. **Siri commands the user authors themselves**, with no code and no Shortcuts app.
2. **Control Center, Lock Screen, Home Screen widgets and the Action Button** — one
   tap from a locked phone, app never opens.
3. **A spatial room map** with gesture control, which needs native gesture and
   render performance to feel like direct manipulation rather than a web toy.
4. **Push-based live state**, so the screen never lies about what the room is doing.

Everything else is parity. If a feature is not on that list, the PWA is the cheaper
place for it.

## Architecture

```
ios/                                     (in this repo — API and client change together)
  App/                                   the .app target, one file
  Sources/
    VueCore            models, kelvin↔RGB, errors. No UI, no networking.
    VueDesignSystem    tokens ported from globals.css, primitives
    VueRepositories    protocols + fixtures + live HTTP + SSE client
    VueNavigation      Route, Router, environment keys
    VueFeatureRoom     the map, master controls, per-lamp sheet
    VueFeatureScenes   library, capture, aliases
    VueFeatureSchedules
    VueFeatureSettings
    VueIntents         App Intents — imported by the app AND the widget extension
    VueApp             composition root, route table
  Widgets/                               widget + Control Center extension
```

SwiftPM multi-target driven by XcodeGen, Swift 6, **iOS 26** floor (current shipping
release; Control Center controls need 18+, and there is no reach argument for a
one-person app).

Two traps carried over from `dap-fitness-swift`, both of which cost real days there:

- **The SwiftPM product is `VueLightsKit`, never `VueLights`.** If a package product
  shares the app target's name, `xcodebuild -scheme VueLights` silently resolves to
  the library, reports BUILD SUCCEEDED, and leaves the previously-installed app in
  place. Every "my change didn't take" is that.
- **macOS goes in `platforms`** so `VueCore` and `VueRepositories` run under
  `swift test` with no simulator. Feature modules are iOS-only behind `#if os(iOS)`.

### The server stays the only thing that talks to Home Assistant

The phone is not on the tailnet, so this is not a preference — it is the only
topology that works. Invariant #1 holds unchanged: the HA token never leaves
Persimmon. The app holds a Vue Lights token, nothing more.

### API

The existing routes are already close to what the app needs. Rather than invent
`/api/v1`, **the app consumes the current routes** and they gain what is missing:

| Route | Status |
|---|---|
| `GET /api/state` | exists — scenes, lamps, automations, unreachableCount |
| `POST /api/light` | exists — accepts one or many entities, on/brightness/kelvin/hs |
| `POST /api/scene` | exists — activate, reports `unreachable[]` |
| `POST /api/scenes` `DELETE /api/scenes?id=` | exists — snapshot capture |
| `POST/PUT/DELETE /api/automations` | exists — time and sun schedules |
| `GET /api/events` | **new** — SSE stream of state changes |
| `GET /api/siri` | **new** — the Siri catalogue (scenes + aliases + symbols) |
| `PATCH /api/scenes/{id}/meta` | **new** — label, accent, symbol, aliases, order |
| `PUT /api/placement` | **new** — lamp x/y on the room map |
| `POST /api/token` | **new** — passphrase → bearer, when the gate is on again |

**Auth.** While `APP_PASSPHRASE` is unset the app sends nothing and the server asks
for nothing. The bearer path is built anyway and activates the moment the variable
is set, so turning the gate back on is an env change and not an app release. Token
in the Keychain, never `UserDefaults`.

**SSE, not polling.** The server holds **one** HA WebSocket (`subscribe_events`,
`state_changed`) and fans changes out to connected clients. One socket for the whole
household regardless of client count. Heartbeat every 20 s so Traefik does not reap
the connection; the client falls back to the existing 6 s poll if the stream drops.
This is what finally enforces invariant #3 rather than mitigating it — a lamp
switched off at the wall greys out immediately instead of up to six seconds later.

## The room map

The primary screen. It does not scroll.

**Rendering.** A bundled illustrated plate (`docs/design/room-map/`) as the
backdrop, with lamps drawn live in SwiftUI on top — fill colour derived from the
lamp's real `color_temp_kelvin` or `hs_color`, glow radius and opacity tracking
brightness. Off is a hollow ring; unreachable is a dashed grey ring. **No light is
ever baked into the plate**, because a picture and a room that disagree is the same
failure as a stale reading.

**Gestures**, chosen so the common cases cost one action:

| Gesture | Effect |
|---|---|
| Tap a lamp | toggle |
| Vertical drag on a lamp | brightness, 1:1 |
| Horizontal drag on a lamp | colour temperature |
| Long-press a lamp | detail sheet — colour wheel, effects, exact values, rename |
| Drag on empty floor | the same two axes applied to **every** reachable lamp |
| Double-tap empty floor | all off |

Dragging the floor is the important one: warming or dimming the whole room is one
gesture with no mode switch and no trip to a master panel.

Slider commits follow the web app's rule — throttled to ~4 updates/second during the
drag so it feels live, final value committed on release. Zigbee handles a few
messages a second; forwarding every frame makes the lamp chase a stale queue.

**Scenes** live in a bottom strip of chips that expands into a sheet. The strip owns
vertical swipes; the canvas owns everything else. Separating them by region is what
keeps the floor-drag gesture from fighting the tray.

**Haptics:** light impact on toggle, selection feedback crossing 25/50/75/100,
success on scene apply.

**The list fallback is not optional.** VoiceOver cannot drag a canvas, and the map is
meaningless before placement is set. A complete list mode ships alongside — every
lamp as a row with standard controls and Adjustable actions, reachable from Settings
and selected automatically under VoiceOver or Switch Control. This is a second UI,
and it is the honest cost of choosing a spatial map.

**Placement** is stored in Postgres as normalized `(x, y)` and edited in-app by
dragging. Defaults are seeded from `docs/design/room-map/lamp-placement.svg`. If the
table is empty or unreachable the map degrades to an evenly-spaced grid of lamp
tiles over the same plate — never a blank screen.

## Siri — user-authored commands, no code

The core feature. Mechanism confirmed against Apple's own documentation; see the
research doc for citations.

Siri does not accept free-form phrase parameters. It **does** accept a phrase
template that interpolates an `AppEntity`, expanding one real phrase per entity
value:

```swift
AppShortcut(
    intent: ActivateSceneIntent(),
    phrases: ["\(.applicationName) \(\.$scene)",
              "Set \(\.$scene) with \(.applicationName)",
              "Turn on \(\.$scene) in \(.applicationName)"],
    shortTitle: "Activate scene",
    systemImage: "lightbulb.fill")
```

`SceneEntity.displayRepresentation` carries `alternativeNames: [String]` — synonyms
Siri matches against. **Those come straight from a text field in the app.** Name a
scene "Movie" and add `movie time`, `netflix`, `film`, and Siri answers to all four.
The user is authoring Siri grammar from a form; no Xcode, no Shortcuts app, no
recompile.

**The mirror.** `EntityQuery.suggestedEntities()` must never hit the network — the
system calls it opportunistically, sometimes offline, sometimes in a tight window,
and a network call there is exactly how Siri breaks intermittently and
unreproducibly. So the app writes the catalogue from `GET /api/siri` to a JSON file
in a **shared App Group container** on every foreground and after every scene
mutation, and the query reads that file. Then
`VueShortcuts.updateAppShortcutParameters()`.

Two failure modes to handle explicitly:
- Phrases referencing entity parameters **do not work until the system has fetched
  entities once**. Call `updateAppShortcutParameters()` on first launch or Siri is
  silently dead on a fresh install.
- A deleted scene must resolve to empty in `entities(for:)` and fail with a spoken
  "That scene no longer exists" — never a crash, never a stale activation.

**Budget** — 10 App Shortcuts and 1,000 total phrases per app, counted expansively:

| Intent | Phrases |
|---|---|
| `ActivateSceneIntent` | 3 templates × 7 scenes = 21 |
| `RunScheduleIntent` | 1 × 2 = 2 |
| `AllLightsOffIntent` / `AllLightsOnIntent` | ~4 |
| `SetBrightnessIntent` (AppEnum: 10/25/50/75/100) | 5 |
| `SetWarmthIntent` (AppEnum: warm/neutral/cool) | 3 |
| `RoomStatusIntent` → spoken dialog | 2 |

Six shortcuts of ten; ~37 phrases of a thousand. Room to grow by an order of
magnitude before either ceiling matters.

**Every phrase must contain `\(.applicationName)`.** Omitting it still compiles and
silently never matches — the single most common way this feature dies. Register
`INAlternativeAppNames` (`Vue`, `Lights`, `Living Room`) so the app name is
speakable more than one way.

**Discoverability.** Each scene shows a **"What Siri hears"** row listing its literal
phrases. An invisible feature is an unused one, and this is the screen that makes the
alias field obviously worth filling in.

## System surfaces

One `ActivateSceneIntent` powers all of these — write the intent once, get six
places to trigger it:

- **Control Center control** — configurable to any scene via Control Center's own
  editor (`AppIntentControlConfiguration`), plus an "all lights" toggle
- **Lock Screen control** — the same control
- **Home Screen widget** — 2×2, four scene buttons and a state line
- **Action Button**
- **Shortcuts app** — free, for anything not anticipated here

On iOS 27, pin scene activation to `.main` via `ExecutionTargets`; it is a network
write and does not belong in the widget extension.

## Data model

One migration, idempotent per the repo rule:

```sql
ALTER TABLE scene_meta ADD COLUMN IF NOT EXISTS symbol  text;
ALTER TABLE scene_meta ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS lamp_placement (
  entity_id text PRIMARY KEY,
  x real NOT NULL, y real NOT NULL,          -- normalized 0–1 over the plate
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Invariant #2 holds: Home Assistant owns scenes, automations and device state;
Postgres owns presentation, voice aliases, placement and tap history. `label` stays
NULL by default so renaming in HA is not shadowed by a stale copy. Every read has a
fallback and every write is best-effort — if Postgres is down the app still turns on
the lights, it just loses aliases and the map falls back to a grid.

## Failure behaviour

The four existing invariants port unchanged. Native additions:

| Condition | Behaviour |
|---|---|
| SSE drops | fall back to polling; a subtle "reconnecting" state, never a modal |
| HA unreachable | lamps go dashed, controls disable, the map stays on screen with an honest banner |
| Scene applied partially | the lamps it could not reach go dashed and are named in the toast |
| Siri catalogue stale | intent resolves against the server on execute; a missing scene speaks a clear failure |
| DB down | aliases and placement lost, control unaffected |

## Out of scope

- iPad. Every surface is designed portrait-phone; iPad is a design project.
- Multi-room. One room, four lamps. The entity layer is generic so a second room is
  additive, but no UI assumes it.
- General automation authoring beyond time and sun triggers. Conditions, presence and
  multi-step stay in HA's own editor — rebuilding that to control four lamps is the
  wrong trade, and the web app already made this call.
- Offline write queue. A queued "turn on the lights" that fires an hour later is
  worse than a failure.
- HomeKit Bridge. Worth enabling separately for on-LAN Siri, but it exposes scenes as
  bare switches and puts naming in Apple's database rather than ours, so it does not
  serve this brief.

## Phases

Each ships and is independently useful.

1. **Foundation** — package, XcodeGen, design tokens, models, fixtures, API client, the app running end to end on fixture data.
2. **Control** — room map read-only, list fallback, gestures, per-lamp sheet, kelvin↔RGB, haptics.
3. **Live** — SSE on the server, stream client, connection states.
4. **Scenes** — library, capture, rename, accent, symbol, delete.
5. **Siri** — intents, entity, query, App Group mirror, alias editor, "What Siri hears". *The feature the app exists for.*
6. **Surfaces** — Control Center, Lock Screen, widget, Action Button.
7. **Schedules** — parity with the web app's time and sun authoring.
8. **Polish** — placement editor, effects, onboarding, accessibility pass, snapshot tests.

## Risks

| Risk | Mitigation |
|---|---|
| `/api/config/scene/config/*` is undocumented | Already in production use by the web app. One adapter module, one round-trip integration test. Documented fallback to `scene.apply`. |
| `updateAppShortcutParameters()` reported flaky for Spotlight titles | Known open radar; Siri matching appears unaffected. Verify on device in phase 5 before building UI that depends on it. |
| Two sessions editing this repo | Real — it already happened. Serialize on `web/`. |
| The room plate is illustration, not survey | It is decoration behind live markers. Placement is user-editable and the grid fallback needs no plate at all. |
| SSE through Traefik/Coolify | Heartbeats plus automatic fallback to the existing poll. |

## Open

- Light-mode plate not yet produced. Must be a separate render, not a filter.
- Whether the passphrase gate comes back on. The bearer path is built either way.
