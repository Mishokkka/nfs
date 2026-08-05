import { samplePitAhead, sampleTrackAhead } from "../track.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const angleWrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const dot = (ax, ay, bx, by) => ax * bx + ay * by;

export function shouldBotPit(car, laps) {
  if (car.pitStopsCompleted >= car.pitStopsRequired) return false;
  const targetLap = Math.floor(((car.pitStopsCompleted + 1) * laps) / (car.pitStopsRequired + 1));
  return car.lap >= Math.max(0, targetLap)
    || car.finishBlocked
    || car.health < car.physics.maxHealth * 0.36
    || car.overheated;
}

export function computeBotInput({ car, dt, routeContext, track, cars, laps, tick }) {
  const velocity = Math.hypot(car.vx, car.vy);
  const forwardSpeed = Math.max(0, dot(car.vx, car.vy, Math.cos(car.angle), Math.sin(car.angle)));
  const skill = Math.round(clamp(car.botSkill, 1, 4));
  const mainNearest = routeContext.mainNearest;
  const pitNearest = routeContext.pitNearest;
  const wantsPit = shouldBotPit(car, laps);
  const pitApproach = Boolean(pitNearest) && car.pitState !== "track";
  const servicePoint = track.pit.samples[track.pit.serviceIndex];
  const serviceHalfLength = Number(track.pit.serviceHalfLength ?? 52);
  const serviceRemaining = pitApproach && car.pitState === "entering" && servicePoint
    ? servicePoint.cumulative - Number(pitNearest?.point?.cumulative ?? servicePoint.cumulative)
    : Infinity;
  const serviceApproach = Number.isFinite(serviceRemaining)
    && serviceRemaining <= Math.max(280, track.pit.speedLimit * 0.96)
    && serviceRemaining >= -serviceHalfLength * 0.9;
  const routeNearest = pitApproach ? pitNearest : mainNearest;
  const routeWidth = pitApproach ? track.pit.width : track.width;
  const ahead = (distance) => pitApproach
    ? samplePitAhead(track, routeNearest.index, distance)
    : sampleTrackAhead(track, routeNearest.index, distance);

  let laneOffset = pitApproach ? 0 : car.botLaneBias * routeWidth;
  if (!pitApproach) {
    const fx = Math.cos(car.angle);
    const fy = Math.sin(car.angle);
    const rx = -fy;
    const ry = fx;
    for (const rival of cars) {
      if (rival.id === car.id || rival.disabled || rival.finished || rival.pitState !== "track") continue;
      const dx = rival.x - car.x;
      const dy = rival.y - car.y;
      const longitudinal = dot(dx, dy, fx, fy);
      if (longitudinal < 10 || longitudinal > 145) continue;
      const lateral = dot(dx, dy, rx, ry);
      if (Math.abs(lateral) > 62) continue;
      laneOffset += (lateral >= 0 ? -1 : 1) * routeWidth * 0.13;
    }
    laneOffset = clamp(laneOffset, -routeWidth * (skill === 4 ? 0.18 : 0.26), routeWidth * (skill === 4 ? 0.18 : 0.26));
  }

  const skillLookahead = [0, 1.10, 1.05, 1.00, 0.96][skill];
  const lookaheadDistance = clamp((105 + forwardSpeed * 0.52) * skillLookahead, 130, pitApproach ? 285 : 420);
  const pitEntryStartProgress = Number(track.pit.entryMainProgressNormalized ?? 0.77);
  const pitEntryEndProgress = Number(track.pit.samples[track.pit.entryTriggerEnd]?.mainProgressUnwrapped ?? 0.93);
  const pitEntryMode = wantsPit
    && car.pitState === "track"
    && mainNearest.progress >= Math.max(0, pitEntryStartProgress - 0.08)
    && mainNearest.progress <= Math.min(0.985, pitEntryEndProgress + 0.025);
  let target = ahead(lookaheadDistance);
  if (pitEntryMode) {
    const mapped = clamp((mainNearest.progress - pitEntryStartProgress) / Math.max(0.001, pitEntryEndProgress - pitEntryStartProgress), 0, 1);
    const mappedIndex = Math.round(mapped * track.pit.entryTriggerEnd);
    target = samplePitAhead(track, mappedIndex, lookaheadDistance * 0.72);
    laneOffset = 0;
  }
  const targetX = target.x + target.nx * laneOffset;
  const targetY = target.y + target.ny * laneOffset;
  const pursuitHeading = Math.atan2(targetY - car.y, targetX - car.x);
  const tangentHeading = Math.atan2(target.ty, target.tx);
  const desiredHeading = tangentHeading + angleWrap(pursuitHeading - tangentHeading) * 0.82;
  const headingError = angleWrap(desiredHeading - car.angle);
  const lateralError = routeNearest.signedDistance - laneOffset;
  const crossTrack = Math.atan2(lateralError * 2.4, forwardSpeed + 75);
  let desiredSteer = headingError * (2.02 + skill * 0.17)
    - crossTrack * 1.65
    - car.angularVelocity * 0.48;

  const roadHalf = routeWidth * 0.5;
  const edgeRatio = Math.abs(lateralError) / Math.max(1, roadHalf);
  if (edgeRatio > 0.68 || car.surfaceSeverity > 0.04) {
    const rescue = clamp(-lateralError / Math.max(1, roadHalf * 0.92), -1, 1);
    desiredSteer = rescue * 1.15 - car.angularVelocity * 0.62;
  }
  desiredSteer = clamp(desiredSteer, -1, 1);

  const steeringResponse = 3.9 + skill * 0.88;
  car.botSteer += clamp(desiredSteer - car.botSteer, -steeringResponse * dt, steeringResponse * dt);

  // Curvature is refreshed at 20 Hz and staggered across bots. Steering still
  // runs at the full fixed timestep, while the expensive look-ahead is reused.
  let curvaturePerUnit = Number(car.botCurvature);
  if (!Number.isFinite(curvaturePerUnit) || (tick + car.botPhase) % 3 === 0) {
    const probes = [
      { distance: 190 + forwardSpeed * 0.28, weight: 1.24 },
      { distance: 430 + forwardSpeed * 0.58, weight: 1.02 },
      { distance: 760 + forwardSpeed * 0.96, weight: 0.78 }
    ];
    const baseHeading = Math.atan2(routeNearest.point.ty, routeNearest.point.tx);
    curvaturePerUnit = 0.00008;
    let previousHeading = baseHeading;
    let previousDistance = 0;
    for (const probe of probes) {
      const point = ahead(probe.distance);
      const heading = Math.atan2(point.ty, point.tx);
      const interval = Math.max(1, probe.distance - previousDistance);
      const localCurvature = Math.abs(angleWrap(heading - previousHeading)) / interval;
      curvaturePerUnit = Math.max(curvaturePerUnit, localCurvature * probe.weight);
      previousHeading = heading;
      previousDistance = probe.distance;
    }
    car.botCurvature = curvaturePerUnit;
  }

  const skillPace = [0, 0.91, 0.97, 1.04, 1.14][skill];
  const safeCornerSpeed = Math.sqrt(Math.max(1, car.physics.lateralGrip) * 38 / curvaturePerUnit);
  const cornerConfidence = [0, 0.94, 0.99, 1.05, 1.12][skill];
  let targetSpeed = Math.min(car.physics.maxSpeed * skillPace, safeCornerSpeed * cornerConfidence);
  targetSpeed = Math.max(car.physics.maxSpeed * [0, 0.22, 0.24, 0.27, 0.30][skill], targetSpeed);
  if (edgeRatio > 0.58) {
    const edgePenalty = skill === 4 ? 0.42 : 0.58;
    targetSpeed *= clamp(1.06 - edgeRatio * edgePenalty, skill === 4 ? 0.54 : 0.42, skill === 4 ? 0.97 : 0.78);
  }
  if (car.surfaceSeverity > 0.02) {
    const terrainLimit = car.surfaceType === "sand" ? 0.13 : car.surfaceType === "gravel" ? 0.20 : 0.26;
    targetSpeed = Math.min(targetSpeed, car.physics.maxSpeed * terrainLimit);
  }
  if (pitApproach || pitEntryMode) targetSpeed = Math.min(targetSpeed, track.pit.speedLimit * (pitApproach ? 0.93 : 1.08));
  if (serviceApproach) {
    // Bots obey the same physical service rule as players: they brake into the
    // visible blue box and reach a standstill there. No teleport or scripted
    // rail is used to start service.
    const stoppingTarget = Math.max(0, (serviceRemaining - 6) * 1.12);
    targetSpeed = Math.min(targetSpeed, stoppingTarget);
  }

  const brakingDistanceBias = skill === 4
    ? 1 + Math.max(0, curvaturePerUnit - 0.0014) * 22
    : 1 + Math.max(0, curvaturePerUnit - 0.0008) * 180;
  const brakeThreshold = skill === 4 ? 1.025 : 1.015;
  const triggerRatio = skill === 4
    ? clamp(brakeThreshold / brakingDistanceBias, 0.90, 1.05)
    : clamp(brakeThreshold / brakingDistanceBias, 0.72, 1.03);
  const serviceBrake = serviceApproach && forwardSpeed > Math.max(3, targetSpeed * 0.96);
  const brake = serviceBrake || (forwardSpeed > targetSpeed * triggerRatio && forwardSpeed > 42);
  const speedError = targetSpeed - forwardSpeed;
  const desiredThrottle = serviceApproach
    ? 0
    : brake ? 0 : clamp((skill === 4 ? 0.58 : 0.30) + speedError / (skill === 4 ? 92 : 125), 0.16, 1);
  const throttleResponse = brake ? 10 : 4.8;
  car.botThrottle += clamp(desiredThrottle - car.botThrottle, -throttleResponse * dt, throttleResponse * dt);

  if (pitEntryMode) {
    const entryHeading = Math.atan2(target.y - car.y, target.x - car.x);
    const entryError = angleWrap(entryHeading - car.angle);
    const entrySteer = clamp(entryError * 2.35 - car.angularVelocity * 0.52, -1, 1);
    car.botSteer += (entrySteer - car.botSteer) * clamp(dt * 5.2, 0, 1);
    car.botThrottle = Math.min(car.botThrottle, 0.64);
  }

  if (velocity > 90) car.botRecoveryAttempts = 0;
  if (velocity < 10 && car.botThrottle > 0.45) car.botStuckTimer += dt;
  else car.botStuckTimer = Math.max(0, car.botStuckTimer - dt * 2.5);
  if (car.botStuckTimer > 1.35) {
    if (car.pitState === "track") {
      car.botRecoveryAttempts = Number(car.botRecoveryAttempts || 0) + 1;
      if (car.botRecoveryAttempts >= 3) {
        car.botRecoveryRequested = true;
        car.botRecoveryAttempts = 0;
        car.botReverseTimer = 0;
      } else car.botReverseTimer = 0.78;
    } else if (car.pitState === "exit") car.botReverseTimer = 0.62;
    car.botStuckTimer = 0;
  }
  if (car.botReverseTimer > 0) {
    car.botReverseTimer -= dt;
    return { throttle: 0, steer: clamp(-car.botSteer, -1, 1), brake: false, reverse: true, boost: false, ram: false, drift: false };
  }

  let ram = false;
  if (!pitApproach && skill >= 3 && curvaturePerUnit < 0.00055 && edgeRatio < 0.42) {
    const rival = cars.find((candidate) => {
      if (candidate.id === car.id || candidate.disabled || candidate.finished || candidate.pitState !== "track") return false;
      const dx = candidate.x - car.x;
      const dy = candidate.y - car.y;
      if (Math.hypot(dx, dy) > 82) return false;
      return dot(dx, dy, Math.cos(car.angle), Math.sin(car.angle)) > 18;
    });
    ram = Boolean(rival) && car.resolved.driverStats.aggression + skill >= 8;
  }

  const boost = !brake
    && !pitApproach
    && curvaturePerUnit < (skill === 4 ? 0.00062 : 0.00034)
    && edgeRatio < (skill === 4 ? 0.42 : 0.36)
    && car.charge > 8
    && !car.overheated
    && car.heat < (skill === 4 ? 84 : 76)
    && forwardSpeed > car.physics.maxSpeed * (skill === 4 ? 0.40 : 0.48);
  return {
    throttle: clamp(car.botThrottle, 0, 1),
    steer: clamp(car.botSteer, -1, 1),
    brake,
    reverse: false,
    boost,
    ram,
    drift: false
  };
}
