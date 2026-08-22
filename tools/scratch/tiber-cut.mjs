#!/usr/bin/env node
/**
 * Where does the plate-true Tiber stop being usable as this map's river, and why?
 *
 * Two independent limits, both measured here rather than asserted:
 *
 *  1. **Single-valuedness in z.** Everything downstream of `riverCentreX` treats the channel as
 *     x = f(z). Find the northernmost z at which the projected course is still strictly monotone.
 *  2. **The attacker's deployment box**, `DEPLOY_GROUND.north` = cx 340, cz -196, hx 515, hz 130,
 *     feather 80 — x -175..855, z -326..-66, and -255..935 / -406..14 with the feather. A river
 *     inside it is not a river, it is a bug report.
 */
import fs from 'node:fs';
import { worldOf, KX, KZ } from './tiber-plate.mjs';

const C = JSON.parse(fs.readFileSync('tools/scratch/tiber-course.json', 'utf8')).course;
const P = C.map(([e, n]) => ({ ...worldOf(e, n), e, n }));
// order south (high z) to north (low z)
if (P[0].z < P[P.length - 1].z) P.reverse();

// 1. monotonicity walking north
let firstReversal = null;
for (let i = 1; i < P.length; i++) {
  if (P[i].z >= P[i - 1].z - 1e-9) { firstReversal = { i, z: P[i].z, x: P[i].x, prevZ: P[i - 1].z, prevX: P[i - 1].x }; break; }
}
console.log(`course ${P.length} nodes, world z ${P[0].z.toFixed(0)} (south) .. ${P[P.length - 1].z.toFixed(0)} (north)`);
if (firstReversal) {
  console.log(`first reversal in z walking north: node ${firstReversal.i} at z ${firstReversal.z.toFixed(1)} x ${firstReversal.x.toFixed(1)}`
    + ` (previous z ${firstReversal.prevZ.toFixed(1)} x ${firstReversal.prevX.toFixed(1)})`);
  const s = P[firstReversal.i];
  console.log(`  survey e ${s.e.toFixed(0)} n ${s.n.toFixed(0)} = lat ${(41.8925 + s.n / 111320).toFixed(4)} lon ${(12.4823 + s.e / (111320 * Math.cos(41.8925 * Math.PI / 180))).toFixed(4)}`);
} else console.log('no reversal: the whole course is a function of z');

// 2. the deployment box
const BOX = { cx: 340, cz: -196, hx: 515, hz: 130, feather: 80 };
const inBox = (x, z, f) => Math.abs(x - BOX.cx) <= BOX.hx + f && Math.abs(z - BOX.cz) <= BOX.hz + f;
let firstBox = null;
for (let i = 0; i < P.length; i++) {
  if (inBox(P[i].x, P[i].z, BOX.feather)) { firstBox = { i, ...P[i] }; break; }
}
console.log(firstBox
  ? `first node inside the attacker's box + feather: node ${firstBox.i} at x ${firstBox.x.toFixed(0)} z ${firstBox.z.toFixed(0)}`
  : 'the course never enters the attacker\'s box');

// 3. the mean bearing of the reach below any cut, for the continuation
const bearingBelow = (zCut, span) => {
  const a = P.find((p) => p.z <= zCut);
  const b = P.find((p) => p.z <= zCut + span);
  if (!a || !b) return null;
  return { dxdz: (a.x - b.x) / (a.z - b.z), from: b, to: a };
};
for (const zc of [-250, -300, -350, -390, -420]) {
  const br = bearingBelow(zc, 600);
  if (!br) continue;
  const xEdge = br.to.x + br.dxdz * (-1400 - br.to.z);
  console.log(`cut at z ${zc}: node x ${br.to.x.toFixed(0)}, mean dx/dz over the 600 m below = ${br.dxdz.toFixed(3)}`
    + `  -> extended to z -1400 the channel reaches x ${xEdge.toFixed(0)}`);
}

// 4. what the honest river would do inside the map, for the record
const inMap = P.filter((p) => p.z >= -1400 && p.z <= 1400 && p.x >= -1400 && p.x <= 1400);
console.log(`\nnodes of the plate-true course inside the map: ${inMap.length} of ${P.length}`);
const nBox = P.filter((p) => inBox(p.x, p.z, 0)).length;
const nBoxF = P.filter((p) => inBox(p.x, p.z, BOX.feather)).length;
console.log(`nodes inside the attacker's box: ${nBox} (core), ${nBoxF} (with feather) = ${(nBoxF * 4 / 1000).toFixed(2)} km of channel`);
