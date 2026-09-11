import type { VoiceAudioChunk, VoiceAudioFormat } from "./types.ts";

function validate(format: VoiceAudioFormat): void {
  if (format.encoding !== "pcm_s16le" || format.channels !== 1 || !Number.isInteger(format.sampleRate) || format.sampleRate < 8000 || format.sampleRate > 192000) {
    throw new Error("Expected mono PCM16 with an 8–192kHz sample rate");
  }
}

/** Chunk boundaries do not reset phase. One input sample of lookahead is held.
 * ponytail: linear interpolation is prototype-quality (no anti-alias filter);
 * use a band-limited streaming converter before claiming live-audio quality. */
export class Pcm16Converter {
  private sourceRate: number | undefined;
  private samples: number[] = [];
  private position = 0;
  readonly format: VoiceAudioFormat;
  constructor(format: VoiceAudioFormat) { validate(format); this.format = { ...format }; }
  reset(): void { this.sourceRate = undefined; this.samples = []; this.position = 0; }
  convert(chunk: VoiceAudioChunk): VoiceAudioChunk {
    validate(chunk.format);
    if (!(chunk.data instanceof Uint8Array) || chunk.data.byteLength % 2 || chunk.data.byteLength > 1024 * 1024) throw new Error("Invalid PCM chunk");
    if (this.sourceRate !== undefined && this.sourceRate !== chunk.format.sampleRate) throw new Error("PCM source rate changed mid-stream; reconnect first");
    this.sourceRate = chunk.format.sampleRate;
    if (this.sourceRate === this.format.sampleRate) return { data: chunk.data, format: this.format };
    const input = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
    for (let i = 0; i < input.byteLength; i += 2) this.samples.push(input.getInt16(i, true));
    const output: number[] = [];
    const target = this.format.sampleRate;
    for (;;) {
      const index = Math.floor(this.position / target);
      const fraction = this.position % target;
      if (index >= this.samples.length || (fraction !== 0 && index + 1 >= this.samples.length)) break;
      const a = this.samples[index]!;
      output.push(Math.round(a + (fraction === 0 ? 0 : (this.samples[index + 1]! - a) * fraction / target)));
      this.position += this.sourceRate;
    }
    const consumed = Math.min(Math.floor(this.position / target), this.samples.length);
    this.samples = this.samples.slice(consumed);
    this.position -= consumed * target;
    const data = new Uint8Array(output.length * 2);
    const view = new DataView(data.buffer);
    output.forEach((sample, index) => view.setInt16(index * 2, sample, true));
    return { data, format: this.format };
  }
}
