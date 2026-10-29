import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.foundry = { utils: { deepClone: structuredClone } };
let clock = 100;
let pump = null;
let handler = null;
const posted = [];
globalThis.performance = { timeOrigin: 0, now: () => clock };
let scheduledDelay = 0;
globalThis.setTimeout = (callback, delay = 0) => { pump = callback; scheduledDelay = delay; return 1; };
globalThis.clearTimeout = () => { pump = null; };
globalThis.self = {
  addEventListener: (type, callback) => { if (type === "message") handler = callback; },
  postMessage: (message) => posted.push(message),
  close: () => {}
};

const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { cloneDefaultBuild } = await load("scripts/catalog.js");
const { generateTrack } = await load("scripts/track.js");
const workerUrl = pathToFileURL(path.join(root, "scripts/simulation-worker.js"));
workerUrl.searchParams.set("worker-test", String(Date.now()));
await import(workerUrl.href);
assert.equal(typeof handler, "function");

handler({ data: {
  type: "init",
  raceId: "worker-race",
  checkpoints: true,
  track: generateTrack(0, 2),
  entries: [{ id: "car", userId: "user", name: "Car", build: cloneDefaultBuild(), color: "#fff", isBot: false }],
  config: { laps: 1, collisionMode: "recovery", botDifficulty: 2, requiredPitStops: 1 }
} });
assert.ok(posted.some((message) => message.type === "ready" && message.raceId === "worker-race"));
assert.ok(posted.some((message) => message.type === "snapshot"));
assert.ok(posted.some((message) => message.type === "checkpoint"));
assert.ok(posted.every((message) => message.generatedAt == null || Number.isFinite(message.generatedAt)),
  "worker published a non-finite generatedAt timestamp");
assert.equal(typeof pump, "function");

handler({ data: { type: "input", carId: "car", input: { throttle: 1, steer: 0, brake: false, reverse: false, boost: false, ram: false, drift: false } } });
const snapshotTimes = [];
for (let index = 0; index < 8; index += 1) {
  const before = posted.filter((message) => message.type === "snapshot").length;
  clock += 1000 / 60;
  const currentPump = pump;
  pump = null; // a real setTimeout callback is consumed before it executes
  currentPump?.();
  const snapshots = posted.filter((message) => message.type === "snapshot");
  if (snapshots.length > before) snapshotTimes.push(snapshots.at(-1).snapshot.simulationTime);
  assert.ok(scheduledDelay >= 0 && scheduledDelay <= 1000 / 60 + 1);
}
assert.ok(posted.filter((message) => message.type === "snapshot").length >= 3);
for (let index = 1; index < snapshotTimes.length; index += 1) {
  const interval = snapshotTimes[index] - snapshotTimes[index - 1];
  assert.ok(interval > 0 && interval <= 3 / 60 + 1e-9, `worker publication skipped too many ticks: ${interval}`);
}

// Worker import resumes at the saved tick, not at the start grid. Human input
// counters reopen, and saving continues off the main thread after recovery.
const savedCheckpoint = JSON.parse(posted.findLast(message => message.type === "checkpoint").checkpoint);
savedCheckpoint.tick = 1200; savedCheckpoint.simulationTime = 20;
savedCheckpoint.countdown = 0; savedCheckpoint.started = true;
handler({ data: { type: "init", raceId: "worker-restored", track: generateTrack(0, 2),
  entries: [{ id: "car", userId: "user", name: "Car", build: cloneDefaultBuild(), color: "#fff", isBot: false }],
  config: { laps: 1, collisionMode: "recovery", botDifficulty: 2, requiredPitStops: 1 },
  checkpoint: savedCheckpoint, checkpoints: true } });
assert.equal(posted.findLast(message => message.raceId === "worker-restored" && message.type === "snapshot").snapshot.tick, 1200);
assert.ok(posted.some(message => message.raceId === "worker-restored" && message.type === "checkpoint"));

