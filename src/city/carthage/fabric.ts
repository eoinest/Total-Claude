import * as THREE from 'three';
import { box, gableRoof, type Batch } from '../build';
import type { Lane } from '../insulae';
import { KeepOut, type WayClass } from '../layout';
import type { CityChunkSpec, TreeRequest } from '../wall';
import {
  buildLineZAt, INSULA_DEPTH, INSULA_FACE, PLOT_FACE, PUNIC_WAY_WIDTH,
  QUARTERS, shoreZAt, STOREY_H, type Quarter,
} from './layout';
import { PUN, tinted } from './palette';
import { hash2, Rng } from '../../util/rand';
import { clamp } from '../../util/math';

/**
 * The housing of Carthage, authored on the Punic cubit.
 *
 * ## Build to the module, and there is nothing to resolve
 *
 * `docs/CARTHAGE.md` §7.3: the Byrsa quarter's excavation plan dimensions its blocks in
 * cubits — 30 deep by 60 along the street — subdivided into five plots of 12 × 30. A
 * generator that snaps to that module produces a Carthaginian street front **by
 * construction**. That is a categorically better foundation than placing buildings and then
 * resolving the overlaps: Rome's roads ran 73-91% through masonry because a resolver moved
 * things after the streets were drawn, and a grid that is right the first time has no
 * resolver to go wrong.
 *
 * So: `INSULA_FACE × INSULA_DEPTH` is the only block size in the city. A quarter chooses how
 * many bays of it to run together and how many storeys to put on it, and nothing else.
 *
 * ## What a Punic house is
 *
 * Not an insula. §7.1: an elongated rectangle with **entrances front and back onto two
 * streets**, a side corridor running the full depth between them, a small courtyard for
 * light with the **cistern mouth in its floor**, a cesspool, and a street-front room usable
 * as a shop. Walls are *opus africanum* — rubble and mud-brick between upright ashlar piers —
 * lime-rendered white or ochre. Roofs are **flat, with parapets**: Punic and North African,
 * not tiled and pitched like Rome's.
 *
 * **Flat roofs are a mechanic, not a look.** Appian's Romans crossed roof to roof on planks
 * and fought a second battle up there while the first went on in the street below. The gaps
 * between blocks on the three Byrsa streets are held at 4 m for exactly that reason.
 *
 * ## Why the geometry is metre-scale
 *
 * A 55 mm course cannot resolve at 90 m and 84% of a normal map's perturbation is gone by
 * mip 4. What reads at battle distance is geometry a metre across: the projecting pier of an
 * *opus africanum* wall, a roof parapet, a stair box, the shadow under a plot division.
 * Nothing below is authored under about 0.3 m.
 */

type Ground = (x: number, z: number) => number;

/** Ground-floor clear height. Taller than the upper storeys because it is a shop. */
const GROUND_H = 3.9;

export interface FabricOutput {
  chunks: CityChunkSpec[];
  trees: TreeRequest[];
  footprints: { x: number; z: number; hw: number; hd: number; rot: number }[];
  lanes: Lane[];
  blocksByQuarter: { id: string; placed: number; rejected: number; roofArea: number }[];
}

interface Block {
  x: number;
  z: number;
  rot: number;
  hw: number;
  hd: number;
  mask: number;
  storeys: number;
  kind: Quarter['kind'];
  h: number;
  /** Which side the principal street front is on, in the block's own +v. */
  front: 1 | -1;
  /** Bays of `INSULA_FACE` this block runs. 1 everywhere but the warehouse ranges. */
  bays: number;
}

/** Uniform grid of placed rectangles, so quarters do not grow through each other. */
class PlacedGrid {
  private static readonly CELL = 32;
  private cells = new Map<number, Block[]>();

  private static key(x: number, z: number): number {
    return ((Math.floor(x / PlacedGrid.CELL) + 4096) << 13) | (Math.floor(z / PlacedGrid.CELL) + 4096);
  }

  add(b: Block): void {
    const r = Math.hypot(b.hw, b.hd);
    for (let x = b.x - r; x <= b.x + r + PlacedGrid.CELL; x += PlacedGrid.CELL) {
      for (let z = b.z - r; z <= b.z + r + PlacedGrid.CELL; z += PlacedGrid.CELL) {
        const k = PlacedGrid.key(x, z);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        if (!list.includes(b)) list.push(b);
      }
    }
  }

