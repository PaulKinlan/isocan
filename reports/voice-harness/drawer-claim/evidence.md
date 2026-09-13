# A name claimed from the settings drawer

Page: http://127.0.0.1:5772/voice (Vite, this repo's own config, /harness → http://127.0.0.1:7990/).
Harness: the shipped `isocan voice` verb on a free port, over a throwaway home and daemon.

- enrolled for the walk: enrolled Voice — answerable on "Voice evidence" · listens only to you. A running `isocan rc` picks this up without a restart; nothing runs until something arrives. Nobody else's word wakes it — `isocan rc listen Voice --to <names|everyone>` widens that.
- before: roster row ["Voice"]
- harness: `isocan voice` listening at http://127.0.0.1:7990/ (daemon 39509, home isocan-voice-drawer-KvPCJ4)
- before: actor “Voice” usr_00Xuy_5GJG, canvas “Voice evidence” prj_voice, enrolled true
- page: http://127.0.0.1:5772/voice (Vite serving packages/web, /harness → this run's harness)
- ✓ the settings drawer is open
- ✓ the drawer offers a name field and a “Claim this name” button — the harness answered the contract
- ✓ nothing in the drawer says the build cannot do it: ["Canvas: Voice evidence — this harness build cannot list or change it from here.isocan voice --canvas \"<name>\"","Actor: Voice (usr_00Xuy_5GJG) — the microphone speaks as this actor.Claim this name","Enrolled: this actor is invited to the canvas as a voice harness.","No provider key is stored — the harness cannot open a Live session without one.Add a key"]
- drawer: actor “Voice”, 4 setup step(s), the claim control present
- ✓ the person pressed “Claim this name”
- ✓ the drawer's actor id is the harness's: usr_00Xuy_5GJG
- ✓ no complaint is standing on the page
- ✓ the page's own log says what it posted and what came back: "22:33:13/actor: {\"ok\":true,\"actor\":{\"id\":\"usr_00Xuy_5GJG\",\"name\":\"Nova\"},\"canvas\":{\"id\":\"prj_voice\",\"title\":\"Voice evidence\"},\"answer\":\"this agent now answers to “Nova” (it was “Voice”) — the enrolment on “Voice evid"
- ✓ and the harness answered ok
- page log: 22:33:13/actor: {"ok":true,"actor":{"id":"usr_00Xuy_5GJG","name":"Nova"},"canvas":{"id":"prj_voice","title":"Voice evidence"},"answer":"this agent now answers to “Nova” (it was “Voice”) — the enrolment on “Voice evid
- ✓ the harness's own account of itself is “Nova”
- ✓ the same actor id — a rename, not a second agent
- ✓ the canvas calls that actor “Nova”
- ✓ the machine's enrolment row moved with it: ["Nova"]
- ✓ the canvas's own enrolment record says “Nova”
- ✓ /state agrees: “Nova” usr_00Xuy_5GJG
- ✓ a harness started AFTER the claim (by the old env name “Voice”) resumes “Nova” usr_00Xuy_5GJG
- ✓ and the canvas carries one name, not two faces

Screenshots: 01-drawer-open.png, 02-name-typed.png, 03-claimed.png.
Raw: evidence.json.

What is not covered here: the daemon and canvas pickers (`GET /daemons`,
`GET /canvases`, `POST /canvas`) and `POST /enrol` — this run is the claim,
which is the one that was blocking.
