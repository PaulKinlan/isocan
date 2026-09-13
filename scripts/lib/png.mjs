/**
 * **A tiny PNG reader, so a claim about pixels is arithmetic.**
 *
 * Two facts about the device pills are about pixels rather than layout: whether
 * the picker's arrow survived the clipping that keeps a long device name from
 * growing the page, and whether the text sits on the capsule's centre line.
 * Both are one screenshot and a few sums; squinting at a picture is not a
 * measurement and does not survive a re-run.
 *
 * Non-interlaced, 8-bit, colour type 2 (RGB) or 6 (RGBA) — what CDP's
 * `Page.captureScreenshot` returns for `format: "png"`. Node's own `zlib` is
 * the only dependency, which is why this is 60 lines and not a package.
 */
import { inflateSync } from "node:zlib";

export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} not supported`);
      if (data[12] !== 0) throw new Error("interlaced PNG not supported");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`colour type ${colorType} not supported`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      const value = line[x];
      out[x] =
        filter === 0 ? value
        : filter === 1 ? (value + a) & 0xff
        : filter === 2 ? (value + b) & 0xff
        : filter === 3 ? (value + ((a + b) >> 1)) & 0xff
        : filter === 4 ? (value + paeth(a, b, c)) & 0xff
        : (() => { throw new Error(`filter ${filter} unknown`); })();
    }
    previous = out;
  }
  return { width, height, channels, pixels };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 0…255 luminance, or null when the pixel is transparent. */
export function luminance(png, x, y) {
  const offset = (y * png.width + x) * png.channels;
  if (png.channels === 4 && png.pixels[offset + 3] < 8) return null;
  const [r, g, b] = [png.pixels[offset], png.pixels[offset + 1], png.pixels[offset + 2]];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Where the ink is, by row: how many pixels in a row are darker than the page
 * and the pill's own background. Reported as the first/last row with ink and
 * the centre between them, which is what "centred in the pill" means.
 */
export function inkRows(png, { left = 0, right = png.width, darker = 150 } = {}) {
  const rows = [];
  for (let y = 0; y < png.height; y++) {
    let dark = 0;
    for (let x = left; x < right; x++) {
      const l = luminance(png, x, y);
      if (l !== null && l < darker) dark++;
    }
    rows.push(dark);
  }
  const inked = rows.map((count, y) => (count > 0 ? y : -1)).filter((y) => y >= 0);
  if (inked.length === 0) return { rows: 0, first: null, last: null, centre: null };
  return {
    rows: inked.length,
    first: inked[0],
    last: inked.at(-1),
    centre: (inked[0] + inked.at(-1)) / 2,
  };
}

/** Ink in a vertical strip — the picker's arrow lives in the pill's right end. */
export function inkInStrip(png, { left, right, darker = 150 }) {
  let count = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = left; x < right; x++) {
      const l = luminance(png, x, y);
      if (l !== null && l < darker) count++;
    }
  }
  return count;
}
