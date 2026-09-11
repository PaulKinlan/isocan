export type VoiceProviderId = "simulated" | "gemini" | "openai";
export type VoiceSessionStatus = "disconnected" | "connecting" | "connected" | "listening" | "speaking" | "muted" | "error";

/** PCM bytes always travel with their format; no provider's rate is implicit. */
export interface VoiceAudioFormat {
  encoding: "pcm_s16le";
  sampleRate: number;
  channels: 1;
}
export interface VoiceAudioChunk {
  data: Uint8Array;
  format: VoiceAudioFormat;
}
export interface VoiceToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: false;
  };
}
export interface VoiceToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export interface VoiceConnectionOptions {
  voiceName?: string;
  systemInstruction?: string;
  tools: readonly VoiceToolDeclaration[];
  /** Optional device/playback format; the adapter converts from its wire format. */
  outputAudioFormat?: VoiceAudioFormat;
  onAudioOut: (chunk: VoiceAudioChunk) => void;
  onTranscript: (speaker: "user" | "agent", text: string, isFinal: boolean) => void;
  /** Cancellation stops undispatched gestures; a CanvasHandle gesture already invoked may finish. */
  onToolCall: (call: VoiceToolCall, signal: AbortSignal) => Promise<Record<string, unknown>>;
  onStatusChange?: (status: VoiceSessionStatus) => void;
  onError?: (error: Error) => void;
  onInterrupt?: () => void;
}
export interface VoiceBackend {
  readonly id: VoiceProviderId;
  readonly transport: "in-memory" | "websocket";
  readonly status: VoiceSessionStatus;
  /** Native wire formats, not assumptions the audio client must copy. Null means no audio. */
  readonly inputAudioFormat: VoiceAudioFormat | null;
  readonly outputAudioFormat: VoiceAudioFormat | null;
  connect(options: VoiceConnectionOptions): Promise<void>;
  sendAudioChunk(chunk: VoiceAudioChunk): void;
  sendTextMessage(text: string): Promise<void>;
  setMuted(muted: boolean): void;
  disconnect(): Promise<void>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
