import 'server-only';
import { haBaseUrl, haToken } from './env';
import type { RecordedState } from './history-normalize';

export async function historyGet<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${haBaseUrl()}${path}`, {
      headers: { Authorization: `Bearer ${haToken()}` }, cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
    });
  } catch { throw new Error('History could not reach Home Assistant'); }
  if (!response.ok) throw new Error(`Home Assistant history returned HTTP ${response.status}`);
  return await response.json() as T;
}

/** A short-lived, read-only registry request. Never accepts a service name. */
export async function historyRegistry(type: 'config/entity_registry/list' | 'config/device_registry/list' | 'config/area_registry/list'): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(haBaseUrl().replace(/^http/, 'ws') + '/api/websocket');
    let settled = false;
    const finish = (error?: Error, result?: Record<string, unknown>[]) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.close();
      if (error) reject(error); else resolve(result ?? []);
    };
    const timer = setTimeout(() => finish(new Error('HA registry timed out')), 10_000);
    socket.addEventListener('error', () => finish(new Error('HA registry connection failed')));
    socket.addEventListener('close', () => finish(new Error('HA registry disconnected')));
    socket.addEventListener('message', event => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: haToken() }));
      if (msg.type === 'auth_invalid') finish(new Error('HA rejected history credentials'));
      if (msg.type === 'auth_ok') socket.send(JSON.stringify({ id: 1, type }));
      if (msg.type === 'result') finish(msg.success ? undefined : new Error('HA registry request failed'), msg.result);
    });
  });
}

/** Explicitly requests attribute-only changes and suppresses fabricated start states. */
export async function recorderPeriod(ids: string[], start: string, end: string, minimal = false): Promise<RecordedState[]> {
  const all: RecordedState[] = [];
  for (let i = 0; i < ids.length; i += 40) {
    const params = new URLSearchParams({ filter_entity_id: ids.slice(i, i + 40).join(','),
      end_time: end, significant_changes_only: '0', skip_initial_state: '' });
    if (minimal) params.set('minimal_response', '');
    const groups = await historyGet<RecordedState[][]>(`/api/history/period/${encodeURIComponent(start)}?${params}`);
    if (!Array.isArray(groups) || groups.some(g => !Array.isArray(g))) throw new Error('Invalid HA history response');
    for (const group of groups) {
      // Minimal rows omit entity_id and attributes; used ONLY to find the floor.
      const entityId = group[0]?.entity_id;
      for (const row of group) all.push({ ...row, entity_id: row.entity_id || entityId });
    }
  }
  return all;
}
