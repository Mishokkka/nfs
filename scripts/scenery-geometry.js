const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const local = (point, box) => {
  const c = Math.cos(box.angle || 0), s = Math.sin(box.angle || 0);
  const x = point.x - box.x, y = point.y - box.y;
  return { x: x * c + y * s, y: -x * s + y * c };
};
const corners = box => {
  const x = box.width / 2, y = box.height / 2;
  return [{ x: -x, y: -y }, { x, y: -y }, { x, y }, { x: -x, y }];
};
function project(point, a, b) {
  const x = b.x - a.x, y = b.y - a.y;
  const t = clamp(((point.x - a.x) * x + (point.y - a.y) * y) / Math.max(1e-12, x * x + y * y), 0, 1);
  return { x: a.x + x * t, y: a.y + y * t };
}
function segmentBox(a, b, box) {
  const halfX = box.width / 2, halfY = box.height / 2;
  let enter = 0, exit = 1;
  for (const [key, half] of [["x", halfX], ["y", halfY]]) {
    const delta = b[key] - a[key];
    if (Math.abs(delta) < 1e-10) { if (Math.abs(a[key]) > half) return null; }
    else {
      const p = (-half - a[key]) / delta, q = (half - a[key]) / delta;
      enter = Math.max(enter, Math.min(p, q)); exit = Math.min(exit, Math.max(p, q));
      if (enter > exit) return null;
    }
  }
  return { enter, exit };
}
function nearestBoxSegment(a, b, box) {
  if (segmentBox(a, b, box)) return { distanceSquared: 0 };
  let best = { distanceSquared: Infinity };
  const points = corners(box);
  const consider = (axis, edge) => {
    const distanceSquared = (axis.x - edge.x) ** 2 + (axis.y - edge.y) ** 2;
    if (distanceSquared < best.distanceSquared) best = { distanceSquared, axis, edge };
  };
  for (let i = 0; i < 4; i++) {
    const p = points[i], q = points[(i + 1) % 4];
    consider(a, project(a, p, q)); consider(b, project(b, p, q));
    consider(project(p, a, b), p); consider(project(q, a, b), q);
  }
  return best;
}

/** Minimum distance from the complete solid footprint to a road centreline.
 * Building dimensions, placement validation and contacts use the same box. */
export function sceneryRoadDistance(obstacle, points, closed = true) {
  let distanceSquared = Infinity;
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (obstacle.collisionShape === "box") {
      distanceSquared = Math.min(distanceSquared, nearestBoxSegment(local(a, obstacle), local(b, obstacle), obstacle).distanceSquared);
    } else {
      const nearest = project(obstacle, a, b);
      distanceSquared = Math.min(distanceSquared, (nearest.x - obstacle.x) ** 2 + (nearest.y - obstacle.y) ** 2);
    }
  }
  return Math.max(0, Math.sqrt(distanceSquared) - (obstacle.collisionShape === "box" ? 0 : obstacle.collisionRadius));
}

/** Conservative foundation-to-asphalt clearance on a variable-width ribbon.
 * The wider endpoint bounds the linear taper over each segment. */
export function sceneryRoadClearance(obstacle, points, width, closed = true) {
  let clearance = Infinity;
  const count = closed ? points.length : points.length - 1;
  for (let i=0;i<count;i++) {
    const a=points[i],b=points[(i+1)%points.length];
    const distance = obstacle.collisionShape === "box"
      ? Math.sqrt(nearestBoxSegment(local(a,obstacle),local(b,obstacle),obstacle).distanceSquared)
      : Math.hypot(project(obstacle,a,b).x-obstacle.x,project(obstacle,a,b).y-obstacle.y)-obstacle.collisionRadius;
    clearance=Math.min(clearance,distance-Math.max(Number(a.roadWidth)||width,Number(b.roadWidth)||width)/2);
  }
  return clearance;
}

/** Return a world-space capsule/solid contact, using a circle only for round
 * objects. The enclosing radius is a broad phase, never the building's wall. */
