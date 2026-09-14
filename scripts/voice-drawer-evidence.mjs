#!/usr/bin/env node
/**
 * **The settings drawer, driven: a person claims a name from the page.**
 *
 * This is the walk Paul was trying to do when the harness answered 405: open
 * the voice page, open the settings drawer, type a name, press *Claim this
 * name*. The page's half has been there since `isocan-xsh.8` froze the
 * contract — `POST /actor`, `GET /daemons`, `GET /canvases`, `POST /canvas`,
 * `POST /enrol` — and a build that answers none of them tells the person so in
 * as many words ("this harness build does not offer /actor yet — the command
 * above does it by hand"). That message is honest and it is useless: the
 * capability existed for the model and not for the person.
 *
 * What is real here: the shipped `isocan voice` verb, the real page from
 * `packages/voice-agent` served by that package's own Vite config (wrapped, not
 * copied — see the temp config below), a real Chrome, a real click, the real
 * settings drawer, and a real daemon underneath. What is synthetic: nothing, except
 * that the home is a throwaway directory so a run cannot touch anybody's work.
 *
 *   node scripts/voice-drawer-evidence.mjs [--out <dir>]
 *
 * Ports: the harness and the page are both on free ports and the Vite proxy is
 * wrapped to point at this run's harness, because the committed proxy points at
 * 7654 — where somebody's real microphone may be standing, and this script must
 * not disturb it.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";
import { browser, until } from "./lib/browser.mjs";

register();
const { startDaemon } = await import("@isocan/server");

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "packages", "cli", "bin", "isocan.js");
const outArg = process.argv.indexOf("--out");
const outDir = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : path.join(repo, "reports", "voice-harness", "drawer-claim");
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const begun = Date.now();
const steps = [];
const step = (line) => {
  steps.push(line);
  console.log(`  ${line}`);
};
function expect(ok, what) {
  if (!ok) throw new Error(what);
  step(`✓ ${what}`);
}

const home = mkdtempSync(path.join(os.tmpdir(), "isocan-voice-drawer-"));
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
/** The fixture's own actor, NOT the person: one actor may be claimed by one
 * surface at a time, and the CLI's badge has to be free to claim the person
 * itself (which is what makes `rc add` able to enrol anything). */
