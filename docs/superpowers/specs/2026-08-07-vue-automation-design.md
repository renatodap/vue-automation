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
| Host | Raspberry Pi 5 | Needs the official 27W USB-C supply and active cooling |
| Storage | NVMe via HAT | Boots from NVMe; leaves all USB ports free |
| Zigbee coordinator | HAUTECH Zigbee 3.0 USB Dongle (Silicon Labs EFR32MG24) | Delivered 2026-08-05 |
| Lights | 4× THIRDREALITY ZL1 A19 RGBCW | 800 lm, 2700–6500K, delivered 2026-08-04 |
| Fixtures | 4 living room lamps | All existing, all E26 |

Flashing is done through a USB→NVMe enclosure attached to the Mac. Network is
`10.0.0.0/24`, gateway `10.0.0.1`. No Ethernet cable currently on hand, so
first-boot networking happens over the local console (micro-HDMI + USB keyboard).

## Architecture

```
4× ZL1 bulbs
   └─ Zigbee 3.0 mesh (bulbs are mains-powered, so they also route)
        └─ HAUTECH MG24 coordinator  [USB 2.0 port, on extension cable]
             └─ Zigbee2MQTT ──MQTT──> Mosquitto broker
                                          └─ Home Assistant (HA OS, Pi 5)
                                               ├─ scene entities (YAML, in this repo)
                                               └─ WebSocket API
                                                    └─ Next.js scene picker (LAN, served from Pi)
```

Each layer is independently testable: the mesh works before MQTT exists, HA
works before scenes exist, scenes work before the UI exists.

## Phase 0 — Bring-up

Ordered, because several steps fail invisibly if done out of order.

1. Flash HA OS to the NVMe in the USB enclosure using Raspberry Pi Imager
   (**not currently installed on the Mac** — install it first). Seat the NVMe in
   the HAT afterward.
2. Attach a display to the micro-HDMI port **nearest the USB-C power connector**
   (HDMI0). A lone display on the far port sometimes produces no output during
   early boot. Attach a USB keyboard — Bluetooth won't work pre-pairing.
3. Boot. If nothing appears, the bootloader EEPROM predates NVMe boot support or
   its boot order excludes NVMe. Fix by booting Raspberry Pi OS from a microSD
   and updating the bootloader, then retry.
4. At the `ha >` console prompt, join Wi-Fi:
   ```
   ha network update wlan0 --ipv4-method auto \
     --wifi-mode infrastructure --wifi-auth wpa-psk \
     --wifi-ssid "SSID" --wifi-psk "PASSWORD"
   ```
   `ha network info` reports the assigned IP.
5. Complete HA onboarding at `http://<ip>:8123` from the Mac.
6. Install the **Mosquitto broker** add-on, then the **Zigbee2MQTT** add-on.
7. **Only now** plug in the MG24 — into a **black USB 2.0 port, via a short USB
   extension cable.** Verify the coordinator firmware in Z2M before pairing; MG24
   sticks ship with varying coordinator firmware and may need flashing.
8. Pair the four bulbs, name them by physical position, not by "Lamp 1–4".

### Why Ethernet is still worth buying

Wi-Fi works, but the Pi's onboard radio is 2.4 GHz — the same band as Zigbee,
transmitting inches from the coordinator. Wiring the Pi and disabling its Wi-Fi
removes an interference source sitting right on top of the dongle. In a 767 sqft
unit, coordinator placement doesn't otherwise matter; the bulbs act as routers
and will cover the whole apartment from any corner.

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

- **Served from the Pi, on the LAN.** Lights keep working when the internet is
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
  behavior are testable without touching real bulbs or needing the Pi up.
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
| NVMe won't boot (bootloader EEPROM too old) | Monitor attached during first boot makes this visible immediately; microSD + bootloader update is the fix |
| MG24 firmware incompatible with Z2M | Check firmware before pairing; reflashing is documented but tedious |
| Zigbee range or dropouts | Dongle on an extension cable, off USB 3; wire the Pi and disable its Wi-Fi |
| Someone switches a lamp off physically | Scenes degrade gracefully and report it; Zigbee buttons if it becomes routine |
| SD/NVMe loss takes HA with it | Configure HA backups before building anything on top |
