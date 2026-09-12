#!/usr/bin/env node
/**
 * **Does the Live API take video frames today? Measure it; do not assume it.**
 *
 * The browser-capability work (`isocan-xsh.8.11`) starts with camera and screen
 * frames going up the same realtime input as audio. The docs describe that
 * input as "one of audio, video, or text"; `mediaChunks` — a carrier this tree
 * once used by accident — is marked deprecated. So the shape that actually
 * works is a fact about today's endpoint, and the only honest way to have it is
 * to open a real session and push frames.
 *
 * What this does, one variable per attempt, in one short session:
 *
 *   A  realtimeInput.video            the current documented shape
 *   C  clientContent with image parts  "frames as images" (docs say this path
 *                                      is for seeding history, not live turns)
 *   B  realtimeInput.mediaChunks       the deprecated carrier — still accepted?
 *   E  realtimeInput.video inside activityStart/activityEnd
 *                                      runs only when A was not accepted, to
 *                                      separate "video rejected" from "nothing
 *                                      triggered a turn"
 *
 * Each attempt sends its own solid-colour synthetic frame (a pure-Node PNG;
 * ffmpeg, a webcam and a display are all absent by design) and then asks what
 * colour it was. A reply that names the colour is the frame arriving; a reply
 * that denies seeing one is the frame being ignored; an error is reported with
 * its code and the message that drew it. The colour differs per attempt, so a
 * late reply still attributes to the frame that caused it.
 *
 * There are no retries. One session, bounded windows, `--live` required
 * because a real Live session spends money. Evidence — frames, every byte
 * sent, every response received — lands in the output directory; the console
 * gets the verdict.
 *
 *   node scripts/voice-video-probe.mjs --live [--model <name>] [--out <dir>]
 *   node scripts/voice-video-probe.mjs --dry-run      # frame synthesis only
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const live = process.argv.includes("--live");
const dryRun = process.argv.includes("--dry-run");
const model = arg("model", "models/gemini-3.1-flash-live-preview");
/**
 * AUDIO, because it is the only combination this model supports: measured
 * 12 Sep 2026, `TEXT` is refused at setup with close 1007 — "The requested
 * combination of response modalities (TEXT) is not supported by the model."
 * The spoken answer is read back through `outputAudioTranscription`.
 */
const modalities = String(arg("modalities", "AUDIO"))
  .split(",")
  .map((one) => one.trim().toUpperCase())
  .filter(Boolean);
const waitMs = Number(arg("wait", "25000"));
/** A ceiling on the whole run, so a wedged socket cannot spend past a session. */
const capMs = Number(arg("cap", "240000"));
const out = path.resolve(
  arg("out", path.join(os.tmpdir(), `isocan-voice-video-probe-${new Date().toISOString().replace(/[:.]/g, "-")}`)),
);
const keyFile = path.resolve(arg("key", path.join(os.homedir(), ".isocan", "voice", "key.json")));

