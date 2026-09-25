import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canvasIdFromUrl, recordDeliveryLoss } from "../src/delivery-ledger.ts";

/* The contract a reader of the ledger will rely on. The other half — that a
   write to an unreachable home actually reaches this function through the 503
   branch — is asserted end-to-end in test/connect-deadline.test.ts, which
   already builds a real server for this error. */

const dir = () => mkdtempSync(join(tmpdir(), "isocan-ledger-"));

const row = (canvasId: string | null = "prj_led", cause = "ECONNREFUSED") => ({
  at: "2026-09-25T07:30:00.000Z",
  canvasId,
  homeUrl: "http://127.0.0.1:1",
  cause,
  outcome: "not-made" as const,
});

describe("the delivery ledger", () => {
  it("records one row per attempt-and-loss, and nothing else", () => {
    const path = join(dir(), "delivery.jsonl");
    recordDeliveryLoss(row(), path);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      canvasId: "prj_led",
      homeUrl: "http://127.0.0.1:1",
      cause: "ECONNREFUSED",
      outcome: "not-made",
    });
  });

  it("appends rather than replacing — the third loss does not erase the first", () => {
    /* The failure this guards against is the one that makes a ledger worthless:
       a write that truncates leaves a record of only the most recent loss, and
       a person asking "how long has this been failing?" gets today's answer. */
    const path = join(dir(), "delivery.jsonl");
    recordDeliveryLoss(row("prj_a", "first"), path);
    recordDeliveryLoss(row("prj_b", "second"), path);
    recordDeliveryLoss(row("prj_c", "third"), path);
    const causes = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l).cause);
    expect(causes).toEqual(["first", "second", "third"]);
  });

  it("never throws when the record cannot be written — the 503 is the answer", () => {
    /* A courtesy must not cost the answer. The path is a directory, so the
       append fails at the OS level; the caller must not see that. */
    const path = dir();
    expect(() => recordDeliveryLoss(row(), path)).not.toThrow();
  });

  it("names the canvas from a request path, and says null rather than guessing", () => {
    expect(canvasIdFromUrl("/api/canvases/prj_acme/ops")).toBe("prj_acme");
    expect(canvasIdFromUrl("/api/canvases/prj_acme?x=1")).toBe("prj_acme");
    expect(canvasIdFromUrl("/api/homes")).toBeNull();
    expect(canvasIdFromUrl(undefined)).toBeNull();
  });
});
