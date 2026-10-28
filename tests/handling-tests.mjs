import assert from "node:assert/strict";
import { cloneDefaultBuild, resolveBuild } from "../scripts/catalog.js";
import { deriveCarPhysics, buildRaceCarMeta, neutralInput } from "../scripts/physics.js";
import { advanceCarMotion } from "../scripts/physics/car-motion.js";

const build = cloneDefaultBuild();
const resolved = resolveBuild(build);
const physics = deriveCarPhysics(resolved);
const meta = buildRaceCarMeta({ id: "handling", build });
const dt = 1 / 60;
const kmh = 0.62 / 3;
const carAt = (speed) => ({ ...meta, x: 0, y: 0, vx: speed, vy: 0, angle: 0,
  angularVelocity: 0, steeringPosition: 0, lastSteer: 0, driftAmount: 0,
  driftDirection: 0, slipAngle: 0, health: physics.maxHealth, charge: physics.maxCharge,
  heat: 0, overheated: false, pitState: "track", surfaceType: "road", surfaceSeverity: 0, lap: 0 });
const step = (car, input = {}) => advanceCarMotion(car, { ...neutralInput(), ...input }, physics, dt,
  { traits: resolved.traits, laps: 3, pit: { speedLimit: 60 / kmh, speedLimitDeceleration: 96 } });

// Losing engine power must preserve stored momentum. The old clamp discarded
// 10-30 km/h in one tick after boost, heat lockout or a small change of surface.
for (const event of ["boost-release", "thermal-lockout", "charge-empty", "grass-edge"]) {
  const car = carAt(physics.maxSpeed * 1.12);
  if (event === "thermal-lockout") car.heat = 99.9;
  if (event === "charge-empty") car.charge = physics.boostDrain * dt * 0.5;
  if (event === "grass-edge") {
    car.vx = physics.maxSpeed * 0.999;
    car.surfaceType = "grass"; car.surfaceSeverity = 0.05;
  }
  for (let tick = 0; tick < 2; tick++) {
    const prior = car.vx;
    step(car, { throttle: 1, boost: event === "thermal-lockout" || event === "charge-empty" });
    assert.ok((prior - car.vx) * kmh < 1, `${event} deleted momentum in one tick`);
  }
  if (event === "thermal-lockout") {
    assert.equal(car.overheated, true);
    assert.equal(car.boostActive, false);
  }
  if (event === "charge-empty") assert.equal(car.charge, 0);
}

// Preserving excess momentum must not become an unlimited boost exploit:
// throttle cannot accelerate beyond its ceiling and drag eventually removes it.
{
  const car = carAt(physics.maxSpeed * 1.12);
  let previous = car.vx;
  for (let tick = 0; tick < 8 * 60; tick++) {
    step(car, { throttle: 1 });
    assert.ok(car.vx <= previous + 1e-8 || car.vx < physics.maxSpeed,
      "throttle maintained an overspeed without boost");
    previous = car.vx;
  }
  assert.ok(car.vx <= physics.maxSpeed && car.vx > physics.maxSpeed * 0.98);
  const backwards = carAt(-physics.maxSpeed * 0.4);
  const prior = backwards.vx;
  step(backwards, { reverse: true });
  assert.ok((backwards.vx - prior) * kmh < 1, "reverse speed cap deleted collision momentum");
}

// A service brake and S must override held W/Space. A player must be able to
// stop while holding both pedals, without burning charge or launching backwards.
{
  const reference = carAt(80 / kmh);
  const gasBrake = carAt(reference.vx);
  const bothKeys = carAt(reference.vx);
  const charge = bothKeys.charge;
  for (let tick = 0; tick < 3 * 60; tick++) {
    step(reference, { brake: true });
    step(gasBrake, { throttle: 1, brake: true, boost: true });
    step(bothKeys, { throttle: 1, reverse: true, boost: true });
    assert.ok(Math.abs(gasBrake.vx - reference.vx) < 1e-8, "gas weakened the service brake");
    assert.ok(Math.abs(bothKeys.vx - reference.vx) < 1e-8, "W/Space defeated S braking");
  }
  assert.equal(bothKeys.vx, 0);
  assert.equal(bothKeys.charge, charge);
  assert.equal(bothKeys.boostActive, false);
  for (let tick = 0; tick < 60; tick++) step(bothKeys, { reverse: true });
  assert.ok(bothKeys.vx < -20, "releasing W did not allow S to select reverse");
}

// The pit limiter remains a stronger, progressive speed reduction; stored
// momentum must not bypass the 60 km/h limit or be deleted on entry.
{
  const car = carAt(100 / kmh);
  car.pitState = "entering";
  const prior = car.vx;
  step(car, { throttle: 1, boost: true });
  assert.ok(car.vx < prior && car.vx > 60 / kmh);
  for (let tick = 0; tick < 3 * 60; tick++) step(car, { throttle: 1 });
  assert.ok(car.vx <= 60 / kmh);
}

console.log("handling-tests: ok (momentum, thermal/charge transitions, brake priority, reverse, pit limiter)");
