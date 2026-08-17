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

## The wall remote, and two bugs it exposed

The remote is bound and working: buttons 1–4 are Warm 20%, Orange 70%, Bright,
all off — the physical order originally asked for. The automations live in Home
Assistant; `homeassistant/bin/bind-remote.sh` rebuilds them.

Binding had to happen from the Persimmon server, not from a laptop. The app
container already holds `HA_TOKEN` and sits on the tailnet, which is the only
route to the Pi that exists outside the flat. Widening `/api/automations` to
accept a device trigger was considered and rejected — that endpoint is
deliberately two shapes wide, and taking arbitrary triggers would make it a
general automation writer, which invariant 8 refuses.

**Bug 1: a template comparison that could never be true.** The first automation
extracted the button digit from the action string and compared it to `'1'`. It
triggered on all six test presses and did nothing, silently. Home Assistant
parses template results into native types, so the extracted `'1'` was the
integer `1`, and `1 == '1'` is false in Python. The lesson generalises: match
the payload in the TRIGGER with an exact string, and keep templates out of the
matching path entirely. The remote's real action names — `1_single` … `4_single`
— were never in doubt once read; they were recovered by logging
`{{ trigger.payload }}` to the logbook, because persistent notifications stopped
being entities and cannot be read over REST.

**Bug 2: the strip throws brightness away.** The Tuya strip drops the brightness
component when brightness and colour temperature arrive in one command — which
is how a scene applies. Sent alone, it dims instantly. Every scene was therefore
leaving it at whatever brightness it happened to be on, and it took an
end-to-end test of the real automation to see it: eight lamps landed correctly
and the ninth kept its old level while reporting the new colour.

Corrected in all three paths that drive lamps: `applyLightPatches` splits those
entities into a colour round and a brightness round, `/api/scene` re-reads the
scene's stored definition and re-sends brightness afterwards, and each remote
automation follows its scene with a brightness-only command. `SPLIT_BRIGHTNESS`
in `web/src/lib/ha.ts` is the one list; anything new that drives lamps has to
respect it.
