import * as THREE from 'three';
import { box, column, pavedField, statue, type Batch } from '../build';
import type { Blocker, CityChunkSpec } from '../wall';
import { COTHON, MERCHANT_HARBOUR } from './layout';
import { PUN, tinted } from './palette';
import { SEA_LEVEL } from '../../maps/carthage/topography';
import { hash2 } from '../../util/rand';

/**
 * The harbours of Carthage — and what they are *for*.
 *
 * ## The decision: playable space, not backdrop
 *
 * This was the biggest open question in the workstream and `docs/CARTHAGE.md` §6.1 settles
 * it against the cautious answer: **"Yes, and the whole second half of the map is there."**
 * Appian is explicit — the Romans took the quay, then unexpectedly got onto the ring of the
 * circular harbour, and from there Scipio seized the forum. The harbours are not scenery;
 * they are the route to the Byrsa, and in the 146 BC moment the map is set at, the Romans
 * already hold the quay. So:
 *
 * - **Every quay is open ground.** The cothon's 20 m ring, the merchant basin's 15 m west and
 *   north and 25 m east belts, Scipio's mole and the causeway are all walkable, in the nav
 *   grid, and reached by `via-portus` and `via-navalis`.
 * - **The water is solid.** Both basins, both channels and the cut are stamped as obstacles.
 *   Nobody swims, and no pathfinder routes a cohort across a naval harbour.
 * - **The island is reachable, by one 4 m timber causeway.** §6.4 flags this loudly: there is
 *   no archaeological evidence for a causeway and the ancient accounts imply boats. It is
 *   built because a 4 m bridge onto a defended island is the best chokepoint on the map and
 *   the alternative is that the island is pointless in a land battle.
 * - **The ship sheds are built and they are nearly free.** 168 of them (§6.3: 30 on the
 *   island, 138 on the ring, against Appian's 220 — archaeology gives 160-170). Merged into
 *   the harbour's chunk they are geometry, not draw calls, and the 1 km ring of Ionic columns
 *   round a circular lagoon is a colonnade a fight can happen in, which is a kind of space
 *   this project does not otherwise have.
 * - **The water surface is a stand-in.** A dark plane at `waterY`, published so the terrain
 *   workstream can drop a real reflective surface at exactly that height. Two triangles.
 *
 * ## The 147-146 siege works, which are why the year is 146
 *
 * §6.4. Scipio's mole across the harbour mouth (attacker asset: it carries men and light
 * engines to the harbour front dry-shod), the Carthaginians' answering channel cut straight
 * out to the open sea (defender asset *and* a 30 m gap in their own defences), and the Roman
 * quay-fort, which is a monument and lives in `monuments.ts`. All three are on the ground in
 * spring 146 and none of them exists on a 149 BC map.
 */

const M4 = new THREE.Matrix4();

/**
 * **The water in both basins is the Mediterranean, so it stands at the Mediterranean's level.**
 *
 * This used to be `heightAt(basin centre) - FREEBOARD`, computed separately per basin, so the
 * two had two different water levels and neither was the sea's. Measured: the cothon's ground
 * sample is +0.34, putting its water at **−1.46**; the merchant basin's is +1.76, putting its
 * water at **−0.04**; and the gulf both join through 21 m channels is at **0**. Painted as
 * splat that is a shade of brown. Rendered as three surfaces it is three water levels inside
 * 400 m, one of them a metre and a half down a hole.
 *
 * A basin open to the sea cannot carry its own datum. It takes the sea's, and the freeboard
 * is then whatever the ground supplies rather than an input — which is the honest direction
 * of causation, and `assertions.ts` measures the result rather than assuming it.
 *
 * Exported because the map's `WaterProfile` renders a surface in each basin and it has to
 * land on this plane. A copy of the number in `src/maps/` is a copy that can drift; an import
 * cannot.
 */
export const BASIN_WATER_Y = SEA_LEVEL;
/**
 * What a quay ought to stand above its water, §6.2 [GAME].
 *
 * No longer derives anything — see `BASIN_WATER_Y` — and is kept as the figure the built
 * result is measured against, because "the cothon's quay clears its water by 0.34 m against a
 * 1.8 m target" is a finding about the ground under the harbour, and a constant deleted for
 * being unused is a finding thrown away.
 */
