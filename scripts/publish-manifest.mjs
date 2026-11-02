import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const REPOSITORY = "Mishokkka/nfs";
const MODULE_ID = "fbl-need-for-speed";
const UPDATE_URL = `https://github.com/${REPOSITORY}/releases/latest/download/module.json`;
const stableVersion = version => /^\d+\.\d+\.\d+$/.test(version);
const compareVersion = (a, b) => {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
};

function validateRelease(manifestText, release, { allowDraft = false } = {}) {
  const manifest = JSON.parse(manifestText);
  if (manifest.id !== MODULE_ID || !stableVersion(manifest.version)
    || manifest.manifest !== UPDATE_URL || release.tag_name !== `v${manifest.version}`
    || !(release.draft === false && release.published_at || allowDraft && release.draft === true)
    || release.prerelease !== false
    || manifest.download !== `https://github.com/${REPOSITORY}/releases/download/v${manifest.version}/${MODULE_ID}-${manifest.version}.zip`) {
    throw new Error("Refusing to expose a manifest without its public stable release");
  }
  for (const name of ["module.json", `${MODULE_ID}-${manifest.version}.zip`, "SHA256SUMS.txt"]) {
    const asset = release.assets?.find(item => item.name === name);
    if (asset?.state !== "uploaded" || !(asset.size > 0)
      || (name === "module.json" && asset.size !== Buffer.byteLength(manifestText))) {
      throw new Error(`Release asset missing or incomplete: ${name}`);
    }
  }
  return manifest;
}

function legacyManifest(current) {
  if (!current) return null;
  if (!current.sha || typeof current.content !== "string") throw new Error("Invalid existing manifest response");
  const manifest = JSON.parse(Buffer.from(current.content, "base64").toString("utf8"));
  if (manifest.id !== MODULE_ID || !stableVersion(manifest.version)) throw new Error("Invalid existing public manifest");
  return manifest;
}

/** Plan the legacy raw-main update only from a complete public stable release.
 * The content SHA also makes GitHub reject a concurrent manifest replacement. */
export function publicManifestUpdate(manifestText, release, current = null) {
  const manifest = validateRelease(manifestText, release);
  if (current) {
    const previous = legacyManifest(current);
    const previousText = Buffer.from(current.content, "base64").toString("utf8");
    if (compareVersion(previous.version, manifest.version) > 0) throw new Error("Refusing to roll back the public manifest");
    if (previousText === manifestText) return null;
  }
  return { message: `Publish v${manifest.version} manifest after release assets`, branch: "main",
    content: Buffer.from(manifestText).toString("base64"), ...(current ? { sha: current.sha } : {}) };
}

/** Run inside the repository-wide stable-release concurrency group. Validate
 * both channels BEFORE publishing, then publish without changing Latest. Only
 * complete public assets may advance legacy; a failed legacy write leaves
 * Latest untouched. A later-finishing older tag is published as history only. */
export async function publishRelease(api, tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error("Only stable release tags update the public channels");
  let release = await api.release(tag);
  if (release.tag_name !== tag) throw new Error("Release tag differs from the requested tag");
  const text = await api.manifest(tag);
  const candidate = validateRelease(text, release, { allowDraft: true });
  const channels = async () => {
    const latest = await api.latest();
    const latestManifest = latest ? validateRelease(await api.manifest(latest.tag_name), latest) : null;
    const legacy = await api.legacy();
    const previous = legacyManifest(legacy);
    const newer = [latestManifest, previous].some(item => item && compareVersion(item.version, candidate.version) > 0);
    return { latest, legacy, newer };
  };
  const before = await channels();
  if (release.draft) {
    await api.publishWithoutLatest(release);
    release = await api.release(tag);
    if (await api.manifest(tag) !== text) throw new Error("Manifest asset changed during publication");
  }
  validateRelease(text, release);
  const current = await channels();
  if (before.newer || current.newer) return { promoted: false, reason: "newer-public-version" };
  const payload = publicManifestUpdate(text, release, current.legacy);
  if (payload) await api.updateLegacy(payload);
  // Other tag jobs are serialized, but recheck before the final side effect so
  // a newer external promotion observed here is never replaced by this tag.
  const final = await channels();
  if (final.newer) return { promoted: false, reason: "newer-public-version" };
  if (final.latest?.tag_name !== tag) await api.promote(release);
  return { promoted: true };
}

