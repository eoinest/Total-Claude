#!/usr/bin/env node
/**
 * Phase 5's decomposition of Rome's roof coverage, outside the browser.
 *
 * `rome-blockcheck.mjs` grades the *plan*: faces, grain, seams. This grades the **fill** —
 * how much of the ground between street lines becomes roof, which block builds nothing and
 * what refused it, and what each reservation class costs on its own. It imports the shipped
 * `cityPlan()`, `buildDistricts()` and `romeKeepOut()`; nothing here is a copy.
 *
 *   node --experimental-transform-types --import ./tools/lib/ts-resolve.mjs \
 *     tools/scratch/fill-audit.mjs [--ablate]
 */
import '../../src/terrain/topography.ts';
import '../../src/city/rome/survey.ts';
import '../../src/city/rome/apertures.ts';
import '../../src/city/rome/section.ts';
import '../../src/city/rome/monuments.ts';
import '../../src/city/rome/ways.ts';
import '../../src/city/rome/layout.ts';
import { cityPlan, buildDistricts } from '../../src/city/rome/fabric.ts';
import { AQUEDUCTS, LANDMARKS, PLAZAS, WAYS, WAY_FRONTAGE, MON_AMBITUS, romeKeepOut } from '../../src/city/rome/layout.ts';
import { KeepOut } from '../../src/city/layout.ts';
import { romeWallZ } from '../../src/terrain/topography.ts';

const ABLATE = process.argv.includes('--ablate');

/** Area of a polygon given as world points. */
function area(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.z - q.x * p.z;
  }
  return Math.abs(a) * 0.5;
}

/** Exact clipped area of an oriented rectangle against a convex-ish polygon, by triangulation. */
function rectPolyArea(rect, poly) {
  // Sutherland-Hodgman with the rectangle as the (convex) clip.
  const c = Math.cos(rect.rot);
  const s = Math.sin(rect.rot);
  // Local +X maps to world (cos, -sin) — three.js convention, as in `Obb`.
  const ux = { x: c, z: -s };
  const vx = { x: s, z: c };
  const planes = [
    { nx: ux.x, nz: ux.z, d: rect.hw },
    { nx: -ux.x, nz: -ux.z, d: rect.hw },
    { nx: vx.x, nz: vx.z, d: rect.hd },
    { nx: -vx.x, nz: -vx.z, d: rect.hd },
  ];
  let out = poly.map((p) => ({ x: p.x - rect.x, z: p.z - rect.z }));
  for (const pl of planes) {
    const inp = out;
    out = [];
    for (let i = 0; i < inp.length; i++) {
      const a = inp[i];
      const b = inp[(i + 1) % inp.length];
      const da = a.x * pl.nx + a.z * pl.nz - pl.d;
      const db = b.x * pl.nx + b.z * pl.nz - pl.d;
      if (da <= 0) out.push(a);
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const t = da / (da - db);
        out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      }
    }
    if (out.length === 0) return 0;
  }
  return area(out);
}

const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);

/**
 * Roof over the ground between street lines, measured the way the acceptance number is
 * stated: total footprint area clipped to each block's own inset polygon, over the total
 * inset area. Clipped rather than summed whole, because a footprint that oversails its own
 * block would otherwise be counted as coverage of ground it is not on.
 */
function coverage(plan, footprints) {
  // Bucket footprints by block via a coarse grid on the block centroid.
  const CELL = 128;
  const grid = new Map();
  for (const b of plan.blocks) {
    if (b.kind !== 'block' || b.inset.length < 3) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of b.inset) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
    }
    for (let z = z0; z <= z1 + CELL; z += CELL) {
      for (let x = x0; x <= x1 + CELL; x += CELL) {
        const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
        (grid.get(k) ?? grid.set(k, []).get(k)).push(b);
      }
    }
  }
  const roofPer = new Map();
  let roofTotal = 0;
  let insetTotal = 0;
  for (const f of footprints) {
    const k = `${Math.floor(f.x / CELL)},${Math.floor(f.z / CELL)}`;
    const seen = new Set();
    for (const b of grid.get(k) ?? []) {
      if (seen.has(b.index)) continue;
      seen.add(b.index);
      const a = rectPolyArea(f, b.inset);
      if (a <= 0) continue;
      roofPer.set(b.index, (roofPer.get(b.index) ?? 0) + a);
      roofTotal += a;
    }
  }
  const per = [];
  for (const b of plan.blocks) {
    if (b.kind !== 'block' || b.insetAreaM2 <= 0) continue;
    insetTotal += b.insetAreaM2;
    per.push({ b, roof: roofPer.get(b.index) ?? 0, cov: (roofPer.get(b.index) ?? 0) / b.insetAreaM2 });
  }
  return { roofTotal, insetTotal, cov: roofTotal / insetTotal, per };
}

