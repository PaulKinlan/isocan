import { reasonFor } from "./inbox.ts";
import type { ActorJoins } from "./identity.ts";
import type { MentionCandidate } from "./mentions.ts";
import type { Comment, CommentThread } from "./model.ts";
import type { NewComment } from "./ops.ts";
import type { PresenceSession } from "./protocol.ts";

/**
 * **Did the thing you asked for actually reach anybody.**
 *
 * Phase 1 of `docs/research/2026-09-06-agents-you-can-trust.md` (#197), and
 * the answer to the question that started it: *"it seems hard to know if an
 * agent is actually around and able to wake and answer."*
 *
 * Before this, naming an agent in a comment produced either a reply or
 * silence, and **silence was indistinguishable from thinking**. You could not
 * tell a model composing a careful answer from an rc that was wedged, out of
 * budget, or pointed at a model that was down. The roster's dot said
 * "standing by", which is a claim about a held socket rather than about
 * anybody answering — and on 6 September this project found an rc that
 * printed "answering on X", looked healthy, and silently never answered for
 * an agent at all (`main.ts`, the roster reconcile).
 *
 * So: every summons gets a receipt, and the receipt can say no.
 *
 * ## It is an observation, not a fact the canvas holds
 *
 * Deliberately no operation and no stored field. A receipt is what the person
 * who asked can see about what they asked — it is true of a viewer, not of
 * the canvas, and two people watching the same thread are waiting on
 * different things. Writing one per summons would also add an op to a
 * vocabulary held at 33, to record something nobody needs tomorrow.
 *
 * Everything here is therefore derived from what the tab already holds: the
 * comment, the roster, live presence, and the clock.
 */

/** How long a summons may go unacknowledged before the receipt says so.
 *
 * An rc does not poll for work — it holds a long-poll open — so an agent that
 * is going to pick something up starts within seconds of the op landing. The
 * doc's own example is *picked up (4s)*.
 *
 * Forty-five seconds is therefore generous rather than tight, and the
 * generosity is the point: this number decides when the app is willing to say
 * **nothing answered**, and saying that wrongly about an agent which was about
 * to reply is worse than a few more seconds of "asked". */
export const ANSWER_WITHIN_MS = 45_000;

/** What a viewer can say about one summons, right now. */
export type SummonsState =
  /** Sent, and nothing has come back yet. Still inside the bound. */
  | { state: "asked"; waitedMs: number }
  /** The agent started a turn on this thread — presence said so. */
  | { state: "picked-up"; afterMs: number }
  /** It replied. Terminal, and it does not matter whether we ever saw
   *  presence: a machine that answers has answered. */
  | { state: "answered"; afterMs: number }
  /**
   * Past the bound with nothing. `rcParked` is what makes this useful rather
   * than merely disappointing: an rc holding a connection and not responding
   * is a broken agent, where no rc at all is nobody home. The two want
   * different sentences and different next moves.
   */
  | { state: "unanswered"; waitedMs: number; rcParked: boolean };

/**
 * The agents a comment summons — decided by `reasonFor`, the same function the
 * dispatcher and a parked `wait` use, so a receipt cannot promise a wake-up
 * the rc does not perform.
 *
 * **Two of the three reasons count, and the third does not.** `mentioned` is
 * somebody naming an agent. `main-thread` is somebody using the canvas's
 * direct channel to their emissary — `mainthread.ts` says anything landing
 * there wakes a parked agent with no mention needed, so a receipt that
 * required an `@` would be silent in the place people most often ask for
 * something, which is the place a receipt is worth most.
 *
 * `in-your-thread` is left out on purpose. It wakes an agent, but nobody
 * directed it — it is a conversation continuing, not a request — and putting
 * *asked Percy* under a comment that asked nothing makes the word meaningless
 * exactly where it has to be exact.
 */
export function summoned(
  comment: NewComment | Comment,
  agents: readonly { actorId: string; names: readonly MentionCandidate[] }[],
  thread?: CommentThread | undefined,
  joined?: ActorJoins,
): string[] {
  return agents
    .filter((agent) => {
      const reason = reasonFor(comment, thread, agent.actorId, agent.names, joined);
      return reason === "mentioned" || reason === "main-thread";
    })
    .map((agent) => agent.actorId);
}

/**
 * Where one summons stands.
 *
 * `askedAt` and `now` are passed rather than read, so this is pure and so a
 * test can stand anywhere on the timeline without waiting.
 */
export function summonsState(
  summons: { actorId: string; threadId: string; askedAt: number },
  seen: {
    /** Live sessions, as the facepile has them. */
    sessions: readonly PresenceSession[];
    /** The thread as it stands, for a reply that beat presence. */
    thread?: CommentThread | undefined;
    /** Whether an rc holds a connection claiming this actor. */
    rcParked: boolean;
    /** When presence first showed this agent working on this thread, if the
     *  caller has been watching. Without it, a turn that has already ended is
     *  indistinguishable from one that never began — which is why the caller
     *  keeps this and not us. */
    pickedUpAt?: number | undefined;
    joined?: ActorJoins | undefined;
  },
  now: number,
): SummonsState {
  const waitedMs = Math.max(0, now - summons.askedAt);

  // A reply outranks everything: it is the outcome the other states are
  // predicting, and an agent fast enough to answer before its presence
  // reaches this tab must not read as "nothing answered".
  const reply = seen.thread?.comments.find(
    (c: Comment) => c.author.id === summons.actorId && Date.parse(c.createdAt) >= summons.askedAt,
  );
  if (reply) return { state: "answered", afterMs: Math.max(0, Date.parse(reply.createdAt) - summons.askedAt) };

  if (seen.pickedUpAt !== undefined) {
    return { state: "picked-up", afterMs: Math.max(0, seen.pickedUpAt - summons.askedAt) };
  }

  const working = seen.sessions.some(
    (s) =>
      s.actor.id === summons.actorId &&
      s.activity != null &&
      "threadId" in s.activity &&
      s.activity.threadId === summons.threadId,
  );
  if (working) return { state: "picked-up", afterMs: waitedMs };

  if (waitedMs >= ANSWER_WITHIN_MS) {
    return { state: "unanswered", waitedMs, rcParked: seen.rcParked };
  }
  return { state: "asked", waitedMs };
}

/**
 * The sentence a receipt shows.
 *
 * Here rather than in the web app because the words ARE the feature — *"that
 * last sentence is the whole feature: it converts a mystery into a fact"* —
 * and a CLI that grows `isocan comment --wait` must say the same thing. The
 * copy persona's rule applies: name what happened, and when it is bad, say
 * which bad thing.
 */
export function summonsLine(name: string, state: SummonsState): string {
  const secs = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`;
  switch (state.state) {
    case "asked":
      return `asked ${name}`;
    case "picked-up":
      return `${name} picked it up (${secs(state.afterMs)})`;
    case "answered":
      return `${name} answered (${secs(state.afterMs)})`;
    case "unanswered":
      // The distinction the whole phase exists for. A parked rc that did not
      // respond is a broken agent and names the rc, because that is where a
      // person would look. No rc is nobody home, and the fix is different.
      return state.rcParked
        ? `nothing answered — the rc is parked but did not respond`
        : `nothing answered — nothing is listening for ${name} here`;
  }
}
