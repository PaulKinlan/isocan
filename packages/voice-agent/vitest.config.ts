import { defineConfig } from "vitest/config";

/**
 * **This package's own test scope.**
 *
 * The root config's include glob picks these tests up too, so `npm test` at
 * the repo root still runs them — but that run
 * also hands them the root `setupFiles` (daemon guard, replica home) and
 * `globalSetup` (Firestore emulator): infrastructure for tests that spawn
 * processes and talk to a daemon. Nothing here does either. These tests load an
 * HTML file, drive a DOM and check DSP arithmetic, so the page's own tests
 * inheriting the app's daemon rig is both weight and a new way for the app's
 * infrastructure to break the page's suite.
 *
 * So `npm test -w @isocan/voice-agent` is the fast, honest scope, and the root
 * run is the union that CI already knows how to make.
 *
 * `environment` is left at vitest's default (node): it is right for the DSP,
 * the stylesheet and the config tests, and the three that need a DOM say so
 * in their own `// @vitest-environment jsdom` docblock — where a reader of the
 * test finds it, rather than here.
 *
 * The timeouts match the root config's, and for the same reason: these are not
 * tests that assert on elapsed time, and a machine under load must not decide
 * whether the page works.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
