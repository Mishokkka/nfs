import assert from "node:assert/strict";
import { RaceNetwork } from "../scripts/network.js";
import { RaceSimulation, neutralInput } from "../scripts/physics.js";
import { cloneDefaultBuild } from "../scripts/catalog.js";
import { generateTrack } from "../scripts/track.js";

let clock = 10000, nextTimer = 1;
const timers = new Map(), listeners = [], sent = [];
const wireDelay = new Map();
Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => clock, timeOrigin: 0 } });
const users = new Map([
  ["host", { id: "host", name: "Host", isGM: true, active: true }],
  ["player", { id: "player", name: "Player", isGM: false, active: true }],
  ["observer", { id: "observer", name: "Observer", isGM: false, active: true }]
]);
const as = (id, fn) => { const before = game.user; game.user = users.get(id); try { return fn(); } finally { game.user = before; } };
globalThis.setTimeout = (fn, delay) => { const id = nextTimer++; timers.set(id, { at: clock + delay, fn, owner: game.user.id }); return id; };
globalThis.clearTimeout = id => timers.delete(id);
const advance = ms => {
  const until = clock + ms;
  for (;;) {
    const next = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    timers.delete(next[0]); clock = next[1].at; as(next[1].owner, next[1].fn);
  }
  clock = until;
};
globalThis.window = { setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, addEventListener() {} };
globalThis.document = { hidden: false, activeElement: null };
globalThis.HTMLElement = class {};
globalThis.HTMLInputElement = class {};
globalThis.HTMLSelectElement = class {};
globalThis.HTMLFormElement = class {};
globalThis.Hooks = { on: () => 1, off() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
class MockApp {
  constructor() { this.rendered = false; this.element = null; this.renderCalls = 0; }
  render() { this.rendered = true; this.renderCalls++; return Promise.resolve(this); }
  async _onRender() {} async _preClose() {} async _onClose() {}
}
globalThis.foundry = {
  utils: { deepClone: structuredClone, mergeObject: (a, b) => ({ ...structuredClone(a), ...structuredClone(b) }) },
  applications: { api: { ApplicationV2: MockApp, HandlebarsApplicationMixin: a => a, DialogV2: { confirm: async () => true } } }
};
globalThis.game = {
  user: users.get("host"), users,
  settings: { get: (_m, key) => ({ build: {}, cameraMode: "overview", soundEnabled: false })[key], set: async () => {} },
  socket: {
    on(_name, fn) { listeners.push({ owner: game.user.id, fn }); },
    off(_name, fn) { const index = listeners.findIndex(x => x.fn === fn); if (index >= 0) listeners.splice(index, 1); },
    emit(_name, message) {
      sent.push(structuredClone(message));
      const deliver = () => {
        for (const listener of [...listeners]) as(listener.owner, () => listener.fn(structuredClone(message)));
      };
      if (wireDelay.has(message.type)) setTimeout(deliver, wireDelay.get(message.type));
      else deliver();
    }
  }
};
const { BigRacesApp } = await import("../scripts/app/racing-app.js");
const { RaceRuntime } = await import("../scripts/app/race-runtime.js");
const { RaceInput } = await import("../scripts/app/race-input.js");
const makeNetwork = id => as(id, () => { const n = new RaceNetwork(); n.initialize(); return n; });
const setup = () => {
  listeners.length = 0; sent.length = 0; timers.clear(); clock += 1000;
  wireDelay.clear();
  const host = makeNetwork("host"), player = makeNetwork("player");
  let hostStarts = 0;
  host.on("start", () => hostStarts++);
  as("host", () => host.createLobby({ build: cloneDefaultBuild(), config: { seed: 88201, bots: 0 } }));
  as("player", () => player.join(cloneDefaultBuild()));
  as("host", () => host.startRace(Object.values(host.lobby.participants).map(p => ({ id: "car-" + p.userId, userId: p.userId, build: p.build, name: p.userName }))));
  assert.equal(hostStarts, 1, "the first local race-init did not start the host runtime");
  return { host, player };
};

// The sole GM can discover and explicitly abort an orphaned race after reload.
{
  const { host, player } = setup();
  const raceId = player.raceId;
  as("host", () => host.destroy());
  const reloaded = makeNetwork("host");
  wireDelay.set("session-offer", 120);
  as("host", () => reloaded.requestState());
  advance(1);
  as("host", () => reloaded.requestState());
  advance(119);
  assert.equal(reloaded.lobby.id, player.lobby.id);
  assert.equal(reloaded.hostOffline, true);
  assert.equal(as("host", () => reloaded.isHost), false, "discovery started an authority without a simulation");
  assert.equal(as("player", () => player.recoverOrphanedSession()), false);
  assert.equal(as("host", () => reloaded.recoverOrphanedSession()), true);
  assert.equal(player.raceId, null);
  assert.equal(reloaded.raceId, null);
  assert.equal(player.lobby.phase, "lobby");
  assert.equal(player.lobby.hostEpoch, reloaded.lobby.hostEpoch);
  assert.ok(sent.some(m => m.type === "host-claim" && m.abortedRaceId === raceId));
  reloaded.destroy(); player.destroy();
}

// Rapid key changes coalesce to the latest state within 8 ms, including release.
{
  const { host, player } = setup();
  const received = [];
  host.on("input", message => received.push(message));
  const input = new RaceInput({ getLocalCarId: () => "car-player", getSnapshot: () => null,
    isRaceActive: () => true, onInput: (value, sequence) => as("player", () => player.sendInput("car-player", value, sequence)) });
  as("player", () => { input.keys.add("KeyW"); input.dispatch(undefined, { force: true }); });
  advance(1);
  as("player", () => { input.keys.add("KeyD"); input.dispatch(undefined, { force: true }); });
  assert.equal(received.length, 1);
  advance(7);
  assert.equal(received.at(-1).input.steer, 1);
  assert.equal(received.at(-1).sequence, 2);
  advance(1);
  as("player", () => input.neutralize());
  advance(7);
  assert.deepEqual(received.at(-1).input, neutralInput());
  // Reordered commands cannot replace a newer release, and stop cancels timers.
  as("player", () => player.sendInput("car-player", { throttle: 1 }, 1));
  advance(8);
  assert.deepEqual(received.at(-1).input, neutralInput());
  as("player", () => player.sendInput("car-player", { throttle: 1 }, 4));
  advance(1);
  as("player", () => player.sendInput("car-player", { steer: 1 }, 5));
  const before = received.length;
  as("host", () => host.stopRace()); advance(20);
  assert.equal(received.length, before);
  host.destroy(); player.destroy();
}

// Runtime events are scoped to a chosen race. Practice and unopened observers
// survive start/snapshot/results/stop from another group in the same world.
{
  const { host, player } = setup();
  const observer = makeNetwork("observer");
  const app = as("observer", () => new BigRacesApp(observer));
  as("observer", () => observer.requestState());
  for (const fn of observer.handlers.start) as("observer", () => fn(host.activeRace));
  assert.equal(app.screen, "garage");
  assert.equal(app.rendered, false);
  app.runtime.start({ host: false, practice: true, raceId: "practice", config: {}, entries: [] });
  app.screenStateMachine.transition("race");
  const localSnapshot = { sentinel: true };
  app.runtime.currentSimulationSnapshot = localSnapshot;
  for (const [event, data] of [["start", host.activeRace], ["snapshot", {}], ["results", {}], ["stop", {}]]) {
    for (const fn of observer.handlers[event]) as("observer", () => fn(data));
  }
  assert.equal(app.runtime.currentRaceId, "practice");
  assert.equal(app.runtime.currentSimulationSnapshot, localSnapshot);
  assert.equal(app.screen, "race");
  app.shutdown(); host.destroy(); player.destroy(); observer.destroy();
}

// A participant editing the garage is not navigated away by someone joining.
{
  const { host, player } = setup();
  as("host", () => host.stopRace());
  const app = as("player", () => new BigRacesApp(player));
  app.rendered = true;
  app.garage.build.name = "Черновик";
  for (const fn of player.handlers.lobby) as("player", () => fn(player.lobby));
  assert.equal(app.screen, "garage");
  assert.equal(app.garage.build.name, "Черновик");
  assert.equal(app.renderCalls, 0);
  app.shutdown(); host.destroy(); player.destroy();
}

// A worker frame must go straight to the socket for the active host, and never
// for practice. Exercise the real message handler instead of matching its text.
{
  let worker;
  globalThis.Worker = class {
    constructor() { worker = this; this.handlers = new Map(); }
    addEventListener(type, fn) { this.handlers.set(type, fn); }
    removeEventListener(type) { this.handlers.delete(type); }
    postMessage() {} terminate() {}
  };
  const frames = [];
  const network = { isHost: true, sendSnapshot: (snapshot, timing) => frames.push({ snapshot, timing }) };
  const runtime = new RaceRuntime({ network, isRaceActive: () => true, onFinished() {} });
  const entries = [{ id: "car", userId: "host", build: cloneDefaultBuild() }];
  for (const practice of [false, true]) {
    runtime.start({ entries, host: true, practice, raceId: "runtime", config: {} });
    const snapshot = new RaceSimulation({ track: generateTrack(88201, 2), entries }).snapshot();
    worker.handlers.get("message")({ data: { type: "snapshot", raceId: "runtime", snapshot, generatedAt: clock } });
    assert.equal(frames.length, 1);
  }
  network.isHost = false;
  runtime.practice = false;
  worker.handlers.get("message")({ data: { type: "snapshot", raceId: "runtime", snapshot: frames[0].snapshot, generatedAt: clock } });
  assert.equal(frames.length, 1, "former host kept publishing authoritative frames");
  runtime.destroy(); delete globalThis.Worker;
}

// Probe timestamps are local monotonic times; the midpoint maps simulation time
// correctly without assuming that two computers share an epoch or wall clock.
{
  const { host, player } = setup();
  wireDelay.set("race-ping", 100); wireDelay.set("race-pong", 100);
  const simulation = new RaceSimulation({ track: generateTrack(88201, 2), entries: host.activeRace.entries });
  const snapshot = simulation.snapshot(); snapshot.simulationTime = 7;
  const sentAt = clock;
  as("host", () => host.sendSnapshot(snapshot));
  advance(200);
  assert.equal(player.timing.rttMs, 200);
  assert.ok(Math.abs(player.timing.clockOffset - (sentAt / 1000 - 7)) < 1e-8);
  host.destroy(); player.destroy();
}


// Delayed control/state packets must not rewind a newer race or resurrect one
// that the GM has already stopped. Lobby revisions also order configuration.
{
  const { host, player } = setup();
  const firstInit = structuredClone(sent.find(m => m.type === "race-init"));
  as("player", () => player.requestState());
  const staleState = structuredClone(sent.find(m => m.type === "race-state" && m.targetId === "player"));
  const staleLobby = structuredClone(sent.find(m => m.type === "lobby-state"));
  const simulation = new RaceSimulation({ track: generateTrack(88201, 2), entries: host.activeRace.entries });
  const snapshot = simulation.snapshot(); snapshot.tick = 120; snapshot.simulationTime = 2;
  as("host", () => host.sendSnapshot(snapshot));
  const lastTick = player.lastSnapshot.tick;
  as("host", () => game.socket.emit("test", { ...staleState, id: "late-state-before-stop" }));
  assert.equal(player.lastSnapshot.tick, lastTick);
  as("host", () => host.stopRace());
  const revision = player.lobby.revision;
  for (const [i, message] of [firstInit, staleState, staleLobby].entries()) {
    as("host", () => game.socket.emit("test", { ...message, id: "retired-message-" + i }));
  }
  assert.equal(player.raceId, null);
  assert.equal(player.lobby.phase, "lobby");
  assert.equal(player.lobby.revision, revision);
  as("host", () => host.closeLobby());
  as("host", () => game.socket.emit("test", { ...staleLobby, id: "closed-lobby-state" }));
  assert.equal(player.lobby, null);
  host.destroy(); player.destroy();
}

// A reloading player still restores when a full race-state reply overtakes the
// lobby metadata. Late race-init must not remount the newly restored runtime.
{
  const { host, player } = setup();
  const simulation = new RaceSimulation({ track: generateTrack(88201, 2), entries: host.activeRace.entries });
  const snapshot = simulation.snapshot(); snapshot.tick = 2;
  as("host", () => host.sendSnapshot(snapshot));
  const init = structuredClone(sent.find(m => m.type === "race-init"));
  player.destroy();
  const returning = makeNetwork("player");
  const app = as("player", () => new BigRacesApp(returning));
  wireDelay.set("lobby-state", 120);
  as("player", () => returning.requestState());
  assert.equal(returning.raceId, null, "state was accepted without known lobby authority");
  advance(120);
  assert.equal(returning.raceId, host.raceId);
  assert.equal(returning.lastSnapshot.tick, 2);
  assert.equal(app.runtime.localCarId, "car-player");
  assert.equal(app.screen, "race");
  const renders = app.renderCalls;
  as("host", () => game.socket.emit("test", { ...init, id: "late-init-after-restore" }));
  assert.equal(app.renderCalls, renders);
  app.shutdown(); host.destroy(); returning.destroy();
}

// Leaving is a persistent choice while the user browses Garage/Lobby. Only an
// explicit Resume action may bring the same retired driver back as a spectator.
{
  const { host, player } = setup();
  const beforeUser = game.user;
  game.user = users.get("player");
  const simulation = new RaceSimulation({ track: generateTrack(88201, 2), entries: host.activeRace.entries });
  host.on("leaveRace", message => { simulation.handToBot(message.carId); host.sendSnapshot(simulation.snapshot()); });
  const app = new BigRacesApp(player);
  const events = new Map();
  app.element = { querySelector: () => null, addEventListener: (type, fn) => events.set(type, fn), contains: () => true };
  for (const fn of player.handlers.start) fn(player.activeRace);
  await app._onRender({}, {});
  const click = async action => {
    const button = { dataset: { action } };
    events.get("click")({ target: { closest: () => button }, preventDefault() {} });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  };
  const raceId = player.raceId;
  await click("abandon-race");
  assert.equal(app.dismissedRaceId, raceId);
  assert.equal(app.screen, "lobby");
  await click("show-garage");
  advance(300);
  await click("show-lobby");
  assert.equal(app.screen, "lobby", "a state reply reopened a race the user left");
  advance(300);
  await click("resume-race");
  assert.equal(app.screen, "race");
  assert.equal(app.runtime.localCarId, null, "resuming an abandoned car restored manual ownership");
  app.shutdown(); host.destroy(); player.destroy(); game.user = beforeUser;
}

console.log("session-regression-tests: ok (recovery, coalescing, isolation, garage, worker authority, reordered reconnect, explicit spectator resume)");
