import { describe, expect, it } from "vitest";
import { applyOperation } from "../src/index.ts";
import type { Operation } from "../src/index.ts";
import { envelope, nv, seedState } from "./helpers.ts";

function derived() {
  const state = seedState();
  state.canvas.items.itm_1!.properties = { derived: "roadmap", source: "https://github.com/acme/widgets/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/docs/plan.md" };
  return state;
}

describe("derived content is a reading, not an editable copy", () => {
  const changes: Operation[] = [
    { type: "item.update", itemId: "itm_1", patch: { title: "Invented verdict" } },
    { type: "item.update", itemId: "itm_1", patch: { removeProperties: ["derived"] } },
    { type: "item.update", itemId: "itm_1", patch: { properties: { source: "https://example.com" } } },
    { type: "item.addVersion", itemId: "itm_1", version: nv("ver_invented") },
    { type: "item.restoreVersion", itemId: "itm_1", version: { ...nv("ver_invented"), createdBy: { id: "usr_writer", name: "Writer" }, createdAt: "2026-01-01T00:00:00Z" } },
  ];
  it.each(changes)("refuses $type at the shared reducer, including removing the lock", (op) => {
    expect(() => applyOperation(derived(), envelope(op))).toThrow(/derived.*source/i);
  });
  it("keeps ordinary documents editable (the positive control)", () => {
    const state = applyOperation(seedState(), envelope(changes[0]!))!;
    expect(state.canvas.items.itm_1!.title).toBe("Invented verdict");
  });
  it("allows positioning, reactions, delete and undo-delete without changing the reading", () => {
    const state = derived();
    const moved = applyOperation(state, envelope({ type: "item.move", itemId: "itm_1", x: 120, y: 80 }))!;
    expect(moved.canvas.items.itm_1!.x).toBe(120);
    const deleted = applyOperation(moved, envelope({ type: "item.delete", itemId: "itm_1" }))!;
    const restored = applyOperation(deleted, envelope({ type: "item.restore", itemId: "itm_1" }))!;
    expect(restored.canvas.items.itm_1!.versions).toEqual(state.canvas.items.itm_1!.versions);
    expect(restored.canvas.items.itm_1!.properties).toEqual(state.canvas.items.itm_1!.properties);
  });
});
