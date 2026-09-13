/**
 * **The voice harness's face** — one page, served from `127.0.0.1`, holding a
 * microphone, a meter and a key field.
 *
 * Three rules shape it, and each one is a refusal:
 *
 * - **The page never holds the key.** It posts the key once to the local
 *   harness and never writes it to `localStorage`, a cookie or anywhere else.
 *   The one honest caveat is in the docs: the key transits the page in that
 *   single request, over loopback, and the field is cleared the moment it is
 *   accepted. A local tool may spend that; it must not pretend it did not.
 * - **Capture degrades in a stated order** — `<microphone>`, then
 *   `<usermedia>`, then `getUserMedia` — and the page SAYS which one ran, with
 *   the browser version beside it. "No microphone element" and "no permission"
 *   look identical in a screenshot and mean opposite things.
 * - **The meter is real**, driven by an `AnalyserNode` over the captured
 *   stream, so a screenshot of bars moving is evidence that audio arrived and
 *   a screenshot of silence is evidence it did not.
 *
 * Everything else is a thin client: audio goes to the harness over loopback
 * as WAV, the harness talks to the provider, and the reply comes back as text
 * plus the operations it sent. The page never reaches a provider itself.
 */

/** What the page is told at render time — the facts it cannot ask for, and
 * the ones a person asks first: what is this connected to? */
export interface VoicePageFacts {
  /** The harness's name, for the header. */
  name: string;
  /** The port, so the page can talk to its own harness. */
  port: number;
  /** The canvas operations land on: the title a person says, and the id a
   * bug report needs. */
  canvas: { title: string; id: string };
  /** The daemon this answers to. */
  daemon: string;
  /** The isocan home the daemon is bound to — "which service is this?" */
  home: string;
  /** Who the operations are attributed to, and whether anything can summon
   * them: a microphone speaking under a name is not the same as an enrolled
   * agent, and the difference used to be in a log. */
  agent: { name: string; id: string; enrolled: boolean };
  /** Where the audio goes: which provider, which model, and whether a key is
   * present. Never the key. */
  provider: { name: string | null; model: string; key: boolean };
  /** Which build is running, and when the code behind it was last written —
   * because the confusion this evening was not knowing whether the page in
   * front of you was the old one or the new one. */
  version: string;
  updated: string;
  /** The question waiting for the person, if any — announced on the live
   * socket and kept in `/state`, so a tab that opens later still sees it. */
  confirm?: { id: string; what: string } | null;
}

/**
 * The page's own script, as a string — one template so the HTML and its
 * behaviour cannot drift into two files that disagree.
 *
 * The capture ladder is the interesting part. `HTMLMicrophoneElement` is not
 * in Chrome 152; `HTMLUserMediaElement` is, and it is a real element with
 * `setConstraints`, a `stream` property and an `onstream` event. So a browser
 * that has the declarative element uses it and one that does not falls back —
 * and whichever ran is printed under the meter rather than assumed.
 */
