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

function fakeCapture(): void {
  class FakeContext {
    sampleRate = 48000;
    currentTime = 0;
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
    for (const id of ["listen", "mute", "end", "device", "meter", "log"]) {
      expect(document.getElementById(id), id).toBeTruthy();
    }
    expect(element<HTMLElement>("bars").children).toHaveLength(28);
    expect(element<HTMLElement>("peak").hidden).toBe(true);
    expect(document.querySelectorAll(".voice-scale span")).toHaveLength(3);
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
    expect(element<HTMLButtonElement>("listen").disabled).toBe(true);
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
    // The ticker is what writes the meter, so let it tick once: the waveform
    // now reads the model's own output, not the microphone.
    await vi.advanceTimersByTimeAsync(150);
    expect(element<HTMLElement>("meter").getAttribute("aria-label")).toContain("output level");

    // The reply, as the harness tags it: the transcript shows both sides.
    socket.event({ type: "tool_log", entry: { details: { kind: "reply", text: "I've read the canvas." } } });
    expect(element("transcript").textContent).toContain("Voice");
    expect(element("transcript").textContent).toContain("I've read the canvas.");

    // A quiet tail returns to listening without anyone saying so.
    await vi.advanceTimersByTimeAsync(900);
    expect(element<HTMLElement>("hero").dataset.activity).toBe("listening");
    expect(element<HTMLElement>("meter").getAttribute("aria-label")).toContain("input level");
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
