import { describe, expect, it } from "vitest";
import { applyOperation, type CanvasState, type LogEntry, type NewVersion, type Operation, type PresenceSession } from "@isocan/core";
import { applyTailOp, hereCount, refusalWords, tipStall } from "../src/lib/canvastail.ts";

/**
 * **The tail's decisions, held to account with real values** (isocan-wq6.6).
 * The socket itself is browser ground — driven in a real browser, reported
 * as such — but the rules that decide what a message MEANS are pure
 * functions, so they get real folds and real close codes here.
 */

const actor = { id: "usr_tail", name: "Tail" };
const stamp = { createdAt: "2026-09-19T00:00:00Z", createdBy: actor, updatedAt: "2026-09-19T00:00:00Z", updatedBy: actor };

function nv(id: string): NewVersion {
  return { id, blobHash: `hash_${id}`, mimeType: "text/markdown", filename: `${id}.md`, size: 10 };
}

let seq = 0;
function entry(state: CanvasState, op: Operation, canvasId = state.project.id): LogEntry {
  seq += 1;
  return { seq, envelope: { id: `op_${seq}`, canvasId, actor, ts: stamp.createdAt, op }, inverse: null };
}

function bornCanvas(): CanvasState {
  return applyOperation(null, { id: "op_birth", canvasId: "prj_tail", actor, ts: stamp.createdAt, op: { type: "project.create", canvasId: "prj_tail", title: "Tail", groupMode: "groups" } })!;
}

describe("applyTailOp — one entry folded into the held picture", () => {
  it("folds a real item.add and moves the cursor only on success", () => {
    const state = bornCanvas();
    const held = { state, lastSeq: 1 };
    const one = entry(state, { type: "item.add", itemId: "itm_1", version: nv("ver_1"), title: "one", width: 10, height: 10, placement: { x: 0, y: 0 } });
    const next = applyTailOp(held, one);
    expect(next).not.toBeNull();
    expect(Object.keys(next!.canvas.items)).toContain("itm_1");
    expect(held.lastSeq).toBe(one.seq);
  });

  it("folds two real adds in a row, accumulating", () => {
    const state = bornCanvas();
    const held = { state, lastSeq: 1 };
    const one = entry(state, { type: "item.add", itemId: "itm_1", version: nv("ver_1"), title: "one", width: 10, height: 10, placement: { x: 0, y: 0 } });
    expect(applyTailOp(held, one)).not.toBeNull();
    const two = entry(state, { type: "item.add", itemId: "itm_2", version: nv("ver_2"), title: "two", width: 10, height: 10, placement: { x: 5, y: 5 } });
    const next = applyTailOp(held, two);
    expect(Object.keys(next!.canvas.items).sort()).toEqual(["itm_1", "itm_2"]);
    expect(held.lastSeq).toBe(two.seq);
  });

  it("refuses to move the cursor past an op that will not apply", () => {
    const state = bornCanvas();
    const held = { state, lastSeq: 1 };
    const first = entry(state, { type: "item.add", itemId: "itm_1", version: nv("ver_1"), title: "one", width: 10, height: 10, placement: { x: 0, y: 0 } });
    expect(applyTailOp(held, first)).not.toBeNull();
    // The SAME envelope again — the shape a tail replay actually produces,
    // and the reducer refuses it (`duplicate-id`) because the item now
    // exists. The fold is thrown away and the cursor does NOT move: a seq
    // claimed but not held is a lie. The caller closes and redials into a
    // snapshot that is always correct.
    expect(applyTailOp(held, first)).toBeNull();
    expect(held.lastSeq).toBe(first.seq);
  });
});

describe("refusalWords — which closes are the door saying no", () => {
  it("says the door sentence for not-admitted and badge-less closes", () => {
    expect(refusalWords(4402)).toBe("You are not admitted to this canvas — open it to ask at its door.");
    expect(refusalWords(4401)).toBe("You are not admitted to this canvas — open it to ask at its door.");
  });

  it("says the read sentence for gone, wrong-origin and stale-client closes", () => {
    expect(refusalWords(4404)).toBe("This canvas could not be read right now.");
    expect(refusalWords(4403)).toBe("This canvas could not be read right now.");
    expect(refusalWords(4426)).toBe("This canvas could not be read right now.");
  });

  it("redials everything else — a close is not always a refusal", () => {
    expect(refusalWords(1000)).toBeNull();
    expect(refusalWords(1006)).toBeNull();
    expect(refusalWords(4500)).toBeNull();
  });
});

describe("hereCount — the roster's N here", () => {
  it("counts distinct actors and never counts a parked rc", () => {
    const session = (id: string, kind: "web" | "cli" | "rc" = "web") => ({ sessionId: `ses_${id}`, actor: { id, name: id }, kind }) as PresenceSession;
    expect(hereCount([session("a"), session("b"), session("a")])).toBe(2);
    expect(hereCount([session("a"), session("parked", "rc")])).toBe(1);
    expect(hereCount([])).toBe(0);
  });
});

describe("tipStall — the beat's two-beat rule (#85)", () => {
  it("does not close on one beat behind: an op may be in flight", () => {
    expect(tipStall(null, 10, 11)).toBe(false);
  });

  it("closes on the second beat at the same cursor: the subscription stopped", () => {
    expect(tipStall(10, 10, 11)).toBe(true);
  });

  it("is quiet when the tail is level or has caught up", () => {
    expect(tipStall(null, 12, 12)).toBe(false);
    expect(tipStall(10, 12, 12)).toBe(false);
  });
});
