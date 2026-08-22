#!/usr/bin/env node
/**
 * **Are the twelve control points the engine's Tiber is built on actually on the river?**
 *
 * This is the check nothing on this project has ever run. `ROME-FABRIC.md` §7.3 reports the
 * Tiber's "worst survey error" as 0.1 world metres, and `probe-rometransect --only=tiber`
 * measures it — but what it measures is the *transcribed table* against `worldOf` of the *same
 * twelve latitudes and longitudes*. That is the arithmetic of the projection, not the position of
 * the river. If a latitude and longitude is 800 m from the water, the check passes at 0.1 m.
 *
 * So: for each knot, print (a) whether the orthophoto says that spot is water, and (b) how far it
 * is from the course traced off the plate. Nothing here consults the engine.
 */
import fs from 'node:fs';
import { surveyToPx, surveyOfLatLon, worldOf, KX, KZ } from './tiber-plate.mjs';
import { loadVirtual } from './tiber-raster.mjs';

const TIBER_LATLON = [
  [41.9450, 12.4600], [41.9352, 12.4670], [41.9270, 12.4700], [41.9200, 12.4712],
  [41.9130, 12.4718], [41.9052, 12.4723], [41.9013, 12.4665], [41.8965, 12.4640],
  [41.8930, 12.4700], [41.8905, 12.4778], [41.8820, 12.4760], [41.8700, 12.4720],
];
const V = await loadVirtual();
const C = JSON.parse(fs.readFileSync('tools/scratch/tiber-course.json', 'utf8')).course;

const distToCourse = (e, n) => {
  let best = Infinity, bp = null;
  for (let i = 0; i + 1 < C.length; i++) {
    const [ae, an] = C[i], [be, bn] = C[i + 1];
    const de = be - ae, dn = bn - an, L2 = de * de + dn * dn || 1;
    let t = ((e - ae) * de + (n - an) * dn) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const pe = ae + de * t, pn = an + dn * t;
    const d = Math.hypot(e - pe, n - pn);
    if (d < best) { best = d; bp = [pe, pn]; }
  }
  return { d: best, p: bp };
};

console.log('   lat      lon   |      e |     n |  world x |  world z | on water | dist to traced course | world offset');
console.log('  -------------------------------------------------------------------------------------------------------');
let worst = 0, worstI = -1;
const rows = [];
for (let i = 0; i < TIBER_LATLON.length; i++) {
  const [la, lo] = TIBER_LATLON[i];
  const s = surveyOfLatLon(la, lo);
  const w = worldOf(s.e, s.n);
  const p = surveyToPx(s.e, s.n);
  const g = V.gateAt(p.px, p.py);
  const { d, p: near } = distToCourse(s.e, s.n);
  const wdx = (near[0] - s.e) * KX, wdz = -(near[1] - s.n) * KZ;
  const wd = Math.hypot(wdx, wdz);
  if (d > worst) { worst = d; worstI = i; }
  rows.push({ i, la, lo, e: s.e, n: s.n, x: w.x, z: w.z, gate: g, d, wd });
  console.log(`  ${la.toFixed(4)} ${lo.toFixed(4)} | ${s.e.toFixed(0).padStart(6)} | ${s.n.toFixed(0).padStart(5)} | `
    + `${w.x.toFixed(1).padStart(8)} | ${w.z.toFixed(1).padStart(8)} | `
    + `${(g === 1 ? 'WATER' : g === 0 ? ' land' : 'off pl').padStart(8)} | ${d.toFixed(0).padStart(15)} m survey | ${wd.toFixed(0).padStart(5)} world m`);
}
const onWater = rows.filter((r) => r.gate === 1).length;
const offPlate = rows.filter((r) => r.gate < 0).length;
console.log(`\n  ${onWater} of ${TIBER_LATLON.length} knots stand on water; ${offPlate} off every plate.`);
const ds = rows.map((r) => r.d).sort((a, b) => a - b);
console.log(`  distance from the traced course: median ${ds[ds.length >> 1].toFixed(0)} m, worst ${worst.toFixed(0)} m (knot ${worstI + 1}, ${TIBER_LATLON[worstI]})`);
const wds = rows.map((r) => r.wd).sort((a, b) => a - b);
console.log(`  the same in world metres:        median ${wds[wds.length >> 1].toFixed(0)} m, worst ${wds[wds.length - 1].toFixed(0)} m`);
