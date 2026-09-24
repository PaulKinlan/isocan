import { describe, expect, it } from "vitest";
import { withoutNodeRuntimeWarnings } from "./node-runtime-noise";

/**
 * **The filter is the fix, so the filter gets the test.**
 *
 * `isocan-wq6.1`'s acceptance is "on Node 26 the six files pass" — and this
 * machine is Node 24, where the runtime emits nothing to filter, so the six
 * files pass either way and prove nothing. What is checkable from here is the
 * one thing the fix actually does: that the runtime's own envelope is removed
 * and that nothing the CLI says is removed with it. A filter that stripped too
 * much would turn six loud tests into six silent ones, which is worse than the
 * bug it was written for.
 */
describe("the runtime's stderr is filtered out of the CLI's", () => {
  /** The two lines verbatim from the bead's Node 26 measurement. */
  const DEP0205 =
    "(node:217760) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.\n" +
    "(Use `node --trace-deprecation ...` to show where the warning was created)";

  it("drops the deprecation warning and its paired hint, whatever else arrived", () => {
    expect(withoutNodeRuntimeWarnings(DEP0205)).toBe("");
    expect(withoutNodeRuntimeWarnings(`before\n${DEP0205}\nafter`)).toBe("before\nafter");
  });

  it("is not a pid, a code or a line-position constant", () => {
    // A different pid and a different DEP code are the same runtime envelope.
    expect(withoutNodeRuntimeWarnings("(node:7) [DEP0040] DeprecationWarning: `punycode` is deprecated.")).toBe("");
    // The hint line is recognised by its own shape, not by following a warning.
    expect(withoutNodeRuntimeWarnings("(Use `node --trace-deprecation ...` to show where the warning was created)")).toBe("");
  });

  it("keeps everything the CLI itself says, however warning-shaped", () => {
    // The bead's other half: `not.toContain("warning")` in claiming.test.ts was
    // tripped by the HINT line, which says "warning". A product line that says
    // "warning" must survive, or the filter has eaten a real red.
    const product = [
      "warning: this canvas has no actor called Sian",
      "error: the daemon refused the op",
      "(node:1) a line that merely starts like the runtime's",
      "DeprecationWarning: printed by the CLI, not by node",
    ].join("\n");
    expect(withoutNodeRuntimeWarnings(product)).toBe(product);
  });

  it("leaves an empty stderr empty, and a lone newline a lone newline", () => {
    expect(withoutNodeRuntimeWarnings("")).toBe("");
    expect(withoutNodeRuntimeWarnings("\n")).toBe("\n");
  });
});
