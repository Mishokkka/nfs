import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parent = path.dirname(root);
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const dist = path.join(root, "dist");
const output = path.join(dist, `fbl-need-for-speed-${pkg.version}.zip`);
fs.mkdirSync(dist, { recursive: true });
fs.rmSync(output, { force: true });

const result = spawnSync("zip", [
  "-qr", output, path.basename(root),
  "-x", `${path.basename(root)}/node_modules/*`,
  "-x", `${path.basename(root)}/dist/*`,
  "-x", `${path.basename(root)}/.git/*`
], { cwd: parent, stdio: "inherit" });

if (result.error) throw new Error(`Unable to run zip: ${result.error.message}`);
if (result.status !== 0) throw new Error(`zip exited with status ${result.status}`);
console.log(output);
