#!/usr/bin/env node
/**
 * **The two device rows, proved in a real browser and a real audio stack.**
 *
 * The functional-verification rule says interaction only a browser can prove
 * is proved by driving a browser; `voice-evidence.mjs` does that for the
 * microphone. This is the same thing for the device selectors beside it, and
 * it exists because the interesting claims are the ones a unit test cannot
 * make:
 *
 *   - the reply reaches a NON-DEFAULT output device — measured on that
 *     device's own monitor port, against a control device that must stay
 *     silent, not read off a control's value;
 *   - a chosen device that goes away is named in the UI, and the sound really
 *     moves to the system default (two recordings, before and after);
 *   - what the row says when the browser withholds device names, which is
 *     Chrome's answer until the page has been allowed a microphone.
 *
 * Nothing here touches anybody's canvas and no key is used: the harness is a
 * stub this script starts, on its own port, and the page is pointed at it
 * through `ISOCAN_VOICE_HARNESS`. It deliberately does NOT run with Chrome's
 * `--use-fake-device-for-media-stream`: that flag replaces the machine's real
 * outputs with fakes, and a fake output is exactly what cannot be proved to
 * receive anything.
 *
 *   node scripts/voice-devices-evidence.mjs [--out <dir>]
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { browser, until } from "./lib/browser.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outIndex = process.argv.indexOf("--out");
const outDir = outIndex > -1 ? path.resolve(process.argv[outIndex + 1]) : path.join(repo, "reports", "voice-devices");
mkdirSync(outDir, { recursive: true });
// A previous run's pictures are cleared first: evidence.md is rewritten every
// time, and a screenshot left from an older code path would be evidence of a
// state this run never measured.
for (const file of readdirSync(outDir)) {
  if (file.endsWith(".png")) rmSync(path.join(outDir, file), { force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
const step = (line) => {
  steps.push(line);
  console.log(`  ${line}`);
};

/** pactl, with its own complaints kept in view. */
function pactl(...args) {
  const run = spawnSync("pactl", args, { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`pactl ${args.join(" ")} failed: ${run.stderr.trim() || run.status}`);
  return run.stdout.trim();
}

/**
 * **Two recordings of a monitor port: the device under test and the control.**
 *
 * `parec` on a sink's monitor is what that sink actually produced, which is a
 * different claim from "setSinkId was called". Raw s16le so the peak can be
 * read here rather than by a second tool.
 */
async function record(device, seconds) {
  const proc = spawn("parec", ["--device", device, "--format", "s16le", "--rate", "48000", "--channels", "2"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const chunks = [];
  proc.stdout.on("data", (data) => chunks.push(data));
  const done = new Promise((resolve) => proc.once("exit", resolve));
  await sleep(seconds * 1000);
  proc.kill("SIGTERM");
  await done;
  return Buffer.concat(chunks);
}

/**
 * **Which sink each Chrome stream is being rendered on — the platform's own
 * answer, not the page's.**
 *
 * This exists because the machine's DEFAULT sink is not a clean measuring
 * instrument: a first run of this script recorded it at 18302 while the tone
 * was supposed to be elsewhere, and the number turned out to be somebody
 * else's music. A sink's monitor carries whatever the machine plays, so the
 * machine's default is read through PulseAudio's own stream attribution
 * instead, which names the sink Chrome's audio is actually going to.
 */
function chromeStreams() {
  const listing = spawnSync("pactl", ["list", "sink-inputs"], { encoding: "utf8" }).stdout;
  const streams = [];
  for (const block of listing.split(/^Sink Input #/m).slice(1)) {
    const index = Number(block.split("\n")[0].trim());
    const sink = Number(/^\s*Sink: (\d+)/m.exec(block)?.[1]);
    const app = /application\.name = "([^"]*)"/.exec(block)?.[1] ?? "";
    const pid = /application\.process\.id = "([^"]*)"/.exec(block)?.[1] ?? "";
    streams.push({ index, sink, app, pid });
  }
  return streams.filter((one) => /chrome|chromium/i.test(one.app));
}

/** A sink's PulseAudio index, which is what a stream's `Sink:` line points at. */
function sinkIndex(name) {
  const line = pactl("list", "short", "sinks")
    .split("\n")
    .find((one) => one.includes(`\t${name}\t`));
  return line ? Number(line.split("\t")[0]) : NaN;
}

