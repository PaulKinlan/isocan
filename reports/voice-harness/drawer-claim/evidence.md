# A name claimed from the settings drawer

Page: http://127.0.0.1:5796/voice (Vite, this repo's own config, /harness → http://127.0.0.1:7986/).
Harness: the shipped `isocan voice` verb on a free port, over a throwaway home and daemon.

- before: roster row []
- harness: `isocan voice` listening at http://127.0.0.1:7986/ (daemon 44413, home isocan-voice-drawer-o3YlK9)
- before: actor “Voice” usr_hRnSPtgLVG, canvas “Voice evidence” prj_voice, enrolled false
- page: http://127.0.0.1:5796/voice (Vite serving packages/web, /harness → this run's harness)
- ✓ the settings drawer is open
- ✓ the drawer offers a name field and a “Claim this name” button — the harness answered the contract
- ✓ nothing in the drawer says the build cannot do it: ["Canvas: Voice evidence. Choose another one:Launch planVoice evidenceUse this canvas","Actor: Voice (usr_hRnSPtgLVG) — the microphone speaks as this actor.Claim this name","Not enrolled: nothing can summon it, and the roster has no voice harness for this canvas.Enrol from hereisocan rc add Voice --harness voice\"acpAdapters\": {\"voice\": [\"node\", \"<isocan.js>\", \"voice\", \"--acp\"]} in ~/.isocan/config.json","No provider key is stored — the harness cannot open a Live session without one.Add a key"]
- drawer: actor “Voice”, 4 setup step(s), the claim control present
- ✓ the drawer says what is missing and offers the fix: "Not enrolled: nothing can summon it, and the roster has no voice harness for this canvas.Enrol from hereisocan rc add Voice --harness voice\"acpAdapters\": {\"voice\": [\"node\", \"<isocan.js>\", \"voice\", \"--acp\"]} in ~/.isocan/config.json"
- ✓ the harness says it is enrolled, from the page alone
- ✓ the machine's rc half is there: [{"name":"Voice","harness":"voice"}]
- enrolled from the drawer — no CLI, no config edit
- ✓ the person pressed “Claim this name”
- ✓ the drawer's actor id is the harness's: usr_hRnSPtgLVG
- ✓ no complaint is standing on the page
- ✓ the page's own log says what it posted and what came back: "22:38:19/actor: {\"ok\":true,\"actor\":{\"id\":\"usr_hRnSPtgLVG\",\"name\":\"Nova\"},\"canvas\":{\"id\":\"prj_voice\",\"title\":\"Voice evidence\"},\"answer\":\"this agent now answers to “Nova” (it was “Voice”) — the enrolment on “Voice evid"
- ✓ and the harness answered ok
- page log: 22:38:19/actor: {"ok":true,"actor":{"id":"usr_hRnSPtgLVG","name":"Nova"},"canvas":{"id":"prj_voice","title":"Voice evidence"},"answer":"this agent now answers to “Nova” (it was “Voice”) — the enrolment on “Voice evid
- ✓ the harness's own account of itself is “Nova”
- ✓ the same actor id — a rename, not a second agent
- ✓ the canvas calls that actor “Nova”
- ✓ the machine's enrolment row moved with it: ["Nova"]
- ✓ the canvas's own enrolment record says “Nova”
- ✓ the drawer offers a canvas picker: [{"value":"prj_voice","text":"Voice evidence"},{"value":"prj_launch","text":"Launch plan"}]
- ✓ the picker lists the canvases the harness knows (GET /canvases)
- ✓ the session moved to “Launch plan” (prj_launch)
- picker: chose “Launch plan” and the session is on prj_launch
- ✓ /state agrees: “Nova” usr_hRnSPtgLVG
- ✓ a harness started AFTER the claim (by the old env name “Voice”) resumes “Nova” usr_hRnSPtgLVG
- ✓ and the canvas carries one name, not two faces

Screenshots: 01-drawer-open.png, 02-name-typed.png, 03-claimed.png,
04-canvas-chosen.png.
Raw: evidence.json.

What is not covered here: `GET /daemons` + `POST /daemon` — the daemon is
what the harness attaches to at start, so that pair is a different question.
Everything else in the contract is walked above: enrol, claim, and the canvas
picker.
