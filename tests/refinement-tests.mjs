import assert from "node:assert/strict";
import { RaceSimulation, neutralInput } from "../scripts/physics.js";
import { cloneDefaultBuild, resolveBuild } from "../scripts/catalog.js";
import { generateTrack } from "../scripts/track.js";
import { estimateBuildPerformance, compareBuildPerformance } from "../scripts/physics/build-preview.js";
import { GripFeedback } from "../scripts/rendering/grip-feedback.js";
import { RaceRecoveryStore } from "../scripts/race-recovery.js";

const build = cloneDefaultBuild(), resolved = resolveBuild(build);
assert.ok(Object.values(resolved.overflow).every(value => value === 0), "starter kit wastes rating points");
const preview = estimateBuildPerformance(resolved);
assert.ok(preview.zeroTo100 > 6 && preview.zeroTo100 < 8);
assert.ok(preview.brakingDistance > 24 && preview.brakingDistance < 34);
assert.ok(preview.lateralBudget > 1.2 && preview.lateralBudget < 1.6);
assert.equal(estimateBuildPerformance(resolveBuild({ ...build, name: "A different name" })), preview, "renaming reran the physics preview");
assert.ok(compareBuildPerformance(resolved, resolved).every(metric => metric.comparison === ""));
const oldBuild = { ...build, running: "grip" };
const durability = compareBuildPerformance(resolved, resolveBuild(oldBuild)).find(metric => metric.key === "maxHealth");
assert.equal(durability.comparisonClass, "is-better");
const slow = resolveBuild({ ...build, frame: "spider", core: "hammer", transmission: "short", steering: "counter", running: "grip", body: "short" });
assert.ok(estimateBuildPerformance(slow).maxSpeed < 100, "reachability fixture must be unable to reach 100 km/h");
{
  const comparison = compareBuildPerformance(slow, resolved).find(metric => metric.key === "zeroTo100");
  assert.equal(comparison.value, "—");
  assert.equal(comparison.comparisonClass, "is-worse");
}

// Round-trip the full authority state during countdown, collisions, pit service
// and finish. Compare future states, not merely the save's visible positions.
for (const seed of [88201, 424242]) {
  const setup = { track: generateTrack(seed, 3), laps: 2, requiredPitStops: 1,
    entries: Array.from({ length: 6 }, (_, i) => ({ id: `bot-${i}`, name: `Bot ${i}`, build, isBot: true, botSkill: 4 })) };
  let original = new RaceSimulation(setup), nextSave = 75;
  let saves = 0, pitSaves = 0;
  for (let tick = 0; tick < 22_000 && !original.finished; tick++) {
    original.step();
    const inPit = original.cars.some(car => car.pitState === "service");
    if (tick < nextSave && !(inPit && !pitSaves)) continue;
    const saved = JSON.parse(JSON.stringify(original.exportCheckpoint()));
    const restored = new RaceSimulation(setup).restoreCheckpoint(saved);
    for (let future = 0; future < 90; future++) { original.step(); restored.step(); }
    assert.deepEqual(restored.exportCheckpoint(), original.exportCheckpoint(), `restore diverged for seed ${seed} at ${tick}`);
    original = restored;
    saves++; if (inPit) pitSaves++;
    nextSave = tick + 1100;
  }
  assert.ok(original.finished, `restored race ${seed} did not finish`);
  assert.ok(saves >= 5 && pitSaves >= 1, "recovery fixtures missed pit service");
  assert.ok(original.cars.every(car => car.pitStopsCompleted === 1));
  assert.deepEqual(new RaceSimulation(setup).restoreCheckpoint(original.exportCheckpoint()).snapshot(), original.snapshot());
  const corrupt = original.exportCheckpoint(); corrupt.cars[0].state.vx = NaN;
  const clean = new RaceSimulation(setup), before = clean.exportCheckpoint();
  assert.throws(() => clean.restoreCheckpoint(corrupt));
  assert.deepEqual(clean.exportCheckpoint(), before, "rejected checkpoint partially mutated authority");
  corrupt.cars[0].state.vx = 0; corrupt.cars[0].rng = 0;
  assert.throws(() => clean.restoreCheckpoint(corrupt));
  const badIndex = original.exportCheckpoint(); badIndex.cars[0].state.trackIndex = 999999;
  assert.throws(() => clean.restoreCheckpoint(badIndex));
}

