const TRACK_LENGTH_SCALE = 3.30;
export const WALL_COLLISION_ALPHA = 0.08;
export const MAIN_TRACK_SCENERY_CLEARANCE = 8;
export const SCENERY_CLEARANCE = 12;

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

function wallSideKeys(side) {
  return side >= 0
    ? { alphaKey: "wallLeftAlpha", segmentKey: "wallLeftSegmentAlpha", xKey: "wallLeftX", yKey: "wallLeftY" }
    : { alphaKey: "wallRightAlpha", segmentKey: "wallRightSegmentAlpha", xKey: "wallRightX", yKey: "wallRightY" };
}

function hashSeed(value) {
  const text = String(value ?? 1);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function seededRng(seed) {
  let state = hashSeed(seed) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function catmullRom(p0, p1, p2, p3, t, tension = 0) {
  const clampedTension = Math.max(0, Math.min(0.85, Number(tension) || 0));
  const tangentScale = 0.5 * (1 - clampedTension);
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const m1x = (p2.x - p0.x) * tangentScale;
  const m1y = (p2.y - p0.y) * tangentScale;
  const m2x = (p3.x - p1.x) * tangentScale;
  const m2y = (p3.y - p1.y) * tangentScale;
  return {
    x: h00 * p1.x + h10 * m1x + h01 * p2.x + h11 * m2x,
    y: h00 * p1.y + h10 * m1y + h01 * p2.y + h11 * m2y
  };
}

function segmentIntersection(a, b, c, d) {
  const cross = (u, v) => u.x * v.y - u.y * v.x;
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denominator = cross(r, s);
  if (Math.abs(denominator) < 1e-8) return false;
  const qp = { x: c.x - a.x, y: c.y - a.y };
  const t = cross(qp, s) / denominator;
  const u = cross(qp, r) / denominator;
  return t > 0.015 && t < 0.985 && u > 0.015 && u < 0.985;
}

export function polylineSelfIntersects(points) {
  return Boolean(findPolylineIntersection(points));
}

function openPolylineSelfIntersects(points) {
  return Boolean(findOpenPolylineIntersection(points));
}

function findOpenPolylineIntersection(points) {
  const length = points?.length ?? 0;
  for (let i = 0; i < length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    for (let j = i + 2; j < length - 1; j += 1) {
      const c = points[j];
      const d = points[j + 1];
      if (segmentIntersection(a, b, c, d)) return { i, j };
    }
  }
  return null;
}

function findOpenPolylinePairIntersection(pointsA, pointsB) {
  const lengthA = pointsA?.length ?? 0;
  const lengthB = pointsB?.length ?? 0;
  for (let i = 0; i < lengthA - 1; i += 1) {
    const a = pointsA[i];
    const b = pointsA[i + 1];
    for (let j = 0; j < lengthB - 1; j += 1) {
      const c = pointsB[j];
      const d = pointsB[j + 1];
      if (segmentIntersection(a, b, c, d)) return { i, j };
    }
  }
  return null;
}

function findPolylineIntersection(points) {
  const length = points.length;
  for (let i = 0; i < length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % length];
    for (let j = i + 2; j < length; j += 1) {
      if ((j + 1) % length === i) continue;
      if (Math.abs(j - i) <= 2 || Math.abs(j - i) >= length - 2) continue;
      const c = points[j];
      const d = points[(j + 1) % length];
      if (segmentIntersection(a, b, c, d)) return { i, j };
    }
  }
  return null;
}

function relaxClosedWindow(points, startIndex, endIndex, padding = 4, strength = 0.38) {
  const count = points.length;
  const span = ((endIndex - startIndex) % count + count) % count;
  const touched = new Set();
  for (let offset = -padding; offset <= span + padding; offset += 1) {
    touched.add((startIndex + offset + count) % count);
  }
  const next = points.map((point) => ({ x: point.x, y: point.y }));
  for (const index of touched) {
    const previous = points[(index - 1 + count) % count];
    const point = points[index];
    const following = points[(index + 1) % count];
    const averageX = previous.x * 0.5 + following.x * 0.5;
    const averageY = previous.y * 0.5 + following.y * 0.5;
    next[index].x = point.x + (averageX - point.x) * strength;
    next[index].y = point.y + (averageY - point.y) * strength;
  }
  for (const index of touched) {
    points[index].x = next[index].x;
    points[index].y = next[index].y;
  }
}

function relaxWallCoordinateWindow(points, xKey, yKey, startIndex, endIndex, closed = false, padding = 4, strength = 0.44) {
  const count = points?.length ?? 0;
  if (!count) return;
  const touched = new Set();
  if (closed) {
    const span = ((endIndex - startIndex) % count + count) % count;
    for (let offset = -padding; offset <= span + padding; offset += 1) {
      touched.add((startIndex + offset + count) % count);
    }
  } else {
    const minimum = Math.max(0, Math.min(startIndex, endIndex) - padding);
    const maximum = Math.min(count - 1, Math.max(startIndex, endIndex) + 1 + padding);
    for (let index = minimum; index <= maximum; index += 1) touched.add(index);
  }
  const next = points.map((point) => ({ x: Number(point[xKey]), y: Number(point[yKey]) }));
  for (const index of touched) {
    if (!closed && (index === 0 || index === count - 1)) continue;
    const previous = points[closed ? (index - 1 + count) % count : index - 1];
    const point = points[index];
    const following = points[closed ? (index + 1) % count : index + 1];
    const averageX = Number(previous[xKey]) * 0.5 + Number(following[xKey]) * 0.5;
    const averageY = Number(previous[yKey]) * 0.5 + Number(following[yKey]) * 0.5;
    next[index].x = Number(point[xKey]) + (averageX - Number(point[xKey])) * strength;
    next[index].y = Number(point[yKey]) + (averageY - Number(point[yKey])) * strength;
  }
  for (const index of touched) {
    points[index][xKey] = next[index].x;
    points[index][yKey] = next[index].y;
  }
}

function smoothstep(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function smootherstep(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function angleDelta(target, current) {
  return Math.atan2(Math.sin(target - current), Math.cos(target - current));
}

function circularDistance(a, b) {
  const delta = Math.abs(a - b) % 1;
  return Math.min(delta, 1 - delta);
}

function smoothSeries(values, passes = 3, closed = true) {
  let current = values.map((value) => Number(value) || 0);
  for (let pass = 0; pass < passes; pass += 1) {
    current = current.map((value, index) => {
      if (!closed && (index === 0 || index === current.length - 1)) return value;
      const previous = current[closed ? (index - 1 + current.length) % current.length : index - 1];
      const next = current[closed ? (index + 1) % current.length : index + 1];
      return previous * 0.22 + value * 0.56 + next * 0.22;
    });
  }
  return current;
}

function localCurveData(samples, index, span = 4) {
  const count = samples.length;
  const previous = samples[(index - span + count) % count];
  const next = samples[(index + span) % count];
  const headingBefore = Math.atan2(previous.ty, previous.tx);
  const headingAfter = Math.atan2(next.ty, next.tx);
  const signedTurn = angleDelta(headingAfter, headingBefore);
  const turn = Math.abs(signedTurn);
  if (turn < 0.003) return { radius: Infinity, signedTurn: 0 };
  const chord = Math.hypot(next.x - previous.x, next.y - previous.y);
  return {
    radius: chord / Math.max(0.001, 2 * Math.sin(turn * 0.5)),
    signedTurn
  };
}

export const RUNOFF_SURFACES = Object.freeze(["grass", "sand", "gravel"]);

function circularBump(progress, center, halfWidth) {
  const distance = circularDistance(progress, center);
  if (distance >= halfWidth) return 0;
  return smootherstep(1 - distance / Math.max(0.001, halfWidth));
}

function makeWideRunoffZones(seed) {
  const rng = seededRng(`${seed}:wide-runoff-zones`);
  const zones = [];
  const desired = 4;
  for (let attempt = 0; attempt < 80 && zones.length < desired; attempt += 1) {
    const center = 0.08 + rng() * 0.84;
    const halfWidth = 0.030 + rng() * 0.030;
    const side = zones.length % 2 === 0 ? (rng() < 0.5 ? 1 : -1) : -zones.at(-1).side;
    if (zones.some((zone) => circularDistance(zone.center, center) < zone.halfWidth + halfWidth + 0.035)) continue;
    zones.push({ center, halfWidth, side });
  }
  return zones;
}

function makeSurfacePatches(seed, theme) {
  const rng = seededRng(`${seed}:runoff-surfaces:${theme}`);
  const themeCounts = {
    industrial: { sand: 1, gravel: 4 },
    woodland: { sand: 1, gravel: 2 },
    estate: { sand: 1, gravel: 3 },
    ruins: { sand: 2, gravel: 4 },
    tournament: { sand: 2, gravel: 4 }
  };
  const counts = themeCounts[theme] ?? { sand: 2, gravel: 3 };
  const requested = [
    ...Array.from({ length: counts.sand }, () => "sand"),
    ...Array.from({ length: counts.gravel }, () => "gravel")
  ];
  const patches = [];
  for (const type of requested) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const center = 0.065 + rng() * 0.87;
      const halfWidth = (type === "sand" ? 0.030 : 0.024) + rng() * (type === "sand" ? 0.032 : 0.026);
      const side = rng() < 0.5 ? 1 : -1;
      if (patches.some((patch) => patch.side === side
        && circularDistance(patch.center, center) < patch.halfWidth + halfWidth + 0.018)) continue;
      patches.push({ type, center, halfWidth, side });
      break;
    }
  }
  return patches;
}

function assignTrackRunoffProfile(samples, totalLength, baseWidth, seed, theme = "auto") {
  const rng = seededRng(`${seed}:grass-profile`);
  const anchorCount = 14;
  const leftAnchors = Array.from({ length: anchorCount }, () => 0.30 + rng() * 0.24);
  const rightAnchors = Array.from({ length: anchorCount }, () => 0.30 + rng() * 0.24);
  const rawLeft = [];
  const rawRight = [];
  const wideZones = makeWideRunoffZones(seed);
  const surfacePatches = makeSurfacePatches(seed, theme);

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const point = samples[sampleIndex];
    const progress = point.cumulative / Math.max(1, totalLength);
    const scaled = progress * anchorCount;
    const index = Math.floor(scaled) % anchorCount;
    const next = (index + 1) % anchorCount;
    const blend = smootherstep(scaled - Math.floor(scaled));
    const leftNoise = leftAnchors[index] + (leftAnchors[next] - leftAnchors[index]) * blend;
    const rightNoise = rightAnchors[index] + (rightAnchors[next] - rightAnchors[index]) * blend;

    // Real circuits do not use equal-width ribbons. Runoff is broader on the
    // outside of fast bends and narrower on the inside. A few long, smooth
    // safety pockets then expand the existing local width up to exactly twice
    // its normal value instead of replacing the useful variable profile.
    const { radius: curveRadius, signedTurn } = localCurveData(samples, sampleIndex, 5);
    const curveStrength = Number.isFinite(curveRadius)
      ? Math.max(0, Math.min(1, (baseWidth * 5.4 - curveRadius) / Math.max(1, baseWidth * 4.5)))
      : 0;
    const straightness = 1 - curveStrength;
    const outsideBonus = curveStrength * 0.34;
    const insideReduction = curveStrength * 0.18;
    const straightApron = straightness * 0.06;

    let leftVariation = leftNoise + straightApron;
    let rightVariation = rightNoise + straightApron;
    if (signedTurn > 0.002) {
      leftVariation -= insideReduction;
      rightVariation += outsideBonus;
    } else if (signedTurn < -0.002) {
      rightVariation -= insideReduction;
      leftVariation += outsideBonus;
    }

    const innerCap = Number.isFinite(curveRadius)
      ? Math.max(baseWidth * 0.08, curveRadius * 0.21 - baseWidth * 0.5)
      : baseWidth * 0.78;
    const outerCap = baseWidth * (0.82 + curveStrength * 0.18);
    const leftCap = signedTurn > 0 ? innerCap : outerCap;
    const rightCap = signedTurn < 0 ? innerCap : outerCap;

    rawLeft.push(Math.min(baseWidth * Math.max(0.12, Math.min(0.92, leftVariation)), leftCap));
    rawRight.push(Math.min(baseWidth * Math.max(0.12, Math.min(0.92, rightVariation)), rightCap));
  }

  const left = smoothSeries(rawLeft, 7, true);
  const right = smoothSeries(rawRight, 7, true);
  for (let index = 0; index < samples.length; index += 1) {
    const point = samples[index];
    const progress = point.cumulative / Math.max(1, totalLength);
    const finishDistance = circularDistance(progress, 0);
    const finishVerge = 0.28 + 0.72 * smootherstep((finishDistance - 0.010) / 0.045);
    const leftExpansion = Math.max(0, ...wideZones.filter((zone) => zone.side > 0)
      .map((zone) => circularBump(progress, zone.center, zone.halfWidth)));
    const rightExpansion = Math.max(0, ...wideZones.filter((zone) => zone.side < 0)
      .map((zone) => circularBump(progress, zone.center, zone.halfWidth)));
    point.grassWidthLeft = Math.max(baseWidth * 0.06, left[index] * finishVerge * (1 + leftExpansion));
    point.grassWidthRight = Math.max(baseWidth * 0.06, right[index] * finishVerge * (1 + rightExpansion));
    point.grassWidth = (point.grassWidthLeft + point.grassWidthRight) * 0.5;
    point.runoffWideLeft = leftExpansion;
    point.runoffWideRight = rightExpansion;
    point.surfaceLeft = "grass";
    point.surfaceRight = "grass";
    for (const patch of surfacePatches) {
      if (circularDistance(progress, patch.center) > patch.halfWidth) continue;
      if (patch.side > 0) point.surfaceLeft = patch.type;
      else point.surfaceRight = patch.type;
    }
    point.wallLeftAlpha = 1;
    point.wallRightAlpha = 1;
  }
}

