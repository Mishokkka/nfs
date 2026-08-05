const item = (id, name, description, stats = {}, traits = {}) => ({ id, name, description, stats, traits });

export const PARTS = Object.freeze({
  frame: [
    item("arrow", "Стрела", "Лёгкая рама для скорости и разгона. Плохо переносит контакт.", { speed: 2, acceleration: 1, handling: 1, durability: -2, mass: -2 }, { radiusBase: 15 }),
    item("spider", "Паук", "Короткая колёсная база и быстрые реакции на руление.", { handling: 3, control: 1, durability: -1, mass: -1 }, { radiusBase: 16 }),
    item("keel", "Киль", "Стабильная рама, сохраняющая направление на высокой скорости.", { control: 3, handling: 1, mass: 1 }, { radiusBase: 17 }),
    item("bull", "Бык", "Тяжёлая рама для борьбы корпусом и прямых ударов.", { durability: 3, mass: 3, acceleration: -1, handling: -1 }, { radiusBase: 19 }),
    item("turtle", "Черепаха", "Максимальная защита ценой скорости и подвижности.", { durability: 5, mass: 3, speed: -1, acceleration: -1, handling: -1 }, { radiusBase: 20 }),
    item("allantry", "Универсал Аллантре", "Надёжная турнирная рама без выраженных слабостей.", { speed: 1, acceleration: 1, handling: 1, control: 1 }, { radiusBase: 17 })
  ],
  core: [
    item("needle", "Ядро «Игла»", "Высокие обороты и максимальная скорость.", { speed: 3, acceleration: 1 }, { heatRate: 1.08 }),
    item("hammer", "Ядро «Молот»", "Большой крутящий момент и сила удара.", { acceleration: 3, mass: 1 }, { ramPower: 1.18 }),
    item("choir", "Ядро «Хор»", "Ровная мощность и умеренный нагрев.", { speed: 1, acceleration: 1, control: 1 }, { heatRate: 0.82, cooling: 1.15 }),
    item("wild", "Дикое ядро", "Взрывной форсаж. Быстро перегревается.", { speed: 2, acceleration: 2, control: -1 }, { boostPower: 1.34, heatRate: 1.42 }),
    item("twin", "Двойное ядро", "Большой запас энергии и тяжёлая конструкция.", { speed: 1, acceleration: 2, mass: 1 }, { charge: 1.34, heatRate: 1.12 }),
    item("pulse", "Пульсирующее ядро", "Возвращает заряд за чистое прохождение поворотов.", { acceleration: 1, handling: 1, control: 1 }, { cornerCharge: 1 })
  ],
  transmission: [
    item("long", "Длинный редуктор", "Сильнее на прямых, слабее при разгоне.", { speed: 3, acceleration: -1 }),
    item("short", "Короткий редуктор", "Быстрый разгон с умеренным ограничением максимальной скорости.", { speed: -1, acceleration: 3 }),
    item("adaptive", "Адаптивная передача", "Автоматически выравнивает тягу во всём диапазоне скоростей.", { speed: 1, acceleration: 1, control: 1 }),
    item("impulse", "Импульсная передача", "Краткий рывок после выхода из сильного поворота.", { acceleration: 2, handling: 1 }, { exitBurst: 1 }),
    item("direct", "Прямая передача", "Высокая эффективность и резкая реакция на газ.", { speed: 2, acceleration: 1, control: -1 }),
    item("reinforced", "Усиленная передача", "Устойчива к таранам и плотному контакту.", { durability: 2, acceleration: 1 }, { collisionResistance: 0.82 })
  ],
  steering: [
    item("quick", "Быстрая рейка", "Резкое руление, требующее точности на высокой скорости.", { handling: 3, control: -1 }),
    item("gyro", "Гироскопическая", "Держит направление и сглаживает резкие ошибки.", { control: 3, handling: -1 }, { spinResistance: 1.25 }),
    item("counter", "Контррулевая", "Облегчает управляемый занос.", { handling: 2, control: 1 }, { drift: 1.10 }),
    item("precision", "Точная рейка", "Высокий потолок мастерства без сильной автоматики.", { handling: 2 }, { precision: 1 }),
    item("ramlock", "Таранный фиксатор", "Фиксирует колёса перед ударом и держит линию.", { durability: 1, mass: 1 }, { ramPower: 1.15, ramSteerPenalty: 0.72 }),
    item("floating", "Плавающая рейка", "Прощает ошибки и быстро возвращает болид на траекторию.", { control: 3, speed: -1 })
  ],
  running: [
    item("grip", "Цепкая ходовая", "Высокое сцепление на чистом полотне.", { control: 3, handling: 1 }),
    item("slide", "Скользящая ходовая", "Легче входит в занос и быстрее меняет направление.", { handling: 3, control: -1 }, { drift: 1.2 }),
    item("reinforced", "Усиленная ходовая", "Лучше переносит бордюры и плотный контакт.", { durability: 3 }, { collisionResistance: 0.86 }),
    item("soft", "Мягкая ходовая", "Лучше сохраняет скорость и управление на траве.", { control: 2, durability: 1 }, { offroadGrip: 1.25 }),
    item("sport", "Спортивная ходовая", "Быстра на чистой траектории, но не прощает ошибок.", { speed: 2, handling: 2, control: -2 }),
    item("heavy", "Тяжёлая ходовая", "Трудно сместить ударом, но она замедляет разгон.", { durability: 2, mass: 2, acceleration: -1 })
  ],
  body: [
    item("streamlined", "Обтекаемый корпус", "Меньше сопротивления и немного эффективнее форсаж.", { speed: 1, acceleration: 1, durability: -1 }, { boostPower: 1.06 }),
    item("short", "Укороченный корпус", "Малый радиус поворота и быстрая перекладка.", { handling: 3, mass: -1 }),
    item("armored", "Бронированный корпус", "Сохраняет прочность в плотной борьбе.", { durability: 4, mass: 2, speed: -1 }),
    item("wide", "Расширенный корпус", "Хорошо блокирует соперников, но цепляет стены.", { durability: 2, mass: 2, handling: -1 }, { radiusDelta: 2, ramPower: 1.08 }),
    item("open", "Открытый корпус", "Минимальная масса и быстрый разгон.", { speed: 1, acceleration: 2, handling: 1, mass: -2, durability: -2 }),
    item("ribbed", "Рёберный корпус", "Рассеивает боковые удары и защищает от разворота.", { durability: 2, control: 1 }, { sideYieldFactor: 0.72 })
  ],
  module: [
    item("none", "Без специального модуля", "Меньше масса, но нет специального эффекта.", { mass: -1 }),
    item("ram", "Таранная решётка", "Усиливает намеренные удары.", { durability: 1, mass: 1 }, { ramPower: 1.18 }),
    item("stabilizer", "Гиростабилизатор", "Сопротивляется развороту после столкновений.", { control: 1 }, { spinResistance: 1.30 }),
    item("capacitor", "Кристаллический конденсатор", "Увеличивает запас форсажа на 25%.", {}, { charge: 1.25 }),
    item("cooler", "Дополнительное охлаждение", "Ускоряет охлаждение ядра на 28%.", {}, { cooling: 1.28 }),
    item("emergency", "Аварийная спайка", "Один раз возвращает разрушенный болид с 28% прочности.", {}, { emergencyRepair: 1 }),
    item("recuperator", "Рекуператор", "Постепенно возвращает заряд при торможении на скорости.", {}, { recuperation: 0.82 }),
    item("resonator", "Резонатор", "Медленно накапливает заряд в воздушном мешке соперника.", {}, { slipstreamCharge: 0.82 }),
    item("discharger", "Разрядник", "Усиливает импульс сильного столкновения на 14% для обеих машин.", {}, { collisionBlast: 0.14 }),
    item("selfseal", "Самозатягивающаяся обшивка", "После четырёх секунд без столкновений медленно восстанавливает прочность.", {}, { regeneration: 0.55 })
  ]
});

