/**
 * Rasterize logo.svg into the PNGs make-icon.ts consumes.
 *
 * Why this exists as a script rather than a manual screenshot session: the
 * first attempt captured each size with a viewport CLIP, and the clip origin
 * drifted from where the SVG actually sat. The result was an icon whose
 * bottom-right corner showed the neighbouring tile — the "连续图" artefact.
 *
 * The approach here removes that whole class of bug:
 *
 *   1. the SVG fills the viewport EXACTLY, so there is no surrounding page to
 *      bleed in and no clip origin to get wrong;
 *   2. one capture at a large size is taken, with no clip at all;
 *   3. every target size is produced by box-filtering that capture DOWN in
 *      TypeScript, which is deterministic and inspectable.
 *
 * Usage:  <runtime> run server/scripts/rasterize-logo.ts
 * Output: _icon-<size>.png in the project root, then run make-icon.ts.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, "$1").replace(/\/$/, "");

/** Capture size. Larger than any icon we emit, so every size is a downsample. */
export const CAPTURE = 512;
/** Sizes Windows picks from. */
export const SIZES = [16, 32, 48, 64, 128, 256];

// ── PNG decode / encode (no image library in this project) ──────────────────

export function decodePng(buf: Buffer): { w: number; h: number; rgba: Buffer } {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let w = 0, h = 0, depth = 0, colorType = 0;
  const idat: Buffer[] = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString("latin1");
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data.readUInt8(8); colorType = data.readUInt8(9);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG: depth=${depth} colorType=${colorType}`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * 4);
  const prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    raw.copy(cur, 0, p, p + stride); p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = cur[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
    cur.copy(prev);
    for (let x = 0; x < w; x++) {
      const s = x * bpp, d = (y * w + x) * 4;
      out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2];
      out[d + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
  }
  return { w, h, rgba: out };
}

function crc32(buf: Buffer): number {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(w: number, h: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Box-filter downsample. Averages every source pixel that maps into the target
 * pixel, which is both correct for large reductions and simple enough to verify
 * by reading it — unlike a resampling library, there is no hidden behaviour.
 *
 * Alpha is averaged WITHOUT premultiplying, which is right here: the icon's
 * transparent surround is fully transparent (alpha 0) and the artwork is fully
 * opaque, so there is no coloured-but-transparent fringe to smear.
 */
export function downsample(
  src: Buffer, sw: number, sh: number, dw: number, dh: number,
): Buffer {
  const out = Buffer.alloc(dw * dh * 4);
  const xr = sw / dw, yr = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor(dy * yr), y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil((dy + 1) * yr)));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor(dx * xr), x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil((dx + 1) * xr)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * sw + x) * 4;
          r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3];
          n++;
        }
      }
      const d = (dy * dw + dx) * 4;
      out[d] = Math.round(r / n); out[d + 1] = Math.round(g / n);
      out[d + 2] = Math.round(b / n); out[d + 3] = Math.round(a / n);
    }
  }
  return out;
}

/**
 * Build the capture page: the SVG as the document root, sized to fill the
 * viewport exactly. No wrapper element and no page background, so nothing can
 * appear in the frame that is not the logo.
 */
export function captureHtml(): string {
  const svg = readFileSync(`${ROOT}/logo.svg`, "utf-8")
    .replace(/width="128" height="128"/, `width="${CAPTURE}" height="${CAPTURE}"`);
  return `<!doctype html><html><head><style>
    html,body { margin:0; padding:0; background:transparent; overflow:hidden; }
    svg { display:block; }
  </style></head><body>${svg}</body></html>`;
}

// Two modes, because the screenshot has to happen in a browser this script
// cannot drive. The seam between them is a FILE, not a shared variable, so each
// half can be run and checked on its own.
//
//   (default)  serve the capture page; screenshot it with no clip
//   --sizes    read _capture-<N>.png and emit _icon-<size>.png for every size
if (import.meta.main) {
  if (process.argv.includes("--sizes")) {
    const capPath = `${ROOT}/_capture-${CAPTURE}.png`;
    if (!existsSync(capPath)) {
      console.error(`missing ${capPath} — screenshot the capture page first`);
      process.exit(1);
    }
    const { w, h, rgba } = decodePng(readFileSync(capPath));
    if (w !== CAPTURE || h !== CAPTURE) {
      console.error(`capture is ${w}x${h}, expected ${CAPTURE}x${CAPTURE}`);
      process.exit(1);
    }
    console.log(`source: ${w}x${h}`);
    for (const size of SIZES) {
      const px = size === w ? rgba : downsample(rgba, w, h, size, size);
      writeFileSync(`${ROOT}/_icon-${size}.png`, encodePng(size, size, px));
      // Report the bottom-right alpha: a correct icon is transparent at every
      // corner, so a tiling bug shows up here rather than only in the image.
      const corner = px[(size * size - 1) * 4 + 3];
      console.log(`  ${String(size).padStart(3)}px  corner alpha=${corner}  (0 = clean)`);
    }
    console.log("now run: <runtime> run server/scripts/make-icon.ts");
  } else {
    const port = Number(process.env.ICON_PORT ?? "17804");
    Bun.serve({
      port,
      fetch() {
        return new Response(captureHtml(), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      },
    });
    console.log(`capture page on http://127.0.0.1:${port}/  (${CAPTURE}x${CAPTURE})`);
    console.log(`screenshot it with NO clip and save as _capture-${CAPTURE}.png, then:`);
    console.log(`  <runtime> run server/scripts/rasterize-logo.ts --sizes`);
  }
}
