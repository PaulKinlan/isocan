/**
 * **The shelf, hooked up** (2026-09-20, `voicebox-beads-4eh`).
 *
 * The tools were built from source, digested, self-tested and installed, and
 * nothing could call them: the shelf was a directory and the catalogue was a
 * list, with no bridge between them. Paul found it by looking: *"I see tools as
 * wasm etc, but don't see them hooked up either."*
 *
 * This drives the bridge against the real daemon:
 *
 *   1. the command list is GENERATED from the installed manifest (remove the
 *      module and the tools leave the list with it);
 *   2. both abis run for real, and the bytes that come back are the tool's
 *      actual semantics (SHA-256 of "abc", an edit script that terminates),
 *      not just "something happened";
 *   3. the result is addressable — stored as a content-addressed blob and
 *      readable back by its hash;
 *   4. every refusal is NAMED, and a single tampered byte on disk refuses
 *      BEFORE instantiation (fail closed, never run unverified bytes).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon, type Daemon } from "../src/daemon.ts";
import { mintTestBadge, type TestBadge } from "./badge.ts";
import { modulesDir } from "../src/modules.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** SHA-256 of "abc" — the digest the tool must produce, computed here too. */
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

const alice = { id: "usr_alice", name: "Alice" };
const canvasId = "prj_wasm_shelf";

interface ShelfTool {
  id: string;
  digest: string;
  abi?: string;
  limits?: { inputMaxBytes: number; outputMaxBytes: number };
}
interface ShelfManifest {
  engines?: string;
  tools: ShelfTool[];
}
interface Command {
  name: string;
  description: string;
  usage: string;
  source: string;
  body: string;
}
interface ToolAnswer {
  status: number;
  body: {
    ok?: boolean;
    code?: string;
    error?: string;
    resultB64?: string;
    resultDigest?: string;
    toolDigest?: string;
    blobHash?: string;
  };
}

let daemon: Daemon;
let base: string;
let home: string;
let badge: TestBadge;

const shelfDir = () => path.join(modulesDir(home), "wasm-tools");
const manifestPath = () => path.join(shelfDir(), "manifest.json");
const readManifest = (): ShelfManifest => JSON.parse(readFileSync(manifestPath(), "utf8")) as ShelfManifest;
const writeManifest = (manifest: ShelfManifest): void => writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2) + "\n");

/** The module as the pipeline emits it, installed where the daemon reads it.
 *
 * The pipeline runs on EVERY test file rather than trusting whatever is in
 * `dist/`: `dist/` is gitignored, so a fresh worktree has nothing, and a
 * stale build would let this test pass against a manifest the pipeline no
 * longer emits — proving the hookup works with last week's abi. The build's
 * own selftests run with it. */
let shelfBuilt = false;
let buildRoot = "";
let builtShelf = "";
async function installShelf(): Promise<void> {
  if (!shelfBuilt) {
    // The pipeline runs on EVERY test file rather than trusting whatever is in
    // `dist/`: `dist/` is gitignored, so a fresh worktree has nothing, and a
    // stale build would let this test pass against a manifest the pipeline no
    // longer emits — proving the hookup works with last week's abi. It builds
    // into its own temp root (`WASM_TOOLS_OUT`) so a test run cannot rewrite a
    // tracked binary in the checkout. The build's selftests run with it.
    buildRoot = await fs.mkdtemp(path.join(os.tmpdir(), "isocan-shelf-build-"));
    builtShelf = path.join(buildRoot, "dist/module/wasm-tools");
    execFileSync("node", ["build-all.mjs"], {
      cwd: path.join(repoRoot, "tools/wasm-tools"),
      env: { ...process.env, WASM_TOOLS_OUT: buildRoot },
      stdio: "pipe",
    });
    shelfBuilt = true;
  }
  await fs.rm(shelfDir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await fs.mkdir(path.dirname(shelfDir()), { recursive: true });
  await fs.cp(builtShelf, shelfDir(), { recursive: true });
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "isocan-wasm-shelf-"));
  await installShelf();
  daemon = await startDaemon({ port: 0, home });
  const address = daemon.app.server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  badge = await mintTestBadge(base);
  await badge.speakAs(alice);
  await accepted({ type: "project.create", canvasId, title: "Wasm shelf", groupMode: "legacy" }, null);
});

