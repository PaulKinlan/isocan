import { assertVoiceToolSafety } from "./tools.ts";
import type { VoiceAudioChunk, VoiceBackend, VoiceConnectionOptions, VoiceSessionStatus } from "./types.ts";

/** Deterministic text commands, NOT speech recognition or synthesised voice. */
export class KeylessSimulationBackend implements VoiceBackend {
  readonly id = "simulated";
  readonly transport = "in-memory";
  readonly inputAudioFormat = null;
  readonly outputAudioFormat = null;
  private options: VoiceConnectionOptions | undefined;
  private state: VoiceSessionStatus = "disconnected";
  private calls = new Set<AbortController>();
  private callId = 0;
  get status(): VoiceSessionStatus { return this.state; }
  private statusChanged(status: VoiceSessionStatus): void {
    this.state = status;
    this.options?.onStatusChange?.(status);
  }
  async connect(options: VoiceConnectionOptions): Promise<void> {
    if (this.options) throw new Error("Voice backend already connected");
    assertVoiceToolSafety(options.tools);
    this.options = options;
    this.statusChanged("connecting");
    this.statusChanged("connected");
  }
  sendAudioChunk(_chunk: VoiceAudioChunk): void {
    throw new Error("Simulation does not accept or recognise audio");
  }
  async sendTextMessage(text: string): Promise<void> {
    const options = this.options;
    if (!options || this.state === "muted") throw new Error("Voice input is stopped or muted");
    const match = /^move\s+(\S+)\s+to\s+(\S+)\s+(\S+)$/.exec(text.trim());
    const name = text === "items" ? "canvas_items" : text === "who" ? "canvas_who" : match ? "item_move" : null;
    if (!name) throw new Error("Simulation commands: items; who; move <exact-item-id> to <x> <y>");
    options.onTranscript("user", text, true);
    const result = await this.simulateToolCall(name, match ? { itemId: match[1], x: Number(match[2]), y: Number(match[3]) } : {});
    if (this.options === options && this.status !== "muted") options.onTranscript("agent", JSON.stringify(result), true);
  }
  async simulateToolCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const options = this.options;
    if (!options || this.state === "muted") throw new Error("Voice input is stopped or muted");
    if (!options.tools.some((tool) => tool.name === name)) throw new Error("Voice tool not granted");
    const controller = new AbortController();
    this.calls.add(controller);
    try {
      return await options.onToolCall({ id: `sim_${++this.callId}`, name, args }, controller.signal);
    } finally { this.calls.delete(controller); }
  }
  setMuted(muted: boolean): void {
    if (!this.options) throw new Error("Voice backend is disconnected");
    if (muted) { for (const call of this.calls) call.abort(); this.options.onInterrupt?.(); }
    this.statusChanged(muted ? "muted" : "connected");
  }
  async disconnect(): Promise<void> {
    for (const call of this.calls) call.abort();
    this.calls.clear();
    this.statusChanged("disconnected");
    this.options = undefined;
  }
}
