// @ts-check

import { MODULE_ID, PHYSICS_HZ, PROTOCOL_VERSION, SNAPSHOT_HZ, VERSION } from "../constants.js";
import { normalizeBuild } from "../catalog.js";
import { generateTrack } from "../track.js";
import { RaceSimulation, neutralInput } from "../physics.js";
import { RaceRenderer } from "../renderer.js";
import { normalizeConfig } from "../network.js";
import { RaceInput } from "./race-input.js";
import { RaceHud } from "./race-hud.js";
import { PitUi } from "./pit-ui.js";
import { RaceSoundManager } from "./sound-manager.js";

export class RaceRuntime {
  constructor({ network, isRaceActive, onFinished }) {
    this.network = network;
    this.isRaceActive = isRaceActive;
    this.onFinished = onFinished;
    this.practice = false;
    this.isHost = false;
    this.config = normalizeConfig({});
    this.currentRaceId = null;
    this.localCarId = null;
    this.controlConfirmed = false;
    this.track = null;
    this.simulation = null;
    this.simulationWorker = null;
    this.workerReady = false;
    this.workerInitEntries = null;
    this.workerStartupTimer = null;
    this.renderer = null;
    this.previousSimulationSnapshot = null;
    this.currentSimulationSnapshot = null;
    this.pendingInitialSnapshot = null;
    this.raceFrame = null;
    this.lastFrameAt = 0;
    this.accumulator = 0;
    this.lastSnapshotSent = 0;
    this.lastWorkerSnapshotAt = 0;
    this.hiddenTimer = null;
    this.hiddenWallAt = 0;
    this.hiddenAccumulator = 0;
    this.resultsSent = false;
    this.lastInputSequence = new Map();
    try {
      this.cameraMode = game.settings.get(MODULE_ID, "cameraMode") || "overview";
      this.minimapEnabled = game.settings.get(MODULE_ID, "minimapEnabled") !== false;
      this.performanceOverlay = game.settings.get(MODULE_ID, "performanceOverlay") === true;
    } catch (error) {
      console.warn("FBL Need for Speed | не удалось прочитать клиентские настройки", error);
      this.cameraMode = "overview";
      this.minimapEnabled = true;
      this.performanceOverlay = false;
    }

    this.pitUi = new PitUi({
      onComplete: (word, attemptId) => this.#completeLocalPit(word, attemptId),
      onRestoreFocus: () => this.input.restoreFocus()
    });
    this.hud = new RaceHud({ pitUi: this.pitUi });
    this.input = new RaceInput({
      getLocalCarId: () => this.localCarId,
      getSnapshot: () => this.currentSimulationSnapshot ?? this.pendingInitialSnapshot,
      isRaceActive: () => this.isRaceActive(),
      onInput: (input, sequence) => this.#submitLocalInput(input, sequence),
      onCameraMode: (mode) => this.setCameraMode(mode),
      onToggleCamera: () => this.toggleCameraMode(),
      onToggleMinimap: () => this.toggleMinimap(),
      onVisibilityChange: (hidden) => this.#handleVisibility(hidden)
    });
    this.audio = new RaceSoundManager({ getLocalCarId: () => this.localCarId });
  }

  getContext() {
    return {
      cameraMode: this.cameraMode,
      isOverviewCamera: this.cameraMode === "overview",
      isChaseCamera: this.cameraMode === "chase",
      minimapEnabled: this.minimapEnabled,
      performanceOverlay: this.performanceOverlay,
      requiredPitStops: this.config.requiredPitStops
    };
  }

  start({ config, entries, host, practice = false, raceId = null, initialSnapshot = null, assignedCarId = null }) {
    this.stop();
    this.practice = Boolean(practice);
    this.isHost = Boolean(host);
    this.config = normalizeConfig(config);
    const safeEntries = (entries ?? []).map((entry) => ({
      ...entry,
      build: normalizeBuild(entry.build, { repairPoints: true })
    }));
    this.currentRaceId = raceId;
    this.track = generateTrack(this.config.seed, this.config.trackComplexity, this.config.environmentTheme);
    const expectedCarId = assignedCarId == null ? null : String(assignedCarId);
    const ownedEntries = safeEntries.filter((entry) => String(entry.userId ?? "") === String(game.user.id));
    const restoredAssignedCar = Array.isArray(initialSnapshot?.cars)
      ? initialSnapshot.cars.find((car) => String(car?.id ?? "") === expectedCarId)
      : null;
    const assignedCarAvailable = !restoredAssignedCar || (!restoredAssignedCar.abandoned && !restoredAssignedCar.isBot);
    this.localCarId = expectedCarId && assignedCarAvailable && ownedEntries.some((entry) => String(entry.id) === expectedCarId)
      ? expectedCarId
      : (!expectedCarId && ownedEntries.length === 1 ? String(ownedEntries[0].id) : null);
    this.controlConfirmed = Boolean(this.practice || host);
    this.pendingInitialSnapshot = initialSnapshot;
    this.resultsSent = false;
    this.lastInputSequence.clear();

    if (host && typeof Worker !== "undefined") this.#startWorker(safeEntries);
    else if (host) this.#startMainThreadSimulation(safeEntries);
  }

