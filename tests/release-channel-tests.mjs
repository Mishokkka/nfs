import assert from "node:assert/strict";
import fs from "node:fs";
import { publishRelease } from "../scripts/publish-manifest.mjs";

const source = JSON.parse(fs.readFileSync(new URL("../module-source.json", import.meta.url)));
const manifest = version => `${JSON.stringify({ ...source, version,
  download: `https://github.com/Mishokkka/nfs/releases/download/v${version}/fbl-need-for-speed-${version}.zip` })}\n`;
const rank = version => version.split(".").reduce((value, part) => value * 1000n + BigInt(part), 0n);

function fixture({ latest = "0.16.10", legacy = latest } = {}) {
  const releases = new Map(), effects = [];
  let latestTag = latest ? `v${latest}` : null, legacyValue = null, serial = 0;
  let failLegacy = false, failPromotion = false, afterPublication = null, legacyReads = 0;
  const add = (version, draft = true) => {
    const text = manifest(version), tag = `v${version}`;
    releases.set(tag, { text, release: { id: ++serial, tag_name: tag, draft, prerelease: false,
      published_at: draft ? null : "2026-11-02T00:00:00Z", assets: [
        { name: "module.json", state: "uploaded", size: Buffer.byteLength(text) },
        { name: `fbl-need-for-speed-${version}.zip`, state: "uploaded", size: 100 },
        { name: "SHA256SUMS.txt", state: "uploaded", size: 100 }
      ] } });
  };
  if (latest) add(latest, false);
  if (legacy && !releases.has(`v${legacy}`)) add(legacy, false);
  if (legacy) legacyValue = { sha: `sha-${++serial}`, content: Buffer.from(manifest(legacy)).toString("base64") };
  const versions = () => ({ latest: latestTag?.slice(1) ?? null,
    legacy: legacyValue ? JSON.parse(Buffer.from(legacyValue.content, "base64").toString()).version : null });
  let previous = versions();
  const record = effect => {
    const current = versions();
    for (const channel of ["latest", "legacy"]) {
      assert.ok(!previous[channel] || current[channel] && rank(current[channel]) >= rank(previous[channel]), `${channel} regressed during ${effect}`);
      if (current[channel]) assert.equal(releases.get(`v${current[channel]}`).release.draft, false, `${channel} advertised a draft`);
    }
    effects.push({ effect, ...current }); previous = current;
  };
  const api = {
    release: async tag => structuredClone(releases.get(tag).release),
    manifest: async tag => releases.get(tag).text,
    latest: async () => latestTag ? structuredClone(releases.get(latestTag).release) : null,
    legacy: async () => { legacyReads++; return structuredClone(legacyValue); },
    publishWithoutLatest: async release => {
      assert.ok(legacyReads > 0, "publication happened before both channel checks");
      Object.assign(releases.get(release.tag_name).release, { draft: false, published_at: "2026-11-02T00:00:00Z" });
      record("publish-without-latest");
      if (afterPublication) afterPublication();
    },
    updateLegacy: async payload => {
      assert.equal(payload.sha, legacyValue?.sha, "Contents API SHA mismatch");
      if (failLegacy) throw new Error("legacy write denied");
      legacyValue = { sha: `sha-${++serial}`, content: payload.content }; record("legacy");
    },
    promote: async release => {
      if (failPromotion) throw new Error("Latest write failed");
      latestTag = release.tag_name; record("latest");
    }
  };
  return { api, add, effects, releases, versions,
    denyLegacy: value => { failLegacy = value; }, denyPromotion: value => { failPromotion = value; },
    afterPublication: fn => { afterPublication = fn; },
    externalLatest: version => { latestTag = `v${version}`; record("external-latest"); } };
}

