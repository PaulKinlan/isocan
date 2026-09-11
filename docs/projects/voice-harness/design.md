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

The microphone ladder is `<microphone>`, then `<usermedia>`, then
`getUserMedia`, and which rung ran is printed on the page with the browser
version beside it — because "no element" and "no permission" look identical in a
screenshot and mean opposite things. What the rungs actually do here:

| | |
| --- | --- |
| `HTMLMicrophoneElement` | **undefined** on 152 |
| `HTMLUserMediaElement` | **a function**, and a real element: `stream`, `error`, `onstream`, `onerror`, `oncancel`, `setConstraints` |
| `setConstraints` | takes a **`MediaTrackConstraintSet`** — `{}` is accepted, `{audio: true}` throws "Value is not of type MediaTrackConstraintSet" |
| What it needs | no custom styling (a styled one fails `InvalidStateError: The permission element is disabled due to: invalid style`), a stable layout (armed while the page was still laying out: *"recently attached to layout tree, intersection with viewport changed"*), and a **real user gesture on the element** — a click on another button is not it |
| In a `position: fixed` dock | fails `InvalidStateError: … intersection occluded or distorted`. In normal flow the same element delivers a stream |

So in this build the element is **armed and tried, refuses in the page's own
layout, and the page falls back to `getUserMedia` inside the same gesture** —
and says so on the face of it. That is the honest reading of 152: present,
plausibly useful, not yet load-bearing. When a browser ships a `<microphone>`
that works, the ladder prefers it with no code change, and the page will say
which one ran.

## What is not built yet

- **The provider path has not been driven with a real key.** Transcription
  (`transcribe()`) is implemented for Gemini (inline `audio/wav`) and OpenAI
  (`/v1/audio/transcriptions`), and the harness falls back to saying it has no
  key rather than failing silently — but no spend was authorised, so it is
  unit-tested, not measured.
- **A real summon has not been driven end to end.** The ACP face answers the
  wire, unit-tested; `isocan rc turn <name> …` against a live enrolled voice
  agent is the next thing to run.
- **The grammar is deliberately small** — rename, delete, move, say, ask,
  comment, and a read that answers "what is on this canvas". It is deterministic
  on purpose: the first build has to be provable with no key and no spend. A
  model that reads freer sentences can sit in front of it and emit the same
  plans; the plan is the contract, not the parser.
- **`item.setCurrentVersion` is not in the grammar yet**, which the research
  note calls the operation most worth saying ("keep the new one").

## Evidence

`node scripts/voice-evidence.mjs` — a throwaway home and daemon, the real
`isocan voice` verb, a real Chrome with a synthetic microphone, and photographs.
Its run wrote `reports/voice-harness/evidence.md`: capture fell back to
`getUserMedia` on Chrome 152, the meter peaked at **28/28 bars** over 2.0s of
audio, the typed utterance produced `item.update`, the canvas read
`["Checkout v2", "Settings screen"]`, and the last operation was attributed to
**Voice**, the enrolled agent — not to the person.
