// webmcp-frames.mjs — the discriminating frame-protocol matrix for phase 5.
//
//   node webmcp-frames.mjs <chromePath> [--enable-features=WebMCP]
//
// Parent origin: http://127.0.0.1:8942.  Child origin: http://127.0.0.1:8941.
// Six conditions, each in a fresh iframe, registration awaited, discovery
// sampled three times (no race): the same-origin positives, an explicit policy
// DENIAL, and the three cross-origin policy/exposure combinations. Each result
// carries `scope`, the scope its samples were actually read with — `default`
// for the same-origin conditions, `fromOrigins` for the foreign ones.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const BIN = process.argv[2];
const FLAG = process.argv[3] ?? "";
if (!BIN || !existsSync(BIN)) throw new Error(`chrome not found: ${BIN}`);
const P = 8942, C = 8941;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHILD = (parentOrigin) => `<!doctype html><meta charset=utf-8><body>child<script>
const params = new URLSearchParams(location.search);
const exposed = params.get("exposed") === "1";
(async () => {
  let state = "no-api";
  try {
    const mc = document.modelContext;
    if (mc) {
      await mc.registerTool({ name: "probe_child", description: "probe", inputSchema: { type: "object", properties: {} }, execute: async () => "ok" }, exposed ? { exposedTo: ["${parentOrigin}"] } : undefined);
      state = "registered";
    }
  } catch (e) { state = "rejected: " + String(e); }
  parent.postMessage({ probe: "child", state }, "*");
})();
</script>`;

const PARENT = `<!doctype html><meta charset=utf-8><body>parent<script>
window.__childStates = [];
window.__discover = async (fromOrigins) => {
  const tools = await document.modelContext.getTools(fromOrigins ? { fromOrigins } : undefined);
  return tools.map((t) => t.name);
};
window.__run = async (src, allow, fromOrigins) => {
  const before = window.__childStates.length;
  const f = document.createElement("iframe");
  if (allow !== null) f.setAttribute("allow", allow);
  f.src = src;
  document.body.appendChild(f);
  const deadline = Date.now() + 4000;
  while (window.__childStates.length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const state = window.__childStates[window.__childStates.length - 1] ?? "no-message";
  const samples = [];
  for (let i = 0; i < 3; i++) { samples.push(await window.__discover(fromOrigins)); }
  f.remove();
  return { state, samples };
};
</script>`;

function serve(port, htmlOrFn) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(typeof htmlOrFn === "function" ? htmlOrFn(req.url ?? "/") : htmlOrFn);
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}
const origin = (p) => `http://127.0.0.1:${p}`;

async function launch() {
  const dir = mkdtempSync(path.join(tmpdir(), "webmcp-frames-"));
  const proc = spawn(BIN, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--disable-gpu", ...(FLAG ? [FLAG] : []), "about:blank"], { stdio: "ignore" });
  const file = path.join(dir, "DevToolsActivePort");
  const deadline = Date.now() + 30000;
  let endpoint;
  for (;;) {
    if (proc.exitCode !== null) throw new Error("chrome exited early");
    try { const [port, wsPath] = readFileSync(file, "utf8").split("\n"); if (port && wsPath) { endpoint = `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`; break; } } catch {}
    if (Date.now() > deadline) throw new Error("no DevTools endpoint");
    await sleep(50);
  }
  const bws = new WebSocket(endpoint, { maxPayload: 1 << 28 });
  await new Promise((r, j) => { bws.once("open", r); bws.once("error", j); });
  let bid = 0; const bp = new Map();
  bws.on("message", (d) => { const m = JSON.parse(d); if (m.id && bp.has(m.id)) { bp.get(m.id)(m); bp.delete(m.id); } });
  const bsend = (method, params = {}) => { const id = ++bid; bws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => bp.set(id, (m) => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); };
  const { targetId } = await bsend("Target.createTarget", { url: "about:blank" });
  const wsUrl = endpoint.replace(/\/devtools\/browser\/.*$/, `/devtools/page/${targetId}`);
  const ws = new WebSocket(wsUrl, { maxPayload: 1 << 28 });
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0; const pending = new Map();
  ws.on("message", (d) => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => { const mid = ++id; ws.send(JSON.stringify({ id: mid, method, params })); return new Promise((res, rej) => pending.set(mid, (m) => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); };
  await send("Page.enable"); await send("Runtime.enable");
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`probe threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  };
  const goto = async (url) => { await send("Page.navigate", { url }); for (let i = 0; i < 100; i++) { if (await ev(`document.readyState === "complete"`).catch(() => false)) return; await sleep(100); } };
  const close = async () => { try { ws.terminate(); bws.terminate(); } catch {} proc.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); };
  return { send, ev, goto, close };
}

const servers = [];
let chrome;
try {
  servers.push(await serve(C, CHILD(origin(P))));
  // The same-origin child lives at the PARENT's origin under ?child=1, so the
  // only variable between conditions 1-3 is the frame's allow attribute.
  servers.push(await serve(P, (url) => url.includes("child=1") ? CHILD(origin(P)) : PARENT));
  chrome = await launch();
  await chrome.goto(`${origin(P)}/`);
  await chrome.ev(`window.addEventListener("message", (e) => { if (e.data && e.data.probe === "child") window.__childStates.push(e.data.state); }); true`);
  const conditions = [
    ["1 same-origin, no allow (default self)", `${origin(P)}/?child=1`, null, null],
    ["2 same-origin, allow=tools", `${origin(P)}/?child=1`, "tools", null],
    ["3 same-origin, allow=\"tools 'none'\" (policy denial)", `${origin(P)}/?child=1`, "tools 'none'", null],
    ["4 foreign, no allow, exposed", `${origin(C)}/?exposed=1`, null, null],
    ["5 foreign, allow=tools, NOT exposed", `${origin(C)}/?exposed=0`, "tools", null],
    ["6 foreign, allow=tools, exposed", `${origin(C)}/?exposed=1`, "tools", null],
  ];
  const results = [];
  for (const [name, src, allow, fromOrigins] of conditions) {
    const foreign = src.startsWith(origin(C));
    const scope = foreign ? [origin(C)] : null;
    const detail = await chrome.ev(`window.__run(${JSON.stringify(src)}, ${JSON.stringify(allow)}, ${scope ? JSON.stringify(scope) : "undefined"})`);
    // Label each sample by the read that ACTUALLY happened: the same-origin
    // conditions read with the default scope, the foreign ones scoped to the
    // child origin. There is no paired read of the other scope, and a read
    // taken after __run removes the iframe returns [] for every case — so
    // neither is emitted. (The first version of this probe printed the scoped
    // samples under `discoveredDefault` and paired them with an always-empty
    // post-removal `discoveredScoped`.)
    results.push({ name, child: detail.state, scope: scope ? "fromOrigins" : "default", samples: detail.samples });
  }
  console.log(JSON.stringify({ parent: origin(P), child: origin(C), results }, null, 1));
} finally {
  if (chrome) await chrome.close().catch(() => {});
  for (const s of servers) s.close();
}
process.exit(0);
