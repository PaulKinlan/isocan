import { WebSocketVoiceBackend, type RemoteVoiceOptions } from "./websocket.ts";
export type OpenAIRealtimeOptions = RemoteVoiceOptions;

export class OpenAIRealtimeBackend extends WebSocketVoiceBackend {
  constructor(options: OpenAIRealtimeOptions) { super("openai", options); }
}
