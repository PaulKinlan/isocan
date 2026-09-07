import { describe, expect, it } from "vitest";
import { ANSWER_WITHIN_MS, summoned, summonsLine, summonsState } from "../src/index.ts";
import type { Comment, CommentThread, PresenceSession } from "../src/index.ts";

/**
 * **Silence becomes a fact instead of a mystery** (#197 phase 1).
 *
 * The question this answers is the one that started the standing-agents work:
 * *"it seems hard to know if an agent is actually around and able to wake and
 * answer."* Naming an agent used to produce a reply or nothing, and nothing
 * looked identical whether the agent was thinking, wedged, out of budget, or
 * had never been listening.
 *
 * The cases below are written from the failure modes rather than the happy
 * path, because the happy path is the one that never needed a receipt.
 */
const T0 = Date.parse("2026-09-07T10:00:00.000Z");
const AGENT = "usr_percy";
const THREAD = "thr_1";

const session = (over: Partial<PresenceSession> = {}): PresenceSession =>
  ({
    sessionId: "ses_1",
    actor: { id: AGENT, name: "Percy" },
    capability: "edit",
    ...over,
  }) as unknown as PresenceSession;

const thread = (comments: Partial<Comment>[]): CommentThread =>
  ({
    id: THREAD,
    comments: comments.map((c, i) => ({
      id: `c${i}`,
      body: "…",
      author: { id: AGENT, name: "Percy" },
      createdAt: new Date(T0).toISOString(),
      ...c,
    })),
  }) as unknown as CommentThread;

describe("a summons carries a receipt", () => {
  const ask = { actorId: AGENT, threadId: THREAD, askedAt: T0 };

  it("says asked, while it is still reasonable to be waiting", () => {
    const state = summonsState(ask, { sessions: [], rcParked: true }, T0 + 3_000);
    expect(state).toEqual({ state: "asked", waitedMs: 3_000 });
    expect(summonsLine("Percy", state)).toBe("asked Percy");
  });

  it("says picked up the moment presence names this thread", () => {
    /* `PresenceActivity` already carried `{ kind: "working", threadId }` — the
       protocol comment calls it "the question the person who asked it is
       waiting on". This phase is that fact, rendered. */
    const working = session({ activity: { kind: "working", threadId: THREAD } } as never);
    const state = summonsState(ask, { sessions: [working], rcParked: true }, T0 + 4_000);
    expect(state).toEqual({ state: "picked-up", afterMs: 4_000 });
    expect(summonsLine("Percy", state)).toBe("Percy picked it up (4s)");
  });

  it("ignores the same agent working somewhere else", () => {
    // Presence on ANOTHER thread means it is busy, not that it took this. The
    // whole value of the receipt is that it does not flatter.
    const elsewhere = session({ activity: { kind: "working", threadId: "thr_other" } } as never);
    const state = summonsState(ask, { sessions: [elsewhere], rcParked: true }, T0 + 4_000);
    expect(state.state).toBe("asked");
  });

  it("ignores a session for somebody else entirely", () => {
    const other = session({ actor: { id: "usr_someone", name: "Someone" }, activity: { kind: "working", threadId: THREAD } } as never);
    expect(summonsState(ask, { sessions: [other], rcParked: true }, T0 + 4_000).state).toBe("asked");
  });

  it("lets a reply outrank everything, even if presence was never seen", () => {
    /* An agent quick enough to answer before its presence reaches this tab
       must never read as "nothing answered" — the receipt would be calling a
       working agent broken, which is worse than no receipt. */
    const replied = thread([{ createdAt: new Date(T0 + 6_000).toISOString() }]);
    const state = summonsState(ask, { sessions: [], rcParked: true, thread: replied }, T0 + ANSWER_WITHIN_MS + 10_000);
    expect(state).toEqual({ state: "answered", afterMs: 6_000 });
    expect(summonsLine("Percy", state)).toBe("Percy answered (6s)");
  });

  it("does not count a comment the agent left BEFORE it was asked", () => {
    // Otherwise every summons in a thread the agent has ever spoken in reads
    // as instantly answered, which is the receipt lying in the flattering
    // direction — the direction nobody checks.
    const older = thread([{ createdAt: new Date(T0 - 60_000).toISOString() }]);
    const state = summonsState(ask, { sessions: [], rcParked: true, thread: older }, T0 + 3_000);
    expect(state.state).toBe("asked");
  });

  it("says nothing answered past the bound, and names the rc when one is parked", () => {
    /* The sentence the whole phase exists for. A parked rc that did not
       respond is a broken agent; that is a different problem from nobody
       being home, and it wants a different next move. */
    const state = summonsState(ask, { sessions: [], rcParked: true }, T0 + ANSWER_WITHIN_MS);
    expect(state).toEqual({ state: "unanswered", waitedMs: ANSWER_WITHIN_MS, rcParked: true });
    expect(summonsLine("Percy", state)).toBe("nothing answered — the rc is parked but did not respond");
  });

  it("says something different when nothing was listening at all", () => {
    const state = summonsState(ask, { sessions: [], rcParked: false }, T0 + ANSWER_WITHIN_MS);
    expect(summonsLine("Percy", state)).toBe("nothing answered — nothing is listening for Percy here");
  });

  it("holds the boundary, on both sides", () => {
    // A tuning constant that must not be frozen gets bracketed, per
    // lessons.md #11: one case that fails if it moves down, one if it moves up.
    expect(summonsState(ask, { sessions: [], rcParked: true }, T0 + ANSWER_WITHIN_MS - 1).state).toBe("asked");
    expect(summonsState(ask, { sessions: [], rcParked: true }, T0 + ANSWER_WITHIN_MS).state).toBe("unanswered");
  });

  it("keeps a pick-up once seen, so a finished turn is not mistaken for silence", () => {
    /* Presence goes when the turn ends. Without the caller remembering the
       moment, an agent that picked something up, worked and stopped would
       fall back through to "nothing answered" — the receipt calling a
       completed turn a failure. */
    const state = summonsState(ask, { sessions: [], rcParked: true, pickedUpAt: T0 + 2_000 }, T0 + ANSWER_WITHIN_MS + 5_000);
    expect(state).toEqual({ state: "picked-up", afterMs: 2_000 });
  });
});

