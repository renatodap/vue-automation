import { NextResponse } from "next/server";
import { getStates, toLamps } from "@/lib/ha";
import { loadRoomOverrides } from "@/lib/db";
import { ROOMS, isRoomId, roomOf } from "@/lib/rooms";
import { internalSecretOk, unauthorized, badRequest } from "../_lib/guard";
import { internalError } from "../_lib/errors";
import { setLampRoom } from "../_lib/lamp-room";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  entity_id?: string;
  room_id?: string | null;
};

/**
 * Move a bulb to a room, or clear the override so the static map takes over.
 *
 * This shadows `ASSIGNMENTS` in `lib/rooms.ts` rather than replacing it, which
 * is the whole reason the feature is allowed to exist: a database outage costs
 * the overrides, not the grouping.
 *
 * Two checks are the point of the route. The lamp is verified against a LIVE
 * Home Assistant read, so a typo becomes a 404 instead of an orphan row that
 * silently does nothing; and the room is checked against the closed `RoomId`
 * set, so a model cannot invent "livingroom" and create a room that renders
 * nowhere. Rooms themselves are a source-level decision and are not writable
 * here — assigning a bulb to an existing room is bookkeeping, adding a room is
 * a decision about how Home is laid out.
 */
export async function POST(req: Request): Promise<Response> {
  if (!internalSecretOk(req)) return unauthorized();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return badRequest("Expected a JSON body.");
  }

  const entityId = (body.entity_id ?? "").trim();
  if (!entityId.startsWith("light.")) {
    return badRequest("entity_id must be a light.* entity.");
  }

  // undefined and null mean different things here: null is an explicit "clear
  // it", undefined is a caller that forgot the field. Only the first is a
  // valid request.
  if (body.room_id === undefined) {
    return badRequest(
      `room_id is required — one of ${ROOMS.map((r) => `"${r.id}"`).join(", ")}, ` +
        `or null to clear the override and fall back to the built-in assignment.`,
    );
  }
  const roomId = body.room_id === null ? null : String(body.room_id).trim();
  if (roomId !== null && !isRoomId(roomId)) {
    return badRequest(
      `"${roomId}" is not a room. Use one of ${ROOMS.map((r) => `"${r.id}"`).join(", ")}, ` +
        `or null to clear the override. Rooms are defined in the app and cannot be created here.`,
    );
  }

  try {
    const [states, overrides] = await Promise.all([getStates(), loadRoomOverrides()]);
    const lamp = toLamps(states).find((l) => l.entityId === entityId);
    if (!lamp) {
      return NextResponse.json(
        { error: `Home Assistant has no light called ${entityId}. Read the lamp list again.` },
        { status: 404 },
      );
    }

    const before = roomOf(entityId, overrides);
    await setLampRoom(entityId, roomId);
    // Setting an override makes it the answer, since it was checked against the
    // room set above. Clearing one means resolving WITHOUT any override, which
    // is the static map — not "unassigned".
    const resolved = roomId === null ? roomOf(entityId) : roomId;

    return NextResponse.json({
      ok: true,
      entity_id: entityId,
      lamp: lamp.name,
      room: resolved,
      room_name: ROOMS.find((r) => r.id === resolved)?.name ?? resolved,
      previous_room: before,
      note:
        roomId === null
          ? `Override cleared. ${lamp.name} falls back to the app's built-in assignment, which puts it in "${resolved}".`
          : before === resolved
            ? `${lamp.name} was already in "${resolved}" — the override is now recorded explicitly.`
            : `${lamp.name} moved from "${before}" to "${resolved}". This is how the app groups it; ` +
              `Home Assistant's own areas are unchanged.`,
    });
  } catch (error) {
    return internalError(error);
  }
}
