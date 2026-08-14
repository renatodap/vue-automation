/**
 * OAuth 2.1 authorization server for the Claude custom-connector flow.
 *
 * Public client + PKCE (S256), dynamic client registration, passphrase consent,
 * opaque bearer tokens with rotating refresh. State lives in Postgres so it
 * survives a redeploy — a connector that disconnects every time the app ships
 * is a connector nobody keeps.
 *
 * There is one household and one passphrase. Accounts, a users table and
 * password resets would all be machinery serving nobody; what this DOES have to
 * do is fail closed, because it is on the public internet and it turns on the
 * lights in someone's home.
 *
 * Tokens are 256-bit CSPRNG strings stored as SHA-256. Opaque, not JWT: a token
 * issued by any other server has no row in the table, so MCP's hardest
 * requirement — never accept a token that wasn't issued for you — is structural
 * rather than a check somebody has to remember. A fast hash is right for the
 * same reason it is right for sessions: there is no guessable input for a slow
 * hash to protect, and it would cost a derivation on every request.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db.js";
import { mcpPassphrase } from "./env.js";

const b64url = (b: Buffer) => b.toString("base64url");
const newSecret = () => b64url(randomBytes(32));
const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

/**
 * An access token lives an hour and a refresh token 60 days.
 *
 * Short access tokens are only reasonable BECAUSE refresh exists — otherwise
 * the connection would die hourly. The pair is what makes revocation
 * meaningful: killing a grant takes effect within the hour rather than in two
 * months.
 */
const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_DAYS = 60;

/** Authorization-server metadata (`/.well-known/oauth-authorization-server`). */
export function asMetadata(issuer: string) {
  return {
    // Byte-identical to the base URL this document is served from (RFC 8414
    // §3.3). A conformant client rejects the WHOLE document on a mismatch.
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // S256 only. Offering `plain` invites a downgrade.
    code_challenge_methods_supported: ["S256"],
    // Stated explicitly: RFC 8414 DEFAULTS this to client_secret_basic, and a
    // public client holding no secret would then attempt Basic auth against an
    // endpoint with no secret to check.
    token_endpoint_auth_methods_supported: ["none"],
    // `offline_access` belongs here and ONLY here — never in protected-resource
    // metadata or a challenge. A refresh token is a client convenience, not a
    // requirement of the resource, and advertising it there makes the consent
    // screen ask for more than the connector needs.
    scopes_supported: ["mcp", "offline_access"],
  };
}

