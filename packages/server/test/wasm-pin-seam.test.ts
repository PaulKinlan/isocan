import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { startDaemon, type Daemon } from "../src/daemon.ts";
import { mintTestBadge, type TestBadge } from "./badge.ts";
import { reachableHashes } from "../src/gc.ts";
import * as p from "../src/paths.ts";
import { readFileSync } from "node:fs";
import type { CanvasState } from "@isocan/core";
import { wasm, type WasmInstance } from "../src/wasm.ts";

/**
 * **The pin seam, proven — not shipped** (isocan-54k follow-on, 19 Sep 2026).
 *
 * The feasibility report (`~/journal/reports/2026-09-19-isocan-wasm-tools-feasibility.md`)
 * and the options paper (`…-pin-options.md`) left one thing to prove: that
 * option A — a tool's admitted bytes pinned as a project property, verified
 * BEFORE load, failing closed — has a route through operations that exist
 * today, with no vocabulary change. This file is that proof, as a fixture.
 * The `loadPinnedTool` helper below is the code a tool host would run; it
 * lives HERE because the job is to demonstrate the mechanism, not to ship a
 * feature.
 *
 * What each test pins down, against the REAL daemon (startDaemon, real
 * reducer, real FileStore, real HTTP route — not mocks):
 *
 * 1. the pin rides `project.update` + `MetaPatch.properties` (ops that exist;
 *    `applyMetaPatch` merges arbitrary string keys, `reducer.ts`), and the
 *    pinned bytes become GC-reachable BY SHAPE (`blobrefs.ts` treats a 64-hex
 *    property value as a named blob);
 * 2. verify-before-load works against the store's own minting: the pin IS
 *    `engine.putBlob`'s sha256, the fetched bytes rehash to it, and the
 *    module runs;
 * 3. THE NEGATIVE CONTROL: corrupt ONE byte — chosen so the module stays
 *    structurally valid wasm and its semantics flip (`i32.add` → `i32.sub`)
 *    — and the verifier REFUSES before instantiation. A wasm validator passes
 *    this module; only the digest check catches it. A verifier that cannot
 *    refuse is decoration;
 * 4. fail closed on a missing pin and a malformed pin — absence is refusal,
 *    never load;
 * 5. parity, smallest honest form: the bytes the HTTP route serves (both real
 *    clients' path) and the at-rest bytes a daemon-side host reads are
 *    byte-identical, and verified bytes from either path run to the same
 *    result. The BROWSER's wasm engine is NOT exercised here — see the file
 *    this test came from for what that would take.
 */

// A minimal wasm module exporting `add(i32, i32) -> i32`, spelled as bytes so
// the fixture carries no binary artifact and reads as its own documentation.
// Sections: type, function, export ("add"), code (local.get 0; local.get 1;
// i32.add; end). Byte 45 is the 0x6a (i32.add) — the corruption target in the
// negative control, because 0x6a ^ 0x01 = 0x6b (i32.sub): valid wasm, wrong
// answer, the exact shape only a digest check can catch.
const WASM_ADD = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
);
const ADD_BYTE_INDEX = 39;

const alice = { id: "usr_alice", name: "Alice" };
const canvasId = "prj_wasm_pin_seam";
const PIN_KEY = "tools.pins.add";

