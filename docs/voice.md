# The voice page

`packages/web/voice.html` is a standalone microphone page: no router, no React,
no identity gate. Vite serves it at `/voice` (the dev server also proxies
`/harness` to the local voice harness, so the page and the harness share an
origin). It exists for one reason — to speak operations onto a canvas as an
enrolled actor — and it is a client of the harness, never a second
implementation of it.

## Starting a working page

  1. **A daemon.** `isocan serve` (or any `isocan` command, which starts one on
     demand). This is the thing that owns the canvas.
  2. **A harness.** `node packages/cli/bin/isocan.js voice --canvas "<name>"`.
     It claims the actor, opens the provider's Live session and holds the key;
     the page only sends audio to loopback.
  3. **The page.** `npm run dev` in `packages/web`, then
     `http://127.0.0.1:5173/voice` (the integration build serves it at
     `/voice` on its own port). The header carries a **build tag** —
     `branch @ commit` — so you can see which build you are looking at; a build
     without the injected value says `build tag not injected`.

## The three settings, and where they live

| Setting | Today | The page's half |
| --- | --- | --- |
| **Daemon** | whatever `isocan`/the harness was started against; `--port` to change it | shows it in "Connected to"; can switch it when the harness answers `GET /daemons` + `POST /daemon` |
| **Actor** | `isocan voice --as "<name>"`, or the name the `rc` session injected; the claim is idempotent, so restarting resumes the same actor | shows name, id and whether it is enrolled; can claim a name when the harness answers `POST /actor` (a refusal — "that name is taken" — is shown verbatim) |
| **Project** | `--canvas "<name>"`, or the directory's binding | shows title + id; can pick from `GET /canvases` + `POST /canvas` |
| **Enrolment** | `isocan rc add <name> --harness voice`, plus an `"acpAdapters": {"voice": ["node", "<isocan.js>", "voice", "--acp"]}` entry in `~/.isocan/config.json` | "Enrol from here" when the harness answers `POST /enrol`; otherwise the exact two commands are printed in the panel |
| **Key** | paste it in the Key drawer; the harness writes `~/.isocan/voice/key.json` (0600) and never stores it in the page | working today |

**The page half is written against a frozen contract**, held as a comment on
bead `isocan-xsh.8`: request shape, response shape and the refusal text for
each failure. Where the running harness build does not answer a verb yet, the
panel says so and names the command instead of rendering a control that does
nothing — the setup drawer also opens itself while the canvas, the actor, the
enrolment or the key is missing, so a first run cannot hide behind the same
disclosure as the logs.

## What the page will not do

  - **It never holds the key** beyond the one POST over loopback.
  - **It never confirms for the model.** Destructive operations are the
    harness's gate; the page renders Allow/Deny when the harness asks
    (`{ confirm: { id, what } }` → `POST /confirm { id, allow }`) and a
    model-supplied `force: true` cannot satisfy it.
  - **It never adds canvas items for `open_url`.** A tab is a surface
    capability and is gated on a real press; the canvas path is the harness's.

## Reading the page when something is wrong

The tool log is the diagnosable record, and three lines in it exist because
each one cost a day:

  - `microphone: <label> (…) @ 44100 Hz` — the capture context rate. 44.1 kHz
    with a fractional resample ratio is what sent 98% zeros to the provider and
    produced silent turns; the rate in the log names that class in one line.
  - `audio #N · <bytes> B · <duration>s · starts <t>s (now <t>s)` — every
    playback chunk's sequence, size and scheduled start. Chunks must start
    where the last one ended; two chunks starting at the same time is the
    overlap bug, and this line shows it.
  - `state: <…>` and `the harness is asking: <…>` — the session's own words,
    and the permission question, next to the events that produced them.
