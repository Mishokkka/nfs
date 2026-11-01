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
  const rootElement = new FakeElement();
  rootElement.querySelector = (selector) => bySelector.get(selector) ?? null;
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
  assert.equal(overlay.focusCount, 1, "waiting for the authority must keep focus in the pit dialog");
  let trapped = 0;
  rootElement.listeners.get("keydown")({ key: "Tab", preventDefault() { trapped++; }, stopPropagation() {} });
  assert.equal(trapped, 1);
  assert.equal(overlay.focusCount, 2, "Tab escaped the busy pit dialog");

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
  rootElement.listeners.get("keydown")({ key: "Tab", shiftKey: true, preventDefault() { trapped++; }, stopPropagation() {} });
  assert.equal(input.focusCount, 3, "Shift+Tab escaped the active pit input");
  rootElement.listeners.get("keydown")({ key: "Tab", ctrlKey: true, preventDefault() { trapped++; }, stopPropagation() {} });
  assert.equal(trapped, 2, "browser Ctrl+Tab shortcut was trapped");
  pit.update({ pitState: "track" });
  rootElement.listeners.get("keydown")({ key: "Tab", preventDefault() { trapped++; }, stopPropagation() {} });
  assert.equal(trapped, 2, "hidden pit dialog intercepted normal keyboard navigation");
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
// The delayed focus retries must respect a later user blur, and must never
// refocus driving underneath an interactive service dialog.
{
  const priorDocument=globalThis.document,priorAdd=window.addEventListener;
  const canvas=new FakeElement();let service=false;
  globalThis.document={activeElement:canvas,hidden:false,addEventListener(){}};
  window.addEventListener=()=>{};
  const input=new RaceInput({getLocalCarId:()=> 'driver',getSnapshot:()=>({cars:[{id:'driver',pitState:service?'service':'track'}]}),
    isRaceActive:()=>true,onInput(){},onCameraMode(){},onToggleCamera(){},onToggleMinimap(){},onVisibilityChange(){}});
  input.mount(canvas,{querySelector:()=>null});input.restoreFocus();
  const frame=frameCallbacks.get(input.restoreFrame),timer=window.timers.get(input.restoreTimer)?.callback;
  document.activeElement=new FakeInput();canvas.emit('blur');const count=canvas.focusCount;
  frame?.(0);timer?.();await Promise.resolve();
  assert.equal(canvas.focusCount,count,'old focus retries overrode a newer user focus');
  service=true;input.restoreFocus();await Promise.resolve();
  assert.equal(canvas.focusCount,count,'focus jumped from pit input to driving');
  input.destroyListeners();globalThis.document=priorDocument;
  if(priorAdd===undefined)delete window.addEventListener;else window.addEventListener=priorAdd;
}

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

// Losing local ownership must close an existing service dialog once, without
// copying the followed leader's interactive pit state to a spectator.
{
  const updates=[];
  const hud=new RaceHud({pitUi:{update:car=>updates.push(car)}});
  const service={id:'own',pitState:'service',pitAttemptId:'a',pitWord:'ядро'};
  hud.update(service,{cars:[service]});
  hud.update(null,{cars:[service]});
  hud.update(null,{cars:[service]});
  assert.equal(updates.length,2);
  assert.equal(updates[0].pitState,'service');
  assert.notEqual(updates[1].pitState,'service','spectator retained an interactive pit dialog');
}

// A lobby update may arrive before blur/change commits a typed value. Preserve
// that draft and its caret, but never carry it into another lobby or a disabled
// control after the host role changes.
{
  const {ViewState}=await load('scripts/app/view-state.js');
  const state=new ViewState(),field=new FakeInput();
  field.name='seed';field.type='number';field.value='777888';field.selectionStart=null;field.selectionEnd=null;
  field.matches=()=>true;field.closest=()=>({dataset:{form:'lobby-config'}});
  const disclosure={dataset:{nfsDisclosure:'track-code'},open:true};
  const scroll={scrollTop:231};
  const shell={dataset:{nfsScreen:'lobby',nfsScope:'lobby-a'}};
  const rootElement={contains:el=>el===field,querySelector:s=>s==='[data-nfs-screen]'?shell:s==='.nfs-view'?scroll:null,
    querySelectorAll:s=>s==='[data-nfs-disclosure]'?[disclosure]:[field]};
  const priorDocument=globalThis.document;globalThis.document={activeElement:field};
  state.capture(rootElement);
  field.value='88201';disclosure.open=false;scroll.scrollTop=0;
  state.restore(rootElement);
  assert.equal(field.value,'777888');assert.equal(field.focusCount,1);assert.equal(disclosure.open,true);assert.equal(scroll.scrollTop,231);
  shell.dataset.nfsScope='lobby-b';field.value='123';state.restore(rootElement);assert.equal(field.value,'123');
  shell.dataset.nfsScope='lobby-a';field.disabled=true;state.restore(rootElement);assert.equal(field.value,'123');
  field.disabled=false;field.type='text';field.selectionStart=2;field.selectionEnd=4;field.value='late edit';
  let selection;field.setSelectionRange=(...range)=>selection=range;
  state.capture(rootElement);field.value='stale template';state.restore(rootElement);
  assert.equal(field.value,'late edit');assert.deepEqual(selection,[2,4]);
  field.setAttribute('aria-invalid','true');field.validity={customError:true};field.validationMessage='Введите целое число';
  let restoredValidity;field.setCustomValidity=message=>restoredValidity=message;
  state.capture(rootElement);field.setAttribute('aria-invalid','false');state.restore(rootElement);
  assert.equal(field.getAttribute('aria-invalid'),'true');assert.equal(restoredValidity,'Введите целое число');
  state.capture(null);assert.equal(state.saved,null);
  globalThis.document=priorDocument;
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
