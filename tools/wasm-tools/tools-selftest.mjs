// tools-selftest.mjs — a binary that fails its own behaviour is not built.
// Instantiates the freshly built bytes and asserts behaviour, not structure:
// hash answers the canonical "abc" vector and matches Node's crypto on more
// inputs; diff produces an edit script that reconstructs both texts.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const enc = new TextEncoder();

// ── hash ──
{
  const bytes = readFileSync("hash.wasm");
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const { sha256, addresses, memory } = instance.exports;
  const addr = addresses();
  const IN = addr >>> 16, OUT = 9216;
  for (const [text, expect] of [
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["isocan".repeat(300), createHash("sha256").update("isocan".repeat(300)).digest("hex")],
  ]) {
    const input = enc.encode(text);
    new Uint8Array(memory.buffer).set(input, IN);
    sha256(input.length);
    const digest = [...new Uint8Array(memory.buffer).slice(OUT, OUT + 32)].map((b) => b.toString(16).padStart(2, "0")).join("");
    assert.equal(digest, expect, `hash selftest failed on ${JSON.stringify(text.slice(0, 12))}`);
  }
}

// ── diff ──
{
  const bytes = readFileSync("diff.wasm");
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const { layoutA, layoutB, layoutOut, diff, memory } = instance.exports;
  const A = layoutA(), B = layoutB(), OUT = layoutOut();
  const u8 = new Uint8Array(memory.buffer);
  const run = (a, b) => {
    const ba = enc.encode(a), bb = enc.encode(b);
    u8.set(ba, A); u8.set(bb, B);
    const n = diff(ba.length, bb.length);
    const script = [];
    for (let i = 0; i + 1 < n;) {
      const op = u8[OUT + i]; i += 1;
      if (op === 255) break;
      const rd = () => { let v = u8[OUT + i] | (u8[OUT + i + 1] << 8) | (u8[OUT + i + 2] << 16) | (u8[OUT + i + 3] << 24); i += 4; return v >>> 0; };
      script.push({ op, al: rd(), ac: rd(), bl: rd(), bc: rd() });
    }
    return script;
  };
  const reconstructs = (a, b) => {
    const aL = a === "" ? [] : a.split("\n"), bL = b === "" ? [] : b.split("\n");
    const rA = [], rB = [];
    for (const blk of run(a, b)) {
      if (blk.op === 0) for (let k = 0; k < blk.ac; k++) { rA.push(aL[blk.al + k]); rB.push(bL[blk.bl + k]); }
      else if (blk.op === 1) for (let k = 0; k < blk.ac; k++) rA.push(aL[blk.al + k]);
      else for (let k = 0; k < blk.bc; k++) rB.push(bL[blk.bl + k]);
    }
    return rA.join("\n") === a && rB.join("\n") === b;
  };
  assert.ok(reconstructs("same\nlines\nhere", "same\nlines\nhere"), "diff selftest: identical texts");
  assert.ok(reconstructs("one\ntwo\nthree", "one\nTWO\nthree"), "diff selftest: one-line change");
  assert.ok(reconstructs("a\nb\nc\nd", "a\nd"), "diff selftest: shrink");
  assert.ok(reconstructs("", "brand\nnew"), "diff selftest: empty to text");
  assert.ok(
    reconstructs(Array.from({ length: 200 }, (_, i) => (i % 30 === 0 ? "mutated " + i : "row " + i)).join("\n"),
      Array.from({ length: 200 }, (_, i) => "row " + i).join("\n")),
    "diff selftest: 200 lines with periodic mutations",
  );
}
