const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const angleWrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const dot = (ax, ay, bx, by) => ax * bx + ay * by;

/**
 * Deterministic kinematic core shared by the authoritative simulation and the
 * remote client's local prediction. The caller owns race-specific resources,
 * terrain queries, collisions and trait side effects; this function owns the
 * actual drive/steer/grip/drag integration so the two paths cannot drift apart.
 *
 * Drift is an explicit driving command. At sufficient speed the dedicated
 * drift input must be held together with steering to break rear traction.
 * Ordinary high-speed steering, braking and throttle lift never create a drift
 * state by themselves. Releasing the key restores grip gradually, while
 * countersteer exits faster and excessive slip can still develop into a spin.
 * The optional driftAssist modifier changes entry and recovery without making
 * the car permanently slippery in ordinary driving.
 *
 * @param {object} state Mutable kinematic state.
 * @param {object} input Sanitized driving input.
 * @param {object} physics Car physics parameters.
 * @param {number} dt Fixed or bounded time step in seconds.
 * @param {object} [modifiers] Race-state multipliers calculated by the caller.
 * @returns {{forwardSpeed:number,lateralSpeed:number,steering:number,brakingForReverse:boolean,speedRatio:number,driftAmount:number,slipAngle:number,drifting:boolean}}
 */
export function applyDriveModel(state, input, physics, dt, modifiers = {}) {
  const p = physics ?? {};
  const step = Math.max(0, Number(dt) || 0);
  const maxSpeed = Math.max(1, Number(p.maxSpeed) || 420);
  const accelerationPower = Math.max(0, Number(p.acceleration) || 0);
  const reverseAcceleration = Math.max(0, Number(p.reverseAcceleration) || 0);
  const brakingPower = Math.max(0, Number(p.braking) || 0);
  const steerRate = Math.max(0, Number(p.steerRate) || 0);
  const recovery = Math.max(0.01, Number(p.recovery) || 1);
  const spinResistance = Math.max(0.01, Number(p.spinResistance) || 1);
  const lateralGrip = Math.max(0.01, Number(p.lateralGrip) || 1);
  const longitudinalDrag = Math.max(0, Number(p.longitudinalDrag) || 0);
  const rollingDrag = Math.max(0, Number(p.rollingDrag) || 0);

  const forwardX = Math.cos(state.angle);
  const forwardY = Math.sin(state.angle);
  const rightX = -forwardY;
  const rightY = forwardX;
  let forwardSpeed = dot(state.vx, state.vy, forwardX, forwardY);
  let lateralSpeed = dot(state.vx, state.vy, rightX, rightY);
  const forwardSpeedBeforeAcceleration = forwardSpeed;

  const speedRatio = clamp(Math.abs(forwardSpeed) / maxSpeed, 0, 1.4);
  const lowSpeedAuthority = clamp(Math.abs(forwardSpeed) / 72, 0.22, 1.04);
  // High-speed cornering should demand commitment. The raw steer rate still
  // defines how lively a chassis feels, but as speed climbs the available yaw
  // authority now falls off in a way that better rewards handling and control.
  const highSpeedHandling = clamp(Math.sqrt(Math.max(0.06, lateralGrip)) * 0.72 + steerRate * 0.18, 0.72, 2.1);
  const highSpeedPenalty = 0.64 / highSpeedHandling;
  const highSpeedAuthority = Math.max(0.24, 1 - speedRatio * speedRatio * highSpeedPenalty);
  const steerAuthority = lowSpeedAuthority * highSpeedAuthority;
  const accelerationMultiplier = Number.isFinite(Number(modifiers.accelerationMultiplier))
    ? Math.max(0, Number(modifiers.accelerationMultiplier)) : 1;
  const steeringMultiplier = Number.isFinite(Number(modifiers.steeringMultiplier))
    ? Math.max(0, Number(modifiers.steeringMultiplier)) : 1;
  const topSpeedMultiplier = Number.isFinite(Number(modifiers.topSpeedMultiplier))
    ? Math.max(0.01, Number(modifiers.topSpeedMultiplier)) : 1;
  const gripMultiplier = Number.isFinite(Number(modifiers.gripMultiplier))
    ? Math.max(0.01, Number(modifiers.gripMultiplier)) : 1;
  const boostAccelerationMultiplier = Math.max(0, Number(modifiers.boostAccelerationMultiplier) || 0);
  const boostTopSpeedMultiplier = Math.max(0.01, Number(modifiers.boostTopSpeedMultiplier) || 1);
  const extraAcceleration = Number(modifiers.extraAcceleration) || 0;

  let acceleration = extraAcceleration;
  if (input.throttle > 0) {
    acceleration += input.throttle * accelerationPower * (1 - speedRatio * 0.38) * accelerationMultiplier;
  }

  const wantsReverse = Boolean(input.reverse) || input.throttle < 0;
  const brakingForReverse = wantsReverse && forwardSpeed > 7;
  if (wantsReverse && !brakingForReverse) {
    acceleration -= reverseAcceleration * clamp(1 - Math.abs(forwardSpeed) / (maxSpeed * 0.3), 0.25, 1);
  }

  if (input.brake || brakingForReverse) {
    acceleration -= Math.sign(forwardSpeed || 1) * brakingPower;
  }

  if (boostAccelerationMultiplier > 0) {
    acceleration += accelerationPower * boostAccelerationMultiplier;
  }

  forwardSpeed += acceleration * step;
  const maxForward = maxSpeed * topSpeedMultiplier * boostTopSpeedMultiplier;
  const speedLimit = Number.isFinite(Number(modifiers.speedLimit)) ? Math.max(0, Number(modifiers.speedLimit)) : Infinity;
  const speedLimitDeceleration = Math.max(0, Number(modifiers.speedLimitDeceleration) || 0);
  const reverseSpeedMultiplier = clamp(Number(modifiers.reverseSpeedMultiplier) || 0.26, 0.05, 1);
  const limitedForward = Math.min(maxForward, speedLimit);

  if (Number.isFinite(speedLimit) && forwardSpeedBeforeAcceleration > limitedForward && forwardSpeed > limitedForward) {
    // A pit-lane limiter must bleed speed away instead of deleting it in one
    // physics tick. Positive throttle cannot cancel this deceleration, while
    // active braking is still allowed to slow the car more aggressively.
    const softenedSpeed = Math.max(limitedForward, forwardSpeedBeforeAcceleration - speedLimitDeceleration * step);
    forwardSpeed = Math.min(forwardSpeed, softenedSpeed);
  } else {
    forwardSpeed = Math.min(forwardSpeed, limitedForward);
  }
  forwardSpeed = Math.max(-maxSpeed * reverseSpeedMultiplier, forwardSpeed);

  let steering = clamp(Number(input.steer) || 0, -1, 1);
  if (Math.abs(steering) < 0.025) steering = 0;
  const previousSteer = Number(modifiers.previousSteer ?? state.lastSteer) || 0;
  const changedDirection = Math.sign(steering) !== Math.sign(previousSteer)
    && Math.abs(previousSteer) > 0.42 && Math.abs(steering) > 0.42;

  const driftEnabled = modifiers.driftEnabled !== false;
  const driftAssist = clamp(Number(modifiers.driftAssist) || 1, 0.75, 1.8);
  const driftControl = clamp(Number(modifiers.driftControl) || 1, 0.45, 2.2);
  const driftRequested = Boolean(input.drift);
  let driftAmount = clamp(Number(state.driftAmount) || 0, 0, 1);
  let driftDirection = Math.sign(Number(state.driftDirection) || 0);
  const initialSlipAngle = Math.atan2(lateralSpeed, Math.max(22, Math.abs(forwardSpeed)));
  const entrySpeed = maxSpeed * clamp(0.38 - (driftAssist - 1) * 0.08, 0.28, 0.40);
  const enoughSpeed = Math.abs(forwardSpeed) >= entrySpeed;
  const steeringForDrift = Math.abs(steering) >= 0.38;
  const requestedDirection = Math.sign(steering);
  const preliminaryCounterSteer = driftAmount > 0.04 && driftDirection !== 0
    && steering * driftDirection < -0.10;
  const enteringDrift = driftEnabled && driftRequested && enoughSpeed && steeringForDrift
    && driftAmount < 0.24 && (driftDirection === 0 || driftDirection === requestedDirection);

  if (enteringDrift) {
    if (!driftDirection) driftDirection = requestedDirection || Math.sign(initialSlipAngle || 1);
    const entryRate = 2.35 + Math.abs(steering) * 0.55;
    driftAmount = clamp(driftAmount + step * entryRate * driftAssist, 0, 1);
  } else if (driftEnabled && enoughSpeed && driftAmount > 0.04) {
    const steeringWithSlide = steering * driftDirection > 0.10;
    const sustainRate = preliminaryCounterSteer
      ? -1.12 * driftControl
      : driftRequested && steeringWithSlide ? 0.10
        : driftRequested ? -0.16
          : -0.74 * driftControl;
    driftAmount = clamp(driftAmount + sustainRate * step * driftAssist, 0, 1);
  } else {
    const recoveryRate = (1.12 + recovery * 0.72) * driftControl;
    driftAmount = clamp(driftAmount - recoveryRate * step, 0, 1);
  }
  if (driftAmount < 0.015) {
    driftAmount = 0;
    driftDirection = 0;
  } else if (!driftDirection) {
    driftDirection = Math.sign(steering || state.angularVelocity || -initialSlipAngle || 1);
  }

  const directionSign = Math.sign(forwardSpeed || 1);
  const yawResponseMultiplier = Number.isFinite(Number(modifiers.yawResponseMultiplier))
    ? Math.max(0.05, Number(modifiers.yawResponseMultiplier)) : 1;
  const angularDampingMultiplier = Number.isFinite(Number(modifiers.angularDampingMultiplier))
    ? Math.max(0.05, Number(modifiers.angularDampingMultiplier)) : 1;
  const counterSteering = driftAmount > 0.04 && steering * driftDirection < -0.10;
  const sameDirectionSteering = driftAmount > 0.04 && steering * driftDirection > 0.10;
  const driftYawMultiplier = 1 - driftAmount * 0.28 + (enteringDrift ? driftAmount * 0.06 : 0);
  state.angularVelocity = (Number(state.angularVelocity) || 0)
    + steering * steerRate * steerAuthority * steeringMultiplier * yawResponseMultiplier
      * driftYawMultiplier * directionSign * step * 5.2;

  if (driftAmount > 0) {
    const throttle = clamp(Number(input.throttle) || 0, 0, 1);
    const handbrakeYaw = enteringDrift ? 0.20 : driftRequested && !counterSteering ? 0.09 : 0;
    const throttleYaw = sameDirectionSteering ? Math.max(0, throttle - 0.50) * 0.14 : 0;
    const targetYaw = driftDirection * steerRate * steerAuthority
      * (0.10 + driftAmount * 0.26 + handbrakeYaw + throttleYaw);
    const yawBlend = clamp(step * (1.05 + driftAssist * 0.48), 0, 0.12);
    state.angularVelocity += (targetYaw - state.angularVelocity) * yawBlend * driftAmount;
  }

  const baseAngularDamping = 4.7 * spinResistance * recovery * angularDampingMultiplier;
  const driftDampingScale = 1 - driftAmount * 0.48;
  const counterDamping = counterSteering ? (1.9 + driftControl * 2.25) * driftAmount : 0;
  state.angularVelocity *= Math.exp(-(baseAngularDamping * driftDampingScale + counterDamping) * step);
  const inertialVx = forwardX * forwardSpeed + rightX * lateralSpeed;
  const inertialVy = forwardY * forwardSpeed + rightY * lateralSpeed;
  state.angle = angleWrap((Number(state.angle) || 0) + state.angularVelocity * step);
  const updatedForwardX = Math.cos(state.angle);
  const updatedForwardY = Math.sin(state.angle);
  const updatedRightX = -updatedForwardY;
  const updatedRightY = updatedForwardX;
  forwardSpeed = dot(inertialVx, inertialVy, updatedForwardX, updatedForwardY);
  lateralSpeed = dot(inertialVx, inertialVy, updatedRightX, updatedRightY);

  if (driftAmount > 0) {
    // The chassis rotates more quickly than the velocity vector. Throttle and
    // braking keep the rear axle sliding outward; countersteer then has a real
    // lateral velocity to arrest instead of merely changing a visual angle.
    const throttle = clamp(Number(input.throttle) || 0, 0, 1);
    const outwardDirection = -driftDirection;
    const handbrakeSlip = driftRequested && !counterSteering ? 0.12 : 0;
    const throttleSlip = 0.14 + throttle * 0.28 + handbrakeSlip + (input.brake ? 0.10 : 0);
    lateralSpeed += outwardDirection * Math.abs(forwardSpeed) * driftAmount * throttleSlip * step * 0.014;
  }

  const brakeGripMultiplier = (input.brake || brakingForReverse)
    ? Math.max(0.01, Number(modifiers.brakeGripMultiplier) || 1)
    : 1;
  const gripBase = lateralGrip * gripMultiplier;
  const driftGripRetention = 1 - driftAmount * (counterSteering ? 0.28 : 0.52);
  const controlledGrip = gripBase * Math.max(0.12, driftGripRetention)
    * (counterSteering ? 1 + (driftControl - 1) * 0.34 : 1);
  const lateralDamping = 1 - Math.exp(-controlledGrip * brakeGripMultiplier * step);
  lateralSpeed *= 1 - lateralDamping;

  const transferFactor = modifiers.smoothSteer && changedDirection ? 0.68 : 1;
  const driftCornerRelief = 1 - driftAmount * 0.34;
  const cornerLoss = Math.abs(steering) * speedRatio * speedRatio * 11 * transferFactor * driftCornerRelief * step;
  forwardSpeed -= Math.sign(forwardSpeed || 1) * Math.min(Math.abs(forwardSpeed), cornerLoss);

  const slipAngle = Math.atan2(lateralSpeed, Math.max(22, Math.abs(forwardSpeed)));
  const maximumControlledSlip = clamp(
    0.38 + (driftAssist - 1) * 0.18 + (driftControl - 1) * 0.06,
    0.32,
    0.58
  );
  const spinExcess = clamp((Math.abs(slipAngle) - maximumControlledSlip) / 0.38, 0, 1);
  if (spinExcess > 0 && driftAmount > 0.18) {
    const spinDirection = Math.sign(state.angularVelocity || driftDirection || -slipAngle || 1);
    state.angularVelocity += spinDirection * spinExcess * (0.85 + speedRatio * 1.15)
      / Math.sqrt(Math.max(0.35, spinResistance)) * step;
    driftAmount = Math.max(driftAmount, 0.68 + spinExcess * 0.32);
  }

  const drag = longitudinalDrag * speedRatio * speedRatio * Math.sign(forwardSpeed);
  forwardSpeed -= drag * 55 * step;
  if (Math.abs(forwardSpeed) > 0) {
    const rolling = Math.min(Math.abs(forwardSpeed), rollingDrag * step);
    forwardSpeed -= Math.sign(forwardSpeed) * rolling;
  }

  state.vx = updatedForwardX * forwardSpeed + updatedRightX * lateralSpeed;
  state.vy = updatedForwardY * forwardSpeed + updatedRightY * lateralSpeed;
  state.x += state.vx * step;
  state.y += state.vy * step;
  state.driftAmount = driftAmount;
  state.driftDirection = driftDirection;
  state.slipAngle = Math.atan2(lateralSpeed, Math.max(22, Math.abs(forwardSpeed)));

  return {
    forwardSpeed,
    lateralSpeed,
    steering,
    brakingForReverse,
    speedRatio,
    driftAmount,
    slipAngle: state.slipAngle,
    drifting: driftAmount > 0.18 && Math.abs(state.slipAngle) > 0.12
  };
}
