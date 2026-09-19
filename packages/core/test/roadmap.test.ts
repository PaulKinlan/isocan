import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { roadmapSource } from "../src/roadmapsource.ts";
import { landRoadmap, parseRoadmap, readRoadmap, roadmapCards } from "../src/roadmap.ts";
import { classifyAddable } from "../src/addable.ts";
import { applyOperation } from "../src/reducer.ts";
import { envelope, seedState } from "./helpers.ts";
import type { Operation } from "../src/ops.ts";

const COMMIT = "a".repeat(40);
const input = "https://github.com/acme/widgets";
const source = roadmapSource(input)!;
const markdown = `# Roadmap

**1 built · 1 still open** — summary numbers come from the file.

## Designed <sub>1</sub>

| | What | Since | |
| --- | --- | --- | --- |
| research | [A \\| B](research/a.md) | 2026-01-01 | A note with \\| a pipe · see alpha, beta · [#12](https://github.com/acme/widgets/issues/12) |

## Built <sub>1</sub>

| | What | Since | |
| --- | --- | --- | --- |
| **project** | [Gamma](projects/gamma/journey.md) | 2026-01-02 | Finished |
`;
const bytes = Buffer.from(markdown);
const blobSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
function github() {
  return vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url).endsWith("/commits/HEAD")) return Response.json({ sha: COMMIT });
    if (String(url).includes("/contents/")) return Response.json({ sha: blobSha, path: "docs/ROADMAP.md", type: "file", size: bytes.length });
    return new Response(markdown, { headers: { "content-type": "text/plain" } });
  });
}

