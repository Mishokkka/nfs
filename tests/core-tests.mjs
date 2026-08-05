import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { entry, skipCountdown } from "./test-harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.foundry = { utils: { deepClone: structuredClone } };

const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const catalog = await load("scripts/catalog.js");
const trackApi = await load("scripts/track.js");
const physicsApi = await load("scripts/physics.js");
const { applyDriveModel } = await load("scripts/physics/drive-model.js");

const {
  PARTS,
  DRIVER_SPECIALIZATIONS,
  DRIVER_TALENTS,
  cloneDefaultBuild,
  normalizeBuild,
  resolveBuild,
  validateBuild
} = catalog;
const {
  generateTrack, polylineSelfIntersects, sampleTrack, nearestTrackPoint,
  pointAtTrackProgress, pointAtPitProgress, grassWidthForSide, runoffSurfaceForSide, boundaryPoint, wallBoundaryPoint,
  nearestPitPoint, wallSegmentActiveRange, MAIN_TRACK_SCENERY_CLEARANCE, SCENERY_CLEARANCE
} = trackApi;
const { RaceSimulation, neutralInput, deriveCarPhysics } = physicsApi;
const raceEntry = (id, options) => entry(cloneDefaultBuild, id, options);

function forwardSpeed(car) {
  return car.vx * Math.cos(car.angle) + car.vy * Math.sin(car.angle);
}

// The shared drive core must retain the quadratic high-speed losses that were
// absent from the former client-only prediction copy.
{
  const state = { x: 0, y: 0, vx: 300, vy: 0, angle: 0, angularVelocity: 0 };
  const physics = {
    maxSpeed: 450, acceleration: 90, reverseAcceleration: 58, braking: 245,
    steerRate: 1.4, lateralGrip: 2.8, longitudinalDrag: 0.25,
    rollingDrag: 20, spinResistance: 1, recovery: 1
  };
  applyDriveModel(state, neutralInput(), physics, 1 / 60);
  const expected = 300 - 0.25 * (300 / 450) ** 2 * 55 / 60 - 20 / 60;
  assert.ok(Math.abs(state.vx - expected) < 1e-9);
  assert.equal(state.vy, 0);
}

// Simulation tick and transport clock advance during the countdown while race
// time remains zero. This keeps remote countdown snapshots monotonic.
{
  const simulation = new RaceSimulation({ track: generateTrack("countdown", 2), entries: [raceEntry("countdown")] });
  const before = simulation.snapshot();
  simulation.step(1 / 60);
  const after = simulation.snapshot();
  assert.equal(after.tick, before.tick + 1);
  assert.ok(after.simulationTime > before.simulationTime);
  assert.equal(after.time, 0);
  assert.ok(after.countdown < before.countdown);
}

// Network/saved builds are whitelist-normalized, repaired to sixteen points and
// cannot apply duplicate or unknown talents.
{
  const safe = normalizeBuild({
    name: "\u0000".repeat(5) + "Очень длинное имя".repeat(20),
    frame: "not-a-frame",
    core: "wild",
    driver: {
      name: "Испытатель",
      reflexes: 999,
      technique: -5,
      composure: 4,
      aggression: 4,
      attunement: 4,
      specialization: "unknown",
      talents: ["predator", "predator", "unknown", "smooth"]
    },
    prototypePollution: { speed: Infinity }
  });
  assert.equal(validateBuild(safe), null);
  assert.equal(Object.values(safe.driver).filter(Number.isInteger).reduce((a, b) => a + b, 0), 16);
  assert.equal(new Set(safe.driver.talents).size, 2);
  assert.ok(PARTS.frame.some((part) => part.id === safe.frame));
  assert.equal("prototypePollution" in safe, false);
}

// Every catalog trait must have a concrete consumer in physics, renderer or UI.
{
  const source = ["scripts/physics.js", "scripts/renderer.js", "scripts/app.js"]
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n");
  const traitIds = new Set();
  for (const group of Object.values(PARTS)) for (const part of group) for (const key of Object.keys(part.traits ?? {})) traitIds.add(key);
  for (const entry of [...DRIVER_SPECIALIZATIONS, ...DRIVER_TALENTS]) for (const key of Object.keys(entry.traits ?? {})) traitIds.add(key);
  const unused = [...traitIds].filter((key) => !source.includes(key));
  assert.deepEqual(unused, []);
}

// Tracks are approximately twice as long as the pre-0.11.7 generation,
// and progress-to-point mapping follows arc length instead of raw sample index.
{
  for (let complexity = 1; complexity <= 5; complexity += 1) {
    const track = generateTrack(`length-${complexity}`, complexity);
    assert.ok(track.totalLength > 11500 + complexity * 1300, `track ${complexity} was too short: ${track.totalLength}`);
    assert.ok(track.pit?.totalLength > 1000);
    for (const progress of [0.03, 0.123, 0.37, 0.82, 0.97]) {
      const marker = pointAtTrackProgress(track, progress);
      const nearest = nearestTrackPoint(track, marker.x, marker.y);
      const delta = Math.abs(nearest.progress - progress);
      assert.ok(Math.min(delta, 1 - delta) < 0.004, `arc progress mismatch ${progress} -> ${nearest.progress}`);
    }
    for (const progress of [0.05, 0.33, 0.67, 0.95]) {
      const marker = pointAtPitProgress(track, progress);
      assert.ok(Number.isFinite(marker.x) && Number.isFinite(marker.y));
    }
  }
}

// The extreme profile has genuinely severe direction changes. Tournament
// circuits combine a technical complex with a long uninterrupted straight.
{
  const profileMetrics = (track) => {
    const count = track.samples.length;
    let maximumTurn = 0;
    let longestStraight = 0;
    let straightRun = 0;
    for (let step = 0; step < count * 2; step += 1) {
      const index = step % count;
      const previous = track.samples[(index - 5 + count) % count];
      const next = track.samples[(index + 5) % count];
      const before = Math.atan2(previous.ty, previous.tx);
      const after = Math.atan2(next.ty, next.tx);
      const turn = Math.abs(Math.atan2(Math.sin(after - before), Math.cos(after - before)));
      maximumTurn = Math.max(maximumTurn, turn);
      if (turn < 0.05) {
        straightRun += track.samples[index].segmentLength;
        longestStraight = Math.max(longestStraight, straightRun);
      } else straightRun = 0;
      if (step >= count && straightRun === 0) break;
    }
    return { maximumTurn, longestStraight };
  };
  const extreme = generateTrack("profile-extreme", 4);
  const tournament = generateTrack("profile-tournament", 5);
  const extremeMetrics = profileMetrics(extreme);
  const tournamentMetrics = profileMetrics(tournament);
  assert.ok(extremeMetrics.maximumTurn > 1.45, `extreme profile was too mild: ${extremeMetrics.maximumTurn}`);
  assert.equal(tournament.trackProfile, "tournament");
  assert.ok(tournamentMetrics.maximumTurn > 0.95, `tournament technical section was too mild: ${tournamentMetrics.maximumTurn}`);
  assert.ok(tournamentMetrics.longestStraight > tournament.totalLength * 0.12,
    `tournament straight was too short: ${tournamentMetrics.longestStraight}/${tournament.totalLength}`);
}

// Tournament generation must stay varied while preserving its intended race rhythm:
// one or two long speed sections and a large technical remainder.
{
  const signatures = new Set();
  for (let seed = 0; seed < 12; seed += 1) {
    const track = generateTrack(`tournament-variety-${seed}`, 5);
    const layout = track.tournamentLayout;
    assert.equal(track.trackProfile, "tournament");
    assert.ok(layout.longStraights.length >= 1 && layout.longStraights.length <= 2,
      `tournament ${seed} had ${layout.longStraights.length} long straights`);
    assert.ok(layout.longestStraightRatio >= 0.105,
      `tournament ${seed} lacked a meaningful straight: ${layout.longestStraightRatio}`);
    assert.ok(layout.technicalRatio >= 0.28,
      `tournament ${seed} lacked a technical complex: ${layout.technicalRatio}`);
    signatures.add([
      track.controls.length,
      layout.longStraights.length,
      layout.longestStraightRatio.toFixed(2),
      layout.technicalRatio.toFixed(2),
      Math.round(track.totalLength / 250)
    ].join(":"));
  }
  assert.ok(signatures.size >= 7, `tournament silhouettes were insufficiently varied: ${signatures.size}`);
}

