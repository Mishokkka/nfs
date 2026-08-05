import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "module.json"), "utf8"));
const constants = await import(pathToFileURL(path.join(root, "scripts/constants.js")).href);
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const css = manifest.styles.map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
const runtime = fs.readFileSync(path.join(root, "scripts/app/race-runtime.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "scripts/simulation-worker.js"), "utf8");

assert.equal(manifest.version, pkg.version, "module.json and package.json versions diverged");
assert.equal(constants.VERSION, pkg.version, "constants VERSION and package.json diverged");
assert.equal(manifest.manifest, "https://raw.githubusercontent.com/Mishokkka/nfs/main/module.json", "manifest update URL is missing or stale");
assert.equal(manifest.download, `https://github.com/Mishokkka/nfs/releases/download/v${pkg.version}/fbl-need-for-speed-${pkg.version}.zip`, "release download URL is missing or stale");
assert.ok(readme.includes(`Версия: \`${pkg.version}\``), "README version is stale");
assert.match(readme, new RegExp(`${constants.SNAPSHOT_HZ} Гц`));
assert.match(readme, new RegExp(`${constants.INPUT_KEEPALIVE_MS} мс`));
assert.match(readme, /0,8 секунды/);
assert.match(readme, new RegExp(`Протокол версии ${constants.PROTOCOL_VERSION}`));
assert.doesNotMatch(css, /padding:\s*0\s*!important|overflow:\s*hidden\s*!important/);
assert.ok((runtime.match(/!this\.practice\s*&&\s*this\.network\.isHost\s*&&/g) ?? []).length >= 3,
  "authoritative snapshot sends must explicitly check network.isHost");
assert.match(worker, /postMessage\(\s*\{\s*type:\s*"finished"[\s\S]*?clearClockTimer\(\)/,
  "worker must stop its clock after publishing the final snapshot");

console.log("metadata-tests: ok");
