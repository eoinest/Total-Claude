import * as THREE from 'three';
import { clamp, lerp } from '../../util/math';
import { Rng, hash2 } from '../../util/rand';
import {
  archPanel,
  box,
  column,
  cylinder,
  gableRoof,
  hipRoof,
  quadPrism,
  type Batch,
  type GeoStream,
} from '../build';
import { KeepOut, obbOverlap, type Obb, type WayClass } from '../layout';
import {
  HALF_EXTENT,
  WATER_LEVEL,
  islandMask,
  regionalPlain,
  riverInfluence,
  riverOffset,
  riverProfile,
  romeWallZ,
  worldOf,
} from '../../terrain/topography';
import { TIBER_SURVEY } from '../../terrain/tiberSurvey';
import { POMERIUM } from './circuit';
import {
  onMonument,
  PLAZAS,
  WAY_FRONTAGE,
  WAY_WIDTH,
  WAYS,
} from './layout';
import {
  faceBearing,
  insetFace,
  planarise,
  polyArea,
  type Face,
  type GraphWay,
  type PlanarGraph,
  type Pt,
} from './graph';
import { regionAt, surveyNorthingOf, type RegionPoly } from './regions';
import { wayBearingAt } from './ways';
import type { Lane } from '../cityPlan';
import type { CityMatKey } from '../materials';
import { PAL } from '../palette';
import { cylinderBetween, type CityChunkSpec, type TreeRequest } from '../wall';

/**
 * The city fabric: *insulae*, streets and courtyards.
 *
 * ## Phase 4: a block is a face of the road graph
 *
 * `docs/ROME-FABRIC.md` §5 phase 4. What this file did until now was lay a **spine-and-rib
 * lattice** inside each of seventeen district rectangles: two to six spines running the
 * length of the quarter on their own sine, ribs cutting between them, and the quads left
 * over filled with terraces. It was a real improvement on the BSP it replaced — every spine
 * ran end to end, so the gaps between blocks were streets rather than stubs — and it could
 * not close the gate, for a reason the phase that shipped it measured rather than guessed
 * (§10.5):
 *
 *  - **A block's nearest street was almost always its own quarter's rib**, cut in the
 *    quarter's own `(u, v)` frame. Turning the block toward the *network* turned it away
 *    from the lane it actually fronted, so `probe-fabric` G20 and G21 pulled in opposite
 *    directions and a sweep of the correction bound found a **floor of 6.86°** on G20 at any
 *    setting, against a 5° gate.
 *  - **The seventeen rectangles overlapped**, claiming 1.46× the available ground with 82
 *    overlapping pairs, so a block in one quarter was routinely nearest a *different*
 *    quarter's lane. G20 could not pass while the regions did not partition, whatever the
 *    lattice did.
 *
 * So the lattice is gone and with it `DISTRICT_PLAN`, `DISTRICTS`, `DistrictSpec`,
 * `districtFrame`, `districtMask`, `planDistrict`, `rowRotOf` and `ROW_TURN`. What replaces
 * them is one operation, in `graph.ts`:
 *
 *  1. **Close the armature into a planar graph** — the 23 named ways, the military road
 *     inside the curtain, and the battlefield frame. Split at every crossing, weld the
 *     nodes, prune the stubs.
 *  2. **Insert cross-lanes at the module pitch** inside any face big enough to need them,
 *     in *that face's own frame* — so a cross-lane is parallel to the street the block
 *     fronts rather than to the map axes or to a quarter's box.
 *  3. **Take the faces. Those are the blocks.** A block's orientation is the bearing of its
 *     own longest bounding edge, which is a street, which is upstream of everything here.
 *  4. **Inset each face** by its own bounding edges' setbacks. Below `MIN_DEPTH` the face is
 *     not a block: it is a plaza or a street widening, and it is reported as one.
 *  5. **Subdivide** the inset polygon into insulae, frontage quantised, depth fixed —
 *     Carthage's `fitFace` discipline, in the block's own frame.
 *  6. **Only now reject against the monuments**, which the graph cannot see.
 *
 * The *regiones* survive as **attributes**: `regions.ts` says how many storeys, how packed,
 * how grand and whether the ground is fabric or garden. It says nothing about where a block
 * is. That separation is `ROME-FABRIC.md` §4.3's whole fix.
 *
 * ## The sign, once, because it is the one thing here that cannot be seen
 *
 * `graph.ts:faceBearing` returns a **world bearing** — `atan2(dz, dx)` along the longest
 * edge. A `Plot.rot` is a **plan rotation**: `makeRotationY(rot)` sends a box's local +X to
 * `(cos rot, −sin rot)`, so a plot whose long axis must point along bearing `β` has
 * `rot = −β`, and its own `(u, v)` axes are `(cos β, sin β)` and `(−sin β, cos β)`. That is
 * the *only* place the two conventions meet in this file, it is `blockFrame`, and
 * `assertBlockBearingSign` in `assertions.ts` grades it against a deliberately asymmetric
 * case — a face at +30° and its mirror at −30° — because `MAP-METHOD.md` rule 24 is about
 * exactly this: the hash this mechanism replaced was its own mirror image, so two
 * opposite-handed conventions could disagree under it indefinitely, and they did, for as long
 * as the lattice existed.
 *
 * Real dimensions: Roman insulae ran three to five storeys, and Augustus capped them at 70
 * Roman feet (20.7 m) after collapses — Trajan later lowered it to 60 (17.8 m). Ground floors
 * held *tabernae* with wide arched openings, and the storeys above were about 3.1 m each with
 * shuttered windows and projecting timber balconies.
 */

const STOREY_H = 3.15;
const GROUND_H = 4.3;

export interface DistrictOutput {
  chunks: CityChunkSpec[];
  trees: TreeRequest[];
  /** Building footprints, in world space, for the movement-blocking grid. */
  footprints: { x: number; z: number; hw: number; hd: number; rot: number }[];
  /**
   * The lanes the grid cut for itself, so the plan diagnostic and the stats can see the whole
   * network rather than only the named armature.
   */
  lanes: Lane[];
  /** What the grid did, by the numbers, for the report and for the assertions. */
  report: BlockReport;
}

type Ground = (x: number, z: number) => number;

/**
 * What a *regio* tells a block about itself. `RegionPoly` satisfies it; nothing in the
 * building geometry ever sees a polygon.
 */
interface Character {
  id: string;
  density: number;
  grandeur: number;
  minFloors: number;
  maxFloors: number;
}

interface Plot {
  /** World centre. */
  x: number;
  z: number;
  rot: number;
  /** Half-extents of the footprint in the block's local frame. */
  hw: number;
  hd: number;
  /** Which side faces the widest street; tabernae and balconies go there. */
  frontSide: 1 | -1;
  /**
   * This footprint is a whole city block and must be built as a **continuous perimeter
   * range about a courtyard**, not as a free-standing building. See `fillRun`.
   */
  perimeter?: boolean;
  /** 1 in the heart of the city, falling to 0 at its frayed edge. */
  edge: number;
  /**
   * `FACE_X0` / `FACE_X1`: which of the plot's own ends is a **party wall** with the plot
   * packed next to it along the same frontage.
   *
   * `place` packs a frontage greedily and leaves `PARTY_GAP` = 0.35 m between pieces, which
   * is a party wall in everything but name — the two renders are 350 mm apart and nobody
   * standing in the street can see between them. So an end that abuts must stay blank, and
   * an end at the frontage's own extremity, which faces a cross street, must not. Without
   * this the ground floor puts a door and a threshold slab into a 350 mm slot: invisible,
   * and about 170,000 triangles of it across the city.
   */
  abut: number;
}

/**
 * Depth at which a block is deep enough for two rows of building about a light well.
 *
 * A Roman insula is 12–20 m from street front to back wall — that is as far as a room can be
 * from a window before it is useless — so anything deeper than about two of those plus a gap
 * is built as two terraces back to back with an internal court between them. Ostia's Casa di
 * Diana and the Garden Houses are both exactly this.
 *
 * **34 m was far too deep a threshold and the measurement is direct.** The blocks the road graph
 * produces have a median inset depth of about 37 m, so at 34 a large minority of them took the
 * single-row branch: one 22 m terrace on the street and **fifteen metres of empty back yard**
 * against the next block's wall. Roof coverage between street lines came out at **26 %** with
 * the keep-out map switched off entirely, against the AGEA orthophoto's 60–70 %. At 30, the
 * same 37 m block builds two rows of 16.9 m about a 3.2 m well — inside Ostia's own 12–20 m
 * band — and covers 91 % of its own depth instead of 59 %.
 *
 * **And 30 was still too deep.** Two thirds of the frontages the graph produces are shallower
 * than that, and each of them took the single-row branch: a 22 m terrace on the street and the
 * rest of the block bare. Per-block coverage of the buildable polygon came out at a median of
 * **31 %**. At 22 the branch flips wherever there is room for two ranges and a light well —
 * `2 × MIN_PLOT + LIGHT_WELL` is 18.2, so 22 leaves each range 9.4 m at the shallowest. That is
 * not a compromise: a Pompeian street range of *tabernae* is 4–8 m deep and Ostia's shop rows
 * are 6–9, so a 9 m range with a door on the street and a light well behind it is the commonest
 * thing in a Roman block. The deep blocks are unaffected — the row depth is still capped at
 * `INSULA_DEPTH_MAX`.
 */
const TWO_ROW_DEPTH = 22;
/** Internal light well between the two rows of a deep block. */
const LIGHT_WELL = 3.2;

/**
 * How deep a single building may be, front wall to back wall.
 *
 * A room needs a window, so a Roman house is one or two rooms deep and that is that: Ostia's
 * insulae run 12–20 m from the street to the light well and the Forma Urbis shows the same
 * across the city.
 */
const INSULA_DEPTH_MAX = 22;

/**
 * The smallest thing still worth calling a building, metres on a side.
 *
 * This is the terminator of the adaptive fill in `place`, so it decides the *grain* of the
 * fabric beside an obstruction rather than merely rejecting noise. Below about seven metres a
 * footprint stops reading as a house from any camera and starts reading as debris, and it
 * costs a movement obstacle for nothing.
 */
const MIN_PLOT = 7.5;

/**
 * Shortest frontage a terrace will cut.
 *
 * Ostia's narrowest surviving property is **6.2 m**, so 11 was never an archaeological figure —
 * it was a floor chosen to keep the old lattice from producing slivers. Nine is closer to the
 * evidence and it is worth about a fifth more frontage per block: at a mean cut of 15 m a 70 m
 * block takes five frontages instead of four, and the fifth is the one the old loop threw away
 * as a remainder.
 */
const MIN_FRONTAGE = 9;
/** A block shallower than this has no room for a house and a back wall. */
const MIN_DEPTH = 9;
/** Render's worth of party wall between two pieces of one subdivided frontage. */
const PARTY_GAP = 0.35;

// ---------------------------------------------------------------------------
// The module, and the arithmetic that fixes it
// ---------------------------------------------------------------------------

/**
 * **Across a block: 59.2 world metres, and every term is a real dimension.**
 *
 * `INSULA_DEPTH_MAX` back to back about a `LIGHT_WELL`, two *vicus* frontages, and one
 * *vicus* carriageway:
 *
 *     22 + 4.2 + 22           = 48.2   two rows of insula about a court
 *       + 2 × WAY_FRONTAGE.vicus (1.5) = 51.2   to the building line
 *       + WAY_WIDTH.vicus (8)          = 59.2   to the next lane's centreline
 *
 * `ROME-FABRIC.md` §4.3's insula arithmetic is the reason `KZ` is 0.35 and not 0.222: real
 * cross-street pitch in the Campus Martius is 50–90 m, which projects to 17.5–31.5 world
 * metres in `z`, and a true-depth insula needs about 30. So **one** row fits between two
 * projected cross-streets at the top of the real range and two do not, which is why this
 * pitch is a two-row block rather than a one-row one: the modelled city carries **fewer** of
 * a repeated thing than the real one did, at true cross-section, which is `CARTHAGE.md`
 * §2.4's rule stated for a block instead of for a tower.
 *
 * At this pitch a block encloses about `51.2 × 76 = 3,890 m²` — 0.39 ha, inside phase 4's
 * stated acceptance band of 0.15 to 1.2 ha for the median face.
 */
const PITCH_V = INSULA_DEPTH_MAX * 2 + LIGHT_WELL + 2 * WAY_FRONTAGE.vicus + WAY_WIDTH.vicus;

/**
 * **Along a block: 84 world metres.** Four frontages at the middle of Ostia's 12–26 m range
 * plus one *vicus*. Roman blocks are longer than they are deep and the Forma Urbis shows the
 * ratio at about 1.4–1.8; this is 1.42.
 */
const PITCH_U = 4 * 19 + WAY_WIDTH.vicus;

/** Faces below this get no cross-lanes: they are already a block. */
const SUBDIVIDE_MIN_M2 = PITCH_U * PITCH_V * 1.35;

/**
 * **Where the city ends, and why it is a distance to a street rather than a rectangle.**
 *
 * The seventeen district rectangles each faded their own boundary through a `fray` mask, and
 * the QA pass called the result what it was: *"the city stops at a rectangular seam"*. The
 * cause of a real city's edge is not a box, it is that fabric fronts streets and there comes
 * a point where there are no more streets. So the fringe is a smooth ramp in **distance to
 * the authored armature** — `WAYS`, the 23 plate-cited viae and the military road, and
 * nothing generated — and the *regio*'s own `fray` weights how quickly it falls.
 *
 * The two numbers are measured rather than chosen, in `tools/scratch/rome-urbanreach.mjs`:
 * they are the pair that puts the built ground inside the Aurelian circuit closest to the
 * AGEA orthophoto's 60–70 % roof coverage between street lines while leaving the far bank —
 * which phase 3 authored no way across at all — as the countryside it has to be. A block
 * beyond `URBAN_FAR` gets no cross-lanes, no plots and no floor; it is field.
 *
 * **This is also what protects G20 from the one population that could wreck it.** A block
 * out in the *ager* is bounded by the battlefield frame rather than by a street, so its grain
 * comes from the map axes and its nearest carriageway is half a kilometre away at an
 * unrelated bearing. Not building there is not a convenience: a building whose nearest street
 * is 500 m off is not a building on a street, and counting it as one would be the check
 * measuring its own absence.
 */
const URBAN_NEAR = 150;
const URBAN_FAR = 340;

/** How much of a *horti* block is built. `ROME-FABRIC.md` §4.3: about 6 % coverage. */
const HORTI_COVERAGE = 0.08;

// ---------------------------------------------------------------------------
// The block frame
// ---------------------------------------------------------------------------

interface BlockFrame {
  /** World bearing of the block's longest bounding edge. */
  bearing: number;
  /** The plan rotation every plot in this block takes: `−bearing`. */
  rot: number;
  cx: number;
  cz: number;
  x: (u: number, v: number) => number;
  z: (u: number, v: number) => number;
  u: (x: number, z: number) => number;
  v: (x: number, z: number) => number;
}

/**
 * **The one place a world bearing becomes a plan rotation.** See the file header, and
 * `assertBlockBearingSign`, which asks this function for +30° and −30° and fails if either
 * comes back mirrored.
 */
export function blockFrame(poly: readonly Pt[], cx: number, cz: number): BlockFrame {
  return frameAt(faceBearing(poly), cx, cz);
}

/** The same, from a bearing that has already been chosen. */
export function frameAt(bearing: number, cx: number, cz: number): BlockFrame {
  const cs = Math.cos(bearing);
  const sn = Math.sin(bearing);
  return {
    bearing,
    rot: -bearing,
    cx,
    cz,
    x: (u, v) => cx + u * cs - v * sn,
    z: (u, v) => cz + u * sn + v * cs,
    u: (x, z) => (x - cx) * cs + (z - cz) * sn,
    v: (x, z) => -(x - cx) * sn + (z - cz) * cs,
  };
}

/**
 * A uniform-grid reject for plots already placed.
 *
 * **The tolerance is zero now, and that is the phase.** It used to be −0.5 m — half a metre
 * of *allowed* interpenetration — because the districts overlapped and two quarters
 * interleaved buildings across a shared boundary, and because two plots following a bending
 * spine at slightly different angles clipped each other at the corner. Neither cause exists:
 * blocks are disjoint faces inset from their own streets by at least 5.5 m a side, and every
 * plot in a block shares one rotation. `probe-fabric` G3 and G10 measured the cost of the old
 * tolerance directly — 13 interpenetrating pairs and a worst clearance of −3.36 m — so the
 * allowance is gone rather than tightened.
 */
class PlotGrid {
  private static readonly CELL = 32;
  private cells = new Map<number, Plot[]>();

  private key(x: number, z: number): number {
    return ((Math.floor(x / PlotGrid.CELL) + 4096) << 13) | (Math.floor(z / PlotGrid.CELL) + 4096);
  }

  add(p: Plot): void {
    const r = Math.sqrt(p.hw * p.hw + p.hd * p.hd);
    for (let z = p.z - r; z <= p.z + r + PlotGrid.CELL; z += PlotGrid.CELL) {
      for (let x = p.x - r; x <= p.x + r + PlotGrid.CELL; x += PlotGrid.CELL) {
        const k = this.key(x, z);
        const list = this.cells.get(k);
        if (list) list.push(p);
        else this.cells.set(k, [p]);
      }
    }
  }

