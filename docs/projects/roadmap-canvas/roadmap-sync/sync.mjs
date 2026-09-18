#!/usr/bin/env node
/**
 * Roadmap canvas sync — the manual form of docs/projects/roadmap-canvas phase 1/3.
 *
 * Re-reads `origin/main:docs/ROADMAP.md` and every document it links, and lands
 * what changed as a new version on the canvas. Derived and regenerated: nothing
 * here writes a canvas item except by copying bytes out of the repository, so the
 * canvas cannot disagree with the commit it names.
 *
 * State lives in .roadmap-sync.json — path → { item, sha } — beside this script,
 * never in the repository. A run that cannot reach the home writes nothing and
 * exits non-zero; the next run retries from the same commit.
 *
 *   node sync.mjs              one pass
 *   node sync.mjs --selftest   the parser and the sheet-growth math, on fixtures
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
// Overridable so a rehearsal can run against a scratch canvas and manifest.
const REPO = process.env.ROADMAP_REPO ?? "/home/paulkinlan/isocan";
const MANIFEST = process.env.ROADMAP_MANIFEST ?? join(DIR, ".roadmap-sync.json");
const CANVAS = process.env.ROADMAP_CANVAS ?? "prj_OE-AuGl119";
const CARD = { width: 360, height: 260 };
const PAD = 24; // sheet inner margin, matches core/area.ts
const GAP = 40; // the spacing the CLI's freeSpotIn packs with

const log = (...a) => console.log(new Date().toISOString(), ...a);
const git = (...args) =>
  execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
const show = (ref) =>
  execFileSync("git", ["-C", REPO, "show", ref], { encoding: "utf8", maxBuffer: 1 << 26 });

/** The ROADMAP's own structure: `##` headings are sections, table rows are docs. */
export function parseRoadmap(md) {
  const rows = [];
  let section = null;
  for (const line of md.split("\n")) {
    const h = line.match(/^## (.+?)(?: <sub>.*)?$/);
    if (h) { section = h[1].trim(); continue; }
    if (!section) continue;
    const m = line.match(/^\| (?:research|\*\*project\*\*) \| \[([^\]]+)\]\(([^)]+)\)/);
    if (!m || !m[2].endsWith(".md")) continue;
    const path = m[2].startsWith("docs/") ? m[2] : `docs/${m[2]}`;
    rows.push({ section, title: m[1], path });
  }
  return rows;
}

/** `item.kind` is the CONTENT's kind even for a sheet — the sheet is a property. */
const isArea = (item) => item.properties?.kind === "area" || item.kind === "area";

/** Where the sheet must end for `count` cards at this width — the caller's grow. */
export function grownHeight(area, count, card = CARD) {
  const cols = Math.max(1, Math.floor((area.width - PAD * 2 + GAP) / (card.width + GAP)));
  const rows = Math.ceil(count / cols);
  return Math.max(area.height, PAD * 2 + rows * (card.height + GAP) - GAP);
}

/**
 * A document that appears in the roadmap lands through the CLI, not the library,
 * and that is deliberate: `AddSpec.at` travels as an UNCHOSEN placement, which
 * the daemon is right to tidy out of the sheet (`positionIsMeaningful` in
 * core/placement.ts) — measured 10 Sep, a script's `at` inside a sheet came back
 * at x=-1176. `--in <area>` is the gesture that marks the spot chosen, so the new
 * row lands among its siblings. One spawn per document that appears, which is
 * rare; the common run only edits what is already there.
 */
function addViaCli(canvasId, file, section, title, path, head, at, size = CARD) {
  const args = ["--canvas", canvasId, "add", file, "--size", `${size.width}x${size.height}`,
    "--title", title, "--prop", `upstream=${path}`, "--prop", `commit=${head}`, "--json"];
  if (at) args.push("--at", `${at.x},${at.y}`);
  else args.push("--in", section);
  const out = execFileSync("isocan", args,
    { encoding: "utf8", env: { ...process.env, ISOCAN_SESSION_ID: "roadmap-sync", ISOCAN_HARNESS: "cron" } },
  );
  return JSON.parse(out).itemId;
}

/** A text node, through the CLI, so its box is the measured one the ladder wants. */
function textViaCli(canvasId, words, { at, style, title, size }) {
  const scratch = mkdtempSync(join(tmpdir(), "roadmap-sync-"));
  const file = join(scratch, "legend.md");
  writeFileSync(file, words);
  const args = ["--canvas", canvasId, "text", "-f", file, "--at", `${at.x},${at.y}`, "--style", style, "--title", title];
  if (size) args.push("--size", `${size.width}x${size.height}`);
  execFileSync("isocan",
    args,
    { encoding: "utf8", env: { ...process.env, ISOCAN_SESSION_ID: "roadmap-sync", ISOCAN_HARNESS: "cron" } },
  );
}

