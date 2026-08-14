import { NextResponse } from "next/server";
import {
  callService,
  deleteScene,
  getStates,
  saveScene,
  snapshotForScene,
  toLamps,
  toScenes,
} from "@/lib/ha";
import { recordTap } from "@/lib/db";
import { internalSecretOk, unauthorized, badRequest } from "../_lib/guard";
import { internalError } from "../_lib/errors";
import { getSceneConfig } from "../_lib/ha-config";
import { applyReport } from "../_lib/apply-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stable, readable, and collision-proof enough for one household. Mirrors
 *  `/api/scenes`, so a scene saved by Claude and one saved by a tap in the app
 *  get ids of the same shape. */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return base || "scene";
}

/** Read back a stored scene, so a caller can show what a change would replace. */
export async function GET(req: Request): Promise<Response> {
  if (!internalSecretOk(req)) return unauthorized();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return badRequest("Pass ?id= the scene's Home Assistant config id.");
  try {
    const config = await getSceneConfig(id);
    return NextResponse.json({ ok: true, id, config });
  } catch (error) {
    return internalError(error);
  }
}

type Body = {
  action?: "apply" | "save" | "delete";
  entity_id?: string;
  id?: string;
  name?: string;
  transition?: number;
};

export async function POST(req: Request): Promise<Response> {
  if (!internalSecretOk(req)) return unauthorized();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return badRequest("Expected a JSON body.");
  }

  try {
    switch (body.action) {
      case "apply":
        return await apply(body);
      case "save":
        return await save(body);
      case "delete":
        return await remove(body);
      default:
        return badRequest('action must be one of "apply", "save", "delete".');
    }
  } catch (error) {
    return internalError(error);
  }
}

/**
 * Activate a scene, then report honestly on what it could and couldn't reach.
 *
 * Home Assistant applies a scene to the lights it can talk to and stays quiet
 * about the ones it can't; silence reads as success. So the room is re-read
 * afterwards and compared against what the scene actually stores, and the
 * lamps that did not follow are named one by one.
 */
async function apply(body: Body): Promise<Response> {
  const entityId = body.entity_id ?? "";
  if (!entityId.startsWith("scene.")) return badRequest("entity_id must be a scene.* entity.");

  const before = await getStates();
  const scene = toScenes(before).find((s) => s.entityId === entityId);
  if (!scene) {
    return NextResponse.json(
      {
        error:
          `Home Assistant has no scene called ${entityId}. Read the scene list again — ` +
          `it may have been renamed or deleted.`,
      },
      { status: 404 },
    );
  }

  // What the scene is actually aiming at. A hand-written YAML scene with no
  // `id:` cannot be read back, so the fallback is every lamp — less precise,
  // still honest, and it never silently narrows the report.
  const config = scene.id ? await getSceneConfig(scene.id) : null;
  const targets: Record<string, unknown> =
    config?.entities && Object.keys(config.entities).length > 0
      ? config.entities
      : Object.fromEntries(toLamps(before).map((l) => [l.entityId, {}]));

  const data: Record<string, unknown> = { entity_id: entityId };
  if (typeof body.transition === "number" && Number.isFinite(body.transition)) {
    data.transition = Math.max(0, Math.min(300, body.transition));
  }
  await callService("scene", "turn_on", data);

  // Best-effort, never blocking the answer — a failed history write must not
  // fail a scene that already applied.
  void recordTap(entityId);

  const after = toLamps(await getStates());
  const report = applyReport(targets, after);

  return NextResponse.json({
    ok: true,
    applied_entity_id: entityId,
    scene: scene.name,
    read_at: new Date().toISOString(),
    // `applied` inside the report is the list of lamp NAMES that followed —
    // spread last so the report's own vocabulary wins over anything above.
    ...report,
    lamps: after,
  });
}

/**
 * Save the room as it is right now.
 *
 * Snapshotting beats a form: the light has already been arranged by eye, and
 * re-entering those values is both more work and less accurate than reading
 * what the lamps actually settled on.
 */
async function save(body: Body): Promise<Response> {
  const name = (body.name ?? "").trim();
  if (!name) return badRequest("A scene needs a name.");

  const lamps = toLamps(await getStates());
  const entities = snapshotForScene(lamps);
  if (Object.keys(entities).length === 0) {
    return NextResponse.json(
      {
        error:
          "No reachable lamps to capture, so there is nothing to save. Every bulb is " +
          "unavailable — check the lamp switches before trying again.",
      },
      { status: 409 },
    );
  }

  // Reuse the id when overwriting, so "save over this scene" updates in place
  // rather than leaving a duplicate with the same name behind.
  const sceneId = body.id?.trim() || `${slugify(name)}_${Math.floor(Date.now() / 1000)}`;
  const previous = body.id?.trim() ? await getSceneConfig(sceneId) : null;
  await saveScene(sceneId, name, entities);

  return NextResponse.json({
    ok: true,
    id: sceneId,
    name,
    captured: Object.keys(entities).length,
    entities,
    replaced: previous,
    skipped: lamps.filter((l) => !l.reachable).map((l) => l.name),
  });
}

async function remove(body: Body): Promise<Response> {
  const id = body.id?.trim();
  if (!id) return badRequest("Pass the scene's Home Assistant config id.");
  const previous = await getSceneConfig(id);
  if (!previous) {
    return NextResponse.json(
      {
        error:
          `Home Assistant has no editable scene with id "${id}". Scenes written by hand ` +
          `in scenes.yaml without an \`id:\` cannot be deleted over the API.`,
      },
      { status: 404 },
    );
  }
  await deleteScene(id);
  return NextResponse.json({ ok: true, deleted: id, was: previous });
}
