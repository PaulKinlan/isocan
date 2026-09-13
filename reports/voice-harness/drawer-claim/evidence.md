# A name claimed from the settings drawer

Page: http://127.0.0.1:5664/voice (Vite, this repo's own config, /harness → http://127.0.0.1:7934/).
Harness: the shipped `isocan voice` verb on a free port, over a throwaway home and daemon.

- enrolled for the walk: enrolled Voice — answerable on "Voice evidence" · listens only to you. A running `isocan rc` picks this up without a restart; nothing runs until something arrives. Nobody else's word wakes it — `isocan rc listen Voice --to <names|everyone>` widens that.
- before: roster row ["Voice"]
- harness: `isocan voice` listening at http://127.0.0.1:7934/ (daemon 38995, home isocan-voice-drawer-uZizYX)
- before: actor “Voice” usr_yLL79RE6GS, canvas “Voice evidence” prj_voice, enrolled true
- page: http://127.0.0.1:5664/voice (Vite serving packages/web, /harness → this run's harness)
- ✓ the settings drawer is open
- ✓ the drawer offers a name field and a “Claim this name” button — the harness answered the contract
- ✓ nothing in the drawer says the build cannot do it: ["Canvas: Voice evidence. Choose another one:Voice evidenceisocan-deepseek-actorsLaunch planUse this canvas","Actor: Voice (usr_yLL79RE6GS) — the microphone speaks as this actor.Claim this name","Enrolled: this actor is invited to the canvas as a voice harness.","No provider key is stored — the harness cannot open a Live session without one.Add a key"]
- drawer: actor “Voice”, 4 setup step(s), the claim control present
- ✓ the person pressed “Claim this name”
- ✓ the drawer's actor id is the harness's: usr_yLL79RE6GS
- ✓ no complaint is standing on the page
- ✓ the page's own log says what it posted and what came back: "22:35:48/actor: {\"ok\":true,\"actor\":{\"id\":\"usr_yLL79RE6GS\",\"name\":\"Nova\"},\"canvas\":{\"id\":\"prj_voice\",\"title\":\"Voice evidence\"},\"answer\":\"this agent now answers to “Nova” (it was “Voice”) — the enrolment on “Voice evid"
- ✓ and the harness answered ok
- page log: 22:35:48/actor: {"ok":true,"actor":{"id":"usr_yLL79RE6GS","name":"Nova"},"canvas":{"id":"prj_voice","title":"Voice evidence"},"answer":"this agent now answers to “Nova” (it was “Voice”) — the enrolment on “Voice evid
- ✓ the harness's own account of itself is “Nova”
- ✓ the same actor id — a rename, not a second agent
- ✓ the canvas calls that actor “Nova”
- ✓ the machine's enrolment row moved with it: ["Nova"]
- ✓ the canvas's own enrolment record says “Nova”
- ✓ the drawer offers a canvas picker: [{"value":"prj_voice","text":"Voice evidence"},{"value":"prj_Wl8WJUrdCN","text":"isocan-deepseek-actors"},{"value":"prj_launch","text":"Launch plan"}]
- ✓ the picker lists the canvases the harness knows (GET /canvases)
- ✓ the session moved to “Launch plan” (prj_launch)
- picker: chose “Launch plan” and the session is on prj_launch
- ✓ /state agrees: “Nova” usr_yLL79RE6GS
- ✓ a harness started AFTER the claim (by the old env name “Voice”) resumes “Nova” usr_yLL79RE6GS
- ✓ and the canvas carries one name, not two faces

Screenshots: 01-drawer-open.png, 02-name-typed.png, 03-claimed.png,
04-canvas-chosen.png.
Raw: evidence.json.

What is not covered here: `GET /daemons` + `POST /daemon` and `POST /enrol` —
the claim and the project picker are.
