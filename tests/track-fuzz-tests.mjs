import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { generateTrack, polylineSelfIntersects, wallBoundaryPoint, nearestTrackPoint, nearestPitPoint } = await import(path.join(root, "scripts/track.js"));

function positiveInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const trackSeeds = positiveInteger("NFS_TRACK_FUZZ_SEEDS", 400);
const wallSeeds = positiveInteger("NFS_WALL_FUZZ_SEEDS", 60);
const pitSeeds = positiveInteger("NFS_PIT_FUZZ_SEEDS", 120);

function headingTurn(points, width, side, closed = true, alphaKey = null) {
  const boundary = points.map((point) => wallBoundaryPoint(point, width, side));
  let maximum = 0;
  const start = closed ? 0 : 1;
  const end = closed ? boundary.length : boundary.length - 1;
  for (let index = start; index < end; index += 1) {
    const previous = boundary[(index - 1 + boundary.length) % boundary.length];
    const point = boundary[index];
    const next = boundary[(index + 1) % boundary.length];
    if (alphaKey && (
      Number(points[(index - 1 + points.length) % points.length]?.[alphaKey] ?? 1) < 0.08
      || Number(points[index]?.[alphaKey] ?? 1) < 0.08
      || Number(points[(index + 1) % points.length]?.[alphaKey] ?? 1) < 0.08
    )) continue;
    const before = Math.atan2(point.y - previous.y, point.x - previous.x);
    const after = Math.atan2(next.y - point.y, next.x - point.x);
    maximum = Math.max(maximum, Math.abs(Math.atan2(Math.sin(after - before), Math.cos(after - before))));
  }
  return maximum;
}

for (let seed = 0; seed < trackSeeds; seed += 1) {
  const track = generateTrack(seed, 1 + seed % 5);
  assert.equal(polylineSelfIntersects(track.samples), false, `self-intersection at seed ${seed}`);
  assert.ok(track.scenery.length >= 18, `scenery generation starved at seed ${seed}`);
  for (const obstacle of track.scenery) {
    const main = nearestTrackPoint(track, obstacle.x, obstacle.y);
    const pit = nearestPitPoint(track, obstacle.x, obstacle.y);
    assert.ok(main.distance >= track.width * 0.5 + obstacle.collisionRadius + 7.7, `scenery entered track at seed ${seed}`);
    assert.ok(pit.distance >= track.pit.width * 0.5 + obstacle.collisionRadius + 11.7, `scenery entered pit at seed ${seed}`);
  }
  if (track.complexity === 5) {
    assert.ok(track.tournamentLayout.longStraights.length >= 1 && track.tournamentLayout.longStraights.length <= 2,
      `tournament straight count invalid at seed ${seed}`);
    assert.ok(track.tournamentLayout.longestStraightRatio >= 0.105, `tournament straight too short at seed ${seed}`);
    assert.ok(track.tournamentLayout.technicalRatio >= 0.28, `tournament technical section too small at seed ${seed}`);
  }
}

for (let seed = 0; seed < wallSeeds; seed += 1) {
  const complexity = 1 + seed % 5;
  const track = generateTrack(`wall-smooth-${seed}`, complexity);
  const asymmetry = Math.max(...track.samples.map((point) => Math.abs(point.grassWidthLeft - point.grassWidthRight)));
  assert.ok(asymmetry > track.width * 0.10, `runoff was effectively uniform at seed ${seed}`);
  assert.equal(polylineSelfIntersects(track.samples.map((point) => wallBoundaryPoint(point, track.width, 1))), false, `left perimeter crossed itself at seed ${seed}`);
  assert.equal(polylineSelfIntersects(track.samples.map((point) => wallBoundaryPoint(point, track.width, -1))), false, `right perimeter crossed itself at seed ${seed}`);
  const wallTurnLimit = complexity >= 3 ? 2.45 : 1.50;
  assert.ok(headingTurn(track.samples, track.width, 1) < wallTurnLimit, `left perimeter hooked at seed ${seed}`);
  assert.ok(headingTurn(track.samples, track.width, -1) < wallTurnLimit, `right perimeter hooked at seed ${seed}`);
  assert.ok(headingTurn(track.pit.samples, track.pit.width, 1, false, "wallLeftAlpha") < 0.72, `left pit wall hooked at seed ${seed}`);
  assert.ok(headingTurn(track.pit.samples, track.pit.width, -1, false, "wallRightAlpha") < 0.72, `right pit wall hooked at seed ${seed}`);
  const pitWindow = track.pit.exitMainProgressNormalized >= track.pit.entryMainProgressNormalized
    ? track.pit.exitMainProgressNormalized - track.pit.entryMainProgressNormalized
    : 1 - track.pit.entryMainProgressNormalized + track.pit.exitMainProgressNormalized;
  assert.ok(pitWindow < 0.13, `pit branch was too long at seed ${seed}`);
  assert.ok(Math.min(...track.pit.samples.slice(track.pit.serviceStart, track.pit.serviceEnd + 1).map((point) => point.grassWidthRight)) < 0.001);
}

for (let seed = 0; seed < pitSeeds; seed += 1) {
  const track = generateTrack(`pit-junction-${seed}`, 1 + seed % 4);
  const pit = track.pit;
  const outerKey = pit.outerSide > 0 ? "wallLeftAlpha" : "wallRightAlpha";
  const innerKey = pit.innerSide > 0 ? "wallLeftAlpha" : "wallRightAlpha";
  for (const index of [0, pit.samples.length - 1]) {
    const pitPoint = pit.samples[index];
    const mainPoint = track.samples[pitPoint.mainIndex];
    const adjacentPit = index === 0
      ? pit.samples.slice(0, Math.min(4, pit.samples.length))
      : pit.samples.slice(Math.max(0, pit.samples.length - 4));
    const outerCoverage = Math.max(Number(mainPoint[outerKey] ?? 0), ...adjacentPit.map((sample) => Number(sample[outerKey] ?? 0)));
    assert.ok(outerCoverage > 0.92, `outer perimeter vanished at the fork at seed ${seed}`);
    assert.ok(Number(pitPoint[outerKey]) < 0.08, `pit perimeter doubled the circuit wall at seed ${seed}`);
    assert.ok(Number(pitPoint[innerKey]) < 0.08, `pit median started as a rail hook at seed ${seed}`);
  }
  const service = pit.samples[pit.serviceIndex];
  assert.ok(Number(service[innerKey]) > 0.94, `pit median did not close at seed ${seed}`);
  assert.ok(Number(service[outerKey]) > 0.94, `pit outer wall did not close at seed ${seed}`);
  const mainMedianKey = pit.side > 0 ? "wallLeftAlpha" : "wallRightAlpha";
  const serviceMain = track.samples[service.mainIndex];
  assert.ok(Number(serviceMain[mainMedianKey]) > 0.94, `main straight wall vanished beside the pit at seed ${seed}`);
}

console.log(`track-fuzz-tests: ok (${trackSeeds} track, ${wallSeeds} wall, ${pitSeeds} pit seeds)`);
