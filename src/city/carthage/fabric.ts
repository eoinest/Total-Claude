import * as THREE from 'three';
import { box, type Batch } from '../build';
import type { Lane } from '../cityPlan';
import { KeepOut, type WayClass } from '../layout';
import type { CityChunkSpec, TreeRequest } from '../wall';
import {
  buildLineZAt, INSULA_DEPTH, INSULA_FACE, PLOT_FACE, PUNIC_WAY_WIDTH,
  QUARTERS, shoreZAt, STOREY_H, type Quarter,
} from './layout';
import { PUN, tinted } from './palette';
import { SEA_LEVEL } from '../../maps/carthage/topography';
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

/**
 * How far above the sea a block's whole footing has to stand.
 *
 * **The fabric had a coastline test in z and none in x, and the Lake of Tunis runs in x.**
 * `planQuarter` refused anything seaward of `shoreZAt`, which is the Gulf of Tunis and is a
 * function of x; the lake's edge is a function of z and nothing tested it. So the Salammbô
 * quarter's grid marched straight across the lagoon behind the Taenia: measured against the
 * built city, **22 footprints stood under the datum, 6,689 m² of the fabric's 357,376**, the
 * deepest with its floor 9.3 m under water. Painted as splat nobody noticed; rendered as
 * water they were houses in a lagoon.
 *
 * Testing the *bed* rather than adding a second authored polyline is deliberate and it is the
 * same reasoning `WaterSurface` uses for the wetted extent: a coast and a city planned
 * against two different curves is the bug seen from two sides, and there is only one
 * heightfield. It also means a re-seed, a new quarter or a moved shoreline cannot put the
 * problem back.
 *
 * 0.5 m rather than 0. The gulf's swell breathes the waterline in and out — `surge` 0.55 in
 * the map's `WaterProfile`, and the shader's two-sine crest reaches 0.8 of it, so water laps
 * to **+0.44 m** at the top of the swell. A house at +0.24 would stand in it twice a minute.
 * `assertions.ts` measures the achieved clearance so this number cannot go quietly stale.
 */
const BUILD_FREEBOARD = 0.5;

/**
 * Is every part of this block's plan clear of the water?
 *
 * Nine samples — corners, edge midpoints and centre — rather than the four corners, because a
 * block bridging the lagoon's scarp can have all four corners on dry ground and its middle
 * 9 m under. Called once per candidate block at build time, so about 9,000 heightfield reads
 * for the whole city.
 */
function dryFooting(
  ground: Ground, x: number, z: number, hw: number, hd: number, rot: number
): boolean {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let iu = -1; iu <= 1; iu++) {
    for (let iv = -1; iv <= 1; iv++) {
      const u = iu * hw;
      const v = iv * hd;
      if (ground(x + u * c - v * s, z + u * s + v * c) < SEA_LEVEL + BUILD_FREEBOARD) return false;
    }
  }
  return true;
}

/**
 * Why a candidate cell did not become a block.
 *
 * **This exists because "771 rejected" is not a diagnosis, and three quarters were empty
 * behind it.** The Hannibalic quarter — the best-documented Punic urbanism there is, and the
 * reason §7.1 has any numbers at all — placed **zero** blocks, and so did the Byrsa approach
 * that carries Appian's six-storey ranges. One rejected count cannot tell you that: a quarter
 * with eight candidate cells and eight rejections reads exactly like a quarter that was
 * thinned. Splitting the count by cause names it in a line.
 */
export type RejectReasons = {
  /** Outside the quarter's fray mask entirely — never a candidate. */
  masked: number;
  /** Thinned by the density rule. The only rejection that is a design decision. */
  density: number;
  /** Forward of the build line behind the wall, or seaward of the shore margin. */
  outOfBounds: number;
  /** Standing within the swell crest of the datum. See `BUILD_FREEBOARD`. */
  drowned: number;
  /** Inside a monument's reserved rectangle or a way's carriageway plus frontage. */
  keepOut: number;
  /** Overlapping a block already placed, by this quarter or a neighbouring one. */
  collide: number;
};

const noReasons = (): RejectReasons =>
  ({ masked: 0, density: 0, outOfBounds: 0, drowned: 0, keepOut: 0, collide: 0 });

