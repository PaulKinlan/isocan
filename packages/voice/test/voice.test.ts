import { once } from "node:events";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { startDaemon } from "@isocan/server";
import { connect, DaemonClient, harnessVars } from "@isocan/api";
import { GeminiLiveBackend, OpenAIRealtimeBackend, KeylessSimulationBackend, canvasVoiceTools, assertVoiceToolSafety, type VoiceAudioChunk, type VoiceConnectionOptions } from "@isocan/voice";
import { selectVoiceBackend } from "../src/cli.ts";
import { Pcm16Converter } from "../src/pcm.ts";

const readTool = { name: "canvas_items", description: "Synthetic read", parameters: { type: "object" as const, properties: {} } };
const defaults: VoiceConnectionOptions = { tools: [readTool], onAudioOut() {}, onTranscript() {}, async onToolCall() { return { ok: true }; } };

async function wire(provider: "gemini" | "openai", options: VoiceConnectionOptions, work: (backend: GeminiLiveBackend | OpenAIRealtimeBackend, peer: WebSocket, setup: any, ready: Promise<void>) => Promise<void>) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const config = { apiKey: "synthetic-local-key", model: "synthetic-model", endpoint: `ws://127.0.0.1:${address.port}` };
  const backend = provider === "gemini" ? new GeminiLiveBackend(config) : new OpenAIRealtimeBackend(config);
  const peerPromise = once(server, "connection");
  const ready = backend.connect(options);
  // Observe rejection even when a test fails before it can send the acknowledgement.
  const observed = ready.catch(() => {});
  try {
    const [peer] = await peerPromise;
    const [frame] = await once(peer, "message");
    await work(backend, peer, JSON.parse(frame.toString()), ready);
  } finally {
    await backend.disconnect();
    await observed;
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
async function flush(peer: WebSocket): Promise<void> { const pong = once(peer, "pong"); peer.ping(); await pong; }

it("OpenAI uses GA setup/ready, complete calls, explicit PCM, mute and a duplicate-call guard", async () => {
  let calls = 0;
  const audio: VoiceAudioChunk[] = [];
  await wire("openai", { ...defaults, onAudioOut(chunk) { audio.push(chunk); }, async onToolCall() { calls++; return { count: calls }; } }, async (backend, peer, setup, ready) => {
    expect(setup).toMatchObject({ type: "session.update", session: { type: "realtime", output_modalities: ["audio"], audio: { input: { format: { type: "audio/pcm", rate: 24000 } }, output: { format: { type: "audio/pcm", rate: 24000 } } } } });
    expect(backend.status).toBe("connecting");
    peer.send(JSON.stringify({ type: "session.created", session: {} }));
    await flush(peer);
    expect(backend.status).toBe("connecting");
    peer.send(JSON.stringify({ type: "session.updated", session: setup.session }));
    await ready;
    const call = { type: "response.done", response: { status: "completed", output: [{ type: "function_call", call_id: "call_1", name: "canvas_items", arguments: "{}" }] } };
    const reply = once(peer, "message");
    peer.send(JSON.stringify(call));
    expect(JSON.parse((await reply)[0].toString())).toMatchObject({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "call_1", output: '{"count":1}' } });
    peer.send(JSON.stringify(call));
    await flush(peer);
    expect(calls).toBe(1);
    backend.setMuted(true);
    await expect(backend.sendTextMessage("items")).rejects.toThrow(/muted/);
    backend.setMuted(false);
    expect(() => backend.sendAudioChunk({ data: new Uint8Array(1), format: { encoding: "pcm_s16le", channels: 1, sampleRate: 16000 } })).toThrow(/PCM/);
    peer.send(JSON.stringify({ type: "response.output_audio.delta", delta: "AAA=" }));
    await flush(peer);
    expect(Array.from(audio[0]!.data)).toEqual([0, 0]);
    expect(audio[0]!.format).toEqual({ encoding: "pcm_s16le", channels: 1, sampleRate: 24000 });
    await backend.disconnect();
    await expect(backend.sendTextMessage("items")).rejects.toThrow(/stopped/);
  });
});

