import * as THREE from 'three';
import { HORSE_RIG, HB } from '../anim/rig';
import { Mat, matUv } from './atlas';
import { Tint } from './kit';
import { MeshBuilder } from './meshBuilder';
import type { Lod } from './soldierMesh';

/**
 * The cavalry mount, built procedurally on the retargeted horse rig.
 *
 * Roman cavalry rode small animals — 14 to 15 hands, closer to a Camargue or a Barb than
 * anything modern — with a four-horned saddle and no stirrups. That is why a rider's legs
 * hang long and straight in the reliefs, and it is worth getting right because the
 * rider-to-horse proportion is the first thing that reads as wrong.
 *
 * Coat colour is per-instance through the tint system: the hide tile carries hair and
 * dapple detail in greyscale and `iCol0` supplies bay, chestnut, grey or black, so one
 * geometry and one texture cover the whole remount depot.
 */

export const enum HorsePiece {
  Body = 0,
  Tack = 1,
  Mane = 2,
  Count = 3,
}

/** All horses show body, tack and mane; the mask never varies. */
export const HORSE_MASK_LO = 0b111;

const p3 = (b: number): [number, number, number] => [
  HORSE_RIG.restT[b * 3],
  HORSE_RIG.restT[b * 3 + 1],
  HORSE_RIG.restT[b * 3 + 2],
];

/** Linear interpolation between two bone rest positions, for intermediate rings. */
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

interface HorseDetail {
  body: number;
  leg: number;
  fine: boolean;
  medium: boolean;
}

const DETAIL: Record<Lod, HorseDetail> = {
  0: { body: 10, leg: 6, fine: true, medium: true },
  1: { body: 7, leg: 5, fine: false, medium: false },
  2: { body: 5, leg: 3, fine: false, medium: false },
};

/** Saddle position, so the render system can seat the rider without guessing. */
export function saddleOffset(): { y: number; z: number } {
  const barrel = p3(HB.barrel);
  const loin = p3(HB.loin);
  // Just behind the withers, on top of the barrel. 0.30 m clears the ribs plus the blanket.
  return { y: (barrel[1] + loin[1]) * 0.5 + 0.3, z: (barrel[2] + loin[2]) * 0.5 - 0.02 };
}

