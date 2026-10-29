import test from "node:test";
import { runScript } from "./test-harness.mjs";

test("renderer snapshot buffering", { timeout: 20_000 }, () => runScript("renderer-tests.mjs", { timeout: 15_000 }));
test("worker protocol lifecycle", { timeout: 20_000 }, () => runScript("worker-tests.mjs", { timeout: 15_000 }));
test("garage estimates and full race checkpoints", { timeout: 30_000 }, () => runScript("refinement-tests.mjs", { timeout: 25_000 }));
test("city generation, building footprints and surfaces", { timeout: 35_000 }, () => runScript("track-environment-tests.mjs", { timeout: 30_000 }));
test("multiple virtual clients converge", { timeout: 20_000 }, () => runScript("multiclient-tests.mjs", { timeout: 15_000 }));

test("session recovery, input coalescing and app isolation", { timeout: 15_000 }, () => runScript("session-regression-tests.mjs", { timeout: 10_000 }));
test("application architecture and technical-debt guards", { timeout: 20_000 }, () => runScript("app-architecture-tests.mjs", { timeout: 15_000 }));
test("UI controllers and focus lifecycle", { timeout: 10_000 }, () => runScript("ui-controller-tests.mjs", { timeout: 5_000 }));
test("application startup and Journal Notes button", { timeout: 20_000 }, () => runScript("startup-tests.mjs", { timeout: 15_000 }));
