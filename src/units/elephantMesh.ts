import * as THREE from 'three';
import { ELEPHANT_RIG, EB } from '../anim/rig';
import { Mat, matUv } from './atlas';
import { Tint } from './kit';
import { MeshBuilder } from './meshBuilder';

/**
 * The Carthaginian war elephant, built procedurally on the hand-authored elephant rig.
 *
 * ## What it is copying
 * `reference/rome2/r2-08` is the target and it is unusually legible: four armoured elephants
 * coming out of a gate at night under firelight. Read off that plate, the things that make
 * the silhouette are, in order of how much they matter:
 *
 *  1. **A bronze chamfron** over the forehead and the top of the trunk — a big embossed
 *     plate with a raised central boss and a scalloped lower edge. It is the brightest thing
 *     on the animal and it is what says "war elephant" rather than "elephant".
 *  2. **Scale barding down the trunk and across the chest**, silver-grey, hanging in a bib.
 *  3. **Tusks**, long and pale, sweeping forward and up past the trunk.
 *  4. **A crenellated timber tower** with merlons, corner posts and visible planking.
 *  5. **A hooded mahout on the neck**, ahead of and below the tower.
 *  6. **A caparison** — draped cloth under the tower, over the back and down the flanks.
 *  7. Ears fanned wide, which is most of the frontal area.
 *
 * ## One LOD, on purpose
 * Every other mesh in this project has three. An elephant unit is eight animals at
 * establishment and sixteen at the shipped `ultra` size, against nine thousand men — so at
 * roughly 7 k triangles apiece the whole elephant line is about 110 k triangles, which is
 * three per cent of one LOD1 rank of infantry. A distance LOD would save nothing measurable
 * and would cost a draw call out of a budget of twelve that already has ten in it. The
 * animal is also large enough that it is never the thing a player is squinting at.
 */

export const enum ElephantPiece {
  /** Hide: body, legs, head, trunk, ears, tail. */
  Body = 0,
  /** Bronze chamfron, scale barding, tusk bands, harness. */
  Barding = 1,
  /** Howdah: floor, posts, planking, merlons, and the caparison under it. */
  Tower = 2,
  Count = 3,
}

/** Every war elephant carries all three groups; the mask never varies. */
export const ELEPHANT_MASK_LO = 0b111;

const p3 = (b: number): [number, number, number] => [
  ELEPHANT_RIG.restT[b * 3],
  ELEPHANT_RIG.restT[b * 3 + 1],
  ELEPHANT_RIG.restT[b * 3 + 2],
];

const lerp3 = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number
): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const UP: [number, number, number] = [0, 1, 0];

/**
 * How far the mesh sits above its own origin, metres — subtract it to put the feet on the
 * ground.
 *
 * The foot bone is at y 0.22 and the pad geometry hangs 0.19 m below it, so the sole is at
 * 0.03 m in the rest pose. Registering that to the ground is the same convention the horse
 * uses and for the same reason: `probe-elephant` measures the stance plane over the whole
 * gait, and an animal that never leaves the ground must never be drawn floating above it.
 */
export const ELEPHANT_GROUND_LIFT = 0.03;

/**
 * Where the howdah floor sits in the rest pose, and how big it is.
 *
 * The floor rides on a folded pad over the barrel, whose top surface is the back plus the
 * pad's own thickness. Exported because `UnitRenderSystem` seats the tower crew against the
 * *animated* height of this point — the same decomposition the saddle uses, and for the same
 * reason: put a man's boots at a rest-pose height and he rides in the air.
 */
export const HOWDAH = {
  y: 2.76 + 0.30,
  z: 0.02,
  /**
   * Internal floor, metres. Three men stand in this, shoulder to shoulder.
   *
   * 0.56 x 0.52 half-extents, down from 0.74 x 0.66. The first pass made the tower 1.48 m
   * wide against a body 1.36 m across — so it overhung the animal on both sides and read as
   * a shipping crate strapped to a cow. In r2-08 the tower is visibly *narrower* than the
   * elephant's back, which is the only way it could be lashed down at all.
   */
  halfX: 0.56,
  halfZ: 0.52,
  /** Height of the wall from the floor to the base of the merlons. */
  wall: 0.66,
  /** Merlon height above the wall. */
  merlon: 0.22,
} as const;

/** Bones the tower is rigidly bound to — it is strapped across the barrel and the loin. */
export const HOWDAH_BONES = { bone0: EB.barrel, bone1: EB.loin, weight0: 0.72 } as const;

/**
 * Where the mahout sits, in the rest pose.
 *
 * On the neck, straddling it just behind the skull, which is where a mahout has always sat
 * because it is the only place from which the ears can be reached — the goad and the feet
 * behind the ears are the controls. Well forward of and below the tower, which is exactly
 * the read in r2-08.
 */
export const MAHOUT_SEAT = { y: 2.70 + 0.24, z: 1.44 } as const;
export const MAHOUT_BONES = { bone0: EB.neck, bone1: EB.withers, weight0: 0.7 } as const;

