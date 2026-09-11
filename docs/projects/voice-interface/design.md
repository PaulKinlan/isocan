# Voice on the isomorphic canvas

**11 September 2026.** Voice is an input surface over existing Operations, not a
second agent protocol. The [journey](journey.md) remains the ideal; the bounded
CLI prototype below is deliberately smaller. No live microphone or provider
session has been used to validate it.

## Relationship to the voice note (#139)

This extends [Live mode: voice on an isomorphic canvas](../../research/2026-08-24-voice.md),
not a parallel product or a Pi fork.

- **Completes the vision:** an ambient lifecycle with reconnect; workspace and
  project addressing above focused-canvas selection (the largest gap in the
  note); provider choice; and voice as a separately attributed peer agent.
  These are requirements, not claims that the prototype implements them all.
- **Resolves the tension:** always available does not mean always listening or
  continuously billed. Connect on explicit intent, show the microphone state,
  and stop on demand. A voice-only client is fine; a voice-exclusive capability
  is not. Every effect must remain reachable by the ordinary CLI and browser.
- **Reinforces the foundation:** the CLI/daemon owns provider sessions and
  credentials. Selection, cursor and `#Title` references supply focused-canvas
  deixis; existing `thread.create`/`thread.reply` dispatch slow work. No new
  notification bus or privileged session started by a website is needed.

The full design still owes conversational workspace addressing, reliable
reconnection, real audio terminals and a distributed floor. The prototype uses
an explicit canvas ref and exact item IDs instead of guessing what “that one”
means.

## Provider contract, checked 11 September 2026

These are documentation findings, **not live service validation**:

