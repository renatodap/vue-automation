import "server-only";
import { haBaseUrl, haToken } from "@/lib/env";

/**
 * Reading back what a scene or an automation actually stores.
 *
 * `lib/ha.ts` can already WRITE both of these (`saveScene`, `saveAutomation`)
 * and delete them; what it has never needed is the GET, because the PWA renders
 * from entity state and never opens a stored config. The connector does need
 * it: naming the lamps a scene failed to reach means knowing which lamps the
 * scene was aiming at, and showing a diff before a destructive change means
 * knowing what is about to be lost.
 *
 * Colocated with the internal routes rather than added to `lib/ha.ts` so the
 * PWA's own client keeps exactly the surface it uses.
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

/** The stored definition of a scene, or null when HA has none under that id. */
export function getSceneConfig(id: string): Promise<StoredScene | null> {
  return haGet<StoredScene>(`/api/config/scene/config/${encodeURIComponent(id)}`);
}

/** The stored definition of an automation, or null. */
export function getAutomationConfig(id: string): Promise<Record<string, unknown> | null> {
  return haGet<Record<string, unknown>>(`/api/config/automation/config/${encodeURIComponent(id)}`);
}
