import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { RootContent, PhrasingContent, TableCell } from "mdast";
import { githubPath, roadmapSource, roadmapDocumentUrl } from "./roadmapsource.ts";
import type { RoadmapSource } from "./roadmapsource.ts";
import { newGroupId, newItemId, newVersionId } from "./ids.ts";
import type { Operation } from "./ops.ts";

/** One source-authored table row; see references are words, never guessed links. */
interface RoadmapRow { title: string; category: string; path: string; since: string; note: string; see: string; issue: { label: string; url: string } | null }
/** Source summary and ordered sections, without recomputed status totals. */
interface Roadmap { summary: string; sections: { title: string; rows: RoadmapRow[] }[] }
/** A verified file at a real commit; blobSha identifies its bytes separately. */
interface RoadmapReading { source: RoadmapSource; commit: string; blobSha: string; readAt: string; roadmap: Roadmap }
/** Client-independent ordinary-item content and relative placement. */
interface RoadmapCard { key: string; title: string; markdown: string; x: number; y: number; width: number; height: number; properties: Record<string, string> }
const SHA = /^[a-f0-9]{40}$/;
const MAX_BYTES = 1_000_000;
const plain = (node: RootContent | PhrasingContent | TableCell): string => "children" in node ? node.children.map(child => plain(child as PhrasingContent)).join("") : node.type === "html" ? "" : "value" in node ? node.value : "";
const quote = (text: string): string => text.replace(/[\\`*_[\]<>#!|]/g, "\\$&");

/** Same file-relative link semantics as GitHub. No guessing that a docs/ prefix
 * meant repository-root; ../ can reach siblings but cannot leave the repository. */
function documentPath(href: string, source: RoadmapSource): string {
  if (/^[a-z][a-z\d+.-]*:|^\/|[\\?#]/i.test(href)) throw new Error(`Roadmap document must be a repository-relative file: ${href}`);
  const parts = source.path.split("/").slice(0, -1);
  for (const encoded of href.split("/")) {
    let part: string;
    try { part = decodeURIComponent(encoded); } catch { throw new Error(`Malformed document link: ${href}`); }
    if (part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error(`Document link leaves the repository: ${href}`);
      parts.pop();
    } else {
      if (!part || /[/\\\x00-\x1f]/.test(part)) throw new Error(`Malformed document link: ${href}`);
      parts.push(part);
    }
  }
  const resolved = parts.join("/");
  if (!resolved.toLowerCase().endsWith(".md")) throw new Error(`Unsupported roadmap document link: ${href}`);
  return resolved;
}

/** A GFM AST, not split('|'): escaped pipes, inline code and link titles are
 * ordinary table content. Keep the source's summary numbers, never recalculate
 * them from a guessed status vocabulary. */
export function parseRoadmap(markdown: string, source: RoadmapSource): Roadmap {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const summary: string[] = [];
  const sections: Roadmap["sections"] = [];
  let section: Roadmap["sections"][number] | undefined;
  for (const node of tree.children) {
    if (node.type === "heading" && node.depth === 2) {
      const raw = markdown.slice(node.position!.start.offset, node.position!.end.offset);
      const title = raw.replace(/^##\s+/, "").replace(/\s*<sub>\d+<\/sub>\s*$/, "").trim();
      section = { title, rows: [] };
      sections.push(section);
    } else if (node.type === "table" && section) {
      if (node.children[0]?.children.length !== 4) throw new Error(`Roadmap section ${section.title} needs four table columns`);
      for (const row of node.children.slice(1)) {
        const [kind, what, since, detail] = row.children;
        const links = what?.children.filter(child => child.type === "link") ?? [];
        if (!kind || !what || !since || !detail || links.length !== 1) throw new Error(`Malformed roadmap row in ${section.title}`);
        const link = links[0]!;
        const detailLinks = detail.children.filter(child => child.type === "link");
        let issue: RoadmapRow["issue"] = null;
        for (const candidate of detailLinks) {
          const label = plain(candidate);
          if (!/^#\d+$/.test(label)) continue;
          const expected = `https://github.com/${source.owner}/${source.repo}/issues/${label.slice(1)}`;
          if (candidate.url !== expected) throw new Error(`Issue link does not belong to the named repository: ${candidate.url}`);
          if (issue) throw new Error("A roadmap row names more than one issue");
          issue = { label, url: expected };
        }
        let detailText = plain(detail).trim();
        if (issue) detailText = detailText.replace(new RegExp(`(?:\\s*·\\s*)?${issue.label}\\s*$`), "").trim();
        const split = detailText.lastIndexOf("· see ");
        const see = split < 0 ? "" : detailText.slice(split + 6).trim();
        const note = split < 0 ? detailText : detailText.slice(0, split).trim();
        section.rows.push({ title: plain(link), category: plain(kind), path: documentPath(link.url, source), since: plain(since), note, see, issue });
      }
    } else if (!section && node.type !== "html" && !(node.type === "heading" && node.depth === 1)) {
      summary.push(plain(node));
    }
  }
  if (!sections.length || !sections.some(s => s.rows.length)) throw new Error("This file has no roadmap sections and rows");
  return { summary: summary.join("\n\n"), sections };
}