export function sceneryContact(capsule, obstacle, car) {
  const radius = Math.max(4, Number(obstacle.collisionRadius) || 12);
  if ((car.x - obstacle.x) ** 2 + (car.y - obstacle.y) ** 2 > (radius + capsule.halfLength) ** 2) return null;
  if (obstacle.collisionShape !== "box") {
    const nearest = project(obstacle, capsule.start, capsule.end);
    let nx = nearest.x - obstacle.x, ny = nearest.y - obstacle.y;
    const distance = Math.hypot(nx, ny);
    if (distance >= capsule.halfWidth + radius) return null;
    if (distance > 1e-6) { nx /= distance; ny /= distance; }
    else {
      const speed = Math.hypot(car.vx, car.vy);
      nx = speed > .1 ? -car.vx / speed : Math.cos(car.angle + Math.PI / 2);
      ny = speed > .1 ? -car.vy / speed : Math.sin(car.angle + Math.PI / 2);
    }
    return { nx, ny, penetration: capsule.halfWidth + radius - distance,
      contactX: obstacle.x + nx * radius, contactY: obstacle.y + ny * radius };
  }
  const a = local(capsule.start, obstacle), b = local(capsule.end, obstacle);
  const closest = nearestBoxSegment(a, b, obstacle);
  if (closest.distanceSquared >= capsule.halfWidth ** 2) return null;
  const halfX = obstacle.width / 2, halfY = obstacle.height / 2;
  let nx, ny, penetration, point;
  if (closest.distanceSquared > 1e-12) {
    const distance = Math.sqrt(closest.distanceSquared);
    nx = (closest.axis.x - closest.edge.x) / distance; ny = (closest.axis.y - closest.edge.y) / distance;
    penetration = capsule.halfWidth - distance; point = closest.edge;
  } else {
    const exits = [
      { depth: Math.max(a.x, b.x) + halfX, nx: -1, ny: 0 },
      { depth: halfX - Math.min(a.x, b.x), nx: 1, ny: 0 },
      { depth: Math.max(a.y, b.y) + halfY, nx: 0, ny: -1 },
      { depth: halfY - Math.min(a.y, b.y), nx: 0, ny: 1 }
    ].sort((p, q) => p.depth - q.depth);
    ({ nx, ny } = exits[0]); penetration = exits[0].depth + capsule.halfWidth;
    point = { x: nx ? nx * halfX : clamp((a.x + b.x) / 2, -halfX, halfX),
      y: ny ? ny * halfY : clamp((a.y + b.y) / 2, -halfY, halfY) };
  }
  const c = Math.cos(obstacle.angle || 0), s = Math.sin(obstacle.angle || 0);
  return { nx: nx * c - ny * s, ny: nx * s + ny * c, penetration,
    contactX: obstacle.x + point.x * c - point.y * s, contactY: obstacle.y + point.x * s + point.y * c };
}

/** Separation on each rectangle axis, with a conservative gap between plots. */
export function sceneryOverlaps(a, b, gap = 0) {
  if (Math.hypot(a.x - b.x, a.y - b.y) >= a.collisionRadius + b.collisionRadius + gap) return false;
  if (a.collisionShape !== "box" && b.collisionShape !== "box") return true;
  if (a.collisionShape !== "box") return sceneryOverlaps(b, a, gap);
  if (b.collisionShape !== "box") {
    const p = local(b, a);
    return Math.hypot(p.x - clamp(p.x, -a.width / 2, a.width / 2), p.y - clamp(p.y, -a.height / 2, a.height / 2)) < b.collisionRadius + gap;
  }
  for (const angle of [a.angle || 0, (a.angle || 0) + Math.PI / 2, b.angle || 0, (b.angle || 0) + Math.PI / 2]) {
    const radius = box => Math.abs(Math.cos((box.angle || 0) - angle)) * box.width / 2 + Math.abs(Math.sin((box.angle || 0) - angle)) * box.height / 2;
    const separation = Math.abs((a.x - b.x) * Math.cos(angle) + (a.y - b.y) * Math.sin(angle));
    if (separation >= radius(a) + radius(b) + gap) return false;
  }
  return true;
}
