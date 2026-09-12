# Voice, live — 2026-09-12T21:53:56.299Z

A real Chrome, playing a synthesized utterance through the capture device,
drove the real Vite page (`/voice`, through its committed `/harness` proxy),
the real `isocan voice` harness, a real Gemini Live session with the key at
`~/.isocan/voice/key.json`, and a real daemon on a throwaway home.

- browser: undefined
- page: /tmp/voice-ui-pin @ 
- speech: speech-fixture.wav (a824efe1e5fb…), synthesized locally, no cloud TTS
- audio the page sent: 3960 frames, 10.6s at 16 kHz, zero-sample fraction 0.77269, RMS 0.0732
- turn boundary: 2026-09-12T21:53:54.337Z
- tool call: `read_canvas {}`
- operation: none minted
- canvas after: Alpha note, Beta note
- canvas before: Alpha note, Beta note
- oplog as Voice: none

## Steps

- daemon: real, on a temp home, canvas “Voice drive” (prj_voice_drive) with 2 items
- key: stored in the run's home from ~/.isocan/voice/key.json (mode 0600, value never printed)
- harness: real `isocan voice`, listening at http://127.0.0.1:7815/
- key: the provider accepted it (one cheap authenticated call)
- page: real Vite page at http://127.0.0.1:5351/voice (/tmp/voice-ui-pin @ )
- browser: chrome — fake capture device playing speech-fixture.wav
- listen: pressed the page's Listen button
- live: session open (setup_complete at 2026-09-12T21:53:44.537Z), listening while the WAV plays
- turn: the provider closed a turn at 2026-09-12T21:53:54.337Z
- tool call: read_canvas {} -> no operation
- daemon: acknowledged
- canvas: 2 items now — Alpha note, Beta note
- oplog: 0 op(s) as Voice this run — none
