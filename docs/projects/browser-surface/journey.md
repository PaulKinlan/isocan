---
status: design
since: 2026-09-11
see: multiuser, on-demand, iso-api
note: "Track C: Isocan as a Chrome Extension, ACP browser-control loopback, and trusted multiplayer browser sharing. Bidirectional isomorphism between browser actions and canvas operations, grounded in real Chrome MV3 constraints and chrome-agent-platform capabilities."
---

# The browser surface: the journeys

**11 September 2026.** The ideal, written as scenes: what it feels like to
treat the browser not as an outside frame that visits an isocan canvas, but
as a native isomorphic surface of the canvas itself.

[design.md](design.md) argues the physical mechanisms, the authority model,
and the protocol boundaries. [phases.md](phases.md) defines the staged
walk to build it. Each scene below is an acceptance test — a phase closes
only when the scene can be walked for real against an actual Chrome instance
and a real isocan canvas.

---

## 1. The spatial tab strip — hired to escape the linear clamp

**When** Sarah has thirty tabs open across three GitHub issues, two Figma
specs, four staging deployments, and documentation, **she hires the isocan
extension to** project her browser window into a two-dimensional canvas,
**so that** her workspace reflects how she actually thinks instead of a 1D
strip of clipped favicons.

She clicks the isocan icon in Chrome's toolbar. A new canvas opens (or she
picks an existing project canvas). The extension does not dump thirty raw
bookmarks; it emits thirty `item.add` operations. Each card is an item
wearing `text/uri-list` MIME (`packages/core/src/browseritem.ts`), with its
current title and a live visual snapshot.

Sarah drags related tabs together into an area she titles "Staging Review".
The browser window still has thirty tabs, but the canvas has clustered them
spatially. When she clicks a card on the canvas, Chrome brings that tab to the
front. When she middle-clicks a card to delete it on the canvas, the tab
closes in Chrome.

**What Sarah notices:**
- The canvas is not a static screenshot board; it is her tab strip, laid out
  in space.
- Closing a tab on the canvas emits an ordinary `item.delete`. Hitting `⌘Z`
  on the canvas restores the item and re-opens the closed tab in Chrome at its
  exact history position.

---

## 2. The isomorphic loop — hired to keep two surfaces honest

**When** Marcus is browsing documentation on his laptop while his canvas is
open on an external monitor, **he hires bidirectional isomorphism to** keep
both views identical without manual bookmarking or copy-pasting URLs.

Marcus clicks a link in Chrome, navigating from `/docs/v1` to `/docs/v2`.
The Chrome extension detects the navigation and emits an `item.addVersion`
mutation targeting the card representing that tab. On the canvas, the card
transitions smoothly to the new title and URL, preserving the version stack:
anyone inspecting the card can see that Marcus navigated from v1 to v2 three
minutes ago.

Next, Marcus turns to the canvas. He types a new URL into the card's address
input. The canvas emits an `item.addVersion` with the new URL. The extension's
service worker receives the op and navigates the bound Chrome tab immediately.

**What Marcus notices:**
- Neither surface is "master"; the daemon's oplog is the sole source of truth.
- Both the browser tab and the canvas card speak the exact same `Operation`
  vocabulary (`item.add`, `item.addVersion`, `item.delete`).

---

## 3. The nested research canvas — hired to contain rabbit holes

**When** Elena is investigating a complex customer bug and opens fifteen tabs
investigating auth tokens, **she hires nested canvases to** bundle the
investigation into a single contained card before it pollutes the team board.

On her main project canvas, Elena selects the fifteen browser cards. She
presses `⌘G` (or runs `isocan group --into-canvas`). The items collapse into
a single card wearing `kind: "canvas"`. Inside that nested canvas, the tabs
remain live.

Elena switches between working on the top-level architecture and diving into
the nested auth investigation. Her team members looking at the main canvas see
one card: "Elena: Auth Bug Investigation (15 tabs, 2 comments)". Zooming in
reveals the live sub-canvases and tab states.

**What Elena notices:**
- Tab groups in Chrome map naturally to nested canvases on isocan.
- The state of the nested canvas replicates across machines like any other
  isocan canvas; team members can inspect the investigation without opening
  fifteen tabs on their own machines.

---

## 4. Summoning the browser agent over ACP — hired to delegate live page work

**When** David is reviewing a messy tabular pricing page with twenty tiers,
**he hires the browser agent to** extract the pricing data into an isocan
table item without writing scraping scripts by hand.

David opens the card thread on the canvas and types:
`@browser extract all tier prices and limits into a table`.

The `isocan rc` daemon receives the comment, recognizes `@browser` as an
enrolled standing agent (`agent.enroll`), and connects over Agent Control
Protocol (ACP, `packages/cli/src/acp.ts`) to the extension's local loopback
adapter.

The browser agent takes a turn:
1. It requests the DOM structure and screenshot of the tab from the extension
   via CAP's accessibility tree tools (`extension/lib/browser-tools.js`).
2. It parses the pricing tiers.
3. It calls `@isocan/core` operations to emit an `item.add` of a new table card
   right beside the browser item on the canvas.
4. It replies in the thread: "Extracted 20 tiers into #item-pricing-table."

**What David notices:**
- David did not have to grant raw API keys or command-line permissions to the
  agent; the browser agent used its scoped ACP connection to inspect only the
  explicitly targeted tab.
- The extracted table item is immediately editable by David and his team.

---

## 5. Trusted multiplayer co-browsing — hired to share without leaking

