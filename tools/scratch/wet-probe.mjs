#!/usr/bin/env node
/** How much of Rome's block ground the river test condemns, and how deep the margin is. */
import '../../src/terrain/topography.ts';
import '../../src/city/rome/survey.ts';
import '../../src/city/rome/apertures.ts';
import '../../src/city/rome/section.ts';
import '../../src/city/rome/monuments.ts';
import '../../src/city/rome/ways.ts';
import '../../src/city/rome/layout.ts';
import { cityPlan, buildDistricts, inTheRiverAt } from '../../src/city/rome/fabric.ts';
import { romeKeepOut } from '../../src/city/rome/layout.ts';
import { romeWallZ, WATER_LEVEL, islandMask, regionalPlain, riverInfluence, riverOffset, riverProfile } from '../../src/terrain/topography.ts';

const groundAt = (x, z) => {
  const d = riverOffset(x, z);
  const inf = riverInfluence(d, z);
  const plain = regionalPlain(x, z);
  return plain + (riverProfile(d, z, plain) - plain) * inf;
};

const plan = cityPlan();
const STEP = 4;
const inPoly = (poly, x, z) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]; const b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
};
const per = new Map();
const bands = { under0: 0, b0_1: 0, b1_2: 0, b2_28: 0, over28: 0, dry: 0 };
let total = 0;
for (const b of plan.blocks) {
  if (b.kind !== 'block' || b.inset.length < 3) continue;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of b.inset) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z; }
  const acc = per.get(b.region.numeral) ?? { total: 0, wet: 0 };
  for (let z = z0 + 2; z < z1; z += STEP) {
    for (let x = x0 + 2; x < x1; x += STEP) {
      if (!inPoly(b.inset, x, z)) continue;
      const A = STEP * STEP;
      total += A; acc.total += A;
      const wet = inTheRiverAt(x, z);
      if (wet) acc.wet += A;
      const inf = riverInfluence(riverOffset(x, z), z);
      const free = islandMask(x, z) > 0.4 || inf <= 0.001 ? 99 : groundAt(x, z) - WATER_LEVEL;
      if (free < 0) bands.under0 += A;
      else if (free < 1) bands.b0_1 += A;
      else if (free < 2) bands.b1_2 += A;
      else if (free < 2.8) bands.b2_28 += A;
      else if (free < 90) bands.over28 += A;
      else bands.dry += A;
    }
  }
  per.set(b.region.numeral, acc);
}
const pc = (v) => `${((v / total) * 100).toFixed(1)}%`;
console.log(`block ground ${(total / 1e4).toFixed(1)} ha, freeboard above WATER_LEVEL=${WATER_LEVEL}:`);
console.log(`   below water        ${(bands.under0 / 1e4).toFixed(2).padStart(6)} ha ${pc(bands.under0)}`);
console.log(`   0 - 1 m            ${(bands.b0_1 / 1e4).toFixed(2).padStart(6)} ha ${pc(bands.b0_1)}`);
console.log(`   1 - 2 m            ${(bands.b1_2 / 1e4).toFixed(2).padStart(6)} ha ${pc(bands.b1_2)}`);
console.log(`   2 - 2.8 m          ${(bands.b2_28 / 1e4).toFixed(2).padStart(6)} ha ${pc(bands.b2_28)}`);
console.log(`   >= 2.8 m (in reach)${(bands.over28 / 1e4).toFixed(2).padStart(6)} ha ${pc(bands.over28)}`);
console.log(`   out of river reach ${(bands.dry / 1e4).toFixed(2).padStart(6)} ha ${pc(bands.dry)}`);
console.log('wet block ground by regio (point test):');
for (const [n, a] of [...per.entries()].sort((x, y) => y[1].wet - x[1].wet)) {
  console.log(`   ${n.padStart(4)}  ${(a.total / 1e4).toFixed(2).padStart(6)} ha  wet ${(a.wet / 1e4).toFixed(2).padStart(6)} ha  ${((a.wet / a.total) * 100).toFixed(1)}%`);
}

// and the plots the nine-sample box test actually kills
const out = buildDistricts(() => 20, romeKeepOut(), 'rome-fabric', romeWallZ);
console.log(`plots dropped as wet: ${out.report.plotRejects.wet}`);
