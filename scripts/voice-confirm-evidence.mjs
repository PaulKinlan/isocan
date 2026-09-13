#!/usr/bin/env node
/**
 * **The person's gate, clicked in a real browser** — the evidence the
 * functional-verification rule asks for, for the half that only a browser can
 * prove.
 *
 * A gate held in JavaScript is not a gate: the question has to be ON the page,
 * the buttons have to be real, and a click on one has to be what opens it.
 * Nothing below the page can say that — a test that POSTs `/confirm` proves the
 * door, not the button — so this drives a real Chrome at the real
 * `isocan voice` page and clicks.
 *
 * What it does, in order, and why each step is not optional:
 *
 * 1. A throwaway home and daemon, so nothing here touches anybody's canvas.
 * 2. A canvas with two items, seeded through the door a browser uses.
 * 3. The REAL `isocan voice` verb, spawned the way a person spawns it.
 * 4. A real Chrome at the page it printed, typing the same sentence twice:
 *    once answered **No** (and the item is still there, and the oplog has no
 *    delete), once answered **Yes** (and the item is gone, and the oplog has
 *    one).
 * 5. Photographs of the question standing, and of both answers.
 *
 * What is deliberately not proven here, and is proven in
 * `packages/cli/test/voice-harness.test.ts` instead: that a tool call blocks
 * until the answer (a fake provider socket drives the live path there), and
 * that the page's canvas label follows a switch (that needs a live session,
 * and therefore a key and a spend).
 *
 *   node scripts/voice-confirm-evidence.mjs [--out <dir>]
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";
import { browser, until } from "./lib/browser.mjs";

// The bin's own trick: register tsx so the workspace's TypeScript sources
// import directly (a static import would resolve before this runs).
register();
const { startDaemon } = await import("@isocan/server");

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "packages", "cli", "bin", "isocan.js");
const outArg = process.argv.indexOf("--out");
const outDir = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : path.join(repo, "reports", "voice-harness", "confirm-gate");
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const begun = Date.now();
const steps = [];
const step = (line) => {
  steps.push(line);
  console.log(`  ${line}`);
};

const home = mkdtempSync(path.join(os.tmpdir(), "isocan-voice-confirm-"));
writeFileSync(
  path.join(home, "identity.json"),
  JSON.stringify({ id: "usr_person", name: "Person", createdAt: new Date().toISOString() }),
);
const daemon = await startDaemon({ port: 0, home });
const daemonPort = daemon.app.server.address().port;
const base = `http://127.0.0.1:${daemonPort}`;

const { mintTestBadge } = await import(path.join(repo, "packages", "cli", "test", "badge.ts"));
const badge = await mintTestBadge(base);
const person = { id: "usr_person", name: "Person" };
await badge.speakAs(person);
const op = async (canvasId, body) =>
  (await fetch(`${base}/api/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...badge.headers },
    body: JSON.stringify({ canvasId, actor: person, op: body }),
  })).json();

await op(null, { type: "project.create", canvasId: "prj_voice", title: "Voice evidence" });
for (const [id, title, x, y] of [
  ["itm_checkout", "Checkout screen", 100, 100],
  ["itm_settings", "Settings screen", 520, 100],
]) {
  await op("prj_voice", {
    type: "item.add",
    itemId: id,
    version: { id: `ver_${id}`, blobHash: `h_${id}`, mimeType: "text/markdown", filename: `${id}.md`, size: 3 },
    width: 320,
    height: 240,
    placement: { x, y },
    title,
  });
}

/** The canvas, as the daemon holds it — read through the same door a browser
 * reads it, so "still there" is not the script's own bookkeeping. */
const itemsNow = async () => {
  const r = await fetch(`${base}/api/projects/prj_voice/canvas`, { headers: badge.headers });
  return Object.values(((await r.json()).canvas?.items ?? {})).map((i) => i.title);
};
const oplogNow = async () => {
  const r = await fetch(`${base}/api/oplog/watch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...badge.headers },
    body: JSON.stringify({ cursors: { prj_voice: 0 }, only: ["prj_voice"], waitMs: 0 }),
  });
  return ((await r.json()).entries ?? []).map((e) => e.envelope.op.type);
};

const voicePort = 7654 + Math.floor(Math.random() * 400);
const child = spawn(process.execPath, [cli, "voice", "--voice-port", String(voicePort), "--canvas", "prj_voice"], {
  cwd: repo,
  env: { ...process.env, ISOCAN_HOME: home, ISOCAN_PORT: String(daemonPort), ISOCAN_SESSION_ID: "Voice", ISOCAN_HARNESS: "agent" },
  stdio: ["ignore", "pipe", "pipe"],
});
let voiceOut = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => (voiceOut += d));
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => (voiceOut += d));
const url = `http://127.0.0.1:${voicePort}/`;
{
  const deadline = Date.now() + 30_000;
  while (!voiceOut.includes(url) && Date.now() < deadline) await sleep(100);
  if (!voiceOut.includes(url)) throw new Error(`the harness never said it was listening:\n${voiceOut}`);
}
step(`harness: \`isocan voice\` listening at ${url} (daemon on ${daemonPort}, home ${path.basename(home)})`);

const b = await browser({ flags: ["--window-size=1440,900"] });
const shot = async (name) => {
  const { data } = await b.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, "base64"));
};

/** Type a sentence into the page's own box and press its own Send — the same
 * gesture a person makes, not a fetch. */
