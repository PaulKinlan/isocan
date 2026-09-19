import { useEffect, useRef, useState } from "react";
import type { CanvasState, LogEntry, PresenceSession, ServerMessage } from "@isocan/core";
import { applyOperation, WS_NOT_ADMITTED, WS_NO_CANVAS } from "@isocan/core";
import { wsUrl } from "../stores/canvasStore.ts";

/**
 * **The card as a room member** (isocan-wq6.6).
 *
 * A canvas card used to pull the other canvas's snapshot every thirty
 * seconds while its tab was visible — on a hosted store that is one request
 * per card, forever, for a picture that changes a few times a day. The
 * engine already keeps per-canvas rooms that answer a new socket with a
 * snapshot and then every mutation as it lands (`server/ws.ts`,
 * snapshot-then-tail ON PURPOSE), so the card does what any other room
 * member does: it dials in, and the ops come to it.
 *
 * **A read-only member, honestly.** The socket never sends a presence
 * message, so the server never registers a face for it (the session is
 * created lazily on the first presence message) — the card watches the room
 * and does not appear in it. Its "N here" count comes from the rosters the
 * room broadcasts anyway.
 *
 * **No cursor claims.** The card holds no write queue and no offline
 * replica, so it resumes nothing: every dial says `since=0` and takes a
 * fresh snapshot. A resume cursor would save one snapshot per reconnect —
 * and cost a second state path to keep honest. The store's connection has
 * the cursor machinery; this is deliberately the cheap half of it.
 *
 * **The recovery is close-and-redial.** A gap, a bad op, or a beat that
 * says the card is behind twice in a row closes the socket; the next dial
 * takes a fresh snapshot, which is always correct. Refusals are said in the
 * card's own words; anything else retries with the store's backoff shape
 * while the tab stays visible, and the last live picture stays on screen —
 * never a blank rectangle.
 */

/** The store's reconnect backoff shape (RECONNECT_MIN/MAX there): fast
 *  enough that a blip is invisible, slow enough that a down home is not
 *  hammered by every card on the wall. */
const RECONNECT_MIN_MS = 800;
const RECONNECT_MAX_MS = 30_000;

/** Which close codes are the door saying no, and the words the card already
 *  used for the same answers over HTTP. Everything else is not a refusal —
 *  it is the home being away, and it gets a redial, not words. */
export function refusalWords(code: number): string | null {
  if (code === WS_NOT_ADMITTED || code === 4401) return "You are not admitted to this canvas — open it to ask at its door.";
  if (code === WS_NO_CANVAS || code === 4403 || code === 4426) return "This canvas could not be read right now.";
  return null;
}

/** Distinct actors on the room's roster — the "N here" in the card's head.
 *  The roster is already scoped to this canvas's room, so there is nothing
 *  to filter by canvas; distinct by actor, the way the poll's rows were. */
export function hereCount(sessions: PresenceSession[]): number {
  return new Set(sessions.filter((one) => one.kind !== "rc").map((one) => one.actor.id)).size;
}

/**
 * One tail entry folded into the held picture. Null when the op will not
 * apply — the caller closes and redials, because a picture that cannot take
 * an op is wrong in a way no further tail entry can repair. The cursor only
 * moves when the fold SUCCEEDED: a failed fold that moved the cursor would
 * claim to hold a seq it does not.
 */
export function applyTailOp(held: { state: CanvasState; lastSeq: number }, entry: LogEntry): CanvasState | null {
  try {
    const state = applyOperation(held.state, entry.envelope);
    if (state) {
      held.state = state;
      held.lastSeq = entry.seq;
    }
    return state;
  } catch {
    return null;
  }
}

/**
 * **The beat's tip, held to the two-beat rule** (#85): one beat behind is an
 * op in flight; the same cursor behind on a second beat is a subscription
 * that has stopped, and closing is the recovery. Pure so the rule is
 * testable without a socket.
 */
export function tipStall(behindAt: number | null, lastSeq: number, tip: number): boolean {
  return tip > lastSeq && behindAt === lastSeq;
}

/** Is this tab worth holding a socket open for right now. */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(typeof document === "undefined" ? true : document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

export type TailState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "live"; state: CanvasState; here: number }
  | { kind: "refused"; why: string };

/**
 * Subscribe to the canvas's room while `enabled` (the tab visible and the
 * canvas's home being this origin — a cross-home card keeps its polling
 * path, it cannot dial a room that is not here).
 */
export function useCanvasTail(canvasId: string, enabled: boolean): TailState {
  const visible = useDocumentVisible();
  const active = enabled && visible;
  const [tail, setTail] = useState<TailState>({ kind: "idle" });
  /** The live state ref mirrors `tail` so message handlers read the current
   *  fold without re-subscribing on every op. */
  const liveRef = useRef<{ state: CanvasState; lastSeq: number; here: number } | null>(null);

  useEffect(() => {
    if (!active) {
      liveRef.current = null;
      setTail({ kind: "idle" });
      return;
    }
    let live = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = RECONNECT_MIN_MS;
    let behindAt: number | null = null;

    const dial = () => {
      if (!live) return;
      setTail((one) => (one.kind === "live" ? one : { kind: "connecting" }));
      const ws = new WebSocket(wsUrl(canvasId, 0));
      socket = ws;
      const stale = () => socket !== ws || !live;

      ws.onmessage = (event) => {
        if (stale()) return;
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data as string) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === "snapshot") {
          backoffMs = RECONNECT_MIN_MS;
          behindAt = null;
          const held = { state: { project: message.project, canvas: message.canvas }, lastSeq: message.lastSeq, here: 0 };
          liveRef.current = held;
          setTail({ kind: "live", state: held.state, here: held.here });
        } else if (message.type === "op-applied") {
          const held = liveRef.current;
          if (!held) return;
          const state = applyTailOp(held, message.entry);
          if (!state) {
            // A fold that will not apply means this replica's picture is
            // wrong in a way a tail cannot repair: close, and the redial
            // takes a snapshot that is always correct.
            ws.close();
            return;
          }
          setTail({ kind: "live", state, here: held.here });
        } else if (message.type === "presence-roster") {
          const held = liveRef.current;
          if (!held) return;
          held.here = hereCount(message.sessions);
          setTail({ kind: "live", state: held.state, here: held.here });
        } else if (message.type === "heartbeat") {
          const held = liveRef.current;
          if (!held || typeof message.tip !== "number") return;
          if (tipStall(behindAt, held.lastSeq, message.tip)) {
            behindAt = null;
            ws.close();
            return;
          }
          behindAt = message.tip > held.lastSeq ? held.lastSeq : null;
        }
      };

      ws.onclose = (event) => {
        if (stale()) return;
        socket = null;
        const words = refusalWords(event.code);
        if (words) {
          setTail({ kind: "refused", why: words });
          return;
        }
        // Keep the last live picture on screen while the redial waits: a
        // canvas that has blipped is a canvas to show, not to blank.
        reconnectTimer = setTimeout(dial, backoffMs);
        backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
      };
    };

    dial();
    return () => {
      live = false;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      const doomed = socket;
      socket = null;
      // Null the ref BEFORE close: the dying socket's handlers must see
      // themselves as stale (the store learned this the hard way).
      liveRef.current = null;
      doomed?.close();
    };
  }, [canvasId, active]);

  return tail;
}
