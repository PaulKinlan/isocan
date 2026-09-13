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

function fakeCapture(): { frame(): void } {
  FakeSocket.latest = null;
  let worklet: FakeWorklet | null = null;
  class FakeContext {
    sampleRate = 48000;
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
  return { frame: () => (worklet?.port.onmessage as ((event: { data: Float32Array }) => void) | null)?.({ data: new Float32Array(128).fill(0.25) }) };
}

describe("hold-to-talk microphone ownership", () => {
  function pointer(type: string, target: EventTarget = element("listen")): void {
    target.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerId: 1, isPrimary: true, button: 0 }));
  }
  function space(type: string, target: EventTarget = document.body, repeat = false): void {
    target.dispatchEvent(new KeyboardEvent(type, { code: "Space", key: " ", repeat, bubbles: true, cancelable: true }));
  }
  function trackedMic() {
    const mic = fakeCapture();
    const track = { kind: "audio", label: "Fake microphone", readyState: "live", getSettings: () => ({}), stop: vi.fn() };
    track.stop.mockImplementation(() => { track.readyState = "ended"; });
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
    const grant = vi.fn(async () => stream);
    navigator.mediaDevices.getUserMedia = grant;
    localStorage.setItem("isocan.voice.inputMode", "push-to-talk");
    return { ...mic, track, stream, grant };
  }

  it("defaults to Toggle, saves a real hold-mode choice, and rejects unknown preferences", async () => {
    localStorage.setItem("isocan.voice.inputMode", "unknown");
    await wire();
    const select = element<HTMLSelectElement>("input-mode");
    expect(select.value).toBe("toggle");
    select.value = "push-to-talk";
    select.dispatchEvent(new Event("change"));
    expect(localStorage.getItem("isocan.voice.inputMode")).toBe("push-to-talk");
    expect(element("mute").hidden).toBe(false);
    expect(element<HTMLButtonElement>("mute").disabled).toBe(true);
    expect(element("shortcut").textContent).toContain("release to mute");
    expect(element("mode-note").textContent).toContain("does not send or end a turn");
  });

  it("stops tracks immediately while unmute is pending and keeps them stopped after its late reply", async () => {
    const mic = trackedMic();
    const normal = vi.mocked(fetch).getMockImplementation()!;
    let acknowledge!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith("/session/unmute")
      ? new Promise<Response>((resolve) => { acknowledge = resolve; }) : normal(input, init));
    await wire();
    pointer("pointerdown"); await flush();
    const socket = FakeSocket.latest!;
    socket.onopen?.(); await flush();
    mic.frame(); expect(socket.sent.length).toBeGreaterThan(0);
    const sent = socket.sent.length;
    pointer("pointerup", document);
    expect(mic.track.stop).toHaveBeenCalledOnce(); // No acknowledgement resolved.
    expect(mic.track.readyState).toBe("ended");
    expect(element("hero").textContent).toContain("microphone stopped; session still open");
    mic.frame(); expect(socket.sent).toHaveLength(sent);
    acknowledge(answer({ ok: true })); await flush();
    expect(mic.track.readyState).toBe("ended");
    expect(mic.grant).toHaveBeenCalledOnce();
    expect(element("hero").dataset.muted).toBe("true");
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter((url) => /session\/(unmute|mute)$/.test(url))).toEqual(["/harness/session/unmute", "/harness/session/mute"]);
  });

  it("stops a late permission grant without ever sending its audio", async () => {
    const mic = trackedMic();
    let allow!: (stream: MediaStream) => void;
    mic.grant.mockImplementation(() => new Promise((resolve) => { allow = resolve; }));
    await wire(); pointer("pointerdown"); await flush();
    pointer("pointerup", document);
    expect(element("hero").dataset.muted).toBe("true");
    expect(mic.track.stop).not.toHaveBeenCalled(); // There is no granted track yet.
    allow(mic.stream); await flush();
    expect(mic.track.stop).toHaveBeenCalledOnce();
    expect(mic.track.readyState).toBe("ended");
    const socket = FakeSocket.latest!;
    socket.onopen?.(); await flush(); mic.frame();
    expect(socket.sent).toHaveLength(0);
    expect(element("hero").dataset.muted).toBe("true");
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/session/unmute"))).toBe(false);
  });

  it("can honour a new hold while stopping the previous late grant", async () => {
    const mic = trackedMic();
    const second = { ...mic.track, readyState: "live", stop: vi.fn() };
    second.stop.mockImplementation(() => { second.readyState = "ended"; });
    const fresh = { getTracks: () => [second], getAudioTracks: () => [second] } as unknown as MediaStream;
    let allow!: (stream: MediaStream) => void;
    mic.grant.mockImplementationOnce(() => new Promise((resolve) => { allow = resolve; })).mockResolvedValueOnce(fresh);
    await wire(); pointer("pointerdown"); await flush();
    pointer("pointerup", document); pointer("pointerdown");
    allow(mic.stream); await flush();
    expect(mic.track.readyState).toBe("ended");
    expect(mic.grant).toHaveBeenCalledTimes(2);
    expect(second.readyState).toBe("live");
    mic.frame(); expect(FakeSocket.latest!.sent.length).toBeGreaterThan(0);
    pointer("pointerup", document); expect(second.readyState).toBe("ended");
  });

  it.each(["resume", "worklet"])("stops a granted track even while %s startup is unresolved", async (phase) => {
    const mic = trackedMic();
    let ready!: () => void;
    class DelayedContext extends AudioContext {
      constructor() {
        super();
        if (phase === "worklet") this.audioWorklet.addModule = () => new Promise<void>((resolve) => { ready = resolve; });
      }
      override resume(): Promise<void> {
        return phase === "resume" ? new Promise<void>((resolve) => { ready = resolve; }) : super.resume();
      }
    }
    vi.stubGlobal("AudioContext", DelayedContext);
    await wire(); pointer("pointerdown"); await flush();
    expect(ready).toBeTypeOf("function");
    expect(mic.track.readyState).toBe("live");
    pointer("pointerup", document);
    const beforeResolution = mic.track.readyState;
    ready(); await flush(); // The late continuation must not resurrect it either.
    expect(beforeResolution).toBe("ended");
    expect(mic.track.readyState).toBe("ended");
    expect(element("hero").dataset.muted).toBe("true");
  });

  it.each(["pointercancel", "lostpointercapture", "blur"])("stops tracks on %s", async (event) => {
    const mic = trackedMic();
    await wire(); pointer("pointerdown"); await flush();
    if (event === "blur") window.dispatchEvent(new Event("blur"));
    else pointer(event, event === "pointercancel" ? document : element("listen"));
    expect(mic.track.readyState).toBe("ended");
    expect(element("hero").dataset.muted).toBe("true");
  });

  it("holds with Space, ignores repeats, and never reopens on the release's compatibility click", async () => {
    const mic = trackedMic();
    await wire(); space("keydown"); await flush();
    space("keydown", document.body, true); await flush();
    expect(mic.grant).toHaveBeenCalledOnce();
    space("keyup"); element("listen").click();
    expect(mic.track.readyState).toBe("ended");
    expect(element("hero").dataset.muted).toBe("true");
  });

  it.each(["input", "textarea", "select", "button", "div"])("does not steal Space from a focused %s", async (tag) => {
    const mic = trackedMic(); await wire();
    const input = document.createElement(tag); input.tabIndex = 0;
    if (tag === "div") input.setAttribute("contenteditable", "true");
    document.body.appendChild(input); input.focus(); space("keydown", input); await flush();
    expect(mic.grant).not.toHaveBeenCalled();
  });

  it("does not start from a modal, confirmation, or disposed page", async () => {
    const mic = trackedMic(); await wire();
    element("settings-open").click(); space("keydown"); await flush();
    expect(mic.grant).not.toHaveBeenCalled();
    element("settings-close").click(); element("confirm").hidden = false;
    space("keydown"); await flush(); expect(mic.grant).not.toHaveBeenCalled();
    element("confirm").hidden = true; page!.stop(); pointer("pointerdown"); space("keydown");
    await flush(); expect(mic.grant).not.toHaveBeenCalled();
  });
});

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
    for (const id of ["listen", "mute", "end", "device", "input-wave", "output-wave", "log"]) {
      expect(document.getElementById(id), id).toBeTruthy();
    }
    expect(document.querySelector("#listen #input-wave")).toBeTruthy();
    expect(document.querySelector("#listen #output-wave")).toBeNull();
    expect(document.querySelectorAll("#meter, #bars, #peak, .voice-scale")).toHaveLength(0);
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
  it("lists the microphones and remembers the one chosen", async () => {
    await wire();
    const device = element<HTMLSelectElement>("device");
    expect([...device.options].map((one) => one.textContent)).toEqual(["Desk microphone", "Headset"]);
    expect(device.value).toBe("mic-1");
    device.value = "mic-2";
    device.dispatchEvent(new Event("change"));
    await flush();
    expect(localStorage.getItem("isocan.voice.deviceId")).toBe("mic-2");
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
    await wire();
    const dialog = element<HTMLDialogElement>("settings");
    expect(dialog.open).toBe(false);
    for (const id of ["connection-panel", "key-panel", "daemon-field", "device", "save-key", "test-key", "forget-key"])
      expect(dialog.contains(element(id))).toBe(true);
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
    expect(element("keep-captions").closest("label")).toBeTruthy();
  });

  it("fits settings to a visual-viewport resize without losing the focused draft", async () => {
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    await wire();
    element<HTMLButtonElement>("settings-open").click();
    element<HTMLDetailsElement>("key-panel").open = true;
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
      expect(buildWords()).toBe("feat/voice-ui-vite @ 57dd1b50\nBuild time not injected");
      expect(element("build-tag")).toBeTruthy();
    } finally {
      delete (globalThis as Record<string, unknown>).__VOICE_BUILD_INFO__;
    }
  });
});

describe("the build timestamp is not the browser clock", () => {
  it.each([["serve", "Dev started"], ["build", "Built"]])("labels %s using its fixed UTC invocation time", (command, label) => {
    vi.stubGlobal("__VOICE_BUILD_INFO__", { branch: "review", commit: "abcdef012345", command, startedAt: "2026-09-13T19:00:00.000Z" });
    const expected = `review @ abcdef01\n${label} 2026-09-13 19:00:00 UTC`;
    expect(buildWords()).toBe(expected);
    vi.setSystemTime(new Date("2035-01-01T00:00:00Z"));
    expect(buildWords()).toBe(expected);
  });

  it("does not invent a timestamp when the injected date is invalid", () => {
    vi.stubGlobal("__VOICE_BUILD_INFO__", { branch: "review", commit: "abcdef01", command: "build", startedAt: "not-a-date" });
    expect(buildWords()).toBe("review @ abcdef01\nBuild time not injected");
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