  hits(x: number, z: number, hw: number, hd: number, rot: number, pad = 0): boolean {
    const a: Obb = { x, z, hw, hd, rot };
    const r = Math.sqrt(hw * hw + hd * hd);
    for (let cz = z - r; cz <= z + r + PlotGrid.CELL; cz += PlotGrid.CELL) {
      for (let cx = x - r; cx <= x + r + PlotGrid.CELL; cx += PlotGrid.CELL) {
        const list = this.cells.get(this.key(cx, cz));
        if (!list) continue;
        for (const p of list) {
          if (obbOverlap(a, { x: p.x, z: p.z, hw: p.hw, hd: p.hd, rot: p.rot }, pad)) return true;
        }
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// The plan: graph -> faces -> blocks
// ---------------------------------------------------------------------------

/** How far a point is from the authored armature. Not from the generated lanes. */
const armatureSegs: { ax: number; az: number; bx: number; bz: number }[] = [];
for (const w of WAYS) {
  for (let i = 0; i + 1 < w.path.length; i++) {
    armatureSegs.push({ ax: w.path[i].x, az: w.path[i].z, bx: w.path[i + 1].x, bz: w.path[i + 1].z });
  }
}

function armatureDist(x: number, z: number): number {
  let best = Infinity;
  for (const s of armatureSegs) {
    const ex = s.bx - s.ax;
    const ez = s.bz - s.az;
    const l2 = ex * ex + ez * ez;
    const t = l2 < 1e-9 ? 0 : clamp(((x - s.ax) * ex + (z - s.az) * ez) / l2, 0, 1);
    const dx = x - (s.ax + ex * t);
    const dz = z - (s.az + ez * t);
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/**
 * How far a point is from the modelled channel. Built from the same projected stations
 * `riverWay` puts into the graph, so the frontage and the block boundary are the same line.
 */
let RIVER_SEGS: { ax: number; az: number; bx: number; bz: number }[] | null = null;
// Lazy: `riverWay` reads `FRAME_E`, which is declared below this point, and a module-level
// IIFE here would run first and read it in its temporal dead zone.
function riverSegs(): { ax: number; az: number; bx: number; bz: number }[] {
  if (RIVER_SEGS) return RIVER_SEGS;
  const out: { ax: number; az: number; bx: number; bz: number }[] = [];
  for (const w of riverWay()) {
    for (let i = 0; i + 1 < w.path.length; i++) {
      out.push({ ax: w.path[i].x, az: w.path[i].z, bx: w.path[i + 1].x, bz: w.path[i + 1].z });
    }
  }
  RIVER_SEGS = out;
  return out;
}

function riverDist(x: number, z: number): number {
  let best = Infinity;
  for (const s of riverSegs()) {
    const ex = s.bx - s.ax;
    const ez = s.bz - s.az;
    const l2 = ex * ex + ez * ez;
    const t = l2 < 1e-9 ? 0 : clamp(((x - s.ax) * ex + (z - s.az) * ez) / l2, 0, 1);
    const dx = x - (s.ax + ex * t);
    const dz = z - (s.az + ez * t);
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

const smooth = (s: number): number => s * s * (3 - 2 * s);

/**
 * 1 in the city, 0 in the country, a smooth ramp between.
 *
 * **Two frontages, and the second one is Transtiberim.** Phase 3 authored no way across the
 * right bank — the Via Aurelia and the Via Portuensis are not in `ROME_WAYS` — so on the
 * armature test alone the whole far bank came back as one 108-hectare field and Regio XIV
 * built **nothing**, on a map where the right bank is 46 % of the ground behind the crest.
 * That is a worse answer than the rectangles it replaced, which at least put a `trastevere`
 * and a `vaticanus` there.
 *
 * The repair is not to stretch the armature's reach until the Janiculum qualifies. It is that
 * **a river bank in a city is a frontage**: Transtiberim existed because of the water, its
 * fabric hugged the *Ripa*, and the hill behind it was gardens — which is exactly the shape a
 * short ramp off the channel produces. `RIVER_REACH` is 230 m, about 520 real metres of
 * riverside quarter, and beyond it the Janiculum is country until phase 6 gives it its horti.
 *
 * Recording the alternative that was rejected: giving the far-bank face a lattice regardless
 * would have covered a square kilometre with one uniform grid at one bearing, which is less
 * like Transtiberim than an empty field is.
 */
const RIVER_REACH = 230;

function urbanWeight(x: number, z: number, fray = 0.35): number {
  const far = URBAN_NEAR + (URBAN_FAR - URBAN_NEAR) * (0.55 + 0.9 * (1 - fray));
  const a = smooth(clamp((far - armatureDist(x, z)) / Math.max(20, far - URBAN_NEAR), 0, 1));
  const r = smooth(clamp((RIVER_REACH - riverDist(x, z)) / (RIVER_REACH - 40), 0, 1));
  return Math.max(a, r);
}

export type BlockKind = 'block' | 'plaza' | 'pomerium' | 'field';

export interface CityBlock {
  index: number;
  face: Face;
  /** The buildable polygon: the face pulled in by each bounding street's own setback. */
  inset: Pt[];
  insetAreaM2: number;
  frame: BlockFrame;
  region: RegionPoly;
  kind: BlockKind;
  /** Why it is not a block, when it is not. Every rejection is named. */
  reason: string | null;
  /** 1 in the city, 0 in the country. */
  urban: number;
  /** Terraces and planted avenues rather than fabric. `ROME-FABRIC.md` §4.3. */
  horti: boolean;
}

export interface BlockReport {
  graph: PlanarGraph['report'];
  crossLanes: number;
  crossLaneKm: number;
  faces: number;
  blocks: number;
  plazas: number;
  pomerium: number;
  field: number;
  hortiBlocks: number;
  /** Every face that is not a block, by reason. Nothing is dropped silently. */
  rejects: { reason: string; n: number }[];
  faceAreaP10: number;
  faceAreaP50: number;
  faceAreaP90: number;
  insetAreaP50: number;
  /** Faces whose ring is re-entrant, so the half-plane inset is conservative. */
  nonConvexFaces: number;
  plots: number;
  plotsByRegion: {
    id: string; blocks: number; plots: number; frontages: number;
    /** Ground between street lines, and how much of it is roof. */
    insetM2: number; roofM2: number; coverage: number;
  }[];
  /**
   * Regiones the frame carries too little of to grade, by name with their buildable ground.
   * `MAP-METHOD.md` rule 25: the exclusion arrives *after* the measurement that justifies it.
   */
  ungraded: { id: string; insetM2: number; blocks: number }[];
  plotRejects: PlotRejects;
  /** Blocks that survived every face test and then built nothing, by dominant cause. */
  emptyBlocks: { reason: string; n: number }[];
  /** `blockFrame`'s answer against its own face, in degrees. Should be exactly zero. */
  worstFrameErrorDeg: number;
}

const setbackOf = (cls: WayClass): number => WAY_WIDTH[cls] * 0.5 + WAY_FRONTAGE[cls];

/** All the spans of a polygon (given in the block frame) along a line of constant `u`. */
function spansAt(poly: readonly { u: number; v: number }[], u: number): [number, number][] {
  const hits: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a.u > u !== b.u > u) hits.push(a.v + ((u - a.u) / (b.u - a.u)) * (b.v - a.v));
  }
  hits.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i], hits[i + 1]]);
  return out;
}

/** The widest span, which for the convex inset polygons here is the only one. */
function spanAt(poly: readonly { u: number; v: number }[], u: number): [number, number] | null {
  const s = spansAt(poly, u);
  if (s.length === 0) return null;
  let best = s[0];
  for (const c of s) if (c[1] - c[0] > best[1] - best[0]) best = c;
  return best;
}

/**
 * **Step 2: the grid's own cross-lanes, in the face's own frame.**
 *
 * `ROME-FABRIC.md` §4.3 step 2: *"For each pair of adjacent armature edges bounding an
 * unsubdivided region, insert `vicus`-rank lines perpendicular to the local mean street
 * direction at the module pitch."* The local mean street direction is the face's own longest
 * edge, so the cross-lanes of a face are parallel and perpendicular to the street the face
 * fronts — which is the whole reason this closes G21 where the lattice could not. Two
 * adjacent faces sharing a long street share its bearing, so their lanes agree across it;
 * the grain rotates where the *street* rotates and nowhere else.
 *
 * Every fourth lane in each direction is a 14 m `local` rather than an 8 m `vicus`, so a
 * band is never more than two blocks from something a column can turn into.
 */
function crossLanesFor(face: Face): GraphWay[] {
  /*
   * **Which bearing a face's lattice takes, and why the answer is not always its longest edge.**
   *
   * For a face the size of a block, its longest edge *is* the street it fronts and that is the
   * whole point of §4.3. For a face the size of a quarter it is not: the ground the armature
   * leaves in one piece can be a kilometre across, its longest edge is then whichever of the
   * battlefield frame's own sides bounds it, and a lattice cut to the map axes is exactly the
   * grain that has nothing to do with the city. Measured: the far bank came back with 55 blocks
   * all aligned to `x` and `z` because the face containing it was bounded by the frame.
   *
   * So above eight modules the frame comes from `wayBearingAt` — the road network's own
   * rank-and-length-weighted bearing field, quadrupled-angle so it respects the same 90°
   * symmetry the question does. That is still a street's bearing, which is rule 9; it is just
   * the *mean* of the nearby streets rather than one edge of an arbitrary polygon. The blocks
   * the cut produces then take their own edges, which are the cuts, so nothing downstream ever
   * sees this choice.
   */
  const bearing = face.areaM2 > 8 * PITCH_U * PITCH_V
    ? wayBearingAt(face.cx, face.cz)
    : faceBearing(face.ring);
  const F = frameAt(bearing, face.cx, face.cz);
  const uv = face.ring.map((p) => ({ u: F.u(p.x, p.z), v: F.v(p.x, p.z) }));
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of uv) {
    if (p.u < u0) u0 = p.u;
    if (p.u > u1) u1 = p.u;
    if (p.v < v0) v0 = p.v;
    if (p.v > v1) v1 = p.v;
  }
  const out: GraphWay[] = [];
  const nU = Math.max(1, Math.round((u1 - u0) / PITCH_U));
  const nV = Math.max(1, Math.round((v1 - v0) / PITCH_V));
  const vSpansAt = (v: number): [number, number][] =>
    spansAt(uv.map((p) => ({ u: p.v, v: p.u })), v);
  /*
   * **A cut is broken where it leaves the city.**
   *
   * The faces the armature leaves behind are enormous — the ground outside the curtain is one
   * face 2,800 m across, and so is the far bank, which phase 3 authored no way across. Running
   * a lattice edge to edge over those produced **226 km of cross-lane**: a grid of streets
   * across open country, paved, drawn, and counted in the way mix. So each span is walked and
   * only the runs standing on city ground survive. A cut that stops at the edge of the fabric
   * is what a *vicus* does; one that carries on into a ploughed field is a fault that only a
   * plan view can see, and the plan views are the thing being fixed.
   */
  const emit = (id: string, cls: WayClass, ax: number, az: number, bx: number, bz: number): void => {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 12) return;
    const steps = Math.max(2, Math.round(len / 24));
    let run: Pt[] = [];
    const flush = (): void => {
      if (run.length >= 2) {
        const d0 = run[0];
        const d1 = run[run.length - 1];
        const l = Math.sqrt((d1.x - d0.x) * (d1.x - d0.x) + (d1.z - d0.z) * (d1.z - d0.z));
        if (l >= 14) out.push({ id, cls, path: run });
      }
      run = [];
    };
    for (let i = 0; i <= steps; i++) {
      const x = ax + (dx * i) / steps;
      const z = az + (dz * i) / steps;
      if (urbanWeight(x, z) > 0.05) run.push({ x, z });
      else flush();
    }
    flush();
  };
  for (let i = 1; i < nU; i++) {
    const u = lerp(u0, u1, i / nU);
    const cls: WayClass = i % 4 === 2 ? 'local' : 'vicus';
    for (const [a, b] of spansAt(uv, u)) {
      emit(`cut-u${face.index}-${i}`, cls, F.x(u, a), F.z(u, a), F.x(u, b), F.z(u, b));
    }
  }
  for (let j = 1; j < nV; j++) {
    const v = lerp(v0, v1, j / nV);
    const cls: WayClass = j % 4 === 2 ? 'local' : 'vicus';
    for (const [a, b] of vSpansAt(v)) {
      emit(`cut-v${face.index}-${j}`, cls, F.x(a, v), F.z(a, v), F.x(b, v), F.z(b, v));
    }
  }
  return out;
}

/**
 * **The Tiber's centreline, as a graph edge that is never drawn.**
 *
 * §4.3 step 1 adds the pomerium and the wall's inner face to the graph because a block may not
 * cross either. The channel is the same kind of thing and a stronger case: without it the far
 * bank and the Campus Martius are **one face**, so a block could and did span the water, and
 * the fabric on the right bank took its grain from the battlefield frame — the map's own axes —
 * rather than from anything in the city. With it, Transtiberim fronts the river, which is what
 * Transtiberim is.
 *
 * `artery` rank, so the setback is `42/2 + 10 = 31 m` either side of the centreline, and the
 * number is measured rather than chosen. The modelled channel's half-width is 14–17 world
 * metres over this reach, and `inTheRiver` refuses any plot whose ground stands below
 * `WATER_LEVEL + 2.8` — the cut bank's own terrace height — which puts the dry line 25–35 m
 * out. At `secondary`'s 17 m the riverside blocks were planned right down into the water and
 * then had **208 of their plots deleted**, one in six of everything the city planned, and the
 * block they were cut from came back empty. At 31 m the building line is on dry ground and
 * those blocks build. `inTheRiver` still runs and still owns the bank; this owns the *block
 * boundary*, and the two now agree instead of arguing.
 *
 * It is in the graph and in nothing else. `buildWays` paves `WAYS` and the generated lanes, and
 * the river is in neither, so no carriageway is drawn on the water.
 */
function riverWay(): GraphWay[] {
  const E = FRAME_E;
  const out: GraphWay[] = [];
  let run: Pt[] = [];
  const flush = (): void => {
    if (run.length >= 2) out.push({ id: `tiber-${out.length}`, cls: 'artery', path: run });
    run = [];
  };
  const inside = (p: Pt): boolean => Math.abs(p.x) <= E && Math.abs(p.z) <= E;
  /** Where the segment `a -> b` leaves the square, so the run ends ON the frame. */
  const exit = (a: Pt, b: Pt): Pt => {
    let t = 1;
    for (const [num, den] of [
      [-E - a.x, b.x - a.x], [E - a.x, b.x - a.x],
      [-E - a.z, b.z - a.z], [E - a.z, b.z - a.z],
    ] as const) {
      if (Math.abs(den) < 1e-9) continue;
      const s = num / den;
      if (s > 1e-9 && s < t) {
        const p = { x: a.x + (b.x - a.x) * s, z: a.z + (b.z - a.z) * s };
        if (Math.abs(p.x) <= E + 1e-6 && Math.abs(p.z) <= E + 1e-6) t = s;
      }
    }
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  };
  const pts = TIBER_SURVEY.map(([e, n]) => worldOf(e, n));
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (inside(p)) {
      // Entering: start the run on the frame, not at the first station inside it.
      if (run.length === 0 && i > 0 && !inside(pts[i - 1])) run.push(exit(p, pts[i - 1]));
      run.push(p);
    } else {
      if (run.length > 0) run.push(exit(pts[i - 1], p));
      flush();
    }
  }
  flush();
  return out;
}

/**
 * **The wall's own line, as a graph edge that is never drawn.** §4.3 step 1.
 *
 * Without it the ground outside the curtain and the ground inside it are **one face**, joined
 * round the west end of the circuit where the wall stops at the river — measured on this tree
 * as a single 479-hectare face with 285 edges carrying the glacis, the far bank and everything
 * the armature had not enclosed. A block may not cross the curtain, so the curtain is an edge.
 *
 * Sampled every 40 m off `romeWallZ`, the terrain's own crest, across the whole map width, so
 * it follows the wall where there is a wall and the same contour where the wall has ended.
 */
function wallWay(): GraphWay {
  const path: Pt[] = [];
  for (let x = -FRAME_E; x < FRAME_E; x += 40) path.push({ x, z: romeWallZ(x) });
  path.push({ x: FRAME_E, z: romeWallZ(FRAME_E) });
  return { id: 'wall-line', cls: 'vicus', path };
}

/** Does any part of this face stand on city ground? Corners, edge midpoints and the centroid. */
function touchesCity(f: Face): boolean {
  if (urbanWeight(f.cx, f.cz) > 0.02) return true;
  for (let i = 0; i < f.ring.length; i++) {
    const a = f.ring[i];
    const b = f.ring[(i + 1) % f.ring.length];
    if (urbanWeight(a.x, a.z) > 0.02) return true;
    if (urbanWeight((a.x + b.x) * 0.5, (a.z + b.z) * 0.5) > 0.02) return true;
  }
  return false;
}

/**
 * The battlefield frame, so the graph is closed and every face is finite.
 *
 * **The wall line and the river have to *reach* it**, and one metre short is the difference
 * between a city and a heap. A chain that ends in mid-air is degree-1 at that end, `planarise`
 * prunes degree-1 chains iteratively, and a chain that crosses nothing is therefore eaten
 * whole: with the wall line stopping at `HALF_EXTENT − 3` against a frame at `HALF_EXTENT − 2`,
 * the frame came back as **one four-edged face covering the entire 7.8 km² map** and the
 * fabric fell from 354 blocks to 124 with four *regiones* getting none at all. So `FRAME_E` is
 * one constant and all three producers use it.
 */
const FRAME_E = HALF_EXTENT - 2;

function frameWay(): GraphWay {
  const E = FRAME_E;
  return {
    id: 'frame',
    cls: 'vicus',
    path: [
      { x: -E, z: -E }, { x: E, z: -E }, { x: E, z: E }, { x: -E, z: E }, { x: -E, z: -E },
    ],
  };
}

const isConvex = (poly: readonly Pt[]): boolean => {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = poly[(i + 2) % poly.length];
    const cr = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    if (Math.abs(cr) < 1e-9) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
};

/** The narrowest width of a convex polygon: the smallest edge-normal extent. */
function minWidth(poly: readonly Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const l = Math.sqrt(ex * ex + ez * ez);
    if (l < 1e-6) continue;
    let hi = 0;
    for (const p of poly) {
      const d = ((p.x - a.x) * -ez + (p.z - a.z) * ex) / l;
      if (d > hi) hi = d;
    }
    if (hi < best) best = hi;
  }
  return best === Infinity ? 0 : best;
}

export interface CityPlanOut {
  graph: PlanarGraph;
  blocks: CityBlock[];
  /** The cross-lanes as authored, before the monuments clip the paving. */
  cuts: GraphWay[];
  report: BlockReport;
}

let PLAN: CityPlanOut | null = null;

/**
 * **The city's block plan.** Pure: the ways, the frame and the regions, and nothing else.
 *
 * Memoised because `urbanGroundMask` is called by the *terrain* build — the heightfield asks
 * what ground is city before any of the city exists — and `buildDistricts` asks again
 * afterwards. Two callers, one answer: `ROME-FABRIC.md` §7's own warning about a cache that
 * answers differently to two callers applies here, and the way this file avoids it is that
 * nothing in the computation can see a monument, a `KeepOut` or an `Rng`.
 */