// A held pre-refresh pedal must not be replayed; manual ownership, pit word and
// attempt token must survive without granting a second stop.
{
  const setup = { track: generateTrack(9, 2), requiredPitStops: 1,
    entries: [{ id: "human", userId: "pilot", name: "Pilot", build }] };
  const original = new RaceSimulation(setup), car = original.cars[0];
  Object.assign(car, { lap: 1, startedLap: true, nextSector: 3, pitState: "service",
    pitWord: "кристалл", pitAttemptId: "attempt-7", pitServiceTimer: 2.5, lastInputSequence: 200,
    currentInput: { ...neutralInput(), throttle: 1 } });
  const restored = new RaceSimulation(setup).restoreCheckpoint(original.exportCheckpoint(), { resetInputs: true });
  assert.deepEqual(restored.cars[0].currentInput, neutralInput());
  assert.equal(restored.cars[0].lastInputSequence, -1);
  assert.equal(restored.cars[0].lap, 1);
  assert.equal(restored.completePitStop("human", "кристалл", "old-attempt"), false);
  assert.equal(restored.completePitStop("human", "кристалл", "attempt-7"), true);
  assert.equal(restored.completePitStop("human", "кристалл", "attempt-7"), false);
  assert.equal(restored.cars[0].pitStopsCompleted, 1);
}

{
  const feedback = new GripFeedback(), car = { id: "a", angle: 0, vx: 400, vy: 140, driftAmount: 0 };
  assert.equal(feedback.update(car, 100), "", "one contact impulse caused a warning");
  assert.equal(feedback.update(car, 160), "");
  assert.match(feedback.update(car, 240), /Снос/);
  assert.match(feedback.update({ ...car, vy: 0 }, 260), /Снос/, "warning flickered on one clean frame");
  assert.equal(feedback.update({ ...car, vy: 0 }, 600), "");
  assert.equal(feedback.update({ ...car, id: "other" }, 620), "", "warning leaked between cars");
  assert.match(feedback.update({ ...car, driftAmount: .8 }, 640), /Управляемый занос/);
  assert.equal(feedback.update({ ...car, vx: 10, vy: 10 }, 660), "");
}

{
  const values = new Map();
  globalThis.game = { world: { id: "world-a" }, user: { id: "pilot" } };
  globalThis.sessionStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const store = new RaceRecoveryStore();
  const lease = { raceId: "race-a", lobbyId: "lobby-a", hostId: "pilot", hostEpoch: 0 };
  const data = { lobby: { id: "lobby-a", hostEpoch: 0 }, race: { raceId: "race-a", hostId: "pilot", phase: "race" }, checkpoint: "{}" };
  assert.equal(store.save(data), true);
  assert.equal(store.load(lease).race.raceId, "race-a");
  assert.equal(store.load({ ...lease, raceId: "other" }), null);
  assert.equal(store.load({ ...lease, hostEpoch: 1 }), null);
  assert.equal(store.load({}), null, "stopped race remained recoverable");
  game.world.id = "world-b";
  assert.equal(store.load(lease), null, "checkpoint leaked between worlds");
  game.world.id = "world-a";
  const saved = JSON.parse(values.get(store.key)); saved.savedAt -= 13 * 60 * 60 * 1000;
  values.set(store.key, JSON.stringify(saved));
  assert.equal(store.load(lease), null, "expired save was revived");
  store.clear(); assert.equal(values.size, 0);
  const warn = console.warn; console.warn = () => {};
  sessionStorage.setItem = () => { throw new Error("Quota exceeded"); };
  try { assert.equal(store.save(data), false); assert.equal(store.warned, true); }
  finally { console.warn = warn; }
}
console.log("refinement-tests: ok (garage estimates, deterministic authority restore, pits, RNG, slip feedback, storage lease)");
