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
  spotlight: boolean;
  tapCount: number;
  lastTappedAt: string | null;
};

type MetaRow = {
  entity_id: string;
  label: string | null;
  accent: string | null;
  sort_order: number | null;
  spotlight: boolean | null;
  tap_count: number;
  last_tapped_at: Date | null;
};

/** Never throws — a metadata outage must not take the scene list down. */
export async function loadSceneMeta(): Promise<Map<string, SceneMeta>> {
  const sql = db();
  if (!sql) return new Map();

  let rows: MetaRow[];
  try {
    rows = await sql<MetaRow[]>`
      SELECT s.entity_id,
             s.label,
             s.accent,
             s.sort_order,
             s.spotlight,
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
  } catch {
    // Almost always "column spotlight does not exist" — the app deployed ahead
    // of its migration. Losing the spotlight row is a missing convenience;
    // losing every label and accent with it would look like data loss, so the
    // older shape is worth one more round trip before giving up.
    try {
      rows = (
        await sql<Omit<MetaRow, "spotlight">[]>`
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
        `
      ).map((r) => ({ ...r, spotlight: false }));
    } catch {
      return new Map();
    }
  }

  return new Map(
    rows.map((r) => [
      r.entity_id,
      {
        entityId: r.entity_id,
        label: r.label,
        accent: r.accent,
        sortOrder: r.sort_order,
        spotlight: r.spotlight ?? false,
        tapCount: r.tap_count,
        lastTappedAt: r.last_tapped_at?.toISOString() ?? null,
      },
    ]),
  );
}

/**
 * Put a scene in the spotlight, or take it out.
 *
 * Unlike recordTap this one THROWS on failure. A tap that fails to be counted
 * costs nothing, but a spotlight toggle that silently does nothing leaves a
 * switch on screen showing a state the database never agreed to.
 */
export async function setSpotlight(entityId: string, spotlight: boolean): Promise<void> {
  const sql = db();
  if (!sql) throw new Error("The database that stores this isn't configured");
  await sql`
    INSERT INTO scene_meta (entity_id, spotlight) VALUES (${entityId}, ${spotlight})
    ON CONFLICT (entity_id) DO UPDATE SET spotlight = ${spotlight}
  `;
}

/** Drop a deleted scene's metadata, so its label can't haunt a reused id. */
export async function forgetScene(entityId: string): Promise<void> {
  const sql = db();
  if (!sql) return;
  try {
    await sql`DELETE FROM scene_meta WHERE entity_id = ${entityId}`;
  } catch {
    // Best-effort: the scene is already gone from Home Assistant, which is the
    // half that decides whether it still exists.
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

/**
 * The per-bulb room overrides that shadow the static map in `lib/rooms.ts`.
 *
 * Never throws, exactly like `loadSceneMeta`: an empty map is the correct
 * answer for "Postgres is unreachable", because resolution then falls through
 * to the compiled-in assignments and Home groups the way it always has. This is
 * the read that makes invariant 9 survive a metadata outage, so it must not be
 * given the chance to fail loudly.
 */
export async function loadRoomOverrides(): Promise<Record<string, string>> {
  const sql = db();
  if (!sql) return {};
  try {
    const rows = await sql<{ entity_id: string; room_id: string }[]>`
      SELECT entity_id, room_id FROM lamp_room`;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.entity_id] = r.room_id;
    return out;
  } catch {
    return {};
  }
}