export const FREEBOARD = 1.8;
/** §6.2: 2.5-3.0 m of water in both basins. Exported for the same reason as `BASIN_WATER_Y`. */
export const BASIN_DEPTH = 2.8;
/** §6.3 [ARCH]: slipway width. */
const SHED_BAY = 5.9;
/** §6.3 [GAME]: a quinquereme is 35-40 m. */
const SHED_DEPTH = 40;
/** §6.3 [GAME]: ridge height. */
const SHED_RIDGE = 8.5;
/** §6.2 [ARCH]: 30 slipways on the island, 138 on the ring. */
const ISLAND_SHEDS = 30;
const RING_SHEDS = 138;

export interface HarbourOutput {
  chunks: CityChunkSpec[];
  footprints: { x: number; z: number; hw: number; hd: number; rot: number }[];
  /** Water and the channels, as thick lines. Circles are not in the raster's vocabulary. */
  occSegments: Blocker[];
  waterY: number;
  shedCount: number;
}

function annulus(
  st: ReturnType<Batch['s']>, r0: number, r1: number, y: number, n: number,
  col: THREE.Color, salt: number
): void {
  const up = new THREE.Vector3(0, 1, 0);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const t0 = (i / n) * Math.PI * 2;
    const t1 = ((i + 1) / n) * Math.PI * 2;
    a.set(Math.cos(t0) * r0, y, Math.sin(t0) * r0);
    b.set(Math.cos(t1) * r0, y, Math.sin(t1) * r0);
    c.set(Math.cos(t1) * r1, y, Math.sin(t1) * r1);
    d.set(Math.cos(t0) * r1, y, Math.sin(t0) * r1);
    st.quadN(up, a, b, c, d, tinted(col, hash2(i, salt, 0xf1), 0.11));
  }
}

function basinWall(
  st: ReturnType<Batch['s']>, r: number, y0: number, y1: number, n: number,
  inward: boolean, col: THREE.Color
): void {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const low = col.clone().multiplyScalar(0.72);
  for (let i = 0; i < n; i++) {
    const t0 = (i / n) * Math.PI * 2;
    const t1 = ((i + 1) / n) * Math.PI * 2;
    a.set(Math.cos(t0) * r, y0, Math.sin(t0) * r);
    b.set(Math.cos(t1) * r, y0, Math.sin(t1) * r);
    c.set(Math.cos(t1) * r, y1, Math.sin(t1) * r);
    d.set(Math.cos(t0) * r, y1, Math.sin(t0) * r);
    const s = inward ? -1 : 1;
    nrm.set(Math.cos((t0 + t1) * 0.5) * s, 0, Math.sin((t0 + t1) * 0.5) * s);
    if (inward) st.quadN(nrm, b, a, d, c, low, low, col, col);
    else st.quadN(nrm, a, b, c, d, low, low, col, col);
  }
}

const SHED_KEYS = ['stone', 'roof', 'timber', 'concrete'] as const;

/**
 * One range of ship sheds along a circular arc, facing the water.
 *
 * Modelled as the mouth and the slip, not the whole boat house: two piers, a lintel, the
 * rammed-earth slipway at its 1:10 gradient, and the roof running back. That is what reads
 * from the water, and it is four boxes per bay.
 *
 * **`concrete` is in the push list.** The first revision left it out, so every slipway in the
 * harbour was emitted with no transform and landed at the world origin — 840 vertices in the
 * middle of the battlefield, which `assertNoStrayGeometry` caught and which is exactly the
 * `Batch.distinct` aliasing trap the build library warns about, arriving by the other door.
 */
