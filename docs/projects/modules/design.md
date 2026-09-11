---
status: partial
since: 2026-09-04
see: modules, extensions, workbench, mindmap, iso-api, atlas
note: designed 4 Sep from the research note's counts; phases 1 (the registries, the mind map as the first internal module), 2 (Mermaid, the first node-type module — the union paid), 3 (runtime loading — module add/rm/ls, a host object, no import map) and 4 (documents — the inspector, page and command slots; the prose editor deferred) built 4–5 Sep; phase 4.5 (WebHost, overlays, drops, the module API's own version and a PROPOSED list) built 9 Sep from #156's field report. Phase 5, sandboxes, waits on three gates: the content origin (CLEARED 6 Sep, live on prod), extension actors (which extensions stage 4 found has no subject to attribute until a panel ACTS, so it waits on that rather than on the calendar) and compute consent. Transportable compute registered 11 Sep as future work, not implemented: one digest-pinned project tool suite, pure by default, with cross-host parity and authorised Operation effects
---
# Modules — a package that contributes to both surfaces, and can be taken away

*This is the argument. To build one, read [`authoring.md`](authoring.md):
the layout, every extension point and its exact shape, the host, the build,
the install, and the guards.*

**4 September 2026.** The ask: *let's have a module system, and can we make
it dynamic so external modules can be loaded and unloaded outside of core?*
The [research note](../../research/2026-09-04-modules.md) counted what that
costs today and what makes it possible; this is the design it argued for, made
concrete enough to build, with the first phase built the same night.

## The sentence

> **A module is a package that contributes to the registries on both surfaces
> at once, and that can be removed leaving every item it made still readable
> as a file.**

Both halves are load-bearing. The first is the isomorphism applied to
packaging: a module that ships a renderer and no verb is the web-only feature
AGENTS.md forbids, in a box. The second is what makes *add and remove* honest
rather than a slogan, and it is already true of the data model — an item is a
file with a mime type and a property bag, the 33 operations know nothing about
kinds, and a canvas whose module is gone renders as files.

The rule a module lives under is the extensions design's rule, one step out:

> **A module may only add what a person could already do with a file and a
> verb.**

A new kind is a file with a new mime. A new panel is a list the CLI can
already print. A new tool is a gesture whose intent has a verb. A module that
cannot be described that way is asking for a product change — and product
changes are made in the product, with an op if they need one, never in a
module.

## What a module is made of

One package, `packages/modules/<name>/`, three entry points, each for the
surface that loads it:

| Entry | Loaded by | What it holds |
| --- | --- | --- |
| `core.ts` | both, through the other two | the pure facts: property keys, the functions that read them, and **the `CoreModule` record** — what this module contributes to core's registries (context pieces, edges, kinds) |
| `web.tsx` | the web shell's list, `packages/web/src/modules.ts` | components the shell mounts in its slots — today an *underlay* drawn inside `.world` under the items; next a *renderer* keyed by mime, a *panel*, a *page* |
| `cli.ts` | the CLI's list, `packages/cli/src/modules.ts` | `register(host)`: a verb family hung on the same commander program, through a **host** that hands it the CLI's own helpers; and the module's **guide section**, printed inside `isocan --agent-help` only while the module is loaded |

The two lists are the whole coupling. A distribution's modules are the
entries in those two files; everything else about a module is inside its own
directory. **The removability test is literal:** delete the module's
directory and its two list entries, and `npm run build`, `npm test` and
`isocan --help` all agree the feature never existed. A guard in `test/`
holds the weaker, mechanical half of that — a module's name may appear
outside its directory only in the two lists, the lockfile and the docs.

### Core's registry

`core/modules.ts` is small on purpose. `registerModule(record)` and
`modules()`; a module's record names what it contributes:

