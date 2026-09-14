# Design lint: the implementation walk

**Where we are — 14 September 2026:** Research and issues #299–303 are published.
All implementation phases are NOT STARTED. Next is design-lint phase 1 on
current `origin/main`. Paid evaluation and human ratings wait on a person;
native diagnostics, repair, contracts and repository compatibility do not.

The [journeys](journey.md) are acceptance and [design](design.md) names the
mechanisms. Each phase closes only on its named proof, with a full suite,
typecheck and the deep suite before push. Shared computation belongs in core;
reads need no operation, and a repair uses conditional `item.edit`. Fixtures are
synthetic. A passing lint report is not visual approval. The conductor owns
these records and independently verifies the builder's output.

## Phase 1 — Parsed diagnostics and governing provenance (#300)

**Status: NOT STARTED.** 2026-09-14 — The old regex audit remains in production.

**Work:** Measure and choose HTML/CSS parsers; implement shared diagnostics,
coverage and compatibility aggregates; resolve each item's governing system
through shared context readers; wire the current CLI audit and a browser-safe
reader entry point to the same report. Cover all cases in issue #300.

**Proof:** Run `npm test`, `npm run typecheck`, `npm run build` and
`npm run test:deep -- --maxWorkers=6`. Replay the seven research probes with
corrected classifications; inspect source-range, alias/fallback/cycle,
malformed/dynamic/external-style and shorthand negative controls. Test nested
groups, scoped-only and inherited systems through real analyzer inputs and
both I/O adapters. Record standalone parser and app bundle measurements.
Exercise `design audit` against a fresh local daemon and synthetic canvas.

**Trajectory:**

*nothing — implementation has not begun.*

## Phase 2 — Findings and conditional repair on both surfaces (#302)

**Status: NOT STARTED.** 2026-09-14 — Depends on design-lint phase 1.

**Work:** Add item/file audit selection and opt-in failing exits, structured
advisory arrival evidence, browser findings with source selection, and explicit
version-checked repair with fresh before/after reports. Document a two-round
agent budget and retain ordinary version/undo behavior. Update README and guide.

**Proof:** Run the full verification commands from design-lint phase 1. Drive a
real browser and a freshly started local daemon: add identical synthetic bad
HTML from CLI and browser, compare reports, select a finding's source, repair,
undo and attempt a stale concurrent repair. Verify CLI file/JSON/failure modes
and that audit errors after storage never misreport a successful write.

**Trajectory:**

*nothing — implementation has not begun.*

## Phase 3 — Scoped declarative recipe contracts (#301)

**Status: NOT STARTED.** 2026-09-14 — Depends on design-lint phases 1 and 2.

**Work:** Finalize and record the version 1 schema before coding. Preserve
unknown extension data or report unsupported conversion. Implement literal
policy, explicit recipe/treatment markers, ownership and reasoned exceptions.
Expose the effective contract and source on both surfaces using normal edits.

**Proof:** Run the full verification commands from design-lint phase 1. Test
native and supported export/import round trips, unknown versions/rules, nested
groups and inheritance, separate lane policies, Button placement versus owned
padding/radius, and title size versus owned weight. In a real browser inspect
the effective policy, edit the governing document, observe changed findings
and undo the edit. Confirm an HTML repair cannot weaken the governing policy.

**Trajectory:**

*nothing — implementation has not begun.*

## Phase 4 — Optional repository checks and Tailwind proof (#303)

**Status: NOT STARTED.** 2026-09-14 — Uses phase 1 report shape; no native blocker.

**Work:** Build the pinned local Tailwind runner and reproducible fixture,
isolated from browser dependencies. Measure monorepo/config/component behavior,
unsupported and unavailable states, source mapping and runtime. Record a go/no-go
and the spacing-policy boundary. Survey the other recommended technology checks
with concrete compatibility probes for CSS, HTML and rendered accessibility;
retain optional adoption and existing project configuration.

**Proof:** Run the full verification commands from design-lint phase 1 and
the pinned adapter fixture in a scratch repository. Exercise custom theme,
component directory, monorepo alias/barrel, unsupported HTML/CSS and missing
dependencies/theme. Findings carry relative paths and tool/config identity;
the app bundle contains no upstream runner. Record actual tool output and
go/no-go, including a negative control that cannot report a false clean result.

**Trajectory:**

*nothing — implementation has not begun.*

## Phase 5 — Controlled repair evaluation (#302)

**Status: NOT STARTED.** 2026-09-14 — Harness follows product phases; paid runs wait.

**Work:** Prepare equal-budget rules-only versus diagnostics tasks and a dry-run
harness, declare go/no-go thresholds, and render fixtures at intended sizes.
Record compliance, false positives, uncovered styling, system changes, rounds,
latency and spend separately from visual intent and interaction results.

**Proof:** Run the full verification commands from design-lint phase 1 and a
no-spend dry run exercising both conditions and failure/empty-render controls.
Then run the approved paid comparison and collect human intent ratings. Publish
the actual results; no model lift or human preference is inferred from dry runs.

**Provision:** ⚑ Paid model calls require a stated cap and user approval after
the harness is reviewable. Human intent ratings wait on a person's review.

**Trajectory:**

*nothing — implementation has not begun.*
