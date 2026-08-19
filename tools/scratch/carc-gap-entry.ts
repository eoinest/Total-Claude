/**
 * Where the howdah actually separates from the back — scratch, carcass workstream.
 *
 * Splits the tower group into its two halves (the timber, tint `Atlas`, and the caparison,
 * tint `Tunic`) and tracks each vertex against the hide vertex nearest it in the rest pose.
 * It also runs the named-cause control: the same tower vertices skinned with `barrel` alone
 * against the shipped `barrel 0.72 / loin 0.28` blend. If that control is not zero, the bind
 * is the mechanism; if it is, something else is.
 */
import { ELEPHANT_RIG, EB } from '../../src/anim/rig';
import { frameGlobals } from '../../src/anim/pose';
import { ELEPHANT_CLIP, ELEPHANT_CLIP_SET } from '../../src/anim/elephantClips';
import { buildElephantGeometry, ElephantPiece } from '../../src/units/elephantMesh';

const rig = ELEPHANT_RIG;
const n = rig.boneCount;
const geo = buildElephantGeometry();
const pos = geo.getAttribute('position').array as Float32Array;
const skin = geo.getAttribute('aSkin').array as Float32Array;
const pt = geo.getAttribute('aPieceTint').array as Float32Array;
const vcount = pos.length / 3;

const bq = new Float32Array(n * 4);
const bt = new Float32Array(n * 3);
const wq = new Float32Array(n * 4);
const wt = new Float32Array(n * 3);

function boneMats(f: number): void {
  frameGlobals(rig, ELEPHANT_CLIP_SET.clips[ELEPHANT_CLIP.death], f, wq, wt);
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

function byBone(v: number, b: number, w: number, out: number[]): void {
  const px = pos[v * 3], py = pos[v * 3 + 1], pz = pos[v * 3 + 2];
  const qx = bq[b * 4], qy = bq[b * 4 + 1], qz = bq[b * 4 + 2], qw = bq[b * 4 + 3];
  const cx = 2 * (qy * pz - qz * py);
  const cy = 2 * (qz * px - qx * pz);
  const cz = 2 * (qx * py - qy * px);
  out[0] += (px + qw * cx + (qy * cz - qz * cy) + bt[b * 3]) * w;
  out[1] += (py + qw * cy + (qz * cx - qx * cz) + bt[b * 3 + 1]) * w;
  out[2] += (pz + qw * cz + (qx * cy - qy * cx) + bt[b * 3 + 2]) * w;
}

const tmp: number[] = [0, 0, 0];
function skinVert(v: number): number[] {
  tmp[0] = 0; tmp[1] = 0; tmp[2] = 0;
  for (let k = 0; k < 2; k++) {
    const w = skin[v * 4 + 2 + k];
    if (w > 0.002) byBone(v, skin[v * 4 + k], w, tmp);
  }
  return tmp;
}
const tmp2: number[] = [0, 0, 0];
function skinAs(v: number, b: number): number[] {
  tmp2[0] = 0; tmp2[1] = 0; tmp2[2] = 0;
  byBone(v, b, 1, tmp2);
  return tmp2;
}

const hide: number[] = [];
const capar: number[] = [];
const wood: number[] = [];
for (let v = 0; v < vcount; v++) {
  const p = pt[v * 4], t = pt[v * 4 + 1];
  if (p === ElephantPiece.Body) hide.push(v);
  else if (p === ElephantPiece.Tower) (t === 1 ? capar : wood).push(v);
}
const near = (set: number[]): { v: number; h: number; d0: number }[] => set.map((v) => {
  let best = -1, bd = Infinity;
  for (const h of hide) {
    const d = (pos[h * 3] - pos[v * 3]) ** 2 + (pos[h * 3 + 1] - pos[v * 3 + 1]) ** 2
      + (pos[h * 3 + 2] - pos[v * 3 + 2]) ** 2;
    if (d < bd) { bd = d; best = h; }
  }
  return { v, h: best, d0: Math.sqrt(bd) };
});
const caparP = near(capar);
const woodP = near(wood);

const clip = ELEPHANT_CLIP_SET.clips[ELEPHANT_CLIP.death];
const rows: Record<string, number>[] = [];
for (let f = 0; f < clip.frames; f++) {
  boneMats(f);
  const stat = (ps: { v: number; h: number; d0: number }[]): number => {
    let m = 0;
    for (const p of ps) {
      const a = skinVert(p.v).slice();
      const b = skinVert(p.h);
      const g = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) - p.d0;
      if (g > m) m = g;
    }
    return +m.toFixed(4);
  };
  // Control: the shipped blend against a pure `barrel` bind on the same vertices.
  let bindDelta = 0;
  for (const v of wood.concat(capar)) {
    const a = skinVert(v).slice();
    const b = skinAs(v, EB.barrel);
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (d > bindDelta) bindDelta = d;
  }
  rows.push({
    f, t: +(f / (clip.frames - 1)).toFixed(2),
    caparGap: stat(caparP), woodGap: stat(woodP), bindDelta: +bindDelta.toFixed(6),
  });
}
console.log(JSON.stringify({ capar: capar.length, wood: wood.length, rows }, null, 0));