export const DRIVER_SPECIALIZATIONS = [
  item("speedster", "Скоростник", "Сильнее на прямых и в воздушном мешке.", {}, { topSpeed: 1.045, slipstream: 1.18 }),
  item("technician", "Техник", "Меньше теряет скорость в сложных поворотах.", {}, { cornerGrip: 1.08 }),
  item("duelist", "Дуэлянт", "Устойчив в контакте борт к борту.", {}, { sideYieldFactor: 0.86 }),
  item("rammer", "Таранщик", "Сильнее наносит и переносит прямые удары.", {}, { ramPower: 1.14, collisionResistance: 0.93 }),
  item("mechanic", "Механик", "Повреждения систем наступают позже.", {}, { durabilityMult: 1.08, regeneration: 0.18 }),
  item("daredevil", "Сорвиголова", "Получает мощный форсаж при низкой прочности.", {}, { lowHealthBoost: 1.20 }),
  item("veteran", "Ветеран", "Быстрее возвращает контроль после ошибок.", {}, { recovery: 1.18 }),
  item("street", "Уличный гонщик", "Лучше чувствует заносы и увереннее возвращается с травы.", {}, { drift: 1.14, offroadGrip: 1.12 })
];

export const DRIVER_STAT_DEFINITIONS = Object.freeze([
  { key: "reflexes", label: "Рефлексы", icon: "fas fa-bolt", description: "За каждый пункт сверх 1: разгон +4%, торможение +3%, восстановление +4%." },
  { key: "technique", label: "Техника", icon: "fas fa-compass-drafting", description: "За каждый пункт сверх 1: руление +2,8%, сцепление +1,6%, скорость +0,5%." },
  { key: "composure", label: "Хладнокровие", icon: "fas fa-snowflake", description: "За каждый пункт сверх 1: сцепление +2,2%, урон −3%, устойчивость к развороту +2,2%." },
  { key: "aggression", label: "Напор", icon: "fas fa-hand-fist", description: "За каждый пункт сверх 1: сила тарана +4,8%, устойчивость к смещению +2,5%." },
  { key: "attunement", label: "Чувство ядра", icon: "fas fa-gem", description: "За каждый пункт сверх 1: охлаждение +5%, нагрев −3%, заряд +2%, форсаж +1,7%." }
]);

