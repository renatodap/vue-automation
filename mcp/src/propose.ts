/**
 * Propose → commit, for the changes that cannot be taken back.
 *
 * A `propose_*` tool describes what WOULD happen in plain English and hands
 * back an opaque token; `commit_change(token)` is what actually does it. The
 * user reads the diff between the two calls, which is the only reliable moment
 * to say no.
 *
 * Deliberately NOT built on MCP elicitation. Elicitation is optional for
 * clients, so a client that does not implement it silently skips the question
 * and the destructive call goes straight through — the confirmation would be
 * present in the protocol and absent in practice. Two tool calls with a token
 * in between cannot be skipped by anybody: without a commit there is no delete.
 *
 * The token is opaque and random, and only its SHA-256 is stored. That makes
 * "a token this server did not issue" structurally unusable rather than a
 * check somebody has to remember to write, and it means a leaked audit row
 * cannot be replayed as a commit.
 *
 * Storage is Postgres FIRST, memory always. Postgres so a proposal survives the
 * redeploy that happens between reading a diff and approving it; memory so the
 * flow still works during a database outage, when the lights must keep working
 * (invariant #2).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db.js";

/** Long enough to read a diff and answer, short enough that a stale approval
 *  can't be replayed into a house that has since changed. */
const TTL_MS = 10 * 60 * 1000;

export type Proposal = {
  tool: string;
  args: Record<string, unknown>;
  diff: string;
  expiresAt: number;
};

const memory = new Map<string, Proposal>();

const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

function sweep(): void {
  const now = Date.now();
  for (const [hash, p] of memory) if (p.expiresAt <= now) memory.delete(hash);
}

/** Mint a proposal. Returns the token to hand back to the model. */
export async function createProposal(
  tool: string,
  args: Record<string, unknown>,
  diff: string,
): Promise<{ token: string; expiresAt: number }> {
  sweep();
  const token = `chg_${randomBytes(24).toString("base64url")}`;
  const hash = sha256(token);
  const expiresAt = Date.now() + TTL_MS;
  memory.set(hash, { tool, args, diff, expiresAt });

  const sql = db();
  if (sql) {
    try {
      await sql`
        INSERT INTO mcp_change_proposal (token_hash, tool, arguments, diff, expires_at)
        VALUES (${hash}, ${tool}, ${JSON.stringify(args)}::text::jsonb, ${diff},
                to_timestamp(${expiresAt / 1000}))`;
    } catch (e) {
      // Best effort. The proposal still exists in memory, which is enough for
      // the common case of approving within the same conversation.
      console.error("[vue-mcp] could not persist proposal:", e);
    }
  }
  return { token, expiresAt };
}

export class ProposalError extends Error {}

/**
 * Redeem a proposal, EXACTLY once.
 *
 * The single-use check is the whole safety property, so it is done by an
 * atomic conditional UPDATE in Postgres — check-then-write would let two
 * concurrent commits both through, and "delete the scene" applied twice is not
 * the same as applied once when the second one hits whatever now holds that id.
 * The memory path deletes before returning, which is atomic on a single thread.
 */
export async function consumeProposal(token: string): Promise<Proposal> {
  sweep();
  if (typeof token !== "string" || !token.startsWith("chg_")) {
    throw new ProposalError(
      "That is not a change token. Call the matching propose_* tool first, show the user " +
        "the diff it returns, and pass ITS token here once they approve.",
    );
  }
  const hash = sha256(token);

  const sql = db();
  if (sql) {
    try {
      const rows = await sql<{ tool: string; arguments: Record<string, unknown>; diff: string }[]>`
        UPDATE mcp_change_proposal SET committed_at = now()
         WHERE token_hash = ${hash} AND committed_at IS NULL AND expires_at > now()
        RETURNING tool, arguments, diff`;
      if (rows[0]) {
        memory.delete(hash);
        return { tool: rows[0].tool, args: rows[0].arguments, diff: rows[0].diff, expiresAt: 0 };
      }
      // No row won the update. Distinguish "already used or expired" from
      // "never existed here" before falling back, so a genuine replay is not
      // quietly re-served out of memory.
      const known = await sql<{ committed_at: Date | null; expired: boolean }[]>`
        SELECT committed_at, expires_at <= now() AS expired
          FROM mcp_change_proposal WHERE token_hash = ${hash}`;
      if (known[0]) {
        memory.delete(hash);
        throw new ProposalError(
          known[0].committed_at
            ? "That change was already applied. Do not apply it again — re-read the current " +
              "state and tell the user what it looks like now."
            : "That proposal has expired. Propose the change again so the user sees a diff " +
              "against what is true NOW, then commit the new token.",
        );
      }
    } catch (e) {
      if (e instanceof ProposalError) throw e;
      console.error("[vue-mcp] proposal lookup failed, falling back to memory:", e);
    }
  }

  const found = memory.get(hash);
  if (!found) {
    throw new ProposalError(
      "That change token is unknown or has expired. Propose the change again so the user " +
        "sees a fresh diff, then commit the new token.",
    );
  }
  // Single-use: gone before it is returned.
  memory.delete(hash);
  if (found.expiresAt <= Date.now()) {
    throw new ProposalError("That proposal has expired. Propose the change again.");
  }
  return found;
}

/** What is waiting for approval right now — the memory view, which is the only
 *  one guaranteed to exist. */
export function pendingProposals(): Array<{ tool: string; diff: string; expires_in_seconds: number }> {
  sweep();
  return [...memory.values()].map((p) => ({
    tool: p.tool,
    diff: p.diff,
    expires_in_seconds: Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000)),
  }));
}

/** Exported for the tests: proves two distinct tokens never collide and that
 *  comparison is not accidentally by prefix. */
export function tokensMatch(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a), "hex");
  const y = Buffer.from(sha256(b), "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}
