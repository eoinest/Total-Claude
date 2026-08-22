#!/usr/bin/env node
/**
 * **Digitise the Tiber — both banks, the island, and the channel width — off the orthophoto.**
 *
 * Output: `tools/scratch/tiber-digitised.json`, in **survey metres** east/north of the Temple of
 * Jupiter OM, plus a look-at PNG. Nothing here imports the engine. The only thing shared with
 * `src/` is the published pixel -> survey georeference, restated in `tiber-plate.mjs`, so that
 * the number being graded and the number grading it are not the same number
 * (`MAP-METHOD.md` rule 6).
 *
 * ## Three algorithms that did not work, and why — the useful part of this file
 *
 * **1. Global colour gate + flood fill.** Recovered 0.066 km2 of a 0.7 km2 river. Two causes: one
 * gate cannot hold water that runs pale grey-green above the Muro Torto and dark olive below the
 * Aventine, and a 4-connected fill stops dead at every bridge — the closed gate breaks the river
 * into **twelve** components, one per inter-bridge reach. A radius-9 morphological close does not
 * rejoin them: the gaps at the Tiber Island and at Ponte Testaccio are 100-200 px.
 *
 * **2. Perpendicular edge-find on an iterated, smoothed centreline.** Found 506 stations and never
 * converged — maximum centre movement stayed near 380 m over four passes. At a meander the *next
 * limb* of the river is inside the search reach, so a station captures the wrong limb and the
 * smoothing drags its neighbours after it. **An iterative snap needs a basin of attraction
 * narrower than the spacing of the features it might snap to, and a meander does not give it one.**
 *
 * **3. A tracker whose offsets were measured from a fixed reference course.** Converged well
 * (offset median 1.7 m, p90 7.7 m) over the reach the twelve knots describe, and *lost the river
 * entirely north of them*, where the reference course was a straight extrapolation and the real
 * Tiber loops 400 m off it around the Foro Italico. **A tracker that measures its state relative
 * to a guess inherits the guess's errors wherever the guess is worst** — which is exactly the
 * failure this whole pass exists to fix, one level up.
 *
 * ## What works: a self-propelled walker with a turn limit
 *
 * No reference course at all. From a point and a heading, step 12 m forward, cut the perpendicular,
 * take the water run nearest the projected centre, move to its midpoint, and turn the heading
 * toward where you ended up — by at most 8 degrees per step. That turn limit is the whole trick:
 * 12 m at 8 degrees is an 86 m minimum radius, and the Tiber's tightest bend at Rome is about
 * 200 m, so the walker can follow every real bend and cannot turn hard enough to leave the channel
 * for a side pond or the wrong arm of a bifurcation. Walk downstream from a seed, then upstream.
 *
 * The seed is found, not assumed: the first station near the Pons Aelius whose perpendicular shows
 * exactly one water run 60-170 m wide.
 *
 * ## The gate
 *
 * `rough <= 34`, luminance 78..168, `G-R >= 5`, `G-B >= 6` (`tiber-raster.mjs`). Set off 22 538 pixels of confirmed water
 * against 3.3 M land pixels in a 68-171 m band beside them; the script that measured that is not
 * kept, because re-running it would grade the gate's population with the gate. Texture is the discriminating axis — water 1..18, land 33..172 — and the gate is
 * deliberately looser than those quantiles because the first, tight one held the reach from the
 * Muro Torto to the island and lost the whole southern river.
 *
 * ## Coverage
 *
 * Two rasters, one pixel grid (`tiber-raster.mjs`): the repo's plate covers survey n -2436..+2450,
 * and three tiles fetched this pass from the same WMS, layer, CRS and licence carry it north to
 * n +8180. That is world z -1505..+1400 at `KZ` = 0.35 — **the whole battlefield, with no reach of
 * the map's river left to extrapolation**, which is what Phase 1's run-out was.
 *
 *   node tools/scratch/tiber-digitise.mjs
 */
import sharp from 'sharp';
import fs from 'node:fs';
import { pxToSurvey, surveyToPx, surveyOfLatLon, M_PER_PX, worldOf } from './tiber-plate.mjs';
import { loadVirtual, MAIN, NORTH, NORTH_DY, GATE } from './tiber-raster.mjs';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const STEP_M = Number(arg('step', 12));
const MIN_RUN_M = Number(arg('minrun', 20));
const MAX_RUN_M = Number(arg('maxrun', 260));
const REACH_M = Number(arg('reach', 150));
const MAX_TURN_DEG = Number(arg('turn', 8));
const OFF_GATE_M = Number(arg('offgate', 40));
const MISS_LIMIT = Number(arg('misslimit', 24));
const N_LO = Number(arg('nlo', -2400));
const N_HI = Number(arg('nhi', 5000));
const ENV_GAP_M = Number(arg('envgap', 100));
const BAR_MIN_M = Number(arg('barmin', 18));
const JSON_OUT = arg('json', 'tools/scratch/tiber-digitised.json');
const PNG_OUT = arg('png', 'screenshots/tiber/digitised.png');

