import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * **`/voice` is a second entry, not a route.**
 *
 * `voice.html` is the standalone microphone page: no router, no identity gate,
 * no React — see `src/voice/main.ts`. Vite serves any `.html` at its own
 * address, so the only thing this plugin does is spell the address without the
 * extension: `/voice` must open the microphone, not the app shell's "pick a
 * name" door.
 *
 * It is deliberately NOT in `build.rollupOptions.input`. Adding a second Rollup
 * entry splits the app's first-visit chunk and moves the cursor art out of it —
 * `cursorart.test.ts`'s "keeps the shapes out of what a first visit downloads"
 * caught exactly that. This page is a local surface served by Vite, and the
 * app's first visit is not going to pay for it.
 */
function voiceEntry(): Plugin {
  const rewrite = (url: string | undefined): string | undefined => {
    if (url === "/voice") return "/voice.html";
    if (url?.startsWith("/voice?")) return "/voice.html" + url.slice("/voice".length);
    return url;
  };
  return {
    name: "voice-entry",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        req.url = rewrite(req.url);
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), voiceEntry()],
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
