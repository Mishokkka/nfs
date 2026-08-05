import {
  SOCKET,
  PROTOCOL_VERSION,
  DEFAULT_CONFIG,
  MAX_RACE_ENTRIES,
  TRACK_ENVIRONMENT_THEMES
} from "./constants.js";
import { normalizeBuild } from "./catalog.js";
import { buildRaceCarMeta, sanitizeInput } from "./physics.js";

const clone = (value) => foundry.utils.deepClone(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

let messageCounter = 0;
function messageId() {
  messageCounter = (messageCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${game.user.id}-${messageCounter}`;
}

const MESSAGE_SIZE_LIMITS = Object.freeze({
  "race-input": 8_192,
  "race-ready": 8_192,
  "control-assignment": 8_192,
  "claim-control": 8_192,
  "leave-race": 8_192,
  "pit-complete": 8_192,
  "join-request": 64_000,
  "leave-request": 8_192,
  "build-update": 64_000,
  "race-frame": 64_000,
  "race-results": 128_000,
  "race-init": 512_000,
  "race-state": 512_000,
  "lobby-state": 512_000
});

const MESSAGE_META_FIELDS = Object.freeze([
  "type", "protocolVersion", "id", "senderId", "sentAt"
]);

const SMALL_MESSAGE_SCHEMAS = Object.freeze({
  "race-ready": {
    required: ["lobbyId", "raceId", "userId", "carId"]
  },
  "control-assignment": {
    required: ["targetId", "lobbyId", "raceId", "userId", "carId"]
  },
  "claim-control": {
    required: ["lobbyId", "raceId", "userId", "carId"]
  },
  "leave-race": {
    required: ["lobbyId", "raceId", "userId", "carId"]
  },
  "pit-complete": {
    required: ["lobbyId", "raceId", "userId", "carId", "word", "attemptId"]
  }
});

const STRING_FIELD_LIMITS = Object.freeze({
  type: 40,
  id: 160,
  senderId: 80,
  targetId: 80,
  lobbyId: 120,
  raceId: 120,
  userId: 80,
  carId: 80,
  word: 80,
  attemptId: 80
});

const RACE_INPUT_FIELDS = new Set([
  "throttle", "steer", "brake", "reverse", "boost", "ram", "drift"
]);

const RACE_FRAME_MESSAGE_FIELDS = new Set([
  ...MESSAGE_META_FIELDS, "lobbyId", "raceId", "sequence", "simulationTick", "frame"
]);
const COMPACT_RACE_FRAME_FIELDS = new Set(["t", "s", "r", "c", "a", "f", "l", "p", "o", "v"]);
const LEGACY_RACE_FRAME_FIELDS = new Set([
  "tick", "simulationTime", "time", "countdown", "started", "finished",
  "laps", "requiredPitStops", "finishOrder", "cars"
]);
const LEGACY_RACE_CAR_FIELDS = new Set([
  "id", "x", "y", "vx", "vy", "angle", "health", "charge", "heat",
  "overheated", "lap", "progress", "raceDistance", "nextSector",
  "currentLapTime", "lastLapTime", "bestLapTime", "place", "finished",
  "finishTime", "finishBlocked", "disabled", "isBot", "temporaryAutopilot",
  "abandoned", "ram", "boost", "pitState", "pitProgress", "pitStopsCompleted",
  "pitWord", "pitAttemptId", "inputSequence", "surfaceSeverity", "wallContactTimer",
  "driftAmount", "pitInServiceZone"
]);

function hasOnlyKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value, limit, nullable = false) {
  if (nullable && value == null) return true;
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}

function boundedStringArray(value, limit = 80) {
  return Array.isArray(value) && value.length <= MAX_RACE_ENTRIES
    && value.every((entry) => boundedString(entry, limit));
}

function compactRaceRowFitsSchema(row) {
  if (!Array.isArray(row) || row.length !== 29 || !boundedString(row[0], 80)) return false;
  for (let index = 1; index < row.length; index += 1) {
    if (index === 22 || index === 23) {
      if (!boundedString(row[index], 80, true)) return false;
      continue;
    }
    if (index === 15 || index === 16 || index === 18) {
      if (row[index] != null && !Number.isFinite(row[index])) return false;
      continue;
    }
    if (index === 28) {
      if (![0, 1, false, true].includes(row[index])) return false;
      continue;
    }
    if (!Number.isFinite(row[index])) return false;
  }
  return true;
}

function compactRaceFrameFitsSchema(frame) {
  if (!hasOnlyKeys(frame, COMPACT_RACE_FRAME_FIELDS)) return false;
  for (const key of ["t", "s", "r", "c", "l", "p"]) if (!Number.isFinite(frame[key])) return false;
  if (!([0, 1, false, true].includes(frame.a)) || !([0, 1, false, true].includes(frame.f))) return false;
  if (!boundedStringArray(frame.o)) return false;
  return Array.isArray(frame.v) && frame.v.length > 0 && frame.v.length <= MAX_RACE_ENTRIES
    && frame.v.every(compactRaceRowFitsSchema);
}

function legacyRaceCarFitsSchema(car) {
  if (!hasOnlyKeys(car, LEGACY_RACE_CAR_FIELDS) || !boundedString(car.id, 80)) return false;
  for (const [key, value] of Object.entries(car)) {
    if (key === "id") continue;
    if (key === "pitState") {
      if (!boundedString(value, 16)) return false;
      continue;
    }
    if (key === "pitWord" || key === "pitAttemptId") {
      if (!boundedString(value, 80, true)) return false;
      continue;
    }
    if (value != null && typeof value !== "number" && typeof value !== "boolean") return false;
    if (typeof value === "number" && !Number.isFinite(value)) return false;
  }
  return true;
}

function legacyRaceFrameFitsSchema(frame) {
  if (!hasOnlyKeys(frame, LEGACY_RACE_FRAME_FIELDS)) return false;
  for (const key of ["tick", "simulationTime", "time", "countdown", "laps", "requiredPitStops"]) {
    if (!Number.isFinite(frame[key])) return false;
  }
  if (typeof frame.started !== "boolean" || typeof frame.finished !== "boolean") return false;
  if (!boundedStringArray(frame.finishOrder)) return false;
  return Array.isArray(frame.cars) && frame.cars.length > 0 && frame.cars.length <= MAX_RACE_ENTRIES
    && frame.cars.every(legacyRaceCarFitsSchema);
}

function raceFrameMessageFitsSchema(message) {
  if (!hasOnlyKeys(message, RACE_FRAME_MESSAGE_FIELDS)) return false;
  if (!boundedString(message.id, STRING_FIELD_LIMITS.id)
    || !boundedString(message.senderId, STRING_FIELD_LIMITS.senderId)
    || !boundedString(message.lobbyId, STRING_FIELD_LIMITS.lobbyId)
    || !boundedString(message.raceId, STRING_FIELD_LIMITS.raceId)) return false;
  if (!Number.isInteger(message.protocolVersion) || !Number.isFinite(message.sentAt)
    || !Number.isInteger(message.sequence) || message.sequence < 0
    || !Number.isInteger(message.simulationTick) || message.simulationTick < 0) return false;
  return Array.isArray(message.frame?.v)
    ? compactRaceFrameFitsSchema(message.frame)
    : legacyRaceFrameFitsSchema(message.frame);
}

function serializedLengthWithin(message, limit) {
  try {
    return JSON.stringify(message).length <= limit;
  } catch (_) {
    return false;
  }
}

function smallMessageFitsSchema(message, schema) {
  const allowed = new Set([...MESSAGE_META_FIELDS, ...schema.required]);
  if (!Object.keys(message).every((key) => allowed.has(key))) return false;
  if (!Number.isFinite(message.sentAt) || !Number.isInteger(message.protocolVersion)) return false;
  for (const field of [...MESSAGE_META_FIELDS, ...schema.required]) {
    if (field === "protocolVersion" || field === "sentAt") continue;
    const value = message[field];
    const limit = STRING_FIELD_LIMITS[field] ?? 120;
    if (typeof value !== "string" || value.length === 0 || value.length > limit) return false;
  }
  return serializedLengthWithin(message, MESSAGE_SIZE_LIMITS[message.type] ?? 8_192);
}

function messageFitsLimit(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  // Compact race frames have a fixed, shallow shape whose maximum encoded size
  // is bounded by the participant count and two 80-character nullable fields per
  // row. Validate that structure directly instead of JSON.stringify-ing every
  // 10 Hz snapshot again on every receiving client.
  if (message.type === "race-frame") return raceFrameMessageFitsSchema(message);
  if (message.type === "race-input") {
    const allowed = new Set(["type", "lobbyId", "raceId", "userId", "carId", "input", "sequence", "protocolVersion", "id", "senderId", "sentAt"]);
    const inputKeys = message.input && typeof message.input === "object" && !Array.isArray(message.input)
      ? Object.keys(message.input)
      : [];
    return Boolean(message.carId && inputKeys.length > 0)
      && Object.keys(message).every((key) => allowed.has(key))
      && inputKeys.length <= RACE_INPUT_FIELDS.size
      && inputKeys.every((key) => RACE_INPUT_FIELDS.has(key))
      && serializedLengthWithin(message, MESSAGE_SIZE_LIMITS[message.type]);
  }
  const schema = SMALL_MESSAGE_SCHEMAS[message.type];
  if (schema) return smallMessageFitsSchema(message, schema);
  const limit = MESSAGE_SIZE_LIMITS[message.type] ?? 64_000;
  return serializedLengthWithin(message, limit);
}

function finiteInteger(value, fallback) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    seed: finiteInteger(source.seed, DEFAULT_CONFIG.seed),
    laps: clamp(finiteInteger(source.laps, DEFAULT_CONFIG.laps), 1, 12),
    bots: clamp(finiteInteger(source.bots, 0), 0, 11),
    botDifficulty: clamp(finiteInteger(source.botDifficulty, DEFAULT_CONFIG.botDifficulty), 1, 4),
    trackComplexity: clamp(finiteInteger(source.trackComplexity, DEFAULT_CONFIG.trackComplexity), 1, 5),
    environmentTheme: TRACK_ENVIRONMENT_THEMES.includes(String(source.environmentTheme ?? ""))
      ? String(source.environmentTheme)
      : DEFAULT_CONFIG.environmentTheme,
    requiredPitStops: clamp(finiteInteger(source.requiredPitStops, DEFAULT_CONFIG.requiredPitStops), 0, 4),
    collisionMode: source.collisionMode === "elimination" ? "elimination" : "recovery"
  };
}

function normalizeParticipant(raw, fallbackUserId = null, fallbackName = "Гонщик") {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    userId: String(source.userId ?? fallbackUserId ?? "").slice(0, 80),
    userName: String(source.userName ?? fallbackName).trim().slice(0, 80) || fallbackName,
    build: normalizeBuild(source.build, { repairPoints: true })
  };
}

const finite = (value, fallback = 0, min = -Infinity, max = Infinity) => {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, min, max) : fallback;
};
const rounded = (value, digits = 2, fallback = 0, min = -Infinity, max = Infinity) => {
  const number = finite(value, fallback, min, max);
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
};

function buildControlAssignments(entries) {
  const assignments = {};
  for (const entry of entries ?? []) {
    if (entry?.isBot || entry?.userId == null) continue;
    const userId = String(entry.userId);
    const carId = String(entry.id);
    if (!userId || !carId || assignments[userId]) return null;
    assignments[userId] = carId;
  }
  return assignments;
}

function normalizeRaceEntries(rawEntries, raceId = "race") {
  const seen = new Set();
  const entries = [];
  for (const [sourceIndex, raw] of (Array.isArray(rawEntries) ? rawEntries : []).entries()) {
    if (entries.length >= MAX_RACE_ENTRIES) break;
    const source = raw && typeof raw === "object" ? raw : {};
    const fallbackId = `entry-${sourceIndex}`;
    const id = String(source.id || fallbackId).trim().slice(0, 80) || fallbackId;
    if (seen.has(id)) continue;
    seen.add(id);
    const index = entries.length;
    entries.push({
      id,
      userId: source.userId == null ? null : String(source.userId).slice(0, 80),
      name: String(source.name || `Болид ${index + 1}`).trim().slice(0, 80) || `Болид ${index + 1}`,
      build: normalizeBuild(source.build, { repairPoints: true }),
      color: String(source.color || "#d8d8d8").slice(0, 32),
      isBot: Boolean(source.isBot),
      botSkill: clamp(finite(source.botSkill, 2), 1, 4),
      botSeed: String(source.botSeed ?? `${raceId}:${index}`).slice(0, 160)
    });
  }
  return entries;
}

function normalizeCarMeta(rawMeta, entries) {
  const byId = new Map((Array.isArray(rawMeta) ? rawMeta.slice(0, MAX_RACE_ENTRIES * 2) : []).map((meta) => [String(meta?.id ?? ""), meta]));
  return entries.map((entry, index) => {
    const source = byId.get(entry.id);
    const fallback = buildRaceCarMeta(entry, index);
    return {
      id: entry.id,
      userId: entry.userId,
      name: String(source?.name ?? fallback.name).trim().slice(0, 80) || fallback.name,
      driverName: String(source?.driverName ?? fallback.driverName).trim().slice(0, 80) || fallback.driverName,
      color: String(source?.color ?? fallback.color).slice(0, 32),
      maxHealth: rounded(source?.maxHealth, 2, fallback.maxHealth, 1, 100000),
      maxCharge: rounded(source?.maxCharge, 2, fallback.maxCharge, 1, 100000),
      heatWarning: Boolean(source?.heatWarning ?? fallback.heatWarning),
      prediction: {
        maxSpeed: rounded(source?.prediction?.maxSpeed, 2, fallback.prediction.maxSpeed, 1, 100000),
        acceleration: rounded(source?.prediction?.acceleration, 2, fallback.prediction.acceleration, 1, 100000),
        reverseAcceleration: rounded(source?.prediction?.reverseAcceleration, 2, fallback.prediction.reverseAcceleration, 1, 100000),
        braking: rounded(source?.prediction?.braking, 2, fallback.prediction.braking, 1, 100000),
        steerRate: rounded(source?.prediction?.steerRate, 4, fallback.prediction.steerRate, 0.01, 100),
        lateralGrip: rounded(source?.prediction?.lateralGrip, 4, fallback.prediction.lateralGrip, 0.01, 1000),
        longitudinalDrag: rounded(source?.prediction?.longitudinalDrag, 4, fallback.prediction.longitudinalDrag, 0, 100),
        rollingDrag: rounded(source?.prediction?.rollingDrag, 4, fallback.prediction.rollingDrag, 0, 10000),
        spinResistance: rounded(source?.prediction?.spinResistance, 4, fallback.prediction.spinResistance, 0.01, 100),
        offroadGrip: rounded(source?.prediction?.offroadGrip, 4, fallback.prediction.offroadGrip, 0.01, 100),
        recovery: rounded(source?.prediction?.recovery, 4, fallback.prediction.recovery, 0.01, 100),
        boostPower: rounded(source?.prediction?.boostPower, 4, fallback.prediction.boostPower, 0.01, 100),
        boostDrain: rounded(source?.prediction?.boostDrain, 4, fallback.prediction.boostDrain, 0.01, 10000),
        heatRate: rounded(source?.prediction?.heatRate, 4, fallback.prediction.heatRate, 0, 10000),
        cooling: rounded(source?.prediction?.cooling, 4, fallback.prediction.cooling, 0, 10000),
        ramSteerPenalty: rounded(source?.prediction?.ramSteerPenalty, 4, fallback.prediction.ramSteerPenalty, 0.01, 2),
        drift: rounded(source?.prediction?.drift, 4, fallback.prediction.drift, 0.01, 100),
        precision: Boolean(source?.prediction?.precision ?? fallback.prediction.precision),
        lateBrake: Boolean(source?.prediction?.lateBrake ?? fallback.prediction.lateBrake),
        smoothSteer: Boolean(source?.prediction?.smoothSteer ?? fallback.prediction.smoothSteer),
        lastLap: Boolean(source?.prediction?.lastLap ?? fallback.prediction.lastLap),
        lowHealthBoost: rounded(source?.prediction?.lowHealthBoost, 4, fallback.prediction.lowHealthBoost, 0.01, 100)
      }
    };
  });
}

function normalizeRaceFrame(raw, race) {
  if (!raw || typeof raw !== "object" || !race) return null;
  const known = new Set((race.carMeta ?? []).map((meta) => meta.id));
  const seen = new Set();
  const cars = [];
  for (const source of Array.isArray(raw.cars) ? raw.cars : []) {
    if (cars.length >= MAX_RACE_ENTRIES) break;
    const id = String(source?.id ?? "").slice(0, 80);
    if (!id || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    const pitState = ["track", "entering", "service", "exit"].includes(source.pitState) ? source.pitState : "track";
    cars.push({
      id,
      x: rounded(source.x, 2, 0, -1000000, 1000000),
      y: rounded(source.y, 2, 0, -1000000, 1000000),
      vx: rounded(source.vx, 2, 0, -100000, 100000),
      vy: rounded(source.vy, 2, 0, -100000, 100000),
      angle: rounded(source.angle, 4, 0, -1000, 1000),
      health: rounded(source.health, 2, 0, 0, 100000),
      charge: rounded(source.charge, 2, 0, 0, 100000),
      heat: rounded(source.heat, 2, 0, 0, 200),
      overheated: Boolean(source.overheated),
      lap: Math.max(0, Math.floor(finite(source.lap, 0, 0, 100))),
      progress: rounded(source.progress, 5, 0, -2, 2),
      raceDistance: rounded(source.raceDistance, 5, -1, -10, 1000),
      nextSector: Math.max(0, Math.floor(finite(source.nextSector, 0, 0, 1000))),
      currentLapTime: rounded(source.currentLapTime, 3, 0, 0, 1000000),
      lastLapTime: source.lastLapTime == null ? null : rounded(source.lastLapTime, 3, 0, 0, 1000000),
      bestLapTime: source.bestLapTime == null ? null : rounded(source.bestLapTime, 3, 0, 0, 1000000),
      place: Math.max(1, Math.floor(finite(source.place, 1, 1, MAX_RACE_ENTRIES))),
      finished: Boolean(source.finished),
      finishTime: source.finishTime == null ? null : rounded(source.finishTime, 3, 0, 0, 1000000),
      finishBlocked: Boolean(source.finishBlocked),
      disabled: Boolean(source.disabled),
      isBot: Boolean(source.isBot),
      temporaryAutopilot: Boolean(source.temporaryAutopilot),
      abandoned: Boolean(source.abandoned),
      ram: Boolean(source.ram),
      boost: Boolean(source.boost),
      pitState,
      pitProgress: rounded(source.pitProgress, 5, 0, 0, 1),
      pitStopsCompleted: Math.max(0, Math.floor(finite(source.pitStopsCompleted, 0, 0, 20))),
      pitWord: pitState === "service" ? String(source.pitWord ?? "").slice(0, 80) || null : null,
      pitAttemptId: pitState === "service" ? String(source.pitAttemptId ?? "").slice(0, 80) || null : null,
      inputSequence: Math.max(0, Math.floor(finite(source.inputSequence, 0, 0, Number.MAX_SAFE_INTEGER))),
      surfaceSeverity: rounded(source.surfaceSeverity, 3, 0, 0, 1),
      wallContactTimer: rounded(source.wallContactTimer, 3, 0, 0, 10),
      driftAmount: rounded(source.driftAmount, 3, 0, 0, 1),
      pitInServiceZone: Boolean(source.pitInServiceZone)
    });
  }
  if (!cars.length || cars.length !== known.size) return null;
  return {
    tick: Math.max(0, Math.floor(finite(raw.tick, 0, 0, Number.MAX_SAFE_INTEGER))),
    simulationTime: rounded(raw.simulationTime, 3, 0, 0, 1000000),
    time: rounded(raw.time, 3, 0, 0, 1000000),
    countdown: rounded(raw.countdown, 3, 0, 0, 60),
    started: Boolean(raw.started),
    finished: Boolean(raw.finished),
    laps: Math.max(1, Math.floor(finite(raw.laps, race.config?.laps ?? 1, 1, 100))),
    requiredPitStops: Math.max(0, Math.floor(finite(raw.requiredPitStops, race.config?.requiredPitStops ?? 0, 0, 20))),
    finishOrder: (Array.isArray(raw.finishOrder) ? raw.finishOrder.slice(0, MAX_RACE_ENTRIES * 2) : []).map(String).filter((id, index, list) => known.has(id) && list.indexOf(id) === index).slice(0, MAX_RACE_ENTRIES),
    cars
  };
}

const PIT_STATE_TO_CODE = Object.freeze({ track: 0, entering: 1, service: 2, exit: 3 });
const PIT_CODE_TO_STATE = Object.freeze(["track", "entering", "service", "exit"]);

function encodeNormalizedFrame(frame) {
  if (!frame) return null;
  return {
    t: frame.tick,
    s: frame.simulationTime,
    r: frame.time,
    c: frame.countdown,
    a: frame.started ? 1 : 0,
    f: frame.finished ? 1 : 0,
    l: frame.laps,
    p: frame.requiredPitStops,
    o: frame.finishOrder,
    v: frame.cars.map((car) => {
      let flags = 0;
      if (car.overheated) flags |= 1;
      if (car.finished) flags |= 2;
      if (car.finishBlocked) flags |= 4;
      if (car.disabled) flags |= 8;
      if (car.isBot) flags |= 16;
      if (car.temporaryAutopilot) flags |= 32;
      if (car.abandoned) flags |= 64;
      if (car.ram) flags |= 128;
      if (car.boost) flags |= 256;
      return [
        car.id,
        car.x,
        car.y,
        car.vx,
        car.vy,
        car.angle,
        car.health,
        car.charge,
        car.heat,
        flags,
        car.lap,
        car.progress,
        car.raceDistance,
        car.nextSector,
        car.currentLapTime,
        car.lastLapTime,
        car.bestLapTime,
        car.place,
        car.finishTime,
        PIT_STATE_TO_CODE[car.pitState] ?? 0,
        car.pitProgress,
        car.pitStopsCompleted,
        car.pitWord,
        car.pitAttemptId,
        car.inputSequence,
        car.surfaceSeverity,
        car.wallContactTimer,
        car.driftAmount,
        car.pitInServiceZone ? 1 : 0
      ];
    })
  };
}

function decodeRaceFrame(raw, race) {
  if (!raw || typeof raw !== "object") return null;
  if (!Array.isArray(raw.v)) return normalizeRaceFrame(raw, race);
  const canonical = {
    tick: raw.t,
    simulationTime: raw.s,
    time: raw.r,
    countdown: raw.c,
    started: Boolean(raw.a),
    finished: Boolean(raw.f),
    laps: raw.l,
    requiredPitStops: raw.p,
    finishOrder: raw.o,
    cars: raw.v.slice(0, MAX_RACE_ENTRIES).map((values) => {
      if (!Array.isArray(values)) return null;
      const flags = Math.max(0, Math.floor(finite(values[9], 0, 0, 1023)));
      return {
        id: values[0],
        x: values[1],
        y: values[2],
        vx: values[3],
        vy: values[4],
        angle: values[5],
        health: values[6],
        charge: values[7],
        heat: values[8],
        overheated: Boolean(flags & 1),
        finished: Boolean(flags & 2),
        finishBlocked: Boolean(flags & 4),
        disabled: Boolean(flags & 8),
        isBot: Boolean(flags & 16),
        temporaryAutopilot: Boolean(flags & 32),
        abandoned: Boolean(flags & 64),
        ram: Boolean(flags & 128),
        boost: Boolean(flags & 256),
        lap: values[10],
        progress: values[11],
        raceDistance: values[12],
        nextSector: values[13],
        currentLapTime: values[14],
        lastLapTime: values[15],
        bestLapTime: values[16],
        place: values[17],
        finishTime: values[18],
        pitState: PIT_CODE_TO_STATE[Math.max(0, Math.min(3, Math.floor(finite(values[19], 0))))] ?? "track",
        pitProgress: values[20],
        pitStopsCompleted: values[21],
        pitWord: values[22],
        pitAttemptId: values[23],
        inputSequence: values[24],
        surfaceSeverity: values[25],
        wallContactTimer: values[26],
        driftAmount: values[27],
        pitInServiceZone: Boolean(values[28])
      };
    }).filter(Boolean)
  };
  return normalizeRaceFrame(canonical, race);
}

function hydrateRaceFrame(frame, race) {
  if (!frame || !race) return null;
  const meta = new Map((race.carMeta ?? []).map((entry) => [entry.id, entry]));
  return {
    ...frame,
    cars: frame.cars.map((car) => ({
      ...meta.get(car.id),
      ...car,
      pitStopsRequired: frame.requiredPitStops
    }))
  };
}

function normalizeResults(raw, race) {
  if (!raw || typeof raw !== "object" || !race) return null;
  const meta = new Map((race.carMeta ?? []).map((entry) => [entry.id, entry]));
  const seen = new Set();
  const cars = [];
  for (const source of Array.isArray(raw.cars) ? raw.cars.slice(0, MAX_RACE_ENTRIES) : []) {
    const id = String(source?.id ?? "").slice(0, 80);
    const staticData = meta.get(id);
    if (!id || !staticData || seen.has(id)) continue;
    seen.add(id);
    cars.push({
      id,
      name: staticData.name,
      driverName: staticData.driverName,
      isBot: Boolean(source.isBot),
      finishTime: source.finishTime == null ? null : rounded(source.finishTime, 3, 0, 0, 1000000),
      finished: Boolean(source.finished),
      health: rounded(source.health, 2, 0, 0, staticData.maxHealth),
      maxHealth: staticData.maxHealth,
      pitStopsCompleted: Math.max(0, Math.floor(finite(source.pitStopsCompleted, 0, 0, 20))),
      pitStopsRequired: Math.max(0, Math.floor(finite(source.pitStopsRequired, race.config?.requiredPitStops ?? 0, 0, 20)))
    });
  }
  return {
    seed: Math.floor(finite(raw.seed, race.config?.seed ?? 1, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)),
    laps: Math.max(1, Math.floor(finite(raw.laps, race.config?.laps ?? 1, 1, 100))),
    cars
  };
}

export class RaceNetwork {
  constructor() {
    this.lobby = null;
    this.activeRace = null;
    this.lastSnapshot = null;
    this.lastFrame = null;
    this.lastResults = null;
    this.seen = new Set();
    this.snapshotSequence = 0;
    this.lastReceivedSnapshotSequence = -1;
    this.lastReceivedSimulationTick = -1;
    this.lastHostHeartbeat = 0;
    this.hostOffline = false;
    this.heartbeatTimer = null;
    this.socketHandler = null;
    this.initialized = false;
    this.lastRequestAcceptedAt = new Map();
    this.lastRateLimitPruneAt = 0;
    this.handlers = {
      lobby: new Set(),
      start: new Set(),
      raceState: new Set(),
      input: new Set(),
      claimControl: new Set(),
      controlAssignment: new Set(),
      snapshot: new Set(),
      leaveRace: new Set(),
      pitComplete: new Set(),
      stop: new Set(),
      results: new Set(),
      hostStatus: new Set()
    };
  }

  initialize() {
    if (this.initialized) return;
    try {
      this.socketHandler ??= (message) => this.#receive(message);
      game.socket.on(SOCKET, this.socketHandler);
      this.heartbeatTimer = window.setInterval(() => this.#heartbeat(), 2000);
      this.initialized = true;
    } catch (error) {
      if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (this.socketHandler && typeof game.socket.off === "function") game.socket.off(SOCKET, this.socketHandler);
      this.socketHandler = null;
      this.initialized = false;
      throw error;
    }
  }

  destroy() {
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.socketHandler && typeof game.socket.off === "function") game.socket.off(SOCKET, this.socketHandler);
    this.socketHandler = null;
    this.initialized = false;
    this.seen.clear();
    this.lastRequestAcceptedAt.clear();
    this.lastRateLimitPruneAt = 0;
  }

  on(type, callback) {
    this.handlers[type]?.add(callback);
    return () => this.handlers[type]?.delete(callback);
  }

  get isHost() {
    return this.lobby?.hostId === game.user.id;
  }

  get participant() {
    return this.lobby?.participants?.[game.user.id] ?? null;
  }

  get raceId() {
    return this.activeRace?.raceId ?? null;
  }

  get participantCarId() {
    return this.activeRace?.controlAssignments?.[String(game.user.id)] ?? null;
  }

  createLobby({ build, config }) {
    if (this.lobby) return false;
    const lobby = {
      id: `lobby-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      hostId: game.user.id,
      hostName: game.user.name,
      phase: "lobby",
      config: normalizeConfig(config),
      participants: {
        [game.user.id]: normalizeParticipant({
          userId: game.user.id,
          userName: game.user.name,
          build
        }, game.user.id, game.user.name)
      },
      createdAt: Date.now(),
      hostEpoch: 0,
      hostClaimedAt: Date.now(),
      hostClaimId: game.user.id
    };
    this.lobby = lobby;
    this.activeRace = null;
    this.lastSnapshot = null;
    this.lastFrame = null;
    this.lastResults = null;
    this.lastHostHeartbeat = Date.now();
    this.#send({ type: "lobby-state", lobby });
    return true;
  }

  requestState() {
    this.#send({ type: "state-request", requesterId: game.user.id });
  }

  join(build) {
    if (!this.lobby || this.lobby.phase !== "lobby") return;
    this.#send({
      type: "join-request",
      lobbyId: this.lobby.id,
      participant: normalizeParticipant({
        userId: game.user.id,
        userName: game.user.name,
        build
      }, game.user.id, game.user.name)
    });
  }

  leave() {
    if (!this.lobby) return;
    if (this.isHost) {
      this.closeLobby();
      return;
    }
    this.#send({ type: "leave-request", lobbyId: this.lobby.id, userId: game.user.id });
  }

  leaveRace(carId) {
    if (!this.activeRace || !carId) return;
    this.sendInput(carId, {
      throttle: 0,
      steer: 0,
      brake: false,
      reverse: false,
      boost: false,
      ram: false,
      drift: false
    }, Number.MAX_SAFE_INTEGER);
    this.#send({
      type: "leave-race",
      lobbyId: this.lobby?.id ?? null,
      raceId: this.activeRace.raceId,
      userId: game.user.id,
      carId
    });
  }


  completePitStop(carId, word, attemptId) {
    if (!this.activeRace?.raceId || !carId) return;
    this.#send({
      type: "pit-complete",
      lobbyId: this.lobby?.id ?? null,
      raceId: this.activeRace.raceId,
      userId: game.user.id,
      carId,
      word: String(word ?? "").slice(0, 80),
      attemptId: String(attemptId ?? "").slice(0, 80)
    });
  }

  updateBuild(build) {
    if (!this.lobby || this.lobby.phase !== "lobby") return;
    this.#send({
      type: "build-update",
      lobbyId: this.lobby.id,
      userId: game.user.id,
      build: normalizeBuild(build, { repairPoints: true })
    });
  }

  updateConfig(config) {
    if (!this.isHost || !this.lobby || this.lobby.phase !== "lobby") return;
    this.lobby.config = normalizeConfig(config);
    this.#broadcastLobby();
  }

  startRace(entries) {
    if (!this.isHost || !this.lobby || this.lobby.phase !== "lobby") return null;
    const raceId = `race-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const safeEntries = normalizeRaceEntries(entries, raceId);
    if (!safeEntries.length) return null;
    const carMeta = normalizeCarMeta(null, safeEntries);
    const controlAssignments = buildControlAssignments(safeEntries);
    if (!controlAssignments) return null;
    this.lobby.phase = "race";
    this.snapshotSequence = 0;
    this.lastReceivedSnapshotSequence = -1;
    this.lastReceivedSimulationTick = -1;
    this.lastSnapshot = null;
    this.lastFrame = null;
    this.lastResults = null;
    this.lastRequestAcceptedAt.clear();
    this.activeRace = {
      protocolVersion: PROTOCOL_VERSION,
      raceId,
      lobbyId: this.lobby.id,
      hostId: game.user.id,
      phase: "race",
      config: normalizeConfig(this.lobby.config),
      entries: safeEntries,
      carMeta,
      controlAssignments,
      startedAt: Date.now()
    };
    this.#send({
      type: "race-init",
      lobbyId: this.lobby.id,
      raceId,
      hostId: game.user.id,
      config: this.activeRace.config,
      entries: safeEntries,
      carMeta,
      controlAssignments
    });
    this.#broadcastLobby();
    return raceId;
  }

  requestControlAssignment() {
    const carId = this.participantCarId;
    if (!this.activeRace?.raceId || !carId || this.isHost) return false;
    this.#send({
      type: "race-ready",
      lobbyId: this.lobby?.id ?? null,
      raceId: this.activeRace.raceId,
      userId: game.user.id,
      carId
    });
    return true;
  }

  sendInput(carId, input, sequence) {
    if (!this.activeRace?.raceId || !carId) return;
    this.#send({
      type: "race-input",
      lobbyId: this.lobby?.id ?? null,
      raceId: this.activeRace.raceId,
      userId: game.user.id,
      carId: String(carId).slice(0, 80),
      input: sanitizeInput(input),
      sequence: Math.max(0, Math.floor(finite(sequence, 0, 0, Number.MAX_SAFE_INTEGER)))
    }, false);
  }

  claimControl(carId) {
    if (!this.activeRace?.raceId || !carId) return;
    this.#send({
      type: "claim-control",
      lobbyId: this.lobby?.id ?? null,
      raceId: this.activeRace.raceId,
      userId: game.user.id,
      carId: String(carId).slice(0, 80)
    });
  }

  sendSnapshot(snapshot) {
    if (!this.isHost || !this.activeRace || !snapshot) return;
    const normalizedFrame = normalizeRaceFrame(snapshot, this.activeRace);
    if (!normalizedFrame) return;
    const frame = encodeNormalizedFrame(normalizedFrame);
    this.snapshotSequence += 1;
    this.lastSnapshot = snapshot;
    this.lastFrame = frame;
    this.#send({
      type: "race-frame",
      lobbyId: this.lobby?.id ?? null,
      raceId: this.activeRace.raceId,
      sequence: this.snapshotSequence,
      simulationTick: normalizedFrame.tick,
      frame
    }, false);
  }

  sendResults(results) {
    if (!this.isHost || !this.activeRace) return;
    const safeResults = normalizeResults(results, this.activeRace);
    if (!safeResults) return;
    if (this.lobby) this.lobby.phase = "results";
    this.activeRace.phase = "results";
    this.lastResults = safeResults;
    this.#send({
      type: "race-results",
      lobbyId: this.lobby?.id ?? null,
      raceId: this.activeRace.raceId,
      results: safeResults
    });
    this.#broadcastLobby();
  }

  stopRace() {
    if (!this.isHost || !this.lobby) return;
    const raceId = this.activeRace?.raceId ?? null;
    this.lobby.phase = "lobby";
    this.activeRace = null;
    this.lastSnapshot = null;
    this.lastFrame = null;
    this.lastResults = null;
    this.lastRequestAcceptedAt.clear();
    this.#send({ type: "stop-race", lobbyId: this.lobby.id, raceId });
    this.#broadcastLobby();
  }

  closeLobby() {
    if (!this.isHost || !this.lobby) return;
    const lobbyId = this.lobby.id;
    const raceId = this.activeRace?.raceId ?? null;
    this.lobby = null;
    this.activeRace = null;
    this.lastSnapshot = null;
    this.lastFrame = null;
    this.lastResults = null;
    this.lastRequestAcceptedAt.clear();
    this.#send({ type: "lobby-closed", lobbyId, raceId });
  }

  /**
   * Recover an orphaned trusted-group session. A GM may claim an idle/results
   * lobby. An active race is deliberately aborted rather than migrated because
   * remote clients do not own the full authoritative physics state.
   */
  recoverOrphanedSession() {
    if (!this.lobby || !this.hostOffline || !game.user.isGM) return false;
    const now = Date.now();
    const wasRacing = this.lobby.phase === "race";
    const claimedLobby = clone(this.lobby);
    claimedLobby.hostId = game.user.id;
    claimedLobby.hostName = game.user.name;
    claimedLobby.hostEpoch = Math.max(0, Math.floor(Number(this.lobby.hostEpoch) || 0)) + 1;
    claimedLobby.hostClaimedAt = now;
    claimedLobby.hostClaimId = `${now.toString(36)}:${game.user.id}`;
    if (wasRacing) claimedLobby.phase = "lobby";
    this.#send({
      type: "host-claim",
      lobby: claimedLobby,
      abortRace: wasRacing,
      abortedRaceId: wasRacing ? this.activeRace?.raceId ?? null : null
    });
    return true;
  }

  #broadcastLobby(targetId = null) {
    this.#send({ type: "lobby-state", lobby: this.lobby, targetId });
  }

  #broadcastRaceState(targetId) {
    if (!this.activeRace) return;
    this.#send({
      type: "race-state",
      targetId,
      lobbyId: this.lobby?.id ?? null,
      race: this.activeRace,
      frame: this.lastFrame,
      results: this.lastResults
    });
  }

  #send(payload, handleLocal = true) {
    const message = {
      ...payload,
      protocolVersion: PROTOCOL_VERSION,
      id: messageId(),
      senderId: game.user.id,
      sentAt: Date.now()
    };
    if (handleLocal) this.#receive(message);
    game.socket.emit(SOCKET, message);
  }

  #emit(type, payload) {
    for (const callback of this.handlers[type] ?? []) {
      try {
        callback(payload);
      } catch (error) {
        console.error("FBL Need for Speed | network handler failed", error);
      }
    }
  }

  #isExpectedHost(message) {
    const expected = this.lobby?.hostId ?? this.activeRace?.hostId ?? message.hostId;
    return Boolean(expected && message.senderId === expected);
  }

  #acceptLobby(message) {
    const incoming = message.lobby;
    if (!incoming || typeof incoming !== "object") return false;
    if (message.senderId !== incoming.hostId) return false;
    if (!this.lobby) return true;

    if (this.lobby.id === incoming.id) {
      const ownership = this.#compareLobbyOwnership(incoming, this.lobby);
      if (ownership !== 0) return ownership > 0;
      return String(incoming.hostId) === String(this.lobby.hostId);
    }

    // Two users can create a lobby in the same network round-trip. Resolve that
    // split-brain deterministically so every client converges on one lobby.
    if (this.lobby.phase === "lobby" && incoming.phase === "lobby") {
      const currentCreated = Number(this.lobby.createdAt) || 0;
      const incomingCreated = Number(incoming.createdAt) || 0;
      if (incomingCreated !== currentCreated) return incomingCreated < currentCreated;
      return String(incoming.id) < String(this.lobby.id);
    }

    // A stale/offline lobby may be replaced, but an active race is never
    // overwritten by an unrelated broadcast.
    return this.hostOffline && this.lobby.phase !== "race";
  }

  #compareLobbyOwnership(incoming, current) {
    const incomingEpoch = Math.max(0, Math.floor(Number(incoming?.hostEpoch) || 0));
    const currentEpoch = Math.max(0, Math.floor(Number(current?.hostEpoch) || 0));
    if (incomingEpoch !== currentEpoch) return incomingEpoch > currentEpoch ? 1 : -1;

    const incomingClaimedAt = Number(incoming?.hostClaimedAt) || Number(incoming?.createdAt) || 0;
    const currentClaimedAt = Number(current?.hostClaimedAt) || Number(current?.createdAt) || 0;
    if (incomingClaimedAt !== currentClaimedAt) return incomingClaimedAt < currentClaimedAt ? 1 : -1;

    const incomingClaimId = String(incoming?.hostClaimId || incoming?.hostId || "");
    const currentClaimId = String(current?.hostClaimId || current?.hostId || "");
    if (incomingClaimId === currentClaimId) return 0;
    return incomingClaimId < currentClaimId ? 1 : -1;
  }

  #normalizeLobby(raw) {
    const incoming = clone(raw);
    incoming.config = normalizeConfig(incoming.config);
    incoming.participants = Object.fromEntries(Object.entries(incoming.participants ?? {})
      .slice(0, MAX_RACE_ENTRIES)
      .map(([id, participant]) => [id, normalizeParticipant(participant, id, participant?.userName)]));
    incoming.hostEpoch = Math.max(0, Math.floor(Number(incoming.hostEpoch) || 0));
    incoming.hostClaimedAt = Number(incoming.hostClaimedAt) || Number(incoming.createdAt) || 0;
    incoming.hostClaimId = String(incoming.hostClaimId || incoming.hostId || "");
    return incoming;
  }

  #normalizeRace(raw, expectedHostId, fallbackStartedAt = Date.now()) {
    if (!raw || typeof raw !== "object") return null;
    const raceId = String(raw.raceId ?? "").slice(0, 120);
    const lobbyId = String(raw.lobbyId ?? "").slice(0, 120);
    const hostId = String(raw.hostId ?? expectedHostId ?? "").slice(0, 80);
    if (!raceId || !lobbyId || !hostId || hostId !== String(expectedHostId ?? hostId)) return null;
    const entries = normalizeRaceEntries(raw.entries, raceId);
    if (!entries.length) return null;
    const controlAssignments = buildControlAssignments(entries);
    if (!controlAssignments) return null;
    return {
      protocolVersion: PROTOCOL_VERSION,
      raceId,
      lobbyId,
      hostId,
      phase: raw.phase === "results" ? "results" : "race",
      config: normalizeConfig(raw.config),
      entries,
      carMeta: normalizeCarMeta(raw.carMeta, entries),
      controlAssignments,
      startedAt: finite(raw.startedAt, fallbackStartedAt, 0, Number.MAX_SAFE_INTEGER)
    };
  }

  #markHostAlive() {
    this.lastHostHeartbeat = Date.now();
    this.#setHostOffline(false);
  }

  #acceptRate(key, minimumIntervalMs) {
    const now = performance.now();
    if (now - this.lastRateLimitPruneAt >= 60_000) {
      const cutoff = now - 60_000;
      for (const [storedKey, acceptedAt] of this.lastRequestAcceptedAt) {
        if (acceptedAt < cutoff) this.lastRequestAcceptedAt.delete(storedKey);
      }
      this.lastRateLimitPruneAt = now;
    }
    const previousAt = this.lastRequestAcceptedAt.get(key) ?? -Infinity;
    if (now - previousAt < minimumIntervalMs) return false;
    this.lastRequestAcceptedAt.set(key, now);
    return true;
  }

  #receive(message) {
    try {
    if (!message?.id || this.seen.has(message.id)) return;
    if (message.protocolVersion !== PROTOCOL_VERSION || !messageFitsLimit(message)) return;
    this.seen.add(message.id);
    if (this.seen.size > 5000) {
      const iterator = this.seen.values();
      for (let index = 0; index < 2500; index += 1) {
        const next = iterator.next();
        if (next.done) break;
        this.seen.delete(next.value);
      }
    }

    switch (message.type) {
      case "state-request":
        if (this.isHost && this.lobby && message.senderId === message.requesterId) {
          this.#broadcastLobby(message.requesterId);
          this.#broadcastRaceState(message.requesterId);
        }
        break;

      case "lobby-state": {
        if (message.targetId && message.targetId !== game.user.id) break;
        if (!this.#acceptLobby(message)) break;
        const incoming = this.#normalizeLobby(message.lobby);
        this.lobby = incoming;
        this.#markHostAlive();
        this.#emit("lobby", this.lobby);
        break;
      }

      case "host-claim": {
        if (!game.users?.get(message.senderId)?.isGM) break;
        if (!this.#acceptLobby(message)) break;
        const incoming = this.#normalizeLobby(message.lobby);
        const abortRace = Boolean(message.abortRace);
        const abortedRaceId = message.abortedRaceId == null ? null : String(message.abortedRaceId);
        this.lobby = incoming;
        if (abortRace) {
          this.activeRace = null;
          this.lastSnapshot = null;
          this.lastFrame = null;
          this.lastResults = null;
          this.lastRequestAcceptedAt.clear();
        } else if (this.activeRace) {
          this.activeRace.hostId = incoming.hostId;
        }
        this.#markHostAlive();
        this.#emit("lobby", this.lobby);
        if (abortRace) this.#emit("stop", { ...message, raceId: abortedRaceId, recovered: true });
        break;
      }

      case "join-request":
        if (!this.isHost || !this.lobby || this.lobby.phase !== "lobby") break;
        if (message.lobbyId !== this.lobby.id || message.senderId !== message.participant?.userId) break;
        if (!game.users?.get(message.senderId)?.active) break;
        if (!this.#acceptRate(`join:${message.senderId}`, 250)) break;
        if (!this.lobby.participants[message.senderId] && Object.keys(this.lobby.participants).length >= MAX_RACE_ENTRIES) break;
        this.lobby.participants[message.senderId] = normalizeParticipant(message.participant, message.senderId, game.users?.get(message.senderId)?.name);
        this.#broadcastLobby();
        break;

      case "leave-request":
        if (!this.isHost || !this.lobby || message.lobbyId !== this.lobby.id) break;
        if (message.senderId !== message.userId || message.userId === this.lobby.hostId) break;
        if (!this.#acceptRate(`leave-lobby:${message.senderId}`, 250)) break;
        delete this.lobby.participants[message.senderId];
        this.#broadcastLobby();
        break;

      case "build-update":
        if (!this.isHost || !this.lobby || this.lobby.phase !== "lobby") break;
        if (message.lobbyId !== this.lobby.id || message.senderId !== message.userId) break;
        if (!this.lobby.participants?.[message.senderId]) break;
        if (!this.#acceptRate(`build:${message.senderId}`, 50)) break;
        this.lobby.participants[message.senderId].build = normalizeBuild(message.build, { repairPoints: true });
        this.#broadcastLobby();
        break;

      case "race-init": {
        if (this.lobby?.id !== message.lobbyId || !this.#isExpectedHost(message)) break;
        if (!message.raceId || message.hostId !== message.senderId) break;
        const race = this.#normalizeRace({
          raceId: message.raceId,
          lobbyId: message.lobbyId,
          hostId: message.hostId,
          phase: "race",
          config: message.config,
          entries: message.entries,
          carMeta: message.carMeta,
          controlAssignments: message.controlAssignments,
          startedAt: message.sentAt
        }, message.senderId, message.sentAt);
        if (!race || race.lobbyId !== this.lobby.id) break;
        this.lobby.phase = "race";
        this.activeRace = race;
        this.lastReceivedSnapshotSequence = -1;
        this.lastReceivedSimulationTick = -1;
        this.lastSnapshot = null;
        this.lastFrame = null;
        this.lastResults = null;
        this.#markHostAlive();
        this.#emit("start", clone(this.activeRace));
        if (!this.isHost && this.participantCarId) this.requestControlAssignment();
        break;
      }

      case "race-state": {
        if (message.targetId && message.targetId !== game.user.id) break;
        if (!this.#isExpectedHost(message) || message.lobbyId !== this.lobby?.id) break;
        const race = this.#normalizeRace(message.race, message.senderId, message.sentAt);
        if (!race || race.lobbyId !== this.lobby.id) break;
        this.activeRace = race;
        const restoredFrame = decodeRaceFrame(message.frame, this.activeRace);
        this.lastFrame = encodeNormalizedFrame(restoredFrame);
        this.lastSnapshot = hydrateRaceFrame(restoredFrame, this.activeRace);
        this.lastResults = normalizeResults(message.results, this.activeRace);
        this.#markHostAlive();
        this.#emit("raceState", {
          race: clone(this.activeRace),
          snapshot: this.lastSnapshot,
          results: this.lastResults ? clone(this.lastResults) : null
        });
        if (!this.isHost && this.participantCarId) this.requestControlAssignment();
        break;
      }

      case "race-ready": {
        if (!this.isHost || !this.activeRace || message.lobbyId !== this.lobby?.id) break;
        if (message.raceId !== this.activeRace.raceId || message.senderId !== message.userId) break;
        const assignedCarId = this.activeRace.controlAssignments?.[String(message.senderId)] ?? null;
        if (!assignedCarId || assignedCarId !== String(message.carId)) break;
        if (!this.#acceptRate(`ready:${message.senderId}`, 250)) break;
        this.#send({
          type: "control-assignment",
          targetId: message.senderId,
          lobbyId: this.lobby.id,
          raceId: this.activeRace.raceId,
          userId: message.senderId,
          carId: assignedCarId
        });
        break;
      }

      case "control-assignment": {
        if (message.targetId !== game.user.id || !this.activeRace || !this.#isExpectedHost(message)) break;
        if (message.lobbyId !== this.lobby?.id || message.raceId !== this.activeRace.raceId) break;
        const expectedCarId = this.activeRace.controlAssignments?.[String(game.user.id)] ?? null;
        if (!expectedCarId || expectedCarId !== String(message.carId) || message.userId !== game.user.id) break;
        this.#markHostAlive();
        this.#emit("controlAssignment", { carId: expectedCarId, raceId: this.activeRace.raceId });
        break;
      }

      case "race-input": {
        if (!this.isHost || !this.activeRace || this.lobby?.id !== message.lobbyId) break;
        if (message.raceId !== this.activeRace.raceId || message.senderId !== message.userId) break;
        const entry = this.activeRace.entries.find((candidate) => candidate.id === message.carId);
        if (!entry || entry.userId !== message.senderId || entry.isBot) break;
        if (!this.#acceptRate(`input:${message.senderId}:${message.carId}`, 8)) break;
        this.#emit("input", {
          ...message,
          sequence: Math.max(0, Math.floor(finite(message.sequence, 0, 0, Number.MAX_SAFE_INTEGER))),
          input: sanitizeInput(message.input)
        });
        break;
      }

      case "claim-control": {
        if (!this.isHost || !this.activeRace || this.lobby?.id !== message.lobbyId) break;
        if (message.raceId !== this.activeRace.raceId || message.senderId !== message.userId) break;
        const entry = this.activeRace.entries.find((candidate) => candidate.id === message.carId);
        if (!entry || entry.userId !== message.senderId || entry.isBot) break;
        if (!this.#acceptRate(`claim:${message.senderId}:${message.carId}`, 250)) break;
        this.#emit("claimControl", message);
        break;
      }

      case "leave-race": {
        if (!this.isHost || !this.activeRace || message.lobbyId !== this.lobby?.id) break;
        if (message.raceId !== this.activeRace.raceId) break;
        if (message.senderId !== message.userId) break;
        const entry = this.activeRace.entries.find((candidate) => candidate.id === message.carId);
        if (!entry || entry.userId !== message.senderId) break;
        if (!this.#acceptRate(`leave-race:${message.senderId}:${message.carId}`, 250)) break;
        this.#emit("leaveRace", message);
        break;
      }


      case "pit-complete": {
        if (!this.isHost || !this.activeRace || message.raceId !== this.activeRace.raceId) break;
        if (message.lobbyId !== this.lobby?.id || message.senderId !== message.userId) break;
        const entry = this.activeRace.entries.find((candidate) => candidate.id === message.carId);
        if (!entry || entry.userId !== message.senderId || entry.isBot) break;
        if (!this.#acceptRate(`pit:${message.senderId}:${message.carId}`, 100)) break;
        this.#emit("pitComplete", {
          ...message,
          word: String(message.word ?? "").slice(0, 80),
          attemptId: message.attemptId == null ? null : String(message.attemptId).slice(0, 80)
        });
        break;
      }

      case "race-frame": {
        if (this.isHost || !this.activeRace || !this.#isExpectedHost(message)) break;
        if (message.lobbyId !== this.lobby?.id || message.raceId !== this.activeRace.raceId) break;
        const sequence = Math.max(0, Math.floor(finite(message.sequence, -1, -1, Number.MAX_SAFE_INTEGER)));
        const simulationTick = Math.max(0, Math.floor(finite(message.simulationTick, -1, -1, Number.MAX_SAFE_INTEGER)));
        if (sequence <= this.lastReceivedSnapshotSequence) break;
        if (simulationTick < this.lastReceivedSimulationTick) break;
        const frame = decodeRaceFrame(message.frame, this.activeRace);
        if (!frame || frame.tick !== simulationTick) break;
        this.lastReceivedSnapshotSequence = sequence;
        this.lastReceivedSimulationTick = simulationTick;
        this.lastFrame = encodeNormalizedFrame(frame);
        this.lastSnapshot = hydrateRaceFrame(frame, this.activeRace);
        this.#markHostAlive();
        this.#emit("snapshot", this.lastSnapshot);
        break;
      }

      case "race-results": {
        if (!this.activeRace || !this.#isExpectedHost(message)) break;
        if (message.lobbyId !== this.lobby?.id || message.raceId !== this.activeRace.raceId) break;
        const safeResults = normalizeResults(message.results, this.activeRace);
        if (!safeResults) break;
        if (this.lobby) this.lobby.phase = "results";
        this.activeRace.phase = "results";
        this.lastResults = safeResults;
        this.#markHostAlive();
        this.#emit("results", this.lastResults);
        break;
      }

      case "stop-race":
        if (this.lobby?.id !== message.lobbyId || !this.#isExpectedHost(message)) break;
        if (message.raceId && this.activeRace?.raceId && message.raceId !== this.activeRace.raceId) break;
        if (this.lobby) this.lobby.phase = "lobby";
        this.activeRace = null;
        this.lastSnapshot = null;
        this.lastFrame = null;
        this.lastResults = null;
        this.lastRequestAcceptedAt.clear();
        this.#markHostAlive();
        this.#emit("stop", message);
        break;

      case "lobby-closed":
        if (this.lobby?.id !== message.lobbyId || !this.#isExpectedHost(message)) break;
        this.lobby = null;
        this.activeRace = null;
        this.lastSnapshot = null;
        this.lastFrame = null;
        this.lastResults = null;
        this.lastRequestAcceptedAt.clear();
        this.#emit("lobby", null);
        this.#emit("stop", message);
        break;

      case "host-heartbeat":
        if (message.lobbyId !== this.lobby?.id || message.senderId !== this.lobby?.hostId) break;
        this.#markHostAlive();
        break;

      default:
        break;
      }
    } catch (error) {
      console.error("FBL Need for Speed | rejected malformed network message", error, message?.type);
    }
  }

  #heartbeat() {
    if (!this.lobby) return;
    if (this.isHost) {
      this.lastHostHeartbeat = Date.now();
      this.#send({
        type: "host-heartbeat",
        lobbyId: this.lobby.id,
        raceId: this.activeRace?.raceId ?? null,
        phase: this.lobby.phase
      }, false);
      return;
    }
    const timeout = this.lobby.phase === "race" ? 6500 : 18000;
    const stale = this.lastHostHeartbeat > 0 && Date.now() - this.lastHostHeartbeat > timeout;
    this.#setHostOffline(stale);
  }

  #setHostOffline(value) {
    const next = Boolean(value);
    if (next === this.hostOffline) return;
    this.hostOffline = next;
    this.#emit("hostStatus", { offline: next, hostId: this.lobby?.hostId ?? null });
  }
}
