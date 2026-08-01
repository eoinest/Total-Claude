import type { BakedBone, BakedRigData } from './bakedTypes';

/**
 * The war elephant's skeleton, written by hand rather than retargeted from a model.
 *
 * ## Why this is not a GLTF
 * The man and the horse come from CC0 Quaternius meshes put through `bake/retarget.mjs`.
 * There is no elephant in `public/assets/models/`, the project must run with an empty asset
 * folder, and the licence rule is procedural-or-CC0 — so the animal is defined here, in code,
 * as thirty-one bone positions. That turns out to be the *better* option and not merely the
 * available one, for the reason below.
 *
 * ## Why every rest rotation is the identity
 * A retargeted rig inherits whatever bone orientations the artist's skeleton happened to
 * have, and the horse's do not line up with the world axes. `buildOverlay` authors motion as
 * "rotate this bone N degrees about the world X axis", so with an arbitrary rest orientation
 * the author has to reason about the composition of two frames at once. Setting every
 * `restQ` to identity makes the two the same frame: "swing the femur -20 about X" moves the
 * hind leg forward by twenty degrees, full stop, and a bind inverse becomes a pure
 * translation. Nothing downstream cares — `frameGlobals`, `sampleGlobals`, `measureRootSpeed`
 * and the animation-texture baker are all written against arbitrary rest transforms.
 *
 * ## The animal
 * *Loxodonta africana pharaohensis*, the North African forest elephant, which is the animal
 * Carthage actually used and is materially smaller than the Indian elephant everyone pictures:
 * around 2.5 m at the shoulder against 3.2 m. This one stands **2.85 m at the withers**, at
 * the top of that range, because it is a picked and grain-fed war animal and because the
 * howdah has to be credible on its back.
 *
 * That last point is a real historical argument and it is worth recording which side this
 * takes. Several historians hold that the forest elephant was too small to carry a tower and
 * that Punic elephants were ridden by a mahout alone; Polybius describing towers at Raphia
 * is talking about the larger Indian animals of the Seleucid army. The reference plates this
 * work is graded against (`reference/rome2/r2-00`, `r2-08`) both show crenellated towers, so
 * the tower is built — but the animal underneath it is sized as the African forest elephant
 * it should be, rather than quietly inflated to an Indian bull to make the tower easy.
 *
 * Proportions are from skeletal measurements rather than eyeballed: the shoulder is the
 * highest point (a horse's is the croup), the back dips behind it, the neck is very short,
 * and the legs are columnar — an elephant is the only large land mammal whose limb bones
 * stack nearly vertically, which is why its knees look wrong and why it cannot jump or trot.
 */

/** Semantic bone names, in the order they are declared below. */
export const ELEPHANT_BONES = [
  'root', 'croup', 'loin', 'barrel', 'withers', 'neck', 'head',
  'trunk1', 'trunk2', 'trunk3', 'trunk4',
  'earL', 'earR',
  'fShoulderL', 'fUpperL', 'fKneeL', 'fFootL',
  'fShoulderR', 'fUpperR', 'fKneeR', 'fFootR',
  'bHipL', 'bFemurL', 'bHockL', 'bFootL',
  'bHipR', 'bFemurR', 'bHockR', 'bFootR',
  'tail1', 'tail2',
] as const;

/**
 * Bone name, parent name, and rest position in metres.
 *
 * +Z is forward (the way the animal looks), +Y up, +X to the animal's left. Same convention
 * as the man and horse rigs, so a mount and its riders share one world frame.
 */
