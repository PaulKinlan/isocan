import { defineConfig } from "vitest/config";
import os from "node:os";
import { DEEP, runningDeep } from "./test/deep.ts";

const numCpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
// Bounded worker pool (isocan-7r8):
// Tests in this repository spawn real subprocesses (Node + tsx transpilation).
// On high-core machines (e.g. 32 cores), Vitest's default `cpus - 1` (31 forks)
// causes massive CPU oversubscription when multiple worker forks run process-spawning
// test suites simultaneously. This thrashes CPU and drives load >30, stretching cold
// child process launches from 250ms to 2.5s and causing timeouts across the deep lane.
// Bounding maxForks ensures worker forks + their child process spawns stay within
// machine capacity. Can be overridden via VITEST_MAX_FORKS env variable.
const maxForks = process.env.VITEST_MAX_FORKS
  ? Number(process.env.VITEST_MAX_FORKS)
  : Math.min(8, Math.max(1, Math.floor(numCpus / 2)));

export default defineConfig({
  test: {
    poolOptions: {
      forks: {
        maxForks,
      },
    },
    include: ["packages/*/test/**/*.test.ts", "packages/modules/*/test/**/*.test.ts", "test/**/*.test.ts"],
    /**
     * **The deep lane, left out unless asked for.** The files in `test/deep.ts`
     * drive the real binary and are about half this suite's CPU; `npm test`
     * skips them and says so, `npm run test:deep` runs them, and CI sets
     * `ISOCAN_REQUIRE_DEEP` so the run that decides a release never skips.
     * The exclusion has to be empty when that switch is set — an anti-skip
     * switch that skipped would be worse than no switch.
     */
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...(runningDeep() ? [] : DEEP.map((d) => d.file)),
    ],
    // Runs in every worker, before every test file: see test/setup.ts for what
    // a run leaves behind without it.
    setupFiles: ["test/setup.ts"],
    /* The default reporter prints the duration; `timing-reporter.ts` is what
       remembers it. Every run, no flag — `scripts/timings.mjs` reads them back
       and says which kind of run is getting slower. */
    reporters: ["default", "./test/timing-reporter.ts"],
    /**
     * **60s global timeout (isocan-ril)**:
     * Replaces the former 30s limit and eliminates all scattered per-file
     * `vi.setConfig` overrides across the repository.
     *
     * Most integration tests in the deep lane spawn real processes: a daemon,
     * or `bin/isocan.js` itself, 15–35 times sequentially per test. Under
     * parallel execution on multi-core runners, cold process startup (with
     * on-the-fly tsx transpilation) takes 1.5s–2.5s per spawn. A 30s limit
     * allowed only 0.8s–1.5s per spawn, which caused recurring timeouts
     * under load (isocan-7r8, isocan-swf, isocan-ril). 60s grants 2.0s–3.5s
     * per spawn, accommodating realistic scheduling latency without flaking.
     *
     * This is strictly fail-closed: nothing here asserts on elapsed time;
     * assertions are about state, process output, and files on disk. A
     * genuinely wedged test still fails with its name at 60s, while passing
     * tests finish as fast as they can (test/flake-isolation.test.ts).
     */
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Runs ONCE, in the main process, before any worker exists — which is the
    // only place a Firestore emulator can be started and have every worker
    // inherit its address. See test/emulator.ts for the three tiers and for
    // what happens on a machine that has none.
    globalSetup: ["test/emulator.ts", "test/deepgate.ts"],
  },
});
