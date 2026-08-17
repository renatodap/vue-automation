import { RoomsPanel } from "@/components/rooms-panel";

export const dynamic = "force-dynamic";

/**
 * Home is the app's front door: the spotlit scenes, then each room and the
 * bulbs in it. The fastest path from "that lamp is too bright" to the lamp is
 * a list you can read in one glance, which a photograph of one room stopped
 * being the moment the house had two.
 */
export default function HomePage() {
  return <RoomsPanel />;
}
