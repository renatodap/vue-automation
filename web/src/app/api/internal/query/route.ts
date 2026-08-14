import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { internalSecretOk, unauthorized, badRequest } from "../_lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only SQL over the scene-metadata tables, and nothing else.
 *
 * This exists for the genuinely novel question no named route covers — "which
 * scene do I use most between 6 and 9pm" — and it is the LAST resort, never a
 * substitute for a named read. A generic query tool is the easiest thing to
 * build and the worst thing to ship: the model invents a join, confidently
 * reports a wrong number, and nobody catches it. So it is fenced in four
 * independent ways, and a write is structurally impossible rather than merely
 * checked for:
 *
 *   1. One statement, which must start with SELECT / WITH / TABLE.
 *   2. A write or DDL keyword anywhere in the text is a refusal.
 *   3. `EXPLAIN (FORMAT JSON)` runs FIRST and the plan is walked for the
 *      relations the statement will actually touch. This is the only check
 *      that survives an alias, a CTE or a view, and the only one that reliably
 *      keeps the connector's own OAuth tables out of reach. EXPLAIN without
 *      ANALYZE plans without executing.
 *   4. The statement runs inside a `READ ONLY` transaction with a statement
 *      timeout, and the transaction's read-only flag is verified rather than
 *      trusted — a silently read-write transaction is indistinguishable from a
 *      safe one right up until something writes.
 *
 * Nothing here can reach the lamps in any case: Home Assistant owns those and
 * it is a different system on a different machine.
 */

const ALLOWED_TABLES = ["scene_meta", "scene_tap", "scene_alias"] as const;

const WRITE_RE =
  /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|vacuum|reindex|refresh|call|do|set|reset|lock|listen|notify|prepare|deallocate|begin|commit|rollback|savepoint|import|merge|pg_read_file|pg_ls_dir|lo_import|lo_export|dblink)\b/i;

export async function POST(req: Request): Promise<Response> {
  if (!internalSecretOk(req)) return unauthorized();

  let body: { query?: string; max_rows?: number };
  try {
    body = (await req.json()) as { query?: string; max_rows?: number };
  } catch {
    return badRequest("Expected a JSON body.");
  }

  const sql = db();
  if (!sql) {
    return NextResponse.json(
      { error: "No metadata database is configured, so there is nothing to query." },
      { status: 409 },
    );
  }

  const q = (body.query ?? "").trim().replace(/;\s*$/, "");
  if (!q) return badRequest("query is empty.");
  if (/;/.test(q)) {
    return badRequest("Only a single statement is allowed — remove the ';' and send one SELECT.");
  }
  if (!/^(select|with|table)\b/i.test(q)) {
    return badRequest("Only read queries are allowed — the statement must start with SELECT, WITH or TABLE.");
  }
  if (WRITE_RE.test(q)) {
    return badRequest(
      "That statement contains a write or DDL keyword and this surface is read-only. " +
        "Use the named mutation routes to change anything.",
    );
  }

  const limit = Math.max(1, Math.min(Math.round(Number(body.max_rows) || 200), 1000));

  try {
    const out = await sql.begin(async (tx) => {
      // Access mode FIRST: Postgres refuses to change it once the transaction
      // has executed a statement, and the EXPLAIN below is a statement.
      await tx.unsafe("SET TRANSACTION READ ONLY");
      await tx.unsafe("SET LOCAL statement_timeout = '10s'");

      const [mode] = (await tx`SELECT current_setting('transaction_read_only') AS ro`) as unknown as {
        ro: string;
      }[];
      if (mode?.ro !== "on") {
        throw new Error(
          "Refusing to run: the READ ONLY transaction did not take effect on this connection.",
        );
      }

      const plan = (await tx.unsafe(`EXPLAIN (FORMAT JSON) ${q}`)) as unknown as unknown[];
      const touched = relationsInPlan(plan);
      const forbidden = touched.filter((t) => !(ALLOWED_TABLES as readonly string[]).includes(t));
      if (forbidden.length) {
        throw new Error(
          `This query reads ${forbidden.join(", ")}, which is out of scope. ` +
            `Only these tables are queryable: ${ALLOWED_TABLES.join(", ")}. ` +
            `Everything about the lamps themselves lives in Home Assistant, not here.`,
        );
      }

      const rows = (await tx.unsafe(q)) as unknown as Record<string, unknown>[];
      return { rows, touched };
    });

    const rows = out.rows.slice(0, limit);
    return NextResponse.json({
      ok: true,
      columns: rows.length ? Object.keys(rows[0]) : [],
      rows,
      row_count: rows.length,
      truncated: out.rows.length > limit,
      tables_read: out.touched,
      ...(out.rows.length > limit
        ? { note: `Truncated to ${limit} of ${out.rows.length} rows — add LIMIT or aggregate.` }
        : {}),
    });
  } catch (error) {
    // A rejected query is the model's input problem, not a server fault: 400 so
    // it rewrites the SQL rather than reporting an outage.
    const message = error instanceof Error ? error.message : "The query could not be run.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Every relation an EXPLAIN plan names, however deeply nested. */
function relationsInPlan(plan: unknown): string[] {
  const found = new Set<string>();
  (function walk(node: unknown): void {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const rel = obj["Relation Name"];
    if (typeof rel === "string") found.add(rel);
    for (const value of Object.values(obj)) walk(value);
  })(plan);
  return [...found].sort();
}
