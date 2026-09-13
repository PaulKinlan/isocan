import { describe, expect, it, vi } from "vitest";
import type { SeenMark } from "@isocan/core";

const api = vi.hoisted(() => ({ fetchSeen: vi.fn(), putSeen: vi.fn() }));
vi.mock("../src/lib/api.ts", () => api);

describe("accepted visits update the local inbox", () => {
  it("announces the home's accepted mark, never a read or an optimistic browser clock", async () => {
    api.fetchSeen.mockResolvedValue({ marks: {} });
    let accept!: (value: { mark: SeenMark }) => void;
    api.putSeen.mockReturnValue(new Promise((resolve) => { accept = resolve; }));
    const { loadSeen, noteVisit, onSeenVisit, seenMarks } = await import("../src/lib/seen.ts");
    const received = vi.fn();
    const unwatch = onSeenVisit(received);
    await loadSeen("usr_ada");
    expect(received).not.toHaveBeenCalled();
    noteVisit("prj_acme", 10, "usr_ada");
    await Promise.resolve();
    expect(api.putSeen).toHaveBeenCalledWith("prj_acme", 10, "usr_ada");
    expect(received).not.toHaveBeenCalled();
    const mark = { seq: 12, at: "2026-09-13T12:00:00.000Z" };
    accept({ mark });
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith("usr_ada", "prj_acme", mark));
    expect(seenMarks("usr_ada").prj_acme).toEqual(mark);
    unwatch();
    noteVisit("prj_acme", 12, "usr_ada");
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toHaveBeenCalledTimes(1);
  });
});
