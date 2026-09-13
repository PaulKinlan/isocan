# The confirmation gate — above the microphone, in the window, and answerable

Run 2026-09-13T23:15:24.226Z. The page, driven by the socket frame the harness sends (`{confirm}`) from a stub harness in the script; no key, no canvas.

## Before this change (measured first, the same way)

| window | document grew | the gate's position | above the mic | in the window |
| --- | --- | --- | --- | --- |
| 1440×900 | +28px | top 650 (mic at 153–393) | no | yes |
| 420×900 | +77px | top 681 | no | yes |
| 390×844 | +133px | top 681 | no | yes |
| 844×390 | +125px | top 650 in a 390px window | no | **NO — offscreen** |

Focus landed on `BODY` at every size, so a keyboard user was never told a question had been asked.

## After

| window | gate | microphone | above the mic | in the window | mic visible | page moved | focus |
| --- | --- | --- | --- | --- | --- | --- | --- |
| desktop 1440×900 | top 62px tall | visible | yes | yes | yes | 0px | `confirm-what` |
| narrow portrait 420×900 | top 77px tall | visible | yes | yes | yes | 0px | `confirm-what` |
| phone portrait 390×844 | top 77px tall | visible | yes | yes | yes | 0px | `confirm-what` |
| phone landscape 844×390 | top 62px tall | visible | yes | yes | yes | 0px | `confirm-what` |

Escape meant Deny at every size — the refusal reached the harness as `{ "allow": false }` and the gate closed.

## The two session states the item asks about

- **muted**: the gate came up pressable, and Allow posted {"id":"gate-muted","allow":true}. The session is still live and the harness is still holding the question, so an answerable gate is the correct behaviour — a gate that refused to work while muted would trap the person who muted to think.
- **session ended while the gate was up**: buttons disabled, note "The session has ended, so nothing is waiting for this answer — press Listen and ask again.", and pressing Allow posted nothing at all. Kept on screen (it says what was asked) and unable to post into a socket that is gone.

## Screenshots
- 01-confirm-1440x900-desktop.png — desktop 1440×900, gate above the microphone
- 02-confirm-420x900-narrow-portrait.png — narrow portrait 420×900, gate above the microphone
- 03-confirm-390x844-phone-portrait.png — phone portrait 390×844, gate above the microphone
- 04-confirm-844x390-phone-landscape.png — phone landscape 844×390, gate above the microphone
- 05-confirm-session-ended-420x900.png — the session ended with the gate up: visible, said so, unpressable

## Steps
- session: live (the stub harness holds the socket; no key and no canvas are involved)
- desktop 1440×900: gate 8–70 of a 900px window (62px tall), microphone 153–393 — above the microphone: yes, in the window: yes, microphone visible: yes, the page moved by 0px, focus confirm-what — 01-confirm-1440x900-desktop.png
-   keyboard: Escape posted {"id":"gate-1440","allow":false} and the gate closed: true
- narrow portrait 420×900: gate 8–85 of a 900px window (77px tall), microphone 117–357 — above the microphone: yes, in the window: yes, microphone visible: yes, the page moved by 0px, focus confirm-what — 02-confirm-420x900-narrow-portrait.png
-   keyboard: Escape posted {"id":"gate-420","allow":false} and the gate closed: true
- phone portrait 390×844: gate 8–85 of a 844px window (77px tall), microphone 89–329 — above the microphone: yes, in the window: yes, microphone visible: yes, the page moved by 0px, focus confirm-what — 03-confirm-390x844-phone-portrait.png
-   keyboard: Escape posted {"id":"gate-390","allow":false} and the gate closed: true
- phone landscape 844×390: gate 8–70 of a 390px window (62px tall), microphone 88–328 — above the microphone: yes, in the window: yes, microphone visible: yes, the page moved by 0px, focus confirm-what — 04-confirm-844x390-phone-landscape.png
-   keyboard: Escape posted {"id":"gate-844","allow":false} and the gate closed: true
- muted: gate up with buttons pressable, focus confirm-what; Allow posted {"id":"gate-muted","allow":true} — answerable while muted, which is right: the session is live
- session ended with the gate up: buttons disabled, note "The session has ended, so nothing is waiting for this answer — press Listen and ask again.", Allow posted nothing — 05-confirm-session-ended-420x900.png
