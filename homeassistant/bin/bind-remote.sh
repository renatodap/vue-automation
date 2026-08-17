#!/usr/bin/env bash
#
# Bind the Zemismart 4-button remote to the three scenes, plus all-off.
#
# These four automations already exist on the Pi — this is how they were made
# and how to rebuild them. Run from anything that can reach Home Assistant:
#
#   HA_TOKEN=xxx HA_BASE_URL=http://100.85.128.101 ./homeassistant/bin/bind-remote.sh
#
# Idempotent: the automation ids are fixed, so re-running UPDATES them in place
# rather than stacking duplicates.
#
# WHY NOT THE APP: /api/automations deliberately speaks clock times and sun
# offsets only. Widening it to accept arbitrary triggers would make it a general
# automation writer, which is exactly what invariant 8 says nothing gets.

set -euo pipefail

HA="${HA_BASE_URL:?Set HA_BASE_URL, e.g. http://100.85.128.101}"
: "${HA_TOKEN:?Set HA_TOKEN — Home Assistant → your profile → Long-lived access tokens}"

TOPIC="zigbee2mqtt/0x6ce4a4fffe99d9c7"
STRIP="light.0xa4c138939b2d0b23"

# The action names are CONFIRMED, not guessed: the remote publishes
# {"action":"1_single","battery":100,...} on the topic above.
#
# Matching happens in the TRIGGER via value_template + payload, deliberately.
# The first attempt matched in a condition by pulling the digit out of the
# action with a template, and it silently never fired: Home Assistant parses
# template results into native types, so '1' came back as the integer 1 and
# `1 == '1'` is false. Exact string matching at the trigger has no such trap.
#
# Every scene step is followed by a brightness-only command for the strip. That
# is NOT redundant: the Tuya strip drops the brightness component when
# brightness and colour temperature arrive together, which is precisely how a
# scene applies. Send brightness alone and it obeys instantly.
bind() {
  local n="$1" name="$2" strip_pct="$3" action_json="$4"

  local follow_up=""
  if [ -n "$strip_pct" ]; then
    follow_up=$(cat <<JSON
    , { "delay": { "milliseconds": 600 } }
    , { "action": "light.turn_on",
        "target": { "entity_id": "${STRIP}" },
        "data": { "brightness_pct": ${strip_pct} } }
JSON
    )
  fi

  printf '  button %s → %-12s ' "$n" "$name"
  local code
  code=$(curl -sS -o /tmp/bind-remote.out -w '%{http_code}' \
    -X POST "${HA}/api/config/automation/config/vue_remote_${n}" \
    -H "Authorization: Bearer ${HA_TOKEN}" \
    -H "Content-Type: application/json" \
    --data @- <<JSON
{
  "id": "vue_remote_${n}",
  "alias": "Wall remote ${n} — ${name}",
  "description": "Zemismart 4-button remote. Action ${n}_single.",
  "triggers": [
    { "trigger": "mqtt",
      "topic": "${TOPIC}",
      "value_template": "{{ value_json.action }}",
      "payload": "${n}_single" }
  ],
  "conditions": [],
  "actions": [ ${action_json} ${follow_up} ],
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

echo "Binding the remote on ${HA}:"

bind 1 "Warm 20%"   100 '{ "action": "scene.turn_on", "target": { "entity_id": "scene.warm_20" } }'
bind 2 "Orange 70%" 100 '{ "action": "scene.turn_on", "target": { "entity_id": "scene.orange_70" } }'
bind 3 "Bright"      60 '{ "action": "scene.turn_on", "target": { "entity_id": "scene.bright" } }'
bind 4 "All off"     ""  '{ "action": "light.turn_off", "target": { "entity_id": "all" } }'

cat <<'NOTE'

Done. Press each button once to confirm.

If a button does nothing, read what it actually emitted rather than guessing —
temporarily add an automation triggered on the topic with no payload filter,
whose action is logbook.log of `{{ trigger.payload }}`, then read it back from
/api/logbook. Persistent notifications are NOT usable for this: they stopped
being entities and cannot be read over REST.

The remote is battery powered, so the first press after a long idle can be
swallowed while the radio wakes. Press twice before concluding it is broken.
NOTE