afterEach(async () => {
  await daemon?.close();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

afterAll(async () => {
  if (buildRoot) await fs.rm(buildRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function accepted(op: unknown, canvasIdForOp: string | null = canvasId): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/api/ops`, {
    method: "POST",
    headers: { ...badge.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ canvasId: canvasIdForOp, actor: alice, op }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}

async function commands(): Promise<Command[]> {
  const response = await fetch(`${base}/api/commands`, { headers: badge.headers });
  expect(response.status).toBe(200);
  return (await response.json()) as Command[];
}

async function runTool(tool: string, body: Record<string, unknown>): Promise<ToolAnswer> {
  const response = await fetch(`${base}/api/projects/${canvasId}/tools/${tool}`, {
    method: "POST",
    headers: { ...badge.headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as ToolAnswer["body"] };
}

const digestOf = (tool: string): string => readManifest().tools.find((t) => t.id === tool)?.digest ?? "";

/** The edit script's own format (`tools/wasm-tools/diff.c`): zero or more
 *  blocks of {op u8, aLine u32, aCount u32, bLine u32, bCount u32}, little-
 *  endian, terminated by op 255. Decoded here rather than eyeballed, because
 *  "there are bytes" is not "there is an edit script". */
function blocks(script: Buffer): Array<{ op: number; al: number; ac: number; bl: number; bc: number }> {
  const out: Array<{ op: number; al: number; ac: number; bl: number; bc: number }> = [];
  let i = 0;
  while (i + 1 < script.length) {
    const op = script[i] as number;
    i += 1;
    if (op === 255) break;
    const read = () => {
      const value = script.readUInt32LE(i);
      i += 4;
      return value;
    };
    out.push({ op, al: read(), ac: read(), bl: read(), bc: read() });
  }
  return out;
}

describe("the wasm shelf, hooked to the one command list", () => {
  it("1. the tools are GENERATED into the command list from the installed manifest", async () => {
    const list = await commands();
    const hash = list.find((c) => c.name === "wasm-hash");
    const diff = list.find((c) => c.name === "wasm-diff");
    expect(hash, "hash is in the one command list").toBeTruthy();
    expect(diff, "diff is in the one command list").toBeTruthy();
    expect(hash!.source).toBe("module");
    expect(hash!.description).toContain(digestOf("hash").slice(0, 12));
    expect(hash!.description, "the declared limit is IN the description").toContain("8192");
    expect(diff!.usage, "the two-text shape is generated from the abi").toBe("<text> <against>");

    // Generated, not hand-added: with the module gone the tools are gone too,
    // and no second file had to be edited to make that true.
    await fs.rm(shelfDir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const after = await commands();
    expect(after.filter((c) => c.name.startsWith("wasm-"))).toEqual([]);
  });

  it("2. hash runs: the result bytes are SHA-256 of the input, stored and readable by hash", async () => {
    const { status, body } = await runTool("hash", { input: "abc" });
    expect(status, JSON.stringify(body)).toBe(200);
    const output = Buffer.from(body.resultB64 ?? "", "base64");
    expect(output.toString("hex"), "the tool's real semantics, not just a 200").toBe(SHA256_ABC);
    expect(body.resultDigest).toBe(createHash("sha256").update(output).digest("hex"));
    expect(body.toolDigest).toBe(digestOf("hash"));

    // Addressable: the daemon stored the result; its hash reads it back.
    const fetched = await fetch(`${base}/api/projects/${canvasId}/blobs/${body.blobHash}`, { headers: badge.headers });
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).toString("hex")).toBe(SHA256_ABC);
  });

  it("3. diff runs: two texts in, a terminated edit script out, and identical texts say so", async () => {
    const { status, body } = await runTool("diff", { input: "one\ntwo", against: "one\nthree" });
    expect(status, JSON.stringify(body)).toBe(200);
    const script = Buffer.from(body.resultB64 ?? "", "base64");
    expect(script.length).toBeGreaterThan(1);
    expect(script[script.length - 1], "op 255 terminates the script").toBe(255);
    expect(body.resultDigest).toBe(createHash("sha256").update(script).digest("hex"));
    expect(blocks(script).some((b) => b.op !== 0), "a real difference produces a change block").toBe(true);

    // The control: two identical texts have no change to describe. Not an
    // empty script — the tool still emits an equal block — so the assertion is
    // "no op other than equal", which is the property that matters.
    const same = await runTool("diff", { input: "same", against: "same" });
    expect(same.status).toBe(200);
    const unchanged = blocks(Buffer.from(same.body.resultB64 ?? "", "base64"));
    expect(unchanged.length).toBeGreaterThan(0);
    expect(unchanged.every((b) => b.op === 0), "identical texts produce no change op").toBe(true);
    expect(unchanged.reduce((n, b) => n + b.ac, 0)).toBe(1);
  });

  it("4. every refusal is NAMED — and one tampered byte never reaches instantiation", async () => {
    const unknown = await runTool("nope", { input: "x" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("tool-unknown");

    const missing = await runTool("diff", { input: "only one text" });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("tool-input-missing");

    const tooBig = await runTool("hash", { input: "x".repeat(8193) });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.code).toBe("capability-exceeded");
    expect(tooBig.body.error, "the declared limit is in the sentence").toContain("8192");

    // The one that matters: flip one byte of the module on disk. The manifest
    // still pins the original digest, so the host must refuse BEFORE it
    // instantiates — and must return no result at all.
    const wasm = path.join(shelfDir(), "assets", "hash.wasm");
    const bytes = readFileSync(wasm);
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] as number) ^ 0x01;
    writeFileSync(wasm, bytes);
    const tampered = await runTool("hash", { input: "abc" });
    expect(tampered.status).toBe(409);
    expect(tampered.body.code).toBe("digest-mismatch");
    expect(tampered.body.resultB64, "nothing ran").toBeUndefined();

    await installShelf();
    const unsupported = readManifest();
    (unsupported.tools.find((t) => t.id === "hash") as ShelfTool).abi = "guessing-9";
    writeManifest(unsupported);
    const wrongAbi = await runTool("hash", { input: "abc" });
    expect(wrongAbi.status).toBe(409);
    expect(wrongAbi.body.code).toBe("tool-abi-unsupported");

    await installShelf();
    const refused = readManifest();
    refused.engines = ">=999.0.0";
    writeManifest(refused);
    const refusedModule = await runTool("hash", { input: "abc" });
    expect(refusedModule.status).toBe(409);
    expect(refusedModule.body.code).toBe("tool-refused");
  });

  it("5. a refused module's tool is LISTED with its reason — visible, never silently skipped", async () => {
    const manifest = readManifest();
    manifest.engines = ">=999.0.0";
    writeManifest(manifest);
    const hash = (await commands()).find((c) => c.name === "wasm-hash");
    expect(hash, "the tool is still listed after its module is refused").toBeTruthy();
    expect(hash!.description).toContain("REFUSED");
  });
});
