# Native app + user-defined Siri — research

**Date:** 2026-08-07
**Question:** mirror `web/` into a SwiftUI app, cover home automation properly, and let
Renato create his own Siri commands *inside the app* with no code and no Xcode.

Everything below was checked against the live instance (HA **2026.8.1** on the Pi,
reached over the tailnet from Persimmon) or against a primary source. Where a
community claim conflicts with the source, the source wins and the conflict is noted.

---

## 0. What is actually running, as of today

This is the load-bearing section. The repo's design doc describes a system that does
not yet exist, and building a Swift mirror of the *documented* app would ship an app
with an empty main screen.

| | `docs/` says | The instance says |
|---|---|---|
| Bulbs | 4× ThirdReality ZL1 | **2 paired** — `light.floor_lamp`, `light.shelf_lamp` |
| Scenes | 5, in `homeassistant/scenes.yaml` | **zero `scene.*` entities** — the YAML was never copied to the Pi |
| Database | `scene_meta`, `scene_tap` | tables exist, **0 rows** |
| HA version | — | 2026.8.1, `config_source: storage`, `America/New_York`, imperial units |

Both lamps report identically: `color_temp` mode at 2702 K, brightness 115/255,
`supported_color_modes: [color_temp, xy]`, range **2000–6493 K**, and an
`effect_list` of 8 effects (`blink`, `breathe`, `okay`, `colorloop`, …) that the web
app never exposes.

Other entities that already exist and are worth something: `weather.forecast_home`,
`sun.sun` + six `sensor.sun_next_*`, `person.*` and `device_tracker.renatos_iphone`
(presence), `todo.shopping_list`, `notify.mobile_app_renatos_iphone` (push to the
phone), `conversation.home_assistant` (Assist), and `binary_sensor.raspberry_pi_power_status`.

62 service domains are registered, including `climate`, `cover`, `media_player`,
`lock`, `vacuum`, `fan`, `humidifier`, `valve` — all loaded by `default_config`, all
with **zero entities**. Their presence in `/api/services` says nothing about hardware.

**Consequence for the design:** the app cannot be a scene *picker*, because there is
nothing to pick. It has to be a scene **author** first. That inverts the web app's
v1 scope decision ("scene authoring from the UI" was explicitly out of scope) — and
it is also precisely what makes the Siri feature possible, because a scene the user
created in the app is a row we control.

---

## 1. Can a user create Siri phrases at runtime, with no code?

**Yes — with one hard constraint, and it shapes the whole feature.**

Siri does **not** support free-form phrase parameters. You cannot ship "Hey Siri, tell
Vue Lights to *«anything the user typed»*". What you *can* do — and what Apple
explicitly designed for — is declare a phrase **template** at compile time that
interpolates an `AppEntity` parameter, then feed the system a finite, runtime-updated
list of entity values. Each value expands into its own real Siri phrase.

```swift
AppShortcut(
    intent: ActivateSceneIntent(),
    phrases: [
        "\(.applicationName) \(\.$scene)",
        "Set \(\.$scene) with \(.applicationName)",
        "Turn on \(\.$scene) in \(.applicationName)",
    ],
    shortTitle: "Activate scene",
    systemImage: "lightbulb.fill")
```

