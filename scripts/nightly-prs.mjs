#!/usr/bin/env node
/**
 * **The night shift's pull requests: which one lands, which one waits, and
 * which one is closed.**
 *
 * AGENTS.md states the policy ("The night shift's pull requests"); this file is
 * the machinery that performs it, so the two can be read against each other
 * instead of taken on faith. It exists because the promise was written before
 * the code was: until 18 Sep 2026 the changelog half of that section described
 * a three-day draft merge and a supersede-close that nothing in the repository
 * performed — `git log -S` over every ref finds only the two hand-drains of
 * 7 and 8 September, so for eleven days the rule most reliant on a person
 * remembering was the one with nothing behind it.
 *
 * Three rules, and one gate they all pass through:
 *
 *   - **Changelogs are authored, so the default is wait.** The PR is the
 *     drafting surface; a writer — person or agent — deletes the draft marker,
 *     adds the index row and merges. Machinery owns the floor and the door: a
 *     draft still unwritten after three days is landed AS a draft, marker
 *     intact and index row saying so, and when the day's page is already on
 *     `main` the PR is superseded and closed.
 *   - **Grades are a time series, so the default is merge** (`drainGradePRs`).
 *   - **The gate.** A PR opened with `GITHUB_TOKEN` does fire `pull_request`
 *     runs, but GitHub holds them approval-required, so nothing has checked a
 *     machine PR by the time the merge step runs. The merge step runs the
 *     suite itself, against the branch, and a red — or unrunnable — gate
 *     leaves the PR for a person.
 *
 *   node scripts/nightly-prs.mjs --drain changelog
 *   node scripts/nightly-prs.mjs --drain grades
 *   node scripts/nightly-prs.mjs --gate changelog/2026-09-16
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Everything here runs in the checkout the workflow — or a test — put us in,
 * and never in the directory this file lives in. A fixture repository is a
 * repository too, and a root resolved from `import.meta.url` would quietly
 * make every fixture test a test of `isocan` itself.
 */
const cwd = process.cwd();

/** The writer's window: three days of nobody writing, then machinery lands it. */
export const DRAFT_WINDOW_HOURS = 72;

const CHANGELOG_DIR = "docs/changelog/";
const GRADES_DIR = "docs/grades/";
const MAIN = "refs/remotes/origin/main";

/** Output caps. `execFileSync` buffers, and a full suite is louder than the
 *  one megabyte default — a red gate that fails with ENOBUFS is a gate that
 *  blames the wrong thing. */
const MAX_OUTPUT = 32 * 1024 * 1024;

const log = (...said) => console.log(...said);

/**
 * **What tonight would do, without doing it.**
 *
 * The machinery's first night on a real queue is the one place a mistake is
 * expensive — a wrong merge or a wrong close on somebody's PR — so the run can
 * be asked what it thinks first: `--dry-run` reports every merge, close and
 * comment it would make and makes none of them. Acting is still the default;
 * this is a flag, not a mode anybody can leave the machinery in.
 */
let DRY = false;
const would = (said) => {
  log(`[dry run] would ${said}`);
};

function messageOf(err) {
  const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr ?? "") : "";
  const stdout = err && typeof err === "object" && "stdout" in err ? String(err.stdout ?? "") : "";
  const said = (stderr.trim() || stdout.trim() || (err instanceof Error ? err.message : String(err))).trim();
  return said.length > 1500 ? `${said.slice(0, 1500)}…` : said;
}

function run(file, args, { dir = cwd, env = process.env } = {}) {
  return execFileSync(file, args, {
    cwd: dir,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_OUTPUT,
  }).trim();
}

function tryRun(file, args, options) {
  try {
    return { ok: true, out: run(file, args, options) };
  } catch (err) {
    return { ok: false, out: messageOf(err) };
  }
}

const gitTry = (args, options) => tryRun("git", args, options);
const ghTry = (args, options) => tryRun("gh", args, options);

