import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "scripts/app");

// Private methods are implementation details and should not survive as detached tails.
for (const sourceFile of fs.readdirSync(path.join(root, "scripts"), { recursive: true })) {
  if (!String(sourceFile).endsWith(".js")) continue;
  const sourcePath = path.join(root, "scripts", String(sourceFile));
  const source = fs.readFileSync(sourcePath, "utf8");
  const definitions = [...source.matchAll(/^\s{2}(#[$A-Z_a-z][$\w]*)\s*\([^\n]*\)\s*\{/gm)];
  for (const [, name] of definitions) {
    const references = source.split(name).length - 1;
    assert.ok(references > 1, `${sourceFile}: unused private method ${name}`);
  }
}
const expected = [
  "racing-app.js",
  "garage-controller.js",
  "lobby-controller.js",
  "race-runtime.js",
  "race-input.js",
  "race-hud.js",
  "pit-ui.js",
  "tooltip-controller.js"
];
for (const file of expected) assert.ok(fs.existsSync(path.join(appDir, file)), `${file} missing`);
assert.ok(fs.readFileSync(path.join(root, "scripts/app.js"), "utf8").split("\n").length < 10, "compatibility app entrypoint grew again");
const raceInputText = fs.readFileSync(path.join(appDir, "race-input.js"), "utf8");
assert.match(raceInputText, /AbortController/);
assert.match(raceInputText, /ControlLeft/);
assert.match(raceInputText, /drift:/);
const racingAppText = fs.readFileSync(path.join(appDir, "racing-app.js"), "utf8");
assert.match(racingAppText, /ScreenStateMachine/);
assert.doesNotMatch(racingAppText, /this\.state\s*=/, "ApplicationV2.state is getter-only in Foundry v13");

const appHelpersUrl = pathToFileURL(path.join(appDir, "app-helpers.js"));
const { ScreenStateMachine, formatTime } = await import(appHelpersUrl.href);
const state = new ScreenStateMachine();
assert.equal(state.current, "garage");
assert.equal(state.transition("lobby"), true);
assert.equal(state.transition("race"), true);
assert.equal(state.transition("results"), true);
assert.throws(() => state.transition("unknown"));
assert.equal(formatTime(59.999), "1:00.00", "centisecond rounding must carry into the next minute");
assert.equal(formatTime(3599.999), "60:00.00", "minute carry must remain valid for long races");
assert.equal(formatTime(-0.01), "0:00.00", "negative transient timestamps must clamp to zero");

globalThis.foundry = { utils: { deepClone: structuredClone } };
const { normalizeConfig } = await import(pathToFileURL(path.join(root, "scripts/network.js")).href);
assert.equal(normalizeConfig({ seed: 0 }).seed, 0, "seed 0 must be preserved");
assert.notEqual(normalizeConfig({ seed: "" }).seed, 0, "blank seed must use the default");

const catalogText = fs.readFileSync(path.join(root, "scripts/catalog.js"), "utf8");
const physicsText = fs.readFileSync(path.join(root, "scripts/physics.js"), "utf8");
assert.doesNotMatch(catalogText + physicsText, /wallResistance|sideResistance|traits\.durability\b/);
assert.match(catalogText, /sideYieldFactor/);
assert.match(catalogText, /durabilityMult/);

const botControllerPath = path.join(root, "scripts/physics/bot-controller.js");
assert.ok(fs.existsSync(botControllerPath), "bot controller was not extracted from RaceSimulation");
assert.match(physicsText, /return computeBotInput\(\{/);
assert.ok((physicsText.match(/#botInput\(car, dt, routeContext\)/g) ?? []).length === 1);
const { shouldBotPit } = await import(pathToFileURL(botControllerPath).href);
const botFixture = {
  pitStopsCompleted: 0, pitStopsRequired: 1, lap: 1, finishBlocked: false,
  health: 100, physics: { maxHealth: 100 }, overheated: false
};
assert.equal(shouldBotPit(botFixture, 3), true);
assert.equal(shouldBotPit({ ...botFixture, lap: 0 }, 3), false);
const garageText = fs.readFileSync(path.join(appDir, "garage-controller.js"), "utf8");
const templateText = fs.readFileSync(path.join(root, "templates/app.hbs"), "utf8");
assert.match(garageText, /DRIVER_POINT_BUDGET/);
assert.match(garageText, /deriveCarPhysics/);
assert.match(templateText, /data-driver-step/);
assert.match(templateText, /data-physics-preview/);
assert.match(templateText, /data-nfs-tooltip/);
assert.doesNotMatch(templateText, /data-tooltip=/, "Foundry and module tooltips must not share the same trigger attribute");
assert.match(templateText, /data-action="copy-performance-report"/);
assert.match(templateText, /data-hud-pits>0 \/ \{\{requiredPitStops\}\}/);
assert.match(templateText, /data-driver-points-status role="status" aria-live="polite"/);
assert.match(templateText, /data-race-focus role="button" tabindex="-1" aria-hidden="true"/,
  "the initially hidden focus notice must not enter the accessibility tree or tab order");
assert.match(raceInputText, /setAttribute\("aria-hidden", String\(!lost\)\)/);
assert.match(raceInputText, /setAttribute\("tabindex", lost \? "0" : "-1"\)/);
assert.match(templateText, /data-pit-overlay hidden role="dialog"/);
assert.doesNotMatch(templateText, /nfs-field--tooltip|nfs-card--bolide|nfs-section--profile|nfs-section--talents|nfs-section__count/);
assert.doesNotMatch(templateText, /nfs-chip--neutral|nfs-section__title--plain|class="[^"]*nfs-lobby(?:\s|")/, "empty UI modifiers returned");
assert.doesNotMatch(garageText, /driverPointsRemaining|rawValue:/, "unused garage context returned");
assert.doesNotMatch(fs.readFileSync(path.join(appDir, "lobby-controller.js"), "utf8"), /isJoinable:/, "unused lobby context returned");
assert.match(racingAppText, /case "copy-performance-report"/);
const raceRuntimeText = fs.readFileSync(path.join(appDir, "race-runtime.js"), "utf8");
assert.match(raceRuntimeText, /copyPerformanceReport\(\)/);
assert.match(raceRuntimeText, /handleClaimControl\(message\)[\s\S]*lastInputSequence\.delete\(message\.carId\)/,
  "reclaiming control must reopen the host-side input sequence window");
const tooltipText = fs.readFileSync(path.join(appDir, "tooltip-controller.js"), "utf8");
assert.match(tooltipText, /document\.body\.append/);
assert.match(tooltipText, /positionFrame/);
assert.match(tooltipText, /Math\.round\(Math\.max\(margin, left\)\)/, "tooltip placement must clamp the final left edge to the viewport margin");
assert.match(racingAppText, /#restoreRaceState\(raceState = \{\}\)/,
  "race-state restoration must tolerate an omitted payload");
assert.match(racingAppText, /const \{ race, snapshot, results \} = raceState \?\? \{\}/,
  "race-state restoration must tolerate a null payload");

// Smoke-import and construct the ApplicationV2 coordinator with minimal Foundry globals.
class ApplicationV2 {
  get state() { return 0; }
  constructor() { this.rendered = false; this.element = null; }
}
globalThis.foundry.applications = { api: { ApplicationV2, HandlebarsApplicationMixin: (Base) => class extends Base {} } };
globalThis.foundry.utils.mergeObject = (base, extra) => ({ ...structuredClone(base), ...structuredClone(extra ?? {}) });
globalThis.game = {
  user: { id: "user", name: "User", isGM: true },
  users: new Map(),
  settings: { get: (_module, key) => key === "minimapEnabled" ? true : key === "cameraMode" ? "overview" : {}, set: async () => {} }
};
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
let removedAudioHook = null;
globalThis.Hooks = {
  on: (name) => name === "fblNeedForSpeedAudioSettingsChanged" ? 77 : null,
  off: (name, id) => { removedAudioHook = { name, id }; }
};
const network = {
  lobby: null, participant: null, isHost: false,
  on: () => () => {}, requestState() {}
};
const racingAppUrl = pathToFileURL(path.join(appDir, "racing-app.js"));
racingAppUrl.searchParams.set("smoke", String(Date.now()));
const { BigRacesApp } = await import(racingAppUrl.href);
const app = new BigRacesApp(network);
assert.equal(app.screen, "garage");
app.runtime.start({
  config: { seed: 1, trackComplexity: 1, environmentTheme: "industrial" },
  entries: [{ id: "player-user", userId: "user", name: "Player", build: app.garage.build, isBot: false }],
  host: false,
  raceId: "restored-race",
  initialSnapshot: { cars: [{ id: "player-user", abandoned: true, isBot: true }] },
  assignedCarId: "player-user"
});
assert.equal(app.runtime.localCarId, null, "an abandoned car was restored as locally controllable");
app.shutdown();
assert.deepEqual(removedAudioHook, { name: "fblNeedForSpeedAudioSettingsChanged", id: 77 },
  "application shutdown did not release the audio settings hook");

console.log("app-architecture-tests: ok");

// Local worker frames use production timestamps and the renderer snapshot buffer.
// Presentation must not reset a pairwise alpha on every delivered message.
{
  const runtimeSource = fs.readFileSync(path.join(root, "scripts/app/race-runtime.js"), "utf8");
  const workerSource = fs.readFileSync(path.join(root, "scripts/simulation-worker.js"), "utf8");
  const constantsSource = fs.readFileSync(path.join(root, "scripts/constants.js"), "utf8");
  assert.match(runtimeSource, /pushSnapshot\(message\.snapshot, \{ source: "worker", generatedAt: message\.generatedAt \}\)/);
  assert.doesNotMatch(runtimeSource, /workerSnapshotInterval/);
  assert.match(workerSource, /generatedAt: performance\.timeOrigin \+ performance\.now\(\)/);
  assert.match(constantsSource, /WORKER_SNAPSHOT_HZ = 30/);
}
