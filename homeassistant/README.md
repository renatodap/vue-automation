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

## The four lamps

| Entity | Where |
|---|---|
| `light.shelf_lamp` | ladder shelf, right of the TV wall |
| `light.floor_lamp` | arc lamp over the couch |
| `light.abajour` | table lamp behind the couch, left |
| `light.tv_lamp` | small lamp on the TV console |

Named by physical position on purpose. `light.lamp_3` is unreadable a month
later, and every scene in the system references these names.

## Migrations

`migrations/` holds SQL for the PWA's own Postgres database on the Persimmon
box, not for Home Assistant. Nothing re-applies them on boot, so each one is
written to be safe to run twice. Apply with:

```
/Users/renatodaprado/dev/Persimmon/infra/bin/infra db exec vue-automation -- \
  bash -c 'psql "${DATABASE_URL%%\?*}" -f -' < migrations/<file>.sql
```