function safeOffsetPoint(points, index, distance, side, closed = true) {
  const count = points.length;
  const point = points[index];
  if (!point) return { x: 0, y: 0 };
  if (!closed && (index === 0 || index === count - 1)) {
    return {
      x: point.x + point.nx * distance * side,
      y: point.y + point.ny * distance * side
    };
  }

  const previous = points[closed ? (index - 1 + count) % count : index - 1];
  const next = points[closed ? (index + 1) % count : index + 1];
  const previousLength = Math.hypot(point.x - previous.x, point.y - previous.y) || 1;
  const nextLength = Math.hypot(next.x - point.x, next.y - point.y) || 1;
  const previousTx = (point.x - previous.x) / previousLength;
  const previousTy = (point.y - previous.y) / previousLength;
  const nextTx = (next.x - point.x) / nextLength;
  const nextTy = (next.y - point.y) / nextLength;
  const previousNx = -previousTy * side;
  const previousNy = previousTx * side;
  const nextNx = -nextTy * side;
  const nextNy = nextTx * side;
  const sumX = previousNx + nextNx;
  const sumY = previousNy + nextNy;
  const sumLength = Math.hypot(sumX, sumY);

  if (sumLength < 0.08) {
    return {
      x: point.x + point.nx * distance * side,
      y: point.y + point.ny * distance * side
    };
  }

  const bisectorX = sumX / sumLength;
  const bisectorY = sumY / sumLength;
  const denominator = bisectorX * nextNx + bisectorY * nextNy;
  if (denominator < 0.22) {
    return {
      x: point.x + point.nx * distance * side,
      y: point.y + point.ny * distance * side
    };
  }

  // True miter joins become enormous at acute corners. Clamp them into a short
  // bevel-like join, preserving technical corners without producing hooks that
  // cross the circuit or fill half the screen.
  const rawMiter = distance / denominator;
  const localSegment = Math.min(previousLength, nextLength);
  // Acute corners are visually better with a short bevel than with a long miter.
  // A stricter cap avoids the hooked rails that can still appear in hairpins.
  const maximumMiter = Math.min(distance * 1.34, distance + localSegment * 0.22);
  const miter = Math.max(distance * 0.76, Math.min(maximumMiter, rawMiter));
  return {
    x: point.x + bisectorX * miter,
    y: point.y + bisectorY * miter
  };
}

function assignWallCoordinates(points, roadWidth, closed = true) {
  const halfRoad = Math.max(0, Number(roadWidth) || 0) * 0.5;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const leftDistance = halfRoad + Math.max(0, Number(point.grassWidthLeft ?? point.grassWidth ?? 0));
    const rightDistance = halfRoad + Math.max(0, Number(point.grassWidthRight ?? point.grassWidth ?? 0));
    const left = safeOffsetPoint(points, index, leftDistance, 1, closed);
    const right = safeOffsetPoint(points, index, rightDistance, -1, closed);
    point.wallLeftX = left.x;
    point.wallLeftY = left.y;
    point.wallRightX = right.x;
    point.wallRightY = right.y;
  }
}

function constrainWallCoordinates(points, roadWidth) {
  const halfRoad = Math.max(0, Number(roadWidth) || 0) * 0.5;
  for (const point of points) {
    for (const side of [1, -1]) {
      const xKey = side > 0 ? "wallLeftX" : "wallRightX";
      const yKey = side > 0 ? "wallLeftY" : "wallRightY";
      const grass = side > 0
        ? Number(point.grassWidthLeft ?? point.grassWidth ?? 0)
        : Number(point.grassWidthRight ?? point.grassWidth ?? 0);
      const required = halfRoad + Math.max(0, grass);
      const dx = Number(point[xKey]) - point.x;
      const dy = Number(point[yKey]) - point.y;
      const projected = (dx * point.nx + dy * point.ny) * side;
      if (!Number.isFinite(projected) || projected < required) {
        point[xKey] = point.x + point.nx * required * side;
        point[yKey] = point.y + point.ny * required * side;
      }
    }
  }
}

// A wall is rendered as straight segments between sampled vertices. Checking
// only the vertex normal is insufficient: on a tight bend the chord between two
// otherwise legal endpoints can cut through the asphalt. Iteratively project
// every endpoint against each adjacent road segment, moving it only outwards.
// Because both the required width and the wall chord interpolate linearly along
// a segment, legal endpoints guarantee that the whole visible segment remains
// outside the road surface.
function enforceWallSegmentClearance(points, roadWidth, closed = true, passes = 8) {
  if (!points?.length || points.length < 2) return;
  const halfRoad = Math.max(0, Number(roadWidth) || 0) * 0.5;
  const segmentCount = closed ? points.length : points.length - 1;
  for (let pass = 0; pass < passes; pass += 1) {
    let maximumDeficit = 0;
    for (let index = 0; index < segmentCount; index += 1) {
      const nextIndex = closed ? (index + 1) % points.length : index + 1;
      const start = points[index];
      const end = points[nextIndex];
      const sx = end.x - start.x;
      const sy = end.y - start.y;
      const length = Math.hypot(sx, sy) || 1;
      const nx = -sy / length;
      const ny = sx / length;
      for (const side of [1, -1]) {
        const xKey = side > 0 ? "wallLeftX" : "wallRightX";
        const yKey = side > 0 ? "wallLeftY" : "wallRightY";
        for (const point of [start, end]) {
          const grass = side > 0
            ? Number(point.grassWidthLeft ?? point.grassWidth ?? 0)
            : Number(point.grassWidthRight ?? point.grassWidth ?? 0);
          const required = halfRoad + Math.max(0, grass);
          const dx = Number(point[xKey]) - point.x;
          const dy = Number(point[yKey]) - point.y;
          const projected = (dx * nx + dy * ny) * side;
          const deficit = required - projected;
          if (!Number.isFinite(projected) || deficit > 0.001) {
            const correction = Number.isFinite(deficit) ? deficit + 0.01 : required;
            point[xKey] = (Number.isFinite(Number(point[xKey])) ? Number(point[xKey]) : point.x) + nx * side * correction;
            point[yKey] = (Number.isFinite(Number(point[yKey])) ? Number(point[yKey]) : point.y) + ny * side * correction;
            maximumDeficit = Math.max(maximumDeficit, correction);
          }
        }
      }
    }
    if (maximumDeficit < 0.002) break;
  }
}

function smoothWallCoordinates(points, passes = 2, closed = true) {
  const pairs = [["wallLeftX", "wallLeftY"], ["wallRightX", "wallRightY"]];
  for (let pass = 0; pass < passes; pass += 1) {
    for (const [xKey, yKey] of pairs) {
      const next = points.map((point) => ({ x: Number(point[xKey]), y: Number(point[yKey]) }));
      for (let index = 0; index < points.length; index += 1) {
        if (!closed && (index === 0 || index === points.length - 1)) continue;
        const previous = points[closed ? (index - 1 + points.length) % points.length : index - 1];
        const point = points[index];
        const following = points[closed ? (index + 1) % points.length : index + 1];
        next[index] = {
          x: Number(previous[xKey]) * 0.18 + Number(point[xKey]) * 0.64 + Number(following[xKey]) * 0.18,
          y: Number(previous[yKey]) * 0.18 + Number(point[yKey]) * 0.64 + Number(following[yKey]) * 0.18
        };
      }
      for (let index = 0; index < points.length; index += 1) {
        points[index][xKey] = next[index].x;
        points[index][yKey] = next[index].y;
      }
    }
  }
}

function repairOpenWallIntersections(points, roadWidth, passes = 6) {
  if (!points?.length || points.length < 4) return;
  for (let pass = 0; pass < passes; pass += 1) {
    const left = points.map((point) => ({ x: Number(point.wallLeftX), y: Number(point.wallLeftY) }));
    const right = points.map((point) => ({ x: Number(point.wallRightX), y: Number(point.wallRightY) }));
    const leftHit = findOpenPolylineIntersection(left);
    const rightHit = findOpenPolylineIntersection(right);
    const pairHit = findOpenPolylinePairIntersection(left, right);
    if (!leftHit && !rightHit && !pairHit) break;
    if (leftHit) relaxWallCoordinateWindow(points, "wallLeftX", "wallLeftY", leftHit.i, leftHit.j + 1, false, 4, 0.48);
    if (rightHit) relaxWallCoordinateWindow(points, "wallRightX", "wallRightY", rightHit.i, rightHit.j + 1, false, 4, 0.48);
    if (pairHit) {
      relaxWallCoordinateWindow(points, "wallLeftX", "wallLeftY", pairHit.i, pairHit.i + 1, false, 5, 0.50);
      relaxWallCoordinateWindow(points, "wallRightX", "wallRightY", pairHit.j, pairHit.j + 1, false, 5, 0.50);
    }
    constrainWallCoordinates(points, roadWidth);
  }
}

function maximumPolylineTurn(points, closed = true) {
  if (!points?.length || points.length < 3) return 0;
  let maximum = 0;
  const start = closed ? 0 : 1;
  const end = closed ? points.length : points.length - 1;
  for (let index = start; index < end; index += 1) {
    const previous = points[closed ? (index - 1 + points.length) % points.length : index - 1];
    const point = points[index];
    const next = points[closed ? (index + 1) % points.length : index + 1];
    const before = Math.atan2(point.y - previous.y, point.x - previous.x);
    const after = Math.atan2(next.y - point.y, next.x - point.x);
    maximum = Math.max(maximum, Math.abs(angleDelta(after, before)));
  }
  return maximum;
}

function curveScore(samples, rawIndex, span = 7) {
  const count = samples.length;
  const index = (rawIndex % count + count) % count;
  const previous = samples[(index - span + count) % count];
  const next = samples[(index + span) % count];
  const before = Math.atan2(previous.ty, previous.tx);
  const after = Math.atan2(next.ty, next.tx);
  return Math.abs(angleDelta(after, before));
}