let daemon: Daemon;
let base: string;
let home: string;
let badge: TestBadge;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "isocan-wasm-pin-seam-"));
  daemon = await startDaemon({ port: 0, home });
  const address = daemon.app.server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  badge = await mintTestBadge(base);
  await badge.speakAs(alice);
});
afterEach(async () => {
  await daemon?.close();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function postOp(op: unknown, canvasIdForOp: string | null = canvasId) {
  const response = await fetch(`${base}/api/ops`, {
    method: "POST",
    headers: { ...badge.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ canvasId: canvasIdForOp, actor: alice, op }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function accepted(op: unknown, canvasIdForOp: string | null = canvasId) {
  const result = await postOp(op, canvasIdForOp);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

/** The admitted bytes, fetched the way both real clients fetch: the badged
 *  HTTP content route (`GET /api/projects/:id/blobs/:hash`). */
async function fetchBlobBytes(hash: string): Promise<Uint8Array> {
  const response = await fetch(`${base}/api/projects/${canvasId}/blobs/${hash}`, {
    headers: badge.headers,
  });
  expect(response.status).toBe(200);
  return new Uint8Array(await response.arrayBuffer());
}

/** The same bytes the way a daemon-side compute host (the 54k.3 design) reads
 *  them: at rest, under the content-addressed path the store promises. */
function atRestBlobBytes(hash: string, file: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(p.blobsDir(home, canvasId), file)));
}

async function atRestBlobFile(hash: string): Promise<string | null> {
  const index = JSON.parse(await fs.readFile(p.blobsIndexFile(home, canvasId), "utf8").catch(() => "null")) as Record<string, { file: string }> | null;
  return index?.[hash]?.file ?? null;
}

/**
 * The seam under test: resolve a pin, VERIFY THE PINNED BYTES BEFORE LOAD,
 * fail closed on every path that is not a verified load. Refusal names its
 * reason; nothing here can be mistaken for a success.
 */
type PinnedLoad =
  | { ok: true; bytes: Uint8Array; instance: WasmInstance }
  | { ok: false; refused: string };

async function loadPinnedTool(fetchBytes: () => Promise<Uint8Array>, pin: unknown): Promise<PinnedLoad> {
  if (typeof pin !== "string" || pin === "") return { ok: false, refused: "no pin" };
  if (!/^[0-9a-f]{64}$/.test(pin)) return { ok: false, refused: `pin malformed: ${pin}` };
  const bytes = await fetchBytes();
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== pin) {
    return { ok: false, refused: `digest mismatch: pinned ${pin.slice(0, 12)}…, bytes hash ${digest.slice(0, 12)}…` };
  }
  const { instance } = await wasm.instantiate(bytes, {});
  return { ok: true, bytes, instance };
}

const pinOf = async (state: CanvasState): Promise<unknown> => state.project.properties[PIN_KEY];
const stateOf = (): Promise<CanvasState> => daemon.engine.getSnapshot(canvasId) as Promise<CanvasState>;

describe("wasm tool pin seam — option A, proven against the real daemon", () => {
  let blobHash: string;

  beforeEach(async () => {
    await accepted(
      { type: "project.create", canvasId, title: "Wasm pin seam", groupMode: "legacy" },
      null,
    );
    // The daemon mints the hash from the bytes — the client never claims one.
    blobHash = (await daemon.engine.putBlob(canvasId, Buffer.from(WASM_ADD), {
      mimeType: "application/wasm",
      filename: "add.wasm",
    })).blobHash;
    expect(blobHash).toBe(createHash("sha256").update(WASM_ADD).digest("hex"));
  });

  it("1. the pin rides an existing op — project.update + properties, no vocabulary change — and holds the bytes against GC", async () => {
    await accepted({ type: "project.update", patch: { properties: { [PIN_KEY]: blobHash } } });
    const state = await stateOf();
    expect(state.project.properties[PIN_KEY]).toBe(blobHash);

    // Replay: the op the reducer applied IS the admission record. A client
    // catching up re-derives the same pin from the log, never from a
    // machine-local file.
    const log = await (await fetch(`${base}/api/projects/${canvasId}/oplog`, { headers: badge.headers })).json() as { envelope: { op: { type: string; patch?: { properties?: Record<string, string> } } } }[];
    const admission = log.map((e) => e.envelope.op).find((op) => op.type === "project.update" && op.patch?.properties?.[PIN_KEY]);
    expect(admission, "the admission op replays from the log").toBeTruthy();

    // The shape rule: a 64-hex property value is a named blob, so the pinned
    // bytes cannot be swept while the pin stands (blobrefs.ts by-shape scan).
    expect(reachableHashes(await stateOf(), []).has(blobHash)).toBe(true);
  });

  it("2. verify BEFORE load: the pinned bytes rehash to the pin, load, and run — twice, same result", async () => {
    await accepted({ type: "project.update", patch: { properties: { [PIN_KEY]: blobHash } } });
    const state = await stateOf();

    const load = await loadPinnedTool(() => fetchBlobBytes(blobHash), await pinOf(state));
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    const add = load.instance.exports.add as (a: number, b: number) => number;
    expect(add(2, 3)).toBe(5); // and the oracle agrees:
    expect(2 + 3).toBe(5);

    // A second, independent instantiation of the same verified bytes runs to
    // the same result — the determinism the 54k.2 exec boundary demands,
    // asserted on the fixture.
    const second = await loadPinnedTool(() => fetchBlobBytes(blobHash), await pinOf(await stateOf()));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect((second.instance.exports.add as (a: number, b: number) => number)(20, 22)).toBe(42);
  });

  it("3. NEGATIVE CONTROL: one corrupted byte — valid wasm, wrong semantics — REFUSES before load", async () => {
    await accepted({ type: "project.update", patch: { properties: { [PIN_KEY]: blobHash } } });
    const state = await stateOf();

    // Flip i32.add → i32.sub. The module stays structurally valid: proof that
    // the refusal below comes from the DIGEST CHECK and not from wasm
    // validation refusing a broken module.
    const corrupted = Uint8Array.from(WASM_ADD);
    const before = corrupted[ADD_BYTE_INDEX];
    expect(before).toBe(0x6a); // i32.add — the premise, asserted rather than assumed
    corrupted[ADD_BYTE_INDEX] = (before as number) ^ 0x01;
    expect(corrupted[ADD_BYTE_INDEX]).toBe(0x6b); // i32.sub
    const stillValid = await wasm.instantiate(corrupted, {});
    expect((stillValid.instance.exports as { add: (a: number, b: number) => number }).add(2, 3)).toBe(-1);

    // The store gives the corrupted bytes their OWN hash — the mint never
    // conflates them with the pinned bytes.
    const tamperedHash = (await daemon.engine.putBlob(canvasId, Buffer.from(corrupted), {
      mimeType: "application/wasm",
      filename: "add-corrupted.wasm",
    })).blobHash;
    expect(tamperedHash).not.toBe(blobHash);

    // Now the seam must refuse: bytes whose hash is not the pin NEVER load —
    // not "load and compute wrongly", not "load and warn". Refuse. The
    // tampered hash is a legal hash, so the fetch succeeds and the verifier
    // is what refuses; assert the refusal, its reason, and that no instance
    // escaped. Then the same bytes against the ORIGINAL pin, same refusal —
    // the check is bytes vs pin, never on which hash was asked for.
    const load = await loadPinnedTool(() => fetchBlobBytes(tamperedHash), await pinOf(state));
    expect(load).toMatchObject({ ok: false, refused: expect.stringMatching(/digest mismatch/) });
    expect(load).not.toHaveProperty("instance");
    const againstOriginalPin = await loadPinnedTool(() => fetchBlobBytes(tamperedHash), blobHash);
    expect(againstOriginalPin).toMatchObject({ ok: false, refused: expect.stringMatching(/digest mismatch/) });
  });

  it("4. fail closed: a missing pin and a malformed pin are refusals, never loads", async () => {
    // No property: no pin, no load.
    const unpinned = await loadPinnedTool(() => fetchBlobBytes(blobHash), await pinOf(await stateOf()));
    expect(unpinned).toMatchObject({ ok: false, refused: "no pin" });

    // A malformed pin: refused before any fetch — and the content route's own
    // 64-hex rule (content.ts CONTENT_BLOB_PATH) would refuse the fetch too.
    const malformed = await loadPinnedTool(() => fetchBlobBytes(blobHash), "deadbeef");
    expect(malformed).toMatchObject({ ok: false, refused: expect.stringMatching(/pin malformed/) });
  });

  it("5. parity, smallest honest form: served bytes, at-rest bytes, same verified bytes, same result", async () => {
    await accepted({ type: "project.update", patch: { properties: { [PIN_KEY]: blobHash } } });
    const state = await stateOf();

    // What the served route gives a client:
    const served = await fetchBlobBytes(blobHash);
    // What a daemon-side host reads at rest (blobs.json names the file):
    const indexFile = await atRestBlobFile(blobHash);
    expect(indexFile, "the store's index names the at-rest file").toBeTruthy();
    if (!indexFile) return;
    const atRest = atRestBlobBytes(blobHash, indexFile);

    // Byte-identical, both hashing to the pin:
    expect(Buffer.from(served).equals(Buffer.from(WASM_ADD))).toBe(true);
    expect(Buffer.from(atRest).equals(Buffer.from(WASM_ADD))).toBe(true);
    expect(createHash("sha256").update(served).digest("hex")).toBe(blobHash);
    expect(createHash("sha256").update(atRest).digest("hex")).toBe(blobHash);

    // And the same verified bytes run to the same result from either path:
    const viaServed = await loadPinnedTool(async () => served, await pinOf(state));
    const viaAtRest = await loadPinnedTool(async () => atRest, await pinOf(state));
    expect(viaServed.ok && viaAtRest.ok).toBe(true);
    if (!(viaServed.ok && viaAtRest.ok)) return;
    expect((viaServed.instance.exports.add as (a: number, b: number) => number)(2, 3))
      .toBe((viaAtRest.instance.exports.add as (a: number, b: number) => number)(2, 3));
  });
});
