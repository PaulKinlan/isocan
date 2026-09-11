# The browser surface: implementation phases

[`design.md`](design.md) argues the physical mechanisms, the authority
boundaries, and the protocol separation; [`journey.md`](journey.md) is the
acceptance suite — each phase below names the journey scenes it closes, and a
phase closes only when the scene can be walked for real against an actual
Chrome instance and a live isocan daemon.

**How the work runs:** Follows the conductor model established in
[`../multiuser/phases.md`](../multiuser/phases.md). Each phase delivers a
discrete, testable milestone, verified against genuine Chrome MV3 constraints
and CAP tool capabilities.

---

**Where we are: DESIGN COMPLETE (Track C roadmap, 11 Sep 2026).** The
architectural design, user journeys, seam census, and authority model are
specified. Staged implementation phases are defined below.

---

## Phase 1 — The extension shell & tab projection

**Closes:** `journey.md` Scene 1 (The spatial tab strip).

**Deliverables:**
1. **Extension Package Structure**:
   - Manifest V3 extension configuration declared in `packages/extension/` (or
     as an adapter wrapping CAP).
   - Side panel (`chrome.sidePanel`), toolbar popup, and full canvas tab
     (`chrome-extension://.../canvas.html`).
2. **Tab Census & Projection Engine**:
   - Reads active Chrome tabs (`chrome.tabs.query`).
   - Projects tabs onto the canvas as `item.add` operations wearing
     `text/uri-list` MIME (`packages/core/src/browseritem.ts`).
   - Title and favicon metadata mapped to item properties.
3. **Interactive Focus Link**:
   - Clicking a browser card on the canvas emits an ephemeral presence event.
   - The extension brings the corresponding `tabId` to active focus via
     `chrome.tabs.update(tabId, { active: true })`.

**Verification & Acceptance:**
- Open ten diverse tabs in Chrome. Click "Project to isocan".
- Ten cards appear on the canvas in a neat spatial grid with titles and URLs.
- Clicking any card on the canvas immediately switches Chrome's active window
  to that tab.

---

## Phase 2 — Bidirectional isomorphism & ⌘Z undo

**Closes:** `journey.md` Scene 2 (The isomorphic loop) and Scene 7 (⌘Z on the real world).

**Deliverables:**
1. **Chrome $\rightarrow$ Canvas Event Bridge**:
   - `chrome.tabs.onCreated` $\rightarrow$ emits `item.add`.
   - `chrome.tabs.onUpdated` (URL change) $\rightarrow$ emits `item.addVersion`
     (preserving previous URLs in the version stack).
   - `chrome.tabs.onUpdated` (title/favicon) $\rightarrow$ emits `item.update`.
   - `chrome.tabs.onRemoved` $\rightarrow$ emits `item.delete` (moves card to trash).
2. **Canvas $\rightarrow$ Chrome Mutation Handler**:
   - User edits card URL $\rightarrow$ extension invokes `chrome.tabs.update(tabId, { url })`.
   - User deletes card on canvas $\rightarrow$ extension invokes `chrome.tabs.remove(tabId)`.
3. **⌘Z Undo Bridge**:
   - User hits `⌘Z` on canvas after closing a tab $\rightarrow$ canvas reducer
     applies `item.restore`.
   - Extension detects restoration of a `text/uri-list` item and re-opens the
     tab in Chrome (`chrome.tabs.create({ url, active: false })`).

**Verification & Acceptance:**
- Automated test driving Chrome via CDP:
  1. Navigate a tab in Chrome; assert canvas card appends new version.
  2. Edit card URL on canvas; assert Chrome tab navigates to the new URL.
  3. Close tab in Chrome; assert card moves to canvas trash.
  4. Hit `⌘Z` on canvas; assert card restores and Chrome tab re-opens.

---

## Phase 3 — Tab groups & nested canvases

**Closes:** `journey.md` Scene 3 (The nested research canvas).

**Deliverables:**
1. **Chrome Tab Group Mapping**:
   - `chrome.tabGroups.onCreated` / `onUpdated` mapped to canvas `area` items
     (`packages/core/src/area.ts`) enclosing member tab cards.
   - Group titles and colors synchronized with canvas area titles and colors.
2. **Nested Canvas Collapse**:
   - Multi-select gesture on canvas (`items.move` / `group --into-canvas`)
     collapses tab cards into a nested canvas item (`kind: "canvas"`).
   - Chrome tab group updates its label and visual style to reflect nested
     canvas status.
