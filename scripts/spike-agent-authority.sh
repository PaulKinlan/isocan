#!/usr/bin/env bash
# What does an enrolled agent actually hold?
#
# `isocan-r8h` asks whether spending power rides the badge, and whether a local
# agent therefore holds its owner's. This is that question measured rather than
# argued, and it keeps the two halves APART, because they turn out to travel by
# different channels:
#
#   AUTHORITY  rides the badge's admission for the canvas (`capabilityIn`).
#   SPEND      rides the summons environment (`adapterEnv`'s passed prefixes).
#
# A badge cookie cannot spend anything, and an environment variable cannot
# authorise anything. Conflating them makes the hole look bigger than it is in
# one place and smaller than it is in the other.
#
# It starts a throwaway daemon on a throwaway home, so it touches nothing you
# own: no canvas of yours, no enrolment of yours, no config of yours. It never
# reaches the network and never prints a secret VALUE — the spend half prints
# variable NAMES, which are not credentials.
#
#   ./scripts/spike-agent-authority.sh
#
# Findings belong in docs/research/, beside the note that owns this question
# (2026-09-11-per-asker-scopes.md, "The only two places that enforce anything").
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ISOCAN="node $REPO/packages/cli/bin/isocan.js"
if [ ! -f "$REPO/packages/cli/bin/isocan.js" ]; then
  echo "This script has to run from inside an isocan checkout: it looked for" >&2
  echo "  $REPO/packages/cli/bin/isocan.js" >&2
  echo "and found nothing. Run it as ./scripts/spike-agent-authority.sh from the repo root." >&2
  exit 2
fi

SPIKE="$(mktemp -d)"
HOME_DIR="$SPIKE/home"
PROJ="$SPIKE/proj"
PORT=$((4780 + RANDOM % 180))
mkdir -p "$HOME_DIR" "$PROJ"

# One JSON reader for the whole script, so no verdict depends on a nested
# `$( ... node -e '...' )` surviving shell quoting. Prints the value at a
# dotted path, or "" when the shape is not what was hoped for.
PICK="$SPIKE/pick.mjs"
cat >"$PICK" <<'PICKJS'
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try {
    let v = JSON.parse(s);
    for (const k of process.argv[2].split(".")) v = v?.[k];
    console.log(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  } catch {
    console.log("");
  }
});
PICKJS
pick() { node "$PICK" "$1"; }

# A scratch home and a scratch port, so the daemon this starts is not the one
# you are running and the badge it mints is not yours.
export ISOCAN_HOME="$HOME_DIR" ISOCAN_PORT="$PORT"

PASS=0
FAIL=0
ROWS=()
row() { # row <question> <verdict> <detail>
  ROWS+=("$(printf '%-46s %-6s %s' "$1" "$2" "${3-}")")
  if [ "$2" = "yes" ] || [ "$2" = "no" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
}
say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
# Every CLI call runs in the bound directory, as the owner or as the agent.
# `--json` is a GLOBAL flag and goes before the verb: after it, the verb prints
# its human table and the reader gets nothing to parse.
as_owner() { (cd "$PROJ" && $ISOCAN "$@" 2>&1); }
as_owner_json() { (cd "$PROJ" && $ISOCAN --json "$@" 2>/dev/null); }
as_agent() { (cd "$PROJ" && ISOCAN_HARNESS=agent ISOCAN_SESSION_ID="$AGENT_SESSION" $ISOCAN "$@" 2>&1); }
as_agent_json() { (cd "$PROJ" && ISOCAN_HARNESS=agent ISOCAN_SESSION_ID="$AGENT_SESSION" $ISOCAN --json "$@" 2>/dev/null); }
# Shape-agnostic on purpose: the verdict is "did the bytes change", which does
# not depend on guessing which key the sharing answer keeps its rung under.
link_state() { as_owner_json share | tr -d ' \n' | head -c 400; }
# The link grant read out of `share --json`'s actual shape: a `grants[]` row
# whose subject is `link`, with an ABSENT capability meaning `edit` (core's
# `capabilityOf`). Printed so the table's detail column shows the change rather
# than asserting it.
link_row() {
  as_owner_json share | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
  const g=(JSON.parse(s).grants||[]).find(r=>r.subject==="link");
  console.log(g?`subject=link capability=${g.capability??"edit (absent)"} barred=${g.bar??false} id=${g.id}`:"no link grant row");
}catch{console.log("<unreadable>")}});'
}

