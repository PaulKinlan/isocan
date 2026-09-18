# Roadmap canvas — the sync timer's runbook

`docs/ROADMAP.md` and every document its table links are mirrored onto the
**Roadmap Test** canvas by a user timer on this machine. The canvas is derived,
never edited: a verdict is written in the document's own front matter and the
canvas is re-read from `origin/main`, always naming the commit it was read at
(the plan is the *roadmap canvas* epic; this directory is its operating half).

The sync runs from `~/isocan-roadmap`, **outside any repository**, because it
consumes a published `isocan` build rather than this checkout. That is why the
definition and the one recovery an operator needs are tracked here, beside the
script's own copies in [`roadmap-sync/`](roadmap-sync/) — so a reader of the
repository, on a machine that has never seen this one, can restore the timer
and get a stranded claim back without guessing.

## The timer, at a glance

| | |
| --- | --- |
| **What** | `roadmap-sync.service` runs `node sync.mjs` once and exits: it reads `origin/main:docs/ROADMAP.md` and every linked document, and lands what changed as new versions on the Roadmap Test canvas. Nothing is written back to the repository. |
| **When** | `roadmap-sync.timer` — every 15 minutes (`OnUnitActiveSec=15min`), `Persistent=true`, first fire 3 minutes after boot. |
| **Where** | `WorkingDirectory=%h/isocan-roadmap`; the units live in `~/.config/systemd/user/`. |
| **Identity** | its own actor, **Roadmap Sync**, under the session key `cron:roadmap-sync` (`ISOCAN_HARNESS=cron ISOCAN_SESSION_ID=roadmap-sync`). Every version it stacks says so, and `undo` is per-actor, so one can be taken back with the same key. |
| **State** | `.roadmap-sync.json` beside the script — `path → { item, sha }`. Never in a repository. Deleting it re-adds every card. |
| **Canvas** | the marker at `~/isocan-roadmap/.isocan/project.json`: `prj_OE-AuGl119` (“Roadmap Test”), home `https://isocan.io`. |
| **Selftest** | `node sync.mjs --selftest` — the parser and the sheet-growth math, on fixtures. |
| **Rehearsal** | `ROADMAP_REPO`, `ROADMAP_CANVAS` and `ROADMAP_MANIFEST` override the repository, canvas and state file. |

## The definition of record

[`roadmap-sync/`](roadmap-sync/) carries, verbatim:

- [`sync.mjs`](roadmap-sync/sync.mjs) — the script (274 lines).
- [`roadmap-sync.service`](roadmap-sync/roadmap-sync.service) and
  [`roadmap-sync.timer`](roadmap-sync/roadmap-sync.timer) — the units.
- [`package.json`](roadmap-sync/package.json) — its one dependency,
  `isocan@github:dglazkov/isocan#release` (a published build, not this checkout).
- [`README.md`](roadmap-sync/README.md) — the operational prose, including the
  recovery section.

The live copies are at `~/isocan-roadmap/{sync.mjs,README.md,package.json}` and
`~/.config/systemd/user/roadmap-sync.{service,timer}`. The live README does not
yet carry the recovery section this copy does; syncing it is a copy, not a merge
(`cp roadmap-sync/README.md ~/isocan-roadmap/README.md` — the script itself is
byte-identical). When the script changes on the machine, copy it back here in the
same change; a definition that drifts from the thing that runs is the debt this
directory exists to discharge.

## When it fails: `no actor is claimed under session "cron:roadmap-sync"`

This is the one failure a long-running script actually reaches, and it cost this
timer eight days (2026-09-10 to 2026-09-18) while its canvas froze. It does **not**
mean the identity was never made. It means the claim is **stranded**: the actor
`Roadmap Sync` is still on the home's desk under `cron:roadmap-sync`, held by a
badge this machine no longer holds — a wiped browser profile, a re-badged home.
The migration shelf is empty in exactly that case, so nothing adopts it for you.

### The trap

Until the fix below reaches the published release, the timer's own stderr says:

```text
no actor is claimed under session "cron:roadmap-sync" — claim it once:
ISOCAN_HARNESS=cron ISOCAN_SESSION_ID=roadmap-sync isocan identity --name "Your Name" --session
```

**Do not run that.** `--name` mints a SECOND actor wearing the same display name:
refused as name-taken, or admitted and splitting every later version and every
per-actor `undo` across two actors. The history the key already has stays behind.

