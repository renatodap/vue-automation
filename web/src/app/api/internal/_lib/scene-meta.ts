import "server-only";
import { db } from "@/lib/db";

/**
 * Metadata writes and history reads for the connector.
 *
 * `lib/db.ts` already owns the READ the picker renders from (`loadSceneMeta`)
 * and the tap write (`recordTap`). What it has never needed is the ability to
 * SET a label, an accent or an order — the PWA edits those through its own
 * pages — nor the aliases table, which only exists so a spoken name can find a
 * scene. Those live here.
 *
 * The write policy is deliberately the OPPOSITE of `recordTap`'s. Tap history
 * is telemetry nobody asked for, so a failure there is swallowed. A rename is
 * something a person asked for, so a failure has to be reported: "renamed"
 * over a write that never landed is a lie they only find out about later.
 */

export class MetaUnavailableError extends Error {
  constructor(what: string) {
    super(
      `The database is unavailable, so ${what} was NOT saved. The lamps themselves ` +
        `are unaffected — Home Assistant owns those.`,
    );
    this.name = "MetaUnavailableError";
  }
}

export type AliasRow = { entity_id: string; alias: string };

/** Aliases for every scene. Never throws — an outage must not hide the list. */
export async function loadAliases(): Promise<Map<string, string[]>> {
  const sql = db();
  if (!sql) return new Map();
  try {
    const rows = await sql<AliasRow[]>`
      SELECT entity_id, alias FROM scene_alias ORDER BY entity_id, alias`;
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const list = out.get(r.entity_id) ?? [];
      list.push(r.alias);
      out.set(r.entity_id, list);
    }
    return out;
  } catch {
    return new Map();
  }
}

async function ensureRow(entityId: string): Promise<void> {
  const sql = db();
  if (!sql) throw new MetaUnavailableError("the change");
  await sql`INSERT INTO scene_meta (entity_id) VALUES (${entityId}) ON CONFLICT (entity_id) DO NOTHING`;
}

export async function setLabel(entityId: string, label: string | null): Promise<void> {
  const sql = db();
  if (!sql) throw new MetaUnavailableError("the label");
  try {
    await ensureRow(entityId);
    await sql`UPDATE scene_meta SET label = ${label} WHERE entity_id = ${entityId}`;
  } catch (e) {
    throw e instanceof MetaUnavailableError ? e : new MetaUnavailableError("the label");
  }
}

export async function setAccent(entityId: string, accent: string | null): Promise<void> {
  const sql = db();
  if (!sql) throw new MetaUnavailableError("the accent");
  try {
    await ensureRow(entityId);
    await sql`UPDATE scene_meta SET accent = ${accent} WHERE entity_id = ${entityId}`;
  } catch (e) {
    throw e instanceof MetaUnavailableError ? e : new MetaUnavailableError("the accent");
  }
}

/**
 * Write an explicit order over the scenes named, and CLEAR it for the rest.
 *
 * Half-ordered is the worst state: `sort_order` beats frecency whenever it is
 * set, so leaving stale numbers on scenes the caller did not mention pins them
 * above scenes the caller deliberately placed. Passing the full intended order
 * and clearing everything else is the only version with a predictable result.
 */
export async function reorder(entityIds: string[]): Promise<void> {
  const sql = db();
  if (!sql) throw new MetaUnavailableError("the scene order");
  try {
    for (const id of entityIds) await ensureRow(id);
    await sql`UPDATE scene_meta SET sort_order = NULL WHERE entity_id <> ALL(${entityIds})`;
    for (const [index, id] of entityIds.entries()) {
      await sql`UPDATE scene_meta SET sort_order = ${index} WHERE entity_id = ${id}`;
    }
  } catch (e) {
    throw e instanceof MetaUnavailableError ? e : new MetaUnavailableError("the scene order");
  }
}

export async function setAliases(entityId: string, aliases: string[]): Promise<string[]> {
  const sql = db();
  if (!sql) throw new MetaUnavailableError("the aliases");
  try {
    await ensureRow(entityId);
    await sql`DELETE FROM scene_alias WHERE entity_id = ${entityId}`;
    for (const alias of aliases) {
      await sql`INSERT INTO scene_alias (entity_id, alias) VALUES (${entityId}, ${alias})
                ON CONFLICT (entity_id, alias) DO NOTHING`;
    }
    const rows = await sql<{ alias: string }[]>`
      SELECT alias FROM scene_alias WHERE entity_id = ${entityId} ORDER BY alias`;
    return rows.map((r) => r.alias);
  } catch (e) {
    throw e instanceof MetaUnavailableError ? e : new MetaUnavailableError("the aliases");
  }
}

export type History = {
  days: number;
  total_taps: number;
  by_scene: Array<{ entity_id: string; label: string | null; taps: number; last_tapped_at: string | null }>;
  by_hour: Array<{ hour: number; taps: number }>;
  recent: Array<{ entity_id: string; tapped_at: string }>;
};

/**
 * Tap history.
 *
 * Returns null — not an empty history — when it cannot be read, so "nothing has
 * been tapped" stays distinguishable from "the history is unavailable". A
 * caller told zero when the real answer is unknown reports a fact that isn't
 * one.
 */
export async function history(days: number): Promise<History | null> {
  const sql = db();
  if (!sql) return null;
  try {
    const since = `${days} days`;
    const [byScene, byHour, recent] = await Promise.all([
      sql<{ entity_id: string; label: string | null; taps: number; last_tapped_at: Date | null }[]>`
        SELECT t.entity_id, m.label, COUNT(*)::int AS taps, MAX(t.tapped_at) AS last_tapped_at
          FROM scene_tap t LEFT JOIN scene_meta m ON m.entity_id = t.entity_id
         WHERE t.tapped_at > now() - ${since}::interval
         GROUP BY t.entity_id, m.label
         ORDER BY taps DESC`,
      sql<{ hour: number; taps: number }[]>`
        SELECT EXTRACT(hour FROM tapped_at)::int AS hour, COUNT(*)::int AS taps
          FROM scene_tap WHERE tapped_at > now() - ${since}::interval
         GROUP BY 1 ORDER BY 1`,
      sql<{ entity_id: string; tapped_at: Date }[]>`
        SELECT entity_id, tapped_at FROM scene_tap
         WHERE tapped_at > now() - ${since}::interval
         ORDER BY tapped_at DESC LIMIT 50`,
    ]);
    return {
      days,
      total_taps: byScene.reduce((n, r) => n + r.taps, 0),
      by_scene: byScene.map((r) => ({
        entity_id: r.entity_id,
        label: r.label,
        taps: r.taps,
        last_tapped_at: r.last_tapped_at?.toISOString() ?? null,
      })),
      by_hour: byHour.map((r) => ({ hour: r.hour, taps: r.taps })),
      recent: recent.map((r) => ({ entity_id: r.entity_id, tapped_at: r.tapped_at.toISOString() })),
    };
  } catch {
    return null;
  }
}
