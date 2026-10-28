import { MODULE_ID, VERSION, PROTOCOL_VERSION } from "./constants.js";

const MAX_BYTES = 256_000;
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Tab-local checkpoints survive F5 without sharing authority between tabs. */
export class RaceRecoveryStore {
  constructor() { this.warned = false; }

  get key() {
    return `${MODULE_ID}:recovery:${game.world?.id ?? "world"}:${game.user.id}`;
  }

  save({ lobby, race, checkpoint }) {
    try {
      if (!globalThis.sessionStorage) return false;
      const text = JSON.stringify({ version: VERSION, protocol: PROTOCOL_VERSION,
        savedAt: Date.now(), userId: game.user.id, lobby, race, checkpoint });
      if (text.length * 2 > MAX_BYTES) throw new Error("Сохранение превышает допустимый размер");
      sessionStorage.setItem(this.key, text);
      return true;
    } catch (error) {
      if (!this.warned) console.warn("FBL Need for Speed | сохранение для F5 недоступно", error);
      this.warned = true;
      return false;
    }
  }

  load(lease) {
    try {
      const text = globalThis.sessionStorage?.getItem(this.key);
      if (!text || text.length * 2 > MAX_BYTES) return null;
      const saved = JSON.parse(text);
      if (saved.version !== VERSION || saved.protocol !== PROTOCOL_VERSION || saved.userId !== game.user.id
        || !Number.isFinite(saved.savedAt) || Date.now() - saved.savedAt < -10_000
        || Date.now() - saved.savedAt > MAX_AGE_MS || !lease?.raceId
        || saved.race?.raceId !== lease.raceId || saved.race?.hostId !== game.user.id
        || saved.lobby?.id !== lease.lobbyId || saved.lobby?.hostEpoch !== lease.hostEpoch
        || lease.hostId !== game.user.id || saved.race.phase !== "race") return null;
      return saved;
    } catch (_) { return null; }
  }

  clear() {
    try { globalThis.sessionStorage?.removeItem(this.key); } catch (_) { /* Storage can be disabled. */ }
  }
}
