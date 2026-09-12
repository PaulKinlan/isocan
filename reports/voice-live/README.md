# Voice, driven end to end — 2026-09-12

Three runs where a real Chrome played a locally synthesized utterance into the
capture device and the whole shipped path carried it: the Vite page at `/voice`
(through its committed `/harness` proxy) → `isocan voice` → a real Gemini Live
session with the key at `~/.isocan/voice/key.json` → a tool call → an operation
on a real daemon → the canvas.

`node scripts/voice-live-drive.mjs --speech <wav> --live --out <dir>` is the
whole run; `--probe` is the same page and capture with no key and no provider,
measuring only what the page puts on the wire.

## mutation — a spoken command becomes an operation

`01-ready.png`, `02-tool-call.png`, `evidence.json`, `evidence.md`,
`canvas-after.json`

Utterance: *"Add a note titled Banana, with the text hello world."* (eSpeak-NG,
en-gb, 140 wpm, 3 s lead-in, synthesized on this machine, no cloud TTS.)

- turn boundary: `turn_complete` from the provider, 2026-09-12T21:53:33.384Z
- tool call: `add_item {"text":"buy milk"}` → `item.add` → daemon acknowledged
- canvas: `Alpha note, Beta note, New note` (was two items)
- oplog: **seq 4 `item.add` as Voice**

The model mis-heard the text (`buy milk`) — the *link* is what this run proves,
not the transcription. See "what the provider did not hear" below.

## read-question — the model answers from live canvas state

`01-ready.png`, `02-tool-call.png`, `evidence.json`, `evidence.md`,
`canvas-after.json`

Utterance: *"Read the canvas and tell me how many items it contains."*

- turn boundary: `turn_complete`, 2026-09-12T21:53:54.337Z
- tool call: `read_canvas {}` → `"2 things here: Alpha note [itm_alpha]; Beta note [itm_beta]."`
- no operation minted, because a read is not an operation

## gemini-only-check — the same path after OpenAI was removed

`01-ready.png`, `02-tool-call.png`, `evidence.json`, `evidence.md`,
`canvas-after.json`

Run on the commit that made the voice agent Gemini-only, to answer "does the
Gemini path still work end to end" with a run rather than a suite:

- key: the provider accepted it (one cheap authenticated call, `/key/test`)
- session: `setup_complete`, audio in, audio out, `turn_complete`
- tool call: `add_item {"title":"Greeting","text":"hello world"}` → `item.add` → acknowledged
- canvas: `Alpha note, Beta note, Greeting`; oplog **seq 4 `item.add` as Voice**

## What the page sends, measured before the provider

From the probe (no key, no provider), on the same fixture:

- whole capture: 14.0 s at 16 kHz, zero-sample fraction 0.816, RMS 0.056
- the speech window (2.0–5.5 s): zero-sample fraction 0.265, **RMS 0.112**
- continuity: worst inter-frame gap 29 ms, audio-vs-wall-clock within 0.05 %

The resampler fix (6d98af1a) is what these numbers are about: the old one put
98 % zeros on this wire at a 44.1 kHz context. Independent check of the same
recorded PCM through a batch model (`gemini-2.5-flash`, transcribe) came back
*"Arden note says hello from the voice harness."* — near-perfect, which is how
we know the capture chain is not the thing mis-hearing.

## What the provider did not hear — a finding

Five `--live` runs with good audio: **three produced a model response and two
produced nothing at all.** In the two silent ones the provider accepted the
session, sent `setupComplete` and then only `sessionResumptionUpdate` for the
whole run — no `voiceActivity`, no transcription, no turn, no error — while the
client sent 34,020 audio frames (90.8 s of audio in 90.7 s of wall clock, no
gap over 30 ms) including speech measured at RMS 0.149. The same fixture then
worked on the next attempt.

That is the silent-turn family with a wire-level record: the provider can take
a continuous, correctly-levelled stream and process none of it, without saying
so. A client cannot tell that apart from a model that heard nothing, which is
why `turn_complete` and the refused-call lines in `/log` matter more than frame
counters.

The raw provider wires for those two runs are not kept here (they are 3 MB of
mostly base64); every `--live` run writes `provider-wire.jsonl` and
`page-input.s16` into its own `--out` directory, so the record is one run away.