async function typeSentence(text) {
  await b.ev(`(() => { const el = document.getElementById("typed"); el.focus(); el.value = ${JSON.stringify(text)}; })()`);
  await b.ev(`document.getElementById("send").click()`);
}

/** The question, as the page shows it — read off the DOM the person reads. */
const questionOnPage = () =>
  b.ev(`(() => { const el = document.getElementById("confirm"); return el.hidden ? null : document.getElementById("confirm-what").textContent; })()`);

const clickAnswer = (which) => b.ev(`document.getElementById("confirm-${which}").click()`);

const evidence = [];
try {
  const loaded = b.once("Page.loadEventFired");
  await b.send("Page.navigate", { url });
  await loaded;
  await until(b, `!!document.getElementById("confirm")`, "the page to paint its question bar");

  const connection = await (await fetch(`${url}connection`)).json();
  step(`page: canvas “${connection.canvas.title}” ${connection.canvas.id} · agent ${connection.agent.name} ${connection.agent.id} · ${connection.provider.name ?? "no provider"}${connection.provider.key ? "" : " (no key — the typed path)"}`);
  const itemsBefore = await itemsNow();
  step(`canvas before: ${itemsBefore.join(", ")}`);

  /* ---- the question, answered NO ---- */
  await typeSentence("delete the Checkout screen");
  await until(b, `!document.getElementById("confirm").hidden`, "the question to appear on the page");
  const askedNo = await questionOnPage();
  await shot("01-question-standing");
  expect(askedNo !== null && askedNo.includes("Checkout screen"), `the page asks about the item: ${JSON.stringify(askedNo)}`);
  const stillThere = await itemsNow();
  expect(stillThere.includes("Checkout screen"), "asking is not doing: the item is still on the canvas");
  expect(!(await oplogNow()).includes("item.delete"), "no delete op while the question stands");
  step(`asked on the page: “${askedNo}” — and the canvas is untouched (${stillThere.join(", ")})`);

  await clickAnswer("no");
  await until(b, `document.getElementById("confirm").hidden`, "the question to close");
  await sleep(150);
  await shot("02-answered-no");
  expect((await itemsNow()).includes("Checkout screen"), "the no left the item alone");
  expect(!(await oplogNow()).includes("item.delete"), "the no minted no operation");
  const afterNo = { items: await itemsNow(), ops: await oplogNow() };
  step("clicked No: the bar closed, the item is still there, and the oplog has no delete");

  /* ---- the same sentence, answered YES ---- */
  await typeSentence("delete the Checkout screen");
  await until(b, `!document.getElementById("confirm").hidden`, "the question to appear again");
  const askedYes = await questionOnPage();
  await until(b, `document.getElementById("confirm-yes") === document.activeElement`, "the focus the question takes when it opens");
  step(`asked again: “${askedYes}” — and the live answer button HAS focus (${await b.ev(`document.activeElement.id`)}), so a keyboard can answer it`);
  await clickAnswer("yes");
  await until(b, `document.getElementById("confirm").hidden`, "the question to close");
  {
    const deadline = Date.now() + 5000;
    while (!(await oplogNow()).includes("item.delete") && Date.now() < deadline) await sleep(50);
  }
  await shot("03-answered-yes");
  const after = await itemsNow();
  const ops = await oplogNow();
  expect(!after.includes("Checkout screen"), `the yes deleted it — canvas now: ${after.join(", ")}`);
  expect(ops.includes("item.delete"), "the yes minted the operation");
  step(`clicked Yes: the item is gone (${after.join(", ")}) and the oplog ends ${ops.slice(-3).join(" → ")}`);

  /* The harness's own record: the question, both answers, and who answered. */
  const log = (await (await fetch(`${url}log`)).json()).entries;
  const kinds = log.filter((e) => e.details?.kind?.startsWith("confirm_")).map((e) => e.details.kind);
  expect(kinds.includes("confirm_requested"), "the ask is in the harness's log");
  expect(kinds.includes("confirm_declined") && kinds.includes("confirm_allowed"), `both answers are in the log: ${kinds.join(", ")}`);
  step(`harness /log: ${kinds.join(", ")}`);

  evidence.push({
    asked: askedNo,
    answeredNo: afterNo,
    askedAgain: askedYes,
    answeredYes: { items: after, ops },
  });
} catch (err) {
  console.error(`\n  FAILED: ${err.message}\n`);
  for (const line of b.takeErrors()) console.error(`  page error: ${line}`);
  await b.close().catch(() => {});
  child.kill("SIGTERM");
  await daemon.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  process.exit(1);
}

function expect(ok, what) {
  if (!ok) throw new Error(what);
  step(`✓ ${what}`);
}

writeFileSync(
  path.join(outDir, "evidence.json"),
  `${JSON.stringify({ at: new Date().toISOString(), seconds: (Date.now() - begun) / 1000, url, steps, evidence }, null, 2)}\n`,
);
writeFileSync(
  path.join(outDir, "evidence.md"),
  `# The person's gate, clicked in a real browser\n\n${steps.map((s) => `- ${s}`).join("\n")}\n\n` +
    `Screenshots: 01-question-standing.png, 02-answered-no.png, 03-answered-yes.png.\n` +
    `Raw: evidence.json. Run: \`node scripts/voice-confirm-evidence.mjs\`.\n`,
);
console.log(`\n  ${steps.length} steps, ${((Date.now() - begun) / 1000).toFixed(1)}s — evidence in ${path.relative(repo, outDir)}`);
await b.close().catch(() => {});
child.kill("SIGTERM");
await daemon.close();
rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
