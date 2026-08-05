import { PHYSICS_HZ, CAR_COLORS, INPUT_TIMEOUT_SECONDS } from "./constants.js";
import { resolveBuild } from "./catalog.js";
import {
  nearestTrackPoint,
  nearestPitPoint,
  sampleTrack,
  samplePit,
  seededRng,
  runoffSurfaceForSide,
  wallSegmentActiveRange,
  WALL_COLLISION_ALPHA
} from "./track.js";
import { computeBotInput, shouldBotPit } from "./physics/bot-controller.js";
import { applyDriveModel } from "./physics/drive-model.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const dot = (ax, ay, bx, by) => ax * bx + ay * by;
const cross = (ax, ay, bx, by) => ax * by - ay * bx;

function closestPointOnSegment(point, start, end) {
  const sx = end.x - start.x;
  const sy = end.y - start.y;
  const lengthSquared = sx * sx + sy * sy;
  const t = lengthSquared > 1e-9
    ? clamp(((point.x - start.x) * sx + (point.y - start.y) * sy) / lengthSquared, 0, 1)
    : 0;
  return { x: start.x + sx * t, y: start.y + sy * t, t };
}

function closestPointsBetweenSegments(a0, a1, b0, b1) {
  const ux = a1.x - a0.x;
  const uy = a1.y - a0.y;
  const vx = b1.x - b0.x;
  const vy = b1.y - b0.y;
  const wx = a0.x - b0.x;
  const wy = a0.y - b0.y;
  const aa = dot(ux, uy, ux, uy);
  const bb = dot(ux, uy, vx, vy);
  const cc = dot(vx, vy, vx, vy);
  const dd = dot(ux, uy, wx, wy);
  const ee = dot(vx, vy, wx, wy);
  const denominator = aa * cc - bb * bb;
  let sN = 0;
  let sD = denominator;
  let tN = 0;
  let tD = denominator;

  if (denominator < 1e-9) {
    sN = 0;
    sD = 1;
    tN = ee;
    tD = cc || 1;
  } else {
    sN = bb * ee - cc * dd;
    tN = aa * ee - bb * dd;
    if (sN < 0) {
      sN = 0;
      tN = ee;
      tD = cc || 1;
    } else if (sN > sD) {
      sN = sD;
      tN = ee + bb;
      tD = cc || 1;
    }
  }

  if (tN < 0) {
    tN = 0;
    if (-dd < 0) sN = 0;
    else if (-dd > aa) sN = sD;
    else { sN = -dd; sD = aa || 1; }
  } else if (tN > tD) {
    tN = tD;
    if (-dd + bb < 0) sN = 0;
    else if (-dd + bb > aa) sN = sD;
    else { sN = -dd + bb; sD = aa || 1; }
  }

  const s = Math.abs(sN) < 1e-9 ? 0 : sN / (sD || 1);
  const t = Math.abs(tN) < 1e-9 ? 0 : tN / (tD || 1);
  return {
    a: { x: a0.x + ux * s, y: a0.y + uy * s },
    b: { x: b0.x + vx * t, y: b0.y + vy * t },
    s,
    t
  };
}

function carCapsule(car, x = car.x, y = car.y, angle = car.angle) {
  const forwardX = Math.cos(angle);
  const forwardY = Math.sin(angle);
  const halfWidth = Math.max(7, Number(car.physics.collisionHalfWidth ?? car.physics.radius) || 12);
  const halfLength = Math.max(halfWidth, Number(car.physics.collisionHalfLength) || halfWidth * 1.7);
  const axisHalf = Math.max(0, halfLength - halfWidth);
  return {
    start: { x: x - forwardX * axisHalf, y: y - forwardY * axisHalf },
    end: { x: x + forwardX * axisHalf, y: y + forwardY * axisHalf },
    forwardX,
    forwardY,
    halfWidth,
    halfLength,
    axisHalf
  };
}

function velocityAtPoint(car, x, y) {
  const rx = x - car.x;
  const ry = y - car.y;
  return {
    x: car.vx - car.angularVelocity * ry,
    y: car.vy + car.angularVelocity * rx
  };
}
const GLOBAL_SPEED_SCALE = 1.25;
const GLOBAL_ACCELERATION_SCALE = 1.0;

const TERRAIN_PROFILES = Object.freeze({
  road: Object.freeze({ accelerationLoss: 0, steeringLoss: 0, topSpeedLoss: 0, gripLoss: 0, yawGain: 0, dampingShift: 0, dragBase: 0, dragStrength: 0 }),
  grass: Object.freeze({ accelerationLoss: 0.45, steeringLoss: 0.34, topSpeedLoss: 0.42, gripLoss: 0.72, yawGain: 0.48, dampingShift: -0.68, dragBase: 0.18, dragStrength: 1.38 }),
  gravel: Object.freeze({ accelerationLoss: 0.64, steeringLoss: 0.42, topSpeedLoss: 0.64, gripLoss: 0.66, yawGain: 0.22, dampingShift: -0.34, dragBase: 0.42, dragStrength: 2.82 }),
  sand: Object.freeze({ accelerationLoss: 0.86, steeringLoss: 0.46, topSpeedLoss: 0.82, gripLoss: 0.34, yawGain: -0.18, dampingShift: 1.18, dragBase: 0.70, dragStrength: 5.20 })
});

function terrainModifiers(car, physics, speed = null) {
  const p = physics ?? car?.physics ?? {};
  const rawSeverity = clamp(Number(car?.surfaceSeverity) || 0, 0, 1);
  const effective = clamp(rawSeverity / Math.max(1, Number(p.offroadGrip) || 1), 0, 1);
  const currentSpeed = speed == null ? Math.hypot(Number(car?.vx) || 0, Number(car?.vy) || 0) : Math.abs(Number(speed) || 0);
  const speedRatio = clamp(currentSpeed / Math.max(1, Number(p.maxSpeed) || 420), 0, 1.4);
  const type = TERRAIN_PROFILES[car?.surfaceType] ? car.surfaceType : (effective > 0.001 ? "grass" : "road");
  const profile = TERRAIN_PROFILES[type];
  const highSpeed = clamp((speedRatio - 0.22) / 0.88, 0, 1);
  const gripLoss = type === "grass"
    ? profile.gripLoss * (0.52 + highSpeed * 0.72)
    : profile.gripLoss * (0.82 + highSpeed * 0.18);
  const sandCrawlAssist = type === "sand"
    ? effective * 0.52 * (1 - clamp(speedRatio / 0.20, 0, 1))
    : 0;
  return {
    type,
    severity: effective,
    speedRatio,
    // Deep sand still destroys pace, but a stationary car must retain enough
    // tractive effort to crawl back toward the asphalt. The extra low-speed
    // term fades completely before the car reaches racing speed.
    acceleration: Math.max(0.08, 1 - effective * profile.accelerationLoss + sandCrawlAssist),
    steering: Math.max(0.18, 1 - effective * profile.steeringLoss * (0.78 + highSpeed * 0.32)),
    topSpeed: Math.max(0.12, 1 - effective * profile.topSpeedLoss),
    grip: Math.max(0.06, 1 - effective * gripLoss),
    yawResponse: Math.max(0.28, 1 + effective * profile.yawGain * (0.42 + highSpeed * 0.78)),
    angularDamping: Math.max(0.16, 1 + effective * profile.dampingShift * (0.45 + highSpeed * 0.75)),
    dragRate: effective > 0.001
      ? profile.dragBase * effective + profile.dragStrength * Math.pow(effective, 1.28) * (0.54 + speedRatio * 0.52)
      : 0
  };
}
const PIT_WORDS = Object.freeze([
  "кристалл", "болид", "вираж", "скорость", "поршень", "шестерня", "искрение", "гонщик",
  "питстоп", "разряд", "трасса", "Аллантре", "турбина", "механик", "форсаж", "сцепление",
  "crystal", "racing", "throttle", "piston", "gearbox", "velocity", "pitstop", "overdrive",
  "engine", "circuit", "driver", "traction", "coolant", "turbine", "chassis", "resonance"
]);

export function deriveCarPhysics(resolved) {
  const { stats, traits, driverStats } = resolved;
  const reflexes = clamp(Number(driverStats.reflexes) || 1, 1, 6);
  const technique = clamp(Number(driverStats.technique) || 1, 1, 6);
  const composure = clamp(Number(driverStats.composure) || 1, 1, 6);
  const aggression = clamp(Number(driverStats.aggression) || 1, 1, 6);
  const attunement = clamp(Number(driverStats.attunement) || 1, 1, 6);
  const mass = 600 + stats.mass * 105;
  const radius = Math.max(13, traits.radiusBase + traits.radiusDelta + stats.mass * 0.42);
  const collisionHalfWidth = Math.max(10.5, radius * 0.91);
  const collisionHalfLength = Math.max(collisionHalfWidth + 8, 20.5 + stats.mass * 1.05 + traits.radiusDelta * 0.42);
  const momentOfInertia = Math.max(1, mass * ((collisionHalfLength * 2) ** 2 + (collisionHalfWidth * 2) ** 2) / 12);
  return {
    // Each driver attribute owns a clear domain and changes it by roughly
    // 8-24% across the full 1-6 range. No single attribute supplies both the
    // highest speed and the highest cornering performance anymore.
    maxSpeed: (260 + stats.speed * 30) * traits.topSpeed * (1 + (technique - 1) * 0.005) * GLOBAL_SPEED_SCALE,
    acceleration: (18 + stats.acceleration * 16) * (1 + (reflexes - 1) * 0.04) * GLOBAL_ACCELERATION_SCALE,
    reverseAcceleration: 58 * GLOBAL_ACCELERATION_SCALE,
    braking: 245 * (1 + (reflexes - 1) * 0.03) * GLOBAL_SPEED_SCALE,
    steerRate: (0.88 + stats.handling * 0.14) * (1 + (technique - 1) * 0.028),
    lateralGrip: (1.55 + stats.control * 0.42)
      * traits.cornerGrip
      * (1 + (technique - 1) * 0.016 + (composure - 1) * 0.022),
    longitudinalDrag: 0.25,
    rollingDrag: 16 * GLOBAL_SPEED_SCALE,
    mass,
    momentOfInertia,
    maxHealth: (55 + stats.durability * 14) * traits.durabilityMult,
    radius,
    collisionHalfWidth,
    collisionHalfLength,
    maxCharge: 100 * traits.charge * (1 + (attunement - 1) * 0.017),
    cooling: 5.0 * traits.cooling * (1 + (attunement - 1) * 0.05),
    heatRate: 40 * traits.heatRate * (1 - (attunement - 1) * 0.03),
    boostDrain: 25,
    boostPower: traits.boostPower * (1 + (attunement - 1) * 0.017),
    ramPower: traits.ramPower * (1 + (aggression - 1) * 0.048),
    collisionResistance: traits.collisionResistance * (1 - (composure - 1) * 0.03),
    sideYieldFactor: traits.sideYieldFactor * (1 - (aggression - 1) * 0.025),
    spinResistance: traits.spinResistance * (1 + (reflexes - 1) * 0.04 + (composure - 1) * 0.022),
    offroadGrip: traits.offroadGrip,
    recovery: traits.recovery * (1 + (reflexes - 1) * 0.04)
  };
}