```ts
interface CoreModule {
  name: string;                                     // "@isocan/mindmap"
  propertyKeys?: readonly string[];                 // the keys it owns — namespaced, forever
  contextPieces?: (canvas) => ContextPiece[];       // rows in `isocan context` and the Context view
  edges?: (canvas) => { from: Item; to: Item }[];   // lines the canvas draws; edges JSON Canvas exports
  kinds?: readonly ModuleKind[];                    // phase 2: a mime, a label, a noun, an icon name
}
```

Core reads the registry where it used to call the mind map by name: the
context pieces walk asks every module for its rows; the JSON Canvas exporter
asks every module for its edges. **Core imports no module.** The web shell
and the CLI register each module's record from their lists, so a surface that
does not load a module gets a core that has never heard of it — which is the
only way "removed" can mean removed.

### The web contract

The shell owns the slots and the modules fill them. A slot is a place in the
shell's tree where it maps over `MODULES` and mounts what each contributes,
handing it **facts as props, never stores**: the module's component gets the
canvas and the live drag, not the zustand hooks. That keeps the dependency
pointing one way — a module knows core and React; it does not know the shell.

Slots, in the order they are needed:

1. **Underlay** (built): inside `.world`, before the items, in world units.
   The mind map's lines live here.
2. **Renderer** (phase 2): an entry in `VersionContent`'s chain, keyed by a
   mime test, mounted before the built-in chain so a module can own a mime
   the built-ins would otherwise call a document. Lazy — a renderer is a
   `React.lazy` chunk loaded when its kind is first seen, never at boot.
3. **Page** and **inspector** (phase 4): a cover route of a module's own, and
   a reader beside the workbench's stage.
4. **Overlay** and **drop** (phase 4.5, proposed): screen space against a
   named edge, and a claim on a dragged mime. Both landed because a module
   asked — which is what "each lands when a module asks" meant, and the first
   time somebody outside this repo did the asking.
5. **Panel** and **tool**: still designed and unbuilt. A dock panel or a rail
   tool is a shell change today.

**Reading is free; writing is a slot's own question.** Until 9 Sep every one of
these except `actions` was read-only, which nobody noticed while no module had
an interactive surface. `WebHost` (phase 4.5) is what a component changes
anything through, and it is handed only to the slots a person interacts with.

### The CLI contract

`CliHost` is the set of helpers the CLI's own verbs use and a module's verbs
need: the program, `run`, `ctxOf`, `resolveCanvas`, `resolveItem`, `sendOp`,
`printJson`, `sizeFor`, `placementFor`, `truncate`. Nothing else. A module
that wants more is asking for a helper to be promoted — a review question, not
a private import.

The guide is the same object it always was, with a rule added: `isocan
--agent-help` prints the base guide and then each loaded module's
`agent-guide.md`. `surface.test.ts` reads verbs from `main.ts` **and** from
every module's `cli.ts`, and documented verbs from the base guide **and**
every module's guide. A module verb nobody is told about does not exist,
exactly as before.

## Versioning: two surfaces, one of them frozen

**`MODULE_API_VERSION` is not the app's version** (9 Sep 2026). It was, pinned
by a test to the root package's 0.1.0, which is why the engines check — real
and enforced — had never refused anything: the number it compared against was
a constant.

VS Code can judge `engines.vscode` against the app version because their stable
API has essentially never broken since 1.0; every release is compatible, so the
app version is a safe proxy. Ours breaks. Tying them means bumping the app for
a change nobody outside a module can see, or never bumping — and it was the
second.

So the module API has its own number, moving only when it moves, and a
**proposed** list for the parts we intend to change. A module names the
proposals it uses and a home says yes with `--proposed`. That is the split that
lets the older slots be treated as nearly-stable while overlays, drops and the
host keep moving: fast on one side of the line, careful on the other, and the
line is a list rather than a promise.

## What a module may not add

**Operations, ever.** **Protocol messages.** **Server routes, at first** — a
route is a door and the desk's whole job is that every door runs the same
test; if a second real module ever needs one it is `/api/m/<name>/…` behind
the same badge check. **A hidden store** — module state is an item, visible
and versioned. **Reading the desk.**

