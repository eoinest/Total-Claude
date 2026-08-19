/**
 * Death-pose explorer — scratch, owned by the carcass workstream.
 *
 * Builds a candidate death clip from a JSON track table in `CARC_TRACKS`, skins the real
 * elephant geometry over it and reports the numbers that decide the pose: the lowest skinned
 * vertex per limb per frame, the howdah-to-hide separation, and the settled foot positions.
 * Hand-searching four limbs against a screenshot is six browser round trips per guess; this
 * is forty milliseconds.
 */
import { ELEPHANT_RIG, EB } from '../../src/anim/rig';
import { buildOverlay, restClip, type BoneTrack } from '../../src/anim/pose';
import { frameGlobals } from '../../src/anim/pose';
import { buildElephantGeometry, ElephantPiece } from '../../src/units/elephantMesh';

const rig = ELEPHANT_RIG;
const n = rig.boneCount;
const geo = buildElephantGeometry();
const pos = geo.getAttribute('position').array as Float32Array;
const skin = geo.getAttribute('aSkin').array as Float32Array;
const piece = geo.getAttribute('aPieceTint').array as Float32Array;
const vcount = pos.length / 3;

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const spec = JSON.parse(env.CARC_TRACKS ?? '{}') as {
  frames?: number;
  duration?: number;
  tracks: Record<string, [number, number, number, number][]>;
  root: [number, number, number, number][];
};

const tracks: BoneTrack[] = Object.entries(spec.tracks).map(([name, keys]) => ({
  bone: (EB as unknown as Record<string, number>)[name] ?? rig.bone(name),
  keys,
}));

const base = restClip(rig, 'elephant-rest', 1);
const clip = buildOverlay(rig, base, {
  name: 'death',
  frames: spec.frames ?? 26,
  duration: spec.duration ?? 2.6,
  loop: false,
  tracks,
  root: spec.root,
});

const wq = new Float32Array(n * 4);
const wt = new Float32Array(n * 3);
const bq = new Float32Array(n * 4);
const bt = new Float32Array(n * 3);

function boneMats(f: number): void {
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

const sv: [number, number, number] = [0, 0, 0];
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
  sv[0] = x; sv[1] = y; sv[2] = z;
  return sv;
}

const GROUPS: Record<string, string[]> = {
  FL: ['fShoulderL', 'fUpperL', 'fKneeL', 'fFootL'],
  FR: ['fShoulderR', 'fUpperR', 'fKneeR', 'fFootR'],
  HL: ['bHipL', 'bFemurL', 'bHockL', 'bFootL'],
  HR: ['bHipR', 'bFemurR', 'bHockR', 'bFootR'],
  trunk: ['trunk1', 'trunk2', 'trunk3', 'trunk4'],
  head: ['head', 'neck'],
  earL: ['earL'],
  earR: ['earR'],
  body: ['root', 'croup', 'loin', 'barrel', 'withers'],
};
const limbOf: Record<number, string> = {};
for (const [g, names] of Object.entries(GROUPS)) for (const nm of names) limbOf[rig.bone(nm)] = g;

const hideIdx: number[] = [];
const towerIdx: number[] = [];
for (let v = 0; v < vcount; v++) {
  // Only spine-bound hide: the caparison's nearest neighbour would otherwise be a shoulder
  // or a leg vertex, and re-authoring the legs would then read as a howdah separation.
  if (piece[v * 4] === ElephantPiece.Body && limbOf[skin[v * 4]] === 'body') hideIdx.push(v);
  else if (piece[v * 4] === ElephantPiece.Tower && pos[v * 3 + 1] <= 3.30) towerIdx.push(v);
}
const pairs: { t: number; h: number; d0: number }[] = [];
for (const t of towerIdx) {
  const tx = pos[t * 3], ty = pos[t * 3 + 1], tz = pos[t * 3 + 2];
  let best = -1, bd = Infinity;
  for (const h of hideIdx) {
    const d = (pos[h * 3] - tx) ** 2 + (pos[h * 3 + 1] - ty) ** 2 + (pos[h * 3 + 2] - tz) ** 2;
    if (d < bd) { bd = d; best = h; }
  }
  if (Math.sqrt(bd) < 0.80) pairs.push({ t, h: best, d0: Math.sqrt(bd) });
}

const rows: Record<string, unknown>[] = [];
for (let f = 0; f < clip.frames; f++) {
  boneMats(f);
  const lo: Record<string, number> = {};
  let all = Infinity;
  for (let v = 0; v < vcount; v++) {
    const p = skinVert(v);
    if (p[1] < all) all = p[1];
    const g = limbOf[skin[v * 4]];
    if (g && (lo[g] === undefined || p[1] < lo[g])) lo[g] = p[1];
  }
  for (const k of Object.keys(lo)) lo[k] = +lo[k].toFixed(3);
  let gapMax = 0;
  for (const pr of pairs) {
    const a = skinVert(pr.t).slice() as number[];
    const bb = skinVert(pr.h);
    const g = Math.hypot(a[0] - bb[0], a[1] - bb[1], a[2] - bb[2]) - pr.d0;
    if (g > gapMax) gapMax = g;
  }
  const fk = (nm: string): string => {
    const b = rig.bone(nm);
    return `${wt[b * 3].toFixed(2)},${wt[b * 3 + 1].toFixed(2)},${wt[b * 3 + 2].toFixed(2)}`;
  };
  rows.push({
    f, t: +(f / (clip.frames - 1)).toFixed(2), all: +all.toFixed(3), lo,
    gapMax: +gapMax.toFixed(3),
    feet: { FL: fk('fFootL'), FR: fk('fFootR'), HL: fk('bFootL'), HR: fk('bFootR') },
  });
}
console.log(JSON.stringify({ pairs: pairs.length, rows }));
