import assert from "node:assert/strict";
import { LocalPrediction } from "../scripts/netcode/local-prediction.js";
import { advanceCarMotion } from "../scripts/physics/car-motion.js";
import { applyDriveModel } from "../scripts/physics/drive-model.js";
import { RaceSimulation, neutralInput, buildRaceCarMeta } from "../scripts/physics.js";
import { cloneDefaultBuild } from "../scripts/catalog.js";
import { generateTrack, seededRng } from "../scripts/track.js";

globalThis.foundry = { utils: { deepClone: structuredClone } };
const entry = { id: "car", userId: "player", build: cloneDefaultBuild() };
const meta = buildRaceCarMeta(entry);
const initial = () => ({ ...meta, x: 0, y: 0, vx: 220, vy: 0, angle: 0, angularVelocity: 0,
  steeringPosition: 0, lastSteer: 0, driftAmount: 0, driftDirection: 0, slipAngle: 0,
  health: meta.maxHealth, charge: meta.maxCharge, heat: 0, overheated: false,
  pitState: "track", lap: 0, surfaceType: "road", surfaceSeverity: 0, inputSequence: -1 });
const frame = (car, tick, time) => ({ cars: [{ ...car }], tick, simulationTime: time, time, laps: 3, started: true });
const physics = { ...meta.prediction, maxHealth: meta.maxHealth, maxCharge: meta.maxCharge };

// Replay one acknowledged state plus a later turn. Presentation frequency must
// not change the physical result, and pending input reacts without an RTT wait.
{
  const car = initial(), predictors = [new LocalPrediction(), new LocalPrediction()];
  const input = { ...neutralInput(), throttle: 1, steer: 0.7 };
  for (const predictor of predictors) predictor.submit(input, 1, 120);
  for (const [index, fps] of [60, 144].entries()) {
    for (let now = 0; now < 200; now += 1000 / fps) predictors[index].sample(car, frame(car, 0, 0), { now, clockOffset: 0 });
    predictors[index].sample(car, frame(car, 0, 0), { now: 200, clockOffset: 0 });
  }
  assert.deepEqual(predictors[0].state, predictors[1].state, "physical replay depends on display refresh rate");
  const immediate = new LocalPrediction(); immediate.submit(input, 1, 120);
  immediate.sample(car, frame(car, 0, 0), { now: 121, clockOffset: 0 });
  assert.ok(immediate.state.steeringPosition > 0, "pending turn waited for authority");
  const acked = { ...car, inputSequence: 1 };
  const pending = new LocalPrediction();
  pending.submit({ ...neutralInput(), throttle: 1 }, 1, 0);
  pending.submit({ ...neutralInput(), throttle: 1, steer: -1 }, 2, 140);
  const originalAcked = structuredClone(acked);
  pending.sample(acked, frame(acked, 6, 0.1), { now: 180, clockOffset: 0 });
  assert.ok(pending.state.steeringPosition < 0, "unacknowledged input was discarded during reconciliation");
  assert.deepEqual(acked, originalAcked, "replay mutated the source snapshot");
}

// Shared modifiers are exercised through the real authoritative simulation and
// the prediction path, including a hot/damaged car in a deliberate drift.
{
  const simulation = new RaceSimulation({ track: generateTrack(88201, 2), entries: [entry] });
  simulation.started = true; simulation.countdown = 0;
  const car = simulation.cars[0];
  car.vx = Math.cos(car.angle) * 190; car.vy = Math.sin(car.angle) * 190;
  car.health = car.physics.maxHealth * 0.22; car.heat = 75;
  const before = simulation.snapshot().cars[0];
  const input = { ...neutralInput(), throttle: 0.6, steer: 0.4, drift: true };
  simulation.setInput(car.id, input, 1); simulation.step(1 / 60);
  const prediction = new LocalPrediction(); prediction.submit(input, 1, 0);
  prediction.sample({ ...before, inputSequence: -1 }, frame(before, 0, 0), { now: 1000 / 60, clockOffset: 0 });
  for (const key of ["vx", "vy", "angle", "angularVelocity", "driftAmount", "steeringPosition", "heat", "charge"]) {
    assert.ok(Math.abs(car[key] - prediction.state[key]) < 1e-7, `authority/prediction ${key}: ${car[key]}/${prediction.state[key]}`);
  }
}