## Two trust classes

An **extension** is an item on a canvas, put there by a collaborator, trusted
like one: sandboxed, attributed, revoked by the desk. A **module** is a
package on a machine, put there by the operator of a home, trusted like the
CLI they installed: it runs as the app. The relationship: **a module is the
runtime an extension may need.** Where the module is absent the item is still
there, as a file, and the card can say *made with `@isocan/x`, not installed
here* from the mime alone.

## Dynamic: loading and unloading outside core

The ask's second half. Two shapes, and they are stages rather than rivals:

**Build-time modules** (phase 1, built): a distribution chooses its modules
when it builds — the two lists. isocan.io gets what CI built. A self-hosted
home that wants a different set edits two lines and rebuilds. No loader, no
import map, nothing on disk but the code.

**Runtime modules** (phase 3): a module ships **prebuilt** — `manifest.json`,
`web.js`, `cli.js`, `commands/`, `agent-guide.md` — into
`~/.isocan/modules/<name>/`. The mechanics, decided here so the phase is a
build and not a design:

- `isocan module add <dir | git spec>` copies it in after printing the
  manifest — every kind, verb, panel and page it declares — and refusing
  until `--yes`, the ceremony `command add --from` already has. `module rm`
  removes the directory; `module ls` prints what is loaded and why anything
  was refused.
- **The engines check.** A manifest names the isocan range it was built
  against; a home outside the range refuses that module with a sentence
  naming both versions and loads everything else.
- **The CLI half** is the easy half: before `parseAsync`, the program imports
  each `cli.js` and calls its `register(host)` with the same host build-time
  modules get.
- **The web half** cannot be compiled where it is installed, so it is not
  imported through the bundle. The daemon serves `/api/modules` (the loaded
  manifests) and `/modules/<name>/web.js`; the shell fetches the list at boot
  and `import()`s each file. A runtime module's `web.js` exports
  `activate(host)`, and the **host object** carries `React`, the JSX runtime
  and `core` — so a module is written against the host it is handed rather
  than against an import map the shell would have to emit for hashed chunks.
  Obsidian's shape, read from its docs; the one rule of theirs carried over
  verbatim: *never keep references to views; the factory may be called many
  times.*
- **Unload is the proof.** The acceptance for phase 3 is the Mermaid module
  removed from a home that has a diagram on a canvas: the item renders as a
  file, the card says which module made it, `isocan ls --kind` files it under
  `other`, the `diagram` verbs are gone from `--help`, and the oplog is
  untouched.

## What was decided against

- **A manifest as the only truth**, with the code registering nothing. The
  manifest is what a person reads before `--yes`; the record the code
  registers is what the app runs. Two copies, and a test that they agree, is
  cheaper than a manifest that has to be expressive enough to be code.
- **Modules importing the shell's stores.** It works and it is a dependency
  in the wrong direction; a module that reads `useUiStore` is a shell file
  in a different directory. Facts as props.
- **Wiring modules through an import map** for the web half. The bundle's
  chunks are hashed; an import map would pin React to a URL the next build
  changes. A host object is what every plugin system that survived a major
  version does.
- **Letting a module add an op.** Once, for a good reason, and the vocabulary
  is no longer closed. The mind map, the sprint, areas, context and personas
  each added zero; that is the standard.

## Transportable compute — roadmap registration, 11 Sep 2026

**Future work, not implemented or a complete design.** A person checksums a
file in the browser; an agent repeats it through the CLI and gets the same
answer. Diff and gzip/compression behave the same way. Changing machines does
not change the project's tools, and a missing or changed module refuses to run
rather than substituting a local version.

