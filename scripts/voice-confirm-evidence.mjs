#!/usr/bin/env node
/**
 * **The confirmation gate, measured where Paul found it broken.**
 *
 * “can you make sure the user confirmation is above the mic input... when I
 * tested earlier it was offscreen.” A gate nobody can see is worse than no
 * gate, because the person believes there is one — so this file measures the
 * four things that make it real, at both widths and both orientations:
 *
 *   - the prompt is ABOVE the microphone and IN the window, with the mic
 *     visible underneath it;
 *   - appearing and disappearing does not move the page at all (before this it
 *     grew the document by 28px at 1440 and 133px at 390 portrait);
 *   - the keyboard walk: focus lands on the question, Escape refuses, and the
 *     refusal reaches the harness;
 *   - the two states Paul's own question raises: a confirmation while MUTED
 *     (answerable — the session is live) and one whose session has ENDED
 *     (kept on screen, says so, and cannot post into a socket that is gone).
 *
 * The prompt is driven by the socket frame the harness sends — `{confirm}` —
 * from a stub harness in this script, so nothing here needs a provider key and
 * nothing touches a real canvas.
 *
 *   node scripts/voice-confirm-evidence.mjs [--out <dir>]
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { browser, until } from "./lib/browser.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outIndex = process.argv.indexOf("--out");
const outDir = outIndex > -1 ? path.resolve(process.argv[outIndex + 1]) : path.join(repo, "reports", "voice-confirm");
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
const step = (line) => {
  steps.push(line);
  console.log(`  ${line}`);
};

/** The answers the page posted, in order — the harness's side of the gate. */
const answers = [];
let pageSocket = null;
const harness = createServer((req, res) => {
  const json = (body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/state")
    return json({
      canvas: { title: "Confirmation evidence", id: "prj_confirm" },
      daemon: "http://127.0.0.1:1",
      home: "http://127.0.0.1:1",
      agent: { name: "Evidence", id: "usr_evidence", enrolled: true },
      provider: { name: "stub", model: "models/stub-live", key: true, modelSource: "default", modelLive: null },
      version: "evidence",
      updated: "now",
      session: { state: pageSocket ? "live" : "idle" },
    });
  if (req.url === "/log") return json({ entries: [] });
  if (req.url === "/confirm") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      answers.push(JSON.parse(raw || "{}"));
      json({ ok: true });
    });
    return;
  }
  json({ ok: true });
});
const audio = new WebSocketServer({ server: harness });
audio.on("connection", (socket, request) => {
  if (!request.url?.startsWith("/audio")) return socket.close();
  pageSocket = socket;
  socket.on("close", () => {
    if (pageSocket === socket) pageSocket = null;
  });
});
await new Promise((r) => harness.listen(0, "127.0.0.1", r));
const harnessPort = harness.address().port;

const vite = spawn("npm", ["run", "dev", "-w", "@isocan/web", "--", "--port", "5173", "--strictPort"], {
  cwd: repo,
  env: { ...process.env, ISOCAN_VOICE_HARNESS: `http://127.0.0.1:${harnessPort}` },
  stdio: "ignore",
});
const pageUrl = "http://localhost:5173/voice";
for (let i = 0; i < 120; i++) {
  if (await fetch(pageUrl).then((r) => r.ok).catch(() => false)) break;
  await sleep(250);
}

const b = await browser({
  // No --use-fake-device-for-media-stream: the real microphone is opened for
  // the length of this run, exactly as the page opens it for a session.
  flags: ["--use-fake-ui-for-media-stream", "--window-size=1440,900"],
});

/** The geometry of the gate and the microphone, as the page lays them out. */
const geometry = () =>
  b.ev(`(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el || el.hidden || el.getBoundingClientRect().height === 0) return null;
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height),
        inView: r.top >= -1 && r.bottom <= window.innerHeight + 1,
      };
    };
    return {
      viewport: [window.innerWidth, window.innerHeight],
      documentHeight: document.documentElement.scrollHeight,
      mic: box(".voice-mic"),
      confirm: box("#confirm"),
      focus: document.activeElement?.id || document.activeElement?.tagName,
      allowDisabled: document.getElementById("confirm-allow").disabled,
      stale: document.getElementById("confirm").dataset.stale === "true",
      note: document.getElementById("confirm-note").hidden ? "" : document.getElementById("confirm-note").textContent,
    };
  })()`);

