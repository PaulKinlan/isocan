// @vitest-environment jsdom
/**
 * **The help dialog, and the sweep it is not allowed to drift from.**
 *
 * A help page written by hand is true on the day it is written and wrong
 * within a week: it promises tools nobody declared and keeps quiet about the
 * ones that were refused. So the capability section is generated
 * (`scripts/voice-capability-sweep.mjs` → `capabilities.generated.ts`) and
 * these tests hold the two ends together —
 *
 *   1. the sweep and the page's copy of it still agree (`--check`, which
 *      also covers the doc), and
 *   2. the rendered dialog still shows exactly what that copy says.
 *
 * The access claims cannot be generated the same way, but they name their own
 * mechanisms — the OPFS call, the DirectoryHandle, `POST /fs/grant`, the
 * provider's host — so the last test asserts each named mechanism still
 * exists in the source it describes. A claim whose mechanism has moved is a
 * claim somebody has to rewrite rather than one that quietly rots.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELP_COUNTS, HELP_GROUPS, HELP_REFUSED } from "../src/voice/capabilities.generated.ts";
import { wireVoice, type VoicePage } from "../src/voice/main.ts";

const voiceHtml = readFileSync(path.resolve(process.cwd(), "packages/web/voice.html"), "utf8");
const voiceBody = /<body[^>]*>([\s\S]*)<\/body>/i.exec(voiceHtml)?.[1] ?? "";
const readSource = (rel: string): string => readFileSync(path.resolve(process.cwd(), rel), "utf8");

let page: VoicePage | null = null;

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the voice page is missing #${id}`);
  return found as T;
};

beforeEach(() => {
  document.body.innerHTML = voiceBody;
  // jsdom checks delegation only; native Escape, focus containment and the
  // real `closedby` are Chromium's, and driven there.
  for (const id of ["settings", "logs", "help"]) {
    const dialog = document.getElementById(id) as HTMLDialogElement;
    dialog.showModal = vi.fn(() => {
      dialog.open = true;
      (dialog.querySelector("[autofocus]") as HTMLElement)?.focus();
    });
    dialog.close = vi.fn(() => {
      dialog.open = false;
      (document.activeElement as HTMLElement | null)?.blur?.();
      dialog.dispatchEvent(new Event("close"));
    });
  }
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: async () => [],
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.endsWith("/state") ? {} : { entries: [] };
      return {
        ok: true,
        status: 200,
        url: "",
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  page?.stop();
  page = null;
  vi.unstubAllGlobals();
});

async function wire(): Promise<void> {
  page = wireVoice(document);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the help dialog is the third one, wearing the same shell", () => {
  it("sits in the header beside the cog and the logs", async () => {
    await wire();
    const button = element<HTMLButtonElement>("help-open");
    expect(document.querySelector(".voice-head-actions #help-open")).toBe(button);
    expect(button.getAttribute("aria-controls")).toBe("help");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.textContent?.trim()).toBe("");
    expect(button.getAttribute("aria-label")).toBeTruthy();

    const help = element<HTMLDialogElement>("help");
    expect(help.open).toBe(false);
    expect(help.getAttribute("closedby")).toBe("any");
    expect(help.querySelector(".voice-dialog-head #help-title")).toBeTruthy();
    // Flat like the other two: read by scrolling, not by opening something.
    expect(help.querySelectorAll("details, summary").length).toBe(0);
  });

  it("opens from its button, closes, and gives the focus back to that button", async () => {
    await wire();
    const help = element<HTMLDialogElement>("help");
    const button = element<HTMLButtonElement>("help-open");

    button.click();
    expect(help.showModal).toHaveBeenCalledOnce();
    expect(help.open).toBe(true);
    expect(document.activeElement).toBe(element("help-title"));
    expect(button.getAttribute("aria-expanded")).toBe("true");

    element<HTMLButtonElement>("help-close").click();
    expect(help.open).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    // A dialog dismissed with no opener (a backdrop press) still has to leave
    // the person somewhere; the button that opened it is the only honest place.
    expect(document.activeElement).toBe(button);

    // Reopening rebuilds nothing: the section is rendered once.
    const made = element("help-capabilities").childElementCount;
    button.click();
    expect(element("help-capabilities").childElementCount).toBe(made);
  });

  it("is dismissed from outside like the other two, and itself when it is the open one", async () => {
    await wire();
    const help = element<HTMLDialogElement>("help");
    // The declarative half is `closedby="any"`; jsdom has no `closedBy`, so
    // what runs here is the Safari fallback — now looking for the open dialog
    // among three rather than assuming one of two.
    expect(help.getAttribute("closedby")).toBe("any");
    // jsdom has no layout either, so the dialog says where its box is.
    help.getBoundingClientRect = () => ({ left: 100, top: 50, right: 500, bottom: 400 }) as DOMRect;
    const pressAt = (target: EventTarget, clientX: number, clientY: number) =>
      target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX, clientY }));

    element<HTMLButtonElement>("help-open").click();
    expect(help.open).toBe(true);
    // Its own padding, its own content, and a popup painted outside the box
    // all belong to the dialog and are not a dismissal.
    pressAt(help, 300, 395);
    expect(help.open).toBe(true);
    pressAt(element("help-title"), 10, 10);
    expect(help.open).toBe(true);
    pressAt(element("help-refused"), 900, 900);
    expect(help.open).toBe(true);
    // The backdrop does dismiss it.
    pressAt(document.body, 10, 10);
    expect(help.open).toBe(false);

    // The picker must choose the dialog that is actually open: nothing up
    // means nothing to dismiss...
    pressAt(document.body, 10, 10);
    expect(help.open).toBe(false);
    // ...and with the cog up instead, the press decides against the COG's box:
    // the help dialog is closed, so it is not the one being measured.
    const settings = element<HTMLDialogElement>("settings");
    element<HTMLButtonElement>("settings-open").click();
    pressAt(help, 10, 10);
    expect(settings.open).toBe(false);
    expect(help.open).toBe(false);
  });
});

describe("the capability section is the sweep's, rendered", () => {
  it("counts what the sweep counted", async () => {
    await wire();
    element<HTMLButtonElement>("help-open").click();
    const count = element("help-can-count").textContent ?? "";
    expect(count).toContain(String(HELP_COUNTS.total));
    expect(count).toContain(String(HELP_COUNTS.tooled));
    const missing = element("help-can-missing").textContent ?? "";
    expect(missing).toContain(String(HELP_COUNTS.missing));
    expect(missing).toContain(String(HELP_COUNTS.excluded));
  });

  it("renders every group, every act and every tool name, and invents none", async () => {
    await wire();
    element<HTMLButtonElement>("help-open").click();
    const panel = element("help-capabilities");
    for (const group of HELP_GROUPS) {
      expect(panel.textContent, group.title).toContain(group.title);
      for (const act of group.acts) {
        expect(panel.textContent, act.tool).toContain(act.label);
        expect(panel.textContent, act.tool).toContain(act.tool);
      }
    }
    const rendered = [...panel.querySelectorAll("li")];
    expect(rendered.length).toBe(HELP_GROUPS.reduce((n, g) => n + g.acts.length, 0));
    // One row per tool: the sweep's five surfaces overlap, and a person should
    // not read `add_item` eight times.
    const tools = rendered.map((li) => li.querySelector("code")?.textContent);
    expect(new Set(tools).size).toBe(tools.length);
    // The wrong kind of drift: a capability the sweep marks missing, shown as
    // if the harness could do it.
    expect(panel.textContent).not.toContain("read_activity");
    expect(panel.textContent).not.toContain("actor_claim");
  });

  it("keeps the refusals, with the reason each one carries", async () => {
    await wire();
    element<HTMLButtonElement>("help-open").click();
    expect(element("help-cannot-title").textContent).toContain("What it cannot do");
    const limits = element("help-limits").querySelectorAll("li");
    // The harness-level limits — the confirmation gate, the internal ops, the
    // name, the memories, the folder boundary, the tool list itself.
    expect(limits.length).toBeGreaterThanOrEqual(6);
    const refused = element("help-refused").querySelectorAll("li");
    expect(refused.length).toBe(HELP_REFUSED.length);
    for (const [index, row] of HELP_REFUSED.entries()) {
      expect(refused[index]?.textContent, row.label).toContain(row.label);
      expect(row.why, `${row.label} needs a reason`).not.toBe("");
      expect(refused[index]?.textContent, row.label).toContain(row.why);
    }
  });
});

describe("the sweep is the ratchet", () => {
  it("fails when the dialog's data and the sweep's rows disagree", () => {
    // `--check` re-derives both outputs from the rows: the doc and the page's
    // copy. A capability added, removed or re-statused without regenerating
    // lands here with the file to fix.
    const out = execFileSync("node", [path.resolve(process.cwd(), "scripts/voice-capability-sweep.mjs"), "--check"], {
      encoding: "utf8",
    });
    expect(out).toContain(`${HELP_COUNTS.total} rows`);
    expect(out).toContain(`${HELP_COUNTS.tooled} tooled`);
  });
});

describe("every access claim names a mechanism that still exists", () => {
  /**
   * `[what the dialog says, the anchor in the source, the file that must
   * still hold it]`. The anchor differs from the claim where the prose names
   * the call and the code only names the object it is called on.
   */
  const CLAIMS: Array<[claim: string, anchor: string, file: string]> = [
    ["navigator.storage.getDirectory()", "storage.getDirectory()", "packages/web/src/voice/main.ts"],
    ["navigator.storage.persist()", "storage.persist()", "packages/web/src/voice/main.ts"],
    ['showDirectoryPicker({ mode: "read" })', 'showDirectoryPicker', "packages/web/src/voice/main.ts"],
    ["POST /fs/grant", "/fs/grant", "packages/web/src/voice/main.ts"],
    ["~/.isocan/voice/key.json", "key.json", "packages/cli/src/voice-harness.ts"],
    ["0600", "0o600", "packages/cli/src/voice-harness.ts"],
    ["generativelanguage.googleapis.com", "generativelanguage.googleapis.com", "packages/cli/src/voice-harness.ts"],
    ["ISOCAN_PORT", "ISOCAN_PORT", "packages/api/src/ctx.ts"],
    ["INTERNAL_OP_TYPES", "INTERNAL_OP_TYPES", "packages/core/src/ops.ts"],
    ["/confirm", "/confirm", "packages/web/src/voice/main.ts"],
    ["AGENTS.md", "AGENTS.md", "packages/cli/src/voice-harness.ts"],
    ["getUserMedia", "getUserMedia", "packages/web/src/lib/voiceAudio.ts"],
    ["list_dir", "list_dir", "packages/cli/src/voice-harness.ts"],
    ["LIVE_TOOLS", "LIVE_TOOLS", "packages/cli/src/voice-harness.ts"],
    ["isocan voice --as", "voice", "packages/cli/src/agent-guide.md"],
  ];

  it("says each one in the dialog, and each one is still in the code it describes", () => {
    for (const [claim, anchor, file] of CLAIMS) {
      expect(voiceHtml, `the dialog no longer says ${claim}`).toContain(claim);
      expect(readSource(file), `${file} no longer holds ${anchor}`).toContain(anchor);
    }
  });
});
