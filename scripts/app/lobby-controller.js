// @ts-check

import { DEFAULT_CONFIG, CAR_COLORS, MAX_RACE_ENTRIES } from "../constants.js";
import { PARTS, DRIVER_SPECIALIZATIONS, DRIVER_TALENTS, cloneDefaultBuild, normalizeBuild } from "../catalog.js";
import { normalizeConfig } from "../network.js";
import { clamp } from "./app-helpers.js";

export class LobbyController {
  constructor({ network }) {
    this.network = network;
    this.config = foundry.utils.deepClone(DEFAULT_CONFIG);
  }

  getContext(hostOffline = false) {
    const lobby = this.network.lobby;
    const participants = Object.values(lobby?.participants ?? {}).map((participant) => ({
      ...participant,
      bolidName: participant.build?.name || "Безымянный болид",
      driverName: participant.build?.driver?.name || participant.userName,
      isSelf: participant.userId === game.user.id,
      isHost: participant.userId === lobby?.hostId
    }));
    return {
      lobby,
      hasLobby: Boolean(lobby),
      isHost: this.network.isHost,
      isParticipant: Boolean(this.network.participant),
      isLobbyRacing: lobby?.phase === "race",
      isLobbyResults: lobby?.phase === "results",
      hostOffline,
      canRecoverHost: Boolean(hostOffline && game.user.isGM),
      recoverHostLabel: lobby?.phase === "race" ? "Сбросить зависший заезд" : "Принять управление",
      lobbyPhaseLabel: ({ lobby: "Подготовка", race: "Идёт гонка", results: "Результаты" })[lobby?.phase] ?? "Неизвестно",
      participants,
      config: lobby?.config ?? this.config
    };
  }

  bind(root, signal) {
    root.querySelector("form[data-form='lobby-config']")?.addEventListener("change", () => this.updateConfigFromForm(root), { signal });
  }

  updateConfigFromForm(root) {
    const form = root?.querySelector("form[data-form='lobby-config']");
    if (!(form instanceof HTMLFormElement) || !this.network.isHost) return this.config;
    const data = new FormData(form);
    this.config = normalizeConfig({
      seed: data.get("seed"),
      laps: data.get("laps"),
      bots: data.get("bots"),
      botDifficulty: data.get("botDifficulty"),
      trackComplexity: data.get("trackComplexity"),
      environmentTheme: data.get("environmentTheme"),
      requiredPitStops: data.get("requiredPitStops"),
      collisionMode: data.get("collisionMode")
    });
    this.network.updateConfig(this.config);
    return this.config;
  }

  createPractice(build) {
    const config = normalizeConfig({ ...this.config, seed: Date.now() % 1000000 });
    return {
      config,
      entries: [
        {
          id: `player-${game.user.id}`,
          userId: game.user.id,
          name: build.name,
          build: normalizeBuild(build, { repairPoints: true }),
          color: CAR_COLORS[0],
          isBot: false
        },
        ...this.createBotEntries(config.bots, config.botDifficulty, 1, config.seed)
      ]
    };
  }

  startLobbyRace(root) {
    if (!this.network.isHost || !this.network.lobby || this.network.lobby.phase !== "lobby") return false;
    this.updateConfigFromForm(root);
    const participants = Object.values(this.network.lobby.participants).slice(0, MAX_RACE_ENTRIES);
    if (!participants.length) {
      ui.notifications.warn("В лобби нет гонщиков.");
      return false;
    }
    const entries = participants.map((participant, index) => ({
      id: `player-${participant.userId}`,
      userId: participant.userId,
      name: participant.build?.name || participant.userName,
      build: normalizeBuild(participant.build, { repairPoints: true }),
      color: CAR_COLORS[index % CAR_COLORS.length],
      isBot: false
    }));
    const botCount = Math.min(this.network.lobby.config.bots, Math.max(0, MAX_RACE_ENTRIES - entries.length));
    entries.push(...this.createBotEntries(botCount, this.network.lobby.config.botDifficulty, entries.length, this.network.lobby.config.seed));
    return this.network.startRace(entries);
  }