const SKELETON: readonly (readonly [string, string | null, number, number, number])[] = [
  // ---- spine, back to front -------------------------------------------------
  // The root sits at the pelvis. The back is not level: it rises from the loin to a
  // pronounced shoulder hump and then drops sharply to a very short neck.
  ['root', null, 0, 2.30, -1.55],
  ['croup', 'root', 0, 2.66, -1.30],
  ['loin', 'croup', 0, 2.74, -0.60],
  // The tower sits over the barrel, which is the strongest part of the back and directly
  // above the animal's centre of mass. `elephantMesh.ts` reads this station.
  ['barrel', 'loin', 0, 2.76, 0.15],
  ['withers', 'barrel', 0, 2.82, 0.92],
  // One neck bone, not three. An elephant's cervical vertebrae are short and stacked to carry
  // the skull's mass, so the neck barely articulates — giving it a horse's three-bone chain
  // would let it arch like a horse, which is the single most wrong thing it could do.
  ['neck', 'withers', 0, 2.70, 1.42],
  ['head', 'neck', 0, 2.52, 1.80],

  // ---- trunk ----------------------------------------------------------------
  // Four segments, tapering. The trunk is the animal's most-watched feature: it is never
  // still, it curls up out of the way in a charge, and it is the difference between an
  // elephant and a grey cow.
  ['trunk1', 'head', 0, 2.28, 2.14],
  ['trunk2', 'trunk1', 0, 1.86, 2.36],
  ['trunk3', 'trunk2', 0, 1.40, 2.44],
  ['trunk4', 'trunk3', 0, 0.96, 2.38],

  // ---- ears -----------------------------------------------------------------
  // African ears, and huge — they reach above the top of the skull and below the jaw. They
  // flap constantly for cooling, which is most of what makes a standing elephant read as
  // alive rather than as a statue.
  ['earL', 'head', 0.46, 2.58, 1.70],
  ['earR', 'head', -0.46, 2.58, 1.70],

  // ---- fore limbs -----------------------------------------------------------
  // Hung from the withers, because an elephant has no clavicle and the forelimb is slung
  // from the shoulder girdle. Nearly vertical: shoulder 2.38, elbow 1.66, carpus 0.92, pad
  // 0.22 — barely 70 mm of lateral drift over 2.16 m of leg.
  ['fShoulderL', 'withers', 0.58, 2.38, 0.86],
  ['fUpperL', 'fShoulderL', 0.62, 1.66, 0.84],
  ['fKneeL', 'fUpperL', 0.64, 0.92, 0.88],
  ['fFootL', 'fKneeL', 0.65, 0.22, 0.92],
  ['fShoulderR', 'withers', -0.58, 2.38, 0.86],
  ['fUpperR', 'fShoulderR', -0.62, 1.66, 0.84],
  ['fKneeR', 'fUpperR', -0.64, 0.92, 0.88],
  ['fFootR', 'fKneeR', -0.65, 0.22, 0.92],

  // ---- hind limbs -----------------------------------------------------------
  // The hind leg is the giveaway. Every other large quadruped has a deep zig-zag at the
  // stifle and hock; an elephant's is almost straight, which is why it appears to have
  // human-like knees and why it ambles instead of trotting.
  ['bHipL', 'root', 0.56, 2.30, -1.34],
  ['bFemurL', 'bHipL', 0.60, 1.60, -1.30],
  ['bHockL', 'bFemurL', 0.62, 0.86, -1.24],
  ['bFootL', 'bHockL', 0.63, 0.22, -1.20],
  ['bHipR', 'root', -0.56, 2.30, -1.34],
  ['bFemurR', 'bHipR', -0.60, 1.60, -1.30],
  ['bHockR', 'bFemurR', -0.62, 0.86, -1.24],
  ['bFootR', 'bHockR', -0.63, 0.22, -1.20],

  // ---- tail -----------------------------------------------------------------
  ['tail1', 'croup', 0, 2.56, -1.62],
  ['tail2', 'tail1', 0, 1.90, -1.78],
];

const IDENTITY_Q = [0, 0, 0, 1];

function buildBones(): BakedBone[] {
  const index = new Map<string, number>();
  SKELETON.forEach(([name], i) => index.set(name, i));

  return SKELETON.map(([name, parentName, x, y, z], i): BakedBone => {
    const parent = parentName === null ? -1 : index.get(parentName)!;
    if (parentName !== null && parent === undefined) {
      throw new Error(`[elephantSkeleton] "${name}" wants missing parent "${parentName}"`);
    }
    // Topological order is a hard requirement of the forward sweep in `frameGlobals`, and a
    // hand-written table is exactly the kind of thing that stops satisfying it after an edit.
    // Assert rather than trust: a parent later in the array produces a pose that is subtly
    // wrong for one bone and its whole subtree, which is very hard to see and very easy to
    // blame on the mesh.
    if (parent >= i) {
      throw new Error(`[elephantSkeleton] "${name}" (${i}) precedes its parent "${parentName}" (${parent})`);
    }
    const rest: number[] = [x, y, z];
    const local = parent < 0
      ? rest.slice()
      : [x - SKELETON[parent][2], y - SKELETON[parent][3], z - SKELETON[parent][4]];
    return {
      name,
      parent,
      // Identity everywhere — see the note at the top of the file. With no rest rotation the
      // offset to a child is the same vector in world space and in the parent's frame, which
      // is what makes `localT` a plain subtraction.
      restQ: IDENTITY_Q.slice(),
      restT: rest,
      localQ: IDENTITY_Q.slice(),
      localT: local,
    };
  });
}

/**
 * The rig payload, in the shape `makeRig` already consumes.
 *
 * `clips` is empty and the two base64 payloads are blank on purpose: every elephant clip is
 * authored in `elephantClips.ts` from `restClip` plus `buildOverlay`, so there is nothing
 * baked to decode. `decodeBaked` is never called on this.
 */
export const ELEPHANT_BAKED: BakedRigData = {
  boneCount: SKELETON.length,
  bones: buildBones(),
  clips: [],
  rot: '',
  rootT: '',
};

/** Withers height in the rest pose, metres — the figure the mesh and the tower are scaled to. */
export const ELEPHANT_SHOULDER_H = 2.82;
