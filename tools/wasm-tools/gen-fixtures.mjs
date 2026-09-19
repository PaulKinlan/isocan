// gen-fixtures.mjs — builds hash.wasm variants and their CAP-shaped
// inventories: one PASS and three refusals, each isolating ONE failure.
// Run from tools/wasm-tools/: node --experimental-strip-types gen-fixtures.mjs
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const CC = ["clang --target=wasm32 -O2 -nostdlib -Wl,--no-entry -Wl,--export-memory"];

function build(wasmFile, extraFlags) {
  execSync(`${CC.join(" ")} ${extraFlags.join(" ")} -o ${wasmFile} sha256.c`, { stdio: "inherit" });
  return new Uint8Array(readFileSync(wasmFile));
}

const commit = execSync("git rev-parse HEAD").toString().trim();

// ── the good build: declared memory max (CAP refuses an undeclared ceiling) ──
const good = build("hash.wasm", ["-Wl,--max-memory=33554432", "-Wl,--export=sha256", "-Wl,--export=addresses"]);
mkdirSync("files", { recursive: true });
writeFileSync("files/hash-sha256-wasm.wasm", good);

// ── fixture: import-carrying binary (imports module "env" — outside CAP's
//    allowed set, so the discipline refuses it whatever a manifest says) ──
writeFileSync("fixture-import.c", `
__attribute__((import_module("env"))) __attribute__((import_name("log"))) void log_it(int);
__attribute__((export_name("trigger"))) void trigger(void) { log_it(1); }
`);
const withImport = build("fixtures-import.wasm", ["-Wl,--max-memory=33554432", "-Wl,--export=trigger", "fixture-import.c"]);

// ── fixture: undeclared memory max (the build the discipline corrected) ──
const noMax = build("fixtures-nomax.wasm", ["-Wl,--export=sha256", "-Wl,--export=addresses"]);

// ── fixture: tampered twin (one byte of the good build, flipped) ──
const tampered = Uint8Array.from(good);
tampered[39] ^= 0x01;

const executableFor = (bytes, imports) => ({
  id: "hash-sha256-wasm",
  sha256: sha(bytes),
  size: bytes.length,
  imports,
  memory: { tier: "tiny", initialPages: 2, maxPages: 512 },
  runtimeCompat: ["wasm32"],
  replayClass: "read-only",
  capabilities: ["crypto"],
  capabilityDigest: sha(JSON.stringify(["crypto"])),
});

function manifest(executables) {
  return {
    schemaVersion: 1,
    package: { id: "isocan.wasm-tools", version: "0.1.0", name: "tools", type: "tool-bundle" },
    tools: executables.map((e) => ({
      toolId: e.id,
      digest: e.sha256,
      capabilityDigest: e.capabilityDigest,
      replayClass: e.replayClass,
      capabilities: e.capabilities,
    })),
    executables,
    signer: { lane: "bundled", keyId: "isocan-dev", alg: "none" },
    source: { repo: "https://github.com/PaulKinlan/isocan", commit },
    build: { toolchain: "clang 22.1.8 --target=wasm32", profile: "release", reproducible: true },
    sbom: { format: "cyclonedx-json@1.5", sha256: sha(readFileSync("sbom.cdx.json")), ref: "tools/wasm-tools/sbom.cdx.json" },
    license: { spdx: "MIT", file: "LICENSE" },
    meta: { label: "hash", description: "SHA-256 over an 8 KiB linear-memory input buffer" },
  };
}

const NO_IMPORTS = { allowed: [], disallowed: ["*"] };

// the real inventory, for the real tool
writeFileSync("inventory.json", JSON.stringify(manifest([executableFor(good, NO_IMPORTS)]), null, 2) + "\n");

// negative fixtures, each isolating one refusal
rmSync("fixtures", { recursive: true, force: true });
mkdirSync("fixtures/tampered", { recursive: true });
writeFileSync("fixtures/tampered/hash-sha256-wasm.wasm", tampered);
writeFileSync("fixtures/tampered/inventory.json", JSON.stringify(manifest([executableFor(good, NO_IMPORTS)]), null, 2));

mkdirSync("fixtures/import", { recursive: true });
writeFileSync("fixtures/import/hash-sha256-wasm.wasm", withImport);
writeFileSync("fixtures/import/inventory.json", JSON.stringify(manifest([executableFor(withImport, NO_IMPORTS)]), null, 2));

mkdirSync("fixtures/nomax", { recursive: true });
writeFileSync("fixtures/nomax/hash-sha256-wasm.wasm", noMax);
writeFileSync("fixtures/nomax/inventory.json", JSON.stringify(manifest([executableFor(noMax, NO_IMPORTS)]), null, 2));

console.log(JSON.stringify({
  good: { sha: sha(good), size: good.length },
  tampered: { sha: sha(tampered) },
  import: { sha: sha(withImport), size: withImport.length },
  nomax: { sha: sha(noMax), size: noMax.length },
}, null, 2));