export function buildRaceCarMeta(entry, index = 0) {
  const resolved = resolveBuild(entry?.build);
  const physics = deriveCarPhysics(resolved);
  return {
    id: String(entry?.id ?? `entry-${index}`),
    userId: entry?.userId == null ? null : String(entry.userId),
    name: String(entry?.name || `Болид ${index + 1}`).trim().slice(0, 80),
    driverName: String(entry?.build?.driver?.name || entry?.name || `Гонщик ${index + 1}`).trim().slice(0, 80),
    color: String(entry?.color || CAR_COLORS[index % CAR_COLORS.length]).slice(0, 32),
    maxHealth: physics.maxHealth,
    maxCharge: physics.maxCharge,
    heatWarning: Boolean(resolved.traits.heatWarning),
    prediction: {
      maxSpeed: physics.maxSpeed,
      acceleration: physics.acceleration,
      reverseAcceleration: physics.reverseAcceleration,
      braking: physics.braking,
      steerRate: physics.steerRate,
      lateralGrip: physics.lateralGrip,
      longitudinalDrag: physics.longitudinalDrag,
      rollingDrag: physics.rollingDrag,
      spinResistance: physics.spinResistance,
      offroadGrip: physics.offroadGrip,
      recovery: physics.recovery,
      boostPower: physics.boostPower,
      boostDrain: physics.boostDrain,
      heatRate: physics.heatRate,
      cooling: physics.cooling,
      ramSteerPenalty: resolved.traits.ramSteerPenalty || 0.55,
      drift: resolved.traits.drift || 1,
      precision: Boolean(resolved.traits.precision),
      lateBrake: Boolean(resolved.traits.lateBrake),
      smoothSteer: Boolean(resolved.traits.smoothSteer),
      lastLap: Boolean(resolved.traits.lastLap),
      lowHealthBoost: resolved.traits.lowHealthBoost || 1
    }
  };
}

export class RaceSimulation {
  constructor({
    track,
    entries,
    laps = 3,
    collisionMode = "recovery",
    botDifficulty = 2,
    requiredPitStops = 0
  }) {
    this.track = track;
    this.laps = Math.max(1, Number(laps) || 3);
    this.collisionMode = collisionMode;
    this.botDifficulty = clamp(Number(botDifficulty) || 2, 1, 4);
    this.requiredPitStops = clamp(Math.floor(Number(requiredPitStops) || 0), 0, 4);
    this.time = 0;
    this.simulationTime = 0;
    this.started = false;
    this.countdown = 3.4;
    this.finished = false;
    this.finishOrder = [];
    this.tick = 0;
    this.cars = entries.map((entry, index) => this.#createCar(entry, index));
  }

  #createCar(entry, index) {
    const resolved = resolveBuild(entry.build);
    const physics = deriveCarPhysics(resolved);
    const botSkill = clamp(Number(entry.botSkill ?? this.botDifficulty) || 1, 1, 4);
    const startIndex = (this.track.samples.length - 5 - Math.floor(index / 2) * 7 + this.track.samples.length) % this.track.samples.length;
    const start = sampleTrack(this.track, startIndex);
    const lane = index % 2 === 0 ? -1 : 1;
    const offset = lane * Math.min(42, this.track.width * 0.19);
    return {
      id: entry.id,
      userId: entry.userId ?? null,
      name: entry.name,
      driverName: entry.build.driver?.name || entry.name,
      build: entry.build,
      resolved,
      physics,
      color: entry.color ?? CAR_COLORS[index % CAR_COLORS.length],
      isBot: Boolean(entry.isBot),
      botSkill,
      x: start.x + start.nx * offset,
      y: start.y + start.ny * offset,
      vx: 0,
      vy: 0,
      angle: Math.atan2(start.ty, start.tx),
      angularVelocity: 0,
      health: physics.maxHealth,
      charge: physics.maxCharge,
      heat: 0,
      overheated: false,
      boostActive: false,
      lap: 0,
      startedLap: false,
      progress: start.cumulative / this.track.totalLength,
      lastProgress: start.cumulative / this.track.totalLength,
      raceDistance: start.cumulative / this.track.totalLength - 1,
      nextSector: 0,
      startGateArmed: true,
      lapStartedAt: 0,
      lastLapTime: null,
      bestLapTime: null,
      trackIndex: startIndex,
      place: index + 1,
      finished: false,
      finishTime: null,
      finishBlocked: false,
      disabled: false,
      respawnTimer: 0,
      emergencyUsed: false,
      criticalIgnored: false,
      criticalGrace: false,
      lastCollisionAt: -10,
      lastWallImpactAt: -10,
      lastObstacleImpactAt: -10,
      retaliationUntil: 0,
      cleanLap: true,
      currentInput: neutralInput(),
      inputAge: 0,
      lastInputSequence: 0,
      temporaryAutopilot: false,
      abandoned: false,
      rng: seededRng(entry.botSeed ?? `${this.track.seed}:${entry.id}:${index}`),
      cornerAccumulator: 0,
      lastSteer: 0,
      burstTimer: 0,
      startBoostTimer: 0,
      pitState: "track",
      pitIndex: 0,
      pitProgress: 0,
      lastPitProgress: 0,
      pitStopsRequired: this.requiredPitStops,
      pitStopsCompleted: 0,
      pitWord: null,
      pitAttemptId: null,
      pitServiceTimer: 0,
      pitStartCrossed: false,
      lastPitMainProgress: null,
      botStuckTimer: 0,
      botReverseTimer: 0,
      botRecoveryAttempts: 0,
      botRecoveryRequested: false,
      pitStallTimer: 0,
      botSteer: 0,
      botThrottle: 0,
      botLaneBias: Boolean(entry.isBot) ? ((index % 3) - 1) * (botSkill === 4 ? 0.045 : 0.12) : 0,
      botPhase: index % 3,
      botCurvature: null,
      surfaceSeverity: 0,
      surfaceType: "road",
      surfaceSide: 0,
      surfaceOutside: 0,
      surfaceKickCooldown: 0,
      driftAmount: 0,
      driftDirection: 0,
      slipAngle: 0,
      wallContactTimer: 0,
      offroadImpactSpeed: 0,
      offroadTimer: 0,
      routeContext: null
    };
  }

  setInput(carId, input, sequence = null) {
    const car = this.cars.find((candidate) => candidate.id === carId);
    if (!car || car.isBot || car.abandoned) return;
    const nextSequence = sequence == null ? car.lastInputSequence + 1 : Math.max(0, Math.floor(Number(sequence) || 0));
    if (nextSequence < car.lastInputSequence) return;
    car.lastInputSequence = nextSequence;
    car.temporaryAutopilot = false;
    car.inputAge = 0;
    if (car.pitState === "service") return;
    car.currentInput = sanitizeInput(input);
  }

  claimControl(carId) {
    const car = this.cars.find((candidate) => candidate.id === carId);
    if (!car || car.isBot || car.abandoned || car.finished) return false;
    car.temporaryAutopilot = false;
    car.currentInput = neutralInput();
    car.inputAge = 0;
    // A reconnect or remount starts the owning client's input counter from
    // zero. Keep the authority transition explicit by opening a fresh sequence
    // window here; otherwise every packet from the reclaimed client can be
    // rejected forever as older than the previous session's final sequence.
    car.lastInputSequence = -1;
    return true;
  }

  completePitStop(carId, typedWord, attemptId = null) {
    const car = this.cars.find((candidate) => candidate.id === carId);
    if (!car || car.pitState !== "service" || !car.pitWord) return false;
    if (attemptId != null && String(attemptId) !== String(car.pitAttemptId)) return false;
    if (String(typedWord ?? "").normalize("NFC") !== String(car.pitWord).normalize("NFC")) return false;

    car.health = car.physics.maxHealth;
    car.charge = car.physics.maxCharge;
    car.heat = 0;
    car.overheated = false;
    car.boostActive = false;
    car.disabled = false;
    car.criticalGrace = false;
    car.pitStopsCompleted = Math.min(car.pitStopsRequired, car.pitStopsCompleted + 1);
    car.finishBlocked = car.pitStopsCompleted < car.pitStopsRequired;
    car.pitState = "exit";
    car.pitWord = null;
    car.pitAttemptId = null;
    car.pitServiceTimer = 0;
    car.currentInput = neutralInput();
    car.inputAge = 0;
    // Service ends exactly where the driver stopped. No launch, centring or
    // relocation is performed; control simply returns for the manual pit exit.
    car.surfaceSeverity = 0;
    car.surfaceType = "road";
    car.surfaceSide = 0;
    car.surfaceKickCooldown = 0;
    car.driftAmount = 0;
    car.driftDirection = 0;
    car.slipAngle = 0;
    car.vx = 0;
    car.vy = 0;
    car.angularVelocity = 0;
    car.routeContext = null;
    return true;
  }

  handToBot(carId, skill = 1) {
    const car = this.cars.find((candidate) => candidate.id === carId);
    if (!car || car.finished) return false;
    car.isBot = true;
    car.temporaryAutopilot = false;
    car.abandoned = true;
    car.botSkill = clamp(Number(skill) || 1, 1, 4);
    car.currentInput = neutralInput();
    car.inputAge = 0;
    return true;
  }

