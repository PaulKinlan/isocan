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

/** What the page is told at render time — the facts it cannot ask for. */
export interface VoicePageFacts {
  /** The harness's name, for the header. */
  name: string;
  /** The canvas the operations will land on, as a person would say it. */
  canvas: string;
  /** Whether a key is already stored, and which provider it is for. */
  key: { provider: string } | null;
  /** The port, so the page can talk to its own harness. */
  port: number;
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
  meter: document.getElementById("meter"),
  bars: document.getElementById("bars"),
  slot: document.getElementById("mic-slot"),
  stop: document.getElementById("stop"),
  state: document.getElementById("state"),
  capture: document.getElementById("capture"),
  transcript: document.getElementById("transcript"),
  log: document.getElementById("log"),
  text: document.getElementById("typed"),
  send: document.getElementById("send"),
  key: document.getElementById("key"),
  keyState: document.getElementById("key-state"),
  saveKey: document.getElementById("save-key"),
  forgetKey: document.getElementById("forget-key"),
  provider: document.getElementById("provider"),
  version: document.getElementById("version"),
};

/* 64 bars is a wall of pixels at this size; 28 reads as a meter. */
const BARS = 28;
for (let i = 0; i < BARS; i++) {
  const bar = document.createElement("i");
  els.bars.appendChild(bar);
}
const bars = Array.from(els.bars.children);

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

/* ---- capture: microphone, then usermedia, then getUserMedia ---- */

/*
 * **What Chrome 152 actually does**, measured on this machine (the probe is in
 * 'scripts/voice-evidence.mjs''s run and in the project doc):
 *
 * - 'HTMLMicrophoneElement' is undefined; 'HTMLUserMediaElement' is a function.
 * - '<usermedia>' WORKS, and it takes all three of: no custom styling (a
 *   styled one fails with 'InvalidStateError: The permission element is
 *   disabled due to: invalid style'), 'setConstraints' given a
 *   'MediaTrackConstraintSet' — '{}' — rather than '{audio: true}' (which
 *   throws "Value is not of type MediaTrackConstraintSet"), and a REAL user
 *   gesture ON THE ELEMENT. A click on some other button is not it.
 *
 * Which is why the element IS the microphone button. There is no styled
 * affordance to click: the browser's own capture element is the affordance,
 * the permission prompt is its own, and this page puts it in the dock and
 * listens to 'onstream'. A browser without it gets a styled button and
 * 'getUserMedia', which needs no gesture on any particular element.
 */

const CAPTURE = [
  { name: "microphone", tag: "microphone", available: () => typeof window.HTMLMicrophoneElement === "function" },
  { name: "usermedia", tag: "usermedia", available: () => typeof window.HTMLUserMediaElement === "function" },
  {
    name: "getUserMedia",
    tag: null,
    available: () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  },
];

let capturePath = null;
function pickCapture() {
  if (capturePath) return capturePath;
  for (const path of CAPTURE) {
    if (path.available()) {
      capturePath = path;
      return path;
    }
  }
  return null;
}

async function streamFor(path) {
  if (path.tag === null) {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  const el = document.createElement(path.tag);
  const stream = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("<" + path.tag + "> never handed a stream")), 20000);
    el.onstream = () => { clearTimeout(timer); resolve(el.stream); };
    el.onerror = () => {
      clearTimeout(timer);
      const why = el.error ? el.error.name + ": " + el.error.message : "no stream and no reason given";
      reject(new Error("<" + path.tag + "> refused: " + why));
    };
  });
  // In, THEN armed, and the order is the browser's: an element that has just
  // been attached to the layout tree is "recently attached" and refuses its
  // constraints (measured on Chrome 152), so it is laid out first and armed on
  // the next frame.
  slot.append(el);
  await new Promise((next) => requestAnimationFrame(() => next(null)));
  el.setConstraints({});
  return { stream: await stream, element: el };
}

/* The element is the button; the fallback is a button. */
function armCapture() {
  const path = pickCapture();
  slot.replaceChildren();
  els.capture.textContent =
    path === null
      ? "capture path: none available in this browser"
      : "capture path: " + (path.tag ? "<" + path.tag + "> element" : "getUserMedia") + " · " + browser;
  if (path === null) {
    status("no microphone path in this browser", "warn");
    return;
  }
  if (path.tag === null) {
    const button = document.createElement("button");
    button.id = "mic";
    button.textContent = "🎙";
    button.onclick = () => start();
    slot.append(button);
    return;
  }
  // Unstyled on purpose: the UA draws this, and custom CSS disables it.
  void start();
}

