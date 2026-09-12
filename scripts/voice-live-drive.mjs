#!/usr/bin/env node
/**
 * **The whole path, driven: speech -> page -> harness -> Live API -> an
 * operation on a canvas.**
 *
 * Every other voice check in this tree stops one hop short. `voice-evidence.mjs`
 * drives the page with no key and types the utterance: it proves the page and
 * the operations, and says nothing about whether audio reaches a model. The
 * silent-turn probe went the other way — a bespoke socket adapter proved the
 * provider answers synthesized speech, but not the page, not the harness, not
 * the operations.
 *
 * This runs the shipped path end to end, in one process tree:
 *
 *   Chrome (fake capture device, a synthesized speech WAV, the real
 *   getUserMedia path) -> the Vite page at /voice, through the committed
 *   /harness proxy -> `isocan voice` as a person starts it -> the Gemini Live
 *   socket -> a tool call -> an operation on a real daemon -> the canvas.
 *
 * What is real: the page, the proxy, the harness, the provider (a real key
 * from ~/.isocan/voice/key.json, a real Live session), the daemon, the canvas,
 * the op and its oplog seq. What is synthetic: the speech (local eSpeak-NG, no
 * cloud synthesis) and the microphone (an agent has no mouth, so Chrome's fake
 * capture device plays the WAV through the same getUserMedia path a hardware
 * mic takes). The home is a temp directory: a run cannot touch anybody's work.
 *
 * A run spends money at the provider, so it refuses to start without `--live`.
 * `--probe` is the cheap sibling: the same page and the same capture, no key
 * and no provider, measuring only what the page puts on the wire — the number
 * that named the silent turn, and the one to read before spending a session.
 *
 *   node scripts/voice-live-drive.mjs --speech <wav> --live  [--out <dir>] [--ui <dir>]
 *   node scripts/voice-live-drive.mjs --speech <wav> --probe [--out <dir>] [--ui <dir>]
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";
import { browser, until } from "./lib/browser.mjs";

// The bin's own trick: register tsx so the workspace's TypeScript sources
// import directly. Dynamic, because a static import would resolve first.
register();
const { startDaemon } = await import("@isocan/server");

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "packages", "cli", "bin", "isocan.js");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const live = process.argv.includes("--live");
const probe = process.argv.includes("--probe");
const speech = arg("speech", null);
/** Where the speech sits in the fixture, in ms from the capture's start. */
const windowMs = (arg("window", "2000-5500") ?? "2000-5500").split("-").map(Number);
const ui = path.resolve(arg("ui", path.join(os.homedir(), "worktrees", "isocan-voice-ui")));
const out = path.resolve(arg("out", path.join(repo, "reports", "voice-live")));
const keyFile = path.join(os.homedir(), ".isocan", "voice", "key.json");

