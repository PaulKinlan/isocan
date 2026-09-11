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
  // Bring it into view first: a click at coordinates outside the viewport is
  // not a gesture, and the element needs a real gesture.
  await b.ev(`document.querySelector("#mic-slot > *").scrollIntoView({ block: "center" })`);
  await sleep(250);
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
  flags: [
    // A real window: a declarative capture element that is off the bottom of a
    // 600px headless viewport cannot be clicked at all, and a screenshot of
    // half a page is not evidence of a layout.
    "--window-size=1440,900",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
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

  const connection = await (await fetch(`${url}connection`)).json();
  step(`connected to: canvas “${connection.canvas.title}” ${connection.canvas.id} · daemon ${connection.daemon} · home ${connection.home} · agent ${connection.agent.name} ${connection.agent.id}${connection.agent.enrolled ? " (enrolled)" : " (not enrolled)"} · audio ${connection.provider.name ?? "no provider"} ${connection.provider.model}${connection.provider.key ? "" : ", no key"}`);
  const version = await b.ev(`document.getElementById("version").textContent`);
  const before = await b.ev(`document.getElementById("capture").textContent`);
  const pathBeforeCapture = await b.ev(`document.getElementById("capture").textContent`);
  step(`page: painted — ${version}; ${pathBeforeCapture}`);

  /* The microphone, clicked. The synthetic device is a tone, so a meter that
     moves is the proof that audio actually arrived. */
  await clickMic(b);
  try {
    await until(b, `document.getElementById("state").className.includes("live") || document.getElementById("state").className.includes("warn")`, "capture to start or refuse");
  } catch (err) {
    // Say what the page says and what it threw, rather than only that it
    // timed out: a capture that never starts has a reason and the page has it.
    step(`capture did not start — page state ${JSON.stringify(await b.ev(`document.getElementById("state").textContent`))}, capture line ${JSON.stringify(await b.ev(`document.getElementById("capture").textContent`))}`);
    step(`page errors: ${JSON.stringify(b.takeErrors())}`);
    throw err;
  }
  const captureLine = await b.ev(`document.getElementById("capture").textContent`);
  const lit = async () => b.ev(`document.querySelectorAll("#bars i.on").length`);
  /* Sample the meter, and PHOTOGRAPH IT AT THE PEAK: the synthetic device is
     a beeping tone, so a shot taken after the loop can land in a gap and show
     one lit bar over a claim of twenty-eight. The picture and the number are
     taken from the same moment. */
  let peak = 0;
  let atPeak = null;
  for (let i = 0; i < 60; i++) {
    const count = await lit();
    if (count > peak) {
      peak = count;
      atPeak = await shot("01-meter-live");
    }
    await sleep(25);
  }
  const held = await b.ev(`document.querySelectorAll("#bars i.peak").length`);
  const litAfterShot = await lit();
  const meterShot = atPeak ?? (await shot("01-meter-live"));
  /* The layout, checked rather than looked at: a panel clipped by the window
     edge is a measurement, not an opinion. */
  const layout = await b.ev(`(() => {
    const aside = document.querySelector("aside").getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      asideRight: Math.round(aside.right),
      clippedPanels: [...document.querySelectorAll("aside .panel")].filter((p) => p.getBoundingClientRect().right > window.innerWidth + 1).length,
    };
  })()`);
  step(`layout: viewport ${layout.viewport}px, document ${layout.scrollWidth}px, key panel right edge ${layout.asideRight}px, panels clipped off-window: ${layout.clippedPanels}`);
  if (layout.scrollWidth > layout.viewport + 1) {
    /* Say WHICH element is off the window rather than reporting a number: an
       overflow is only fixable once it has a name. */
    const offenders = await b.ev(`[...document.querySelectorAll("body *")]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.right > window.innerWidth + 1)
      .sort((a, b) => b.r.right - a.r.right)
      .slice(0, 5)
      .map(({ el, r }) => el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ").join(".") : "") + " right=" + Math.round(r.right) + " width=" + Math.round(r.width) + " text=" + JSON.stringify((el.textContent || "").trim().slice(0, 40)))`);
    step(`layout: elements past the edge — ${offenders.join(" | ")}`);
  }
  step(`capture: ${captureLine}`);
  step(`meter: peak ${peak}/28 bars, photographed at that moment (${meterShot}); held-peak marker present: ${held}`);

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

  /* Narrow, because Paul reads layout quality as a proxy for whether the
     thing works: one column, nothing past the window, and a picture to look
     at. Measured rather than eyeballed. */
  await b.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const narrow = await b.ev(`(() => {
    const aside = document.querySelector("aside").getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      asideRight: Math.round(aside.right),
      asideWidth: Math.round(aside.width),
      columns: getComputedStyle(document.body).gridTemplateColumns,
      clipped: [...document.querySelectorAll("aside .panel")].filter((p) => p.getBoundingClientRect().right > window.innerWidth + 1).length,
    };
  })()`);
  const narrowShot = await shot("04-narrow-420");
  step(`narrow 420px: columns ${narrow.columns}, document ${narrow.scrollWidth}px, aside ${narrow.asideWidth}px (right edge ${narrow.asideRight}px), panels clipped: ${narrow.clipped} — ${narrowShot}`);
  await b.send("Emulation.clearDeviceMetricsOverride");

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
    `- connected to: canvas “${connection.canvas.title}” (${connection.canvas.id}), daemon ${connection.daemon}, home ${connection.home}`,
    `- agent: ${connection.agent.name} (${connection.agent.id})${connection.agent.enrolled ? ", enrolled" : ", NOT enrolled"}`,
    `- audio: ${connection.provider.name ?? "no provider"} ${connection.provider.model}${connection.provider.key ? "" : " (no key stored)"}`,
    `- capture path that ran: ${captureLine}`,
    `- meter peak: ${peak}/28 bars (sampled every 25ms for 1.5s; the screenshot was taken at the peak sample, so the picture and the number are the same moment)`,
    `- held-peak marker: ${held ? "present" : "absent"}`,
    `- bars lit immediately after the shutter closed: ${litAfterShot}/28 (the level meter has a slow release on purpose; the held-peak marker is what survives a quiet moment)`,
    `- layout at 1440: viewport ${layout.viewport}px, document width ${layout.scrollWidth}px, key panel right edge ${layout.asideRight}px, panels clipped off-window: ${layout.clippedPanels}`,
    `- layout at 420: columns ${narrow.columns}, document ${narrow.scrollWidth}px, panels clipped: ${narrow.clipped}`,
    `- utterance: “${utterance}”`,
    `- operations sent: ${sent}`,
    `- canvas titles after: ${JSON.stringify(titles)}`,
    `- last operation: ${last.envelope.op.type} by “${snapshot.names[last.envelope.actor.id]}”`,
    ``,
    `## Steps`,
    ...steps.map((s) => `- ${s}`),
    ``,
    `## Screenshots`,
    `- 01-meter-live.png — capture running, meter at its peak (${meterShot})`,
    `- 02-no-key-stated.png — the stop, with the harness saying it has no key (${audioShot})`,
    `- 03-operation-sent.png — the operation in the log beside the canvas it changed (${opsShot})`,
    `- 04-narrow-420.png — the same page at 420px: ${narrow.scrollWidth}px of document in a ${narrow.viewport}px window, ${narrow.clipped} panels clipped (${narrowShot})`,
  ].join("\n");
  writeFileSync(path.join(outDir, "evidence.md"), `${report}\n`);
  console.log(`\n  evidence written to ${path.join(outDir, "evidence.md")}\n`);
} finally {
  await b.close();
  child.kill("SIGTERM");
  await daemon.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
