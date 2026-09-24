import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **The nightly PR queues, driven rather than read.**
 *
 * AGENTS.md promises per-workflow behaviour for the machine PRs: a changelog
 * waits for a writer and is landed as a draft after three days; a grades PR
 * merges itself and drains its predecessors oldest first; a close happens only
 * when something replaced the PR; and a merge step runs the suite first,
 * because nothing else checks a `GITHUB_TOKEN` PR. Until 18 Sep 2026 two of
 * those were prose only — `git log -S` over every ref finds no changelog
 * machinery ever, only the two hand-drains of 7 and 8 September — and nothing
 * could tell, which is the failure this file exists to make impossible to
 * repeat.
 *
 * So these cases drive `scripts/nightly-prs.mjs` against a real git repository
 * with a real remote and a `gh` that records every call it is asked to make.
 * The assertions are on **what was done** — the merge that was issued, the row
 * that landed on the branch, the close that named a replacement — and not on
 * the prose in the script, because a script that only says the right thing is
 * the bug this replaced.
 *
 * The dates are ancient on purpose: a fixture that would rot in three days is
 * a fixture that goes red for the wrong reason. A PR is four days old unless a
 * case says otherwise.
 */

const repo = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(repo, "scripts", "nightly-prs.mjs");
const DAY = "2026-09-16";
const NEXT_DAY = "2026-09-17";

const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).trim();

/**
 * The `gh` the machinery talks to: it answers the questions the drain asks and
 * writes down every command it was given, so a case can assert what was done.
 * `FAKE_MERGE_BEFORE` is how a case plays the person who merges the same day
 * while the drain is running — the merge fails, and the day lands anyway.
 */
const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1/$2" in
  pr/list) cat "$FAKE_PRS" ;;
  pr/diff) cat "$FAKE_DIFF" ;;
  pr/view) printf '%s' "\${FAKE_VIEW:-}" ;;
  pr/merge)
    if [ -n "\${FAKE_MERGE_BEFORE:-}" ]; then sh -c "$FAKE_MERGE_BEFORE"; fi
    exit "\${FAKE_MERGE:-0}" ;;
esac
exit 0
`;

type Kind = "changelog" | "grades";


/**
 * The fixture's suite, in the shape the gate expects: vitest's JSON report at
 * `$NIGHTLY_PR_REPORT`, failing when the tree it runs in carries a marker. That
 * is what lets a case be red on the branch, red on `main`, or both — the point
 * of the comparison, and not something a fixed exit code could express.
 */
const SUITE = `#!/bin/sh
if [ -n "\${FAKE_EMPTY_FAIL:-}" ]; then
    printf '{"testResults":[]}' > "$NIGHTLY_PR_REPORT"
    exit 1
  fi
  if [ -n "\${FAKE_LOAD_FAILURE:-}" ]; then
    printf '{"success":false,"numFailedTests":0,"testResults":[{"name":"%s/test/load.test.ts","status":"failed","message":"Transform failed with 1 error: /x.ts:1:1: Expected identifier","assertionResults":[]}]}' "$PWD" > "$NIGHTLY_PR_REPORT"
    exit 1
  fi
  if [ -f .nightly-fails ]; then
  COUNT="\${FAKE_FAILURES:-1}"
  printf '{"testResults":[{"name":"%s/test/x.test.ts","assertionResults":[' "$PWD" > "$NIGHTLY_PR_REPORT"
  i=1
  while [ "$i" -le "$COUNT" ]; do
    [ "$i" -gt 1 ] && printf ',' >> "$NIGHTLY_PR_REPORT"
    printf '{"fullName":"a finding nobody answered %s","status":"failed"}' "$i" >> "$NIGHTLY_PR_REPORT"
    i=$((i + 1))
  done
  printf ']}]}' >> "$NIGHTLY_PR_REPORT"
  exit 1
