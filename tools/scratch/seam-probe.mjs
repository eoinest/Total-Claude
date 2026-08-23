#!/usr/bin/env node
/** Where the grain seams are: pairs of plots within 40 m more than 15 deg apart, by block. */
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
// Attribute footprints to blocks by nearest block whose inset contains them.
const P = out.footprints;
// [0, 45]: a block parallel and a block perpendicular to the same street are both aligned.
const fold = (rad) => { let d = ((Math.abs(rad) * 180) / Math.PI) % 90; if (d > 45) d = 90 - d; return d; };
const CELL = 48;
const grid = new Map();
P.forEach((p, i) => {
  const k = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
  (grid.get(k) ?? grid.set(k, []).get(k)).push(i);
});
const bad = [];
let pairs = 0;
for (let i = 0; i < P.length; i++) {
  const a = P[i];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const j of grid.get(`${Math.floor(a.x / CELL) + dx},${Math.floor(a.z / CELL) + dz}`) ?? []) {
        if (j <= i) continue;
        const b = P[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d > 40) continue;
        pairs++;
        const f = fold(a.rot - b.rot);
        if (f > 15) bad.push({ i, j, f, d, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
      }
    }
  }
}
console.log(`${pairs} pairs, ${bad.length} over 15 deg (${((bad.length / pairs) * 100).toFixed(2)}%)`);
// cluster the offenders by location
const clusters = [];
for (const b of bad.sort((x, y) => y.f - x.f)) {
  const n = clusters.find((c) => Math.hypot(c.x - b.x, c.z - b.z) < 60);
  if (n) { n.n++; n.worst = Math.max(n.worst, b.f); n.minD = Math.min(n.minD, b.d); }
  else clusters.push({ x: b.x, z: b.z, n: 1, worst: b.f, minD: b.d });
}
console.log(`${clusters.length} clusters:`);
for (const c of clusters.sort((a, b) => b.n - a.n)) {
  console.log(`   ${String(c.n).padStart(3)} pairs at (${c.x.toFixed(0)},${c.z.toFixed(0)})  worst ${c.worst.toFixed(1)} deg  closest ${c.minD.toFixed(1)} m`);
}

// Is a seam at a junction of two authored ways, or in the middle of a quarter?
// The threshold comment licenses "a handful of pairs [that] legitimately straddle a genuine
// grain change"; a grain change in a real city happens where two streets meet. So measure it.
const { WAYS } = await import('../../src/city/rome/layout.ts');
const junctions = [];
const seg = (w) => { const o = []; for (let i = 0; i + 1 < w.path.length; i++) o.push([w.path[i], w.path[i + 1]]); return o; };
const cross = (a1, a2, b1, b2) => {
  const rx = a2.x - a1.x, rz = a2.z - a1.z, sx = b2.x - b1.x, sz = b2.z - b1.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b1.x - a1.x) * sz - (b1.z - a1.z) * sx) / den;
  const u = ((b1.x - a1.x) * rz - (b1.z - a1.z) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a1.x + rx * t, z: a1.z + rz * t };
};
for (let i = 0; i < WAYS.length; i++) {
  for (let j = i + 1; j < WAYS.length; j++) {
    for (const [a1, a2] of seg(WAYS[i])) for (const [b1, b2] of seg(WAYS[j])) {
      const h = cross(a1, a2, b1, b2);
      if (h) junctions.push(h);
    }
  }
}
// ...and the generated cross-lanes' own junctions with the armature, since a cross-lane is a
// street too and a block fronts it.
for (const c of plan.cuts) {
  for (const w of WAYS) {
    for (const [a1, a2] of seg(c)) for (const [b1, b2] of seg(w)) {
      const h = cross(a1, a2, b1, b2);
      if (h) junctions.push(h);
    }
  }
}
const nearJ = (x, z) => {
  let d = Infinity;
  for (const j of junctions) { const q = Math.hypot(j.x - x, j.z - z); if (q < d) d = q; }
  return d;
};
const ds = bad.map((b) => nearJ(b.x, b.z)).sort((a, b) => a - b);
console.log(`${junctions.length} street junctions; seam-pair distance to the nearest one:`
  + ` median ${ds[Math.floor(ds.length / 2)].toFixed(1)} m, max ${ds[ds.length - 1].toFixed(1)} m,`
  + ` over 60 m: ${ds.filter((v) => v > 60).length} of ${ds.length}`);
