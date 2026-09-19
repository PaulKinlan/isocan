# The first minute — the design

**18 September 2026.** The debt this discharges is
[#332](https://github.com/dglazkov/isocan/issues/332): an agent in a small
hosted sandbox pays for isocan at every step of a turn, and a laptop hides all
of it. [journey.md](journey.md) has the three journeys and their targets. This
doc says where the time goes, what to change, and which decisions are open.

## What was measured

On a laptop, 18 Sep 2026, at 61f7616a, `isocan --version`:

| | real | user CPU |
| --- | --- | --- |
| today, tsx cache warm | 0.29 s | 0.43 s |
| today, tsx cache cold (`TMPDIR` empty) | 0.38 s | 1.16 s |
| esbuild bundle of `main.ts`, dependencies external | 0.17 s | 0.22 s |
| `node` alone | about 0.04 s | |

The same command in the #332 sandbox takes 3.3 s.

**Every command loads everything.** Counted with a `load` hook,
`isocan --version` loads 456 modules:

- 297 are our own `.ts` files, 4.7 MB of source: core 137, server 50, api 40,
  cli 35, and the rest module CLIs. `bin/isocan.js` registers tsx, so each of
  them is transpiled, or hashed and looked up in tsx's cache, on every
  command. A sandbox with a fresh disk has no cache.
- 134 are from `node_modules`: zod 95, tsx 22, ws 9.
- All of `@isocan/server` is imported, fastify included, by a command that
  prints a version.
- Every module's `cli.ts` reads its `agent-guide.md` from disk at import time
  (`guide: readFileSync(...)`), whatever the command.

This is the same cost `scripts/roadmap.mjs` measured on 6 Sep 2026 (571 ms a
spawn, 35 s for `roadmap.test.ts`) and the reason the deep lane of the suite
is four minutes: thirty-seven files that spawn the CLI per case.

Why the sandbox turns 0.3 s into 3.3 s was not measured here. The likely cause
is that hosted sandboxes intercept file system calls, so 456 opens and reads
cost far more than on a laptop's disk. Phase 0 measures it.

**What installs.** The `release` branch is HEAD's whole tree plus the built
app, the types and the browser bundles (`scripts/release.mjs`). About 40 MB:

| | MB | an install runs it |
| --- | --- | --- |
| `packages/web` (src and `dist`) | 13.7 | `dist` only, when a daemon serves the app |
| `docs/research` | 9.6 | no (two tarballs are 3.7 and 3.3 MB) |
| `docs/projects`, `changelog`, `reviews`, one 0.8 MB jpg | 4.2 | no |
| `packages/core`, `server`, `cli`, `api` sources | 8.6 | yes, as source, through tsx |
| `test/fixtures` | 0.6 | no |

The 227 packages come from 19 declared dependencies: fastify, the remark
stack, css-tree, parse5, zod, the MCP SDK, and tsx (which brings esbuild and
its platform binary) only because the CLI ships as source.

**The guide** is 189 KB in one file, with each loaded module's guide appended.
There is no way to ask for part of it.

## What to change

### 1. The release CLI is a bundle

`release.mjs` already runs esbuild for the browser bundles. It gains a node
bundle of `packages/cli/src/main.ts` (ESM, `platform: node`), and the release
manifest's `bin` names it. tsx, `workspace-loader.mjs` and 297 file reads are
gone from every command. Source mode is unchanged on `main`: a checkout still
runs `bin/isocan.js` through tsx.

What the bundle breaks is every read relative to `import.meta.url`, because
the file is no longer where its source was. They are:

- `cli/src/agent-guide.ts` and eight module `cli.ts` files: `agent-guide.md`.
- `cli/src/main.ts`: the skill directory, `.git`, the package root
  (`myRoot`), `scripts/canvas-shot.mjs`, `scripts/deck-export.mjs`.
- `server/src/build.ts` and `http.ts`: the package root, for the build stamp,
  `WHATSNEW.md` and `packages/web/dist`.
- `api/src/client.ts`: one path beside itself.
- `modules/design-competition/src/cli.ts`: files beside the module.

Two fixes cover them. Text the CLI prints (the guides) is inlined at build
time with esbuild's text loader. Paths into the package (root, `dist`,
scripts) go through one `packageRoot()` helper that answers correctly from
both a source file and the bundle. Runtime modules under `~/.isocan/modules/`
are already built JavaScript reaching core through `globalThis.isocan`, so
they need nothing.

### 2. The install resolves nothing

Inline the dependencies into the bundle and the release manifest declares
none for the CLI. `@types/node` stays, for `connect()`'s consumers. Whether
fastify and the MCP SDK bundle cleanly is phase 2's first question; anything
that does not stays a declared dependency, and the count is still far under
227.

The release tree drops what an install never runs: `docs/`, `test/`, and,
once the bundle exists, the `.ts` sources of the bundled packages.
`release.mjs` already removes `.github/` from the tree, so this is more of
the same filter. `WHATSNEW.md` and `packages/web/dist` stay.

### 3. Lazy loading inside the bundle

After 1, about 0.13 s of the 0.17 s is evaluating modules a command does not
use. `@isocan/server`, `@isocan/mcp`, the design stack and module CLIs move
behind `import()` in the actions that need them; module guides are read only
by `--agent-help`. This matters less than 1 and 2 and comes after them.

### 4. The guide in tiers, the summons with its context

`isocan --agent-help` prints the core protocol and an index of topics.
`isocan --agent-help <topic>` prints one topic; module guides are topics.
`surface.test.ts` keeps its rule, restated: every registered command appears
in the core or in a topic the index names.

The rc's summons (`packages/rc/src/helpers.ts`) carries the thread the
comment is in and the id, kind and title of the item it is on, so the first
command of a turn can be the edit.

### 5. An agent that holds no secret

The CLI accepts an identity from the environment: the home, the actor's
public ids, and a statement that authorization is added upstream. It writes
and reads no `identity.json` in that mode and sends no `Authorization` of its
own. Separately, the CLI installs undici's `EnvHttpProxyAgent` as the global
dispatcher when a proxy variable is set, so `HTTPS_PROXY` works without
`NODE_USE_ENV_PROXY`. undici is already a dependency.

### 6. The guard

Two budgets in the suite, because the laptop will never show the regression:

- the number of modules `isocan --version` loads from the bundle, and the
  bundle's size;
- the token count of the core guide.

## Open doors

These are Dimitri's, and the walk stops at each.

1. **A thin artifact.** A direct-mode agent never runs a daemon, so a bundle
   with no server and no web app would be one small file, fetchable with
   `curl`; its size was not measured. It is also a second thing to ship, test and explain. The design
   above does not need it to meet the targets; decide after phase 2's
   numbers.
2. **How the guide is cut.** What is core and what is a topic is a judgement
   about what an agent must know before her first act. Phase 4 proposes a
   cut and stops.
3. **The shape of the no-secret identity.** Environment variables, a flag on
   `isocan direct`, or a config file isocan writes. It changes when the CLI
   refuses for want of an identity, so it is a design call and not plumbing.

## What this does not change

The op vocabulary, the reducer, the daemon, and anything on `main`'s source
mode. Every change here is in how the CLI is packaged, how it starts, and what
it prints.
