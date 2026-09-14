# Voice settings — the "?" help, browser evidence

Run 2026-09-14T12:18:50.856Z in 20.8s.

- browser: Chrome/152.0.0.0
- platform: popover yes, invoker commands yes, anchor positioning yes, position-try yes, closedby yes, interest invokers yes
- `popover="hint"`: understood
- one at a time: 1 card open before a second glyph was pressed, ["help-daemon"] after
- reflow: row [631,751,429,615] → [631,751,429,615]; dialog scroll height 1917 → 1917
- keyboard: "daemon-field" → Tab → {"id":"daemon-use","label":null,"text":"Use this daemon"}, on the glyph "About the daemon": Enter opened ["help-daemon"], Space opened ["help-home"], Escape left [] open with the dialog still open and focus on "About home"
- screen reader: control "daemon address" → "The daemon this harness attaches to — normally the one on this machine. Point it somewhere else only when the harness runs elsewhere; a daemon that does not answer is why a session refuses to start."
- screen reader: glyph "About the daemon" → "The daemon this harness attaches to — normally the one on this machine. Point it somewhere else only when the harness runs elsewhere; a daemon that does not answer is why a session refuses to start."
- screen reader: heading "KEY"
- reduced motion: transition 0s, animation none
- touch at 420: tap opened []
- screenshots: each one taken with its card open and painted at its own centre
- cards whose open state or centre is not what the numbers describe: 0
- dialog closed by a card interaction: 2 times
- page errors: none

## Every card, by width
- 1440: help-canvas landed anchored-below at [483,277,823,378], glyph [483,233,527,277], dialog [400,16,1040,877], inside the viewport: true
- 1440: help-daemon landed anchored-below at [688,292,1028,413], glyph [688,248,732,292], dialog [400,16,1040,877], inside the viewport: true
- 1440: help-home landed anchored-below at [872,317,1212,438], glyph [872,273,916,317], dialog [400,16,1040,877], inside the viewport: true
- 1440: help-actor landed anchored-below at [474,469,814,589], glyph [474,425,518,469], dialog [400,16,1040,877], inside the viewport: true
- 1440: help-audio landed anchored-below at [875,469,1215,608], glyph [875,425,919,469], dialog [400,16,1040,877], inside the viewport: true
- 1440: help-version landed anchored-below at [486,468,826,569], glyph [486,424,530,468], dialog [400,16,1040,877], inside the viewport: true
- 1440: help-localfiles landed anchored-below at [714,468,1054,588], glyph [714,424,758,468], dialog [400,16,1040,877], inside the viewport: true
- 1440: help-microphone landed anchored-below at [922,468,1262,588], glyph [922,424,966,468], dialog [400,16,1040,877], inside the viewport: true
- 1440: help-key landed anchored-below at [971,469,1311,608], glyph [971,425,1015,469], dialog [400,16,1040,877], inside the viewport: true
- 1440: help-theme landed anchored-below at [971,468,1311,626], glyph [971,424,1015,468], dialog [400,16,1040,877], inside the viewport: true
- 420 light: help-canvas landed flush-below at [16,296,356,397], glyph [100,252,144,296], dialog [17,16,403,844], inside the viewport: true
- 420 light: help-daemon landed flush-below at [16,452,356,572], glyph [103,408,147,452], dialog [17,16,403,844], inside the viewport: true
- 420 light: help-home landed flush-below at [16,452,356,572], glyph [85,408,129,452], dialog [17,16,403,844], inside the viewport: true
- 420 light: help-actor landed flush-below at [16,452,356,572], glyph [91,408,135,452], dialog [17,16,403,844], inside the viewport: true
- 420 light: help-audio landed flush-below at [16,452,356,591], glyph [88,408,132,452], dialog [17,16,403,844], inside the viewport: true
- 420 light: help-version landed flush-below at [16,452,356,553], glyph [103,408,147,452], dialog [17,16,403,844], inside the viewport: true
- 420 light: help-localfiles landed flush-below at [16,452,356,572], glyph [129,408,173,452], dialog [17,16,403,844], inside the viewport: true
- 420 light: help-microphone landed flush-below at [16,452,356,572], glyph [135,408,179,452], dialog [17,16,403,844], inside the viewport: true
- 420 light: help-key landed anchored-below at [38,452,378,591], glyph [334,408,378,452], dialog [17,16,403,844], inside the viewport: true
- 420 light: help-theme landed anchored-below at [38,452,378,609], glyph [334,408,378,452], dialog [17,16,403,844], inside the viewport: true
- 420 dark: help-canvas landed flush-below at [16,296,356,397], inside the viewport: true
- 420 dark: help-daemon landed flush-below at [16,452,356,572], inside the viewport: true
- 420 dark: help-home landed flush-below at [16,452,356,572], inside the viewport: true
- 420 dark: help-actor landed flush-below at [16,452,356,572], inside the viewport: true
- 420 dark: help-audio landed flush-below at [16,452,356,591], inside the viewport: true
- 420 dark: help-version landed flush-below at [16,452,356,553], inside the viewport: true
- 420 dark: help-localfiles landed flush-below at [16,452,356,572], inside the viewport: true
- 420 dark: help-microphone landed flush-below at [16,452,356,572], inside the viewport: true
- 420 dark: help-key landed anchored-below at [38,452,378,591], inside the viewport: true
- 420 dark: help-theme landed anchored-below at [38,452,378,609], inside the viewport: true

