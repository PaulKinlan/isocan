# Voice settings — the theme choice, browser evidence

Run 2026-09-14T12:18:50.855Z in 20.8s, by the same script that
drives the help cards (`scripts/voice-settings-evidence.mjs`): same dialog, same page, same real browser.

- browser: Chrome/152.0.0.0
- three states, each selected by a real click on its label: (nothing chosen) → radio "system", page light; dark → radio "dark", page dark; light → radio "light", page light; system → radio "system", page light
- what the row said: (nothing chosen): "Following your device: light right now."; dark: "Pinned to dark."; light: "Pinned to light."; system: "Following your device: light right now."
- the device flipped to dark under Use system: page dark, row "Following your device: dark right now.", the same page instance (no reload)
- pinned to dark with the device on light: page dark, row "Pinned to dark."
- after a reload: page dark, radio "dark", row "Pinned to dark."
- keyboard: ArrowRight from "dark" chose "system" (page light), Space chose "system" (page light)
- at 420: the panel 42..378 inside the dialog 17..403, choices [[42,102,44],[118,177,44],[193,298,44]], radios [[20,20],[20,20],[20,20]], "?" 44x44, document 420px of 420px
- at 420, the row's help card: anchored-below at [38,452,378,609], inside the viewport: true
- theme page errors: none

## Steps
- theme: (nothing chosen) → radio "system", page light, row says "Following your device: light right now."
- theme: dark → radio "dark", page dark, row says "Pinned to dark."
- theme: light → radio "light", page light, row says "Pinned to light."
- theme: system → radio "system", page light, row says "Following your device: light right now."
- theme: the device flips to dark under Use system → page dark, row says "Following your device: dark right now." (the same page instance: no reload)
- theme: pinned to dark with the device on light → page dark, row says "Pinned to dark."; after a reload: page dark, radio "dark", row says "Pinned to dark."
- theme by keyboard: ArrowRight from "dark" moved the choice to "system" and the page to light; Space then selected "system" with the page light
- theme at 420: the panel spans 42..378 inside the dialog's 17..403; the choices are [left, right, height] [[42,102,44],[118,177,44],[193,298,44]] (44px targets); the radios are [w, h] [[20,20],[20,20],[20,20]]; the "?" is 44x44 at 334..378; document 420px of 420px
- theme at 420: its help card landed anchored-below at [38,452,378,609], inside the viewport: true

## Screenshots
- 01-theme-dark.png — the theme row with that choice made
- 02-theme-light.png — the theme row with that choice made
- 03-theme-system.png — the theme row with that choice made
- 04-theme-420-with-help.png — the same row at 420 with its "?" card open