// Model the complete publication sequence, checking BOTH URLs after every
// mutation. Later-finishing backports may enter history without rollback.
for (const order of [["0.18.0", "0.17.1"], ["0.17.1", "0.18.0"]]) {
  const f = fixture();
  for (const version of order) f.add(version);
  for (const version of order) await publishRelease(f.api, `v${version}`);
  assert.deepEqual(f.versions(), { latest: "0.18.0", legacy: "0.18.0" });
  assert.equal(f.releases.get("v0.17.1").release.draft, false);
  assert.deepEqual(f.effects.map(item => item.effect), order[0] === "0.18.0"
    ? ["publish-without-latest", "legacy", "latest", "publish-without-latest"]
    : ["publish-without-latest", "legacy", "latest", "publish-without-latest", "legacy", "latest"]);
}

// Missing or divergent legacy channels must not hide a newer real Latest.
for (const channels of [{ latest: "0.18.0", legacy: null }, { latest: "0.18.0", legacy: "0.16.10" },
  { latest: "0.16.10", legacy: "0.18.0" }, { latest: null, legacy: "0.18.0" }]) {
  const f = fixture(channels); f.add("0.17.1");
  assert.equal((await publishRelease(f.api, "v0.17.1")).promoted, false);
  assert.deepEqual(f.versions(), channels);
  assert.deepEqual(f.effects.map(item => item.effect), ["publish-without-latest"]);
}

// First release and retries after partial success. A failed legacy write must
// not select Latest; a failed final promotion can safely be retried.
for (const failure of [null, "legacy", "latest"]) {
  const f = fixture({ latest: null, legacy: null }); f.add("0.17.0");
  if (failure) {
    f.denyLegacy(failure === "legacy"); f.denyPromotion(failure === "latest");
    await assert.rejects(publishRelease(f.api, "v0.17.0"), /write/);
    assert.equal(f.versions().latest, null);
    f.denyLegacy(false); f.denyPromotion(false);
  }
  assert.equal((await publishRelease(f.api, "v0.17.0")).promoted, true);
  assert.deepEqual(f.versions(), { latest: "0.17.0", legacy: "0.17.0" });
  const effects = f.effects.length;
  await publishRelease(f.api, "v0.17.0");
  assert.equal(f.effects.length, effects, "retry rewrote already-current channels");
}

// Bad assets/metadata fail before publication, including malformed current
// channels. A newer promotion arriving during publication is reread afterward.
for (const invalid of ["missing-zip", "uploading", "prerelease", "tag", "bad-latest"]) {
  const f = fixture(); f.add("0.17.0");
  const release = f.releases.get("v0.17.0").release;
  if (invalid === "missing-zip") release.assets.splice(1, 1);
  if (invalid === "uploading") release.assets[0].state = "uploading";
  if (invalid === "prerelease") release.prerelease = true;
  if (invalid === "tag") release.tag_name = "v0.18.0";
  if (invalid === "bad-latest") f.releases.get("v0.16.10").release.assets = [];
  await assert.rejects(publishRelease(f.api, "v0.17.0"));
  assert.equal(f.effects.length, 0, `${invalid} performed a side effect`);
}
{
  const f = fixture(); f.add("0.17.0"); f.add("0.18.0", false);
  f.afterPublication(() => f.externalLatest("0.18.0"));
  assert.equal((await publishRelease(f.api, "v0.17.0")).promoted, false);
  assert.deepEqual(f.versions(), { latest: "0.18.0", legacy: "0.16.10" });
}

// All stable tags must share the same non-cancelling queue, rather than one
// lock per tag. The workflow must delegate promotion to the tested sequence.
const workflow = fs.readFileSync(new URL("../.github/workflows/checks.yml", import.meta.url), "utf8");
assert.match(workflow, /concurrency:\s+group: nfs-stable-release\s+cancel-in-progress: false\s+queue: max/);
assert.doesNotMatch(workflow, /gh release edit[^\n]*--latest/);
console.log("release-channel-tests: ok (ordered/out-of-order tags, both channels at every mutation, retries, failures and publication guards)");