/** Public GitHub reads work in a browser as well as Node. Resolve the COMMIT
 * first; the contents endpoint's sha is a BLOB, never a valid /blob/<ref> ref.
 * All later reads use that immutable commit, even if the branch moves mid-read. */
export async function readRoadmap(input: string, fetcher: typeof fetch = fetch): Promise<RoadmapReading> {
  const source = roadmapSource(input);
  if (!source) throw new Error("Use a public GitHub owner/repository or https://github.com/owner/repository/blob/ref/path.md");
  const sourceAddress = source.url;
  const signal = AbortSignal.timeout(20_000);
  async function get(url: string): Promise<Response> {
    let response: Response;
    try { response = await fetcher(url, { credentials: "omit", redirect: "error", signal }); }
    catch (error) { throw new Error(`Could not read ${sourceAddress} (unreachable or moved): ${(error as Error).message}`); }
    if (!response.ok) {
      const body = await response.text();
      let words = response.statusText;
      try { const parsed = JSON.parse(body); if (typeof parsed.message === "string") words = parsed.message; } catch { /* Do not print an HTML error page as prose. */ }
      throw new Error(`GitHub answered ${response.status}: ${words || "source unavailable"}`);
    }
    return response;
  }
  const api = `https://api.github.com/repos/${source.owner}/${source.repo}`;
  const revision = await (await get(`${api}/commits/${encodeURIComponent(source.ref)}`)).json() as { sha?: string };
  if (!revision.sha || !SHA.test(revision.sha)) throw new Error("GitHub did not name a commit for this reading");
  const commit = revision.sha;
  const meta = await (await get(`${api}/contents/${githubPath(source.path)}?ref=${commit}`)).json() as { sha?: string; type?: string; size?: number; path?: string };
  if (meta.type !== "file" || meta.path !== source.path || !meta.sha || !SHA.test(meta.sha) || !Number.isFinite(meta.size) || meta.size! > MAX_BYTES) throw new Error("GitHub did not return a regular roadmap file under 1 MB");
  const raw = await get(`https://raw.githubusercontent.com/${source.owner}/${source.repo}/${commit}/${githubPath(source.path)}`);
  if (/text\/html/i.test(raw.headers.get("content-type") ?? "")) throw new Error("GitHub returned a web page instead of the roadmap");
  const bytes = new Uint8Array(await raw.arrayBuffer());
  if (bytes.length > MAX_BYTES || bytes.length !== meta.size) throw new Error("The roadmap bytes disagree with GitHub's file size");
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const gitBlob = new Uint8Array(prefix.length + bytes.length);
  gitBlob.set(prefix); gitBlob.set(bytes, prefix.length);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", gitBlob)), b => b.toString(16).padStart(2, "0")).join("");
  if (digest !== meta.sha) throw new Error("The roadmap bytes disagree with GitHub's blob SHA");
  const roadmap = parseRoadmap(new TextDecoder("utf-8", { fatal: true }).decode(bytes), source);
  return { source, commit, blobSha: meta.sha, readAt: new Date().toISOString(), roadmap };
}