it("Gemini converts declared PCM rate, uses current JSON schema and aborts a cancelled pending call", async () => {
  let called!: () => void;
  const started = new Promise<void>((resolve) => { called = resolve; });
  let finish!: (value: Record<string, unknown>) => void;
  const result = new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
  let signal: AbortSignal | undefined;
  await wire("gemini", { ...defaults, async onToolCall(_call, current) { signal = current; called(); return result; } }, async (backend, peer, setup, ready) => {
    expect(setup.setup.tools[0].functionDeclarations[0]).toHaveProperty("parametersJsonSchema");
    peer.send(JSON.stringify({ setupComplete: {} }));
    await ready;
    const audio = once(peer, "message");
    backend.sendAudioChunk({ data: new Uint8Array(2), format: { encoding: "pcm_s16le", channels: 1, sampleRate: 48000 } });
    expect(JSON.parse((await audio)[0].toString())).toEqual({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: "AAA=" } } });
    peer.send(JSON.stringify({ toolCall: { functionCalls: [{ id: "call_1", name: "canvas_items", args: {} }] } }));
    await started;
    peer.send(JSON.stringify({ toolCallCancellation: { ids: ["call_1"] } }));
    await flush(peer);
    expect(signal?.aborted).toBe(true);
    const replies: unknown[] = [];
    peer.on("message", (data) => replies.push(JSON.parse(data.toString())));
    finish({ done: true });
    await flush(peer);
    expect(replies).toEqual([]);
  });
});

it("a provider closing before setup rejects connect rather than leaving it pending", async () => {
  await wire("gemini", defaults, async (_backend, peer, _setup, ready) => {
    peer.close();
    await expect(ready).rejects.toThrow(/before setup/);
  });
});

const pcm = (samples: number[], sampleRate: number): VoiceAudioChunk => {
  const data = new Uint8Array(samples.length * 2);
  const view = new DataView(data.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return { data, format: { encoding: "pcm_s16le", channels: 1, sampleRate } };
};
const samplesOf = (data: Uint8Array): number[] => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return Array.from({ length: data.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true));
};

it.each(["gemini", "openai"] as const)("%s converts the SAME client audio into its wire rate and converts output back", async (provider) => {
  const output: VoiceAudioChunk[] = [];
  const clientAudio = pcm([0, 1000, 2000, 3000, 4000, 5000, 6000], 48000);
  await wire(provider, { ...defaults, outputAudioFormat: clientAudio.format, onAudioOut(chunk) { output.push(chunk); } }, async (backend, peer, _setup, ready) => {
    peer.send(JSON.stringify(provider === "gemini" ? { setupComplete: {} } : { type: "session.updated", session: {} }));
    await ready;
    expect(backend.inputAudioFormat.sampleRate).toBe(provider === "gemini" ? 16000 : 24000);
    expect(backend.outputAudioFormat.sampleRate).toBe(24000);
    const sent = once(peer, "message");
    backend.sendAudioChunk(clientAudio);
    const frame = JSON.parse((await sent)[0].toString());
    const bytes = Buffer.from(provider === "gemini" ? frame.realtimeInput.audio.data : frame.audio, "base64");
    expect(samplesOf(bytes)).toEqual(provider === "gemini" ? [0, 3000, 6000] : [0, 2000, 4000, 6000]);
    for (const values of [[0, 2400], [4800]]) {
      const data = Buffer.from(pcm(values, 24000).data).toString("base64");
      peer.send(JSON.stringify(provider === "gemini" ? { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data } }] } } } : { type: "response.output_audio.delta", delta: data }));
    }
    await flush(peer);
    expect(output.flatMap((chunk) => samplesOf(chunk.data))).toEqual([0, 1200, 2400, 3600, 4800]);
    expect(output.every((chunk) => chunk.format.sampleRate === 48000)).toBe(true);
  });
});

it("PCM conversion preserves stream phase across arbitrary chunk boundaries", () => {
  const source = Array.from({ length: 101 }, (_, i) => i * 123 - 6000);
  for (const [from, to] of [[16000, 24000], [48000, 16000], [44100, 48000]]) {
    const format = pcm([], to!).format;
    const whole = new Pcm16Converter(format).convert(pcm(source, from!));
    const split = new Pcm16Converter(format);
    const result = [];
    for (let i = 0; i < source.length; i += 7) result.push(...samplesOf(split.convert(pcm(source.slice(i, i + 7), from!)).data));
    expect(result).toEqual(samplesOf(whole.data));
  }
});

it("PCM validation fails closed and reset permits an intentional source-format change", () => {
  const target = pcm([], 24000).format;
  expect(() => new Pcm16Converter({ ...target, sampleRate: 0 })).toThrow(/PCM/);
  const converter = new Pcm16Converter(target);
  expect(() => converter.convert({ ...pcm([], 16000), data: new Uint8Array(1) })).toThrow(/PCM/);
  expect(() => converter.convert({ ...pcm([], 16000), data: new Uint8Array(1024 * 1024 + 2) })).toThrow(/PCM/);
  converter.convert(pcm([0, 3000], 16000));
  expect(() => converter.convert(pcm([0], 48000))).toThrow(/source rate changed/);
  converter.reset();
  expect(samplesOf(converter.convert(pcm([100, 200, 300], 48000)).data)).toEqual([100, 300]);
});

