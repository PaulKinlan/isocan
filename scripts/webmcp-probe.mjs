// webmcp-probe.mjs — the revision's executable evidence, on real browsers.
//
//   node webmcp-probe.mjs annotations <chromePath> [featureFlag]
//   node webmcp-probe.mjs frames <chromePath> [featureFlag]
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
  frames: (origin, childOrigin) => `<!doctype html><meta charset=utf-8><title>frames ${origin}</title><body>ready<script>
// Register on THIS page for the same-origin conditions; the iframe handles foreign.
window.__results = [];
window.__registerHere = async (exposedTo) => {
  const mc = document.modelContext;
  if (!mc) return "no-api";
  try {
    await mc.registerTool({ name: "probe_local", description: "probe", inputSchema: { type: "object", properties: {} }, execute: async () => "ok" }, exposedTo ? { exposedTo } : undefined);
    return "registered";
  } catch (e) { return "rejected: " + String(e); }
};
window.__discoverLocal = async () => {
  const tools = await document.modelContext.getTools();
  return tools.map((t) => t.name + "@" + (t.origin ?? ""));
};
window.__frame = async (src, allow) => {
  const f = document.createElement("iframe");
  if (allow) f.setAttribute("allow", allow);
  f.src = src;
  document.body.appendChild(f);
  await new Promise((r) => { f.onload = r; setTimeout(r, 4000); });
  return true;
};
window.__discoverAll = async (fromOrigins) => {
  const tools = await document.modelContext.getTools(fromOrigins ? { fromOrigins } : undefined);
  return tools.map((t) => t.name + "@" + (t.origin ?? ""));
};
</script>`,
  child: (origin, parentOrigin) => `<!doctype html><meta charset=utf-8><title>child ${origin}</title><body>ready<script>
window.__child = (async () => {
  const mc = document.modelContext;
  if (!mc) return "no-api";
  try {
    await mc.registerTool({ name: "probe_child", description: "probe", inputSchema: { type: "object", properties: {} }, execute: async () => "ok" }, { exposedTo: ["${parentOrigin}"] });
    return "registered";
  } catch (e) { return "rejected: " + String(e); }
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
  } else if (MODE === "frames") {
    // Parent origin 8942; child origin 8941. Parent also serves a same-origin child path.
    servers.push(await serve(8941, (params) => params.get("child") !== null ? PAGES.child(origin(8941), origin(8942)) : PAGES.frames(origin(8941), origin(8942))));
    servers.push(await serve(8942, () => PAGES.frames(origin(8942), origin(8941))));
    chrome = await launch();
    await chrome.goto(`${origin(8942)}/`);
    const out = { origin, results: [] };
    // 1. same origin, no allow
    out.results.push({ name: "same-origin no allow", detail: await chrome.ev(`(async () => { await window.__frame("${origin(8942)}/", null); return { registered: "n/a (same page)", discovered: await window.__discoverLocal() }; })()`) });
    // 2. same origin, allow="tools"
    out.results.push({ name: 'same-origin allow="tools"', detail: await chrome.ev(`(async () => { await window.__frame("${origin(8942)}/", "tools"); return { discovered: await window.__discoverLocal() }; })()`) });
    // 3. same origin, allow="tools 'none'"
    out.results.push({ name: 'same-origin allow="tools none"', detail: await chrome.ev(`(async () => { await window.__frame("${origin(8942)}/", "tools 'none'"); return { discovered: await window.__discoverLocal() }; })()`) });
    // 4. foreign, no allow (child exposes to the parent)
    out.results.push({ name: "foreign no allow, exposed", detail: await chrome.ev(`(async () => { await window.__frame("${origin(8941)}/?child=1", null); return { child: await (async () => { const f = document.querySelector("iframe"); return f?.contentWindow?.__child ?? "n/a"; })() }; })()`) });
    // 5/6: foreign + allow; exposure decided by the child page (always exposed here; condition 5 covered by 4's policy denial)
    out.results.push({ name: 'foreign allow="tools", exposed', detail: await chrome.ev(`(async () => { await window.__frame("${origin(8941)}/?child=1", "tools"); const f = document.querySelector("iframe"); const childState = await f?.contentWindow?.__child; const all = await window.__discoverAll(["${origin(8941)}"]); const none = await window.__discoverAll(); return { childState, discoveredWithFromOrigins: all, discoveredWithout: none }; })()`) });
    console.log(JSON.stringify(out, null, 1));
  }
} finally {
  if (chrome) await chrome.close().catch(() => {});
  for (const s of servers) s.close();
}
process.exit(0);