- **Gemini Live:** the [WebSocket reference](https://ai.google.dev/api/live)
  requires `setup` first and `setupComplete` before additional messages.
  `realtimeInput.audio` replaces deprecated `mediaChunks`. Transcription is
  enabled by `inputAudioTranscription` and `outputAudioTranscription` on setup;
  output arrives in `serverContent`. Function results carry the matching ID,
  name and response. Tool cancellation IDs must not be treated as new work.
- The [Gemini audio-format guide](https://ai.google.dev/gemini-api/docs/live-guide#audio-formats)
  says: “Input audio is natively 16kHz, but the Live API will resample if needed
  so any sample rate can be sent.” The MIME type must describe the actual
  bytes. Output is 24kHz little-endian PCM16. The adapter nevertheless converts
  locally to its declared native input format so the audio client need not
  contain provider-specific logic.
- **OpenAI Realtime:** [WebSocket](https://developers.openai.com/api/docs/guides/realtime-websocket)
  is the server-to-server path; [WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
  is also supported and recommended for browser/mobile clients. Daemon custody
  selects WebSocket here, not a claim that OpenAI only supports that transport.
- The [GA client schema](https://developers.openai.com/api/reference/resources/realtime/client-events)
  uses `session.type: "realtime"`, `output_modalities`, nested `audio.input` and
  `audio.output`, and PCM format `{type: "audio/pcm", rate: 24000}`. The adapter
  waits for `session.updated`, not merely `session.created` or an open socket.
  It does not send the old beta header or flat `pcm16` configuration.
- The [server schema](https://developers.openai.com/api/reference/resources/realtime/server-events)
  names `response.output_audio.delta`. `response.done` is always emitted and
  carries `completed`, `cancelled`, `failed` or `incomplete`. This prototype
  dispatches complete function calls from a **completed** response's output,
  then sends function outputs and one continuation, rather than racing
  `response.create` against a still-running response. Cancelled responses do
  not dispatch their functions.

Model names are caller configuration, not baked-in defaults. The original
`gemini-2.0-flash-exp` assumption is not retained. Verify availability and limits
for the chosen model before enabling it; no session duration, token lifetime,
context size or resumption window from the older note is treated as current.

### Fast tools and slow threads

The [function declaration contract](https://ai.google.dev/api/generate-content#FunctionDeclaration)
includes `BLOCKING` and model-dependent `NON_BLOCKING` behaviour. The
[Live tools guide](https://ai.google.dev/gemini-api/docs/live-api/tools) currently
lists Gemini 3.1 Flash Live Preview as synchronous-only and Gemini 2.5 Flash
Live Preview as synchronous/asynchronous. A project explicitly pinning and
verifying the latter can consider `NON_BLOCKING` plus response scheduling;
this adapter does not enable it. It is not a platform-wide sync-only rule.

Keep fast canvas gestures as tools and slow work as thread dispatch regardless:
a person should not wait through a build to continue talking. Non-blocking tools
are an option for a specifically selected, verified model, not a reason to
create another task channel. **Below 50ms is an engineering target, not a
measurement.** Only the bounded read/move subset is implemented here; thread
posting and background-agent dispatch are deferred.

## Bounded CLI demo

From a checkout:

```sh
npm install
npm run voice -- --help
npm test -- packages/voice/test
```

The tests start a synthetic local daemon and a real CLI child process. For a
canvas you have deliberately chosen, first claim a distinct agent using the
existing identity command under `ISOCAN_HARNESS=isocan-voice` and
`ISOCAN_SESSION_ID=demo-voice`. Then:

```sh
npm run voice -- --canvas <canvas-ref> --session demo-voice --provider simulated \
  --allow-move <exact-item-id>
```

Type `items`, `who`, or `move <exact-item-id> to 330 220`. `/mute`, `/unmute`,
`/stop`, EOF and Ctrl-C control the session. JSON output names the provider,
connection status, actor and grants, and always says **microphone off** and
**audio playback unavailable**. A session runs for 60 seconds by default;
`--seconds` accepts 1–300. This is deterministic **text simulation**, not speech
recognition, a voice-quality demonstration or a latency result.

`connect({identity: {harness: "isocan-voice", session}})` uses the existing API's
claimed-actor door. It refuses an unclaimed identity rather than impersonating
the person. `Home.canvas(ref)` uses ordinary canvas resolution.
`CanvasHandle.move()` supplies the native gesture, including attached
annotations; readback comes from the daemon. The same Operation is visible in
the existing browser canvas and its oplog. No new op, API route or audio listener
is introduced.

The manifest is closed: `canvas_items`, `canvas_who`, and `item_move` only when
specific item IDs were granted. Read results contain IDs, names and geometry,
not arbitrary item contents. Runtime validation rejects unknown tools, extra
arguments, non-finite coordinates and moves outside the grant. `trash.empty`,
canvas/project deletion, arbitrary execution and thread dispatch are not tools.

Presence is a normal named CLI session, not another identity system. Stop
revokes future dispatch and ends this presence lease; it does not retire the
claimed actor. A gesture already handed to `CanvasHandle` may complete after
cancellation, and stopping is **not rollback**. The oplog remains the record of
what actually happened.

One exclusive file lock prevents two demo CLIs taking the same **local
home/canvas** floor. It is not a cross-machine room lock. A hard crash can leave
that lock: confirm the recorded process is dead before removing the named file.
A failed connection stops; automatic reconnect, provider resumption and tool
replay are deliberately absent.

## The audio seam

[The source contract](../../../packages/voice/src/types.ts) carries PCM bytes
with encoding, channels and sample rate. Each adapter declares native input and
output formats; a caller supplies its actual capture format and may request a
playback format. The adapters own conversion, not the client.

Gemini declares 16kHz input; OpenAI's selected PCM mode declares 24kHz. Both
currently declare 24kHz output. Tests give **the same 48kHz input** to both,
assert the actual differently sampled wire bytes, then feed output over each
real local WebSocket and verify conversion to the requested 48kHz playback
format. Chunk-split tests check phase continuity, including 44.1→48kHz.

The [PCM converter](../../../packages/voice/src/pcm.ts) uses streaming linear
interpolation with one input sample of lookahead. It preserves phase across
chunks, but has **no anti-alias filter**; a final lookahead tail is discarded on
stop/turn end. This is prototype-quality conversion, not a claim of production
speech quality. A band-limited converter and real capture/playback evaluation
are owed before live-audio acceptance. The simulation intentionally accepts no
audio rather than pretending silent bytes were recognised.

## Activation, custody and remaining safety work

The CLI selects `simulated`, `gemini` or `openai`. Cloud selection refuses before
reading a provider key unless `--enable-cloud` **and an explicit `--model`** are
provided. Only then does the CLI read `GEMINI_API_KEY` or `OPENAI_API_KEY` from
its environment. Keys never belong in command arguments, browser code or logs.
The library adapters receive credentials from their host and never read the
environment themselves. Provider errors do not echo URLs or authorization
headers. Local wire tests use synthetic keys and localhost peers only.

Cloud activation permits provider costs and disclosure of messages and offered
tool results; it is not permission for microphone capture. No live activation
has been performed. Muting stops input and tool dispatch but does not close a
billable provider connection: **stop disconnects it**. The bounded deadline
terminates the provider socket even when local cleanup is still pending.

A future audio terminal must be explicitly engaged, show live/mute/stop state,
and use the daemon's authenticated, Origin/CSRF-checked boundary. A proposed
audio endpoint is not an implemented boundary. Distributed floor ownership,
playback queue clearing/truncation, device permissions, session resumption and
recovery from ambiguous in-flight effects still need design and driven tests.

Live transcripts belong in ephemeral presence, not the durable thread. The
prototype prints transient transcript events to stdout (redirecting stdout
would record them); it posts no transcript or decision comments. Future
confirmed decisions require read-back before a comment is written. Durable
canvas effects must replay from Operations **without re-running audio or model
calls**; the conversation itself is not reconstructed from the oplog.
