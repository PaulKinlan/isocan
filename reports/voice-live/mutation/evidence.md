# Voice, live — 2026-09-12T21:53:35.217Z

A real Chrome, playing a synthesized utterance through the capture device,
drove the real Vite page (`/voice`, through its committed `/harness` proxy),
the real `isocan voice` harness, a real Gemini Live session with the key at
`~/.isocan/voice/key.json`, and a real daemon on a throwaway home.

- browser: undefined
- page: /tmp/voice-ui-pin @ 
- speech: speech.wav (0d95cccadd6f…), synthesized locally, no cloud TTS
- audio the page sent: 2272 frames, 6.1s at 16 kHz, zero-sample fraction 0.59077, RMS 0.0850
- turn boundary: 2026-09-12T21:53:33.384Z
- tool call: `add_item {"text":"buy milk"}`
- operation: item.add — add "New note"
- canvas after: Alpha note, Beta note, New note
- canvas before: Alpha note, Beta note
- oplog as Voice: seq 4 item.add

## Steps

- daemon: real, on a temp home, canvas “Voice drive” (prj_voice_drive) with 2 items
- key: stored in the run's home from ~/.isocan/voice/key.json (mode 0600, value never printed)
- harness: real `isocan voice`, listening at http://127.0.0.1:7639/
- key: the provider accepted it (one cheap authenticated call)
- page: real Vite page at http://127.0.0.1:5367/voice (/tmp/voice-ui-pin @ )
- browser: chrome — fake capture device playing speech.wav
- listen: pressed the page's Listen button
- live: session open (setup_complete at 2026-09-12T21:53:28.106Z), listening while the WAV plays
- turn: the provider closed a turn at 2026-09-12T21:53:33.384Z
- tool call: add_item {"text":"buy milk"} -> item.add: add "New note"
- daemon: acknowledged
- canvas: 3 items now — Alpha note, Beta note, New note
- oplog: 1 op(s) as Voice this run — seq 4 item.add
