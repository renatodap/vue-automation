import "server-only";
import { getStates } from "./ha";
import { buildInsights } from "./insights";
import { HistoryQueryError, parseHistoryQuery, parseInsightsQuery } from "./history-params";
import { HistoryTooLargeError, HistoryUnavailableError, queryHistory, queryInsights, type HistoryKind } from "./history-query";
import type { HistoryFailure } from "./history-types";

const headers = { "Cache-Control": "no-store, max-age=0" };
export function historyError(error: unknown): Response {
  let payload: HistoryFailure;
  let status: number;
  if (error instanceof HistoryQueryError) {
    payload = { ok: false, reason: "invalid_query", message: error.message }; status = 400;
  } else if (error instanceof HistoryTooLargeError) {
    payload = { ok: false, reason: "history_too_large", message: error.message }; status = 422;
  } else {
    payload = { ok: false, reason: "history_unavailable", message: error instanceof HistoryUnavailableError ? error.message : "History is unavailable right now. Live light controls still work independently." }; status = 503;
  }
  return Response.json(payload, { status, headers });
}
export async function historyResponse(req: Request, kind: HistoryKind): Promise<Response> {
  try {
    const query = parseHistoryQuery(new URL(req.url).searchParams);
    if (query.transitionsOnly && kind !== "lamps") throw new HistoryQueryError("transitions_only applies only to lamp history.");
    if (query.entityId && (kind === "lamps" ? !query.entityId.startsWith("light.") : kind === "scenes" ? !query.entityId.startsWith("scene.") : !/^(sensor|climate)\./.test(query.entityId))) throw new HistoryQueryError(`entity_id does not identify a ${kind === "lamps" ? "light" : kind === "scenes" ? "scene" : "climate or sensor"} entity.`);
    return Response.json(await queryHistory(kind, query), { headers });
  } catch (error) { return historyError(error); }
}
export async function insightsResponse(req: Request): Promise<Response> {
  try {
    const { start, end, room } = parseInsightsQuery(new URL(req.url).searchParams);
    const input = await queryInsights(start, end, room);
    // A successful request now is a live observation even if last_changed is old.
    // HA state is never substituted from the history database when this fails.
    const live = await getStates().then((states) => ({ states, checkedAt: new Date().toISOString() })).catch(() => null);
    return Response.json(buildInsights(input, live, new Date()), { headers });
  } catch (error) { return historyError(error); }
}
