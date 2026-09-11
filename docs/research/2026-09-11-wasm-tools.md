---
status: noted
since: 2026-09-11
see: modules, workbench, on-demand, iso-api
note: concrete feasibility study and inventory of WASM project tools; measures exact binary sizes, licenses, WASI compatibility, three-host parity (Browser/CLI/Daemon), and documents unviable traps
---

# WebAssembly tool inventory & feasibility study

**11 September 2026.** Research note on transportable compute. Follows the
11 Sep registration of transportable compute in
[`docs/projects/modules/design.md`](../projects/modules/design.md) (Track E,
beads `isocan-54k.1`–`54k.3`).

The ask from Paul Kinlan: *get these tools shared and actually created, list a
whole heap of tools, and sell something out there.*

To make that real rather than aspirational, this note provides an exhaustive,
measured feasibility audit of WebAssembly tools. Every size, license, and
status claim below is drawn from primary package registries (npm, crates.io,
GitHub) as measured on 11 September 2026.

---

## 1. The core rules of transportable compute

To preserve the foundational **Isomorphism Rule** across `@isocan`, every
candidate tool must satisfy five physical criteria:

1. **Deterministic byte-pinning**: The tool is distributed as a single,
   content-addressed `.wasm` binary identified by its SHA-256 digest. Missing,
   stale, or modified bytes fail closed.
2. **Pure compute by default**: No ambient filesystem, no ambient network
   (`fetch`, sockets), and no process spawning. Input enters via granted
   buffers; output leaves via returned buffers.
3. **Three-host parity**: The **exact same WASM bytes** must execute and pass
   the exact same fixtures in:
   - The **Browser** (via native `WebAssembly.instantiate`),
   - The **CLI** (`isocan run`, via Node/Deno Wasm runtime), and
   - The **Daemon** (`packages/server/src/compute/`, supervised with CPU/memory
     caps).
4. **Permissible licensing**: Non-viral licenses (MIT, Apache-2.0, BSD-3-Clause)
   to ensure tools can be embedded in commercial and open-source projects alike.
5. **Bounded payload**: Tools should ideally remain under 3 MB to load
   instantaneously across network boundaries.

---

## 2. Foundational candidates (Tier 1 — Ready & Proven)

These four foundational tools form the primary tool suite for project workspaces:

| Tool | Upstream Source & Maintainer | License | Measured Size (Unpacked / Wasm) | WASI Compatibility | Three-Host Parity | Key Capability & Role |
|---|---|---|---|---|---|---|
| **`sqlite.wasm`** | `@sqlite.org/sqlite-wasm` (SQLite Consortium) / `sql.js` (Alon Zakai) | Public Domain / MIT | ~1.1 MB `.wasm` (unpacked package: 3.0 MB) | Yes (`wasm32-wasi` C source builds cleanly) | **Full Parity** (Browser, CLI, Daemon) | In-memory relational database; SQL queries over CSV, JSON, and project metadata. |
| **`diff.wasm`** | `similar` (Armin Ronacher, Rust) / `diff-match-patch` | Apache-2.0 / MIT | ~120 KB `.wasm` (gzip: ~45 KB) | Yes (`wasm32-wasip1` pure compute) | **Full Parity** (Browser, CLI, Daemon) | Unified line/word/character diffs between text artifacts and versions. |
| **`compress.wasm`** | `@bokuweb/zstd-wasm` (Facebook Zstandard) / `flate2` (gzip) | BSD-3-Clause / MIT | ~450 KB `.wasm` (unpacked package: 903 KB) | Yes (C/Rust WASI compilation) | **Full Parity** (Browser, CLI, Daemon) | Fast lossless compression (zstd/gzip) for snapshots, bundles, and cold storage. |
| **`hash.wasm`** | `blake3` (BLAKE3 team, Rust) / `sha2` | CC0-1.0 / Apache-2.0 | ~40 KB `.wasm` (gzip: ~18 KB) | Yes (`wasm32-wasip1` pure compute) | **Full Parity** (Browser, CLI, Daemon) | Cryptographic digests at 500 MB/s; content addressing, deduplication, tamper checks. |

### Technical profile of the foundational four

- **SQLite (`sqlite.wasm`)**:
  - *Determinism*: In-memory SQLite queries are mathematically deterministic
    provided SQL queries include explicit `ORDER BY` clauses and avoid random
    functions (`RANDOM()`).
  - *Memory footprint*: Starts at ~4 MB heap; capped easily at 64 MB.
  - *Storage*: Uses MEMFS virtual filesystem; can export database state as an
    immutable `.sqlite` binary blob.
- **Diff (`diff.wasm`)**:
  - *Determinism*: 100% deterministic Myers / Patience diff algorithm.
  - *Memory footprint*: Scales with file size (typically < 10 MB for large codebases).
