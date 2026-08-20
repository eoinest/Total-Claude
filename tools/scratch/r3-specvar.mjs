#!/usr/bin/env node
/**
 * `r3-specvar` — how much two men's shields differ, measured the way the grader read them.
 *
 * The claim this exists to put a number on is a strong one and it is not about the device:
 *
 *   > "You can read the instancing off the highlights alone, without recognising the device.
 *   > Every boss shows the same mirror-white teardrop at the same clock position even on
 *   > shields angled thirty degrees apart."
 *
 * That is a statement about **cross-man variance of one piece's shading**, so it is measured
 * as one. For each of N men drawn from the real per-man hash:
 *
 *   1. Solo the shield piece, so nothing else is in the frame.
 *   2. Crop to the shield's own bounding box and resample to a fixed square. This throws
 *      away translation and scale, which are variation the grader was **not** talking about —
 *      a shield further left is not a shield that looks different — and keeps rotation,
 *      shading and the highlight, which are.
 *   3. Compare every man to every other man.
 *
 * Two numbers, both on luminance in 0..255:
 *
 *   `mad`     mean pairwise mean-absolute-difference over the shield's own pixels. Zero means
 *             the deck could be one shield stamped N times.
 *   `hotMad`  the same, restricted to the brightest decile of the *mean* image — which on a
 *             shield is the boss and the rim. This is the one the claim is about: a board can
 *             differ in its planks and still have an identical glint.
 *
 * Reported per piece, so a scutum and a hoplon are not averaged together.
 *
 * Usage:
 *   node tools/scratch/r3-specvar.mjs --port=5231
 *   node tools/scratch/r3-specvar.mjs --port=5231 --n=16 --unit=legio-cohort --hour=10.4
 */

import { chromium } from 'playwright';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const n = (k, d) => Number(args.get(k) ?? d);
const PORT = n('port', 5231);
const N = n('n', 14);
const HOUR = n('hour', 10.4);
const UNITS = (args.get('units') ?? 'legio-cohort:24,libyan-spearmen:25').split(',');
const BASE = `http://127.0.0.1:${PORT}`;

const alive = await fetch(`${BASE}/viewer.html`).then((r) => r.ok).catch(() => false);
if (!alive) { console.error(`No dev server on ${PORT}.`); process.exit(2); }

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 700, height: 800 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__viewer && window.__viewer.ready === true, null, { timeout: 300000 });
await page.evaluate(() => {
  for (const el of ['viewer-panel', 'viewer-readout', 'viewer-boot']) {
    const q = document.getElementById(el); if (q) q.remove();
  }
  document.body.style.margin = '0';
  const c = document.getElementById('viewer-canvas');
  if (c) { c.style.width = '100vw'; c.style.height = '100vh'; }
  window.dispatchEvent(new Event('resize'));
});