fi
printf '{"testResults":[]}' > "$NIGHTLY_PR_REPORT"
exit 0
`;

interface Fixture {
  run(options?: {
    ageHours?: number;
    gate?: string;
    files?: string;
    mergeFails?: boolean;
    mergeBefore?: string;
    numbers?: number[];
    dryRun?: boolean;
    suite?: string;
    view?: string;
    loadFailure?: boolean;
    emptyFail?: boolean;
    failures?: number;
  }): { calls: string[]; log: string; said: string };
  gate(branch?: string): string;
  indexOnBranch(branch?: string): string;
  tipMoved(branch?: string): boolean;
}

const roots: string[] = [];

afterEach(() => {
  // The retry is the suite's rule for a scratch directory (test/teardown.test.ts):
  // something else may still be writing into it when the assertion has passed.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A repository whose `origin` is a bare repo beside it, open PRs on branches
 *  of one kind, and a `gh` on PATH that answers for them. */
function fixture(options: {
  kind?: Kind;
  variant: "draft" | "written" | "plain";
  pageOnMain?: boolean;
  install?: "cheap" | "real" | "missing";
  failsOn?: "none" | "branch" | "both";
  days?: string[];
}): Fixture {
  const kind: Kind = options.kind ?? "changelog";
  const install = options.install ?? "cheap";
  const dir = `docs/${kind}`;
  const days = options.days ?? [DAY];
  const root = mkdtempSync(path.join(os.tmpdir(), "isocan-nightly-prs-"));
  roots.push(root);
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const bin = path.join(root, "bin");
  const logPath = path.join(root, "gh.log");
  mkdirSync(bin, { recursive: true });

  writeFileSync(path.join(bin, "gh"), FAKE_GH);
  chmodSync(path.join(bin, "gh"), 0o755);
  writeFileSync(path.join(bin, "suite"), SUITE);
  chmodSync(path.join(bin, "suite"), 0o755);

  git(["init", "-q", "--bare", origin], root);
  git(["clone", "-q", origin, work], root);
  const who = ["-c", "user.name=isocan nightly", "-c", "user.email=noreply@github.com"];
  const commit = (message: string) => git([...who, "commit", "-qm", message], work);

  mkdirSync(path.join(work, dir), { recursive: true });
  writeFileSync(
    path.join(work, `${dir}/README.md`),
    kind === "changelog"
      ? "# Changelog\n\n| Day | | What happened |\n| --- | --- | --- |\n| **[15 Sep](2026-09-15.md)** | Something | An entry. |\n"
      : "# Grades\n\n| Day | |\n| --- | --- |\n",
  );
  if (options.pageOnMain) writeFileSync(path.join(work, `${dir}/${DAY}.md`), landedPage(kind));
  // A suite failure that `main` already has, for the case that proves the gate
  // does not blame a branch for the base's own red.
  if (options.failsOn === "both") writeFileSync(path.join(work, ".nightly-fails"), "a finding nobody answered\n");
  if ((options.install ?? "cheap") === "real") {
    // A real (tiny) manifest, so a case can drive the actual `npm ci` the gate
    // runs without paying for the repository's own 758 packages.
    writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "isocan-nightly-fixture", version: "0.0.0", private: true }));
    writeFileSync(
      path.join(work, "package-lock.json"),
      JSON.stringify({
        name: "isocan-nightly-fixture",
        version: "0.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "isocan-nightly-fixture", version: "0.0.0" } },
      }),
    );
  }
  git(["add", "-A"], work);
  commit("main");
  git(["branch", "-M", "main"], work);
  git(["push", "-q", "-u", "origin", "main"], work);

  const tipped: Record<string, string> = {};
  for (const day of days) {
    const branch = `${kind}/${day}`;
    git(["checkout", "-q", "-b", branch, "main"], work);
    writeFileSync(path.join(work, `${dir}/${day}.md`), pageFor(kind, day, options.variant));
    if (options.failsOn === "branch" || options.failsOn === "both") {
      writeFileSync(path.join(work, ".nightly-fails"), "a finding nobody answered\n");
    }
    git(["add", "-A"], work);
    commit(`${kind === "changelog" ? "Changelog" : "Grades"}: ${day}`);
    git(["push", "-q", "-u", "origin", branch], work);
    tipped[branch] = git(["--git-dir", origin, "rev-parse", branch], root);
  }

  return {
    run(run = {}) {
      writeFileSync(logPath, "");
      const diff = path.join(root, "diff.txt");
      const prs = path.join(root, "prs.json");
      const numbers = run.numbers ?? [42];
      writeFileSync(diff, `${run.files ?? `${dir}/${numbers.map(() => DAY).slice(0, 1)[0]}.md`}\n`);
      writeFileSync(
        prs,
        JSON.stringify(
          numbers.map((number, index) => ({
            number,
            headRefName: `${kind}/${days[index] ?? DAY}`,
            createdAt: new Date(Date.now() - (run.ageHours ?? 96) * 3_600_000).toISOString(),
          })),
        ),
      );
      const said = execFileSync("node", [script, "--drain", kind, ...(run.dryRun ? ["--dry-run"] : [])], {
        cwd: work,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          FAKE_LOG: logPath,
          FAKE_PRS: prs,
          FAKE_DIFF: diff,
          FAKE_VIEW: run.view ?? "",
          FAKE_LOAD_FAILURE: run.loadFailure ? "1" : "",
          FAKE_EMPTY_FAIL: run.emptyFail ? "1" : "",
          FAKE_MERGE: run.mergeFails ? "1" : "0",
          FAKE_MERGE_BEFORE: run.mergeBefore ?? "",
          FAKE_FAILURES: String(run.failures ?? 1),
          // The gate's three commands, two of them stubbed: the fixture's tree
          // is not a TypeScript workspace, and its "suite" is the marker script.
          NIGHTLY_PR_TYPECHECK: "true",
          NIGHTLY_PR_SUITE: run.suite ?? path.join(bin, "suite"),
          // The real install command is exercised by its own case; every other
          // one would pay npm's startup for a fact none of them asserts.
          ...(install === "cheap" ? { NIGHTLY_PR_INSTALL: "true" } : {}),
        },
      });
      // `calls` is line-per-command; `log` keeps the raw text, because a
      // comment body is multi-line and asserting on one line of it would
      // quietly assert only its first sentence.
      const log = readFileSync(logPath, "utf8");
      return { calls: log.split("\n").filter(Boolean), log, said };
    },
    /** The bare check, as `persona.yml` calls it. */
    gate(branch = `${kind}/${DAY}`) {
      const options = {
        cwd: work,
        encoding: "utf8" as const,
        stdio: ["ignore", "pipe", "pipe"] as const,
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          NIGHTLY_PR_INSTALL: "true",
          NIGHTLY_PR_TYPECHECK: "true",
          NIGHTLY_PR_SUITE: path.join(bin, "suite"),
        },
      };
      try {
        // The deadline is in `options` (as it is for every other child here), but
        // this call passes it BY NAME — and `test/syncexec.test.ts` reads source
        // for a literal `timeout:`, so a deadline behind a variable is invisible to
        // it and reads as "blocks the worker with no deadline of its own". Stating
        // it here keeps that guard honest without changing the behaviour: same
        // 60s budget, now legible to the check that exists to enforce it.
        return execFileSync("node", [script, "--gate", branch], { ...options, timeout: 60_000 });
      } catch (err) {
        // A red verdict is an exit code, not an exception: read what it said.
        return String((err as { stdout?: string }).stdout ?? "");
      }
    },
    indexOnBranch: (branch = `${kind}/${DAY}`) => git(["--git-dir", origin, "show", `${branch}:${dir}/README.md`], root),
    tipMoved: (branch = `${kind}/${DAY}`) => git(["--git-dir", origin, "rev-parse", branch], root) !== tipped[branch],
  };
}

/** The page a branch carries, by variant, for either kind. */
function pageFor(kind: Kind, day: string, variant: "draft" | "written" | "plain"): string {
  if (kind === "grades") {
    return `# Grades — ${day}\n\nA run of the graders.\n\n| Page | Checks passing | Failing |\n| --- | --- | --- |\n| docs/index.html | 8/8 | — |\n`;
  }
  if (variant === "draft") {
    return `<!-- draft -->\n\n# ${day}\n\n> Draft. Delete this line and the \`<!-- draft -->\` marker when it is written.\n\n## What landed\n\n### Something\n`;
  }
  if (variant === "written") return "# 16 September 2026 — A headline the writer wrote\n\nThe entry, written but not merged.\n";
  return "Something with no heading at all.\n";
}

