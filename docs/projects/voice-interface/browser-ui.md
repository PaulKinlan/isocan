---
status: partial
since: 2026-09-12
issue: 139
note: Local /voice-check capture, meter and playback built; Gemini Live, tokens and canvas voice control not built
---
# Browser voice: permission, a Live session, and ordinary operations

This plan replaces the missing browser capture/playback surface, not the
reviewed CLI harness. It follows the [revised research note](../../research/2026-08-24-voice.md).
The source census is against upstream `ed8efe0c`; the note was reviewed at
`2dd38c54`. **Only the free `/voice-check` page is built on this branch.**
The Gemini session, issuer and canvas voice-control surface below remain a
plan. On a running checkout, open `/voice-check` over HTTPS or loopback HTTP;
an arbitrary LAN HTTP origin cannot request a microphone.

The capture slice was driven in Chrome 152.0.7977.82 with a fake stepped-tone
device: one audio track, zero video tracks, changing meter, local recording,
decodable signal, native playback and cleanup. A separate run without
auto-accept exercised denial. Another headful run captured Chrome's native
mic-only permission prompt. None used a real microphone or a model. The
future `<microphone>` branch remains unexercised on this browser.

## Delivery order: let the person speak into something first

**Step 1 — capture only, free.** Build a small `/voice-check` page in the
existing web app before integrating the full canvas control. It prefers a
real `<microphone>` when supported, otherwise a mic-only JS fallback (see the
runtime correction below), a live level meter, a short local recording and
an explicit Play control. Recording and playback
stay in this tab's memory; stop tracks and release recording URLs on reset or
exit. Avoid immediate speaker loopback and its feedback risk. There is no
provider, key, transcript service, token mint, canvas operation or cloud audio.
Do not require a voice-provider configuration merely to open this check page.

This proves the physical input path, permission handling, actual browser
support, audible local playback and cleanup **on the person's own setup**.
Automated evidence uses fake devices; only Paul trying it can establish his
real microphone/Chrome result. Publishing the page does not authorize an agent
to activate real hardware. This is a capture check, not a pretend voice agent.

**Gate between steps.** The capture path must work and clean up with real
browser evidence before adding the provider. Keys, live-provider traffic,
spend and agent-driven real-microphone use remain off until Paul explicitly
activates them. A synthetic local provider fixture may exercise the code
without crossing that boundary.

**Step 2 — the thin live slice.** Reuse that capture path for mic → browser
Gemini Live session → visible transcript → **one offered tool that applies one
observable native operation**. Use a daemon-minted ephemeral token, not a key
in the page. Start with the already-reviewed scoped move gesture and show its
actual daemon/actor readback. This is the first voice-control milestone, not
the complete Stitch-like UI, full public vocabulary or polished playback.
Keep its deliberately small manifest labelled as a milestone, not an
enduring voice-specific authority restriction.

The remaining sections specify the follow-through: bottom-left integration,
all permitted public operations, confirmation and lifecycle hardening. They
must not postpone the free capture page or be claimed complete by the one-tool
slice. Deliver on the fork branch; **no new PRs or merges during Paul's hold**.

## Boundaries and the first cut

The browser captures audio, holds Gemini Live with an ephemeral token, and
plays responses. The daemon holds the system-key integration, authorizes
minting and applies every canvas operation through the existing engine.
There is no voice-only operation vocabulary or second state writer.

Hosted issuance requires the existing badge with a server-verified email
attestation. A string naming an email, a claim-key harness, a WebSocket labelled
`web`, or a User-Agent is not a substitute. Local issuance is an explicitly
configured, loopback-only machine-trust mode. An agent sharing the user's
badge shares its authority; this build does not solve per-actor credential
isolation.

**Funding decision still open:** [the innkeeper](../multiuser/innkeeper.md)
says the operator pays for storage and relay while harness minutes bill to the
owner's account. The proposed system Gemini key bills the operator for voice.
That is a departure, not something this plan silently reconciles. Keep hosted
activation off pending the product decision and an operator-configured policy.
Local synthetic development requires neither a key nor that activation.

## The bottom-left control

Integrate a lazy-loaded voice controller in
`packages/web/src/pages/CanvasPage.tsx`, using the current component, color,
spacing and focus conventions. Do not add a second app shell. The existing
`Minimap`, rail and `ZoomControls` must remain usable at narrow widths and
when a side panel opens; use their existing rail-offset calculation rather
than placing an unrelated fixed overlay on top of them.

