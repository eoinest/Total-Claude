#!/usr/bin/env node
/**
 * The phase-4 block plan, graded outside the browser.
 *
 * `probe-fabric` is the gate and this is not it: this imports `cityPlan()` — the shipped
 * function, not a copy of it — and prints the face-area distribution, the reject reasons, the
 * grain of the blocks against their own bounding streets, and the same G20/G21 statistics the
 * probe computes, so that a sign error or an empty quarter is found in two seconds instead of
 * in a four-minute browser boot. Everything it reports, the probe re-measures on the built
 * scene, where a builder can still disagree with its own plan.
 *
 *   node --experimental-strip-types --import ./tools/lib/ts-resolve.mjs \
 *     tools/scratch/rome-blockcheck.mjs
 */
// Primed in dependency order. `src/city/rome` has import cycles that Vite's evaluation order
// tolerates and Node's does not, so the leaves are pulled in first; nothing about the values
// depends on this, only on which module finishes evaluating first.
import '../../src/terrain/topography.ts';
import '../../src/city/rome/survey.ts';
import '../../src/city/rome/apertures.ts';
import '../../src/city/rome/section.ts';
import '../../src/city/rome/monuments.ts';
import '../../src/city/rome/ways.ts';
import '../../src/city/rome/layout.ts';
import { cityPlan, blockFrame } from '../../src/city/rome/fabric.ts';
import { REGIONS } from '../../src/city/rome/regions.ts';
import { WAYS } from '../../src/city/rome/layout.ts';

const t0 = Date.now();
const plan = cityPlan();
const ms = Date.now() - t0;
const r = plan.report;

console.log(`cityPlan() in ${ms} ms`);
console.log('graph:', JSON.stringify(r.graph));
console.log(`cross-lanes ${r.crossLanes} (${r.crossLaneKm.toFixed(2)} km)`);
console.log(`faces ${r.faces}: blocks ${r.blocks}, plazas ${r.plazas},`
  + ` pomerium ${r.pomerium}, field ${r.field}, horti blocks ${r.hortiBlocks}`);
console.log(`face area  p10 ${(r.faceAreaP10 / 1e4).toFixed(3)} ha`
  + `  p50 ${(r.faceAreaP50 / 1e4).toFixed(3)} ha`
  + `  p90 ${(r.faceAreaP90 / 1e4).toFixed(3)} ha`);
const bAreas = plan.blocks.filter((b) => b.kind === 'block').map((b) => b.face.areaM2).sort((a, b) => a - b);
const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
console.log(`BLOCK face area only: p10 ${(q(bAreas, 0.1) / 1e4).toFixed(3)} ha`
  + `  p50 ${(q(bAreas, 0.5) / 1e4).toFixed(3)} ha`
  + `  p90 ${(q(bAreas, 0.9) / 1e4).toFixed(3)} ha  n=${bAreas.length}`);
console.log(`inset area p50 ${(r.insetAreaP50 / 1e4).toFixed(3)} ha`);
console.log(`non-convex faces ${r.nonConvexFaces} of ${r.faces}`);
console.log(`worst frame error vs its own face: ${r.worstFrameErrorDeg.toFixed(6)} deg`);
console.log('rejects:');
for (const x of r.rejects) console.log(`   ${String(x.n).padStart(5)}  ${x.reason}`);

// ---- blocks per region --------------------------------------------------
const per = new Map();
for (const b of plan.blocks) {
  const acc = per.get(b.region.id) ?? { block: 0, plaza: 0, pomerium: 0, field: 0, area: 0 };
  acc[b.kind]++;
  if (b.kind === 'block') acc.area += b.face.areaM2;
  per.set(b.region.id, acc);
}
console.log('per region:');
for (const g of REGIONS) {
  const a = per.get(g.id) ?? { block: 0, plaza: 0, pomerium: 0, field: 0, area: 0 };
  console.log(`   ${g.numeral.padStart(4)} ${g.id.padEnd(30)} blocks ${String(a.block).padStart(4)}`
    + `  plaza ${String(a.plaza).padStart(4)}  pom ${String(a.pomerium).padStart(4)}`
    + `  field ${String(a.field).padStart(5)}  built face area ${(a.area / 1e6).toFixed(3)} km2`);
}

// ---- G20's question, asked of the plan ---------------------------------
// Nearest carriageway centreline among the armature and the generated cuts, then the folded
// angle between the block's own bearing and that street's. The probe asks the same question of
// the baked obstacle list; this asks it of the plan, so the two disagreeing is informative.
const segs = [];
const pushPath = (path, cls) => {
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    if (dx * dx + dz * dz < 1e-6) continue;
    segs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, bearing: Math.atan2(dz, dx), cls });
  }
};
for (const w of WAYS) pushPath(w.path, w.cls);
for (const c of plan.cuts) pushPath(c.path, c.cls);

