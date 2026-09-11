/**
 * **The voice harness, as a contract rather than a page.**
 *
 * The harness (merger's side) owns the microphone-to-model plumbing and the
 * key; this module is only the wire between a browser and it. Everything the
 * UI knows about the outside world is in this file:
 *
 *   GET  /state                       facts: canvas, daemon, home, agent, provider, model, version, updated, session
 *   POST /session/start|mute|unmute|end
 *   POST /key {key, provider}         the key is posted once and never stored in the page
 *   POST /key/test                    one authenticated call, the provider's answer verbatim
 *   GET  /log                         the tool-call log: call, operation minted, daemon's answer
 *   WS   /audio                       16 kHz PCM up (binary), 24 kHz PCM back (binary)
 *
 * `/harness` is a Vite dev proxy to 127.0.0.1:7654, so the page is same-origin
 * and the daemon needs no CORS header to work in dev or in a build behind it.
 */

export const HARNESS = "/harness";

export type SessionState = "idle" | "live" | "muted" | "ended";

export interface State {
  canvas?: { title?: string; id?: string };
  daemon?: string;
  home?: string;
  service?: string;
  agent?: { name?: string; id?: string; enrolled?: boolean };
  provider?: string;
  model?: string;
  keyPresent?: boolean;
  version?: string;
  updated?: string;
  session?: SessionState | { state?: SessionState };
  [k: string]: unknown;
}

export interface LogEntry {
  at?: string | undefined;
  tool?: string | undefined;
  args?: unknown;
  operation?: string | undefined;
  answered?: string | undefined;
  error?: string | undefined;
  event?: string | undefined;
  [k: string]: unknown;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(HARNESS + path, init);
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    // A refusal is the answer, not an error to swallow: an endpoint that does
    // not exist yet must say so in the log rather than render as a blank panel.
    throw new Error(`${path} answered ${response.status}: ${text.slice(0, 200)}`);
  }
}

export const state = () => json<State>("/state");
export const log = () => json<LogReply>("/log");
export const startSession = () => json<{ ok?: boolean; error?: string }>("/session/start", { method: "POST" });
export const muteSession = () => json<{ ok?: boolean; error?: string }>("/session/mute", { method: "POST" });
export const unmuteSession = () => json<{ ok?: boolean; error?: string }>("/session/unmute", { method: "POST" });
export const endSession = () => json<{ ok?: boolean; error?: string }>("/session/end", { method: "POST" });
export const saveKey = (key: string, provider: string) =>
  json<{ ok?: boolean; error?: string }>("/key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, provider }),
  });
export const testKey = () =>
  json<{ ok?: boolean; answer?: string; provider?: string }>("/key/test", { method: "POST" });

/** The entries in whatever shape the endpoint returns today. */
/**
 * **The harness's field names, mapped once, at the wire.**
 *
 * `GET /log` answers `{ timestamp, name, op, result }` and the page renders
 * `{ at, tool, operation, answered }`. Translating in the renderer is how the
 * log came out empty for hours while the endpoint was working: every field it
 * read was `undefined` and every row looked like a blank line.
 */
export function entriesFrom(reply: LogReply): LogEntry[] {
  const raw: RawEntry[] = Array.isArray(reply) ? reply : (reply.entries ?? reply.log ?? []);
  return raw.map((entry) => ({
    at: entry.at ?? entry.timestamp ?? entry.time,
    tool: entry.tool ?? entry.name ?? entry.toolName,
    args: entry.args ?? entry.arguments ?? entry.input,
    operation: entry.operation ?? entry.op ?? entry.operationId,
    answered: entry.answered ?? entry.result ?? entry.answer,
    error: entry.error ?? entry.failure,
    event: entry.event ?? entry.message,
  }));
}

export interface RawEntry {
  at?: string;
  timestamp?: string;
  time?: string;
  tool?: string;
  name?: string;
  toolName?: string;
  args?: unknown;
  arguments?: unknown;
  input?: unknown;
  operation?: string;
  op?: string;
  operationId?: string;
  answered?: string;
  result?: string;
  answer?: string;
  error?: string;
  failure?: string;
  event?: string;
  message?: string;
}

export type LogReply = RawEntry[] | { entries?: RawEntry[]; log?: RawEntry[] };

/** `{ state: "live" }` or `"live"` — the harness has answered both ways. */
export function sessionFrom(reply: State | null | undefined): SessionState | undefined {
  const held = reply?.session as unknown;
  if (!held) return undefined;
  if (typeof held === "string") return held as SessionState;
  const state = (held as { state?: string }).state;
  return state as SessionState | undefined;
}

export function audioSocket(): WebSocket {
  const url = new URL(HARNESS + "/audio", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url);
}
