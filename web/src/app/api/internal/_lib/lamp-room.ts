import "server-only";
import { db } from "@/lib/db";
import { MetaUnavailableError } from "./scene-meta";

/**
 * The write half of the room override layer. The read half is
 * `loadRoomOverrides` in `lib/db.ts`, and the two have deliberately opposite
 * failure policies.
 *
 * The READ swallows everything: an unreachable database means no overrides,
 * resolution falls back to the static map in `lib/rooms.ts`, and Home groups
 * exactly as it always has. That is what keeps invariant 9 true.
 *
 * The WRITE throws. Someone asked for a lamp to be moved; reporting success
 * over a write that never landed is a lie they find out about later, by opening
 * the app and seeing the bulb still in the old room.
 */

/** Clearing an override is a delete, so the static map takes over again. */
export async function setLampRoom(entityId: string, roomId: string | null): Promise<void> {
  const sql = db();
  if (!sql) throw new MetaUnavailableError("the room assignment");
  try {
    if (roomId === null) {
      await sql`DELETE FROM lamp_room WHERE entity_id = ${entityId}`;
      return;
    }
    await sql`
      INSERT INTO lamp_room (entity_id, room_id, updated_at)
      VALUES (${entityId}, ${roomId}, now())
      ON CONFLICT (entity_id) DO UPDATE SET room_id = ${roomId}, updated_at = now()
    `;
  } catch (e) {
    throw e instanceof MetaUnavailableError
      ? e
      : new MetaUnavailableError("the room assignment");
  }
}
