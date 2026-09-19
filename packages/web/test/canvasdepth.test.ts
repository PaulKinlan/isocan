import { describe, expect, it } from "vitest";
import { canDeepen, MAX_MINIATURE_DEPTH, MIN_NESTED_HEIGHT, MIN_NESTED_WIDTH, NESTED_MOST_ITEMS, nestedTarget } from "../src/lib/canvasdepth.ts";
import type { Item } from "@isocan/core";

/**
 * **The depth-2 decision, held to account with real values** (isocan-wq6.5,
 * upstream #203). `canDeepen` is the whole gating rule in one pure function
 * precisely so these tests can fail: each case below is a shape the rendering
 * must actually distinguish — depth exhausted, cycles, boxes too small to
 * read — not a grep of the source that would pass on any wording.
 */
describe("canDeepen — the depth-2 gating rule", () => {
  const fresh = new Set(["canvas-a"]);

  it("deepens a level-1 picture into a large-enough, non-cyclic target", () => {
    expect(canDeepen(1, "canvas-b", fresh, 200, 150)).toBe(true);
  });

  it("never deepens past exactly one extra level", () => {
    expect(canDeepen(MAX_MINIATURE_DEPTH, "canvas-b", fresh, 200, 150)).toBe(false);
    expect(canDeepen(MAX_MINIATURE_DEPTH + 1, "canvas-b", fresh, 200, 150)).toBe(false);
  });

  it("refuses a target that would close a cycle", () => {
    expect(canDeepen(1, "canvas-a", fresh, 200, 150)).toBe(false);
    expect(canDeepen(1, "canvas-b", new Set(["canvas-a", "canvas-b"]), 200, 150)).toBe(false);
  });

  it("refuses a box too small to read the picture inside", () => {
    expect(canDeepen(1, "canvas-b", fresh, MIN_NESTED_WIDTH - 1, 150)).toBe(false);
    expect(canDeepen(1, "canvas-b", fresh, 200, MIN_NESTED_HEIGHT - 1)).toBe(false);
    // The boundary itself is deep enough to read: >=, not >.
    expect(canDeepen(1, "canvas-b", fresh, MIN_NESTED_WIDTH, MIN_NESTED_HEIGHT)).toBe(true);
  });

  it("refuses an unknown target outright", () => {
    expect(canDeepen(1, null, fresh, 200, 150)).toBe(false);
  });
});

/**
 * **Which canvas a block would deepen into.** The parser is the shared
 * `automaticCanvasTarget`, and a `source` at another origin is somebody
 * else's home — the nested rule must not pull across homes even when the
 * direct card's own refusal is what usually catches it first.
 */
describe("nestedTarget — which block deepens, and into what", () => {
  const base = { x: 0, y: 0, width: 800, height: 600, title: "", description: "", versions: [] } as const;
  const item = (properties: Record<string, string>): Item =>
    ({ ...base, id: "i1", properties, currentVersionId: "" }) as unknown as Item;

  it("resolves a declared canvas item with no source", () => {
    expect(nestedTarget(item({ kind: "canvas", canvas: "canvas-b" }), "https://x.test")).toBe("canvas-b");
  });

  it("resolves a canvas item whose source names the same origin", () => {
    expect(nestedTarget(item({ kind: "canvas", canvas: "canvas-b", source: "https://x.test/p/canvas-b" }), "https://x.test")).toBe("canvas-b");
  });

  it("refuses a canvas item whose source lives at another home", () => {
    expect(nestedTarget(item({ kind: "canvas", canvas: "canvas-b", source: "https://elsewhere.test/p/canvas-b" }), "https://x.test")).toBeNull();
  });

  it("refuses anything that is not a canvas item", () => {
    expect(nestedTarget(item({ kind: "text" }), "https://x.test")).toBeNull();
    expect(nestedTarget(item({}), "https://x.test")).toBeNull();
  });

  it("carries the fixed nested budget", () => {
    expect(NESTED_MOST_ITEMS).toBeLessThan(120);
    expect(NESTED_MOST_ITEMS).toBeGreaterThan(0);
  });
});