3. **Sub-Canvas Navigation**:
   - Zooming into the nested canvas presents member tabs, research notes, and
     attached discussion threads.

**Verification & Acceptance:**
- Group five tabs in Chrome; assert canvas draws a titled area enclosing them.
- Collapse area into a nested canvas; verify state replicates across two
  connected isocan clients over WebSocket `/api/ws`.

---

## Phase 4 — The ACP browser-control loopback

**Closes:** `journey.md` Scene 4 (Summoning the browser agent over ACP).

**Deliverables:**
1. **Extension ACP Server (`isocan-browser-acp`)**:
   - Extension runs an internal ACP 1 server endpoint over local loopback
     WebSocket (or Native Messaging host).
   - Implements ACP methods: `session/new`, `session/prompt`, `session/update`,
     `session/load`, matching `packages/cli/src/acp.ts`.
2. **CAP Tool Dispatch Bridge**:
   - Translates incoming ACP tool calls to CAP's internal browser tools
     (`extension/lib/browser-tools.js`): DOM accessibility tree, element click,
     text input, scroll, and screenshot capture.
3. **Standing Agent Enrollment**:
   - Enrolls `@browser` as a standing agent on the canvas (`agent.enroll`).
   - Answering comments in card threads (`reasonFor`) triggers `isocan rc` to
     initiate an ACP turn against the bound browser tab.
4. **Data Extraction to Canvas**:
   - Browser agent extracts structured page data (tables, lists, text) and
     emits `item.add` operations to place extracted cards beside the source tab.

**Verification & Acceptance:**
- Summon `@browser` in a thread on a mock pricing page card.
- Agent executes an ACP turn, inspects the live page via CAP tools, and emits
  a new table card with parsed pricing tiers.
- Verify zero raw credentials or external shell commands were required.

---

## 5. Phase 5 — Trusted multiplayer browser sharing

**Closes:** `journey.md` Scene 5 (Trusted multiplayer co-browsing).

**Deliverables:**
1. **Strict Profile Custody**:
   - Cookies, session headers, and saved credentials remain strictly inside
     the owner's local Chrome profile; never sent across the network.
2. **Explicit Scoped Sharing UI**:
   - Extension modal allowing the owner to select:
     - Target tab.
     - Allowed origin patterns (e.g. `https://staging.example.com/*`).
     - Guest roles: Viewer (read-only) vs Co-Driver (input reflection).
3. **Frame Streaming & Input Reflection**:
   - Owner extension captures tab frames (`chrome.tabCapture` / `captureVisibleTab`)
     and streams visual updates to connected canvas guests via WebRTC.
   - Remote guest clicks and scrolls are sent over the isocan presence hub,
     stamped with guest `actorId` and rendered with guest's actor color/mark.
   - Owner extension dispatches synthetic input events to the target DOM.
4. **Sensitive Field Shield**:
   - Content script masks `type=password` and payment input fields on captured
     frames.
   - Remote input events targeting sensitive elements are rejected.
5. **Real-Time Revocation & Audit**:
   - One-click access revocation immediately terminates the sharing session.
   - All guest interactions logged in the oplog with full undoability.

**Verification & Acceptance:**
- Host and remote guest connect to a shared canvas.
- Host shares an authenticated staging web app card with guest as Co-Driver.
- Guest navigates within the staging site and clicks a button; action executes
  on host browser.
- Network inspection confirms guest machine never received host session cookies.
- Host clicks "Revoke"; guest immediately loses interactive control.

---

## Phase 6 — Spatial voice & screen collaboration

**Closes:** `journey.md` Scene 6 (Spatial voice and screen cast).

**Deliverables:**
1. **Ephemeral WebRTC Audio Mesh**:
   - Collaborators join audio on the canvas via explicit `getUserMedia` prompt.
   - Audio tracks exchanged directly over WebRTC; visual speaking rings appear
     around actor avatars on the canvas.
2. **Card-Bound Screen / Tab Cast**:
   - Collaborators can share tab audio/video via `getDisplayMedia`.
   - Video track binds directly as an active visual face on the browser card.
3. **Zero Oplog Footprint**:
   - Media tracks and live audio/video data exist exclusively in the ephemeral
     plane; zero audio/video bytes written to oplog or persistent storage.

**Verification & Acceptance:**
- Two collaborators join a canvas audio room.
- Verify bidirectional audio with hardware mute indicators.
- Host streams tab video to a canvas card; guest views stream in real time.
- Verify oplog size does not increase during media streaming.