/** The page `main` already carries when a case says a day has landed. */
function landedPage(kind: Kind): string {
  return kind === "changelog"
    ? "# 16 September 2026 — A page a person wrote\n\nThe entry.\n"
    : `# Grades — ${DAY}\n\nA page already on main.\n`;
}

const did = (calls: string[], said: string) => calls.some((call) => call.startsWith(said));

describe("a changelog draft past the writer's window", () => {
  it("is landed as a draft, and the index row says so", () => {
    const fx = fixture({ variant: "draft" });
    const { calls } = fx.run();

    expect(did(calls, "pr merge --squash"), "the draft was not merged").toBe(true);
    expect(fx.indexOnBranch()).toContain(`| **[16 Sep](${DAY}.md)** | Draft |`);
    expect(fx.indexOnBranch(), "the row must say why a draft is on main").toContain("unwritten after three days");
  });

  it("is committed on its own branch before it is merged, so main never moved itself", () => {
    const fx = fixture({ variant: "draft" });
    fx.run();

    expect(fx.tipMoved(), "the index row was not committed to the branch").toBe(true);
    expect(fx.indexOnBranch()).toContain(`(${DAY}.md)`);
  });

  it("quotes the writer's own headline when the entry was written but not merged", () => {
    const fx = fixture({ variant: "written" });
    const { calls } = fx.run();

    expect(did(calls, "pr merge"), "a written entry waiting past the window should land").toBe(true);
    expect(fx.indexOnBranch()).toContain("| A headline the writer wrote |");
  });

  it("refuses to index a day whose entry has no headline to quote", () => {
    const fx = fixture({ variant: "plain" });
    const { calls } = fx.run();

    expect(did(calls, "pr merge"), "an unindexable page must not land").toBe(false);
    expect(did(calls, "pr comment 42")).toBe(true);
  });
});