export function cityPlan(): CityPlanOut {
  if (PLAN) return PLAN;
  const base: GraphWay[] = WAYS.map((w) => ({ id: w.id, cls: w.cls, path: w.path }));
  base.push(frameWay());
  base.push(wallWay());
  for (const r of riverWay()) base.push(r);

  const g0 = planarise(base);
  const cuts: GraphWay[] = [];
  for (const f of g0.faces) {
    if (f.areaM2 < SUBDIVIDE_MIN_M2) continue;
    // **Any part of the face, not its centroid.** The far bank is one 108-hectare face whose
    // centroid sits 400 m up the Janiculum; testing that point alone said "country", so no
    // lattice was cut, so Regio XIV came back with zero blocks on a bank the river frontage
    // had already declared urban. A face is offered a lattice if any of its own corners or
    // edge midpoints stands in the city; `emit` still clips every span to the ground that is.
    if (!touchesCity(f)) continue;
    // Nothing outside the curtain gets a lattice. The Via Flaminia's tomb frontage and the
    // suburbium are `ROME-FABRIC.md` §5 phase 6, and a grid of lanes across the glacis would
    // be a street network the assault walks up.
    if (f.cz < romeWallZ(clamp(f.cx, -HALF_EXTENT, HALF_EXTENT)) + POMERIUM) continue;
    for (const c of crossLanesFor(f)) cuts.push(c);
  }
  const graph = planarise([...base, ...cuts]);

  const blocks: CityBlock[] = [];
  const rejects = new Map<string, number>();
  let nonConvex = 0;
  let worstFrameErr = 0;
  for (const face of graph.faces) {
    const region = regionAt(face.cx, face.cz);
    const urban = urbanWeight(face.cx, face.cz, region.fray);
    const n = surveyNorthingOf(face.cz);
    const horti = region.hortiNorthOf !== null && n > region.hortiNorthOf;
    if (!isConvex(face.ring)) nonConvex++;
    const inset = insetFace(face, setbackOf);
    /*
     * **The frame comes from the FACE's longest edge, not from the inset's.**
     *
     * It was the inset's for one revision and the difference is not cosmetic: insetting a
     * nearly-square face by four different setbacks can make a *different* edge the longest
     * one, and the block then turns ninety degrees away from the street it fronts. Measured on
     * this tree the worst disagreement was **43.9°** and it pushed `probe-fabric` G20's p90 to
     * 20.6°. The face's edges are streets; the inset's edges are offsets of them. Only the
     * first is a thing the city has.
     */
    const frame = blockFrame(face.ring, face.cx, face.cz);
    // The frame must agree with the face it came from. Zero by construction; measured because
    // "by construction" is what every sign error in this file has claimed for itself.
    {
      const fb = faceBearing(face.ring);
      let d = Math.abs(frame.bearing - fb) % (Math.PI / 2);
      if (d > Math.PI / 4) d = Math.PI / 2 - d;
      const deg = (d * 180) / Math.PI;
      if (deg > worstFrameErr) worstFrameErr = deg;
    }
    let kind: BlockKind = 'block';
    let reason: string | null = null;
    const insetArea = inset.length >= 3 ? polyArea(inset) : 0;
    if (urban <= 0.02) {
      kind = 'field';
      reason = `beyond the armature's reach (${armatureDist(face.cx, face.cz).toFixed(0)} m)`;
    } else if (face.cz < romeWallZ(clamp(face.cx, -HALF_EXTENT, HALF_EXTENT)) + POMERIUM) {
      kind = 'pomerium';
      reason = 'inside the pomerium, or outside the curtain';
    } else if (inset.length < 3) {
      kind = 'plaza';
      reason = 'the setbacks meet: the face is all street';
    } else if (minWidth(inset) < MIN_DEPTH) {
      kind = 'plaza';
      reason = `inset narrower than MIN_DEPTH (${minWidth(inset).toFixed(1)} m)`;
    }
    if (reason) rejects.set(reason.replace(/\([^)]*\)/, '(...)'), (rejects.get(reason.replace(/\([^)]*\)/, '(...)')) ?? 0) + 1);
    blocks.push({
      index: blocks.length, face, inset, insetAreaM2: insetArea, frame, region, kind, reason, urban, horti,
    });
  }

  const areas = graph.faces.map((f) => f.areaM2).sort((a, b) => a - b);
  const insets = blocks.filter((b) => b.kind === 'block').map((b) => b.insetAreaM2).sort((a, b) => a - b);
  const q = (a: number[], p: number): number => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
  let cutKm = 0;
  for (const c of cuts) {
    for (let i = 0; i + 1 < c.path.length; i++) {
      const dx = c.path[i + 1].x - c.path[i].x;
      const dz = c.path[i + 1].z - c.path[i].z;
      cutKm += Math.sqrt(dx * dx + dz * dz);
    }
  }
  const report: BlockReport = {
    graph: graph.report,
    crossLanes: cuts.length,
    crossLaneKm: cutKm / 1000,
    faces: graph.faces.length,
    blocks: blocks.filter((b) => b.kind === 'block').length,
    plazas: blocks.filter((b) => b.kind === 'plaza').length,
    pomerium: blocks.filter((b) => b.kind === 'pomerium').length,
    field: blocks.filter((b) => b.kind === 'field').length,
    hortiBlocks: blocks.filter((b) => b.kind === 'block' && b.horti).length,
    rejects: [...rejects.entries()].sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, n })),
    faceAreaP10: q(areas, 0.1),
    faceAreaP50: q(areas, 0.5),
    faceAreaP90: q(areas, 0.9),
    insetAreaP50: q(insets, 0.5),
    nonConvexFaces: nonConvex,
    plots: 0,
    plotsByRegion: [],
    ungraded: [],
    emptyBlocks: [],
    plotRejects: { pomerium: 0, reserved: 0, neighbour: 0, thinned: 0, notPerimeter: 0, tooSmall: 0, wet: 0, narrow: 0, shortFrontage: 0, frontages: 0, rows: 0, rowsBuilt: 0, oneRowOnly: 0, perimeterTried: 0, perimeterBuilt: 0 },
    worstFrameErrorDeg: worstFrameErr,
  };
  PLAN = { graph, blocks, cuts, report };
  return PLAN;
}

// ---------------------------------------------------------------------------
// One block, subdivided
// ---------------------------------------------------------------------------

/**
 * Fill one block with insulae, in the block's own frame.
 *
 * The order is the one a surveyor works in and each step is a demotion of the last:
 *
 *  1. **One courtyard mass over the whole block.** A block big enough and clear enough stops
 *     being a row of buildings and becomes *one* building — a continuous range wrapped round
 *     all four sides with a light well in the middle. That is what an insula block is, and it
 *     is what the figure-ground of Rome looks like from above: one connected mass punched with
 *     courtyards, not a scatter of separate objects. **This is the difference between a
 *     scatter and a city, and it took a blind critic to make it stick** — shown the plan
 *     beside four crops of an orthophoto it sorted the deck 6/6 and wrote *"the buildings are
 *     separate objects with visible ground between them instead of a continuous mass of
 *     party-walled frontage… adding count doesn't produce urbanism, adding adjacency does."*
 *  2. **Halve it along `u` and try again.** A wide block that a monument clips is not
 *     unbuildable — it is two shorter blocks. Real fabric beside a monument gets *smaller*
 *     grain, it does not dissolve into open ground.
 *  3. **A terrace of party-walled frontages**, each of which subdivides further in `place`
 *     until it fits.
 */
/**
 * Why a candidate footprint did not get built. Accumulated across the city and printed, so a
 * quarter that comes back thin says *what* thinned it rather than only that it is thin — which
 * is the difference between the district generator's old "the quarter is buried" line and a
 * measurement. `MAP-METHOD.md` rule 13's shape applied to a rejection rather than to a check.
 */
export interface PlotRejects {
  /** Inside the consecrated strip behind the curtain, or outside it. */
  pomerium: number;
  /** A monument, a named street's reservation, an aqueduct or a plaza stands there. */
  reserved: number;
  /** Another block's building is already there. Must be rare; blocks are disjoint. */
  neighbour: number;
  /** The dice: `fade` thins the fabric toward the country and inside the horti. */
  thinned: number;
  /** The block is one courtyard range instead of a terrace, by the same dice. */
  notPerimeter: number;
  /** Nothing at this frontage was wide or deep enough to be a house. */
  tooSmall: number;
  /** Planned, then found standing in the Tiber. Counted, not silently dropped. */
  wet: number;
  /** The frontage was cut, but the block is shallower than a house there. */
  narrow: number;
  /** The frontage came out under `MIN_FRONTAGE`. */
  shortFrontage: number;
  /** Frontages cut, and rows offered to `place`, over the whole city. */
  frontages: number;
  rows: number;
  /** Rows that produced at least one building. */
  rowsBuilt: number;
  /** Frontages whose own span was too shallow for two rows about a light well. */
  oneRowOnly: number;
  /** Whole-block courtyard ranges tried, and how many stood. */
  perimeterTried: number;
  perimeterBuilt: number;
}

function planBlock(
  b: CityBlock,
  rng: Rng,
  keepOut: KeepOut,
  wallZAt: (x: number) => number,
  placed: PlotGrid,
  total: PlotRejects
): { plots: Plot[]; frontages: number; emptyBecause: string | null } {
  /*
   * Counted per block as well as per city, so a block that builds **nothing** can say which
   * of the six causes did it. Phase 4's acceptance asks for every rejected face to be reported
   * with its reason; a face that survives as a block and then comes back empty is the same
   * failure one level down, and it is the one the district generator could never see — its
   * only instrument was "the quarter is buried", which fires on a whole quarter or not at all.
   */
  const why: PlotRejects = {
    pomerium: 0, reserved: 0, neighbour: 0, thinned: 0, notPerimeter: 0, tooSmall: 0,
    wet: 0, narrow: 0, shortFrontage: 0, frontages: 0, rows: 0, rowsBuilt: 0, oneRowOnly: 0,
    perimeterTried: 0, perimeterBuilt: 0,
  };
  const plots: Plot[] = [];
  const F = b.frame;
  const uv = b.inset.map((p) => ({ u: F.u(p.x, p.z), v: F.v(p.x, p.z) }));
  let u0 = Infinity;
  let u1 = -Infinity;
  for (const p of uv) {
    if (p.u < u0) u0 = p.u;
    if (p.u > u1) u1 = p.u;
  }
  /*
   * **Strictly inside the bounding box, and this half-metre was the whole fabric.**
   *
   * `spansAt` counts crossings of the line `u = const` against the ring's edges. At exactly
   * `u0` or `u1` the line is *tangent* to the polygon, so it finds nought or one crossing and
   * returns no span — and `fill` starts by asking for the span over `[u0, u1]`, and every
   * recursive halving keeps one of the two ends. So every block in Rome answered "no span" and
   * the city came back with **six buildings**, on a run where G20 and G21 both read PASS off a
   * sample of six. `MAP-METHOD.md` rule 12: a statistic whose sample has collapsed reports a
   * confident number rather than an error, and it did.
   */
  u0 += 0.6;
  u1 -= 0.6;
  if (u1 - u0 < MIN_FRONTAGE) return { plots: [], frontages: 0, emptyBecause: 'narrower than one frontage' };
  const R = { rows: 0, ok: 0 };
  /**
   * How much of a block actually gets built. Measured on the AGEA orthophoto of the historic
   * core, roofs cover 60–72 % of the ground between street lines; a *horti* block is 8 %.
   */
  const keep = b.horti ? HORTI_COVERAGE : 0.9 + b.region.density * 0.1;
  const fade = (m: number): number => keep * (0.68 + 0.32 * m);

  const buildable = (u: number, v: number, hu: number, hv: number): number => {
    const x = F.x(u, v);
    const z = F.z(u, v);
    const zReach = Math.abs(Math.sin(F.rot)) * hu + Math.abs(Math.cos(F.rot)) * hv;
    if (z - zReach < wallZAt(x) + POMERIUM) {
      why.pomerium++;
      return 0;
    }
    if (keepOut.blockedRect(x, z, hu, hv, F.rot)) {
      why.reserved++;
      return 0;
    }
    if (placed.hits(x, z, hu, hv, F.rot)) {
      why.neighbour++;
      return 0;
    }
    return b.urban;
  };

  /** The v-span available across the whole of `[ua, ub]`, or null. */
  const spanOver = (ua: number, ub: number): [number, number] | null => {
    let lo = -Infinity;
    let hi = Infinity;
    for (const u of [ua, (ua + ub) * 0.5, ub]) {
      const s = spanAt(uv, u);
      if (!s) return null;
      if (s[0] > lo) lo = s[0];
      if (s[1] < hi) hi = s[1];
    }
    return hi - lo >= MIN_DEPTH ? [lo, hi] : null;
  };

  function place(
    uc: number, hu: number, v0: number, v1: number, front: 1 | -1, level: number
  ): void {
    const w = hu * 2;
    const dep = v1 - v0;
    if (w < MIN_PLOT || dep < MIN_PLOT) {
      why.tooSmall++;
      return;
    }
    const vc = (v0 + v1) * 0.5;
    const hv = dep * 0.5 - 0.12;

    const run: { i: number; u0: number; u1: number }[] = [];
    const emit = (u: number, halfW: number): boolean => {
      if (halfW * 2 < MIN_PLOT) return false;
      const mask = buildable(u, vc, halfW, hv);
      if (mask <= 0) return false;
      R.ok++;
      run.push({ i: plots.length, u0: u - halfW, u1: u + halfW });
      plots.push({
        x: F.x(u, vc), z: F.z(u, vc), rot: F.rot, hw: halfW, hd: hv,
        frontSide: front, edge: mask, abut: 0,
      });
      return true;
    };

    if (emit(uc, hu)) return;

    /*
     * **Bisection is not good enough and the measurement says so.** A frontage clipped eight
     * metres at one end halves into two twenties, the clipped twenty into two tens, and the
     * clipped ten falls under the minimum — so eight metres of obstruction destroyed twenty
     * metres of frontage and the fabric stood back from every kerb in Rome. So a frontage that
     * does not fit whole is packed greedily from one end: take the widest piece from the
     * ladder that fits, advance past it, repeat. That is how a terrace of houses actually
     * grows along an awkward plot, and it walks the façade right up to whatever is in the way.
     */
    const uEnd = uc + hu;
    let u = uc - hu;
    let any = false;
    for (let guard = 0; guard < 12 && uEnd - u >= MIN_PLOT; guard++) {
      let took = 0;
      for (const want of [w * 0.7, w * 0.45, MIN_PLOT * 1.7, MIN_PLOT]) {
        const ww = Math.min(want, uEnd - u);
        if (ww < MIN_PLOT) continue;
        if (emit(u + ww * 0.5, ww * 0.5)) {
          took = ww;
          break;
        }
      }
      u += took > 0 ? took + PARTY_GAP : MIN_PLOT * 0.5;
      any = any || took > 0;
    }
    for (let i = 1; i < run.length; i++) {
      if (run[i].u0 - run[i - 1].u1 > PARTY_GAP * 1.6) continue;
      plots[run[i - 1].i].abut |= FACE_X1;
      plots[run[i].i].abut |= FACE_X0;
    }
    if (any || level >= 2) return;
    place(uc, hu, v0, vc - PARTY_GAP * 0.5, -1, level + 1);
    place(uc, hu, vc + PARTY_GAP * 0.5, v1, 1, level + 1);
  }

  function terrace(ua: number, ub: number): void {
    /*
     * **No whole-block span test here, and removing it trebled the fabric.**
     *
     * This used to begin `if (!spanOver(ua, ub)) return`, which asks whether the block is at
     * least `MIN_DEPTH` deep *at its narrowest point over its whole length*. A face bounded by
     * two converging streets comes to a point, so its narrowest point is nought — and the
     * whole block, including the eighty metres of it that are forty metres deep, was
     * abandoned. Measured: 885 frontages from 304 blocks, against the eight per block the
     * module predicts. Each frontage tests its own span a dozen lines below, which is the
     * right place for the question: what a converging block loses is its last frontage, not
     * itself.
     */
    const cuts: number[] = [ua];
    let u = ua;
    while (ub - u > MIN_FRONTAGE) {
      const want = rng.range(11, 19);
      if (ub - (u + want) < MIN_FRONTAGE) break;
      u += want;
      cuts.push(u);
    }
    cuts.push(ub);

    for (let p = 0; p + 1 < cuts.length; p++) {
      // Party walls. The figure-ground of a real city is one connected mass punched with
      // courtyards, so the default gap is a few centimetres of render and only one frontage
      // in eight opens a passage.
      const gap = rng.next() < 0.12 ? rng.range(1.3, 2.8) : rng.range(0.05, 0.3);
      const pa = cuts[p] + (p === 0 ? 0 : gap * 0.5);
      const pb = cuts[p + 1] - (p + 2 === cuts.length ? 0 : gap * 0.5);
      const uc = (pa + pb) * 0.5;
      const hu = (pb - pa) * 0.5;
      if (hu * 2 < MIN_FRONTAGE) {
        why.shortFrontage++;
        continue;
      }
      why.frontages++;
      const local = spanOver(pa, pb);
      if (!local) {
        why.narrow++;
        continue;
      }
      const [lo, hi] = local;
      const depth = hi - lo;

      const rows: [number, number, 1 | -1][] = [];
      if (depth < TWO_ROW_DEPTH) why.oneRowOnly++;
      if (depth >= TWO_ROW_DEPTH) {
        const rd = Math.min(INSULA_DEPTH_MAX, (depth - LIGHT_WELL) * 0.5);
        rows.push([lo, lo + rd, -1], [hi - rd, hi, 1]);
      } else {
        const rd = Math.min(INSULA_DEPTH_MAX, depth);
        rows.push([lo, lo + rd, -1]);
      }
      for (const [w0, w1, front] of rows) {
        R.rows++;
        why.rows++;
        if (rng.next() > fade(b.urban)) {
          why.thinned++;
          continue;
        }
        const before = plots.length;
        place(uc, hu, w0, w1, front, 0);
        if (plots.length > before) why.rowsBuilt++;
      }
    }
  }

  function tryPerimeter(ua: number, ub: number): boolean {
    const blockW = ub - ua;
    if (blockW < 26) return false;
    const span = spanOver(ua, ub);
    if (!span) return false;
    const blockD = span[1] - span[0];
    if (blockD < 24) return false;
    /*
     * **A minority of blocks, and the measurement that inverted this.**
     *
     * It used to fire on `0.66 + density × 0.3` — nine blocks in ten — on the argument that a
     * whole-block courtyard range is what an insula block *is*. The argument is right and the
     * probability was wrong, because a perimeter range is **one inscribed rectangle** and a
     * block is not a rectangle: whatever the inscribed rectangle misses is left as bare
     * ground, and `fill` stops as soon as this returns true, so nothing ever comes back for
     * the rest. Measured with the keep-out map switched off entirely — no monuments, no
     * streets, no aqueducts — the city built **213 buildings covering 25 % of its own block
     * faces**, against the 60–70 % the AGEA orthophoto shows between street lines. 134 of
     * those 213 were single perimeter masses.
     *
     * The terrace does not have that failure mode: it walks the block's *actual* polygon by
     * spans, cuts party-walled frontages along the whole length, and lays two rows back to
     * back about a light well — which is a continuous street wall on both sides with a court
     * between, i.e. both of the things the perimeter range was there for. So the ring is now
     * the minority case it should always have been: about one block in four, more in the
     * packed quarters, and the rest get the finer grain.
     */
    why.perimeterTried++;
    if (rng.next() > 0.14 + b.region.density * 0.16) {
      why.notPerimeter++;
      return false;
    }
    const uc = (ua + ub) * 0.5;
    const vc = (span[0] + span[1]) * 0.5;
    R.rows++;
    if (rng.next() > fade(b.urban)) {
      why.thinned++;
      return false;
    }
    const mask = buildable(uc, vc, blockW * 0.5 - 0.2, blockD * 0.5 - 0.2);
    if (mask <= 0) return false;
    R.ok++;
    why.perimeterBuilt++;
    plots.push({
      x: F.x(uc, vc), z: F.z(uc, vc), rot: F.rot,
      hw: blockW * 0.5 - 0.2, hd: blockD * 0.5 - 0.2,
      frontSide: -1, edge: mask, perimeter: true, abut: 0,
    });
    return true;
  }

  function fill(ua: number, ub: number, level = 0): void {
    if (ub - ua < 13) return;
    if (!b.horti && tryPerimeter(ua, ub)) return;
    // 66 m is two frontages plus a party wall either side of a 14 m lane: below it, halving
    // produces blocks too short to read as blocks and the terrace is the honest answer. Split
    // off-centre so the grain does not come out as powers of two.
    if (ub - ua >= 66 && level < 2) {
      const um = lerp(ua, ub, rng.range(0.4, 0.6));
      fill(ua, um - 0.25, level + 1);
      fill(um + 0.25, ub, level + 1);
      return;
    }
    terrace(ua, ub);
  }

  fill(u0, u1);
  for (const k of Object.keys(why) as (keyof PlotRejects)[]) total[k] += why[k];
  let emptyBecause: string | null = null;
  if (plots.length === 0) {
    const causes: [string, number][] = [
      ['a monument, a street reservation or an aqueduct', why.reserved],
      ['the pomerium', why.pomerium],
      ['too shallow for a house', why.narrow],
      ['thinned to nothing at the city fringe', why.thinned],
      ['no frontage wide enough', why.shortFrontage + why.tooSmall],
      ["a neighbour's building", why.neighbour],
    ];
    causes.sort((a, b) => b[1] - a[1]);
    emptyBecause = causes[0][1] > 0 ? causes[0][0] : 'no frontage was offered at all';
  }
  return { plots, frontages: R.rows, emptyBecause };
}