function choosePitWindows(trackSamples, fullOffset) {
  const count = trackSamples.length;
  const totalLength = Math.max(1, Number(trackSamples[count - 1]?.cumulative ?? 0) + Number(trackSamples[count - 1]?.segmentLength ?? 0));
  const progressAt = (index) => Number(trackSamples[(index % count + count) % count]?.cumulative ?? 0) / totalLength;
  const indexAtProgress = (progress) => {
    const loop = Math.floor(progress);
    const normalized = progress - loop;
    let low = 0;
    let high = count - 1;
    while (low < high) {
      const middle = Math.floor((low + high) * 0.5);
      if (progressAt(middle) < normalized) low = middle + 1;
      else high = middle;
    }
    return loop * count + low;
  };
  const candidates = [];

  // Select the branch by arc length rather than by sample count. Tournament
  // tracks deliberately use non-uniformly spaced samples around long straights
  // and technical complexes; an index-ratio window would make their pit lane
  // much longer than the same setting on a conventional circuit.
  for (let startProgress = 0.925; startProgress <= 0.975; startProgress += 0.005) {
    for (let windowProgress = 0.070; windowProgress <= 0.125; windowProgress += 0.005) {
      const startIndex = indexAtProgress(startProgress);
      const endUnwrapped = indexAtProgress(startProgress + windowProgress);
      const length = endUnwrapped - startIndex;
      if (length < 8) continue;

      for (const side of [-1, 1]) {
        let score = Math.abs(startProgress - 0.95) * 0.62 + Math.abs(windowProgress - 0.095) * 0.54;
        const probes = [0, 0.07, 0.14, 0.24, 0.36, 0.50, 0.64, 0.76, 0.86, 0.93, 1];
        let maximumInsideRatio = 0;
        let maximumMergeTurn = 0;
        let maximumTurn = 0;
        let signedTurnSum = 0;
        let insideProbeCount = 0;
        for (const probe of probes) {
          const rawIndex = Math.round(startIndex + length * probe);
          const mergeProbe = probe < 0.26 || probe > 0.74;
          const edgeWeight = mergeProbe ? 6.4 : 0.62;
          const { radius, signedTurn } = localCurveData(trackSamples, rawIndex % count, mergeProbe ? 5 : 7);
          const turn = Math.abs(signedTurn);
          signedTurnSum += signedTurn;
          maximumTurn = Math.max(maximumTurn, turn);
          if (mergeProbe) maximumMergeTurn = Math.max(maximumMergeTurn, turn);
          score += turn * turn * edgeWeight;

          if (Number.isFinite(radius) && signedTurn * side > 0) {
            insideProbeCount += 1;
            const insideRatio = fullOffset / Math.max(1, radius);
            maximumInsideRatio = Math.max(maximumInsideRatio, insideRatio);
            score += insideRatio * insideRatio * edgeWeight * 7.5;
          }
        }
        if (maximumInsideRatio > 0.12) score += 190 + (maximumInsideRatio - 0.12) * 220;
        if (maximumMergeTurn > 0.18) score += (maximumMergeTurn - 0.18) * 24;
        if (maximumTurn > 0.20) score += (maximumTurn - 0.20) * 42;
        if (maximumTurn > 0.34) score += 12;
        score += Math.max(0, signedTurnSum * side) * 18;
        score += insideProbeCount * 0.65;
        candidates.push({ startIndex, endUnwrapped, side, score, startProgress, windowProgress });
      }
    }
  }
  candidates.sort((a, b) => a.score - b.score
    || a.startProgress - b.startProgress
    || a.windowProgress - b.windowProgress
    || a.side - b.side);
  if (candidates.length) return candidates;
  return [{
    startIndex: indexAtProgress(0.95),
    endUnwrapped: indexAtProgress(1.045),
    side: -1,
    score: Infinity,
    startProgress: 0.95,
    windowProgress: 0.095
  }];
}

function smoothOpenCoordinates(samples, passes = 2) {
  for (let pass = 0; pass < passes; pass += 1) {
    const next = samples.map((point) => ({ ...point }));
    for (let index = 2; index < samples.length - 2; index += 1) {
      const previous = samples[index - 1];
      const point = samples[index];
      const following = samples[index + 1];
      const weight = smootherstep(Math.min(1, point.separation * 1.6));
      next[index].x = point.x * (1 - weight * 0.34) + (previous.x * 0.20 + point.x * 0.60 + following.x * 0.20) * weight * 0.34;
      next[index].y = point.y * (1 - weight * 0.34) + (previous.y * 0.20 + point.y * 0.60 + following.y * 0.20) * weight * 0.34;
    }
    for (let index = 0; index < samples.length; index += 1) Object.assign(samples[index], next[index]);
  }
}

function makeExtremeProfileSamples(rng, irregularity = 1) {
  const count = 360;
  const base = 940 * TRACK_LENGTH_SCALE;
  const phaseA = rng() * Math.PI * 2;
  const phaseB = rng() * Math.PI * 2;
  const phaseC = rng() * Math.PI * 2;
  const amplitudeA = (0.285 + rng() * 0.050) * irregularity;
  const amplitudeB = (0.125 + rng() * 0.035) * irregularity;
  return Array.from({ length: count }, (_, index) => {
    const theta = index / count * Math.PI * 2;
    const radius = base * (1
      + Math.sin(theta * 4 + phaseA) * amplitudeA
      + Math.sin(theta * 7 + phaseB) * amplitudeB
      + Math.sin(theta * 11 + phaseC) * 0.052 * irregularity
      + Math.sin(theta * 15 + phaseA * 0.6) * 0.022 * irregularity);
    const verticalScale = 0.67 + Math.sin(theta * 3 + phaseB) * 0.045 * irregularity;
    return { x: Math.cos(theta) * radius, y: Math.sin(theta) * radius * verticalScale };
  });
}

function makeExtremeControlPoints(rng, irregularity = 1) {
  const template = [
    [-1.22, -0.55], [-0.72, -0.62], [-0.18, -0.61], [0.34, -0.58], [0.76, -0.46],
    [0.98, -0.24], [0.80, -0.06], [1.00, 0.13], [0.78, 0.33],
    [0.43, 0.49], [0.10, 0.51], [-0.08, 0.29], [-0.29, 0.50],
    [-0.68, 0.51], [-1.03, 0.34], [-0.86, 0.10], [-1.10, -0.09], [-0.93, -0.34]
  ];
  const rotation = (rng() - 0.5) * 0.34;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const scale = 970 * TRACK_LENGTH_SCALE;
  return template.map(([x, y], index) => {
    const technical = [5, 6, 7, 8, 10, 11, 12, 14, 15, 16].includes(index);
    const jitter = technical ? 0.028 : 0.016;
    const px = (x + (rng() - 0.5) * jitter * irregularity) * scale;
    const py = (y + (rng() - 0.5) * jitter * irregularity) * scale;
    return { x: px * cos - py * sin, y: px * sin + py * cos };
  });
}

function makeTournamentControlPoints(rng, irregularity = 1) {
  // Tournament courses are assembled from several genuinely different layouts.
  // Every layout contains one or two long, collinear acceleration zones, while
  // the remaining anchors form compact chicanes, switchbacks and hairpins.
  // The old superellipse only changed a few harmonic offsets, so different seeds
  // produced the same silhouette and the same rhythm of corners.
  const templates = [
    [
      [-1.58, -0.66, 0], [-1.12, -0.66, 0], [-0.58, -0.66, 0], [0.02, -0.66, 0], [0.64, -0.66, 0], [1.22, -0.66, 0], [1.58, -0.66, 0],
      [1.72, -0.48, 1], [1.48, -0.28, 1], [1.72, -0.08, 1], [1.45, 0.13, 1], [1.69, 0.36, 1], [1.38, 0.58, 1],
      [0.88, 0.68, 0], [0.31, 0.68, 0], [-0.31, 0.68, 0], [-0.88, 0.68, 0], [-1.32, 0.63, 0],
      [-1.62, 0.47, 1], [-1.43, 0.25, 1], [-1.66, 0.05, 1], [-1.41, -0.18, 1], [-1.62, -0.40, 1]
    ],
    [
      [-1.62, -0.64, 0], [-1.12, -0.64, 0], [-0.55, -0.64, 0], [0.08, -0.64, 0], [0.72, -0.64, 0], [1.30, -0.64, 0], [1.63, -0.61, 0],
      [1.76, -0.39, 1], [1.48, -0.18, 1], [1.70, 0.02, 1], [1.36, 0.19, 1], [1.58, 0.39, 1], [1.23, 0.60, 1],
      [0.82, 0.46, 1], [0.49, 0.72, 1], [0.08, 0.50, 1], [-0.31, 0.74, 1], [-0.72, 0.48, 1], [-1.12, 0.68, 1],
      [-1.52, 0.52, 1], [-1.69, 0.27, 1], [-1.42, 0.05, 1], [-1.69, -0.18, 1], [-1.45, -0.40, 1]
    ],
    [
      [-1.55, -0.68, 0], [-1.03, -0.68, 0], [-0.46, -0.68, 0], [0.17, -0.68, 0], [0.83, -0.68, 0], [1.42, -0.68, 0],
      [1.70, -0.50, 1], [1.55, -0.24, 1], [1.78, 0.00, 1], [1.51, 0.23, 1], [1.70, 0.48, 1], [1.34, 0.67, 1],
      [0.87, 0.58, 1], [0.52, 0.31, 1], [0.17, 0.57, 1], [-0.18, 0.31, 1], [-0.55, 0.61, 1],
      [-1.00, 0.70, 0], [-1.34, 0.70, 0], [-1.61, 0.62, 1], [-1.73, 0.36, 1], [-1.48, 0.15, 1], [-1.70, -0.08, 1], [-1.45, -0.35, 1]
    ],
    [
      [-1.60, -0.62, 0], [-1.08, -0.62, 0], [-0.49, -0.62, 0], [0.15, -0.62, 0], [0.82, -0.62, 0], [1.43, -0.62, 0],
      [1.73, -0.44, 1], [1.49, -0.20, 1], [1.75, 0.05, 1], [1.40, 0.24, 1], [1.60, 0.51, 1], [1.20, 0.70, 1],
      [0.70, 0.62, 1], [0.31, 0.36, 1], [-0.07, 0.70, 1], [-0.45, 0.38, 1], [-0.81, 0.67, 1], [-1.18, 0.45, 1],
      [-1.55, 0.64, 1], [-1.74, 0.38, 1], [-1.51, 0.17, 1], [-1.75, -0.05, 1], [-1.49, -0.27, 1]
    ],
    [
      [-1.64, -0.66, 0], [-1.14, -0.66, 0], [-0.58, -0.66, 0], [0.04, -0.66, 0], [0.69, -0.66, 0], [1.30, -0.66, 0], [1.64, -0.62, 0],
      [1.80, -0.39, 1], [1.52, -0.14, 1], [1.76, 0.09, 1], [1.43, 0.31, 1], [1.58, 0.58, 1], [1.16, 0.72, 1],
      [0.65, 0.72, 0], [0.15, 0.72, 0], [-0.28, 0.67, 0],
      [-0.50, 0.43, 1], [-0.82, 0.66, 1], [-1.12, 0.40, 1], [-1.45, 0.61, 1], [-1.73, 0.36, 1], [-1.50, 0.10, 1], [-1.72, -0.15, 1], [-1.44, -0.40, 1]
    ]
  ];
  const templateIndex = Math.floor(rng() * templates.length) % templates.length;
  const template = templates[templateIndex];
  const rotation = (rng() - 0.5) * 0.72;
  const mirror = rng() < 0.5 ? -1 : 1;
  const scaleX = (900 + rng() * 105) * TRACK_LENGTH_SCALE;
  const scaleY = (900 + rng() * 90) * TRACK_LENGTH_SCALE;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const points = template.map(([x, y, technical], index) => {
    const alongJitter = (rng() - 0.5) * (technical ? 0.040 : 0.010) * irregularity;
    const crossJitter = technical ? (rng() - 0.5) * 0.065 * irregularity : 0;
    const px = (x + alongJitter) * scaleX;
    const py = (y * mirror + crossJitter) * scaleY;
    return {
      x: px * cos - py * sin,
      y: px * sin + py * cos,
      tournamentTechnical: Boolean(technical),
      tournamentTemplate: templateIndex
    };
  });
  return points;
}

function makeControlPoints(rng, complexity, irregularity = 1) {
  if (complexity === 5) return makeTournamentControlPoints(rng, irregularity);
  if (complexity === 4) return makeExtremeControlPoints(rng, irregularity);
  const count = [0, 11, 12, 14, 16][complexity] ?? 12;
  const baseRadius = 760 + complexity * 55;
  const points = [];
  const angularWeights = Array.from({ length: count }, () => {
    const spread = complexity >= 4 ? 0.78 : complexity >= 3 ? 0.44 : 0.15;
    return 1 + (rng() - 0.5) * spread * irregularity;
  });
  const angularTotal = angularWeights.reduce((sum, value) => sum + value, 0);
  let angularCursor = 0;
  const phase = rng() * Math.PI * 2;
  for (let i = 0; i < count; i += 1) {
    const angle = (angularCursor / angularTotal) * Math.PI * 2;
    angularCursor += angularWeights[i];
    const waveAmplitude = complexity >= 4 ? 170 : 70 + complexity * 18;
    const wave = Math.sin(angle * (2 + complexity) + phase) * waveAmplitude * irregularity;
    const randomAmplitude = complexity >= 4 ? 430 : 210 + complexity * 48;
    const randomRadius = (rng() - 0.5) * randomAmplitude * irregularity;
    const alternating = complexity >= 4 ? (i % 2 === 0 ? 1 : -1) * 72 * irregularity : 0;
    const radius = Math.max(360, baseRadius + wave + randomRadius + alternating) * TRACK_LENGTH_SCALE;
    const jitterBase = complexity >= 4 ? 0.22 : 0.13 + complexity * 0.024;
    const angleJitter = (rng() - 0.5) * jitterBase * irregularity;
    const yScale = complexity >= 4
      ? 0.68 + rng() * 0.20 * irregularity + (1 - irregularity) * 0.10
      : 0.76 + rng() * 0.14 * irregularity + (1 - irregularity) * 0.07;
    points.push({
      x: Math.cos(angle + angleJitter) * radius,
      y: Math.sin(angle + angleJitter) * radius * yScale
    });
  }
  return points;
}

