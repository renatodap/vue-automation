#!/usr/bin/env bash
#
# Bind the two Zemismart 4-button remotes — one per room.
#
#   HA_TOKEN=xxx HA_BASE_URL=http://100.85.128.101 ./homeassistant/bin/bind-remote.sh
#
# Idempotent: the automation ids are fixed, so re-running UPDATES them in place
# rather than stacking duplicates. The living-room ids are deliberately still
# `vue_remote_N` — the same ids the single-remote version wrote — so this
# REPLACES that behaviour instead of leaving a second set of automations firing
# on the same button.
#
# WHY NOT SCENES ANY MORE. Each remote used to apply a scene, and a Home
# Assistant scene is a fixed, whole-house entity list: there is no way to make
# one affect a single room. Now that each remote owns a room, the automations
# call light.turn_on with that room's entity ids directly. Two consequences
# worth knowing:
#
#   * The lamp lists below MUST match ASSIGNMENTS in `web/src/lib/rooms.ts`,
#     and the brightness/colour numbers MUST match `lookPatch` in the same file.
#     If they drift, the remote and the app's room buttons quietly disagree —
#     which is the one failure nobody notices until they are standing in the
#     room wondering why the wall control did something different.
#   * A new bulb is NOT picked up automatically. It has to be added here as
#     well as to rooms.ts, exactly like it has to be added to a scene.
#
# WHY NOT THE APP: /api/automations deliberately speaks clock times and sun
# offsets only. Widening it to accept arbitrary triggers would make it a general
# automation writer, which is exactly what invariant 8 says nothing gets.

set -euo pipefail

HA="${HA_BASE_URL:?Set HA_BASE_URL, e.g. http://100.85.128.101}"
: "${HA_TOKEN:?Set HA_TOKEN — Home Assistant → your profile → Long-lived access tokens}"

# ------------------------------------------------------------------- rooms
#
# Mirrors web/src/lib/rooms.ts. The kitchen pendants live under "living" there,
# and the app shows them under Living Room, so the living-room remote drives
# them too — the remote and the app's room button do the same thing.

LIVING_TOPIC="zigbee2mqtt/0x6ce4a4fffe99d9c7"
LIVING_LAMPS='"light.abajour", "light.floor_lamp", "light.shelf_lamp", "light.tv_lamp", "light.0xb4e8428fd6070000", "light.0xb4e8428ffab10000", "light.0xa4c138939b2d0b23", "light.0xa4c138f7081797c5"'
LIVING_STRIPS='"light.0xa4c138939b2d0b23", "light.0xa4c138f7081797c5"'

BED_TOPIC="zigbee2mqtt/0xd878f0fffec1edbb"
BED_LAMPS='"light.0xb4e84290af510000", "light.0xb4e8428f428b0000", "light.0xb4e842918a2f0000", "light.0xa4c13898403028f1"'
BED_STRIPS='"light.0xa4c13898403028f1"'

# ------------------------------------------------------------------ actions
#
# Every look is TWO commands. The second is not redundant: the Tuya strips drop
# the brightness component when brightness and a colour arrive together, which
# is exactly the shape of the first command. Sent alone, brightness lands
# instantly. This is invariant 11; every room here has at least one strip.
#
# The strips also run BRIGHTER than the lamps in the two dim looks, because they
# sit behind a desk, a television and a console — the level that reads as "dim"
# on a lamp in the open reads as "off" on those. Same rule as `STRIPS` in
# rooms.ts. The living room has TWO strips now, which is why the follow-up takes
# a list rather than a single id.

look_actions() { # lamps strips colour_json lamp_pct strip_pct
  cat <<JSON
    { "action": "light.turn_on",
      "target": { "entity_id": [ $1 ] },
      "data": { "brightness_pct": $4, $3 } },
    { "delay": { "milliseconds": 600 } },
    { "action": "light.turn_on",
      "target": { "entity_id": [ $2 ] },
      "data": { "brightness_pct": $5 } }
JSON
}

off_actions() { # lamps
  cat <<JSON
    { "action": "light.turn_off", "target": { "entity_id": [ $1 ] } }
JSON
}

# --------------------------------------------------------------------- put
#
# Matching happens in the TRIGGER via value_template + payload, deliberately.
# The first attempt matched in a condition by pulling the digit out of the
# action with a template, and it silently never fired: Home Assistant parses
# template results into native types, so '1' came back as the integer 1 and
# `1 == '1'` is false. Exact string matching at the trigger has no such trap.

put() { # id alias topic button actions_json
  printf '  %-22s %-28s ' "$1" "$2"
  local code
  code=$(curl -sS -o /tmp/bind-remote.out -w '%{http_code}' \
    -X POST "${HA}/api/config/automation/config/$1" \
    -H "Authorization: Bearer ${HA_TOKEN}" \
    -H "Content-Type: application/json" \
    --data @- <<JSON
{
  "id": "$1",
  "alias": "$2",
  "description": "Zemismart 4-button remote on $3. Action $4_single. Drives ONE ROOM: the entity ids are this room's, mirroring ASSIGNMENTS in web/src/lib/rooms.ts. The brightness-only follow-up is not redundant — the Tuya strip drops brightness when brightness and colour arrive in one command.",
  "triggers": [
    { "trigger": "mqtt",
      "topic": "$3",
      "value_template": "{{ value_json.action }}",
      "payload": "$4_single" }
  ],
  "conditions": [],
  "actions": [
$5
  ],
  "mode": "queued",
  "max": 10,
  "initial_state": true
}
JSON
  )
  if [ "$code" = "200" ]; then echo "ok"; else
    echo "FAILED (${code})"; cat /tmp/bind-remote.out; echo; return 1
  fi
}

bind_room() { # id_prefix label topic lamps strips
  put "${1}1" "$2 remote 1 — Warm 20%"   "$3" 1 "$(look_actions "$4" "$5" '"color_temp_kelvin": 2000' 20 100)"
  put "${1}2" "$2 remote 2 — Orange 70%" "$3" 2 "$(look_actions "$4" "$5" '"hs_color": [29, 100]'     70 100)"
  put "${1}3" "$2 remote 3 — Bright"     "$3" 3 "$(look_actions "$4" "$5" '"color_temp_kelvin": 4000' 60  60)"
  put "${1}4" "$2 remote 4 — All off"    "$3" 4 "$(off_actions "$4")"
}

echo "Binding the living-room remote on ${HA}:"
bind_room "vue_remote_"     "Living" "$LIVING_TOPIC" "$LIVING_LAMPS" "$LIVING_STRIPS"

echo "Binding the bedroom remote:"
bind_room "vue_remote_bed_" "Bedroom" "$BED_TOPIC"  "$BED_LAMPS"    "$BED_STRIPS"

cat <<'NOTE'

Done. Press each button once on each remote to confirm.

Button 4 is now per-room: neither remote turns off the whole house any more.

If a button does nothing, read what it actually emitted rather than guessing —
temporarily add an automation triggered on the topic with no payload filter,
whose action is logbook.log of `{{ trigger.payload }}`, then read it back from
/api/logbook. Persistent notifications are NOT usable for this: they stopped
being entities and cannot be read over REST.

The remotes are battery powered, so the first press after a long idle can be
swallowed while the radio wakes. Press twice before concluding it is broken.
NOTE
