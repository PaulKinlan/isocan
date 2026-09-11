import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, type CanvasHandle, type ListedItem } from "@isocan/api";
import { voicePage } from "./voice-harness-page.ts";

/**
 * **The voice harness** (Paul, 11 Sep 2026) — a local process that is enrolled
 * on a canvas like any other agent, and a page you talk to.
 *
 * Why a harness and not a page with a socket: enrolment is what makes the
 * operations *somebody's*. `isocan rc add <name> --harness voice` mints an
 * actor and a session key; the rc spawns this process the way it spawns any
 * adapter; and every operation the microphone produces is sent with that
 * identity, so the canvas says who typed, `@Name` reaches them, and undo and
 * the oplog treat a spoken change exactly like a clicked one. A page holding
 * its own socket would be a second surface with a second vocabulary — the
 * thing `docs/research/2026-08-24-voice.md` refuses by name.
 *
 * Two faces, one process model:
 *
 * - **`isocan voice --acp`** — the adapter the rc spawns. It speaks ACP over
 *   stdio (initialize / session/new / session/prompt), and when a summons
 *   arrives it hands it to the standing local server — starting one, detached,
 *   if none is up — so the summons appears in the conversation instead of
 *   being spent on a turn nobody watches.
 * - **`isocan voice`** — the standing server itself: the page, the capture,
 *   the key, and the operations. It lives as long as the person wants it to,
 *   which is the whole point: a microphone is not a turn.
 *
 * The key is the harness's, not the page's: it is POSTed once over loopback,
 * stored `0600` under `~/.isocan/voice/key.json`, and never written by the
 * page anywhere at all. Speech can also be transcribed by the browser's own
 * recogniser when no key is stored, and typed commands take the same path as
 * spoken ones — so the operation pipeline is provable with no key and no
 * spend, which is how it was verified.
 */

export const VOICE_HARNESS = "voice";
export const DEFAULT_VOICE_PORT = 7654;

/** Everything this feature owns, under `~/.isocan`. */
export function voiceDir(home: string): string {
  return path.join(home, "voice");
}
export function voiceKeyFile(home: string): string {
  return path.join(voiceDir(home), "key.json");
}
export function voiceServerFile(home: string): string {
  return path.join(voiceDir(home), "server.json");
}

export interface VoiceKey {
  provider: "gemini" | "openai";
  key: string;
}

/**
 * **A key's shape is its provider** — and when it is not, the person says so.
 * `AIza…` is Gemini's, `sk-…` is OpenAI's; anything else is stored with the
 * provider that was named in the form, or refused naming both shapes. Guessing
 * wrong sends a working key to a provider that answers 401, which reads as a
 * dead key rather than a wrong address.
 */
export function providerFor(key: string, named?: string): VoiceKey["provider"] | null {
  const shape = key.startsWith("AIza")
    ? "gemini"
    : key.startsWith("sk-")
      ? "openai"
      : null;
  if (named === "gemini" || named === "openai") {
    // A named provider with an unrecognised shape is still honoured — the
    // person knows what they pasted; only the AUTO guess needs a shape.
    if (!shape || shape === named) return named;
    return null;
  }
  return shape;
}

/** The stored key, or null. A file that is not 0600 is refused rather than
 * read: a key that leaked its own permissions is worth telling somebody
 * about, and reading it anyway would hide the one fact worth knowing. */
export async function readVoiceKey(home: string): Promise<VoiceKey | null> {
  const file = voiceKeyFile(home);
  try {
    const stat = await fs.stat(file);
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error(`${file} is mode ${(stat.mode & 0o777).toString(8)}, not 600 — refusing to read it`);
    }
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as VoiceKey;
    if (!parsed?.key || !parsed.provider) return null;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeVoiceKey(home: string, value: VoiceKey): Promise<string> {
  const dir = voiceDir(home);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = voiceKeyFile(home);
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600); // an existing file keeps its old mode otherwise
  return file;
}

