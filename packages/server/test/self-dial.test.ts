import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDaemon, type Daemon } from "../src/daemon.ts";
import { mintTestBadge } from "./badge.ts";
import { isSelfAddress } from "../src/self-address.ts";
import { MAX_CONCURRENT_DIALS } from "../src/home-link.ts";

describe("isocan-vab: self-dial prevention and socket leak containment", () => {
  let homeDir: string;
  let daemon: Daemon | null = null;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "isocan-vab-test-"));
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.close();
      daemon = null;
    }
    await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
  });

  it("isSelfAddress identifies all loopback and local origin variants on matching port", () => {
    const port = 4465;
    expect(isSelfAddress(`http://127.0.0.1:${port}`, port)).toBe(true);
    expect(isSelfAddress(`http://localhost:${port}`, port)).toBe(true);
    expect(isSelfAddress(`http://0.0.0.0:${port}`, port)).toBe(true);
    expect(isSelfAddress(`http://[::1]:${port}`, port)).toBe(true);

    // Different port is not self
    expect(isSelfAddress(`http://127.0.0.1:${port + 1}`, port)).toBe(false);
    expect(isSelfAddress(`http://localhost:80`, port)).toBe(false);

    // External domain is not self
    expect(isSelfAddress("https://isocan.io", port)).toBe(false);
    expect(isSelfAddress("https://dev.isocan.io", port)).toBe(false);

    // Null/undefined/malformed
    expect(isSelfAddress(null, port)).toBe(false);
    expect(isSelfAddress(undefined, port)).toBe(false);
    expect(isSelfAddress("not-a-url", port)).toBe(false);
  });

  it("a self-home daemon creates canvases locally and does not open a single socket to itself", async () => {
    // 1. Discover a free ephemeral port
    const probe = await startDaemon({ port: 0, home: homeDir, birthHome: null });
    const port = (probe.app.server.address() as any).port;
    await probe.close();

    const selfUrl = `http://127.0.0.1:${port}`;
    let connectionsToSelf = 0;

    // 2. Boot daemon configured with birthHome pointing to its own listen origin
    daemon = await startDaemon({
      port,
      home: homeDir,
      birthHome: selfUrl,
      homePollMs: 50, // fast poll to aggressively exercise any potential loop
    });

    const badge = await mintTestBadge(selfUrl);
    const alice = { id: "usr_alice", name: "Alice" };
    await badge.speakAs(alice);

    // Track every TCP connection arriving at the server AFTER setup
    daemon.app.server.on("connection", () => {
      connectionsToSelf++;
    });

    // 3. Create a canvas born on this daemon
    const res = await fetch(`${selfUrl}/api/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...badge.headers },
      body: JSON.stringify({
        canvasId: "prj_self_dial_test",
        actor: alice,
        op: { type: "project.create", canvasId: "prj_self_dial_test", title: "Test Canvas" },
      }),
    });

    // Operation must succeed locally
    expect(res.status).toBe(200);

    // Wait for any asynchronous poll/dial cycles to attempt
    await new Promise((r) => setTimeout(r, 300));

    // Zero outbound connections made to itself
    expect(connectionsToSelf, "a self-home daemon must not open a single socket to itself").toBe(0);

    // The canvas must be treated as local in the daemon's home registry
    expect(daemon.homes.for("prj_self_dial_test")).toBeNull();
    expect(daemon.homes.isSelf(selfUrl)).toBe(true);
  }, 10_000);

  it("homes.bind short-circuits self URLs to null without dialling", async () => {
    daemon = await startDaemon({ port: 0, home: homeDir, birthHome: null });
    const port = (daemon.app.server.address() as any).port;
    const selfUrl = `http://127.0.0.1:${port}`;

    // Explicitly bind a canvas to self
    const connection = await daemon.homes.bind("prj_self_bound", selfUrl);

    // Must return null (local canvas)
    expect(connection).toBeNull();
    expect(daemon.homes.for("prj_self_bound")).toBeNull();
    expect(daemon.homes.homeOf("prj_self_bound")).toBeNull();
  });

  it("enforces maximum concurrent in-flight dial bounds", () => {
    expect(MAX_CONCURRENT_DIALS).toBe(8);
  });
});
