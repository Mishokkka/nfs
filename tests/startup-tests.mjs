import assert from "node:assert/strict";

const hooks = new Map();
globalThis.Hooks = {
  once(name, callback) { hooks.set(`once:${name}`, callback); },
  on(name, callback) { hooks.set(`on:${name}`, callback); }
};
globalThis.Handlebars = { registerHelper() {} };

class MockApplicationV2 {
  get state() { return 0; }

  constructor() {
    this.rendered = false;
    this.element = null;
    this.renderCalls = [];
  }

  async render(options = {}) {
    this.renderCalls.push(options);
    await this._prepareContext(options);
    this.rendered = true;
    return this;
  }

  async _onRender() {}
  async close() { return this; }
  async _preClose() {}
  async _onClose() {}
}

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: MockApplicationV2,
      HandlebarsApplicationMixin: (Base) => class extends Base {},
      DialogV2: { confirm: async () => true }
    }
  },
  utils: {
    deepClone: (value) => structuredClone(value),
    mergeObject: (base, update) => Object.assign(structuredClone(base), structuredClone(update ?? {}))
  }
};

const settings = new Map();
globalThis.game = {
  user: { id: "user-1", name: "Гонщик", isGM: true },
  users: new Map(),
  settings: {
    register(moduleId, key, options) { settings.set(`${moduleId}.${key}`, structuredClone(options.default)); },
    get(moduleId, key) { return settings.get(`${moduleId}.${key}`); },
    async set(moduleId, key, value) { settings.set(`${moduleId}.${key}`, structuredClone(value)); }
  },
  socket: { on() {}, off() {}, emit() {} }
};
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
globalThis.window = {
  addEventListener() {},
  setInterval: () => 1,
  clearInterval() {},
  setTimeout: () => 1,
  clearTimeout() {},
  confirm: () => true
};
globalThis.document = { hidden: false, activeElement: null };
globalThis.HTMLFormElement = class {};
globalThis.HTMLInputElement = class {};
globalThis.HTMLSelectElement = class {};
globalThis.HTMLElement = class {};

await import(`../scripts/main.js?startup-test=${Date.now()}`);
await hooks.get("once:init")();
await hooks.get("once:ready")();

const controls = { notes: { name: "notes", tools: {} } };
hooks.get("on:getSceneControlButtons")(controls);
const tool = controls.notes.tools["fbl-need-for-speed"];
assert.ok(tool, "Journal Notes tool must be registered");
assert.equal(typeof tool.onChange, "function");

tool.onChange(new Event("click"), true);
await new Promise((resolve) => setImmediate(resolve));

assert.ok(game.fblNeedForSpeed?.app, "application must be initialized");
assert.equal(game.fblNeedForSpeed.app.rendered, true, "scene-control button must render the app");
assert.equal(game.fblNeedForSpeed.app.renderCalls.at(-1), true, "ApplicationV2 must receive an explicit force render");

console.log("startup-tests: ok");
