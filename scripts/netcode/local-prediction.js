import { advanceCarMotion, terrainModifiers } from "../physics/car-motion.js";

const neutral = () => ({ throttle: 0, steer: 0, brake: false, reverse: false, boost: false, ram: false, drift: false });
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const FIXED_STEP = 1 / 60;
const MAX_HISTORY = 256;

/** Rebuild physics from the latest authority, replay only unacknowledged input,
 * and smooth a separate visual offset. Visual correction never feeds physics.
 * Input time and the simulation clock are mapped onto the same monotonic clock.
 */
export class LocalPrediction {
  constructor() { this.reset(); }

  reset() {
    this.history = [];
    this.authority = null;
    this.sourceTick = null;
    this.offset = { x: 0, y: 0, angle: 0 };
    this.lastAt = null;
    this.error = 0;
    this.correctionTime = 0.10;
    this.horizon = 0;
    this.blocked = false;
    this.state = null;
    this.displayedState = null;
    this.contactBlocked = false;
    this.contactClearAt = null;
  }

  /** Record an owning client's command on its monotonic clock; cap outage memory. */
  submit(input, sequence, at = performance.now()) {
    const last = this.history.at(-1);
    if (last && sequence <= last.sequence) return;
    this.history.push({ input: { ...input }, sequence, at });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
  }

  /** Rebuild physical state from a snapshot, replaying only input beyond its ACK. */
  #replay(authority, snapshot, now, clockOffset, receivedAt, maxHorizon, pit) {
    const sourceTime = Number(snapshot.simulationTime ?? snapshot.time) || 0;
    const mapped = Number.isFinite(clockOffset);
    const sourceAt = mapped ? (sourceTime + clockOffset) * 1000 : receivedAt;
    const horizon = clamp((now - sourceAt) / 1000, 0, maxHorizon);
    const state = { ...authority };
    const ack = Number(authority.inputSequence ?? -1);
    let input = neutral();
    for (const command of this.history) if (command.sequence <= ack) input = command.input;
    const pending = this.history.filter((command) => command.sequence > ack);
    const p = { ...authority.prediction, maxHealth: authority.maxHealth, maxCharge: authority.maxCharge };
    let elapsed = 0;
    let commandIndex = 0;
    // Bounded by the horizon and input-history count, even after a long pause.
    while (elapsed + 1e-9 < horizon) {
      while (commandIndex < pending.length && pending[commandIndex].at <= sourceAt + elapsed * 1000 + 0.01) {
        input = pending[commandIndex++].input;
      }
      let step = Math.min(FIXED_STEP, horizon - elapsed);
      const nextCommandAt = pending[commandIndex]?.at;
      if (nextCommandAt > sourceAt + elapsed * 1000) step = Math.min(step, (nextCommandAt - sourceAt) / 1000 - elapsed);
      if (step < 1e-8) break;
      advanceCarMotion(state, input, p, step, { laps: snapshot.laps, pit });
      // Frozen contact data is safe for a short replay. New collisions and
      // random gravel kicks are reconciled exclusively from the next authority.
      const terrain = terrainModifiers(state, p);
      if (terrain.dragRate) {
        const damping = Math.exp(-terrain.dragRate * step);
        state.vx *= damping;
        state.vy *= damping;
      }
      elapsed += step;
    }
    return { state, horizon };
  }

  /** Keep brief wall-contact fluctuations from alternating between two timelines. */
  #updateContact(timer, now) {
    if (timer > 0.02) {
      this.contactBlocked = true;
      this.contactClearAt = null;
    } else if (this.contactBlocked) {
      if (timer < 0.005) {
        this.contactClearAt ??= now;
        if (now - this.contactClearAt >= 100) this.contactBlocked = false;
      } else this.contactClearAt = null;
    }
  }

  /** Rebase only the displayed pose; teleports and pit transitions stay authoritative. */
  #correctVisual(from, target, contact = false) {
    const errorX = from.x - target.x, errorY = from.y - target.y;
    this.error = Math.hypot(errorX, errorY);
    this.correctionTime = contact ? 0.05 : clamp(0.08 + this.error / 550, 0.08, 0.32);
    const discontinuity = from.pitState !== target.pitState || this.error > 260;
    this.offset = discontinuity ? { x: 0, y: 0, angle: 0 } : {
      x: clamp(errorX, -180, 180), y: clamp(errorY, -180, 180),
      angle: clamp(angleDelta(from.angle, target.angle), -0.7, 0.7)
    };
  }

  /** Sample local presentation without feeding its correction back into physics.
   * Wall contact switches smoothly in both directions; terminal states snap to
   * authority so service, retirement and respawn do not retain speculative motion.
   */
  sample(authority, snapshot, { now, clockOffset, receivedAt = now, maxHorizon = 0.25, pit = {} }) {
    const dt = this.lastAt == null ? 0 : clamp((now - this.lastAt) / 1000, 0, 0.25);
    const sourceTick = Number(snapshot.tick) || 0;
    const wasContactBlocked = this.contactBlocked;
    this.#updateContact(Number(authority.wallContactTimer) || 0, now);
    const terminal = !snapshot.started || authority.finished || authority.disabled || authority.abandoned
      || authority.isBot || authority.pitState === "service";
    this.blocked = Boolean(terminal || this.contactBlocked);
    if (terminal || !authority.prediction) {
      this.authority = null;
      this.offset = { x: 0, y: 0, angle: 0 };
      this.state = { ...authority };
      this.displayedState = this.state;
      this.contactBlocked = false;
      this.contactClearAt = null;
      this.lastAt = now;
      this.horizon = 0;
      this.error = 0;
      return this.state;
    }
    const replay = this.contactBlocked ? { state: { ...authority }, horizon: 0 }
      : this.#replay(authority, snapshot, now, clockOffset, receivedAt, maxHorizon, pit);
    if (this.displayedState && (wasContactBlocked !== this.contactBlocked
      || (this.contactBlocked && sourceTick !== this.sourceTick))) {
      this.#correctVisual(this.displayedState, replay.state, this.contactBlocked);
    } else if (this.authority && sourceTick !== this.sourceTick) {
      const prior = this.#replay(this.authority.car, this.authority.snapshot, now, clockOffset, this.authority.receivedAt, maxHorizon, pit).state;
      this.#correctVisual({ ...prior, x: prior.x + this.offset.x, y: prior.y + this.offset.y, angle: prior.angle + this.offset.angle }, replay.state);
    }
    const decay = Math.exp(-dt / this.correctionTime);
    for (const key of ["x", "y", "angle"]) this.offset[key] *= decay;
    this.authority = this.contactBlocked ? null : { car: authority, snapshot, receivedAt };
    this.sourceTick = sourceTick;
    this.lastAt = now;
    this.horizon = replay.horizon;
    this.state = replay.state;
    // Retain the acknowledged input as the base for future replay and prune
    // older acknowledgements. submit() caps the count during a connection stall.
    const ack = Number(authority.inputSequence ?? -1);
    let keep = 0;
    for (let i = 0; i < this.history.length; i++) if (this.history[i].sequence <= ack) keep = i;
    if (keep > 0) this.history.splice(0, keep);
    this.displayedState = { ...replay.state, x: replay.state.x + this.offset.x, y: replay.state.y + this.offset.y, angle: replay.state.angle + this.offset.angle };
    return this.displayedState;
  }
}