**This trap is only reachable while the claim is actually stranded** (this
machine's badge is gone). After a successful recovery, re-running the `--name`
line merely re-asserts the same actor and is harmless — which is why testing the
trap requires a stranded claim, and why a passing `--name` does not mean the trap
is gone. Do not conclude the warning is stale because the advice appeared to
work on a machine that had just recovered.

That message is the reason this runbook exists; the `--as` gesture below is the
recovery, and the code change that teaches scripts to print it is `isocan-irs`
commit `c2778610` (`packages/api/src/connect.ts`, `noActorUnderKey`), in review at
the time of writing.

### Recover, in four steps

1. **See the stranded actor.** Present the same session key and ask who you are —
   the CLI already names it here (this is the ambient path's honest refusal, the
   same one `connect()` is being taught to speak):

   ```sh
   ISOCAN_HARNESS=cron ISOCAN_SESSION_ID=roadmap-sync isocan whoami
   ```

   ```text
   error: no identity here — this machine's badge (bdg_…) holds no claims, but this home
   has an actor on another badge: Roadmap Sync (usr_…), named 6s ago. That is this
   conversation's own session key, so if it is you, come back with
   `isocan identity --session --as usr_…` — `--name` would make you somebody new and
   leave your history behind.
   ```

2. **Come back as that actor** — the same session key, under the timer's directory.
   The desk excludes the key it is asked about from “held elsewhere”, so this needs
   no vouch:

   ```sh
   cd ~/isocan-roadmap && \
     ISOCAN_HARNESS=cron ISOCAN_SESSION_ID=roadmap-sync isocan identity --session --as usr_…
   ```

   The id is the one step 1 printed. Same actor id as before, so history and `undo`
   are intact; no new canvas is created.

3. **Run it once and read the timer's own journal**, not the script's:

   ```sh
   systemctl --user start roadmap-sync.service
   journalctl --user -u roadmap-sync.service -n 20
   ```

   Success is `ExecMainStatus=0` and a line like
   `synced a770255c — 103 documents tracked, 56 changed`. The first fire after a
   recovery lands the drift; the **next** one should be quiet — `0 changed`, about
   two seconds — which is the proof the claim survives across fires.

4. **Check attribution on the persisted canvas, not the script's log.** Every op a
   fire lands is stamped with the actor:

   ```sh
   grep -o '"actor":{"id":"[^"]*"' ~/.isocan/projects/prj_OE-AuGl119/oplog.jsonl \
     | sort | uniq -c | sort -rn
   ```

   After the recovery above, every op a fire lands carries the actor's id
   (`usr_AgRvjzUBIN` for the recovery measured on 2026-09-18, 111 ops at the time
   of writing) and none carries no actor at all. A replica keeps its own copy of
   the log; the home's is the one that counts.

### What not to do

- **Never** `--name` for this failure. A second “Roadmap Sync” is the damage.
- **Do not delete `.roadmap-sync.json`** to “start clean”: that re-adds every card
  as new versions. It is for rebuilding the canvas from nothing, not for a refusal.
- **Do not read a non-zero exit as content drift.** Identity first: `--name`-shaped
  advice in the log means a stranded claim, not a broken roadmap table.
- **Do not move the canvas.** The id in the marker (`.isocan/project.json`) is what
  the script derives to; a different canvas is a different project.

## Rebuilding the timer on a machine that never had it

1. `mkdir -p ~/isocan-roadmap && cd ~/isocan-roadmap`, then copy
   [`roadmap-sync/`](roadmap-sync/) in as `sync.mjs`, `package.json` and `README.md`,
   and `npm install` (this pulls the published release, not the checkout).
2. Write the two units to `~/.config/systemd/user/`, substituting `%h` for that
   machine's home — the copies here already use `%h`, so they are installable as-is.
3. `systemctl --user daemon-reload && systemctl --user enable --now roadmap-sync.timer`.
4. Bind the directory to its canvas so the marker names the right home, then make the
   identity. On a machine the actor has never been on, that is a **claim**, not a
   recovery:

   ```sh
   cd ~/isocan-roadmap && \
     ISOCAN_HARNESS=cron ISOCAN_SESSION_ID=roadmap-sync isocan identity --session --name "Roadmap Sync"
   ```

   If the answer is “name-taken”, the actor exists on this home already — go back to
   the recovery above and use `--as`, never a different name.
5. The six sheet areas and the hand-placed XL labels are canvas furniture the script
   does not create; a rebuild on a fresh canvas is incomplete without them (they are
   described in the script's README).

## Where this is tracked

- The plan for the canvas itself: the **roadmap canvas** epic (isocan-91s) —
  `journey.md`/`design.md`/`phases.md` are still owed; this directory holds the
  operating mechanism until they land beside it.
- The wrong-advice fix at its source: `isocan-irs` — `packages/api/src/connect.ts`
  (`noActorUnderKey`), in review.
- The measured failure and recovery: `isocan-9ww` (this runbook) and `isocan-irs`;
  the eight-day journal record and the recovery's operator evidence are cited in
  those beads.