  /**
   * Oriented-rectangle overlap, not a circumradius test.
   *
   * The first revision used circumradii and rejected 60% of the fabric, because two blocks
   * legitimately facing each other across a 7 m street are 22 m apart while their
   * circumradii sum to 34. A conservative approximation of a rectangle is how a city loses
   * its buildings — Rome's own generator has the same note against the same mistake.
   */
  hits(x: number, z: number, hw: number, hd: number, rot: number): boolean {
    const r = Math.hypot(hw, hd);
    for (let cx = x - r; cx <= x + r + PlacedGrid.CELL; cx += PlacedGrid.CELL) {
      for (let cz = z - r; cz <= z + r + PlacedGrid.CELL; cz += PlacedGrid.CELL) {
        const list = this.cells.get(PlacedGrid.key(cx, cz));
        if (!list) continue;
        for (const b of list) {
          if (obbHit(x, z, hw, hd, rot, b.x, b.z, b.hw, b.hd, b.rot)) return true;
        }
      }
    }
    return false;
  }
}

function obbHit(
  ax: number, az: number, ahw: number, ahd: number, arot: number,
  bx: number, bz: number, bhw: number, bhd: number, brot: number
): boolean {
  const axes: [number, number][] = [
    [Math.cos(arot), Math.sin(arot)], [-Math.sin(arot), Math.cos(arot)],
    [Math.cos(brot), Math.sin(brot)], [-Math.sin(brot), Math.cos(brot)],
  ];
  for (const [ux, uz] of axes) {
    const ra = Math.abs(ahw * (Math.cos(arot) * ux + Math.sin(arot) * uz))
      + Math.abs(ahd * (-Math.sin(arot) * ux + Math.cos(arot) * uz));
    const rb = Math.abs(bhw * (Math.cos(brot) * ux + Math.sin(brot) * uz))
      + Math.abs(bhd * (-Math.sin(brot) * ux + Math.cos(brot) * uz));
    if (Math.abs((bx - ax) * ux + (bz - az) * uz) >= ra + rb) return false;
  }
  return true;
}

/** Soft quarter boundary: a lobed superellipse, so no quarter ends at a right angle. */
function quarterMask(q: Quarter, u: number, v: number): number {
  const tu = Math.abs(u) / q.hw;
  const tv = Math.abs(v) / q.hd;
  const t = Math.pow(Math.pow(tu, 4) + Math.pow(tv, 4), 0.25);
  const seed = Rng.hashString(q.id) & 0xff;
  const ang = Math.atan2(v * q.hw, u * q.hd);
  const lobe = q.fray * (0.16 * Math.sin(ang * 3 + hash2(seed, 1, 0x51) * 6.283)
    + 0.09 * Math.sin(ang * 7 + hash2(seed, 2, 0x52) * 6.283));
  const outer = 1 + q.fray * 0.3 + lobe;
  const inner = outer - (0.1 + q.fray * 0.22);
  const s = clamp((outer - t) / Math.max(0.05, outer - inner), 0, 1);
  return s * s * (3 - 2 * s);
}

const frame = (q: Quarter): { x: (u: number, v: number) => number; z: (u: number, v: number) => number } => {
  const cs = Math.cos(q.rot);
  const sn = Math.sin(q.rot);
  return { x: (u, v) => q.x + u * cs - v * sn, z: (u, v) => q.z + u * sn + v * cs };
};

/**
 * Lay one quarter's grid on the cubit module.
 *
 * `u` runs along the block face (30.9 m per bay, with a 4 m lane between bays) and `v` runs
 * through the block depth (15.45 m, with a 7 m local street between rows). §7.3: the long
 * axis lies along the contour, so the face runs across the slope and the depth climbs it,
 * and each block steps down one terrace to the next.
 *
 * **A lane is only emitted where it has a block on it.** The first revision drew the whole
 * grid across the quarter's rectangle including its empty frayed margin, which put 75 ha of
 * carriageway into a 170 ha city and left streets running through open fields. A street with
 * no houses is not a street.
 */
