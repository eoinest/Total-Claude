#!/usr/bin/env node
/**
 * `FAR_BANK` is evaluated at ONE row. A footprint spans many, and the Tiber bends.
 *
 * Prints, row by row across each far-bank monument's own footprint, where the west bank is,
 * where the monument's west and east edges are, and how much of that row is in the channel.
 */
import { LANDMARKS } from '../../src/city/rome/layout.ts';
import { FAR_BANK } from '../../src/city/rome/survey.ts';
import {
  WATER_LEVEL, riverBankX, riverCentreX, riverHalfWidthAt, riverOffset, islandMask,
  regionalPlain, riverInfluence, riverProfile,
} from '../../src/terrain/topography.ts';

const groundAt = (x, z) => {
  const d = riverOffset(x, z);
  const inf = riverInfluence(d, z);
  const plain = regionalPlain(x, z);
  return plain + (riverProfile(d, z, plain) - plain) * inf;
};

for (const id of ['mausoleum-hadrian', 'theatre-marcellus', 'janiculum']) {
  const m = LANDMARKS.find((l) => l.id === id);
  if (!m) { console.log(`${id}: not built`); continue; }
  const c = Math.abs(Math.cos(m.rot)); const s = Math.abs(Math.sin(m.rot));
  const ah = m.hw * c + m.hd * s;
  const ad = m.hw * s + m.hd * c;
  console.log(`\n${id}  centre (${m.x.toFixed(1)}, ${m.z.toFixed(1)})  half-extents ${m.hw.toFixed(1)} x ${m.hd.toFixed(1)}`
    + `  axis-aligned box x ${(m.x - ah).toFixed(1)}..${(m.x + ah).toFixed(1)}  z ${(m.z - ad).toFixed(1)}..${(m.z + ad).toFixed(1)}`);
  console.log(`  FAR_BANK(centre z, 100) = ${FAR_BANK(m.z, 100).toFixed(1)}  -> the override ${m.x <= FAR_BANK(m.z, 100) ? 'is inert (survey x is already west of it)' : 'BINDS'}`);
  console.log('     z   westBank  FAR_BANK-100   boxW     boxE   clearance(boxE to bank)   groundAtBoxE');
  for (let z = m.z - ad; z <= m.z + ad + 0.01; z += Math.max(4, (2 * ad) / 12)) {
    const bw = riverBankX(z, -1);
    console.log(
      `${z.toFixed(0).padStart(6)} ${bw.toFixed(1).padStart(9)} ${(bw - 100).toFixed(1).padStart(12)}`
      + ` ${(m.x - ah).toFixed(1).padStart(8)} ${(m.x + ah).toFixed(1).padStart(8)}`
      + ` ${(bw - (m.x + ah)).toFixed(1).padStart(22)} ${groundAt(m.x + ah, z).toFixed(2).padStart(14)}`);
  }
}
console.log(`\nwater level ${WATER_LEVEL} m. A negative clearance means the box's east edge is east of the west bank — i.e. in the river.`);
