-- Spotlight: the handful of scenes that also appear at the top of Home.
--
-- Presentation metadata like label and accent, and it lives here for the same
-- reason they do: Home Assistant owns which scenes exist, this database only
-- decorates them. If Postgres is down the spotlight row is simply empty and
-- every scene is still one tap away on the Scenes tab.
--
-- Idempotent by construction: nothing re-applies migrations on boot, so every
-- one must be safe to run twice.

ALTER TABLE scene_meta
  ADD COLUMN IF NOT EXISTS spotlight boolean NOT NULL DEFAULT false;

-- Home reads "the spotlighted scenes, in display order" on every load, and the
-- answer is four rows out of a table of ten. Partial, because the false rows
-- are the ones we never ask for.
CREATE INDEX IF NOT EXISTS scene_meta_spotlight_idx
  ON scene_meta (sort_order) WHERE spotlight;