/**
 * **Would any part of this plot stand in water?**
 *
 * Not "is it within N metres of the channel". A distance margin is the wrong shape: the
 * Tiber's cut bank rises to `WATER_LEVEL` + 2.8 in fifteen metres and its point bar takes
 * eighty-two to reach + 0.8, so one margin is either too tight on one side or eats a hundred
 * metres of dry quay on the other. Two rounds of tuning a single margin moved the count from
 * 4 to 8 and back, because a rejected plot frees ground the placer immediately fills.
 *
 * So ask the terrain's own question: evaluate the **modelled ground** — `regionalPlain`
 * blended into `riverProfile` by `riverInfluence`, which is exactly what `heightfield.ts`
 * does before it adds noise — and reject the plot if any of nine samples over its bounding
 * box comes out under `WATER_LEVEL + FREEBOARD`.
 *
 * The Tiber Island is land and is excluded from the test rather than from the map: the Insula
 * Tiberina, the Pons Fabricius and the Pons Cestius all stand on it.
 */
const RIVER_FREEBOARD = 2.8;

/**
 * The same question at one point. Exported so an offline audit can rasterise the river's
 * share of a block's ground without carrying its own copy of the blend — `MAP-METHOD.md`
 * rule 29, and the nine-sample box test below is now the only caller inside this file.
 */
export function inTheRiverAt(x: number, z: number): boolean {
  if (islandMask(x, z) > 0.4) return false;
  const d = riverOffset(x, z);
  const inf = riverInfluence(d, z);
  if (inf <= 0.001) return false;
  const plain = regionalPlain(x, z);
  const g = plain + (riverProfile(d, z, plain) - plain) * inf;
  return g < WATER_LEVEL + RIVER_FREEBOARD;
}

function inTheRiver(p: Plot): boolean {
  const ah = Math.abs(p.hw * Math.cos(p.rot)) + Math.abs(p.hd * Math.sin(p.rot));
  const ad = Math.abs(p.hw * Math.sin(p.rot)) + Math.abs(p.hd * Math.cos(p.rot));
  for (const [su, sv] of [
    [0, 0], [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
  ] as const) {
    if (inTheRiverAt(p.x + ah * su, p.z + ad * sv)) return true;
  }
  return false;
}

/**
 * **How much of the ground at (x, z) belongs to the city.** 1 on a block, 0 in the country.
 *
 * This is the block floor's own mask, evaluated without building anything, so the ground the
 * terrain treats as urban and the floor the city draws over it cannot disagree — they are the
 * same function of the same faces. `MAP-METHOD.md` rule 11 is about a footprint and a piece
 * of stone drifting apart because two producers each held their own copy of the same
 * rectangle.
 *
 * **What it is for.** Nothing in `GrassField` had ever heard of the city, so a 0.32–0.54 m
 * sward grew through a carriageway drawn 6 cm above the terrain and the eye-level frame in an
 * insula quarter was a photograph of grass with some walls behind it.
 *
 * It is a mask on the **ground**, not on the fabric: it deliberately includes the streets,
 * the yards and the space between the monuments, because all of that is city floor and none
 * of it is meadow. It is a raster rather than a polygon sweep because the heightfield asks
 * this question about a million times and there are two thousand faces.
 */
const MASK_CELL = 12;
const MASK_N = Math.ceil((HALF_EXTENT * 2) / MASK_CELL) + 1;
let MASK: Float32Array | null = null;

function urbanRaster(): Float32Array {
  if (MASK) return MASK;
  const m = new Float32Array(MASK_N * MASK_N);
  const plan = cityPlan();
  for (const b of plan.blocks) {
    if (b.kind === 'field' || b.kind === 'pomerium') continue;
    const ring = b.face.ring;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const p of ring) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.z < z0) z0 = p.z;
      if (p.z > z1) z1 = p.z;
    }
    const i0 = Math.max(0, Math.floor((x0 + HALF_EXTENT) / MASK_CELL));
    const i1 = Math.min(MASK_N - 1, Math.ceil((x1 + HALF_EXTENT) / MASK_CELL));
    const j0 = Math.max(0, Math.floor((z0 + HALF_EXTENT) / MASK_CELL));
    const j1 = Math.min(MASK_N - 1, Math.ceil((z1 + HALF_EXTENT) / MASK_CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = i * MASK_CELL - HALF_EXTENT;
        const z = j * MASK_CELL - HALF_EXTENT;
        let inside = false;
        for (let a = 0, c = ring.length - 1; a < ring.length; c = a++) {
          if (ring[a].z > z !== ring[c].z > z) {
            const t = (z - ring[a].z) / (ring[c].z - ring[a].z);
            if (x < ring[a].x + t * (ring[c].x - ring[a].x)) inside = !inside;
          }
        }
        if (inside) m[j * MASK_N + i] = Math.max(m[j * MASK_N + i], b.urban);
      }
    }
  }
  MASK = m;
  return m;
}

export function urbanGroundMask(x: number, z: number, wallZAt: (x: number) => number): number {
  if (z <= wallZAt(x) + 8) return 0;
  const m = urbanRaster();
  const fx = (x + HALF_EXTENT) / MASK_CELL;
  const fz = (z + HALF_EXTENT) / MASK_CELL;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  if (i < 0 || j < 0 || i + 1 >= MASK_N || j + 1 >= MASK_N) return 0;
  const tx = fx - i;
  const tz = fz - j;
  const a = m[j * MASK_N + i];
  const b = m[j * MASK_N + i + 1];
  const c = m[(j + 1) * MASK_N + i];
  const d = m[(j + 1) * MASK_N + i + 1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

export function buildDistricts(
  heightAt: Ground,
  keepOut: KeepOut,
  seed: string,
  wallZAt: (x: number) => number
): DistrictOutput {
  const rng = new Rng(seed);
  const trees: TreeRequest[] = [];
  const footprints: { x: number; z: number; hw: number; hd: number; rot: number }[] = [];
  const plan = cityPlan();
  const report: BlockReport = { ...plan.report };

  /*
   * **The cross-lanes become drawn streets here, and only here, because this is the first
   * place a monument is visible.**
   *
   * `graph.ts` cannot see a monument by design — §4.3 step 6, and the reason `deflect()`
   * existed. So the *plan* runs a lane straight across the Baths of Trajan if the block
   * boundary falls there, and the block boundary is right: the ground on both sides of the
   * baths is fabric and the two sides are different blocks. What must not happen is that the
   * lane is *paved* over the temple floor, which is `probe-fabric` G4 and G5. So the run is
   * broken wherever it enters a reservation and picked up on the far side, which is what a
   * street that stops at a precinct does.
   */
  const lanes: Lane[] = [];
  for (const c of plan.cuts) {
    const w = WAY_WIDTH[c.cls];
    for (let s = 0; s + 1 < c.path.length; s++) {
      const a = c.path[s];
      const b = c.path[s + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      const steps = Math.max(2, Math.round(len / 12));
      let run: { x: number; z: number }[] = [];
      for (let i = 0; i <= steps; i++) {
        const x = a.x + (dx * i) / steps;
        const z = a.z + (dz * i) / steps;
        const ok = !keepOut.blockedRect(x, z, 6, w * 0.5, 0) && z > wallZAt(x) + 20;
        if (ok) run.push({ x, z });
        else {
          if (run.length >= 2) lanes.push({ path: run, cls: c.cls, width: w });
          run = [];
        }
      }
      if (run.length >= 2) lanes.push({ path: run, cls: c.cls, width: w });
    }
  }

  // ---- the plots ----------------------------------------------------------
  const placed = new PlotGrid();
  const why: PlotRejects = { pomerium: 0, reserved: 0, neighbour: 0, thinned: 0, notPerimeter: 0, tooSmall: 0, wet: 0, narrow: 0, shortFrontage: 0, frontages: 0, rows: 0, rowsBuilt: 0, oneRowOnly: 0, perimeterTried: 0, perimeterBuilt: 0 };
  const emptyBlocks = new Map<string, number>();
  const byBlock = new Map<number, Plot[]>();
  const perRegion = new Map<string, { blocks: number; plots: number; frontages: number; insetM2: number; roofM2: number }>();
  let plotCount = 0;
  for (const b of plan.blocks) {
    const acc = perRegion.get(b.region.id) ?? { blocks: 0, plots: 0, frontages: 0, insetM2: 0, roofM2: 0 };
    if (b.kind !== 'block') {
      perRegion.set(b.region.id, acc);
      continue;
    }
    acc.blocks++;
    acc.insetM2 += b.insetAreaM2;
    const brng = rng.fork(`block:${b.index}`);
    const out = planBlock(b, brng, keepOut, wallZAt, placed, why);
    acc.frontages += out.frontages;
    if (out.emptyBecause) emptyBlocks.set(out.emptyBecause, (emptyBlocks.get(out.emptyBecause) ?? 0) + 1);
    // **Nothing stands in the Tiber.** The graph has never been told where the water is. The
    // wet plots still claim their ground: dropping them outright frees the river's own
    // footprint and something else fills it. The river is a hole in the city.
    const dry = out.plots.filter((p) => !inTheRiver(p));
    why.wet += out.plots.length - dry.length;
    for (const p of out.plots) placed.add(p);
    byBlock.set(b.index, dry);
    acc.plots += dry.length;
    for (const q of dry) acc.roofM2 += 4 * q.hw * q.hd;
    plotCount += dry.length;
    for (const p of dry) footprints.push({ x: p.x, z: p.z, hw: p.hw, hd: p.hd, rot: p.rot });
    perRegion.set(b.region.id, acc);
  }
  report.plots = plotCount;
  report.plotRejects = why;
  report.emptyBlocks = [...emptyBlocks.entries()].sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, n }));
  report.plotsByRegion = [...perRegion.entries()]
    .sort((a, b) => b[1].plots - a[1].plots)
    .map(([id, v]) => ({
      id, blocks: v.blocks, plots: v.plots, frontages: v.frontages,
      insetM2: v.insetM2, roofM2: v.roofM2, coverage: v.insetM2 > 0 ? v.roofM2 / v.insetM2 : 0,
    }));

  /*
   * **The self-report, kept word for word, because the check that reads it must not go dark.**
   *
   * `probe-fabric` G17 greps the boot log for `planned only N buildings from M frontages — the
   * quarter is buried`. Deleting the seventeen districts deletes the only producer of that
   * line, and `MAP-METHOD.md` rule 13 is explicit that a check which goes dark is worse than
   * one that fails: G17 would have read PASS on a city with no houses in it. So the *regiones*
   * report themselves in the same words.
   *
   * The population changed and the threshold has to change with it. A regio is asked the
   * question only if it has at least three blocks — Regio X keeps one sliver of the Palatine's
   * north slope on this frame and a regio with one block is not buried, it is off the edge —
   * and the floor stays twenty buildings, which is about two blocks' worth. The count is
   * absolute rather than a ratio for the reason the district version recorded: `place` packs a
   * frontage greedily, so one frontage yields six buildings or none and `ok/rows` fired on
   * fourteen of seventeen healthy quarters.
   */
  /*
   * **Which regiones the question can be asked of, and the measurement that decides it.**
   *
   * `MAP-METHOD.md` rule 25: *"a survey station can only be graded where the frame can carry
   * it, and that has to be a check that fails rather than an exclusion that explains… An
   * exclusion that arrives before the check that justifies it is exemption-shopping; one that
   * arrives after it is a measurement."*
   *
   * At `KZ` = 0.35 the map's +Z edge is survey northing −441. **Regio X Palatium** and **Regio
   * XI Circus Maximus** are centred 450 m past it, so what the frame carries of them is a
   * ribbon along the last twenty metres of the map: measured on this tree, X keeps **one** block
   * with 0.31 ha of buildable ground and XI keeps **four** totalling 0.30 ha, all of them
   * inside the Theatre of Marcellus's or the Capitol's own reservation. "Twenty buildings" is
   * not a floor that means anything against three hectares of ground.
   *
   * So the floor is stated in **ground**, not in blocks: one hectare of buildable polygon,
   * which is about three and a half blocks at this module's own median inset. It is set there
   * and not higher because Regio IV, the Subura, has only **1.36 ha** of buildable ground on
   * this frame and builds **77 %** of it — the densest quarter in the city would have been
   * excused from the check by a two-hectare floor, which is the shape of mistake rule 25 is
   * about. A regio below the floor is named,
   * counted and printed every run with its area, and `assertRegionsGraded` gates the count —
   * so a third regio dropping out of the graded population is a failure and not a category.
   */
  const GRADE_FLOOR_M2 = 10000;
  const BURIED_COVERAGE = 0.15;
  const ungraded: { id: string; insetM2: number; blocks: number }[] = [];
  for (const [id, v] of perRegion) {
    if (v.insetM2 < GRADE_FLOOR_M2) {
      ungraded.push({ id, insetM2: v.insetM2, blocks: v.blocks });
      continue;
    }
    /*
     * **Buried is a coverage floor now, not a building count, and the floor is external.**
     *
     * "Fewer than twenty buildings" was the right shape for seventeen rectangles of roughly one
     * size. It is the wrong shape for ten regiones whose buildable ground on this frame runs
     * from 0.3 to 49 hectares: twenty buildings is a full quarter for Regio IV and a rounding
     * error for Regio VI. So the question is asked in the units the answer is wanted in —
     * **roof over the ground between street lines** — and against the number `ROME-FABRIC.md`
     * §4.4 check 4 takes from the AGEA 2012 orthophoto: the historic core is **60–70 %** built.
     * Fifteen per cent is a quarter of that and is nowhere near a judgement call about quality;
     * a regio under it has not been built at all.
     *
     * The old wording is kept to the word because `probe-fabric` G17 greps for it, and a check
     * that goes dark is worse than one that fails (rule 13).
     */
    const cov = v.insetM2 > 0 ? v.roofM2 / v.insetM2 : 0;
    if (cov < BURIED_COVERAGE) {
      console.warn(
        `[city] ${id} planned only ${v.plots} buildings from ${v.frontages} frontages — the quarter is buried`
        + ` (${(cov * 100).toFixed(1)} % of its ${(v.insetM2 / 1e4).toFixed(2)} ha of ground between street lines,`
        + ` against the orthophoto's 60-70 % and this floor's ${(BURIED_COVERAGE * 100).toFixed(0)} %)`
      );
    }
  }
  ungraded.sort((a, b) => a.id < b.id ? -1 : 1);
  report.ungraded = ungraded;
  if (ungraded.length) {
    console.info(
      `[city:rome] ${ungraded.length} regio(nes) the frame carries too little of to grade for `
      + `burial, by name: ${ungraded.map((u) => `${u.id} ${u.blocks} block(s), ${(u.insetM2 / 1e4).toFixed(2)} ha buildable`).join('; ')}`
      + ` — the floor is ${(GRADE_FLOOR_M2 / 1e4).toFixed(0)} ha`
    );
  }
  console.info(
    `[city:rome] grid: ${report.faces} faces of the road graph — ${report.blocks} blocks,`
    + ` ${report.plazas} plazas, ${report.pomerium} pomerium, ${report.field} field;`
    + ` ${report.crossLanes} cross-lanes (${report.crossLaneKm.toFixed(1)} km);`
    + ` block face p10/p50/p90 ${(report.faceAreaP10 / 1e4).toFixed(2)}/`
    + `${(report.faceAreaP50 / 1e4).toFixed(2)}/${(report.faceAreaP90 / 1e4).toFixed(2)} ha;`
    + ` ${plotCount} insulae. Footprints rejected: ${JSON.stringify(why)}.`
    + ` Blocks that built nothing: ${report.emptyBlocks.map((e) => `${e.n} ${e.reason}`).join('; ') || 'none'}.`
    + ` Rejected faces by reason: `
    + report.rejects.map((r) => `${r.n} ${r.reason}`).join('; ')
  );
  console.info(
    '[city:rome] grid by regio: '
    + report.plotsByRegion.map((r) => `${r.id} ${r.blocks}b/${r.plots}p/${(r.coverage * 100).toFixed(0)}%`).join('  ')
  );

  // ---- planting -----------------------------------------------------------
  // Courtyard trees inside, orchards and garden plots on the frayed margin — which is what
  // actually made the edge of a Roman city, and it hides the transition to fields.
  {
    const trng = rng.fork('planting');
    for (const b of plan.blocks) {
      if (b.kind === 'pomerium' || b.kind === 'field') continue;
      const n = Math.round(b.face.areaM2 * (b.horti ? 0.0016 : 0.00055) * (1.4 - b.region.density));
      for (let i = 0; i < n; i++) {
        const F = b.frame;
        const u = trng.range(-1, 1);
        const v = trng.range(-1, 1);
        const wx = F.x(u * 90, v * 60);
        const wz = F.z(u * 90, v * 60);
        if (wz < wallZAt(wx) + 14) continue;
        if (urbanGroundMask(wx, wz, wallZAt) < 0.15) continue;
        if (keepOut.blocked(wx, wz, 5)) continue;
        if (placed.hits(wx, wz, 3, 3, 0)) continue;
        if (nearLane(lanes, wx, wz, 3)) continue;
        trees.push({
          x: wx, z: wz,
          kind: trng.pick(['cypress', 'pine', 'umbrella'] as const),
          scale: trng.range(0.75, 1.25),
        });
      }
    }
  }

  /**
   * **Chunks are a draw-call budget before they are a quality setting**, and the grouping is
   * no longer by quarter because there are no quarters.
   *
   * A chunk at full detail is four meshes — stucco, roof, stone, timber — and therefore four
   * draw calls plus their shadow passes. Six groups at full detail is 24 calls before a single
   * monument, against a 220 whole-frame cap. So the city is cut into **six bands, two columns
   * by three rows, aligned to the wall rather than to the quarters**, because the camera that
   * matters looks *along* the wall from above it or *at* it from the field: a band parallel to
   * the curtain is either wholly in frame or wholly out, which is what makes an LOD switch
   * worth having. The switch distance is measured to a chunk's surface, so a 1,400 m band is
   * never far away by that measure however small the number; merging is the only lever that
   * actually removes a call.
   *
   * `city-gate-w` keeps the tightest switch and the only shadow pass: it is the quarter
   * directly behind the Porta Flaminia and the player is looking at it from thirty metres.
   */
  const bandOf = (b: CityBlock): string => {
    const col = b.face.cx < 300 ? 'w' : 'e';
    const row = b.face.cz < 720 ? 'gate' : b.face.cz < 980 ? 'mid' : 'far';
    return `city-${row}-${col}`;
  };
  const groups = new Map<string, CityBlock[]>();
  for (const b of plan.blocks) {
    if (b.kind === 'field' || b.kind === 'pomerium') continue;
    const k = bandOf(b);
    const list = groups.get(k);
    if (list) list.push(b);
    else groups.set(k, [b]);
  }

  const chunks: CityChunkSpec[] = [];
  for (const [name, list] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let cx = 0;
    let cz = 0;
    for (const b of list) {
      cx += b.face.cx;
      cz += b.face.cz;
    }
    cx /= list.length;
    cz /= list.length;
    let radius = 60;
    for (const b of list) {
      for (const p of b.face.ring) {
        const d = Math.sqrt((p.x - cx) * (p.x - cx) + (p.z - cz) * (p.z - cz));
        if (d > radius) radius = d;
      }
    }
    const near = name === 'city-gate-w';
    chunks.push({
      name,
      cx,
      cz,
      radius,
      castShadow: near,
      lodSwitch: near ? [260, 1200] : [280, 1e9],
      build: (batch, detail) => {
        batch.setUvOrigin(cx, 0, cz);
        for (const b of list) {
          if (detail >= 1) buildBlockFloor(batch, b, heightAt, wallZAt);
          const plots = byBlock.get(b.index) ?? [];
          for (let i = 0; i < plots.length; i++) {
            buildBuilding(batch, detail, plots[i], b.region, heightAt, new Rng(Rng.hashString(`${b.index}:${i}`)));
          }
        }
      },
    });
  }

  // The whole street network in one chunk: carriageways, kerbs, footways and the colonnades
  // of the processional ways. Two materials, so two draw calls for every paved surface in Rome.
  chunks.push({
    name: 'streets',
    cx: 0,
    cz: 760,
    radius: 1500,
    castShadow: false,
    lodSwitch: [1e9, 1e9],
    build: (batch, detail) => {
      batch.setUvOrigin(0, 0, 760);
      buildWays(batch, detail, heightAt, lanes);
    },
  });

  return { chunks, trees, footprints, lanes, report };
}