## Steps
- page: a throwaway vite on 5430, pointed at a stub harness on 41603 (5173 and 7654 untouched)
- browser: Chrome/152.0.0.0; popover yes, invoker commands yes, anchor positioning yes, position-try yes, closedby yes, interest invokers yes
- popover="hint" in this browser: understood; the platform closes other hints, dismisses on an outside press and takes Escape
- dialog: opened from the cog; 10 help glyphs in it
- closed cards: all 10 hidden by the platform
- 1440 light: 10 cards, positions ["canvas=anchored-below","daemon=anchored-below","home=anchored-below","actor=anchored-below","audio=anchored-below","version=anchored-below","localfiles=anchored-below","microphone=anchored-below","key=anchored-below","theme=anchored-below"], never opened none, off-screen none, past the dialog's inline box ["help-home 872..1212 in 400..1040","help-audio 875..1215 in 400..1040","help-localfiles 714..1054 in 400..1040","help-microphone 922..1262 in 400..1040","help-key 971..1311 in 400..1040","help-theme 971..1311 in 400..1040"], document wider than the window: no
- reflow: the row is [631,751,429,615] before and [631,751,429,615] after the card opens (unmoved); the dialog scrolls 1917px of content either way (unchanged)
- two at once: 1 open before the second press, ["help-daemon"] after it — the rule is one
- hover: 120ms after the pointer arrives, 0 open (the delay is deliberate: sweeping across the dialog must not open nine cards); after 520ms, ["help-actor"]; 400ms after the pointer leaves, 0
- hover then Escape: 400ms after the key (the hover timer's own delay is 300ms), [] open
- keyboard: focus was on "daemon-field", Tab moved it to {"id":"daemon-use","label":null,"text":"Use this daemon"}; on the glyph "About the daemon", Enter opened ["help-daemon"], Space opened ["help-home"]; Escape left [] open, the dialog still open, focus "About home"
- reduced motion: a card under prefers-reduced-motion has transition 0s and animation none
- screen reader, the control: #daemon-field is "textbox" named "daemon address", described "The daemon this harness attaches to — normally the one on this machine. Point it somewhere"…
- screen reader, the glyph: "About the daemon" (button), described "The daemon this harness attaches to — normally the one on this machine. Point it somewhere"…
- screen reader, the key panel's heading: "KEY" (heading)
- 1440 dark: the page came back with data-theme="dark" and the card is the same size in it
- 420 dark: 10 cards, positions ["canvas=flush-below","daemon=flush-below","home=flush-below","actor=flush-below","audio=flush-below","version=flush-below","localfiles=flush-below","microphone=flush-below","key=anchored-below","theme=anchored-below"], never opened none, off-screen none, past the dialog's inline box none, document wider than the window: no
- 420 light: 10 cards, positions ["canvas=flush-below","daemon=flush-below","home=flush-below","actor=flush-below","audio=flush-below","version=flush-below","localfiles=flush-below","microphone=flush-below","key=anchored-below","theme=anchored-below"], never opened none, off-screen none, past the dialog's inline box none, document wider than the window: no
- 420: the card that reached furthest right ended at 378px of 420px (anchored-below, inside the viewport: true; document 420px wide)
- 420x320: 10 cards, positions ["canvas=flush-below","daemon=flush-below","home=flush-below","actor=flush-below","audio=sheet","version=flush-below","localfiles=flush-below","microphone=flush-below","key=sheet","theme=sheet"], never opened none, off-screen none, past the dialog's inline box none, document wider than the window: no
- short window: the cards that became sheets ["help-audio","help-key","help-theme"], off-screen []
- touch at 420: a tap opened [] — the whole path for a phone, where nothing hovers

## Screenshots
- 01-wide-light.png — 1440 light, the microphone card open
- 05-two-at-once.png — a second glyph pressed while the first card was open
- 02-wide-dark.png — 1440 dark
- 03-narrow-light.png — 420 light
- 04-narrow-dark.png — 420 dark
