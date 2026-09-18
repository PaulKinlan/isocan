# Roadmap canvas — the sync

> **This is the tracked copy of the README that runs on the machine**
> (`~/isocan-roadmap/README.md`), kept here so the timer's prose is reviewable
> and recoverable without that home directory. The script beside it is
> byte-identical to the live copy; this README carries one section the live copy
> does not have yet — **Recovery** below. Sync it with a copy, not a merge, the
> next time the machine is touched. The full operating guide is
> [`../runbook.md`](../runbook.md).

The canvas **Roadmap Test** (`prj_OE-AuGl119` at https://isocan.io) mirrors
`docs/ROADMAP.md` from `origin/main` and every document that table links —
one card per document, in the sheet for its section. Nothing on the canvas is
ever written back to the repository: this is the manual form of
`docs/projects/roadmap-canvas` phases 1 and 3.

    node sync.mjs              one pass — reads origin/main, edits what changed
    node sync.mjs --selftest   the parser and the sheet-growth math, on fixtures

- **State** is `.roadmap-sync.json` beside this script: `path → { item, sha }`.
  Delete it to re-add everything from scratch. Unchanged files are never touched.
- **Identity** is its own actor, `Roadmap Sync` — every version it stacks says so,
  and `undo` is per-actor, so `ISOCAN_SESSION_ID=roadmap-sync ISOCAN_HARNESS=cron isocan undo`
  takes one back.
- **Recovery** for a stranded claim — `no actor is claimed under session
  "cron:roadmap-sync"` means the claim sits on a badge this machine no longer
  holds, not that the identity was never made. **Never run the `--name` gesture
  the old message prints**: it mints a second `Roadmap Sync` and splits every
  later version and per-actor undo. (The trap is only reachable while the claim
  is actually stranded; after a recovery, `--name` merely re-asserts the same
  actor — a passing `--name` does not mean the trap is gone.) See the stranded
  actor first, then come back under the same session key:

      ISOCAN_HARNESS=cron ISOCAN_SESSION_ID=roadmap-sync isocan whoami
      cd ~/isocan-roadmap \
        && ISOCAN_HARNESS=cron ISOCAN_SESSION_ID=roadmap-sync isocan identity --session --as usr_…

  The first command prints the actor id; the second restores the same actor, so
  history and undo are intact. [`../runbook.md`](../runbook.md) has the measured
  case, the verification and what not to do.
- **Schedule**: the systemd user timer `roadmap-sync.timer`, every 15 minutes
  (`systemctl --user status roadmap-sync.timer`, stop with
  `systemctl --user disable --now roadmap-sync.timer`).
- **Exploration** is half derived, half furniture. The `Start here` card is generated
  by this script (counts per section, the commit it was read at) and is rewritten
  whenever those change — edit the documents, not that card. The six XL labels beside
  the sheets (`Partly built`, …) are hand-placed furniture, readable at 6% zoom, and
  the script never touches them.
- **Sheets** are the layout's own half and the script does not make them: the six
  areas (`Partly built`, `Designed, not built`, `No verdict recorded`, `Built`,
  `Noted — read, owing nothing`, `Superseded`) must exist before a document can
  land in one. A card is `in` a sheet when its centre is inside it.
- **A new row** in the roadmap lands through the `isocan` CLI (`add --in`), because
  a script's `at` is an unchosen placement the daemon is right to tidy away
  (`positionIsMeaningful`, `core/placement.ts`). A file that leaves the roadmap
  leaves its card behind — nothing here deletes.
- The repository is read with `git -C /home/paulkinlan/isocan`; override with
  `ROADMAP_REPO`, `ROADMAP_CANVAS`, `ROADMAP_MANIFEST` for a rehearsal.
