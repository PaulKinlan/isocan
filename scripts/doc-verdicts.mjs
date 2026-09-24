#!/usr/bin/env node
/**
 * **A doc's own prose must not contradict its front matter.**
 *
 *   node scripts/doc-verdicts.mjs           # the count (one integer, for a persona goal)
 *   node scripts/doc-verdicts.mjs --names   # which docs, and the two verdicts side by side
 *
 * Front matter is the single status authority — that is the rule
 * `docs/ROADMAP.md` exists to enforce, and `core/docStatus` is its one reader, so
 * this imports that rather than parsing front matter a second time.
 *
 * What front matter cannot see is the **second verdict**: the hand-kept
 * `**Where we are:**` line that 28 project docs carry beside it. `docStatus`
 * reads front matter only, so a doc can say `status: designed` — "written,
 * argued, nothing built" — while its own prose says phase 1 is in progress, and
 * the roadmap prints the front matter and nothing objects.
 *
 * That is not hypothetical. `docs/research/2026-08-26-attaching-a-directory.md`
 * carries the scar: "This paragraph used to be a second verdict — 'not built' —
 * written before the pane was fixed and left behind when the first was." And
 * `docs/projects/voice-interface/phases.md` said "**Where we are: PHASE 1 IN
 * PROGRESS (2026-09-11)**" for a week while `packages/voice-agent` shipped
 * fifteen test files underneath it, its front matter said `designed`, and the
 * roadmap faithfully printed "designed". Three verdicts, none of them the truth,
 * and nothing able to tell (isocan-wy2).
 *
 * ## Why the rules are this narrow
 *
 * Two directions only, both keyed on a phase/walk quantifier rather than on a
 * verb alone:
 *
 *   1. front matter says nothing is built (`designed`, `open`, `noted`) and the
 *      prose says a phase, a walk or the project is built, closed, done,
 *      complete, landed or in progress;
 *   2. front matter says `built` and the prose says nothing is built.
 *
 * A looser rule reads "the design is complete" on a `designed` doc as a
 * contradiction, and a guard that cries wolf on the first doc somebody writes is
 * a guard that gets turned off — which `scripts/ratchet.mjs` names as worse than
 * never having had it. `partial` is deliberately NOT checked in either
 * direction: it means "some of it is built, the doc says which part", so any
 * mix of built and unbuilt prose agrees with it by definition.
 *
 * ## Measured the day this was written
 *
 * 28 `Where we are` lines across `docs/projects/`, **0 contradictions**. The one
 * doc that is `designed` and carries the line (`browser-surface`) says "ROADMAP
 * REGISTERED … specified … defined", which is design language and correctly does
 * not match. So the bound is 0 and stays affordable: it is strict about the next
 * doc rather than asking anybody to clean up this one.
 *
 * `--root <dir>` points it at a fixture instead of the real tree, which is how
 * `test/doc-verdicts.test.ts` shows the guard can fail. A check that has only
 * ever been seen to pass is decoration, and this one is meant to stop a commit.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

register();
// The one reader. Registering tsx once and importing the function directly is
// `scripts/roadmap.mjs`'s pattern, and the reason is the same: reaching
// `docStatus` through the CLI would transpile eleven thousand lines of main.ts
// per document.
const { docStatus } = await import("@isocan/core");

const repo = fileURLToPath(new URL("..", import.meta.url));
/** `scripts/roadmap.mjs`'s order: the first of these that exists is the doc whose
 *  front matter the roadmap reads, so it is the one whose status is authoritative. */
const ORDER = ["journey.md", "design.md", "plan.md", "phases.md"];
/** Core's own vocabulary, not a restatement of it: these three all mean nothing
 *  is built yet. `open` is also what a doc with no front matter at all reads as. */
const NOTHING_BUILT = new Set(["designed", "open", "noted"]);

/** Prose that claims work happened, keyed on a phase/walk/project quantifier so
 *  that "the design is complete" on a `designed` doc is not a hit. */
const CLAIMS_BUILT = [
  /\bPHASE\s+\d+\s+IN\s+PROGRESS\b/i, // the exact string voice-interface carried
  /\bphases?\b[^.]{0,60}\b(built|closed|done|complete|landed|part-done|in progress)\b/i,
  /\b(all|every)\b[^.]{0,40}\b(built|closed|done|complete)\b/i,
  /\b(walk|project)\b[^.]{0,40}\b(complete|done|closed)\b/i,
];
/** Prose that claims nothing was built. */
const CLAIMS_NOTHING = [/\b(nothing|no phase|none)\b[^.]{0,40}\bbuilt\b/i, /\bnot built\b/i];

const anyMatch = (patterns, text) => patterns.some((re) => re.test(text));

/**
 * The `**Where we are…**` verdict and enough of its paragraph to judge it.
 * Bounded, because a doc can ramble and the quantifier patterns above look
 * within a sentence, not across the whole file.
 */
function whereWeAre(text) {
  const at = text.search(/\*\*Where we are/i);
  if (at < 0) return null;
  const rest = text.slice(at);
  const blank = rest.search(/\n\s*\n/);
  return rest.slice(0, blank > 0 ? blank : 400).replace(/\s+/g, " ").trim();
}

/**
 * Every contradiction in `docs/projects/`, as
 * `{ dir, statusDoc, status, prose, file, why }`.
 * Exported so the test can drive it against a synthetic doc rather than only
 * asserting that today's tree happens to be clean — a guard that cannot be shown
 * to fail is decoration.
 */
export function contradictions(root = path.join(repo, "docs/projects")) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const dir of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const full = path.join(root, dir);
    const statusDoc = ORDER.map((f) => path.join(full, f)).find((f) => existsSync(f));
    if (!statusDoc) continue;
    const { status } = docStatus(readFileSync(statusDoc, "utf8"));
    for (const entry of readdirSync(full).filter((f) => f.endsWith(".md"))) {
      const file = path.join(full, entry);
      const prose = whereWeAre(readFileSync(file, "utf8"));
      if (!prose) continue;
      const rel = path.relative(repo, file);
      if (NOTHING_BUILT.has(status) && anyMatch(CLAIMS_BUILT, prose)) {
        out.push({ dir, statusDoc: path.relative(repo, statusDoc), status, prose, file: rel, why: `front matter says "${status}" — nothing built — and the prose says work is built, closed or in progress` });
      } else if (status === "built" && anyMatch(CLAIMS_NOTHING, prose)) {
        out.push({ dir, statusDoc: path.relative(repo, statusDoc), status, prose, file: rel, why: `front matter says "built" and the prose says nothing is` });
      }
    }
  }
  return out;
}

const argv = process.argv.slice(2);
const rootArg = argv.indexOf("--root");
const ROOT = rootArg >= 0 ? path.resolve(argv[rootArg + 1] ?? "") : path.join(repo, "docs/projects");

const found = contradictions(ROOT);
if (argv.includes("--names")) {
  if (found.length === 0) {
    console.log("no project doc contradicts its own front matter");
  } else {
    for (const c of found) {
      console.log(`${c.file} — ${c.why}`);
      console.log(`    authority: ${c.statusDoc} (status: ${c.status})`);
      console.log(`    prose:     ${c.prose.slice(0, 200)}`);
    }
    console.log(`\nFix the front matter or the prose — whichever is true. If both are, the doc has two verdicts and one of them should go.`);
  }
} else {
  console.log(found.length);
}