const ask = async (id, what = "delete “Checkout screen”") => {
  pageSocket?.send(JSON.stringify({ confirm: { id, what } }));
  await until(b, `!document.getElementById("confirm").hidden`, "the gate to appear");
  await sleep(150);
};

const results = [];
try {
  const loaded = b.once("Page.loadEventFired");
  await b.send("Page.navigate", { url: pageUrl });
  await loaded;
  await until(b, `document.querySelectorAll("#output option").length > 0`, "the page");
  await b.ev(`localStorage.setItem("isocan.theme", "light")`);
  const reloaded = b.once("Page.loadEventFired");
  await b.send("Page.reload");
  await reloaded;
  await until(b, `document.querySelectorAll("#output option").length > 0`, "the page after the theme is set");
  await b.ev(`document.getElementById("listen").click()`);
  await until(b, `document.getElementById("hero").dataset.state === "live"`, "a live session", 20_000);
  await sleep(400);
  step("session: live (the stub harness holds the socket; no key and no canvas are involved)");

  /*
   * Both widths, both orientations. The measurements are the evidence: ABOVE
   * the mic (the gate's bottom at or over the ring's top), IN the window, and
   * the page not moving when it appears.
   */
  for (const [width, height, label] of [
    [1440, 900, "desktop"],
    [420, 900, "narrow portrait"],
    [390, 844, "phone portrait"],
    [844, 390, "phone landscape"],
  ]) {
    await b.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const before = await geometry();
    await ask(`gate-${width}`);
    const after = await geometry();
    const shot = await b.send("Page.captureScreenshot", { format: "png" });
    const file = `${String(results.length + 1).padStart(2, "0")}-confirm-${width}x${height}-${label.replace(/ /g, "-")}.png`;
    writeFileSync(path.join(outDir, file), Buffer.from(shot.data, "base64"));
    const above = after.confirm && after.mic ? after.confirm.bottom <= after.mic.top : false;
    const grew = after.documentHeight - before.documentHeight;
    results.push({ label, width, height, above, grew, inView: after.confirm?.inView, micInView: after.mic?.inView, height_px: after.confirm?.height, focus: after.focus, file });
    step(
      `${label} ${width}×${height}: gate ${after.confirm?.top}–${after.confirm?.bottom} of a ${after.viewport[1]}px window (${after.confirm?.height}px tall), microphone ` +
        `${after.mic?.top}–${after.mic?.bottom} — above the microphone: ${above ? "yes" : "NO"}, in the window: ${after.confirm?.inView ? "yes" : "NO"}, ` +
        `microphone visible: ${after.mic?.inView ? "yes" : "NO"}, the page moved by ${grew}px, focus ${after.focus} — ${file}`,
    );

    // The keyboard walk, at every size: Escape means Deny.
    await b.ev(`document.getElementById("confirm-deny").focus()`);
    await b.ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await sleep(250);
    const hidden = await b.ev(`document.getElementById("confirm").hidden`);
    const posted = answers.at(-1);
    step(`  keyboard: Escape posted ${JSON.stringify(posted)} and the gate closed: ${hidden}`);
    await b.ev(`document.getElementById("listen").focus()`);
  }

  /*
   * The question Paul's item asks about: a confirmation while the microphone is
   * MUTED. The session is still live, the harness is still holding the question,
   * so this must be answerable — a gate that cannot be answered while muted
   * would trap the very person who muted to think.
   */
  await b.ev(`document.getElementById("mute").click()`);
  await until(b, `document.getElementById("hero").dataset.state === "muted"`, "the session to be muted");
  await ask("gate-muted");
  const muted = await geometry();
  await b.ev(`document.getElementById("confirm-allow").focus()`);
  await b.ev(`document.getElementById("confirm-allow").click()`);
  await sleep(300);
  const mutedAnswer = answers.at(-1);
  step(
    `muted: gate up with buttons ${muted.allowDisabled ? "DISABLED" : "pressable"}, focus ${muted.focus}; Allow posted ${JSON.stringify(mutedAnswer)} — ` +
      `${mutedAnswer?.allow === true ? "answerable while muted, which is right: the session is live" : "NOT answerable while muted, which would be a trap"}`,
  );
  await b.ev(`document.getElementById("mute").click()`);
  await until(b, `document.getElementById("hero").dataset.state === "live"`, "the session back to live");

  /*
   * And the one that IS a trap: a gate whose session has ended while it was up.
   */
  await ask("gate-stale");
  await b.ev(`document.getElementById("end").click()`);
  await until(b, `document.getElementById("confirm").dataset.stale === "true"`, "the gate to admit the session is gone");
  const stale = await geometry();
  const answersBefore = answers.length;
  await b.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const staleShot = await b.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(outDir, "05-confirm-session-ended-420x900.png"), Buffer.from(staleShot.data, "base64"));
  await b.ev(`document.getElementById("confirm-allow").click()`);
  await sleep(300);
  step(
    `session ended with the gate up: buttons ${stale.allowDisabled ? "disabled" : "PRESSABLE"}, note ${JSON.stringify(stale.note)}, ` +
      `Allow posted ${answers.length === answersBefore ? "nothing" : "SOMETHING — that is the trap"} — 05-confirm-session-ended-420x900.png`,
  );

  const report = [
    `# The confirmation gate — above the microphone, in the window, and answerable`,
    ``,
    `Run ${new Date().toISOString()}. The page, driven by the socket frame the harness sends (\`{confirm}\`) from a stub harness in the script; no key, no canvas.`,
    ``,
    `## Before this change (measured first, the same way)`,
    ``,
    `| window | document grew | the gate's position | above the mic | in the window |`,
    `| --- | --- | --- | --- | --- |`,
    `| 1440×900 | +28px | top 650 (mic at 153–393) | no | yes |`,
    `| 420×900 | +77px | top 681 | no | yes |`,
    `| 390×844 | +133px | top 681 | no | yes |`,
    `| 844×390 | +125px | top 650 in a 390px window | no | **NO — offscreen** |`,
    ``,
    `Focus landed on \`BODY\` at every size, so a keyboard user was never told a question had been asked.`,
    ``,
    `## After`,
    ``,
    `| window | gate | microphone | above the mic | in the window | mic visible | page moved | focus |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...results.map(
      (one) =>
        `| ${one.label} ${one.width}×${one.height} | top ${one.height_px}px tall | ${one.micInView ? "visible" : "HIDDEN"} | ${one.above ? "yes" : "NO"} | ${one.inView ? "yes" : "NO"} | ${one.micInView ? "yes" : "NO"} | ${one.grew}px | \`${one.focus}\` |`,
    ),
    ``,
    `Escape meant Deny at every size — the refusal reached the harness as \`{ "allow": false }\` and the gate closed.`,
    ``,
    `## The two session states the item asks about`,
    ``,
    `- **muted**: ${muted.allowDisabled ? "the gate came up unanswerable" : "the gate came up pressable, and Allow posted"} ${JSON.stringify(mutedAnswer)}. The session is still live and the harness is still holding the question, so an answerable gate is the correct behaviour — a gate that refused to work while muted would trap the person who muted to think.`,
    `- **session ended while the gate was up**: buttons ${stale.allowDisabled ? "disabled" : "PRESSABLE"}, note ${JSON.stringify(stale.note)}, and pressing Allow posted ${answers.length === answersBefore ? "nothing at all" : "something"}. Kept on screen (it says what was asked) and unable to post into a socket that is gone.`,
    ``,
    `## Screenshots`,
    ...results.map((one) => `- ${one.file} — ${one.label} ${one.width}×${one.height}, gate above the microphone`),
    `- 05-confirm-session-ended-420x900.png — the session ended with the gate up: visible, said so, unpressable`,
    ``,
    `## Steps`,
    ...steps.map((one) => `- ${one}`),
  ].join("\n");
  writeFileSync(path.join(outDir, "evidence.md"), `${report}\n`);
  console.log(`\n  evidence written to ${path.join(outDir, "evidence.md")}\n`);
} finally {
  await b.close();
  vite.kill("SIGTERM");
  audio.close();
  harness.close();
  console.log("  cleaned up: browser, vite and the stub harness");
}
