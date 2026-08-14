/**
 * HTTP entrypoint — stateless Streamable HTTP, JSON only.
 *
 * Routes: OAuth discovery + register/authorize/token/revoke, and `POST /mcp`
 * behind a bearer gate. Behind Coolify's Traefik (TLS terminated upstream), so
 * `X-Forwarded-*` is trusted for building the issuer.
 *
 * Nothing is ever stored between requests. No `Mcp-Session-Id` is minted — as
 * of the 2026-07-28 revision protocol-level sessions no longer exist at all,
 * and even for the older revisions there is nothing here to keep. Which also
 * means "initialize must come first" is NOT enforced: every POST is answered on
 * its own merits.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { checkEnvelope, handleRpc, type Envelope } from "./rpc.js";
import { ensureTables } from "./db.js";
import {
  asMetadata, authorizePage, authorizeSubmit, registerClient, resourceMetadata,
  revokeToken, tokenExchange, verifyToken,
} from "./oauth.js";
import { ensureConnected, mqttConfigured } from "./mqtt.js";

const PORT = Number(process.env.PORT || 3000);

/**
 * The base URL this request arrived on, which is also the OAuth issuer.
 *
 * It has to be byte-identical to the URL the discovery documents are served
 * from (RFC 8414 §3.3) or a conformant client rejects the entire document, so
 * it is derived from the request rather than configured.
 *
 * The scheme defaults to https because in production this always sits behind
 * Traefik, which terminates TLS and sets `X-Forwarded-Proto`; defaulting to
 * http would mint an http issuer the one time that header went missing and
 * break the whole flow. The loopback exception exists because a request that
 * arrives on 127.0.0.1 with no forwarding header is genuinely plain HTTP —
 * local development and the tests — and claiming https there produces an
 * issuer nothing can fetch.
 */
function issuerOf(req: IncomingMessage): string {
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "localhost";
  const forwarded = req.headers["x-forwarded-proto"] as string | undefined;
  const isLoopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
  const proto = forwarded || (isLoopback ? "http" : "https");
  return `${proto}://${host}`;
}

function cors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Mcp-Protocol-Version, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id",
  );
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
}

function json(res: ServerResponse, status: number, body: unknown) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string) {
  cors(res);
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => {
      d += c;
      if (d.length > 4 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
}

/**
 * Reject an unrecognised Origin; ALLOW an absent one.
 *
 * Claude's connector calls server-to-server from Anthropic's backend and sends
 * no Origin at all, so rejecting absent rejects every real client. An Origin
 * that IS present and is not this server is a browser being driven from
 * somewhere else, and that is the DNS-rebinding case the check exists for.
 */
function originOk(req: IncomingMessage, issuer: string): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === "null") return false;
  try {
    return new URL(origin).origin === new URL(issuer).origin;
  } catch {
    return false;
  }
}

function envelopeOf(req: IncomingMessage): Envelope {
  const h = (k: string) => {
    const v = req.headers[k];
    return typeof v === "string" && v.length ? v : null;
  };
  return {
    method: h("mcp-method"),
    name: h("mcp-name"),
    // The header is spelled MCP-Protocol-Version in the 2026-07-28 revision and
    // Mcp-Protocol-Version in 2025-06-18. Node lowercases every header name, so
    // both land in the same slot and neither spelling is special-cased.
    protocolVersion: h("mcp-protocol-version"),
  };
}

