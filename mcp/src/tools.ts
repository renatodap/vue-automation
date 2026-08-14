/**
 * The tool registry.
 *
 * Every tool is a NAMED question or a named mutation with a schema and a tested
 * implementation. There is no generic SQL writer and there never will be: a
 * write expressed as free-form SQL is a write nobody reviewed, against a house.
 * The one raw-SQL surface, `query_sql`, is read-only, fenced to three tables,
 * and is the last resort rather than a substitute for a named read.
 *
 * Descriptions here are prompt text the model reads on every call, so they
 * carry the operating rules — what to say when a scene only partly applied,
 * why a cached reading must never be presented as current, when to propose
 * rather than do.
 *
 * Handlers return `{ data, audit }`. `audit` carries before/after for the
 * mutations, which the RPC layer writes to the trail and never sends to the
 * model.
 */
import { api, ApiError, type Lamp, type SceneRow } from "./api.js";
import {
  bridgeInfo, ensureConnected, listDevices, mqttConfigured, MqttError,
  permitJoin, recentEvents, renameDevice,
} from "./mqtt.js";
import { entityRegistryList, haConfigured, HaRegistryError, renameEntity } from "./ha-registry.js";
import { consumeProposal, createProposal, pendingProposals, ProposalError } from "./propose.js";

/** A failure the model should read and correct, not an outage. */
export class ToolError extends Error {}

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolResult {
  data: unknown;
  audit?: { before?: unknown; after?: unknown };
}

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

// ------------------------------------------------------------------ coercion

/**
 * Arguments arrive from a model, so they are coerced DEFENSIVELY and the error
 * messages are written for the model to act on. A limit of 5000, an enum it
 * invented and a colour spelled "warm white" are all routine.
 */
