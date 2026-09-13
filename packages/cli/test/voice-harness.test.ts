import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon, type Daemon } from "@isocan/server";
import { harnessVars } from "@isocan/api";
import { readRcAgents } from "../src/rc.ts";
import { shelvePatch } from "@isocan/core";
import { mintTestBadge, type TestBadge } from "./badge.ts";
import {
  DEFAULT_VOICE_PORT,
  LIVE_MODEL,
  describeMintedOp,
  liveSetup,
  liveUrl,
  planForCall,
  resolveLivePlans,
  startLiveSession,
  createAcpAgent,
  planVoice,
  readVoiceKey,
  readVoiceLog,
  resolveSpokenRef,
  startVoiceServer,
  voiceKeyFile,
  writeVoiceKey,
  writeVoiceLog,
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
async function log(ids: string[] = ["prj_1"]): Promise<{ type: string; actor: string }[]> {
  const res = await fetch(`${base}/api/oplog/watch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...badge.headers },
    body: JSON.stringify({
      cursors: Object.fromEntries(ids.map((id) => [id, 0])),
      only: ids,
      waitMs: 0,
    }),
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

/** The question the harness is holding, read the way the page reads it — off
 * `/state`, which is the only route a tab that missed the socket has. */
async function theQuestion(baseUrl: string): Promise<{ id: string; what: string }> {
  const deadline = Date.now() + 5000;
  let last = "";
  while (Date.now() < deadline) {
    const s = (await (await fetch(`${baseUrl}state`)).json()) as { confirm?: { id: string; what: string } | null };
    if (s.confirm) return s.confirm;
    last = JSON.stringify(s).slice(0, 400);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`the harness never asked the person; last state: ${last}`);
}

/** The person's click, in HTTP form: what the page posts, and the only thing
 * that opens the gate. */
async function answering(baseUrl: string, id: string, allow: boolean): Promise<{ ok: boolean; allowed?: boolean }> {
  const r = await fetch(`${baseUrl}confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, allow }),
  });
  return (await r.json()) as { ok: boolean; allowed?: boolean };
}

