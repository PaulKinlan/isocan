import { spawn } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket as NodeSocket } from "ws";
import { readConfigFile } from "@isocan/server";
import { statSync } from "node:fs";
import { connect, type CanvasHandle, type ListedItem } from "@isocan/api";
import { readRcAgents } from "./rc.ts";
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
 * **The provider, guessed only when nobody said — and never a refusal.**
 *
 * This used to reject a key whose prefix was not `AIza…` or `sk-…`, which is a
 * client-side guess about a format that changes, failing closed on the one
 * person who knows better. Paul pasted a real key, the page said no, and the
 * feature looked broken before it had run. There is no validation here now:
 * any non-empty key is stored, the provider is taken from the form when it is
 * named and guessed from the prefix only as a default, and **the provider is
 * the judge** — its error is surfaced verbatim, in its own words.
 */
export function providerFor(key: string, named?: string): VoiceKey["provider"] {
  if (named === "gemini" || named === "openai") return named;
  return key.startsWith("sk-") ? "openai" : "gemini";
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
 * The Live API: the socket, the model, and the tools
 * ------------------------------------------------------------------ */

/**
 * **Gemini's Live API, not transcribe-then-act** (Paul, 11 Sep 2026: *"it
 * should just be sending to the Gemini live api (or whatever the latest
 * is)"*). A stateful bidirectional WebSocket — `BidiGenerateContent` — where
 * audio goes up as 16 kHz PCM and comes back as 24 kHz PCM plus text, and
 * where the model can call the canvas's operations as tools.
 *
 * The custody rule does not change with the protocol: **the harness opens the
 * socket and holds the key; the page only ever sends audio to loopback.** The
 * page capture is already 16 kHz PCM, so nothing here resamples — the page
 * knows its own `AudioContext.sampleRate`, which is the side that has to.
 *
 * Function calling is synchronous: a tool call blocks the conversation until
 * it is answered, which is the right shape for canvas operations — they are
 * one local round trip — and the wrong shape for making a screen. Slow asks
 * belong in the Chat, as the research note says; the tool list here is the
 * fast set.
 *
 * `gemini-3.1-flash-live-preview` verified current on 11 Sep 2026 against
 * Google's Live API docs. It is a preview name and will move; `--model` and
 * `LiveSessionOptions.model` exist so a person can move with it without a
 * release.
 */
export const LIVE_MODEL = "models/gemini-3.1-flash-live-preview";

export function liveUrl(key: string, host = "generativelanguage.googleapis.com"): string {
  return (
    `wss://${host}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` +
    `?key=${encodeURIComponent(key)}`
  );
}

/** The tool surface: exactly the fast set of operations a sentence can be,
 * declared so the model calls them rather than describing them. */
export const LIVE_TOOLS = [
  {
    name: "rename_item",
    description: "Rename something on the canvas. Use the item's current title or an ordinal like 'the second screen'.",
    parameters: {
      type: "OBJECT",
      properties: {
        item_ref: { type: "STRING", description: "The item's title, a prefix of it, or an ordinal phrase." },
        title: { type: "STRING", description: "The new title." },
      },
      required: ["item_ref", "title"],
    },
  },
  {
    name: "delete_item",
    description: "Delete something on the canvas (it goes to the trash, and the person can undo it).",
    parameters: {
      type: "OBJECT",
      properties: { item_ref: { type: "STRING" } },
      required: ["item_ref"],
    },
  },
  {
    name: "move_item",
    description: "Move something on the canvas, either by a delta or to a place.",
    parameters: {
      type: "OBJECT",
      properties: {
        item_ref: { type: "STRING" },
        by_x: { type: "NUMBER" },
        by_y: { type: "NUMBER" },
        to_x: { type: "NUMBER" },
        to_y: { type: "NUMBER" },
      },
      required: ["item_ref"],
    },
  },
  {
    name: "say",
    description: "Say something in the canvas Chat, where every parked agent hears it.",
    parameters: { type: "OBJECT", properties: { text: { type: "STRING" } }, required: ["text"] },
  },
  {
    name: "ask",
    description: "Ask the person a question on the canvas, pinned to the Chat.",
    parameters: { type: "OBJECT", properties: { text: { type: "STRING" } }, required: ["text"] },
  },
  {
    name: "comment_on_item",
    description: "Leave a comment on one item, where the conversation about that item belongs.",
    parameters: {
      type: "OBJECT",
      properties: { item_ref: { type: "STRING" }, text: { type: "STRING" } },
      required: ["item_ref", "text"],
    },
  },
  {
    name: "read_canvas",
    description: "Answer what is on the canvas: the items and how many.",
    parameters: { type: "OBJECT", properties: {} },
  },
];

/** What the setup message is: the whole contract with the API in one object. */
export function liveSetup(model: string = LIVE_MODEL): object {
  return {
    setup: {
      model,
      generationConfig: {
        responseModalities: ["AUDIO"],
        // Both sides transcribed, so the page can show what was said — and
        // so a wrong transcript that becomes a comment is visible before it
        // is believed.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      systemInstruction: {
        parts: [
          {
            text:
              "You are Voice, an agent on an isocan canvas, talking out loud with the person who owns it. " +
              "Keep replies to a sentence: you are a voice in a room, not a report. " +
              "When the person asks for something the canvas can do, CALL THE TOOL rather than describing it — " +
              "the tools are the canvas's own operations, they are instant, and every one of them is undoable. " +
              "If a request needs real work (making a screen, writing code, judging a design), say you are " +
              "putting it in the Chat and use `say` — a team of parked agents is listening there. " +
              "If you cannot tell which item they mean, ask.",
          },
        ],
      },
      tools: [{ functionDeclarations: LIVE_TOOLS }],
    },
  };
}

/** A tool call, as a plan: the same vocabulary the typed grammar produces, so
 * a spoken `move` and a typed one are one implementation. */
export function planForCall(name: string, args: Record<string, unknown>): { plans: PlannedOp[]; what?: string } {
  const ref = typeof args.item_ref === "string" ? args.item_ref : "";
  const text = typeof args.text === "string" ? args.text : "";
  switch (name) {
    case "rename_item":
      return { plans: [{ op: { type: "item.update", ref, title: String(args.title ?? "") }, said: `renamed ${ref}` }] };
    case "delete_item":
      return { plans: [{ op: { type: "item.delete", ref }, said: `deleted ${ref}` }] };
    case "move_item": {
      const by = args.by_x !== undefined || args.by_y !== undefined;
      return {
        plans: [
          {
            op: {
              type: "item.move",
              ref,
              by,
              x: by ? Number(args.by_x ?? 0) : Number(args.to_x ?? 0),
              y: by ? Number(args.by_y ?? 0) : Number(args.to_y ?? 0),
            },
            said: `moved ${ref}`,
          },
        ],
      };
    }
    case "say":
      return { plans: [{ op: { type: "thread.reply", body: text }, said: `said: ${text}` }] };
    case "ask":
      return { plans: [{ op: { type: "thread.reply", body: `? ${text}` }, said: `asked: ${text}` }] };
    case "comment_on_item":
      return { plans: [{ op: { type: "item.comment", ref, body: text }, said: `commented on ${ref}` }] };
    case "read_canvas":
      return { plans: [], what: "__read__" };
    default:
      return { plans: [], what: `the model called ${name}, which this harness does not have` };
  }
}

/** What the model asked for, turned into operations the canvas can apply:
 * a spoken reference resolved against what is actually here, and a delta
 * turned into the absolute position `item.move` takes. A reference nobody can
 * resolve is REFUSED in words rather than guessed at. */
export function resolveLivePlans(plans: PlannedOp[], items: ListedItem[]): { ready: PlannedOp[]; refused: string[] } {
  const ready: PlannedOp[] = [];
  const refused: string[] = [];
  for (const plan of plans) {
    const op = { ...plan.op } as { type: string; [key: string]: unknown };
    const ref = typeof op.ref === "string" ? op.ref : null;
    if (ref !== null) {
      const item = resolveSpokenRef(ref, items);
      if (!item) {
        refused.push(`${plan.said} — I could not tell which one “${ref}” is`);
        continue;
      }
      delete op.ref;
      op.itemId = item.id;
      if (op.type === "item.move" && op.by === true) {
        op.x = Number(item.x ?? 0) + Number(op.x ?? 0);
        op.y = Number(item.y ?? 0) + Number(op.y ?? 0);
      }
      delete op.by;
    }
    if (op.type === "item.update") op.title = op.title;
    ready.push({ op, said: plan.said });
  }
  return { ready, refused };
}

export interface LiveCallbacks {
  onHeard?: (text: string) => void;
  onText?: (text: string) => void;
  /** The model asked for an operation. Answers with what to say back to it. */
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onAudio?: (pcm: Uint8Array) => void;
  onState?: (state: string, bad?: boolean) => void;
}

export interface LiveSession {
  send(pcm: Uint8Array): void;
  close(): void;
  readonly ready: Promise<boolean>;
}

/**
 * **One live session.** Opened by the harness, fed by the page, and closed
 * when either side says so. A failure is reported in the provider's own
 * words: a key the provider rejects, a model it does not have, a quota — the
 * message is the message, and guessing at its cause on this side is how the
 * key panel came to refuse a real key.
 */
export function startLiveSession(options: {
  key: VoiceKey;
  model?: string;
  callbacks?: LiveCallbacks;
  urlFor?: (key: string) => string;
  WebSocketImpl?: typeof WebSocket;
}): LiveSession {
  const Socket = options.WebSocketImpl ?? WebSocket;
  const callbacks = options.callbacks ?? {};
  const url = options.urlFor
    ? options.urlFor(options.key.key)
    : options.key.provider === "gemini"
      ? liveUrl(options.key.key)
      : liveUrl(options.key.key);
  const socket = new Socket(url);
  let settled = false;
  let settle: (value: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => {
    settle = (value: boolean) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    socket.onopen = () => {
      socket.send(JSON.stringify(liveSetup(options.model ?? LIVE_MODEL)));
    };
    socket.onerror = () => {
      callbacks.onState?.("the live socket refused", true);
      settle(false);
    };
    socket.onclose = (event: any) => {
      const code = event?.code;
      const reason = event?.reason ? String(event.reason) : "";
      if (code && code !== 1000) {
        const closeMsg = `provider closed socket: code ${code}${reason ? ` — ${reason}` : ""}`;
        callbacks.onState?.(closeMsg, true);
      }
      settle(false);
    };
    socket.onmessage = (event: { data: unknown }) => {
      void handleMessage(event.data);
    };
  });

  async function handleMessage(raw: unknown): Promise<void> {
    let text: string;
    if (typeof raw === "string") text = raw;
    else if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
      text = new TextDecoder().decode(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw);
    } else if (raw && typeof (raw as { text?: () => Promise<string> }).text === "function") {
      text = await (raw as { text: () => Promise<string> }).text();
    } else {
      return;
    }
    let message: Record<string, any>;
    try {
      message = JSON.parse(text) as Record<string, any>;
    } catch {
      return;
    }
    if (message.error) {
      // The provider's own words, verbatim: it is the judge of the key, the
      // model and the quota, and a paraphrase here is how a real key came to
      // be called invalid.
      callbacks.onState?.(String(message.error.message ?? JSON.stringify(message.error)), true);
      settle(false);
      return;
    }
    if (message.setupComplete) {
      callbacks.onState?.("live", false);
      settle(true);
      return;
    }
    const content = message.serverContent;
    if (content) {
      if (content.inputTranscription?.text) callbacks.onHeard?.(content.inputTranscription.text);
      if (content.outputTranscription?.text) callbacks.onText?.(content.outputTranscription.text);
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.text) callbacks.onText?.(part.text);
        if (part.inlineData?.data) {
          const bytes = Buffer.from(part.inlineData.data, "base64");
          callbacks.onAudio?.(bytes);
        }
      }
      if (content.interrupted) callbacks.onState?.("the model was interrupted", false);
    }
    if (message.toolCall?.functionCalls) {
      const responses: Record<string, unknown>[] = [];
      for (const call of message.toolCall.functionCalls) {
        const answer = await (callbacks.onToolCall?.(call.name, call.args ?? {}) ?? Promise.resolve({ ok: true }));
        responses.push({ id: call.id, name: call.name, response: answer });
      }
      // Function calling is synchronous: the conversation waits for this, so
      // it carries the RESULT of the operation, not a promise of one.
      socket.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    }
  }

  return {
    send(pcm) {
      if (socket.readyState !== 1) return;
      socket.send(
        JSON.stringify({
          realtimeInput: { audio: { data: Buffer.from(pcm).toString("base64"), mimeType: "audio/pcm;rate=16000" } },
        }),
      );
    },
    close() {
      try {
        socket.close();
      } catch {
        // already gone
      }
    },
    ready,
  };
}