export const DRIVER_TALENTS = [
  item("late-brake", "Позднее торможение", "Кратко повышает сцепление при сильном торможении.", {}, { lateBrake: 1 }),
  item("smooth", "Мягкая перекладка", "Меньше теряет скорость в последовательных поворотах.", {}, { smoothSteer: 1 }),
  item("iron-hands", "Железные руки", "Удар слабее сбивает направление.", {}, { spinResistance: 1.14 }),
  item("fearless", "Без страха", "Первое критическое повреждение не вызывает штрафа.", {}, { ignoreFirstCritical: 1 }),
  item("predator", "Хищник", "Ускоряется, преследуя соперника.", {}, { pursuit: 1 }),
  item("fixed-line", "Неподвижная линия", "Сложнее вытолкнуть с траектории.", {}, { sideYieldFactor: 0.88 }),
  item("timing", "Чувство момента", "Получает больше заряда за чистый выход из поворота.", {}, { cornerCharge: 0.65 }),
  item("crystal-ear", "Кристальный слух", "Раньше предупреждает о перегреве.", {}, { heatWarning: 1 }),
  item("retaliation", "Ответный удар", "После полученного удара кратко усиливает таран.", {}, { retaliation: 1 }),
  item("clean-start", "Чистый старт", "Усиленный стартовый разгон.", {}, { startBoost: 1 }),
  item("last-lap", "Последний круг", "Умеренное усиление на финальном круге.", {}, { lastLap: 1 }),
  item("repair-master", "Мастер ремонта", "Восстанавливает прочность после чистого круга.", {}, { lapRepair: 1 })
];

export const DEFAULT_BUILD = Object.freeze({
  name: "Безымянный болид",
  frame: "allantry",
  core: "choir",
  transmission: "adaptive",
  steering: "floating",
  running: "grip",
  body: "ribbed",
  module: "none",
  driver: {
    name: "Гонщик",
    reflexes: 3,
    technique: 4,
    composure: 3,
    aggression: 3,
    attunement: 3,
    specialization: "technician",
    talents: ["smooth", "crystal-ear"]
  }
});

