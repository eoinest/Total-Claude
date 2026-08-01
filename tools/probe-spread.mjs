#!/usr/bin/env node
/**
 * Local luminance spread, in stops, at figure scale — the agreed cross-workstream metric.
 *
 * Blocks, not pixel neighbourhoods, and that is the point of the tool. The anti-aliasing
 * workstream measures a harshness ratio that is explicitly pixel-scale, and its mip and
 * specular filtering is *designed* to reduce high-frequency variance. If contrast inside a
 * crowd were measured as a 3x3 local standard deviation, the two workstreams would cancel on
 * paper while both improved the image. A block of a few tens of pixels sits well above the
 * 1-4 px aliasing scale, so edge filtering does not register here as lost form.
 *
 * Unmasked, because reference plates have no emissive mask available — so it must be run
 * unmasked on BOTH sides to be fair. `probe-lighting.mjs` carries a masked variant for our own
 * frames, where the soldier mask does exist; that one reads about 0.4 stops higher because it
 * sees only figure interiors.
 *
 * What it found, and it inverted the brief it was built to serve. A blind critic estimated by
 * eye that the reference showed roughly 4 stops of intra-figure range against under 1.5 of
 * ours, and a workstream was scoped to close that gap by lifting ambient and carving it back
 * with occlusion. Measured at matched content — crowd interiors cropped from both sides, no
 * sky, no open ground, no wordmark:
 *
 *     32 px blocks     Rome II crowd  1.39 stops      ours  3.64 stops
 *
 * We carry about 2.6x the local contrast of the reference, not a third of it, and the same
 * ordering holds at 16 and 64 px. Controlled for JPEG, which attenuates exactly this signal:
 * re-encoding our lossless crop at q95/q88/q75 moves it by under 2 %, so encoding is not the
 * explanation. It also agrees in sign with the independently built harshness ratio, which puts
 * us at 0.507-0.986 against the plates' 0.057-0.234.
 *
 * The reading that reconciles this with the critics, who are not wrong about what they see: a
 * crowd that reads as a flat mat is not short of contrast, it is short of *coherent* contrast.
 * High-amplitude high-frequency variation reads as noise and texture; the reference gets
 * legible men out of far less range because its variation is smooth across a form — gradients
 * over a helmet bowl, soft shadow terminators, filtered speculars. That is a filtering problem,
 * not an ambient one, and raising ambient to chase the eye estimate would have moved us
 * further from the reference on this measure while the ambient metrics were already in range.
 *
 *   node tools/probe-spread.mjs reference/rome2 screenshots/mine
 */

import sharp from 'sharp';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/**
 * p05..p95 luminance range within each block, averaged over blocks, in stops.
 *
 * The bottom 20 % is cropped by default because the reference plates carry a wordmark there,
 * and everything is resized to a common width so a block covers the same fraction of a figure
 * regardless of source resolution — otherwise a 4K plate and a 1280 frame are being asked
 * different questions by the same number.
 */
async function spread(file, sizes = [16, 32, 64], crop = 0.20) {
  const m0 = await sharp(file).metadata();
  const r = await sharp(file)
    .extract({ left: 0, top: 0, width: m0.width, height: Math.round(m0.height * (1 - crop)) })
    .resize(1280, null, { fit: 'inside' })
    .raw().toBuffer({ resolveWithObject: true });
  const W = r.info.width, H = r.info.height, ch = r.info.channels;
  const lum = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * ch;
    lum[i] = (0.2126 * r.data[o] + 0.7152 * r.data[o + 1] + 0.0722 * r.data[o + 2]) / 255;
  }
  const out = {};
  for (const B of sizes) {
    const st = [];
    for (let by = 0; by + B <= H; by += B) {
      for (let bx = 0; bx + B <= W; bx += B) {
        const v = [];
        for (let y = by; y < by + B; y++) for (let x = bx; x < bx + B; x++) v.push(lum[y * W + x]);
        v.sort((a, b) => a - b);
        const lo = Math.max(1e-4, v[Math.floor(v.length * 0.05)]);
        const hi = Math.max(1e-4, v[Math.floor(v.length * 0.95)]);
        st.push(Math.log2(hi / lo));
      }
    }
    out[B] = st.reduce((a, b) => a + b, 0) / st.length;
  }
  return out;
}

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error('usage: probe-spread.mjs <dir> [dir...]   — mean block spread in stops');
  process.exit(2);
}
for (const d of dirs) {
  const files = (await readdir(d)).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).sort();
  if (!files.length) { console.log(`${d}  (no images)`); continue; }
  const acc = { 16: [], 32: [], 64: [] };
  for (const f of files) {
    const s = await spread(path.join(d, f));
    for (const B of [16, 32, 64]) acc[B].push(s[B]);
  }
  const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`${d}  (${files.length} frames)`);
  for (const B of [16, 32, 64]) {
    const a = acc[B];
    console.log(`   ${String(B).padStart(2)}px  ${m(a).toFixed(2)} stops   [${Math.min(...a).toFixed(2)} - ${Math.max(...a).toFixed(2)}]`);
  }
}
