#!/usr/bin/env node
/**
 * **The Tiber's course, as the least-cost path through the water on the plate.**
 *
 * Emits `tools/scratch/tiber-course.json`: a dense polyline in survey metres. `tiber-digitise.mjs`
 * then measures the banks, the width and the bars on it.
 *
 * ## Why a shortest path, after three trackers failed
 *
 * Recorded because the failures are the useful part, and because every one of them is a version
 * of the same mistake.
 *
 * 1. **Global colour gate + flood fill** — 0.066 km2 of a 0.7 km2 river. The gate breaks the
 *    river into twelve components, one per inter-bridge reach, and a radius-9 close does not
 *    rejoin them.
 * 2. **Perpendicular edge-find on an iterated, smoothed centreline** — 506 stations, never
 *    converged, max movement stuck near 380 m. At a meander the next limb is inside the search
 *    reach, a station captures the wrong limb, and the smoothing drags its neighbours after it.
 * 3. **A tracker measuring offsets from a fixed reference course** — excellent where the
 *    reference was good (offset p90 7.7 m) and blind where it was a straight extrapolation, i.e.
 *    exactly north of the twelve knots, where the real Tiber loops 400 m off the line. *A tracker
 *    that measures its state against a guess inherits the guess's error where the guess is worst.*
 * 4. **A self-propelled walker with an 8-degree turn limit** — follows any meander, and dies at a
 *    bridge that sits on a bend: it must coast blind through the deck, and Ponte Umberto I turns
 *    40 degrees underneath. A re-acquisition fan made it worse, not better.
 *
 * All four are *local* methods, and the thing they keep getting wrong is a *global* question:
 * which of several plausible continuations is the river. So ask it globally. Build a cost field
 * on the plate — cheap in mid-channel, dear near a bank, ruinous on land — and take the
 * least-cost path from one verified mid-channel point. There is no heading to lose, no reference
 * course to inherit, and no local minimum: a bridge deck is crossed because crossing it is
 * cheaper than any alternative, and a meander is followed because cutting its neck is not.
 *
 * ## The cost field
 *
 *   water, distance `t` px from the nearest land :  1 + 26/(1 + t)
 *   land                                         :  3000
 *
 * The water term biases the path to mid-channel without forbidding anything. The land constant is
 * set by an explicit trade: the widest deck to cross is about 20 m (12 px, 6 coarse px), and the
 * longest meander that could be short-circuited by a land neck is the Tor di Quinto loop, roughly
 * 2 km of water against a 500 m neck. At 3000 a 500 m neck costs 4.4e5 and 2 km of mid-channel
 * water costs about 1.2e3, so the loop is followed; a 20 m deck costs 1.8e4 and has no
 * alternative at all. **Both numbers are checked in the output**, as `deckCrossings` and
 * `landPxOnPath`, so a change to the cost that started short-cutting meanders would show up as a
 * long run of land pixels rather than a handful.
 *
 * ## Scale
 *
 * The path runs on a 2x-downsampled grid — 3.42 m per node, 2048 x 3414 nodes — which is finer
 * than the 12 m station spacing it feeds and 14x finer than the world's own heightfield sample in
 * z. The banks are then measured at full plate resolution.
 *
 *   node tools/scratch/tiber-course.mjs
 */
import fs from 'node:fs';
import sharp from 'sharp';
import { pxToSurvey, surveyToPx, surveyOfLatLon, M_PER_PX, worldOf } from './tiber-plate.mjs';
import { loadVirtual, MAIN, NORTH, NORTH_DY, GATE } from './tiber-raster.mjs';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const DS = 2;
const LAND_COST = Number(arg('land', 3000));
const MID_BONUS = Number(arg('mid', 26));
const N_TOP = Number(arg('ntop', 7900));
const N_BOT = Number(arg('nbot', -600));
const OUT = arg('out', 'tools/scratch/tiber-course.json');

const V = await loadVirtual();

// virtual pixel window
const PY0 = -4095, PY1 = 2734, PX0 = 0, PX1 = 4096;
const CW = Math.ceil((PX1 - PX0) / DS), CH = Math.ceil((PY1 - PY0) / DS);
console.error(`coarse grid ${CW} x ${CH} = ${(CW * CH / 1e6).toFixed(2)} M nodes at ${(M_PER_PX * DS).toFixed(2)} m`);