export function buildHorseGeometry(lod: Lod): THREE.InstancedBufferGeometry {
  const b = new MeshBuilder();
  const d = DETAIL[lod];

  const hideUv = matUv(Mat.HideBay);
  const maneUv = matUv(Mat.Mane);
  const hoofUv = matUv(Mat.Hoof);
  const leatherUv = matUv(Mat.SaddleLeather);
  const bronzeUv = matUv(Mat.Bronze);
  const clothUv = matUv(Mat.WoolCoarse);

  const hind = p3(HB.hind);
  const croup = p3(HB.croup);
  const loin = p3(HB.loin);
  const barrel = p3(HB.barrel);
  const withers = p3(HB.withers);
  const neck1 = p3(HB.neck1);
  const neck2 = p3(HB.neck2);
  const neck3 = p3(HB.neck3);
  const head = p3(HB.head);

  // =========================================================================
  // Barrel and quarters
  // =========================================================================
  // A 15-hand horse is about 0.55 m across the ribs and 0.72 m deep through the girth,
  // narrowing sharply at the loin — the "pear" shape seen from above.
  b.setPiece(HorsePiece.Body, Tint.Tunic);
  b.sweep(
    [
      { p: lerp3(croup, hind, 0.55), rx: 0.2, rz: 0.24, bone: HB.hind },
      { p: croup, rx: 0.26, rz: 0.3, bone: HB.croup },
      { p: lerp3(croup, loin, 0.5), rx: 0.25, rz: 0.31, bone: HB.croup, bone2: HB.loin, w: 0.5 },
      { p: loin, rx: 0.23, rz: 0.31, bone: HB.loin },
      { p: lerp3(loin, barrel, 0.5), rx: 0.26, rz: 0.34, bone: HB.loin, bone2: HB.barrel, w: 0.5 },
      { p: barrel, rx: 0.275, rz: 0.36, bone: HB.barrel },
      { p: lerp3(barrel, withers, 0.55), rx: 0.25, rz: 0.35, bone: HB.barrel, bone2: HB.withers, w: 0.5 },
      { p: withers, rx: 0.19, rz: 0.27, bone: HB.withers },
    ],
    UP, d.body, hideUv, { capStart: true, repeatU: 1, repeatV: 2 }
  );

  // =========================================================================
  // Neck and head
  // =========================================================================
  b.sweep(
    [
      { p: withers, rx: 0.17, rz: 0.24, bone: HB.withers },
      { p: neck1, rx: 0.135, rz: 0.22, bone: HB.neck1 },
      { p: neck2, rx: 0.115, rz: 0.2, bone: HB.neck2 },
      { p: neck3, rx: 0.095, rz: 0.16, bone: HB.neck3 },
      { p: lerp3(neck3, head, 0.85), rx: 0.08, rz: 0.13, bone: HB.neck3, bone2: HB.head, w: 0.4 },
    ],
    UP, d.body, hideUv, { repeatV: 2 }
  );

  // Head: jowl, then the long taper of the face to the muzzle.
  {
    const dirx = head[0] - neck3[0];
    const diry = head[1] - neck3[1];
    const dirz = head[2] - neck3[2];
    const len = Math.hypot(dirx, diry, dirz) || 1;
    // The skull carries on past the head bone, angled down toward the muzzle.
    const muzzle: [number, number, number] = [
      head[0] + (dirx / len) * 0.02,
      head[1] - 0.3,
      head[2] + 0.16,
    ];
    b.sweep(
      [
        { p: lerp3(neck3, head, 0.8), rx: 0.085, rz: 0.13, bone: HB.head },
        { p: head, rx: 0.082, rz: 0.12, bone: HB.head },
        { p: lerp3(head, muzzle, 0.45), rx: 0.062, rz: 0.085, bone: HB.head },
        { p: lerp3(head, muzzle, 0.85), rx: 0.05, rz: 0.062, bone: HB.head },
        { p: muzzle, rx: 0.046, rz: 0.05, bone: HB.head },
      ],
      UP, Math.max(5, d.body - 3), hideUv, { capEnd: true }
    );
    if (d.medium) {
      // Ears, pricked forward.
      b.setBone(HB.head);
      for (const s of [-1, 1]) {
        const m = new THREE.Matrix4()
          .makeRotationZ(s * 15 * (Math.PI / 180))
          .premultiply(new THREE.Matrix4().makeTranslation(head[0] + s * 0.062, head[1] + 0.08, head[2] - 0.03));
        b.setMatrix(m);
        b.revolve([[0.001, 0.11], [0.022, 0.055], [0.028, 0.0], [0.02, -0.02]], 5, hideUv);
        b.setMatrix(null);
      }
      // Eyes, set on the sides of the skull.
      b.setPiece(HorsePiece.Body, Tint.Atlas);
      for (const s of [-1, 1]) {
        b.setMatrix(new THREE.Matrix4().makeTranslation(head[0] + s * 0.075, head[1] - 0.02, head[2] + 0.03));
        b.revolve([[0.001, 0.02], [0.02, 0.008], [0.02, -0.008], [0.001, -0.02]], 5, matUv(Mat.HideBlack));
        b.setMatrix(null);
      }
      b.setPiece(HorsePiece.Body, Tint.Tunic);
    }
  }

  // =========================================================================
  // Legs
  // =========================================================================
  const leg = (
    chain: readonly number[],
    radii: readonly number[],
    hoofBone: number
  ): void => {
    const nodes = chain.map((bone, i) => ({
      p: p3(bone),
      rx: radii[i],
      rz: radii[i] * 1.15,
      bone,
    }));
    b.setPiece(HorsePiece.Body, Tint.Tunic);
    b.sweep(nodes, UP, d.leg, hideUv, { capStart: true });
    // Hoof: a short dark cylinder below the pastern.
    b.setPiece(HorsePiece.Body, Tint.Atlas);
    b.setBone(hoofBone);
    const hp = p3(hoofBone);
    b.setMatrix(new THREE.Matrix4().makeTranslation(hp[0], hp[1], hp[2]));
    b.revolve(
      [[0.001, 0.005], [0.045, -0.005], [0.052, -0.06], [0.048, -0.09], [0.001, -0.095]],
      Math.max(5, d.leg - 1), hoofUv
    );
    b.setMatrix(null);
    b.setPiece(HorsePiece.Body, Tint.Tunic);
  };

  // Fore legs: shoulder, forearm, cannon. Thick above, fine below — the "clean leg" that
  // makes a horse look like a horse rather than a table.
  leg([HB.fShoulderL, HB.fUpperL, HB.fLowerL, HB.fHoofL], [0.115, 0.1, 0.05, 0.042], HB.fHoofL);
  leg([HB.fShoulderR, HB.fUpperR, HB.fLowerR, HB.fHoofR], [0.115, 0.1, 0.05, 0.042], HB.fHoofR);
  // Hind legs: the stifle and hock give the deep zig-zag.
  leg([HB.bHipL, HB.bFemurL, HB.bTibiaL, HB.bCannonL, HB.bHoofL], [0.14, 0.13, 0.105, 0.05, 0.042], HB.bHoofL);
  leg([HB.bHipR, HB.bFemurR, HB.bTibiaR, HB.bCannonR, HB.bHoofR], [0.14, 0.13, 0.105, 0.05, 0.042], HB.bHoofR);

  // =========================================================================
  // Mane and tail
  // =========================================================================
  b.setPiece(HorsePiece.Mane, Tint.Legs);
  if (d.medium) {
    const rows = d.fine ? 7 : 4;
    const crest: [number, number, number][] = [withers, neck1, neck2, neck3, head];
    const grid: number[][] = [];
    const bones = [HB.withers, HB.neck1, HB.neck2, HB.neck3, HB.head];
    for (let r = 0; r < rows; r++) {
      const t = r / (rows - 1);
      const seg = Math.min(crest.length - 2, Math.floor(t * (crest.length - 1)));
      const ft = t * (crest.length - 1) - seg;
      const p = lerp3(crest[seg], crest[seg + 1], ft);
      b.setBone(bones[seg], bones[seg + 1], 1 - ft);
      const row: number[] = [];
      for (let c = 0; c < 3; c++) {
        const s = (c - 1) * 0.05;
        // Hangs to the off side, as a mane trained over does.
        const drop = c === 1 ? 0 : -0.1 - Math.abs(s) * 0.6;
        const [u, v] = MeshBuilder.tileUv(maneUv, (c + 1) / 3, t, 1, 2);
        row.push(b.vert(p[0] + s * 1.6, p[1] + 0.2 + drop, p[2] - 0.02, s * 4, 1, 0, u, v));
      }
      grid.push(row);
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < 2; c++) {
        b.quad(grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c]);
        b.quad(grid[r][c], grid[r + 1][c], grid[r + 1][c + 1], grid[r][c + 1]);
      }
    }
  }

  {
    const t1 = p3(HB.tail1);
    const t2 = p3(HB.tail2);
    b.sweep(
      [
        { p: t1, rx: 0.055, rz: 0.055, bone: HB.tail1 },
        { p: lerp3(t1, t2, 0.5), rx: 0.06, rz: 0.06, bone: HB.tail1, bone2: HB.tail2, w: 0.5 },
        { p: t2, rx: 0.05, rz: 0.05, bone: HB.tail2 },
        { p: [t2[0], t2[1] - 0.42, t2[2] - 0.08], rx: 0.03, rz: 0.03, bone: HB.tail2 },
      ],
      UP, Math.max(4, d.leg - 2), maneUv, { capEnd: true, repeatV: 3 }
    );
  }

  // =========================================================================
  // Tack
  // =========================================================================
  b.setPiece(HorsePiece.Tack, Tint.Atlas);
  {
    const s = saddleOffset();
    b.setBone(HB.barrel, HB.loin, 0.6);
    // Saddle cloth, then the four-horned saddle itself. The horns are the whole reason a
    // stirrupless rider could stay on through a charge.
    b.setMatrix(new THREE.Matrix4().makeTranslation(0, s.y - 0.3, s.z));
    b.box(0, 0.06, 0, 0.62, 0.42, 0.6, clothUv, 2);
    b.setMatrix(null);
    b.setMatrix(new THREE.Matrix4().makeTranslation(0, s.y - 0.05, s.z));
    b.box(0, 0, 0, 0.44, 0.11, 0.46, leatherUv);
    if (d.medium) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          b.box(sx * 0.17, 0.09, sz * 0.19, 0.075, 0.14, 0.07, leatherUv);
        }
      }
      // Girth.
      b.setMatrix(null);
      b.setBone(HB.barrel);
      b.sweep(
        [
          { p: [0, barrel[1] + 0.02, barrel[2] - 0.02], rx: 0.29, rz: 0.06 },
          { p: [0, barrel[1] - 0.36, barrel[2] - 0.02], rx: 0.29, rz: 0.06 },
        ],
        [0, 0, 1], 6, leatherUv
      );
    }
    b.setMatrix(null);

    if (d.medium) {
      // Bridle: a browband, a cheek strap and reins running back to the hands.
      b.setBone(HB.head);
      const hp = head;
      b.setMatrix(new THREE.Matrix4().makeTranslation(hp[0], hp[1], hp[2]));
      b.box(0, 0.0, 0.02, 0.17, 0.03, 0.14, leatherUv);
      b.box(0, -0.13, 0.08, 0.16, 0.026, 0.03, leatherUv);
      for (const sx of [-1, 1]) b.box(sx * 0.075, -0.08, 0.04, 0.022, 0.14, 0.026, leatherUv);
      b.box(0, -0.1, 0.09, 0.06, 0.03, 0.03, bronzeUv);
      b.setMatrix(null);
      // Reins as a slack line from the bit back to where the rider's hands are.
      b.setBone(HB.neck2, HB.head, 0.5);
      for (const sx of [-1, 1]) {
        b.sweep(
          [
            { p: [hp[0] + sx * 0.08, hp[1] - 0.1, hp[2] + 0.06], rx: 0.011, rz: 0.011 },
            { p: [neck2[0] + sx * 0.12, neck2[1] - 0.02, neck2[2]], rx: 0.011, rz: 0.011 },
            { p: [withers[0] + sx * 0.14, withers[1] + 0.16, withers[2] - 0.04], rx: 0.011, rz: 0.011 },
          ],
          UP, 4, leatherUv
        );
      }
    }
  }

  return b.toGeometry(`horse-lod${lod}`);
}
