/**
 * Offline skinner for the war elephant — scratch, owned by the carcass workstream.
 *
 * Runs the death clip's forward kinematics over the *real* geometry `buildElephantGeometry`
 * emits and reports the numbers a screenshot cannot give: the lowest skinned vertex on every
 * frame (ground penetration), the clearance between the howdah's floor and the hide it is
 * lashed to (the separation defect), and where each foot pad finishes.
 *
 * Bundled with rolldown and run in node, so it needs no browser and no dev server.
 */
import { ELEPHANT_RIG } from '../../src/anim/rig';
import { frameGlobals } from '../../src/anim/pose';
import { ELEPHANT_CLIP, ELEPHANT_CLIP_SET } from '../../src/anim/elephantClips';
import { buildElephantGeometry, ElephantPiece } from '../../src/units/elephantMesh';

const rig = ELEPHANT_RIG;
const n = rig.boneCount;
const geo = buildElephantGeometry();
const pos = geo.getAttribute('position').array as Float32Array;
const skin = geo.getAttribute('aSkin').array as Float32Array;
const piece = geo.getAttribute('aPieceTint').array as Float32Array;
const vcount = pos.length / 3;

const wq = new Float32Array(n * 4);
const wt = new Float32Array(n * 3);
const bq = new Float32Array(n * 4);
const bt = new Float32Array(n * 3);

function boneMats(clipIdx: number, f: number): void {
  const clip = ELEPHANT_CLIP_SET.clips[clipIdx];
  frameGlobals(rig, clip, f, wq, wt);
  for (let b = 0; b < n; b++) {
    const ax = wq[b * 4], ay = wq[b * 4 + 1], az = wq[b * 4 + 2], aw = wq[b * 4 + 3];
    const ix = rig.bindInvQ[b * 4], iy = rig.bindInvQ[b * 4 + 1];
    const iz = rig.bindInvQ[b * 4 + 2], iw = rig.bindInvQ[b * 4 + 3];
    bq[b * 4] = aw * ix + ax * iw + ay * iz - az * iy;
    bq[b * 4 + 1] = aw * iy - ax * iz + ay * iw + az * ix;
    bq[b * 4 + 2] = aw * iz + ax * iy - ay * ix + az * iw;
    bq[b * 4 + 3] = aw * iw - ax * ix - ay * iy - az * iz;
    const vx = rig.bindInvT[b * 3], vy = rig.bindInvT[b * 3 + 1], vz = rig.bindInvT[b * 3 + 2];
    const cx = 2 * (ay * vz - az * vy);
    const cy = 2 * (az * vx - ax * vz);
    const cz = 2 * (ax * vy - ay * vx);
    bt[b * 3] = vx + aw * cx + (ay * cz - az * cy) + wt[b * 3];
    bt[b * 3 + 1] = vy + aw * cy + (az * cx - ax * cz) + wt[b * 3 + 1];
    bt[b * 3 + 2] = vz + aw * cz + (ax * cy - ay * cx) + wt[b * 3 + 2];
  }
}

const out3: [number, number, number] = [0, 0, 0];
function skinVert(v: number): [number, number, number] {
  const px = pos[v * 3], py = pos[v * 3 + 1], pz = pos[v * 3 + 2];
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < 2; k++) {
    const b = skin[v * 4 + k];
    const w = skin[v * 4 + 2 + k];
    if (w <= 0.002) continue;
    const qx = bq[b * 4], qy = bq[b * 4 + 1], qz = bq[b * 4 + 2], qw = bq[b * 4 + 3];
    const cx = 2 * (qy * pz - qz * py);
    const cy = 2 * (qz * px - qx * pz);
    const cz = 2 * (qx * py - qy * px);
    x += (px + qw * cx + (qy * cz - qz * cy) + bt[b * 3]) * w;
    y += (py + qw * cy + (qz * cx - qx * cz) + bt[b * 3 + 1]) * w;
    z += (pz + qw * cz + (qx * cy - qy * cx) + bt[b * 3 + 2]) * w;
  }
  out3[0] = x; out3[1] = y; out3[2] = z;
  return out3;
}

