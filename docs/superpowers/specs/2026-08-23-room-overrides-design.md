# Room overrides — letting the connector move a bulb between rooms

2026-08-23

## The problem

A tenth bulb joined the mesh (`light.0xb4e842918a2f0000`, "bedroom bedside
lamp"). Adding it to the bedroom is a one-line edit to `ASSIGNMENTS` in
`web/src/lib/rooms.ts` — which is exactly the trouble. Every future bulb, and
every bulb that moves rooms, needs a source edit, a build and a deploy. Asking
Claude to put the new lamp in the bedroom cannot work, because the map it would
have to change is a compiled-in constant.

Invariant 9 forbids the obvious fix in as many words: room assignment is a
static map, *not* Postgres, because "putting the grouping in Postgres would
collapse Home into one undifferentiated list every time the metadata database
blinked."

That reasoning is sound and this design keeps it. What it does not require is
that Postgres be uninvolved — only that a database outage never costs us the
grouping.

## The shape

Room assignment resolves in three steps, most specific first:

```
roomOf(entityId, overrides) =
  overrides[entityId]        // Postgres, may be absent or unreachable
    ?? ASSIGNMENTS[entityId] // the static map, compiled into the bundle
    ?? "unassigned"
```

The static map stays in source and stays authoritative for every bulb it lists.
The override table only ever *shadows* it. So:

- **Database up:** the connector can reassign a lamp and the change is live on
  the next state read, no deploy.
- **Database down:** `loadRoomOverrides()` returns `{}` — it swallows failures
  the way `loadSceneMeta` already does — and the grouping is byte-identical to
  today's. Invariant 9's guarantee holds; only its mechanism widens.
- **Neither knows the bulb:** "Unassigned", as before, so a lamp paired at 2am
  is still reachable.

### Where resolution happens

Server-side, in the two state routes, which attach a resolved `room` to each
lamp. The client groups on that field rather than calling `roomOf` itself.

This looks like it weakens invariant 9 — the room now arrives over the network —
but it does not, because **the lamps arrive over that same network call.** If
`/api/state` fails there are no lamps to group and the question is moot. The
outage invariant 9 actually guards against is *Postgres* down while *Home
Assistant* is up, and in that case the route still answers, with rooms resolved
from the static map.

`LampView.room` is nonetheless declared **optional**, and `groupByRoom` falls
back to `roomOf(entityId)` when it is missing. Any code path that builds a
LampView without going through a state route still groups correctly, and the
static map remains a genuine floor rather than a decorative one.

### Ownership

`lamp_room` belongs to the **web app**, beside `scene_meta` and `scene_alias` —
not to the connector. The connector writes it through a new
`/api/internal/lamp-room` route, preserving the rule stated in the connector
migration: "The connector touches no other table: every read and write about
the house goes through the app's `/api/internal` routes, so the entity
projections and the partial-application rule have exactly one implementation."

### Write policy

The **opposite** of `recordTap`'s. Tap history is telemetry nobody asked for, so
a failure there is swallowed. Moving a lamp to another room is something a
person asked for, so a failure must be reported — reusing
`MetaUnavailableError`. Telling someone the bedside lamp is in the bedroom when
the write never landed is a lie they discover later, by looking at the app.

## The tool

`set_lamp_room`, named and typed, per invariant 8. No generic table writer.

- `entity_id` — accepts an entity id or a name, resolved against a live Home
  Assistant read, so a lamp that does not exist is refused rather than written
  as an orphan row. Same discipline as `requireScene`.
- `room_id` — constrained to the known `RoomId` union, or `null` to clear the
  override and fall back to the static map. A free-text room would let a model
  invent "livingroom" and quietly create a room nothing renders.
- `readOnlyHint: false`, `idempotentHint: true`. Not destructive: it is
  reversible by definition, and the static map underneath is untouched.

Rooms themselves stay a closed set in source. Creating a *room* is a design
decision about how Home is laid out; assigning a bulb to an existing one is
bookkeeping. Only the second is delegated.

## What is not being built

- **No room creation tool.** See above. `ROOMS` stays in source.
- **No HA area sync.** Home Assistant's area registry is reachable over the
  WebSocket API the connector already uses for `name_device`, and owning rooms
  there would be cleaner in principle. It is rejected here because the web app
  would need either a WebSocket dependency it deliberately avoids or a cached
  projection, and a failed read collapses Home into one list — precisely the
  failure invariant 9 exists to prevent. Worth revisiting only if HA gains a
  REST area surface.
- **No UI for reassignment.** The PWA renders rooms; it does not edit them. The
  connector is the only writer today.

## Invariant 9, amended

The current text forbids Postgres outright. It becomes a statement of the
layering and of the guarantee, so the guarantee survives and the mechanism is
described accurately. The static map remains the thing to edit for a permanent
assignment; the override table is for changes made without a deploy.
