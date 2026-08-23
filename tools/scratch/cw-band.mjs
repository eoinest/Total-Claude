import sharp from 'sharp';

/**
 * Mean luminance of two horizontal bands, for one question: is the ground darker where a
 * man stands on it than it is two metres out.
 *
 * A blind grader named exactly this as the worst remaining fault in the build — "the grass
 * at the foot of every shield is the same value as the grass two metres out" — and quoted
 * the pixel rows. This reads those rows.
 */
async function band(file, y0, y1, x0, x1) {
  const im = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = im.info.width;
  let s = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * W + x) * 3;
      s += 0.2126 * im.data[o] + 0.7152 * im.data[o + 1] + 0.0722 * im.data[o + 2];
      n++;
    }
  }
  return s / n;
}

for (const file of process.argv.slice(2)) {
  const at = await band(file, 885, 935, 300, 1500);
  const out = await band(file, 975, 1010, 300, 1500);
  console.log(file.padEnd(46), 'foot', at.toFixed(1), ' 2m-out', out.toFixed(1),
    ' ratio', (at / out).toFixed(3));
}