**Runtime correction after the plan review:** prefer a real
`HTMLMicrophoneElement` when implemented; otherwise call
`getUserMedia({audio:true, video:false})` from an ordinary labelled button.
The specific element supplies a `track`/`track` event and owns its native
mute/unmute toggle. Do not use `autostart`.

The first Chrome 152 browser run exposed an incorrect assumption in the
reviewed plan: modern `<usermedia>` requests **both camera and microphone**.
Its native label said so despite audio-only `setConstraints`. The
[Chromium implementation](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/html/html_user_media_element.cc)
unconditionally constructs both permission descriptors outside legacy mode;
constraints change preferences, not that permission set. `type="microphone"`
only takes effect in legacy mode. Do not weaken the audio-only guard or enable
legacy flags to make the check pass. The UI explains why an available
usermedia element is skipped. This scope correction was approved before the
capture implementation was published.

The source article says usermedia shipped in 151 and microphone is roadmap;
the observed Chrome 152 has `HTMLUserMediaElement`, not
`HTMLMicrophoneElement`. Record the actual selected path and browser version.
The native browser permission prompt on the **JS path** remains valid prompt
evidence; it is not evidence that a microphone element exists.

The states must be visible as words, not color alone:

| State | What the person sees and can do |
| --- | --- |
| Unconfigured / sign-in required | Why voice is unavailable and the existing sign-in path where configured. No microphone request or provider call. |
| Ready / requesting permission | An accessible mic control. Denial, dismissal and missing device have distinct recovery messages; no automatic re-prompt. |
| Connecting | Capture acquired but audio not sent before `setupComplete`. Cancel releases the stream and abandons pending setup. |
| Listening / responding | Voice actor, elapsed time, token expiry, a usage estimate, and explicit “audio sent to Google” disclosure. |
| Muted | No outgoing audio or new tool dispatch. Say that the connection is still open and may incur usage. Unmute and Stop remain separate. |
| Confirmation pending | Exact action and target, consequence, Confirm and Cancel. Nothing dispatched yet. |
| Stopped / failed / expired | No active capture, playback queue or future tool dispatch. Explain whether another token is needed; do not say the old Google token was remotely revoked. |

Keep controls keyboard-operable, announce state changes without narrating each
audio chunk, restore focus after confirmation, and respect reduced motion.
Transcripts are session-local by default, not automatically published as a
thread. Show a permanent simulation label in the synthetic mode.

## Token issuer and credential custody

Add a small daemon route module rather than putting provider plumbing in the
UI. Proposed endpoints are `GET /api/projects/:id/voice` for availability and
policy, and `POST /api/projects/:id/voice/token` for a fresh session token.
They are **proposed routes**, not existing API surface. The availability
response contains no key or credential values.

The POST must check configuration, authenticated badge, the acting actor's
binding, canvas admission and the configured mint standing before reading a
key or making an outbound request. Hosted mode additionally requires a stored
verified-email attestation. Preserve existing cookie/Origin/CSRF protections;
validate the local host/loopback posture against DNS-rebinding and accidental
remote exposure. Headers can support CSRF checks, not prove a person.

The daemon makes the documented fixed-origin Google auth-token request.
The browser receives only the ephemeral token and public session policy and
uses the `v1beta` constrained WebSocket endpoint with `access_token`. Do not
accept an arbitrary provider URL, model, expiry or tool manifest from the
browser. Keep request and response errors free of keys, tokens and raw
provider bodies. Responses containing tokens are `no-store`.

Proposed initial policy, to be encoded and tested rather than inferred from
provider defaults:

- Explicit model `gemini-3.1-flash-live-preview`; no speculative model ID.
- One use, 30 seconds to establish the session, 120-second token lifetime.
- Constrain the model and setup, including the offered tool declarations and
  output mode. Check the raw REST encoding against primary API/SDK sources;
  SDK configuration property names are not automatically raw wire names.
- A separate voice mint-count bucket, initially burst 2 / two per minute,
  using `TokenBuckets` rather than changing the badge-mint bucket's policy.
  Key hosted per-user limits from verified identity, not a body label or a
  freely minted badge ID alone. Also impose an operator-wide limit.
- Record issued-token validity independently of the browser's Stop report.
  Stopping locally must not pretend a still-valid token ceased to exist.
  Expose cooldown/remaining validity honestly if it prevents a new session.
- Private per-mint records: timestamp, caller/badge/actor reference, canvas,
  model, requested expiry, outcome and reported usage provenance. No API key,
  provider token, transcript or audio. They belong with private desk/audit
  state, never in the public operation stream. Bound retention.

