-- Tables for the MCP connector (`mcp/`), plus the scene aliases it needs.
--
-- Two owners share this database and the split matters:
--
--   * `scene_alias` belongs to the WEB APP, beside `scene_meta` and
--     `scene_tap`. It decorates the scene list the same way they do — the
--     alternative names a scene answers to when someone says "movie mode"
--     rather than "Cozy Cinema". Home Assistant still owns which scenes exist.
--
--   * `mcp_oauth_*`, `mcp_audit` and `mcp_change_proposal` belong to the
--     CONNECTOR and nothing else reads them. The connector touches no other
--     table: every read and write about the house goes through the app's
--     `/api/internal` routes, so the entity projections and the
--     partial-application rule have exactly one implementation.
--     `registry.json` deliberately records no database for the connector, so
--     `infra db *` must never target it — apply this file against the
--     vue-automation database.
--
-- Nothing re-applies migrations on boot, so this is written to be safe to run
-- twice. The connector also creates its own tables at startup (see
-- `mcp/src/db.ts` → `ensureTables`), which makes a fresh deploy work before
-- anyone remembers to run this by hand; the two must stay in agreement.
--
-- Apply with:
--   /Users/renatodaprado/dev/Persimmon/infra/bin/infra db exec vue-automation -- \
--     bash -c 'psql "${DATABASE_URL%%\?*}" -f -' < migrations/2026-08-14_mcp-connector.sql

-- ---------------------------------------------------------------- app tables

-- The spoken names for a scene. Lowercased and de-duplicated by the writer, so
-- a lookup is a plain equality match rather than a scan with a function on it.
CREATE TABLE IF NOT EXISTS scene_alias (
  entity_id  text NOT NULL REFERENCES scene_meta(entity_id) ON DELETE CASCADE,
  alias      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, alias)
);

-- ---------------------------------------------------------- connector tables

-- OAuth 2.1 authorization-server state. Opaque tokens, SHA-256 at rest: a token
-- issued by any other server has no row here, so "never accept a token that
-- wasn't issued for you" is structural rather than a check somebody has to
-- remember to write. In Postgres rather than memory so a redeploy doesn't
-- silently disconnect the connector.

CREATE TABLE IF NOT EXISTS mcp_oauth_client (
  client_id     text PRIMARY KEY,
  client_name   text,
  redirect_uris text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_oauth_grant (
  id             bigserial PRIMARY KEY,
  client_id      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Set when a refresh token is REPLAYED, when an authorization code is
  -- replayed, or on explicit revocation. Replay is treated as a breach and
  -- kills the whole grant, not just the offending request.
  revoked_at     timestamptz,
  revoked_reason text
);

CREATE TABLE IF NOT EXISTS mcp_oauth_code (
  code_hash      text PRIMARY KEY,
  client_id      text,
  redirect_uri   text,
  code_challenge text,
  resource       text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Consumed by a conditional UPDATE, so two concurrent exchanges race in the
  -- database and exactly one wins. Check-then-update would let both through.
  consumed_at    timestamptz
);

CREATE TABLE IF NOT EXISTS mcp_oauth_token (
  token_hash text PRIMARY KEY,
  grant_id   bigint REFERENCES mcp_oauth_grant(id) ON DELETE CASCADE,
  -- Stamped even though there is only one resource today, so the day a second
  -- one appears a cross-audience token fails loudly instead of working.
  audience   text,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_oauth_refresh (
  id          bigserial PRIMARY KEY,
  grant_id    bigint REFERENCES mcp_oauth_grant(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz,
  used_at     timestamptz,
  replaced_by bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Every tool call, reads included. MCP traffic is a person having a
-- conversation, so the volume is low and the reads are the part that explains
-- WHY a write happened: "it applied Cozy Cinema" is far less useful than "it
-- read the room, found two lamps dark, then applied Cozy Cinema".
--
-- `arguments` is stored verbatim. That is the point of the table — an assistant
-- acting on someone's home has to leave behind exactly what it was asked to do,
-- not a summary of it.
CREATE TABLE IF NOT EXISTS mcp_audit (
  id           bigserial PRIMARY KEY,
  tool         text NOT NULL,
  read_only    boolean,
  arguments    jsonb,
  before_state jsonb,
  after_state  jsonb,
  status_code  integer,
  duration_ms  integer,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_audit_created_idx ON mcp_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS mcp_audit_tool_idx    ON mcp_audit (tool, created_at DESC);

-- Propose → commit, for the changes that cannot be taken back (deleting a
-- scene or a schedule, overwriting a scene's stored definition). The propose_*
-- tool writes a row and returns an opaque token; commit_change redeems it with
-- a conditional UPDATE, which is what makes single-use hold under concurrency.
-- Only the token's SHA-256 is stored, so a leaked audit row cannot be replayed
-- as a commit.
CREATE TABLE IF NOT EXISTS mcp_change_proposal (
  token_hash   text PRIMARY KEY,
  tool         text NOT NULL,
  arguments    jsonb NOT NULL,
  diff         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  committed_at timestamptz
);

CREATE INDEX IF NOT EXISTS mcp_change_proposal_expiry_idx ON mcp_change_proposal (expires_at);
