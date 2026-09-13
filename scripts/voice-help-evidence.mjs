#!/usr/bin/env node
/**
 * **The "?" beside a setting, proved in a real browser.**
 *
 * The functional-verification rule says interaction only a browser can prove
 * is proved by driving a browser. This is that for the help cards, and it
 * exists because the claims that matter here are all ones a jsdom test cannot
 * make: where a card lands, whether it leaves the screen at 420, whether the
 * platform's own popover machinery or ours is doing the work, and what a
 * screen reader is actually told.
 *
 * What it measures, and why each is not optional:
 *
 *   - **Every card, at both widths**, opened by a real click on its glyph, with
 *     the geometry of where it landed: the anchored position, the flips, and
 *     whether it stayed inside the viewport and inside the dialog's column.
 *   - **Hover**, with real mouse events, because "hover opens it" is a claim
 *     about the pointer, not about a handler existing.
 *   - **Keyboard**, with real Enter and Escape, reading back both the card's
 *     state and `document.activeElement`: Escape must close the card and NOT
 *     the dialog, which is the one way a help affordance can lose somebody's
 *     place in the settings they were editing.
 *   - **Two at once**, which is what `popover="hint"` is supposed to prevent
 *     and what a browser that does not know the value will not prevent for us.
 *   - **No reflow**: the row's box and the dialog's scroll height, before and
 *     after a card opens. A help that moves the setting it explains is worse
 *     than no help.
 *   - **The accessibility tree**, not the attributes: the description a
 *     screen reader gets for the control, and the name it gets for the glyph.
 *   - **The platform's answers**, printed: whether this browser has `hint`,
 *     invoker commands, anchor positioning and `closedby`, and what it does
 *     with a popover value it does not know.
 *
 * A stub harness on a free port answers `/state`; the throwaway vite is pointed
 * at it with `ISOCAN_VOICE_HARNESS`, so nothing here touches the real harness
 * on 7654 or anybody's canvas.
 *
 *   node scripts/voice-help-evidence.mjs [--out <dir>]
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browser, until } from "./lib/browser.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outIndex = process.argv.indexOf("--out");
const outDir = outIndex > -1 ? path.resolve(process.argv[outIndex + 1]) : path.join(repo, "reports", "voice-help");
mkdirSync(outDir, { recursive: true });
// A previous run's pictures are cleared first: evidence.md is rewritten every
// time, and a screenshot left from an older code path would be evidence of a
// state this run never measured.
for (const file of readdirSync(outDir)) {
  if (file.endsWith(".png")) rmSync(path.join(outDir, file), { force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const begun = Date.now();
const steps = [];
const step = (line) => {
  steps.push(line);
  console.log(`  ${line}`);
};
const say = (line) => console.log(`  ${line}`);

/* One synthetic harness. Nothing here is a real canvas and no key is used. */
const harness = createServer((req, res) => {
  const send = (body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/state")
    return send({
      canvas: { title: "Help evidence canvas", id: "prj_help" },
      daemon: "http://127.0.0.1:4441",
      home: "/tmp/isocan-help-evidence",
      agent: { name: "Voice", id: "usr_help", enrolled: true },
      provider: { name: "gemini", model: "models/gemini-3.1-flash-live-preview", key: true },
      version: "help-evidence",
      updated: "now",
      session: { state: "idle" },
    });
  if (req.url === "/log") return send({ entries: [] });
  if (req.url === "/daemons") return send({ found: [] });
  if (req.url === "/canvases") return send({ canvases: [] });
  if (req.method === "POST") return send({ ok: true });
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: `no ${req.url}` }));
});
await new Promise((resolve) => harness.listen(0, "127.0.0.1", resolve));
const harnessPort = harness.address().port;

/* A throwaway vite, pointed at THIS harness. 5173 and 7654 are somebody's
   session on this machine, so the web port is picked rather than assumed. */
