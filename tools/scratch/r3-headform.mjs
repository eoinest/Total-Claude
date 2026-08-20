#!/usr/bin/env node
/**
 * `r3-headform` — the head statistic round three is measured on, and nothing else.
 *
 * Round one and round two both had a grader write down "the head is a box with a face painted
 * on it". A previous pass answered that by unburying the nose (`07d766b`), and the graders
 * said it again. So the question this probe exists to settle is not "is there a nose" — the
 * source says there is — but **does the head have form a camera can see**, at the sizes a
 * grader judges at, under the light the game ships.
 *
 * `silhouette excursion` — the head's own outline against sky, as a shape.
 * Take the outermost non-sky column of the head on each side, row by row, from the crown down
 * to the jaw. Report the **peak-to-peak excursion of that edge as a percentage of the head's
 * own width**, and the mean |second difference| along it in pixels. The grader's complaint is
 * literally "the silhouette against sky is a straight vertical edge": a lathe scores near zero
 * on both because a lathe *is* a straight vertical edge, and a skull with a temple, a
 * zygomatic arch and a jaw angle does not.
 *
 * Normalising by head width is what makes the number comparable across a change that also
 * moves the framing, and taking it per side is what keeps a three-quarter view honest.
 *
 * The sweep over sun hour is not decoration. A shaded silhouette is found by "this pixel is
 * not sky", so a sun behind the man merges his edge into the haze and a sun in front blows it
 * out; reporting one hour would be measuring the light. Three hours, three azimuths, nine
 * frames, and the mean is the statistic.
 *
 * Usage:
 *   node tools/scratch/r3-headform.mjs --port=5231
 *   node tools/scratch/r3-headform.mjs --port=5231 --unit=legio-cohort --hash=0.37
 *   node tools/scratch/r3-headform.mjs --port=5231 --save=/tmp/r3-head
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const PORT = Number(args.get('port') ?? 5231);
const UNIT = args.get('unit') ?? 'juthungi-warband';
const HASH = Number(args.get('hash') ?? 0.61);
const FILL = Number(args.get('fill') ?? 3.2);
const SAVE = args.get('save') ?? null;
const BASE = `http://127.0.0.1:${PORT}`;
const W = 900, H = 1100, DPR = 2;

const AZIMUTHS = [
  { name: 'front', az: 0.0 },
  { name: 'threeq', az: 0.62 },
  { name: 'profile', az: 1.45 },
];
/** Hours chosen for sun elevation: a raking sun, a mid-morning sun and a high one. */
const HOURS = [7.4, 9.6, 12.4];

const alive = await fetch(`${BASE}/viewer.html`).then((r) => r.ok).catch(() => false);
if (!alive) { console.error(`No dev server on ${PORT}.`); process.exit(2); }

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__viewer && window.__viewer.ready === true, null, { timeout: 300000 });
await page.evaluate(() => {
  for (const el of ['viewer-panel', 'viewer-readout', 'viewer-boot']) {
    const n = document.getElementById(el); if (n) n.remove();
  }
  document.body.style.margin = '0';
  const c = document.getElementById('viewer-canvas');
  if (c) { c.style.width = '100vw'; c.style.height = '100vh'; }
  window.dispatchEvent(new Event('resize'));
});