/**
 * **The deliberately asymmetric case, which is the only way this sign can be checked.**
 *
 * `MAP-METHOD.md` rule 24, in full because it was paid for here: *"a symmetric input hides an
 * asymmetric bug, and replacing it is what reveals the bug… Every terrace in Rome was built to
 * the reflection of its own street, off by up to 14.6°, since the lattice was written. Neither
 * the fabric gate nor the Carthage control could see it, for the same reason: Carthage's
 * blocks are axis-aligned, and an axis-aligned control is symmetric under reflection too."*
 *
 * So this asks `blockFrame` for a face whose long axis is at **+30°**, and for its mirror at
 * **−30°**, and requires that the plot rotation it hands back draws the long axis along the
 * bearing it was given. Three independent things have to be right at once and each of them has
 * been wrong in this file:
 *
 *  - `faceBearing` must return `atan2(dz, dx)` of the long edge, not its negation;
 *  - `Plot.rot` must be `−bearing`, because `makeRotationY(rot)` sends local +X to
 *    `(cos rot, −sin rot)`;
 *  - the frame's own `u` axis must be `(cos bearing, sin bearing)`, so the terrace is laid
 *    along the same line the plot is drawn along.
 *
 * A mirrored implementation passes every one of these at 0° and 45° and fails at 30°, which is
 * exactly why 0 and 45 are not in the list. `drawnDeg` is computed the way the *renderer*
 * computes it, from `makeRotationY`, rather than from the sign convention this file believes
 * in — otherwise it would be the check comparing something against itself.
 */
export function assertBlockBearingSign(): {
  ok: boolean;
  cases: { inputDeg: number; bearingDeg: number; rotDeg: number; drawnDeg: number; ok: boolean }[];
  worstDeg: number;
} {
  const fold = (rad: number): number => {
    let d = (Math.abs(rad) * 180) / Math.PI % 90;
    if (d > 45) d = 90 - d;
    return d;
  };
  const cases = [30, -30, 12, -12, 75, -75, 3].map((inputDeg) => {
    const th = (inputDeg * Math.PI) / 180;
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    // A 240 x 80 rectangle whose long axis is at `th`, so "longest edge" is unambiguous.
    const ring: Pt[] = ([[-120, -40], [120, -40], [120, 40], [-120, 40]] as const)
      .map(([u, v]) => ({ x: u * cs - v * sn, z: u * sn + v * cs }));
    const F = blockFrame(ring, 0, 0);
    // The renderer's own reading: `makeRotationY(rot)` sends local +X to (cos rot, -sin rot).
    const drawn = Math.atan2(-Math.sin(F.rot), Math.cos(F.rot));
    // ...and the frame's u axis, which the terrace is laid along, must be the same line.
    const uAxis = Math.atan2(F.z(1, 0) - F.z(0, 0), F.x(1, 0) - F.x(0, 0));
    const bad = Math.max(fold(F.bearing - th), fold(drawn - th), fold(uAxis - th));
    return {
      inputDeg,
      bearingDeg: (F.bearing * 180) / Math.PI,
      rotDeg: (F.rot * 180) / Math.PI,
      drawnDeg: (drawn * 180) / Math.PI,
      ok: bad < 1e-6,
    };
  });
  // And the mirror relation itself: +30 and -30 must give exactly opposite rotations.
  const pairOk = Math.abs(cases[0].rotDeg + cases[1].rotDeg) < 1e-9
    && Math.abs(cases[2].rotDeg + cases[3].rotDeg) < 1e-9
    && Math.abs(cases[4].rotDeg + cases[5].rotDeg) < 1e-9;
  const worst = Math.max(...cases.map((c) => fold(((c.drawnDeg - c.inputDeg) * Math.PI) / 180)));
  return { ok: cases.every((c) => c.ok) && pairOk, cases, worstDeg: worst };
}

/**
 * **Are the blocks actually faces of the graph?** The check that says whether §4.3 happened.
 *
 * Two questions, and the second is the one that can go wrong quietly:
 *
 *  1. **Every plot's rotation is its block's frame rotation**, which is the bearing of a street.
 *     Zero by construction — `planBlock` writes `F.rot` into every plot — so this is a guard on
 *     the construction rather than a measurement, and it is cheap.
 *  2. **No plot straddles a street centreline.** The graph's own edges are the centrelines, and
 *     a plot is cut from a polygon that was inset from them, so the answer must be none. It can
 *     fail: `spanAt` takes the widest span of a re-entrant polygon, the half-plane inset is only
 *     conservative for a *convex* face, and either could put a rectangle across a lane. This is
 *     the boot-time half of `probe-fabric` G4/G5, asked of the fabric instead of the monuments.
 *
 * The reference is the planar graph, which is upstream of the block generator and has never
 * heard of a plot — `MAP-METHOD.md` rule 6.
 */
export function assertBlocksAreFaces(
  footprints: readonly { x: number; z: number; hw: number; hd: number; rot: number }[]
): { ok: boolean; plots: number; straddling: number; worstDepthM: number; worst: string[] } {
  const plan = cityPlan();
  const CELL = 48;
  const cells = new Map<number, number[]>();
  const key = (ix: number, iz: number): number => ((ix + 4096) << 13) | (iz + 4096);
  const g = plan.graph;
  for (let i = 0; i < g.edges.length; i++) {
    const a = g.nodes[g.edges[i].a];
    const b = g.nodes[g.edges[i].b];
    const x0 = Math.floor(Math.min(a.x, b.x) / CELL);
    const x1 = Math.floor(Math.max(a.x, b.x) / CELL);
    const z0 = Math.floor(Math.min(a.z, b.z) / CELL);
    const z1 = Math.floor(Math.max(a.z, b.z) / CELL);
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const k = key(ix, iz);
        const list = cells.get(k);
        if (list) list.push(i);
        else cells.set(k, [i]);
      }
    }
  }
  let straddling = 0;
  let worst = 0;
  const names: string[] = [];
  for (const f of footprints) {
    const cs = Math.cos(f.rot);
    const sn = Math.sin(f.rot);
    // The plot's own axes, in the plan convention: +X -> (cos, -sin), +Z -> (sin, cos).
    const inside = (px: number, pz: number): number => {
      const dx = px - f.x;
      const dz = pz - f.z;
      const u = dx * cs - dz * sn;
      const v = dx * sn + dz * cs;
      return Math.min(f.hw - Math.abs(u), f.hd - Math.abs(v));
    };
    const r = Math.sqrt(f.hw * f.hw + f.hd * f.hd);
    const seen = new Set<number>();
    for (let iz = Math.floor((f.z - r) / CELL); iz <= Math.floor((f.z + r) / CELL); iz++) {
      for (let ix = Math.floor((f.x - r) / CELL); ix <= Math.floor((f.x + r) / CELL); ix++) {
        for (const ei of cells.get(key(ix, iz)) ?? []) {
          if (seen.has(ei)) continue;
          seen.add(ei);
          const a = g.nodes[g.edges[ei].a];
          const b = g.nodes[g.edges[ei].b];
          // Sample the segment; a centreline crossing a plot puts a sample inside it.
          const len = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z));
          const n = Math.max(2, Math.min(64, Math.round(len / 2)));
          for (let i = 0; i <= n; i++) {
            const d = inside(a.x + ((b.x - a.x) * i) / n, a.z + ((b.z - a.z) * i) / n);
            if (d > 0.05 && d > worst) worst = d;
            if (d > 0.05) {
              straddling++;
              if (names.length < 6) {
                names.push(`plot at (${f.x.toFixed(0)}, ${f.z.toFixed(0)}) over an edge, ${d.toFixed(2)} m in`);
              }
              i = n + 1;
            }
          }
        }
      }
    }
  }
  return { ok: straddling === 0, plots: footprints.length, straddling, worstDepthM: worst, worst: names };
}

/** Distance test against every lane centreline, for keeping planting out of the road. */
function nearLane(lanes: readonly Lane[], x: number, z: number, pad: number): boolean {
  for (const l of lanes) {
    const lim = l.width * 0.5 + pad;
    for (let i = 0; i + 1 < l.path.length; i++) {
      const a = l.path[i];
      const b = l.path[i + 1];
      const ax = b.x - a.x;
      const az = b.z - a.z;
      const len2 = ax * ax + az * az;
      const t = len2 < 1e-6 ? 0 : clamp(((x - a.x) * ax + (z - a.z) * az) / len2, 0, 1);
      const dx = x - (a.x + ax * t);
      const dz = z - (a.z + az * t);
      if (dx * dx + dz * dz < lim * lim) return true;
    }
  }
  return false;
}

/**
 * The urban floor: the trodden ground the whole block stands on, out to the street lines.
 *
 * **The quilt was here, and it is worth being precise about what was wrong with it**, because
 * the obvious fix is to delete it and that is also wrong. The old version laid a 22 × 22 grid
 * of 25 m quads over each district *rectangle* and chose each cell's base colour from a hash
 * of its indices — basalt, dust or dirt, three unrelated tones. Adjacent cells had no
 * relationship to each other or to anything in the scene, and at 25 m a cell is about the size
 * of a house, so from the strategic camera it read as a chequerboard: *"not so much like
 * streets but a patched quilt"*.
 *
 * Deleting it is worse. The first attempt at this rebuild paved only the streets and the block
 * interiors, and the terrain's grass came through everywhere else — Rome as a set of terraces
 * standing in a meadow. A city has a floor.
 *
 * So: one base tone drifting between beaten earth and dust over a scale of two hundred metres,
 * ±7 % rather than ±22 %, from two incommensurate sinusoids instead of a hash — and now laid
 * **per face**, so the floor's own boundary is a street rather than a rectangle. That is the
 * part the rectangles could not do: the edge of the paving is the edge of the block.
 *
 * **This surface is the back of the block, and it has to be the darkest thing in the frame or
 * there is no street.** The hue was corrected once already, from three randomly-tinted tones
 * per cell to one smooth grey drift, on the strength of a blind critic's measurement that the
 * real plates are ~30 % achromatic while this was 1.2 %. The grey was right; the *value* was
 * not, and it is why the plan still read as a quilt afterwards. In an orthophoto of Rome the
 * light achromatic pixels are roofs, render and pavement — never the ground between buildings,
 * which is the darkest thing in the picture because it is a yard in the shade of a five-storey
 * insula. So the bright achromatic budget belongs to the travertine footways in `buildWays`,
 * which are continuous lines and therefore *draw* the network, and this is what it physically
 * is: beaten earth and ash between party walls, dark and warm.
 */
function buildBlockFloor(
  batch: Batch,
  b: CityBlock,
  heightAt: Ground,
  wallZAt: (x: number) => number
): void {
  if (b.urban < 0.08) return;
  const st = batch.s('stone');
  const F = b.frame;
  const ring = b.face.ring;
  const uv = ring.map((p) => ({ u: F.u(p.x, p.z), v: F.v(p.x, p.z) }));
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of uv) {
    if (p.u < u0) u0 = p.u;
    if (p.u > u1) u1 = p.u;
    if (p.v < v0) v0 = p.v;
    if (p.v > v1) v1 = p.v;
  }
  const STEP = 9;
  const nu = Math.max(1, Math.min(48, Math.round((u1 - u0) / STEP)));
  const nv = Math.max(1, Math.min(48, Math.round((v1 - v0) / STEP)));
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  const nrm = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  const seed = Rng.hashString(b.region.id) & 0xff;
  const ph1 = hash2(seed, 1, 0x71) * Math.PI * 2;
  const ph2 = hash2(seed, 2, 0x72) * Math.PI * 2;
  const inRing = (x: number, z: number): boolean => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if (ring[i].z > z !== ring[j].z > z) {
        const t = (z - ring[i].z) / (ring[j].z - ring[i].z);
        if (x < ring[i].x + t * (ring[j].x - ring[i].x)) inside = !inside;
      }
    }
    return inside;
  };
  const at = (u: number, v: number, out: THREE.Vector3): boolean => {
    const x = F.x(u, v);
    const z = F.z(u, v);
    out.set(x, heightAt(x, z) + 0.02, z);
    return z > wallZAt(x) + 8;
  };
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const ua = lerp(u0, u1, i / nu);
      const ub = lerp(u0, u1, (i + 1) / nu);
      const va = lerp(v0, v1, j / nv);
      const vb = lerp(v0, v1, (j + 1) / nv);
      const uc = (ua + ub) * 0.5;
      const vc = (va + vb) * 0.5;
      if (!inRing(F.x(uc, vc), F.z(uc, vc))) continue;
      if (!(at(ua, va, p0) && at(ub, va, p1) && at(ub, vb, p2) && at(ua, vb, p3))) continue;
      const w = clamp(
        0.5 +
          0.32 * Math.sin(uc * 0.031 + ph1) * Math.cos(vc * 0.027 + ph2) +
          0.18 * Math.sin(vc * 0.069 + ph2 * 1.7),
        0,
        1
      );
      c.copy(PAL.basalt).lerp(PAL.terraDirty, 0.16 + w * 0.26).multiplyScalar(0.58 + w * 0.16);
      // Toward the country it becomes the orchards and garden plots that actually ended a
      // Roman city, so the transition to ploughed field is a fade and not a seam.
      c.lerp(PAL.terraDirty, (1 - b.urban) * 0.62);
      st.quadN(nrm, p0, p1, p2, p3, c);
    }
  }
}

