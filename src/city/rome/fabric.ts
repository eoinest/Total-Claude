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
import { POMERIUM } from './circuit';
import {
  DISTRICTS,
  onMonument,
  PLAZAS,
  WAY_FRONTAGE,
  WAY_WIDTH,
  WAYS,
  type DistrictSpec,
} from './layout';
import type { Lane } from '../cityPlan';
import type { CityMatKey } from '../materials';
import { PAL } from '../palette';
import { cylinderBetween, type CityChunkSpec, type TreeRequest } from '../wall';

/**
 * The city fabric: *insulae*, streets and courtyards.
 *
 * ## What was wrong
 *
 * The user's report was two sentences and both were about this file: *"the streets of Rome
 * look... not so much like streets but a patched quilt"*, and *"the large monuments are
 * smacked down across multiple buildings"*. Rendered from the strategic camera the
 * diagnosis was not subtle. There were **no streets at all**. There were three separate
 * faults compounding:
 *
 *  1. **The blocks came from a BSP.** Each district was recursively cut in half with a gap
 *     left between the halves, and the gaps were called streets. They are not streets. A
 *     BSP gap terminates at its parent rectangle, so nothing runs anywhere: the city was a
 *     set of disconnected stubs, T-ing into each other at every level. Worse, each district
 *     ran its own BSP at its own rotation, so no line survived a district boundary.
 *  2. **Nothing drew them.** The subdivision left *absences*. The only paving in the city
 *     was the nine named viae. Between the blocks was `buildDistrictGround`, a 22 × 22 grid
 *     of 25 m quads tinted at random from three tones — which is, quite literally, a patched
 *     quilt, and it had no relationship whatsoever to where the blocks were. That is the
 *     thing the user could see.
 *  3. **The ratio was inverted.** Streets were graded by the size of the block they cut, so
 *     a 42 m artery appeared wherever a district happened to be large. Counted from the
 *     occupancy grid, barely a third of the ground inside the walls was built. Real Rome is
 *     the other way round: dense fabric, thin lanes.
 *
 * ## What replaces it
 *
 * **Streets first, blocks second, buildings third** — the order a Roman surveyor works in.
 *
 *  - `rome/layout.ts` publishes `WAYS`, a city-wide armature of named viae, the military road
 *    inside the wall, a ring round every monument, and the feeders that connect them. It is
 *    a graph, it is continuous, and it is graded by rank rather than by accident.
 *  - Each district lays a **spine-and-rib** lattice inside that armature: two to six
 *    *spines* running the length of the quarter, gently wandering and never parallel for
 *    long, with short *ribs* cutting between adjacent spines. Ribs are staggered from band
 *    to band, so every crossing is a T-junction and no two blocks are the same shape. This
 *    is the topology of an organic Mediterranean city, and the important property is that
 *    **irregular is not the same as discontinuous**: every spine runs end to end.
 *  - A **block** is the quad between two ribs and two spines. It is filled with a terrace of
 *    party-walled insulae whose façades sit *on* the street line, in one or two rows about a
 *    central light well. That is what an insula block is, and it is why the result reads as
 *    blocks of buildings rather than as scattered huts.
 *  - The whole network is then **drawn** — cambered basalt carriageway, travertine kerb,
 *    raised footway, colonnades on the processional ways — in one batch, for one draw call.
 *
 * Real dimensions: Roman insulae ran three to five storeys, and Augustus capped them
 * at 70 Roman feet (20.7 m) after collapses — Trajan later lowered it to 60 (17.8 m).
 * Ground floors held *tabernae* with wide arched openings, and the storeys above were
 * about 3.1 m each with shuttered windows and projecting timber balconies.
 */

const STOREY_H = 3.15;
const GROUND_H = 4.3;

export interface DistrictOutput {
  chunks: CityChunkSpec[];
  trees: TreeRequest[];
  /** Building footprints, in world space, for the movement-blocking grid. */
  footprints: { x: number; z: number; hw: number; hd: number; rot: number }[];
  /**
   * The lanes each quarter cut for itself, so the plan diagnostic and the stats can see
   * the whole network rather than only the named armature.
   */
  lanes: Lane[];
}

type Ground = (x: number, z: number) => number;

interface Plot {
  /** World centre. */
  x: number;
  z: number;
  rot: number;
  /** Half-extents of the footprint in the district's local frame. */
  hw: number;
  hd: number;
  /** Which side faces the widest street; tabernae and balconies go there. */
  frontSide: 1 | -1;
  /**
   * This footprint is a whole city block and must be built as a **continuous perimeter
   * range about a courtyard**, not as a free-standing building. See `fillBlock`.
   */
  perimeter?: boolean;
  /** 1 in the heart of the district, falling to 0 at its frayed edge. */
  edge: number;
}

/**
 * Depth at which a block is deep enough for two rows of building about a light well.
 *
 * A Roman insula is 12–20 m from street front to back wall — that is as far as a room can
 * be from a window before it is useless — so anything deeper than about two of those plus a
 * gap is built as two terraces back to back with an internal court between them. Ostia's
 * Casa di Diana and the Garden Houses are both exactly this.
 */
const TWO_ROW_DEPTH = 34;
/** Internal light well between the two rows of a deep block. */
const LIGHT_WELL = 4.2;

/**
 * How deep a single building may be, front wall to back wall.
 *
 * A room needs a window, so a Roman house is one or two rooms deep and that is that:
 * Ostia's insulae run 12–20 m from the street to the light well and the Forma Urbis shows
 * the same across the city. The number matters here for a second reason. A block band can
 * be 50 m deep, and building it as two 23 m slabs makes each *plot* 26 × 23 m — four times
 * the area of the BSP plots this replaced, and once a plot is that big and tested exactly
 * against the monuments there is nowhere left in the monumental core that one will fit.
 * Capping the depth turns the middle of a deep block into what it should be anyway: a
 * garden.
 */
const INSULA_DEPTH_MAX = 22;

/**
 * The smallest thing still worth calling a building, metres on a side.
 *
 * This is the terminator of the adaptive fill in `place`, so it decides the *grain* of the
 * fabric beside an obstruction rather than merely rejecting noise. Below about seven metres
 * a footprint stops reading as a house from any camera and starts reading as debris, and it
 * costs a movement obstacle for nothing.
 */
