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
                                                    └─ Next.js scene picker (LAN, served from the host)
```

Each layer is independently testable: the mesh works before MQTT exists, HA
works before scenes exist, scenes work before the UI exists.

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
- [ ] Pair the four bulbs, naming each by physical position rather than "Lamp 1–4".
- [ ] **Configure HA backups before building anything on top.** Losing the NVMe
      otherwise loses the whole setup.

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

- **Served from the HA host, on the LAN.** Lights keep working when the internet is
  down, there's no tunnel to maintain, and nothing is exposed publicly.
- **Talks to HA over the WebSocket API** with a long-lived access token.
  Subscribes to `state_changed` for live state; sends `scene.turn_on` and
  `light.turn_on` to act.
- **Remote access is deferred.** Tailscale adds it later without changing this
  design.

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
