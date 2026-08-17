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

A Zemismart 4-button remote, `0x6ce4a4fffe99d9c7` (Home Assistant device id
`864e487ec5cd7cfd448d8b1c51dcfcdf`). Top to bottom:

| Button | Does |
|---|---|
| 1 | `scene.warm_20` |
| 2 | `scene.orange_70` |
| 3 | `scene.bright` |
| 4 | every light off |

Home Assistant only projects the remote's battery, link-quality and voltage —
there is no action or event entity — so the presses are reachable as MQTT or as
a device trigger, and neither is something the PWA can author. `/api/automations`
deliberately speaks clock times and sun offsets only; widening it to take
arbitrary triggers would turn it into a general automation writer, which is what
invariant 8 exists to prevent.

Bind them from anything on the tailnet:

```
HA_TOKEN=xxx ./homeassistant/bin/bind-remote.sh
```

The script is idempotent — fixed automation ids, so re-running updates the four
in place. It matches several spellings of each action (`1_single`,
`button_1_single`, `1_click`, `1_press`) because Zigbee2MQTT's naming varies by
converter, and a trigger that never matches fails **silently**: no error, the
light simply never comes on.

Doing it by hand instead: Settings → Automations → Create → trigger **Device**,
pick the remote, choose the button, action **Scene: activate**. The UI lists the
real action names, so it cannot guess wrong — it is four trips through a wizard
rather than one command.

## Migrations

`migrations/` holds SQL for the PWA's own Postgres database on the Persimmon
box, not for Home Assistant. Nothing re-applies them on boot, so each one is
written to be safe to run twice. Apply with:

```
/Users/renatodaprado/dev/Persimmon/infra/bin/infra db exec vue-automation -- \
  bash -c 'psql "${DATABASE_URL%%\?*}" -f -' < migrations/<file>.sql
```
