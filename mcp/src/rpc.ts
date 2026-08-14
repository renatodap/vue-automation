/**
 * The MCP protocol engine — stateless Streamable HTTP, one POST in, one JSON
 * object out.
 *
 * ## Two generations, one dispatcher
 *
 * The handshake era (2024-11-05 … 2025-11-25) negotiates once via `initialize`
 * and then talks. The 2026-07-28 revision removed protocol-level sessions
 * (SEP-2567) and the handshake with them: every request stands alone, carries
 * its protocol version and client capabilities in a per-request `_meta`, and
 * `server/discover` replaces handshake-time capability exchange.
 *
 * Both are served here. `initialize` is not deprecated in this codebase because
 * it is what Claude's connector actually speaks in production today, and a
 * connector that only implements the newest revision is a connector that does
 * not connect. `server/discover` is implemented because a 2026-07-28 server is
 * required to answer it.
 *
 * The transport never needed changing: stateless JSON with no SSE and no
 * session id started here as a shared-hosting constraint and is now simply the
 * specified shape.
 */
import { TOOL_DEFS, TOOLS, callTool, hasTool, isReadOnly, ToolError } from "./tools.js";
import { writeAudit } from "./db.js";

/**
 * What to answer a handshake client that asks for something unrecognised.
 *
 * Deliberately NOT the newest revision. This is the version Claude's connector
 * negotiates today and the one with the most deployed clients; offering a
 * client something newer than it asked for is how a working connection becomes
 * a parse error.
 */
const PREFERRED_VERSION = "2025-06-18";

const SUPPORTED = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"];

/** Only the capabilities actually implemented. Advertising `resources` or
 *  `logging` obliges answering those methods, and `listChanged: true` promises
 *  pushes that cannot be sent without an open stream. */
const CAPABILITIES = { tools: { listChanged: false } };

const SERVER_INFO = {
  name: "vue-automation",
  title: "Living-room lights",
  version: "1.0.0",
};

const INSTRUCTIONS =
  "Control the living-room lighting: four Zigbee bulbs behind Home Assistant on a Raspberry Pi, " +
  "presented as scenes. Behave like someone standing in the room with a light switch, not like a " +
  "database client.\n\n" +

  "READ BEFORE YOU SPEAK. You have no memory of the room and no clock on it. Someone flips a wall " +
  "switch, a schedule fires, another phone taps a scene. Call get_room (or get_scenes / get_lamp) at " +
  "the START of any answer about the lights, and again after any change. NEVER repeat an earlier " +
  "reading as if it were current — a stale light state is worse than an error, because the user acts " +
  "on it and finds out you were wrong by looking at a dark room.\n\n" +

  "A SCENE CAN APPLY PARTIALLY, AND SILENCE READS AS SUCCESS. Home Assistant applies a scene to the " +
  "lamps it can reach and says nothing about the rest. apply_scene and set_lamp both return " +
  "`fully_applied`, `unreachable` and `did_not_match`. When `fully_applied` is false you must name the " +
  "lamps that did not follow. 'Cozy Cinema is on' while the floor lamp sits dark is the failure this " +
  "connector exists to prevent.\n\n" +

  "UNREACHABLE IS PHYSICAL. A smart bulb is only smart while it has power, so an unreachable lamp " +
  "almost always means someone switched it off at the lamp or the wall. Say that — it is a fix the " +
  "user can carry out in five seconds — rather than reporting a system error or retrying.\n\n" +

  "TOOL ROUTING:\n" +
  "  • 'what are the lights doing', 'is anything on' → get_room.\n" +
  "  • 'what scenes do I have', anything about labels, colours or order → get_scenes.\n" +
  "  • 'movie mode', 'cozy', any name → apply_scene. It resolves entity ids, labels, Home Assistant " +
  "names and saved aliases, so pass what the user said rather than guessing an entity id.\n" +
  "  • one lamp too bright, or a colour tweak → set_lamp. Colour temperature and hue are mutually " +
  "exclusive modes on these bulbs; send one. Kelvin outside the bulb's own reported range is rejected " +
  "SILENTLY and the lamp does not move, so read min/max from get_lamp first.\n" +
  "  • 'save this' → arrange the room first, confirm it looks right, then save_scene. It snapshots what " +
  "the lamps are ACTUALLY doing; unreachable lamps cannot be captured and are reported as skipped.\n" +
  "  • 'lights at sunset' → set_schedule. Prefer sunset/sunrise offsets over clock times: 6pm is pitch " +
  "dark in December and broad daylight in June, and Home Assistant already tracks the real sun.\n" +
  "  • 'stop that schedule' → set_schedule_enabled(false) first. Pausing is reversible; deleting is not, " +
  "and people usually mean pause.\n" +
  "  • 'which scenes do I actually use' → get_history. query_sql only for a genuinely novel question " +
  "about that history that no named tool answers.\n\n" +

  "DESTRUCTIVE CHANGES GO THROUGH A DIFF. Deleting a scene or a schedule, and overwriting a scene's " +
  "stored definition, are irreversible. Call the matching propose_* tool, SHOW THE USER THE DIFF IT " +
  "RETURNS, wait for an explicit yes, then commit_change with the token. Never commit a token the user " +
  "has not seen the diff for. The token is single-use and expires in ten minutes; if it lapses, propose " +
  "again so the diff is against what is true now.\n\n" +

  "ADDING A BULB is a three-step conversation, and the middle step is asynchronous. start_pairing opens " +
  "the mesh and returns IMMEDIATELY — nothing has joined yet. Tell the user to factory-reset the bulb, " +
  "then poll_pairing after ~20 seconds and again after that. A `device_joined` event is not a finished " +
  "pairing: wait for an interview to come back successful. Then name_device, which renames in BOTH " +
  "Zigbee2MQTT and Home Assistant — renaming in one alone leaves the two systems disagreeing, which is " +
  "why it is one tool. Name lamps by physical position ('shelf lamp', 'floor lamp'), never by number: " +
  "`light.lamp_3` is unreadable a month later and every scene references these names.\n\n" +

  "WHAT THIS CONNECTOR DOES NOT OWN. Home Assistant owns which scenes exist and what the lamps are " +
  "doing. The app's database only stores labels, accents, ordering, aliases and tap history. If that " +
  "database is unavailable the lights still work — say that plainly rather than reporting the house as " +
  "broken, and note that labels have fallen back to Home Assistant's own names.";