function run(label, keepOut) {
  const plan = cityPlan();
  const out = buildDistricts(() => 20, keepOut, 'rome-fabric', romeWallZ);
  const c = coverage(plan, out.footprints);
  console.log(`${label.padEnd(30)} plots ${String(out.footprints.length).padStart(5)}`
    + `  roof ${(c.roofTotal / 1e3).toFixed(1).padStart(7)} km2/1000`
    + `  inset ${(c.insetTotal / 1e3).toFixed(1).padStart(7)}`
    + `  coverage ${(c.cov * 100).toFixed(1)}%`);
  return { plan, out, c };
}

// ---- the shipped answer -------------------------------------------------
const { plan, out, c } = run('as shipped', romeKeepOut());
const r = out.report;
console.log('');
console.log(`inset ground between street lines: ${(c.insetTotal / 1e4).toFixed(1)} ha over ${c.per.length} blocks`);
const covs = c.per.map((p) => p.cov).sort((a, b) => a - b);
console.log(`per-block coverage p10 ${(q(covs, 0.1) * 100).toFixed(0)}%  p25 ${(q(covs, 0.25) * 100).toFixed(0)}%`
  + `  p50 ${(q(covs, 0.5) * 100).toFixed(0)}%  p75 ${(q(covs, 0.75) * 100).toFixed(0)}%  p90 ${(q(covs, 0.9) * 100).toFixed(0)}%`);
const empties = c.per.filter((p) => p.roof <= 0);
console.log(`blocks with NO roof at all: ${empties.length} of ${c.per.length}`
  + `  (${(empties.reduce((s, p) => s + p.b.insetAreaM2, 0) / 1e4).toFixed(1)} ha of buildable ground)`);
console.log(`the generator's own emptyBecause names: ${r.emptyBlocks.reduce((s, e) => s + e.n, 0)}`);
for (const e of r.emptyBlocks) console.log(`   ${String(e.n).padStart(4)}  ${e.reason}`);
console.log('plot rejects:', JSON.stringify(r.plotRejects));

// Where the empty blocks are, and how big.
console.log('empty blocks, largest 20:');
for (const p of empties.slice().sort((a, b) => b.b.insetAreaM2 - a.b.insetAreaM2).slice(0, 20)) {
  const b = p.b;
  console.log(`   ${(b.insetAreaM2 / 1e4).toFixed(3)} ha  ${b.region.numeral.padStart(4)}`
    + ` at (${b.face.cx.toFixed(0)},${b.face.cz.toFixed(0)})  urban ${b.urban.toFixed(2)}`
    + `  horti ${b.horti ? 'y' : 'n'}  minWidth-ish ${(b.insetAreaM2 / Math.max(1, Math.sqrt(b.face.areaM2))).toFixed(1)}`);
}

// Coverage by regio, in the acceptance units.
console.log('coverage by regio:');
const byRegion = new Map();
for (const p of c.per) {
  const acc = byRegion.get(p.b.region.numeral) ?? { roof: 0, inset: 0, n: 0, empty: 0 };
  acc.roof += p.roof; acc.inset += p.b.insetAreaM2; acc.n++;
  if (p.roof <= 0) acc.empty++;
  byRegion.set(p.b.region.numeral, acc);
}
for (const [num, a] of [...byRegion.entries()].sort((x, y) => y[1].inset - x[1].inset)) {
  console.log(`   ${num.padStart(4)}  ${(a.inset / 1e4).toFixed(1).padStart(6)} ha  roof ${(a.roof / 1e4).toFixed(1).padStart(6)} ha`
    + `  ${((a.roof / a.inset) * 100).toFixed(1).padStart(5)}%  blocks ${String(a.n).padStart(3)}  empty ${a.empty}`);
}