// ---- water on the coarse grid ----------------------------------------------------------
const water = new Uint8Array(CW * CH);
const valid = new Uint8Array(CW * CH);
{
  let nw = 0, nv = 0;
  for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CW; cx++) {
    let w = 0, v = 0;
    for (let dy = 0; dy < DS; dy++) for (let dx = 0; dx < DS; dx++) {
      const g = V.gateAt(PX0 + cx * DS + dx, PY0 + cy * DS + dy);
      if (g >= 0) v++;
      if (g === 1) w++;
    }
    const k = cy * CW + cx;
    if (v > 0) { valid[k] = 1; nv++; }
    if (w * 2 >= DS * DS) { water[k] = 1; nw++; }
  }
  console.error(`coarse: ${nv} valid nodes, ${nw} water (${(100 * nw / nv).toFixed(2)} %)`);
}

// ---- distance from each water node to the nearest non-water (chamfer, 2 passes) ---------
const dt = new Int32Array(CW * CH);
{
  const BIG = 1 << 28;
  for (let k = 0; k < CW * CH; k++) dt[k] = water[k] ? BIG : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= CW || y >= CH ? 0 : dt[y * CW + x]);
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    const k = y * CW + x;
    if (!water[k]) continue;
    dt[k] = Math.min(dt[k], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
  }
  for (let y = CH - 1; y >= 0; y--) for (let x = CW - 1; x >= 0; x--) {
    const k = y * CW + x;
    if (!water[k]) continue;
    dt[k] = Math.min(dt[k], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
  }
}

// ---- cost per node ---------------------------------------------------------------------
const cost = new Int32Array(CW * CH);
for (let k = 0; k < CW * CH; k++) {
  if (!valid[k]) { cost[k] = -1; continue; }
  cost[k] = water[k] ? Math.round(10 * (1 + (MID_BONUS * 3) / (3 + dt[k]))) : LAND_COST * 10;
}

// ---- the seed: one verified mid-channel node ------------------------------------------
const seedTarget = surveyOfLatLon(41.9013, 12.4665);
let seedK = -1, seedBest = -1;
{
  const p = surveyToPx(seedTarget.e, seedTarget.n);
  const cx0 = Math.round((p.px - PX0) / DS), cy0 = Math.round((p.py - PY0) / DS);
  for (let dy = -60; dy <= 60; dy++) for (let dx = -60; dx <= 60; dx++) {
    const cx = cx0 + dx, cy = cy0 + dy;
    if (cx < 0 || cy < 0 || cx >= CW || cy >= CH) continue;
    const k = cy * CW + cx;
    if (!water[k]) continue;
    if (dt[k] > seedBest) { seedBest = dt[k]; seedK = k; }
  }
  if (seedK < 0) throw new Error('no water near the seed');
  const sx = seedK % CW, sy = (seedK - sx) / CW;
  const s = pxToSurvey(PX0 + sx * DS, PY0 + sy * DS);
  console.error(`seed node: e ${s.e.toFixed(1)} n ${s.n.toFixed(1)}, ${(seedBest / 3 * M_PER_PX * DS).toFixed(0)} m from the nearest bank`);
}

// ---- Dijkstra --------------------------------------------------------------------------
const dist = new Int32Array(CW * CH).fill(0x7fffffff);
const prev = new Int32Array(CW * CH).fill(-1);
{
  // binary heap over (dist, node)
  const heapK = new Int32Array(CW * CH + 1);
  const heapD = new Int32Array(CW * CH + 1);
  let hn = 0;
  const push = (k, d) => {
    let i = ++hn; heapK[i] = k; heapD[i] = d;
    while (i > 1) { const p = i >> 1; if (heapD[p] <= heapD[i]) break; const tk = heapK[p], td = heapD[p]; heapK[p] = heapK[i]; heapD[p] = heapD[i]; heapK[i] = tk; heapD[i] = td; i = p; }
  };
  const pop = () => {
    const rk = heapK[1], rd = heapD[1];
    heapK[1] = heapK[hn]; heapD[1] = heapD[hn]; hn--;
    let i = 1;
    for (;;) {
      let m = i; const l = i << 1, r = l + 1;
      if (l <= hn && heapD[l] < heapD[m]) m = l;
      if (r <= hn && heapD[r] < heapD[m]) m = r;
      if (m === i) break;
      const tk = heapK[m], td = heapD[m]; heapK[m] = heapK[i]; heapD[m] = heapD[i]; heapK[i] = tk; heapD[i] = td; i = m;
    }
    return [rk, rd];
  };
  const N8 = [[1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10], [1, 1, 14], [1, -1, 14], [-1, 1, 14], [-1, -1, 14]];
  dist[seedK] = 0; push(seedK, 0);
  let popped = 0;
  while (hn > 0) {
    const [k, d] = pop();
    if (d > dist[k]) continue;
    popped++;
    const x = k % CW, y = (k - x) / CW;
    for (const [dx, dy, w] of N8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= CW || ny >= CH) continue;
      const nk = ny * CW + nx;
      const c = cost[nk];
      if (c < 0) continue;
      const nd = d + ((c * w) / 10) | 0;
      if (nd < dist[nk]) { dist[nk] = nd; prev[nk] = k; push(nk, nd); }
    }
  }
  console.error(`dijkstra settled ${popped} nodes`);
}