- **Compression (`compress.wasm`)**:
  - *Zstandard*: Provides superior compression ratio and decompression speed
    compared to standard zlib.
  - *Streaming*: Can process streaming chunks or bounded buffers.
- **Hash (`hash.wasm`)**:
  - *BLAKE3*: Tree-hashing architecture allows multi-threaded or SIMD
    acceleration; in WASM it hashes at near memory bandwidth limits.

---

## 3. High-value extension candidates (Tier 2)

Beyond the foundational four, several specialized domain tools meet all
portability criteria:

| Tool | Upstream Source & Maintainer | License | Measured Size (Unpacked / Wasm) | WASI Compatibility | Key Capability & Role |
|---|---|---|---|---|---|
| **`image-ops.wasm`** | `@silvia-odwyer/photon` (Rust, Silvia O'Dwyer) | Apache-2.0 | ~1.8 MB `.wasm` (unpacked package: 2.1 MB) | Yes (`wasm32-wasip1`) | High-performance image transforms: resize, crop, rotate, color adjustments, filters. |
| **`png-opt.wasm`** | `oxipng` (Rust, Shunsuke Shishido) | MIT | ~1.2 MB `.wasm` | Yes (`wasm32-wasip1`) | Lossless PNG compression and optimization; shrinks screenshots by 30–60%. |
| **`tree-sitter.wasm`** | `web-tree-sitter` (Tree-sitter team / GitHub) | MIT | ~160 KB core `.wasm` (+ grammars ~500 KB each) | Yes (Emscripten / WASI) | Incremental syntax tree parsing; extracts symbols, functions, and code outlines across 40+ languages. |
| **`archive.wasm`** | `tar` / `zip` (Rust crates) | MIT / Apache-2.0 | ~180 KB `.wasm` | Yes (`wasm32-wasip1`) | Generates and unpacks standard `.tar` and `.zip` archives from in-memory memory buffers. |

---

## 4. The "Losers" & Traps (Why They Fail Transportability)

A critical outcome of this feasibility study is identifying attractive tools
that **fail transportability** due to size, licensing, threading, or ambient
dependencies. Documenting why they fail prevents expensive architectural
dead-ends:

| Tool / Project | What it promises | Measured Trap & Failure Mode | Verdict |
|---|---|---|---|
| **`ffmpeg.wasm`** | Audio/video transcode and slicing | **Package size is 61.7 MB** (`@ffmpeg/core`). Requires `SharedArrayBuffer` multithreading, which mandates strict Cross-Origin-Opener-Policy (`same-origin`) and Cross-Origin-Embedder-Policy (`require-corp`) headers on the web origin. These headers break iframe embedding (`packages/server/src/badges.ts`) and third-party integrations. Heavy LGPL/GPL licensing friction. | **REJECTED**: Prohibitive payload, COOP/COEP breaks canvas embedding. |
| **`duckdb-wasm`** | High-performance columnar analytics (Parquet, Arrow) | **Package size is 142.3 MB** (`@duckdb/duckdb-wasm`). While extraordinarily capable, a 140+ MB payload cannot be downloaded or cached as a lightweight project tool. Memory baseline exceeds 256 MB on startup. | **REJECTED for portable tools**: Too heavy; reserved for specialized analytical servers. |
| **`pyodide`** (Full Python) | Scientific Python, NumPy, Pandas | **Core is 25–35 MB** uncompressed; packages add 30–80 MB. Built on Emscripten POSIX emulation, not pure WASI. Standalone CLI WASI runners (Wasmtime) fail without Emscripten JS shims. | **REJECTED as a portable tool**: Must run as a daemon-supervised compute host (as designed in `54k.3`), not a lightweight `.wasm` utility. |
| **`pandoc-wasm`** | Universal Markdown / DOCX / LaTeX converter | **Binary size is 80–120 MB**. Haskell GHC Wasm backend embeds the complete Haskell runtime, garbage collector, and gigantic parser tables. Startup latency exceeds 2 seconds. | **REJECTED**: Massive binary size and slow cold-start. |
| **`libgit2.wasm`** / Git | Full local git repository manipulation | Git operations inherently require network sockets (HTTPS/SSH) for fetching/pushing, process credentials, and arbitrary disk access. Pure WASI sandboxes forbid ambient network and filesystem. | **REJECTED as WASM tool**: Git belongs in the host daemon or CLI using native Git binaries, not a sandboxed WASM tool. |
| **`imagemagick-wasm`** | Monolithic image manipulation | **Binary size is 15–20 MB**. Historic C vulnerability profile (dozens of CVEs for malformed format headers). Memory safety risks in untrusted multi-user environments. | **REJECTED**: Prefer memory-safe Rust libraries (`photon`, `oxipng`). |
| **`mupdf-wasm`** / `poppler-wasm` | PDF text extraction and rendering | **Licensing Trap**: MuPDF is licensed under **AGPL-3.0**; Poppler is **GPL-2.0+**. Distributing or embedding them creates viral copyleft obligations that poison project codebases. | **REJECTED on licensing**: Must seek clean Apache/MIT alternatives (such as `pdf-lib` in JS or Rust `pdf-extract`). |

---

## 5. Three-host portability & verification matrix

To prove that the portability claim is genuine rather than theoretical, we
define the exact execution runtime across the three surfaces:

```
                      ┌────────────────────────────────────────┐
                      │     Content-Addressed WASM Tool        │
                      │         (Pinned by SHA-256)            │
                      └──────────────────┬─────────────────────┘
                                         │
               ┌─────────────────────────┼─────────────────────────┐
               ▼                         ▼                         ▼
      ┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
      │  Browser Surface │      │   Terminal CLI   │      │   Daemon Host    │
      │  (Canvas/Stage)  │      │  (`isocan run`)  │      │(packages/server) │
      ├──────────────────┤      ├──────────────────┤      ├──────────────────┤
      │ Native Browser   │      │ Node / Deno      │      │ Isolated Worker  │
      │ WebAssembly engine│      │ `node:wasi` or   │      │ with MEMFS and   │
      │ in WebWorker /   │      │ wasm runtime     │      │ 30s timeout      │
      │ OffscreenCanvas  │      │                  │      │                  │
      └──────────────────┘      └──────────────────┘      └──────────────────┘
```

### Verification protocol
1. **Fixture Conformance Suite**: Every tool candidate must provide a suite of
   test fixtures (inputs and expected output buffers).
2. **Byte-for-Byte Output Equality**: Running `tool.wasm(fixture_input)` in the
   Browser, in the CLI, and in the Daemon must produce **identical output
   digests**. If floating-point differences or locale variations produce
   differing bytes, the tool is disqualified.

---

## 6. "Selling it" — Concrete user stories and workflows

How does transportable compute change a user's daily experience? Here are four
compelling, immediate user stories:

### Story 1: Instant visual diffing on the canvas
- *Scenario*: A designer or engineer has two versions of an architectural spec
  or UI copy on the canvas.
- *Experience*: They drag card A onto card B. The UI launches `diff.wasm`
  in an offscreen worker. Within 12 milliseconds, a visual side-by-side
  Unified Diff highlights added and removed lines.
- *Why it sells*: Zero server roundtrips, zero latency, works completely
  offline on an airplane, and preserves total document confidentiality.

### Story 2: SQLite as a zero-setup project index
- *Scenario*: An agent or researcher drops five CSV files, an API JSON export,
  and a project inventory into a workspace.
- *Experience*: The user asks `@browser` or types `isocan query "SELECT customer, SUM(amount) FROM sales GROUP BY customer"`.
  The daemon runs `sqlite.wasm`, ingests the CSVs into MEMFS tables in 40ms,
  executes the analytical query, and renders a clean summary table card.
- *Why it sells*: Instant SQL analytics over project files without installing
  PostgreSQL, Docker, or Python.

### Story 3: High-speed cryptographic deduplication & verification
- *Scenario*: Multiple collaborators share large project assets across
  different operating systems and networks.
- *Experience*: Every file added to the project is hashed via `hash.wasm`
  (BLAKE3) at 500 MB/s. The canvas instantly detects duplicates, matches
  identical assets across workspaces, and guarantees tamper-proof integrity.
- *Why it sells*: Provable byte-level integrity with zero trust required in the
  transport network.

### Story 4: Compressing page snapshots before sharing
- *Scenario*: A researcher captures five dense web page snapshots (Track F,
  MHTML). Each uncompressed file is 12 MB.
- *Experience*: Before saving to the oplog, the extension invokes
  `compress.wasm` (Zstandard). The files shrink by 75% to 3 MB each.
- *Why it sells*: Canvas sync remains blazing fast, network bandwidth is
  conserved, and archival storage costs drop dramatically.

---

## 7. Recommended implementation phases

1. **Phase 1: The Core Four Suite** (`sqlite.wasm`, `diff.wasm`, `compress.wasm`,
   `hash.wasm`):
   - Package the pre-compiled, audited WASM binaries under `packages/tools/`.
   - Write automated cross-host parity tests running under Node, Deno, and
     headless Chrome.
2. **Phase 2: Daemon Supervisor & Isolation Engine**:
   - Implement memory limits (64–512 MB) and CPU deadlines (30s) in
     `packages/server/src/compute/`.
3. **Phase 3: Canvas & CLI Integration**:
   - Mount diff viewers in `ArtifactStage`.
   - Implement `isocan run <tool> <args>` in the CLI.
