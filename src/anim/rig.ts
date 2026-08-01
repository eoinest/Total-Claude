import type { BakedRigData } from './bakedTypes';
import { MAN_BAKED } from './generated/manBaked.gen';
import { HORSE_BAKED } from './generated/horseBaked.gen';
import { ELEPHANT_BAKED } from './elephantSkeleton';

/**
 * Skeletons.
 *
 * A rig is a flat, topologically-sorted array of rigid bones: parent index, rest world
 * transform, and rest transform relative to the parent. Flat arrays because every
 * consumer walks the whole skeleton in order — the pose evaluator, the animation-texture
 * baker and the socket solver all do a single forward sweep, and a tree of objects would
 * only add pointer chasing.
 *
 * Every transform here is rigid: rotation plus translation, no scale. That is what lets
 * the animation texture store a bone as a quaternion and a vector (two RGBA texels)
 * instead of three rows of matrix, and it makes normals exactly correct under skinning
 * because rotating a normal by a quaternion needs no inverse-transpose.
 *
 * The man's rest pose is a T-pose inherited from the CC0 Quaternius source rig, with
 * bone lengths replaced by human anthropometry for a 1.75 m man. Soldier meshes are
 * authored directly in that rest pose, so the bind matrices are exact by construction.
 */

export interface Rig {
  readonly boneCount: number;
  readonly names: readonly string[];
  readonly parent: Int32Array;
  /** Rest world rotation per bone, xyzw. */
  readonly restQ: Float32Array;
  /** Rest world position per bone. */
  readonly restT: Float32Array;
  /** Rest rotation relative to the parent. */
  readonly localQ: Float32Array;
  /** Rest offset from the parent, expressed in the parent's frame. */
  readonly localT: Float32Array;
  /** Inverse of the rest world transform — the bind inverse. */
  readonly bindInvQ: Float32Array;
  readonly bindInvT: Float32Array;
  /** Bone index by name; throws on a typo so a bad clip fails loudly at load. */
  bone(name: string): number;
}

function makeRig(data: BakedRigData): Rig {
  const n = data.boneCount;
  const names = data.bones.map((b) => b.name);
  const parent = new Int32Array(n);
  const restQ = new Float32Array(n * 4);
  const restT = new Float32Array(n * 3);
  const localQ = new Float32Array(n * 4);
  const localT = new Float32Array(n * 3);
  const bindInvQ = new Float32Array(n * 4);
  const bindInvT = new Float32Array(n * 3);

  for (let i = 0; i < n; i++) {
    const b = data.bones[i];
    parent[i] = b.parent;
    for (let c = 0; c < 4; c++) {
      restQ[i * 4 + c] = b.restQ[c];
      localQ[i * 4 + c] = b.localQ[c];
    }
    for (let c = 0; c < 3; c++) {
      restT[i * 3 + c] = b.restT[c];
      localT[i * 3 + c] = b.localT[c];
    }
    // Rigid inverse: q⁻¹ is the conjugate, and the translation is -q⁻¹·t.
    const qx = -b.restQ[0];
    const qy = -b.restQ[1];
    const qz = -b.restQ[2];
    const qw = b.restQ[3];
    bindInvQ[i * 4 + 0] = qx;
    bindInvQ[i * 4 + 1] = qy;
    bindInvQ[i * 4 + 2] = qz;
    bindInvQ[i * 4 + 3] = qw;
    const tx = -b.restT[0];
    const ty = -b.restT[1];
    const tz = -b.restT[2];
    // Rotate (-t) by the conjugate quaternion.
    const cx = 2 * (qy * tz - qz * ty);
    const cy = 2 * (qz * tx - qx * tz);
    const cz = 2 * (qx * ty - qy * tx);
    bindInvT[i * 3 + 0] = tx + qw * cx + (qy * cz - qz * cy);
    bindInvT[i * 3 + 1] = ty + qw * cy + (qz * cx - qx * cz);
    bindInvT[i * 3 + 2] = tz + qw * cz + (qx * cy - qy * cx);
  }

  const index = new Map(names.map((s, i) => [s, i]));
  return {
    boneCount: n,
    names,
    parent,
    restQ,
    restT,
    localQ,
    localT,
    bindInvQ,
    bindInvT,
    bone(name: string): number {
      const i = index.get(name);
      if (i === undefined) throw new Error(`[rig] no bone "${name}"`);
      return i;
    },
  };
}

export const MAN_RIG: Rig = makeRig(MAN_BAKED);
export const HORSE_RIG: Rig = makeRig(HORSE_BAKED);
/**
 * The war elephant. Hand-authored rather than retargeted, and with identity rest rotations —
 * see `elephantSkeleton.ts` for why both of those are deliberate.
 */
export const ELEPHANT_RIG: Rig = makeRig(ELEPHANT_BAKED);

