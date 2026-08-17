import "server-only";
import { getSceneConfig as readSceneConfig } from "@/lib/ha";
import { haBaseUrl, haToken } from "@/lib/env";

/**
 * Reading back what an automation actually stores, and the connector's more
 * forgiving view of the same for scenes.
 *
 * The scene GET moved to `lib/ha.ts` when the scene editor was added — the PWA
 * needs it now too, and two copies of one endpoint drift. What stays here is
 * the connector's ERROR CONTRACT, which is genuinely different: every failure
 * collapses to null, because a diff that cannot be read is a diff the connector
 * declines to show, whereas the editor has a person in front of it who is owed
 * the reason.
 */

const TIMEOUT_MS = 8_000;

async function haGet<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${haBaseUrl()}${path}`, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${haToken()}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });
    // 404 is the ordinary answer for a hand-written YAML scene with no `id:`,
    // which can never be read or edited over this API. Null, not an error.
    if (!res.ok) return null;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type StoredScene = {
  id?: string;
  name?: string;
  entities?: Record<string, unknown>;
};

/**
 * The stored definition of a scene, or null when HA has none under that id.
 *
 * 404 is the ordinary answer for a hand-written YAML scene with no `id:`, which
 * can never be read or edited over this API — null, not an error.
 */
export async function getSceneConfig(id: string): Promise<StoredScene | null> {
  try {
    return await readSceneConfig(id);
  } catch {
    return null;
  }
}

/** The stored definition of an automation, or null. */
export function getAutomationConfig(id: string): Promise<Record<string, unknown> | null> {
  return haGet<Record<string, unknown>>(`/api/config/automation/config/${encodeURIComponent(id)}`);
}