cleanup() {
  [ -n "${DAEMON_PID:-}" ] && kill "$DAEMON_PID" 2>/dev/null
  rm -rf "$SPIKE"
}
trap cleanup EXIT

say "The machine"
echo "  $(uname -srm), node $(node --version)"
echo "  repo: $REPO  ($(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo 'no git'))"
echo "  throwaway home: $HOME_DIR   port: $PORT"

as_owner identity --name "Owner Person" --home >/dev/null 2>&1
(cd "$PROJ" && exec $ISOCAN serve --foreground >"$SPIKE/daemon.log" 2>&1) &
DAEMON_PID=$!
for _ in $(seq 1 60); do
  $ISOCAN status >/dev/null 2>&1 && break
  sleep 0.5
done
if ! $ISOCAN status >/dev/null 2>&1; then
  echo "the throwaway daemon did not come up; its log:" >&2
  cat "$SPIKE/daemon.log" >&2
  exit 1
fi
BADGE="$(as_owner_json whoami | pick badge)"
echo "  one badge for this machine: ${BADGE:-unknown}"

# ---------------------------------------------------------------- AUTHORITY --
say "AUTHORITY — what an enrolled agent may authorise"

echo "  owner creates a canvas: $(as_owner canvas create 'Acme Owner Canvas' | tail -1)"
CANVAS_ID="$(as_owner_json canvas list --all | pick 0.id)"
echo "  canvas: ${CANVAS_ID:-unknown}"
BEFORE="$(link_state)"
BEFORE_ROW="$(link_row)"
echo "  link grant before: $BEFORE_ROW"

# The agent, claimed under the SAME badge with the harness `adapterEnv`
# injects (packages/cli/src/acp.ts: `env["ISOCAN_HARNESS"] = "agent"`). Its
# session key here is a plain string rather than an HMAC, which weakens
# nothing in this measurement: the question is what the badge AUTHORISES, and
# room phase 3.5's unguessable keys are about who may PRESENT the agent, not
# about what presenting it is worth.
AGENT_SESSION="spike-enrolled-agent"
echo "  agent claims under the same badge: $(as_agent identity --name 'Acme Agent' --session | head -1)"
AGENT_ID="$(as_agent_json whoami | pick id)"
OWNER_ID="$(as_owner_json whoami | pick id)"
echo "  owner actor: ${OWNER_ID:-?}   agent actor: ${AGENT_ID:-?}"
row "owner and agent are distinct actors" \
  "$([ -n "$OWNER_ID" ] && [ "$OWNER_ID" != "$AGENT_ID" ] && echo yes || echo no)" \
  "$OWNER_ID vs $AGENT_ID"

# Is the agent honestly RECORDED as an agent? `actorKinds` is what faces and
# counts read, and personal.ts is the one authority path that consults it.
# Does the HOME record this actor as an agent? `who --all` does not carry the
# kind on its rows, so this reads the registry the home actually persisted and
# applies core's own predicate to it — the classification, not a rendering of it.
HARNESS="$(node -e '
const fs=require("fs");
try{const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
console.log((r.harnesses||{})[process.argv[2]]||"<not recorded>");}catch(e){console.log("<unreadable>")}' \
  "$HOME_DIR/actors.json" "$AGENT_ID")"
IS_AGENT="$(node --experimental-transform-types --no-warnings --input-type=module -e '
const { isAgentHarness } = await import("'"$REPO"'/packages/core/src/claims.ts");
console.log(isAgentHarness(process.argv[1]) ? "agent" : "person");' "$HARNESS" 2>/dev/null)"
row "the home records the agent AS an agent" \
  "$([ "$IS_AGENT" = "agent" ] && echo yes || echo no)" \
  "registry harness=\"$HARNESS\" -> isAgentHarness: ${IS_AGENT:-?} (but see AUTHORITY below: kind gates faces and personal canvases, not rungs)"