const PAGE_SCRIPT = String.raw`
const facts = JSON.parse(document.getElementById("facts").textContent);
const slot = document.getElementById("mic-slot");

const els = {
  bars: document.getElementById("bars"),
  stop: document.getElementById("stop"),
  state: document.getElementById("state"),
  capture: document.getElementById("capture"),
  skipped: document.getElementById("skipped"),
  meterState: document.getElementById("meter-state"),
  transcript: document.getElementById("transcript"),
  log: document.getElementById("log"),
  text: document.getElementById("typed"),
  send: document.getElementById("send"),
  key: document.getElementById("key"),
  keyState: document.getElementById("key-state"),
  saveKey: document.getElementById("save-key"),
  forgetKey: document.getElementById("forget-key"),
  testKey: document.getElementById("test-key"),
  provider: document.getElementById("provider"),
  version: document.getElementById("version"),
  canvasTitle: document.getElementById("canvas-title"),
  canvasFact: document.getElementById("canvas-fact"),
  canvasFactId: document.getElementById("canvas-fact-id"),
  agentName: document.getElementById("agent-name"),
  confirm: document.getElementById("confirm"),
  confirmWhat: document.getElementById("confirm-what"),
  confirmYes: document.getElementById("confirm-yes"),
  confirmNo: document.getElementById("confirm-no"),
};

const BARS = 28;
for (let i = 0; i < BARS; i++) els.bars.appendChild(document.createElement("i"));
const bars = Array.from(els.bars.children);

const browser = (() => {
  const m = navigator.userAgent.match(/(HeadlessChrome|Chrome)\/([\d.]+)/);
  return m ? m[1] + " " + m[2] : navigator.userAgent;
})();
els.version.textContent = browser;

function say(where, text, kind) {
  const line = document.createElement("div");
  line.className = "line " + (kind ?? "");
  line.textContent = text;
  where.prepend(line);
  while (where.children.length > 40) where.lastChild.remove();
}
function status(text, kind) {
  els.state.textContent = text;
  els.state.className = "state " + (kind ?? "");
}
function meterState(text) {
  els.meterState.textContent = text;
}

/* ---- the harness on loopback ---- */

async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || (r.status + " from the harness"));
  return j;
}

/* ---- the question only a person can answer ----
 *
 * A delete, and anything else the harness holds for consent, waits here. The
 * model cannot press these buttons and neither can a transcript: the answer
 * arrives as a click, and no answer inside a minute is a no. The harness
 * announces the question on the live socket AND keeps it in /state, so a
 * question asked while this tab was closed still appears.
 */
/* ---- which canvas, and who is speaking ----
 *
 * Both move while the session runs: a switch re-points every operation, and a
 * claim renames the agent. Neither is worth a page reload — a reload would
 * throw away the transcript, which is the record of what was said — so both
 * are patched in place, and the poll catches up a tab that was not listening
 * when it happened.
 */
function showCanvas(canvas) {
  if (!canvas) return;
  els.canvasTitle.textContent = canvas.title;
  els.canvasFact.textContent = canvas.title;
  els.canvasFactId.textContent = canvas.id;
}
function showAgent(name) {
  if (name) els.agentName.textContent = name;
}

let asking = null;
function showConfirm(ask) {
  asking = ask && ask.id ? ask : null;
  els.confirm.hidden = !asking;
  if (asking) {
    els.confirmWhat.textContent = asking.what;
    els.confirmYes.focus();
  }
}
async function answer(allow) {
  const ask = asking;
  if (!ask) return;
  showConfirm(null);
  try {
    await post("/confirm", { id: ask.id, allow });
    say(els.log, (allow ? "you allowed: " : "you declined: ") + ask.what, "note");
  } catch (err) {
    say(els.log, String(err.message || err), "bad");
  }
}
els.confirmYes.onclick = () => void answer(true);
els.confirmNo.onclick = () => void answer(false);

async function send(utterance, source) {
  if (!utterance.trim()) return;
  say(els.transcript, utterance, "you " + source);
  status("thinking…", "busy");
  try {
    const out = await post("/utterance", { text: utterance, source });
    if (out.reply) say(els.transcript, out.reply, "agent");
    for (const sent of out.sent || []) say(els.log, sent, "op");
    for (const failed of out.failed || []) say(els.log, failed, "bad");
    status(out.state || "ready", out.failed && out.failed.length ? "warn" : "");
  } catch (err) {
    say(els.log, String(err.message || err), "bad");
    status("the harness refused that", "warn");
  }
}
els.send.onclick = () => { const t = els.text.value; els.text.value = ""; void send(t, "typed"); };
els.text.onkeydown = (e) => { if (e.key === "Enter") els.send.onclick(); };

/* ---- capture ---- */

/*
 * <microphone> when a browser has it; getUserMedia({audio: true, video: false})
 * otherwise. <usermedia> is deliberately NOT a rung: it requests camera AND
 * microphone together, and an audio feature must not prompt for a camera.
 * The getUserMedia path is therefore the PRIMARY path, not a fallback, and its
 * control is always on the page — a slot that fills only on browsers with the
 * declarative element leaves a person with nothing to press.
 */
const CAPTURE = [
  { name: "microphone", tag: "microphone", available: () => typeof window.HTMLMicrophoneElement === "function" },
  { name: "getUserMedia", tag: null, available: () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) },
];
const SKIPPED = typeof window.HTMLUserMediaElement === "function"
  ? "<usermedia> skipped on purpose: it asks for camera and microphone together."
  : "";

let capturePath = null;
let listening = false;
let audio = null;
let live = null;

function pickCapture() {
  if (capturePath) return capturePath;
  for (const path of CAPTURE) if (path.available()) { capturePath = path; return path; }
  return null;
}

async function elementStream(tag) {
  const el = document.createElement(tag);
  const stream = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("<" + tag + "> never handed a stream")), 15000);
    el.onstream = () => { clearTimeout(timer); resolve(el.stream); };
    el.onerror = () => {
      clearTimeout(timer);
      reject(new Error("<" + tag + "> refused: " + (el.error ? el.error.name + ": " + el.error.message : "no reason given")));
    };
  });
  slot.append(el);
  await new Promise((next) => requestAnimationFrame(() => next(null)));
  el.setConstraints({});
  return { stream: await stream, element: el };
}

function meterFrom(stream) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const state = { stream, ctx, analyser, data, raf: 0, peak: 0, level: 0, peakBar: 0 };
  const draw = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
    const instant = Math.min(1, Math.sqrt(sum / data.length) * 6);
    state.level = instant > state.level ? instant : state.level * 0.94;
    state.peak = Math.max(state.peak, instant);
    const lit = Math.round(state.level * BARS);
    state.peakBar = Math.max(state.peakBar, Math.round(state.peak * BARS));
    bars.forEach((bar, i) => {
      const on = i < lit;
      const held = i === state.peakBar - 1 && state.peakBar > lit;
      bar.className = on ? "on" : held ? "peak" : "";
    });
    state.raf = requestAnimationFrame(draw);
  };
  draw();
  return state;
}

const WORKLET_SOURCE = [
  "class Capture extends AudioWorkletProcessor {",
  "  process(inputs) {",
  "    const channel = inputs[0] && inputs[0][0];",
  "    if (channel && channel.length) this.port.postMessage(new Float32Array(channel));",
  "    return true;",
  "  }",
  "}",
  "registerProcessor('capture', Capture);",
].join("\n");
const WORKLET_URL = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));

function resample16k(frames, from, carry) {
  const ratio = from / 16000;
  const input = carry.concat(frames);
  const out = new Int16Array(Math.max(0, Math.floor((input.length - 1) / ratio)));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const low = Math.floor(pos);
    const frac = pos - low;
    const sample = input[low] * (1 - frac) + (input[low + 1] ?? input[low]) * frac;
    out[i] = Math.max(-1, Math.min(1, sample)) * 32767;
  }
  return { pcm: out, rest: input.slice(Math.floor(out.length * ratio)) };
}

let player = null;
function playPcm(bytes, rate) {
  const ctx = player ? player.ctx : (player = { ctx: new (window.AudioContext || window.webkitAudioContext)(), next: 0 }).ctx;
  const samples = new Float32Array(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  const buffer = ctx.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  const at = Math.max(ctx.currentTime, player.next);
  source.start(at);
  player.next = at + buffer.duration;
}

function flatten(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

function wav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

/* The control is built once, and it is always here. */
function armCapture() {
  const path = pickCapture();
  slot.replaceChildren();
  els.capture.textContent = path === null
    ? "capture: no microphone API in this browser"
    : "capture: " + (path.tag ? "<" + path.tag + "> element" : "getUserMedia, audio only") + " · " + browser;
  if (SKIPPED) els.skipped.textContent = SKIPPED;
  const button = document.createElement("button");
  button.id = "mic";
  button.textContent = "🎙 Listen";
  button.onclick = () => void start();
  slot.append(button);
  if (path && path.tag) void start();
}

async function start() {
  if (listening) return;
  const path = pickCapture();
  if (!path) { status("no microphone API in this browser", "warn"); return; }
  meterState("asking for the microphone…");
  let stream;
  try {
    if (path.tag) {
      ({ stream } = await elementStream(path.tag));
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
  } catch (err) {
    const why = String(err.message || err);
    if (path.tag) {
      // The declarative element can refuse; the JS path is right there.
      capturePath = CAPTURE.find((p) => p.tag === null) ?? null;
      els.capture.textContent = "<" + path.tag + "> refused (" + why + ") — using getUserMedia, audio only · " + browser;
      return start();
    }
    els.capture.textContent = "getUserMedia refused: " + why;
    status("the microphone refused", "warn");
    meterState("no microphone");
    return;
  }

  if (audio) { cancelAnimationFrame(audio.raf); try { audio.ctx.close(); } catch {} }
  audio = meterFrom(stream);
  const rate = audio.ctx.sampleRate;
  const session = { stream, rate, carry: [], frames: [], opened: false, socket: null, node: null, source: null, sink: null };
  live = session;

  try {
    await audio.ctx.audioWorklet.addModule(WORKLET_URL);
    const node = new AudioWorkletNode(audio.ctx, "capture");
    const sink = audio.ctx.createGain();
    sink.gain.value = 0;
    const source = audio.ctx.createMediaStreamSource(stream);
    source.connect(node);
    node.connect(sink);
    sink.connect(audio.ctx.destination);
    session.node = node; session.sink = sink; session.source = source;
    node.port.onmessage = (event) => {
      session.frames.push(event.data);
      if (session.frames.length > 1200) session.frames.shift();
      if (session.socket && session.socket.readyState === WebSocket.OPEN) {
        const ratio = rate / 16000;
        session.carry.push(...event.data);
        const whole = Math.floor(session.carry.length / ratio) * ratio;
        if (whole > 0) {
          const pcm = new Int16Array(whole / ratio);
          for (let i = 0; i < pcm.length; i++) {
            let sum = 0;
            for (let j = 0; j < ratio; j++) sum += session.carry[i * ratio + j] ?? 0;
            const value = Math.max(-1, Math.min(1, sum / ratio));
            pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
          }
          session.carry.splice(0, whole);
          if (pcm.length) session.socket.send(pcm.buffer);
        }
      }
    };
  } catch (err) {
    // No worklet here: the meter still works, and the one-shot path still does.
    say(els.transcript, "capture graph fell back to the analyser only — " + String(err.message || err), "note");
  }

  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(scheme + "://" + location.host + "/live");
  session.socket = socket;
  socket.onopen = () => {
    session.opened = true;
    say(els.transcript, "live session open — the harness holds the key and the socket", "note");
  };
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") { playPcm(new Uint8Array(event.data), 24000); return; }
    let message = {};
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.text) say(els.transcript, message.text, "agent");
    if (message.heard) say(els.transcript, message.heard, "you spoken");
    if (message.confirm !== undefined) showConfirm(message.confirm);
    if (message.canvas) showCanvas(message.canvas);
    if (message.agent) showAgent(message.agent.name);
    for (const line of message.sent || []) say(els.log, line, "op");
    for (const line of message.failed || []) say(els.log, line, "bad");
    if (message.state) status(message.state, message.bad ? "warn" : "");
    if (message.live === false) {
      // Said on the face of it: no silent serving of the grammar path behind a
      // credential problem.
      say(els.transcript, "Live session could not start — " + message.state, "bad");
    }
  };
  socket.onclose = () => { if (listening) status("the live session closed", "warn"); };
  socket.onerror = () => status("the live socket could not open — is the harness still running?", "warn");

  listening = true;
  els.stop.hidden = false;
  status("listening", "live");
  meterState("listening — say something, then stop");
}

async function stop() {
  if (!listening) return;
  listening = false;
  els.stop.hidden = true;
  const session = live;
  live = null;
  if (session) {
    try { session.node && session.node.disconnect(); session.source && session.source.disconnect(); session.sink && session.sink.disconnect(); } catch {}
    try { session.socket && session.socket.close(); } catch {}
    session.stream.getTracks().forEach((t) => t.stop());
  }
  const seconds = session ? (session.frames.reduce((n, c) => n + c.length, 0) / (session.rate || 48000)).toFixed(1) : "0";
  meterState("captured " + seconds + "s");
  say(els.transcript, "listening stopped — " + seconds + "s of audio", "note");
  status("ready");
  if (session && !session.opened && session.frames.length) {
    // The socket never opened — no key, or the provider refused it. The audio
    // is still here, so the one-shot path runs rather than losing the take,
    // and whatever the provider says is said verbatim.
    meterState("transcribing " + seconds + "s…");
    try {
      const out = await post("/audio", {
        wav: await wav(flatten(session.frames), session.rate).arrayBuffer(),
        sampleRate: session.rate,
      });
      if (out.text) await send(out.text, "spoken");
      else status(out.reason || out.error || "nothing was heard", "warn");
    } catch (err) {
      status(String(err.message || err), "warn");
    }
  }
}
els.stop.onclick = () => void stop();

/* ---- the key ---- */

els.keyState.textContent = facts.provider.key ? "a " + facts.provider.name + " key is stored" : "no key stored yet";
els.provider.value = facts.provider.name ?? "";
els.saveKey.onclick = async () => {
  const key = els.key.value.trim();
  if (!key) return;
  try {
    const out = await post("/key", { key, provider: els.provider.value || undefined });
    els.key.value = "";
    els.keyState.textContent = "a " + out.provider + " key is stored (" + out.path + ")";
    say(els.log, "key stored by the harness: " + out.provider, "note");
  } catch (err) {
    els.keyState.textContent = String(err.message || err);
  }
};
els.testKey.onclick = async () => {
  els.keyState.textContent = "asking the provider…";
  try {
    const out = await post("/key/test", {});
    els.keyState.textContent = out.ok ? "the provider accepted the key" : "the provider said: " + out.answer;
  } catch (err) {
    els.keyState.textContent = String(err.message || err);
  }
};
els.forgetKey.onclick = async () => {
  try {
    await post("/key", { forget: true });
    els.keyState.textContent = "no key stored";
  } catch (err) {
    els.keyState.textContent = String(err.message || err);
  }
};

meterState("idle — press Listen");
armCapture();

/* ---- auto-reload on source update ---- */
setInterval(async () => {
  try {
    const r = await fetch("/state", { cache: "no-store" });
    if (!r.ok) return;
    const s = await r.json();
    if (s.updated && facts.updated && s.updated !== facts.updated) {
      location.reload();
    }
    // The typed path asks without a live socket, so the question is only ever
    // seen here — and a question answered in another tab disappears here.
    const askId = s.confirm ? s.confirm.id : null;
    if ((asking && asking.id) !== askId) showConfirm(s.confirm || null);
    if (s.canvas && s.canvas.id !== facts.canvas.id) {
      facts.canvas = s.canvas;
      showCanvas(s.canvas);
    }
    if (s.name && s.name !== facts.name) {
      facts.name = s.name;
      showAgent(s.name);
    }
  } catch {}
}, 2500);

`;