async function utterance(baseUrl: string, text: string): Promise<{ sent: string[]; failed: string[]; reply: string; state: string }> {
  const r = await fetch(`${baseUrl}utterance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, source: "typed" }),
  });
  return (await r.json()) as { sent: string[]; failed: string[]; reply: string; state: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * **A live session on a fake provider socket** — the shape every tool call in
 * this file arrives through — plus the two handles a person has: the page and
 * the canvas.
 */
async function liveServer() {
  await writeVoiceKey(home, { provider: "gemini", key: "AIza-live-test" });
  let providerSocket!: { emit: (message: unknown) => void; sent: string[] };
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
    // A gate nobody answers must not hold a test for a minute.
    confirmTimeoutMs: 2000,
    WebSocketImpl: FakeLiveSocket as unknown as typeof WebSocket,
  });
  const { WebSocket: WsClient } = await import("ws");
  const clientWs = new WsClient(`${server.state.url.replace("http://", "ws://")}live`);
  await new Promise<void>((resolve) => clientWs.on("open", () => resolve()));
  /** Everything the page is told on its live socket, in order. */
  const toPage: any[] = [];
  clientWs.on("message", (data: unknown) => {
    try {
      toPage.push(JSON.parse(String(data)));
    } catch {
      // binary audio
    }
  });
  while (!providerSocket) await sleep(10);
  providerSocket.emit({ setupComplete: {} });
  await sleep(50);
  return {
    server,
    providerSocket,
    toPage,
    close: async () => {
      clientWs.close();
      await server.close();
    },
  };
}

/**
 * **A fresh `isocan voice`, the way a person (or the rc) starts one** — the
 * real verb, in a real process, on a free port. It stands until it is killed,
 * so this waits for the line that says it is listening (or for it to exit with
 * a refusal), reads `/state` back, and stops it.
 *
 * The subject is the NAME it claims, not the audio: a restart is where a
 * rename either survives or is quietly undone.
 */
async function startFreshVoice(env: Record<string, string>): Promise<{
  started: boolean;
  state: { name: string; agent: { id: string; name: string }; canvas: { id: string; title: string } } | null;
  said: string;
}> {
  const port = 9000 + Math.floor(Math.random() * 900);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ISOCAN_HARNESS: "agent" };
  for (const name of harnessVars) delete childEnv[name];
  const child = spawn(process.execPath, [cliBin, "voice", "--voice-port", String(port)], {
    env: { ...childEnv, ISOCAN_HOME: home, ISOCAN_PORT: new URL(base).port, ...env },
    cwd: home,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk) => (said += chunk));
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk) => (said += chunk));
  let url: string | null = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const found = said.match(/talk at (http:\/\/127\.0\.0\.1:\d+\/)/);
    if (found) {
      url = found[1]!;
      break;
    }
    if (child.exitCode !== null) break;
    await sleep(50);
  }
  let state: { name: string; agent: { id: string; name: string }; canvas: { id: string; title: string } } | null = null;
  if (url) {
    // The page and a check read the same three facts; this is the machine
    // readable door.
    for (let i = 0; i < 100 && !state; i++) {
      state = (await fetch(`${url}state`).then((r) => r.json()).catch(() => null)) as typeof state;
      if (!state) await sleep(50);
    }
  }
  child.kill("SIGTERM");
  await sleep(200);
  child.kill("SIGKILL");
  await sleep(50);
  return { started: url !== null, state, said };
}

/**
 * The model's call, answered. Started without awaiting when the person has to
 * answer first, and then awaited — the tool response only arrives after the
 * gate opens.
 */
async function callTool(
  socket: { emit: (message: unknown) => void; sent: string[] },
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ id: string; response: any }> {
  const before = socket.sent.length;
  socket.emit({ toolCall: { functionCalls: [{ id, name, args }] } });
  const deadline = Date.now() + 8000;
  while (socket.sent.length <= before && Date.now() < deadline) await sleep(10);
  const reply = JSON.parse(socket.sent.at(-1) ?? "{}");
  return reply.toolResponse?.functionResponses?.[0];
}

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
      type: "thread.create",
      itemId: "itm_1",
      body: "the padding is wrong",
    });
  });

  it("answers a question about the canvas instead of inventing an operation", () => {
    const out = planVoice("what is on this canvas?", { items: [item("Checkout screen", "itm_1")], mainThreadId: null });
    expect(out.plans).toEqual([]);
    expect(out.what).toContain("Checkout screen");
  });

  it("derives a call's label from the operation and its arguments, never from the tool's name", () => {
    // Paul's log: an update that changed a description was labelled "renamed".
    const { plans } = planForCall("update_item", { item_ref: "Hello Dion", description: "Hello Dion again" });
    const { ready, refused } = resolveLivePlans(plans, [item("Hello Dion", "itm_dion")]);
    expect(refused).toEqual([]);
    expect(ready[0]!.op).toMatchObject({ type: "item.update", itemId: "itm_dion", description: "Hello Dion again" });
    expect(ready[0]!.said).toBe('update "Hello Dion": new description');
    expect(ready[0]!.said).not.toMatch(/renam/i);

    const titled = resolveLivePlans(
      planForCall("update_item", { item_ref: "Hello Dion", title: "Checkout v2" }).plans,
      [item("Hello Dion", "itm_dion")],
    );
    expect(titled.ready[0]!.said).toBe('update "Hello Dion": new title "Checkout v2"');
  });

  it("labels a reference nobody can resolve as a failure under the operation's own name", () => {
    // Paul's log: a call that could not find "Paul" still carried "renamed Paul".
    const { plans } = planForCall("update_item", { item_ref: "Paul", title: "Paul" });
    const { ready, refused } = resolveLivePlans(plans, [item("Hello Dion", "itm_dion")]);
    expect(ready).toEqual([]);
    expect(refused).toEqual([
      { type: "item.update", said: "could not resolve “Paul”", message: "item.update failed — could not resolve “Paul”" },
    ]);
  });

  it("phrases labels as actions, because the outcome has not happened yet", () => {
    expect(describeMintedOp({ type: "item.delete", itemId: "itm_1" }, "Checkout screen")).toBe('delete "Checkout screen"');
    expect(describeMintedOp({ type: "item.add", title: "Site" })).toBe('add "Site"');
    expect(describeMintedOp({ type: "item.move", x: 10, y: 20 }, "Note")).toBe('move "Note" to 10, 20');
  });

  it("turns a URL into an ordinary item.add whose blob is a text/uri-list", () => {
    const { plans } = planForCall("add_item", { url: "localhost:3000" });
    expect(plans[0]!.op).toMatchObject({
      type: "item.add",
      title: "localhost:3000",
      text: "http://localhost:3000/\n",
      mime: "text/uri-list",
    });
    const { ready } = resolveLivePlans(plans, []);
    expect(ready[0]!.said).toBe('add "localhost:3000" as a web page');
  });

  it("refuses a url that is not a web address instead of adding an empty note", () => {
    const { plans, what } = planForCall("add_item", { url: "not a url" });
    expect(plans).toEqual([]);
    expect(what).toContain("not a web address");
  });

  it("plans the command surface as the engine's own operations", () => {
    const items = [item("Checkout screen", "itm_1")];
    const version = resolveLivePlans(planForCall("item_add_version", { item_ref: "Checkout", content: "v2" }).plans, items);
    expect(version.ready[0]!.op).toMatchObject({ type: "item.addVersion", itemId: "itm_1", body: "v2" });
    expect(version.ready[0]!.said).toBe('add a version to "Checkout screen"');

    const thread = resolveLivePlans(planForCall("thread_create", { item_ref: "Checkout", body: "let's talk" }).plans, items);
    expect(thread.ready[0]!.op).toMatchObject({ type: "thread.create", itemId: "itm_1", body: "let's talk" });

    const main = planForCall("thread_set_main", { thread_id: "thr_1" });
    expect(main.plans[0]!.op).toMatchObject({ type: "thread.setMain", threadId: "thr_1" });

    const edit = planForCall("comment_update", { thread_id: "thr_1", comment_id: "cmt_1", body: "fixed" });
    expect(edit.plans[0]!.op).toMatchObject({ type: "comment.update", threadId: "thr_1", commentId: "cmt_1", body: "fixed" });

    expect(planForCall("notify", { text: "shipping" }).plans[0]!.op).toMatchObject({ type: "thread.reply", body: "shipping", notify: true });
    expect(planForCall("actor_set_color", { color: "#00ff00" }).plans[0]!.op).toMatchObject({ type: "actor.setColor", color: "#00ff00" });
    expect(planForCall("actor_set_mark", { mark: "🦊" }).plans[0]!.op).toMatchObject({ type: "actor.setMark", mark: "🦊" });
    expect(planForCall("agent_enroll", { actor_id: "usr_2", name: "Codex" }).plans[0]!.op).toMatchObject({
      type: "agent.enroll",
      actorId: "usr_2",
      agentName: "Codex",
    });
    expect(planForCall("agent_withdraw", { actor_id: "usr_2" }).plans[0]!.op).toMatchObject({ type: "agent.withdraw", actorId: "usr_2" });
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

  it("never refuses a key: any non-empty string is stored, and the provider judges", async () => {
    // "hunter2" is not a key shape at all, and it is still stored. This used
    // to be a client-side refusal — a guess about a key format, failing closed
    // on a real key before anything had sent it.
    expect(await writeVoiceKey(home, { provider: "gemini", key: "hunter2" })).toBe(voiceKeyFile(home));
    expect(await readVoiceKey(home)).toEqual({ provider: "gemini", key: "hunter2" });
    // A key that LOOKS like another provider's is not special: there is one
    // provider, and it is the judge.
    expect(await writeVoiceKey(home, { provider: "gemini", key: "sk-looks-like-openai" })).toBe(voiceKeyFile(home));
    expect(await readVoiceKey(home)).toEqual({ provider: "gemini", key: "sk-looks-like-openai" });
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

describe("the person's gate", () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await close?.();
    close = null;
  });

  /** The same server, with the window short: a test cannot wait a minute for
   * a question nobody is going to answer. */
  async function serve() {
    const server = await startVoiceServer({
      home,
      port: 0,
      identity: { session: "Voice", harness: "agent" },
      canvas: "prj_1",
      daemonPort: Number(new URL(base).port),
      confirmTimeoutMs: 700,
    });
    close = server.close;
    return server;
  }

  it("holds a typed delete until the person answers: a yes sends it, a no does not", async () => {
    const server = await serve();

    // The no. The question is asked, and asking is not doing: the item is
    // still on the canvas while it stands.
    const deniedRun = utterance(server.state.url, "delete the Checkout screen");
    const deniedAsk = await theQuestion(server.state.url);
    expect(deniedAsk.what).toContain("Checkout screen");
    expect((await items()).map((i) => i.title)).toContain("Checkout screen");
    expect(await answering(server.state.url, deniedAsk.id, false)).toEqual({ ok: true, allowed: false });

    const denied = await deniedRun;
    expect(denied.state).toBe("refused");
    expect(denied.sent).toEqual([]);
    expect((await items()).map((i) => i.title)).toContain("Checkout screen");
    expect((await log()).some((e) => e.type === "item.delete")).toBe(false);

    // The yes, on the same sentence — the person is the difference.
    const allowedRun = utterance(server.state.url, "delete the Checkout screen");
    const allowedAsk = await theQuestion(server.state.url);
    expect(allowedAsk.id).not.toBe(deniedAsk.id);
    expect(await answering(server.state.url, allowedAsk.id, true)).toEqual({ ok: true, allowed: true });

    const allowed = await allowedRun;
    expect(allowed.failed).toEqual([]);
    expect((await items()).map((i) => i.title)).not.toContain("Checkout screen");
    expect((await log()).at(-1)!.type).toBe("item.delete");

    // Both answers are in the record, with the question they answered — which
    // is the only thing that can say, a week later, whether it asked first.
    const entries = ((await (await fetch(`${server.state.url}log`)).json()) as { entries: any[] }).entries;
    expect(entries.some((e) => e.details?.kind === "confirm_requested")).toBe(true);
    expect(entries.some((e) => e.details?.kind === "confirm_declined")).toBe(true);
    expect(entries.some((e) => e.details?.kind === "confirm_allowed")).toBe(true);
  });

  it("reads no answer as a no, and says so rather than pretending it happened", async () => {
    const server = await serve();
    const run = utterance(server.state.url, "delete the Checkout screen");
    await theQuestion(server.state.url);

    const out = await run;
    expect(out.state).toBe("refused");
    expect(out.reply).toContain("did not confirm");
    expect((await items()).map((i) => i.title)).toContain("Checkout screen");

    const entries = ((await (await fetch(`${server.state.url}log`)).json()) as { entries: any[] }).entries;
    const expired = entries.find((e) => e.reason === "no answer");
    expect(expired, "the expiry is in the log, with its reason").toBeDefined();
    // And the question is gone: a stale question on the page is a person
    // answering something that already happened.
    const state = (await (await fetch(`${server.state.url}state`)).json()) as { confirm: unknown };
    expect(state.confirm).toBeNull();
  });

  it("answers an answer that is not the question being asked", async () => {
    const server = await serve();
    const run = utterance(server.state.url, "delete the Checkout screen");
    const ask = await theQuestion(server.state.url);

    const stale = await answering(server.state.url, "cfm_not_the_one", true);
    expect(stale.ok).toBe(false);
    expect(await answering(server.state.url, ask.id, false)).toEqual({ ok: true, allowed: false });
    await run;
  });

  it("asks on the page with buttons a person can press, and posts the answer nowhere else", async () => {
    const server = await serve();
    const page = await (await fetch(server.state.url)).text();
    expect(page).toContain('id="confirm"');
    expect(page).toContain('id="confirm-what"');
    expect(page).toContain("Yes, do it");
    expect(page).toContain('post("/confirm"');
    // A question asked while the tab was closed still finds it: the poll reads
    // it off /state, which the socket-less typed path never announces on.
    expect(page).toContain("showConfirm(s.confirm || null)");
  });
});

describe("what an agent is called", () => {


  async function canvasNames(): Promise<Record<string, string>> {
    const res = await fetch(`${base}/api/projects/prj_1/canvas`, { headers: badge.headers });
    return ((await res.json()) as { names?: Record<string, string> }).names ?? {};
  }

  /** The identity ledger on disk — the home's own record of who a name
   * belongs to, which is the half a canvas view cannot show. */
  async function nameRows(): Promise<Record<string, { name: string }>> {
    const raw = JSON.parse(await fs.readFile(path.join(home, "actors.json"), "utf8")) as {
      names?: Record<string, { name: string }>;
    };
    return raw.names ?? {};
  }

  it("renames in place when the person names it, and the canvas, the ledger and the face follow", async () => {
    const live = await liveServer();
    try {
      const before = ((await (await fetch(`${live.server.state.url}state`)).json()) as any).agent as {
        id: string;
        name: string;
      };
      expect(before.name).toBe("Voice");
      expect((await canvasNames())[before.id]).toBe("Voice");

      // The model proposes; the person answers. Nothing has moved yet.
      const call = callTool(live.providerSocket, "call-name", "actor_claim", { name: "Nova" });
      const ask = await theQuestion(live.server.state.url);
      expect(ask.what).toContain("Nova");
      expect(ask.what).toContain("Voice");
      expect((await canvasNames())[before.id], "the name is the person's to give").toBe("Voice");

      expect(await answering(live.server.state.url, ask.id, true)).toEqual({ ok: true, allowed: true });
      const answered = await call;
      expect(answered.response.ok).toBe(true);

      // In place: the same actor, so every op it ever wrote is still its own.
      expect(answered.response.actor.id).toBe(before.id);
      expect(answered.response.actor.name).toBe("Nova");
      expect((await canvasNames())[before.id]).toBe("Nova");

      // The home's ledger, and the harness's own account of itself.
      expect((await nameRows())[before.id]!.name).toBe("Nova");
      const state = (await (await fetch(`${live.server.state.url}state`)).json()) as any;
      expect(state.name).toBe("Nova");
      expect(state.agent.id).toBe(before.id);

      // The face the canvas shows is re-worn, not left with the old name on it.
      const sessions = (await (
        await fetch(`${base}/api/projects/prj_1/sessions`, { headers: badge.headers })
      ).json()) as { actor: { id: string }; label?: string; name?: string }[];
      expect(sessions.some((s) => s.actor.id === before.id && (s.label ?? s.name) === "Nova")).toBe(true);
      expect(sessions.some((s) => s.actor.id === before.id && (s.label ?? s.name) === "Voice")).toBe(false);

      // And /log says a claim was made, named.
      const entries = ((await (await fetch(`${live.server.state.url}log`)).json()) as any).entries as any[];
      const claim = entries.find((e) => e.op?.type === "actor.claim" && e.result?.ok === true);
      expect(claim, "the claim is in the harness's own record").toBeDefined();
      expect(claim.op.said).toContain("Nova");
    } finally {
      await live.close();
    }
  });

  it("changes nothing when the person refuses, and says whose name it is when the daemon refuses", async () => {
    const live = await liveServer();
    try {
      const before = ((await (await fetch(`${live.server.state.url}state`)).json()) as any).agent as {
        id: string;
        name: string;
      };

      // The person says no: the model does not get to name itself.
      const declined = callTool(live.providerSocket, "call-declined", "actor_claim", { name: "Helper" });
      const firstAsk = await theQuestion(live.server.state.url);
      await answering(live.server.state.url, firstAsk.id, false);
      const refused = await declined;
      expect(refused.response.ok).toBe(false);
      expect(refused.response.error).toContain("did not confirm");
      expect((await nameRows())[before.id]!.name).toBe("Voice");

      // The person says yes to a name somebody on this canvas already answers
      // to: the daemon refuses, in its own words, and the refusal is shown.
      const taken = callTool(live.providerSocket, "call-taken", "actor_claim", { name: "Seeder" });
      const secondAsk = await theQuestion(live.server.state.url);
      await answering(live.server.state.url, secondAsk.id, true);
      const clash = await taken;
      expect(clash.response.ok).toBe(false);
      expect(clash.response.error).toContain("not renamed");
      expect(clash.response.error).toContain("Seeder");
      expect((await nameRows())[before.id]!.name).toBe("Voice");
      expect((await canvasNames())[before.id]).toBe("Voice");
    } finally {
      await live.close();
    }
  });
});

describe("the projects this session can work on", () => {


  it("makes a canvas the person asked for, and leaves the session where it was", async () => {
    const live = await liveServer();
    try {
      const made = await callTool(live.providerSocket, "call-create", "project_create", {
        title: "Launch plan",
        description: "the redesign",
      });
      expect(made.response.ok).toBe(true);
      const canvasId = made.response.canvas.id as string;
      expect(canvasId).toMatch(/^prj_/);

      // The home lists it, and its own log holds its birth — the same
      // `project.create` `isocan canvas create` sends, sent as this agent.
      const canvases = (await (await fetch(`${base}/api/projects`, { headers: badge.headers })).json()) as {
        id: string;
        title: string;
      }[];
      expect(canvases.find((c) => c.id === canvasId)?.title).toBe("Launch plan");
      const born = (await log([canvasId])).find((e) => e.type === "project.create");
      expect(born, "a new canvas's log starts with its own birth").toBeDefined();
      expect(born!.actor).not.toBe(seeder.id);

      // Created, not entered: the session is still on the canvas it was on,
      // because nothing was switched and the answer says so.
      const state = (await (await fetch(`${live.server.state.url}state`)).json()) as any;
      expect(state.canvas.id).toBe("prj_1");
      expect(made.response.answer).toContain("still on");

      // A canvas with no name is refused rather than made blank.
      const blank = await callTool(live.providerSocket, "call-blank", "project_create", { title: "   " });
      expect(blank.response.ok).toBe(false);
      expect(blank.response.error).toContain("title");

      const entries = ((await (await fetch(`${live.server.state.url}log`)).json()) as any).entries as any[];
      const row = entries.find((e) => e.name === "project_create" && e.result?.ok === true);
      expect(row.op.type).toBe("project.create");
      expect(row.result.canvasId).toBe(canvasId);
    } finally {
      await live.close();
    }
  });

  it("the whole walk in one sitting: create a canvas, list it, switch to it, speak a command", async () => {
    const live = await liveServer();
    try {
      // 1. A canvas, from a sentence the person said.
      const made = await callTool(live.providerSocket, "walk-create", "project_create", { title: "Winter work" });
      expect(made.response.ok).toBe(true);
      const winter = made.response.canvas.id as string;

      // 2. Where the session is, and what else there is.
      const listed = await callTool(live.providerSocket, "walk-list", "project_list");
      expect(listed.response.current).toBe("prj_1");
      expect((listed.response.canvases as { title: string }[]).map((c) => c.title)).toContain("Winter work");

      // 3. Move there — and the harness's own account of itself moves.
      const moved = await callTool(live.providerSocket, "walk-switch", "project_switch", { canvas_ref: "Winter work" });
      expect(moved.response.canvas).toEqual({ id: winter, title: "Winter work" });
      expect(((await (await fetch(`${live.server.state.url}state`)).json()) as any).canvas.id).toBe(winter);

      // 4. A command, spoken after the move. The canvas and the log agree: the
      // operation is in the NEW canvas's oplog, and the harness's /log reads
      // create → switch → add, in that order.
      const spoken = await callTool(live.providerSocket, "walk-say", "add_item", {
        title: "Kick-off notes",
        text: "what the plan says",
      });
      expect(spoken.response.ok).toBe(true);
      expect((await log([winter])).map((e) => e.type)).toEqual(["project.create", "item.add"]);
      expect((await log(["prj_1"])).map((e) => e.type)).toEqual(["project.create", "item.add"]);
      expect(((await (await fetch(`${live.server.state.url}state`)).json()) as any).canvas.id).toBe(winter);

      const entries = ((await (await fetch(`${live.server.state.url}log`)).json()) as any).entries as any[];
      const walked = entries
        .filter((e) => ["project_create", "project_switch", "add_item"].includes(e.name))
        .map((e) => e.name);
      expect(walked).toEqual(["project_create", "project_switch", "add_item"]);
    } finally {
      await live.close();
    }
  });

  it("switches the session to another canvas, and the log, the tool context and the page follow it", async () => {
    await post("/api/ops", {
      canvasId: null,
      actor: seeder,
      op: { type: "project.create", canvasId: "prj_2", title: "Launch plan" },
    });
    await post("/api/ops", {
      canvasId: "prj_2",
      actor: seeder,
      op: {
        type: "item.add",
        itemId: "itm_launch",
        version: { id: "ver_l", blobHash: "h9", mimeType: "text/markdown", filename: "l.md", size: 3 },
        width: 320,
        height: 240,
        placement: { x: 40, y: 40 },
        title: "Launch checklist",
      },
    });

    const live = await liveServer();
    try {
      const before = (await (await fetch(`${live.server.state.url}state`)).json()) as any;
      expect(before.canvas.id).toBe("prj_1");

      const moved = await callTool(live.providerSocket, "call-switch", "project_switch", {
        canvas_ref: "Launch plan",
      });
      expect(moved.response.ok).toBe(true);
      expect(moved.response.canvas).toEqual({ id: "prj_2", title: "Launch plan" });
      expect(moved.response.previous).toEqual({ id: "prj_1", title: "Voice test" });
      // The tool context followed: the answer carries the NEW canvas's items,
      // which is what the model has to work with from here.
      expect(moved.response.items.map((i: { title: string }) => i.title)).toEqual(["Launch checklist"]);
      expect(moved.response.answer).toContain("Every operation from here lands on it");

      // Nothing was minted by the move itself: switching is not a canvas edit.
      expect((await log(["prj_2"])).map((e) => e.type)).toEqual(["project.create", "item.add"]);

      // The harness's own account of itself, and the page's, followed.
      const after = (await (await fetch(`${live.server.state.url}state`)).json()) as any;
      expect(after.canvas).toEqual({ title: "Launch plan", id: "prj_2" });
      expect(live.toPage.some((m) => m.canvas?.id === "prj_2"), "the page is told, not left naming the old room").toBe(
        true,
      );
      // ...and so did the machine-readable file this harness keeps for anyone
      // looking from outside.
      const recorded = JSON.parse(await fs.readFile(path.join(home, "voice", "server.json"), "utf8")) as {
        canvas: string;
      };
      expect(recorded.canvas).toBe("Launch plan");

      // Presence moved rooms: ended on the old canvas, standing on the new.
      const onOld = (await (
        await fetch(`${base}/api/projects/prj_1/sessions`, { headers: badge.headers })
      ).json()) as { actor: { id: string } }[];
      const onNew = (await (
        await fetch(`${base}/api/projects/prj_2/sessions`, { headers: badge.headers })
      ).json()) as { actor: { id: string } }[];
      const me = after.agent.id as string;
      expect(onOld.some((s) => s.actor.id === me), "not still standing in the room it left").toBe(false);
      expect(onNew.some((s) => s.actor.id === me)).toBe(true);

      // Now the point of the whole thing: a command SPOKEN after the switch
      // lands on the new canvas — and shows up in that canvas's log, not the
      // other one.
      const spoken = await callTool(live.providerSocket, "call-add", "add_item", {
        title: "Kick-off notes",
        text: "what the plan says",
      });
      expect(spoken.response.ok).toBe(true);
      expect((await log(["prj_2"])).map((e) => e.type)).toEqual(["project.create", "item.add", "item.add"]);
      expect((await log(["prj_1"])).map((e) => e.type)).toEqual(["project.create", "item.add"]);

      // The harness's /log says the move happened, and to where.
      const entries = ((await (await fetch(`${live.server.state.url}log`)).json()) as any).entries as any[];
      const row = entries.find((e) => e.name === "project_switch" && e.result?.ok === true);
      expect(row.result.canvasId).toBe("prj_2");
      expect(row.result.from).toBe("prj_1");
      expect(row.op, "a move mints no operation").toBeUndefined();

      // Asking for the canvas it is already on is not an error.
      const again = await callTool(live.providerSocket, "call-again", "project_switch", {
        canvas_ref: "prj_2",
      });
      expect(again.response.ok).toBe(true);
      expect(again.response.answer).toContain("already on");

      const nowhere = await callTool(live.providerSocket, "call-nowhere", "project_switch", {
        canvas_ref: "no such project",
      });
      expect(nowhere.response.ok).toBe(false);
      expect(nowhere.response.error).toContain("no canvas matches");
    } finally {
      await live.close();
    }
  });

  it("renames the canvas this session is on, and the page's own account of itself with it", async () => {
    const live = await liveServer();
    try {
      const renamed = await callTool(live.providerSocket, "call-rename-canvas", "project_update", {
        title: "Winter work",
      });
      expect(renamed.response.ok).toBe(true);
      expect(renamed.response.canvas).toEqual({ id: "prj_1", title: "Winter work" });

      const canvases = (await (await fetch(`${base}/api/projects`, { headers: badge.headers })).json()) as {
        id: string;
        title: string;
      }[];
      expect(canvases.find((c) => c.id === "prj_1")?.title).toBe("Winter work");
      expect((await log())[0]!.type).toBe("project.create");
      const last = (await log()).at(-1)!;
      expect(last.type).toBe("project.update");
      expect(last.actor).not.toBe(seeder.id);

      // The harness's own account of itself follows — the header, the facts
      // panel and the tool context all read this one label.
      const state = (await (await fetch(`${live.server.state.url}state`)).json()) as any;
      expect(state.canvas).toEqual({ title: "Winter work", id: "prj_1" });

      const entries = ((await (await fetch(`${live.server.state.url}log`)).json()) as any).entries as any[];
      const row = entries.find((e) => e.name === "project_update" && e.result?.ok === true);
      expect(row.op.type).toBe("project.update");
      expect(row.op.said).toContain("Voice test");
    } finally {
      await live.close();
    }
  });

  it("edits another canvas by name, and refuses a canvas nobody can find or an empty edit", async () => {
    await post("/api/ops", {
      canvasId: null,
      actor: seeder,
      op: { type: "project.create", canvasId: "prj_2", title: "Launch plan" },
    });
    const live = await liveServer();
    try {
      const other = await callTool(live.providerSocket, "call-other", "project_update", {
        canvas_ref: "Launch plan",
        title: "Launch plan v2",
        description: "the redesign",
      });
      expect(other.response.ok).toBe(true);
      const canvases = (await (await fetch(`${base}/api/projects`, { headers: badge.headers })).json()) as {
        id: string;
        title: string;
      }[];
      expect(canvases.find((c) => c.id === "prj_2")?.title).toBe("Launch plan v2");
      // ...and the session did not move to the canvas it edited.
      const state = (await (await fetch(`${live.server.state.url}state`)).json()) as any;
      expect(state.canvas.id).toBe("prj_1");

      const missing = await callTool(live.providerSocket, "call-missing", "project_update", {
        canvas_ref: "nothing like this",
        title: "Nope",
      });
      expect(missing.response.ok).toBe(false);
      expect(missing.response.error).toContain("no canvas matches");

      const empty = await callTool(live.providerSocket, "call-empty", "project_update", {});
      expect(empty.response.ok).toBe(false);
      expect(empty.response.error).toContain("nothing to change");
    } finally {
      await live.close();
    }
  });

  it("lists the canvases a person can work on, marks where the session is, and leaves the shelf out", async () => {
    // A second canvas, and a third put away. The shelf rule is core's
    // (`inScope`), and this is the only place it is checked through the tool.
    await post("/api/ops", {
      canvasId: null,
      actor: seeder,
      op: { type: "project.create", canvasId: "prj_2", title: "Launch plan" },
    });
    await post("/api/ops", {
      canvasId: null,
      actor: seeder,
      op: { type: "project.create", canvasId: "prj_old", title: "Put away" },
    });
    await post("/api/ops", {
      canvasId: "prj_old",
      actor: seeder,
      op: { type: "project.update", patch: shelvePatch(new Date().toISOString()) },
    });

    const live = await liveServer();
    try {
      const listed = await callTool(live.providerSocket, "call-list", "project_list");
      expect(listed.response.ok).toBe(true);
      const titles = (listed.response.canvases as { id: string; title: string }[]).map((c) => c.title);
      expect(titles).toContain("Voice test");
      expect(titles).toContain("Launch plan");
      expect(titles, "a shelved canvas is not in the way").not.toContain("Put away");
      expect(listed.response.current).toBe("prj_1");
      // The model has to be able to NAME one to switch to it, and the id is
      // what every other tool takes.
      expect(listed.response.answer).toContain("[prj_2]");
      expect(listed.response.answer).toContain("(this session is here)");

      const entries = ((await (await fetch(`${live.server.state.url}log`)).json()) as any).entries as any[];
      const row = entries.find((e) => e.name === "project_list");
      expect(row, "a read is a read: nothing was minted").toBeDefined();
      expect(row.op).toBeUndefined();
      expect(row.result.ok).toBe(true);
    } finally {
      await live.close();
    }
  });
});

describe("the name the enrolment summons", () => {
  /**
   * **The state both tests here start from**: the agent enrolled on prj_1, a
   * harness standing, and a rename to Nova that the person allowed at the
   * gate. Built once because the point is what the rename LEFT BEHIND, and two
   * copies of fifty lines of setup would drift.
   */
  async function enrolledAndRenamed() {
    await fs.writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ acpAdapters: { voice: [process.execPath, cliBin, "voice", "--acp"] } }),
    );
    const named = await isocan(["identity", "--name", "Person", "--as", "usr_person", "--session"], {
      ISOCAN_SESSION_ID: "person",
      ISOCAN_HARNESS: "isocan",
    });
    expect(named.code, named.stderr).toBe(0);
    // `--canvas prj_1`: the point-anywhere form, so the enrolment lands in the
    // room the harness stands in rather than in the one a bare temp cwd would
    // have made for itself.
    const enrolled = await isocan(["rc", "add", "Voice", "--harness", "voice", "--dir", home, "--canvas", "prj_1"]);
    expect(enrolled.code, enrolled.stderr).toBe(0);

    const before = await readRcAgents(home);
    const row = before.find((r) => r.name === "Voice")!;
    expect(row, "the enrolment exists before the rename").toBeDefined();
    const beforeSnap = (await (
      await fetch(`${base}/api/projects/prj_1/canvas`, { headers: badge.headers })
    ).json()) as { canvas: { agents?: Record<string, { actor: { id: string; name: string }; rules?: unknown }> } };
    const beforeStanding = Object.values(beforeSnap.canvas.agents ?? {}).find((a) => a.actor.id === row.actorId)!;
    expect(beforeStanding.actor.name).toBe("Voice");

    await writeVoiceKey(home, { provider: "gemini", key: "AIza-live-test" });
    let providerSocket!: { emit: (m: unknown) => void; sent: string[] };
    class FakeLiveSocket {
      readyState = 1;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((e: { data: unknown }) => void) | null = null;
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
      confirmTimeoutMs: 2000,
      WebSocketImpl: FakeLiveSocket as unknown as typeof WebSocket,
    });
    const { WebSocket: WsClient } = await import("ws");
    const clientWs = new WsClient(`${server.state.url.replace("http://", "ws://")}live`);
    await new Promise<void>((r) => clientWs.on("open", () => r()));
    while (!providerSocket) await sleep(10);
    providerSocket.emit({ setupComplete: {} });
    await sleep(50);

    const call = callTool(providerSocket, "enrol-rename", "actor_claim", { name: "Nova" });
    const ask = await theQuestion(server.state.url);
    await answering(server.state.url, ask.id, true);
    const renamedRightNow = await call;

    return {
      server,
      row,
      beforeStanding,
      renamed: renamedRightNow,
      close: async () => {
        clientWs.close();
        await server.close();
      },
    };
  }

  it("moves every copy of the name: the standing, the roster row and the harness's own record", async () => {
    const live = await enrolledAndRenamed();
    const { server, row, beforeStanding } = live;
    try {
      const renamed = live.renamed;
      expect(renamed.response.ok).toBe(true);
      expect(renamed.response.answer, "the answer says what moved").toContain("enrolment");

      // The row moved its LABEL and nothing else: same actor, same harness,
      // same working directory, same place in the file.
      const after = await readRcAgents(home);
      const renamedRow = after.find((r) => r.actorId === row.actorId)!;
      expect(renamedRow.name).toBe("Nova");
      expect(renamedRow.harness).toBe(row.harness);
      expect(renamedRow.cwd).toBe(row.cwd);
      expect(after.filter((r) => r.actorId === row.actorId)).toHaveLength(1);
      expect(after.some((r) => r.name === "Voice"), "no row keeps the old name").toBe(false);

      // The canvas's OWN enrolment record — the copy `rc turn <name>`, the
      // agent tray and `isocan who` read — moved with it, with the actor and
      // the rules untouched.
      const snap = (await (
        await fetch(`${base}/api/projects/prj_1/canvas`, { headers: badge.headers })
      ).json()) as { canvas: { agents?: Record<string, { actor: { id: string; name: string }; rules?: unknown }> } };
      const standing = Object.values(snap.canvas.agents ?? {}).find((a) => a.actor.id === row.actorId)!;
      expect(standing.actor.name, "the standing a summons reads by name").toBe("Nova");
      expect(standing.rules).toEqual(beforeStanding.rules);

      // And this harness's own record of who it is: same id, same key, new name.
      const identity = JSON.parse(
        await fs.readFile(path.join(home, "voice", "identity.json"), "utf8"),
      ) as { actorId: string; sessionKey: string; name: string };
      expect(identity.actorId).toBe(row.actorId);
      expect(identity.name).toBe("Nova");
      expect(identity.sessionKey, "the key is the conversation: a rename does not move it").toBe("agent:Voice");
    } finally {
      await live.close();
    }
  });

  /**
   * **The summons is where a stale name costs the most**: `rc turn <name>` is
   * how anything reaches an agent, and it resolves the name against canvas
   * state, then binds the adapter's session — which used to be the NAME, so a
   * rename made the summon fail with "X is somebody else here".
   */
  it("summons by the new name, presenting the key the agent already holds", async () => {
    const live = await enrolledAndRenamed();
    try {
      const summoned = await isocan([
        "rc",
        "turn",
        "Nova",
        "--canvas",
        "prj_1",
        "look",
        "at",
        "the",
        "checkout",
        "screen",
      ]);
      expect(summoned.code, summoned.stderr).toBe(0);
      const lines = ((await (await fetch(`${live.server.state.url}state`)).json()) as { lines: string[] }).lines.join("\n");
      expect(lines).toContain("summoned by Nova");

      // The old name is a name nothing answers to any more — said plainly,
      // rather than waking a second agent wearing it.
      const byOldName = await isocan(["rc", "turn", "Voice", "--canvas", "prj_1", "hello"]);
      expect(byOldName.code, "the old name must not find the renamed agent").not.toBe(0);
      expect(byOldName.stderr).toContain("no standing agent");
    } finally {
      await live.close();
    }
  });

  /**
   * **Coord's acceptance, in one sitting**: claim an actor, enrol it, rename it
   * by voice through the gate — and then check every surface a person can hear
   * the name from, including a harness that did not exist when the rename
   * happened.
   */
  it("the acceptance walk: claim, enrol, rename by voice, and every surface agrees", async () => {
    const live = await enrolledAndRenamed();
    const actorId = live.row.actorId;
    try {
      const renamed = live.renamed;
      expect(renamed.response.ok).toBe(true);

      // 1. The canvas: the registry's name for that actor id.
      expect((await namesOnCanvas())[actorId]).toBe("Nova");

      // 2. The enrolment, both halves a summon reads.
      const snap = (await (
        await fetch(`${base}/api/projects/prj_1/canvas`, { headers: badge.headers })
      ).json()) as { canvas: { agents?: Record<string, { actor: { id: string; name: string } }> } };
      expect(snap.canvas.agents?.[actorId]?.actor.name).toBe("Nova");
      expect((await readRcAgents(home)).find((r) => r.actorId === actorId)!.name).toBe("Nova");

      // 3. The page's own account of itself.
      const state = (await (await fetch(`${live.server.state.url}state`)).json()) as any;
      expect(state.name).toBe("Nova");
      expect(state.agent.id).toBe(actorId);
      expect(state.agent.name).toBe("Nova");

      // 4. A harness that did not exist when the rename happened — started by
      // the new name, and then by the old one, which must not re-assert it.
      const asNew = await startFreshVoice({ ISOCAN_SESSION_ID: "Nova" });
      expect(asNew.started, `a fresh \`isocan voice\` should start:\n${asNew.said.slice(-400)}`).toBe(true);
      expect(asNew.state!.name).toBe("Nova");
      expect(asNew.state!.agent.id).toBe(actorId);

      const asOld = await startFreshVoice({ ISOCAN_SESSION_ID: "Voice" });
      expect(asOld.started, `a fresh \`isocan voice\` should start:\n${asOld.said.slice(-400)}`).toBe(true);
      expect(asOld.state!.name, "the old name is not asserted back").toBe("Nova");
      expect(asOld.state!.agent.id).toBe(actorId);

      // 5. And one actor, one name: nothing forked and nothing kept the old
      // name as a second face.
      const names = Object.values(await namesOnCanvas());
      expect(names.filter((n) => n === "Nova" || n === "Voice")).toEqual(["Nova"]);
    } finally {
      await live.close();
    }
  });

  /**
   * **The record is a convenience; the badge's row is the truth.** A machine
   * that holds the binding but not `voice/identity.json` — a second machine
   * enrolled in the same actor, or a home whose `voice/` directory was cleared
   * — would rebuild the key from the name it was started with and rename the
   * actor back. So the first-run path resumes too, whenever the key it would
   * claim is a key this badge already holds.
   */
  it("resumes on a machine that holds the row but not the harness's own record", async () => {
    const live = await enrolledAndRenamed();
    const actorId = live.row.actorId;
    try {
      await live.close();
      await fs.rm(path.join(home, "voice", "identity.json"), { force: true });

      const noRecord = await startFreshVoice({ ISOCAN_SESSION_ID: "Voice" });
      expect(noRecord.started, `a fresh \`isocan voice\` should start:\n${noRecord.said.slice(-400)}`).toBe(true);
      expect(noRecord.state!.name, "the binding is enough to resume: no rename back").toBe("Nova");
      expect(noRecord.state!.agent.id).toBe(actorId);
      expect(noRecord.said).toContain("stale");

      // And the record it just wrote is the same identity it resumed.
      const identity = JSON.parse(
        await fs.readFile(path.join(home, "voice", "identity.json"), "utf8"),
      ) as { actorId: string; sessionKey: string; name: string };
      expect(identity).toEqual({ actorId, sessionKey: "agent:Voice", name: "Nova" });
    } finally {
      await live.close();
    }
  });
});

