import { mergeSeen, type SeenMark, type SeenMarks } from "@isocan/core";
import { fetchSeen, putSeen } from "./api.ts";

/**
 * **What this person has already seen, as the home keeps it** (#147, #134) —
 * `docs/research/2026-09-12-seen-marks.md`.
 *
 * The browser has had read state since the beginning, in `localStorage`:
 * per-thread watermarks (`stores/unreadStore.ts`) and the switcher's recents
 * (`lib/recents.ts`). Both are per BROWSER, and that is the thing this
 * replaces one half of. The durable mark is coarse — one row per canvas, the
 * head you had in front of you and when — and it crosses machines, which is
 * the half localStorage structurally could not do. The per-thread watermarks
 * stay exactly where they are, doing the fine-grained job they already do.
 *
 * **Only a visit writes.** The mark means both "I was here" and "I had seen
 * everything up to here", which is what lets the inbox and the switcher read
 * one fact. Marking canvases nobody opened would fill somebody's "lately"
 * with places they never went.
 *
 * Nothing here fails loudly. A mark is a nicety; a home that cannot answer
 * costs an ordering, never a canvas.
 */

/** The marks this tab has read, once per identity. A module-level cache
 *  rather than a store: it is asked for by two surfaces, changes at most once
 *  per visit, and nothing re-renders when it lands. */
const cached = new Map<string, SeenMarks>();
interface SeenRead {
  controller: AbortController;
  promise: Promise<boolean>;
  users: number;
  settled: boolean;
}
const asking = new Map<string, SeenRead>();
/** Preparation is a nicety, so a stalled home cannot hold navigation forever. */
export const SEEN_READ_TIMEOUT_MS = 8000;
const visits = new Set<(actorId: string, canvasId: string, mark: SeenMark) => void>();

/** Navigation can clear its count when THIS tab's visit was accepted, without
 * another poll. Optimistic local timestamps and plain reads never announce. */
export function onSeenVisit(received: (actorId: string, canvasId: string, mark: SeenMark) => void): () => void {
  visits.add(received);
  return () => { visits.delete(received); };
}


/** Inbox reads refresh the shared ledger; only noteVisit writes it. */
export function rememberSeen(actorId: string, marks: SeenMarks): void {
  cached.set(actorId, mergeSeen(cached.get(actorId) ?? {}, marks));
}

/** What the home last told us, and an empty ledger until it has. */
export function seenMarks(actorId: string): SeenMarks {
  return cached.get(actorId) ?? {};
}

/** Share an authoritative read, preserving claim-healing order. A refresh
 * asks again after an earlier success; a failed read can always be retried.
 * Each caller owns its wait. Only the last cancellation aborts shared HTTP
 * work, so a hidden navigation cannot cancel an actual canvas visit. */
export function loadSeen(
  actorId: string,
  options: { signal?: AbortSignal; refresh?: boolean } = {},
): Promise<boolean> {
  options.signal?.throwIfAborted();
  if (!options.refresh && cached.has(actorId)) return Promise.resolve(true);
  let pending = asking.get(actorId);
  if (!pending || pending.controller.signal.aborted) {
    const controller = new AbortController();
    const read: SeenRead = { controller, users: 0, settled: false, promise: Promise.resolve(false) };
    read.promise = fetchSeen(actorId, AbortSignal.any([controller.signal, AbortSignal.timeout(SEEN_READ_TIMEOUT_MS)]))
      .then(({ marks }) => {
        controller.signal.throwIfAborted();
        rememberSeen(actorId, marks);
        return true;
      }, () => {
        controller.signal.throwIfAborted();
        return false;
      })
      .finally(() => {
        read.settled = true;
        if (asking.get(actorId) === read) asking.delete(actorId);
      });
    asking.set(actorId, read);
    pending = read;
  }
  const read = pending;
  read.users++;
  return new Promise((resolve, reject) => {
    let done = false;
    const leave = () => {
      done = true;
      options.signal?.removeEventListener("abort", cancel);
      if (--read.users === 0 && !read.settled) read.controller.abort();
    };
    const cancel = () => { if (!done) { leave(); reject(options.signal!.reason); } };
    options.signal?.addEventListener("abort", cancel, { once: true });
    read.promise.then((available) => {
      if (done) return;
      leave(); resolve(available);
    }, (error) => {
      if (done) return;
      leave(); reject(error);
    });
  });
}

/**
 * **You opened a canvas.** Moves the mark to the head this tab has in front
 * of it, and keeps the local copy in step so "lately" is right before the
 * answer lands.
 *
 * Once per arrival rather than per op: a write per op would be the per-thread
 * mistake wearing a different hat — the whole argument for a high-water mark
 * is that a glance costs at most one write. A canvas whose head has not moved
 * since the mark is still written, because a REVISIT is the fact "lately"
 * needs and the merge takes the later instant on its own.
 */
export function noteVisit(canvasId: string, seq: number, actorId: string): void {
  const at = new Date().toISOString();
  if (cached.has(actorId)) cached.get(actorId)![canvasId] = { seq, at };
  /**
   * **After the read, never beside it** — and this is a bug that only a real
   * browser found.
   *
   * A fresh page load holds a badge whose CLAIM on this persona the home may
   * have forgotten, so the first request asserting an actor comes back
   * `not-your-actor`. `lib/api.ts` heals exactly that, once, by re-claiming
   * and replaying — but the healing is guarded by a single `reclaiming` flag,
   * so of two requests fired in the same tick only one gets to heal and the
   * other fails for good. Fired together, the read healed and the WRITE was
   * the one that died: marks stopped being written on every load after the
   * first, silently, because a mark is deliberately allowed to fail quietly.
   *
   * Sequencing is the whole fix. The read goes first, heals the claim if it
   * needs healing, and the write follows a claim that is already good. It
   * costs a round trip on a nicety and buys a feature that works on the
   * second page load.
   */
  void loadSeen(actorId)
    .then(() => putSeen(canvasId, seq, actorId))
    .then(
      ({ mark }) => {
        // The home may be AHEAD — another machine of yours got further — and
        // its answer is the one that stands.
        cached.set(actorId, { ...cached.get(actorId), [canvasId]: mark });
        for (const received of visits) received(actorId, canvasId, mark);
      },
      () => {},
    );
}
