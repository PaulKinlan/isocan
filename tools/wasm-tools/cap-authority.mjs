// cap-authority.mjs — isocan's port of CAP's wasm package AUTHORITY discipline.
//
// Source of the port: PaulKinlan/chrome-agent-platform @ 32ea6822d893c4267104ef1f5792ee014b60f109,
// extension/lib/wasm-package-authority.js (fetched and read 2026-09-19; the
// isocan design cites this exact commit as precedent — docs/projects/modules/design.md).
//
// WHAT IS PORTED, faithfully: exactKeys manifest validation; capability
// allowlist + canonical-JSON capability digest; replay classes; the executable
// record (id, sha256, size, imports allowed/disallowed, memory tier with
// DECLARED max, runtimeCompat, callExport ABI); the bounded wasm binary audit —
// magic/version, section order/duplicates/framing, canonical LEB128, the
// import section measured against an allowed-module list, the memory section
// (exactly one memory, no shared, no memory64, max REQUIRED, ceiling enforced),
// and the call-export ABI existence checks; and the byte-identity proof
// (sha256(bytes) === executable.sha256, size === executable.size).
//
// WHAT IS OMITTED, and why: CAP's mutable registry journal (WAL, store locks,
// revoke states) is the PIN-STORE layer isocan has not decided (options A/B/C
// are open — see reports/2026-09-19-isocan-wasm-tools-pin-options.md), so this
// port validates bytes+manifest only and keeps no state. Signature verification
// is format-only in CAP's fetched slice and stays format-only here. No route,
// no network, no install UI, no execution surface — this file never calls
// WebAssembly.* : refusing happens BEFORE any load, and there is no load here.
//
// SCOPE: an admission CHECK, not the admission system. ovfm.4 (CAP's
// ambient-network confinement) remains OPEN and UNVERIFIED and is not claimed.

import { createHash } from "node:crypto";

export const WASM_PACKAGE_LIMITS = Object.freeze({
  MAX_CAPABILITIES: 32,
  TIERS: Object.freeze({
    tiny: Object.freeze({ maxPages: 512, maxBytes: Number.POSITIVE_INFINITY, admission: "allowed" }),
    default: Object.freeze({ maxPages: 2048, maxBytes: Number.POSITIVE_INFINITY, admission: "allowed" }),
    large: Object.freeze({ maxPages: 4096, maxBytes: Number.POSITIVE_INFINITY, admission: "allowed" }),
  }),
});

