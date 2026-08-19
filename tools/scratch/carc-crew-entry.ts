/**
 * Does a thrown crewman pass through the animal? — scratch, carcass workstream.
 *
 * Replays `UnitRenderSystem.pushElephantCrew` / `throwCrewman` against the death clip and
 * tests the man's own body capsule against the *posed* hide, rather than against the standing
 * animal the 0.55 m throw arc was sized for. Every spine bone shares one rigid transform in
 * this rig (see `carc-gap-entry.ts`), so the hide can be inverted exactly: bring the man back
 * into the animal's rest frame and test him against the swept ellipse the hide is built from.
 */
import { ELEPHANT_RIG, EB } from '../../src/anim/rig';
import { frameGlobals } from '../../src/anim/pose';
import { ELEPHANT_CLIP, ELEPHANT_CLIP_SET } from '../../src/anim/elephantClips';
import { HOWDAH, HOWDAH_BONES, HOWDAH_STATIONS, MAHOUT_BONES, MAHOUT_SEAT, ELEPHANT_GROUND_LIFT } from '../../src/units/elephantMesh';
import { bakePointTrack } from '../../src/anim/clips';
import { hash01 } from '../../src/util/rand';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const ARC = Number(env.CARC_ARC ?? '0.55');
const START = Number(env.CARC_START ?? '0.28');
const LEN = Number(env.CARC_LEN ?? '0.22');
const OUT = Number(env.CARC_OUT ?? '1.95');
const SIDE_SIGN = -1;

const rig = ELEPHANT_RIG;
const n = rig.boneCount;
const clip = ELEPHANT_CLIP_SET.clips[ELEPHANT_CLIP.death];
const rowBase = ELEPHANT_CLIP_SET.rows[ELEPHANT_CLIP.death];

const howdah = bakePointTrack(ELEPHANT_CLIP_SET, [0, HOWDAH.y, HOWDAH.z], HOWDAH_BONES.bone0, HOWDAH_BONES.bone1, HOWDAH_BONES.weight0);
const mahoutT = bakePointTrack(ELEPHANT_CLIP_SET, [0, MAHOUT_SEAT.y, MAHOUT_SEAT.z], MAHOUT_BONES.bone0, MAHOUT_BONES.bone1, MAHOUT_BONES.weight0);

/** Hide stations, copied from the body sweep in `elephantMesh.ts`. */
const HIDE: readonly [number, number, number, number][] = [
  [-2.07, 2.12, 0.42, 0.42],
  [-1.46, 2.50, 0.60, 0.60],
  [-0.60, 2.54, 0.66, 0.62],
  [0.15, 2.54, 0.68, 0.66],
  [0.535, 2.59, 0.67, 0.66],
  [0.92, 2.64, 0.64, 0.64],
  [1.26, 2.56, 0.56, 0.56],
];

const wq = new Float32Array(n * 4);
const wt = new Float32Array(n * 3);

/** Depth of a world point inside the hide, metres; 0 or less means clear. */
function depth(px: number, py: number, pz: number, R: number[], T: number[], rad: number): number {
  // p_rest = R^-1 (p - T)
  const vx = px - T[0], vy = py - T[1], vz = pz - T[2];
  const qx = -R[0], qy = -R[1], qz = -R[2], qw = R[3];
  const cx = 2 * (qy * vz - qz * vy);
  const cy = 2 * (qz * vx - qx * vz);
  const cz = 2 * (qx * vy - qy * vx);
  const x = vx + qw * cx + (qy * cz - qz * cy);
  const y = vy + qw * cy + (qz * cx - qx * cz);
  const z = vz + qw * cz + (qx * cy - qy * cx);
  if (z < HIDE[0][0] || z > HIDE[HIDE.length - 1][0]) return -1;
  let i = 0;
  while (i < HIDE.length - 2 && HIDE[i + 1][0] < z) i++;
  const f = (z - HIDE[i][0]) / (HIDE[i + 1][0] - HIDE[i][0]);
  const cyy = HIDE[i][1] + (HIDE[i + 1][1] - HIDE[i][1]) * f;
  const rx = HIDE[i][2] + (HIDE[i + 1][2] - HIDE[i][2]) * f;
  const rz = HIDE[i][3] + (HIDE[i + 1][3] - HIDE[i][3]) * f;
  const k = Math.hypot(x / rx, (y - cyy) / rz);
  // Radial slack in metres, plus the man's own body radius.
  const mean = (rx + rz) * 0.5;
  return (1 - k) * mean + rad;
}