// ------------------------------------------------------------------ plumbing

function result(id: unknown, r: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result: r };
}
function error(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}
const isNotification = (m: Record<string, unknown>) => m && m.method != null && m.id === undefined;

/** The 2026-07-28 envelope headers, resolved once per HTTP request. */
export interface Envelope {
  method?: string | null;
  name?: string | null;
  protocolVersion?: string | null;
}

/** Mismatched routing headers. Its own code so a load balancer's rewrite is
 *  distinguishable from a malformed body. */
export const ERR_ENVELOPE_MISMATCH = -32020;

/**
 * Validate the 2026-07-28 routing headers against the body.
 *
 * `Mcp-Method` / `Mcp-Name` exist so a plain round-robin load balancer can
 * route without parsing JSON. That only holds if they are checked: a header
 * that disagrees with the body means the request was routed on a claim that
 * was not true, and answering it anyway would execute a different call than
 * the one the infrastructure believed it was forwarding.
 *
 * ABSENT headers are fine — handshake-era clients send none.
 */
export function checkEnvelope(
  env: Envelope,
  message: Record<string, unknown>,
): { code: number; message: string } | null {
  const method = typeof message.method === "string" ? message.method : "";

  if (env.method && method && env.method !== method) {
    return {
      code: ERR_ENVELOPE_MISMATCH,
      message: `Mcp-Method header says "${env.method}" but the body's method is "${method}".`,
    };
  }

  if (env.name) {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const bodyName = typeof params.name === "string" ? params.name : "";
    if (bodyName && env.name !== bodyName) {
      return {
        code: ERR_ENVELOPE_MISMATCH,
        message: `Mcp-Name header says "${env.name}" but the body names "${bodyName}".`,
      };
    }
  }

  if (env.protocolVersion && !SUPPORTED.includes(env.protocolVersion)) {
    return {
      code: ERR_ENVELOPE_MISMATCH,
      message:
        `MCP-Protocol-Version "${env.protocolVersion}" is not supported. ` +
        `This server speaks: ${SUPPORTED.join(", ")}.`,
    };
  }

  return null;
}