describe("a changelog draft inside the writer's window", () => {
  it("is left alone — the PR is the drafting surface until three days are up", () => {
    const fx = fixture({ variant: "draft" });
    const { calls, said } = fx.run({ ageHours: 24 });

    expect(said).toContain("inside the writer's window");
    expect(did(calls, "pr merge"), "machinery must not merge before the window closes").toBe(false);
    expect(did(calls, "pr close"), "and it must not close a live draft").toBe(false);
  });
});

describe("a day whose page is already on main", () => {
  it("is superseded and closed, and the comment names the replacement", () => {
    const fx = fixture({ variant: "draft", pageOnMain: true });
    const { calls, log } = fx.run();

    expect(did(calls, "pr close 42"), "the PR was not closed").toBe(true);
    const closure = log.slice(log.indexOf("pr close 42"));
    expect(closure, "a supersede-close must link what replaced it").toMatch(/`main` already carries/);
    expect(closure, "the branch has to be recoverable").toContain("git fetch origin");
    expect(did(calls, "pr merge"), "nothing is merged when the page is already there").toBe(false);
  });

  it("is superseded after a failed merge when the day landed while the drain ran", () => {
    const fx = fixture({ variant: "draft" });
    const { calls } = fx.run({
      mergeFails: true,
      mergeBefore: "git checkout -q main && printf '%s' '# 16 September 2026 — landed while the drain ran' > docs/changelog/2026-09-16.md && git add -A && git commit -qm 'a person wrote the day' && git push -q origin main && git checkout -q -",
    });

    expect(did(calls, "pr close 42"), "the day landed, so the PR is superseded").toBe(true);
  });
});