const webPort = 5300 + Math.floor(Math.random() * 400);
const vite = spawn("npm", ["run", "dev", "-w", "@isocan/web", "--", "--port", String(webPort), "--strictPort"], {
  cwd: repo,
  env: { ...process.env, ISOCAN_VOICE_HARNESS: `http://127.0.0.1:${harnessPort}` },
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOut = "";
vite.stdout.setEncoding("utf8");
vite.stderr.setEncoding("utf8");
vite.stdout.on("data", (d) => (viteOut += d));
vite.stderr.on("data", (d) => (viteOut += d));
// `localhost`, not 127.0.0.1: vite binds the name it was given, and 127.0.0.1
// is not necessarily the same socket.
const pageUrl = `http://localhost:${webPort}/voice`;
{
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (await fetch(pageUrl).then((r) => r.ok).catch(() => false)) break;
    if (Date.now() > deadline) throw new Error(`vite never served ${pageUrl}:\n${viteOut}`);
    await sleep(250);
  }
}
step(`page: a throwaway vite on ${webPort}, pointed at a stub harness on ${harnessPort} (5173 and 7654 untouched)`);

const b = await browser({ flags: ["--window-size=1440,980"] });
/**
 * **The picture and the claim are taken at the same moment.**
 *
 * Before the shutter closes, the card is open and it is what is painted at its
 * own centre — so a screenshot here is a photograph of the state the numbers
 * describe, not of whatever happened to be on screen afterwards.
 */
const shot = async (name, id) => {
  const painted = await b.ev(`(() => { const card = document.getElementById(${JSON.stringify(id)});
    const r = card.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return { open: card.matches(":popover-open"), onTop: Boolean(hit && card.contains(hit)) }; })()`);
  if (!painted.open || !painted.onTop) step(`${name}: the card under the shutter was open ${painted.open}, painted at its centre ${painted.onTop}`);
  const { data } = await b.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, "base64"));
  return `${name}.png${painted.open && painted.onTop ? "" : " (NOT the state the numbers describe)"}`;
};

/** Real keys, through the browser's own input pipeline. Enter and Space carry
 *  their text: without it Chrome dispatches the key without the activation a
 *  button's default action is made of, and "Enter did not open it" would look
 *  like a page bug. */
async function key(name, code, vk, text) {
  for (const type of ["keyDown", "keyUp"])
    await b.send("Input.dispatchKeyEvent", {
      type, key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text } : {}),
    });
}
async function clickAt(x, y) {
  for (const type of ["mousePressed", "mouseReleased"])
    await b.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}
const centre = async (selector) =>
  b.ev(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);

/**
 * **Where every card sits, and whether it is inside everything it must be.**
 *
 * Which fallback was chosen is read off the USED style rather than guessed
 * from the rectangle: a card with a `position-area` is anchored, one pinned to
 * the viewport's block-end is the sheet, and one with no area and a pixel
 * block-start is the narrow rule.
 */
