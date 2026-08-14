import { RoomMap } from "@/components/room-map";

export const dynamic = "force-dynamic";

/**
 * The room is the app's front door, as it is in the native app: the fastest
 * possible path from "that lamp is too bright" to the lamp itself is pointing
 * at where it physically is.
 */
export default function RoomPage() {
  return <RoomMap />;
}
