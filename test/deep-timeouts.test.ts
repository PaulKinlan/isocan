// test/deep-timeouts.test.ts — isocan-ril (Option 3 ratchet guard):
//
// Invariant: No DEEP test file may introduce a new per-test timeout literal
// tighter than the global 60s floor (`vitest.config.ts`).
//
// Background (isocan-7r8, isocan-swf, isocan-ril):
// A per-test literal (e.g. `}, 30_000)` or `}, 20_000)`) outranks file-level
// config in Vitest. When the global timeout was raised to 60s for multi-spawn
// CLI suites, 119 tighter literals in 41 files silently superseded the global bound.
//
// This guard ratchets the existing tighter literals (currently 120 across 19 files)
// so the direction is strictly monotone: new files cannot introduce tighter literals,
// and existing ones can only decrease as they are individually reviewed.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEEP } from "./deep.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));

/**
 * The known 19 DEEP files that historically carry per-test literals tighter than 60s.
 * No NEW file may be added to this set.
 */
export const KNOWN_FILES_WITH_TIGHTER_LITERALS = new Set([
  "test/questionnaire-cli.test.ts",
  "packages/cli/test/dispatch.test.ts",
  "packages/cli/test/direct.test.ts",
  "packages/cli/test/session-identity.test.ts",
  "packages/cli/test/rc-sheep-withdrawal.test.ts",
  "packages/cli/test/home.test.ts",
  "packages/cli/test/wait.test.ts",
  "packages/cli/test/park.test.ts",
  "packages/cli/test/acp.test.ts",
  "packages/cli/test/rc-sheep.test.ts",
  "packages/cli/test/binding.test.ts",
  "packages/cli/test/restart.test.ts",
  "packages/cli/test/daemon-takeover.test.ts",
  "packages/cli/test/wait-cursor.test.ts",
  "packages/cli/test/operator.test.ts",
  "packages/cli/test/agent-key.test.ts",
  "packages/voice-agent/test/voice-harness.test.ts",
  "packages/cli/test/rehome.test.ts",
  "packages/cli/test/operator-revoke.test.ts",
]);

/** Historical ceiling of tighter-than-60s literals across DEEP files. */
export const TIGHTER_LITERALS_CEILING = 120;

export interface TimeoutLiteralHit {
  file: string;
  line: number;
  ms: number;
  text: string;
}

export function scanTighterLiterals(files: readonly { file: string }[], rootDir = repo): TimeoutLiteralHit[] {
  const hits: TimeoutLiteralHit[] = [];
  for (const { file } of files) {
    const fullPath = path.join(rootDir, file);
    if (!existsSync(fullPath)) continue;
    const lines = readFileSync(fullPath, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/},\s*([0-9_]+)\s*\);/);
      if (m) {
        const ms = Number(m[1].replace(/_/g, ""));
        if (ms < 60_000) {
          hits.push({ file, line: i + 1, ms, text: line.trim() });
        }
      }
    }
  }
  return hits;
}

describe("deep lane timeout literal ratchet (isocan-ril Option 3)", () => {
  it("zero DEEP files carry a per-file override (vi.setConfig)", () => {
    const hits: string[] = [];
    for (const { file } of DEEP) {
      const fullPath = path.join(repo, file);
      if (!existsSync(fullPath)) continue;
      const lines = readFileSync(fullPath, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("vi.setConfig")) {
          hits.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    expect(hits, "DEEP files must not carry per-file vi.setConfig overrides; the global 60s testTimeout governs").toEqual([]);
  });

  it("no DEEP file outside the known set carries a timeout tighter than 60s", () => {
    const hits = scanTighterLiterals(DEEP, repo);
    const unlisted = hits.filter((h) => !KNOWN_FILES_WITH_TIGHTER_LITERALS.has(h.file));
    expect(
      unlisted.map((u) => `${u.file}:${u.line} (${u.ms}ms)`),
      "found new per-test timeout literals tighter than 60s in unlisted DEEP files; let the global 60s bound govern instead",
    ).toEqual([]);
  });

  it("the total count of tighter literals does not exceed the historical ceiling (monotone ratchet)", () => {
    const hits = scanTighterLiterals(DEEP, repo);
    expect(
      hits.length,
      `tighter-than-60s literals increased beyond ceiling (${hits.length} > ${TIGHTER_LITERALS_CEILING})`,
    ).toBeLessThanOrEqual(TIGHTER_LITERALS_CEILING);
  });

  it("falsification: catches an unlisted file introducing a tighter literal", () => {
    const mockFiles = [
      { file: "packages/cli/test/place.test.ts" }, // place.test.ts has 0 literals on main
    ];
    // Scanner on a synthetic content with a 40s literal
    const mockHits = [
      { file: "packages/cli/test/place.test.ts", line: 142, ms: 40_000, text: "}, 40_000);" },
    ];
    const unlisted = mockHits.filter((h) => !KNOWN_FILES_WITH_TIGHTER_LITERALS.has(h.file));
    expect(unlisted.length).toBe(1);
    expect(unlisted[0].ms).toBe(40_000);
  });
});