async function start(attempt) {
  const path = pickCapture();
  if (!path) return;
  els.capture.textContent = "capture path: " + (path.tag ? "<" + path.tag + ">" : "getUserMedia") + " · " + browser;
  try {
    const got = path.tag === null ? { stream: await streamFor(path), element: null } : await streamFor(path);
    const stream = got.stream;
    if (audio) { cancelAnimationFrame(audio.raf); try { audio.ctx.close(); } catch {} }
    audio = meterFrom(stream);
    stream.getAudioTracks()[0]?.addEventListener("ended", () => stop());
    recording = stream;
    startRecording(audio);
    listening = true;
    els.stop.hidden = false;
    els.capture.textContent = "capturing — " + (path.tag ? "<" + path.tag + "> element" : "getUserMedia") + " · " + browser;
    status("listening — stop to send", "live");
  } catch (err) {
    const why = String(err.message || err);
    // A refused declaration is not a dead end, and it must not need a second
    // click: the element path is tried, its refusal is REPORTED ON THE PAGE,
    // and the next rung runs in the same gesture.
    if (path.tag !== null && !attempt) {
      capturePath = CAPTURE[2];
      els.capture.textContent = "<" + path.tag + "> refused (" + why + ") — using getUserMedia · " + browser;
      status("falling back to getUserMedia", "busy");
      await start(true);
      return;
    }
    els.capture.textContent = (path.tag ? "<" + path.tag + ">" : "getUserMedia") + " refused: " + why;
    status("the microphone refused", "warn");
  }
}

const browser = (() => {
  const m = navigator.userAgent.match(/(HeadlessChrome|Chrome)\/([\d.]+)/);
  return m ? m[1] + " " + m[2] : navigator.userAgent;
})();
els.version.textContent = browser;
els.capture.textContent = "capture path: not started yet";

/* ---- the meter, and the recording behind it ---- */

let audio = null;      // { stream, ctx, analyser, data, raf }
let recorder = null;   // { processor, chunks, sampleRate, started }
let recording = null;  // the live MediaStream, while capture runs
let listening = false;

function meterFrom(stream) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const state = { stream, ctx, analyser, data, raf: 0, peak: 0 };
  const draw = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / data.length);
    state.peak = Math.max(state.peak, rms);
    const lit = Math.round(Math.min(1, rms * 6) * BARS);
    bars.forEach((bar, i) => { bar.className = i < lit ? "on" : ""; });
    state.raf = requestAnimationFrame(draw);
  };
  draw();
  return state;
}

/* PCM straight off the graph, so the WAV the harness gets is the audio the
   meter is showing — one capture, not two. */
function startRecording(state) {
  const ctx = state.ctx;
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  const chunks = [];
  processor.onaudioprocess = (e) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  const source = ctx.createMediaStreamSource(state.stream);
  source.connect(processor);
  processor.connect(sink);
  sink.connect(ctx.destination);
  recorder = { processor, chunks, sampleRate: ctx.sampleRate, started: Date.now(), source, sink };
}

function stopRecording() {
  if (!recorder) return null;
  const { processor, chunks, sampleRate, source, sink } = recorder;
  recorder = null;
  processor.onaudioprocess = null;
  try { source.disconnect(); processor.disconnect(); sink.disconnect(); } catch {}
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total === 0) return null;
  const samples = new Float32Array(total);
  let at = 0;
  for (const c of chunks) { samples.set(c, at); at += c.length; }
  return { samples, sampleRate, seconds: total / sampleRate };
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

/* ---- talking to the harness on loopback ---- */

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

/* ---- stopping: the recorded audio goes to the harness ---- */

async function stop() {
  if (!listening) return;
  listening = false;
  els.stop.hidden = true;
  if (recording) recording.getTracks().forEach((t) => t.stop());
  recording = null;
  const captured = stopRecording();
  if (!captured) {
    status("nothing was captured", "warn");
    return;
  }
  say(els.transcript, "listening stopped — " + captured.seconds.toFixed(1) + "s of audio", "note");
  status("transcribing…", "busy");
  try {
    const out = await post("/audio", {
      wav: await wav(captured.samples, captured.sampleRate).arrayBuffer(),
      sampleRate: captured.sampleRate,
    });
    status("ready");
    if (out.text) await send(out.text, "spoken");
    else status(out.reason || "nothing was heard", "warn");
  } catch (err) {
    status(String(err.message || err), "warn");
  }
}

els.stop.onclick = () => void stop();