  step(dt = 1 / PHYSICS_HZ) {
    dt = Math.min(0.05, Math.max(0, dt));
    if (this.finished) return;

    this.tick += 1;
    this.simulationTime += dt;
    if (this.countdown > 0) {
      this.countdown = Math.max(0, this.countdown - dt);
      if (this.countdown <= 0) {
        this.started = true;
        for (const car of this.cars) {
          if (car.resolved.traits.startBoost) car.startBoostTimer = 1.2;
        }
      }
      return;
    }

    this.time += dt;
    for (const car of this.cars) {
      if (car.finished) continue;
      // Driving input is ignored during service, but its keepalive still resets
      // inputAge in setInput(). A disconnected player eventually gets temporary
      // autopilot, while an actively typing player remains in control.
      if (car.pitState === "service") {
        this.#stepPitService(car, dt);
        continue;
      }
      if (!car.isBot) {
        car.inputAge += dt;
        if (car.inputAge > INPUT_TIMEOUT_SECONDS) car.currentInput = neutralInput();
        if (this.started && car.inputAge > 5 && !car.temporaryAutopilot) {
          car.temporaryAutopilot = true;
          car.botSkill = 1;
          car.currentInput = neutralInput();
        }
      }
      if (car.disabled) {
        this.#stepDisabled(car, dt);
        continue;
      }
      const automated = car.isBot || car.temporaryAutopilot;
      const steeringContext = automated ? (car.routeContext ?? this.#routeContext(car)) : null;
      const input = automated ? this.#botInput(car, dt, steeringContext) : car.currentInput;
      if (automated) car.currentInput = input;
      this.#stepCar(car, input, dt);
    }

    this.#resolveCarCollisions();
    this.#updateRaceOrder();
    if (this.cars.every((car) => car.finished || car.disabled && this.collisionMode === "elimination")) {
      this.finished = true;
    }
  }

  #stepPitService(car, dt) {
    car.vx = 0;
    car.vy = 0;
    car.angularVelocity = 0;
    car.currentInput = neutralInput();
    car.heat = Math.max(0, car.heat - car.physics.cooling * 2.5 * dt);
    if (!car.isBot) {
      car.inputAge += dt;
      if (car.inputAge > 5) {
        car.temporaryAutopilot = true;
        car.botSkill = 1;
      }
    }
    if (!car.isBot && !car.temporaryAutopilot) return;
    car.pitServiceTimer -= dt;
    if (car.pitServiceTimer <= 0) this.completePitStop(car.id, car.pitWord, car.pitAttemptId);
  }

