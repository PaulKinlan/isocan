// compress-check.mjs — the CROSS-CHECK that kept compress off the shelf.
// Run: node compress-check.mjs — it FAILS today, on purpose, visibly:
// zlib (the reference) validates the compressor's streams, but the
// decompressor misdecodes valid fixed-Huffman streams and the LZ77 barely
// matches. Do not ship until every line prints OK. Fix on the branch; do not
// weaken this file.
import { readFile } from "node:fs/promises";
import zlib from "node:zlib";
import assert from "node:assert/strict";

const bytes = await readFile("compress.wasm");
const { instance } = await WebAssembly.instantiate(bytes, {});
const { compress, decompress, layoutIn, layoutCmp, layoutDec, memory } = instance.exports;
const IN = layoutIn(), CMP = layoutCmp(), DEC = layoutDec();
const u8 = new Uint8Array(memory.buffer);
const enc = new TextEncoder();
let all = true;

for (const [name, input] of [
  ["empty", enc.encode("")],
  ["abc", enc.encode("abc")],
  ["repetitive", enc.encode("isocan ".repeat(500))],
  ["pseudo-random", (() => { const o = new Uint8Array(32768); let s = 12345; for (let i = 0; i < o.length; i++) { s = (s * 1103515245 + 12345) >>> 0; o[i] = s & 0xff; } return o; })()],
]) {
  u8.set(input, IN);
  const c = compress(input.length);
  const ref = zlib.inflateRawSync(Buffer.from(u8.slice(CMP, CMP + c)));
  const refOk = ref.equals(Buffer.from(input));
  u8.set(u8.slice(CMP, CMP + c), CMP);
  const d = decompress(c, 131072);
  const mine = d >= 0 && Buffer.from(u8.slice(DEC, DEC + d)).equals(Buffer.from(input));
  console.log(refOk && mine ? "OK  " : "FAIL", name, input.length + "B -> " + c + "B | zlib:", refOk, "| my-decompress:", mine);
  all = all && refOk && mine;
}
assert.ok(all, "compress is not ready: the cross-check above names the failures");
