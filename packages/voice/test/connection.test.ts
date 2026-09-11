import { once } from "node:events";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { GeminiLiveBackend } from "../src/gemini.ts";

it("Gemini connect waits for provider setupComplete, not merely an open socket", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no fixture port");
  const backend = new GeminiLiveBackend({
    apiKey: "synthetic-local-fixture-key", model: "models/synthetic",
    endpoint: `ws://127.0.0.1:${address.port}`,
  });
  const peer = once(server, "connection");
  let settled = false;
  const ready = backend.connect({
    tools: [], onAudioOut() {}, onTranscript() {}, async onToolCall() { return {}; },
  });
  const observed = ready.then(() => { settled = true; }, () => { settled = true; });
  try {
    const [socket] = await peer;
    const [frame] = await once(socket, "message");
    expect(JSON.parse(frame.toString()).setup.model).toBe("models/synthetic");
    expect(settled).toBe(false);
    expect(backend.status).toBe("connecting");
    socket.send(JSON.stringify({ setupComplete: {} }));
    await ready;
    expect(backend.status).toBe("connected");
  } finally {
    await backend.disconnect();
    await observed;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
