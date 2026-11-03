-- Permanent observations, never a source of current lamp state. No TTL, no
-- cascading entity/scene deletion. Safe to apply twice with ON_ERROR_STOP=1.
BEGIN;
CREATE TABLE IF NOT EXISTS history_entity (
  entity_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('light','temperature','humidity','climate','scene')),
  name text NOT NULL,
  room_id text CHECK (room_id IN ('living','bedroom','unassigned')),
  unit text,
  attributes jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lamp_state_history (
  entity_id text NOT NULL,
  at timestamptz NOT NULL,
  state text NOT NULL,
  brightness numeric,
  color_temp_kelvin numeric,
  hs_color jsonb,
  xy_color jsonb,
  source text NOT NULL DEFAULT 'unknown' CHECK (source IN ('user','automation','scene','unknown')),
  context_id text, context_parent_id text, context_user_id text,
  scene_id text,
  attributes jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (entity_id, at)
);
CREATE INDEX IF NOT EXISTS lamp_state_history_at_idx ON lamp_state_history(at,entity_id);
CREATE INDEX IF NOT EXISTS lamp_state_history_context_idx ON lamp_state_history(context_id) WHERE context_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS climate_history (
  entity_id text NOT NULL,
  at timestamptz NOT NULL,
  state text NOT NULL,
  temperature_c numeric, humidity numeric,
  target_temperature_c numeric, target_temperature_low_c numeric, target_temperature_high_c numeric,
  source text NOT NULL DEFAULT 'unknown' CHECK (source IN ('user','automation','scene','unknown')),
  context_id text, context_parent_id text, context_user_id text,
  attributes jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (entity_id, at)
);
CREATE INDEX IF NOT EXISTS climate_history_at_idx ON climate_history(at,entity_id);
CREATE TABLE IF NOT EXISTS scene_application (
  entity_id text NOT NULL,
  at timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'unknown' CHECK (source IN ('user','automation','scene','unknown')),
  context_id text, context_parent_id text, context_user_id text,
  origin text NOT NULL CHECK (origin IN ('recorder','app','legacy_tap')),
  room_ids text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (entity_id, at)
);
CREATE INDEX IF NOT EXISTS scene_application_at_idx ON scene_application(at,entity_id);
CREATE TABLE IF NOT EXISTS history_sync (
  id text PRIMARY KEY,
  cursor_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  started_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS history_settings (
  id text PRIMARY KEY,
  time_zone text NOT NULL,
  temperature_unit text NOT NULL,
  recorder_start_at timestamptz,
  retention_days integer,
  discovered_at timestamptz NOT NULL DEFAULT now()
);
-- Distinguish an observable ingestion gap from proof of continuous coverage.
CREATE TABLE IF NOT EXISTS history_gap (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  reason text NOT NULL
);
CREATE TABLE IF NOT EXISTS history_context (
  context_id text PRIMARY KEY,
  entity_id text NOT NULL,
  at timestamptz NOT NULL,
  source text NOT NULL CHECK (source='automation')
);
COMMIT;
