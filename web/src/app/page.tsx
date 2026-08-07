import { ScenePicker } from "@/components/scene-picker";
import { InstallHint } from "@/components/install-hint";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <>
      <ScenePicker />
      <InstallHint />
    </>
  );
}
