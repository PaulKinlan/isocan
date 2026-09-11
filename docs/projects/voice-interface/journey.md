---
status: designed
since: 2026-09-11
see: voice-interface, iso-api, on-demand
note: Opt-in voice input over existing Operations. The larger voice journeys remain designed; a bounded checkout CLI tests the provider seam and real gestures with keyless text simulation, not live audio.
---
# Voice on the Isomorphic Canvas — the journeys

**11 September 2026.** The ideal, written as user journeys.
[design.md](design.md) argues the mechanism; [phases.md](phases.md) orders
the work and parks its decisions. Each journey here is an acceptance test:
a phase that claims one closes only when you can walk it, for real, on a
real canvas. Journeys describe what you experience, not how it works —
where a journey seems to force a mechanism, the mechanism is what bends.

**You** are a designer or engineer working on an isocan canvas. **Charlie**
is the active voice emissary in the room — an enrolled agent whose voice
holds the floor. **Gina** is an implementation agent parked on `isocan rc`.

**`isocan voice`** below is the **proposed** installed command, not an available
command or a completed journey. Today's [bounded demo](design.md#bounded-cli-demo)
is `npm run voice` in a checkout, with text input and no audio device. The
future companion is a long-running
process running on your machine, connected to the local daemon and the
canvas over the existing operation and presence channels. The daemon holds
the provider connection and credentials; your microphone and speaker are
local client capabilities.

---

## Journey 1 — Bring a voice agent onto the canvas

*One command in the terminal; a voice appears in the room and on the canvas.*

1. In your project directory, with your local daemon running:
   ```bash
   isocan voice --as Charlie
   ```
   Or explicitly selecting the provider backend:
   ```bash
   isocan voice --as Charlie --provider gemini
   ```
2. In the web app, Charlie's avatar lights up in the presence bar with an
   active microphone badge (`isocan who` in another terminal shows
   `Charlie (voice, live)`).
3. Charlie speaks a brief greeting through your speaker: *"I'm on the canvas.
   What are we looking at?"*
4. No browser extension, no third-party plugin, and no API keys pasted into a
   web form. The process runs locally under your control.

---

## Journey 2 — Direct canvas manipulation without touching the mouse

*Fast, spoken manipulation that produces ordinary, undoable operations.*

1. You speak naturally: *"Move the checkout card to position two hundred, four hundred."*
2. Under Charlie's face in the web app, a transient presence status appears:
   `session say: "moving #Checkout…"` — ephemeral text that costs no operation
   and leaves no clutter in the permanent log.
3. The checkout card glides to `(200, 400)` on the screen.
4. On your screen or CLI, hit `⌘Z` or type `isocan undo`. The card returns to
   its previous position. Spoken acts produce standard `Operation`s
   (`item.move`); they are indistinguishable from clicks or CLI commands.
5. Charlie responds concisely: *"Moved."*

---

## Journey 3 — The spoken convergence gesture

*Resolving design divergence in a single sentence.*

1. An agent has explored three alternative navigation cards on the canvas
   (`item.addVersion` created v1, v2, and v3).
2. You look at the second version: *"Keep the second version of the nav card."*
3. Charlie immediately executes `item.setCurrentVersion`.
4. The canvas updates instantly to display v2 as the canonical version.
5. What previously required opening an item drawer, inspecting versions, and
   clicking through confirmation dialogs happened as a one-second spoken
   sentence.

---

## Journey 4 — Deictic referencing using shared presence and selection

*Talking about "this" and "that" without naming filenames or coordinates.*

1. You click and drag across three screen cards on the canvas. Your selection
   is published as shared presence state (`PresenceSession.selection`).
2. You speak: *"Align these along the top edge."*
3. Charlie resolves *"these"* directly from your active selection:
   reads the bounding boxes of the three selected items, computes the minimum
   `y` coordinate, and submits an `items.move` operation.
4. All three cards align cleanly along the top edge in under 100 milliseconds.
5. Charlie: *"Aligned to top."*

---

## Journey 5 — Delegating heavy work without blocking the voice floor

*Slow tasks are dispatched to parked agents via threads, keeping voice responsive.*

1. You: *"Ask Gina to rebuild the payment card to include Apple Pay."*
2. Building a full interactive screen is slow work (dozens of seconds of code
   generation and test execution). Charlie does **not** stall the audio
   stream on a blocking tool call.
3. Charlie replies immediately: *"I've asked Gina to update the payment card."*
4. Under the hood, Charlie creates a comment on the payment card's thread:
   `thread.reply(threadId, "@Gina please update this screen to support Apple Pay")`.
5. Gina (parked on `isocan rc`) wakes up via the standard inbox mechanism,
   announces her presence on the thread, and begins building in the background.
6. Meanwhile, your voice session with Charlie remains live and uninterrupted.
   You continue discussing copy and layout while Gina's work lands as a new
   version branch.

---

## Journey 6 — Consensus, read-back, and durable records

*Conversation is ephemeral; decisions are verified before they become comments.*

1. You and Charlie discuss typography options for ten minutes.
2. Charlie does not pollute the canvas thread with transcripts of every utterance.
3. When the discussion resolves, Charlie initiates a read-back:
   *"So to confirm: we're switching the primary heading to the slab serif,
   and moving all data labels to the monospace font. Shall I post that to the
   spec thread?"*
4. You say: *"Yes, post that."*
5. Charlie posts a single, structured summary comment to the canvas thread:
   `thread.reply(threadId, "Decision: heading to slab serif, data labels to monospace.")`.
6. A teammate checking the canvas tomorrow reads one clear decision comment,
   rather than wading through two hundred lines of raw chat transcripts.

---

## Journey 7 — Safety boundaries and excluded verbs

*Destructive operations are refused by construction.*

1. You say: *"Empty the trash and delete this project."*
2. The voice agent's tool declaration deliberately omits `trash.empty`,
   `project.delete`, and `canvas delete`. The model has no tool definition for
   irreversible actions.
3. Charlie responds: *"Irreversible deletions cannot be commanded by voice.
   Please use the CLI or project dashboard with explicit confirmation."*
4. No excluded operation is dispatched through the voice tool boundary.
   This is not a claim of protection against other authorised canvas clients.

---

## Journey 8 — Keyless simulation and multi-provider selection

*Developing and verifying voice interaction without cloud credentials or material spend.*

1. From a checkout, after claiming a distinct `isocan-voice` identity:
   ```bash
   npm run voice -- --canvas <canvas-ref> --session demo-voice --provider simulated
   ```
2. The bounded simulator parses deterministic **text** commands and exercises
   existing Operations and presence. It does not perform audio loopback,
   recognise speech fixtures or establish voice quality. `--allow-move` names
   each item whose native move gesture is allowed, including its annotations.
3. Cloud transport needs separate owner activation, an explicitly verified
   model, and a host-held key. Only after that approval:
   ```bash
   npm run voice -- --canvas <canvas-ref> --session demo-voice \
     --provider gemini --enable-cloud --model <verified-model>
   ```
   `--provider openai` selects the other adapter with its own verified model.
   The CLI still has no microphone capture or speaker playback. Adapter tests
   use local WebSocket peers; no live provider session has been validated.
4. Only the explicitly activated host reads `GEMINI_API_KEY` or
   `OPENAI_API_KEY`. Neither key belongs in a command argument, log or browser.
   This prototype does not read a credential store.
