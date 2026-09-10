---
status: designed
since: 2026-09-10
see: on-demand, inception, modules, 2026-08-30-repo-admin-canvas.md, 2026-09-02-google-docs-on-the-canvas.md
note: designed 10 Sep — five phases: derive the file, follow a row, re-read as the repository moves, say which door, prove the registry with a second source; nothing built
---
# The roadmap canvas — the phases

**10 September 2026.** Designed, nothing built. [design.md](design.md) is the
argument; [journey.md](journey.md) is what each phase must let you do.

A phase closes when its journey walks, for real, on a real canvas — the
screenshot or it did not happen rule this project already keeps. Phases 1–3 are
the roadmap canvas; 4 and 5 are the general mechanism it is the first customer
of.

## Phase 1 — The file becomes a canvas

**Recognise, fetch, parse, land.** Core learns one more closed source shape:
`github.com/<owner>/<repo>` with an optional `blob/<ref>/<path>`, defaulting to
`docs/ROADMAP.md` on the default branch; `isocan roadmap add <owner>/<repo>`
from the CLI, and the same recognition in the Add-site flow. The browser
fetches through `raw.githubusercontent.com` (CORS-open, measured), the contents
API supplies the blob `sha`, and the parse turns the file's own structure into
items: the summary card, one section per `##`, one card per row with title,
`since`, note, `see` and issue.

**Acceptance — journey 1.** The canvas agrees with the file at the named commit
row for row and number for number, for a public repository, with no token. The
source line names repository, path, commit and read time. Nothing on the canvas
is editable, and every card carries a door to its document.

## Phase 2 — Follow a row to where the work is

**Every card reaches its document; every named issue reaches its issue.** The
↗ opens the doc at the read commit; a row's issue opens the tracker. The
`see` references stay words (they name other docs, not addresses) until there
is a rule that makes them links without guessing.

**Acceptance — journey 2.** A row that names an issue has a working link to it;
a row that does not is not given one. No card links anywhere the source line
does not account for.

## Phase 3 — Re-read as the repository moves

**The watch and the age.** One conditional request (`ETag` / blob `sha`) answers
"has it changed?"; a change re-reads and re-lays the cards. The canvas carries
its age everywhere it is shown, and a reading that could not be refreshed keeps
the last commit and says so — ageing is visible, never silent.

**Acceptance — journey 3.** A real front-matter change committed upstream
reaches a canvas nobody touched. A canvas whose source is unreachable shows the
last reading with its commit and age, and never presents it as current.

## Phase 4 — Say which door

**The ladder, printed.** An external item names its door: *framed* (live),
*derived* (from a source), *photographed* (a picture, with its age). When a
frame is refused, the item prints the site's own words — `frameVerdict`
already computes them — and, when the address is a recognised source, offers
the other door: derive it. No path through the app ends in a blank rectangle.

**Acceptance — journey 5.** Adding `https://github.com/dglazkov/isocan` as a
site reports GitHub's own refusal (`x-frame-options: deny` /
`frame-ancestors 'none'`) and offers the repository door; adding a page with no
other door gives a photograph that says it is one.

## Phase 5 — One registry, two sources

**Prove it is a mechanism.** A second kind of source joins the registry the
roadmap went through — the Google Doc route is the candidate, because it exists
and doing it again properly is how two shapes become one — with a single
recogniser, one fetch rule ("the daemon only when a browser cannot"), and one
render contract.

**Acceptance — journey 4's rule holds for both:** a source that is refused,
moved, or unreachable says which, in the site's words where there are words,
and neither source can be edited into disagreement with its origin.

---

## Decisions parked, with the phase they block

- **Which ref** — default branch, or pinned to a commit? Pinned is honest and
  goes stale by design; default branch tracks. Phase 1 ships the default branch
  and *names* the commit it read, which is what makes either answer checkable.
- **Read cadence while a canvas is open** — phase 3 starts with "when the
  canvas is looked at" and adds nothing that runs when nobody is there.
- **Private repositories** — a token stored the way `isocan gdoc auth` stores
  one on a machine, and the daemon doing the fetch. Out of phase 1; the design
  keeps the door open by putting every fetch behind the same source interface.
- **A repository file other than the roadmap** — `isocan file add <repo>:<path>`
  is phase 1's parser with a different renderer. Do not build it before the
  roadmap walks; it is the same door, and the second customer is phase 5.