# An own-gated act, as the agent: change who may enter the owner's canvas.
WIDEN="$(as_agent share --link read | tail -2 | head -1)"
AFTER_WIDEN="$(link_state)"
row "agent changed the link grant (own-gated)" \
  "$([ -n "$AFTER_WIDEN" ] && [ "$AFTER_WIDEN" != "$BEFORE" ] && echo yes || echo no)" \
  "$(echo "$WIDEN" | cut -c1-46) | $(link_row)"

OFF="$(as_agent share --link off | tail -2 | head -1)"
AFTER_OFF="$(link_state)"
row "agent turned the link grant OFF (expels)" \
  "$([ "$AFTER_OFF" != "$AFTER_WIDEN" ] && echo yes || echo no)" \
  "$(echo "$OFF" | cut -c1-40) | $(link_row)"

# And an ordinary write, so the table gives the floor and not only the ceiling.
WROTE="$(as_agent text 'written by the agent' --at 0,0 | tail -1)"
row "agent wrote an item (edit-gated)" \
  "$(echo "$WROTE" | grep -qiE 'error|refus|not allowed|no identity' && echo no || echo yes)" \
  "$(echo "$WROTE" | cut -c1-70)"

# Whose name is on it? Identity is the half the design says is honest.
BY="$(as_agent_json ls >"$SPIKE/ls.json" 2>/dev/null; node -e '
const fs=require("fs");
try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const arr=Array.isArray(j)?j:(j.items||Object.values(j.items||{}));
const it=arr.find((x)=>String(x.title||"").includes("written by the agent"));
console.log(it?JSON.stringify(it.createdBy||it.updatedBy||"(no actor field)"):"item not found");}
catch(e){console.log("unreadable: "+e.message)}' "$SPIKE/ls.json")"
row "the write is recorded as the AGENT" \
  "$(echo "$BY" | grep -q 'Acme Agent' && echo yes || echo no)" "createdBy: $BY"

# ------------------------------------------------------------------- SPEND --
say "SPEND — what an enrolled agent may actually spend"

# The mechanism, on a synthetic shell: no real value is ever read, and only
# NAMES come out. `adapterEnv` is the rc's whole environment policy.
# `--experimental-transform-types`, because acp.ts pulls in core, and core's
# `ApiError` uses a TypeScript parameter property — which strip-only mode
# refuses. The CLI's own bin registers tsx for the same reason.
node --experimental-transform-types --no-warnings --input-type=module -e '
const { adapterEnv } = await import("'"$REPO"'/packages/cli/src/acp.ts");
const fake = {
  PATH: "/usr/bin", HOME: "/home/acme",
  GEMINI_API_KEY: "AIzaFAKE", ANTHROPIC_API_KEY: "sk-ant-FAKE", OPENAI_API_KEY: "sk-FAKE",
  AWS_SECRET_ACCESS_KEY: "FAKE", GITHUB_TOKEN: "FAKE", SSH_AUTH_SOCK: "/tmp/FAKE",
};
const got = adapterEnv("prj_acme", "spike", { source: fake });
const show = (n, note) => console.log("    " + n.padEnd(24) + (got[n] !== undefined ? "PASSED" : "not passed") + (note ? "   " + note : ""));
console.log("  a synthetic shell, through the rc'"'"'s own adapterEnv():");
show("GEMINI_API_KEY", "(vendor namespace)");
show("ANTHROPIC_API_KEY", "(vendor namespace)");
show("OPENAI_API_KEY", "(vendor namespace)");
show("AWS_SECRET_ACCESS_KEY", "(layer 1 narrowed this out)");
show("GITHUB_TOKEN", "(layer 1 narrowed this out)");
show("SSH_AUTH_SOCK", "(layer 1 narrowed this out)");
console.log("    ISOCAN_HARNESS=" + got.ISOCAN_HARNESS + "  ISOCAN_SESSION_ID=" + got.ISOCAN_SESSION_ID);
' 2>&1 || echo "    (adapterEnv could not be imported in this node; see the file directly)"

# The same question about the shell THIS script was launched from: names only,
# because a name is not a credential and a value is.
echo
echo "  vendor-prefixed names in the launching shell (names only, never values):"
node -e '
const P = ["ANTHROPIC_","CLAUDE_","OPENAI_","CODEX_","GEMINI_","GOOGLE_API_","PI_"];
const hits = Object.keys(process.env).filter((n) => P.some((p) => n.startsWith(p))).sort();
const keyish = hits.filter((n) => /KEY|TOKEN|SECRET|CREDENTIAL/.test(n));
console.log("    " + hits.length + " name(s) match the passed prefixes; " + keyish.length + " look like a credential:");
console.log("    " + (keyish.join(", ") || "(none)"));
'

# Is there a route a BADGE can call to obtain or spend a provider credential?
echo
ROUTES="$(grep -rhoE 'app\.(get|post|put|delete|patch)\(\s*"[^"]+"' "$REPO"/packages/server/src/*.ts 2>/dev/null \
  | sed -E 's/.*"([^"]+)"/\1/' | sort -u)"