// Steering is progressive, cannot turn a stationary car, reverses naturally in
// reverse gear, and finite tyre forces prevent unlimited high-speed cornering.
{
  const parked = initial(); parked.vx = 0;
  for (let i = 0; i < 60; i++) applyDriveModel(parked, { ...neutralInput(), steer: 1 }, physics, 1 / 60);
  assert.equal(parked.angle, 0);
  const forward = initial(), reverse = { ...initial(), vx: -80 };
  applyDriveModel(forward, { ...neutralInput(), steer: 1 }, physics, 1 / 60);
  applyDriveModel(reverse, { ...neutralInput(), steer: 1 }, physics, 1 / 60);
  assert.ok(forward.steeringPosition > 0 && forward.steeringPosition < 0.5);
  assert.ok(forward.angularVelocity > 0 && reverse.angularVelocity < 0);
  const fast = { ...initial(), vx: 500 }, slow = { ...initial(), vx: 180 };
  for (let i = 0; i < 45; i++) {
    applyDriveModel(fast, { ...neutralInput(), steer: 1, throttle: 1 }, physics, 1 / 60);
    applyDriveModel(slow, { ...neutralInput(), steer: 1, throttle: 1 }, physics, 1 / 60);
  }
  const radius = state => Math.hypot(state.vx, state.vy) / Math.max(0.001, Math.abs(state.angularVelocity));
  assert.ok(radius(fast) > radius(slow) * 1.5, "fast full-lock corner has no wider turning radius");
  const braking = { ...initial(), vx: 2 };
  for (let i = 0; i < 30; i++) applyDriveModel(braking, { ...neutralInput(), brake: true }, physics, 1 / 60);
  assert.ok(braking.vx >= 0, "braking launched the car backwards");
}

// Wall-contact gating must not move the car between the raw and predicted poses
// in one frame. Exercise both transitions, threshold chatter and pit authority.
{
  const prediction = new LocalPrediction();
  let previous = null, maximumStep = 0, blockedFrames = 0;
  for (let index = 0; index < 80; index++) {
    const now = 1000 + index * 1000 / 60;
    const sourceTime = (1000 + Math.floor(index / 2) * 1000 / 30) / 1000 - 0.12;
    const car = { ...initial(), x: sourceTime * 400, vx: 400,
      wallContactTimer: index >= 8 && index < 24 ? (index % 4 < 2 ? 0.021 : 0.019) : 0,
      prediction: { ...meta.prediction, longitudinalDrag: 0, rollingDrag: 0 } };
    const displayed = prediction.sample(car, frame(car, Math.floor(index / 2), sourceTime), { now, clockOffset: 0 });
    if (previous) maximumStep = Math.max(maximumStep, Math.abs(displayed.x - previous.x));
    if (prediction.blocked) {
      blockedFrames++;
      assert.equal(prediction.state.x, car.x, "contact smoothing leaked into physical state");
    }
    previous = displayed;
  }
  assert.ok(blockedFrames >= 20, "contact gate chattered instead of waiting for stable clearance");
  assert.ok(!prediction.blocked, "prediction did not resume after contact cleared");
  assert.ok(maximumStep < 22, `wall contact caused a visible snap: ${maximumStep}`);
  const serviced = { ...initial(), x: 2000, pitState: "service" };
  const displayed = prediction.sample(serviced, frame(serviced, 90, 2), { now: 2200, clockOffset: 0 });
  assert.equal(displayed.x, 2000, "pit service retained speculative motion");
}

