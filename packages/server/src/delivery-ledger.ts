import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * One attempt that was made and lost — the record the oplog cannot hold.
 *
 * This is deliberately NOT a canvas fact and NOT in the oplog. The oplog is the
 * shared, replicated, undoable history of a document: its entries are
 * attributed to a person, they travel to peers, and they can be undone. A
 * delivery failure is none of those things — it is true on this machine only,
 * it is not a fact about the canvas, no peer should ever replay it, and an
 * undone delivery record would leave the lie behind. So it lives beside the
 * daemon's other machine-local state (`~/.isocan/`) and is never synced.
 */
export type DeliveryLoss = {
  /** When the attempt failed, ISO-8601. */
  at: string;
  /** The canvas being written to, when the request identified one. */
  canvasId: string | null;
  /** Which home was unreachable — a machine can have several (phase 10.3). */
  homeUrl: string;
  /** Why it could not be reached. */
  cause: string;
  /** Always `not-made`: the daemon refuses rather than guessing. */
  outcome: "not-made";
};

/** Where the ledger lives. `ISOCAN_DELIVERY_LEDGER` overrides it; tests use that.
 *  Not exported: nothing outside this file needs the path, and an export nobody
 *  imports is the kind of promise the repo's unused-exports ceiling exists to
 *  catch — it caught this one. */
function deliveryLedgerPath(): string {
  return (
    process.env.ISOCAN_DELIVERY_LEDGER ??
    join(process.env.ISOCAN_STATE_DIR ?? join(homedir(), ".isocan"), "delivery.jsonl")
  );
}

/**
 * Append one loss to the ledger. Never throws, and that is the point: a record
 * that cannot be written must not change the answer the caller receives, which
 * is the 503 that already tells the truth. A reader that cannot find the file
 * has an empty ledger, not a broken daemon.
 */
export function recordDeliveryLoss(row: DeliveryLoss, path: string = deliveryLedgerPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`);
  } catch {
    /* the 503 is the answer; the record is a courtesy that must never cost it */
  }
}

/** The canvas a request was about, from its path — `null` rather than a guess. */
export function canvasIdFromUrl(url: string | undefined): string | null {
  const match = /\/api\/canvases\/([^/?#]+)/.exec(url ?? "");
  const id = match?.[1];
  return id ? decodeURIComponent(id) : null;
}
