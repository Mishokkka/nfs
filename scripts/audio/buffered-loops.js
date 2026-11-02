import { prepareLoopBuffer } from "./loop-buffer.js";

const MAX_ENCODED_BYTES = 16 * 1024 * 1024;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

export function smoothParam(param, value, now, seconds) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
  else { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); }
  param.setTargetAtTime(value, now, seconds);
}

/** One private audio graph per mounted race. Persistent native looping sources
 * survive UI renders and volume changes. No play()/seek/restart per cycle. */
export class BufferedLoops {
  static supported() { return typeof (globalThis.AudioContext ?? globalThis.webkitAudioContext) === "function"; }

  constructor({ onError = () => {}, context = null } = {}) {
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    this.context = context ?? new Context({ latencyHint: "interactive" });
    this.ownsContext = !context;
    this.onError = onError;
    this.slots = new Map();
    this.voices = new Set();
    this.buffers = new Map();
    this.bufferBytes = 0;
    this.disposed = false;
    this.abort = new AbortController();
    this.bus = this.context.createGain();
    this.bus.gain.value = 1;
    this.compressor = this.context.createDynamicsCompressor?.() ?? null;
    if (this.compressor) {
      for (const [name, value] of Object.entries({ threshold: -6, knee: 9, ratio: 4, attack: .004, release: .15 })) this.compressor[name].value = value;
      this.bus.connect(this.compressor); this.compressor.connect(this.context.destination);
    } else this.bus.connect(this.context.destination);
  }

  setLoop(name, path) {
    const previous = this.slots.get(name);
    if (previous?.path === path && !previous.failed || this.disposed) return previous?.pending ?? Promise.resolve();
    const slot = { path, volume: previous?.volume ?? 0, rate: previous?.rate ?? 1, voice: previous?.voice ?? null };
    this.slots.set(name, slot);
    slot.pending = this.load(path).then(buffer => {
      if (this.disposed || this.slots.get(name) !== slot) return;
      const source = this.context.createBufferSource(), gain = this.context.createGain();
      source.buffer = buffer; source.loop = true;
      source.playbackRate.value = slot.rate; gain.gain.value = 0;
      source.connect(gain); gain.connect(this.bus);
      const voice = { source, gain, path, volume: slot.volume, rate: slot.rate };
      this.voices.add(voice);
      source.onended = () => this.release(voice);
      source.start();
      if (slot.voice) this.retire(slot.voice);
      slot.voice = voice;
      smoothParam(gain.gain, slot.volume, this.context.currentTime, .04);
    }).catch(error => {
      slot.failed = true;
      if (!this.disposed && this.slots.get(name) === slot) this.onError(name, error);
    });
    return slot.pending;
  }

  setLevel(name, volume, rate = 1) {
    const slot = this.slots.get(name);
    if (!slot || this.disposed) return;
    volume = clamp(volume, 0, 1); rate = clamp(rate, .5, 2.2);
    const now = this.context.currentTime;
    if (slot.voice && (Math.abs(slot.voice.volume - volume) > .001 || volume === 0 && slot.voice.volume !== 0)) {
      smoothParam(slot.voice.gain.gain, volume, now, volume > slot.voice.volume ? .035 : .065);
      slot.voice.volume = volume;
    }
    if (slot.voice && Math.abs(slot.voice.rate - rate) > .001) {
      smoothParam(slot.voice.source.playbackRate, rate, now, .075);
      slot.voice.rate = rate;
    }
    slot.volume = volume; slot.rate = rate;
  }

  setMuted(muted) { if (!this.disposed) smoothParam(this.bus.gain, muted ? 0 : 1, this.context.currentTime, .02); }

  unlock() {
    if (this.disposed || this.context.state === "running") return Promise.resolve();
    return this.context.resume();
  }

  async load(path) {
    const cached = this.buffers.get(path);
    if (cached) { cached.used = performance.now(); return cached.pending; }
    const record = { used: performance.now(), bytes: 0, pending: null };
    this.buffers.set(path, record);
    record.pending = (async () => {
      const response = await fetch(path, { signal: this.abort.signal });
      if (!response.ok) throw new Error(`Audio request failed (${response.status})`);
      if (Number(response.headers?.get("content-length")) > MAX_ENCODED_BYTES) throw new Error("Loop file exceeds 16 MiB");
      const encoded = await response.arrayBuffer();
      if (this.disposed) return null;
      if (encoded.byteLength > MAX_ENCODED_BYTES) throw new Error("Loop file exceeds 16 MiB");
      const decoded = await this.context.decodeAudioData(encoded);
      if (this.disposed) return null;
      const bytes = decoded.length * decoded.numberOfChannels * 4;
      if (bytes > MAX_BUFFER_BYTES || decoded.duration > 120 || decoded.numberOfChannels > 2) throw new Error("Use a mono/stereo loop up to 120 seconds and 32 MiB decoded");
      this.evict(bytes, path);
      const buffer = prepareLoopBuffer(this.context, decoded);
      record.bytes = buffer.length * buffer.numberOfChannels * 4;
      this.bufferBytes += record.bytes;
      return buffer;
    })().catch(error => { this.buffers.delete(path); throw error; });
    return record.pending;
  }

  evict(required, keep) {
    const used = new Set([...this.slots.values()].map(slot => slot.path));
    for (const voice of this.voices) used.add(voice.path);
    for (const [path, record] of [...this.buffers].sort((a, b) => a[1].used - b[1].used)) {
      if (this.bufferBytes + required <= MAX_CACHE_BYTES) break;
      if (path === keep || used.has(path) || !record.bytes) continue;
      this.buffers.delete(path); this.bufferBytes -= record.bytes;
    }
    if (this.bufferBytes + required > MAX_CACHE_BYTES) throw new Error("Active loop buffers exceed 64 MiB");
  }

  retire(voice) {
    if (!this.voices.has(voice) || voice.retiring) return;
    voice.retiring = true;
    smoothParam(voice.gain.gain, 0, this.context.currentTime, .04);
    voice.source.stop(this.context.currentTime + .28);
  }

  release(voice) {
    if (!this.voices.delete(voice)) return;
    voice.source.disconnect(); voice.gain.disconnect(); voice.source.onended = null;
  }

  stop() {
    if (this.disposed) return;
    this.disposed = true; this.abort.abort();
    smoothParam(this.bus.gain, 0, this.context.currentTime, .012);
    for (const voice of this.voices) this.retire(voice);
    this.slots.clear(); this.buffers.clear(); this.bufferBytes = 0;
    // Only teardown uses a wall-clock timer. Loop seams and ramps remain on the
    // audio clock even while the main thread stalls. Never close Foundry audio.
    setTimeout(() => {
      for (const voice of [...this.voices]) this.release(voice);
      this.bus.disconnect();
      this.compressor?.disconnect();
      if (this.ownsContext && this.context.state !== "closed") void this.context.close().catch(() => {});
    }, 120);
  }

  stats() {
    return { backend: "webaudio-buffer", contextState: this.context.state, loops: this.slots.size,
      playingLoops: this.context.state === "running" ? [...this.slots.values()].filter(slot => slot.voice).length : 0,
      voices: this.voices.size, bufferBytes: this.bufferBytes };
  }
}
