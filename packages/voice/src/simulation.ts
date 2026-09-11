import type { VoiceBackend, VoiceConnectionOptions, VoiceSessionStatus, VoiceToolCall } from "./types.ts";

/**
 * KeylessSimulationBackend: An in-memory simulation adapter for testing and
 * zero-cost verification. It generates synthetic audio ticks, simulates
 * user/agent transcripts, and allows injecting scripted tool calls directly.
 */
export class KeylessSimulationBackend implements VoiceBackend {
  readonly id = "simulated";
  private _status: VoiceSessionStatus = "disconnected";
  private options?: VoiceConnectionOptions;
  private callCounter = 0;

  get status(): VoiceSessionStatus {
    return this._status;
  }

  async connect(options: VoiceConnectionOptions): Promise<void> {
    this.options = options;
    this._status = "connecting";
    options.onStatusChange?.(this._status);

    // Simulate connection delay
    await new Promise((resolve) => setTimeout(resolve, 20));

    this._status = "connected";
    options.onStatusChange?.(this._status);

    // Initial agent greeting
    options.onTranscript("agent", "I'm on the canvas. What are we looking at?", true);
    // Synthetic silent PCM chunk (24kHz 16-bit mono: 480 samples = 20ms = 960 bytes)
    options.onAudioOut(new Uint8Array(960));

    this._status = "listening";
    options.onStatusChange?.(this._status);
  }

  sendAudioChunk(_pcm16k: Uint8Array): void {
    if (this._status !== "listening" && this._status !== "connected") return;
    // In simulation mode, audio chunks represent active user mic streaming.
  }

  sendTextMessage(text: string): void {
    if (!this.options) return;
    this.options.onTranscript("user", text, true);

    // Parse simple simulated commands for automated tests
    this.simulateSpeechUnderstanding(text);
  }

  /**
   * Scripting helper: directly trigger a tool call as if the model called it.
   */
  async simulateToolCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.options) throw new Error("Simulation backend not connected");
    const callId = `sim_call_${++this.callCounter}`;
    const call: VoiceToolCall = { id: callId, name, args };

    this._status = "speaking";
    this.options.onStatusChange?.(this._status);

    const result = await this.options.onToolCall(call);

    this._status = "listening";
    this.options.onStatusChange?.(this._status);

    return result;
  }

  private simulateSpeechUnderstanding(text: string): void {
    if (!this.options) return;

    // Fast keyword parsing for simulation demo
    const lower = text.toLowerCase();
    if (lower.startsWith("move ") || lower.includes("move item")) {
      // e.g. "move item_1 to 150 250"
      const match = text.match(/move\s+([\w#_-]+)\s+(?:to\s+)?(-?\d+)\s+(-?\d+)/i);
      if (match && match[1] && match[2] && match[3]) {
        void this.simulateToolCall("item_move", {
          itemId: match[1],
          x: parseInt(match[2], 10),
          y: parseInt(match[3], 10),
        }).then((res) => {
          this.options?.onTranscript("agent", `Moved item to (${match[2]}, ${match[3]}).`, true);
        });
        return;
      }
    }

    if (lower.includes("keep version") || lower.includes("set version")) {
      const match = text.match(/(?:keep|set)\s+(?:version\s+)?([\w_-]+)\s+(?:for|of)\s+([\w#_-]+)/i);
      if (match && match[1] && match[2]) {
        void this.simulateToolCall("item_set_current_version", {
          versionId: match[1],
          itemId: match[2],
        }).then((res) => {
          this.options?.onTranscript("agent", `Version ${match[1]} is now active.`, true);
        });
        return;
      }
    }

    if (lower.startsWith("ask ") || lower.startsWith("tell ")) {
      const match = text.match(/(?:ask|tell)\s+(\w+)\s+(?:to\s+)?(.+)/i);
      if (match && match[1] && match[2]) {
        void this.simulateToolCall("dispatch_task", {
          agentName: match[1],
          task: match[2],
        }).then((res) => {
          this.options?.onTranscript("agent", `I've asked ${match[1]} to handle that.`, true);
        });
        return;
      }
    }

    // Default conversational echo
    this.options.onTranscript("agent", `Understood: "${text}".`, true);
  }

  async disconnect(): Promise<void> {
    this._status = "disconnected";
    this.options?.onStatusChange?.(this._status);
    this.options = undefined;
  }
}
