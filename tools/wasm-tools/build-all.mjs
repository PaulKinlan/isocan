#!/usr/bin/env node
// build-all.mjs — the wasm tool pipeline: every tool compiles from source in
// this repo, so every shipped module is ours and digest-pinned by construction.
//
//   node build-all.mjs
//
// Builds each tool/*.c with the same clang discipline (wasm32, freestanding,
// no entry, memory exported, DECLARED max), verifies each binary against a
// behavioural selftest, and emits:
//   files/<id>.wasm              — the admitted bytes, one per executable
//   dist/module/wasm-tools/      — an installable runtime module
//     manifest.json              — ModuleManifest with tools[] (id, wasm, digest)
//     tools/<id>.wasm            — the same bytes, packaged
//     tools/<id>.sha256          — the digest, for eyeballing
// The seed script installs dist/module/wasm-tools into ~/.isocan/modules/.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
/**
 * **Where the build writes.** The pipeline's own directory by default — a
 * person running `node build-all.mjs` gets `hash.wasm`, `files/`, `dist/`
 * beside the sources, which is where `seed.mjs` and the docs expect them.
 *
 * `WASM_TOOLS_OUT` exists for the tests: they must build the REAL current
 * pipeline (a stale `dist/` would let them verify last week's abi) without
 * rewriting tracked binaries in the checkout, `compress.wasm` among them —
 * a WIP artifact that a test run has no business touching.
 */
const outRoot = process.env.WASM_TOOLS_OUT ? path.resolve(process.env.WASM_TOOLS_OUT) : here;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const CC = "clang --target=wasm32 -O2 -nostdlib -Wl,--no-entry -Wl,--export-memory -Wl,--max-memory=33554432 -Wl,--strip-all";

const build = (source, exports) => {
  const out = path.join(here, `.build-${source.replace(/\.c$/, "")}.tmp`);
  execSync(`${CC} ${exports.split(",").map((e) => `-Wl,--export=${e}`).join(" ")} -o ${out} ${source}`, { cwd: here, stdio: "inherit" });
  const bytes = new Uint8Array(readFileSync(out));
  execSync(`rm -f ${out}`, { cwd: here });
  return bytes;
};

// ── hash: SHA-256 over an 8 KiB input buffer (already acceptance-tested) ──
const hash = build("sha256.c", "sha256,addresses");
writeFileSync(path.join(outRoot, "hash.wasm"), hash);

// ── diff: Hirschberg line diff, edit script out (reconstruction-tested) ──
const diff = build("diff.c", "diff,layoutA,layoutB,layoutOut");
writeFileSync(path.join(outRoot, "diff.wasm"), diff);

// Behavioural selftests: a binary that fails its own behaviour is not built.
// Run from the output root, because that is where the binaries it reads are.
execSync(`node --test ${path.join(here, "tools-selftest.mjs")}`, { cwd: outRoot, stdio: "inherit" });

// ── compress: NOT ON THE SHELF YET (2026-09-20). Fixed-Huffman DEFLATE in
// compress.c passes half the cross-check (zlib validates its streams) but the
// decompressor misdecodes the compressor's own output on non-trivial inputs
// and the LZ77 barely matches — the reference caught it, which is what the
// reference is for. Kept as source + compress-check.mjs (the failing
// cross-check) so the next lane inherits the state, not a silent gap.
const compress = build("compress.c", "compress,decompress,layoutIn,layoutCmp,layoutDec");
writeFileSync(path.join(outRoot, "compress.wasm"), compress);

// The shelf's declared calling conventions (abi) and bounds (limits). An
// abi names the convention so the host never guesses; the limits are the
// SAME numbers the C enforces (sha256.c MAX_INPUT/OUT_ADDR, diff.c
// MAX_TEXT/outRegion), declared here so the host can refuse FIRST, in words,
// rather than letting the module's own bound be the first thing that says no.
const tools = [
  { id: "hash", source: "sha256.c", bytes: hash, capability: "crypto", description: "SHA-256 over an 8 KiB input buffer",
    abi: { family: "digest-1", input: { addr: 1024, maxBytes: 8192 }, output: { addr: 9216, bytes: 32 }, call: { export: "sha256" } },
    limits: { inputMaxBytes: 8192, outputMaxBytes: 32 } },  // addresses: sha256.c's addresses() reports 1024/9216
  { id: "diff", source: "diff.c", bytes: diff, capability: "text.transform", description: "line-level edit script between two texts (Hirschberg LCS)",
    abi: { family: "diff-1", input: { addr: 65536, maxBytes: 65536 }, output: { addr: 196608, bytes: 262144 }, call: { export: "diff" } },
    limits: { inputMaxBytes: 65536, outputMaxBytes: 262144 } },  // addresses: diff.c's layoutA()/layoutOut(); the SECOND buffer (layoutB, 131072) is the family's, named not listed
];

// ── the shelf: one installable runtime module carrying every tool ──
const moduleDir = path.join(outRoot, "dist/module/wasm-tools");
mkdirSync(path.join(moduleDir, "assets"), { recursive: true });
const manifest = {
  name: "@isocan/wasm-tools",
  version: "0.1.0",
  description: "Pinned wasm tools: " + tools.map((t) => t.id).join(", "),
  engines: ">=0.2.2",
  tools: tools.map((t) => ({
    id: t.id,
    wasm: `assets/${t.id}.wasm`,
    digest: sha(t.bytes),
    bytes: t.bytes.length,
    capability: t.capability,
    description: t.description,
    abi: t.abi,
    limits: t.limits,
    source: `tools/wasm-tools/${t.source}`,
  })),
  assets: tools.map((t) => ({ path: `assets/${t.id}.wasm`, size: t.bytes.length })),
};
writeFileSync(path.join(moduleDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
for (const t of tools) {
  writeFileSync(path.join(moduleDir, `assets/${t.id}.wasm`), t.bytes);
  writeFileSync(path.join(moduleDir, `assets/${t.id}.sha256`), sha(t.bytes) + `  ${t.id}.wasm\n`);
  mkdirSync(path.join(outRoot, "files"), { recursive: true });
  writeFileSync(path.join(outRoot, `files/${t.id}.wasm`), t.bytes);
}

console.log(JSON.stringify({
  tools: manifest.tools.map((t) => ({ id: t.id, digest: t.digest, bytes: t.bytes, abi: t.abi, limits: t.limits })),
  module: moduleDir,
}, null, 2));
