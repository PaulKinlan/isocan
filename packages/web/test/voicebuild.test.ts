import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfigFromFile } from "vite";

/** The actual Vite injector must identify this checkout, not a tab's clock. */
describe("voice build metadata", () => {
  it.each(["serve", "build"] as const)("records %s and its invocation time", async (command) => {
    const root = process.cwd();
    const before = Date.now();
    const loaded = await loadConfigFromFile(
      { command, mode: command === "serve" ? "development" : "production" },
      path.join(root, "packages/web/vite.config.ts"),
    );
    const after = Date.now();
    const info = JSON.parse(loaded!.config.define!.__VOICE_BUILD_INFO__ as string);
    expect(info.command).toBe(command);
    expect(Date.parse(info.startedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(info.startedAt)).toBeLessThanOrEqual(after);
    expect(info.commit).toBe(execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    expect(info.branch).toBe(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim() || "(detached)");
    expect(info).not.toHaveProperty("version"); // 0.1.0 is not a revision counter.
  });
});
