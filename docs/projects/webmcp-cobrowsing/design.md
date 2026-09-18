# WebMCP co-browsing

**18 September 2026.** Design (#isocan-hsr). Nothing built. The project's
status lives in [journey.md](journey.md)'s front matter; the walk is
[phases.md](phases.md); this doc is the argument.

The thesis in one line: **a browser agent and a human share one live canvas
session, with no bridge, because the tools run inside the page the human is
already on — the page already IS the session.**

The registration (11 Sep) named this project as the browser-native transport of
a vocabulary that already exists. This design is what the census — re-read and
executed on 18 Sep — says that transport must be, and what it must not become.

## 1. The census, re-read

The 11 September registration said "six read tools, the write half waits on
addressability". That was two generations stale by the time this design was
written, and the difference is the whole argument, so it is recorded here as
measured rather than read.

- **`@isocan/mcp` has sixteen tools.** A real stdio handshake on 18 Sep
  (`initialize` + `tools/list` against `node packages/cli/bin/isocan.js mcp`)
  answered `isocan 0.1.0` with sixteen tools: ten reads (`list_canvases`,
  `read_canvas`, `read_context`, `read_context_content`, `read_item`,
  `read_threads`, `read_activity`, `who`, `read_context_summary`,
  `read_personal_context`) and six writes (`claim_agent`, `create_item`,
  `edit_item`, `post_comment`, `reply_comment`, `wait_for_feedback`). The write
  half is built; the addressability question was answered by `claim_agent` and
  by the embed project's settled rule — **the person by default, a deliberately
  claimed session when an agent means to stay and be addressed**
  ([embed/phases.md](../embed/phases.md), "Who is an agent that arrives over
  MCP — settled").
- **The vocabulary is one reducer's.** 28 `Operation` types in
  [`packages/core/src/ops.ts`](../../../packages/core/src/ops.ts); every write
  tool above resolves to existing operations (`item.add`, `item.addVersion`,
  `thread.create`, `thread.reply`, `actor.claim`) through `@isocan/api`. No
  tool invents a mutation path, and this design adds no operation.
- **Presence is the ephemeral plane.** A tab beats `cursor`, `selection` and
  `textSelection` on the per-canvas socket
  ([`packages/core/src/protocol.ts`](../../../packages/core/src/protocol.ts),
  `ClientMessage.presence`); the roster is readable at
  `GET /api/projects/:id/sessions`; nothing there is stored, oplogged, or undone.
- **The browser API moved.** The registration cited `navigator.modelContext`
  and "the spec lacks read-only/destructive annotations". Neither is true now:
  the interface is `document.modelContext`, `provideContext()` is gone, and the
  spec's `ToolAnnotations` carry four hints. §3 below is the current API,
  measured on this machine as well as read.

## 2. What this project is, precisely

Shape B's vocabulary moved into shape A's session
([embed/journey.md](../embed/journey.md)'s four shapes): the same sixteen tools
the stdio MCP server offers, registered on the isocan page itself, so a browser
agent — one that lives where the canvas is already open — calls them without a
process, a config file, or a second identity.

It is **not**: a new operation vocabulary; an autonomous offline planner; a
voice variant (Track A); the browser extension (Track C); or MCP Apps (embed
phase 3). The tools act on the live canvas the person is looking at, and the
person watches them act.

## 3. The transport, as it actually is

Measured on 18 September 2026, on two Chromes on one machine:

| | Chrome for Testing 150.0.7871.24 | Google Chrome 152.0.7977.82 |
|---|---|---|
| `document.modelContext` with no flags | **object** | **undefined** |
| with `--enable-features=WebMCP` | object | **object** |
| with `--enable-blink-features=WebMCP` | object | object |
| prototype | `registerTool, getTools, executeTool, ontoolchange` | same |
| `document.featurePolicy.allowsFeature("tools")` | true | true |

The API, per the [Chrome explainer](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
(updated 11 Sep 2026) and the
[CG draft](https://webmachinelearning.github.io/webmcp), and confirmed by
running it:

- `document.modelContext.registerTool({ name, description, inputSchema, execute, annotations? }, { signal?, exposedTo? })`
  — `inputSchema` is JSON Schema; `execute(args, { signal })` may be cancelled.
- `document.modelContext.getTools({ fromOrigins? })` — same-origin documents by
  default; `toolchange` fires when the list changes.
- `document.modelContext.executeTool(tool, input, { signal? })`.
- `annotations`: `readOnlyHint`, `untrustedContentHint`, `consequentialHint`,
  `debugging` — all default false. The browser may use `consequentialHint` to
  force a user confirmation; the agent uses the other three to reason.
- Gating: origin-isolated documents only (`document.domain` disables it), and
  the `tools` Permissions Policy, which defaults to `self`; cross-origin
  iframes need `allow="tools"` **and** an explicit `exposedTo` origin.
- Availability: origin trial from Chrome 149; local development via
  `chrome://flags/#enable-webmcp-testing`, which is the `WebMCP` feature above.
  This machine's stable 152 answers with the flag, not without it.

**Two measured gotchas this design has to carry.** `executeTool` on the 150
build rejected `executeTool(tool, { a: 2, b: 3 })` with
`UnknownError: Failed to parse input arguments` and accepted
`executeTool(tool, '{"a":2,"b":3}')` — the input is a **JSON string**, however
the docs' example reads. And a returned tool's `annotations` elide the false
hints: registering `{ readOnlyHint: true, untrustedContentHint: false,
consequentialHint: false }` came back as `{ readOnlyHint: true,
untrustedContentHint: false }`. Both are pinned in phase 0 of the walk, because
a surface built on the docs' prose instead of the shipped behaviour would have
failed on its first call.

## 4. Who the agent is

The one decision this transport forces is a different answer from stdio, and it
is answered by the product's own rules rather than invented here.

- **An anonymous writer is refused.** Presence is honest and `undo` is
  per-actor; a write with no actor is the thing isocan does not have.
- **The person is not the agent.** A write as the person cannot be @-addressed,
  wakes nobody, and mixes the agent's work into the human's history — exactly
  the reason the MCP write half is not ambient for a collaborating agent.
- **So: reads ride the page's own session; a collaborating agent claims a name.**
  The page registers read tools under the tab's badge — the person looking at
  their canvas is reading it, and asking them to name themselves to read is a
  gate the CLI never had. The six write tools are registered only when the page
  holds an **explicitly claimed agent session**, in the same durable registry
  `isocan identity --session` and MCP's `claim_agent` write to. `claim_agent`
  itself is the claim: consequential, the person's deliberate act, never
  automatic.
- **Co-presence is the point.** The claimed agent appears in presence with its
  own face and name, so the human sees who is acting; its writes are stamped
  with its actor; `undo` takes back that agent's work and not the human's. The
  browser agent is not a ghost in the person's tab; it is a participant with a
  name.
- **The badge is the ceiling.** The page's tools can do exactly what the tab's
  badge can already do — no more. The agent gains no route, no admission and no
  authority the person's own tab did not have. WebMCP widens the *audience* of
  the page's session, never the session's power.

## 5. Deixis: the page knows what the human is looking at

The co-browsing value is not that the agent can read the canvas — stdio MCP
already does that — it is that the agent can act on **what is in front of the
human**. The page holds that fact natively: the selected items, the item open
full screen, the viewport's locus. Presence carries the same facts ephemerally
(`cursor`, `selection`, `textSelection`), so the rest of the canvas can see the
human's locus without any new channel.

The rules that keep this honest:

- **A default, not a coercion.** "Add this to the canvas" / "comment here" mean
  the current selection; an explicit id always wins. The tool's description
  says which selection it will use, and the page shows the call.
- **Read from the live page, never replayed.** Deixis is the tab's state and
  the ephemeral plane. It is never written into an op, never stored, and never
  reconstructed from the oplog — a replay has no cursor.
- **The human's locus is the human's.** A tool reads the selection of the tab
  it runs in. It does not go looking through the roster for other people's
  selections, and nothing about the person's other tabs, history or files is
  reachable from here.

## 6. The tiers

Every tool gets the hints the spec asks for, and each hint is a claim the code
already makes:

- **`readOnlyHint: true`** on the ten reads. They call routes, never the
  reducer; none needs a write session.
- **`readOnlyHint: false`** on the six writes, each of which is an existing
  operation.
- **`untrustedContentHint: true`** on **every tool whose result contains text a
  person or agent wrote** — canvas items, threads, comments, activity, personal
  context. To the tool author that content is untrusted by construction, and
  the hint is what lets the client delimit or spotlight it. The comments and
  Chat tools are the sharpest case: a reply body is exactly where an injection
  would ride. Reads that return only ids, names and positions
  (`list_canvases`, `read_canvas`'s structural half, `who`) do not need it.
- **`consequentialHint: true`** only where the product says the act is not
  undoable: `claim_agent` (the registry, not the oplog) and any future
  operator-tier act. Canvas writes are **not** consequential in this sense —
  they are ordinary operations with per-actor `undo`, and marking them
  irreversible would teach the agent to distrust the product's own undo.
- **The approval line is the surface's shape, not a prompt.** The exposed
  sixteen tools contain no `trash.empty`, no `project.delete` and no operator
  act; the personal-context reads keep their existing consent check (an
  explicit authorized session, rechecked per call). An approval is something
  the person does in the product — a claim, a consent, a Share — never a
  confirmation dialog the page invents.
- **`debugging`** stays false: these are product tools, not diagnostics.

## 7. Cancellation, concurrency and the human's own edits

- `execute`'s `AbortSignal` is passed into `@isocan/api`'s existing `signal`
  parameters, so a cancelled tool call stops its HTTP work; the ops themselves
  are atomic, so a cancelled call has either landed or not — there is no
  partial write to clean up.
- `wait_for_feedback` already polls with a 60-second bound and honours
  cancellation, and the presence beat is where a mid-turn cancellation already
  reaches an agent (`PUT /api/projects/:id/sessions/:sid` answers `cancelled`
  for a thread the caller is on). A WebMCP `execute` bound to that same beat
  means the human's own "stop" reaches the tool, not just the agent loop.
- A human editing while the agent writes needs no new mechanism: every write is
  an operation against the same reducer, ordered by the same log. The design's
  obligation is visibility — the agent's face in presence and its name on the
  version — not locking.

## 8. Degradation, unsupported browsers, and the framed case

- **Feature-detect, register nothing, say one sentence.** Where
  `document.modelContext` is absent (the measured no-flag 152 case), the page
  runs exactly as it does today with no errors and no dead affordance; the
  canvas does not mention WebMCP unless asked. The stdio MCP server remains the
  path for agents that can be configured, and it is unaffected.
- **The framed embed is the cross-origin case.** An isocan canvas framed in
  another origin gets no tools unless the frame carries `allow="tools"` *and*
  the registering document lists that origin. Same-origin frames in the app's
  own tree need no such grant. The default is off, deliberately.
- **Headless automation is not the target.** The API's own limitations say it
  is designed for a human in the loop; a page that only ever runs headless will
  find no agent to register for, which is correct.

## 9. What this design does not do

- No new operation, route or credential. The surface is the sixteen tools.
- No secret ever crosses it: tools return the same bounded, content-addressed
  reads the API already returns, and nothing reads the tab's badge or key.
- No history, no other tabs, no other people's selections.
- No MCP Apps, no extension, no offline planner, no voice.
- No automatic claim: the agent's name is the person's act, once.

The walk that proves each line is [phases.md](phases.md).
