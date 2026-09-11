#!/usr/bin/env node
/**
 * **The voice harness, driven in a real browser** — the evidence the
 * functional-verification rule asks for, in one command.
 *
 * What it does, and why each step is not optional:
 *
 * 1. A throwaway home and daemon, so nothing here touches anybody's canvas.
 * 2. The REAL `isocan voice` verb, spawned the way a person spawns it, so the
 *    evidence is about the shipped path and not a test double.
 * 3. A REAL Chrome with a synthetic microphone, at the page the harness
 *    printed — clicking the microphone button as a person would.
 * 4. Photographs: the meter lit while capture runs, and the operation the
 *    utterance produced sitting in the log beside the canvas it changed.
 * 5. The capture path that actually ran, read off the page — `<microphone>`,
 *    `<usermedia>` or `getUserMedia` — with the browser version beside it,
 *    because "no element" and "no permission" look the same in a screenshot
 *    and mean opposite things.
 *
 * What it deliberately does NOT do: call a speech provider. No key is stored
 * and no money is spent; the utterance is typed, which takes the same path
 * through the harness that a transcript takes. The provider call is a thin
 * function over a key the harness owns, pinned by unit tests, and it needs
 * Paul's key to run for real.
 *
 *   node scripts/voice-evidence.mjs [--out <dir>]
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "@isocan/server";
import { browser, until } from "./lib/browser.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "packages", "cli", "bin", "isocan.js");
const outIndex = process.argv.indexOf("--out");
const outDir = outIndex > -1 ? path.resolve(process.argv[outIndex + 1]) : path.join(repo, "reports", "voice-harness");
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const begun = Date.now();
const steps = [];
const step = (line) => {
  steps.push(line);
  console.log(`  ${line}`);
};

const home = mkdtempSync(path.join(os.tmpdir(), "isocan-voice-evidence-"));
// The machine has named its person: every CLI command resolves this, and a
// harness is no different from `ls` about needing somebody to be.
writeFileSync(
  path.join(home, "identity.json"),
  JSON.stringify({ id: "usr_person", name: "Person", createdAt: new Date().toISOString() }),
);
const daemon = await startDaemon({ port: 0, home });
const daemonPort = daemon.app.server.address().port;
const base = `http://127.0.0.1:${daemonPort}`;

/* A person, a canvas, and two things to talk about — seeded through the door
   the way a browser does, because this part is furniture, not the subject. */
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

/* The harness, as a person starts it. */
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

/**
 * Press the microphone.
 *
 * When the browser has the declarative element, the element IS the button and
 * a real gesture ON IT is what starts capture — `el.click()` is a script
 * click and does not count. When it does not, the page grew its own button
 * and any click will do. Which one happened is read off the page, not
 * assumed.
 */
async function clickMic(b) {
  const box = await b.ev(`(() => { const el = document.querySelector("#mic-slot > *"); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, tag: el.tagName.toLowerCase() }; })()`);
  if (box.tag === "button") {
    await b.ev(`document.querySelector("#mic-slot > button").click()`);
    return box.tag;
  }
  for (const type of ["mousePressed", "mouseReleased"]) {
    await b.send("Input.dispatchMouseEvent", { type, x: box.x + box.w / 2, y: box.y + box.h / 2, button: "left", clickCount: 1 });
  }
  return box.tag;
}

