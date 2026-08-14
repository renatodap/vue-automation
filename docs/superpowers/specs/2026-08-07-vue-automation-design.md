# vue-automation — Design

**Date:** 2026-08-07
**Status:** Approved design, pending implementation plan

## Goal

Put the four living room lamps at The Vue under software control, with named
lighting scenes that can be triggered from a phone in one tap. Home Assistant is
the engine; a small custom web UI sits on top of it as the everyday surface.

This is a two-layer system on purpose. Home Assistant already solves device
discovery, state, scheduling, and recovery — rewriting any of that would be
wasted work. The custom UI exists only to be a better front door than a generic
entity dashboard.

## Hardware

| Piece | Model | Notes |
|---|---|---|
| Host | Raspberry Pi 5 | **Running.** HA OS, reachable at `10.0.0.67` / `homeassistant.local` |
| Storage | NVMe via HAT | Boots from NVMe; leaves all USB ports free |
| Networking | Onboard Wi-Fi (2.4 GHz) | Working, but see "Networking" below — this is the one thing worth changing later |
| Zigbee coordinator | HAUTECH Zigbee 3.0 USB Dongle (Silicon Labs EFR32MG24) | Delivered 2026-08-05 |
| Lights | 4× THIRDREALITY ZL1 A19 RGBCW | 800 lm, 2700–6500K, delivered 2026-08-04 |
| Fixtures | 4 living room lamps | All existing, all E26 |

Network is `10.0.0.0/24`, gateway `10.0.0.1`. HA serves on port 80, with 8123
redirecting to it.

### Host choice

An old Intel MacBook was briefly considered as the host and the spec was
rewritten around it, before the Pi was simply set up instead. The Pi is the right
answer and this is recorded only so the MacBook idea doesn't get revived without
its costs attached:

- **Broadcom BCM43xx Wi-Fi has no driver in HA OS.** That model has no built-in
  Ethernet either, so it would have had no network at all until a USB Ethernet
  adapter (~$20, ASIX AX88179 or Realtek RTL8153 chipset) was purchased and
  attached.
- **Linux suspends on lid close**, and HA OS doesn't expose the `logind` setting
  that changes it. A suspended host means dead lights.
- **An old battery on permanent AC is a real fire risk** in a way a Pi never is.

The MacBook remains a viable fallback if the Pi fails, and is a genuinely good
candidate for a wall-mounted kiosk display later — see "Out of scope".

## Architecture

```
4× ZL1 bulbs
   └─ Zigbee 3.0 mesh (bulbs are mains-powered, so they also route)
        └─ HAUTECH MG24 coordinator  [USB 2.0 port, on extension cable]
             └─ Zigbee2MQTT ──MQTT──> Mosquitto broker
                                          └─ Home Assistant (HA OS, Raspberry Pi 5)
                                               ├─ scene entities (YAML, in this repo)
                                               └─ WebSocket API
                                               └─ REST API  ← ── ── ── ┐
                                                                       │
                                                            Tailscale (WireGuard)
                                                                       │
   Phone ──HTTPS──> renatodap.me/vue-automation ──> Next.js on Persimmon (Hetzner)
```

Each layer is independently testable: the mesh works before MQTT exists, HA
works before scenes exist, scenes work before the UI exists.

### Why Tailscale, and why the browser never talks to HA

The PWA is hosted on the Persimmon box in Falkenstein. Home Assistant is at
`10.0.0.67` on a home LAN in Indianapolis. Two independent walls sit between
them, and only one solution clears both:

1. **A private address is not routable from the internet.** A server in Germany
   has no path to `10.0.0.*`.
2. **An HTTPS page cannot call a plaintext LAN address.** Even standing in the
   apartment, the browser blocks it as mixed content. "Just have the phone talk
   to the Pi directly" fails on this, not on routing.

So the Pi and the Persimmon server join one tailnet, and **every Home Assistant
call is made server-side**. This is not only a workaround — it's the better
design regardless:

- The HA token never reaches the browser. It grants full control of the house;
  shipping it to the client would hand anyone with devtools the same power.