/** Ordinary markdown items, with section heading cards and a fixed three-column
 * reading order. No new kind or op. Both clients upload exactly these bytes. */
export function roadmapCards(reading: RoadmapReading): RoadmapCard[] {
  const { source, commit, blobSha, readAt, roadmap } = reading;
  const sourceUrl = roadmapDocumentUrl(source, commit);
  const stamp = `Derived from ${source.owner}/${source.repo} · ${source.path}\n\nCommit: ${commit}\n\nRead: ${readAt}`;
  const properties = { derived: "roadmap", "roadmap.url": source.url, "roadmap.commit": commit, "roadmap.blob": blobSha, synced: readAt };
  const cards: RoadmapCard[] = [];
  const card = (key: string, title: string, body: string, url: string, x: number, y: number, width: number, height: number) => {
    cards.push({ key, title, markdown: `# ${quote(title)}\n\n${body}\n\n---\n\n${quote(stamp)}\n\n[Open source at this commit](${url})\n\nRead-only — change the document's front matter in the repository.\n`, x, y, width, height,
      properties: { ...properties, source: url, "roadmap.key": key } });
  };
  card("summary", `${source.owner}/${source.repo} — Roadmap`, quote(roadmap.summary), sourceUrl, 0, 0, 1240, 600);
  let y = 680;
  for (const [sectionIndex, section] of roadmap.sections.entries()) {
    card(`section:${sectionIndex}`, section.title, `${section.rows.length} rows in this section.`, sourceUrl, 0, y, 1240, 260);
    y += 340;
    for (const [index, row] of section.rows.entries()) {
      const body = [quote(row.category), `Since: ${quote(row.since)}`, quote(row.note), row.see ? `See: ${quote(row.see)}` : "", row.issue ? `[${row.issue.label}](${row.issue.url})` : ""].filter(Boolean).join("\n\n");
      card(`row:${sectionIndex}:${index}`, row.title, body, roadmapDocumentUrl(source, commit, row.path), (index % 3) * 440, y + Math.floor(index / 3) * 760, 360, 680);
    }
    y += Math.ceil(section.rows.length / 3) * 760 + 80;
  }
  return cards;
}

/** One upload/operation adapter on either surface; all uploads finish before
 * any card is placed. A failed write reports the exact partial landing. */
export async function landRoadmap(reading: RoadmapReading, at: { x: number; y: number }, io: {
  upload(markdown: string, filename: string): Promise<{ blobHash: string; size: number }>;
  send(op: Operation, group: string): Promise<unknown>;
}): Promise<string[]> {
  const cards = roadmapCards(reading);
  const prepared = [];
  for (const card of cards) {
    const filename = `roadmap-${card.key.replace(/:/g, "-")}.md`;
    const upload = await io.upload(card.markdown, filename);
    prepared.push({ card, filename, upload });
  }
  const group = newGroupId();
  const landed: string[] = [];
  for (const { card, filename, upload } of prepared) {
    const itemId = newItemId();
    try {
      await io.send({ type: "item.add", itemId, title: card.title,
        version: { id: newVersionId(), ...upload, filename, mimeType: "text/markdown" },
        width: card.width, height: card.height, placement: { x: at.x + card.x, y: at.y + card.y, chosen: true },
        properties: { ...card.properties, "roadmap.reading": group },
      }, group);
      landed.push(itemId);
    } catch (error) { throw new Error(`Roadmap: ${landed.length} of ${cards.length} cards added. ${(error as Error).message}${landed.length ? " Undo removes this partial reading." : ""}`); }
  }
  return landed;
}