export function verifyPublicManifest(localText, releasedText, release) {
  publicManifestUpdate(releasedText, release);
  // Checkout can convert LF to CRLF on Windows; validate the release asset's
  // bytes, then compare the actual JSON metadata rather than checkout endings.
  if (!isDeepStrictEqual(JSON.parse(localText), JSON.parse(releasedText))) {
    throw new Error("Public manifest differs from the published release asset");
  }
}

function gh(...args) {
  if (process.env.GH_REPO !== REPOSITORY) throw new Error("Unexpected release repository");
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
}

function checkPublicManifest() {
  const manifestPath = new URL("../module.json", import.meta.url);
  if (!fs.existsSync(manifestPath)) return;
  const manifestText = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  if (!stableVersion(manifest.version)) throw new Error("Invalid public manifest version");
  const tag = `v${manifest.version}`;
  const release = JSON.parse(gh("api", `repos/${REPOSITORY}/releases/tags/${tag}`));
  const releasedText = gh("release", "download", tag, "--repo", REPOSITORY, "--pattern", "module.json", "--output", "-");
  verifyPublicManifest(manifestText, releasedText, release);
}

function optionalResource(endpoint, run = gh) {
  try { return JSON.parse(run("api", endpoint)); }
  catch (error) { if (!String(error.stderr ?? "").includes("HTTP 404")) throw error; return null; }
}

function writeResource(method, endpoint, payload, run = gh) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nfs-release-manifest-"));
  const payloadPath = path.join(directory, "manifest-update.json");
  try {
    fs.writeFileSync(payloadPath, JSON.stringify(payload));
    run("api", "--method", method, endpoint, "--input", payloadPath);
  } finally { fs.rmSync(payloadPath, { force: true }); fs.rmdirSync(directory); }
}

/** Whole-job retries must reach the publisher without replacing public assets. */
export async function prepareRelease(api, tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error("Only stable tags may prepare release assets");
  const release = await api.findRelease(tag);
  if (!release) { await api.createDraft(tag); return "created"; }
  if (release.tag_name !== tag || release.prerelease !== false) throw new Error("Unexpected existing release");
  if (release.draft === true) { await api.uploadDraft(release); return "uploaded-draft"; }
  if (release.draft === false && release.published_at) return "reuse-published";
  throw new Error("Invalid release state");
}

export function createReleaseApi(run = gh) {
  const endpoint = `repos/${REPOSITORY}`;
  const find = tag => {
    // The list explicitly includes drafts for a writer token. Do not depend on
    // the published-release-by-tag endpoint for the initial draft lookup.
    const pages = JSON.parse(run("api", "--paginate", "--slurp", `${endpoint}/releases?per_page=100`));
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error("Invalid releases list response");
    const matches = pages.flat().filter(item => item.tag_name === tag);
    if (matches.length > 1) throw new Error(`Ambiguous releases for ${tag}`);
    return matches[0] ?? null;
  };
  const required = tag => { const release = find(tag); if (!release) throw new Error(`Release missing for ${tag}`); return release; };
  const assets = tag => [`dist/${MODULE_ID}-${tag.slice(1)}.zip`, "dist/SHA256SUMS.txt", "dist/module.json"];
  return {
    findRelease: find,
    release: required,
    createDraft: tag => run("release", "create", tag, ...assets(tag), "--repo", REPOSITORY, "--draft", "--verify-tag", "--title", tag, "--generate-notes"),
    uploadDraft: release => {
      const current = required(release.tag_name);
      if (current.id !== release.id || current.draft !== true || current.prerelease !== false) throw new Error("Refusing to replace assets outside the original draft");
      return run("release", "upload", current.tag_name, ...assets(current.tag_name), "--repo", REPOSITORY, "--clobber");
    },
    manifest: tag => run("release", "download", tag, "--repo", REPOSITORY, "--pattern", "module.json", "--output", "-"),
    latest: () => optionalResource(`${endpoint}/releases/latest`, run),
    legacy: () => optionalResource(`${endpoint}/contents/module.json?ref=main`, run),
    publishWithoutLatest: release => writeResource("PATCH", `${endpoint}/releases/${release.id}`, { draft: false, make_latest: "false" }, run),
    updateLegacy: payload => writeResource("PUT", `${endpoint}/contents/module.json`, payload, run),
    promote: release => writeResource("PATCH", `${endpoint}/releases/${release.id}`, { make_latest: "true" }, run)
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === "--check") checkPublicManifest();
  else if (process.argv[2] === "--prepare") await prepareRelease(createReleaseApi(), process.env.GITHUB_REF_NAME);
  else await publishRelease(createReleaseApi(), process.env.GITHUB_REF_NAME);
}
