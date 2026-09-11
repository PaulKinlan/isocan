# Voice harness — browser evidence

Run 2026-09-11T23:07:29.794Z in 3.546s.

- browser: HeadlessChrome 152.0.0.0
- connected to: canvas “Voice evidence” (prj_voice), daemon http://127.0.0.1:43729, home no home configured — the daemon's default
- agent: Voice (usr_iWNMgM-J84), NOT enrolled
- audio: no provider models/gemini-3.1-flash-live-preview (no key stored)
- capture path that ran: capture: getUserMedia, audio only · HeadlessChrome 152.0.0.0
- meter peak: 28/28 bars (sampled every 25ms for 1.5s; the screenshot was taken at the peak sample, so the picture and the number are the same moment)
- held-peak marker: present
- bars lit immediately after the shutter closed: 11/28 (the level meter has a slow release on purpose; the held-peak marker is what survives a quiet moment)
- layout at 1440: viewport 1440px, document width 1440px, key panel right edge 1414px, panels clipped off-window: 0
- layout at 420: document 420px in a 420px window, panels clipped: 0, overlapping pairs: none
- utterance: “retitle the checkout screen to Checkout v2”
- operations sent: renamed “Checkout screen” (itm_checko)
- canvas titles after: ["Checkout v2","Settings screen"]
- last operation: item.update by “Voice”

## Steps
- harness: `isocan voice` listening at http://127.0.0.1:7710/ (daemon on 43729, home isocan-voice-evidence-ZXOKqd)
- connected to: canvas “Voice evidence” prj_voice · daemon http://127.0.0.1:43729 · home no home configured — the daemon's default · agent Voice usr_iWNMgM-J84 (not enrolled) · audio no provider models/gemini-3.1-flash-live-preview, no key
- page: painted — HeadlessChrome 152.0.0.0; capture: getUserMedia, audio only · HeadlessChrome 152.0.0.0
- layout: viewport 1440px, document 1440px, key panel right edge 1414px, panels clipped off-window: 0
- capture: capture: getUserMedia, audio only · HeadlessChrome 152.0.0.0
- meter: peak 28/28 bars, photographed at that moment (/home/paulkinlan/worktrees/isocan-voice-harness/reports/voice-harness/01-meter-live.png); held-peak marker present: 1
- stop: listening stopped — 1.8s of audio | live session open — the harness holds the key and the socket
- utterance: “retitle the checkout screen to Checkout v2”
- sent: renamed “Checkout screen” (itm_checko)
- reply: renamed “Checkout screen” (itm_checko)
- narrow 420px overlaps: none
- narrow 420px: columns minmax(0px, 1fr) minmax(0px, 320px), document 420px, aside 392px (right edge 406px), panels clipped: 0 — /home/paulkinlan/worktrees/isocan-voice-harness/reports/voice-harness/04-narrow-420.png
- canvas: titles now ["Checkout v2","Settings screen"]
- canvas: last op item.update by Voice (usr_iWNMgM-J84), the enrolled agent

## Screenshots
- 01-meter-live.png — capture running, meter at its peak (/home/paulkinlan/worktrees/isocan-voice-harness/reports/voice-harness/01-meter-live.png)
- 02-no-key-stated.png — the stop, with the harness saying it has no key (/home/paulkinlan/worktrees/isocan-voice-harness/reports/voice-harness/02-no-key-stated.png)
- 03-operation-sent.png — the operation in the log beside the canvas it changed (/home/paulkinlan/worktrees/isocan-voice-harness/reports/voice-harness/03-operation-sent.png)
- 04-narrow-420.png — the same page at 420px: 420px of document in a 420px window, 0 panels clipped (/home/paulkinlan/worktrees/isocan-voice-harness/reports/voice-harness/04-narrow-420.png)