const V = await loadVirtual();
console.error(`gate: main ${V.main.gateCount} px, north ${V.north.gateCount} px`);

// ------------------------------------------------------------------ one perpendicular cut
/**
 * Water runs on the perpendicular at `cen`, heading `(te, tn)`. Offsets in metres; positive is
 * to the left of the heading. Single-pixel dropouts (boat wakes, JPEG ringing) are bridged.
 */
function runsAt(cen, te, tn, reachM) {
  const pe = -tn, pn = te;
  const N = Math.round(reachM / M_PER_PX);
  const cls = new Int8Array(2 * N + 1);
  for (let i = -N; i <= N; i++) {
    const p = surveyToPx(cen.e + pe * i * M_PER_PX, cen.n + pn * i * M_PER_PX);
    cls[i + N] = V.gateAt(p.px, p.py);
  }
  for (let i = 1; i < 2 * N; i++) if (cls[i] === 0 && cls[i - 1] === 1 && cls[i + 1] === 1) cls[i] = 1;
  const runs = [];
  let i = 0;
  while (i <= 2 * N) {
    if (cls[i] !== 1) { i++; continue; }
    const a = i; while (i <= 2 * N && cls[i] === 1) i++;
    const b = i - 1;
    const width = (b - a + 1) * M_PER_PX;
    runs.push({ lo: (a - N) * M_PER_PX, hi: (b - N) * M_PER_PX, mid: ((a + b) / 2 - N) * M_PER_PX, width });
  }
  return { runs, pe, pn, anyPlate: cls.some((c) => c >= 0) };
}
const channelRuns = (r) => r.runs.filter((x) => x.width >= MIN_RUN_M && x.width <= MAX_RUN_M);

// ------------------------------------------------------------------ the course
/**
 * The course comes from `tiber-course.mjs`, which finds it as the least-cost path through the
 * water on the plate. Splitting the two means this file cannot quietly re-tune the course to
 * make its own width numbers nicer, and it keeps the four failed trackers' lessons in one place.
 */
const rawCourse = JSON.parse(fs.readFileSync(arg('course', 'tools/scratch/tiber-course.json'), 'utf8'))
  .course.map(([e, n]) => ({ e, n }));
if (rawCourse[0].n < rawCourse[rawCourse.length - 1].n) rawCourse.reverse();
console.error(`course loaded: ${rawCourse.length} nodes, n ${rawCourse[0].n.toFixed(0)} .. ${rawCourse[rawCourse.length - 1].n.toFixed(0)}`);

// ------------------------------------------------------------------ smooth, resample, re-measure
const resample = (poly, step) => {
  const out = [poly[0]]; let carry = 0;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i], b = poly[i + 1];
    const L = Math.hypot(b.e - a.e, b.n - a.n);
    if (L < 1e-9) continue;
    let t = step - carry;
    while (t <= L) { out.push({ e: a.e + (b.e - a.e) * (t / L), n: a.n + (b.n - a.n) * (t / L) }); t += step; }
    carry = L - (t - step);
  }
  out.push(poly[poly.length - 1]);
  return out;
};
const smooth = (poly, win) => poly.map((_, i) => {
  let e = 0, n = 0, k = 0;
  for (let j = -win; j <= win; j++) {
    const q = poly[Math.max(0, Math.min(poly.length - 1, i + j))];
    const w = 1 - Math.abs(j) / (win + 1);
    e += q.e * w; n += q.n * w; k += w;
  }
  return { e: e / k, n: n / k };
});
const tangentAt = (poly, i, span = 3) => {
  const a = poly[Math.max(0, i - span)], b = poly[Math.min(poly.length - 1, i + span)];
  const de = b.e - a.e, dn = b.n - a.n, L = Math.hypot(de, dn) || 1;
  return [de / L, dn / L];
};
const course = resample(smooth(rawCourse, 2), STEP_M);

