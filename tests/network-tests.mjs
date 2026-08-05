import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.foundry = { utils: { deepClone: structuredClone } };
let intervalCalls = 0;
let clearedIntervals = 0;
globalThis.window = {
  setInterval: () => ++intervalCalls,
  clearInterval: () => { clearedIntervals += 1; }
};

const users = new Map([
  ["host", { id: "host", name: "Host", isGM: true, active: true }],
  ["player", { id: "player", name: "Player", isGM: false, active: true }],
  ["attacker", { id: "attacker", name: "Attacker", isGM: false, active: true }],
  ["gm-a", { id: "gm-a", name: "GM A", isGM: true, active: true }],
  ["gm-b", { id: "gm-b", name: "GM B", isGM: true, active: true }]
]);
let socketHandler = null;
let socketOnCalls = 0;
let socketOffCalls = 0;
const emitted = [];
globalThis.game = {
  user: users.get("player"),
  users,
  socket: {
    on: (_channel, handler) => { socketOnCalls += 1; socketHandler = handler; },
    off: (_channel, handler) => {
      socketOffCalls += 1;
      if (socketHandler === handler) socketHandler = null;
    },
    emit: (_channel, message) => emitted.push(message)
  }
};

const { PROTOCOL_VERSION } = await import(path.join(root, "scripts/constants.js"));
const { cloneDefaultBuild } = await import(path.join(root, "scripts/catalog.js"));
const { RaceNetwork, normalizeConfig } = await import(path.join(root, "scripts/network.js"));

// Repeated startup and teardown must keep exactly one listener and heartbeat.
{
  const network = new RaceNetwork();
  const onBefore = socketOnCalls;
  const intervalBefore = intervalCalls;
  const offBefore = socketOffCalls;
  const clearBefore = clearedIntervals;
  network.initialize();
  network.initialize();
  assert.equal(socketOnCalls, onBefore + 1);
  assert.equal(intervalCalls, intervalBefore + 1);
  network.destroy();
  network.destroy();
  assert.equal(socketOffCalls, offBefore + 1);
  assert.equal(clearedIntervals, clearBefore + 1);
  network.initialize();
  assert.equal(socketOnCalls, onBefore + 2);
  assert.equal(intervalCalls, intervalBefore + 2);
  network.destroy();
}

// Zero mandatory pit stops is a valid lobby value and must survive network normalization.
assert.equal(normalizeConfig({ requiredPitStops: 0 }).requiredPitStops, 0);
assert.equal(normalizeConfig({ trackComplexity: 5 }).trackComplexity, 5);
assert.equal(normalizeConfig({ environmentTheme: "ruins" }).environmentTheme, "ruins");
assert.equal(normalizeConfig({ environmentTheme: "invalid" }).environmentTheme, "auto");

let counter = 0;
const message = (payload) => ({
  protocolVersion: PROTOCOL_VERSION,
  id: `test-${++counter}`,
  sentAt: Date.now(),
  ...payload
});

