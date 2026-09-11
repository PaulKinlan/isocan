# Voice on the Isomorphic Canvas — The Implementation Walk

**11 September 2026.** The implementation walk for [design.md](design.md),
guided by the acceptance criteria in [journey.md](journey.md).

**Where we are: PHASE 1 IN PROGRESS (2026-09-11).**
- Project docset authored: `journey.md`, `design.md`, `phases.md`.
- Provider facts and corrections are in [design.md](design.md#provider-contract-checked-11-september-2026): native formats differ, Gemini accepts other declared input rates, and synchronous-only function calling is model-specific. No live provider test has run.
- Architectural boundaries locked: Subproject inside `isocan`; daemon/CLI process owns cloud sockets and credentials; mic is client-only; exact existing `Operation` vocabulary; `trash.empty` and canvas deletions strictly forbidden.
- The bounded prototype now overlaps phases 1–3: a checkout-only `npm run voice` CLI, provider WebSocket plumbing and keyless **text** simulation. Its only tools are item/presence reads and explicitly granted moves; it has no microphone, playback or browser endpoint. See [the actual demo](design.md#bounded-cli-demo). The larger walk below is planned scope, not an implementation inventory.

---

## Phase 1 — Architecture, Provider Seam & Keyless Simulation Backend

The foundation: define the provider-agnostic abstraction and build an in-memory
simulation engine so the entire operation pipeline can be tested without cloud
credentials, network egress, or financial spend.

### Doors
1. **Where does the voice package live?**
   *Decision:* As `packages/voice` inside the isocan workspace, depending on
   `@isocan/core` and `@isocan/api`.
2. **How are voice tools defined?**
   *Decision:* A closed capability list calls the existing `CanvasHandle`
   gestures. Do not expose raw Operation schemas as a model's authority.

### Steps
1. Create `packages/voice` workspace with `VoiceBackend` interface and types.
2. Implement `KeylessSimulationBackend`:
   - Parses deterministic text commands and emits labelled synthetic transcripts;
     it does not recognise or synthesise speech.
   - Dispatches synthetic function calls to verify canvas manipulation.
3. Map fast operations (<50ms) to voice tool declarations:
   - `item.move`, `items.move`, `item.resize`, `item.update`, `item.setCurrentVersion`.
   - `thread.create`, `thread.reply`, `thread.setMain`, `thread.setAnchor`.
   - `actor.setColor`, `actor.setMark`.
4. Implement strict safety filter:
   - Explicit unit assertions that `trash.empty`, `project.delete`, and
     `canvas.delete` are rejected and omitted from tool declarations.
5. Unit and integration tests verifying tool calls execute through
   `CanvasHandle` and produce valid `Operation` records in the oplog.

### Acceptance
- Vitest tests in `packages/voice/test/` pass cleanly.
- Replay test passes: oplog replay reproduces all canvas changes made via
  simulated voice tools without requiring audio streams.

---

## Phase 2 — CLI-Started Voice Companion (`isocan voice`)

Build the CLI entry point that launches the voice agent as a local process.

### Doors
1. **How is the voice agent started?**
   *Decision:* Via `isocan voice` in the CLI. The command resolves the local
   daemon and canvas using `@isocan/api` (`connect()`), identical to `isocan wait`
   and `isocan rc`.
2. **How does the voice agent appear to other clients?**
   *Decision:* As an active actor in presence (`isocan who`), with a voice badge.

### Steps
1. Register `isocan voice` command in `packages/cli/src/main.ts`:
   - Flags: `--as <name>`, `--provider <simulated|gemini|openai>`, `--model <model>`, `--voice <voice>`.
2. Wire connection through `@isocan/api`:
   - Connects to canvas, emits presence heartbeat.
   - Binds transcript output to `session say` (ephemeral presence updates).
3. Connect `KeylessSimulationBackend` to execute simulated interactive sessions.
4. Add CLI help text and update `packages/cli/src/agent-guide.md`.

### Acceptance
- Running `isocan voice --provider simulated` connects to a running local daemon,
  announces presence, and executes test commands without error.
- Verified in `packages/cli/test/voice.test.ts`.

---

## Phase 3 — Live Cloud Provider Adapters (Gemini Live & OpenAI Realtime)

Implement the real-time WebSocket adapters for Google Gemini and OpenAI.

### Doors
1. **Where do API keys live?**
   *Decision:* Read from local environment variables (`GEMINI_API_KEY`,
   `OPENAI_API_KEY`) or local secure config by the daemon/CLI process. Never
   sent to the browser, never written to git, and never logged.
2. **When is cloud voice activated?**
   *Decision:* Cloud activation requires explicit owner approval. Code includes
   mock/keyless modes so default tests and builds never require live keys.

### Steps
1. Implement `GeminiLiveBackend` (`packages/voice/src/gemini.ts`):
   - WebSocket connection to Google Multimodal Live API.
   - Adapter-owned conversion from declared client format to native 16kHz PCM16.
   - Server audio parsing (24kHz PCM16).
   - Fast calls using the default blocking mode; async is a separately verified,
     model-dependent option.
2. Implement `OpenAIRealtimeBackend` (`packages/voice/src/openai.ts`):
   - WebSocket connection to OpenAI Realtime API.
   - Event framing for `input_audio_buffer.append` and `conversation.item.create`.
   - Tool response emission.
3. Socket lifetime management:
   - Verify the selected model's connection/session limits and resumption support
     before designing reconnect; no universal 10–15 minute timeout is assumed.

### Acceptance
- Unit tests verify WebSocket message framing, serialization, and error recovery
  using mock WebSocket fixtures.
- Future live provider tests require explicit owner activation. No live-test
  environment switch or microphone test exists in the bounded prototype.

---

## Phase 4 — Browser Audio Client & Presence Synchronization

Add browser microphone streaming and audio playback to the web app over local loopback.

### Doors
1. **How does browser audio reach the daemon?**
   *Decision:* Over a local loopback WebSocket (`ws://127.0.0.1:PORT/api/voice/stream`).
   The browser does not connect to Google or OpenAI directly.
2. **How is microphone consent handled?**
   *Decision:* User must explicitly click the microphone button; browser
   requests `getUserMedia` permissions. Prominent visual indicators show when the
   microphone is active, muted, or stopped.

### Steps
1. Daemon endpoint `GET /api/voice/stream` (WebSocket):
   - Validates localhost Origin and session tokens.
   - Relays raw PCM audio between browser and active `VoiceBackend`.
2. Browser `AudioWorklet` for low-latency PCM capture and playback.
3. Web UI presence integration:
   - Microphone indicator on the emissary agent's card.
   - Real-time display of `session say` ephemeral speech transcripts.

### Acceptance
- Playwright/CDP integration test verifies microphone permission prompt,
  audio stream relay, and presence avatar state transitions.

---

## Phase 5 — Thread Delegation & Decision Readback Protocol

Connect the voice agent to the rest of the canvas ecosystem.

### Steps
1. Implement thread delegation:
   - When a user requests complex work, voice agent calls `thread.reply` with
     `@agent` mentions, waking parked workers on `isocan rc`.
2. Implement decision readback confirmation:
   - Decisions require explicit user verbal agreement before committing a
     formal comment to the thread.
3. End-to-end dogfooding walk:
   - Spoken canvas navigation, item arrangement, design convergence, and
     background task delegation.

### Acceptance
- Full multi-agent interaction demonstrated and replayable from the oplog.
