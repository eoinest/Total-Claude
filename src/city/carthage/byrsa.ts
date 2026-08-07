import * as THREE from 'three';
import { box, column, crenellation, pavedField, statue, steps, type Batch } from '../build';
import type { CityChunkSpec, TreeRequest } from '../wall';
import { BYRSA, BYRSA_GATE } from './layout';
import { PUN, tinted } from './palette';
import { clamp } from '../../util/math';
import { hash2 } from '../../util/rand';

/**
 * The Byrsa: Carthage's citadel, and the last thing to fall.
 *
 * Appian: the temple of Eshmun stood "in a place of great height and rocky nature", reached
 * in peacetime by an ascent of sixty steps; fifty thousand people surrendered out of the
 * enclosure after the six-day fight up the three streets; and nine hundred Roman deserters
 * held the temple and burned it over themselves on the seventh day.
 *
 * ## The relief, and who owns it
 *
 * `docs/CARTHAGE.md` §5.1a: the hill is **45 m above the lower town** and that 45 is *not*
 * compressed, while its footprint is. Run the real 700 × 550 m hill through the projection
 * and you get a 30° cliff on which the three streets are unbuildable, so the spec overrides
 * the world footprint to 340 × 200 and takes the gradient from that. This file implements
 * the override.
 *
 * **`byrsaReliefAt` is the contract.** It returns metres of hill to add to the terrain at any
 * point, and the streets, the terraced housing and the citadel all read it, so nothing can
 * end up at a different height from the ground it stands on. When the map workstream's
 * heightfield carries the real hill, this becomes a `Math.max` against what the terrain
 * already supplies and the fabric does not change at all — which is why it is a function and
 * not a set of baked Y values.
 */

const M4 = new THREE.Matrix4();

/** Revetted terraces between the citadel's toe and the summit plateau. */
const TERRACES = 3;

/**
 * Metres of hill above the surrounding ground at a point.
 *
 * A superellipse in the hill's own frame: flat at the summit, falling to zero at the 20 m
 * contour. Exponent 3 rather than 2 keeps the flanks straight through most of their run and
 * rounds only the last of it, which is what a worked hill looks like and what a terrace
 * needs — a paraboloid puts every terrace on a different gradient.
 */
export function byrsaReliefAt(x: number, z: number): number {
  const u = Math.abs(x - BYRSA.x) / BYRSA.baseHw;
  const v = Math.abs(z - BYRSA.z) / BYRSA.baseHd;
  const r = Math.pow(Math.pow(u, 3) + Math.pow(v, 3), 1 / 3);
  if (r >= 1) return 0;
  const rSummit = BYRSA.summitHw / BYRSA.baseHw;
  const t = clamp((1 - r) / (1 - rSummit), 0, 1);
  // Smoothstep only over the last tenth, so the slope is a slope and not an S-curve.
  const s = t > 0.9 ? 1 : t / 0.9;
  return BYRSA.relief * (s * s * (3 - 2 * s) * 0.25 + s * 0.75);
}

/** Absolute Y of the summit platform. Everything on the citadel is dimensioned off this. */
export function byrsaTopY(heightAt: (x: number, z: number) => number): number {
  return heightAt(BYRSA.x, BYRSA.z) + BYRSA.relief;
}

/** Half-extents of revetted terrace `i`, 0 the widest at the citadel's toe. */
function terraceHalf(i: number): { hw: number; hd: number } {
  const t = i / TERRACES;
  return {
    hw: BYRSA.citadelHw + (BYRSA.summitHw - BYRSA.citadelHw) * t,
    hd: BYRSA.citadelHd + (BYRSA.summitHd - BYRSA.citadelHd) * t,
  };
}

