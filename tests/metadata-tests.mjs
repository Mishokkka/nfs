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
const networkNotes = readme.slice(readme.indexOf("## Сетевая модель"));
assert.match(networkNotes, new RegExp(`с частотой ${constants.SNAPSHOT_HZ} Гц`));
assert.match(networkNotes, new RegExp(`Протокол версии ${constants.PROTOCOL_VERSION} использует`));
const history = readme.split("## Изменения 0.16.6")[1].split("## ")[0];
assert.ok(history.includes("с 10 до 15 Гц") && history.includes("Протокол версии 13 сохранён"), "historical 0.16.6 notes were rewritten");
assert.doesNotMatch(css, /padding:\s*0\s*!important|overflow:\s*hidden\s*!important/);
assert.match(worker, /postMessage\(\s*\{\s*type:\s*"finished"[\s\S]*?clearClockTimer\(\)/,
  "worker must stop its clock after publishing the final snapshot");

console.log("metadata-tests: ok");