function shedRange(
  b: Batch, r: number, facing: 1 | -1, count: number, y: number, detail: number
): void {
  const st = b.s('stone');
  const roofSt = b.s('roof');
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const px = Math.cos(a) * r;
    const pz = Math.sin(a) * r;
    const rot = -a + (facing > 0 ? 0 : Math.PI);
    const sub = b.pushAll(SHED_KEYS, M4.makeRotationY(rot).setPosition(px, y, pz));
    const hw = SHED_BAY * 0.5 - 0.4;
    const tint = tinted(PUN.sandstone, hash2(i, facing, 0x33), 0.13);
    box(st, -hw - 0.5, 0, 0, -hw + 0.5, SHED_RIDGE, SHED_DEPTH, tint, { bottom: false, groundShade: 0.15 });
    box(st, hw - 0.5, 0, 0, hw + 0.5, SHED_RIDGE, SHED_DEPTH, tint, { bottom: false, groundShade: 0.15 });
    box(st, -hw - 0.7, SHED_RIDGE, -0.2, hw + 0.7, SHED_RIDGE + 1.2, 1.6,
      tinted(tint, 0.8, 0.08), { bottom: false });
    // The slipway: rammed earth at 1:10, running back and down under the shed. The reason
    // the building exists, and the only part of it a camera above the quay can see.
    box(b.s('concrete'), -hw, -0.2, 1.6, hw, SHED_DEPTH * 0.1, SHED_DEPTH, PUN.earth, { bottom: false });
    box(roofSt, -hw - 0.9, SHED_RIDGE + 1.2, 1.6, hw + 0.9, SHED_RIDGE + 2.4, SHED_DEPTH,
      tinted(PUN.tileWorn, hash2(i, 7, 0x34), 0.1), { bottom: false });
    if (detail >= 2) {
      // §6.3 [A]: two Ionic columns in front of every shed, reading as a continuous portico
      // round the harbour and round the island.
      column(st, -hw, SHED_RIDGE, 0.8, 0.42, 1.4, 'ionic', PUN.sandstonePale, 0);
      column(st, hw, SHED_RIDGE, 0.8, 0.42, 1.4, 'ionic', PUN.sandstonePale, 0);
      box(b.s('timber'), -hw - 1.0, SHED_RIDGE + 1.0, 1.6, hw + 1.0, SHED_RIDGE + 1.25,
        SHED_DEPTH, PUN.timber, { bottom: false });
    }
    b.popAll(sub);
  }
}

const COTHON_KEYS = ['stone', 'road', 'roof', 'timber', 'concrete', 'stucco', 'metal'] as const;
const MH_KEYS = ['stone', 'road', 'concrete', 'timber', 'metal'] as const;

