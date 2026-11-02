// @ts-check

import { MODULE_ID } from "../constants.js";
import { BufferedLoops } from "../audio/buffered-loops.js";

const SPEED_TO_KMH = 0.62 / 3;
const AUDIO_UPDATE_INTERVAL_MS = 90;
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));

export const DEFAULT_SOUND_PATHS = Object.freeze({
  engine: `modules/${MODULE_ID}/sounds/engine-loop.ogg`,
  wind: `modules/${MODULE_ID}/sounds/wind-loop.ogg`,
  skid: `modules/${MODULE_ID}/sounds/skid-loop.ogg`,
  ambience: `modules/${MODULE_ID}/sounds/track-ambience-loop.ogg`,
  pitAmbience: `modules/${MODULE_ID}/sounds/pit-ambience-loop.ogg`,
  boost: `modules/${MODULE_ID}/sounds/boost.ogg`,
  collision: `modules/${MODULE_ID}/sounds/collision.ogg`,
  pitEntry: `modules/${MODULE_ID}/sounds/pit-entry.ogg`,
  pitService: `modules/${MODULE_ID}/sounds/pit-service.ogg`,
  countdown: `modules/${MODULE_ID}/sounds/countdown.ogg`,
  start: `modules/${MODULE_ID}/sounds/start.ogg`,
  lap: `modules/${MODULE_ID}/sounds/lap.ogg`,
  finish: `modules/${MODULE_ID}/sounds/finish.ogg`,
  ui: `modules/${MODULE_ID}/sounds/ui-click.ogg`
});

const PATH_SETTING = Object.freeze({
  engine: "soundEnginePath",
  wind: "soundWindPath",
  skid: "soundSkidPath",
  ambience: "soundAmbiencePath",
  pitAmbience: "soundPitAmbiencePath",
  boost: "soundBoostPath",
  collision: "soundCollisionPath",
  pitEntry: "soundPitEntryPath",
  pitService: "soundPitServicePath",
  countdown: "soundCountdownPath",
  start: "soundStartPath",
  lap: "soundLapPath",
  finish: "soundFinishPath",
  ui: "soundUiPath"
});