const rows: Record<string, unknown>[] = [];
const scale = 1.0;
const variant = 0.37;
const STEPS = 200;
for (let step = 0; step <= STEPS; step++) {
  const fall = step / STEPS;
  // The animal's pose is quantised to the clip's own frames, exactly as the shader is; the
  // man's position is continuous. Sampling only at frames aliases the crossing badly.
  const f = Math.min(clip.frames - 1, Math.floor(fall * clip.frames));
  frameGlobals(rig, clip, f, wq, wt);
  const b = EB.barrel;
  const ix = rig.bindInvQ[b * 4], iy = rig.bindInvQ[b * 4 + 1], iz = rig.bindInvQ[b * 4 + 2], iw = rig.bindInvQ[b * 4 + 3];
  const ax = wq[b * 4], ay = wq[b * 4 + 1], az = wq[b * 4 + 2], aw = wq[b * 4 + 3];
  const R = [
    aw * ix + ax * iw + ay * iz - az * iy,
    aw * iy - ax * iz + ay * iw + az * ix,
    aw * iz + ax * iy - ay * ix + az * iw,
    aw * iw - ax * ix - ay * iy - az * iz,
  ];
  const bvx = rig.bindInvT[b * 3], bvy = rig.bindInvT[b * 3 + 1], bvz = rig.bindInvT[b * 3 + 2];
  const ccx = 2 * (ay * bvz - az * bvy);
  const ccy = 2 * (az * bvx - ax * bvz);
  const ccz = 2 * (ax * bvy - ay * bvx);
  const T = [
    bvx + aw * ccx + (ay * ccz - az * ccy) + wt[b * 3],
    bvy + aw * ccy + (az * ccx - ax * ccz) + wt[b * 3 + 1],
    bvz + aw * ccz + (ax * ccy - ay * ccx) + wt[b * 3 + 2],
  ];

  const row = (rowBase + f) * 3;
  const floorY = howdah[row + 1] * scale;
  const floorZ = howdah[row + 2] * scale;
  const seatY = mahoutT[row + 1] * scale;
  const seatZ = mahoutT[row + 2] * scale;
  const throwT = fall <= START ? 0 : Math.min(1, (fall - START) / LEN);

  let worst = -9;
  let worstMan = -1;
  let worstH = 0;
  let wp: number[] = [];
  for (let k = 0; k < HOWDAH_STATIONS.length + 1; k++) {
    const mahout = k === HOWDAH_STATIONS.length;
    const st = mahout ? { x: 0, z: 0, turn: 0 } : HOWDAH_STATIONS[k];
    const seed = Math.floor(variant * 16777216) + k * 7919;
    const jx = (hash01(seed, 61) - 0.5) * 0.14;
    const jz = (hash01(seed, 62) - 0.5) * 0.12;
    const lx = (st.x + jx) * scale;
    const lz = (mahout ? seatZ : floorZ + st.z + jz) * scale;
    const my = ELEPHANT_GROUND_LIFT + (mahout ? seatY - 0.86 * scale : floorY);
    const fromX = lx, fromZ = lz, fromY = my;

    const t = throwT;
    const side = SIDE_SIGN * (OUT + hash01(seed, 81) * 1.35);
    const along = mahout ? 1.5 + hash01(seed, 82) * 0.9 : -0.7 + hash01(seed, 82) * 2.4;
    const landX = fromX + side;
    const landZ = fromZ + along;
    const landY = 0 + 0.15;
    const NEW = env.CARC_EASE === 'new';
    // Out fast (he leaves a rotating platform at speed), down slow (gravity).
    const sOut = NEW ? t * (2 - t) : t * t * (3 - 2 * t);
    const sDown = NEW ? t * t : t * t * (3 - 2 * t);
    const s = NEW ? sOut : sDown;
    const x = fromX + (landX - fromX) * sOut;
    const z = fromZ + (landZ - fromZ) * sOut;
    const ARCP = Number(env.CARC_ARCP ?? '1');
    const y = fromY + (landY - fromY) * sDown + ARC * Math.sin(Math.PI * (NEW ? Math.pow(t, ARCP) : s));
    // His body axis: up, tipped s*1.676 about the outward horizontal.
    const outward = -Math.PI / 2 + (hash01(seed, 83) - 0.5) * 1.1;
    const tip = s * 1.676;
    const axis = [Math.cos(outward), 0, -Math.sin(outward)];
    // up rotated about `axis` by `tip` (Rodrigues, up = (0,1,0)).
    const ct = Math.cos(tip), stn = Math.sin(tip);
    // Rodrigues with v = (0,1,0) and k horizontal: k x v = (-kz, 0, kx) and k(k.v) = 0.
    const ux = -axis[2] * stn;
    const uy = ct;
    const uz = axis[0] * stn;
    for (let q = 0; q <= 4; q++) {
      const h = 0.25 + (q / 4) * 1.35;
      const px = throwT <= 0 ? fromX : x;
      const py = throwT <= 0 ? fromY : y;
      const pz = throwT <= 0 ? fromZ : z;
      const d = depth(px + ux * h, py + uy * h, pz + uz * h, R, T, 0.24);
      if (d > worst) { worst = d; worstMan = k; worstH = h; wp = [+(px + ux * h).toFixed(2), +(py + uy * h).toFixed(2), +(pz + uz * h).toFixed(2)]; }
    }
  }
  rows.push({
    f, fall: +fall.toFixed(3), throwT: +throwT.toFixed(3),
    worstPenetration: +worst.toFixed(3), man: worstMan, h: +worstH.toFixed(2), wp, floorY: +floorY.toFixed(3),
  });
}
console.log(JSON.stringify({ arc: ARC, rows }));
