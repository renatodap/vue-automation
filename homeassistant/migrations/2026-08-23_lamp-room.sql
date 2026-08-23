-- Room overrides — the rows that let a bulb be reassigned without a deploy.
--
-- This table belongs to the WEB APP, beside `scene_meta` and `scene_alias`. The
-- connector never touches it directly: it writes through
-- `/api/internal/lamp-room`, so the validation and the resolution order have
-- exactly one implementation.
--
-- It OVERRIDES the static map in `web/src/lib/rooms.ts`, it does not replace
-- it. Resolution is:
--
--     lamp_room.room_id  ??  ASSIGNMENTS[entity_id]  ??  "unassigned"
--
-- which is why invariant 9 survives a database outage intact: an unreachable
-- Postgres yields no override rows, resolution falls through to the compiled-in
-- map, and Home groups exactly as it does today. Nothing here is authoritative
-- about the house — Home Assistant still owns the lamps, and a bulb listed in
-- neither place lands in "Unassigned" rather than vanishing.
--
-- `room_id` is deliberately unconstrained at the database level. The known
-- rooms are a closed set in TypeScript (`RoomId`) and the write route rejects
-- anything outside it; a CHECK constraint here would mean a migration every
-- time a room is added, to enforce a rule that is already enforced where the
-- rooms are actually defined. A stale value cannot render a phantom room —
-- `groupByRoom` only walks `ROOMS`.
--
-- Nothing re-applies migrations on boot, so this is safe to run twice.
--
-- Apply with:
--   /Users/renatodaprado/dev/Persimmon/infra/bin/infra db exec vue-automation -- \
--     bash -c 'psql "${DATABASE_URL%%\?*}" -f -' < migrations/2026-08-23_lamp-room.sql

CREATE TABLE IF NOT EXISTS lamp_room (
  entity_id  text PRIMARY KEY,
  room_id    text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