export function buildHarbours(heightAt: (x: number, z: number) => number): HarbourOutput {
  const quayY = heightAt(COTHON.x, COTHON.z);
  const waterY = BASIN_WATER_Y;
  const floorY = waterY - BASIN_DEPTH;
  // Sheds are 40 m deep and the annular water is 100 m, so 80 of it is shed and 20 is water.
  // That is §6.2's own arithmetic, and it is the check that the whole table hangs together.
  const ringR = COTHON.outerR - SHED_DEPTH;
  const shedCount = ISLAND_SHEDS + RING_SHEDS;

  const chunks: CityChunkSpec[] = [];

  chunks.push({
    name: 'harbour-cothon',
    cx: COTHON.x,
    cz: COTHON.z,
    radius: COTHON.outerR + 22,
    castShadow: true,
    // Radius 185 → 102 m of surface correction, against a 300 m near switch. It fires.
    lodSwitch: [300, 1100],
    farMaterial: 'stone',
    build: (b, detail) => {
      b.setUvOrigin(COTHON.x, 0, COTHON.z);
      const streams = b.pushAll(COTHON_KEYS, M4.makeTranslation(COTHON.x, 0, COTHON.z));
      const seg = detail >= 2 ? 64 : 32;

      // Ring quay, 20 m of paving. Playable ground — this is the ring Appian's Romans got
      // onto and fought along.
      annulus(b.s('road'), COTHON.outerR, COTHON.outerR + 20, quayY + 0.1, seg, PUN.paving, 1);
      basinWall(b.s('stone'), COTHON.outerR, floorY, quayY, seg, true, PUN.ashlar);
      annulus(b.s('concrete'), COTHON.islandR, COTHON.outerR, floorY, seg, PUN.sandstoneDark, 2);
      annulus(b.s('road'), COTHON.islandR, COTHON.outerR, waterY, seg, PUN.basin, 3);

      // The admiralty island: an artificial raised platform, 125 m across.
      basinWall(b.s('stone'), COTHON.islandR, floorY, quayY + 1.6, seg, false, PUN.ashlar);
      annulus(b.s('road'), 0, COTHON.islandR, quayY + 1.6, seg, PUN.paving, 4);

      shedRange(b, COTHON.islandR + 1.5, 1, ISLAND_SHEDS, quayY + 1.6, detail);
      shedRange(b, ringR, -1, RING_SHEDS, quayY, detail);

      // §6.4 [GAME]: the causeway, on the north (+x) side. 4 m of timber deck on piles.
      {
        const cw = COTHON.causewayWidth * 0.5;
        box(b.s('timber'), COTHON.islandR - 2, quayY + 1.2, -cw, COTHON.outerR + 2, quayY + 1.6, cw,
          PUN.timber, { bottom: true });
        for (let i = 0; i < 7; i++) {
          const px = COTHON.islandR + ((COTHON.outerR - COTHON.islandR) * i) / 6;
          box(b.s('timber'), px - 0.3, floorY, -cw + 0.2, px + 0.3, quayY + 1.2, -cw + 0.8,
            PUN.timberDark, { bottom: false });
          box(b.s('timber'), px - 0.3, floorY, cw - 0.8, px + 0.3, quayY + 1.2, cw - 0.2,
            PUN.timberDark, { bottom: false });
        }
      }

      if (detail >= 1) {
        // The admiral's house, raised so he could see over the city wall and out to sea. [A]
        const ty = quayY + 1.6;
        box(b.s('stucco'), -15, ty, -15, 15, ty + 8, 15, PUN.render, { bottom: false });
        box(b.s('stone'), -9.5, ty + 8, -9.5, 9.5, ty + 19, 9.5, tinted(PUN.ashlar, 0.7, 0.06),
          { bottom: false, batter: 0.012 });
        box(b.s('roof'), -10.5, ty + 19, -10.5, 10.5, ty + 20.4, 10.5, PUN.tile, { bottom: false });
        if (detail >= 2) statue(b.s('metal'), 0, ty + 20.4, 0, 4, PUN.bronze, 0);
      }
      b.popAll(streams);
    },
  });

  // ---- the merchant harbour ------------------------------------------------
  const mh = MERCHANT_HARBOUR;
  const mQuayY = heightAt(mh.x, mh.z);
  // Same sea, so the same surface. The 1.42 m of ground between the two basins' centres is a
  // difference in freeboard, not a difference in water level.
  const mWaterY = BASIN_WATER_Y;
  const mFloorY = mWaterY - BASIN_DEPTH;
  chunks.push({
    name: 'harbour-merchant',
    cx: mh.x,
    cz: mh.z,
    radius: Math.hypot(mh.hw + mh.quayWest, mh.hd + mh.quayEast) + 20,
    castShadow: true,
    lodSwitch: [300, 1100],
    farMaterial: 'stone',
    build: (b, detail) => {
      b.setUvOrigin(mh.x, 0, mh.z);
      const streams = b.pushAll(MH_KEYS, M4.makeTranslation(mh.x, 0, mh.z));
      const st = b.s('stone');
      // §6.2 [ARCH]: 15 m of quay west and north, 25 m east against the city.
      const qw = mh.quayWest;
      const qe = mh.quayEast;
      for (const [x0, z0, x1, z1] of [
        [-mh.hw - qw, -mh.hd - qw, mh.hw + qw, -mh.hd],
        [-mh.hw - qw, mh.hd, mh.hw + qw, mh.hd + qe],
        [-mh.hw - qw, -mh.hd, -mh.hw, mh.hd],
        [mh.hw, -mh.hd, mh.hw + qw, mh.hd],
      ] as [number, number, number, number][]) {
        const sub = b.pushAllTranslate(['road'], (x0 + x1) * 0.5, 0, (z0 + z1) * 0.5);
        pavedField(b.s('road'), (x1 - x0) * 0.5, (z1 - z0) * 0.5, mQuayY + 0.1, 4.5,
          PUN.paving, 0x51, 0.12);
        b.popAll(sub);
      }
      box(st, -mh.hw, mFloorY, -mh.hd, mh.hw, mQuayY, mh.hd, PUN.ashlar, { top: false, bottom: false });
      box(b.s('concrete'), -mh.hw, mFloorY - 0.2, -mh.hd, mh.hw, mFloorY, mh.hd,
        PUN.sandstoneDark, { bottom: false });
      box(b.s('road'), -mh.hw, mWaterY - 0.1, -mh.hd, mh.hw, mWaterY, mh.hd, PUN.basin, { bottom: false });

      if (detail >= 1) {
        // §6.2/§6.4: the sea entrance, 21 m (Appian's 70 ft), closable with iron chains. The
        // sea is +z, so the moles reach out that way.
        const half = mh.entranceWidth * 0.5;
        for (const s of [-1, 1]) {
          box(st, s * half, mFloorY, mh.hd + qe, s * (mh.hw + qw), mQuayY + 1.2, mh.hd + qe + 34,
            tinted(PUN.ashlar, 0.5, 0.07), { bottom: false, batter: 0.02 });
        }
        box(b.s('metal'), -half, mQuayY + 2.2, mh.hd + qe + 30, half, mQuayY + 2.7,
          mh.hd + qe + 31, PUN.bronze, { bottom: false });
        // §6.4: Scipio's mole across the harbour mouth. 25 m at the base, 12 at the top, 3 m
        // above the water — an attacker asset that carries men and light engines dry-shod.
        box(st, -mh.hw - qw - 60, mWaterY, mh.hd + qe + 26, half - 2, mWaterY + 3,
          mh.hd + qe + 38, tinted(PUN.sandstoneDark, 0.4, 0.1), { bottom: false, batter: 0.06 });
      }
      if (detail >= 2) {
        for (let i = -7; i <= 7; i++) {
          box(st, i * 20 - 0.5, mQuayY + 0.1, -mh.hd - 3, i * 20 + 0.5, mQuayY + 0.9, -mh.hd - 2,
            PUN.sandstoneDark, { bottom: false });
        }
      }
      b.popAll(streams);
    },
  });

  // ---- solids --------------------------------------------------------------
  const footprints: { x: number; z: number; hw: number; hd: number; rot: number }[] = [
    // The island's built core. Not its whole disc: the outer ring of it is quay and sheds a
    // landing party fights along, and the causeway lands on it.
    { x: COTHON.x, z: COTHON.z, hw: 16, hd: 16, rot: 0 },
    // The two moles either side of the sea entrance.
    { x: mh.x - (mh.hw + mh.quayWest + mh.entranceWidth * 0.5) * 0.5, z: mh.z + mh.hd + mh.quayEast + 17,
      hw: (mh.hw + mh.quayWest - mh.entranceWidth * 0.5) * 0.5, hd: 17, rot: 0 },
    { x: mh.x + (mh.hw + mh.quayWest + mh.entranceWidth * 0.5) * 0.5, z: mh.z + mh.hd + mh.quayEast + 17,
      hw: (mh.hw + mh.quayWest - mh.entranceWidth * 0.5) * 0.5, hd: 17, rot: 0 },
    // The merchant basin: water, and a rectangle, so it goes in as one.
    { x: mh.x, z: mh.z, hw: mh.hw, hd: mh.hd, rot: 0 },
  ];

  /**
   * The circular basin as chords, and the two channels.
   *
   * The occupancy raster takes rectangles and thick segments, not discs, so the annulus of
   * water between the island's sheds and the ring's is stamped as 28 chords. Under-claiming
   * at the edges is the safe direction: a spare cell of open ground at the water's edge is a
   * man standing on a quay, while an over-claim would close the ring the harbour road runs
   * onto — which is the one piece of ground Appian's account turns on.
   */
  const occSegments: Blocker[] = [];
  {
    const n = 28;
    const inner = COTHON.islandR + SHED_DEPTH;
    const outer = COTHON.outerR - SHED_DEPTH;
    const rMid = (inner + outer) * 0.5;
    const halfW = Math.max(2, (outer - inner) * 0.5 - 0.5);
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 0.999) / n) * Math.PI * 2;
      occSegments.push({
        x1: COTHON.x + Math.cos(a0) * rMid, z1: COTHON.z + Math.sin(a0) * rMid,
        x2: COTHON.x + Math.cos(a1) * rMid, z2: COTHON.z + Math.sin(a1) * rMid,
        halfW,
      });
    }
    // §6.4: the controlled channel from the merchant basin into the naval yard, behind a
    // double wall with a gate, so merchants could not see into it. 21 m, and water.
    occSegments.push({
      x1: COTHON.x + COTHON.outerR + 8, z1: COTHON.z,
      x2: mh.x - mh.hw - 6, z2: mh.z,
      halfW: 10.5,
    });
    // §6.4: the Carthaginians' cut channel to the open sea, 30 m, freshly dug and
    // unrevetted. A defender's escape *and* a 30 m gap in their own defences.
    occSegments.push({
      x1: COTHON.x, z1: COTHON.z + COTHON.outerR + 6,
      x2: COTHON.x + 60, z2: 1340,
      halfW: 15,
    });
  }

  return { chunks, footprints, occSegments, waterY, shedCount };
}
