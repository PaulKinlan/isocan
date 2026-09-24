---
status: designed
since: 2026-09-10
see: on-demand, inception, modules, 2026-08-30-repo-admin-canvas.md, 2026-09-02-google-docs-on-the-canvas.md
note: designed 10 Sep — a canvas that IS docs/ROADMAP.md, derived from the repository and re-read as the repository moves; journeys written, nothing built
---
# The roadmap canvas — the journeys

**10 September 2026.** Designed, nothing built. [design.md](design.md) argues
the mechanism and answers the general question under it — *what may a canvas
show from the web, when the web refuses to be framed?* [phases.md](phases.md)
orders the work.

**You** are the person who keeps this repository. The roadmap is the document
you and your agents read to know what the project believes about itself, and it
is already derived: `docs/ROADMAP.md` is generated from the front matter of
every research note and project, so it cannot drift from what it describes.
What it has never had is a surface you can stand on — it is a table in a git
tree, and reading it means leaving wherever you were.

The canvas this journey builds is a **view**, in the same sense the file is:
derived and regenerated, never edited. The place a verdict is written stays the
front matter of the document the verdict is about. Every journey below is an
acceptance test; a phase closes only when you can walk it, for real.

## Journey 1 — The roadmap is a canvas, and it arrived by itself

*One gesture, and the repository's own account of itself is on the canvas.*

1. Add it the way you add any site, or from the CLI: `isocan roadmap add
   dglazkov/isocan`. The address is a repository and a path
   (`docs/ROADMAP.md`), and isocan recognises that shape rather than treating
   it as a web page. (The same recognition `isocan gdoc add` does for a Google
   Doc address — a closed set, never a general proxy.)
2. The canvas lands holding the roadmap: the summary numbers as a card at the
   top, then one card per row, grouped by the file's own sections — Partly
   built, Designed, Built, Noted, Superseded.
3. The footer says where it came from and when: the repository, the path, the
   commit the file was read at, and how long ago that was.

**Acceptance:** The canvas and the file agree at the named commit, row for row
and number for number. Adding it needs no token for a public repository. The
canvas names its source and its age without being asked.

## Journey 2 — Follow a row to where the work is

*The canvas is a lens, not a terminus.*

1. A card reads *The flake family, and the first one caught in the act — 4 of 5
   witnesses diagnosed*. You click the card's ↗ and land on the document in
   GitHub, at the commit the canvas read.
2. Where a row names an issue, the card carries it, and the issue opens in a
   tab.
3. Back on the canvas, nothing moved. The card you were reading is where you
   left it.

**Acceptance:** Every card reaches its document, and every row that names an
issue reaches the issue. No link sends the reader anywhere the canvas did not
name.

## Journey 3 — It is re-read as the repository moves

*The canvas is synced, and says how old it is.*

1. A merge lands on `main` that changes a document's front matter. The roadmap
   file changes with it.
2. The canvas notices — the repository is watched, the way the repo-admin
   canvas watches commits — and re-reads. A card that moved section moves; a
   row that changed its note says the new note.
3. The footer's age resets. If the canvas cannot reach the repository, it does
   not go blank and it does not lie: it keeps the last reading and says it is
   reading from *that* commit, with its age.

**Acceptance:** A real commit upstream reaches the canvas without anybody
touching it. A canvas that has not been re-read is visibly old, and a canvas
that could not be re-read says so instead of showing yesterday's file as
today's.

## Journey 4 — It cannot drift, because it cannot be edited

*The rule that keeps a second copy honest: derived, or decided, never both.*

1. You try the obvious thing: edit a card's words. There is nothing to edit —
   the canvas says where the verdict lives, and offers the document.
2. You change the verdict the right way: the front matter of the document. The
   next reading carries it.

**Acceptance:** No gesture on this canvas can put it out of step with the file
it is a view of. The canvas offers a door to the document for every row, and
the door is the only way to change what a row says.

## Journey 5 — A site that refuses, and what the canvas says instead

*The general question, walked once.*

1. You try to add `https://github.com/dglazkov/isocan` as a site. GitHub
   refuses to be framed — measured: `x-frame-options: deny` and
   `frame-ancestors 'none'` — and the canvas says so in GitHub's own words
   rather than showing a blank rectangle.
2. Because the address is a *repository*, the refusal comes with the other
   door: offer to derive it. It is the same repository either way; one door is
   closed by the site, and one is open to anybody who can read a file.
3. For a page that is neither frameable nor readable as data, the canvas says
   which door it took — a picture, with the age of the picture.

**Acceptance:** Every external item names its door (framed, derived,
photographed) and, when a door is refused, whose words refused it. There is no
path through the app that ends in a silent blank rectangle.