const b = await browser({
  flags: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const shot = async (name) => {
  const { data } = await b.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(outDir, `${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  return file;
};

try {
  const loaded = b.once("Page.loadEventFired");
  await b.send("Page.navigate", { url });
  await loaded;
  await until(b, `!!document.querySelector("#mic-slot > *")`, "the page to arm its microphone");

  const version = await b.ev(`document.getElementById("version").textContent`);
  const before = await b.ev(`document.getElementById("capture").textContent`);
  const pathBeforeCapture = await b.ev(`document.getElementById("capture").textContent`);
  step(`page: painted — ${version}; ${pathBeforeCapture}`);

  /* The microphone, clicked. The synthetic device is a tone, so a meter that
     moves is the proof that audio actually arrived. */
  await clickMic(b);
  await until(b, `document.getElementById("state").className.includes("live") || document.getElementById("state").className.includes("warn")`, "capture to start or refuse");
  const captureLine = await b.ev(`document.getElementById("capture").textContent`);
  const lit = async () => b.ev(`document.querySelectorAll("#bars i.on").length`);
  let peak = 0;
  for (let i = 0; i < 30; i++) {
    peak = Math.max(peak, await lit());
    await sleep(60);
  }
  const meterShot = await shot("01-meter-live");
  step(`capture: ${captureLine}`);
  step(`meter: peak ${peak}/28 bars lit while capture ran — ${meterShot}`);

  /* Stop: the harness offers the recorded audio to its provider, which has no
     key here and says so rather than failing silently. */
  await b.ev(`document.getElementById("stop").click()`);
  await until(b, `document.querySelectorAll("#transcript .line").length > 0`, "the stop to be acknowledged");
  const stopped = await b.ev(`[...document.querySelectorAll("#transcript .line")].map((l) => l.textContent).join(" | ")`);
  step(`stop: ${stopped.slice(0, 160)}`);
  const audioShot = await shot("02-no-key-stated");

  /* The utterance. Typed, because there is no key — and the same path a
     transcript takes, which is the property being demonstrated. */
  const utterance = "retitle the checkout screen to Checkout v2";
  await b.ev(`(() => { const t = document.getElementById("typed"); t.value = ${JSON.stringify(utterance)}; document.getElementById("send").click(); })()`);
  await until(b, `document.querySelectorAll("#log .line.op").length > 0`, "the operation to be sent");
  const sent = await b.ev(`[...document.querySelectorAll("#log .line.op")].map((l) => l.textContent).join(" | ")`);
  const reply = await b.ev(`[...document.querySelectorAll("#transcript .line.agent")].map((l) => l.textContent).join(" | ")`);
  const opsShot = await shot("03-operation-sent");
  step(`utterance: “${utterance}”`);
  step(`sent: ${sent}`);
  step(`reply: ${reply}`);

  /* The canvas, asked directly: the operation is real, and it is the enrolled
     agent's — not the person's. */
  const snapshot = await (await fetch(`${base}/api/projects/prj_voice/canvas`, { headers: badge.headers })).json();
  const titles = Object.values(snapshot.canvas.items).map((i) => i.title);
  const watch = await (await fetch(`${base}/api/oplog/watch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...badge.headers },
    body: JSON.stringify({ cursors: { prj_voice: 0 }, only: ["prj_voice"], waitMs: 0 }),
  })).json();
  const last = watch.entries.at(-1);
  step(`canvas: titles now ${JSON.stringify(titles)}`);
  step(`canvas: last op ${last.envelope.op.type} by ${snapshot.names[last.envelope.actor.id]} (${last.envelope.actor.id}), ${last.envelope.actor.id === person.id ? "the PERSON" : "the enrolled agent"}`);

  const report = [
    `# Voice harness — browser evidence`,
    ``,
    `Run ${new Date().toISOString()} in ${(Date.now() - begun) / 1000}s.`,
    ``,
    `- browser: ${version}`,
    `- capture path that ran: ${captureLine}`,
    `- meter peak: ${peak}/28 bars`,
    `- utterance: “${utterance}”`,
    `- operations sent: ${sent}`,
    `- canvas titles after: ${JSON.stringify(titles)}`,
    `- last operation: ${last.envelope.op.type} by “${snapshot.names[last.envelope.actor.id]}”`,
    ``,
    `## Steps`,
    ...steps.map((s) => `- ${s}`),
    ``,
    `## Screenshots`,
    `- 01-meter-live.png — capture running, meter lit (${meterShot})`,
    `- 02-no-key-stated.png — the stop, with the harness saying it has no key (${audioShot})`,
    `- 03-operation-sent.png — the operation in the log beside the canvas it changed (${opsShot})`,
  ].join("\n");
  writeFileSync(path.join(outDir, "evidence.md"), `${report}\n`);
  console.log(`\n  evidence written to ${path.join(outDir, "evidence.md")}\n`);
} finally {
  await b.close();
  child.kill("SIGTERM");
  await daemon.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
