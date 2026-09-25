/**
 * Build icons/ZcodeKnight.ico from logo.svg.
 *
 * Two things make this non-obvious, and both are why the first version of this
 * file produced an icon Windows rendered as garbage:
 *
 *  1. **Format per entry.** Windows only accepts PNG-compressed entries in an
 *     ICO for 256x256 and above. Smaller entries must be classic BMP (a
 *     BITMAPINFOHEADER followed by BGRA pixels and an AND mask). Writing PNG at
 *     16/32/48/64/128 makes Explorer read PNG bytes as raw pixels, which paints
 *     a tiled-looking mess instead of the logo.
 *
 *  2. **BMP height is doubled.** An ICO bitmap stores the colour image AND a
 *     1-bit transparency mask, so the header's height field is 2x the real
 *     height. Getting this wrong shifts every scanline.
 *
 * Usage:  <runtime> run server/scripts/make-icon.ts
 *
 * Input:  _icon-<size>.png in the project root — the logo rasterized at each
 *         size. There is no image library in this project (no sharp/resvg/
 *         canvas), so those come from rendering logo.svg in a browser at each
 *         size and screenshotting it. To redo the whole icon:
 *
 *           1. serve logo.svg and a page that shows it at a fixed pixel size
 *              (the size is just CSS width/height on the element)
 *           2. screenshot that element at 16/32/48/64/128/256
 *           3. save them as _icon-<size>.png here, then run this script
 *
 *         A browser is used rather than an SVG rasterizer because the icon is
 *         generated rarely, and the browser renders the gradients and strokes
 *         exactly as the panel does — a second renderer could disagree.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";

/**
 * Project root, derived from this file's own location so the script keeps
 * working after the project is moved: `<root>/server/scripts/make-icon.ts`.
 */
const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/\/$/, "");
/** Sizes Windows picks from, smallest first. */
const SIZES = [16, 32, 48, 64, 128, 256];
/** The one size stored as PNG; everything smaller must be BMP. */
const PNG_FROM = 256;

/** Decode a PNG to straight RGBA bytes. */
function decodePng(buf: Buffer): { w: number; h: number; rgba: Buffer } {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat: Buffer[] = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString("latin1");
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8); colorType = data.readUInt8(9);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG: depth=${bitDepth} colorType=${colorType}`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    raw.copy(cur, 0, p, p + stride);
    p += stride;
    // Undo the per-scanline filter. PNG's five filters are fixed by spec.
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = cur[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
    cur.copy(prev);
    for (let x = 0; x < w; x++) {
      const s = x * bpp, d = (y * w + x) * 4;
      out[d] = cur[s];
      out[d + 1] = cur[s + 1];
      out[d + 2] = cur[s + 2];
      out[d + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
  }
  return { w, h, rgba: out };
}

/** Encode RGBA pixels as an ICO BMP entry (header + BGRA + AND mask). */
function encodeBmp(w: number, h: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);              // BITMAPINFOHEADER size
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8);            // colour + mask, hence 2x
  header.writeUInt16LE(1, 12);              // planes
  header.writeUInt16LE(32, 14);             // bits per pixel
  header.writeUInt32LE(0, 16);              // BI_RGB (no compression)
  header.writeUInt32LE(w * h * 4, 20);      // colour data size

  // Pixels are stored bottom-up, in BGRA order.
  const pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    for (let x = 0; x < w; x++) {
      const s = src + x * 4, d = (y * w + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }

  // AND mask: 1 bit per pixel, rows padded to 4 bytes. 1 = transparent. It is
  // required even when the colour data carries alpha — some shell paths read
  // only the mask, and a zeroed one would show a black box.
  const maskStride = Math.ceil(w / 32) * 4;
  const mask = Buffer.alloc(maskStride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const alpha = rgba[((h - 1 - y) * w + x) * 4 + 3];
      if (alpha < 128) mask[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

const entries: Array<{ size: number; data: Buffer }> = [];
for (const size of SIZES) {
  const pngPath = `${ROOT}/_icon-${size}.png`;
  if (!existsSync(pngPath)) throw new Error(`missing ${pngPath} — screenshot the logo at ${size}px first`);
  const png = readFileSync(pngPath);
  if (size >= PNG_FROM) {
    entries.push({ size, data: png });
  } else {
    const { w, h, rgba } = decodePng(png);
    entries.push({ size, data: encodeBmp(w, h, rgba) });
  }
}

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);

let offset = 6 + entries.length * 16;
const dir: Buffer[] = [];
for (const e of entries) {
  const b = Buffer.alloc(16);
  b.writeUInt8(e.size >= 256 ? 0 : e.size, 0);
  b.writeUInt8(e.size >= 256 ? 0 : e.size, 1);
  b.writeUInt8(0, 2);
  b.writeUInt8(0, 3);
  b.writeUInt16LE(1, 4);
  b.writeUInt16LE(32, 6);
  b.writeUInt32LE(e.data.length, 8);
  b.writeUInt32LE(offset, 12);
  dir.push(b);
  offset += e.data.length;
}

const ico = Buffer.concat([header, ...dir, ...entries.map((e) => e.data)]);
writeFileSync(`${ROOT}/icons/ZcodeKnight.ico`, ico);
console.log(`icons/ZcodeKnight.ico: ${ico.length} bytes`);
for (const e of entries) {
  console.log(`  ${String(e.size).padStart(3)}px  ${e.size >= PNG_FROM ? "PNG" : "BMP"}  ${e.data.length} bytes`);
}