/** The run that did this, for a comment a reader can follow back. */
function runUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : "nightly run";
}

/** How to get a branch back, so a supersede-close is never a loss. */
const recover = (branch) =>
  `The branch \`${branch}\` was kept; to recover it: \`git fetch origin ${branch} && git checkout ${branch}\`.`;

/**
 * **The merge gate.** What runs against the branch before anything merges.
 *
 * Three commands, each overridable so a test can drive the wiring without
 * paying for a real suite — and **empty is not a way to turn any of them off**:
 * a gate somebody can empty is a gate that passes, so an empty value falls back
 * to the real command.
 *
 * `main` can be red on purpose: `test/review-queue.test.ts` reddens the suite
 * when a review finding goes unanswered for three days, which is a forcing
 * function and not a bug. A gate that demanded a green suite would therefore
 * never pass and every machine PR would pile up behind a red nobody was asked
 * to fix — so the criterion is what a docs-only branch can actually be held to:
 * **the branch adds no failure that the merge target does not already have.**
 * The alternative, and the reason this is written down rather than assumed, is
 * the failure this repository keeps finding: a gate that always fails, blaming
 * the work for a property of the base.
 */
export function installCommand() {
  const said = (process.env.NIGHTLY_PR_INSTALL ?? "").trim();
  return said || "npm ci --no-audit --no-fund";
}

export function typecheckCommand() {
  const said = (process.env.NIGHTLY_PR_TYPECHECK ?? "").trim();
  return said || "npm run typecheck";
}

/** The suite writes vitest's JSON report to `$NIGHTLY_PR_REPORT`, so a failure
 *  on the branch can be compared with the same failure on the merge target
 *  rather than taken as a verdict on its own. */
export function suiteCommand() {
  const said = (process.env.NIGHTLY_PR_SUITE ?? "").trim();
  return said || "npm test -- --reporter=json --outputFile=$NIGHTLY_PR_REPORT";
}

/** The failing tests in one tree, by name, from the suite's own report. */
function suiteReport(dir) {
  const report = path.join(os.tmpdir(), `isocan-nightly-report-${process.pid}-${path.basename(dir)}.json`);
  rmSync(report, { force: true });
  const said = tryRun("sh", ["-c", suiteCommand()], { dir, env: { ...process.env, NIGHTLY_PR_REPORT: report } });
  if (!existsSync(report)) {
    return {
      broken: `the suite left no report (it ${said.ok ? "exited 0" : "failed"} without writing one), so nothing can be said about the branch: ${said.out}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(report, "utf8"));
  } catch {
    return { broken: `the suite's report could not be read: ${said.out}` };
  }
  const failed = [];
  for (const file of parsed.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === "failed") failed.push(assertion.fullName ?? assertion.title ?? file.name);
    }
  }
  return { failed, said: said.out };
}

/**
 * The merge target's own tree, for the comparison.
 *
 * In a workflow the caller's checkout *is* `main` — `actions/checkout` with no
 * `ref` takes the default branch on a schedule — and its dependencies are
 * already installed, so the comparison costs one suite run and nothing else.
 * Anywhere else (a lane's worktree, a dirty tree) a scratch worktree of `main`
 * is made and installed instead, because comparing against the wrong tree would
 * invent failures the branch does not have.
 */
function withBaseTree(fn) {
  const head = gitTry(["rev-parse", "HEAD"]);
  const target = gitTry(["rev-parse", MAIN]);
  const dirty = gitTry(["status", "--porcelain"]);
  if (head.ok && target.ok && head.out === target.out && dirty.ok && dirty.out === "") {
    return fn({ dir: cwd, install: false });
  }
  gitTry(["fetch", "--quiet", "origin", "main"]);
  const dir = path.join(os.tmpdir(), `isocan-nightly-base-${process.pid}`);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const added = gitTry(["worktree", "add", "--detach", dir, MAIN]);
  if (!added.ok) return { ok: false, said: `could not check out ${MAIN} to compare against: ${added.out}` };
  try {
    return fn({ dir, install: true });
  } finally {
    const removed = gitTry(["worktree", "remove", "--force", dir]);
    if (!removed.ok) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    gitTry(["worktree", "prune"]);
  }
}

