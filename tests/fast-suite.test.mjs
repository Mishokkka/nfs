import test from "node:test";
import { runScript } from "./test-harness.mjs";

test("catalog, track and short physics invariants", { timeout: 35_000 }, () => runScript("core-tests.mjs", { timeout: 30_000 }));
test("network protocol invariants", { timeout: 25_000 }, () => runScript("network-tests.mjs", { timeout: 20_000 }));
test("release metadata consistency", { timeout: 10_000 }, () => runScript("metadata-tests.mjs", { timeout: 5_000 }));

test("CSS architecture and narrow-window contract", { timeout: 10_000 }, () => runScript("css-architecture-tests.mjs", { timeout: 5_000 }));
