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
import { Playback, capture, fromBytes, inputs, rmsOf, toBytes, type Capture, type Input, type ScheduleInfo } from "../lib/voiceAudio.ts";
import { HELP_COUNTS, HELP_GROUPS, HELP_REFUSED } from "./capabilities.generated.ts";

/** The input waveform's recent energy samples; not a calibrated dB scale. */
export const BARS = 28;
const DEVICE_KEY = "isocan.voice.deviceId";
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

/** A device id is a preference, not a secret, and not worth failing a render for. */
function storedDevice(): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(DEVICE_KEY) ?? "";
  } catch {
    return "";
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
  const inputWave = required<SVGPathElement>("input-wave", doc);
  const outputWave = required<SVGPathElement>("output-wave", doc);
  const captions = required<HTMLElement>("captions", doc);
  const copyNote = required<HTMLElement>("copy-note", doc);
  const settings = required<HTMLDialogElement>("settings", doc);
  const settingsOpen = required<HTMLButtonElement>("settings-open", doc);
  const settingsClose = required<HTMLButtonElement>("settings-close", doc);
  const logs = required<HTMLDialogElement>("logs", doc);
  const logsOpen = required<HTMLButtonElement>("logs-open", doc);
  const logsClose = required<HTMLButtonElement>("logs-close", doc);
  const help = required<HTMLDialogElement>("help", doc);
  const helpOpen = required<HTMLButtonElement>("help-open", doc);
  const helpClose = required<HTMLButtonElement>("help-close", doc);
  const helpCount = required<HTMLElement>("help-can-count", doc);
  const helpCapabilities = required<HTMLElement>("help-capabilities", doc);
  const helpMissing = required<HTMLElement>("help-can-missing", doc);
  const helpRefused = required<HTMLElement>("help-refused", doc);
  const setupOpen = required<HTMLButtonElement>("setup-open", doc);
  const setupCallout = required<HTMLElement>("setup-callout", doc);
  const setupStatus = required<HTMLElement>("setup-status", doc);
  const motion = doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)");
  const stateLine = required<HTMLElement>("state", doc);
  const buildTag = required<HTMLElement>("build-tag", doc);
  const memorySummary = required<HTMLElement>("memory-summary", doc);
  const memoryNote = required<HTMLElement>("memory-note", doc);
  const memoryList = required<HTMLElement>("memory-list", doc);
  const memoryForgetAll = required<HTMLButtonElement>("memory-forget-all", doc);
  const folderName = required<HTMLElement>("folder-name", doc);
  const folderNote = required<HTMLElement>("folder-note", doc);
  const folderPick = required<HTMLButtonElement>("folder-pick", doc);
  const folderReconnect = required<HTMLButtonElement>("folder-reconnect", doc);
  const folderForget = required<HTMLButtonElement>("folder-forget", doc);
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
  const connectionPanel = required<HTMLElement>("connection-panel", doc);
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
  let chosenId = storedDevice();
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
    stateLine.textContent = stateWords(
      activity,
      muted,
      mics.find((one) => one.id === chosenId)?.label ?? "the default microphone",
    );
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

  /**
   * **A caption is for reading now, not for keeping.**
   *
   * It streams in with the words, and it stays long enough to read a sentence
   * — 50ms a character, never less than 4.5s — and then fades. Persistence
   * has a home: the transcript in Logs. A caption that stays put is a second
   * copy of that record, on the one surface meant to be the conversation.
   *
   * The fade itself is CSS, so `prefers-reduced-motion` already makes it
   * instant without a line of code here (the page's blanket rule turns the
   * transition off).
   */
  function fadeCaptionLater(): void {
    clearCaptionTimer();
    if (!captionText) return;
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

    // Missing prerequisites also get an inline pointer beside the
    // conversation; the modal never opens itself on first run.
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

  /** Labels arrive only after permission, so this runs on load and after capture. */
  async function lookForMics(): Promise<void> {
    try {
      const found = await inputs();
      mics = found;
      deviceSelect.replaceChildren();
      if (found.length === 0) {
        const option = doc.createElement("option");
        option.value = "";
        option.textContent = "microphone 1";
        deviceSelect.appendChild(option);
      }
      for (const one of found) {
        const option = doc.createElement("option");
        option.value = one.id;
        option.textContent = one.label;
        deviceSelect.appendChild(option);
      }
      if (!chosenId && found[0]) chosenId = found[0].id;
      deviceSelect.value = chosenId;
      renderHero();
    } catch {
      // An enumeration failure is not worth a message: the page still works
      // on the default device, which is what a browser without this does.
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
    if (event.memory && typeof event.memory === "object") {
      // The agent's own state, asked of the store that holds it (OPFS here).
      void answerMemoryRequest(event.memory as Record<string, unknown>);
      return;
    }
    if (event.fs && typeof event.fs === "object") {
      // A file question from the harness: answered from the granted handle, or
      // refused in words. Never silence.
      void answerFsRequest(event.fs as Record<string, unknown>);
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

    const player = new Playback();
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
      void lookForMics();
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
    try {
      localStorage.setItem(DEVICE_KEY, deviceId);
    } catch {
      // A preference that cannot be stored is not worth failing the switch for.
    }
    if (session !== "live" && session !== "muted") {
      await lookForMics();
      return;
    }
    try {
      held?.stop();
      const captured = await startCapture(deviceId);
      if (!captured) return;
      put({ at: new Date().toLocaleTimeString(), event: `microphone changed to ${captured.label}` });
      await lookForMics();
    } catch (err) {
      // Fall back to the default rather than leaving the session silent.
      const why = String((err as Error).message ?? err);
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
        // The settings surface is flat, so the field is already on screen:
        // focusing it is what scrolls it into view.
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
    // A question behind a modal is a question nobody sees: close whichever
    // surface is up, then hand focus to the question itself, never to Allow.
    const surfacing = [settings, logs].filter((dialog) => dialog.open);
    for (const dialog of surfacing) dialog.close();
    if (surfacing.length > 0) confirmWhat.focus();
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

  /* ------------------------------------------------------------------ *
   * Memory: the agent's own state, in this browser's OPFS
   * ------------------------------------------------------------------ */

  /**
   * **The agent's state belongs to the page, in OPFS.**
   *
   * Paul's ruling: OPFS — `navigator.storage.getDirectory()` — is the store for
   * the agent's own state (memory, and whatever else the page produces), while
   * a DirectoryHandle is for reading the person's files. OPFS is per-origin,
   * persistent, and needs no permission prompt, which is the whole reason it
   * exists; the harness is the model-facing side and asks for what it needs
   * rather than keeping a copy.
   *
   * Two things make this honest rather than merely convenient:
   *
   *  - **`navigator.storage.persist()` is requested**, and the answer is shown.
   *    Under storage pressure an unpersisted origin can be evicted, and memory
   *    a housekeeping pass can delete is not memory.
   *  - **The store is visible and deletable in the UI**, because it is
   *    per-origin and per-browser: the terminal cannot read it, and a different
   *    profile sees a different store. That is inherent — so the person gets the
   *    list and the delete, here, rather than a store they cannot inspect.
   *
   * A browser without OPFS (or a private window) still gets a working session:
   * the store falls back to this tab's memory, and the note says so instead of
   * pretending the entries will be here tomorrow.
   */
  interface Memory {
    id: string;
    text: string;
    tags: string[];
    at: string;
    session: string;
    presenceId?: string;
  }

  const MEMORY_FILE = "memories.json";
  const MEMORY_DIR = "voice";

  /** The File System Access API surface OPFS needs, as much as is used here. */
  interface OpfsFileHandle {
    createWritable(options?: { keepExistingData?: boolean }): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
    getFile(): Promise<File>;
  }
  interface OpfsDirHandle {
    getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
    getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirHandle>;
    removeEntry?(name: string): Promise<void>;
  }

  let memoryStore: Memory[] | null = null; // the in-tab fallback, when OPFS is absent
  let memoryPersisted: boolean | null = null;

  function opfsRoot(): Promise<OpfsDirHandle | null> {
    return new Promise((resolve) => {
      const storage = (navigator as unknown as { storage?: { getDirectory?: () => Promise<OpfsDirHandle> } }).storage;
      if (!storage?.getDirectory) {
        resolve(null);
        return;
      }
      storage.getDirectory().then(resolve).catch(() => resolve(null));
    });
  }

  async function memoryFile(create: boolean): Promise<OpfsFileHandle | null> {
    const root = await opfsRoot();
    if (!root) return null;
    try {
      const dir = await root.getDirectoryHandle(MEMORY_DIR, { create });
      return await dir.getFileHandle(MEMORY_FILE, { create });
    } catch {
      return null;
    }
  }

  async function readStoredMemories(): Promise<Memory[]> {
    const handle = await memoryFile(false);
    if (!handle) return memoryStore ?? [];
    try {
      const file = await handle.getFile();
      const parsed = JSON.parse(await file.text()) as unknown;
      const list = Array.isArray(parsed) ? parsed : ((parsed as { memories?: unknown })?.memories ?? []);
      if (!Array.isArray(list)) return [];
      return list.filter((one): one is Memory => {
        const m = one as Partial<Memory>;
        return typeof m?.id === "string" && typeof m?.text === "string";
      });
    } catch {
      return []; // a missing or corrupt file is an empty store, never fatal
    }
  }

  async function writeStoredMemories(list: Memory[]): Promise<boolean> {
    const handle = await memoryFile(true);
    if (!handle) {
      memoryStore = list; // session-only, and the note says so
      return false;
    }
    try {
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify(list, null, 2) + "\n");
      await writable.close();
      return true;
    } catch {
      memoryStore = list;
      return false;
    }
  }

  /** Ask the browser to keep this origin's storage, and say what it answered. */
  async function askToPersist(): Promise<boolean | null> {
    if (memoryPersisted !== null) return memoryPersisted;
    const storage = (navigator as unknown as {
      storage?: { persist?: () => Promise<boolean>; persisted?: () => Promise<boolean> };
    }).storage;
    if (!storage?.persist) {
      memoryPersisted = false;
      return false;
    }
    try {
      memoryPersisted = (await storage.persist()) || Boolean(await storage.persisted?.());
    } catch {
      memoryPersisted = false;
    }
    renderMemory();
    return memoryPersisted;
  }

  function memoryWords(one: Memory): string {
    return `${one.text}${one.tags.length ? ` [${one.tags.join(", ")}]` : ""}`;
  }

  function renderMemory(): void {
    void (async () => {
      const list = await readStoredMemories();
      memorySummary.textContent = list.length === 0 ? "nothing stored" : `${list.length} ${list.length === 1 ? "memory" : "memories"}`;
      memoryForgetAll.hidden = list.length === 0;
      memoryNote.textContent = list.length === 0
        ? "Nothing stored yet. The agent keeps what it is told to remember in this browser's own storage — no server, no key."
        : memoryPersisted === false
          ? "Stored in this browser for this session only — this browser would not grant persistent storage, so it may be cleared."
          : "Stored in this browser (this origin only), persistent where the browser granted it. The terminal cannot read these.";
      memoryList.replaceChildren();
      for (const one of list) {
        const row = doc.createElement("li");
        chunk(row, "voice-at", one.at ? one.at.slice(0, 19).replace("T", " ") : "");
        const text = doc.createElement("span");
        text.textContent = memoryWords(one);
        row.appendChild(text);
        chunk(row, "voice-id", one.session);
        const forget = doc.createElement("button");
        forget.type = "button";
        forget.textContent = "Forget";
        forget.addEventListener("click", () => void forgetMemoryEntry(one.id));
        row.appendChild(forget);
        memoryList.appendChild(row);
      }
    })();
  }

  async function forgetMemoryEntry(id: string): Promise<void> {
    const list = await readStoredMemories();
    const next = list.filter((one) => one.id !== id);
    await writeStoredMemories(next);
    put({ at: new Date().toLocaleTimeString(), event: `forgot memory ${id}` });
    renderMemory();
  }

  async function forgetAllMemories(): Promise<void> {
    await writeStoredMemories([]);
    put({ at: new Date().toLocaleTimeString(), event: "forgot every memory in this browser" });
    renderMemory();
  }

  function newMemoryId(): string {
    return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * **The one-time move off the harness's file.**
   *
   * Memory used to be the harness's (`~/.isocan/voice/memories.json`). It now
   * lives here, so on load the page offers to take whatever is still on disk,
   * merges by id (never overwriting something already in OPFS), and tells the
   * harness it is done — which retires the file. Nobody loses a memory because
   * the shelf moved.
   */
  async function migrateLegacyMemories(): Promise<void> {
    const answer = await callSetup("/memory/legacy").catch(() => null);
    if (!answer?.ok || !Array.isArray(answer.body?.entries)) return;
    const legacy = (answer.body.entries as Memory[]).filter((one) => one && typeof one.id === "string");
    if (legacy.length === 0) return;
    const existing = await readStoredMemories();
    const known = new Set(existing.map((one) => one.id));
    const incoming = legacy.filter((one) => !known.has(one.id));
    const merged = [...existing, ...incoming];
    const stored = await writeStoredMemories(merged);
    put({
      at: new Date().toLocaleTimeString(),
      event: `migrated ${incoming.length} ${incoming.length === 1 ? "memory" : "memories"} from the harness's file into this browser`,
    });
    if (incoming.length > 0 || !stored) await callSetup("/memory/migrated", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: incoming.length }),
    }).catch(() => undefined);
    renderMemory();
  }

  /**
   * **The page's answer to `{ memory: … }`** — the same round trip as files, for
   * the agent's own state. Search is a case-insensitive substring over text and
   * tags, and the answer says so: the model must not be told it has semantic
   * recall it does not have. The model cannot delete or enumerate here either —
   * there is no branch for it.
   */
  async function answerMemoryRequest(request: Record<string, unknown>): Promise<void> {
    const callId = String(request.callId ?? "");
    const op = String(request.op ?? "");
    const at = new Date().toLocaleTimeString();
    const reply = (body: Record<string, unknown>) =>
      callSetup("/memory/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId, ...body }),
      }).catch(() => undefined);

    try {
      const stored = await readStoredMemories();
      if (op === "remember") {
        const text = String(request.text ?? "").trim();
        if (!text) {
          await reply({ ok: false, error: "a memory needs text" });
          return;
        }
        await askToPersist();
        const one: Memory = {
          id: newMemoryId(),
          text,
          tags: Array.isArray(request.tags) ? (request.tags as string[]).filter((t) => typeof t === "string") : [],
          at: new Date().toISOString(),
          session: String(request.session ?? "unknown"),
          ...(typeof request.presenceId === "string" ? { presenceId: request.presenceId } : {}),
        };
        await writeStoredMemories([...stored, one]);
        await reply({ ok: true, id: one.id, at: one.at, tags: one.tags });
        put({ at, event: `remembered in this browser (${one.id}): ${one.text.slice(0, 120)}` });
        renderMemory();
        return;
      }
      if (op === "read") {
        const id = String(request.id ?? "");
        const found = stored.find((one) => one.id === id) ?? null;
        await reply(
          found
            ? { ok: true, memory: found }
            : { ok: false, error: `no memory with id "${id}"`, recentIds: stored.slice(-5).map((one) => one.id) },
        );
        return;
      }
      if (op === "search") {
        const query = String(request.query ?? "").trim().toLowerCase();
        const found = query
          ? stored.filter(
              (one) =>
                one.text.toLowerCase().includes(query) ||
                one.tags.some((tag) => tag.toLowerCase().includes(query)),
            )
          : stored;
        await reply({ ok: true, count: found.length, memories: found.slice(0, 50) });
        put({ at, event: `searched this browser's memory: ${found.length} match${found.length === 1 ? "" : "es"}` });
        return;
      }
      await reply({ ok: false, error: `unknown memory operation: ${op || "(none)"}` });
    } catch (err) {
      const why = String((err as Error).message ?? err);
      await reply({ ok: false, error: why });
      put({ at, event: `memory ${op} failed: ${why}`, error: why });
    }
  }

  /* ------------------------------------------------------------------ *
   * Local files: the one capability only this page can ask for
   * ------------------------------------------------------------------ */

  /**
   * **A folder the person picked, kept where a handle can be kept.**
   *
   * The File System Access API is the only way to reach a person's own files,
   * and it is deliberately awkward: the picker needs a real click, the handle
   * is a browser object (it cannot be sent anywhere — the harness is told the
   * folder's NAME), and permission is granted per session, so a returning page
   * must ask again. That last part is the one this page must not paper over:
   * when the browser has not re-granted, the page says "Reconnect" and the
   * harness refuses the read in words, rather than reading nothing quietly.
   *
   * Nothing here reads data the page was not handed. There is no filesystem
   * access beyond the one directory handle, and no path can leave it.
   */
  interface FsHandle {
    kind: "file" | "directory";
    name: string;
    entries?(): AsyncIterableIterator<[string, FsHandle]>;
    getFileHandle?(name: string, options?: { create?: boolean }): Promise<FsHandle>;
    getDirectoryHandle?(name: string, options?: { create?: boolean }): Promise<FsHandle>;
    getFile?(): Promise<File>;
    queryPermission?(options: { mode: "read" }): Promise<PermissionState>;
    requestPermission?(options: { mode: "read" }): Promise<PermissionState>;
  }

  /** What the page will read for a model, matched to the harness's caps. */
  const FS_MAX_BYTES = 256 * 1024;
  const FS_MAX_ENTRIES = 500;
  const FS_DB = "isocan.voice.fs";
  const FS_STORE = "handles";
  const FS_KEY = "folder";

  /**
   * **The handle is remembered in IndexedDB, and the page says when it cannot
   * be.** A directory handle is structured-cloneable, so it can be stored and
   * reused across reloads — but IndexedDB is not always there (a private
   * window), and then the grant lasts the session and the page says exactly
   * that rather than implying it will still be here tomorrow.
   */
  function handleDb(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(FS_DB, 1);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => request.result.createObjectStore(FS_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  }

  /** Remember the handle (or forget it). Answers whether it persisted. */
  async function saveFolderHandle(handle: FsHandle | null): Promise<boolean> {
    const db = await handleDb();
    if (!db) return false;
    return await new Promise<boolean>((resolve) => {
      try {
        const tx = db.transaction(FS_STORE, "readwrite");
        const store = tx.objectStore(FS_STORE);
        if (handle) store.put(handle, FS_KEY);
        else store.delete(FS_KEY);
        tx.oncomplete = () => resolve(handle !== null);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  async function loadFolderHandle(): Promise<FsHandle | null> {
    const db = await handleDb();
    if (!db) return null;
    return await new Promise<FsHandle | null>((resolve) => {
      try {
        const request = db.transaction(FS_STORE, "readonly").objectStore(FS_STORE).get(FS_KEY);
        request.onsuccess = () => resolve((request.result as FsHandle | undefined) ?? null);
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  let folder: { handle: FsHandle | null; name: string | null; permission: "none" | "granted" | "needs-permission" | "unsupported"; persisted: boolean } = {
    handle: null,
    name: null,
    permission: "none",
    persisted: false,
  };

  function renderFolder(): void {
    const named = Boolean(folder.name);
    folderName.textContent = named
      ? folder.name!
      : folder.permission === "unsupported"
        ? "this browser cannot grant a folder"
        : "no folder granted";
    folderNote.textContent = !named
      ? ""
      : folder.permission === "granted"
        ? folder.persisted
          ? ""
          : " — kept for this session only"
        : " — the browser wants permission again";
    folderPick.hidden = named && folder.permission === "granted";
    folderReconnect.hidden = !(named && folder.permission === "needs-permission");
    folderForget.hidden = !named;
  }

  /** Tell the harness what it may read — a name, never a handle. */
  async function reportGrant(): Promise<void> {
    const granted = folder.permission === "granted" && Boolean(folder.name);
    await callSetup("/fs/grant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: granted ? folder.name : null, granted }),
    }).catch(() => undefined);
  }

  async function pickFolder(): Promise<void> {
    const picker = (window as unknown as { showDirectoryPicker?: (options: { mode: "read" }) => Promise<FsHandle> })
      .showDirectoryPicker;
    if (!picker) {
      folder.permission = "unsupported";
      renderFolder();
      return;
    }
    try {
      const handle = await picker.call(window, { mode: "read" });
      const allowed = handle.queryPermission ? await handle.queryPermission({ mode: "read" }) : "granted";
      folder = {
        handle,
        name: handle.name,
        permission: allowed === "granted" ? "granted" : "needs-permission",
        persisted: await saveFolderHandle(handle),
      };
      renderFolder();
      put({ at: new Date().toLocaleTimeString(), event: `folder granted: ${handle.name}` });
      await reportGrant();
    } catch (err) {
      // Closing the picker is a decision, not a failure worth a red line.
      if ((err as Error)?.name !== "AbortError") {
        complaint = `could not open that folder: ${String((err as Error).message ?? err)}`;
        renderComplaint();
      }
    }
  }

  /** Permission is per session: this is the button the browser's rule needs. */
  async function reconnectFolder(): Promise<void> {
    const handle = folder.handle;
    if (!handle?.requestPermission) return;
    try {
      const allowed = await handle.requestPermission({ mode: "read" });
      folder.permission = allowed === "granted" ? "granted" : "needs-permission";
      renderFolder();
      put({
        at: new Date().toLocaleTimeString(),
        event: allowed === "granted" ? `folder reconnected: ${folder.name}` : `folder not re-granted: ${folder.name}`,
      });
      await reportGrant();
    } catch (err) {
      complaint = `the browser refused that folder: ${String((err as Error).message ?? err)}`;
      renderComplaint();
    }
  }

  async function forgetFolder(): Promise<void> {
    const was = folder.name;
    await saveFolderHandle(null);
    folder = { handle: null, name: null, permission: "none", persisted: false };
    renderFolder();
    put({ at: new Date().toLocaleTimeString(), event: `folder access dropped: ${was ?? "none"}` });
    await reportGrant();
  }

  /** A path inside the granted folder, or null. `..` and absolutes never fit. */
  async function resolveInFolder(root: FsHandle, path: string, want: "file" | "directory"): Promise<FsHandle | null> {
    const parts = path.split("/").filter((one) => one && one !== ".");
    let dir: FsHandle = root;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      const last = index === parts.length - 1;
      if (last && want === "file") {
        try {
          return (await dir.getFileHandle?.(part, { create: false })) ?? null;
        } catch {
          return null;
        }
      }
      const next = await dir.getDirectoryHandle?.(part, { create: false }).catch(() => null);
      if (!next) return null;
      dir = next;
    }
    return want === "directory" ? dir : null;
  }

  /**
   * **The page's answer to `{ fs: … }`, which is the whole point of the
   * round trip.** Every branch answers: content, or a sentence saying why not.
   * The harness turns the sentence into the tool's refusal, so the model hears
   * the reason and the person can see it in the log.
   */
  async function answerFsRequest(request: Record<string, unknown>): Promise<void> {
    const callId = String(request.callId ?? "");
    const op: "list_dir" | "read_file" = request.op === "list_dir" ? "list_dir" : "read_file";
    const path = String(request.path ?? "");
    const at = new Date().toLocaleTimeString();
    const reply = (body: Record<string, unknown>) =>
      callSetup("/fs/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId, ...body }),
      }).catch(() => undefined);

    if (!folder.handle || folder.permission !== "granted") {
      const why = folder.name
        ? "the folder needs permission again — press Reconnect in the page"
        : "no folder is granted in the page";
      await reply({ ok: false, error: why });
      put({ at, event: `${op} refused (${path || "/"}): ${why}` });
      return;
    }
    try {
      if (op === "list_dir") {
        const dir = await resolveInFolder(folder.handle, path, "directory");
        if (!dir?.entries) {
          await reply({ ok: false, error: `no such folder: ${path || "/"}` });
          return;
        }
        const entries: { name: string; kind: "file" | "directory" }[] = [];
        let truncated = false;
        for await (const [name, node] of dir.entries()) {
          if (entries.length >= FS_MAX_ENTRIES) {
            truncated = true;
            break;
          }
          entries.push({ name, kind: node.kind === "directory" ? "directory" : "file" });
        }
        await reply({ ok: true, entries, truncated });
        put({ at, event: `listed ${entries.length} entries in ${folder.name}/${path}`.replace(/\/$/, "") });
        return;
      }
      const file = await (await resolveInFolder(folder.handle, path, "file"))?.getFile?.();
      if (!file) {
        await reply({ ok: false, error: `no such file: ${path}` });
        put({ at, event: `read refused: no such file: ${path}` });
        return;
      }
      const truncated = file.size > FS_MAX_BYTES;
      const content = await (truncated ? file.slice(0, FS_MAX_BYTES) : file).text();
      await reply({ ok: true, content, bytes: file.size, truncated });
      put({ at, event: `read ${folder.name}/${path} (${content.length} chars${truncated ? ", truncated" : ""})` });
    } catch (err) {
      const why = String((err as Error).message ?? err);
      await reply({ ok: false, error: why });
      put({ at, event: `read failed (${path}): ${why}`, error: why });
    }
  }

  /** On load: the handle comes back, and the browser decides if it still works. */
  async function restoreFolder(): Promise<void> {
    const handle = await loadFolderHandle();
    if (!handle) {
      renderFolder();
      return;
    }
    const allowed = handle.queryPermission ? await handle.queryPermission({ mode: "read" }) : "denied";
    folder = {
      handle,
      name: handle.name,
      permission: allowed === "granted" ? "granted" : "needs-permission",
      persisted: true,
    };
    renderFolder();
    await reportGrant();
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

  // A mobile keyboard can shrink the visual viewport without changing dvh.
  // Keep the settings scroll surface, and its focused input, in visible space.
  const viewport = doc.defaultView?.visualViewport;
  function fitSettings(): void {
    if (!viewport) return; // CSS viewport units remain the fallback.
    settings.style.setProperty("--voice-visible-height", `${viewport.height}px`);
    settings.style.setProperty("--voice-visible-top", `${viewport.offsetTop}px`);
    const focused = doc.activeElement;
    if (settings.open && focused instanceof HTMLElement && settings.contains(focused) && focused.matches("input, select, textarea"))
      focused.scrollIntoView({ block: "nearest" });
  }
  viewport?.addEventListener("resize", fitSettings);
  viewport?.addEventListener("scroll", fitSettings);
  fitSettings();

  function openSettings(): void {
    if (disposed || settings.open) return;
    // One alert node, moved into the active surface rather than duplicated
    // into an inert background. Closing restores its conversation location.
    settings.insertBefore(complaintLine, connectionPanel);
    settings.showModal();
    settingsOpen.setAttribute("aria-expanded", "true");
  }

  function openLogs(): void {
    if (disposed || logs.open) return;
    logs.showModal();
    logsOpen.setAttribute("aria-expanded", "true");
  }

  /**
   * **The capability section, from the sweep rather than from memory.**
   *
   * `HELP_GROUPS` is generated by `scripts/voice-capability-sweep.mjs` from the
   * same rows as `docs/projects/voice-harness/capability-sweep.md`, and
   * `packages/web/test/voicehelp.test.ts` fails when the two disagree. So the
   * count a person reads here is the count the sweep computed, and a tool the
   * harness gains appears without anybody editing this page — which is the only
   * way a help section stays true for longer than a week.
   *
   * Built once, on the first open: the dialog is read, never polled.
   */
  function renderHelp(): void {
    if (helpCapabilities.childElementCount > 0) return;
    helpCount.textContent =
      `${HELP_COUNTS.total} capabilities are written down across the engine, the CLI, the agent guide, ` +
      `MCP, the web UI and this harness's own tool declarations — ${HELP_COUNTS.tooled} are tooled today. ` +
      `Grouped below by what you would ask for, with the tool name beside each one.`;
    for (const group of HELP_GROUPS) {
      const heading = doc.createElement("h4");
      heading.className = "voice-help-sub";
      heading.textContent = group.title;
      const list = doc.createElement("ul");
      list.className = "voice-help-acts";
      for (const act of group.acts) {
        const item = doc.createElement("li");
        const label = doc.createElement("span");
        label.textContent = act.label;
        const tool = doc.createElement("code");
        tool.textContent = act.tool;
        item.append(label, tool);
        list.append(item);
      }
      helpCapabilities.append(heading, list);
    }
    helpMissing.textContent =
      `${HELP_COUNTS.missing} more are named on other surfaces — the CLI, the web UI, the agent guide — ` +
      `and have no voice tool yet; ${HELP_COUNTS.excluded} are excluded on purpose, below.`;
    for (const refusal of HELP_REFUSED) {
      const item = doc.createElement("li");
      const label = doc.createElement("code");
      label.textContent = refusal.label;
      const reason = doc.createElement("span");
      reason.className = "voice-help-why";
      reason.textContent = refusal.why;
      item.append(label, reason);
      helpRefused.append(item);
    }
  }

  function openHelp(): void {
    if (disposed || help.open) return;
    renderHelp();
    help.showModal();
    helpOpen.setAttribute("aria-expanded", "true");
  }

  settingsOpen.addEventListener("click", openSettings);
  setupOpen.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", () => settings.close());
  logsOpen.addEventListener("click", openLogs);
  logsClose.addEventListener("click", () => logs.close());
  helpOpen.addEventListener("click", openHelp);
  helpClose.addEventListener("click", () => help.close());
  /**
   * **Click-outside, where the platform does not do it for us.**
   *
   * `closedby="any"` on all three dialogs in voice.html is the whole feature in
   * Chrome 134+ and Firefox 141+. Safari has no `closedBy` (it is still only
   * in preview, so this path runs for real), and it has three traps worth
   * naming, because the obvious implementation fails all three:
   *
   * 1. A click on the dialog's own padding reports the DIALOG as its event
   *    target, exactly like a backdrop click — so `target === dialog` would
   *    close the panel whenever somebody pressed its edge.
   * 2. A click on the backdrop over the page body reports the BODY as its
   *    target (measured in Chrome), so a listener bound to the dialog would
   *    miss the very click this exists for.
   * 3. The click that OPENS the dialog is itself a click outside it (the cog
   *    and the logs button are outside the box), so dismissing on `click`
   *    closes the dialog in the same dispatch that opened it.
   *
   * The coordinates answer (1) and (2) — they are the test the HTML spec names
   * for the nearest clicked dialog, 4.11.5 — and the pointerdown answers (3):
   * the press that opens the dialog lands while it is still shut. Listening on
   * the document is safe because a modal dialog makes the page behind inert.
   * Anything belonging to the dialog's own tree still counts as inside, since
   * a native popup reports coordinates where the popup is painted.
   */
  if (!("closedBy" in HTMLDialogElement.prototype)) {
    doc.addEventListener("pointerdown", (event) => {
      // All three are modal, so the other openers are behind a backdrop and
      // cannot be pressed: at most one of them is up, and it is the one the
      // press has to be measured against.
      const dialog = [settings, logs, help].find((one) => one.open);
      if (!dialog) return;
      const box = dialog.getBoundingClientRect();
      const onTheDialog =
        event.clientX >= box.left && event.clientX <= box.right &&
        event.clientY >= box.top && event.clientY <= box.bottom;
      // A press on the dialog's own box is not a press outside it — including
      // the padding, which reports the dialog as its target.
      if (onTheDialog) return;
      // Anything owned by the dialog still counts as inside, though: a native
      // popup reports the coordinates where the popup is painted, and the
      // dialog itself is excluded here so that a backdrop press reporting the
      // dialog as its target still gets decided by the coordinates above.
      if (event.target !== dialog && dialog.contains(event.target as Node)) return;
      dialog.close();
    });
  }
  for (const [dialog, opener] of [[settings, settingsOpen], [logs, logsOpen], [help, helpOpen]] as const) {
    dialog.addEventListener("close", () => {
      opener.setAttribute("aria-expanded", "false");
      // Native restoration handles the opener; settings may have hidden it
      // since, and a dialog dismissed from the backdrop has no opener at all.
      if (!disposed && doc.activeElement === doc.body) opener.focus();
    });
  }
  settings.addEventListener("close", () => {
    hero.insertBefore(complaintLine, confirmBox);
  });

  listenButton.addEventListener("click", () => {
    if (session === "live" || session === "muted") void toggleMute();
    else void listen();
  });
  muteButton.addEventListener("click", () => void toggleMute());
  endButton.addEventListener("click", () => void end());
  deviceSelect.addEventListener("change", () => void chooseMic(deviceSelect.value));
  keyInput.addEventListener("input", renderSave);
  saveKeyButton.addEventListener("click", () => void save());
  testKeyButton.addEventListener("click", () => void test());
  forgetKeyButton.addEventListener("click", () => void forget());
  copyLogButton.addEventListener("click", () => void copyLog());
  memoryForgetAll.addEventListener("click", () => void forgetAllMemories());
  folderPick.addEventListener("click", () => void pickFolder());
  folderReconnect.addEventListener("click", () => void reconnectFolder());
  folderForget.addEventListener("click", () => void forgetFolder());
  daemonUse.addEventListener("click", () => void chooseDaemon(daemonField.value));
  daemonReset.addEventListener("click", () => void resetDaemon());
  confirmAllow.addEventListener("click", () => void answerConfirm(true));
  confirmDeny.addEventListener("click", () => void answerConfirm(false));
  openButton.addEventListener("click", () => void openProject());

  const onDeviceChange = () => void lookForMics();
  navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);

  const stateTimer = setInterval(() => void refresh(), 2000);
  const logTimer = setInterval(() => void pollLog(), 2000);
  void refresh();
  void pollLog();
  void lookForMics();
  // What the harness can do is asked once, so the setup panel can choose
  // between a working control and the command that does the same thing.
  void probeSetup();
  drawWaves(performance.now());
  // The folder grant: restored from IndexedDB, reported honestly either way —
  // a returning page whose permission lapsed says so instead of reading nothing.
  renderFolder();
  void restoreFolder();
  // Memory: the page's own store. Show what is kept, ask the browser to keep it
  // for real, and take anything the harness's old file still holds.
  renderMemory();
  void askToPersist();
  void migrateLegacyMemories();
  renderHero();
  renderSave();
  buildTag.textContent = buildWords();

  return {
    stop(): void {
      disposed = true;
      viewport?.removeEventListener("resize", fitSettings);
      viewport?.removeEventListener("scroll", fitSettings);
      if (settings.open) settings.close();
      if (logs.open) logs.close();
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
