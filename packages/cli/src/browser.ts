import { spawn } from "node:child_process";

/**
 * **How this machine opens an address, said once.**
 *
 * Three verbs open a browser — `isocan open`, `isocan setup`, and the operator's
 * proof and look — and until now each spelled the spawn itself. A second
 * spelling of "how do you open a browser here" is a second thing to get wrong
 * on a machine that has no session, no display, or no business opening windows
 * at all, which is exactly what happened: the operator verbs landed on 12–13
 * September and a test run started putting browser windows on somebody's
 * screen.
 *
 * **`ISOCAN_BROWSER=none` means print it, do not open it.** The callers all
 * print the address anyway — that is the rule the operator's opener already
 * stated, because a machine with no browser still needs the line — so refusing
 * to spawn loses nothing and is the whole difference between a test suite and
 * a poltergeist. `test/setup.ts` sets it for every worker, and the CLI children
 * a test spawns inherit it through `{ ...process.env }`, so a test cannot open
 * a window by forgetting to ask not to.
 *
 * It is a person's switch as well as a harness one: over SSH, in a container,
 * or on a machine where the browser is not where the work is, `ISOCAN_BROWSER=none`
 * makes every verb hand you the address instead of throwing a window at a
 * display you are not looking at.
 */
export function openInBrowser(url: string): void {
  if (process.env["ISOCAN_BROWSER"] === "none") return;
  spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
    stdio: "ignore",
    detached: true,
  }).unref();
}
