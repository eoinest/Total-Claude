#!/usr/bin/env node
/**
 * **The bridges, measured off the plate instead of remembered.**
 *
 * A bridge deck is opaque at 1.71 m/px, so walking the traced course a bridge is a *gap* in the
 * water gate. Take the midpoint of each gap of the right length and that is the crossing, on the
 * centreline by construction and read off the raster rather than recalled.
 *
 * Why bother: `tools/judge/control.mjs` grades the Tiber against sixteen bridge midpoints given
 * as latitude and longitude, and checked against the same orthophoto
 * (`tools/scratch/tiber-bridgecheck.mjs`) **three of the sixteen stand on water**, five are
 * 44-89 m from the nearest water, and **Ponte Duca d'Aosta is 652 m from the Tiber** — it is
 * given at 41.9296 and the bridge is at 41.9328. Those are not typos in a spreadsheet; they are
 * the ruler the map is being graded with, and a ruler with a 652 m error in it will mark a
 * correct river wrong.
 *
 * This emits the same sixteen names with plate-measured positions and an error bar, in the same
 * shape, so the judge's table can take them.
 */
import fs from 'node:fs';
import { surveyToPx, M_PER_PX, worldOf } from './tiber-plate.mjs';
import { loadVirtual } from './tiber-raster.mjs';

const LAT0 = 41.8925, LON0 = 12.4823, MLAT = 111320;
const MLON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
/** The names, in order downstream, with the coordinate the judge's table gives, for comparison. */
const NAMED = [
  ['Ponte Milvio', 41.9351, 12.4667], ['Ponte Duca d Aosta', 41.9296, 12.4691],
  ['Ponte Risorgimento', 41.9203, 12.4707], ['Ponte Matteotti', 41.9146, 12.4726],
  ['Ponte Regina Margherita', 41.9109, 12.4741], ['Ponte Cavour', 41.9060, 12.4741],
  ['Ponte Umberto I', 41.9020, 12.4715], ['Ponte Sant Angelo', 41.9017, 12.4665],
  ['Ponte Vittorio Emanuele II', 41.8977, 12.4650], ['Ponte Mazzini', 41.8945, 12.4663],
  ['Ponte Sisto', 41.8930, 12.4700], ['Ponte Garibaldi', 41.8918, 12.4749],
  ['Ponte Fabricio', 41.8917, 12.4779], ['Ponte Palatino', 41.8894, 12.4788],
  ['Ponte Sublicio', 41.8829, 12.4757], ['Ponte Testaccio', 41.8748, 12.4713],
];

const V = await loadVirtual();
const course = JSON.parse(fs.readFileSync('tools/scratch/tiber-course.json', 'utf8')).course
  .map(([e, n]) => ({ e, n }));
// downstream order: north (high n) first
if (course[0].n < course[course.length - 1].n) course.reverse();

// arc length along the course, and the gate under each node
const s = [0];
for (let i = 1; i < course.length; i++) s.push(s[i - 1] + Math.hypot(course[i].e - course[i - 1].e, course[i].n - course[i - 1].n));
const gate = course.map((p) => { const q = surveyToPx(p.e, p.n); return V.gateAt(q.px, q.py); });

/** Gaps in the water along the course, 8-90 m long: bridge decks and nothing else that size. */
const gaps = [];
let i = 0;
while (i < course.length) {
  if (gate[i] !== 0) { i++; continue; }
  const a = i;
  while (i < course.length && gate[i] === 0) i++;
  const b = i - 1;
  const len = s[b] - s[a];
  if (len < 8 || len > 90) continue;
  // the midpoint, and the deck's own width measured across the course
  const mid = { e: (course[a].e + course[b].e) / 2, n: (course[a].n + course[b].n) / 2 };
  gaps.push({ mid, lenM: len, iA: a, iB: b });
}
console.error(`gaps of 8-90 m in the water along the course: ${gaps.length}`);

console.log('\nEVERY gap of 8-90 m along the course, in downstream order — the deck crossings the plate shows');
console.log('  #    lat      lon      e      n      deck   world x     z');
gaps.forEach((g, k) => {
  const w = worldOf(g.mid.e, g.mid.n);
  console.log(String(k).padStart(3), (LAT0 + g.mid.n / MLAT).toFixed(5), (LON0 + g.mid.e / MLON).toFixed(5),
    g.mid.e.toFixed(0).padStart(7), g.mid.n.toFixed(0).padStart(7), g.lenM.toFixed(0).padStart(7) + ' m',
    w.x.toFixed(0).padStart(8), w.z.toFixed(0).padStart(7));
});
console.log('');

const rows = [];
for (const [id, la, lo] of NAMED) {
  const e = (lo - LON0) * MLON;
  const n = (la - LAT0) * MLAT;
  let best = null;
  for (const g of gaps) {
    const d = Math.hypot(g.mid.e - e, g.mid.n - n);
    if (!best || d < best.d) best = { d, g };
  }
  const w = best ? worldOf(best.g.mid.e, best.g.mid.n) : null;
  rows.push({
    id,
    given: [la, lo],
    plate: best ? [+best.g.mid.e.toFixed(1), +best.g.mid.n.toFixed(1)] : null,
    plateLatLon: best ? [+(LAT0 + best.g.mid.n / MLAT).toFixed(5), +(LON0 + best.g.mid.e / MLON).toFixed(5)] : null,
    world: w ? [+w.x.toFixed(1), +w.z.toFixed(1)] : null,
    deckM: best ? +best.g.lenM.toFixed(1) : null,
    movedM: best ? +best.d.toFixed(1) : null,
  });
}
console.log('bridge                        given lat,lon      plate lat,lon      deck   moved   world x,z');
for (const r of rows) {
  console.log(`${r.id.padEnd(28)}${r.given[0].toFixed(4)},${r.given[1].toFixed(4)}   `
    + `${r.plateLatLon ? r.plateLatLon[0].toFixed(5) + ',' + r.plateLatLon[1].toFixed(5) : '   -   '}`
    + `${(r.deckM ?? 0).toFixed(0).padStart(7)} m${(r.movedM ?? 0).toFixed(0).padStart(7)} m`
    + `   ${r.world ? r.world[0].toFixed(0) + ', ' + r.world[1].toFixed(0) : ''}`);
}
const moved = rows.filter((r) => r.movedM !== null).map((r) => r.movedM).sort((a, b) => a - b);
console.log(`\nmedian correction ${moved[moved.length >> 1].toFixed(0)} m, worst ${moved[moved.length - 1].toFixed(0)} m`);
fs.writeFileSync('tools/scratch/tiber-bridges.json', JSON.stringify({ rows, gaps: gaps.length }, null, 1));
console.error('wrote tools/scratch/tiber-bridges.json');
