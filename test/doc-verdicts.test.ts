import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(repo, "scripts", "doc-verdicts.mjs");

/**
 * **A doc's prose must not contradict its front matter** — `isocan-wy2`, part B.
 *
 * Front matter is the single status authority and `core/docStatus` is its one
 * reader, but `docStatus` cannot see the hand-kept `**Where we are:**` line that
 * 28 project docs carry beside it. So a doc can say `status: designed` — core's
 * own words, "written, argued, nothing built" — while its prose says phase 1 is
 * in progress, and `docs/ROADMAP.md` prints the front matter and nothing objects.
 *
 * That happened: `docs/projects/voice-interface/phases.md` said "**Where we are:
 * PHASE 1 IN PROGRESS (2026-09-11)**" for a week while `packages/voice-agent`
 * shipped fifteen test files underneath it. Three verdicts in one project, none
 * of them the truth. `docs/research/2026-08-26-attaching-a-directory.md` carries
 * the older scar of the same thing.
 *
 * Two tests, because one is not enough. The first is the guard: the real tree is
 * clean today, so a bound of 0 costs nobody anything and reddens the commit that
 * introduces the next one. The second proves the guard CAN fail — a check only
 * ever seen to pass is decoration, and this one is meant to stop a commit.
 */
describe("a project doc's own prose does not contradict its front matter", () => {
  it("is true of every doc in the tree today", () => {
    // `--names` rather than the count, so a failure prints the doc and both
    // verdicts instead of a number somebody has to go and look up.
    const out = execFileSync(process.execPath, [script, "--names"], { cwd: repo, encoding: "utf8", timeout: 120_000 });
    expect(out.trim(), out).toBe("no project doc contradicts its own front matter");
  });

  const tmp = mkdtempSync(path.join(os.tmpdir(), "isocan-doc-verdicts-"));
  // `maxRetries` is not optional here: `test/teardown.test.ts` scans the suite for
  // a recursive rm without it, because a scratch directory removed while a
  // spawned child is still writing loses the race and takes the next test with it.
  afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  /** One fixture project: an authority doc carrying the status, and a phases doc carrying the prose. */
  const project = (name: string, status: string, prose: string) => {
    const dir = path.join(tmp, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "journey.md"), `---\nstatus: ${status}\nsince: 2026-09-11\n---\n# ${name}\n`);
    writeFileSync(path.join(dir, "phases.md"), `# ${name} — the walk\n\n**${prose}**\n\nSome steps.\n`);
  };

  it("catches both directions, and does not cry wolf on the three shapes that agree", () => {
    // The exact case that shipped: front matter says nothing is built, prose says phase 1 is.
    project("inprogress", "designed", "Where we are: PHASE 1 IN PROGRESS (2026-09-11).");
    // The other direction: front matter says built, prose says nothing is.
    project("overclaimed", "built", "Where we are: nothing built yet.");
    // `browser-surface`'s real line — design language, and correctly not a hit.
    project("registered", "designed", "Where we are: ROADMAP REGISTERED. The design is specified and the phases are defined below.");
    // `partial` means "some of it is built, the doc says which part", so any mix agrees with it.
    project("partway", "partial", "Where we are: phases 0–6 CLOSED; phase 7 PART-DONE.");
    // A built doc agreeing with itself.
    project("done", "built", "Where we are: ALL FOUR PHASES CLOSED (27–29 Aug 2026).");

    const count = execFileSync(process.execPath, [script, "--root", tmp], { cwd: repo, encoding: "utf8", timeout: 120_000 });
    // One integer and nothing else — `scripts/measure.mjs`'s contract, since a
    // persona goal compares the output to a bound without parsing it.
    expect(count.trim()).toBe("2");

    const names = execFileSync(process.execPath, [script, "--root", tmp, "--names"], { cwd: repo, encoding: "utf8", timeout: 120_000 });
    expect(names).toContain("inprogress/phases.md");
    expect(names).toContain("overclaimed/phases.md");
    expect(names).not.toContain("registered/phases.md");
    expect(names).not.toContain("partway/phases.md");
    expect(names).not.toContain("done/phases.md");
    // The failure message has to say which verdict is which, or the person it
    // stops has to go and read two files to find out what to fix.
    expect(names).toContain('front matter says "designed"');
    expect(names).toContain("journey.md");
  });
});
