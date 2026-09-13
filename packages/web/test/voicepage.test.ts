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
  const fakeDialog = (id: string): void => {
    const dialog = document.getElementById(id) as HTMLDialogElement;
    dialog.showModal = vi.fn(() => {
      dialog.open = true;
      (dialog.querySelector("[autofocus]") as HTMLElement)?.focus();
    });
    dialog.close = vi.fn(() => {
      dialog.open = false;
      dialog.dispatchEvent(new Event("close"));
    });
  };
  fakeDialog("settings");
  fakeDialog("logs");
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
    // Nothing in Settings is folded away: it is one flat scroll, so there is
    // no disclosure control to open before the key can be reached.
    expect(document.querySelectorAll("#settings details, #settings summary").length).toBe(0);
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
    page!.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a caption readable for a sentence, and then lets it go", async () => {
    fakeCapture();
    stateReply = { session: "idle" };
    await wire();
    const socket = await goLive();
    stateReply = { session: "live" };
    const reply = (text: string) => socket.event({ type: "tool_log", entry: { details: { kind: "reply", text } } });
    // There is no "keep captions" control any more: the caption is transient
    // by design, and the transcript in Logs is where persistence lives.
    expect(document.getElementById("keep-captions")).toBeNull();

    reply("The canvas ");
    const first = element("captions").firstChild;
    reply("is ready.");
    // Words stream into the node that is already there, not a rebuilt one.
    expect(element("captions").firstChild).toBe(first);
    expect(element("captions").textContent).toBe("The canvas is ready.");

    // Readable while a person is reading it. The reading time is at least
    // 4.5s and starts when the speaking tail ends (TEXT_TAIL_MS), so 4s in it
    // is still on screen and it has gone a couple of seconds later.
    await vi.advanceTimersByTimeAsync(4000);
    expect(element("captions").classList.contains("faded")).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(element("captions").classList.contains("faded")).toBe(true);
    // The record is untouched by any of it.
    expect(element("transcript").textContent).toContain("The canvas is ready.");
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
    await wire();
    const dialog = element<HTMLDialogElement>("settings");
    expect(dialog.open).toBe(false);
    for (const id of ["connection-panel", "key-panel", "daemon-field", "mic-fact", "save-key", "test-key", "forget-key"])
      expect(dialog.contains(element(id)), id).toBe(true);
    // The microphone's CONTROL is beside the microphone; what the facts hold
    // is the answer — which device this page is listening through.
    expect(dialog.contains(element("device"))).toBe(false);
    expect(element("mic-fact").textContent).toBe("the system default microphone");
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

  it("dismisses from a click outside the dialog, and not from one inside it", async () => {
    await wire();
    const dialog = element<HTMLDialogElement>("settings");
    // The declarative half: a browser with `closedBy` does all of this itself.
    // jsdom has no `closedBy`, so what runs below is the Safari fallback.
    expect(dialog.getAttribute("closedby")).toBe("any");
    // jsdom has no layout either, so the dialog says where its box is.
    dialog.getBoundingClientRect = () => ({ left: 100, top: 50, right: 500, bottom: 400 } as DOMRect);
    const clickAt = (target: EventTarget, clientX: number, clientY: number) =>
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX, clientY }));
    const pressAt = (target: EventTarget, clientX: number, clientY: number) =>
      target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX, clientY }));

    element<HTMLButtonElement>("settings-open").click();
    expect(dialog.open).toBe(true);
    // The click that OPENED it is a click outside it (the cog is out there):
    // dismissing on `click` would close what it just opened.
    clickAt(document.body, 10, 10);
    expect(dialog.open).toBe(true);

    // The press is what decides. On the backdrop it reports the page BODY as
    // its target in Chrome, measured — so the target cannot decide this.
    pressAt(document.body, 10, 10);
    expect(dialog.open).toBe(false);

    // A press on the dialog's own padding reports the DIALOG as the target,
    // which is the other half of that trap: `target === dialog` alone would
    // dismiss whenever somebody pressed the edge of the panel.
    element<HTMLButtonElement>("settings-open").click();
    pressAt(dialog, 300, 395);
    expect(dialog.open).toBe(true);
    // A press on the content is a press on a child, not a dismissal.
    pressAt(element("settings-title"), 10, 10);
    expect(dialog.open).toBe(true);
    // A native popup paints outside the dialog's box while belonging to it.
    pressAt(element("key"), 900, 900);
    expect(dialog.open).toBe(true);

    // The mirror case: a backdrop press that reports the DIALOG as its target
    // (Safari does this where Chrome reports the body) — same target as the
    // padding press above, opposite outcome. The coordinates are the whole
    // difference, and this is the assertion that fails if they are dropped.
    element<HTMLButtonElement>("settings-open").click();
    pressAt(dialog, 10, 10);
    expect(dialog.open).toBe(false);

    element<HTMLButtonElement>("settings-open").click();
    element<HTMLButtonElement>("settings-close").click();
    expect(dialog.open).toBe(false);
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

