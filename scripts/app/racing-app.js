// @ts-check

import { MODULE_ID } from "../constants.js";
import { GarageController } from "./garage-controller.js";
import { LobbyController } from "./lobby-controller.js";
import { RaceRuntime } from "./race-runtime.js";
import { ScreenStateMachine, formatTime } from "./app-helpers.js";
import { TooltipController } from "./tooltip-controller.js";
import { ViewState } from "./view-state.js";
import { playUiClick } from "./sound-manager.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class BigRacesApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "fbl-need-for-speed-app",
    classes: ["fbl-need-for-speed"],
    tag: "section",
    window: {
      title: "Большие Гонки",
      icon: "fas fa-flag-checkered",
      resizable: true,
      minimizable: true
    },
    position: { width: 1040, height: 720 }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/app.hbs` }
  };

  constructor(network, options = {}) {
    super(options);
    this.network = network;
    this.screenStateMachine = new ScreenStateMachine("garage");
    this.garage = new GarageController({ network });
    this.lobby = new LobbyController({ network });
    this.results = null;
    this.viewState = new ViewState();
    this.viewGeneration = 0;
    this.launchRequest = 0;
    this.hostOffline = false;
    this.closing = false;
    this.closeConfirmed = false;
    this.renderAbortController = null;
    this.networkUnsubscribers = [];
    this.joinPending = false;
    this.resumeRequested = false;
    this.viewingNetworkRace = false;
    this.dismissedRaceId = null;
    this.tooltips = new TooltipController();
    this.runtime = new RaceRuntime({
      network,
      isRaceActive: () => this.screenStateMachine.is("race"),
      onFinished: (results) => this.#showResults(results)
    });
    this.#bindNetwork();
  }

  get screen() {
    return this.screenStateMachine.current;
  }

  _replaceHTML(result, content, options) {
    // Capture at replacement, after async template work, so typing and scroll
    // changes made while a render was queued are not overwritten by old state.
    this.viewState?.capture(this.element);
    return super._replaceHTML(result, content, options);
  }

  #setScreen(screen, options = {}) {
    const previous = this.screen;
    const changed = this.screenStateMachine.transition(screen, options);
    if (changed && previous !== this.screen) this.viewGeneration++;
    return changed;
  }

  #bindNetwork() {
    this.networkUnsubscribers.push(
      this.network.on("lobby", (lobby) => {
        if (this.screenStateMachine.is("race") || this.screenStateMachine.is("results")) return;
        const participates = Boolean(lobby?.participants?.[game.user.id]);
        if (!lobby && this.screenStateMachine.is("lobby")) this.#setScreen("garage");
        else if (lobby && this.joinPending && participates) {
          this.joinPending = false;
          this.#setScreen("lobby");
        }
        if (!this.closing && this.rendered && (this.screenStateMachine.is("lobby") || !lobby)) this.render({ force: true });
      }),
      this.network.on("start", (race) => this.#startMultiplayerRace(race)),
      this.network.on("raceState", (state) => this.#restoreRaceState(state)),
      this.network.on("input", (message) => { if (this.#ownsNetworkRuntime()) this.runtime.handleRemoteInput(message); }),
      this.network.on("claimControl", (message) => { if (this.#ownsNetworkRuntime()) this.runtime.handleClaimControl(message); }),
      this.network.on("controlAssignment", (message) => { if (this.#ownsNetworkRuntime()) this.runtime.handleControlAssignment(message); }),
      this.network.on("leaveRace", (message) => { if (this.#ownsNetworkRuntime()) this.runtime.handleLeaveRace(message); }),
      this.network.on("pitComplete", (message) => { if (this.#ownsNetworkRuntime()) this.runtime.handlePitComplete(message); }),
      this.network.on("snapshot", (snapshot) => { if (this.#ownsNetworkRuntime()) this.runtime.handleSnapshot(snapshot); }),
      this.network.on("timing", (timing) => { if (this.#ownsNetworkRuntime()) this.runtime.renderer?.setNetworkTiming(timing); }),
      this.network.on("results", (results) => { if (this.#ownsNetworkRuntime()) this.#showResults(results); }),
      this.network.on("hostStatus", ({ offline }) => {
        this.hostOffline = offline;
        if (this.#ownsNetworkRuntime() || this.screenStateMachine.is("lobby")) {
          if (offline) ui.notifications.warn("Связь с ведущим потеряна. Дождитесь его возвращения; если заезд не восстановится, ГМ может сбросить его в лобби.");
          else ui.notifications.info("Связь с ведущим Больших Гонок восстановлена.");
        }
        if (this.screenStateMachine.is("lobby") && this.rendered) this.render({ force: true });
      }),
      this.network.on("stop", () => {
        if (this.runtime.practice || !this.viewingNetworkRace) return;
        this.viewingNetworkRace = false;
        this.runtime.stop();
        this.#setScreen(this.network.lobby ? "lobby" : "garage");
        if (!this.closing && this.rendered) this.render({ force: true });
      })
    );
  }

  #ownsNetworkRuntime() {
    return this.viewingNetworkRace && !this.runtime.practice
      && this.runtime.currentRaceId === this.network.raceId;
  }

  /** Present only intended sessions. Leaving a race suppresses state replies for
   * that race until explicit resume, while a different race can still be joined.
   */
  #shouldPresentRace(race) {
    if (this.runtime.practice) return false;
    if ((race?.sessionId ?? race?.raceId) === this.dismissedRaceId && !this.resumeRequested && !this.viewingNetworkRace) return false;
    return this.resumeRequested || this.viewingNetworkRace
      || Boolean(race?.controlAssignments?.[game.user.id] && this.network.participant);
  }

  #dismissRaceView() {
    if (this.viewingNetworkRace) this.dismissedRaceId = this.network.activeRace?.sessionId ?? this.network.raceId ?? this.runtime.currentRaceId;
    this.viewingNetworkRace = false;
    this.resumeRequested = false;
  }

  async _prepareContext(options) {
    return {
      screenName: this.screen,
      viewScope: this.screen === "lobby" ? this.network.lobby?.id ?? "empty"
        : this.screen === "race" ? this.runtime.currentRaceId ?? "empty" : this.screen,
      isGarage: this.screenStateMachine.is("garage"),
      isLobby: this.screenStateMachine.is("lobby"),
      isRace: this.screenStateMachine.is("race"),
      isResults: this.screenStateMachine.is("results"),
      ...this.garage.getContext(),
      ...this.lobby.getContext(this.hostOffline),
      ...this.runtime.getContext(),
      raceExitLabel: this.runtime.practice ? "В гараж" : this.network.isHost ? "Остановить общий заезд" : this.runtime.localCarId ? "Передать болид автоматону" : "Выйти из наблюдения",
      results: this.results,
      formattedResults: (this.results?.cars ?? []).map((car, index) => ({
        ...car,
        place: index + 1,
        timeText: formatTime(car.finishTime)
      }))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    this.renderAbortController?.abort();
    this.renderAbortController = new AbortController();
    const signal = this.renderAbortController.signal;
    root.addEventListener("click", this.#onRootClick, { signal });
    this.tooltips.mount(root);
    this.garage.bind(root, signal);
    this.lobby.bind(root, signal);
    if (this.screenStateMachine.is("race")) this.runtime.mount(root);
    this.viewState.restore(root);
  }

  async close(options = {}) {
    if (this.screenStateMachine.is("race") && !this.runtime.practice && this.network.isHost && !this.closeConfirmed) {
      const confirmed = await this.#confirmStopRace();
      if (!confirmed) return this;
      this.closeConfirmed = true;
    }
    return super.close(options);
  }

  async _preClose(options) {
    // stopRace synchronously broadcasts stop/lobby events. Mark closing before
    // them, or those handlers queue a forced render behind Foundry's close.
    this.closing = true;
    this.viewGeneration++;
    if (!this.runtime.practice) this.#dismissRaceView();
    if (this.screenStateMachine.is("race") && !this.runtime.practice) {
      if (this.network.isHost) this.network.stopRace();
      else if (this.runtime.localCarId) this.runtime.sendNeutralInput();
    }
    this.renderAbortController?.abort();
    this.renderAbortController = null;
    this.tooltips.destroy();
    this.runtime.stop();
    await super._preClose(options);
  }

  async _onClose(options) {
    this.runtime.stop();
    this.#setScreen(this.network.lobby ? "lobby" : "garage", { force: true });
    await super._onClose(options);
    this.closing = false;
    this.closeConfirmed = false;
  }

  shutdown() {
    this.viewGeneration++;
    this.renderAbortController?.abort();
    this.tooltips.destroy({ removeElement: true });
    this.runtime.destroy();
    for (const unsubscribe of this.networkUnsubscribers.splice(0)) unsubscribe();
  }

  #onRootClick = (event) => {
    const button = event.target?.closest?.("[data-action]");
    if (!button || !this.element?.contains(button)) return;
    event.preventDefault();
    playUiClick();
    void this.#onAction(button.dataset.action).catch(error => {
      console.error("FBL Need for Speed | действие интерфейса не выполнено", error);
      ui.notifications.error("Не удалось выполнить действие. Подробности записаны в консоль Foundry.");
    });
  };

  async #saveForLaunch() {
    const request = ++this.launchRequest, view = this.viewGeneration;
    const lobbyId = this.network.lobby?.id, phase = this.network.lobby?.phase, raceId = this.network.raceId;
    const saved = await this.garage.saveFromForm(this.element, false);
    // Saving may finish after navigation, close, another launch, or a host's
    // race transition. Keep the saved build, discard only the obsolete launch.
    return saved && this.rendered && !this.closing && view === this.viewGeneration && request === this.launchRequest
      && lobbyId === this.network.lobby?.id && phase === this.network.lobby?.phase && raceId === this.network.raceId ? saved : false;
  }

  async #onAction(action) {
    switch (action) {
      case "show-garage":
        if (this.screenStateMachine.is("race")) return;
        this.#dismissRaceView();
        this.#setScreen("garage");
        this.render({ force: true });
        break;
      case "show-lobby":
        if (this.screenStateMachine.is("race")) return;
        this.#dismissRaceView();
        this.garage.readFromForm(this.element);
        this.#setScreen("lobby");
        this.network.requestState();
        this.render({ force: true });
        break;
      case "save-build":
        await this.garage.saveFromForm(this.element);
        break;
      case "practice": {
        const saved = await this.#saveForLaunch();
        if (saved) this.#startPractice(saved);
        break;
      }
      case "create-lobby": {
        const saved = await this.#saveForLaunch();
        if (!saved) return;
        if (!this.network.createLobby({ build: saved, config: this.lobby.config })) {
          ui.notifications.warn("В мире уже существует активное лобби.");
          this.#setScreen("lobby");
          this.network.requestState();
        } else this.#setScreen("lobby");
        this.render({ force: true });
        break;
      }
      case "join-lobby": {
        const saved = await this.#saveForLaunch();
        if (saved) {
          this.joinPending = true;
          this.network.join(saved);
        }
        break;
      }
      case "leave-lobby":
        this.network.leave();
        break;
      case "close-lobby":
        this.network.closeLobby();
        this.#setScreen("garage");
        this.render({ force: true });
        break;
      case "recover-host":
        if (this.network.recoverOrphanedSession()) {
          ui.notifications.warn("Управление осиротевшим лобби передано текущему ГМу. Активная гонка, если она шла, остановлена безопасно.");
          this.#setScreen("lobby");
          this.render({ force: true });
        }
        break;
      case "start-race":
        this.lobby.startLobbyRace(this.element);
        break;
      case "resume-race":
        this.resumeRequested = true;
        this.network.requestState();
        break;
      case "camera-overview":
        await this.runtime.setCameraMode("overview");
        break;
      case "camera-chase":
        await this.runtime.setCameraMode("chase");
        break;
      case "toggle-minimap":
        await this.runtime.toggleMinimap();
        break;
      case "copy-performance-report":
        await this.runtime.copyPerformanceReport();
        break;
      case "resume-driving": {
        const help = this.element?.querySelector(".nfs-controls-help");
        if (help) help.open = false;
        this.runtime.input.restoreFocus();
        break;
      }
      case "abandon-race":
        await this.#abandonRace();
        break;
      case "results-lobby":
        this.#dismissRaceView();
        this.results = null;
        this.#setScreen(this.network.lobby ? "lobby" : "garage");
        if (this.network.isHost && this.network.lobby) this.network.stopRace();
        this.render({ force: true });
        break;
      default:
        break;
    }
  }

  #startPractice(build = this.garage.build) {
    this.viewingNetworkRace = false;
    this.resumeRequested = false;
    const { config, entries } = this.lobby.createPractice(build);
    this.runtime.start({
      config,
      entries,
      host: true,
      practice: true,
      raceId: `practice-${Date.now().toString(36)}`
    });
    this.results = null;
    this.#setScreen("race");
    this.render({ force: true });
  }

  #startMultiplayerRace(race) {
    if (!this.#shouldPresentRace(race)) return;
    this.viewingNetworkRace = true;
    this.resumeRequested = false;
    this.runtime.start({
      config: race.config,
      entries: race.entries,
      host: this.network.isHost,
      allowLocalControl: !this.network.isSecondaryHost,
      practice: false,
      raceId: race.raceId,
      assignedCarId: race.controlAssignments?.[String(game.user.id)] ?? null
    });
    this.results = null;
    this.#setScreen("race");
    this.render({ force: true });
  }

  #restoreRaceState(raceState = {}) {
    const { race, snapshot, results } = raceState ?? {};
    if (!race || !this.#shouldPresentRace(race)) return;
    this.resumeRequested = false;
    this.viewingNetworkRace = true;
    if (race.phase === "results" && results) {
      this.#showResults(results);
      return;
    }
    if (race.phase !== "race") return;
    if (this.screenStateMachine.is("race") && this.runtime.currentRaceId === race.raceId) {
      this.runtime.restoreSnapshot(snapshot);
      return;
    }
    this.runtime.start({
      config: race.config,
      entries: race.entries,
      host: this.network.isHost,
      allowLocalControl: !this.network.isSecondaryHost,
      practice: false,
      raceId: race.raceId,
      initialSnapshot: snapshot,
      checkpoint: this.network.isHost ? this.network.takeRecoveryCheckpoint(race.raceId) : null,
      assignedCarId: race.controlAssignments?.[String(game.user.id)] ?? null
    });
    this.results = null;
    this.#setScreen("race");
    this.render({ force: true });
  }

  #showResults(results) {
    this.runtime.stop();
    this.results = results;
    this.#setScreen("results");
    if (!this.closing) this.render({ force: true });
  }

  async #abandonRace() {
    if (this.runtime.practice) {
      this.runtime.stop();
      this.#setScreen("garage");
      this.render({ force: true });
      return;
    }
    if (this.network.isHost) {
      if (await this.#confirmStopRace()) this.network.stopRace();
      return;
    }
    const raceId = this.runtime.currentRaceId;
    const carId = this.runtime.localCarId;
    const wasDriver = Boolean(carId);
    if (wasDriver && !(await foundry.applications.api.DialogV2.confirm({
      window: { title: "Передать болид автоматону?" },
      content: "<p>Вернуть ручное управление в этом заезде уже не получится. Чтобы временно скрыть окно, используйте сворачивание.</p>",
      yes: { label: "Передать болид" }, no: { label: "Остаться" }, rejectClose: false, modal: true
    }))) return;
    if (this.runtime.practice || this.runtime.currentRaceId !== raceId
      || this.runtime.localCarId !== carId || this.network.isHost) return;
    this.viewingNetworkRace = false;
    this.dismissedRaceId = this.network.activeRace?.sessionId ?? this.runtime.currentRaceId;
    this.runtime.sendNeutralInput();
    if (wasDriver) this.network.leaveRace(carId);
    this.runtime.stop();
    this.#setScreen(this.network.lobby ? "lobby" : "garage");
    this.render({ force: true });
    ui.notifications.info(wasDriver ? "Вы покинули заезд. Болид передан автоматону." : "Наблюдение завершено.");
  }

  async #confirmStopRace() {
    const raceId = this.runtime.currentRaceId;
    const carId = this.runtime.localCarId;
    const DialogV2 = foundry.applications.api.DialogV2;
    let confirmed;
    if (DialogV2?.confirm) {
      confirmed = await DialogV2.confirm({
        window: { title: "Завершить общий заезд?" },
        content: "<p>Гонка завершится для всех участников. Результаты текущего заезда не будут сохранены.</p>",
        yes: { label: "Завершить", icon: "fas fa-flag" },
        no: { label: "Остаться", icon: "fas fa-xmark" },
        rejectClose: false,
        modal: true
      });
    } else confirmed = window.confirm("Завершить общий заезд для всех участников?");
    return Boolean(confirmed && !this.runtime.practice && this.network.isHost
      && this.runtime.currentRaceId === raceId && this.runtime.localCarId === carId);
  }
}