- Nothing about Home Assistant is exposed publicly. The only public surface is
  this app, behind its own passphrase.
- The app works identically on cellular, on hotel wifi, and on the couch,
  because the phone's network is irrelevant to it.

## Networking — Wi-Fi works, wired is better

The Pi is on its onboard 2.4 GHz Wi-Fi. That works, and nothing here is blocked
on changing it.

The catch is that **2.4 GHz Wi-Fi and Zigbee share a band**, and the Pi's radio
sits inches from where the coordinator plugs in. This is the standard cause of
short Zigbee range and bulbs that drop off the mesh. Two mitigations, in order of
effort:

1. **Put the dongle on a USB extension cable** — already required for other
   reasons, and buys the most improvement for the least effort.
2. **Move the Pi to Ethernet and disable its Wi-Fi**, if dropouts show up later.

Treat this as the first suspect if Zigbee misbehaves, rather than something to
fix pre-emptively.

## Phase 0 — Bring-up

Ordered, because several steps fail invisibly if done out of order.

- [x] HA OS installed on the Pi 5 and booted from NVMe.
- [x] On the network at `10.0.0.67`, resolving as `homeassistant.local`.
- [ ] **Complete HA onboarding.** Account is local-only with no recovery path —
      store the password in a password manager immediately. Set location,
      elevation, timezone, and units correctly; sun-based automations depend on
      the coordinates. Skip the device auto-discovery offer and add things
      deliberately.
- [ ] Install the **Mosquitto broker** add-on. Start it, and enable both "start
      on boot" and "watchdog".
- [ ] Install the **Zigbee2MQTT** add-on, but don't start it yet.
- [ ] **Now plug in the MG24** — into a **black USB 2.0 port**, via a short USB
      extension cable, never seated directly against the board. The blue USB 3
      ports are the worst possible choice; USB 3 emits directly into the Zigbee
      band.
- [ ] Point Z2M at the coordinator's serial path, start it, and read the log
      before pairing anything. Verify the coordinator firmware — MG24 sticks ship
      with varying firmware and may need flashing.
- [x] Zigbee2MQTT 2.13.0 running. **The adapter must be set explicitly**:
      `serial.adapter: ember` alongside the port. Without it Z2M fails with
      "No valid USB adapter found" even though the port is correct — auto-detect
      does not recognise this stick. Coordinator reports EmberZNet 7.4.5 [GA].
- [ ] Pair the four bulbs, naming each by physical position rather than "Lamp 1–4".
      2 of 4 done: `light.shelf_lamp`, `light.floor_lamp`.
- [x] Tailscale on both ends — `homeassistant` = `100.85.128.101`,
      `persimmon-eu` = `100.125.141.65`. `HA_BASE_URL=http://100.85.128.101`
      (port 80, not 8123 — HA serves on 80 here).
- [ ] **Configure HA backups before building anything on top.** Losing the NVMe
      otherwise loses the whole setup.

### Gotchas hit during bring-up, recorded so they aren't rediscovered

- **The Apps (formerly Add-ons) panel is missing from the UI entirely.** The
  `hassio` component loads and the Supervisor is healthy, but no `hassio` panel
  is registered and `/hassio/store` 404s. Known unresolved upstream issue. The
  console `ha` CLI and the Supervisor API both still work.
- **The Supervisor proxy (`/api/hassio/*`) rejects long-lived tokens** with 401,
  while `/api/*` accepts them. Add-on management needs either the console, or
  `$SUPERVISOR_TOKEN` from inside an add-on container.
- **The `ha >` console is not a shell** — no pipes, no `grep`.
- **Zigbee2MQTT 2.x waits on an onboarding page** and will not start the Zigbee
  stack until it receives `POST /submit`. It re-arms this on every restart.
- **Renaming a device in Z2M does not rename the HA entity** (`homeassistant_rename:
  false`); the entity registry needs a separate update to get `light.<name>`.

### Wi-Fi gotchas, 2026-08-14 — an evening lost to each of these