describe("the harness's name across a restart", () => {
  const enrollVoice = async () => {
    const enrolled = await isocan(["rc", "add", "Voice", "--harness", "voice", "--dir", home], {
      ISOCAN_SESSION_ID: "Voice",
      ISOCAN_HARNESS: "agent",
    });
    expect(enrolled.code, enrolled.stderr).toBe(0);
  };

  it("resumes the actor it renamed, rather than re-asserting the name it was started with", async () => {
    await enrollVoice();
    const live = await liveServer();
    let renamedActor = "";
    try {
      const before = ((await (await fetch(`${live.server.state.url}state`)).json()) as any).agent as { id: string; name: string };
      expect(before.name).toBe("Voice");
      renamedActor = before.id;

      // Rename, by voice, through the gate.
      const call = callTool(live.providerSocket, "restart-rename", "actor_claim", { name: "Nova" });
      const ask = await theQuestion(live.server.state.url);
      await answering(live.server.state.url, ask.id, true);
      expect((await call).response.ok).toBe(true);
    } finally {
      await live.close();
    }

    // 1. A fresh start under the NEW name — what a person types, and what a
    // renamed enrolment injects. This was a hard refusal before: the harness
    // rebuilt the key from the name, and `agent:Nova` is a key it never held.
    const asNew = await startFreshVoice({ ISOCAN_SESSION_ID: "Nova" });
    expect(asNew.started, `a fresh \`isocan voice\` should start:\n${asNew.said.slice(-600)}`).toBe(true);
    expect(asNew.state!.name).toBe("Nova");
    expect(asNew.state!.agent.id, "the same actor, not a second one wearing the name").toBe(renamedActor);

    // 2. A fresh start under the OLD name — a stale enrolment, or a shell with
    // the old export. It must resume, not rename back.
    const asOld = await startFreshVoice({ ISOCAN_SESSION_ID: "Voice" });
    expect(asOld.started, `a fresh \`isocan voice\` should start:\n${asOld.said.slice(-600)}`).toBe(true);
    expect(asOld.state!.name, "the old name is not asserted back over the new one").toBe("Nova");
    expect(asOld.state!.agent.id).toBe(renamedActor);
    expect(asOld.said, "and it says whose name is stale, rather than obeying it").toContain("stale");

    // 3. One actor, one name, on the canvas: no fork.
    const names = Object.values(await namesOnCanvas());
    expect(names.filter((n) => n === "Nova" || n === "Voice")).toEqual(["Nova"]);
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

    await fs.rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

    await fs.rm(validDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.rm(staleDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
      // A gate nobody answers must not hold a test for a minute: a short
      // window, exactly as a person would get if they walked away.
      confirmTimeoutMs: 2000,
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

      // The turn boundary, recorded as the provider reported it. Audio that
      // never reached the model produces no turnComplete at all, so this line
      // in /log is the difference between a silent session and a slow one.
      providerSocket.emit({ serverContent: { turnComplete: true } });
      await new Promise((r) => setTimeout(r, 30));

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
      // The read names the ids, so a follow-up can echo them. 
      expect(readResp.response.canvas).toContain("[itm_1]");

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

      // 2b. `add_item` with a title and NO text — how "add a note called X"
      // arrives from the model. The note's body falls back to its title rather
      // than an empty blob, which the daemon refuses as `empty blob body`.
      providerSocket.emit({
        toolCall: { functionCalls: [{ id: "call-title-only", name: "add_item", args: { title: "Titled Only" } }] },
      });
      while (providerSocket.sent.length < 4) await new Promise(r => setTimeout(r, 10));
      const titledItems = await items();
      expect(titledItems.map((i) => i.title)).toContain("Titled Only");
      const titledLog = ((await (await fetch(`${server.state.url}log`)).json()) as any).entries.find(
        (e: any) => e.args?.title === "Titled Only",
      );
      expect(titledLog.result.ok, `a title alone still makes a note: ${titledLog.result.error ?? ""}`).toBe(true);

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
      while (providerSocket.sent.length < 5) await new Promise(r => setTimeout(r, 10));

      const renamedItems = await items();
      expect(renamedItems.map((i) => i.title)).toContain("Spoken Note Renamed");

      // 4. add_item with a url — the "add a web page" case Paul asked for.
      // It is an ordinary item.add whose blob is a text/uri-list, so the
      // canvas renders it as a live site rather than a text card.
      providerSocket.emit({
        toolCall: {
          functionCalls: [{ id: "call-site", name: "add_item", args: { url: "localhost:3000" } }],
        },
      });
      while (providerSocket.sent.length < 6) await new Promise(r => setTimeout(r, 10));

      const siteItems = await items();
      expect(siteItems.map((i) => i.title)).toContain("localhost:3000");

      // 5. Paul's example: comment, then delete the thread the comment made —
      // using only the id the model's own recent-action record carries.
      providerSocket.emit({
        toolCall: {
          functionCalls: [
            { id: "call-comment", name: "comment_on_item", args: { item_ref: "Checkout screen", text: "needs a button" } },
          ],
        },
      });
      while (providerSocket.sent.length < 7) await new Promise(r => setTimeout(r, 10));
      const commentReply = JSON.parse(providerSocket.sent.at(-1) ?? "{}");
      const commentResp = commentReply.toolResponse?.functionResponses?.[0];
      expect(commentResp.response.ok).toBe(true);
      const created = (commentResp.response.recent as Array<{ op: string; id?: string }>).find(
        (r) => r.op === "thread.create",
      );
      expect(created?.id, "the created thread's id is in the recent actions").toBeTruthy();

      providerSocket.emit({
        toolCall: {
          functionCalls: [{ id: "call-del", name: "thread_delete", args: { thread_id: created!.id } }],
        },
      });
      while (providerSocket.sent.length < 8) await new Promise(r => setTimeout(r, 10));
      const delResp = JSON.parse(providerSocket.sent.at(-1) ?? "{}").toolResponse?.functionResponses?.[0];
      expect(delResp.response.ok).toBe(true);

      // 6. Assert /log
      const logRes = (await (await fetch(`${server.state.url}log`)).json()) as any;
      expect(logRes.entries.length).toBeGreaterThanOrEqual(3);

      const readLog = logRes.entries.find((e: any) => e.name === "read_canvas");
      expect(readLog).toBeDefined();
      expect(readLog.result.ok).toBe(true);

      const addLog = logRes.entries.find((e: any) => e.name === "add_item");
      expect(addLog).toBeDefined();
      expect(addLog.result.ok).toBe(true);
      expect(addLog.op.type).toBe("item.add");

      const siteLog = logRes.entries.find((e: any) => e.args?.url === "localhost:3000");
      expect(siteLog, "the site call is in the log").toBeDefined();
      expect(siteLog.op.said).toBe('add "localhost:3000" as a web page');
      expect(siteLog.result.ok).toBe(true);

      const renameLog = logRes.entries.find((e: any) => e.name === "rename_item");
      expect(renameLog).toBeDefined();
      expect(renameLog.result.ok).toBe(true);
      expect(renameLog.op.type).toBe("item.update");

      const turnLog = logRes.entries.find((e: any) => e.event === "turn_complete");
      expect(turnLog, "the provider's turn boundary is in the log").toBeDefined();

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
      // A gate nobody answers must not hold a test for a minute: a short
      // window, exactly as a person would get if they walked away.
      confirmTimeoutMs: 2000,
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

      // 4. DELETE (delete_item) — through the gate, because that is the whole
      // point of it: the operation lands when the PERSON says yes, and the
      // model's tool call is only the question.
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
      const asked = await theQuestion(server.state.url);
      expect(asked.what).toContain("Handwritten Arrow");
      // Asked, not done: the sketch is still on the canvas while the question
      // stands, which is the difference between a gate and a log line.
      expect((await items()).some((i) => i.title === "Handwritten Arrow"), "nothing is deleted while the question stands").toBe(true);
      expect(await answering(server.state.url, asked.id, true)).toEqual({ ok: true, allowed: true });
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
    // Merged by id, so the restart cannot show the same call twice.
    expect(logRes.entries.filter((e: any) => e.args?.text === "say persist this message")).toHaveLength(1);
  });

  it("answers with what the apply did, not with the label that asked for it", async () => {
    const server = await serve();
    await fetch(`${server.state.url}utterance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "retitle the first thing to Logged Title", source: "test" }),
    });
    const logRes = (await (await fetch(`${server.state.url}log`)).json()) as any;
    const utt = logRes.entries.find((e: any) => e.type === "utterance");
    expect(utt.op.said).toBe('update "Checkout screen": new title "Logged Title"');
    expect(String(utt.result.answer)).toContain('updated "Checkout screen"');
    expect(utt.result.answer).not.toBe(utt.op.said);
  });

  it("marks restarts and session opens in the stream", async () => {
    const server = await serve();
    await fetch(`${server.state.url}session/start`, { method: "POST" });
    const logRes = (await (await fetch(`${server.state.url}log`)).json()) as any;
    expect(logRes.entries.some((e: any) => e.event === "harness restarted")).toBe(true);
    expect(logRes.entries.some((e: any) => e.event === "session opened")).toBe(true);
  });

  it("keeps the persisted file as the record when the in-memory window is capped at 200", async () => {
    const old = Array.from({ length: 205 }, (_, i) => ({
      id: `log_old_${i}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      type: "session_event" as const,
      event: `old ${i}`,
    }));
    await writeVoiceLog(home, old);
    const server = await serve();
    await fetch(`${server.state.url}utterance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "say after the cap", source: "typed" }),
    });
    // The write is fire-and-forget; give it a beat to land rather than race it.
    let disk = await readVoiceLog(home);
    for (let i = 0; i < 50 && disk.length <= 205; i++) {
      await new Promise((r) => setTimeout(r, 10));
      disk = await readVoiceLog(home);
    }
    expect(disk.length).toBeGreaterThan(205);
    expect(disk.some((e) => e.id === "log_old_0")).toBe(true);
    const logRes = (await (await fetch(`${server.state.url}log`)).json()) as any;
    expect(logRes.entries.some((e: any) => e.id === "log_old_0")).toBe(true);
    expect(logRes.entries.filter((e: any) => e.args?.text === "say after the cap")).toHaveLength(1);
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

        /* The question bar is hidden until something asks, and it is the one
           element on the page whose whole job is to be seen while somebody is
           mid-decision — so it is measured with a question standing, not in
           the state a quiet canvas leaves it in. Unhidden by hand: what is
           being measured is the layout, and the gate's own behaviour is
           driven for real in `the person's gate` above. */
        await b.ev(
          `(() => { document.getElementById("confirm-what").textContent = "delete “Checkout screen”"; document.getElementById("confirm").hidden = false; })()`,
        );

        // 1. Document width <= viewport width + 1
        const docWidth = Number(await b.ev(`document.documentElement.scrollWidth`));
        expect(docWidth).toBeLessThanOrEqual(width + 1);

        // 2. Zero pairwise bounding-box intersection between panels
        const overlaps = ((await b.ev(`(() => {
          const boxes = [...document.querySelectorAll("aside .panel, main > .panel, main > .composer, main > .dock, main > #confirm")]
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
