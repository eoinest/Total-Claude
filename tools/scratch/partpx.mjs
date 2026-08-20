#!/usr/bin/env node
/**
 * Part legibility, measured off the rendered pixels rather than reasoned about.
 *
 * Pairs a `--debugparts` frame with the shaded frame of the *same* camera and answers two
 * questions that four rounds of blind grading could not:
 *
 *   1. **Coverage** — what fraction of the machine's own pixels does each part own? A part at
 *      0.2 % is not a part a judge can grade, whatever the geometry says.
 *   2. **Value break** — how far does a part's mean display luminance sit from the mean of the
 *      pixels immediately *around* it? That is what "the claw is invisible against the case"
 *      means numerically, and it is the thing every reference photograph of a legible release
 *      group has in common.
 *
 * Both are read out of the framebuffer, so neither can be flattered by geometry that is correct
 * and occluded — which is the exact failure this machine has repeated.
 *
 *   node tools/mine/partpx.mjs screenshots/eng/parts/bench screenshots/eng/bench
 */
import sharp from 'sharp';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const PARTS = [
  ['Ground', [0.28, 0.28, 0.32]],
  ['Body', [0.10, 0.42, 0.95]],
  ['Arm', [1.00, 0.25, 0.05]],
  ['Slider', [0.10, 0.95, 0.35]],
  ['String', [1.00, 0.95, 0.10]],
  ['Bolt', [1.00, 0.10, 0.55]],
  ['Winch', [0.55, 0.15, 0.95]],
  ['Rope', [0.10, 0.90, 0.95]],
];
// `FRAG_DEBUG` writes straight to `gl_FragColor` with post-processing off, so the value lands in
// the PNG as `c * 255` with no transfer applied — verified by histogramming a frame: Body's
// (0.10, 0.42, 0.95) comes back at (25, 107, 242). Match tightly; a loose threshold silently
// classifies grass as "Ground" and the sky as "String" and every ratio below is then nonsense.
const TARGETS = PARTS.map(([n, c]) => [n, c.map((x) => x * 255)]);
const TOL = 9;

const [partDir, shadeDir] = process.argv.slice(2);
const files = (await readdir(partDir)).filter((f) => f.endsWith('.png')).sort();

const rows = [];
for (const f of files) {
  const pRaw = await sharp(path.join(partDir, f)).raw().toBuffer({ resolveWithObject: true });
  const sPath = path.join(shadeDir, f);
  let sRaw = null;
  try { sRaw = await sharp(sPath).raw().toBuffer({ resolveWithObject: true }); } catch { /* none */ }
  const { data, info } = pRaw;
  const ch = info.channels;
  const n = info.width * info.height;
  const owner = new Int8Array(n).fill(-1);
  const count = new Array(PARTS.length).fill(0);
  const lumSum = new Array(PARTS.length).fill(0);
  for (let i = 0; i < n; i++) {
    const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2];
    let best = -1, bestD = TOL * TOL * 3;
    for (let k = 0; k < TARGETS.length; k++) {
      const t = TARGETS[k][1];
      const d = (r - t[0]) ** 2 + (g - t[1]) ** 2 + (b - t[2]) ** 2;
      if (d < bestD) { bestD = d; best = k; }
    }
    owner[i] = best;
    if (best >= 0) count[best]++;
  }
  const machine = count.reduce((a, b) => a + b, 0);
  // Mean display luminance of each part's pixels in the *shaded* frame, plus the mean of the
  // pixels bordering that part — the value break a judge actually sees.
  const border = new Array(PARTS.length).fill(0);
  const borderSum = new Array(PARTS.length).fill(0);
  if (sRaw) {
    const sd = sRaw.data, sc = sRaw.info.channels, W = info.width, H = info.height;
    const lumAt = (i) => (0.2126 * sd[i * sc] + 0.7152 * sd[i * sc + 1] + 0.0722 * sd[i * sc + 2]) / 255;
    for (let i = 0; i < n; i++) if (owner[i] >= 0) lumSum[owner[i]] += lumAt(i);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (owner[i] >= 0) continue;
        // A background/other pixel touching part k contributes to k's surround.
        const seen = new Set();
        for (const j of [i - 1, i + 1, i - W, i + W]) if (owner[j] >= 0) seen.add(owner[j]);
        for (const k of seen) { border[k]++; borderSum[k] += lumAt(i); }
      }
    }
  }
  rows.push({ f, machine, count, lumSum, border, borderSum });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('view', 22)}${PARTS.map(([n]) => pad(n, 9)).join('')}`);
for (const r of rows) {
  console.log(pad(r.f.replace('.png', ''), 22) +
    r.count.map((c) => pad(((c / r.machine) * 100).toFixed(2) + '%', 9)).join(''));
}
console.log('\nvalue break: |mean part luminance − mean bordering luminance| (display, 0..1)');
console.log(`${pad('view', 22)}${PARTS.map(([n]) => pad(n, 9)).join('')}`);
for (const r of rows) {
  console.log(pad(r.f.replace('.png', ''), 22) +
    r.count.map((c, k) => {
      if (!c || !r.border[k]) return pad('-', 9);
      const a = r.lumSum[k] / c, b = r.borderSum[k] / r.border[k];
      return pad(Math.abs(a - b).toFixed(3), 9);
    }).join(''));
}
console.log('\nmean part luminance (display)');
console.log(`${pad('view', 22)}${PARTS.map(([n]) => pad(n, 9)).join('')}`);
for (const r of rows) {
  console.log(pad(r.f.replace('.png', ''), 22) +
    r.count.map((c, k) => (c ? pad((r.lumSum[k] / c).toFixed(3), 9) : pad('-', 9))).join(''));
}
console.log('\nmachine pixels: ' + rows.map((r) => `${r.f.replace('.png', '')}=${r.machine}`).join('  '));
