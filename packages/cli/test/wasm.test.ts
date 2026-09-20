/**
 * **`isocan wasm ls` and `isocan wasm run`, driven against a real daemon.**
 *
 * The server test (`packages/server/test/wasm-shelf.test.ts`) proves the route:
 * the generated command list, both abis, the refusals. What it cannot prove is
 * the half a person or an agent actually touches — that the verb prints what it
 * ran, posts the addressable receipt with both digests on it, and exits
 * non-zero WITHOUT posting anything when the daemon refuses.
 *
 * So this runs the real CLI (its own daemon, its own home) with the shelf
 * installed where a module goes, which is the same door every other verb
 * comes through.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cliBin = fileURLToPath(new URL("../bin/isocan.js", import.meta.url));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** One CLI invocation in a home that already exists. */
function isocan(home: string, args: string[], input?: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, ...args], {
      cwd: home, // the canvas binds to the directory the command runs in
      env: { ...process.env, ISOCAN_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
}

let home = "";
let buildRoot = "";

beforeAll(async () => {
  // The same rule the server test follows: build the REAL current pipeline
  // rather than trust whatever is in `dist/`, because `dist/` is gitignored
  // and a stale manifest would let this pass against an abi the pipeline no
  // longer emits. It builds into its own temp root (`WASM_TOOLS_OUT`), so a
  // test run cannot rewrite a tracked binary in the checkout.
  buildRoot = await fs.mkdtemp(path.join(os.tmpdir(), "isocan-wasm-cli-build-"));
  execFileSync("node", ["build-all.mjs"], {
    cwd: path.join(repoRoot, "tools/wasm-tools"),
    env: { ...process.env, WASM_TOOLS_OUT: buildRoot },
    stdio: "pipe",
  });
  home = await fs.mkdtemp(path.join(os.tmpdir(), "isocan-wasm-cli-"));
  await fs.mkdir(path.join(home, "modules"), { recursive: true });
  await fs.cp(path.join(buildRoot, "dist/module/wasm-tools"), path.join(home, "modules", "wasm-tools"), { recursive: true });
  const named = await isocan(home, ["identity", "--name", "Shelf Driver"]);
  expect(named.code, named.stderr).toBe(0);
}, 120_000);

afterAll(async () => {
  if (buildRoot) await fs.rm(buildRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (home) await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("`isocan wasm` — the shelf an agent can actually call", () => {
  it("ls lists the tools with their digests and declared limits, generated from the manifest", async () => {
    const { code, stdout, stderr } = await isocan(home, ["wasm", "ls"]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("wasm-hash");
    expect(stdout).toContain("wasm-diff");
    expect(stdout).toContain("inputs ≤ 8192 bytes");
    // The two-text shape is generated from the abi, not hand-written per tool.
    expect(stdout).toContain("isocan wasm run diff <text> <against>");
  }, 120_000);

  it("run posts an addressable receipt naming the tool and both digests", async () => {
    const ran = await isocan(home, ["wasm", "run", "hash", "abc"]);
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout, "the real digest of the input, printed").toContain(SHA256_ABC);

    const listed = await isocan(home, ["ls", "--json"]);
    expect(listed.code, listed.stderr).toBe(0);
    const items = JSON.parse(listed.stdout) as Array<{ title: string; properties: Record<string, string> }>;
    const receipt = items.find((item) => item.title === "wasm hash run");
    expect(receipt, "the receipt item is on the canvas").toBeTruthy();
    expect(receipt!.properties.role).toBe("tool-run");
    expect(receipt!.properties.tool).toBe("hash");
    expect(receipt!.properties.inputDigest).toBe(SHA256_ABC);
    expect(receipt!.properties.status).toBe("ok");
  }, 180_000);

  it("a refusal exits non-zero, names the gate, and posts NOTHING", async () => {
    const before = await isocan(home, ["ls", "--json"]);
    const countBefore = (JSON.parse(before.stdout) as unknown[]).length;

    const refused = await isocan(home, ["wasm", "run", "hash", "x".repeat(9000)]);
    expect(refused.code, "a refusal is not a success").toBe(1);
    expect(refused.stderr).toContain("refused (capability-exceeded)");
    expect(refused.stderr, "the declared limit is in the sentence").toContain("8192");

    const after = await isocan(home, ["ls", "--json"]);
    expect((JSON.parse(after.stdout) as unknown[]).length, "no receipt claims a run that did not happen").toBe(countBefore);
  }, 180_000);
});
