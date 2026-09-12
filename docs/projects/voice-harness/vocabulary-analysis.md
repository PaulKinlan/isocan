# Voice Harness: Full Operation & Agent Vocabulary Analysis

**Date:** 12 September 2026  
**Status:** Pre-Implementation Specification & Design Artefact  
**Author:** `merger` (Gemini 3.8 Flash)  
**Mandate (Paul Kinlan):** *"Do a full analysis of all the commands and operations we need, they all need to be tools we call. It should be able to replicate any other agent."*  

---

## 1. Executive Summary & Principles

The voice harness is **not a remote control with a hardcoded shortlist of six verbs**; it is a **first-class isomorphic client of the canvas**, with the same capability, awareness, and authority as any other agent (`isocan`, `claude-code`, `pi`, `codex`).

To make this complete and drift-proof, this analysis establishes the **strict union** of:
1. **The Engine's Operation Vocabulary (`@isocan/core`)**: Every single operation defined in the engine (`ops.ts`, `reducer.ts`) — **33 operations, 33 rows**.
2. **The Agent Surface (`isocan --agent-help`)**: Collaborative actions, workspace reads, presence states, drawing, viewport, and selection gestures.

---

## 2. Core Operation Vocabulary Mapping (33 Operations, 33 Rows)

The table below enumerates every operation defined in `packages/core/src/ops.ts` and applied by `packages/core/src/reducer.ts`. Every engine mutation is represented:

| # | Core Operation | Tool Name | Parameters & Arguments | Execution Type | Destructive? | Description & Semantics |
|---|---|---|---|---|---|---|
| 1 | **`actor.claim`** | `actor_claim` | `name: string, session_key?: string` | **Fast** | No | Claim or switch identity under a session key on this canvas. |
| 2 | **`actor.setColor`** | `actor_set_color` | `color: string` | **Fast** | No | Set the voice agent's visual presence color on the canvas (hex or color token). |
| 3 | **`actor.setMark`** | `actor_set_mark` | `mark: string` | **Fast** | No | Set the voice agent's avatar mark / emoji badge on the canvas. |
| 4 | **`actor.join`** | `actor_join` | `other_actor_id: string` | **Fast** | No | Fold another actor identity owned by this machine into the active actor. |
| 5 | **`project.create`** | `project_create` | `title: string, canvas_id?: string` | **Fast** | No | Create a new canvas / project workspace. |
| 6 | **`project.update`** | `project_update` | `title?: string, description?: string` | **Fast** | No | Update the canvas title or description metadata. |
| 7 | **`project.delete`** | `project_delete` | `(none)` | **Fast** | YES (Gated) | Soft-delete the canvas. Refused without explicit human UI confirmation. |
| 8 | **`item.add`** | `item_add` | `title: string, content?: string, mime?: string, x?: number, y?: number, width?: number, height?: number` | **Fast** | No | Add a note, document, card, or sketch to the canvas. |
| 9 | **`item.react`** | `item_react` | `item_ref: string, emoji: string, on?: boolean, at_x?: number, at_y?: number` | **Fast** | No | Add or remove an emoji reaction mark, or place a heat-map vote dot on an item. |
| 10 | **`item.move`** | `item_move` | `item_ref: string, to_x?: number, to_y?: number, by_x?: number, by_y?: number` | **Fast** | No | Move an item to coordinates or by relative delta. |
| 11 | **`item.resize`** | `item_resize` | `item_ref: string, width: number, height: number` | **Fast** | No | Resize an item to specified width and height in pixels. |
| 12 | **`item.update`** | `item_update` | `item_ref: string, title?: string, description?: string, properties?: Record<string, string>` | **Fast** | No | Rename an item or update its description/properties. |
| 13 | **`item.addVersion`** | `item_add_version` | `item_ref: string, content: string, filename?: string, mime?: string` | **Fast** | No | Push a new version of text, markdown, or code onto an item's version stack. |
| 14 | **`item.setCurrentVersion`** | `item_set_current_version` | `item_ref: string, version_id: string` | **Fast** | No | Convergence operation: switch which historical version is active and visible. |
| 15 | **`item.removeVersion`** | `item_remove_version` | `item_ref: string, version_id: string` | **Fast** | No | Remove a version from stack (internal inverse of addVersion; exposed for exact undo). |
| 16 | **`item.restoreVersion`** | `item_restore_version` | `item_ref: string, version_id: string` | **Fast** | No | Restore a removed version to stack (internal inverse of removeVersion). |
| 17 | **`item.delete`** | `item_delete` | `item_ref: string` | **Fast** | No (Soft) | Move an item to the canvas trash. Version history preserved; undoable. |
| 18 | **`item.restore`** | `item_restore` | `item_ref: string` | **Fast** | No | Restore a deleted item from the trash back to the canvas plane. |
| 19 | **`items.move`** | `items_move` | `item_refs: string[], by_x: number, by_y: number` | **Fast** | No | Multi-select move: shift an array of items simultaneously by spatial delta. |
| 20 | **`items.delete`** | `items_delete` | `item_refs: string[]` | **Fast** | No (Soft) | Move multiple items to trash simultaneously. |
| 21 | **`items.restore`** | `items_restore` | `item_refs: string[]` | **Fast** | No | Restore multiple items from trash simultaneously. |
| 22 | **`trash.empty`** | `trash_empty` | `(none)` | **Fast** | YES (Gated) | Permanently purge all trashed items. Refused without explicit human UI confirmation. |
| 23 | **`thread.create`** | `thread_create` | `body: string, item_ref?: string, x?: number, y?: number` | **Fast** | No | Start a new discussion thread pinned to an item or canvas coordinates. |
| 24 | **`thread.reply`** | `thread_reply` | `text: string, thread_id?: string` | **Fast** | No | Post a reply in a thread or the canvas Chat. Audible to all collaborators and agents. |
| 25 | **`thread.setAnchor`** | `thread_set_anchor` | `thread_id: string, x: number, y: number, item_ref?: string` | **Fast** | No | Move a thread's pin position on the canvas or anchor it to an item. |
| 26 | **`thread.setMain`** | `thread_set_main` | `thread_id: string` | **Fast** | No | Designate a thread as the primary Chat thread for this canvas. |
| 27 | **`thread.delete`** | `thread_delete` | `thread_id: string` | **Fast** | No (Soft) | Delete a conversation thread. |
| 28 | **`comment.update`** | `comment_update` | `comment_id: string, body: string` | **Fast** | No | Edit a previously posted comment body. |
| 29 | **`comment.remove`** | `comment_remove` | `comment_id: string` | **Fast** | No (Soft) | Soft-remove a comment from a thread. |
| 30 | **`comment.restore`** | `comment_restore` | `comment_id: string` | **Fast** | No | Restore a removed comment (internal inverse of comment.remove). |
| 31 | **`thread.restore`** | `thread_restore` | `thread_id: string` | **Fast** | No | Restore a deleted thread (internal inverse of thread.delete). |
| 32 | **`agent.enroll`** | `agent_enroll` | `actor_id: string, name: string, rules?: object` | **Fast** | No | Enrol an agent on this canvas with permissions and rules. |
| 33 | **`agent.withdraw`** | `agent_withdraw` | `actor_id: string` | **Fast** | No | Withdraw and dismiss an enrolled agent from the canvas. |

*(Count: exactly 33 core operations, 33 rows. No operation omitted.)*

---

## 3. UI Gestures, Viewport, Selection & Workspace Reads (Agent Surface)

Beyond the 33 core operations, `isocan --agent-help` and the web UI provide drawing, viewport control, selection, and inspection tools essential for the voice agent to understand workspace state and guide the collaborator's screen:

| Tool Name | Parameters & Arguments | Execution Type | Description & Semantics |
|---|---|---|---|
| `drawing_add` | `points: Array<{x, y}>` (req), `title?: string`, `color?: string`, `width?: number` | **Fast** | **Pen / Drawing tool**: generates an SVG document (`DRAWING_MIME`) with `kind: "drawing"` from world-space `InkStroke` points via `drawing.ts` (lands via `item.add`). |
| `area_create` | `title: string` (req), `x: number`, `y: number`, `width: number`, `height: number` | **Fast** | Creates a named section sheet / area bounding box (lands via `area.new` / `item.add`). |
| `read_canvas` | (none) | **Fast** | Inspects all active items: id, title, kind, placement (x, y, w, h), and currentVersionId. |
| `read_item` | `item_ref: string` (req) | **Fast** | Reads full markdown/text content, metadata properties, and version list of an item. |
| `find_items` | `query: string` (req) | **Fast** | **Find items**: searches titles, ids, and content for matching items. |
| `read_threads` | `item_ref?: string` | **Fast** | Reads conversation threads, comments, and Chat history. |
| `read_presence`| (none) | **Fast** | Reports who is live in the room right now and which agents are enrolled. |
| `read_history` | `limit?: number` (default 20) | **Fast** | Reads the latest oplog operations and activity timestamps on this canvas. |
| `viewport_focus`| `item_ref: string` (req) | **Fast** | Centers and zooms the human's web canvas view onto a specific item. |
| `viewport_pan` | `x: number` (req), `y: number` (req), `zoom?: number` | **Fast** | Moves the human's camera to world coordinates and zoom level. |
| `selection_set` | `item_refs: string[]` (req) | **Fast** | Selects an array of items on the canvas. |
| `selection_clear`| (none) | **Fast** | Deselects all items on the canvas. |

---

## 4. Architectural Rules & Safety Discipline

1. **Derived Vocabulary Principle**:
   - The tool declarations are generated directly from the core operation definitions and types.
   - Operations that take raw IDs (e.g. `itemId: string`) accept human-friendly `item_ref: string` references, resolved against live canvas state via `resolveSpokenRef` (matching title, prefix, ID, or ordinals like "the second screen").
2. **Fast vs Slow Boundary**:
   - Every operation in the table above is **fast** (executed within the turn via the daemon).
   - If a collaborator asks for an unbounded generative task ("design five alternatives for the landing page"), the voice model speaks a brief acknowledgment and uses `thread_reply` (`say`) to post the task in the Chat for parked autonomous agents.
3. **Destructive Operation Gates**:
   - Tools marked **YES (Gated)** (`trash_empty`, `project_delete`) are confirmation-gated.
   - If called directly, the harness refuses execution with an explicit error:
     `"Destructive actions require explicit confirmation in the UI; voice agents cannot execute this unattended."`
   - A model-supplied `confirmed: true` parameter is rejected; the confirmation must come from an explicit human interaction.
4. **Project Instructions (`AGENTS.md`)**:
   - Loaded into Gemini Live `systemInstruction` via `resolveProjectInstructions()`, capped at 12,000 characters.
5. **Full Tool Logging (`/log`)**:
   - Every tool call (name, arguments, minted operation, daemon response/error, and source `live` vs `typed`) is recorded to `~/.isocan/voice/log.json` and broadcast live over WebSocket.

---

## 5. Acceptance Verification Plan

The acceptance test must exercise one operation from each distinct family:
1. **Content**: `item_add`
2. **Layout**: `item_move` / `items_move`
3. **Comment**: `comment_on_item` / `thread_reply`
4. **React**: `item_react` (adds emoji mark 👍)
5. **Draw**: `drawing_add` (freehand SVG ink via `drawing.ts`)
6. **Version**: `item_set_current_version` (switches active version)
7. **Destructive Guard**: `trash_empty` (verifies confirmation gate refusal)
8. **State Reads**: `read_canvas`, `read_item`, `find_items` (answering from live state)