export async function forgetVoiceKey(home: string): Promise<void> {
  await fs.rm(voiceKeyFile(home), { force: true });
}

/* ------------------------------------------------------------------ *
 * What a sentence means
 * ------------------------------------------------------------------ */

export interface PlannedOp {
  /** The operation, as `@isocan/api` sends it. */
  op: { type: string; [key: string]: unknown };
  /** What to say afterwards, in the person's words. */
  said: string;
}

export interface PlanContext {
  items: ListedItem[];
  /** The canvas's Chat thread, when there is one. */
  mainThreadId: string | null;
}

/** A spoken reference: a title prefix, or an ordinal ("the second screen"). */
export function resolveSpokenRef(ref: string, items: ListedItem[]): ListedItem | null {
  const wanted = ref.trim().toLowerCase().replace(/^the\s+/, "");
  if (!wanted) return null;
  const ordinal = wanted.match(/^(first|second|third|fourth|fifth|last|newest|oldest)\b/);
  if (ordinal) {
    const ordered = [...items].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const pick =
      ordinal[1] === "first"
        ? ordered[0]
        : ordinal[1] === "last" || ordinal[1] === "newest"
          ? ordered[ordered.length - 1]
          : ordinal[1] === "oldest"
            ? ordered[0]
            : ordered[["", "first", "second", "third", "fourth", "fifth"].indexOf(ordinal[1]!) - 1];
    return pick ?? null;
  }
  const exact = items.filter((i) => i.title?.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0]!;
  const prefixed = items.filter((i) => i.title?.toLowerCase().startsWith(wanted));
  return prefixed.length === 1 ? prefixed[0]! : null;
}

/**
 * **The spoken grammar, as a pure function.** Deterministic on purpose: the
 * first build has to be provable without a key and without spend, and a
 * sentence that maps to an operation is a fact a test can hold. A model that
 * reads freer sentences can sit in front of this later and emit the same
 * plans — the plan is the contract, not the parser.
 *
 * Every verb here is an operation the canvas already had. Nothing in this file
 * invents a vocabulary, which is the property that keeps voice honest.
 */
