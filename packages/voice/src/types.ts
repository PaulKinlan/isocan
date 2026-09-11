/**
 * Types for the provider-agnostic voice interface (@isocan/voice).
 */

export type VoiceProviderId = "simulated" | "gemini" | "openai";

export type VoiceSessionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "listening"
  | "speaking"
  | "muted"
  | "error";

export interface VoiceToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface VoiceToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface VoiceToolResult {
  callId: string;
  name: string;
  result: Record<string, unknown>;
}

export interface VoiceConnectionOptions {
  voiceName?: string;
  systemInstruction?: string;
  tools: VoiceToolDeclaration[];
  onAudioOut: (pcm24k: Uint8Array) => void;
  onTranscript: (speaker: "user" | "agent", text: string, isFinal: boolean) => void;
  onToolCall: (call: VoiceToolCall) => Promise<Record<string, unknown>>;
  onStatusChange?: (status: VoiceSessionStatus) => void;
  onError?: (error: Error) => void;
  onInterrupt?: () => void;
}

export interface VoiceBackend {
  readonly id: VoiceProviderId;
  readonly status: VoiceSessionStatus;

  connect(options: VoiceConnectionOptions): Promise<void>;
  sendAudioChunk(pcm16k: Uint8Array): void;
  sendTextMessage(text: string): void;
  disconnect(): Promise<void>;
}
