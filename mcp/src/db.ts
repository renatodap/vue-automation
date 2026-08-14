/**
 * Postgres access for the connector — its OWN tables and nothing else.
 *
 * Deliberately narrow, mirroring `dap-finance-mcp`: this service owns
 * `mcp_oauth_*`, `mcp_audit` and `mcp_change_proposal`. Everything about scenes,
 * lamps, schedules and tap history goes through the app's `/api/internal`
 * routes (see api.ts), so the projections and the partial-application rule have
 * exactly one implementation. `registry.json` records no database for this
 * service — `infra db *` must never target it.
 *
 * Tokens live here rather than in memory so a redeploy doesn't silently
 * disconnect the connector.
 *
 * The pool is OPTIONAL, and that is not laziness. Invariant #2 says the lights
 * must work when the database does not. A connection that cannot be made must
 * therefore degrade rather than crash: the tools keep working (they talk to the
 * app, which talks to Home Assistant), the audit trail goes quiet, proposals
 * fall back to memory, and only NEW authorizations are refused.
 */
import postgres, { type Sql } from "postgres";
import { databaseUrl } from "./env.js";

type Client = Sql<Record<string, never>>;

/**
 * TLS only for real public hosts.
 *
 * Coolify's internal Postgres is a dot-less Docker container name speaking
 * PLAINTEXT; forcing `ssl: require` there fails the handshake with ECONNRESET,
 * which looks exactly like "the database is down" and wastes an afternoon.
 */
function sslFor(url: string): "require" | false {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host.includes(".") && host !== "localhost" ? "require" : false;
}

function makePool(url: string, max: number): Client {
  return postgres(url, {
    ssl: sslFor(url),
    max,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
  }) as Client;
}

let main: Client | null = null;
let audit: Client | null = null;

/** The shared pool, or null when no DATABASE_URL is configured. */
export function db(): Client | null {
  const url = databaseUrl();
  if (!url) return null;
  if (!main) main = makePool(url, 5);
  return main;
}

/**
 * A pool of its OWN for the audit trail.
 *
 * The audit write happens while a tool call is still in flight, so borrowing a
 * second slot out of the main pool is a deadlock waiting for concurrency to
 * find it. Two connections, never shared.
 */
export function auditDb(): Client | null {
  const url = databaseUrl();
  if (!url) return null;
  if (!audit) audit = makePool(url, 2);
  return audit;
}

export async function closePools(): Promise<void> {
  await Promise.all([main, audit].map((p) => (p ? p.end({ timeout: 5 }) : Promise.resolve())));
  main = audit = null;
}

// -------------------------------------------------------------------- schema

/**
 * Create everything this service needs, idempotently.
 *
 * A mirror of `homeassistant/migrations/2026-08-14_mcp-connector.sql`, run at
 * boot so a fresh deploy works before anyone remembers to apply the migration
 * by hand. Never throws: a database unreachable at boot must not stop the
 * connector from turning on the lights.
 */
export async function ensureTables(): Promise<void> {
  const sql = db();
  if (!sql) {
    console.warn(
      "[vue-mcp] DATABASE_URL is not set. The connector will serve tools, but nobody can " +
        "AUTHORIZE — OAuth state has nowhere to live. Set it before adding the connector in Claude.",
    );
    return;
  }
  try {
    await ensureOAuthTables();
    await ensureAuditTable();
    await ensureProposalTable();
  } catch (e) {
    console.error("[vue-mcp] ensureTables failed (continuing without the database):", e);
  }
}