function paintColour(rng: Rng): THREE.Color {
  const base = rng.pickWeighted(
    [PAL.pompeianRed, PAL.ochre, PAL.limeWhite, PAL.ochreDeep, PAL.terraDirty, PAL.romanRed],
    [0.27, 0.26, 0.125, 0.15, 0.115, 0.08]
  );
  return new THREE.Color().copy(base).multiplyScalar(rng.range(0.78, 1.18));
}

function roofColour(rng: Rng): THREE.Color {
  const base = rng.pickWeighted([PAL.roofTile, PAL.roofTileOld, PAL.roofTileDark], [0.5, 0.34, 0.16]);
  return new THREE.Color().copy(base).multiplyScalar(rng.range(0.82, 1.16));
}

// ---------------------------------------------------------------------------
// One building
// ---------------------------------------------------------------------------

function buildBuilding(batch: Batch, detail: number, plot: Plot, d: Character, heightAt: Ground, rng: Rng): void {
  const g = heightAt(plot.x, plot.z);
  const m = new THREE.Matrix4().makeRotationY(plot.rot).setPosition(plot.x, 0, plot.z);
  const stucco = batch.s('stucco');
  const roof = batch.s('roof');
  const timber = detail >= 2 ? batch.s('timber') : null;
  const stone = detail >= 1 ? batch.s('stone') : null;
  // Through `pushAll`, which drops aliases. At far detail `collapseTo` makes `stucco` and
  // `roof` the *same* stream, so pushing per stream composed the placement matrix twice and
  // the whole quarter was drawn again at roughly double its coordinates. See
  // `Batch.distinct`.
  const keys: CityMatKey[] = ['stucco', 'roof'];
  if (timber) keys.push('timber');
  if (stone) keys.push('stone');
  const used = batch.pushAll(keys, m);

  const w = plot.hw * 2;
  const dep = plot.hd * 2;
  const area = w * dep;
  // Grand houses cluster on the outskirts, where the land was cheap enough for a garden.
  //
  // The area gate is 620 m², not 240. Under the BSP a plot was 18–32 m on its longest side
  // and 240 m² picked out the genuinely large ones; a block terrace hands this function
  // plots of 26 × 24 m as a matter of course, so the old threshold turned a third of Rome
  // into single-storey *domus* and the skyline went flat. A real *domus* in the middle of a
  // tenement quarter is a rarity — that is the whole point of one.
  const grand = rng.next() < d.grandeur + (1 - plot.edge) * 0.3 && area > 620;
  const tall = clamp(rng.int(d.minFloors - 1, d.maxFloors) + (rng.next() < 0.14 ? 1 : 0), 1, 6);
  // The last blocks are one and two storeys: nobody built a six-storey tenement facing
  // open fields, and the height ramp is what makes the city's edge read as a fade.
  const floors = grand ? Math.max(1, d.minFloors - 1) : Math.max(1, Math.round(tall * (0.44 + 0.56 * plot.edge)));

  if (detail === 0) {
    // Far silhouette: one prism and one roof plane. Everything the eye keeps at a
    // kilometre is the massing and the terracotta.
    const h = GROUND_H + STOREY_H * (floors - 1);
    box(stucco, -w / 2, g, -dep / 2, w / 2, g + h, dep / 2, paintColour(rng), { bottom: false });
    hipRoof(roof, w, dep, g + h, Math.min(w, dep) * 0.16, 0.4, roofColour(rng));
    batch.popAll(used);
    return;
  }

  if (grand) {
    buildDomus(batch, detail, w, dep, g, rng, stucco, roof, stone, timber);
    batch.popAll(used);
    return;
  }

  // Larger plots become a ring of wings round a light well — the *cavaedium* plan,
  // and from above the courtyards are what make the roofscape read as a city.
  const courtyard = plot.perimeter === true || (area > 300 && Math.min(w, dep) > 15 && rng.bool(0.55));
  const paint = paintColour(rng);
  const tile = roofColour(rng);

  if (courtyard) {
    // A whole block's range is deeper than one house's wing: a street front, a room and a
    // back stair is 11–16 m, which is what an Ostian insula measures front to light well.
    const wingW = plot.perimeter ? Math.min(rng.range(11, 16), Math.min(w, dep) * 0.34) : rng.range(5.5, 8.0);
    const wings: [number, number, number, number][] = [
      [-w / 2, -dep / 2, w / 2, -dep / 2 + wingW],
      [-w / 2, dep / 2 - wingW, w / 2, dep / 2],
      [-w / 2, -dep / 2 + wingW, -w / 2 + wingW, dep / 2 - wingW],
      [w / 2 - wingW, -dep / 2 + wingW, w / 2, dep / 2 - wingW],
    ];
    for (let k = 0; k < wings.length; k++) {
      const [x0, z0, x1, z1] = wings[k];
      if (x1 - x0 < 2.4 || z1 - z0 < 2.4) continue;
      const fl = clamp(floors + (hash2(k, Math.round(w), 55) < 0.3 ? -1 : 0), 1, 5);
      const front = k === 0 ? -1 : k === 1 ? 1 : 0;
      const form = k < 2 ? 'gable' : 'hip';
      /*
       * Which of this wing's faces are not street. The court is always enclosed; a side
       * wing's inner long face is the court and both its ends abut the two ranges. Ranges
       * 0 and 1 keep their short ends, because those are the block's own corners and a
       * corner insula is where a Roman city put its bar.
       */
      const wingEnclosed = k === 0
        ? FACE_Z1
        : k === 1
          ? FACE_Z0
          : k === 2
            ? FACE_X1 | FACE_Z0 | FACE_Z1
            : FACE_X0 | FACE_Z0 | FACE_Z1;
      if (!plot.perimeter) {
        buildWing(batch, detail, x0, z0, x1, z1, g, fl, paint, tile, rng, stucco, roof, timber, stone, front, wingEnclosed, form);
        continue;
      }
      /**
       * **Bays.** A block range built as one prism with one ridge is a warehouse, and from
       * above it is the giveaway that the mass is procedural: real frontage is a row of
       * properties that happen to share walls, so the ridge steps, the eaves height changes
       * every fifteen metres and no two bays are painted the same.
       *
       * Splitting here rather than inside `buildWing` keeps the *footprint* single — the
       * block is still one obstacle and one continuous wall to the street — while the
       * elevation is many. That is exactly the relationship a terrace has.
       */
      const alongX = x1 - x0 >= z1 - z0;
      const run = alongX ? x1 - x0 : z1 - z0;
      const bays = Math.max(1, Math.round(run / rng.range(13, 21)));
      let t0 = 0;
      for (let bi = 0; bi < bays; bi++) {
        // Uneven bay widths: a parcel boundary is not a division of the block by N.
        const t1 = bi === bays - 1 ? 1 : t0 + (1 - t0) / (bays - bi) * rng.range(0.78, 1.24);
        const a = Math.min(t1, 1);
        if (a - t0 < 0.04) continue;
        const bx0 = alongX ? lerp(x0, x1, t0) : x0;
        const bx1 = alongX ? lerp(x0, x1, a) : x1;
        const bz0 = alongX ? z0 : lerp(z0, z1, t0);
        const bz1 = alongX ? z1 : lerp(z0, z1, a);
        // Storey count walks by one between neighbours, so the roofline steps.
        const bf = clamp(fl + (rng.next() < 0.34 ? (rng.bool() ? 1 : -1) : 0), 1, 6);
        const bp = new THREE.Color().copy(paint).multiplyScalar(rng.range(0.86, 1.16));
        const bt = new THREE.Color().copy(tile).multiplyScalar(rng.range(0.9, 1.12));
        /*
         * A bay's joins with its neighbours are **party walls**, and that is the whole
         * difference between a terrace and a row of sheds. The run's own two ends keep
         * whatever the range had; every internal join is closed on both sides.
         */
        const joinLow = t0 > 0.001 ? (alongX ? FACE_X0 : FACE_Z0) : 0;
        const joinHigh = a < 0.999 ? (alongX ? FACE_X1 : FACE_Z1) : 0;
        buildWing(batch, detail, bx0, bz0, bx1, bz1, g, bf, bp, bt, rng, stucco, roof, timber, stone, front, wingEnclosed | joinLow | joinHigh, form);
        t0 = a;
        if (t0 >= 1) break;
      }
    }
    // The court itself: paved, with a cistern mouth and a vine. `stone` is already carrying
    // the placement transform from `used` above, so it must *not* be pushed again — the
    // earlier revision did, and every courtyard shed a stray basalt slab at `m²`.
    if (stone) {
      box(stone, -w / 2 + wingW, g + 0.06, -dep / 2 + wingW, w / 2 - wingW, g + 0.12, dep / 2 - wingW, PAL.basalt, { bottom: false });
    }
    if (detail >= 2 && stone) {
      cylinder(stone, 0, g + 0.1, 0, 0.7, 0.65, 0.85, 9, PAL.travertineDirty, { top: true });
    }
  } else {
    /*
     * A single-mass plot: shop front on `frontSide`, doors on every other face except the
     * ends `place` recorded as party walls with the plot packed beside it. Both long faces
     * are street — the back one faces the lane behind, which is where an insula's *fauces*
     * and its stair door actually were.
     */
    buildWing(batch, detail, -w / 2, -dep / 2, w / 2, dep / 2, g, floors, paint, tile, rng, stucco, roof, timber, stone, plot.frontSide, plot.abut);
  }

  batch.popAll(used);
}

/**
 * Which of a wing's four faces are **party walls or courtyard walls** rather than street
 * frontage, as a bitmask.
 *
 * This exists because the previous ground floor could only address one face — `front`, a
 * single long side — and every other face in the city was a blank painted wall by
 * construction. `VISUAL-RUBRIC.md` H7 has scored **zero on both maps for two passes** on
 * exactly that: *"a blank painted wall is the single most common tell of a generated city
 * and it is a 0."*
 *
 * The complement of "which face is the shop front" is not "which face is blank"; it is
 * "which face is *enclosed*". A terrace bay's ends are party walls and must stay blank —
 * that is what makes it a terrace — while its back elevation faces a lane and had doors,
 * stairs and a latrine window on it. A courtyard range's inner face is a light well. A
 * free-standing plot has four street faces and had openings on all of them. One bitmask
 * says all three, and the caller is the only code that knows.
 */
const FACE_Z0 = 1;
const FACE_Z1 = 2;
const FACE_X0 = 4;
const FACE_X1 = 8;

/**
 * **One face of a ground storey, drawn as an elevation with holes in it.**
 *
 * The wall box does not draw this face at all (see `buildWing`); this does, out of thin
 * boxes standing in the face plane, one per solid span and one per lintel head, with a dark
 * recess behind every opening. So an opening is an actual gap in the triangles of the wall
 * plane rather than a dark rectangle painted on it — which is what the eye reads at 1.6 m
 * and what `probe-eye.mjs` E5 counts.
 *
 * `axis` 0 means the face is perpendicular to z, 1 perpendicular to x; `s` is the outward
 * direction. `uA`/`uB` are the face's extent along its own run.
 */
function pierceElevation(
  st: GeoStream,
  uA: number,
  uB: number,
  cross: number,
  axis: 0 | 1,
  s: -1 | 1,
  yBot: number,
  yTop: number,
  wallCol: THREE.Color,
  dadoCol: THREE.Color,
  dark: THREE.Color,
  holes: { u0: number; u1: number; head: number }[],
): void {
  // The face's own slab: 60 mm of thickness so the outward quad has somewhere to be, drawn
  // inward so the elevation stands exactly on the plane the rest of the wall is on.
  const c0 = s > 0 ? cross - 0.06 : cross;
  const c1 = s > 0 ? cross : cross + 0.06;
  const only = axis === 0
    ? { top: false, bottom: false, xMin: false, xMax: false, zMin: s < 0, zMax: s > 0 }
    : { top: false, bottom: false, zMin: false, zMax: false, xMin: s < 0, xMax: s > 0 };
  /** A rectangle of wall between `a` and `b` along the run, from `y0` to `y1`. */
  const slab = (a: number, b: number, y0: number, y1: number, col: THREE.Color): void => {
    if (b - a < 0.04 || y1 - y0 < 0.04) return;
    if (axis === 0) box(st, a, y0, c0, b, y1, c1, col, only);
    else box(st, c0, y0, a, c1, y1, b, col, only);
  };
  // The splash-back dado survives on the piers, where a real one does: it is the band cart
  // wheels and rain off the eaves stain, and it stops at every doorway because a doorway is
  // where the wall stops.
  const DADO = Math.min(1.05, (yTop - yBot) * 0.3);
  const span = (a: number, b: number, y1: number): void => {
    slab(a, b, yBot, Math.min(yBot + DADO + 0.5, y1), dadoCol);
    slab(a, b, Math.min(yBot + DADO + 0.5, y1), y1, wallCol);
  };
  const sorted = holes.slice().sort((p, q) => p.u0 - q.u0);
  let cursor = uA;
  for (const hle of sorted) {
    const a = Math.max(uA, hle.u0);
    const b = Math.min(uB, hle.u1);
    if (b <= a) continue;
    span(cursor, a, yTop);
    // Over the opening.
    slab(a, b, Math.min(hle.head, yTop), yTop, wallCol);
    // The recess behind it: five faces, the outward one left open because that is the hole.
    const r0 = s > 0 ? cross - 0.44 : cross;
    const r1 = s > 0 ? cross : cross + 0.44;
    const rev = axis === 0
      ? { top: true, bottom: false, xMin: true, xMax: true, zMin: s > 0, zMax: s < 0 }
      : { top: true, bottom: false, zMin: true, zMax: true, xMin: s > 0, xMax: s < 0 };
    if (axis === 0) box(st, a, yBot, r0, b, Math.min(hle.head, yTop), r1, dark, rev);
    else box(st, r0, yBot, a, r1, Math.min(hle.head, yTop), b, dark, rev);
    cursor = b;
  }
  span(cursor, uB, yTop);
}

/**
 * A street door: a recess, a travertine lintel, jambs and a threshold slab.
 *
 * Roman insulae are entered off the street through a *fauces* about 1.2-1.5 m wide with a
 * travertine lintel over it, and every surviving Ostian block has a worn sill slab standing
 * proud of the wall at the foot of it. The sill is the cheapest of these four boxes and it
 * is the one that does the most work at 1.75 m, because it is the only part of a doorway
 * below a man's knee and therefore the only part he sees at a glancing angle down a street.
 *
 * The void is a dark recess and not a timber leaf, for the reason `carthage/fabric.ts`
 * gives for the same choice: a doorway that reads as a hole reads at every distance, and a
 * painted leaf reads as a rectangle of the wrong colour beyond about thirty metres.
 *
 * `axis` 0 means the face is perpendicular to z (a long face of a wing), 1 perpendicular to
 * x; `s` is the outward direction along that axis. Everything is in the wing's own local
 * frame, which is axis-aligned, so no transform is pushed.
 */
function streetDoor(
  stone: GeoStream | null,
  detail: number,
  cu: number,
  cross: number,
  g: number,
  axis: 0 | 1,
  s: -1 | 1,
  dw: number,
  dh: number,
): void {
  const hw = dw / 2;
  // The hole itself is `pierceElevation`'s; this is only the dressing round it, so this
  // function no longer touches the `stucco` stream at all. The first draft drew the opening
  // here as a dark box standing 20 mm PROUD of the wall, which is a rectangle painted on a
  // façade rather than a way into a building, and `probe-eye.mjs` E5 scored it as wall —
  // correctly.
  if (detail < 1 || !stone) return;
  // Lintel: one travertine block bridging the opening, proud of the render by 90 mm.
  const l0 = cross + s * 0.09;
  const l1 = cross - s * 0.09;
  if (axis === 0) {
    box(stone, cu - hw - 0.16, g + dh, Math.min(l0, l1), cu + hw + 0.16, g + dh + 0.18, Math.max(l0, l1), PAL.travertine);
  } else {
    box(stone, Math.min(l0, l1), g + dh, cu - hw - 0.16, Math.max(l0, l1), g + dh + 0.18, cu + hw + 0.16, PAL.travertine);
  }
  if (detail < 2) return;
  // Jambs and the worn threshold. Detail 2 only: these are 40-90 mm features and at the
  // distance the mid tier switches in they are below a pixel.
  const j0 = cross + s * 0.06;
  const j1 = cross - s * 0.06;
  const t0 = cross + s * 0.34;
  const t1 = cross - s * 0.02;
  for (const side of [-1, 1]) {
    const jc = cu + side * (hw + 0.08);
    if (axis === 0) {
      box(stone, jc - 0.08, g, Math.min(j0, j1), jc + 0.08, g + dh, Math.max(j0, j1), PAL.travertine);
    } else {
      box(stone, Math.min(j0, j1), g, jc - 0.08, Math.max(j0, j1), g + dh, jc + 0.08, PAL.travertine);
    }
  }
  if (axis === 0) {
    box(stone, cu - hw - 0.12, g - 0.06, Math.min(t0, t1), cu + hw + 0.12, g + 0.12, Math.max(t0, t1), PAL.travertineDirty, { bottom: false });
  } else {
    box(stone, Math.min(t0, t1), g - 0.06, cu - hw - 0.12, Math.max(t0, t1), g + 0.12, cu + hw + 0.12, PAL.travertineDirty, { bottom: false });
  }
}

/**
 * One block of building: storeys, string courses, windows, shutters, balcony,
 * ground-floor tabernae, and a roof. `front` selects which long side gets the shop
 * fronts and balcony (0 = neither, for internal courtyard wings).
 */
