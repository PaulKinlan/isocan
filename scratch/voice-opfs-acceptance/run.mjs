// The bead's evidence, run against the shipped page: write a memory, RELOAD
// the page and read it back, then CLOSE the browser entirely, reopen it with
// the same profile, and read it again.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const CHROME = "/usr/bin/google-chrome-stable";
const PAGE = "http://127.0.0.1:5201/voice.html";
const PROFILE = "/tmp/voice-opfs-profile";
const PORT = 9350;

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch() {
  return spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-sync", "--disable-extensions", "--disable-component-update",
    "--password-store=basic", "--use-mock-keychain", "--mute-audio", "--window-size=1440,900",
    PAGE,
  ], { stdio: "ignore" });
}

let id = 0;
function driver(ws) {
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const mine = ++id;
    pending.set(mine, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
      const page = list.find((one) => one.type === "page" && String(one.url).includes("voice.html"));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => ws.addEventListener("open", r));
        const send = driver(ws);
        await send("Page.enable");
        return {
          ws,
          send,
          evaluate: async (expression) => {
            const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
            if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
            return result.result.value;
          },
        };
      }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("chrome never offered the page");
}

/** What the panel says, plus what OPFS actually holds. */
const READ = `(async () => {
  const panel = {
    summary: document.getElementById("memory-summary")?.textContent ?? null,
    note: document.getElementById("memory-note")?.textContent ?? null,
    rows: [...document.querySelectorAll("#memory-list li")].map((li) => li.textContent),
  };
  let opfs = null;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("voice");
    const file = await dir.getFileHandle("memories.json");
    const text = await (await file.getFile()).text();
    opfs = { entries: JSON.parse(text).length, first: JSON.parse(text)[0]?.text ?? null };
  } catch (err) {
    opfs = { error: String(err && err.message ? err.message : err) };
  }
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
  return { panel, opfs, persisted };
})()`;

const chrome1 = launch();
await sleep(3500);
const session1 = await connect();
for (let i = 0; i < 20; i++) {
  const seen = await session1.evaluate(READ);
  if ((seen.panel.rows ?? []).length >= 2) break;
  await sleep(400);
}
const written = await session1.evaluate(READ);
console.log("1. after the page's migration wrote them:", JSON.stringify(written, null, 1));

// 2. RELOAD the page.
await session1.send("Page.reload", { ignoreCache: true });
await sleep(3000);
const afterReload = await session1.evaluate(READ);
console.log("2. after a page reload:", JSON.stringify(afterReload, null, 1));

// 3. CLOSE THE BROWSER ENTIRELY.
session1.ws.close();
chrome1.kill("SIGKILL");
await sleep(1500);

// 4. Reopen with the same profile — a different browser process.
const chrome2 = launch();
await sleep(3500);
const session2 = await connect();
const afterRestart = await session2.evaluate(READ);
console.log("3. after closing the browser and reopening:", JSON.stringify(afterRestart, null, 1));

// 5. The person's delete, then the claim that it stays deleted.
const forgotten = await session2.evaluate(`(async () => {
  const buttons = [...document.querySelectorAll("#memory-list li button")];
  buttons[0]?.click();
  await new Promise((r) => setTimeout(r, 600));
  return document.getElementById("memory-summary")?.textContent ?? null;
})()`);
console.log("4. after the person forgets one:", forgotten);

session2.ws.close();
chrome2.kill("SIGKILL");

const ok =
  (written.panel.rows ?? []).length === 2 &&
  (afterReload.panel.rows ?? []).length === 2 &&
  (afterRestart.panel.rows ?? []).length === 2 &&
  written.opfs?.entries === 2 &&
  afterRestart.opfs?.entries === 2;
console.log(ok ? "ACCEPTANCE: PASS" : "ACCEPTANCE: FAIL");
process.exit(ok ? 0 : 1);
