#!/usr/bin/env node
/**
 * Does the monument fit in the gap the projection leaves it? `MAP-METHOD.md` rule 10, one
 * level up, and rule 22's mirror: a FOOTPRINT held in world metres is a variable clearance in
 * real metres, because the gap between it and the river compresses and it does not.
 *
 * For each far-bank / riverside monument: the real clearance from its survey row to the
 * surveyed channel, the same clearance projected, and the footprint's own half-reach in world
 * metres. Then a sweep of candidate `draw` scales against the wet area they leave.
 */
import { LANDMARKS } from '../../src/city/rome/layout.ts';
import { ROME, worldOf } from '../../src/city/rome/survey.ts';
import { TIBER_SURVEY } from '../../src/terrain/tiberSurvey.ts';
import {
  WATER_LEVEL, KX, KZ, riverBankX, riverOffset, riverHalfWidthAt, islandMask,
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
  return { area: n * cell, wetM2: wet * cell, chanM2: chan * cell, wetFrac: wet / n, worst };
}

/** Nearest surveyed channel station to a survey point, in REAL metres. */
function realClearance(e, n) {
  let best = Infinity; let at = null;
  for (const [se, sn, w] of TIBER_SURVEY) {
    const d = Math.hypot(se - e, sn - n) - w * 0.5;
    if (d < best) { best = d; at = [se, sn, w]; }
  }
  return { d: best, at };
}

for (const id of ['mausoleum-hadrian', 'theatre-marcellus', 'tiber-island']) {
  const row = ROME.find((r) => r.id === id);
  const m = LANDMARKS.find((l) => l.id === id);
  if (!row || !m) continue;
  const rc = realClearance(row.e, row.n);
  const w = worldOf(row.e, row.n);
  console.log(`\n=== ${id} ===`);
  console.log(`  survey e ${row.e} n ${row.n} -> world (${w.x.toFixed(1)}, ${w.z.toFixed(1)}); built at (${m.x.toFixed(1)}, ${m.z.toFixed(1)})`);
  console.log(`  real published plan ${row.len} x ${row.wid} m; draw ${row.draw ?? '(none -> 1)'}; built half-extents ${m.hw.toFixed(1)} x ${m.hd.toFixed(1)} WORLD m`);
  console.log(`  real clearance survey point -> nearest channel EDGE: ${rc.d.toFixed(0)} real m (station e ${rc.at[0]} n ${rc.at[1]}, width ${rc.at[2]})`);
  console.log(`  that clearance PROJECTED: ${(rc.d * KX).toFixed(0)} world m if the reach runs N-S, ${(rc.d * KZ).toFixed(0)} if it runs E-W`);
  console.log(`  the footprint's own half-reach is ${Math.max(m.hw, m.hd).toFixed(0)} world m and does NOT compress`);
  const base = scan(m.x, m.z, m.hw, m.hd, m.rot);
  console.log(`  as built: ${base.wetM2.toFixed(0)} m2 wet of ${base.area.toFixed(0)} (${(base.wetFrac * 100).toFixed(0)}%), worst ground ${base.worst.toFixed(2)} m`);
  const cur = row.draw ?? 1;
  console.log('   draw   hw     hd    wet m2   wet%   chan m2   worst');
  for (const d of [1, 0.8, 0.667, 0.6, 0.5, 0.443, 0.4, 0.35, 0.3]) {
    const k = d / cur;
    const r = scan(m.x, m.z, m.hw * k, m.hd * k, m.rot);
    console.log(`  ${d.toFixed(3)} ${(m.hw * k).toFixed(1).padStart(6)} ${(m.hd * k).toFixed(1).padStart(6)}`
      + ` ${r.wetM2.toFixed(0).padStart(8)} ${(r.wetFrac * 100).toFixed(1).padStart(6)} ${r.chanM2.toFixed(0).padStart(9)} ${r.worst.toFixed(2).padStart(7)}`);
  }
}

// What the far-bank bound would have to be to clear the footprint.
const m = LANDMARKS.find((l) => l.id === 'mausoleum-hadrian');
const c = Math.abs(Math.cos(m.rot)); const s = Math.abs(Math.sin(m.rot));
const ah = m.hw * c + m.hd * s; const ad = m.hw * s + m.hd * c;
let minBank = Infinity;
for (let z = m.z - ad; z <= m.z + ad; z += 2) minBank = Math.min(minBank, riverBankX(z, -1));
console.log(`\nmausoleum-hadrian: min west bank over its own z span = ${minBank.toFixed(1)};`
  + ` a footprint-aware FAR_BANK at clearance 0 would put its centre at ${(minBank - ah).toFixed(1)},`
  + ` i.e. ${(m.x - (minBank - ah)).toFixed(0)} m west of where it stands.`);
