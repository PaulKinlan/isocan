# The voice harness

**11 September 2026.** Paul's ask: *"I just want the UI, and a system that will
send the commands… we need to be invited somehow to the board. Can we add it via
`isocan rc --harness` and it's a 'voice harness' that we create… a slick
interface, have meter levels, let me set the API key needed and ideally it's more
local."*

This is the local, try-it-now half of voice, beside the daemon-minted
product path in [`docs/research/2026-08-24-voice.md`](../../research/2026-08-24-voice.md).
That note's rule holds here without exception: **voice is an input surface over
the vocabulary that already exists.** Every sentence the harness understands
becomes an operation the canvas already had, sent through the same door the CLI
uses, attributed to the actor the microphone was enrolled as.

## The shape

**A harness, not a page with a socket.** `isocan voice --acp` speaks ACP on
stdio — `initialize`, `session/new`, `session/prompt`, `stopReason: "end_turn"`,
the wire `packages/cli/src/acp.ts` was verified against on the real adapters. It
is declared in `~/.isocan/config.json` like any harness isocan has never heard
of:

```json
{"acpAdapters": {"voice": ["node", "/path/to/isocan/packages/cli/bin/isocan.js", "voice", "--acp"]}}
```

Then `isocan rc add <name> --harness voice` enrols it, and the rc's summons
reaches the page instead of being spent on a turn nobody watches: a voice turn
is a summons, not a conversation, and the microphone belongs to a process that
outlives it.

**`isocan voice`** is that process: a page on `127.0.0.1`, the capture, the key,
and the operations. The key is POSTed once over loopback and stored `0600` at
`~/.isocan/voice/key.json`; the page keeps it in a field for one request and
writes it nowhere — no `localStorage`, no cookie (asserted against the page's own
behaviour script in `packages/cli/test/voice-harness.test.ts`). The honest
caveat, stated rather than glossed: the key transits the page once, over
loopback. A browser never talks to a provider.

## What was measured about capture (Chrome 152.0.7977.82)

The ladder is **`<microphone>` → `getUserMedia({audio: true, video: false})`**,
and which rung ran is printed on the page with the browser version beside it —
because "no element" and "no permission" look identical in a screenshot and
mean opposite things.

**`<usermedia>` is deliberately not a rung**, and the page says why. Astra
proved it from Chromium's source and photographed the result:
`html_user_media_element.cc` adds **both** capture descriptors outside legacy
mode, so the element requests camera AND microphone unconditionally and
`setConstraints` changes preferences, not permission descriptors. An audio
feature must not prompt for a camera. (Measured on 152 anyway, for the record:
it exists and is real — `stream`, `error`, `onstream`, `onerror`, `oncancel`,
`setConstraints` — but it refuses styled *"invalid style"*, refuses while the
layout is settling *"recently attached to layout tree, intersection with
viewport changed"*, refuses inside a `position: fixed` dock *"intersection
occluded or distorted"*, and takes a `MediaTrackConstraintSet`, so
`setConstraints({})` rather than `{audio: true}`.)

Since `<microphone>` does not exist on 152, **the JS path is the primary path
and its control is always on the page** — a real button. The first build filled
a slot only when the declarative element was available, which left the person
who mattered with nothing to press.

## The Live API is the path

`BidiGenerateContent` against **`models/gemini-3.1-flash-live-preview`**
(verified current against Google's Live docs on 11 Sep 2026; a preview name
that will move, which is why `--model` exists). The harness opens the socket
and holds the key; the page streams 16 kHz PCM up over loopback and plays the
24 kHz PCM back, so the key still never reaches a page. Tool calls are
**synchronous**, which is the right shape here: a canvas operation is one local
round trip, and the tool list is the fast set — rename, delete, move, say, ask,
comment, read. A slow ask belongs in the Chat, where the parked agents already
listen. The typed grammar remains as the deterministic second path, and
`transcribe()` plus `POST /audio` remain as the one-shot fallback when the live
socket never opens.

**Two things the model proposes and a person disposes of** (13 Sep). A delete
and a change of the agent's own name both stop at a question on the page: the
harness holds the operation, `/confirm` carries the answer, and no answer inside
a minute is a no — a microphone nobody is sitting at is not consent. The gate is
keyed on the OPERATION (`item.delete`, `items.delete`, `actor.claim`), so the
typed path asks the same question the spoken one does, and the log holds
`confirm_requested` / `confirm_allowed` / `confirm_declined` beside the call
that asked. A rename is claimed **in place**, under the session key the harness
already holds: the actor keeps its id, so its comments, its ops and its undo
history stay its own.

**A rename moves a label, never an identity** (13 Sep). The actor is renamed in
place, under the session key it already holds, so its id, its comments and its
undo history stay its own — and the name is written down in four places, every
one of which a person can hear: the registry, canvas state's enrolment record
(what `rc turn <name>`, the agent tray and `isocan who` match on), this
machine's rc roster rows, and the harness's own `voice/identity.json`.

