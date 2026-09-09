import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { rules, withoutComments } from "./cssrules.ts";

/**
 * **The home-grid peek overlays; it never reflows.**
 *
 * The first peek was a plain flex child of the card: every hover grew the
 * card by the peek's height and pushed the whole grid down, so the page
 * jumped under the pointer (measured 2026-09-09: hovering one card moved the
 * row below it by 187px). The fix is placement, not content: the card's
 * footprint is fixed, the preview is absolutely positioned over its
 * neighbours on an opaque ground, opens upward when the bottom edge is
 * constrained, and answers Escape. These guards hold the placements and the
 * dismissal; the geometry itself is proven by driving a real browser
 * (scripts in the change's evidence), which a stylesheet cannot assert.
 */
const page = readFileSync(
  fileURLToPath(new URL("../src/pages/CanvasListPage.tsx", import.meta.url)),
  "utf8",
);
const component = readFileSync(
  fileURLToPath(new URL("../src/components/CardPeek.tsx", import.meta.url)),
  "utf8",
);
const sheet = rules(withoutComments());

/** The rule under EXACTLY this selector — a substring match can be satisfied
 *  by a descendant or a suffix while the rule it guards is gone. */
const exact = (selector: string) => sheet.find((r) => r.selector === selector);

describe("the grid never moves", () => {
  it("the peek is out of flow, hung below its card", () => {
    const peek = exact(".card-peek");
    expect(peek?.body).toMatch(/position:\s*absolute/);
    expect(peek?.body).toMatch(/top:\s*100%/);
  });

  it("the card does not clip what leaves its box", () => {
    /* `overflow: hidden` on the card clipped nothing in flow; over an
       absolutely positioned preview it would cut the overlay off at the
       card's own bottom edge. */
    expect(exact(".canvas-card")?.body).not.toMatch(/overflow:\s*hidden/);
  });

  it("the card a preview hangs from stacks above the cards it covers", () => {
    expect(exact(".canvas-card:hover")?.body).toMatch(/z-index:\s*var\(--z-popover\)/);
    /* Focus is the second way a preview opens, and a focused card is not
       necessarily hovered. */
    expect(exact(".canvas-card:focus-within")?.body).toMatch(/z-index:\s*var\(--z-popover\)/);
  });

  it("carries an opaque ground, because it opens over other cards", () => {
    /* The menu's lesson (8 Sep 2026): a surface that can open over anything
       owes its states a ground that renders one value everywhere. */
    expect(exact(".card-peek")?.body).toContain(
      "linear-gradient(var(--panel), var(--panel)), var(--card)",
    );
  });

  it("is bounded and scrolls rather than running off a short window", () => {
    const peek = exact(".card-peek");
    expect(peek?.body).toMatch(/max-height:/);
    expect(peek?.body).toMatch(/overflow-y:\s*auto/);
  });
});

describe("one continuous surface", () => {
  it("gives the open card and preview the same opaque ground and border", () => {
    const card = exact(".canvas-card:has(> .card-peek)");
    expect(card?.body).toContain("linear-gradient(var(--panel), var(--panel)), var(--card)");
    expect(exact(".card-peek")?.body).toMatch(/border-color:\s*inherit/);
    // Separate shadows cast a dark line across the otherwise continuous join.
    expect(card?.body).toMatch(/box-shadow:\s*none/);
    expect(exact(".card-peek")?.body).toMatch(/box-shadow:\s*none/);
  });

  it("removes the joining corners and border below, without shrinking the card", () => {
    const card = exact(".canvas-card:has(> .card-peek:not(.up))");
    expect(card?.body).toMatch(/border-bottom-left-radius:\s*0/);
    expect(card?.body).toMatch(/border-bottom-right-radius:\s*0/);
    expect(card?.body).not.toMatch(/border(?:-bottom)?(?:-width)?:/);
    expect(exact(".card-peek")?.body).toMatch(/border-top-width:\s*0/);
  });

  it("joins the opposite edges for an upward preview", () => {
    const card = exact(".canvas-card:has(> .card-peek.up)");
    expect(card?.body).toMatch(/border-top-left-radius:\s*0/);
    expect(card?.body).toMatch(/border-top-right-radius:\s*0/);
    expect(card?.body).not.toMatch(/border(?:-top)?(?:-width)?:/);
    expect(exact(".card-peek.up")?.body).toMatch(/border-top-width:\s*1px/);
    expect(exact(".card-peek.up")?.body).toMatch(/border-bottom-width:\s*0/);
  });
});

describe("the bottom edge", () => {
  it("has an upward-opening variant", () => {
    expect(exact(".card-peek.up")?.body).toMatch(/bottom:\s*100%/);
  });

  it("opens toward the room, measured when the peek opens", () => {
    /* The side decision and the real cap are one pure function — the
       executing cases are in peekplace.test.ts; this guard holds the
       WIRING: the component calls it with the card's box and the window,
       wears its side, and hands its cap to the style. */
    expect(component).toMatch(/peekPlacement\(r\.top, r\.bottom, window\.innerHeight\)/);
    expect(component).toMatch(/place\.up \? " up"/);
    expect(component).toMatch(/maxHeight: place\.maxHeight/);
  });

  it("re-measures on resize, because the window can shrink under an open peek", () => {
    expect(component).toMatch(/window\.addEventListener\("resize", measure\)/);
  });
});

describe("the dismissal", () => {
  it("answers Escape", () => {
    expect(page).toMatch(/window\.addEventListener\("keydown", dismiss\)/);
    expect(page).toMatch(/e\.key === "Escape"/);
  });

  it("is not taken away by the pointer while the keyboard is reading it", () => {
    expect(page).toMatch(/contains\(document\.activeElement\)/);
  });

  it("keeps the rows where Tab expects them: between the open link and the ··· row", () => {
    const openAt = page.indexOf('className="card-open"');
    const peekAt = page.indexOf("<CardPeek");
    const moreAt = page.indexOf('className="card-more"');
    expect(openAt).toBeGreaterThan(-1);
    expect(openAt).toBeLessThan(peekAt);
    expect(peekAt).toBeLessThan(moreAt);
  });
});
