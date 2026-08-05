import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.window = { setInterval: () => 1, clearInterval: () => {} };

const users = new Map([
  ["host", { id: "host", name: "Host", isGM: true, active: true }],
  ["player", { id: "player", name: "Player", isGM: false, active: true }]
]);
const listeners = [];
const socket = {
  on: (_channel, handler) => listeners.push({ userId: game.user.id, handler }),
  off: (_channel, handler) => {
    const index = listeners.findIndex((entry) => entry.handler === handler);
    if (index >= 0) listeners.splice(index, 1);
  },
  emit: (_channel, payload) => {
    const caller = game.user;
    for (const listener of [...listeners]) {
      game.user = users.get(listener.userId);
      listener.handler(structuredClone(payload));
    }
    game.user = caller;
  }
};
globalThis.game = { user: users.get("host"), users, socket };

const { RaceNetwork } = await import(path.join(root, "scripts/network.js"));
const { cloneDefaultBuild } = await import(path.join(root, "scripts/catalog.js"));
const host = new RaceNetwork();
host.initialize();
game.user = users.get("player");
const player = new RaceNetwork();
player.initialize();

game.user = users.get("host");
assert.equal(host.createLobby({ build: cloneDefaultBuild(), config: { seed: 0, laps: 1, bots: 0 } }), true);
assert.equal(player.lobby?.hostId, "host");
assert.equal(player.lobby?.config.seed, 0);

game.user = users.get("player");
player.join(cloneDefaultBuild());
assert.ok(host.lobby?.participants?.player);
assert.ok(player.lobby?.participants?.player);

game.user = users.get("host");
const entries = Object.values(host.lobby.participants).map((participant) => ({
  id: `player-${participant.userId}`,
  userId: participant.userId,
  name: participant.userName,
  build: participant.build,
  color: "#fff",
  isBot: false
}));
assert.ok(host.startRace(entries));
assert.equal(player.activeRace?.raceId, host.activeRace?.raceId);
assert.equal(player.activeRace?.entries.length, 2);

host.destroy();
game.user = users.get("player");
player.destroy();
assert.equal(listeners.length, 0);
console.log("multiclient-tests: ok");