// A non-host client must reject authoritative messages from anyone except the
// host recorded in the lobby and must reject stale snapshots.
{
  game.user = users.get("player");
  const network = new RaceNetwork();
  network.initialize();
  let starts = 0;
  let startedRace = null;
  let snapshots = 0;
  network.on("start", (race) => { starts += 1; startedRace = race; });
  network.on("snapshot", () => { snapshots += 1; });

  const lobby = {
    id: "lobby-a",
    hostId: "host",
    hostName: "Host",
    phase: "lobby",
    config: { seed: 1, laps: 1, bots: 0, botDifficulty: 2, trackComplexity: 2, collisionMode: "recovery" },
    participants: {
      host: { userId: "host", userName: "Host", build: cloneDefaultBuild() },
      player: { userId: "player", userName: "Player", build: cloneDefaultBuild() }
    },
    createdAt: 1
  };
  socketHandler(message({ type: "lobby-state", senderId: "host", lobby }));
  assert.equal(network.lobby.id, "lobby-a");

  const racePayload = {
    type: "race-init",
    lobbyId: "lobby-a",
    raceId: "race-a",
    hostId: "host",
    config: lobby.config,
    entries: [
      { id: "car-player", userId: "player", name: "Player", build: cloneDefaultBuild(), isBot: false },
      { id: "car-host", userId: "host", name: "Host", build: cloneDefaultBuild(), isBot: false }
    ]
  };
  socketHandler(message({ ...racePayload, senderId: "attacker" }));
  assert.equal(starts, 0);
  socketHandler(message({ ...racePayload, senderId: "host" }));
  assert.equal(starts, 1);
  const prediction = startedRace.carMeta[0].prediction;
  for (const key of ["lateralGrip", "longitudinalDrag", "rollingDrag", "spinResistance", "offroadGrip", "boostDrain", "heatRate", "cooling"]) {
    assert.ok(Number.isFinite(prediction[key]), `prediction metadata ${key} is missing`);
  }

  const frame = {
    tick: 10,
    simulationTime: 1,
    time: 1,
    countdown: 0,
    started: true,
    finished: false,
    laps: 1,
    requiredPitStops: 1,
    finishOrder: [],
    cars: [
      { id: "car-player", x: 1, y: 2, health: 100, charge: 100, place: 1 },
      { id: "car-host", x: 3, y: 4, health: 100, charge: 100, place: 2 }
    ]
  };
  socketHandler(message({ type: "race-frame", senderId: "attacker", lobbyId: "lobby-a", raceId: "race-a", sequence: 1, simulationTick: 10, frame }));
  assert.equal(snapshots, 0);
  socketHandler(message({ type: "race-frame", senderId: "host", lobbyId: "lobby-a", raceId: "race-a", sequence: 2, simulationTick: 10, frame }));
  assert.equal(snapshots, 1);
  assert.equal(network.lastSnapshot.cars[0].name, "Player");
  assert.ok(Number.isFinite(network.lastSnapshot.cars[0].maxHealth));
  socketHandler(message({ type: "race-frame", senderId: "host", lobbyId: "lobby-a", raceId: "race-a", sequence: 1, simulationTick: 9, frame: { ...frame, tick: 9 } }));
  assert.equal(snapshots, 1);

  network.lastHostHeartbeat = 1;
  socketHandler(message({
    type: "race-frame", senderId: "host", lobbyId: "lobby-a", raceId: "race-a",
    sequence: 3, simulationTick: 11, frame: { ...frame, tick: 11, simulationTime: 1.1 }
  }));
  assert.ok(network.lastHostHeartbeat > 1, "valid race traffic did not refresh host liveness");
  socketHandler(message({
    type: "race-frame", senderId: "host", lobbyId: "lobby-a", raceId: "race-a",
    sequence: 4, simulationTick: 12, frame: { ...frame, tick: 12, cars: frame.cars.slice(0, 1) }
  }));
  assert.equal(snapshots, 2, "partial race frame was accepted");

  const compactCar = (id, x, y, place, { driftAmount = 0, pitInServiceZone = false } = {}) => [
    id, x, y, 0, 0, 0, 100, 100, 0, 0,
    0, 0, 0, 0, 0, null, null, place, null,
    0, 0, 0, null, null, 0, 0, 0, driftAmount, pitInServiceZone ? 1 : 0
  ];
  socketHandler(message({
    type: "race-frame", senderId: "host", lobbyId: "lobby-a", raceId: "race-a",
    sequence: 5, simulationTick: 13,
    frame: {
      t: 13, s: 1.3, r: 1.3, c: 0, a: 1, f: 0, l: 1, p: 1, o: [],
      v: [compactCar("car-player", 5, 6, 1, { driftAmount: 0.73, pitInServiceZone: true }), compactCar("car-host", 7, 8, 2)]
    }
  }));
  assert.equal(snapshots, 3, "valid 29-field compact race frame was rejected");
  assert.equal(network.lastSnapshot.cars[0].x, 5);
  assert.equal(network.lastSnapshot.cars[0].driftAmount, 0.73, "remote drift HUD state was lost");
  assert.equal(network.lastSnapshot.cars[0].pitInServiceZone, true, "remote pit service-zone state was lost");

  // race-frame validation must stay structural. Re-serializing every accepted
  // snapshot on every client was measurable overhead with larger grids.
  const originalStringify = JSON.stringify;
  JSON.stringify = () => { throw new Error("race-frame must not be serialized for validation"); };
  try {
    socketHandler(message({
      type: "race-frame", senderId: "host", lobbyId: "lobby-a", raceId: "race-a",
      sequence: 6, simulationTick: 14,
      frame: {
        t: 14, s: 1.4, r: 1.4, c: 0, a: 1, f: 0, l: 1, p: 1, o: [],
        v: [compactCar("car-player", 9, 10, 1), compactCar("car-host", 11, 12, 2)]
      }
    }));
  } finally {
    JSON.stringify = originalStringify;
  }
  assert.equal(snapshots, 4, "structurally valid frame still depended on JSON.stringify");

  socketHandler(message({
    type: "race-frame", senderId: "host", lobbyId: "lobby-a", raceId: "race-a",
    sequence: 7, simulationTick: 15,
    frame: {
      t: 15, s: 1.5, r: 1.5, c: 0, a: 1, f: 0, l: 1, p: 1, o: [], padding: "x".repeat(100000),
      v: [compactCar("car-player", 9, 10, 1), compactCar("car-host", 11, 12, 2)]
    }
  }));
  assert.equal(snapshots, 4, "frame with an unbounded extra field was accepted");

  const oversizedRow = compactCar("car-player", 9, 10, 1);
  oversizedRow[22] = "x".repeat(81);
  socketHandler(message({
    type: "race-frame", senderId: "host", lobbyId: "lobby-a", raceId: "race-a",
    sequence: 8, simulationTick: 16,
    frame: {
      t: 16, s: 1.6, r: 1.6, c: 0, a: 1, f: 0, l: 1, p: 1, o: [],
      v: [oversizedRow, compactCar("car-host", 11, 12, 2)]
    }
  }));
  assert.equal(snapshots, 4, "oversized compact row string was accepted");
}