it("simulation and refused cloud activation do not read provider credentials", () => {
  const forbiddenEnv = new Proxy({}, { get() { throw new Error("credential read"); } });
  expect(selectVoiceBackend("simulated", undefined, false, forbiddenEnv)).toBeInstanceOf(KeylessSimulationBackend);
  expect(() => selectVoiceBackend("gemini", "explicit-model", false, forbiddenEnv)).toThrow(/Cloud disabled/);
  expect(() => selectVoiceBackend("openai", undefined, true, forbiddenEnv)).toThrow(/explicit --model/);
  for (const name of ["trash.empty", "trash_empty", "canvas.delete", "canvas_delete", "project.delete", "eval", "thread_reply"]) {
    expect(() => assertVoiceToolSafety([{ ...readTool, name }])).toThrow(/Unsupported/);
  }
});

it("the real CLI simulator moves through the real daemon, with its own actor and revocable item scope", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "isocan-voice-"));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "isocan-voice-work-"));
  const saved = new Map(["ISOCAN_HOME", "ISOCAN_DIRECT", ...harnessVars].map((key) => [key, process.env[key]]));
  const beforeCwd = process.cwd();
  const daemon = await startDaemon({ port: 0, home: homeDir, auth: null, birthHome: null });
  const address = daemon.app.server.address();
  if (!address || typeof address === "string") throw new Error("no daemon port");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    process.env.ISOCAN_HOME = homeDir;
    delete process.env.ISOCAN_DIRECT;
    for (const key of harnessVars) delete process.env[key];
    process.chdir(workDir);
    const client = new DaemonClient(`http://127.0.0.1:${address.port}`, homeDir);
    await client.claimActor({ type: "actor.claim", sessionKey: "isocan-voice:synthetic-session", name: "Voice Demo" });
    const home = await connect({ port: address.port, identity: { harness: "isocan-voice", session: "synthetic-session" } });
    await client.sendOp(null, home.actor, { type: "project.create", canvasId: "prj_voice", title: "Synthetic Voice Canvas" });
    const canvas = await home.canvas("prj_voice");
    const item = await canvas.add({ title: "Demo card", content: "Synthetic fixture", mime: "text/markdown", at: { x: 10, y: 20 } });
    const grant = canvasVoiceTools(canvas, [item.id]);
    const controller = new AbortController();
    await expect(grant.invoke({ id: "bad", name: "item_move", args: { itemId: "not-granted", x: 99, y: 99 } }, controller.signal)).rejects.toThrow(/outside/);
    await expect(grant.invoke({ id: "bad", name: "item_move", args: { itemId: item.id, x: Infinity, y: 99 } }, controller.signal)).rejects.toThrow(/finite/);
    grant.revoke();
    await expect(grant.invoke({ id: "late", name: "item_move", args: { itemId: item.id, x: 99, y: 99 } }, controller.signal)).rejects.toThrow(/revoked/);
    expect((await canvas.item(item.id)).x).toBe(10);
    const bin = fileURLToPath(new URL("../bin/voice.mjs", import.meta.url));
    child = spawn(process.execPath, [bin, "--canvas", canvas.id, "--session", "synthetic-session", "--allow-move", item.id, "--port", String(address.port)], { cwd: workDir, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", (data) => { stdout += data; });
    child.stderr!.on("data", (data) => { stderr += data; });
    const ended = once(child, "close");
    child.stdin!.end(`items\n/mute\n/unmute\nmove ${item.id} to 330 220\n/stop\n`);
    const [exit] = await ended;
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(events.find((event) => event.type === "ready")).toMatchObject({ provider: "simulated", microphone: false, actor: { id: home.actor.id } });
    expect(events.some((event) => event.type === "tool-result" && event.name === "item_move")).toBe(true);
    expect(await canvas.item(item.id)).toMatchObject({ x: 330, y: 220 });
    const activity = await canvas.activity();
    expect(activity[0]).toMatchObject({ who: "Voice Demo" });
    expect(await client.listSessions(canvas.id)).toEqual([]);
    expect(await fs.readdir(path.join(homeDir, "voice"))).toEqual([]);
  } finally {
    child?.kill();
    process.chdir(beforeCwd);
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await daemon.close();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
