#!/usr/bin/env node
/**
 * **The picture.** The river the map used to draw and the river it draws now, both laid on the
 * plate they are supposed to agree with, in the plate's own frame.
 *
 * Nothing is projected into a screenshot and nothing is eyeballed against a description: the
 * engine's channel is un-projected back into survey metres through the same affine
 * `src/city/overlay.ts` publishes, and drawn on the raster. If the new line is not in Lanciani's
 * inked channel, that is visible in one look and no residual is needed.
 *
 *   red     the twelve-knot Fritsch-Carlson spline this pass replaces, centreline
 *   orange  the twelve control points it was built from
 *   cyan    the authored channel's two banks
 *   yellow  the authored centreline
 *   magenta the Tiber Island
 *
 *   node tools/scratch/tiber-overlay.mjs
 */
import sharp from 'sharp';
import fs from 'node:fs';
import { surveyToPx, surveyOfLatLon, worldOf, surveyOf, KX, KZ } from './tiber-plate.mjs';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const PLATE = arg('plate', 'lanciani');
const PX = Number(arg('px', 880)), PY = Number(arg('py', 250));
const PW = Number(arg('pw', 1250)), PH = Number(arg('ph', 1700));
const OUTW = Number(arg('w', 1100));
const OUT = arg('out', `screenshots/tiber/overlay-${PLATE}.png`);

const SRC = {
  lanciani: 'reference/rome-plans/lanciani-georef-EPSG3004-2307658_4638583_2314671_4643263-4096px.png',
  ortho: 'reference/rome-plans/agea-2012-ortofoto-EPSG3004-2307658_4638583_2314671_4643263-4096px.jpg',
};
/**
 * The crop may run north of the main plate, where the three WMS tiles fetched this pass carry
 * the ground; `py' = py - 4095` is the same pixel grid. Sampling per pixel rather than
 * `extract`ing keeps one code path for both.
 */
const rgb = Buffer.alloc(PW * PH * 3, 26);
{
  const load = async (f) => { const r = await sharp(f).raw().toBuffer({ resolveWithObject: true }); return { d: r.data, w: r.info.width, h: r.info.height, c: r.info.channels }; };
  const main = await load(SRC[PLATE]);
  const north = PLATE === 'ortho' && PY < 0
    ? await load('reference/rome-plans/agea-2012-ortofoto-EPSG3004-north-mosaic-4096x4095.jpg') : null;
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const gx = PX + x, gy = PY + y;
    let src = null, sx = gx, sy = gy;
    if (gy >= 0 && gy < main.h && gx >= 0 && gx < main.w) src = main;
    else if (north && gy + 4095 >= 0 && gy + 4095 < north.h && gx >= 0 && gx < north.w) { src = north; sy = gy + 4095; }
    if (!src) continue;
    const i = (sy * src.w + sx) * src.c, o = (y * PW + x) * 3;
    rgb[o] = src.d[i]; rgb[o + 1] = src.d[i + 1]; rgb[o + 2] = src.d[i + 2];
  }
}
const put = (e, n, col, rad = 1) => {
  const p = surveyToPx(e, n);
  const x0 = Math.round(p.px) - PX, y0 = Math.round(p.py) - PY;
  for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
    const x = x0 + dx, y = y0 + dy;
    if (x < 0 || y < 0 || x >= PW || y >= PH) continue;
    const o = (y * PW + x) * 3; rgb[o] = col[0]; rgb[o + 1] = col[1]; rgb[o + 2] = col[2];
  }
};
const stroke = (pts, col, rad = 1) => {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.e - a.e, b.n - a.n) / 1.2));
    for (let t = 0; t <= steps; t++) put(a.e + (b.e - a.e) * (t / steps), a.n + (b.n - a.n) * (t / steps), col, rad);
  }
};

// ------------------------------------------------------------------ the OLD twelve-knot spline
/**
 * Re-derived here rather than imported, because it no longer exists in `src/`. These are the
 * exact twelve world-metre knots `topography.ts` carried at `bc2e0f2`, and the exact cubic
 * Hermite with Fritsch-Carlson limited tangents it evaluated them with.
 */
