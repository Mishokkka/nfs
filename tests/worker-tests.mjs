import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.foundry = { utils: { deepClone: structuredClone } };
let clock = 100;
let pump = null;
let handler = null;
const posted = [];
globalThis.performance = { timeOrigin: 0, now: () => clock };
let scheduledDelay = 0;
globalThis.setTimeout = (callback, delay = 0) => { pump = callback; scheduledDelay = delay; return 1; };
globalThis.clearTimeout = () => { pump = null; };
globalThis.self = {
  addEventListener: (type, callback) => { if (type === "message") handler = callback; },
  postMessage: (message) => posted.push(message),
  close: () => {}
};

const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { cloneDefaultBuild } = await load("scripts/catalog.js");
const { generateTrack } = await load("scripts/track.js");
const workerUrl = pathToFileURL(path.join(root, "scripts/simulation-worker.js"));
workerUrl.searchParams.set("worker-test", String(Date.now()));
await import(workerUrl.href);
assert.equal(typeof handler, "function");

handler({ data: {
  type: "init",
  raceId: "worker-race",
  track: generateTrack(0, 2),
  entries: [{ id: "car", userId: "user", name: "Car", build: cloneDefaultBuild(), color: "#fff", isBot: false }],
  config: { laps: 1, collisionMode: "recovery", botDifficulty: 2, requiredPitStops: 1 }
} });
assert.ok(posted.some((message) => message.type === "ready" && message.raceId === "worker-race"));
assert.ok(posted.some((message) => message.type === "snapshot"));
assert.ok(posted.every((message) => message.generatedAt == null || Number.isFinite(message.generatedAt)),
  "worker published a non-finite generatedAt timestamp");
assert.equal(typeof pump, "function");

handler({ data: { type: "input", carId: "car", input: { throttle: 1, steer: 0, brake: false, reverse: false, boost: false, ram: false, drift: false } } });
const snapshotTimes = [];
for (let index = 0; index < 8; index += 1) {
  const before = posted.filter((message) => message.type === "snapshot").length;
  clock += 1000 / 60;
  const currentPump = pump;
  pump = null; // a real setTimeout callback is consumed before it executes
  currentPump?.();
  const snapshots = posted.filter((message) => message.type === "snapshot");
  if (snapshots.length > before) snapshotTimes.push(snapshots.at(-1).snapshot.simulationTime);
  assert.ok(scheduledDelay >= 0 && scheduledDelay <= 1000 / 60 + 1);
}
assert.ok(posted.filter((message) => message.type === "snapshot").length >= 3);
for (let index = 1; index < snapshotTimes.length; index += 1) {
  const interval = snapshotTimes[index] - snapshotTimes[index - 1];
  assert.ok(interval > 0 && interval <= 3 / 60 + 1e-9, `worker publication skipped too many ticks: ${interval}`);
}

handler({ data: {
  type: "init",
  raceId: "worker-finish",
  track: generateTrack("worker-finish", 1),
  entries: [{
    id: "bot", userId: null, name: "Bot", build: cloneDefaultBuild(), color: "#fff",
    isBot: true, botSkill: 4, botSeed: "worker-finish"
  }],
  config: { laps: 1, collisionMode: "recovery", botDifficulty: 4, requiredPitStops: 0 }
} });
for (let index = 0; index < 180 && pump; index += 1) {
  clock += 1500;
  const currentPump = pump;
  pump = null; // consume the one-shot timeout before running it
  currentPump?.();
}
assert.ok(posted.some((message) => message.type === "finished" && message.raceId === "worker-finish"),
  "worker did not publish a final snapshot");
assert.equal(pump, null, "worker interval continued after the final snapshot");
handler({ data: { type: "stop" } });

console.log("worker-tests: ok");
