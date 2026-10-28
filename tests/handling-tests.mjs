import assert from "node:assert/strict";
import { cloneDefaultBuild, resolveBuild } from "../scripts/catalog.js";
import { deriveCarPhysics, buildRaceCarMeta, neutralInput, RaceSimulation } from "../scripts/physics.js";
import { advanceCarMotion } from "../scripts/physics/car-motion.js";
import { computeBotInput } from "../scripts/physics/bot-controller.js";
import { generateTrack, sampleTrack, nearestTrackPoint } from "../scripts/track.js";

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

// Acceptance ranges describe the agreed arcade/realism compromise. Measure
// actual motion, not just constants, so a second force cannot silently undo it.
{
  const car = carAt(0);
  let reached100 = null;
  for (let tick = 0; tick < 60 * 60; tick++) {
    step(car, { throttle: 1 });
    if (reached100 == null && car.vx * kmh >= 100) reached100 = (tick + 1) * dt;
  }
  assert.ok(reached100 >= 6 && reached100 <= 8, `base 0–100 left its 6–8 s range: ${reached100}`);
  assert.ok(Math.abs(car.vx * kmh - 123.2) < 0.5, "softer launch changed base straight-line top speed");
  const braking = carAt(80 / kmh);
  for (let tick = 0; tick < 8 * 60 && braking.vx > 0.01; tick++) step(braking, { brake: true });
  const distanceMetres = braking.x * kmh / 3.6;
  assert.ok(distanceMetres >= 25 && distanceMetres <= 35, `80–0 braking distance: ${distanceMetres}`);
  const turning = carAt(80 / kmh);
  let lateralG = 0;
  for (let tick = 0; tick < 60; tick++) {
    const vx = turning.vx, vy = turning.vy;
    step(turning, { throttle: 1, steer: 1 });
    if (tick >= 30) lateralG += Math.abs(vx * (turning.vy - vy) - vy * (turning.vx - vx))
      / Math.hypot(vx, vy) / dt * (kmh / 3.6) / 9.81 / 30;
  }
  assert.ok(lateralG >= 2.4 && lateralG <= 3.3, `base racing grip left its target: ${lateralG} g`);
}

// Softer engines must still overcome passive losses in a genuine low-torque
// build; retaining only the displayed speed rating would hide a reduced top end.
{
  const weakBuild = { ...cloneDefaultBuild(), frame: "turtle", core: "choir",
    transmission: "long", running: "heavy", body: "armored" };
  const weak = resolveBuild(weakBuild);
  const p = deriveCarPhysics(weak);
  const car = { ...carAt(0), health: p.maxHealth, maxHealth: p.maxHealth,
    charge: p.maxCharge, maxCharge: p.maxCharge };
  for (let tick = 0; tick < 90 * 60; tick++) {
    advanceCarMotion(car, { ...neutralInput(), throttle: 1 }, p, dt, { traits: weak.traits });
  }
  assert.ok(Math.abs(car.vx - p.maxSpeed) < 1, "low-torque build cannot attain its advertised top speed");
}

// A bot must brake for a curve that its own low-grip tyres cannot sustain.
// The same curve is safe with the high-grip build at the same approach speed.
{
  const track = generateTrack("bot-tyre-budget", 3);
  const simulation = new RaceSimulation({ track, entries: [{ id: "bot", build, isBot: true, botSkill: 3 }] });
  const point = sampleTrack(track, 80);
  const run = (lateralGrip) => {
    const car = { ...simulation.cars[0], physics: { ...simulation.cars[0].physics, lateralGrip } };
    Object.assign(car, { x: point.x, y: point.y, angle: Math.atan2(point.ty, point.tx),
      vx: point.tx * 300, vy: point.ty * 300, botLaneBias: 0, botPhase: 0,
      botCurvature: 0.0025, botSteer: 0, botThrottle: 0.6 });
    return computeBotInput({ car, dt, track, cars: [car], laps: 3, tick: 1,
      routeContext: { mainNearest: nearestTrackPoint(track, car.x, car.y), pitNearest: null } });
  };
  assert.equal(run(2).brake, true, "low-grip bot ignored the corner's tyre demand");
  assert.equal(run(8).brake, false, "high-grip bot did not retain its cornering advantage");
}

// Every frame must hold ordinary steering without a large unrequested slide;
// the dedicated drift key must still give a distinct, recoverable slide.
for(const frame of ['allantry','arrow','spider','keel','bull','turtle']) {
  const resolved=resolveBuild({...cloneDefaultBuild(),frame}),p=deriveCarPhysics(resolved);
  const run=(car,input)=>advanceCarMotion(car,{...neutralInput(),...input},p,dt,{traits:resolved.traits});
  const ordinary={...carAt(80/kmh),health:p.maxHealth,charge:p.maxCharge};
  let largestSlip=0;
  for(let tick=0;tick<60;tick++) {run(ordinary,{throttle:1,steer:1});largestSlip=Math.max(largestSlip,Math.abs(ordinary.slipAngle));}
  assert.equal(ordinary.driftAmount,0,frame+' entered drift without Ctrl');
  assert.ok(largestSlip<7*Math.PI/180,frame+' developed excessive ordinary sideslip');
  const drift={...carAt(80/kmh),health:p.maxHealth,charge:p.maxCharge};
  for(let tick=0;tick<70;tick++)run(drift,{throttle:.62,steer:.85,drift:true});
  assert.ok(drift.driftAmount>.2 && Math.abs(drift.slipAngle)>largestSlip*1.5,frame+' lost intentional drift');
  const disturbed={...carAt(80/kmh),vy:70,health:p.maxHealth,charge:p.maxCharge};
  for(let tick=0;tick<48;tick++)run(disturbed,{throttle:.5});
  assert.ok(Math.abs(disturbed.slipAngle)<Math.PI/180,frame+' failed to recover a lateral disturbance');
}

console.log("handling-tests: ok (balance targets, momentum, brake priority, reverse, pit limiter, bot tyre budget)");