function getSetting(key, fallback) {
  try {
    const value = game.settings.get(MODULE_ID, key);
    return value == null ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

function getSoundPath(name) {
  const configured = String(getSetting(PATH_SETTING[name], DEFAULT_SOUND_PATHS[name]) ?? "").trim();
  return configured || DEFAULT_SOUND_PATHS[name];
}

function canUseAudio() {
  return typeof globalThis.Audio === "function";
}

function makeAudio(path, loop = false) {
  if (!canUseAudio() || !path) return null;
  const audio = new Audio(path);
  audio.preload = "auto";
  audio.loop = loop;
  audio.volume = 0;
  return audio;
}

export function playUiClick() {
  if (!canUseAudio() || getSetting("soundEnabled", true) !== true) return;
  const master = clamp(getSetting("soundMasterVolume", 0.75));
  const uiVolume = clamp(getSetting("soundUiVolume", 0.55));
  if (master <= 0 || uiVolume <= 0) return;
  const audio = makeAudio(getSoundPath("ui"));
  if (!audio) return;
  audio.volume = clamp(master * uiVolume * 0.55);
  void audio.play().catch(() => {});
}

export class RaceSoundManager {
  constructor({ getLocalCarId }) {
    this.getLocalCarId = getLocalCarId;
    this.active = false;
    this.suspended = false;
    this.loopBank = null;
    this.loopErrors = new Set();
    this.lastSnapshot = null;
    this.oneShots = new Set();
    this.cooldowns = new Map();
    this.previous = null;
    this.lastUpdateAt = 0;
    this.updateCount = 0;
    this.updateCostEma = 0;
    this.updateCostMax = 0;
    this.settings = this.#readSettings();
    this.unlockPromise = null;
    this.settingsHook = globalThis.Hooks?.on?.("fblNeedForSpeedAudioSettingsChanged", () => this.reload()) ?? null;
    this.unlockAbortController = null;
  }

  mount(root) {
    const wasActive = this.active;
    this.active = true;
    this.suspended = Boolean(globalThis.document?.hidden);
    this.settings = this.#readSettings();
    if (!wasActive) {
      this.updateCount = 0;
      this.updateCostEma = 0;
      this.updateCostMax = 0;
    }
    this.#loadLoops();
    this.loopBank?.setMuted(this.suspended || !this.settings.enabled);
    this.#bindUnlock(root);
    this.#tryUnlock();
  }

  reload() {
    this.settings = this.#readSettings();
    if (!this.active) return;
    this.#loadLoops();
    this.loopBank?.setMuted(this.suspended || !this.settings.enabled);
    if (!this.settings.enabled) this.#stopOneShots();
    if (this.lastSnapshot) this.#mixLoops(this.lastSnapshot);
    this.#tryUnlock();
  }

  setSuspended(suspended) {
    this.suspended = Boolean(suspended);
    this.loopBank?.setMuted(this.suspended || !this.settings.enabled);
    if (this.suspended) {
      this.#stopOneShots();
      return;
    }
    this.#tryUnlock();
  }

  stop() {
    this.active = false;
    this.suspended = false;
    this.previous = null;
    this.lastSnapshot = null;
    this.lastUpdateAt = 0;
    this.updateCount = 0;
    this.updateCostEma = 0;
    this.updateCostMax = 0;
    this.unlockPromise = null;
    this.unlockAbortController?.abort();
    this.unlockAbortController = null;
    this.#stopLoops();
    this.#stopOneShots();
    this.cooldowns.clear();
    this.loopErrors.clear();
  }

  #stopOneShots() {
    for (const audio of this.oneShots) {
      try { audio.pause(); } catch (_) { /* already disposed */ }
    }
    this.oneShots.clear();
  }

  destroy() {
    this.stop();
    if (this.settingsHook != null) globalThis.Hooks?.off?.("fblNeedForSpeedAudioSettingsChanged", this.settingsHook);
    this.settingsHook = null;
  }


  getDiagnosticStats() {
    const loops = this.loopBank?.stats() ?? { backend: "unavailable", loops: 0, playingLoops: 0, bufferBytes: 0 };
    return {
      active: this.active,
      suspended: this.suspended,
      updateIntervalMs: AUDIO_UPDATE_INTERVAL_MS,
      ...loops,
      loopErrors: this.loopErrors.size,
      oneShots: this.oneShots.size,
      unlockPending: Boolean(this.unlockPromise),
      updateCount: this.updateCount,
      updateCostMs: this.updateCostEma,
      updateCostMaxMs: this.updateCostMax
    };
  }

  update(snapshot) {
    if (snapshot) this.lastSnapshot = snapshot;
    if (!this.active || this.suspended || !snapshot) return;
    const now = performance.now();
    if (now - this.lastUpdateAt < AUDIO_UPDATE_INTERVAL_MS) return;
    this.lastUpdateAt = now;
    const startedAt = performance.now();

    const settings = this.settings;
    const master = settings.enabled ? settings.master : 0;
    const vehicle = settings.vehicle;
    const ambience = settings.ambience;
    const effects = settings.effects;
    const localId = String(this.getLocalCarId?.() ?? "");
    const car = snapshot.cars?.find((candidate) => String(candidate.id) === localId) ?? null;

    this.#updateEvents(snapshot, car, master * effects);
    this.#updateLoops(snapshot, car, { master, vehicle, ambience });
    const cost = Math.max(0, performance.now() - startedAt);
    this.updateCount += 1;
    this.updateCostEma = this.updateCostEma ? this.updateCostEma * 0.88 + cost * 0.12 : cost;
    this.updateCostMax = Math.max(this.updateCostMax, cost);
  }

  #readSettings() {
    return {
      enabled: getSetting("soundEnabled", true) === true,
      master: clamp(getSetting("soundMasterVolume", 0.75)),
      vehicle: clamp(getSetting("soundVehicleVolume", 0.8)),
      ambience: clamp(getSetting("soundAmbienceVolume", 0.55)),
      effects: clamp(getSetting("soundEffectsVolume", 0.8)),
      paths: Object.fromEntries(Object.keys(PATH_SETTING).map((name) => [name, getSoundPath(name)]))
    };
  }

  #loadLoops() {
    if (!BufferedLoops.supported() || !this.settings.enabled) return;
    try {
      this.loopBank ??= new BufferedLoops({ onError: (name, error) => {
        const key = `${name}:${this.settings.paths[name]}`;
        if (this.loopErrors.has(key)) return;
        this.loopErrors.add(key);
        console.warn(`FBL Need for Speed | не удалось загрузить непрерывный звук (${name})`, error);
        globalThis.ui?.notifications?.warn?.("Большие Гонки: не удалось загрузить один из непрерывных звуков. Проверьте звуковые файлы; подробности в консоли.");
      } });
    } catch (error) {
      console.warn("FBL Need for Speed | звуковой контекст недоступен", error);
      return;
    }
    for (const name of ["engine", "wind", "skid", "ambience", "pitAmbience"]) {
      void this.loopBank.setLoop(name, this.settings.paths[name]);
    }
  }

  #stopLoops() {
    this.loopBank?.stop();
    this.loopBank = null;
  }

  #bindUnlock(root) {
    this.unlockAbortController?.abort();
    this.unlockAbortController = new AbortController();
    const signal = this.unlockAbortController.signal;
    const unlock = () => this.#tryUnlock();
    root?.addEventListener?.("pointerdown", unlock, { signal, passive: true });
    root?.addEventListener?.("keydown", unlock, { signal, passive: true });
  }

  #tryUnlock() {
    if (!this.active || this.suspended || !this.settings.enabled || !this.loopBank || this.unlockPromise) return;
    // Retry autoplay only on mount/settings/real gestures, never on snapshots.
    const pending = this.loopBank.unlock().catch(() => {}).finally(() => {
      if (this.unlockPromise === pending) this.unlockPromise = null;
    });
    this.unlockPromise = pending;
  }

  #setLoop(name, targetVolume, playbackRate = 1) {
    this.loopBank?.setLevel(name, targetVolume, playbackRate);
  }

  #mixLoops(snapshot) {
    const car = snapshot.cars?.find(candidate => String(candidate.id) === String(this.getLocalCarId?.() ?? "")) ?? null;
    this.#updateLoops(snapshot, car, { master: this.settings.enabled ? this.settings.master : 0,
      vehicle: this.settings.vehicle, ambience: this.settings.ambience });
  }

  #updateLoops(snapshot, car, volumes) {
    const racing = Boolean(snapshot.started) && !snapshot.finished;
    const speed = car ? Math.hypot(Number(car.vx) || 0, Number(car.vy) || 0) : 0;
    const speedKmh = speed * SPEED_TO_KMH;
    const pit = car && car.pitState !== "track";
    const service = car?.pitState === "service";

    const engineRunning = car && !snapshot.finished && !car.finished && !car.disabled;
    const engineLevel = engineRunning
      ? volumes.master * volumes.vehicle * (!racing || service ? 0.12 : clamp(0.18 + speedKmh / 155, 0.18, 0.92))
      : 0;
    const engineRate = service ? 0.62 : !racing ? 0.68 : 0.68 + clamp(speedKmh / 125, 0, 1) * 0.9;
    this.#setLoop("engine", engineLevel, engineRate);

    const windLevel = car && racing
      ? volumes.master * volumes.vehicle * clamp((speedKmh - 30) / 115, 0, 0.72)
      : 0;
    this.#setLoop("wind", windLevel, 0.82 + clamp(speedKmh / 140, 0, 1) * 0.42);

    let skidLevel = 0;
    if (car && racing && !service) {
      const rightX = -Math.sin(Number(car.angle) || 0);
      const rightY = Math.cos(Number(car.angle) || 0);
      const lateral = Math.abs((Number(car.vx) || 0) * rightX + (Number(car.vy) || 0) * rightY);
      const moving = clamp((speedKmh - 3) / 12);
      skidLevel = volumes.master * volumes.vehicle * moving
        * clamp((lateral - 18) / 90 + Number(car.surfaceSeverity || 0) * 0.45, 0, 0.62);
    }
    this.#setLoop("skid", skidLevel, 0.9 + clamp(speedKmh / 160, 0, 1) * 0.25);

    this.#setLoop("ambience", racing ? volumes.master * volumes.ambience * (pit ? 0.22 : 0.5) : 0, 1);
    this.#setLoop("pitAmbience", racing && pit ? volumes.master * volumes.ambience * (service ? 0.72 : 0.46) : 0, 1);
  }

  #updateEvents(snapshot, car, effectVolume) {
    const previous = this.previous;
    const current = car ? {
      countdown: Math.ceil(Math.max(0, Number(snapshot.countdown) || 0)),
      started: Boolean(snapshot.started),
      finishedRace: Boolean(snapshot.finished),
      boost: Boolean(car.boost),
      pitState: String(car.pitState || "track"),
      lap: Number(car.lap) || 0,
      health: Number(car.health) || 0,
      disabled: Boolean(car.disabled),
      finished: Boolean(car.finished),
      wallContact: Number(car.wallContactTimer) || 0
    } : {
      countdown: Math.ceil(Math.max(0, Number(snapshot.countdown) || 0)),
      started: Boolean(snapshot.started),
      finishedRace: Boolean(snapshot.finished)
    };

    if (previous) {
      if (!current.started && current.countdown > 0 && current.countdown < previous.countdown) {
        this.#play("countdown", effectVolume * 0.7, 80);
      }
      if (current.started && !previous.started) this.#play("start", effectVolume, 500);
      if (car) {
        if (current.boost && !previous.boost) this.#play("boost", effectVolume * 0.86, 180);
        if (previous.pitState === "track" && current.pitState === "entering") this.#play("pitEntry", effectVolume * 0.78, 900);
        if (previous.pitState === "entering" && current.pitState === "service") this.#play("pitService", effectVolume, 900);
        if (current.lap > previous.lap && !current.finished) this.#play("lap", effectVolume * 0.85, 1000);
        if (current.finished && !previous.finished) this.#play("finish", effectVolume, 2000);
        const damage = Math.max(0, previous.health - current.health);
        const newWallHit = current.wallContact > 0.02 && previous.wallContact <= 0.02;
        if (damage > 0.8 || newWallHit || current.disabled && !previous.disabled) {
          this.#play("collision", effectVolume * clamp(0.42 + damage / 24, 0.42, 1), 220);
        }
      } else if (current.finishedRace && !previous.finishedRace) {
        this.#play("finish", effectVolume, 2000);
      }
    }
    this.previous = current;
  }

  #play(name, volume, cooldownMs = 0) {
    if (!canUseAudio() || volume <= 0.003) return;
    const now = performance.now();
    if (now < Number(this.cooldowns.get(name) || 0)) return;
    this.cooldowns.set(name, now + Math.max(0, cooldownMs));
    const audio = makeAudio(this.settings.paths[name]);
    if (!audio) return;
    if (this.oneShots.size >= 12) {
      const oldest = this.oneShots.values().next().value;
      try { oldest.pause(); } catch (_) { /* already disposed */ }
      this.oneShots.delete(oldest);
    }
    audio.volume = clamp(volume);
    this.oneShots.add(audio);
    const cleanup = () => this.oneShots.delete(audio);
    audio.addEventListener("ended", cleanup, { once: true });
    audio.addEventListener("error", cleanup, { once: true });
    void audio.play().catch(cleanup);
  }
}
