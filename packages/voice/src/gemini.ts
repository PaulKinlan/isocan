import WebSocket from "ws";
import type { VoiceBackend, VoiceConnectionOptions, VoiceSessionStatus, VoiceToolCall } from "./types.ts";

export interface GeminiLiveOptions {
  apiKey?: string;
  model?: string;
  voiceName?: string;
  endpoint?: string;
}

/**
 * GeminiLiveBackend: Implements the Google Gemini Multimodal Live API
 * bidirectional WebSocket protocol.
 *
 * Official spec (2026-09-11):
 * - URL: wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
 * - Input: Linear PCM 16-bit 16kHz mono (audio/pcm;rate=16000)
 * - Output: Linear PCM 16-bit 24kHz mono (audio/pcm;rate=24000)
 * - Turn function calling: synchronous within turn
 */
export class GeminiLiveBackend implements VoiceBackend {
  readonly id = "gemini";
  private _status: VoiceSessionStatus = "disconnected";
  private ws?: WebSocket;
  private options?: VoiceConnectionOptions;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly voiceName: string;
  private readonly endpoint: string;

  constructor(opts: GeminiLiveOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
    this.model = opts.model ?? "models/gemini-2.0-flash-exp";
    this.voiceName = opts.voiceName ?? "Kore";
    this.endpoint = opts.endpoint ?? "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
  }

  get status(): VoiceSessionStatus {
    return this._status;
  }

  async connect(options: VoiceConnectionOptions): Promise<void> {
    if (!this.apiKey) {
      throw new Error("Gemini Live API requires GEMINI_API_KEY; none was provided or configured in environment.");
    }

    this.options = options;
    this._status = "connecting";
    options.onStatusChange?.(this._status);

    const url = `${this.endpoint}?key=${encodeURIComponent(this.apiKey)}`;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);

        this.ws.on("open", () => {
          this.sendSetupFrame();
          this._status = "connected";
          options.onStatusChange?.(this._status);
          resolve();
        });

        this.ws.on("message", (data: WebSocket.RawData) => {
          this.handleServerMessage(data);
        });

        this.ws.on("error", (err: Error) => {
          this._status = "error";
          options.onStatusChange?.(this._status);
          options.onError?.(err);
          reject(err);
        });

        this.ws.on("close", () => {
          this._status = "disconnected";
          options.onStatusChange?.(this._status);
        });
      } catch (err) {
        this._status = "error";
        options.onStatusChange?.(this._status);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sendSetupFrame(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.options) return;

    // Transform tool declarations into Gemini functionDeclarations
    const functionDeclarations = this.options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    const setupMessage = {
      setup: {
        model: this.model,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.options.voiceName ?? this.voiceName,
              },
            },
          },
        },
        tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : [],
        systemInstruction: this.options.systemInstruction
          ? { parts: [{ text: this.options.systemInstruction }] }
          : undefined,
      },
    };

    this.ws.send(JSON.stringify(setupMessage));
  }

  sendAudioChunk(pcm16k: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const base64Audio = Buffer.from(pcm16k).toString("base64");
    const realtimeMessage = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/pcm;rate=16000",
            data: base64Audio,
          },
        ],
      },
    };

    this.ws.send(JSON.stringify(realtimeMessage));
  }

  sendTextMessage(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const textMessage = {
      clientContent: {
        turns: [
          {
            role: "user",
            parts: [{ text }],
          },
        ],
        turnComplete: true,
      },
    };

    this.ws.send(JSON.stringify(textMessage));
  }

  private handleServerMessage(rawData: WebSocket.RawData): void {
    if (!this.options) return;

    try {
      const msg = JSON.parse(rawData.toString("utf-8")) as Record<string, unknown>;

      // Server audio & text output
      if (msg.serverContent && typeof msg.serverContent === "object") {
        const sc = msg.serverContent as Record<string, unknown>;

        if (sc.interrupted === true) {
          this.options.onInterrupt?.();
        }

        if (sc.modelTurn && typeof sc.modelTurn === "object") {
          const modelTurn = sc.modelTurn as { parts?: Array<Record<string, unknown>> };
          for (const part of modelTurn.parts ?? []) {
            if (part.text && typeof part.text === "string") {
              this.options.onTranscript("agent", part.text, false);
            }
            if (part.inlineData && typeof part.inlineData === "object") {
              const inline = part.inlineData as { mimeType?: string; data?: string };
              if (inline.data && inline.mimeType?.startsWith("audio/pcm")) {
                const audioBuffer = Buffer.from(inline.data, "base64");
                this.options.onAudioOut(new Uint8Array(audioBuffer));
              }
            }
          }
        }

        if (sc.turnComplete === true) {
          this._status = "listening";
          this.options.onStatusChange?.(this._status);
        }
      }

      // Synchronous turn function calls
      if (msg.toolCall && typeof msg.toolCall === "object") {
        const tc = msg.toolCall as { functionCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }> };
        for (const call of tc.functionCalls ?? []) {
          void this.handleToolCall(call);
        }
      }
    } catch (err) {
      console.error("GeminiLiveBackend: error parsing server message:", err);
    }
  }

  private async handleToolCall(call: { id: string; name: string; args: Record<string, unknown> }): Promise<void> {
    if (!this.options || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      const toolCall: VoiceToolCall = { id: call.id, name: call.name, args: call.args ?? {} };
      const response = await this.options.onToolCall(toolCall);

      const responseMessage = {
        toolResponse: {
          functionResponses: [
            {
              response: { output: response },
              id: call.id,
            },
          ],
        },
      };

      this.ws.send(JSON.stringify(responseMessage));
    } catch (err) {
      console.error(`GeminiLiveBackend: error handling toolCall ${call.name}:`, err);
    }
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Best effort
      }
      this.ws = undefined;
    }
    this._status = "disconnected";
    this.options?.onStatusChange?.(this._status);
    this.options = undefined;
  }
}