export function planVoice(text: string, ctx: PlanContext): { plans: PlannedOp[]; what?: string } {
  const said = text.trim();
  if (!said) return { plans: [] };
  const lower = said.toLowerCase();

  const quick = (item: ListedItem | null) => (item ? say(item.title ?? "that", item.id) : "that one");
  const say = (title: string, id: string) => `“${title}” (${id.slice(0, 10)})`;

  // Reads — answered, no operation sent. A voice surface that can only write
  // is a voice surface nobody can aim.
  if (/^(what|who|which)\b/.test(lower) || /\b(list|tell me)\b/.test(lower)) {
    return { plans: [], what: describeCanvas(ctx) };
  }

  let m = said.match(/^(?:please\s+)?(?:re)?(?:name|title|retitle|rename)\s+(.+?)\s+(?:to|as)\s+(.+)$/i);
  if (m) {
    const item = resolveSpokenRef(m[1]!, ctx.items);
    if (!item) return { plans: [], what: `I could not tell which one “${m[1]}” is.` };
    return {
      plans: [{ op: { type: "item.update", itemId: item.id, title: m[2]!.trim() }, said: `renamed ${quick(item)}` }],
    };
  }

  m = said.match(/^(?:please\s+)?(?:delete|remove|bin|trash)\s+(.+)$/i);
  if (m) {
    const item = resolveSpokenRef(m[1]!, ctx.items);
    if (!item) return { plans: [], what: `I could not tell which one “${m[1]}” is.` };
    return { plans: [{ op: { type: "item.delete", itemId: item.id }, said: `deleted ${quick(item)}` }] };
  }

  // Move: by a delta, or to a place on the plane. Both are the same op — and
  // the preposition is read rather than inferred, because "move X to 400, 200"
  // and "move X by 400, 200" are the same four numbers and different places.
  m = said.match(/^(?:please\s+)?move\s+(.+?)\s+(by|to|left|right|up|down)\s+(.+)$/i);
  if (m) {
    const item = resolveSpokenRef(m[1]!, ctx.items);
    if (!item) return { plans: [], what: `I could not tell which one “${m[1]}” is.` };
    const here = { x: Number(item.x ?? 0), y: Number(item.y ?? 0) };
    const how = m[2]!.toLowerCase();
    const rest = m[3]!.toLowerCase();
    const pair = rest.match(/^(-?\d+)\s*(?:,|\s+and\s+)\s*(-?\d+)$/);
    const amount = rest.match(/-?\d+/);
    let x = here.x;
    let y = here.y;
    if (how === "by" || how === "to") {
      if (!pair) {
        return { plans: [], what: `“${m[3]}” is not a place I understand — say “by 60, 0” or “to 400, 200”.` };
      }
      const [dx, dy] = [Number(pair[1]), Number(pair[2])];
      if (how === "to") {
        x = dx;
        y = dy;
      } else {
        x += dx;
        y += dy;
      }
    } else {
      const step = amount ? Number(amount[0]) : 60;
      if (how === "left") x -= step;
      else if (how === "right") x += step;
      else if (how === "up") y -= step;
      else y += step;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { plans: [], what: `I could not work out where “${m[2]}” puts that one.` };
    }
    return {
      plans: [
        { op: { type: "item.move", itemId: item.id, x: Math.round(x), y: Math.round(y) }, said: `moved ${quick(item)} to ${Math.round(x)}, ${Math.round(y)}` },
      ],
    };
  }

  m = said.match(/^(?:please\s+)?(?:say|note|notify|tell everyone)\s+(.+)$/i);
  if (m) {
    return { plans: [{ op: { type: "thread.reply", body: m[1]!.trim() }, said: `said: ${m[1]!.trim()}` }] };
  }

  m = said.match(/^(?:please\s+)?ask\s+(.+)$/i);
  if (m) {
    return { plans: [{ op: { type: "thread.reply", body: `? ${m[1]!.trim()}` }, said: `asked: ${m[1]!.trim()}` }] };
  }

  m = said.match(/^(?:please\s+)?(?:comment|reply|write)\s+(?:on\s+)?(.+?)[:,]\s*(.+)$/i);
  if (m) {
    const item = resolveSpokenRef(m[1]!, ctx.items);
    if (!item) return { plans: [], what: `I could not tell which one “${m[1]}” is.` };
    return {
      plans: [{ op: { type: "item.comment", itemId: item.id, body: m[2]!.trim() }, said: `commented on ${quick(item)}` }],
    };
  }

  return {
    plans: [],
    what:
      `I know: rename X to Y, delete X, move X by 60, 0, say …, ask …, comment on X: … . ` +
      `I heard “${said}”.`,
  };
}

function describeCanvas(ctx: PlanContext): string {
  if (ctx.items.length === 0) return "This canvas is empty.";
  const titles = ctx.items.slice(0, 6).map((i) => i.title ?? i.id.slice(0, 8));
  const more = ctx.items.length > titles.length ? `, and ${ctx.items.length - titles.length} more` : "";
  return `${ctx.items.length} things here: ${titles.join("; ")}${more}.`;
}

/* ------------------------------------------------------------------ *
 * Speech to text, at the harness, with the harness's key
 * ------------------------------------------------------------------ */

export interface Transcript {
  text: string;
  provider: string;
}

/**
 * **Audio over loopback, key over loopback, provider from the harness.** The
 * page never sees either. WAV on the wire because both providers take it and
 * neither takes the browser's `webm` opus without a conversion this file would
 * then own.
 */