**When** Maya is debugging a staging checkout flow with Tom across the globe,
**she hires trusted browser sharing to** walk through the flow together
without sharing her personal browser session, cookies, or master passwords.

Maya clicks "Share Browser Card" on the canvas. An explicit permission dialog
opens in the extension:
- **Target tab:** `https://staging.internal.example.com/checkout`
- **Guest role:** Co-Driver (can click and scroll; form typing requires approval)
- **Cookie sharing:** Strictly isolated (Tom's browser gets live visual frames
  and remote input events; Maya's cookies NEVER leave her machine)
- **Forbidden actions:** Navigation to non-staging domains is blocked.

Tom joins the canvas. He sees the live browser card on the canvas with Maya's
avatar badge on it. As Maya scrolls, Tom sees the viewport move in real time
over the isocan presence hub.

Tom moves his pointer over the card. His custom presence cursor (wearing his
chosen actor color and mark, `actor.setColor`, `actor.setMark`) appears on
Maya's screen inside the staging page. Tom clicks "Next Step". Maya's extension
dispatches the click event at Tom's coordinates, logs the action in the audit
stream, and updates the canvas.

When Tom accidentally clicks a link pointing to `accounts.google.com`, Maya's
extension policy blocks the cross-domain navigation, flashes a warning on the
card, and keeps the tab on the staging site.

**What Maya and Tom notice:**
- Tom can co-drive the staging site, but he never possesses Maya's session
  cookies or auth headers.
- Maya can revoke Tom's co-driver grant with a single click, immediately
  dropping him to read-only viewer mode.

---

## 6. Spatial voice and screen cast — hired to talk over the work

**When** Liam and Priya are doing an architectural review of a live web
application, **she hires spatial media streams to** discuss the page
directly on the canvas without juggling an external meeting app.

Priya clicks "Join Audio" on the canvas. Her browser requests mic access
(`navigator.mediaDevices.getUserMedia`) under an explicit, visible browser
prompt. The canvas shows a green speaking halo around Priya's actor badge.

Liam joins audio. They talk as they move cards around. Priya selects the
browser card and clicks "Stream Tab Audio/Video". Chrome prompts for tab capture
(`chrome.tabCapture` / `getDisplayMedia`). The live WebRTC stream binds as an
active media face on the canvas card.

When Priya speaks while hovering over the staging card, her audio is heard
clearly. Both participants can mute their own microphones at any time with a
dedicated hardware/UI indicator. No audio or video stream is ever recorded to
the permanent oplog; media streams live exclusively in the ephemeral presence
and WebRTC transport plane.

**What Liam and Priya notice:**
- Voice and video are per-person, explicit grants; there is zero ambient
  listening when leaving the canvas tab.
- The media stream attaches to the spatial card, so conversation is naturally
  anchored to the artifact being discussed.

---

## 7. ⌘Z on the real world — hired to reverse mistakes safely

**When** an automated agent or a remote co-driver clicks a destructive button
on a live staging dashboard, **the workspace owner hires oplog undo to**
revert the action cleanly.

During a shared session, an agent clicks "Archive Project" on the staging
dashboard. The action was logged as an isomorphic operation in the isocan
ledger with `actor: "agent:qa-bot"` and `group: "action_123"`.

The owner notices the mistake and immediately hits `⌘Z` on the canvas.
Because the action was logged as an isomorphic op with a defined inverse:
1. The canvas rolls back the item state.
2. The extension's ACP controller receives the undo notification and dispatches
   a compensatory browser action (or prompts for confirmation if irreversible).
3. The page returns to the un-archived view.

**What the owner notices:**
- Every collaborative and automated action leaves a durable audit trail.
- Undo is not a local text-editor trick; it is an integrated platform safety
  valve that bridges the canvas and the browser.

---

## What the scenes force

Walking these seven scenes reveals the irreducible mechanisms that must exist
in [design.md](design.md):

1. **The Extension as Both Surface and Agent:**
   - As a *surface*, it renders canvas items and tab strips in side panels, popups,
     and full-window canvas tabs.
   - As an *agent*, it executes browser tasks and answers queries via ACP.
   - Both must speak the exact same `Operation` vocabulary.

2. **Bidirectional Isomorphism without Master-Slave Coupling:**
   - Chrome tab mutations must map to `@isocan/core` operations (`item.add`,
     `item.addVersion`, `item.delete`).
   - Canvas mutations must be capable of driving Chrome tabs (`tabs.update`,
     `tabs.remove`, `debugger.sendCommand`).

3. **Separation of the Three Planes:**
   - **State Plane (Oplog)**: Durable operations, items, versions, comments,
     and agent standing, synchronized over WebSocket `/api/ws`.
   - **Control Plane (ACP)**: Agent-to-browser control loopback, tools, prompts,
     and turn management via Agent Control Protocol (`packages/cli/src/acp.ts`).
   - **Ephemeral Plane (Presence & WebRTC)**: Cursors, live viewport scrolls,
     mic audio, and screen video tracks, expiring on TTL and never persisted
     to disk.

4. **Zero-Trust Credential & Cookie Boundary:**
   - The browser profile owns cookies and auth state. Remote guests and AI
     agents NEVER receive raw cookie stores or session tokens.
   - Multiplayer co-browsing operates via input-event reflection and frame
     streaming, never by credential replication.

5. **Strict Scope & Revocation:**
   - Sharing is per-tab and per-canvas, with explicit domain allowlists.
   - Any grant (co-driver, agent control, screen cast) is revocable in real time.
