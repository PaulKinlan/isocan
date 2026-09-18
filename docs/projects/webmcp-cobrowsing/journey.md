---
status: designed
since: 2026-09-11
see: iso-api, embed
note: roadmap defined 11 Sep; the argument and the walk landed 18 Sep 2026 in design.md and phases.md, re-derived after an independent REVISE the same day — sixteen MCP tools over a real stdio handshake with the behaviourally-correct eleven/five split, 46 Operation variants (40 public), the browser API and its annotation projection measured on two Chromes, and no phase resting on the undemonstrated consequential hint. The fuller journey suite is still owed
---

# WebMCP co-browsing

**11 September 2026.** Roadmap (#isocan-hsr). Registered thin on purpose: the
bounded existence census (2026-09-11) found the vocabulary and the stdio
transport already built, so this registration links rather than restates, and
the deeper design is owed as a follow-on, not drafted twice.

The thesis in one line: **a browser agent and a human share the same live
canvas session with no bridge, because WebMCP tools run inside isocan's own
page — the page already IS the session.**

## What exists (the census)

- **`@isocan/mcp`** — the canvas as an MCP server over stdio
  ([embed phase 2](../embed/phases.md)): **sixteen tools** as of 13 Sep 2026 —
  ten reads and six writes, including a durable agent claim and attributed
  item/comment writes. The write half's addressability answer is the embed
  project's settled rule: the person by default, a deliberately claimed
  session when an agent means to stay and be addressed. A real stdio handshake
  on 18 Sep listed all sixteen (see [phases.md](phases.md), phase 0).
- **The Operation vocabulary** ([iso-api](../iso-api/)): one
  `Operation` type, one reducer, one route surface — the contract every
  surface imports.
- **The embed four-shape analysis**: page (A), MCP server (B), MCP Apps (C),
  native extension (D). This project is shape B's vocabulary moving into the
  page — shape A's session.

## What this project adds

The BROWSER-NATIVE transport of that vocabulary:
[`document.modelContext`](https://webmachinelearning.github.io/webmcp) —
verified experimental (origin trial from Chrome 149; local testing via
`chrome://flags/#enable-webmcp-testing`, which is the `WebMCP` feature), with
the current interface measured on two Chromes on 18 Sep 2026: `registerTool`,
`getTools`, `executeTool`, `toolchange`, and four annotation hints
(`readOnlyHint`, `untrustedContentHint`, `consequentialHint`, `debugging`).
Gated by origin isolation and the `tools` Permissions Policy, default `self`.
`navigator.modelContext`, cited when this page was registered, is
build-dependent rather than simply gone: it is still an **object** on the
measured Chrome for Testing 150 and **undefined** on stable 152, while
`provideContext()` is gone from the draft. `document.modelContext` is the
canonical spelling for new code. See [design.md](design.md) §3 for the current
shape and the measured behaviours a surface has to carry. Tools run inside
the isocan page, which already holds the human's live session; co-presence is
by construction, and the write half's addressability question gets a different
answer per transport: stdio speaks as the machine or a claimed agent; the page
speaks as an enrolled agent actor over the human's own session medium.

## What is owed (in order)

1. ~~The existence census findings become the design's ground …~~ **Done,
   18 Sep 2026** — the census was re-run and executed, not read: the sixteen
   tools' schemas, the write half's settled addressability answer, the
   annotation tiers, and the measured browser behaviour are [design.md](design.md)
   §1–§4 and [phases.md](phases.md) phase 0.
2. ~~design.md — the argument, from that ground.~~ **Done** — [design.md](design.md).
3. ~~phases.md — the walk, with browser acceptance per phase (origin-trial and
   flag detection; graceful degradation documented).~~ **Done** —
   [phases.md](phases.md): six phases, each with the browser walk that proves
   it and what would falsify it.
4. **Still owed:** a full journey suite — scenes deeper than the registration's.
   The line that said a draft was “preserved uncommitted in this worktree” was
   checked on 18 Sep 2026 in the three places it could be: base `a770255c`, the
   old branch tip `186dcd34`, and the original
   `isocan-hsr-webmcp-cobrowsing` worktree. **No draft was found in those
   locations** and the worktree is clean; the suite is written fresh, the day
   the design stops arguing with it.

## Sources

- Web-ML CG draft: webmachinelearning.github.io/webmcp (+ /docs/proposal.html).
- Chrome: developer.chrome.com/docs/ai/webmcp (origin trial 149, testing flag,
  Permissions Policy `tools`, discovery = visit the site directly).
- Distinct from MCP Apps (modelcontextprotocol.org/seps/1865).
