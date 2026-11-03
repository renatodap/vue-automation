import test from 'node:test';
import assert from 'node:assert/strict';
import { celsius, historyKind, normalizeHistory, type RecordedState } from '../src/lib/history-normalize';

function state(overrides: Partial<RecordedState> = {}): RecordedState {
  return {
    entity_id: 'light.shelf_lamp', state: 'on', attributes: {},
    last_changed: '2026-10-01T18:00:00.000000Z',
    last_updated: '2026-10-01T18:04:00.123456Z', ...overrides,
  };
}

test('attribute-only lamp changes use last_updated without losing microseconds', () => {
  const result = normalizeHistory(state({ attributes: { brightness: 128, color_temp: 400, hs_color: [20, 60], xy_color: [0.4, 0.3] } }), 'light', '°C');
  assert.equal(result?.kind, 'light');
  if (result?.kind !== 'light') throw new Error('expected lamp');
  assert.equal(result.row.at, '2026-10-01T18:04:00.123456Z');
  assert.equal(result.row.brightness, 128);
  assert.equal(result.row.color_temp_kelvin, 2500);
  assert.deepEqual(result.row.hs_color, [20, 60]);
  assert.deepEqual(result.row.xy_color, [0.4, 0.3]);
});

test('Celsius, Fahrenheit and Kelvin convert explicitly; unknown units remain unknown', () => {
  assert.equal(celsius('20', '°C'), 20);
  assert.equal(celsius('68', '°F'), 20);
  assert.equal(celsius(293.15, 'K'), 20);
  for (const [value, unit] of [[20, undefined], [20, 'degrees'], ['unavailable', '°C'], [null, '°C'], [true, '°C'], ['', '°C']]) {
    assert.equal(celsius(value, unit), null);
  }
});

test('sensor units override the household temperature unit', () => {
  const result = normalizeHistory(state({ entity_id: 'sensor.temperature', state: '68', attributes: { device_class: 'temperature', unit_of_measurement: '°F' } }), 'temperature', '°C');
  assert.ok(result && 'temperature_c' in result.row);
  assert.equal(result.row.temperature_c, 20);
});

test('climate current and target temperatures use the discovered HA unit', () => {
  const result = normalizeHistory(state({
    entity_id: 'climate.living_room', state: 'heat',
    attributes: { current_temperature: 68, temperature: 71.6, target_temp_low: 64.4, target_temp_high: 75.2, current_humidity: 45 },
  }), 'climate', '°F');
  assert.ok(result && 'temperature_c' in result.row);
  assert.equal(result.row.temperature_c, 20);
  assert.ok(Math.abs((result.row.target_temperature_c ?? 0) - 22) < 1e-10);
  assert.ok(Math.abs((result.row.target_temperature_low_c ?? 0) - 18) < 1e-10);
  assert.ok(Math.abs((result.row.target_temperature_high_c ?? 0) - 24) < 1e-10);
  assert.equal(result.row.humidity, 45);
});

test('unknown and unavailable climate states cannot reuse stale numeric attributes', () => {
  for (const unavailable of ['unknown', 'unavailable']) {
    const result = normalizeHistory(state({ entity_id: 'climate.living_room', state: unavailable, attributes: { current_temperature: 22, current_humidity: 45, temperature: 23 } }), 'climate', '°C');
    assert.ok(result && 'temperature_c' in result.row);
    assert.equal(result.row.state, unavailable);
    assert.equal(result.row.temperature_c, null);
    assert.equal(result.row.humidity, null);
    assert.equal(result.row.target_temperature_c, null);
    assert.equal(result.row.attributes.current_temperature, 22, 'raw evidence remains preserved');
  }
});

test('humidity is validated without turning absent or invalid values into zero', () => {
  for (const [value, expected] of [['45.5', 45.5], ['0', 0], ['100', 100], ['101', null], ['-1', null], ['unknown', null]]) {
    const result = normalizeHistory(state({ entity_id: 'sensor.humidity', state: String(value), attributes: { device_class: 'humidity', unit_of_measurement: '%' } }), 'humidity', '°C');
    assert.ok(result && 'humidity' in result.row);
    assert.equal(result.row.humidity, expected);
  }
});

test('source attribution requires evidence; a context parent alone is not automation', () => {
  const parentOnly = normalizeHistory(state({ context: { id: 'event', parent_id: 'parent' } }), 'light', '°C');
  assert.equal(parentOnly?.row.source, 'unknown');
  assert.equal(parentOnly?.row.context_parent_id, 'parent');
  const user = normalizeHistory(state({ context: { id: 'event', user_id: 'ha-user' } }), 'light', '°C');
  assert.equal(user?.row.source, 'user');
  const missing = normalizeHistory(state(), 'light', '°C');
  assert.equal(missing?.row.source, 'unknown');
  assert.equal(missing?.row.context_id, null);
});

test('scene reloads retain the activation key instead of creating a new application', () => {
  const activation = '2026-10-01T18:00:00.654321Z';
  const first = normalizeHistory(state({ entity_id: 'scene.movie', state: activation, last_updated: activation }), 'scene', '°C');
  const reloaded = normalizeHistory(state({ entity_id: 'scene.movie', state: activation, last_updated: '2026-10-02T12:00:00Z' }), 'scene', '°C');
  assert.equal(first?.row.at, activation);
  assert.equal(reloaded?.row.at, activation);
  for (const value of ['unknown', 'unavailable', 'off']) {
    assert.equal(normalizeHistory(state({ entity_id: 'scene.movie', state: value }), 'scene', '°C'), null);
  }
});

test('unrelated sensors are not invented as climate observations', () => {
  assert.equal(historyKind(state({ entity_id: 'sensor.battery', attributes: { device_class: 'battery' } })), null);
  assert.equal(historyKind(state({ entity_id: 'sensor.bedroom_temperature', attributes: {} })), null);
  assert.equal(historyKind(state({ entity_id: 'sensor.temperature', attributes: { device_class: 'temperature' } })), 'temperature');
  assert.equal(historyKind(state({ entity_id: 'climate.living_room' })), 'climate');
});

test('an invalid observation timestamp is rejected rather than silently skipped', () => {
  assert.throws(() => normalizeHistory(state({ last_updated: 'invalid' }), 'light', '°C'), /timestamp/);
});
