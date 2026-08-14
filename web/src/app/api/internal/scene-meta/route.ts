import { NextResponse } from "next/server";
import { getStates, toScenes } from "@/lib/ha";
import { internalSecretOk, unauthorized, badRequest } from "../_lib/guard";
import { internalError } from "../_lib/errors";
import { setAccent, setAliases, setLabel, reorder } from "../_lib/scene-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  action?: "label" | "accent" | "aliases" | "reorder";
  entity_id?: string;
  label?: string | null;
  accent?: string | null;
  aliases?: string[];
  entity_ids?: string[];
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Presentation metadata: the label, the accent, the order, and the spoken
 * aliases.
 *
 * None of it is authoritative about the house. Home Assistant owns which
 * scenes exist and what they do; this only decorates that list. Which is why
 * every entity id is checked against Home Assistant first — writing metadata
 * for a scene that does not exist creates a row nothing will ever join to, and
 * the caller would be told the rename worked.
 */
export async function POST(req: Request): Promise<Response> {
  if (!internalSecretOk(req)) return unauthorized();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return badRequest("Expected a JSON body.");
  }

  try {
    const known = new Set(toScenes(await getStates()).map((s) => s.entityId));

    switch (body.action) {
      case "label": {
        const id = requireScene(body.entity_id, known);
        if (typeof id !== "string") return id;
        const label = body.label == null ? null : String(body.label).trim();
        if (label !== null && label.length === 0) {
          return badRequest("label must be a non-empty string, or null to fall back to the Home Assistant name.");
        }
        await setLabel(id, label);
        return NextResponse.json({
          ok: true,
          entity_id: id,
          label,
          note:
            label === null
              ? "Cleared — the scene now shows the name Home Assistant reports."
              : "This is a display label stored beside Home Assistant, not a rename inside it. " +
                "The scene's own name in Home Assistant is unchanged.",
        });
      }

      case "accent": {
        const id = requireScene(body.entity_id, known);
        if (typeof id !== "string") return id;
        const accent = body.accent == null ? null : String(body.accent).trim();
        if (accent !== null && !HEX.test(accent)) {
          return badRequest(`accent must be a 6-digit hex colour like "#e8a54d", or null to fall back to the app's own accent.`);
        }
        await setAccent(id, accent);
        return NextResponse.json({ ok: true, entity_id: id, accent });
      }

      case "aliases": {
        const id = requireScene(body.entity_id, known);
        if (typeof id !== "string") return id;
        const raw = Array.isArray(body.aliases) ? body.aliases : null;
        if (!raw) return badRequest("aliases must be an array of strings (send [] to clear them).");
        const cleaned = [
          ...new Set(
            raw
              .filter((a): a is string => typeof a === "string")
              .map((a) => a.trim().toLowerCase())
              .filter((a) => a.length > 0 && a.length <= 60),
          ),
        ];
        const saved = await setAliases(id, cleaned);
        return NextResponse.json({ ok: true, entity_id: id, aliases: saved });
      }

      case "reorder": {
        const ids = Array.isArray(body.entity_ids)
          ? body.entity_ids.filter((e): e is string => typeof e === "string")
          : [];
        if (ids.length === 0) return badRequest("entity_ids must list the scenes in the order they should appear.");
        const missing = ids.filter((e) => !known.has(e));
        if (missing.length) {
          return NextResponse.json(
            { error: `Home Assistant has no scene called ${missing.join(", ")}.` },
            { status: 404 },
          );
        }
        // Passing a PARTIAL order is accepted, and the scenes left out have
        // their explicit order cleared rather than kept: sort_order beats
        // frecency wherever it is set, so a stale number on an unmentioned
        // scene would pin it above the ones deliberately placed.
        await reorder(ids);
        return NextResponse.json({
          ok: true,
          order: ids,
          cleared: [...known].filter((e) => !ids.includes(e)),
        });
      }

      default:
        return badRequest('action must be one of "label", "accent", "aliases", "reorder".');
    }
  } catch (error) {
    return internalError(error);
  }
}

function requireScene(entityId: string | undefined, known: Set<string>): string | Response {
  const id = (entityId ?? "").trim();
  if (!id.startsWith("scene.")) return badRequest("entity_id must be a scene.* entity.");
  if (!known.has(id)) {
    return NextResponse.json(
      { error: `Home Assistant has no scene called ${id}. Read the scene list again.` },
      { status: 404 },
    );
  }
  return id;
}
