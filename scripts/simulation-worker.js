import { RaceSimulation } from "./physics.js";
import { PHYSICS_HZ, WORKER_SNAPSHOT_HZ } from "./constants.js";

let simulation = null;
let raceId = null;
let timer = null;
let accumulator = 0;
let lastWallTime = 0;
let nextPumpAt = 0;
let finishedPublished = false;
let lastPublishedTick = -Infinity;
let checkpoints = false;
let lastCheckpointTick = -Infinity;
let snapshotFlowControl = false;
let snapshotSequence = 0;
let awaitingSnapshotId = null;
let snapshotPending = false;
let compactSnapshots = false;

const fixedDt = 1 / PHYSICS_HZ;
const tickIntervalMs = 1000 / PHYSICS_HZ;
const snapshotEveryTicks = Math.max(1, Math.round(PHYSICS_HZ / WORKER_SNAPSHOT_HZ));

function clearClockTimer() {
  if (timer != null) clearTimeout(timer);
  timer = null;
}

function publishSnapshot({ force = false, flush = false } = {}) {
  if (!simulation) return;
  const tick = Number(simulation.tick) || 0;
  if (!force && !flush && !simulation.finished && tick - lastPublishedTick < snapshotEveryTicks) return;
  if (checkpoints && !simulation.finished && (force || tick - lastCheckpointTick >= PHYSICS_HZ / 2)) {
    lastCheckpointTick = tick;
    self.postMessage({ type: "checkpoint", raceId, checkpoint: JSON.stringify(simulation.exportCheckpoint()) });
  }
  lastPublishedTick = tick;
  if (simulation.finished && !finishedPublished) {
    finishedPublished = true;
    snapshotPending = false;
    const snapshot = simulation.snapshot({ includeMetadata: !compactSnapshots });
    self.postMessage({ type: "finished", raceId, snapshot, compact: compactSnapshots, generatedAt: performance.timeOrigin + performance.now() });
    clearClockTimer();
    return;
  }
  if (snapshotFlowControl && awaitingSnapshotId !== null && !force) {
    // Do not clone stale frames into the main-thread event queue. The next ACK
    // requests the then-current state, replacing all missed periodic snapshots.
    snapshotPending = true;
    return;
  }
  const snapshot = simulation.snapshot({ includeMetadata: !compactSnapshots });
  const stateEvent = snapshotFlowControl && awaitingSnapshotId !== null;
  const snapshotId = stateEvent ? null : ++snapshotSequence;
  if (snapshotFlowControl && !stateEvent) awaitingSnapshotId = snapshotId;
  self.postMessage({ type: stateEvent ? "state" : "snapshot", raceId, snapshot, snapshotId, compact: compactSnapshots,
    generatedAt: performance.timeOrigin + performance.now() });
}

function schedulePump(now = performance.now()) {
  if (!simulation || simulation.finished) return;
  if (!nextPumpAt) nextPumpAt = now + tickIntervalMs;
  timer = setTimeout(pump, Math.max(0, nextPumpAt - now));
}

function pump() {
  timer = null;
  if (!simulation) return;
  const now = performance.now();
  if (!lastWallTime) lastWallTime = now;
  // Dedicated workers keep ticking when Foundry is obscured. Catch up from wall
  // time, but publish only after an actual fixed step. The old 16 ms interval
  // plus a 16.67 ms publication gate alternated irregular snapshots.
  const elapsed = Math.max(0, Math.min(1.5, (now - lastWallTime) / 1000));
  lastWallTime = now;
  accumulator += elapsed;
  let steps = 0;
  const maxCatchUpSteps = PHYSICS_HZ * 2;
  while (accumulator + 1e-9 >= fixedDt && steps < maxCatchUpSteps && !simulation.finished) {
    simulation.step(fixedDt);
    accumulator -= fixedDt;
    steps += 1;
  }
  if (steps >= maxCatchUpSteps) accumulator = Math.min(accumulator, fixedDt);
  if (steps > 0) publishSnapshot();
  if (!simulation || simulation.finished) return;

  // Advance an absolute deadline instead of chaining timeout duration. This
  // removes timer drift while avoiding a burst of zero-delay callbacks after a
  // delayed worker turn; the accumulator already performed the required catch-up.
  while (nextPumpAt <= now) nextPumpAt += tickIntervalMs;
  if (nextPumpAt - now < 1) nextPumpAt += tickIntervalMs;
  schedulePump(now);
}

function startClock() {
  clearClockTimer();
  const now = performance.now();
  lastWallTime = now;
  nextPumpAt = now + tickIntervalMs;
  accumulator = 0;
  schedulePump(now);
}

function stopClock() {
  clearClockTimer();
  simulation = null;
  raceId = null;
  accumulator = 0;
  lastWallTime = 0;
  nextPumpAt = 0;
  finishedPublished = false;
  lastPublishedTick = -Infinity;
  lastCheckpointTick = -Infinity;
  checkpoints = false;
  snapshotFlowControl = false;
  snapshotSequence = 0;
  awaitingSnapshotId = null;
  snapshotPending = false;
  compactSnapshots = false;
}

self.addEventListener("message", (event) => {
  const message = event.data ?? {};
  try {
    switch (message.type) {
      case "init":
        stopClock();
        raceId = String(message.raceId ?? "race");
        simulation = new RaceSimulation({
          track: message.track,
          entries: message.entries,
          laps: message.config?.laps,
          collisionMode: message.config?.collisionMode,
          botDifficulty: message.config?.botDifficulty,
          requiredPitStops: message.config?.requiredPitStops
        });
        if (message.checkpoint) simulation.restoreCheckpoint(message.checkpoint, { resetInputs: true });
        checkpoints = message.checkpoints === true;
        snapshotFlowControl = message.snapshotFlowControl === true;
        compactSnapshots = message.compactSnapshots === true;
        if (compactSnapshots) self.postMessage({ type: "metadata", raceId, cars: simulation.carMetadata() });
        finishedPublished = false;
        startClock();
        publishSnapshot({ force: true });
        self.postMessage({ type: "ready", raceId });
        break;
      case "snapshot-consumed":
        if (awaitingSnapshotId === null || message.raceId !== raceId || message.snapshotId !== awaitingSnapshotId) break;
        awaitingSnapshotId = null;
        if (snapshotPending && simulation && !simulation.finished) {
          snapshotPending = false;
          publishSnapshot({ flush: true });
        }
        break;
      case "input":
        simulation?.setInput(message.carId, message.input, message.sequence);
        break;
      case "claim-control":
        simulation?.claimControl(message.carId);
        publishSnapshot({ force: true });
        break;
      case "pit-complete":
        simulation?.completePitStop(message.carId, message.word, message.attemptId);
        publishSnapshot({ force: true });
        break;
      case "hand-to-bot":
        simulation?.handToBot(message.carId, message.skill);
        publishSnapshot({ force: true });
        break;
      case "snapshot-request":
        publishSnapshot({ force: true });
        break;
      case "stop":
        stopClock();
        self.close();
        break;
      default:
        break;
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      raceId,
      message: error?.message ?? String(error),
      stack: error?.stack ?? null
    });
  }
});
