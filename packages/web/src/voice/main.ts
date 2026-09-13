/**
 * **The voice page, without a framework.**
 *
 * Vite is here for the reload loop and nothing else: the page is markup in
 * `voice.html`, and this module is the controller. It queries the elements
 * once, keeps a handful of values, and writes them into the DOM directly.
 *
 * That is not nostalgia. The React version handed `/log`'s `{ type, said }`
 * and `{ ok, answer }` objects to a renderer that wanted text, and the whole
 * route went white; an update that writes `textContent` cannot fail that way.
 * The wire normalisation in `lib/voice.ts` still turns every entry into a
 * sentence — the difference is that a mistake there now shows as
 * "[object Object]" in one row instead of taking the page down.
 */
import "../styles.css";
import {
  HARNESS,
  audioSocket,
  endSession,
  entriesFrom,
  log as fetchLog,
  muteSession,
  saveKey,
  sessionFrom,
  state as fetchState,
  startSession,
  testKey,
  unmuteSession,
  type LogEntry,
  type SessionState,
  type State,
} from "../lib/voice.ts";
import {
  Playback,
  canRouteOutput,
  capture,
  fromBytes,
  listDevices,
  rmsOf,
  toBytes,
  type Capture,
  type Input,
  type Output,
  type ScheduleInfo,
} from "../lib/voiceAudio.ts";

/** The input waveform's recent energy samples; not a calibrated dB scale. */
export const BARS = 28;
const DEVICE_KEY = "isocan.voice.deviceId";
const DEVICE_NAME_KEY = "isocan.voice.deviceName";
const OUTPUT_KEY = "isocan.voice.outputId";
const OUTPUT_NAME_KEY = "isocan.voice.outputName";
/**
 * **The daemon the person asked for, remembered in this browser.**
 *
 * Same pattern as the microphone's id, and for the same reason: a choice made
 * once should not have to be made again. It is a preference, not a secret, and
 * a wrong value must not be a trap — hence the reset in the setup panel, which
 * is the only way out of a bad `localStorage` value without devtools.
 *
 * What it is NOT is a way to point the page at another host: the page reaches
 * the harness through the same-origin `/harness` proxy (deliberately — no CORS
 * header on the daemon, and the audio socket survives HMR). This is about
 * which daemon the HARNESS attaches to, so the page can only ask the harness
 * to switch, and say so honestly when that build cannot.
 */
const DAEMON_KEY = "isocan.voice.daemon";

/**
 * The daemon's own answer is the only validation worth having: a URL that
 * looks right and answers wrong is the failure this avoids. Until the harness
 * offers `POST /daemon`, the honest answer is "stored, not yet applied".
 */
function storedDaemon(): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(DAEMON_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeDaemon(value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (value) localStorage.setItem(DAEMON_KEY, value);
    else localStorage.removeItem(DAEMON_KEY);
  } catch {
    // A preference that cannot be stored is not worth failing the page for.
  }
}

/** The page is markup, so a missing element is a broken page, not a blank. */
function required<T extends Element>(id: string, doc: Document): T {
  const found = doc.querySelector<T>(`#${id}`);
  if (!found) throw new Error(`the voice page is missing #${id}`);
  return found;
}

/**
 * **`/state` has two shapes for the same fact and the page takes both.**
 *
 * The harness describes audio as `{ name, model, key }` in some builds and as
 * flat `provider` / `model` / `keyPresent` fields in others. A page that only
 * knew one shape rendered `[object Object]` and took the whole route down with
 * it, which is a worse failure than saying "unknown" — so this asks the object
 * rather than assuming, and the key itself is never in either shape.
 */
function audioFacts(facts: State | null): { provider: string; model: string; key: boolean } {
  const audio = (facts?.provider ?? facts?.audio) as unknown;
  if (audio && typeof audio === "object") {
    const held = audio as { name?: string; model?: string; key?: boolean | string };
    return { provider: held.name ?? "no provider", model: held.model ?? "no model", key: Boolean(held.key) };
  }
  return {
    provider: (audio as string) ?? "no provider",
    model: facts?.model ?? "no model",
    key: Boolean(facts?.keyPresent),
  };
}

/**
 * **What the microphone is doing, which is not the same as what the session
 * is.**
 *
 * The session has four words the harness owns (`idle`, `live`, `muted`,
 * `ended`) and they answer "is there a session". The page needs a second,
 * finer answer — the one an LLM voice mode shows — because "live" covers
 * three different pictures: the microphone is open and waiting, the model is
 * working on what it just heard, and the model is talking back. Those are
 * `listening`, `thinking` and `speaking`, and they are derived ONLY from
 * signals that exist on the wire:
 *
 *   - `heard` (input transcript received, not a separate VAD guarantee) → thinking
 *   - scheduled output PCM, or a reply transcript line → speaking
 *   - the playback queue drains (or a text-only reply goes quiet) → listening
 *   - `interrupted` → the model stops, the microphone is what happened next
 *
 * `thinking` is the state that was missing: without it the page jumps from
 * "live" straight to "live" again and nothing tells a person that their
 * sentence landed and something is happening. The mute gate is checked here
 * rather than in the mic: a muted session never renders as listening, because
 * a page that shows a live microphone while it is off is lying about the one
 * thing the person controls.
 */
export type Activity = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "muted" | "ended";

/** Only a fallback for text-only replies; PCM follows its playback schedule. */
const TEXT_TAIL_MS = 700;

/**
 * **The state line says which microphone, because "it is using the wrong one"
 * is not diagnosable from a word like "live".**
 */
function stateWords(activity: Activity, muted: boolean, microphone: string): string {
  if (activity === "connecting") return "connecting…";
  if (activity === "thinking") return "thinking…";
  if (activity === "speaking") {
    return muted ? "speaking — you are muted" : "speaking";
  }
  if (activity === "muted") return `muted — ${microphone} is still open`;
  if (activity === "listening") return `listening — ${microphone}`;
  if (activity === "ended") return "ended";
  return "idle — press Listen to start";
}

/**
 * **The build tag, and what it says when there is no build to tag.**
 *
 * The integration build injects `{ branch, commit }` through Vite's `define`,
 * because Paul uses that line to know which branch he is looking at. A build
 * without the define must not borrow a plausible-looking string: it says the
 * tag was not injected, which is the one true thing it knows.
 */
declare const __VOICE_BUILD_INFO__: { branch?: string; commit?: string } | string | undefined;

export function buildWords(): string {
  const info = typeof __VOICE_BUILD_INFO__ === "undefined" ? undefined : __VOICE_BUILD_INFO__;
  if (!info) return "build tag not injected";
  if (typeof info === "string") return info;
  const branch = info.branch ?? "unknown branch";
  const commit = (info.commit ?? "").slice(0, 8);
  return commit ? `${branch} @ ${commit}` : branch;
}

/**
 * **A device choice is an id AND the name it had when it was made.**
 *
 * The id is what `getUserMedia` and `setSinkId` take; the name is what the
 * page can still say about it afterwards. Headphones that leave take their id
 * out of `enumerateDevices()` with them, and "«name» is not connected" is only
 * sayable if the name was kept — which is the whole difference between a
 * visible state and a silent revert to the system default.
 *
 * Neither is a secret, and neither is worth failing a render for.
 */
function stored(key: string): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function store(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // A preference that cannot be stored is not worth failing a switch for.
  }
}

export interface VoicePage {
  /** Everything this page started: its polls, its socket, its microphone. */
  stop(): void;
}

/**
 * Wire the page in `doc`. Exported rather than run at import so a test can
 * build the real markup and drive this without a browser, and so the page's
 * own script is the only place that decides when it starts.
 */