// The host accepts input only for the car owned by the sender and only for the
// current race id.
{
  game.user = users.get("host");
  socketHandler = null;
  const network = new RaceNetwork();
  network.initialize();
  network.createLobby({ build: cloneDefaultBuild(), config: { bots: 0, laps: 1 } });
  socketHandler(message({
    type: "join-request",
    senderId: "player",
    lobbyId: network.lobby.id,
    participant: { userId: "player", userName: "Player", build: cloneDefaultBuild() }
  }));
  network.startRace([
    { id: "car-host", userId: "host", name: "Host", build: cloneDefaultBuild(), isBot: false },
    { id: "car-player", userId: "player", name: "Player", build: cloneDefaultBuild(), isBot: false }
  ]);
  assert.equal(network.activeRace.controlAssignments.player, "car-player");
  const assignmentsBefore = emitted.filter((entry) => entry.type === "control-assignment").length;
  socketHandler(message({
    type: "race-ready", senderId: "player", lobbyId: network.lobby.id, raceId: network.activeRace.raceId,
    userId: "player", carId: "car-host"
  }));
  assert.equal(emitted.filter((entry) => entry.type === "control-assignment").length, assignmentsBefore);
  socketHandler(message({
    type: "race-ready", senderId: "player", lobbyId: network.lobby.id, raceId: network.activeRace.raceId,
    userId: "player", carId: "car-player"
  }));
  const assignment = emitted.findLast((entry) => entry.type === "control-assignment");
  assert.equal(assignment.targetId, "player");
  assert.equal(assignment.carId, "car-player");
  network.sendSnapshot({
    tick: 1,
    simulationTime: 0.016,
    time: 0,
    countdown: 3.3,
    started: false,
    finished: false,
    laps: 1,
    requiredPitStops: 1,
    finishOrder: [],
    cars: [
      { id: "car-host", x: 1.23456, y: 2.34567, health: 100, charge: 100, place: 1, driftAmount: 0.4567, pitInServiceZone: true, name: "must-not-repeat" },
      { id: "car-player", x: 3.45678, y: 4.56789, health: 100, charge: 100, place: 2, name: "must-not-repeat" }
    ]
  });
  const sentFrame = emitted.findLast((entry) => entry.type === "race-frame");
  assert.ok(sentFrame, "host did not emit compact race-frame");
  assert.ok(Array.isArray(sentFrame.frame.v));
  assert.equal(sentFrame.frame.v[0][1], 1.23);
  assert.equal(sentFrame.frame.v[0].length, 29);
  assert.equal(sentFrame.frame.v[0][27], 0.457);
  assert.equal(sentFrame.frame.v[0][28], 1);
  assert.equal(sentFrame.frame.v[0].includes("must-not-repeat"), false);
  let inputs = 0;
  let acceptedInput = null;
  network.on("input", (payload) => { inputs += 1; acceptedInput = payload.input; });
  const base = {
    type: "race-input",
    lobbyId: network.lobby.id,
    raceId: network.activeRace.raceId,
    userId: "player",
    carId: "car-player",
    sequence: 1,
    input: {
      throttle: 1,
      steer: -1,
      brake: false,
      reverse: false,
      boost: true,
      ram: false,
      drift: true
    }
  };
  socketHandler(message({ ...base, senderId: "attacker" }));
  socketHandler(message({ ...base, senderId: "player", carId: "car-host" }));
  socketHandler(message({ ...base, senderId: "player", raceId: "old-race" }));
  assert.equal(inputs, 0);
  socketHandler(message({ ...base, senderId: "player", padding: "x".repeat(9000) }));
  assert.equal(inputs, 0, "oversized input payload was accepted");
  socketHandler(message({
    ...base,
    senderId: "player",
    input: { ...base.input, unexpected: true }
  }));
  assert.equal(inputs, 0, "input packet with an unknown field was accepted");
  socketHandler(message({ ...base, senderId: "player" }));
  assert.equal(inputs, 1, "complete seven-field driving input was rejected");
  assert.equal(acceptedInput?.throttle, 1, "network sanitization dropped forward input");
  assert.equal(acceptedInput?.steer, -1, "network sanitization dropped steering input");
  assert.equal(acceptedInput?.boost, true, "network sanitization dropped boost input");
  assert.equal(acceptedInput?.drift, true, "network sanitization dropped the Ctrl drift command");
  socketHandler(message({ ...base, senderId: "player", sequence: 2 }));
  assert.equal(inputs, 1, "input rate limit did not reject an immediate duplicate");

  let controlClaims = 0;
  network.on("claimControl", () => { controlClaims += 1; });
  const claim = {
    type: "claim-control",
    lobbyId: network.lobby.id,
    raceId: network.activeRace.raceId,
    userId: "player",
    carId: "car-player"
  };
  socketHandler(message({ ...claim, senderId: "attacker" }));
  socketHandler(message({ ...claim, senderId: "player", carId: "car-host" }));
  assert.equal(controlClaims, 0);
  socketHandler(message({ ...claim, senderId: "player" }));
  assert.equal(controlClaims, 1);

  let pitCompletions = 0;
  network.on("pitComplete", () => { pitCompletions += 1; });
  const pit = {
    type: "pit-complete",
    lobbyId: network.lobby.id,
    raceId: network.activeRace.raceId,
    userId: "player",
    carId: "car-player",
    word: "кристалл",
    attemptId: "attempt-1"
  };
  socketHandler(message({ ...pit, senderId: "attacker" }));
  socketHandler(message({ ...pit, senderId: "player", carId: "car-host" }));
  socketHandler(message({ ...pit, senderId: "player", raceId: "old-race" }));
  socketHandler(message({ ...pit, senderId: "player", word: "x".repeat(81) }));
  socketHandler(message({ ...pit, senderId: "player", unexpected: { nested: true } }));
  assert.equal(pitCompletions, 0);
  socketHandler(message({ ...pit, senderId: "player" }));
  assert.equal(pitCompletions, 1);
  socketHandler(message({ ...pit, senderId: "player" }));
  assert.equal(pitCompletions, 1, "pit request rate limit did not reject an immediate duplicate");
}

