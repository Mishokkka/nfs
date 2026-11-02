import assert from "node:assert/strict";
import fs from "node:fs";
import { publishRelease, prepareRelease, createReleaseApi } from "../scripts/publish-manifest.mjs";

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

// Exercise the real CLI adapter: draft lookup must paginate the draft-capable
// list, preserve the REST id and never call the published-only tag endpoint.
{
  const draft = { id: 123, tag_name: "v0.17.0", draft: true, prerelease: false }, calls = [];
  const api = createReleaseApi((...args) => {
    calls.push(args);
    if (args[0] === "api" && args.at(-1).endsWith("/releases?per_page=100")) return JSON.stringify([[{ id: 1, tag_name: "v0.16.10" }], [draft]]);
    if (args[0] === "release" && args[1] === "upload") return "";
    if (args[0] === "api" && args.includes("--method")) {
      const payload = JSON.parse(fs.readFileSync(args[args.indexOf("--input") + 1]));
      assert.equal(payload.make_latest, "false");
      assert.ok(args.includes("repos/Mishokkka/nfs/releases/123"));
      return "{}";
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  });
  assert.deepEqual(api.release("v0.17.0"), draft);
  assert.ok(calls[0].includes("--paginate") && calls[0].includes("--slurp"));
  assert.equal(await prepareRelease(api, "v0.17.0"), "uploaded-draft");
  const upload = calls.find(args => args[1] === "upload");
  assert.ok(upload.includes("--clobber") && upload.includes("dist/fbl-need-for-speed-0.17.0.zip"));
  api.publishWithoutLatest(draft);
  assert.throws(() => createReleaseApi(() => JSON.stringify([[draft], [draft]])).release("v0.17.0"), /Ambiguous/);
  assert.throws(() => createReleaseApi(() => "[[]]").release("v0.17.0"), /missing/);
  const creates = [], empty = createReleaseApi((...args) => {
    if (args[0] === "api") return "[[]]";
    creates.push(args); return "";
  });
  assert.equal(await prepareRelease(empty, "v0.17.0"), "created");
  assert.ok(creates[0].includes("--draft") && creates[0].includes("--verify-tag"));
  let reads = 0;
  const changed = createReleaseApi((...args) => {
    assert.equal(args[0], "api", "uploaded after the draft became public");
    return JSON.stringify([[++reads === 1 ? draft : { ...draft, draft: false, published_at: "now" }]]);
  });
  await assert.rejects(prepareRelease(changed, "v0.17.0"), /Refusing/);
}

// Whole-job retry: an existing partial draft is completed; a failure AFTER
// publication reuses public assets without clobber and reaches the publisher.
for (const failedStage of ["upload", "legacy"]) {
  const f = fixture(), actions = [];
  let failUpload = failedStage === "upload";
  Object.assign(f.api, {
    findRelease: async tag => structuredClone(f.releases.get(tag)?.release ?? null),
    createDraft: async tag => { actions.push("create"); f.add(tag.slice(1)); },
    uploadDraft: async release => {
      assert.equal(release.draft, true); actions.push("upload-draft");
      if (failUpload) { failUpload = false; throw new Error("interrupted upload"); }
    }
  });
  if (failedStage === "upload") {
    f.add("0.17.0");
    await assert.rejects(prepareRelease(f.api, "v0.17.0"), /interrupted/);
  } else {
    await prepareRelease(f.api, "v0.17.0"); f.denyLegacy(true);
    await assert.rejects(publishRelease(f.api, "v0.17.0"), /denied/); f.denyLegacy(false);
  }
  const assetsBeforeRetry = structuredClone(f.releases.get("v0.17.0").release.assets);
  await prepareRelease(f.api, "v0.17.0"); await publishRelease(f.api, "v0.17.0");
  assert.deepEqual(f.versions(), { latest: "0.17.0", legacy: "0.17.0" });
  assert.deepEqual(f.releases.get("v0.17.0").release.assets, assetsBeforeRetry);
  assert.deepEqual(actions, failedStage === "upload" ? ["upload-draft", "upload-draft"] : ["create"]);
}
{
  let writes = 0;
  await assert.rejects(prepareRelease({ findRelease: async () => { throw new Error("API unavailable"); }, createDraft: () => writes++ }, "v0.17.0"), /unavailable/);
  await assert.rejects(prepareRelease({ findRelease: async () => ({ tag_name: "v0.17.0", draft: true, prerelease: true }), uploadDraft: () => writes++ }, "v0.17.0"));
  assert.equal(writes, 0, "lookup errors were interpreted as an absent release");
}

// All stable tags must share the same non-cancelling queue, rather than one
// lock per tag. The workflow must delegate promotion to the tested sequence.
const workflow = fs.readFileSync(new URL("../.github/workflows/checks.yml", import.meta.url), "utf8");
assert.match(workflow, /concurrency:\s+group: nfs-stable-release\s+cancel-in-progress: false\s+queue: max/);
assert.doesNotMatch(workflow, /gh release edit[^\n]*--latest/);
assert.match(workflow, /run: node scripts\/publish-manifest\.mjs --prepare/);
console.log("release-channel-tests: ok (ordered/out-of-order tags, both channels at every mutation, retries, failures and publication guards)");
