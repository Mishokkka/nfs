import { deriveCarPhysics, neutralInput } from "../physics.js";
import { advanceCarMotion } from "./car-motion.js";
import { lateralAccelerationBudget } from "./drive-model.js";

const KMH = 0.62 / 3;
const METRES = KMH / 3.6;
const DT = 1 / 60;
const cache = new Map();

/** Flat, dry asphalt, full health, no boost or start bonuses. Same drive model
 * as the race; at most two measurements per garage change, outside the race. */
export function estimateBuildPerformance(resolved) {
  const physics = deriveCarPhysics(resolved);
  const key = JSON.stringify([physics, resolved.traits]);
  if (cache.has(key)) {
    const value = cache.get(key);
    cache.delete(key); cache.set(key, value);
    return value;
  }
  const carAt = speed => ({ x: 0, y: 0, vx: speed, vy: 0, angle: 0, angularVelocity: 0,
    steeringPosition: 0, lastSteer: 0, driftAmount: 0, driftDirection: 0,
    health: physics.maxHealth, charge: physics.maxCharge, heat: 0, overheated: false,
    pitState: "track", surfaceType: "road", surfaceSeverity: 0, lap: 0 });
  const run = (car, input) => advanceCarMotion(car, { ...neutralInput(), ...input }, physics, DT,
    { traits: resolved.traits, laps: 3 });
  const launch = carAt(0);
  let zeroTo100 = null;
  if (physics.maxSpeed * KMH > 100) for (let tick = 0; tick < 60 * 60; tick++) {
    const previous = launch.vx;
    run(launch, { throttle: 1 });
    if (launch.vx * KMH >= 100) {
      zeroTo100 = (tick + (100 / KMH - previous) / (launch.vx - previous)) * DT;
      break;
    }
  }
  const braking = carAt(80 / KMH);
  for (let tick = 0; tick < 10 * 60 && braking.vx > 0; tick++) {
    run(braking, { brake: true });
  }
  const brakingDistance = braking.x * METRES;
  const value = Object.freeze({ maxSpeed: physics.maxSpeed * KMH, zeroTo100, brakingDistance,
    lateralBudget: lateralAccelerationBudget(physics) * METRES / 9.81,
    maxHealth: physics.maxHealth, maxCharge: physics.maxCharge });
  cache.set(key, value);
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return value;
}

const METRICS = [
  ["maxSpeed", "Предел скорости без форсажа", "Скорость", "км/ч", 0, 1],
  ["zeroTo100", "Разгон с места до 100 км/ч без форсажа", "0–100", "с", 1, -1],
  ["brakingDistance", "Тормозной путь с 80 км/ч до остановки, без времени реакции", "80–0", "м", 1, -1],
  ["lateralBudget", "Предел бокового ускорения шин на сухом асфальте, без одновременного торможения", "Сцепление", "g", 2, 1],
  ["maxHealth", "Максимальная прочность", "Прочность", "", 0, 1],
  ["maxCharge", "Максимальный заряд", "Заряд", "", 0, 1]
];

export function compareBuildPerformance(resolved, baseline) {
  const current = estimateBuildPerformance(resolved), saved = estimateBuildPerformance(baseline);
  return METRICS.map(([key, label, shortLabel, unit, digits, direction]) => {
    const value = current[key], before = saved[key];
    const delta = value == null || before == null ? null : Number((value - before).toFixed(digits));
    const changedReachability = (value == null) !== (before == null);
    const comparison = changedReachability ? (value == null ? "Теперь недоступно" : "Теперь достигается")
      : delta ? `${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(digits)} ${unit}`.trim() : "";
    return { key, label, shortLabel, value: value == null ? "—" : `${value.toFixed(digits)} ${unit}`.trim(),
      comparison, comparisonClass: comparison ? ((changedReachability ? value != null : delta * direction > 0) ? "is-better" : "is-worse") : "",
      tooltip: `${label}${key === "zeroTo100" && value == null ? ". Эта сборка не достигает 100 км/ч за 60 с" : ""}. До изменения: ${before == null ? "недоступно" : `${before.toFixed(digits)} ${unit}`.trim()}.` };
  });
}
