/**
 * **The runtime's own stderr is not the CLI's stderr.**
 *
 * Every CLI test spawns `node bin/isocan.js`, and the launcher registers tsx
 * plus the workspace loader through `module.register()` — an API newer Node
 * has begun to deprecate. On Node 26 the runtime answers an otherwise-silent
 * command with two lines of its own:
 *
 *     (node:217760) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.
 *     (Use `node --trace-deprecation ...` to show where the warning was created)
 *
 * Those lines are about the RUNTIME, not the product, but they poisoned the
 * suite's empty-stderr assertions on anything newer than CI's Node 22 and
 * read exactly like product reds: `expect(stderr).toBe("")` failed on the
 * warning line, and `not.toContain("warning")` failed on the hint line,
 * which says "warning" (isocan-wq6.1, measured 2026-09-09).
 *
 * The filter is deliberately narrow: only lines wearing the runtime's own
 * envelope — the `(node:PID) [DEPnnnn] DeprecationWarning:` prefix and its
 * paired hint — are dropped. Anything the CLI itself prints, however
 * warning-shaped, survives the filter and still fails the test. Each test
 * file applies it where the child's stderr is collected, so every assertion
 * in the file hears the CLI's voice with the runtime's shouting removed.
 */

const RUNTIME_WARNING_LINE = /^\(node:\d+\) \[DEP\d+\] DeprecationWarning: /;
const RUNTIME_WARNING_HINT = /^\(Use `node --trace-deprecation/;

export function withoutNodeRuntimeWarnings(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !RUNTIME_WARNING_LINE.test(line) && !RUNTIME_WARNING_HINT.test(line))
    .join("\n");
}
