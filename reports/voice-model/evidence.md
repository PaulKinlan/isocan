# The model: chosen, typed, and refused — against the real provider

Run 2026-09-13T22:29:58.779Z. The shipped harness (`isocan voice`) in a throwaway home, with a 0600 copy of the machine's key.

## What the provider's list actually is (measured, not assumed)

- the provider lists 55 models, 7 of them Live
- the Live ones, by the provider's own `bidiGenerateContent` method: `gemini-3.5-transcribe-live`, `gemini-2.5-flash-native-audio-latest`, `gemini-2.5-flash-native-audio-preview-09-2025`, `gemini-2.5-flash-native-audio-preview-12-2025`, `gemini-3.1-flash-live-preview`, `gemini-robotics-er-2-streaming-preview`, `gemini-3.5-live-translate-preview`
- so `live` in the page is read from the provider's method list, not from a list this repo keeps — and the free-text field stays, because a beta name is exactly what that list will not carry.

## Turns held

| model | outcome | audio back |
| --- | --- | --- |
| `models/gemini-3.1-flash-live-preview` (the harness's own model) | turn complete | 32670 bytes |
| `models/gemini-2.5-flash-native-audio-latest` (after `POST /model`) | turn complete | 34560 bytes |
| `models/gemini-3.1-flash-live-preview` again (after switching back) | turn complete | 36990 bytes |

## The refusals, verbatim

| what was typed | the provider's own words | what the provider cannot say |
| --- | --- | --- |
| a name that does not exist | "1008 — models/gemini-9.9-does-not-exist is not found for API version v1beta, or is not supported for bidiGenerateContent. Call Mod" | "no model by this name is in the provider's list, so this was tried anyway and the provider refused it — a beta model you have access to would be here too, which is why the field exists. Its exact name is what matters." |
| a text-only model | "1008 — models/gemini-2.5-flash is not found for API version v1beta, or is not supported for bidiGenerateContent. Call ModelService" | "models/gemini-2.5-flash is a real model, but not a Live one: Live needs a model that takes audio in and sends audio back (bidiGenerateContent), and this one offers generateContent, countTokens, createCachedContent, batchGenerateContent. A text-only model name is the easiest mistake to make in that field." |
| a Live TRANSCRIBE model | "1007 — The requested combination of response modalities (AUDIO) is not supported by the model. models/gemini-3.5-transcribe-live a" | "models/gemini-3.5-transcribe-live is a Live model, but not a conversational one: the provider accepted the setup and then refused the response modality — this one does not send AUDIO back. Transcription and translation models are Live and are not a voice to talk with; the conversation needs a model that takes audio in AND answers in audio." |
| a name that is not shaped like one | "“gemini 2.5 flash!” is not shaped like a Gemini model name — a name is letters, digits, dots, dashes and underscores, optionally after “models/”. (Checked here, not at the provider: nothing was sent.)" | refused before anything was sent |

The first two answers are the same sentence from the provider — which is why the list is fetched and the difference is stated by the harness.

## Persistence

- the page's fact before a reload: "gemini-3.1-flash-live-preview"
- after a page reload: "gemini-2.5-flash-native-audio-latest"
- after a harness restart: `models/gemini-2.5-flash-native-audio-latest` (source `stored`)

## Steps
- harness: `isocan voice` on http://127.0.0.1:8463/ (throwaway home, the machine's key copied in 0600, daemon 39123)
- list: the provider lists 55 models, 7 of them Live
- list: the Live models the provider names — gemini-3.5-transcribe-live (Gemini 3.5 Transcribe Live); gemini-2.5-flash-native-audio-latest (Gemini 2.5 Flash Native Audio Latest); gemini-2.5-flash-native-audio-preview-09-2025 (Gemini 2.5 Flash Native Audio Preview 09-2025); gemini-2.5-flash-native-audio-preview-12-2025 (Gemini 2.5 Flash Native Audio Preview 12-2025); gemini-3.1-flash-live-preview (Gemini 3.1 Flash Live Preview); gemini-robotics-er-2-streaming-preview (Gemini Robotics-ER 2 Streaming Preview); gemini-3.5-live-translate-preview (Gemini 3.5 Live Translate Preview)
- chosen: the harness is on models/gemini-3.1-flash-live-preview; a second Live model available is models/gemini-2.5-flash-native-audio-latest
- turn on models/gemini-3.1-flash-live-preview: turn complete — 32670 bytes of audio back, setupComplete: true
- switch: POST /model → {"ok":true,"model":"models/gemini-2.5-flash-native-audio-latest","source":"stored","appliesTo":"now"}; the harness now reports model models/gemini-2.5-flash-native-audio-latest (source stored)
- turn on models/gemini-2.5-flash-native-audio-latest: turn complete — 34560 bytes of audio back, setupComplete: true
- switch back: POST /model → {"ok":true,"model":"models/gemini-3.1-flash-live-preview","source":"stored","appliesTo":"now"}
- turn on models/gemini-3.1-flash-live-preview again: turn complete — 36990 bytes of audio back
- refusal (a name that does not exist): "1008 — models/gemini-9.9-does-not-exist is not found for API version v1beta, or is not supported for bidiGenerateContent. Call Mod"
-   …and the part the provider cannot say: "no model by this name is in the provider's list, so this was tried anyway and the provider refused it — a beta model you have access to would be here too, which is why the field exists. Its exact name is what matters."
- refusal (a text-only model): "1008 — models/gemini-2.5-flash is not found for API version v1beta, or is not supported for bidiGenerateContent. Call ModelService"
-   …and the part the provider cannot say: "models/gemini-2.5-flash is a real model, but not a Live one: Live needs a model that takes audio in and sends audio back (bidiGenerateContent), and this one offers generateContent, countTokens, createCachedContent, batchGenerateContent. A text-only model name is the easiest mistake to make in that field."
- refusal (a Live TRANSCRIBE model, models/gemini-3.5-transcribe-live): "1007 — The requested combination of response modalities (AUDIO) is not supported by the model. models/gemini-3.5-transcribe-live a"
-   …and the part the provider cannot say: "models/gemini-3.5-transcribe-live is a Live model, but not a conversational one: the provider accepted the setup and then refused the response modality — this one does not send AUDIO back. Transcription and translation models are Live and are not a voice to talk with; the conversation needs a model that takes audio in AND answers in audio."
- refusal (a name that is not shaped like one, refused HERE): "“gemini 2.5 flash!” is not shaped like a Gemini model name — a name is letters, digits, dots, dashes and underscores, optionally after “models/”. (Checked here, not at the provider: nothing was sent.)"
- the harness's own session: {"ok":true,"state":"live"}, the provider completed its setup and /state reports modelLive "models/gemini-3.1-flash-live-preview" (the harness's log line said: "23:29:55  voice opening a live session on models/gemini-3.1-flash-live-preview (stored)")
- page: the facts say "gemini-3.1-flash-live-preview"
- page: the panel lists 55 models, e.g. models/gemini-3.5-transcribe-live, models/gemini-2.5-flash-native-audio-latest, models/gemini-2.5-flash-native-audio-preview-09-2025
- page: choosing models/gemini-2.5-flash-native-audio-latest said "models/gemini-2.5-flash-native-audio-latest stored — the next session uses it"
- page: after a reload the facts say "gemini-2.5-flash-native-audio-latest"
- page: the panel photographed at 606×333 (a clipped shot: the dialog scrolls, and a full-window one showed the top of it)
- restart: the harness was on models/gemini-2.5-flash-native-audio-latest (stored); after a restart /state reports models/gemini-2.5-flash-native-audio-latest (source stored)

## Screenshots
- 01-model-panel-1440.png — the model panel, with the provider's list in it
