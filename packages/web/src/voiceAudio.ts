/**
 * Capturing a voice, and playing one back, in the two formats the harness
 * speaks: 16 kHz PCM in, 24 kHz PCM back.
 *
 * The ladder is deliberately short. `<microphone>` is preferred when a browser
 * actually has it; `<usermedia>` is NOT in the ladder because Chromium adds
 * both capture descriptors to it, so an audio feature that reached for it
 * would ask for a camera. Everything else is `getUserMedia({audio: true})`,
 * which is the path that runs today, and the page says which one ran.
 */

export interface Capture {
  path: string;
  stop: () => void;
  muted: boolean;
  context: AudioContext;
}

/** A Worklet that owns the rate conversion, off the page's main thread. */
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.ready = true; }
  process(input) {
    const channel = input[0] && input[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("tap", Tap);
`;

export async function capture(onFrame: (pcm: Int16Array) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const context = new AudioContext();
  await context.resume();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
  await context.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "tap");
  const carry: number[] = [];
  const ratio = context.sampleRate / 16000;

  node.port.onmessage = (message: MessageEvent<Float32Array>) => {
    if (held.muted) return;
    carry.push(...message.data);
    const whole = Math.floor(carry.length / ratio) * ratio;
    if (whole === 0) return;
    const pcm = new Int16Array(whole / ratio);
    for (let i = 0; i < pcm.length; i++) {
      // One sample per output step, averaged over the step: dropping samples
      // instead of averaging is what makes a resampled voice sound metallic.
      let sum = 0;
      for (let j = 0; j < ratio; j++) sum += carry[i * ratio + j];
      const value = Math.max(-1, Math.min(1, sum / ratio));
      pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
    carry.splice(0, whole);
    onFrame(pcm);
  };
  source.connect(node);
  // The worklet needs a live path to be pulled; not to the speakers, or the
  // page howls.
  node.connect(context.destination);

  const held: Capture = {
    path: "getUserMedia, audio only",
    muted: false,
    context,
    stop: () => {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close();
    },
  };
  return held;
}

/** What the model says back, played as it arrives, and stopped when it is cut off. */
export class Playback {
  private context: AudioContext | null = null;
  private playing: AudioBufferSourceNode[] = [];

  private async ready(): Promise<AudioContext> {
    if (!this.context) this.context = new AudioContext({ sampleRate: 24000 });
    if (this.context.state === "suspended") await this.context.resume();
    return this.context;
  }

  async push(pcm: Int16Array): Promise<void> {
    const context = await this.ready();
    const buffer = context.createBuffer(1, pcm.length, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      this.playing = this.playing.filter((one) => one !== source);
    };
    source.start();
    this.playing.push(source);
  }

  /** `interrupted` is the server saying the person spoke over the model. */
  stopNow(): void {
    for (const source of this.playing) {
      try {
        source.stop();
      } catch {
        // Already ended; stopping it twice is not a failure worth reporting.
      }
    }
    this.playing = [];
  }

  close(): void {
    this.stopNow();
    void this.context?.close();
    this.context = null;
  }
}

export function toBytes(pcm: Int16Array): ArrayBuffer {
  return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
}

export function fromBytes(data: ArrayBuffer | Blob): Promise<Int16Array> {
  if (data instanceof Blob) {
    return data.arrayBuffer().then((buffer) => new Int16Array(buffer));
  }
  return Promise.resolve(new Int16Array(data));
}
