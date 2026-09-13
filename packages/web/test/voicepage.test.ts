// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entriesFrom, sessionFrom } from "../src/lib/voice.ts";
import { buildWords, wireVoice, type VoicePage } from "../src/voice/main.ts";

/**
 * **The standalone page, driven as a page.**
 *
 * There is no React here, so there is no component tree to render: the markup
 * is `voice.html` and the controller is `src/voice/main.ts`. These tests load
 * the real body, answer the wire with stubs, and then read the DOM a person
 * would see — which is the only place the two bugs that mattered tonight
 * lived: an unwrapped session state that left every control disabled, and log
 * objects handed to a renderer that wanted text.
 */

// jsdom serves modules over http, so `import.meta.url` is not a file URL here;
// the repo root is the vitest root and this file is where it has always been.
const voiceHtml = readFileSync(path.resolve(process.cwd(), "packages/web/voice.html"), "utf8");
const voiceBody = /<body[^>]*>([\s\S]*)<\/body>/i.exec(voiceHtml)?.[1] ?? "";

/** jsdom has no server; the wire is answered by these values. */
let stateReply: unknown = {};
let logReply: unknown = { entries: [] };
let openReply: unknown = { url: "https://isocan.io/p/prj_cr7#pss_fresh" };
let openThrows = false;
let fakeTab: { location: { replace: ReturnType<typeof vi.fn> } };
let page: VoicePage | null = null;

function answer(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    url: "",
    text: async () => JSON.stringify(data),
    json: async () => data,
  } as unknown as Response;
}

