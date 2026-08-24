#!/usr/bin/env node
/** Where the channel is at a few z, so a camera can be put in it rather than guessed at. */
import {
  WATER_LEVEL, riverCentreX, riverHalfWidthAt, riverBankX, riverOffset, regionalPlain,
  riverInfluence, riverProfile,
} from '../../src/terrain/topography.ts';

const groundAt = (x, z) => {
  const d = riverOffset(x, z);
  const inf = riverInfluence(d, z);
  const plain = regionalPlain(x, z);
  return plain + (riverProfile(d, z, plain) - plain) * inf;
};

console.log('   z   centreX   halfW    bankW    bankE   groundAtCentre');
for (const z of [500, 600, 700, 780, 833, 900, 1000, 1100, 1200, 1277, 1318, 1350]) {
  console.log(
    `${String(z).padStart(5)} ${riverCentreX(z).toFixed(1).padStart(9)} ${riverHalfWidthAt(z).toFixed(1).padStart(7)}`
    + ` ${riverBankX(z, -1).toFixed(1).padStart(8)} ${riverBankX(z, 1).toFixed(1).padStart(8)}`
    + ` ${groundAt(riverCentreX(z), z).toFixed(2).padStart(9)}`);
}
console.log(`\nwater level ${WATER_LEVEL}`);
// A cross-section through the two offenders.
for (const [name, cz] of [['mausoleum-hadrian', 833], ['theatre-marcellus', 1277]]) {
  console.log(`\n${name}: ground across z=${cz}`);
  let line = '';
  for (let x = riverCentreX(cz) - 160; x <= riverCentreX(cz) + 160; x += 20) {
    line += `${x.toFixed(0)}:${groundAt(x, cz).toFixed(1)}  `;
  }
  console.log('  ' + line);
}
