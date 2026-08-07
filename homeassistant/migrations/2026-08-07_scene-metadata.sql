-- Scene presentation metadata and tap history.
--
-- Nothing here is authoritative about the house. Home Assistant owns what the
-- lamps are doing and which scenes exist; this database only decorates that
-- list (label, accent, order) and remembers what gets used, so the picker can
-- float frequent scenes to the top.
--
-- Idempotent by construction: nothing re-applies migrations on boot, so every
-- one must be safe to run twice.

CREATE TABLE IF NOT EXISTS scene_meta (
  entity_id   text PRIMARY KEY,
  -- NULL means "use the friendly_name Home Assistant already reports". Only
  -- set this to override HA, so renaming a scene there doesn't get silently
  -- shadowed by a stale copy here.
  label       text,
  -- Hex, e.g. '#e8a54d'. NULL falls back to the app's accent token.
  accent      text,
  -- Explicit ordering wins over frecency when set. NULL = let usage decide.
  sort_order  integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scene_tap (
  id         bigserial PRIMARY KEY,
  entity_id  text NOT NULL REFERENCES scene_meta(entity_id) ON DELETE CASCADE,
  tapped_at  timestamptz NOT NULL DEFAULT now()
);

-- The aggregate in loadSceneMeta() groups by entity_id and takes MAX(tapped_at).
CREATE INDEX IF NOT EXISTS scene_tap_entity_time_idx
  ON scene_tap (entity_id, tapped_at DESC);