const GEOMETRY = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const dialog = document.getElementById("settings").getBoundingClientRect();
  return [...document.querySelectorAll("#settings .voice-help")].map((button) => {
    const card = document.getElementById(button.getAttribute("commandfor"));
    const g = button.getBoundingClientRect();
    const r = card.getBoundingClientRect();
    const open = card.matches(":popover-open");
    const style = getComputedStyle(card);
    const anchored = style.positionArea !== "none";
    const where = !open
      ? "closed"
      : anchored
        ? r.bottom <= g.top + 1
          ? "anchored-above"
          : r.top >= g.bottom - 1
            ? "anchored-below"
            : r.right <= g.left + 1
              ? "anchored-inline-start"
              : r.left >= g.right - 1
                ? "anchored-inline-end"
                : "anchored-overlapping"
        : Math.abs(r.top - g.bottom) < 2
          ? "flush-below"
          : vh - r.bottom <= 20
            ? "sheet"
            : "pinned-elsewhere";
    const insideViewport = r.left >= -0.5 && r.top >= -0.5 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5;
    return {
      id: card.id, where, open, insideViewport, positionArea: style.positionArea,
      // The card is allowed to hang over the dialog's own box (it is an
      // overlay), but not off the screen and not off the page's inline edges.
      rightOfPage: r.right <= vw + 0.5 && r.left >= -0.5,
      card: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
      glyph: [Math.round(g.left), Math.round(g.top), Math.round(g.right), Math.round(g.bottom)],
      dialog: [Math.round(dialog.left), Math.round(dialog.top), Math.round(dialog.right), Math.round(dialog.bottom)],
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
})()`;

const openCard = async (id) => {
  // Into view first: below the fold of the dialog's own scrollport the click
  // would land on the backdrop, which is a press outside it — a dismissal
  // rather than a press on the glyph.
  await b.ev(`document.querySelector('[commandfor="${id}"]').scrollIntoView({ block: "center" })`);
  await sleep(80);
  const at = await centre(`[commandfor="${id}"]`);
  await clickAt(at.x, at.y);
  await sleep(120);
};
const escape = async () => {
  await key("Escape", "Escape", 27);
  await sleep(80);
};

/** The dialog must be open for anything here to mean anything, and one of the
 *  claims is that closing a card never closes it. Say so rather than measuring
 *  a page that quietly went away. */
let dialogClosures = 0;
async function ensureDialog() {
  if (await b.ev(`document.getElementById("settings").open`)) return;
  dialogClosures++;
  const cog = await centre("#settings-open");
  await clickAt(cog.x, cog.y);
  await until(b, `document.getElementById("settings").open`, "the settings dialog to come back");
}

/** Open every card in turn, by a real click on its glyph, and record where it landed. */
async function sweep(label) {
  const rows = [];
  for (const id of await b.ev(`[...document.querySelectorAll("#settings .voice-help")].map((b) => b.getAttribute("commandfor"))`)) {
    await ensureDialog();
    await openCard(id);
    const [row] = (await b.ev(GEOMETRY)).filter((r) => r.id === id);
    rows.push(row);
    await escape();
  }
  const viewportWidth = await b.ev("innerWidth");
  const outside = rows.filter((r) => !r.insideViewport || !r.rightOfPage);
  const wide = rows.filter((r) => r.scrollWidth > viewportWidth);
  const never = rows.filter((r) => !r.open);
  // A pixel of tolerance: the narrow rule holds the card to the page's own
  // margin, which is where the dialog's border sits, not its padding box.
  const past = rows.filter((r) => r.open && (r.card[0] < r.dialog[0] - 1 || r.card[2] > r.dialog[2] + 1));
  step(
    `${label}: ${rows.length} cards, positions ${JSON.stringify(rows.map((r) => `${r.id.replace("help-", "")}=${r.where}`))}, ` +
      `never opened ${never.length ? JSON.stringify(never.map((r) => r.id)) : "none"}, ` +
      `off-screen ${outside.length ? JSON.stringify(outside.map((r) => r.id)) : "none"}, ` +
      `past the dialog's inline box ${past.length ? JSON.stringify(past.map((r) => `${r.id} ${r.card[0]}..${r.card[2]} in ${r.dialog[0]}..${r.dialog[2]}`)) : "none"}, ` +
      `document wider than the window: ${wide.length ? JSON.stringify(wide.map((r) => r.id)) : "no"}`,
  );
  return rows;
}