// Every environment set is deterministic, uses only its own archetypes and
// places solid scenery wholly in the grass without intruding on either road.
{
  const allowedKinds = {
    industrial: new Set(["workshop", "tank", "column", "tower", "boulder"]),
    woodland: new Set(["tree", "pine", "boulder", "barn"]),
    estate: new Set(["column", "statue", "tree", "house", "obelisk"]),
    ruins: new Set(["column", "obelisk", "boulder", "tower", "statue"]),
    tournament: new Set(["grandstand", "timingTower", "workshop", "column", "tower"])
  };
  for (const [theme, allowed] of Object.entries(allowedKinds)) {
    const track = generateTrack("scenery-placement", 3, theme);
    assert.equal(track.environmentTheme, theme);
    assert.ok(track.scenery.length >= 18, `${theme} produced too little scenery`);
    for (const obstacle of track.scenery) {
      assert.equal(obstacle.solid, true);
      assert.equal(obstacle.drawLayer, 2);
      assert.ok(allowed.has(obstacle.kind), `${theme} emitted ${obstacle.kind}`);
      const main = nearestTrackPoint(track, obstacle.x, obstacle.y);
      const pit = nearestPitPoint(track, obstacle.x, obstacle.y);
      assert.ok(main.distance >= track.width * 0.5 + obstacle.collisionRadius + MAIN_TRACK_SCENERY_CLEARANCE - 0.2,
        `${theme} obstacle entered the track: ${main.distance}`);
      assert.ok(pit.distance >= track.pit.width * 0.5 + obstacle.collisionRadius + SCENERY_CLEARANCE - 0.2,
        `${theme} obstacle entered the pit lane: ${pit.distance}`);
    }
    for (let first = 0; first < track.scenery.length; first += 1) {
      for (let second = first + 1; second < track.scenery.length; second += 1) {
        const a = track.scenery[first];
        const b = track.scenery[second];
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > a.collisionRadius + b.collisionRadius + SCENERY_CLEARANCE - 0.2,
          `${theme} obstacles overlapped: ${a.id}/${b.id}`);
      }
    }
  }
  const first = generateTrack("scenery-determinism", 3, "woodland");
  const second = generateTrack("scenery-determinism", 3, "woodland");
  assert.deepEqual(first.scenery, second.scenery);
}

// Every rendered wall segment remains outside its asphalt edge, not only its
// sampled vertices. Physics intersects the same displayed segment along the
// road normal, so smoothing and pit hand-off cannot create an inward visual rail
// or a collision plane reconstructed somewhere else.
{
  for (let complexity = 1; complexity <= 5; complexity += 1) {
    const track = generateTrack(`wall-physics-${complexity}`, complexity);
    for (const [points, width, closed] of [
      [track.samples, track.width, true],
      [track.pit.samples, track.pit.width, false]
    ]) {
      const segmentCount = closed ? points.length : points.length - 1;
      for (let index = 0; index < segmentCount; index += 1) {
        const nextIndex = closed ? (index + 1) % points.length : index + 1;
        const startPoint = points[index];
        const endPoint = points[nextIndex];
        const sx = endPoint.x - startPoint.x;
        const sy = endPoint.y - startPoint.y;
        const length = Math.hypot(sx, sy) || 1;
        const nx = -sy / length;
        const ny = sx / length;
        for (const side of [1, -1]) {
          const xKey = side > 0 ? "wallLeftX" : "wallRightX";
          const yKey = side > 0 ? "wallLeftY" : "wallRightY";
          const alphaKey = side > 0 ? "wallLeftAlpha" : "wallRightAlpha";
          for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
            const alpha = Number(startPoint[alphaKey] ?? 1)
              + (Number(endPoint[alphaKey] ?? 1) - Number(startPoint[alphaKey] ?? 1)) * progress;
            if (alpha < 0.025) continue;
            const centerX = startPoint.x + sx * progress;
            const centerY = startPoint.y + sy * progress;
            const wallX = Number(startPoint[xKey]) + (Number(endPoint[xKey]) - Number(startPoint[xKey])) * progress;
            const wallY = Number(startPoint[yKey]) + (Number(endPoint[yKey]) - Number(startPoint[yKey])) * progress;
            const startGrass = side > 0
              ? Number(startPoint.grassWidthLeft ?? startPoint.grassWidth ?? 0)
              : Number(startPoint.grassWidthRight ?? startPoint.grassWidth ?? 0);
            const endGrass = side > 0
              ? Number(endPoint.grassWidthLeft ?? endPoint.grassWidth ?? 0)
              : Number(endPoint.grassWidthRight ?? endPoint.grassWidth ?? 0);
            const required = width * 0.5 + startGrass + (endGrass - startGrass) * progress;
            const extent = ((wallX - centerX) * nx + (wallY - centerY) * ny) * side;
            assert.ok(extent >= required - 0.05,
              `wall entered road on profile ${complexity}, segment ${index}: ${extent}/${required}`);
          }
        }
      }
    }
  }
}

// Pit-junction wall segments are clipped and generation-masked against both
// drivable ribbons. This covers the reported finish-straight/pit-lane case in
// which a coarse main-wall chord visibly crossed the pit asphalt and caught a
// human driver before route commitment, while bots switched route earlier.
{
  const seeds = ["142534", "8820114", "8820123", "12523", "2473457", "pit-wall-regression"];
  for (const seed of seeds) {
    const track = generateTrack(seed, 2);
    const inspect = (route, points, width, closed) => {
      const segmentCount = closed ? points.length : points.length - 1;
      for (let index = 0; index < segmentCount; index += 1) {
        const nextIndex = closed ? (index + 1) % points.length : index + 1;
        const start = points[index];
        const end = points[nextIndex];
        for (const side of [1, -1]) {
          const active = wallSegmentActiveRange(start, end, side, 0.025);
          if (!active) continue;
          const a = wallBoundaryPoint(start, width, side);
          const b = wallBoundaryPoint(end, width, side);
          for (let sample = 0; sample <= 10; sample += 1) {
            const t = active.startT + (active.endT - active.startT) * sample / 10;
            const x = a.x + (b.x - a.x) * t;
            const y = a.y + (b.y - a.y) * t;
            const other = route === "main"
              ? nearestPitPoint(track, x, y)
              : nearestTrackPoint(track, x, y, Number(start.mainIndex) || null);
            const otherHalf = route === "main" ? track.pit.width * 0.5 : track.width * 0.5;
            assert.ok(other.distance >= otherHalf + 5.35,
              `${route} wall crossed the other road at seed ${seed}, segment ${index}, side ${side}: ${other.distance}/${otherHalf}`);
          }
        }
      }
    };
    inspect("main", track.samples, track.width, true);
    inspect("pit", track.pit.samples, track.pit.width, false);
  }
}

// Spatial-grid fallback must return the same nearest segment as the exhaustive
// scan, including points outside the road and around the closed-track seam.
{
  const track = generateTrack("spatial-grid", 4);
  const withoutGrid = { ...track, spatialGrid: null, pit: { ...track.pit, spatialGrid: null } };
  const probes = [
    ...track.samples.filter((_, index) => index % 37 === 0).map((point) => ({ x: point.x + point.nx * 310, y: point.y + point.ny * 310 })),
    ...track.pit.samples.filter((_, index) => index % 19 === 0).map((point) => ({ x: point.x - point.nx * 140, y: point.y - point.ny * 140 }))
  ];
  for (const probe of probes) {
    const grid = nearestTrackPoint(track, probe.x, probe.y);
    const exhaustive = nearestTrackPoint(withoutGrid, probe.x, probe.y);
    assert.ok(Math.abs(grid.distance - exhaustive.distance) < 1e-6);
    const indexDelta = Math.abs(grid.index - exhaustive.index);
    assert.ok(indexDelta === 0 || indexDelta === 1 || indexDelta === track.samples.length - 1,
      `grid chose a non-equivalent segment ${grid.index}/${exhaustive.index}`);
  }
}

