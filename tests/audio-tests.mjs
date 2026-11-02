import assert from "node:assert/strict";
import { prepareLoopBuffer } from "../scripts/audio/loop-buffer.js";
import { BufferedLoops } from "../scripts/audio/buffered-loops.js";
import { RaceSoundManager } from "../scripts/app/sound-manager.js";

class Buffer {
  constructor(channels, length, sampleRate) {
    Object.assign(this, { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate });
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(channel) { return this.channels[channel]; }
}
class Param {
  constructor(value = 0) { this.value = value; this.targets = []; }
  cancelAndHoldAtTime() {}
  setValueAtTime(value) { this.value = value; }
  setTargetAtTime(value, now, seconds) { this.value = value; this.targets.push({ value, now, seconds }); }
}
class Node {
  connect() {} disconnect() { this.disconnected = true; }
}
class Context {
  constructor() { this.state = "suspended"; this.currentTime = 1; this.sources = []; this.resumeCalls = 0; this.decodeCalls = 0; this.destination = {}; contexts.push(this); }
  createGain() { return Object.assign(new Node(), { gain: new Param(1) }); }
  createBuffer(channels, length, rate) { return new Buffer(channels, length, rate); }
  createBufferSource() {
    const source = Object.assign(new Node(), { playbackRate: new Param(1), starts: 0, stops: [],
      start() { this.starts++; }, stop(at) { this.stops.push(at); } });
    this.sources.push(source); return source;
  }
  async decodeAudioData() { this.decodeCalls++; return tone(this, 1000); }
  resume() { this.resumeCalls++; if (this.rejectAutoplay) return Promise.reject(new Error("autoplay blocked")); this.state = "running"; return Promise.resolve(); }
  close() { this.state = "closed"; return Promise.resolve(); }
}
const contexts = [], requests = [], pending = new Map();
let now = 1000;
Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => now } });
globalThis.AudioContext = Context;
globalThis.fetch = async (path, options) => {
  requests.push({ path, options });
  if (pending.has(path)) await pending.get(path).promise;
  if (path === "bad") throw new Error("decode fixture failed");
  return { ok: true, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(16) };
};
const defer = path => {
  let resolve; const promise = new Promise(done => { resolve = done; });
  pending.set(path, { promise, resolve }); return resolve;
};
const tone = (context, rate, channels = 1) => {
  const buffer = context.createBuffer(channels, rate, rate);
  for (let c = 0; c < channels; c++) for (let i = rate / 10; i < rate * .9; i++) buffer.channels[c][i] = .5 * Math.sin((i - rate / 10) * Math.PI * 2 * 53 / rate + c * .4);
  return buffer;
};

// Loop preparation removes encoder/file padding, keeps stereo, and wraps at
// adjacent source samples. Rendered browser probes additionally test the DSP.
for (const rate of [44100, 48000]) for (const channels of [1, 2]) {
  const context = new Context(), input = tone(context, rate, channels);
  const prepared = prepareLoopBuffer(context, input);
  assert.equal(prepared.numberOfChannels, channels);
  assert.equal(prepared.sampleRate, rate);
  assert.ok(prepared.duration > .65 && prepared.duration < .8, "did not remove quiet edge padding/overlap");
  for (let c = 0; c < channels; c++) {
    const data = prepared.getChannelData(c);
    assert.ok(Math.abs(data[0] - data.at(-1)) < .01, "periodic buffer has a discontinuity at its wrap");
    assert.ok(data.every(Number.isFinite));
    let minimum = Infinity;
    for (let i = 0; i < data.length; i += Math.round(rate * .01)) {
      const window = data.subarray(i, Math.min(data.length, i + Math.round(rate * .01)));
      const rms = Math.sqrt(window.reduce((sum, x) => sum + x * x, 0) / window.length);
      if (window.length > rate * .009) minimum = Math.min(minimum, rms);
    }
    assert.ok(minimum > .15, "tonal overlap cancelled into a recurring gap");
  }
  const silent = context.createBuffer(channels, 200, rate);
  assert.equal(prepareLoopBuffer(context, silent), silent, "silence was amplified");
  const seamless = context.createBuffer(channels, rate, rate);
  for (const channel of seamless.channels) for (let i = 0; i < rate; i++) channel[i] = .5 * Math.sin(i * Math.PI * 2 * 100 / rate);
  assert.equal(prepareLoopBuffer(context, seamless), seamless, "already-periodic recording lost its intended period");
}