export interface FabricOutput {
  chunks: CityChunkSpec[];
  trees: TreeRequest[];
  footprints: { x: number; z: number; hw: number; hd: number; rot: number }[];
  lanes: Lane[];
  blocksByQuarter: {
    id: string; placed: number; rejected: number; roofArea: number;
    /** Of the rejected, how many were refused for standing in water. See `BUILD_FREEBOARD`. */
    drowned: number;
    /** The whole rejection ledger, so an empty quarter says *why* it is empty. */
    why: RejectReasons;
  }[];
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
    const r = Math.sqrt(b.hw * b.hw + b.hd * b.hd);
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
    const r = Math.sqrt(hw * hw + hd * hd);
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

const frame = (
  q: Quarter,
  bearing: number
): { x: (u: number, v: number) => number; z: (u: number, v: number) => number } => {
  const cs = Math.cos(bearing);
  const sn = Math.sin(bearing);
  return { x: (u, v) => q.x + u * cs - v * sn, z: (u, v) => q.z + u * sn + v * cs };
};

/**
 * **CANDIDATE — one city-wide lattice. Awaiting the owner's decision; not a landed call.**
 *
 * The owner asked for Carthage to be "built on a grid system", and measurement says the
 * module was already right and the *registration* was not. Every quarter runs the same Punic
 * cubit module — `INSULA_FACE + vicus` by `INSULA_DEPTH + local`, 34.90 × 22.45 m — and all
 * fifteen `QUARTERS` already share one bearing to within ±0.03 rad. But `planQuarter` used to
 * lay the first bay at `-q.hw + 0.5 * pitchU` **relative to the quarter's own centre**, and
 * those centres sit at arbitrary metres: measured across one 34.90 m bay, twelve different
 * phases spread right across the cell (1.9, 5.7, 10.4, 10.6, 11.6, 13.6, 14.1, 17.6, 18.0,
 * 23.7, 24.1, 29.2 m), and the same scatter through the 22.45 m depth. So no local street ran
 * out of one quarter and into the next, and the city read as a dozen grid patches rather than
 * as one grid.
 *
 * Two things change here and nothing else:
 *
 * 1. **Phase.** A quarter's lower corner is rounded onto the world lattice before the first
 *    bay is laid, so every bay boundary in the city is a multiple of the pitch measured from
 *    the world origin. Two quarters on the same module now interlock and their local streets
 *    are the same streets. The bay *count* is untouched.
 * 2. **Bearing.** `CITY_BEARING` replaces `q.rot + q.grid`. A lattice cannot be continuous
 *    across a 1.7° kink; the jitter was decoration and it cost the thing it decorated. This is
 *    overridden here rather than edited into `layout.ts` so the candidate is one file and the
 *    authored numbers survive untouched if it is rejected.
 *
 * The module, the pitches, the density rule, the fray mask, the keep-out and the placed-grid
 * rejection are all byte-for-byte what they were. The Megara's three quarters carry their own
 * `blockFace`/`blockDepth` (§7.7's 40-70 m field enclosures), so they get their own lattice on
 * their own pitch, anchored the same way — they are orchards, not streets, and they were never
 * meant to register with the insulae.
 */
const CITY_BEARING = 0;

/**
 * The smallest terrace worth building, in plots. One 12-cubit house, 6.2 m of street front.
 *
 * An earlier revision held this at two "because below that a block is a shed and it costs the
 * same draw call as five houses". That was wrong on its own terms: chunks merge per material,
 * so an extra block costs triangles and **no draw call at all**. And §7.1 records that some
 * plots were themselves split front and back into an `a` and a `b` unit, so a single 12 × 30
 * cubit house on a corner is the module, not a compromise. It is worth about a hectare of
 * roof in the gaps the streets leave.
 */
const MIN_PLOTS = 1;

/**
 * Shorten a block's face by whole plots until it fits, instead of deleting it.
 *
 * **This is the single largest thing wrong with the fabric's first revision and it is worth
 * stating plainly.** A candidate block was placed only if all 30.9 m of its face cleared
 * every keep-out, every neighbour and every boundary. Touch a way's frontage margin by one
 * metre and 477 m² of roof vanished. Measured: **204 of 770 rejections were the keep-out and
 * 75 were a neighbour** — 36 % of everything refused — and two whole quarters died of it. The
 * `hannibal-quarter`, which is the excavated Byrsa slope every dimension in §7.1 comes from,
 * placed **0 blocks of 8**, seven of them to the keep-out; `byrsa-approach`, which carries
 * Appian's six-storey ranges on the three streets, placed **0 of 6**, all six to the keep-out.
 * The two most important pieces of urbanism on the map were deleted by the streets that make
 * them worth building.
 *
 * **Dropping plots is not a compromise, it is the archaeology.** §7.1: the 60-cubit block face
 * is subdivided into five plots of 12 × 30 cubits. A terrace of three plots against a street
 * corner is a Punic street front; a terrace of five that has been squeezed to 4/5 scale is
 * not. So the quantum is one plot, the module is untouched, and every façade in the city
 * stays on the same 6.2 m rhythm whatever length of block it belongs to.
 *
 * **The depth is never trimmed.** §7.1's defining feature is a house with entrances front and
 * back onto two streets and a side corridor joining them. Shorten the depth and it stops
 * being that house. So `v` is fixed at 30 cubits and all the give is in `u`.
 *
 * Windows are tried longest first and, at equal length, nearest the cell centre first, so a
 * block only slides off-centre when it must and the row still reads as a row.
 */
function fitFace(
  q: Quarter,
  fullHw: number,
  stands: (off: number, hw: number) => number
): { ok: boolean; off: number; hw: number; worst: number } {
  // A garden enclosure and a warehouse range are not made of houses, so they take their own
  // quantum: a quarter of the field for the Megara, a whole insula bay for the quay ranges.
  const quantum = q.kind === 'megara' ? fullHw * 0.5 : q.kind === 'harbourside' ? INSULA_FACE : PLOT_FACE;
  const n = Math.max(1, Math.round((fullHw * 2) / quantum));
  const minRun = Math.min(n, q.kind === 'insulae' || q.kind === 'terrace' ? MIN_PLOTS : 1);
  let worst = 0;
  for (let run = n; run >= minRun; run--) {
    const starts: number[] = [];
    for (let a = 0; a + run <= n; a++) starts.push(a);
    // Nearest-centred window first; ties broken toward the low end so the choice is stable.
    starts.sort((a, b) => Math.abs(a + run / 2 - n / 2) - Math.abs(b + run / 2 - n / 2));
    for (const a of starts) {
      const hw = (run * quantum) * 0.5;
      const off = (a + run * 0.5) * quantum - fullHw;
      const bad = stands(off, hw);
      if (bad === 0) return { ok: true, off, hw, worst: 0 };
      // Report the *last* obstacle standing in the way of the smallest window tried, which is
      // the one that actually refused the cell.
      worst = bad;
    }
  }
  return { ok: false, off: 0, hw: 0, worst };
}

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
  placed: PlacedGrid,
  ground: Ground
): { blocks: Block[]; lanes: Lane[]; rejected: number; drowned: number; why: RejectReasons } {
  const blocks: Block[] = [];
  const lanes: Lane[] = [];
  const why = noReasons();
  let rejected = 0;
  let drowned = 0;
  const F = frame(q, CITY_BEARING);
  const rot = CITY_BEARING;

  const faceLen = q.blockFace ?? INSULA_FACE * q.bays;
  const depthLen = q.blockDepth ?? INSULA_DEPTH;
  const pitchU = faceLen + PUNIC_WAY_WIDTH.vicus;
  const pitchV = depthLen + PUNIC_WAY_WIDTH.local;
  const nU = Math.max(1, Math.floor((q.hw * 2) / pitchU));
  const nV = Math.max(1, Math.floor((q.hd * 2) / pitchV));
  /**
   * The snap. The quarter's lower corner is rounded onto the world lattice and the bays are
   * walked from there, so bay boundaries land on multiples of the pitch measured from the
   * world origin and two quarters on the same module share their lines.
   *
   * The **bay count is deliberately untouched** — still `floor(2·hw / pitch)`. An earlier cut
   * of this took the run of lattice cells covering the quarter's rectangle instead, which
   * quietly grew every quarter by up to half a cell on each side: it gained 29 blocks and
   * then failed the stair-apron check, and a candidate that changes coverage cannot be used
   * to grade a change of phase. Same count, same candidate cells consumed from `rng`, same
   * everything — only where the first line falls.
   */
  const cellU = (i: number): number =>
    Math.round((q.x - q.hw) / pitchU) * pitchU + (i + 0.5) * pitchU - q.x;
  const cellV = (j: number): number =>
    Math.round((q.z - q.hd) / pitchV) * pitchV + (j + 0.5) * pitchV - q.z;

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
      const u = cellU(i);
      const v = cellV(j);
      const mask = quarterMask(q, u, v);
      if (mask < 0.05) { why.masked++; continue; }
      // Density thins the *fringe*, not the heart. `mask` is 1 across the quarter's plateau
      // and only falls through its rim, so a quarter at 0.9 is essentially solid in the
      // middle and ragged at the edge — which is what a Punic quarter looks like and is what
      // keeps the roof figure from being eaten by holes nobody asked for.
      if (rng.next() > q.density * (0.35 + 0.65 * mask) + 0.2) { rejected++; why.density++; continue; }

      // The module never changes; only whether a block is there at all. Fringe blocks lose
      // a bay rather than shrinking, which keeps every façade on the same plot rhythm.
      const bays = mask < 0.35 && q.bays > 1 ? q.bays - 1 : q.bays;
      const fullHw = (q.blockFace ?? INSULA_FACE * bays) * 0.5;
      const hd = depthLen * 0.5;
      const cx = F.x(u, v);
      const cz = F.z(u, v);

      /**
       * Does a block of this face, centred at this offset along `u`, stand?
       *
       * **The bounds are tested on the block's whole extent, in both axes, and the previous
       * revision tested one point.** `buildLineZAt(centre)` alone is not the build line the
       * block meets: the reserved strip is 35 m deep along most of the wall and **70 m over a
       * stair apron**, with a cosine shoulder between, so a 31 m block whose centre stands
       * just outside an apron has a corner 15 m inside it where the line is deeper. That is
       * exactly the seven obstructed samples `assertions.ts` reports at x −475, and it is the
       * same shape of mistake as the coastline test that had a z guard and no x guard.
       *
       * So both boundaries are evaluated at the two ends of the face as well as at the
       * centre, and the strictest wins. `shoreZAt` gets the same treatment because the coast
       * runs diagonally across the whole north-east and a block face there spans 8 m of it.
       */
      const stands = (off: number, hw: number): RejectReasons['collide'] | 0 => {
        const wx = F.x(u + off, v);
        const wz = F.z(u + off, v);
        const near = Math.max(buildLineZAt(wx - hw), buildLineZAt(wx), buildLineZAt(wx + hw));
        const far = Math.min(shoreZAt(wx - hw), shoreZAt(wx), shoreZAt(wx + hw)) - 26;
        if (wz - hd < near || wz + hd > far) return 1;
        if (!dryFooting(ground, wx, wz, hw, hd, rot)) return 2;
        if (keepOut.blockedRect(wx, wz, hw + 1.2, hd + 1.2, rot)) return 3;
        if (placed.hits(wx, wz, hw + 1.0, hd + 1.0, rot)) return 4;
        return 0;
      };

      const fit = fitFace(q, fullHw, stands);
      if (!fit.ok) {
        rejected++;
        if (fit.worst === 1) why.outOfBounds++;
        else if (fit.worst === 2) { drowned++; why.drowned++; }
        else if (fit.worst === 3) why.keepOut++;
        else why.collide++;
        continue;
      }
      const hw = fit.hw;
      const wx = F.x(u + fit.off, v);
      const wz = F.z(u + fit.off, v);
      const h = hash2(i, j, Rng.hashString(q.id) & 0xffff);
      const storeys = Math.max(1, Math.round(q.storeys * (0.78 + 0.3 * mask) + (h - 0.5) * 1.2));
      blocks.push({
        x: wx, z: wz, rot, hw, hd, mask, storeys, kind: q.kind, h, bays,
        front: (i + j) % 2 === 0 ? 1 : -1,
      });
      span(rowSpan, j, u + fit.off - hw, u + fit.off + hw);
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
    const v = cellV(j) - pitchV * 0.5 - PUNIC_WAY_WIDTH.local * 0.5;
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
    const u = cellU(i) - pitchU * 0.5 - PUNIC_WAY_WIDTH.vicus * 0.5;
    lanes.push({
      path: [{ x: F.x(u, lo), z: F.z(u, lo) }, { x: F.x(u, hi), z: F.z(u, hi) }],
      cls: 'vicus' as WayClass,
      width: PUNIC_WAY_WIDTH.vicus,
    });
  }
  return { blocks, lanes, rejected, drowned, why };
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