/** Vertex index sets we care about, chosen in the rest pose once. */
const hideIdx: number[] = [];
const towerIdx: number[] = [];
for (let v = 0; v < vcount; v++) {
  const p = piece[v * 4];
  if (p === ElephantPiece.Body) hideIdx.push(v);
  else if (p === ElephantPiece.Tower) towerIdx.push(v);
}

/**
 * The separation pairs: every tower vertex within 0.45 m of a hide vertex in the rest pose,
 * paired with its nearest one. If the tower and the hide skinned identically these distances
 * would never change; every millimetre they grow is daylight opening under the caparison.
 */
const pairs: { t: number; h: number; d0: number }[] = [];
for (const t of towerIdx) {
  const tx = pos[t * 3], ty = pos[t * 3 + 1], tz = pos[t * 3 + 2];
  // Only the underside of the tower group can show a gap.
  if (ty > 3.30) continue;
  let best = -1, bd = Infinity;
  for (const h of hideIdx) {
    const d = (pos[h * 3] - tx) ** 2 + (pos[h * 3 + 1] - ty) ** 2 + (pos[h * 3 + 2] - tz) ** 2;
    if (d < bd) { bd = d; best = h; }
  }
  const d0 = Math.sqrt(bd);
  if (d0 < 0.45) pairs.push({ t: best === -1 ? t : t, h: best, d0 });
}

const limbOf: Record<number, string> = {};
for (const [g, names] of Object.entries({
  FL: ['fShoulderL', 'fUpperL', 'fKneeL', 'fFootL'],
  FR: ['fShoulderR', 'fUpperR', 'fKneeR', 'fFootR'],
  HL: ['bHipL', 'bFemurL', 'bHockL', 'bFootL'],
  HR: ['bHipR', 'bFemurR', 'bHockR', 'bFootR'],
  trunk: ['trunk1', 'trunk2', 'trunk3', 'trunk4'],
  head: ['head', 'neck', 'earL', 'earR'],
})) for (const nm of names) limbOf[rig.bone(nm)] = g;

const feet = ['fFootL', 'fFootR', 'bFootL', 'bFootR'].map((s) => rig.bone(s));

const clip = ELEPHANT_CLIP_SET.clips[ELEPHANT_CLIP.death];
const rows: Record<string, unknown>[] = [];
for (let f = 0; f < clip.frames; f++) {
  boneMats(ELEPHANT_CLIP.death, f);
  let lo = Infinity, loV = -1;
  let loBody = Infinity;
  const limbLo: Record<string, number> = {};
  for (let v = 0; v < vcount; v++) {
    const p = skinVert(v);
    if (p[1] < lo) { lo = p[1]; loV = v; }
    if (piece[v * 4] === ElephantPiece.Body && p[1] < loBody) loBody = p[1];
    const g = limbOf[skin[v * 4]];
    if (g && (limbLo[g] === undefined || p[1] < limbLo[g])) limbLo[g] = p[1];
  }
  for (const k of Object.keys(limbLo)) limbLo[k] = +limbLo[k].toFixed(3);
  let maxGap = 0, sumGap = 0;
  for (const pr of pairs) {
    const a = skinVert(pr.t).slice() as [number, number, number];
    const bb = skinVert(pr.h);
    const d = Math.hypot(a[0] - bb[0], a[1] - bb[1], a[2] - bb[2]);
    const g = d - pr.d0;
    if (g > maxGap) maxGap = g;
    sumGap += Math.max(0, g);
  }
  const footY = feet.map((b) => +(bt[b * 3 + 1] + wq[0] * 0).toFixed(3));
  rows.push({
    f,
    t: +(f / (clip.frames - 1)).toFixed(3),
    lowestVert: +lo.toFixed(4),
    lowestVertPiece: piece[loV * 4],
    lowestBone: rig.names[skin[loV * 4]],
    limbLo,
    lowestBody: +loBody.toFixed(4),
    gapMax: +maxGap.toFixed(4),
    gapMean: +(sumGap / pairs.length).toFixed(4),
    footY,
  });
}
console.log(JSON.stringify({ pairs: pairs.length, verts: vcount, tris: geo.getIndex()!.count / 3, rows }, null, 0));
