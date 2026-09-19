import type { Item } from "@isocan/core";
import { automaticCanvasTarget, isCanvasItem, sourceOf } from "@isocan/core";

/** Fixed budget for a nested (depth 2) picture: enough to read the shape of
 *  the canvas inside the canvas, few enough that a wall of cards stays
 *  cheap. The level-1 budget stays `MOST_ITEMS` in CanvasCard. */
export const NESTED_MOST_ITEMS = 40;
/** Exactly one extra level: a depth-1 picture may deepen, a depth-2 picture
 *  never does. The recursion guard is a navigation rule against mazes, not
 *  a rendering rule — this is the rendering budget that lives inside it. */
export const MAX_MINIATURE_DEPTH = 2;
/** Smallest drawn size, in pixels, at which a nested canvas block deepens.
 *  Below this the picture inside would be unreadable marks, and the titled
 *  block is the honest rendering. */
export const MIN_NESTED_WIDTH = 60;
/** The height half of the same bound: a wide, one-block-tall picture inside
 *  is no more readable than a tall, narrow one. */
export const MIN_NESTED_HEIGHT = 40;

/**
 * **The whole depth-2 decision in one pure function** (isocan-wq6.5,
 * upstream #203): a canvas block inside the picture deepens into its own
 * picture only when there is exactly one level of room left, the target is
 * known, it is not an ancestor (a canvas that contains itself, or two that
 * contain each other, is a card and not a recursion), and the drawn box is
 * big enough to read.
 *
 * Everything else — on-screen gating, the pull through the source policy,
 * the plain-block fallback — is the component's job; this is the part a
 * unit test can hold to account, so it takes numbers and strings and
 * nothing else.
 */
export function canDeepen(
  depth: number,
  targetCanvasId: string | null,
  ancestors: ReadonlySet<string>,
  boxWidth: number,
  boxHeight: number,
): boolean {
  return (
    depth + 1 <= MAX_MINIATURE_DEPTH &&
    targetCanvasId !== null &&
    !ancestors.has(targetCanvasId) &&
    boxWidth >= MIN_NESTED_WIDTH &&
    boxHeight >= MIN_NESTED_HEIGHT
  );
}

/**
 * The canvas a Miniature block would deepen into, or null. The item must be
 * a canvas item whose declared target and source agree — the shared
 * `automaticCanvasTarget` parser, not a second spelling of "which canvas
 * does this point at" — and a `source` at another origin is somebody else's
 * home: the block stays a titled block rather than pulling across homes,
 * exactly the rule the direct card already follows.
 */
export function nestedTarget(item: Item, pageOrigin: string): string | null {
  if (!isCanvasItem(item)) return null;
  const target = automaticCanvasTarget(item.properties.canvas ?? null, sourceOf(item));
  if (target.kind !== "canvas") return null;
  if (target.source) {
    try {
      if (new URL(target.source).origin !== pageOrigin) return null;
    } catch {
      return null;
    }
  }
  return target.canvasId;
}
