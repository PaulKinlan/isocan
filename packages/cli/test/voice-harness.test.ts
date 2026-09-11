import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon, type Daemon } from "@isocan/server";
import { harnessVars } from "@isocan/api";
import { mintTestBadge, type TestBadge } from "./badge.ts";
import {
  DEFAULT_VOICE_PORT,
  LIVE_MODEL,
  liveSetup,
  liveUrl,
  planForCall,
  resolveLivePlans,
  startLiveSession,
  createAcpAgent,
  planVoice,
  providerFor,
  readVoiceKey,
  resolveSpokenRef,
  startVoiceServer,
  voiceKeyFile,
  writeVoiceKey,
} from "../src/voice-harness.ts";
import type { ListedItem } from "@isocan/api";

/**
 * **The voice harness** (Paul, 11 Sep 2026), pinned at the three joints that
 * could each be a lie:
 *
 * - **the grammar** — a sentence to a plan, a spoken reference to an item. Pure,
 *   so the mapping is a fact rather than a transcript;
 * - **the key** — stored by the harness `0600`, and the page that carries it
 *   for exactly one request writes it nowhere (asserted against the page's own
 *   text: no `localStorage` anywhere in it);
 * - **the operation** — a typed utterance lands on a real daemon as the
 *   ENROLLED actor. That last assertion is the whole reason this is a harness
 *   and not a page with a socket: if the op is not attributed, the microphone
 *   is a stranger talking.
 *
 * The ACP face is driven on its wire shapes (initialize / session/new /
 * session/prompt, `stopReason: end_turn`) because that is what makes it a
 * harness the rc can invite.
 */

const cliBin = fileURLToPath(new URL("../bin/isocan.js", import.meta.url));
/**
 * Two actors, deliberately: `seeder` is the test's own badge, holding one
 * actor for the fixture operations it posts, and `person` is the machine's
 * person in `identity.json` — the actor the SPAWNED CLI has to be able to
 * claim for itself. One badge holding both is exactly what the desk refuses
 * (one actor, two faces), which is how this test found that out.
 */
const seeder = { id: "usr_seeder", name: "Seeder" };
const person = { id: "usr_person", name: "Person" };
const voice = { id: "usr_voice", name: "Voice" };

let home: string;
let daemon: Daemon;
let base: string;
let badge: TestBadge;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "isocan-voice-"));
  await fs.writeFile(
    path.join(home, "identity.json"),
    JSON.stringify({ ...person, createdAt: new Date().toISOString() }),
  );
  daemon = await startDaemon({ port: 0, home });
  const address = daemon.app.server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  badge = await mintTestBadge(base);
  await badge.speakAs(seeder);
  await post("/api/ops", {
    canvasId: null,
    actor: seeder,
    op: { type: "project.create", canvasId: "prj_1", title: "Voice test" },
  });
  // The enrolment, exercised the way a person does it: the CLI claims
  // `agent:Voice` on THIS machine's badge, which is the claim the rc makes
  // before it spawns an adapter. Done through the CLI rather than by posting
  // an op, because the badge a claim belongs to is the whole question —
  // `startVoiceServer` resolves with the machine's own, exactly as the
  // rc-spawned adapter does.
  const claimed = await isocan(["identity", "--name", "Voice", "--session"], {
    ISOCAN_SESSION_ID: "Voice",
    ISOCAN_HARNESS: "agent",
  });
  expect(claimed.code, claimed.stderr).toBe(0);
  await post("/api/ops", {
    canvasId: "prj_1",
    actor: seeder,
    op: {
      type: "item.add",
      itemId: "itm_1",
      version: { id: "ver_1", blobHash: "h1", mimeType: "text/markdown", filename: "a.md", size: 3 },
      width: 320,
      height: 240,
      placement: { x: 100, y: 100 },
      title: "Checkout screen",
    },
  });
});

afterEach(async () => {
  await daemon.close();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function post(url: string, body: unknown): Promise<any> {
  const res = await fetch(`${base}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...badge.headers },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => null);
}

/** Every op the canvas has, oldest first, with who sent it — the watched log
 * replayed from zero, which is what `isocan tail --since 0` walks. */
async function log(): Promise<{ type: string; actor: string }[]> {
  const res = await fetch(`${base}/api/oplog/watch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...badge.headers },
    body: JSON.stringify({ cursors: { prj_1: 0 }, only: ["prj_1"], waitMs: 0 }),
  });
  const body = (await res.json()) as {
    entries?: { envelope: { actor: { id: string }; op: { type: string } } }[];
  };
  return (body.entries ?? []).map((entry) => ({ type: entry.envelope.op.type, actor: entry.envelope.actor.id }));
}

