import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { entriesFrom, sessionFrom } from "../src/lib/voice.ts";
import { VoicePage } from "../src/pages/VoicePage.tsx";

/**
 * **The three things that were broken while the page looked finished.**
 *
 * Each of these shipped, was looked at, and passed: the session state was
 * read off the wire in the wrong shape so every control stayed disabled; the
 * log's fields were named one way by the harness and read another way by the
 * page, so a working endpoint rendered as blank rows; and the key controls
 * were folded into a `<details>` that rendered its summary with nothing under
 * it — the page's own author reported "I still can't set the API key" and it
 * was true. A screenshot cannot catch any of them, which is why they are
 * asserted here rather than looked at.
 */
describe("what the harness says, in the shape the page reads", () => {
  it("unwraps the session state, and also takes it bare", () => {
    expect(sessionFrom({ session: { state: "live" } })).toBe("live");
    expect(sessionFrom({ session: "muted" })).toBe("muted");
    expect(sessionFrom({})).toBeUndefined();
    expect(sessionFrom(null)).toBeUndefined();
  });

  it("maps the log's own field names onto the ones the page renders", () => {
    const [entry] = entriesFrom([
      { timestamp: "23:10:02", name: "item.update", op: "item.update prj_1", result: "accepted" },
    ]);
    expect(entry).toMatchObject({
      at: "23:10:02",
      tool: "item.update",
      operation: "item.update prj_1",
      answered: "accepted",
    });
  });

  it("turns the op and result objects into sentences a renderer can hold", () => {
    // The real harness answers an operation as `{ type, said }` and a result
    // as `{ ok, answer }`. Rendering either object as a child threw and took
    // the route down — visible only against the live harness, not here.
    const [entry] = entriesFrom([
      {
        timestamp: "23:25:33.060Z",
        name: "utterance",
        args: { text: "retitle voice-demo-card.md to Checkout v2", source: "spoken" },
        op: { type: "item.update", said: "renamed “voice-demo-card.md” (itm_ei0yNw)" },
        result: { ok: true, answer: "renamed “voice-demo-card.md” (itm_ei0yNw)" },
      },
    ]);
    expect(entry?.operation).toBe("item.update — renamed “voice-demo-card.md” (itm_ei0yNw)");
    expect(entry?.answered).toBe("renamed “voice-demo-card.md” (itm_ei0yNw)");
    expect(typeof entry?.event).not.toBe("object");
  });

  it("answers a refusal with its reason, not with its object", () => {
    const [entry] = entriesFrom([{ timestamp: "23:26:00", result: { ok: false, error: "no model configured" } }]);
    expect(entry?.answered).toBe("no model configured");
  });

  it("takes both the bare array and the wrapped envelope", () => {
    expect(entriesFrom({ entries: [{ name: "say" }] })[0]?.tool).toBe("say");
    expect(entriesFrom({ log: [{ name: "say" }] })[0]?.tool).toBe("say");
  });
});

describe("the page keeps the controls a person has to press", () => {
  const markup = renderToStaticMarkup(h(VoicePage));

  it("offers the key controls, visible rather than folded away", () => {
    for (const id of ["key", "save-key", "test-key", "forget-key"]) {
      expect(markup).toContain(`id="${id}"`);
    }
    // The regression: a `<details>` that rendered its summary and hid the rest.
    expect(markup).toMatch(/<details[^>]*\bopen\b/);
  });

  it("offers the microphone, the session controls and the device picker", () => {
    for (const id of ["listen", "mute", "end", "device", "meter", "log"]) {
      expect(markup).toContain(`id="${id}"`);
    }
  });

  it("says which microphone it will listen on", () => {
    expect(markup).toContain("press Listen to start");
  });
});
