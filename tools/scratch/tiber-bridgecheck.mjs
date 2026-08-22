#!/usr/bin/env node
/**
 * **Are the sixteen bridge midpoints on the river?**
 *
 * The judge's control table (`tools/judge/control.mjs` on `e/judge/rome-plan`) grades the Tiber
 * against sixteen modern bridge midpoints, on the ground that a bridge midpoint is on the
 * centreline by construction. That is true of a bridge and only as true as the coordinate.
 *
 * Measured here the same way the twelve engine knots were: sample the AGEA 2012 orthophoto's
 * water gate at each coordinate, and report the distance to the nearest gated water and to the
 * dense traced course. A control that is not on the river is not a control.
 */
import { surveyToPx, M_PER_PX } from './tiber-plate.mjs';
import { loadVirtual } from './tiber-raster.mjs';
import fs from 'node:fs';

const BRIDGES = [
  ['Ponte Milvio', 41.9351, 12.4667], ['Ponte Duca d Aosta', 41.9296, 12.4691],
  ['Ponte Risorgimento', 41.9203, 12.4707], ['Ponte Matteotti', 41.9146, 12.4726],
  ['Ponte Regina Margherita', 41.9109, 12.4741], ['Ponte Cavour', 41.9060, 12.4741],
  ['Ponte Umberto I', 41.9020, 12.4715], ['Ponte Sant Angelo', 41.9017, 12.4665],
  ['Ponte Vittorio Emanuele II', 41.8977, 12.4650], ['Ponte Mazzini', 41.8945, 12.4663],
  ['Ponte Sisto', 41.8930, 12.4700], ['Ponte Garibaldi', 41.8918, 12.4749],
  ['Ponte Fabricio', 41.8917, 12.4779], ['Ponte Palatino', 41.8894, 12.4788],
  ['Ponte Sublicio', 41.8829, 12.4757], ['Ponte Testaccio', 41.8748, 12.4713],
];
const LAT0 = 41.8925, LON0 = 12.4823, MLAT = 111320;
const MLON = 111320 * Math.cos((LAT0 * Math.PI) / 180);

const V = await loadVirtual();
const course = JSON.parse(fs.readFileSync('tools/scratch/tiber-course.json', 'utf8')).course;
const toCourse = (e, n) => {
  let best = Infinity;
  for (let i = 0; i + 1 < course.length; i++) {
    const [ae, an] = course[i], [be, bn] = course[i + 1];
    const de = be - ae, dn = bn - an, L2 = de * de + dn * dn || 1;
    let t = ((e - ae) * de + (n - an) * dn) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(e - (ae + de * t), n - (an + dn * t));
    if (d < best) best = d;
  }
  return best;
};

console.log('bridge                        e      n   gate   nearest water   to traced course');
const rows = [];
for (const [id, la, lo] of BRIDGES) {
  const e = (lo - LON0) * MLON;
  const n = (la - LAT0) * MLAT;
  const p = surveyToPx(e, n);
  const g = V.gateAt(p.px, p.py);
  // nearest gated water, searched out to 400 m
  let near = null;
  for (let r = 0; r <= 240 && near === null; r++) {
    for (let a = 0; a < 360; a += 6) {
      const dx = r * Math.cos((a * Math.PI) / 180);
      const dy = r * Math.sin((a * Math.PI) / 180);
      if (V.gateAt(p.px + dx, p.py + dy) === 1) { near = r * M_PER_PX; break; }
    }
  }
  const dc = toCourse(e, n);
  rows.push({ id, e, n, gate: g, nearWater: near, toCourse: dc });
  console.log(`${id.padEnd(28)}${e.toFixed(0).padStart(6)}${n.toFixed(0).padStart(7)}`
    + `${(g === 1 ? ' WATER' : g === 0 ? '  land' : ' offpl').padStart(7)}`
    + `${(near === null ? '>410' : near.toFixed(0)).padStart(10)} m${dc.toFixed(0).padStart(15)} m`);
}
const onWater = rows.filter((r) => r.gate === 1).length;
const far = rows.filter((r) => r.toCourse > 60);
console.log(`\n${onWater} of ${BRIDGES.length} bridge midpoints stand on gated water.`);
console.log(`${far.length} are more than 60 m from the traced course: ` + far.map((r) => `${r.id} ${r.toCourse.toFixed(0)} m`).join('; '));
