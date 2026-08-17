#!/usr/bin/env bash
#
# Bind the Zemismart 4-button remote to the three scenes, plus all-off.
#
# Run this from anything that can reach the Pi — the Pi itself, or a machine on
# the tailnet. It cannot run from a machine that is off the tailnet, which is
# the whole reason this is a script you run rather than something the app does.
#
#   HA_TOKEN=xxx ./homeassistant/bin/bind-remote.sh
#
# Idempotent: the automation ids are fixed, so re-running UPDATES the four
# automations in place rather than stacking duplicates. Safe to run after
# changing which scene a button points at.
#
# WHY NOT THE APP: /api/automations deliberately speaks clock times and sun
# offsets only. A device trigger is a different shape entirely, and widening
# that endpoint to accept arbitrary triggers would make it a general automation
# writer — which is exactly what invariant 8 says nothing gets.

set -euo pipefail

HA="${HA_BASE_URL:-http://vue-pi:8123}"
: "${HA_TOKEN:?Set HA_TOKEN — Home Assistant → your profile → Long-lived access tokens}"

# From Home Assistant's device registry (list_zigbee_devices). This is HA's own
# device id, not the IEEE address.
DEVICE_ID="864e487ec5cd7cfd448d8b1c51dcfcdf"
TOPIC="zigbee2mqtt/0x6ce4a4fffe99d9c7"

# Button → what it does. Top to bottom, as the remote sits on the wall.
#
# Zigbee2MQTT names these actions per converter and the naming is NOT stable
# across models: 1_single, button_1_single and 1_click all exist in the wild.
# Matching a list rather than one string is the difference between a button that
# works and one that fails silently — an automation whose trigger never matches
# raises no error, the light simply never comes on.
bind() {
  local n="$1" name="$2" action_json="$3"

  local payload
  payload=$(cat <<JSON
{
  "id": "vue_remote_${n}",
  "alias": "Remote button ${n} — ${name}",
  "description": "Zemismart 4-button remote. Written by homeassistant/bin/bind-remote.sh",
  "triggers": [
    { "trigger": "mqtt", "topic": "${TOPIC}" }
  ],
  "conditions": [
    {
      "condition": "template",
      "value_template": "{{ trigger.payload_json.action in ['${n}_single', 'button_${n}_single', '${n}_click', '${n}_press'] }}"
    }
  ],
  "actions": [ ${action_json} ],
  "mode": "single",
  "initial_state": true
}
JSON
  )

  printf '  button %s → %-12s ' "$n" "$name"
  local code
  code=$(curl -sS -o /tmp/bind-remote-$n.out -w '%{http_code}' \
    -X POST "${HA}/api/config/automation/config/vue_remote_${n}" \
    -H "Authorization: Bearer ${HA_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "${payload}")

  if [ "$code" = "200" ]; then echo "ok"; else
    echo "FAILED (${code})"; cat /tmp/bind-remote-$n.out; echo; return 1
  fi
}

echo "Binding the remote on ${HA}:"

bind 1 "Warm 20%"   '{ "action": "scene.turn_on", "target": { "entity_id": "scene.warm_20" } }'
bind 2 "Orange 70%" '{ "action": "scene.turn_on", "target": { "entity_id": "scene.orange_70" } }'
bind 3 "Bright"     '{ "action": "scene.turn_on", "target": { "entity_id": "scene.bright" } }'
bind 4 "All off"    '{ "action": "light.turn_off", "target": { "entity_id": "all" } }'

cat <<'NOTE'

Done. Now press each button once and watch the lights.

If a button does nothing, its action name is one this script does not match.
Find the real one: Developer Tools → Events → listen to `mqtt_message` (or read
the Zigbee2MQTT log), press the button, and read `action` out of the payload.
Add that string to the list in the value_template above and re-run.

The remote is battery powered, so the first press after a long idle can be
swallowed while the radio wakes up. Press twice before concluding it is broken.
NOTE
