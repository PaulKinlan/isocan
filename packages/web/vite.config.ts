import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * **The page's own port, and it is declared in the page's own config.**
 *
 * `packages/voice-agent/vite.config.ts` binds this; the redirect below names it
 * because a redirect has to name something. Change it there and here.
 */
const VOICE_PORT = 5200;

/**
 * **`/voice` still opens the microphone; the page just lives elsewhere now.**
 *
 * `voice.html` used to be a second entry in this app — served by this config,
 * with `/harness` proxied here so the page's audio socket was same-origin. The
 * page is now `packages/voice-agent`, with its own server, its own `/harness`
 * proxy and its own build, so this config's whole remaining interest in it is
 * the address people already have.
 *
 * **A redirect, not a proxy** (option A of the extraction plan). Proxying under
 * a prefix would have needed `base: "/voice/"` on the page and every asset and
 * module path rewritten under it — a mistake in the prefix is a silent 404 on a
 * module, which is the shape of bug this project keeps excavating. Redirecting
 * leaves the page's origin the server that serves it, so HMR and `/harness/audio`
 * stay same-origin for free, and the app server being down does not take the
 * page with it.
 *
 * **The host comes from the request, not from a constant.** Vite's dev server
 * binds `localhost`, which resolves to `::1` here, and this repo's own docs
 * record the day `http://127.0.0.1:5173` stopped answering because of it. A
 * hardcoded target would hand that surprise to whoever typed the other name;
 * swapping only the port keeps the name they used.
 */
function voiceRedirect(): Plugin {
  return {
    name: "voice-redirect",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        // Exactly `/voice`, with or without a query — not `/voice/`, which is
        // not an address this page has ever had.
        if (url !== "/voice" && !url.startsWith("/voice?")) return next();
        const host = (req.headers.host ?? "localhost").replace(/:\d+$/, "");
        res.statusCode = 302;
        res.setHeader("Location", `http://${host}:${VOICE_PORT}${url}`);
        res.end();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), voiceRedirect()],
  server: {
    port: 5173,
    // /ws is deliberately NOT proxied: the client connects its WebSocket
    // straight to the daemon in dev (see canvasStore.wsUrl) — the proxy hop
    // spammed EPIPE stacks whenever the daemon restarted mid-write.
    proxy: {
      "/api": "http://127.0.0.1:4441",
    },
  },
});