function buildWing(
  batch: Batch,
  detail: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  g: number,
  floors: number,
  paint: THREE.Color,
  tile: THREE.Color,
  rng: Rng,
  stucco: GeoStream,
  roof: GeoStream,
  timber: GeoStream | null,
  stone: GeoStream | null,
  front: number,
  /** Bitmask of `FACE_*`: which faces are party walls or light wells, not street. */
  enclosed: number,
  roofOverride?: 'hip' | 'gable' | 'terrace'
): void {
  const w = x1 - x0;
  const dep = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;

  // Every random choice is drawn here, before any `detail` branch. A level-of-detail
  // swap must not change a building's roof form or storey height, and it would if the
  // number of draws taken from the stream depended on the detail level.
  const P = {
    groundH: GROUND_H * rng.range(0.92, 1.1),
    storeyH: STOREY_H * rng.range(0.94, 1.08),
    bareGround: rng.bool(0.4),
    groundTone: rng.range(0.7, 0.92),
    tabernaBay: rng.range(3.4, 4.6),
    /*
     * Spacing of doors on the faces that are not the shop front. Ostia's back lanes run a
     * *fauces* or a stair door every six to ten metres, which is one per property; wider
     * than that and a block reads as a warehouse, narrower and it reads as a cloister.
     * Drawn here with every other random choice, before any `detail` branch, because a LOD
     * swap must not change how many draws come off the stream.
     */
    doorPitch: rng.range(6.2, 9.6),
    doorH: rng.range(2.25, 2.62),
    windowPitchX: rng.range(2.6, 3.6),
    windowPitchZ: rng.range(2.6, 3.6),
    balcony: rng.bool(0.5),
    balconyFloor: rng.int(1, 3),
    balconyProj: rng.range(0.9, 1.5),
    balconyFrac: rng.range(0.5, 0.9),
    roofKind: rng.pickWeighted(['hip', 'gable', 'terrace'] as const, [0.5, 0.28, 0.22]),
    gablePitch: rng.range(0.2, 0.3),
    overhang: rng.range(0.35, 0.7),
    hipRise: rng.range(0.14, 0.21),
    chimney: rng.bool(0.35),
    chimneyU: rng.next(),
    chimneyV: rng.next(),
    chimneyH: rng.range(1.1, 2.0),
  };
  const groundH = P.groundH;
  const storeyH = P.storeyH;
  const top = g + groundH + storeyH * (floors - 1);
  const dark = new THREE.Color(0.022, 0.02, 0.017);

  /*
   * ---- which faces the street can see, decided BEFORE the wall is drawn -----
   *
   * **This ordering is the whole of the H7 fix and it is worth stating plainly.** The wall
   * box below used to be drawn solid on all four sides and the arcade laid *on top of it*,
   * so `archPanel`'s 0.55 m reveal opened onto the ground storey's own painted face 40 mm
   * behind. Every taberna in Rome was **blind arcading**: an arched niche in a solid wall.
   * That is why the ground judge scored H7 zero twice while `CITY-GROUND-JUDGE.md` §3 could
   * truthfully say *"the generator models arched tabernae (fabric.ts:1200)"* — the code was
   * there and the hole was not, which is `VISUAL-RUBRIC.md`'s critic instruction 5 exactly.
   *
   * So the street faces are worked out first, the wall box is drawn with those faces
   * **omitted**, and each of them is then rebuilt as a pierced elevation with real holes in
   * it. `tools/probe-eye.mjs` E5 is written to see the difference: it counts triangles lying
   * *in* the wall plane and calls the gaps openings, so a painted-on door scores nothing.
   */
  const shopFace = front < 0 ? FACE_Z0 : front > 0 ? FACE_Z1 : 0;
  const wingFaces: [number, 0 | 1, number, number, -1 | 1][] = [
    [FACE_Z0, 0, z0, w, -1],
    [FACE_Z1, 0, z1, w, 1],
    [FACE_X0, 1, x0, dep, -1],
    [FACE_X1, 1, x1, dep, 1],
  ];
  /** Faces this wing will rebuild as pierced elevations, so the box must not draw them. */
  const pierced = detail >= 1
    ? wingFaces.filter(([bit, , , run]) => !(enclosed & bit) && run >= 3.6).map(([bit]) => bit)
    : [];
  const drawn = (bit: number) => !pierced.includes(bit);

  // Ground storey: often left as bare brick or a darker render, as at Ostia.
  const groundPaint = new THREE.Color().copy(P.bareGround ? PAL.terraDirty : paint).multiplyScalar(P.groundTone);
  box(stucco, x0, g - 0.6, z0, x1, g + groundH, z1, groundPaint, {
    groundShade: 0.24,
    zMin: drawn(FACE_Z0),
    zMax: drawn(FACE_Z1),
    xMin: drawn(FACE_X0),
    xMax: drawn(FACE_X1),
  });
  // Splash-back dado. `groundShade` ramps the whole storey, which over four metres reads as
  // a soft vignette rather than as dirt; the line where cart wheels, rain off the eaves and
  // a public street actually stain a façade is a crisp band about a metre up, and every
  // surviving Ostian frontage has one. Proud of the wall by 40 mm so it reads in section
  // as well as in tone.
  const dado = new THREE.Color().copy(groundPaint).multiplyScalar(0.62).lerp(PAL.dust, 0.22);
  // ...on the faces that are still solid walls. A pierced elevation carries its own dado
  // between its own piers, and a band drawn straight across a doorway is the thing this
  // whole block is trying to stop.
  box(stucco, x0 - 0.04, g - 0.5, z0 - 0.04, x1 + 0.04, g + 1.05, z1 + 0.04, dado, {
    bottom: false,
    top: false,
    groundShade: 0.26,
    zMin: drawn(FACE_Z0),
    zMax: drawn(FACE_Z1),
    xMin: drawn(FACE_X0),
    xMax: drawn(FACE_X1),
  });
  // Upper storeys, each a fraction lighter than the one below (rain-washed).
  for (let f = 1; f < floors; f++) {
    const y0 = g + groundH + storeyH * (f - 1);
    const c = new THREE.Color().copy(paint).multiplyScalar(0.94 + f * 0.035);
    box(stucco, x0, y0, z0, x1, y0 + storeyH, z1, c, { bottom: false, top: false });
    // String course marking the floor line.
    if (detail >= 1) {
      box(stucco, x0 - 0.14, y0 - 0.16, z0 - 0.14, x1 + 0.14, y0, z1 + 0.14, new THREE.Color().copy(paint).multiplyScalar(1.2), {
        bottom: false,
      });
    }
  }

  /*
   * ---- the ground floor ---------------------------------------------------
   *
   * **Every face a street can see gets something below three metres.** This block used to
   * be `if (front !== 0 && w > 6) tabernae; else one 1.5 m dark box at z0`, which addressed
   * at most **one of four faces** and put the fallback door on the *inside* of every
   * courtyard side wing. So three insula faces in four were blank by construction — the
   * ground judge said exactly that (`CITY-GROUND-JUDGE.md` G7) and H7 has been a zero for
   * two passes on both maps.
   *
   * The rule now: the shop front is `front` where there is one; every other face that is
   * not a party wall or a light well gets doors. That is also what the archaeology shows.
   * Ostia's blocks carry tabernae on the main street and a *fauces*, a stair door and a
   * latrine window on the back lane, and nothing at all on the party walls — which is why
   * this is a mask of *enclosure* rather than a second `front`.
   */
  if (detail >= 1) {
    for (const [bit, axis, cross, run, s] of wingFaces) {
      if (!pierced.includes(bit)) continue;
      const uA = axis === 0 ? x0 : z0;
      const uB = axis === 0 ? x1 : z1;
      if (bit === shopFace && run > 6) {
        // ---- tabernae: wide arched shop fronts on the principal street ------
        const bays = Math.max(1, Math.floor(run / P.tabernaBay));
        const bw = run / bays;
        const zf = cross;
        /*
         * The back of the shop, 0.55 m in — the depth `archPanel`'s reveal already runs to.
         * Without it the arch opens on nothing and the building is hollow from the street.
         * One box per face, five faces, two of which the piers hide.
         */
        const b0 = s > 0 ? zf - 0.60 : zf + 0.55;
        const b1 = s > 0 ? zf - 0.55 : zf + 0.60;
        const shopDark = new THREE.Color().copy(groundPaint).multiplyScalar(0.20);
        if (axis === 0) box(stucco, uA, g - 0.6, Math.min(b0, b1), uB, g + groundH, Math.max(b0, b1), shopDark, { top: false, bottom: false });
        else box(stucco, Math.min(b0, b1), g - 0.6, uA, Math.max(b0, b1), g + groundH, uB, shopDark, { top: false, bottom: false });
        // The plinth below the arcade's springing level, which `archPanel` starts above.
        const p0 = s > 0 ? zf - 0.08 : zf;
        const p1 = s > 0 ? zf : zf + 0.08;
        if (axis === 0) box(stucco, uA, g - 0.6, Math.min(p0, p1), uB, g, Math.max(p0, p1), groundPaint, { top: false, bottom: false });
        else box(stucco, Math.min(p0, p1), g - 0.6, uA, Math.max(p0, p1), g, uB, groundPaint, { top: false, bottom: false });
        for (let i = 0; i < bays; i++) {
          const bxp = uA + bw * (i + 0.5);
          /*
           * Rotation: `archPanel`'s front face looks toward local −Z, so `rotY(0)` addresses
           * a −z face, π a +z face, +π/2 a −x face and −π/2 a +x face.
           */
          const yaw = axis === 0 ? (s < 0 ? 0 : Math.PI) : (s < 0 ? Math.PI / 2 : -Math.PI / 2);
          const px = axis === 0 ? bxp : zf;
          const pz = axis === 0 ? zf : bxp;
          stucco.push(new THREE.Matrix4().makeRotationY(yaw).setPosition(px, g, pz));
          archPanel(stucco, bw + 0.02, groundH, groundPaint, {
            depth: 0.55,
            spring: groundH * 0.56,
            openWidth: bw * (0.5 + hash2(i, Math.round(run * 4), 401) * 0.18),
            segments: detail >= 2 ? 7 : 4,
            voidCol: dark,
          });
          stucco.pop();
          /*
           * The shop's own threshold. A taberna opened over a single travertine sill with a
           * grooved slot for the shutter boards, and every surviving one is worn into a
           * dish. It is the only part of a shop front at a soldier's boot rather than over
           * his head, so it is the part he sees down a street at a glancing angle, and it
           * costs one box.
           */
          if (detail >= 2 && stone) {
            const ow = bw * 0.5;
            const t0 = axis === 0 ? zf + s * 0.42 : zf + s * 0.42;
            const t1 = axis === 0 ? zf - s * 0.06 : zf - s * 0.06;
            if (axis === 0) box(stone, bxp - ow, g - 0.06, Math.min(t0, t1), bxp + ow, g + 0.13, Math.max(t0, t1), PAL.travertineDirty, { bottom: false });
            else box(stone, Math.min(t0, t1), g - 0.06, bxp - ow, Math.max(t0, t1), g + 0.13, bxp + ow, PAL.travertineDirty, { bottom: false });
          }
          // Cloth awning over every other shop — the top face is what the camera sees.
          if (detail >= 2 && axis === 0 && hash2(i, Math.round(cx * 3), 907) > 0.55) {
            const aw = bw * 0.8;
            const proj = 1.2 + hash2(i, Math.round(cz * 3), 331) * 0.8;
            const yTop = g + groundH * 0.86;
            const q0 = new THREE.Vector3(bxp - aw / 2, yTop, zf + s * 0.1);
            const q1 = new THREE.Vector3(bxp + aw / 2, yTop, zf + s * 0.1);
            const q2 = new THREE.Vector3(bxp + aw / 2, yTop - 0.75, zf + s * proj);
            const q3 = new THREE.Vector3(bxp - aw / 2, yTop - 0.75, zf + s * proj);
            NRM_UP.set(0, 1, 0);
            const cloth = [PAL.limeWhite, PAL.ochrePale, PAL.pompeianRed][Math.floor(hash2(i, Math.round(cx), 71) * 3)];
            stucco.quadN(NRM_UP, q0, q1, q2, q3, new THREE.Color().copy(cloth).multiplyScalar(1.1));
            if (timber) {
              cylinderBetween(timber, bxp - aw / 2, yTop - 0.75, zf + s * proj, bxp + aw / 2, yTop - 0.75, zf + s * proj, 0.05, PAL.timber, 4);
            }
          }
        }
        continue;
      }
      // ---- every other street face: doors onto the lane ---------------------
      const doors = Math.max(1, Math.round(run / P.doorPitch));
      const step = run / doors;
      const holes: { u0: number; u1: number; head: number }[] = [];
      for (let i = 0; i < doors; i++) {
        // Jittered off centre, because a door is where a stair or a corridor is and not at
        // the midpoint of a bay. Hashed on the face, so two faces of one wing differ.
        const j = (hash2(i * 13 + bit, Math.round((cx + cz) * 3), 733) - 0.5) * step * 0.34;
        const cu = uA + step * (i + 0.5) + j;
        const dw = 1.15 + hash2(i, Math.round(run * 5) + bit, 199) * 0.5;
        if (cu - dw / 2 - uA < 0.7 || uB - (cu + dw / 2) < 0.7) continue;
        holes.push({ u0: cu - dw / 2, u1: cu + dw / 2, head: g + P.doorH });
        streetDoor(stone, detail, cu, cross, g, axis, s, dw, P.doorH);
      }
      pierceElevation(stucco, uA, uB, cross, axis, s, g - 0.6, g + groundH, groundPaint, dado, dark, holes);
    }
  }

  // ---- windows -------------------------------------------------------------
  if (detail >= 1) {
    const perFloorX = Math.max(1, Math.floor(w / P.windowPitchX));
    const perFloorZ = Math.max(1, Math.floor(dep / P.windowPitchZ));
    for (let f = 1; f < floors; f++) {
      const y = g + groundH + storeyH * (f - 1) + storeyH * 0.34;
      const wh = storeyH * 0.36;
      const ww = 0.62;
      for (let i = 0; i < perFloorX; i++) {
        const px = lerp(x0 + 1.3, x1 - 1.3, perFloorX === 1 ? 0.5 : i / (perFloorX - 1));
        for (const zz of [z0, z1]) {
          if (hash2(i * 11 + f * 7, Math.round(px * 3), 61) < 0.3) continue;
          const s = zz === z0 ? -1 : 1;
          box(stucco, px - ww / 2, y, zz + s * 0.02, px + ww / 2, y + wh, zz - s * 0.14, dark);
          // Lintel and sill in travertine.
          if (detail >= 2 && stone) {
            box(stone, px - ww / 2 - 0.12, y + wh, zz + s * 0.06, px + ww / 2 + 0.12, y + wh + 0.13, zz - s * 0.06, PAL.travertine);
            box(stone, px - ww / 2 - 0.12, y - 0.1, zz + s * 0.1, px + ww / 2 + 0.12, y, zz - s * 0.02, PAL.travertine);
          }
          // Shutters: a leaf folded back against the wall on one side.
          if (timber && hash2(i * 3 + f, Math.round(px), 19) > 0.55) {
            box(timber, px + ww / 2, y, zz + s * 0.06, px + ww / 2 + 0.42, y + wh, zz + s * 0.14, PAL.timberDark);
          }
        }
      }
      for (let i = 0; i < perFloorZ; i++) {
        const pz = lerp(z0 + 1.3, z1 - 1.3, perFloorZ === 1 ? 0.5 : i / (perFloorZ - 1));
        for (const xx of [x0, x1]) {
          if (hash2(i * 13 + f * 5, Math.round(pz * 3), 71) < 0.42) continue;
          const s = xx === x0 ? -1 : 1;
          box(stucco, xx + s * 0.02, y, pz - ww / 2, xx - s * 0.14, y + wh, pz + ww / 2, dark);
        }
      }
    }
  }

  // ---- balcony (*maenianum*) ----------------------------------------------
  if (front !== 0 && floors >= 3 && detail >= 1 && P.balcony) {
    const f = Math.min(P.balconyFloor, Math.max(1, floors - 2));
    const y = g + groundH + storeyH * (f - 1) + storeyH * 0.02;
    const s = front < 0 ? -1 : 1;
    const zf = front < 0 ? z0 : z1;
    const proj = P.balconyProj;
    const bw = w * P.balconyFrac;
    box(stucco, cx - bw / 2, y, Math.min(zf, zf + s * proj), cx + bw / 2, y + 0.22, Math.max(zf, zf + s * proj), new THREE.Color().copy(paint).multiplyScalar(1.14));
    if (timber) {
      const rails = Math.max(3, Math.round(bw / 0.5));
      for (let i = 0; i <= rails; i++) {
        const px = lerp(cx - bw / 2, cx + bw / 2, i / rails);
        cylinder(timber, px, y + 0.22, zf + s * proj, 0.045, 0.04, 0.95, 4, PAL.timber);
      }
      cylinderBetween(timber, cx - bw / 2, y + 1.15, zf + s * proj, cx + bw / 2, y + 1.15, zf + s * proj, 0.055, PAL.timberDark, 4);
      // Corbels under the slab.
      for (let i = 0; i < 3; i++) {
        const px = lerp(cx - bw / 2 + 0.4, cx + bw / 2 - 0.4, i / 2);
        cylinderBetween(timber, px, y, zf, px, y - 0.5, zf + s * proj, 0.07, PAL.timberDark, 4);
      }
    }
  }

  // Baked eaves shadow: the façades the camera sees are backlit, so without a dark
  // band under the overhang a wall and its roof merge into one silhouette.
  if (detail >= 1) {
    box(stucco, x0 - 0.03, top - 0.42, z0 - 0.03, x1 + 0.03, top, z1 + 0.03, new THREE.Color().copy(paint).multiplyScalar(0.42), {
      bottom: false,
      top: false,
    });
  }

  // ---- roof ---------------------------------------------------------------
  const roofKind = roofOverride ?? P.roofKind;
  roof.pushTranslate(cx, 0, cz);
  stucco.pushTranslate(cx, 0, cz);
  if (roofKind === 'terrace') {
    // Flat roof terrace with a parapet, planters and a vine pergola — very Roman,
    // and the variety it gives the roofscape from above is worth the triangles.
    const par = 0.85;
    box(stucco, -w / 2, top, -dep / 2, w / 2, top + 0.12, dep / 2, PAL.dust, { bottom: false });
    for (const [ax, az, bx, bz] of [
      [-w / 2, -dep / 2, w / 2, -dep / 2 + 0.28],
      [-w / 2, dep / 2 - 0.28, w / 2, dep / 2],
      [-w / 2, -dep / 2, -w / 2 + 0.28, dep / 2],
      [w / 2 - 0.28, -dep / 2, w / 2, dep / 2],
    ] as const) {
      box(stucco, ax, top, az, bx, top + par, bz, new THREE.Color().copy(paint).multiplyScalar(1.08), { bottom: false });
    }
    if (timber && Math.min(w, dep) > 9 && P.chimney) {
      const pw = Math.min(w - 4, 3.6);
      const pd = Math.min(dep - 4, 2.8);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          cylinder(timber, (sx * pw) / 2, top + 0.12, (sz * pd) / 2, 0.07, 0.06, 2.3, 4, PAL.timber);
        }
      }
      for (let i = 0; i < 5; i++) {
        const px = lerp(-pw / 2, pw / 2, i / 4);
        cylinderBetween(timber, px, top + 2.4, -pd / 2, px, top + 2.4, pd / 2, 0.045, PAL.timberDark, 4);
      }
      // Vine over the pergola. Kept in the timber stream rather than the foliage one
      // so a district never pays a draw call for a handful of leaves.
      box(timber, -pw / 2, top + 2.4, -pd / 2, pw / 2, top + 2.7, pd / 2, PAL.vine, { bottom: false });
    }
  } else if (roofKind === 'gable') {
    const pitch = P.gablePitch;
    const alongX = w >= dep;
    const rh = (alongX ? dep : w) * 0.5 * pitch * 2;
    gableRoof(stucco, roof, w, dep, top, rh, P.overhang, tile, alongX);
    if (detail >= 2) {
      // Ridge tiles.
      const rl = alongX ? w : dep;
      const rc = new THREE.Color().copy(tile).multiplyScalar(1.16);
      if (alongX) box(roof, -rl / 2, top + rh - 0.06, -0.14, rl / 2, top + rh + 0.12, 0.14, rc, { bottom: false });
      else box(roof, -0.14, top + rh - 0.06, -rl / 2, 0.14, top + rh + 0.12, rl / 2, rc, { bottom: false });
    }
  } else {
    const rh = Math.min(w, dep) * P.hipRise;
    hipRoof(roof, w, dep, top, rh, P.overhang, tile);
    if (detail >= 2) {
      const rc = new THREE.Color().copy(tile).multiplyScalar(1.16);
      const alongX = w >= dep;
      const half = Math.max(0.2, alongX ? w / 2 - dep / 2 : dep / 2 - w / 2);
      if (alongX) box(roof, -half, top + rh - 0.06, -0.14, half, top + rh + 0.12, 0.14, rc, { bottom: false });
      else box(roof, -0.14, top + rh - 0.06, -half, 0.14, top + rh + 0.12, half, rc, { bottom: false });
    }
  }
  // A vent or chimney stack — bakeries and heated rooms had them, and they break up
  // an otherwise unbroken field of tile.
  if (detail >= 2 && P.chimney) {
    const px = lerp(-w / 2 + 1.2, w / 2 - 1.2, P.chimneyU);
    const pz = lerp(-dep / 2 + 1.2, dep / 2 - 1.2, P.chimneyV);
    box(stucco, px - 0.32, top, pz - 0.32, px + 0.32, top + P.chimneyH, pz + 0.32, PAL.terraDirty, { bottom: false });
  }
  roof.pop();
  stucco.pop();
}