/**
 * Every material a fabric block may touch, and it is a short list on purpose.
 *
 * **A material within a chunk is a draw call, and the fabric is the map's whole draw
 * problem** — Carthage renders 242 at ultra against a 220 cap and `fabric` is the largest
 * single line in the colour pass. Measured on the built city: `concrete` appeared in **98 of
 * 99** fabric chunks at full detail and `roof` in **25**, and between them they carried a
 * courtyard floor slab, an irrigation channel and a farm shed's tiles.
 *
 * Both are gone:
 *
 * - **`concrete` folds into `stone`.** It only ever drew the *pavimenta punica* slab in a
 *   courtyard and the Megara's channel bed, and both keep their colour — the loss is a
 *   roughness map on a horizontal surface, at a distance where a normal map has already lost
 *   84 % of its perturbation by mip 4. `TRIM_MERGE` already folded concrete into stone at mid
 *   detail, so this only makes the near tier agree with the far one.
 * - **`roof` is gone because §7.3 says it should never have been there.** "Roofs: **flat, with
 *   parapets** — Punic and North African, not tiled and pitched like Rome's." Every insula
 *   already had a flat roof; only the Megara's farm ranges carried a pitched tile gable, which
 *   is a Roman idiom on a Punic farm. They are flat-roofed now, and the fabric touches no
 *   roof-tile material anywhere.
 * - **`timber` is gone because the doors are better without it.** They were solid leaves
 *   standing 0.28 m *proud* of the wall in a wood material, in 33 of 41 chunks. §7.1's
 *   ground-floor room is "usable as a **shop** on the street", and a Punic shop front is an
 *   open doorway — so they are now a recess *into* the render, unlit and near-black. What
 *   reads at any distance is the value step and the 0.28 m of relief, and both are stronger
 *   set in than set out. Below about 40 m the loss is a wood normal map on a 1.2 × 2.2 m
 *   surface; above it, HANDOFF's own measurement says 84 % of that map is gone by mip 4.
 *
 * That takes a full-detail fabric chunk from four material meshes to **two**, plus its one
 * merged shadow proxy. `buildShadowProxy` merges **per chunk**, not per stream, so a material
 * stream costs exactly one call in the colour pass and nothing in the four cascades.
 */