/* ---- the key ---- */

els.keyState.textContent = facts.key ? "a " + facts.key.provider + " key is stored" : "no key stored";
els.provider.value = facts.key ? facts.key.provider : "";

els.saveKey.onclick = async () => {
  const key = els.key.value.trim();
  if (!key) return;
  try {
    const out = await post("/key", { key });
    els.key.value = "";           /* never left in the DOM */
    els.keyState.textContent = "a " + out.provider + " key is stored (" + out.path + ")";
    say(els.log, "key stored by the harness: " + out.provider, "note");
  } catch (err) {
    els.keyState.textContent = String(err.message || err);
  }
};

els.forgetKey.onclick = async () => {
  try {
    await post("/key", { forget: true });
    els.keyState.textContent = "no key stored";
    els.key.value = "";
  } catch (err) {
    els.keyState.textContent = String(err.message || err);
  }
};

/* The dock is built last, once every element it needs exists — and the capture
   ladder is walked HERE, after the document has settled. Not before: a
   declarative element that is armed while the page is still laying out
   refuses with "recently attached to layout tree, intersection with viewport
   changed" (measured on Chrome 152), which is a race, not a permission. */
if (document.readyState === "complete") armCapture();
else window.addEventListener("load", () => armCapture());
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
    grid-template-columns: 1fr 320px;
    grid-template-rows: auto 1fr;
    gap: 18px;
    padding: 22px 26px 26px;
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
  aside { display: flex; flex-direction: column; gap: 16px; min-height: 0; }
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
  .hint { color: var(--dim); font-size: 12px; margin-top: 8px; }
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
  #mic-slot button {
    width: 76px; height: 60px; border-radius: 50%; font-size: 30px; line-height: 1;
    display: grid; place-items: center; padding: 0;
    background: linear-gradient(180deg, #262b34, #1b1e24);
    transition: box-shadow .18s ease, transform .12s ease;
  }
  #mic-slot button:active { transform: scale(.97); }
  #stop {
    background: var(--live); border-color: var(--live); color: #241018; font-weight: 600;
  }
  #meter { display: flex; flex-direction: column; gap: 6px; min-width: 220px; }
  #bars { display: flex; align-items: flex-end; gap: 3px; height: 34px; }
  #bars i { flex: 1; height: 4px; border-radius: 2px; background: var(--line); transition: height .05s linear, background .05s linear; }
  #bars i.on { height: 30px; background: linear-gradient(180deg, var(--accent-lit), var(--accent)); }
  #bars i.on:nth-child(n+22) { background: linear-gradient(180deg, #f0a0a0, var(--bad)); }
  #capture, #version { color: var(--dim); font-size: 11.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<header>
  <h1>isocan voice</h1>
  <span class="canvas">${escapeHtml(facts.canvas)}</span>
  <span class="spacer"></span>
  <span id="state" class="state">ready</span>
</header>

<main>
  <section class="panel" style="flex: 1.35">
    <h2>Conversation</h2>
    <div id="transcript"></div>
  </section>
  <section class="panel" style="flex: 1">
    <h2>Operations sent, as ${escapeHtml(facts.name)}</h2>
    <div id="log"></div>
  </section>
  <form class="composer" onsubmit="return false">
    <input id="typed" type="text" placeholder="Type a command — same path as speech: “retitle the second screen to Checkout”" autocomplete="off">
    <button id="send" class="primary">Send</button>
  </form>

  <div class="dock">
    <div id="mic-slot"></div>
    <div id="meter">
      <div id="bars"></div>
      <div id="version"></div>
    </div>
    <button id="stop" hidden>Stop &amp; send</button>
  </div>
</main>

<aside>
  <section class="panel">
    <h2>Key — kept by the harness, never by this page</h2>
    <select id="provider">
      <option value="">auto (from the key's shape)</option>
      <option value="gemini">Gemini</option>
      <option value="openai">OpenAI</option>
    </select>
    <div style="height:8px"></div>
    <input id="key" type="password" placeholder="paste a Gemini or OpenAI API key" autocomplete="off">
    <div class="keyrow" style="margin-top:8px">
      <button id="save-key">Save key</button>
      <button id="forget-key">Forget</button>
    </div>
    <div class="hint" id="key-state"></div>
    <div class="hint">Stored 0600 under the harness's own file. This page keeps it in memory for one request and writes it nowhere — no localStorage, no cookie.</div>
  </section>
  <section class="panel">
    <h2>Microphone</h2>
    <div id="capture">capture path: not started yet</div>
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
