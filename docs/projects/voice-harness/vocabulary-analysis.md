# Voice Harness: Full Operation & Agent Vocabulary Analysis

**Date:** 12 September 2026  
**Status:** Pre-Implementation Specification & Design Artefact  
**Author:** `merger` (Gemini 3.8 Flash)  
**Mandate (Paul Kinlan):** *"Do a full analysis of all the commands and operations we need, they all need to be tools we call. It should be able to replicate any other agent."*  

---

## 1. Executive Summary & Principles

The voice harness is **not a remote control with a hardcoded shortlist of six verbs**; it is a **first-class isomorphic client of the canvas**, with the same capability, awareness, and authority as any other agent (`isocan`, `claude-code`, `pi`, `codex`).

To make this complete and drift-proof, this analysis establishes the **strict union** of:
1. **The Engine's Operation Vocabulary (`@isocan/core`)**: Every mutation supported by the core reducer (`ops.ts`, `reducer.ts`).
2. **The Agent Surface (`isocan --agent-help`)**: The full set of collaborative actions, reads, presence states, and canvas gestures.

---

## 2. Exhaustive Operation & Tool Mapping Table

| Operation / Domain | Tool Name | Parameters & Arguments | Execution Type | Destructive? | Description & Semantics |
|---|---|---|---|---|---|
| **`item.add`** | `item_add` | `title: string` (req), `content?: string`, `mime?: string`, `x?: number`, `y?: number`, `width?: number`, `height?: number` | **Fast** (in-turn) | No | Adds a new note, document, or card to the canvas. Defaults to markdown. |
| **`drawing` (Pen)** | `drawing_add` | `title?: string`, `color?: string`, `width?: number`, `points: Array<{x, y}>` (req) | **Fast** (in-turn) | No | Freehand pen ink. Creates an SVG document (`DRAWING_MIME`) with `kind: "drawing"`. |
| **`item.update`** | `item_update` | `item_ref: string` (req), `title?: string`, `description?: string`, `properties?: Record<string, string>` | **Fast** (in-turn) | No | Renames or edits metadata/properties of an existing item. |
| **`item.move`** | `item_move` | `item_ref: string` (req), `to_x?: number`, `to_y?: number`, `by_x?: number`, `by_y?: number` | **Fast** (in-turn) | No | Moves a single item to absolute coordinates or by relative delta. |
| **`items.move`** | `items_move` | `item_refs: string[]` (req), `by_x: number` (req), `by_y: number` (req) | **Fast** (in-turn) | No | **Multi-select move**: moves an entire group or selection of items by a spatial delta. |
| **`item.resize`** | `item_resize` | `item_ref: string` (req), `width: number` (req), `height: number` (req) | **Fast** (in-turn) | No | Resizes an item to specified pixel dimensions. |
| **`item.delete`** | `item_delete` | `item_ref: string` (req) | **Fast** (in-turn) | No (Soft) | Moves an item to the canvas trash. Version history travels with it; fully undoable. |
| **`items.delete`** | `items_delete` | `item_refs: string[]` (req) | **Fast** (in-turn) | No (Soft) | Moves multiple items to trash. |
| **`item.restore`** | `item_restore` | `item_ref: string` (req) | **Fast** (in-turn) | No | Restores a previously trashed item back to active canvas plane. |
| **`items.restore`** | `items_restore` | `item_refs: string[]` (req) | **Fast** (in-turn) | No | Restores multiple items from trash. |
| **`item.addVersion`** | `item_add_version`| `item_ref: string` (req), `content: string` (req), `filename?: string`, `mime?: string` | **Fast** (in-turn) | No | Pushes a new version onto an item's stack (e.g. updating code or document body). |
| **`item.setCurrentVersion`** | `item_set_current_version` | `item_ref: string` (req), `version_ref: string` (req) | **Fast** (in-turn) | No | **Convergence operation**: switches which historical version is visible on the canvas. |
| **`item.react`** | `item_react` | `item_ref: string` (req), `emoji: string` (req), `on?: boolean` (default true), `at_x?: number`, `at_y?: number` | **Fast** (in-turn) | No | **Emoji mark / reaction**: wears an emoji on an item or places a heat-map dot (0..1 fraction). |
| **`area.new`** | `area_create` | `title: string` (req), `x: number` (req), `y: number` (req), `width: number` (req), `height: number` (req) | **Fast** (in-turn) | No | Creates a spatial section/sheet bounding area on the canvas. |
| **`thread.create`** | `thread_create` | `body: string` (req), `item_ref?: string`, `x?: number`, `y?: number` | **Fast** (in-turn) | No | Starts a new pinned conversation thread on an item or in world space. |
| **`thread.reply`** | `thread_reply` | `text: string` (req), `thread_id?: string` | **Fast** (in-turn) | No | Posts in the canvas Chat (or replies to an existing thread). Parked agents hear it. |
| **`comment.on_item`** | `comment_on_item`| `item_ref: string` (req), `text: string` (req) | **Fast** (in-turn) | No | Attaches a comment directly to an item's discussion thread. |
| **`comment.update`** | `comment_update` | `comment_id: string` (req), `body: string` (req) | **Fast** (in-turn) | No | Edits a previously posted comment body. |
| **`comment.remove`** | `comment_remove` | `comment_id: string` (req) | **Fast** (in-turn) | No (Soft) | Soft-removes a comment. |
| **`project.update`**| `project_update` | `title?: string`, `description?: string` | **Fast** (in-turn) | No | Updates project/canvas title and metadata. |
| **`trash.empty`** | `trash_empty` | (none) | **Fast** | **YES (Gated)**| Permanently purges trash. **Refused without explicit human UI confirmation.** |
| **`project.delete`**| `project_delete` | (none) | **Fast** | **YES (Gated)**| Deletes canvas. **Refused without explicit human UI confirmation.** |