export const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  try {
    const method = req.method || "GET";
    const issuer = issuerOf(req);
    const url = new URL(req.url || "/", issuer);
    const path = url.pathname;

    if (method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // ---- Discovery ----
    // The chain is: 401 + resource_metadata → oauth-protected-resource →
    // oauth-authorization-server → register → authorize → token. Every link or
    // the dance simply stops, silently, with nothing in any log.
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
      return json(res, 200, asMetadata(issuer));
    }
    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
      return json(res, 200, resourceMetadata(issuer));
    }

    // ---- OAuth ----
    if (path === "/oauth/register" && method === "POST") {
      const body = await readBody(req);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        /* tolerate a malformed body — the useful field is redirect_uris */
      }
      try {
        return json(res, 201, await registerClient(parsed));
      } catch {
        return json(res, 503, { error: "temporarily_unavailable" });
      }
    }
    if (path === "/oauth/authorize" && method === "GET") {
      return html(res, 200, authorizePage(url.searchParams));
    }
    if (path === "/oauth/authorize" && method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const outcome = await authorizeSubmit(form, issuer);
      // A failed consent renders the page AGAIN. It must never redirect the
      // error: redirecting to a URI that did not validate is the vulnerability.
      if (!outcome.ok) return html(res, 401, authorizePage(form, outcome.error));
      cors(res);
      res.writeHead(302, { Location: outcome.redirect });
      res.end();
      return;
    }
    if (path === "/oauth/token" && method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const r = await tokenExchange(form, issuer);
      return r.ok ? json(res, 200, r.body) : json(res, 400, { error: r.error });
    }
    if (path === "/oauth/revoke" && method === "POST") {
      await revokeToken(new URLSearchParams(await readBody(req)));
      // RFC 7009: a revocation always answers 200, whether or not the token
      // existed. Saying "no such token" is a lookup oracle.
      return json(res, 200, {});
    }

    // ---- MCP ----
    // A POST to the bare origin is treated as a POST to /mcp. Pasting the root
    // URL into a connector dialog is the obvious mistake — and the failure it
    // produced was actively misleading: the root served HTML with a 200, so the
    // client reported "not a valid MCP server" for a server that was healthy and
    // correctly configured one path along. GET / still renders the landing page.
    if (path === "/mcp" || (path === "/" && method === "POST")) {
      // No SSE stream is offered, so don't pretend one exists.
      if (method !== "POST") {
        cors(res);
        res.setHeader("Allow", "POST");
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed", detail: "This endpoint accepts POST only." }));
        return;
      }

      if (!originOk(req, issuer)) {
        return json(res, 403, { error: "forbidden_origin" });
      }

      // THE MOST IMPORTANT LINES IN THIS FILE.
      //
      // A real HTTP 401 carrying WWW-Authenticate with resource_metadata, run
      // at the HTTP layer BEFORE the JSON-RPC dispatcher. Claude does not
      // honour WWW-Authenticate on a 200 — answer an unauthenticated call with
      // a friendly `{isError: true, "please sign in"}` and that text is handed
      // to the model as a tool result: the user sees Claude say "you need to
      // sign in", with no Connect button and no way to proceed. And it has to
      // be here, because once a tool handler returns, the response is already
      // committed to being a 200.
      //
      // Bearer token or nothing — a browser cookie can never authorize this.
      if (!(await verifyToken(req.headers.authorization ?? null))) {
        cors(res);
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
        );
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }

      const raw = await readBody(req);
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }

      const env = envelopeOf(req);

      // Tolerate a top-level array (2025-03-26 batching). A few lines, and a
      // stray old client otherwise gets a flat parse error.
      if (Array.isArray(msg)) {
        const out = (
          await Promise.all(msg.map((m) => handleRpc(m as Record<string, unknown>, env)))
        ).filter(Boolean);
        if (out.length === 0) {
          cors(res);
          res.writeHead(202).end();
          return;
        }
        return json(res, 200, out);
      }

      const out = await handleRpc(msg as Record<string, unknown>, env);
      if (out === null) {
        // Notification: 202 with an EMPTY body.
        cors(res);
        res.writeHead(202).end();
        return;
      }
      return json(res, 200, out);
    }

    if (path === "/healthz") return json(res, 200, { ok: true });
    if (path === "/") {
      return html(
        res,
        200,
        "<h1>Living-room lights — MCP</h1>" +
          "<p>Add this as a custom connector in Claude, then authorize with the passphrase:</p>" +
          `<p><code>${issuer}/mcp</code></p>` +
          "<p>The bare origin also works — a POST here is handled as a POST to " +
          "<code>/mcp</code> — but the path is the address to prefer.</p>",
      );
    }
    return json(res, 404, { error: "not_found" });
  } catch (e) {
    console.error("[vue-mcp] unhandled:", e);
    json(res, 500, { error: "server_error" });
  }
};

/** Exported so the tests can drive the same handler on an ephemeral port. */
export function createApp() {
  return createServer(handler);
}

/** Exported for `checkEnvelope`'s test, which asserts the header contract
 *  without standing up a socket. */
export { checkEnvelope };

const isEntrypoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  ensureTables()
    .then(() => {
      // Start the Zigbee2MQTT subscription eagerly when it is configured: the
      // bridge event buffer only holds what arrived while connected, and a
      // pairing event that lands before the first poll would otherwise be lost.
      if (mqttConfigured()) {
        ensureConnected().catch((e) =>
          console.warn("[vue-mcp] MQTT not reachable at boot (pairing tools will retry):", e.message));
      }
      createApp().listen(PORT, () => console.log(`[vue-mcp] listening on :${PORT}`));
    })
    .catch((e) => {
      console.error("[vue-mcp] startup failed:", e);
      process.exit(1);
    });
}