// Competing GM recovery claims for one lobby converge by host epoch, claim time
// and claim id. The active race is aborted in the same accepted transaction.
{
  game.user = users.get("player");
  socketHandler = null;
  const network = new RaceNetwork();
  network.initialize();
  const baseLobby = {
    id: "lobby-recovery",
    hostId: "host",
    hostName: "Host",
    phase: "lobby",
    config: { seed: 2, laps: 1, bots: 0, botDifficulty: 2, trackComplexity: 2, collisionMode: "recovery" },
    participants: {
      host: { userId: "host", userName: "Host", build: cloneDefaultBuild() },
      player: { userId: "player", userName: "Player", build: cloneDefaultBuild() }
    },
    createdAt: 10,
    hostEpoch: 0,
    hostClaimedAt: 10,
    hostClaimId: "host"
  };
  socketHandler(message({ type: "lobby-state", senderId: "host", lobby: baseLobby }));
  socketHandler(message({
    type: "race-init", senderId: "host", lobbyId: baseLobby.id, raceId: "race-recovery", hostId: "host",
    config: baseLobby.config, entries: [{ id: "car-player", userId: "player", name: "Player", build: cloneDefaultBuild(), isBot: false }]
  }));
  assert.equal(network.activeRace.raceId, "race-recovery");

  const claimB = {
    ...baseLobby, hostId: "gm-b", hostName: "GM B", phase: "lobby",
    hostEpoch: 1, hostClaimedAt: 200, hostClaimId: "claim-b"
  };
  const claimA = {
    ...baseLobby, hostId: "gm-a", hostName: "GM A", phase: "lobby",
    hostEpoch: 1, hostClaimedAt: 100, hostClaimId: "claim-a"
  };
  socketHandler(message({ type: "host-claim", senderId: "gm-b", lobby: claimB, abortRace: true, abortedRaceId: "race-recovery" }));
  assert.equal(network.lobby.hostId, "gm-b");
  assert.equal(network.activeRace, null);
  socketHandler(message({ type: "host-claim", senderId: "gm-a", lobby: claimA, abortRace: true, abortedRaceId: "race-recovery" }));
  assert.equal(network.lobby.hostId, "gm-a");
  assert.equal(network.lobby.hostEpoch, 1);

  socketHandler(message({ type: "lobby-state", senderId: "host", lobby: baseLobby }));
  assert.equal(network.lobby.hostId, "gm-a", "stale pre-claim host overwrote recovery owner");
}