/**
 * Final measurement. The **envelope** is the braided channel: all water runs whose gaps from
 * their neighbours are under `ENV_GAP_M`, merged. Its outer edges are the two banks — which is
 * the right answer at the Tiber Island, where a walker that picks the nearest run follows one
 * arm and puts the centreline 50 m off the island's own axis. Interior gaps wider than
 * `BAR_MIN_M` are **bars**: the island, and the two gravel shoals below it.
 */
const stations = [];
for (let i = 0; i < course.length; i++) {
  if (course[i].n < N_LO || course[i].n > N_HI) continue;
  const [te, tn] = tangentAt(course, i);
  const rr = runsAt(course[i], te, tn, 230);
  if (!rr.anyPlate) continue;
  const rs = channelRuns(rr).sort((a, b) => a.lo - b.lo);
  if (!rs.length) { stations.push({ e: course[i].e, n: course[i].n, ok: false }); continue; }
  // the group containing the run nearest offset 0
  let k0 = 0;
  for (let k = 1; k < rs.length; k++) if (Math.abs(rs[k].mid) < Math.abs(rs[k0].mid)) k0 = k;
  let a = k0, b = k0;
  while (a > 0 && rs[a].lo - rs[a - 1].hi <= ENV_GAP_M) a--;
  while (b + 1 < rs.length && rs[b + 1].lo - rs[b].hi <= ENV_GAP_M) b++;
  const lo = rs[a].lo, hi = rs[b].hi;
  const bars = [];
  for (let k = a; k < b; k++) {
    const g = rs[k + 1].lo - rs[k].hi;
    if (g >= BAR_MIN_M) bars.push([+rs[k].hi.toFixed(1), +rs[k + 1].lo.toFixed(1)]);
  }
  const mid = (lo + hi) / 2;
  const pe = rr.pe, pn = rr.pn;
  stations.push({
    ok: true,
    e: +(course[i].e + pe * mid).toFixed(2), n: +(course[i].n + pn * mid).toFixed(2),
    te: +te.toFixed(5), tn: +tn.toFixed(5),
    we: +(course[i].e + pe * lo).toFixed(2), wn: +(course[i].n + pn * lo).toFixed(2),
    ee: +(course[i].e + pe * hi).toFixed(2), en: +(course[i].n + pn * hi).toFixed(2),
    width: +(hi - lo).toFixed(1),
    water: +rs.slice(a, b + 1).reduce((s, r) => s + r.width, 0).toFixed(1),
    bars: bars.length ? bars.map(([g0, g1]) => [
      +(course[i].e + pe * g0).toFixed(1), +(course[i].n + pn * g0).toFixed(1),
      +(course[i].e + pe * g1).toFixed(1), +(course[i].n + pn * g1).toFixed(1),
    ]) : undefined,
  });
}
const good = stations.filter((s) => s.ok);
// make (we,wn) the west side
let flip = 0;
for (const s of good) if (s.we > s.ee) flip++;
if (flip > good.length / 2) for (const s of good) { const a = s.we, b = s.wn; s.we = s.ee; s.wn = s.en; s.ee = a; s.en = b; }

let len = 0;
for (let i = 0; i + 1 < good.length; i++) len += Math.hypot(good[i + 1].e - good[i].e, good[i + 1].n - good[i].n);
const widths = good.map((s) => s.width).sort((a, b) => a - b);
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
const nMin = Math.min(...good.map((s) => s.n)), nMax = Math.max(...good.map((s) => s.n));
console.error(`course ${(len / 1000).toFixed(2)} km, ${good.length} stations at ${STEP_M} m`);
console.error(`n ${nMin.toFixed(0)} .. ${nMax.toFixed(0)} survey m  ->  world z ${worldOf(0, nMax).z.toFixed(0)} .. ${worldOf(0, nMin).z.toFixed(0)}`);
console.error(`channel envelope width: p10 ${q(widths, 0.1).toFixed(0)}  median ${q(widths, 0.5).toFixed(0)}  p90 ${q(widths, 0.9).toFixed(0)}  min ${widths[0].toFixed(0)}  max ${widths[widths.length - 1].toFixed(0)} m`);
const barSt = good.filter((s) => s.bars);
console.error(`stations with a bar in the channel: ${barSt.length}`);

