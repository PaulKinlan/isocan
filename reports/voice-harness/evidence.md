# Voice harness — browser evidence

Run 2026-09-11T22:39:49.428Z in 3.137s.

- browser: HeadlessChrome 152.0.0.0
- capture path that ran: capturing — getUserMedia · HeadlessChrome 152.0.0.0
- meter peak: 28/28 bars
- utterance: “retitle the checkout screen to Checkout v2”
- operations sent: renamed “Checkout screen” (itm_checko)
- canvas titles after: ["Checkout v2","Settings screen"]
- last operation: item.update by “Voice”

## Steps
- harness: `isocan voice` listening at http://127.0.0.1:7816/ (daemon on 39331, home isocan-voice-evidence-7Wx8lA)
- page: painted — HeadlessChrome 152.0.0.0; capture path: <usermedia> · HeadlessChrome 152.0.0.0
- capture: capturing — getUserMedia · HeadlessChrome 152.0.0.0
- meter: peak 28/28 bars lit while capture ran — /home/paulkinlan/worktrees/isocan-voice-harness/reports/voice-harness/01-meter-live.png
- stop: listening stopped — 2.0s of audio
- utterance: “retitle the checkout screen to Checkout v2”
- sent: renamed “Checkout screen” (itm_checko)
- reply: renamed “Checkout screen” (itm_checko)
- canvas: titles now ["Checkout v2","Settings screen"]
- canvas: last op item.update by Voice (usr_0PdjMwgwh4), the enrolled agent

## Screenshots
- 01-meter-live.png — capture running, meter lit (/home/paulkinlan/worktrees/isocan-voice-harness/reports/voice-harness/01-meter-live.png)
- 02-no-key-stated.png — the stop, with the harness saying it has no key (/home/paulkinlan/worktrees/isocan-voice-harness/reports/voice-harness/02-no-key-stated.png)
- 03-operation-sent.png — the operation in the log beside the canvas it changed (/home/paulkinlan/worktrees/isocan-voice-harness/reports/voice-harness/03-operation-sent.png)
