export const MODULE_ID = "fbl-need-for-speed";
export const SOCKET = `module.${MODULE_ID}`;
export const VERSION = "0.16.9";
export const PROTOCOL_VERSION = 13;

export const PHYSICS_HZ = 60;
export const WORKER_SNAPSHOT_HZ = 30;
export const SNAPSHOT_HZ = 15;
export const INPUT_KEEPALIVE_MS = 100;
export const INPUT_TIMEOUT_SECONDS = 0.8;
export const MAX_RACE_ENTRIES = 12;

export const DEFAULT_CONFIG = Object.freeze({
  seed: 88201,
  laps: 3,
  bots: 5,
  botDifficulty: 2,
  trackComplexity: 2,
  environmentTheme: "auto",
  requiredPitStops: 1,
  collisionMode: "recovery"
});

export const CAR_COLORS = [
  "#e24b3b", "#37a8d6", "#e0b23f", "#65b55a", "#a06cce", "#d56eae",
  "#d27b34", "#57b8a8", "#d8d8d8", "#7f8ca8", "#c84f67", "#86b947"
];


export const TRACK_ENVIRONMENT_THEMES = Object.freeze([
  "auto", "industrial", "woodland", "estate", "ruins", "tournament"
]);