function peakOf(buffer) {
  let peak = 0;
  for (let i = 0; i + 1 < buffer.length; i += 2) peak = Math.max(peak, Math.abs(buffer.readInt16LE(i)));
  return peak;
}

const aSink = "isocan_evidence_a";
const bSink = "isocan_evidence_b";
const aLabel = "IsocanEvidenceA";
/** A second of 440 Hz at half scale, the shape the page's playback takes. */
const TONE_HZ = 440;

/** 24 kHz PCM in 100 ms frames, the granularity the Live API sends. */
function toneBurst(frames) {
  const out = [];
  for (let f = 0; f < frames; f++) {
    const pcm = new Int16Array(2400);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * TONE_HZ * (f * 2400 + i)) / 24000) * 0.5 * 0x7fff);
    out.push(Buffer.from(pcm.buffer));
  }
  return out;
}

/* The stub harness: enough of the wire for the page to go live, and a tone
   the script can ask for. It counts the microphone frames it received, which
   is the page's INPUT half running in the same session. */
let micFrames = 0;
let micBytes = 0;
const sockets = new Set();
const harness = createServer((req, res) => {
  const send = (body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/state")
    return send({
      canvas: { title: "Device evidence (synthetic)", id: "prj_evidence" },
      daemon: "http://127.0.0.1:1",
      home: "http://127.0.0.1:1",
      agent: { name: "Evidence", id: "usr_evidence", enrolled: true },
      provider: { name: "stub", model: "stub-live", key: true },
      version: "evidence",
      updated: "now",
      session: sockets.size > 0 ? { state: "live" } : { state: "idle" },
    });
  if (req.url === "/log") return send({ entries: [] });
  if (req.method === "POST" && req.url === "/tone") {
    for (const socket of sockets) for (const frame of toneBurst(25)) socket.send(frame);
    return send({ ok: true, frames: 25 });
  }
  if (req.method === "POST") return send({ ok: true });
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: `no ${req.url}` }));
});
const audio = new WebSocketServer({ server: harness });
audio.on("connection", (socket, request) => {
  if (!request.url?.startsWith("/audio")) return socket.close();
  sockets.add(socket);
  socket.on("message", (data) => {
    micFrames++;
    micBytes += data.length ?? 0;
  });
  socket.on("close", () => sockets.delete(socket));
});
await new Promise((resolve) => harness.listen(0, "127.0.0.1", resolve));
const harnessPort = harness.address().port;

/* A throwaway vite, pointed at THIS harness rather than the one on 7654 that
   somebody may be using. */
