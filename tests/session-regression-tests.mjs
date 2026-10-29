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
const settingsState = new Map();
const recoveryValues = new Map();
globalThis.sessionStorage = { getItem: key => recoveryValues.get(key), setItem: (key, value) => recoveryValues.set(key, value), removeItem: key => recoveryValues.delete(key) };
globalThis.game = {
  user: users.get("host"), users,
  settings: { get: (_m, key) => settingsState.get(key) ?? ({ build: {}, cameraMode: "overview", soundEnabled: false })[key],
    set: async (_m, key, value) => settingsState.set(key, structuredClone(value)) },
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

// If Worker creation fails during F5 recovery, fallback must import the same
// checkpoint rather than placing the cars back on the grid.
{
  const config = { seed: 88201, trackComplexity: 2, laps: 3, requiredPitStops: 1 };
  const entries = [{ id: "car-host", userId: "host", name: "Host", build: cloneDefaultBuild() }];
  const sim = new RaceSimulation({ ...config, entries, track: generateTrack(88201, 2) });
  for (let tick = 0; tick < 420; tick++) sim.step();
  Object.assign(sim.cars[0], { health: sim.cars[0].health - 20, heat: 31, lastInputSequence: 40,
    currentInput: { ...neutralInput(), throttle: 1 } });
  globalThis.Worker = class { constructor() { throw new Error("Worker blocked"); } };
  const saves = [];
  const runtime = new RaceRuntime({ network: { isHost: true, saveRecoveryCheckpoint: value => saves.push(value) },
    isRaceActive: () => true, onFinished() {} });
  const warn = console.warn; console.warn = () => {};
  try { runtime.start({ config, entries, host: true, raceId: "fallback-recovery", checkpoint: sim.exportCheckpoint() }); }
  finally { console.warn = warn; delete globalThis.Worker; }
  assert.equal(runtime.simulationWorker, null);
  assert.equal(runtime.simulation.tick, 420);
  assert.equal(runtime.simulation.cars[0].health, sim.cars[0].health);
  assert.equal(runtime.simulation.cars[0].heat, 31);
  assert.deepEqual(runtime.simulation.cars[0].currentInput, neutralInput());
  assert.equal(runtime.simulation.cars[0].lastInputSequence, -1);
  assert.equal(JSON.parse(saves[0]).tick, 420);
  runtime.stop();
}

// F5 resumes full authority, fences old transport packets even when the saved
// tick precedes the player's last frame, and reassigns the same human cars.
{
  await new Promise(resolve => setImmediate(resolve));
  const { host, player } = setup();
  await host.sessionWrite;
  const sim = new RaceSimulation({ ...host.activeRace.config, entries: host.activeRace.entries,
    track: generateTrack(host.activeRace.config.seed, host.activeRace.config.trackComplexity, host.activeRace.config.environmentTheme) });
  Object.assign(sim, { tick: 6200, simulationTime: 103.333, time: 99.933, countdown: 0, started: true });
  Object.assign(sim.cars[0], { lap: 1, nextSector: 2, pitState: "service", pitWord: "ядро", pitAttemptId: "f5-attempt", pitServiceTimer: 2.7 });
  as("host", () => host.sendSnapshot({ ...sim.snapshot(), tick: 6500 }));
  const staleFrame = structuredClone(sent.findLast(m => m.type === "race-frame"));
  as("player", () => player.sendInput("car-player", { throttle: 1 }, 999));
  advance(8);
  const staleInput = structuredClone(sent.findLast(m => m.type === "race-input"));
  assert.equal(as("host", () => host.saveRecoveryCheckpoint(JSON.stringify(sim.exportCheckpoint()))), true);
  const oldRaceId = host.raceId;
  const dismissedApp = as("player", () => new BigRacesApp(player));
  dismissedApp.dismissedRaceId = oldRaceId;
  as("host", () => host.destroy());
  const reloaded = makeNetwork("host");
  const app = as("host", () => new BigRacesApp(reloaded));
  assert.equal(as("host", () => reloaded.restoreSavedRace()), true);
  assert.equal(JSON.parse(recoveryValues.get(as("host", () => reloaded.recoveryStore.key))).race.raceId, oldRaceId,
    "unacknowledged world lease overwrote the last durable checkpoint");
  await reloaded.sessionWrite;
  assert.equal(JSON.parse(recoveryValues.get(as("host", () => reloaded.recoveryStore.key))).race.raceId, reloaded.raceId);
  assert.notEqual(reloaded.raceId, oldRaceId);
  assert.equal(player.raceId, reloaded.raceId);
  assert.equal(reloaded.activeRace.sessionId, oldRaceId);
  assert.equal(player.lastSnapshot.tick, 6200, "new transport retained the old monotonic tick window");
  assert.equal(dismissedApp.screen, "garage", "F5 pulled a player back into a race they had left");
  assert.equal(app.screen, "race");
  assert.equal(app.runtime.simulation.tick, 6200);
  assert.equal(app.runtime.simulation.cars[0].lap, 1);
  assert.equal(app.runtime.simulation.cars[0].pitAttemptId, "f5-attempt");
  assert.equal(app.runtime.localCarId, "car-host");
  assert.equal(as("player", () => player.participantCarId), "car-player");
  const oldEpoch = staleFrame.hostEpoch;
  let inputs = 0;
  reloaded.on("input", () => inputs++);
  const deliver = message => { for (const listener of [...listeners]) as(listener.owner, () => listener.fn(message)); };
  deliver({ ...staleFrame, id: "delayed-old-frame" });
  deliver({ ...staleInput, id: "delayed-old-input" });
  deliver({ ...staleFrame, type: "lobby-closed", id: "delayed-old-close", hostEpoch: oldEpoch });
  assert.equal(inputs, 0);
  assert.equal(player.lastSnapshot.tick, 6200);
  assert.ok(player.lobby && reloaded.lobby, "old host epoch closed the resumed lobby");
  as("player", () => player.sendInput("car-player", { throttle: 1 }, 1)); advance(8);
  assert.equal(inputs, 1, "fresh low sequence was rejected after resume");
  assert.equal(app.runtime.simulation.cars[1].currentInput.throttle, 1);
  as("host", () => app.shutdown());
  as("player", () => dismissedApp.shutdown());
  as("host", () => reloaded.stopRace());
  await reloaded.sessionWrite;
  assert.deepEqual(settingsState.get("raceSession"), {});
  const nextReload = makeNetwork("host");
  assert.equal(as("host", () => nextReload.restoreSavedRace()), false, "stop revived a stale save");
  as("host", () => reloaded.closeLobby());
  assert.equal(player.lobby, null, "the resumed epoch could not close its lobby");
  nextReload.destroy(); reloaded.destroy(); player.destroy();
}

// A player's F5 keeps the race ID but must retire its old input namespace.
// Late input/ready/claim packets cannot poison the new small sequence numbers.
{
  const {host,player}=setup(),assignments=[];
  const simulation=new RaceSimulation({track:generateTrack(88201,2),entries:host.activeRace.entries});
  host.on('input',m=>simulation.setInput(m.carId,m.input,m.sequence));
  let claims=0;
  host.on('claimControl',m=>{claims++;simulation.claimControl(m.carId);});
  player.on('controlAssignment',m=>assignments.push(m));
  as('player',()=>player.beginControlSession('car-player'));
  as('player',()=>player.requestControlAssignment());
  assert.equal(claims,1,'assignment was confirmed before establishing the host input window');
  assert.equal(assignments.length,1);
  as('player',()=>player.sendInput('car-player',{throttle:1,steer:1},500));advance(20);
  const oldInput=structuredClone(sent.findLast(m=>m.type==='race-input'));
  const oldReady=structuredClone(sent.findLast(m=>m.type==='race-ready'));
  const car=simulation.cars.find(c=>c.id==='car-player');
  assert.equal(car.lastInputSequence,500);
  player.destroy();advance(300);
  const reloaded=makeNetwork('player');
  as('player',()=>reloaded.requestState());
  assert.equal(claims,1,'state discovery implicitly reclaimed the car');
  as('player',()=>reloaded.beginControlSession('car-player'));
  as('player',()=>reloaded.requestControlAssignment());
  assert.equal(claims,2);
  as('player',()=>reloaded.sendInput('car-player',{throttle:1,steer:-1},1));advance(20);
  const freshInput=sent.findLast(m=>m.type==='race-input');
  assert.notEqual(freshInput.controlSession,oldInput.controlSession);
  assert.equal(car.lastInputSequence,1);
  as('player',()=>game.socket.emit('test',{...oldInput,id:'late-prior-input',sequence:501}));
  advance(300);
  as('player',()=>game.socket.emit('test',{...oldReady,id:'late-prior-ready'}));
  as('player',()=>game.socket.emit('test',{...oldReady,type:'claim-control',id:'late-prior-claim'}));
  as('player',()=>reloaded.sendInput('car-player',{throttle:.3,steer:-.5},2));advance(20);
  assert.equal(car.lastInputSequence,2,'prior connection poisoned the new input sequence');
  assert.equal(car.currentInput.steer,-.5);
  assert.equal(claims,2,'retired control claim reopened the host sequence');
  advance(300);
  as('player',()=>reloaded.requestControlAssignment());
  assert.equal(claims,2,'duplicate current assignment reset live control');
  assert.equal(car.lastInputSequence,2);
  // A delayed assignment for the old namespace cannot confirm a new runtime.
  let confirmed=0;reloaded.on('controlAssignment',()=>confirmed++);
  const priorAssignment=sent.find(m=>m.type==='control-assignment'&&m.controlSession===oldInput.controlSession);
  as('host',()=>game.socket.emit('test',{...priorAssignment,id:'late-prior-assignment'}));
  assert.equal(confirmed,0);
  host.destroy();reloaded.destroy();
}

// A queued world-setting write must recheck its owner before issuing I/O.
// Otherwise a GM who has already lost authority can invalidate the winner's F5.
{
  await new Promise(resolve=>setImmediate(resolve));
  const {host,player}=setup();
  const oldRace=host.raceId;
  users.set('winner',{id:'winner',name:'Winner',isGM:true,active:true});
  const lobby={...host.lobby,hostId:'winner',hostEpoch:1,hostClaimedAt:Date.now(),hostClaimId:'winning-claim',phase:'lobby'};
  const winnerLease={raceId:'winner-race',lobbyId:lobby.id,hostId:'winner',hostEpoch:1};
  as('winner',()=>game.socket.emit('test',{type:'host-claim',id:'new-authority-before-write',protocolVersion:host.activeRace.protocolVersion,
    senderId:'winner',sentAt:Date.now(),lobby,abortRace:true,abortedRaceId:oldRace}));
  settingsState.set('raceSession',winnerLease);
  await host.sessionWrite;
  assert.deepEqual(settingsState.get('raceSession'),winnerLease,'obsolete GM overwrote the current world lease');
  host.destroy();player.destroy();users.delete('winner');
}

// Superseding queued operations must still persist a newly started race, and
// an explicit close must clear its own lease even after lobby becomes null.
{
  settingsState.delete('raceSession');
  const {host,player}=setup();
  const entries=host.activeRace.entries;
  as('host',()=>host.stopRace());
  as('host',()=>host.startRace(entries));
  await host.sessionWrite;
  assert.equal(settingsState.get('raceSession').raceId,host.raceId);
  as('host',()=>host.closeLobby());
  await host.sessionWrite;
  assert.deepEqual(settingsState.get('raceSession'),{});
  host.destroy();player.destroy();
}

// A newer durable owner can be visible before its socket claim arrives. The
// equal-epoch tie-break must agree with lobby election, not just compare epochs.
for(const epoch of [0,1]) {
  settingsState.delete('raceSession');
  const {host,player}=setup();
  const durable={raceId:'durable-winner',protocol:host.activeRace.protocolVersion,lobbyId:host.lobby.id,
    hostId:'winner',hostInstanceId:'winner-instance',hostEpoch:epoch,hostClaimedAt:1,hostClaimId:'winner'};
  settingsState.set('raceSession',durable);
  await host.sessionWrite;
  assert.deepEqual(settingsState.get('raceSession'),durable,'pending write defeated the durable owner');
  host.destroy();player.destroy();
}

// A resumed race-state may precede the replacement host metadata. Existing
// lobby knowledge must not make that reply disappear permanently.
for(const claimFirst of [false,true]) {
  settingsState.delete('raceSession');
  const {host,player}=setup(),previous=player.raceId;
  const lobby={...host.lobby,hostEpoch:1,hostInstanceId:'replacement-instance',hostClaimedAt:1,hostClaimId:'replacement'};
  const race={...host.activeRace,raceId:'replacement-race',hostInstanceId:lobby.hostInstanceId};
  const meta={senderId:'host',sentAt:Date.now(),protocolVersion:race.protocolVersion,hostEpoch:1,hostInstanceId:lobby.hostInstanceId};
  as('host',()=>game.socket.emit('test',{...meta,type:'race-state',id:'resumed-state-first',targetId:'player',lobbyId:lobby.id,race,frame:null,results:null}));
  assert.equal(player.raceId,previous,'unconfirmed ownership was accepted');
  if(claimFirst)as('host',()=>game.socket.emit('test',{...meta,type:'host-claim',id:'resumed-claim-later',lobby,abortRace:true,abortedRaceId:previous}));
  as('host',()=>game.socket.emit('test',{...meta,type:'lobby-state',id:'resumed-owner-later',lobby}));
  assert.equal(player.raceId,race.raceId,'replacement state was lost before its ownership metadata');
  assert.equal(player.pendingRaceState,null);
  host.destroy();player.destroy();
}

// The same GM account in two tabs must have exactly one simulation owner.
// A secondary tab spectates, including when the original owner resumes via F5.
{
  settingsState.delete('raceSession');
  const previousWorker=globalThis.Worker;let liveWorkers=0;
  globalThis.Worker=class {
    constructor(){liveWorkers++;this.alive=true;}
    addEventListener(){}removeEventListener(){}postMessage(){}
    terminate(){if(this.alive){liveWorkers--;this.alive=false;}}
  };
  const {host,player}=setup(),duplicate=makeNetwork('host');
  const primaryApp=as('host',()=>new BigRacesApp(host));
  const secondaryApp=as('host',()=>new BigRacesApp(duplicate));
  as('host',()=>duplicate.requestState());
  assert.equal(as('host',()=>duplicate.isHost),false);
  assert.equal(secondaryApp.runtime.localCarId,null);
  const entries=host.activeRace.entries;
  as('host',()=>host.stopRace());as('host',()=>host.startRace(entries));
  assert.equal(liveWorkers,1,'a second GM tab forked the authoritative simulation');
  assert.equal(primaryApp.runtime.isHost,true);assert.equal(secondaryApp.runtime.isHost,false);
  assert.equal(secondaryApp.runtime.localCarId,null,'secondary GM tab claimed the primary driver');
  await host.sessionWrite;
  const simulation=new RaceSimulation({...host.activeRace.config,track:generateTrack(88201,2),entries});
  as('host',()=>host.saveRecoveryCheckpoint(JSON.stringify(simulation.exportCheckpoint())));
  as('host',()=>primaryApp.shutdown());host.destroy();
  assert.equal(liveWorkers,0);
  const resumed=makeNetwork('host'),resumedApp=as('host',()=>new BigRacesApp(resumed));
  assert.equal(as('host',()=>resumed.restoreSavedRace()),true);
  await resumed.sessionWrite;
  assert.equal(liveWorkers,1,'F5 created competing workers in the other GM tab');
  assert.equal(resumedApp.runtime.isHost,true);
  assert.equal(secondaryApp.runtime.isHost,false);
  assert.equal(secondaryApp.runtime.localCarId,null);
  assert.notEqual(resumed.lobby.hostInstanceId,host.instanceId);
  as('host',()=>resumed.stopRace());resumedApp.shutdown();secondaryApp.shutdown();
  resumed.destroy();duplicate.destroy();player.destroy();
  assert.equal(liveWorkers,0);
  if(previousWorker===undefined)delete globalThis.Worker;else globalThis.Worker=previousWorker;
}

console.log("session-regression-tests: ok (single host instance, F5 restore, world-lease fencing, control sessions, coalescing, isolation, garage, worker authority, reordered reconnect, explicit spectator resume)");
