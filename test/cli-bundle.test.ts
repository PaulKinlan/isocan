import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCliBundle, CLI_BUNDLE, releaseManifest } from "../scripts/release.mjs";

/**
 * **The release CLI is a bundle, and these are the two things that has to be
 * true of it** (`docs/projects/first-minute/phases.md`, phase 1).
 *
 * The debt is #332: an agent in a hosted sandbox waits 2 to 4 seconds for
 * `isocan --version`, because `bin/isocan.js` registers tsx and then imports
 * 297 of our own `.ts` files through it, plus every module's guide off the
 * disk, before the version string is printed. A laptop hides that — 0.3 s
 * there — and no test that runs on a laptop can measure the sandbox's clock.
 * So the two guards here are counts, not seconds:
 *
 * 1. **the bundle starts without the sources.** Run from a tree that has the
 *    release manifest and `packages/cli/dist` and nothing else — no `.ts`
 *    anywhere, no tsx — the CLI still answers `--version`, `--help` and
 *    `--agent-help`, guides and all.
 * 2. **the budget.** `--version` loads fewer than 150 modules; it loaded 456
 *    when this project started, and phase 3 takes it under 40.
 *
 * Both need the bundle built, which is esbuild over the whole CLI closure and
 * the reason this file is in the deep lane.
 */

const repo = fileURLToPath(new URL("..", import.meta.url));
const bundle = path.join(repo, CLI_BUNDLE);

/** What one command loads, by URL, through a hook on the module loader. */
function modulesLoadedBy(entry: string, args: string[]): string[] {
  const log = path.join(mkdtempSync(path.join(os.tmpdir(), "isocan-modules-")), "log");
  const done = spawnSync(
    process.execPath,
    ["--import", path.join(repo, "test/lib/count-modules.mjs"), entry, ...args],
    { encoding: "utf8", env: { ...process.env, ISOCAN_MODULE_LOG: log } },
  );
  expect(done.status, done.stderr).toBe(0);
  const seen = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  rmSync(path.dirname(log), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return [...new Set(seen)];
}

describe("the release CLI is a bundle", () => {
  beforeAll(async () => {
    await buildCliBundle();
  }, 120_000);

  it("starts from a tree with no sources in it and no tsx to resolve", () => {
    // The shape an install has: the release manifest, the bundle, and the
    // dependencies npm would have resolved (a link, so the test is about the
    // bundle and not about the network). Nothing else — no `packages/*/src`,
    // no `bin/isocan.js`, no `.ts` file anywhere in the tree.
    const tree = mkdtempSync(path.join(os.tmpdir(), "isocan-installed-"));
    try {
      const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
      writeFileSync(
        path.join(tree, "package.json"),
        JSON.stringify(releaseManifest(pkg, "deadbee", "2026-09-18T00:00:00Z"), null, 2),
      );
      mkdirSync(path.join(tree, "packages/cli"), { recursive: true });
      cpSync(path.join(repo, "packages/cli/dist"), path.join(tree, "packages/cli/dist"), {
        recursive: true,
      });
      symlinkSync(path.join(repo, "node_modules"), path.join(tree, "node_modules"), "dir");

      const installed = path.join(tree, JSON.parse(readFileSync(path.join(tree, "package.json"), "utf8")).bin.isocan);
      expect(existsSync(installed), "the manifest's bin is not where it says").toBe(true);

      const run = (...args: string[]) => {
        const done = spawnSync(process.execPath, [installed, ...args], { encoding: "utf8" });
        expect(done.status, `isocan ${args.join(" ")}\n${done.stderr}`).toBe(0);
        return done.stdout;
      };

      // The build stamp is read from the manifest of the tree it is IN, which
      // is how `packageRoot()` is proved: a copy that found the repo's root
      // instead would print the repo's commit.
      expect(run("--version")).toContain("deadbee");
      expect(run("--help")).toContain("Isomorphic canvas");

      // The guides are inlined, so `--agent-help` is whole without a single
      // `.md` file being in the tree — the base guide and every module's.
      const guide = run("--agent-help");
      expect(guide.length).toBeGreaterThan(100_000);
      expect(guide).toContain("isocan wait");
      expect(guide).toContain("mindmap");

      // A module verb is registered and answers, which is the other half of
      // "the modules survived the bundling": `map` is the mind map's, `sticker`
      // the stickers'.
      expect(run("map", "--help")).toContain("Mind maps");
      expect(run("sticker", "--help")).toContain("stickers");
    } finally {
      rmSync(tree, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);

  it("loads under 150 modules to print a version, and none of them through tsx", () => {
    const loaded = modulesLoadedBy(bundle, ["--version"]);
    const ours = loaded.filter((url) => url.endsWith(".ts"));
    const tsx = loaded.filter((url) => url.includes("/tsx/"));

    expect(tsx, "the bundle must not need a transpiler").toEqual([]);
    expect(ours, "the bundle must not reach back to the sources").toEqual([]);
    // 456 when this project started, 437 measured here the same day. Phase 3
    // takes this under 40 by moving the server, the MCP layer and the design
    // stack behind `import()`; until then the ceiling stops it climbing.
    expect(loaded.length, `${loaded.length} modules for --version`).toBeLessThan(150);
  }, 120_000);
});
