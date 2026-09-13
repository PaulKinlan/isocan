# Voice device selectors — browser evidence

Run 2026-09-13T21:06:13.437Z in a real Chrome Chrome/152.0.0.0, on two null sinks planted in the machine's own audio stack.

The claim this file exists for: **a non-default output received the reply, and a control output did not.**

| wire | silence before | tone while chosen |
| --- | --- | --- |
| IsocanEvidenceA (the chosen device) | 0 | 16384 |
| IsocanEvidenceB (control) | 0 | 0 |

Peaks are int16 samples off each sink's own monitor port (`parec`), so a number over zero is audio that device actually produced. The machine's own default sink is NOT used as a third wire: its monitor carries whatever else the machine is playing (a first run of this script read 18302 there while the tone was meant to be elsewhere, and the sound was somebody's music), so where the reply goes is read from PulseAudio's own stream attribution instead:

- while IsocanEvidenceA was chosen: PulseAudio rendered Chrome's audio for the page on sink 38198 (isocan_evidence_a)
- setSinkId is per AudioContext (measured): the capture context stays on the system default while the playback context is routed, so only the reply moves
- after the device was unplugged: the same browser (pid 1597284, stream #38260) had its audio rendered on sink 11003, which is the system default (alsa_output.usb-R__DE_RODECaster_Duo_IR0065308-00.analog-stereo)

- microphone row: ["System default microphone","RODECaster Duo Analog Stereo","AB13X Headset Adapter Mono","Cam Link 4K Analog Stereo"]
- output row: ["System default","RODECaster Duo Analog Stereo","AB13X Headset Adapter Analog Stereo","Radeon High Definition Audio Controller Digital Stereo (HDMI) [DELL U2721DE]","IsocanProofA","IsocanProofB","IsocanEvidenceA","IsocanEvidenceB"]
- output at load: "" (nothing chosen yet) then "IsocanEvidenceA" ("9a193edbcff9b4acd1602050c98fa4ea1e330d354f8082359e764f0278ef081c")
- note while chosen and playing: ""
- after unplugging IsocanEvidenceA: rows ["System default","RODECaster Duo Analog Stereo","AB13X Headset Adapter Analog Stereo","Radeon High Definition Audio Controller Digital Stereo (HDMI) [DELL U2721DE]","IsocanProofA","IsocanProofB","IsocanEvidenceB","IsocanEvidenceA — not connected"], selection "9a193edbcff9b4acd1602050c98fa4ea1e330d354f8082359e764f0278ef081c"
- after unplugging IsocanEvidenceA: note "IsocanEvidenceA is not connected. The reply is playing on the system default until it comes back."
- with no microphone permission asked: microphone rows ["System default microphone"], output rows ["System default"], note "Your device names are hidden until this page is allowed to use the microphone."
- with AudioContext.setSinkId deleted (a browser that cannot route output): rows ["System default","RODECaster Duo Analog Stereo","AB13X Headset Adapter Analog Stereo","Radeon High Definition Audio Controller Digital Stereo (HDMI) [DELL U2721DE]","IsocanProofA","IsocanProofB","IsocanEvidenceB"], control disabled true, note "This browser cannot choose an output device, so the reply plays on the system default."
- microphone frames the stub harness received from the page: 3860 (329386 bytes)

## Screenshots
- 04-gone-device-1440-light.png
- 01-rows-1440-light.png
- 02-output-picker-1440-light.png
- 05-rows-420-light.png
- 06-rows-420-dark.png
- 07-rows-1440-dark.png
- 08-names-withheld-1440-light.png
- 09-no-output-api-1440-light.png

## Steps
- page: a throwaway vite on 5173, its /harness proxied to a stub on 40013 (the real harness on 7654 is untouched)
- audio: null sinks isocan_evidence_a and isocan_evidence_b loaded; the machine's own default is alsa_output.usb-R__DE_RODECaster_Duo_IR0065308-00.analog-stereo (recorded as the second wire, never changed)
- rows: microphone ["System default microphone","RODECaster Duo Analog Stereo","AB13X Headset Adapter Mono","Cam Link 4K Analog Stereo"]; output ["System default","RODECaster Duo Analog Stereo","AB13X Headset Adapter Analog Stereo","Radeon High Definition Audio Controller Digital Stereo (HDMI) [DELL U2721DE]","IsocanProofA","IsocanProofB","IsocanEvidenceA","IsocanEvidenceB"]
- rows: chosen output ""; note ""
- silence: peaks before any audio — isocan_evidence_a 0, isocan_evidence_b 0
- chose: IsocanEvidenceA (9a193edb…) — stored preference agrees; note ""
- session: live — "listening — the system default microphone"
- reply: 25 frames (2.5 s of 440 Hz at half scale) sent by the harness
- reply: isocan_evidence_a.monitor peak 16384, isocan_evidence_b.monitor (control) peak 0 — only the chosen device received it
- reply: PulseAudio renders 2 Chrome stream(s) for the page on sink 38198 (isocan_evidence_a), first #38260
- reply: the page holds two AudioContexts (capture and playback); only the playback one is routed
- microphone: the page sent 1652 frames (140970 bytes of 16 kHz PCM) up the same socket
- unplugged: isocan_evidence_a unloaded (8 output rows)
- unplugged: rows now ["System default","RODECaster Duo Analog Stereo","AB13X Headset Adapter Analog Stereo","Radeon High Definition Audio Controller Digital Stereo (HDMI) [DELL U2721DE]","IsocanProofA","IsocanProofB","IsocanEvidenceB","IsocanEvidenceA — not connected"]; selection "9a193edbcff9b4acd1602050c98fa4ea1e330d354f8082359e764f0278ef081c"
- unplugged: note "IsocanEvidenceA is not connected. The reply is playing on the system default until it comes back."
- after unplug: Chrome 1597284's stream is now rendered on sink 11003 (the system default, alsa_output.usb-R__DE_RODECaster_Duo_IR0065308-00.analog-stereo), and the control sink peak was 0
- layout: 420px light — document 420px, device row 12…408 of 420, pill widths [396,396] heights [44,44] (stacked), microphone 240px of a 396px hero — 05-rows-420-light.png
- layout: 420px dark — document 420px, device row 12…408 of 420, pill widths [396,396] heights [44,44] (stacked), microphone 240px of a 396px hero — 06-rows-420-dark.png
- layout: 1440px dark — document 1440px, device row 482…958 of 1440, pill widths [213,254] heights [34,34] (one line), microphone 240px of a 688px hero — 07-rows-1440-dark.png
- no permission asked: microphone rows ["System default microphone"], output rows ["System default"]
- no permission asked: note "Your device names are hidden until this page is allowed to use the microphone." — 08-names-withheld-1440-light.png
- no output API: output rows ["System default","RODECaster Duo Analog Stereo","AB13X Headset Adapter Analog Stereo","Radeon High Definition Audio Controller Digital Stereo (HDMI) [DELL U2721DE]","IsocanProofA","IsocanProofB","IsocanEvidenceB"], control disabled true
- no output API: note "This browser cannot choose an output device, so the reply plays on the system default." — 09-no-output-api-1440-light.png
