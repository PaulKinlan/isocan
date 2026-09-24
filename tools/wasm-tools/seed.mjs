// Seed the isocan daemon for the wasm tool surface:
//   project + hash.wasm uploaded as a blob + pinned via project.update (option A).
// Usage: node seed.mjs <base> <canvasId>
// Reads the tool bytes from tools/wasm-tools/hash.wasm (the built artefact).
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { formatBadgeToken } from "../../packages/core/src/badge.ts";

const [base, canvasId] = process.argv.slice(2);
if (!base || !canvasId) { console.error("usage: node seed.mjs <base> <canvasId>"); process.exit(1); }

const wasm = await readFile(new URL("./hash.wasm", import.meta.url));
const expected = createHash("sha256").update(wasm).digest("hex");

const door = await (await fetch(`${base}/api/door`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ carrier: "bearer" }),
})).json();
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${formatBadgeToken(door.badgeId, door.secret)}` };
const actor = { id: "usr_verifier", name: "Verifier" };
const claim = await fetch(`${base}/api/ops`, { method: "POST", headers, body: JSON.stringify({ canvasId: null, op: { type: "actor.claim", sessionKey: "wasm-surface:verifier", as: actor.id, name: actor.name } }) });
if (!claim.ok) throw new Error(`claim refused: ${claim.status} ${await claim.text()}`);

const op = async (o, cid = canvasId) => {
  const r = await fetch(`${base}/api/ops`, { method: "POST", headers, body: JSON.stringify({ canvasId: cid === null ? null : cid, actor, op: o }) });
  if (!r.ok) throw new Error(`op ${o.type} refused: ${r.status} ${await r.text()}`);
  return r.json();
};

try {
  await op({ type: "project.create", canvasId, title: "Wasm tool surface", groupMode: "legacy" }, null);
} catch (err) {
  if (!String(err).includes("duplicate-id")) throw err; // idempotent seed: already seeded is fine
}

let blobHash;
{
  // Try octet-stream first; the blob route registers buffer parsers for a
  // short, closed content-type list, and text/plain carries raw bytes too.
  for (const mime of ["application/octet-stream", "text/plain"]) {
    const r = await fetch(`${base}/api/projects/${canvasId}/blobs`, {
      method: "POST", headers: { ...headers, "Content-Type": mime, "x-isocan-filename": "hash.wasm" }, body: wasm,
    });
    if (r.ok) { blobHash = (await r.json()).blobHash; break; }
    if (mime === "text/plain") throw new Error(`blob upload refused: ${r.status} ${await r.text()}`);
  }
}
if (blobHash !== expected) throw new Error(`daemon minted ${blobHash}, expected ${expected}`);

await op({ type: "project.update", patch: { properties: { "tools.pins.hash": blobHash } } });

// Read the pin back through the same door a browser will use.
const state = await (await fetch(`${base}/api/projects/${canvasId}/canvas`, { headers })).json();
const pin = state.project.properties["tools.pins.hash"];
if (pin !== expected) throw new Error("pin did not read back");

await writeFile(new URL("./seeded.json", import.meta.url), JSON.stringify({ base, canvasId, pin, bytes: wasm.length }, null, 2));
console.log(JSON.stringify({ canvasId, pin, bytes: wasm.length }));
