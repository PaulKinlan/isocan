---
status: designed
since: 2026-09-11
see: iso-api, on-demand, embed
note: "roadmap defined — the browser surface extends browseritem.ts (text/uri-list) and ACP into a bidirectional spatial tab strip and browser agent, grounded in CAP capabilities and profile cookie custody"
---

# The browser surface: the journeys

**11 September 2026.** Roadmap (#isocan-chf). Registered thin on purpose: the
bounded existence census (2026-09-11) found the browser projection item format
and the ACP client already built, so this registration links rather than
restates, and the deep design is staged as a companion follow-on.

The thesis in one line: **the browser is not an outside window looking at an
isocan canvas — it is an isomorphic surface and an enrolled agent speaking the
same operation vocabulary.**

---

## What exists (the census)

- **`packages/core/src/browseritem.ts`** — the mini-browser item (#40): an
  ordinary `item.add` whose version blob is `text/uri-list` holding the
  projected URL, with `normalizeSiteUrl`, `siteLabel`, and `siteFilename`.
  Undo is `item.delete`; changing the URL is `item.addVersion`. No new op type.
- **`packages/core/src/canvasitem.ts`** — nested canvases on a canvas: already
  implemented via `properties.kind === "canvas"` and `canvasitemOf`, partly built
  in the [inception](../inception/) project.
- **`packages/cli/src/acp.ts`** — the ACP 1 client in `isocan rc`
  ([on-demand](../on-demand/)): speaks Agent Control Protocol over stdio with
  `session/new`, `session/prompt`, `session/update`, `session/load`, and
  resumable sessions. Note: the browser-side ACP server adapter is **PROPOSED**
  and unimplemented; only the client exists today.
- **`packages/server/src/badges.ts:117–154`** — partitioned cookies
  (`SameSite=None; Secure; Partitioned`) for iframe embedding
  ([embed](../embed/phases.md)) and actor badge claims.
- **Chrome Agent Platform (CAP)** — 188 browser tools declared in
  `extension/lib/chrome-tool-capabilities.js`, WebMCP dual content scripts,
  and script sandbox with digest-verified import maps.

---

## What this project adds

1. **Spatial 2D Tab Strip**: A Chrome Manifest V3 extension (side panel,
   popup, or canvas tab) projecting browser windows onto the canvas as spatial
   `text/uri-list` cards.
2. **Bidirectional Isomorphism**:
   - Chrome tab actions $\rightarrow$ canvas operations (`item.add`,
     `item.addVersion`, `item.delete`).
   - Canvas card interactions $\rightarrow$ Chrome tab actions (`tabs.update`,
     `tabs.remove`, `tabs.create`).
3. **Browser-as-Agent over ACP (PROPOSED)**: The extension proposes an internal
   ACP 1 adapter so `isocan rc` can vend browser control sessions to standing
   agents (`@browser`) without ad-hoc RPC channels. The census confirms the ACP
   client in `packages/cli/src/acp.ts` is built, but the browser-side ACP adapter
   is **PROPOSED** and does not yet exist.
4. **Trusted Multiplayer Co-Browsing & Authority Model**: Distinguishes between
   isocan's built CHIPS partitioned cookie custody for embedded iframes
   (`packages/server/src/badges.ts:117–154`, `SameSite=None; Secure; Partitioned`)
   and **owner-profile browser authority** (the owner's Chrome profile holds
   third-party session cookies and credentials, which NEVER leave the owner's
   machine). Remote guests co-drive via WebRTC frame projection and synthetic
   event reflection without credential replication.

---

## What is owed (bounded design questions & goals)

1. **Echo Suppression**: Explicit provenance tracking (`clientId`, origin
   filtering) to prevent infinite loops between Chrome navigation events and
   canvas version additions.
2. **Reversibility Truth**: Clarifying that `tabs.create` restores closed tabs
   to their URL, but Chrome cannot restore closed tab back/forward history;
   oplog undo cannot reverse third-party web server mutations.
3. **Model Alignment & Inception Reuse**: Preserving `@isocan/core` data
   models strictly: browser items use `text/uri-list` source and optional
   screenshot blob `VisualFace: { blobHash, mimeType: "image/png" }`. Nested
   canvases must extend existing `packages/core/src/canvasitem.ts`
   (`properties.kind === "canvas"`) and the partly built [inception](../inception/)
   project, rather than inventing an ad-hoc item kind.
4. **ACP Adapter Boundary**: Designing the extension's ACP server transport
   (spawned native messaging host or loopback) and cleanly separating agent
   turn narration from browser tool dispatch.
5. **Credential & Visual Exposure Limits**: Acknowledging that visual frame
   streaming renders visible text and DOM pixels on screen; masking password
   and payment fields mitigates form credential exposure, but visual streaming
   inherently reveals visible page content, URL tokens, and dashboard data.
   Frame sharing is therefore proposed only for explicitly authorized peers,
   with the owner's HTTP session cookies and credentials remaining unexported.
6. **Detailed Mechanism & Staging**: Deep design and implementation walk
   maintained in companion documents [design.md](design.md) and
   [phases.md](phases.md).

---

## Sources & Companion Documents

- Core item contract: `packages/core/src/browseritem.ts`.
- Agent control protocol: `packages/cli/src/acp.ts` and `docs/projects/on-demand/design.md`.
- Badge and embedding precedent: `packages/server/src/badges.ts` and `docs/projects/embed/phases.md`.
- Deep technical design: [design.md](design.md).
- Staged implementation phases: [phases.md](phases.md).