const fold = (rad) => {
  let d = (Math.abs(rad) * 180) / Math.PI % 90;
  if (d > 45) d = 90 - d;
  return d;
};
const errs = [];
for (const b of plan.blocks) {
  if (b.kind !== 'block') continue;
  let best = null;
  let bd = Infinity;
  for (const s of segs) {
    const ex = s.bx - s.ax;
    const ez = s.bz - s.az;
    const l2 = ex * ex + ez * ez;
    const t = Math.max(0, Math.min(1, ((b.face.cx - s.ax) * ex + (b.face.cz - s.az) * ez) / l2));
    const dx = b.face.cx - (s.ax + ex * t);
    const dz = b.face.cz - (s.az + ez * t);
    const d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = s; }
  }
  if (best) {
    errs.push({
      deg: fold(b.frame.bearing - best.bearing),
      region: b.region.numeral,
      x: b.face.cx, z: b.face.cz,
      near: best.cls, dist: Math.sqrt(bd),
    });
  }
}
const errVals = errs.map((e) => e.deg).sort((a, b) => a - b);
console.log(`plan-side G20: ${errs.length} blocks, median ${q(errVals, 0.5).toFixed(2)} deg,`
  + ` p90 ${q(errVals, 0.9).toFixed(2)}, max ${errVals[errVals.length - 1].toFixed(2)},`
  + ` over 5 deg: ${errVals.filter((e) => e > 5).length}`);
{
  const per = new Map();
  for (const e of errs) {
    if (e.deg <= 5) continue;
    const k = e.region;
    per.set(k, (per.get(k) ?? 0) + 1);
  }
  console.log('  blocks over 5 deg by region:', [...per.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`).join('  '));
  console.log('  worst 8:', errs.slice().sort((a, b) => b.deg - a.deg).slice(0, 8)
    .map((e) => `${e.deg.toFixed(1)}deg ${e.region} at (${e.x.toFixed(0)},${e.z.toFixed(0)}) nearest ${e.near} ${e.dist.toFixed(0)}m`).join('\n            '));
}

// ---- the shape of the buildable polygon, in the block's own frame -------
{
  const us = [];
  const vs = [];
  for (const b of plan.blocks) {
    if (b.kind !== 'block') continue;
    let u0 = Infinity; let u1 = -Infinity; let v0 = Infinity; let v1 = -Infinity;
    for (const p of b.inset) {
      const u = b.frame.u(p.x, p.z);
      const v = b.frame.v(p.x, p.z);
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    us.push(u1 - u0);
    vs.push(v1 - v0);
  }
  us.sort((a, b2) => a - b2);
  vs.sort((a, b2) => a - b2);
  console.log(`inset extent along u: p10 ${q(us, 0.1).toFixed(1)} p50 ${q(us, 0.5).toFixed(1)} p90 ${q(us, 0.9).toFixed(1)} m`);
  console.log(`inset extent across v: p10 ${q(vs, 0.1).toFixed(1)} p50 ${q(vs, 0.5).toFixed(1)} p90 ${q(vs, 0.9).toFixed(1)} m`);
  console.log(`  blocks with v >= 30 (two rows): ${vs.filter((v) => v >= 30).length} of ${vs.length}`);
}

// ---- the biggest faces, and what became of them -------------------------
console.log('largest 10 faces:');
for (const b of plan.blocks.slice().sort((a, b2) => b2.face.areaM2 - a.face.areaM2).slice(0, 10)) {
  console.log(`   ${(b.face.areaM2 / 1e4).toFixed(2).padStart(9)} ha  ${b.kind.padEnd(9)}`
    + ` urban ${b.urban.toFixed(2)}  ${b.region.numeral.padStart(4)}`
    + ` at (${b.face.cx.toFixed(0)},${b.face.cz.toFixed(0)})  edges ${b.face.ring.length}`);
}

// ---- and the fabric itself, with the monuments in the way ---------------
// The same `KeepOut` `src/city/plan.ts` assembles, so the plot count here is the one the
// engine gets. Geometry is never built: the chunk `build` closures are not invoked.
{
  const { KeepOut } = await import('../../src/city/layout.ts');
  const { buildDistricts, assertBlocksAreFaces, assertBlockBearingSign } =
    await import('../../src/city/rome/fabric.ts');
  const { AQUEDUCTS, LANDMARKS, PLAZAS, STREETS } = await import('../../src/city/rome/layout.ts');
  const { romeWallZ } = await import('../../src/terrain/topography.ts');
  const keepOut = new KeepOut();
  for (const l of LANDMARKS) {
    keepOut.addRect(l.x, l.z, l.hw, l.hd, l.rot);
    if (l.mound) keepOut.addCircle(l.x, l.z, (l.moundRadius ?? l.clear) * 1.02);
  }
  for (const st of STREETS) keepOut.addPath(st.path, st.width * 0.5 + 2.5);
  for (const a of AQUEDUCTS) keepOut.addPath(a.path, 8);
  for (const pz of PLAZAS) keepOut.addRect(pz.x, pz.z, pz.hw + 2, pz.hd + 2, pz.rot);
  const t1 = Date.now();
  const out = buildDistricts(() => 20, keepOut, 'rome-fabric', romeWallZ);
  console.log(`buildDistricts in ${Date.now() - t1} ms: ${out.footprints.length} plots,`
    + ` ${out.lanes.length} lanes, ${out.trees.length} trees, ${out.chunks.length} chunks`);
  console.log('  by regio:', out.report.plotsByRegion.map((r) => `${r.id.replace('regio-', '')} ${r.blocks}b/${r.plots}p/${r.frontages}f`).join('  '));
  let area = 0;
  for (const f of out.footprints) area += 4 * f.hw * f.hd;
  console.log(`  building footprint area ${(area / 1e6).toFixed(3)} km2`);
  const faces = assertBlocksAreFaces(out.footprints);
  console.log('  blocks-are-faces:', JSON.stringify({ ...faces, worst: faces.worst.slice(0, 2) }));
  console.log('  bearing sign:', assertBlockBearingSign().ok ? 'OK' : 'MIRRORED');
  // Per-block coverage: how much of each buildable polygon actually became roof.
  {
    const cov = [];
    let empty = 0;
    for (const b of plan.blocks) {
      if (b.kind !== 'block' || b.insetAreaM2 < 100) continue;
      let a = 0;
      for (const f of out.footprints) {
        const du = b.frame.u(f.x, f.z);
        const dv = b.frame.v(f.x, f.z);
        let u0 = Infinity; let u1 = -Infinity; let v0 = Infinity; let v1 = -Infinity;
        for (const p of b.inset) {
          const u = b.frame.u(p.x, p.z);
          const v = b.frame.v(p.x, p.z);
          if (u < u0) u0 = u; if (u > u1) u1 = u;
          if (v < v0) v0 = v; if (v > v1) v1 = v;
        }
        if (du < u0 - 2 || du > u1 + 2 || dv < v0 - 2 || dv > v1 + 2) continue;
        a += 4 * f.hw * f.hd;
      }
      if (a === 0) empty++;
      cov.push(a / b.insetAreaM2);
    }
    cov.sort((x, y) => x - y);
    console.log(`  per-block coverage of the buildable polygon: p10 ${(q(cov, 0.1) * 100).toFixed(0)}%`
      + ` p50 ${(q(cov, 0.5) * 100).toFixed(0)}% p90 ${(q(cov, 0.9) * 100).toFixed(0)}%;`
      + ` ${empty} of ${cov.length} blocks built nothing`);
  }

  // Plan-side G21: neighbouring plots within 40 m, folded angle between them.
  const P = out.footprints;
  const pairs = [];
  const CELL = 48;
  const grid = new Map();
  P.forEach((p, i) => {
    const k = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)).push(i);
  });
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(`${Math.floor(a.x / CELL) + dx},${Math.floor(a.z / CELL) + dz}`) ?? []) {
          if (j <= i) continue;
          const b = P[j];
          const d = Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
          if (d > 40) continue;
          pairs.push(fold(a.rot - b.rot));
        }
      }
    }
  }
  pairs.sort((x, y) => x - y);
  console.log(`  plan-side G21: ${pairs.length} pairs within 40 m, median ${q(pairs, 0.5).toFixed(2)} deg,`
    + ` p90 ${q(pairs, 0.9).toFixed(2)}, over 15 deg ${pairs.filter((v) => v > 15).length}`
    + ` (${((pairs.filter((v) => v > 15).length / Math.max(1, pairs.length)) * 100).toFixed(2)}%)`);
}

// ---- the deliberately asymmetric sign case -----------------------------
for (const deg of [30, -30, 12, -12, 75]) {
  const th = (deg * Math.PI) / 180;
  const L = 120;
  const W = 40;
  const ring = [
    { x: -L * Math.cos(th) - -W * Math.sin(th), z: -L * Math.sin(th) + -W * Math.cos(th) },
    { x: L * Math.cos(th) - -W * Math.sin(th), z: L * Math.sin(th) + -W * Math.cos(th) },
    { x: L * Math.cos(th) - W * Math.sin(th), z: L * Math.sin(th) + W * Math.cos(th) },
    { x: -L * Math.cos(th) - W * Math.sin(th), z: -L * Math.sin(th) + W * Math.cos(th) },
  ];
  const F = blockFrame(ring, 0, 0);
  // A plot at this frame's `rot` draws its long axis along `-rot`; that must equal the input.
  const drawn = (-F.rot * 180) / Math.PI;
  console.log(`sign case ${String(deg).padStart(4)} deg -> frame bearing ${(F.bearing * 180 / Math.PI).toFixed(3)},`
    + ` plan rot ${(F.rot * 180 / Math.PI).toFixed(3)}, drawn long axis ${drawn.toFixed(3)}`
    + `  ${Math.abs(fold(F.bearing - th)) < 1e-6 ? 'OK' : 'MISMATCH'}`);
}
