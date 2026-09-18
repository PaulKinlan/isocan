// test/flake-isolation.test.ts — isocan-7r8:
// Verification and falsification for CLI load-flake isolation and work bounds.
//
// Problem: On high-core machines (32 cores), Vitest's default `cpus - 1` (31 forks)
// runs dozens of process-spawning test suites in parallel. Each worker fork spawns
// child `node bin/isocan.js` processes that invoke `tsx` transpilation on the fly.
// Saturated with 60+ competing processes, cold child process launches balloon from
// 250ms to 2.5s, causing tests with sequential spawns to hit 30s timeouts.
//
// Solution:
// 1. Cap `poolOptions.forks.maxForks` in `vitest.config.ts` to prevent self-induced thrashing.
// 2. Calibrate timeouts in high-spawn test files (`place.test.ts`, `rc.test.ts`) to 60s
//    reflecting real sequential work (24-35 spawns) rather than wall-clock starvation.
// 3. Falsification: prove that a genuinely wedged/hung test still fails with `Test timed out`.

import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import os from "node:os";

/**
 * Compute the number of synthetic CPU burners to spawn based on ambient load.
 * Target saturation is ~12-16 active threads (half of CPU capacity on 32-core box).
 * If ambient load is already >= targetPressure, returns workerCount = 0 to avoid
 * compounding already-high load (e.g. multi-agent fleet running at load 30-76).
 */
export function computeBurnerCount(ambientLoad: number, cpus = os.cpus().length): { workerCount: number; targetPressure: number } {
  const targetPressure = Math.min(16, Math.max(4, Math.floor(cpus / 2)));
  const workerCount = ambientLoad >= targetPressure
    ? 0 // Ambient machine load already provides the required saturation
    : Math.min(8, Math.max(2, Math.round(targetPressure - ambientLoad)));
  return { workerCount, targetPressure };
}

describe("isocan-7r8: CLI flake isolation under controlled saturation", () => {
  it("burner count computation correctly branches on ambient load", () => {
    // Branch A: Machine already saturated (ambientLoad >= targetPressure) -> workerCount = 0
    expect(computeBurnerCount(76.5, 32).workerCount).toBe(0);
    expect(computeBurnerCount(33.0, 32).workerCount).toBe(0);
    expect(computeBurnerCount(16.0, 32).workerCount).toBe(0);

    // Branch B: Machine quiet -> scales synthetic burners up to cap (8)
    expect(computeBurnerCount(2.0, 32).workerCount).toBe(8);
    expect(computeBurnerCount(10.0, 32).workerCount).toBe(6);
    expect(computeBurnerCount(14.0, 32).workerCount).toBe(2);
  });

  it("direction 1: place.test.ts passes cleanly under controlled CPU saturation", async () => {
    // Controlled saturation: target saturation is ~12-16 active threads.
    // If the machine already has high ambient load (e.g. multi-agent fleet running,
    // loadavg > 16), spawning 24 unconditional burners causes severe compounding
    // oversubscription (load > 75). Instead, dynamically scale synthetic burners
    // based on ambient load so total pressure is controlled and bounded.
    const ambientLoad = os.loadavg()[0];
    const { workerCount, targetPressure } = computeBurnerCount(ambientLoad);

    const workers: Worker[] = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(new Worker("while(true);", { eval: true }));
    }

    try {
      // Timeout trade: 120s child process timeout (and 150s test timeout) provides
      // adequate headroom for nested Vitest initialization, on-the-fly TSX
      // compilation, and the 60s test liveness bound under heavy saturation,
      // without prematurely cutting off via execFileSync's wrapper.
      const result = execFileSync(
        process.execPath,
        ["./node_modules/vitest/vitest.mjs", "run", "packages/cli/test/place.test.ts"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        },
      );
      expect(result).toContain("1 passed");
      expect(result).not.toContain("timed out");
    } finally {
      for (const w of workers) {
        w.terminate();
      }
    }
  }, 150_000);

  it("direction 2 (falsification): a genuinely hung test still fails loudly with Test timed out", async () => {
    // Write a temporary test file in test/ that deliberately exceeds its timeout
    const testDir = path.join(process.cwd(), "test");
    const tempFile = path.join(testDir, `scratch-timeout-probe-${Date.now()}.test.ts`);
    const testCode = `
import { it } from "vitest";
it("deliberately hung test", async () => {
  await new Promise((r) => setTimeout(r, 5000));
}, 500);
`;
    await fs.writeFile(tempFile, testCode, "utf8");

    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          ["./node_modules/vitest/vitest.mjs", "run", tempFile],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });

      // Must exit non-zero and report timed out
      expect(result.code).not.toBe(0);
      const combined = result.stdout + result.stderr;
      expect(combined).toMatch(/Test timed out in 500ms|timed out/i);
      expect(combined).toContain("deliberately hung test");
    } finally {
      await fs.rm(tempFile, { force: true }).catch(() => {});
    }
  }, 30_000);
});