describe("who a comment actually summons", () => {
  const percy = { actorId: AGENT, names: [{ id: AGENT, name: "Percy" }] };
  const sian = { actorId: "usr_sian", names: [{ id: "usr_sian", name: "Sian" }] };

  const side = { id: "thr_side", comments: [] } as unknown as CommentThread;
  const main = { id: "thr_main", main: true, comments: [] } as unknown as CommentThread;

  it("is the agents named, and only those", () => {
    expect(summoned({ body: "@Percy have a look" } as never, [percy, sian], side)).toEqual([AGENT]);
  });

  it("summons nobody for an unaddressed comment on an ordinary thread", () => {
    expect(summoned({ body: "just thinking out loud" } as never, [percy, sian], side)).toEqual([]);
  });

  it("summons two when two are named", () => {
    expect(summoned({ body: "@Percy @Sian both of you" } as never, [percy, sian], side).sort()).toEqual(
      [AGENT, "usr_sian"].sort(),
    );
  });

  it("counts the MAIN thread as an ask, with no mention needed", () => {
    /* `mainthread.ts`: "anything landing here wakes a parked agent's `isocan
       wait` with no @-mention needed". A receipt that required an `@` would be
       silent in the place people most often ask for something — which is the
       place a receipt is worth the most. Deriving from `reasonFor` is what
       keeps this true: the receipt and the dispatcher read one rule. */
    expect(summoned({ body: "can you take a look at the deck" } as never, [percy], main)).toEqual([
      AGENT,
    ]);
  });

  it("does not count a thread the agent merely spoke in before", () => {
    /* `in-your-thread` wakes an agent but nobody directed it — a conversation
       continuing, not a request. "asked Percy" under a comment that asked
       nothing makes the word meaningless where it has to be exact. */
    const spokenIn = {
      id: "thr_side",
      comments: [
        { id: "c0", body: "earlier", author: { id: AGENT, name: "Percy" }, createdAt: new Date(T0).toISOString() },
      ],
    } as unknown as CommentThread;
    expect(summoned({ body: "hm, interesting" } as never, [percy], spokenIn)).toEqual([]);
  });
});