const out = await page.evaluate(async ({ units, count, hour }) => {
  const v = window.__viewer;
  const cv = document.getElementById('viewer-canvas');
  const scratch = document.createElement('canvas');
  const S = 128;                      // the normalised square every shield is resampled into
  const settle = async (k) => { for (let i = 0; i < k; i++) await new Promise((r) => requestAnimationFrame(r)); };

  /**
   * The background, captured once by soloing a piece no man wears.
   *
   * The first version of this found the shield by differencing every pixel against the
   * frame's own corner, which is sky — and the plate's *ground* differs from sky by far more
   * than 26, so the bounding box came back as the whole lower half of the frame for every
   * man and the aspect spread read exactly 0.0000 on a change that had moved it. A
   * difference against the real background is the only test that cannot be fooled by
   * something in the background.
   */
  let BG = null;
  const rawRGB = () => {
    scratch.width = cv.width; scratch.height = cv.height;
    const ctx = scratch.getContext('2d');
    ctx.drawImage(cv, 0, 0);
    return ctx.getImageData(0, 0, cv.width, cv.height).data;
  };

  /** Luminance of the canvas, plus the bounding box of everything that is not background. */
  const grabNormalised = () => {
    scratch.width = cv.width; scratch.height = cv.height;
    const ctx = scratch.getContext('2d');
    ctx.drawImage(cv, 0, 0);
    const w = cv.width, h = cv.height;
    const d = ctx.getImageData(0, 0, w, h).data;
    // Background is the plate's sky and ground; the shield is the only geometry in frame, so
    // "not background" is found by differencing against the frame's own border colour rather
    // than by a colour rule that would have to know the sky.
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    const lum = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        lum[y * w + x] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        const dv = Math.abs(d[i] - BG[i]) + Math.abs(d[i + 1] - BG[i + 1]) + Math.abs(d[i + 2] - BG[i + 2]);
        if (dv > 14) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < x0 || y1 < y0) return null;
    // Nearest-neighbour into the fixed square. Interpolation would smooth exactly the
    // high-frequency highlight edge the statistic is about.
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const sq = new Float32Array(S * S);
    for (let j = 0; j < S; j++) {
      const sy = y0 + Math.floor((j + 0.5) * bh / S);
      for (let i = 0; i < S; i++) {
        const sx = x0 + Math.floor((i + 0.5) * bw / S);
        sq[j * S + i] = lum[sy * w + sx];
      }
    }
    return { sq, bw, bh };
  };

  const result = [];
  for (const spec of units) {
    const [unit, pieceStr] = spec.split(':');
    const piece = Number(pieceStr);
    // Background first: same camera, same light, nothing drawn.
    v.plate({
      unit, hash: 0.5, lod: 0, clip: 'idleAlertReady', phase: 0.32,
      azimuth: -0.95, elevation: 0.05, fill: 0.9, light: 'battle', graded: true,
    });
    v.setHour(hour);
    v.solo(63);
    await settle(32);
    BG = rawRGB();

    const imgs = [];
    for (let k = 0; k < count; k++) {
      const hash = (k + 0.5) / count;
      v.plate({
        unit, hash, lod: 0, clip: 'idleAlertReady', phase: 0.32,
        azimuth: -0.95, elevation: 0.05, fill: 0.9, light: 'battle', graded: true,
      });
      v.setHour(hour);
      v.solo(piece);
      await settle(10);
      const g = grabNormalised();
      if (g) imgs.push(g);
    }
    if (imgs.length < 3) { result.push({ unit, piece, error: 'shield never found in frame' }); continue; }
    // Mean image, to locate the specular decile.
    const mean = new Float32Array(S * S);
    for (const g of imgs) for (let i = 0; i < S * S; i++) mean[i] += g.sq[i] / imgs.length;
    const sorted = Array.from(mean).sort((a, b) => b - a);
    const hotCut = sorted[Math.floor(S * S * 0.10)];
    const hot = [];
    for (let i = 0; i < S * S; i++) if (mean[i] >= hotCut) hot.push(i);

    let mad = 0, hotMad = 0, pairs = 0;
    for (let a = 0; a < imgs.length; a++) {
      for (let b = a + 1; b < imgs.length; b++) {
        let s = 0, sh = 0;
        for (let i = 0; i < S * S; i++) s += Math.abs(imgs[a].sq[i] - imgs[b].sq[i]);
        for (const i of hot) sh += Math.abs(imgs[a].sq[i] - imgs[b].sq[i]);
        mad += s / (S * S); hotMad += sh / hot.length; pairs++;
      }
    }
    // Aspect spread: how much the shield's own on-screen shape varies, which is the rotation
    // half of the story and is thrown away by the crop.
    const ar = imgs.map((g) => g.bw / g.bh);
    const arMean = ar.reduce((a, b) => a + b, 0) / ar.length;
    const arSd = Math.sqrt(ar.reduce((a, b) => a + (b - arMean) ** 2, 0) / ar.length);
    result.push({
      unit, piece, men: imgs.length,
      mad: mad / pairs, hotMad: hotMad / pairs, arSd, arMean,
    });
  }
  return result;
}, { units: UNITS, count: N, hour: HOUR });

console.log(`\nr3-specvar — ${N} men a piece, hour ${HOUR}, luminance 0..255\n`);
console.log('unit                 piece  men    mad   hotMad   aspect SD');
for (const r of out) {
  if (r.error) { console.log(`${r.unit.padEnd(20)} ${String(r.piece).padStart(5)}  ${r.error}`); continue; }
  console.log(
    `${r.unit.padEnd(20)} ${String(r.piece).padStart(5)} ${String(r.men).padStart(4)} ` +
    `${r.mad.toFixed(2).padStart(6)} ${r.hotMad.toFixed(2).padStart(8)}   ${r.arSd.toFixed(4)}`
  );
}
if (errors.length) console.log(`\npage errors:\n  ${errors.slice(0, 4).join('\n  ')}`);
await browser.close();
