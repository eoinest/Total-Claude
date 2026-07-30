import * as THREE from 'three';
import { Faction } from '../sim/types';
import { MAN_RIG, MB } from '../anim/rig';
import { MAN_CLIP_SET } from '../anim/clips';
import { sampleGlobals } from '../anim/pose';
import { Mat, matUv, type UvRect } from './atlas';
import { Coarse, Piece, Tint } from './kit';
import { MeshBuilder, type SheetPoint } from './meshBuilder';

/**
 * Procedural soldier meshes, built in the rig's rest T-pose.
 *
 * One geometry per faction per LOD. The geometry is the *union* of every kit piece that
 * faction can field; the vertex shader collapses whatever this particular man is not
 * wearing. That is the trade that keeps the draw-call budget: a legionary cohort, the
 * praetorians, the urban cohorts, the archers and the cavalry all render from the same
 * buffer, where a geometry per unit type would cost twelve draws before LODs.
 *
 * Historical target is 271 AD, which is a transitional moment and should look like one:
 * lorica segmentata alongside ring mail, the Imperial Gallic bowl alongside the new
 * two-piece ridge helmet, the rectangular scutum alongside the oval shield that replaced
 * it. Getting the transition visible is more truthful than picking one and repeating it.
 *
 * Sizes are archaeological where a find exists — the Dura-Europos scutum, the Corbridge
 * segmentata plates, the Nydam spears — and anthropometric otherwise.
 */

export type Lod = 0 | 1 | 2;

const ONE = new THREE.Vector3(1, 1, 1);
const poseQ = new Float32Array(MAN_RIG.boneCount * 4);
const poseT = new Float32Array(MAN_RIG.boneCount * 3);

const bonePos = (b: number): THREE.Vector3 =>
  new THREE.Vector3(MAN_RIG.restT[b * 3], MAN_RIG.restT[b * 3 + 1], MAN_RIG.restT[b * 3 + 2]);
const boneQuat = (b: number): THREE.Quaternion =>
  new THREE.Quaternion(
    MAN_RIG.restQ[b * 4], MAN_RIG.restQ[b * 4 + 1], MAN_RIG.restQ[b * 4 + 2], MAN_RIG.restQ[b * 4 + 3]
  );

/**
 * Where to build an attachment so that it lands correctly once animated.
 *
 * A weapon is skinned rigidly to a hand, so its placement is fixed by a single matrix in
 * the *rest* pose — but "correct" is only visible in a *posed* frame. So: sample a
 * reference clip, say where the object should be in world space at that instant, and pull
 * the answer back through the bone to rest. Authoring the rest-pose matrix directly would
 * mean reasoning about a T-posed arm sticking straight out sideways, which is how sockets
 * end up subtly wrong forever.
 */
function socket(
  clipName: string,
  t: number,
  bone: number,
  worldOffset: THREE.Vector3,
  worldEuler: THREE.Euler
): THREE.Matrix4 {
  const clip = MAN_CLIP_SET.clips[MAN_CLIP_SET.index(clipName)];
  sampleGlobals(MAN_RIG, clip, t, poseQ, poseT);
  const posePos = new THREE.Vector3(poseT[bone * 3], poseT[bone * 3 + 1], poseT[bone * 3 + 2]);
  const poseRot = new THREE.Quaternion(
    poseQ[bone * 4], poseQ[bone * 4 + 1], poseQ[bone * 4 + 2], poseQ[bone * 4 + 3]
  );
  const poseM = new THREE.Matrix4().compose(posePos, poseRot, ONE);
  const desired = new THREE.Matrix4().compose(
    posePos.clone().add(worldOffset),
    new THREE.Quaternion().setFromEuler(worldEuler),
    ONE
  );
  const local = poseM.invert().multiply(desired);
  return new THREE.Matrix4().compose(bonePos(bone), boneQuat(bone), ONE).multiply(local);
}

const DEG = Math.PI / 180;
const euler = (x: number, y = 0, z = 0): THREE.Euler => new THREE.Euler(x * DEG, y * DEG, z * DEG, 'XYZ');

// ---------------------------------------------------------------------------
// Skin binding helpers
// ---------------------------------------------------------------------------

interface Bind {
  bone: number;
  bone2: number;
  w: number;
}

/** One ring of a swept limb. Mirrors `MeshBuilder.tube`'s node shape. */
interface TubeNode {
  y: number;
  rx: number;
  rz: number;
  x?: number;
  z?: number;
  bone?: number;
  bone2?: number;
  w?: number;
}

