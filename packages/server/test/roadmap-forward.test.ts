import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { roadmapSource } from "@isocan/core";
import { landRoadmap, parseRoadmap } from "@isocan/core/roadmap";
import { startDaemon, type Daemon } from "../src/daemon.ts";
import { mintTestBadge } from "./badge.ts";

// A fresh instrument for the route the direct-only roadmap journey missed:
// real HTTP client → replica → authoritative home, compared with client → home.
// The same synthetic 105-row / 111-card reading goes through both routes. No
// GitHub dependency, shared home, fixed port or ISOCAN_DIRECT environment switch.
const actor = { id: "usr_roadmap", name: "Acme Reader" };
const canvasId = "prj_roadmap_forward";
const source = roadmapSource("acme/roadmap")!;
const markdown = ["# Roadmap", "105 documents.", ...Array.from({ length: 5 }, (_, section) => [
  `## Section ${section}`,
  "| Kind | Document | Since | Note |",
  "| --- | --- | --- | --- |",
  ...Array.from({ length: 21 }, (_, row) => `| feature | [Row ${section}-${row}](rows/${section}-${row}.md) | 2026-09-20 | Synthetic |`),
].join("\n"))].join("\n\n");
const reading = {
  source, commit: "a".repeat(40),
  blobSha: createHash("sha1").update(`blob ${Buffer.byteLength(markdown)}\0`).update(markdown).digest("hex"),
  readAt: "2026-09-20T00:00:00Z", roadmap: parseRoadmap(markdown, source),
};
const daemons: Daemon[] = [];
const dirs: string[] = [];

async function node(birthHome: string | null) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "isocan-roadmap-forward-"));
  dirs.push(home);
  const daemon = await startDaemon({ port: 0, contentPort: 0, home, birthHome, homePollMs: 50, auth: null, operators: [] });
  daemons.push(daemon);
  const address = daemon.app.server.address();
  if (!address || typeof address === "string") throw new Error("daemon did not bind a TCP port");
  const base = `http://127.0.0.1:${address.port}`;
  const badge = await mintTestBadge(base);
  async function post(route: string, body: unknown) {
    const response = await fetch(`${base}${route}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...badge.headers },
      body: JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }
  return { daemon, base, badge, post };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("a derived roadmap is one undo through either transport", () => {
  it.each(["direct", "forwarded"] as const)("%s: preserves the request group and removes all 111 cards", async (route) => {
    const writer = await node(null);
    const client = route === "forwarded" ? await node(writer.base) : writer;
    await client.badge.speakAs(actor);
    await client.post("/api/ops", {
      canvasId: null, actor,
      op: { type: "project.create", canvasId, title: "Acme roadmap", groupMode: "groups" },
    });
    // Observes the real incoming request without replacing the writer or its
    // result. In the forwarded case this is AFTER the second HTTP crossing.
    const writerSubmit = vi.spyOn(writer.daemon.engine, "submit");
    const sentGroups: string[] = [];
    const ids = await landRoadmap(reading, { x: 0, y: 0 }, {
      async upload(body, filename) {
        const response = await fetch(`${client.base}/api/projects/${canvasId}/blobs`, {
          method: "POST", headers: { "Content-Type": "text/markdown", "X-Isocan-Filename": filename, ...client.badge.headers }, body,
        });
        expect(response.status, await response.clone().text()).toBe(200);
        return response.json() as Promise<{ blobHash: string; size: number }>;
      },
      send(op, group) {
        sentGroups.push(group);
        return client.post("/api/ops", { canvasId, actor, op, group });
      },
    });
    const received = writerSubmit.mock.calls.map(([request]) => request).filter(request => request.canvasId === canvasId);
    const entries = (await writer.daemon.engine.getLog(canvasId)).filter(entry => entry.envelope.op.type !== "project.create");
    const before = Object.keys((await writer.daemon.engine.getSnapshot(canvasId)).canvas.items).length;
    await client.post(`/api/projects/${canvasId}/undo`, { actor });
    const atHome = await writer.daemon.engine.getSnapshot(canvasId);
    const after = Object.keys(atHome.canvas.items).length;
    // A multi-entry undo returns its final receipt; the replica catches up
    // asynchronously over its home link. Wait for that sequence, not a sleep
    // or an assumed empty canvas (the unfixed route converges to 110 items).
    await vi.waitFor(async () => {
      expect((await client.daemon.engine.getSnapshot(canvasId)).lastSeq).toBe(atHome.lastSeq);
    }, { timeout: 10_000, interval: 20 });
    const replicaAfter = Object.keys((await client.daemon.engine.getSnapshot(canvasId)).canvas.items).length;

    console.info(JSON.stringify({ route, cards: ids.length, before, after, replicaAfter,
      sent: sentGroups.length, received: received.length,
      requestGroups: [...new Set(received.map(request => request.group ?? null))],
      recordedGroups: [...new Set(entries.map(entry => entry.group ?? null))],
    }));
    expect(ids).toHaveLength(111);
    expect(before).toBe(111);
    expect(sentGroups).toHaveLength(111);
    expect(new Set(sentGroups).size).toBe(1);
    expect(sentGroups[0]).toMatch(/^grp_/);
    expect.soft(received).toHaveLength(111);
    expect.soft([...new Set(received.map(request => request.group))], "group must reach the authoritative writer on every request").toEqual([sentGroups[0]]);
    expect.soft(entries).toHaveLength(111);
    expect.soft([...new Set(entries.map(entry => entry.group))], "group must survive into every recorded entry").toEqual([sentGroups[0]]);
    expect.soft(after, "one undo at the home removes the whole reading").toBe(0);
    expect.soft(replicaAfter, "the caller observes the same undo").toBe(0);
  });
});
