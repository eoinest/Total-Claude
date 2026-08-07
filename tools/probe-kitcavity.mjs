#!/usr/bin/env node
/**
 * Interleaved A/B for the soldier kit cavity gate.
 *
 * Cross-session before/after is not a measurement on this project: two runs at identical
 * configuration and identical shot order differ on 50-70 % of pixels at a mean of 17-27/255.
 * So both arms are shot inside **one** page session by pinning the uniform, and the base arm
 * is re-shot **last** as a drift check — that last shot is the only thing that distinguishes
 * "my change did nothing" from "my arms did not restore".
 *
 * It also checks the arm actually ran. A metalness delta of exactly 0.0000 has been shipped
 * on this project once already because the material already had the value; here, if the
 * uniform handle is missing the probe exits 2 rather than printing a clean-looking zero.
 *
 * Reports three scalars per arm, on the isolated-model plate rather than a battle frame:
 *   harshness      full-res Laplacian RMS / Laplacian RMS after a 4x decimate. Ours 1.137
 *                  against Rome II 0.427 on battle frames. A ratio, so JPEG cancels — but
 *                  it is one blur away from being gamed, so never quote it alone.
 *   blockContrast  mean local RMS contrast over 32 px blocks, x100. Ours 3.64 against Rome
 *                  II 1.39 on battle frames: we carry 2.6x the reference and still read
 *                  flatter, because our variation is albedo rather than shading.
 *   smoothFrac     percentage of 32 px blocks whose Laplacian std is below 1.0. The
 *                  adversarial grader's strongest single scalar: plates 0.31-15.10 %, ours
 *                  0.00-0.05 %, twenty of twenty.
 *
 * Usage: node tools/probe-kitcavity.mjs --port=5199
 */

import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const PORT = Number(args.get('port') ?? 5199);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve(import.meta.dirname, '..', args.get('out') ?? 'screenshots/cavity-ab');
const STRENGTH = Number(args.get('strength') ?? 0.62);

const alive = await fetch(`${BASE}/viewer.html`).then((r) => r.ok).catch(() => false);
if (!alive) { console.error(`No dev server on ${PORT}.`); process.exit(2); }

// --- metrics ----------------------------------------------------------------

const luma = (d, w, h, c) => {
  const o = new Float64Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += c) o[i] = (0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) / 255;
  return o;
};
const lapRms = (img, w, h) => {
  let a = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const l = 4 * img[i] - img[i - 1] - img[i + 1] - img[i - w] - img[i + w];
    a += l * l; n++;
  }
  return Math.sqrt(a / n);
};
const decimate = (img, w, h, f) => {
  const nw = (w / f) | 0, nh = (h / f) | 0, out = new Float64Array(nw * nh), inv = 1 / (f * f);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    let s = 0;
    for (let dy = 0; dy < f; dy++) { const r = (y * f + dy) * w + x * f; for (let dx = 0; dx < f; dx++) s += img[r + dx]; }
    out[y * nw + x] = s * inv;
  }
  return { img: out, w: nw, h: nh };
};
/** Blocks of 32 px: mean local RMS contrast, and the fraction that are smooth. */
function blocks(img, w, h) {
  const B = 32;
  let cAcc = 0, n = 0, smooth = 0;
  for (let by = 0; by + B <= h; by += B) {
    for (let bx = 0; bx + B <= w; bx += B) {
      let s = 0, s2 = 0, ls = 0, ls2 = 0, m = 0;
      for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
        const gx = bx + x, gy = by + y, i = gy * w + gx;
        s += img[i]; s2 += img[i] * img[i];
        if (gx > 0 && gy > 0 && gx < w - 1 && gy < h - 1) {
          const l = (4 * img[i] - img[i - 1] - img[i + 1] - img[i - w] - img[i + w]) * 255;
          ls += l; ls2 += l * l; m++;
        }
      }
      const px = B * B;
      cAcc += Math.sqrt(Math.max(0, s2 / px - (s / px) ** 2)) * 100;
      if (m > 1 && Math.sqrt(Math.max(0, ls2 / m - (ls / m) ** 2)) < 1.0) smooth++;
      n++;
    }
  }
  return { blockContrast: cAcc / n, smoothFrac: (100 * smooth) / n };
}
async function measure(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const y = luma(data, info.width, info.height, info.channels);
  const full = lapRms(y, info.width, info.height);
  const d = decimate(y, info.width, info.height, 4);
  const small = lapRms(d.img, d.w, d.h);
  return { harshness: full / small, ...blocks(y, info.width, info.height) };
}