/** The whole page. `facts` travels as JSON in a script tag, so the script
 * above can be a plain string with no interpolation to get wrong. */
export function voicePage(facts: VoicePageFacts): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>isocan voice — ${escapeHtml(facts.name)}</title>
<style>
  :root {
    color-scheme: dark;
    --ground: #16181d;
    --card: #1d2026;
    --line: #2b2f37;
    --ink: #e8eaee;
    --dim: #9aa1ad;
    --accent: #1f3fd0;
    --accent-lit: #7d8ff0;
    --good: #56b06a;
    --bad: #e0716a;
    --live: #e07ccb;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: radial-gradient(1200px 600px at 20% 0%, #1b1f27 0%, var(--ground) 60%);
    color: var(--ink);
    font: 15px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: grid;
    /* minmax(0, …) rather than 1fr: a grid track's default minimum is its
       content's min-content width, so one long placeholder or a wide ops line
       pushes the second column off the window. Measured: the key panel was
       clipped by the viewport edge in all three evidence screenshots. */
    grid-template-columns: minmax(0, 1fr) minmax(0, 320px);
    grid-template-rows: auto minmax(0, 1fr);
    gap: 18px;
    padding: 22px 26px 26px;
  }
  main, aside, .panel { min-width: 0; }
  input, select, button { min-width: 0; }
  /*
   * Narrow screens: ONE column, everything full width, nothing competing for
   * room. Paul: "the ui is terrible on a narrower screen" — the two-column
   * layout had no breakpoint, so the key panel was squeezed and the meter
   * fought it for width. The order matters too: what this is connected to,
   * then the microphone, then the key — and the microphone row wraps rather
   * than shrinking the bars.
   */
  @media (max-width: 820px) {
    /*
     * ONE column, and NORMAL FLOW rather than a grid inside a grid. The first
     * attempt kept the two-column grid and re-declared rows, and the aside's
     * three panels painted on top of each other (caught by the vision check on
     * the 420px screenshot, not by me). Nothing here constrains a height:
     * height: auto on the body, display: block on the aside, and the page
     * scrolls like a document. There is nothing left to collapse.
     */
    html, body { height: auto; min-height: 100%; }
    body { display: block; padding: 16px 14px 20px; }
    header { flex-wrap: wrap; gap: 8px 14px; }
    aside { display: block; }
    aside > .panel { margin-bottom: 14px; }
    main { display: block; }
    main > .panel, main > .composer, main > .dock, main > #confirm { margin-bottom: 14px; }
    .dock { display: flex; flex-wrap: wrap; align-items: center; row-gap: 10px; }
    #mic-slot { min-width: 96px; }
    #meter { flex: 1 1 100%; }
    #bars { height: 40px; }
  }

  header { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 14px; }
  header h1 { font-size: 17px; font-weight: 600; margin: 0; letter-spacing: .2px; }
  header .canvas { color: var(--dim); font-size: 13px; }
  header .spacer { flex: 1; }
  .state { font-size: 13px; color: var(--dim); }
  .state.live { color: var(--live); }
  .state.busy { color: var(--accent-lit); }
  .state.warn { color: var(--bad); }
  main { display: flex; flex-direction: column; gap: 16px; min-height: 0; }
  .panel {
    background: color-mix(in oklab, var(--card) 88%, transparent);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 14px 16px;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .panel h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .13em; color: var(--dim); margin: 0 0 10px; font-weight: 600; }
  #transcript { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 7px; }
  .line { font-size: 14px; }
  .line.you { color: var(--ink); }
  .line.you.typed::before { content: "⌨ "; color: var(--dim); }
  .line.you.spoken::before { content: "🎙 "; }
  .line.agent { color: var(--accent-lit); }
  .line.agent::before { content: "→ "; }
  .line.note, .line.op, .line.bad { font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .line.note { color: var(--dim); }
  .line.op { color: var(--good); }
  .line.op::before { content: "sent "; color: var(--dim); }
  .line.bad { color: var(--bad); }
  .line.bad::before { content: "refused "; color: var(--dim); }
  #log { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
  aside { display: flex; flex-direction: column; gap: 16px; min-height: 0; overflow-y: auto; }
  .keyrow { display: flex; gap: 8px; }
  input[type=text], input[type=password], select {
    background: var(--ground); border: 1px solid var(--line); color: var(--ink);
    border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 13px; width: 100%;
  }
  button {
    background: var(--card); color: var(--ink); border: 1px solid var(--line);
    border-radius: 9px; padding: 8px 12px; font: inherit; font-size: 13px; cursor: pointer;
  }
  button:hover { border-color: var(--accent-lit); }
  button.primary { background: var(--accent); border-color: var(--accent); }
  .hint { color: var(--dim); font-size: 12px; margin-top: 8px; overflow-wrap: anywhere; }
  .facts { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px 10px; font-size: 12.5px; }
  .facts dt { color: var(--dim); }
  .facts dd { margin: 0; overflow-wrap: anywhere; }
  .facts .id { color: var(--dim); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
  .facts .warn { color: var(--bad); }
  .composer { display: flex; gap: 8px; }
  /*
   * The mic sits bottom-left, where a thumb and a habit both expect it — and
   * it is IN THE FLOW, not floating over it, which is not a style choice.
   * Chrome 152 refuses a declarative capture element that is occluded or
   * distorted (InvalidStateError: intersection occluded or distorted), and a
   * position:fixed parent is enough to earn that: measured, the same
   * element captures fine in normal flow and refuses inside a fixed dock with
   * a backdrop filter. So the dock is a row of the page and the element is
   * plain and laid out like any other control.
   */
  .dock { display: flex; align-items: center; gap: 14px; padding: 2px 0 0; }
  #mic-slot { min-width: 280px; }
  #meter { flex: 1; min-width: 220px; }
  #mic-slot button {
    min-width: 96px; height: 50px; border-radius: 25px; font-size: 14px; line-height: 1;
    display: inline-flex; align-items: center; justify-content: center; padding: 0 16px; gap: 6px;
    background: linear-gradient(180deg, #262b34, #1b1e24);
    transition: box-shadow .18s ease, transform .12s ease;
  }
  #mic-slot button:active { transform: scale(.97); }
  #stop {
    background: var(--live); border-color: var(--live); color: #241018; font-weight: 600;
  }
  #meter { display: flex; flex-direction: column; gap: 6px; min-width: 220px; }
  /* The question bar. Above the composer because it is the one thing on this
     page that is waiting for a person, and set apart from the panels because
     it is not a log: it is a decision. */
  #confirm {
    display: flex; flex-direction: column; gap: 8px;
    padding: 12px 14px; border: 1px solid var(--accent-lit); border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  #confirm .q { font-size: 14px; }
  #confirm .q span { font-weight: 600; }
  #confirm .row { display: flex; gap: 8px; }
  #bars { display: flex; align-items: flex-end; gap: 3px; height: 34px; }
  #bars i { flex: 1; height: 4px; border-radius: 2px; background: var(--line); transition: height .05s linear, background .05s linear; }
  #bars i.on { height: 30px; background: linear-gradient(180deg, var(--accent-lit), var(--accent)); }
  #bars i.on:nth-child(n+22) { background: linear-gradient(180deg, #f0a0a0, var(--bad)); }
  /* The held peak: the loudest frame since capture started, so a quiet moment
     still says how loud it got. */
  #bars i.peak { height: 22px; background: var(--live); }
  #capture, #version { color: var(--dim); font-size: 11.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  #meter-state { color: var(--ink); font-size: 12.5px; }
</style>
</head>
<body>
<header>
  <h1>isocan voice</h1>
  <span class="canvas" id="canvas-title">${escapeHtml(facts.canvas.title)}</span>
  <span class="spacer"></span>
  <span id="state" class="state">ready</span>
</header>

<main>
  <section class="panel" style="flex: 1.35">
    <h2>Conversation</h2>
    <div id="transcript"></div>
  </section>
  <section class="panel" style="flex: 1">
    <h2>Operations sent, as <span id="agent-name">${escapeHtml(facts.name)}</span></h2>
    <div id="log"></div>
  </section>
  <form class="composer" onsubmit="return false">
    <input id="typed" type="text" placeholder="Type a command — same path as speech: “retitle the second screen to Checkout”" autocomplete="off">
    <button id="send" class="primary">Send</button>
  </form>

  <div id="confirm" hidden role="alertdialog" aria-labelledby="confirm-what">
    <div class="q">Needs your answer — <span id="confirm-what"></span></div>
    <div class="row">
      <button id="confirm-yes" class="primary">Yes, do it</button>
      <button id="confirm-no">No</button>
    </div>
    <div class="hint">Nobody else can answer this: the microphone cannot press a button, and no answer within a minute is a no.</div>
  </div>

  <div class="dock">
    <div id="mic-slot"></div>
    <div id="meter">
      <div id="bars"></div>
      <div id="meter-state">idle — press Listen</div>
      <div id="version"></div>
    </div>
    <button id="stop" hidden>Stop &amp; send</button>
  </div>
</main>

<aside>
  <section class="panel">
    <h2>Connected to</h2>
    <dl class="facts">
      <dt>Canvas</dt><dd><span id="canvas-fact">${escapeHtml(facts.canvas.title)}</span> <span class="id" id="canvas-fact-id">${escapeHtml(facts.canvas.id)}</span></dd>
      <dt>Daemon</dt><dd>${escapeHtml(facts.daemon)}</dd>
      <dt>Home</dt><dd>${escapeHtml(facts.home)}</dd>
      <dt>Agent</dt><dd>${escapeHtml(facts.agent.name)} <span class="id">${escapeHtml(facts.agent.id)}</span>${facts.agent.enrolled ? "" : " <span class=\"warn\">not enrolled — nothing can summon it</span>"}</dd>
      <dt>Audio</dt><dd>${escapeHtml(facts.provider.name ?? "no provider yet")} ${escapeHtml(facts.provider.model)}${facts.provider.key ? "" : " — no key stored"}</dd>
      <dt>Version</dt><dd>${escapeHtml(facts.version)} <span class="id">updated ${escapeHtml(facts.updated)}</span></dd>
    </dl>
  </section>
  <section class="panel">
    <h2>Key — kept by the harness, never by this page</h2>
    <select id="provider">
      <option value="gemini">Gemini</option>
    </select>
    <div style="height:8px"></div>
    <input id="key" type="password" placeholder="paste your Gemini API key" autocomplete="off">
    <div class="keyrow" style="margin-top:8px">
      <button id="save-key">Save key</button>
      <button id="test-key">Test key</button>
      <button id="forget-key">Forget</button>
    </div>
    <div class="hint" id="key-state"></div>
    <div class="hint">Stored 0600 under the harness's own file. This page keeps it in memory for one request and writes it nowhere — no localStorage, no cookie.</div>
  </section>
  <section class="panel">
    <h2>Microphone</h2>
    <div id="capture">capture path: not started yet</div>
    <div class="hint" id="skipped"></div>
    <div class="hint">Preferred order: <code>&lt;microphone&gt;</code>, then <code>&lt;usermedia&gt;</code>, then <code>getUserMedia</code>. Which one ran is stated above, because “no element” and “no permission” look the same and mean opposite things.</div>
  </section>
</aside>

<script type="application/json" id="facts">${JSON.stringify(facts)}</script>
<script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
