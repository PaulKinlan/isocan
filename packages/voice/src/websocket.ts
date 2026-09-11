import WebSocket from "ws";
import { assertVoiceToolSafety } from "./tools.ts";
import { Pcm16Converter } from "./pcm.ts";
import { isRecord, type VoiceAudioChunk, type VoiceAudioFormat, type VoiceBackend, type VoiceConnectionOptions, type VoiceProviderId, type VoiceSessionStatus, type VoiceToolCall } from "./types.ts";

export interface RemoteVoiceOptions {
  /** Supplied by an explicitly activated host; adapters never read the environment. */
  apiKey: string;
  /** Deliberately required: model availability is not a timeless library default. */
  model: string;
  /** Test seam. The CLI never accepts a provider endpoint from model/user text. */
  endpoint?: string;
}
const endpoints = {
  gemini: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
  openai: "wss://api.openai.com/v1/realtime",
};

/** Shared socket lifecycle; only the wire encodings branch by provider. No auto-resume/replay. */
export class WebSocketVoiceBackend implements VoiceBackend {
  readonly transport = "websocket";
  readonly inputAudioFormat: VoiceAudioFormat;
  readonly outputAudioFormat: VoiceAudioFormat = { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 };
  private inputConverter: Pcm16Converter | undefined;
  private outputConverter: Pcm16Converter | undefined;
  private state: VoiceSessionStatus = "disconnected";
  private socket: WebSocket | undefined;
  private options: VoiceConnectionOptions | undefined;
  private closing = false;
  private muted = false;
  private epoch = 0;
  private calls = new Map<string, AbortController>();