/** A battered ashlar retaining wall round one terrace, as a faceted ring. */
function revetmentRing(
  b: Batch, hw: number, hd: number, y0: number, y1: number, col: THREE.Color, detail: number
): void {
  const st = b.s('stone');
  const n = detail >= 2 ? 28 : 14;
  const a = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  const e = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const x0 = Math.cos(a0) * hw;
    const z0 = Math.sin(a0) * hd;
    const x1 = Math.cos(a1) * hw;
    const z1 = Math.sin(a1) * hd;
    const mx = (x0 + x1) * 0.5;
    const mz = (z0 + z1) * 0.5;
    const nl = Math.hypot(mx / (hw * hw), mz / (hd * hd)) || 1;
    const nx = mx / (hw * hw) / nl;
    const nz = mz / (hd * hd) / nl;
    // A Punic retaining wall leans back about 1 in 12, and the batter is what separates a
    // revetment from a curtain at any distance.
    const bat = (y1 - y0) / 12;
    const shade = tinted(col, hash2(i, Math.round(y0), 0xc1), 0.1);
    a.set(x0, y0, z0);
    c.set(x1, y0, z1);
    d.set(x1 - nx * bat, y1, z1 - nz * bat);
    e.set(x0 - nx * bat, y1, z0 - nz * bat);
    nrm.set(nx, 0.12, nz).normalize();
    st.quadN(nrm, a, c, d, e, tinted(shade, 0.15, 0.2), tinted(shade, 0.15, 0.2), shade, shade);
    if (detail >= 1) {
      // Coping: 0.55 m of overhanging cap. Metre-scale, so it survives the mip chain.
      const o = 0.4;
      const c0 = new THREE.Vector3(x0 - nx * bat + nx * o, y1, z0 - nz * bat + nz * o);
      const c1 = new THREE.Vector3(x1 - nx * bat + nx * o, y1, z1 - nz * bat + nz * o);
      const d0 = new THREE.Vector3(c0.x, y1 + 0.55, c0.z);
      const d1 = new THREE.Vector3(c1.x, y1 + 0.55, c1.z);
      st.quadN(nrm, c0, c1, d1, d0, shade, shade, tinted(shade, 0.8, 0.12), tinted(shade, 0.8, 0.12));
      st.quadN(new THREE.Vector3(0, 1, 0), d0, d1, d, e, tinted(shade, 0.85, 0.1));
    }
  }
}

/** Fill a terrace deck as a fan of paving. */
function terraceDeck(b: Batch, hw: number, hd: number, y: number, salt: number): void {
  const st = b.s('road');
  const up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Vector3(0, y, 0);
  for (let i = 0; i < 28; i++) {
    const a0 = (i / 28) * Math.PI * 2;
    const a1 = ((i + 1) / 28) * Math.PI * 2;
    st.triN(
      up, c,
      new THREE.Vector3(Math.cos(a0) * hw, y, Math.sin(a0) * hd),
      new THREE.Vector3(Math.cos(a1) * hw, y, Math.sin(a1) * hd),
      tinted(PUN.earth, hash2(i, salt, 0xd1), 0.12)
    );
  }
}

export interface ByrsaOutput {
  chunks: CityChunkSpec[];
  trees: TreeRequest[];
  footprints: { x: number; z: number; hw: number; hd: number; rot: number }[];
  summitY: number;
}

const KEYS = ['stone', 'stucco', 'road', 'roof', 'timber', 'metal', 'concrete'] as const;