  createBotEntries(count, difficulty, colorOffset = 0, raceSeed = 0) {
    const names = ["Медная Комета", "Шальной Резонанс", "Третий Зуб", "Жёлтый Шершень", "Грохот", "Пепельная Игла", "Старая Клятва", "Синяя Ртуть", "Костолом", "Тихий Хор", "Сажа", "Полуденный Ветер"];
    const frames = PARTS.frame.map((entry) => entry.id);
    const cores = PARTS.core.map((entry) => entry.id);
    const transmissions = PARTS.transmission.map((entry) => entry.id);
    const steerings = PARTS.steering.map((entry) => entry.id);
    const runnings = PARTS.running.map((entry) => entry.id);
    const bodies = PARTS.body.map((entry) => entry.id);
    const modules = PARTS.module.slice(1).map((entry) => entry.id);
    const specializations = DRIVER_SPECIALIZATIONS.map((entry) => entry.id);
    const talents = DRIVER_TALENTS.map((entry) => entry.id);
    const pointProfiles = {
      1: [3, 3, 4, 2, 4],
      2: [3, 4, 3, 3, 3],
      3: [4, 4, 3, 3, 2],
      4: [6, 6, 2, 1, 1]
    };
    const eliteBuilds = [
      {
        frame: "arrow", core: "needle", transmission: "long", steering: "precision",
        running: "grip", body: "streamlined", module: "capacitor",
        specialization: "speedster", talents: ["late-brake", "smooth"]
      },
      {
        frame: "spider", core: "choir", transmission: "adaptive", steering: "quick",
        running: "grip", body: "short", module: "cooler",
        specialization: "technician", talents: ["smooth", "timing"]
      },
      {
        frame: "allantry", core: "wild", transmission: "adaptive", steering: "precision",
        running: "sport", body: "streamlined", module: "cooler",
        specialization: "veteran", talents: ["clean-start", "last-lap"]
      }
    ];

    return Array.from({ length: count }, (_, index) => {
      const base = cloneDefaultBuild();
      const pick = (array, salt = 0) => array[(index * 3 + salt * 5 + difficulty) % array.length];
      base.name = names[index % names.length];
      const skill = clamp(Number(difficulty) || 2, 1, 4);
      const elite = eliteBuilds[index % eliteBuilds.length];
      if (skill === 4) {
        base.frame = elite.frame;
        base.core = elite.core;
        base.transmission = elite.transmission;
        base.steering = elite.steering;
        base.running = elite.running;
        base.body = elite.body;
        base.module = elite.module;
      } else {
        base.frame = pick(frames, 1);
        base.core = pick(cores, 2);
        base.transmission = pick(transmissions, 3);
        base.steering = pick(steerings, 4);
        base.running = pick(runnings, 5);
        base.body = pick(bodies, 6);
        base.module = pick(modules, 7);
      }
      const profile = pointProfiles[skill];
      const rotated = skill === 4 ? profile : profile.map((_, statIndex) => profile[(statIndex + index) % profile.length]);
      const firstTalent = pick(talents, 9);
      let secondTalent = pick(talents, 10);
      if (secondTalent === firstTalent) secondTalent = talents[(talents.indexOf(firstTalent) + 1) % talents.length];
      base.driver = {
        name: `Автоматон ${index + 1}`,
        reflexes: rotated[0], technique: rotated[1], composure: rotated[2], aggression: rotated[3], attunement: rotated[4],
        specialization: skill === 4 ? elite.specialization : pick(specializations, 8),
        talents: skill === 4 ? elite.talents : [firstTalent, secondTalent]
      };
      const safeBuild = normalizeBuild(base, { repairPoints: true });
      return {
        id: `bot-${index}-${String(raceSeed).replace(/\W/g, "").slice(-8)}`,
        userId: null,
        name: safeBuild.name,
        build: safeBuild,
        color: CAR_COLORS[(index + colorOffset) % CAR_COLORS.length],
        isBot: true,
        botSkill: skill,
        botSeed: `${raceSeed}:${index}:${difficulty}`
      };
    });
  }
}
