#!/usr/bin/env node
/**
 * What each candidate repair costs, in metres, for the two monuments in the Tiber.
 *
 * Three axes, swept independently against the same wet-area measure `probe-fabric` G22 now
 * gates on: a plan scale (`draw`), a displacement north (−z), and a displacement west (−x).
 * The point is to put a price on each option rather than to pick one — the choice between
 * survey position and published size is the owner's.
 */
import { LANDMARKS } from '../../src/city/rome/layout.ts';
import { ROME } from '../../src/city/rome/survey.ts';
import {
  WATER_LEVEL, riverOffset, riverHalfWidthAt, islandMask,
  regionalPlain, riverInfluence, riverProfile,
} from '../../src/terrain/topography.ts';

const groundAt = (x, z) => {
  const d = riverOffset(x, z);
  const inf = riverInfluence(d, z);
  const plain = regionalPlain(x, z);
  return plain + (riverProfile(d, z, plain) - plain) * inf;
};
const inChannel = (x, z) =>
  islandMask(x, z) <= 0.4 && Math.abs(riverOffset(x, z)) < riverHalfWidthAt(z);

const STEP = 1.5;
function scan(x, z, hw, hd, rot) {
  const c = Math.cos(rot); const s = Math.sin(rot);
  let n = 0; let wet = 0; let chan = 0; let worst = Infinity;
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
      if (g < worst) worst = g;
    }
  }
  const cell = (2 * hw / nu) * (2 * hd / nv);
  return { wetM2: wet * cell, chanM2: chan * cell, worst };
}

for (const id of ['mausoleum-hadrian', 'theatre-marcellus']) {
  const m = LANDMARKS.find((l) => l.id === id);
  const row = ROME.find((r) => r.id === id);
  const cur = row.draw ?? 1;
  console.log(`\n=== ${id} — G22's gate is 4 m2 of wet plan ===`);
  console.log(`  as built: draw ${cur}, at (${m.x.toFixed(1)}, ${m.z.toFixed(1)})`);
  const drawnH = (row.drawY ?? row.draw ?? 1);
  console.log(`  drawn height scale ${drawnH} — a plan change moves this too unless drawY is authored separately (rule 14)`);

  console.log('  A. shrink the plan');
  for (const d of [cur, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3]) {
    const k = d / cur;
    const r = scan(m.x, m.z, m.hw * k, m.hd * k, m.rot);
    console.log(`     draw ${d.toFixed(3)}  wet ${r.wetM2.toFixed(0).padStart(6)} m2  channel ${r.chanM2.toFixed(0).padStart(6)}`
      + `  worst ${r.worst.toFixed(2).padStart(6)}  ${r.wetM2 <= 4 ? 'CLEARS' : ''}`);
  }
  console.log('  B. move it north (-z), plan unchanged');
  for (const dz of [0, -10, -20, -30, -40, -50, -60, -80, -100]) {
    const r = scan(m.x, m.z + dz, m.hw, m.hd, m.rot);
    console.log(`     dz ${String(dz).padStart(5)}  wet ${r.wetM2.toFixed(0).padStart(6)} m2  channel ${r.chanM2.toFixed(0).padStart(6)}`
      + `  worst ${r.worst.toFixed(2).padStart(6)}  ${r.wetM2 <= 4 ? 'CLEARS' : ''}`);
  }
  console.log('  C. move it west (-x), plan unchanged');
  for (const dx of [0, -20, -40, -60, -80, -100, -120]) {
    const r = scan(m.x + dx, m.z, m.hw, m.hd, m.rot);
    console.log(`     dx ${String(dx).padStart(5)}  wet ${r.wetM2.toFixed(0).padStart(6)} m2  channel ${r.chanM2.toFixed(0).padStart(6)}`
      + `  worst ${r.worst.toFixed(2).padStart(6)}  ${r.wetM2 <= 4 ? 'CLEARS' : ''}`);
  }
}