async function items(): Promise<ListedItem[]> {
  const res = await fetch(`${base}/api/projects/prj_1/canvas`, { headers: badge.headers });
  const body = (await res.json()) as { canvas?: { items?: Record<string, { title?: string; x: number; y: number }> } };
  return Object.entries(body.canvas?.items ?? {}).map(([id, item]) => ({ id, ...item }) as ListedItem);
}

/** Actor id → the name the canvas knows them by, which is how a test can ask
 * "who did this?" without inventing the desk's ids. */
async function namesOnCanvas(): Promise<Record<string, string>> {
  const res = await fetch(`${base}/api/projects/prj_1/canvas`, { headers: badge.headers });
  const body = (await res.json()) as { names?: Record<string, string> };
  return body.names ?? {};
}

const item = (title: string, id = title, x = 100, y = 100): ListedItem =>
  ({ id, title, x, y, kind: "text", createdAt: new Date(2026, 0, 1).toISOString() }) as ListedItem;

/** The CLI, with this test's temp home and daemon — the same launcher the acp
 * suite uses, so the machine badge and the identity resolution are the real
 * ones. */
function isocan(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  // EVERY harness variable, not just isocan's two: this suite runs inside pi,
  // so `PI_SESSION_ID` in the ambient environment made the spawned CLI read
  // itself as a harness session and refuse `rc turn` as an agent's verb.
  for (const name of harnessVars) delete env[name];
  const child = spawn(process.execPath, [cliBin, ...args], {
    env: { ...env, ISOCAN_HOME: home, ISOCAN_PORT: new URL(base).port, ...extraEnv },
    cwd: home,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr })));
}

describe("what a sentence means", () => {
  it("renames, deletes, moves, says, asks and comments — each as an operation that already existed", () => {
    const items = [item("Checkout screen", "itm_1"), item("Settings screen", "itm_2")];
    const ctx = { items, mainThreadId: null };

    const renamed = planVoice("retitle the second screen to Checkout v2", ctx);
    expect(renamed.plans[0]!.op).toMatchObject({ type: "item.update", itemId: "itm_2", title: "Checkout v2" });

    expect(planVoice("delete Settings", ctx).plans[0]!.op).toMatchObject({ type: "item.delete", itemId: "itm_2" });

    const moved = planVoice("move the first thing by 60, -20", ctx);
    expect(moved.plans[0]!.op).toMatchObject({ type: "item.move", itemId: "itm_1", x: 160, y: 80 });

    const placed = planVoice("move Checkout screen to 400, 200", ctx);
    expect(placed.plans[0]!.op).toMatchObject({ type: "item.move", itemId: "itm_1", x: 400, y: 200 });

    expect(planVoice("say the type scale is agreed", ctx).plans[0]!.op).toMatchObject({
      type: "thread.reply",
      body: "the type scale is agreed",
    });
    expect(planVoice("ask which of the two we keep", ctx).plans[0]!.op).toMatchObject({
      type: "thread.reply",
      body: "? which of the two we keep",
    });
    expect(planVoice("comment on Checkout screen: the padding is wrong", ctx).plans[0]!.op).toMatchObject({
      type: "item.comment",
      itemId: "itm_1",
      body: "the padding is wrong",
    });
  });

  it("answers a question about the canvas instead of inventing an operation", () => {
    const out = planVoice("what is on this canvas?", { items: [item("Checkout screen", "itm_1")], mainThreadId: null });
    expect(out.plans).toEqual([]);
    expect(out.what).toContain("Checkout screen");
  });

  it("refuses to guess which of two things you meant, and says so", () => {
    const ctx = { items: [item("Checkout screen", "itm_1"), item("Checkout v2", "itm_2")], mainThreadId: null };
    const out = planVoice("delete Checkout", ctx);
    expect(out.plans).toEqual([]);
    expect(out.what).toContain("Checkout");
  });

  it("resolves a title prefix and an ordinal, and refuses an ambiguous one", () => {
    const items = [item("Checkout screen", "itm_1"), item("Settings screen", "itm_2")];
    expect(resolveSpokenRef("checkout", items)?.id).toBe("itm_1");
    expect(resolveSpokenRef("the first thing", items)?.id).toBe("itm_1");
    expect(resolveSpokenRef("screen", items)).toBeNull();
  });
});

