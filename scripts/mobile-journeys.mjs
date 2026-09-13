#!/usr/bin/env node
/** Actual touch input, against a synthetic daemon and a fresh browser badge. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { browser, throughTheDoor, until } from "./lib/browser.mjs";
import { DaemonClient, connect } from "../index.mjs";
const { startDaemon } = await import("@isocan/server");
const { newCanvasId } = await import("@isocan/core");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const home = await mkdtemp(path.join(tmpdir(), "isocan-mobile-"));
const out = process.env.MOBILE_PROOF_DIR;
if (out) await mkdir(out, { recursive: true });
const daemon = await startDaemon({ home, port: 0, contentPort: 0, auth: null, birthHome: null });
const port = daemon.app.server.address().port;
const origin = `http://127.0.0.1:${port}`;
const b = await browser();
const touch = (type, points) => b.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y, id = 1]) => ({ x, y, id })) });
async function size(width, touchEnabled = true) {
  await b.send("Emulation.setDeviceMetricsOverride", { width, height: 812, deviceScaleFactor: 1, mobile: touchEnabled });
  await b.send("Emulation.setTouchEmulationEnabled", { enabled: touchEnabled, maxTouchPoints: 5 });
}
async function tap(selector) {
  const box = await b.ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2; return { x, y, hit: e.contains(document.elementFromPoint(x,y)) }; })()`);
  assert(box?.hit, `${selector} is reachable`);
  await touch("touchStart", [[box.x, box.y]]); await touch("touchEnd", []); await pause(200);
}
async function shot(name) { if (out) { const { data } = await b.send("Page.captureScreenshot", { format: "png" }); await writeFile(path.join(out, `${name}.png`), Buffer.from(data, "base64")); } }
try {
  process.env.ISOCAN_HOME = home;
  const client = new DaemonClient(origin, home);
  await client.claimActor({ type: "actor.claim", name: "Fixture", sessionKey: "proof:mobile" });
  const h = await connect({ port, identity: { session: "mobile", harness: "proof" } });
  const id = newCanvasId();
  await client.sendOp(null, h.actor, { type: "project.create", canvasId: id, title: "Acme mobile" });
  const canvas = await h.canvas(id);
  await canvas.add({ title: "First", content: "# First\nA synthetic mobile example.", mime: "text/markdown", at: { x: 0, y: 0 }, size: { width: 300, height: 240 } });
  await canvas.add({ title: "Second", content: "# Second\nThe next node.", mime: "text/markdown", at: { x: 500, y: 0 }, size: { width: 300, height: 240 } });
  await size(375);
  const loaded = b.once("Page.loadEventFired"); await b.send("Page.navigate", { url: origin }); await loaded;
  await throughTheDoor(b, origin, "Morgan", "mobile-proof");
  await b.ev('localStorage.setItem("isocan.minimap", "1")');
  await b.send("Page.navigate", { url: `${origin}/p/${id}` });
  await until(b, '!!document.querySelector(".world")', "the canvas");
  const rail = await b.ev('[...document.querySelectorAll(".tool-rail button")].filter(e=>e.getBoundingClientRect().width).map(e=>({name:e.getAttribute("aria-label"),w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height}))');
  assert.deepEqual(rail.map((x) => x.name), ["Hand", "Comment", "More tools"]);
  assert(rail.every((x) => x.w >= 44 && x.h >= 44), "44px primary controls");
  await tap('[aria-label="More tools"]'); await until(b, 'document.querySelector(".tool-rail").classList.contains("tools-expanded")', "expanded tools");
  await tap('[aria-label="More tools"]');
  const viewport = () => b.ev('document.querySelector(".world").style.transform');
  const before = await viewport();
  await touch("touchStart", [[100, 620]]); await touch("touchMove", [[140, 660]]); await touch("touchMove", [[150, 670]]); await touch("touchEnd", []);
  assert.notEqual(await viewport(), before, "one finger pans");
  await pause(650); assert.equal(await b.ev('!!document.querySelector(".context-menu")'), false, "motion cancels long press");
  const prePinch = await viewport();
  await touch("touchStart", [[100, 600], [180, 600, 2]]); await touch("touchMove", [[60, 600], [220, 600, 2]]); await touch("touchEnd", []);
  assert.notEqual(await viewport(), prePinch, "two fingers pinch");
  await pause(650); assert.equal(await b.ev('!!document.querySelector(".context-menu")'), false, "second touch cancels long press");
  await touch("touchStart", [[100, 620]]); await pause(700);
  await until(b, '!!document.querySelector(".context-menu")', "stationary long press menu");
  await touch("touchEnd", []); await shot("touch-controls");
  await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27 });
  await size(768); assert.equal(await b.ev('localStorage.getItem("isocan.minimap")'), "1");
  const tablet = await viewport(); await touch("touchStart", [[100, 620]]); await touch("touchMove", [[160, 620]]); await touch("touchEnd", []); assert.notEqual(await viewport(), tablet, "tablet touch pans");
  await size(375, false); const mouseBefore = await viewport();
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 620, button: "left", buttons: 1, clickCount: 1 });
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 160, y: 680, button: "left", buttons: 1 });
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 160, y: 680, button: "left", buttons: 0, clickCount: 1 });
  assert.equal(await viewport(), mouseBefore, "narrow mouse selects instead of panning");
  assert.deepEqual(b.takeErrors(), []); console.log("PASS stage 0: rail, pan, pinch, cancellation, tablet, narrow mouse, preference");
} finally {
  await b.close(); await daemon.close();
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