// --- shoot both arms in one session ----------------------------------------

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__viewer && window.__viewer.ready === true, null, { timeout: 180000 });
await page.evaluate(() => {
  for (const s of ['#viewer-panel', '#viewer-readout', '#viewer-boot']) document.querySelector(s)?.remove();
  const c = document.getElementById('viewer-canvas');
  if (c) { c.style.position = 'absolute'; c.style.inset = '0'; c.style.width = '100%'; c.style.height = '100%'; }
  window.dispatchEvent(new Event('resize'));
});

const SHOTS = [
  { unit: 'legio-cohort', hash: 0.37, az: -0.85, el: 0.05, fill: 0.88, name: 'legio' },
  { unit: 'praetorian-cohort', hash: 0.29, az: -0.5, el: 0.02, fill: 1.9, aimY: 1.25, name: 'praet' },
];
// off, on, off — the trailing base arm is the drift check.
const ARMS = [['off0', 0], ['on', STRENGTH], ['off1', 0]];

const results = {};
let armRan = null;
for (const [armName, value] of ARMS) {
  const ok = await page.evaluate((v) => window.__viewer.setCavity(v), value);
  if (armRan === null) armRan = ok;
  if (!ok) {
    console.error('REFUSED: __viewer.setCavity returned false — the uniform handle is missing,');
    console.error('so this arm never ran and any delta printed would be zero for the wrong reason.');
    await browser.close();
    process.exit(2);
  }
  for (const s of SHOTS) {
    await page.evaluate((spec) => {
      window.__viewer.plate({
        unit: spec.unit, hash: spec.hash, lod: 0, clip: 'idleAlertReady', phase: 0.32,
        azimuth: spec.az, elevation: spec.el, fill: spec.fill, aimY: spec.aimY,
      });
    }, s);
    // `plate` rebuilds the man; re-pin, because a rebuilt material set loses the pin.
    await page.evaluate((v) => window.__viewer.setCavity(v), value);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
    const file = path.join(OUT, `${s.name}-${armName}.png`);
    await page.screenshot({ path: file, type: 'png' });
    results[`${s.name}-${armName}`] = await measure(file);
  }
}
await browser.close();

console.log(`\nkit cavity A/B — interleaved, one session, strength ${STRENGTH}\n`);
console.log('shot                harshness   blockContrast   smoothFrac%');
console.log('-'.repeat(62));
for (const k of Object.keys(results)) {
  const r = results[k];
  console.log(`${k.padEnd(18)} ${r.harshness.toFixed(4).padStart(9)} ${r.blockContrast.toFixed(3).padStart(15)} ${r.smoothFrac.toFixed(2).padStart(13)}`);
}
console.log('-'.repeat(62));
for (const s of SHOTS) {
  const a = results[`${s.name}-off0`], b = results[`${s.name}-on`], c = results[`${s.name}-off1`];
  const drift = Math.abs(a.harshness - c.harshness);
  console.log(
    `${s.name}: harshness ${a.harshness.toFixed(4)} -> ${b.harshness.toFixed(4)} ` +
    `(${((b.harshness / a.harshness - 1) * 100).toFixed(1)}%)  ` +
    `block ${a.blockContrast.toFixed(3)} -> ${b.blockContrast.toFixed(3)}  ` +
    `smooth ${a.smoothFrac.toFixed(2)} -> ${b.smoothFrac.toFixed(2)}`
  );
  console.log(`      drift check (off shot twice): harshness ${drift.toFixed(5)} — anything near the delta invalidates the run`);
}
if (errors.length) {
  console.error(`\n${errors.length} page error(s):`);
  for (const e of [...new Set(errors)].slice(0, 6)) console.error(`  ${e}`);
  process.exit(1);
}