export function gateIn(dir) {
  const installed = tryRun("sh", ["-c", installCommand()], { dir });
  if (!installed.ok) {
    // Fail closed. A gate that cannot run is not a gate that passed.
    return { ok: false, said: `could not install in the worktree, so the gate cannot run: ${installed.out}` };
  }
  const typed = tryRun("sh", ["-c", typecheckCommand()], { dir });
  if (!typed.ok) return { ok: false, said: `typecheck failed in the branch's own tree:\n${typed.out}` };

  const branch = suiteReport(dir);
  if (branch.broken) return { ok: false, said: branch.broken };
  if (branch.failed.length === 0) return { ok: true, said: "the suite is green" };

  return withBaseTree((base) => {
    if (base.install) {
      const installed = tryRun("sh", ["-c", installCommand()], { dir: base.dir });
      if (!installed.ok) {
        return { ok: false, said: `the suite is red on the branch and ${MAIN} could not be installed to compare against: ${installed.out}` };
      }
    }
    const onBase = suiteReport(base.dir);
    if (onBase.broken) {
      return { ok: false, said: `the suite is red on the branch and could not be compared with ${MAIN}: ${onBase.broken}` };
    }
    const added = branch.failed.filter((name) => !onBase.failed.includes(name));
    if (added.length === 0) {
      return {
        ok: true,
        said: `the suite is red, and red the same way on ${MAIN}: ${onBase.failed.length} failure(s), none of them this branch's`,
      };
    }
    return { ok: false, said: `${added.length} failure(s) this branch adds:\n${added.map((name) => `- ${name}`).join("\n")}` };
  });
}

/**
 * Run `fn` inside a scratch worktree of `branch`, then take it away again.
 *
 * Nothing is borrowed from the caller's checkout — not `node_modules`, not a
 * build — because a half-borrowed tree is what produced the two-copies failure
 * above. The worktree is the branch, whole.
 */
function withBranch(branch, fn) {
  const ref = `refs/remotes/origin/${branch}`;
  const fetched = gitTry(["fetch", "--quiet", "origin", `+refs/heads/${branch}:${ref}`]);
  if (!fetched.ok) return { ok: false, said: `could not fetch ${branch}: ${fetched.out}` };

  const dir = path.join(os.tmpdir(), `isocan-nightly-${process.pid}-${branch.replace(/[^\w.-]+/g, "-")}`);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const added = gitTry(["worktree", "add", "--detach", dir, ref]);
  if (!added.ok) return { ok: false, said: `could not check out ${branch}: ${added.out}` };

  try {
    return fn(dir, ref);
  } finally {
    const removed = gitTry(["worktree", "remove", "--force", dir]);
    if (!removed.ok) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    gitTry(["worktree", "prune"]);
  }
}

export function gate(branch) {
  return withBranch(branch, (dir) => gateIn(dir));
}

/**
 * The open PRs whose branch starts with `prefix`, oldest first.
 *
 * `null` on a failure to ask, which is not the same as "none open": a run that
 * could not list pull requests must not report that it drained anything.
 */
function openPRs(prefix) {
  const said = ghTry(["pr", "list", "--state", "open", "--limit", "50", "--json", "number,headRefName,createdAt"]);
  if (!said.ok) {
    log(`could not list pull requests: ${said.out}`);
    return null;
  }
  let rows;
  try {
    rows = JSON.parse(said.out);
  } catch {
    log("could not read the pull-request list");
    return null;
  }
  return rows
    .filter((pr) => typeof pr?.headRefName === "string" && pr.headRefName.startsWith(prefix))
    .sort((a, b) => a.number - b.number);
}

