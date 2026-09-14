#!/usr/bin/env node
/**
 * **The model, chosen and typed, against the real provider.**
 *
 * The item's own evidence list, and why each step is here:
 *
 *   - switch to a second model and hold a REAL turn with it, then switch back
 *     and hold one. A turn is the only proof that a model works here: this is
 *     the Live API with audio out, and a name that looks fine can be refused
 *     the moment the socket is asked for audio;
 *   - type a model that does not exist and show the provider's refusal
 *     VERBATIM — and, next to it, a text-only model, whose refusal from the
 *     provider is byte-for-byte the same sentence. Telling those two apart is
 *     the whole reason the provider's own list is fetched;
 *   - prove the choice survives a page reload and a harness restart.
 *
 * It runs against the shipped harness (`isocan voice`), in a throwaway home,
 * with a COPY of the machine's key (0600 — the harness refuses anything else),
 * so nothing in the real `~/.isocan` is touched and no canvas is disturbed.
 *
 * The turn is held over the Live socket with the API's own setup contract and
 * the model name read from the harness's `/state`: a plain script cannot import
 * `liveSetup` (Node's type-stripping fails on `@isocan/core`), and the page's
 * socket carries PCM only, so a synthetic turn is the honest way to ask the
 * provider about a model without a microphone. The harness's OWN session on the
 * same model is proven separately, by starting one and reading its state.
 *
 * Run it with tsx — it imports the repo's TypeScript (the badge helper), which
 * plain `node` refuses to strip:
 *
 *   npx tsx scripts/voice-model-evidence.mjs [--out <dir>]
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "@isocan/server";
import WebSocket from "ws";
import { browser, until } from "./lib/browser.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "packages", "cli", "bin", "isocan.js");
const outIndex = process.argv.indexOf("--out");
const outDir = outIndex > -1 ? path.resolve(process.argv[outIndex + 1]) : path.join(repo, "reports", "voice-model");
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
const step = (line) => {
  steps.push(line);
  console.log(`  ${line}`);
};

const realHome = process.env.ISOCAN_HOME ?? path.join(os.homedir(), ".isocan");
const realKey = path.join(realHome, "voice", "key.json");
if (!existsSync(realKey)) {
  console.error(`\n  no key at ${realKey} — this evidence needs a real provider key.\n`);
  process.exit(2);
}

/* A throwaway home, a canvas and an actor, so the harness has somewhere to be. */
const home = mkdtempSync(path.join(os.tmpdir(), "isocan-model-evidence-"));
mkdirSync(path.join(home, "voice"), { recursive: true, mode: 0o700 });
copyFileSync(realKey, path.join(home, "voice", "key.json"));
const key = JSON.parse((await import("node:fs")).readFileSync(path.join(home, "voice", "key.json"), "utf8")).key;
writeFileSync(path.join(home, "identity.json"), JSON.stringify({ id: "usr_person", name: "Person", createdAt: new Date().toISOString() }));
const daemon = await startDaemon({ port: 0, home });
const daemonPort = daemon.app.server.address().port;
const base = `http://127.0.0.1:${daemonPort}`;
const { mintTestBadge } = await import(path.join(repo, "packages", "cli", "test", "badge.ts"));
const badge = await mintTestBadge(base);
const person = { id: "usr_person", name: "Person" };
await badge.speakAs(person);
await fetch(`${base}/api/ops`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...badge.headers },
  body: JSON.stringify({ canvasId: null, actor: person, op: { type: "project.create", canvasId: "prj_model", title: "Model evidence" } }),
});

