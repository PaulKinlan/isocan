import { afterEach, describe, expect, it, vi } from "vitest";
import { Playback, START_CUSHION, type ScheduleInfo } from "../src/lib/voiceAudio.ts";

/**
 * **The overlap Paul heard, and the cursor that ends it.**
 *
 * `source.start()` with no argument starts a chunk at "now", so any chunk that
 * arrived while the previous one still had audio left started on top of it.
 * The overlap was guaranteed, not occasional: the model sends audio faster
 * than real time, so a chunk arriving 20 ms after its predecessor began 20 ms
 * after it and played over it. The measured symptom was "a lot of overlap in
 * the audio" and the cause was one missing cursor.
 *
 * These are the numbers the page's log now shows, held to as arithmetic:
 * every chunk starts where the last one ended, nothing is scheduled in the
 * past, and an interruption resets the clock rather than leaving a hole or an
 * overlap behind it.
 */

/** A context just real enough to record when each chunk was asked to start. */
class FakeContext {
  currentTime = 0;
  state = "running";
  destination = {};
  readonly started: number[] = [];
  readonly stopped: unknown[] = [];

  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) };
  }

  createBufferSource() {
    const context = this;
    const source = {
      buffer: null as { duration: number } | null,
      onended: null as (() => void) | null,
      connect: () => undefined,
      start: (when = 0) => context.started.push(when),
      stop: () => context.stopped.push(source),
    };
    return source;
  }

  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}

/** 0.1 s of 24 kHz PCM, the granularity the Live API sends. */
const chunk = (): Int16Array => new Int16Array(2400).fill(1000);

function fake(): FakeContext {
  const context = new FakeContext();
  vi.stubGlobal("AudioContext", function AudioContext() {
    return context;
  } as unknown as typeof AudioContext);
  return context;
}

afterEach(() => vi.unstubAllGlobals());

describe("playback schedules each chunk after the last", () => {
  it("starts chunk N+1 exactly where chunk N ended", async () => {
    const context = fake();
    const playback = new Playback();
    const seen: ScheduleInfo[] = [];
    playback.onSchedule = (info) => seen.push(info);

    for (let i = 0; i < 4; i++) await playback.push(chunk());

    // 0.1 s chunks at a stopped clock: the cursor does all the moving.
    const expected = [0, 1, 2, 3].map((index) => START_CUSHION + index * 0.1);
    context.started.forEach((start, index) => expect(start).toBeCloseTo(expected[index]!, 9));
    for (let i = 1; i < seen.length; i++) {
      // The overlap assertion: no chunk begins before its predecessor ends.
      expect(seen[i]!.start).toBeGreaterThanOrEqual(seen[i - 1]!.start + seen[i - 1]!.duration - 1e-9);
    }
    expect(seen.map((one) => one.seq)).toEqual([0, 1, 2, 3]);
    expect(seen[0]!.bytes).toBe(4800);
  });

  it("starts at now rather than in the past when playback fell behind", async () => {
    const context = fake();
    const playback = new Playback();
    const seen: ScheduleInfo[] = [];
    playback.onSchedule = (info) => seen.push(info);

    await playback.push(chunk()); // cursor: 0.02 … 0.12
    context.currentTime = 5; // a long silence, or a slow decode
    await playback.push(chunk());

    expect(seen[1]!.behind).toBe(true);
    expect(seen[1]!.start).toBeCloseTo(5 + START_CUSHION, 9);
    expect(seen[1]!.start).toBeGreaterThan(context.currentTime);

    context.currentTime = 5.05;
    await playback.push(chunk());
    expect(seen[2]!.behind).toBe(false);
    expect(seen[2]!.start).toBeCloseTo(seen[1]!.start + 0.1, 9);
  });

  it("resets the clock on an interruption instead of overlapping the next reply", async () => {
    const context = fake();
    const playback = new Playback();
    const seen: ScheduleInfo[] = [];
    playback.onSchedule = (info) => seen.push(info);

    await playback.push(chunk());
    await playback.push(chunk());
    playback.stopNow();
    expect(context.stopped).toHaveLength(2);

    context.currentTime = 1;
    await playback.push(chunk());
    expect(seen[2]!.start).toBeCloseTo(1 + START_CUSHION, 9);
  });
});