describe("the key belongs to the harness", () => {
  it("stores it 0600, reads it back, and refuses one that leaked its own permissions", async () => {
    const file = await writeVoiceKey(home, { provider: "gemini", key: "AIza-secret" });
    expect(file).toBe(voiceKeyFile(home));
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await readVoiceKey(home)).toEqual({ provider: "gemini", key: "AIza-secret" });

    await fs.chmod(file, 0o644);
    await expect(readVoiceKey(home)).rejects.toThrow(/not 600/);
  });

  it("never refuses a key: the shape is only a default, and the provider judges", () => {
    expect(providerFor("AIza-abc")).toBe("gemini");
    expect(providerFor("sk-abc")).toBe("openai");
    // Whatever shape it is, it is accepted. This used to be `null`: a
    // client-side guess about a key format, failing closed on a real key
    // before anything had sent it.
    expect(providerFor("hunter2")).toBe("gemini");
    expect(providerFor("hunter2", "openai")).toBe("openai");
    expect(providerFor("AIza-abc", "openai")).toBe("openai");
  });

});

describe("the page", () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function serve(port = 0) {
    const server = await startVoiceServer({
      home,
      port,
      identity: { session: "Voice", harness: "agent" },
      canvas: "prj_1",
      daemonPort: Number(new URL(base).port),
    });
    close = server.close;
    return server;
  }

  it("serves the harness's own page, prefers `<microphone>` and falls back in the stated order, and writes nothing to browser storage", async () => {
    const server = await serve();
    const page = await (await fetch(server.state.url)).text();

    expect(page).toContain("isocan voice");
    expect(page).toContain("Voice");
    // The ladder, in order: microphone, then usermedia, then getUserMedia.
    const mic = page.indexOf('name: "microphone"');
    const gum = page.indexOf('name: "getUserMedia"');
    expect(mic).toBeGreaterThan(-1);
    expect(mic).toBeLessThan(gum);
    // `<usermedia>` is deliberately NOT a rung: it asks for camera and
    // microphone together, and an audio feature must not prompt for a camera.
    expect(page).not.toContain('name: "usermedia"');
    expect(page).toContain("asks for camera and microphone together");
    // And the constraint is audio-only.
    expect(page).toContain("getUserMedia({ audio: true, video: false })");
    // The key is never the page's to keep: the BEHAVIOUR script — the only
    // half that could write anything — names no browser storage at all. The
    // prose above it is allowed to say so in words.
    // No deprecated node: Paul read the console, and a deprecation warning
    // that looks like a defect is one.
    expect(page).not.toContain("createScriptProcessor");
    expect(page).toContain("audioWorklet.addModule");
    const behaviour = page.slice(page.lastIndexOf("<script>"));
    expect(behaviour).not.toContain("localStorage");
    expect(behaviour).not.toContain("document.cookie");
  });

  it("says what it is connected to: canvas by title and id, daemon, home, agent, provider", async () => {
    const server = await serve();
    const facts = (await (await fetch(`${server.state.url}connection`)).json()) as Record<string, any>;
    expect(facts.canvas).toEqual({ title: "Voice test", id: "prj_1" });
    expect(facts.daemon).toContain("127.0.0.1:".slice(0, 10));
    expect(facts.agent).toMatchObject({ name: "Voice", enrolled: false });
    expect(facts.provider).toMatchObject({ name: null, key: false });
    expect(facts.version).toBeTruthy();
    expect(facts.updated).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(facts.provider.model).toBe("models/gemini-3.1-flash-live-preview");
    // The key itself is never in the facts, only whether one is there.
    await fetch(`${server.state.url}key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "AIza-secret-value" }),
    });
    const after = (await (await fetch(`${server.state.url}connection`)).json()) as Record<string, any>;
    expect(after.provider).toMatchObject({ name: "gemini", key: true });
    expect(JSON.stringify(after)).not.toContain("AIza-secret-value");
  });

  it("stores a key the page POSTs, and reports it without ever echoing it back", async () => {
    const server = await serve();
    const saved = await (
      await fetch(`${server.state.url}key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "AIza-from-the-page" }),
      })
    ).json();
    expect(saved).toMatchObject({ provider: "gemini" });
    expect(JSON.stringify(saved)).not.toContain("AIza-from-the-page");
    expect(await readVoiceKey(home)).toEqual({ provider: "gemini", key: "AIza-from-the-page" });
  });

  it("sends a typed utterance as the ENROLLED agent, and the canvas says so", async () => {
    const server = await serve();
    const out = (await (
      await fetch(`${server.state.url}utterance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "retitle the first thing to Checkout v2", source: "typed" }),
      })
    ).json()) as { sent: string[]; failed: string[]; reply: string };

    expect(out.sent).toHaveLength(1);
    expect(out.failed).toEqual([]);

    const after = await items();
    expect(after.map((i) => i.title)).toContain("Checkout v2");

    // The attribution IS the feature: the operation is the ENROLLED Voice
    // actor's, not the person's, so `@Voice` reaches it and undo treats it as
    // the agent's work. The id is the desk's to mint, so this asserts the two
    // facts that matter — it is not the person, and the canvas calls it Voice.
    const last = (await log()).at(-1)!;
    expect(last.type).toBe("item.update");
    expect(last.actor).not.toBe(seeder.id);
    const names = await namesOnCanvas();
    expect(names[last.actor]).toBe("Voice");
  });

  it("refuses a sentence it cannot turn into an operation, and sends nothing", async () => {
    const server = await serve();
    const before = (await log()).length;
    const out = (await (
      await fetch(`${server.state.url}utterance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "make it feel more premium", source: "typed" }),
      })
    ).json()) as { sent: string[]; failed: string[]; reply: string };
    expect(out.sent).toEqual([]);
    expect(out.reply).toContain("I know:");
    expect((await log()).length).toBe(before);
  });
});

