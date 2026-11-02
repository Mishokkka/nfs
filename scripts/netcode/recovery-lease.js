// A world setting is not an atomic lock. Cross-lobby recovery needs both an
// expired durable lease and a full local observation period without its owner.
// Legacy leases have no expiry; they still require the same quiet period.
export const RECOVERY_LEASE_MS = 90_000;
export const RECOVERY_LEASE_RENEW_MS = 30_000;

const ownerKey = lease => JSON.stringify([lease.raceId, lease.lobbyId, lease.hostId,
  lease.hostInstanceId ?? null, Number(lease.hostEpoch) || 0, lease.hostClaimId ?? null,
  Number(lease.hostClaimedAt) || 0, Number(lease.expiresAt) || 0]);

export class RecoveryLeaseGuard {
  constructor() { this.record = null; }

  reset() { this.record = null; }

  canReplace(lease, { now = performance.now(), wallNow = Date.now(), connected = true } = {}) {
    const key = ownerKey(lease);
    if (!this.record || this.record.key !== key) {
      this.record = { key, lease: { ...lease }, quietSince: now, checkedAt: now };
    }
    const record = this.record;
    // A suspended tab or a disconnected socket has not observed a quiet owner.
    if (!connected || now - record.checkedAt > 5000 || now < record.checkedAt) record.quietSince = now;
    record.checkedAt = now;
    const expiresAt = Number(lease.expiresAt) || 0;
    return connected && wallNow >= expiresAt && now - record.quietSince >= RECOVERY_LEASE_MS;
  }

  observe(message, now = performance.now()) {
    const lease = this.record?.lease;
    if (!lease || !["host-heartbeat", "race-frame", "race-state", "race-init", "race-results", "lobby-state"].includes(message.type)) return;
    const source = message.type === "lobby-state" ? message.lobby : message;
    if (!source) return;
    const lobbyId = message.type === "lobby-state" ? source.id : source.lobbyId;
    if (message.senderId !== lease.hostId || lobbyId !== lease.lobbyId
      || (Number(source.hostEpoch) || 0) !== (Number(lease.hostEpoch) || 0)
      || (source.hostInstanceId ?? null) !== (lease.hostInstanceId ?? null)) return;
    this.record.quietSince = now;
  }
}
