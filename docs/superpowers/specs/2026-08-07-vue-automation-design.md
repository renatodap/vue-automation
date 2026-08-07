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
| Host | Intel MacBook (no built-in Ethernet) | Chosen over the Pi 5 by preference; see "Host choice" below |
| Storage | NVMe in a USB→NVMe enclosure | HA OS runs from the external drive; the MacBook's internal disk is never touched |
| Networking | USB Ethernet adapter — **must be purchased** | Mandatory, not optional. See "Networking" below |
| Zigbee coordinator | HAUTECH Zigbee 3.0 USB Dongle (Silicon Labs EFR32MG24) | Delivered 2026-08-05 |
| Lights | 4× THIRDREALITY ZL1 A19 RGBCW | 800 lm, 2700–6500K, delivered 2026-08-04 |
| Fixtures | 4 living room lamps | All existing, all E26 |

Network is `10.0.0.0/24`, gateway `10.0.0.1`.

### Host choice

A Raspberry Pi 5 with an NVMe HAT is on hand and is the technically better
appliance — bare-metal HA OS, real USB ports, a few watts, no moving parts, no
battery. The MacBook was chosen anyway. This section records the tradeoff so the
decision isn't re-litigated later, and so the failure modes below are understood
as accepted rather than overlooked.

**Running from external USB, not the internal SSD.** HA OS is written to the NVMe
in its USB enclosure, and the MacBook boots from it by holding Option at startup.
macOS stays intact on the internal disk. This is reversible — unplug the drive and
the machine is a laptop again — and it reuses hardware already owned, since the
NVMe is freed up by not using the Pi.

## Architecture

```
4× ZL1 bulbs
   └─ Zigbee 3.0 mesh (bulbs are mains-powered, so they also route)
        └─ HAUTECH MG24 coordinator  [USB 2.0 port, on extension cable]
             └─ Zigbee2MQTT ──MQTT──> Mosquitto broker
                                          └─ Home Assistant (HA OS, Intel MacBook)
                                               ├─ scene entities (YAML, in this repo)
                                               └─ WebSocket API
                                                    └─ Next.js scene picker (LAN, served from the host)
```

Each layer is independently testable: the mesh works before MQTT exists, HA
works before scenes exist, scenes work before the UI exists.

## Networking — wired is mandatory

On the Pi, Wi-Fi was a workable fallback. On an Intel MacBook it is not.

MacBooks use Broadcom BCM43xx wireless chips, which need proprietary firmware
that HA OS does not ship. The realistic expectation is **no wireless interface at
all** under HA OS. With no built-in Ethernet port on this model, that means the
machine has no network whatsoever until an adapter is attached.

**Buy a USB Ethernet adapter with an ASIX AX88179 or Realtek RTL8153 chipset.**
Both have in-tree Linux drivers and work without configuration. Cheap adapters
with obscure chipsets are the ones that don't come up, and diagnosing that on a
machine with no network is unpleasant. Roughly $20.

A wired host is also the better outcome for Zigbee: no 2.4 GHz radio transmitting
next to the coordinator, which is the same interference argument that applied to
the Pi.

## Phase 0 — Bring-up

Ordered, because several steps fail invisibly if done out of order.

1. Write the **HA OS generic x86-64** image to the NVMe in its USB enclosure,
   attached to the working Mac. Balena Etcher or `dd`; Raspberry Pi Imager is not
   needed on this path.
2. Attach the USB Ethernet adapter to the MacBook and plug it into the network.
   Do this before first boot so HA OS sees a link immediately.
3. Boot the MacBook holding **Option**, and select the external drive (it appears
   as "EFI Boot"). macOS on the internal disk is untouched and remains selectable.
4. HA OS should acquire a DHCP lease automatically. Find it at
   `http://homeassistant.local:8123`, or by checking the router's client list for
   a new device. `ha network info` at the console reports the IP directly.
5. Complete HA onboarding.
6. Install the **Mosquitto broker** add-on, then the **Zigbee2MQTT** add-on.
7. **Only now** plug in the MG24 — via a short USB extension cable, never seated
   directly against the chassis. Verify the coordinator firmware in Z2M before
   pairing; MG24 sticks ship with varying coordinator firmware and may need
   flashing.
8. Pair the four bulbs, name them by physical position, not by "Lamp 1–4".

### Laptop-specific setup

- **Leave the lid open.** Linux suspends on lid close by default, and a suspended
  host takes the lights down with it. HA OS does not expose the `logind` settings
  that normally fix this; changing it requires developer-mode shell access, which
  is off the supported path. An open lid is the reliable answer.
- **Keep it on AC permanently, and check the battery first.** A swollen battery in
  a machine that is always charging is the one genuine safety risk in this plan.
  If there is any bulge in the case or trackpad, remove the battery before
  putting the machine into service.
- **Set it somewhere ventilated.** An old laptop running continuously with the lid
  open needs airflow more than a Pi does.

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
| No network at all (Broadcom Wi-Fi unsupported, no built-in port) | USB Ethernet adapter with a known-good chipset, attached before first boot. This is the most likely thing to block Phase 0 |
| Mac won't boot the external drive | Hold Option at startup and select "EFI Boot". Intel Macs boot UEFI external media reliably; if it doesn't appear, the image was written to a partition rather than the whole device |
| Laptop suspends and takes the lights down | Lid stays open; verify it survives an hour idle before trusting it |
| Swollen battery on permanent AC | Inspect before service; remove the battery if there's any bulge |
| MG24 firmware incompatible with Z2M | Check firmware before pairing; reflashing is documented but tedious |
| Zigbee range or dropouts | Dongle on an extension cable, never seated against the chassis; wired host keeps a 2.4 GHz radio away from the coordinator |
| Someone switches a lamp off physically | Scenes degrade gracefully and report it; Zigbee buttons if it becomes routine |
| Drive loss takes HA with it | Configure HA backups before building anything on top |
| MacBook proves unreliable as a host | The Pi 5 and its HAT remain on hand as a drop-in fallback — the NVMe moves over and nothing above the OS layer changes |