  restoreSnapshot(snapshot) {
    if (!snapshot) return;
    this.pendingInitialSnapshot = snapshot;
    this.currentSimulationSnapshot = snapshot;
    this.renderer?.pushSnapshot(snapshot);
    this.audio.update(snapshot);
  }

  mount(root) {
    const canvas = root?.querySelector("canvas[data-race-canvas]");
    if (!canvas || !this.track) return;
    this.#unmountView();
    try {
      this.pitUi.mount(root);
      this.hud.mount(root);
      this.audio.mount(root);
      this.renderer = new RaceRenderer(canvas, this.track, {
        localCarId: this.localCarId,
        onHud: (car, snapshot) => this.hud.update(car, snapshot),
        cameraMode: this.cameraMode,
        minimapEnabled: this.minimapEnabled,
        enableLocalPrediction: !this.practice && !this.isHost,
        networkRenderDelay: this.isHost ? 0.032 : 0.14,
        maxExtrapolation: this.isHost ? 0.10 : 0.30,
        performanceOverlay: this.performanceOverlay,
        smoothAuthoritativePresentation: Boolean(this.simulationWorker)
      });
      if (this.simulation) {
        const current = this.currentSimulationSnapshot ?? this.simulation.snapshot();
        const previous = this.previousSimulationSnapshot ?? current;
        this.renderer.setSimulationFrame(previous, current, 0);
      } else if (this.isHost && this.currentSimulationSnapshot) {
        this.renderer.pushSnapshot(this.currentSimulationSnapshot, { source: "worker" });
      } else if (this.pendingInitialSnapshot) {
        this.renderer.pushSnapshot(this.pendingInitialSnapshot);
      }

      this.input.mount(canvas, root);
      if (this.localCarId) {
        this.input.focus();
        if (this.practice || this.network.isHost) {
          if (this.simulationWorker) this.simulationWorker.postMessage({ type: "claim-control", carId: this.localCarId });
          else this.simulation?.claimControl(this.localCarId);
          this.controlConfirmed = true;
        } else {
          this.controlConfirmed = false;
          this.network.requestControlAssignment();
        }
      } else if (!this.practice) {
        ui.notifications.warn("Большие Гонки: для этого пользователя не найден собственный болид. Включён режим наблюдателя.");
      }
      this.lastFrameAt = performance.now();
      this.accumulator = 0;
      this.raceFrame = requestAnimationFrame(this.#raceLoop);
    } catch (error) {
      this.showError(error, root);
    }
  }

  handleRemoteInput(message) {
    const previous = this.lastInputSequence.get(message.carId) ?? -1;
    if (Number(message.sequence) <= previous) return;
    this.lastInputSequence.set(message.carId, Number(message.sequence));
    if (this.simulationWorker) this.simulationWorker.postMessage({ type: "input", carId: message.carId, input: message.input, sequence: message.sequence });
    else this.simulation?.setInput(message.carId, message.input, message.sequence);
  }

  handleClaimControl(message) {
    // Input sequence numbers are client-session local. Reclaiming a car opens a
    // new sequence window, so the host-side gate must forget the previous
    // session before the first fresh packet arrives.
    this.lastInputSequence.delete(message.carId);
    if (this.simulationWorker) this.simulationWorker.postMessage({ type: "claim-control", carId: message.carId });
    else this.simulation?.claimControl(message.carId);
  }

  handleControlAssignment(message) {
    if (!message || String(message.raceId ?? "") !== String(this.currentRaceId ?? "")) return;
    const carId = String(message.carId ?? "");
    if (!carId || carId !== String(this.localCarId ?? "")) return;
    this.controlConfirmed = true;
    this.renderer?.setLocalCarId(carId);
    this.network.claimControl(carId);
    this.input.dispatch(undefined, { force: true });
  }

  handleLeaveRace(message) {
    let handed = false;
    if (this.simulationWorker) {
      this.simulationWorker.postMessage({ type: "hand-to-bot", carId: message.carId, skill: 1 });
      handed = true;
    } else {
      handed = Boolean(this.simulation?.handToBot(message.carId, 1));
    }
    if (handed) ui.notifications.info(`${game.users?.get(message.userId)?.name ?? "Игрок"} покинул заезд. Управление болидом передано автоматону.`);
  }

  handlePitComplete(message) {
    if (this.simulationWorker) this.simulationWorker.postMessage({
      type: "pit-complete", carId: message.carId, word: message.word, attemptId: message.attemptId
    });
    else this.simulation?.completePitStop(message.carId, message.word, message.attemptId);
  }

  handleSnapshot(snapshot) {
    this.pendingInitialSnapshot = snapshot;
    this.currentSimulationSnapshot = snapshot;
    this.renderer?.pushSnapshot(snapshot);
    this.audio.update(snapshot);
  }

  sendNeutralInput() {
    return this.input.neutralize();
  }

  async setCameraMode(mode) {
    if (!["overview", "chase"].includes(mode)) return;
    this.cameraMode = mode;
    await game.settings.set(MODULE_ID, "cameraMode", mode);
    this.renderer?.setCameraMode(mode);
    const root = this.renderer?.canvas?.closest?.(".fbl-need-for-speed") ?? document;
    for (const button of root.querySelectorAll?.("[data-camera-mode]") ?? []) {
      const active = button.dataset.cameraMode === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    this.input.focus();
  }

  toggleCameraMode() {
    return this.setCameraMode(this.cameraMode === "overview" ? "chase" : "overview");
  }

  async toggleMinimap() {
    this.minimapEnabled = !this.minimapEnabled;
    await game.settings.set(MODULE_ID, "minimapEnabled", this.minimapEnabled);
    this.renderer?.setMinimapEnabled(this.minimapEnabled);
    const button = this.renderer?.canvas?.closest?.(".fbl-need-for-speed")?.querySelector?.("[data-action='toggle-minimap']");
    if (button) {
      button.classList.toggle("is-active", this.minimapEnabled);
      button.setAttribute("aria-pressed", String(this.minimapEnabled));
    }
    this.input.focus();
  }

  async copyPerformanceReport() {
    if (!this.renderer) {
      ui.notifications.warn("Большие Гонки: диагностический отчёт доступен только во время заезда.");
      return null;
    }
    const snapshot = this.currentSimulationSnapshot ?? this.pendingInitialSnapshot;
    const report = {
      generatedAt: new Date().toISOString(),
      module: { id: MODULE_ID, version: VERSION, protocol: PROTOCOL_VERSION },
      foundry: { version: String(game.version ?? game.release?.version ?? "unknown") },
      client: {
        userAgent: String(globalThis.navigator?.userAgent ?? "unknown"),
        devicePixelRatio: Number(globalThis.devicePixelRatio ?? 1),
        hardwareConcurrency: Number(globalThis.navigator?.hardwareConcurrency ?? 0),
        deviceMemoryGb: Number(globalThis.navigator?.deviceMemory ?? 0)
      },
      race: {
        raceId: this.currentRaceId,
        role: this.practice ? "practice-host" : this.isHost ? "multiplayer-host" : "multiplayer-client",
        localCarId: this.localCarId,
        cars: snapshot?.cars?.length ?? 0,
        tick: Number(snapshot?.tick) || 0,
        simulationTime: Number(snapshot?.simulationTime) || 0,
        config: { ...this.config }
      },
      renderer: this.renderer.getDiagnosticReport(),
      hud: this.hud.getDiagnosticStats(),
      audio: this.audio.getDiagnosticStats()
    };
    const text = `FBL Need for Speed diagnostic\n${JSON.stringify(report, null, 2)}`;
    try {
      if (globalThis.navigator?.clipboard?.writeText) await globalThis.navigator.clipboard.writeText(text);
      else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.append(textarea);
        textarea.select();
        const copied = document.execCommand?.("copy");
        textarea.remove();
        if (!copied) throw new Error("clipboard unavailable");
      }
      ui.notifications.info("Большие Гонки: диагностический отчёт скопирован в буфер обмена.");
    } catch (error) {
      console.info(text);
      ui.notifications.warn("Не удалось скопировать отчёт. Он выведен в консоль Foundry.");
    }
    this.input.focus();
    return text;
  }

  showError(error, root) {
    console.error("FBL Need for Speed | race runtime failed", error);
    const overlay = root?.querySelector("[data-race-error]");
    const text = root?.querySelector("[data-race-error-text]");
    this.stop({ preserveIdentity: true });
    if (text) text.textContent = error?.message || String(error || "Неизвестная ошибка");
    if (overlay) overlay.hidden = false;
    ui.notifications.error("Большие Гонки: не удалось запустить гонку. Ошибка показана в окне и консоли.");
  }

  destroy() {
    this.stop();
    this.audio.destroy();
  }

  stop({ preserveIdentity = false } = {}) {
    this.#unmountView();
    this.input.reset();
    if (this.hiddenTimer) window.clearInterval(this.hiddenTimer);
    this.hiddenTimer = null;
    this.hiddenWallAt = 0;
    this.hiddenAccumulator = 0;
    this.simulation = null;
    if (this.simulationWorker) {
      this.simulationWorker.removeEventListener("message", this.#onWorkerMessage);
      this.simulationWorker.removeEventListener("error", this.#onWorkerError);
      try { this.simulationWorker.postMessage({ type: "stop" }); } catch (_) { /* worker already closed */ }
      this.simulationWorker.terminate();
    }
    this.simulationWorker = null;
    this.workerReady = false;
    if (this.workerStartupTimer) window.clearTimeout(this.workerStartupTimer);
    this.workerStartupTimer = null;
    this.workerInitEntries = null;
    this.previousSimulationSnapshot = null;
    this.currentSimulationSnapshot = null;
    this.pendingInitialSnapshot = null;
    this.track = null;
    this.lastFrameAt = 0;
    this.accumulator = 0;
    this.lastSnapshotSent = 0;
    this.lastWorkerSnapshotAt = 0;
    this.resultsSent = false;
    this.lastInputSequence.clear();
    this.controlConfirmed = false;
    if (!preserveIdentity) {
      this.currentRaceId = null;
      this.localCarId = null;
      this.controlConfirmed = false;
      this.practice = false;
      this.isHost = false;
    }
  }

  #unmountView() {
    if (this.raceFrame) cancelAnimationFrame(this.raceFrame);
    this.raceFrame = null;
    this.renderer?.destroy();
    this.renderer = null;
    this.input.destroyListeners();
    this.hud.destroy();
    this.pitUi.destroy();
    this.audio.stop();
  }

  #startMainThreadSimulation(entries) {
    this.simulation = new RaceSimulation({
      track: this.track,
      entries,
      laps: this.config.laps,
      collisionMode: this.config.collisionMode,
      botDifficulty: this.config.botDifficulty,
      requiredPitStops: this.config.requiredPitStops
    });
    this.currentSimulationSnapshot = this.simulation.snapshot();
    this.previousSimulationSnapshot = this.currentSimulationSnapshot;
    this.pendingInitialSnapshot = this.currentSimulationSnapshot;
  }

  #startWorker(entries) {
    this.workerInitEntries = entries;
    try {
      this.simulationWorker = new Worker(new URL("../simulation-worker.js", import.meta.url), {
        type: "module",
        name: "fbl-need-for-speed-simulation"
      });
      this.workerReady = false;
      this.simulationWorker.addEventListener("message", this.#onWorkerMessage);
      this.simulationWorker.addEventListener("error", this.#onWorkerError);
      this.simulationWorker.postMessage({
        type: "init", raceId: this.currentRaceId, track: this.track, entries, config: this.config
      });
      this.workerStartupTimer = window.setTimeout(() => {
        if (!this.workerReady && this.simulationWorker) this.#fallbackWorker(new Error("Фоновая симуляция не ответила при запуске"));
      }, 2500);
    } catch (error) {
      this.#fallbackWorker(error);
    }
  }

  #fallbackWorker(error) {
    console.warn("FBL Need for Speed | simulation worker unavailable, falling back to main thread", error);
    if (this.workerStartupTimer) window.clearTimeout(this.workerStartupTimer);
    this.workerStartupTimer = null;
    if (this.simulationWorker) {
      this.simulationWorker.removeEventListener("message", this.#onWorkerMessage);
      this.simulationWorker.removeEventListener("error", this.#onWorkerError);
      this.simulationWorker.terminate();
    }
    this.simulationWorker = null;
    this.workerReady = false;
    this.#startMainThreadSimulation(this.workerInitEntries ?? []);
    this.renderer?.setSmoothAuthoritativePresentation(false);
    this.renderer?.setSimulationFrame(this.currentSimulationSnapshot, this.currentSimulationSnapshot, 0);
    ui.notifications.warn("Большие Гонки: Web Worker недоступен, симуляция продолжена в основном потоке.");
  }

  #onWorkerMessage = (event) => {
    const message = event.data ?? {};
    if (String(message.raceId ?? "") !== String(this.currentRaceId ?? "")) return;
    if (message.type === "ready") {
      this.workerReady = true;
      if (this.workerStartupTimer) window.clearTimeout(this.workerStartupTimer);
      this.workerStartupTimer = null;
      // Entries are already owned by the worker. Keeping the normalized builds
      // here doubled the retained race setup until teardown.
      this.workerInitEntries = null;
      return;
    }
    if (message.type === "error") {
      const error = new Error(message.message || "Ошибка фоновой симуляции");
      if (!this.workerReady) this.#fallbackWorker(error);
      else this.showError(error, this.renderer?.canvas?.closest?.(".fbl-need-for-speed"));
      return;
    }
    if ((message.type !== "snapshot" && message.type !== "finished") || !message.snapshot) return;
    const priorSnapshot = this.currentSimulationSnapshot;
    this.previousSimulationSnapshot = priorSnapshot ?? message.snapshot;
    this.currentSimulationSnapshot = message.snapshot;
    this.pendingInitialSnapshot = message.snapshot;
    this.audio.update(message.snapshot);
    const now = performance.now();
    this.lastWorkerSnapshotAt = now;
    // Worker snapshots are timestamped at production and enter the same bounded
    // presentation buffer as network frames. This decouples visible motion from
    // message-delivery jitter and prevents alpha from resetting on every packet.
    this.renderer?.pushSnapshot(message.snapshot, { source: "worker", generatedAt: message.generatedAt });
    if (!this.practice && this.network.isHost && now - this.lastSnapshotSent >= 1000 / SNAPSHOT_HZ) {
      this.lastSnapshotSent = now;
      this.network.sendSnapshot(message.snapshot);
    }
    if (message.type === "finished" && !this.resultsSent) this.#finish(message.snapshot);
  };

  #onWorkerError = (event) => {
    const error = event?.error ?? new Error(event?.message || "Фоновая симуляция остановлена");
    if (!this.workerReady) this.#fallbackWorker(error);
    else this.showError(error, this.renderer?.canvas?.closest?.(".fbl-need-for-speed"));
  };

  #submitLocalInput(input, sequence) {
    if (!this.localCarId) return;
    this.renderer?.setLocalInput(input, sequence);
    if (!this.practice && !this.network.isHost && !this.controlConfirmed) {
      this.network.requestControlAssignment();
      return;
    }
    if (this.simulationWorker) this.simulationWorker.postMessage({ type: "input", carId: this.localCarId, input, sequence });
    else if (this.simulation) this.simulation.setInput(this.localCarId, input, sequence);
    else this.network.sendInput(this.localCarId, input, sequence);
  }