**The key never moves.** `agent:<name at enrolment>` is the conversation a badge
bound the actor to, and the daemon refuses to re-key a live actor — correctly,
since that refusal is what stops a second session unseating a working agent. So
every later start RESUMES (a claim with no name, which is the op's own rule for a
key already worn) and says that the name it was launched with is stale instead of
obeying it; a summons injects the conversation rather than the label. Two callers,
one function: the model's `actor_claim` tool, after the person's gate, and the
settings drawer's `POST /actor`, which is the person's own press — the authority
the gate exists to protect.

**Projects are the session's, not the flag's** (13 Sep). `--canvas` used to fix
a session's canvas for its whole life; `project_list`, `project_create`,
`project_update` and `project_switch` make the canvas something a person can
ask about and move between by voice. A switch mints no operation — it re-resolves
the session's handle, ends its presence on the old canvas and takes it up on the
new one, and tells the page, so what follows the name is the room the agent is
standing in and not a stale copy in a header. The Live session's system
instruction is written once at start and the API has no mid-session system
channel; the switch's answer carries the new canvas's items, ids included, and
that tool result is the honest correction.

**The settings drawer's contract, served** (13 Sep). The page's half was written
against `isocan-xsh.8` and degrades honestly when the harness does not answer —
"this harness build does not offer /actor yet — the command above does it by
hand" — which is how a person came to be told to claim his own name in a
terminal. `POST /actor`, `POST /enrol`, `GET /canvases` and `POST /canvas` are
served now, each routing through the same function its tool counterpart uses, so
a rename, an enrolment or a switch behaves the same whichever surface asked.
`GET /daemons` answers with the one daemon the harness is attached to — and why
that is the only entry — while `POST /daemon` refuses in the harness's own words
and names the remedy (`isocan voice --port <port>`): the daemon is what the
process attached to at START, and telling somebody mid-flight would mean
re-resolving every handle it holds.

**A known residual, machine-local on purpose**: a rename on machine A cannot
reach machine B's rc roster row. That row is a cache of the registry's name and
it lives in a machine-local file (`rc-agents.json`) that by design never
replicates. What holds the line is elsewhere: canvas state's enrolment record —
which every summons reads — moved with the rename, so a stale local row cannot
summon the wrong agent, and machine B's next start RESUMES the binding rather
than asserting the stale name it was launched with. The residual is an untidy
label in a file on a machine nobody has re-enrolled from, and a synced roster is
its own decision rather than a tail on this one.

## What is not built yet

- **The Live session has never run against Google.** No key in the test home
  and no spend authorised, so everything up to the socket is proven and the
  socket itself is not: the setup message, 16 kHz frames, tool→operation→result
  and verbatim provider errors are unit-tested against a fake socket. The first
  real model turn is Paul's.
- **`<microphone>` is unproven** — no browser here has it.
- **A summon has been driven**: `isocan rc turn <name> …` reaches the standing
  page, asserted in the suite (the turn ends `end_turn` and the summons appears
  in the page's own log).
- **The grammar is deliberately small** — rename, delete, move, say, ask,
  comment, and a read that answers "what is on this canvas". It is deterministic
  on purpose: the first build has to be provable with no key and no spend. A
  model that reads freer sentences can sit in front of it and emit the same
  plans; the plan is the contract, not the parser.
- **`item.setCurrentVersion` is not in the grammar yet**, which the research
  note calls the operation most worth saying ("keep the new one").

## Evidence

`node scripts/voice-confirm-evidence.mjs` — the person's gate, clicked in a real
browser, because a question nobody can click is not a gate. It starts the real
verb, types "delete the Checkout screen" into the page's own box, and clicks the
page's own buttons: No leaves the item on the canvas and the oplog without a
delete, Yes takes it off and leaves `item.delete` there, and the harness's /log
reads `confirm_requested, confirm_declined, confirm_requested, confirm_allowed`.
Photographs and the raw record are in `reports/voice-harness/confirm-gate/`.
What it does not cover, and says so: a tool call blocking until the answer (a
fake provider socket in `packages/cli/test/voice-harness.test.ts` drives that)
and the page's canvas label following a switch (a live-session path).

`node scripts/voice-evidence.mjs` — a throwaway home and daemon, the real
`isocan voice` verb, a real Chrome with a synthetic microphone, and photographs.
Its run wrote `reports/voice-harness/evidence.md`: capture fell back to
`getUserMedia` on Chrome 152, the meter peaked at **28/28 bars** over 2.0s of
audio, the typed utterance produced `item.update`, the canvas read
`["Checkout v2", "Settings screen"]`, and the last operation was attributed to
**Voice**, the enrolled agent — not to the person.