/** Spine binding by height: a smooth blend up the four spine bones. */
function spineBind(y: number): Bind {
  const stops: [number, number][] = [
    [0.92, MB.pelvis],
    [1.02, MB.spineLow],
    [1.16, MB.spineMid],
    [1.30, MB.spineUp],
    [1.44, MB.chest],
  ];
  if (y <= stops[0][0]) return { bone: stops[0][1], bone2: stops[0][1], w: 1 };
  for (let i = 0; i < stops.length - 1; i++) {
    if (y <= stops[i + 1][0]) {
      const t = (y - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
      return { bone: stops[i][1], bone2: stops[i + 1][1], w: 1 - t };
    }
  }
  const last = stops[stops.length - 1][1];
  return { bone: last, bone2: last, w: 1 };
}

/** Leg binding by height for one side. */
function legBind(y: number, left: boolean): Bind {
  const thigh = left ? MB.thighL : MB.thighR;
  const shin = left ? MB.shinL : MB.shinR;
  const foot = left ? MB.footL : MB.footR;
  const hipY = MAN_RIG.restT[thigh * 3 + 1];
  const kneeY = MAN_RIG.restT[shin * 3 + 1];
  const ankleY = MAN_RIG.restT[foot * 3 + 1];
  if (y >= kneeY + 0.06) return { bone: thigh, bone2: thigh, w: 1 };
  if (y >= kneeY - 0.06) {
    const t = (kneeY + 0.06 - y) / 0.12;
    return { bone: thigh, bone2: shin, w: 1 - t };
  }
  if (y >= ankleY + 0.05) return { bone: shin, bone2: shin, w: 1 };
  const t = Math.min(1, (ankleY + 0.05 - y) / 0.08);
  void hipY;
  return { bone: shin, bone2: foot, w: 1 - t };
}

/** Arm binding by lateral distance from the body centreline. */
function armBind(x: number, left: boolean): Bind {
  const s = left ? 1 : -1;
  const shoulder = left ? MB.upperArmL : MB.upperArmR;
  const elbow = left ? MB.lowerArmL : MB.lowerArmR;
  const wrist = left ? MB.handL : MB.handR;
  const sx = MAN_RIG.restT[shoulder * 3] * s;
  const ex = MAN_RIG.restT[elbow * 3] * s;
  const wx = MAN_RIG.restT[wrist * 3] * s;
  const d = x * s;
  if (d <= sx + 0.05) return { bone: shoulder, bone2: shoulder, w: 1 };
  if (d < ex - 0.05) return { bone: shoulder, bone2: shoulder, w: 1 };
  if (d < ex + 0.05) {
    const t = (d - (ex - 0.05)) / 0.1;
    return { bone: shoulder, bone2: elbow, w: 1 - t };
  }
  if (d < wx - 0.04) return { bone: elbow, bone2: elbow, w: 1 };
  const t = Math.min(1, (d - (wx - 0.04)) / 0.08);
  return { bone: elbow, bone2: wrist, w: 1 - t };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

interface Detail {
  /** Radial segments for the torso and limbs. */
  torso: number;
  limb: number;
  head: number;
  /** Rings along a limb. */
  rings: number;
  shieldCols: number;
  shieldRows: number;
  /** Skip decorative sub-pieces below this level of detail. */
  fine: boolean;
  medium: boolean;
}

// LOD0 keeps every rivet-scale form that reads at 5 m. LOD1 drops the sub-pieces —
// cheek plates, pteruges, crest strands, arrow shafts — which is most of the cost and
// almost none of the silhouette past 45 m. LOD2 is a different mesh entirely.
const DETAIL: Record<Lod, Detail> = {
  0: { torso: 10, limb: 7, head: 10, rings: 4, shieldCols: 5, shieldRows: 6, fine: true, medium: true },
  // LOD1 keeps `medium`. Those pieces are not decoration, they are the *silhouette*: the
  // flared neck guard is what tells you a helmeted man is Roman from behind, and the ridge
  // crest and the Coolus knob are what tell three helmet types apart. Dropping them at 45 m
  // both flattened kit variety across most of the army and made the LOD0 boundary visible,
  // because a man's neck guard vanished as he crossed it.
  1: { torso: 7, limb: 5, head: 7, rings: 3, shieldCols: 3, shieldRows: 3, fine: false, medium: true },
  2: { torso: 5, limb: 4, head: 5, rings: 2, shieldCols: 2, shieldRows: 2, fine: false, medium: false },
};

export function buildSoldierGeometry(faction: Faction, lod: Lod): THREE.InstancedBufferGeometry {
  if (lod === 2) return buildFarGeometry(faction);
  const b = new MeshBuilder();
  const d = DETAIL[lod];
  const germanic = faction === Faction.Germanic;

  const skinUv = matUv(Mat.Skin);
  const hairUv = matUv(Mat.Hair);
  const woolUv = matUv(Mat.WoolCoarse);
  const linenUv = matUv(Mat.Linen);
  const clothUv = matUv(Mat.ClothFine);
  const ironUv = matUv(Mat.IronWorn);
  const plateUv = matUv(Mat.IronPlate);
  const bronzeUv = matUv(Mat.Bronze);
  const mailUv = matUv(Mat.Mail);
  const scaleUv = matUv(Mat.Scale);
  const bandUv = matUv(Mat.Bands);
  const leatherUv = matUv(Mat.LeatherBrown);
  const darkLeatherUv = matUv(Mat.LeatherDark);
  const woodUv = matUv(Mat.WoodPlank);
  const furUv = matUv(Mat.Fur);
  const plumeUv = matUv(Mat.Plume);
  const ropeUv = matUv(Mat.Rope);
  const boneUv = matUv(Mat.Bone);

  const headY = MAN_RIG.restT[MB.head * 3 + 1];
  const neckY = MAN_RIG.restT[MB.neck * 3 + 1];
  const chestY = MAN_RIG.restT[MB.chest * 3 + 1];

  // =========================================================================
  // Always-present body: head, neck, arms, hands
  // =========================================================================
  b.setMatrix(null).setPiece(Piece.Head, Tint.Skin);

  // Skull. Eyes sit at 0.93 of stature, the crown at 1.75, so the head bone at 1.613 is
  // roughly the atlanto-occipital joint and the skull is a 0.10 m sphere above it.
  b.setBone(MB.head);
  b.setMatrix(new THREE.Matrix4().makeTranslation(0, headY, MAN_RIG.restT[MB.head * 3 + 2]));
  b.revolve(
    [
      [0.001, -0.055], [0.055, -0.075], [0.072, -0.045], [0.079, 0.0],
      [0.082, 0.045], [0.072, 0.095], [0.045, 0.128], [0.001, 0.14],
    ],
    d.head, skinUv
  );
  if (d.medium) {
    // Brow, nose and jaw: three small forms are enough to read a face in profile, which
    // is the only way a face is ever seen in a battle line.
    b.box(0, -0.012, 0.058, 0.055, 0.026, 0.05, skinUv);
    b.box(0, -0.052, 0.03, 0.075, 0.05, 0.055, skinUv);
    // Eye sockets. Twelve triangles that turn a pale oval into a face at three metres.
    b.setPiece(Piece.Head, Tint.Atlas);
    for (const s2 of [-1, 1]) {
      b.box(s2 * 0.031, -0.021, 0.064, 0.026, 0.014, 0.012, matUv(Mat.HideBlack));
    }
    b.setPiece(Piece.Head, Tint.Skin);
  }
  b.setMatrix(null);

  // Neck.
  b.setBone(MB.neck, MB.chest, 0.6);
  b.tube(
    [
      { y: chestY - 0.02, rx: 0.062, rz: 0.058, bone: MB.chest },
      { y: neckY + 0.02, rx: 0.052, rz: 0.05, bone: MB.neck },
      { y: headY - 0.04, rx: 0.048, rz: 0.046, bone: MB.head },
    ],
    d.head, skinUv
  );

  // Arms, built out along X in the T-pose.
  for (const left of [true, false]) {
    const s = left ? 1 : -1;
    const sh = left ? MB.upperArmL : MB.upperArmR;
    const el = left ? MB.lowerArmL : MB.lowerArmR;
    const wr = left ? MB.handL : MB.handR;
    const shX = MAN_RIG.restT[sh * 3];
    const elX = MAN_RIG.restT[el * 3];
    const wrX = MAN_RIG.restT[wr * 3];
    const armY = MAN_RIG.restT[sh * 3 + 1];
    const armZ = MAN_RIG.restT[sh * 3 + 2];

    // A tube swept along X rather than Y: reuse `tube` by rotating the frame.
    const m = new THREE.Matrix4()
      .makeRotationZ(left ? -Math.PI / 2 : Math.PI / 2)
      .premultiply(new THREE.Matrix4().makeTranslation(0, armY, armZ));
    b.setMatrix(m);
    const nodes: TubeNode[] = [];
    const push = (x: number, r: number): void => {
      const bind = armBind(x, left);
      // The tube frame is rotated so its local +Y runs out along the arm; local y is
      // therefore the distance from the body centreline.
      nodes.push({ y: Math.abs(x), rx: r, rz: r * 0.94, bone: bind.bone, bone2: bind.bone2, w: bind.w });
    };
    // Deltoid, mid-humerus, elbow, mid-forearm, wrist.
    push(shX, 0.055);
    push((shX + elX) / 2, 0.048);
    push(elX, 0.042);
    push((elX + wrX) / 2, 0.037);
    push(wrX, 0.03);
    b.tube(nodes, d.limb, skinUv, { capEnd: false });
    b.setMatrix(null);

    // Hand: a mitten. Fingers are invisible past 3 m and cost 200 triangles.
    b.setBone(wr);
    const hm = new THREE.Matrix4().makeTranslation(wrX + s * 0.045, armY, armZ);
    b.setMatrix(hm);
    b.box(0, 0, 0, 0.09, 0.075, 0.048, skinUv);
    b.setMatrix(null);
  }

  // =========================================================================
  // Hair and beard
  // =========================================================================
  const headM = new THREE.Matrix4().makeTranslation(0, headY, MAN_RIG.restT[MB.head * 3 + 2]);
  b.setBone(MB.head).setMatrix(headM);

  b.setPiece(Piece.HairShort, Tint.Hair);
  b.revolve(
    [[0.001, 0.145], [0.05, 0.132], [0.077, 0.098], [0.086, 0.04], [0.088, -0.01], [0.086, -0.035]],
    d.head, hairUv
  );

  if (germanic) {
    b.setPiece(Piece.HairLong, Tint.Hair);
    b.revolve(
      [[0.001, 0.15], [0.055, 0.135], [0.082, 0.1], [0.092, 0.04], [0.094, -0.02]],
      d.head, hairUv
    );
    // A mass of hair falling behind the shoulders. Tacitus on the Suebi: the hair is
    // knotted and drawn back, and it is the first thing a Roman notices.
    b.setBone(MB.head, MB.neck, 0.7);
    b.tube(
      [
        { y: 0.03, rx: 0.086, rz: 0.07, z: -0.03 },
        { y: -0.06, rx: 0.088, rz: 0.062, z: -0.05 },
        { y: -0.17, rx: 0.078, rz: 0.05, z: -0.055 },
        { y: -0.26, rx: 0.055, rz: 0.036, z: -0.05 },
      ],
      Math.max(4, d.head - 3), hairUv, { capEnd: true }
    );
    b.setBone(MB.head);
  }

  b.setPiece(Piece.Beard, Tint.Hair);
  const beardLen = germanic ? 0.13 : 0.06;
  b.tube(
    [
      { y: -0.03, rx: 0.072, rz: 0.062, z: 0.012 },
      { y: -0.055, rx: 0.068, rz: 0.062, z: 0.014 },
      { y: -0.055 - beardLen * 0.6, rx: 0.055, rz: 0.05, z: 0.012 },
      { y: -0.055 - beardLen, rx: 0.03, rz: 0.028, z: 0.008 },
    ],
    Math.max(4, d.head - 4), hairUv, { capEnd: true }
  );

  // =========================================================================
  // Helmets
  // =========================================================================
  // A galea sits on the crown with its rim just above the brow, so every shell starts at
  // about y = -0.02 relative to the head bone and rises to 0.16.
  if (!germanic) {
    // Imperial Gallic: a rounded bowl with an embossed brow band, a broad flared neck
    // guard at the back and large hinged cheek pieces. This is the helmet everyone
    // pictures when they picture a legionary.
    b.setPiece(Piece.HelmGallic, Tint.Metal);
    b.revolve(
      [[0.001, 0.124], [0.058, 0.117], [0.094, 0.086], [0.105, 0.034], [0.108, 0.0], [0.109, -0.016]],
      d.head, plateUv
    );
    if (d.medium) {
      // Rim reinforce. Every galea has a thickened brow band, and without it the bowl
      // reads as a swimming cap.
      b.setPiece(Piece.HelmGallic, Tint.Atlas);
      b.revolve([[0.109, -0.014], [0.118, -0.026], [0.118, -0.044], [0.107, -0.05]], d.head, bronzeUv);
      b.setPiece(Piece.HelmGallic, Tint.Metal);
      // Neck flange, angled down and back.
      // Neck guard. Flared down and back, and the single feature that tells you a
      // helmeted man is Roman when you are looking at the back of his head.
      // Nearly horizontal, and wide: the Gallic neck guard is a shelf, and exaggerating it
      // is what makes this helmet identifiable at forty metres against the ridge helmet.
      const flange = new THREE.Matrix4()
        .makeRotationX(-42 * DEG)
        .premultiply(new THREE.Matrix4().makeTranslation(0, -0.014, -0.086));
      b.setMatrix(headM.clone().multiply(flange));
      b.box(0, -0.062, 0, 0.25, 0.13, 0.014, plateUv);
      b.setPiece(Piece.HelmGallic, Tint.Atlas);
      b.box(0, -0.13, 0, 0.25, 0.024, 0.022, bronzeUv);
      b.setPiece(Piece.HelmGallic, Tint.Metal);
      b.setMatrix(headM);
      // Cheek pieces, hinged forward of the ears.
      for (const s of [-1, 1]) {
        const cheek = new THREE.Matrix4()
          .makeRotationZ(s * 11 * DEG)
          .premultiply(new THREE.Matrix4().makeTranslation(s * 0.1, -0.075, 0.018));
        b.setMatrix(headM.clone().multiply(cheek));
        b.box(0, 0, 0, 0.024, 0.115, 0.085, plateUv);
        b.setMatrix(headM);
      }
    }

    // Intercisa / ridge helmet: two iron halves joined by a raised central ridge, the new
    // pattern of the late third century. Taller and more angular than the Gallic bowl.
    b.setPiece(Piece.HelmRidge, Tint.Metal);
    // Markedly taller and more conical than the Gallic bowl, which is both what the
    // Intercisa and Berkasovo finds are and what makes the two read apart in a crowd.
    b.revolve(
      [[0.001, 0.198], [0.026, 0.186], [0.06, 0.146], [0.086, 0.084], [0.097, 0.028],
        [0.1, 0.0], [0.101, -0.018]],
      d.head, plateUv
    );
    if (d.medium) {
      b.setPiece(Piece.HelmRidge, Tint.Atlas);
      // The ridge itself, fore and aft along the crown, plus the brow band.
      b.box(0, 0.166, 0, 0.026, 0.062, 0.21, bronzeUv);
      b.revolve([[0.101, -0.016], [0.109, -0.028], [0.109, -0.046], [0.099, -0.052]], d.head, bronzeUv);
      b.setPiece(Piece.HelmRidge, Tint.Metal);
      for (const s of [-1, 1]) {
        const cheek = new THREE.Matrix4()
          .makeRotationZ(s * 9 * DEG)
          .premultiply(new THREE.Matrix4().makeTranslation(s * 0.098, -0.08, 0.014));
        b.setMatrix(headM.clone().multiply(cheek));
        b.box(0, 0, 0, 0.022, 0.125, 0.09, plateUv);
        b.setMatrix(headM);
      }
      // Nasal, and a neck guard of its own — the ridge helmet's is narrower than the
      // Gallic bowl's but still flares.
      b.box(0, -0.048, 0.094, 0.024, 0.075, 0.014, plateUv);
      const rflange = new THREE.Matrix4()
        .makeRotationX(-64 * DEG)
        .premultiply(new THREE.Matrix4().makeTranslation(0, -0.026, -0.078));
      b.setMatrix(headM.clone().multiply(rflange));
      b.box(0, -0.045, 0, 0.18, 0.095, 0.013, plateUv);
      b.setMatrix(headM);
    }

    // Coolus: a plain bronze-or-iron bowl with a small knob and a token neck guard. The
    // cheapest helmet in the army, which is why the city cohorts have it.
    b.setPiece(Piece.HelmCoolus, Tint.Metal);
    b.revolve(
      [[0.001, 0.112], [0.06, 0.107], [0.092, 0.08], [0.101, 0.033], [0.104, 0.0], [0.105, -0.014]],
      Math.max(5, d.head - 2), plateUv
    );
    if (d.medium) {
      b.setPiece(Piece.HelmCoolus, Tint.Atlas);
      // The knob is this helmet's whole silhouette signature, so it is drawn big enough
      // to survive a mip level.
      b.revolve([[0.001, 0.152], [0.026, 0.138], [0.026, 0.116], [0.001, 0.108]], 6, bronzeUv);
      b.revolve([[0.105, -0.012], [0.113, -0.024], [0.113, -0.04], [0.103, -0.046]],
        Math.max(5, d.head - 2), bronzeUv);
      b.setPiece(Piece.HelmCoolus, Tint.Metal);
      const guard = new THREE.Matrix4()
        .makeRotationX(-62 * DEG)
        .premultiply(new THREE.Matrix4().makeTranslation(0, -0.015, -0.09));
      b.setMatrix(headM.clone().multiply(guard));
      b.box(0, -0.028, 0, 0.15, 0.056, 0.012, plateUv);
      b.setMatrix(headM);
    }
  } else {
    // Spangenhelm: a conical shell of iron plates riveted to a frame, with a nasal. The
    // Germanic helmet, and rare enough that most of the host is bareheaded.
    b.setPiece(Piece.HelmSpangen, Tint.Metal);
    b.revolve(
      [[0.004, 0.178], [0.028, 0.158], [0.06, 0.108], [0.088, 0.042], [0.098, -0.002], [0.099, -0.018]],
      d.head, plateUv
    );
    if (d.medium) {
      b.setPiece(Piece.HelmSpangen, Tint.Atlas);
      // Four visible ribs — the "spangen" the helmet is named for.
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const rib = new THREE.Matrix4()
          .makeRotationY(a)
          .multiply(new THREE.Matrix4().makeRotationX(-24 * DEG));
        b.setMatrix(headM.clone().multiply(rib));
        b.box(0, 0.075, 0.062, 0.016, 0.19, 0.014, bronzeUv);
        b.setMatrix(headM);
      }
      // Brow band and nasal.
      b.revolve([[0.101, -0.028], [0.108, -0.04], [0.108, -0.055], [0.101, -0.06]], d.head, bronzeUv);
      b.setPiece(Piece.HelmSpangen, Tint.Metal);
      b.box(0, -0.055, 0.096, 0.024, 0.075, 0.014, plateUv);
    }

    // Fur cap: what a fanatic wears instead of iron.
    b.setPiece(Piece.HelmFur, Tint.Atlas);
    b.revolve(
      [[0.001, 0.17], [0.058, 0.158], [0.095, 0.11], [0.106, 0.04], [0.108, -0.02], [0.1, -0.045]],
      Math.max(5, d.head - 3), furUv
    );
  }

  // =========================================================================
  // Crests
  // =========================================================================
  if (d.medium) {
    // Longitudinal horsehair crest, fore and aft — the praetorian and officer marker.
    b.setPiece(Piece.CrestLongitudinal, Tint.Atlas);
    b.setMatrix(headM);
    const crestRows = d.fine ? 5 : 3;
    for (let i = 0; i < crestRows; i++) {
      const t = i / (crestRows - 1);
      const z = 0.085 - t * 0.19;
      const h = 0.075 * Math.sin(Math.PI * (0.18 + t * 0.7));
      b.box(0, 0.15 + h * 0.5, z, 0.02, h, 0.19 / crestRows + 0.004, plumeUv);
    }
    // Transverse crest, ear to ear — the centurion's.
    b.setPiece(Piece.CrestTransverse, Tint.Atlas);
    for (let i = 0; i < crestRows; i++) {
      const t = i / (crestRows - 1);
      const x = -0.1 + t * 0.2;
      const h = 0.08 * Math.sin(Math.PI * (0.16 + t * 0.72));
      b.box(x, 0.15 + h * 0.5, 0, 0.2 / crestRows + 0.004, h, 0.022, plumeUv);
    }
    // Plume: a single tuft in a socket at the crown, for cavalry.
    b.setPiece(Piece.CrestPlume, Tint.Atlas);
    b.tube(
      [
        { y: 0.14, rx: 0.016, rz: 0.016 },
        { y: 0.21, rx: 0.03, rz: 0.03 },
        { y: 0.28, rx: 0.022, rz: 0.022 },
        { y: 0.325, rx: 0.004, rz: 0.004 },
      ],
      Math.max(4, d.head - 4), plumeUv, { capEnd: true }
    );
    // Horns: the Germanic chieftain's helmet in every Roman description, however much
    // modern scholarship doubts it saw a battlefield. It reads instantly at 60 m.
    b.setPiece(Piece.CrestHorns, Tint.Atlas);
    for (const s of [-1, 1]) {
      const seg = d.fine ? 4 : 3;
      for (let i = 0; i < seg; i++) {
        const t = i / seg;
        const a = t * 2.1;
        const r = 0.16;
        const x = s * (0.075 + Math.sin(a) * r * 0.8);
        const y = 0.13 + (1 - Math.cos(a)) * r;
        b.box(x, y, -0.01 - t * 0.03, 0.034 - t * 0.02, 0.05, 0.034 - t * 0.02, boneUv);
      }
    }
    b.setMatrix(null);
  }

  // =========================================================================
  // Torso: tunic, bare chest, focale
  // =========================================================================
  const torsoNodes = (scale: number, hemY: number): TubeNode[] => {
    // Chest 0.32 wide by 0.22 deep, waist 0.28 by 0.20, hips 0.32 by 0.22 — the classic
    // male taper, and wider than deep, which is what makes a rank read as shoulders.
    const rows: [number, number, number][] = [
      [chestY + 0.005, 0.163, 0.112],
      [1.28, 0.15, 0.103],
      [1.13, 0.138, 0.098],
      [1.0, 0.152, 0.106],
      [hemY + 0.03, 0.16, 0.112],
      [hemY, 0.156, 0.11],
    ];
    return rows
      .filter((_, i) => d.fine || i % 2 === 0 || i === rows.length - 1)
      .map(([y, rx, rz]) => {
        const bind = spineBind(y);
        return { y, rx: rx * scale, rz: rz * scale, bone: bind.bone, bone2: bind.bone2, w: bind.w };
      });
  };

  b.setPiece(Piece.Tunic, Tint.Tunic);
  b.tube(torsoNodes(1.0, 0.62), d.torso, woolUv, { repeatV: 3, repeatU: 2, capEnd: true });
  if (d.medium) {
    // Short sleeves over the deltoid.
    for (const left of [true, false]) {
      const s = left ? 1 : -1;
      const sh = left ? MB.upperArmL : MB.upperArmR;
      const armY = MAN_RIG.restT[sh * 3 + 1];
      const armZ = MAN_RIG.restT[sh * 3 + 2];
      const shX = MAN_RIG.restT[sh * 3];
      b.setBone(sh);
      const m = new THREE.Matrix4()
        .makeRotationZ(left ? -Math.PI / 2 : Math.PI / 2)
        .premultiply(new THREE.Matrix4().makeTranslation(0, armY, armZ));
      b.setMatrix(m);
      b.tube(
        [
          { y: Math.abs(shX) - 0.02, rx: 0.072, rz: 0.066 },
          { y: Math.abs(shX) + 0.06, rx: 0.062, rz: 0.058 },
          { y: Math.abs(shX) + 0.11, rx: 0.055, rz: 0.052 },
        ],
        d.limb, woolUv, { repeatU: 2 }
      );
      b.setMatrix(null);
      void s;
    }
  }

  if (germanic) {
    b.setPiece(Piece.TorsoBare, Tint.Skin);
    b.tube(torsoNodes(0.95, 0.88), d.torso, skinUv, { capEnd: false });
    // Loincloth for the fanatics, since they are bare to the waist and not beyond.
    b.setPiece(Piece.TorsoBare, Tint.Legs);
    b.tube(
      [
        { y: 0.97, rx: 0.16, rz: 0.112, bone: MB.pelvis },
        { y: 0.84, rx: 0.155, rz: 0.11, bone: MB.pelvis },
        { y: 0.76, rx: 0.14, rz: 0.1, bone: MB.pelvis },
      ],
      d.torso, woolUv, { repeatU: 2 }
    );
  } else {
    // Focale: the neck scarf that stopped mail and plate chafing the throat. Small, but
    // it is on every relief and its absence is felt.
    b.setPiece(Piece.Focale, Tint.Focale);
    b.setBone(MB.chest, MB.neck, 0.5);
    b.tube(
      [
        { y: chestY + 0.05, rx: 0.062, rz: 0.058 },
        { y: chestY + 0.018, rx: 0.072, rz: 0.067 },
        { y: chestY - 0.012, rx: 0.068, rz: 0.063 },
      ],
      d.torso, linenUv, { repeatU: 2 }
    );
  }

  // =========================================================================
  // Armour
  // =========================================================================
  if (!germanic) {
    // Lorica segmentata. Horizontal iron girdle plates from the armpit to the hip, with
    // overlapping shoulder guards. The Bands atlas tile carries the plate lines and rivets,
    // so the geometry is a shell and the detail is in the texture — the only way to afford
    // it at 6,000 men.
    b.setPiece(Piece.ArmourSegmentata, Tint.Metal);
    const segRows: [number, number, number][] = [
      [chestY + 0.01, 0.172, 0.122],
      [1.25, 0.17, 0.12],
      [1.14, 0.16, 0.113],
      [0.99, 0.168, 0.12],
    ];
    b.tube(
      segRows
        .filter((_, i) => d.fine || i % 2 === 0 || i === segRows.length - 1)
        .map(([y, rx, rz]) => {
          const bind = spineBind(y);
          return { y, rx, rz, bone: bind.bone, bone2: bind.bone2, w: bind.w };
        }),
      d.torso, bandUv, { repeatU: 2 }
    );
    if (d.medium) {
      // Shoulder guards: three overlapping plates per side, following the deltoid.
      for (const left of [true, false]) {
        const s = left ? 1 : -1;
        const sh = left ? MB.upperArmL : MB.upperArmR;
        const armY = MAN_RIG.restT[sh * 3 + 1];
        const armZ = MAN_RIG.restT[sh * 3 + 2];
        const shX = MAN_RIG.restT[sh * 3];
        const plates = d.fine ? 3 : 2;
        for (let i = 0; i < plates; i++) {
          const t = i / plates;
          const bind = i === 0
            ? { bone: MB.chest, bone2: sh, w: 0.55 }
            : { bone: sh, bone2: MB.chest, w: 0.8 };
          b.setBone(bind.bone, bind.bone2, bind.w);
          const m = new THREE.Matrix4()
            .makeRotationZ(left ? -Math.PI / 2 : Math.PI / 2)
            .premultiply(new THREE.Matrix4().makeTranslation(0, armY + 0.03 - t * 0.02, armZ));
          b.setMatrix(m);
          const x = Math.abs(shX) - 0.05 + t * 0.115;
          b.tube(
            [
              { y: x, rx: 0.082 - t * 0.012, rz: 0.076 - t * 0.012 },
              { y: x + 0.055, rx: 0.078 - t * 0.012, rz: 0.072 - t * 0.012 },
            ],
            d.limb, bandUv, { repeatU: 2 }
          );
          b.setMatrix(null);
          void s;
        }
      }
      // Pteruges: the leather strips hanging from the shoulders and waist.
      b.setPiece(Piece.ArmourSegmentata, Tint.Atlas);
      const strips = d.fine ? 10 : 6;
      for (let i = 0; i < strips; i++) {
        const a = (i / strips) * Math.PI * 2;
        const bind = spineBind(0.97);
        b.setBone(bind.bone, bind.bone2, bind.w);
        b.box(
          Math.cos(a) * 0.16, 0.925, Math.sin(a) * 0.112,
          0.045, 0.11, 0.014, leatherUv
        );
      }
    }
  }

  // Ring mail, worn by everyone who is not in plate or scale. A hamata reached the hip and
  // had short sleeves; the Mail tile does the rings.
  b.setPiece(Piece.ArmourMail, Tint.Metal);
  b.tube(torsoNodes(1.06, 0.78), d.torso, mailUv, { repeatV: 4, repeatU: 3, capEnd: false });
  if (d.medium) {
    for (const left of [true, false]) {
      const sh = left ? MB.upperArmL : MB.upperArmR;
      const armY = MAN_RIG.restT[sh * 3 + 1];
      const armZ = MAN_RIG.restT[sh * 3 + 2];
      const shX = MAN_RIG.restT[sh * 3];
      b.setBone(sh, MB.chest, 0.75);
      const m = new THREE.Matrix4()
        .makeRotationZ(left ? -Math.PI / 2 : Math.PI / 2)
        .premultiply(new THREE.Matrix4().makeTranslation(0, armY, armZ));
      b.setMatrix(m);
      b.tube(
        [
          { y: Math.abs(shX) - 0.03, rx: 0.08, rz: 0.074 },
          { y: Math.abs(shX) + 0.07, rx: 0.068, rz: 0.063 },
          { y: Math.abs(shX) + 0.14, rx: 0.06, rz: 0.056 },
        ],
        d.limb, mailUv, { repeatU: 3 }
      );
      b.setMatrix(null);
    }
  }

  if (!germanic) {
    // Lorica squamata: bronze scales wired to a linen backing. Praetorian kit.
    b.setPiece(Piece.ArmourScale, Tint.Atlas);
    b.tube(torsoNodes(1.07, 0.8), d.torso, scaleUv, { repeatV: 3, repeatU: 3, capEnd: false });
    if (d.medium) {
      for (const left of [true, false]) {
        const sh = left ? MB.upperArmL : MB.upperArmR;
        const armY = MAN_RIG.restT[sh * 3 + 1];
        const armZ = MAN_RIG.restT[sh * 3 + 2];
        const shX = MAN_RIG.restT[sh * 3];
        b.setBone(sh, MB.chest, 0.75);
        b.setMatrix(new THREE.Matrix4()
          .makeRotationZ(left ? -Math.PI / 2 : Math.PI / 2)
          .premultiply(new THREE.Matrix4().makeTranslation(0, armY, armZ)));
        b.tube(
          [
            { y: Math.abs(shX) - 0.03, rx: 0.082, rz: 0.076 },
            { y: Math.abs(shX) + 0.08, rx: 0.07, rz: 0.065 },
            { y: Math.abs(shX) + 0.15, rx: 0.062, rz: 0.058 },
          ],
          d.limb, scaleUv, { repeatU: 3 }
        );
        b.setMatrix(null);
      }
    }
  } else {
    // A hide jerkin. No sleeves, cut short, and it does not pretend to be armour.
    b.setPiece(Piece.ArmourLeather, Tint.Atlas);
    b.tube(
      torsoNodes(1.05, 0.86).filter((nd) => nd.y > 0.85),
      d.torso, leatherUv, { repeatV: 2, repeatU: 2 }
    );
  }

  // =========================================================================
  // Legs and boots
  // =========================================================================
  for (const left of [true, false]) {
    const s = left ? 1 : -1;
    const thigh = left ? MB.thighL : MB.thighR;
    const shin = left ? MB.shinL : MB.shinR;
    const foot = left ? MB.footL : MB.footR;
    const toe = left ? MB.toeL : MB.toeR;
    const hipX = MAN_RIG.restT[thigh * 3];
    const hipY = MAN_RIG.restT[thigh * 3 + 1];
    const kneeY = MAN_RIG.restT[shin * 3 + 1];
    const ankleY = MAN_RIG.restT[foot * 3 + 1];

    const legNodes = (scale: number): TubeNode[] => {
      // Thigh, knee, calf, ankle. The calf bulge matters: without it a leg is a stick,
      // and a rank of sticks is the first thing that reads as cheap.
      const rows: [number, number][] = [
        [hipY + 0.02, 0.088],
        [kneeY + 0.08, 0.066],
        [kneeY, 0.057],
        [kneeY - 0.11, 0.064],
        [ankleY + 0.1, 0.044],
        [ankleY + 0.02, 0.037],
      ];
      return rows
        .filter((_, i) => d.fine || i % 2 === 0 || i === rows.length - 1)
        .map(([y, r]) => {
          const bind = legBind(y, left);
          return { y, x: hipX, rx: r * scale, rz: r * scale * 1.02, bone: bind.bone, bone2: bind.bone2, w: bind.w };
        });
    };

    b.setPiece(Piece.LegsBare, Tint.Skin);
    b.tube(legNodes(1.0), d.limb, skinUv, { capEnd: true });

    // Bracae with leg wraps. Universal among Germans, and by 271 common in the legions too.
    b.setPiece(Piece.LegsTrousers, Tint.Legs);
    b.tube(legNodes(1.1), d.limb, woolUv, { repeatV: 3, repeatU: 2, capEnd: true });
    if (d.medium) {
      b.setPiece(Piece.LegsTrousers, Tint.Atlas);
      const wraps = d.fine ? 4 : 2;
      for (let i = 0; i < wraps; i++) {
        const y = ankleY + 0.05 + i * 0.075;
        const bind = legBind(y, left);
        b.setBone(bind.bone, bind.bone2, bind.w);
        b.tube(
          [
            { y, x: hipX, rx: 0.05, rz: 0.051 },
            { y: y + 0.055, x: hipX, rx: 0.05, rz: 0.051 },
          ],
          d.limb, ropeUv, { repeatU: 3 }
        );
      }
    }

    // Caligae: a hobnailed sandal-boot cut from one piece of leather. The strap pattern is
    // its silhouette, so even LOD2 keeps the sole and the ankle band.
    // Caligae: a hobnailed sole with an openwork upper of cut leather straps. The strap
    // pattern IS the silhouette, and without it a foot is a black blob — which is exactly
    // how it reads at LOD0 if you only build a shoe-shaped box.
    b.setPiece(Piece.Boots, Tint.Atlas);
    b.setBone(foot);
    b.setMatrix(new THREE.Matrix4().makeTranslation(hipX, ankleY, MAN_RIG.restT[foot * 3 + 2]));
    // Sole: pale, thick, and proud of the upper, so the foot has a readable ground line.
    b.box(0, -0.052, 0.048, 0.092, 0.028, 0.245, ropeUv);
    b.box(0, -0.028, 0.045, 0.086, 0.028, 0.235, darkLeatherUv);
    if (d.medium) {
      // Heel cup and ankle straps.
      b.box(0, 0.012, -0.028, 0.08, 0.062, 0.075, leatherUv);
      const straps = d.fine ? 3 : 2;
      for (let k = 0; k < straps; k++) {
        b.box(0, 0.02 + k * 0.035, 0.02 + k * 0.012, 0.086, 0.016, 0.09, leatherUv);
      }
      b.setBone(toe, foot, 0.7);
      b.box(0, -0.03, 0.16, 0.072, 0.03, 0.075, darkLeatherUv);
      if (d.fine) b.box(0, 0.006, 0.115, 0.076, 0.016, 0.055, leatherUv);
    }
    b.setMatrix(null);
    void s;
  }

  // =========================================================================
  // Cloak
  // =========================================================================
  // A sagum pinned at the right shoulder and hanging down the back. Bound top to the chest
  // and bottom to the pelvis, so it swings a little with the torso instead of being a
  // rigid board.
  b.setPiece(Piece.Cloak, Tint.Cloak);
  b.sheet(
    d.fine ? 5 : 3,
    d.fine ? 5 : 3,
    (tu: number, tv: number, out: SheetPoint) => {
      // A sagum reaches the back of the knee, not the ankle, and hangs from the shoulders
      // rather than swallowing the man. Too long or too wide and a rank of cloaked warriors
      // reads as a row of monks.
      const sx = tu * 2 - 1;
      const halfW = 0.17 + tv * 0.1;
      const y = chestY + 0.05 - tv * (chestY + 0.05 - 0.74);
      out.x = sx * halfW;
      out.y = y + Math.sin(tv * Math.PI) * 0.02 * Math.sin(sx * 5);
      out.z = -0.105 - (1 - sx * sx) * (0.045 + tv * 0.05);
      // Normal follows the wrap, so the cloth catches the light around the shoulders
      // instead of reading as one flat plane.
      out.nx = sx * 1.6;
      out.ny = 0.12;
      out.nz = -1;
    },
    (tv: number) => spineBind(Math.max(0.95, chestY + 0.05 - tv * (chestY + 0.05 - 0.74))),
    clothUv, 2, 3
  );

  // Torc: twisted bronze at the throat, the mark of a Germanic warrior of standing.
  if (germanic && d.medium) {
    b.setPiece(Piece.Torc, Tint.Atlas);
    b.setBone(MB.neck);
    const seg = d.fine ? 10 : 6;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 1.75 + Math.PI * 0.125;
      b.box(Math.cos(a) * 0.072, neckY + 0.02, Math.sin(a) * 0.068, 0.026, 0.024, 0.026, bronzeUv);
    }
  }

  // =========================================================================
  // Shields
  // =========================================================================
  // Offsets are from the elbow in the reference pose. The scutum's centre wants to sit
  // near the body's midline at hip height, so it covers from knee to chin.
  // A shield held at the grip covers shin to shoulder, not thigh to crown: the boss sits at
  // about the height of the lower ribs, which is where the hand behind it naturally is.
  const scutumM = socket('march', 0, MB.lowerArmL, new THREE.Vector3(-0.13, -0.16, 0.2), euler(0, 12, 0));
  const roundM = socket('march', 0, MB.lowerArmL, new THREE.Vector3(-0.11, -0.14, 0.18), euler(0, 10, 0));

  const boss = (uvIron: UvRect, piece: number, r: number, z: number): void => {
    b.setPiece(piece, Tint.Metal);
    b.revolve(
      [[0.001, z + r * 0.9], [r * 0.45, z + r * 0.8], [r * 0.8, z + r * 0.4], [r, z], [r * 1.15, z - 0.01]],
      Math.max(5, d.head - 2), uvIron
    );
  };

  if (!germanic) {
    // Scutum: the Dura-Europos find is 1.06 m tall, 0.66 m across the chord, and a
    // section of a cylinder deep enough to wrap the body. Plywood, hide-faced, iron boss.
    b.setBone(MB.lowerArmL).setMatrix(scutumM);
    b.shieldPanel(
      0.33, 0.53, 0.135, 0.022, d.shieldCols, d.shieldRows,
      matUv(Mat.WoodPlank), woodUv, Tint.Emblem, Tint.Atlas,
      // Rectangular, as the Dura-Europos find is: 1.06 m by 0.66 m of curved plywood.
      () => 1,
      Piece.ShieldScutum
    );
    if (d.medium) {
      // Umbo, and the vertical spina behind it.
      const bm = scutumM.clone().multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      b.setMatrix(bm);
      boss(plateUv, Piece.ShieldScutum, 0.075, -0.14);
      b.setMatrix(scutumM);
      b.setPiece(Piece.ShieldScutum, Tint.Atlas);
      b.box(0, 0.28, 0.155, 0.05, 0.28, 0.012, bronzeUv);
      b.box(0, -0.28, 0.155, 0.05, 0.28, 0.012, bronzeUv);
    }

    // Oval shield: the pattern replacing the scutum by the late third century. Flatter,
    // lighter, and better for a man who might have to fight in a street.
    b.setMatrix(roundM);
    b.shieldPanel(
      0.34, 0.5, 0.075, 0.02, d.shieldCols, d.shieldRows,
      matUv(Mat.WoodPlank), woodUv, Tint.Emblem, Tint.Atlas,
      (_sx, sy) => Math.sqrt(Math.max(0.02, 1 - sy * sy * 0.92)),
      Piece.ShieldOval
    );
    if (d.medium) {
      b.setMatrix(roundM.clone().multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
      boss(plateUv, Piece.ShieldOval, 0.062, -0.085);
      b.setMatrix(null);
    }
  }

  // Round limewood shield: 0.85-0.95 m across in the Germanic finds, a plank board with a
  // hide rim and an iron boss over a hand grip. Roman cavalry carried a smaller version.
  b.setBone(MB.lowerArmL).setMatrix(roundM);
  b.shieldPanel(
    0.4, 0.4, 0.05, 0.018, d.shieldCols, d.shieldRows,
    matUv(Mat.WoodPlank), woodUv, Tint.Emblem, Tint.Atlas,
    (_sx, sy) => Math.sqrt(Math.max(0.02, 1 - sy * sy)),
    Piece.ShieldRound
  );
  if (d.medium) {
    b.setMatrix(roundM.clone().multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
    boss(plateUv, Piece.ShieldRound, 0.07, -0.06);
    b.setMatrix(null);
  }

  // =========================================================================
  // Weapons
  // =========================================================================
  // Drawn sword, referenced at the moment of maximum extension in the thrust so the blade
  // comes out level and forward from behind the shield.
  const swordM = socket('attackThrust', 0.46, MB.handR, new THREE.Vector3(0, 0, 0.03), euler(84));
  b.setBone(MB.handR).setMatrix(swordM);
  b.setPiece(Piece.WeaponSword, Tint.Metal);
  // A gladius Pompeianus: 0.50 m blade, parallel edges, short triangular point. A spatha
  // is longer but the silhouette at range is the same, so one mesh serves both.
  b.box(0, 0.30, 0, 0.046, 0.44, 0.008, plateUv);
  b.setPiece(Piece.WeaponSword, Tint.Atlas);
  if (d.medium) {
    const tip = swordM.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.56, 0));
    b.setMatrix(tip);
    b.setPiece(Piece.WeaponSword, Tint.Metal);
    b.revolve([[0.023, -0.04], [0.016, 0.0], [0.001, 0.05]], 4, plateUv);
    b.setMatrix(swordM);
    b.setPiece(Piece.WeaponSword, Tint.Atlas);
    b.box(0, 0.07, 0, 0.075, 0.022, 0.03, boneUv);
    b.box(0, 0.0, 0, 0.032, 0.1, 0.03, boneUv);
    b.revolve([[0.001, -0.06], [0.026, -0.052], [0.026, -0.036], [0.001, -0.03]], 6, bronzeUv);
  }

  // Sheathed gladius, high on the right hip where a legionary wore it so he could draw
  // without fouling the shield.
  b.setBone(MB.pelvis);
  const scabM = new THREE.Matrix4()
    .makeRotationZ(-11 * DEG)
    .premultiply(new THREE.Matrix4().makeTranslation(-0.155, 1.0, 0.02));
  b.setMatrix(scabM);
  b.setPiece(Piece.SwordSheathed, Tint.Atlas);
  b.box(0, -0.24, 0, 0.055, 0.44, 0.022, darkLeatherUv);
  if (d.medium) {
    b.setPiece(Piece.SwordSheathed, Tint.Atlas);
    b.box(0, 0.01, 0, 0.036, 0.09, 0.028, boneUv);
    b.box(0, -0.46, 0, 0.05, 0.04, 0.026, bronzeUv);
  }
  b.setMatrix(null);

  // Spear: an ash shaft with a leaf-shaped iron head. The Nydam finds run 2.2-2.7 m; the
  // roster gives 2.4-2.6 m of reach, so 2.5 m of shaft.
  const spearM = socket('march', 0, MB.handR, new THREE.Vector3(0, 0, 0), euler(10));
  b.setBone(MB.handR).setMatrix(spearM);
  b.setPiece(Piece.WeaponSpear, Tint.Atlas);
  b.tube(
    [
      { y: -0.95, rx: 0.017, rz: 0.017 },
      { y: 0.2, rx: 0.019, rz: 0.019 },
      { y: 1.35, rx: 0.016, rz: 0.016 },
    ],
    Math.max(4, d.limb - 2), woodUv, { repeatV: 6, capStart: true }
  );
  b.setPiece(Piece.WeaponSpear, Tint.Metal);
  b.revolve(
    [[0.001, 1.34], [0.014, 1.38], [0.021, 1.44], [0.013, 1.51], [0.001, 1.55]],
    Math.max(4, d.limb - 3), plateUv
  );

  if (germanic) {
    // Francisca: a short haft and a heavy, deeply-bearded iron head.
    const axeM = socket('march', 0, MB.handR, new THREE.Vector3(0, 0, 0), euler(-6));
    b.setMatrix(axeM);
    b.setPiece(Piece.WeaponAxe, Tint.Atlas);
    b.tube(
      [{ y: -0.24, rx: 0.017, rz: 0.014 }, { y: 0.2, rx: 0.019, rz: 0.015 }, { y: 0.46, rx: 0.017, rz: 0.014 }],
      Math.max(4, d.limb - 2), woodUv, { repeatV: 3, capStart: true, capEnd: true }
    );
    b.setPiece(Piece.WeaponAxe, Tint.Metal);
    b.box(0, 0.45, 0.0, 0.035, 0.075, 0.05, plateUv);
    b.box(0, 0.45, 0.075, 0.03, 0.135, 0.11, plateUv);
    if (d.medium) b.box(0, 0.45, 0.15, 0.02, 0.17, 0.055, plateUv);
    b.setMatrix(null);
  }

  // Composite recurve bow in the left hand, referenced at full draw.
  const bowM = socket('drawBow', 0.6, MB.handL, new THREE.Vector3(0, 0, 0), euler(0, 0, 0));
  b.setBone(MB.handL).setMatrix(bowM);
  b.setPiece(Piece.WeaponBow, Tint.Atlas);
  {
    const seg = d.fine ? 5 : 3;
    for (const s of [-1, 1]) {
      for (let i = 0; i < seg; i++) {
        const t = i / seg;
        const y = s * (0.08 + t * 0.5);
        // Limb sweeps back, then the recurved tip kicks forward again.
        const z = -0.02 - Math.sin(t * Math.PI * 0.9) * 0.075 + Math.max(0, t - 0.78) * 0.5;
        b.box(0, y, z, 0.02, 0.6 / seg + 0.01, 0.026 - t * 0.008, boneUv);
      }
    }
    b.box(0, 0, -0.015, 0.028, 0.17, 0.035, leatherUv);
    if (d.medium) {
      // String, near enough straight — a drawn string cannot be baked into a rigid mesh.
      b.setPiece(Piece.WeaponBow, Tint.Atlas);
      b.box(0, 0, 0.055, 0.006, 1.16, 0.006, ropeUv);
    }
  }
  b.setMatrix(null);

  // Quiver slung across the back on the right.
  b.setPiece(Piece.Quiver, Tint.Atlas);
  b.setBone(MB.chest, MB.spineUp, 0.6);
  const quiverM = new THREE.Matrix4()
    .makeRotationX(22 * DEG)
    .premultiply(new THREE.Matrix4().makeRotationZ(-24 * DEG))
    .premultiply(new THREE.Matrix4().makeTranslation(-0.13, 1.22, -0.14));
  b.setMatrix(quiverM);
  b.tube(
    [{ y: -0.02, rx: 0.05, rz: 0.05 }, { y: 0.28, rx: 0.055, rz: 0.055 }],
    Math.max(4, d.limb - 2), leatherUv, { capStart: true, repeatU: 2 }
  );
  if (d.medium) {
    b.setPiece(Piece.Quiver, Tint.Atlas);
    for (let i = 0; i < (d.fine ? 5 : 3); i++) {
      const a = (i / 5) * Math.PI * 2;
      b.box(Math.cos(a) * 0.028, 0.36, Math.sin(a) * 0.028, 0.008, 0.14, 0.008, woodUv);
    }
  }
  b.setMatrix(null);

  // Pilum: 1.3 m of ash, a 0.6 m untempered iron shank and a small pyramidal head. It
  // bends on impact so it cannot be thrown back, and it is the reason a legion opens a
  // fight the way it does.
  const pilumM = socket('march', 0, MB.handR, new THREE.Vector3(0, 0, 0), euler(-9));
  b.setBone(MB.handR).setMatrix(pilumM);
  b.setPiece(Piece.Pilum, Tint.Atlas);
  b.tube(
    [{ y: -0.62, rx: 0.021, rz: 0.021 }, { y: 0.0, rx: 0.024, rz: 0.024 }, { y: 0.62, rx: 0.02, rz: 0.02 }],
    Math.max(4, d.limb - 2), woodUv, { repeatV: 4, capStart: true }
  );
  b.setPiece(Piece.Pilum, Tint.Metal);
  if (d.medium) b.box(0, 0.68, 0, 0.05, 0.13, 0.05, plateUv);
  b.tube(
    [{ y: 0.7, rx: 0.008, rz: 0.008 }, { y: 1.26, rx: 0.007, rz: 0.007 }],
    4, plateUv, { capStart: false }
  );
  b.revolve([[0.001, 1.25], [0.016, 1.29], [0.001, 1.35]], 4, plateUv);
  b.setMatrix(null);

  // A fistful of framea. Tacitus: they carry several, and throw them a very long way.
  const javM = socket('march', 0, MB.handR, new THREE.Vector3(0, 0, 0), euler(-4));
  b.setBone(MB.handR).setMatrix(javM);
  b.setPiece(Piece.JavelinBundle, Tint.Atlas);
  for (let i = 0; i < (d.fine ? 3 : 2); i++) {
    const off = (i - 1) * 0.03;
    const tilt = new THREE.Matrix4()
      .makeRotationZ((i - 1) * 4 * DEG)
      .premultiply(new THREE.Matrix4().makeTranslation(off, 0, off * 0.6));
    b.setMatrix(javM.clone().multiply(tilt));
    b.tube(
      [{ y: -0.52, rx: 0.013, rz: 0.013 }, { y: 0.6, rx: 0.011, rz: 0.011 }],
      4, woodUv, { repeatV: 3, capStart: true }
    );
    b.setPiece(Piece.JavelinBundle, Tint.Metal);
    b.revolve([[0.001, 0.59], [0.017, 0.64], [0.001, 0.73]], 4, plateUv);
    b.setPiece(Piece.JavelinBundle, Tint.Atlas);
  }
  b.setMatrix(null);

  return b.toGeometry(`soldier-${faction === Faction.Rome ? 'rome' : 'germanic'}-lod${lod}`);
}