// ------------------------------------------------------------------ bars into islands
/** Group consecutive bar-bearing stations into islands and measure each. */
const islands = [];
{
  let cur = [];
  for (let i = 0; i < good.length; i++) {
    if (good[i].bars) cur.push(good[i]);
    else { if (cur.length >= 4) islands.push(cur); cur = []; }
  }
  if (cur.length >= 4) islands.push(cur);
}
const islandOut = islands.map((grp) => {
  const w = [], e = [];
  for (const s of grp) {
    // the widest bar at this station
    let best = null;
    for (const b of s.bars) {
      const L = Math.hypot(b[2] - b[0], b[3] - b[1]);
      if (!best || L > best.L) best = { L, b };
    }
    w.push({ e: best.b[0], n: best.b[1] });
    e.push({ e: best.b[2], n: best.b[3] });
  }
  const ring = [...w, ...e.slice().reverse()];
  let cx = 0, cn = 0;
  for (const p of ring) { cx += p.e; cn += p.n; }
  cx /= ring.length; cn /= ring.length;
  let sxx = 0, sxn = 0, snn = 0;
  for (const p of ring) { const a = p.e - cx, b = p.n - cn; sxx += a * a; sxn += a * b; snn += b * b; }
  const th = 0.5 * Math.atan2(2 * sxn, sxx - snn);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of ring) {
    const u = (p.e - cx) * Math.cos(th) + (p.n - cn) * Math.sin(th);
    const v = -(p.e - cx) * Math.sin(th) + (p.n - cn) * Math.cos(th);
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  // shoelace area of the ring
  let A = 0;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; A += a.e * b.n - b.e * a.n; }
  return {
    stations: grp.length,
    centre: [+cx.toFixed(1), +cn.toFixed(1)],
    lengthM: +(u1 - u0).toFixed(1), widthM: +(v1 - v0).toFixed(1),
    bearingDeg: +(((90 - (th * 180) / Math.PI) % 360 + 360) % 360).toFixed(1),
    areaHa: +(Math.abs(A / 2) / 1e4).toFixed(3),
    ring: ring.map((p) => [+p.e.toFixed(1), +p.n.toFixed(1)]),
  };
}).sort((a, b) => b.areaHa - a.areaHa);
for (const il of islandOut.slice(0, 5)) {
  const w = worldOf(il.centre[0], il.centre[1]);
  console.error(`island: ${il.areaHa} ha, ${il.lengthM} x ${il.widthM} m, bearing ${il.bearingDeg} deg,`
    + ` e ${il.centre[0]} n ${il.centre[1]} (world x ${w.x.toFixed(0)} z ${w.z.toFixed(0)}), ${il.stations} stations`);
}

// ------------------------------------------------------------------ output
fs.writeFileSync(JSON_OUT, JSON.stringify({
  sources: [MAIN, NORTH], northDy: NORTH_DY, gate: GATE,
  measure: { stepM: STEP_M, minRunM: MIN_RUN_M, maxRunM: MAX_RUN_M, nLo: N_LO, nHi: N_HI },
  envelope: { gapM: ENV_GAP_M, barMinM: BAR_MIN_M },
  courseLenM: +len.toFixed(0),
  nRange: [+nMin.toFixed(1), +nMax.toFixed(1)],
  widthM: { p10: +q(widths, 0.1).toFixed(1), median: +q(widths, 0.5).toFixed(1), p90: +q(widths, 0.9).toFixed(1), min: +widths[0].toFixed(1), max: +widths[widths.length - 1].toFixed(1) },
  stations: good,
  islands: islandOut,
}, null, 1));
console.error('wrote ' + JSON_OUT);

// ------------------------------------------------------------------ the look-at picture
if (PNG_OUT) {
  const PY0 = -4095, PY1 = 2734, PX1 = 4096;
  const W = PX1, H = PY1 - PY0;
  const rgb = Buffer.alloc(W * H * 3, 20);
  for (let py = PY0; py < PY1; py++) for (let px = 0; px < PX1; px++) {
    const c = V.rgbAt(px, py);
    const o = ((py - PY0) * W + px) * 3;
    if (c) { rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]; }
  }
  const dot = (e, n, r, g, b, rad = 1) => {
    const p = surveyToPx(e, n);
    const x0 = Math.round(p.px), y0 = Math.round(p.py);
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const x = x0 + dx, y = y0 + dy;
      if (x < 0 || x >= PX1 || y < PY0 || y >= PY1) continue;
      const o = ((y - PY0) * W + x) * 3; rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
    }
  };
  for (const s of good) {
    dot(s.we, s.wn, 255, 235, 40, 1);
    dot(s.ee, s.en, 40, 220, 255, 1);
    dot(s.e, s.n, 255, 40, 40, 1);
  }
  for (const il of islandOut) for (const p of il.ring) dot(p[0], p[1], 255, 0, 255, 1);
  await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toFile(PNG_OUT);
  console.error(`wrote ${PNG_OUT} (${W}x${H}, virtual py ${PY0}..${PY1})`);
}