describe("closed roadmap source recognition", () => {
  it("recognises a repository/default branch and an explicit file", () => {
    expect(roadmapSource("acme/widgets")).toEqual(source);
    expect(roadmapSource(input + "/blob/topic/docs/PLAN.md")).toMatchObject({ ref: "topic", path: "docs/PLAN.md" });
    expect(classifyAddable(input, [])).toMatchObject({ kind: "roadmap" });
  });
  it.each(["https://example.com/acme/widgets", "https://github.com.evil.test/acme/widgets", "https://u:p@github.com/acme/widgets", "http://github.com/acme/widgets", input + "/issues/2", input + "/blob/main/../ROADMAP.md", input + "/blob/main/%2e%2e/ROADMAP.md", input + "/blob/main/a%2Fb.md", "file:///tmp/roadmap.md"])("refuses %s before fetching", async (url) => {
    const fetcher = github();
    expect(roadmapSource(url)).toBeNull();
    await expect(readRoadmap(url, fetcher)).rejects.toThrow(/public GitHub/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("one pinned reading", () => {
  it("pins every request/link to a commit, never to the contents API blob SHA", async () => {
    const fetcher = github();
    const reading = await readRoadmap(input, fetcher);
    expect(reading.commit).toBe(COMMIT);
    expect(reading.blobSha).toBe(blobSha);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      "https://api.github.com/repos/acme/widgets/commits/HEAD",
      `https://api.github.com/repos/acme/widgets/contents/docs/ROADMAP.md?ref=${COMMIT}`,
      `https://raw.githubusercontent.com/acme/widgets/${COMMIT}/docs/ROADMAP.md`,
    ]);
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ credentials: "omit", redirect: "error" });
    const cards = roadmapCards(reading);
    expect(cards).toHaveLength(5);
    expect(cards[0]!.markdown).toContain("1 built · 1 still open");
    expect(cards[2]!.properties.source).toBe(`${input}/blob/${COMMIT}/docs/research/a.md`);
    expect(cards[2]!.markdown).toContain("[#12](https://github.com/acme/widgets/issues/12)");
    expect(cards[4]!.markdown).not.toContain("/issues/");
    expect(cards.every(card => card.properties["roadmap.blob"] === blobSha && card.properties.synced === reading.readAt)).toBe(true);
  });
  it("refuses changed raw bytes even with successful HTTP responses", async () => {
    const fetcher = github();
    fetcher.mockImplementationOnce(async () => Response.json({ sha: COMMIT }))
      .mockImplementationOnce(async () => Response.json({ sha: "f".repeat(40), path: "docs/ROADMAP.md", type: "file", size: bytes.length }));
    await expect(readRoadmap(input, fetcher)).rejects.toThrow(/blob SHA/);
  });
  it("names GitHub's refusal without turning it into an empty canvas", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ message: "API rate limit exceeded" }, { status: 403 }));
    await expect(readRoadmap(input, fetcher)).rejects.toThrow("GitHub answered 403: API rate limit exceeded");
  });
  it("parses escaped table cells and keeps see as words", () => {
    const parsed = parseRoadmap(markdown, source);
    expect(parsed.sections.map(s => s.title)).toEqual(["Designed", "Built"]);
    expect(parsed.sections[0]!.rows[0]).toEqual({ title: "A | B", category: "research", path: "docs/research/a.md", since: "2026-01-01", note: "A note with | a pipe", see: "alpha, beta", issue: { label: "#12", url: input + "/issues/12" } });
  });
  it("refuses a guessed external document or issue link", () => {
    expect(() => parseRoadmap(markdown.replace("research/a.md", "https://example.com/a.md"), source)).toThrow(/repository-relative/);
    expect(() => parseRoadmap(markdown.replace("/widgets/issues/12", "/elsewhere/issues/12"), source)).toThrow(/named repository/);
  });
  it("resolves relative documents without URL-normalising away an escape", () => {
    expect(parseRoadmap(markdown.replace("research/a.md", "../README.md"), source).sections[0]!.rows[0]!.path).toBe("README.md");
    for (const href of ["../../outside.md", "%2e%2e/%2e%2e/outside.md", "research%2Fa.md", "research/a.md#guess", "research/a.md?ref=main"]) {
      expect(() => parseRoadmap(markdown.replace("research/a.md", href), source)).toThrow();
    }
  });
  it("accepts every generated row in the repository's actual format", () => {
    const current = readFileSync(new URL("../../../docs/ROADMAP.md", import.meta.url), "utf8");
    const parsed = parseRoadmap(current, roadmapSource("dglazkov/isocan")!);
    const rows = current.split("\n").filter(line => /^\| (research|\*\*project\*\*) \|/.test(line));
    expect(parsed.sections.flatMap(s => s.rows)).toHaveLength(rows.length);
    expect(rows.length).toBeGreaterThan(0);
  });
  it("lands the same native cards with one undo group and no editable backdoor", async () => {
    const reading = await readRoadmap(input, github());
    let state = seedState();
    const groups: string[] = [];
    const upload = vi.fn(async (body: string) => ({ blobHash: createHash("sha256").update(body).digest("hex"), size: Buffer.byteLength(body) }));
    const ids = await landRoadmap(reading, { x: 2000, y: 4000 }, { upload, send: async (op, group) => { groups.push(group); state = applyOperation(state, envelope(op))!; } });
    expect(ids).toHaveLength(5);
    expect(new Set(groups).size).toBe(1);
    expect(state.canvas.items[ids[0]!]!.x).toBe(2000);
    expect(state.canvas.items[ids[2]!]!.title).toBe("A | B");
    expect(() => applyOperation(state, envelope({ type: "item.update", itemId: ids[2]!, patch: { title: "Different" } }))).toThrow(/derived/);
  });
  it("never lands a card after an upload failed; reports partial operation failure accurately", async () => {
    const reading = await readRoadmap(input, github());
    const send = vi.fn(async (_op: Operation) => undefined);
    await expect(landRoadmap(reading, { x: 0, y: 0 }, { upload: async () => { throw new Error("disk full"); }, send })).rejects.toThrow("disk full");
    expect(send).not.toHaveBeenCalled();
    send.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disconnected"));
    await expect(landRoadmap(reading, { x: 0, y: 0 }, { upload: async () => ({ blobHash: "hash", size: 1 }), send })).rejects.toThrow("1 of 5 cards added. disconnected");
  });
});
