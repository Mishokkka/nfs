import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.foundry = { utils: { deepClone: structuredClone } };
const { cloneDefaultBuild } = await import(path.join(root, "scripts/catalog.js"));
const { generateTrack } = await import(path.join(root, "scripts/track.js"));
const { RaceSimulation } = await import(path.join(root, "scripts/physics.js"));

function positiveInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function entry(id, { bot = false, skill = 2, seed = id } = {}) {
  return {
    id,
    userId: bot ? null : `user-${id}`,
    name: id,
    build: cloneDefaultBuild(),
    color: "#ffffff",
    isBot: bot,
    botSkill: skill,
    botSeed: seed
  };
}

function skipCountdown(simulation) {
  simulation.countdown = 0;
  simulation.started = true;
}

const profileCount = Math.min(3, positiveInteger("NFS_RACE_SOAK_PROFILES", 3));
const profiles = [[1, 1], [2, 3], [3, 5]].slice(0, profileCount);
for (const [race, complexity] of profiles) {
  const track = generateTrack(7000 + race, complexity);
  const entries = Array.from({ length: 12 }, (_, index) => entry(`bot-${race}-${index}`, {
    bot: true,
    skill: 1 + index % 4,
    seed: `${race}:${index}`
  }));
  const simulation = new RaceSimulation({ track, entries, laps: 2, collisionMode: "recovery", botDifficulty: 2 });
  for (let tick = 0; tick < 60 * 210 && !simulation.finished; tick += 1) simulation.step(1 / 60);
  assert.equal(simulation.finished, true, `race ${race} on profile ${complexity} did not finish`);
  for (const car of simulation.cars) {
    assert.ok([car.x, car.y, car.vx, car.vy, car.health, car.charge, car.heat, car.raceDistance].every(Number.isFinite));
  }
}

const finishTime = (skill, seed) => {
  const track = generateTrack(seed, 4);
  const simulation = new RaceSimulation({
    track,
    entries: [entry(`bot-${skill}`, { bot: true, skill, seed })],
    laps: 2,
    requiredPitStops: 0,
    botDifficulty: skill
  });
  skipCountdown(simulation);
  for (let tick = 0; tick < 60 * 240 && !simulation.finished; tick += 1) simulation.step(1 / 60);
  return simulation.cars[0].finishTime ?? 240;
};
const eliteSeedCount = Math.min(3, positiveInteger("NFS_ELITE_BOT_SEEDS", 3));
const seeds = ["elite-bot-a", "elite-bot-b", "elite-bot-c"].slice(0, eliteSeedCount);
const tierThree = seeds.reduce((sum, seed) => sum + finishTime(3, seed), 0) / seeds.length;
const tierFour = seeds.reduce((sum, seed) => sum + finishTime(4, seed), 0) / seeds.length;
assert.ok(tierFour < tierThree * 0.95, `elite bot ${tierFour.toFixed(2)} was not faster than tier three ${tierThree.toFixed(2)}`);

console.log(`race-soak-tests: ok (${profiles.length} race profiles, ${seeds.length} elite seeds)`);