// Calling recovery as a replacement GM during an active race must abort the
// race locally in the same host-claim transaction.
{
  game.user = users.get("gm-a");
  socketHandler = null;
  const network = new RaceNetwork();
  network.initialize();
  let recoveredStops = 0;
  network.on("stop", (payload) => { if (payload?.recovered) recoveredStops += 1; });
  const lobby = {
    id: "lobby-direct-recovery",
    hostId: "host",
    hostName: "Host",
    phase: "lobby",
    config: { seed: 3, laps: 1, bots: 0, botDifficulty: 2, trackComplexity: 2, collisionMode: "recovery" },
    participants: {
      host: { userId: "host", userName: "Host", build: cloneDefaultBuild() },
      "gm-a": { userId: "gm-a", userName: "GM A", build: cloneDefaultBuild() }
    },
    createdAt: 20,
    hostEpoch: 0,
    hostClaimedAt: 20,
    hostClaimId: "host"
  };
  socketHandler(message({ type: "lobby-state", senderId: "host", lobby }));
  socketHandler(message({
    type: "race-init", senderId: "host", lobbyId: lobby.id, raceId: "race-direct-recovery", hostId: "host",
    config: lobby.config,
    entries: [{ id: "car-gm", userId: "gm-a", name: "GM A", build: cloneDefaultBuild(), isBot: false }]
  }));
  assert.equal(network.activeRace?.raceId, "race-direct-recovery");
  network.hostOffline = true;
  assert.equal(network.recoverOrphanedSession(), true);
  assert.equal(network.activeRace, null);
  assert.equal(network.lobby.hostId, "gm-a");
  assert.equal(network.lobby.phase, "lobby");
  assert.equal(recoveredStops, 1);
  network.destroy();
}

console.log("network-tests: ok");