/** The discovery document, shared by `initialize` and `server/discover`. */
function discovery(negotiated: string) {
  return {
    protocolVersion: negotiated,
    protocolVersions: SUPPORTED,
    capabilities: CAPABILITIES,
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  };
}

export async function handleRpc(
  message: Record<string, unknown>,
  env: Envelope = {},
): Promise<Record<string, unknown> | null> {
  // A notification is acknowledged with 202 and an EMPTY body — serialising
  // anything at all, even `{}`, is a protocol violation some clients hang on.
  if (isNotification(message)) return null;

  const id = message.id ?? null;
  const method = typeof message.method === "string" ? message.method : "";
  if (!method) return error(id, -32600, "Missing method.");

  const mismatch = checkEnvelope(env, message);
  if (mismatch) return error(id, mismatch.code, mismatch.message);

  const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<
    string,
    unknown
  >;

  // Per-request `_meta` replaced the handshake's negotiated state in
  // 2026-07-28. Read it where present, fall back to the envelope header, and
  // fall back again to the preferred version — this is the only place the
  // protocol version comes from once `initialize` is gone.
  const meta = (params._meta && typeof params._meta === "object" ? params._meta : {}) as Record<string, unknown>;
  const metaVersion = typeof meta.protocolVersion === "string" ? meta.protocolVersion : null;
  const negotiated =
    (metaVersion && SUPPORTED.includes(metaVersion) && metaVersion) ||
    (env.protocolVersion && SUPPORTED.includes(env.protocolVersion) && env.protocolVersion) ||
    PREFERRED_VERSION;

  switch (method) {
    case "initialize": {
      // Echo the client's version when it is recognised, else offer the
      // preferred one. The tools wire format is identical across every
      // shipping revision, so this only affects the handshake itself.
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const version = SUPPORTED.includes(asked) ? asked : PREFERRED_VERSION;
      return result(id, {
        protocolVersion: version,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }

    // 2026-07-28: what `initialize` used to answer, on demand and without
    // establishing anything. Mandatory for a server of that revision, optional
    // for the client to call.
    case "server/discover":
      return result(id, { ...discovery(negotiated), tools: TOOL_DEFS });

    case "ping":
      return result(id, {});

    case "tools/list":
      return result(id, { tools: TOOL_DEFS });

    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments && typeof params.arguments === "object"
        ? params.arguments
        : {}) as Record<string, unknown>;
      if (!name) return error(id, -32602, "Missing tool name.");
      // An unknown tool NAME is the one genuine protocol error here. Everything
      // else — bad arguments, an unreachable lamp, a refused write — comes back
      // as a SUCCESSFUL result carrying isError, so the model reads it and
      // corrects itself instead of surfacing an opaque failure to the user.
      if (!hasTool(name)) {
        return error(id, -32602, `Unknown tool: ${name}. Available: ${TOOLS.map((t) => t.name).join(", ")}`);
      }

      const startedAt = Date.now();
      try {
        const { data, audit } = await callTool(name, args);
        void writeAudit({
          tool: name,
          readOnly: isReadOnly(name),
          args,
          before: audit?.before,
          after: audit?.after,
          durationMs: Date.now() - startedAt,
          error: null,
        });
        const text = JSON.stringify(data, null, 2);
        return result(id, {
          // structuredContent AND a mirrored text block: safe on every
          // revision, costs nothing, and older clients read only the text.
          content: [{ type: "text", text }],
          structuredContent: data as Record<string, unknown>,
          isError: false,
        });
      } catch (e) {
        const msg =
          e instanceof ToolError
            ? e.message
            : "The tool failed unexpectedly on the server. Nothing about the house is known to have changed.";
        if (!(e instanceof ToolError)) console.error(`[vue-mcp] tool ${name}:`, e);
        void writeAudit({
          tool: name,
          readOnly: isReadOnly(name),
          args,
          durationMs: Date.now() - startedAt,
          error: msg,
        });
        return result(id, { content: [{ type: "text", text: msg }], isError: true });
      }
    }

    default:
      return error(id, -32601, `Method not found: ${method}`);
  }
}

export { INSTRUCTIONS, SUPPORTED, PREFERRED_VERSION, SERVER_INFO };
