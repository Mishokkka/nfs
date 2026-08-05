import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { for (const name of names) this.values.add(name); }
  remove(...names) { for (const name of names) this.values.delete(name); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

class FakeElement {
  constructor() {
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = "";
    this.hidden = false;
    this.isConnected = true;
    this.focusCount = 0;
  }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { this.focusCount += 1; }
  emit(type) { this.listeners.get(type)?.({ currentTarget: this }); }
}

class FakeInput extends FakeElement {
  constructor() {
    super();
    this.value = "";
    this.disabled = false;
  }
}

globalThis.HTMLInputElement = FakeInput;

globalThis.window = {
  nextTimerId: 1,
  timers: new Map(),
  clearedTimers: new Set(),
  setTimeout(callback, delay) {
    const id = this.nextTimerId++;
    this.timers.set(id, { callback, delay });
    return id;
  },
  clearTimeout(id) {
    this.clearedTimers.add(id);
    this.timers.delete(id);
  }
};

const { PitUi } = await load("scripts/app/pit-ui.js");
{
  const overlay = new FakeElement();
  const word = new FakeElement();
  const input = new FakeInput();
  const errors = new FakeElement();
  const count = new FakeElement();
  const bySelector = new Map([
    ["[data-pit-overlay]", overlay],
    ["[data-pit-word]", word],
    ["[data-pit-input]", input],
    ["[data-pit-errors]", errors],
    ["[data-pit-count]", count]
  ]);
  const rootElement = { querySelector: (selector) => bySelector.get(selector) ?? null };
  const completed = [];
  let restored = 0;
  const pit = new PitUi({
    onComplete: (typed, attemptId) => completed.push({ typed, attemptId }),
    onRestoreFocus: () => { restored += 1; }
  });
  pit.mount(rootElement);
  pit.update({ pitState: "service", pitWord: "кристалл", pitAttemptId: "attempt-1", pitStopsCompleted: 0, pitStopsRequired: 1 });
  await Promise.resolve();
  assert.equal(input.focusCount, 1);

  input.value = "кристалл";
  input.emit("input");
  assert.deepEqual(completed, [{ typed: "кристалл", attemptId: "attempt-1" }]);
  assert.equal(restored, 0, "focus must wait for authoritative completion");
  assert.equal(input.disabled, true);
  assert.equal(errors.textContent, "Подтверждение обслуживания…");
  assert.equal(overlay.getAttribute("aria-busy"), "true");

  pit.update({ pitState: "exit", pitWord: "", pitAttemptId: null, pitStopsCompleted: 1, pitStopsRequired: 1 });
  assert.equal(restored, 1);
  assert.equal(input.disabled, false);
  assert.equal(overlay.classList.contains("is-complete"), false);
  assert.equal(overlay.getAttribute("aria-busy"), "false");

  pit.update({ pitState: "service", pitWord: "ядро", pitAttemptId: "attempt-2", pitStopsCompleted: 0, pitStopsRequired: 1 });
  input.value = "ядро";
  input.emit("input");
  const retryTimer = [...window.timers.values()].find((timer) => timer.delay === 2500);
  assert.ok(retryTimer, "confirmation retry timer missing");
  retryTimer.callback();
  assert.equal(input.disabled, false, "lost confirmation must not lock the pit input forever");
  assert.equal(errors.textContent, "Подтверждение не получено. Повторите ввод.");
  assert.equal(overlay.classList.contains("is-complete"), false);
  assert.equal(input.focusCount, 2);
  assert.equal(restored, 1, "retry must keep focus in the pit dialog");
  pit.destroy();
}

const frameCallbacks = new Map();
const cancelledFrames = new Set();
let nextFrameId = 1;
globalThis.requestAnimationFrame = (callback) => {
  const id = nextFrameId++;
  frameCallbacks.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  cancelledFrames.add(id);
  frameCallbacks.delete(id);
};

const { RaceInput } = await load("scripts/app/race-input.js");
{
  const canvas = new FakeElement();
  const raceInput = new RaceInput({
    getLocalCarId: () => "car-1",
    getSnapshot: () => ({ cars: [] }),
    isRaceActive: () => true,
    onInput() {},
    onCameraMode() {},
    onToggleCamera() {},
    onToggleMinimap() {},
    onVisibilityChange() {}
  });
  raceInput.target = canvas;
  raceInput.keys.add("KeyA");
  raceInput.keys.add("ControlLeft");
  const driftInput = raceInput.current();
  assert.equal(driftInput.steer, -1);
  assert.equal(driftInput.drift, true, "Ctrl did not reach the driving input payload");
  raceInput.keys.clear();
  raceInput.restoreFocus();
  const oldFrameId = raceInput.restoreFrame;
  const oldTimerId = raceInput.restoreTimer;
  const oldFrameCallback = frameCallbacks.get(oldFrameId);
  const oldTimerCallback = window.timers.get(oldTimerId)?.callback;
  raceInput.restoreFocus();
  assert.ok(cancelledFrames.has(oldFrameId), "previous focus RAF was not cancelled");
  assert.ok(window.clearedTimers.has(oldTimerId), "previous focus timer was not cancelled");
  const afterSecondRestore = canvas.focusCount;
  oldFrameCallback?.(0);
  oldTimerCallback?.();
  assert.equal(canvas.focusCount, afterSecondRestore, "stale focus callback stole focus");
  raceInput.destroyListeners();
}

const { RaceHud } = await load("scripts/app/race-hud.js");
{
  const hud = new RaceHud({ pitUi: { update() {} } });
  hud.updateCount = 9;
  hud.mount({ querySelector: () => null });
  assert.deepEqual(hud.getDiagnosticStats(), {
    mode: "canvas",
    updateIntervalMs: 0,
    pending: false,
    updateCount: 0,
    domWrites: 0
  });
  hud.destroy();
}


// Autoplay rejection must not cause play() retries from the periodic audio update loop.
{
  const instances = [];
  let allowPlayback = false;
  let audioClock = 0;
  globalThis.performance = { now: () => audioClock };
  class FakeAudio {
    constructor(path) {
      this.path = path;
      this.paused = true;
      this.volume = 0;
      this.playbackRate = 1;
      this.currentTime = 0;
      this.loop = false;
      this.preload = "";
      this.playCalls = 0;
      instances.push(this);
    }
    play() {
      this.playCalls += 1;
      if (!allowPlayback) return Promise.reject(new Error("autoplay blocked"));
      this.paused = false;
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    addEventListener() {}
  }
  globalThis.Audio = FakeAudio;
  const soundManagerUrl = pathToFileURL(path.join(root, "scripts/app/sound-manager.js"));
  soundManagerUrl.searchParams.set("audio", String(Date.now()));
  const { RaceSoundManager } = await import(soundManagerUrl.href);
  const audioRoot = new FakeElement();
  const manager = new RaceSoundManager({ getLocalCarId: () => "car-1" });
  manager.mount(audioRoot);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(instances.length, 5);
  assert.equal(instances.reduce((sum, audio) => sum + audio.playCalls, 0), 5);

  const snapshot = {
    started: true,
    finished: false,
    countdown: 0,
    cars: [{ id: "car-1", vx: 0, vy: 0, angle: 0, pitState: "track", health: 100 }]
  };
  for (let index = 0; index < 50; index += 1) {
    audioClock += 100;
    manager.update(snapshot);
  }
  await Promise.resolve();
  assert.equal(instances.reduce((sum, audio) => sum + audio.playCalls, 0), 5,
    "audio update loop retried blocked autoplay");

  allowPlayback = true;
  audioRoot.emit("pointerdown");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(instances.reduce((sum, audio) => sum + audio.playCalls, 0), 10,
    "real user gesture did not retry paused loops");
  assert.equal(manager.getDiagnosticStats().playingLoops, 5);
  audioRoot.emit("pointerdown");
  await Promise.resolve();
  assert.equal(instances.reduce((sum, audio) => sum + audio.playCalls, 0), 10,
    "already playing loops were restarted on every pointer event");

  manager.setSuspended(true);
  assert.equal(manager.getDiagnosticStats().playingLoops, 0, "suspending audio left loop decoders running");
  assert.ok(instances.every((audio) => audio.paused), "suspending audio did not pause every loop");
  manager.setSuspended(false);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(manager.getDiagnosticStats().playingLoops, 5, "resuming audio did not restart eligible loops");
  assert.equal(instances.reduce((sum, audio) => sum + audio.playCalls, 0), 15,
    "resuming audio retried an unexpected number of loops");
  manager.destroy();
  delete globalThis.Audio;
}

console.log("ui-controller-tests: ok");