  constructor(readonly id: Exclude<VoiceProviderId, "simulated">, private config: RemoteVoiceOptions) {
    this.inputAudioFormat = { encoding: "pcm_s16le", sampleRate: id === "gemini" ? 16000 : 24000, channels: 1 };
  }
  get status(): VoiceSessionStatus { return this.state; }
  private statusChanged(status: VoiceSessionStatus): void {
    this.state = status;
    this.options?.onStatusChange?.(status);
  }
  private active(socket: WebSocket): boolean {
    return this.socket === socket && !this.closing && !this.muted && socket.readyState === WebSocket.OPEN && this.state !== "connecting";
  }
  private send(socket: WebSocket, frame: unknown): void {
    if (this.socket === socket && !this.closing && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }
  async connect(options: VoiceConnectionOptions): Promise<void> {
    if (this.socket) throw new Error("Voice backend already connected");
    if (!this.config.apiKey || !this.config.model.trim()) throw new Error("An API key and explicit model are required");
    assertVoiceToolSafety(options.tools);
    this.inputConverter = new Pcm16Converter(this.inputAudioFormat);
    this.outputConverter = new Pcm16Converter(options.outputAudioFormat ?? this.outputAudioFormat);
    this.options = options;
    this.closing = false;
    this.muted = false;
    this.calls.clear();
    this.statusChanged("connecting");
    let socket: WebSocket;
    try {
      const url = new URL(this.config.endpoint ?? endpoints[this.id]);
      const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
      if (!["wss:", "ws:"].includes(url.protocol) || url.username || url.password ||
          (!loopback && url.origin !== new URL(endpoints[this.id]).origin)) throw new Error("Invalid provider endpoint");
      if (this.id === "gemini") url.searchParams.set("key", this.config.apiKey);
      else url.searchParams.set("model", this.config.model);
      socket = new WebSocket(url, {
        maxPayload: 1024 * 1024,
        ...(this.id === "openai" ? { headers: { Authorization: `Bearer ${this.config.apiKey}` } } : {}),
      });
    } catch {
      this.statusChanged("error");
      this.options = undefined;
      // Neither a URL containing Google's key nor a header value belongs in an error.
      throw new Error("Unable to open provider connection");
    }
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const fail = () => {
        if (this.socket !== socket || this.closing) return;
        const error = new Error(`${this.id} provider connection failed`);
        this.statusChanged("error");
        settle(error);
        options.onError?.(error);
        void this.disconnect();
      };
      const timer = setTimeout(fail, 10_000);
      socket.on("open", () => this.send(socket, this.setup(options)));
      socket.on("error", fail);
      socket.on("close", () => {
        settle(new Error("Provider closed before setup completed"));
        if (this.socket !== socket) return;
        this.interrupt();
        this.socket = undefined;
        this.statusChanged("disconnected");
        this.options = undefined;
      });
      socket.on("message", (raw: WebSocket.RawData) => {
        if (this.socket !== socket || this.closing) return;
        let message: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(raw.toString());
          if (!isRecord(parsed) || parsed.error || parsed.type === "error") throw new Error("invalid provider event");
          message = parsed;
        } catch { fail(); return; }
        const ready = this.id === "gemini" ? isRecord(message.setupComplete) : message.type === "session.updated";
        if (!settled && ready) { this.statusChanged("connected"); settle(); }
        if (!settled || this.state === "error") return;
        void this.message(socket, message).catch(fail);
      });
    });
  }

  private setup(options: VoiceConnectionOptions): unknown {
    if (this.id === "gemini") return { setup: {
      model: this.config.model.startsWith("models/") ? this.config.model : `models/${this.config.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        ...(options.voiceName ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voiceName } } } } : {}),
      },
      ...(options.systemInstruction ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } } : {}),
      inputAudioTranscription: {}, outputAudioTranscription: {},
      tools: options.tools.length ? [{ functionDeclarations: options.tools.map(({ parameters, ...tool }) => ({ ...tool, parametersJsonSchema: parameters })) }] : [],
    } };
    return { type: "session.update", session: {
      type: "realtime", output_modalities: ["audio"],
      ...(options.systemInstruction ? { instructions: options.systemInstruction } : {}),
      audio: {
        input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: { type: "server_vad", interrupt_response: true } },
        output: { format: { type: "audio/pcm", rate: 24000 }, ...(options.voiceName ? { voice: options.voiceName } : {}) },
      },
      tools: options.tools.map((tool) => ({ type: "function", ...tool })),
      tool_choice: "auto",
    } };
  }
  private inputSocket(): WebSocket {
    if (!this.socket || !this.active(this.socket)) throw new Error("Voice input is not ready, stopped or muted");
    return this.socket;
  }
  sendAudioChunk(chunk: VoiceAudioChunk): void {
    const socket = this.inputSocket();
    const converted = this.inputConverter!.convert(chunk);
    if (!converted.data.byteLength) return;
    const data = Buffer.from(converted.data).toString("base64");
    // Convert at the adapter, including for Gemini (which could also resample remotely).
    this.send(socket, this.id === "gemini"
      ? { realtimeInput: { audio: { mimeType: `audio/pcm;rate=${converted.format.sampleRate}`, data } } }
      : { type: "input_audio_buffer.append", audio: data });
  }
  async sendTextMessage(text: string): Promise<void> {
    const socket = this.inputSocket();
    if (!text.trim()) throw new Error("Text must not be empty");
    if (this.id === "gemini") this.send(socket, { clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } });
    else {
      this.send(socket, { type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
      this.send(socket, { type: "response.create" });
    }
  }
  private interrupt(): void {
    this.epoch++;
    for (const call of this.calls.values()) call.abort();
    this.inputConverter?.reset();
    this.outputConverter?.reset();
    this.options?.onInterrupt?.();
  }
  setMuted(muted: boolean): void {
    if (!this.socket || this.closing || this.socket.readyState !== WebSocket.OPEN || this.state === "connecting") throw new Error("Voice backend is not ready");
    this.muted = muted;
    if (muted) this.interrupt();
    this.statusChanged(muted ? "muted" : "connected");
  }
  private audio(data: unknown): void {
    if (typeof data !== "string" || this.muted) return;
    const converted = this.outputConverter!.convert({ data: Buffer.from(data, "base64"), format: this.outputAudioFormat });
    if (!converted.data.byteLength) return;
    this.statusChanged("speaking");
    this.options?.onAudioOut(converted);
  }
  private async message(socket: WebSocket, message: Record<string, unknown>): Promise<void> {
    const options = this.options;
    if (!options) return;
    if (this.id === "gemini") {
      const cancel = message.toolCallCancellation;
      if (isRecord(cancel) && Array.isArray(cancel.ids)) for (const id of cancel.ids) if (typeof id === "string") this.calls.get(id)?.abort();
      const content = message.serverContent;
      if (isRecord(content)) {
        if (content.interrupted === true) this.interrupt();
        if (!this.active(socket)) return;
        const turn = content.modelTurn;
        if (isRecord(turn) && Array.isArray(turn.parts)) for (const part of turn.parts) {
          if (!isRecord(part) || !this.active(socket)) continue;
          if (isRecord(part.inlineData) && typeof part.inlineData.mimeType === "string" && part.inlineData.mimeType.startsWith("audio/pcm")) this.audio(part.inlineData.data);
          if (!content.outputTranscription && !part.thought && typeof part.text === "string") options.onTranscript("agent", part.text, false);
        }
        for (const [field, speaker] of [["inputTranscription", "user"], ["outputTranscription", "agent"]] as const) {
          const transcript = content[field];
          if (isRecord(transcript) && typeof transcript.text === "string") options.onTranscript(speaker, transcript.text, false);
        }
        if (content.turnComplete === true) { this.outputConverter?.reset(); options.onTranscript("agent", "", true); this.statusChanged("connected"); }
      }
      if (isRecord(message.toolCall) && Array.isArray(message.toolCall.functionCalls)) await this.runTools(socket, message.toolCall.functionCalls);
    } else {
      if (message.type === "input_audio_buffer.speech_started") this.interrupt();
      if (!this.active(socket)) return;
      if (message.type === "response.output_audio.delta") this.audio(message.delta);
      if (message.type === "response.output_audio.done") this.outputConverter?.reset();
      if (message.type === "response.output_audio_transcript.delta" && typeof message.delta === "string") options.onTranscript("agent", message.delta, false);
      if (message.type === "response.output_audio_transcript.done" && typeof message.transcript === "string") options.onTranscript("agent", message.transcript, true);
      if (message.type === "conversation.item.input_audio_transcription.completed" && typeof message.transcript === "string") options.onTranscript("user", message.transcript, true);
      if (message.type === "response.done" && isRecord(message.response)) {
        if (message.response.status === "cancelled") this.interrupt();
        if (message.response.status === "completed" && Array.isArray(message.response.output)) {
          // Final response contains complete function-call arguments. Waiting for it
          // also avoids response.create racing a still-generating response.
          await this.runTools(socket, message.response.output.filter((item) => isRecord(item) && item.type === "function_call"));
        }
        if (this.active(socket)) this.statusChanged("connected");
      }
    }
  }
  private async runTools(socket: WebSocket, rawCalls: unknown[]): Promise<void> {
    const options = this.options;
    if (!options || !this.active(socket)) return;
    const epoch = this.epoch;
    const pending: { call: VoiceToolCall; controller: AbortController }[] = [];
    for (const raw of rawCalls) {
      if (!isRecord(raw)) throw new Error("Invalid tool call");
      const id = this.id === "gemini" ? raw.id : raw.call_id;
      const args: unknown = this.id === "gemini" ? raw.args ?? {} : typeof raw.arguments === "string" ? JSON.parse(raw.arguments) : null;
      if (typeof id !== "string" || !id || typeof raw.name !== "string" || !isRecord(args)) throw new Error("Invalid tool call");
      if (this.calls.has(id)) continue;
      // ponytail: a bounded per-connection replay guard; reconnect starts a NEW session, never resumes old tool calls.
      if (this.calls.size >= 256) throw new Error("Voice tool-call budget exhausted");
      const controller = new AbortController();
      this.calls.set(id, controller);
      pending.push({ call: { id, name: raw.name, args }, controller });
    }
    const results = [];
    for (const { call, controller } of pending) {
      if (!this.active(socket) || this.epoch !== epoch || controller.signal.aborted) continue;
      let result: Record<string, unknown>;
      try {
        if (!options.tools.some((tool) => tool.name === call.name)) throw new Error("Tool not granted");
        result = await options.onToolCall(call, controller.signal);
      } catch { result = { error: "Tool refused or failed; no success is claimed" }; }
      if (this.active(socket) && this.epoch === epoch && !controller.signal.aborted) results.push({ id: call.id, name: call.name, response: result });
    }
    if (!results.length || !this.active(socket) || this.epoch !== epoch) return;
    if (this.id === "gemini") this.send(socket, { toolResponse: { functionResponses: results } });
    else {
      for (const result of results) this.send(socket, { type: "conversation.item.create", item: { type: "function_call_output", call_id: result.id, output: JSON.stringify(result.response) } });
      this.send(socket, { type: "response.create" });
    }
  }
  async disconnect(): Promise<void> {
    this.closing = true;
    this.interrupt();
    const socket = this.socket;
    if (!socket) { this.statusChanged("disconnected"); this.options = undefined; return; }
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.terminate();
    });
  }
}
