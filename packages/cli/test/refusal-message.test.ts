import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon, type Daemon } from "@isocan/server/daemon";

/**
 * **The refusal reaches the person, in the daemon's own words** (isocan-iiq,
 * isocan-ox7).
 *
 * Paul's report was `item.addVersion — internal error`, where the daemon had
 * actually answered with a specific, actionable sentence: *"that canvas lives
 * at … and this daemon cannot reach it (…) — the write was NOT made. … a
 * replica's CLI writes are not."* The mapping is right at the HTTP layer
 * (`http.ts:950`, 503 + the message + `code: home-unreachable`) and two server
 * tests assert it — but nothing asserted the layer a person actually reads: the
 * CLI's rendering of that body.
 *
 * So this test drives the whole path with no mocks: a real daemon, a real
 * closed port, the real CLI binary. It fails if the CLI ever flattens the
 * daemon's refusal into a generic message — which is the one regression this
 * bead exists to prevent, and the reason the last assertion is a negative.
 */

const cliBin = fileURLToPath(new URL("../bin/isocan.js", import.meta.url));

let home: string;
let daemon: Daemon;
let port: number;
let birth: string;

/** A port that is closed: bind it, learn the number, let it go. */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const found = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(found));
    });
    probe.on("error", reject);
  });
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "isocan-refusal-"));
  await fs.writeFile(
    path.join(home, "identity.json"),
    JSON.stringify({ id: "usr_reviewer", name: "Reviewer", createdAt: new Date().toISOString() }),
  );
  birth = `http://127.0.0.1:${await closedPort()}`;
  daemon = await startDaemon({ port: 0, home, birthHome: birth });
  const address = daemon.app.server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterEach(async () => {
  await daemon.close();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * The real binary, against the daemon that is running for this case.
 *
 * **Async `spawn`, never `spawnSync`.** The daemon for this case lives in THIS
 * process, so a synchronous child would block the very event loop that has to
 * answer it — measured: the worker died with `ERR_IPC_CHANNEL_CLOSED` and the
 * run produced no results. It is why every walk in this suite spawns this way.
 */
function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliBin, ...args], {
      env: { ...process.env, ISOCAN_HOME: home, ISOCAN_PORT: String(port) },
      timeout: 60_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("a write whose home is unreachable", () => {
  it("prints the daemon's refusal in its own words, never 'internal error'", async () => {
    // The canvas is born at an address nothing answers on, so the create forwards
    // to that home, the forward fails, and the daemon answers 503. The birth home
    // is set on the DAEMON rather than with `isocan home --force`: that verb
    // RESTARTS the daemon, and this daemon is in-process, so the CLI would take
    // its own test's worker down with it (measured: ERR_IPC_CHANNEL_CLOSED).
    const refused = await cli("canvas", "create", "Refused canvas");

    expect(refused.code, "a refusal is not a success").not.toBe(0);
    expect(refused.stderr, "the canvas's home is named").toContain(birth);
    expect(refused.stderr, "the write's fate is named").toContain("the write was NOT made");
    expect(refused.stderr, "the cause is named").toContain("cannot reach it");
    // The negative, and the reason this test exists: the message Paul saw was
    // the generic one, and a CLI that says "internal error" has thrown away a
    // sentence it was handed.
    expect(refused.stderr).not.toContain("internal error");
  });
});
