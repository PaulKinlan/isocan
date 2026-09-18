// webmcp-probe.mjs — the revision's executable evidence, on real browsers.
//
//   node scripts/webmcp-probe.mjs <chromePath> [--enable-features=WebMCP] [mode]
//
// The binary comes FIRST; `mode` defaults to `annotations` and is the only mode
// here. The frame-protocol conditions live in scripts/webmcp-frames.mjs, which
// runs the six-condition matrix — this probe's old five-condition `frames` mode
// was stale (same-origin children never invoke registration, and its case 5 was
// mislabelled) and is deleted rather than advertised beside the real one.
//
// Minimal owned-Chrome CDP driver (the repo's launchChrome does not take
// feature flags; WebMCP on stable 152 needs --enable-features=WebMCP).
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
const MODE = process.argv[4] ?? "annotations";
if (!BIN || !existsSync(BIN)) throw new Error(`chrome not found: ${BIN}`);
const CHILD_ORIGIN = "http://127.0.0.1:8941";
const PARENT_ORIGIN = "http://127.0.0.1:8942";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const dir = mkdtempSync(path.join(tmpdir(), "webmcp-probe-"));
  const proc = spawn(BIN, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`,
    "--no-first-run", "--disable-gpu",
    ...(FLAG ? [FLAG] : []),
    "about:blank",
  ], { stdio: "ignore" });
  const file = path.join(dir, "DevToolsActivePort");
  const deadline = Date.now() + 30000;
  let endpoint;
  for (;;) {
    if (proc.exitCode !== null) throw new Error("chrome exited early");
    try {
      const [port, wsPath] = readFileSync(file, "utf8").split("\n");
      if (port && wsPath) { endpoint = `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`; break; }
    } catch { /* not there yet */ }
    if (Date.now() > deadline) throw new Error("no DevTools endpoint");
    await sleep(50);
  }
  const browserWs = new WebSocket(endpoint, { maxPayload: 1 << 28 });
  await new Promise((r, j) => { browserWs.once("open", r); browserWs.once("error", j); });
  let bid = 0; const bpending = new Map();
  browserWs.on("message", (d) => { const m = JSON.parse(d); if (m.id && bpending.has(m.id)) { bpending.get(m.id)(m); bpending.delete(m.id); } });
  const bsend = (method, params = {}) => { const id = ++bid; browserWs.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => bpending.set(id, (m) => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); };
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
  const close = async () => { try { ws.terminate(); browserWs.terminate(); } catch {} proc.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); };
  return { send, ev, goto, close };
}

const PAGES = {
  annotations: (origin) => `<!doctype html><meta charset=utf-8><title>annotations</title><body>ready<script>
window.__probe = (async () => {
  const out = { globals: { document: typeof document.modelContext, navigator: typeof navigator.modelContext }, tools: [] };
  const mc = document.modelContext;
  if (!mc) return out;
  const cases = [
    ["all-false", { readOnlyHint: false, untrustedContentHint: false, consequentialHint: false, debugging: false }],
    ["all-true", { readOnlyHint: true, untrustedContentHint: true, consequentialHint: true, debugging: true }],
    ["consequential-true-only", { readOnlyHint: false, untrustedContentHint: false, consequentialHint: true, debugging: false }],
    ["debugging-true-only", { readOnlyHint: false, untrustedContentHint: false, consequentialHint: false, debugging: true }],
    ["readonly-true-only", { readOnlyHint: true, untrustedContentHint: false, consequentialHint: false, debugging: false }],
  ];
  for (const [name, annotations] of cases) {
    await mc.registerTool({ name: "probe_" + name.replace(/-/g, "_"), description: "probe", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, annotations, execute: async ({ a, b }) => "sum=" + (a + b) });
  }
  const tools = await mc.getTools();
  out.tools = tools.map((t) => ({ name: t.name, annotations: t.annotations ?? null }));
  // the executeTool input shape, from the successful call
  const mine = tools.find((t) => t.name === "probe_readonly_true_only");
  try { out.executeObject = await mc.executeTool(mine, { a: 2, b: 3 }); } catch (e) { out.executeObject = "ERR " + String(e); }
  try { out.executeJsonString = await mc.executeTool(mine, '{"a":2,"b":3}'); } catch (e) { out.executeJsonString = "ERR " + String(e); }
  return out;
})();
</script>`,
};

function serve(port, htmlFor) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(htmlFor(new URL(req.url, `http://127.0.0.1:${port}`).searchParams));
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}

const origin = (p) => `http://127.0.0.1:${p}`;
const servers = [];
let chrome;
try {
  if (MODE === "annotations") {
    servers.push(await serve(8941, () => PAGES.annotations(origin(8941))));
    chrome = await launch();
    await chrome.goto(`${origin(8941)}/`);
    await chrome.ev(`window.__probe`); // wait for the async probe
    await sleep(500);
    console.log(JSON.stringify(await chrome.ev(`window.__probe`), null, 1));
  } else {
    throw new Error(`unknown mode: ${MODE} — this probe measures annotations; the six frame conditions live in scripts/webmcp-frames.mjs`);
  }
} finally {
  if (chrome) await chrome.close().catch(() => {});
  for (const s of servers) s.close();
}
process.exit(0);