describe("the thumb-first conversation layout", () => {
  it("places secondary controls beneath the microphone in the same stack and focus order", () => {
    const stack = document.querySelector(".voice-controls")!;
    expect(stack.contains(element("listen"))).toBe(true);
    expect(stack.contains(element("mute"))).toBe(true);
    expect(stack.contains(element("end"))).toBe(true);
    expect(element("listen").compareDocumentPosition(element("mute")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(element("mute").compareDocumentPosition(element("end")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps both waveforms without a redundant direction legend", () => {
    expect(document.querySelector("#listen #input-wave")).toBeTruthy();
    expect(document.querySelector(".voice-ring #output-wave")).toBeTruthy();
    expect(document.querySelector(".voice-signal-key")).toBeNull();
    expect(element("hero").textContent).not.toMatch(/You inside|Voice outside/);
  });

  it("places captions before the microphone in DOM order, not just with CSS order", () => {
    expect(element("captions").compareDocumentPosition(element("listen")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector(".voice-stage")!.contains(element("hero"))).toBe(true);
  });

  it("fits settings to a visual-viewport resize without losing the focused draft", async () => {
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    await wire();
    element<HTMLButtonElement>("settings-open").click();
    const field = element<HTMLInputElement>("key");
    field.value = "synthetic draft";
    field.scrollIntoView = vi.fn();
    field.focus();
    viewport.height = 420;
    viewport.offsetTop = 80;
    viewport.dispatchEvent(new Event("resize"));
    expect(element("settings").style.getPropertyValue("--voice-visible-height")).toBe("420px");
    expect(element("settings").style.getPropertyValue("--voice-visible-top")).toBe("80px");
    expect(field.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("synthetic draft");
    page!.stop();
    viewport.height = 300;
    viewport.dispatchEvent(new Event("resize"));
    expect(element("settings").style.getPropertyValue("--voice-visible-height")).toBe("420px");
  });
});

describe("the record of the conversation, behind its own button", () => {
  it("keeps the transcript and the tool calls inside the logs dialog", async () => {
    await wire();
    const logs = element<HTMLDialogElement>("logs");
    expect(logs.open).toBe(false);
    for (const id of ["transcript", "log", "copy-log", "copy-note", "transcript-panel", "log-panel"])
      expect(logs.contains(element(id)), id).toBe(true);
    // Flat, like the settings: the record is read by scrolling, not by
    // opening something inside it.
    expect(logs.querySelectorAll("details, summary").length).toBe(0);
  });

  it("opens from its button, and keeps recording into the same rows", async () => {
    fakeCapture();
    stateReply = { session: "idle" };
    await wire();
    const logs = element<HTMLDialogElement>("logs");
    const button = element<HTMLButtonElement>("logs-open");
    const socket = await goLive();
    stateReply = { session: "live" };
    socket.event({ type: "tool_log", entry: { name: "read_canvas", details: { kind: "heard", text: "read the canvas" } } });
    const logged = element("log").children.length;
    const turn = element("transcript").firstChild;

    button.click();
    expect(logs.showModal).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(element("logs-title"));
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // The record keeps recording while it is being read, and into the same
    // nodes: no re-render, no gap while the dialog is open.
    socket.event({ type: "tool_log", entry: { name: "rename_item", details: { kind: "reply", text: "renamed it" } } });
    expect(element("log").children.length).toBe(logged + 1);
    expect(element("log").textContent).toContain("tool: rename_item");
    expect(element("transcript").firstChild).toBe(turn);
    expect(element("transcript").textContent).toContain("renamed it");

    element<HTMLButtonElement>("logs-close").click();
    expect(logs.open).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("false");

    // Reopening shows the same rows, not a rebuild of them.
    button.click();
    expect(element("transcript").firstChild).toBe(turn);
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
    // And the log carries the refusal, which is where a person looks to find
    // out why their speakers stayed silent.
    expect([...document.querySelectorAll("#log li")].map((li) => li.textContent).join(" ")).toContain(
      "Studio monitors could not be used",
    );
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

/**
 * **The page half of the file tools: the folder only this page can ask for.**
 *
 * jsdom has no `showDirectoryPicker` and no IndexedDB, which is the point:
 * a fake handle proves the page reads only through the handle it was handed,
 * and the absent IndexedDB exercises the honest fallback ("kept for this
 * session only") rather than a lie about persistence.
 */
describe("the page asks for a folder, and answers file questions from it", () => {
  interface FakeNode {
    kind: "file" | "directory";
    name: string;
    text?: string;
    children?: FakeNode[];
  }

  function fakeHandle(node: FakeNode): Record<string, unknown> {
    const handle: Record<string, unknown> = { kind: node.kind, name: node.name };
    if (node.kind === "file") {
      handle.getFile = async () => ({
        size: node.text?.length ?? 0,
        text: async () => node.text ?? "",
        slice: (start: number, end: number) => ({
          text: async () => (node.text ?? "").slice(start, end),
        }),
      });
    } else {
      handle.getDirectoryHandle = async (name: string) => {
        const found = (node.children ?? []).find((one) => one.name === name && one.kind === "directory");
        if (!found) throw new Error(`no such directory: ${name}`);
        return fakeHandle(found);
      };
      handle.getFileHandle = async (name: string) => {
        const found = (node.children ?? []).find((one) => one.name === name && one.kind === "file");
        if (!found) throw new Error(`no such file: ${name}`);
        return fakeHandle(found);
      };
      handle.entries = () => {
        const list = node.children ?? [];
        let index = 0;
        return {
          async next() {
            return index < list.length
              ? { value: [list[index]!.name, fakeHandle(list[index++]!)], done: false as const }
              : { value: undefined, done: true as const };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      };
    }
    handle.queryPermission = async () => "granted";
    handle.requestPermission = async () => "granted";
    return handle;
  }

  const NOTES: FakeNode = {
    kind: "directory",
    name: "Notes",
    children: [
      { kind: "file", name: "todo.md", text: "buy milk" },
      { kind: "directory", name: "deep", children: [{ kind: "file", name: "buried.txt", text: "found it" }] },
    ],
  };

  const pickerOf = (node: FakeNode) => vi.fn(async () => fakeHandle(node) as never);

  it("picks a folder, shows it, and tells the harness the folder's name", async () => {
    const picker = pickerOf(NOTES);
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = picker;
    await wire();
    expect(element("folder-name").textContent).toBe("no folder granted");

    element<HTMLButtonElement>("folder-pick").click();
    await flush();
    expect(picker).toHaveBeenCalledTimes(1);
    expect(element("folder-name").textContent).toBe("Notes");
    // No IndexedDB in jsdom: the page says the grant is session-only.
    expect(element("folder-note").textContent).toContain("this session only");
    expect(element<HTMLButtonElement>("folder-forget").hidden).toBe(false);
    const grant = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/fs/grant"));
    expect(JSON.parse(String((grant?.[1] as RequestInit).body))).toEqual({ folder: "Notes", granted: true });
  });

  it("reads a file through the handle and answers with the content", async () => {
    fakeCapture();
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = pickerOf(NOTES);
    await wire();
    element<HTMLButtonElement>("folder-pick").click();
    await flush();

    const socket = await goLive();
    socket.event({ fs: { callId: "fs_1", op: "read_file", path: "deep/buried.txt" } });
    await flush();
    const result = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/fs/result"));
    expect(JSON.parse(String((result?.[1] as RequestInit).body))).toMatchObject({
      callId: "fs_1",
      ok: true,
      content: "found it",
      truncated: false,
    });
  });

  it("lists a folder through the handle, and refuses a path that leaves it", async () => {
    fakeCapture();
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = pickerOf(NOTES);
    await wire();
    element<HTMLButtonElement>("folder-pick").click();
    await flush();
    const socket = await goLive();

    socket.event({ fs: { callId: "fs_2", op: "list_dir", path: "" } });
    await flush();
    const listed = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/fs/result")).at(-1);
    expect(JSON.parse(String((listed?.[1] as RequestInit).body))).toMatchObject({
      ok: true,
      truncated: false,
    });
    expect(JSON.parse(String((listed?.[1] as RequestInit).body)).entries.map((one: { name: string }) => one.name)).toEqual([
      "todo.md",
      "deep",
    ]);

    // `..` cannot resolve inside the handle, so it is a refusal with words.
    socket.event({ fs: { callId: "fs_3", op: "read_file", path: "../secrets.txt" } });
    await flush();
    const refused = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/fs/result")).at(-1);
    expect(JSON.parse(String((refused?.[1] as RequestInit).body))).toMatchObject({ callId: "fs_3", ok: false });
    expect(JSON.parse(String((refused?.[1] as RequestInit).body)).error).toMatch(/no such file/);
  });

  it("refuses a read when no folder is granted — never a silent empty answer", async () => {
    fakeCapture();
    await wire();
    const socket = await goLive();
    socket.event({ fs: { callId: "fs_4", op: "read_file", path: "todo.md" } });
    await flush();
    const result = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/fs/result"));
    expect(JSON.parse(String((result?.[1] as RequestInit).body))).toMatchObject({
      callId: "fs_4",
      ok: false,
      error: "no folder is granted in the page",
    });
  });

  it("forgets the folder, and says so to the harness", async () => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = pickerOf(NOTES);
    await wire();
    element<HTMLButtonElement>("folder-pick").click();
    await flush();
    element<HTMLButtonElement>("folder-forget").click();
    await flush();
    expect(element("folder-name").textContent).toBe("no folder granted");
    expect(element<HTMLButtonElement>("folder-forget").hidden).toBe(true);
    const grant = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/fs/grant")).at(-1);
    expect(JSON.parse(String((grant?.[1] as RequestInit).body))).toEqual({ folder: null, granted: false });
  });
});

/**
 * **Memory, in the page's own store, and the person able to see all of it.**
 *
 * jsdom has no OPFS and no `navigator.storage`, which exercises the honest
 * fallback: the store is this tab's memory for the session and the panel says
 * so. The fake-OPFS test below is the reload claim at jsdom scale — a second
 * `wireVoice` reading what the first one wrote — and the real-browser proof
 * (reload, then a browser restart) is run separately, against the code as
 * shipped.
 */
describe("memory lives in the page's store", () => {
  const fakeOpfs = () => {
    const files = new Map<string, string>();
    const dir = (prefix: string): Record<string, unknown> => ({
      getDirectoryHandle: async (name: string) => dir(`${prefix}${name}/`),
      getFileHandle: async (name: string) => {
        const key = `${prefix}${name}`;
        return {
          createWritable: async () => ({
            write: async (data: string) => {
              files.set(key, data);
            },
            close: async () => undefined,
          }),
          getFile: async () => ({ text: async () => files.get(key) ?? "" }),
        };
      },
    });
    return {
      files,
      storage: {
        getDirectory: async () => dir(""),
        persist: async () => true,
        persisted: async () => true,
      },
    };
  };

  const withStorage = (value: unknown) =>
    Object.defineProperty(navigator, "storage", { configurable: true, value });

  it("records a memory through the broker, and the panel shows it", async () => {
    fakeCapture();
    withStorage(undefined); // no OPFS: the session-only fallback, stated as such
    await wire();
    const socket = await goLive();
    socket.event({ memory: { callId: "m1", op: "remember", text: "the daemon port is 4441", tags: ["daemon"], session: "Voice" } });
    await flush();

    const stored = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/memory/result"));
    const body = JSON.parse(String((stored?.[1] as RequestInit).body));
    expect(body).toMatchObject({ callId: "m1", ok: true, tags: ["daemon"] });
    expect(body.id).toMatch(/^mem_/);
    expect(body.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await flush();
    expect(element("memory-summary").textContent).toBe("1 memory");
    expect(element("memory-list").textContent).toContain("the daemon port is 4441");
    expect(element("memory-note").textContent).toContain("session only");
  });

  it("answers a search honestly, and a read by id (or says which ids exist)", async () => {
    fakeCapture();
    await wire();
    const socket = await goLive();
    for (const text of ["the daemon port is 4441", "Paul prefers short answers"]) {
      socket.event({ memory: { callId: `w_${text.length}`, op: "remember", text, session: "Voice" } });
      await flush();
    }
    const lastResult = () =>
      JSON.parse(
        String(
          (vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/memory/result")).at(-1)?.[1] as RequestInit)
            .body,
        ),
      );

    socket.event({ memory: { callId: "s1", op: "search", query: "DAEMON" } });
    await flush();
    expect(lastResult()).toMatchObject({ callId: "s1", ok: true, count: 1 });

    socket.event({ memory: { callId: "s2", op: "search", query: "database" } });
    await flush();
    expect(lastResult()).toMatchObject({ callId: "s2", ok: true, count: 0 }); // a synonym was never written

    socket.event({ memory: { callId: "s3", op: "read", id: "mem_nope" } });
    await flush();
    const miss = lastResult();
    expect(miss).toMatchObject({ callId: "s3", ok: false });
    expect(miss.recentIds.length).toBe(2); // so the model can retry with a real one
  });

  it("lets the person forget one entry, and all of them", async () => {
    fakeCapture();
    await wire();
    const socket = await goLive();
    socket.event({ memory: { callId: "w1", op: "remember", text: "first", session: "Voice" } });
    await flush();
    socket.event({ memory: { callId: "w2", op: "remember", text: "second", session: "Voice" } });
    await flush();
    expect(element("memory-summary").textContent).toBe("2 memories");

    const forget = [...element("memory-list").querySelectorAll("button")].find((b) => b.textContent === "Forget");
    forget!.click();
    await flush();
    expect(element("memory-summary").textContent).toBe("1 memory");

    element<HTMLButtonElement>("memory-forget-all").click();
    await flush();
    expect(element("memory-summary").textContent).toBe("nothing stored");
    expect(element<HTMLButtonElement>("memory-forget-all").hidden).toBe(true);
  });

  it("keeps memory across a page reload when OPFS is there", async () => {
    const opfs = fakeOpfs();
    withStorage(opfs.storage);

    fakeCapture();
    await wire();
    const socket = await goLive();
    socket.event({ memory: { callId: "w1", op: "remember", text: "survives a reload", tags: ["opfs"], session: "Voice" } });
    await flush();
    page?.stop();

    // A reload: new wiring, new listeners, same store.
    await wire();
    await flush();
    expect(element("memory-summary").textContent).toBe("1 memory");
    expect(element("memory-list").textContent).toContain("survives a reload");
    expect(opfs.files.get("voice/memories.json")).toContain("survives a reload");

    // And a search through the broker finds it after the reload.
    const socket2 = await goLive();
    socket2.event({ memory: { callId: "s1", op: "search", query: "reload" } });
    await flush();
    const found = JSON.parse(
      String(
        (vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/memory/result")).at(-1)?.[1] as RequestInit).body,
      ),
    );
    expect(found).toMatchObject({ callId: "s1", ok: true, count: 1 });
  });

  it("takes the harness's old file once, without duplicating what is already here", async () => {
    const opfs = fakeOpfs();
    withStorage(opfs.storage);
    const original = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/memory/legacy")) {
        return answer({
          entries: [
            { id: "mem_old", text: "stored before the move", tags: ["legacy"], at: "2026-09-12T00:00:00.000Z", session: "Voice" },
          ],
          count: 1,
        });
      }
      return original!(input, init);
    });

    await wire();
    await flush();
    expect(element("memory-list").textContent).toContain("stored before the move");
    const migrated = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/memory/migrated"));
    expect(JSON.parse(String((migrated?.[1] as RequestInit).body))).toEqual({ count: 1 });

    // A second load must not import the same entry twice.
    page?.stop();
    await wire();
    await flush();
    expect(element("memory-summary").textContent).toBe("1 memory");
  });
});