---

## 3. UI State, Viewport, Selection & Read Tools

These tools do not mutate the oplog, but provide the model with full sight of the workspace and control over the human's visual viewport:

| Capability | Tool Name | Parameters & Arguments | Execution Type | Description & Semantics |
|---|---|---|---|---|
| **Canvas State** | `read_canvas` | (none) | **Fast** | Returns all active items: id, title, kind, placement (x, y, w, h), currentVersionId. |
| **Item Content** | `read_item` | `item_ref: string` (req) | **Fast** | Reads full markdown/text body, metadata, and version list of an item. |
| **Item Search** | `find_items` | `query: string` (req) | **Fast** | **Find items**: searches titles, ids, and content for matching items. |
| **Conversation** | `read_threads` | `item_ref?: string` | **Fast** | Reads conversation threads, comments, and Chat history. |
| **Presence & Roster**| `read_presence` | (none) | **Fast** | Reports who is live in the room right now and which agents are enrolled. |
| **Oplog Timeline**| `read_history` | `limit?: number` (default 20) | **Fast** | Reads the latest oplog operations and activity timestamps on this canvas. |
| **Viewport Focus** | `viewport_focus` | `item_ref: string` (req) | **Fast** | Centers and zooms the human's web canvas view onto a specific item. |
| **Viewport Pan** | `viewport_pan` | `x: number` (req), `y: number` (req), `zoom?: number` | **Fast** | Moves the human's camera to specific world coordinates and zoom level. |
| **Set Selection** | `selection_set` | `item_refs: string[]` (req) | **Fast** | Sets active visual selection box around specified items. |
| **Clear Selection**| `selection_clear`| (none) | **Fast** | Deselects all items on the canvas. |

---

## 4. Architectural Rules & Inferences

1. **Derived Vocabulary Principle**:
   - The tool declarations are generated from `@isocan/core` constants and types (`ops.ts`, `opwords.ts`, `drawing.ts`).
   - Where operations accept raw ids (e.g. `itemId: string`), the voice tool accepts human-friendly references (`item_ref: string`), which are resolved against live canvas state by `resolveSpokenRef` (matching title, prefix, id, or ordinals like "the second screen").
2. **Fast vs Slow Boundary**:
   - Every operation in the table above is **fast** (one local round-trip to the daemon or client).
   - If a human asks for an unbounded generative task ("design five alternatives for the landing page"), the voice model does not hang the audio turn; it speaks a brief acknowledgment and uses `say` to post the task in the Chat where parked autonomous agents pick it up.
3. **Destructive Guard**:
   - Tools marked **YES (Gated)** (`trash_empty`, `project_delete`) are confirmation-gated. If the model invokes them directly, the harness refuses execution with an explicit error:
     `"Destructive actions require explicit confirmation in the UI; voice agents cannot execute this unattended."`
   - A model-supplied `confirmed: true` parameter is rejected; the gate is human-in-the-loop.
4. **Project Instructions (`AGENTS.md`)**:
   - Injected directly into Gemini Live `systemInstruction` via `resolveProjectInstructions()`.
   - Capped at 12,000 characters to protect real-time latency.
5. **Full Tool Logging (`/log`)**:
   - Every invocation (name, arguments, minted operation, daemon response/error, and source `live` vs `typed`) is recorded to `~/.isocan/voice/log.json` and broadcast live over WebSocket.

---

## 5. Verification Plan (Acceptance Walk)

The acceptance test must exercise one operation from each family:
1. **Content**: `add_item` (creates note)
2. **Layout**: `move_item` / `items_move` (moves items)
3. **Comment**: `comment_on_item` (posts comment)
4. **React**: `item_react` (adds emoji reaction `👍`)
5. **Draw**: `drawing_add` (draws with pen tool)
6. **Version**: `item_set_current_version` (switches version)
7. **Destructive Guard**: `trash_empty` (refused with confirmation requirement)
8. **State Reads**: `read_canvas`, `read_item`, `find_items` (answering from live state)