/** Is every file in this PR inside `dir`? A machine PR that grew a hand edit
 *  outside its own directory is not the machinery's to merge. */
function inScope(number, dir) {
  const said = ghTry(["pr", "diff", "--name-only", String(number)]);
  if (!said.ok) return { ok: false, said: `could not read the diff: ${said.out}` };
  const files = said.out.split("\n").map((file) => file.trim()).filter(Boolean);
  if (files.length === 0) return { ok: false, said: "the diff has no files" };
  const outside = files.filter((file) => !file.startsWith(dir));
  return outside.length === 0
    ? { ok: true }
    : { ok: false, said: `it touches ${outside.slice(0, 3).join(", ")}${outside.length > 3 ? ", …" : ""}` };
}

/**
 * Say something on the PR — once. A machine that repeats itself every night is
 * a machine people filter, and the point of these comments is that they are
 * read on the morning they first matter.
 */
function commentOnce(number, marker, body) {
  const seen = ghTry(["pr", "view", String(number), "--json", "comments", "--jq", '[.comments[].body] | join("\\n")']);
  if (seen.ok && seen.out.includes(marker)) return false;
  if (DRY) {
    would(`comment on #${number}: ${body.split("\n")[0]}`);
    return false;
  }
  const said = ghTry(["pr", "comment", String(number), "--body", body]);
  if (!said.ok) log(`could not comment on #${number}: ${said.out}`);
  return said.ok;
}

const OUTSIDE = "nightly-machinery: outside-its-own-directory";
const RED_GATE = "nightly-machinery: red-gate";
const UNREADY = "nightly-machinery: not-ready";
const CONFLICTED = "nightly-machinery: merge-failed";

/** `2026-09-16` → `16 Sep`, which is how the index's own rows say a day. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The writer's own headline, quoted from their page — never invented. A day
 * whose entry has no headline is left for a person rather than indexed under
 * one the machinery made up.
 */
export function headlineOf(page) {
  const dashed = /^#\s+\d{1,2}\s+\w+\s+\d{4}\s+—\s+(.+)$/m.exec(page);
  if (dashed) return dashed[1].trim();
  const section = /^##\s+(.+)$/m.exec(page);
  return section ? section[1].trim() : null;
}

/** The index row for a landed day, in the same shape as the rows the hand
 *  drain of 7 and 8 September wrote. */
export function rowFor(day, page) {
  const [, month, date] = day.split("-").map(Number);
  const label = `${date} ${MONTHS[month - 1]}`;
  if (page.includes("<!-- draft -->")) {
    return `| **[${label}](${day}.md)** | Draft | Merged as a draft, unwritten after three days, per AGENTS.md's machine-PR rule: the day's commits with what they said, and no entry yet. Write it up in place and replace this row. |`;
  }
  const headline = headlineOf(page);
  return headline
    ? `| **[${label}](${day}.md)** | ${headline} | Landed by the night shift's three-day rule; the writer's entry is on the page. |`
    : null;
}

/** Add the row under the table's header, newest first — where the index's own
 *  rows go. Refuses (rather than guesses) when it cannot write a true row. */
function addRow(dir, day, page) {
  const file = path.join(dir, "docs/changelog/README.md");
  const before = readFileSync(file, "utf8");
  if (before.includes(`(${day}.md)`)) return { ok: true, changed: false };
  const row = rowFor(day, page);
  if (!row) return { ok: false, said: `the entry for ${day} has no headline to quote, so there is no true index row to write` };
  const lines = before.split("\n");
  const separator = lines.findIndex((line) => /^\|\s*-{3,}/.test(line));
  if (separator < 0) return { ok: false, said: "docs/changelog/README.md has no index table to add a row to" };
  lines.splice(separator + 1, 0, row);
  writeFileSync(file, lines.join("\n"));
  return { ok: true, changed: true };
}