/** Semantic bone indices for the man, resolved once. */
export const MB = {
  root: MAN_RIG.bone('root'),
  pelvis: MAN_RIG.bone('pelvis'),
  spineLow: MAN_RIG.bone('spineLow'),
  spineMid: MAN_RIG.bone('spineMid'),
  spineUp: MAN_RIG.bone('spineUp'),
  chest: MAN_RIG.bone('chest'),
  neck: MAN_RIG.bone('neck'),
  head: MAN_RIG.bone('head'),
  clavL: MAN_RIG.bone('clavL'),
  upperArmL: MAN_RIG.bone('upperArmL'),
  lowerArmL: MAN_RIG.bone('lowerArmL'),
  handL: MAN_RIG.bone('handL'),
  clavR: MAN_RIG.bone('clavR'),
  upperArmR: MAN_RIG.bone('upperArmR'),
  lowerArmR: MAN_RIG.bone('lowerArmR'),
  handR: MAN_RIG.bone('handR'),
  thighL: MAN_RIG.bone('thighL'),
  shinL: MAN_RIG.bone('shinL'),
  footL: MAN_RIG.bone('footL'),
  toeL: MAN_RIG.bone('toeL'),
  thighR: MAN_RIG.bone('thighR'),
  shinR: MAN_RIG.bone('shinR'),
  footR: MAN_RIG.bone('footR'),
  toeR: MAN_RIG.bone('toeR'),
} as const;

/** Semantic bone indices for the horse. */
export const HB = {
  hind: HORSE_RIG.bone('hind'),
  croup: HORSE_RIG.bone('croup'),
  loin: HORSE_RIG.bone('loin'),
  barrel: HORSE_RIG.bone('barrel'),
  withers: HORSE_RIG.bone('withers'),
  neck1: HORSE_RIG.bone('neck1'),
  neck2: HORSE_RIG.bone('neck2'),
  neck3: HORSE_RIG.bone('neck3'),
  head: HORSE_RIG.bone('head'),
  fShoulderL: HORSE_RIG.bone('fShoulderL'),
  fUpperL: HORSE_RIG.bone('fUpperL'),
  fLowerL: HORSE_RIG.bone('fLowerL'),
  fHoofL: HORSE_RIG.bone('fHoofL'),
  fShoulderR: HORSE_RIG.bone('fShoulderR'),
  fUpperR: HORSE_RIG.bone('fUpperR'),
  fLowerR: HORSE_RIG.bone('fLowerR'),
  fHoofR: HORSE_RIG.bone('fHoofR'),
  bHipL: HORSE_RIG.bone('bHipL'),
  bFemurL: HORSE_RIG.bone('bFemurL'),
  bTibiaL: HORSE_RIG.bone('bTibiaL'),
  bCannonL: HORSE_RIG.bone('bCannonL'),
  bHoofL: HORSE_RIG.bone('bHoofL'),
  bHipR: HORSE_RIG.bone('bHipR'),
  bFemurR: HORSE_RIG.bone('bFemurR'),
  bTibiaR: HORSE_RIG.bone('bTibiaR'),
  bCannonR: HORSE_RIG.bone('bCannonR'),
  bHoofR: HORSE_RIG.bone('bHoofR'),
  tail1: HORSE_RIG.bone('tail1'),
  tail2: HORSE_RIG.bone('tail2'),
} as const;

/** Semantic bone indices for the elephant. */
export const EB = {
  root: ELEPHANT_RIG.bone('root'),
  croup: ELEPHANT_RIG.bone('croup'),
  loin: ELEPHANT_RIG.bone('loin'),
  barrel: ELEPHANT_RIG.bone('barrel'),
  withers: ELEPHANT_RIG.bone('withers'),
  neck: ELEPHANT_RIG.bone('neck'),
  head: ELEPHANT_RIG.bone('head'),
  trunk1: ELEPHANT_RIG.bone('trunk1'),
  trunk2: ELEPHANT_RIG.bone('trunk2'),
  trunk3: ELEPHANT_RIG.bone('trunk3'),
  trunk4: ELEPHANT_RIG.bone('trunk4'),
  earL: ELEPHANT_RIG.bone('earL'),
  earR: ELEPHANT_RIG.bone('earR'),
  fShoulderL: ELEPHANT_RIG.bone('fShoulderL'),
  fUpperL: ELEPHANT_RIG.bone('fUpperL'),
  fKneeL: ELEPHANT_RIG.bone('fKneeL'),
  fFootL: ELEPHANT_RIG.bone('fFootL'),
  fShoulderR: ELEPHANT_RIG.bone('fShoulderR'),
  fUpperR: ELEPHANT_RIG.bone('fUpperR'),
  fKneeR: ELEPHANT_RIG.bone('fKneeR'),
  fFootR: ELEPHANT_RIG.bone('fFootR'),
  bHipL: ELEPHANT_RIG.bone('bHipL'),
  bFemurL: ELEPHANT_RIG.bone('bFemurL'),
  bHockL: ELEPHANT_RIG.bone('bHockL'),
  bFootL: ELEPHANT_RIG.bone('bFootL'),
  bHipR: ELEPHANT_RIG.bone('bHipR'),
  bFemurR: ELEPHANT_RIG.bone('bFemurR'),
  bHockR: ELEPHANT_RIG.bone('bHockR'),
  bFootR: ELEPHANT_RIG.bone('bFootR'),
  tail1: ELEPHANT_RIG.bone('tail1'),
  tail2: ELEPHANT_RIG.bone('tail2'),
} as const;

/** The four bones that touch the ground, for stride measurement. */
export const ELEPHANT_CONTACTS: readonly number[] = [EB.fFootL, EB.fFootR, EB.bFootL, EB.bFootR];

/** Rest world position of a bone, for mesh authoring. */
export const restPos = (rig: Rig, bone: number, out: [number, number, number]): [number, number, number] => {
  out[0] = rig.restT[bone * 3];
  out[1] = rig.restT[bone * 3 + 1];
  out[2] = rig.restT[bone * 3 + 2];
  return out;
};