`\(\.$scene)` resolves against `SceneEntity`'s `EntityQuery.suggestedEntities()`.
Return the scenes from the database there, and every scene the user creates becomes a
spoken phrase — **no recompile, no Xcode, no intent authoring**.
([WWDC23 "Spotlight your app with App Shortcuts"](https://developer.apple.com/videos/play/wwdc2023/10102/))

### The rules that constrain the design

| Rule | Value | Where it bites |
|---|---|---|
| App Shortcuts per app | **10 max** | We need ~5. Fine, but it is a budget, not a rounding error. |
| Total trigger phrases | **1,000 max** | Counted *expansively*: 3 phrase templates × 40 scenes = 120. Fine at our scale; would break at 300 scenes. |
| Every phrase must contain `\(.applicationName)` | mandatory | Omit it and **the build still succeeds** — the phrase just never matches at runtime. This is the single most common silent failure. |
| Free-form/open-ended parameters | **unsupported** | "Search for X" is impossible. A finite entity list is the only mechanism. |
| Entities must be fetched once before phrases work | — | "App Shortcut phrases referencing entity parameters won't work until the system has successfully fetched entities for the first time." Call `updateAppShortcutParameters()` on first launch or Siri is silently dead. |

### `alternativeNames` is the actual no-code feature

`DisplayRepresentation` takes an `alternativeNames: [String]` array — synonyms Siri
will match against. This is the part that turns "the app names your scenes" into
"you name your scenes, in your words":

```swift
DisplayRepresentation(
    title: "\(label)",
    subtitle: "Scene",
    image: .init(systemName: symbol),
    alternativeNames: aliases)   // ← straight out of Postgres
```

So a scene labelled **Cinema** with aliases `["movie time", "netflix", "film", "movie night"]`
answers to all five, and the aliases are a text field in the app, stored in a column.
The user is literally authoring Siri grammar from a form. Changing them requires
`AppShortcutsProvider.updateAppShortcutParameters()` — synonyms are explicitly
called out as needing it.

### Confidence

**High.** The mechanism, the 10/1000 limits, the `applicationName` requirement, the
`alternativeNames` API and the first-fetch caveat all come from Apple's own WWDC23
session. The one thing I could not verify from a primary source is whether the 1,000
limit is enforced by truncation or by rejection — it does not matter at our scale.

---

## 2. iOS version reality, and what changed at WWDC26

- **iOS 26.6 is the current shipping release** (iOS 26 shipped 2025-09-15).
  iOS 27 was previewed at WWDC on 2026-06-08 and is at developer beta 4; it ships
  ~September 2026. ([Macworld](https://www.macworld.com/article/1659017/ios-versions-list.html),
  [MacRumors](https://www.macrumors.com/roundup/ios-27/))
- **SiriKit is deprecated.** App Intents is now the only way an app surfaces in Siri.
  Nothing here should touch `INIntent`.
- **WWDC26 additions** (land in the iOS 27 generation, so they are a *later* upgrade,
  not a v1 dependency): `LongRunningIntent` + `CancellableIntent` for work beyond 30 s
  with Live Activity progress, `ExecutionTargets` to pin an intent to the main app vs
  an extension, `EntityCollection` for bulk identifiers, `SyncableEntity` for
  cross-device Siri, `@UnionValue` parameters, and `RelevantEntities` for contextual
  suggestion. ([WWDC26 session 345](https://developer.apple.com/videos/play/wwdc2026/345/))
- **`ExecutionTargets` is worth flagging now** even though it is iOS 27: a scene
  activation is a network write, so it wants `.main` or an intents extension — not the
  widget extension.
- **There is no smart-home assistant schema.** The `@AssistantIntent` domains are
  reader, browser, photos, books, camera, whiteboard, files, presentation, mail, word
  processor, journal, spreadsheets — no home/IoT domain exists.
  ([App intent domains](https://developer.apple.com/documentation/appintents/app-intent-domains))
  So there is no free ride: the App Shortcuts route in §1 is the route.

**Recommended floor: iOS 26.** It is shipping, it is what the phone runs, Control
Center controls need 18+, and the Liquid Glass material is free on nav/tab/sheet.
`dap-fitness-swift` targets iOS 17 for reach reasons that do not apply to a
single-user app controlling a single apartment.

---

## 3. The Siri alternative I have to rule on: HomeKit Bridge

HA ships a **HomeKit Bridge** integration that presents entities to Apple Home over
HAP, on the LAN, with no cloud. Siri then controls them natively — "Hey Siri, turn on
the floor lamp" — with zero app code.
([HomeKit Bridge](https://www.home-assistant.io/integrations/homekit/))

It should probably be turned on regardless. But it does **not** replace the app-driven
Siri feature, for three concrete reasons:

1. **HA scenes expose as on/off switches**, not as HomeKit scenes. So "Cinema" becomes
   a switch called Cinema — it works, but it has no scene semantics and no aliases.
2. **It requires the phone and the Pi to be on the same LAN** to set up, and Apple
   Home's remote access needs a home hub (Apple TV / HomePod). The tailnet does not
   help here — HAP is a LAN protocol. The whole point of the current architecture is
   that the phone reaches the house from anywhere via the Persimmon server.
3. **The naming lives in Apple's database, not ours.** Renaming a scene means renaming
   it in the Home app. The brief is "create my own commands *via the Swift app*
   reading from the db" — that is the opposite arrangement.

**Verdict:** complementary, not a substitute. Worth enabling for on-LAN convenience;
the app's own App Intents are what deliver the brief.

---

## 4. Home Assistant APIs — what we can actually build on

### Scene authoring: use the config API, not `scene.create`

There are two ways to make a scene from code and only one of them is durable.

**`scene.create`** (service, documented) builds a scene in memory. It is **lost on
restart** — confirmed by [core#133912](https://github.com/home-assistant/core/issues/133912)
and several long-running community threads. Fine for "snapshot the room so I can
restore it in 20 minutes". Wrong for a user's named scene library.

**`POST /api/config/scene/config/{id}`** is the endpoint HA's own scene editor uses.
Reading [`components/config/scene.py`](https://github.com/home-assistant/core/blob/dev/homeassistant/components/config/scene.py)
and its `EditIdBasedConfigView` base:

- Registered at `/api/config/{component}/{config_type}/{config_key}`, so
  `/api/config/scene/config/<id>` — **GET, POST, DELETE**.
- **Requires an admin user.** Verified live: a GET for an unknown id returns
  `{"message":"Resource not found"}` (404), not 401 — so the long-lived token in
  `HA_TOKEN` belongs to an admin. A non-admin token would 401 here.
- POST body is the scene dict, validated against the scene `PLATFORM_SCHEMA`;
  responds `{"result":"ok"}`.
- Writes through to **`scenes.yaml`** in the config dir, then the `post_write_hook`
  calls `scene.reload` — so the scene becomes a live `scene.*` entity immediately.
- DELETE removes the entry *and* unregisters the entity from the entity registry.

Verified live on our instance: `/api/config/scene/config/*` and
`/api/config/automation/config/*` both answer with HA's JSON 404 body, while a bogus
path (`/api/config/banana/config/*`) answers with a plain-text `404: Not Found`.
The endpoints are real and reachable with our token.

**This is the keystone.** It means the app can create, edit and delete *real,
persistent* HA scenes — visible to HA automations, to the HA companion app, and to
HomeKit Bridge — and they survive reboots. It is undocumented
([core#68453](https://github.com/home-assistant/core/issues/68453)), which is a real
risk to write down: it is an internal API that HA's own frontend depends on, so it is
unlikely to vanish, but it is not covered by any compatibility promise. **Mitigation:
one adapter module, one integration test that round-trips a throwaway scene, and a
documented fallback to `scene.apply`** (which needs no stored scene at all and is
fully documented).

### `scene.apply` — the preview mechanism

`scene.apply` takes an entities dict inline and applies it **without any stored
scene**. That makes live preview while editing a scene free: the user drags a slider,
we apply, the room changes, nothing is persisted until Save. Both `turn_on` and
`apply` accept `transition` (seconds).

### WebSocket beats polling

The web app polls `/api/state` every 6 s while visible. HA hosts a WebSocket API at
`/api/websocket`: `auth_required` → `auth` → `auth_ok`, then `subscribe_events` with
`event_type: state_changed`, or `subscribe_trigger` for a filtered state trigger.
([WebSocket API](https://developers.home-assistant.io/docs/api/websocket/))

For a native app this is strictly better: state arrives when it changes, a lamp
someone turns off at the wall greys out immediately, and there is no six-second
window where the UI lies. It also removes the polling battery cost the web app has to
mitigate with `visibilitychange`.

Also available and useful: `get_states`, `call_service` (with `return_response`),
`validate_config`, `extract_from_target`, and
`config/entity_registry/list_for_display`.

### Other endpoints worth knowing

- `POST /api/services/<domain>/<service>` returns **the list of states that changed**
  during the call — which is a cheaper way to do the web app's "report partial
  application" than re-reading everything.
- `POST /api/template` renders a Jinja template server-side.
- `/api/config/automation/config/<id>` — same shape as scenes. Automations are
  authorable by the same mechanism, which is the door to schedules and presence rules
  without ever opening HA's UI.

---

## 5. Low-tap surfaces — the real answer to "minimize clicks"

Ranked by taps saved per unit of work. The brief's "minimize clicks and scrolls,
especially scrolling back and forth" is not primarily an in-app layout problem — the
biggest wins are outside the app entirely.

| Surface | Taps to change the room | Requires |
|---|---|---|
| **Siri phrase** | 0 (voice) | App Intents, §1 |
| **Control Center control** | 1 swipe + 1 tap, app never opens | `ControlWidget`, iOS 18+ |
| **Lock Screen control** | 1 tap, phone locked | same `ControlWidget` |
| **Action Button** | 1 press | any App Intent |
| **Home Screen widget** | 1 tap | interactive widget + App Intent |
| **App, top of first screen** | open + 1 tap | good IA |
| **App, after scrolling** | open + scroll + tap | the thing to eliminate |

Controls are driven by App Intents, so **one `ActivateSceneIntent` powers Siri, the
Control Center control, the widget, the Action Button and the Shortcuts app at once**.
That is the architectural payoff: write the intent once, get six surfaces.
([WWDC24 "Extend your app's controls across the system"](https://developer.apple.com/videos/play/wwdc2024/10157/))

Notes from the sources: widget interactivity is limited to `Button` and `Toggle`, and
only via intents; `requestConfirmation` exists for destructive actions but a light
switch does not warrant it — confirming a lamp trains people to tap through. I found
no documented hard cap on controls per app (one shipping app has nine).

---

## 6. Home-automation UX patterns

Consistent across the design sources, and they line up with the brief:

- **Zone/room-first navigation** — tap where the thing physically is; spatial memory
  beats menu memory. (The repo's own design doc calls the spatial room map "the most
  interesting version of this UI" and cut it from v1 for cost.)
- **Direct manipulation over menus** — a slider you drag, not a value you pick.
- **High-visibility touch targets** as the primary layer; detail behind them.
- **Transparency about automation** — "dimmed because sunset", never silent change.
  This maps directly onto the repo's existing invariant #4 (report partial
  application).
- **One app, consistent gesture vocabulary** across every device class.

Sources here are design-blog quality, not primary research — treat as corroboration
for decisions, not as evidence.

---

## Confidence

| Finding | Confidence | Basis |
|---|---|---|
| Live inventory: 2 lamps, 0 scenes, empty DB | **High** | Read directly off the instance and the database |
| Parameterized App Shortcut phrases from a runtime entity list | **High** | Apple WWDC23 session, plus three secondary sources |
| 10 shortcuts / 1,000 phrases / `applicationName` mandatory | **High** | Apple, stated explicitly |
| `alternativeNames` synonyms, updated via `updateAppShortcutParameters()` | **High** | Apple, stated explicitly |
| No smart-home assistant schema domain | **Medium-High** | Domain list consistent across sources; Apple's index page did not render for a direct read |
| `/api/config/scene/config/<id>` shape, admin gate, writes `scenes.yaml`, reloads | **High** | HA source read directly, plus a live probe against our instance |
| `scene.create` does not survive restart | **High** | Core issue + several community threads agree |
| iOS 26.6 current, iOS 27 in beta for ~Sept 2026 | **High** | Two independent trackers |
| WWDC26 App Intents additions | **Medium** | Single session page; features are iOS 27-era anyway |
| UX patterns | **Low-Medium** | Design blogs, no primary research |

## Open questions

- Whether HA will keep `/api/config/scene/config/*` stable. Undocumented, frontend
  depends on it, no promise. Mitigated by an adapter + a round-trip test.
- Whether the 1,000-phrase ceiling truncates or rejects. Irrelevant below ~100 scenes.
- Whether `updateAppShortcutParameters()` reliably refreshes Spotlight titles —
  [one open developer forum thread](https://developer.apple.com/forums/thread/817109)
  reports stale parameter titles after calling it. Siri matching appears unaffected.
- The two unpaired bulbs. Everything here works with two; scene design does not.

## Sources

Apple — primary:
[Spotlight your app with App Shortcuts (WWDC23)](https://developer.apple.com/videos/play/wwdc2023/10102/) ·
[Discover new capabilities in the App Intents framework (WWDC26)](https://developer.apple.com/videos/play/wwdc2026/345/) ·
[Build intelligent Siri experiences with App Schemas (WWDC26)](https://developer.apple.com/videos/play/wwdc2026/240/) ·
[App intent domains](https://developer.apple.com/documentation/appintents/app-intent-domains) ·
[Extend your app's controls across the system (WWDC24)](https://developer.apple.com/videos/play/wwdc2024/10157/) ·
[Bring your app to Siri (WWDC24)](https://developer.apple.com/videos/play/wwdc2024/10133/) ·
[App Shortcut parameter title does not update after updateAppShortcutParameters()](https://developer.apple.com/forums/thread/817109)

Home Assistant — primary:
[REST API](https://developers.home-assistant.io/docs/api/rest/) ·
[WebSocket API](https://developers.home-assistant.io/docs/api/websocket/) ·
[Scenes](https://www.home-assistant.io/docs/scene/) ·
[Scene editor](https://www.home-assistant.io/docs/scene/editor/) ·
[`components/config/scene.py`](https://github.com/home-assistant/core/blob/dev/homeassistant/components/config/scene.py) ·
[HomeKit Bridge](https://www.home-assistant.io/integrations/homekit/) ·
[core#133912 — dynamic scene lost on restart](https://github.com/home-assistant/core/issues/133912) ·
[core#68453 — no documented way to get scene detail](https://github.com/home-assistant/core/issues/68453) ·
[Companion app: Apple App Intents](https://companion.home-assistant.io/docs/integrations/siri-shortcuts/)

Secondary:
[iOS version history (Macworld)](https://www.macworld.com/article/1659017/ios-versions-list.html) ·
[iOS 27 roundup (MacRumors)](https://www.macrumors.com/roundup/ios-27/) ·
[Performing your app actions with Siri through App Shortcuts Provider](https://www.createwithswift.com/performing-your-app-actions-with-siri-through-app-shortcuts-provider/) ·
[Creating App Intents using Assistant Schemas](https://www.createwithswift.com/creating-app-intents-using-assistant-schemas/) ·
[Exploring WidgetKit: Control Widgets in iOS 18](https://rudrank.com/exploring-widgetkit-first-control-widget-ios-18-swiftui) ·
[The UX of a smart home (UXPin)](https://www.uxpin.com/studio/blog/the-ux-of-a-smart-home/)
