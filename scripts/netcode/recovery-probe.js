// sessionStorage can be copied when a tab is duplicated. Its checkpoint is
// evidence of prior ownership, never evidence that the old instance has left.
export const RECOVERY_PROBE_MS = 3000;
const OWNER_MESSAGES = new Set(["host-heartbeat", "race-frame", "race-state", "race-init",
  "race-results", "lobby-state", "stop-race", "lobby-closed"]);

export class RecoveryProbe {
  constructor(lease, { connected, requestState }) {
    this.lease = lease;
    this.connected = connected;
    this.requestState = requestState;
    this.startedAt = this.checkedAt = performance.now();
    this.requestedAt = -Infinity;
    this.timer = null;
    this.done = false;
    this.result = new Promise(resolve => { this.resolve = resolve; });
  }

  start() { this.check(); return this.result; }

  check() {
    if (this.done) return;
    const now = performance.now();
    // A suspended/disconnected tab has not actually observed a quiet owner.
    if (!this.connected() || now < this.checkedAt || now - this.checkedAt > 1500) return this.finish(false);
    this.checkedAt = now;
    if (now - this.startedAt >= RECOVERY_PROBE_MS) return this.finish(true);
    if (now - this.requestedAt >= 1000) {
      this.requestedAt = now;
      try { this.requestState(); }
      catch (_) { return this.finish(false); }
    }
    if (!this.done) this.timer = setTimeout(() => this.check(), 100);
  }

  observe(message) {
    if (!OWNER_MESSAGES.has(message.type)) return;
    const source = message.type === "lobby-state" ? message.lobby : message;
    const lobbyId = message.type === "lobby-state" ? source?.id : source?.lobbyId;
    if (message.senderId === this.lease.hostId && lobbyId === this.lease.lobbyId
      && (Number(source?.hostEpoch) || 0) === (Number(this.lease.hostEpoch) || 0)
      && (source?.hostInstanceId ?? null) === (this.lease.hostInstanceId ?? null)) this.finish(false);
  }

  cancel() { this.finish(false); }

  finish(quiet) {
    if (this.done) return;
    this.done = true;
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
    this.resolve(quiet);
  }
}
