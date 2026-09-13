# Voice device selectors — browser evidence

Run 2026-09-13T22:09:45.493Z in a real Chrome Chrome/152.0.0.0, on two null sinks planted in the machine's own audio stack.

The claim this file exists for: **a non-default output received the reply, and a control output did not.**

| wire | silence before | tone while chosen |
| --- | --- | --- |
| IsocanEvidenceA (the chosen device) | 0 | 16384 |
| IsocanEvidenceB (control) | 0 | 0 |

Peaks are int16 samples off each sink's own monitor port (`parec`), so a number over zero is audio that device actually produced. The machine's own default sink is NOT used as a third wire: its monitor carries whatever else the machine is playing (a first run of this script read 18302 there while the tone was meant to be elsewhere, and the sound was somebody's music), so where the reply goes is read from PulseAudio's own stream attribution instead:

- while IsocanEvidenceA was chosen: PulseAudio rendered Chrome's audio for the page on sink 40034 (isocan_evidence_a)
- setSinkId is per AudioContext (measured): the capture context stays on the system default while the playback context is routed, so only the reply moves
- after the device was unplugged: the same browser (pid 2159216, stream #40096) had its audio rendered on sink 11003, which is the system default (alsa_output.usb-R__DE_RODECaster_Duo_IR0065308-00.analog-stereo)

- facts panel at load: Microphone "System default", Output "System default" (rows Microphone then Output)
- facts panel after the unplug: Output "IsocanEvidenceA — not connected"
- microphone row: ["System default","RODECaster Duo Analog Stereo","AB13X Headset Adapter Mono","Cam Link 4K Analog Stereo"]
- output row: ["System default","RODECaster Duo Analog Stereo","AB13X Headset Adapter Analog Stereo","Radeon High Definition Audio Controller Digital Stereo (HDMI) [DELL U2721DE]","IsocanEvidenceA","IsocanEvidenceB"]
- output at load: "" (nothing chosen yet) then "IsocanEvidenceA" ("10e9d0b92698c33710f99715498e4ebca283632b6f52274de1323cedd304444b")
- note while chosen and playing: ""
- after unplugging IsocanEvidenceA: rows ["System default","RODECaster Duo Analog Stereo","AB13X Headset Adapter Analog Stereo","Radeon High Definition Audio Controller Digital Stereo (HDMI) [DELL U2721DE]","IsocanEvidenceB","IsocanEvidenceA — not connected"], selection "10e9d0b92698c33710f99715498e4ebca283632b6f52274de1323cedd304444b"
- after unplugging IsocanEvidenceA: note "IsocanEvidenceA is not connected. The reply is playing on the system default until it comes back."
- with no microphone permission asked: microphone rows ["System default"], output rows ["System default"], note "Your device names are hidden until this page is allowed to use the microphone."
- with AudioContext.setSinkId deleted (a browser that cannot route output): rows ["System default","RODECaster Duo Analog Stereo","AB13X Headset Adapter Analog Stereo","Radeon High Definition Audio Controller Digital Stereo (HDMI) [DELL U2721DE]","IsocanEvidenceB"], control disabled true, note "This browser cannot choose an output device, so the reply plays on the system default."
- microphone frames the stub harness received from the page: 3884 (331434 bytes)

## The pills, measured

| window | pills | drawn / hit area | where | row centre vs microphone centre | horizontal overflow |
| --- | --- | --- | --- | --- | --- |
| 420×900 (narrow portrait) | 138px + 224px | 34px / 44px | under the ring | +154px | none |
| 420×900 (narrow portrait, dark) | 138px + 224px | 34px / 44px | under the ring | +154px | none |
| 1440×900 (desktop, dark) | 138px + 224px | 30px / 44px | beside the ring | +0px | none |
| 844×390 (phone landscape) | 138px + 224px | 30px / 44px | under the ring | +150px | none |
| 390×844 (phone portrait) | 136px + 222px | 34px / 44px | under the ring | +154px | none |
| 1240×800 (smallest window that puts them beside the ring) | 138px + 224px | 30px / 44px | beside the ring | +0px | none |

With a real long device name ("Radeon High Definition Audio Controller Digital Stereo (HDMI) [DELL U2721DE]") selected, the output pill's right 16px carried 9 ink pixels at 1440 and 9 at 420 — the arrow, which the platform's own icon lost the moment the name did not fit — and its text rows sat at 17–28 (1440) and 17–28 (420) around a centre line at 21.5px, with the glyph at 18–25.

The drawn pill is the hairline capsule; the hit area is the select inside it, which is what a thumb has to reach. Both pills stay on one line at every size, and neither the row nor the list leaves the window at any of them.

## Screenshots
- 05-gone-device-1440-light.png
- 01-rows-1440-light.png
- 02-facts-panel-1440-light.png
- 03-output-picker-1440-light.png
- 06-rows-420-light.png
- 07-rows-420-dark.png
- 08-rows-1440-dark.png
- 11-landscape-844x390.png
- 12-portrait-390x844.png
- 13-beside-ring-1240x800.png
- 09-names-withheld-1440-light.png
- 10-no-output-api-1440-light.png

## Steps
- page: a throwaway vite on 5173, its /harness proxied to a stub on 34843 (the real harness on 7654 is untouched)
- audio: null sinks isocan_evidence_a and isocan_evidence_b loaded; the machine's own default is alsa_output.usb-R__DE_RODECaster_Duo_IR0065308-00.analog-stereo (recorded as the second wire, never changed)
- rows: microphone ["System default","RODECaster Duo Analog Stereo","AB13X Headset Adapter Mono","Cam Link 4K Analog Stereo"]; output ["System default","RODECaster Duo Analog Stereo","AB13X Headset Adapter Analog Stereo","Radeon High Definition Audio Controller Digital Stereo (HDMI) [DELL U2721DE]","IsocanEvidenceA","IsocanEvidenceB"]
- rows: chosen output ""; note ""
- facts panel: Microphone "System default", Output "System default", rows in the order Microphone → Output — 02-facts-panel-1440-light.png
- silence: peaks before any audio — isocan_evidence_a 0, isocan_evidence_b 0
- chose: IsocanEvidenceA (10e9d0b9…) — stored preference agrees; note ""
- session: live — "listening — the system default microphone"
- reply: 25 frames (2.5 s of 440 Hz at half scale) sent by the harness
- reply: isocan_evidence_a.monitor peak 16384, isocan_evidence_b.monitor (control) peak 0 — only the chosen device received it
- reply: PulseAudio renders 2 Chrome stream(s) for the page on sink 40034 (isocan_evidence_a), first #40096
- reply: the page holds two AudioContexts (capture and playback); only the playback one is routed
- microphone: the page sent 1644 frames (140288 bytes of 16 kHz PCM) up the same socket
- facts panel after the unplug: Output "IsocanEvidenceA — not connected"
- unplugged: isocan_evidence_a unloaded (6 output rows)
- unplugged: rows now ["System default","RODECaster Duo Analog Stereo","AB13X Headset Adapter Analog Stereo","Radeon High Definition Audio Controller Digital Stereo (HDMI) [DELL U2721DE]","IsocanEvidenceB","IsocanEvidenceA — not connected"]; selection "10e9d0b92698c33710f99715498e4ebca283632b6f52274de1323cedd304444b"
- unplugged: note "IsocanEvidenceA is not connected. The reply is playing on the system default until it comes back."
- after unplug: Chrome 2159216's stream is now rendered on sink 11003 (the system default, alsa_output.usb-R__DE_RODECaster_Duo_IR0065308-00.analog-stereo), and the control sink peak was 0
- layout: narrow portrait (420×900, light) — pills 138px wide + 224px wide, one line, drawn 34px tall with a 44px hit area, under the ring, row centre +154px from the microphone's centre, document 420×900 in 420×900 (horizontal overflow none, vertical none) — 06-rows-420-light.png
- layout: narrow portrait, dark (420×900, dark) — pills 138px wide + 224px wide, one line, drawn 34px tall with a 44px hit area, under the ring, row centre +154px from the microphone's centre, document 420×900 in 420×900 (horizontal overflow none, vertical none) — 07-rows-420-dark.png
- layout: desktop, dark (1440×900, dark) — pills 138px wide + 224px wide, one line, drawn 30px tall with a 44px hit area, beside the ring, row centre +0px from the microphone's centre, document 1440×900 in 1440×900 (horizontal overflow none, vertical none) — 08-rows-1440-dark.png
- layout: phone landscape (844×390, light) — pills 138px wide + 224px wide, one line, drawn 30px tall with a 44px hit area, under the ring, row centre +150px from the microphone's centre, document 844×835 in 844×390 (horizontal overflow none, vertical +445 (the hero is taller than a landscape window: astra's stack, not this row)) — 11-landscape-844x390.png
- layout: phone portrait (390×844, light) — pills 136px wide + 222px wide, one line, drawn 34px tall with a 44px hit area, under the ring, row centre +154px from the microphone's centre, document 390×890 in 390×844 (horizontal overflow none, vertical +46 (the hero is taller than a landscape window: astra's stack, not this row)) — 12-portrait-390x844.png
- layout: smallest window that puts them beside the ring (1240×800, light) — pills 138px wide + 224px wide, one line, drawn 30px tall with a 44px hit area, beside the ring, row centre +0px from the microphone's centre, document 1240×847 in 1240×800 (horizontal overflow none, vertical +47 (the hero is taller than a landscape window: astra's stack, not this row)) — 13-beside-ring-1240x800.png
- pills measured (light theme, ink counted from a clipped screenshot): with the longest real name "Radeon High Definition Audio Controller Digital Stereo (HDMI) [DELL U2721DE]" the output pill is 224px wide at 1440 and 224px at 420, and its right 16px carries 9 ink pixels at 1440 / 9 at 420 (the arrow that says it opens) — text rows 17–28 and 17–28 against a centre line at 21.5px, glyph rows 18–25 / 18–25; the microphone pill with a short name: 138px wide, arrow ink 9, text rows 17–28
- no permission asked: microphone rows ["System default"], output rows ["System default"]
- no permission asked: note "Your device names are hidden until this page is allowed to use the microphone." — 09-names-withheld-1440-light.png
- no output API: output rows ["System default","RODECaster Duo Analog Stereo","AB13X Headset Adapter Analog Stereo","Radeon High Definition Audio Controller Digital Stereo (HDMI) [DELL U2721DE]","IsocanEvidenceB"], control disabled true
- no output API: note "This browser cannot choose an output device, so the reply plays on the system default." — 10-no-output-api-1440-light.png