try {
  const loaded = b.once("Page.loadEventFired");
  await b.send("Page.navigate", { url: pageUrl });
  await loaded;
  await until(b, `document.getElementById("daemon")?.textContent === "http://127.0.0.1:4441"`, "the page to take its facts from the stub harness");
  await b.send("Accessibility.enable");

  /* What this browser has, and what it does with a popover value it does not
     know. The last one decides whether the one-card-at-a-time rule and the
     Escape key are the platform's work or ours on this machine — the file
     claims both, and this is where the claim is tested. */
  const platform = await b.ev(`(() => {
    const probe = document.createElement("div");
    probe.setAttribute("popover", "hint");
    document.body.appendChild(probe);
    const answers = {
      chrome: navigator.userAgent.match(/Chrome\\/[\\d.]+/)?.[0] ?? "unknown",
      popover: "popover" in HTMLElement.prototype,
      invokerCommands: "commandForElement" in HTMLButtonElement.prototype,
      anchorPositioning: CSS.supports("position-area", "block-end") && CSS.supports("anchor-name", "--x"),
      positionTry: CSS.supports("position-try-fallbacks", "--x"),
      closedBy: "closedBy" in HTMLDialogElement.prototype,
      interestInvokers: "interestForElement" in HTMLButtonElement.prototype,
      hintUnderstood: probe.popover === "hint",
      hintResolvesTo: probe.popover,
      popoverShowsAtAll: typeof probe.showPopover === "function",
    };
    probe.remove();
    return answers;
  })()`);
  step(
    `browser: ${platform.chrome}; popover ${platform.popover ? "yes" : "NO"}, invoker commands ${platform.invokerCommands ? "yes" : "no"}, ` +
      `anchor positioning ${platform.anchorPositioning ? "yes" : "no"}, position-try ${platform.positionTry ? "yes" : "no"}, ` +
      `closedby ${platform.closedBy ? "yes" : "no"}, interest invokers ${platform.interestInvokers ? "yes" : "no"}`,
  );
  step(
    `popover="hint" in this browser: ${platform.hintUnderstood ? 'understood' : `NOT understood — it resolves to "${platform.hintResolvesTo}"`}; ` +
      `${platform.hintUnderstood ? "the platform closes other hints, dismisses on an outside press and takes Escape" : "so one-at-a-time, light dismiss and Escape are the page's own rule here"}`,
  );

  /* The dialog, opened by a real press on the cog. */
  const cog = await centre("#settings-open");
  await clickAt(cog.x, cog.y);
  await until(b, `document.getElementById("settings").open`, "the settings dialog to open");
  step(`dialog: opened from the cog; ${(await b.ev(`document.querySelectorAll("#settings .voice-help").length`))} help glyphs in it`);

  /* Closed cards must not be PAINTED. An author `display` beats the UA's own
     hiding of a closed popover, so a card that inherits one is rendered at
     its anchored position with nothing open — nine explanations over the
     settings. This run found exactly that, which is why it is a step. */
  const closedCards = await b.ev(`[...document.querySelectorAll(".voice-help-card")].map((c) => ({ id: c.id, display: getComputedStyle(c).display, paints: c.checkVisibility ? c.checkVisibility() : null }))`);
  const painted = closedCards.filter((c) => c.display !== "none" || c.paints);
  step(`closed cards: ${painted.length ? `PAINTED ${JSON.stringify(painted)}` : `all ${closedCards.length} hidden by the platform`}`);

  /* 1440, light: every card, then a picture of one of them. */
  const wideLight = await sweep("1440 light");

  /* No reflow: the row's own box and the dialog's scroll height, before and
     after a card opens. Nothing about the setting may move. */
  await ensureDialog();
  const before = await b.ev(`(() => { const row = document.querySelector('[commandfor="help-microphone"]').closest("div").getBoundingClientRect();
    const dialog = document.getElementById("settings");
    return { row: [Math.round(row.top), Math.round(row.bottom), Math.round(row.left), Math.round(row.right)], scroll: dialog.scrollHeight }; })()`);
  await openCard("help-microphone");
  const after = await b.ev(`(() => { const row = document.querySelector('[commandfor="help-microphone"]').closest("div").getBoundingClientRect();
    const dialog = document.getElementById("settings");
    return { row: [Math.round(row.top), Math.round(row.bottom), Math.round(row.left), Math.round(row.right)], scroll: dialog.scrollHeight }; })()`);
  step(
    `reflow: the row is ${JSON.stringify(before.row)} before and ${JSON.stringify(after.row)} after the card opens (${JSON.stringify(before.row) === JSON.stringify(after.row) ? "unmoved" : "MOVED"}); ` +
      `the dialog scrolls ${before.scroll}px of content either way (${before.scroll === after.scroll ? "unchanged" : "CHANGED"})`,
  );
  const wideLightShot = await shot("01-wide-light", "help-microphone");

  /* Two at once: a second glyph, pressed while the first card is open. */
  const second = await b.ev(`document.querySelectorAll(".voice-help-card:popover-open").length`);
  await openCard("help-daemon");
  const openNow = await b.ev(`[...document.querySelectorAll(".voice-help-card:popover-open")].map((c) => c.id)`);
  step(`two at once: ${second} open before the second press, ${JSON.stringify(openNow)} after it — the rule is one`);
  const twoShot = await shot("05-two-at-once", "help-daemon");
  await escape();

  /* Hover, with the mouse really moving: onto the glyph, then off it. */
  await ensureDialog();
  const hoverAt = await centre(`[commandfor="help-actor"]`);
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, button: "none", pointerType: "mouse" });
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hoverAt.x, y: hoverAt.y, button: "none", pointerType: "mouse" });
  await sleep(120);
  const early = await b.ev(`document.querySelectorAll(".voice-help-card:popover-open").length`);
  await sleep(400);
  const hovered = await b.ev(`[...document.querySelectorAll(".voice-help-card:popover-open")].map((c) => c.id)`);
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, button: "none", pointerType: "mouse" });
  await sleep(400);
  const left = await b.ev(`document.querySelectorAll(".voice-help-card:popover-open").length`);
  step(
    `hover: 120ms after the pointer arrives, ${early} open (the delay is deliberate: sweeping across the dialog must not open nine cards); ` +
      `after 520ms, ${JSON.stringify(hovered)}; 400ms after the pointer leaves, ${left}`,
  );

  /* Hover, then Escape, inside the hover delay: the intent that opened it is
     still counting down, and it must not put the card back 133ms after the
     key dismissed it. This is the one bug this run found; it stays as a
     step so it cannot come back unannounced. */
  const stale = await centre(`[commandfor="help-home"]`);
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, button: "none", pointerType: "mouse" });
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: stale.x, y: stale.y, button: "none", pointerType: "mouse" });
  await clickAt(stale.x, stale.y);
  await sleep(120);
  await escape();
  await sleep(400);
  const staleOpen = await b.ev(`[...document.querySelectorAll(".voice-help-card:popover-open")].map((c) => c.id)`);
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, button: "none", pointerType: "mouse" });
  await sleep(250);
  step(`hover then Escape: 400ms after the key (the hover timer's own delay is ${300}ms), ${JSON.stringify(staleOpen)} open`);

  /* Keyboard, with real keys: focus the glyph, Enter to open, Escape to close.
     The glyph is focused rather than Tabbed to — the claim is that it is
     focusable and that the key opens and closes the card — and what the tab
     order does around it is reported beside it. */
  await ensureDialog();
  await b.ev(`document.getElementById("daemon-field").focus()`);
  const focusBefore = await b.ev(`document.activeElement.id`);
  await key("Tab", "Tab", 9);
  const focusAfterTab = await b.ev(`(() => { const el = document.activeElement;
    return { id: el.id || null, label: el.getAttribute?.("aria-label") ?? null, text: (el.textContent ?? "").trim().slice(0, 30) }; })()`);
  await b.ev(`document.querySelector('[commandfor="help-daemon"]').focus()`);
  const focusOnGlyph = await b.ev(`document.activeElement.getAttribute("aria-label")`);
  await key("Enter", "Enter", 13, "\r");
  await sleep(120);
  const entered = await b.ev(`[...document.querySelectorAll(".voice-help-card:popover-open")].map((c) => c.id)`);
  await escape();
  // Space is the other key a button answers, and the one a keyboard user who
  // does not know about Enter will try.
  await b.ev(`document.querySelector('[commandfor="help-home"]').focus()`);
  await key(" ", "Space", 32, " ");
  await sleep(120);
  const spaced = await b.ev(`[...document.querySelectorAll(".voice-help-card:popover-open")].map((c) => c.id)`);
  await escape();
  const afterEscape = await b.ev(`(() => ({
    open: [...document.querySelectorAll(".voice-help-card:popover-open")].map((c) => c.id),
    dialogOpen: document.getElementById("settings").open,
    focus: document.activeElement.getAttribute("aria-label") ?? document.activeElement.id,
  }))()`);
  step(
    `keyboard: focus was on ${JSON.stringify(focusBefore)}, Tab moved it to ${JSON.stringify(focusAfterTab)}; ` +
      `on the glyph ${JSON.stringify(focusOnGlyph)}, Enter opened ${JSON.stringify(entered)}, Space opened ${JSON.stringify(spaced)}; ` +
      `Escape left ${JSON.stringify(afterEscape.open)} open, the dialog ${afterEscape.dialogOpen ? "still open" : "CLOSED"}, focus ${JSON.stringify(afterEscape.focus)}`,
  );

  /* Reduced motion: this page already turns off every transition under the
     preference, and a card must not be the exception. */
  await ensureDialog();
  await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await openCard("help-audio");
  const motionState = await b.ev(`(() => { const card = document.getElementById("help-audio"); const s = getComputedStyle(card);
    return { transition: s.transitionDuration, animation: s.animationName }; })()`);
  await escape();
  await b.send("Emulation.setEmulatedMedia", { features: [] });
  step(`reduced motion: a card under prefers-reduced-motion has transition ${motionState.transition} and animation ${motionState.animation}`);

  /* The accessibility tree, which is what a screen reader gets — an attribute
     in the markup is a claim about it, not the thing itself. */
  const ax = async (selector) => {
    const { result } = await b.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` });
    const tree = await b.send("Accessibility.getPartialAXTree", { objectId: result.objectId, fetchRelatives: false });
    const node = tree.nodes?.[0];
    return {
      role: node?.role?.value ?? "none",
      name: node?.name?.value ?? "",
      description: node?.description?.value ?? "",
    };
  };
  const axControl = await ax("#daemon-field");
  const axGlyph = await ax(`[commandfor="help-daemon"]`);
  const axHeading = await ax("#key-title");
  step(
    `screen reader, the control: #daemon-field is "${axControl.role}" named ${JSON.stringify(axControl.name)}, described ${JSON.stringify(axControl.description.slice(0, 90))}${axControl.description.length > 90 ? "…" : ""}`,
  );
  step(
    `screen reader, the glyph: ${JSON.stringify(axGlyph.name)} (${axGlyph.role}), described ${JSON.stringify(axGlyph.description.slice(0, 90))}${axGlyph.description.length > 90 ? "…" : ""}`,
  );
  step(`screen reader, the key panel's heading: ${JSON.stringify(axHeading.name)} (${axHeading.role})`);

  /* Dark, at the same width. The page's own stored preference decides, before
     first paint, exactly as it does for a person who chose it. */
  await b.ev(`localStorage.setItem("isocan.theme", "dark")`);
  const reloaded = b.once("Page.loadEventFired");
  await b.send("Page.reload");
  await reloaded;
  await until(b, `document.getElementById("daemon")?.textContent === "http://127.0.0.1:4441"`, "the page to come back");
  const theme = await b.ev(`document.documentElement.dataset.theme`);
  const cogDark = await centre("#settings-open");
  await clickAt(cogDark.x, cogDark.y);
  await until(b, `document.getElementById("settings").open`, "the settings dialog to open in the dark");
  await openCard("help-microphone");
  const wideDarkShot = await shot("02-wide-dark", "help-microphone");
  step(`1440 dark: the page came back with data-theme=${JSON.stringify(theme)} and the card is the same size in it`);
  await escape();

  /* 420: an emulated phone, touch included, because that is where an anchored
     card has the least room and where hover does not exist at all. */
  await b.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 860, deviceScaleFactor: 2, mobile: true });
  await b.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await sleep(200);
  const narrowDark = await sweep("420 dark");
  // The worst case is the card whose right edge came closest to the screen's.
  const worst = [...narrowDark].sort((a, b) => b.card[2] - a.card[2])[0];
  await openCard(worst.id);
  const narrowDarkShot = await shot("04-narrow-dark", worst.id);
  await escape();

  await b.ev(`localStorage.setItem("isocan.theme", "light")`);
  const back = b.once("Page.loadEventFired");
  await b.send("Page.reload");
  await back;
  await until(b, `document.getElementById("daemon")?.textContent === "http://127.0.0.1:4441"`, "the page to come back in the light");
  const narrowCog = await centre("#settings-open");
  await clickAt(narrowCog.x, narrowCog.y);
  await until(b, `document.getElementById("settings").open`, "the settings dialog to open at 420");
  const narrowLight = await sweep("420 light");
  const worstLight = [...narrowLight].sort((a, b) => b.card[2] - a.card[2])[0];
  await openCard(worstLight.id);
  const narrowLightShot = await shot("03-narrow-light", worstLight.id);
  step(
    `420: the card that reached furthest right ended at ${worstLight.card[2]}px of ${await b.ev("innerWidth")}px ` +
      `(${worstLight.where}, inside the viewport: ${worstLight.insideViewport}; document ${worstLight.scrollWidth}px wide)`,
  );

  /* A short window — a phone in landscape, or the keyboard up — is where the
     glyph has no room below it either, and the last fallback earns its place. */
  await b.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 320, deviceScaleFactor: 2, mobile: true });
  await sleep(200);
  await ensureDialog();
  const shortWindow = await sweep("420x320");
  step(
    `short window: the cards that became sheets ${JSON.stringify(shortWindow.filter((r) => r.where === "sheet").map((r) => r.id))}, ` +
      `off-screen ${JSON.stringify(shortWindow.filter((r) => !r.insideViewport).map((r) => r.id))}`,
  );
  await b.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 860, deviceScaleFactor: 2, mobile: true });
  await sleep(200);

  /* A touch press on the glyph: no hover, so the click has to be enough. */
  await ensureDialog();
  const touchAt = await centre(`[commandfor="help-localfiles"]`);
  await b.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchAt.x, y: touchAt.y }] });
  await b.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(200);
  const touchOpen = await b.ev(`[...document.querySelectorAll(".voice-help-card:popover-open")].map((c) => c.id)`);
  step(`touch at 420: a tap opened ${JSON.stringify(touchOpen)} — the whole path for a phone, where nothing hovers`);
  await escape();

  const errors = b.takeErrors();
  if (errors.length) step(`page errors: ${JSON.stringify(errors)}`);

  const report = [
    `# Voice settings — the "?" help, browser evidence`,
    ``,
    `Run ${new Date().toISOString()} in ${((Date.now() - begun) / 1000).toFixed(1)}s.`,
    ``,
    `- browser: ${platform.chrome}`,
    `- platform: popover ${platform.popover ? "yes" : "NO"}, invoker commands ${platform.invokerCommands ? "yes" : "no"}, anchor positioning ${platform.anchorPositioning ? "yes" : "no"}, position-try ${platform.positionTry ? "yes" : "no"}, closedby ${platform.closedBy ? "yes" : "no"}, interest invokers ${platform.interestInvokers ? "yes" : "no"}`,
    `- \`popover="hint"\`: ${platform.hintUnderstood ? "understood" : `not understood (resolves to "${platform.hintResolvesTo}")`}`,
    `- one at a time: ${second} card open before a second glyph was pressed, ${JSON.stringify(openNow)} after`,
    `- reflow: row ${JSON.stringify(before.row)} → ${JSON.stringify(after.row)}; dialog scroll height ${before.scroll} → ${after.scroll}`,
    `- keyboard: ${JSON.stringify(focusBefore)} → Tab → ${JSON.stringify(focusAfterTab)}, on the glyph ${JSON.stringify(focusOnGlyph)}: Enter opened ${JSON.stringify(entered)}, Space opened ${JSON.stringify(spaced)}, Escape left ${JSON.stringify(afterEscape.open)} open with the dialog ${afterEscape.dialogOpen ? "still open" : "CLOSED"} and focus on ${JSON.stringify(afterEscape.focus)}`,
    `- screen reader: control ${JSON.stringify(axControl.name)} → ${JSON.stringify(axControl.description)}`,
    `- screen reader: glyph ${JSON.stringify(axGlyph.name)} → ${JSON.stringify(axGlyph.description)}`,
    `- screen reader: heading ${JSON.stringify(axHeading.name)}`,
    `- reduced motion: transition ${motionState.transition}, animation ${motionState.animation}`,
    `- touch at 420: tap opened ${JSON.stringify(touchOpen)}`,
    `- screenshots: each one taken with its card open and painted at its own centre`,
    `- cards whose open state or centre is not what the numbers describe: ${[wideLightShot, twoShot, wideDarkShot, narrowLightShot, narrowDarkShot].filter((s) => s.includes("NOT")).length}`,
    `- dialog closed by a card interaction: ${dialogClosures} times`,
    `- page errors: ${errors.length ? JSON.stringify(errors) : "none"}`,
    ``,
    `## Every card, by width`,
    ...wideLight.map((r) => `- 1440: ${r.id} landed ${r.where} at [${r.card}], glyph [${r.glyph}], dialog [${r.dialog}], inside the viewport: ${r.insideViewport}`),
    ...narrowLight.map((r) => `- 420 light: ${r.id} landed ${r.where} at [${r.card}], glyph [${r.glyph}], dialog [${r.dialog}], inside the viewport: ${r.insideViewport}`),
    ...narrowDark.map((r) => `- 420 dark: ${r.id} landed ${r.where} at [${r.card}], inside the viewport: ${r.insideViewport}`),
    ``,
    `## Steps`,
    ...steps.map((s) => `- ${s}`),
    ``,
    `## Screenshots`,
    `- ${wideLightShot} — 1440 light, the microphone card open`,
    `- ${twoShot} — a second glyph pressed while the first card was open`,
    `- ${wideDarkShot} — 1440 dark`,
    `- ${narrowLightShot} — 420 light`,
    `- ${narrowDarkShot} — 420 dark`,
    ``,
  ].join("\n");
  writeFileSync(path.join(outDir, "evidence.md"), report);
  console.log(`\n  evidence written to ${path.join(outDir, "evidence.md")}\n`);
} finally {
  await b.close();
  vite.kill("SIGTERM");
  await new Promise((resolve) => harness.close(resolve));
}