// ---- what each reservation class costs ----------------------------------
if (ABLATE) {
  console.log('');
  console.log('ablations (each drops ONE reservation class; everything else as shipped):');
  const build = (opts) => {
    const k = new KeepOut();
    if (!opts.noMon) {
      for (const l of LANDMARKS) {
        k.addRect(l.x, l.z, l.hw + MON_AMBITUS, l.hd + MON_AMBITUS, l.rot);
        if (l.mound) k.addCircle(l.x, l.z, (l.moundRadius ?? l.clear) * 1.02);
      }
    }
    if (!opts.noWays) for (const w of WAYS) k.addPath(w.path, w.width * 0.5 + WAY_FRONTAGE[w.cls]);
    if (!opts.noPlaza) for (const p of PLAZAS) k.addRect(p.x, p.z, p.hw + 2, p.hd + 2, p.rot);
    if (!opts.noAq) for (const a of AQUEDUCTS) k.addPath(a.path, 8);
    return k;
  };
  run('no monuments', build({ noMon: true }));
  run('no way reservations', build({ noWays: true }));
  run('no plazas', build({ noPlaza: true }));
  run('no aqueducts', build({ noAq: true }));
  run('nothing reserved at all', build({ noMon: true, noWays: true, noPlaza: true, noAq: true }));
}

