import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon, type Daemon } from "@isocan/server";
import { mintTestBadge, type TestBadge } from "./badge.ts";
import {
  DEFAULT_VOICE_PORT,
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
  await badge.speakAs(person);
  await post("/api/ops", {
    canvasId: null,
    actor: person,
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
    actor: person,
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
  delete env.ISOCAN_SESSION_ID;
  delete env.ISOCAN_HARNESS;
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

  it("takes the provider from the key's shape, and the stated one when the shape is unknown", () => {
    expect(providerFor("AIza-abc")).toBe("gemini");
    expect(providerFor("sk-abc")).toBe("openai");
    expect(providerFor("hunter2")).toBeNull();
    expect(providerFor("hunter2", "gemini")).toBe("gemini");
    // A key that names one provider but looks like the other is a mistake
    // worth refusing rather than sending to the wrong address.
    expect(providerFor("AIza-abc", "openai")).toBeNull();
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
    const usermedia = page.indexOf('name: "usermedia"');
    const gum = page.indexOf('name: "getUserMedia"');
    expect(mic).toBeGreaterThan(-1);
    expect(mic).toBeLessThan(usermedia);
    expect(usermedia).toBeLessThan(gum);
    // The key is never the page's to keep: the BEHAVIOUR script — the only
    // half that could write anything — names no browser storage at all. The
    // prose above it is allowed to say so in words.
    const behaviour = page.slice(page.lastIndexOf("<script>"));
    expect(behaviour).not.toContain("localStorage");
    expect(behaviour).not.toContain("document.cookie");
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
    expect(last.actor).not.toBe(person.id);
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

describe("the harness as the rc's adapter", () => {
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