export async function ensureOAuthTables(): Promise<void> {
  const sql = db();
  if (!sql) return;
  await sql`CREATE TABLE IF NOT EXISTS mcp_oauth_client (
    client_id text PRIMARY KEY,
    client_name text,
    redirect_uris text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS mcp_oauth_grant (
    id bigserial PRIMARY KEY,
    client_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    revoked_reason text)`;
  await sql`CREATE TABLE IF NOT EXISTS mcp_oauth_code (
    code_hash text PRIMARY KEY,
    client_id text,
    redirect_uri text,
    code_challenge text,
    resource text,
    created_at timestamptz NOT NULL DEFAULT now(),
    consumed_at timestamptz)`;
  await sql`CREATE TABLE IF NOT EXISTS mcp_oauth_token (
    token_hash text PRIMARY KEY,
    grant_id bigint REFERENCES mcp_oauth_grant(id) ON DELETE CASCADE,
    audience text,
    expires_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS mcp_oauth_refresh (
    id bigserial PRIMARY KEY,
    grant_id bigint REFERENCES mcp_oauth_grant(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz,
    used_at timestamptz,
    replaced_by bigint,
    created_at timestamptz NOT NULL DEFAULT now())`;
}

/**
 * The audit table.
 *
 * Every call, with what was asked, what the house looked like before, and what
 * it looked like after. Reads as well as writes: MCP traffic is a person having
 * a conversation, so the volume is low and the reads are the part that explains
 * WHY a write happened. "It applied Cozy Cinema" is far less useful than "it
 * read the room, found two lamps dark, then applied Cozy Cinema".
 *
 * The arguments are stored verbatim. That is the point of the table: an
 * assistant acting on someone's home has to leave behind exactly what it was
 * asked to do, not a summary of it.
 */
export async function ensureAuditTable(): Promise<void> {
  const sql = db();
  if (!sql) return;
  await sql`CREATE TABLE IF NOT EXISTS mcp_audit (
    id bigserial PRIMARY KEY,
    tool text NOT NULL,
    read_only boolean,
    arguments jsonb,
    before_state jsonb,
    after_state jsonb,
    status_code integer,
    duration_ms integer,
    error text,
    created_at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE INDEX IF NOT EXISTS mcp_audit_created_idx ON mcp_audit (created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS mcp_audit_tool_idx ON mcp_audit (tool, created_at DESC)`;
}

export async function ensureProposalTable(): Promise<void> {
  const sql = db();
  if (!sql) return;
  await sql`CREATE TABLE IF NOT EXISTS mcp_change_proposal (
    token_hash text PRIMARY KEY,
    tool text NOT NULL,
    arguments jsonb NOT NULL,
    diff text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    committed_at timestamptz)`;
  await sql`CREATE INDEX IF NOT EXISTS mcp_change_proposal_expiry_idx
    ON mcp_change_proposal (expires_at)`;
}

/**
 * Record a tool call. Runs on its own pool and NEVER throws — a failed audit
 * write must not turn a working tool into a broken one.
 *
 * `::text::jsonb`, and the inner cast is not redundant. A bare `::jsonb` makes
 * Postgres infer a jsonb parameter, so postgres.js serialises the already-
 * stringified value a SECOND time and the column ends up holding a jsonb
 * *string*: `arguments->>'entity_id'` then reads back NULL and nothing in the
 * trail is queryable by what it recorded.
 */
export async function writeAudit(entry: {
  tool: string;
  readOnly: boolean | null;
  args: unknown;
  before?: unknown;
  after?: unknown;
  durationMs: number;
  error: string | null;
}): Promise<void> {
  const sql = auditDb();
  if (!sql) return;
  try {
    await sql`
      INSERT INTO mcp_audit (tool, read_only, arguments, before_state, after_state,
                             status_code, duration_ms, error)
      VALUES (${entry.tool}, ${entry.readOnly},
              ${JSON.stringify(entry.args ?? null)}::text::jsonb,
              ${JSON.stringify(entry.before ?? null)}::text::jsonb,
              ${JSON.stringify(entry.after ?? null)}::text::jsonb,
              ${entry.error ? 500 : 200}, ${entry.durationMs}, ${entry.error})`;
  } catch (e) {
    console.error("[vue-mcp] audit write failed for", entry.tool, e);
  }
}
