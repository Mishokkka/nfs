import { applyDriveModel } from "./drive-model.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const TERRAIN_PROFILES = Object.freeze({
  road: { accelerationLoss: 0, steeringLoss: 0, topSpeedLoss: 0, gripLoss: 0, yawGain: 0, dampingShift: 0, dragBase: 0, dragStrength: 0 },
  grass: { accelerationLoss: 0.45, steeringLoss: 0.34, topSpeedLoss: 0.42, gripLoss: 0.72, yawGain: 0.48, dampingShift: -0.68, dragBase: 0.18, dragStrength: 1.38 },
  gravel: { accelerationLoss: 0.64, steeringLoss: 0.42, topSpeedLoss: 0.64, gripLoss: 0.66, yawGain: 0.22, dampingShift: -0.34, dragBase: 0.42, dragStrength: 2.82 },
  sand: { accelerationLoss: 0.86, steeringLoss: 0.46, topSpeedLoss: 0.82, gripLoss: 0.34, yawGain: -0.18, dampingShift: 1.18, dragBase: 0.70, dragStrength: 5.20 }
});

/** Derive deterministic grip, drag and steering multipliers from the last known
 * surface. Sand keeps crawl traction; grass loses more grip at high speed.
 * Used by authority and prediction with the same normalized contact severity.
 */
export function terrainModifiers(car, physics, speed = null) {
  const p = physics ?? car?.physics ?? {};
  const effective = clamp((Number(car?.surfaceSeverity) || 0) / Math.max(1, Number(p.offroadGrip) || 1), 0, 1);
  const currentSpeed = speed == null ? Math.hypot(car.vx || 0, car.vy || 0) : Math.abs(speed);
  const speedRatio = clamp(currentSpeed / Math.max(1, p.maxSpeed || 420), 0, 1.4);
  const type = TERRAIN_PROFILES[car.surfaceType] ? car.surfaceType : (effective > 0.001 ? "grass" : "road");
  const profile = TERRAIN_PROFILES[type];
  const highSpeed = clamp((speedRatio - 0.22) / 0.88, 0, 1);
  const gripLoss = type === "grass" ? profile.gripLoss * (0.52 + highSpeed * 0.72) : profile.gripLoss * (0.82 + highSpeed * 0.18);
  const sandCrawlAssist = type === "sand" ? effective * 0.52 * (1 - clamp(speedRatio / 0.20, 0, 1)) : 0;
  return {
    type, severity: effective, speedRatio,
    acceleration: Math.max(0.08, 1 - effective * profile.accelerationLoss + sandCrawlAssist),
    steering: Math.max(0.18, 1 - effective * profile.steeringLoss * (0.78 + highSpeed * 0.32)),
    topSpeed: Math.max(0.12, 1 - effective * profile.topSpeedLoss),
    grip: Math.max(0.06, 1 - effective * gripLoss),
    yawResponse: Math.max(0.28, 1 + effective * profile.yawGain * (0.42 + highSpeed * 0.78)),
    angularDamping: Math.max(0.16, 1 + effective * profile.dampingShift * (0.45 + highSpeed * 0.75)),
    dragRate: effective > 0.001 ? profile.dragBase * effective + profile.dragStrength * Math.pow(effective, 1.28) * (0.54 + speedRatio * 0.52) : 0
  };
}

/** Resources and all deterministic drive modifiers use the same path on both clients.
 * Collisions, route transitions, drafting and random terrain impulses stay authoritative.
 */
