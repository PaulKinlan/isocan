# Voice page screenshots — 2026-09-12, 22:08Z

Fifteen frames of the standalone voice page (`packages/web/voice.html`) taken
by the UI lane while building the compact voice-mode layout. Kept because they
are the **pre-fix record** of a state that existed, and because they are the
artefact of a review that mistook a rigged input for a pass. Read the caption
before treating any of them as current.

## How they were taken

  - Headless Chrome, `--use-fake-device-for-media-stream` with a synthesized
    speech fixture as the microphone, against the **live harness** at
    `127.0.0.1:7654` (real provider, real session) — so `listening`,
    `thinking` and `speaking` are states the page actually reached, not
    attributes set for the picture.
  - The page was served from this branch's own Vite dev server on `:5198`
    (`:5199` had been taken over by another worktree mid-session), working tree
    as it stood just before commit `bf0acf17` on `feat/voice-ui-vite`.
  - The `*drawers*`, `*daemon-row*` and `420-*` frames were taken with **every
    disclosure opened by the screenshot script**, which is not the page's
    default: by default the connection drawer opens itself only while the
    canvas, actor, enrolment or key is missing.

## Why the dark frames are not evidence

**The page cannot go dark on its own.** Dark tokens exist only under
`:root[data-theme="dark"]`, and nothing in the voice page ever sets that
attribute — the theme resolver (`packages/web/src/lib/theme.ts`) is imported by
React components, and the pre-paint script is in the app's `index.html`, which
this page does not load.

The screenshot harness set it by hand (`document.documentElement.dataset.theme
= "dark"`) so the CSS could be photographed. Measured in a real browser with
`prefers-color-scheme: dark` emulated and nothing set by hand, the resolved
ground stays `#fbfbf9` — light. So **the dark frames show what the stylesheet
would look like in dark, not what the page does when the OS asks for dark.**
The dark half of that visual review is therefore not a pass; a check on a rigged
input proves nothing, and this directory is kept as the record of that.

The dark frames are: `1440-dark-idle`, `1440-dark-drawers`,
`1440-dark-daemon-row`, `420-dark-live`.

The fix for the live bug was routed to the lane that owns those files on
2026-09-13. After it lands, dark screenshots must be re-taken with **nothing
written by the harness** — emulated `prefers-color-scheme` only, the page dark
because it *is* dark — and these frames are superseded for that question.

## What the light frames do and do not support

  - They support **layout and geometry**: measured on the light frames only —
    microphone centre offset 0 px, no horizontal overflow, no page scroll at
    both 1440×900 and 420×900, everything above the fold with every drawer open.
  - The contrast pair taken from this set is half a measurement: the light
    off-bar figure (**1.97:1**) was measured against the page as it renders, but
    the dark figure (**2.68:1**) was measured under the manually-set theme, so
    it is the stylesheet's computed value rather than the page's behaviour.
    Re-measure the dark half after the theme fix.

## Frames

| File | State |
| --- | --- |
| `1440-light-idle` | no session; the setup drawer open because the harness's actor is not enrolled |
| `1440-dark-idle` | same, dark — see the caption above |
| `1440-light-idle-restored` | idle after the theme attribute was removed (light again) |
| `1440-light-listening` | a live session, provider accepted, microphone open |
| `1440-light-thinking` | after `heard`, before output: the amber dashed ring |
| `1440-light-speaking`, `-2` | output audio arriving; the waveform reads the model, not the microphone |
| `1440-light-drawers`, `1440-dark-drawers` | every disclosure open, tool log included |
| `1440-light-drawers-connection` | the connection panel open, scrolled to the facts |
| `1440-light-daemon-row`, `1440-dark-daemon-row` | the daemon field and its buttons |
| `420-light-live`, `420-dark-live` | 420×900, live, drawers open |
| `420-light-idle-toggle` | 420×900, drawers closed, the microphone first |