describe("the ACP face", () => {
  it("speaks the wire the rc speaks, and answers a turn with end_turn", async () => {
    const written: unknown[] = [];
    const agent = createAcpAgent({ name: "Voice", forward: async () => ({ url: "http://127.0.0.1:1/" }), out: (m) => written.push(m) });

    await agent.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(written[0]).toMatchObject({ id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });

    await agent.handle({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
    const session = (written[1] as { result: { sessionId: string } }).result.sessionId;
    expect(session).toBeTruthy();

    await agent.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: session, prompt: [{ type: "text", text: "look at the checkout screen" }] },
    });
    const update = written.find((m) => (m as { method?: string }).method === "session/update") as {
      params: { update: { sessionUpdate: string; content: { text: string } } };
    };
    expect(update.params.update.sessionUpdate).toBe("agent_message_chunk");
    expect(update.params.update.content.text).toContain("http://127.0.0.1:1/");
    expect(written.at(-1)).toMatchObject({ id: 3, result: { stopReason: "end_turn" } });
  });

  it("refuses a method it does not speak rather than hanging a turn", async () => {
    const written: unknown[] = [];
    const agent = createAcpAgent({ name: "Voice", forward: async () => null, out: (m) => written.push(m) });
    await agent.handle({ jsonrpc: "2.0", id: 9, method: "session/teleport", params: {} });
    expect(written[0]).toMatchObject({ id: 9, error: { code: -32601 } });
  });
});

