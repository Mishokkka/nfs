import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(root, "package.json");
const modulePath = path.join(root, "module.json");
const constantsPath = path.join(root, "scripts/constants.js");
const readmePath = path.join(root, "README.md");

const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const version = String(pkg.version ?? "").trim();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid package version: ${version || "<empty>"}`);
}

const manifest = JSON.parse(fs.readFileSync(modulePath, "utf8"));
manifest.version = version;
manifest.manifest = "https://raw.githubusercontent.com/Mishokkka/nfs/main/module.json";
manifest.download = `https://github.com/Mishokkka/nfs/releases/download/v${version}/fbl-need-for-speed-${version}.zip`;

const constants = fs.readFileSync(constantsPath, "utf8");
const updatedConstants = constants.replace(
  /export const VERSION = "[^"]+";/,
  `export const VERSION = "${version}";`
);
if (updatedConstants === constants && !constants.includes(`export const VERSION = "${version}";`)) {
  throw new Error("VERSION constant was not found");
}

const readme = fs.readFileSync(readmePath, "utf8");
const updatedReadme = readme.replace(/- Версия: `[^`]+`/, `- Версия: \`${version}\``);
if (updatedReadme === readme && !readme.includes(`- Версия: \`${version}\``)) {
  throw new Error("README version line was not found");
}

fs.writeFileSync(modulePath, `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(constantsPath, updatedConstants);
fs.writeFileSync(readmePath, updatedReadme);

console.log(`Synchronized module version ${version}`);
