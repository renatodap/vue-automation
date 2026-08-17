# vue-automation

Lighting control for the flat: Home Assistant on a Raspberry Pi 5 driving nine
Zigbee bulbs across the living room and the bedroom, and a phone-first PWA that
turns the whole thing into a room list and a handful of tappable scenes.

```
web/             Next.js 16 PWA — rooms, scenes, schedules, devices
ios/             SwiftUI app — scenes, the room map, and user-defined Siri phrases
mcp/             Claude MCP connector (lights-mcp.renatodap.me) — see docs/architecture
homeassistant/   Versioned HA scenes + SQL migrations for the PWA's database
docs/            Design spec, research, architecture
```

## How it fits together

```
bulbs → Zigbee mesh → MG24 coordinator → Zigbee2MQTT → Mosquitto → Home Assistant (Pi)
                                                                          ↑
                                                                    Tailscale
                                                                          ↑
phone → https://renatodap.me/vue-automation → Next.js on Persimmon (Hetzner)
```

**Every Home Assistant call is server-side.** The browser never talks to HA
directly — it can't (a private LAN address isn't routable from Germany, and an
HTTPS page can't call plaintext `http://10.0.0.x` even from the couch), and it
shouldn't (the HA token grants full control of the house).

Home Assistant owns the truth. Scenes live there, not here; the app reads the
scene list rather than keeping its own, so adding a scene in HA makes it appear
in the app with no deploy.

**The Pi needs internet, not the home Wi-Fi.** Everything reaches Home Assistant
over Tailscale, so the network the Pi happens to be on is irrelevant to the app —
see the outage note below, because this is the thing that gets the lights back.

## Develop

```bash
cd web
cp .env.example .env.local   # fill in HA_BASE_URL, HA_TOKEN, APP_PASSPHRASE, AUTH_SECRET
npm install
npm run dev
```

Before pushing anything non-trivial:

```bash
cd web && npx tsc --noEmit && npm run build
```

## Deploy

Push to `main`. Coolify rebuilds via webhook. Env vars live in Coolify, not
here.

```bash
/Users/renatodaprado/dev/Persimmon/infra/bin/infra deploy vue-automation
/Users/renatodaprado/dev/Persimmon/infra/bin/infra logs vue-automation -f
```

## The things that will break it

- **A lamp switched off at the lamp.** A smart bulb is only smart while it has
  power. The app reports these as unreachable rather than pretending the scene
  applied cleanly, but the fix is physical: leave the switches on.
- **Tailscale down on either end.** The app shows a disconnected state. Home
  Assistant itself keeps running and its own app still works on the LAN.
- **A rotated HA token.** Long-lived tokens don't expire, but revoking one in
  HA breaks this app until `HA_TOKEN` is updated in Coolify.
- **The home Wi-Fi.** Not fatal — see below. It is the one outage with a fix
  that takes five minutes.

### The home Wi-Fi is down. Read this first.

**A phone hotspot is a complete recovery path.** `HA_BASE_URL` is a Tailscale
address (`http://100.85.128.101`), so nothing in phone → Persimmon → Pi cares
which network the Pi is on, or whether the phone is anywhere near it. Give the Pi
*any* internet and Tailscale re-establishes, the PWA works from anywhere, and the
lights come back on while the router is still broken.

```bash
# at the HA console (keyboard + monitor on the Pi, or its own app on the LAN)
ha network update wlan0 --ipv4-method auto --wifi-auth wpa-psk \
  --wifi-mode infrastructure --wifi-ssid "SSID" --wifi-psk "PASSWORD"
```

Two traps, both of which cost an evening on 2026-08-14 and are written up in
[the design doc's Wi-Fi gotchas](docs/superpowers/specs/2026-08-07-vue-automation-design.md#wi-fi-gotchas-2026-08-14--an-evening-lost-to-each-of-these):
the SSID is **case-sensitive** and a wrong one fails with the identical error to
a wrong password, and the HA CLI **cannot join a WPA3-only network** at all.

An iPhone hotspot defaults to WPA2/WPA3 *transitional*, so it offers WPA2-PSK
alongside SAE and `--wifi-auth wpa-psk` associates fine. If it doesn't, turn on
**Settings → Personal Hotspot → Maximize Compatibility**, which forces WPA2-only
and 2.4 GHz ([Apple](https://support.apple.com/guide/security/wi-fi-security-with-apple-devices-secfd166f620/web)).
The same fix applies to the router: WPA2/WPA3 transitional mode, not WPA3-only.
