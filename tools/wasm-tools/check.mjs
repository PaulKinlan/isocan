// check.mjs — the admission CHECK CLI (not the admission system).
//
//   node check.mjs <manifest.json> <files-dir>
//
// For every executable in the CAP-shaped manifest: locate <files-dir>/<id>.wasm,
// prove identity (sha256(bytes) === declared, size === declared), then run the
// bounded binary audit. Prints the CAP-shaped verdict per executable and
// PASS/REFUSED overall. Refusals name their code; nothing here calls
// WebAssembly.* — a refusal happens before any load could exist.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { validateManifest, checkExecutable, AuthorityError } from "./cap-authority.mjs";

const [manifestPath, filesDir] = process.argv.slice(2);
if (!manifestPath || !filesDir) { console.error("usage: node check.mjs <manifest.json> <files-dir>"); process.exit(2); }

const manifest = validateManifest(readFileSync(manifestPath, "utf8"));
let failures = 0;
for (const executable of manifest.executables) {
  const file = path.join(filesDir, `${executable.id}.wasm`);
  if (!existsSync(file)) {
    failures++;
    console.log(`REFUSED ${executable.id}: bytes_missing — no file at ${file}`);
    continue;
  }
  const bytes = new Uint8Array(readFileSync(file));
  try {
    const verdict = checkExecutable(bytes, executable);
    console.log(`PASS ${executable.id}: ` + JSON.stringify({
      ok: true, bytes: verdict.bytes,
      imports: verdict.imports,
      measured: verdict.measured,
      sections: verdict.sections, customBytes: verdict.customBytes,
    }));
  } catch (error) {
    if (error instanceof AuthorityError) {
      failures++;
      console.log(`REFUSED ${executable.id}: ${error.code} — ${error.message}${error.detail ? ` (${error.detail})` : ""}`);
    } else throw error;
  }
}
console.log(failures === 0 ? "PASS — every executable admitted on its declared bytes" : `REFUSED — ${failures} executable(s) not admitted`);
process.exit(failures === 0 ? 0 : 1);