function smoothControlLoop(points, passes = 2) {
  let current = points.map((point) => ({ ...point }));
  for (let pass = 0; pass < passes; pass += 1) {
    current = current.map((point, index) => {
      const previous = current[(index - 1 + current.length) % current.length];
      const next = current[(index + 1) % current.length];
      return {
        x: point.x * 0.66 + previous.x * 0.17 + next.x * 0.17,
        y: point.y * 0.66 + previous.y * 0.17 + next.y * 0.17
      };
    });
  }
  return current;
}

function sampleSpline(controls, complexity = 2) {
  const samples = [];
  const safeComplexity = Math.max(1, Math.min(5, Number(complexity) || 2));
  const stepsPerSegment = [0, 16, 16, 16, 20, 20][safeComplexity];
  const tension = [0, 0.02, 0.12, 0.34, 0.22, 0.18][safeComplexity];
  for (let i = 0; i < controls.length; i += 1) {
    const p0 = controls[(i - 1 + controls.length) % controls.length];
    const p1 = controls[i];
    const p2 = controls[(i + 1) % controls.length];
    const p3 = controls[(i + 2) % controls.length];
    for (let step = 0; step < stepsPerSegment; step += 1) {
      samples.push(catmullRom(p0, p1, p2, p3, step / stepsPerSegment, tension));
    }
  }
  return samples;
}

function rotateToBestStart(samples) {
  if (!samples?.length) return samples;
  finalizeClosedSamples(samples);
  let bestIndex = 0;
  let bestScore = Infinity;
  const window = Math.max(12, Math.round(samples.length * 0.095));
  const step = Math.max(2, Math.round(samples.length / 90));

  for (let index = 0; index < samples.length; index += 1) {
    let maximumTurn = 0;
    let accumulatedTurn = 0;
    for (let offset = -window; offset <= window; offset += step) {
      const turn = curveScore(samples, index + offset, 4);
      maximumTurn = Math.max(maximumTurn, turn);
      accumulatedTurn += turn;
    }
    // The maximum dominates: one hairpin inside the pit window is worse than a
    // gently curving branch. The sum then chooses the broadest of equally safe
    // windows. A tiny local term keeps the line itself visually straight.
    const score = maximumTurn * 18
      + accumulatedTurn * 0.72
      + curveScore(samples, index, 3) * 2.4;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  if (bestIndex === 0) return samples;
  return [...samples.slice(bestIndex), ...samples.slice(0, bestIndex)];
}

function finalizeClosedSamples(samples) {
  let totalLength = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const point = samples[i];
    const next = samples[(i + 1) % samples.length];
    const previous = samples[(i - 1 + samples.length) % samples.length];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const magnitude = Math.hypot(dx, dy) || 1;
    point.tx = dx / magnitude;
    point.ty = dy / magnitude;
    point.nx = -point.ty;
    point.ny = point.tx;
    point.cumulative = totalLength;
    point.segmentLength = Math.hypot(next.x - point.x, next.y - point.y);
    totalLength += point.segmentLength;
  }
  return totalLength;
}

function finalizeOpenSamples(samples) {
  let totalLength = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const point = samples[i];
    const previous = samples[Math.max(0, i - 1)];
    const next = samples[Math.min(samples.length - 1, i + 1)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const magnitude = Math.hypot(dx, dy) || 1;
    point.tx = dx / magnitude;
    point.ty = dy / magnitude;
    point.nx = -point.ty;
    point.ny = point.tx;
    point.cumulative = totalLength;
    if (i < samples.length - 1) {
      point.segmentLength = Math.hypot(samples[i + 1].x - point.x, samples[i + 1].y - point.y);
      totalLength += point.segmentLength;
    } else point.segmentLength = 0;
  }
  return totalLength;
}

function buildSpatialGrid(points, cellSize, closed = true) {
  const safeCellSize = Math.max(64, Number(cellSize) || 256);
  const cells = Object.create(null);
  const segmentCount = closed ? points.length : Math.max(0, points.length - 1);
  for (let index = 0; index < segmentCount; index += 1) {
    const point = points[index];
    const next = points[closed ? (index + 1) % points.length : index + 1];
    const minX = Math.floor(Math.min(point.x, next.x) / safeCellSize);
    const maxX = Math.floor(Math.max(point.x, next.x) / safeCellSize);
    const minY = Math.floor(Math.min(point.y, next.y) / safeCellSize);
    const maxY = Math.floor(Math.max(point.y, next.y) / safeCellSize);
    for (let cellX = minX; cellX <= maxX; cellX += 1) {
      for (let cellY = minY; cellY <= maxY; cellY += 1) {
        const key = `${cellX},${cellY}`;
        (cells[key] ??= []).push(index);
      }
    }
  }
  return { cellSize: safeCellSize, cells };
}

function pitLaneDimensions(width) {
  const pitWidth = Math.max(84, width * 0.42);
  return {
    pitWidth,
    fullOffset: width * 0.70 + pitWidth * 0.62
  };
}