This extends modules, not a second plugin system. Today's
[`ModuleManifest`](../../../packages/core/src/modules.ts) and
[CLI](../../../packages/cli/src/runtime-modules.ts)/[web](../../../packages/web/src/lib/runtimeModules.ts)
loaders deliver separate, operator-trusted JavaScript halves from a
[machine-local installation](../../../packages/server/src/modules.ts). They
are not a digest-pinned project compute suite. The
[extensions](../extensions/design.md) project's `role=tool` buttons ask for
slash commands; [iso-api](../iso-api/journey.md) is a daemon client. Neither
establishes compute portability. Phase 5's [sandbox gates](phases.md#phase-5--sandboxes)
remain; bounded local computation is not permission to launch agent harnesses
or spend somebody's hosted compute.

### What this scene forces

- **Operations and tools differ.** An `Operation` is the ordered canvas record
  vocabulary. A tool computes a result; it does not extend that vocabulary.
  Every participant uses the identical project suite and pins. An agent's
  private tools are separate and cannot silently substitute for that suite.
- **Admission is separate from download.** Modules may come from project or
  third-party authors, but only project-authorised maintainers may admit them
  or add/replace their pins, after reviewing source/build provenance, licence,
  imports and fixtures. Exact role mapping and the project declaration belong
  in the follow-on design; a participant or module cannot self-authorise a pin
  change. Every host must resolve the same project revision, refusing missing,
  stale or conflicting pins rather than silently upgrading. A digest proves
  byte integrity, not publisher identity, review or safety; admission must
  establish authenticity through a trusted source/release, not a claimed hash.
- **Verify exact pinned bytes BEFORE loading or executing, fail closed.**
  Include executable dependencies; no unchecked URL imports, mutable version
  aliases or host-specific rebuilds masquerading as the admitted module.
- **Pure compute by default, no ambient filesystem, network or state.** Wasm
  is not inherently pure: host imports, WASI preopens and linker capabilities
  determine authority. Exclude credentials, process spawning, DOM access,
  arbitrary host calls and implicit clock/randomness; bound memory, execution
  time, input and output. Failure or exhaustion must not publish partial state.
- **Stateful results/effects land through an authorised Operation**, not a
  second record or hidden store. Rename computes a plan; actual renaming needs
  an authorised host effect and its Operation, never magic Wasm filesystem
  authority. An oplog entry alone cannot undo arbitrary external changes:
  define effect failure/recovery and valid inverse boundaries before enabling
  them, or refuse the effect.
- **SAME module bytes, SAME fixtures and results across CLI, agent host and
  browser, or the portability claim is false.** An agent invoking the CLI is
  a caller of that host, not proof of a third runtime. A genuinely separate
  agent host must run the same fixtures independently. Include corrupt-byte,
  forbidden-import, pin-change and resource-exhaustion refusals in that proof.

### Reuse, without importing another product's protocol