/**
 * The card that says what this canvas is, and which commit it was read at — a
 * reading that cannot name its commit is a reading nobody can check
 * (design.md). Generated, so it is regenerated and never edited into
 * disagreement: the counts and the age come from the same read the cards did.
 */
export function legendText(rows, head, committed) {
  const sections = [];
  for (const row of rows) if (!sections.includes(row.section)) sections.push(row.section);
  const counts = sections
    .map((s) => `- ${s} — ${rows.filter((r) => r.section === s).length}`)
    .join("\n");
  return [
    "# Start here",
    "",
    `**dglazkov/isocan** · \`docs/ROADMAP.md\` · read at \`${head.slice(0, 8)}\` · committed ${committed}`,
    "",
    `${rows.length} documents, one card each, in the sheet for the status its own front matter records:`,
    "",
    counts,
    "",
    "The record is each document's front matter — `node scripts/roadmap.mjs` derives the",
    "table this mirrors — and `~/isocan-roadmap/sync.mjs` re-reads `origin/main` every 15",
    "minutes. The big labels beside the sheets are furniture; **this card is generated:**",
    "say what belongs here in the repository, not on it.",
    "",
  ].join("\n");
}

async function main() {
  git("fetch", "origin", "main", "--quiet");
  const head = git("rev-parse", "origin/main");
  const manifest = existsSync(MANIFEST)
    ? JSON.parse(readFileSync(MANIFEST, "utf8"))
    : { commit: null, roadmap: {}, items: {} };

  const rows = parseRoadmap(show("origin/main:docs/ROADMAP.md"));
  const shas = new Map(rows.map((r) => [r.path, git("rev-parse", `origin/main:${r.path}`)]));
  const roadmapSha = git("rev-parse", "origin/main:docs/ROADMAP.md");
  const changed = rows.filter((r) => manifest.items[r.path]?.sha !== shas.get(r.path));
  const roadmapChanged = manifest.roadmap?.sha !== roadmapSha;
  // No early exit on "nothing changed": the body below writes only what differs,
  // so a quiet run is cheap anyway — and a card deleted from the canvas is
  // re-read rather than skipped because the manifest still remembers it.

  const { connect } = await import("isocan");
  const home = await connect({ identity: { session: "roadmap-sync", harness: "cron" } });
  const canvas = await home.canvas(CANVAS);
  const items = await canvas.items();
  const byId = new Map(items.map((i) => [i.id, i]));
  const areas = new Map(items.filter(isArea).map((a) => [a.title, a]));

  // How much each sheet already holds — membership is the centre being inside.
  const held = new Map([...areas.keys()].map((t) => [t, 0]));
  for (const item of items) {
    if (isArea(item)) continue;
    const cx = item.x + item.width / 2, cy = item.y + item.height / 2;
    for (const a of areas.values()) {
      if (cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height) {
        held.set(a.title, held.get(a.title) + 1);
      }
    }
  }

  // The roadmap document itself, and the card that says what this is.
  if (roadmapChanged) {
    const content = show("origin/main:docs/ROADMAP.md");
    const properties = { upstream: "docs/ROADMAP.md", commit: head, synced: new Date().toISOString() };
    if (manifest.roadmap?.item && byId.has(manifest.roadmap.item)) {
      await canvas.edit(manifest.roadmap.item, { content, mime: "text/markdown" });
      await canvas.set(manifest.roadmap.item, { properties });
      log(`updated docs/ROADMAP.md → ${manifest.roadmap.item}`);
    } else {
      // A fresh canvas: the header card sits above the first sheet, not left of everything.
      const first = [...areas.values()].sort((a, b) => a.y - b.y)[0];
      const at = first ? { x: first.x + 24, y: Math.max(0, first.y - 700) } : undefined;
      const scratch = mkdtempSync(join(tmpdir(), "roadmap-sync-"));
      const file = join(scratch, "ROADMAP.md");
      writeFileSync(file, content);
      const itemId = addViaCli(CANVAS, file, null, "ROADMAP.md", "docs/ROADMAP.md", head, at, { width: 615, height: 641 });
      manifest.roadmap = { item: itemId };
      log(`added docs/ROADMAP.md → ${itemId}`);
    }
    manifest.roadmap.sha = roadmapSha;
  }

  const legend = legendText(rows, head, git("show", "-s", "--format=%cI", "origin/main"));
  if (manifest.legend?.text !== legend || !byId.has(manifest.legend?.item)) {
    if (manifest.legend?.item && byId.has(manifest.legend.item)) {
      await canvas.edit(manifest.legend.item, { content: legend, mime: "text/markdown" });
      log(`updated the legend → ${manifest.legend.item}`);
    } else {
      const first = [...areas.values()].sort((a, b) => a.y - b.y)[0];
      const at = first ? { x: first.x + 860, y: Math.max(0, first.y - 800) } : { x: 0, y: 0 };
      textViaCli(CANVAS, legend, { at, style: "heading", title: "Start here", size: { width: 1100, height: 780 } });
      const written = (await canvas.items()).find((i) => i.title === "Start here");
      if (!written) throw new Error("the legend was written but is not on the canvas");
      manifest.legend = { item: written.id, text: legend };
      log(`added the legend → ${written.id}`);
    }
    manifest.legend = { ...manifest.legend, text: legend };
  }

  for (const row of changed) {
    const sha = shas.get(row.path);
    const content = show(`origin/main:${row.path}`);
    const known = manifest.items[row.path];
    if (known?.item && byId.has(known.item)) {
      await canvas.edit(known.item, { content, mime: "text/markdown" });
      await canvas.set(known.item, { properties: { upstream: row.path, commit: head } });
      manifest.items[row.path] = { item: known.item, sha };
      log(`updated ${row.path} → ${known.item}`);
      continue;
    }
    const area = areas.get(row.section);
    if (!area) throw new Error(`no sheet called "${row.section}" for ${row.path}`);
    const scratch = mkdtempSync(join(tmpdir(), "roadmap-sync-"));
    const file = join(scratch, basename(row.path));
    writeFileSync(file, content);
    const itemId = addViaCli(CANVAS, file, row.section, row.title, row.path, head);
    manifest.items[row.path] = { item: itemId, sha };
    log(`added ${row.path} → ${itemId} in "${row.section}"`);
    const count = (held.get(row.section) ?? 0) + 1;
    held.set(row.section, count);
    const needed = grownHeight(area, count);
    if (needed > area.height) await canvas.set(area.id, { size: { width: area.width, height: needed } });
  }

  manifest.commit = head;
  const tmp = `${MANIFEST}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 1) + "\n");
  renameSync(tmp, MANIFEST);
  log(`synced ${head.slice(0, 8)} — ${rows.length} documents tracked, ${changed.length} changed`);
}

function selftest() {
  const md = [
    "# Roadmap", "",
    "## Partly built <sub>2</sub>", "",
    "| | What | Since | |", "| --- | --- | --- | --- |",
    "| research | [Alpha](docs/research/a.md) | 2026-01-01 | note |",
    "| **project** | [Beta](projects/b/design.md) | 2026-01-02 | note |",
    "| research | [Not a file](https://github.com/x/y/issues/1) | 2026-01-03 | |",
    "", "## Built <sub>1</sub>", "",
    "| research | [Gamma](docs/research/c.md) | 2026-01-04 | note |",
  ].join("\n");
  const rows = parseRoadmap(md);
  console.assert(rows.length === 3, "parses three documents", rows.length);
  console.assert(rows[0].path === "docs/research/a.md", "docs/ kept", rows[0]);
  console.assert(rows[1].path === "docs/projects/b/design.md", "relative resolved", rows[1]);
  console.assert(rows[2].section === "Built" && rows[2].path === "docs/research/c.md", "section follows the heading");

  const card = { width: 360, height: 260 };
  const area = { title: "S", x: 0, y: 0, width: 1640, height: 500 };
  console.assert(grownHeight(area, 4, card) === 500, "four cards fit a 1640 sheet", grownHeight(area, 4, card));
  console.assert(grownHeight(area, 8, card) > 500, "the ninth row grows the sheet", grownHeight(area, 9, card));
  console.assert(grownHeight({ ...area, width: 500 }, 2, card) > 500, "a narrow sheet grows sooner");

  const legend = legendText(
    [
      { section: "Partly built", path: "a" }, { section: "Partly built", path: "b" },
      { section: "Built", path: "c" },
    ],
    "434c9198b4f0e6bed2fc118dc8a6f5214832e7fa",
    "2026-09-10T22:04:00Z",
  );
  console.assert(legend.includes("- Partly built — 2"), "counts per section, in order", legend);
  console.assert(legend.indexOf("Partly built") < legend.indexOf("Built — 1"), "the file's section order holds");
  console.assert(legend.includes("read at `434c9198`"), "the short commit is named", legend);
  console.log("selftest ok");
}

if (process.argv.includes("--selftest")) selftest();
else
  main().catch((err) => {
    console.error(new Date().toISOString(), `sync failed: ${err?.message ?? err}`);
    process.exit(1);
  });
