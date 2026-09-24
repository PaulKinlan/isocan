import { describe, expect, it } from "vitest";
import { Resampler } from "../src/voiceAudio.ts";

/**
 * **The resampler, driven at the two rates a real browser hands out.**
 *
 * The silent-turn bug was an arithmetic one: the first version indexed its
 * carry buffer with `i * ratio + j` and summed over `j < ratio`. At 48,000 Hz
 * the ratio is exactly 3, every index lands on a sample, and it works; at
 * 44,100 Hz the ratio is 2.75625, every index is a float, every lookup
 * answers `undefined`, and the `?? 0` fallback turned 98.29% of the PCM into
 * zeros. The provider heard silence, never opened a turn, and the page looked
 * broken. The next device Paul uses will pick its own context rate, so the
 * invariant is: **for any ratio, the output is neither silent nor distorted**.
 *
 * The numbers are astra's: zero-sample fraction and RMS, measured at 44,100
 * and 48,000 side by side. A −20 dBFS sine has no zeros to speak of (the
 * crossing falls between samples), so the first assertion is the bug itself —
 * the broken resampler answers ~0.98 there and fails it.
 */

/** A sine whose RMS is exactly `db` dBFS, at the given context rate. */
function sineAt(rate: number, db: number, length: number): Float32Array {
  const amplitude = 10 ** (db / 20) * Math.SQRT2;
  return Float32Array.from({ length }, (_, i) => amplitude * Math.sin((2 * Math.PI * 440 * i) / rate));
}

/** Run the whole signal through, in the 128-sample blocks the worklet hands over. */
function resample(rate: number, signal: Float32Array): Int16Array {
  const resampler = new Resampler(rate / 16000);
  const out: number[] = [];
  for (let i = 0; i < signal.length; i += 128) {
    out.push(...resampler.push(signal.subarray(i, Math.min(i + 128, signal.length))));
  }
  return Int16Array.from(out);
}

/** Exactly-zero samples over the whole stream — the measure that found the bug. */
function zeroFraction(pcm: Int16Array): number {
  let zeros = 0;
  for (const sample of pcm) if (sample === 0) zeros++;
  return zeros / pcm.length;
}

/** RMS in dBFS — the other measure, so "quiet" cannot pass as "present". */
function rmsDb(pcm: Int16Array): number {
  let sum = 0;
  for (const sample of pcm) sum += (sample / 0x8000) ** 2;
  return 20 * Math.log10(Math.sqrt(sum / pcm.length));
}

describe("a resampler keeps the signal at every context rate", () => {
  it.each([44100, 48000])("at %d Hz every DC sample survives two seconds of worklet boundaries", (rate) => {
    const expected = 8191; // .25 converted with the positive PCM16 scale, then truncated.
    const pcm = resample(rate, new Float32Array(rate * 2).fill(0.25));
    // At 44.1 kHz the old epsilon-rounded discard left a negative position:
    // carry[-1] became undefined -> NaN -> PCM zero at 17600/19040/20480.
    // One-second sine/RMS checks never reached these boundaries and allowed
    // rare dropouts, so check every value as well as the aggregate signal.
    expect.soft(pcm).toHaveLength(32000);
    expect.soft([...pcm].flatMap((sample, index) => sample === expected ? [] : [index])).toEqual([]);
    expect.soft(zeroFraction(pcm)).toBe(0);
    expect.soft(rmsDb(pcm)).toBeCloseTo(20 * Math.log10(expected / 0x8000), 10);
  });

  it.each([44100, 48000])("at %d Hz a complete 10 ms tail never reads past the buffer", (rate) => {
    // At 44.1 kHz repeated addition makes the final end 441.0000000000012.
    // The completion epsilon accepted it, but carry[441] was out of bounds.
    const pcm = new Resampler(rate / 16000).push(new Float32Array(rate / 100).fill(0.25));
    expect(pcm).toHaveLength(160);
    expect([...pcm].every((sample) => sample === 8191)).toBe(true);
    expect(zeroFraction(pcm)).toBe(0);
    expect(rmsDb(pcm)).toBeCloseTo(20 * Math.log10(8191 / 0x8000), 10);
  });

  it.each([44100, 48000])("at %d Hz the stream is neither silent nor distorted", (rate) => {
    const pcm = resample(rate, sineAt(rate, -20, rate)); // one second of −20 dBFS
    expect(pcm.length).toBeGreaterThan(16000 * 0.98); // ~one second out
    expect(pcm.length).toBeLessThan(16000 * 1.02);
    expect(zeroFraction(pcm)).toBeLessThan(0.01);
    expect(rmsDb(pcm)).toBeCloseTo(-20, 0);
  });

  it("at 44.1 kHz it no longer answers the 98%-zeros the bug produced", () => {
    // The exact ratio astra measured the bug at: 44100/16000 = 2.75625.
    const pcm = resample(44100, sineAt(44100, -20, 4410));
    expect(zeroFraction(pcm)).toBeLessThan(0.01);
  });

  it("keeps the phase across worklet block boundaries", () => {
    // One block is 128 samples; a window is ~2.76 wide, so a block boundary
    // leaves a fraction behind. Feed block by block and the output must stay
    // a clean sine — block-aligned silence would read as a periodic dropout.
    const signal = sineAt(44100, -20, 44100);
    const resampler = new Resampler(44100 / 16000);
    const out: number[] = [];
    for (let i = 0; i < signal.length; i += 128) {
      const pcm = resampler.push(signal.subarray(i, i + 128));
      for (const sample of pcm) out.push(sample);
    }
    const pcm = Int16Array.from(out);
    expect(zeroFraction(pcm)).toBeLessThan(0.01);
    expect(rmsDb(pcm)).toBeCloseTo(-20, 0);
  });

  it("answers complete windows only, and holds the rest for the next block", () => {
    const resampler = new Resampler(48000 / 16000); // ratio 3: one window per 3 samples
    expect(resampler.push(new Float32Array([1, 1, 1]))).toHaveLength(1);
    expect(resampler.push(new Float32Array([0.5, 0.5]))).toHaveLength(0); // 2 left is not a window
    expect(resampler.push(new Float32Array([0.5, 1, 1, 1]))).toHaveLength(2); // 3 now, plus 3
  });

  it("passes 16 kHz straight through", () => {
    const resampler = new Resampler(1);
    const pcm = resampler.push(Float32Array.from([0.5, -0.5, 0.25]));
    // Int16 conversion truncates toward zero, which is the same quantisation
    // the wire has always had.
    expect([...pcm]).toEqual([16383, -16384, 8191]);
  });

  it("never exceeds full scale", () => {
    const pcm = resample(44100, sineAt(44100, 0, 44100)); // a 0 dBFS sine
    expect(Math.max(...pcm)).toBeLessThanOrEqual(0x7fff);
    expect(Math.min(...pcm)).toBeGreaterThanOrEqual(-0x8000);
  });
});