/**
 * Crew stations inside the tower, in the animal's own frame, relative to the floor centre.
 *
 * Three men, which is what the plate shows and what the platform will hold: two facing
 * forward over the front merlons with javelins, one turned to the rear quarter. They stand
 * shoulder to shoulder because the floor is 1.48 by 1.32 m and there is nowhere else to be.
 */
export const HOWDAH_STATIONS: readonly { x: number; z: number; turn: number }[] = [
  { x: -0.28, z: 0.18, turn: -0.18 },
  { x: 0.28, z: 0.18, turn: 0.18 },
  { x: 0.02, z: -0.24, turn: 2.5 },
];

export function buildElephantGeometry(): THREE.InstancedBufferGeometry {
  const b = new MeshBuilder();

  const hideUv = matUv(Mat.ElephantHide);
  const bronzeUv = matUv(Mat.Bronze);
  const scaleUv = matUv(Mat.Scale);
  const boneUv = matUv(Mat.Bone);
  const oakUv = matUv(Mat.OakBeam);
  const plankUv = matUv(Mat.WoodPlank);
  const leatherUv = matUv(Mat.LeatherBrown);
  const ropeUv = matUv(Mat.Rope);
  const clothUv = matUv(Mat.WoolCoarse);
  const ironUv = matUv(Mat.IronWorn);

  const root = p3(EB.root);
  const croup = p3(EB.croup);
  const loin = p3(EB.loin);
  const barrel = p3(EB.barrel);
  const withers = p3(EB.withers);
  const neck = p3(EB.neck);
  const head = p3(EB.head);
  const trunk1 = p3(EB.trunk1);
  const trunk2 = p3(EB.trunk2);
  const trunk3 = p3(EB.trunk3);
  const trunk4 = p3(EB.trunk4);

  // =========================================================================
  // Body
  // =========================================================================
  // An elephant is a barrel, not a pear: nearly the same width from shoulder to rump, with
  // the highest point at the *shoulder* rather than the croup. Getting that hump right is
  // most of the difference between this and a grey horse. Widths from skeletal breadth:
  // 1.36 m across the ribs on a 2.85 m animal.
  b.setPiece(ElephantPiece.Body, Tint.Atlas);
  b.sweep(
    [
      { p: [0, root[1] - 0.18, root[2] - 0.52], rx: 0.42, rz: 0.42, bone: EB.root },
      { p: [0, croup[1] - 0.16, croup[2] - 0.16], rx: 0.60, rz: 0.60, bone: EB.croup },
      { p: [0, loin[1] - 0.20, loin[2]], rx: 0.66, rz: 0.62, bone: EB.loin },
      { p: [0, barrel[1] - 0.22, barrel[2]], rx: 0.68, rz: 0.66, bone: EB.barrel },
      {
        p: [0, (barrel[1] + withers[1]) * 0.5 - 0.20, (barrel[2] + withers[2]) * 0.5],
        rx: 0.67, rz: 0.66, bone: EB.barrel, bone2: EB.withers, w: 0.5,
      },
      // The shoulder hump: the widest and tallest station on the animal.
      { p: [0, withers[1] - 0.18, withers[2]], rx: 0.64, rz: 0.64, bone: EB.withers },
      { p: [0, withers[1] - 0.26, withers[2] + 0.34], rx: 0.56, rz: 0.56, bone: EB.withers },
    ],
    UP, 12, hideUv, { capStart: true, repeatU: 7, repeatV: 5 }
  );

  // Neck and skull. Very short — two stations — because an elephant's cervical vertebrae are
  // stacked flat to carry the head and it has almost no neck to speak of.
  b.sweep(
    [
      { p: [0, neck[1] - 0.24, neck[2]], rx: 0.50, rz: 0.44, bone: EB.neck },
      { p: [0, head[1] - 0.14, head[2]], rx: 0.44, rz: 0.40, bone: EB.head },
      // The domed forehead, which on an African elephant is a single broad dome rather than
      // the Indian's twin bosses.
      { p: [0, head[1] - 0.02, head[2] + 0.26], rx: 0.40, rz: 0.36, bone: EB.head },
      { p: [0, head[1] - 0.20, head[2] + 0.42], rx: 0.32, rz: 0.30, bone: EB.head },
    ],
    UP, 11, hideUv, { capEnd: true, repeatU: 4, repeatV: 3 }
  );

  // =========================================================================
  // Trunk
  // =========================================================================
  // Tapering hard: 0.30 m at the root to 0.08 m at the tip, and the tip carries the two
  // finger-like processes an African elephant has and an Indian one does not.
  b.sweep(
    [
      { p: [0, trunk1[1] + 0.14, trunk1[2] - 0.10], rx: 0.28, rz: 0.28, bone: EB.head, bone2: EB.trunk1, w: 0.4 },
      { p: trunk1, rx: 0.23, rz: 0.23, bone: EB.trunk1 },
      { p: trunk2, rx: 0.185, rz: 0.185, bone: EB.trunk2 },
      { p: trunk3, rx: 0.14, rz: 0.14, bone: EB.trunk3 },
      { p: trunk4, rx: 0.095, rz: 0.095, bone: EB.trunk4 },
      { p: [trunk4[0], trunk4[1] - 0.14, trunk4[2] + 0.03], rx: 0.06, rz: 0.06, bone: EB.trunk4 },
    ],
    UP, 10, hideUv, { capEnd: true, repeatU: 3, repeatV: 7 }
  );

  // =========================================================================
  // Ears
  // =========================================================================
  // African, and therefore enormous — they reach above the skull and below the jaw, and they
  // are the single largest flat area on the animal. Two-sided sheets on their own bones so
  // they can flap; the flap is most of what makes a standing elephant read as alive.
  for (const [side, bone] of [[1, EB.earL], [-1, EB.earR]] as const) {
    b.setBone(bone);
    const ex = side * 0.40;
    const ey = 2.58;
    const ez = 1.70;
    const cols = 7;
    const rows = 8;
    const grid: number[][] = [];
    for (let r = 0; r < rows; r++) {
      const t = r / (rows - 1);
      const row: number[] = [];
      for (let cI = 0; cI < cols; cI++) {
        const s = cI / (cols - 1);
        // Outline: broad and square at the top, tapering to a rounded lobe at the bottom.
        const spread = 0.34 + Math.sin(t * Math.PI) * 0.52 - t * 0.18;
        const x = ex + side * s * spread;
        const y = ey + 0.30 - t * 1.05;
        // The ear cups forward and its trailing edge curls; without the curl it is a plank.
        const curl = Math.sin(s * Math.PI * 0.85) * 0.16 + s * s * 0.14;
        const z = ez - 0.08 - curl;
        const [u, v] = MeshBuilder.tileUv(hideUv, s, t);
        row.push(b.vert(x, y, z, side * 0.35, 0.1, -0.9, u, v));
      }
      grid.push(row);
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let cI = 0; cI < cols - 1; cI++) {
        // Both windings, so an ear is visible from in front and behind without a two-sided
        // material — the same trick the horse's mane and the cloaks use.
        b.quad(grid[r][cI], grid[r][cI + 1], grid[r + 1][cI + 1], grid[r + 1][cI]);
        b.quad(grid[r][cI], grid[r + 1][cI], grid[r + 1][cI + 1], grid[r][cI + 1]);
      }
    }
  }

  // =========================================================================
  // Legs
  // =========================================================================
  // Columns. The radius barely changes down the limb, which is the whole visual point: a
  // horse's leg is a taper from a heavy shoulder to a fine cannon, an elephant's is a pillar
  // that stands on a pad.
  const leg = (chain: readonly number[], r0: number, r1: number): void => {
    const nodes = chain.map((bone, i) => {
      const t = i / (chain.length - 1);
      const rad = r0 + (r1 - r0) * t;
      return { p: p3(bone), rx: rad, rz: rad * 1.06, bone };
    });
    b.setPiece(ElephantPiece.Body, Tint.Atlas);
    b.sweep(nodes, UP, 8, hideUv, { capStart: true, repeatU: 3, repeatV: 4 });
    // The foot: a broad fibrous pad, wider than the leg, with the toenails set round its
    // front edge. The pad is why an elephant leaves a round print and why it walks silently.
    const foot = chain[chain.length - 1];
    const fp = p3(foot);
    b.setBone(foot);
    b.setMatrix(new THREE.Matrix4().makeTranslation(fp[0], fp[1], fp[2]));
    b.revolve(
      [[0.001, 0.02], [0.20, -0.02], [0.245, -0.10], [0.225, -0.175], [0.001, -0.19]],
      9, hideUv
    );
    // Toenails — four on the front feet, three behind, but at this scale the count reads as
    // "a row of pale ovals round the toe" and the exact number is not the point.
    b.setPiece(ElephantPiece.Barding, Tint.Atlas);
    for (let n = 0; n < 4; n++) {
      const a = (-0.62 + (n / 3) * 1.24);
      b.setMatrix(new THREE.Matrix4().makeTranslation(
        fp[0] + Math.sin(a) * 0.185, fp[1] - 0.115, fp[2] + Math.cos(a) * 0.185
      ));
      b.revolve([[0.001, 0.045], [0.042, 0.03], [0.046, -0.03], [0.001, -0.045]], 5, boneUv);
    }
    b.setMatrix(null);
    b.setPiece(ElephantPiece.Body, Tint.Atlas);
  };

  leg([EB.fShoulderL, EB.fUpperL, EB.fKneeL, EB.fFootL], 0.27, 0.21);
  leg([EB.fShoulderR, EB.fUpperR, EB.fKneeR, EB.fFootR], 0.27, 0.21);
  leg([EB.bHipL, EB.bFemurL, EB.bHockL, EB.bFootL], 0.30, 0.22);
  leg([EB.bHipR, EB.bFemurR, EB.bHockR, EB.bFootR], 0.30, 0.22);

  // Tail: thin, with the tuft of coarse black bristle at the end.
  {
    const t1 = p3(EB.tail1);
    const t2 = p3(EB.tail2);
    b.sweep(
      [
        { p: t1, rx: 0.075, rz: 0.075, bone: EB.tail1 },
        { p: t2, rx: 0.05, rz: 0.05, bone: EB.tail2 },
        { p: [t2[0], t2[1] - 0.30, t2[2] - 0.04], rx: 0.035, rz: 0.035, bone: EB.tail2 },
      ],
      UP, 6, hideUv, { capEnd: true, repeatV: 4 }
    );
    b.setBone(EB.tail2);
    b.setMatrix(new THREE.Matrix4().makeTranslation(t2[0], t2[1] - 0.36, t2[2] - 0.05));
    b.revolve([[0.03, 0.06], [0.055, -0.04], [0.03, -0.14], [0.001, -0.19]], 6, matUv(Mat.Hair));
    b.setMatrix(null);
  }

  // =========================================================================
  // Tusks
  // =========================================================================
  // Forest-elephant tusks: straighter and thinner than a bush elephant's, sweeping forward
  // and slightly down before the tips turn up. They emerge from the upper jaw either side of
  // the trunk, not from the mouth, which is the detail most reconstructions get wrong.
  b.setPiece(ElephantPiece.Barding, Tint.Atlas);
  for (const s of [-1, 1]) {
    b.setBone(EB.head);
    const bx = s * 0.24;
    b.sweep(
      [
        { p: [bx, 2.26, 2.08], rx: 0.075, rz: 0.075 },
        { p: [bx * 1.05, 2.10, 2.36], rx: 0.068, rz: 0.068 },
        { p: [bx * 1.12, 1.94, 2.66], rx: 0.056, rz: 0.056 },
        { p: [bx * 1.16, 1.86, 2.96], rx: 0.042, rz: 0.042 },
        // The tip turns up, which is what catches the light and what a man is thrown by.
        { p: [bx * 1.18, 1.92, 3.20], rx: 0.024, rz: 0.024 },
        { p: [bx * 1.18, 2.02, 3.34], rx: 0.008, rz: 0.008 },
      ],
      UP, 7, boneUv, { capStart: true, capEnd: true, repeatV: 2 }
    );
    // A bronze band and a socket ferrule where the tusk leaves the lip — Punic and
    // Hellenistic practice was to cap or band a war elephant's tusks, and it reads as
    // deliberate equipment rather than as an animal that wandered in.
    b.setMatrix(new THREE.Matrix4().makeTranslation(bx, 2.24, 2.12));
    b.revolve([[0.083, 0.05], [0.09, 0.0], [0.088, -0.07], [0.078, -0.09]], 8, bronzeUv);
    b.setMatrix(new THREE.Matrix4().makeTranslation(bx * 1.16, 1.88, 2.92));
    b.revolve([[0.046, 0.04], [0.05, 0.0], [0.046, -0.06]], 7, bronzeUv);
    b.setMatrix(null);
  }

  // =========================================================================
  // Chamfron — the bronze head plate
  // =========================================================================
  /**
   * The single most important object on this mesh.
   *
   * In `r2-08` it dominates the animal: a broad embossed plate covering the whole forehead,
   * running down over the top of the trunk root, with a raised central rib, a domed boss and
   * a scalloped lower edge. It is polished copper-bronze against grey hide, which makes it
   * the only saturated thing in the frame and the reason four elephants at forty metres read
   * as *armoured* elephants.
   *
   * Built as a sheet that follows the skull's own dome 15 mm off it, rather than as a box in
   * front of the face. `horseMesh.ts` records what happens otherwise: its saddle cloth was a
   * box centred inside the barrel, so all a camera ever saw of it was two rectangles poking
   * out of the ribs.
   */
  {
    b.setPiece(ElephantPiece.Barding, Tint.Metal);
    b.setBone(EB.head);
    const cols = 7;
    const rows = 7;
    const grid: number[][] = [];
    for (let r = 0; r < rows; r++) {
      const t = r / (rows - 1);
      const row: number[] = [];
      for (let cI = 0; cI < cols; cI++) {
        const s = (cI / (cols - 1)) * 2 - 1;
        // Follow the skull: an ellipse in x, dropping down the face as t rises.
        const halfW = (0.40 - t * 0.10) * Math.sqrt(Math.max(0, 1 - t * t * 0.22));
        const x = s * halfW;
        // Down the dome and over the brow onto the trunk root.
        const y = 2.86 - t * 0.92;
        const arch = Math.sqrt(Math.max(0, 1 - s * s)) * (0.30 - t * 0.08);
        const z = head[2] + 0.16 + arch + Math.sin(t * Math.PI * 0.8) * 0.14;
        // A raised central rib, and the domed boss at the brow.
        const rib = Math.exp(-(s * s) / 0.05) * 0.035;
        const boss = Math.exp(-((s * s) / 0.16 + ((t - 0.42) ** 2) / 0.012)) * 0.075;
        const [u, v] = MeshBuilder.tileUv(bronzeUv, (s + 1) * 0.5, t);
        row.push(b.vert(x, y, z + rib + boss, s * 0.7, 0.35, 0.62, u, v));
      }
      grid.push(row);
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let cI = 0; cI < cols - 1; cI++) {
        b.quad(grid[r][cI], grid[r][cI + 1], grid[r + 1][cI + 1], grid[r + 1][cI]);
      }
    }
    // Scalloped lower edge: a row of half-round lobes hanging off the bottom rank, which is
    // the detail that stops the plate reading as a piece of sheet metal taped to a head.
    // The bottom row's positions are recomputed here rather than read back out of the
    // builder, which keeps no vertex table a caller can query.
    const last = grid[rows - 1];
    for (let cI = 0; cI < cols - 1; cI++) {
      const s0 = (cI / (cols - 1)) * 2 - 1;
      const s1 = ((cI + 1) / (cols - 1)) * 2 - 1;
      const sm = (s0 + s1) * 0.5;
      const halfW = 0.30;
      const arch = Math.sqrt(Math.max(0, 1 - sm * sm)) * 0.22;
      const [u, v] = MeshBuilder.tileUv(bronzeUv, (sm + 1) * 0.5, 1);
      const tip = b.vert(
        sm * halfW, 2.86 - 0.92 - 0.10, head[2] + 0.16 + arch + Math.sin(0.8 * Math.PI) * 0.14,
        0, -0.2, 0.98, u, v
      );
      b.tri(last[cI], last[cI + 1], tip);
    }
  }

  // =========================================================================
  // Scale barding — trunk and chest
  // =========================================================================
  // A mail or lamellar bib hanging over the chest between the forelegs, and a sleeve of
  // scale down the length of the trunk. Both are clearly visible in r2-08 and both are
  // practical: the trunk and the hamstrings are where a man with a sword goes for.
  {
    // Trunk sleeve: a tapering tube 12 mm off the trunk, bound to the same bones.
    b.setPiece(ElephantPiece.Barding, Tint.Atlas);
    b.sweep(
      [
        { p: [0, trunk1[1] + 0.02, trunk1[2] - 0.02], rx: 0.245, rz: 0.245, bone: EB.trunk1 },
        { p: trunk2, rx: 0.198, rz: 0.198, bone: EB.trunk2 },
        { p: lerp3(trunk2, trunk3, 0.6), rx: 0.168, rz: 0.168, bone: EB.trunk2, bone2: EB.trunk3, w: 0.4 },
        { p: trunk3, rx: 0.152, rz: 0.152, bone: EB.trunk3 },
      ],
      UP, 9, scaleUv, { repeatU: 2, repeatV: 3 }
    );
    /**
     * Chest bib: scale barding slung across the front of the shoulders.
     *
     * It was a **rectangle** — six columns by four rows, 1.04 m wide at the top and 0.88 at
     * the bottom, with four square corners and a straight hem — bulged over a cylinder. At
     * any distance that reads as a signboard hung on the animal, which is the fourth thing
     * the model viewer found and the only one of the four that is visible on a *live*
     * elephant as much as on a dead one.
     *
     * Three changes, none of them a new material: the outline is an ellipse narrowed at the
     * throat and rounded off at the bottom, so no corner is square; the hem is a row of
     * pointed lappets, which is how lamellar and mail barding actually terminates and the
     * same device the chamfron's scalloped edge already uses on this mesh; and the surface
     * carries a shallow fold across it rather than being a section of a perfect cylinder.
     */
    b.setBone(EB.withers);
    const cols = 9;
    const rows = 6;
    /** Half-width of the bib at parameter t down it, metres. */
    const bibHalf = (t: number): number => {
      // An ellipse about a waist at t = 0.42: narrower at the throat where it is slung from
      // the neck strap, widest across the points of the shoulders, drawn in at the bottom.
      const e = Math.sqrt(Math.max(0, 1 - ((t - 0.42) / 0.75) ** 2 * 0.62));
      const round = t < 0.76 ? 1 : 1 - 0.62 * ((t - 0.76) / 0.24) ** 1.7;
      return 0.56 * e * round;
    };
    const bibY = (t: number): number => 2.42 - t * 1.06;
    const bibZ = (t: number, s: number): number => {
      const bulge = Math.sqrt(Math.max(0, 1 - s * s)) * 0.20;
      // One shallow fold across the sheet, so it is cloth over mail and not a lathe section.
      const fold = 0.018 * Math.cos(s * Math.PI * 2.6) * Math.sin(t * Math.PI);
      return withers[2] + 0.26 + bulge + fold - t * 0.10;
    };
    const grid: number[][] = [];
    for (let r = 0; r < rows; r++) {
      const t = r / (rows - 1);
      const row: number[] = [];
      for (let cI = 0; cI < cols; cI++) {
        const s = (cI / (cols - 1)) * 2 - 1;
        const [u, v] = MeshBuilder.tileUvWrapped(scaleUv, (s + 1) * 0.5, t, 2, 3);
        row.push(b.vert(s * bibHalf(t), bibY(t), bibZ(t, s), s * 0.6, 0.1, 0.79, u, v));
      }
      grid.push(row);
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let cI = 0; cI < cols - 1; cI++) {
        b.quad(grid[r][cI], grid[r][cI + 1], grid[r + 1][cI + 1], grid[r + 1][cI]);
        b.quad(grid[r][cI], grid[r + 1][cI], grid[r + 1][cI + 1], grid[r][cI + 1]);
      }
    }
    // The lappets. Four pointed tabs off the hem, alternating length so the bottom edge is
    // not a straight line — the same reason the chamfron's lower edge is scalloped.
    {
      const last = grid[rows - 1];
      for (let cI = 0; cI < cols - 1; cI++) {
        const s0 = (cI / (cols - 1)) * 2 - 1;
        const s1 = ((cI + 1) / (cols - 1)) * 2 - 1;
        const sm = (s0 + s1) * 0.5;
        const drop = 0.10 + (cI % 2 === 0 ? 0.07 : 0.02);
        const [u, v] = MeshBuilder.tileUvWrapped(scaleUv, (sm + 1) * 0.5, 1, 2, 3);
        const tip = b.vert(
          sm * bibHalf(1) * 0.94, bibY(1) - drop, bibZ(1, sm) - 0.012,
          sm * 0.5, -0.35, 0.79, u, v
        );
        b.tri(last[cI], last[cI + 1], tip);
        b.tri(last[cI + 1], last[cI], tip);
      }
    }
  }

  // =========================================================================
  // Caparison and girth
  // =========================================================================
  /**
   * The dyed cloth the tower sits on, hanging down both flanks.
   *
   * ## What it replaces, and what was actually wrong
   * The reported defect was "the howdah separates from the back, leaving daylight under the
   * caparison", and the cause on record was "a rigid `barrel`/`loin` bind against the hide's
   * skinning". **That is provably not the mechanism.** Nothing but `root` carries a rotation
   * track on the spine in any elephant clip, and a track's delta accumulates unchanged down
   * the chain, so `croup`, `loin`, `barrel` and `withers` all hold *identical* skinning
   * transforms on every frame of every clip. Skinning the tower's own vertices with
   * `barrel 0.72 / loin 0.28` and with `barrel` alone differs by **0.000000 m at all 26
   * frames of the death clip** (`tools/scratch/carc-gap-entry.ts` runs that control). The
   * bind could not open a gap and never did.
   *
   * What opens the gap is this piece of geometry. It used to be **two rings and six columns
   * — five quads** — spanning z −0.77 to +1.01 at a fixed 0.70 m radius, so:
   *   - between its two end rings it was a straight ruled tent over a barrel that tapers,
   *     and its ends were hard straight edges standing 60-80 mm proud of the flank;
   *   - it stopped short of the tower fore and aft, so from the side there was nothing
   *     between the platform's underside and the sky;
   *   - and at the equator it dropped a flat 0.34 m skirt with a horizontal hem, which is
   *     the "caparison hanging in the air" in the report.
   *
   * It is now a drape on **the hide's own stations**: same z, same axis height, same radii
   * plus 30 mm of clearance, and each station bound to the bone the hide uses there. It runs
   * z −1.15 to +1.15, past both ends of the tower, and hangs a scalloped skirt that is
   * deepest amidships. Cloth, so both windings.
   */
  {
    // `Tint.Tunic`, not `Tint.Focale`. Focale is the neck-scarf palette and the shader picks
    // it from a hash, which put a bright gold sheet over every animal — by a wide margin the
    // loudest thing in the first frame and completely wrong against the reference, where the
    // cloth under the tower is a dark dyed drape. `Tunic` is the slot `pushElephant` writes
    // the per-animal Punic crimson into.
    b.setPiece(ElephantPiece.Tower, Tint.Tunic);
    /**
     * One station per ring, read off the hide sweep above rather than invented.
     *
     * `cy`, `rx` and `ry` are the hide's own axis height and half-widths at that z — linearly
     * interpolated between its nodes where a station falls between two — and `bone`/`w` is
     * the bind that ring of hide carries. Copying them is the whole point: cloth that is
     * everywhere 30 mm off the animal cannot show daylight against it.
     */
    const drape: readonly {
      z: number; cy: number; rx: number; ry: number;
      bone: number; bone2?: number; w?: number;
    }[] = [
      { z: -1.15, cy: 2.514, rx: 0.622, ry: 0.607, bone: EB.croup, bone2: EB.loin, w: 0.5 },
      { z: -0.60, cy: 2.540, rx: 0.660, ry: 0.620, bone: EB.loin },
      { z: 0.15, cy: 2.540, rx: 0.680, ry: 0.660, bone: EB.barrel },
      { z: 0.535, cy: 2.590, rx: 0.670, ry: 0.660, bone: EB.barrel, bone2: EB.withers, w: 0.5 },
      { z: 0.920, cy: 2.640, rx: 0.640, ry: 0.640, bone: EB.withers },
      { z: 1.150, cy: 2.586, rx: 0.586, ry: 0.586, bone: EB.withers },
    ];
    /** Clearance off the hide, metres — cloth, not a second skin. */
    const CLOTH = 0.03;
    /** Where the drape stops hugging and starts hanging free, as a fraction of the span. */
    const HANG = 0.78;
    const COLS = 11;
    const grid: number[][] = drape.map((st, r) => {
      const ti = r / (drape.length - 1);
      // Deepest amidships, shorter over the croup and the shoulder, with a scallop so the
      // hem is not a straight line down the animal.
      const drop = (0.30 + 0.22 * Math.sin(Math.PI * ti)) * (1 + 0.10 * Math.cos(r * 2.3));
      b.setBone(st.bone, st.bone2 ?? st.bone, st.bone2 === undefined ? 1 : (st.w ?? 0.5));
      const row: number[] = [];
      for (let cI = 0; cI < COLS; cI++) {
        const s = (cI / (COLS - 1)) * 2 - 1;
        const u = Math.max(-1, Math.min(1, s / HANG));
        const a = u * 1.676;
        let x = (st.rx + CLOTH) * Math.sin(a);
        let y = st.cy + (st.ry + CLOTH) * Math.cos(a);
        const over = Math.max(0, Math.abs(s) - HANG) / (1 - HANG);
        if (over > 0) {
          y -= over * drop;
          x += Math.sign(s) * over * 0.035;
        }
        const nx = Math.sin(a);
        const ny = over > 0 ? Math.cos(a) * 0.4 : Math.cos(a);
        const [uu, vv] = MeshBuilder.tileUvWrapped(clothUv, (s + 1) * 0.5, ti, 3, 2);
        row.push(b.vert(x, y, st.z, nx, ny, 0, uu, vv));
      }
      return row;
    });
    for (let r = 0; r < grid.length - 1; r++) {
      for (let cI = 0; cI < COLS - 1; cI++) {
        b.quad(grid[r][cI], grid[r][cI + 1], grid[r + 1][cI + 1], grid[r + 1][cI]);
        b.quad(grid[r][cI], grid[r + 1][cI], grid[r + 1][cI + 1], grid[r][cI + 1]);
      }
    }

    /**
     * Two girth ropes over the caparison, which is what actually holds a howdah on.
     *
     * They used to be a *straight vertical ribbon* 1.44 m wide and 90 mm thick driven
     * through the animal — `rx: 0.72` on a two-node sweep — so all that was ever visible of
     * a rope was the two slivers where a flat plate emerged from a round back, at 90 degrees
     * to it. On the carcass, where the whole flank is presented, they read as a pair of
     * striped fins. Each is now a 70 mm tube following the drape's own section.
     */
    b.setPiece(ElephantPiece.Tower, Tint.Atlas);
    for (const gz of [-0.47, 0.73]) {
      // Nearest drape station, so the strap lies on the cloth rather than intersecting it.
      let st = drape[0];
      for (const d of drape) if (Math.abs(d.z - gz) < Math.abs(st.z - gz)) st = d;
      b.setBone(st.bone, st.bone2 ?? st.bone, st.bone2 === undefined ? 1 : (st.w ?? 0.5));
      const N = 11;
      const nodes = [];
      for (let i = 0; i < N; i++) {
        const a = ((i / (N - 1)) * 2 - 1) * 1.83;
        nodes.push({
          p: [
            (st.rx + CLOTH + 0.045) * Math.sin(a),
            st.cy + (st.ry + CLOTH + 0.045) * Math.cos(a),
            gz,
          ] as [number, number, number],
          rx: 0.035,
          rz: 0.035,
        });
      }
      b.sweep(nodes, [0, 0, 1], 5, ropeUv, { repeatV: 3 });
    }
  }

  // =========================================================================
  // The howdah
  // =========================================================================
  /**
   * A crenellated fighting tower, which is the other half of the silhouette.
   *
   * Built as real carpentry rather than as a crenellated box: four corner posts, a floor, a
   * rail, vertical planking between the posts, and merlons standing above the rail with
   * embrasures between them. r2-08 shows all of that clearly, and it matters because a
   * plain box with square teeth on top reads as a battlement prop, where posts and planks
   * read as something a carpenter built to be carried.
   *
   * On the historical argument about whether a North African forest elephant could carry
   * one at all, see `elephantSkeleton.ts`: the plates show towers, so there is a tower, but
   * the animal under it is honestly sized.
   */
  {
    b.setPiece(ElephantPiece.Tower, Tint.Atlas);
    b.setBone(HOWDAH_BONES.bone0, HOWDAH_BONES.bone1, HOWDAH_BONES.weight0);
    const fy = HOWDAH.y;
    const hx = HOWDAH.halfX;
    const hz = HOWDAH.halfZ;
    const cz = HOWDAH.z;

    // Floor: a platform of cross-planks on two bearers.
    b.setMatrix(new THREE.Matrix4().makeTranslation(0, fy - 0.06, cz));
    b.box(0, 0, 0, hx * 2 + 0.10, 0.10, hz * 2 + 0.10, oakUv);
    b.setMatrix(null);
    for (const sx of [-1, 1]) {
      b.setMatrix(new THREE.Matrix4().makeTranslation(sx * (hx - 0.10), fy - 0.15, cz));
      b.box(0, 0, 0, 0.13, 0.12, hz * 2, oakUv);
      b.setMatrix(null);
    }

    // Corner posts, standing proud of the rail so they read as structure.
    const postH = HOWDAH.wall + HOWDAH.merlon + 0.06;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.setMatrix(new THREE.Matrix4().makeTranslation(
          sx * hx, fy + postH * 0.5 - 0.02, cz + sz * hz
        ));
        b.box(0, 0, 0, 0.13, postH, 0.13, oakUv);
        b.setMatrix(null);
      }
    }

    // Planked walls between the posts, and the merlons above them. Walked as four sides so
    // the front can be lower than the back — a crew has to shoot over the front.
    const sides: { nx: number; nz: number; half: number; lower: boolean }[] = [
      { nx: 0, nz: 1, half: hx, lower: true },
      { nx: 0, nz: -1, half: hx, lower: false },
      { nx: 1, nz: 0, half: hz, lower: false },
      { nx: -1, nz: 0, half: hz, lower: false },
    ];
    for (const side of sides) {
      const wall = HOWDAH.wall - (side.lower ? 0.12 : 0);
      const ox = side.nx * hx;
      const oz = cz + side.nz * hz;
      const along = side.nx === 0 ? 1 : 0;
      // Planking, laid vertically as the plate shows, with a visible gap every plank.
      // Wider boards. At a 0.19 m pitch the wall came out as a regular horizontal weave that
      // read as basketry rather than as sawn planks — the tile's own grain was finer than the
      // boards it was drawn on, which inverts the visual hierarchy.
      const n = Math.max(3, Math.round((side.half * 2) / 0.29));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5;
        const px = ox + (along ? t * side.half * 2 : 0);
        const pz = oz + (along ? 0 : t * side.half * 2);
        b.setMatrix(new THREE.Matrix4().makeTranslation(px, fy + wall * 0.5, pz));
        b.box(0, 0, 0,
          along ? (side.half * 2) / n - 0.030 : 0.075,
          wall,
          along ? 0.075 : (side.half * 2) / n - 0.030,
          plankUv);
        b.setMatrix(null);
      }
      // Cap rail.
      b.setMatrix(new THREE.Matrix4().makeTranslation(ox, fy + wall + 0.035, oz));
      b.box(0, 0, 0,
        along ? side.half * 2 + 0.13 : 0.10, 0.07,
        along ? 0.10 : side.half * 2 + 0.13, oakUv);
      b.setMatrix(null);
      // Merlons: three or four per side with embrasures between, standing on the rail.
      const m = along ? 3 : 3;
      for (let i = 0; i < m; i++) {
        const t = (i + 0.5) / m - 0.5;
        const px = ox + (along ? t * side.half * 2 : 0);
        const pz = oz + (along ? 0 : t * side.half * 2);
        const w = (side.half * 2) / m * 0.58;
        b.setMatrix(new THREE.Matrix4().makeTranslation(px, fy + wall + HOWDAH.merlon * 0.5 + 0.06, pz));
        b.box(0, 0, 0,
          along ? w : 0.085, HOWDAH.merlon,
          along ? 0.085 : w, plankUv);
        b.setMatrix(null);
      }
    }

    // Lashings: rope turns over the corner posts and down to the girths, which is the only
    // honest way a tower stays on a moving animal and reads as tension in the frame.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.sweep(
          [
            { p: [sx * hx, fy + 0.06, cz + sz * hz], rx: 0.022, rz: 0.022 },
            { p: [sx * (hx + 0.22), fy - 0.42, cz + sz * (hz + 0.06)], rx: 0.022, rz: 0.022 },
            { p: [sx * 0.70, barrel[1] - 0.34, cz + sz * 0.58], rx: 0.022, rz: 0.022 },
          ],
          UP, 5, ropeUv
        );
      }
    }

    // A pair of javelin quivers strapped inside the front wall, which is what the crew are
    // actually shooting and is the small piece of kit that makes the platform look served.
    b.setPiece(ElephantPiece.Tower, Tint.Atlas);
    for (const sx of [-1, 1]) {
      b.setMatrix(new THREE.Matrix4().makeTranslation(sx * (hx - 0.14), fy + 0.30, cz + hz - 0.10));
      b.revolve([[0.001, 0.30], [0.075, 0.26], [0.08, -0.22], [0.001, -0.26]], 6, leatherUv);
      b.setMatrix(null);
      for (let j = 0; j < 3; j++) {
        b.setMatrix(new THREE.Matrix4().makeTranslation(
          sx * (hx - 0.14) + (j - 1) * 0.03, fy + 0.66, cz + hz - 0.10 + (j - 1) * 0.02
        ));
        b.box(0, 0, 0, 0.016, 0.44, 0.016, ironUv);
        b.setMatrix(null);
      }
    }
  }

  return b.toGeometry('war-elephant');
}