/* ------------------------------------------------------------------ *
 * The standing server: the page, and the operations it sends
 * ------------------------------------------------------------------ */

/** Does the provider accept this key? Its own words, either way. */
export async function checkKey(
  key: VoiceKey,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; answer: string; provider: string }> {
  try {
    if (key.provider === "openai") {
      const r = await fetchImpl("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key.key}` } });
      const body = await r.text();
      return { ok: r.ok, answer: r.ok ? "accepted" : `${r.status} ${body.slice(0, 300)}`, provider: "openai" };
    }
    const r = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key.key)}`,
    );
    const body = await r.text();
    return { ok: r.ok, answer: r.ok ? "accepted" : `${r.status} ${body.slice(0, 300)}`, provider: "gemini" };
  } catch (err) {
    return { ok: false, answer: `could not reach the provider: ${String((err as Error).message ?? err)}`, provider: key.provider };
  }
}

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
  /** The Live model, when it is not the current default. */
  model?: string;
  /** The socket address, for a test that needs a local stand-in. */
  liveUrl?: (key: string) => string;
  /** The network, for a test. */
  fetchImpl?: typeof fetch;
}

export interface ToolLogEntry {
  id: string;
  timestamp: string;
  type: "tool_call" | "session_event" | "utterance";
  name?: string;
  args?: Record<string, unknown>;
  op?: { type: string; said?: string; target?: string };
  result?: { ok: boolean; answer?: unknown; error?: string };
  event?: string;
  reason?: string;
}

export interface VoiceServerState {
  port: number;
  url: string;
  name: string;
  canvas: string;
  lines: string[];
  session: { state: "idle" | "live" | "muted" | "ended" };
  toolLog: ToolLogEntry[];
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
async function handleFor(options: VoiceServerOptions): Promise<{
  canvas: CanvasHandle;
  name: string;
  actorId: string;
  canvasLabel: string;
  canvasId: string;
  daemon: string;
  mainThreadId: string | null;
}> {
  const home = await withHome(options.home, options.daemonPort, async () =>
    connect(options.identity ? { identity: options.identity } : {}),
  );
  const canvas = await home.canvas(options.canvas);
  const threads = await canvas.threads();
  const main = threads.find((t) => t.main) ?? null;
  const daemon = canvas.ctx.client.base;
  return {
    canvas,
    name: home.actor.name,
    actorId: home.actor.id,
    canvasLabel: canvas.title,
    canvasId: canvas.id,
    daemon,
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
  let sessionState: "idle" | "live" | "muted" | "ended" = "idle";
  let activeLiveSession: LiveSession | null = null;
  const toolLog: ToolLogEntry[] = [];
  const logListeners = new Set<(entry: ToolLogEntry) => void>();

  function recordToolLog(entry: Omit<ToolLogEntry, "id" | "timestamp">): ToolLogEntry {
    const item: ToolLogEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    toolLog.push(item);
    while (toolLog.length > 200) toolLog.shift();
    for (const listener of logListeners) {
      try { listener(item); } catch {}
    }
    return item;
  }

  const narrate = (line: string) => {
    lines.push(line);
    if (lines.length > 50) lines.shift();
    options.onLine?.(line);
  };

  /** Everything the page — and a check — needs to say what this harness is
   * connected to: the canvas by title AND id, the daemon, the home it answers
   * to, the actor and whether it is enrolled, and the provider and model the
   * audio goes to. Paul: "I also have no clue what project or isocan service
   * the isocan voice agent is connected to." */
  const factsFor = async () => {
    const stored = await readVoiceKey(home).catch(() => null);
    const config = await readConfigFile<{ home?: string }>(home).catch(() => ({}) as { home?: string });
    const enrolled = (await readRcAgents(home).catch(() => [])).some(
      (row) => row.canvasId === target.canvasId && row.name === target.name && row.harness === VOICE_HARNESS,
    );
    return {
      name: target.name,
      port: options.port ?? DEFAULT_VOICE_PORT,
      version: voiceVersion(),
      updated: voiceUpdated(),
      canvas: { title: target.canvasLabel, id: target.canvasId },
      daemon: target.daemon,
      home: config.home ?? "no home configured — the daemon's default",
      agent: { name: target.name, id: target.actorId, enrolled },
      provider: { name: stored?.provider ?? null, model: options.model ?? LIVE_MODEL, key: stored !== null },
      session: { state: sessionState },
    };
  };

  const server = http.createServer((req, res) => {
    const respond = (code: number, body: unknown, type = "application/json") => {
      const payload = type === "application/json" ? JSON.stringify(body) : body;
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(payload);
    };
    const readBody = async (): Promise<Record<string, unknown> | string> => {
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
      if (text.trimStart().startsWith('"')) return JSON.parse(text) as string;
      return { raw };
    };
    const guard = (work: () => Promise<void>) => {
      void work().catch((err) => respond(500, { error: String((err as Error).message ?? err) }));
    };
    void (async () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${options.port || DEFAULT_VOICE_PORT}`);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        respond(200, voicePage(await factsFor()), "text/html; charset=utf-8");
        return;
      }
      if (req.method === "GET" && url.pathname === "/connection") {
        // Machine-readable, because "what is this agent connected to" is a
        // question a check should be able to ask without a screenshot.
        respond(200, await factsFor());
        return;
      }
      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        // A browser asks by itself. Answering 405 made the console look broken
        // for a page that is working.
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/state") {
        respond(200, { ...(await factsFor()), lines });
        return;
      }
      if (req.method === "GET" && url.pathname === "/log") {
        respond(200, { entries: toolLog, count: toolLog.length });
        return;
      }
      if (req.method === "POST" && url.pathname === "/session/start") {
        sessionState = "live";
        recordToolLog({ type: "session_event", event: "opened" });
        respond(200, { ok: true, state: sessionState });
        return;
      }
      if (req.method === "POST" && url.pathname === "/session/mute") {
        if (sessionState === "live") {
          sessionState = "muted";
          recordToolLog({ type: "session_event", event: "muted" });
        }
        respond(200, { ok: true, state: sessionState });
        return;
      }
      if (req.method === "POST" && url.pathname === "/session/unmute") {
        if (sessionState === "muted") {
          sessionState = "live";
          recordToolLog({ type: "session_event", event: "unmuted" });
        }
        respond(200, { ok: true, state: sessionState });
        return;
      }
      if (req.method === "POST" && url.pathname === "/session/end") {
        sessionState = "ended";
        recordToolLog({ type: "session_event", event: "closed", reason: "user ended" });
        if (activeLiveSession) {
          try { activeLiveSession.close(); } catch {}
          activeLiveSession = null;
        }
        respond(200, { ok: true, state: sessionState });
        return;
      }
      if (req.method !== "POST") {
        respond(405, { error: "the voice harness answers GET /, /state, /connection, /log and POST /key, /audio, /utterance, /summons, /session/*" });
        return;
      }
      const body = await readBody();
      if (url.pathname === "/key") {
        if (typeof body === "object" && body.forget === true) {
          await forgetVoiceKey(home);
          narrate("key forgotten");
          respond(200, { provider: null });
          return;
        }
        // Either shape: the form posts `{key, provider}`, and a bare string is
        // tolerated because a hand-made request is not a mistake worth a 400.
        const posted: Record<string, unknown> = typeof body === "string" ? { key: body } : body;
        const key = String(posted.key ?? "").trim();
        if (!key) {
          respond(400, { error: "no key in that body" });
          return;
        }
        const provider = providerFor(key, typeof posted["provider"] === "string" ? (posted["provider"] as string) : undefined);
        await writeVoiceKey(home, { provider, key });
        narrate(`key stored for ${provider}`);
        respond(200, { provider, path: voiceKeyFile(home) });
        return;
      }
      if (url.pathname === "/key/test") {
        const stored = await readVoiceKey(home);
        if (!stored) {
          respond(200, { ok: false, answer: "no key stored" });
          return;
        }
        // One cheap authenticated call, and the provider's answer VERBATIM:
        // a wrong key is found the moment it is pasted rather than at the
        // first utterance, which is the difference between a five-second fix
        // and an hour of debugging the wrong layer.
        const result = await checkKey(stored, options.fetchImpl);
        narrate(`key check (${stored.provider}): ${result.ok ? "accepted" : result.answer}`);
        respond(200, result);
        return;
      }
      if (url.pathname === "/audio") {
        const stored = await readVoiceKey(home);
        if (!stored) {
          respond(200, { text: "", reason: "no key stored, so the harness cannot transcribe — set one in the panel, or use the browser's own recogniser" });
          return;
        }
        const wav = typeof body === "string" ? undefined : body.wav;
        if (!(wav instanceof Buffer) && !(wav instanceof Uint8Array)) {
          respond(400, { error: "expected raw audio bytes" });
          return;
        }
        const bytes = wav as Uint8Array;
        const out = await transcribe({
          wav: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          key: stored,
          ...(typeof body === "object" && typeof body.model === "string" ? { model: body.model } : {}),
        });
        narrate(`heard (${out.provider}): ${out.text || "nothing"}`);
        respond(200, { text: out.text, provider: out.provider });
        return;
      }
      if (url.pathname === "/utterance") {
        const asObject = typeof body === "string" ? {} : body;
        const text = String(asObject.text ?? "");
        const source = String(asObject.source ?? "spoken");
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
            recordToolLog({
              type: "utterance",
              name: "utterance",
              args: { text, source },
              op: { type: plan.op.type, said: plan.said },
              result: { ok: true, answer: plan.said },
            });
          } catch (err) {
            failed.push(`${plan.said} — ${(err as Error).message}`);
            narrate(`refused: ${plan.said} — ${(err as Error).message}`);
            recordToolLog({
              type: "utterance",
              name: "utterance",
              args: { text, source },
              op: { type: plan.op.type, said: plan.said },
              result: { ok: false, error: (err as Error).message },
            });
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
        const summons = typeof body === "string" ? {} : body;
        const who = String(summons.name ?? "an agent");
        const prompt = String(summons.prompt ?? "");
        narrate(`summoned by ${who}: ${prompt.slice(0, 300)}`);
        respond(200, { lines });
        return;
      }
      respond(404, { error: "no such door" });
      return;
    })().catch(() => {});
    void guard;
  });

  /**
   * **The live door.** The page streams 16 kHz PCM here; this process holds
   * the provider socket and the key. Supports both /live and /audio paths.
   * Everything the model does comes back through the callbacks below, and a
   * tool call is answered with the RESULT of the operation because function
   * calling is synchronous.
   */
  const live = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/live" || pathname === "/audio") {
      live.handleUpgrade(request, socket, head, (ws) => {
        live.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });
  live.on("connection", (page: NodeSocket) => {
    sessionState = "live";
    recordToolLog({ type: "session_event", event: "opened" });
    const say = (message: unknown) => {
      if (page.readyState === page.OPEN) page.send(JSON.stringify(message));
    };
    const onLog = (entry: ToolLogEntry) => {
      say({ type: "tool_log", entry });
    };
    logListeners.add(onLog);
    void (async () => {
      const stored = await readVoiceKey(home).catch((err) => {
        say({ state: String((err as Error).message), bad: true });
        return null;
      });
      if (!stored) {
        say({
          state: "no key stored — set one in the panel and the microphone will use the Live API",
          bad: true,
        });
        return;
      }
      let liveFailure = "";
      const session = startLiveSession({
        key: stored,
        ...(options.model ? { model: options.model } : {}),
        ...(options.liveUrl ? { urlFor: options.liveUrl } : {}),
        callbacks: {
          onState: (state: string, bad?: boolean) => {
            if (bad) liveFailure = state;
            if (state.includes("interrupted")) {
              recordToolLog({ type: "session_event", event: "interrupted", reason: state });
            } else if (state === "turn_complete") {
              recordToolLog({ type: "session_event", event: "turn_complete" });
            }
            say({ state, bad });
          },
          onHeard: (text: string) => say({ heard: text }),
          onText: (text: string) => say({ text }),
          onAudio: (pcm: Uint8Array) => {
            if (page.readyState === page.OPEN) page.send(pcm);
          },
          onToolCall: async (name, args) => {
            const items = await target.canvas.items();
            const plan = planForCall(name, args as Record<string, unknown>);
            if (plan.what === "__read__") {
              const answer = describeCanvas({ items, mainThreadId: target.mainThreadId });
              say({ text: answer });
              recordToolLog({
                type: "tool_call",
                name,
                args: args as Record<string, unknown>,
                result: { ok: true, answer },
              });
              return { ok: true, canvas: answer };
            }
            const { ready, refused } = resolveLivePlans(plan.plans, items);
            const sent: string[] = [];
            const failed: string[] = [...refused];
            for (const one of ready) {
              try {
                await applyPlan(target.canvas, one, { items, mainThreadId: target.mainThreadId });
                sent.push(one.said);
                narrate(`sent: ${one.said}`);
                recordToolLog({
                  type: "tool_call",
                  name,
                  args: args as Record<string, unknown>,
                  op: { type: one.op.type, said: one.said, target: "target" in one.op ? String((one.op as any).target ?? (one.op as any).itemId ?? "") : undefined },
                  result: { ok: true, answer: one.said },
                });
              } catch (err) {
                const msg = (err as Error).message;
                failed.push(`${one.said} — ${msg}`);
                narrate(`refused: ${one.said} — ${msg}`);
                recordToolLog({
                  type: "tool_call",
                  name,
                  args: args as Record<string, unknown>,
                  op: { type: one.op.type, said: one.said },
                  result: { ok: false, error: msg },
                });
              }
            }
            for (const r of refused) {
              recordToolLog({
                type: "tool_call",
                name,
                args: args as Record<string, unknown>,
                result: { ok: false, error: r },
              });
            }
            say({ sent, failed, state: failed.length ? "some operations were refused" : "live", bad: failed.length > 0 });
            return { ok: failed.length === 0, ...(failed.length ? { failed } : {}), ...(plan.what ? { note: plan.what } : {}) };
          },
        },
      });
      activeLiveSession = session;
      page.on("message", (data: Buffer, isBinary: boolean) => {
        if (sessionState === "muted") return; // muted: suppress audio
        if (isBinary || Buffer.isBuffer(data)) session.send(new Uint8Array(data as Buffer));
      });
      page.on("close", () => {
        logListeners.delete(onLog);
        sessionState = "ended";
        recordToolLog({ type: "session_event", event: "closed", reason: liveFailure || "closed" });
        session.close();
      });
      const ok = await session.ready;
      if (!ok && page.readyState === page.OPEN) {
        // Loud, and never a silent fallback: a quiet failure here is what made
        // a credential problem look like a grammar problem.
        say({ state: "Live session could not start — " + (liveFailure || "the provider refused, see above"), bad: true, live: false });
      }
    })().catch((err) => say({ state: String((err as Error).message ?? err), bad: true }));
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
  const state: VoiceServerState = {
    port: listening,
    url,
    name: target.name,
    canvas: target.canvasLabel,
    lines,
    session: { state: sessionState },
    toolLog,
  };
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

/**
 * **Which build is running, and when the code behind it was last written.**
 * The evening's confusion was not knowing whether the page in front of you was
 * the old one or the new one, and a page that cannot answer that is a page
 * somebody tests the wrong version of. The version is the CLI's own; the time
 * is the newest modification of this feature's source, read from disk, so it
 * says when the RUNNING code was written rather than when it was released.
 */
function voiceVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unreleased";
  } catch {
    return "unreleased";
  }
}

function voiceUpdated(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const files = ["voice-harness.ts", "voice-harness-page.ts"].map((name) => statSync(path.join(here, name)).mtimeMs);
    return new Date(Math.max(...files)).toISOString().replace("T", " ").slice(0, 16) + "Z";
  } catch {
    return "unknown";
  }
}

/** `~/.isocan` for the process, the way every other CLI command finds it. */
export function isocanHome(): string {
  return process.env.ISOCAN_HOME ?? path.join(os.homedir(), ".isocan");
}