const NRM_UP = new THREE.Vector3(0, 1, 0);

/** A *domus*: low, wide, ranged round a colonnaded peristyle with a pool. */
function buildDomus(
  batch: Batch,
  detail: number,
  w: number,
  dep: number,
  g: number,
  rng: Rng,
  stucco: GeoStream,
  roof: GeoStream,
  stone: GeoStream | null,
  timber: GeoStream | null
): void {
  const paint = paintColour(rng);
  const tile = roofColour(rng);
  const h = GROUND_H + (rng.bool(0.4) ? STOREY_H : 0);
  const wingW = Math.min(7.5, Math.min(w, dep) * 0.3);

  const wings: [number, number, number, number][] = [
    [-w / 2, -dep / 2, w / 2, -dep / 2 + wingW],
    [-w / 2, dep / 2 - wingW, w / 2, dep / 2],
    [-w / 2, -dep / 2 + wingW, -w / 2 + wingW, dep / 2 - wingW],
    [w / 2 - wingW, -dep / 2 + wingW, w / 2, dep / 2 - wingW],
  ];
  for (const [x0, z0, x1, z1] of wings) {
    if (x1 - x0 < 2 || z1 - z0 < 2) continue;
    box(stucco, x0, g - 0.5, z0, x1, g + h, z1, paint, { groundShade: 0.2 });
    roof.pushTranslate((x0 + x1) / 2, 0, (z0 + z1) / 2);
    hipRoof(roof, x1 - x0 + 1.2, z1 - z0 + 1.2, g + h, Math.min(x1 - x0, z1 - z0) * 0.2, 0.7, tile);
    roof.pop();
  }
  // Peristyle: paved court, colonnade and an *impluvium* pool.
  const cw = w - wingW * 2;
  const cd = dep - wingW * 2;
  box(batch.s('stone'), -cw / 2, g + 0.06, -cd / 2, cw / 2, g + 0.14, cd / 2, PAL.marbleShadow, { bottom: false });
  if (stone && cw > 5 && cd > 5) {
    const nx = Math.max(2, Math.round(cw / 3.0));
    const nz = Math.max(2, Math.round(cd / 3.0));
    for (let i = 0; i <= nx; i++) {
      const px = lerp(-cw / 2 + 0.5, cw / 2 - 0.5, i / nx);
      column(stone, px, g + 0.14, -cd / 2 + 0.5, 0.24, 3.4, 'corinthian', PAL.marble, detail - 1);
      column(stone, px, g + 0.14, cd / 2 - 0.5, 0.24, 3.4, 'corinthian', PAL.marble, detail - 1);
    }
    for (let i = 1; i < nz; i++) {
      const pz = lerp(-cd / 2 + 0.5, cd / 2 - 0.5, i / nz);
      column(stone, -cw / 2 + 0.5, g + 0.14, pz, 0.24, 3.4, 'corinthian', PAL.marble, detail - 1);
      column(stone, cw / 2 - 0.5, g + 0.14, pz, 0.24, 3.4, 'corinthian', PAL.marble, detail - 1);
    }
    box(stone, -cw / 2 + 0.2, g + 3.6, -cd / 2 + 0.2, cw / 2 - 0.2, g + 4.1, cd / 2 - 0.2, PAL.marble, { bottom: false });
    // Pool.
    box(stone, -cw * 0.22, g + 0.1, -cd * 0.22, cw * 0.22, g + 0.32, cd * 0.22, PAL.marbleShadow, { bottom: false });
    box(stone, -cw * 0.19, g + 0.1, -cd * 0.19, cw * 0.19, g + 0.24, cd * 0.19, new THREE.Color(0.1, 0.2, 0.24), { bottom: false });
  }
}

// ---------------------------------------------------------------------------
// Streets
// ---------------------------------------------------------------------------

/**
 * The whole street network as terrain-following ribbons.
 *
 * A Roman street in section is not a flat strip. The carriageway is polygonal basalt
 * setts, heavily cambered because it carries the storm water; the *crepidines* either side
 * are raised travertine footways 0.3–0.5 m above it; and the kerb between them is a line of
 * dressed blocks. Every surviving street at Pompeii and Ostia has all three, and the reason
 * it matters here is that **the section is what makes the plan read as a street**. A flat
 * quad of dark colour on the ground is a stain. A crowned carriageway between two pale
 * raised edges is a road, from a kilometre up as well as from head height, because the kerb
 * line is a continuous highlight that traces the route through the fabric.
 *
 * Cost: the network is about 21 km of way, which at one 11 m cell per side comes to roughly
 * 150 k triangles in two streams — `road` for the surfaces and `stone` for the colonnades.
 * Two draw calls for every paved surface in the city.
 */
function buildWays(batch: Batch, detail: number, heightAt: Ground, lanes: readonly Lane[]): void {
  const st = batch.s('road');
  const trim = detail >= 1 ? batch.s('stone') : null;
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  const nrm = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();

  const all: { path: readonly { x: number; z: number }[]; width: number; cls: WayClass; paved: boolean; portico: boolean }[] = [];
  for (const w of WAYS) all.push({ path: w.path, width: w.width, cls: w.cls, paved: w.paved, portico: w.porticoed === true });
  for (const l of lanes) all.push({ path: l.path, width: l.width, cls: l.cls, paved: l.cls !== 'vicus', portico: false });

  let salt = 0;
  for (const way of all) {
    salt++;
    /**
     * **Every rank gets a footway, and that is the single change that makes the network
     * legible from above.**
     *
     * A *vicus* used to be all carriageway on the argument that Pompeii's narrowest streets
     * have no pavement. True of the narrowest ones, and beside the point here: the lanes are
     * the overwhelming majority of the network by length, so denying them a kerb left the
     * whole fabric of the city with no drawn line through it and only the handful of named
     * viae reading as streets at all. Pompeii's ordinary *vici* do have raised *crepidines*,
     * usually about a Roman foot wide, and a foot of travertine is exactly the continuous
     * bright thread a plan view needs.
     *
     * Footways therefore scale with rank but never vanish: 0.9 m on an 8 m lane, 2.0 m on a
     * 14 m local, up to 3.4 m on a 42 m artery.
     */
    const foot = clamp(way.width * 0.115, 0.9, 3.4);
    const road = way.width * 0.5 - foot;
    const kerbH = way.cls === 'vicus' ? 0.2 : 0.34;
    // Camber: the crown stands proud of the gutter. Only worth the extra strip on the
    // wide ways, where the eye can actually read the curve.
    const crown = detail >= 1 && road > 6 ? 0.14 : 0;

    for (let s = 0; s + 1 < way.path.length; s++) {
      const a = way.path[s];
      const b = way.path[s + 1];
      const len = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z));
      if (len < 0.5) continue;
      const n = Math.max(1, Math.round(len / (detail >= 1 ? 11 : 30)));
      const dx = (b.x - a.x) / len;
      const dz = (b.z - a.z) / len;
      const nx = -dz;
      const nz = dx;

      for (let i = 0; i < n; i++) {
        const ax = lerp(a.x, b.x, i / n);
        const az = lerp(a.z, b.z, i / n);
        const bx = lerp(a.x, b.x, (i + 1) / n);
        const bz = lerp(a.z, b.z, (i + 1) / n);
        // A way keeps its reservation where a monument stands on it — that ground is spoken
        // for either way and giving the reservation up necks the corridor shut on both sides
        // — but it must not *pave* the temple floor. See `onMonument`.
        if (onMonument((ax + bx) * 0.5, (az + bz) * 0.5)) continue;
        // Setts vary stone to stone; the variation is what stops a long road reading as
        // one plate of colour. Kept tight — this is one material, not three.
        const tone = 0.88 + hash2(i, salt, 33) * 0.26;
        // Polygonal basalt setts, lifted most of the way to peperino. Raw `basalt` is
        // 0x413f39, which is right for wet selce in shadow and reads as tar from a strategic
        // camera — a black ribbon, not a road. The lift has to be judged against what is
        // *beside* it, and what is beside it is now the dark beaten ground of the block
        // interiors rather than a pale paved floor, so the carriageway can be a clean mid
        // grey: brighter than the yards it separates, darker and cooler than the tile.
        c.copy(PAL.basalt).lerp(PAL.peperino, 0.62).multiplyScalar(tone);
        if (!way.paved) c.copy(PAL.dust).multiplyScalar(tone);

        const surf = (o0: number, o1: number, y0: number, y1: number): void => {
          p0.set(ax + nx * o0, heightAt(ax + nx * o0, az + nz * o0) + y0, az + nz * o0);
          p1.set(bx + nx * o0, heightAt(bx + nx * o0, bz + nz * o0) + y0, bz + nz * o0);
          p2.set(bx + nx * o1, heightAt(bx + nx * o1, bz + nz * o1) + y1, bz + nz * o1);
          p3.set(ax + nx * o1, heightAt(ax + nx * o1, az + nz * o1) + y1, az + nz * o1);
          st.quadN(nrm, p0, p1, p2, p3, c);
        };
        if (crown > 0) {
          surf(-road, 0, 0.06, 0.06 + crown);
          surf(0, road, 0.06 + crown, 0.06);
        } else {
          surf(-road, road, 0.07, 0.07);
        }

        if (foot > 0 && detail >= 1) {
          const g = heightAt(ax, az);
          for (const side of [-1, 1]) {
            const o0 = road * side;
            const o1 = (road + foot) * side;
            // Raised footway, in travertine rather than basalt.
            p0.set(ax + nx * o0, g + kerbH, az + nz * o0);
            p1.set(bx + nx * o0, heightAt(bx, bz) + kerbH, bz + nz * o0);
            p2.set(bx + nx * o1, heightAt(bx + nx * o1, bz + nz * o1) + kerbH, bz + nz * o1);
            p3.set(ax + nx * o1, heightAt(ax + nx * o1, az + nz * o1) + kerbH, az + nz * o1);
            // The bright edge. Travertine rather than travertineDirty: the footway is the
            // only near-white surface in the city and it is what draws the street line.
            st.quadN(nrm, p0, p1, p2, p3, PAL.travertine);
            // The kerb face. This is the line that reads from the air.
            quadPrism(
              st, ax + nx * o0, az + nz * o0, bx + nx * o0, bz + nz * o0,
              nx * side, nz * side, 0.14, g - 0.1, g + kerbH,
              PAL.peperino, PAL.travertineDirty, { ends: false, top: false }
            );
          }
        }
      }

      // Colonnades on the processional ways. Rome's Via Lata ran between continuous
      // porticoes for its whole length, and it is what makes a 42 m corridor read as a
      // monumental street rather than as a gap.
      if (way.portico && trim && detail >= 2) {
        const pitch = 4.6;
        const cols = Math.floor(len / pitch);
        const off = road + foot + 0.9;
        for (let i = 1; i < cols; i++) {
          const t = (i * pitch) / len;
          const px = lerp(a.x, b.x, t);
          const pz = lerp(a.z, b.z, t);
          for (const side of [-1, 1]) {
            const cxp = px + nx * off * side;
            const czp = pz + nz * off * side;
            column(trim, cxp, heightAt(cxp, czp) + 0.34, czp, 0.46, 6.4, 'corinthian', PAL.marble, detail - 1);
          }
        }
        // The architrave the columns carry. Without it a colonnade is a row of bollards,
        // which is exactly what the first render of this looked like: a portico is a
        // *roofed* walk, and the continuous horizontal is what says so at any distance.
        for (const side of [-1, 1]) {
          const y = heightAt(a.x, a.z) + 7.1;
          const ox = nx * off * side;
          const oz = nz * off * side;
          for (const [w0, w1, dy] of [[-0.55, 0.55, 0], [-0.85, 0.85, 1.05]] as const) {
            p0.set(a.x + ox + nx * w0, y + dy, a.z + oz + nz * w0);
            p1.set(b.x + ox + nx * w0, y + dy, b.z + oz + nz * w0);
            p2.set(b.x + ox + nx * w1, y + dy, b.z + oz + nz * w1);
            p3.set(a.x + ox + nx * w1, y + dy, a.z + oz + nz * w1);
            trim.quadN(nrm, p0, p1, p2, p3, dy > 0 ? PAL.marbleShadow : PAL.marble);
          }
          // The fascia, so the beam has a face and not just a top.
          quadPrism(
            trim, a.x + ox + nx * 0.85 * side, a.z + oz + nz * 0.85 * side,
            b.x + ox + nx * 0.85 * side, b.z + oz + nz * 0.85 * side,
            nx * side, nz * side, 0.05, y, y + 1.05,
            PAL.marble, PAL.marbleShadow, { ends: false, top: false }
          );
        }
      }
    }
  }

  // ---- the squares --------------------------------------------------------
  for (const pz of PLAZAS) {
    const cs = Math.cos(pz.rot);
    const sn = Math.sin(pz.rot);
    // Big cells, because a forum is one surface laid over centuries and patched, not a
    // mosaic. 6 m matches the travertine slabs of the Forum of Trajan.
    const nu = Math.max(2, Math.round(pz.hw / 5));
    const nv = Math.max(2, Math.round(pz.hd / 5));
    const at = (u: number, v: number, out: THREE.Vector3): void => {
      const x = pz.x + u * cs + v * sn;
      const z = pz.z - u * sn + v * cs;
      out.set(x, heightAt(x, z) + 0.12, z);
    };
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const u0 = lerp(-pz.hw, pz.hw, i / nu);
        const u1 = lerp(-pz.hw, pz.hw, (i + 1) / nu);
        const v0 = lerp(-pz.hd, pz.hd, j / nv);
        const v1 = lerp(-pz.hd, pz.hd, (j + 1) / nv);
        at(u0, v0, p0);
        at(u1, v0, p1);
        at(u1, v1, p2);
        at(u0, v1, p3);
        c.copy(PAL.travertine).lerp(PAL.marble, hash2(i, j, 0x5f1) * 0.35)
          .multiplyScalar(0.9 + hash2(i, j, 0x717) * 0.2);
        st.quadN(nrm, p0, p1, p2, p3, c);
      }
    }
    // A forum is a colonnade round a rectangle. Without the portico it is a car park.
    if (pz.porticoed && trim && detail >= 2) {
      const pitch = 4.4;
      const nx2 = Math.max(3, Math.round((pz.hw * 2) / pitch));
      const nz2 = Math.max(3, Math.round((pz.hd * 2) / pitch));
      const post = (u: number, v: number): void => {
        const x = pz.x + u * cs + v * sn;
        const z = pz.z - u * sn + v * cs;
        column(trim, x, heightAt(x, z) + 0.14, z, 0.44, 7.2, 'corinthian', PAL.marble, detail - 1);
      };
      for (let i = 0; i <= nx2; i++) {
        const u = lerp(-pz.hw, pz.hw, i / nx2);
        post(u, -pz.hd);
        post(u, pz.hd);
      }
      for (let j = 1; j < nz2; j++) {
        const v = lerp(-pz.hd, pz.hd, j / nz2);
        post(-pz.hw, v);
        post(pz.hw, v);
      }
    }
  }
}
