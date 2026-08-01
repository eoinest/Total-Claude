#!/usr/bin/env node
/**
 * Harshness ratio: pixel-scale Laplacian energy divided by structure-scale Laplacian energy.
 *
 *   harshness = E_lap(full resolution) / E_lap(after a 4x low-pass)
 *
 * The claim under test is that this separates aliased renders from correctly-filtered ones,
 * and that being a ratio makes it immune to the press plates' prior JPEG generation.
 * Both halves of that claim are checked here rather than assumed: `--jpegsweep` re-encodes
 * each input at a range of qualities and reports how the ratio moves.
 *
 * Several readings of "after a 4x low-pass" are plausible and they do not agree, so all of
 * them are computed and printed side by side:
 *
 *   decimate  downsample 4x (area), Laplacian on the small image, RMS per pixel
 *   blurfull  Gaussian sigma ~4/pi at full res, Laplacian at full res, RMS per pixel
 *   dec_up    downsample 4x then bilinear back up, Laplacian at full res
 *
 * Usage:
 *   node tools/probe-harshness.mjs 'reference/rome2/*.jpg' 'screenshots/*.png'
 *   node tools/probe-harshness.mjs --jpegsweep screenshots/melee.png
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

/** Rec.709 luma of a decoded RGB buffer, as Float64 in 0..1. */
function luma(data, w, h, channels) {
  const out = new Float64Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += channels) {
    out[i] = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
  }
  return out;
}

/** RMS of the 4-neighbour discrete Laplacian, interior pixels only. */
function lapRms(img, w, h) {
  let acc = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = 4 * img[i] - img[i - 1] - img[i + 1] - img[i - w] - img[i + w];
      acc += l * l;
      n++;
    }
  }
  return Math.sqrt(acc / n);
}

/** Box-average decimation by an integer factor. */
function decimate(img, w, h, f) {
  const nw = Math.floor(w / f);
  const nh = Math.floor(h / f);
  const out = new Float64Array(nw * nh);
  const inv = 1 / (f * f);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * w + x * f;
        for (let dx = 0; dx < f; dx++) s += img[row + dx];
      }
      out[y * nw + x] = s * inv;
    }
  }
  return { img: out, w: nw, h: nh };
}

/** Nearest-block upsample of a decimated image back to the original grid. */
function upsample(img, w, h, f, ow, oh) {
  const out = new Float64Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / f));
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(w - 1, Math.floor(x / f));
      out[y * ow + x] = img[sy * w + sx];
    }
  }
  return out;
}

/** Separable Gaussian blur in place-safe fashion. */
function gaussian(img, w, h, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp((-i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        s += img[y * w + xx] * k[i + r];
      }
      tmp[y * w + x] = s;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        s += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

/**
 * Decode to a common working size so that a 1728-wide plate and a 2560-wide render are not
 * compared at different pixel densities: the whole measure is scale-relative.
 */
async function load(file, targetH) {
  let pipe = sharp(file).removeAlpha();
  const meta = await sharp(file).metadata();
  if (targetH && meta.height !== targetH) {
    pipe = pipe.resize({ height: targetH, fit: 'inside', kernel: 'lanczos3' });
  }
  const { data, info } = await pipe.raw().toBuffer({ resolveWithObject: true });
  return { img: luma(data, info.width, info.height, info.channels), w: info.width, h: info.height };
}

function measure({ img, w, h }) {
  const full = lapRms(img, w, h);
  const d = decimate(img, w, h, 4);
  const dec = lapRms(d.img, d.w, d.h);
  const up = upsample(d.img, d.w, d.h, 4, w, h);
  const decUp = lapRms(up, w, h);
  const blurred = gaussian(img, w, h, 4 / Math.PI);
  const blurFull = lapRms(blurred, w, h);
  // Structural detail: RMS gradient at the 4x scale, the critic's "structural detail" figure.
  let g = 0;
  let n = 0;
  for (let y = 1; y < d.h - 1; y++) {
    for (let x = 1; x < d.w - 1; x++) {
      const i = y * d.w + x;
      const gx = d.img[i + 1] - d.img[i - 1];
      const gy = d.img[i + d.w] - d.img[i - d.w];
      g += gx * gx + gy * gy;
      n++;
    }
  }
  return {
    full,
    decimate: full / dec,
    dec_up: full / decUp,
    blurfull: full / blurFull,
    structural: Math.sqrt(g / n) * 100,
  };
}

const args = process.argv.slice(2);
const sweep = args.includes('--jpegsweep');
const files = args.filter((a) => !a.startsWith('--'));
const targetH = Number(args.find((a) => a.startsWith('--h='))?.slice(3) ?? 1080);

const expanded = [];
for (const f of files) {
  if (f.includes('*')) {
    const dir = path.dirname(f);
    const pat = new RegExp('^' + path.basename(f).replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
    for (const e of fs.readdirSync(dir).sort()) if (pat.test(e)) expanded.push(path.join(dir, e));
  } else if (fs.statSync(f).isDirectory()) {
    for (const e of fs.readdirSync(f).sort()) {
      if (/\.(png|jpg|jpeg)$/i.test(e)) expanded.push(path.join(f, e));
    }
  } else expanded.push(f);
}

if (sweep) {
  console.log('file                          q     decimate  dec_up  blurfull');
  for (const f of expanded) {
    for (const q of [100, 95, 88, 80, 70, 60, 50]) {
      const buf = await sharp(f).removeAlpha().jpeg({ quality: q }).toBuffer();
      const meta = await sharp(buf).metadata();
      let pipe = sharp(buf);
      if (meta.height !== targetH) pipe = pipe.resize({ height: targetH, fit: 'inside', kernel: 'lanczos3' });
      const { data, info } = await pipe.raw().toBuffer({ resolveWithObject: true });
      const m = measure({ img: luma(data, info.width, info.height, info.channels), w: info.width, h: info.height });
      console.log(
        path.basename(f).padEnd(28),
        String(q).padStart(4),
        m.decimate.toFixed(3).padStart(9),
        m.dec_up.toFixed(3).padStart(7),
        m.blurfull.toFixed(3).padStart(9),
      );
    }
  }
  process.exit(0);
}

console.log('file                                    lapRMS  decimate  dec_up  blurfull  struct');
const rows = [];
for (const f of expanded) {
  const m = measure(await load(f, targetH));
  rows.push({ f, ...m });
  console.log(
    path.basename(path.dirname(f)) + '/' + path.basename(f),
    '',
    (m.full * 100).toFixed(3).padStart(7),
    m.decimate.toFixed(3).padStart(9),
    m.dec_up.toFixed(3).padStart(7),
    m.blurfull.toFixed(3).padStart(9),
    m.structural.toFixed(2).padStart(7),
  );
}
for (const k of ['decimate', 'dec_up', 'blurfull']) {
  const v = rows.map((r) => r[k]).sort((a, b) => a - b);
  console.log(
    `${k.padEnd(9)} min ${v[0].toFixed(3)}  mean ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3)}  max ${v[v.length - 1].toFixed(3)}`,
  );
}
