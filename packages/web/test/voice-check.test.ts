import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { inputLevel } from "../src/lib/voice-check.ts";

const controller = readFileSync(new URL("../src/lib/voice-check.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/pages/VoiceCheckPage.tsx", import.meta.url), "utf8");

describe("local capture check", () => {
  it("reports silence, relative levels and bounded full scale from actual samples", () => {
    expect(inputLevel(new Float32Array())).toBe(0);
    expect(inputLevel(new Float32Array(32))).toBe(0);
    expect(inputLevel(new Float32Array([0.1, -0.1]))).toBeCloseTo(2 / 3);
    expect(inputLevel(new Float32Array([1, -1]))).toBe(1);
    expect(inputLevel(new Float32Array([2, -2]))).toBe(1);
  });

  it("keeps the diagnostic dependency boundary free of clients, credentials and network senders", () => {
    // A closed, deliberately small import surface. The browser run separately
    // records actual requests; this guard prevents adding a hidden client here.
    expect(controller).not.toMatch(/\bimport\s/);
    const imports = [...page.matchAll(/^import .+? from "(.+?)";/gm)].map((match) => match[1]);
    expect(imports).toEqual(["react", "../lib/voice-check.ts"]);
    for (const source of [controller, page]) {
      expect(source).not.toMatch(/\b(?:fetch|WebSocket|XMLHttpRequest|EventSource|sendBeacon|importScripts|eval)\b/);
      expect(source).not.toMatch(/\bimport\s*\(|process\.env|localStorage|sessionStorage|document\.cookie|https?:\/\//);
    }
    expect(controller).not.toContain('createElement("usermedia")');
    expect(controller).toContain('getUserMedia({ audio: true, video: false })');
    expect(controller).toContain('media.getVideoTracks().length');
    expect(controller).toContain("URL.createObjectURL(blob)");
    expect(controller).toContain("player.src = clipUrl");
  });
});
