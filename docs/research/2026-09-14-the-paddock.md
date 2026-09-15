---
status: designed
since: 2026-09-14
see: standing-agents, on-demand, agent-custody, sheep-harness, room, memory, inbox, harnesses
note: asked 14 Sep 2026 — a registry of MY agents, attached to me rather than to a canvas, and "have @Name join" from anywhere. Found that every piece exists except the one that matters: enrolment is per-canvas by construction, and the only account-scoped list of agents is `~/.isocan/rc-agents.json`, which is machine-scoped, not account-scoped, and dies with the laptop. The recommendation is that the PERSONAL CANVAS is the registry — it already exists, is private, per-owner, per-home, replicated and has an oplog — so a paddock needs no new storage primitive, and the Inbox reads it for free. Three tiers of "always available" are ordered by what they cost, and only the first needs no new argument. The naming risk is called out: `paddock` sits next to sheep's `pasture` and this bridges more than sheep.
---

# The paddock — my agents, and getting one to join

**14 September 2026.** Research, in the form
[sheep-as-standing-agents](2026-09-08-sheep-as-standing-agents.md) used.
Nothing built.

> "As a user I add my agents to the system. I want a registry of them that I
> can find attached to my account and profile. Then, how can I, from a
> project, say 'Have @Name join' from various spots even chat, and agents
> panel etc. This is where I think be able to have a sheep that is always
> available. If possible wake up / connect back to the agent and bring it in
> to the canvas. Consider a special personal canvas that's like the Unix `~`
> directory that has a paddock of agents where you can see what's happening
> … that can tie into the Inbox etc."

Sources: this repository as of `c6ade95c`, and the six projects that already
own pieces of this.

## The short answer

**Three of the four asks are assembly, not invention. The fourth — "always
available" — is a cost decision that has been deferred twice and is still
deferred here, on purpose.**

- A **registry attached to you** does not exist and should not be a new
  store. The personal canvas already is one.
- **"Have @Name join"** is one new op and three call sites. The hard part is
  not the gesture; it is what happens when nothing is listening.