export function buildByrsa(heightAt: (x: number, z: number) => number): ByrsaOutput {
  const toeY = heightAt(BYRSA.x, BYRSA.z);
  const summitY = toeY + BYRSA.relief;
  // Relief at the citadel's toe, so the lowest revetment starts where the housing slope ends.
  const citadelToeY = toeY + byrsaReliefAt(BYRSA.x + BYRSA.citadelHw, BYRSA.z);

  const chunks: CityChunkSpec[] = [
    {
      name: 'carthage-byrsa',
      cx: BYRSA.x,
      cz: BYRSA.z,
      radius: BYRSA.citadelHw + 16,
      castShadow: true,
      // The objective, looked at from the deployment line 1.1 km away, so it holds full
      // detail further out than the fabric does. Radius 120 → 66 m of surface correction.
      lodSwitch: [560, 1600],
      farMaterial: 'stone',
      build: (b, detail) => {
        b.setUvOrigin(BYRSA.x, 0, BYRSA.z);
        const streams = b.pushAll(KEYS, M4.makeTranslation(BYRSA.x, 0, BYRSA.z));
        const st = b.s('stone');

        // ---- the revetted platform ---------------------------------------
        for (let i = 0; i < TERRACES; i++) {
          const lo = terraceHalf(i);
          const hi = terraceHalf(i + 1);
          const y0 = citadelToeY + ((summitY - citadelToeY) * i) / TERRACES;
          const y1 = citadelToeY + ((summitY - citadelToeY) * (i + 1)) / TERRACES;
          revetmentRing(b, lo.hw, lo.hd, y0 - 1, y1, PUN.ashlar, detail);
          terraceDeck(b, hi.hw + 7, hi.hd + 7, y1, i);
        }

        // ---- the citadel enceinte ----------------------------------------
        // §5.2 [GAME]: 4.5 m high, 2.5 m thick, one gate on the side the three streets
        // arrive from. Deliberately modest — this is an inner keep, not a curtain, and a
        // second 16 m wall on top of the hill would make the isthmus wall look small.
        const eh = BYRSA.enceinteHeight;
        const et = BYRSA.enceinteThickness;
        const gw = 6;
        const corners: [number, number][] = [
          [-BYRSA.summitHw, -BYRSA.summitHd], [BYRSA.summitHw, -BYRSA.summitHd],
          [BYRSA.summitHw, BYRSA.summitHd], [-BYRSA.summitHw, BYRSA.summitHd],
        ];
        for (let i = 0; i < 4; i++) {
          const [ax, az] = corners[i];
          const [bx, bz] = corners[(i + 1) % 4];
          const x0 = Math.min(ax, bx) - (ax === bx ? et * 0.5 : 0);
          const x1 = Math.max(ax, bx) + (ax === bx ? et * 0.5 : 0);
          const z0 = Math.min(az, bz) - (az === bz ? et * 0.5 : 0);
          const z1 = Math.max(az, bz) + (az === bz ? et * 0.5 : 0);
          // Face 3 is the −x side, which is where the three streets arrive.
          if (i === 3) {
            box(st, x0, summitY, z0, x1, summitY + eh, -gw, PUN.ashlar, { bottom: false, batter: 0.02 });
            box(st, x0, summitY, gw, x1, summitY + eh, z1, PUN.ashlar, { bottom: false, batter: 0.02 });
            // Gate tower over the passage.
            box(st, x0 - 1.4, summitY + 3.4, -gw - 1.6, x1 + 1.4, summitY + eh + 3.6, gw + 1.6,
              tinted(PUN.ashlar, 0.6, 0.08), { bottom: false });
          } else {
            box(st, x0, summitY, z0, x1, summitY + eh, z1, PUN.ashlar, { bottom: false, batter: 0.02 });
          }
          if (detail >= 1) crenellation(st, ax, az, bx, bz, summitY + eh, 1.15, 0.75, PUN.sandstone);
        }
        for (const [cx, cz] of corners) {
          box(st, cx - 4.5, summitY - 0.5, cz - 4.5, cx + 4.5, summitY + eh + 3.2, cz + 4.5,
            tinted(PUN.ashlar, 0.4, 0.08), { bottom: false, batter: 0.015 });
        }
        pavedField(b.s('road'), BYRSA.summitHw - 2, BYRSA.summitHd - 2, summitY + 0.12, 5,
          PUN.paving, 0x2b, 0.13);

        // ---- the temple of Eshmun and the sixty steps --------------------
        // §5.2: Appian's sixty steps are verified and they are the last chokepoint on the
        // map — 9 m wide, no engines, no horses, 11.4 m of climb at a 0.19 m rise.
        const RISERS = 60;
        const RISE = 0.19;
        const podH = RISERS * RISE;
        const podHw = 20;
        const podHd = 26;
        const py = summitY + podH;
        box(st, -podHw, summitY, -podHd, podHw, py, podHd, tinted(PUN.ashlar, 0.75, 0.06),
          { bottom: false, batter: 0.02 });
        {
          // The flight climbs in −x, because the gate is on the −x face and the streets come
          // from the forum. `steps` runs toward −z, so the frame is turned a quarter turn.
          // `makeRotationY(+π/2)` sends local +Z to world +X, and `steps` marches toward
          // local −Z, so the flight ascends toward −x — up from the enceinte gate to the
          // temple, which is the direction the three streets arrive from.
          const sub = b.pushAll(['stone'], M4.makeRotationY(Math.PI * 0.5)
            .setPosition(-podHw - 0.2, summitY, 0));
          steps(st, 9, 0, 0, RISERS, RISE, 0.42, tinted(PUN.ashlar, 0.5, 0.06));
          b.popAll(sub);
          // Cheek walls, which are what make a stair read as architecture rather than as a
          // ramp with lines on it.
          for (const s of [-1, 1]) {
            box(st, -podHw - 25.5, summitY - 0.5, s * 4.5 - 0.6, -podHw, summitY + podH * 0.55,
              s * 4.5 + 0.6, tinted(PUN.ashlar, 0.35, 0.06), { bottom: false });
          }
        }
        // Cella and porch. A Punic temple takes a Levantine plan — a walled court with a
        // pillared front — not a Greek peripteros, so the columns are a porch of six.
        box(b.s('stucco'), -13, py, -19, 13, py + 10.5, 13, tinted(PUN.render, 0.7, 0.08),
          { bottom: false });
        box(b.s('roof'), -13.6, py + 10.5, -19.6, 13.6, py + 11.8, 13.6, PUN.tile, { bottom: false });
        if (detail >= 2) {
          for (let i = 0; i < 6; i++) {
            column(b.s('stone'), -11 + (i * 22) / 5, py, 18, 0.95, 9.5, 'ionic', PUN.sandstonePale, 1);
          }
          box(st, -14, py + 9.5, 12, 14, py + 11.2, 20, tinted(PUN.ashlar, 0.8, 0.05), { bottom: false });
          box(b.s('metal'), -3, py, 12.9, 3, py + 7, 13.1, PUN.bronze, { bottom: false });
          statue(b.s('metal'), 0, py + 11.8, 16, 3.4, PUN.bronze, Math.PI);
        }

        b.popAll(streams);
      },
    },
  ];

  // Cypresses on the upper terrace. The precinct was planted, and a vertical punctuation at
  // the summit is what tells the eye how tall the citadel is from 1.1 km away.
  const trees: TreeRequest[] = [];
  const t2 = terraceHalf(2);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + 0.3;
    trees.push({
      x: BYRSA.x + Math.cos(a) * (t2.hw - 6),
      z: BYRSA.z + Math.sin(a) * (t2.hd - 6),
      kind: 'cypress',
      scale: 0.9 + hash2(i, 3, 0xe1) * 0.35,
      y: citadelToeY + ((summitY - citadelToeY) * 2) / TERRACES,
    });
  }

  return {
    chunks,
    trees,
    /**
     * Solid to a man on the ground: the citadel platform and the summit block.
     *
     * The *hill* is not solid — its slope carries the Hannibalic quarter's terraced housing
     * and the three streets, all of which are walkable. Only the revetted platform is
     * masonry. Stamped as the platform's inscribed rectangle, which under-claims the corners
     * deliberately: an over-claim would close the ring road at the hill's foot.
     */
    footprints: [
      { x: BYRSA.x, z: BYRSA.z, hw: BYRSA.citadelHw * 0.86, hd: BYRSA.citadelHd * 0.86, rot: 0 },
    ],
    summitY,
  };
}

/** Where the ceremonial stair meets the enceinte, for the plan view and the way network. */
export const BYRSA_STAIR_HEAD = { x: BYRSA_GATE.x, z: BYRSA_GATE.z };
