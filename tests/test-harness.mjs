import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function positiveInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function entry(cloneDefaultBuild, id, { bot = false, skill = 2, seed = id } = {}) {
  return {
    id,
    userId: bot ? null : `user-${id}`,
    name: id,
    build: cloneDefaultBuild(),
    color: "#ffffff",
    isBot: bot,
    botSkill: skill,
    botSeed: seed
  };
}

export function skipCountdown(simulation) {
  simulation.countdown = 0;
  simulation.started = true;
}

export function runScript(file, { timeout = 30_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "tests", file)], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try {
        assert.equal(timedOut, false, `${file} exceeded ${timeout} ms\n${stdout}\n${stderr}`);
        assert.equal(code, 0, `${file} failed with ${signal ?? `exit ${code}`}\n${stdout}\n${stderr}`);
        resolve({ stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}