Recorded from a real debugging session, not from documentation. Both of these
present as the *same* symptom, which is the whole problem.

- **`ha network update --wifi-ssid` is case-sensitive, and a wrong SSID fails
  with the exact same error as a wrong password.** The console reports
  `Activating connection failed, check connection settings.` for *both* "network
  not found" and "auth rejected" — the message does not discriminate, so it tells
  you nothing about which half is wrong. A real incident here: `"Dap's Home"` was
  entered for a network actually named `"DAP's Home"`, and the resulting hours
  were spent re-checking the password. **Read the SSID off a device that is
  already connected, character by character, before touching the password.**
  (The same generic message is
  [supervisor#4166](https://github.com/home-assistant/supervisor/issues/4166).)

- **Home Assistant's CLI cannot join a WPA3-only network — the radio can, the
  CLI can't ask.** HA OS enabled WPA3-SAE in `wpa_supplicant` in
  [11.3](https://github.com/home-assistant/operating-system/releases/tag/11.3)
  ("Enable WPA3 support in wpa_supplicant to support WPA3-SAE"), but the
  Supervisor's `AuthMethod` enum still accepts only `open`, `wep` and `wpa-psk`
  ([`supervisor/host/const.py`](https://github.com/home-assistant/supervisor/blob/main/supervisor/host/const.py)),
  so `ha network update --wifi-auth` has no way to say `sae`. NetworkManager is
  handed `key_mgmt` = `WPA-PSK WPA-PSK-SHA256 FT-PSK`, association fails, and it
  times out with **`ssid-not-found`** — which reads exactly like the typo above.
  This is [supervisor#5348](https://github.com/home-assistant/supervisor/issues/5348),
  opened 2024-10-11 and **closed as not planned**: it is a permanent property to
  design around, not a bug to wait out.

  Two workarounds, in order of effort:
  1. **Set the router to WPA2/WPA3 transitional mode.** The AP then offers
     WPA2-PSK alongside SAE and `wpa-psk` associates normally.
  2. **Import a NetworkManager keyfile with `key-mgmt=sae`** — write it to
     `CONFIG/network/my-network` on a USB stick labelled `CONFIG` (all caps,
     **Unix LF line endings**), insert it, and run **`ha os import`** (or reboot;
     the stick is read at startup). The stick can be removed afterwards.
     ([HAOS configuration](https://developers.home-assistant.io/docs/operating-system/configuration/))

  **Do not conclude "WPA3-only" from what a Mac reports.** 6 GHz mandates WPA3 by
  spec — WPA2 is not permitted on that band at all — so a Mac showing
  "WPA3 Personal" while associated on a 6 GHz channel says *nothing* about the
  2.4/5 GHz bands, and the Pi's onboard radio only uses those. Check the router's
  per-band security settings, not the client's status line.

### The recovery path, when the home Wi-Fi is the broken thing

**The Pi needs *internet*, not the home network.** The app reaches Home Assistant
over Tailscale (`HA_BASE_URL=http://100.85.128.101`), never over the apartment
LAN — see "Why Tailscale, and why the browser never talks to HA" above. Nothing
in the path from phone → Persimmon → Pi depends on which network the Pi is on, or
on the phone and the Pi being on the same one.

So **a phone hotspot is a complete disaster-recovery path.** Point the Pi at a
hotspot — with `ha network update`, or by moving the USB `CONFIG` stick to it —
and Tailscale re-establishes, the PWA works from anywhere in the world, and the
lights come back on while the router is still broken. The apartment's Wi-Fi is a
convenience, not a dependency.

This was not designed as a recovery feature. It falls out of hosting the UI
off-site, which the "Tradeoff accepted" note below treats as a *cost*. On the
evening the router broke, it was the thing that worked.

## Zigbee stack: Zigbee2MQTT

Chosen over ZHA. Both support an EFR32MG24 coordinator, but Z2M gives readable
logs, link quality, and route tables — the difference between diagnosing a
dropped bulb in minutes versus guessing. ThirdReality support also lands there
first. Cost is one extra moving part (the broker).

ZHA is a valid fallback. Nothing downstream depends on the choice: the UI talks
to Home Assistant, not to the Zigbee layer.

## Scenes

Defined as HA `scene` entities in YAML, versioned in this repo rather than
authored through the HA UI, so they're diffable and restorable.

Scene contents are deliberately not specified here — they should be tuned
against the real bulbs in the real room, at night, rather than designed on paper.
The starting set is four moods; names and levels get settled during
implementation.

**Design constraint carried into every scene:** a smart bulb is only smart while
it has power. All four lamp switches stay permanently on. Any lamp with an
inline foot switch or pull chain is the most likely thing to break this system in
week two; a Zigbee button or smart plug is the standard fix.

**Known quality caveat:** ThirdReality does not publish CRI 90+ for the ZL1
(they're approximately 80 CRI). Worth judging in person before buying more bulbs.

## Custom UI

A Next.js scene picker — named moods as large tappable cards. No entity lists, no
per-bulb sliders, no settings. HA's own companion app stays installed underneath
for real controls and debugging, which is what keeps the custom surface small.

- **Next.js 16 / React 19 / Tailwind v4**, deployed to Persimmon under
  `renatodap.me/vue-automation`, path-mounted like the rest of the fleet.
- **Server-side HA REST client** with a long-lived access token, over the
  tailnet. The client polls `/api/state` — one round trip returning scenes,
  lamps and health together — and only while the tab is visible.
- **Dark by default.** The app's job is dimming lights in a dark room; a cream
  screen at 9pm undoes what the user just asked for. Light mode is opt-in.
- **Shared passphrase**, exchanged for a signed cookie. One user, no accounts.
  The middleware runs on every request with no `config.matcher`, because a
  matcher can never match the exact basePath root — the hole that left another
  app in this fleet serving its dashboard unauthenticated.

**Tradeoff accepted:** hosting off-site means the lights stop responding *from
this app* when the home internet drops, where a Pi-hosted UI would not. Home
Assistant itself keeps running, and its own app on the local network still
works. Cellular access every other day of the year is worth more than
graceful degradation during an outage.

### Failure behavior

| Condition | Behavior |
|---|---|
| Bulb unreachable (lamp switched off at the lamp) | Lamp greys out; scene applies to reachable lights and reports which it couldn't |
| HA restart / Pi reboot | UI reconnects with backoff rather than hanging on a dead socket |
| Token invalid or expired | Explicit re-auth state, not a blank screen |
| Zigbee coordinator unplugged | HA reports the integration down; UI surfaces it rather than silently failing every tap |

## Testing

- Scenes verified through HA Developer Tools before any UI exists.
- UI tested against a **mock HA WebSocket server**, so scene logic and reconnect
  behavior are testable without touching real bulbs or needing the host up.
- A Playwright pass against the real instance before calling it done.

## Explicitly out of scope for v1

Kept out to stay shippable; each is additive later.

- Spatial room map (tap a lamp where it physically sits). The most interesting
  version of this UI, and roughly triples v1.
- Scene authoring/tuning from the UI.
- Wall-mounted tablet / kiosk mode.
- Remote access from outside the apartment.
- LED strips, sensors, blinds, voice control, non-living-room lights.
- Any coupling to `vue-view` or `vue-plan`.

## Risks

| Risk | Mitigation |
|---|---|
| Zigbee range or dropouts | **Most likely problem, given the Pi is on 2.4 GHz Wi-Fi.** Dongle on an extension cable in a USB 2.0 port; move the Pi to Ethernet and disable Wi-Fi if it persists |
| MG24 firmware incompatible with Z2M | Check firmware before pairing; reflashing is documented but tedious |
| Someone switches a lamp off physically | Scenes degrade gracefully and report it; Zigbee buttons if it becomes routine |
| NVMe loss takes HA with it | Configure HA backups before building anything on top |
| HA onboarding password lost | Local account with no recovery path — into a password manager at creation time |
| Pi proves unreliable as a host | The Intel MacBook remains a fallback, at the cost of a USB Ethernet adapter and the lid-sleep and battery problems documented above |