const webPort = 5173;
const vite = spawn("npm", ["run", "dev", "-w", "@isocan/web", "--", "--port", String(webPort), "--strictPort"], {
  cwd: repo,
  env: { ...process.env, ISOCAN_VOICE_HARNESS: `http://127.0.0.1:${harnessPort}` },
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOut = "";
vite.stdout.setEncoding("utf8");
vite.stderr.setEncoding("utf8");
vite.stdout.on("data", (d) => (viteOut += d));
vite.stderr.on("data", (d) => (viteOut += d));
// `localhost`, not 127.0.0.1: vite binds the name it was given, and 127.0.0.1
// is not necessarily the same socket.
const pageUrl = `http://localhost:${webPort}/voice`;
{
  const deadline = Date.now() + 60_000;
  for (;;) {
    const answered = await fetch(pageUrl)
      .then((r) => r.ok)
      .catch(() => false);
    if (answered) break;
    if (Date.now() > deadline) throw new Error(`vite never served ${pageUrl}:\n${viteOut}`);
    await sleep(250);
  }
}
step(`page: a throwaway vite on ${webPort}, its /harness proxied to a stub on ${harnessPort} (the real harness on 7654 is untouched)`);

/* Two null sinks: the device the page will route to, and a control that
   nothing should reach. */
for (const [name, description] of [
  [aSink, aLabel],
  [bSink, "IsocanEvidenceB"],
]) {
  for (const line of pactl("list", "short", "modules").split("\n")) {
    if (line.includes(`sink_name=${name}`)) pactl("unload-module", line.split("\t")[0]);
  }
  pactl("load-module", "module-null-sink", `sink_name=${name}`, `sink_properties=device.description=${description}`);
}
const defaultSink = pactl("get-default-sink");
step(`audio: null sinks ${aSink} and ${bSink} loaded; the machine's own default is ${defaultSink} (recorded as the second wire, never changed)`);

const b = await browser({
  flags: [
    // NOT --use-fake-device-for-media-stream: that replaces the machine's
    // outputs with fakes, and a fake cannot be proved to receive anything.
    // The fake UI only answers the permission prompt, so the page gets the
    // device names the way a person's browser gives them.
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1440,900",
  ],
});
/**
 * The theme is SET, not inherited: a fresh profile answers to the machine's
 * own preference, and a screenshot called "light" that is dark is worse than
 * no screenshot. The page's own stored preference is how a person does it.
 */
const setTheme = async (remote, theme) => {
  await remote.ev(`localStorage.setItem("isocan.theme", ${JSON.stringify(theme)})`);
  const reloaded = remote.once("Page.loadEventFired");
  await remote.send("Page.reload");
  await reloaded;
  await until(remote, `document.querySelectorAll("#output option").length > 0`, "the rows after a reload");
  await sleep(400);
};
/**
 * Photograph a SPECIFIC browser: this run has three of them, and a screenshot
 * taken from the wrong one is a picture of a state that was not measured —
 * which is worse than no picture, because it looks like evidence.
 */
const shot = async (remote, name) => {
  const { data } = await remote.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, "base64"));
  return `${name}.png`;
};
const read = async () => ({
  mic: await b.ev(`[...document.querySelectorAll("#device option")].map((o) => o.textContent)`),
  output: await b.ev(`[...document.querySelectorAll("#output option")].map((o) => o.textContent)`),
  chosen: await b.ev(`document.getElementById("output").value`),
  note: await b.ev(`document.getElementById("device-note").hidden ? "" : document.getElementById("device-note").textContent`),
  state: await b.ev(`document.getElementById("state").textContent`),
});

