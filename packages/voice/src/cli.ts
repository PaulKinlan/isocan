import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { connect } from "@isocan/api";
import { GeminiLiveBackend, OpenAIRealtimeBackend, KeylessSimulationBackend, canvasVoiceTools, type VoiceBackend } from "./index.ts";

export function selectVoiceBackend(provider: string, model: string | undefined, enableCloud: boolean, env: NodeJS.ProcessEnv = process.env): VoiceBackend {
  if (provider === "simulated") return new KeylessSimulationBackend();
  if (provider !== "gemini" && provider !== "openai") throw new Error("Provider must be simulated, gemini or openai");
  if (!enableCloud) throw new Error("Cloud disabled: --enable-cloud explicitly permits provider cost and message/canvas-data egress");
  if (!model?.trim()) throw new Error("Cloud sessions require an explicit --model");
  // Deliberately AFTER both activation gates. No provider credential is read in simulation.
  const keyName = provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
  const apiKey = env[keyName];
  if (!apiKey) throw new Error(`${keyName} is not configured; never put a key in command arguments`);
  return provider === "gemini" ? new GeminiLiveBackend({ apiKey, model }) : new OpenAIRealtimeBackend({ apiKey, model });
}

const usage = `Checkout-only voice transport demo (NOT microphone capture or audio playback).
  npm run voice -- --canvas <ref> --session <claimed-session> [--allow-move <exact-item-id>]...
    [--provider simulated|gemini|openai] [--model <model>] [--enable-cloud] [--seconds 60] [--port <port>]

Simulation text commands: items; who; move <exact-item-id> to <x> <y>
Controls: /mute, /unmute, /stop; EOF and Ctrl-C also stop. Microphone is always OFF.
Move grants include attached annotations, matching the existing CLI/browser gesture.
Claim the voice actor first with ISOCAN_HARNESS=isocan-voice and ISOCAN_SESSION_ID=<session>
using the existing isocan identity --name "Voice Demo" --session command.
Cloud adapters are experimental; this demo has no mic/speaker client. Cloud is OFF unless
--enable-cloud is given. That flag permits costs and disclosure of input/tool results.
`;

export async function runVoiceCli(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, options: {
    help: { type: "boolean", short: "h" }, canvas: { type: "string" }, session: { type: "string" },
    provider: { type: "string", default: "simulated" }, model: { type: "string" },
    "enable-cloud": { type: "boolean", default: false }, "allow-move": { type: "string", multiple: true },
    seconds: { type: "string", default: "60" }, port: { type: "string" },
  } });
  if (values.help) { console.log(usage); return; }
  if (!values.canvas || !values.session) throw new Error(usage);
  const seconds = Number(values.seconds);
  const port = values.port === undefined ? undefined : Number(values.port);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300 || (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))) {
    throw new Error("seconds must be 1–300; port must be 1–65535");
  }
  const backend = selectVoiceBackend(values.provider, values.model, values["enable-cloud"]);
  const home = await connect({ identity: { harness: "isocan-voice", session: values.session }, ...(port !== undefined ? { port } : {}) });
  const canvas = await home.canvas(values.canvas);
  const grant = canvasVoiceTools(canvas, values["allow-move"]);
  const lockDir = path.join(home.ctx.home, "voice");
  await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(lockDir, `${createHash("sha256").update(`${home.ctx.client.base}/${canvas.id}`).digest("hex")}.lock`);
  // ponytail: one local CLI per home/canvas, not a distributed room floor.
  // A hard crash leaves this lock; remove it only after confirming the old process is dead.
  const lock = await fs.open(lockPath, "wx", 0o600).catch(() => { throw new Error(`Voice floor unavailable: ${lockPath}; stop its owner before removing a stale lock`); });
  let sessionId: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let status = "connecting";
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Subscribe before asynchronous setup so piped lines/EOF cannot be lost.
  const lines = input[Symbol.asyncIterator]();
  const emit = (value: unknown) => console.log(JSON.stringify(value));
  const stop = () => { stopped = true; grant.revoke(); input.close(); void backend.disconnect(); };
  const deadline = setTimeout(stop, seconds * 1000);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, canvasId: canvas.id }) + "\n");
    const presence = await home.ctx.client.createSession(canvas.id, home.actor, `Voice (${backend.id}; microphone off)`, "isocan-voice");
    sessionId = presence.sessionId;
    if (stopped) return;
    let beating = false;
    const beat = async () => {
      if (stopped || beating || !sessionId) return;
      beating = true;
      try { await home.ctx.client.updateSession(canvas.id, sessionId, { status: `${backend.id}: ${status}; microphone off`, statusSource: "lifecycle" }); }
      catch { process.exitCode = 1; emit({ type: "error", message: "Voice presence lost; stopping" }); stop(); }
      finally { beating = false; }
    };
    heartbeat = setInterval(() => { void beat(); }, Math.max(100, Math.min(5000, presence.ttlMs / 3)));
    await backend.connect({
      tools: grant.tools,
      systemInstruction: "You are a separate voice agent on one authorised canvas. Use only offered tools. Do not claim actions succeeded unless tool results confirm them. No deletion or background task dispatch is available.",
      onToolCall: async (call, signal) => { const result = await grant.invoke(call, signal); emit({ type: "tool-result", callId: call.id, name: call.name, result }); return result; },
      onTranscript: (speaker, text, final) => { if (text) emit({ type: "transcript", speaker, text, final }); },
      onAudioOut: (chunk) => emit({ type: "audio-not-played", bytes: chunk.data.byteLength, format: chunk.format }),
      onStatusChange: (next) => { status = next; emit({ type: "status", provider: backend.id, status: next, microphone: false }); if (next === "disconnected") { stopped = true; grant.revoke(); input.close(); } },
      onError: (error) => { process.exitCode = 1; emit({ type: "error", message: error.message }); stop(); },
      onInterrupt: () => emit({ type: "interrupted" }),
    });
    await beat();
    if (stopped) return;
    emit({ type: "ready", provider: backend.id, transport: backend.transport, canvasId: canvas.id, actor: home.actor, microphone: false, audioPlayback: false, moveItems: values["allow-move"] ?? [], maxSeconds: seconds });
    for await (const line of lines) {
      if (stopped || line === "/stop") break;
      try {
        if (line === "/mute" || line === "/unmute") backend.setMuted(line === "/mute");
        else if (line.trim()) await backend.sendTextMessage(line.trim());
      } catch (error) { emit({ type: "refused", message: error instanceof Error ? error.message : "Voice input failed" }); }
    }
  } finally {
    stopped = true;
    grant.revoke();
    clearTimeout(deadline);
    clearInterval(heartbeat);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    input.close();
    await backend.disconnect();
    if (sessionId) await home.ctx.client.endSession(canvas.id, sessionId).catch(() => {});
    await lock.close();
    await fs.unlink(lockPath);
  }
}
