# The OPFS acceptance run — 2026-09-13

The evidence `isocan-xsh.8.18` asks for, run against the page as shipped:
**write a memory, reload the page, read it back — then close the browser
entirely, reopen it with the same profile, and read it again.** That is a harder
claim than the process restart the harness version proved, and it is the claim
that matters now that the store is the page's.

`run.mjs` is the script; `evidence.txt` is its output from the run recorded
here (`ACCEPTANCE: PASS`).

## How it was run

  - The real page source from this branch, served by a second Vite on `:5201`
    with `/harness` proxied to a **stand-in harness** (`:7664`) that serves the
    two legacy routes with the shape the real ones return. The stand-in exists
    so the write goes through the page's OWN migration path rather than through
    a test-only hook; the page's broker paths are covered by unit tests.
  - Headless Chrome with a **persistent `--user-data-dir`** (`/tmp/voice-opfs-profile`),
    which is what makes step 3 meaningful: the same profile, a brand-new browser
    process.

## What the run shows

  1. **Written**: the page's migration reads the legacy entries and writes them
     into OPFS — the panel shows `2 memories`, and reading OPFS directly shows
     `voice/memories.json` with 2 entries.
  2. **Reload**: still 2, both in the panel and in OPFS.
  3. **Browser restart**: Chrome killed, relaunched on the same profile — still 2
     in the panel and in OPFS.
  4. **The person's Forget** removes one (`1 memory`), from the same panel.

## One honest note in that output

`persisted: false`. The page **does** call `navigator.storage.persist()` (that
is the point of it), and this fresh headless profile **declined** — Chrome grants
persistence on its own heuristics (engagement, installation), not on request.
The UI therefore says exactly what is true: *"Stored in this browser for this
session only — this browser would not grant persistent storage, so it may be
cleared."* The data still survived the browser restart in this run; what the
declined grant means is that the browser reserves the right to evict it under
storage pressure. That is the difference between "it is here" and "the browser
has promised to keep it", and the page reports which one you have rather than
implying the stronger claim.
