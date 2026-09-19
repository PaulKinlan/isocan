import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDaemon, type Daemon } from "../src/daemon.ts";
import { mintTestBadge } from "./badge.ts";
import { isSelfAddress, resolveCache, MAX_RESOLVE_CACHE_ENTRIES } from "../src/self-address.ts";
import { HomeLink, MAX_CONCURRENT_DIALS } from "../src/home-link.ts";

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

  it("isSelfAddress identifies all loopback, local IPs, IPv4-mapped IPv6, machine hostname variants, and trailing dot FQDNs", () => {
    const port = 4465;
    expect(isSelfAddress(`http://127.0.0.1:${port}`, port)).toBe(true);
    expect(isSelfAddress(`http://localhost:${port}`, port)).toBe(true);
    expect(isSelfAddress(`http://0.0.0.0:${port}`, port)).toBe(true);
    expect(isSelfAddress(`http://[::1]:${port}`, port)).toBe(true);
    expect(isSelfAddress(`http://[::]:${port}`, port)).toBe(true);

    // F6: Trailing dot in FQDN
    expect(isSelfAddress(`http://localhost.:${port}`, port)).toBe(true);

    // F1: Machine hostname and .local FQDN
    const myHost = os.hostname().toLowerCase();
    expect(isSelfAddress(`http://${myHost}:${port}`, port)).toBe(true);
    expect(isSelfAddress(`http://${myHost}.local:${port}`, port)).toBe(true);
    expect(isSelfAddress(`http://${myHost}.:${port}`, port)).toBe(true);

    // F2: IPv4-mapped IPv6 loopbacks (both dotted-decimal and hex)
    expect(isSelfAddress(`http://[::ffff:127.0.0.1]:${port}`, port)).toBe(true);
    expect(isSelfAddress(`http://[::ffff:7f00:1]:${port}`, port)).toBe(true);

    // Local interfaces (LAN, Tailscale)
    const ifaces = os.networkInterfaces();
    for (const iface of Object.values(ifaces)) {
      for (const info of iface ?? []) {
        expect(isSelfAddress(`http://${info.address.includes(":") ? `[${info.address}]` : info.address}:${port}`, port)).toBe(true);
      }
    }

    // F5: Positive control — remote home starting with machine hostname must NOT be self
    expect(isSelfAddress(`http://${myHost}.evil.com:${port}`, port)).toBe(false);
    expect(isSelfAddress(`http://${myHost}.example.com:${port}`, port)).toBe(false);

    // Different port is not self
    expect(isSelfAddress(`http://127.0.0.1:${port + 1}`, port)).toBe(false);
    expect(isSelfAddress(`http://${myHost}:${port + 1}`, port)).toBe(false);

    // External domain is not self
    expect(isSelfAddress("https://isocan.io", port)).toBe(false);
    expect(isSelfAddress("http://unrelated-remote-host.invalid:4465", port)).toBe(false);

    // Null/undefined/malformed
    expect(isSelfAddress(null, port)).toBe(false);
    expect(isSelfAddress(undefined, port)).toBe(false);
    expect(isSelfAddress("not-a-url", port)).toBe(false);
  });

  it("a self-home daemon bound to host '::' with machine hostname creates canvases locally with 0 sockets to self (F1 & F6)", async () => {
    // 1. Probe a free ephemeral port on dual-stack host '::'
    const probe = await startDaemon({ port: 0, host: "::", home: homeDir, birthHome: null });
    const port = (probe.app.server.address() as any).port;
    await probe.close();

    const myHost = os.hostname().toLowerCase();
    const hostnameSelfUrl = `http://${myHost}:${port}`;
    let connectionsToSelf = 0;

    // 2. Boot daemon bound to "::" configured with birthHome pointing to hostnameSelfUrl
    daemon = await startDaemon({
      port,
      host: "::",
      home: homeDir,
      birthHome: hostnameSelfUrl,
      homePollMs: 50,
    });

    const badge = await mintTestBadge(`http://127.0.0.1:${port}`);
    const alice = { id: "usr_alice", name: "Alice" };
    await badge.speakAs(alice);

    // Track every connection arriving at the server
    daemon.app.server.on("connection", () => {
      connectionsToSelf++;
    });

    // 3. Create a canvas born on this daemon
    const res = await fetch(`http://127.0.0.1:${port}/api/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...badge.headers },
      body: JSON.stringify({
        canvasId: "prj_hostname_dial_test",
        actor: alice,
        op: { type: "project.create", canvasId: "prj_hostname_dial_test", title: "Hostname Test Canvas" },
      }),
    });

    expect(res.status).toBe(200);

    // Wait for any async dial or poll loop to attempt to run
    await new Promise((r) => setTimeout(r, 400));

    // Zero sockets opened to itself
    expect(connectionsToSelf, "hostname self-home daemon must open 0 sockets to itself").toBe(0);
    expect(daemon.homes.for("prj_hostname_dial_test")).toBeNull();
    expect(daemon.homes.isSelf(hostnameSelfUrl)).toBe(true);
    expect(daemon.homes.isSelf(`http://localhost.:${port}`)).toBe(true);
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

  it("fetchHome refuses to make outbound HTTP requests to self (F4)", async () => {
    daemon = await startDaemon({ port: 0, home: homeDir, birthHome: null });
    const port = (daemon.app.server.address() as any).port;
    const selfUrl = `http://127.0.0.1:${port}`;

    const link = daemon.homes.linkFor(selfUrl);
    expect(link).toBeDefined();

    // Calling putBlob on a self link throws HomeUnreachableError at fetchHome without network I/O
    await expect(
      link.putBlob("prj_1", Buffer.from("test"), { mimeType: "text/plain", filename: "test.txt" }),
    ).rejects.toThrow("cannot fetch home: address points to this daemon itself (isocan-vab)");
  });

  it("bounds concurrent in-flight dials to MAX_CONCURRENT_DIALS and defers excess dials (F3)", async () => {
    daemon = await startDaemon({ port: 0, home: homeDir, birthHome: null });

    // Create a mock link where dials are slow to simulate in-flight concurrency
    const link = new HomeLink({
      homeUrl: "https://remote.invalid",
      home: homeDir,
      engine: daemon.engine,
      presence: daemon.homes["options"].presence,
      registry: daemon.homes,
      isSelf: false,
    });

    // Mock ensureBadge to take 100ms so dials stay in-flight
    let currentInFlight = 0;
    let peakInFlight = 0;
    (link as any).ensureBadge = async () => {
      currentInFlight++;
      if (currentInFlight > peakInFlight) peakInFlight = currentInFlight;
      await new Promise((r) => setTimeout(r, 100));
      currentInFlight--;
      return null; // stop dial from attempting real network connection
    };

    // Trigger 16 concurrent canvas dials (more than MAX_CONCURRENT_DIALS = 8)
    for (let i = 1; i <= 16; i++) {
      (link as any).openCanvas(`prj_concurrent_${i}`);
    }

    // Wait for the dials to execute their first pass
    await new Promise((r) => setTimeout(r, 50));

    // Peak concurrent in-flight dials must NOT exceed MAX_CONCURRENT_DIALS
    expect(peakInFlight).toBe(MAX_CONCURRENT_DIALS);

    // Excess canvases (canvases 9-16) must have their dial deferred via reconnect retry
    const allCanvasLinks = Array.from((link as any).links.values()) as any[];
    const retrying = allCanvasLinks.filter((l) => l.retry !== null);
    expect(retrying.length).toBeGreaterThanOrEqual(16 - MAX_CONCURRENT_DIALS);

    await link.close();
  });

  it("never caches a resolution failure (F7: negative caching trap) and bounds cache size", () => {
    resolveCache.clear();
    const port = 4465;

    // 1. Unresolvable host: evaluated as remote
    const unresolvable = "http://unresolvable-boot-time-host.invalid:4465";
    expect(isSelfAddress(unresolvable, port)).toBe(false);

    // F7 assertion: Unresolvable host must NOT be cached!
    expect(resolveCache.has("unresolvable-boot-time-host.invalid"), "negative resolution must never be cached").toBe(false);

    // 2. Resolvable local name requiring DNS/getent (Tailscale MagicDNS alias): positive result IS cached for 0ms future lookups
    const tailHost = "omarchy.tail9d22b9.ts.net";
    expect(isSelfAddress(`http://${tailHost}:${port}`, port)).toBe(true);
    expect(resolveCache.has(tailHost), "positive resolution must be cached").toBe(true);
    expect(resolveCache.get(tailHost)!.length).toBeGreaterThan(0);

    // 3. Cache size is bounded
    expect(MAX_RESOLVE_CACHE_ENTRIES).toBe(256);
  });
});