// ---- pick the two ends: cheapest reachable water above N_TOP and below N_BOT -----------
const pickEnd = (want) => {
  let best = -1, bestD = 0x7fffffff;
  for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CW; cx++) {
    const k = cy * CW + cx;
    if (!water[k] || dist[k] >= bestD) continue;
    const s = pxToSurvey(PX0 + cx * DS, PY0 + cy * DS);
    if (!want(s.n)) continue;
    bestD = dist[k]; best = k;
  }
  return { k: best, d: bestD };
};
const north = pickEnd((n) => n >= N_TOP);
const south = pickEnd((n) => n <= N_BOT);
for (const [name, end] of [['north', north], ['south', south]]) {
  if (end.k < 0) { console.error(`${name} end: NOT REACHED`); continue; }
  const x = end.k % CW, y = (end.k - x) / CW;
  const s = pxToSurvey(PX0 + x * DS, PY0 + y * DS);
  console.error(`${name} end: e ${s.e.toFixed(0)} n ${s.n.toFixed(0)} cost ${end.d}`);
}
if (north.k < 0 || south.k < 0) throw new Error('one end of the course was not reached');

const backtrack = (k) => { const out = []; while (k >= 0) { out.push(k); k = prev[k]; } return out; };
const upPath = backtrack(north.k);          // north end -> seed
const downPath = backtrack(south.k).reverse(); // seed -> south end
const nodes = [...upPath, ...downPath.slice(1)];
let landPx = 0, deckRuns = 0, inLand = false;
for (const k of nodes) {
  if (!water[k]) { landPx++; if (!inLand) { deckRuns++; inLand = true; } }
  else inLand = false;
}
const poly = nodes.map((k) => { const x = k % CW, y = (k - x) / CW; return pxToSurvey(PX0 + x * DS, PY0 + y * DS); });
let len = 0;
for (let i = 0; i + 1 < poly.length; i++) len += Math.hypot(poly[i + 1].e - poly[i].e, poly[i + 1].n - poly[i].n);
const nn = poly.map((p) => p.n);
console.error(`\ncourse ${poly.length} nodes, ${(len / 1000).toFixed(2)} km, n ${Math.min(...nn).toFixed(0)} .. ${Math.max(...nn).toFixed(0)}`
  + `  -> world z ${worldOf(0, Math.max(...nn)).z.toFixed(0)} .. ${worldOf(0, Math.min(...nn)).z.toFixed(0)}`);
console.error(`land nodes on the path: ${landPx} in ${deckRuns} runs (bridge decks and the two shoals)`
  + `  longest land run check: see json`);

// longest contiguous land run, which is the number that would betray a short-cut meander
let longest = 0, cur = 0;
for (const k of nodes) { if (!water[k]) { cur++; longest = Math.max(longest, cur); } else cur = 0; }
console.error(`longest contiguous land run: ${longest} nodes = ${(longest * M_PER_PX * DS).toFixed(0)} m`);

fs.writeFileSync(OUT, JSON.stringify({
  sources: [MAIN, NORTH], gate: GATE, ds: DS, mPerNode: +(M_PER_PX * DS).toFixed(4),
  landCost: LAND_COST, midBonus: MID_BONUS,
  seed: [+pxToSurvey(PX0 + (seedK % CW) * DS, PY0 + ((seedK - seedK % CW) / CW) * DS).e.toFixed(1),
         +pxToSurvey(PX0 + (seedK % CW) * DS, PY0 + ((seedK - seedK % CW) / CW) * DS).n.toFixed(1)],
  lenM: +len.toFixed(0), nodes: poly.length,
  landPxOnPath: landPx, deckCrossings: deckRuns, longestLandRunM: +(longest * M_PER_PX * DS).toFixed(0),
  course: poly.map((p) => [+p.e.toFixed(2), +p.n.toFixed(2)]),
}));
console.error('wrote ' + OUT);