const BLOCK_KEYS = ['stucco', 'stone'] as const;

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
      // Street doors front and back — §7.1's defining feature, an entrance on two streets,
      // and the ground-floor room behind one of them is a shop. Cut *into* the render as a
      // dark recess rather than stood proud as a timber leaf: the recess is the thing that
      // reads, it survives the mip chain as a value step, and it costs no second material.
      for (const zf of [-blk.hd, blk.hd] as const) {
        const sg = Math.sign(zf);
        box(wall, x0 + plotW * 0.55 - 0.6, 0.9, zf - sg * 0.34,
          x0 + plotW * 0.55 + 0.6, 3.1, zf - sg * 0.06,
          PUN.timberDark, { bottom: false, top: false });
      }
      // The cistern mouth in the courtyard floor. Every excavated house has one.
      if (p === Math.floor(nPlots / 2)) {
        box(stone, -1.1, 0.05, -courtHd + 0.4, 1.1, 0.16, courtHd - 0.4,
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
  box(stone, -blk.hw, -1.0, -blk.hd - 1.4, blk.hw, -0.15, -blk.hd + 0.6,
    PUN.earth, { bottom: false, top: true });

  if (blk.mask > 0.35 || detail >= 2) {
    const fw = Math.min(blk.hw * 0.5, 6.5);
    const fd = Math.min(blk.hd * 0.4, 4.5);
    const fx = (blk.h - 0.5) * (blk.hw - fw) * 1.3;
    const fz = -blk.front * (blk.hd - fd - 2);
    box(wall, fx - fw, 0, fz - fd, fx + fw, 3.3, fz + fd, tinted(PUN.render, blk.h, 0.16),
      { bottom: false, groundShade: 0.14 });
    // Flat, with a parapet, like every other roof in this city. §7.3 is explicit that the
    // Punic roof is flat and North African; the pitched tile gable this used to carry was a
    // Roman farm on a Carthaginian estate, and it was the fabric's only user of the `roof`
    // material — one draw call per chunk for a shed.
    box(wall, fx - fw, 3.3, fz - fd, fx + fw, 3.44, fz + fd, tinted(PUN.render, blk.h * 0.7, 0.1),
      { bottom: false });
    box(stone, fx - fw, 3.44, fz - fd, fx + fw, 3.96, fz - fd + 0.26,
      tinted(PUN.sandstoneDark, blk.h, 0.1), { bottom: false });
    box(stone, fx - fw, 3.44, fz + fd - 0.26, fx + fw, 3.96, fz + fd,
      tinted(PUN.sandstoneDark, blk.h, 0.1), { bottom: false });
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
      box(wall, px - 1.4, 1.1, blk.front * blk.hd - 0.42, px + 1.4, 4.2,
        blk.front * blk.hd - 0.08, PUN.timberDark, { bottom: false, top: false });
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
 * Chunking: one world lattice, not one lattice per quarter.
 *
 * Rome's LOD switch distances were silently never firing: `preRender` measures distance to a
 * chunk's *surface* as `centre distance − radius × 0.55`, and Rome's district chunks are
 * 400-700 m across, so the subtraction alone exceeded the switch distance and every chunk
 * stayed at full detail from every camera. Carthage caps a chunk's radius so the correction
 * stays well under the 300 m near switch, and its ladder does fire — measured at 146 m of
 * correction against a 340 m switch.
 *
 * **But the bins were per quarter, and that is a draw call for nothing.** Two quarters whose
 * fabric interleaves across one 140 m cell produced two chunks over the same ground, each
 * with its own material meshes and its own merged shadow proxy. Fifteen quarters against
 * about forty occupied cells gave **99 chunks**, and a chunk is at least three calls at full
 * detail. Binning on **one world lattice** — the same lattice the blocks themselves are
 * snapped to, so this is the registration argument applied one level up — merges those, and
 * a chunk is then a piece of *city* rather than a piece of an authoring rectangle.
 *
 * On the size. `CitySystem.surfaceCorrection` is `min(radius × 0.55, nearSwitch × 0.5)`, so
 * anything up to `2 × 0.5 × 300 / 0.55 = 545` m of radius keeps the correction on the radius
 * term; the binding consideration is frustum culling, not the ladder. 200 m is the largest
 * bin at which a chunk is still smaller than the ground a battle camera sees, and it takes
 * the count from 99 to about 40 without pinning anything at full detail.
 */
const MAX_CHUNK_R = 280;

export function buildFabric(heightAt: Ground, keepOut: KeepOut, seed: string): FabricOutput {
  const rng = new Rng(seed);
  const trees: TreeRequest[] = [];
  const footprints: { x: number; z: number; hw: number; hd: number; rot: number }[] = [];
  const lanes: Lane[] = [];
  const chunks: CityChunkSpec[] = [];
  const blocksByQuarter: FabricOutput['blocksByQuarter'] = [];
  const placed = new PlacedGrid();
  const bins = new Map<string, Block[]>();

  for (const q of QUARTERS) {
    const out = planQuarter(q, rng.fork(q.id), keepOut, placed, heightAt);
    for (const b of out.blocks) placed.add(b);
    for (const l of out.lanes) lanes.push(l);
    let roofArea = 0;
    for (const b of out.blocks) {
      footprints.push({ x: b.x, z: b.z, hw: b.hw, hd: b.hd, rot: b.rot });
      roofArea += b.hw * b.hd * 4;
      if (b.kind === 'megara') plotTrees(b, trees);
      // One world lattice for the chunks, keyed off the block's own position rather than off
      // the quarter it came from, so neighbouring quarters share a chunk instead of laying
      // two over the same ground.
      const k = `${Math.floor(b.x / MAX_CHUNK_R)},${Math.floor(b.z / MAX_CHUNK_R)}`;
      let list = bins.get(k);
      if (!list) bins.set(k, (list = []));
      list.push(b);
    }
    blocksByQuarter.push({
      id: q.id, placed: out.blocks.length, rejected: out.rejected, roofArea,
      drowned: out.drowned, why: out.why,
    });
  }

  for (const [key, run] of [...bins.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const name = `fabric-${key.replace(',', '_')}`;
    let cx = 0;
    let cz = 0;
    let gardens = 0;
    for (const b of run) { cx += b.x; cz += b.z; if (b.kind === 'megara') gardens++; }
    cx /= run.length;
    cz /= run.length;
    let radius = 0;
    for (const b of run) radius = Math.max(radius, Math.sqrt((b.x - cx) * (b.x - cx) + (b.z - cz) * (b.z - cz)) + Math.sqrt(b.hw * b.hw + b.hd * b.hd) + 2);
    chunks.push({
      name, cx, cz, radius,
      castShadow: true,
      lodSwitch: [300, 850],
      // The far tier collapses to one material, so a mixed chunk has to pick. Gardens
      // collapse to `stone` (dry-stone walls) and everything else to `stucco` (rendered
      // house walls); the majority wins, which is the right answer for a chunk that is
      // nearly all one or the other and an arbitrary but stable one for the few that are not.
      farMaterial: gardens * 2 > run.length ? 'stone' : 'stucco',
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

  return { chunks, trees, footprints, lanes, blocksByQuarter };
}