/** A commit by the machinery, not by whoever ran it. */
function botEnv() {
  const who = { GIT_AUTHOR_NAME: "isocan changelog", GIT_AUTHOR_EMAIL: "noreply@github.com" };
  return {
    ...process.env,
    ...who,
    GIT_COMMITTER_NAME: who.GIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: who.GIT_AUTHOR_EMAIL,
  };
}

const branchFile = (ref, rel) => gitTry(["show", `${ref}:${rel}`]);
const mainFile = (rel) => gitTry(["show", `${MAIN}:${rel}`]);

/** The commit on `main` carrying a page: a supersede comment that names no
 *  replacement is a close nobody can check. */
function landingCommit(rel) {
  const said = gitTry(["log", "-1", "--format=%h %s", MAIN, "--", rel]);
  return said.ok && said.out ? said.out : null;
}

function ageHours(createdAt) {
  const then = Date.parse(createdAt ?? "");
  return Number.isFinite(then) ? (Date.now() - then) / 3_600_000 : null;
}

/**
 * The day has landed on `main` already, so the PR has nothing left to add.
 *
 * A supersede-close names the commit that replaced it: "closed as superseded"
 * with no link is a claim nobody can check, and `isocan-v1d` R2 asked for the
 * link for a reason — a close is only honest when there is a replacement.
 */
function supersedeClosed(pr, branch, rel, day, kind) {
  const landed = landingCommit(rel);
  const body = [
    `Closed as superseded (${runUrl()}).`,
    "",
    `\`main\` already carries ${day}'s ${kind}${landed ? ` in \`${landed}\`` : ""}, so this pull request has nothing left to add.`,
    "",
    recover(branch),
  ].join("\n");
  if (DRY) {
    would(`close #${pr.number} (${branch}) as superseded by ${landed ?? `${day} on main`}`);
    return;
  }
  const said = ghTry(["pr", "close", String(pr.number), "--comment", body]);
  log(
    said.ok
      ? `closed #${pr.number} (${branch}) as superseded by ${landed ?? `${day} on main`}`
      : `could not close #${pr.number}: ${said.out}`,
  );
}

/** A red gate, said the same way in both queues: the branch is not landed and
 *  the reason is the check, not the content. */
function redGate(number, said, what) {
  // The run log carries the reason, not just the verdict: a nightly that says
  // "the gate is red" and nothing else costs somebody a morning.
  log(`#${number} not merged — ${said.split("\n")[0]}`);
  commentOnce(
    number,
    RED_GATE,
    [
      `Left for a person: the merge gate is red on this branch, so machinery will not land it.`,
      "",
      "```",
      said,
      "```",
      "",
      `Fix the branch, or close it by hand — nothing here lands a ${what} the suite has not passed.`,
    ].join("\n"),
  );
}

/**
 * Drain the changelog queue, oldest first.
 *
 * Three things, in the order that keeps a day from being lost:
 *   1. the page is already on `main` → supersede-close, with the commit linked;
 *   2. the PR is past the writer's window → land it, as a draft or as written;
 *   3. inside the window → leave it alone, which is most nights.
 *
 * Returns false only when the queue could not be read.
 */
