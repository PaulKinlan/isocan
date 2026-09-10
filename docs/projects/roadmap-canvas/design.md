---
status: designed
since: 2026-09-10
see: on-demand, inception, modules, 2026-08-30-repo-admin-canvas.md, 2026-09-02-google-docs-on-the-canvas.md
note: designed 10 Sep — the mechanism under the roadmap canvas, and the three doors a canvas has for showing somebody else's web: frame it, derive it, photograph it; derived-and-regenerated, never edited
---
# The roadmap canvas — the design

**10 September 2026.** Designed, nothing built. [journey.md](journey.md) is
what it feels like; [phases.md](phases.md) orders the work.

## The question

Two questions, and the second is the one worth the note.

**A canvas that is the roadmap, synced to the repository.** `docs/ROADMAP.md`
is derived from the front matter of every document, and it is the best summary
this project has of what it believes about itself. It is also a table in a git
tree. The canvas should be that table, alive, on the home screen.

**What may a canvas show from the web, when the web refuses to be framed?**
"Isocan item = an iframe" is how *Add site* works today, and most of the public
web refuses it: `X-Frame-Options` and CSP `frame-ancestors` exist precisely to
stop a page being embedded by somebody else. A blank rectangle is the failure
mode, and it is a failure of *saying*, not of rendering.

## What exists, measured today

| Fact | Evidence |
| --- | --- |
| `github.com` refuses framing | `x-frame-options: deny` **and** `frame-ancestors 'none'` on the repo page — measured 10 Sep |
| A repository file is readable as data | `raw.githubusercontent.com/…/ROADMAP.md` answers `access-control-allow-origin: *`, `content-type: text/plain`, with an `ETag` |
| The API names the blob and its age | `api.github.com/repos/{owner}/{repo}/contents/{path}` answers CORS-open JSON with the blob `sha` and `last-modified`; 60 requests/hour unauthenticated |
| Refusal is already diagnosed | `packages/core/src/frameable.ts` reads the headers and returns a verdict with the site's own words; `/api/frameable` is the daemon probe |
| Deriving is already a shape | `isocan gdoc add` fetches a Google Doc's markdown *only for an address core recognises as a doc, never as a general proxy*, and lands it as a document with `source` and `synced` |
| Watching a repository is already a shape | the repo-admin canvas (#148) watches commits; its read half is built |
| The rule that keeps a view honest | every panel is *derived and regenerated*, or *decided here and nowhere else* — nothing in between (`2026-08-30-repo-admin-canvas.md`) |

## The three doors

A canvas has exactly three ways to show something it does not own, and they are
a ladder, tried in order and named on the item.

**Door 1 — frame it.** A live projection, because the site allows it. This is
today's *Add site*, and it stays the first try: a frame is not a copy, so it
cannot be stale or wrong about the site it shows. When the site refuses, the
verdict is the site's own words — `frameable.ts` already returns them, and the
canvas must print them instead of a blank rectangle.

**Door 2 — derive it.** When the content can be read as data, read it and
render it as items. This is the door for the roadmap, and for the whole class
the roadmap belongs to: a repository file, a Google Doc, a feed, a JSON
endpoint. It is strictly more work than a frame and it buys things a frame
cannot have — the items join the canvas's own model (properties, pins, layout,
comment anchoring, agent reach), and they survive the site changing its mind
about framing.

The registry is **closed**: core recognises an address as a known source and
parses it into (host, owner, repo, ref, path), exactly as `googleDocId` does.
This is the doctrine that keeps *derive* from becoming a general proxy, which
is a different product with different problems.

For a public repository file the *browser* can do the fetch — `raw` is
CORS-open — so no daemon is needed and nothing in the app changes shape. For a
private repository the daemon fetches with a token, as the gdoc route does on
this machine.

**Door 3 — photograph it.** Nothing frameable, nothing readable: take a
picture, and carry its age. Inception already draws cards one level deep and
`isocan canvas shot --into` already exists as "the picture that survives a
refused pull"; the nightly shot keeper (wq6.8) is the same idea on a clock. A
photograph is the honest last door precisely because it announces that it is
one.

**The rule over all three:** the item says which door it took, and when a door
was refused, whose words refused it. The original bug was silence.

## Why the roadmap is door 2 and not a special case

The roadmap file is text, and its *structure is already data*: sections are
states, rows are documents, and every row already carries its title, `since`,
`note`, `see` and `issue` — all of it derived from front matter by
`scripts/roadmap.mjs`. So the canvas is a projection of a projection: parse the
file into its parts and lay each part down as an item.

- a summary card for `**21 built · 43 still open**` and the paragraphs under it;
- one section per `##` heading, in the file's order;
- one card per row: title, the `since` date, the note, the `see` references,
  and the issue link where the row names one;
- the source line: repository, path, commit, read time.

Nothing here needs a new operation, a new kind, or a schema change: cards are
cards, sections are the layout, and the file is the record.

**Which commit was read** is part of the content, not decoration. The contents
API returns the blob `sha`; the read is pinned to it, and the footer names it.
A reading that cannot name its commit is a reading nobody can check.

**Syncing** is polling done well: the `ETag`/`sha` makes "has it changed?" one
cheap conditional request, and a change re-reads the file. The repo-admin
canvas already watches a repository's commits; this reuses that shape, at the
cadence the canvas is on screen rather than a daemon clock that never stops.

**It cannot be edited.** Cards are read-only, and the gesture that would edit
one points at the document instead. This is the same rule the generated file
already carries ("Do not edit — edit the front matter of the document itself"),
said in the medium that makes editing most tempting.

## Where it sits

**A project home surface.** The wq6 epic names `project-home-surface` as a
concern; a repository's roadmap is the most honest thing a project's home can
carry, because it is the one page that cannot flatter the project — it is
derived from the documents themselves.

**A second source, not a special case.** Phase 5 is a different source through
the same registry, so the mechanism is proven to be a mechanism. The Google Doc
route is the obvious candidate: it exists, it is the same door, and expressing
it through one registry is how two shapes become one.

**Out of scope, said so nobody rediscovers it as a bug.** A general web proxy
(no); rendering a page's *pixels* without framing it (no — that is a
photograph, door 3, and it should be called one); write-back to a repository
(the canvas does not decide; the repository is where decisions are kept);
private-repository UX beyond a stored token (phase 1 reads public repositories
only).
