# Home Assistant config

Versioned copies of what lives on the Pi. Home Assistant is the source of
truth for scenes and device state; the PWA in `web/` only reads and triggers
them.

## Why the entity IDs are placeholders

`scenes.yaml` cannot be finished until the four ThirdReality ZL1 bulbs are
paired, because Zigbee2MQTT assigns entity IDs from the names given at pairing
time. Pair first, name each bulb by **physical position** (`light.floor_lamp`,
not `light.lamp_1` — you will not remember which is which in a month), then
replace the placeholders.

## Applying it

Home Assistant reads `scenes.yaml` from its config directory. Copy the file
there and reload scenes from Developer Tools → YAML → Scenes, or restart HA.

There is no automatic sync from this repo to the Pi. That is deliberate for
now — an unattended config push into a running house is a bigger mechanism
than four lamps justify.

## Migrations

`migrations/` holds SQL for the PWA's own Postgres database on the Persimmon
box, not for Home Assistant. Nothing re-applies them on boot, so each one is
written to be safe to run twice. Apply with:

```
/Users/renatodaprado/dev/Persimmon/infra/bin/infra db exec vue-automation -- \
  bash -c 'psql "${DATABASE_URL%%\?*}" -f -' < migrations/<file>.sql
```
