# The wasm authority check — CAP's discipline, isocan's code

**Scope: this is an admission CHECK, not the admission system.** No pin store,
no operator authority, no cross-host parity claim, and it never executes the
bytes it audits — there is no `WebAssembly.*` call in this directory's
checker, so every refusal happens before any load could exist. CAP's
`ovfm.4` (ambient-network confinement) remains OPEN and UNVERIFIED and is not
claimed by anything here.

## Provenance

Ported from `PaulKinlan/chrome-agent-platform` at commit
`32ea6822d893c4267104ef1f5792ee014b60f109`,
`extension/lib/wasm-package-authority.js` — fetched and read 2026-09-19, the
exact commit the isocan modules design cites as precedent. Ported faithfully:
manifest validation (exact keys, capability allowlist + canonical-JSON
capability digest, replay classes, the full executable record), and the
bounded binary audit (canonical LEB128, section order/duplicates, imports
measured against an allowed-module list, exactly one memory with a DECLARED
max, tier ceilings, call-export ABI existence). Omitted on purpose: CAP's
mutable registry journal and store — that is the pin-store layer isocan has
not decided yet. The byte-identity proof (`sha256(bytes) === declared`,
`size === declared`) is the offscreen host's rehash-before-load rule, applied
here before any audit.

## Run it

```sh
# rebuild the tool and all fixtures (clang --target=wasm32 required)
sh build.sh
node --experimental-strip-types gen-fixtures.mjs

# PASS — the real tool, admitted on its declared bytes
node check.mjs inventory.json files

# REFUSED digest_mismatch — the tampered twin (one byte), against the good manifest
node check.mjs fixtures/tampered/inventory.json fixtures/tampered

# REFUSED import_not_allowed — a binary importing module "env", outside CAP's allowed set
node check.mjs fixtures/import/inventory.json fixtures/import

# REFUSED memory_max_missing — a build with an undeclared memory ceiling
node check.mjs fixtures/nomax/inventory.json fixtures/nomax
```

The PASS verdict is CAP's own shape: `{ ok, bytes, imports, measured:
{ memoryInitial, memoryMax, imported, tier }, skippedSections, sections,
customBytes }`. Note `imports: []` is MEASURED from the binary's import
section (parsed, bounded, canonical-LEB-checked), never assumed.

## What the discipline did to our own tool

The first build of `hash.wasm` had no declared memory max — clang does not
emit one unless asked. CAP's authority refuses that (`memory_max_missing`):
a tool whose RAM ceiling is undeclared cannot be bounded. The build now
passes `-Wl,--max-memory=33554432` (512 pages, CAP tier `tiny`) and the
fixture `fixtures/nomax` keeps the old shape around as the refusal's
evidence. Adopting the discipline changed our build for the better before it
admitted anything.