// Deterministic latency/loss/reordering matrix, with the production drive core
// advancing authority at 60 Hz and prediction receiving compact-like snapshots.
const metrics = [];
for (const profile of [
  { name: "LAN", rtt: 10, jitter: 2, loss: 0 },
  { name: "WAN", rtt: 80, jitter: 15, loss: 0.02 },
  { name: "jitter", rtt: 160, jitter: 40, loss: 0.05 },
  { name: "slow", rtt: 260, jitter: 70, loss: 0.10 },
  { name: "pause", rtt: 100, jitter: 25, loss: 0.03, pause: true }
]) {
  const rng = seededRng("prediction-" + profile.name), prediction = new LocalPrediction();
  const car = initial(), queue = [];
  let activeInput = neutralInput(), sequence = 0, tick = 0, lastFrame = frame(car, 0, 0), lastReceived = 0;
  let nextPhysics = 0, nextRender = 0, previous = null, maximumStep = 0, maximumCorrection = 0, frozenAt = null;
  const commands = [
    [0, { throttle: 1 }], [900, { throttle: 1, steer: 0.4 }], [1500, { throttle: 1, steer: -0.3 }],
    [2200, { throttle: 1, steer: 0.8, drift: true }], [2700, { throttle: 0.3, steer: -0.5 }],
    [3500, { throttle: 1, boost: true }], [4100, { throttle: 1 }], [4800, {}]
  ];
  const deliver = (type, data, now) => {
    if (rng() < profile.loss) return;
    const delay = Math.max(0, profile.rtt * 0.5 + (rng() * 2 - 1) * profile.jitter);
    queue.push({ at: now + delay, type, data });
  };
  for (let now = 0; now <= 6000; now++) {
    while (commands.length && now >= commands[0][0]) {
      const [, raw] = commands.shift(), input = { ...neutralInput(), ...raw };
      prediction.submit(input, ++sequence, now); deliver("input", { input, sequence }, now);
    }
    queue.sort((a, b) => a.at - b.at);
    while (queue.length && queue[0].at <= now) {
      const message = queue.shift();
      if (message.type === "input") {
        if (message.data.sequence > car.inputSequence) { activeInput = message.data.input; car.inputSequence = message.data.sequence; }
      } else if (message.data.tick > lastFrame.tick) { lastFrame = message.data; lastReceived = now; }
    }
    if (now + 0.001 >= nextPhysics) {
      advanceCarMotion(car, activeInput, physics, 1 / 60, { laps: 3 });
      tick++; nextPhysics += 1000 / 60;
      if (tick % 2 === 0 && !(profile.pause && now >= 3000 && now <= 3500)) deliver("frame", frame(car, tick, tick / 60), now);
    }
    if (now + 0.001 >= nextRender) {
      const local = prediction.sample(lastFrame.cars[0], lastFrame, { now: now + 1000 / 60, clockOffset: 0, receivedAt: lastReceived });
      nextRender += 1000 / 120;
      assert.ok([local.x, local.y, local.vx, local.vy, local.angle, local.heat, local.charge].every(Number.isFinite));
      if (previous) maximumStep = Math.max(maximumStep, Math.hypot(local.x - previous.x, local.y - previous.y));
      maximumCorrection = Math.max(maximumCorrection, Math.hypot(prediction.offset.x, prediction.offset.y));
      if (profile.pause && now >= 3400 && !frozenAt) frozenAt = { x: local.x, y: local.y };
      if (profile.pause && now >= 3480 && now < 3500 && frozenAt) assert.ok(Math.hypot(local.x - frozenAt.x, local.y - frozenAt.y) < 2, "prediction kept driving through a connection stall");
      previous = local;
    }
  }
  assert.ok(maximumStep < 90, `unbounded visible jump for ${profile.name}: ${maximumStep}`);
  assert.ok(prediction.history.length <= 256);
  metrics.push({ profile: profile.name, rttMs: profile.rtt, jitterMs: profile.jitter, lossPercent: profile.loss * 100,
    maxRenderedStepPx: +maximumStep.toFixed(2), maxCorrectionPx: +maximumCorrection.toFixed(2) });
}
console.log(JSON.stringify(metrics));
console.log("prediction-tests: ok (replay, differential physics, handling, latency/loss/pause matrix)");
