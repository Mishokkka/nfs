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

/** Plan the legacy raw-main update only from a complete public stable release.
 * The content SHA also makes GitHub reject a concurrent manifest replacement. */
export function publicManifestUpdate(manifestText, release, current = null) {
  const manifest = JSON.parse(manifestText);
  if (manifest.id !== MODULE_ID || !stableVersion(manifest.version)
    || manifest.manifest !== UPDATE_URL || release.tag_name !== `v${manifest.version}`
    || release.draft !== false || release.prerelease !== false || !release.published_at
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
  if (current) {
    if (!current.sha || typeof current.content !== "string") throw new Error("Invalid existing manifest response");
    const previousText = Buffer.from(current.content, "base64").toString("utf8");
    const previous = JSON.parse(previousText);
    if (previous.id !== MODULE_ID || !stableVersion(previous.version)
      || compareVersion(previous.version, manifest.version) > 0) throw new Error("Refusing to roll back the public manifest");
    if (previousText === manifestText) return null;
  }
  return { message: `Publish v${manifest.version} manifest after release assets`, branch: "main",
    content: Buffer.from(manifestText).toString("base64"), ...(current ? { sha: current.sha } : {}) };
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
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
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

function publishManifest() {
  const tag = process.env.GITHUB_REF_NAME;
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error("Only stable release tags update the public manifest");
  const release = JSON.parse(gh("api", `repos/${REPOSITORY}/releases/tags/${tag}`));
  const manifestText = gh("release", "download", tag, "--repo", REPOSITORY, "--pattern", "module.json", "--output", "-");
  let current = null;
  try { current = JSON.parse(gh("api", `repos/${REPOSITORY}/contents/module.json?ref=main`)); }
  catch (error) { if (!String(error.stderr ?? "").includes("HTTP 404")) throw error; }
  const payload = publicManifestUpdate(manifestText, release, current);
  if (!payload) return;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nfs-release-manifest-"));
  const payloadPath = path.join(directory, "manifest-update.json");
  try {
    fs.writeFileSync(payloadPath, JSON.stringify(payload));
    gh("api", "--method", "PUT", `repos/${REPOSITORY}/contents/module.json`, "--input", payloadPath);
  } finally { fs.rmSync(payloadPath, { force: true }); fs.rmdirSync(directory); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === "--check") checkPublicManifest();
  else publishManifest();
}
