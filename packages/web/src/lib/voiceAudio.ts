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

export interface Input {
  id: string;
  label: string;
}

/**
 * **The microphones, and the trap that makes them look nameless.**
 *
 * Device labels are empty until the browser has been given microphone
 * permission once — so this is called on load AND again after the first
 * successful capture, which is the moment the names appear. Before that a
 * person still has to be able to choose, so unnamed inputs are numbered
 * rather than rendered as blanks.
 */
export async function inputs(): Promise<Input[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const found = await navigator.mediaDevices.enumerateDevices();
  return found
    .filter((device) => device.kind === "audioinput")
    .map((device, index) => ({
      id: device.deviceId,
      label: device.label || `microphone ${index + 1}`,
    }));
}

/**
 * **A level meter, not a peak display and not a random number.**
 *
 * Three things were wrong at once and this is all three:
 *
 *   - the reading was `0.35 + Math.random() * 0.6`, so every tick pinned the
 *     top half of the bars on any sound and on no sound at all;
 *   - amplitude is linear where loudness is logarithmic — normal speech sits
 *     near −20 dBFS, which on a linear scale is already 90% of the way up, so
 *     "everything above a whisper pins the top" is arithmetic, not taste;
 *   - a peak meter jumps to full on one transient and reads as broken.
 *
 * So: RMS over the block (`sqrt(mean(x²))`), converted with `20·log10`, floored
 * at −60 dBFS, gated below −55 so a quiet room reads zero rather than one
 * twitching bar, mapped −60…0 → 0…bars, and smoothed in dB — a release
 * measured in dB per tick is visible at the top and not sluggish at the bottom,
 * which a multiplicative decay on raw amplitude is not.
 */
export const METER_FLOOR_DB = -60;
/** Under this, the room is silent: zero bars, not one that twitches. */
export const METER_GATE_DB = -55;
const METER_BARS = 28;
/** How much of the gap to a louder reading is closed per 100 ms tick. */
const ATTACK = 0.55;
/** Decay, in dB per tick — 60 dB/s. */
const RELEASE_DB = 6;
/** The held peak falls this much per tick, so a word stays visible. */
const PEAK_DROP_DB = 1.5;

/** `mean(x²)`, the step before the square root. Int16 is normalised first. */
export function meanSquareOf(pcm: Int16Array | Float32Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const sample = pcm instanceof Int16Array ? pcm[i]! / 0x8000 : pcm[i]!;
    sum += sample * sample;
  }
  return sum / pcm.length;
}

export function rmsOf(pcm: Int16Array | Float32Array): number {
  return Math.sqrt(meanSquareOf(pcm));
}

/** Mean square → dBFS, floored. Silence answers `-Infinity`, not `-Infinity` dB. */
export function dbFromMeanSquare(meanSquare: number): number {
  if (!(meanSquare > 0)) return -Infinity;
  return Math.max(METER_FLOOR_DB, 20 * Math.log10(Math.sqrt(meanSquare)));
}

export function dbfs(pcm: Int16Array | Float32Array): number {
  return dbFromMeanSquare(meanSquareOf(pcm));
}

/** −60…0 dBFS → 0…count bars. Everything under the gate is silence. */
export function barsFromDb(db: number, count = METER_BARS): number {
  if (!Number.isFinite(db) || db <= METER_GATE_DB) return 0;
  const level = Math.min(0, db) - METER_FLOOR_DB;
  return Math.max(0, Math.min(count, Math.round((level / -METER_FLOOR_DB) * count)));
}

/**
 * **What the meter remembers between frames.**
 *
 * `feed` takes blocks as they arrive (about 8 ms each) and accumulates their
 * energy; `tick` runs on the display interval, turns the window into one dBFS
 * reading, and applies attack, release and the held peak. Keeping the two
 * apart is what makes this testable without a microphone: a test can feed a
 * synthetic sine of a known level and read the same numbers the page shows.
 */
export class LevelMeter {
  private db = METER_FLOOR_DB;
  private peakDb = METER_FLOOR_DB;
  private sum = 0;
  private samples = 0;

  constructor(readonly bars: number = METER_BARS) {}

  /** One block of PCM: Float32 from the worklet, Int16 off the wire. */
  feed(pcm: Int16Array | Float32Array): void {
    this.sum += meanSquareOf(pcm) * pcm.length;
    this.samples += pcm.length;
  }

  /** One display frame: 0…1 for the bars, 0…1 for the held peak, and the dB. */
  tick(): { level: number; peak: number; db: number } {
    const mean = this.samples > 0 ? this.sum / this.samples : 0;
    this.sum = 0;
    this.samples = 0;
    const raw = dbFromMeanSquare(mean);
    const gated = raw > METER_GATE_DB ? raw : -Infinity;
    const next =
      gated > this.db ? this.db + (gated - this.db) * ATTACK : Math.max(gated, this.db - RELEASE_DB);
    this.db = Math.max(METER_FLOOR_DB, next);
    this.peakDb = Math.max(this.peakDb - PEAK_DROP_DB, this.db);
    return {
      level: barsFromDb(this.db, this.bars) / this.bars,
      peak: barsFromDb(this.peakDb, this.bars) / this.bars,
      db: this.db,
    };
  }

  /** A new session starts at rest rather than holding the last one's peak. */
  reset(): void {
    this.db = METER_FLOOR_DB;
    this.peakDb = METER_FLOOR_DB;
    this.sum = 0;
    this.samples = 0;
  }
}

export interface Capture {
  path: string;
  deviceId: string;
  label: string;
  /** Kept so a device change can swap the track without touching the session. */
  frames: (pcm: Int16Array) => void;
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

export async function capture(
  onFrame: (pcm: Int16Array) => void,
  deviceId?: string,
  onDone?: (pcm: Int16Array) => void,
): Promise<Capture> {
  // `exact` because "prefer this one" silently gives you the system default,
  // which is the bug being fixed here.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    video: false,
  });
  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings?.() ?? {};
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
      for (let j = 0; j < ratio; j++) sum += carry[i * ratio + j] ?? 0;
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
    deviceId: settings.deviceId ?? deviceId ?? "default",
    label: track?.label || "unnamed microphone",
    muted: false,
    context,
    frames: onFrame,
    stop: () => {
      node.port.onmessage = null;
      void onDone;
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
    for (let i = 0; i < pcm.length; i++) channel[i] = (pcm[i] ?? 0) / 0x8000;
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
