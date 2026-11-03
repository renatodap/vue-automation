/** Pure normalization shared by REST backfill and the server-side event worker. */
export type RecordedState = {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated?: string;
  context?: { id?: string | null; parent_id?: string | null; user_id?: string | null };
};
export type HistoryKind = 'light' | 'temperature' | 'humidity' | 'climate' | 'scene';
export function historyKind(s: Pick<RecordedState, 'entity_id' | 'attributes'>): HistoryKind | null {
  if (s.entity_id.startsWith('light.')) return 'light';
  if (s.entity_id.startsWith('scene.')) return 'scene';
  if (s.entity_id.startsWith('climate.')) return 'climate';
  const deviceClass = s.attributes.device_class;
  if (s.entity_id.startsWith('sensor.') && (deviceClass === 'temperature' || deviceClass === 'humidity')) return deviceClass;
  return null;
}
export function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function celsius(value: unknown, unit: unknown): number | null {
  const n = finite(value);
  if (n === null) return null;
  if (unit === '°C' || unit === 'C') return n;
  if (unit === '°F' || unit === 'F') return (n - 32) * 5 / 9;
  if (unit === 'K') return n - 273.15;
  return null; // Unknown units are not Celsius by assumption.
}
const pair = (v: unknown): [number, number] | null =>
  Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1]] : null;
export function normalizeHistory(s: RecordedState, kind: HistoryKind, temperatureUnit: string) {
  const at = s.last_updated || s.last_changed;
  if (!at || !Number.isFinite(Date.parse(at))) throw new Error('Invalid HA observation timestamp');
  const context = s.context;
  // A parent alone is not proof of automation. Keep unsupported attribution unknown.
  const source = context?.user_id ? 'user' : 'unknown';
  const base = {
    entity_id: s.entity_id, at, state: s.state,
    source, context_id: context?.id ?? null,
    context_parent_id: context?.parent_id ?? null, context_user_id: context?.user_id ?? null,
    attributes: s.attributes,
  };
  const a = s.attributes;
  if (kind === 'light') return {
    kind, row: { ...base, brightness: finite(a.brightness),
      color_temp_kelvin: finite(a.color_temp_kelvin) ?? (finite(a.color_temp) ? 1_000_000 / Number(a.color_temp) : null),
      hs_color: pair(a.hs_color), xy_color: pair(a.xy_color), scene_id: null,
    },
  } as const;
  if (kind === 'scene') {
    // A scene's state is its activation time, not on/off. Reloads can emit the
    // same activation at a new last_updated; the activation key deduplicates it.
    if (!/^\d{4}-\d{2}-\d{2}T/.test(s.state) || !Number.isFinite(Date.parse(s.state))) return null;
    const activationContext = Math.abs(Date.parse(at) - Date.parse(s.state)) < 1000;
    return { kind, row: { ...base, at: s.state,
      ...(activationContext ? {} : {source:'unknown',context_id:null,context_parent_id:null,context_user_id:null}),
    } } as const;
  }
  const available = s.state !== 'unknown' && s.state !== 'unavailable';
  const unit = a.unit_of_measurement ?? (kind === 'climate' ? temperatureUnit : null);
  const humidity = available ? finite(kind === 'humidity' ? s.state : a.current_humidity) : null;
  return { kind, row: {
    ...base,
    temperature_c: available ? celsius(kind === 'temperature' ? s.state : a.current_temperature, unit) : null,
    humidity: humidity !== null && humidity >= 0 && humidity <= 100 ? humidity : null,
    target_temperature_c: available && kind === 'climate' ? celsius(a.temperature, unit) : null,
    target_temperature_low_c: available && kind === 'climate' ? celsius(a.target_temp_low, unit) : null,
    target_temperature_high_c: available && kind === 'climate' ? celsius(a.target_temp_high, unit) : null,
  } } as const;
}
