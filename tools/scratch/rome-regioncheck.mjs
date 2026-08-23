#!/usr/bin/env node
/**
 * Does `src/city/rome/regions.ts` actually tile the frame?
 *
 * Runs `assertRegionPartition` outside the browser — Node's type stripping loads the module
 * directly, so this grades the shipped table rather than a copy of it. Also samples the
 * battlefield square on an 8 m grid, the same pitch `probe-fabric` G19 uses, and reports
 * claimed-over-available and covered-over-available *before* a browser is involved. The probe
 * remains the gate; this is the thirty-second version of it while the table is being written.
 *
 *   node --experimental-strip-types tools/scratch/rome-regioncheck.mjs
 */
import { REGIONS, OFF_FRAME_REGIONES, assertRegionPartition, regionAt, regionFallbacks }
  from '../../src/city/rome/regions.ts';
import { HALF_EXTENT } from '../../src/terrain/topography.ts';

const a = assertRegionPartition();
console.log('partition:', JSON.stringify(a));
for (const g of REGIONS) {
  console.log(' ', g.numeral.padStart(4), g.id.padEnd(30), (g.areaM2 / 1e6).toFixed(3) + ' km2',
    ' bb x', g.bb.x0.toFixed(0).padStart(6), g.bb.x1.toFixed(0).padStart(6),
    ' z', g.bb.z0.toFixed(0).padStart(6), g.bb.z1.toFixed(0).padStart(6));
}
console.log('off frame:', OFF_FRAME_REGIONES.map((r) => `${r.numeral} ${r.name}`).join(', '));

const inRing = (p, x, z) => {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i].z > z) !== (p[j].z > z)) {
      const t = (z - p[i].z) / (p[j].z - p[i].z);
      if (x < p[i].x + t * (p[j].x - p[i].x)) inside = !inside;
    }
  }
  return inside;
};

const sweep = (zFrom, label) => {
  const STEP = 8;
  let cells = 0;
  let claimed = 0;
  let covered = 0;
  const per = new Map();
  for (let z = zFrom; z <= HALF_EXTENT; z += STEP) {
    for (let x = -HALF_EXTENT; x <= HALF_EXTENT; x += STEP) {
      cells++;
      let n = 0;
      for (const r of REGIONS) {
        if (x < r.bb.x0 || x > r.bb.x1 || z < r.bb.z0 || z > r.bb.z1) continue;
        if (!inRing(r.poly, x, z)) continue;
        n++;
        per.set(r.numeral, (per.get(r.numeral) ?? 0) + 1);
      }
      claimed += n;
      if (n > 0) covered++;
    }
  }
  console.log(`${label}: ${cells} cells, claimed/cells ${(claimed / cells).toFixed(4)},`
    + ` covered/cells ${(covered / cells).toFixed(4)}`);
  console.log('  per region:', [...per.entries()].sort((p, q) => q[1] - p[1])
    .map(([k, v]) => `${k} ${(v * 64 / 1e6).toFixed(2)}km2`).join('  '));
};

sweep(-HALF_EXTENT, 'whole square');
sweep(520, 'behind z=520 (the ground a region is responsible for)');
console.log('regionAt fallbacks:', regionFallbacks(),
  '| spot checks — Campus Martius', regionAt(-160, 830).numeral,
  ', far bank', regionAt(-900, 900).numeral,
  ', Quirinal', regionAt(600, 950).numeral,
  ', Forum', regionAt(410, 1250).numeral);
