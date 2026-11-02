import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { publicManifestUpdate, verifyPublicManifest } from "../scripts/publish-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "module-source.json"), "utf8"));
const constants = await import(pathToFileURL(path.join(root, "scripts/constants.js")).href);
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const css = manifest.styles.map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
const runtime = fs.readFileSync(path.join(root, "scripts/app/race-runtime.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "scripts/simulation-worker.js"), "utf8");

assert.equal(manifest.version, pkg.version, "module-source.json and package.json versions diverged");
assert.equal(constants.VERSION, pkg.version, "constants VERSION and package.json diverged");
assert.equal(manifest.manifest, "https://github.com/Mishokkka/nfs/releases/latest/download/module.json", "manifest update URL is missing or stale");
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

// The raw-main compatibility manifest may be created/advanced only after all
// assets are public. Never advertise a draft, incomplete release or rollback.
{
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const release = { tag_name: `v${manifest.version}`, draft: false, prerelease: false,
    published_at: "2026-11-02T00:00:00Z", assets: [
      { name: "module.json", state: "uploaded", size: Buffer.byteLength(text) },
      { name: `fbl-need-for-speed-${manifest.version}.zip`, state: "uploaded", size: 100 },
      { name: "SHA256SUMS.txt", state: "uploaded", size: 100 }
    ] };
  const payload = publicManifestUpdate(text, release);
  assert.equal(Buffer.from(payload.content, "base64").toString(), text);
  assert.equal(payload.branch, "main");
  assert.doesNotThrow(() => verifyPublicManifest(text.replaceAll("\n", "\r\n"), text, release), "Windows checkout line endings invalidated a published manifest");
  assert.throws(() => verifyPublicManifest(JSON.stringify({ ...manifest, version: "99.0.0" }), text, release));
  assert.equal(publicManifestUpdate(text, release, { sha: "current", content: payload.content }), null);
  const prior = { ...manifest, version: "0.16.10" };
  const current = { sha: "previous", content: Buffer.from(JSON.stringify(prior)).toString("base64") };
  assert.equal(publicManifestUpdate(text, release, current).sha, "previous");
  for (const incomplete of [
    { ...release, draft: true }, { ...release, prerelease: true }, { ...release, published_at: null },
    { ...release, assets: release.assets.filter(asset => !asset.name.endsWith(".zip")) },
    { ...release, assets: release.assets.map(asset => ({ ...asset, state: "uploading" })) },
    { ...release, assets: release.assets.map(asset => ({ ...asset, size: 0 })) }
  ]) assert.throws(() => publicManifestUpdate(text, incomplete), "exposed an unpublished/incomplete release");
  assert.throws(() => publicManifestUpdate(text, { ...release, tag_name: "v0.1.0" }));
  assert.throws(() => publicManifestUpdate(text, release, { sha: "newer",
    content: Buffer.from(JSON.stringify({ ...manifest, version: "99.0.0" })).toString("base64") }));
}

// Sync/build must use the development manifest without modifying the public
// channel. Inspect the actual ZIP entry, not only the separate dist manifest.
{
  const tempRoot = path.resolve(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(tempRoot, "nfs-package-test-"));
  try {
    for (const directory of ["scripts", "styles", "templates", "sounds", "docs"]) fs.mkdirSync(path.join(fixture, directory));
    for (const file of ["sync-version.mjs", "build-module.mjs"]) fs.copyFileSync(path.join(root, "scripts", file), path.join(fixture, "scripts", file));
    const publicBytes = Buffer.from(JSON.stringify({ ...manifest, version: "0.16.10" }));
    fs.writeFileSync(path.join(fixture, "module.json"), publicBytes);
    fs.writeFileSync(path.join(fixture, "module-source.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ version: "0.17.1" }));
    fs.writeFileSync(path.join(fixture, "scripts/constants.js"), `export const VERSION = "${manifest.version}";\n`);
    fs.writeFileSync(path.join(fixture, "README.md"), `- Версия: \`${manifest.version}\`\n`);
    fs.writeFileSync(path.join(fixture, "CHANGELOG.md"), "test fixture\n");
    execFileSync(process.execPath, [path.join(fixture, "scripts/sync-version.mjs")], { timeout: 10_000 });
    assert.deepEqual(fs.readFileSync(path.join(fixture, "module.json")), publicBytes, "sync-version modified the public update channel");
    execFileSync(process.execPath, [path.join(fixture, "scripts/build-module.mjs")], { timeout: 10_000 });
    const built = fs.readFileSync(path.join(fixture, "dist/module.json"));
    assert.deepEqual(built, fs.readFileSync(path.join(fixture, "module-source.json")));
    assert.equal(JSON.parse(built).version, "0.17.1");
    const archive = fs.readFileSync(path.join(fixture, "dist/fbl-need-for-speed-0.17.1.zip"));
    let archivedManifest = null;
    for (let offset = 0; archive.readUInt32LE(offset) === 0x04034b50;) {
      const size = archive.readUInt32LE(offset + 18), nameLength = archive.readUInt16LE(offset + 26), extraLength = archive.readUInt16LE(offset + 28);
      const start = offset + 30 + nameLength + extraLength;
      const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString();
      if (name === "fbl-need-for-speed/module.json") archivedManifest = inflateRawSync(archive.subarray(start, start + size));
      assert.ok(!name.includes("module-source.json"), "source manifest leaked into the installed module");
      offset = start + size;
    }
    assert.deepEqual(archivedManifest, built, "ZIP packaged the old public manifest instead of the current source");
    assert.deepEqual(fs.readFileSync(path.join(fixture, "module.json")), publicBytes, "build modified the public update channel");
  } finally {
    const relative = path.relative(tempRoot, path.resolve(fixture));
    assert.ok(relative.startsWith("nfs-package-test-") && !relative.includes(path.sep), "refusing to remove a fixture outside the temp directory");
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

console.log("metadata-tests: ok (source/build/public manifests and release publication guards)");
