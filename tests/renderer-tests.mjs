import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.Path2D = class {
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  arc() {}
  closePath() {}
};
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; this.disconnected = false; }
  observe() {}
  disconnect() { this.disconnected = true; }
};
const rafCallbacks = new Map();
let nextRaf = 1;
globalThis.requestAnimationFrame = (callback) => {
  const id = nextRaf++;
  rafCallbacks.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => rafCallbacks.delete(id);
globalThis.window = { devicePixelRatio: 1 };

const gradient = { addColorStop() {} };
function makeContext() {
  const target = {
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    measureText: (text) => ({ width: String(text).length * 8 })
  };
  return new Proxy(target, {
    get(object, key) {
      if (key in object) return object[key];
      return () => {};
    },
    set(object, key, value) {
      object[key] = value;
      return true;
    }
  });
}

function makeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    parentElement: null,
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
    getContext: () => makeContext()
  };
  canvas.parentElement = canvas;
  return canvas;
}

let createdCanvasCount = 0;
globalThis.document = { createElement: () => {
  createdCanvasCount += 1;
  return makeCanvas();
} };

const { generateTrack } = await import(pathToFileURL(path.join(root, "scripts/track.js")).href);
const { RaceRenderer } = await import(pathToFileURL(path.join(root, "scripts/renderer.js")).href);
const track = generateTrack("renderer-countdown", 2);