if (!live && !probe) {
  console.error("refusing to run without --live: a real Live session spends money at the provider. Use --probe to measure the page's audio without one.");
  process.exit(2);
}
if (!speech || !existsSync(speech)) {
  console.error("--speech <wav> is required: a 16-bit PCM WAV of speech, played through the capture device.");
  process.exit(2);
}
if (live) {
  if (!existsSync(keyFile)) {
    console.error(`no key at ${keyFile} — store one from the page's key panel first.`);
    process.exit(2);
  }
  if ((statSync(keyFile).mode & 0o777) !== 0o600) {
    console.error(`${keyFile} is not mode 0600. Fix that before driving with it.`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
const step = (line) => {
  steps.push(line);
  console.log(`  ${line}`);
};
const json = async (url, init) => {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};
const gitRev = (dir) => {
  const r = spawn("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  r.stdout.on("data", (d) => (out += d));
  return out.trim();
};

const home = mkdtempSync(path.join(os.tmpdir(), "isocan-voice-live-"));
mkdirSync(out, { recursive: true });
writeFileSync(path.join(home, "identity.json"), JSON.stringify({ id: "usr_person", name: "Person", createdAt: new Date().toISOString() }));
const tapFile = path.join(out, "provider-tap.mjs");
const wireFile = path.join(out, "provider-wire.jsonl");

let daemon, voice, vite, b;
const harnessLines = [];
const events = [];
const startedAt = Date.now();
/** Every binary frame the page put on the /harness/audio socket. */
const pageFrames = [];
const socketUrls = new Map();

/**
 * **Is the voice intact, or only present?**
 *
 * RMS and zeros answer "did anything arrive". They cannot answer "did it
 * arrive WHOLE" — a stream with a hole in every word still has a healthy RMS.
 * So this walks the frames' own clock: each frame carries `bytes / 32`
 * milliseconds of audio (16 samples per millisecond at 16 kHz), and any
 * interval that carried less than its clock says is a gap the provider had to
 * guess through.
 */
function gapStats(frames) {
  if (frames.length < 3) return { intervals: 0, worstGapMs: 0, missingMs: 0, gapsOver20ms: 0 };
  let worstGapMs = 0;
  let missingMs = 0;
  let gapsOver20ms = 0;
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i].at - frames[i - 1].at;
    const carried = frames[i - 1].data.length / 32;
    const missing = dt - carried;
    if (missing > 2) {
      missingMs += missing;
      if (missing > 20) gapsOver20ms++;
      worstGapMs = Math.max(worstGapMs, missing);
    }
  }
  return { intervals: frames.length - 1, worstGapMs: Math.round(worstGapMs), missingMs: Math.round(missingMs), gapsOver20ms };
}

/** What the page's own PCM says: zeros and RMS are how a silent turn is named. */
function pageStats(frames) {
  const pcm = Buffer.concat(frames.map((f) => f.data));
  const n = pcm.length / 2;
  let zeros = 0;
  let energy = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const v = pcm.readInt16LE(i) / 0x8000;
    if (v === 0) zeros++;
    energy += v * v;
  }
  return {
    frames: frames.length,
    bytes: pcm.length,
    secondsAt16k: pcm.length / 32000,
    zeroFraction: n ? zeros / n : 1,
    rms: n ? Math.sqrt(energy / n) : 0,
  };
}

/**
 * **The same numbers, over the window the speech is actually in.**
 *
 * The whole capture is mostly silence at both ends — the fixture carries a
 * lead-in and a long tail — so a whole-run zero fraction says almost nothing
 * about whether the resampler preserved a voice. Astra's silent-turn probe
 * compared the two windows for exactly this reason, and the window is where
 * the answer lives.
 */
function speechStats(frames, fromMs = windowMs[0], toMs = windowMs[1]) {
  const first = frames[0]?.at ?? 0;
  return pageStats(frames.filter((f) => f.at - first >= fromMs && f.at - first <= toMs));
}

/**
 * **The provider wire, recorded by wrapping the global WebSocket.**
 *
 * The harness is a child process, so its socket cannot be read from here — but
 * `node --import` can wrap the constructor before the harness ever runs. It
 * observes and changes nothing: the same frames go out at the same moment.
 * Audio payloads are counted, never kept — the wire carries the person's
 * voice, and a debuggable log is not a recording.
 */
const TAP = `
import { appendFileSync } from "node:fs";
const file = process.env.VOICE_TAP;
const write = (record) => { try { appendFileSync(file, JSON.stringify(record) + "\\n"); } catch {} };
const Native = globalThis.WebSocket;
globalThis.WebSocket = class extends Native {
  constructor(url, protocols) {
    super(url, protocols);
    write({ at: Date.now(), event: "opening", url: String(url).split("?")[0] });
    this.addEventListener("message", (event) => {
      // Messages arrive as text or as binary; the provider's JSON is what is
      // worth keeping, so decode both shapes rather than recording "0 bytes".
      const data = event.data;
      const show = (text) => write({ at: Date.now(), event: "received", bytes: text?.length ?? 0, text: text?.slice(0, 1200) });
      if (typeof data === "string") show(data);
      else if (data instanceof ArrayBuffer) show(Buffer.from(data).toString("utf8"));
      else if (ArrayBuffer.isView(data)) show(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"));
      else if (data?.text) data.text().then(show, () => show(null));
      else show(null);
    });
    this.addEventListener("close", (event) => write({ at: Date.now(), event: "closed", code: event.code, reason: event.reason }));
    this.addEventListener("error", () => write({ at: Date.now(), event: "error" }));
  }
  send(data) {
    if (typeof data === "string") {
      let shape = { kind: "unreadable", bytes: data.length };
      try {
        const message = JSON.parse(data);
        if (message.setup) shape = { kind: "setup", model: message.setup.model, tools: message.setup.tools?.[0]?.functionDeclarations?.length };
        else if (message.realtimeInput?.audio) shape = { kind: "audio", samples: Buffer.from(message.realtimeInput.audio.data, "base64").byteLength / 2 };
        else if (message.toolResponse) shape = { kind: "toolResponse", names: message.toolResponse.functionResponses?.map((r) => r.name) };
        else shape = { kind: "other", keys: Object.keys(message) };
      } catch {}
      write({ at: Date.now(), event: "sent", ...shape });
    } else {
      write({ at: Date.now(), event: "sent", kind: "binary", bytes: data?.byteLength ?? data?.length ?? 0 });
    }
    return super.send(data);
  }
};
`;

/** The tap file, read back as a short summary rather than thousands of lines. */
function wireSummary(file) {
  if (!existsSync(file)) return { records: 0 };
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const sent = rows.filter((r) => r.event === "sent");
  return {
    records: rows.length,
    sentByKind: sent.reduce((all, r) => ({ ...all, [r.kind]: (all[r.kind] ?? 0) + 1 }), {}),
    audioSamples: sent.filter((r) => r.kind === "audio").reduce((n, r) => n + r.samples, 0),
    received: rows.filter((r) => r.event === "received").map((r) => ({ at: r.at, bytes: r.bytes, text: r.text })),
    setup: sent.find((r) => r.kind === "setup"),
    closed: rows.find((r) => r.event === "closed") ?? null,
  };
}

async function main() {
  try {
    /* A real daemon on a throwaway home, and a canvas with something on it —
       so a read has an answer and a write has somewhere to land. */
    daemon = await startDaemon({ port: 0, contentPort: 0, home, auth: null, birthHome: null });
    const base = `http://127.0.0.1:${daemon.app.server.address().port}`;
    const { mintTestBadge } = await import(path.join(repo, "packages", "cli", "test", "badge.ts"));
    const badge = await mintTestBadge(base);
    const seeder = { id: "usr_seeder", name: "Seeder" };
    await badge.speakAs(seeder);
    const push = (canvasId, op, actor = seeder) =>
      fetch(`${base}/api/ops`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...badge.headers },
        body: JSON.stringify({ canvasId, actor, op }),
      }).then((r) => r.json());
    const canvasId = "prj_voice_drive";
    await push(null, { type: "project.create", canvasId, title: "Voice drive" });
    for (const [id, title, x] of [["itm_alpha", "Alpha note", 100], ["itm_beta", "Beta note", 520]]) {
      await push(canvasId, {
        type: "item.add",
        itemId: id,
        version: { id: `ver_${id}`, blobHash: `h_${id}`, mimeType: "text/markdown", filename: `${id}.md`, size: 3 },
        width: 320,
        height: 240,
        placement: { x, y: 100 },
        title,
      });
    }
    step(`daemon: real, on a temp home, canvas “Voice drive” (${canvasId}) with 2 items`);
    /* What the canvas was before anything spoke: the "landed" claim is only
       meaningful against a seq cursor taken here. */
    const before = await json(`${base}/api/projects/${canvasId}/canvas`, { headers: badge.headers });

    /* The provider key, copied into the run's home and never printed. The
       harness is the only thing that reads it; the page never sees it. */
    if (!probe) {
      mkdirSync(path.join(home, "voice"), { recursive: true, mode: 0o700 });
      writeFileSync(path.join(home, "voice", "key.json"), readFileSync(keyFile), { mode: 0o600 });
      step("key: stored in the run's home from ~/.isocan/voice/key.json (mode 0600, value never printed)");
    }

    /* The agent, then the harness as a person starts it. The session identity
       dance is today's reality (`--session` plus two env vars); the rc
       integration is the change that removes it. */
    if (!probe) writeFileSync(tapFile, TAP);
    const childEnv = {
      ...process.env,
      ISOCAN_HOME: home,
      ISOCAN_PORT: String(new URL(base).port),
      ISOCAN_SESSION_ID: "Voice",
      ISOCAN_HARNESS: "agent",
      ...(probe
        ? {}
        : {
            VOICE_TAP: wireFile,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${pathToFileURL(tapFile).href}`].filter(Boolean).join(" "),
          }),
    };
    await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [cli, "identity", "--name", "Voice", "--session"], { cwd: repo, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      let why = "";
      c.stdout.on("data", (d) => (why += d));
      c.stderr.on("data", (d) => (why += d));
      c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`isocan identity exited ${code}:\n${why}`))));
    });

    const voicePort = 7600 + Math.floor(Math.random() * 300);
    voice = spawn(process.execPath, [cli, "voice", "--voice-port", String(voicePort), "--canvas", canvasId], {
      cwd: repo,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let voiceOut = "";
    voice.stdout.setEncoding("utf8");
    voice.stderr.setEncoding("utf8");
    voice.stdout.on("data", (d) => {
      voiceOut += d;
      for (const line of String(d).split("\n")) if (line.trim()) harnessLines.push({ at: Date.now(), line: line.trim() });
    });
    voice.stderr.on("data", (d) => (voiceOut += d));
    const voiceUrl = `http://127.0.0.1:${voicePort}/`;
    {
      const deadline = Date.now() + 30_000;
      while (!voiceOut.includes(voiceUrl) && Date.now() < deadline) await sleep(100);
      if (!voiceOut.includes(voiceUrl)) throw new Error(`the harness never said it was listening:\n${voiceOut}`);
    }
    step(`harness: real \`isocan voice\`, listening at ${voiceUrl}`);

    /* One cheap authenticated call first, so a bad key is found before a Live
       session rather than during one — and in the provider's own words. */
    if (!probe) {
      const keyCheck = await json(`${voiceUrl}key/test`, { method: "POST" });
      if (!keyCheck.ok) throw new Error(`the provider refused the stored key: ${keyCheck.answer}`);
      step("key: the provider accepted it (one cheap authenticated call)");
    }

    /* The page, served by its own Vite config — the committed /harness proxy is
       part of what is being proven, so it is kept and only pointed at this
       run's harness port. */
    const { createServer } = await import(path.join(ui, "node_modules", "vite", "dist", "node", "index.js"));
    vite = await createServer({
      root: path.join(ui, "packages", "web"),
      configFile: path.join(ui, "packages", "web", "vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: 5200 + Math.floor(Math.random() * 200),
        strictPort: true,
        proxy: { "/harness": { target: voiceUrl, changeOrigin: true, ws: true, rewrite: (p) => p.replace(/^\/harness/, "") } },
      },
    });
    await vite.listen();
    const pageUrl = `http://127.0.0.1:${vite.httpServer.address().port}/voice`;
    step(`page: real Vite page at ${pageUrl} (${ui} @ ${gitRev(ui)})`);

    /* A real Chrome, with a synthetic microphone: the WAV is played through the
       device the page's getUserMedia call actually opens. */
    b = await browser({
      flags: [
        "--window-size=1440,900",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-audio-capture=${speech}%noloop`,
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    step(`browser: ${b.version?.product ?? "chrome"} — fake capture device playing ${path.basename(speech)}`);

    /* The audio the page actually put on the wire, frame by frame: the two
       numbers that name a silent turn, taken before anything interprets them. */
    b.on("Network.webSocketCreated", (p) => socketUrls.set(p.requestId, p.url));
    b.on("Network.webSocketFrameSent", (p) => {
      // A frame's opcode and payload live under `response` in CDP; reading
      // them off the event itself silently answers `undefined` for every
      // frame, which is a measurement that lies in the shape of a finding.
      const frame = p.response ?? {};
      if (frame.opcode === 2 && String(socketUrls.get(p.requestId) ?? "").includes("/harness/audio")) {
        pageFrames.push({ at: Date.now(), data: Buffer.from(frame.payloadData, "base64") });
      }
    });
    await b.send("Network.enable");

    const shot = async (name) => {
      const { data } = await b.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, "base64"));
    };

    const loaded = b.once("Page.loadEventFired");
    await b.send("Page.navigate", { url: pageUrl });
    await loaded;
    await until(b, `document.getElementById("canvas-title")?.textContent === "Voice drive"`, "the page to show its canvas", 20_000);
    await shot("01-ready");

    /* A real click on the real button, at the place a person would press. */
    const box = await b.ev(`(() => { const r = document.getElementById("listen").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await b.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    step("listen: pressed the page's Listen button");

    if (probe) {
      /* No provider, no key, no money: just what the page puts on the wire. */
      await sleep(14_000);
      const stats = pageStats(pageFrames);
      const speechWindow = speechStats(pageFrames);
      const gaps = gapStats(pageFrames);
      const words = await b.ev(`document.getElementById("state")?.textContent ?? ""`);
      writeFileSync(path.join(out, "page-input.s16"), Buffer.concat(pageFrames.map((f) => f.data)));
      await shot("01-capture");
      writeFileSync(
        path.join(out, "probe.json"),
        JSON.stringify({ at: new Date().toISOString(), speech: path.basename(speech), pageState: words, pageAudio: stats, speechWindow, gaps }, null, 2),
      );
      step(`probe: ${stats.frames} frames, ${stats.bytes} bytes (${stats.secondsAt16k.toFixed(1)}s at 16 kHz), zero-sample fraction ${stats.zeroFraction.toFixed(5)}, RMS ${stats.rms.toFixed(4)}`);
      step(`probe/speech: zero-sample fraction ${speechWindow.zeroFraction.toFixed(5)}, RMS ${speechWindow.rms.toFixed(4)} over ${speechWindow.secondsAt16k.toFixed(1)}s`);
      step(`probe/continuity: worst gap ${gaps.worstGapMs}ms, ${gaps.gapsOver20ms} gaps over 20ms, ${gaps.missingMs}ms missing in total`);
      if (speechWindow.rms < 0.005) throw new Error("the page sent silence where the speech is — the capture path is broken before the provider");
      return;
    }

    const callAt = Date.now();
    const logOf = async () => (await json(`${voiceUrl}log`)).entries ?? [];
    const waitFor = async (what, test, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const value = await test().catch(() => null);
        if (value) return value;
        await sleep(500);
      }
      throw new Error(`timed out waiting for ${what}`);
    };

    const seen = await waitFor(
      "the live session to open",
      async () => (await logOf()).find((e) => e.event === "setup_complete") ?? null,
      30_000,
    );
    step(`live: session open (setup_complete at ${seen.timestamp}), listening while the WAV plays`);

    /* The turn boundary and the tool call, both as the provider reported them:
       this is what a silent session never produces and the whole drive exists
       to see. */
    const turnAt = await waitFor(
      "a turn boundary (serverContent.turnComplete) in the harness log",
      async () => (await logOf()).find((e) => e.event === "turn_complete")?.timestamp ?? null,
      90_000,
    );
    step(`turn: the provider closed a turn at ${turnAt}`);
    const call = await waitFor(
      "a tool call in /log",
      async () => (await logOf()).find((e) => e.name && e.timestamp >= new Date(callAt).toISOString()) ?? null,
      30_000,
    );
    step(`tool call: ${call.name} ${JSON.stringify(call.args ?? {})} -> ${call.op ? `${call.op.type}: ${call.op.said ?? ""}` : "no operation"}`);
    step(`daemon: ${call.result?.ok === false ? `refused — ${call.result.error}` : (call.result?.answer?.ack ?? call.result?.ack ?? "acknowledged")}`);
    await shot("02-tool-call");

    /* The canvas itself, not the log: the op has to be ON it, with a seq and an
       actor, or "landed" means nothing. */
    const snapshot = await json(`${base}/api/projects/${canvasId}/canvas`, { headers: badge.headers });
    const oplog = await json(`${base}/api/projects/${canvasId}/oplog`, { headers: badge.headers });
    const items = Object.values(snapshot.canvas?.items ?? {});
    const landed = oplog.filter((e) => e.envelope?.actor?.name === "Voice" && e.seq > (before.lastSeq ?? 0));
    step(`canvas: ${items.length} items now — ${items.map((i) => i.title).join(", ")}`);
    step(`oplog: ${landed.length} op(s) as Voice this run — ${landed.map((e) => `seq ${e.seq} ${e.envelope?.op?.type}`).join(", ") || "none"}`);
    writeFileSync(path.join(out, "canvas-after.json"), JSON.stringify({ snapshot, oplog }, null, 2));

    const endBox = await b.ev(`(() => { const r = document.getElementById("end").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await b.send("Input.dispatchMouseEvent", { type, x: endBox.x, y: endBox.y, button: "left", clickCount: 1 });
    }
    await sleep(1500);

    const evidence = {
      at: new Date().toISOString(),
      run: out,
      real: { page: `${ui} @ ${gitRev(ui)}`, harness: repo, daemon: base, provider: "gemini live", key: "~/.isocan/voice/key.json (never printed)" },
      synthetic: { speech, sha256: createHash("sha256").update(readFileSync(speech)).digest("hex"), microphone: "chrome fake capture device" },
      browser: b.version?.product,
      // The page's own PCM, kept: every claim about the audio above is
      // checkable against the bytes the page actually sent.
      pageInput: (() => {
        writeFileSync(path.join(out, "page-input.s16"), Buffer.concat(pageFrames.map((f) => f.data)));
        return "page-input.s16";
      })(),
      pageAudio: pageStats(pageFrames),
      speechWindow: speechStats(pageFrames),
      gaps: gapStats(pageFrames),
      pageState: await b.ev(`document.getElementById("state").textContent`),
      turn: turnAt,
      toolCall: call,
      canvas: { before: Object.values(before.canvas?.items ?? {}).map((i) => i.title), after: items.map((i) => ({ id: i.id, title: i.title })) },
      oplogAsVoice: landed.map((e) => ({ seq: e.seq, type: e.envelope?.op?.type, at: e.envelope?.at })),
      providerWire: wireSummary(wireFile),
      harnessLines,
    };
    writeFileSync(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
    writeFileSync(path.join(out, "evidence.md"), render(evidence));
    step(`evidence: ${path.join(out, "evidence.md")}`);

    if (landed.length === 0) throw new Error("the model called a tool but no operation landed on the canvas as Voice");
  } catch (err) {
    /* Say what the harness and the page said, rather than only that a wait
       ended: a session that never opens has a reason and both surfaces have it. */
    console.error(`  harness last lines:\n    ${harnessLines.slice(-12).map((l) => l.line).join("\n    ")}`);
    if (b) {
      const complaint = await b.ev(`document.getElementById("complaint")?.textContent ?? ""`).catch(() => "");
      const stateWord = await b.ev(`document.getElementById("state")?.textContent ?? ""`).catch(() => "");
      const pageLog = await b.ev(`document.getElementById("log")?.textContent?.slice(0, 400) ?? ""`).catch(() => "");
      console.error(`  page state: ${stateWord}\n  page complaint: ${complaint}\n  page log: ${pageLog}`);
    }
    writeFileSync(path.join(out, "harness-output.txt"), harnessLines.map((l) => l.line).join("\n"));
    if (pageFrames.length) writeFileSync(path.join(out, "page-input.s16"), Buffer.concat(pageFrames.map((f) => f.data)));
    writeFileSync(
      path.join(out, "partial.json"),
      JSON.stringify(
        { at: new Date().toISOString(), error: String(err?.message ?? err), pageAudio: pageStats(pageFrames), speechWindow: speechStats(pageFrames), providerWire: wireSummary(wireFile) },
        null,
        2,
      ),
    );
    events.push({ at: Date.now(), error: String(err?.stack ?? err) });
    throw err;
  } finally {
    writeFileSync(path.join(out, "events.json"), JSON.stringify({ startedAt, endedAt: Date.now(), events }, null, 2));
    if (b) await b.close().catch(() => {});
    if (vite) await vite.close().catch(() => {});
    if (voice) voice.kill("SIGTERM");
    if (daemon) await daemon.close().catch(() => {});
  }
}

/** The run, written down: what ran, what the provider said, what landed. */
function render(e) {
  return [
    `# Voice, live — ${e.at}`,
    "",
    "A real Chrome, playing a synthesized utterance through the capture device,",
    "drove the real Vite page (`/voice`, through its committed `/harness` proxy),",
    "the real `isocan voice` harness, a real Gemini Live session with the key at",
    "`~/.isocan/voice/key.json`, and a real daemon on a throwaway home.",
    "",
    `- browser: ${e.browser}`,
    `- page: ${e.real.page}`,
    `- speech: ${path.basename(e.synthetic.speech)} (${e.synthetic.sha256.slice(0, 12)}…), synthesized locally, no cloud TTS`,
    `- audio the page sent: ${e.pageAudio.frames} frames, ${e.pageAudio.secondsAt16k.toFixed(1)}s at 16 kHz, zero-sample fraction ${e.pageAudio.zeroFraction.toFixed(5)}, RMS ${e.pageAudio.rms.toFixed(4)}`,
    `- turn boundary: ${e.turn}`,
    `- tool call: \`${e.toolCall.name} ${JSON.stringify(e.toolCall.args ?? {})}\``,
    `- operation: ${e.toolCall.op ? `${e.toolCall.op.type} — ${e.toolCall.op.said}` : "none minted"}`,
    `- canvas after: ${e.canvas.after.map((i) => i.title).join(", ")}`,
    `- canvas before: ${e.canvas.before.join(", ")}`,
    `- oplog as Voice: ${e.oplogAsVoice.map((o) => `seq ${o.seq} ${o.type}`).join(", ") || "none"}`,
    "",
    "## Steps",
    "",
    ...steps.map((l) => `- ${l}`),
    "",
  ].join("\n");
}

await main();