export function advanceCarMotion(car, input, p, dt, { traits = p, laps = 3, pit = {}, extraAcceleration = 0 } = {}) {
  const forwardSpeed = car.vx * Math.cos(car.angle) + car.vy * Math.sin(car.angle);
  const terrain = terrainModifiers(car, p, Math.abs(forwardSpeed));
  if (car.overheated && car.heat <= 48) car.overheated = false;
  const heatStress = clamp((car.heat - 68) / 32, 0, 1);
  const thermalAcceleration = car.overheated ? 0.58 : 1 - heatStress * 0.28;
  const thermalSteering = car.overheated ? 0.72 : 1 - heatStress * 0.13;
  const thermalTopSpeed = car.overheated ? 0.78 : 1 - heatStress * 0.08;
  const healthPenalty = car.health < p.maxHealth * 0.25 && !car.criticalGrace ? 0.78 : 1;
  const lastLapBoost = traits.lastLap && car.lap === laps - 1 ? 1.04 : 1;
  const lowHealthBoost = car.health < p.maxHealth * 0.3 ? Math.max(1, Number(traits.lowHealthBoost) || 1) : 1;
  if ((input.brake || ((input.reverse || input.throttle < 0) && forwardSpeed > 7)) && traits.recuperation && Math.abs(forwardSpeed) > 8) {
    car.charge = Math.min(p.maxCharge, car.charge + Math.abs(forwardSpeed) * 0.018 * traits.recuperation * dt);
  }
  car.boostActive = false;
  let boostAccelerationMultiplier = 0;
  let boostTopSpeedMultiplier = 1;
  if (car.pitState === "track" && input.boost && input.throttle > 0 && !car.overheated && car.charge > 0.001) {
    const requestedCharge = p.boostDrain * dt;
    const fraction = clamp(car.charge / Math.max(0.0001, requestedCharge), 0, 1);
    if (fraction > 0.001) {
      car.boostActive = true;
      boostAccelerationMultiplier = 0.95 * p.boostPower * lowHealthBoost * fraction;
      boostTopSpeedMultiplier = 1.17 * p.boostPower;
      car.charge = Math.max(0, car.charge - requestedCharge * fraction);
      car.heat = Math.min(112, car.heat + p.heatRate * dt * fraction);
    }
  }
  if (!car.boostActive) car.heat = Math.max(0, car.heat - p.cooling * dt);
  if (car.heat >= 100) {
    car.overheated = true;
    car.boostActive = false;
    boostTopSpeedMultiplier = 1;
  }
  for (const [timer, multiplier] of [["startBoostTimer", 0.3], ["burstTimer", 0.35]]) {
    if (car[timer] > 0) {
      car[timer] = Math.max(0, car[timer] - dt);
      extraAcceleration += p.acceleration * multiplier;
    }
  }
  const driftAssist = Math.max(0.75, Number(traits.drift) || 1);
  const drive = applyDriveModel(car, input, p, dt, {
    accelerationMultiplier: healthPenalty * thermalAcceleration * terrain.acceleration * lastLapBoost,
    steeringMultiplier: (input.ram ? (traits.ramSteerPenalty || 0.55) : 1) * thermalSteering * terrain.steering * (traits.precision ? 1.04 : 1),
    topSpeedMultiplier: thermalTopSpeed * terrain.topSpeed * lastLapBoost,
    gripMultiplier: terrain.grip,
    yawResponseMultiplier: terrain.yawResponse,
    angularDampingMultiplier: terrain.angularDamping,
    brakeGripMultiplier: traits.lateBrake ? 1.22 : 1,
    driftEnabled: car.pitState === "track" && terrain.type === "road" && !car.isBot && !car.temporaryAutopilot,
    driftAssist,
    driftControl: Math.max(0.45, Math.sqrt(p.spinResistance * p.recovery) * (1 + (driftAssist - 1) * 0.75)),
    extraAcceleration,
    boostAccelerationMultiplier,
    boostTopSpeedMultiplier,
    speedLimit: car.pitState !== "track" ? (pit.speedLimit ?? Infinity) : Infinity,
    speedLimitDeceleration: car.pitState !== "track" ? (pit.speedLimitDeceleration ?? 96) : 0,
    previousSteer: car.lastSteer,
    smoothSteer: Boolean(traits.smoothSteer)
  });
  if (terrain.type !== "road" || car.pitState !== "track") {
    car.driftAmount = Math.max(0, car.driftAmount - dt * 2.8);
    if (car.driftAmount <= 0.01) { car.driftAmount = 0; car.driftDirection = 0; }
  }
  return drive;
}