// Main-thread stalls cannot enqueue a stream of increasingly obsolete frames.
// A single ACK releases a fresh snapshot, while state events stay independent.
for(const stallMs of [250,500,1000]) {
  const raceId='worker-pressure-'+stallMs;
  handler({data:{type:'init',raceId,snapshotFlowControl:true,checkpoints:true,
    track:generateTrack('worker-pressure',2),entries:[{id:'car',userId:'user',build:cloneDefaultBuild()}],
    config:{laps:1,requiredPitStops:0}}});
  const initial=posted.findLast(message=>message.raceId===raceId&&message.type==='snapshot');
  for(let elapsed=0;elapsed<stallMs;elapsed+=1000/60) {
    clock+=1000/60;const current=pump;pump=null;current?.();
  }
  assert.equal(posted.filter(message=>message.raceId===raceId&&message.type==='snapshot').length,1,'worker accumulated unconsumed periodic snapshots');
  handler({data:{type:'snapshot-request'}});
  assert.ok(posted.some(message=>message.raceId===raceId&&message.type==='state'),'state event was trapped behind the periodic ACK');
  handler({data:{type:'snapshot-consumed',raceId:'old-race',snapshotId:initial.snapshotId}});
  assert.equal(posted.filter(message=>message.raceId===raceId&&message.type==='snapshot').length,1,'an old-race ACK released a snapshot');
  handler({data:{type:'snapshot-consumed',raceId,snapshotId:initial.snapshotId}});
  const fresh=posted.findLast(message=>message.raceId===raceId&&message.type==='snapshot');
  assert.ok(fresh.snapshot.tick>=Math.floor(stallMs/1000*60),'ACK released an obsolete replacement');
  assert.equal(fresh.generatedAt,clock,'replacement retained an old production timestamp');
  assert.equal(posted.filter(message=>message.raceId===raceId&&message.type==='snapshot').length,2,'ACK burst a queue of stale frames');
  handler({data:{type:'snapshot-consumed',raceId,snapshotId:initial.snapshotId}});
  assert.equal(posted.filter(message=>message.raceId===raceId&&message.type==='snapshot').length,2,'duplicate ACK changed the outstanding frame');
}

handler({ data: {
  type: "init",
  raceId: "worker-finish",
  snapshotFlowControl: true,
  track: generateTrack("worker-finish", 1),
  entries: [{
    id: "bot", userId: null, name: "Bot", build: cloneDefaultBuild(), color: "#fff",
    isBot: true, botSkill: 4, botSeed: "worker-finish"
  }],
  config: { laps: 1, collisionMode: "recovery", botDifficulty: 4, requiredPitStops: 0 }
} });
for (let index = 0; index < 180 && pump; index += 1) {
  clock += 1500;
  const currentPump = pump;
  pump = null; // consume the one-shot timeout before running it
  currentPump?.();
}
assert.ok(posted.some((message) => message.type === "finished" && message.raceId === "worker-finish"),
  "worker did not publish a final snapshot");
assert.equal(pump, null, "worker interval continued after the final snapshot");
handler({ data: { type: "stop" } });

// The real runtime ACKs only after audio, rendering and network consumption.
// State/checkpoint events bypass this credit without accidentally granting more.
{
  globalThis.window={setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1,clearInterval:()=>{}};
  globalThis.game={user:{id:'user'},settings:{get:()=>undefined}};
  globalThis.ui={notifications:{warn:()=>{},error:()=>{}}};
  const order=[];
  globalThis.Worker=class {
    constructor(){this.listeners=new Map();this.sent=[];}
    addEventListener(type,callback){this.listeners.set(type,callback);}
    removeEventListener(type){this.listeners.delete(type);}
    postMessage(message){this.sent.push(message);if(message.type==='snapshot-consumed')order.push('ack');}
    terminate(){}
  };
  const {RaceRuntime}=await load('scripts/app/race-runtime.js');
  const network={isHost:true,sendSnapshot:()=>order.push('network'),saveRecoveryCheckpoint:()=>order.push('checkpoint')};
  const runtime=new RaceRuntime({network,isRaceActive:()=>true,onFinished:()=>{}});
  runtime.start({config:{seed:1,trackComplexity:1},entries:[{id:'car',userId:'user',build:cloneDefaultBuild()}],host:true,raceId:'runtime-pressure'});
  const worker=runtime.simulationWorker;
  assert.equal(worker.sent[0].snapshotFlowControl,true,'runtime did not enable snapshot credits');
  runtime.audio.update=()=>order.push('audio');
  runtime.renderer={pushSnapshot:()=>order.push('renderer'),destroy:()=>{}};
  const receive=worker.listeners.get('message');
  receive({data:{type:'snapshot',raceId:'runtime-pressure',snapshotId:1,snapshot:{tick:2,cars:[]},generatedAt:clock}});
  assert.deepEqual(order,['audio','renderer','network','ack']);
  assert.deepEqual(worker.sent.at(-1),{type:'snapshot-consumed',raceId:'runtime-pressure',snapshotId:1});
  order.length=0;
  receive({data:{type:'state',raceId:'runtime-pressure',snapshot:{tick:3,cars:[]}}});
  assert.deepEqual(order,['audio','renderer','network']);
  receive({data:{type:'checkpoint',raceId:'runtime-pressure',checkpoint:'{}'}});
  assert.equal(order.at(-1),'checkpoint');
  runtime.stop();
}

console.log("worker-tests: ok");