beforeEach(() => {
  document.body.innerHTML = voiceBody;
  // jsdom checks delegation only; native Escape/focus containment are driven
  // in Chrome. Each test gets fresh dialog methods on its own element.
  const settings = document.getElementById("settings") as HTMLDialogElement;
  settings.showModal = vi.fn(() => {
    settings.open = true;
    (settings.querySelector("[autofocus]") as HTMLElement)?.focus();
  });
  settings.close = vi.fn(() => {
    settings.open = false;
    settings.dispatchEvent(new Event("close"));
  });
  localStorage.clear();
  stateReply = {};
  logReply = { entries: [] };
  openReply = { url: "https://isocan.io/p/prj_cr7#pss_fresh" };
  openThrows = false;
  fakeTab = { location: { replace: vi.fn() } };
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/state")) return answer(stateReply);
      if (url.endsWith("/log")) return answer(logReply);
      if (url.endsWith("/open")) {
        if (openThrows) throw new TypeError("Failed to fetch");
        return answer(openReply);
      }
      // The session and setup verbs: `{ ok: true }` is what a harness that
      // has them answers, and a test that wants a refusal stubs its own.
      if (/\/(session\/(start|mute|unmute|end)|key|key\/test|daemon|canvas|actor|enrol|confirm|open_url\/result)$/.test(url)) {
        return answer({ ok: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: async () => [
        { kind: "audioinput", deviceId: "mic-1", label: "Desk microphone" },
        { kind: "audioinput", deviceId: "mic-2", label: "Headset" },
      ],
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  Object.defineProperty(window, "open", {
    configurable: true,
    writable: true,
    value: vi.fn(() => fakeTab),
  });
});

afterEach(() => {
  page?.stop();
  page = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
};

async function wire(): Promise<void> {
  page = wireVoice(document);
  await flush();
}

const LIVE = {
  canvas: { title: "Voice demo (scratch)", id: "prj_cr7-OVI6s2" },
  daemon: "http://127.0.0.1:4441",
  home: "https://isocan.io",
  agent: { name: "Voice", id: "usr_EENJ5jZAPo", enrolled: true },
  provider: { name: "gemini", model: "models/gemini-3.1-flash-live-preview", key: true },
  version: "0.1.0",
  updated: "2026-09-11 23:34Z",
  session: { state: "live" },
};

const UTTERANCE = {
  id: "log_1789169133060_as3p7d",
  timestamp: "2026-09-11T23:25:33.060Z",
  type: "utterance",
  name: "utterance",
  args: { text: "retitle voice-demo-card.md to Checkout v2", source: "spoken" },
  op: { type: "item.update", said: "renamed “voice-demo-card.md” (itm_ei0yNw)" },
  result: { ok: true, answer: "renamed “voice-demo-card.md” (itm_ei0yNw)" },
};

const OPENED = { id: "log_1", timestamp: "2026-09-11T23:05:33.279Z", type: "session_event", event: "opened" };

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
};

/**
 * **A page that is really live, without a microphone.**
 *
 * The state model, the permission gate and `open_url` all live behind the
 * socket, and a test that cannot open one cannot see the states Paul asked
 * for. So capture is faked at its four seams — permission, context, worklet,
 * worklet node — and the socket is a class the test holds and feeds. Nothing
 * about the page changes for it: this is the same `wireVoice` a browser gets.
 */
class FakeSocket {
  static readonly OPEN = 1;
  static latest: FakeSocket | null = null;
  readyState = 1;
  binaryType = "";
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.latest = this;
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  /** One string frame from the harness, as it arrives. */
  event(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  /** One binary frame: the model's own 24 kHz PCM. */
  audio(samples = 4800): void {
    this.onmessage?.({ data: new Int16Array(samples).fill(1200).buffer });
  }
}

/** A fake context's routing surface: what a page reads back out of Chrome. */
interface SinkableFake {
  sinkId: string;
}

/**
 * A refusal in the shape Chrome throws it, so the page's words can be checked.
 */
function notAllowed(): Error {
  const err = new Error("The request is not allowed by the user agent or the platform in the current context.");
  err.name = "NotAllowedError";
  return err;
}

function fakeCapture(): { frame(): void; contexts: SinkableFake[]; refused: Set<string> } {
  FakeSocket.latest = null;
  let worklet: FakeWorklet | null = null;
  /** Every context the page built, in the order it built them. */
  const contexts: SinkableFake[] = [];
  /** A device this browser will not route to, as Chrome refuses a denied one. */
  const refused = new Set<string>();
  class FakeContext {
    sampleRate = 48000;
    /** What `AudioContext.setSinkId` leaves behind, and the page reads back. */
    sinkId = "";
    constructor() {
      contexts.push(this);
    }
    async setSinkId(id: string): Promise<void> {
      if (refused.has(id)) throw notAllowed();
      this.sinkId = id;
    }
    private createdAt = performance.now();
    get currentTime() { return (performance.now() - this.createdAt) / 1000; }
    state = "running";
    destination = {};
    audioWorklet = { addModule: async () => undefined };
    createMediaStreamSource() {
      return { connect: () => undefined, disconnect: () => undefined };
    }
    // Playback needs these the moment output audio arrives, and an
    // unhandled rejection here would be a test that lies about passing.
    createBuffer(_channels: number, length: number, rate: number) {
      return { duration: length / rate, getChannelData: () => new Float32Array(length) };
    }
    createBufferSource() {
      return { buffer: null, onended: null, connect: () => undefined, start: () => undefined, stop: () => undefined };
    }
    async resume() {}
    async close() {}
  }
  class FakeWorklet {
    constructor() { worklet = this; }
    port = { onmessage: null as unknown, postMessage: () => undefined };
    connect(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: async () => [
        { kind: "audioinput", deviceId: "mic-1", label: "Desk microphone" },
        { kind: "audioinput", deviceId: "mic-2", label: "Headset" },
        { kind: "audiooutput", deviceId: "spk-1", label: "Desk speakers" },
        { kind: "audiooutput", deviceId: "spk-locked", label: "Studio monitors" },
      ],
      getUserMedia: async () => ({
        getAudioTracks: () => [{ label: "Fake microphone", getSettings: () => ({}) }],
        getTracks: () => [{ stop: () => undefined }],
      }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorklet);
  vi.stubGlobal("WebSocket", FakeSocket);
  // Only the two statics: replacing URL itself takes away `new URL(...)`,
  // which is how the page builds the socket address.
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:worklet";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
  return {
    frame: () => (worklet?.port.onmessage as ((event: { data: Float32Array }) => void) | null)?.({ data: new Float32Array(128).fill(0.25) }),
    contexts,
    refused,
  };
}

/** Start a session and hand back the socket the page opened. */
async function goLive(): Promise<FakeSocket> {
  await element<HTMLButtonElement>("listen").click();
  await flush();
  await flush();
  const socket = FakeSocket.latest;
  if (!socket) {
    const seen = [...document.querySelectorAll("#log li")].map((li) => li.textContent).join(" | ");
    throw new Error(`the page never opened a socket — complaint: ${element("complaint").textContent} — log: ${seen}`);
  }
  return socket;
}

describe("what the harness says, in the shape the page reads", () => {
  it("unwraps the session state, and also takes it bare", () => {
    expect(sessionFrom({ session: { state: "live" } })).toBe("live");
    expect(sessionFrom({ session: "muted" })).toBe("muted");
    expect(sessionFrom({})).toBeUndefined();
    expect(sessionFrom(null)).toBeUndefined();
  });

  it("maps the log's own field names onto the ones the page renders", () => {
    const [entry] = entriesFrom([
      { timestamp: "23:10:02", name: "item.update", op: "item.update prj_1", result: "accepted" },
    ]);
    expect(entry).toMatchObject({
      at: "23:10:02",
      tool: "item.update",
      operation: "item.update prj_1",
      answered: "accepted",
    });
  });

  it("turns the op and result objects into sentences a renderer can hold", () => {
    // The real harness answers an operation as `{ type, said }` and a result
    // as `{ ok, answer }`. The React page handed both to JSX, which threw and
    // took the route down; this page writes textContent, and the wire still
    // normalises so the row reads as a sentence either way.
    const [entry] = entriesFrom([UTTERANCE]);
    expect(entry?.operation).toBe("item.update — renamed “voice-demo-card.md” (itm_ei0yNw)");
    expect(entry?.answered).toBe("renamed “voice-demo-card.md” (itm_ei0yNw)");
  });

  it("takes both the bare array and the wrapped envelope", () => {
    expect(entriesFrom({ entries: [{ name: "say" }] })[0]?.tool).toBe("say");
    expect(entriesFrom({ log: [{ name: "say" }] })[0]?.tool).toBe("say");
  });
});

describe("the standalone page keeps the controls a person has to press", () => {
  it("offers the key controls, visible rather than folded away", async () => {
    await wire();
    for (const id of ["key", "save-key", "test-key", "forget-key"]) {
      expect(document.getElementById(id), id).toBeTruthy();
    }
    // The drawer that carries the missing piece opens itself on a first run:
    // stateReply is empty here, so there is no canvas, no actor and no key.
    expect(document.querySelector("details[open]")).toBeTruthy();
    // The heading was printed twice — once as the summary, once as an <h2>.
    expect(document.body.innerHTML.match(/>Key</g)?.length ?? 0).toBe(1);
    expect(element<HTMLButtonElement>("save-key").disabled).toBe(true);
  });

  it("offers the microphone, the session controls and the device picker", async () => {
    await wire();
    for (const id of ["listen", "mute", "end", "device", "output", "device-note", "input-wave", "output-wave", "log"]) {
      expect(document.getElementById(id), id).toBeTruthy();
    }
    expect(document.querySelector("#listen #input-wave")).toBeTruthy();
    expect(document.querySelector("#listen #output-wave")).toBeNull();
    expect(document.querySelectorAll("#meter, #bars, #peak, .voice-scale")).toHaveLength(0);
    // Both ends of the sound live beside the microphone, not in Settings.
    const hero = element("hero");
    expect(hero.contains(element("device"))).toBe(true);
    expect(hero.contains(element("output"))).toBe(true);
  });

  it("offers a way to open the project it is driving", async () => {
    await wire();
    const open = element<HTMLButtonElement>("open-project");
    expect(open.textContent).toContain("Open the project");
  });
});

describe("state wiring, without a component tree", () => {
  it("unwraps the session and enables the controls that follow from it", async () => {
    stateReply = LIVE;
    // A device this browser remembers is the one the state line names; the
    // picker beside the microphone is where that choice gets changed.
    localStorage.setItem("isocan.voice.deviceId", "mic-1");
    await wire();
    expect(element<HTMLElement>("hero").dataset.state).toBe("live");
    expect(element<HTMLButtonElement>("listen").disabled).toBe(false);
    expect(element<HTMLButtonElement>("listen").getAttribute("aria-label")).toBe("Mute microphone");
    expect(element<HTMLButtonElement>("mute").disabled).toBe(false);
    expect(element<HTMLButtonElement>("end").disabled).toBe(false);
    expect(element<HTMLElement>("state").textContent).toBe("listening — Desk microphone");
    // The page's own word for what the microphone is doing, next to the
    // session's own word for whether there is a session.
    expect(element<HTMLElement>("hero").dataset.activity).toBe("listening");
  });

  it("takes a bare session string too", async () => {
    stateReply = { session: "muted" };
    await wire();
    expect(element<HTMLElement>("hero").dataset.state).toBe("muted");
    expect(element<HTMLElement>("hero").dataset.activity).toBe("muted");
    expect(element<HTMLElement>("state").textContent).toContain("muted");
  });

  it("says which canvas, actor, model and version it is connected to", async () => {
    stateReply = LIVE;
    await wire();
    expect(element("canvas-title").textContent).toBe("Voice demo (scratch)");
    expect(element("canvas-id").textContent).toBe("prj_cr7-OVI6s2");
    expect(element("daemon").textContent).toBe("http://127.0.0.1:4441");
    expect(element("actor-name").textContent).toBe("Voice");
    expect(element("actor-standing").textContent).toBe("enrolled");
    expect(element("audio").textContent).toBe(
      "gemini · models/gemini-3.1-flash-live-preview · key stored",
    );
    expect(element("version").textContent).toBe("0.1.0");
  });
});

describe("the log renders what the harness sends", () => {
  it("renders a tool call as a sentence, newest first", async () => {
    logReply = { entries: [OPENED, UTTERANCE] };
    await wire();
    const rows = [...document.querySelectorAll("#log li")].map((li) => li.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("item.update — renamed “voice-demo-card.md” (itm_ei0yNw)");
    expect(rows[0]).toContain("daemon: renamed “voice-demo-card.md” (itm_ei0yNw)");
    expect(rows[1]).toContain("opened");
  });

  it("takes the wrapped log envelope as well as the bare array", async () => {
    logReply = { log: [OPENED] };
    await wire();
    expect(document.querySelectorAll("#log li")).toHaveLength(1);
    expect(document.querySelector("#log li")?.textContent).toContain("opened");
  });

  it("says nothing yet rather than showing an empty list", async () => {
    await wire();
    expect(document.querySelectorAll("#log li")).toHaveLength(1);
    expect(document.querySelector("#log li")?.textContent).toContain("nothing yet");
  });
});

describe("devices, keys and the project link", () => {
  it("lists the named microphones, under the system default", async () => {
    await wire();
    const device = element<HTMLSelectElement>("device");
    // The browser's own "default" alias is not a device, so the page draws its
    // own row for that and lists the devices by name under it.
    expect([...device.options].map((one) => one.textContent)).toEqual([
      "System default microphone",
      "Desk microphone",
      "Headset",
    ]);
    // Nothing has been chosen, so nothing is claimed: the row says the system
    // default, which is the microphone the browser would open.
    expect(device.value).toBe("");
    device.value = "mic-2";
    device.dispatchEvent(new Event("change"));
    await flush();
    expect(localStorage.getItem("isocan.voice.deviceId")).toBe("mic-2");
    expect(localStorage.getItem("isocan.voice.deviceName")).toBe("Headset");
    expect(element<HTMLSelectElement>("device").value).toBe("mic-2");
  });

  it("keeps Save inactive until there is a key to save", async () => {
    await wire();
    const key = element<HTMLInputElement>("key");
    const save = element<HTMLButtonElement>("save-key");
    expect(save.disabled).toBe(true);
    key.value = "AIza-not-a-real-key";
    key.dispatchEvent(new Event("input"));
    expect(save.disabled).toBe(false);
  });

  it("forgets through the harness's POST verb and reports a refusal", async () => {
    await wire();
    element<HTMLButtonElement>("forget-key").click();
    await flush();
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/key"));
    expect(call?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ forget: true });
    expect(element("key-note").textContent).toBe("key forgotten");
    vi.mocked(fetch).mockResolvedValueOnce({ ...answer({}), ok: false, status: 503 });
    element<HTMLButtonElement>("forget-key").click();
    await flush();
    expect(element("key-note").textContent).toBe("key not removed — harness refused (503)");
  });

  it("mints a fresh pass on every press and opens the tab it made", async () => {
    await wire();
    element<HTMLButtonElement>("open-project").click();
    await flush();
    expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
    // The JSON answer is what keeps the `#pss_…` fragment the pass lives in;
    // the plain redirect loses it to `response.url`.
    const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/open"));
    expect((call?.[1] as RequestInit | undefined)?.headers).toMatchObject({ accept: "application/json" });
    expect(fakeTab.location.replace).toHaveBeenCalledWith("https://isocan.io/p/prj_cr7#pss_fresh");
  });

  it("points the tab at /open when the fetch cannot follow the redirect", async () => {
    // The harness answers with a cross-origin redirect; a fetch may not follow
    // it without CORS headers, and a top-level navigation may.
    openThrows = true;
    await wire();
    element<HTMLButtonElement>("open-project").click();
    await flush();
    expect(fakeTab.location.replace).toHaveBeenCalledWith("/harness/open");
  });
});

describe("the states Paul asked for, from the wire that carries them", () => {
  it("says listening, then thinking when the utterance lands, then speaking", async () => {
    fakeCapture();
    stateReply = { session: "idle" }; // a page with no session yet: Listen is pressable
    await wire();
    const socket = await goLive();
    expect(element<HTMLElement>("hero").dataset.activity).toBe("listening");

    socket.event({ type: "tool_log", entry: { details: { kind: "heard", text: "read the canvas and" } } });
    expect(element<HTMLElement>("hero").dataset.activity).toBe("thinking");
    expect(element<HTMLElement>("state").textContent).toBe("thinking…");
    expect(element("transcript").textContent).toContain("read the canvas and");

    // The provider sends input transcription as partials that grow; the
    // transcript must not glue one to the next ("andread" was the bug).
    socket.event({ type: "tool_log", entry: { details: { kind: "heard", text: "read the canvas and tell me" } } });
    expect(element("transcript").textContent).not.toContain("andread");
    expect(element("transcript").textContent).toContain("read the canvas and tell me");

    // Output audio: the model is speaking, and the waveform follows ITS audio.
    socket.audio();
    await flush();
    expect(element<HTMLElement>("hero").dataset.activity).toBe("speaking");
    // The outer waveform follows scheduled output without replacing input.
    await vi.advanceTimersByTimeAsync(150);
    expect(document.getElementById("output-wave")?.getAttribute("d")).toContain("L");

    // The reply, as the harness tags it: the transcript shows both sides.
    socket.event({ type: "tool_log", entry: { details: { kind: "reply", text: "I've read the canvas." } } });
    expect(element("transcript").textContent).toContain("Voice");
    expect(element("transcript").textContent).toContain("I've read the canvas.");

    // A quiet tail returns to listening without anyone saying so.
    await vi.advanceTimersByTimeAsync(900);
    expect(element<HTMLElement>("hero").dataset.activity).toBe("listening");
    expect(document.getElementById("input-wave")?.getAttribute("d")).toContain("M");
  });

  it("stops the model and goes back to listening when it is interrupted", async () => {
    fakeCapture();
    stateReply = { session: "idle" }; // a page with no session yet: Listen is pressable
    await wire();
    const socket = await goLive();
    socket.audio();
    await flush();
    expect(element<HTMLElement>("hero").dataset.activity).toBe("speaking");
    socket.event({ state: "the model was interrupted" });
    expect(element<HTMLElement>("hero").dataset.activity).toBe("listening");
  });

  it("a muted session never renders as listening", async () => {
    fakeCapture();
    stateReply = { session: "idle" }; // a page with no session yet: Listen is pressable
    await wire();
    await goLive();
    element<HTMLButtonElement>("mute").click();
    await flush();
    expect(element<HTMLElement>("hero").dataset.state).toBe("muted");
    expect(element<HTMLElement>("hero").dataset.activity).toBe("muted");
    expect(element<HTMLElement>("state").textContent).toContain("muted");
  });
});

describe("mic-centred conversation feedback", () => {
  it("shows connecting immediately and prevents duplicate start presses", async () => {
    fakeCapture();
    stateReply = { session: "idle" };
    await wire();
    element<HTMLButtonElement>("listen").click();
    expect(element("hero").dataset.activity).toBe("connecting");
    expect(element<HTMLButtonElement>("listen").disabled).toBe(false);
    expect(element<HTMLButtonElement>("listen").getAttribute("aria-disabled")).toBe("true");
    element<HTMLButtonElement>("listen").click();
    await flush();
    await flush();
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/session/start"))).toHaveLength(1);
  });

  it("keeps speaking through burst-delivered PCM, not a 700 ms packet gap", async () => {
    fakeCapture();
    stateReply = { session: "idle" };
    await wire();
    const socket = await goLive();
    stateReply = { session: "live" };
    const inputBefore = document.getElementById("input-wave")!.getAttribute("d");
    const outputBefore = document.getElementById("output-wave")!.getAttribute("d");
    socket.audio(72000); // three seconds delivered in one message
    await flush();
    socket.event({ state: "turn_complete" });
    await vi.advanceTimersByTimeAsync(1200);
    expect(element("hero").dataset.activity).toBe("speaking");
    expect(document.getElementById("output-wave")!.getAttribute("d")).not.toBe(outputBefore);
    expect(document.getElementById("input-wave")!.getAttribute("d")).toBe(inputBefore);
    await vi.advanceTimersByTimeAsync(2100);
    expect(element("hero").dataset.activity).toBe("listening");
  });

  it("streams captions without replacing earlier words, fades, and retains history", async () => {
    fakeCapture();
    stateReply = { session: "idle" };
    await wire();
    const socket = await goLive();
    stateReply = { session: "live" };
    const reply = (text: string) => socket.event({ type: "tool_log", entry: { details: { kind: "reply", text } } });
    reply("The canvas ");
    const first = element("captions").firstChild;
    const historyRow = element("transcript").firstChild;
    reply("is ready.");
    expect(element("captions").firstChild).toBe(first);
    expect(element("transcript").firstChild).toBe(historyRow);
    expect(element("captions").textContent).toBe("The canvas is ready.");
    // The old reply class accidentally inherited the entire .voice page grid.
    expect(document.querySelectorAll(".voice")).toHaveLength(1);
    expect(document.querySelector("#transcript .voice-turn--voice")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(5500);
    expect(element("captions").classList.contains("faded")).toBe(true);
    expect(element("transcript").textContent).toContain("The canvas is ready.");
    element<HTMLInputElement>("keep-captions").click();
    await vi.advanceTimersByTimeAsync(10000);
    expect(element("captions").classList.contains("faded")).toBe(false);
    page!.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("End cancels opening and stops a microphone granted afterwards", async () => {
    fakeCapture();
    stateReply = { session: "idle" };
    let grant!: (stream: MediaStream) => void;
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementation(() => new Promise((resolve) => { grant = resolve; }));
    await wire();
    element<HTMLButtonElement>("listen").click();
    await flush();
    expect(element<HTMLButtonElement>("end").disabled).toBe(false);
    element<HTMLButtonElement>("end").click();
    await flush();
    const stop = vi.fn();
    grant({ getAudioTracks: () => [], getTracks: () => [{ stop }] } as unknown as MediaStream);
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(FakeSocket.latest).toBeNull();
    expect(element("hero").dataset.activity).toBe("ended");
  });

  it("a state poll started before Mute cannot undo its feedback", async () => {
    fakeCapture();
    stateReply = { session: "idle" };
    await wire();
    await goLive();
    const original = vi.mocked(fetch).getMockImplementation()!;
    let release!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((url, init) => String(url).endsWith("/state")
      ? new Promise((resolve) => { release = resolve; }) : original(url, init));
    await vi.advanceTimersByTimeAsync(2000);
    element<HTMLButtonElement>("mute").click();
    await flush();
    release(answer({ session: "live" }));
    await flush();
    expect(element("hero").dataset.activity).toBe("muted");
    expect(element<HTMLButtonElement>("listen").getAttribute("aria-label")).toBe("Unmute microphone");
  });

  it("a refused mute update does not undo the local microphone mute", async () => {
    const mic = fakeCapture();
    stateReply = { session: "idle" };
    await wire();
    const socket = await goLive();
    stateReply = { session: "live" };
    vi.mocked(fetch).mockRejectedValueOnce(new Error("simulated lost acknowledgement"));
    element<HTMLButtonElement>("mute").click();
    await flush();
    await vi.advanceTimersByTimeAsync(2100);
    mic.frame();
    expect(socket.sent).toHaveLength(0);
    expect(element("hero").dataset.state).toBe("live");
    expect(element("hero").dataset.activity).toBe("muted");
    expect(element("hero").dataset.muted).toBe("true");
  });

  it("a new Listen after ending muted starts with input enabled", async () => {
    const mic = fakeCapture();
    stateReply = { session: "idle" };
    await wire();
    await goLive();
    element<HTMLButtonElement>("mute").click();
    await flush();
    element<HTMLButtonElement>("end").click();
    await flush();
    const restarted = await goLive();
    mic.frame();
    expect(restarted.sent).toHaveLength(1);
    expect(element("hero").dataset.muted).toBe("false");
  });

  it("a rejected old decode cannot end a new session", async () => {
    fakeCapture();
    stateReply = { session: "idle" };
    await wire();
    const old = await goLive();
    let reject!: (error: Error) => void;
    const blob = new Blob();
    Object.defineProperty(blob, "arrayBuffer", { value: () => new Promise((_resolve, refuse) => { reject = refuse; }) });
    old.onmessage?.({ data: blob });
    await flush();
    element<HTMLButtonElement>("end").click();
    await flush();
    const current = await goLive();
    reject(new Error("old decode failed"));
    await flush();
    expect(element("hero").dataset.state).toBe("live");
    expect(current.readyState).toBe(1);
    expect(element("complaint").textContent).not.toContain("old decode");
  });

  it("uses the large mic as mute/unmute without starting another session", async () => {
    fakeCapture();
    stateReply = { session: "idle" };
    await wire();
    await goLive();
    const mic = element<HTMLButtonElement>("listen");
    mic.click();
    await flush();
    expect(element("hero").dataset.activity).toBe("muted");
    expect(mic.getAttribute("aria-label")).toBe("Unmute microphone");
    mic.click();
    await flush();
    expect(element("hero").dataset.activity).toBe("listening");
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/session/start"))).toHaveLength(1);
  });
});

describe("the permission gate and open_url, as the page renders them", () => {
  it("asks a person before a destructive operation, and posts their answer", async () => {
    fakeCapture();
    stateReply = { session: "idle" }; // a page with no session yet: Listen is pressable
    await wire();
    const socket = await goLive();
    expect(element<HTMLElement>("confirm").hidden).toBe(true);

    socket.event({ confirm: { id: "cfm_1", name: "trash_empty", what: "empty the trash (3 items)" } });
    expect(element<HTMLElement>("confirm").hidden).toBe(false);
    expect(element("confirm-what").textContent).toContain("empty the trash (3 items)");

    element<HTMLButtonElement>("confirm-allow").click();
    await flush();
    expect(element<HTMLElement>("confirm").hidden).toBe(true);
    const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/confirm"));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ id: "cfm_1", allow: true });
  });

  it("refuses a scheme the page will not open, and logs that it blocked it", async () => {
    fakeCapture();
    stateReply = { session: "idle" }; // a page with no session yet: Listen is pressable
    await wire();
    const socket = await goLive();
    socket.event({ open_url: { callId: "opn_1", url: "javascript:alert(1)", target: "tab" } });
    await flush();
    expect(window.open).not.toHaveBeenCalled();
    const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/open_url/result"));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toMatchObject({ callId: "opn_1", ok: false, opened: "blocked" });
  });

  it("opens a tab when the page has a gesture, and says the tab path ran", async () => {
    fakeCapture();
    stateReply = { session: "idle" }; // a page with no session yet: Listen is pressable
    await wire();
    const socket = await goLive();
    socket.event({ open_url: { callId: "opn_2", url: "https://isocan.io/", target: "tab" } });
    await flush();
    const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/open_url/result"));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toMatchObject({ callId: "opn_2", ok: true, opened: "tab" });
    expect([...document.querySelectorAll("#log li")].some((li) => (li.textContent ?? "").includes("open_url: tab"))).toBe(true);
  });
});

describe("the setup panel says what this harness cannot do", () => {
  it("names the command when the build has no /enrol endpoint", async () => {
    await wire();
    // The list of steps is built from facts; with none, the panel is open.
    expect(element<HTMLElement>("setup").hidden).toBe(false);
    const steps = [...element("setup-steps").querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(steps.join("\n")).toContain("isocan rc add");
    expect(steps.join("\n")).toContain("acpAdapters");
  });

  it("shows a canvas picker that works when the harness answers /canvases", async () => {
    const original = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/canvases")) {
        return answer({ current: "prj_1", canvases: [{ id: "prj_1", title: "First" }, { id: "prj_2", title: "Second" }] });
      }
      if (url.endsWith("/canvas")) return answer({ ok: true, canvas: { id: "prj_2", title: "Second" } });
      return original!(input, init);
    });
    await wire();
    const select = element("setup-steps").querySelector("select");
    expect(select).toBeTruthy();
    expect([...select!.options].map((o) => o.textContent)).toEqual(["First", "Second"]);
    select!.value = "prj_2";
    [...element("setup-steps").querySelectorAll("button")].find((b) => b.textContent === "Use this canvas")!.click();
    await flush();
    const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/canvas"));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ id: "prj_2" });
  });
});

describe("configuration behind the settings cog", () => {
  it("keeps the controls intact in a closed dialog, without starting audio", async () => {
    stateReply = LIVE;
    // A browser that can route output, so the pair below reads as values
    // rather than as the no-API sentence (which has its own test).
    routable();
    await wire();
    const dialog = element<HTMLDialogElement>("settings");
    expect(dialog.open).toBe(false);
    for (const id of [
      "connection-panel",
      "key-panel",
      "daemon-field",
      "mic-fact",
      "output-fact",
      "save-key",
      "test-key",
      "forget-key",
    ])
      expect(dialog.contains(element(id)), id).toBe(true);
    // The CONTROLS are beside the microphone; what the facts hold is the
    // answer — both ends of the sound, in the panel, as a pair.
    expect(dialog.contains(element("device"))).toBe(false);
    expect(dialog.contains(element("output"))).toBe(false);
    expect(element("mic-fact").textContent).toBe("System default");
    expect(element("output-fact").textContent).toBe("System default");
    expect(element("setup-callout").hidden).toBe(true);
    const key = element<HTMLInputElement>("key");
    key.value = "synthetic-not-a-key";
    element<HTMLButtonElement>("settings-open").click();
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(element("settings-title"));
    expect(element("settings-open").getAttribute("aria-expanded")).toBe("true");
    expect(dialog.contains(element("complaint"))).toBe(true);
    element<HTMLButtonElement>("settings-close").click();
    expect(dialog.open).toBe(false);
    expect(element("hero").contains(element("complaint"))).toBe(true);
    element<HTMLButtonElement>("settings-open").click();
    expect(element("key")).toBe(key);
    expect(key.value).toBe("synthetic-not-a-key");
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/session/start"))).toBe(false);
  });

  it("makes missing setup actionable inline without automatically opening settings", async () => {
    await wire();
    const dialog = element<HTMLDialogElement>("settings");
    expect(dialog.open).toBe(false);
    expect(element("setup-callout").hidden).toBe(false);
    expect(element("setup-status").textContent).toContain("Needs setup");
    element<HTMLButtonElement>("setup-open").click();
    expect(dialog.open).toBe(true);
    expect(element("setup-steps").textContent).toContain("isocan rc add");
    expect(element("setup-steps").textContent).toContain("acpAdapters");
  });

  it("does not replace a focused setup field on identical state polls", async () => {
    await wire();
    element<HTMLButtonElement>("settings-open").click();
    const field = element("setup-steps").querySelector("input")!;
    field.value = "Test voice";
    field.focus();
    await vi.advanceTimersByTimeAsync(4100);
    expect(element("setup-steps").querySelector("input")).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("Test voice");
  });

  it("surfaces an explicit permission question rather than leaving it behind the modal", async () => {
    fakeCapture();
    stateReply = { session: "idle" };
    await wire();
    const socket = await goLive();
    element<HTMLButtonElement>("settings-open").click();
    socket.event({ confirm: { id: "synthetic_confirmation", what: "delete a test item" } });
    expect(element<HTMLDialogElement>("settings").open).toBe(false);
    expect(document.activeElement).toBe(element("confirm-what"));
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/confirm"))).toBe(false);
  });

  it("closes its dialog when the page is disposed", async () => {
    await wire();
    element<HTMLButtonElement>("settings-open").click();
    page!.stop();
    expect(element<HTMLDialogElement>("settings").open).toBe(false);
  });
});

describe("the build tag tells the truth about what is being tested", () => {
  it("says the tag was not injected rather than inventing one", () => {
    expect(buildWords()).toBe("build tag not injected");
  });

  it("names the branch and the short commit when the build injects them", () => {
    (globalThis as Record<string, unknown>).__VOICE_BUILD_INFO__ = {
      branch: "feat/voice-ui-vite",
      commit: "57dd1b50c0ffee",
    };
    try {
      expect(buildWords()).toBe("feat/voice-ui-vite @ 57dd1b50");
      expect(element("build-tag")).toBeTruthy();
    } finally {
      delete (globalThis as Record<string, unknown>).__VOICE_BUILD_INFO__;
    }
  });
});

/** A context with the one method output routing needs, and nothing else. */
function routable(): void {
  vi.stubGlobal(
    "AudioContext",
    class {
      sinkId = "";
      async setSinkId(id: string): Promise<void> {
        this.sinkId = id;
      }
    },
  );
}

/**
 * The devices the browser is willing to name, and a way to unplug one.
 *
 * The rows are read through a function so a test can change them and fire the
 * browser's own `devicechange`, which is the only signal a page gets.
 */
function nameDevices(rows: () => { kind: string; deviceId: string; label: string }[]): () => void {
  const listeners: (() => void)[] = [];
  const existing = (navigator.mediaDevices ?? {}) as unknown as Record<string, unknown>;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      ...existing,
      enumerateDevices: async () => rows(),
      addEventListener: (_type: string, run: () => void) => listeners.push(run),
      removeEventListener: () => undefined,
    },
  });
  return () => listeners.forEach((run) => run());
}

/**
 * **Both ends of the sound, and every state that is not "as chosen".**
 *
 * The microphone picker worked already; what it never had was a companion, a
 * state for a device that went away, or an honest story about a browser that
 * cannot route output at all. Each test below is a fact a person could
 * otherwise be lied to about.
 */
describe("the two ends of the sound", () => {
  it("lists the named speakers under a system default row, and nothing blank", async () => {
    routable();
    nameDevices(() => [
      { kind: "audioinput", deviceId: "mic-1", label: "Desk microphone" },
      { kind: "audioinput", deviceId: "default", label: "Default" },
      { kind: "audiooutput", deviceId: "spk-1", label: "Desk speakers" },
      { kind: "audiooutput", deviceId: "default", label: "Default" },
    ]);
    await wire();
    // The browser's own "default" alias is not a device; the page draws its
    // own row for that and lists the named devices beneath it.
    expect([...element<HTMLSelectElement>("device").options].map((one) => one.textContent)).toEqual([
      "System default microphone",
      "Desk microphone",
    ]);
    expect([...element<HTMLSelectElement>("output").options].map((one) => one.textContent)).toEqual([
      "System default",
      "Desk speakers",
    ]);
    expect(element("device-note").hidden).toBe(true);
  });

  it("does not number devices the browser will not name", async () => {
    routable();
    // What Chrome 152 answers before this page has been allowed a microphone:
    // one nameless entry per kind, with the ids withheld as well.
    nameDevices(() => [
      { kind: "audioinput", deviceId: "", label: "" },
      { kind: "audiooutput", deviceId: "", label: "" },
    ]);
    await wire();
    expect([...element<HTMLSelectElement>("device").options].map((one) => one.textContent)).toEqual([
      "System default microphone",
    ]);
    expect([...element<HTMLSelectElement>("output").options].map((one) => one.textContent)).toEqual([
      "System default",
    ]);
    expect(element("device-note").hidden).toBe(false);
    expect(element("device-note").textContent).toContain("hidden until this page is allowed");
  });

  it("keeps the row and says so when the browser cannot route output", async () => {
    // jsdom has no Web Audio at all, which is the same code path a browser
    // without AudioContext.setSinkId takes: the control stays, the choice
    // does not, and the row says where the reply goes instead.
    nameDevices(() => [{ kind: "audiooutput", deviceId: "spk-1", label: "Desk speakers" }]);
    await wire();
    expect(element<HTMLSelectElement>("output").disabled).toBe(true);
    expect(element<HTMLSelectElement>("output").value).toBe("");
    expect(element("device-note").textContent).toContain("cannot choose an output device");
  });

  it("applies the speaker chosen before the reply ever played", async () => {
    const mic = fakeCapture();
    nameDevices(() => [
      { kind: "audioinput", deviceId: "mic-1", label: "Desk microphone" },
      { kind: "audiooutput", deviceId: "spk-1", label: "Desk speakers" },
    ]);
    localStorage.setItem("isocan.voice.outputId", "spk-1");
    localStorage.setItem("isocan.voice.outputName", "Desk speakers");
    await wire();
    const socket = await goLive();
    // No context exists until the first chunk of a reply, so this is the
    // "stored choice meets a brand new context" path, not the picker's.
    expect(mic.contexts).toHaveLength(1);
    socket.audio();
    await flush();
    await flush();
    expect(mic.contexts.at(-1)?.sinkId).toBe("spk-1");
  });

  it("moves a reply that is already playing to another speaker", async () => {
    const mic = fakeCapture();
    nameDevices(() => [
      { kind: "audioinput", deviceId: "mic-1", label: "Desk microphone" },
      { kind: "audiooutput", deviceId: "spk-1", label: "Desk speakers" },
    ]);
    await wire();
    const socket = await goLive();
    socket.audio();
    await flush();
    await flush();
    const player = mic.contexts.at(-1);
    expect(player?.sinkId).toBe("");
    const output = element<HTMLSelectElement>("output");
    output.value = "spk-1";
    output.dispatchEvent(new Event("change"));
    await flush();
    expect(player?.sinkId).toBe("spk-1");
    expect(element("device-note").hidden).toBe(true);
  });

  it("names a chosen speaker that is gone, and moves the reply to the default", async () => {
    const mic = fakeCapture();
    let rows = [
      { kind: "audioinput", deviceId: "mic-1", label: "Desk microphone" },
      { kind: "audiooutput", deviceId: "spk-1", label: "Desk speakers" },
    ];
    const devicechange = nameDevices(() => rows);
    localStorage.setItem("isocan.voice.outputId", "spk-1");
    localStorage.setItem("isocan.voice.outputName", "Desk speakers");
    await wire();
    const socket = await goLive();
    socket.audio();
    await flush();
    await flush();
    const player = mic.contexts.at(-1);
    expect(player?.sinkId).toBe("spk-1");
    // Unplugged: out of the browser's list. Chrome on Linux fires NO
    // `devicechange` for a sink that goes away (measured on 152), so the
    // state poll is what re-reads the list — this is that tick.
    rows = rows.filter((one) => one.deviceId !== "spk-1");
    devicechange(); // still honoured where the platform does announce it
    await vi.advanceTimersByTimeAsync(2100);
    await flush();
    await flush();
    expect(player?.sinkId).toBe("");
    const output = element<HTMLSelectElement>("output");
    expect([...output.options].map((one) => one.textContent)).toEqual([
      "System default",
      "Desk speakers — not connected",
    ]);
    // The selection stays on the device that is gone — it is what was chosen,
    // and it is named rather than swapped out under the person.
    expect(output.value).toBe("spk-1");
    expect([...output.options][1]!.disabled).toBe(true);
    expect(element("device-note").textContent).toContain("Desk speakers is not connected");
  });

  it("reports a refused route with where the reply actually went", async () => {
    const mic = fakeCapture();
    nameDevices(() => [
      { kind: "audioinput", deviceId: "mic-1", label: "Desk microphone" },
      { kind: "audiooutput", deviceId: "spk-locked", label: "Studio monitors" },
    ]);
    mic.refused.add("spk-locked");
    await wire();
    const socket = await goLive();
    socket.audio();
    await flush();
    await flush();
    const output = element<HTMLSelectElement>("output");
    output.value = "spk-locked";
    output.dispatchEvent(new Event("change"));
    await flush();
    const said = element("device-note").textContent ?? "";
    expect(said).toContain("Studio monitors could not be used");
    expect(said).toContain("The reply is playing on the system default.");
    // The panel says the same thing the row does: the device the reply is on,
    // not the one that was asked for.
    expect(element("output-fact").textContent).toBe("System default");
    // And the log carries the refusal, which is where a person looks to find
    // out why their speakers stayed silent.
    expect([...document.querySelectorAll("#log li")].map((li) => li.textContent).join(" ")).toContain(
      "Studio monitors could not be used",
    );
  });
});

describe("the two ends of the sound, in the facts panel", () => {
  it("names both ends as a pair, in the order of the path", async () => {
    routable();
    nameDevices(() => [
      { kind: "audioinput", deviceId: "mic-1", label: "Desk microphone" },
      { kind: "audiooutput", deviceId: "spk-1", label: "Desk speakers" },
    ]);
    await wire();
    const rows = [...document.querySelectorAll(".voice-facts div")];
    const mic = rows.find((row) => row.querySelector("dt")?.textContent === "Microphone");
    const output = rows.find((row) => row.querySelector("dt")?.textContent === "Output");
    // A panel that named one end of the path would describe half of it, and a
    // person should not have to hunt: the two rows are adjacent.
    expect(mic?.nextElementSibling).toBe(output);
    expect(element("mic-fact").textContent).toBe("System default");
    expect(element("output-fact").textContent).toBe("System default");
  });

  it("follows the route, and the device it is on after the device goes away", async () => {
    routable();
    const spokes = [
      { kind: "audioinput", deviceId: "mic-1", label: "Desk microphone" },
      { kind: "audiooutput", deviceId: "spk-1", label: "Desk speakers" },
    ];
    nameDevices(() => spokes);
    await wire();
    const output = element<HTMLSelectElement>("output");
    output.value = "spk-1";
    output.dispatchEvent(new Event("change"));
    await flush();
    expect(element("output-fact").textContent).toBe("Desk speakers");
    // The same fact the pill carries, in the same words, so the panel and the
    // row beside the microphone cannot disagree when a speaker walks away.
    spokes.splice(1, 1);
    await vi.advanceTimersByTimeAsync(2100);
    await flush();
    expect(element("output-fact").textContent).toBe("Desk speakers — not connected");
    expect([...element<HTMLSelectElement>("output").options].map((one) => one.textContent)).toContain(
      "Desk speakers — not connected",
    );
  });

  it("says the audio path rather than a choice, when the browser cannot route", async () => {
    // jsdom has no AudioContext at all: the browser that has no say in this.
    nameDevices(() => [{ kind: "audiooutput", deviceId: "spk-1", label: "Desk speakers" }]);
    localStorage.setItem("isocan.voice.outputId", "spk-1");
    localStorage.setItem("isocan.voice.outputName", "Desk speakers");
    await wire();
    expect(element("output-fact").textContent).toBe("System default (this browser cannot choose another)");
  });
});

describe("the daemon is a stored preference, like the microphone", () => {
  it("prefills the field with the daemon the page resolved", async () => {
    stateReply = LIVE;
    await wire();
    const field = element<HTMLInputElement>("daemon-field");
    expect(field.value).toBe("http://127.0.0.1:4441");
    expect(localStorage.getItem("isocan.voice.daemon")).toBeNull();
  });

  it("stores what a person types, asks the harness, and says plainly when it cannot take it", async () => {
    stateReply = LIVE;
    await wire();
    const original = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/daemon")) {
        return { ok: false, status: 405, url: "", text: async () => JSON.stringify({ error: "not here" }) } as unknown as Response;
      }
      return original!(input, init);
    });
    const field = element<HTMLInputElement>("daemon-field");
    field.value = "http://127.0.0.1:4442";
    element<HTMLButtonElement>("daemon-use").click();
    await flush();
    // Stored regardless: the page can always keep a choice, never pretend it applied it.
    expect(localStorage.getItem("isocan.voice.daemon")).toBe("http://127.0.0.1:4442");
    expect(element("daemon-note").textContent).toContain("not yet applied");
    const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/daemon"));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ url: "http://127.0.0.1:4442" });
  });

  it("reads a stored daemon before the first request, and offers it to the harness once", async () => {
    localStorage.setItem("isocan.voice.daemon", "http://127.0.0.1:4442");
    stateReply = LIVE;
    await wire();
    const calls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/daemon"));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String((calls[0]?.[1] as RequestInit).body))).toEqual({ url: "http://127.0.0.1:4442" });
    // The daemon line states both facts: what it is talking to, and what is wanted.
    expect(element("daemon").textContent).toBe("http://127.0.0.1:4441");
    expect(element("daemon-note").textContent).toContain("wanted: http://127.0.0.1:4442");
    // A second poll must not ask again.
    await vi.advanceTimersByTimeAsync(2100);
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/daemon"))).toHaveLength(1);
  });

  it("has a way out of a wrong stored value", async () => {
    localStorage.setItem("isocan.voice.daemon", "http://127.0.0.1:9");
    stateReply = LIVE;
    await wire();
    const reset = element<HTMLButtonElement>("daemon-reset");
    expect(reset.hidden).toBe(false);
    reset.click();
    await flush();
    expect(localStorage.getItem("isocan.voice.daemon")).toBeNull();
    expect(element<HTMLInputElement>("daemon-field").value).toBe("http://127.0.0.1:4441");
  });
});
