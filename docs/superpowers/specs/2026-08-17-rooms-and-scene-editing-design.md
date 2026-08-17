# Rooms, a smaller scene set, and editing a scene — 2026-08-17

The house went from four bulbs in one room to nine across two. That broke three
things at once: the scenes only ever touched the original four, the front door
of the app was a photograph of a room that no longer contained most of the
lights, and there was no way to change what a scene did short of rebuilding the
room by hand and re-saving it.

## What changed in the house

Ten scenes became three, each covering all nine bulbs.

| Scene | Every lamp | Keyboard strip |
|---|---|---|
| Orange 70% | hue 28.94, saturation 100, 70% | same orange at 100% |
| Warm 20% | 2202K at 20% | 2000K at 100% |
| Bright | 4000K at 60% | 4000K at 60% |

Eight scenes were deleted (Evening, Focus, Guitar, Host, Late, Morning, Movie,
Teal and orange) plus three that were created mid-session by hand (Orange, Warm
Dim, Bright White). No schedule referenced any of them — there are no schedules
— and every one had been tapped zero times.

The orange is not a fresh choice. It is the hue the previous Orange 70% already
stored, recovered by applying the scene and reading the lamps back, so the room
looks the way it already did.

### Two bulb facts this uncovered

**The ZL1s advertise a 2000K floor they cannot reach.** Asked for 2000K they
settle at 2202K and report that back. Warm 20% therefore stores 2202K for eight
lamps and 2000K for the one bulb that genuinely reaches it. This is not a
rounding artefact to be fixed later; it is the bulb's real limit.

**They report state late.** A read taken about a second after a write echoes the
old value. The connector's `set_lamp` re-reads on that timescale, so it reported
`fully_applied: true` alongside values proving nothing had moved — and the
commands had in fact all landed. Any verification has to be a fresh read a few
seconds later, never the response to the write.

Both are recorded as invariant 10 in `CLAUDE.md`, because the failure mode is
believing a change failed and doing it again.

## Rooms live in code

`web/src/lib/rooms.ts` maps entity id to room. Living gets seven bulbs
(including both kitchen pendants and the LED strip), Bedroom gets two.

Considered and rejected: Home Assistant's area registry, which is the
conceptually right owner but is not exposed over the REST API the app speaks;
and a Postgres table, which would mean the grouping collapses whenever the
metadata database is unavailable. Invariant 2 promises the database can be down
without taking the lights with it, and a Home screen that degrades into one
undifferentiated list of nine bulbs breaks that promise in spirit.

The cost is honest: moving a bulb between rooms is a code edit and a deploy.
For nine bulbs in two rooms that is the right trade. Anything unlisted falls
into "Unassigned" rather than disappearing.

## One definition of Orange, White and Warm

The same three looks drive the room buttons, the per-lamp buttons and the three
scenes. `lookPatch()` is the single source, including the LED strip's exception
(full brightness in the two dim looks, because it sits behind a desk where 20%
reads as off). Without this the buttons and the scenes drift apart and tapping
Orange on a room lands somewhere the Orange scene would not have.

## Home is a list

The room map — an 896×1200 photographic plate with draggable markers, a scrub
gesture and an eyedropper, about 900 lines — is deleted. It was the fastest way
to reach a lamp you could see and had nowhere to put a second room. A list
scales; a photograph taken from one doorway does not.

Home is now: up to four spotlit scenes as small buttons, then per room a card
with `On/Off · Orange · White · Warm`, then a row per bulb with a switch and the
same three looks. Room-level actions arm undo first, and skip unreachable lamps
rather than reporting a success that never happened.

## Editing a scene

`GET /api/scene-config?id=` reads a scene's **stored definition**; the editor
renders that, not the live room. This is the whole point: editing by snapshot
can only ever change a scene to what is already happening, which makes "turn
this scene's strip up" require first turning the strip up.

Saving is read-modify-write, so entities the editor does not render — a switch,
a media player — survive a save instead of being silently dropped. Renaming goes
through the same path and therefore renames in Home Assistant, so HomeKit, Siri
and the connector all follow.

The editor renders in place of the scene grid rather than as an overlay. A
fixed-position sheet would be a second scrolling element detached from the
layout viewport, which is the thing iOS then moves on its own.

Spotlight is a new `scene_meta.spotlight` column
(`homeassistant/migrations/2026-08-17_scene-spotlight.sql`). `loadSceneMeta()`
falls back to the pre-migration query shape if the column is missing, so
deploying ahead of the migration costs the spotlight row rather than every label
and accent in the app.

## The wall remote is scripted, not wired

The Zemismart remote is paired but its four buttons are not bound yet, and this
session could not bind them: the Pi is reachable only over the tailnet, and the
connector's schedule tool accepts clock and sun triggers by design.

Widening `/api/automations` to accept a device trigger was considered and
rejected. That endpoint is deliberately two shapes wide; taking arbitrary
triggers would make it a general automation writer, which is precisely what
invariant 8 refuses to hand a model.

So the binding is `homeassistant/bin/bind-remote.sh` — one idempotent command,
run from anything on the tailnet. Buttons top to bottom are Warm 20%, Orange
70%, Bright, all off, which is the physical order originally asked for.

It matches four spellings of each action name rather than one. Zigbee2MQTT's
naming varies by converter, and this failure is silent: an automation whose
trigger never matches raises nothing, the light simply never comes on. The
alternative — HA's own device-trigger wizard — cannot guess wrong because it
lists the real names, and costs four trips through a UI instead of one command.