export function drainChangelogPRs() {
  const prs = openPRs("changelog/");
  if (prs === null) return false;
  if (prs.length === 0) {
    log("no open changelog pull requests");
    return true;
  }
  gitTry(["fetch", "--quiet", "origin", "main"]);

  for (const pr of prs) {
    const branch = pr.headRefName;
    const day = branch.slice("changelog/".length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      log(`#${pr.number} (${branch}) is not a day's draft — left alone`);
      continue;
    }
    const scope = inScope(pr.number, CHANGELOG_DIR);
    if (!scope.ok) {
      log(`#${pr.number} (${branch}) is left for a person: ${scope.said}`);
      commentOnce(
        pr.number,
        OUTSIDE,
        `Left for a person: ${scope.said}. The nightly machinery merges only its own \`docs/changelog/\` pages, so this one is not its to land.`,
      );
      continue;
    }

    const rel = `${CHANGELOG_DIR}${day}.md`;
    if (mainFile(rel).ok) {
      supersedeClosed(pr, branch, rel, day, "page");
      continue;
    }

    const hours = ageHours(pr.createdAt);
    if (hours === null) {
      log(`#${pr.number} (${branch}) has no readable age — left for a person`);
      continue;
    }
    if (hours < DRAFT_WINDOW_HOURS) {
      log(`#${pr.number} (${branch}) is ${Math.floor(hours)}h old — inside the writer's window`);
      continue;
    }

    const ready = withBranch(branch, (dir, ref) => {
      const page = branchFile(ref, rel);
      if (!page.ok) return { ok: false, said: `the branch carries no ${rel}` };

      const gated = gateIn(dir);
      if (!gated.ok) return { ok: false, gate: true, said: gated.said };

      const row = addRow(dir, day, page.out);
      if (!row.ok) return { ok: false, said: row.said };
      const gateSaid = gated.said;
      if (!row.changed) return { ok: true, said: `${gateSaid}; the index row was already there` };

      const staged = gitTry(["add", "docs/changelog/README.md"], { dir });
      if (!staged.ok) return { ok: false, said: `could not stage the index row: ${staged.out}` };
      const wrote = gitTry(["commit", "-m", `Changelog index: ${day}, merged as a draft`], { dir, env: botEnv() });
      if (!wrote.ok) return { ok: false, said: `could not commit the index row: ${wrote.out}` };
      // No `--force`, deliberately: an authored page is not a generated one,
      // and a push that finds a writer's edit waiting is a push that stands
      // down and asks.
      if (DRY) {
        would(`commit and push the index row for ${day} to ${branch}`);
        return { ok: true, said: `${gateSaid}; index row would be added` };
      }
      const pushed = gitTry(["push", "origin", `HEAD:refs/heads/${branch}`], { dir });
      if (!pushed.ok) return { ok: false, said: `could not push the index row: ${pushed.out}` };
      return { ok: true, said: `${gateSaid}; index row added` };
    });

    if (!ready.ok) {
      if (ready.gate) {
        redGate(pr.number, ready.said, "draft");
      } else {
        log(`#${pr.number} (${branch}) not merged — ${ready.said}`);
        commentOnce(pr.number, UNREADY, `Left for a person: ${ready.said}.`);
      }
      continue;
    }

    if (DRY) {
      would(`merge changelog #${pr.number} (${branch}) — ${ready.said}`);
      continue;
    }
    const merged = ghTry(["pr", "merge", "--squash", "--delete-branch", String(pr.number)]);
    if (merged.ok) {
      log(`merged changelog #${pr.number} (${branch}) — ${ready.said}`);
      continue;
    }
    // A failed merge is NOT proof of supersession: `main` moved under the
    // branch (the index row is a shared file), which needs a rebase and not a
    // close. So look again — if the day landed while this ran, it is genuinely
    // superseded; if it did not, nothing has replaced it and it stays open.
    log(`#${pr.number} (${branch}) could not be merged: ${merged.out}`);
    gitTry(["fetch", "--quiet", "origin", "main"]);
    if (mainFile(rel).ok) {
      supersedeClosed(pr, branch, rel, day, "page");
      continue;
    }
    commentOnce(
      pr.number,
      CONFLICTED,
      [
        `Left for a person: the merge failed, and a failed merge is not a supersession — nothing here has been replaced.`,
        "",
        "```",
        merged.out,
        "```",
        "",
        recover(branch),
      ].join("\n"),
    );
  }
  return true;
}

