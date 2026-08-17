# Home Assistant

Home Assistant on the Pi is the source of truth for devices, scenes and
schedules. The PWA in `web/` reads and writes them over its API.

## There is no scenes.yaml here any more

There used to be a template with placeholder entity IDs, to be filled in after
pairing. It's gone, because the app now authors scenes directly through HA's
scene-editor API — arrange the lamps, tap "Save current", name it. Keeping a
YAML copy alongside that would be a second source of truth that silently drifts
from the real one.

The same applies to schedules: created in the app, stored by HA.

## The nine lamps

| Entity | Room | Where |
|---|---|---|
| `light.shelf_lamp` | Living | ladder shelf, right of the TV wall |
| `light.floor_lamp` | Living | arc lamp over the couch |
| `light.abajour` | Living | table lamp behind the couch, left |
| `light.tv_lamp` | Living | small lamp on the TV console |
| `light.0xb4e8428fd6070000` | Living | kitchen pendant 1 |
| `light.0xb4e8428ffab10000` | Living | kitchen pendant 2 |
| `light.0xa4c138939b2d0b23` | Living | keyboard strip — the LED strip |
| `light.0xb4e8428f428b0000` | Bedroom | bedroom lamp |
| `light.0xb4e84290af510000` | Bedroom | bedroom floor lamp |

The first four are named by physical position on purpose — `light.lamp_3` is
unreadable a month later. The five newer ones were never renamed in
Zigbee2MQTT, so they answer to their raw IEEE address; renaming them there
would change these entity ids and orphan every scene that references them.

Which room a lamp is in is **not** stored here. It lives in
`web/src/lib/rooms.ts`, because Home Assistant does not expose its area
registry over the REST API the app talks to.

### What these bulbs actually do

The seven Third Reality ZL1s advertise a 2000K floor they cannot reach. Ask for
2000K and they settle at **2202K** and report that back; that is their warmest
white, and no amount of retrying moves them further. The Tuya strip really does
reach 2000K, which is why the two dim scenes store 2202K for eight lamps and
2000K for the strip.

They also report state **late**. A read taken a second after a write echoes the
old value, so a write verified against its own response looks like it failed
when it did not. Re-read a few seconds later instead.

## The wall remote

A Zemismart 4-button remote, `0x6ce4a4fffe99d9c7`. **Bound and working.** Top to
bottom:

| Button | Action | Does |
|---|---|---|
| 1 | `1_single` | `scene.warm_20` |
| 2 | `2_single` | `scene.orange_70` |
| 3 | `3_single` | `scene.bright` |
| 4 | `4_single` | every light off |

Home Assistant only projects the remote's battery, link-quality and voltage —
there is no action or event entity — so the presses are reachable only as MQTT
on `zigbee2mqtt/0x6ce4a4fffe99d9c7`, which the PWA cannot author.
`/api/automations` deliberately speaks clock times and sun offsets only.

Rebuild them with `bin/bind-remote.sh` (idempotent, fixed ids). Two traps are
baked into that script because both cost real debugging:

- **Match the payload in the TRIGGER, not in a condition.** The first attempt
  pulled the button digit out of the action with a template and compared it to
  `'1'`. It never fired and never errored — Home Assistant parses template
  results into native types, so `'1'` was the integer `1`, and `1 == '1'` is
  false.
- **The strip needs its brightness sent separately, afterwards.** See below.

## The strip throws brightness away

The Tuya strip drops the brightness component whenever brightness and colour
temperature arrive in the SAME command — which is exactly how a scene applies.
Send brightness on its own and it obeys instantly.

So every scene silently leaves it at whatever brightness it was already on.
Both paths now correct for it: the remote automations follow each scene with a
brightness-only command, and `/api/scene` re-reads the scene's stored definition
and re-sends brightness for any lamp in `SPLIT_BRIGHTNESS` (`web/src/lib/ha.ts`).
The one-tap looks on Home go through `applyLightPatches`, which splits the same
way.

## Migrations

`migrations/` holds SQL for the PWA's own Postgres database on the Persimmon
box, not for Home Assistant. Nothing re-applies them on boot, so each one is
written to be safe to run twice. Apply with:

```
/Users/renatodaprado/dev/Persimmon/infra/bin/infra db exec vue-automation -- \
  bash -c 'psql "${DATABASE_URL%%\?*}" -f -' < migrations/<file>.sql
```
