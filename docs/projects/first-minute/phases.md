# The first minute — the walk

**18 September 2026.** The order of work for [design.md](design.md).
Each phase ends with **Trajectory**: only what the phase discovered
that changes the project's course. A phase that went as planned leaves
it empty.

**Where we are: phases 0 and 1 are done; phase 2 is next.** Seven phases. Phases 0 to 3
need no person. Phases 4 and 5 each open with a decision that is Dimitri's
(design.md, "Open doors") and stop there until it is made. Phase 6 is the
walk in the sandbox #332 was measured in, which lives in
dglazkov/isocannery and needs its owner. The rule for every phase:
`npm test` and `npm run typecheck` whole, and `npm run test:deep` before the
push.

## Phase 0 — A sandbox on the laptop, and the numbers

**Status: DONE, 18 Sep 2026.** `scripts/first-minute.mjs` with
`scripts/lib/first-minute-sandbox.sh`. Today's `release`: install 14.2 s / 227
packages / 115 MB, `isocan --version` 1.12 s cold and 1.07 s warm against a
0.04 s node floor, 4397 `openat` calls of which 1396 found a file. Recorded in
design.md.

**Outcome:** a script under `scripts/` that runs the installed release CLI
in a container close to #332's (Linux, Node 22, 4 cores, a cold disk, no tsx
cache) and prints three numbers: install seconds and package count for
`npm install -g github:dglazkov/isocan#release`, seconds for
`isocan --version`, and the count of files that command opens. If a plain
container does not reproduce seconds-per-command, the script runs under a
sandboxed runtime (gVisor's `runsc`) and says which it used. The numbers go
into design.md's table beside the laptop's.

**Proof:** the script's output for today's `release`, recorded in design.md,
with `isocan --version` over 1 s. If no local runtime reproduces it, that is
the phase's finding and the later proofs use file-open counts instead of
seconds.

**Trajectory:** the container reproduces 1.1 s, not #332's 3.3 s, and gVisor
was not there to close the gap — `docker info` on this machine lists `runc`
alone. So the later phases' second-targets are read against 1.1 s, and the
file-open count is the gate that means the same thing in both sandboxes: 3001
of the 4397 opens found nothing, and a sandbox that intercepts the file system
charges for those too.

## Phase 1 — The release CLI is a bundle

**Status: DONE, 18 Sep 2026.** `buildCliBundle()` in `scripts/release.mjs`;
`packageRoot()` / `packagePath()` / `packageBin()` in
`@isocan/core/packageroot`; guides imported as text, with the rule spelled
once in `md.d.ts` and adapted in four places. Proof in
`test/cli-bundle.test.ts`. In phase 0's sandbox, against a `release` built
from 328197a: **`isocan --version` 0.14 s against 1.12 s, and 474 file opens
against 4397** — past journey 1's 0.5 s target before phase 3 has begun. The
install is untouched at 227 packages, which is phase 2's.

**Outcome:** `scripts/release.mjs` builds a node ESM bundle of
`packages/cli/src/main.ts` with dependencies external, and the release
manifest's `bin` names it. Guides are inlined at build time. One
`packageRoot()` helper replaces the reads relative to `import.meta.url`
that design.md lists, and answers the same from source and from the bundle.
`bin/isocan.js` and source mode on `main` are unchanged.

**Proof:** a test that builds the release into a temporary directory,
installs it to a temporary prefix, and runs `isocan --version`,
`isocan --agent-help`, `isocan --help` and one module verb from the
installed copy with no tsx on the path it resolves. A budget test: the
bundled `--version` loads fewer than 150 modules (456 today). Phase 0's
script over the new release, recorded.

**Trajectory:** the bundle is SPLIT, not one file, and the number forced it.
Bundled into a single output `--version` loaded 538 modules — more than source
mode's 437 — because esbuild hoists an inlined module's external imports to
the top of the file it lands in, so every `await import("./design-system.ts")`
dragged fastify, the MCP SDK, ajv and the remark stack into startup. With
`splitting` each dynamic import keeps its own chunk: 142 modules, 0.20 s
against source mode's 0.38 s. Phase 3's work now counts instead of being
cancelled. The consequence for design.md's open door 1 (a thin artifact
fetchable with `curl`) is that the release CLI is 35 files, not one — the door
is still open, but it is a second build and not a flag on this one.