function buildPitLane(trackSamples, trackTotalLength, width, placement = null) {
  const count = trackSamples.length;
  const { pitWidth, fullOffset } = pitLaneDimensions(width);
  // Leave a real grass median between the two asphalt ribbons. The previous
  // offset only barely exceeded their combined half-widths, so technical bends
  // could visually and physically overlap even when both centrelines were valid.
  const selectedPlacement = placement ?? choosePitWindows(trackSamples, fullOffset)[0];
  const { startIndex, endUnwrapped, side, score: placementScore } = selectedPlacement;
  let averageTx = 0;
  let averageTy = 0;
  for (let raw = startIndex; raw <= endUnwrapped; raw += 1) {
    const point = trackSamples[(raw % count + count) % count];
    averageTx += point.tx;
    averageTy += point.ty;
  }
  const averageLength = Math.hypot(averageTx, averageTy) || 1;
  averageTx /= averageLength;
  averageTy /= averageLength;
  // Translate the short main-route window along one stable normal. Offsetting
  // every sample by its own normal makes an inside parallel curve collapse into
  // a cusp on technical bends. A fixed branch direction preserves the route's
  // shape and produces a smooth, compact pit lane.
  const branchNx = -averageTy * side;
  const branchNy = averageTx * side;
  const samples = [];
  const entryRampEnd = 0.18;
  const exitRampStart = 0.82;
  const subdivisions = 3;
  const totalSteps = Math.max(1, (endUnwrapped - startIndex) * subdivisions);

  // The main circuit can stay deliberately angular, but the pit merge needs
  // enough geometry to draw a clean Y-junction. Sample the short branch twice
  // per circuit segment instead of lengthening it around half the lap.
  for (let step = 0; step <= totalSteps; step += 1) {
    const rawPosition = startIndex + step / subdivisions;
    const raw = Math.floor(rawPosition);
    const fraction = rawPosition - raw;
    const mainIndex = (raw % count + count) % count;
    const nextIndex = (mainIndex + 1) % count;
    const current = trackSamples[mainIndex];
    const following = trackSamples[nextIndex];
    const tangentX = current.tx + (following.tx - current.tx) * fraction;
    const tangentY = current.ty + (following.ty - current.ty) * fraction;
    const tangentLength = Math.hypot(tangentX, tangentY) || 1;
    const tx = tangentX / tangentLength;
    const ty = tangentY / tangentLength;
    const frame = { tx, ty, nx: -ty, ny: tx };
    const main = {
      x: current.x + (following.x - current.x) * fraction,
      y: current.y + (following.y - current.y) * fraction,
      tx, ty, nx: -ty, ny: tx,
      cumulative: current.cumulative + current.segmentLength * fraction
    };
    const u = step / totalSteps;
    let separation;
    if (u < entryRampEnd) separation = smootherstep(u / entryRampEnd);
    else if (u > exitRampStart) separation = smootherstep((1 - u) / (1 - exitRampStart));
    else separation = 1;

    const desiredSeparation = fullOffset * separation;
    const localSideNx = frame.nx * side;
    const localSideNy = frame.ny * side;
    // A single branch normal keeps the fork smooth, but on a changing heading it
    // can project too little distance onto the local road normal and let the two
    // asphalt ribbons overlap. Blend toward the local outward normal and rescale
    // the vector so the measured lateral separation is always exact.
    let directionX = branchNx * 0.68 + localSideNx * 0.32;
    let directionY = branchNy * 0.68 + localSideNy * 0.32;
    let directionLength = Math.hypot(directionX, directionY) || 1;
    directionX /= directionLength;
    directionY /= directionLength;
    let projection = directionX * localSideNx + directionY * localSideNy;
    if (projection < 0.58) {
      directionX = branchNx * 0.28 + localSideNx * 0.72;
      directionY = branchNy * 0.28 + localSideNy * 0.72;
      directionLength = Math.hypot(directionX, directionY) || 1;
      directionX /= directionLength;
      directionY /= directionLength;
      projection = Math.max(0.58, directionX * localSideNx + directionY * localSideNy);
    }
    const travel = desiredSeparation / Math.max(0.58, projection);
    const offset = side * desiredSeparation;
    const loop = Math.floor(rawPosition / count);
    samples.push({
      x: main.x + directionX * travel,
      y: main.y + directionY * travel,
      mainIndex,
      mainProgressUnwrapped: loop + main.cumulative / Math.max(1, trackTotalLength),
      u,
      separation,
      offset,
      wallLeftAlpha: 0,
      wallRightAlpha: 0
    });
  }

  // Only a light coordinate pass is needed. The separation profile already has
  // zero first and second derivatives at both merges; excessive smoothing made
  // the pit swallow a large fraction of the circuit and rounded technical bends.
  smoothOpenCoordinates(samples, 2);
  finalizeOpenSamples(samples);
  for (const endpoint of [0, samples.length - 1]) {
    const main = trackSamples[samples[endpoint].mainIndex];
    samples[endpoint].x = main.x;
    samples[endpoint].y = main.y;
    samples[endpoint].tx = main.tx;
    samples[endpoint].ty = main.ty;
    samples[endpoint].nx = main.nx;
    samples[endpoint].ny = main.ny;
    samples[endpoint].offset = 0;
    samples[endpoint].separation = 0;
  }
  // Endpoint correction changes the final two segment lengths, so rebuild arc
  // coordinates once. This also keeps pit progress and service placement exact.
  const correctedTotalLength = finalizeOpenSamples(samples);

  const serviceStart = Math.floor(samples.length * 0.39);
  const serviceEnd = Math.floor(samples.length * 0.61);
  const serviceIndex = Math.floor((serviceStart + serviceEnd) * 0.5);
  const entryTriggerStart = Math.ceil(samples.length * 0.12);
  const entryTriggerEnd = Math.floor(samples.length * 0.27);
  const exitMergeStart = Math.floor(samples.length * 0.78);
  const exitIndex = Math.floor(samples.length * 0.91);
  const locatedStartLine = samples.findIndex((point) => point.mainProgressUnwrapped >= 1);
  const startLineIndex = Math.max(1, locatedStartLine < 0 ? Math.floor(samples.length * 0.58) : locatedStartLine);
  const outerSide = side;
  const innerSide = -side;
  const outerAlphaKey = outerSide > 0 ? "wallLeftAlpha" : "wallRightAlpha";
  const innerAlphaKey = innerSide > 0 ? "wallLeftAlpha" : "wallRightAlpha";
  const outerXKey = outerSide > 0 ? "wallLeftX" : "wallRightX";
  const outerYKey = outerSide > 0 ? "wallLeftY" : "wallRightY";
  const mainAlphaKey = outerAlphaKey;

  for (const point of samples) {
    point.grassWidthLeft = 0;
    point.grassWidthRight = 0;
    point.grassWidth = 0;
    point.surfaceLeft = "grass";
    point.surfaceRight = "grass";
  }
  assignWallCoordinates(samples, pitWidth, false);
  // Smooth the independent pit offsets before they are blended into the main
  // perimeter. Smoothing after the hand-off pulled nominally coincident merge
  // points apart and recreated a faint double rail.
  smoothWallCoordinates(samples, 3, false);
  constrainWallCoordinates(samples, pitWidth);

  const lastWallIndex = samples.length - 1;
  const entryWallEnd = Math.max(3, Math.min(lastWallIndex - 3, Math.round(lastWallIndex * entryRampEnd)));
  const exitWallStart = Math.max(entryWallEnd + 2, Math.min(lastWallIndex - 3, Math.round(lastWallIndex * exitRampStart)));
  const rawOuterWalls = samples.map((point) => ({ x: Number(point[outerXKey]), y: Number(point[outerYKey]) }));
  const entryMainPoint = trackSamples[samples[0].mainIndex];
  const exitMainPoint = trackSamples[samples[lastWallIndex].mainIndex];
  const entryMainWall = wallBoundaryPoint(entryMainPoint, width, outerSide);
  const exitMainWall = wallBoundaryPoint(exitMainPoint, width, outerSide);

  const connectorPoint = (start, end, startTangent, endTangent, progress) => {
    const t = Math.max(0, Math.min(1, progress));
    const t2 = t * t;
    const t3 = t2 * t;
    const chordX = end.x - start.x;
    const chordY = end.y - start.y;
    const chordLength = Math.hypot(chordX, chordY) || 1;
    const chordNx = chordX / chordLength;
    const chordNy = chordY / chordLength;
    const safeTangent = (tangent) => {
      let tx = Number(tangent?.tx) || chordNx;
      let ty = Number(tangent?.ty) || chordNy;
      const magnitude = Math.hypot(tx, ty) || 1;
      tx /= magnitude;
      ty /= magnitude;
      // A tangent pointing backwards creates a loop. Blend it toward the
      // connector chord while preserving as much route direction as possible.
      const alignment = tx * chordNx + ty * chordNy;
      if (alignment < 0.22) {
        tx = tx * 0.28 + chordNx * 0.72;
        ty = ty * 0.28 + chordNy * 0.72;
        const adjusted = Math.hypot(tx, ty) || 1;
        tx /= adjusted;
        ty /= adjusted;
      }
      return { x: tx * chordLength * 0.58, y: ty * chordLength * 0.58 };
    };
    const m0 = safeTangent(startTangent);
    const m1 = safeTangent(endTangent);
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return {
      x: h00 * start.x + h10 * m0.x + h01 * end.x + h11 * m1.x,
      y: h00 * start.y + h10 * m0.y + h01 * end.y + h11 * m1.y
    };
  };

  const entryConnectorEnd = rawOuterWalls[entryWallEnd];
  const exitConnectorStart = rawOuterWalls[exitWallStart];
  const mainMedianAlpha = new Map();

  for (let index = 0; index < samples.length; index += 1) {
    const point = samples[index];
    const main = trackSamples[point.mainIndex];
    const actualOffset = Math.abs(Number(point.offset) || 0);

    const mainGrass = outerSide > 0
      ? Number(main.grassWidthLeft ?? main.grassWidth ?? 0)
      : Number(main.grassWidthRight ?? main.grassWidth ?? 0);
    const mainOuterDistance = width * 0.5 + Math.max(0, mainGrass);
    const pitOuterDistance = actualOffset + pitWidth * 0.5;

    // Drive the hand-off from the C2-continuous branch separation itself. A
    // geometric threshold made the alpha jump from zero to almost opaque in one
    // sample on narrow roads, creating a visible double rail and a hooked end.
    let wallHandoff = 1;
    let outerWall = rawOuterWalls[index];
    if (index <= entryWallEnd) {
      const progress = index / Math.max(1, entryWallEnd);
      outerWall = connectorPoint(entryMainWall, entryConnectorEnd, entryMainPoint, samples[entryWallEnd], progress);
      wallHandoff = smootherstep(progress / 0.06);
    } else if (index >= exitWallStart) {
      const progress = (index - exitWallStart) / Math.max(1, lastWallIndex - exitWallStart);
      outerWall = connectorPoint(exitConnectorStart, exitMainWall, samples[exitWallStart], exitMainPoint, progress);
      wallHandoff = smootherstep((1 - progress) / 0.06);
    }
    const medianClearance = actualOffset - (width + pitWidth) * 0.5;
    const medianWindow = smootherstep((point.u - entryRampEnd) / 0.08)
      * smootherstep((exitRampStart - point.u) / 0.08);
    const innerBlend = smootherstep(medianClearance / Math.max(1, pitWidth * 0.16))
      * smootherstep((point.separation - 0.24) / 0.48)
      * medianWindow;

    // Each merge is a tangent-matched connector. The main perimeter hands off
    // while both rails still occupy the same curve; after that only the pit rail
    // exists. There is no translucent pair of walls crossing through itself.
    point[outerXKey] = outerWall.x;
    point[outerYKey] = outerWall.y;
    point[outerAlphaKey] = wallHandoff;
    point[innerAlphaKey] = innerBlend;

    // The visual/physical runoff between the still-overlapping ribbons belongs
    // to the circuit. Once the car has committed to the branch both sides of
    // the pit are hard-walled at the asphalt edge.
    const remainingRunoff = Math.max(0, mainOuterDistance - pitOuterDistance) * (1 - wallHandoff);
    point.grassWidthLeft = outerSide > 0 ? remainingRunoff : 0;
    point.grassWidthRight = outerSide < 0 ? remainingRunoff : 0;
    point.grassWidth = remainingRunoff * 0.5;

    // The finish straight keeps its own wall once a genuine grass median exists.
    // Only the two merge throats remain open. Previously the main wall was handed
    // off to the *outer* pit wall for the entire branch, leaving the circuit side
    // visibly unprotected even though the pit lane had both of its rails.
    const previousMedianAlpha = Number(mainMedianAlpha.get(point.mainIndex) ?? 0);
    mainMedianAlpha.set(point.mainIndex, Math.max(previousMedianAlpha, innerBlend));
  }

  for (const [mainIndex, alpha] of mainMedianAlpha) {
    const main = trackSamples[mainIndex];
    main[mainAlphaKey] = Math.max(0, Math.min(1, alpha));
  }

  // Connector splines and the independently smoothed pit walls can still cut
  // a corner between samples. Apply the same segment-level guarantee used by
  // the main circuit after the final hand-off coordinates are known.
  enforceWallSegmentClearance(samples, pitWidth, false);
  repairOpenWallIntersections(samples, pitWidth);
  enforceWallSegmentClearance(samples, pitWidth, false);

  return {
    samples,
    totalLength: correctedTotalLength,
    width: pitWidth,
    grassWidth: width,
    side,
    outerSide,
    innerSide,
    // Internal velocity units are displayed as km/h with a factor of 0.62 / 3.
    // 290 units therefore produce the requested 60 km/h pit-lane limit.
    speedLimit: 290,
    speedLimitDeceleration: 96,
    serviceHalfLength: 52,
    serviceStopSpeed: 12,
    entryIndex: Math.floor(samples.length * 0.20),
    entryTriggerStart,
    entryTriggerEnd,
    serviceStart,
    serviceEnd,
    serviceIndex,
    serviceStartProgress: samples[serviceStart].cumulative / Math.max(1, correctedTotalLength),
    serviceEndProgress: samples[serviceEnd].cumulative / Math.max(1, correctedTotalLength),
    exitMergeStart,
    exitIndex,
    startLineIndex,
    startLineProgress: samples[startLineIndex].cumulative / Math.max(1, correctedTotalLength),
    entryMainIndex: startIndex % count,
    exitMainIndex: endUnwrapped % count,
    entryMainProgress: trackSamples[startIndex % count].cumulative,
    exitMainProgress: trackSamples[endUnwrapped % count].cumulative,
    entryMainProgressNormalized: trackSamples[startIndex % count].cumulative / Math.max(1, trackTotalLength),
    exitMainProgressNormalized: trackSamples[endUnwrapped % count].cumulative / Math.max(1, trackTotalLength),
    placementScore
  };
}

function spatialSegmentsNear(spatialGrid, x, y, radius, fallbackCount) {
  if (!spatialGrid?.cells || !Number.isFinite(spatialGrid.cellSize)) {
    return Array.from({ length: fallbackCount }, (_, index) => index);
  }
  const cellSize = spatialGrid.cellSize;
  const minX = Math.floor((x - radius) / cellSize);
  const maxX = Math.floor((x + radius) / cellSize);
  const minY = Math.floor((y - radius) / cellSize);
  const maxY = Math.floor((y + radius) / cellSize);
  const indices = new Set();
  for (let cellX = minX; cellX <= maxX; cellX += 1) {
    for (let cellY = minY; cellY <= maxY; cellY += 1) {
      for (const index of spatialGrid.cells[`${cellX},${cellY}`] ?? []) indices.add(index);
    }
  }
  return indices;
}

export function pitLaneFitsCircuit(pit, trackSamples, trackTotalLength, trackWidth, spatialGrid = null) {
  if (!pit?.samples?.length) return false;
  const leftWall = pit.samples.map((point) => wallBoundaryPoint(point, pit.width, 1));
  const rightWall = pit.samples.map((point) => wallBoundaryPoint(point, pit.width, -1));
  if (openPolylineSelfIntersects(leftWall) || openPolylineSelfIntersects(rightWall)) return false;
  const requiredSeparation = (Math.max(0, Number(trackWidth) || 0) + Math.max(0, Number(pit.width) || 0)) * 0.5;
  const count = trackSamples.length;
  const localExclusion = 4;

  for (let pitIndex = 0; pitIndex < pit.samples.length; pitIndex += 1) {
    const point = pit.samples[pitIndex];
    const separation = Number(point.separation) || 0;
    if (separation < 0.82) continue;

    const unwrapped = Number(point.mainProgressUnwrapped);
    const normalized = Number.isFinite(unwrapped) ? ((unwrapped % 1) + 1) % 1 : 0;
    const main = pointAtDistance(trackSamples, normalized * trackTotalLength, trackTotalLength, true);
    const signedSeparation = ((point.x - main.x) * main.nx + (point.y - main.y) * main.ny) * Number(pit.side || 1);
    const expected = requiredSeparation + 10;
    if (!Number.isFinite(signedSeparation) || signedSeparation < expected) return false;

    if (separation < 0.88) continue;
    const searchRadius = requiredSeparation + 22;
    for (const segmentIndex of spatialSegmentsNear(spatialGrid, point.x, point.y, searchRadius, count)) {
      const delta = Math.abs(segmentIndex - Number(point.mainIndex || 0));
      const circular = Math.min(delta, count - delta);
      if (circular <= localExclusion) continue;
      const projected = projectSegment(trackSamples, segmentIndex, point.x, point.y, true);
      if (Math.sqrt(projected.distanceSquared) < searchRadius) return false;
    }
  }
  return true;
}

function resetPitWallAlphas(trackSamples) {
  for (const point of trackSamples ?? []) {
    point.wallLeftAlpha = 1;
    point.wallRightAlpha = 1;
  }
}

function findValidPitLane(trackSamples, trackTotalLength, trackWidth) {
  const spatialGrid = buildSpatialGrid(trackSamples, Math.max(220, trackWidth * 1.35), true);
  const { fullOffset } = pitLaneDimensions(trackWidth);
  const candidates = choosePitWindows(trackSamples, fullOffset);
  for (const placement of candidates.slice(0, 80)) {
    resetPitWallAlphas(trackSamples);
    const candidate = buildPitLane(trackSamples, trackTotalLength, trackWidth, placement);
    if (!pitLaneFitsCircuit(candidate, trackSamples, trackTotalLength, trackWidth, spatialGrid)) continue;
    return { pit: candidate, spatialGrid };
  }
  resetPitWallAlphas(trackSamples);
  return null;
}

function pointToSegmentDistanceSquared(point, start, end) {
  const sx = end.x - start.x;
  const sy = end.y - start.y;
  const lengthSquared = sx * sx + sy * sy;
  if (lengthSquared < 1e-9) {
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    return dx * dx + dy * dy;
  }
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * sx + (point.y - start.y) * sy) / lengthSquared));
  const dx = point.x - (start.x + sx * t);
  const dy = point.y - (start.y + sy * t);
  return dx * dx + dy * dy;
}