export function wireVoice(doc: Document = document): VoicePage {
  const hero = required<HTMLElement>("hero", doc);
  const listenButton = required<HTMLButtonElement>("listen", doc);
  const muteButton = required<HTMLButtonElement>("mute", doc);
  const endButton = required<HTMLButtonElement>("end", doc);
  const deviceSelect = required<HTMLSelectElement>("device", doc);
  const outputSelect = required<HTMLSelectElement>("output", doc);
  const deviceNoteLine = required<HTMLElement>("device-note", doc);
  const micFact = required<HTMLElement>("mic-fact", doc);
  const inputWave = required<SVGPathElement>("input-wave", doc);
  const outputWave = required<SVGPathElement>("output-wave", doc);
  const captions = required<HTMLElement>("captions", doc);
  const keepCaptions = required<HTMLInputElement>("keep-captions", doc);
  const copyNote = required<HTMLElement>("copy-note", doc);
  const settings = required<HTMLDialogElement>("settings", doc);
  const settingsOpen = required<HTMLButtonElement>("settings-open", doc);
  const settingsClose = required<HTMLButtonElement>("settings-close", doc);
  const setupOpen = required<HTMLButtonElement>("setup-open", doc);
  const setupCallout = required<HTMLElement>("setup-callout", doc);
  const setupStatus = required<HTMLElement>("setup-status", doc);
  const motion = doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)");
  keepCaptions.checked = motion?.matches ?? false;
  const stateLine = required<HTMLElement>("state", doc);
  const buildTag = required<HTMLElement>("build-tag", doc);
  const transcript = required<HTMLElement>("transcript", doc);
  const canvasTitle = required<HTMLElement>("canvas-title", doc);
  const canvasId = required<HTMLElement>("canvas-id", doc);
  const daemonLine = required<HTMLElement>("daemon", doc);
  const daemonNoteLine = required<HTMLElement>("daemon-note", doc);
  const daemonField = required<HTMLInputElement>("daemon-field", doc);
  const daemonUse = required<HTMLButtonElement>("daemon-use", doc);
  const daemonReset = required<HTMLButtonElement>("daemon-reset", doc);
  const homeLine = required<HTMLElement>("home", doc);
  const actorName = required<HTMLElement>("actor-name", doc);
  const actorId = required<HTMLElement>("actor-id", doc);
  const actorStanding = required<HTMLElement>("actor-standing", doc);
  const audioLine = required<HTMLElement>("audio", doc);
  const versionLine = required<HTMLElement>("version", doc);
  const updatedLine = required<HTMLElement>("updated", doc);
  const complaintLine = required<HTMLElement>("complaint", doc);
  const connectionPanel = required<HTMLDetailsElement>("connection-panel", doc);
  const connectionSummary = required<HTMLElement>("connection-summary", doc);
  const setupBox = required<HTMLElement>("setup", doc);
  const setupNote = required<HTMLElement>("setup-note", doc);
  const setupSteps = required<HTMLElement>("setup-steps", doc);
  const confirmBox = required<HTMLElement>("confirm", doc);
  const confirmWhat = required<HTMLElement>("confirm-what", doc);
  const confirmAllow = required<HTMLButtonElement>("confirm-allow", doc);
  const confirmDeny = required<HTMLButtonElement>("confirm-deny", doc);
  const openButton = required<HTMLButtonElement>("open-project", doc);
  const keyInput = required<HTMLInputElement>("key", doc);
  const saveKeyButton = required<HTMLButtonElement>("save-key", doc);
  const testKeyButton = required<HTMLButtonElement>("test-key", doc);
  const forgetKeyButton = required<HTMLButtonElement>("forget-key", doc);
  const keyNote = required<HTMLElement>("key-note", doc);
  const logList = required<HTMLElement>("log", doc);
  const copyLogButton = required<HTMLButtonElement>("copy-log", doc);

  let facts: State | null = null;
  let setupSignature = "";
  let session: SessionState = "idle";
  let muted = false;
  let muting = false;
  let entries: LogEntry[] = [];
  let mics: Input[] = [];
  let speakers: Output[] = [];
  /** True once the browser has shown a device name; false = ids are hidden too. */
  let devicesNamed = false;
  /** The last rows drawn, so a poll that changes nothing touches no DOM. */
  let devicesSignature = "";
  let chosenId = stored(DEVICE_KEY);
  let chosenOutputId = stored(OUTPUT_KEY);
  /** A route the browser refused, said out loud rather than swallowed. */
  let outputProblem = "";
  /** The current harness stores Gemini keys; the field also supports older builds. */
  const provider = "gemini";
  /** Read once, before any request goes out: the stored value wins. */
  let daemonWant = storedDaemon();
  /** The honest sentence about whether the harness took it. */
  let daemonNote = daemonWant ? "stored, not yet applied" : "";
  /** One attempt per value, so a returning person is not asked to press again. */
  let daemonTried = "";
  let complaint = "";
  let note = "";
  /** True only while the state poll is the thing that failed. */
  let stateComplaint = false;
  let held: Capture | null = null;
  let socket: WebSocket | null = null;
  let playback: Playback | null = null;
  let ticker: number | null = null;
  let opening = false;
  let disposed = false;
  let generation = 0;
  let captureEpoch = 0;
  let outputEpoch = 0;
  const inputHistory: number[] = Array(BARS).fill(0);
  const displayInput: number[] = Array(BARS).fill(0);
  const displayOutput: number[] = Array(64).fill(0);
  let lastInputAt = 0;
  let lastFrameAt = 0;
  let queuedAudio: { pcm: Int16Array; start: number; end: number }[] = [];
  let speechUntil = 0;
  let captionTimer: ReturnType<typeof setTimeout> | null = null;
  let captionText = "";
  let captionTurn: object | null = null;
  /** The visible state: what the microphone is doing, not what the session is. */
  let activity: Activity = "idle";
  /** Turn boundaries and the reply, as the harness's own log describes them. */
  let turns: { who: "you" | "voice"; text: string }[] = [];
  const turnRows = new WeakMap<object, HTMLLIElement>();
  /** True once a tagged reply has been seen, so the untagged copy is ignored. */
  let sawTagged = false;
  /** The confirmation the harness is waiting on, if any. */
  let pendingConfirm: { id: string } | null = null;
  /**
   * What the harness offered when asked, so the panel can choose between a
   * working control and the command that does the same thing by hand. Absent
   * keys mean the build does not answer that verb yet — which is said out
   * loud rather than rendered as a dead button.
   */
  const offered: { daemons?: unknown[]; canvases?: unknown[]; actors?: unknown[] } = {};

  /**
   * The session's word and the page's word, side by side. `data-state` is the
   * harness's vocabulary (idle / live / muted / ended) and `data-activity` is
   * the visible one; a muted session is never rendered as listening. A live
   * session keeps whatever activity is in progress — the poll runs every two
   * seconds and must not wipe "thinking" back to "listening" mid-turn.
   */
  function renderHero(): void {
    hero.dataset.state = session;
    hero.dataset.muted = String(muted);
    if (opening) activity = "connecting";
    else if (session === "idle" || session === "ended") activity = session;
    else if (muted && activity !== "speaking") activity = "muted";
    else if (session === "live" && (activity === "idle" || activity === "ended" || activity === "muted"))
      activity = "listening";
    hero.dataset.activity = activity;
    // Keep keyboard focus through an async start; guards refuse repeat presses.
    listenButton.disabled = false;
    listenButton.setAttribute("aria-disabled", String(opening || muting));
    listenButton.setAttribute("aria-busy", String(opening || muting));
    const running = session === "live" || session === "muted";
    listenButton.setAttribute("aria-label", running ? (muted ? "Unmute microphone" : "Mute microphone") : "Listen");
    listenButton.title = running ? (muted ? "Unmute microphone" : "Mute microphone") : "Start listening";
    muteButton.disabled = opening || muting || (session !== "live" && session !== "muted");
    endButton.disabled = !opening && (session === "idle" || session === "ended");
    muteButton.textContent = muted ? "Unmute" : "Mute";
    stateLine.textContent = stateWords(activity, muted, micWords());
  }

  /** The activity changed for a reason; say it once, in one place. */
  function setActivity(next: Activity): void {
    if (activity === next) return;
    activity = next;
    renderHero();
  }

  /** Text can precede the sound; scheduled PCM, not packet arrival, owns its end. */
  function spoke(): void {
    if (session !== "live" && session !== "muted") return;
    speechUntil = performance.now() + TEXT_TAIL_MS;
    setActivity("speaking");
  }

  function clearCaptionTimer(): void {
    if (captionTimer !== null) clearTimeout(captionTimer);
    captionTimer = null;
  }

  function fadeCaptionLater(): void {
    clearCaptionTimer();
    if (keepCaptions.checked || !captionText) return;
    const readingTime = Math.max(4500, Math.min(20000, captionText.length * 50));
    captionTimer = setTimeout(() => {
      captionTimer = null;
      captions.classList.add("faded");
    }, readingTime);
  }

  function clearOutput(): void {
    outputEpoch++;
    queuedAudio = [];
    speechUntil = 0;
    displayOutput.fill(0);
  }

  /** A user turn or the reply, as text, accumulating within the turn. */
  function addTurn(who: "you" | "voice", text: string): void {
    if (!text) return;
    const last = turns[turns.length - 1];
    if (last && last.who === who) {
      // Input transcription arrives as partials that grow — "read the canvas
      // and" and then the same phrase, longer. Replacing the extension rather
      // than appending is what stops the transcript saying "andread".
      if (text.startsWith(last.text) || last.text.startsWith(text)) {
        last.text = text.length >= last.text.length ? text : last.text;
      } else {
        last.text += text;
      }
    } else {
      turns.push({ who, text });
    }
    turns = turns.slice(-6);
    renderTranscript();
  }

  function renderTranscript(): void {
    for (const row of [...transcript.children]) {
      if (!turns.some((turn) => turnRows.get(turn) === row)) row.remove();
    }
    for (const turn of turns) {
      let row = turnRows.get(turn);
      if (!row) {
        row = doc.createElement("li");
        // Never reuse .voice here: it is the page's full-height grid class.
        row.className = `voice-turn voice-turn--${turn.who}`;
        const label = doc.createElement("b");
        label.textContent = turn.who === "you" ? "You" : "Voice";
        row.append(label, doc.createTextNode(""));
        turnRows.set(turn, row);
        transcript.appendChild(row);
      }
      const text = row.lastChild as Text;
      if (turn.text.startsWith(text.data)) text.appendData(turn.text.slice(text.length));
      else text.data = turn.text;
    }
    const last = turns[turns.length - 1];
    if (last?.who !== "voice") return;
    if (captionTurn !== last) {
      captionTurn = last;
      captionText = "";
      captions.replaceChildren();
    }
    if (last.text === captionText) return;
    clearCaptionTimer();
    captions.classList.remove("faded");
    // Append only the new words to the live region, not six rebuilt turns.
    if (last.text.startsWith(captionText)) captions.appendChild(doc.createTextNode(last.text.slice(captionText.length)));
    else captions.textContent = last.text;
    captionText = last.text;
  }

  function energy(pcm: Int16Array): number {
    const rms = rmsOf(pcm);
    return rms < 0.0018 ? 0 : Math.min(1, Math.sqrt(rms / 0.22));
  }

  function drawWaves(now: number): void {
    const blend = 1 - Math.exp(-Math.min(100, now - lastFrameAt || 16) / 65);
    lastFrameAt = now;
    // Retain half a second of played PCM for the perimeter's level history.
    // Those old samples do not extend the speaking state.
    const audioNow = (playback?.currentTime ?? 0) * 1000;
    queuedAudio = queuedAudio.filter((chunk) => chunk.end > audioNow - 512);
    const pending = queuedAudio.some((chunk) => chunk.end > audioNow);
    const quiet = muted || now - lastInputAt > 180;
    let inner = "", outer = "";
    for (let i = 0; i < BARS; i++) {
      displayInput[i] = displayInput[i]! + ((quiet ? 0 : inputHistory[i]!) - displayInput[i]!) * blend;
      const x = 24 + i * 80 / (BARS - 1);
      const height = motion?.matches ? 0 : displayInput[i]! * 24;
      inner += `M${x.toFixed(2)},${(64 - height).toFixed(2)}V${(64 + height + 0.5).toFixed(2)}`;
    }
    for (let i = 0; i < 64; i++) {
      // Walk recent played sound around the edge, in 8 ms RMS windows.
      // A burst's unread future samples never animate ahead of its audio.
      const time = audioNow - (63 - i) * 8;
      const chunk = pending ? queuedAudio.find((one) => one.start <= time && one.end > time) : undefined;
      const end = chunk ? Math.floor((time - chunk.start) * 24) + 1 : 0;
      const target = chunk ? energy(chunk.pcm.subarray(Math.max(0, end - 192), end)) : 0;
      displayOutput[i] = displayOutput[i]! + (target - displayOutput[i]!) * blend;
      const angle = i / 64 * Math.PI * 2 - Math.PI / 2;
      const radius = 101 + (motion?.matches ? 0 : displayOutput[i]! * 13);
      outer += `${i ? "L" : "M"}${(120 + Math.cos(angle) * radius).toFixed(2)},${(120 + Math.sin(angle) * radius).toFixed(2)}`;
    }
    inputWave.setAttribute("d", inner);
    outputWave.setAttribute("d", outer + "Z");
    if (activity === "speaking" && !pending && now >= speechUntil) {
      setActivity(muted ? "muted" : "listening");
      fadeCaptionLater();
    }
  }

  function animate(now: number): void {
    drawWaves(now);
    ticker = requestAnimationFrame(animate);
  }

  function renderFacts(): void {
    canvasTitle.textContent = facts?.canvas?.title ?? "unknown";
    canvasId.textContent = facts?.canvas?.id ?? "no id";
    daemonLine.textContent = facts?.daemon ?? "unknown";
    // Prefilled with what the page resolved, and never overwritten while a
    // person is typing in it: the two-second poll must not fight the cursor.
    if (doc.activeElement !== daemonField) daemonField.value = daemonWant || facts?.daemon || "";
    daemonReset.hidden = !daemonWant;
    const wanted = daemonWant && daemonWant !== facts?.daemon;
    daemonNoteLine.textContent = wanted
      ? ` — wanted: ${daemonWant} (${daemonNote || "stored, not yet applied"})`
      : daemonNote && !daemonWant
        ? ` — ${daemonNote}`
        : "";
    homeLine.textContent = facts?.home ?? facts?.service ?? "none configured";
    actorName.textContent = facts?.agent?.name ?? "unknown";
    actorId.textContent = facts?.agent?.id ?? "no id";
    actorStanding.textContent = facts?.agent?.enrolled
      ? "enrolled"
      : "not enrolled — nothing can summon it";
    actorStanding.className = facts?.agent?.enrolled ? "voice-ok" : "voice-bad";
    const audio = audioFacts(facts);
    audioLine.textContent = `${audio.provider} · ${audio.model} · ${audio.key ? "key stored" : "no key stored"}`;
    versionLine.textContent = facts?.version ?? "unknown";
    updatedLine.textContent = `updated ${facts?.updated ?? "unknown"}`;

    // One line that answers "what am I connected to" without opening anything:
    // the canvas by title, the actor by name, and the one thing still missing.
    const missing: string[] = [];
    if (!facts?.canvas?.title) missing.push("no canvas");
    if (!facts?.agent?.name) missing.push("no actor");
    else if (!facts?.agent?.enrolled) missing.push("not enrolled");
    if (!audio.key) missing.push("no key");
    connectionSummary.textContent = facts
      ? `${facts.canvas?.title ?? "no canvas"} · ${facts.agent?.name ?? "no actor"}${
          missing.length ? ` · ${missing.join(" · ")}` : ""
        }`
      : "no harness answered";

    // Expand the section inside Settings, never the modal itself. Missing
    // prerequisites also have an inline pointer beside the conversation.
    if (missing.length > 0) connectionPanel.open = true;
    renderSetup();
  }

  function renderComplaint(): void {
    complaintLine.hidden = !complaint;
    complaintLine.textContent = complaint;
  }

  function renderNote(): void {
    keyNote.hidden = !note;
    keyNote.textContent = note;
  }

  function renderSave(): void {
    saveKeyButton.disabled = !keyInput.value.trim();
  }

  /** A chunk of a log row: the log's own field names became text at the wire. */
  function chunk(row: HTMLElement, className: string, text: string): void {
    const span = doc.createElement("span");
    span.className = className;
    span.textContent = text;
    row.appendChild(span);
  }

  function renderLog(): void {
    logList.replaceChildren();
    if (entries.length === 0) {
      const hint = doc.createElement("li");
      hint.className = "voice-hint";
      hint.textContent = "nothing yet — press Listen and say something";
      logList.appendChild(hint);
      return;
    }
    for (const entry of entries) {
      const row = doc.createElement("li");
      if (entry.at) chunk(row, "voice-at", entry.at);
      if (entry.tool) {
        const tool = doc.createElement("b");
        tool.textContent = entry.tool;
        row.appendChild(tool);
      }
      if (entry.args !== undefined && entry.args !== null) {
        const args = doc.createElement("code");
        args.textContent = typeof entry.args === "string" ? entry.args : JSON.stringify(entry.args);
        row.appendChild(args);
      }
      if (entry.operation) chunk(row, "voice-op", `→ ${entry.operation}`);
      if (entry.answered) chunk(row, "voice-answered", `daemon: ${entry.answered}`);
      if (entry.error) chunk(row, "voice-bad", entry.error);
      if (entry.event) chunk(row, "voice-event", entry.event);
      logList.appendChild(row);
    }
  }

  /**
   * **The page's own entries are marked, because the log poll used to eat
   * them.**
   *
   * `pollLog` replaces `entries` with the harness's `/log` every two seconds,
   * and the page's own record — the session opening, which microphone at
   * which rate, every audio chunk's schedule — is not the harness's to
   * return. So it survived for at most two seconds and then vanished, which is
   * how a page can show a log and still have nothing to read when something
   * sounds wrong. Marking them lets the poll replace only its own half.
   */
  function put(entry: LogEntry): void {
    entries = [{ ...entry, own: true }, ...entries].slice(0, 200);
    renderLog();
  }

  /**
   * **Every audio chunk, counted and dated, because "the frames overlap" is
   * answered by the log or by nothing.**
   *
   * `Playback` reports each chunk's sequence, byte length and scheduled start.
   * The first few are logged whole — the numbers that would show two chunks
   * starting at the same time — and after that only a folded line every
   * hundred, so a live session does not push the tool calls out of the log.
   * `behind` and out-of-order starts are always logged: those are the shape of
   * a real fault, and a fault nobody can see is the one that took a day to
   * find.
   */
  const audio = { chunks: 0, bytes: 0, behind: 0, disorder: 0, last: -1 };

  function noteChunk(info: ScheduleInfo): void {
    const outOfOrder = info.start < audio.last - 1e-6;
    audio.chunks += 1;
    audio.bytes += info.bytes;
    if (info.behind) audio.behind += 1;
    if (outOfOrder) audio.disorder += 1;
    audio.last = info.start;
    const at = new Date().toLocaleTimeString();
    if (info.behind || outOfOrder) {
      put({
        at,
        event: `audio #${info.seq} · ${info.bytes} B · starts ${info.start.toFixed(3)}s at now ${info.now.toFixed(3)}s`,
      });
      return;
    }
    if (audio.chunks <= 8) {
      put({
        at,
        event: `audio #${info.seq} · ${info.bytes} B · ${info.duration.toFixed(3)}s · starts ${info.start.toFixed(3)}s (now ${info.now.toFixed(3)}s)`,
      });
      return;
    }
    if (audio.chunks % 100 === 0) {
      put({
        at,
        event: `audio · ${audio.chunks} chunks · ${audio.bytes} B · ${audio.behind} at now · last starts ${info.start.toFixed(3)}s${audio.disorder ? ` · ${audio.disorder} out of order` : ""}`,
      });
    }
  }

  const refresh = async (): Promise<void> => {
    if (muting) return;
    const epoch = generation;
    try {
      const next = await fetchState();
      if (disposed || epoch !== generation) return;
      facts = next;
      renderFacts();
      // Applied on load: a stored choice that differs from what the harness
      // reports is offered to it once, so a returning person does not have to
      // press anything. Failure is already a sentence, not a silent no.
      if (daemonWant && daemonWant !== next.daemon && daemonTried !== daemonWant) {
        daemonTried = daemonWant;
        void chooseDaemon(daemonWant);
      }
      const running = sessionFrom(next);
      if (running) {
        session = running;
        // A refused harness update must not undo a local microphone mute.
        muted = Boolean(held?.muted) || running === "muted";
        renderHero();
      }
      // Only the poll's own complaint is the poll's to clear. An action that
      // failed ("Live session could not start") must stay on screen long
      // enough to be read, not vanish at the next two-second tick.
      if (stateComplaint) {
        stateComplaint = false;
        complaint = "";
        renderComplaint();
      }
      // The same tick re-reads the devices, because a removed one is not
      // guaranteed to announce itself: see `lookForDevices`.
      await lookForDevices();
    } catch (err) {
      if (disposed || epoch !== generation) return;
      stateComplaint = true;
      complaint = String((err as Error).message ?? err);
      renderComplaint();
      renderSetup();
    }
  };

  const pollLog = async (): Promise<void> => {
    try {
      const reply = await fetchLog();
      // Newest first, because a live log is read from the top: the harness
      // answers oldest-first and the newest tool call is the one a person
      // came to see, not the last of thirty session events. The page's own
      // entries stay in front: they happened on this page and the harness
      // cannot return them.
      const own = entries.filter((entry) => entry.own);
      entries = [...own, ...entriesFrom(reply).slice(-200).reverse()].slice(0, 200);
      renderLog();
    } catch {
      // The endpoint is merger's to land; until it exists the log stays as
      // the page's own record rather than replacing it with an error.
    }
  };

  /**
   * **What to call the microphone this page is listening through.**
   *
   * The id is the choice; the name can come from the browser's list, from the
   * choice as it was stored, or from nowhere — and the last one is said as
   * such rather than filled in. A device that is no longer in the list is
   * named with the fact attached, because "listening" beside a device that is
   * gone is a claim this page cannot make.
   */
  function micWords(): string {
    if (!chosenId) return "the system default microphone";
    const name =
      mics.find((one) => one.id === chosenId)?.label ||
      stored(DEVICE_NAME_KEY) ||
      "the microphone this browser remembered";
    return missingMicId() ? `${name} (not connected)` : name;
  }

  /** A device's name, from the list in hand, the stored choice, or neither. */
  function nameOf(id: string, found: { id: string; label: string }[], key: string): string {
    return found.find((one) => one.id === id)?.label || stored(key) || "the chosen device";
  }

  /**
   * **The chosen device, when the browser's own list says it is gone.**
   *
   * Empty covers two different things on purpose: nothing was chosen, and
   * nothing can be known — before the browser has shown a single name, its
   * ids are hidden too, so a stored id that is not in the list proves nothing.
   * Claiming a device is gone on that evidence would be the page inventing a
   * fact, which is the one thing this control must not do.
   */
  function missing(output: boolean): string {
    const chosen = output ? chosenOutputId : chosenId;
    if (!devicesNamed || !chosen) return "";
    const found = output ? speakers : mics;
    return found.some((one) => one.id === chosen) ? "" : chosen;
  }
  const missingMicId = (): string => missing(false);
  const missingOutputId = (): string => missing(true);

  /** What the next session routes to: the choice, unless it is known to be gone. */
  function wantedOutput(): string {
    return missingOutputId() ? "" : chosenOutputId;
  }

  interface DeviceRow {
    value: string;
    text: string;
    /** A device that is not there: named, so the state is visible, not choosable. */
    gone: boolean;
  }

  /**
   * **The rows of one picker, and the two reasons a device is missing from it.**
   *
   * An unnamed device is not drawn at all: a blank row cannot be told from
   * another blank row, and numbering them claims a position that means
   * nothing. The chosen device is drawn even when it is absent — a gone
   * speaker that vanished from the picker would be a silent revert to the
   * default; a gone speaker named in it is a state a person can see.
   */
  function deviceRows(kind: "input" | "output"): DeviceRow[] {
    const found: { id: string; label: string }[] = kind === "input" ? mics : speakers;
    const chosen = kind === "input" ? chosenId : chosenOutputId;
    const nameKey = kind === "input" ? DEVICE_NAME_KEY : OUTPUT_NAME_KEY;
    const rows: DeviceRow[] = [
      { value: "", text: kind === "input" ? "System default microphone" : "System default", gone: false },
    ];
    for (const one of found) rows.push({ value: one.id, text: one.label, gone: false });
    if (chosen && !found.some((one) => one.id === chosen)) {
      rows.push({
        value: chosen,
        text: devicesNamed
          ? `${nameOf(chosen, found, nameKey)} — not connected`
          : nameOf(chosen, found, nameKey),
        gone: devicesNamed,
      });
    }
    return rows;
  }

  function fillSelect(select: HTMLSelectElement, rows: DeviceRow[]): void {
    select.replaceChildren();
    for (const row of rows) {
      const option = doc.createElement("option");
      option.value = row.value;
      option.textContent = row.text;
      option.disabled = row.gone;
      select.appendChild(option);
    }
  }

  /**
   * **Every state this row has to confess, one sentence per fact.**
   *
   * Nothing here is inferred: each sentence is a thing the page checked — the
   * browser withheld the names, it has no output routing, the chosen device is
   * no longer in the list, a route was refused. Empty is the good state.
   */
  function deviceNote(): string {
    const said: string[] = [];
    if (!devicesNamed) {
      said.push("Your device names are hidden until this page is allowed to use the microphone.");
    }
    if (!canRouteOutput()) {
      said.push("This browser cannot choose an output device, so the reply plays on the system default.");
    }
    if (missingOutputId()) {
      said.push(
        `${nameOf(chosenOutputId, speakers, OUTPUT_NAME_KEY)} is not connected. The reply is playing on the system default until it comes back.`,
      );
    }
    if (outputProblem) said.push(outputProblem);
    if (missingMicId()) {
      // Said, and not acted on: moving a microphone without being asked is a
      // worse answer than a microphone that stopped working out loud.
      said.push(
        `${nameOf(chosenId, mics, DEVICE_NAME_KEY)} is not connected, so nothing is being heard until another microphone is chosen.`,
      );
    }
    return said.join(" ");
  }

  /** The picker, the note and the Settings fact, rendered from one place. */
  function renderDevices(): void {
    const micRows = deviceRows("input");
    const outputRows = deviceRows("output");
    const said = deviceNote();
    const fact = micWords();
    /*
     * **A poll that found nothing new must not touch the DOM.**
     *
     * The devices are re-read on the state poll (see `refresh`), and that
     * lands every two seconds for the life of the page. Rebuilding the rows
     * each time would close a picker somebody had just opened — so the render
     * is skipped when every fact it would draw is the one already there.
     */
    const signature = JSON.stringify([micRows, outputRows, said, fact, chosenId, chosenOutputId, canRouteOutput()]);
    if (signature === devicesSignature) return;
    devicesSignature = signature;

    fillSelect(deviceSelect, micRows);
    deviceSelect.value = chosenId;
    fillSelect(outputSelect, outputRows);
    outputSelect.value = chosenOutputId;
    // A browser without the API keeps the row and loses only the choice: it
    // says where the reply goes, which is more than a hole would.
    outputSelect.disabled = !canRouteOutput();
    deviceNoteLine.hidden = said === "";
    deviceNoteLine.textContent = said;
    micFact.textContent = fact;
  }

  /**
   * **The device lists, and the one place they are re-read.**
   *
   * On load, on `devicechange`, after the first successful capture (the other
   * moment names appear) — and on the state poll, which is not belt and
   * braces. Measured in Chrome 152 on Linux: unloading an output device fires
   * NO `devicechange` at all, while a fresh `enumerateDevices()` does drop it,
   * so a page that waited for the event would keep saying "headphones" over
   * sound that had already moved to the speakers. The poll costs one local
   * call every two seconds and the render below is skipped unless something
   * actually changed.
   *
   * An enumeration failure is not worth a complaint: the page still works on
   * the default device, which is what a browser without any of this does.
   */
  async function lookForDevices(): Promise<void> {
    try {
      const found = await listDevices();
      mics = found.inputs;
      speakers = found.outputs;
      devicesNamed = found.named;
    } catch {
      // Keep the list in hand rather than emptying the picker over it.
    }
    renderDevices();
    renderHero();
    await settleOutput();
  }

  /**
   * **A chosen speaker that went away moves the reply, out loud.**
   *
   * Chrome falls back to the system default by itself when a sink disappears —
   * the exact silent revert this control exists to prevent. The same fallback
   * happens here, deliberately and by name: the picker keeps showing what was
   * chosen, the note says it is not connected, and the route is moved to the
   * default the moment the context would otherwise be pointing at nothing.
   *
   * Coming back is the same rule read backwards: the choice was never thrown
   * away, so the reply returns to the device as soon as it is enumerated
   * again.
   */
  async function settleOutput(): Promise<void> {
    const player = playback;
    if (!player) return;
    const want = wantedOutput();
    const wentAway = missingOutputId();
    if (want === player.sinkId) return;
    try {
      await player.setSink(want);
      put({
        at: new Date().toLocaleTimeString(),
        event: wentAway
          ? `${nameOf(wentAway, speakers, OUTPUT_NAME_KEY)} is not connected — the reply moves to the system default`
          : `output is back on ${nameOf(want, speakers, OUTPUT_NAME_KEY)}`,
      });
    } catch (err) {
      outputProblem = routeFailed(want, err, player.sinkId);
      renderDevices();
      put({ at: new Date().toLocaleTimeString(), event: outputProblem, error: outputProblem });
    }
  }

  /** Where a device id actually points, in words a person can read. */
  function speakerWords(id: string): string {
    return id ? nameOf(id, speakers, OUTPUT_NAME_KEY) : "the system default";
  }

  /**
   * **A route that did not happen, said with where the sound IS.**
   *
   * Three sentences need this and they must not disagree. A route that fails
   * leaves the context on the device it was already on, so a sentence that
   * repeated the person's wish would claim a device their reply never
   * reached — which is exactly the lie this row exists to prevent.
   */
  function routeFailed(deviceId: string, err: unknown, actual: string): string {
    return `${speakerWords(deviceId)} could not be used (${whyWords(err)}). The reply is playing on ${speakerWords(actual)}.`;
  }

  /** One error's own words; a thrown string is not a sentence until it is one. */
  function whyWords(err: unknown): string {
    return String((err as Error)?.message ?? err);
  }

  /**
   * **The reply's device, changed without touching the conversation.**
   *
   * Playback is Web Audio, so this is the CONTEXT's `setSinkId` and the audio
   * continues on the new device. A refusal is reported as where the reply is
   * ACTUALLY going — the context keeps the device it was on — because a
   * sentence that repeated the person's wish would be the lie this page is
   * built not to tell.
   */
  async function chooseSpeaker(deviceId: string): Promise<void> {
    chosenOutputId = deviceId;
    store(OUTPUT_KEY, deviceId);
    store(OUTPUT_NAME_KEY, deviceId ? nameOf(deviceId, speakers, OUTPUT_NAME_KEY) : "");
    outputProblem = "";
    renderDevices();
    const player = playback;
    if (!player) {
      // Nothing is playing yet: the next session builds its playback with this
      // choice, and the picker already shows it.
      put({
        at: new Date().toLocaleTimeString(),
        event: deviceId ? `output set to ${speakerWords(deviceId)}` : "output set to the system default",
      });
      return;
    }
    try {
      await player.setSink(deviceId);
      put({
        at: new Date().toLocaleTimeString(),
        event: deviceId ? `output changed to ${speakerWords(deviceId)}` : "output back on the system default",
      });
    } catch (err) {
      outputProblem = routeFailed(deviceId, err, player.sinkId);
      renderDevices();
      put({ at: new Date().toLocaleTimeString(), event: outputProblem, error: outputProblem });
    }
  }

  /** Changing microphone does not disturb the session: only the track changes. */
  async function startCapture(deviceId?: string): Promise<Capture | null> {
    const epoch = ++captureEpoch;
    let captured: Capture;
    try {
      captured = await capture((pcm) => {
        if (epoch !== captureEpoch || disposed || muted) return;
        const live = socket;
        if (live?.readyState === WebSocket.OPEN) live.send(toBytes(pcm));
        inputHistory.push(energy(pcm));
        inputHistory.shift();
        lastInputAt = performance.now();
      }, deviceId);
    } catch (err) {
      if (epoch !== captureEpoch || disposed) return null;
      throw err;
    }
    if (epoch !== captureEpoch || disposed) {
      captured.stop();
      return null;
    }
    captured.muted = muted;
    held = captured;
    return captured;
  }

  function stopTicker(): void {
    if (ticker !== null) cancelAnimationFrame(ticker);
    ticker = null;
  }

  function stopSpeakingTimer(): void {
    speechUntil = 0;
  }

  async function finish(): Promise<void> {
    generation++;
    captureEpoch++;
    opening = false;
    muting = false;
    muted = false;
    socket?.close();
    socket = null;
    held?.stop();
    held = null;
    playback?.close();
    playback = null;
    stopTicker();
    stopSpeakingTimer();
    clearOutput();
    inputHistory.fill(0);
    displayInput.fill(0);
    drawWaves(performance.now());
    fadeCaptionLater();
    session = "ended";
    activity = "ended";
    renderHero();
  }

  /**
   * **One message from the harness, and what it means.**
   *
   * The wire speaks four shapes the page uses and one it only records:
   *
   *   { state, bad }         the harness narrating a session state ("live",
   *                          "the model was interrupted", a failure)
   *   { heard: text }        the person's utterance, transcribed — a turn ended
   *   { text }               the model's reply (or a tool result echoed)
   *   { type: "tool_log" }   the harness's own record, carrying `details.kind`
   *                          (`heard` / `reply`) which is the ONLY way to tell
   *                          a reply from a tool-result echo: both arrive as
   *                          `{ text }`. The transcript is built from the
   *                          tagged copy so the canvas description a tool
   *                          returned is never shown as something the voice
   *                          said.
   *   binary                24 kHz PCM from the model — the page's output
   *
   * `turnComplete`/`interrupted` as booleans are kept as well as their string
   * forms, because the harness has answered both shapes across builds and the
   * state machine must not be the thing that decides which one is canonical.
   */
  function handleEvent(event: Record<string, unknown>): void {
    if (event.confirm && typeof event.confirm === "object") {
      showConfirm(event.confirm as Record<string, unknown>);
      return;
    }
    if (event.open_url && typeof event.open_url === "object") {
      void handleOpenUrl(event.open_url as Record<string, unknown>);
      return;
    }
    const tagged = event.type === "tool_log" ? (event.entry as Record<string, unknown> | undefined) : undefined;
    if (tagged) {
      const details = tagged.details as { kind?: string; text?: string } | undefined;
      if (details?.kind === "heard") {
        sawTagged = true;
        addTurn("you", details.text ?? "");
        if (activity === "speaking") return; // the model is still finishing a sentence
        setActivity("thinking");
      } else if (details?.kind === "reply") {
        sawTagged = true;
        addTurn("voice", details.text ?? "");
        spoke();
      }
      const name = typeof tagged.name === "string" ? tagged.name : undefined;
      if (name) put({ at: new Date().toLocaleTimeString(), event: `tool: ${name}` });
      return;
    }

    if (typeof event.heard === "string") {
      addTurn("you", event.heard);
      setActivity("thinking");
      return;
    }
    if (typeof event.state === "string") {
      const bad = event.bad === true;
      if (bad) {
        complaint = event.state;
        renderComplaint();
      }
      if (event.state.includes("interrupted") || event.interrupted === true) {
        // Barge-in: the model stops mid-sentence and the microphone is what
        // happened next.
        playback?.stopNow();
        stopSpeakingTimer();
        clearOutput();
        fadeCaptionLater();
        setActivity(muted ? "muted" : "listening");
      } else if (event.state === "turn_complete" || event.turn_complete === true) {
        // The turn is over; anything still playing drains on the tail timer.
        if (activity !== "speaking") setActivity(muted ? "muted" : "listening");
      } else if (event.state === "live" && activity !== "speaking" && activity !== "thinking") {
        setActivity(muted ? "muted" : "listening");
      }
      put({ at: new Date().toLocaleTimeString(), event: `state: ${event.state}${bad ? " (failed)" : ""}` });
      return;
    }
    if (typeof event.text === "string") {
      // A refusal to act unattended is the harness's gate speaking, and it is
      // said in the page's own words rather than left in a log nobody opened.
      if (/destructive actions require explicit confirmation/i.test(event.text)) {
        complaint = "the harness refuses destructive actions outright — this build has no Allow/Deny round-trip yet";
        renderComplaint();
      }
      // The untagged copy of a reply. It is used only when the harness never
      // sends the tagged one (an older build), so a reply is never doubled.
      if (!sawTagged) addTurn("voice", event.text);
      if (activity === "thinking") spoke();
      return;
    }
    if (event.interrupted === true) {
      playback?.stopNow();
      clearOutput();
      fadeCaptionLater();
      setActivity(muted ? "muted" : "listening");
    }
  }

  async function listen(): Promise<void> {
    if (opening || disposed) return;
    const epoch = ++generation;
    opening = true;
    renderHero();
    put({ at: new Date().toLocaleTimeString(), event: `opening the session through ${HARNESS}` });
    try {
      const opened = await startSession();
      if (opened.error) throw new Error(opened.error);
      if (epoch !== generation) return;
    } catch (err) {
      if (epoch !== generation || disposed) return;
      // Said plainly, because a silent fallback is how a credential problem
      // gets mistaken for a voice problem.
      opening = false;
      renderHero();
      const why = `Live session could not start — ${String((err as Error).message ?? err)}`;
      complaint = why;
      renderComplaint();
      put({ at: new Date().toLocaleTimeString(), event: why, error: why });
      return;
    }

    const player = new Playback(wantedOutput());
    // A route the browser refuses when the context appears must not end the
    // session: the reply plays where the context already points, and the row
    // says both the device that failed and the one it is playing on.
    player.onSinkError = (err) => {
      outputProblem = routeFailed(wantedOutput(), err, player.sinkId);
      renderDevices();
      put({ at: new Date().toLocaleTimeString(), event: outputProblem, error: outputProblem });
    };
    let audioWork = Promise.resolve();
    let pendingPCM: Int16Array | null = null;
    playback = player;
    player.onSchedule = (info) => {
      if (playback !== player) return;
      noteChunk(info);
      const start = info.start * 1000;
      if (pendingPCM) queuedAudio.push({ pcm: pendingPCM, start, end: start + info.duration * 1000 });
    };
    clearCaptionTimer();
    captionTurn = null;
    captionText = "";
    captions.replaceChildren();
    turns = [];
    renderTranscript();
    try {
      const captured = await startCapture(chosenId || undefined);
      if (!captured) return;
      if (epoch !== generation) {
        captured.stop();
        if (held === captured) held = null;
        return;
      }
      void lookForDevices();
      // Retain the actual context rate for diagnosis. A keyless capture
      // exposed 44.1 kHz corruption; the historical silent session's rate
      // and PCM were not retained, so its cause remains unknown.
      put({
        at: new Date().toLocaleTimeString(),
        event: `microphone: ${captured.label} (${captured.path}) @ ${captured.context.sampleRate} Hz`,
      });
    } catch (err) {
      await endSession().catch(() => undefined);
      await finish();
      const why = `no microphone: ${String((err as Error).message ?? err)}`;
      complaint = why;
      renderComplaint();
      put({ at: new Date().toLocaleTimeString(), event: why, error: why });
      return;
    }

    const live = audioSocket();
    live.binaryType = "arraybuffer";
    socket = live;
    live.onopen = () => put({ at: new Date().toLocaleTimeString(), event: "audio socket open" });
    live.onmessage = (message) => {
      if (socket !== live) return;
      if (typeof message.data === "string") {
        try {
          handleEvent(JSON.parse(message.data) as Record<string, unknown>);
        } catch {
          put({ at: new Date().toLocaleTimeString(), event: message.data.slice(0, 200) });
        }
        return;
      }
      const turn = outputEpoch;
      audioWork = audioWork.then(async () => {
        if (socket !== live || playback !== player || turn !== outputEpoch) return;
        const pcm = await fromBytes(message.data as ArrayBuffer);
        if (socket !== live || turn !== outputEpoch) return;
        pendingPCM = pcm;
        spoke();
        await player.push(pcm);
        pendingPCM = null;
        if (socket !== live || turn !== outputEpoch) {
          player.stopNow();
          if (playback === player) clearOutput();
        }
      }).catch((err) => {
        pendingPCM = null;
        if (socket !== live || playback !== player || turn !== outputEpoch) return;
        complaint = `Audio playback failed — end the session and try again: ${String(err)}`;
        renderComplaint();
        void end();
      });
    };
    live.onclose = (event) => {
      put({ at: new Date().toLocaleTimeString(), event: `audio socket closed ${event.code} ${event.reason}`.trim() });
      if (socket !== live) return;
      complaint = "Audio connection closed. Press Listen to start a new session.";
      renderComplaint();
      void end();
    };
    live.onerror = () => {
      if (socket !== live) return;
      complaint = "Audio connection failed. End the session and try Listen again.";
      renderComplaint();
      put({ at: new Date().toLocaleTimeString(), event: "audio socket error", error: "the socket failed" });
    };

    session = "live";
    muted = false;
    activity = "listening";
    opening = false;
    renderHero();
    stopTicker();
    ticker = requestAnimationFrame(animate);
  }

  async function chooseMic(deviceId: string): Promise<void> {
    chosenId = deviceId;
    store(DEVICE_KEY, deviceId);
    store(DEVICE_NAME_KEY, deviceId ? nameOf(deviceId, mics, DEVICE_NAME_KEY) : "");
    if (session !== "live" && session !== "muted") {
      await lookForDevices();
      return;
    }
    try {
      held?.stop();
      const captured = await startCapture(deviceId);
      if (!captured) return;
      put({ at: new Date().toLocaleTimeString(), event: `microphone changed to ${captured.label}` });
      await lookForDevices();
    } catch (err) {
      // Fall back to the default rather than leaving the session silent, and
      // say so: the choice that failed is still the picker's selection, so the
      // log line is the only place the truth would otherwise be lost.
      const why = whyWords(err);
      put({ at: new Date().toLocaleTimeString(), event: `could not use that microphone: ${why}`, error: why });
      try {
        const captured = await startCapture();
        if (!captured) return;
        put({ at: new Date().toLocaleTimeString(), event: `fell back to ${captured.label}` });
      } catch {
        complaint = "no microphone available";
        renderComplaint();
      }
    }
  }

  async function toggleMute(): Promise<void> {
    if (opening || muting || disposed) return;
    const epoch = ++generation;
    muting = true;
    const next = !muted;
    muted = next;
    if (held) held.muted = next;
    session = next ? "muted" : "live";
    // The mute gate lives in the state model, not only on the track: a muted
    // session never renders as listening, and unmuting after a barge-in goes
    // back to waiting for a sentence rather than to a stale "speaking".
    if (next && activity !== "speaking") activity = "muted";
    if (!next && activity === "muted") activity = "listening";
    renderHero();
    put({ at: new Date().toLocaleTimeString(), event: next ? "muted (session still open)" : "unmuted" });
    try {
      await (next ? muteSession() : unmuteSession());
    } catch (err) {
      if (epoch !== generation) return;
      complaint = String((err as Error).message ?? err);
      renderComplaint();
    } finally {
      if (epoch === generation) {
        muting = false;
        generation++;
        renderHero();
      }
    }
  }

  async function end(): Promise<void> {
    // Local audio stops on the press, not after a network round trip.
    await finish();
    await endSession().catch(() => undefined);
    put({ at: new Date().toLocaleTimeString(), event: "session ended" });
  }

  async function copyLog(): Promise<void> {
    const text = entries
      .map((entry) =>
        JSON.stringify({
          at: entry.at,
          tool: entry.tool,
          args: entry.args,
          operation: entry.operation,
          answered: entry.answered,
          error: entry.error,
          event: entry.event,
        }),
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      copyNote.textContent = "Log copied";
    } catch {
      copyNote.textContent = "Clipboard refused — select the log and copy it by hand.";
    }
  }

  async function save(): Promise<void> {
    try {
      const answer = await saveKey(keyInput.value, provider);
      note = answer.ok === false ? `refused: ${answer.error ?? "no reason given"}` : "key stored";
      keyInput.value = "";
      renderSave();
      renderNote();
      await refresh();
    } catch (err) {
      note = String((err as Error).message ?? err);
      renderNote();
    }
  }

  async function test(): Promise<void> {
    note = "asking the provider…";
    renderNote();
    try {
      const answer = await testKey();
      note = answer.ok ? "the provider accepted the key" : `the provider said: ${answer.answer ?? "nothing"}`;
    } catch (err) {
      note = String((err as Error).message ?? err);
    }
    renderNote();
  }

  async function forget(): Promise<void> {
    try {
      // The harness's existing verb is POST {forget:true}; DELETE is a 405.
      const response = await fetch(`${HARNESS}/key`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ forget: true }),
      });
      if (!response.ok) throw new Error(`harness refused (${response.status})`);
      note = "key forgotten";
      await refresh();
    } catch (err) {
      note = `key not removed — ${String((err as Error).message ?? err)}`;
    }
    renderNote();
  }

  /**
   * **The project is one click away, and every click mints its own pass.**
   *
   * A pass is single-use, so a plain `href` — cached, kept in history, or
   * refreshed — opens a dead link the second time. This asks `/open` on every
   * press and follows whatever fresh address it answers with, whether that is
   * a redirect the fetch followed or a JSON `{ url }`.
   *
   * The tab is opened BEFORE the `await`, because a window opened after one is
   * a popup and browsers block it. It starts blank and is pointed at the
   * harness once the pass is known. The harness is asked for JSON
   * (`accept: application/json`), because the plain redirect it also offers
   * goes to another origin: a fetch may not follow it without CORS headers,
   * and `response.url` would come back without the `#pss_…` fragment the
   * single-use pass lives in. The redirect stays as the fallback for a
   * harness that does not negotiate yet — a top-level navigation can follow
   * it, fragment and all.
   */
  /**
   * **A setup verb, answered honestly when the harness does not have it yet.**
   *
   * The harness half of the setup surface is a frozen contract (bead
   * `isocan-xsh.8`): `GET /daemons`, `GET /canvases`, `POST /canvas`,
   * `POST /actor`, `POST /enrol`. Until that lands, an older harness answers
   * the unknown path with its 405 list — and the answer here is a sentence
   * naming the verb and the command that does it by hand, never a control that
   * looks broken. A 405/404 is not an error to swallow: it is the build saying
   * what it is.
   */
  async function callSetup(
    path: string,
    init?: RequestInit,
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null; error?: string }> {
    try {
      const response = await fetch(HARNESS + path, init);
      const text = await response.text();
      let body: Record<string, unknown> | null = null;
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      if (!response.ok) {
        const said = typeof body?.error === "string" ? body.error : `${response.status} ${text.slice(0, 160)}`;
        return { ok: false, status: response.status, body, error: said };
      }
      return { ok: true, status: response.status, body };
    } catch (err) {
      return { ok: false, status: 0, body: null, error: String((err as Error).message ?? err) };
    }
  }

  /** Ask the harness what it can do, once, so the panel can tell the truth. */
  async function probeSetup(): Promise<void> {
    const [daemons, canvases] = await Promise.all([callSetup("/daemons"), callSetup("/canvases")]);
    if (daemons.ok && Array.isArray(daemons.body?.found)) offered.daemons = daemons.body.found as unknown[];
    if (canvases.ok && Array.isArray(canvases.body?.canvases)) offered.canvases = canvases.body.canvases as unknown[];
    renderSetup();
  }

  /** One step of the setup: a sentence, and either a control or the command. */
  function setupStep(text: string): HTMLElement {
    const li = doc.createElement("li");
    const line = doc.createElement("span");
    line.textContent = text;
    li.appendChild(line);
    setupSteps.appendChild(li);
    return li;
  }

  function setupCode(li: HTMLElement, command: string): void {
    const code = doc.createElement("code");
    code.textContent = command;
    li.appendChild(code);
  }

  function setupAction(li: HTMLElement, label: string, run: () => void): void {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", run);
    li.appendChild(button);
  }

  /**
   * **What is missing, what the harness can do about it, and what to type.**
   *
   * The three setup failures from tonight — "no identity yet", "Voice is
   * taken", and "which project?" — were all environment variables nobody
   * could discover. So each step here is either a control the page can press
   * (when the harness answers the contract) or the exact command, and nothing
   * is ever left as a dead end.
   */
  function renderSetup(): void {
    const audio = audioFacts(facts);
    const enrolled = Boolean(facts?.agent?.enrolled);
    const hasCanvas = Boolean(facts?.canvas?.id);
    const unreachable = !facts && stateComplaint;
    const needed = unreachable || !hasCanvas || !enrolled || !audio.key;
    setupCallout.hidden = !(facts || unreachable) || !needed;
    const missing = [!hasCanvas && "canvas", !enrolled && "enrolled actor", !audio.key && "key"].filter(Boolean);
    const status = unreachable ? "Harness unavailable. Open settings for setup." : `Needs setup: ${missing.join(", ")}.`;
    if (setupStatus.textContent !== status) setupStatus.textContent = status;
    // Polling identical facts must not discard a name being typed or focus.
    const signature = JSON.stringify([facts?.canvas, facts?.agent?.id, facts?.agent?.name, enrolled, audio, unreachable, offered.canvases]);
    if (signature === setupSignature) return;
    setupSignature = signature;
    setupSteps.replaceChildren();
    setupBox.hidden = !needed;
    if (!needed) return;
    setupNote.textContent = unreachable
      ? "Nothing answered at /harness. Start a harness, then reload this page."
      : "These are the harness's to set, not this page's. What this build cannot do is named here, with the command that does it by hand.";


    if (offered.canvases) {
      const li = setupStep(`Canvas: ${facts?.canvas?.title ?? "none"}. Choose another one:`);
      const select = doc.createElement("select");
      select.setAttribute("aria-label", "Canvas");
      for (const one of offered.canvases as { id?: string; title?: string }[]) {
        const option = doc.createElement("option");
        option.value = String(one.id ?? "");
        option.textContent = String(one.title ?? one.id ?? "");
        select.appendChild(option);
      }
      li.appendChild(select);
      setupAction(li, "Use this canvas", () => void setupPost("/canvas", { id: select.value }));
    } else {
      const li = setupStep(`Canvas: ${facts?.canvas?.title ?? "none bound"} — this harness build cannot list or change it from here.`);
      setupCode(li, "isocan voice --canvas \"<name>\"");
    }

    const actor = setupStep(
      `Actor: ${facts?.agent?.name ?? "none"}${facts?.agent?.id ? ` (${facts.agent.id})` : ""} — the microphone speaks as this actor.`,
    );
    const nameInput = doc.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "a name, e.g. Voice";
    nameInput.setAttribute("aria-label", "actor name");
    actor.appendChild(nameInput);
    setupAction(actor, "Claim this name", () => void setupPost("/actor", { name: nameInput.value.trim() }));

    if (enrolled) {
      setupStep("Enrolled: this actor is invited to the canvas as a voice harness.");
    } else {
      const li = setupStep("Not enrolled: nothing can summon it, and the roster has no voice harness for this canvas.");
      setupAction(li, "Enrol from here", () => void setupPost("/enrol", { name: facts?.agent?.name ?? undefined }));
      setupCode(li, `isocan rc add ${facts?.agent?.name ?? "Voice"} --harness voice`);
      setupCode(
        li,
        `"acpAdapters": {"voice": ["node", "<isocan.js>", "voice", "--acp"]} in ~/.isocan/config.json`,
      );
    }

    if (!audio.key) {
      const li = setupStep(`No ${audio.provider === "no provider" ? "provider" : audio.provider} key is stored — the harness cannot open a Live session without one.`);
      setupAction(li, "Add a key", () => {
        connectionPanel.open = false;
        const keyPanel = doc.getElementById("key-panel") as HTMLDetailsElement | null;
        if (keyPanel) keyPanel.open = true;
        keyInput.focus();
      });
    }
  }

  /**
   * **Store the daemon, then ask the harness to take it.**
   *
   * The store happens first and unconditionally: the page can always keep a
   * person's choice, even when it cannot apply it. What it must never do is
   * pretend. So the harness is asked, its answer decides the sentence, and a
   * build without the verb is named — "stored, not yet applied; this harness
   * build fixes its daemon at start" — rather than shown as live.
   */
  async function chooseDaemon(value: string): Promise<void> {
    const wanted = value.trim();
    if (!wanted) {
      daemonNote = "empty — nothing stored";
      renderFacts();
      renderSetup();
      return;
    }
    daemonWant = wanted;
    storeDaemon(wanted);
    daemonNote = "stored, not yet applied";
    renderFacts();
    renderSetup();
    const answer = await callSetup("/daemon", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: wanted }),
    });
    const at = new Date().toLocaleTimeString();
    if (answer.ok) {
      daemonNote = "";
      daemonTried = wanted;
      complaint = "";
      renderComplaint();
      put({ at, event: `daemon: ${JSON.stringify(answer.body ?? {}).slice(0, 160)}` });
      await refresh();
      renderFacts();
      renderSetup();
      return;
    }
    if (answer.status === 404 || answer.status === 405) {
      daemonNote = "stored, not yet applied — this harness build fixes its daemon when it starts";
      put({ at, event: `daemon: ${daemonNote}`, error: daemonNote });
    } else {
      // The harness answered with the daemon's own refusal: that is the
      // validation, and it is worth more than any pattern the page could run.
      daemonNote = `refused: ${answer.error ?? "no reason given"}`;
      put({ at, event: `daemon: ${daemonNote}`, error: daemonNote });
    }
    renderFacts();
    renderSetup();
  }

  /** The way out of a bad stored value — the reason the reset exists. */
  async function resetDaemon(): Promise<void> {
    daemonWant = "";
    daemonNote = "";
    daemonTried = "";
    storeDaemon("");
    renderFacts();
    renderSetup();
    put({ at: new Date().toLocaleTimeString(), event: "daemon preference cleared — the harness's own value is back" });
  }

  /** A setup verb posted, with the answer — or the reason — shown in place. */
  async function setupPost(path: string, body: Record<string, unknown>): Promise<void> {
    const answer = await callSetup(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const at = new Date().toLocaleTimeString();
    if (answer.ok) {
      complaint = "";
      renderComplaint();
      put({ at, event: `${path}: ${JSON.stringify(answer.body ?? {}).slice(0, 200)}` });
      await refresh();
      await probeSetup();
      return;
    }
    // The refusal verbatim, plus what this build is: a 405 is not a mystery.
    const missing = answer.status === 404 || answer.status === 405;
    complaint = missing
      ? `this harness build does not offer ${path} yet — the command above does it by hand`
      : `${path} refused: ${answer.error ?? "no reason given"}`;
    renderComplaint();
    put({ at, event: complaint, error: complaint });
  }

  /**
   * **The permission gate, as the page half: the harness asks, a person
   * answers.**
   *
   * The model can never satisfy this — a `force: true` from the model is the
   * harness's to refuse, and this page only ever posts what a button press
   * said. If the harness never asks (no confirmation round-trip in the build),
   * the refusal it does send is surfaced rather than swallowed.
   */
  function showConfirm(ask: Record<string, unknown>): void {
    const id = String(ask.id ?? "");
    if (!id) return;
    pendingConfirm = { id };
    const what = typeof ask.what === "string" ? ask.what : String(ask.name ?? "an operation");
    confirmWhat.textContent = `The agent wants to ${what}. Nothing happens until you answer.`;
    confirmBox.hidden = false;
    if (settings.open) {
      settings.close();
      // Surface the question, never focus Allow or treat the model as consent.
      confirmWhat.focus();
    }
    put({ at: new Date().toLocaleTimeString(), event: `confirmation asked: ${what}` });
  }

  async function answerConfirm(allow: boolean): Promise<void> {
    const held = pendingConfirm;
    if (!held) return;
    pendingConfirm = null;
    confirmBox.hidden = true;
    const answer = await callSetup("/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: held.id, allow }),
    });
    const at = new Date().toLocaleTimeString();
    if (answer.ok) {
      put({ at, event: allow ? "allowed — the agent may act once" : "denied — nothing was changed" });
      return;
    }
    complaint =
      answer.status === 404 || answer.status === 405
        ? "this harness build asked nothing the page can answer — the gate is not in it yet"
        : `the harness could not take that answer: ${answer.error ?? "no reason"}`;
    renderComplaint();
    put({ at, event: complaint, error: complaint });
  }

  /**
   * **`open_url` is a surface capability, so the page owns the tab.**
   *
   * A canvas item is the harness's to add; a TAB needs a user gesture, which
   * a websocket tool call is not. So the page tries, and when the browser
   * refuses the popup it says so and leaves a button — the "Open the project"
   * pattern, where the press is the gesture.
   */
  async function handleOpenUrl(request: Record<string, unknown>): Promise<void> {
    const callId = String(request.callId ?? "");
    const url = String(request.url ?? "");
    const target = String(request.target ?? "tab");
    const answer = (ok: boolean, opened: string, error?: string) =>
      callSetup("/open_url/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId, ok, opened, ...(error ? { error } : {}) }),
      });
    const scheme = (() => {
      try {
        return new URL(url).protocol;
      } catch {
        return "";
      }
    })();
    if (scheme !== "http:" && scheme !== "https:") {
      const why = `that is not a URL the page will open: ${url}`;
      put({ at: new Date().toLocaleTimeString(), event: `open_url refused — ${why}`, error: why });
      await answer(false, "blocked", why);
      return;
    }
    if (target === "canvas") {
      const why = "adding a canvas item is the harness's half — this build does not offer it yet";
      put({ at: new Date().toLocaleTimeString(), event: `open_url: canvas — ${why}`, error: why });
      await answer(false, "blocked", why);
      return;
    }
    const tab = window.open(url, "_blank");
    if (tab) {
      put({ at: new Date().toLocaleTimeString(), event: `open_url: tab (press) ${url}` });
      await answer(true, "tab");
      return;
    }
    const why = "a tab needs a press — the person must press Open";
    put({ at: new Date().toLocaleTimeString(), event: `open_url: tab blocked — ${url}` });
    await answer(false, "blocked", why);
  }

  async function openProject(): Promise<void> {
    const tab = window.open("about:blank", "_blank");
    const go = (url: string) => {
      if (tab) tab.location.replace(url);
      else window.location.assign(url);
    };
    try {
      const response = await fetch(HARNESS + "/open", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`/open answered ${response.status}`);
      const text = await response.text();
      let url = response.url;
      try {
        const parsed = JSON.parse(text) as { url?: string };
        if (parsed?.url) url = parsed.url;
      } catch {
        // Not JSON: the address the redirect landed on is the answer.
      }
      if (!url || url.endsWith("/open")) throw new Error("no project address in the answer");
      go(url);
      complaint = "";
      renderComplaint();
    } catch {
      // No JSON negotiated, or the harness is not there: the tab asks `/open`
      // directly and follows whatever the harness says. A top-level navigation
      // is not subject to the CORS rule the fetch would be, and it keeps the
      // `#pss_…` fragment the pass lives in.
      go(HARNESS + "/open");
    }
  }

  function openSettings(): void {
    if (disposed || settings.open) return;
    // One alert node, moved into the active surface rather than duplicated
    // into an inert background. Closing restores its conversation location.
    settings.insertBefore(complaintLine, connectionPanel);
    settings.showModal();
    settingsOpen.setAttribute("aria-expanded", "true");
  }

  settingsOpen.addEventListener("click", openSettings);
  setupOpen.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", () => settings.close());
  settings.addEventListener("close", () => {
    hero.insertBefore(complaintLine, confirmBox);
    settingsOpen.setAttribute("aria-expanded", "false");
    // Native restoration handles the opener; setup may have hidden it since.
    if (!disposed && doc.activeElement === doc.body) settingsOpen.focus();
  });

  listenButton.addEventListener("click", () => {
    if (session === "live" || session === "muted") void toggleMute();
    else void listen();
  });
  keepCaptions.addEventListener("change", () => {
    clearCaptionTimer();
    captions.classList.remove("faded");
    if (activity !== "speaking") fadeCaptionLater();
  });
  muteButton.addEventListener("click", () => void toggleMute());
  endButton.addEventListener("click", () => void end());
  deviceSelect.addEventListener("change", () => void chooseMic(deviceSelect.value));
  outputSelect.addEventListener("change", () => void chooseSpeaker(outputSelect.value));
  keyInput.addEventListener("input", renderSave);
  saveKeyButton.addEventListener("click", () => void save());
  testKeyButton.addEventListener("click", () => void test());
  forgetKeyButton.addEventListener("click", () => void forget());
  copyLogButton.addEventListener("click", (event) => {
    // Copying is not opening: the button lives inside the summary, and without
    // this the drawer toggles under the press.
    event.preventDefault();
    event.stopPropagation();
    void copyLog();
  });
  daemonUse.addEventListener("click", () => void chooseDaemon(daemonField.value));
  daemonReset.addEventListener("click", () => void resetDaemon());
  confirmAllow.addEventListener("click", () => void answerConfirm(true));
  confirmDeny.addEventListener("click", () => void answerConfirm(false));
  openButton.addEventListener("click", () => void openProject());

  const onDeviceChange = () => void lookForDevices();
  navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);

  const stateTimer = setInterval(() => void refresh(), 2000);
  const logTimer = setInterval(() => void pollLog(), 2000);
  void refresh();
  void pollLog();
  void lookForDevices();
  // What the harness can do is asked once, so the setup panel can choose
  // between a working control and the command that does the same thing.
  void probeSetup();
  drawWaves(performance.now());
  renderHero();
  renderSave();
  buildTag.textContent = buildWords();

  return {
    stop(): void {
      disposed = true;
      if (settings.open) settings.close();
      generation++;
      captureEpoch++;
      clearCaptionTimer();
      clearOutput();
      clearInterval(stateTimer);
      clearInterval(logTimer);
      stopTicker();
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
      socket?.close();
      socket = null;
      held?.stop();
      held = null;
      playback?.close();
      playback = null;
    },
  };
}