const stats = await page.evaluate(async ({ unit, hash, azimuths, hours, fill }) => {
  const v = window.__viewer;
  const cv = document.getElementById('viewer-canvas');
  const scratch = document.createElement('canvas');
  const settle = async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); };

  /**
   * Sky, and only sky. The plate background is the game's own sky dome, so a sky pixel is
   * blue-dominant and bright; skin, iron, hair and wool are none of those. The test is
   * deliberately conservative — a false "not sky" on a haze pixel only widens the head by a
   * column and cannot manufacture *curvature*, which is what the statistic reads.
   */
  const isSky = (d, i) => {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    return b > r + 6 && b > 70 && Math.abs(g - (r + b) / 2) < 42;
  };

  /**
   * Centre-out, not edge-in.
   *
   * The first version of this scanned each row from the frame edge inward, and on the
   * Juthungi plate that found the man's own spear at x = 0 and reported a head 1,799 px wide
   * in an 1,800 px frame. A head plate is framed *on the head*, so the head owns the centre
   * column by construction: walk out from it until the first sky pixel and stop. A spear
   * across the corner cannot be reached, and neither can the shoulder.
   */
  const measure = () => {
    scratch.width = cv.width; scratch.height = cv.height;
    const ctx = scratch.getContext('2d');
    ctx.drawImage(cv, 0, 0);
    const { data: d, width: w, height: h } = ctx.getImageData(0, 0, cv.width, cv.height);
    const cx = Math.floor(w / 2);
    const sky = (x, y) => isSky(d, (y * w + x) * 4);
    // The crown: the first row whose centre column is not sky. Only the centre is consulted,
    // for the reason above.
    let top = -1;
    for (let y = 0; y < h; y++) if (!sky(cx, y)) { top = y; break; }
    if (top < 0) return null;
    // Crown to jaw. A head is about 0.23 m of a 1.9 m man, and `fill` puts the man at `fill`
    // frame heights, so the head owns `0.23 / 1.9 * fill` of the frame — 39 % at fill 3.2.
    const band = Math.round(h * 0.36);
    const left = [], right = [];
    for (let y = top + 8; y < Math.min(h, top + band); y++) {
      if (sky(cx, y)) break;              // the head ended; do not walk onto the background
      let l = cx, r = cx;
      while (l > 0 && !sky(l - 1, y)) l--;
      while (r < w - 1 && !sky(r + 1, y)) r++;
      if (l === 0 || r === w - 1) continue;   // touched the frame: not a silhouette
      left.push(l); right.push(r);
    }
    if (left.length < 24) return null;
    const stat = (arr) => {
      const n = arr.length;
      // Five-tap smooth first, so a single aliased pixel cannot manufacture curvature.
      const s = arr.map((_, i) => {
        let a = 0, c = 0;
        for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < n) { a += arr[j]; c++; } }
        return a / c;
      });
      let d2 = 0;
      for (let i = 1; i < n - 1; i++) d2 += Math.abs(s[i - 1] - 2 * s[i] + s[i + 1]);
      return { p2p: Math.max(...s) - Math.min(...s), d2: d2 / Math.max(1, n - 2) };
    };
    const mid = Math.floor(left.length / 2);
    return { rows: left.length, width: right[mid] - left[mid], L: stat(left), R: stat(right) };
  };

  const out = [];
  for (const a of azimuths) {
    for (const hr of hours) {
      v.plate({
        unit, hash, lod: 0, clip: 'idleAlertReady', phase: 0.32,
        azimuth: a.az, elevation: 0.055, fill, aimY: 1.62, light: 'battle', graded: true,
      });
      v.setHour(hr);
      // `LightingSystem` re-patches materials on a sixteen-frame timer; a plate taken two
      // frames after a switch photographs an unpatched material at four times the exposure.
      await settle(30);
      out.push({ az: a.name, hour: hr, m: measure() });
    }
  }
  return out;
}, { unit: UNIT, hash: HASH, azimuths: AZIMUTHS, hours: HOURS, fill: FILL });

console.log(`\nr3-headform — ${UNIT} hash ${HASH}, fill ${FILL}\n`);
console.log('az        hour   headpx   excursion L/R (px)   |d2| L/R (px)');
const rows = [];
for (const s of stats) {
  if (!s.m) { console.log(`${s.az.padEnd(9)} ${String(s.hour).padEnd(6)} (no head found)`); continue; }
  const m = s.m;
  rows.push({ ...s, ...m });
  console.log(
    `${s.az.padEnd(9)} ${String(s.hour).padEnd(6)} ${String(m.width).padStart(5)}    ` +
    `${m.L.p2p.toFixed(1).padStart(6)}/${m.R.p2p.toFixed(1).padEnd(6)}      ` +
    `${m.L.d2.toFixed(3).padStart(6)}/${m.R.d2.toFixed(3)}`
  );
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const p2pPct = rows.map((t) => ((t.L.p2p + t.R.p2p) / 2 / Math.max(1, t.width)) * 100);
const d2 = rows.map((t) => (t.L.d2 + t.R.d2) / 2);
const px = rows.map((t) => t.width);
console.log(`\nhead width, mean:            ${mean(px).toFixed(0)} px  (the grader asked for 200+)`);
console.log(`silhouette excursion, mean:  ${mean(p2pPct).toFixed(2)} % of head width`);
console.log(`silhouette |d2|,      mean:  ${mean(d2).toFixed(4)} px`);

if (SAVE) {
  await mkdir(SAVE, { recursive: true });
  for (const a of AZIMUTHS) {
    for (const hr of HOURS) {
      await page.evaluate(async ({ unit, hash, az, hr, fill }) => {
        const v = window.__viewer;
        v.plate({
          unit, hash, lod: 0, clip: 'idleAlertReady', phase: 0.32,
          azimuth: az, elevation: 0.055, fill, aimY: 1.62, light: 'battle', graded: true,
        });
        v.setHour(hr);
        for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r));
      }, { unit: UNIT, hash: HASH, az: a.az, hr, fill: FILL });
      await writeFile(`${SAVE}/${a.name}-${String(hr).replace('.', 'p')}.png`, await page.screenshot({ type: 'png' }));
    }
  }
  console.log(`\nplates → ${SAVE}`);
}
if (errors.length) console.log(`\npage errors:\n  ${errors.slice(0, 6).join('\n  ')}`);
await browser.close();