function segmentDistanceSquared(a, b, c, d) {
  if (segmentIntersection(a, b, c, d)) return 0;
  return Math.min(
    pointToSegmentDistanceSquared(a, c, d),
    pointToSegmentDistanceSquared(b, c, d),
    pointToSegmentDistanceSquared(c, a, b),
    pointToSegmentDistanceSquared(d, a, b)
  );
}

function applyWallSegmentSafetyMasks(trackSamples, trackTotalLength, trackWidth, pit) {
  if (!trackSamples?.length || !pit?.samples?.length) return;
  const pitSamples = pit.samples;
  const pitWidth = Math.max(0, Number(pit.width) || 0);
  const wallStrokeHalf = 5.5;

  for (const point of [...trackSamples, ...pitSamples]) {
    point.wallLeftSegmentAlpha = 1;
    point.wallRightSegmentAlpha = 1;
  }

  const inspectRoute = ({ points, width, closed, otherPoints, otherWidth, otherClosed, candidate, otherSegments }) => {
    const segmentCount = closed ? points.length : Math.max(0, points.length - 1);
    const otherSegmentCount = otherClosed ? otherPoints.length : Math.max(0, otherPoints.length - 1);
    const minimumDistanceSquared = (otherWidth * 0.5 + wallStrokeHalf) ** 2;
    for (let index = 0; index < segmentCount; index += 1) {
      if (!candidate(index)) continue;
      const nextIndex = closed ? (index + 1) % points.length : index + 1;
      const startPoint = points[index];
      const endPoint = points[nextIndex];
      const nearby = otherSegments(index);
      if (!nearby.length) continue;
      for (const side of [1, -1]) {
        const { segmentKey } = wallSideKeys(side);
        const active = wallSegmentActiveRange(startPoint, endPoint, side, 0.025);
        if (!active) continue;
        const rawStart = wallBoundaryPoint(startPoint, width, side);
        const rawEnd = wallBoundaryPoint(endPoint, width, side);
        const wallStart = {
          x: rawStart.x + (rawEnd.x - rawStart.x) * active.startT,
          y: rawStart.y + (rawEnd.y - rawStart.y) * active.startT
        };
        const wallEnd = {
          x: rawStart.x + (rawEnd.x - rawStart.x) * active.endT,
          y: rawStart.y + (rawEnd.y - rawStart.y) * active.endT
        };
        let unsafe = false;
        for (const rawOtherIndex of nearby) {
          let otherIndex = rawOtherIndex;
          if (otherClosed) otherIndex = (otherIndex % otherPoints.length + otherPoints.length) % otherPoints.length;
          else if (otherIndex < 0 || otherIndex >= otherSegmentCount) continue;
          const otherNext = otherClosed ? (otherIndex + 1) % otherPoints.length : otherIndex + 1;
          if (segmentDistanceSquared(wallStart, wallEnd, otherPoints[otherIndex], otherPoints[otherNext])
            < minimumDistanceSquared) {
            unsafe = true;
            break;
          }
        }
        if (unsafe) startPoint[segmentKey] = 0;
      }
    }
  };

  const count = trackSamples.length;
  const pitMainIndices = new Set();
  for (const point of pitSamples) {
    const base = Number(point.mainIndex) || 0;
    for (let offset = -3; offset <= 3; offset += 1) pitMainIndices.add((base + offset + count) % count);
  }
  const mainToPitSegments = (mainIndex) => {
    const result = [];
    for (let pitIndex = 0; pitIndex < pitSamples.length - 1; pitIndex += 1) {
      const mappedA = Number(pitSamples[pitIndex].mainIndex) || 0;
      const mappedB = Number(pitSamples[pitIndex + 1].mainIndex) || mappedA;
      const distanceA = Math.min(Math.abs(mappedA - mainIndex), count - Math.abs(mappedA - mainIndex));
      const distanceB = Math.min(Math.abs(mappedB - mainIndex), count - Math.abs(mappedB - mainIndex));
      if (Math.min(distanceA, distanceB) <= 5) result.push(pitIndex);
    }
    return result;
  };

  inspectRoute({
    points: trackSamples,
    width: trackWidth,
    closed: true,
    otherPoints: pitSamples,
    otherWidth: pitWidth,
    otherClosed: false,
    candidate: (index) => pitMainIndices.has(index) || pitMainIndices.has((index + 1) % count),
    otherSegments: (index) => mainToPitSegments(index)
  });

  inspectRoute({
    points: pitSamples,
    width: pitWidth,
    closed: false,
    otherPoints: trackSamples,
    otherWidth: trackWidth,
    otherClosed: true,
    candidate: (index) => {
      const startSeparation = Number(pitSamples[index]?.separation) || 0;
      const endSeparation = Number(pitSamples[index + 1]?.separation) || 0;
      return Math.min(startSeparation, endSeparation) < 0.995;
    },
    otherSegments: (index) => {
      const mappedA = Number(pitSamples[index]?.mainIndex) || 0;
      const mappedB = Number(pitSamples[index + 1]?.mainIndex) || mappedA;
      const result = [];
      for (const mapped of [mappedA, mappedB]) {
        for (let offset = -6; offset <= 6; offset += 1) result.push(mapped + offset);
      }
      return [...new Set(result)];
    }
  });
}

function analyzeTrackLayout(samples, totalLength) {
  if (!samples?.length || totalLength <= 0) {
    return { straightRuns: [], longStraights: [], longestStraightRatio: 0, technicalRatio: 0 };
  }
  const straightFlags = samples.map((_, index) => curveScore(samples, index, 6) < 0.046);
  const technicalLength = samples.reduce((sum, point, index) => sum
    + (curveScore(samples, index, 5) > 0.085 ? Number(point.segmentLength) || 0 : 0), 0);
  const runs = [];
  let runStart = null;
  let runLength = 0;
  for (let index = 0; index < samples.length; index += 1) {
    if (straightFlags[index]) {
      if (runStart == null) runStart = index;
      runLength += Number(samples[index].segmentLength) || 0;
    } else if (runStart != null) {
      runs.push({ startIndex: runStart, endIndex: index - 1, length: runLength });
      runStart = null;
      runLength = 0;
    }
  }
  if (runStart != null) runs.push({ startIndex: runStart, endIndex: samples.length - 1, length: runLength });
  if (runs.length > 1 && straightFlags[0] && straightFlags.at(-1)) {
    const first = runs.shift();
    const last = runs.pop();
    runs.unshift({
      startIndex: last.startIndex,
      endIndex: first.endIndex,
      length: last.length + first.length,
      wraps: true
    });
  }
  runs.sort((a, b) => b.length - a.length);
  const longStraights = runs.filter((run) => run.length / totalLength >= 0.085).slice(0, 2);
  return {
    straightRuns: runs.slice(0, 6),
    longStraights,
    longestStraightRatio: (runs[0]?.length ?? 0) / totalLength,
    technicalRatio: technicalLength / totalLength
  };
}

const SCENERY_ARCHETYPES = Object.freeze({
  tree: { collisionRadius: 17, visualRadius: 42, placementRadius: 15 },
  pine: { collisionRadius: 16, visualRadius: 40, placementRadius: 14 },
  column: { collisionRadius: 13, visualRadius: 24, placementRadius: 12 },
  statue: { collisionRadius: 15, visualRadius: 28, placementRadius: 14 },
  boulder: { collisionRadius: 20, visualRadius: 30, placementRadius: 18 },
  house: { collisionRadius: 34, visualRadius: 64, width: 90, height: 68, placementRadius: 24 },
  barn: { collisionRadius: 36, visualRadius: 68, width: 98, height: 66, placementRadius: 25 },
  workshop: { collisionRadius: 39, visualRadius: 74, width: 110, height: 72, placementRadius: 27 },
  tank: { collisionRadius: 24, visualRadius: 34, placementRadius: 20 },
  tower: { collisionRadius: 27, visualRadius: 44, placementRadius: 21 },
  obelisk: { collisionRadius: 14, visualRadius: 26, placementRadius: 12 },
  grandstand: { collisionRadius: 43, visualRadius: 86, width: 158, height: 62, placementRadius: 28 },
  timingTower: { collisionRadius: 25, visualRadius: 44, width: 58, height: 78, placementRadius: 21 }
});

const SCENERY_SETS = Object.freeze({
  industrial: { label: "Промышленный пояс", density: 1.05, kinds: ["workshop", "tank", "column", "tower", "boulder", "workshop", "tank"] },
  woodland: { label: "Лесная трасса", density: 1.22, kinds: ["tree", "pine", "tree", "pine", "boulder", "barn", "tree"] },
  estate: { label: "Дворцовый парк", density: 0.96, kinds: ["column", "statue", "tree", "house", "obelisk", "column", "tree"] },
  ruins: { label: "Древние руины", density: 1.08, kinds: ["column", "obelisk", "boulder", "tower", "statue", "column", "boulder"] },
  tournament: { label: "Большой турнир", density: 0.88, kinds: ["grandstand", "timingTower", "workshop", "column", "grandstand", "tower"] }
});

function resolveSceneryTheme(seed, complexity, requestedTheme) {
  const requested = String(requestedTheme ?? "auto");
  if (SCENERY_SETS[requested]) return requested;
  const themes = complexity === 5
    ? ["tournament", "tournament", "industrial", "estate", "ruins"]
    : ["industrial", "woodland", "estate", "ruins"];
  const rng = seededRng(`${seed}:environment-theme:${complexity}`);
  return themes[Math.floor(rng() * themes.length) % themes.length];
}

function distanceToPolyline(points, x, y, closed = true) {
  if (!points?.length) return Infinity;
  const segmentCount = closed ? points.length : Math.max(0, points.length - 1);
  let best = Infinity;
  for (let index = 0; index < segmentCount; index += 1) {
    const nextIndex = closed ? (index + 1) % points.length : index + 1;
    best = Math.min(best, pointToSegmentDistanceSquared({ x, y }, points[index], points[nextIndex]));
  }
  return Math.sqrt(best);
}

function buildScenery(trackSamples, totalLength, trackWidth, pit, seed, complexity, requestedTheme) {
  const theme = resolveSceneryTheme(seed, complexity, requestedTheme);
  const set = SCENERY_SETS[theme];
  const rng = seededRng(`${seed}:scenery:${complexity}:${theme}`);
  const targetCount = Math.max(18, Math.min(62, Math.round(totalLength / 510 * set.density)));
  const obstacles = [];
  const maximumAttempts = targetCount * 34;

  for (let attempt = 0; attempt < maximumAttempts && obstacles.length < targetCount; attempt += 1) {
    const pointIndex = Math.floor(rng() * trackSamples.length) % trackSamples.length;
    const point = trackSamples[pointIndex];
    const side = rng() < 0.5 ? -1 : 1;
    const kind = set.kinds[Math.floor(rng() * set.kinds.length) % set.kinds.length];
    const archetype = SCENERY_ARCHETYPES[kind];
    const largeFeature = kind === "house" || kind === "workshop" || kind === "barn" || kind === "grandstand" || kind === "timingTower";
    const scale = largeFeature ? 0.96 + rng() * 0.56 : 0.90 + rng() * 0.48;
    const collisionRadius = archetype.collisionRadius * scale;
    const visualRadius = archetype.visualRadius * scale;
    const placementRadius = Math.max(8, Number(archetype.placementRadius ?? archetype.collisionRadius * 0.72)) * scale;
    const grassWidth = grassWidthForSide(point, side);
    const roadMargin = Math.max(10, placementRadius * 0.28);
    const wallMargin = Math.max(4, visualRadius * 0.04);
    const freeWidth = grassWidth - roadMargin - placementRadius * 2;
    if (freeWidth < -visualRadius * 0.38) continue;

    const offset = trackWidth * 0.5 + roadMargin + placementRadius + Math.max(0, freeWidth) * rng();
    const along = (rng() - 0.5) * Math.min(58, Number(point.segmentLength || 0) * 0.8 + 16);
    const x = point.x + point.nx * offset * side + point.tx * along;
    const y = point.y + point.ny * offset * side + point.ty * along;

    // A candidate may be on the intended verge but still overlap another remote
    // section of a folded circuit or the separately generated pit lane.
    const mainDistance = distanceToPolyline(trackSamples, x, y, true);
    if (mainDistance < trackWidth * 0.5 + collisionRadius + MAIN_TRACK_SCENERY_CLEARANCE) continue;
    if (pit?.samples?.length) {
      const pitDistance = distanceToPolyline(pit.samples, x, y, false);
      if (pitDistance < pit.width * 0.5 + collisionRadius + SCENERY_CLEARANCE) continue;
    }
    if (obstacles.some((other) => Math.hypot(other.x - x, other.y - y)
      < other.collisionRadius + collisionRadius + Math.max(SCENERY_CLEARANCE, Math.min(32, visualRadius * 0.35)))) continue;

    const angle = Math.atan2(point.ty, point.tx) + (rng() - 0.5) * (kind === "house" || kind === "workshop" || kind === "barn" || kind === "grandstand" ? 0.42 : Math.PI);
    obstacles.push({
      id: `${theme}-${obstacles.length}`,
      kind,
      theme,
      x,
      y,
      angle,
      scale,
      collisionRadius,
      visualRadius,
      width: Number(archetype.width ?? visualRadius * 1.5) * scale,
      height: Number(archetype.height ?? visualRadius * 1.5) * scale,
      solid: true,
      drawLayer: 2
    });
  }

  return {
    theme,
    label: set.label,
    obstacles
  };
}