/**
 * Drain the grades queue, oldest first — the run's own PR included, because
 * "the run merges its own PR" is only true if something in the run does it.
 *
 * Merging is the default and superseding is the exception, because these pages
 * are a time series: yesterday's readings are yesterday's, not stale. A merge
 * that FAILS is not proof that anything replaced it — `main` moved under the
 * branch, which needs a rebase — so a close happens only when that day's page
 * has landed anyway, and then the comment names the commit that carries it.
 * `isocan-v1d` R2 is the reason: a real conflict on a unique, unpublished
 * grade day would otherwise be called superseded, and a day's readings
 * quietly gone.
 */
export function drainGradePRs() {
  const prs = openPRs("grades/");
  if (prs === null) return false;
  if (prs.length === 0) {
    log("no open grades pull requests");
    return true;
  }
  gitTry(["fetch", "--quiet", "origin", "main"]);

  for (const pr of prs) {
    const branch = pr.headRefName;
    const day = branch.slice("grades/".length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      log(`#${pr.number} (${branch}) is not a day's page — left alone`);
      continue;
    }
    const scope = inScope(pr.number, GRADES_DIR);
    if (!scope.ok) {
      log(`#${pr.number} (${branch}) is left for a person: ${scope.said}`);
      commentOnce(
        pr.number,
        OUTSIDE,
        `Left for a person: ${scope.said}. The nightly machinery merges only its own \`docs/grades/\` pages.`,
      );
      continue;
    }

    const rel = `${GRADES_DIR}${day}.md`;
    if (mainFile(rel).ok) {
      supersedeClosed(pr, branch, rel, day, "readings");
      continue;
    }

    const gated = withBranch(branch, (dir) => gateIn(dir));
    if (!gated.ok) {
      redGate(pr.number, gated.said, "page of readings");
      continue;
    }

    if (DRY) {
      would(`merge grades #${pr.number} (${branch})`);
      continue;
    }
    const merged = ghTry(["pr", "merge", "--squash", "--delete-branch", String(pr.number)]);
    if (merged.ok) {
      log(`merged grades #${pr.number} (${branch})`);
      continue;
    }
    if (mainFile(rel).ok) {
      supersedeClosed(pr, branch, rel, day, "readings");
      continue;
    }
    log(`#${pr.number} (${branch}) could not be merged: ${merged.out}`);
    gitTry(["fetch", "--quiet", "origin", "main"]);
    if (mainFile(rel).ok) {
      supersedeClosed(pr, branch, rel, day, "readings");
      continue;
    }
    commentOnce(
      pr.number,
      CONFLICTED,
      [
        "Left for a person: the merge failed, and a failed merge is not a supersession — no page for this day is on `main`, so nothing here has been replaced.",
        "",
        "```",
        merged.out,
        "```",
        "",
        recover(branch),
      ].join("\n"),
    );
  }
  return true;
}

const argv = process.argv.slice(2);
DRY = argv.includes("--dry-run");
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const drainAt = argv.indexOf("--drain");
  const gateAt = argv.indexOf("--gate");
  if (drainAt >= 0) {
    const what = argv[drainAt + 1];
    if (DRY) log("dry run: every change below was reported and none was made");
    if (what === "changelog") process.exit(drainChangelogPRs() ? 0 : 1);
    if (what === "grades") process.exit(drainGradePRs() ? 0 : 1);
    console.error(`--drain takes changelog or grades, not ${what ?? "nothing"}`);
    process.exit(2);
  }
  if (gateAt >= 0) {
    const branch = argv[gateAt + 1];
    if (!branch) {
      console.error("--gate takes a branch, e.g. --gate changelog/2026-09-16");
      process.exit(2);
    }
    const gated = gate(branch);
    console.log(gated.ok ? `green: ${branch}` : `red: ${branch} — ${gated.said}`);
    process.exit(gated.ok ? 0 : 1);
  }
  console.error("usage: nightly-prs.mjs --drain changelog|grades [--dry-run] | --gate <branch>");
  process.exit(2);
}