describe("nothing is landed on a check that did not run or did not pass", () => {
  it("leaves a red gate's PR open, and says so", () => {
    const fx = fixture({ variant: "draft", failsOn: "branch" });
    const { calls, said } = fx.run();

    expect(said).toContain("not merged");
    expect(did(calls, "pr merge")).toBe(false);
    expect(did(calls, "pr comment 42"), "a person has to be told why it is still open").toBe(true);
    expect(calls.find((call) => call.startsWith("pr comment 42"))).toContain("gate is red");
  });

  it("does not blame the branch for a red that main already has", () => {
    // `test/review-queue.test.ts` reddens on purpose when a finding goes
    // unanswered for three days, so a gate that demanded green would never pass
    // and every machine PR would pile up behind a red nobody was asked to fix.
    const fx = fixture({ variant: "draft", failsOn: "both" });
    const { calls, said } = fx.run();

    expect(said, "the run has to say why it landed over a red").toContain(`red the same way on`);
    expect(did(calls, "pr merge"), "a failure main also has is not this branch's").toBe(true);
  });

  it("lists the first failures and counts the rest, so a bad night cannot post hundreds of lines", () => {
    const fx = fixture({ variant: "draft", failsOn: "branch" });
    const { log, said } = fx.run({ failures: 30 });

    expect(said, "the log says how many, without the wall of names").toContain("30 failure(s) this branch adds");
    // The raw log, not `calls`: a comment body is multi-line and one line of
    // it would assert only its first sentence.
    const comment = log.slice(log.indexOf("pr comment 42"));
    expect(comment, "the list is capped").toContain("… and 10 more");
    expect((comment.match(/a finding nobody answered /g) ?? []).length, "20 names, not 30").toBe(20);
  });

  it("treats a test file that failed to LOAD as a failure, by name", () => {
    // qwen2's F-1: real vitest JSON for a transform error is `success: false`,
    // `numFailedTests: 0`, and an EMPTY assertionResults on a file marked failed.
    const fx = fixture({ variant: "draft" });
    const { calls, log, said } = fx.run({ loadFailure: true });

    expect(said, "the comparison counts it").toContain("1 failure(s) this branch adds");
    const comment = log.slice(log.indexOf("pr comment 42"));
    expect(comment, "the load failure has to be named, by file").toContain("load.test.ts");
    expect(comment).toContain("did not run");
    expect(did(calls, "pr merge"), "a file that never ran is not a green suite").toBe(false);
    expect(did(calls, "pr comment 42")).toBe(true);
  });

  it("does not land a non-zero suite that names nothing", () => {
    const fx = fixture({ variant: "draft", failsOn: "branch" });
    const { calls, said } = fx.run({ emptyFail: true });

    expect(said).toContain("exited non-zero and named no failing test");
    expect(did(calls, "pr merge")).toBe(false);
  });

  it("writes the marker it searches for, so a comment is left once", () => {
    // qwen2's F-2, driven the way it was found: the first night's comment body
    // is handed back as the PR's existing comments on the second night.
    const fx = fixture({ variant: "draft", failsOn: "branch" });
    const first = fx.run();
    const posted = first.log.slice(first.log.indexOf("pr comment 42"));
    expect(posted, "the posted body must carry the marker").toContain("<!-- nightly-machinery: red-gate -->");

    const second = fx.run({ view: posted });
    expect(did(second.calls, "pr comment 42"), "night two must not repeat the comment").toBe(false);
  });

  it("does not land a failure the branch adds", () => {
    const fx = fixture({ variant: "draft", failsOn: "branch" });
    const { calls, said } = fx.run();

    expect(said).toContain("failure(s) this branch adds");
    expect(did(calls, "pr merge")).toBe(false);
  });

  it("treats an install that cannot run as a failure, not a pass", () => {
    // No manifest in the fixture, so the gate's own `npm ci` fails: a check
    // that could not run has not been passed.
    const fx = fixture({ variant: "draft", install: "missing" });
    const { calls } = fx.run();

    expect(did(calls, "pr merge"), "an unrunnable check is not a merge").toBe(false);
    expect(did(calls, "pr comment 42")).toBe(true);
  });

  it("installs the branch's own dependencies before it checks", () => {
    // The real `npm ci`, on a tiny manifest — because borrowing the caller's
    // node_modules put two copies of every workspace package in play and made
    // typecheck fail on an untouched branch (measured 19 Sep 2026).
    const fx = fixture({ variant: "draft", install: "real" });
    const { calls, said } = fx.run();

    expect(said).toContain("merged changelog #42");
    expect(did(calls, "pr merge")).toBe(true);
  });

  it("treats a suite that left no report as a failure, not a pass", () => {
    // A command that exits 0 having said nothing is not a green suite. This is
    // the shape that bit the repository before: an absence reported as success.
    const fx = fixture({ variant: "draft" });
    const { calls, said } = fx.run({ suite: "true" });

    expect(said).toContain("no report");
    expect(did(calls, "pr merge"), "a suite nobody can read has not passed").toBe(false);
    expect(did(calls, "pr comment 42")).toBe(true);
  });

  it("leaves a PR that grew a file outside its own directory for a person", () => {
    const fx = fixture({ variant: "draft" });
    const { calls, said } = fx.run({ files: `docs/changelog/${DAY}.md\nscripts/something.mjs` });

    expect(said).toContain("scripts/something.mjs");
    expect(did(calls, "pr merge")).toBe(false);
    expect(did(calls, "pr close")).toBe(false);
  });
});

