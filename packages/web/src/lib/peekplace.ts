/**
 * **Where a card's peek fits, in the window there actually is.**
 *
 * The peek chooses a side — below its card, or above when the bottom edge is
 * near — and the stylesheet caps it at 240px. But 240 is a guess about the
 * window: on a short one an upward peek still ran 94px past the top edge
 * (measured 2026-09-09, 800×300: card 98–213, peek −94–99). So the cap is
 * the SMALLER of the stylesheet's cap and the room on the chosen side, less
 * a breath off the viewport edge.
 *
 * Pure arithmetic, one function, because the component measures and this
 * decides — and a decision that took a real browser to find wrong earns a
 * test that runs without one.
 */

/** The stylesheet's `max-height` on `.card-peek` — the cap when room is plenty. */
export const PEEK_CAP = 240;

/** Roughly what a full peek costs: below this, the other side is considered. */
export const PEEK_ROOM = 260;

/** The breath left between the peek's far edge and the viewport edge. */
export const PEEK_MARGIN = 8;

export interface PeekPlacement {
  /** Open upward: more room above the card than below, and below is tight. */
  up: boolean;
  /** The real cap for this opening — never more than the stylesheet's. */
  maxHeight: number;
}

export function peekPlacement(
  cardTop: number,
  cardBottom: number,
  viewportHeight: number,
): PeekPlacement {
  const below = viewportHeight - cardBottom;
  const up = below < PEEK_ROOM && cardTop > below;
  const room = (up ? cardTop : below) - PEEK_MARGIN;
  return { up, maxHeight: Math.max(0, Math.min(PEEK_CAP, room)) };
}