const HEX64_RE = /^[0-9a-f]{64}$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const PACKAGE_ID_RE = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/u;
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]{1,16}(?:\.[0-9A-Za-z-]{1,16})*))?(?:\+([0-9A-Za-z-]{1,16}(?:\.[0-9A-Za-z-]{1,16})*))?$/u;
const TOKEN_RE = /^[a-z][a-z0-9.-]{0,15}$/u;
const IMPORT_MODULE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
export const BUNDLED_ALLOWED_IMPORT_MODULES = Object.freeze(["wasi_snapshot_preview1"]);
const BUNDLED_ALLOWED_IMPORT_MODULE_SET = new Set(BUNDLED_ALLOWED_IMPORT_MODULES);
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const REPLAY = new Set(["read-only", "idempotent", "mutating", "unknown"]);
const PACKAGE_TYPES = new Set(["tool-bundle", "runtime", "library", "model-support"]);
const SPDX_IDS = new Set(["0BSD", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT", "MPL-2.0", "PSF-2.0", "Zlib", "blessing"]);
const CAPABILITY_ALLOWLIST = new Set([
  "artifact.create", "compute", "crypto", "data.read", "data.write",
  "file.read", "file.write", "text.transform",
]);
const META_FIELDS = new Set(["category", "channel", "description", "homepage", "label", "note", "owner", "status"]);
const SECTION_NAMES = Object.freeze({
  1: "type", 2: "import", 3: "function", 4: "table", 5: "memory",
  6: "global", 7: "export", 8: "start", 9: "element", 10: "code",
  11: "data", 12: "datacount",
});
const KIND_NAMES = Object.freeze({ 0: "function", 1: "table", 2: "memory", 3: "global", 4: "tag" });
const decoder = new TextDecoder("utf-8", { fatal: true });

export class AuthorityError extends Error {
  constructor(code, path = "", detail = null) {
    super(`${code}${path ? ` at ${path}` : ""}`);
    this.name = "AuthorityError";
    this.code = code;
    this.path = path;
    this.detail = detail;
  }
}
function fail(code, path = "", detail = null) { throw new AuthorityError(code, path, detail); }

export function exactKeys(value, required, optional = [], path = "$manifest") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("manifest_type", path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("manifest_unknown_field", `${path}.${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail("manifest_missing_field", `${path}.${key}`);
}

function assertAscii(value, path, { min = 0, max = 256 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) fail("manifest_string_bound", path);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code > 0x7f || code < 0x20 || code === 0x7f) fail("manifest_non_ascii", path);
  }
  return value;
}

export function assertRelativePath(value, path) {
  const text = assertAscii(value, path, { min: 1, max: 128 });
  let decoded;
  try { decoded = decodeURIComponent(text); } catch { fail("path_escape", path); }
  if (!PATH_RE.test(text) || text.startsWith("/") || text.includes("\\") || text.split("/").some((p) => !p || p === "." || p === "..") || decoded !== text) fail("path_escape", path);
  return text;
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) fail("canonical_number"); return JSON.stringify(value); }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  fail("canonical_type");
}

const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");

function validateCapabilities(value, path) {
  if (!Array.isArray(value) || value.length > WASM_PACKAGE_LIMITS.MAX_CAPABILITIES) fail("capability_bound", path);
  const out = value.map((item, index) => {
    const token = assertAscii(item, `${path}[${index}]`, { min: 1, max: 16 });
    if (!TOKEN_RE.test(token)) fail("capability_invalid", `${path}[${index}]`);
    if (!CAPABILITY_ALLOWLIST.has(token)) fail("capability_not_declared", `${path}[${index}]`);
    return token;
  });
  if (new Set(out).size !== out.length || JSON.stringify(out) !== JSON.stringify([...out].sort())) fail("capability_order", path);
  return out;
}
const capabilityDigest = (capabilities) => sha256Hex(canonicalJson(capabilities));

function validateManifestObject(manifest) {
  exactKeys(manifest, ["schemaVersion", "package", "tools", "executables", "signer", "source", "build", "sbom", "license", "meta"]);
  if (manifest.schemaVersion !== 1) fail("manifest_schema_version", "$.schemaVersion");

  exactKeys(manifest.package, ["id", "version", "name", "type"], [], "$.package");
  const packageId = assertAscii(manifest.package.id, "$.package.id", { min: 1, max: 128 });
  if (!PACKAGE_ID_RE.test(packageId) || packageId.includes("..") || packageId.startsWith(".") || packageId.endsWith(".")) fail("package_id_invalid", "$.package.id");
  if (!SEMVER_RE.test(assertAscii(manifest.package.version, "$.package.version", { min: 5, max: 96 }))) fail("semver_invalid", "$.package.version");
  if (!ID_RE.test(assertAscii(manifest.package.name, "$.package.name", { min: 1, max: 64 }))) fail("package_name_invalid", "$.package.name");
  if (!PACKAGE_TYPES.has(manifest.package.type)) fail("package_type_invalid", "$.package.type");

  if (!Array.isArray(manifest.tools)) fail("tool_bound", "$.tools");
  const toolIds = new Set();
  for (let index = 0; index < manifest.tools.length; index++) {
    const path = `$.tools[${index}]`;
    const tool = manifest.tools[index];
    exactKeys(tool, ["toolId", "digest", "capabilityDigest", "replayClass", "capabilities"], [], path);
    if (!ID_RE.test(assertAscii(tool.toolId, `${path}.toolId`, { min: 1, max: 64 }))) fail("tool_id_invalid", `${path}.toolId`);
    if (toolIds.has(tool.toolId)) fail("tool_id_duplicate", `${path}.toolId`);
    toolIds.add(tool.toolId);
    if (!HEX64_RE.test(tool.digest)) fail("digest_invalid", `${path}.digest`);
    const capabilities = validateCapabilities(tool.capabilities, `${path}.capabilities`);
    if (tool.capabilityDigest !== capabilityDigest(capabilities)) fail("capability_digest_mismatch", `${path}.capabilityDigest`);
    validateReplay(tool.replayClass, `${path}.replayClass`);
  }

  if (!Array.isArray(manifest.executables) || manifest.executables.length === 0) fail("executable_bound", "$.executables");
  const executableIds = new Set();
  for (let index = 0; index < manifest.executables.length; index++) {
    const path = `$.executables[${index}]`;
    const executable = manifest.executables[index];
    exactKeys(executable, ["id", "sha256", "size", "imports", "memory", "runtimeCompat", "replayClass", "capabilities", "capabilityDigest"], ["callExport"], path);
    if (!ID_RE.test(assertAscii(executable.id, `${path}.id`, { min: 1, max: 64 }))) fail("executable_id_invalid", `${path}.id`);
    if (executableIds.has(executable.id)) fail("executable_id_duplicate", `${path}.id`);
    executableIds.add(executable.id);
    if (!HEX64_RE.test(executable.sha256)) fail("digest_invalid", `${path}.sha256`);
    if (!Number.isSafeInteger(executable.size) || executable.size < 1) fail("size_invalid", `${path}.size`);
    exactKeys(executable.imports, ["allowed", "disallowed"], [], `${path}.imports`);
    for (const field of ["allowed", "disallowed"]) {
      const values = executable.imports[field];
      if (!Array.isArray(values)) fail("import_bound", `${path}.imports.${field}`);
      for (let item = 0; item < values.length; item++) {
        const itemPath = `${path}.imports.${field}[${item}]`;
        const module = assertAscii(values[item], itemPath, { min: 1, max: Number.POSITIVE_INFINITY });
        if (field === "disallowed" && module === "*") continue;
        if (!IMPORT_MODULE_RE.test(module)) fail("import_invalid", itemPath);
        if (field === "allowed" && !BUNDLED_ALLOWED_IMPORT_MODULE_SET.has(module)) fail("import_not_allowed", itemPath, module);
      }
      if (new Set(values).size !== values.length || JSON.stringify(values) !== JSON.stringify([...values].sort())) fail("import_order", `${path}.imports.${field}`);
    }
    if (executable.callExport != null) {
      exactKeys(executable.callExport, ["entry", "inputBuffer", "digestBytes"], [], `${path}.callExport`);
      const EXPORT_NAME_RE = /^[A-Za-z0-9_.$-]{1,64}$/u;
      if (!EXPORT_NAME_RE.test(assertAscii(executable.callExport.entry, `${path}.callExport.entry`, { min: 1, max: 64 }))) fail("callexport_entry_invalid", `${path}.callExport.entry`);
      if (!EXPORT_NAME_RE.test(assertAscii(executable.callExport.inputBuffer, `${path}.callExport.buffer`, { min: 1, max: 64 }))) fail("callexport_buffer_invalid", `${path}.callExport.inputBuffer`);
      if (!Number.isSafeInteger(executable.callExport.digestBytes) || executable.callExport.digestBytes < 1 || executable.callExport.digestBytes > 4096) fail("callexport_digest_invalid", `${path}.callExport.digestBytes`);
      if (executable.imports.allowed.length !== 0) fail("callexport_imports_nonzero", `${path}.imports.allowed`);
    }
    exactKeys(executable.memory, ["tier", "initialPages", "maxPages"], [], `${path}.memory`);
    const tier = WASM_PACKAGE_LIMITS.TIERS[executable.memory.tier];
    if (!tier) fail("tier_invalid", `${path}.memory.tier`);
    if (!Number.isSafeInteger(executable.memory.initialPages) || !Number.isSafeInteger(executable.memory.maxPages) || executable.memory.initialPages < 0 || executable.memory.initialPages > executable.memory.maxPages) fail("memory_declaration_invalid", `${path}.memory`);
    if (executable.memory.maxPages > tier.maxPages || executable.size > tier.maxBytes) fail("tier_mismatch", `${path}.memory`);
    if (!Array.isArray(executable.runtimeCompat) || JSON.stringify(executable.runtimeCompat) !== '["wasm32"]') fail("runtime_incompatible", `${path}.runtimeCompat`);
    validateReplay(executable.replayClass, `${path}.replayClass`);
    const capabilities = validateCapabilities(executable.capabilities, `${path}.capabilities`);
    if (executable.capabilityDigest !== capabilityDigest(capabilities)) fail("capability_digest_mismatch", `${path}.capabilityDigest`);
  }

  exactKeys(manifest.signer, ["lane", "keyId", "alg"], ["sig"], "$.signer");
  if (manifest.signer.lane !== "bundled") fail("lane_not_admitted", "$.signer.lane");
  if (!/^[a-z0-9-]{1,64}$/u.test(assertAscii(manifest.signer.keyId, "$.signer.keyId", { min: 1, max: 64 }))) fail("signer_key_invalid", "$.signer.keyId");
  if (!new Set(["Ed25519", "none"]).has(manifest.signer.alg)) fail("signer_alg_invalid", "$.signer.alg");
  if (manifest.signer.sig != null && !/^(?:[0-9a-f]{2}){1,512}$/u.test(assertAscii(manifest.signer.sig, "$.signer.sig", { min: 2, max: 1024 }))) fail("signature_invalid", "$.signer.sig");

  exactKeys(manifest.source, ["repo", "commit"], ["tag"], "$.source");
  const repo = assertAscii(manifest.source.repo, "$.source.repo", { min: 1, max: 256 });
  try { const url = new URL(repo); if (!new Set(["https:"]).has(url.protocol) || url.username || url.password) fail("source_repo_invalid", "$.source.repo"); } catch { fail("source_repo_invalid", "$.source.repo"); }
  if (!COMMIT_RE.test(manifest.source.commit)) fail("provenance_incomplete", "$.source.commit");
  if (manifest.source.tag != null) assertAscii(manifest.source.tag, "$.source.tag", { min: 1, max: 64 });

  exactKeys(manifest.build, ["toolchain", "profile", "reproducible"], ["rebuildRef"], "$.build");
  assertAscii(manifest.build.toolchain, "$.build.toolchain", { min: 1, max: 64 });
  if (!new Set(["release", "debug"]).has(manifest.build.profile) || typeof manifest.build.reproducible !== "boolean") fail("build_invalid", "$.build");
  if (manifest.build.rebuildRef != null) assertAscii(manifest.build.rebuildRef, "$.build.rebuildRef", { min: 1, max: 128 });

  exactKeys(manifest.sbom, ["format", "sha256", "ref"], [], "$.sbom");
  if (!new Set(["cyclonedx-json@1.5", "spdx-json@2.3"]).has(manifest.sbom.format) || !HEX64_RE.test(manifest.sbom.sha256)) fail("provenance_incomplete", "$.sbom");
  assertRelativePath(manifest.sbom.ref, "$.sbom.ref");

  exactKeys(manifest.license, ["spdx", "file"], ["notices"], "$.license");
  if (!isValidLicenseExpression(manifest.license.spdx)) fail("license_invalid", "$.license.spdx");
  assertRelativePath(manifest.license.file, "$.license.file");

  if (!manifest.meta || typeof manifest.meta !== "object" || Array.isArray(manifest.meta) || Object.keys(manifest.meta).length > 8) fail("meta_bound", "$.meta");
  for (const [key, value] of Object.entries(manifest.meta)) {
    if (!META_FIELDS.has(key)) fail("manifest_unknown_field", `$.meta.${key}`);
    if (!(typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)) fail("meta_scalar", `$.meta.${key}`);
    if (typeof value === "string") assertAscii(value, `$.meta.${key}`, { max: 256 });
  }
  return manifest;
}

function validateReplay(value, path) { if (!REPLAY.has(value)) fail("replay_class_invalid", path); }
function isValidLicenseExpression(value) {
  if (typeof value !== "string") return false;
  if (SPDX_IDS.has(value)) return true;
  const parts = value.split(" AND ");
  return parts.length === 2 && SPDX_IDS.has(parts[0]) && SPDX_IDS.has(parts[1]);
}

function encodeU32(value) {
  const out = [];
  let current = BigInt(value);
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current) byte |= 0x80;
    out.push(byte);
  } while (current);
  return out;
}

class WasmReader {
  constructor(bytes, start = 0, end = bytes.length) { this.bytes = bytes; this.offset = start; this.end = end; }
  byte(code = "section_framing") { if (this.offset >= this.end) fail(code); return this.bytes[this.offset++]; }
  u32() {
    const start = this.offset;
    let value = 0n, shift = 0n;
    for (let count = 0; count < 5; count++) {
      const byte = this.byte("leb_truncated");
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        if (value > 0xffffffffn) fail("leb_overflow");
        if (JSON.stringify(encodeU32(value)) !== JSON.stringify([...this.bytes.slice(start, this.offset)])) fail("leb_non_canonical");
        return Number(value);
      }
      shift += 7n;
    }
    fail("leb_truncated");
  }
  name() {
    const length = this.u32();
    if (length > 256 || this.offset + length > this.end) fail("import_name_bound");
    const bytes = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    let value;
    try { value = decoder.decode(bytes); } catch { fail("import_name_invalid"); }
    assertAscii(value, "wasm.import", { max: 256 });
    return value;
  }
  done() { return this.offset === this.end; }
}

function readMemoryLimits(reader) {
  const flags = reader.u32();
  if (flags & 0x04) fail("memory64_rejected");
  if (flags & 0x02) fail("memory_shared_rejected");
  if (flags & ~0x07) fail("memory_flags_unknown");
  const min = reader.u32();
  if (!(flags & 0x01)) fail("memory_max_missing");
  const max = reader.u32();
  if (min > max) fail("memory_limits_invalid");
  return { min, max, shared: false, memory64: false };
}
function readTableLimits(reader) {
  const flags = reader.u32();
  if (flags & ~0x01) fail("table_flags_unknown");
  reader.u32();
  if (flags & 0x01) reader.u32();
}

export function auditWasmBinary(input, executable, { limits = WASM_PACKAGE_LIMITS, allowLarge = false } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
  if (bytes.byteLength < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) fail("wasm_magic");
  if (bytes[4] !== 0x01 || bytes[5] !== 0x00 || bytes[6] !== 0x00 || bytes[7] !== 0x00) fail("wasm_version");
  const tier = limits.TIERS[executable?.memory?.tier];
  if (!tier) fail("tier_invalid");
  if (executable.memory.tier === "large" && !allowLarge) fail("tier_blocked");
  if (bytes.byteLength > tier.maxBytes) fail("binary_too_large_for_tier");

  const reader = new WasmReader(bytes, 8);
  const seen = new Set();
  let lastOrder = 0, sections = 0, customBytes = 0;
  const skippedSections = [], imports = [], exports = [], memories = [];
  while (!reader.done()) {
    sections += 1;
    const id = reader.byte();
    const size = reader.u32();
    if (reader.offset + size > reader.end) fail("section_size_overflow");
    const end = reader.offset + size;
    if (id === 0) { customBytes += size; reader.offset = end; continue; }
    if (!SECTION_NAMES[id]) fail("unknown_section");
    if (seen.has(id)) fail("duplicate_section");
    if (id < lastOrder) fail("section_order");
    seen.add(id);
    lastOrder = id;
    const section = new WasmReader(bytes, reader.offset, end);
    if (id === 2) {
      const count = section.u32();
      if (count > 1024) fail("import_count_bound");
      for (let index = 0; index < count; index++) {
        const module = section.name();
        const name = section.name();
        const kind = section.byte();
        if (!Object.hasOwn(KIND_NAMES, kind)) fail("import_kind_invalid");
        if (!BUNDLED_ALLOWED_IMPORT_MODULE_SET.has(module) || !executable.imports.allowed.includes(module) || executable.imports.disallowed.includes(module) || executable.imports.disallowed.includes("*")) fail("import_not_allowed", module);
        imports.push({ module, name, kind: KIND_NAMES[kind] });
        if (kind === 0) section.u32();
        else if (kind === 1) { section.byte(); readTableLimits(section); }
        else if (kind === 2) memories.push({ ...readMemoryLimits(section), imported: true });
        else if (kind === 3) { section.byte(); section.byte(); }
        else if (kind === 4) { section.byte(); section.u32(); }
      }
      if (!section.done()) fail("section_framing");
    } else if (id === 5) {
      const count = section.u32();
      if (count > 2) fail("multi_memory_rejected");
      for (let index = 0; index < count; index++) memories.push({ ...readMemoryLimits(section), imported: false });
      if (!section.done()) fail("section_framing");
    } else if (id === 7 && executable?.callExport != null) {
      const count = section.u32();
      if (count > 4096) fail("export_count_bound");
      for (let index = 0; index < count; index++) {
        const name = section.name();
        const kind = section.byte();
        if (!Object.hasOwn(KIND_NAMES, kind)) fail("export_kind_invalid");
        section.u32();
        exports.push({ name, kind: KIND_NAMES[kind] });
      }
      if (!section.done()) fail("section_framing");
    } else {
      skippedSections.push({ id, name: SECTION_NAMES[id], reason: "not_audited_in_authority_slice" });
    }
    reader.offset = end;
  }
  if (memories.length === 0) fail("no_memory");
  if (memories.length !== 1) fail("multi_memory_rejected");
  const measured = memories[0];
  if (measured.max > executable.memory.maxPages || measured.max > tier.maxPages) fail("memory_exceeds_ceiling", executable.memory.tier);
  if (executable?.callExport != null) {
    const fnExports = new Set(exports.filter((e) => e.kind === "function").map((e) => e.name));
    const memExports = new Set(exports.filter((e) => e.kind === "memory").map((e) => e.name));
    if (!fnExports.has(executable.callExport.entry)) fail("callexport_entry_missing", executable.callExport.entry);
    if (!fnExports.has(executable.callExport.inputBuffer)) fail("callexport_buffer_missing", executable.callExport.inputBuffer);
    if (memExports.size === 0) fail("callexport_memory_export_missing");
    if (imports.length !== 0) fail("callexport_imports_present", String(imports.length));
  }
  return Object.freeze({
    ok: true,
    bytes: bytes.byteLength,
    imports: Object.freeze(imports.map((entry) => Object.freeze(entry))),
    measured: Object.freeze({ memoryInitial: measured.min, memoryMax: measured.max, imported: measured.imported, tier: executable.memory.tier }),
    skippedSections: Object.freeze(skippedSections.map((entry) => Object.freeze(entry))),
    sections,
    customBytes,
  });
}

/**
 * The full admission CHECK for one executable against its bytes: identity
 * first (sha256(bytes) === sha256 declared, size === size declared — the
 * rehash-before-load rule the offscreen host applies before worker creation),
 * then the bounded binary audit. Throws AuthorityError with a named code on
 * every refusal; never touches WebAssembly.* — a refusal here happens before
 * any load could exist.
 */
export function checkExecutable(bytes, executable, options = {}) {
  if (!HEX64_RE.test(executable.sha256)) fail("digest_invalid", "$.executables.sha256");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== executable.sha256) fail("digest_mismatch", "", `bytes hash ${digest}`);
  if (bytes.byteLength !== executable.size) fail("size_mismatch", "", `${bytes.byteLength} vs declared ${executable.size}`);
  return auditWasmBinary(bytes, executable, options);
}

export function validateManifest(raw) {
  const manifest = typeof raw === "string" ? JSON.parse(raw) : raw;
  return validateManifestObject(manifest);
}