export function generateTrack(seed, complexity = 2, environmentTheme = "auto") {
  const safeComplexity = Math.max(1, Math.min(5, Number(complexity) || 2));
  const width = safeComplexity === 5 ? 195 : 230 - safeComplexity * 10;
  const resolvedEnvironmentTheme = resolveSceneryTheme(seed, safeComplexity, environmentTheme);
  let controls = null;
  let samples = null;
  let totalLength = 0;
  let tournamentLayout = null;
  let pit = null;
  let spatialGrid = null;
  let usedAttempt = 0;

  const prepareCandidate = (candidateControls, candidateSamples, { requireTournamentProfile = true } = {}) => {
    if (!candidateSamples?.length || polylineSelfIntersects(candidateSamples)) return null;
    const rotated = rotateToBestStart(candidateSamples);
    let length = 0;
    for (let geometryPass = 0; geometryPass < 9; geometryPass += 1) {
      if (polylineSelfIntersects(rotated)) return null;
      length = finalizeClosedSamples(rotated);
      assignTrackRunoffProfile(rotated, length, width, seed, resolvedEnvironmentTheme);
      assignWallCoordinates(rotated, width, true);
      smoothWallCoordinates(rotated, 1, true);
      constrainWallCoordinates(rotated, width);
      enforceWallSegmentClearance(rotated, width, true);
      const left = rotated.map((point) => wallBoundaryPoint(point, width, 1));
      const right = rotated.map((point) => wallBoundaryPoint(point, width, -1));
      const leftIntersection = findPolylineIntersection(left);
      const rightIntersection = findPolylineIntersection(right);
      const worstTurn = Math.max(maximumPolylineTurn(left), maximumPolylineTurn(right));
      if (!leftIntersection && !rightIntersection && worstTurn < 2.45) {
        const layout = analyzeTrackLayout(rotated, length);
        if (requireTournamentProfile && safeComplexity === 5
          && (layout.longestStraightRatio < 0.105 || layout.technicalRatio < 0.28)) return null;
        const pitPlacement = findValidPitLane(rotated, length, width);
        if (!pitPlacement) return null;
        return {
          controls: candidateControls,
          samples: rotated,
          totalLength: length,
          tournamentLayout: layout,
          ...pitPlacement
        };
      }
      const problems = [leftIntersection, rightIntersection].filter(Boolean);
      if (!problems.length) return null;
      for (const problem of problems) {
        const span = ((problem.j - problem.i) % rotated.length + rotated.length) % rotated.length;
        if (span > 28) return null;
        relaxClosedWindow(rotated, problem.i, problem.j, 7, 0.62);
      }
    }
    return null;
  };

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const irregularity = Math.max(safeComplexity >= 4 ? 0.42 : 0.30, 1 - attempt * 0.085);
    const rng = seededRng(`${seed}:${safeComplexity}:${attempt}`);
    const smoothingPasses = safeComplexity === 1 ? 2 : safeComplexity === 2 ? 1 : 0;
    let candidateControls;
    let candidateSamples;
    if (safeComplexity === 4) {
      candidateSamples = makeExtremeProfileSamples(rng, irregularity);
      candidateControls = candidateSamples.filter((_, index) => index % 20 === 0).map((point) => ({ ...point }));
    } else if (safeComplexity === 5) {
      candidateControls = smoothControlLoop(makeTournamentControlPoints(rng, irregularity), 1);
      candidateSamples = sampleSpline(candidateControls, safeComplexity);
    } else {
      candidateControls = smoothControlLoop(makeControlPoints(rng, safeComplexity, irregularity), smoothingPasses);
      candidateSamples = sampleSpline(candidateControls, safeComplexity);
    }
    const prepared = prepareCandidate(candidateControls, candidateSamples);
    if (!prepared) continue;
    ({ controls, samples, totalLength, tournamentLayout, pit, spatialGrid } = prepared);
    usedAttempt = attempt;
    break;
  }

  if (!samples) {
    let fallbackControls;
    if (safeComplexity === 5) {
      fallbackControls = smoothControlLoop(makeTournamentControlPoints(seededRng(`${seed}:tournament-fallback`), 0.36), 1);
    } else {
      const count = 10 + safeComplexity * 2;
      fallbackControls = Array.from({ length: count }, (_, index) => {
        const angle = (index / count) * Math.PI * 2;
        const radialWave = safeComplexity >= 4 ? 125 : 35;
        const radius = (820 + safeComplexity * 45 + Math.sin(angle * (2 + safeComplexity)) * radialWave) * TRACK_LENGTH_SCALE;
        return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * (safeComplexity >= 4 ? 0.74 : 0.83) };
      });
      fallbackControls = smoothControlLoop(fallbackControls, safeComplexity <= 2 ? 2 : 0);
    }

    const prepared = prepareCandidate(fallbackControls, sampleSpline(fallbackControls, safeComplexity));
    if (prepared) {
      ({ controls, samples, totalLength, tournamentLayout, pit, spatialGrid } = prepared);
      usedAttempt = 99;
    } else {
      const emergencyAttempts = safeComplexity === 5 ? 24 : 4;
      for (let emergencyAttempt = 0; emergencyAttempt < emergencyAttempts && !samples; emergencyAttempt += 1) {
        let emergencyControls;
        let emergencySamples;
        if (safeComplexity === 5) {
          const irregularity = Math.max(0.30, 0.42 - emergencyAttempt * 0.004);
          emergencyControls = smoothControlLoop(
            makeTournamentControlPoints(seededRng(`${seed}:tournament-emergency:${emergencyAttempt}`), irregularity),
            1
          );
          emergencySamples = sampleSpline(emergencyControls, safeComplexity);
        } else {
          const count = 12 + safeComplexity;
          const radius = (940 + safeComplexity * 45 + emergencyAttempt * 120) * TRACK_LENGTH_SCALE;
          const yScale = 0.82 - emergencyAttempt * 0.025;
          emergencyControls = Array.from({ length: count }, (_, index) => {
            const angle = index / count * Math.PI * 2;
            return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * yScale };
          });
          emergencySamples = sampleSpline(emergencyControls, safeComplexity >= 4 ? 3 : safeComplexity);
        }
        const emergency = prepareCandidate(emergencyControls, emergencySamples);
        if (!emergency) continue;
        ({ controls, samples, totalLength, tournamentLayout, pit, spatialGrid } = emergency);
        usedAttempt = 100 + emergencyAttempt;
      }
      if (!samples || !pit || !spatialGrid) throw new Error(`Unable to generate a valid circuit and pit lane for seed ${seed}`);
    }
  }

  const sectorCount = 12;
  const sectors = Array.from({ length: sectorCount }, (_, index) => {
    const sampleIndex = Math.floor(index * samples.length / sectorCount) % samples.length;
    return { index, sampleIndex, progress: samples[sampleIndex].cumulative / totalLength };
  });
  applyWallSegmentSafetyMasks(samples, totalLength, width, pit);
  const scenery = buildScenery(samples, totalLength, width, pit, seed, safeComplexity, resolvedEnvironmentTheme);
  pit.spatialGrid = buildSpatialGrid(pit.samples, Math.max(180, pit.width * 1.75), false);
  const start = samples[0];
  const sceneryBounds = scenery.obstacles.flatMap((obstacle) => [
    { x: obstacle.x - obstacle.visualRadius, y: obstacle.y - obstacle.visualRadius },
    { x: obstacle.x + obstacle.visualRadius, y: obstacle.y + obstacle.visualRadius }
  ]);
  const allBounds = [...samples, ...pit.samples, ...sceneryBounds];
  return {
    seed,
    complexity: safeComplexity,
    trackProfile: safeComplexity === 5 ? "tournament" : "standard",
    tournamentLayout: safeComplexity === 5 ? (tournamentLayout ?? analyzeTrackLayout(samples, totalLength)) : null,
    environmentTheme: scenery.theme,
    environmentLabel: scenery.label,
    scenery: scenery.obstacles,
    generationAttempt: usedAttempt,
    controls,
    samples,
    spatialGrid,
    sectors,
    pit,
    width,
    grassWidth: width,
    totalLength,
    start,
    bounds: allBounds.reduce((bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      maxX: Math.max(bounds.maxX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxY: Math.max(bounds.maxY, point.y)
    }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })
  };
}

export function grassWidthForSide(point, side) {
  if (side >= 0) return Math.max(0, Number(point?.grassWidthLeft ?? point?.grassWidth ?? 0));
  return Math.max(0, Number(point?.grassWidthRight ?? point?.grassWidth ?? 0));
}

export function runoffSurfaceForSide(point, side) {
  const value = side >= 0 ? point?.surfaceLeft : point?.surfaceRight;
  return RUNOFF_SURFACES.includes(value) ? value : "grass";
}

export function boundaryPoint(point, roadWidth, side) {
  const direction = side >= 0 ? 1 : -1;
  const distance = Math.max(0, Number(roadWidth) || 0) * 0.5 + grassWidthForSide(point, direction);
  return {
    x: Number(point?.x) + Number(point?.nx) * distance * direction,
    y: Number(point?.y) + Number(point?.ny) * distance * direction
  };
}

export function wallBoundaryPoint(point, roadWidth, side) {
  const direction = side >= 0 ? 1 : -1;
  const xKey = direction > 0 ? "wallLeftX" : "wallRightX";
  const yKey = direction > 0 ? "wallLeftY" : "wallRightY";
  const customX = Number(point?.[xKey]);
  const customY = Number(point?.[yKey]);
  if (Number.isFinite(customX) && Number.isFinite(customY)) return { x: customX, y: customY };
  return boundaryPoint(point, roadWidth, direction);
}

/**
 * Returns the visible/collidable part of a wall segment after endpoint fades
 * and the generation-time safety mask have been applied. Keeping this logic in
 * one place prevents the renderer and collision solver from disagreeing about
 * where a fading merge wall actually starts and ends.
 */
export function wallSegmentActiveRange(startPoint, endPoint, side, threshold = WALL_COLLISION_ALPHA) {
  if (!startPoint || !endPoint) return null;
  const { alphaKey, segmentKey } = wallSideKeys(side);
  const segmentAlpha = clamp01(startPoint[segmentKey] ?? 1);
  if (segmentAlpha <= 0) return null;
  const alphaStart = clamp01(startPoint[alphaKey] ?? 1) * segmentAlpha;
  const alphaEnd = clamp01(endPoint[alphaKey] ?? 1) * segmentAlpha;
  const safeThreshold = Math.max(0, Math.min(0.999, Number(threshold) || 0));
  if (Math.max(alphaStart, alphaEnd) < safeThreshold) return null;

  let startT = 0;
  let endT = 1;
  const delta = alphaEnd - alphaStart;
  if (alphaStart < safeThreshold && delta > 1e-9) {
    startT = Math.max(0, Math.min(1, (safeThreshold - alphaStart) / delta));
  }
  if (alphaEnd < safeThreshold && delta < -1e-9) {
    endT = Math.max(0, Math.min(1, (safeThreshold - alphaStart) / delta));
  }
  if (endT - startT < 1e-5) return null;

  const alphaAt = (t) => alphaStart + delta * t;
  return {
    startT,
    endT,
    startAlpha: clamp01(alphaAt(startT)),
    endAlpha: clamp01(alphaAt(endT)),
    averageAlpha: clamp01((alphaAt(startT) + alphaAt(endT)) * 0.5)
  };
}

