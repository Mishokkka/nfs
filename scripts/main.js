import { MODULE_ID, VERSION } from "./constants.js";
import { RaceNetwork } from "./network.js";
import { BigRacesApp } from "./app.js";
import { DEFAULT_SOUND_PATHS } from "./app/sound-manager.js";

let network = null;
let app = null;
let initialized = false;

function ensureModuleInitialized() {
  network ??= new RaceNetwork();
  network.initialize();
  if (!app) app = new BigRacesApp(network);
  initialized = true;
  return app;
}

async function openBigRaces() {
  try {
    const currentApp = ensureModuleInitialized();
    await currentApp.render(true);
    return currentApp;
  } catch (error) {
    console.error("FBL Need for Speed | не удалось открыть окно Больших Гонок", error);
    ui.notifications?.error?.("Не удалось открыть Большие Гонки. Подробности записаны в консоль Foundry.");
    return null;
  }
}

function exposeApi() {
  game.fblNeedForSpeed = {
    open: openBigRaces,
    get app() { return app; },
    get network() { return network; },
    get initialized() { return initialized; }
  };
}



function registerSoundSettings() {
  const notifyAudioChange = () => Hooks.callAll("fblNeedForSpeedAudioSettingsChanged");
  const registerVolume = (key, name, hint, defaultValue) => game.settings.register(MODULE_ID, key, {
    name, hint, scope: "client", config: true, type: Number, default: defaultValue,
    range: { min: 0, max: 1, step: 0.05 }, onChange: notifyAudioChange
  });
  const registerPath = (key, name, hint, defaultValue) => game.settings.register(MODULE_ID, key, {
    name, hint, scope: "client", config: true, type: String, default: defaultValue,
    filePicker: "audio", onChange: notifyAudioChange
  });

  game.settings.register(MODULE_ID, "soundEnabled", {
    name: "Большие Гонки: звуковое окружение",
    hint: "Включает двигатель, ветер, заносы, атмосферу трассы, пит-лейн и гоночные сигналы.",
    scope: "client", config: true, type: Boolean, default: true, onChange: notifyAudioChange
  });
  registerVolume("soundMasterVolume", "Большие Гонки: общая громкость", "Общий уровень всех звуков модуля.", 0.75);
  registerVolume("soundVehicleVolume", "Большие Гонки: громкость болида", "Двигатель, ветер и скольжение шин.", 0.8);
  registerVolume("soundAmbienceVolume", "Большие Гонки: громкость окружения", "Трибуны, трасса и работа пит-бригады.", 0.55);
  registerVolume("soundEffectsVolume", "Большие Гонки: громкость эффектов", "Столкновения, форсаж, сигналы, круги и финиш.", 0.8);
  registerVolume("soundUiVolume", "Большие Гонки: громкость интерфейса", "Нажатия кнопок внутри окна модуля.", 0.55);

  const paths = [
    ["soundEnginePath", "Звук: двигатель", "Зацикленный звук двигателя болида.", DEFAULT_SOUND_PATHS.engine],
    ["soundWindPath", "Звук: ветер", "Зацикленный шум воздуха на скорости.", DEFAULT_SOUND_PATHS.wind],
    ["soundSkidPath", "Звук: занос", "Зацикленный звук скольжения и потери сцепления.", DEFAULT_SOUND_PATHS.skid],
    ["soundAmbiencePath", "Звук: атмосфера трассы", "Зацикленное окружение трибун и гоночной арены.", DEFAULT_SOUND_PATHS.ambience],
    ["soundPitAmbiencePath", "Звук: атмосфера пит-лейна", "Зацикленная работа механизмов и пит-бригады.", DEFAULT_SOUND_PATHS.pitAmbience],
    ["soundBoostPath", "Звук: форсаж", "Однократный звук включения форсажа.", DEFAULT_SOUND_PATHS.boost],
    ["soundCollisionPath", "Звук: столкновение", "Однократный удар о стену или другой болид.", DEFAULT_SOUND_PATHS.collision],
    ["soundPitEntryPath", "Звук: въезд в пит-лейн", "Сигнал активации ограничения 60 км/ч.", DEFAULT_SOUND_PATHS.pitEntry],
    ["soundPitServicePath", "Звук: начало обслуживания", "Сигнал после полной остановки в голубой зоне.", DEFAULT_SOUND_PATHS.pitService],
    ["soundCountdownPath", "Звук: обратный отсчёт", "Короткий предстартовый сигнал.", DEFAULT_SOUND_PATHS.countdown],
    ["soundStartPath", "Звук: старт", "Сигнал начала гонки.", DEFAULT_SOUND_PATHS.start],
    ["soundLapPath", "Звук: новый круг", "Сигнал пересечения линии круга.", DEFAULT_SOUND_PATHS.lap],
    ["soundFinishPath", "Звук: финиш", "Сигнал завершения гонки.", DEFAULT_SOUND_PATHS.finish],
    ["soundUiPath", "Звук: интерфейс", "Короткий звук нажатия кнопки.", DEFAULT_SOUND_PATHS.ui]
  ];
  for (const setting of paths) registerPath(...setting);
}

Hooks.once("init", () => {
  Handlebars.registerHelper("nfsEq", (left, right) => left === right);
  registerSoundSettings();

  game.settings.register(MODULE_ID, "build", {
    name: "Сохранённая сборка болида",
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, "cameraMode", {
    name: "Режим камеры",
    scope: "client",
    config: false,
    type: String,
    default: "overview"
  });

  game.settings.register(MODULE_ID, "minimapEnabled", {
    name: "Мини-карта гонки",
    scope: "client",
    config: false,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "performanceOverlay", {
    name: "Большие Гонки: показывать метрики производительности",
    hint: "Выводит FPS, стоимость кадра, интервал сетевых снимков, ошибку предсказания и состояние кэшей поверх трассы.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });
});

Hooks.once("ready", () => {
  exposeApi();
  try {
    ensureModuleInitialized();
    network.requestState();
    console.info(`FBL Need for Speed | Большие Гонки ${VERSION} готовы`);
  } catch (error) {
    // Keep the scene-control button alive even when initialization encountered a
    // transient client-side problem. Clicking it retries the complete startup.
    console.error("FBL Need for Speed | ошибка инициализации", error);
    initialized = false;
  }
});

Hooks.on("getSceneControlButtons", (controls) => {
  const notes = Array.isArray(controls)
    ? controls.find((control) => control.name === "notes")
    : controls.notes;
  if (!notes) return;

  const tool = {
    name: "fbl-need-for-speed",
    title: "Большие Гонки",
    icon: "fas fa-flag-checkered",
    button: true,
    visible: true,
    order: 999,
    onChange: () => void openBigRaces()
  };

  if (Array.isArray(notes.tools)) notes.tools.push(tool);
  else notes.tools[tool.name] = tool;
});

window.addEventListener("beforeunload", () => {
  app?.shutdown();
  network?.destroy();
}, { once: true });