// ---------------------------------------------------------------------------
// LOD2: the far mesh
// ---------------------------------------------------------------------------

/**
 * A different mesh, not a decimated one.
 *
 * Past about 130 m a man is thirty pixels tall and every distinguishing detail is below
 * the sampling limit. What still reads is the outline: a body, a helmet or a bare head, a
 * shield, something long over the shoulder, a cloak. So the far tier is eight silhouette
 * groups keyed to `Coarse`, about 250 triangles all told, and the render system feeds it
 * the coarse mask instead of the fine one.
 *
 * This is where the instance count lives — a wide shot puts thousands of men in this
 * tier — so it is the number that actually decides whether the frame budget holds.
 */
function buildFarGeometry(faction: Faction): THREE.InstancedBufferGeometry {
  const b = new MeshBuilder();
  const germanic = faction === Faction.Germanic;
  const SEG = 5;

  const skinUv = matUv(Mat.Skin);
  const woolUv = matUv(Mat.WoolCoarse);
  const mailUv = matUv(Mat.Mail);
  const plateUv = matUv(Mat.IronPlate);
  const woodUv = matUv(Mat.WoodPlank);
  const clothUv = matUv(Mat.ClothFine);
  const hairUv = matUv(Mat.Hair);

  const headY = MAN_RIG.restT[MB.head * 3 + 1];
  const chestY = MAN_RIG.restT[MB.chest * 3 + 1];

  // ---- body ----------------------------------------------------------------
  b.setPiece(Coarse.Body, Tint.Tunic);
  b.tube(
    [
      { y: chestY, rx: 0.165, rz: 0.115, bone: MB.chest },
      { y: 1.19, rx: 0.145, rz: 0.102, bone: MB.spineMid },
      { y: 0.98, rx: 0.16, rz: 0.112, bone: MB.pelvis },
      { y: 0.66, rx: 0.155, rz: 0.11, bone: MB.pelvis },
    ],
    SEG, woolUv, { capEnd: true, repeatU: 1 }
  );
  b.setPiece(Coarse.Body, Tint.Skin);
  b.setBone(MB.head);
  b.setMatrix(new THREE.Matrix4().makeTranslation(0, headY, 0));
  b.revolve([[0.001, -0.07], [0.072, -0.02], [0.08, 0.05], [0.001, 0.14]], SEG, skinUv);
  b.setMatrix(null);
  // A dark cap of hair, so a bare head is not a bald head at range.
  b.setPiece(Coarse.Body, Tint.Hair);
  b.setBone(MB.head);
  b.setMatrix(new THREE.Matrix4().makeTranslation(0, headY, 0));
  b.revolve([[0.001, 0.145], [0.07, 0.1], [0.086, 0.0]], SEG, hairUv);
  b.setMatrix(null);

  b.setPiece(Coarse.Body, Tint.Skin);
  for (const left of [true, false]) {
    const sh = left ? MB.upperArmL : MB.upperArmR;
    const el = left ? MB.lowerArmL : MB.lowerArmR;
    const wr = left ? MB.handL : MB.handR;
    const armY = MAN_RIG.restT[sh * 3 + 1];
    b.setMatrix(new THREE.Matrix4()
      .makeRotationZ(left ? -Math.PI / 2 : Math.PI / 2)
      .premultiply(new THREE.Matrix4().makeTranslation(0, armY, 0)));
    b.tube(
      [
        { y: Math.abs(MAN_RIG.restT[sh * 3]), rx: 0.055, rz: 0.052, bone: sh },
        { y: Math.abs(MAN_RIG.restT[el * 3]), rx: 0.042, rz: 0.04, bone: el },
        { y: Math.abs(MAN_RIG.restT[wr * 3]) + 0.04, rx: 0.032, rz: 0.03, bone: wr },
      ],
      4, skinUv, { capEnd: true }
    );
    b.setMatrix(null);
  }

  b.setPiece(Coarse.Body, germanic ? Tint.Legs : Tint.Skin);
  for (const left of [true, false]) {
    const thigh = left ? MB.thighL : MB.thighR;
    const shin = left ? MB.shinL : MB.shinR;
    const foot = left ? MB.footL : MB.footR;
    const x = MAN_RIG.restT[thigh * 3];
    b.tube(
      [
        { y: MAN_RIG.restT[thigh * 3 + 1], x, rx: 0.082, rz: 0.084, bone: thigh },
        { y: MAN_RIG.restT[shin * 3 + 1], x, rx: 0.058, rz: 0.06, bone: shin },
        { y: MAN_RIG.restT[foot * 3 + 1] + 0.02, x, rx: 0.04, rz: 0.042, bone: foot },
      ],
      4, germanic ? woolUv : skinUv, { capEnd: true }
    );
  }

  // ---- helmet --------------------------------------------------------------
  b.setPiece(Coarse.Helmet, Tint.Metal);
  b.setBone(MB.head);
  b.setMatrix(new THREE.Matrix4().makeTranslation(0, headY, 0));
  b.revolve([[0.02, 0.17], [0.095, 0.06], [0.104, -0.035]], SEG, plateUv);
  b.setMatrix(null);

  // ---- armour --------------------------------------------------------------
  b.setPiece(Coarse.Armour, Tint.Metal);
  b.tube(
    [
      { y: chestY + 0.01, rx: 0.175, rz: 0.124, bone: MB.chest },
      { y: 1.16, rx: 0.162, rz: 0.115, bone: MB.spineMid },
      { y: 0.9, rx: 0.172, rz: 0.122, bone: MB.pelvis },
    ],
    SEG, mailUv, { repeatU: 2 }
  );

  // ---- shields -------------------------------------------------------------
  const shieldM = socket('march', 0, MB.lowerArmL, new THREE.Vector3(-0.12, -0.15, 0.19), euler(0, 11, 0));
  b.setBone(MB.lowerArmL).setMatrix(shieldM);
  b.shieldPanel(
    0.33, 0.52, 0.11, 0.02, 2, 2,
    woodUv, woodUv, Tint.Emblem, Tint.Atlas,
    () => 1, Coarse.ShieldBig
  );
  b.shieldPanel(
    0.4, 0.4, 0.05, 0.018, 2, 2,
    woodUv, woodUv, Tint.Emblem, Tint.Atlas,
    (_sx, sy) => Math.sqrt(Math.max(0.05, 1 - sy * sy)), Coarse.ShieldRound
  );
  b.setMatrix(null);

  // ---- weapons -------------------------------------------------------------
  const poleM = socket('march', 0, MB.handR, new THREE.Vector3(0, 0, 0), euler(8));
  b.setBone(MB.handR).setMatrix(poleM);
  b.setPiece(Coarse.Pole, Tint.Atlas);
  b.tube(
    [{ y: -0.8, rx: 0.018, rz: 0.018 }, { y: 1.3, rx: 0.016, rz: 0.016 }],
    4, woodUv, { capStart: true, capEnd: true }
  );
  b.setPiece(Coarse.Blade, Tint.Metal);
  b.setMatrix(socket('attackThrust', 0.46, MB.handR, new THREE.Vector3(0, 0, 0.03), euler(84)));
  b.box(0, 0.26, 0, 0.05, 0.5, 0.012, plateUv);
  b.setMatrix(null);

  // ---- cloak ---------------------------------------------------------------
  b.setPiece(Coarse.Cloak, Tint.Cloak);
  {
    const grid: number[][] = [];
    for (let r = 0; r <= 2; r++) {
      const t = r / 2;
      const y = chestY + 0.05 - t * (chestY - 0.45);
      b.setBone(t < 0.5 ? MB.chest : MB.pelvis);
      const row: number[] = [];
      for (let c = 0; c <= 2; c++) {
        const sx = c - 1;
        const [u, v] = MeshBuilder.tileUv(clothUv, (sx + 1) / 2, t);
        row.push(b.vert(sx * (0.2 + t * 0.16), y, -0.12 - (1 - sx * sx) * 0.06, sx * 0.5, 0, -1, u, v));
      }
      grid.push(row);
    }
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        b.quad(grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c]);
        b.quad(grid[r][c], grid[r + 1][c], grid[r + 1][c + 1], grid[r][c + 1]);
      }
    }
  }

  return b.toGeometry(`soldier-far-${faction === Faction.Rome ? 'rome' : 'germanic'}`);
}
