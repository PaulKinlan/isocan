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
  session?: SessionState;
  [k: string]: unknown;
}

export interface LogEntry {
  at?: string;
  tool?: string;
  args?: unknown;
  operation?: string;
  answered?: string;
  error?: string;
  event?: string;
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
export const log = () => json<LogEntry[] | { entries?: LogEntry[] }>("/log");
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
export function entriesFrom(reply: LogEntry[] | { entries?: LogEntry[] }): LogEntry[] {
  return Array.isArray(reply) ? reply : (reply.entries ?? []);
}

export function audioSocket(): WebSocket {
  const url = new URL(HARNESS + "/audio", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url);
}