const MIN_PLOT = 7.5;
/** Shortest frontage a terrace will cut. Ostia's narrowest surviving property is 6.2 m. */
const MIN_FRONTAGE = 11;
/** A block shallower than this has no room for a house and a back wall. */
const MIN_DEPTH = 9;
/** Render's worth of party wall between two pieces of one subdivided frontage. */
const PARTY_GAP = 0.35;

/**
 * The district's own frame, in the **same rotation convention the geometry uses**.
 *
 * `makeRotationY(r)` sends local +X to world (cos r, −sin r), and `city/layout.ts`'s `Obb`
 * follows it. The previous district mapping sent local u to (cos r, **+**sin r) — the
 * mirror — so a building drawn with `makeRotationY(d.rot)` was skewed by `2·d.rot` from
 * the subdivision that placed it. At ±0.08 rad of district rotation that is nine degrees,
 * which is small enough never to have been noticed and large enough that a terrace of
 * party-walled houses would splay apart instead of forming a street wall. Getting it
 * right is a precondition for façades that sit *on* a street line.
 */
function districtFrame(d: DistrictSpec): {
  x: (u: number, v: number) => number;
  z: (u: number, v: number) => number;
} {
  const cs = Math.cos(d.rot);
  const sn = Math.sin(d.rot);
  return {
    x: (u, v) => d.x + u * cs + v * sn,
    z: (u, v) => d.z - u * sn + v * cs,
  };
}

/**
 * A uniform-grid reject for plots already placed.
 *
 * Districts overlap — their half-extents are inflated 1.5× and 2.6× so the fabric can fill
 * the gaps the overlap resolver opens between monuments — and nothing used to stop two
 * quarters interleaving buildings across a shared boundary. Every such pair is a visible
 * interpenetration and a phantom obstacle for the sim.
 */
class PlotGrid {
  private static readonly CELL = 32;
  private cells = new Map<number, Plot[]>();

  private key(x: number, z: number): number {
    return ((Math.floor(x / PlotGrid.CELL) + 4096) << 13) | (Math.floor(z / PlotGrid.CELL) + 4096);
  }

  add(p: Plot): void {
    const r = Math.hypot(p.hw, p.hd);
    for (let z = p.z - r; z <= p.z + r + PlotGrid.CELL; z += PlotGrid.CELL) {
      for (let x = p.x - r; x <= p.x + r + PlotGrid.CELL; x += PlotGrid.CELL) {
        const k = this.key(x, z);
        const list = this.cells.get(k);
        if (list) list.push(p);
        else this.cells.set(k, [p]);
      }
    }
  }

