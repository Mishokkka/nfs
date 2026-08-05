import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "module.json"), "utf8"));
const expectedOrder = [
  "styles/fbl-need-for-speed.css",
  "styles/layout/shell.css",
  "styles/components/components.css",
  "styles/screens/garage.css",
  "styles/screens/lobby.css",
  "styles/screens/race.css",
  "styles/screens/results.css",
  "styles/responsive.css",
  "styles/accessibility.css"
];
assert.deepEqual(manifest.styles, expectedOrder, "CSS load order changed without updating the architecture contract");

const allCss = manifest.styles.map((relative) => fs.readFileSync(path.join(root, relative), "utf8")).join("\n");
const selectorOwners = new Map();
for (const relative of manifest.styles) {
  const absolute = path.join(root, relative);
  assert.ok(fs.existsSync(absolute), `${relative} is missing`);
  const css = fs.readFileSync(absolute, "utf8");
  assert.doesNotMatch(css, /\/\*\s*v\d/i, `${relative} contains a historical version patch`);
  assert.doesNotMatch(css, /@layer\b/, `${relative} uses cascade layers that lose to Foundry's unlayered author CSS`);
  assert.doesNotMatch(css, /\.nfs-field--span-2\b/, `${relative} contains an obsolete selector`);

  let depth = 0;
  let quote = null;
  let comment = false;
  for (let i = 0; i < css.length; i += 1) {
    const char = css[i];
    const next = css[i + 1];
    if (comment) {
      if (char === "*" && next === "/") { comment = false; i += 1; }
      continue;
    }
    if (!quote && char === "/" && next === "*") { comment = true; i += 1; continue; }
    if (quote) {
      if (char === "\\") { i += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    assert.ok(depth >= 0, `${relative} closes more blocks than it opens`);
  }
  assert.equal(depth, 0, `${relative} has unbalanced braces`);

  if (relative !== "styles/responsive.css" && relative !== "styles/accessibility.css") {
    for (const match of css.matchAll(/(?:^|\})\s*([^@{}][^{}]*)\{/g)) {
      const selector = match[1].trim().replace(/\s+/g, " ");
      if (!selector || selector === "from" || selector === "to" || /^\d+%$/.test(selector)) continue;
      assert.ok(!selectorOwners.has(selector), `${selector} is defined in both ${selectorOwners.get(selector)} and ${relative}`);
      selectorOwners.set(selector, relative);
    }
  }

  if (relative !== "styles/accessibility.css") {
    assert.doesNotMatch(css, /!important\b/, `${relative} contains !important outside the reduced-motion contract`);
  }
}

const foundation = fs.readFileSync(path.join(root, expectedOrder[0]), "utf8");
assert.match(foundation, /min-width:\s*360px/);
assert.match(foundation, /color-scheme:\s*dark/);
assert.match(foundation, /header-control\[data-action="close"\]::after/,
  "ApplicationV2 close control lacks a font-independent cross");
assert.match(foundation, /rotate\(-45deg\)/);
const responsive = fs.readFileSync(path.join(root, "styles/responsive.css"), "utf8");
assert.match(responsive, /@media \(max-width:\s*480px\)/);
assert.doesNotMatch(responsive, /min-width:\s*(?:480|560)px/);
assert.equal((responsive.match(/@media \(max-width:\s*720px\)/g) ?? []).length, 1, "720px breakpoint is duplicated");
assert.doesNotMatch(allCss, /nfs-heat-pulse|nfs-talent__copy small|nfs-attribute__copy small/);
assert.match(allCss, /\.nfs-talent:focus-within/);

console.log("css-architecture-tests: ok");
