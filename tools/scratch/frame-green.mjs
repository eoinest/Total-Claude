#!/usr/bin/env node
/**
 * Scratch: how much of an eye-level frame is vegetation.
 *
 * The most external measure of "grass at the street edge" there is — it counts the pixels the
 * player sees rather than asking any system what it thinks it drew. A pixel is vegetation if
 * its hue is 60-160 degrees, its saturation is over 0.15 and its value is over 0.10; the band
 * is deliberately wide, because the question is not what shade of green it is.
 *
 *   node tools/scratch/frame-green.mjs <dirA> <dirB>
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const dirs = process.argv.slice(2);
if (dirs.length < 1) { console.error('usage: frame-green.mjs <dir> [<dir>...]'); process.exit(2); }

const green = async (file) => {
  const { data, info } = await sharp(file).resize(480, 270, { fit: 'fill' })
    .raw().toBuffer({ resolveWithObject: true });
  let veg = 0;
  let low = 0;
  const n = info.width * info.height;
  for (let i = 0; i < n; i++) {
    const r = data[i * info.channels] / 255;
    const g = data[i * info.channels + 1] / 255;
    const b = data[i * info.channels + 2] / 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const v = mx;
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    let hue = 0;
    if (mx !== mn) {
      if (mx === r) hue = 60 * (((g - b) / (mx - mn)) % 6);
      else if (mx === g) hue = 60 * ((b - r) / (mx - mn) + 2);
      else hue = 60 * ((r - g) / (mx - mn) + 4);
    }
    if (hue < 0) hue += 360;
    const isVeg = hue >= 60 && hue <= 160 && sat > 0.15 && v > 0.10;
    if (isVeg) veg++;
    // The lower third is the ground a standing man is looking at.
    if (i >= n * (2 / 3) && isVeg) low++;
  }
  return { all: (100 * veg) / n, ground: (100 * low) / (n / 3) };
};

const rows = new Map();
for (const d of dirs) {
  for (const f of readdirSync(d).filter((x) => x.endsWith('-00000.jpg'))) {
    const id = f.replace('-00000.jpg', '');
    const r = await green(path.join(d, f));
    if (!rows.has(id)) rows.set(id, {});
    rows.get(id)[d] = r;
  }
}
const head = ['shot', ...dirs.flatMap((d) => [`${path.basename(path.dirname(path.dirname(d)))} all%`, 'ground%'])];
console.log(head.join('\t'));
for (const [id, r] of rows) {
  const cells = dirs.flatMap((d) => (r[d] ? [r[d].all.toFixed(1), r[d].ground.toFixed(1)] : ['-', '-']));
  console.log([id, ...cells].join('\t'));
}
