---
status: designed
since: 2026-09-18
issue: 332
see: auto-upgrade, room, iso-api, harnesses
note: designed 18 Sep 2026 from #332. An agent in a small hosted sandbox (cold disk, slow file system, a proxy for a network, no secret) spends most of a person's minute on isocan itself — 35 s installing 227 packages, 2 to 4 s starting the CLI for every command, 50k tokens of guide. Measured the same day — `isocan --version` loads 456 modules, 297 of them our own `.ts` transpiled by tsx per command; an esbuild bundle of the same CLI starts in 0.17 s against 0.29 s on a laptop that hides the cost. The walk bundles the release CLI, inlines its dependencies, slims the release tree, tiers the guide, and gives an agent with no secret a supported way to say who she is. Three doors are Dimitri's and open — a thin agent-only artifact, how the guide is cut, the shape of the no-secret identity. Nothing built.
---
# The first minute — the journeys

**18 September 2026.** Three journeys, each a thing the agent in
[#332](https://github.com/dglazkov/isocan/issues/332) does in the first minute
of a turn, with the number that says it is fixed. She runs in a hosted sandbox:
4 cores, a slow file system, a fresh disk every so often, an egress proxy as
her only way out, and a badge held outside the sandbox. The numbers on the
"today" lines are the issue's, measured 18 Sep 2026 from isocannery's walk.
The targets are proposed, not decided.

## 1. She arrives

A new sandbox has Node and nothing else. She runs one install line and then
her first command.

- **Today:** `npm install -g github:dglazkov/isocan#release` takes 35 s and
  installs 227 packages. It is the one thing that puts a cold reply over a
  minute.
- **Target:** install in under 5 s, with no dependency to resolve.
- **Today:** every command takes 2 to 4 s to start, `isocan --version`
  included (3.3 s), where a `fetch` of the same home from the same sandbox
  takes 1 s. A turn of five commands spends 10 to 15 s starting the CLI.
- **Target:** `isocan --version` in under 0.5 s in that sandbox, and a command
  that talks to the home costs the network call plus that.

## 2. She is herself

Her badge is outside the sandbox: the proxy sets `Authorization` on requests
to the home. She holds her public ids and no secret.

- **Today:** the CLI refuses without a local identity, so the sandbox is
  handed a hand-written `~/.isocan/identity.json` with a placeholder secret
  and a hand-written direct-mode `config.json`. And `isocan direct` says
  nothing answered until `NODE_USE_ENV_PROXY=1` is set, because the CLI's
  `fetch` ignores `HTTPS_PROXY`.
- **Target:** she says who she is and where her home is in a way isocan
  documents and tests, writes no file by hand, and `HTTPS_PROXY` is honoured
  with no extra variable.

## 3. She wakes to "make it blue"

A person comments on an item. The rc summons her with that comment.

- **Today:** the summons points her at `isocan --agent-help`, which is 210 KB
  with module guides, about 50k tokens, carried again on every model call of
  the turn. The summons has the one comment and not the thread or the item,
  so she runs `comment list` and `get` before she can start. In the 146 s
  turn, three of her ten shell calls were `--help`.
- **Target:** what she must read before acting is under 8k tokens; the rest
  is reachable by topic. The summons carries the thread and the item it is
  on, so "make it blue" is answered in three shell calls or fewer: the edit,
  the reply, the wait.

## What the journeys force

1. A release CLI that is one file, started without a transpiler.
2. An install with no dependencies to resolve and no files an install does
   not run.
3. A guide in tiers, with the test that every verb is described somewhere
   kept.
4. A summons that carries its own context.
5. A supported identity for an agent that holds no secret, and a `fetch` that
   honours the proxy environment.
6. A guard in the suite for 1 and 3, so the next forty features do not undo
   them. The laptop hides all of this; a number in a test does not.