const OLD_PATH = [
  -526.37, -796.55, -269.43, -415.37, -159.31, -96.42, -115.26, 175.85,
  -93.24, 448.12, -74.89, 751.51, -287.78, 903.21, -379.54, 1089.91,
  -159.31, 1226.05, 127.00, 1323.29, 60.93, 1653.91, -85.90, 2120.66,
];
const oldCentre = (() => {
  const n = OLD_PATH.length / 2;
  const kx = [], kz = [];
  for (let i = 0; i < n; i++) { kx.push(OLD_PATH[i * 2]); kz.push(OLD_PATH[i * 2 + 1]); }
  const sec = [];
  for (let i = 0; i < n - 1; i++) sec.push((kx[i + 1] - kx[i]) / (kz[i + 1] - kz[i]));
  const m = new Array(n).fill(0);
  m[0] = sec[0]; m[n - 1] = sec[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (sec[i - 1] * sec[i] <= 0) { m[i] = 0; continue; }
    const t = (kx[i + 1] - kx[i - 1]) / (kz[i + 1] - kz[i - 1]);
    const cap = 3 * Math.min(Math.abs(sec[i - 1]), Math.abs(sec[i]));
    m[i] = Math.sign(t) * Math.min(Math.abs(t), cap);
  }
  return (z) => {
    if (z <= kz[0]) return kx[0] + m[0] * (z - kz[0]);
    if (z >= kz[n - 1]) return kx[n - 1] + m[n - 1] * (z - kz[n - 1]);
    let s = 0;
    while (s < n - 2 && kz[s + 1] < z) s++;
    const h = kz[s + 1] - kz[s];
    const t = (z - kz[s]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * kx[s] + (t3 - 2 * t2 + t) * h * m[s]
      + (-2 * t3 + 3 * t2) * kx[s + 1] + (t3 - t2) * h * m[s + 1];
  };
})();

// ------------------------------------------------------------------ the authored channel
const src = fs.readFileSync('src/terrain/tiberSurvey.ts', 'utf8');
const rows = [...src.matchAll(/^ {2}\[(-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\],$/gm)]
  .map((m2) => ({ e: +m2[1], n: +m2[2], w: +m2[3] }));
if (!rows.length) throw new Error('could not parse TIBER_SURVEY');
const island = /e: (-?\d+),\s*\n\s*n: (-?\d+),\s*\n\s*\/\*\* Real plan, metres\. \*\/\s*\n\s*lengthM: (\d+),\s*\n\s*widthM: (\d+),[\s\S]*?bearingDeg: (\d+),/.exec(src);

// banks: offset the polyline perpendicular by half the width, which is the |d| = half isoline
const bankOf = (side) => rows.map((r, i) => {
  const a = rows[Math.max(0, i - 1)], b = rows[Math.min(rows.length - 1, i + 1)];
  const de = b.e - a.e, dn = b.n - a.n, L = Math.hypot(de, dn) || 1;
  return { e: r.e + side * (-dn / L) * r.w * 0.5, n: r.n + side * (de / L) * r.w * 0.5 };
});

// ------------------------------------------------------------------ draw
// old centreline: sample by world z, convert back to survey metres
{
  const pts = [];
  for (let z = -1500; z <= 2150; z += 4) {
    const x = oldCentre(z);
    pts.push(surveyOf(x, z));
  }
  stroke(pts, [235, 40, 40], 1);
}
for (let i = 0; i < OLD_PATH.length; i += 2) {
  const s = surveyOf(OLD_PATH[i], OLD_PATH[i + 1]);
  put(s.e, s.n, [255, 150, 0], 4);
}
stroke(bankOf(-1), [0, 230, 255], 1);
stroke(bankOf(+1), [0, 230, 255], 1);
stroke(rows, [255, 235, 0], 1);
if (island) {
  const [, ie, inn, ilen, iwid, ibear] = island.map(Number);
  const rad = (ibear * Math.PI) / 180;
  const ring = [];
  for (let a = 0; a <= 360; a += 6) {
    const t = (a * Math.PI) / 180;
    const u = Math.cos(t) * ilen * 0.5, v = Math.sin(t) * iwid * 0.5;
    ring.push({ e: ie + u * Math.sin(rad) + v * Math.cos(rad), n: inn + u * Math.cos(rad) - v * Math.sin(rad) });
  }
  stroke(ring, [255, 0, 255], 1);
}
// the map's own edges, so the owner can see what is on the battlefield
for (const z of [-1400, 1400]) {
  const pts = [];
  for (let x = -1400; x <= 1400; x += 20) pts.push(surveyOf(x, z));
  stroke(pts, [90, 90, 90], 0);
}
for (const x of [-1400, 1400]) {
  const pts = [];
  for (let z = -1400; z <= 1400; z += 20) pts.push(surveyOf(x, z));
  stroke(pts, [90, 90, 90], 0);
}

await sharp(rgb, { raw: { width: PW, height: PH, channels: 3 } }).resize(OUTW).png().toFile(OUT);
console.log(`wrote ${OUT}  (${rows.length} authored stations)`);
