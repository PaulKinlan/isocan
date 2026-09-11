import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // /ws is deliberately NOT proxied: the client connects its WebSocket
    // straight to the daemon in dev (see canvasStore.wsUrl) — the proxy hop
    // spammed EPIPE stacks whenever the daemon restarted mid-write.
    proxy: {
      "/api": "http://127.0.0.1:4441",
      // The voice harness, same-origin so the daemon needs no CORS header and
      // the audio socket survives HMR. `ws: true` for /harness/audio.
      "/harness": {
        target: "http://127.0.0.1:7654",
        changeOrigin: true,
        ws: true,
        rewrite: (path: string) => path.replace(/^\/harness/, ""),
      },
    },
  },
});
