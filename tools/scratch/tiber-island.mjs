#!/usr/bin/env node
/**
 * **The Tiber Island, digitised as a hole in the water.**
 *
 * The generic bar detector in `tiber-digitise.mjs` found *a* bar at roughly the right northing
 * and got its shape wrong — 112 x 93 m against a published 270 x 67 — because it takes the widest
 * land gap on one perpendicular and the island's arms are not symmetric about the course. The
 * island is the most recognisable single object on any plan of Rome, so it gets its own
 * measurement: close the water gate over a 700 m box, find the land component that the water
 * completely encloses, and trace it.
 *
 * The close is radius 12 px (21 m), which is what it takes to carry the gate across the four
 * bridges that land on the island — Fabricio and Cestio, which are ancient and still standing,
 * plus Garibaldi and Palatino. Without it the two arms are not connected round either end and
 * the island is not a hole.
 *
 *   node tools/scratch/tiber-island.mjs
 */
import sharp from 'sharp';
import fs from 'node:fs';
import { pxToSurvey, surveyToPx, M_PER_PX, worldOf, KX, KZ } from './tiber-plate.mjs';
import { loadVirtual } from './tiber-raster.mjs';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const CE = Number(arg('e', -365));      // survey.ts's Insula Tiberina row, used only to centre the box
const CN = Number(arg('n', -189));
const HALF = Number(arg('half', 420));  // metres
const CLOSE_R = Number(arg('close', 12));

const c = surveyToPx(CE, CN);
const R = Math.ceil(HALF / M_PER_PX);
const X0 = Math.round(c.px) - R, Y0 = Math.round(c.py) - R;
const W = 2 * R + 1, H = 2 * R + 1;

/**
 * A **local** gate with the luminance floor dropped from 78 to 26.
 *
 * The standard gate does not see the island's north-east arm at all. That arm runs at the foot
 * of the Campus Martius bank under the Lungotevere's plane trees and the 18 m *muraglioni*, and
 * in a mid-morning flight it is in full shadow: smooth and green, but at a luminance of 30-60.
 * The global gate cannot be loosened that far without admitting every shaded courtyard in the
 * historic centre — but inside a 840 m box centred on the island, connectivity does the work the
 * luminance floor was doing, so the floor can go. This is the one place on the course where the
 * measurement needs a local exception, and it is written down rather than folded into the global
 * thresholds, because a threshold loosened globally to fix one place is how a gate stops meaning
 * anything.
 */
const MAIN = 'reference/rome-plans/agea-2012-ortofoto-EPSG3004-2307658_4638583_2314671_4643263-4096px.jpg';
const LUM_FLOOR = Number(arg('lumlo', 26));
const water = new Uint8Array(W * H);
{
  const { data, info } = await sharp(MAIN)
    .extract({ left: X0 - 4, top: Y0 - 4, width: W + 8, height: H + 8 }).raw().toBuffer({ resolveWithObject: true });
  const w2 = info.width, c2 = info.channels;
  const idx = (x, y) => (y * w2 + x) * c2;
  const mR = new Float32Array(w2 * info.height), mG = new Float32Array(w2 * info.height), mB = new Float32Array(w2 * info.height);
  for (let y = 1; y < info.height - 1; y++) for (let x = 1; x < w2 - 1; x++) {
    let a = 0, b = 0, d = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const i = idx(x + dx, y + dy); a += data[i]; b += data[i + 1]; d += data[i + 2]; }
    const k = y * w2 + x; mR[k] = a / 9; mG[k] = b / 9; mB[k] = d / 9;
  }
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const gx = x + 4, gy = y + 4, k = gy * w2 + gx;
    const lum = (mR[k] + mG[k] + mB[k]) / 3;
    if (lum < LUM_FLOOR || lum > 168) continue;
    if (mG[k] - mR[k] < 2 || mG[k] - mB[k] < 2) continue;
    let s = 0, cc = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const i = idx(gx + dx, gy + dy);
      s += Math.abs(data[i] - mR[k]) + Math.abs(data[i + 1] - mG[k]) + Math.abs(data[i + 2] - mB[k]); cc++;
    }
    if (s / cc > 34) continue;
    water[y * W + x] = 1; n++;
  }
  console.error(`local gate (lum >= ${LUM_FLOOR}): ${n} water px in the ${(2 * HALF).toFixed(0)} m box`);
}

/**
 * **An island is land with the river on both sides of it**, so test exactly that rather than
 * looking for a hole in the water.
 *
 * Hole-finding failed here and the reason is worth keeping: the four bridge decks that land on
 * the Tiber Island are opaque, so the island's land is 4-connected to both banks through them,
 * and closing the water across a 24 m deck (Ponte Garibaldi) at the same time as keeping the
 * island's own 60 m separate needs a structuring element that does not exist. The local test
 * has no such problem: a pixel is island if, along the channel's own perpendicular at that
 * point, gated water lies within `--armreach` metres on *both* sides.
 */
const course = JSON.parse(fs.readFileSync('tools/scratch/tiber-course.json', 'utf8')).course;
const nearestTangent = (e, n) => {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < course.length; i++) {
    const d = (course[i][0] - e) ** 2 + (course[i][1] - n) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  const a = course[Math.max(0, bi - 4)], b = course[Math.min(course.length - 1, bi + 4)];
  const de = b[0] - a[0], dn = b[1] - a[1], L = Math.hypot(de, dn) || 1;
  return [-dn / L, de / L];   // the perpendicular
};
/**
 * Sweep the course across the island reach and measure the **bar** — the land gap between the
 * two arms on each perpendicular. Length is the run of stations that have one; width is the
 * gap. This is the measurement that works: it needs neither connectivity (defeated by four
 * opaque bridge decks) nor a both-sides test (which captures the quays and made the island
 * 136 m wide against a published 67).
 */
