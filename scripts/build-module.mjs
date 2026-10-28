import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "module.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (manifest.version !== pkg.version) throw new Error("Run npm run sync-version before building");
const files = ["module.json", "README.md", "CHANGELOG.md"];
for (const directory of ["scripts", "styles", "templates", "sounds", "docs"]) {
  for (const relative of fs.readdirSync(path.join(root, directory), { recursive: true })) {
    const file = path.join(directory, String(relative));
    if (fs.statSync(path.join(root, file)).isFile() && !file.endsWith(".mjs")) files.push(file);
  }
}
// Deterministic ZIP: no external executable or dependency, runtime files only,
// under the canonical module ID regardless of the checkout directory's name.
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = (data) => {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const chunks = [], central = [];
let offset = 0;
for (const file of files.sort()) {
  const name = Buffer.from(`${manifest.id}/${file.replaceAll("\\", "/")}`);
  const data = fs.readFileSync(path.join(root, file));
  const compressed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(33, 12); // 1980-01-01
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  chunks.push(local, name, compressed);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  local.copy(entry, 6, 4, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, name);
  offset += local.length + name.length + compressed.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...chunks, directory, end]);
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
const name = `${manifest.id}-${pkg.version}.zip`;
fs.writeFileSync(path.join(dist, name), archive);
fs.writeFileSync(path.join(dist, "SHA256SUMS.txt"), `${createHash("sha256").update(archive).digest("hex")}  ${name}\n`);
console.log(path.join(dist, name));
