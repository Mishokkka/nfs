import { runScript } from "./test-harness.mjs";

const jobs = [
  ["representative procedural track fuzz", "track-fuzz-tests.mjs", 11 * 60_000, {
    NFS_TRACK_FUZZ_SEEDS: "120",
    NFS_WALL_FUZZ_SEEDS: "30",
    NFS_PIT_FUZZ_SEEDS: "50"
  }],
  ["representative multi-car physics and elite bot balance", "race-soak-tests.mjs", 11 * 60_000, {
    NFS_RACE_SOAK_PROFILES: "1",
    NFS_ELITE_BOT_SEEDS: "1"
  }]
];

for (const [label, file, timeout, env] of jobs) {
  const started = performance.now();
  const { stdout, stderr } = await runScript(file, { timeout, env });
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
  const elapsed = ((performance.now() - started) / 1000).toFixed(2);
  console.log(`soak: ${label} passed in ${elapsed}s`);
}