function projectSegment(points, index, x, y, closed = true) {
  const point = points[index];
  const nextIndex = closed ? (index + 1) % points.length : Math.min(points.length - 1, index + 1);
  const next = points[nextIndex];
  const sx = next.x - point.x;
  const sy = next.y - point.y;
  const lengthSquared = sx * sx + sy * sy || 1;
  const t = Math.max(0, Math.min(1, ((x - point.x) * sx + (y - point.y) * sy) / lengthSquared));
  const px = point.x + sx * t;
  const py = point.y + sy * t;
  const dx = x - px;
  const dy = y - py;
  const segmentLength = Math.sqrt(lengthSquared);
  const tx = sx / segmentLength;
  const ty = sy / segmentLength;
  const nx = -ty;
  const ny = tx;
  const cumulative = point.cumulative + segmentLength * t;
  const interpolate = (key, fallback = 0) => {
    const start = Number(point[key] ?? fallback);
    const end = Number(next[key] ?? point[key] ?? fallback);
    return start + (end - start) * t;
  };
  const grassWidthLeft = interpolate("grassWidthLeft", point.grassWidth ?? 0);
  const grassWidthRight = interpolate("grassWidthRight", point.grassWidth ?? 0);
  const grassWidth = (grassWidthLeft + grassWidthRight) * 0.5;
  const wallLeftAlpha = interpolate("wallLeftAlpha", 1);
  const wallRightAlpha = interpolate("wallRightAlpha", 1);
  const wallPointOnNormal = (side) => {
    const xKey = side > 0 ? "wallLeftX" : "wallRightX";
    const yKey = side > 0 ? "wallLeftY" : "wallRightY";
    const startX = Number(point[xKey]);
    const startY = Number(point[yKey]);
    const endX = Number(next[xKey]);
    const endY = Number(next[yKey]);
    const fallbackDistance = side > 0
      ? grassWidthLeft
      : grassWidthRight;
    if (![startX, startY, endX, endY].every(Number.isFinite)) {
      return { x: px + nx * fallbackDistance * side, y: py + ny * fallbackDistance * side };
    }

    const wallDx = endX - startX;
    const wallDy = endY - startY;
    const denominator = nx * wallDy - ny * wallDx;
    if (Math.abs(denominator) > 1e-7) {
      const ax = startX - px;
      const ay = startY - py;
      const distance = (ax * wallDy - ay * wallDx) / denominator;
      const wallT = (ax * ny - ay * nx) / denominator;
      if (Number.isFinite(distance) && Number.isFinite(wallT)
        && wallT >= -0.025 && wallT <= 1.025 && distance * side >= 0) {
        return { x: px + nx * distance, y: py + ny * distance };
      }
    }

    // Degenerate connector or an intersection just outside the segment. The
    // same-parameter point remains on the actually rendered wall segment and is
    // safer than falling back to a separately reconstructed grass boundary.
    return {
      x: startX + wallDx * t,
      y: startY + wallDy * t
    };
  };
  const wallLeft = wallPointOnNormal(1);
  const wallRight = wallPointOnNormal(-1);
  const wallLeftX = wallLeft.x;
  const wallLeftY = wallLeft.y;
  const wallRightX = wallRight.x;
  const wallRightY = wallRight.y;
  const mainProgressUnwrapped = Number.isFinite(point.mainProgressUnwrapped)
    ? point.mainProgressUnwrapped + (Number(next.mainProgressUnwrapped ?? point.mainProgressUnwrapped) - point.mainProgressUnwrapped) * t
    : null;
  const surfaceSource = t < 0.5 ? point : next;
  const surfaceLeft = RUNOFF_SURFACES.includes(surfaceSource.surfaceLeft) ? surfaceSource.surfaceLeft : "grass";
  const surfaceRight = RUNOFF_SURFACES.includes(surfaceSource.surfaceRight) ? surfaceSource.surfaceRight : "grass";
  return {
    point: { x: px, y: py, tx, ty, nx, ny, cumulative, grassWidth, grassWidthLeft, grassWidthRight, surfaceLeft, surfaceRight, wallLeftAlpha, wallRightAlpha, wallLeftX, wallLeftY, wallRightX, wallRightY, mainProgressUnwrapped },
    index,
    distanceSquared: dx * dx + dy * dy,
    signedDistance: dx * nx + dy * ny,
    cumulative
  };
}

function nearestOnPolyline(points, totalLength, x, y, hintIndex = null, closed = true, widthHint = 200, spatialGrid = null) {
  let best = null;
  const maxIndex = closed ? points.length : points.length - 1;
  const consider = (index) => {
    if (!closed && (index < 0 || index >= points.length - 1)) return;
    const normalized = closed ? (index % points.length + points.length) % points.length : index;
    const candidate = projectSegment(points, normalized, x, y, closed);
    if (!best || candidate.distanceSquared < best.distanceSquared) best = candidate;
  };

  if (Number.isInteger(hintIndex)) {
    const range = 54;
    for (let offset = -range; offset <= range; offset += 1) consider(hintIndex + offset);
    if (best && best.distanceSquared < widthHint * widthHint * 3) {
      return {
        ...best,
        distance: Math.sqrt(best.distanceSquared),
        progress: Math.max(0, Math.min(1, best.cumulative / Math.max(1, totalLength)))
      };
    }
  }

  best = null;
  if (spatialGrid?.cells && Number.isFinite(spatialGrid.cellSize)) {
    const cellSize = spatialGrid.cellSize;
    const cellX = Math.floor(x / cellSize);
    const cellY = Math.floor(y / cellSize);
    const considered = new Set();
    for (let radius = 0; radius <= 8; radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dy = -radius; dy <= radius; dy += 1) {
          if (radius > 0 && Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          for (const index of spatialGrid.cells[`${cellX + dx},${cellY + dy}`] ?? []) {
            if (considered.has(index)) continue;
            considered.add(index);
            consider(index);
          }
        }
      }
      if (!best) continue;
      const minX = (cellX - radius) * cellSize;
      const maxX = (cellX + radius + 1) * cellSize;
      const minY = (cellY - radius) * cellSize;
      const maxY = (cellY + radius + 1) * cellSize;
      const boundaryDistance = Math.max(0, Math.min(x - minX, maxX - x, y - minY, maxY - y));
      if (best.distanceSquared <= boundaryDistance * boundaryDistance) {
        return {
          ...best,
          distance: Math.sqrt(best.distanceSquared),
          progress: closed
            ? (best.cumulative % totalLength) / totalLength
            : Math.max(0, Math.min(1, best.cumulative / Math.max(1, totalLength)))
        };
      }
    }
  }
  best = null;
  for (let index = 0; index < maxIndex; index += 1) consider(index);
  return {
    ...best,
    distance: Math.sqrt(best.distanceSquared),
    progress: closed
      ? (best.cumulative % totalLength) / totalLength
      : Math.max(0, Math.min(1, best.cumulative / Math.max(1, totalLength)))
  };
}

export function nearestTrackPoint(track, x, y, hintIndex = null) {
  return nearestOnPolyline(track.samples, track.totalLength, x, y, hintIndex, true, track.width, track.spatialGrid);
}

export function nearestPitPoint(track, x, y, hintIndex = null) {
  return nearestOnPolyline(track.pit.samples, track.pit.totalLength, x, y, hintIndex, false, track.pit.width, track.pit.spatialGrid);
}

export function sampleTrack(track, index) {
  const length = track.samples.length;
  return track.samples[(Math.round(index) % length + length) % length];
}

export function samplePit(track, index) {
  const length = track.pit.samples.length;
  return track.pit.samples[Math.max(0, Math.min(length - 1, Math.round(index)))];
}

function pointAtDistance(samples, targetDistance, totalLength, closed) {
  if (!samples?.length) return { x: 0, y: 0, tx: 1, ty: 0, nx: 0, ny: 1 };
  const maximum = Math.max(0, Number(totalLength) || 0);
  let distance = Number(targetDistance) || 0;
  if (closed && maximum > 0) distance = ((distance % maximum) + maximum) % maximum;
  else distance = Math.max(0, Math.min(maximum, distance));

  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) * 0.5);
    if ((samples[middle].cumulative ?? 0) <= distance) low = middle;
    else high = middle - 1;
  }
  const point = samples[low];
  const nextIndex = closed ? (low + 1) % samples.length : Math.min(samples.length - 1, low + 1);
  const next = samples[nextIndex];
  const segmentLength = Math.max(0.0001, Number(point.segmentLength) || Math.hypot(next.x - point.x, next.y - point.y) || 1);
  const t = Math.max(0, Math.min(1, (distance - (point.cumulative ?? 0)) / segmentLength));
  const tx = point.tx + (next.tx - point.tx) * t;
  const ty = point.ty + (next.ty - point.ty) * t;
  const magnitude = Math.hypot(tx, ty) || 1;
  const startGrassLeft = Number(point.grassWidthLeft ?? point.grassWidth ?? 0);
  const endGrassLeft = Number(next.grassWidthLeft ?? next.grassWidth ?? startGrassLeft);
  const startGrassRight = Number(point.grassWidthRight ?? point.grassWidth ?? 0);
  const endGrassRight = Number(next.grassWidthRight ?? next.grassWidth ?? startGrassRight);
  const grassWidthLeft = startGrassLeft + (endGrassLeft - startGrassLeft) * t;
  const grassWidthRight = startGrassRight + (endGrassRight - startGrassRight) * t;
  return {
    x: point.x + (next.x - point.x) * t,
    y: point.y + (next.y - point.y) * t,
    tx: tx / magnitude,
    ty: ty / magnitude,
    nx: -(ty / magnitude),
    ny: tx / magnitude,
    grassWidthLeft,
    grassWidthRight,
    grassWidth: (grassWidthLeft + grassWidthRight) * 0.5,
    surfaceLeft: runoffSurfaceForSide(t < 0.5 ? point : next, 1),
    surfaceRight: runoffSurfaceForSide(t < 0.5 ? point : next, -1),
    wallLeftX: Number(point.wallLeftX ?? point.x) + (Number(next.wallLeftX ?? next.x ?? point.wallLeftX ?? point.x) - Number(point.wallLeftX ?? point.x)) * t,
    wallLeftY: Number(point.wallLeftY ?? point.y) + (Number(next.wallLeftY ?? next.y ?? point.wallLeftY ?? point.y) - Number(point.wallLeftY ?? point.y)) * t,
    wallRightX: Number(point.wallRightX ?? point.x) + (Number(next.wallRightX ?? next.x ?? point.wallRightX ?? point.x) - Number(point.wallRightX ?? point.x)) * t,
    wallRightY: Number(point.wallRightY ?? point.y) + (Number(next.wallRightY ?? next.y ?? point.wallRightY ?? point.y) - Number(point.wallRightY ?? point.y)) * t,
    wallLeftAlpha: Number(point.wallLeftAlpha ?? 1) + (Number(next.wallLeftAlpha ?? point.wallLeftAlpha ?? 1) - Number(point.wallLeftAlpha ?? 1)) * t,
    wallRightAlpha: Number(point.wallRightAlpha ?? 1) + (Number(next.wallRightAlpha ?? point.wallRightAlpha ?? 1) - Number(point.wallRightAlpha ?? 1)) * t,
    mainProgressUnwrapped: Number.isFinite(point.mainProgressUnwrapped)
      ? point.mainProgressUnwrapped + (Number(next.mainProgressUnwrapped ?? point.mainProgressUnwrapped) - point.mainProgressUnwrapped) * t
      : null,
    index: low
  };
}

export function pointAtTrackProgress(track, progress) {
  const normalized = ((Number(progress) || 0) % 1 + 1) % 1;
  return pointAtDistance(track.samples, normalized * track.totalLength, track.totalLength, true);
}

export function pointAtPitProgress(track, progress) {
  const normalized = Math.max(0, Math.min(1, Number(progress) || 0));
  return pointAtDistance(track.pit.samples, normalized * track.pit.totalLength, track.pit.totalLength, false);
}

export function sampleTrackAhead(track, startIndex, distance) {
  const index = (Math.round(startIndex) % track.samples.length + track.samples.length) % track.samples.length;
  const startDistance = Number(track.samples[index]?.cumulative) || 0;
  return pointAtDistance(track.samples, startDistance + Math.max(0, Number(distance) || 0), track.totalLength, true);
}

export function samplePitAhead(track, startIndex, distance) {
  const index = Math.max(0, Math.min(track.pit.samples.length - 1, Math.round(startIndex)));
  const startDistance = Number(track.pit.samples[index]?.cumulative) || 0;
  return pointAtDistance(track.pit.samples, startDistance + Math.max(0, Number(distance) || 0), track.pit.totalLength, false);
}