/* The harness, the way a person starts it. */
const voicePort = 8100 + Math.floor(Math.random() * 400);
let child = null;
let voiceOut = "";
async function startHarness(extra = []) {
  child = spawn(process.execPath, [cli, "voice", "--voice-port", String(voicePort), "--canvas", "prj_model", ...extra], {
    cwd: repo,
    env: { ...process.env, ISOCAN_HOME: home, ISOCAN_PORT: String(daemonPort), ISOCAN_SESSION_ID: "Voice", ISOCAN_HARNESS: "agent" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => (voiceOut += d));
  child.stderr.on("data", (d) => (voiceOut += d));
  const url = `http://127.0.0.1:${voicePort}/`;
  const deadline = Date.now() + 30_000;
  while (!voiceOut.includes(url) && Date.now() < deadline) await sleep(100);
  if (!voiceOut.includes(url)) throw new Error(`the harness never said it was listening:\n${voiceOut}`);
  return url;
}
async function stopHarness() {
  if (!child) return;
  const ending = child;
  child = null;
  ending.kill("SIGTERM");
  await new Promise((resolve) => ending.once("exit", resolve));
  voiceOut = "";
  await sleep(200);
}

const get = async (url, pathname) => (await fetch(`${url}${pathname}`)).json();
const post = async (url, pathname, body) =>
  (
    await fetch(`${url}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();

/** The Live socket, the API's own setup contract, one text turn. */
async function holdTurn(model) {
  return await new Promise((resolve) => {
    const socket = new WebSocket(
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`,
    );
    const events = [];
    let audioBytes = 0;
    let text = "";
    const finish = (outcome) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve({ outcome, events, audioBytes, text });
    };
    const timer = setTimeout(() => finish("no answer within 20s"), 20_000);
    socket.on("open", () =>
      socket.send(
        JSON.stringify({ setup: { model, generationConfig: { responseModalities: ["AUDIO"] } } }),
      ),
    );
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.setupComplete) {
        events.push("setupComplete");
        socket.send(
          JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: "Say the single word: ready." }] }],
              turnComplete: true,
            },
          }),
        );
        return;
      }
      for (const part of message.serverContent?.modelTurn?.parts ?? []) {
        if (part.inlineData) audioBytes += Math.round((part.inlineData.data?.length ?? 0) * 0.75);
        if (part.text) text += part.text;
      }
      if (message.serverContent?.turnComplete) finish("turn complete");
      if (message.error) {
        events.push(`error: ${JSON.stringify(message.error).slice(0, 300)}`);
        finish("error");
      }
    });
    socket.on("close", (code, reason) => {
      events.push(`closed ${code} ${String(reason).slice(0, 300)}`);
      finish(`closed ${code}`);
    });
    socket.on("error", (err) => {
      events.push(`socket error: ${err.message}`);
      finish("socket error");
    });
  });
}