These are **duration/rate/uses bounds plus a usage estimate**. The existing
meter resets on restart and is not a money ledger. Browser usage reports are
not authoritative. No hard dollar cap or immediate Google token revocation
is promised. A genuine budget/early-cutoff mechanism is separate follow-up
work; it must not be smuggled in as a client timer.

For self-hosting, obtain the key from the **daemon process's environment
specifically**, after activation checks. Do not recommend a global shell
export: `packages/cli/src/acp.ts` forwards `GEMINI_*` and `ISOCAN_*` from the
rc's environment into adapters. A key present there is not daemon-only.
No UI key-entry field and no general third-party secrets store are added.

For hosted custody, the [on-demand design](../on-demand/design.md#isocannery-sketched)
proposes substituting secrets at egress. The [11 September changelog](../../changelog/2026-09-11.md#the-sandbox-spike-on-linux)
records that pattern working for a Claude sandbox. It is a precedent, **not
verification of a Gemini auth-token integration**. A hosted adapter must prove
its own key injection and non-leakage before activation. Existing KMS-wrapped
launch-token design is likewise not permission to store users' Gemini keys.

### Reuse the bounded-mint precedent without overstating it

[Innkeeper mechanism 11](../multiuser/innkeeper.md#mechanism-11-designed-the-bounded-standing-mint)
is frozen delegation: only what the creator could mint, on the intended
canvas, one summons at a time, with authority rooted in the creator's grant.
It is historical design; do not edit it to describe this feature.

Use the same constraints on **new issuance and local operation authority**.
The built `mintPass`/`redeemPass` path supplies a fresh secret, hash-at-rest,
atomic single redemption and existing admission provenance; it is prior art,
not a reason to invent another account or crypto framework. The current pass
implementation endows the presenting badge, not a newly minted badge: preserve
that fact when reusing it. Do not assume calling `mintPass` alone authorizes
anything; its route performs the caller checks.

A Google token is not an isocan pass. Revoking a local grant can stop future
minting and local writes, but an issued provider token may remain valid until
its expiry. Reusing the provenance sweep does **not** make that external
credential die immediately with the grant. Keep this residual lifetime in the
UI and audit rather than promising the innkeeper's local revocation semantics
at Google's boundary.

## Tool surface and attribution

The complete target below follows the one-tool milestone; it is not the
acceptance claim for Step 2. Use the existing operation endpoint and engine,
not a new voice mutation endpoint. A browser-facing `execute_operation` tool accepts the ordinary
Operation JSON; native validation remains authoritative. Read helpers expose
ordinary admitted canvas state/presence. Reuse existing gesture helpers when
an intention, such as moving an item with its annotations, is more than a raw
primitive. Do not build a parallel shell, eval endpoint or arbitrary-fetch tool.

At the inspected source, the union has 33 members, of which these **28 are
public**:

- `actor.claim`, `actor.setColor`, `actor.setMark`, `actor.join`.
- `project.create`, `project.update`, `project.delete`.
- `item.add`, `item.react`, `item.move`, `item.resize`, `item.update`,
  `item.addVersion`, `item.setCurrentVersion`, `item.delete`, `item.restore`.
- `items.move`, `items.delete`, `items.restore`, `trash.empty`.
- `thread.create`, `thread.reply`, `thread.setAnchor`, `thread.setMain`,
  `thread.delete`, `comment.update`, `agent.enroll`, `agent.withdraw`.

`INTERNAL_OP_TYPES` excludes `item.removeVersion`, `item.restoreVersion`,
`comment.remove`, `comment.restore` and `thread.restore`; the engine already
refuses those as direct client operations. Pin catalog equality to the actual
Operation declaration and internal set in tests, rather than freezing a prose
count. Every public operation is available subject to the same native actor,
canvas, rung and validation rules; availability is not permission to bypass
them.

Claim a distinct voice actor through the existing claim path and keep that
actor and a voice client ID in the controller's host-owned context. Do not
accept a model-supplied outer actor, badge or client ID and do not use the
person's ambient `connect()` identity. Canvas mutations carry the voice actor.
Home/identity operations retain their native subject semantics and voice
client provenance; do not invent another identity reducer. The shared badge
still is not a per-actor security boundary.

**Do not use the offline mutation queue for voice.** `web/lib/api.ts` exports
`postOp`, the unqueued core; `sendOp` may queue work for later. Extend/reuse the
unqueued path with explicit voice context and cancellation. A stopped voice
session must not cause a stored write to appear later when the tab reconnects.
Use `PostOpRequest.opId` for operation identity and report an ambiguous lost
response honestly, rather than rerunning an effect under a new ID.

For `trash.empty` and `project.delete`, hold the exact requested operation
until the person confirms the displayed consequence. Reuse the existing
TrashPanel/CLI confirmation semantics and audit other existing confirmation
points, including identity folding. The model cannot confirm itself by a
flag, a second function call or its own output transcript. The first build
uses an explicit person-operated confirmation control; do not claim robust
spoken authorization before it has a separately verified input provenance.
Cancellation, changed target context or Stop dismisses the pending request.
An already-dispatched native operation may still complete: Stop is not undo.

Slow work uses `thread.create`/`thread.reply` and ordinary rc listening policy.
Posting a request is not proof that another agent started work. Preserve the
separate voice actor rather than impersonating the rc owner to trigger it.

## Reuse `packages/voice`; keep the CLI

Bring only the reviewed voice package and necessary workspace wiring from
`5651df9f` onto the fresh upstream lineage. Do not merge its stale branch or
restore its older shared documentation/indexes. Retain its executable CLI,
keyless simulator and real-daemon tests as the headless harness.

Separate Node transport/credential plumbing from browser transport, sharing
the existing lifecycle, tool-call cancellation, declared audio formats,
conversion and setup acknowledgement. Do not bundle Node `ws`, `Buffer`,
filesystem or CLI code into the page. Give the browser an explicit package
entry rather than hoping tree-shaking removes Node-only imports.

Capture with `MediaStream` plus `AudioWorklet`, reading the actual
`AudioContext.sampleRate`. Convert mono PCM16 at the existing adapter boundary;
Gemini input is natively 16 kHz and output 24 kHz. Playback queues must be
cleared on interruption and disconnected on Stop. Keep the linear converter's
prototype-quality limitation visible; byte equality is not a listening-quality
review. Follow the 3.1-specific `realtimeInput.text` behavior and process all
parts of a server event.

One controller owns the stream, audio nodes, socket, pending confirmations,
call IDs and abort generation. No automatic reconnection or resumption of tool
effects in the first cut. Setup failure, permission loss, navigation, page
hiding, expiry and Stop all use the same cleanup path. New provider tokens
require the issuer gate again, not silent client renewal.

## Evidence before implementation is called done

Use a fresh synthetic home/canvas and a controlled browser profile. Provider
and agent-driven real-microphone activation remain prohibited until explicitly
authorized.

- **Step 1 first:** show the actual level meter responding to fake audio,
  record and replay a local clip, and verify that the captured bytes never
  enter a network request. Cover permission denial/dismissal, silent input,
  reset, track cleanup and playback failure. Report the usable local/HTTPS
  check URL and distinguish fake-device evidence from Paul's own mic test.
- Exercise the token route against a local provisioning fixture: disabled
  mode never reads a key; an unattested hosted badge, bad actor, unauthorized
  canvas, hostile Origin/Host, over-limit request and malformed constraints
  fail without provider contact. A valid synthetic attestation is a test
  fixture, not a real user's sign-in. Assert keys/tokens never enter logs.
- Drive the real permission flow using fake media devices, without a global
  auto-grant flag. Capture a native permission prompt in an isolated headed
  browser if headless cannot show it. Record the exact browser/version/flags,
  denial, dismissal and the fallback path. If browser chrome cannot be
  captured, state that evidence gap rather than substituting an app dialog.
- Feed a clearly labelled **spoken-simulated** audio fixture through actual
  capture, worklet, WebSocket and playback paths. The local provider fixture
  emits the known transcript/tool call; it is not speech recognition. Show
  the real daemon operation and visible canvas change, with before/after
  evidence and actor readback. No text-only simulation presented as audio.
- Show setup-ack gating, conversion bytes, duplicate/cancelled calls, a
  destructive request withheld until the person confirms, cancellation with
  no write, and read-only/identity/internal-op refusals. A tool argument
  claiming confirmation must fail to bypass the UI step.
- Exercise Stop, mute, hidden-page cleanup, navigation, expiry and failed
  setup. Assert tracks ended, audio nodes/queued playback released, socket
  closed, presence ended, and no queued write replayed. Preserve the allowed
  already-dispatched-operation race rather than calling Stop a rollback.
- Run the retained CLI real-daemon tests and full repository typecheck/build/
  suite on the final committed tree. Regenerate this branch's roadmap. Obtain
  different-model code/security and browser-evidence review before landing.

Tier 1 human-presence and Tier 2 actor-isolated spend credentials remain
follow-ups. The system-key funding decision and hosted vault integration are
explicit open deployment questions, not reasons to claim the local fake
provider proves a live service. Preserve the existing `text/plain` rejection;
fixture convenience is not permission to weaken it.
