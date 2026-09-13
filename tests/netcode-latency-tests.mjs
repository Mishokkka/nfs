import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.window = { setInterval: () => 1, clearInterval: () => {} };

const user = { id: "player", name: "Player", isGM: false, active: true };
const users = new Map([[user.id, user]]);
const emitted = [];
let socketHandler = null;
globalThis.game = {
  user,
  users,
  socket: {
    on: (_channel, handler) => { socketHandler = handler; },
    off: (_channel, handler) => { if (socketHandler === handler) socketHandler = null; },
    emit: (_channel, message) => emitted.push(message)
  }
};

const networkUrl = pathToFileURL(path.join(root, "scripts/network.js")).href;
const firstModule = await import(`${networkUrl}?client-session=first`);
const first = new firstModule.RaceNetwork();
first.initialize();
first.requestState();
const firstId = emitted.at(-1)?.id;
first.destroy();

const secondModule = await import(`${networkUrl}?client-session=second`);
const second = new secondModule.RaceNetwork();
second.initialize();
second.requestState();
const secondId = emitted.at(-1)?.id;
second.destroy();

assert.ok(firstId && secondId, "fresh client sessions did not emit state requests");
assert.notEqual(firstId, secondId, "message ids collided after a simulated client reload");
assert.match(firstId, /^player:[^:]+:1$/, "message id does not include a per-load session nonce");
assert.match(secondId, /^player:[^:]+:1$/, "reloaded message id does not include a per-load session nonce");

const constants = await import(pathToFileURL(path.join(root, "scripts/constants.js")).href);
assert.equal(constants.PHYSICS_HZ, 60);
assert.equal(constants.WORKER_SNAPSHOT_HZ, 30);
assert.equal(constants.SNAPSHOT_HZ, 30, "authoritative network snapshots must run at 30 Hz");

const runtimeSource = await fs.readFile(path.join(root, "scripts/app/race-runtime.js"), "utf8");
assert.match(
  runtimeSource,
  /networkRenderDelay:\s*this\.isHost\s*\?\s*0\.032\s*:\s*0\.08/,
  "remote presentation delay regressed above the 80 ms target"
);
assert.match(
  runtimeSource,
  /if \(!this\.practice && this\.network\.isHost\) \{[\s\S]*?this\.network\.sendSnapshot\(message\.snapshot\);[\s\S]*?\}/,
  "worker snapshots are no longer forwarded directly to the network"
);
assert.match(
  runtimeSource,
  /#startHiddenMainThreadClock\(\)[\s\S]*?window\.setInterval\([\s\S]*?\},\s*1000\s*\/\s*SNAPSHOT_HZ\);/,
  "hidden main-thread fallback no longer follows the authoritative snapshot cadence"
);

console.log("netcode-latency-tests: ok");