Two things the design did not name. `@isocan/cloudstore` has to be declared
external: it is reached by a static `import()` specifier precisely so its 156
packages never touch a CLI install, and esbuild followed it — the first bundle
built here carried @google-cloud/firestore. And `daemonBin()` in the API
cannot name `packages/cli/bin/isocan.js`, because a bundled install has no
such file; `packageBin()` reads the tree's own manifest instead.

## Phase 2 — The install resolves nothing

**Status: NOT STARTED.**

**Outcome:** dependencies are inlined into the bundle; the release manifest
declares only what would not bundle, plus `@types/node`, and each survivor
is named in the manifest's comment with the reason. The release tree drops
`docs/`, `test/` and the `.ts` sources of bundled packages; `WHATSNEW.md`,
`packages/web/dist`, the types and the browser bundles stay. A daemon
started from the installed copy serves the app.

**Proof:** phase 1's install test, extended: the installed tree has no
`docs/`, the package count after install is under 20 (227 today), and
`isocan serve` from the installed copy answers `/healthz` and serves
`index.html`. Phase 0's script: install under 5 s.

**Trajectory:**

## Phase 3 — Lazy loading

**Status: NOT STARTED.**

**Outcome:** `@isocan/server`, `@isocan/mcp`, the design stack and module
CLIs' action bodies load through `import()` from the commands that use them.
Module guides are read only by `--agent-help`.

**Proof:** the budget from phase 1 drops to under 40 modules for `--version`
and a second budget covers `isocan get` in direct mode. Phase 0's script:
`--version` under 0.5 s.

**Trajectory:**

## Phase 4 — The guide in tiers, the summons with its context

**Status: NOT STARTED.**

**Outcome:** opens with a proposed cut of `agent-guide.md` into a core and
topics, as a list of headings with token counts, and stops for Dimitri.
After the decision: `isocan --agent-help` prints the core and the topic
index, `isocan --agent-help <topic>` prints a topic, module guides are
topics. The rc's summons carries the comment's thread and the id, kind and
title of the item it is on.

**Proof:** `surface.test.ts` restated and passing: every registered command
is in the core or in a topic the index names. A budget test: the core is
under 8k tokens by a stated count. `rc.test.ts` gains a case that the
summons for a reply deep in a thread contains the earlier comments and the
item's title.

**Trajectory:**

## Phase 5 — An agent that holds no secret

**Status: NOT STARTED.**

**Outcome:** opens with the three shapes design.md names, one recommended,
and stops for Dimitri. After the decision: the chosen mode is documented in
the guide, the CLI in that mode reads and writes no `identity.json` and
sends no `Authorization`, and a proxy variable in the environment is
honoured without `NODE_USE_ENV_PROXY`.

**Proof:** a test with an empty `HOME`, the mode's inputs set, and a local
proxy that adds the `Authorization` header: `isocan ls` against a scratch
home succeeds through the proxy, and fails with a line naming the proxy when
the proxy is down.

**Trajectory:**

## Phase 6 — The walk

**Status: NOT STARTED.**

**Outcome:** journeys 1 to 3 walked in isocannery's sandbox against
`release`, with the hand-written `identity.json`, `config.json` and
`NODE_USE_ENV_PROXY` removed from isocannery, and the timings recorded
beside #332's.

**Proof:** a cold first reply under a minute and the "make it blue" turn in
three shell calls or fewer, from isocannery's own timeline. #332 closed with
the numbers.

**Trajectory:**