  #completeLocalPit(word, attemptId) {
    if (!this.localCarId) return;
    if (this.simulationWorker) this.simulationWorker.postMessage({
      type: "pit-complete", carId: this.localCarId, word, attemptId
    });
    else if (this.simulation) this.simulation.completePitStop(this.localCarId, word, attemptId);
    else this.network.completePitStop(this.localCarId, word, attemptId);
  }

  #handleVisibility(hidden) {
    if (!this.isRaceActive()) return;
    this.audio.setSuspended(hidden);
    if (hidden) {
      if (this.raceFrame) cancelAnimationFrame(this.raceFrame);
      this.raceFrame = null;
      if (this.hiddenTimer) return;
      if (this.simulation) this.#startHiddenMainThreadClock();
      else this.hiddenTimer = window.setInterval(() => {
        if (this.isRaceActive() && this.localCarId) this.input.dispatch(neutralInput());
      }, 250);
      return;
    }
    if (this.hiddenTimer) window.clearInterval(this.hiddenTimer);
    this.hiddenTimer = null;
    this.hiddenWallAt = 0;
    this.hiddenAccumulator = 0;
    if (!this.raceFrame && this.isRaceActive()) {
      this.lastFrameAt = performance.now();
      this.accumulator = 0;
      this.raceFrame = requestAnimationFrame(this.#raceLoop);
    }
  }

  #startHiddenMainThreadClock() {
    const fixedDt = 1 / PHYSICS_HZ;
    this.hiddenWallAt = performance.now();
    this.hiddenAccumulator = 0;
    this.hiddenTimer = window.setInterval(() => {
      try {
        if (!this.simulation || !this.isRaceActive()) return;
        const now = performance.now();
        const elapsed = Math.min(2, Math.max(0, (now - this.hiddenWallAt) / 1000));
        this.hiddenWallAt = now;
        this.hiddenAccumulator += elapsed;
        let steps = 0;
        const previous = this.currentSimulationSnapshot ?? this.simulation.snapshot();
        while (this.hiddenAccumulator >= fixedDt && steps < PHYSICS_HZ * 2) {
          this.input.dispatch(neutralInput());
          this.simulation.step(fixedDt);
          this.hiddenAccumulator -= fixedDt;
          steps += 1;
        }
        if (steps > 0) {
          this.previousSimulationSnapshot = previous;
          this.currentSimulationSnapshot = this.simulation.snapshot();
        }
        if (steps >= PHYSICS_HZ * 2) this.hiddenAccumulator = Math.min(this.hiddenAccumulator, fixedDt);
        if (!this.practice && this.network.isHost && now - this.lastSnapshotSent >= 1000 / SNAPSHOT_HZ) {
          this.lastSnapshotSent = now;
          this.network.sendSnapshot(this.currentSimulationSnapshot);
        }
        if (this.simulation.finished && !this.resultsSent) this.#finish(this.currentSimulationSnapshot);
      } catch (error) {
        console.error("FBL Need for Speed | hidden simulation failed", error);
      }
    }, 100);
  }

  #raceLoop = (time) => {
    if (!this.isRaceActive()) return;
    if (document.hidden) {
      this.#handleVisibility(true);
      return;
    }
    try {
      const elapsed = Math.min(0.1, (time - this.lastFrameAt) / 1000);
      this.lastFrameAt = time;
      this.input.dispatch();
      if (this.simulationWorker && this.currentSimulationSnapshot) {
        this.audio.update(this.currentSimulationSnapshot);
      }
      if (this.simulation) {
        this.accumulator += elapsed;
        const fixedDt = 1 / PHYSICS_HZ;
        let steps = 0;
        const previous = this.currentSimulationSnapshot ?? this.simulation.snapshot();
        while (this.accumulator >= fixedDt && steps < 6) {
          this.simulation.step(fixedDt);
          this.accumulator -= fixedDt;
          steps += 1;
        }
        if (steps > 0) {
          this.previousSimulationSnapshot = previous;
          this.currentSimulationSnapshot = this.simulation.snapshot();
        }
        const snapshot = this.currentSimulationSnapshot ?? previous;
        this.audio.update(snapshot);
        this.renderer?.setSimulationFrame(this.previousSimulationSnapshot ?? snapshot, snapshot, this.accumulator / fixedDt);
        if (!this.practice && this.network.isHost && time - this.lastSnapshotSent >= 1000 / SNAPSHOT_HZ) {
          this.lastSnapshotSent = time;
          this.network.sendSnapshot(snapshot);
        }
        if (this.simulation.finished && !this.resultsSent) {
          this.renderer?.render(time);
          this.#finish(snapshot);
          return;
        }
      }
      this.renderer?.render(time);
      this.raceFrame = requestAnimationFrame(this.#raceLoop);
    } catch (error) {
      this.showError(error, this.renderer?.canvas?.closest?.(".fbl-need-for-speed"));
    }
  };

  #finish(snapshot) {
    if (this.resultsSent) return;
    this.resultsSent = true;
    const results = this.buildResults(snapshot);
    if (this.practice) this.onFinished(results);
    else this.network.sendResults(results);
  }

  buildResults(snapshot) {
    return {
      seed: this.config.seed,
      laps: this.config.laps,
      cars: [...(snapshot?.cars ?? [])]
        .sort((a, b) => {
          if (a.finished && b.finished) return a.finishTime - b.finishTime;
          if (a.finished) return -1;
          if (b.finished) return 1;
          return a.place - b.place;
        })
        .map((car) => ({
          id: car.id,
          name: car.name,
          driverName: car.driverName,
          isBot: car.isBot,
          finishTime: car.finishTime,
          finished: car.finished,
          health: car.health,
          maxHealth: car.maxHealth,
          pitStopsCompleted: car.pitStopsCompleted,
          pitStopsRequired: car.pitStopsRequired
        }))
    };
  }
}