const seeder = { id: "usr_seeder", name: "Seeder" };
await badge.speakAs(seeder);
const op = async (canvasId, body) =>
  (await fetch(`${base}/api/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...badge.headers },
    body: JSON.stringify({ canvasId, actor: seeder, op: body }),
  })).json();

await op(null, { type: "project.create", canvasId: "prj_voice", title: "Voice evidence" });
await op(null, { type: "project.create", canvasId: "prj_launch", title: "Launch plan" });
const canvasNames = async () => {
  const r = await fetch(`${base}/api/projects/prj_voice/canvas`, { headers: badge.headers });
  return (await r.json()).names ?? {};
};

const rosterNow = async () =>
  JSON.parse(await (await import("node:fs/promises")).readFile(path.join(home, "rc-agents.json"), "utf8").catch(() => "[]"));
step(`before: roster row ${JSON.stringify((await rosterNow()).map((r) => r.name))}`);

/* The harness, on a free port — never 7654, which may be somebody's. */
const voicePort = 7800 + Math.floor(Math.random() * 400);
const voice = spawn(process.execPath, [cli, "voice", "--voice-port", String(voicePort), "--canvas", "prj_voice"], {
  cwd: home,
  env: { ...process.env, ISOCAN_HOME: home, ISOCAN_PORT: String(daemonPort), ISOCAN_SESSION_ID: "Voice", ISOCAN_HARNESS: "agent" },
  stdio: ["ignore", "pipe", "pipe"],
});
let voiceSaid = "";
voice.stdout.setEncoding("utf8");
voice.stdout.on("data", (d) => (voiceSaid += d));
voice.stderr.setEncoding("utf8");
voice.stderr.on("data", (d) => (voiceSaid += d));
const harnessUrl = `http://127.0.0.1:${voicePort}/`;
{
  const deadline = Date.now() + 30_000;
  while (!voiceSaid.includes(`talk at ${harnessUrl}`) && Date.now() < deadline) await sleep(100);
  if (!voiceSaid.includes(`talk at ${harnessUrl}`)) throw new Error(`the harness never said it was listening:\n${voiceSaid}`);
}
step(`harness: \`isocan voice\` listening at ${harnessUrl} (daemon ${daemonPort}, home ${path.basename(home)})`);

const facts0 = (await (await fetch(`${harnessUrl}connection`)).json());
step(`before: actor “${facts0.agent.name}” ${facts0.agent.id}, canvas “${facts0.canvas.title}” ${facts0.canvas.id}, enrolled ${facts0.agent.enrolled}`);

/* The page, from this repo's own Vite config, wrapped so that /harness points
   at THIS run's harness and the page gets a free port. Not a copy of the
   config and not a second proxy: the plugin list, the voice entry and the
   rewrite rule all stay hers. */
const pagePort = 5399 + Math.floor(Math.random() * 400);
const cfgPath = path.join(os.tmpdir(), `isocan-voice-drawer-${process.pid}.vite.config.ts`);
writeFileSync(
  cfgPath,
  `import base from ${JSON.stringify(path.join(repo, "packages/voice-agent/vite.config.ts"))};\n` +
    `const wrap = async (env) => {\n` +
    `  const resolved = typeof base === "function" ? await base(env) : { ...base };\n` +
    `  resolved.root = ${JSON.stringify(path.join(repo, "packages/voice-agent"))};\n` +
    `  resolved.server = {\n` +
    `    ...(resolved.server ?? {}),\n` +
    `    port: ${pagePort},\n` +
    `    host: "127.0.0.1",\n` +
    `    proxy: {\n` +
    `      ...((resolved.server ?? {}).proxy ?? {}),\n` +
    `      "/harness": {\n` +
    `        target: ${JSON.stringify(harnessUrl)},\n` +
    `        changeOrigin: true,\n` +
    `        ws: true,\n` +
    `        rewrite: (p) => p.replace(/^\\/harness/, ""),\n` +
    `      },\n` +
    `    },\n` +
    `  };\n` +
    `  return resolved;\n` +
    `};\n` +
    `export default wrap;\n`,
);
const vite = spawn(path.join(repo, "node_modules", ".bin", "vite"), ["--config", cfgPath, "--strictPort"], {
  cwd: repo,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteSaid = "";
vite.stdout.setEncoding("utf8");
vite.stdout.on("data", (d) => (viteSaid += d));
vite.stderr.setEncoding("utf8");
vite.stderr.on("data", (d) => (viteSaid += d));
const pageUrl = `http://127.0.0.1:${pagePort}/voice`;
{
  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    up = await fetch(pageUrl).then((r) => r.ok).catch(() => false);
    if (!up) await sleep(200);
  }
  if (!up) throw new Error(`the page never came up on ${pageUrl}:\n${viteSaid.slice(-1500)}`);
}
step(`page: ${pageUrl} (Vite serving packages/voice-agent, /harness → this run's harness)`);

const b = await browser({ flags: ["--window-size=1440,1000"] });
const shot = async (name) => {
  const { data } = await b.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, "base64"));
};

const evidence = {};
try {
  const loaded = b.once("Page.loadEventFired");
  await b.send("Page.navigate", { url: pageUrl });
  await loaded;
  await until(b, `!!document.getElementById("settings-open")`, "the page to paint its settings button");

  // 1. The drawer, opened the way a person opens it.
  await b.ev(`document.getElementById("settings-open").click()`);
  await until(b, `document.getElementById("settings").open === true`, "the drawer to open");
  const opened = await b.ev(`(() => {
    const dialog = document.getElementById("settings");
    const actor = document.getElementById("actor-name").textContent;
    const setup = document.getElementById("setup");
    const steps = [...document.querySelectorAll("#setup-steps li")].map((li) => li.textContent.replace(/\\s+/g, " ").trim());
    const input = !!document.querySelector('#setup-steps input[aria-label="actor name"]');
    const button = [...document.querySelectorAll("#setup-steps button")].some((x) => x.textContent.trim() === "Claim this name");
    return { open: dialog.open, actor, setupHidden: setup.hidden, steps, input, button };
  })()`);
  evidence.drawerBefore = opened;
  await shot("01-drawer-open");
  expect(opened.open === true, "the settings drawer is open");
  expect(opened.input && opened.button, "the drawer offers a name field and a “Claim this name” button — the harness answered the contract");
  expect(
    !opened.steps.some((s) => s.includes("does not offer")),
    `nothing in the drawer says the build cannot do it: ${JSON.stringify(opened.steps)}`,
  );
  step(`drawer: actor “${opened.actor}”, ${opened.steps.length} setup step(s), the claim control present`);

  /* ---- the enrolment, from the same drawer ---- */
  const enrolStep = opened.steps.find((line) => line.startsWith("Not enrolled"));
  expect(Boolean(enrolStep), `the drawer says what is missing and offers the fix: ${JSON.stringify(enrolStep)}`);
  await b.ev(
    `(() => { const b = [...document.querySelectorAll("#setup-steps button")].find((x) => x.textContent.trim() === "Enrol from here"); b.click(); return true; })()`,
  );
  await until(
    b,
    `!document.querySelector("#actor-standing") || document.getElementById("actor-standing").hidden || !document.getElementById("actor-standing").textContent.includes("not enrolled")`,
    "the drawer's enrolment line to stop saying it is not enrolled",
  );
  const enrolledFacts = await (await fetch(`${harnessUrl}connection`)).json();
  evidence.enrolled = enrolledFacts.agent;
  const enrolledRoster = await rosterNow();
  evidence.rosterAfterEnrol = enrolledRoster;
  expect(enrolledFacts.agent.enrolled === true, "the harness says it is enrolled, from the page alone");
  expect(
    enrolledRoster.some((r) => r.actorId === enrolledFacts.agent.id && r.harness === "voice"),
    `the machine's rc half is there: ${JSON.stringify(enrolledRoster.map((r) => ({ name: r.name, harness: r.harness })))}`,
  );
  await shot("01b-enrolled");
  step("enrolled from the drawer — no CLI, no config edit");

  /* ---- the daemon, which this harness cannot change while it runs ---- */
  await b.ev(
    `(() => {
      const field = document.getElementById("daemon-field");
      field.value = "http://127.0.0.1:9999";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("daemon-use").click();
      return true;
    })()`,
  );
  await until(
    b,
    `document.getElementById("daemon-note").textContent.includes("refused")`,
    "the drawer to show the harness's refusal",
  );
  const daemonNote = await b.ev(`document.getElementById("daemon-note").textContent.trim()`);
  evidence.daemonRefusal = daemonNote;
  expect(daemonNote.includes("refused"), `the drawer says the harness refused: ${JSON.stringify(daemonNote)}`);
  expect(
    !daemonNote.includes("does not offer"),
    "and it is the harness's own refusal, not a build that cannot answer",
  );
  const daemons = await (await fetch(`${harnessUrl}daemons`)).json();
  evidence.daemons = daemons;
  expect(
    daemons.found.length === 1 && daemons.found[0].url === facts0.daemon,
    `GET /daemons names the one it is on: ${JSON.stringify(daemons.found?.map((d) => d.url))}`,
  );
  await shot("01c-daemon-refused");
  step(`daemon: the harness refused the move and named the remedy — ${daemonNote.slice(0, 140)}`);

  // 2. Type a name and press the button — no CLI, no config.
  await b.ev(`(() => {
    const input = document.querySelector('#setup-steps input[aria-label="actor name"]');
    input.value = "Nova";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await shot("02-name-typed");
  const claimButton = await b.ev(
    `(() => { const b = [...document.querySelectorAll("#setup-steps button")].find((x) => x.textContent.trim() === "Claim this name"); b.click(); return true; })()`,
  );
  expect(claimButton === true, "the person pressed “Claim this name”");

  await until(b, `document.getElementById("actor-name").textContent.trim() === "Nova"`, "the drawer to show the new name");
  const after = await b.ev(`(() => ({
    actor: document.getElementById("actor-name").textContent.trim(),
    id: document.getElementById("actor-id").textContent.trim(),
    complaint: document.getElementById("complaint").hidden ? null : document.getElementById("complaint").textContent.trim(),
    log: [...document.querySelectorAll("#log li")].map((li) => li.textContent.replace(/\\s+/g, " ").trim()).slice(0, 4),
  }))()`);
  evidence.drawerAfter = after;
  await shot("03-claimed");

  const facts = await (await fetch(`${harnessUrl}connection`)).json();
  evidence.facts = facts;
  expect(after.id !== "" && after.id === facts.agent.id, `the drawer's actor id is the harness's: ${after.id}`);
  expect(after.complaint === null, "no complaint is standing on the page");
  const claimedLine = after.log.find((line) => line.includes("/actor:"));
  expect(Boolean(claimedLine), `the page's own log says what it posted and what came back: ${JSON.stringify(claimedLine)}`);
  expect(/\{"ok":true/.test(claimedLine ?? ""), "and the harness answered ok");
  step(`page log: ${claimedLine}`);
  expect(facts.agent.name === "Nova", `the harness's own account of itself is “${facts.agent.name}”`);
  expect(facts.agent.id === facts0.agent.id, "the same actor id — a rename, not a second agent");

  const names = await canvasNames();
  evidence.canvasNames = names;
  expect(names[facts.agent.id] === "Nova", `the canvas calls that actor “${names[facts.agent.id]}”`);

  const roster = await rosterNow();
  evidence.roster = roster;
  expect(
    roster.every((r) => r.actorId !== facts.agent.id || r.name === "Nova") && roster.length > 0,
    `the machine's enrolment row moved with it: ${JSON.stringify(roster.map((r) => r.name))}`,
  );
  const snap = await (await fetch(`${base}/api/projects/prj_voice/canvas`, { headers: badge.headers })).json();
  const standing = Object.values(snap.canvas.agents ?? {}).find((a) => a.actor.id === facts.agent.id);
  evidence.standing = standing;
  expect(standing?.actor?.name === "Nova", `the canvas's own enrolment record says “${standing?.actor?.name}”`);

  /* ---- the project picker, in the same drawer ---- */
  const picker = await b.ev(`(() => {
    const select = [...document.querySelectorAll("#setup-steps select")].find((s) => s.getAttribute("aria-label") === "Canvas");
    if (!select) return null;
    return { options: [...select.options].map((o) => ({ value: o.value, text: o.textContent })), chosen: select.value };
  })()`);
  evidence.canvasPicker = picker;
  expect(picker !== null, `the drawer offers a canvas picker: ${JSON.stringify(picker?.options)}`);
  expect(
    picker.options.some((o) => o.text === "Launch plan"),
    "the picker lists the canvases the harness knows (GET /canvases)",
  );
  await b.ev(`(() => {
    const select = [...document.querySelectorAll("#setup-steps select")].find((s) => s.getAttribute("aria-label") === "Canvas");
    select.value = ${JSON.stringify("prj_launch")};
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await b.ev(`(() => { const b = [...document.querySelectorAll("#setup-steps button")].find((x) => x.textContent.trim() === "Use this canvas"); b.click(); return true; })()`);
  await until(
    b,
    `document.getElementById("canvas-title").textContent.trim() === "Launch plan"`,
    "the drawer's canvas line to follow the move",
  );
  const moved = await (await fetch(`${harnessUrl}state`)).json();
  evidence.canvasAfterSwitch = { state: moved.canvas, names: await canvasNames() };
  expect(moved.canvas.id === "prj_launch", `the session moved to “${moved.canvas.title}” (${moved.canvas.id})`);
  await shot("04-canvas-chosen");
  step(`picker: chose “Launch plan” and the session is on ${moved.canvas.id}`);
} catch (err) {
  console.error(`\n  FAILED: ${err.message}\n`);
  for (const line of b.takeErrors()) console.error(`  page error: ${line}`);
  await b.close().catch(() => {});
  vite.kill("SIGTERM");
  voice.kill("SIGTERM");
  await daemon.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(cfgPath, { force: true });
  process.exit(1);
}

/* The state file, the roster and a harness that did not exist at the rename —
   the same three the unit tests read, read here from outside. */
const state = await (await fetch(`${harnessUrl}state`)).json();
evidence.state = { name: state.name, agent: state.agent, canvas: state.canvas };
expect(state.name === "Nova" && state.agent.id === evidence.facts.agent.id, `/state agrees: “${state.name}” ${state.agent.id}`);

const freshPort = 8300 + Math.floor(Math.random() * 300);
// The canvas the session is on is named explicitly — a restart with no
// `--canvas` in a home holding several is the OTHER refusal, and this walk is
// about the name, not about binding.
const fresh = spawn(process.execPath, [cli, "voice", "--voice-port", String(freshPort), "--canvas", "prj_launch"], {
  // NOT the repo: this checkout is bound to isocan's own canvas, which does not
  // exist in a throwaway home — the same refusal any stranger would meet, and
  // beside the point of this walk.
  cwd: home,
  env: { ...process.env, ISOCAN_HOME: home, ISOCAN_PORT: String(daemonPort), ISOCAN_SESSION_ID: "Voice", ISOCAN_HARNESS: "agent" },
  stdio: ["ignore", "pipe", "pipe"],
});
let freshSaid = "";
fresh.stdout.setEncoding("utf8");
fresh.stdout.on("data", (d) => (freshSaid += d));
fresh.stderr.setEncoding("utf8");
fresh.stderr.on("data", (d) => (freshSaid += d));
{
  const deadline = Date.now() + 20_000;
  while (!freshSaid.includes(`talk at http://127.0.0.1:${freshPort}/`) && Date.now() < deadline) await sleep(100);
}
const freshUp = freshSaid.includes(`talk at http://127.0.0.1:${freshPort}/`);
if (freshUp) {
  const freshState = await (await fetch(`http://127.0.0.1:${freshPort}/state`)).json();
  evidence.freshStart = { name: freshState.name, agent: freshState.agent, canvas: freshState.canvas, said: freshSaid.slice(-400) };
  expect(
    freshState.name === "Nova" && freshState.agent.id === evidence.facts.agent.id,
    `a harness started AFTER the claim (by the old env name “Voice”) resumes “${freshState.name}” ${freshState.agent.id}`,
  );
} else {
  throw new Error(`a fresh harness did not start:\n${freshSaid.slice(-600)}`);
}
fresh.kill("SIGTERM");

const namesAtEnd = await canvasNames();
expect(
  Object.values(namesAtEnd).filter((n) => n === "Nova" || n === "Voice").length === 1,
  "and the canvas carries one name, not two faces",
);

writeFileSync(
  path.join(outDir, "evidence.json"),
  `${JSON.stringify({ at: new Date().toISOString(), seconds: (Date.now() - begun) / 1000, pageUrl, harnessUrl, steps, evidence }, null, 2)}\n`,
);
writeFileSync(
  path.join(outDir, "evidence.md"),
  `# A name claimed from the settings drawer\n\n` +
    `Page: ${pageUrl} (Vite, this repo's own config, /harness → ${harnessUrl}).\n` +
    `Harness: the shipped \`isocan voice\` verb on a free port, over a throwaway home and daemon.\n\n` +
    `${steps.map((s) => `- ${s}`).join("\n")}\n\n` +
    `Screenshots: 01-drawer-open.png, 02-name-typed.png, 03-claimed.png,\n` +
    `04-canvas-chosen.png.\n` +
    `Raw: evidence.json.\n\n` +
    `Every door in the contract is walked above: enrol, claim, the canvas\n` +
    `picker, and the daemon pair — which answers with the one it is attached to\n` +
    `and refuses the move with the command that does it instead, because a\n` +
    `harness cannot re-attach mid-flight and saying so is more useful than a 405.\n`,
);
console.log(`\n  ${steps.length} steps, ${((Date.now() - begun) / 1000).toFixed(1)}s — evidence in ${path.relative(repo, outDir)}`);

await b.close().catch(() => {});
vite.kill("SIGTERM");
voice.kill("SIGTERM");
fresh.kill("SIGKILL");
await daemon.close();
rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
rmSync(cfgPath, { force: true });
