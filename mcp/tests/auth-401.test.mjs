/**
 * The 401, the discovery chain, and the transport's hard edges.
 *
 * ## Why this file exists
 *
 * The single most consequential line in the connector is the HTTP 401 carrying
 * `WWW-Authenticate: Bearer …, resource_metadata="…"`, emitted at the HTTP
 * layer BEFORE the JSON-RPC dispatcher. Claude does not honour
 * `WWW-Authenticate` on a 200 — answer an unauthenticated call with a friendly
 * `{isError: true, "please sign in"}` and that text is handed to the model as a
 * tool result: the user sees Claude say "you need to sign in", with no Connect
 * button and no way to proceed. There is nothing in any log to explain it.
 *
 * The failure is silent, so it needs a test rather than a review.
 *
 * Runs against `dist/`, so it also proves the package builds. Needs no
 * database, no Home Assistant and no broker: with `DATABASE_URL` unset there
 * are no tokens to verify, which is exactly the state a 401 must come out of.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

delete process.env.DATABASE_URL;

const { createApp, checkEnvelope } = await import("../dist/server.js");
const { SUPPORTED, PREFERRED_VERSION } = await import("../dist/rpc.js");

let base;
let server;

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const rpc = (body, headers = {}) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("an unauthenticated /mcp call is a real 401, not a 200 carrying isError", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  assert.equal(
    res.status,
    401,
    "an unauthenticated call answered 200 — Claude then shows no Connect button and the " +
      "user has no way to authorize",
  );

  const challenge = res.headers.get("www-authenticate");
  assert.ok(challenge, "no WWW-Authenticate header: the discovery chain never starts");
  assert.match(challenge, /^Bearer\b/, "the challenge must name the Bearer scheme");
  assert.match(
    challenge,
    /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/,
    "the challenge must point at protected-resource metadata — that pointer is the first link " +
      "in the chain, and without it the client has nowhere to go",
  );

  // And the body must not look like a successful tool result.
  const body = await res.json();
  assert.equal(body.result, undefined, "a 401 must not carry a JSON-RPC result");
});

test("the 401 runs before the dispatcher, so an unknown method still 401s", async () => {
  // If the auth gate sat inside the dispatcher, this would come back as a
  // -32601 and reveal that the request was processed unauthenticated.
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "totally/unknown" });
  assert.equal(res.status, 401);
  assert.ok(res.headers.get("www-authenticate"));
});

test("a bearer this server never issued is refused, identically", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { Authorization: "Bearer not-a-real-token" });
  assert.equal(res.status, 401);
  const body = await res.json();
  // Every auth failure looks the same. Distinguishing missing from malformed
  // from expired tells an attacker which guess was closer.
  assert.deepEqual(body, { error: "invalid_token" });
});

test("GET and DELETE on /mcp are 405 with Allow: POST — no SSE is offered", async () => {
  for (const method of ["GET", "DELETE", "PUT"]) {
    const res = await fetch(`${base}/mcp`, { method });
    assert.equal(res.status, 405, `${method} /mcp should be 405`);
    assert.equal(res.headers.get("allow"), "POST", `${method} /mcp should advertise Allow: POST`);
  }
});

test("no Mcp-Session-Id is ever minted", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(
    res.headers.get("mcp-session-id"),
    null,
    "this server is stateless; sessions were removed from the protocol entirely in 2026-07-28",
  );
});

test("protected-resource metadata names exactly one authorization server", async () => {
  const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.ok(Array.isArray(doc.authorization_servers) && doc.authorization_servers.length === 1,
    "only the FIRST entry is read by clients — a second is dead weight that looks like a fallback");
  assert.match(doc.resource, /\/mcp$/);
  assert.equal(
    JSON.stringify(doc).includes("offline_access"),
    false,
    "offline_access belongs only in authorization-server metadata — advertising it here makes the " +
      "consent screen ask for more than the resource needs",
  );
});

test("the issuer is byte-identical to the URL the document is served from", async () => {
  const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
  const doc = await res.json();
  assert.equal(
    doc.issuer,
    base,
    "RFC 8414 §3.3 — a conformant client rejects the WHOLE document on a mismatch, and nothing " +
      "in any log says why",
  );
  for (const endpoint of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    assert.ok(doc[endpoint].startsWith(base), `${endpoint} must sit under the issuer`);
  }
});

test("behind Traefik the issuer follows X-Forwarded-*, not the local socket", async () => {
  // This is how the service actually runs: TLS is terminated upstream, so the
  // socket is plain HTTP on a container port while the issuer clients must see
  // is the public https URL. Getting this wrong makes every document fetchable
  // and every document rejected.
  const doc = await (
    await fetch(`${base}/.well-known/oauth-authorization-server`, {
      headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "lights-mcp.renatodap.me" },
    })
  ).json();
  assert.equal(doc.issuer, "https://lights-mcp.renatodap.me");
  assert.equal(doc.token_endpoint, "https://lights-mcp.renatodap.me/oauth/token");

  // And the challenge must point at the same place, or the chain breaks at the
  // very first hop.
  const res = await rpc(
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "lights-mcp.renatodap.me" },
  );
  assert.equal(
    res.headers.get("www-authenticate"),
    'Bearer resource_metadata="https://lights-mcp.renatodap.me/.well-known/oauth-protected-resource"',
  );
});

test("the authorization server advertises S256 only and no-secret clients explicitly", async () => {
  const doc = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(
    doc.code_challenge_methods_supported, ["S256"],
    "offering `plain` invites a PKCE downgrade",
  );
  assert.deepEqual(
    doc.token_endpoint_auth_methods_supported, ["none"],
    "RFC 8414 DEFAULTS this to client_secret_basic — a public client holding no secret would then " +
      "attempt Basic auth against an endpoint with no secret to check",
  );
  assert.ok(doc.grant_types_supported.includes("refresh_token"),
    "a client told only authorization_code has no way to survive the access token expiring");
});

test("dynamic client registration is still reachable, deprecation notwithstanding", async () => {
  // Deprecated by the 2026-07-28 revision in favour of Client ID Metadata
  // Documents, and still what Claude's connector actually uses. Without a
  // database it cannot complete — but it must not 404, because a 404 here is
  // indistinguishable from "this server does not support connecting".
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
  });
  assert.notEqual(res.status, 404, "the registration endpoint must exist");
  assert.notEqual(res.status, 405);
});

test("the consent screen names the verified redirect HOST, not the client's own name", async () => {
  const res = await fetch(
    `${base}/oauth/authorize?client_id=x&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}` +
      `&client_name=${encodeURIComponent("Totally Legit Bank")}&state=abc&code_challenge=y&code_challenge_method=S256`,
  );
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.ok(page.includes("claude.ai"), "the verified redirect host must be shown");
  assert.equal(
    page.includes("Totally Legit Bank"),
    false,
    "a client's self-asserted name is unverified and must never appear on the consent screen",
  );
  assert.ok(page.includes("state") && page.includes("abc"), "state must survive the POST round trip");
});

test("an absent Origin is allowed; a foreign one is refused", async () => {
  // Claude's connector calls server-to-server and sends NO Origin — rejecting
  // absent rejects every real client. A present, foreign Origin is a browser
  // being driven from somewhere else.
  const absent = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(absent.status, 401, "absent Origin must reach the auth gate, not be blocked before it");

  const foreign = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "https://evil.example" });
  assert.equal(foreign.status, 403, "a foreign Origin must be refused outright");
});

test("checkEnvelope: a header that disagrees with the body is -32020", () => {
  // Mcp-Method / Mcp-Name exist so a plain round-robin load balancer can route
  // without parsing JSON. That only holds if they are CHECKED — a mismatch
  // means the request was routed on a claim that was not true.
  const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_room" } };

  assert.equal(checkEnvelope({}, body), null, "absent headers are fine — handshake clients send none");
  assert.equal(
    checkEnvelope({ method: "tools/call", name: "get_room" }, body), null,
    "matching headers must pass",
  );

  const wrongMethod = checkEnvelope({ method: "tools/list" }, body);
  assert.equal(wrongMethod?.code, -32020);
  assert.match(wrongMethod.message, /tools\/list/);

  const wrongName = checkEnvelope({ name: "apply_scene" }, body);
  assert.equal(wrongName?.code, -32020, "a routing header naming a DIFFERENT tool must be refused");

  const badVersion = checkEnvelope({ protocolVersion: "1999-01-01" }, body);
  assert.equal(badVersion?.code, -32020);
  assert.match(badVersion.message, /2026-07-28/, "the refusal should list what IS supported");
});

test("both protocol generations are advertised, and the preferred one is the deployed one", () => {
  assert.ok(SUPPORTED.includes("2026-07-28"), "the sessionless revision must be supported");
  assert.ok(SUPPORTED.includes("2025-06-18"), "the handshake revision Claude speaks today must stay");
  assert.equal(
    PREFERRED_VERSION,
    "2025-06-18",
    "offering a client something NEWER than it asked for is how a working connection becomes a " +
      "parse error; the fallback must be the most widely deployed revision",
  );
});