if (!live && !dryRun) {
  console.error(
    "refusing to run without --live: a real Live session spends money at the provider. Use --dry-run to synthesize frames without a socket.",
  );
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = Date.now();
const stamp = () => new Date().toISOString();
const since = () => Date.now() - startedAt;

/* ------------------------------------------------------------------ *
 * The synthetic frame: a solid colour with a white band across the top.
 *
 * PNG, encoded here rather than shelled out to ffmpeg: the probe must run
 * with one command on any machine, and the frame must be byte-identical on
 * every run. A solid colour answers "did the frame arrive"; the white band
 * gives the model something specific to describe, so a reply that mentions
 * "white band" is not luck.
 * ------------------------------------------------------------------ */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, crc]);
};
/** A `width`×`height` RGB PNG, one colour with a white band across the top fifth. */
export function syntheticFrame(width, height, [r, g, b]) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  const band = Math.floor(height / 5);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    const white = y < band;
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 3;
      if (white) {
        raw[at] = 255;
        raw[at + 1] = 255;
        raw[at + 2] = 255;
      } else {
        raw[at] = r;
        raw[at + 1] = g;
        raw[at + 2] = b;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Frames land beside the wire log, so every claim is checkable byte for byte. */
const framesDir = path.join(out, "frames");

/**
 * **JPEG when ffmpeg is here, the built-in PNG when it is not.**
 *
 * Every code sample in the Live API docs sends `image/jpeg`, so JPEG is the
 * payload least likely to trip over a mime type rather than over the carrier
 * being measured; the PNG encoder above keeps the probe runnable on a machine
 * with nothing but Node. The choice is recorded per run, because if a shape
 * does fail, JPEG-or-PNG is the first thing to check.
 */
const haveFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const frameMime = String(arg("mime", haveFfmpeg ? "image/jpeg" : "image/png")).toLowerCase();

function buildFrame(attempt) {
  mkdirSync(framesDir, { recursive: true });
  if (frameMime === "image/jpeg" && haveFfmpeg) {
    const file = path.join(framesDir, `frame-${attempt.id}-${attempt.word}.jpg`);
    const hex = `#${attempt.colour.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "lavfi",
      "-i", `color=c=${hex}:s=768x768`,
      "-vf", "drawbox=x=0:y=0:w=768:h=154:color=white:t=fill",
      "-frames:v", "1",
      "-q:v", "3",
      "-y", file,
    ]);
    return { bytes: readFileSync(file), mime: frameMime, file };
  }
  const file = path.join(framesDir, `frame-${attempt.id}-${attempt.word}.png`);
  const bytes = syntheticFrame(768, 768, attempt.colour);
  writeFileSync(file, bytes);
  return { bytes, mime: "image/png", file };
}

const QUESTION = "What is the dominant colour of the image I just sent? Answer with one word.";

/** The attempts, in the order coord ruled: current shape, then images, then the rest. */
const attempts = [
  { id: "A", shape: "video", label: "realtimeInput.video", colour: [220, 0, 0], word: "red" },
  { id: "C", shape: "images", label: "clientContent image parts", colour: [0, 160, 0], word: "green" },
  { id: "B", shape: "mediaChunks", label: "realtimeInput.mediaChunks (deprecated)", colour: [0, 0, 230], word: "blue" },
  {
    id: "E",
    shape: "videoActivity",
    label: "realtimeInput.video inside activityStart/activityEnd",
    colour: [255, 140, 0],
    word: "orange",
    // Not a retry: a different documented shape. It runs only when A produced
    // no turn at all, because that is the case it distinguishes — "video was
    // rejected" from "nothing told the model the input had finished".
    when: () => (verdicts.get("A") ?? "") !== "accepted",
  },
];

/* ------------------------------------------------------------------ *
 * The session
 * ------------------------------------------------------------------ */
const sentFull = []; // exact bytes, base64 and all
const sentRedacted = [];
const received = [];
const verdicts = new Map();
const notes = new Map();
let socket = null;
let setup = null;

function loadKey() {
  if (!existsSync(keyFile)) {
    console.error(`no key at ${keyFile} — store one from the page's key panel first.`);
    process.exit(2);
  }
  if ((statSync(keyFile).mode & 0o777) !== 0o600) {
    console.error(`${keyFile} is not mode 0600 — fix that before a probe spends with it.`);
    process.exit(2);
  }
  const stored = JSON.parse(readFileSync(keyFile, "utf8"));
  if (stored.provider && stored.provider !== "gemini") {
    console.error(`the stored key is for ${stored.provider}, not gemini — the Live API probe needs a Gemini key.`);
    process.exit(2);
  }
  const key = String(stored.key ?? "").trim();
  if (!key) {
    console.error(`${keyFile} carries no key.`);
    process.exit(2);
  }
  return key;
}

const redact = (value) => {
  if (typeof value === "string") {
    // Base64 payloads are counted, not quoted; every other byte is kept.
    return value.length > 400 ? `<${value.length} chars of base64>` : value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  return value;
};

const record = (dir, attempt, kind, bytes, message, extra = {}) => {
  sentFull.push({ at: stamp(), ms: since(), dir, attempt: attempt?.id ?? null, kind, bytes, message });
  const row = { at: stamp(), ms: since(), dir, attempt: attempt?.id ?? null, kind, bytes, message: redact(message), ...extra };
  if (dir === "sent") sentRedacted.push(row);
  else received.push(row);
  console.log(
    `    ${dir === "sent" ? "→" : "←"} [${attempt?.id ?? "session"}/${kind}] ${bytes} bytes${
      dir === "recv" ? `: ${JSON.stringify(message).slice(0, 160)}` : ""
    }`,
  );
};

const send = (attempt, kind, message) => {
  const text = JSON.stringify(message);
  socket.send(text);
  record("sent", attempt, kind, Buffer.byteLength(text), message);
};

const decode = async (data) => {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data && typeof data.text === "function") return await data.text();
  return "";
};

/** Denials, checked before colour: "I don't see a red image" is not a success. */
const DENIAL = /don'?t see|do not see|can'?t see|cannot see|no image|didn'?t (?:receive|get)|no (?:frame|visual|picture)|not able to see|unable to see/i;

/**
 * Run one attempt: frames up, the question, then a bounded window for the
 * provider's answer. The window closes early on `turnComplete`; a deadline
 * with no model turn is a finding too, and it is recorded as one.
 */
async function runAttempt(attempt) {
  const frame = buildFrame(attempt);
  const base64 = frame.bytes.toString("base64");
  const blob = { data: base64, mimeType: frame.mime };
  console.log(
    `\n  attempt ${attempt.id} — ${attempt.label}\n    frame: ${frame.bytes.length} bytes ${frame.mime} (${attempt.word}), ${base64.length} base64 chars — ${frame.file}`,
  );

  let windowDone = null;
  let resolveWindow;
  const window = new Promise((resolve) => (resolveWindow = resolve));
  const closeWindow = (why) => {
    if (!windowDone) {
      windowDone = why;
      resolveWindow(why);
    }
  };
  // The window is a timer that `finally` clears, not a sleep raced against
  // it: a reply at second three must not leave a 22-second timer holding the
  // process open after the last attempt.
  const timer = setTimeout(() => closeWindow(`no model turn within ${waitMs}ms`), waitMs);
  const texts = [];
  const errors = [];
  let sawTurnComplete = false;

  const onMessage = async (event) => {
    const text = await decode(event.data);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      message = { raw: text.slice(0, 400) };
    }
    record("recv", attempt, "message", Buffer.byteLength(text), message);
    if (message.error) {
      errors.push(message.error);
      closeWindow("error");
      return;
    }
    const content = message.serverContent;
    if (!content) return;
    if (content.outputTranscription?.text) texts.push(content.outputTranscription.text);
    for (const part of content.modelTurn?.parts ?? []) if (part.text) texts.push(part.text);
    if (content.turnComplete) {
      sawTurnComplete = true;
      closeWindow("turnComplete");
    }
  };

  let closed = null;
  const onData = (event) => void onMessage(event);
  const onClose = (event) => {
    closed = { code: event.code, reason: event.reason ?? "" };
    closeWindow(`closed ${event.code}${event.reason ? ` ${event.reason}` : ""}`);
  };
  socket.addEventListener("message", onData);
  socket.addEventListener("close", onClose);

  try {
    if (attempt.shape === "video" || attempt.shape === "videoActivity") {
      if (attempt.shape === "videoActivity") send(attempt, "activityStart", { realtimeInput: { activityStart: {} } });
      // One frame per second — the documented maximum, and the setting that
      // found the silent-turn bug was a rate mismatch, so hold the rate fixed.
      for (let i = 0; i < 3 && !windowDone; i++) {
        send(attempt, "video", { realtimeInput: { video: blob } });
        await sleep(1000);
      }
      if (attempt.shape === "videoActivity") send(attempt, "activityEnd", { realtimeInput: { activityEnd: {} } });
      if (!windowDone) send(attempt, "text", { realtimeInput: { text: QUESTION } });
    } else if (attempt.shape === "mediaChunks") {
      for (let i = 0; i < 3 && !windowDone; i++) {
        send(attempt, "mediaChunks", { realtimeInput: { mediaChunks: [blob] } });
        await sleep(1000);
      }
      if (!windowDone) send(attempt, "text", { realtimeInput: { text: QUESTION } });
    } else if (attempt.shape === "images") {
      // "Frames as images": the question rides with them, one client turn.
      send(attempt, "clientContent", {
        clientContent: {
          turns: [{ role: "user", parts: [{ inlineData: blob }, { inlineData: blob }, { inlineData: blob }, { text: QUESTION }] }],
          turnComplete: true,
        },
      });
    }

    // `window` always resolves — a reply, an error, a close, or the timer.
    await window;
  } finally {
    clearTimeout(timer);
    socket.removeEventListener("message", onData);
    socket.removeEventListener("close", onClose);
  }

  const said = texts.join("").trim();
  // A close the provider chose is a refusal with a code, not an empty reply:
  // `mediaChunks` is dead and the provider says so in its close reason.
  const verdict = errors.length || (closed && closed.code !== 1000)
    ? "error"
    : DENIAL.test(said)
      ? "ignored"
      : said.toLowerCase().includes(attempt.word)
        ? "accepted"
        : "ignored";
  verdicts.set(attempt.id, verdict);
  notes.set(
    attempt.id,
    errors.length
      ? `error ${errors.map((e) => `${e.code ?? ""} ${e.message ?? JSON.stringify(e)}`.trim()).join("; ")}`
      : closed && closed.code !== 1000
        ? `provider closed ${closed.code}${closed.reason ? `: ${closed.reason}` : ""}`
        : said
          ? `said: “${said.slice(0, 300)}”${sawTurnComplete ? "" : " (no turnComplete)"}`
          : `no readable reply (${windowDone && !windowDone.startsWith("no model turn") ? windowDone : `${waitMs}ms with no model turn`})`,
  );
  console.log(`    verdict: ${verdict.toUpperCase()} — ${notes.get(attempt.id)}`);
  return verdict;
}