/**
 * **Whole versus chunked: strict where strictness is achievable, bounded where
 * it is not** (isocan-xsh.10).
 *
 * A source probe found that a 44.1 kHz sine pushed whole and pushed in chunks
 * `[128, 3, 77, 256, 1, 511]` emits the same 32,013 samples with exactly one
 * differing by one PCM16 LSB. That difference is arithmetic, not a broken
 * resampler: 44100/16000 = 2.75625 is not an integer, so a chunk boundary can
 * leave a fraction of a window behind, and float→PCM16 rounding is not
 * associative — the same sum can land either side of a .5 LSB step. So this
 * asserts the exact equality where the ratio makes it achievable (48 kHz, ratio
 * 3) and a measured, justified bound where it does not, with the length
 * invariant checked at every chunk size — which is the part a dropout or an
 * off-by-one in the carry would break.
 */
describe("whole versus chunked resampling (isocan-xsh.10)", () => {
  /** A worklet block, a three, an odd one, a bigger one, a single sample, and a
   *  large one: the carry is exercised at every kind of boundary, not one. */
  const CHUNKS = [128, 3, 77, 256, 1, 511];

  /** The probe's own signal: 997 Hz, −20 dBFS, phase .371. */
  function tone(rate: number, n: number): Float32Array {
    const amp = Math.SQRT2 * 0.1;
    const signal = new Float32Array(n);
    for (let i = 0; i < n; i++) signal[i] = amp * Math.sin((2 * Math.PI * 997 * i) / rate + 0.371);
    return signal;
  }

  function bothOrders(rate: number, n: number): { whole: Int16Array; chunked: Int16Array } {
    const signal = tone(rate, n);
    const whole = new Resampler(rate / 16000).push(signal);
    const resampler = new Resampler(rate / 16000);
    const out: number[] = [];
    let from = 0;
    let k = 0;
    while (from < n) {
      const size = CHUNKS[k++ % CHUNKS.length]!;
      const to = Math.min(n, from + size);
      for (const sample of resampler.push(signal.subarray(from, to))) out.push(sample);
      from = to;
    }
    return { whole, chunked: Int16Array.from(out) };
  }

  function difference(a: Int16Array, b: Int16Array): { differing: number; maxLsb: number } {
    let differing = 0;
    let maxLsb = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const delta = Math.abs(a[i]! - b[i]!);
      if (delta !== 0) differing++;
      maxLsb = Math.max(maxLsb, delta);
    }
    return { differing, maxLsb };
  }

  it("is bit-identical at 48 kHz, where every output window lands on an input sample", () => {
    const { whole, chunked } = bothOrders(48000, 96037);
    expect(chunked.length, "the same samples, whatever the chunking").toBe(whole.length);
    expect(whole.length).toBe(32012);
    expect(difference(whole, chunked), "ratio 3 leaves no fraction to round").toEqual({ differing: 0, maxLsb: 0 });
  });

  it("keeps the length exact at every chunk size, which is what a dropout would break", () => {
    const signal = tone(44100, 88237);
    const reference = bothOrders(44100, 88237).whole.length;
    for (const size of [1, 7, 128, 1024, 88237]) {
      const resampler = new Resampler(44100 / 16000);
      let emitted = 0;
      for (let from = 0; from < signal.length; from += size) {
        emitted += resampler.push(signal.subarray(from, Math.min(signal.length, from + size))).length;
      }
      expect(emitted, `chunk size ${size} lost or gained a sample`).toBe(reference);
    }
  });

  it("differs by at most one LSB at 44.1 kHz — a boundary rounding, never drift", () => {
    // Measured on this signal and asserted here: 32,013 samples out, ONE
    // differing, by exactly 1 LSB, at index 22,981 (2265 whole, 2266 chunked).
    // The bound is a bound, not a licence: an off-by-one in the carry, a dropped
    // window or a rescaled sample each exceed it, and the 48 kHz case above is
    // held to exact equality.
    const { whole, chunked } = bothOrders(44100, 88237);
    expect(chunked.length).toBe(whole.length);
    expect(whole.length).toBe(32013);
    const { differing, maxLsb } = difference(whole, chunked);
    expect(maxLsb, "one quantisation step, never two").toBeLessThanOrEqual(1);
    expect(differing, "one sample in 32,013 — not a broken stream").toBeLessThanOrEqual(2);
  });
});
