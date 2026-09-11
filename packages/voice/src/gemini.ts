import { WebSocketVoiceBackend, type RemoteVoiceOptions } from "./websocket.ts";
export type GeminiLiveOptions = RemoteVoiceOptions;

export class GeminiLiveBackend extends WebSocketVoiceBackend {
  constructor(options: GeminiLiveOptions) { super("gemini", options); }
}