export const DRIVER_STAT_KEYS = DRIVER_STAT_DEFINITIONS.map((entry) => entry.key);
export const DRIVER_POINT_BUDGET = 16;
export const DRIVER_STAT_MIN = 1;
export const DRIVER_STAT_MAX = 6;
const PART_KEYS = Object.freeze(Object.keys(PARTS));
const clone = (value) => globalThis.foundry?.utils?.deepClone
  ? foundry.utils.deepClone(value)
  : structuredClone(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function cloneDefaultBuild() {
  return clone(DEFAULT_BUILD);
}

function cleanText(value, fallback, maxLength = 60) {
  const text = String(value ?? "").trim().replace(/[\u0000-\u001F\u007F]/g, "");
  return (text || fallback).slice(0, maxLength);
}

function validId(entries, value, fallback) {
  const id = String(value ?? "");
  return entries.some((entry) => entry.id === id) ? id : fallback;
}

function normalizeDriverPoints(values) {
  const result = values.map((value) => clamp(Math.round(Number(value) || DRIVER_STAT_MIN), DRIVER_STAT_MIN, DRIVER_STAT_MAX));
  let total = result.reduce((sum, value) => sum + value, 0);
  // Deterministic repair. Prefer changing less-specialised values first so imported
  // or network builds always resolve to exactly sixteen legal points.
  const increaseOrder = [4, 1, 0, 2, 3];
  const decreaseOrder = [3, 2, 0, 1, 4];
  while (total < DRIVER_POINT_BUDGET) {
    const index = increaseOrder.find((candidate) => result[candidate] < DRIVER_STAT_MAX);
    if (index == null) break;
    result[index] += 1;
    total += 1;
  }
  while (total > DRIVER_POINT_BUDGET) {
    const index = decreaseOrder.find((candidate) => result[candidate] > DRIVER_STAT_MIN);
    if (index == null) break;
    result[index] -= 1;
    total -= 1;
  }
  return result;
}

/**
 * Return a new whitelist-only build. Network and saved data must pass through
 * this function before they can reach physics. `repairPoints:false` preserves
 * an invalid point total so the garage can display a useful validation error.
 */
export function normalizeBuild(raw, { repairPoints = true } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const rawDriver = source.driver && typeof source.driver === "object" ? source.driver : {};
  const defaults = DEFAULT_BUILD.driver;
  let pointValues = DRIVER_STAT_KEYS.map((key) => clamp(Math.round(Number(rawDriver[key]) || defaults[key]), DRIVER_STAT_MIN, DRIVER_STAT_MAX));
  if (repairPoints) pointValues = normalizeDriverPoints(pointValues);

  const validTalentIds = new Set(DRIVER_TALENTS.map((entry) => entry.id));
  const talents = [];
  for (const value of Array.isArray(rawDriver.talents) ? rawDriver.talents : []) {
    const id = String(value);
    if (!validTalentIds.has(id) || talents.includes(id)) continue;
    talents.push(id);
    if (talents.length === 2) break;
  }
  if (repairPoints) {
    for (const fallback of defaults.talents) {
      if (!talents.includes(fallback)) talents.push(fallback);
      if (talents.length === 2) break;
    }
    for (const talent of DRIVER_TALENTS) {
      if (!talents.includes(talent.id)) talents.push(talent.id);
      if (talents.length === 2) break;
    }
  }

  const build = {
    name: cleanText(source.name, DEFAULT_BUILD.name),
    driver: {
      name: cleanText(rawDriver.name, defaults.name),
      specialization: validId(DRIVER_SPECIALIZATIONS, rawDriver.specialization, defaults.specialization),
      talents: talents.slice(0, 2)
    }
  };
  PART_KEYS.forEach((key) => {
    build[key] = validId(PARTS[key], source[key], DEFAULT_BUILD[key]);
  });
  DRIVER_STAT_KEYS.forEach((key, index) => {
    build.driver[key] = pointValues[index];
  });
  return build;
}

function findPart(category, id) {
  return PARTS[category].find((entry) => entry.id === id) ?? PARTS[category][0];
}

function mergeTraits(target, traits) {
  for (const [key, value] of Object.entries(traits ?? {})) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (key === "radiusBase") {
      target.radiusBase = value;
    } else if (["collisionResistance", "sideYieldFactor", "heatRate"].includes(key)) {
      target[key] *= value;
    } else if (["ramPower", "boostPower", "charge", "cooling", "spinResistance", "offroadGrip", "drift", "recovery", "durabilityMult", "topSpeed", "cornerGrip", "slipstream"].includes(key)) {
      target[key] *= value;
    } else {
      target[key] = (target[key] ?? 0) + value;
    }
  }
}

