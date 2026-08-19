/**
 * The leak audits, lifted out of `tools/blind-compare.mjs` so a second deck builder cannot
 * quietly ship a weaker copy of them.
 *
 * Nothing here is new. Every function is the one `blind-compare.mjs` grew, comment for
 * comment, and the reason it now lives in a module is that `tools/pair-deck.mjs` needed the
 * same battery and the two obvious alternatives were both bad: import from a script that
 * builds a deck as a side effect of being loaded, or paste the functions and let the copies
 * drift. This project has eight recorded blind-deck leaks and at least two of them were
 * "the other tool did not have that check yet".
 *
 * The audits, and what each one has actually caught:
 *
 *   - `staticStructuredMask` / `components` — a DOM interface drawn at the same pixel
 *     coordinates in every frame of a pass. Caught leak six (the HUD plaque) after the fact
 *     and refuses it now.
 *   - `balancedAccuracy` — is there one number that sorts the deck? Caught EXIF, file size,
 *     the quantisation-table sum that the file-size fix introduced, and letterbox bars.
 *   - `scanLength`, `dqtSums` — the JPEG header statistics those scores are computed over.
 *   - `flatBorderPx` — uniform bars touching a frame edge, i.e. letterboxing.
 *   - `blackBars` — new here, and it exists because round 1 of the paired instrument found
 *     that three of the twenty-two official Rome II store screenshots are 2.35:1 cinematic
 *     frames with hard 139 px black bars burned into a 16:9 file. `flatBorderPx` would have
 *     caught them *after* they were in a deck; this measures them on the source so a plate
 *     can be windowed or dropped before it ever gets there.
 */

import sharp from 'sharp';
import { readFile, stat } from 'node:fs/promises';