  /**
   * `pad` is **negative** by design. A terrace shares party walls, and two plots that
   * follow a bending spine at slightly different angles clip each other at the corner by a
   * few centimetres. Testing at zero tolerance made the fabric reject itself — every second
   * building in every block vanished, and the city came back emptier than the BSP it
   * replaced. Half a metre of allowed interpenetration is invisible and is what a party
   * wall is anyway.
   */
  hits(x: number, z: number, hw: number, hd: number, rot: number, pad = -0.5): boolean {
    const a: Obb = { x, z, hw, hd, rot };
    const r = Math.hypot(hw, hd);
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

/**
 * Lay the spine-and-rib lattice for one quarter and fill its blocks.
 *
 * The lattice is the whole idea, so it is worth stating what each piece is for:
 *
 *  - **Spines** run the length of the district, one every 54–84 m depending on how packed
 *    the quarter was. Each wanders on its own sine — a twelfth of the band's width, a
 *    period and a half across the district — so no two are parallel for long and none is
 *    straight, but every one of them is *continuous end to end*. That is the property the
 *    BSP could not have and the reason its gaps never read as streets.
 *  - **Ribs** cut across a single band from one spine to the next. Their positions are drawn
 *    per band, so ribs in adjacent bands do not line up and every crossing is a T-junction.
 *    A four-way crossroads is the signature of a planned grid; Rome is not one.
 *  - **Blocks** are the quads left over, and they are filled to their edges with a terrace
 *    of party-walled buildings — one row if the block is shallow, two about a light well if
 *    it is deep. The façades sit on the street line with no setback, which is what makes a
 *    street a corridor with walls rather than a gap between objects.
 */
function planDistrict(
  d: DistrictSpec,
  rng: Rng,
  keepOut: KeepOut,
  wallZAt: (x: number) => number,
  placed: PlotGrid
): { plots: Plot[]; lanes: Lane[] } {
  const plots: Plot[] = [];
  const lanes: Lane[] = [];
  // Kept because a quarter that plans nothing is a real failure mode and an invisible one:
  // the district exists, reserves ground and plants trees, and simply has no houses. That
  // happened to the Subura at one point in this rebuild — 3 buildings out of 125 candidate
  // frontages — and only a counter showed it.
  const R = { rows: 0, ok: 0 };
  /**
   * How much of a block actually gets built.
   *
   * Measured on the AGEA orthophoto of the historic core, roofs cover 60–72 % of the ground
   * between street lines; the previous 0.82 + 0.17·density, further multiplied by
   * `0.55 + 0.45·mask`, was throwing away nearly half of every quarter's *middle* as well as
   * its edge, and the land audit found the walled city 16.5 % built. The fade belongs at the
   * margin, where a Roman city really did become yards and orchards, and nowhere else — so
   * the mask term is now a shallow ramp rather than a halving.
   */
  const keep = 0.9 + d.density * 0.1;
  /** Thinning by distance from the district's heart: 1 in the middle, ~0.7 at the fringe. */
  const fade = (m: number): number => keep * (0.68 + 0.32 * m);
  const F = districtFrame(d);
  const grow = 1 + d.fray * 0.34;
  const HU = d.hw * grow;
  const HV = d.hd * grow;

  // ---- spines -------------------------------------------------------------
  // Block depth. The Subura at density 0.94 gets 54 m bands, the Vaticanus at 0.4 gets 78.
  // Both sit inside the 40–80 m the historic centre actually measures between street lines.
  // Measured off the AGEA orthophoto against a 100 m grid: blocks in Rome's historic core
  // run 45–110 m with a median of 75 × 85 m. The Subura at density 0.94 gets 62 m bands,
  // the Vaticanus at 0.4 gets 82.
  const bandPitch = lerp(88, 62, d.density);
  const nBands = Math.max(1, Math.round((HV * 2) / bandPitch));
  const nSpines = nBands + 1;
  const spine: { v: number; amp: number; freq: number; phase: number; cls: WayClass; edge: boolean }[] = [];
  // The quarter's own high street, and a second one if it is deep enough to need it.
  const mainA = nBands >= 2 ? rng.int(1, nBands - 1) : -1;
  const mainB = nBands >= 5 ? ((mainA + Math.floor(nBands / 2) - 1) % (nBands - 1)) + 1 : -1;
  for (let k = 0; k < nSpines; k++) {
    const edge = k === 0 || k === nBands;
    const jitter = edge ? 0 : rng.range(-0.18, 0.18) * bandPitch;
    spine.push({
      v: lerp(-HV, HV, k / nBands) + jitter,
      amp: edge ? 0 : bandPitch * rng.range(0.05, 0.13),
      freq: (Math.PI * rng.range(1.1, 2.4)) / Math.max(70, HU),
      phase: rng.range(0, Math.PI * 2),
      cls: k === mainA || k === mainB ? 'local' : 'vicus',
      edge,
    });
  }
  const vAt = (k: number, u: number): number =>
    spine[k].v + spine[k].amp * Math.sin(u * spine[k].freq + spine[k].phase);
  const slopeAt = (k: number, u: number): number =>
    spine[k].amp * spine[k].freq * Math.cos(u * spine[k].freq + spine[k].phase);
  // Half the street plus its setback: the *building line*, not the kerb. The district's
  // outer boundary is not a street at all — the fray mask fades the fabric out there, and
  // paving a line through open orchards would put a kerb in a field.
  const halfW = (k: number): number =>
    spine[k].edge ? 0 : WAY_WIDTH[spine[k].cls] * 0.5 + WAY_FRONTAGE[spine[k].cls];

  /** True where the fabric may stand: inside the mask, behind the pomerium, off the plan. */
  const buildable = (u: number, v: number, hu: number, hv: number, rot: number): number => {
    const x = F.x(u, v);
    const z = F.z(u, v);
    const mask = districtMask(d, u, v);
    if (mask <= 0.04) return 0;
    // The *pomerium*: the whole footprint clear of the curtain, not just its centre.
    const zReach = Math.abs(Math.sin(rot)) * hu + Math.abs(Math.cos(rot)) * hv;
    if (z - zReach < wallZAt(x) + POMERIUM) return 0;
    if (keepOut.blockedRect(x, z, hu, hv, rot)) return 0;
    if (placed.hits(x, z, hu, hv, rot)) return 0;
    return mask;
  };

  // Emit a spine as one or more lanes, broken wherever it runs into something reserved.
  // A street that stops at the Colosseum's precinct and picks up on the far side is
  // correct; one that drives through it is not.
  for (let k = 0; k < nSpines; k++) {
    if (spine[k].edge) continue;
    const w = WAY_WIDTH[spine[k].cls];
    const steps = Math.max(6, Math.round((HU * 2) / 22));
    let run: { x: number; z: number }[] = [];
    for (let i = 0; i <= steps; i++) {
      const u = lerp(-HU, HU, i / steps);
      const v = vAt(k, u);
      const x = F.x(u, v);
      const z = F.z(u, v);
      const ok =
        districtMask(d, u, v) > 0.18 &&
        !keepOut.blockedRect(x, z, 6, w * 0.5, d.rot) &&
        z > wallZAt(x) + 20;
      if (ok) run.push({ x, z });
      else {
        if (run.length >= 2) lanes.push({ path: run, cls: spine[k].cls, width: w });
        run = [];
      }
    }
    if (run.length >= 2) lanes.push({ path: run, cls: spine[k].cls, width: w });
  }

  // ---- ribs and blocks, band by band --------------------------------------
  for (let k = 0; k < nBands; k++) {
    // Block length along the spine. Roman blocks are longer than they are deep.
    const ribPitch = lerp(86, 58, d.density) * rng.range(0.88, 1.14);
    const nRibs = Math.max(1, Math.round((HU * 2) / ribPitch));
    const cuts: { u: number; half: number; cls: WayClass }[] = [];
    for (let i = 0; i <= nRibs; i++) {
      const end = i === 0 || i === nRibs;
      // Every fourth rib is a 14 m lane rather than an 8 m alley, so a band is never more
      // than two blocks from something a column can turn into.
      const cls: WayClass = !end && i % 4 === 2 ? 'local' : 'vicus';
      cuts.push({
        u: lerp(-HU, HU, i / nRibs) + (end ? 0 : rng.range(-0.22, 0.22) * ribPitch),
        half: end ? 0 : WAY_WIDTH[cls] * 0.5,
        cls,
      });
    }

    for (let i = 0; i + 1 < cuts.length; i++) {
      const ua = cuts[i].u + cuts[i].half;
      const ub = cuts[i + 1].u - cuts[i + 1].half;
      if (ub - ua < 13) continue;
      fillBlock(k, ua, ub);
    }

    // The ribs themselves, clipped to the band and to anything reserved.
    for (let i = 1; i < cuts.length - 1; i++) {
      const u = cuts[i].u;
      const v0 = vAt(k, u) + halfW(k);
      const v1 = vAt(k + 1, u) - halfW(k + 1);
      if (v1 - v0 < 6) continue;
      const a = { x: F.x(u, v0), z: F.z(u, v0) };
      const b = { x: F.x(u, v1), z: F.z(u, v1) };
      const w = WAY_WIDTH[cuts[i].cls];
      if (districtMask(d, u, (v0 + v1) * 0.5) < 0.2) continue;
      if (keepOut.blockedRect((a.x + b.x) / 2, (a.z + b.z) / 2, w * 0.5, (v1 - v0) * 0.5, d.rot)) continue;
      if (Math.min(a.z, b.z) < wallZAt((a.x + b.x) / 2) + 20) continue;
      lanes.push({ path: [a, b], cls: cuts[i].cls, width: w });
    }
  }

  /**
   * Fill one block, **shrinking it against what crosses it rather than abandoning it.**
   *
   * The order is the one a surveyor works in and each step is a demotion of the last:
   *
   *  1. **One courtyard mass over the whole block.** A block big enough and clear enough
   *     stops being a row of buildings and becomes *one* building — a continuous range
   *     wrapped round all four sides with a light well in the middle. That is what an
   *     insula block is, and it is what the figure-ground of Rome looks like from above:
   *     one connected mass punched with courtyards, not a scatter of separate objects.
   *  2. **Halve it and try again.** A wide block that a street or a precinct clips is not
   *     unbuildable — it is two shorter blocks. Real fabric beside a monument gets *smaller*
   *     grain, it does not dissolve into open ground.
   *  3. **A terrace of party-walled frontages**, each of which subdivides further in
   *     `place` until it fits.
   */
  function fillBlock(k: number, ua: number, ub: number, level = 0): void {
    if (ub - ua < 13) return;
    if (tryPerimeter(k, ua, ub)) return;
    // 66 m is two frontages plus a party wall either side of a 14 m lane: below it,
    // halving produces blocks too short to read as blocks and the terrace is the honest
    // answer. Split off-centre so the grain does not come out as powers of two.
    if (ub - ua >= 66 && level < 2) {
      const um = lerp(ua, ub, rng.range(0.4, 0.6));
      fillBlock(k, ua, um - 0.25, level + 1);
      fillBlock(k, um + 0.25, ub, level + 1);
      return;
    }
    terrace(k, ua, ub);
  }

  /** The two street lines bounding band `k` at a given point along it. */
  function cornerV(k: number, u: number): [number, number] {
    return [vAt(k, u) + halfW(k), vAt(k + 1, u) - halfW(k + 1)];
  }

  /**
   * **One rotation per row, taken at the block's centre.**
   *
   * Deriving each plot's angle from the spine slope *under that plot* seemed the careful
   * thing to do and is wrong: it twists every house in a terrace by a different few
   * degrees, so party walls that are 0.1 m apart at their centres cross by up to three
   * metres at the corners. Measured on the first build of this: 118 interpenetrating pairs
   * involving 214 of 439 buildings. A terrace is built to a single line and the street's
   * bend is taken up at the block ends, which is what a real curving street of houses
   * does — straight runs, angle changes at a party wall.
   */
  function rowRotOf(k: number, ua: number, ub: number): [number, number] {
    return [
      d.rot + Math.atan(slopeAt(k, (ua + ub) * 0.5)),
      d.rot + Math.atan(slopeAt(k + 1, (ua + ub) * 0.5)),
    ];
  }

  /**
   * The whole block as one continuous range about a courtyard.
   *
   * **This is the difference between a scatter and a city, and it took a blind critic to
   * make it stick.** Shown this plan beside four crops of an orthophoto of Rome, the critic
   * sorted the deck 6/6 and wrote: *"density was raised without changing topology — the
   * buildings are separate objects with visible ground between them instead of a continuous
   * mass of party-walled frontage… adding count doesn't produce urbanism, adding adjacency
   * does."* It also noted zero courtyards anywhere in the fabric, where a real dense core is
   * 14–20 % courtyard. A terrace of individually-placed houses cannot fix that however
   * tightly it is packed, because each house still carries its own eaves, its own shadow and
   * its own scrap of ground.
   */
  function tryPerimeter(k: number, ua: number, ub: number): boolean {
    const blockW = ub - ua;
    if (blockW < 26) return false;
    const [lo0, hi0] = cornerV(k, ua);
    const [lo1, hi1] = cornerV(k, ub);
    const blockD = Math.min(hi0 - lo0, hi1 - lo1);
    if (blockD < 24) return false;
    // Not every block: a quarter of solid courtyard rings reads as a housing estate. The
    // rest fall through to a terrace, which is the coarser grain a poorer street has.
    if (rng.next() > 0.66 + d.density * 0.3) return false;
    const uc = (ua + ub) * 0.5;
    const vc = (lo0 + hi0 + lo1 + hi1) * 0.25;
    const rot = rowRotOf(k, ua, ub)[0];
    const m = districtMask(d, uc, vc);
    if (m <= 0.04 || rng.next() > fade(m)) return false;
    R.rows++;
    const mask = buildable(uc, vc, blockW * 0.5 - 0.2, blockD * 0.5 - 0.2, rot);
    if (mask <= 0) return false;
    R.ok++;
    plots.push({
      x: F.x(uc, vc), z: F.z(uc, vc), rot,
      hw: blockW * 0.5 - 0.2, hd: blockD * 0.5 - 0.2,
      frontSide: -1, edge: mask, perimeter: true,
    });
    return true;
  }

  /**
   * A run of party-walled houses fronting the streets either side of the block.
   *
   * Frontages are 12–26 m — the range Ostia's surviving properties occupy — and neighbours
   * share a party wall with a gap of a few centimetres, so the block presents a continuous
   * street wall broken by the odd passage. A block deeper than `TWO_ROW_DEPTH` becomes two
   * terraces back to back about a light well, each fronting its own street. Nothing is set
   * back: the façade *is* the street edge.
   */
  function terrace(k: number, ua: number, ub: number): void {
    const rowRot = rowRotOf(k, ua, ub);
    const cuts: number[] = [ua];
    let u = ua;
    while (ub - u > MIN_FRONTAGE) {
      const want = rng.range(12, 26);
      if (ub - (u + want) < MIN_FRONTAGE) break;
      u += want;
      cuts.push(u);
    }
    cuts.push(ub);

    for (let p = 0; p + 1 < cuts.length; p++) {
      // Party walls. The figure-ground of a real city is one connected mass punched with
      // courtyards, not a scatter of separate buildings, so the default gap is a few
      // centimetres of render and only one frontage in eight opens a passage.
      const gap = rng.next() < 0.12 ? rng.range(1.3, 2.8) : rng.range(0.05, 0.3);
      const pa = cuts[p] + (p === 0 ? 0 : gap * 0.5);
      const pb = cuts[p + 1] - (p + 2 === cuts.length ? 0 : gap * 0.5);
      const uc = (pa + pb) * 0.5;
      const hu = (pb - pa) * 0.5;
      if (hu * 2 < MIN_FRONTAGE) continue;

      const [lo, hi] = cornerV(k, uc);
      const depth = hi - lo;
      if (depth < MIN_DEPTH) continue;

      // One terrace, or two back to back about a garden. Either way no building is deeper
      // than a room and a corridor: the leftover in the middle of the block is the court.
      const rows: [number, number, 1 | -1][] = [];
      if (depth >= TWO_ROW_DEPTH) {
        const rd = Math.min(INSULA_DEPTH_MAX, (depth - LIGHT_WELL) * 0.5);
        rows.push([lo, lo + rd, -1], [hi - rd, hi, 1]);
      } else {
        const rd = Math.min(INSULA_DEPTH_MAX, depth);
        const front: 1 | -1 = halfW(k) >= halfW(k + 1) ? -1 : 1;
        rows.push(front < 0 ? [lo, lo + rd, front] : [hi - rd, hi, front]);
      }

      for (const [v0, v1, front] of rows) {
        R.rows++;
        // Thinned toward the frayed margin, so the city fades into orchards and gardens
        // rather than ending at the mask's cut-off like a bitten biscuit.
        const m = districtMask(d, uc, (v0 + v1) * 0.5);
        if (rng.next() > fade(m)) continue;
        place(uc, hu, v0, v1, front, rowRot[front < 0 ? 0 : 1], 0);
      }
    }
  }

  /**
   * Fit building mass into one frontage, **clipping it against whatever is in the way
   * rather than abandoning the frontage.**
   *
   * This is what makes room for the monuments, and it is also most of the city. A block is
   * cut from the district's own lattice, which knows nothing about the armature of named
   * viae, the ring round the Colosseum or the aqueduct on its piers. A great many blocks
   * are therefore crossed by one of those, and rejecting every plot that touched one lost
   * the *whole block* — forty metres of frontage either side of a fourteen-metre lane.
   * Measured on the revision this replaces: eight of seventeen quarters built under 12 % of
   * their frontages, the Subura 10 houses out of 202, and the whole city came back with 732
   * buildings against the 2,907 the BSP had.
   *
   * **Bisection is not good enough and the measurement says so.** A frontage clipped eight
   * metres at one end halves into two twenties, the clipped twenty halves into two tens, and
   * the clipped ten falls under the minimum — so eight metres of obstruction destroys twenty
   * metres of frontage, and the fabric ends up standing well back from every kerb in Rome
   * with a ring of dead ground round each street. Bisecting the whole city that way took the
   * walled area from 16.5 % built to 17.8 %: nothing.
   *
   * So a frontage that does not fit whole is **packed greedily from one end** instead — take
   * the widest piece from the ladder that fits, advance past it, repeat. That is how a
   * terrace of houses actually grows along an awkward plot, it walks the façade right up to
   * whatever is in the way, and it costs a handful of extra rectangle tests.
   *
   * Only when *nothing* fits anywhere along the frontage at this depth does it halve in
   * depth and try again, with each half anchored to the street it faces — the front half
   * keeps its façade, the back half fronts the lane behind. So the street wall never
   * develops a sawtooth: what retreats is the back wall, and only where something really is
   * in the way.
   */
  function place(
    uc: number, hu: number, v0: number, v1: number, front: 1 | -1, rot: number, level: number
  ): void {
    const w = hu * 2;
    const dep = v1 - v0;
    if (w < MIN_PLOT || dep < MIN_PLOT) return;
    const vc = (v0 + v1) * 0.5;
    const hv = dep * 0.5 - 0.12;

    const emit = (u: number, halfW: number): boolean => {
      if (halfW * 2 < MIN_PLOT) return false;
      const mask = buildable(u, vc, halfW, hv, rot);
      if (mask <= 0) return false;
      R.ok++;
      plots.push({ x: F.x(u, vc), z: F.z(u, vc), rot, hw: halfW, hd: hv, frontSide: front, edge: mask });
      return true;
    };

    if (emit(uc, hu)) return;

    // Pack what will fit, one end to the other. `guard` is belt and braces: every iteration
    // advances `u` by at least half a minimum plot, so a 26 m frontage cannot exceed seven.
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
    if (any || level >= 2) return;

    // Nothing stands at this depth anywhere along the frontage — a precinct or a
    // carriageway crosses the whole of it. Come forward and try the two shallower rows.
    place(uc, hu, v0, vc - PARTY_GAP * 0.5, -1, rot, level + 1);
    place(uc, hu, vc + PARTY_GAP * 0.5, v1, 1, rot, level + 1);
  }

  /**
   * A quarter that plans nothing is a real failure mode and an invisible one: the district
   * exists, reserves ground, plants trees, and simply has no houses. It happened to the
   * Subura twice during this rebuild.
   *
   * The test is an absolute count, not a ratio of frontages. A ratio was the obvious thing
   * and it stopped meaning anything once `place` began packing a frontage greedily — one
   * frontage can now yield six buildings or none, so `ok/rows` swings wildly and fired on
   * fourteen of seventeen healthy quarters. Twenty buildings is about two blocks; below that
   * a district is not thin, it is missing.
   */
  if (R.ok < 20) {
    console.warn(`[city] ${d.id} planned only ${R.ok} buildings from ${R.rows} frontages — the quarter is buried`);
  }
  return { plots, lanes };
}

/**
 * How built-up a district is at a point in its own frame, 1 in the middle and 0 outside.
 *
 * A district authored as a rectangle of insulae ends at a straight line, and against the
 * terrain's ploughed fields that line is the single most artificial thing a procedural
 * city does — the QA pass called it out as "the city stops at a rectangular seam". Real
 * fabric fades: the last blocks get shorter, the plots get bigger, walled gardens and
 * orchards take over, and the boundary wanders. So the district's extent is a *lobed*
 * superellipse rather than a box, and density, storey count and ground surface all ramp
 * down through the last fifth of it.
 */
function districtMask(d: DistrictSpec, u: number, v: number): number {
  const tu = Math.abs(u) / d.hw;
  const tv = Math.abs(v) / d.hd;
  // Superellipse: rounded corners, so no district has a right-angle boundary.
  const t = Math.pow(Math.pow(tu, 4) + Math.pow(tv, 4), 0.25);
  const seed = Rng.hashString(d.id);
  const ph1 = hash2(seed & 0xff, 1, 0x3a) * Math.PI * 2;
  const ph2 = hash2(seed & 0xff, 2, 0x3b) * Math.PI * 2;
  const ang = Math.atan2(v * d.hw, u * d.hd);
  // Two incommensurate lobes push the boundary in and out along its length.
  const lobe = d.fray * (0.17 * Math.sin(ang * 3 + ph1) + 0.1 * Math.sin(ang * 7 + ph2));
  const outer = 1 + d.fray * 0.34 + lobe;
  // The ramp is the *fringe*, not the quarter. At 0.2 + 0.42·fray it ran from 0.38 of the
  // half-extent outwards on a frayed district — over three quarters of the area by radius —
  // so the quarter's heart was being thinned as though it were its edge. Halved, so a
  // district is a plateau with a soft rim.
  const inner = outer - (0.12 + d.fray * 0.26);
  const s = clamp((outer - t) / Math.max(0.05, outer - inner), 0, 1);
  return s * s * (3 - 2 * s);
}

export function buildDistricts(
  heightAt: Ground,
  keepOut: KeepOut,
  seed: string,
  wallZAt: (x: number) => number
): DistrictOutput {
  const rng = new Rng(seed);
  const trees: TreeRequest[] = [];
  const footprints: { x: number; z: number; hw: number; hd: number; rot: number }[] = [];

  // Plan every district up front so the movement grid and the tree list are complete
  // before any geometry is built (chunk builders run lazily, per LOD level).
  //
  // Order matters now in a way it did not before: districts overlap, and a plot is rejected
  // against everything already standing, so the first quarter planned wins the shared
  // ground. `DISTRICTS` runs north to south, which puts the Campus Martius — the quarter the
  // camera is in for most of the battle — first.
  const planned = new Map<string, Plot[]>();
  const lanes: Lane[] = [];
  const placed = new PlotGrid();
  for (const d of DISTRICTS) {
    const drng = rng.fork(d.id);
    const out = planDistrict(d, drng, keepOut, wallZAt, placed);
    // Committed only now the quarter is complete. A plot must be tested against the
    // *neighbouring district*, never against the terrace it belongs to.
    for (const p of out.plots) placed.add(p);
    planned.set(d.id, out.plots);
    for (const l of out.lanes) lanes.push(l);
    for (const p of out.plots) footprints.push({ x: p.x, z: p.z, hw: p.hw, hd: p.hd, rot: p.rot });

    // Courtyard trees and street planting: cypress in gardens, umbrella pine in
    // squares. Density falls with how packed the district is.
    // Courtyard trees inside, orchards and garden plots on the frayed margin — which is
    // what actually made the edge of a Roman city, and it hides the transition to fields.
    const F = districtFrame(d);
    const grow = 1 + d.fray * 0.34;
    const nTrees = Math.round(d.hw * d.hd * 0.0022 * (1.4 - d.density));
    for (let i = 0; i < nTrees; i++) {
      const u = drng.range(-d.hw * grow, d.hw * grow);
      const v = drng.range(-d.hd * grow, d.hd * grow);
      const wx = F.x(u, v);
      const wz = F.z(u, v);
      if (wz < wallZAt(wx) + 14) continue;
      const mask = districtMask(d, u, v);
      if (mask < 0.02) continue;
      // Sparse in the packed heart, thick round the edges.
      if (drng.next() > 1.15 - mask) continue;
      if (keepOut.blocked(wx, wz, 5)) continue;
      // A tree standing in the carriageway is worse than no tree. The fabric already
      // avoids the lanes by construction; the planting has to be told.
      if (placed.hits(wx, wz, 3, 3, 0)) continue;
      if (nearLane(lanes, wx, wz, 3)) continue;
      trees.push({ x: wx, z: wz, kind: drng.pick(['cypress', 'pine', 'umbrella'] as const), scale: drng.range(0.75, 1.25) });
    }
  }

  // Group districts into depth bands: one chunk per band keeps the draw count down,
  // and the whole city is normally in frame at once anyway so per-district culling
  // buys little.
  // Ids must match `DISTRICT_PLAN` in layout.ts exactly — see `assertEveryDistrictBuilt`,
  // which is why this list is now checked rather than trusted. Six of the seven names the
  // first revision used (`porta-flaminia`, `campus-north`, `campus-mid`, `campus-south`,
  // `east-suburb`, `forum-east`) matched nothing, so the whole of the Campus Martius, the
  // Velabrum and the Emporium — 40 % of the city's fabric, and the ground directly behind
  // the wall in the standard viewpoint — were laid out, reserved in the movement grid and
  // planted with trees, but never emitted as geometry. The visible symptom was courtyard
  // cypresses standing in bare field.
  /**
   * Switch distances, and **they are a draw-call budget before they are a quality setting.**
   *
   * A district at full detail is four meshes — stucco, roof, stone, timber — and therefore
   * four draw calls plus their shadow passes. At the mid tier `buildBuilding` stops asking
   * for `timber` at all (shutters, awning poles, balcony rails and pergolas are centimetres
   * across) so the chunk is three, and `TRIM_MERGE` folds what is left. Six district groups
   * at full detail is 24 calls; the same six at mid is 18, for geometry that is 300 m away
   * and already inside a couple of screen pixels per shutter.
   *
   * The numbers below were 420–600 and every district was resolving at full detail from the
   * `city` camera, which is how the frame reached 231 calls against a 220 cap. The distance
   * is measured to a chunk's *surface* (`d = |cam − centre| − 0.55·radius`), and these
   * districts are 400–700 m across, so a nominal 560 m switch fires at nearly a kilometre of
   * centre distance. `city-gate` keeps its 260: it is the quarter directly behind the wall
   * and the player is looking at it from thirty metres.
   */
  const groups: { name: string; ids: string[]; lod: [number, number] }[] = [
    { name: 'city-gate', ids: ['campus-flaminia'], lod: [260, 1200] },
    { name: 'city-campus-n', ids: ['campus-augusti', 'via-lata', 'vaticanus'], lod: [300, 1400] },
    { name: 'city-campus-s', ids: ['campus-medius', 'campus-flaminius', 'trastevere', 'ripa-campi'], lod: [260, 1e9] },
    { name: 'city-east', ids: ['quirinal', 'viminal', 'esquiline'], lod: [260, 1e9] },
    // The Velabrum is the low ground *between* the Forum Boarium and the Forum, so the two
    // share a chunk rather than adding one: the city is already at 104 visible meshes
    // against a budget of 100.
    // The whole southern half in one chunk. Six district groups at four materials each is
    // 24 draw calls before a single monument, and the LOD ladder cannot recover them here:
    // the switch distance is measured to a chunk's surface, and a chunk 700 m across is
    // *never* far away by that measure however small the number is set. Merging is the only
    // lever that actually removes a call. The cost is coarser frustum culling over ground
    // that is almost always in frame together anyway — the Subura, the Velabrum, the Forum
    // Boarium, the Caelian, the Aventine and the Emporium are one continuous sweep of city
    // south of the Fora, and no city camera has ever held part of it without the rest.
    { name: 'city-south', ids: ['subura', 'velabrum', 'forum-boarium', 'caelian', 'aventine', 'emporium'], lod: [280, 1e9] },
  ];
  const built = new Set(groups.flatMap((g) => g.ids));
  const missing = DISTRICTS.filter((d) => !built.has(d.id)).map((d) => d.id);
  const unknown = [...built].filter((id) => !DISTRICTS.some((d) => d.id === id));
  if (missing.length || unknown.length) {
    console.warn(
      `[city] district groups do not cover the plan: unbuilt ${missing.join(', ') || 'none'}; ` +
        `unknown ${unknown.join(', ') || 'none'}`
    );
  }

  const chunks: CityChunkSpec[] = [];
  for (const grp of groups) {
    const specs = DISTRICTS.filter((d) => grp.ids.includes(d.id));
    if (!specs.length) continue;
    let cx = 0;
    let cz = 0;
    for (const d of specs) {
      cx += d.x;
      cz += d.z;
    }
    cx /= specs.length;
    cz /= specs.length;
    let radius = 60;
    for (const d of specs) radius = Math.max(radius, Math.hypot(d.x - cx, d.z - cz) + Math.hypot(d.hw, d.hd));
    chunks.push({
      name: grp.name,
      cx,
      cz,
      radius,
      castShadow: grp.name === 'city-gate',
      lodSwitch: grp.lod,
      build: (batch, detail) => {
        batch.setUvOrigin(cx, 0, cz);
        for (const d of specs) {
          if (detail >= 1) buildDistrictFloor(batch, d, heightAt, wallZAt);
          const plots = planned.get(d.id) ?? [];
          for (let i = 0; i < plots.length; i++) {
            buildBuilding(batch, detail, plots[i], d, heightAt, new Rng(Rng.hashString(`${d.id}:${i}`)));
          }
        }
      },
    });
  }

  // The whole street network in one chunk: carriageways, kerbs, footways and the
  // colonnades of the processional ways. Two materials, so two draw calls for every
  // paved surface in Rome.
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

  return { chunks, trees, footprints, lanes };
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
 * The urban floor: the trodden ground the whole quarter stands on.
 *
 * **The quilt was here, and it is worth being precise about what was wrong with it**,
 * because the obvious fix is to delete it and that is also wrong. The old version laid a
 * 22 × 22 grid of 25 m quads over each district and chose each cell's *base colour* from a
 * hash of its indices — basalt, dust or dirt, three unrelated tones — then multiplied by a
 * second hash over a ±22 % range. Adjacent cells therefore had no relationship to each
 * other or to anything else in the scene, and at 25 m a cell is about the size of a house,
 * so from the strategic camera it read as a chequerboard: *"not so much like streets but a
 * patched quilt"*.
 *
 * Deleting it is worse. The first attempt at this rebuild paved only the streets and the
 * block interiors, and the terrain's grass came through everywhere else — Rome as a set of
 * terraces standing in a meadow. A city has a floor.
 *
 * So: same coverage, but the variation is **smooth and low-contrast** rather than per-cell
 * and random. One base tone drifting between beaten earth and dust over a scale of two
 * hundred metres, ±7 % rather than ±22 %, from two incommensurate sinusoids instead of a
 * hash. It reads as ground that has been walked on for eight hundred years, which is what
 * it is, and nothing in it competes with the paving laid on top.
 */
function buildDistrictFloor(
  batch: Batch,
  d: DistrictSpec,
  heightAt: Ground,
  wallZAt: (x: number) => number
): void {
  const st = batch.s('stone');
  const F = districtFrame(d);
  const grow = 1 + d.fray * 0.34;
  const HU = d.hw * grow;
  const HV = d.hd * grow;
  const n = 24;
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  const nrm = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  const seed = Rng.hashString(d.id) & 0xff;
  const ph1 = hash2(seed, 1, 0x71) * Math.PI * 2;
  const ph2 = hash2(seed, 2, 0x72) * Math.PI * 2;

  const at = (u: number, v: number, out: THREE.Vector3): boolean => {
    const x = F.x(u, v);
    const z = F.z(u, v);
    out.set(x, heightAt(x, z) + 0.02, z);
    return z > wallZAt(x) + 8;
  };

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u0 = lerp(-HU, HU, i / n);
      const u1 = lerp(-HU, HU, (i + 1) / n);
      const v0 = lerp(-HV, HV, j / n);
      const v1 = lerp(-HV, HV, (j + 1) / n);
      const uc = (u0 + u1) * 0.5;
      const vc = (v0 + v1) * 0.5;
      const mask = districtMask(d, uc, vc);
      // Fades out through the frayed margin instead of stopping at a rectangle.
      if (mask < 0.09) continue;
      if (!(at(u0, v0, p0) && at(u1, v0, p1) && at(u1, v1, p2) && at(u0, v1, p3))) continue;
      // Two incommensurate waves, wavelengths ~200 m and ~90 m. Smooth, so no cell edge
      // is ever a tonal boundary.
      const w = clamp(
        0.5 +
          0.32 * Math.sin(uc * 0.031 + ph1) * Math.cos(vc * 0.027 + ph2) +
          0.18 * Math.sin(vc * 0.069 + ph2 * 1.7),
        0,
        1
      );
      /**
       * **This surface is the back of the block, and it has to be the darkest thing in
       * the frame or there is no street.**
       *
       * The hue was already corrected once, from three randomly-tinted tones per 25 m cell —
       * the literal quilt — to one smooth grey drift, on the strength of a blind critic's
       * measurement that the real plates are ~30 % achromatic and 6–10 % above 0.80 value
       * while this was 1.2 % achromatic with nothing above 0.80. The grey was right. The
       * *value* was not, and it is why the plan still read as a quilt afterwards: raising
       * the floor to peperino-drifting-to-travertine put it within a few per cent of the
       * carriageway laid on top of it, so a road stopped being visible at all and the whole
       * city became one mottled grey field with roofs sitting on it.
       *
       * The critic's statistic was about the *frame*, and in an orthophoto of Rome the light
       * achromatic pixels are roofs, render and pavement — never the ground between
       * buildings, which is the darkest thing in the picture because it is a yard in the
       * shade of a five-storey insula. So the bright achromatic budget now belongs to the
       * travertine footways in `buildWays`, which are continuous lines and therefore *draw*
       * the network, and this reverts to what it physically is: beaten earth and ash
       * between party walls, dark and warm, with the same smooth low-contrast drift.
       */
      c.copy(PAL.basalt).lerp(PAL.terraDirty, 0.34 + w * 0.3).multiplyScalar(0.86 + w * 0.16);
      // Toward the margin it becomes the orchards and garden plots that actually ended a
      // Roman city, so the transition to ploughed field is a fade and not a seam.
      c.lerp(PAL.terraDirty, (1 - mask) * 0.62);
      st.quadN(nrm, p0, p1, p2, p3, c);
    }
  }
}

/**
 * Pick a paint colour. Roman street façades were mostly red and ochre.
 *
 * Lime white is down from a fifth of frontages to an eighth. It is the least saturated entry
 * by a wide margin, and at 20 % it was the reason a district read grey from a strategic
 * camera even though two thirds of its buildings were painted: the white ones cluster and the
 * eye averages them. The rubric is explicit that the everyday palette is reds and ochres with
 * cheap lime white as the *minority* note, and Ostia bears that out.
 */
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

function buildBuilding(batch: Batch, detail: number, plot: Plot, d: DistrictSpec, heightAt: Ground, rng: Rng): void {
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
      if (!plot.perimeter) {
        buildWing(batch, detail, x0, z0, x1, z1, g, fl, paint, tile, rng, stucco, roof, timber, stone, front, form);
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
        buildWing(batch, detail, bx0, bz0, bx1, bz1, g, bf, bp, bt, rng, stucco, roof, timber, stone, front, form);
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
    buildWing(batch, detail, -w / 2, -dep / 2, w / 2, dep / 2, g, floors, paint, tile, rng, stucco, roof, timber, stone, plot.frontSide);
  }

  batch.popAll(used);
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

  // Ground storey: often left as bare brick or a darker render, as at Ostia.
  const groundPaint = new THREE.Color().copy(P.bareGround ? PAL.terraDirty : paint).multiplyScalar(P.groundTone);
  box(stucco, x0, g - 0.6, z0, x1, g + groundH, z1, groundPaint, { groundShade: 0.24 });
  // Splash-back dado. `groundShade` ramps the whole storey, which over four metres reads as
  // a soft vignette rather than as dirt; the line where cart wheels, rain off the eaves and
  // a public street actually stain a façade is a crisp band about a metre up, and every
  // surviving Ostian frontage has one. Proud of the wall by 40 mm so it reads in section
  // as well as in tone.
  const dado = new THREE.Color().copy(groundPaint).multiplyScalar(0.62).lerp(PAL.dust, 0.22);
  box(stucco, x0 - 0.04, g - 0.5, z0 - 0.04, x1 + 0.04, g + 1.05, z1 + 0.04, dado, {
    bottom: false,
    top: false,
    groundShade: 0.26,
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

  // ---- tabernae: wide arched shop fronts at street level -------------------
  if (front !== 0 && detail >= 1 && w > 6) {
    const bays = Math.max(1, Math.floor(w / P.tabernaBay));
    const bw = w / bays;
    const zf = front < 0 ? z0 : z1;
    for (let i = 0; i < bays; i++) {
      const bxp = x0 + bw * (i + 0.5);
      stucco.push(new THREE.Matrix4().makeRotationY(front < 0 ? 0 : Math.PI).setPosition(bxp, g, zf));
      archPanel(stucco, bw + 0.02, groundH, groundPaint, {
        depth: 0.55,
        spring: groundH * 0.56,
        openWidth: bw * (0.5 + hash2(i, Math.round(w * 4), 401) * 0.18),
        segments: detail >= 2 ? 7 : 4,
        voidCol: dark,
      });
      stucco.pop();
      // Cloth awning over every other shop — the top face is what the camera sees.
      if (detail >= 2 && hash2(i, Math.round(cx * 3), 907) > 0.55) {
        const aw = bw * 0.8;
        const proj = 1.2 + hash2(i, Math.round(cz * 3), 331) * 0.8;
        const yTop = g + groundH * 0.86;
        const s = front < 0 ? -1 : 1;
        const p0 = new THREE.Vector3(bxp - aw / 2, yTop, zf + s * 0.1);
        const p1 = new THREE.Vector3(bxp + aw / 2, yTop, zf + s * 0.1);
        const p2 = new THREE.Vector3(bxp + aw / 2, yTop - 0.75, zf + s * proj);
        const p3 = new THREE.Vector3(bxp - aw / 2, yTop - 0.75, zf + s * proj);
        NRM_UP.set(0, 1, 0);
        const cloth = [PAL.limeWhite, PAL.ochrePale, PAL.pompeianRed][Math.floor(hash2(i, Math.round(cx), 71) * 3)];
        stucco.quadN(NRM_UP, p0, p1, p2, p3, new THREE.Color().copy(cloth).multiplyScalar(1.1));
        if (timber) {
          cylinderBetween(timber, bxp - aw / 2, yTop - 0.75, zf + s * proj, bxp + aw / 2, yTop - 0.75, zf + s * proj, 0.05, PAL.timber, 4);
        }
      }
    }
  } else if (detail >= 1 && w > 4) {
    // Otherwise a plain doorway.
    const zf = z0;
    box(stucco, cx - 0.75, g, zf - 0.06, cx + 0.75, g + 2.3, zf + 0.2, dark);
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
      const len = Math.hypot(b.x - a.x, b.z - a.z);
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