const gateLocal = (e, n) => {
  const p = surveyToPx(e, n);
  const gx = Math.round(p.px) - X0, gy = Math.round(p.py) - Y0;
  if (gx < 0 || gy < 0 || gx >= W || gy >= H) return -1;
  return water[gy * W + gx];
};
const REACH = Number(arg('reach', 220));
const bars = [];
for (let i = 0; i < course.length; i++) {
  const [e0, n0] = course[i];
  if (Math.hypot(e0 - CE, n0 - CN) > 420) continue;
  const a = course[Math.max(0, i - 4)], b = course[Math.min(course.length - 1, i + 4)];
  const de = b[0] - a[0], dn = b[1] - a[1], L = Math.hypot(de, dn) || 1;
  const pe = -dn / L, pn = de / L;
  const N = Math.round(REACH / M_PER_PX);
  const cls = new Int8Array(2 * N + 1);
  for (let t = -N; t <= N; t++) cls[t + N] = gateLocal(e0 + pe * t * M_PER_PX, n0 + pn * t * M_PER_PX);
  for (let t = 1; t < 2 * N; t++) if (cls[t] === 0 && cls[t - 1] === 1 && cls[t + 1] === 1) cls[t] = 1;
  // runs of water at least 12 m wide
  const runs = [];
  let t = 0;
  while (t <= 2 * N) {
    if (cls[t] !== 1) { t++; continue; }
    const s0 = t; while (t <= 2 * N && cls[t] === 1) t++;
    if ((t - s0) * M_PER_PX >= 12) runs.push([(s0 - N) * M_PER_PX, (t - 1 - N) * M_PER_PX]);
  }
  // a bar is a land gap of 25-160 m between two arms, straddling or near the course
  for (let k = 0; k + 1 < runs.length; k++) {
    const g0 = runs[k][1], g1 = runs[k + 1][0];
    const gap = g1 - g0;
    if (gap < 25 || gap > 170) continue;
    if (Math.min(Math.abs(g0), Math.abs(g1)) > 150) continue;
    bars.push({
      i, gap,
      ae: e0 + pe * g0, an: n0 + pn * g0,
      be: e0 + pe * g1, bn: n0 + pn * g1,
      ce: e0 + pe * (g0 + g1) / 2, cn: n0 + pn * (g0 + g1) / 2,
    });
    break;
  }
}
console.error(`bar stations across the island reach: ${bars.length}`);
// Keep the longest contiguous run. Isolated bars elsewhere in the reach are the quays and the
// moored barges at Ripa Grande, not islands, and they inflated the length to 1 043 m.
{
  const groups = [];
  let cur = [bars[0]];
  for (let k = 1; k < bars.length; k++) {
    if (bars[k].i - cur[cur.length - 1].i <= 3) cur.push(bars[k]);
    else { groups.push(cur); cur = [bars[k]]; }
  }
  groups.push(cur);
  groups.sort((a, b) => b.length - a.length);
  console.error(`contiguous bar groups: ${groups.map((g) => g.length).slice(0, 6).join(', ')}`);
  bars.length = 0;
  for (const b of groups[0]) bars.push(b);
}
if (bars.length < 5) throw new Error('too few bar stations');
let len = 0;
for (let k = 0; k + 1 < bars.length; k++) len += Math.hypot(bars[k + 1].ce - bars[k].ce, bars[k + 1].cn - bars[k].cn);
const gaps = bars.map((b) => b.gap).sort((x, y) => x - y);
const cx = bars.reduce((s2, b) => s2 + b.ce, 0) / bars.length;
const cn = bars.reduce((s2, b) => s2 + b.cn, 0) / bars.length;
const first = bars[0], last = bars[bars.length - 1];
const axE = last.ce - first.ce, axN = last.cn - first.cn;
const th = Math.atan2(axN, axE);
const w = worldOf(cx, cn);
const wU = { x: KX * Math.cos(th), z: -KZ * Math.sin(th) };
const worldBearing = (((Math.atan2(wU.x, -wU.z) * 180) / Math.PI) % 180 + 180) % 180;
const out = {
  method: 'bar between the two arms, local gate lum >= ' + LUM_FLOOR,
  barStations: bars.length,
  surveyCentre: [+cx.toFixed(1), +cn.toFixed(1)],
  surveyLengthM: +len.toFixed(1),
  surveyWidthMedianM: +gaps[gaps.length >> 1].toFixed(1),
  surveyWidthMaxM: +gaps[gaps.length - 1].toFixed(1),
  surveyBearingDeg: +((((90 - (th * 180) / Math.PI) % 360) + 360) % 180).toFixed(1),
  worldCentre: [+w.x.toFixed(1), +w.z.toFixed(1)],
  worldBearingDeg: +worldBearing.toFixed(1),
  latlon: [+(41.8925 + cn / 111320).toFixed(5), +(12.4823 + cx / (111320 * Math.cos((41.8925 * Math.PI) / 180))).toFixed(5)],
  westEdge: bars.map((b) => [+b.ae.toFixed(1), +b.an.toFixed(1)]),
  eastEdge: bars.map((b) => [+b.be.toFixed(1), +b.bn.toFixed(1)]),
};
console.log(JSON.stringify({ ...out, westEdge: undefined, eastEdge: undefined }, null, 1));
fs.writeFileSync('tools/scratch/tiber-island.json', JSON.stringify(out, null, 1));
console.error('wrote tools/scratch/tiber-island.json');
process.exit(0);