/** Mulberry32, so a seed reproduces a deck exactly. */
export function rng(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// The overlay audit
// ---------------------------------------------------------------------------

export const AUDIT_W = 960;
export const AUDIT_H = 540;
export const AUDIT_N = AUDIT_W * AUDIT_H;
const SD_STATIC = 0.02, GRAD_EDGE = 0.10, MIN_COMPONENT = 40;
/** Refuse at 0.02% of frame — 104 px, four times the worst clean deck and forty times under a HUD. */
export const OVERLAY_REFUSE = 0.0002;

export async function greyOf(file) {
  const { data } = await sharp(file, { failOn: 'none' })
    .resize(AUDIT_W, AUDIT_H, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return Float32Array.from(data, (v) => v / 255);
}

/**
 * Pixels that are simultaneously *static* across a pool and *structured*.
 *
 * Scene content fails the first test; sky and haze fail the second. A DOM interface passes
 * both, because it is drawn at fixed coordinates with hard edges regardless of where the
 * camera is pointing.
 */
export function staticStructuredMask(imgs) {
  const n = imgs.length;
  const mean = new Float32Array(AUDIT_N);
  for (let i = 0; i < AUDIT_N; i++) { let s = 0; for (const im of imgs) s += im[i]; mean[i] = s / n; }
  const mask = new Uint8Array(AUDIT_N);
  for (let y = 1; y < AUDIT_H - 1; y++) {
    for (let x = 1; x < AUDIT_W - 1; x++) {
      const i = y * AUDIT_W + x;
      let s = 0;
      for (const im of imgs) { const d = im[i] - mean[i]; s += d * d; }
      if (Math.sqrt(s / n) >= SD_STATIC) continue;
      if (Math.hypot(mean[i + 1] - mean[i - 1], mean[i + AUDIT_W] - mean[i - AUDIT_W]) > GRAD_EDGE) mask[i] = 1;
    }
  }
  return mask;
}

/** Drop speckle and report the biggest surviving region, so the message can point at it. */
export function components(mask) {
  const seen = new Uint8Array(AUDIT_N);
  const stack = new Int32Array(AUDIT_N);
  let kept = 0, best = 0, bestBox = null;
  for (let s0 = 0; s0 < AUDIT_N; s0++) {
    if (!mask[s0] || seen[s0]) continue;
    let top = 0, count = 0, x0 = AUDIT_W, x1 = -1, y0 = AUDIT_H, y1 = -1;
    stack[top++] = s0; seen[s0] = 1;
    const members = [];
    while (top) {
      const p = stack[--top];
      members.push(p); count++;
      const px = p % AUDIT_W, py = (p / AUDIT_W) | 0;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (px < AUDIT_W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (py > 0 && mask[p - AUDIT_W] && !seen[p - AUDIT_W]) { seen[p - AUDIT_W] = 1; stack[top++] = p - AUDIT_W; }
      if (py < AUDIT_H - 1 && mask[p + AUDIT_W] && !seen[p + AUDIT_W]) { seen[p + AUDIT_W] = 1; stack[top++] = p + AUDIT_W; }
    }
    if (count < MIN_COMPONENT) { for (const p of members) mask[p] = 0; continue; }
    kept += count;
    if (count > best) { best = count; bestBox = [x0, y0, x1, y1]; }
  }
  return { kept, best, bestBox };
}

/**
 * Per-origin exclusive overlay area, given `{ origin, file }` records.
 *
 * An artefact common to the whole deck is symmetric and therefore not a tell, so each
 * origin's mask has every other origin's subtracted before it is measured.
 */
export async function overlayAudit(entries) {
  const origins = [...new Set(entries.map((e) => e.origin))];
  const masks = new Map();
  for (const o of origins) {
    const imgs = [];
    for (const e of entries) if (e.origin === o) imgs.push(await greyOf(e.file));
    masks.set(o, staticStructuredMask(imgs));
  }
  const out = [];
  for (const o of origins) {
    const mine = masks.get(o);
    const excl = new Uint8Array(AUDIT_N);
    for (let i = 0; i < AUDIT_N; i++) {
      if (!mine[i]) continue;
      let shared = false;
      for (const [p, m] of masks) if (p !== o && m[i]) { shared = true; break; }
      if (!shared) excl[i] = 1;
    }
    const { kept, best, bestBox } = components(excl);
    out.push({ origin: o, area: kept / AUDIT_N, largest: best / AUDIT_N, box: bestBox });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Header separability
// ---------------------------------------------------------------------------

export const SEPARABLE_REFUSE = 0.95;
export const SEPARABLE_WARN = 0.85;

/**
 * The true end of the compressed data, found the way an adversary would find it.
 *
 * `lastIndexOf(FF D9)` does not work: tail padding of random bytes contains spurious `FF D9`
 * pairs by chance. Inside an entropy-coded scan a literal `FF` is always stuffed to `FF 00`
 * or is a restart marker, so scanning *forward* from SOS finds the true length every time.
 */
export function scanLength(buf) {
  for (let i = 2; i + 3 < buf.length;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9) return i + 2;
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (marker === 0xda) {
      for (let p = i + 2 + len; p + 1 < buf.length; p++) if (buf[p] === 0xff && buf[p + 1] === 0xd9) return p + 2;
      return buf.length;
    }
    i += 2 + len;
  }
  return buf.length;
}

/** Sum of the first (luma) and second (chroma) quantisation tables, straight from the header. */
export function dqtSums(buf) {
  const out = [];
  for (let i = 2; i + 4 < buf.length && out.length < 2;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break;
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (marker === 0xdb) {
      let p = i + 4;
      const end = i + 2 + len;
      while (p < end && out.length < 2) {
        const prec = buf[p] >> 4;
        p += 1;
        let s = 0;
        for (let k = 0; k < 64; k++) s += prec ? ((buf[p + 2 * k] << 8) | buf[p + 2 * k + 1]) : buf[p + k];
        p += prec ? 128 : 64;
        out.push(s);
      }
    }
    i += 2 + len;
  }
  return out;
}

/**
 * Depth, in pixels, of the uniform bars touching each frame edge — i.e. letterboxing.
 *
 * Flatness alone is not enough: a sky graded vertically has rows constant to within a level.
 * Anchoring every row to the value of the outermost row separates the two — a gradient walks
 * away from its first row immediately, a bar does not.
 */
export async function flatBorderPx(file) {
  const { data, info } = await sharp(file, { failOn: 'none' })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const rowIs = (y, v) => { for (let x = 0; x < w; x++) if (Math.abs(data[y * w + x] - v) > 1) return false; return true; };
  const colIs = (x, v) => { for (let y = 0; y < h; y++) if (Math.abs(data[y * w + x] - v) > 1) return false; return true; };
  let n = 0;
  for (let y = 0, v = data[0]; y < h && rowIs(y, v); y++) n++;
  for (let y = h - 1, v = data[(h - 1) * w]; y >= 0 && rowIs(y, v); y--) n++;
  for (let x = 0, v = data[0]; x < w && colIs(x, v); x++) n++;
  for (let x = w - 1, v = data[w - 1]; x >= 0 && colIs(x, v); x--) n++;
  return n;
}

/**
 * Near-black cinematic bars on a *source* image, in pixels per edge.
 *
 * Distinct from `flatBorderPx` in what it tolerates. A JPEG'd bar is not flat — the DCT
 * leaves it wandering by a few levels and the boundary row bleeds — so an exact-value test
 * measures 0 on a bar that is unmistakable to the eye. This asks the weaker question "is
 * every pixel in this row under `thresh`", which is the question a black bar answers yes to
 * and a dark scene does not.
 *
 * Three of the twenty-two official Rome II store screenshots are 2.35:1 frames delivered in
 * a 16:9 file and carry 139-140 px top and bottom. Two of them are the best siege plates in
 * the set, so the right response is to window them, not to drop them — but a deck that used
 * them raw would be sortable at a glance with no reference to render quality at all.
 */
export async function blackBars(file, thresh = 16) {
  const { data, info } = await sharp(file, { failOn: 'none' })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const rowMax = (y) => { let m = 0; for (let x = 0; x < w; x++) { const v = data[y * w + x]; if (v > m) m = v; } return m; };
  const colMax = (x) => { let m = 0; for (let y = 0; y < h; y++) { const v = data[y * w + x]; if (v > m) m = v; } return m; };
  let top = 0; while (top < h && rowMax(top) < thresh) top++;
  let bottom = 0; while (bottom < h && rowMax(h - 1 - bottom) < thresh) bottom++;
  let left = 0; while (left < w && colMax(left) < thresh) left++;
  let right = 0; while (right < w && colMax(w - 1 - right) < thresh) right++;
  return { top, bottom, left, right, width: w, height: h };
}

/**
 * Balanced accuracy at the best single threshold — (sensitivity+specificity)/2 maximised
 * over every cut point. A constant statistic scores 0.5 and a perfect tell scores 1.0.
 * Does not reward a lopsided deck for guessing the majority label.
 */
export function balancedAccuracy(values, isOurs) {
  const pos = values.filter((_, i) => isOurs[i]);
  const neg = values.filter((_, i) => !isOurs[i]);
  if (!pos.length || !neg.length) return 0.5;
  const cuts = [...new Set(values)].sort((a, b) => a - b);
  let best = 0.5;
  for (const c of cuts) {
    const tpr = pos.filter((v) => v <= c).length / pos.length;
    const tnr = neg.filter((v) => v > c).length / neg.length;
    best = Math.max(best, (tpr + tnr) / 2, ((1 - tpr) + (1 - tnr)) / 2);
  }
  return best;
}

/**
 * Six picture statistics, per frame, reported and never refused.
 *
 * These are not leak detectors. They are the objective half of a round's findings: a grader
 * says "the colour is all in one narrow warm band" and this says how narrow, in a number
 * that the next round can be measured against. Everything here is computed on the *deck
 * output*, i.e. on exactly the pixels the grader sees.
 *
 *   lum          mean Rec.709 luma, 0-1.
 *   p01, p99     1st and 99th percentile luma — the dynamic range actually used, and
 *                whether the top end is clipped.
 *   chroma       mean sRGB saturation (max-min)/max over non-black pixels. The project's
 *                own rubric calls a single narrow band worse than over-saturation, so this
 *                is the number that claim has to be argued in.
 *   hueSpread    circular standard deviation of hue in degrees, weighted by chroma. A frame
 *                whose helmet, shield, skin, ground and sky are all one hue scores near 0;
 *                a frame with red cloaks against bronze against green grass scores high.
 *   edge         mean |gradient| of luma per pixel. Pixel-scale energy — the statistic that
 *                `blind-compare.mjs` calls its leading real separator and cannot equalise.
 *   vignette     mean luma of the central 40% divided by mean luma of the outer ring. A
 *                post-process present on one pool only shows up here and nowhere else in
 *                this battery; the press plates have one and a raw render usually does not.
 */
export async function pictureStats(file) {
  const { data, info } = await sharp(file, { failOn: 'none' })
    .resize(640, null, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  const n = w * h;
  const lum = new Float32Array(n);
  let sumC = 0, nC = 0;
  let sx = 0, sy = 0, sw = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * ch] / 255, g = data[i * ch + 1] / 255, b = data[i * ch + 2] / 255;
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 0.02) {
      const c = (mx - mn) / mx;
      sumC += c; nC++;
      if (c > 0.05) {
        // Hue as an angle, then a chroma-weighted circular mean and spread.
        let hue;
        const d = mx - mn;
        if (mx === r) hue = ((g - b) / d + 6) % 6;
        else if (mx === g) hue = (b - r) / d + 2;
        else hue = (r - g) / d + 4;
        const a = (hue / 6) * 2 * Math.PI;
        sx += Math.cos(a) * d; sy += Math.sin(a) * d; sw += d;
      }
    }
  }
  const sorted = Float32Array.from(lum).sort();
  const R = sw > 0 ? Math.hypot(sx, sy) / sw : 1;
  let edge = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      edge += Math.hypot(lum[i + 1] - lum[i - 1], lum[i + w] - lum[i - w]);
    }
  }
  let inner = 0, ni = 0, outer = 0, no = 0;
  const cx = w / 2, cy = h / 2, rMax = Math.hypot(cx, cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const rr = Math.hypot(x - cx, y - cy) / rMax;
      if (rr < 0.40) { inner += lum[y * w + x]; ni++; }
      else if (rr > 0.80) { outer += lum[y * w + x]; no++; }
    }
  }
  return {
    lum: +(lum.reduce((a, v) => a + v, 0) / n).toFixed(4),
    p01: +sorted[Math.floor(n * 0.01)].toFixed(4),
    p99: +sorted[Math.floor(n * 0.99)].toFixed(4),
    chroma: +(nC ? sumC / nC : 0).toFixed(4),
    // Circular sd in degrees; R near 1 means every chromatic pixel shares one hue.
    hueSpread: +(Math.sqrt(Math.max(0, -2 * Math.log(Math.max(1e-6, R)))) * (180 / Math.PI)).toFixed(1),
    edge: +(edge / ((w - 2) * (h - 2))).toFixed(5),
    vignette: +((inner / Math.max(1, ni)) / Math.max(1e-6, outer / Math.max(1, no))).toFixed(3),
  };
}

/** Byte length on disk, so a caller does not have to import `fs` for one line. */
export const bytesOf = async (f) => (await stat(f)).size;

/** Read helper used by the header statistics. */
export const readBuf = (f) => readFile(f);