// The pit lane is a gradual fork: it starts and ends on the racing line, then
// separates before the trigger. Committing to the deep branch must be possible
// without crossing an invisible main-track barrier.
{
  const track = generateTrack("pit-fork", 3);
  const pit = track.pit;
  const first = pit.samples[0];
  const last = pit.samples[pit.samples.length - 1];
  assert.ok((first.separation ?? 1) < 0.01);
  assert.ok((last.separation ?? 1) < 0.01);
  assert.ok(pit.samples[pit.entryTriggerStart].separation > 0.55);
  assert.ok(pit.samples[pit.serviceIndex].separation > 0.95);

  const simulation = new RaceSimulation({ track, entries: [raceEntry("pit-entry")], laps: 2, requiredPitStops: 1 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  const branch = pit.samples[pit.entryTriggerEnd];
  Object.assign(car, {
    x: branch.x,
    y: branch.y,
    angle: Math.atan2(branch.ty, branch.tx),
    vx: branch.tx * 120,
    vy: branch.ty * 120,
    pitState: "track"
  });
  simulation.setInput(car.id, neutralInput());
  simulation.step(1 / 60);
  assert.equal(car.pitState, "entering");
  assert.equal(car.health, car.physics.maxHealth);
}

// Passing close to the pit fork while the car remains on the main asphalt must
// not adopt the pit route or collide with its rails.
{
  const track = generateTrack("pit-close-pass", 4);
  const simulation = new RaceSimulation({ track, entries: [raceEntry("pit-close")], laps: 2, requiredPitStops: 1 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  const branch = track.pit.samples[track.pit.entryTriggerEnd];
  const main = sampleTrack(track, branch.mainIndex);
  const offset = track.width * 0.42 * track.pit.side;
  Object.assign(car, {
    x: main.x + main.nx * offset,
    y: main.y + main.ny * offset,
    angle: Math.atan2(main.ty, main.tx),
    vx: main.tx * 145,
    vy: main.ty * 145,
    pitState: "track"
  });
  simulation.setInput(car.id, neutralInput());
  for (let step = 0; step < 8; step += 1) simulation.step(1 / 60);
  assert.equal(car.pitState, "track");
  assert.ok(car.health > car.physics.maxHealth * 0.99);
}

// The reported extreme seed keeps a real median between the pit lane and the
// circuit once the fork is committed. Touching the outgoing merge from the main
// asphalt cannot adopt the pit route.
{
  const track = generateTrack(235632, 4);
  const requiredClearance = (track.width + track.pit.width) * 0.5 + 20;
  let minimumClearance = Infinity;
  for (const point of track.pit.samples) {
    if (Number(point.separation) < 0.88) continue;
    minimumClearance = Math.min(minimumClearance, nearestTrackPoint(track, point.x, point.y).distance);
  }
  assert.ok(minimumClearance >= requiredClearance,
    `pit lane overlapped the circuit: ${minimumClearance}/${requiredClearance}`);

  const simulation = new RaceSimulation({ track, entries: [raceEntry("pit-exit-graze")], laps: 2, requiredPitStops: 1 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  const branch = track.pit.samples[Math.min(track.pit.samples.length - 2, track.pit.exitMergeStart + 3)];
  const main = sampleTrack(track, branch.mainIndex);
  const offset = track.width * 0.47 * track.pit.side;
  Object.assign(car, {
    x: main.x + main.nx * offset,
    y: main.y + main.ny * offset,
    angle: Math.atan2(main.ty, main.tx),
    vx: main.tx * 180,
    vy: main.ty * 180,
    pitState: "track",
    trackIndex: branch.mainIndex,
    progress: main.cumulative / track.totalLength,
    lastProgress: main.cumulative / track.totalLength
  });
  for (let step = 0; step < 20; step += 1) {
    simulation.setInput(car.id, neutralInput());
    simulation.step(1 / 60);
  }
  assert.equal(car.pitState, "track");
}

// The visible pit ribbon is road even before the state machine formally commits
// a human driver to the branch. It must never apply grass drag at the entry line.
{
  const track = generateTrack("pit-asphalt-surface", 3);
  track.scenery = [];
  for (const point of [...track.samples, ...track.pit.samples]) {
    point.wallLeftAlpha = 0;
    point.wallRightAlpha = 0;
  }
  const index = track.pit.samples.findIndex((point, sampleIndex) => sampleIndex >= track.pit.entryTriggerStart
    && sampleIndex <= track.pit.entryTriggerEnd && Number(point.separation) > 0.45);
  assert.ok(index >= 0);
  const point = track.pit.samples[index];
  const simulation = new RaceSimulation({ track, entries: [raceEntry("pit-asphalt")], laps: 2, requiredPitStops: 1 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  Object.assign(car, {
    x: point.x,
    y: point.y,
    angle: Math.atan2(point.ty, point.tx),
    vx: point.tx * 70,
    vy: point.ty * 70,
    pitState: "track",
    trackIndex: point.mainIndex,
    progress: point.mainProgressUnwrapped % 1,
    lastProgress: point.mainProgressUnwrapped % 1
  });
  for (let tick = 0; tick < 4; tick += 1) {
    simulation.setInput(car.id, neutralInput());
    simulation.step(1 / 60);
    assert.ok(car.surfaceSeverity < 0.001, `pit asphalt was treated as grass: ${car.surfaceSeverity}`);
  }
}

// Cars can use the variable-width grass runoff without taking damage, while the
// hard perimeter remains farther out at the local grass boundary.
{
  const track = generateTrack("grass-runoff", 2);
  track.scenery = []; // Isolate runoff drag from solid scenery collisions.
  for (const sample of track.samples) { sample.wallLeftAlpha = 0; sample.wallRightAlpha = 0; }
  const simulation = new RaceSimulation({ track, entries: [raceEntry("grass")], laps: 2 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  const point = sampleTrack(track, 180);
  const offset = track.width * 0.5 + grassWidthForSide(point, 1) * 0.55;
  Object.assign(car, {
    x: point.x + point.nx * offset,
    y: point.y + point.ny * offset,
    angle: Math.atan2(point.ty, point.tx),
    vx: point.tx * 300,
    vy: point.ty * 300,
    trackIndex: 180
  });
  const health = car.health;
  let maximumGrass = 0;
  for (let tick = 0; tick < 30; tick += 1) {
    simulation.setInput(car.id, neutralInput());
    simulation.step(1 / 60);
    maximumGrass = Math.max(maximumGrass, car.surfaceSeverity);
  }
  assert.equal(car.health, health);
  assert.ok(Math.hypot(car.vx, car.vy) < 200, `grass speed was ${Math.hypot(car.vx, car.vy)}`);
  assert.ok(maximumGrass > 0.30);
}

// Grass contact scales with the car footprint. A single wheel pair on the verge
// produces a progressive loss of grip, while a fully off-track car slows harder.
{
  const track = generateTrack("grass-footprint", 2);
  track.scenery = []; // Isolate footprint terrain sampling from obstacle impacts.
  for (const sample of track.samples) { sample.wallLeftAlpha = 0; sample.wallRightAlpha = 0; }
  const index = track.samples.findIndex((point) => point.grassWidthLeft > 55);
  assert.ok(index >= 0, "no sample with grassWidthLeft > 55");
  const point = track.samples[index];
  const run = (offset) => {
    const simulation = new RaceSimulation({ track, entries: [raceEntry(`grass-${offset}`)], laps: 2 });
    skipCountdown(simulation);
    const car = simulation.cars[0];
    Object.assign(car, {
      x: point.x + point.nx * offset,
      y: point.y + point.ny * offset,
      angle: Math.atan2(point.ty, point.tx),
      vx: point.tx * 220,
      vy: point.ty * 220,
      trackIndex: index
    });
    for (let tick = 0; tick < 8; tick += 1) {
      simulation.setInput(car.id, neutralInput());
      simulation.step(1 / 60);
    }
    return { severity: car.surfaceSeverity, speed: Math.hypot(car.vx, car.vy), health: car.health, maxHealth: car.physics.maxHealth };
  };
  const radius = new RaceSimulation({ track, entries: [raceEntry("grass-radius")], laps: 2 }).cars[0].physics.radius;
  const partial = run(track.width * 0.5 - radius * 0.25);
  const deep = run(track.width * 0.5 + radius * 0.95);
  assert.ok(partial.severity > 0.03 && partial.severity < deep.severity);
  assert.ok(partial.speed > deep.speed);
  assert.equal(partial.health, partial.maxHealth);
  assert.equal(deep.health, deep.maxHealth);
}

// A high-speed runoff impact uses the same visible wall as physics, inflicts a
// meaningful hit and leaves the car on the playable side instead of embedded.
{
  const track = generateTrack("wall-runoff-impact", 3);
  track.scenery = []; // Exercise the perimeter response without a foreground obstacle.
  const simulation = new RaceSimulation({ track, entries: [raceEntry("wall-impact")], laps: 2 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  let index = track.samples.findIndex((point, sampleIndex) => sampleIndex > 20
    && Number(point.wallLeftAlpha) > 0.99 && Number(point.grassWidthLeft) > 40);
  if (index < 0) index = track.samples.findIndex((point, sampleIndex) => sampleIndex > 20
    && Number(point.wallLeftAlpha) > 0.99 && Number(point.grassWidthLeft) > 20);
  assert.ok(index >= 0, "no fully walled sample with usable left runoff");
  const point = track.samples[index];
  const wall = wallBoundaryPoint(point, track.width, 1);
  const startOffset = track.width * 0.5 + point.grassWidthLeft * 0.15;
  Object.assign(car, {
    x: point.x + point.nx * startOffset,
    y: point.y + point.ny * startOffset,
    angle: Math.atan2(point.ty, point.tx),
    vx: point.nx * 420 + point.tx * 20,
    vy: point.ny * 420 + point.ty * 20,
    trackIndex: index,
    progress: point.cumulative / track.totalLength,
    lastProgress: point.cumulative / track.totalLength
  });
  const health = car.health;
  for (let tick = 0; tick < 90; tick += 1) {
    simulation.setInput(car.id, neutralInput());
    simulation.step(1 / 60);
  }
  const inwardDistance = -((car.x - wall.x) * point.nx + (car.y - wall.y) * point.ny);
  assert.ok(health - car.health > car.physics.maxHealth * 0.18,
    `wall impact damage was too small: ${health - car.health}`);
  assert.ok(inwardDistance >= car.physics.radius * 0.9,
    `car remained embedded in the wall: ${inwardDistance}/${car.physics.radius}`);
}

// A glancing strike against solid scenery transfers linear momentum into spin,
// removes speed and causes impact damage instead of behaving like a soft trigger.
{
  const track = generateTrack("scenery-impact", 2);
  track.width = 10000;
  track.scenery = [];
  for (const point of track.samples) { point.wallLeftAlpha = 0; point.wallRightAlpha = 0; }
  const simulation = new RaceSimulation({ track, entries: [raceEntry("scenery-impact")], laps: 2 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  const point = sampleTrack(track, 120);
  Object.assign(car, {
    x: point.x,
    y: point.y,
    angle: Math.atan2(point.ty, point.tx),
    vx: point.tx * 240,
    vy: point.ty * 240,
    trackIndex: 120
  });
  track.scenery = [{
    id: "impact-column", kind: "column", solid: true,
    x: point.x + point.tx * 72 + point.nx * 8,
    y: point.y + point.ty * 72 + point.ny * 8,
    collisionRadius: 19, visualRadius: 22
  }];
  const health = car.health;
  for (let tick = 0; tick < 16; tick += 1) {
    simulation.setInput(car.id, neutralInput());
    simulation.step(1 / 60);
  }
  assert.ok(car.health < health - 10, `solid scenery caused no meaningful damage: ${health - car.health}`);
  assert.ok(Math.hypot(car.vx, car.vy) < 90, `solid scenery failed to absorb momentum: ${Math.hypot(car.vx, car.vy)}`);
  assert.ok(Math.abs(car.angularVelocity) > 0.25, `off-centre impact caused no rotation: ${car.angularVelocity}`);
}

// Capsule-to-capsule contact resolves a glancing rear impact with separation,
// momentum transfer, rotation and asymmetric damage.
{
  const track = generateTrack("car-impact", 2);
  track.width = 10000;
  track.scenery = [];
  for (const point of track.samples) { point.wallLeftAlpha = 0; point.wallRightAlpha = 0; }
  const simulation = new RaceSimulation({ track, entries: [raceEntry("impact-a"), raceEntry("impact-b")], laps: 2 });
  skipCountdown(simulation);
  const [a, b] = simulation.cars;
  const point = sampleTrack(track, 150);
  const heading = Math.atan2(point.ty, point.tx);
  Object.assign(a, { x: point.x, y: point.y, angle: heading, vx: point.tx * 260, vy: point.ty * 260, trackIndex: 150 });
  Object.assign(b, {
    x: point.x + point.tx * 43 + point.nx * 13,
    y: point.y + point.ty * 43 + point.ny * 13,
    angle: heading,
    vx: point.tx * 80,
    vy: point.ty * 80,
    trackIndex: 150
  });
  const initialB = Math.hypot(b.vx, b.vy);
  for (let tick = 0; tick < 8; tick += 1) {
    simulation.setInput(a.id, neutralInput());
    simulation.setInput(b.id, neutralInput());
    simulation.step(1 / 60);
  }
  assert.ok(Math.hypot(b.vx, b.vy) > initialB + 45, "rear car did not transfer momentum");
  assert.ok(Math.abs(a.angularVelocity) > 0.25 && Math.abs(b.angularVelocity) > 0.25, "glancing collision caused no spin");
  assert.ok(a.health < a.physics.maxHealth && b.health < b.physics.maxHealth, "collision caused no damage");
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > a.physics.collisionHalfWidth + b.physics.collisionHalfWidth,
    "cars remained interpenetrating");
}

// Acceleration now has a lower global baseline and a materially wider build
// range, so selecting acceleration parts matters instead of every car launching
// at almost the same rate.
{
  const resolved = resolveBuild(cloneDefaultBuild());
  const low = deriveCarPhysics({ ...resolved, stats: { ...resolved.stats, acceleration: 2 } });
  const high = deriveCarPhysics({ ...resolved, stats: { ...resolved.stats, acceleration: 12 } });
  assert.ok(low.acceleration < 70, `low-acceleration launch remained too strong: ${low.acceleration}`);
  assert.ok(high.acceleration > low.acceleration * 3.5,
    `acceleration stat influence was too weak: ${low.acceleration}/${high.acceleration}`);
}

// Grass follows circuit geometry instead of a random ribbon: outside runoff is
// wider on most meaningful bends, the finish keeps a maintained verge, and the
// committed pit lane remains boxed directly at its asphalt edge.
{
  const track = generateTrack("variable-runoff", 3);
  const widths = track.samples.map((point) => point.grassWidth);
  assert.ok(Math.max(...widths) - Math.min(...widths) > track.width * 0.35);
  assert.ok(track.samples[0].grassWidth >= track.width * 0.05);
  assert.ok(track.samples[0].grassWidth < track.width * 0.30);
  let outsideWider = 0;
  let measuredCorners = 0;
  for (let index = 0; index < track.samples.length; index += 1) {
    const before = track.samples[(index - 5 + track.samples.length) % track.samples.length];
    const after = track.samples[(index + 5) % track.samples.length];
    const headingBefore = Math.atan2(before.ty, before.tx);
    const headingAfter = Math.atan2(after.ty, after.tx);
    const turn = Math.atan2(Math.sin(headingAfter - headingBefore), Math.cos(headingAfter - headingBefore));
    if (Math.abs(turn) < 0.04) continue;
    measuredCorners += 1;
    const point = track.samples[index];
    const outside = turn > 0 ? point.grassWidthRight : point.grassWidthLeft;
    const inside = turn > 0 ? point.grassWidthLeft : point.grassWidthRight;
    if (outside > inside) outsideWider += 1;
  }
  assert.ok(outsideWider / Math.max(1, measuredCorners) > 0.70);
  assert.equal(track.pit.samples[track.pit.serviceIndex].grassWidth, 0);
  assert.ok(track.pit.samples[0].grassWidth >= 0);
}

// Once the pit branch is separated, both asphalt ribbons retain their own wall
// around the grass median. Only the entry and exit throats are open.
{
  const track = generateTrack("pit-main-wall", 3);
  const pit = track.pit;
  const alphaKey = pit.side > 0 ? "wallLeftAlpha" : "wallRightAlpha";
  const entryMain = track.samples[pit.samples[0].mainIndex];
  const serviceMain = track.samples[pit.samples[pit.serviceIndex].mainIndex];
  const exitMain = track.samples[pit.samples[pit.samples.length - 1].mainIndex];
  assert.ok(Number(entryMain[alphaKey]) < 0.08);
  assert.ok(Number(serviceMain[alphaKey]) > 0.94);
  assert.ok(Number(exitMain[alphaKey]) < 0.08);
}

// Crossing the start line through the mapped pit route advances the same lap
// counter and sector sequence as crossing on the main straight.
{
  const track = generateTrack("pit-lap-route", 2);
  const simulation = new RaceSimulation({ track, entries: [raceEntry("pit-lap")], laps: 3, requiredPitStops: 0 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  car.startedLap = true;
  car.nextSector = 1;
  const before = track.pit.samples[track.pit.startLineIndex - 1];
  Object.assign(car, {
    pitState: "exit",
    pitIndex: track.pit.startLineIndex - 1,
    pitProgress: before.cumulative / track.pit.totalLength,
    lastPitProgress: before.cumulative / track.pit.totalLength,
    lastPitMainProgress: before.mainProgressUnwrapped,
    x: before.x, y: before.y, angle: Math.atan2(before.ty, before.tx),
    vx: before.tx * 300, vy: before.ty * 300
  });
  for (let tick = 0; tick < 60 && car.lap === 0; tick += 1) simulation.step(1 / 60);
  assert.equal(car.lap, 1);
  assert.ok(car.raceDistance >= 1);
}

// Driver attributes have separate, monotonic domains and stay within the
// documented modest range. Talents are merged exactly once.
{
  const baseResolved = resolveBuild(cloneDefaultBuild());
  const baseDriver = { reflexes: 3, technique: 4, composure: 3, aggression: 3, attunement: 3 };
  const compare = (key, metric, direction = 1) => {
    const low = deriveCarPhysics({ ...baseResolved, driverStats: { ...baseDriver, [key]: 1 } });
    const high = deriveCarPhysics({ ...baseResolved, driverStats: { ...baseDriver, [key]: 6 } });
    assert.ok((high[metric] - low[metric]) * direction > 0, `${key} did not affect ${metric} monotonically`);
    const ratio = Math.max(high[metric], low[metric]) / Math.max(0.0001, Math.min(high[metric], low[metric]));
    assert.ok(ratio < 1.30, `${key} changes ${metric} too strongly: ${ratio}`);
  };
  compare("reflexes", "acceleration");
  compare("reflexes", "braking");
  compare("technique", "steerRate");
  compare("technique", "maxSpeed");
  compare("composure", "collisionResistance", -1);
  compare("aggression", "ramPower");
  compare("aggression", "sideYieldFactor", -1);
  compare("attunement", "cooling");
  compare("attunement", "heatRate", -1);

  const talented = cloneDefaultBuild();
  talented.driver.talents = ["iron-hands", "crystal-ear"];
  const talentedResolved = resolveBuild(talented);
  assert.ok(Math.abs(talentedResolved.traits.spinResistance - 1.14) < 1e-9);
}

// Special modules trade pace for one bounded mechanic. Recuperation is
// timestep-based rather than refilling the full battery in a few frames.
{
  const build = cloneDefaultBuild();
  build.module = "recuperator";
  const track = generateTrack("recuperator-balance", 2);
  track.width = 10000;
  const simulation = new RaceSimulation({ track, entries: [{ ...raceEntry("recuperator"), build }], laps: 2 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  const point = sampleTrack(track, 80);
  Object.assign(car, {
    x: point.x, y: point.y, angle: Math.atan2(point.ty, point.tx),
    vx: point.tx * 300, vy: point.ty * 300, charge: 0, trackIndex: 80
  });
  for (let tick = 0; tick < 60; tick += 1) {
    simulation.setInput(car.id, { ...neutralInput(), brake: true });
    simulation.step(1 / 60);
  }
  assert.ok(car.charge > 0.2, `recuperator returned too little charge: ${car.charge}`);
  assert.ok(car.charge < 12, `recuperator returned too much charge: ${car.charge}`);
}

// The physical pace is twenty-five percent higher and build ratings have a
// clearly visible effect on straight-line speed, steering, mass and durability.
{
  const track = generateTrack("performance-spread", 2);
  const slow = cloneDefaultBuild();
  Object.assign(slow, { frame: "turtle", core: "pulse", transmission: "short", steering: "floating", running: "reinforced", body: "armored" });
  const fast = cloneDefaultBuild();
  Object.assign(fast, { frame: "arrow", core: "needle", transmission: "long", steering: "precision", running: "sport", body: "streamlined" });
  const agile = cloneDefaultBuild();
  Object.assign(agile, { frame: "spider", steering: "quick", running: "slide", body: "short" });
  const heavy = cloneDefaultBuild();
  Object.assign(heavy, { frame: "bull", steering: "gyro", running: "heavy", body: "wide" });
  const simulation = new RaceSimulation({
    track,
    entries: [
      { ...raceEntry("slow"), build: slow },
      { ...raceEntry("fast"), build: fast },
      { ...raceEntry("agile"), build: agile },
      { ...raceEntry("heavy"), build: heavy }
    ]
  });
  const [slowCar, fastCar, agileCar, heavyCar] = simulation.cars;
  assert.ok(fastCar.physics.maxSpeed > slowCar.physics.maxSpeed * 1.8);
  assert.ok(agileCar.physics.steerRate > heavyCar.physics.steerRate * 1.8);
  assert.ok(heavyCar.physics.mass > fastCar.physics.mass * 1.8);
  assert.ok(heavyCar.physics.maxHealth > fastCar.physics.maxHealth * 2.2);
  assert.ok(simulation.cars.find((car) => car.id === "fast").physics.maxSpeed > 780);
}

// Holding reverse first brakes a forward-moving car and then produces stable
// negative longitudinal speed instead of oscillating around zero.
{
  const track = generateTrack(101, 2);
  track.width = 10000; // isolate transmission/braking from road-edge effects
  const simulation = new RaceSimulation({ track, entries: [raceEntry("reverse")], laps: 3 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  const start = sampleTrack(track, 80);
  Object.assign(car, {
    x: start.x,
    y: start.y,
    angle: Math.atan2(start.ty, start.tx),
    vx: start.tx * 80,
    vy: start.ty * 80,
    trackIndex: 80,
    progress: start.cumulative / track.totalLength,
    lastProgress: start.cumulative / track.totalLength
  });
  for (let tick = 0; tick < 600; tick += 1) {
    simulation.setInput(car.id, { ...neutralInput(), reverse: true });
    simulation.step(1 / 60);
  }
  assert.ok(forwardSpeed(car) < -30, `reverse speed was ${forwardSpeed(car)}`);
}

// Air draft must alter longitudinal speed, not be overwritten when world-space
// velocity is reconstructed later in the same physics step.
{
  const track = generateTrack(202, 2);
  const run = (leader) => {
    const simulation = new RaceSimulation({ track, entries: leader ? [raceEntry("tail"), raceEntry("lead")] : [raceEntry("tail")], laps: 3 });
    skipCountdown(simulation);
    const tailPoint = sampleTrack(track, 80);
    const tail = simulation.cars[0];
    Object.assign(tail, {
      x: tailPoint.x,
      y: tailPoint.y,
      angle: Math.atan2(tailPoint.ty, tailPoint.tx),
      vx: tailPoint.tx * 150,
      vy: tailPoint.ty * 150,
      trackIndex: 80,
      progress: tailPoint.cumulative / track.totalLength,
      lastProgress: tailPoint.cumulative / track.totalLength
    });
    if (leader) {
      const leadPoint = sampleTrack(track, 82);
      const lead = simulation.cars[1];
      Object.assign(lead, {
        x: leadPoint.x,
        y: leadPoint.y,
        angle: Math.atan2(leadPoint.ty, leadPoint.tx),
        vx: leadPoint.tx * 150,
        vy: leadPoint.ty * 150,
        trackIndex: 85,
        progress: leadPoint.cumulative / track.totalLength,
        lastProgress: leadPoint.cumulative / track.totalLength
      });
    }
    for (let tick = 0; tick < 60; tick += 1) {
      for (const car of simulation.cars) simulation.setInput(car.id, neutralInput());
      simulation.step(1 / 60);
    }
    return Math.hypot(tail.vx, tail.vy);
  };
  assert.ok(run(true) > run(false) + 5);
}

// Charge is the actual fuel of boost. An empty battery produces neither extra
// acceleration nor a boost visual state, while a sustained full charge can now
// reach thermal lockout before it is exhausted.
{
  const makeRun = (boost, initialCharge = null) => {
    const track = generateTrack(252, 2);
    track.width = 10000;
    const simulation = new RaceSimulation({ track, entries: [raceEntry(`boost-${boost}-${initialCharge}`)], laps: 3 });
    skipCountdown(simulation);
    const car = simulation.cars[0];
    const start = sampleTrack(track, 80);
    Object.assign(car, {
      x: start.x, y: start.y, angle: Math.atan2(start.ty, start.tx),
      trackIndex: 80, progress: start.cumulative / track.totalLength, lastProgress: start.cumulative / track.totalLength
    });
    if (initialCharge != null) car.charge = initialCharge;
    for (let tick = 0; tick < 60; tick += 1) {
      simulation.setInput(car.id, { ...neutralInput(), throttle: 1, boost });
      simulation.step(1 / 60);
    }
    return { simulation, car, speed: Math.hypot(car.vx, car.vy) };
  };
  const emptyBoost = makeRun(true, 0);
  const emptyNormal = makeRun(false, 0);
  assert.equal(emptyBoost.car.boostActive, false);
  assert.equal(emptyBoost.car.charge, 0);
  assert.ok(Math.abs(emptyBoost.speed - emptyNormal.speed) < 0.001);

  const hot = makeRun(true);
  for (let tick = 0; tick < 240; tick += 1) {
    hot.simulation.setInput(hot.car.id, { ...neutralInput(), throttle: 1, boost: true });
    hot.simulation.step(1 / 60);
    if (hot.car.overheated) break;
  }
  assert.equal(hot.car.overheated, true);
  assert.equal(hot.car.boostActive, false);
  assert.ok(hot.car.charge > 0, "thermal lockout should occur before the entire ordinary charge is gone");
}

// Pit service requires an exact word and only then restores all three resources.
{
  const simulation = new RaceSimulation({ track: generateTrack(262, 3), entries: [raceEntry("pit")], laps: 3, requiredPitStops: 1 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  Object.assign(car, {
    pitState: "service", pitWord: "кристалл", pitAttemptId: "attempt-1",
    health: 1, charge: 2, heat: 100, overheated: true
  });
  assert.equal(simulation.completePitStop(car.id, "кристал", "attempt-1"), false);
  assert.equal(car.pitState, "service");
  assert.equal(simulation.completePitStop(car.id, "кристалл", "wrong-attempt"), false);
  assert.equal(simulation.completePitStop(car.id, "кристалл", "attempt-1"), true);
  assert.equal(car.health, car.physics.maxHealth);
  assert.equal(car.charge, car.physics.maxCharge);
  assert.equal(car.heat, 0);
  assert.equal(car.overheated, false);
  assert.equal(car.pitStopsCompleted, 1);
  assert.equal(car.pitState, "exit");
}

// Pit-lane speed is 60 km/h, overspeed is reduced progressively, and merely
// crossing the blue box at speed does not seize control or start service.
{
  const track = generateTrack("pit-manual-stop", 3);
  assert.equal(Math.round(track.pit.speedLimit * (0.62 / 3)), 60);
  const simulation = new RaceSimulation({ track, entries: [raceEntry("pit-manual-stop")], laps: 2, requiredPitStops: 1 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  const point = track.pit.samples[track.pit.serviceIndex];
  const initialSpeed = Math.min(car.physics.maxSpeed * 0.94, track.pit.speedLimit + 105);
  assert.ok(initialSpeed > track.pit.speedLimit);
  Object.assign(car, {
    x: point.x, y: point.y, angle: Math.atan2(point.ty, point.tx),
    vx: point.tx * initialSpeed, vy: point.ty * initialSpeed,
    pitState: "entering", pitIndex: track.pit.serviceIndex,
    pitProgress: point.cumulative / track.pit.totalLength, lastPitProgress: point.cumulative / track.pit.totalLength
  });
  simulation.setInput(car.id, { ...neutralInput(), throttle: 1 });
  simulation.step(1 / 60);
  const speedAfterLimiter = Math.hypot(car.vx, car.vy);
  assert.equal(car.pitState, "entering", "moving through the blue box started service");
  assert.ok(speedAfterLimiter < initialSpeed, "pit limiter did not bleed overspeed");
  assert.ok(speedAfterLimiter > track.pit.speedLimit, "pit limiter clamped overspeed in one tick");

  const stopX = point.x + point.tx * 11 + point.nx * 4;
  const stopY = point.y + point.ty * 11 + point.ny * 4;
  Object.assign(car, { x: stopX, y: stopY, vx: 0, vy: 0, pitState: "entering", pitIndex: track.pit.serviceIndex });
  simulation.setInput(car.id, neutralInput());
  simulation.step(1 / 60);
  assert.equal(car.pitState, "service");
  assert.ok(Math.hypot(car.x - stopX, car.y - stopY) < 0.001, "service teleported the manually stopped car");
  const attempt = car.pitAttemptId;
  const word = car.pitWord;
  assert.equal(simulation.completePitStop(car.id, word, attempt), true);
  assert.ok(Math.hypot(car.x - stopX, car.y - stopY) < 0.001, "pit completion moved the car out of its box");
}

// A full stop outside the painted service rectangle must not trigger mechanics.
{
  const track = generateTrack("pit-outside-box", 2);
  const simulation = new RaceSimulation({ track, entries: [raceEntry("pit-outside-box")], laps: 2, requiredPitStops: 1 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  const point = track.pit.samples[track.pit.serviceIndex];
  const outside = Number(track.pit.serviceHalfLength ?? 52) + car.physics.radius + 18;
  Object.assign(car, {
    x: point.x + point.tx * outside, y: point.y + point.ty * outside,
    angle: Math.atan2(point.ty, point.tx), vx: 0, vy: 0,
    pitState: "entering", pitIndex: track.pit.serviceIndex
  });
  simulation.setInput(car.id, neutralInput());
  simulation.step(1 / 60);
  assert.equal(car.pitState, "entering");
}

// Entering the service box keeps pit progress in arc-length coordinates.
{
  const track = generateTrack("pit-progress", 3);
  const simulation = new RaceSimulation({ track, entries: [raceEntry("pit-progress")], laps: 2, requiredPitStops: 1 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  const point = track.pit.samples[track.pit.serviceIndex];
  Object.assign(car, {
    x: point.x, y: point.y, angle: Math.atan2(point.ty, point.tx),
    vx: 0, vy: 0, pitState: "entering", pitIndex: track.pit.serviceIndex
  });
  simulation.setInput(car.id, neutralInput());
  simulation.step(1 / 60);
  assert.equal(car.pitState, "service");
  assert.ok(Math.abs(car.pitProgress - point.cumulative / track.pit.totalLength) < 1e-9);
}

// Pit typing is not a network inactivity period. A human can spend more than
// five seconds on the word and must still receive control after service.
{
  const simulation = new RaceSimulation({ track: generateTrack(267, 2), entries: [raceEntry("pit-focus")], laps: 3, requiredPitStops: 1 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  Object.assign(car, { pitState: "service", pitWord: "передача", pitAttemptId: "focus-1", inputAge: 4.9 });
  for (let tick = 0; tick < 60 * 8; tick += 1) {
    simulation.setInput(car.id, neutralInput());
    simulation.step(1 / 60);
  }
  assert.equal(car.isBot, false, "pit service handed a human car to AI");
  assert.equal(car.temporaryAutopilot, false);
  assert.equal(car.abandoned, false);
  assert.equal(simulation.completePitStop(car.id, "передача", "focus-1"), true);
  assert.equal(car.inputAge, 0);
  simulation.setInput(car.id, { ...neutralInput(), throttle: 1 });
  for (let tick = 0; tick < 30; tick += 1) simulation.step(1 / 60);
  assert.ok(Math.hypot(car.vx, car.vy) > 32, "control did not resume after pit exit");
}

// A disconnected human in service eventually receives temporary autopilot so
// the pit lane cannot block the race forever.
{
  const simulation = new RaceSimulation({ track: generateTrack("pit-disconnect", 2), entries: [raceEntry("pit-disconnect")], laps: 2, requiredPitStops: 1 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  Object.assign(car, {
    pitState: "service", pitWord: "болид", pitAttemptId: "disconnect-1",
    pitServiceTimer: 0.1, inputAge: 4.95
  });
  for (let tick = 0; tick < 30; tick += 1) simulation.step(1 / 60);
  assert.equal(car.temporaryAutopilot, true);
  assert.equal(car.pitState, "exit");
  assert.equal(car.abandoned, false);
}

// A low-skill bot on the deliberately severe circuit may scrape the new physical
// wall model, but it must remain inside the perimeter and stay driveable.
{
  const track = generateTrack(272, 4);
  track.scenery = []; // This regression measures wall avoidance, not obstacle navigation.
  const simulation = new RaceSimulation({ track, entries: [raceEntry("clean-bot", { bot: true, skill: 1, seed: "clean-bot" })], laps: 2 });
  let maximumLateral = 0;
  for (let tick = 0; tick < 60 * 90 && !simulation.finished; tick += 1) {
    simulation.step(1 / 60);
    if (tick % 10 === 0) {
      const car = simulation.cars[0];
      const nearest = nearestTrackPoint(track, car.x, car.y, car.trackIndex);
      maximumLateral = Math.max(maximumLateral, Math.abs(nearest.signedDistance));
    }
  }
  const car = simulation.cars[0];
  assert.ok(car.health > car.physics.maxHealth * 0.42, `bot suffered excessive wall damage: ${car.health}/${car.physics.maxHealth}`);
  const maximumRunoff = Math.max(...track.samples.flatMap((point) => [
    Number(point.grassWidthLeft ?? point.grassWidth ?? 0),
    Number(point.grassWidthRight ?? point.grassWidth ?? 0)
  ]));
  assert.ok(maximumLateral < track.width * 0.5 + maximumRunoff * 0.92,
    `bot crossed the visible perimeter by ${maximumLateral}`);
}

// Bots can complete the mandatory service workflow and only then finish.
// The procedural pit may begin before the historical 0.66 progress cut-off,
// so include tracks that previously made faster bots miss the state transition.
for (const scenario of [
  { trackSeed: 282, complexity: 2, skill: 2, botSeed: "pit-bot" },
  { trackSeed: 17, complexity: 2, skill: 3, botSeed: 17 },
  { trackSeed: 9, complexity: 2, skill: 4, botSeed: 9 }
]) {
  const simulation = new RaceSimulation({
    track: generateTrack(scenario.trackSeed, scenario.complexity),
    entries: [raceEntry(`pit-bot-${scenario.trackSeed}`, { bot: true, skill: scenario.skill, seed: scenario.botSeed })],
    laps: 2,
    requiredPitStops: 1
  });
  for (let tick = 0; tick < 60 * 300 && !simulation.finished; tick += 1) simulation.step(1 / 60);
  const car = simulation.cars[0];
  assert.equal(simulation.finished, true, `pit bot failed on track ${scenario.trackSeed}`);
  assert.equal(car.pitStopsCompleted, 1, `pit service missed on track ${scenario.trackSeed}`);
  assert.equal(car.finished, true, `pit bot did not finish track ${scenario.trackSeed}`);
}

// Missing input is neutralized quickly and then activates a reversible low-skill
// autopilot. A valid owner input restores control; only explicit leave is final.
{
  const simulation = new RaceSimulation({ track: generateTrack(303, 2), entries: [raceEntry("stale")], laps: 3 });
  skipCountdown(simulation);
  simulation.setInput("stale", { ...neutralInput(), throttle: 1, steer: 1, ram: true });
  for (let tick = 0; tick < 50; tick += 1) simulation.step(1 / 60);
  assert.deepEqual(simulation.cars[0].currentInput, neutralInput());
  for (let tick = 0; tick < 300; tick += 1) simulation.step(1 / 60);
  const car = simulation.cars[0];
  assert.equal(car.isBot, false);
  assert.equal(car.temporaryAutopilot, true);
  assert.equal(car.abandoned, false);
  simulation.setInput(car.id, { ...neutralInput(), throttle: 1 });
  assert.equal(car.temporaryAutopilot, false);
  assert.equal(car.currentInput.throttle, 1);
  assert.equal(simulation.handToBot(car.id, 1), true);
  assert.equal(car.isBot, true);
  assert.equal(car.abandoned, true);
}

// Cars spawned in the exact same position receive a deterministic separation
// normal instead of being skipped by collision resolution.
{
  const track = generateTrack("exact-overlap", 2);
  track.width = 10000;
  const simulation = new RaceSimulation({ track, entries: [raceEntry("overlap-a"), raceEntry("overlap-b")], laps: 2 });
  skipCountdown(simulation);
  const [a, b] = simulation.cars;
  Object.assign(b, { x: a.x, y: a.y, vx: 0, vy: 0, angle: a.angle });
  Object.assign(a, { vx: 0, vy: 0 });
  simulation.setInput(a.id, neutralInput());
  simulation.setInput(b.id, neutralInput());
  simulation.step(1 / 60);
  assert.ok(Math.hypot(b.x - a.x, b.y - a.y) > 0.01);
}

// Crossing the start line twice without the intermediate sectors cannot award
// a lap. This protects close parallel road sections and teleports.
{
  const track = generateTrack(404, 2);
  const simulation = new RaceSimulation({ track, entries: [raceEntry("checkpoint")], laps: 2 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  const crossStart = () => {
    const point = pointAtTrackProgress(track, 0.995);
    Object.assign(car, {
      x: point.x,
      y: point.y,
      angle: Math.atan2(point.ty, point.tx),
      vx: point.tx * 300,
      vy: point.ty * 300,
      trackIndex: track.samples.length - 2,
      progress: point.cumulative / track.totalLength,
      lastProgress: point.cumulative / track.totalLength
    });
    const initialLap = car.lap;
    const initialStartedLap = car.startedLap;
    for (let tick = 0; tick < 30; tick += 1) {
      simulation.setInput(car.id, neutralInput());
      simulation.step(1 / 60);
      if (car.lap !== initialLap || car.startedLap !== initialStartedLap) break;
    }
  };
  crossStart();
  assert.equal(car.startedLap, true);
  const away = sampleTrack(track, 80);
  Object.assign(car, { x: away.x, y: away.y, trackIndex: 80, progress: away.cumulative / track.totalLength, lastProgress: away.cumulative / track.totalLength });
  simulation.step(1 / 60);
  crossStart();
  assert.equal(car.lap, 0);
  assert.equal(car.cleanLap, false);
}

// Placement is based on completed laps plus mapped route progress. A car one
// full lap ahead stays in front even when the lapped rival has greater raw track
// progress or is physically nearby.
{
  const track = generateTrack("lapping-order", 2);
  const simulation = new RaceSimulation({ track, entries: [raceEntry("leader"), raceEntry("lapped")], laps: 5 });
  skipCountdown(simulation);
  const [leader, lapped] = simulation.cars;
  const leaderPoint = pointAtTrackProgress(track, 0.18);
  const lappedPoint = pointAtTrackProgress(track, 0.91);
  Object.assign(leader, { startedLap: true, lap: 2, progress: 0.18, lastProgress: 0.18, trackIndex: leaderPoint.index, x: leaderPoint.x, y: leaderPoint.y, angle: Math.atan2(leaderPoint.ty, leaderPoint.tx), vx: 0, vy: 0 });
  Object.assign(lapped, { startedLap: true, lap: 1, progress: 0.91, lastProgress: 0.91, trackIndex: lappedPoint.index, x: lappedPoint.x, y: lappedPoint.y, angle: Math.atan2(lappedPoint.ty, lappedPoint.tx), vx: 0, vy: 0 });
  simulation.setInput(leader.id, neutralInput());
  simulation.setInput(lapped.id, neutralInput());
  simulation.step(0);
  assert.equal(leader.place, 1);
  assert.equal(lapped.place, 2);
  assert.ok(leader.raceDistance > lapped.raceDistance);
}


// Every circuit keeps the existing variable runoff but adds several broad safety
// pockets that smoothly reach twice the local base width. Sand and gravel are
// generated as long, coherent sections rather than single-sample visual noise.
{
  const track = generateTrack("runoff-surfaces-and-width", 3, "ruins");
  const types = new Set(track.samples.flatMap((point) => [
    runoffSurfaceForSide(point, 1), runoffSurfaceForSide(point, -1)
  ]));
  assert.deepEqual(types, new Set(["grass", "sand", "gravel"]));
  const expansions = track.samples.flatMap((point) => [
    Number(point.runoffWideLeft) || 0,
    Number(point.runoffWideRight) || 0
  ]);
  assert.ok(Math.max(...expansions) > 0.97, `maximum runoff expansion was ${Math.max(...expansions)}`);
  assert.ok(expansions.filter((value) => value > 0.55).length >= 8);
  for (const type of ["sand", "gravel"]) {
    const left = track.samples.map((point) => runoffSurfaceForSide(point, 1) === type);
    const right = track.samples.map((point) => runoffSurfaceForSide(point, -1) === type);
    const longestRun = (flags) => {
      let best = 0;
      let current = 0;
      for (const active of [...flags, ...flags]) {
        current = active ? current + 1 : 0;
        best = Math.max(best, current);
      }
      return Math.min(best, flags.length);
    };
    assert.ok(Math.max(longestRun(left), longestRun(right)) >= 5, `${type} patch was too fragmented`);
  }
}

// Surface physics are deliberately distinct. Grass is the fastest escape route
// but becomes unstable under steering, gravel has stronger drag and can kick a
// wheel, while sand suppresses yaw and makes acceleration very difficult.
{
  const baseTrack = generateTrack("surface-physics", 2, "woodland");
  const sampleIndex = baseTrack.samples.findIndex((point) => point.grassWidthLeft > 95);
  assert.ok(sampleIndex >= 0);
  const runSurface = (type, { steer = 0, forceKick = false } = {}) => {
    const track = structuredClone(baseTrack);
    track.scenery = [];
    for (const point of track.samples) {
      point.wallLeftAlpha = 0;
      point.wallRightAlpha = 0;
      point.surfaceLeft = type;
      point.surfaceRight = type;
    }
    const simulation = new RaceSimulation({ track, entries: [raceEntry(`surface-${type}`)], laps: 2 });
    skipCountdown(simulation);
    const car = simulation.cars[0];
    const point = track.samples[sampleIndex];
    const offset = track.width * 0.5 + Math.min(70, point.grassWidthLeft * 0.55);
    Object.assign(car, {
      x: point.x + point.nx * offset,
      y: point.y + point.ny * offset,
      angle: Math.atan2(point.ty, point.tx),
      vx: point.tx * 260,
      vy: point.ty * 260,
      trackIndex: sampleIndex
    });
    if (forceKick) car.rng = () => 0;
    let maximumAngularVelocity = 0;
    for (let tick = 0; tick < 30; tick += 1) {
      simulation.setInput(car.id, { ...neutralInput(), throttle: 1, steer });
      simulation.step(1 / 60);
      maximumAngularVelocity = Math.max(maximumAngularVelocity, Math.abs(car.angularVelocity));
    }
    return {
      speed: Math.hypot(car.vx, car.vy),
      angularVelocity: Math.abs(car.angularVelocity),
      maximumAngularVelocity,
      surfaceType: car.surfaceType,
      kickCooldown: car.surfaceKickCooldown
    };
  };
  const grass = runSurface("grass", { steer: 1 });
  const gravel = runSurface("gravel", { forceKick: true });
  const sand = runSurface("sand");
  assert.equal(grass.surfaceType, "grass");
  assert.equal(gravel.surfaceType, "gravel");
  assert.equal(sand.surfaceType, "sand");
  assert.ok(sand.speed < gravel.speed && gravel.speed < grass.speed,
    `unexpected surface speeds: sand=${sand.speed}, gravel=${gravel.speed}, grass=${grass.speed}`);
  assert.ok(grass.angularVelocity > 0.65, `grass yaw was ${grass.angularVelocity}`);
  assert.ok(gravel.kickCooldown > 0, "gravel did not trigger its deterministic wheel kick");
  assert.ok(gravel.maximumAngularVelocity > 0.08, `gravel peak yaw was ${gravel.maximumAngularVelocity}`);
  assert.ok(sand.angularVelocity < 0.05, `sand failed to suppress yaw: ${sand.angularVelocity}`);
}



// The physical wall route follows the asphalt under the car even before the pit
// entry state machine has committed the driver. A car already on the distinct
// pit ribbon cannot pass through the visible service-area fence while still in
// the generic track state.
{
  const track = generateTrack("pit-wall-physical-route", 3);
  track.scenery = [];
  const point = track.pit.samples[track.pit.serviceIndex];
  const side = Number(point.wallLeftAlpha) > 0.9 ? 1 : -1;
  const simulation = new RaceSimulation({ track, entries: [raceEntry("pit-wall-route")], laps: 2, requiredPitStops: 1 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  const wall = wallBoundaryPoint(point, track.pit.width, side);
  const startOffset = side * (track.pit.width * 0.5 - car.physics.collisionHalfWidth * 0.65);
  const progress = ((Number(point.mainProgressUnwrapped) % 1) + 1) % 1;
  Object.assign(car, {
    x: point.x + point.nx * startOffset,
    y: point.y + point.ny * startOffset,
    angle: Math.atan2(point.ty, point.tx),
    vx: point.nx * side * 230,
    vy: point.ny * side * 230,
    pitState: "track",
    pitIndex: track.pit.serviceIndex,
    pitProgress: point.cumulative / track.pit.totalLength,
    lastPitProgress: point.cumulative / track.pit.totalLength,
    trackIndex: point.mainIndex,
    progress,
    lastProgress: progress
  });
  const health = car.health;
  for (let tick = 0; tick < 25; tick += 1) {
    simulation.setInput(car.id, neutralInput());
    simulation.step(1 / 60);
  }
  const inwardDistance = -side * ((car.x - wall.x) * point.nx + (car.y - wall.y) * point.ny);
  assert.ok(inwardDistance >= car.physics.collisionHalfWidth * 0.92,
    `uncommitted pit car crossed the wall: ${inwardDistance}/${car.physics.collisionHalfWidth}`);
  assert.ok(car.health < health, "pit wall did not register an impact");
}

// Deep sand must remain a severe time loss without becoming a permanent trap.
// A stationary human car with straight wheels and sustained throttle can dig
// back to the asphalt under its own power.
{
  const track = generateTrack("sand-low-speed-escape", 2, "woodland");
  track.scenery = [];
  for (const point of track.samples) {
    point.surfaceLeft = "sand";
    point.surfaceRight = "sand";
    point.wallLeftAlpha = 0;
    point.wallRightAlpha = 0;
  }
  const sampleIndex = track.samples.findIndex((point) => point.grassWidthLeft > 100);
  assert.ok(sampleIndex >= 0);
  const point = track.samples[sampleIndex];
  const simulation = new RaceSimulation({ track, entries: [raceEntry("sand-escape")], laps: 2 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  const startOffset = track.width * 0.5 + 70;
  Object.assign(car, {
    x: point.x + point.nx * startOffset,
    y: point.y + point.ny * startOffset,
    angle: Math.atan2(-point.ny, -point.nx),
    vx: 0,
    vy: 0,
    trackIndex: sampleIndex
  });
  for (let tick = 0; tick < 210; tick += 1) {
    simulation.setInput(car.id, { ...neutralInput(), throttle: 1 });
    simulation.step(1 / 60);
  }
  const endOffset = (car.x - point.x) * point.nx + (car.y - point.y) * point.ny;
  assert.ok(endOffset < track.width * 0.5,
    `sand still trapped the car outside the asphalt: ${endOffset}/${track.width * 0.5}`);
  assert.ok(Math.hypot(car.vx, car.vy) > 45, "sand escape produced no usable forward motion");
}

// Ordinary high-speed steering never creates the intentional drift state.
// Ctrl plus steering enters a slide; releasing Ctrl and countersteering restores
// grip without an automatic snap.
{
  const physics = {
    maxSpeed: 450, acceleration: 90, reverseAcceleration: 58, braking: 245,
    steerRate: 1.4, lateralGrip: 2.8, longitudinalDrag: 0.25,
    rollingDrag: 20, spinResistance: 1, recovery: 1
  };
  const modifiers = {
    driftEnabled: true,
    driftAssist: 1.2,
    driftControl: 1.2
  };
  const gripState = {
    x: 0, y: 0, vx: 300, vy: 0, angle: 0, angularVelocity: 0,
    driftAmount: 0, driftDirection: 0, slipAngle: 0, lastSteer: 0
  };
  for (let tick = 0; tick < 30; tick += 1) {
    const steer = tick < 10 ? 0.9 : tick < 20 ? -0.9 : 0.9;
    applyDriveModel(gripState, {
      ...neutralInput(), throttle: tick < 12 ? 1 : 0, steer, brake: tick >= 20
    }, physics, 1 / 60, { ...modifiers, previousSteer: gripState.lastSteer });
    gripState.lastSteer = steer;
  }
  assert.equal(gripState.driftAmount, 0, "ordinary steering entered the dedicated drift state");

  const state = {
    x: 0, y: 0, vx: 300, vy: 0, angle: 0, angularVelocity: 0,
    driftAmount: 0, driftDirection: 0, slipAngle: 0, lastSteer: 0
  };
  for (let tick = 0; tick < 24; tick += 1) {
    applyDriveModel(state, {
      ...neutralInput(), throttle: 0.62, steer: 0.85, drift: true
    }, physics, 1 / 60, { ...modifiers, previousSteer: state.lastSteer });
    state.lastSteer = 0.85;
  }
  const drift = {
    yaw: Math.abs(state.angularVelocity),
    slip: Math.abs(state.slipAngle),
    amount: state.driftAmount,
    speed: Math.hypot(state.vx, state.vy)
  };
  assert.ok(drift.amount > 0.20, `Ctrl drift did not engage: ${drift.amount}`);
  assert.ok(drift.slip > 0.12, `Ctrl drift produced too little slip: ${drift.slip}`);
  assert.ok(drift.yaw > 0.55, `Ctrl drift produced too little yaw: ${drift.yaw}`);
  assert.ok(drift.speed > 150, `Ctrl drift deleted too much speed: ${drift.speed}`);

  for (let tick = 0; tick < 20; tick += 1) {
    applyDriveModel(state, {
      ...neutralInput(), throttle: 0.15, steer: -0.65, drift: false
    }, physics, 1 / 60, { ...modifiers, previousSteer: state.lastSteer });
    state.lastSteer = -0.65;
  }
  assert.ok(Math.abs(state.angularVelocity) < drift.yaw * 0.62,
    `countersteer failed to reduce yaw: ${state.angularVelocity}/${drift.yaw}`);
  assert.ok(Math.abs(state.slipAngle) < drift.slip * 0.58,
    `countersteer failed to reduce slip: ${state.slipAngle}/${drift.slip}`);
  assert.ok(state.driftAmount < drift.amount * 0.45, "releasing Ctrl did not exit the drift state");
}

// Reclaiming a temporarily automated car starts a fresh client input sequence.
// A remounted client commonly restarts at sequence 1, so preserving the prior
// session's high-water mark would remove the banner while rejecting all control.
{
  const simulation = new RaceSimulation({ track: generateTrack("claim-sequence-reset", 2), entries: [raceEntry("claim-sequence")] });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  simulation.setInput(car.id, { ...neutralInput(), throttle: 1 }, 84);
  car.temporaryAutopilot = true;
  simulation.setInput(car.id, { ...neutralInput(), steer: 1 }, 1);
  assert.equal(car.currentInput.throttle, 1, "old sequence gate unexpectedly accepted a restarted client");
  assert.equal(simulation.claimControl(car.id), true);
  simulation.setInput(car.id, { ...neutralInput(), throttle: 1, steer: -1 }, 1);
  assert.equal(car.temporaryAutopilot, false);
  assert.equal(car.currentInput.throttle, 1);
  assert.equal(car.currentInput.steer, -1);
  assert.equal(car.lastInputSequence, 1);
}

// Entering a runoff surface with straight wheels and no lateral velocity must
// alter grip and drag without adding an artificial sideways or yaw impulse.
{
  const track = generateTrack("surface-entry-no-kick", 2, "woodland");
  track.scenery = [];
  for (const point of track.samples) {
    point.wallLeftAlpha = 0;
    point.wallRightAlpha = 0;
    point.surfaceLeft = "grass";
    point.surfaceRight = "grass";
  }
  const sampleIndex = track.samples.findIndex((point) => point.grassWidthLeft > 80);
  assert.ok(sampleIndex >= 0);
  const simulation = new RaceSimulation({ track, entries: [raceEntry("surface-entry")], laps: 2 });
  skipCountdown(simulation);
  const car = simulation.cars[0];
  const point = track.samples[sampleIndex];
  const offset = track.width * 0.5 + car.physics.radius * 0.15;
  Object.assign(car, {
    x: point.x + point.nx * offset,
    y: point.y + point.ny * offset,
    angle: Math.atan2(point.ty, point.tx),
    vx: point.tx * 260,
    vy: point.ty * 260,
    angularVelocity: 0,
    trackIndex: sampleIndex
  });
  for (let tick = 0; tick < 20; tick += 1) {
    simulation.setInput(car.id, { ...neutralInput(), throttle: 1 }, tick + 1);
    simulation.step(1 / 60);
  }
  assert.ok(car.surfaceSeverity > 0.4, "test car did not enter the runoff surface");
  assert.ok(Math.abs(car.angularVelocity) < 1e-8,
    `surface transition injected yaw: ${car.angularVelocity}`);
}

console.log("core-tests: ok");
process.exit(0);
