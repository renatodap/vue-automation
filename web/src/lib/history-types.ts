import type { RoomId } from "./rooms";

/** Historical observations only. None of these rows describes current state. */
export type HistorySource = "user" | "automation" | "scene" | "unknown";
export type HistoryEntity = {
  entityId: string;
  kind: "light" | "temperature" | "humidity" | "climate" | "scene";
  name: string;
  room: RoomId;
  unit: string | null;
};
export type HistoryFailure = {
  ok: false;
  reason: "history_unavailable" | "invalid_query" | "history_too_large";
  message: string;
};
export type HistorySync = {
  status: "pending" | "current" | "delayed" | "error";
  lastSuccessAt: string | null;
  cursorAt: string | null;
  lagSeconds: number | null;
};
export type HistoryCoverage = {
  firstAt: string | null;
  lastAt: string | null;
  /** Recorder's known earliest available time, not an inferred sensor reading. */
  recorderStartAt: string | null;
  retentionDays: number | null;
  /** Events cannot establish continuous sensor coverage. */
  complete: false;
  gaps: { start: string; end: string | null; reason: string }[];
};
export type HistoryMeta = {
  start: string;
  end: string;
  timeZone: string;
  generatedAt: string;
  sync: HistorySync;
  coverage: HistoryCoverage;
};
type EventContext = {
  source: HistorySource;
  contextId: string | null;
  contextParentId: string | null;
  contextUserId: string | null;
};
export type LampHistoryEvent = EventContext & {
  entityId: string;
  at: string;
  state: string;
  /** Home Assistant's raw 0–255 brightness. Null means absent, not zero. */
  brightness: number | null;
  kelvin: number | null;
  hs: [number, number] | null;
  xy: [number, number] | null;
  sceneId: string | null;
};
export type ClimateHistoryEvent = EventContext & {
  entityId: string;
  at: string;
  state: string;
  temperatureC: number | null;
  humidity: number | null;
  targetTemperatureC: number | null;
  targetTemperatureLowC: number | null;
  targetTemperatureHighC: number | null;
};
export type SceneHistoryEvent = EventContext & {
  entityId: string;
  at: string;
  roomIds: RoomId[];
  origin: "recorder" | "app" | "legacy_tap";
};
export type HistoryPage<T> = HistoryMeta & {
  ok: true;
  entities: HistoryEntity[];
  rows: T[];
  nextCursor: string | null;
  availability: "available" | "no_entities" | "no_history" | "no_sensors";
};
export type LampHistoryResponse = HistoryPage<LampHistoryEvent> | HistoryFailure;
export type ClimateHistoryResponse = HistoryPage<ClimateHistoryEvent> | HistoryFailure;
export type SceneHistoryResponse = HistoryPage<SceneHistoryEvent> | HistoryFailure;

export type Confidence = "insufficient" | "low" | "medium" | "high";
export type TypicalTime = {
  /** Local wall-clock minute, 0–1439; null when fewer than 3 dates support it. */
  minute: number | null;
  sampleCount: number;
  /** Count of distinct dates, never count of brightness updates. */
  observedDays: number;
  confidence: Confidence;
};
export type UsagePattern = {
  scope: "lamp" | "room";
  entityId: string | null;
  room: RoomId;
  name: string;
  /** Sunday=0, Saturday=6, in timeZone. */
  weekday: number;
  on: TypicalTime;
  off: TypicalTime;
};
export type SceneRanking = {
  entityId: string;
  name: string;
  roomIds: RoomId[];
  period: "night" | "morning" | "afternoon" | "evening";
  count: number;
  observedDays: number;
  confidence: Confidence;
};
export type ClimateProfile = {
  entityId: string;
  name: string;
  room: RoomId;
  hour: number;
  metric: "temperatureC" | "humidity";
  mean: number;
  low: number;
  high: number;
  sampleCount: number;
  observedDays: number;
  confidence: Confidence;
};
export type HistoryAnomaly = {
  kind: "usually_off_by_now" | "temperature_outside_usual" | "humidity_outside_usual";
  entityId: string;
  name: string;
  room: RoomId;
  message: string;
  checkedAt: string;
  confidence: Confidence;
  sampleCount: number;
};
export type SceneSuggestion = {
  entityId: string;
  name: string;
  roomIds: RoomId[];
  reason: string;
  confidence: Confidence;
  sampleCount: number;
};
export type InsightsResponse = (HistoryMeta & {
  ok: true;
  entities: HistoryEntity[];
  patterns: UsagePattern[];
  scenes: SceneRanking[];
  climate: ClimateProfile[];
  anomalies: HistoryAnomaly[];
  suggestions: SceneSuggestion[];
  liveAvailable: boolean;
  checkedAt: string | null;
  climateAvailability: "available" | "no_sensors" | "no_history";
}) | HistoryFailure;