try {
  const loaded = b.once("Page.loadEventFired");
  await b.send("Page.navigate", { url: pageUrl });
  await loaded;
  await until(b, `document.querySelectorAll("#output option").length > 0`, "the device rows to fill");
  await setTheme(b, "light");
  const before = await read();
  step(`rows: microphone ${JSON.stringify(before.mic)}; output ${JSON.stringify(before.output)}`);
  step(`rows: chosen output ${JSON.stringify(before.chosen)}; note ${JSON.stringify(before.note)}`);
  const openShot = await shot(b, "01-rows-1440-light");

  /* The picker, opened the way a person opens it. The rows the browser will
     actually offer are drawn by the browser in the top layer — including the
     long device names and whichever one is selected — which is a different
     claim from reading option text out of the DOM. */
  const box = await b.ev(`(() => { const r = document.getElementById("output").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await b.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  await sleep(600);
  const pickerShot = await shot(b, "02-output-picker-1440-light");
  await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(300);

  /* Baseline, so a tone is a difference and not a claim: both monitors are
     recorded for a second with nothing playing. */
  const quietA = peakOf(await record(`${aSink}.monitor`, 1));
  const quietB = peakOf(await record(`${bSink}.monitor`, 1));
  step(`silence: peaks before any audio — ${aSink} ${quietA}, ${bSink} ${quietB}`);

  /* Choose the non-default output THROUGH THE ROW, and read back what the
     page stored: this is the picker's own path, not a value poked into a
     select. */
  const aId = await b.ev(
    `[...document.querySelectorAll("#output option")].find((o) => o.textContent === ${JSON.stringify(aLabel)})?.value`,
  );
  if (!aId) throw new Error(`${aLabel} is not in the output row — is Chrome on the real devices?`);
  await b.ev(`(() => { const s = document.getElementById("output"); s.value = ${JSON.stringify(aId)};
    s.dispatchEvent(new Event("change")); })()`);
  await sleep(300);
  const stored = await b.ev(`localStorage.getItem("isocan.voice.outputId")`);
  const chosenRead = await read();
  step(`chose: ${aLabel} (${aId.slice(0, 8)}…) — stored preference ${JSON.stringify(stored) === JSON.stringify(aId) ? "agrees" : `DISAGREES (${stored})`}; note ${JSON.stringify(chosenRead.note)}`);

  /* Go live. The microphone is real (a synthetic capture device would fake
     the outputs too), echo-cancelled, and its frames are counted by the stub
     rather than stored anywhere. */
  await b.ev(`document.getElementById("listen").click()`);
  try {
    await until(b, `document.getElementById("hero").dataset.state === "live"`, "the session to go live", 20_000);
  } catch (err) {
    // Say what the PAGE says rather than only that a wait expired: a session
    // that never opens has a reason, and the reason is on the page.
    step(`no live session — state ${JSON.stringify(await b.ev(`document.getElementById("state").textContent`))}`);
    step(`no live session — complaint ${JSON.stringify(await b.ev(`document.getElementById("complaint").textContent`))}`);
    step(`no live session — log ${JSON.stringify(await b.ev(`[...document.querySelectorAll("#log li")].map((li) => li.textContent).join(" | ")`))}`);
    step(`no live session — page errors ${JSON.stringify(b.takeErrors())}`);
    throw err;
  }
  step(`session: live — ${JSON.stringify((await read()).state)}`);

  /* The reply, on the chosen device — measured two ways at once: what the
     device produced (its own monitor) and where the platform says Chrome's
     stream is being rendered. */
  const duringA = record(`${aSink}.monitor`, 4);
  const duringB = record(`${bSink}.monitor`, 4);
  await sleep(300);
  await fetch(`http://127.0.0.1:${harnessPort}/tone`, { method: "POST" });
  await sleep(700);
  const aIndex = sinkIndex(aSink);
  const routed = chromeStreams().filter((one) => one.sink === aIndex);
  const [playedA, playedB] = [peakOf(await duringA), peakOf(await duringB)];
  const playingShot = await shot(b, "03-playing-1440-light");
  step(`reply: 25 frames (2.5 s of 440 Hz at half scale) sent by the harness`);
  step(`reply: ${aSink}.monitor peak ${playedA}, ${bSink}.monitor (control) peak ${playedB} — ${playedA > 4000 && playedB < 500 ? "only the chosen device received it" : "NOT the clean result this claims"}`);
  step(`reply: PulseAudio renders ${routed.length} Chrome stream(s) for the page on sink ${aIndex} (${aSink})${routed.length ? `, first #${routed[0].index}` : " — NONE, which would mean the tone went somewhere else"}`);
  // Measured separately: setSinkId is per CONTEXT. The capture context keeps
  // the system default while the playback context is routed, so the reply is
  // the thing that moves — the microphone is not dragged along with it.
  step(`reply: the page holds two AudioContexts (capture and playback); only the playback one is routed`);
  // The INDEX is not stable: when its sink vanishes Chrome tears the stream
  // down and makes a new one, so the browser's process id is what carries
  // across the unplug.
  const routedStream = routed[0]?.index;
  const routedPid = routed[0]?.pid;
  step(`microphone: the page sent ${micFrames} frames (${micBytes} bytes of 16 kHz PCM) up the same socket`);

  /* Unplug it, which is the Bluetooth case: the id leaves the browser's list
     and the page has to notice by asking, not by being told. */
  const modules = pactl("list", "short", "modules");
  const aModule = modules.split("\n").find((line) => line.includes(`sink_name=${aSink}`))?.split("\t")[0];
  pactl("unload-module", aModule);
  await until(b, `!document.getElementById("device-note").hidden`, "the page to notice the device is gone", 15_000);
  const gone = await read();
  const goneShot = await shot(b, "04-gone-device-1440-light");
  step(`unplugged: ${aSink} unloaded (${gone.output.length} output rows)`);
  step(`unplugged: rows now ${JSON.stringify(gone.output)}; selection ${JSON.stringify(gone.chosen)}`);
  step(`unplugged: note ${JSON.stringify(gone.note)}`);

  /* And the sound really moved: the SAME Chrome stream, asked again where it
     is rendered now that the chosen device no longer exists. */
  const beforeMove = record(`${bSink}.monitor`, 4);
  await sleep(300);
  await fetch(`http://127.0.0.1:${harnessPort}/tone`, { method: "POST" });
  await sleep(700);
  const movedTo = chromeStreams().find((one) => one.pid === routedPid);
  const controlAfter = peakOf(await beforeMove);
  const defaultIndex = sinkIndex(defaultSink);
  step(`after unplug: Chrome ${routedPid}'s stream is now rendered on sink ${movedTo?.sink} (${movedTo?.sink === defaultIndex ? `the system default, ${defaultSink}` : "NOT the system default — check the note"}), and the control sink peak was ${controlAfter}`);
  const moved = movedTo?.sink === defaultIndex;

  /* Both controls at both widths, in both themes — the page's own theme
     mechanism, so what is photographed is what a person would get. */
  const shots = [goneShot, openShot, pickerShot];
  for (const [width, theme, number] of [
    [420, "light", 5],
    [420, "dark", 6],
    [1440, "dark", 7],
  ]) {
    await b.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await setTheme(b, theme);
    const narrow = await b.ev(`(() => {
      const row = document.querySelector(".voice-devices").getBoundingClientRect();
      const pills = [...document.querySelectorAll(".voice-device")].map((p) => p.getBoundingClientRect());
      const hero = document.querySelector(".voice-hero").getBoundingClientRect();
      return {
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        rowLeft: Math.round(row.left),
        rowRight: Math.round(row.right),
        pills: pills.map((r) => Math.round(r.width)),
        pillHeights: pills.map((r) => Math.round(r.height)),
        pillTheme: document.documentElement.dataset.theme,
        stacked: pills.length > 1 && Math.round(pills[1].top) > Math.round(pills[0].top),
        mic: Math.round(document.querySelector(".voice-mic").getBoundingClientRect().width),
        heroWidth: Math.round(hero.width),
        theme: document.documentElement.dataset.theme,
      };
    })()`);
    const file = await shot(b, `0${number}-rows-${width}-${theme}`);
    shots.push(file);
    step(`layout: ${width}px ${theme} — document ${narrow.document}px, device row ${narrow.rowLeft}…${narrow.rowRight} of ${narrow.viewport}, pill widths ${JSON.stringify(narrow.pills)} heights ${JSON.stringify(narrow.pillHeights)}${narrow.stacked ? " (stacked)" : " (one line)"}, microphone ${narrow.mic}px of a ${narrow.heroWidth}px hero — ${file}`);
  }
  await b.send("Emulation.clearDeviceMetricsOverride");
  await b.ev(`document.getElementById("end").click()`);
  await sleep(300);

  /*
   * **Two states a unit test can only assert, each in its own browser.**
   *
   * One: what the page draws when the browser withholds device names, which is
   * Chrome's answer before a microphone has been allowed — one nameless entry
   * per kind, with the ids hidden as well. It must not invent rows there.
   *
   * Two: what it says when the browser cannot route output at all. This run
   * deletes `AudioContext.setSinkId` before any page script executes, which is
   * the shape of a browser that never had it — with the permission granted, so
   * the rows still carry real names and the ONLY thing missing is the choice.
   */
  const states = {};
  const lookAt = async (remote) => ({
    mic: await remote.ev(`[...document.querySelectorAll("#device option")].map((o) => o.textContent)`),
    output: await remote.ev(`[...document.querySelectorAll("#output option")].map((o) => o.textContent)`),
    note: await remote.ev(`document.getElementById("device-note").hidden ? "" : document.getElementById("device-note").textContent`),
    disabled: await remote.ev(`document.getElementById("output").disabled`),
  });

  const withheldBrowser = await browser({ flags: ["--window-size=1440,900", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const fresh = withheldBrowser.once("Page.loadEventFired");
    await withheldBrowser.send("Page.navigate", { url: pageUrl });
    await fresh;
    await until(withheldBrowser, `document.querySelectorAll("#output option").length > 0`, "the rows with no permission asked");
    await setTheme(withheldBrowser, "light");
    states.withheld = await lookAt(withheldBrowser);
    const file = await shot(withheldBrowser, "08-names-withheld-1440-light");
    shots.push(file);
    step(`no permission asked: microphone rows ${JSON.stringify(states.withheld.mic)}, output rows ${JSON.stringify(states.withheld.output)}`);
    step(`no permission asked: note ${JSON.stringify(states.withheld.note)} — ${file}`);
  } finally {
    await withheldBrowser.close();
  }

  const noApiBrowser = await browser({
    flags: ["--use-fake-ui-for-media-stream", "--window-size=1440,900", "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    await noApiBrowser.send("Page.addScriptToEvaluateOnNewDocument", { source: "delete AudioContext.prototype.setSinkId;" });
    const fresh = noApiBrowser.once("Page.loadEventFired");
    await noApiBrowser.send("Page.navigate", { url: pageUrl });
    await fresh;
    await until(noApiBrowser, `document.querySelectorAll("#output option").length > 0`, "the rows in a browser with no output routing");
    await setTheme(noApiBrowser, "light");
    states.noApi = await lookAt(noApiBrowser);
    const file = await shot(noApiBrowser, "09-no-output-api-1440-light");
    shots.push(file);
    step(`no output API: output rows ${JSON.stringify(states.noApi.output)}, control disabled ${states.noApi.disabled}`);
    step(`no output API: note ${JSON.stringify(states.noApi.note)} — ${file}`);
  } finally {
    await noApiBrowser.close();
  }

  const report = [
    `# Voice device selectors — browser evidence`,
    ``,
    `Run ${new Date().toISOString()} in a real Chrome ${await b.ev(`navigator.userAgent.match(/Chrome\\/[\\d.]+/)[0]`)}, on two null sinks planted in the machine's own audio stack.`,
    ``,
    `The claim this file exists for: **a non-default output received the reply, and a control output did not.**`,
    ``,
    `| wire | silence before | tone while chosen |`,
    `| --- | --- | --- |`,
    `| ${aLabel} (the chosen device) | ${quietA} | ${playedA} |`,
    `| IsocanEvidenceB (control) | ${quietB} | ${playedB} |`,
    ``,
    `Peaks are int16 samples off each sink's own monitor port (\`parec\`), so a number over zero is audio that device actually produced. The machine's own default sink is NOT used as a third wire: its monitor carries whatever else the machine is playing (a first run of this script read 18302 there while the tone was meant to be elsewhere, and the sound was somebody's music), so where the reply goes is read from PulseAudio's own stream attribution instead:`,
    ``,
    `- while ${aLabel} was chosen: PulseAudio rendered Chrome's audio for the page on sink ${aIndex} (${aSink})`,
    `- setSinkId is per AudioContext (measured): the capture context stays on the system default while the playback context is routed, so only the reply moves`,
    `- after the device was unplugged: the same browser (pid ${routedPid}, stream #${routedStream}) had its audio rendered on sink ${movedTo?.sink}, which is ${movedTo?.sink === defaultIndex ? `the system default (${defaultSink})` : "NOT the system default"}`,
    ``,
    `- microphone row: ${JSON.stringify(before.mic)}`,
    `- output row: ${JSON.stringify(before.output)}`,
    `- output at load: ${JSON.stringify(before.chosen)} (nothing chosen yet) then ${JSON.stringify(aLabel)} (${JSON.stringify(stored)})`,
    `- note while chosen and playing: ${JSON.stringify(before.note)}`,
    `- after unplugging ${aLabel}: rows ${JSON.stringify(gone.output)}, selection ${JSON.stringify(gone.chosen)}`,
    `- after unplugging ${aLabel}: note ${JSON.stringify(gone.note)}`,
    `- with no microphone permission asked: microphone rows ${JSON.stringify(states.withheld?.mic)}, output rows ${JSON.stringify(states.withheld?.output)}, note ${JSON.stringify(states.withheld?.note)}`,
    `- with AudioContext.setSinkId deleted (a browser that cannot route output): rows ${JSON.stringify(states.noApi?.output)}, control disabled ${states.noApi?.disabled}, note ${JSON.stringify(states.noApi?.note)}`,
    `- microphone frames the stub harness received from the page: ${micFrames} (${micBytes} bytes)`,
    ``,
    `## Screenshots`,
    ...shots.map((one) => `- ${one}`),
    ``,
    `## Steps`,
    ...steps.map((one) => `- ${one}`),
  ].join("\n");
  writeFileSync(path.join(outDir, "evidence.md"), `${report}\n`);
  console.log(`\n  evidence written to ${path.join(outDir, "evidence.md")}\n`);
} finally {
  await b.close();
  vite.kill("SIGTERM");
  harness.close();
  for (const line of pactl("list", "short", "modules").split("\n")) {
    if (line.includes(`sink_name=${aSink}`) || line.includes(`sink_name=${bSink}`)) pactl("unload-module", line.split("\t")[0]);
  }
  console.log("  cleaned up: browser, vite, stub harness and both null sinks");
}
