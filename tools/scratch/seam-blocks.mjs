#!/usr/bin/env node
/**
 * For every block involved in a grain seam, how close is its longest side to its
 * second-longest at a different bearing? A near-tie is an arbitrary choice, and an arbitrary
 * choice at a junction is a coin flip that can produce a seam; a clear winner is the street.
 */
import '../../src/terrain/topography.ts';
import '../../src/city/rome/survey.ts';
import '../../src/city/rome/apertures.ts';
import '../../src/city/rome/section.ts';
import '../../src/city/rome/monuments.ts';
import '../../src/city/rome/ways.ts';
import '../../src/city/rome/layout.ts';
import { cityPlan, buildDistricts } from '../../src/city/rome/fabric.ts';
import { romeKeepOut } from '../../src/city/rome/layout.ts';
import { romeWallZ } from '../../src/terrain/topography.ts';

const plan = cityPlan();
const out = buildDistricts(() => 20, romeKeepOut(), 'rome-fabric', romeWallZ);
const fold = (rad) => { let d = ((Math.abs(rad) * 180) / Math.PI) % 90; if (d > 45) d = 90 - d; return d; };

/** Side runs of a ring: consecutive edges within 1 degree, as `faceBearing` groups them. */
function sides(poly) {
  const n = poly.length;
  const bear = (i) => Math.atan2(poly[(i + 1) % n].z - poly[i].z, poly[(i + 1) % n].x - poly[i].x);
  const len = (i) => Math.hypot(poly[(i + 1) % n].x - poly[i].x, poly[(i + 1) % n].z - poly[i].z);
  const TOL = Math.PI / 180;
  const near = (p, q) => { let d = Math.abs(p - q) % Math.PI; if (d > Math.PI / 2) d = Math.PI - d; return d <= TOL; };
  let start = 0;
  for (let i = 0; i < n; i++) if (!near(bear(i), bear((i - 1 + n) % n))) { start = i; break; }
  const runs = [];
  let acc = 0;
  let b0 = bear(start);
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (k > 0 && !near(bear(i), b0)) { runs.push({ len: acc, bearing: b0 }); acc = 0; b0 = bear(i); }
    acc += len(i);
  }
  runs.push({ len: acc, bearing: b0 });
  return runs.sort((a, b) => b.len - a.len);
}

// Attribute each footprint to the block whose inset contains its centre.
const inPoly = (poly, x, z) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
};
const blocks = plan.blocks.filter((b) => b.kind === 'block' && b.inset.length >= 3);
const ownerOf = (f) => blocks.find((b) => inPoly(b.inset, f.x, f.z)) ?? null;

const P = out.footprints.map((f) => ({ f, b: ownerOf(f) }));
const CELL = 48;
const grid = new Map();
P.forEach((p, i) => {
  const k = `${Math.floor(p.f.x / CELL)},${Math.floor(p.f.z / CELL)}`;
  (grid.get(k) ?? grid.set(k, []).get(k)).push(i);
});
const involved = new Map();
let pairs = 0;
let bad = 0;
for (let i = 0; i < P.length; i++) {
  const a = P[i];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const j of grid.get(`${Math.floor(a.f.x / CELL) + dx},${Math.floor(a.f.z / CELL) + dz}`) ?? []) {
        if (j <= i) continue;
        const b = P[j];
        if (Math.hypot(a.f.x - b.f.x, a.f.z - b.f.z) > 40) continue;
        pairs++;
        if (fold(a.f.rot - b.f.rot) <= 15) continue;
        bad++;
        for (const e of [a, b]) if (e.b) involved.set(e.b.index, (involved.get(e.b.index) ?? 0) + 1);
      }
    }
  }
}
console.log(`${pairs} pairs, ${bad} seams, ${involved.size} blocks involved`);
let ties = 0;
for (const [idx, n] of [...involved.entries()].sort((a, b) => b[1] - a[1])) {
  const b = blocks.find((q) => q.index === idx);
  if (!b) continue;
  const S = sides(b.face.ring);
  const first = S[0];
  const second = S.find((r) => fold(r.bearing - first.bearing) > 5) ?? null;
  const ratio = second ? second.len / first.len : 0;
  if (ratio > 0.8) ties++;
  console.log(`  block ${idx} ${b.region.numeral} at (${b.face.cx.toFixed(0)},${b.face.cz.toFixed(0)})`
    + ` seams ${n}  longest side ${first.len.toFixed(1)} m`
    + `  next-at-a-different-bearing ${second ? `${second.len.toFixed(1)} m at ${fold(second.bearing - first.bearing).toFixed(1)} deg` : 'none'}`
    + `  ratio ${ratio.toFixed(2)}`);
}
console.log(`${ties} of ${involved.size} involved blocks have a near-tie (>0.8) between their two longest sides`);