function planQuarter(
  q: Quarter,
  rng: Rng,
  keepOut: KeepOut,
  placed: PlacedGrid
): { blocks: Block[]; lanes: Lane[]; rejected: number } {
  const blocks: Block[] = [];
  const lanes: Lane[] = [];
  let rejected = 0;
  const F = frame(q);
  const rot = q.rot + q.grid;

  const faceLen = q.blockFace ?? INSULA_FACE * q.bays;
  const depthLen = q.blockDepth ?? INSULA_DEPTH;
  const pitchU = faceLen + PUNIC_WAY_WIDTH.vicus;
  const pitchV = depthLen + PUNIC_WAY_WIDTH.local;
  const nU = Math.max(1, Math.floor((q.hw * 2) / pitchU));
  const nV = Math.max(1, Math.floor((q.hd * 2) / pitchV));

  /** Extent of placed blocks along each grid line, so a lane can be cut to its fabric. */
  const rowSpan = new Map<number, [number, number]>();
  const colSpan = new Map<number, [number, number]>();
  const span = (m: Map<number, [number, number]>, k: number, lo: number, hi: number): void => {
    const cur = m.get(k);
    if (!cur) m.set(k, [lo, hi]);
    else { cur[0] = Math.min(cur[0], lo); cur[1] = Math.max(cur[1], hi); }
  };

  for (let j = 0; j < nV; j++) {
    for (let i = 0; i < nU; i++) {
      const u = -q.hw + (i + 0.5) * pitchU;
      const v = -q.hd + (j + 0.5) * pitchV;
      const mask = quarterMask(q, u, v);
      if (mask < 0.05) continue;
      // Density thins the *fringe*, not the heart. `mask` is 1 across the quarter's plateau
      // and only falls through its rim, so a quarter at 0.9 is essentially solid in the
      // middle and ragged at the edge — which is what a Punic quarter looks like and is what
      // keeps the roof figure from being eaten by holes nobody asked for.
      if (rng.next() > q.density * (0.35 + 0.65 * mask) + 0.2) { rejected++; continue; }

      // The module never changes; only whether a block is there at all. Fringe blocks lose
      // a bay rather than shrinking, which keeps every façade on the same plot rhythm.
      const bays = mask < 0.35 && q.bays > 1 ? q.bays - 1 : q.bays;
      const hw = (q.blockFace ?? INSULA_FACE * bays) * 0.5;
      const hd = depthLen * 0.5;
      const wx = F.x(u, v);
      const wz = F.z(u, v);
      if (wz < buildLineZAt(wx) || wz > shoreZAt(wx) - 26) { rejected++; continue; }
      if (keepOut.blockedRect(wx, wz, hw + 1.2, hd + 1.2, rot)) { rejected++; continue; }
      if (placed.hits(wx, wz, hw + 1.0, hd + 1.0, rot)) { rejected++; continue; }
      const h = hash2(i, j, Rng.hashString(q.id) & 0xffff);
      const storeys = Math.max(1, Math.round(q.storeys * (0.78 + 0.3 * mask) + (h - 0.5) * 1.2));
      blocks.push({
        x: wx, z: wz, rot, hw, hd, mask, storeys, kind: q.kind, h, bays,
        front: (i + j) % 2 === 0 ? 1 : -1,
      });
      span(rowSpan, j, u - hw, u + hw);
      span(colSpan, i, v - hd, v + hd);
    }
  }

  // Local streets between rows of blocks, cut to the fabric they serve.
  for (let j = 0; j <= nV; j++) {
    const a = rowSpan.get(j - 1);
    const b = rowSpan.get(j);
    if (!a && !b) continue;
    const lo = Math.min(a ? a[0] : Infinity, b ? b[0] : Infinity) - 4;
    const hi = Math.max(a ? a[1] : -Infinity, b ? b[1] : -Infinity) + 4;
    const v = -q.hd + j * pitchV - PUNIC_WAY_WIDTH.local * 0.5;
    lanes.push({
      path: [{ x: F.x(lo, v), z: F.z(lo, v) }, { x: F.x(hi, v), z: F.z(hi, v) }],
      cls: 'local' as WayClass,
      width: PUNIC_WAY_WIDTH.local,
    });
  }
  // Lanes between bays.
  for (let i = 0; i <= nU; i++) {
    const a = colSpan.get(i - 1);
    const b = colSpan.get(i);
    if (!a && !b) continue;
    const lo = Math.min(a ? a[0] : Infinity, b ? b[0] : Infinity) - 3;
    const hi = Math.max(a ? a[1] : -Infinity, b ? b[1] : -Infinity) + 3;
    const u = -q.hw + i * pitchU - PUNIC_WAY_WIDTH.vicus * 0.5;
    lanes.push({
      path: [{ x: F.x(u, lo), z: F.z(u, lo) }, { x: F.x(u, hi), z: F.z(u, hi) }],
      cls: 'vicus' as WayClass,
      width: PUNIC_WAY_WIDTH.vicus,
    });
  }
  return { blocks, lanes, rejected };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const M4 = new THREE.Matrix4();

/**
 * Place a block's local frame.
 *
 * Plan rotation follows three.js: `makeRotationY(r)` sends local +X to world
 * `(cos r, −sin r)`. `CitySystem` negates the same angle for the occupancy raster, which
 * uses the opposite hand; the two are derived from one number and never re-derived.
 */
function place(b: Block, y: number): THREE.Matrix4 {
  return M4.makeRotationY(b.rot).setPosition(b.x, y, b.z);
}

/** Every material a fabric block may touch. See the aliasing note in `Batch.distinct`. */
const BLOCK_KEYS = ['stucco', 'stone', 'roof', 'timber', 'concrete'] as const;

/**
 * One insula: a party-walled terrace of five plots about a courtyard, flat-roofed.
 *
 * The plot subdivision is not decoration. Five 6.2 m plots across a 31 m face is what makes
 * the street read as a Punic street rather than as an extruded block: each plot carries its
 * own render tint, its own door, its own parapet height and its own storey count within one
 * of its neighbours. That is the whole façade grammar, and it comes free from the module.
 */
function insulaBlock(b: Batch, blk: Block, detail: number, groundY: number): void {
  const wall = b.s('stucco');
  const stone = b.s('stone');
  const streams = b.pushAll(BLOCK_KEYS, place(blk, groundY));

  const nPlots = Math.max(1, Math.round((blk.hw * 2) / PLOT_FACE));
  const plotW = (blk.hw * 2) / nPlots;
  // Courtyard: 3-5 m per house, §7.4's grain, punched out of the middle of the depth.
  const courtHd = Math.min(blk.hd * 0.34, 2.4);

  for (let p = 0; p < nPlots; p++) {
    const x0 = -blk.hw + p * plotW;
    const x1 = x0 + plotW;
    const hp = hash2(p, Math.round(blk.h * 255), 0x81);
    // Storeys vary by one about the block's own figure. A terrace whose parapet is level
    // for 31 m is a wall; a terrace that steps every 6 m is a street.
    const st = Math.max(1, blk.storeys + (hp > 0.72 ? 1 : hp < 0.22 ? -1 : 0));
    const top = GROUND_H + (st - 1) * STOREY_H;
    const body = tinted(hp > 0.78 ? PUN.limewash : hp > 0.3 ? PUN.render : PUN.renderWorn, hp, 0.16);

    // Socle: 1.0 m of dressed sandstone under every plot. The one horizontal break in the
    // mass, and the only course that reads from the street at any distance.
    box(stone, x0, -0.4, -blk.hd, x1, 1.0, blk.hd, tinted(PUN.sandstone, hp, 0.1),
      { bottom: false, groundShade: 0.2 });

    // The two ranges either side of the courtyard, so the block is not a solid extrusion.
    box(wall, x0, 0.9, -blk.hd, x1, top, -courtHd, body, { bottom: false });
    box(wall, x0, 0.9, courtHd, x1, top, blk.hd, body, { bottom: false });
    // The side corridor connecting the two street doors, roofed at one storey.
    box(wall, x0, 0.9, -courtHd, x0 + Math.min(1.6, plotW * 0.3), top * 0.42, courtHd,
      tinted(body, 0.4, 0.08), { bottom: false });

    // Flat roof terraces with parapets. §7.3 — and they are walkable ground in the fight
    // Appian describes, so the parapet is 0.9 m: chest-high cover, not a kerb.
    for (const [z0, z1] of [[-blk.hd, -courtHd], [courtHd, blk.hd]] as [number, number][]) {
      box(wall, x0, top, z0, x1, top + 0.12, z1, tinted(body, 0.7, 0.1), { bottom: false });
      box(stone, x0, top + 0.12, z0, x1, top + 0.9, z0 + 0.28, tinted(body, 0.85, 0.08), { bottom: false });
      box(stone, x0, top + 0.12, z1 - 0.28, x1, top + 0.9, z1, tinted(body, 0.85, 0.08), { bottom: false });
    }

    if (detail >= 2) {
      // *Opus africanum*: upright ashlar piers at the plot divisions and at mid-plot,
      // projecting 0.14 m. Metre-scale relief that survives the mip chain, and the single
      // most characteristic thing about a Punic wall.
      for (const px of [x0, x0 + plotW * 0.5, x1]) {
        for (const zf of [-blk.hd, blk.hd] as const) {
          box(stone, px - 0.24, 0.9, zf - (zf < 0 ? 0.14 : 0), px + 0.24, top - 0.2,
            zf + (zf < 0 ? 0 : 0.14), tinted(PUN.sandstone, hp, 0.08),
            { bottom: false, zMin: zf > 0, zMax: zf < 0 });
        }
      }
      // Street doors front and back — §7.1's defining feature, an entrance on two streets.
      for (const zf of [-blk.hd, blk.hd] as const) {
        box(b.s('timber'), x0 + plotW * 0.55 - 0.6, 0.9, zf - Math.sign(zf) * 0.26,
          x0 + plotW * 0.55 + 0.6, 3.1, zf + Math.sign(zf) * 0.02,
          PUN.timberDark, { bottom: false });
      }
      // The cistern mouth in the courtyard floor. Every excavated house has one.
      if (p === Math.floor(nPlots / 2)) {
        box(b.s('concrete'), -1.1, 0.05, -courtHd + 0.4, 1.1, 0.16, courtHd - 0.4,
          PUN.signinum, { bottom: false });
        box(stone, -0.55, 0.16, -0.55, 0.55, 0.62, 0.55, PUN.sandstoneDark, { bottom: false });
      }
      // A roof stair box, which is how a man gets onto the roof Appian's Romans fought on.
      if (hp > 0.62) {
        box(wall, x0 + plotW * 0.2, top + 0.12, courtHd, x0 + plotW * 0.2 + 1.7, top + 2.5,
          courtHd + 1.9, tinted(body, 0.6, 0.06), { bottom: false });
      }
    }
  }
  b.popAll(streams);
}

/**
 * A Megara plot: a dry-stone enclosure, an irrigation ditch, a farm range and planting.
 *
 * §7.7: enclosures 1.2-1.8 m on a 40-70 m grid, channels 1.5-2.5 m wide, ~8% building
 * coverage. Deliberately cheap — four boxes and a tree list against an insula's forty — and
 * that matters, because the Megara is a third of the walled area and it is supposed to read
 * as *open*.
 */
function gardenPlot(b: Batch, blk: Block, detail: number, groundY: number): void {
  const wall = b.s('stucco');
  const stone = b.s('stone');
  const streams = b.pushAll(BLOCK_KEYS, place(blk, groundY));
  const wallCol = tinted(PUN.sandstoneDark, hash2(Math.round(blk.x), Math.round(blk.z), 0xa1), 0.16);
  const t = 0.45;
  const h = 1.2 + blk.h * 0.6;

  for (const [x0, z0, x1, z1] of [
    [-blk.hw, -blk.hd, blk.hw, -blk.hd + t],
    [-blk.hw, blk.hd - t, blk.hw, blk.hd],
    [-blk.hw, -blk.hd, -blk.hw + t, blk.hd],
    [blk.hw - t, -blk.hd, blk.hw, blk.hd],
  ] as [number, number, number, number][]) {
    box(stone, x0, -0.3, z0, x1, h, z1, wallCol, { bottom: false, groundShade: 0.22 });
  }
  // A gateway gap, so the plot is not a sealed box in silhouette.
  box(stone, -1.7, -0.3, blk.front * (blk.hd - t), 1.7, 0.35, blk.front * blk.hd,
    tinted(wallCol, 0.3, 0.1), { bottom: false });
  // The irrigation channel along one side: 2 m wide, 1 m deep, and it breaks a formation.
  box(b.s('concrete'), -blk.hw, -1.0, -blk.hd - 1.4, blk.hw, -0.15, -blk.hd + 0.6,
    PUN.earth, { bottom: false, top: true });

  if (blk.mask > 0.35 || detail >= 2) {
    const fw = Math.min(blk.hw * 0.5, 6.5);
    const fd = Math.min(blk.hd * 0.4, 4.5);
    const fx = (blk.h - 0.5) * (blk.hw - fw) * 1.3;
    const fz = -blk.front * (blk.hd - fd - 2);
    box(wall, fx - fw, 0, fz - fd, fx + fw, 3.3, fz + fd, tinted(PUN.render, blk.h, 0.16),
      { bottom: false, groundShade: 0.14 });
    const rs = b.s('roof');
    const sub = b.pushAllTranslate(['roof'], fx, 3.3, fz);
    gableRoof(rs, rs, fw * 2, fd * 2, 0, 1.2, 0.4, tinted(PUN.tileWorn, blk.h, 0.12), fw >= fd);
    b.popAll(sub);
  }
  b.popAll(streams);
}

/** Olive, fig and cypress in one Megara plot. Emitted at plan time — see `buildFabric`. */
function plotTrees(blk: Block, out: TreeRequest[]): void {
  const n = blk.mask > 0.45 ? 5 : 3;
  for (let i = 0; i < n; i++) {
    const hx = hash2(i, Math.round(blk.h * 255), 0xb1);
    const hz = hash2(i, Math.round(blk.h * 255), 0xb2);
    out.push({
      x: blk.x + (hx - 0.5) * blk.hw * 1.6,
      z: blk.z + (hz - 0.5) * blk.hd * 1.6,
      kind: hx > 0.7 ? 'cypress' : 'umbrella',
      scale: 0.55 + hz * 0.4,
    });
  }
}

/** A harbourside warehouse range: a long store, flat-roofed, with loading bays on the quay. */
function warehouseBlock(b: Batch, blk: Block, detail: number, groundY: number): void {
  const wall = b.s('stucco');
  const stone = b.s('stone');
  const streams = b.pushAll(BLOCK_KEYS, place(blk, groundY));
  const h = 5.0 + blk.h * 2.2;
  const col = tinted(PUN.renderWorn, blk.h, 0.14);
  box(stone, -blk.hw, -0.4, -blk.hd, blk.hw, 1.1, blk.hd, PUN.sandstone, { bottom: false, groundShade: 0.2 });
  box(wall, -blk.hw, 1.1, -blk.hd, blk.hw, h, blk.hd, col, { bottom: false });
  box(wall, -blk.hw, h, -blk.hd, blk.hw, h + 0.14, blk.hd, tinted(col, 0.75, 0.08), { bottom: false });
  box(stone, -blk.hw, h + 0.14, -blk.hd, blk.hw, h + 0.85, -blk.hd + 0.3, tinted(col, 0.9, 0.06), { bottom: false });
  box(stone, -blk.hw, h + 0.14, blk.hd - 0.3, blk.hw, h + 0.85, blk.hd, tinted(col, 0.9, 0.06), { bottom: false });
  if (detail >= 2) {
    const n = Math.max(2, Math.round(blk.hw / 5));
    for (let i = 0; i < n; i++) {
      const px = -blk.hw + ((i + 0.5) * blk.hw * 2) / n;
      box(b.s('timber'), px - 1.4, 1.1, blk.front * blk.hd - 0.36, px + 1.4, 4.2,
        blk.front * blk.hd + 0.06, PUN.timberDark, { bottom: false });
      box(stone, px - 1.9, 1.1, blk.front * (blk.hd + 0.1), px - 1.55, h - 0.3,
        blk.front * (blk.hd + 0.24), PUN.sandstone, { bottom: false });
    }
  }
  b.popAll(streams);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Chunking, and why the chunks are small.
 *
 * Rome's LOD switch distances were silently never firing: `preRender` measures distance to a
 * chunk's *surface* as `centre distance − radius × 0.55`, and Rome's district chunks are
 * 400-700 m across, so the subtraction alone exceeded the switch distance and every chunk
 * stayed at full detail from every camera. Carthage caps a chunk at `MAX_CHUNK_R`, so the
 * surface correction is at most 77 m against a near switch at 300 m. The cost is more chunks
 * — and a chunk is not a draw call; a *material within a chunk* is, and the full level
 * carries five.
 */
const MAX_CHUNK_R = 140;

export function buildFabric(heightAt: Ground, keepOut: KeepOut, seed: string): FabricOutput {
  const rng = new Rng(seed);
  const trees: TreeRequest[] = [];
  const footprints: { x: number; z: number; hw: number; hd: number; rot: number }[] = [];
  const lanes: Lane[] = [];
  const chunks: CityChunkSpec[] = [];
  const blocksByQuarter: FabricOutput['blocksByQuarter'] = [];
  const placed = new PlacedGrid();

  for (const q of QUARTERS) {
    const out = planQuarter(q, rng.fork(q.id), keepOut, placed);
    for (const b of out.blocks) placed.add(b);
    for (const l of out.lanes) lanes.push(l);
    let roofArea = 0;
    for (const b of out.blocks) {
      footprints.push({ x: b.x, z: b.z, hw: b.hw, hd: b.hd, rot: b.rot });
      roofArea += b.hw * b.hd * 4;
      if (b.kind === 'megara') plotTrees(b, trees);
    }
    blocksByQuarter.push({ id: q.id, placed: out.blocks.length, rejected: out.rejected, roofArea });

    // Cut the quarter's blocks into chunks small enough for LOD to fire, by binning on a
    // grid rather than by sorting along one axis — a long thin run has the same radius as
    // the quarter it came from and defeats the point.
    const bins = new Map<string, Block[]>();
    for (const b of out.blocks) {
      const k = `${Math.floor(b.x / MAX_CHUNK_R)},${Math.floor(b.z / MAX_CHUNK_R)}`;
      let list = bins.get(k);
      if (!list) bins.set(k, (list = []));
      list.push(b);
    }
    let part = 0;
    for (const run of bins.values()) {
      const name = `fabric-${q.id}-${part++}`;
      let cx = 0;
      let cz = 0;
      for (const b of run) { cx += b.x; cz += b.z; }
      cx /= run.length;
      cz /= run.length;
      let radius = 0;
      for (const b of run) radius = Math.max(radius, Math.hypot(b.x - cx, b.z - cz) + Math.hypot(b.hw, b.hd) + 2);
      chunks.push({
        name, cx, cz, radius,
        castShadow: true,
        lodSwitch: [300, 850],
        farMaterial: q.kind === 'megara' ? 'stone' : 'stucco',
        build: (batch, detail) => {
          batch.setUvOrigin(cx, 0, cz);
          for (const blk of run) {
            const gy = heightAt(blk.x, blk.z);
            if (detail === 0) {
              // Far silhouette: one prism per block in the collapse material. The
              // roofscape's *height variation* is what reads at a kilometre, so the storey
              // count is kept rather than averaged away.
              const far = batch.s('stone');
              const sub = batch.pushAll(BLOCK_KEYS, place(blk, gy));
              box(far, -blk.hw, 0, -blk.hd, blk.hw,
                blk.kind === 'megara' ? 1.6 : GROUND_H + (blk.storeys - 1) * STOREY_H, blk.hd,
                blk.kind === 'megara' ? PUN.sandstoneDark : PUN.render, { bottom: false });
              batch.popAll(sub);
              continue;
            }
            if (blk.kind === 'megara') gardenPlot(batch, blk, detail, gy);
            else if (blk.kind === 'harbourside') warehouseBlock(batch, blk, detail, gy);
            else insulaBlock(batch, blk, detail, gy);
          }
        },
      });
    }
  }

  return { chunks, trees, footprints, lanes, blocksByQuarter };
}
