// @ts-check

export const APP_SCREENS = Object.freeze(["garage", "lobby", "race", "results"]);

const TRANSITIONS = Object.freeze({
  garage: new Set(["garage", "lobby", "race"]),
  lobby: new Set(["garage", "lobby", "race", "results"]),
  race: new Set(["garage", "lobby", "race", "results"]),
  results: new Set(["garage", "lobby", "race", "results"])
});

export class ScreenStateMachine {
  constructor(initial = "garage") {
    this.current = APP_SCREENS.includes(initial) ? initial : "garage";
  }

  transition(next, { force = false } = {}) {
    if (!APP_SCREENS.includes(next)) throw new Error(`Unknown racing screen: ${next}`);
    if (!force && !TRANSITIONS[this.current]?.has(next)) {
      console.warn(`FBL Need for Speed | rejected screen transition ${this.current} -> ${next}`);
      return false;
    }
    this.current = next;
    return true;
  }

  is(screen) {
    return this.current === screen;
  }
}

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function compactOptionName(value, maxLength = 24) {
  const replacements = [
    ["Кристаллический", "Крист."],
    ["Гироскопическая", "Гироскоп."],
    ["Контррулевая", "Контрруль"],
    ["Универсал Аллантре", "Универсал"],
    ["Самозатягивающаяся", "Самозатяг."],
    ["Дополнительное", "Доп."],
    ["Специального", "спец."],
    ["Кристаллический конденсатор", "Крист. конденсатор"]
  ];
  let text = String(value ?? "");
  for (const [from, to] of replacements) text = text.replace(from, to);
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…` : text;
}

export function optionList(entries, selected) {
  return entries.map((entry) => ({
    ...entry,
    displayName: compactOptionName(entry.name),
    selected: entry.id === selected
  }));
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${minutes}:${remaining.toFixed(2).padStart(5, "0")}`;
}