function str(a: Record<string, unknown>, key: string): string | undefined {
  const v = a[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ToolError(`${key} must be a string — got ${typeof v}.`);
  const t = v.trim();
  return t.length ? t : undefined;
}

function requiredStr(a: Record<string, unknown>, key: string): string {
  const v = str(a, key);
  if (!v) throw new ToolError(`${key} is required.`);
  return v;
}

function num(a: Record<string, unknown>, key: string): number | undefined {
  const v = a[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`${key} must be a number — got ${JSON.stringify(v)}.`);
  return n;
}

function bool(a: Record<string, unknown>, key: string): boolean | undefined {
  const v = a[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new ToolError(`${key} must be true or false — got ${JSON.stringify(v)}.`);
}

function strArray(a: Record<string, unknown>, key: string): string[] | undefined {
  const v = a[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new ToolError(`${key} must be an array of strings.`);
  return v.map((x) => {
    if (typeof x !== "string") throw new ToolError(`${key} must contain only strings.`);
    return x.trim();
  }).filter((x) => x.length > 0);
}

/** Turn any transport failure into something the model can act on. */
function rethrow(e: unknown): never {
  if (e instanceof ToolError) throw e;
  if (e instanceof ApiError || e instanceof MqttError || e instanceof HaRegistryError || e instanceof ProposalError) {
    throw new ToolError(e.message);
  }
  throw e;
}

/** Resolve a scene from anything the user might have said: an entity id, a
 *  config id, a label, the Home Assistant name, or a saved alias. */
function findScene(scenes: SceneRow[], needle: string): SceneRow | undefined {
  const n = needle.trim().toLowerCase();
  return (
    scenes.find((s) => s.entityId.toLowerCase() === n) ??
    scenes.find((s) => (s.id ?? "").toLowerCase() === n) ??
    scenes.find((s) => s.label.toLowerCase() === n) ??
    scenes.find((s) => s.name.toLowerCase() === n) ??
    scenes.find((s) => s.aliases.some((a) => a.toLowerCase() === n))
  );
}

function sceneNotFound(scenes: SceneRow[], needle: string): ToolError {
  return new ToolError(
    `No scene matches "${needle}". Home Assistant currently has: ` +
      (scenes.length ? scenes.map((s) => `${s.label} (${s.entityId})` ).join(", ") : "no scenes at all") +
      ". Call get_scenes and use one of these entity ids.",
  );
}

function findLamp(lamps: Lamp[], needle: string): Lamp | undefined {
  const n = needle.trim().toLowerCase();
  return (
    lamps.find((l) => l.entityId.toLowerCase() === n) ??
    lamps.find((l) => l.name.toLowerCase() === n) ??
    lamps.find((l) => l.name.toLowerCase().includes(n))
  );
}

/** The line every read carries. Says when it was read, and that it is a
 *  reading rather than a memory. */
function freshness(readAt: string): string {
  return `Read from Home Assistant at ${readAt}. This is a live reading — never repeat an ` +
    `earlier one as if it were current; re-read instead.`;
}

// -------------------------------------------------------------------- tools

export const TOOLS: ToolDef[] = [
  // ------------------------------------------------------------------ reads
  {
    name: "get_room",
    title: "The lamps, right now",
    description:
      "Every lamp in the living room as Home Assistant reports it THIS SECOND: on/off, brightness, " +
      "colour temperature or hue, the bulb's own tunable Kelvin range, and — the field that matters " +
      "most — whether it is reachable at all.\n\n" +
      "CALL THIS BEFORE ANSWERING ANYTHING ABOUT THE LIGHTS. You have no memory of the room: someone " +
      "flips a wall switch, an automation fires, another phone taps a scene. A reading from earlier in " +
      "the conversation is not evidence about now, and stating it as current is worse than saying you " +
      "don't know, because the user acts on it.\n\n" +
      "UNREACHABLE MEANS THE BULB LOST POWER. A smart bulb is only smart while it has electricity, so " +
      "'unreachable' almost always means the lamp is switched off at the lamp or the wall. Say that " +
      "plainly — it is a physical fix, not a bug — and never guess what an unreachable lamp is doing.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      try {
        const state = await api.state();
        return {
          data: {
            read_at: state.read_at,
            lamps: state.lamps,
            unreachable: state.lamps.filter((l) => !l.reachable).map((l) => l.name),
            all_reachable: state.unreachableCount === 0,
            note: freshness(state.read_at),
          },
        };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "get_scenes",
    title: "The scene list",
    description:
      "Every scene Home Assistant knows, in the order the app shows them, merged with the presentation " +
      "metadata stored beside it: the display label, the accent colour, the explicit order, how many " +
      "times each has been tapped, and any spoken aliases.\n\n" +
      "Home Assistant owns which scenes EXIST; the database only decorates them. If `metadata` comes " +
      "back \"unavailable\" the labels have fallen back to Home Assistant's own names — that is not the " +
      "same as the labels having been cleared, and it is worth mentioning rather than silently showing " +
      "different names than the app does.\n\n" +
      "`id` is the Home Assistant config id and is NOT the entity id. Scenes written by hand in " +
      "scenes.yaml without an `id:` have `id: null` and can never be edited or deleted over the API — " +
      "say so rather than trying.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      try {
        const state = await api.state();
        return {
          data: {
            read_at: state.read_at,
            scenes: state.scenes,
            metadata: state.metadata,
            note:
              freshness(state.read_at) +
              (state.metadata === "unavailable"
                ? " The metadata database did not answer, so labels, accents, order and tap counts are " +
                  "falling back to Home Assistant's own names. Say so before reporting them as the user's."
                : ""),
          },
        };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "get_lamp",
    title: "One lamp, in full",
    description:
      "One lamp's live state, including the range it can actually be tuned to. Accepts the entity id " +
      "(`light.floor_lamp`) or the name a person would say ('the arc lamp over the couch' → floor lamp).\n\n" +
      "Read `min_kelvin`/`max_kelvin` off the bulb before proposing a colour temperature. Never assume " +
      "2700–6500: a value outside the bulb's real range is rejected SILENTLY by Home Assistant and the " +
      "lamp simply doesn't move, which looks exactly like the request never landed.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "e.g. light.floor_lamp — or the lamp's name" },
      },
      required: ["entity_id"],
    },
    handler: async (a) => {
      const needle = requiredStr(a, "entity_id");
      try {
        const state = await api.state();
        const lamp = findLamp(state.lamps, needle);
        if (!lamp) {
          throw new ToolError(
            `No lamp matches "${needle}". Home Assistant reports: ` +
              (state.lamps.length
                ? state.lamps.map((l) => `${l.name} (${l.entityId})`).join(", ")
                : "no light entities at all") +
              ".",
          );
        }
        return { data: { read_at: state.read_at, lamp, note: freshness(state.read_at) } };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "get_schedules",
    title: "The schedules",
    description:
      "Every automation Home Assistant holds for this house, with whether it is ENABLED and when it " +
      "last fired.\n\n" +
      "`enabled: false` means the schedule still exists and will not fire. It is not deleted, and that " +
      "distinction matters: a disabled schedule looks identical to a missing one to anyone who only " +
      "checks whether the lights came on. Pass `include_config: true` to read back the actual trigger " +
      "and action of one schedule before changing it.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        include_config: {
          type: "boolean",
          description: "also fetch each editable schedule's stored trigger/action (slower)",
        },
      },
    },
    handler: async (a) => {
      const full = bool(a, "include_config") ?? false;
      try {
        const state = await api.state();
        const schedules = await Promise.all(
          state.automations.map(async (s) => {
            if (!full || !s.id) return s;
            try {
              const { config } = await api.scheduleConfig(s.id);
              return { ...s, config };
            } catch {
              return { ...s, config: null };
            }
          }),
        );
        return {
          data: {
            read_at: state.read_at,
            schedules,
            note:
              freshness(state.read_at) +
              " A schedule with `id: null` was written by hand and cannot be edited or deleted here.",
          },
        };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "get_history",
    title: "Which scenes actually get used",
    description:
      "Tap history from the app's database: totals per scene, the hour-of-day distribution, and the " +
      "most recent taps. This is what the picker uses to float frequent scenes to the top.\n\n" +
      "It records TAPS, not the state of the lamps — nothing here says what the light is doing now, and " +
      "a scene applied by a schedule rather than a tap does not appear. If the database is unavailable " +
      "this returns an error rather than zero: reporting 'no taps' when the real answer is 'unknown' " +
      "states a fact that isn't one.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "how far back to look, 1–365 (default 30)" },
      },
    },
    handler: async (a) => {
      const days = Math.max(1, Math.min(Math.round(num(a, "days") ?? 30), 365));
      try {
        return { data: await api.history(days) };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "list_pending_changes",
    title: "Changes waiting for approval",
    description:
      "Every proposal minted by a propose_* tool that has not yet been committed or expired, with its " +
      "diff and how long it has left. Use it when the user says 'go ahead' without saying to what.\n\n" +
      "It does NOT return the tokens. A token is a capability to make an irreversible change, and " +
      "handing them back through a listing would let one be committed without anyone having read its " +
      "diff — which is the entire point of the two-step.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({ data: { pending: pendingProposals() } }),
  },
  {
    name: "query_sql",
    title: "Read-only SQL over the scene metadata",
    description:
      "A LAST RESORT for a genuinely novel question about scene metadata and tap history that no named " +
      "tool answers — 'which scene do I use most between 18:00 and 21:00', 'how has my evening scene " +
      "changed month to month'. If get_scenes or get_history answers the question, using SQL instead is " +
      "a bug: it produces a right answer by luck rather than by design.\n\n" +
      "Read-only and fenced to three tables:\n" +
      "  • scene_meta(entity_id PK, label, accent, sort_order, created_at)\n" +
      "  • scene_tap(id, entity_id → scene_meta, tapped_at)\n" +
      "  • scene_alias(entity_id → scene_meta, alias, created_at)\n" +
      "Nothing about the lamps themselves is in this database — Home Assistant owns that, on a " +
      "different machine — so no query here can tell you whether a light is on.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "one SELECT / WITH / TABLE statement, no trailing semicolon" },
        max_rows: { type: "number", description: "row cap, 1–1000 (default 200)" },
      },
      required: ["query"],
    },
    handler: async (a) => {
      const query = requiredStr(a, "query");
      const maxRows = Math.max(1, Math.min(Math.round(num(a, "max_rows") ?? 200), 1000));
      try {
        return { data: await api.query(query, maxRows) };
      } catch (e) {
        rethrow(e);
      }
    },
  },

  // ----------------------------------------------------------------- writes
  {
    name: "apply_scene",
    title: "Apply a scene",
    description:
      "Turn the room to a saved scene. Accepts the entity id, the label, the Home Assistant name or a " +
      "saved alias.\n\n" +
      "REPORT WHAT COMES BACK, NOT THAT IT SUCCEEDED. Home Assistant applies a scene to the lamps it " +
      "can reach and stays SILENT about the rest, so silence reads as success. The result carries " +
      "`fully_applied`, `unreachable` and `did_not_match`; when `fully_applied` is false you must say " +
      "which lamps didn't follow and why. 'Cozy Cinema is on' while the floor lamp sits dark is the " +
      "exact failure this connector exists to prevent — and the fix is usually physical, so naming the " +
      "lamp is what makes it actionable.\n\n" +
      "`transition` is seconds to fade over. Omit it for an instant change.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        scene_id: { type: "string", description: "entity id (scene.cozy_cinema), label, name or alias" },
        transition: { type: "number", description: "fade in seconds, 0–300; omit for instant" },
      },
      required: ["scene_id"],
    },
    handler: async (a) => {
      const needle = requiredStr(a, "scene_id");
      const transition = num(a, "transition");
      try {
        const before = await api.state();
        const scene = findScene(before.scenes, needle);
        if (!scene) throw sceneNotFound(before.scenes, needle);
        const report = await api.applyScene(scene.entityId, transition);
        return {
          data: report,
          audit: { before: before.lamps, after: report.lamps },
        };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "set_lamp",
    title: "Set one lamp (or all of them)",
    description:
      "Change a single lamp: on/off, brightness, colour temperature or hue. The escape hatch behind the " +
      "scenes, for when a scene is nearly right and one lamp is too bright.\n\n" +
      "COLOUR TEMPERATURE AND HUE ARE MUTUALLY EXCLUSIVE modes on these bulbs. Send one. If both are " +
      "sent, hue wins — but decide which you meant rather than relying on that.\n\n" +
      "Kelvin is clamped to the range the BULB reports (get_lamp shows it), not to a guessed 2700–6500. " +
      "Brightness is 1–100 percent; 0 is not off, use `on: false`.\n\n" +
      "The result re-reads the lamp afterwards. If it comes back unreachable, the change did NOT happen " +
      "— the bulb has no power. Say so.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "light.floor_lamp, the lamp's name, or 'all' for every lamp" },
        on: { type: "boolean", description: "false turns it off; omit to leave the power state alone" },
        brightness: { type: "number", description: "1–100 percent" },
        kelvin: { type: "number", description: "colour temperature; clamped to the bulb's own range" },
        hs: {
          type: "array",
          description: "[hue 0–360, saturation 0–100] — only for bulbs where supportsColor is true",
          items: { type: "number" },
        },
        transition: { type: "number", description: "fade in seconds, 0–300" },
      },
      required: ["entity_id"],
    },
    handler: async (a) => {
      const needle = requiredStr(a, "entity_id");
      const on = bool(a, "on");
      const brightness = num(a, "brightness");
      const kelvin = num(a, "kelvin");
      const transition = num(a, "transition");
      const rawHs = a.hs;
      let hs: [number, number] | undefined;
      if (rawHs !== undefined && rawHs !== null) {
        if (!Array.isArray(rawHs) || rawHs.length !== 2 || rawHs.some((n) => typeof n !== "number")) {
          throw new ToolError("hs must be [hue 0-360, saturation 0-100].");
        }
        hs = rawHs as [number, number];
      }
      if (on === undefined && brightness === undefined && kelvin === undefined && hs === undefined) {
        throw new ToolError(
          "Nothing to change — pass at least one of on, brightness, kelvin or hs. " +
            "To read a lamp without changing it, use get_lamp.",
        );
      }

      try {
        const before = await api.state();
        let entityIds: string[];
        if (needle.toLowerCase() === "all") {
          entityIds = before.lamps.map((l) => l.entityId);
          if (entityIds.length === 0) throw new ToolError("Home Assistant reports no light entities at all.");
        } else {
          const lamp = findLamp(before.lamps, needle);
          if (!lamp) {
            throw new ToolError(
              `No lamp matches "${needle}". Home Assistant reports: ` +
                before.lamps.map((l) => `${l.name} (${l.entityId})`).join(", ") + ".",
            );
          }
          if (hs && !lamp.supportsColor) {
            throw new ToolError(
              `${lamp.name} cannot do colour — it is a tunable-white bulb. Use kelvin ` +
                `(${lamp.minKelvin}–${lamp.maxKelvin}K) instead.`,
            );
          }
          if (kelvin !== undefined && (kelvin < lamp.minKelvin || kelvin > lamp.maxKelvin)) {
            throw new ToolError(
              `${lamp.name} tunes between ${lamp.minKelvin}K and ${lamp.maxKelvin}K; ${kelvin}K is outside ` +
                `that. Pick a value inside the range — out-of-range values are rejected silently and the ` +
                `lamp simply does not move.`,
            );
          }
          entityIds = [lamp.entityId];
        }

        const result = await api.setLamp({
          entity_ids: entityIds,
          ...(on !== undefined ? { on } : {}),
          ...(brightness !== undefined ? { brightness } : {}),
          ...(kelvin !== undefined ? { kelvin } : {}),
          ...(hs ? { hs } : {}),
          ...(transition !== undefined ? { transition } : {}),
        });
        return {
          data: result,
          audit: {
            before: before.lamps.filter((l) => entityIds.includes(l.entityId)),
            after: result.lamps,
          },
        };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "save_scene",
    title: "Save the room as a new scene",
    description:
      "Capture what the lamps are doing RIGHT NOW as a new, persistent Home Assistant scene. It shows " +
      "up as a real `scene.*` entity immediately and survives a reboot, because it is written through " +
      "the scene-editor API rather than the in-memory `scene.create` service.\n\n" +
      "Snapshotting is the point: the light has already been arranged by eye, and re-entering those " +
      "values from a description is both more work and less accurate. So arrange the room with set_lamp " +
      "or apply_scene first, confirm it looks right, THEN save.\n\n" +
      "UNREACHABLE LAMPS ARE NOT CAPTURED — you cannot record what you cannot read. The result lists " +
      "what was skipped; if anything was, tell the user before they discover the scene is missing a lamp.\n\n" +
      "This only CREATES. Overwriting an existing scene destroys its previous definition, so that goes " +
      "through propose_overwrite_scene instead.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "what to call it, e.g. \"Cozy Cinema\"" },
        from_current: {
          type: "boolean",
          description: "must be true — the scene is always a snapshot of the room as it is now",
        },
      },
      required: ["name", "from_current"],
    },
    handler: async (a) => {
      const name = requiredStr(a, "name");
      const fromCurrent = bool(a, "from_current");
      if (fromCurrent !== true) {
        throw new ToolError(
          "from_current must be true. A scene is always a snapshot of the room as it is now — arrange " +
            "the lamps with set_lamp first, check it looks right, then save.",
        );
      }
      try {
        const before = await api.state();
        const clash = before.scenes.find(
          (s) => s.label.toLowerCase() === name.toLowerCase() || s.name.toLowerCase() === name.toLowerCase(),
        );
        if (clash) {
          throw new ToolError(
            `A scene called "${name}" already exists (${clash.entityId}). Saving another would leave two ` +
              `scenes with the same name. To replace it, use propose_overwrite_scene — it shows the user ` +
              `what would be lost first. To keep both, pick a different name.`,
          );
        }
        const saved = await api.saveScene(name);
        return {
          data: {
            ...saved,
            note:
              saved.skipped.length
                ? `${saved.skipped.join(", ")} could not be captured — those bulbs have no power, so the ` +
                  `scene does not touch them. Mention this.`
                : "Captured every reachable lamp.",
          },
          audit: { before: before.lamps, after: saved.entities },
        };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "rename_scene",
    title: "Set a scene's display label",
    description:
      "Set the label the app shows for a scene, stored beside Home Assistant rather than inside it.\n\n" +
      "This is a DISPLAY label, not a rename in Home Assistant. The scene keeps its own name there, so " +
      "the Home Assistant app, HomeKit and any automation referencing it are untouched. Pass `label: " +
      "null` to clear the override and fall back to whatever Home Assistant reports — which is the right " +
      "move when the two have drifted apart, rather than pinning a stale copy on top.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "scene entity id, current label, name or alias" },
        label: { type: ["string", "null"], description: "the new label, or null to fall back to Home Assistant's name" },
      },
      required: ["entity_id", "label"],
    },
    handler: async (a) => {
      const needle = requiredStr(a, "entity_id");
      const label = a.label === null ? null : requiredStr(a, "label");
      try {
        const before = await api.state();
        const scene = findScene(before.scenes, needle);
        if (!scene) throw sceneNotFound(before.scenes, needle);
        const out = await api.sceneMeta({ action: "label", entity_id: scene.entityId, label });
        return { data: out, audit: { before: { label: scene.label }, after: { label } } };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "set_scene_accent",
    title: "Set a scene's accent colour",
    description:
      "The accent colour the app tints a scene's tile with. A 6-digit hex string like \"#e8a54d\", or " +
      "null to fall back to the app's own accent.\n\n" +
      "Purely cosmetic and unrelated to what the lamps do — setting a scene's accent to blue does not " +
      "make the light blue. If the user meant the light, they want set_lamp or a re-saved scene.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "scene entity id, label, name or alias" },
        accent: { type: ["string", "null"], description: "hex colour like \"#e8a54d\", or null to clear" },
      },
      required: ["entity_id", "accent"],
    },
    handler: async (a) => {
      const needle = requiredStr(a, "entity_id");
      const accent = a.accent === null ? null : requiredStr(a, "accent");
      try {
        const before = await api.state();
        const scene = findScene(before.scenes, needle);
        if (!scene) throw sceneNotFound(before.scenes, needle);
        const out = await api.sceneMeta({ action: "accent", entity_id: scene.entityId, accent });
        return { data: out, audit: { before: { accent: scene.accent }, after: { accent } } };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "reorder_scenes",
    title: "Set the order scenes appear in",
    description:
      "Pin the order of the scene picker. Pass the entity ids in the order they should appear.\n\n" +
      "PASS THE FULL ORDER YOU WANT, not just the ones that moved. An explicit order beats usage-based " +
      "ordering wherever it is set, so any scene left out has its explicit position CLEARED and falls " +
      "back to frecency — half-pinned is the one state with no predictable result. Call get_scenes " +
      "first, decide the whole list, then send it.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        entity_ids: {
          type: "array",
          description: "scene entity ids, first to last",
          items: { type: "string" },
        },
      },
      required: ["entity_ids"],
    },
    handler: async (a) => {
      const wanted = strArray(a, "entity_ids");
      if (!wanted || wanted.length === 0) {
        throw new ToolError("entity_ids must list the scenes in the order they should appear.");
      }
      try {
        const before = await api.state();
        const resolved: string[] = [];
        for (const needle of wanted) {
          const scene = findScene(before.scenes, needle);
          if (!scene) throw sceneNotFound(before.scenes, needle);
          resolved.push(scene.entityId);
        }
        const out = await api.sceneMeta({ action: "reorder", entity_ids: resolved });
        return {
          data: out,
          audit: {
            before: before.scenes.map((s) => ({ entity_id: s.entityId, sort_order: s.sortOrder })),
            after: resolved,
          },
        };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "set_scene_aliases",
    title: "Set the spoken names for a scene",
    description:
      "The alternative names a scene answers to — 'movie mode', 'film night', 'cinema' all reaching " +
      "scene.cozy_cinema. Aliases are matched by apply_scene and by anything else that resolves a " +
      "scene by name.\n\n" +
      "REPLACES the whole set: send every alias the scene should have, not just the new one. Send an " +
      "empty array to clear them. Aliases are lowercased and de-duplicated on the way in.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "scene entity id, label, name or existing alias" },
        aliases: { type: "array", description: "the complete alias set; [] clears them", items: { type: "string" } },
      },
      required: ["entity_id", "aliases"],
    },
    handler: async (a) => {
      const needle = requiredStr(a, "entity_id");
      const aliases = strArray(a, "aliases");
      if (!aliases) throw new ToolError("aliases must be an array of strings (send [] to clear them).");
      try {
        const before = await api.state();
        const scene = findScene(before.scenes, needle);
        if (!scene) throw sceneNotFound(before.scenes, needle);
        const out = await api.sceneMeta({ action: "aliases", entity_id: scene.entityId, aliases });
        return { data: out, audit: { before: { aliases: scene.aliases }, after: { aliases } } };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "set_schedule",
    title: "Create or edit a schedule",
    description:
      "A schedule is a Home Assistant automation in one of the two shapes a lighting setup actually " +
      "needs: at a clock time, or at an offset from sunrise/sunset.\n\n" +
      "PREFER SUNSET OVER A CLOCK TIME. 'Lights at 6pm' is wrong for most of the year — pitch dark at " +
      "5pm in December, broad daylight at 8pm in June. 'At sunset', or 'thirty minutes before sunset' " +
      "(offset_minutes: -30), is almost always what someone means, and Home Assistant already tracks it " +
      "for these coordinates.\n\n" +
      "Pass `id` to EDIT an existing schedule in place; omit it to create a new one. Editing replaces " +
      "the trigger and action wholesale — read the current one with get_schedules(include_config: true) " +
      "first if you are only changing part of it.\n\n" +
      "Every schedule written here is pinned enabled across restarts. Without that pin an automation can " +
      "come back disabled after a reload and silently never fire again, which nobody notices for weeks.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "what to call it, e.g. \"Evening lights\"" },
        when: { type: "string", enum: ["time", "sunset", "sunrise"], description: "what triggers it" },
        time: { type: "string", description: "when=time only: \"HH:MM\" on a 24-hour clock" },
        offset_minutes: {
          type: "number",
          description: "when=sunset/sunrise only: minutes relative to the event, negative = before. ±720 max.",
        },
        do_what: { type: "string", enum: ["scene", "allOff"], description: "apply a scene, or turn every light off" },
        scene_id: { type: "string", description: "do_what=scene only: the scene entity id, label or alias" },
        id: { type: "string", description: "the Home Assistant config id, to edit an existing schedule in place" },
      },
      required: ["name", "when", "do_what"],
    },
    handler: async (a) => {
      const name = requiredStr(a, "name");
      const when = requiredStr(a, "when");
      const doWhat = requiredStr(a, "do_what");
      if (!["time", "sunset", "sunrise"].includes(when)) {
        throw new ToolError(`when must be "time", "sunset" or "sunrise" — got "${when}".`);
      }
      if (!["scene", "allOff"].includes(doWhat)) {
        throw new ToolError(`do_what must be "scene" or "allOff" — got "${doWhat}".`);
      }
      const time = str(a, "time");
      if (when === "time" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time ?? "")) {
        throw new ToolError('when="time" needs time as "HH:MM" on a 24-hour clock, e.g. "18:30".');
      }
      const id = str(a, "id");

      try {
        const before = await api.state();
        let sceneEntityId: string | undefined;
        if (doWhat === "scene") {
          const needle = str(a, "scene_id");
          if (!needle) throw new ToolError('do_what="scene" needs scene_id.');
          const scene = findScene(before.scenes, needle);
          if (!scene) throw sceneNotFound(before.scenes, needle);
          sceneEntityId = scene.entityId;
        }
        const previous = id ? await api.scheduleConfig(id).catch(() => null) : null;
        const out = await api.saveSchedule({
          name,
          when,
          time,
          offset_minutes: num(a, "offset_minutes"),
          do_what: doWhat,
          scene_entity_id: sceneEntityId,
          id,
        });
        return { data: out, audit: { before: previous?.config ?? null, after: out } };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "set_schedule_enabled",
    title: "Pause or resume a schedule",
    description:
      "Turn a schedule on or off WITHOUT deleting it — the paused schedule keeps its trigger and its " +
      "action, and resuming restores it exactly. This is what someone means by 'stop the morning lights " +
      "for a while'; deleting is a different, irreversible request that goes through " +
      "propose_delete_schedule.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "the automation entity id, or its name" },
        enabled: { type: "boolean", description: "false pauses it" },
      },
      required: ["entity_id", "enabled"],
    },
    handler: async (a) => {
      const needle = requiredStr(a, "entity_id");
      const enabled = bool(a, "enabled");
      if (enabled === undefined) throw new ToolError("enabled must be true or false.");
      try {
        const before = await api.state();
        const n = needle.toLowerCase();
        const found =
          before.automations.find((s) => s.entityId.toLowerCase() === n) ??
          before.automations.find((s) => s.name.toLowerCase() === n);
        if (!found) {
          throw new ToolError(
            `No schedule matches "${needle}". Home Assistant has: ` +
              (before.automations.length
                ? before.automations.map((s) => `${s.name} (${s.entityId})`).join(", ")
                : "no automations at all") + ".",
          );
        }
        const out = await api.enableSchedule(found.entityId, enabled);
        return { data: out, audit: { before: { enabled: found.enabled }, after: { enabled } } };
      } catch (e) {
        rethrow(e);
      }
    },
  },

  // ------------------------------------------------------- device discovery
  {
    name: "list_zigbee_devices",
    title: "What is joined to the Zigbee mesh",
    description:
      "Every device Zigbee2MQTT knows, read from the broker's retained device list: IEEE address, " +
      "friendly name, vendor and model, whether the interview finished, and how it is powered.\n\n" +
      "This is a LAYER BELOW Home Assistant. A device can be joined here and still have no `light.*` " +
      "entity — usually because its interview never completed. When a bulb is missing from get_room but " +
      "present here, that is the diagnosis, and it is worth saying rather than reporting the bulb as " +
      "absent.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      if (!mqttConfigured()) {
        throw new ToolError(
          "MQTT_URL is not set on the connector, so the Zigbee mesh cannot be read. Home Assistant " +
            "still works — use get_room for the lights that are already set up.",
        );
      }
      try {
        const [devices, info] = await Promise.all([listDevices(), bridgeInfo().catch(() => ({}))]);
        const permit = (info as Record<string, unknown>).permit_join === true;
        return {
          data: {
            devices,
            device_count: devices.filter((d) => d.type !== "Coordinator").length,
            pairing_open: permit,
            zigbee2mqtt_version: (info as Record<string, unknown>).version ?? null,
            note:
              "The coordinator is listed too and is not a bulb. A device with " +
              "interview_completed:false has joined but is not usable yet.",
          },
        };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "start_pairing",
    title: "Open the mesh to new devices",
    description:
      "Put Zigbee2MQTT into pairing mode for a number of seconds, then tell the user to factory-reset " +
      "the bulb — for most bulbs that is power-cycling it a set number of times, or holding the " +
      "switch until it flashes.\n\n" +
      "Pairing is ASYNCHRONOUS. This call returns as soon as the mesh is open, long before anything " +
      "joins; a bulb typically announces itself somewhere between two and ninety seconds later. Do NOT " +
      "report a device as paired here — call poll_pairing afterwards and report what actually arrived.\n\n" +
      "Pass 0 to close pairing again. Leaving the mesh open indefinitely is a security matter: anything " +
      "in radio range can join.",
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        seconds: { type: "number", description: "how long to stay open, 0–600 (0 closes it). Default 120." },
      },
    },
    handler: async (a) => {
      if (!mqttConfigured()) {
        throw new ToolError("MQTT_URL is not set on the connector, so pairing cannot be started.");
      }
      const seconds = Math.max(0, Math.min(Math.round(num(a, "seconds") ?? 120), 600));
      try {
        const before = await listDevices().catch(() => []);
        const res = await permitJoin(seconds);
        return {
          data: {
            ok: true,
            open_for_seconds: seconds,
            since: new Date().toISOString(),
            known_devices_before: before.length,
            response: res,
            next:
              seconds > 0
                ? "Tell the user to factory-reset the bulb NOW, then call poll_pairing in ~20 seconds " +
                  "and again after that. Nothing has joined yet."
                : "Pairing is closed.",
          },
          audit: { before: { pairing_open: false }, after: { pairing_open: seconds > 0, seconds } },
        };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "poll_pairing",
    title: "What has joined since pairing opened",
    description:
      "Read the Zigbee2MQTT bridge events buffered since this connector started: `device_joined`, " +
      "`device_interview` (started / successful / failed) and `device_announce`.\n\n" +
      "A join is not finished until an interview is SUCCESSFUL. `device_joined` alone means the radio " +
      "handshake worked and Zigbee2MQTT does not yet know what the device is — reporting that as " +
      "'paired' is premature, and a failed interview afterwards is common. Wait for " +
      "`interview_successful`, then confirm with list_zigbee_devices and get_room.\n\n" +
      "Pass `since` (an ISO timestamp, e.g. what start_pairing returned) to see only what arrived " +
      "after that moment.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO timestamp; omit for everything buffered" },
      },
    },
    handler: async (a) => {
      if (!mqttConfigured()) {
        throw new ToolError("MQTT_URL is not set on the connector, so pairing events cannot be read.");
      }
      const since = str(a, "since");
      try {
        await ensureConnected();
        const events = recentEvents(since);
        const joined = events.filter((e) => e.type === "device_joined");
        const interviewed = events.filter(
          (e) => e.type === "device_interview" && e.data.status === "successful",
        );
        const failed = events.filter(
          (e) => e.type === "device_interview" && e.data.status === "failed",
        );
        const info = await bridgeInfo().catch(() => ({}));
        return {
          data: {
            pairing_open: (info as Record<string, unknown>).permit_join === true,
            events,
            joined: joined.map((e) => e.data),
            interview_successful: interviewed.map((e) => e.data),
            interview_failed: failed.map((e) => e.data),
            verdict:
              interviewed.length > 0
                ? "At least one device finished its interview. Name it with name_device, then check " +
                  "get_room for the new light entity."
                : joined.length > 0
                  ? "Something joined but has not finished its interview. Wait and poll again — do not " +
                    "call it paired yet."
                  : "Nothing has joined yet. If pairing is still open, wait and poll again; the buffer " +
                    "only holds what arrived since this connector last started.",
          },
        };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "name_device",
    title: "Name a newly paired device",
    description:
      "Give a Zigbee device a real name — in BOTH places it needs one.\n\n" +
      "Zigbee2MQTT runs here with `homeassistant_rename: false`, which means renaming a device in " +
      "Zigbee2MQTT does NOT rename the Home Assistant entity. Renaming in one place only leaves the " +
      "mesh calling it 'Shelf lamp' and Home Assistant still calling it '0x00124b0022...'. Doing both " +
      "in one step is the entire point of this tool.\n\n" +
      "NAME BY PHYSICAL POSITION, not by number. 'shelf lamp', 'floor lamp', 'abajour', 'tv lamp' — " +
      "`light.lamp_3` is unreadable a month later, and every scene in the system references these " +
      "names. Ask where the lamp actually is before naming it.\n\n" +
      "The entity id itself is never changed: scenes, automations and Siri shortcuts all reference it, " +
      "and moving it breaks them silently. Only the friendly name changes.\n\n" +
      "THIS CAN HALF-SUCCEED, AND YOU MUST SAY SO. The Zigbee2MQTT rename happens first; the Home " +
      "Assistant rename can still fail after it (no admin token, no entity matched, the registry " +
      "unreachable). Check `fully_renamed` in the result: when it is false, the two systems now " +
      "disagree about this device's name, and the result says which half landed and what to do about " +
      "it. Reporting a half-done rename as done leaves someone hunting for a lamp that shows up under " +
      "two different names.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        ieee_address: { type: "string", description: "the device's IEEE address, from list_zigbee_devices" },
        friendly_name: { type: "string", description: "the new name, by physical position" },
        entity_id: {
          type: "string",
          description:
            "the Home Assistant entity to rename alongside it. Omit and the connector matches it by " +
            "IEEE address; pass it explicitly when the match is ambiguous.",
        },
      },
      required: ["ieee_address", "friendly_name"],
    },
    handler: async (a) => {
      const ieee = requiredStr(a, "ieee_address");
      const friendly = requiredStr(a, "friendly_name");
      const explicitEntity = str(a, "entity_id");
      if (!mqttConfigured()) {
        throw new ToolError("MQTT_URL is not set on the connector, so the Zigbee rename cannot be done.");
      }

      try {
        const devices = await listDevices();
        const device = devices.find(
          (d) => d.ieee_address.toLowerCase() === ieee.toLowerCase() ||
                 d.friendly_name.toLowerCase() === ieee.toLowerCase(),
        );
        if (!device) {
          throw new ToolError(
            `No Zigbee device with address "${ieee}". Known: ` +
              devices.map((d) => `${d.friendly_name} (${d.ieee_address})`).join(", ") + ".",
          );
        }

        // Step one: Zigbee2MQTT. If this fails nothing has changed anywhere.
        const z2m = await renameDevice(device.friendly_name, friendly);

        // Step two: Home Assistant's entity registry. Reported separately and
        // honestly — a half-done rename that claims to be done is worse than
        // one that says which half landed.
        let haResult: { renamed: boolean; entity_id: string | null; error?: string };
        if (!haConfigured()) {
          haResult = {
            renamed: false,
            entity_id: null,
            error:
              "HA_BASE_URL / HA_TOKEN are not set on the connector, so the Home Assistant entity was " +
              "NOT renamed. Zigbee2MQTT now calls it \"" + friendly + "\" but Home Assistant does not. " +
              "Rename it in Home Assistant, or set those variables and run this again.",
          };
        } else {
          try {
            const registry = await entityRegistryList();
            const entityId =
              explicitEntity ??
              registry.find((r) => (r.unique_id ?? "").toLowerCase().includes(device.ieee_address.toLowerCase()))
                ?.entity_id ??
              registry.find(
                (r) => r.platform === "mqtt" &&
                  (r.original_name ?? "").toLowerCase() === device.friendly_name.toLowerCase(),
              )?.entity_id ??
              null;
            if (!entityId) {
              haResult = {
                renamed: false,
                entity_id: null,
                error:
                  "Renamed in Zigbee2MQTT, but no Home Assistant entity could be matched to this device. " +
                  "Pass entity_id explicitly (find it with get_room) and run this again.",
              };
            } else {
              await renameEntity(entityId, friendly);
              haResult = { renamed: true, entity_id: entityId };
            }
          } catch (e) {
            haResult = {
              renamed: false,
              entity_id: explicitEntity ?? null,
              error:
                `Renamed in Zigbee2MQTT, but the Home Assistant rename failed: ${(e as Error).message} ` +
                `The two systems now disagree about this device's name — say so.`,
            };
          }
        }

        return {
          data: {
            ieee_address: device.ieee_address,
            zigbee2mqtt: { renamed: true, from: device.friendly_name, to: friendly, response: z2m },
            home_assistant: haResult,
            fully_renamed: haResult.renamed,
            summary: haResult.renamed
              ? `Renamed in both Zigbee2MQTT and Home Assistant.`
              : `Renamed in Zigbee2MQTT ONLY. ${haResult.error}`,
          },
          audit: {
            before: { friendly_name: device.friendly_name },
            after: { friendly_name: friendly, ha_entity: haResult.entity_id, ha_renamed: haResult.renamed },
          },
        };
      } catch (e) {
        rethrow(e);
      }
    },
  },

  // ------------------------------------------------------- propose → commit
  {
    name: "propose_overwrite_scene",
    title: "Propose replacing a scene's definition",
    description:
      "Describe what would happen if an existing scene were re-saved from the room as it is now, and " +
      "return a token. NOTHING CHANGES until commit_change is called with that token.\n\n" +
      "Show the user the diff — what the scene stores today, what it would store instead — and get an " +
      "explicit yes before committing. Overwriting destroys the old definition and there is no undo: " +
      "the previous brightness and colour for every lamp are simply gone.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { scene_id: { type: "string", description: "the scene to overwrite: entity id, label or alias" } },
      required: ["scene_id"],
    },
    handler: async (a) => {
      const needle = requiredStr(a, "scene_id");
      try {
        const state = await api.state();
        const scene = findScene(state.scenes, needle);
        if (!scene) throw sceneNotFound(state.scenes, needle);
        if (!scene.id) {
          throw new ToolError(
            `"${scene.label}" has no Home Assistant config id — it was written by hand in scenes.yaml ` +
              `without an \`id:\`, so it cannot be edited over the API at all. It has to be changed in ` +
              `Home Assistant itself.`,
          );
        }
        const current = await api.sceneConfig(scene.id);
        const diff = describeSceneDiff(current.config?.entities ?? {}, state.lamps);
        const { token, expiresAt } = await createProposal(
          "overwrite_scene",
          { scene_entity_id: scene.entityId, scene_config_id: scene.id, name: scene.name },
          diff,
        );
        return {
          data: {
            change_token: token,
            expires_at: new Date(expiresAt).toISOString(),
            scene: scene.label,
            diff,
            note:
              "Nothing has changed yet. Show this diff to the user, get an explicit yes, then call " +
              "commit_change with the token. If they say no, just drop it — the proposal expires on its own.",
          },
        };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "propose_delete_scene",
    title: "Propose deleting a scene",
    description:
      "Describe what deleting a scene would remove, and return a token. NOTHING IS DELETED until " +
      "commit_change is called with that token.\n\n" +
      "Deleting removes the entry from scenes.yaml AND unregisters the entity, so any schedule pointing " +
      "at it stops working — the diff names those. There is no undo.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { scene_id: { type: "string", description: "the scene to delete: entity id, label or alias" } },
      required: ["scene_id"],
    },
    handler: async (a) => {
      const needle = requiredStr(a, "scene_id");
      try {
        const state = await api.state();
        const scene = findScene(state.scenes, needle);
        if (!scene) throw sceneNotFound(state.scenes, needle);
        if (!scene.id) {
          throw new ToolError(
            `"${scene.label}" has no Home Assistant config id, so it cannot be deleted over the API. ` +
              `Hand-written scenes have to be removed from scenes.yaml in Home Assistant.`,
          );
        }
        const current = await api.sceneConfig(scene.id);
        const entities = Object.keys(current.config?.entities ?? {});

        // Which schedules would break. Worth the extra reads: a schedule left
        // pointing at a deleted scene fails silently at 6pm every day.
        const dependents: string[] = [];
        for (const s of state.automations) {
          if (!s.id) continue;
          try {
            const { config } = await api.scheduleConfig(s.id);
            if (config && JSON.stringify(config).includes(scene.entityId)) dependents.push(s.name);
          } catch {
            /* a schedule we cannot read is not evidence of a dependency */
          }
        }

        const diff =
          `DELETE the scene "${scene.label}" (${scene.entityId}).\n` +
          `  It currently sets ${entities.length} lamp${entities.length === 1 ? "" : "s"}: ${entities.join(", ") || "nothing"}.\n` +
          `  It has been tapped ${scene.tapCount} time${scene.tapCount === 1 ? "" : "s"}.\n` +
          (dependents.length
            ? `  ⚠ These schedules apply it and will stop working: ${dependents.join(", ")}.\n`
            : "  No schedule refers to it.\n") +
          `  This cannot be undone.`;

        const { token, expiresAt } = await createProposal(
          "delete_scene",
          { scene_entity_id: scene.entityId, scene_config_id: scene.id, name: scene.label },
          diff,
        );
        return {
          data: {
            change_token: token,
            expires_at: new Date(expiresAt).toISOString(),
            diff,
            breaks_schedules: dependents,
            note: "Nothing has been deleted. Show this to the user and only commit on an explicit yes.",
          },
        };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "propose_delete_schedule",
    title: "Propose deleting a schedule",
    description:
      "Describe what deleting a schedule would remove, and return a token. NOTHING IS DELETED until " +
      "commit_change is called with that token.\n\n" +
      "Check first whether the user actually wants it PAUSED. 'Stop the morning lights for a while' is " +
      "set_schedule_enabled(false), which is reversible; deleting throws away the trigger and the " +
      "action and cannot be undone.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { schedule_id: { type: "string", description: "the automation entity id or its name" } },
      required: ["schedule_id"],
    },
    handler: async (a) => {
      const needle = requiredStr(a, "schedule_id");
      try {
        const state = await api.state();
        const n = needle.toLowerCase();
        const found =
          state.automations.find((s) => s.entityId.toLowerCase() === n) ??
          state.automations.find((s) => s.name.toLowerCase() === n) ??
          state.automations.find((s) => (s.id ?? "").toLowerCase() === n);
        if (!found) {
          throw new ToolError(
            `No schedule matches "${needle}". Home Assistant has: ` +
              (state.automations.length
                ? state.automations.map((s) => `${s.name} (${s.entityId})`).join(", ")
                : "no automations at all") + ".",
          );
        }
        if (!found.id) {
          throw new ToolError(
            `"${found.name}" has no Home Assistant config id, so it cannot be deleted over the API.`,
          );
        }
        const { config } = await api.scheduleConfig(found.id);
        const diff =
          `DELETE the schedule "${found.name}" (${found.entityId}).\n` +
          `  Currently ${found.enabled ? "ENABLED" : "paused"}${found.lastTriggered ? `, last fired ${found.lastTriggered}` : ", never fired"}.\n` +
          `  Stored configuration: ${JSON.stringify(config ?? {}, null, 2)}\n` +
          `  This cannot be undone. If the intent is only to stop it firing, use ` +
          `set_schedule_enabled(enabled: false) instead — that keeps the configuration.`;

        const { token, expiresAt } = await createProposal(
          "delete_schedule",
          { automation_config_id: found.id, entity_id: found.entityId, name: found.name },
          diff,
        );
        return {
          data: {
            change_token: token,
            expires_at: new Date(expiresAt).toISOString(),
            diff,
            note: "Nothing has been deleted. Offer pausing as the reversible alternative before committing.",
          },
        };
      } catch (e) {
        rethrow(e);
      }
    },
  },
  {
    name: "commit_change",
    title: "Apply a proposed change",
    description:
      "Apply the change a propose_* tool described, using the token it returned.\n\n" +
      "ONLY CALL THIS AFTER THE USER HAS SEEN THE DIFF AND SAID YES. The token is single-use and " +
      "expires in ten minutes; if it has expired, propose again so the user sees a diff against what is " +
      "true now rather than against what was true then. Committing a token the user never approved " +
      "defeats the entire mechanism.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "the change_token from a propose_* call" },
      },
      required: ["token"],
    },
    handler: async (a) => {
      const token = requiredStr(a, "token");
      let proposal;
      try {
        proposal = await consumeProposal(token);
      } catch (e) {
        rethrow(e);
      }
      const args = proposal.args as Record<string, string>;
      try {
        switch (proposal.tool) {
          case "overwrite_scene": {
            const out = await api.saveScene(args.name, args.scene_config_id);
            return {
              data: {
                ...out,
                change: "overwrite_scene",
                note:
                  out.skipped.length
                    ? `${out.skipped.join(", ")} had no power and could not be captured, so the scene no ` +
                      `longer controls ${out.skipped.length === 1 ? "it" : "them"}. Mention this.`
                    : "Every reachable lamp was captured.",
              },
              audit: { before: proposal.diff, after: out },
            };
          }
          case "delete_scene": {
            const out = await api.deleteScene(args.scene_config_id);
            return {
              data: { ...out, change: "delete_scene", deleted_name: args.name },
              audit: { before: proposal.diff, after: out },
            };
          }
          case "delete_schedule": {
            const out = await api.deleteSchedule(args.automation_config_id);
            return {
              data: { ...out, change: "delete_schedule", deleted_name: args.name },
              audit: { before: proposal.diff, after: out },
            };
          }
          default:
            throw new ToolError(`That token names an unknown change type (${proposal.tool}).`);
        }
      } catch (e) {
        rethrow(e);
      }
    },
  },
];

