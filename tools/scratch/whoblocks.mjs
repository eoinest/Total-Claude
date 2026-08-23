#!/usr/bin/env node
/** Which reservation class refuses a given patch of block ground, and how much the way joints cost. */
import '../../src/terrain/topography.ts';
import '../../src/city/rome/survey.ts';
import '../../src/city/rome/apertures.ts';
import '../../src/city/rome/section.ts';
import '../../src/city/rome/monuments.ts';
import '../../src/city/rome/ways.ts';
import '../../src/city/rome/layout.ts';
import { KeepOut } from '../../src/city/layout.ts';
import { AQUEDUCTS, LANDMARKS, PLAZAS, WAYS, WAY_FRONTAGE, MON_AMBITUS } from '../../src/city/rome/layout.ts';
import { cityPlan } from '../../src/city/rome/fabric.ts';

const mon = new KeepOut();
for (const l of LANDMARKS) {
  mon.addRect(l.x, l.z, l.hw + MON_AMBITUS, l.hd + MON_AMBITUS, l.rot);
  if (l.mound) mon.addCircle(l.x, l.z, (l.moundRadius ?? l.clear) * 1.02);
}
const aq = new KeepOut();
for (const a of AQUEDUCTS) aq.addPath(a.path, 8);
const pl = new KeepOut();
for (const p of PLAZAS) pl.addRect(p.x, p.z, p.hw + 2, p.hd + 2, p.rot);
// The ways, split: the straight ribbons against the discs `addPath` puts at every joint.
const wayRib = new KeepOut();
const wayDisc = new KeepOut();
for (const w of WAYS) {
  const half = w.width * 0.5 + WAY_FRONTAGE[w.cls];
  for (let i = 0; i + 1 < w.path.length; i++) {
    const a = w.path[i];
    const b = w.path[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-4) continue;
    wayRib.addRect((a.x + b.x) / 2, (a.z + b.z) / 2, len / 2, half, Math.atan2(-(b.z - a.z), b.x - a.x));
  }
  for (let i = 1; i + 1 < w.path.length; i++) wayDisc.addCircle(w.path[i].x, w.path[i].z, half);
}
const named = { monument: mon, aqueduct: aq, plaza: pl, 'way ribbon': wayRib, 'way joint disc': wayDisc };
for (const [x, z] of [[-410.61, 1251.54], [-363.39, 1321.49], [-408.77, 1046.64], [-456.91, 1079.14], [-315, 1289]]) {
  const hits = Object.entries(named).filter(([, k]) => k.blockedRect(x, z, 8, 10, 0)).map(([n]) => n);
  console.log(`(${x},${z})  ${hits.join(', ') || 'nothing'}`);
}

const plan = cityPlan();
const inPoly = (poly, x, z) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
};
let disc = 0;
let rib = 0;
let tot = 0;
for (const b of plan.blocks) {
  if (b.kind !== 'block' || b.inset.length < 3) continue;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of b.inset) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
  }
  for (let z = z0 + 1; z < z1; z += 2) {
    for (let x = x0 + 1; x < x1; x += 2) {
      if (!inPoly(b.inset, x, z)) continue;
      tot += 4;
      if (wayRib.blockedRect(x, z, 1, 1, 0)) rib += 4;
      else if (wayDisc.blockedRect(x, z, 1, 1, 0)) disc += 4;
    }
  }
}
console.log(`block ground ${(tot / 1e4).toFixed(1)} ha: inside a way ribbon ${(rib / 1e4).toFixed(2)} ha,`
  + ` inside a JOINT DISC only ${(disc / 1e4).toFixed(2)} ha`);
