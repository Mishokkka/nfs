// @ts-check

import { MODULE_ID } from "../constants.js";
import {
  PARTS,
  DRIVER_SPECIALIZATIONS,
  DRIVER_TALENTS,
  DRIVER_STAT_DEFINITIONS,
  DRIVER_STAT_KEYS,
  DRIVER_POINT_BUDGET,
  DRIVER_STAT_MIN,
  DRIVER_STAT_MAX,
  cloneDefaultBuild,
  normalizeBuild,
  resolveBuild,
  validateBuild
} from "../catalog.js";
import { deriveCarPhysics } from "../physics.js";
import { optionList, clamp } from "./app-helpers.js";


export class GarageController {
  constructor({ network }) {
    this.network = network;
    this.build = this.#loadBuild();
  }

  #loadBuild() {
    try {
      const saved = game.settings.get(MODULE_ID, "build");
      const merged = foundry.utils.mergeObject(cloneDefaultBuild(), saved || {}, { inplace: false, recursive: true });
      return normalizeBuild(merged, { repairPoints: true });
    } catch (error) {
      console.warn("FBL Need for Speed | сохранённая сборка повреждена, используется стандартная", error);
      return normalizeBuild(cloneDefaultBuild(), { repairPoints: true });
    }
  }

  getContext() {
    const resolved = resolveBuild(this.build);
    const driver = this.build.driver;
    const driverPoints = this.#driverTotal(driver);
    const remaining = DRIVER_POINT_BUDGET - driverPoints;
    return {
      build: this.build,
      driver,
      stats: [
        ["speed", "Скорость"],
        ["acceleration", "Разгон"],
        ["handling", "Управляемость"],
        ["control", "Контроль"],
        ["durability", "Прочность"],
        ["mass", "Масса"]
      ].map(([key, label]) => ({
        key,
        displayLabel: key === "handling" ? "Управл." : key === "durability" ? "Прочн." : label,
        tooltip: `${label}: итоговый рейтинг узлов болида. Значения выше 12 не дают дополнительного эффекта.`,
        value: resolved.stats[key],
        overflow: resolved.overflow[key],
        hasOverflow: resolved.overflow[key] > 0,
        percent: Math.round(resolved.stats[key] / 12 * 100)
      })),
      physicsPreview: this.#physicsPreview(resolved),
      driverPoints,
      driverPointBudget: DRIVER_POINT_BUDGET,
      driverStatMin: DRIVER_STAT_MIN,
      driverStatMax: DRIVER_STAT_MAX,
      driverPointsValid: remaining === 0,
      driverPointsStatus: this.#pointsStatus(remaining),
      driverStatRows: DRIVER_STAT_DEFINITIONS.map((definition) => ({
        ...definition,
        displayLabel: definition.key === "composure" ? "Хладнокр." : definition.key === "attunement" ? "Чувство ядра" : definition.label,
        tooltip: `${definition.label}. ${definition.description}`,
        value: driver[definition.key],
        canDecrease: driver[definition.key] > DRIVER_STAT_MIN,
        canIncrease: driver[definition.key] < DRIVER_STAT_MAX && remaining > 0
      })),
      frameOptions: optionList(PARTS.frame, this.build.frame),
      coreOptions: optionList(PARTS.core, this.build.core),
      transmissionOptions: optionList(PARTS.transmission, this.build.transmission),
      steeringOptions: optionList(PARTS.steering, this.build.steering),
      runningOptions: optionList(PARTS.running, this.build.running),
      bodyOptions: optionList(PARTS.body, this.build.body),
      moduleOptions: optionList(PARTS.module, this.build.module),
      specializationOptions: optionList(DRIVER_SPECIALIZATIONS, driver.specialization),
      talentOptions: DRIVER_TALENTS.map((talent) => ({
        ...talent,
        tooltip: `${talent.name}. ${talent.description}`,
        checked: driver.talents.includes(talent.id)
      }))
    };
  }

  bind(root, signal) {
    const form = root.querySelector("form[data-form='garage']");
    form?.addEventListener("input", (event) => this.#onDriverInput(event, root), { signal });
    form?.addEventListener("change", (event) => this.#onChange(event, root), { signal });
    form?.addEventListener("click", (event) => this.#onDriverStep(event, root), { signal });
  }

  #onDriverStep(event, root) {
    const button = event.target?.closest?.("[data-driver-step][data-driver-stat]");
    if (!(button instanceof HTMLButtonElement) || !root.contains(button)) return;
    event.preventDefault();
    const key = String(button.dataset.driverStat ?? "");
    if (!DRIVER_STAT_KEYS.includes(key)) return;
    const input = root.querySelector(`input[name="${key}"]`);
    if (!(input instanceof HTMLInputElement)) return;
    const step = Number(button.dataset.driverStep) < 0 ? -1 : 1;
    const current = clamp(Math.round(Number(input.value) || Number(this.build.driver[key]) || DRIVER_STAT_MIN), DRIVER_STAT_MIN, DRIVER_STAT_MAX);
    const total = this.#formDriverTotal(root);
    if (step > 0 && (current >= DRIVER_STAT_MAX || total >= DRIVER_POINT_BUDGET)) {
      ui.notifications.warn("Сначала освободите очко другой характеристики.");
      return;
    }
    if (step < 0 && current <= DRIVER_STAT_MIN) return;
    input.value = String(clamp(current + step, DRIVER_STAT_MIN, DRIVER_STAT_MAX));
    this.readFromForm(root);
    this.refreshPreview(root);
  }

  #onDriverInput(event, root) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !DRIVER_STAT_KEYS.includes(target.name)) return;
    const value = Number(target.value);
    const valid = Number.isInteger(value) && value >= DRIVER_STAT_MIN && value <= DRIVER_STAT_MAX;
    target.setCustomValidity(valid ? "" : `Введите целое число от ${DRIVER_STAT_MIN} до ${DRIVER_STAT_MAX}.`);
    target.setAttribute("aria-invalid", valid ? "false" : "true");
    if (!valid) {
      const status = root.querySelector("[data-driver-points-status]");
      if (status) {
        status.textContent = `Нужно целое значение от ${DRIVER_STAT_MIN} до ${DRIVER_STAT_MAX}`;
        status.classList.remove("is-valid");
        status.classList.add("is-invalid");
      }
      return;
    }
    this.readFromForm(root);
    this.refreshPreview(root);
  }

  #onChange(event, root) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (target instanceof HTMLInputElement && target.matches("input[type='checkbox'][name='talents']")) {
      const checked = root.querySelectorAll("input[name='talents']:checked");
      if (checked.length > 2) {
        target.checked = false;
        ui.notifications.warn("Можно выбрать только два таланта.");
        return;
      }
    }

    if (target instanceof HTMLInputElement && DRIVER_STAT_KEYS.includes(target.name)) {
      const previous = Number(this.build.driver[target.name]) || 1;
      const value = clamp(Math.round(Number(target.value) || previous), DRIVER_STAT_MIN, DRIVER_STAT_MAX);
      target.value = String(value);
      target.setCustomValidity("");
      target.setAttribute("aria-invalid", "false");
    }

    this.readFromForm(root);
    this.refreshPreview(root);
  }

  refreshPreview(root) {
    if (!root) return;
    const resolved = resolveBuild(this.build);
    for (const [key, value] of Object.entries(resolved.stats)) {
      const stat = root.querySelector(`.nfs-stat[data-stat="${key}"]`);
      if (!stat) continue;
      const number = stat.querySelector("strong");
      const fill = stat.querySelector(".nfs-rating__fill");
      const overflow = resolved.overflow[key] ?? 0;
      if (number) number.textContent = overflow > 0 ? `${value} (+${overflow})` : String(value);
      if (fill instanceof HTMLElement) fill.style.setProperty("--rating-pct", `${Math.round(value / 12 * 100)}%`);
      stat.classList.toggle("is-overflow", overflow > 0);
      stat.dataset.nfsTooltip = overflow > 0
        ? `Лимит характеристики 12. ${overflow} очк. сборки не дают дополнительного эффекта.`
        : `${stat.querySelector(".nfs-stat__line span")?.textContent ?? "Характеристика"}: итоговый рейтинг узлов болида.`;
    }

    this.#syncDriverControls(root);
    this.#syncPhysicsPreview(root, resolved, this.#driverTotal(this.build.driver) === DRIVER_POINT_BUDGET);

    for (const checkbox of root.querySelectorAll("input[name='talents']")) {
      checkbox.closest(".nfs-talent")?.classList.toggle("is-selected", checkbox.checked);
    }

    const catalogs = {
      frame: PARTS.frame,
      core: PARTS.core,
      transmission: PARTS.transmission,
      steering: PARTS.steering,
      running: PARTS.running,
      body: PARTS.body,
      module: PARTS.module,
      specialization: DRIVER_SPECIALIZATIONS
    };
    for (const [name, entries] of Object.entries(catalogs)) {
      const select = root.querySelector(`select[name="${name}"]`);
      const field = select?.closest(".nfs-field");
      const selected = entries.find((entry) => entry.id === select?.value);
      if (field instanceof HTMLElement && selected) {
        field.dataset.nfsTooltip = `${selected.name}: ${selected.description}`;
        field.setAttribute("aria-label", `${selected.name}. ${selected.description}`);
      }
    }
  }


  #physicsPreview(resolved) {
    const physics = deriveCarPhysics(resolved);
    return [
      { key: "maxSpeed", label: "Максимальная скорость", shortLabel: "Скорость", value: `${Math.round(physics.maxSpeed * (0.62 / 3))} км/ч` },
      { key: "acceleration", label: "Тяга двигателя", shortLabel: "Тяга", value: Math.round(physics.acceleration) },
      { key: "steerRate", label: "Скорость руления", shortLabel: "Руление", value: physics.steerRate.toFixed(2) },
      { key: "lateralGrip", label: "Боковое сцепление", shortLabel: "Сцепл.", value: physics.lateralGrip.toFixed(1) },
      { key: "maxHealth", label: "Максимальная прочность", shortLabel: "Прочн.", value: Math.round(physics.maxHealth) },
      { key: "maxCharge", label: "Максимальный заряд", shortLabel: "Заряд", value: Math.round(physics.maxCharge) }
    ];
  }

  #syncPhysicsPreview(root, resolved, driverValid = true) {
    for (const metric of this.#physicsPreview(resolved)) {
      const value = root.querySelector(`[data-physics-preview="${metric.key}"]`);
      if (value) value.textContent = driverValid ? String(metric.value) : "—";
    }
  }

  #syncDriverControls(root) {
    const points = this.#driverTotal(this.build.driver);
    const remaining = DRIVER_POINT_BUDGET - points;
    const counter = root.querySelector(".nfs-points");
    if (counter) {
      counter.textContent = `${points} / ${DRIVER_POINT_BUDGET}`;
      counter.classList.toggle("is-valid", remaining === 0);
      counter.classList.toggle("is-invalid", remaining !== 0);
    }
    const status = root.querySelector("[data-driver-points-status]");
    if (status) {
      status.textContent = this.#pointsStatus(remaining);
      status.classList.toggle("is-valid", remaining === 0);
      status.classList.toggle("is-invalid", remaining !== 0);
    }
    for (const definition of DRIVER_STAT_DEFINITIONS) {
      const input = root.querySelector(`input[name="${definition.key}"]`);
      if (!(input instanceof HTMLInputElement)) continue;
      const value = Number(this.build.driver[definition.key]) || DRIVER_STAT_MIN;
      const valid = Number.isInteger(value) && value >= DRIVER_STAT_MIN && value <= DRIVER_STAT_MAX;
      input.value = String(value);
      input.setCustomValidity(valid ? "" : `Введите целое число от ${DRIVER_STAT_MIN} до ${DRIVER_STAT_MAX}.`);
      input.setAttribute("aria-invalid", valid ? "false" : "true");
      const row = input.closest(".nfs-attribute");
      const decrease = row?.querySelector('[data-driver-step="-1"]');
      const increase = row?.querySelector('[data-driver-step="1"]');
      if (decrease instanceof HTMLButtonElement) decrease.disabled = value <= DRIVER_STAT_MIN;
      if (increase instanceof HTMLButtonElement) increase.disabled = value >= DRIVER_STAT_MAX || remaining <= 0;
    }
  }

  readFromForm(root) {
    const form = root?.querySelector("form[data-form='garage']");
    if (!(form instanceof HTMLFormElement)) return this.build;
    const data = new FormData(form);
    const readStat = (key) => {
      const raw = Number(data.get(key));
      return Number.isFinite(raw) ? clamp(Math.round(raw), DRIVER_STAT_MIN, DRIVER_STAT_MAX) : Number(this.build.driver[key]) || DRIVER_STAT_MIN;
    };
    this.build = normalizeBuild({
      ...this.build,
      name: String(data.get("name") || "Безымянный болид"),
      frame: String(data.get("frame")),
      core: String(data.get("core")),
      transmission: String(data.get("transmission")),
      steering: String(data.get("steering")),
      running: String(data.get("running")),
      body: String(data.get("body")),
      module: String(data.get("module")),
      driver: {
        ...this.build.driver,
        name: String(data.get("driverName") || game.user.name),
        ...Object.fromEntries(DRIVER_STAT_KEYS.map((key) => [key, readStat(key)])),
        specialization: String(data.get("specialization")),
        talents: data.getAll("talents").map(String).slice(0, 2)
      }
    }, { repairPoints: false });
    return this.build;
  }

  async saveFromForm(root, showNotification = true) {
    this.readFromForm(root);
    const error = validateBuild(this.build);
    if (error) {
      ui.notifications.error(error);
      this.refreshPreview(root);
      return false;
    }
    this.build = normalizeBuild(this.build, { repairPoints: true });
    await game.settings.set(MODULE_ID, "build", this.build);
    if (this.network.participant) this.network.updateBuild(this.build);
    if (showNotification) ui.notifications.info("Сборка сохранена.");
    return true;
  }

  #driverTotal(driver) {
    return DRIVER_STAT_KEYS.reduce((sum, key) => sum + (Number(driver?.[key]) || 0), 0);
  }

  #formDriverTotal(root) {
    return DRIVER_STAT_KEYS.reduce((sum, key) => {
      const input = root.querySelector(`input[name="${key}"]`);
      return sum + clamp(Math.round(Number(input?.value) || Number(this.build.driver[key]) || DRIVER_STAT_MIN), DRIVER_STAT_MIN, DRIVER_STAT_MAX);
    }, 0);
  }

  #pointsStatus(remaining) {
    if (remaining === 0) return "Очки распределены";
    if (remaining > 0) return `Осталось распределить: ${remaining}`;
    return `Превышение: ${Math.abs(remaining)}`;
  }
}