/**
 * **A move that leaves an optional call behind is a silent absence.**
 *
 * `reviews.mjs` drains the grades queue through a dynamic import of
 * `grade-night.mjs` — `import("./grade-night.mjs").then((m) => m.drainGradePRs?.())`
 * — and the `?.` means a name that moved without leaving a re-export behind
 * would do nothing, quietly, every night. So the name is asked for at runtime,
 * the way that caller asks for it.
 */
describe("the grade drain moved without going missing", () => {
  it("is still reachable through grade-night.mjs, where reviews.mjs imports it", () => {
    const said = execFileSync(
      "node",
      ["-e", 'import("./scripts/grade-night.mjs").then((m) => console.log(typeof m.drainGradePRs))'],
      { cwd: repo, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(said.trim()).toBe("function");
  });
});

describe("the bare check", () => {
  it("says why it passed, not just that it did", () => {
    // persona.yml calls this, and "green" on a merge target that is itself red
    // is a different fact from a green suite.
    const fx = fixture({ variant: "draft", failsOn: "both" });
    const said = fx.gate();

    expect(said).toContain("green:");
    expect(said, "the tolerated failure has to be visible").toContain("red the same way on");
  });

  it("says why it failed when the branch adds a failure", () => {
    const fx = fixture({ variant: "draft", failsOn: "branch" });
    const said = fx.gate();

    expect(said).toContain("red:");
    expect(said).toContain("failure(s) this branch adds");
  });
});

describe("a dry run", () => {
  it("reports what it would do and changes nothing", () => {
    const fx = fixture({ variant: "draft" });
    const { calls, log, said } = fx.run({ dryRun: true });

    expect(said).toContain("would merge changelog #42");
    expect(did(calls, "pr merge"), "a dry run must not merge").toBe(false);
    expect(did(calls, "pr close")).toBe(false);
    expect(did(calls, "pr comment")).toBe(false);
    expect(fx.tipMoved(), "and it must not push the index row").toBe(false);
    expect(log, "nothing mutating was asked of gh").not.toContain("pr merge");
  });
});

describe("the grades queue", () => {
  it("merges oldest first", () => {
    const fx = fixture({ kind: "grades", variant: "plain", days: [DAY, NEXT_DAY] });
    const { calls } = fx.run({ numbers: [41, 42] });

    const first = calls.findIndex((call) => call.startsWith("pr merge --squash"));
    const second = calls.findIndex((call, index) => index > first && call.startsWith("pr merge --squash"));
    expect(calls[first], "the older PR merges first").toContain("41");
    expect(calls[second], "and the newer one after it").toContain("42");
    expect(calls.filter((call) => call.startsWith("pr merge")).length).toBe(2);
  });

  it("closes a PR as superseded when the day's page is already on main", () => {
    const fx = fixture({ kind: "grades", variant: "plain", pageOnMain: true });
    const { calls, log } = fx.run({ mergeFails: true });

    expect(did(calls, "pr close 42")).toBe(true);
    expect(log.slice(log.indexOf("pr close 42")), "the replacement is named").toMatch(/`main` already carries/);
  });

  it("does NOT close a conflicting PR when nothing replaced it (isocan-v1d R2)", () => {
    const fx = fixture({ kind: "grades", variant: "plain" });
    const { calls, log } = fx.run({ mergeFails: true });

    expect(did(calls, "pr close 42"), "a conflict is not a supersession").toBe(false);
    expect(did(calls, "pr comment 42"), "but it cannot be silent either").toBe(true);
    expect(log, "the comment has to say nothing replaced it").toContain("not a supersession");
    expect(fx.tipMoved(), "and the branch is left as it was").toBe(false);
  });

  it("does not merge past a red gate", () => {
    const fx = fixture({ kind: "grades", variant: "plain", failsOn: "branch" });
    const { calls } = fx.run();

    expect(did(calls, "pr merge")).toBe(false);
    expect(did(calls, "pr comment 42")).toBe(true);
  });
});

/**
 * **The promise and the pipeline have to be in the same file.**
 *
 * The machinery only runs if the workflow calls it, and it only runs honestly
 * if the workflow gives the gate what the gate needs. Both halves are read out
 * of every workflow that names the script rather than listed here, so a third
 * one added next month is covered without anybody remembering this file.
 *
 * The checkout one is not fussiness. `actions/checkout` defaults to
 * `fetch-depth: 1`, and the gate runs the suite inside a scratch worktree of
 * the branch — where `changelog.test.ts` asks git what landed on the earliest
 * day, and a shallow clone answers "nothing landed". A depth-1 gate is a gate
 * that always fails, which is worse than no gate: it blames the branch for a
 * property of the checkout.
 */
/**
 * **The document and the machinery have to say the same thing.**
 *
 * `isocan-3aw` found this section describing two changelog behaviours that no
 * code performed, and nothing could tell: prose about enforcement is not
 * evidence of it. These two cases are the cheapest half of that guard — the
 * doc has to name the file that does the work, and the gate it describes has
 * to be the gate that runs.
 */
describe("AGENTS.md tells the truth about the machinery", () => {
  const agents = readFileSync(path.join(repo, "AGENTS.md"), "utf8");
  // Scoped to the section, not the file: "`npm run typecheck`" appears in the
  // house rules too, and a file-wide search would pass on a nightly section
  // that described a gate nobody runs.
  const section = agents.slice(
    agents.indexOf("## The night shift's pull requests"),
    agents.indexOf("## Research"),
  );

  it("names the file that does the work", () => {
    expect(section).toContain("scripts/nightly-prs.mjs");
  });

  it("describes the checks that are actually run", () => {
    const source = readFileSync(script, "utf8");
    for (const command of ["npm run typecheck", "npm test"]) {
      expect(source, `the gate should run ${command}`).toContain(command);
      // The whole span, backticks included: "`npm run typecheck`" is a
      // substring of a longer command AND appears in the house rules, so a
      // loose `toContain` passed on a doc describing a gate nobody runs —
      // which is the bug, not a near miss. Scoped to the section, since the
      // house rules carry the same words.
      expect(section, `the doc must name the check the code runs (\`${command}\`)`).toContain(`\`${command}\``);
    }
  });
});

describe("every workflow that runs the nightly machinery", () => {
  const dir = path.join(repo, ".github/workflows");
  const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
  const invoking = readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .filter((file) => read(file).includes("nightly-prs.mjs"));

  it("finds them at all — a search over nothing always passes", () => {
    expect(invoking.length).toBeGreaterThan(0);
  });

  it("checks out the whole history, because the gate walks it", () => {
    const shallow = invoking.filter((file) => !/fetch-depth:\s*0/.test(read(file)));
    expect(
      shallow,
      "these run the gate on a shallow checkout: the suite reads git history, so the worktree " +
        "would fail for a reason that is not the branch. Add `with: { fetch-depth: 0 }`.",
    ).toEqual([]);
  });

  it("installs dependencies, because the gate runs the suite", () => {
    const missing = invoking.filter((file) => !/- run: npm ci/.test(read(file)));
    expect(missing, "the gate cannot run without node_modules, and an unrunnable gate is not a pass").toEqual([]);
  });

  it("drains the changelog queue on days nothing was drafted", () => {
    const workflow = read("changelog.yml");
    expect(workflow).toContain("node scripts/nightly-prs.mjs --drain changelog");
    const drain = workflow.slice(workflow.indexOf("Drain the queue"));
    expect(drain, "the three-day rule must fire when today drafted nothing").not.toContain(
      "steps.gather.outputs.day",
    );
    expect(drain, "a cancelled run drains nothing").toContain("!cancelled()");
  });

  it("drains the grades queue from the run that opened the PR", () => {
    const workflow = read("grade.yml");
    expect(workflow).toContain("node scripts/nightly-prs.mjs --drain grades");
    expect(workflow.indexOf("--drain grades"), "the run merges its own PR, so the drain comes after it").toBeGreaterThan(
      workflow.indexOf("gh pr create"),
    );
  });

  it("sends the persona self-merge through the same gate", () => {
    const merge = read("persona.yml").slice(read("persona.yml").indexOf("The reports merge themselves"));
    expect(merge, "a machine PR that merges itself runs the check first").toContain("nightly-prs.mjs --gate");
    expect(merge.indexOf("--gate"), "and the check comes before the merge").toBeLessThan(merge.indexOf("gh pr merge"));
  });

  it("installs in the worktree, rather than borrowing the caller's modules", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain('return said || "npm ci --no-audit --no-fund";');
    expect(source, "a borrowed node_modules is two copies of every workspace package").not.toContain("symlinkSync");
  });

  it("asks the suite for a report it can compare, not just an exit code", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("--reporter=json --outputFile=$NIGHTLY_PR_REPORT");
    expect(source, "a red on the branch is compared with the merge target").toContain("withBaseTree");
  });

  it("never force-pushes over an authored page", () => {
    // A generated grade page can be rebuilt; a writer's sentence cannot. The
    // push that carries the index row is a plain one, and a rejected push is
    // how the machinery finds out somebody else got there first.
    const source = readFileSync(script, "utf8");
    expect(source).toContain('["push", "origin", `HEAD:refs/heads/${branch}`]');
    expect(source, "no force-push in the changelog path").not.toMatch(/push[^\n]*--force/);
  });
});