export async function transcribe(options: {
  wav: ArrayBuffer;
  key: VoiceKey;
  fetchImpl?: typeof fetch;
  model?: string;
}): Promise<Transcript> {
  const doFetch = options.fetchImpl ?? fetch;
  const bytes = new Uint8Array(options.wav);
  if (options.key.provider === "openai") {
    const form = new FormData();
    form.append("model", options.model ?? "whisper-1");
    form.append("file", new Blob([bytes], { type: "audio/wav" }), "speech.wav");
    const r = await doFetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${options.key.key}` },
      body: form,
    });
    const j = (await r.json()) as { text?: string; error?: { message?: string } };
    if (!r.ok) throw new Error(`openai: ${j.error?.message ?? r.status}`);
    return { text: (j.text ?? "").trim(), provider: "openai" };
  }
  const model = options.model ?? "gemini-2.5-flash";
  const r = await doFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(options.key.key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: "Transcribe this audio exactly as spoken. Answer with the transcription and nothing else." },
              { inline_data: { mime_type: "audio/wav", data: base64(bytes) } },
            ],
          },
        ],
      }),
    },
  );
  const j = (await r.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    error?: { message?: string };
  };
  if (!r.ok) throw new Error(`gemini: ${j.error?.message ?? r.status}`);
  const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  return { text, provider: "gemini" };
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/* ------------------------------------------------------------------ *
 * The standing server: the page, and the operations it sends
 * ------------------------------------------------------------------ */

export interface VoiceServerOptions {
  home: string;
  port?: number;
  /** The identity to speak as — the enrolled agent's session key, or absent
   * to resolve the ambient one the way the CLI does. */
  identity?: { session: string; harness?: string };
  /** The canvas to send to; absent means this directory's. */
  canvas?: string;
  /** The daemon this harness should speak to, when it is not the one the
   * ambient environment names. */
  daemonPort?: number;
  onLine?: (line: string) => void;
}

export interface VoiceServerState {
  port: number;
  url: string;
  name: string;
  canvas: string;
  lines: string[];
}

/**
 * **Resolve where this harness was told to be, not where the process happens
 * to be standing.** `connect()` reads the home and the port out of the
 * environment (`paths.isocanHome()`), which is right for a CLI typed in a
 * shell and wrong for a harness handed a home as an argument: the harness
 * would silently speak to a different isocan than the one it serves — in a
 * test, the developer's real `~/.isocan`. Setting them for the call and
 * putting them back is the honest way to say which place this is.
 */
async function withHome<T>(home: string, port: number | undefined, work: () => Promise<T>): Promise<T> {
  const beforeHome = process.env.ISOCAN_HOME;
  const beforePort = process.env.ISOCAN_PORT;
  process.env.ISOCAN_HOME = home;
  if (port !== undefined) process.env.ISOCAN_PORT = String(port);
  try {
    return await work();
  } finally {
    if (beforeHome === undefined) delete process.env.ISOCAN_HOME;
    else process.env.ISOCAN_HOME = beforeHome;
    if (beforePort === undefined) delete process.env.ISOCAN_PORT;
    else process.env.ISOCAN_PORT = beforePort;
  }
}

/**
 * **One canvas handle, resolved once and reused.** `connect()` resolves the
 * same way every CLI command does — the directory marker, `ISOCAN_CANVAS`, the
 * ambient session key — so a harness started by the rc and a harness started
 * by hand speak as the same collaborator when they are given the same
 * identity.
 */
async function handleFor(options: VoiceServerOptions): Promise<{ canvas: CanvasHandle; name: string; canvasLabel: string; mainThreadId: string | null }> {
  const home = await withHome(options.home, options.daemonPort, async () =>
    connect(options.identity ? { identity: options.identity } : {}),
  );
  const canvas = await home.canvas(options.canvas);
  const threads = await canvas.threads();
  const main = threads.find((t) => t.main) ?? null;
  return {
    canvas,
    name: home.actor.name,
    canvasLabel: canvas.title,
    mainThreadId: main?.id ?? null,
  };
}

/** Send one planned operation through the API handle, so a spoken change is
 * the same operation a click would have made. */
async function applyPlan(
  canvas: CanvasHandle,
  plan: PlannedOp,
  ctx: PlanContext,
): Promise<void> {
  const op = plan.op as { type: string; [key: string]: unknown };
  switch (op.type) {
    case "item.update":
      // The title is a `MetaPatch` field, not a property — `set()`'s property
      // bag would write a property NAMED title, which is a different act.
      await canvas.ctx.client.sendOp(canvas.id, canvas.ctx.actor, {
        type: "item.update",
        itemId: op.itemId as string,
        patch: { title: op.title as string },
      });
      return;
    case "item.delete":
      await canvas.remove(op.itemId as string);
      return;
    case "item.move":
      await canvas.move(op.itemId as string, op.x as number, op.y as number);
      return;
    case "thread.reply":
      if (ctx.mainThreadId) await canvas.reply(ctx.mainThreadId, op.body as string);
      else await canvas.notify(op.body as string);
      return;
    case "item.comment":
      await canvas.comment(op.itemId as string, op.body as string);
      return;
    default:
      throw new Error(`the voice harness has no way to send ${op.type}`);
  }
}

export async function startVoiceServer(options: VoiceServerOptions): Promise<{
  state: VoiceServerState;
  close: () => Promise<void>;
}> {
  const home = options.home;
  const target = await handleFor(options);
  const lines: string[] = [];
  const narrate = (line: string) => {
    lines.push(line);
    if (lines.length > 50) lines.shift();
    options.onLine?.(line);
  };

  const server = http.createServer((req, res) => {
    const respond = (code: number, body: unknown, type = "application/json") => {
      const payload = type === "application/json" ? JSON.stringify(body) : body;
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(payload);
    };
    const readBody = async (): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        // A key is a kilobyte and a WAV is a minute; 32MB is a ceiling on
        // something that should never be near it.
        if (size > 32 * 1024 * 1024) throw new Error("that body is too big for this door");
        chunks.push(chunk as Buffer);
      }
      const raw = Buffer.concat(chunks);
      if (raw.length === 0) return {};
      const text = raw.toString("utf8");
      if (text.trimStart().startsWith("{")) return JSON.parse(text) as Record<string, unknown>;
      return { raw };
    };
    const guard = (work: () => Promise<void>) => {
      void work().catch((err) => respond(500, { error: String((err as Error).message ?? err) }));
    };
    void (async () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${options.port || DEFAULT_VOICE_PORT}`);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const stored = await readVoiceKey(home).catch(() => null);
        respond(
          200,
          voicePage({
            name: target.name,
            canvas: target.canvasLabel,
            key: stored ? { provider: stored.provider } : null,
            port: options.port ?? DEFAULT_VOICE_PORT,
          }),
          "text/html; charset=utf-8",
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/state") {
        respond(200, { name: target.name, canvas: target.canvasLabel, lines });
        return;
      }
      if (req.method !== "POST") {
        respond(405, { error: "the voice harness answers GET /, /state and POST /key, /audio, /utterance, /summons" });
        return;
      }
      const body = await readBody();
      if (url.pathname === "/key") {
        if (body.forget === true) {
          await forgetVoiceKey(home);
          narrate("key forgotten");
          respond(200, { provider: null });
          return;
        }
        const key = String(body.key ?? "").trim();
        if (!key) {
          respond(400, { error: "no key in that body" });
          return;
        }
        const provider = providerFor(key, typeof body.provider === "string" ? body.provider : undefined);
        if (!provider) {
          respond(400, { error: "that does not look like a Gemini (AIza…) or OpenAI (sk-…) key — name the provider if it is one anyway" });
          return;
        }
        await writeVoiceKey(home, { provider, key });
        narrate(`key stored for ${provider}`);
        respond(200, { provider, path: voiceKeyFile(home) });
        return;
      }
      if (url.pathname === "/audio") {
        const stored = await readVoiceKey(home);
        if (!stored) {
          respond(200, { text: "", reason: "no key stored, so the harness cannot transcribe — set one in the panel, or use the browser's own recogniser" });
          return;
        }
        const wav = body.wav;
        if (!(wav instanceof Buffer) && !(wav instanceof Uint8Array)) {
          respond(400, { error: "expected raw audio bytes" });
          return;
        }
        const bytes = wav as Uint8Array;
        const out = await transcribe({
          wav: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          key: stored,
          ...(typeof body.model === "string" ? { model: body.model } : {}),
        });
        narrate(`heard (${out.provider}): ${out.text || "nothing"}`);
        respond(200, { text: out.text, provider: out.provider });
        return;
      }
      if (url.pathname === "/utterance") {
        const text = String(body.text ?? "");
        const source = String(body.source ?? "spoken");
        const items = await target.canvas.items();
        const ctx: PlanContext = { items, mainThreadId: target.mainThreadId };
        const { plans, what } = planVoice(text, ctx);
        const sent: string[] = [];
        const failed: string[] = [];
        for (const plan of plans) {
          try {
            await applyPlan(target.canvas, plan, ctx);
            sent.push(plan.said);
            narrate(`sent: ${plan.said}`);
          } catch (err) {
            failed.push(`${plan.said} — ${(err as Error).message}`);
            narrate(`refused: ${plan.said} — ${(err as Error).message}`);
          }
        }
        respond(200, {
          reply: what ?? (sent.length ? sent.join("; ") : "nothing to send"),
          sent,
          failed,
          state: failed.length ? "some operations were refused" : "ready",
          source,
        });
        return;
      }
      if (url.pathname === "/summons") {
        const who = String(body.name ?? "an agent");
        const prompt = String(body.prompt ?? "");
        narrate(`summoned by ${who}: ${prompt.slice(0, 300)}`);
        respond(200, { lines });
        return;
      }
      respond(404, { error: "no such door" });
      return;
    })().catch(() => {});
    void guard;
  });

  const port = options.port ?? DEFAULT_VOICE_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  // The port ASKED for is not always the port GIVEN: `--voice-port 0` is the
  // way to say "any free one", and a state file that recorded the zero would
  // send every reader to a door nobody is behind.
  const bound = server.address();
  const listening = typeof bound === "object" && bound ? bound.port : port;
  const url = `http://127.0.0.1:${listening}/`;
  const state: VoiceServerState = { port: listening, url, name: target.name, canvas: target.canvasLabel, lines };
  await fs.mkdir(voiceDir(home), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    voiceServerFile(home),
    `${JSON.stringify({ pid: process.pid, port: listening, url, name: state.name, canvas: state.canvas, at: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    state,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(voiceServerFile(home), { force: true });
    },
  };
}

/** Is a harness already standing where the adapter or a second start would
 * find it? A file is a claim; the port is the fact. */
export async function standingVoiceServer(
  home: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ pid: number; port: number; url: string } | null> {
  try {
    const raw = JSON.parse(await fs.readFile(voiceServerFile(home), "utf8")) as { pid: number; port: number; url: string };
    if (!raw?.port) return null;
    const r = await fetchImpl(`http://127.0.0.1:${raw.port}/state`).catch(() => null);
    if (!r?.ok) return null;
    return raw;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * The ACP face: what makes this a harness, which is what invites it
 * ------------------------------------------------------------------ */

interface Rpc {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * **The ACP agent, in full.** The wire is newline-delimited JSON-RPC 2.0 with
 * `protocolVersion` 1, verified against the rc's client (`acp.ts`): initialize,
 * session/new, session/load, session/prompt, and `stopReason: "end_turn"`.
 *
 * A voice turn ends the moment it is acknowledged, deliberately. The rc's turn
 * is a summons, not a conversation: the microphone belongs to a process that
 * outlives the turn (the standing server this face forwards to), so the
 * summons appears in the conversation and the turn closes cleanly rather than
 * holding a 10-minute ceiling open on a room that may be empty.
 */
export function createAcpAgent(options: {
  forward: (summons: { name: string; prompt: string }) => Promise<{ url: string } | null>;
  name: string;
  out?: (message: unknown) => void;
}): { handle: (message: Rpc) => Promise<void> } {
  const out = options.out ?? ((message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`));
  const sessions = new Set<string>();
  return {
    handle: async (message: Rpc) => {
      const { id, method, params = {} } = message;
      const reply = (result: unknown) => out({ jsonrpc: "2.0", id, result });
      const fail = (code: number, text: string) => out({ jsonrpc: "2.0", id, error: { code, message: text } });
      try {
        switch (method) {
          case "initialize":
            reply({
              protocolVersion: 1,
              agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false } },
              authMethods: [],
              agentInfo: { name: "isocan voice", version: "0.1.0" },
            });
            return;
          case "session/new": {
            const sessionId = `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            sessions.add(sessionId);
            reply({ sessionId });
            return;
          }
          case "session/load": {
            const sessionId = String(params.sessionId ?? "");
            sessions.add(sessionId);
            reply({});
            return;
          }
          case "session/prompt": {
            const prompt = promptText(params.prompt);
            const forwarded = await options.forward({ name: options.name, prompt }).catch(() => null);
            out({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: {
                    type: "text",
                    text: forwarded
                      ? `The voice harness is standing at ${forwarded.url} — the summons is in its conversation.`
                      : "The voice harness could not open its local page; run `isocan voice` where you are.",
                  },
                },
              },
            });
            reply({ stopReason: "end_turn" });
            return;
          }
          case "session/cancel":
            reply({});
            return;
          default:
            fail(-32601, `the voice harness does not speak ${method ?? "that"}`);
        }
      } catch (err) {
        fail(-32000, String((err as Error).message ?? err));
      }
    },
  };
}

function promptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
      .join(" ")
      .trim();
  }
  return "";
}

/** Where this CLI's own entry point is, so the detached server is this build
 * and not whatever is on the PATH. */
function cliEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "isocan.js");
}

/**
 * **Enough adapter to be invited.** A summons with no harness standing starts
 * one — detached, so it outlives the turn — and then hands the summons over.
 * `--canvas` and the identity travel with it, which is what makes the
 * operations the microphone sends this agent's.
 */
export async function runVoiceAdapter(options: { home: string; name: string; canvas?: string }): Promise<void> {
  const forward = async (summons: { name: string; prompt: string }) => {
    const standing = await standingVoiceServer(options.home);
    const target = standing ?? (await startDetachedServer(options));
    if (!target) return null;
    await fetch(`http://127.0.0.1:${target.port}/summons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: summons.name, prompt: summons.prompt }),
    }).catch(() => {});
    return { url: target.url };
  };
  const agent = createAcpAgent({ forward, name: options.name });
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim()) {
        let parsed: Rpc | null = null;
        try {
          parsed = JSON.parse(line) as Rpc;
        } catch {
          parsed = null;
        }
        if (parsed) void agent.handle(parsed);
      }
      at = buffer.indexOf("\n");
    }
  });
  await new Promise<void>((resolve) => process.stdin.on("end", resolve));
}

/** Start the standing server as a child that survives this process — the
 * adapter's turn ends, the microphone should not. */
async function startDetachedServer(options: { home: string; name: string; canvas?: string }): Promise<{ port: number; url: string } | null> {
  const port = DEFAULT_VOICE_PORT;
  const args = [cliEntry(), "voice", "--port", String(port)];
  if (options.canvas) args.push("--canvas", options.canvas);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ISOCAN_SESSION_ID: process.env.ISOCAN_SESSION_ID ?? options.name,
      ISOCAN_HARNESS: process.env.ISOCAN_HARNESS ?? "agent",
    },
  });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const standing = await standingVoiceServer(options.home);
    if (standing) return standing;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/** `~/.isocan` for the process, the way every other CLI command finds it. */
export function isocanHome(): string {
  return process.env.ISOCAN_HOME ?? path.join(os.homedir(), ".isocan");
}