/** Protected-resource metadata (`/.well-known/oauth-protected-resource`). */
export function resourceMetadata(issuer: string) {
  // Only the FIRST entry of authorization_servers is read by clients — one
  // issuer, no fallback.
  return { resource: `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: ["mcp"] };
}

/**
 * Dynamic client registration.
 *
 * Deprecated by the 2026-07-28 revision in favour of Client ID Metadata
 * Documents, and kept working anyway: Claude's connector flow still registers
 * this way, and deprecated is not removed. CIMD is deliberately NOT implemented
 * here — it would have this server fetch an arbitrary caller-supplied URL, and
 * this server sits on the tailnet with a route to the Pi. That is an SSRF
 * surface worth adding on purpose with an address allow-list, not casually.
 *
 * Open to the internet by design, which is exactly why consent below is a real
 * authentication rather than a rubber stamp.
 */
export async function registerClient(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sql = db();
  if (!sql) throw new Error("no_database");

  const clientId = `vue-${newSecret().slice(0, 24)}`;
  const uris = Array.isArray(body.redirect_uris)
    ? (body.redirect_uris as unknown[]).filter((u): u is string => typeof u === "string")
    : [];
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 200) : null;

  await sql`INSERT INTO mcp_oauth_client (client_id, client_name, redirect_uris)
            VALUES (${clientId}, ${name}, ${uris})`;
  return {
    client_id: clientId,
    client_name: name,
    redirect_uris: uris,
    token_endpoint_auth_method: "none",
    // Echo the grants actually supported, refresh INCLUDED — a client told only
    // "authorization_code" has no way to keep the connection alive and simply
    // dies when the access token expires.
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

/**
 * Is this redirect_uri one the client registered?
 *
 * Non-loopback matches by EXACT byte comparison — every relaxation (prefix,
 * wildcard, normalization) is a code-exfiltration bug. Loopback matches on
 * everything except the port, because Claude Code binds an ephemeral localhost
 * port per session (RFC 8252 §7.3), and `localhost` is listed beside the
 * numeric forms because clients use all three.
 */
export async function redirectUriAllowed(clientId: string, redirectUri: string): Promise<boolean> {
  const sql = db();
  if (!sql || !clientId || !redirectUri) return false;
  const rows = await sql<{ redirect_uris: string[] }[]>`
    SELECT redirect_uris FROM mcp_oauth_client WHERE client_id = ${clientId} LIMIT 1`;
  const registered = rows[0]?.redirect_uris ?? [];
  if (registered.length === 0) return false;

  let candidate: URL;
  try {
    candidate = new URL(redirectUri);
  } catch {
    return false;
  }
  const LOOPBACK = ["127.0.0.1", "[::1]", "::1", "localhost"];
  const isLoopback = LOOPBACK.includes(candidate.hostname);

  return registered.some((uri) => {
    if (uri === redirectUri) return true;
    if (!isLoopback) return false;
    try {
      const known = new URL(uri);
      return (
        LOOPBACK.includes(known.hostname) &&
        known.protocol === candidate.protocol &&
        known.pathname === candidate.pathname
      );
    } catch {
      return false;
    }
  });
}

/**
 * Is the requested `resource` one this server can mint a token for?
 *
 * An ABSENT resource is accepted — shipping Claude Code omits it. One that
 * names a DIFFERENT resource is refused: that request is asking this server to
 * issue a token for somebody else's.
 */
export function resourceAllowed(resource: string | null, issuer: string): boolean {
  if (!resource) return true;
  const want = `${issuer}/mcp`;
  return resource === want || resource === issuer || resource === `${issuer}/`;
}

/** The consent screen. Names the VERIFIED redirect host — not the client's own
 *  self-asserted name, which nothing checked — and says in plain English what
 *  is being granted. */
export function authorizePage(q: URLSearchParams, error?: string): string {
  const carry = [
    "client_id", "redirect_uri", "state", "code_challenge",
    "code_challenge_method", "scope", "response_type", "resource",
  ]
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(q.get(k) ?? "")}">`)
    .join("");

  let host = "an unknown app";
  try {
    host = new URL(q.get("redirect_uri") ?? "").host || host;
  } catch {
    /* keep the default */
  }

  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect the living-room lights</title><style>
body{font-family:system-ui;margin:0;background:#111013;color:#f2efe9;display:grid;place-items:center;min-height:100dvh}
form{background:#1b191e;padding:28px;border-radius:16px;width:min(380px,90vw);box-shadow:0 10px 40px rgba(0,0,0,.45)}
h1{font-size:18px;margin:0 0 6px} p{color:#a09a92;font-size:13px;margin:0 0 6px;line-height:1.5}
ul{color:#c7c0b6;font-size:13px;margin:6px 0 18px;padding-left:18px;line-height:1.6}
label{display:block;font-size:12px;color:#a09a92;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #35313a;background:#131218;color:#f2efe9;font-size:16px}
button{width:100%;margin-top:16px;padding:12px;border:0;border-radius:10px;background:#e8a54d;color:#221b10;font-size:16px;font-weight:650}
.host{color:#f2efe9;font-weight:650}
.err{color:#ff8d7a;font-size:13px;margin-top:10px}</style></head>
<body><form method="POST" action="/oauth/authorize">
<h1>Connect the living-room lights</h1>
<p><span class="host">${escapeHtml(host)}</span> is asking to connect. It will be able to:</p>
<ul>
  <li>See which lamps are on, how bright, and what colour</li>
  <li>Turn lamps on and off and apply scenes</li>
  <li>Create, rename and reorder scenes, and set schedules</li>
  <li>Put the Zigbee mesh into pairing mode and name new devices</li>
</ul>
<p>Enter the passphrase to approve.</p>
${carry}
<label for="passphrase">Passphrase</label>
<input id="passphrase" type="password" name="passphrase" autocomplete="current-password" required autofocus>
<button type="submit">Approve and connect</button>${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
</form></body></html>`;
}

/**
 * Check the passphrase, then mint a code bound to the client, the PKCE
 * challenge and the redirect_uri.
 *
 * The passphrase is required EVERY time. A live browser session would be
 * authentication, never authorization: registration is open to the internet, so
 * an attacker can register a client pointing at their own server and send a
 * signed-in person a crafted link.
 */
export async function authorizeSubmit(
  form: URLSearchParams,
  issuer: string,
): Promise<{ ok: true; redirect: string } | { ok: false; error: string }> {
  const sql = db();
  if (!sql) {
    return {
      ok: false,
      error: "The connector's database is unavailable, so a new connection can't be authorized right now.",
    };
  }

  const clientId = form.get("client_id") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";

  // Validate the redirect BEFORE anything else. An unvalidated URI must never
  // be redirected to, not even carrying an error — redirecting to it IS the
  // vulnerability, so a failure here renders a page instead.
  if (!(await redirectUriAllowed(clientId, redirectUri))) {
    return { ok: false, error: "That redirect address is not registered for this client." };
  }

  const resource = form.get("resource");
  if (!resourceAllowed(resource, issuer)) {
    return { ok: false, error: "That request asks for a token for a different server." };
  }

  const challenge = form.get("code_challenge") ?? "";
  const method = form.get("code_challenge_method") ?? "S256";
  if (challenge && method !== "S256") {
    return { ok: false, error: "Only the S256 PKCE method is accepted." };
  }

  const expected = mcpPassphrase();
  const supplied = form.get("passphrase") ?? "";
  if (!expected) {
    return { ok: false, error: "No passphrase is configured on the connector, so nothing can be approved." };
  }
  if (!constantTimeEqual(supplied, expected)) {
    return { ok: false, error: "That passphrase is not correct." };
  }

  const code = newSecret();
  await sql`
    INSERT INTO mcp_oauth_code (code_hash, client_id, redirect_uri, code_challenge, resource)
    VALUES (${sha256(code)}, ${clientId}, ${redirectUri}, ${challenge || null}, ${resource})`;

  const u = new URL(redirectUri);
  u.searchParams.set("code", code);
  const state = form.get("state");
  if (state) u.searchParams.set("state", state);
  return { ok: true, redirect: u.toString() };
}

export async function tokenExchange(
  form: URLSearchParams,
  issuer: string,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const sql = db();
  if (!sql) return { ok: false, error: "temporarily_unavailable" };

  const grantType = form.get("grant_type");
  if (grantType === "refresh_token") return refreshExchange(form);
  if (grantType !== "authorization_code") return { ok: false, error: "unsupported_grant_type" };

  if (!resourceAllowed(form.get("resource"), issuer)) return { ok: false, error: "invalid_target" };

  const code = form.get("code") || "";
  const verifier = form.get("code_verifier") || "";

  // Consume ATOMICALLY: two concurrent exchanges race in the database and
  // exactly one wins. Check-then-update would let both through.
  const rows = await sql<{ code_challenge: string | null; redirect_uri: string | null; client_id: string | null }[]>`
    UPDATE mcp_oauth_code SET consumed_at = now()
     WHERE code_hash = ${sha256(code)} AND consumed_at IS NULL
       AND created_at > now() - interval '10 minutes'
    RETURNING code_challenge, redirect_uri, client_id`;

  const row = rows[0];
  if (!row) {
    // Replay of an already-consumed code is a breach, not a retry: burn every
    // grant that code produced.
    await burnGrantsForCode(sha256(code));
    return { ok: false, error: "invalid_grant" };
  }

  const presentedRedirect = form.get("redirect_uri");
  if (presentedRedirect && row.redirect_uri && presentedRedirect !== row.redirect_uri) {
    return { ok: false, error: "invalid_grant" };
  }

  if (row.code_challenge) {
    const computed = b64url(createHash("sha256").update(verifier).digest());
    // Constant-time: a byte-wise early return leaks the challenge prefix.
    const a = Buffer.from(computed);
    const b = Buffer.from(row.code_challenge);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "invalid_grant" };
  }

  const grant = await sql<{ id: string }[]>`
    INSERT INTO mcp_oauth_grant (client_id) VALUES (${row.client_id ?? "unknown"})
    RETURNING id::text AS id`;

  return { ok: true, body: await issuePair(grant[0].id, `${issuer}/mcp`) };
}

/** The only place tokens are made. */
async function issuePair(grantId: string, audience: string): Promise<Record<string, unknown>> {
  const sql = db();
  if (!sql) throw new Error("no_database");
  const access = newSecret();
  const refresh = newSecret();

  await sql`
    INSERT INTO mcp_oauth_token (token_hash, grant_id, audience, expires_at)
    VALUES (${sha256(access)}, ${Number(grantId)}, ${audience},
            now() + ${`${ACCESS_TTL_SECONDS} seconds`}::interval)`;
  await sql`
    INSERT INTO mcp_oauth_refresh (grant_id, token_hash, expires_at)
    VALUES (${Number(grantId)}, ${sha256(refresh)}, now() + ${`${REFRESH_TTL_DAYS} days`}::interval)`;

  return {
    access_token: access,
    refresh_token: refresh,
    token_type: "Bearer",
    scope: "mcp",
    expires_in: ACCESS_TTL_SECONDS,
  };
}

/**
 * Rotate a refresh token.
 *
 * Presenting one that has ALREADY been used is treated as a breach, not a
 * retry: either it was stolen and the thief is racing the real client, or the
 * real client is replaying. Either way the honest response is to kill the whole
 * grant — every access and refresh token under it — and make the user
 * reconnect. Silently issuing a new pair lets a thief keep the connection alive
 * indefinitely.
 */
async function refreshExchange(
  form: URLSearchParams,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const sql = db();
  if (!sql) return { ok: false, error: "temporarily_unavailable" };

  const presented = form.get("refresh_token") || "";
  if (!presented) return { ok: false, error: "invalid_request" };

  const rows = await sql<{
    id: string; grant_id: string; used_at: Date | null; expired: boolean;
    revoked_at: Date | null; audience: string | null;
  }[]>`
    SELECT r.id::text, r.grant_id::text, r.used_at,
           r.expires_at <= now() AS expired,
           g.revoked_at,
           (SELECT t.audience FROM mcp_oauth_token t WHERE t.grant_id = g.id ORDER BY t.created_at DESC LIMIT 1) AS audience
      FROM mcp_oauth_refresh r
      JOIN mcp_oauth_grant g ON g.id = r.grant_id
     WHERE r.token_hash = ${sha256(presented)}
     LIMIT 1`;

  const row = rows[0];
  if (!row) return { ok: false, error: "invalid_grant" };

  if (row.used_at) {
    await sql`UPDATE mcp_oauth_grant SET revoked_at = now(), revoked_reason = 'refresh token replayed'
               WHERE id = ${Number(row.grant_id)} AND revoked_at IS NULL`;
    await sql`UPDATE mcp_oauth_token SET revoked_at = now()
               WHERE grant_id = ${Number(row.grant_id)} AND revoked_at IS NULL`;
    return { ok: false, error: "invalid_grant" };
  }
  if (row.revoked_at || row.expired) return { ok: false, error: "invalid_grant" };

  // Retire the grant's previous access tokens: a refresh means the client has
  // moved on, and leaving the old one live widens the window for nothing.
  await sql`UPDATE mcp_oauth_token SET revoked_at = now()
             WHERE grant_id = ${Number(row.grant_id)} AND revoked_at IS NULL`;

  const body = await issuePair(row.grant_id, row.audience ?? "");
  await sql`
    UPDATE mcp_oauth_refresh
       SET used_at = now(),
           replaced_by = (SELECT id FROM mcp_oauth_refresh
                           WHERE grant_id = ${Number(row.grant_id)} ORDER BY id DESC LIMIT 1)
     WHERE id = ${Number(row.id)}`;

  return { ok: true, body };
}

/** RFC 7009. Revoking a refresh token kills its whole grant. */
export async function revokeToken(form: URLSearchParams): Promise<void> {
  const sql = db();
  if (!sql) return;
  const presented = form.get("token") || "";
  if (!presented) return;
  const hash = sha256(presented);
  await sql`UPDATE mcp_oauth_token SET revoked_at = now() WHERE token_hash = ${hash} AND revoked_at IS NULL`;
  await sql`
    UPDATE mcp_oauth_grant SET revoked_at = now(), revoked_reason = 'revocation endpoint'
     WHERE id IN (SELECT grant_id FROM mcp_oauth_refresh WHERE token_hash = ${hash})
       AND revoked_at IS NULL`;
}

async function burnGrantsForCode(codeHash: string): Promise<void> {
  const sql = db();
  if (!sql) return;
  try {
    const rows = await sql<{ client_id: string | null }[]>`
      SELECT client_id FROM mcp_oauth_code WHERE code_hash = ${codeHash} LIMIT 1`;
    if (!rows[0]) return;
    await sql`
      UPDATE mcp_oauth_grant SET revoked_at = now(), revoked_reason = 'authorization code replayed'
       WHERE client_id = ${rows[0].client_id ?? "unknown"}
         AND created_at > now() - interval '10 minutes' AND revoked_at IS NULL`;
  } catch {
    /* the refusal above already stands */
  }
}

/**
 * A short failover cache for token verification.
 *
 * The NORMAL path always hits the database, so revoking a grant takes effect on
 * the very next call. This is consulted ONLY when the database throws — i.e.
 * during an outage — so that a live conversation can still turn the lights off
 * while Postgres is down. That is invariant #2 applied to auth: a metadata
 * outage must not become a lighting outage.
 */
const failover = new Map<string, number>();
const FAILOVER_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve a bearer.
 *
 * Every failure looks the same to the caller — missing, malformed, expired,
 * revoked, wrong audience. Distinguishing them tells an attacker which guess
 * was closer.
 */
export async function verifyToken(bearer: string | null): Promise<boolean> {
  if (!bearer) return false;
  const raw = bearer.replace(/^Bearer\s+/i, "").trim();
  if (!raw) return false;
  const hash = sha256(raw);

  const sql = db();
  if (!sql) return false;

  try {
    const rows = await sql<{ ok: boolean }[]>`
      SELECT true AS ok
        FROM mcp_oauth_token t
        LEFT JOIN mcp_oauth_grant g ON g.id = t.grant_id
       WHERE t.token_hash = ${hash}
         AND t.revoked_at IS NULL
         AND (g.id IS NULL OR g.revoked_at IS NULL)
         AND (t.expires_at IS NULL OR t.expires_at > now())
       LIMIT 1`;
    const ok = rows.length > 0;
    if (ok) failover.set(hash, Date.now() + FAILOVER_TTL_MS);
    else failover.delete(hash);
    return ok;
  } catch (e) {
    console.error("[vue-mcp] token check could not reach the database:", e);
    const until = failover.get(hash);
    if (until && until > Date.now()) return true;
    failover.delete(hash);
    return false;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
