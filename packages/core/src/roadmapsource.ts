/** Closed public GitHub file recognition. No user-controlled fetch origin. */
export interface RoadmapSource {
  owner: string;
  repo: string;
  ref: string;
  path: string;
  url: string;
}
const name = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const part = (value: string) => value !== "." && value !== ".." && value.length > 0 && !/[\\\x00-\x20\x7f/?#]/.test(value);
/** Encode path components without turning their separators into filename bytes. */
export const githubPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Recognise only public GitHub repository/file addresses, before any I/O. */
export function roadmapSource(input: string): RoadmapSource | null {
  const s = input.trim();
  // Check before URL normalisation: dot segments must be refused, not erased.
  if (/(^|\/)(?:\.|%2e){1,2}(\/|$)/i.test(s) || /\\|%2f|%5c/i.test(s)) return null;
  let u: URL;
  try { u = new URL(/^[\w.-]+\/[\w.-]+\/?$/.test(s) ? `https://github.com/${s}` : s); }
  catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.port || u.username || u.password || u.search || u.hash) return null;
  let bits: string[];
  try { bits = u.pathname.replace(/\/$/, "").slice(1).split("/").map(decodeURIComponent); }
  catch { return null; }
  const [owner, repo] = bits;
  if (!owner || !repo || !name.test(owner) || !name.test(repo) || !bits.every(part)) return null;
  if (bits.length !== 2 && (bits[2] !== "blob" || bits.length < 5)) return null;
  const ref = bits.length === 2 ? "HEAD" : bits[3]!;
  const path = bits.length === 2 ? "docs/ROADMAP.md" : bits.slice(4).join("/");
  if (!path.toLowerCase().endsWith(".md")) return null;
  return { owner, repo, ref, path, url: bits.length === 2 ? `https://github.com/${owner}/${repo}` : `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(ref)}/${githubPath(path)}` };
}

/** Link to a document at the commit read, never at a mutable branch or blob ID. */
export function roadmapDocumentUrl(source: RoadmapSource, commit: string, path = source.path): string {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("A roadmap reading needs a commit, not a branch name");
  return `https://github.com/${source.owner}/${source.repo}/blob/${commit}/${githubPath(path)}`;
}
