# A name claimed from the settings drawer

Page: http://127.0.0.1:5670/voice (Vite, this repo's own config, /harness → http://127.0.0.1:8185/).
Harness: the shipped `isocan voice` verb on a free port, over a throwaway home and daemon.

- before: roster row []
- harness: `isocan voice` listening at http://127.0.0.1:8185/ (daemon 33477, home isocan-voice-drawer-TMeDEA)
- before: actor “Voice” usr_S-j1UBnkad, canvas “Voice evidence” prj_voice, enrolled false
- page: http://127.0.0.1:5670/voice (Vite serving packages/web, /harness → this run's harness)
- ✓ the settings drawer is open
- ✓ the drawer offers a name field and a “Claim this name” button — the harness answered the contract
- ✓ nothing in the drawer says the build cannot do it: ["Canvas: Voice evidence. Choose another one:Launch planVoice evidenceUse this canvas","Actor: Voice (usr_S-j1UBnkad) — the microphone speaks as this actor.Claim this name","Not enrolled: nothing can summon it, and the roster has no voice harness for this canvas.Enrol from hereisocan rc add Voice --harness voice\"acpAdapters\": {\"voice\": [\"node\", \"<isocan.js>\", \"voice\", \"--acp\"]} in ~/.isocan/config.json","No provider key is stored — the harness cannot open a Live session without one.Add a key"]
- drawer: actor “Voice”, 4 setup step(s), the claim control present
- ✓ the drawer says what is missing and offers the fix: "Not enrolled: nothing can summon it, and the roster has no voice harness for this canvas.Enrol from hereisocan rc add Voice --harness voice\"acpAdapters\": {\"voice\": [\"node\", \"<isocan.js>\", \"voice\", \"--acp\"]} in ~/.isocan/config.json"
- ✓ the harness says it is enrolled, from the page alone
- ✓ the machine's rc half is there: [{"name":"Voice","harness":"voice"}]
- enrolled from the drawer — no CLI, no config edit
- ✓ the drawer says the harness refused: "— wanted: http://127.0.0.1:9999 (refused: this harness cannot change daemon while it runs: it attached to http://127.0.0.1:33477 at start, and this session's canvas handles, provider socket and presence are that daemon's. Stop it and start it against the one you want — isocan voice --port <port> (asked for http://127.0.0.1:9999))"
- ✓ and it is the harness's own refusal, not a build that cannot answer
- ✓ GET /daemons names the one it is on: ["http://127.0.0.1:33477"]
- daemon: the harness refused the move and named the remedy — — wanted: http://127.0.0.1:9999 (refused: this harness cannot change daemon while it runs: it attached to http://127.0.0.1:33477 at start, a
- ✓ the person pressed “Claim this name”
- ✓ the drawer's actor id is the harness's: usr_S-j1UBnkad
- ✓ no complaint is standing on the page
- ✓ the page's own log says what it posted and what came back: "22:43:17/actor: {\"ok\":true,\"actor\":{\"id\":\"usr_S-j1UBnkad\",\"name\":\"Nova\"},\"canvas\":{\"id\":\"prj_voice\",\"title\":\"Voice evidence\"},\"answer\":\"this agent now answers to “Nova” (it was “Voice”) — the enrolment on “Voice evid"
- ✓ and the harness answered ok
- page log: 22:43:17/actor: {"ok":true,"actor":{"id":"usr_S-j1UBnkad","name":"Nova"},"canvas":{"id":"prj_voice","title":"Voice evidence"},"answer":"this agent now answers to “Nova” (it was “Voice”) — the enrolment on “Voice evid
- ✓ the harness's own account of itself is “Nova”
- ✓ the same actor id — a rename, not a second agent
- ✓ the canvas calls that actor “Nova”
- ✓ the machine's enrolment row moved with it: ["Nova"]
- ✓ the canvas's own enrolment record says “Nova”
- ✓ the drawer offers a canvas picker: [{"value":"prj_voice","text":"Voice evidence"},{"value":"prj_launch","text":"Launch plan"}]
- ✓ the picker lists the canvases the harness knows (GET /canvases)
- ✓ the session moved to “Launch plan” (prj_launch)
- picker: chose “Launch plan” and the session is on prj_launch
- ✓ /state agrees: “Nova” usr_S-j1UBnkad
- ✓ a harness started AFTER the claim (by the old env name “Voice”) resumes “Nova” usr_S-j1UBnkad
- ✓ and the canvas carries one name, not two faces

Screenshots: 01-drawer-open.png, 02-name-typed.png, 03-claimed.png,
04-canvas-chosen.png.
Raw: evidence.json.

Every door in the contract is walked above: enrol, claim, the canvas
picker, and the daemon pair — which answers with the one it is attached to
and refuses the move with the command that does it instead, because a
harness cannot re-attach mid-flight and saying so is more useful than a 405.