describe("the Live API path", () => {
  it("opens with the setup the API expects, on the model that is current", () => {
    const setup = liveSetup() as { setup: Record<string, unknown> };
    expect(LIVE_MODEL).toBe("models/gemini-3.1-flash-live-preview");
    expect(setup.setup.model).toBe(LIVE_MODEL);
    expect((setup.setup.generationConfig as { responseModalities: string[] }).responseModalities).toEqual(["AUDIO"]);
    const names = ((setup.setup.tools as { functionDeclarations: { name: string }[] }[])[0] ?? { functionDeclarations: [] })
      .functionDeclarations.map((t) => t.name);
    // The fast set, and nothing that cannot be undone.
    expect(names).toContain("rename_item");
    expect(names).toContain("move_item");
    expect(names).toContain("say");
    expect(names).not.toContain("trash_empty");
    expect(liveUrl("AIza-x")).toContain("BidiGenerateContent?key=AIza-x");
  });

  it("speaks the wire: setup first, then audio up and tool calls answered", async () => {
    const sent: string[] = [];
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let socket!: {
      onmessage: ((event: { data: unknown }) => void) | null;
      emit: (message: unknown) => void;
      readyState: number;
    };
    class FakeSocket {
      readyState = 1;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor(readonly url: string) {
        socket = this as unknown as typeof socket;
        queueMicrotask(() => this.onopen?.());
      }
      send(data: unknown) {
        sent.push(typeof data === "string" ? data : "<binary>");
      }
      close() {}
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) });
      }
    }
    const session = startLiveSession({
      key: { provider: "gemini", key: "AIza-test" },
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      callbacks: {
        onToolCall: async (name, args) => {
          calls.push({ name, args });
          return { ok: true };
        },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(sent[0] ?? "{}").setup.model).toBe(LIVE_MODEL);

    session.send(new Uint8Array([1, 2, 3, 4]));
    const audio = JSON.parse(sent[1] ?? "{}") as { realtimeInput: { audio: { mimeType: string; data: string } } };
    expect(audio.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(Buffer.from(audio.realtimeInput.audio.data, "base64")).toEqual(Buffer.from([1, 2, 3, 4]));

    // A tool call is a blocking question: the answer is the operation's RESULT.
    socket.emit({
      toolCall: { functionCalls: [{ id: "call-1", name: "rename_item", args: { item_ref: "checkout", title: "Checkout v2" } }] },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ name: "rename_item", args: { item_ref: "checkout", title: "Checkout v2" } }]);
    const answered = JSON.parse(sent.at(-1) ?? "{}") as { toolResponse: { functionResponses: { id: string; response: unknown }[] } };
    expect(answered.toolResponse.functionResponses[0]).toMatchObject({ id: "call-1", response: { ok: true } });
  });

  it("surfaces the provider's own words when the session fails", async () => {
    const states: { state: string; bad?: boolean }[] = [];
    let socket!: { emit: (message: unknown) => void };
    class FakeSocket {
      readyState = 1;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor(readonly url: string) {
        socket = this as unknown as typeof socket;
        queueMicrotask(() => this.onopen?.());
      }
      send() {}
      close() {}
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) });
      }
    }
    const session = startLiveSession({
      key: { provider: "gemini", key: "nonsense" },
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      callbacks: { onState: (state, bad) => states.push({ state, ...(bad !== undefined ? { bad } : {}) }) },
    });
    await new Promise((r) => setTimeout(r, 0));
    socket.emit({ error: { code: 400, message: "API key not valid. Please pass a valid API key." } });
    expect(await session.ready).toBe(false);
    // Verbatim. A paraphrase here is how a real key came to be called invalid.
    expect(states[0]).toEqual({ state: "API key not valid. Please pass a valid API key.", bad: true });
  });
});

describe("the harness as the rc's adapter", () => {
  it("is summoned for real: `rc turn` reaches the standing page", async () => {
    await fs.writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ acpAdapters: { voice: [process.execPath, cliBin, "voice", "--acp"] } }),
    );
    // The CLI's own badge has to hold the person before it may enrol anyone:
    // the badge this test mints is not the badge the spawned CLI carries.
    const named = await isocan(["identity", "--name", "Person", "--as", "usr_person", "--session"], {
      ISOCAN_SESSION_ID: "person",
      ISOCAN_HARNESS: "isocan",
    });
    expect(named.code, named.stderr).toBe(0);
    const enrolled = await isocan(["rc", "add", "Voice", "--harness", "voice"]);
    expect(enrolled.code, enrolled.stderr).toBe(0);

    // The page is already standing — which is the case that matters: a
    // microphone is not a turn, so the adapter hands the summons to the
    // process that outlives it rather than holding a ceiling open.
    // Port 0, not the default: the adapter finds the standing page through
    // `~/.isocan/voice/server.json`, so a fixed port would make this test
    // collide with the instance somebody is actually testing.
    const server = await startVoiceServer({
      home,
      port: 0,
      identity: { session: "Voice", harness: "agent" },
      canvas: "prj_1",
      daemonPort: Number(new URL(base).port),
    });
    try {
      const turned = await isocan(["rc", "turn", "Voice", "look", "at", "the", "checkout", "screen"]);
      expect(turned.code, turned.stderr).toBe(0);
      expect(turned.stderr).toContain("turn ended — end_turn");
      const state = (await (await fetch(`${server.state.url}state`)).json()) as { lines: string[] };
      expect(state.lines.join("\n")).toContain("summoned by Voice");
      expect(state.lines.join("\n")).toContain("look at the checkout screen");
    } finally {
      await server.close();
    }
  });


  it("is found through config.json's acpAdapters hook like any harness never heard of", async () => {
    // The door every unknown harness walks: a command and its args. This is
    // what `isocan rc add <name> --harness voice` resolves.
    await fs.writeFile(
      path.join(home, "config.json"),
      JSON.stringify({
        acpAdapters: { voice: [process.execPath, cliBin, "voice", "--acp"] },
      }),
    );
    const { adapterFor } = await import("../src/harnesses.ts");
    const spec = await adapterFor(home, "voice");
    expect(spec).toMatchObject({ harness: "voice", command: process.execPath });
    expect(spec!.args).toEqual([cliBin, "voice", "--acp"]);
  });

  it("defaults its port to the one the docs name", () => {
    expect(DEFAULT_VOICE_PORT).toBe(7654);
  });
});