export function resolveBuild(rawBuild) {
  const build = normalizeBuild(rawBuild, { repairPoints: true });
  const base = { speed: 5, acceleration: 5, handling: 5, control: 5, durability: 5, mass: 5 };
  const traits = {
    heatRate: 1,
    cooling: 1,
    boostPower: 1,
    charge: 1,
    ramPower: 1,
    collisionResistance: 1,
    sideYieldFactor: 1,
    spinResistance: 1,
    offroadGrip: 1,
    drift: 1,
    recovery: 1,
    durabilityMult: 1,
    topSpeed: 1,
    cornerGrip: 1,
    slipstream: 1,
    radiusBase: 17,
    radiusDelta: 0
  };

  const chosen = {};
  for (const category of PART_KEYS) {
    const part = findPart(category, build[category]);
    chosen[category] = part;
    for (const [key, value] of Object.entries(part.stats ?? {})) base[key] = (base[key] ?? 0) + value;
    mergeTraits(traits, part.traits);
  }

  const driver = build.driver;
  const specialization = DRIVER_SPECIALIZATIONS.find((entry) => entry.id === driver.specialization) ?? DRIVER_SPECIALIZATIONS[0];
  mergeTraits(traits, specialization.traits);
  const talents = driver.talents
    .map((id) => DRIVER_TALENTS.find((entry) => entry.id === id))
    .filter(Boolean);
  for (const talent of talents) mergeTraits(traits, talent.traits);

  const rawStats = {};
  const stats = {};
  const overflow = {};
  for (const [key, value] of Object.entries(base)) {
    rawStats[key] = value;
    stats[key] = clamp(value, 1, 12);
    overflow[key] = Math.max(0, value - 12);
  }

  const driverStats = Object.fromEntries(DRIVER_STAT_KEYS.map((key) => [key, driver[key]]));
  return { build, chosen, rawStats, stats, overflow, traits, driverStats, specialization, talents };
}

export function validateBuild(rawBuild) {
  if (!rawBuild || typeof rawBuild !== "object") return "Сборка болида повреждена.";
  for (const key of PART_KEYS) {
    if (!PARTS[key].some((entry) => entry.id === rawBuild[key])) return `Выбрана неизвестная деталь: ${key}.`;
  }
  const d = rawBuild.driver;
  if (!d || typeof d !== "object") return "Данные гонщика отсутствуют.";
  const values = DRIVER_STAT_KEYS.map((key) => Number(d[key]));
  if (values.some((value) => !Number.isInteger(value) || value < DRIVER_STAT_MIN || value > DRIVER_STAT_MAX)) {
    return `Каждая характеристика гонщика должна быть целым числом от ${DRIVER_STAT_MIN} до ${DRIVER_STAT_MAX}.`;
  }
  if (values.reduce((sum, value) => sum + value, 0) !== DRIVER_POINT_BUDGET) {
    return `На характеристики гонщика нужно распределить ровно ${DRIVER_POINT_BUDGET} очков.`;
  }
  if (!DRIVER_SPECIALIZATIONS.some((entry) => entry.id === d.specialization)) return "Выбрана неизвестная специализация гонщика.";
  const talents = Array.isArray(d.talents) ? d.talents.map(String) : [];
  if (talents.length !== 2) return "Выберите ровно два таланта гонщика.";
  if (new Set(talents).size !== 2) return "Таланты гонщика не должны повторяться.";
  if (talents.some((id) => !DRIVER_TALENTS.some((entry) => entry.id === id))) return "Выбран неизвестный талант гонщика.";
  return null;
}