/** A human-readable before/after for overwriting a scene. */
function describeSceneDiff(current: Record<string, unknown>, lamps: Lamp[]): string {
  const lines: string[] = ["REPLACE the scene's stored definition with the room as it is now.", ""];
  const ids = new Set([...Object.keys(current), ...lamps.map((l) => l.entityId)]);
  for (const id of [...ids].sort()) {
    const lamp = lamps.find((l) => l.entityId === id);
    const was = current[id];
    const wasText = was === undefined ? "(not in the scene)" : describeStored(was);
    let willText: string;
    if (!lamp) willText = "(no such lamp any more — it will be dropped)";
    else if (!lamp.reachable) willText = "UNREACHABLE — cannot be captured, will be dropped from the scene";
    else if (!lamp.on) willText = "off";
    else {
      const bits = ["on", `${lamp.brightness ?? 100}%`];
      if (lamp.colorMode === "color_temp" && lamp.kelvin) bits.push(`${lamp.kelvin}K`);
      else if (lamp.hs) bits.push(`hue ${Math.round(lamp.hs[0])}`);
      willText = bits.join(" · ");
    }
    lines.push(`  ${lamp?.name ?? id}: ${wasText}  →  ${willText}`);
  }
  lines.push("", "The previous definition cannot be recovered.");
  return lines.join("\n");
}

function describeStored(value: unknown): string {
  if (!value || typeof value !== "object") return String(value);
  const v = value as Record<string, unknown>;
  if (v.state === "off") return "off";
  const bits = ["on"];
  if (typeof v.brightness === "number") bits.push(`${Math.round((v.brightness / 255) * 100)}%`);
  if (typeof v.color_temp_kelvin === "number") bits.push(`${v.color_temp_kelvin}K`);
  if (Array.isArray(v.hs_color)) bits.push(`hue ${(v.hs_color as number[])[0]}`);
  return bits.join(" · ");
}

// ------------------------------------------------------------------ registry

/** Stable order: the list is part of the prompt, and a list that reshuffles
 *  between calls costs cache hits for nothing. */
export const TOOL_DEFS = TOOLS.map((t) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.inputSchema,
  ...(t.annotations ? { annotations: t.annotations } : {}),
}));

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function hasTool(name: string): boolean {
  return BY_NAME.has(name);
}

export function isReadOnly(name: string): boolean | null {
  return BY_NAME.get(name)?.annotations?.readOnlyHint ?? null;
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const t = BY_NAME.get(name);
  if (!t) throw new ToolError(`Unknown tool: ${name}`);
  return t.handler(args);
}
