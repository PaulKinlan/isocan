import { useEffect, useState } from "react";
import { benchAgents, benchRows, type BenchCanvas, type BenchRow } from "@isocan/core";
import { fetchRcAnswering, getSnapshot, listCanvases } from "./api.ts";
import { personalApi } from "./personal.ts";

/**
 * **Reading a person's bench, once, for every panel that draws it.**
 *
 * It began inside `YourBench.tsx` and moved here the day a second panel
 * needed it (the bench, phase 1 — journey 2 puts **Join** on each bench row in
 * the AGENTS panel). The move is the isomorphism rule one level down: a
 * second copy of "find the personal canvas, snapshot every canvas this reader
 * can see, ask the daemon who is answering on each" would agree with the
 * first for about a week, and then one of them would learn something.
 *
 * **Nothing here decides anything.** Every word a panel prints comes from
 * `benchRows()` in `@isocan/core`, which is a fourth caller of `roster()` —
 * the same fold `isocan who`, the agent tray and the workbench read. This
 * fetches and hands over; `packages/web/test/yourbench.test.ts` fails if a
 * panel, or this reader, starts spelling one of the three states for itself.
 *
 * What a browser cannot measure it does not claim. The machine-local running
 * half — `~/.isocan/rc-agents.json` — is not readable from a tab, so the set
 * is passed empty and `elsewhere` is carried by the enrolments, which are
 * canvas state and travel. Likewise the sessions: the per-canvas presence
 * lists belong to the socket for the canvas you are looking at, so `ready`
 * here rests on the daemon's connection-bound rc holds, which is the
 * strongest fact available either way.
 */
export interface Bench {
  /** The rows, or null while the read is still out. */
  rows: BenchRow[] | null;
  /**
   * The personal canvas the rows were read off — what an `agent.invite`
   * carries as the bench that vouched. Null when this person has no bench
   * yet, which is also when `rows` is empty.
   */
  canvasId: string | null;
  error: string | null;
}

export function useBench(actorId: string): Bench {
  const [bench, setBench] = useState<Bench>({ rows: null, canvasId: null, error: null });

  useEffect(() => {
    const control = new AbortController();
    void (async () => {
      try {
        const status = await personalApi.personalStatus(actorId, control.signal);
        const source = status.source?.state === "live" ? status.source.canvasId : null;
        if (!source) {
          if (!control.signal.aborted) setBench({ rows: [], canvasId: null, error: null });
          return;
        }
        const mine = await getSnapshot(source, control.signal);
        const canvases = await listCanvases();
        const seen = await Promise.all(
          canvases.map(async (canvas): Promise<BenchCanvas | null> => {
            const snapshot = await getSnapshot(canvas.id, control.signal).catch(() => null);
            if (!snapshot) return null;
            const answering = await fetchRcAnswering(canvas.id).catch(() => null);
            return {
              canvasId: canvas.id,
              canvasTitle: canvas.title,
              canvas: snapshot.canvas,
              sessions: [],
              ...(answering ? { answerable: new Set(answering.actorIds) } : {}),
            };
          }),
        );
        if (control.signal.aborted) return;
        setBench({
          rows: benchRows(
            benchAgents(mine.canvas),
            seen.filter((one): one is BenchCanvas => one !== null),
            new Set<string>(),
            Date.now(),
          ),
          canvasId: source,
          error: null,
        });
      } catch (err) {
        if (!control.signal.aborted) {
          setBench({
            rows: null,
            canvasId: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => control.abort();
  }, [actorId]);

  return bench;
}