CAP provides source precedents at
[`32ea6822`](https://github.com/PaulKinlan/chrome-agent-platform/tree/32ea6822d893c4267104ef1f5792ee014b60f109):
[package authority](https://github.com/PaulKinlan/chrome-agent-platform/blob/32ea6822d893c4267104ef1f5792ee014b60f109/extension/lib/wasm-package-authority.js)
checks inventory bytes, digests, imports and memory;
[the Wasm host](https://github.com/PaulKinlan/chrome-agent-platform/blob/32ea6822d893c4267104ef1f5792ee014b60f109/extension/lib/wasm-offscreen-host.js#L124-L138)
rehashes before worker creation. Its
[JS sandbox](https://github.com/PaulKinlan/chrome-agent-platform/blob/32ea6822d893c4267104ef1f5792ee014b60f109/extension/sandbox/script-sandbox.js#L208-L307)
verifies all host-supplied dependencies before minting Blob URLs and cleans up
failed loads, with an
[actual-source second-mint regression](https://github.com/PaulKinlan/chrome-agent-platform/blob/32ea6822d893c4267104ef1f5792ee014b60f109/tests/script-sandbox-execution.test.ts#L67-L172).
Reuse that discipline, not its registry protocol. CAP's `ovfm.3` integrity and
cleanup work landed; `ovfm.4` ambient-network confinement is **OPEN and
UNVERIFIED**. This is not a proven no-egress sandbox or an Isocan cross-host
implementation. Admission, host capability boundaries and the parity fixtures
are the next design work; this registration activates nothing.

## Transportable compute — usage examples and the exec question (11 Sep 2026)

*Follow-up exploration for bead `isocan-54k.2`. Builds upon the 11 Sep registration
above without altering its admitted scope.*

### Concrete tool usage: four foundational tools

To ground transportable compute in physical practice, we define four
foundational project tools, answering four mandatory questions for each:
**(1) what it does**, **(2) where its input comes from**, **(3) where its output
lands**, and **(4) what `Operation` it emits** if it mutates project state.

| Tool | (1) What it does | (2) Input source | (3) Output destination | (4) Emitted `Operation` |
|---|---|---|---|---|
| **`sqlite.wasm`** | Queryable relational index and analytical search over tabular data, project metadata, and JSON artifacts. | Item version blobs (`text/csv`, `application/json`) or granted project directory tables. | Ephemeral query results (CLI stdout, agent context, UI table inspector) or a materialized artifact. | Pure query compute: **Zero ops**. Materializing a query result or table export as an item emits `item.add` or `item.addVersion`. |
| **`diff.wasm`** | Deterministic Unified Diff and structural diff generation between text/code versions. | Two content-addressed item version blobs (`v1.blobHash`, `v2.blobHash`) or granted directory file paths. | Transient diff view (workbench `ArtifactStage`, CLI diff output) or saved patch file. | Pure comparison compute: **Zero ops**. Saving a patch artifact to the canvas emits `item.add` (`mimeType: "text/x-diff"`). |
| **`compress.wasm`** (gzip / zstd) | Byte-level lossless compression and decompression for artifact bundling and cold storage. | An item version blob (`blobHash`) or exported canvas collection. | A compressed blob in the content store, or downloaded archive. | Pure compression: **Zero ops**. Associating a compressed archive with an item emits `item.addVersion` (`mimeType: "application/gzip"` or `"application/zstd"`). |
| **`hash.wasm`** (SHA-256, BLAKE3) | Cryptographic digest computation for content-addressed identity, tamper detection, and cross-project deduplication. | Any item version blob, uploaded binary, or streaming chunk. | Digest string returned to caller, or attached to item metadata. | Pure computation: **Zero ops**. Storing the verified digest in item properties emits `item.update` (`patch: { properties: { sha256: digest } }`). |

**Core Rule**: Pure computation emits no operations. State-changing tools
compute their results out-of-band; when the result is admitted to the canvas,
the host emits standard, existing operations (`item.add`, `item.addVersion`,
`item.update`). **The tool computes, the op records.**

---

### The `exec` operation exploration: invocation, determinism, and replay

A central architectural question is whether the closed 33-operation vocabulary
of `@isocan/core` should expand to include an explicit execution record:

```ts
interface ComputeExecOp {
  type: "compute.exec";
  toolId: string;             // e.g. "@isocan/sqlite"
  toolDigest: string;         // SHA-256 of the admitted WASM binary
  inputDigests: string[];     // SHA-256 of all input version blobs
  args: Record<string, unknown>; // Deterministic invocation parameters
  resultDigest: string;       // SHA-256 of output artifact/blob
  outputRef?: string;         // Target itemId or URI if stateful
}
```

If an `exec` record is introduced, it must adhere to three non-negotiable
boundaries:

1. **NEVER re-run computation during oplog replay**:
   - The oplog is an event ledger, not a distributed build execution engine.
   - When a client or agent joins a workspace and catches up on historical
     operations, it **never** re-invokes the WASM binary. It reads the recorded
     `resultDigest` directly from the content store.
   - Re-running computation during replay would impose unbounded CPU costs,
     introduce platform flakiness, and risk divergence if host runtime limits
     differ.
2. **Undo applies to authorized effects, not computation**:
   - You cannot "un-compute" spent CPU cycles or hash operations.
   - Hitting `⌘Z` on the canvas inverts the *effects* produced by the execution
     (e.g., reverting an `item.addVersion` or restoring a deleted card), which
     are already handled by standard oplog inverses (`item.delete`, `item.restore`).
     It does not reverse the historical execution entry.
3. **Determinism must be verified, not assumed**:
   - Compiling code to WebAssembly does not guarantee mathematical determinism.
   - Unseeded pseudo-random number generators, floating-point rounding modes,
     un-ordered hash map traversals, and ambient WASI clock calls
     (`clock_time_get`) produce divergent results across architectures.
   - A tool admitted for `compute.exec` must be certified pure: zero ambient WASI
     clock/randomness imports, pinned memory growth bounds, and deterministic
     algorithm constraints. Any dynamic seed or timestamp must be passed
     explicitly in `args`.

---

### Open design discussion with Dmitry: operator and compute vocabulary

Paul Kinlan proposes raising the operator and compute question with Dmitry
Glazkov. To frame this discussion without re-deriving fundamentals, we record
the three key questions:

1. **First-class `exec` op vs out-of-band tool execution**:
   - *Option A (Pure Out-of-Band)*: Tools run entirely outside the oplog. Only
     their artifact outputs enter the oplog as normal `item.add` or
     `item.addVersion` operations. The oplog remains strictly about canvas
     state.
   - *Option B (First-Class `compute.exec`)*: The invocation tuple (tool digest,
     inputs, args, output digest) is committed as an operation. This provides
     durable provenance ("how was this artifact produced?"), but expands the
     core vocabulary and ledger size.
2. **Primary oplog vs secondary execution receipt ledger**:
   - If execution provenance is valuable, should it live in the primary
     collaborative canvas oplog (`packages/core/src/ops.ts`), or in a separate,
     per-node execution receipt log (analogous to CAP's `action-ledger.js` and
     `durable-runs.js`)?
3. **Execution authorization and quotas**:
   - On a shared multi-user canvas, who holds authority to trigger WASM execution
     on the host daemon? Does an `Editor` grant suffice, or does running
     compute require explicit local machine operator consent to prevent
     denial-of-service?

---

### Interlock: content identity and Track D (watched project files)

A critical architectural dependency links transportable compute to file
watching:

- **Item versions already have content identity**: Every canvas version in
  `@isocan/core` is content-addressed by its immutable `blobHash`. Diffs between
  item versions are portable across machines and projects because the inputs
  are globally identifiable.
- **Granted directory files lack stable content identity**: Files residing in
  a granted local directory (e.g. `isocan watch ./src`) can mutate out-of-band
  on the filesystem. Generating a reproducible diff or checksum over a directory
  file requires that the file's current state be hashed, snapshotted, and
  tracked.
- **Track D Dependency (`isocan-pa5`)**: Providing durable content identity for
  local filesystem files is the core charter of **Track D** (`isocan-pa5: Watched
  project files, change operations and shared canvas collections`).
- **Status**: Track D remains **deferred**. Transportable compute tools operating
  on raw directory paths operate on transient local snapshots until Track D is
  activated; cross-project diff portability is strictly guaranteed for canvas
  item versions today.

---

## Transportable compute — canvas code editor and isolated Python compute host (11 Sep 2026)

*Follow-up architectural design for bead `isocan-54k.3`. Integrates the canvas
code editor and an isolated, single-instance Python compute host across web, CLI,
and agents.*

### 1. Existing source census & research reality

Before designing new compute primitives, we audit the existing repository for
workers, editors, and compute runtimes:

| Capability | Source Census in `isocan` | Measured Finding & Boundary |
|---|---|---|
| **Web Workers / SharedWorkers** | `rg -i "worker" packages/` | **Zero compute workers exist**. The word "worker" appears only in Vitest parallel test runners, the offline service worker shell (`packages/web/public/sw.js`), and collaborative presence sessions (`packages/core/src/onit.ts: Worker`). No Web Workers or SharedWorkers exist in application code. |
| **Code Editors** | `rg -i "editor" packages/` | CodeMirror 6 is mounted in `StageEditor.tsx` / `ArtifactStage.tsx`. It is an artifact text editor for saving item versions (`item.addVersion`). It contains **no code evaluation**, no REPL, no terminal, and no execution runner. |
| **Iodide Status** | External primary audit | **Archived and dormant**. Created by Mozilla in 2018 as an experimental in-browser scientific notebook; officially abandoned and archived in December 2020 (`github.com/iodide-project/iodide`). |
| **Pyodide Status & Size** | External primary audit | **Active and maintained** (`pyodide.org`). However, Pyodide core (`pyodide.asm.wasm` + `python_stdlib.zip`) is **~10–12 MB compressed** and **~25–35 MB uncompressed** in memory. Scientific packages (NumPy, Pandas) add 15–35 MB each. Loading Pyodide per-page or per-card is prohibitive; it must load **per-project lazily**. |

---

### 2. The single-instance architecture: daemon host vs browser SharedWorker

Paul Kinlan specifies that code execution must run in an **isolated, single-instance
runtime**: "if you have multiple windows open, you only want the one instance running",
with equal access across browser windows, the CLI, and autonomous agents.

#### Why a browser `SharedWorker` is insufficient
1. **Violates the Isomorphism Rule**: A browser `SharedWorker` is confined to a
   browser origin. It cannot be called by `isocan run` in the terminal or by an
   agent running via `isocan rc`.
2. **Fragile Lifecycle**: A `SharedWorker` terminates when all browser tabs are
   closed, discarding in-memory kernel state (e.g. loaded datasets, defined
   functions) even if a background CLI command or agent turn is active.
3. **Platform Variance**: `SharedWorker` support varies across browser engines
   and webview contexts.

#### The Architecture: Daemon-Owned Compute Host
Instead of placing the singleton in a browser thread, the **local `isocan`
daemon** (`packages/server/src/compute/`) owns and supervises the project's
compute isolate:

```
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ Browser Window  │   │   Terminal CLI  │   │ Autonomous Agent│
│ (Canvas / Stage)│   │  (`isocan run`) │   │  (`isocan rc`)  │
└────────┬────────┘   └────────┬────────┘   └────────┬────────┘
         │ WebSocket           │ stdio / IPC         │ ACP turn
         ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│                    isocan local daemon                      │
│                  (packages/server/src/)                     │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │           Project Compute Host Supervisor           │   │
│   │   - One isolated instance per project workspace     │   │
│   │   - Execution queue (FIFO, serialized turns)        │   │
│   │   - Output stream muxing (stdout, stderr, MIME)     │   │
│   │   - Memory & execution timeouts                     │   │
│   └──────────────────────────┬──────────────────────────┘   │
│                              │ stdio / WASI pipe            │
│                              ▼                              │
│   ┌─────────────────────────────────────────────────────┐   │
│   │             Isolated Compute Runtime                │   │
│   │      (WASM Host / Pyodide Python Kernel)            │   │
│   │   - Pinned WASM binary & stdlib digest              │   │
│   │   - Zero ambient network or filesystem access       │   │
│   │   - Granted input buffers only; bounded memory      │   │
│   └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**Definition of "Single Instance"**:
- Exactly **one stateful compute runtime per project workspace**, managed by
  the local daemon.
- Multiple browser windows, canvas views, CLI commands, and agents attach to
  the same running project session.
- State (variables, imported modules, defined functions) persists across turns
  within the workspace session, but remains completely isolated between
  different project workspaces.

---

### 3. Isolation, resource ceilings, and capability boundaries

WebAssembly and Python runtimes are not inherently pure; safety requires strict
containment enforced by the daemon supervisor:

1. **Zero Ambient Authority**:
   - **No Ambient Network**: The isolate has no access to sockets, `fetch`, or
     network interfaces. Any external data must be fetched by the host upon
     explicit user grant and passed into the runtime as an input buffer.
   - **No Ambient Filesystem**: The isolate cannot walk the host filesystem or
     arbitrary paths. Access is strictly limited to an in-memory virtual
     filesystem (MEMFS) populated only with granted project item versions.
2. **Resource Ceilings**:
   - **Memory**: Hard ceiling enforced at 512 MB per project isolate.
   - **CPU Time**: Execution deadline (default 30 seconds per cell/invocation).
     If exceeded, the daemon forcibly interrupts or terminates the isolate.
   - **Output Buffer**: stdout/stderr output capped at 2 MB per execution turn
     to prevent buffer exhaustion.
3. **Execution Concurrency & Cancellation**:
   - Computations are queued serially per project isolate, matching standard
     Jupyter / notebook execution semantics.
   - The user or agent can issue an explicit `compute.interrupt` signal. The
     daemon cancels the running turn, flushes remaining queues, and returns an
     `interrupted: true` receipt.
4. **Crash Recovery**:
   - If the compute isolate crashes (due to out-of-memory or a runtime trap),
     the daemon catches the exit, marks the kernel as restarted, and spawns a
     fresh isolate.
   - The oplog is untouched, preventing workspace corruption.

---

### 4. Canvas code-editor module specification

The compute environment is delivered as a first-class project module
(`@isocan/compute`), following the established three-entry module pattern:

1. **`core.ts`**:
   - Declares new MIME kinds: `application/x-ipynb+json` (notebook) and
     `text/x-python` (executable script).
   - Exports property keys for cell execution counts and output digests.
2. **`web.tsx`**:
   - Extends the workbench stage with an interactive **Code Stage**:
     - Code input cells powered by CodeMirror 6 with syntax highlighting and
       keybindings (`Shift-Enter` to execute).
     - Cell output cards supporting rich MIME representations: plain text,
       Markdown, SVG, and PNG plots (using `@isocan/core`'s `VisualFace`).
     - Live execution status badge: `idle`, `running (1.2s)`, `interrupted`, or
       `error`.
3. **`cli.ts`**:
   - Implements `isocan run <itemId>`: evaluates a notebook or script through
     the daemon's compute host from the terminal, streaming stdout/stderr to the
     console and saving output versions if requested.
   - Implements `isocan compute status`: displays active isolates, memory usage,
     and loaded packages.

---

### 5. Replay-safe effect boundary

In alignment with `isocan-54k.2`:
- Interactive code execution in the notebook is an **ephemeral exploration**.
- Running a code cell emits **zero oplog operations**.
- When the user or agent chooses to commit a computation (e.g. saving an
  analyzed table, a generated chart, or an updated script), the host emits
  standard `item.addVersion` or `item.add` operations containing the resulting
  artifact.
- Replaying the oplog never re-executes Python code; it simply renders the
  saved version artifacts.

## Open

- **Unions become strings** when the first module kind lands (phase 2):
  `ItemKind` widens, `KIND_LABEL` and `KindIcon` gain a fallback, and every
  exhaustive switch over kinds stops being exhaustive. Paid on purpose, in
  one commit, with the fallback tested.
- **The guide grows per module.** A module's section is printed only while
  it is loaded, which is the right first cut; printing it only when its kind
  is on the canvas is the short-brief idea and waits for #124.
- **Who runs modules on isocan.io** is the same decision as running
  `release` unattended, which auto-upgrade left open. One answer should cover
  both.
- **`@isocan` on npm.** Git specs work today and need no account; the scope
  is a distribution decision this design does not make.