- **"Wake up / connect back"** works today only while a laptop is open. Making
  it work otherwise is [the 8 Sep note's](2026-09-08-sheep-as-standing-agents.md)
  question, unanswered: who pays to hold a socket, or whose credential lives
  in a cell.
- The **paddock canvas** is the best idea in the ask, and it is the one that
  makes the other three cheap.

## What exists, and where the seam is

An agent record is deliberately split along custody, and the split is the
thing to understand before proposing anything:

| Half | Where it lives | Scope | Survives |
| --- | --- | --- | --- |
| **Standing** — which agents answer here, and their rules | canvas state, via `agent.enroll` / `agent.withdraw` | **one canvas** | anything; it is in the oplog |
| **Running** — harness, cwd, ACP session handle | `~/.isocan/rc-agents.json` | **one machine** | until the machine dies |
| **Identity** — the actor the agent speaks as | claimed under `agent:<hmac>`, keyed by `~/.isocan/agent-secret` | **one machine** | until that file is lost |

`packages/core/src/ops.ts` states the rule for the first: standing lives in
canvas state *"because everything that must see it already reads canvas
state"* — `@Sian` resolves through `mentions.ts`, the tray reads the snapshot,
a parked rc hears the op land. `packages/cli/src/rc.ts` states it for the
second: only this machine can honour a `cwd`, so that half *"never
replicates"*.

**Both rules are right, and between them there is no list of "my agents".**
The closest thing is `rc-agents.json`, and it is the wrong scope twice over:
it is per machine rather than per person, and `agent-custody`'s own Open
section already names the consequence — *"A dead machine's agent: the actor's
claim sits on the dead laptop's badge; a successor machine cannot claim it
unvouched."* `standing-agents` closed all four phases with the same piece
left: *"the actor credential for a second machine is the piece deliberately
left."*

So the gap the ask names is a gap two finished projects already wrote down.
That is the strongest evidence it is real.

### What "add my agents" means today

`AddAgent.tsx` carries the constraint in its own heading: **"No rc, no
button."** Adding an agent requires a visible parked `isocan rc` on *this*
canvas, owned by *you* (owner-only summons, 11 Sep). The dialog sends a name
to that rc, which makes the two moves `isocan agent add` makes. There is no
path that starts from "an agent I already have" — every add starts from a
machine that happens to be parked here, and produces standing on one canvas.

Doing that on five canvases is five adds. The agent is the same agent; the
system has no way to say so.

## The recommendation: the personal canvas is the registry

`isocan context personal` already creates **one private canvas per owner per
home** (memory phases 0–5, verified 13 Sep). It is a canvas: it has items,
comments, threads, an oplog, replication, grants, and a home that is
authoritative for it. It is already the `~` in the ask.

**Put the agent records on it as items, and the registry needs no new
primitive at all.** Specifically:

- An agent in your paddock is an **item** whose `properties.kind` is `agent`,
  carrying the name, the harness, the actor id, and where its key came from.
- The paddock canvas is the **account-scoped** thing the ask wants, because a
  personal canvas is per *owner*, not per machine — and a second machine that
  proves the same address reaches the same paddock.
- Its **oplog is the history**: enrolled, withdrawn, woken, failed to wake,
  each an op, each replayable, each visible in `isocan recap`.
- The **Inbox reads it for free.** The Inbox already reads every canvas
  through its authoritative home; a paddock is a canvas, so agent activity
  arrives in the Inbox with no Inbox change whatsoever.
- **What's happening** is `roster()` — the same derivation `isocan who`, the
  tray and the workbench already share. Three surfaces, one answer; a fourth
  costs nothing.

This is the move that makes the rest cheap, and it is worth saying why it is
not merely convenient: **a registry that is a canvas inherits every property
the team has already argued about** — custody, grants, replication, undo,
recap, the door. A registry that is a new table in the daemon inherits none of
them and will spend a year growing them back.

### What it does NOT solve

Two things, and they must not be papered over:

**The machine-local halves stay machine-local.** A paddock row can say "Percy
runs claude-code in `~/code/isocan` on Dion's laptop". It cannot make a second
machine honour that `cwd`, and it must not pretend to. The paddock holds the
*standing* and the *identity*; the *running* half stays where `rc.ts` put it,
and a row whose machine is not present is a row that says so.

**`agent-secret` is still the thing that dies with the laptop.** Putting the
row on a canvas does not move the HMAC secret. A second machine reaching the
same paddock sees the same agents and still cannot claim their actors. That is
the `standing-agents` residue, and the paddock makes it *visible* rather than
solving it — which is an improvement, because today it is invisible until the
laptop dies.

## "Have @Name join" — one op, three call sites

The gesture is small once the registry exists. Proposed:

```
{ type: "agent.invite"; agent: Actor; from: string /* paddock canvas id */ }
```

sent to the **target** canvas, where `from` records which paddock vouched for
it. It is `agent.enroll` with a provenance field and a different door: enroll
says *"this actor answers here"*, invite says *"this actor answers here, and
here is the registry that says it is mine"*.

Three surfaces, all of which already have the pieces:

1. **Chat** — `findCommandSpans` already parses start-of-line verbs, and
   `findMentionSpans` already resolves `@Name` against candidates. Typing
   `@Percy join` in the main thread is a command chip; the candidates list
   gains your paddock's agents beside the canvas's own actors.
2. **The agents panel** — `AgentTray` already renders `roster()`. It gains a
   section above Add: *your paddock*, with agents not yet standing here and a
   Join beside each. **This is what replaces "No rc, no button"** for agents
   you already own — the rc is still required to *run* the agent, but no
   longer to *name* it.
3. **The command palette** — `CommandPalette` already groups by Recent /
   Everything else and already reads `readRecents()`. A paddock is a source of
   rows like any other.

**Ordering matters here.** Invite must be a distinct op rather than a flag on
enroll, for exactly the reason `item.pruneVersions` is distinct from a loop of
`item.removeVersion` (14 Sep): an older daemon must **refuse** a precondition
it does not implement rather than silently ignoring the provenance half. And
`op-types` is a bounded vocabulary — 36 today, with the architect persona
requiring the argument to be written down — so this is a bound move that has
to be argued, not assumed. One op, not three.

## "Always available" — three tiers, and only the first is free

This is the ask's hard half and the place to be most honest. **Today a summons
reaches an agent only while an `isocan rc` is parked on that canvas**, which
means a laptop with the lid open. "Wake up / connect back" is not a feature
that is missing a button; it is a socket that is not held.

The 8 Sep note ordered the shapes and the order still holds. Restated against
what has been built since:

### Tier 1 — the paddock says who is reachable, honestly

**No new mechanism. Build this first.** The paddock row shows each agent's
true state: standing here, standing elsewhere, or *its machine is not
present*. `roster()` already computes the first two; the third is the absence
of a parked rc, which the tray already knows.

This sounds modest and is not. Today the failure mode is a summons into
silence — you ask, and nothing happens, and nothing says why. A registry whose
rows are honest about reachability converts that into a legible state before
any socket is held. It also gives "wake up" somewhere to report failure *to*.

### Tier 2 — a hosted rc, when overnight matters

`sheep new -- "run isocan rc against this home, parked on these canvases"`.
Room phases 0–4 made this materially more plausible than it was on 8 Sep: the
room is now `runRoom(deps)` in `@isocan/rc`, with nothing under it importing
`node:*`, and a browser-platform bundle that builds. **No host is built** —
room's design says so explicitly, and says the custody argument for a room
nobody started *"is that host's project to make"*.

The cost is the honest part, unchanged from 8 Sep: **a parked long-poll is not
idle.** You are renting a machine to hold a socket, which is the thing cells
exist to stop needing. It buys agents that answer at three in the morning.
That is a real thing to want and it is not free.

### Tier 3 — the summons calls the cell

Zero idle cost, which is what a cell is *for*. Needs the withdrawn address
hook reopened and the questions that killed it answered rather than routed
around: what sets the address, what "the session ends" means, and who is
executing as whom. **Worth doing eventually. Not worth doing first, and not
worth doing quietly.**

### The decision that gates 2 and 3

Unchanged and still unmade: **a sheep needs a badge at the isocan door**, and
it is the same question as `ISOCAN_BEARER` — a long-lived credential that can
write to a canvas from anywhere, living somewhere until somebody revokes it.
The door already judges badge-less `/api/` requests and exempts a bearer, so
the *shape* is settled; the blast radius is not. Deciding it in two places is
how a credential ends up with two settings pages and two revocation stories.

**The paddock gives that decision a home it did not have.** A long-lived
credential needs a place a person can see it and revoke it; "your profile" was
hand-waving, and a paddock canvas is a real surface with real grants.

## Decisions to make before building

1. **Is the paddock the personal canvas, or a canvas beside it?** Recommend
   *the* personal canvas, with agents as a kind of item. A second private
   canvas per person is a second thing to explain, and memory phases 0–5
   already taught the personal canvas to be private by construction.
2. **What is an "account"?** isocan has no accounts; it has actors at homes,
   and a proven address (`Prove your address`) is what makes two machines one
   person. The paddock is therefore **per person per home**, and the
   multi-home story is the Inbox's, which already answers across homes.
3. **Does a paddock row confer standing anywhere by itself?** Recommend **no**
   — joining stays an explicit act on the target canvas. A registry that
   silently enrols is a registry that grants reach nobody asked for, which is
   the fence `agent-custody` spent a project building.
4. **The name.** `paddock` sits directly beside sheep's `pasture`, and the 8
   Sep note's own warning is *"whatever bridges these two projects needs its
   own word on the first day, not the day after."* This bridges more than
   sheep — claude-code, codex, pi and antigravity are all harnesses here — so
   an ovine word is wrong twice: it collides, and it over-claims. Candidates
   worth a minute: **roster** (already the function name — collides),
   **bench**, **desk** (taken: the desk is the door's actor side), **kit**,
   **stable**, **crew**. Dion's word wins; this note only insists the choice
   is deliberate.

## Phases, if it is taken up

- **0 — the paddock reads.** Agents as items on the personal canvas; `isocan
  agents` lists them with honest reachability; the tray shows them. No new
  op, no joining. Ends when a person can see every agent they own in one place
  on both surfaces.
- **1 — join from the panel.** `agent.invite`, the `op-types` bound moved with
  its argument, the tray's Join, and a refusal that says what is missing when
  the agent's machine is absent.
- **2 — join from chat.** `@Name join` as a command chip; paddock agents join
  the mention candidates.
- **3 — the paddock is written by enrolment.** Enrolling an agent anywhere
  adds its row, so the registry fills itself rather than being kept by hand.
- **4+ — tiers 2 and 3.** Not scheduled here. Each needs its own argument, and
  tier 3 needs a design review, not a phase.

## What this leaves open

- **The dead machine.** The paddock makes it visible; it does not make a
  second machine able to claim an agent's actor. `agent-custody`'s Open entry
  stands, and *"waits for a real occurrence"* is still the right answer.
- **Whether `@Name join` should be able to wake tier 2.** If a hosted rc
  exists, "join" and "wake" stop being separable, and the refusal copy written
  in phase 1 becomes wrong. Worth writing phase 1's refusals so they survive
  that.
- **Cost, stated to the person.** If a paddock can start something that bills,
  the row is where the price belongs. Nothing in isocan has had to say that
  yet.
