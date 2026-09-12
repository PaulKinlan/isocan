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
    const setup = JSON.parse(sent[0] ?? "{}").setup;
    expect(setup.model).toBe(LIVE_MODEL);
    expect(setup.generationConfig.responseModalities).toEqual(["AUDIO"]);

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

  it("injects project AGENTS.md instructions into the Live session setup", async () => {
    const { resolveProjectInstructions, liveSetup: makeSetup, LIVE_MODEL: defModel } = await import("../src/voice-harness.ts");
    const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-agents-test-"));
    await fs.writeFile(path.join(testDir, "AGENTS.md"), "# Project Instructions\nAlways be honest.\n");
    await fs.mkdir(path.join(testDir, ".isocan"), { recursive: true });
    await fs.writeFile(path.join(testDir, ".isocan", "project.json"), JSON.stringify({ canvasId: "prj_1" }));
    await fs.writeFile(path.join(home, "dirs.json"), JSON.stringify({ [testDir]: "prj_1" }));

    const resolved = await resolveProjectInstructions(home, "prj_1");
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe("AGENTS.md");
    expect(resolved!.text).toContain("Always be honest");

    const setup = makeSetup(defModel, resolved) as any;
    expect(setup.setup.systemInstruction.parts[0].text).toContain("=== PROJECT INSTRUCTIONS (AGENTS.md) ===");
    expect(setup.setup.systemInstruction.parts[0].text).toContain("Always be honest.");

    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("verifies native writeMarker round-trip, rejects mismatched markers, and prefers valid over stale rows", async () => {
    const { resolveProjectInstructions } = await import("../src/voice-harness.ts");
    const { writeMarker } = await import("@isocan/server");

    // 1. Native writeMarker for target canvas prj_1 (which writes projectId: "prj_1" on disk)
    const validDir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-valid-marker-"));
    await fs.writeFile(path.join(validDir, "AGENTS.md"), "# Valid Project Instructions\n");
    await writeMarker(validDir, { canvasId: "prj_1", title: "Valid Target" });

    // 2. Mismatched marker for another canvas prj_other
    const staleDir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-stale-marker-"));
    await fs.writeFile(path.join(staleDir, "AGENTS.md"), "# Stale Wrong Instructions\n");
    await writeMarker(staleDir, { canvasId: "prj_other", title: "Wrong Target" });

    // Test dirs.json carrying BOTH: stale row pointing to prj_1, followed by valid row
    await fs.writeFile(
      path.join(home, "dirs.json"),
      JSON.stringify({ [staleDir]: "prj_1", [validDir]: "prj_1" }),
    );

    // Assert stale directory is rejected because its disk marker has projectId: "prj_other"
    // And valid directory is accepted because its disk marker has projectId: "prj_1"
    const resolved = await resolveProjectInstructions(home, "prj_1");
    expect(resolved).not.toBeNull();
    expect(resolved!.text).toContain("Valid Project Instructions");
    expect(resolved!.text).not.toContain("Stale Wrong Instructions");

    // Test complete mismatch: if only staleDir exists, returns null
    await fs.writeFile(
      path.join(home, "dirs.json"),
      JSON.stringify({ [staleDir]: "prj_1" }),
    );
    const refused = await resolveProjectInstructions(home, "prj_1");
    expect(refused).toBeNull();

    await fs.rm(validDir, { recursive: true, force: true });
    await fs.rm(staleDir, { recursive: true, force: true });
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

  it("surfaces provider socket close code and reason inline when socket closes abnormally", async () => {
    const states: { state: string; bad?: boolean }[] = [];
    let socket!: { closeWith: (code: number, reason: string) => void };
    class FakeSocket {
      readyState = 1;
      onopen: (() => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor(readonly url: string) {
        socket = this as unknown as typeof socket;
        queueMicrotask(() => this.onopen?.());
      }
      send() {}
      close() {}
      closeWith(code: number, reason: string) {
        this.onclose?.({ code, reason });
      }
    }
    const session = startLiveSession({
      key: { provider: "gemini", key: "nonsense" },
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      callbacks: { onState: (state, bad) => states.push({ state, ...(bad !== undefined ? { bad } : {}) }) },
    });
    await new Promise((r) => setTimeout(r, 0));
    socket.closeWith(1007, "The requested combination of response modalities (TEXT) is not supported by the model");
    expect(await session.ready).toBe(false);
    expect(states[0]?.state).toContain("provider closed socket: code 1007 — The requested combination of response modalities (TEXT)");
    expect(states[0]?.bad).toBe(true);
  });

  it("drives live tools end-to-end: read_canvas answers live state, add_item and rename_item land operations in oplog and /log", async () => {
    await writeVoiceKey(home, { provider: "gemini", key: "AIza-live-test" });

    let providerSocket!: {
      emit: (message: unknown) => void;
      sent: string[];
    };
    class FakeLiveSocket {
      readyState = 1;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor(readonly url: string) {
        providerSocket = this;
        queueMicrotask(() => this.onopen?.());
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {}
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) });
      }
    }

    const server = await startVoiceServer({
      home,
      port: 0,
      identity: { session: "Voice", harness: "agent" },
      canvas: "prj_1",
      daemonPort: Number(new URL(base).port),
      WebSocketImpl: FakeLiveSocket as unknown as typeof WebSocket,
    });

    try {
      const { WebSocket: WsClient } = await import("ws");
      const clientWs = new WsClient(`${server.state.url.replace("http://", "ws://")}live`);
      await new Promise<void>((resolve) => {
        clientWs.on("open", () => resolve());
      });

      while (!providerSocket) await new Promise(r => setTimeout(r, 10));
      providerSocket.emit({ setupComplete: {} });
      await new Promise((r) => setTimeout(r, 50));

      // 1. read_canvas
      providerSocket.emit({
        toolCall: {
          functionCalls: [{ id: "call-read", name: "read_canvas", args: {} }],
        },
      });
      while (providerSocket.sent.length < 2) await new Promise(r => setTimeout(r, 10));

      const readReply = JSON.parse(providerSocket.sent.at(-1) ?? "{}");
      const readResp = readReply.toolResponse?.functionResponses?.[0];
      expect(readResp.id).toBe("call-read");
      expect(readResp.response.ok).toBe(true);
      expect(readResp.response.canvas).toContain("Checkout screen");

      // 2. add_item
      providerSocket.emit({
        toolCall: {
          functionCalls: [
            {
              id: "call-add",
              name: "add_item",
              args: { title: "Spoken Note", text: "Created by voice tool call" },
            },
          ],
        },
      });
      while (providerSocket.sent.length < 3) await new Promise(r => setTimeout(r, 10));

      const canvasItems = await items();
      expect(canvasItems.map((i) => i.title)).toContain("Spoken Note");

      // 3. rename_item
      providerSocket.emit({
        toolCall: {
          functionCalls: [
            {
              id: "call-rename",
              name: "rename_item",
              args: { item_ref: "Spoken Note", title: "Spoken Note Renamed" },
            },
          ],
        },
      });
      while (providerSocket.sent.length < 4) await new Promise(r => setTimeout(r, 10));

      const renamedItems = await items();
      expect(renamedItems.map((i) => i.title)).toContain("Spoken Note Renamed");

      // 4. Assert /log
      const logRes = (await (await fetch(`${server.state.url}log`)).json()) as any;
      expect(logRes.entries.length).toBeGreaterThanOrEqual(3);

      const readLog = logRes.entries.find((e: any) => e.name === "read_canvas");
      expect(readLog).toBeDefined();
      expect(readLog.result.ok).toBe(true);

      const addLog = logRes.entries.find((e: any) => e.name === "add_item");
      expect(addLog).toBeDefined();
      expect(addLog.result.ok).toBe(true);
      expect(addLog.op.type).toBe("item.add");

      const renameLog = logRes.entries.find((e: any) => e.name === "rename_item");
      expect(renameLog).toBeDefined();
      expect(renameLog.result.ok).toBe(true);
      expect(renameLog.op.type).toBe("item.update");

      clientWs.close();
    } finally {
      await server.close();
    }
  });

  it("exercises Paul's five tools: draw, react, comment, delete, and find — each landing on canvas and appearing in /log", async () => {
    await writeVoiceKey(home, { provider: "gemini", key: "AIza-live-test" });

    let providerSocket!: {
      emit: (message: unknown) => void;
      sent: string[];
    };
    class FakeLiveSocket {
      readyState = 1;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor(readonly url: string) {
        providerSocket = this;
        queueMicrotask(() => this.onopen?.());
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {}
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) });
      }
    }

    const server = await startVoiceServer({
      home,
      port: 0,
      identity: { session: "Voice", harness: "agent" },
      canvas: "prj_1",
      daemonPort: Number(new URL(base).port),
      WebSocketImpl: FakeLiveSocket as unknown as typeof WebSocket,
    });

    try {
      const { WebSocket: WsClient } = await import("ws");
      const clientWs = new WsClient(`${server.state.url.replace("http://", "ws://")}live`);
      await new Promise<void>((resolve) => {
        clientWs.on("open", () => resolve());
      });

      while (!providerSocket) await new Promise((r) => setTimeout(r, 10));
      providerSocket.emit({ setupComplete: {} });
      await new Promise((r) => setTimeout(r, 50));

      // 1. DRAW (drawing_add)
      providerSocket.emit({
        toolCall: {
          functionCalls: [
            {
              id: "call-draw",
              name: "drawing_add",
              args: { title: "Handwritten Arrow", color: "#ff0000", points: [{ x: 50, y: 50 }, { x: 150, y: 150 }] },
            },
          ],
        },
      });
      while (providerSocket.sent.length < 2) await new Promise((r) => setTimeout(r, 10));

      const afterDraw = await items();
      const sketchItem = afterDraw.find((i) => i.title === "Handwritten Arrow");
      expect(sketchItem).toBeDefined();
      expect(sketchItem!.properties?.kind).toBe("drawing");

      // 2. REACT (item_react)
      providerSocket.emit({
        toolCall: {
          functionCalls: [
            {
              id: "call-react",
              name: "item_react",
              args: { item_ref: "Checkout screen", emoji: "👍", on: true },
            },
          ],
        },
      });
      while (providerSocket.sent.length < 3) await new Promise((r) => setTimeout(r, 10));

      const afterReact = await items();
      const reactedItem = afterReact.find((i) => i.title === "Checkout screen");
      expect(reactedItem?.reactions?.["👍"]).toBeDefined();

      // 3. COMMENT (comment_on_item)
      providerSocket.emit({
        toolCall: {
          functionCalls: [
            {
              id: "call-comment",
              name: "comment_on_item",
              args: { item_ref: "Checkout screen", text: "Approved by Voice" },
            },
          ],
        },
      });
      while (providerSocket.sent.length < 4) await new Promise((r) => setTimeout(r, 10));

      // 4. DELETE (delete_item)
      providerSocket.emit({
        toolCall: {
          functionCalls: [
            {
              id: "call-delete",
              name: "delete_item",
              args: { item_ref: "Handwritten Arrow" },
            },
          ],
        },
      });
      while (providerSocket.sent.length < 5) await new Promise((r) => setTimeout(r, 10));

      const afterDelete = await items();
      expect(afterDelete.find((i) => i.title === "Handwritten Arrow")).toBeUndefined();

      // 5. FIND (find_items)
      providerSocket.emit({
        toolCall: {
          functionCalls: [
            {
              id: "call-find",
              name: "find_items",
              args: { query: "Checkout" },
            },
          ],
        },
      });
      while (providerSocket.sent.length < 6) await new Promise((r) => setTimeout(r, 10));

      const findReply = JSON.parse(providerSocket.sent.at(-1) ?? "{}");
      expect(findReply.toolResponse?.functionResponses?.[0].response.count).toBe(1);

      // 6. MULTI-SELECT MOVE (items_move)
      providerSocket.emit({
        toolCall: {
          functionCalls: [
            {
              id: "call-move",
              name: "items_move",
              args: { item_refs: ["Checkout screen"], by_x: 20, by_y: 30 },
            },
          ],
        },
      });
      while (providerSocket.sent.length < 7) await new Promise((r) => setTimeout(r, 10));

      // 7. CONVERGENCE / VERSION SWITCH (item_set_current_version)
      providerSocket.emit({
        toolCall: {
          functionCalls: [
            {
              id: "call-ver",
              name: "item_set_current_version",
              args: { item_ref: "Checkout screen", version_ref: "ver_1" },
            },
          ],
        },
      });
      while (providerSocket.sent.length < 8) await new Promise((r) => setTimeout(r, 10));

      // 8. SELECTION GESTURES (selection_set)
      providerSocket.emit({
        toolCall: {
          functionCalls: [
            {
              id: "call-sel",
              name: "selection_set",
              args: { item_refs: ["Checkout screen"] },
            },
          ],
        },
      });
      while (providerSocket.sent.length < 9) await new Promise((r) => setTimeout(r, 10));

      // 9. DESTRUCTIVE CONFIRMATION GUARD (trash_empty)
      providerSocket.emit({
        toolCall: {
          functionCalls: [
            {
              id: "call-trash",
              name: "trash_empty",
              args: {},
            },
          ],
        },
      });
      while (providerSocket.sent.length < 10) await new Promise((r) => setTimeout(r, 10));
      const trashReply = JSON.parse(providerSocket.sent.at(-1) ?? "{}");
      expect(trashReply.toolResponse?.functionResponses?.[0].response.ok).toBe(false);
      expect(trashReply.toolResponse?.functionResponses?.[0].response.error).toContain("confirmation");

      // 10. REFUSED READ_THREADS LOGGING (nonexistent item_ref)
      providerSocket.emit({
        toolCall: {
          functionCalls: [
            {
              id: "call-threads-fail",
              name: "read_threads",
              args: { item_ref: "nonexistent_item_ref" },
            },
          ],
        },
      });
      while (providerSocket.sent.length < 11) await new Promise((r) => setTimeout(r, 10));
      const threadFailReply = JSON.parse(providerSocket.sent.at(-1) ?? "{}");
      expect(threadFailReply.toolResponse?.functionResponses?.[0].response.ok).toBe(false);

      // Verify /log entries
      const logRes = (await (await fetch(`${server.state.url}log`)).json()) as any;
      expect(logRes.entries.find((e: any) => e.name === "drawing_add")).toBeDefined();
      expect(logRes.entries.find((e: any) => e.name === "item_react")).toBeDefined();
      expect(logRes.entries.find((e: any) => e.name === "comment_on_item")).toBeDefined();
      expect(logRes.entries.find((e: any) => e.name === "delete_item")).toBeDefined();
      expect(logRes.entries.find((e: any) => e.name === "find_items")).toBeDefined();
      expect(logRes.entries.find((e: any) => e.name === "items_move")).toBeDefined();
      expect(logRes.entries.find((e: any) => e.name === "item_set_current_version")).toBeDefined();
      expect(logRes.entries.find((e: any) => e.name === "selection_set")).toBeDefined();
      expect(logRes.entries.find((e: any) => e.name === "trash_empty")).toBeDefined();
      const threadFailLog = logRes.entries.find((e: any) => e.name === "read_threads" && e.result?.ok === false);
      expect(threadFailLog).toBeDefined();
      expect(threadFailLog.result.error).toContain("nonexistent_item_ref");

      clientWs.close();
    } finally {
      await server.close();
    }
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

describe("the harness session & tool-call log API", () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function serve() {
    const server = await startVoiceServer({
      home,
      port: 0,
      identity: { session: "Voice", harness: "agent" },
      canvas: "prj_1",
      daemonPort: Number(new URL(base).port),
    });
    close = server.close;
    return server;
  }

  it("exposes session state and transitions through /session/start, /session/mute, /session/unmute, /session/end", async () => {
    const server = await serve();
    const state0 = await (await fetch(`${server.state.url}state`)).json();
    expect(state0).toMatchObject({ session: { state: "idle" } });

    const startRes = await (await fetch(`${server.state.url}session/start`, { method: "POST" })).json();
    expect(startRes).toEqual({ ok: true, state: "live" });

    const state1 = (await (await fetch(`${server.state.url}state`)).json()) as any;
    expect(state1.session.state).toBe("live");

    const muteRes = await (await fetch(`${server.state.url}session/mute`, { method: "POST" })).json();
    expect(muteRes).toEqual({ ok: true, state: "muted" });

    const unmuteRes = await (await fetch(`${server.state.url}session/unmute`, { method: "POST" })).json();
    expect(unmuteRes).toEqual({ ok: true, state: "live" });

    const endRes = await (await fetch(`${server.state.url}session/end`, { method: "POST" })).json();
    expect(endRes).toEqual({ ok: true, state: "ended" });
  });

  it("logs tool calls, utterances, and session events in machine-readable GET /log", async () => {
    const server = await serve();

    // Trigger an utterance
    await fetch(`${server.state.url}utterance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "retitle the first thing to Logged Title", source: "test" }),
    });

    // Check /log
    const logRes = (await (await fetch(`${server.state.url}log`)).json()) as any;
    expect(logRes).toHaveProperty("entries");
    expect(logRes.entries.length).toBeGreaterThan(0);

    const uttLog = logRes.entries.find((e: any) => e.type === "utterance");
    expect(uttLog).toBeDefined();
    expect(uttLog.source).toBe("typed");
    expect(uttLog.args.text).toBe("retitle the first thing to Logged Title");
    expect(uttLog.op.type).toBe("item.update");
    expect(uttLog.result.ok).toBe(true);
  });

  it("handles typed 'add a note' utterances through the same operation vocabulary and logs with source: typed", async () => {
    const server = await serve();

    const res = (await (await fetch(`${server.state.url}utterance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "add a note that says hello from the voice log", source: "typed" }),
    })).json()) as any;

    expect(res.sent.length).toBe(1);
    expect(res.sent[0]).toContain("hello from the voice log");

    const canvasItems = await items();
    expect(canvasItems.some((i) => i.title?.includes("hello from the voice log"))).toBe(true);

    const logRes = (await (await fetch(`${server.state.url}log`)).json()) as any;
    const addLog = logRes.entries.find((e: any) => e.args?.text?.includes("hello from the voice log"));
    expect(addLog).toBeDefined();
    expect(addLog.source).toBe("typed");
    expect(addLog.op.type).toBe("item.add");
  });

  it("persists toolLog to ~/.isocan/voice/log.json so it survives harness restarts", async () => {
    const server1 = await serve();

    await fetch(`${server1.state.url}utterance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "say persist this message", source: "typed" }),
    });

    // Close server1
    await server1.close();
    close = null;

    // Start server2 on same home
    const server2 = await serve();

    const logRes = (await (await fetch(`${server2.state.url}log`)).json()) as any;
    const persistedEntry = logRes.entries.find((e: any) => e.args?.text === "say persist this message");
    expect(persistedEntry).toBeDefined();
  });

  it("mints a one-use pass and redirects to the canvas URL on GET /open", async () => {
    const server = await serve();

    // 1. JSON mode
    const jsonRes = (await (await fetch(`${server.state.url}open`, {
      headers: { Accept: "application/json" },
    })).json()) as any;
    expect(jsonRes).toHaveProperty("url");
    expect(jsonRes.canvasId).toBe("prj_1");
    expect(jsonRes.url).toContain("/p/prj_1#pss_");

    // 2. Redirect mode (manual redirect inspection)
    const redirectRes = await fetch(`${server.state.url}open`, { redirect: "manual" });
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.get("location")).toContain("/p/prj_1#pss_");
  });

  it("publishes enrolled-but-idle presence at start and switches to listening while live", async () => {
    const server = await serve();
    await new Promise((r) => setTimeout(r, 100));

    // Initially present as enrolled-but-idle
    const sessions0 = await (await fetch(`${base}/api/projects/prj_1/sessions`, { headers: badge.headers })).json() as any[];
    const voiceSession0 = sessions0.find((s) => s.harness === "voice");
    expect(voiceSession0).toBeDefined();
    expect(voiceSession0!.status).toBe("enrolled — nobody is listening right now");

    // Start session -> switches to listening
    await fetch(`${server.state.url}session/start`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 50));

    const sessions1 = await (await fetch(`${base}/api/projects/prj_1/sessions`, { headers: badge.headers })).json() as any[];
    const voiceSession1 = sessions1.find((s) => s.harness === "voice");
    expect(voiceSession1!.status).toBe("listening");

    // End session -> drops back
    await fetch(`${server.state.url}session/end`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 50));

    const sessions2 = await (await fetch(`${base}/api/projects/prj_1/sessions`, { headers: badge.headers })).json() as any[];
    const voiceSession2 = sessions2.find((s) => s.harness === "voice");
    expect(voiceSession2!.status).toBe("enrolled — nobody is listening right now");
  });
});

describe("responsive layout and bounding-box isolation", () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await close?.();
    close = null;
  });

  for (const width of [1440, 420]) {
    it(`guarantees zero panel overlaps and zero text overflow at ${width}px`, async () => {
      const server = await startVoiceServer({
        home,
        port: 0,
        identity: { session: "Voice", harness: "agent" },
        canvas: "prj_1",
        daemonPort: Number(new URL(base).port),
      });
      close = server.close;

      // @ts-expect-error - JS helper module
      const { browser } = await import("../../../scripts/lib/browser.mjs");
      const b = await browser({
        flags: [
          `--window-size=${width},900`,
          "--use-fake-device-for-media-stream",
          "--use-fake-ui-for-media-stream",
          "--autoplay-policy=no-user-gesture-required",
        ],
      });

      try {
        const loaded = b.once("Page.loadEventFired");
        await b.send("Page.navigate", { url: server.state.url });
        await loaded;
        await b.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: width <= 500,
        });
        await new Promise((r) => setTimeout(r, 300));

        // 1. Document width <= viewport width + 1
        const docWidth = Number(await b.ev(`document.documentElement.scrollWidth`));
        expect(docWidth).toBeLessThanOrEqual(width + 1);

        // 2. Zero pairwise bounding-box intersection between panels
        const overlaps = ((await b.ev(`(() => {
          const boxes = [...document.querySelectorAll("aside .panel, main > .panel, main > .composer, main > .dock")]
            .map((el) => ({ el, r: el.getBoundingClientRect() }));
          const hits = [];
          for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
              const a = boxes[i].r, b = boxes[j].r;
              const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              if (x > 2 && y > 2) {
                hits.push((boxes[i].el.querySelector("h2")?.textContent || boxes[i].el.className || boxes[i].el.id) + " overlaps " +
                          (boxes[j].el.querySelector("h2")?.textContent || boxes[j].el.className || boxes[j].el.id) +
                          " by " + Math.round(x) + "x" + Math.round(y) + "px");
              }
            }
          }
          return hits;
        })()`)) as string[]) ?? [];
        expect(overlaps, `Overlapping panels at ${width}px: ${overlaps.join("; ")}`).toEqual([]);

        // 3. scrollWidth <= clientWidth + 1 for every text element
        const overflows = ((await b.ev(`(() => {
          const elements = [...document.querySelectorAll("body *")];
          const offenders = [];
          for (const el of elements) {
            if (el.scrollWidth > el.clientWidth + 1) {
              const style = window.getComputedStyle(el);
              if (style.overflowX !== "auto" && style.overflowX !== "scroll") {
                offenders.push(
                  (el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ").join(".") : "")) +
                  " scrollWidth=" + el.scrollWidth + " > clientWidth=" + el.clientWidth +
                  " text=" + JSON.stringify((el.textContent || "").trim().slice(0, 30))
                );
              }
            }
          }
          return offenders;
        })()`)) as string[]) ?? [];
        expect(overflows, `Text overflow at ${width}px: ${overflows.join("; ")}`).toEqual([]);
      } finally {
        await b.close();
      }
    });
  }
});
