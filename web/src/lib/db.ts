import "server-only";
import postgres from "postgres";
import { databaseUrl } from "./env";

/**
 * Shared Postgres on the Persimmon box — this app owns one database inside it.
 *
 * The database is deliberately optional. It stores presentation metadata and
 * tap history, never light state; Home Assistant is the source of truth for
 * what the lamps are actually doing. If Postgres is down the app must still
 * turn on the lights, so every read here has a fallback and every write is
 * best-effort.
 */

let client: ReturnType<typeof postgres> | null = null;

export function db() {
  const url = databaseUrl();
  if (!url) return null;
  if (!client) {
    client = postgres(url, {
      max: 4,
      idle_timeout: 20,
      connect_timeout: 10,
      // Coolify's shared Postgres is reached over the internal Docker network,
      // where TLS buys nothing and its absence is not a downgrade.
      ssl: url.includes("sslmode=require") ? "require" : false,
      onnotice: () => {},
    });
  }
  return client;
}

export type SceneMeta = {
  entityId: string;
  label: string | null;
  accent: string | null;
  sortOrder: number | null;
  tapCount: number;
  lastTappedAt: string | null;
};

/** Never throws — a metadata outage must not take the scene list down. */
export async function loadSceneMeta(): Promise<Map<string, SceneMeta>> {
  const sql = db();
  if (!sql) return new Map();
  try {
    const rows = await sql<
      {
        entity_id: string;
        label: string | null;
        accent: string | null;
        sort_order: number | null;
        tap_count: number;
        last_tapped_at: Date | null;
      }[]
    >`
      SELECT s.entity_id,
             s.label,
             s.accent,
             s.sort_order,
             COALESCE(t.tap_count, 0)::int AS tap_count,
             t.last_tapped_at
        FROM scene_meta s
        LEFT JOIN (
          SELECT entity_id,
                 COUNT(*) AS tap_count,
                 MAX(tapped_at) AS last_tapped_at
            FROM scene_tap
           GROUP BY entity_id
        ) t ON t.entity_id = s.entity_id
    `;
    return new Map(
      rows.map((r) => [
        r.entity_id,
        {
          entityId: r.entity_id,
          label: r.label,
          accent: r.accent,
          sortOrder: r.sort_order,
          tapCount: r.tap_count,
          lastTappedAt: r.last_tapped_at?.toISOString() ?? null,
        },
      ]),
    );
  } catch {
    return new Map();
  }
}

/** Fire-and-forget: a failed analytics write must never fail the user's tap. */
export async function recordTap(entityId: string): Promise<void> {
  const sql = db();
  if (!sql) return;
  try {
    await sql`
      INSERT INTO scene_meta (entity_id) VALUES (${entityId})
      ON CONFLICT (entity_id) DO NOTHING
    `;
    await sql`INSERT INTO scene_tap (entity_id) VALUES (${entityId})`;
  } catch {
    // Intentionally swallowed.
  }
}
