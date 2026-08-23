import sharp from 'sharp';
// High-frequency RMS inside a box: how much of the signal is per-pixel noise rather than shading.
const box = [132, 650, 176, 720];   // the shield face the critic measured, corner.png
async function hf(file, b) {
  const im = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = im.info.width;
  const L = (x, y) => {
    const o = (y * W + x) * 3;
    return 0.2126 * im.data[o] + 0.7152 * im.data[o + 1] + 0.0722 * im.data[o + 2];
  };
  let n = 0, s2 = 0, mn = 255;
  for (let y = b[1] + 1; y < b[3] - 1; y++) for (let x = b[0] + 1; x < b[2] - 1; x++) {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m += L(x + dx, y + dy);
    m /= 9;
    const d = L(x, y) - m;
    s2 += d * d; n++;
    if (L(x, y) < mn) mn = L(x, y);
  }
  return { hfRMS: Math.sqrt(s2 / n).toFixed(2), min: mn.toFixed(1) };
}
for (const f of process.argv.slice(2)) console.log(f.padEnd(52), JSON.stringify(await hf(f, box)));