function report() {
  const lines = [];
  lines.push(`# Voice video probe — ${stamp()}`);
  lines.push("");
  lines.push(`- model: \`${model}\` — output modalities: ${modalities.join(", ")}`);
  lines.push(`- frames: ${frameMime} at 768×768, 1 fps, synthetic`);
  lines.push(`- run: ${since()}ms, attempts: ${[...verdicts.entries()].map(([id, v]) => `${id}=${v}`).join(", ") || "none"}`);
  lines.push("");
  lines.push("| attempt | shape | sent | verdict | what came back |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const attempt of attempts) {
    if (!verdicts.has(attempt.id)) continue;
    const sent = sentFull.filter((r) => r.dir === "sent" && r.attempt === attempt.id);
    const bytes = sent.reduce((n, r) => n + r.bytes, 0);
    lines.push(
      `| ${attempt.id} | ${attempt.label} | ${sent.length} messages, ${bytes} bytes | **${verdicts.get(attempt.id)}** | ${notes.get(attempt.id)} |`,
    );
  }
  lines.push("");
  const overall = ["A", "C", "B", "E"].map((id) => `${id}=${verdicts.get(id) ?? "untested"}`).join(" ");
  lines.push(`**verdict:** ${overall}`);
  return lines.join("\n");
}

async function main() {
  mkdirSync(out, { recursive: true });

  if (dryRun) {
    console.log(`  frame encoder: ${frameMime}${frameMime === "image/jpeg" ? " (ffmpeg)" : " (built-in PNG)"}`);
    for (const attempt of attempts) {
      const frame = buildFrame(attempt);
      console.log(`  ${attempt.id}: ${frame.bytes.length} bytes ${frame.mime}, ${attempt.word} — ${frame.file}`);
    }
    console.log(`  dry run: frames synthesized in ${framesDir}; nothing sent.`);
    return;
  }

  const key = loadKey();
  const url =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
    `?key=${encodeURIComponent(key)}`;
  console.log(`  key: read from ${keyFile} (mode 0600, value never printed)`);
  console.log(`  output: ${out}`);

  socket = new WebSocket(url);
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("the live socket refused to open")), { once: true });
  });
  await opened;
  console.log("  socket: open");

  const complete = new Promise((resolve, reject) => {
    const finish = (work) => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      work();
    };
    const onMessage = (event) => {
      void (async () => {
        const text = await decode(event.data);
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          record("recv", null, "unparseable", Buffer.byteLength(text), { raw: text.slice(0, 400) });
          return;
        }
        record("recv", null, "setup", Buffer.byteLength(text), message);
        if (message.setupComplete) finish(() => resolve(message.setupComplete));
        if (message.error) finish(() => reject(new Error(`setup rejected: ${JSON.stringify(message.error)}`)));
      })();
    };
    // A silent setup is usually a close frame with no JSON before it, so the
    // close and error events are findings too — not an absence to time out on.
    const onClose = (event) => {
      record("recv", null, "close", 0, { code: event.code, reason: event.reason ?? "" });
      finish(() => reject(new Error(`socket closed before setupComplete: ${event.code}${event.reason ? ` ${event.reason}` : ""}`)));
    };
    const onError = (event) => {
      const why = event?.message ?? event?.error?.message ?? "socket error";
      record("recv", null, "error", 0, { error: String(why) });
      finish(() => reject(new Error(`socket error before setupComplete: ${why}`)));
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`no setupComplete within ${waitMs}ms`))), waitMs);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
  // AUDIO with transcription: this probe reads the answer, and the model
  // refuses a text-only combination (see `modalities` above).
  setup = {
    setup: {
      model,
      generationConfig: { responseModalities: modalities },
      ...(modalities.includes("AUDIO") ? { outputAudioTranscription: {} } : {}),
    },
  };
  send(null, "setup", setup);
  try {
    await complete;
  } catch (err) {
    const why = String(err.message ?? err);
    console.error(`  ${why}`);
    console.error("  verdict: SETUP FAILED — nothing about video can be learned from this run.");
    writeFileSync(path.join(out, "probe.json"), JSON.stringify({ at: stamp(), model, modalities, setup, error: why, received }, null, 2));
    process.exitCode = 3;
    try {
      socket.close(1000, "setup rejected");
    } catch {}
    return;
  }
  console.log("  session: setupComplete");

  for (const attempt of attempts) {
    if (since() > capMs) {
      verdicts.set(attempt.id, "untested");
      notes.set(attempt.id, `session cap of ${capMs}ms reached`);
      continue;
    }
    if (attempt.when && !attempt.when()) {
      verdicts.set(attempt.id, "untested");
      notes.set(attempt.id, "skipped — attempt A was accepted, so the trigger question is already answered");
      continue;
    }
    if (socket.readyState !== 1) {
      verdicts.set(attempt.id, "untested");
      notes.set(attempt.id, "skipped — the session closed before this attempt");
      continue;
    }
    await runAttempt(attempt);
    await sleep(1500);
  }

  try {
    socket.close(1000, "probe done");
  } catch {}
  await sleep(250);
  const text = report();
  writeFileSync(path.join(out, "report.md"), text + "\n");
  writeFileSync(path.join(out, "probe.json"), JSON.stringify({ at: stamp(), model, modalities, setup, frames: framesDir, sent: sentRedacted, received, verdicts: Object.fromEntries(verdicts), notes: Object.fromEntries(notes) }, null, 2));
  writeFileSync(path.join(out, "wire.jsonl"), sentFull.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\n${text}`);
  console.log(`\n  evidence: ${path.join(out, "report.md")}, wire.jsonl (exact bytes), frames/`);
}

await main();
