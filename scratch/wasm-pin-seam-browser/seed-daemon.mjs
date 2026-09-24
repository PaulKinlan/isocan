// Seeds a real daemon for the browser leg: project + pinned wasm + tampered twin.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { startDaemon } from new URL("../../packages/server/src/daemon.ts", import.meta.url).href;
import { formatBadgeToken } from new URL("../../packages/core/src/badge.ts", import.meta.url).href;

const WASM_ADD = Uint8Array.of(
  0x00,0x61,0x73,0x6d, 0x01,0x00,0x00,0x00,
  0x01,0x07,0x01, 0x60,0x02,0x7f,0x7f, 0x01,0x7f,
  0x03,0x02,0x01,0x00,
  0x07,0x07,0x01, 0x03,0x61,0x64,0x64, 0x00,0x00,
  0x0a,0x09,0x01, 0x07, 0x00, 0x20,0x00, 0x20,0x01, 0x6a, 0x0b,
);
const TAMPERED = Uint8Array.from(WASM_ADD); TAMPERED[39] ^= 0x01; // i32.add -> i32.sub
const home = await fs.mkdtemp("/tmp/isocan-browser-seam-");
const daemon = await startDaemon({ port: 0, home });
const base = `http://127.0.0.1:${daemon.app.server.address().port}`;
const doorRes = await fetch(`${base}/api/door`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ carrier: "bearer" }) });
const door = await doorRes.json();
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${formatBadgeToken(door.badgeId, door.secret)}` };
const claim = await fetch(`${base}/api/ops`, { method: "POST", headers, body: JSON.stringify({ canvasId: null, op: { type: "actor.claim", sessionKey: "browser-seed:usr_alice", as: "usr_alice", name: "Alice" } }) });
if (!claim.ok) { console.error("claim refused", claim.status, await claim.text()); process.exit(1); }
const canvasId = "prj_browser_seam";
const op = async (o, cid = canvasId) => {
  const r = await fetch(`${base}/api/ops`, { method: "POST", headers, body: JSON.stringify({ canvasId: cid === null ? null : cid, actor: { id: "usr_alice", name: "Alice" }, op: o }) });
  if (r.status !== 200) { console.error("op refused", r.status, await r.text()); process.exit(1); }
  return r.json();
};
await op({ type: "project.create", canvasId, title: "Browser seam", groupMode: "legacy" }, null);
const put = async (bytes, name) => (await daemon.engine.putBlob(canvasId, Buffer.from(bytes), { mimeType: "application/wasm", filename: name })).blobHash;
const good = await put(WASM_ADD, "add.wasm");
const tampered = await put(TAMPERED, "add-tampered.wasm");
await op({ type: "project.update", patch: { properties: { "tools.pins.add": good } } });
console.log(JSON.stringify({ base, canvasId, good, tampered, expected: createHash("sha256").update(WASM_ADD).digest("hex") }));
process.stdin.resume();
