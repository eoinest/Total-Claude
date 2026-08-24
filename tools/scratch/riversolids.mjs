#!/usr/bin/env node
/**
 * How much of each solid's FOOTPRINT stands in the Tiber — the measurement G22 does not make.
 *
 * G22 samples five points (centre + four corners) and gates on the centre. This rasterises the
 * whole oriented rectangle at 2 m and reports the wet AREA, which is the unit the complaint is
 * in: "there are some big buildings still in the river".
 *
 * Offline: it uses the terrain's own analytic ground rather than the baked mesh, so the numbers
 * are the model's and not the rasteriser's. Cross-checked in the browser by probe-fabric G22.
 */
import { LANDMARKS } from '../../src/city/rome/layout.ts';
import {
  WATER_LEVEL, islandMask, regionalPlain, riverInfluence, riverOffset, riverProfile,
  riverHalfWidthAt,
} from '../../src/terrain/topography.ts';

const groundAt = (x, z) => {
  const d = riverOffset(x, z);
  const inf = riverInfluence(d, z);
  const plain = regionalPlain(x, z);
  return plain + (riverProfile(d, z, plain) - plain) * inf;
};
const inChannel = (x, z) =>
  islandMask(x, z) <= 0.4 && Math.abs(riverOffset(x, z)) < riverHalfWidthAt(z);

const STEP = 2;
/** Rasterise an oriented rectangle; return wet and in-channel area. */
function scan(x, z, hw, hd, rot) {
  const c = Math.cos(rot); const s = Math.sin(rot);
  let n = 0; let wet = 0; let chan = 0; let worst = Infinity; let wx = 0; let wz = 0;
  const nu = Math.max(1, Math.round((2 * hw) / STEP));
  const nv = Math.max(1, Math.round((2 * hd) / STEP));
  for (let iu = 0; iu < nu; iu++) {
    const u = -hw + (iu + 0.5) * (2 * hw / nu);
    for (let iv = 0; iv < nv; iv++) {
      const v = -hd + (iv + 0.5) * (2 * hd / nv);
      const px = x + u * c - v * s;
      const pz = z + u * s + v * c;
      n++;
      const g = groundAt(px, pz);
      if (g <= WATER_LEVEL) wet++;
      if (inChannel(px, pz)) chan++;
      if (g < worst) { worst = g; wx = px; wz = pz; }
    }
  }
  const cell = (2 * hw / nu) * (2 * hd / nv);
  return {
    area: n * cell, wetM2: wet * cell, chanM2: chan * cell,
    wetFrac: wet / n, chanFrac: chan / n, worst, wx, wz,
  };
}

const rows = [];
for (const m of LANDMARKS) {
  const r = scan(m.x, m.z, m.hw, m.hd, m.rot);
  const cd = groundAt(m.x, m.z);
  if (r.wetM2 > 0 || r.chanM2 > 0) {
    rows.push({
      kind: m.soft ? 'monument(soft)' : 'monument', id: m.id, name: m.name,
      x: m.x, z: m.z, ...r, centreDatum: cd, centreWet: cd <= WATER_LEVEL,
    });
  }
}

const plots = [];
rows.sort((a, b) => b.wetM2 - a.wetM2);
console.log(`water level ${WATER_LEVEL} m; ${LANDMARKS.length} landmarks, ${plots.length} plots`);
console.log(`solids with ANY wet ground under them: ${rows.length}`);
console.log(`  centre-wet (all G22 gates)           : ${rows.filter((r) => r.centreWet).length}`);
console.log(`  >= 10% of footprint wet              : ${rows.filter((r) => r.wetFrac >= 0.1).length}`);
console.log(`  any ground INSIDE the drawn channel  : ${rows.filter((r) => r.chanM2 > 0).length}`);
console.log('');
console.log('kind             id                        x       z    area  wetM2  wet%  chan%  worst  centre  G22?');
for (const r of rows.slice(0, 40)) {
  console.log(
    `${r.kind.padEnd(16)} ${String(r.id).padEnd(22)} ${r.x.toFixed(0).padStart(6)} ${r.z.toFixed(0).padStart(7)}`
    + ` ${r.area.toFixed(0).padStart(7)} ${r.wetM2.toFixed(0).padStart(6)} ${(r.wetFrac * 100).toFixed(0).padStart(5)}`
    + ` ${(r.chanFrac * 100).toFixed(0).padStart(6)} ${r.worst.toFixed(2).padStart(6)} ${r.centreDatum.toFixed(2).padStart(7)}`
    + `  ${r.centreWet ? 'FAIL' : 'pass'}`);
}
