# vue-automation

Lighting control for the living room: Home Assistant on a Raspberry Pi 5
driving four Zigbee bulbs, and a phone-first PWA that turns the whole thing
into five tappable scenes.

```
web/             Next.js 16 PWA — the scene picker
homeassistant/   Versioned HA scenes + SQL migrations for the PWA's database
docs/            Design spec
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
