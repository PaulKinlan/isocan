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
import { LevelMeter, Playback, capture, fromBytes, inputs, toBytes, type Capture, type Input } from "../lib/voiceAudio.ts";

/** The meter's resolution: 28 bars across −60…0 dBFS. */
export const BARS = 28;
const DEVICE_KEY = "isocan.voice.deviceId";

/** The page is markup, so a missing element is a broken page, not a blank. */
function required<T extends HTMLElement>(id: string, doc: Document): T {
  const found = doc.getElementById(id);
  if (!found) throw new Error(`the voice page is missing #${id}`);
  return found as T;
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
 * **The state line says which microphone, because "it is using the wrong one"
 * is not diagnosable from a word like "live".**
 */
function stateWords(session: SessionState, microphone: string): string {
  if (session === "live") return `live — listening on ${microphone}`;
  if (session === "muted") return `muted — ${microphone} is still open`;
  if (session === "ended") return "ended";
  return "idle — press Listen to start";
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
  const meter = required<HTMLElement>("meter", doc);
  const bars = required<HTMLElement>("bars", doc);
  const peakMark = required<HTMLElement>("peak", doc);
  const stateLine = required<HTMLElement>("state", doc);
  const canvasTitle = required<HTMLElement>("canvas-title", doc);
  const canvasId = required<HTMLElement>("canvas-id", doc);
  const daemonLine = required<HTMLElement>("daemon", doc);
  const homeLine = required<HTMLElement>("home", doc);
  const actorName = required<HTMLElement>("actor-name", doc);
  const actorId = required<HTMLElement>("actor-id", doc);
  const actorStanding = required<HTMLElement>("actor-standing", doc);
  const audioLine = required<HTMLElement>("audio", doc);
  const versionLine = required<HTMLElement>("version", doc);
  const updatedLine = required<HTMLElement>("updated", doc);
  const complaintLine = required<HTMLElement>("complaint", doc);
  const openButton = required<HTMLButtonElement>("open-project", doc);
  const keyInput = required<HTMLInputElement>("key", doc);
  const providerSelect = required<HTMLSelectElement>("provider", doc);
  const saveKeyButton = required<HTMLButtonElement>("save-key", doc);
  const testKeyButton = required<HTMLButtonElement>("test-key", doc);
  const forgetKeyButton = required<HTMLButtonElement>("forget-key", doc);
  const keyNote = required<HTMLElement>("key-note", doc);
  const logList = required<HTMLElement>("log", doc);
  const copyLogButton = required<HTMLButtonElement>("copy-log", doc);

  const barEls: HTMLElement[] = [];
  for (let i = 0; i < BARS; i++) {
    const bar = doc.createElement("span");
    bars.appendChild(bar);
    barEls.push(bar);
  }

  let facts: State | null = null;
  let session: SessionState = "idle";
  let muted = false;
  let entries: LogEntry[] = [];
  let mics: Input[] = [];
  let chosenId = storedDevice();
  let provider = providerSelect.value || "gemini";
  let complaint = "";
  let note = "";
  /** True only while the state poll is the thing that failed. */
  let stateComplaint = false;
  let held: Capture | null = null;
  let socket: WebSocket | null = null;
  let playback: Playback | null = null;
  let levelMeter: LevelMeter | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  function renderHero(): void {
    hero.dataset.state = session;
    listenButton.disabled = session === "live" || session === "muted";
    muteButton.disabled = session !== "live" && session !== "muted";
    endButton.disabled = session === "idle" || session === "ended";
    muteButton.textContent = muted ? "Unmute" : "Mute";
    stateLine.textContent = stateWords(
      session,
      mics.find((one) => one.id === chosenId)?.label ?? "the default microphone",
    );
  }

  function renderMeter(level: number, peak: number): void {
    barEls.forEach((bar, index) => bar.classList.toggle("on", index / BARS < level));
    const percent = Math.round(peak * 100);
    peakMark.hidden = peak <= 0;
    peakMark.style.left = `${Math.min(100, percent)}%`;
    meter.setAttribute("aria-label", `input level ${Math.round(level * 100)} percent, peak ${percent} percent`);
  }

  function renderFacts(): void {
    canvasTitle.textContent = facts?.canvas?.title ?? "unknown";
    canvasId.textContent = facts?.canvas?.id ?? "no id";
    daemonLine.textContent = facts?.daemon ?? "unknown";
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

  function put(entry: LogEntry): void {
    entries = [entry, ...entries].slice(0, 200);
    renderLog();
  }

  const refresh = async (): Promise<void> => {
    try {
      const next = await fetchState();
      facts = next;
      renderFacts();
      const running = sessionFrom(next);
      if (running) {
        session = running;
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
      stateComplaint = true;
      complaint = String((err as Error).message ?? err);
      renderComplaint();
    }
  };

  const pollLog = async (): Promise<void> => {
    try {
      const reply = await fetchLog();
      // Newest first, because a live log is read from the top: the harness
      // answers oldest-first and the newest tool call is the one a person
      // came to see, not the last of thirty session events.
      entries = entriesFrom(reply).slice(-200).reverse();
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
  async function startCapture(deviceId?: string): Promise<Capture> {
    const captured = await capture((pcm) => {
      const live = socket;
      if (live?.readyState === WebSocket.OPEN) live.send(toBytes(pcm));
      levelMeter?.feed(pcm);
    }, deviceId);
    held = captured;
    return captured;
  }

  function stopTicker(): void {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
  }

  async function finish(): Promise<void> {
    socket?.close();
    socket = null;
    held?.stop();
    held = null;
    playback?.close();
    playback = null;
    stopTicker();
    levelMeter?.reset();
    levelMeter = null;
    renderMeter(0, 0);
    session = "ended";
    renderHero();
  }

  async function listen(): Promise<void> {
    put({ at: new Date().toLocaleTimeString(), event: `opening the session through ${HARNESS}` });
    try {
      const opened = await startSession();
      if (opened.error) throw new Error(opened.error);
    } catch (err) {
      // Said plainly, because a silent fallback is how a credential problem
      // gets mistaken for a voice problem.
      const why = `Live session could not start — ${String((err as Error).message ?? err)}`;
      complaint = why;
      renderComplaint();
      put({ at: new Date().toLocaleTimeString(), event: why, error: why });
      return;
    }

    playback = new Playback();
    levelMeter = new LevelMeter(BARS);
    try {
      const captured = await startCapture(chosenId || undefined);
      put({ at: new Date().toLocaleTimeString(), event: `microphone: ${captured.label} (${captured.path})` });
    } catch (err) {
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
    live.onmessage = async (message) => {
      if (typeof message.data === "string") {
        try {
          const event = JSON.parse(message.data) as { interrupted?: boolean; turn_complete?: boolean };
          if (event.interrupted) playback?.stopNow();
          put({ at: new Date().toLocaleTimeString(), event: JSON.stringify(event).slice(0, 200) });
        } catch {
          put({ at: new Date().toLocaleTimeString(), event: message.data.slice(0, 200) });
        }
        return;
      }
      await playback?.push(await fromBytes(message.data as ArrayBuffer));
    };
    live.onclose = (event) =>
      put({ at: new Date().toLocaleTimeString(), event: `audio socket closed ${event.code} ${event.reason}`.trim() });
    live.onerror = () => put({ at: new Date().toLocaleTimeString(), event: "audio socket error", error: "the socket failed" });

    session = "live";
    muted = false;
    renderHero();
    ticker = setInterval(() => {
      const reading = levelMeter?.tick();
      if (!reading) {
        renderMeter(0, 0);
        return;
      }
      renderMeter(reading.level, reading.peak);
    }, 100);
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
      put({ at: new Date().toLocaleTimeString(), event: `microphone changed to ${captured.label}` });
      await lookForMics();
    } catch (err) {
      // Fall back to the default rather than leaving the session silent.
      const why = String((err as Error).message ?? err);
      put({ at: new Date().toLocaleTimeString(), event: `could not use that microphone: ${why}`, error: why });
      try {
        const captured = await startCapture();
        put({ at: new Date().toLocaleTimeString(), event: `fell back to ${captured.label}` });
      } catch {
        complaint = "no microphone available";
        renderComplaint();
      }
    }
  }

  async function toggleMute(): Promise<void> {
    const next = !muted;
    muted = next;
    if (held) held.muted = next;
    session = next ? "muted" : "live";
    renderHero();
    put({ at: new Date().toLocaleTimeString(), event: next ? "muted (session still open)" : "unmuted" });
    await (next ? muteSession() : unmuteSession()).catch((err) => {
      complaint = String((err as Error).message ?? err);
      renderComplaint();
    });
  }

  async function end(): Promise<void> {
    await endSession().catch(() => undefined);
    await finish();
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
      note = "log copied";
    } catch {
      note = "clipboard refused — select the log and copy it by hand";
    }
    renderNote();
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
    await fetch(`${HARNESS}/key`, { method: "DELETE" }).catch(() => undefined);
    await refresh();
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

  listenButton.addEventListener("click", () => void listen());
  muteButton.addEventListener("click", () => void toggleMute());
  endButton.addEventListener("click", () => void end());
  deviceSelect.addEventListener("change", () => void chooseMic(deviceSelect.value));
  keyInput.addEventListener("input", renderSave);
  providerSelect.addEventListener("change", () => {
    provider = providerSelect.value;
  });
  saveKeyButton.addEventListener("click", () => void save());
  testKeyButton.addEventListener("click", () => void test());
  forgetKeyButton.addEventListener("click", () => void forget());
  copyLogButton.addEventListener("click", () => void copyLog());
  openButton.addEventListener("click", () => void openProject());

  const onDeviceChange = () => void lookForMics();
  navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);

  const stateTimer = setInterval(() => void refresh(), 2000);
  const logTimer = setInterval(() => void pollLog(), 2000);
  void refresh();
  void pollLog();
  void lookForMics();
  renderHero();
  renderSave();

  return {
    stop(): void {
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
      levelMeter = null;
    },
  };
}