// Native sources are created once; hundreds of telemetry updates neither seek
// nor restart the source. A file swap fades only that slot after it is ready.
{
  const context = new Context(), errors = [], bank = new BufferedLoops({ context, onError: (...args) => errors.push(args) });
  await Promise.all([bank.setLoop("engine", "engine"), bank.setLoop("wind", "engine")]);
  assert.equal(context.decodeCalls, 1, "shared paths were decoded twice");
  assert.equal(context.sources.length, 2);
  const original = bank.slots.get("engine").voice, wind = bank.slots.get("wind").voice;
  for (let i = 0; i < 500; i++) { context.currentTime += .09; bank.setLevel("engine", i % 2 ? .5 : .7, .68 + i % 10 * .1); }
  await bank.setLoop("engine", "engine");
  assert.equal(original.source.starts, 1); assert.equal(original.source.stops.length, 0);
  assert.equal(context.sources.length, 2);
  assert.ok(original.gain.gain.targets.every(value => value.seconds > 0));
  assert.ok(original.source.playbackRate.targets.every(value => value.seconds > 0));
  bank.setLevel("engine", .2, 1);
  for (let i = 1; i <= 1000; i++) bank.setLevel("engine", .2 + i * .0001, 1 + i * .0001);
  assert.ok(Math.abs(original.gain.gain.value - .3) < .0011, "small level changes never accumulated");
  assert.ok(Math.abs(original.source.playbackRate.value - 1.1) < .0011, "small pitch changes never accumulated");
  const ready = defer("replacement"), replacing = bank.setLoop("engine", "replacement");
  assert.equal(bank.slots.get("engine").voice, original);
  assert.equal(original.source.stops.length, 0, "old sound stopped while replacement was loading");
  ready(); await replacing;
  assert.notEqual(bank.slots.get("engine").voice, original);
  assert.equal(bank.slots.get("wind").voice, wind);
  assert.ok(original.source.stops[0] > context.currentTime);
  const current = bank.slots.get("engine").voice;
  await bank.setLoop("engine", "bad");
  assert.equal(bank.slots.get("engine").voice, current, "failed replacement silenced the old sound");
  assert.equal(errors.length, 1);
  bank.stop();
  assert.equal(bank.stats().bufferBytes, 0);
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(bank.voices.size, 0);
  assert.equal(context.state, "suspended", "bank closed a borrowed context");
}

// Disposed or superseded loads must never resurrect a source. Oversized clips
// are refused before preparation rather than allocating an unbounded PCM copy.
{
  const context = new Context(), bank = new BufferedLoops({ context });
  const ready = defer("obsolete"), loading = bank.setLoop("engine", "obsolete");
  await bank.setLoop("engine", "current");
  ready(); await loading;
  assert.equal(context.sources.length, 1);
  const later = defer("after-stop"), load = bank.setLoop("wind", "after-stop");
  bank.stop(); later(); await load;
  assert.equal(context.sources.length, 1);
  assert.equal(requests.at(-1).options.signal.aborted, true);
  const errors = [], limited = new BufferedLoops({ context, onError: (_name, error) => errors.push(error) });
  context.decodeAudioData = async () => ({ length: 48000 * 121, sampleRate: 48000, numberOfChannels: 1, duration: 121 });
  await limited.setLoop("engine", "too-long");
  assert.match(errors[0].message, /120 seconds/);
  assert.equal(context.sources.length, 1);
  limited.stop();
}

// Exercise the real manager: volume/settings changes and DOM remount preserve
// phase; disabled/hidden states mute; blocked autoplay retries only on gesture.
{
  const settings = new Map(), handlers = new Map(), rootHandlers = new Map();
  globalThis.game = { settings: { get: (_id, key) => settings.get(key) } };
  globalThis.document = { hidden: false };
  globalThis.Hooks = { on: (name, callback) => { handlers.set(name, callback); return name; }, off: name => handlers.delete(name) };
  globalThis.ui = { notifications: { warn() {} } };
  globalThis.Audio = class { constructor() { this.listeners = new Map(); } play() { return Promise.resolve(); } pause() { this.paused = true; } addEventListener(name, callback) { this.listeners.set(name, callback); } };
  const root = { addEventListener: (name, callback) => rootHandlers.set(name, callback) };
  const manager = new RaceSoundManager({ getLocalCarId: () => "local" });
  manager.mount(root);
  const bank = manager.loopBank, context = bank.context;
  context.rejectAutoplay = true;
  await Promise.all([...bank.slots.values()].map(slot => slot.pending));
  await Promise.resolve(); await Promise.resolve();
  const snapshot = { started: true, cars: [{ id: "local", vx: 300, vy: 0, angle: 0, pitState: "track", health: 100 }] };
  const resumes = context.resumeCalls;
  manager.update({ ...snapshot, started: false, countdown: 3 });
  assert.ok(bank.slots.get("engine").volume > 0, "engine was silent during the countdown");
  now += 90;
  manager.update({ ...snapshot, cars: [{ ...snapshot.cars[0], vx: 0, surfaceSeverity: 1 }] });
  assert.equal(bank.slots.get("skid").volume, 0, "stationary tyres kept skidding on rough ground");
  for (let i = 0; i < 100; i++) { now += 90; manager.update(snapshot); }
  assert.equal(context.resumeCalls, resumes, "snapshots retried blocked autoplay");
  const original = [...context.sources];
  settings.set("soundMasterVolume", .3); manager.reload();
  manager.mount(root);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(manager.loopBank, bank, "DOM remount discarded the audio graph");
  assert.deepEqual(context.sources, original);
  assert.ok(original.every(source => source.starts === 1 && source.stops.length === 0));
  settings.set("soundEnabled", false); manager.reload();
  assert.equal(bank.bus.gain.value, 0);
  settings.set("soundEnabled", true); manager.reload();
  manager.setSuspended(true); assert.equal(bank.bus.gain.value, 0);
  manager.setSuspended(false); assert.equal(bank.bus.gain.value, 1);
  await Promise.resolve(); await Promise.resolve();
  context.rejectAutoplay = false; rootHandlers.get("pointerdown")();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(context.state, "running");
  for (let i = 0; i < 30; i++) { now += 300; snapshot.cars[0].health -= 2; manager.update(snapshot); }
  assert.equal(manager.oneShots.size, 12, "long custom effects were unbounded");
  manager.setSuspended(true); assert.equal(manager.oneShots.size, 0);
  manager.destroy();
  assert.equal(handlers.size, 0);
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(context.state, "closed", "private context leaked after race teardown");
}
console.log("audio-tests: ok (periodic PCM, stereo/padding, native loops, ramps, swaps, stale loads, autoplay, remount, mute and teardown)");