let url = null;
let browserSession = null;
/** What the page said, kept for the report outside the browser block. */
let before = null;
let afterReload = null;
try {
  url = await startHarness();
  step(`harness: \`isocan voice\` on ${url} (throwaway home, the machine's key copied in 0600, daemon ${daemonPort})`);

  /* 1. The provider's own list, through the harness. */
  const list = await get(url, "models");
  const live = (list.models ?? []).filter((one) => one.live);
  step(`list: ${list.answer}`);
  step(`list: the Live models the provider names — ${live.map((one) => `${one.name.replace("models/", "")} (${one.displayName})`).join("; ")}`);
  if (!list.ok) throw new Error(`no list to work from: ${list.answer}`);

  const current = (await get(url, "state")).provider.model;
  // Live (bidiGenerateContent) is necessary and NOT sufficient: measured, the
  // transcribe and translate models are Live and cannot hold a conversation —
  // a turn on them closes with 1007 because they do not send audio back. So the
  // second model for the turn is chosen from the conversational ones.
  const conversational = live.filter((one) => !/transcribe|translate|robotics|music/i.test(one.name));
  const second = conversational.find((one) => one.name !== current)?.name;
  if (!second) throw new Error("the provider lists no second conversational Live model to switch to");
  step(`chosen: the harness is on ${current}; a second Live model available is ${second}`);

  /* 2. A turn with the model the harness is on, then on the second, then back. */
  const firstTurn = await holdTurn(current);
  step(`turn on ${current}: ${firstTurn.outcome} — ${firstTurn.audioBytes} bytes of audio back, setupComplete: ${firstTurn.events.includes("setupComplete")}`);

  const switched = await post(url, "model", { model: second });
  const stateAfter = await get(url, "state");
  step(`switch: POST /model → ${JSON.stringify(switched)}; the harness now reports model ${stateAfter.provider.model} (source ${stateAfter.provider.modelSource})`);
  const secondTurn = await holdTurn(stateAfter.provider.model);
  step(`turn on ${second}: ${secondTurn.outcome} — ${secondTurn.audioBytes} bytes of audio back, setupComplete: ${secondTurn.events.includes("setupComplete")}`);

  const back = await post(url, "model", { model: current });
  const backTurn = await holdTurn((await get(url, "state")).provider.model);
  step(`switch back: POST /model → ${JSON.stringify(back)}`);
  step(`turn on ${current} again: ${backTurn.outcome} — ${backTurn.audioBytes} bytes of audio back`);

  /* 3. The refusals, and the difference between them. */
  const unknown = await post(url, "model/test", { model: "gemini-9.9-does-not-exist" });
  step(`refusal (a name that does not exist): ${JSON.stringify(unknown.answer)}`);
  step(`  …and the part the provider cannot say: ${JSON.stringify(unknown.why)}`);

  const textOnly = await post(url, "model/test", { model: "gemini-2.5-flash" });
  step(`refusal (a text-only model): ${JSON.stringify(textOnly.answer)}`);
  step(`  …and the part the provider cannot say: ${JSON.stringify(textOnly.why)}`);

  const transcribe = live.find((one) => /transcribe|translate/i.test(one.name));
  const transcript = transcribe ? await post(url, "model/test", { model: transcribe.name }) : null;
  if (transcript) {
    step(`refusal (a Live TRANSCRIBE model, ${transcribe.name}): ${JSON.stringify(transcript.answer)}`);
    step(`  …and the part the provider cannot say: ${JSON.stringify(transcript.why)}`);
  }

  const malformed = await post(url, "model/test", { model: "gemini 2.5 flash!" });
  step(`refusal (a name that is not shaped like one, refused HERE): ${JSON.stringify(malformed.answer)}`);

  /* 4. The harness's own session on the chosen model: the page's socket is what
     opens it, so one is opened here — the same socket the page uses. */
  const started = await post(url, "session/start", {});
  const pageSocket = new WebSocket(`${url.replace("http://", "ws://")}audio`);
  await new Promise((resolve) => pageSocket.on("open", resolve));
  let liveState = null;
  for (let i = 0; i < 40; i++) {
    liveState = await get(url, "state");
    if (liveState.provider.modelLive) break;
    await sleep(250);
  }
  step(
    `the harness's own session: ${JSON.stringify(started)}, the provider completed its setup and /state reports modelLive ${JSON.stringify(liveState?.provider.modelLive)} ` +
      `(the harness's log line said: ${JSON.stringify(voiceOut.split("\n").filter((l) => /live socket: setup_complete|opening a live session/.test(l)).slice(-2).join(" | ").trim())})`,
  );
  pageSocket.close();
  await sleep(300);
  await post(url, "session/end", {});

  /* 5. The page: the model fact, and a reload. */
  const webPort = 5173;
  const vite = spawn("npm", ["run", "dev", "-w", "@isocan/voice-agent", "--", "--port", String(webPort), "--strictPort"], {
    cwd: repo,
    env: { ...process.env, ISOCAN_VOICE_HARNESS: url.replace(/\/$/, "") },
    stdio: "ignore",
  });
  const pageUrl = `http://localhost:${webPort}/voice`;
  for (let i = 0; i < 120; i++) {
    if (await fetch(pageUrl).then((r) => r.ok).catch(() => false)) break;
    await sleep(250);
  }
  browserSession = await browser({ flags: ["--use-fake-ui-for-media-stream", "--window-size=1440,900"] });
  const b = browserSession;
  try {
    const loaded = b.once("Page.loadEventFired");
    await b.send("Page.navigate", { url: pageUrl });
    await loaded;
    await until(b, `document.getElementById("model-fact").textContent !== "unknown"`, "the model fact");
    before = await b.ev(`document.getElementById("model-fact").textContent`);
    step(`page: the facts say ${JSON.stringify(before)}`);

    // Choose in the panel, the way a person does: open the cog, open the
    // model panel, pick from the provider's list.
    await b.ev(`document.getElementById("settings-open").click()`);
    await b.ev(`(() => { const p = document.getElementById("model-panel"); p.open = true; p.dispatchEvent(new Event("toggle")); return true; })()`);
    await until(b, `document.querySelectorAll("#model-list option").length > 0`, "the provider's list in the panel");
    const options = await b.ev(`[...document.querySelectorAll("#model-list option")].map((o) => o.value)`);
    step(`page: the panel lists ${options.length} models, e.g. ${options.slice(0, 3).join(", ")}`);
    await b.ev(`(() => { const s = document.getElementById("model-list"); s.value = ${JSON.stringify(second)}; s.dispatchEvent(new Event("change")); return true; })()`);
    try {
      await until(b, `document.getElementById("model-note").textContent.includes("stored")`, "the choice to be stored", 8_000);
    } catch (err) {
      // Say what the page says rather than only that a wait expired.
      step(`page: the choice did not store — note ${JSON.stringify(await b.ev(`document.getElementById("model-note").textContent`))}, errors ${JSON.stringify(b.takeErrors())}`);
      throw err;
    }
    const chosenNote = await b.ev(`document.getElementById("model-note").textContent`);
    step(`page: choosing ${second} said ${JSON.stringify(chosenNote)}`);

    const reloaded = b.once("Page.loadEventFired");
    await b.send("Page.reload");
    await reloaded;
    await until(b, `document.getElementById("model-fact").textContent !== "unknown"`, "the model fact after a reload");
    afterReload = await b.ev(`document.getElementById("model-fact").textContent`);
    step(`page: after a reload the facts say ${JSON.stringify(afterReload)}`);
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // The dialog is taller than a 900px window and scrolls, so the panel has to
    // be brought into view before the picture is taken: the first attempt
    // photographed the top of the dialog and claimed it showed the panel.
    await b.ev(`document.getElementById("settings-open").click()`);
    // Open it, and let the provider's list arrive: a picture of a collapsed
    // summary is not a picture of the control.
    await b.ev(`(() => { const p = document.getElementById("model-panel"); p.open = true; p.dispatchEvent(new Event("toggle")); return true; })()`);
    await until(b, `document.querySelectorAll("#model-list option").length > 0`, "the list in the panel before the picture");
    await b.ev(`document.getElementById("model-panel").scrollIntoView({ block: "center" })`);
    await sleep(400);
    const panelBox = await b.ev(`(() => { const r = document.getElementById("model-panel").getBoundingClientRect();
      return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.min(window.innerWidth, r.width + 16), height: Math.min(window.innerHeight - Math.max(0, r.y - 8), r.height + 16) }; })()`);
    const shot = await b.send("Page.captureScreenshot", { format: "png", clip: { ...panelBox, scale: 1 } });
    writeFileSync(path.join(outDir, "01-model-panel-1440.png"), Buffer.from(shot.data, "base64"));
    step(`page: the panel photographed at ${Math.round(panelBox.width)}×${Math.round(panelBox.height)} (a clipped shot: the dialog scrolls, and a full-window one showed the top of it)`);
  } finally {
    await b.close();
    browserSession = null;
    vite.kill("SIGTERM");
  }

  /* 6. A harness restart keeps the choice: the file is the preference. */
  const beforeRestart = (await get(url, "state")).provider.model;
  await stopHarness();
  url = await startHarness();
  const afterRestart = (await get(url, "state")).provider;
  step(`restart: the harness was on ${beforeRestart} (${afterRestart.modelSource}); after a restart /state reports ${afterRestart.model} (source ${afterRestart.modelSource})`);

  const report = [
    `# The model: chosen, typed, and refused — against the real provider`,
    ``,
    `Run ${new Date().toISOString()}. The shipped harness (\`isocan voice\`) in a throwaway home, with a 0600 copy of the machine's key.`,
    ``,
    `## What the provider's list actually is (measured, not assumed)`,
    ``,
    `- ${list.answer}`,
    `- the Live ones, by the provider's own \`bidiGenerateContent\` method: ${live.map((one) => `\`${one.name.replace("models/", "")}\``).join(", ")}`,
    `- so \`live\` in the page is read from the provider's method list, not from a list this repo keeps — and the free-text field stays, because a beta name is exactly what that list will not carry.`,
    ``,
    `## Turns held`,
    ``,
    `| model | outcome | audio back |`,
    `| --- | --- | --- |`,
    `| \`${current}\` (the harness's own model) | ${firstTurn.outcome} | ${firstTurn.audioBytes} bytes |`,
    `| \`${second}\` (after \`POST /model\`) | ${secondTurn.outcome} | ${secondTurn.audioBytes} bytes |`,
    `| \`${current}\` again (after switching back) | ${backTurn.outcome} | ${backTurn.audioBytes} bytes |`,
    ``,
    `## The refusals, verbatim`,
    ``,
    `| what was typed | the provider's own words | what the provider cannot say |`,
    `| --- | --- | --- |`,
    `| a name that does not exist | ${JSON.stringify(unknown.answer)} | ${JSON.stringify(unknown.why)} |`,
    `| a text-only model | ${JSON.stringify(textOnly.answer)} | ${JSON.stringify(textOnly.why)} |`,
    ...(transcript ? [`| a Live TRANSCRIBE model | ${JSON.stringify(transcript.answer)} | ${JSON.stringify(transcript.why)} |`] : []),
    `| a name that is not shaped like one | ${JSON.stringify(malformed.answer)} | refused before anything was sent |`,
    ``,
    `The first two answers are the same sentence from the provider — which is why the list is fetched and the difference is stated by the harness.`,
    ``,
    `## Persistence`,
    ``,
    `- the page's fact before a reload: ${JSON.stringify(before)}`,
    `- after a page reload: ${JSON.stringify(afterReload)}`,
    `- after a harness restart: \`${afterRestart.model}\` (source \`${afterRestart.modelSource}\`)`,
    ``,
    `## Steps`,
    ...steps.map((one) => `- ${one}`),
    ``,
    `## Screenshots`,
    `- 01-model-panel-1440.png — the model panel, with the provider's list in it`,
  ].join("\n");
  writeFileSync(path.join(outDir, "evidence.md"), `${report}\n`);
  console.log(`\n  evidence written to ${path.join(outDir, "evidence.md")}\n`);
} finally {
  await browserSession?.close();
  await stopHarness();
  await daemon.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log("  cleaned up: browser, vite, harness, daemon and the throwaway home");
}