TOTAL="$(echo "$ROUTES" | grep -c .)"
HITS="$(echo "$ROUTES" | grep -iE 'token|/mint|apikey|api-key|credential|secret' || true)"
row "an HTTP route mints or returns a provider key" \
  "$([ -z "$HITS" ] && echo no || echo yes)" \
  "$([ -z "$HITS" ] && echo "none of $TOTAL routes match token/mint/apikey/credential/secret" || echo "$HITS")"

KEYFILE="$(node -e '
const os=require("os"),path=require("path"),fs=require("fs");
const dir=path.join(os.homedir(),".isocan","voice");
try{for(const f of fs.readdirSync(dir)){const st=fs.statSync(path.join(dir,f));
if(/key/i.test(f))console.log(path.join(dir,f)+" mode="+(st.mode&0o777).toString(8));}}catch{}
' 2>/dev/null)"
echo "  voice provider key on this machine: ${KEYFILE:-(none stored)}"
echo "  custody rule (packages/voice-agent/src/live.ts): the harness opens the"
echo "  socket and holds the key; the page only ever sends audio to loopback."

# ------------------------------------------------------------------ VERDICT --
say "The table"
printf '  %-46s %-6s %s\n' "QUESTION" "ANSWER" "DETAIL"
for r in "${ROWS[@]}"; do echo "  $r"; done
echo
echo "  $PASS answered, $FAIL unresolved."
echo
cat <<'READING'
  How to read this. Authority and spend are separate channels, and the
  answers differ:

    AUTHORITY  An enrolled agent's rung is its badge's admission for the
               canvas, and `rungOfAdmission` reads a `created` admission as
               `own` whatever the actor asking. `heldRung`'s actor narrowing
               applies only to the FLOOR that raises a non-own admission, so
               it never bites here. That is deliberate and the code says so:
               "agents hold what their person holds", and a pass is "the
               minter's standing, handed on ... at the minter's rung".

    SPEND      No badge can spend. There is no token-mint route, and
               `meter.ts` counts badge MINTS, not money — in memory, one
               instance, and a restart forgives everybody. What spends is the
               environment the rc hands a summoned adapter: the vendor
               namespaces in `adapterEnv`'s passed prefixes, decided 11 Sep
               from docs/research/2026-09-10-what-the-rc-hands-over.md. Layer
               1 narrowed that from the whole shell to a list; layer 3
               (`rc --sandbox`) fences it, and is opt-in by decision D1.

  So the honest sentence is: an enrolled agent holds its owner's AUTHORITY by
  construction, and reaches its owner's PROVIDER CREDENTIALS by environment —
  and the second is not the badge's doing. Who may START a turn is the lever
  the design already built for that (#238, owner-only summons), in the note's
  own sentence: "the canvas may narrow; it may never spend."
READING
exit 0
