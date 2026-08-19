#!/usr/bin/env node
/**
 * cf-clip — highlight clipping and tonal spread on isolated-model plates, figure pixels only.
 *
 * Round three's critics recorded "praet-torso blows 6% of the scale area to flat 255". There
 * is no per-piece mask in this harness, so this reports the honest whole-figure proxy: of the
 * pixels inside the figure mask, what fraction has a channel at >= 254 and what fraction is
 * flat white in all three. A blown highlight is detail thrown away, which is exactly the
 * defect the critic named, and it is measurable without the mask the critic had.
 *
 * The mask is deliberately the *same rule* `tools/probe-octave.mjs` uses — corner flood with
 * a local tolerance so a gradient backdrop is followed rather than cut, erode 4 px, then the
 * centred 0.72 x 0.84 ellipse — so the two instruments are reporting on the same pixels.
 *
 *   node tools/scratch/cf-clip.mjs --dirs=screenshots/a,screenshots/b
 */
import sharp from 'sharp';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const dirs = (args.get('dirs') ?? 'screenshots/model').split(',');
const TOL = Number(args.get('tol') ?? 0.02) * 255;
const ERODE = Number(args.get('erode') ?? 4);

function flood(L, w, h, tol) {
  const N = w * h;
  const seen = new Uint8Array(N);
  const st = new Int32Array(N);
  let sp = 0;
  for (const s of [0, w - 1, (h - 1) * w, N - 1]) if (!seen[s]) { seen[s] = 1; st[sp++] = s; }
  while (sp > 0) {
    const i = st[--sp];
    const x = i % w;
    const y = (i / w) | 0;
    const v = L[i];
    const step = (j) => { if (!seen[j] && Math.abs(L[j] - v) <= tol) { seen[j] = 1; st[sp++] = j; } };
    if (x + 1 < w) step(i + 1);
    if (x > 0) step(i - 1);
    if (y + 1 < h) step(i + w);
    if (y > 0) step(i - w);
  }
  return seen;
}

function erode(m, w, h, n) {
  let cur = m;
  for (let p = 0; p < n; p++) {
    const next = cur.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!cur[i]) continue;
      if (!cur[i - 1] || !cur[i + 1] || !cur[i - w] || !cur[i + w]) next[i] = 0;
    }
    cur = next;
  }
  return cur;
}

for (const dir of dirs) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  console.log(`\n${dir}`);
  console.log('plate               cov%   >=254%  flat255%   p99.9    p99    mean');
  let clipSum = 0; let flatSum = 0;
  for (const f of files) {
    const { data, info } = await sharp(path.resolve(dir, f)).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height, N = w * h;
    const L = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      L[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    }
    const bg = flood(L, w, h, TOL);
    const fig = new Uint8Array(N);
    for (let i = 0; i < N; i++) fig[i] = bg[i] ? 0 : 1;
    const figE = erode(fig, w, h, ERODE);
    const cx = (w - 1) / 2, cy = (h - 1) / 2, a = 0.72 * w / 2, bb = 0.84 * h / 2;
    let n = 0, clip = 0, flat = 0, sum = 0;
    const lum = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!figE[i]) continue;
      const dx = (x - cx) / a, dy = (y - cy) / bb;
      if (dx * dx + dy * dy > 1) continue;
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      n++;
      if (Math.max(r, g, b) >= 254) clip++;
      if (r >= 254 && g >= 254 && b >= 254) flat++;
      sum += L[i]; lum.push(L[i]);
    }
    lum.sort((p, q) => p - q);
    const q = (t) => lum[Math.min(lum.length - 1, Math.floor(lum.length * t))] ?? 0;
    clipSum += (clip / n) * 100; flatSum += (flat / n) * 100;
    console.log(`${f.replace('.png', '').padEnd(18)} ${((n / N) * 100).toFixed(1).padStart(5)}`
      + ` ${((clip / n) * 100).toFixed(3).padStart(8)} ${((flat / n) * 100).toFixed(3).padStart(9)}`
      + ` ${q(0.999).toFixed(1).padStart(7)} ${q(0.99).toFixed(1).padStart(6)} ${(sum / n).toFixed(1).padStart(7)}`);
  }
  console.log(`pooled mean  >=254 ${(clipSum / files.length).toFixed(3)}%   flat255 ${(flatSum / files.length).toFixed(3)}%`);
}