// Network reconciliation must remain continuous. Reintroducing a fixed fraction
// of authoritative position on every 10 Hz snapshot makes the car and camera
// visibly jump forward and backward.
{
  const rendererSource = fs.readFileSync(path.join(root, "scripts/renderer.js"), "utf8");
  const physicsSource = fs.readFileSync(path.join(root, "scripts/physics.js"), "utf8");
  const hudSource = fs.readFileSync(path.join(root, "scripts/app/race-hud.js"), "utf8");
  const raceCss = fs.readFileSync(path.join(root, "styles/screens/race.css"), "utf8");
  assert.match(rendererSource, /correctionX:\s*clamp\(errorX/, "prediction correction must be bounded");
  assert.match(rendererSource, /smoothingFactor\(step, Number\(state\.correctionTime\)/, "prediction correction must use time-based smoothing");
  assert.doesNotMatch(rendererSource, /state\.x\s*\+=\s*\(authoritative\.x\s*-\s*state\.x\)\s*\*/, "fixed-fraction reconciliation returned");
  assert.match(rendererSource, /import \{ applyDriveModel \} from "\.\/physics\/drive-model\.js"/, "renderer must share the production drive model");
  assert.match(physicsSource, /import \{ applyDriveModel \} from "\.\/physics\/drive-model\.js"/, "authoritative physics must use the shared drive model");
  assert.match(rendererSource, /applyDriveModel\(state, input/, "renderer prediction no longer invokes the drive model");
  assert.match(physicsSource, /applyDriveModel\(car, input/, "authoritative simulation no longer invokes the drive model");
  assert.doesNotMatch(rendererSource, /forwardSpeed \*= Math\.exp\(-0\.045/, "obsolete duplicate drag model returned");
  assert.doesNotMatch(rendererSource, /1000 \/ 45/, "hard-coded 45 Hz renderer timing returned");
  assert.match(rendererSource, /this\.#drawHighResolutionTrackTiles\(ctx, worldScale\)/, "high-resolution track tile rendering is missing");
  assert.match(rendererSource, /#drawTrackLayerRegion\(ctx/, "regional track-layer painting is missing");
  assert.match(rendererSource, /fadedPaths/, "faded path cache is missing");
  assert.doesNotMatch(rendererSource, /geometry\.fadedSegments/, "obsolete per-segment fade geometry returned");
  assert.match(rendererSource, /#chooseRenderDivisor\(refreshHz, targetFps\)/, "adaptive render divisor is missing");
  assert.match(rendererSource, /displayRefreshHz/, "display refresh-rate tracking is missing");
  assert.match(rendererSource, /renderDivisor/, "render divisor state is missing");
  assert.match(rendererSource, /const presentationDt = rawDt/, "presentation timestep no longer follows RAF time");
  assert.match(rendererSource, /smoothAuthoritativePresentation/, "authoritative smoothing toggle is missing");
  assert.match(rendererSource, /PLACE_ORDER_STABILITY_MS = 180/, "place-order stabilization window changed unexpectedly");
  assert.match(rendererSource, /#stabilizeRaceOrder\(snapshot, now\)/, "race order stabilization is not applied");
  assert.doesNotMatch(rendererSource, /elapsed < this\.renderInterval - 1/, "legacy interval-skipping gate returned");
  assert.match(rendererSource, /trackTileReuses/, "track tile reuse telemetry is missing");
  assert.match(rendererSource, /TRACK_TILE_OVERLAP_PX/, "track tile overlap guard is missing");
  const staticTrackPaint = rendererSource.slice(rendererSource.indexOf("#paintStaticTrack(ctx)"), rendererSource.indexOf("\n  #drawScenery(ctx) {"));
  assert.ok(staticTrackPaint.indexOf("#drawBoundaryWallGeometry") < staticTrackPaint.indexOf("this.#drawScenery(ctx)"),
    "solid scenery must be painted after fence geometry");
  assert.match(rendererSource, /RAF p50/);
  assert.match(rendererSource, /#drawRaceHud\(ctx, focus, snapshot, width, height\)/);
  assert.doesNotMatch(rendererSource, /surfaceSeverity\s*>\s*0\.06\s*\|\|\s*wallContactTimer/,
    "ordinary runoff must not disable client prediction");
  assert.match(rendererSource, /const unsafeContact = wallContactTimer > 0\.02/);
  assert.match(hudSource, /mode: "canvas"/);
  assert.match(hudSource, /domWrites: 0/);
  assert.doesNotMatch(hudSource, /requestIdleCallback/);
  assert.doesNotMatch(hudSource, /textContent\s*=/);
  assert.match(raceCss, /nfs-race-stage\.nfs-canvas-hud/);
  assert.match(raceCss, /contain: layout paint style/);
  assert.doesNotMatch(raceCss, /animation: nfs-heat-pulse/);
  assert.doesNotMatch(raceCss, /transition: width 100ms/);
}

// A late network/worker frame must not rewind the presentation clock. The old
// latest-arrival anchor moved the whole scene backwards whenever packet latency
// increased, which looked like severe ping even with cheap Canvas rendering.
{
  const mainCanvas = makeCanvas();
  const renderer = new RaceRenderer(mainCanvas, track, {
    networkRenderDelay: 0.12,
    maxExtrapolation: 0.34,
    enableLocalPrediction: false
  });
  const origin = performance.timeOrigin;
  const base = performance.now() + 100;
  const frame = (tick, simulationTime) => ({
    tick, simulationTime, time: simulationTime, countdown: 0, started: true,
    finished: false, laps: 1, requiredPitStops: 0, finishOrder: [], cars: []
  });
  renderer.pushSnapshot(frame(1, 1), { source: "worker", generatedAt: origin + base });
  renderer.render(base + 150);
  const beforeLateFrame = renderer.playbackTargetTime;
  renderer.pushSnapshot(frame(2, 1.1), { source: "worker", generatedAt: origin + base + 500 });
  renderer.render(base + 520);
  assert.ok(renderer.playbackTargetTime >= beforeLateFrame,
    `late frame rewound presentation: ${renderer.playbackTargetTime}/${beforeLateFrame}`);
  assert.ok(renderer.playbackClockOffset < renderer.playbackOffsetSample,
    "late offset sample replaced the low-latency clock estimate");
  renderer.destroy();
}

// Position changes must not invalidate the expensive label sprite. The rank is
// drawn as a cheap dynamic overlay, while the stable car name remains cached.
{
  const mainCanvas = makeCanvas();
  const renderer = new RaceRenderer(mainCanvas, track, { localCarId: "car-a" });
  const base = performance.now() + 100;
  const car = {
    id: "car-a", x: track.start.x, y: track.start.y, vx: 0, vy: 0,
    angle: Math.atan2(track.start.ty, track.start.tx), health: 100, maxHealth: 100,
    charge: 100, maxCharge: 100, heat: 0, overheated: false, lap: 0,
    progress: 0, raceDistance: 0, place: 1, finished: false, disabled: false,
    color: "#ffffff", name: "Испытатель", pitState: "track", pitProgress: 0,
    surfaceSeverity: 0, wallContactTimer: 0, prediction: {}
  };
  const rival = { ...car, id: "car-b", name: "Соперник", place: 2, x: car.x - 40 };
  const snapshot = {
    tick: 1, simulationTime: 1, time: 1, countdown: 0, started: true,
    finished: false, laps: 3, requiredPitStops: 0, finishOrder: [], cars: [car, rival]
  };
  const twoCars = snapshot;
  renderer.setSimulationFrame(twoCars, twoCars, 0);
  renderer.render(base);
  const afterFirstLabel = renderer.getPerformanceStats();
  const overtaken = {
    ...twoCars, tick: 2, simulationTime: 1.02,
    cars: [{ ...car, place: 2 }, { ...rival, place: 1 }]
  };
  renderer.setSimulationFrame(twoCars, overtaken, 1);
  renderer.render(base + 60);
  assert.deepEqual(renderer.presentationOrder, ["car-a", "car-b"], "one transient rank frame must not change displayed order");
  renderer.setSimulationFrame(twoCars, overtaken, 1);
  renderer.render(base + 260);
  assert.deepEqual(renderer.presentationOrder, ["car-b", "car-a"], "a sustained overtake must eventually update displayed order");
  const afterOvertake = renderer.getPerformanceStats();
  assert.equal(afterOvertake.labelCacheMisses, afterFirstLabel.labelCacheMisses, "rank changes must not allocate another label canvas");
  assert.equal(afterOvertake.labelCacheSize, afterFirstLabel.labelCacheSize);
  assert.ok(afterOvertake.labelCacheHits >= 2);
  renderer.destroy();
}


// Entering a runoff material on a remote client must keep the predicted pose.
// Falling back to the 140 ms delayed snapshot buffer created a backward/forward
// pop that was visible only to players, never to the authoritative GM.
{
  const mainCanvas = makeCanvas();
  const renderer = new RaceRenderer(mainCanvas, track, {
    localCarId: "car-surface",
    enableLocalPrediction: true,
    networkRenderDelay: 0,
    maxExtrapolation: 0.3
  });
  const base = performance.now() + 300;
  const car = {
    id: "car-surface", x: track.start.x, y: track.start.y, vx: track.start.tx * 120, vy: track.start.ty * 120,
    angle: Math.atan2(track.start.ty, track.start.tx), health: 100, maxHealth: 100,
    charge: 100, maxCharge: 100, heat: 0, overheated: false, lap: 0,
    progress: 0, raceDistance: 0, place: 1, finished: false, disabled: false,
    color: "#ffffff", name: "Surface test", pitState: "track", pitProgress: 0,
    inputSequence: 1, surfaceSeverity: 0, surfaceType: "road", surfaceSide: 0,
    wallContactTimer: 0,
    prediction: {
      maxSpeed: 420, acceleration: 240, reverseAcceleration: 95, braking: 300,
      steerRate: 1.5, lateralGrip: 2.8, longitudinalDrag: 0.25, rollingDrag: 20,
      spinResistance: 1, recovery: 1, offroadGrip: 1, boostDrain: 25,
      heatRate: 40, cooling: 5
    }
  };
  const frame = (tick, simulationTime, nextCar) => ({
    tick, simulationTime, time: simulationTime, countdown: 0, started: true,
    finished: false, laps: 3, requiredPitStops: 0, finishOrder: [], cars: [nextCar]
  });
  renderer.setLocalInput({ throttle: 1, steer: 0 }, 1);
  renderer.pushSnapshot(frame(1, 1, car), { generatedAt: performance.timeOrigin + base });
  renderer.render(base + 20);
  renderer.pushSnapshot(frame(2, 1.033, {
    ...car,
    x: car.x + car.vx * 0.033,
    y: car.y + car.vy * 0.033,
    surfaceSeverity: 0.62,
    surfaceType: "grass"
  }), { generatedAt: performance.timeOrigin + base + 33 });
  renderer.render(base + 60);
  assert.equal(renderer.predictionBlocked, false, "runoff transition disabled local prediction");
  assert.ok(renderer.predictionState, "prediction state was discarded on runoff transition");
  renderer.destroy();
}

// Normal race zoom must use the bounded tile cache instead of repainting the
// complete vector circuit every frame. Missing tiles are temporarily covered by
// cropped regions of the whole-track bitmap while the nearest tiles warm up.
{
  const mainCanvas = makeCanvas();
  const renderer = new RaceRenderer(mainCanvas, track, { localCarId: "car-tile" });
  const car = {
    id: "car-tile", x: track.start.x, y: track.start.y, vx: 0, vy: 0,
    angle: Math.atan2(track.start.ty, track.start.tx), health: 100, maxHealth: 100,
    charge: 100, maxCharge: 100, heat: 0, overheated: false, lap: 0,
    progress: 0, raceDistance: 0, place: 1, finished: false, disabled: false,
    color: "#ffffff", name: "Тайловый тест", pitState: "track", pitProgress: 0,
    surfaceSeverity: 0, wallContactTimer: 0, prediction: {}
  };
  const snapshot = {
    tick: 1, simulationTime: 1, time: 1, countdown: 2.5, started: false,
    finished: false, laps: 3, requiredPitStops: 0, finishOrder: [], cars: [car]
  };
  renderer.setSimulationFrame(snapshot, snapshot, 0);
  const base = performance.now() + 200;
  for (let index = 0; index < 24; index += 1) renderer.render(base + index * 20);
  const stats = renderer.getPerformanceStats();
  assert.equal(stats.trackRenderMode, "tiles");
  assert.ok(stats.trackVisibleTiles > 0);
  assert.ok(stats.trackTileGenerated > 0);
  assert.ok(stats.trackTileAllocations > 0);
  assert.ok(stats.trackTileCacheSize <= 16, "tile cache exceeded its hard memory bound");
  assert.ok(Number.isFinite(stats.rafP95));
  renderer.destroy();
}

// Once the tile cache is full, new camera regions must recycle existing Canvas
// backing stores rather than allocate and destroy a new GPU resource every time.
{
  const mainCanvas = makeCanvas();
  const renderer = new RaceRenderer(mainCanvas, track);
  const snapshot = {
    tick: 1, simulationTime: 1, time: 1, countdown: 0, started: true,
    finished: false, laps: 3, requiredPitStops: 0, finishOrder: [], cars: []
  };
  renderer.setSimulationFrame(snapshot, snapshot, 0);
  const base = performance.now() + 300;
  for (let index = 0; index < 80; index += 1) {
    const sample = track.samples[(index * 17) % track.samples.length];
    renderer.camera.x = sample.x;
    renderer.camera.y = sample.y;
    renderer.camera.initialized = true;
    renderer.render(base + index * 20);
  }
  const stats = renderer.getPerformanceStats();
  assert.ok(stats.trackTileGenerated > 16, "test did not traverse enough unique tile regions");
  assert.ok(stats.trackTileReuses > 0, "full tile cache allocated instead of recycling a backing store");
  assert.ok(stats.trackTileAllocations <= 16, "tile canvas allocation exceeded cache capacity");
  renderer.destroy();
}

// A real 60 Hz display often reports RAF intervals slightly below 16.67 ms.
// These callbacks must all render instead of being phase-gated into 30 FPS.
{
  const mainCanvas = makeCanvas();
  const renderer = new RaceRenderer(mainCanvas, track);
  const snapshot = {
    tick: 1, simulationTime: 1, time: 1, countdown: 0, started: true,
    finished: false, laps: 3, requiredPitStops: 0, finishOrder: [], cars: []
  };
  renderer.setSimulationFrame(snapshot, snapshot, 0);
  const base = performance.now() + 50;
  for (let index = 0; index < 12; index += 1) renderer.render(base + index * 16.2);
  assert.equal(renderer.renderedFrames, 12, "60 FPS mode skipped valid RAF callbacks");
  const stats = renderer.getPerformanceStats();
  assert.ok(stats.rafP50 > 15 && stats.rafP50 < 17);
  renderer.recordSnapshotDelivery(16.8, "worker");
  renderer.recordSnapshotDelivery(17.1, "worker");
  assert.equal(renderer.getPerformanceStats().deliverySource, "worker");
  assert.ok(renderer.getDiagnosticReport().recentRafMs.length > 0);
  renderer.destroy();
}


// High-refresh displays must not render every 144 Hz callback when the module is
// targeting roughly 60 FPS. On Foundry/Electron a stable 48 FPS divisor leaves
// compositor headroom; 72 FPS produced periodic presentation stalls despite cheap drawing.
{
  const mainCanvas = makeCanvas();
  const renderer = new RaceRenderer(mainCanvas, track);
  const snapshot = {
    tick: 1, simulationTime: 1, time: 1, countdown: 0, started: true,
    finished: false, laps: 3, requiredPitStops: 0, finishOrder: [], cars: []
  };
  renderer.setSimulationFrame(snapshot, snapshot, 0);
  const base = performance.now() + 1000;
  for (let index = 0; index < 120; index += 1) renderer.render(base + index * (1000 / 144));
  const stats = renderer.getPerformanceStats();
  assert.equal(stats.renderDivisor, 3, "144 Hz display did not select the stable 48 FPS divisor");
  assert.ok(stats.effectiveTargetFps > 47 && stats.effectiveTargetFps < 49);
  assert.ok(stats.fps > 44 && stats.fps < 58, `unexpected paced FPS: ${stats.fps}`);
  assert.ok(stats.renderIntervalP50 > 20 && stats.renderIntervalP50 < 22);
  // Camera smoothing must remain time-based when the compositor misses frames;
  // a fixed nominal step caused visible slow/fast pulsing.
  renderer.render(base + 120 * (1000 / 144) + 55.5);
  const afterStall = renderer.getPerformanceStats();
  assert.ok(afterStall.cameraRawDtMs > 40, "test did not create a long raw frame gap");
  assert.ok(afterStall.cameraStepMs > 40 && afterStall.cameraStepMs <= 50.1, "camera did not use the bounded real frame duration");
  renderer.destroy();
}

// Countdown snapshots have constant race time but a monotonic simulation clock.
// All of them must enter the interpolation buffer instead of freezing on the first.
{
  const mainCanvas = makeCanvas();
  const renderer = new RaceRenderer(mainCanvas, track);
  renderer.pushSnapshot({ tick: 0, simulationTime: 0, time: 0, countdown: 3.4, started: false, cars: [] });
  renderer.pushSnapshot({ tick: 2, simulationTime: 2 / 60, time: 0, countdown: 3.366, started: false, cars: [] });
  renderer.pushSnapshot({ tick: 4, simulationTime: 4 / 60, time: 0, countdown: 3.333, started: false, cars: [] });
  assert.equal(renderer.snapshotBuffer.length, 3);
  assert.ok(renderer.snapshotBuffer[2].time > renderer.snapshotBuffer[1].time);

  // A pending ResizeObserver RAF must not keep a destroyed renderer alive.
  renderer.resizeObserver.callback();
  assert.equal(rafCallbacks.size, 1);
  const staticCanvases = [renderer.trackLayer, renderer.minimapLayer, renderer.background];
  renderer.destroy();
  assert.equal(rafCallbacks.size, 0);
  assert.equal(renderer.snapshotBuffer.length, 0);
  assert.equal(renderer.track, null);
  assert.equal(renderer.canvas, null);
  assert.equal(mainCanvas.width, 1);
  assert.equal(mainCanvas.height, 1);
  for (const canvas of staticCanvases) {
    assert.equal(canvas.width, 1);
    assert.equal(canvas.height, 1);
  }
}

// Repeated races must explicitly release every backing store instead of waiting
// for Chromium's GPU/JS garbage collection.
for (let index = 0; index < 6; index += 1) {
  const mainCanvas = makeCanvas();
  const renderer = new RaceRenderer(mainCanvas, track);
  renderer.destroy();
  renderer.destroy(); // teardown is intentionally idempotent
  assert.equal(mainCanvas.width, 1);
  assert.equal(mainCanvas.height, 1);
}
assert.equal(rafCallbacks.size, 0);

console.log("renderer-tests: ok");
