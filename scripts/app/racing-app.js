// @ts-check

import { MODULE_ID } from "../constants.js";
import { GarageController } from "./garage-controller.js";
import { LobbyController } from "./lobby-controller.js";
import { RaceRuntime } from "./race-runtime.js";
import { ScreenStateMachine, formatTime } from "./app-helpers.js";
import { TooltipController } from "./tooltip-controller.js";
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
    position: { width: 1180, height: 760 }
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
    this.hostOffline = false;
    this.closing = false;
    this.closeConfirmed = false;
    this.renderAbortController = null;
    this.networkUnsubscribers = [];
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

  #setScreen(screen, options = {}) {
    return this.screenStateMachine.transition(screen, options);
  }

  #bindNetwork() {
    this.networkUnsubscribers.push(
      this.network.on("lobby", (lobby) => {
        if (this.screenStateMachine.is("race") || this.screenStateMachine.is("results")) return;
        const participates = Boolean(lobby?.participants?.[game.user.id]);
        if (!lobby && this.screenStateMachine.is("lobby")) this.#setScreen("garage");
        else if (lobby && (this.screenStateMachine.is("lobby") || participates)) this.#setScreen("lobby");
        if (!this.closing && this.rendered && (this.screenStateMachine.is("lobby") || !lobby)) this.render({ force: true });
      }),
      this.network.on("start", (race) => this.#startMultiplayerRace(race)),
      this.network.on("raceState", (state) => this.#restoreRaceState(state)),
      this.network.on("input", (message) => this.runtime.handleRemoteInput(message)),
      this.network.on("claimControl", (message) => this.runtime.handleClaimControl(message)),
      this.network.on("controlAssignment", (message) => this.runtime.handleControlAssignment(message)),
      this.network.on("leaveRace", (message) => this.runtime.handleLeaveRace(message)),
      this.network.on("pitComplete", (message) => this.runtime.handlePitComplete(message)),
      this.network.on("snapshot", (snapshot) => this.runtime.handleSnapshot(snapshot)),
      this.network.on("results", (results) => this.#showResults(results)),
      this.network.on("hostStatus", ({ offline }) => {
        this.hostOffline = offline;
        if (offline) ui.notifications.warn("Связь с ведущим Больших Гонок потеряна. Заезд ожидает его возвращения.");
        else ui.notifications.info("Связь с ведущим Больших Гонок восстановлена.");
        if (this.screenStateMachine.is("lobby") && this.rendered) this.render({ force: true });
      }),
      this.network.on("stop", () => {
        this.runtime.stop();
        this.#setScreen(this.network.lobby ? "lobby" : "garage");
        if (!this.closing && this.rendered) this.render({ force: true });
      })
    );
  }

  async _prepareContext(options) {
    return {
      isGarage: this.screenStateMachine.is("garage"),
      isLobby: this.screenStateMachine.is("lobby"),
      isRace: this.screenStateMachine.is("race"),
      isResults: this.screenStateMachine.is("results"),
      ...this.garage.getContext(),
      ...this.lobby.getContext(this.hostOffline),
      ...this.runtime.getContext(),
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
    if (this.screenStateMachine.is("race") && !this.runtime.practice) {
      if (this.network.isHost) this.network.stopRace();
      else if (this.runtime.localCarId) this.runtime.sendNeutralInput();
    }
    this.closing = true;
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
    void this.#onAction(button.dataset.action);
  };

  async #onAction(action) {
    switch (action) {
      case "show-garage":
        if (this.screenStateMachine.is("race")) return;
        this.#setScreen("garage");
        this.render({ force: true });
        break;
      case "show-lobby":
        if (this.screenStateMachine.is("race")) return;
        this.#setScreen("lobby");
        this.network.requestState();
        this.render({ force: true });
        break;
      case "save-build":
        await this.garage.saveFromForm(this.element);
        break;
      case "practice":
        if (await this.garage.saveFromForm(this.element, false)) this.#startPractice();
        break;
      case "create-lobby":
        if (!(await this.garage.saveFromForm(this.element, false))) return;
        if (!this.network.createLobby({ build: this.garage.build, config: this.lobby.config })) {
          ui.notifications.warn("В мире уже существует активное лобби.");
          this.#setScreen("lobby");
          this.network.requestState();
        } else this.#setScreen("lobby");
        this.render({ force: true });
        break;
      case "join-lobby":
        if (await this.garage.saveFromForm(this.element, false)) this.network.join(this.garage.build);
        break;
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
      case "abandon-race":
        await this.#abandonRace();
        break;
      case "results-lobby":
        this.results = null;
        this.#setScreen(this.network.lobby ? "lobby" : "garage");
        if (this.network.isHost && this.network.lobby) this.network.stopRace();
        this.render({ force: true });
        break;
      default:
        break;
    }
  }

  #startPractice() {
    const { config, entries } = this.lobby.createPractice(this.garage.build);
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
    this.runtime.start({
      config: race.config,
      entries: race.entries,
      host: race.hostId === game.user.id,
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
    if (!race) return;
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
      host: race.hostId === game.user.id,
      practice: false,
      raceId: race.raceId,
      initialSnapshot: snapshot,
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
    this.runtime.sendNeutralInput();
    if (this.runtime.localCarId) this.network.leaveRace(this.runtime.localCarId);
    this.runtime.stop();
    this.#setScreen(this.network.lobby ? "lobby" : "garage");
    this.render({ force: true });
    ui.notifications.info("Вы покинули заезд. Болид передан автоматону.");
  }

  async #confirmStopRace() {
    const DialogV2 = foundry.applications.api.DialogV2;
    if (DialogV2?.confirm) {
      return DialogV2.confirm({
        window: { title: "Завершить общий заезд?" },
        content: "<p>Гонка завершится для всех участников. Результаты текущего заезда не будут сохранены.</p>",
        yes: { label: "Завершить", icon: "fas fa-flag" },
        no: { label: "Остаться", icon: "fas fa-xmark" },
        rejectClose: false,
        modal: true
      });
    }
    return window.confirm("Завершить общий заезд для всех участников?");
  }
}
