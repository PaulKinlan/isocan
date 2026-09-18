// test/deep-timeouts.test.ts — isocan-ril (Option 3 ratchet guard):
//
// Invariant: No DEEP test file may introduce a new per-test timeout literal
// tighter than the global 60s floor (`vitest.config.ts`).
//
// Population & Scope:
// This ratchet polices the 46 files declared in `DEEP` (test/deep.ts).
//
// KNOWN GAP (FAST_SPAWNERS):
// The 24 CLI-spawning test files in `FAST_SPAWNERS` (test/deep.ts) run in the
// fast lane (`npm test`) rather than the deep lane (`npm run test:deep`).
// They currently carry 5 tighter literals across 2 files:
//   - packages/cli/test/rehome.test.ts (4)
//   - packages/cli/test/operator-revoke.test.ts (1)
// Note that `packages/cli/test/grid.test.ts` (the file whose timeout failure
// prompted isocan-ril) belongs to FAST_SPAWNERS and currently has 0 literals
// (relying on the 60s floor). FAST_SPAWNERS are NOT scanned by this DEEP-only
// ratchet; expanding ratchet coverage to FAST_SPAWNERS is tracked as a follow-up.
//
// Background (isocan-7r8, isocan-swf, isocan-ril):
// A per-test literal (e.g. `}, 30_000)` or `}, 20_000)`) outranks file-level
// config in Vitest. When the global timeout was raised to 60s for multi-spawn
// CLI suites, tighter literals silently superseded the global bound.
//
// This guard ratchets the existing tighter literals across DEEP files
// so the direction is strictly monotone: new files cannot introduce tighter literals,
// and existing ones can only decrease as they are individually reviewed.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEEP } from "./deep.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));

/**
 * The known 16 DEEP files that historically carry per-test literals tighter than 60s.
 * No NEW file may be added to this set.
 *
 * Reconciled from 18 to 16 files:
 * `packages/cli/test/operator-revoke.test.ts` (1 literal) and
 * `packages/cli/test/rehome.test.ts` (4 literals) belong to `FAST_SPAWNERS`,
 * not `DEEP`. They were originally listed here when census summed both lists;
 * they are now removed from this DEEP-only allowlist and documented above under
 * the FAST_SPAWNERS known gap.
 */
export const KNOWN_FILES_WITH_TIGHTER_LITERALS = new Set([
  "packages/cli/test/acp.test.ts",
  "packages/cli/test/agent-key.test.ts",
  "packages/cli/test/binding.test.ts",
  "packages/cli/test/daemon-takeover.test.ts",
  "packages/cli/test/direct.test.ts",
  "packages/cli/test/dispatch.test.ts",
  "packages/cli/test/home.test.ts",
  "packages/cli/test/operator.test.ts",
  "packages/cli/test/park.test.ts",
  "packages/cli/test/rc-sheep-withdrawal.test.ts",
  "packages/cli/test/rc-sheep.test.ts",
  "packages/cli/test/restart.test.ts",
  "packages/cli/test/session-identity.test.ts",
  "packages/cli/test/wait-cursor.test.ts",
  "packages/cli/test/wait.test.ts",
  "packages/voice-agent/test/voice-harness.test.ts",
]);

/**
 * Historical ceiling of tighter-than-60s literals across the 46 DEEP files.
 * Reconciled exactly against qwen2's census instrument (deep-timeout-census.mjs):
 * 114 total across 16 DEEP files.
 * (Note: 114 in DEEP + 5 in FAST_SPAWNERS = 119 total across both lists).
 */
export const TIGHTER_LITERALS_CEILING = 114;

export interface TimeoutLiteralHit {
  file: string;
  line: number;
  ms: number;
  text: string;
}

/** Matches `}, 30_000);` anchored to end of test body per qwen2's census definition */
const LITERAL = /^\s*\}, ([0-9][0-9_]{3,})\);\s*$/;

export function scanTighterLiterals(files: readonly { file: string }[], rootDir = repo): TimeoutLiteralHit[] {
  const hits: TimeoutLiteralHit[] = [];
  for (const { file } of files) {
    const fullPath = path.join(rootDir, file);
    if (!existsSync(fullPath)) continue;
    const lines = readFileSync(fullPath, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(LITERAL);
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
    const tempDir = mkdtempSync(path.join(tmpdir(), "isocan-ril-falsify-"));
    try {
      const relPath = "packages/cli/test/unlisted-sample.test.ts";
      const fullPath = path.join(tempDir, relPath);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(
        fullPath,
        `import { it } from "vitest";\nit("sample case", async () => {\n  // do work\n}, 40_000);\n`,
        "utf8",
      );

      const hits = scanTighterLiterals([{ file: relPath }], tempDir);
      expect(hits.length, "scanner must detect the 40s literal in the file").toBe(1);
      expect(hits[0].ms).toBe(40_000);

      const unlisted = hits.filter((h) => !KNOWN_FILES_WITH_TIGHTER_LITERALS.has(h.file));
      expect(unlisted.length, "unlisted file must be flagged as a violation").toBe(1);
      expect(unlisted[0].file).toBe(relPath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