  #stepDisabled(car, dt) {
    car.vx *= Math.exp(-5 * dt);
    car.vy *= Math.exp(-5 * dt);
    car.x += car.vx * dt;
    car.y += car.vy * dt;
    if (this.collisionMode !== "recovery") return;
    car.respawnTimer -= dt;
    if (car.respawnTimer <= 0) this.#respawn(car);
  }

  #respawn(car) {
    const point = car.pitState !== "track"
      ? samplePit(this.track, car.pitIndex)
      : sampleTrack(this.track, car.trackIndex);
    car.x = point.x;
    car.y = point.y;
    car.angle = Math.atan2(point.ty, point.tx);
    car.vx = point.tx * 40;
    car.vy = point.ty * 40;
    car.health = car.physics.maxHealth * 0.55;
    car.heat = Math.min(car.heat, 70);
    car.criticalGrace = false;
    car.disabled = false;
    car.cleanLap = false;
    car.surfaceSeverity = 0;
    car.surfaceType = "road";
    car.surfaceSide = 0;
    car.surfaceKickCooldown = 0;
    car.driftAmount = 0;
    car.driftDirection = 0;
    car.slipAngle = 0;
    car.offroadTimer = 0;
    car.routeContext = null;
  }

  #routeContext(car) {
    const mainNearest = nearestTrackPoint(this.track, car.x, car.y, car.trackIndex);
    const pitEntry = Number(this.track.pit?.entryMainProgressNormalized ?? 0.66);
    const pitExit = Number(this.track.pit?.exitMainProgressNormalized ?? 0.24);
    // Pit placement is selected dynamically from the smoothest part of each
    // generated circuit. Its entry can therefore begin before the old fixed
    // 0.66 cut-off. Query the branch from a measured approach margin through
    // the measured exit margin, otherwise a bot can steer into the fork while
    // the state transition never sees a pit-nearest result.
    const nearPitFork = car.pitState !== "track"
      || mainNearest.progress >= Math.max(0, pitEntry - 0.13)
      || mainNearest.progress <= Math.min(1, pitExit + 0.13);
    const pitNearest = nearPitFork
      ? nearestPitPoint(this.track, car.x, car.y, car.pitIndex)
      : null;
    return { mainNearest, pitNearest };
  }

  #stepCar(car, input, dt) {
    input = sanitizeInput(input);
    const p = car.physics;
    const previousPosition = { x: car.x, y: car.y };
    const forwardX = Math.cos(car.angle);
    const forwardY = Math.sin(car.angle);
    let forwardSpeed = dot(car.vx, car.vy, forwardX, forwardY);

    const terrain = terrainModifiers(car, p, Math.abs(forwardSpeed));

    if (car.overheated && car.heat <= 48) car.overheated = false;
    const heatStress = clamp((car.heat - 68) / 32, 0, 1);
    const thermalAcceleration = car.overheated ? 0.58 : 1 - heatStress * 0.28;
    const thermalSteering = car.overheated ? 0.72 : 1 - heatStress * 0.13;
    const thermalTopSpeed = car.overheated ? 0.78 : 1 - heatStress * 0.08;

    const ramSteerPenalty = input.ram ? (car.resolved.traits.ramSteerPenalty || 0.55) : 1;
    const healthPenalty = car.health < p.maxHealth * 0.25 && !car.criticalGrace ? 0.78 : 1;
    const lastLapBoost = car.resolved.traits.lastLap && car.lap === this.laps - 1 ? 1.04 : 1;
    const lowHealthBoost = car.resolved.traits.lowHealthBoost && car.health < p.maxHealth * 0.3 ? car.resolved.traits.lowHealthBoost : 1;

    let extraAcceleration = 0;
    const draft = car.pitState === "track" ? this.#draftEffect(car, dt) : { acceleration: 0, pursuit: false };
    extraAcceleration += draft.acceleration;
    if (draft.pursuit) extraAcceleration += p.acceleration * 0.07;

    const wantsReverse = input.reverse || input.throttle < 0;
    const brakingForReverse = wantsReverse && forwardSpeed > 7;
    if (input.brake || brakingForReverse) {
      if (car.resolved.traits.recuperation && car.charge < p.maxCharge && Math.abs(forwardSpeed) > 8) {
        car.charge = Math.min(p.maxCharge, car.charge + Math.abs(forwardSpeed) * 0.018 * car.resolved.traits.recuperation * dt);
      }
    }

    car.boostActive = false;
    const requestedBoost = car.pitState === "track"
      && input.boost && input.throttle > 0 && !car.overheated && car.charge > 0.001;
    let boostAccelerationMultiplier = 0;
    let boostTopSpeedMultiplier = 1;
    if (requestedBoost) {
      const requestedCharge = p.boostDrain * dt;
      const boostFraction = clamp(car.charge / Math.max(0.0001, requestedCharge), 0, 1);
      if (boostFraction > 0.001) {
        car.boostActive = true;
        boostAccelerationMultiplier = 0.95 * p.boostPower * lowHealthBoost * boostFraction;
        boostTopSpeedMultiplier = 1.17 * p.boostPower;
        car.charge = Math.max(0, car.charge - requestedCharge * boostFraction);
        car.heat = Math.min(112, car.heat + p.heatRate * dt * boostFraction);
      }
    }
    if (!car.boostActive) car.heat = Math.max(0, car.heat - p.cooling * dt);
    if (car.heat >= 100) {
      car.overheated = true;
      car.boostActive = false;
      boostTopSpeedMultiplier = 1;
    }

    if (car.startBoostTimer > 0) {
      car.startBoostTimer -= dt;
      extraAcceleration += p.acceleration * 0.3;
    }
    if (car.burstTimer > 0) {
      car.burstTimer -= dt;
      extraAcceleration += p.acceleration * 0.35;
    }

    const pitLimit = car.pitState !== "track" ? this.track.pit.speedLimit : Infinity;
    const drive = applyDriveModel(car, input, p, dt, {
      accelerationMultiplier: healthPenalty * thermalAcceleration * terrain.acceleration * lastLapBoost,
      steeringMultiplier: ramSteerPenalty * thermalSteering * terrain.steering * (car.resolved.traits.precision ? 1.04 : 1),
      topSpeedMultiplier: thermalTopSpeed * terrain.topSpeed * lastLapBoost,
      gripMultiplier: terrain.grip,
      yawResponseMultiplier: terrain.yawResponse,
      angularDampingMultiplier: terrain.angularDamping,
      brakeGripMultiplier: car.resolved.traits.lateBrake ? 1.22 : 1,
      driftEnabled: car.pitState === "track" && terrain.type === "road" && !car.isBot && !car.temporaryAutopilot,
      driftAssist: Math.max(0.75, Number(car.resolved.traits.drift) || 1),
      driftControl: Math.max(0.45, Math.sqrt(p.spinResistance * p.recovery)
        * (1 + (Number(car.resolved.traits.drift) || 1) - 1) * 0.75),
      extraAcceleration,
      boostAccelerationMultiplier,
      boostTopSpeedMultiplier,
      speedLimit: pitLimit,
      speedLimitDeceleration: car.pitState !== "track" ? Number(this.track.pit.speedLimitDeceleration ?? 96) : 0,
      previousSteer: car.lastSteer,
      smoothSteer: Boolean(car.resolved.traits.smoothSteer)
    });
    forwardSpeed = drive.forwardSpeed;
    const steering = drive.steering;
    if (terrain.type !== "road" || car.pitState !== "track") {
      car.driftAmount = Math.max(0, Number(car.driftAmount || 0) - dt * 2.8);
      if (car.driftAmount <= 0.01) {
        car.driftAmount = 0;
        car.driftDirection = 0;
      }
    }

    // Measure the route after movement. The result is reused by bot steering on
    // the next fixed step, so every car performs one geometry query per tick
    // without making terrain and progress calculations one frame stale.
    let routeContext = this.#routeContext(car);
    car.routeContext = routeContext;
    let mainNearest = routeContext.mainNearest;
    let pitNearest = routeContext.pitNearest;

    // In recovery mode an automated driver that has failed several physical
    // reverse attempts may be reset by the marshals to the centre of its owned
    // route. Human cars are never affected, and elimination mode keeps the
    // fully physical outcome. This prevents bots from grinding against the same
    // fence indefinitely after a severe capsule collision.
    if ((car.isBot || car.temporaryAutopilot) && car.botRecoveryRequested) {
      car.botRecoveryRequested = false;
      if (this.collisionMode === "recovery" && car.pitState === "track") {
        const point = mainNearest.point;
        const lane = clamp(car.botLaneBias || 0, -0.12, 0.12) * this.track.width;
        car.x = point.x + point.nx * lane;
        car.y = point.y + point.ny * lane;
        car.angle = Math.atan2(point.ty, point.tx);
        car.vx = point.tx * 46;
        car.vy = point.ty * 46;
        car.angularVelocity = 0;
        car.botSteer = 0;
        car.botThrottle = 0.38;
        car.botReverseTimer = 0;
        car.botStuckTimer = 0;
        car.wallContactTimer = 0;
        car.cleanLap = false;
        routeContext = this.#routeContext(car);
        car.routeContext = routeContext;
        mainNearest = routeContext.mainNearest;
        pitNearest = routeContext.pitNearest;
      }
    }

    if (car.isBot && car.pitState !== "track" && pitNearest
      && pitNearest.distance > this.track.pit.width * 0.52) {
      const point = pitNearest.point;
      car.x = point.x;
      car.y = point.y;
      car.angle = Math.atan2(point.ty, point.tx);
      car.vx = point.tx * Math.min(this.track.pit.speedLimit * 0.55, Math.max(52, Math.hypot(car.vx, car.vy)));
      car.vy = point.ty * Math.min(this.track.pit.speedLimit * 0.55, Math.max(52, Math.hypot(car.vx, car.vy)));
      car.angularVelocity = 0;
      car.botSteer = 0;
      car.botThrottle = 0.4;
      car.botReverseTimer = 0;
      car.botStuckTimer = 0;
      pitNearest = nearestPitPoint(this.track, car.x, car.y, pitNearest.index);
      car.routeContext = { mainNearest, pitNearest };
    }

    // Bots commit at the exact shared beginning of the pit fork. At that point
    // both centrelines still coincide, so the state switch is invisible and the
    // regular pit steering can follow the branch without hunting for its exit.
    if ((car.isBot || car.temporaryAutopilot) && car.pitState === "track" && pitNearest && this.#botShouldPit(car)) {
      const entryProgress = Number(this.track.pit.entryMainProgressNormalized ?? 0.77);
      const crossedEntry = car.lastProgress < entryProgress && mainNearest.progress >= entryProgress;
      if (crossedEntry) {
        const entry = this.track.pit.samples[0];
        car.pitState = "entering";
        car.pitIndex = 0;
        car.pitProgress = 0;
        car.lastPitProgress = 0;
        car.pitStartCrossed = false;
        car.lastPitMainProgress = entry.mainProgressUnwrapped;
      }
    }

    if (car.pitState === "track" && pitNearest) {
      // A car may enter only through the measured entry throat. The old recovery
      // range extended almost to the exit merge, so grazing the outgoing lane
      // could teleport a main-track car back into the pit route.
      const branchPoint = this.track.pit.samples[Math.max(0, Math.min(this.track.pit.samples.length - 1, pitNearest.index))];
      const entryStart = Number(this.track.pit.entryMainProgressNormalized ?? 0.94);
      const entryEndUnwrapped = Number(this.track.pit.samples[this.track.pit.entryTriggerEnd]?.mainProgressUnwrapped ?? entryStart + 0.03);
      const mainProgressUnwrapped = mainNearest.progress < entryStart - 0.5
        ? mainNearest.progress + 1
        : mainNearest.progress;
      const inEntryProgress = mainProgressUnwrapped >= entryStart - 0.012
        && mainProgressUnwrapped <= entryEndUnwrapped + 0.012;
      const inEntryThroat = pitNearest.index >= Math.max(0, this.track.pit.entryTriggerStart - 2)
        && pitNearest.index <= Math.min(this.track.pit.samples.length - 1, this.track.pit.entryTriggerEnd + 3);
      const separated = Number(branchPoint?.separation ?? 0) >= 0.86;
      const insidePitAsphalt = pitNearest.distance <= this.track.pit.width * 0.44;
      const outsideMainAsphalt = mainNearest.distance >= this.track.width * 0.56;
      const onPitSide = mainNearest.signedDistance * Number(this.track.pit.side || 1) >= this.track.width * 0.36;
      const clearlyCloserToPit = pitNearest.distance + Math.max(14, this.track.pit.width * 0.14) < mainNearest.distance;
      const movingAlongPit = dot(car.vx, car.vy, Number(branchPoint?.tx) || 0, Number(branchPoint?.ty) || 0) > 2;
      // Entering the branch is a swept gate crossing, not a proximity test. This
      // prevents a car grazing the outgoing pit lane from being captured and
      // teleported onto it after the finish line.
      const entryGate = this.track.pit.samples[Math.max(1, this.track.pit.entryTriggerEnd)];
      const previousAlongGate = entryGate
        ? dot(previousPosition.x - entryGate.x, previousPosition.y - entryGate.y, entryGate.tx, entryGate.ty)
        : -1;
      const currentAlongGate = entryGate
        ? dot(car.x - entryGate.x, car.y - entryGate.y, entryGate.tx, entryGate.ty)
        : 1;
      const crossedEntryGate = previousAlongGate <= 2 && currentAlongGate >= -2;
      if (inEntryProgress && inEntryThroat && crossedEntryGate && separated && insidePitAsphalt
        && outsideMainAsphalt && onPitSide && clearlyCloserToPit && movingAlongPit) {
        car.pitState = "entering";
        car.pitIndex = pitNearest.index;
        car.pitProgress = pitNearest.progress;
        car.lastPitProgress = pitNearest.progress;
        car.pitStartCrossed = false;
        car.lastPitMainProgress = pitNearest.point.mainProgressUnwrapped;
      }
    }

    if (car.pitState !== "track" && pitNearest) {
      car.pitIndex = pitNearest.index;
      car.lastPitProgress = car.pitProgress;
      car.pitProgress = pitNearest.progress;

      if (car.isBot) {
        const advanced = car.pitProgress - car.lastPitProgress;
        if (advanced < 0.00005) car.pitStallTimer = (car.pitStallTimer || 0) + dt;
        else car.pitStallTimer = 0;
        if (car.pitStallTimer > 0.75) {
          const recoveryIndex = Math.min(this.track.pit.samples.length - 1, Math.max(car.pitIndex + 3, 1));
          const point = samplePit(this.track, recoveryIndex);
          car.x = point.x;
          car.y = point.y;
          car.angle = Math.atan2(point.ty, point.tx);
          car.vx = point.tx * 62;
          car.vy = point.ty * 62;
          car.angularVelocity = 0;
          car.pitIndex = recoveryIndex;
          car.pitProgress = point.cumulative / Math.max(1, this.track.pit.totalLength);
          car.pitStallTimer = 0;
          pitNearest = nearestPitPoint(this.track, car.x, car.y, recoveryIndex);
        }
      }

      this.#updatePitRouteProgress(car, pitNearest);

      // The blue service box is not a trigger rail. The driver must place the
      // whole car inside it and reduce actual velocity to a near standstill.
      // Crossing the box at speed simply misses the stop and leaves the car
      // under manual control for the rest of the pit lane.
      const stoppedInServiceZone = car.pitState === "entering"
        && this.#isInsidePitServiceZone(car)
        && Math.hypot(car.vx, car.vy) <= Number(this.track.pit.serviceStopSpeed ?? 12);
      if (stoppedInServiceZone) this.#beginPitService(car);

      if ((car.pitState === "exit" || car.pitState === "entering") && pitNearest.progress >= 0.96) {
        car.pitState = "track";
        car.trackIndex = mainNearest.index;
        car.progress = mainNearest.progress;
        car.lastProgress = mainNearest.progress;
        car.lastPitMainProgress = null;
      }
    } else {
      car.trackIndex = mainNearest.index;
      car.lastProgress = car.progress;
      car.progress = mainNearest.progress;
      this.#updateLap(car, forwardSpeed);
      this.#applyPassiveTraits(car, mainNearest, steering, dt);
    }

    this.#applyTerrain(car, mainNearest, pitNearest, dt, previousPosition);

    car.raceDistance = (car.startedLap ? car.lap : -1) + car.progress;
    car.lastSteer = steering;
  }

  #isInsidePitServiceZone(car) {
    const service = this.track.pit.samples[this.track.pit.serviceIndex];
    if (!service) return false;
    const dx = car.x - service.x;
    const dy = car.y - service.y;
    const longitudinal = dot(dx, dy, service.tx, service.ty);
    const lateral = dot(dx, dy, service.nx, service.ny);
    const radius = Math.max(0, Number(car.physics?.radius) || 0);
    const halfLength = Math.max(18, Number(this.track.pit.serviceHalfLength ?? 52));
    const halfWidth = Math.max(10, Number(this.track.pit.width) * 0.48);
    return Math.abs(longitudinal) <= Math.max(8, halfLength - radius * 0.45)
      && Math.abs(lateral) <= Math.max(6, halfWidth - radius * 0.45);
  }

  #beginPitService(car) {
    car.pitState = "service";
    car.vx = 0;
    car.vy = 0;
    car.angularVelocity = 0;
    car.boostActive = false;
    car.currentInput = neutralInput();
    const word = PIT_WORDS[Math.floor(car.rng() * PIT_WORDS.length) % PIT_WORDS.length];
    car.pitWord = word;
    car.pitAttemptId = `${this.tick}-${Math.floor(car.rng() * 0xFFFFFF).toString(36)}`;
    car.pitServiceTimer = 1.15 + (5 - clamp(car.botSkill, 1, 4)) * 0.52 + car.rng() * 0.55;
    // Preserve the exact manually chosen stopping position and heading.
    car.lastPitProgress = car.pitProgress;
    car.routeContext = null;
  }

  #advanceSectorsToProgress(car, progress) {
    const normalized = clamp(Number(progress) || 0, 0, 0.999999);
    while (car.nextSector > 0 && car.nextSector < this.track.sectors.length) {
      const sector = this.track.sectors[car.nextSector];
      if (!sector || normalized + 0.002 < sector.progress) break;
      car.nextSector += 1;
    }
  }

  #updatePitRouteProgress(car, pitNearest) {
    const current = Number(pitNearest?.point?.mainProgressUnwrapped);
    if (!Number.isFinite(current)) return;
    const previous = Number.isFinite(car.lastPitMainProgress) ? car.lastPitMainProgress : current;

    if (current < 1) this.#advanceSectorsToProgress(car, current);
    const crossedStart = previous < 1 && current >= 1 && !car.pitStartCrossed;
    if (crossedStart) {
      this.#advanceSectorsToProgress(car, 0.999999);
      car.pitStartCrossed = true;
      this.#registerStartCrossing(car);
    }

    const wrapped = ((current % 1) + 1) % 1;
    car.lastProgress = car.progress;
    car.progress = wrapped;
    if (current >= 1) this.#advanceSectorsToProgress(car, wrapped);
    car.lastPitMainProgress = current;
  }

  #draftEffect(car, dt) {
    const forwardX = Math.cos(car.angle);
    const forwardY = Math.sin(car.angle);
    const rightX = -forwardY;
    const rightY = forwardX;
    let best = null;
    for (const rival of this.cars) {
      if (rival.id === car.id || rival.disabled || rival.finished || rival.pitState !== "track") continue;
      const dx = rival.x - car.x;
      const dy = rival.y - car.y;
      const ahead = dot(dx, dy, forwardX, forwardY);
      if (ahead < 25 || ahead > 190) continue;
      const lateral = Math.abs(dot(dx, dy, rightX, rightY));
      if (lateral > 48) continue;
      if (!best || ahead < best.ahead) best = { rival, ahead, lateral };
    }
    if (!best) return { pursuit: false, acceleration: 0, strength: 0 };
    const strength = clamp(1 - best.ahead / 220, 0.15, 0.9) * car.resolved.traits.slipstream;
    if (car.resolved.traits.slipstreamCharge) {
      car.charge = Math.min(car.physics.maxCharge, car.charge + 4.0 * strength * car.resolved.traits.slipstreamCharge * dt);
    }
    return {
      pursuit: Boolean(car.resolved.traits.pursuit),
      strength,
      acceleration: 36 * strength
    };
  }

  #applyStaticImpulse(car, contactX, contactY, nx, ny, restitution = 0.12, friction = 0.58) {
    const mass = Math.max(1, Number(car.physics.mass) || 1);
    const inertia = Math.max(1, Number(car.physics.momentOfInertia) || mass * 500);
    const inverseMass = 1 / mass;
    const inverseInertia = 1 / inertia;
    const rx = contactX - car.x;
    const ry = contactY - car.y;
    const contactVelocity = velocityAtPoint(car, contactX, contactY);
    const normalVelocity = dot(contactVelocity.x, contactVelocity.y, nx, ny);
    if (normalVelocity >= 0) return 0;

    const normalLever = cross(rx, ry, nx, ny);
    const normalDenominator = inverseMass + normalLever * normalLever * inverseInertia;
    const impulseMagnitude = -(1 + restitution) * normalVelocity / Math.max(1e-8, normalDenominator);
    const impulseX = nx * impulseMagnitude;
    const impulseY = ny * impulseMagnitude;
    car.vx += impulseX * inverseMass;
    car.vy += impulseY * inverseMass;
    car.angularVelocity += cross(rx, ry, impulseX, impulseY) * inverseInertia;

    const tangentX = -ny;
    const tangentY = nx;
    const postVelocity = velocityAtPoint(car, contactX, contactY);
    const tangentVelocity = dot(postVelocity.x, postVelocity.y, tangentX, tangentY);
    const tangentLever = cross(rx, ry, tangentX, tangentY);
    const tangentDenominator = inverseMass + tangentLever * tangentLever * inverseInertia;
    const rawTangentImpulse = -tangentVelocity / Math.max(1e-8, tangentDenominator);
    const tangentImpulse = clamp(rawTangentImpulse, -impulseMagnitude * friction, impulseMagnitude * friction);
    car.vx += tangentX * tangentImpulse * inverseMass;
    car.vy += tangentY * tangentImpulse * inverseMass;
    car.angularVelocity += cross(rx, ry, tangentX * tangentImpulse, tangentY * tangentImpulse) * inverseInertia;
    return -normalVelocity;
  }

  #resolveWallCollisions(car, routeCandidates, previousPosition, dt) {
    const previous = previousPosition ?? { x: car.x, y: car.y };
    let collided = false;
    let strongestImpact = 0;
    let hardWallCrossing = false;
    let recoveryCandidate = null;

    const wallCoordinate = (point, roadWidth, side) => {
      const xKey = side > 0 ? "wallLeftX" : "wallRightX";
      const yKey = side > 0 ? "wallLeftY" : "wallRightY";
      const x = Number(point?.[xKey]);
      const y = Number(point?.[yKey]);
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
      const grass = side > 0
        ? Number(point?.grassWidthLeft ?? point?.grassWidth ?? 0)
        : Number(point?.grassWidthRight ?? point?.grassWidth ?? 0);
      const distance = roadWidth * 0.5 + Math.max(0, grass);
      return {
        x: Number(point?.x) + Number(point?.nx) * distance * side,
        y: Number(point?.y) + Number(point?.ny) * distance * side
      };
    };

    for (let pass = 0; pass < 4; pass += 1) {
      let best = null;
      const capsule = carCapsule(car);
      const previousCapsule = carCapsule(car, previous.x, previous.y, car.angle);
      for (const candidate of routeCandidates) {
        if (!candidate?.nearest) continue;
        const isPit = candidate.route === "pit";
        const points = isPit ? this.track.pit.samples : this.track.samples;
        const roadWidth = isPit ? this.track.pit.width : this.track.width;
        const closed = !isPit;
        const count = points.length;
        const segmentCount = closed ? count : Math.max(0, count - 1);
        if (!segmentCount) continue;
        const baseIndex = Math.max(0, Math.min(segmentCount - 1, Number(candidate.nearest.index) || 0));

        for (let offset = -5; offset <= 5; offset += 1) {
          let index = baseIndex + offset;
          if (closed) index = (index % count + count) % count;
          else if (index < 0 || index >= segmentCount) continue;
          const nextIndex = closed ? (index + 1) % count : index + 1;
          const startPoint = points[index];
          const endPoint = points[nextIndex];

          for (const side of [1, -1]) {
            const active = wallSegmentActiveRange(startPoint, endPoint, side, WALL_COLLISION_ALPHA);
            if (!active) continue;
            const rawWallStart = wallCoordinate(startPoint, roadWidth, side);
            const rawWallEnd = wallCoordinate(endPoint, roadWidth, side);
            const wallStart = {
              x: rawWallStart.x + (rawWallEnd.x - rawWallStart.x) * active.startT,
              y: rawWallStart.y + (rawWallEnd.y - rawWallStart.y) * active.startT
            };
            const wallEnd = {
              x: rawWallStart.x + (rawWallEnd.x - rawWallStart.x) * active.endT,
              y: rawWallStart.y + (rawWallEnd.y - rawWallStart.y) * active.endT
            };
            // Treat both the bolid and the visible fence as finite capsules.
            // The previous support-plane approximation extended every wall
            // segment beyond its endpoints and created invisible wedges around
            // sharp corners. Segment-to-segment distance gives the fence real
            // endpoints and allows the nose or flank to glance past them.
            const closest = closestPointsBetweenSegments(capsule.start, capsule.end, wallStart, wallEnd);
            const dx = closest.a.x - closest.b.x;
            const dy = closest.a.y - closest.b.y;
            const distance = Math.hypot(dx, dy);
            const wallRadius = 4.5;
            const minimumDistance = capsule.halfWidth + wallRadius;
            if (distance >= minimumDistance) continue;

            const sourceT = active.startT + (active.endT - active.startT) * closest.t;
            const centerX = startPoint.x + (endPoint.x - startPoint.x) * sourceT;
            const centerY = startPoint.y + (endPoint.y - startPoint.y) * sourceT;
            let inwardX = centerX - closest.b.x;
            let inwardY = centerY - closest.b.y;
            const inwardLength = Math.hypot(inwardX, inwardY);
            if (inwardLength < 0.001) continue;
            inwardX /= inwardLength;
            inwardY /= inwardLength;

            const insideProjection = dot(closest.a.x - closest.b.x, closest.a.y - closest.b.y, inwardX, inwardY);
            let normalX;
            let normalY;
            let penetration;
            if (insideProjection < 0) {
              // The capsule crossed to the outside. Move it completely through
              // the fence back to the playable side instead of reflecting it
              // farther away from the circuit.
              normalX = inwardX;
              normalY = inwardY;
              penetration = minimumDistance - insideProjection;
            } else if (distance > 0.001) {
              normalX = dx / distance;
              normalY = dy / distance;
              if (dot(normalX, normalY, inwardX, inwardY) < 0) {
                normalX *= -1;
                normalY *= -1;
              }
              penetration = minimumDistance - distance;
            } else {
              normalX = inwardX;
              normalY = inwardY;
              penetration = minimumDistance;
            }

            const previousClosest = closestPointsBetweenSegments(previousCapsule.start, previousCapsule.end, wallStart, wallEnd);
            const previousDistance = Math.hypot(previousClosest.a.x - previousClosest.b.x, previousClosest.a.y - previousClosest.b.y);
            const crossed = insideProjection < 0 || previousDistance >= minimumDistance && distance < minimumDistance;
            const contactX = closest.a.x;
            const contactY = closest.a.y;
            const pointVelocity = velocityAtPoint(car, contactX, contactY);
            const velocityImpact = Math.max(0, -dot(pointVelocity.x, pointVelocity.y, normalX, normalY));
            const sweptImpact = crossed && dt > 0 ? Math.max(0, (previousDistance - distance) / dt) : 0;
            const impact = Math.max(velocityImpact, sweptImpact);
            if (!best || penetration > best.penetration) {
              best = {
                penetration, inwardX: normalX, inwardY: normalY,
                contactX, contactY, candidate, impact, crossed
              };
            }
          }
        }
      }

      if (!best) break;
      collided = true;
      recoveryCandidate = best.candidate;
      strongestImpact = Math.max(strongestImpact, best.impact);
      hardWallCrossing ||= Boolean(best.crossed);
      car.x += best.inwardX * (best.penetration + 0.35);
      car.y += best.inwardY * (best.penetration + 0.35);
      const restitution = clamp(0.07 + best.impact / 2200, 0.07, 0.22);
      this.#applyStaticImpulse(car, best.contactX, best.contactY, best.inwardX, best.inwardY, restitution, 0.62);
      car.cleanLap = false;
    }

    if (!collided) {
      car.wallContactTimer = Math.max(0, (car.wallContactTimer || 0) - dt * 2.5);
      return false;
    }

    car.wallContactTimer = (car.wallContactTimer || 0) + dt;
    const impactForDamage = hardWallCrossing
      ? Math.max(strongestImpact, Number(car.offroadImpactSpeed || 0) * 0.58)
      : strongestImpact;
    if (impactForDamage > 24 && this.time - Number(car.lastWallImpactAt ?? -999) >= 0.16) {
      const severity = impactForDamage - 18;
      const damage = (severity * 0.115 + severity * severity * 0.00055)
        * (car.isBot || car.temporaryAutopilot ? 0.68 : 1);
      this.#damage(car, damage);
      car.lastWallImpactAt = this.time;
      car.offroadImpactSpeed *= 0.35;
    }

    const embeddedSpeed = Math.hypot(car.vx, car.vy);
    const needsRecovery = car.wallContactTimer > ((car.isBot || car.temporaryAutopilot) ? 0.86 : 0.72)
      && embeddedSpeed < 56;
    if (needsRecovery && recoveryCandidate?.nearest) {
      const point = recoveryCandidate.nearest.point;
      const lane = car.pitState === "track" ? clamp(car.botLaneBias || 0, -0.18, 0.18) * this.track.width : 0;
      car.x = point.x + point.nx * lane;
      car.y = point.y + point.ny * lane;
      car.angle = Math.atan2(point.ty, point.tx);
      const recoverySpeed = clamp(embeddedSpeed, 20, 40);
      car.vx = point.tx * recoverySpeed;
      car.vy = point.ty * recoverySpeed;
      car.angularVelocity = 0;
      car.botSteer = 0;
      car.botThrottle = 0.32;
      car.botReverseTimer = 0;
      car.botStuckTimer = 0;
      car.wallContactTimer = 0;
    }
    car.routeContext = null;
    return true;
  }

  #resolveSceneryCollisions(car, previousPosition, dt) {
    const obstacles = this.track.scenery ?? [];
    if (!obstacles.length || car.pitState === "service") return false;
    let collided = false;
    let strongestImpact = 0;

    for (let pass = 0; pass < 3; pass += 1) {
      let best = null;
      const capsule = carCapsule(car);
      for (const obstacle of obstacles) {
        if (!obstacle?.solid) continue;
        const closest = closestPointOnSegment(obstacle, capsule.start, capsule.end);
        let nx = closest.x - obstacle.x;
        let ny = closest.y - obstacle.y;
        let distance = Math.hypot(nx, ny);
        const combinedRadius = capsule.halfWidth + Math.max(4, Number(obstacle.collisionRadius) || 12);
        if (distance >= combinedRadius) continue;
        if (distance < 0.001) {
          const speed = Math.hypot(car.vx, car.vy);
          nx = speed > 0.1 ? -car.vx / speed : Math.cos(car.angle + Math.PI * 0.5);
          ny = speed > 0.1 ? -car.vy / speed : Math.sin(car.angle + Math.PI * 0.5);
          distance = 0.001;
        } else {
          nx /= distance;
          ny /= distance;
        }
        const penetration = combinedRadius - distance;
        const obstacleRadius = Math.max(4, Number(obstacle.collisionRadius) || 12);
        const contactX = obstacle.x + nx * obstacleRadius;
        const contactY = obstacle.y + ny * obstacleRadius;
        const pointVelocity = velocityAtPoint(car, contactX, contactY);
        const impact = Math.max(0, -dot(pointVelocity.x, pointVelocity.y, nx, ny));
        if (!best || penetration > best.penetration) {
          best = { obstacle, penetration, nx, ny, contactX, contactY, impact };
        }
      }
      if (!best) break;
      collided = true;
      strongestImpact = Math.max(strongestImpact, best.impact);
      car.x += best.nx * (best.penetration + 0.45);
      car.y += best.ny * (best.penetration + 0.45);
      const restitution = clamp(0.05 + best.impact / 2600, 0.05, 0.18);
      this.#applyStaticImpulse(car, best.contactX, best.contactY, best.nx, best.ny, restitution, 0.72);
      car.cleanLap = false;
    }

    if (!collided) return false;
    car.wallContactTimer = Math.max(Number(car.wallContactTimer) || 0, dt * 1.5);
    if (strongestImpact > 18 && this.time - Number(car.lastObstacleImpactAt ?? -999) >= 0.14) {
      const severity = strongestImpact - 12;
      const damage = (severity * 0.16 + severity * severity * 0.00078)
        * (car.isBot || car.temporaryAutopilot ? 0.72 : 1);
      this.#damage(car, damage);
      car.lastObstacleImpactAt = this.time;
    }
    car.routeContext = null;
    return true;
  }

  #applyTerrain(car, mainNearest, pitNearest, dt, previousPosition = null) {
    const makeCandidate = (nearest, roadWidth, fallbackGrass, route) => {
      if (!nearest) return null;
      const side = Number(nearest.signedDistance) >= 0 ? 1 : -1;
      const halfRoad = roadWidth * 0.5;
      const point = nearest.point ?? {};
      const sideGrass = side > 0 ? point.grassWidthLeft : point.grassWidthRight;
      const grassWidth = Math.max(0, Number(sideGrass ?? point.grassWidth ?? fallbackGrass ?? 0));
      const surfaceType = route === "pit" ? "grass" : runoffSurfaceForSide(point, side);
      const wallAlpha = Math.max(0, Math.min(1, Number(side > 0 ? point.wallLeftAlpha ?? 1 : point.wallRightAlpha ?? 1)));
      const lateral = Math.max(0, Number(nearest.distance) || Math.abs(nearest.signedDistance));
      return {
        nearest, route, grassWidth, surfaceType, halfRoad, side, wallAlpha,
        roadClearance: lateral - halfRoad,
        boundaryClearance: lateral - (halfRoad + grassWidth)
      };
    };

    const mainCandidate = makeCandidate(mainNearest, this.track.width, this.track.grassWidth, "track");
    const pitCandidate = makeCandidate(pitNearest, this.track.pit.width, this.track.pit.grassWidth, "pit");
    const committedToPit = car.pitState !== "track";
    // Asphalt is asphalt before the state machine formally commits to the fork.
    // At the pit mouth the old code always evaluated the main route, so a car
    // visibly driving on the pit ribbon could receive grass drag for several
    // frames. Select whichever road footprint actually contains the car.
    const surface = committedToPit
      ? (pitCandidate ?? mainCandidate)
      : [mainCandidate, pitCandidate].filter(Boolean).sort((a, b) => a.roadClearance - b.roadClearance)[0];
    if (!surface) return;

    const roadClearance = surface.roadClearance;
    const grassWidth = surface.grassWidth;
    const footprint = Math.max(8, Number(car.physics.radius) * 0.72);
    // Surface contact is based on the car footprint, not on the total width of
    // the runoff. One wheel pair touching a wide lawn and one touching a narrow
    // verge should produce the same initial loss of grip. The old ratio against
    // grassWidth made identical edge contacts behave differently on every bend.
    const contactLinear = grassWidth > 1
      ? clamp((roadClearance + footprint) / Math.max(1, footprint * 2), 0, 1)
      : 0;
    const grassContact = contactLinear * contactLinear * (3 - 2 * contactLinear);
    const currentSeverity = clamp(Number(car.surfaceSeverity) || 0, 0, 1);
    const responseTime = grassContact > currentSeverity ? 0.085 : 0.24;
    const response = 1 - Math.exp(-dt / responseTime);
    car.surfaceSeverity = currentSeverity + (grassContact - currentSeverity) * response;
    car.surfaceType = grassContact > 0.01 ? surface.surfaceType : "road";
    car.surfaceSide = grassContact > 0.01 ? surface.side : Number(car.surfaceSide || 0) * Math.exp(-5 * dt);
    car.surfaceOutside = Math.max(0, surface.boundaryClearance);

    const currentSpeed = Math.hypot(car.vx, car.vy);
    if (grassContact > 0.02) {
      car.offroadImpactSpeed = Math.max(currentSpeed, Number(car.offroadImpactSpeed || 0) * Math.exp(-0.55 * dt));
      car.offroadTimer = (car.offroadTimer || 0) + dt * grassContact;
    } else {
      car.offroadImpactSpeed = Number(car.offroadImpactSpeed || 0) * Math.exp(-1.8 * dt);
      car.offroadTimer = Math.max(0, (car.offroadTimer || 0) - dt * 2.4);
    }

    const terrain = terrainModifiers(car, car.physics, currentSpeed);
    const effectiveSeverity = terrain.severity;
    car.surfaceKickCooldown = Math.max(0, Number(car.surfaceKickCooldown || 0) - dt);
    if (effectiveSeverity > 0.008) {
      const damping = Math.exp(-terrain.dragRate * dt);
      car.vx *= damping;
      car.vy *= damping;
      const rightX = -Math.sin(car.angle);
      const rightY = Math.cos(car.angle);
      const lateralSpeed = dot(car.vx, car.vy, rightX, rightY);

      if (terrain.type === "grass") {
        // Grass is not the heaviest surface, but at racing speed it offers very
        // little lateral support. Countersteer can save the car; a large slip
        // angle or an abrupt steering input keeps adding yaw until it spins.
        const highSpeed = clamp((terrain.speedRatio - 0.28) / 0.82, 0, 1);
        const slipRatio = clamp(Math.abs(lateralSpeed) / Math.max(34, currentSpeed * 0.34), 0, 1.4);
        const steer = clamp(Number(car.currentInput?.steer) || 0, -1, 1);
        const instabilitySource = Math.abs(lateralSpeed) > 0.5 ? lateralSpeed : steer;
        if (Math.abs(instabilitySource) > 0.001) {
          const slipDirection = Math.sign(instabilitySource);
          car.angularVelocity += slipDirection * effectiveSeverity * highSpeed
            * (0.16 + slipRatio * 0.62 + Math.abs(steer) * 0.25) * dt;
        }
        // Two wheels on asphalt and two on grass should feel nervous again, but
        // without the old positional snap. Use a small yaw bias only while the
        // contact is genuinely split and the driver is already loading the car
        // with speed, steering or lateral slip.
        const splitContact = clamp(1 - Math.abs(grassContact - 0.5) / 0.5, 0, 1);
        const splitLoad = Math.max(Math.abs(steer) * 0.82, slipRatio * 0.94);
        if (splitContact > 0.04 && highSpeed > 0.08 && splitLoad > 0.06) {
          const vergeYaw = Number(car.surfaceSide || surface.side || 0) >= 0 ? 1 : -1;
          car.angularVelocity += vergeYaw * splitContact * highSpeed * effectiveSeverity
            * (0.030 + splitLoad * 0.070) * dt;
        }
      } else if (terrain.type === "sand") {
        // Loose sand piles in front of the wheels. It kills speed and yaw, making
        // escape possible only with a straight wheel and sustained throttle.
        car.angularVelocity *= Math.exp(-(1.6 + effectiveSeverity * 3.8) * dt);
        const lateralDamping = Math.exp(-(1.2 + effectiveSeverity * 4.2) * dt);
        const forwardX = Math.cos(car.angle);
        const forwardY = Math.sin(car.angle);
        const forwardSpeed = dot(car.vx, car.vy, forwardX, forwardY);
        const reducedLateral = lateralSpeed * lateralDamping;
        car.vx = forwardX * forwardSpeed + rightX * reducedLateral;
        car.vy = forwardY * forwardSpeed + rightY * reducedLateral;
        // Static rolling resistance used to exceed the weakest engine's entire
        // sand-adjusted output. Preserve the heavy bogging at speed, but give a
        // straight, throttled car a small low-speed digging force so it can leave.
        const throttle = clamp(Number(car.currentInput?.throttle) || 0, 0, 1);
        const crawlWindow = 1 - clamp(currentSpeed / 92, 0, 1);
        if (throttle > 0.05 && crawlWindow > 0) {
          const crawlAcceleration = (24 + car.physics.acceleration * 0.22)
            * throttle * crawlWindow * Math.sqrt(effectiveSeverity);
          car.vx += forwardX * crawlAcceleration * dt;
          car.vy += forwardY * crawlAcceleration * dt;
        }
      } else if (terrain.type === "gravel") {
        // A buried stone can kick one front wheel. The event is random but has a
        // cooldown, so gravel feels treacherous rather than like constant noise.
        const chancePerSecond = (0.16 + terrain.speedRatio * 0.78) * effectiveSeverity;
        if (effectiveSeverity > 0.24 && currentSpeed > 72 && car.offroadTimer > 0.35
          && car.surfaceKickCooldown <= 0 && car.rng() < chancePerSecond * dt) {
          const direction = car.rng() < 0.5 ? -1 : 1;
          const impulse = (0.50 + car.rng() * 0.85) * (0.65 + terrain.speedRatio * 0.95)
            * Math.sqrt(effectiveSeverity) / Math.pow(Math.max(0.45, car.physics.spinResistance), 0.35);
          car.angularVelocity += direction * impulse;
          const lateralKick = currentSpeed * (0.010 + car.rng() * 0.022) * effectiveSeverity;
          car.vx += rightX * direction * lateralKick;
          car.vy += rightY * direction * lateralKick;
          car.surfaceKickCooldown = 0.65 + car.rng() * 0.9;
        }
      }
    }

    if ((car.isBot || car.temporaryAutopilot)
      && car.offroadTimer > 1.6
      && Math.hypot(car.vx, car.vy) < 48) {
      const point = surface.nearest.point;
      const lane = car.pitState === "track" ? clamp(car.botLaneBias || 0, -0.14, 0.14) * this.track.width : 0;
      car.x = point.x + point.nx * lane;
      car.y = point.y + point.ny * lane;
      car.angle = Math.atan2(point.ty, point.tx);
      car.vx = point.tx * 58;
      car.vy = point.ty * 58;
      car.angularVelocity = 0;
      car.botSteer = 0;
      car.botThrottle = 0.42;
      car.botReverseTimer = 0;
      car.botStuckTimer = 0;
      car.offroadTimer = 0;
      car.routeContext = null;
      return;
    }

    // Collision ownership follows the asphalt footprint under the car, not only
    // the pit state machine. A human can be physically on the pit ribbon for a
    // few frames before the swept entry gate commits the route; using only the
    // main-track rails in that interval made the visible pit walls non-solid.
    // Selecting the same route that supplied the surface query keeps the merge
    // open while restoring both pit walls everywhere the pit ribbon is distinct.
    const physicalRouteCandidate = surface.route === "pit" ? pitCandidate : mainCandidate;
    const wallCandidates = [physicalRouteCandidate ?? (committedToPit ? pitCandidate : mainCandidate)].filter(Boolean);
    this.#resolveWallCollisions(car, wallCandidates, previousPosition, dt);
    this.#resolveSceneryCollisions(car, previousPosition, dt);
  }

  #updateLap(car, forwardSpeed) {
    const reachesGate = (sectorIndex) => {
      const sector = this.track.sectors[sectorIndex];
      if (!sector) return false;
      const gate = sampleTrack(this.track, sector.sampleIndex);
      const dx = car.x - gate.x;
      const dy = car.y - gate.y;
      const along = dot(dx, dy, gate.tx, gate.ty);
      const lateral = dot(dx, dy, gate.nx, gate.ny);
      const tangentSpeed = dot(car.vx, car.vy, gate.tx, gate.ty);
      const alongTolerance = Math.max(38, this.track.width * 0.22);
      const lateralTolerance = this.track.width * 0.5 + Number(gate.grassWidth ?? this.track.grassWidth ?? 0) + car.physics.radius;
      return Math.abs(along) <= alongTolerance
        && Math.abs(lateral) <= lateralTolerance
        && tangentSpeed > -30
        && forwardSpeed > -10;
    };

    const nearStart = reachesGate(0);
    if (!nearStart) car.startGateArmed = true;
    const crossedStart = nearStart && car.startGateArmed;
    if (crossedStart) car.startGateArmed = false;

    if (!car.startedLap) {
      if (crossedStart) {
        car.startedLap = true;
        car.nextSector = 1;
        car.lapStartedAt = this.time;
      }
      return;
    }

    if (car.nextSector > 0 && car.nextSector < this.track.sectors.length && reachesGate(car.nextSector)) {
      car.nextSector += 1;
    }
    if (crossedStart) this.#registerStartCrossing(car);
  }

  #registerStartCrossing(car) {
    if (!car.startedLap) {
      car.startedLap = true;
      car.nextSector = 1;
      car.lapStartedAt = this.time;
      return;
    }
    if (car.nextSector < this.track.sectors.length) {
      car.cleanLap = false;
      return;
    }

    const lapTime = Math.max(0, this.time - car.lapStartedAt);
    car.lastLapTime = lapTime;
    car.bestLapTime = Number.isFinite(car.bestLapTime) ? Math.min(car.bestLapTime, lapTime) : lapTime;
    car.lapStartedAt = this.time;
    car.lap += 1;
    car.nextSector = 1;
    if (car.resolved.traits.lapRepair && car.cleanLap) {
      car.health = Math.min(car.physics.maxHealth, car.health + car.physics.maxHealth * 0.06);
    }
    car.cleanLap = true;

    if (car.lap >= this.laps) {
      if (car.pitStopsCompleted >= car.pitStopsRequired) {
        this.#finishCar(car);
      } else {
        car.lap = this.laps - 1;
        car.finishBlocked = true;
      }
    }
  }

  #applyPassiveTraits(car, nearest, steering, dt) {
    const speed = Math.hypot(car.vx, car.vy);
    const hasCornerEffect = car.resolved.traits.cornerCharge || car.resolved.traits.exitBurst;
    if (hasCornerEffect) {
      const turning = Math.abs(steering) > 0.45 && speed > car.physics.maxSpeed * 0.38;
      if (turning && Math.abs(nearest.signedDistance) < this.track.width * 0.28) {
        car.cornerAccumulator += dt;
      } else if (car.cornerAccumulator > 0.55) {
        if (car.resolved.traits.cornerCharge) {
          car.charge = Math.min(car.physics.maxCharge, car.charge + 5 * car.resolved.traits.cornerCharge);
        }
        if (car.resolved.traits.exitBurst) car.burstTimer = 0.45;
        car.cornerAccumulator = 0;
      } else {
        car.cornerAccumulator = Math.max(0, car.cornerAccumulator - dt * 2);
      }
    }

    if (car.resolved.traits.regeneration && this.time - car.lastCollisionAt > 4) {
      car.health = Math.min(car.physics.maxHealth, car.health + car.physics.maxHealth * 0.006 * car.resolved.traits.regeneration * dt);
    }
  }

  #finishCar(car) {
    car.finished = true;
    car.finishTime = this.time;
    car.place = this.finishOrder.length + 1;
    this.finishOrder.push(car.id);
    car.currentInput = neutralInput();
    car.boostActive = false;
  }

  #damage(car, amount) {
    if (amount <= 0.25 || car.finished || car.disabled) return;
    car.cleanLap = false;
    car.lastCollisionAt = this.time;
    let damage = amount * car.physics.collisionResistance;

    const criticalThreshold = car.physics.maxHealth * 0.25;
    const wasCritical = car.health <= criticalThreshold;
    const nextHealth = car.health - damage;
    if (wasCritical && car.criticalGrace) car.criticalGrace = false;
    if (!wasCritical && nextHealth <= criticalThreshold && car.resolved.traits.ignoreFirstCritical && !car.criticalIgnored) {
      car.criticalIgnored = true;
      car.criticalGrace = true;
    }
    car.health = nextHealth;

    if (car.health <= 0 && car.resolved.traits.emergencyRepair && !car.emergencyUsed) {
      car.emergencyUsed = true;
      car.health = car.physics.maxHealth * 0.28;
      car.criticalGrace = false;
      car.vx *= 0.35;
      car.vy *= 0.35;
      return;
    }
    if (car.health <= 0) {
      car.health = 0;
      car.disabled = true;
      car.respawnTimer = 3.2 / Math.max(0.6, car.physics.recovery);
      car.vx *= 0.25;
      car.vy *= 0.25;
    }
  }

  #resolveCarCollisions() {
    for (let i = 0; i < this.cars.length; i += 1) {
      const a = this.cars[i];
      if (a.disabled || a.finished || a.pitState === "service") continue;
      for (let j = i + 1; j < this.cars.length; j += 1) {
        const b = this.cars[j];
        if (b.disabled || b.finished || b.pitState === "service") continue;
        if ((a.pitState === "track") !== (b.pitState === "track")) continue;

        const capsuleA = carCapsule(a);
        const capsuleB = carCapsule(b);
        const closest = closestPointsBetweenSegments(capsuleA.start, capsuleA.end, capsuleB.start, capsuleB.end);
        let dx = closest.b.x - closest.a.x;
        let dy = closest.b.y - closest.a.y;
        const minimumDistance = capsuleA.halfWidth + capsuleB.halfWidth;
        let distance = Math.hypot(dx, dy);
        if (distance >= minimumDistance) continue;
        if (distance < 0.001) {
          dx = b.x - a.x;
          dy = b.y - a.y;
          distance = Math.hypot(dx, dy);
          if (distance < 0.001) {
            const angle = ((i + 1) * 1.618 + (j + 1) * 0.731) % (Math.PI * 2);
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            distance = 1;
          }
        }
        const nx = dx / distance;
        const ny = dy / distance;
        const penetration = minimumDistance - distance;
        const inverseMassA = Math.max(0.000001, Number(a.physics.sideYieldFactor) || 1) / Math.max(1, Number(a.physics.mass) || 1);
        const inverseMassB = Math.max(0.000001, Number(b.physics.sideYieldFactor) || 1) / Math.max(1, Number(b.physics.mass) || 1);
        const inverseInertiaA = 1 / Math.max(1, Number(a.physics.momentOfInertia) || 1);
        const inverseInertiaB = 1 / Math.max(1, Number(b.physics.momentOfInertia) || 1);
        const inverseMassSum = inverseMassA + inverseMassB;
        const correction = Math.max(0, penetration - 0.35) * 0.82 / Math.max(1e-8, inverseMassSum);
        a.x -= nx * correction * inverseMassA;
        a.y -= ny * correction * inverseMassA;
        b.x += nx * correction * inverseMassB;
        b.y += ny * correction * inverseMassB;

        const contactX = (closest.a.x + nx * capsuleA.halfWidth + closest.b.x - nx * capsuleB.halfWidth) * 0.5;
        const contactY = (closest.a.y + ny * capsuleA.halfWidth + closest.b.y - ny * capsuleB.halfWidth) * 0.5;
        const velocityA = velocityAtPoint(a, contactX, contactY);
        const velocityB = velocityAtPoint(b, contactX, contactY);
        const relativeX = velocityB.x - velocityA.x;
        const relativeY = velocityB.y - velocityA.y;
        const closingVelocity = dot(relativeX, relativeY, nx, ny);
        if (closingVelocity >= 0) continue;

        const aForwardX = Math.cos(a.angle);
        const aForwardY = Math.sin(a.angle);
        const bForwardX = Math.cos(b.angle);
        const bForwardY = Math.sin(b.angle);
        const aAlignment = Math.max(0, dot(aForwardX, aForwardY, nx, ny));
        const bAlignment = Math.max(0, dot(bForwardX, bForwardY, -nx, -ny));
        const aRam = a.currentInput?.ram ? a.physics.ramPower * (this.time < a.retaliationUntil ? 1.16 : 1) : 1;
        const bRam = b.currentInput?.ram ? b.physics.ramPower * (this.time < b.retaliationUntil ? 1.16 : 1) : 1;

        const raX = contactX - a.x;
        const raY = contactY - a.y;
        const rbX = contactX - b.x;
        const rbY = contactY - b.y;
        const raNormal = cross(raX, raY, nx, ny);
        const rbNormal = cross(rbX, rbY, nx, ny);
        const denominator = inverseMassA + inverseMassB
          + raNormal * raNormal * inverseInertiaA
          + rbNormal * rbNormal * inverseInertiaB;
        const impactSpeed = -closingVelocity;
        const restitution = clamp(0.08 + impactSpeed / 2400, 0.08, 0.24);
        const blast = 1 + Math.max(Number(a.resolved.traits.collisionBlast) || 0, Number(b.resolved.traits.collisionBlast) || 0);
        const ramImpulse = 1 + Math.max(aAlignment * (aRam - 1), bAlignment * (bRam - 1)) * 0.42;
        const normalImpulse = -(1 + restitution) * closingVelocity / Math.max(1e-8, denominator) * blast * ramImpulse;
        const impulseX = nx * normalImpulse;
        const impulseY = ny * normalImpulse;
        a.vx -= impulseX * inverseMassA;
        a.vy -= impulseY * inverseMassA;
        b.vx += impulseX * inverseMassB;
        b.vy += impulseY * inverseMassB;
        a.angularVelocity -= cross(raX, raY, impulseX, impulseY) * inverseInertiaA;
        b.angularVelocity += cross(rbX, rbY, impulseX, impulseY) * inverseInertiaB;

        const tangentX = -ny;
        const tangentY = nx;
        const postA = velocityAtPoint(a, contactX, contactY);
        const postB = velocityAtPoint(b, contactX, contactY);
        const tangentSpeed = dot(postB.x - postA.x, postB.y - postA.y, tangentX, tangentY);
        const raTangent = cross(raX, raY, tangentX, tangentY);
        const rbTangent = cross(rbX, rbY, tangentX, tangentY);
        const tangentDenominator = inverseMassA + inverseMassB
          + raTangent * raTangent * inverseInertiaA
          + rbTangent * rbTangent * inverseInertiaB;
        const rawFrictionImpulse = -tangentSpeed / Math.max(1e-8, tangentDenominator);
        const frictionImpulse = clamp(rawFrictionImpulse, -normalImpulse * 0.52, normalImpulse * 0.52);
        const frictionX = tangentX * frictionImpulse;
        const frictionY = tangentY * frictionImpulse;
        a.vx -= frictionX * inverseMassA;
        a.vy -= frictionY * inverseMassA;
        b.vx += frictionX * inverseMassB;
        b.vy += frictionY * inverseMassB;
        a.angularVelocity -= cross(raX, raY, frictionX, frictionY) * inverseInertiaA;
        b.angularVelocity += cross(rbX, rbY, frictionX, frictionY) * inverseInertiaB;

        const baseDamage = Math.max(0, impactSpeed - 10) * 0.105 + impactSpeed * impactSpeed * 0.00016;
        const damageToB = baseDamage * (0.72 + aAlignment * 0.78) * aRam * Math.sqrt(a.physics.mass / b.physics.mass);
        const damageToA = baseDamage * (0.72 + bAlignment * 0.78) * bRam * Math.sqrt(b.physics.mass / a.physics.mass);
        this.#damage(a, damageToA * (1 - aAlignment * 0.20));
        this.#damage(b, damageToB * (1 - bAlignment * 0.20));
        a.cleanLap = false;
        b.cleanLap = false;

        if (a.resolved.traits.retaliation) a.retaliationUntil = this.time + 1.8;
        if (b.resolved.traits.retaliation) b.retaliationUntil = this.time + 1.8;
      }
    }
  }

  #botShouldPit(car) {
    return shouldBotPit(car, this.laps);
  }

  #botInput(car, dt, routeContext) {
    return computeBotInput({
      car,
      dt,
      routeContext,
      track: this.track,
      cars: this.cars,
      laps: this.laps,
      tick: this.tick
    });
  }

  #updateRaceOrder() {
    const unfinished = this.cars.filter((car) => !car.finished);
    unfinished.sort((a, b) => {
      const distanceDelta = b.raceDistance - a.raceDistance;
      if (Math.abs(distanceDelta) > 1e-6) return distanceDelta;
      if (b.lap !== a.lap) return b.lap - a.lap;
      if (b.nextSector !== a.nextSector) return b.nextSector - a.nextSector;
      return String(a.id).localeCompare(String(b.id));
    });
    unfinished.forEach((car, index) => {
      car.place = this.finishOrder.length + index + 1;
    });
  }

  snapshot() {
    return {
      tick: this.tick,
      simulationTime: this.simulationTime,
      time: this.time,
      countdown: this.countdown,
      started: this.started,
      finished: this.finished,
      laps: this.laps,
      requiredPitStops: this.requiredPitStops,
      finishOrder: [...this.finishOrder],
      cars: this.cars.map((car) => ({
        id: car.id,
        x: car.x,
        y: car.y,
        vx: car.vx,
        vy: car.vy,
        angle: car.angle,
        health: car.health,
        maxHealth: car.physics.maxHealth,
        charge: car.charge,
        maxCharge: car.physics.maxCharge,
        heat: car.heat,
        overheated: car.overheated,
        lap: car.lap,
        progress: car.progress,
        raceDistance: car.raceDistance,
        nextSector: car.nextSector,
        currentLapTime: Math.max(0, this.time - car.lapStartedAt),
        lastLapTime: car.lastLapTime,
        bestLapTime: car.bestLapTime,
        place: car.place,
        finished: car.finished,
        finishTime: car.finishTime,
        finishBlocked: car.finishBlocked,
        disabled: car.disabled,
        color: car.color,
        name: car.name,
        driverName: car.driverName,
        isBot: car.isBot,
        temporaryAutopilot: car.temporaryAutopilot,
        abandoned: car.abandoned,
        heatWarning: Boolean(car.resolved.traits.heatWarning),
        ram: Boolean(car.currentInput?.ram),
        boost: Boolean(car.boostActive),
        pitState: car.pitState,
        pitProgress: car.pitProgress,
        pitInServiceZone: car.pitState !== "track" && this.#isInsidePitServiceZone(car),
        pitStopsRequired: car.pitStopsRequired,
        pitStopsCompleted: car.pitStopsCompleted,
        pitWord: car.pitState === "service" ? car.pitWord : null,
        pitAttemptId: car.pitState === "service" ? car.pitAttemptId : null,
        inputSequence: car.lastInputSequence,
        surfaceSeverity: car.surfaceSeverity,
        driftAmount: car.driftAmount,
        slipAngle: car.slipAngle,
        wallContactTimer: car.wallContactTimer
      }))
    };
  }
}

export function neutralInput() {
  return { throttle: 0, steer: 0, brake: false, reverse: false, boost: false, ram: false, drift: false };
}

export function sanitizeInput(input = {}) {
  return {
    throttle: clamp(Number(input.throttle) || 0, -1, 1),
    steer: clamp(Number(input.steer) || 0, -1, 1),
    brake: Boolean(input.brake),
    reverse: Boolean(input.reverse),
    boost: Boolean(input.boost),
    ram: Boolean(input.ram),
    drift: Boolean(input.drift)
  };
}
