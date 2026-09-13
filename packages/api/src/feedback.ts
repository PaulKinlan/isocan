import { dispatchReason, namesFor, type Actor, type WatchedLogEntry } from "@isocan/core";
import type { DaemonRoutes } from "./routes.ts";

/** A caller-owned read cursor; polling never acknowledges an inbox or starts presence. */
export interface FeedbackOptions { since?: number; timeoutMs?: number; signal?: AbortSignal }
/** Quiet timeout and cancellation retain the position through every inspected entry. */
export interface FeedbackResult { status: "feedback" | "timeout" | "cancelled"; cursor: number; entries: WatchedLogEntry[] }

/** The CLI's addressed-comment rule over a bounded, cancellable read poll. */
export async function waitForFeedback(client: DaemonRoutes, canvasId: string, actor: Actor, options: FeedbackOptions = {}): Promise<FeedbackResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("feedback timeout must be between 1 and 60000 milliseconds");
  if (options.since !== undefined && (!Number.isSafeInteger(options.since) || options.since < 0)) throw new Error("feedback cursor must be a nonnegative integer");
  let cursor = options.since ?? 0;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(cancel, timeoutMs);
  try {
    if (options.since === undefined && !controller.signal.aborted) cursor = (await client.snapshot(canvasId, controller.signal)).lastSeq;
    while (!controller.signal.aborted) {
      const batch = await client.watchLog({ only: [canvasId], cursors: { [canvasId]: cursor }, waitMs: Math.min(timeoutMs, 30_000) }, controller.signal);
      const snapshot = batch.entries.length ? await client.snapshot(canvasId, controller.signal) : null;
      if (controller.signal.aborted) break;
      const entries = batch.entries.filter((entry) => dispatchReason(entry.envelope.op, entry.envelope.actor.id, {
        actorId: actor.id, names: namesFor(actor), ...(snapshot?.joined ? { joined: snapshot.joined } : {}),
      }, snapshot?.canvas) !== null);
      cursor = batch.cursors[canvasId] ?? cursor;
      if (entries.length) return { status: "feedback", cursor, entries };
    }
  } catch (err) { if (!controller.signal.aborted) throw err; }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); }
  return { status: options.signal?.aborted ? "cancelled" : "timeout", cursor, entries: [] };
}
