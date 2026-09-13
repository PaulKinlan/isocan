# Mobile — the walk

The staged design is the [mobile research](../../research/2026-09-05-mobile-web.md).
The journeys here turn its first three stages into reviewable proofs. There
is no new operation; gestures reach the intents both clients already share.

**Where we are:** stage 0's pan, pinch and basic narrow layout shipped before
this continuation. Finish its controls, then stage 1's phone face and stage
2's presentation input. Emulated proofs run here; physical-phone acceptance
is a named remaining hand.

## Stage 0 — Finish touch controls

**Status: PART-DONE.** 13 September 2026 — pan, pinch and minimap folding
already exist; long press, target sizing and rail folding remain.

**Proof:** journey 2 in a built browser with touch input. Measure bounds at
375×812, tablet width and a narrow mouse window. Assert one/two-finger
transforms, cancelled long presses and no preference changes on resize. Run
the full suite and typecheck. Judge gesture feel on an actual phone.

## Stage 1 — Chat first, with the work one tab away

**Status: NOT STARTED.**

**Proof:** journey 1 on a synthetic canvas through the real browser. Submit
Chat through the UI and inspect its daemon record; open an item from the
sheet and an agent stage from the roster. Repeat with a read admission.
Resize both ways without losing desktop preferences or a Chat draft. Run
the full suite and typecheck; check the composer with a real phone keyboard.

## Stage 2 — Present by touch

**Status: NOT STARTED.**

**Proof:** journey 3 in both viewer and fullscreen. Tap and swipe forward
and back, try the boundaries, vertical movement and interactive controls,
open/close Notes and exit. Check the printable deck route. Run the full
suite and typecheck, then the same walk on a real phone.

## Later stages

Stage 3 handoff and stage 4 install/share targets keep the research's order
and are outside this continuation. A native app remains refused.

## Trajectory

- **2026-09-13** — Open: physical-phone keyboard behavior, Safari toolbar
  changes and gesture feel need a phone. Desktop touch emulation is useful
  evidence about events and layout, and cannot close those observations.