// ---- how much of the "ground between street lines" is not fabric ground -----
//
// The 60-70 % the AGEA orthophoto shows is roof over the ground between street lines. The
// denominator this pass inherited is every block's inset polygon, and part of that polygon
// is a monument, a square, an aqueduct arcade or the Tiber - ground the fabric is *right*
// not to build on. So the ablations above cannot be read as "the generator is refusing 17
// points"; some of it is ground that is already something. Measured by rasterising each
// block's inset at 2 m and asking the same `KeepOut` the generator asks.
{
  const { inTheRiverAt } = await import('../../src/city/rome/fabric.ts');
  const mk = (which) => {
    const k = new KeepOut();
    if (which === 'mon') {
      for (const l of LANDMARKS) {
        k.addRect(l.x, l.z, l.hw + MON_AMBITUS, l.hd + MON_AMBITUS, l.rot);
        if (l.mound) k.addCircle(l.x, l.z, (l.moundRadius ?? l.clear) * 1.02);
      }
    }
    if (which === 'way') for (const w of WAYS) k.addPath(w.path, w.width * 0.5 + WAY_FRONTAGE[w.cls]);
    if (which === 'plaza') for (const p of PLAZAS) k.addRect(p.x, p.z, p.hw + 2, p.hd + 2, p.rot);
    if (which === 'aq') for (const a of AQUEDUCTS) k.addPath(a.path, 8);
    return k;
  };
  const kinds = { mon: mk('mon'), way: mk('way'), plaza: mk('plaza'), aq: mk('aq') };
  const STEP = 2;
  const CELLA = STEP * STEP;
  const tally = { total: 0, mon: 0, way: 0, plaza: 0, aq: 0, wet: 0, free: 0 };
  const inPoly = (poly, x, z) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]; const b = poly[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    }
    return inside;
  };
  const freePer = new Map();
  const regFree = new Map();
  for (const b of plan.blocks) {
    if (b.kind !== 'block' || b.inset.length < 3) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of b.inset) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
    }
    let free = 0;
    let mon = 0;
    for (let z = z0 + STEP / 2; z < z1; z += STEP) {
      for (let x = x0 + STEP / 2; x < x1; x += STEP) {
        if (!inPoly(b.inset, x, z)) continue;
        tally.total += CELLA;
        let taken = false;
        for (const key of ['mon', 'plaza', 'aq', 'way']) {
          if (kinds[key].blockedRect(x, z, STEP / 2, STEP / 2, 0)) {
            tally[key] += CELLA; taken = true;
            if (key === 'mon') mon += CELLA;
            break;
          }
        }
        if (!taken && inTheRiverAt(x, z)) { tally.wet += CELLA; taken = true; }
        if (!taken) { tally.free += CELLA; free += CELLA; }
      }
    }
    freePer.set(b.index, free);
    const a = regFree.get(b.region.numeral) ?? { free: 0, mon: 0 };
    a.free += free; a.mon += mon;
    regFree.set(b.region.numeral, a);
  }
  const pct = (v) => `${((v / tally.total) * 100).toFixed(1)}%`;
  console.log('');
  console.log(`ground between street lines, rasterised at ${STEP} m: ${(tally.total / 1e4).toFixed(1)} ha`);
  console.log(`   a monument precinct     ${(tally.mon / 1e4).toFixed(1).padStart(6)} ha  ${pct(tally.mon)}`);
  console.log(`   a square                ${(tally.plaza / 1e4).toFixed(1).padStart(6)} ha  ${pct(tally.plaza)}`);
  console.log(`   an aqueduct corridor    ${(tally.aq / 1e4).toFixed(1).padStart(6)} ha  ${pct(tally.aq)}`);
  console.log(`   a way own reservation   ${(tally.way / 1e4).toFixed(1).padStart(6)} ha  ${pct(tally.way)}`);
  console.log(`   the Tiber               ${(tally.wet / 1e4).toFixed(1).padStart(6)} ha  ${pct(tally.wet)}`);
  console.log(`   FREE for fabric         ${(tally.free / 1e4).toFixed(1).padStart(6)} ha  ${pct(tally.free)}`);
  console.log(`FABRIC roof / free ground   = ${((c.roofTotal / tally.free) * 100).toFixed(1)}%   <- grades the generator`);
  console.log(`ALL roof / all ground       = ${(((c.roofTotal + tally.mon) / tally.total) * 100).toFixed(1)}%   <- what an orthophoto measures`);
  console.log(`fabric roof / all ground    = ${((c.roofTotal / tally.total) * 100).toFixed(1)}%   <- the number phase 4 quoted`);
  console.log('by regio, free ground and what the fabric did with it:');
  for (const [num, a] of [...byRegion.entries()].sort((x, y) => y[1].inset - x[1].inset)) {
    const f = regFree.get(num) ?? { free: 0, mon: 0 };
    console.log(`   ${num.padStart(4)}  all ${(a.inset / 1e4).toFixed(1).padStart(5)} ha`
      + `  free ${(f.free / 1e4).toFixed(1).padStart(5)} ha  monument ${(f.mon / 1e4).toFixed(1).padStart(5)} ha`
      + `  fabric/free ${((a.roof / Math.max(1, f.free)) * 100).toFixed(0).padStart(3)}%`
      + `  all-roof/all ${(((a.roof + f.mon) / a.inset) * 100).toFixed(0).padStart(3)}%`);
  }

  // Of the blocks that build nothing, how many have free ground in them?
  const emptyFree = empties.map((p) => freePer.get(p.b.index) ?? 0).sort((a, b) => b - a);
  const gaveUp = emptyFree.filter((v) => v >= 200);
  console.log(`empty blocks with >= 200 m2 of FREE ground in them: ${gaveUp.length} of ${empties.length}`
    + `, holding ${(gaveUp.reduce((s, v) => s + v, 0) / 1e4).toFixed(2)} ha`);
  console.log(`   the other ${empties.length - gaveUp.length} are genuinely occupied or wet`);

  // Name them. A count of give-ups is not actionable; a list with a cause is.
  const byIndex = new Map(out.diag.map((d) => [d.index, d]));
  const rows = empties
    .map((p) => ({ p, free: freePer.get(p.b.index) ?? 0, d: byIndex.get(p.b.index) }))
    .filter((r) => r.free >= 200)
    .sort((a, b) => b.free - a.free);
  console.log('the give-ups, by name:');
  for (const r of rows) {
    const w = r.d?.why ?? {};
    const top = Object.entries(w).filter(([k]) => ['reserved', 'narrow', 'thinned', 'pomerium', 'neighbour', 'shortFrontage', 'tooSmall'].includes(k))
      .sort((a, b2) => b2[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(' ');
    console.log(`   free ${String(Math.round(r.free)).padStart(5)} m2  ${r.p.b.region.numeral.padStart(4)}`
      + ` at (${r.p.b.face.cx.toFixed(0)},${r.p.b.face.cz.toFixed(0)})  inset ${(r.p.b.insetAreaM2 / 1e4).toFixed(2)} ha`
      + `  urban ${r.p.b.urban.toFixed(2)} horti ${r.p.b.horti ? 'y' : 'n'}`
      + `  drowned ${r.d?.drowned ?? '?'}  "${r.d?.emptyBecause}"  [${top}]`);
  }
}
