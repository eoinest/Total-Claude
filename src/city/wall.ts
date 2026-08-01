import * as THREE from 'three';
import { clamp, lerp } from '../util/math';
import { Rng, hash2 } from '../util/rand';
import type { CityMatKey } from './materials';
import {
  archPanel,
  box,
  column,
  crenellation,
  cylinder,
  hipRoof,
  quadPrism,
  statue,
  steps,
  type Batch,
  type GeoStream,
} from './build';
import {
  bayStage,
  fitWallPath,
  GATE_OPEN_WIDTH,
  GATE_X,
  WALL,
  WALL_LENGTH,
  WALL_X_MAX,
  WALL_X_MIN,
  type BayStage,
  type WallNode,
} from './layout';
import { PAL } from './palette';

/**
 * The Aurelian Wall, under construction.
 *
 * Aurelian began the circuit *because of* this invasion, so in 271 the wall is a
 * building site: finished stretches near the gate, half-built curtains with
 * scaffolding and treadwheel cranes, stockpiled travertine and brick, mortar pits,
 * and gaps blocked in a hurry with palisade and rubble.
 *
 * Dimensions (sources in `layout.ts`): 6.5 m to the wall-walk, 3.5 m thick,
 * brick-faced concrete on a travertine footing, square towers projecting 3.5 m at
 * one *actus* (35.5 m) intervals, each carrying a ballista chamber under a tiled
 * roof. The monumental gate sits on the axis of the Via Flaminia.
 *
 * The curtain is built bay by bay between towers. Within a bay the wall-walk is
 * *level*; between bays it steps. That is how real Roman curtains cross sloping
 * ground — they step the courses rather than shearing them.
 */

export interface WallSegmentOut {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  /**
   * Rise of the masonry above its own footing, **not** an absolute Y. A consumer that
   * wants the height of the wall-walk above the datum must add the ground height under
   * the bay — or, better, read `GarrisonBay.walkY`, which is absolute and is the same
   * number the geometry is actually built at.
   */
  height: number;
  /** True for the bay the gate passage runs through: masonry, but with a hole in it. */
  gate: boolean;
  /** Half-thickness of the curtain, so a consumer stamping an obstacle gets it right. */
  halfThickness: number;
}

/**
 * A bay of the curtain described as somewhere a man can stand.
 *
 * This is the contract between the wall geometry and the siege simulation, and it exists
 * because the two were derived independently once and disagreed. `walkY` is **absolute**
 * and is produced by the same function the wall-walk quad is built from, so a garrisoned
 * man cannot be at a different height from the stone under his feet.
 *
 * Offsets are along the bay's outward normal: negative is cityward. The clear standing
 * band runs from `innerOff` (nearest the city) to `outerOff` (up against the parapet).
 */
export interface GarrisonBay {
  index: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Outward (northward) unit normal of the run. */
  nx: number;
  nz: number;
  /** Unit vector along the run, x0 -> x1. */
  dx: number;
  dz: number;
  length: number;
  stage: BayStage;
  /** Absolute Y of the surface a man's feet rest on. */
  walkY: number;
  /** Ground under the bay — the lower of its two ends. */
  groundY: number;
  /** Absolute Y of the top of the merlons. What a flat shot must clear. */
  crestY: number;
  /**
   * Absolute Y of the sill between the merlons — the bottom of a crenel.
   *
   * A defender shoots *through* the embrasure, not over the battlement: the merlons are
   * 1.45 m of brick on top of a 0.6 m sill, and a 1.75 m man behind a merlon cannot see
   * out at all. Equal to `walkY` where there is no parapet raised yet.
   */
  sillY: number;
  /** Normal-offsets of the parapet's inner and outer faces. Equal where there is none. */
  parapetInner: number;
  parapetOuter: number;
  /** Normal-offset of the cityward limit of the clear standing band. */
  innerOff: number;
  /** Normal-offset of the outward limit, clear of the parapet or the merlon stacks. */
  outerOff: number;
  /**
   * False for footing and gap bays, which have no walkway to stand on, and false for the
   * bay the gatehouse stands in — that bay *has* a walkway either side of the block, but
   * the block breaks the run in two and a garrison rank must not be laid across it.
   */
  garrisonable: boolean;
  /**
   * True where there is a wall-walk at `walkY`, whether or not a garrison is posted on it.
   *
   * This, not `garrisonable`, is what the movement grid takes an obstacle's top from: the
   * gate bay's curtain is a walking surface at `walkY` and stamping it to `crestY` put its
   * top two metres inside the merlons.
   */
  walkable: boolean;
  /** Half-length of the tower footprint at `x0`, which the walkway does not pass through. */
  towerHalf: number;
  /**
   * Whether a curtain tower actually stands at `x0`.
   *
   * Not the same question as `towerHalf > 0`, and kept separate because the two were
   * conflated: the movement grid decided whether to stamp a tower box from `towerHalf`,
   * which is a *standing* offset and can be non-zero for reasons that are not a tower.
   */
  hasTower: boolean;
  isGate: boolean;
}

export interface GateOut {
  id: string;
  x: number;
  z: number;
  facing: number;
  open: boolean;
}

/**
 * The gatehouse as a solid: an oriented box on the wall line, with the carriageway
 * through it.
 *
 * Separate from the bays on purpose. The block is 25 m long and centred on where the Via
 * Flaminia actually crosses, so it straddles two bays; anything that reads it off the bay
 * flagged `isGate` gets the wrong 35.5 m of ground. That is precisely how `masonryTopAt`
 * came to report a fifteen-metre gatehouse standing over 23 m of open grass.
 */
export interface GateBlockOut {
  /** Centre of the carriageway, on the wall line. */
  x: number;
  z: number;
  /** Outward normal and along-run direction of the block, matching the bay's. */
  nx: number;
  nz: number;
  dx: number;
  dz: number;
  /** Half-extent along the run. */
  halfRun: number;
  /** Half-extent across the run, front face to back face. */
  halfDepth: number;
  /** Absolute Y of the top of the block's battlements. */
  topY: number;
  /** Half the clear width of the carriageway. */
  openHalf: number;
}

export interface Blocker {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  halfW: number;
}

export interface TreeRequest {
  x: number;
  z: number;
  kind: 'cypress' | 'pine' | 'umbrella';
  scale: number;
  /** Absolute base height. Omit to plant on the terrain; set it for roof gardens
   *  and for the cypresses on top of the Mausoleum's tumulus. */
  y?: number;
}

export interface CityChunkSpec {
  name: string;
  cx: number;
  cz: number;
  radius: number;
  /** `detail` runs 0 (far silhouette) .. 2 (full). */
  build: (b: Batch, detail: number) => void;
  castShadow: boolean;
  /** Distance at which each detail level takes over, near to far. */
  lodSwitch: [number, number];
  /** Material the far level collapses into. Defaults to `stone`. */
  farMaterial?: CityMatKey;
  /**
   * Distant scenery that deliberately lies outside the heightfield — only the horizon
   * ring. Exempt from `assertNoStrayGeometry`'s battlefield test, and required by it to
   * stay wholly beyond the map instead.
   */
  scenery?: boolean;
}

export interface WallBuildOutput {
  path: WallNode[];
  chunks: CityChunkSpec[];
  segments: WallSegmentOut[];
  gates: GateOut[];
  /** Where the gatehouse masonry actually stands. See `GateBlockOut`. */
  gateBlock: GateBlockOut;
  blockers: Blocker[];
  trees: TreeRequest[];
  towerCount: number;
  bayStages: BayStage[];
  /** Every bay described as a place to stand. See `GarrisonBay`. */
  garrisonBays: GarrisonBay[];
  /** Where the wall line sits, for the insula generator to build up against. */
  wallZAt: (x: number) => number;
}

interface Bay {
  index: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Level of the wall-walk in this bay; flat across the bay, stepped between them. */
  topY: number;
  g0: number;
  g1: number;
  /** Highest terrain anywhere under the run, not only at its two ends. */
  gMax: number;
  stage: BayStage;
  isGate: boolean;
  /**
   * True for the piece of a run that carries the bay's one-off construction dressing —
   * the scaffold, the material yard, the shuttering. A run cut in two by the gatehouse
   * would otherwise put two cranes on one bay. See `curtainSpans`.
   */
  dress: boolean;
}

// ---------------------------------------------------------------------------
// The gatehouse block, as a span the curtain has to make room for
// ---------------------------------------------------------------------------

/**
 * Along-run width of the Porta Flaminia's masonry block. `buildGate` builds to this.
 *
 * The block is centred on `GATE_X` — where the Via Flaminia crosses the crest, solved
 * from the Lanciani georeference — and `GATE_X` is not a bay boundary and need not even
 * lie in the bay the gate is booked to. So the curtain is *cut* to receive the block
 * rather than one whole bay being replaced by it.
 *
 * Replacing a whole bay is what this fixes. The gate is at x = 72, which falls in bay 19,
 * while `gateBay` rounds to 20 — so `buildGate` ran instead of `buildCurtainBay` for the
 * 35.5 m of bay 20, covered 5.5 m of it with the east end of the block, and left 28.4 m
 * of open grass immediately east of the Porta Flaminia. Meanwhile bay 19's curtain was
 * built straight through the middle of the gate passage, so the one way into Rome was
 * bricked up 3.75 m behind the doors.
 */
const GATE_BLOCK_W = 25;
/** Front-to-back depth of the block, so the passage is a real tunnel. */
const GATE_BLOCK_D = 11;
/** Clear height of the carriageway to the springing of the vault. */
const GATE_PASS_H = 8.4;
/** The attic above the arch, carrying the dedicatory inscription. */
const GATE_ATTIC = 4.8;
/** Merlon height on the gate block's crown. */
const GATE_MERLON_H = 2.0;
/**
 * Half-width of the span the curtain is cut out of, 0.3 m inside the block's own face so
 * the curtain dies *inside* the brick and no seam can open between the two.
 */
const GATE_CLIP_HALF = GATE_BLOCK_W * 0.5 - 0.3;

/** True where the gatehouse block stands, so nothing else may be built there. */
function inGateBlock(x: number): boolean {
  return Math.abs(x - GATE_X) <= GATE_CLIP_HALF;
}

/**
 * The parts of a run from `x0` to `x1` that the gatehouse does not stand in: the whole
 * run, one piece of it, or the two flanks either side of the block.
 */
function curtainSpans(x0: number, x1: number, out: [number, number][]): [number, number][] {
  out.length = 0;
  const a = GATE_X - GATE_CLIP_HALF;
  const b = GATE_X + GATE_CLIP_HALF;
  if (b <= x0 || a >= x1) {
    out.push([x0, x1]);
    return out;
  }
  if (x0 < a) out.push([x0, Math.min(a, x1)]);
  if (x1 > b) out.push([Math.max(b, x0), x1]);
  return out;
}

/**
 * One piece of a bay, as a bay in its own right.
 *
 * `topY`, `g0`, `g1` and `gMax` are deliberately the *parent's*: the wall-walk is level
 * across a whole bay by construction, and `walkGeometry` has to give the piece the same
 * answer it gives the garrison API for the bay, or the two disagree again.
 */
function clipBay(bay: Bay, ax: number, bx: number, dress: boolean): Bay {
  if (ax === bay.x0 && bx === bay.x1 && dress) return bay;
  const span = bay.x1 - bay.x0;
  return {
    ...bay,
    x0: ax,
    z0: lerp(bay.z0, bay.z1, (ax - bay.x0) / span),
    x1: bx,
    z1: lerp(bay.z0, bay.z1, (bx - bay.x0) / span),
    dress,
  };
}

const OUT = new THREE.Vector3();
const P0 = new THREE.Vector3();
const P1 = new THREE.Vector3();
const P2 = new THREE.Vector3();
const P3 = new THREE.Vector3();

interface Frame {
  nx: number;
  nz: number;
  dx: number;
  dz: number;
  len: number;
  rotY: number;
}

/**
 * Local frame of a wall run. `n` is the outward (northward) normal; `rotY` rotates a
 * module authored with −Z outward onto this run.
 */
function frameOf(x0: number, z0: number, x1: number, z1: number): Frame {
  const len = Math.hypot(x1 - x0, z1 - z0) || 1;
  const dx = (x1 - x0) / len;
  const dz = (z1 - z0) / len;
  // A run heading +X has its outward side toward −Z, i.e. toward the Juthungi.
  const nx = dz;
  const nz = -dx;
  return { nx, nz, dx, dz, len, rotY: Math.atan2(-nx, -nz) };
}

/**
 * Absolute top of the built work on a stage that has no construction level — a bare
 * footing or a rubble gap — at a point where the terrain stands at `localGround`.
 *
 * Exported because two things need the same answer and derived it separately once
 * already: `walkGeometry`, which reports one number per bay, and `CitySystem.masonryTopAt`,
 * which is asked per point and must not answer with the bay's maximum. Bay 2 crosses a
 * knoll and its footing runs from 10.4 m at the ends to 19.5 m over the rise, so a single
 * number for the bay is nine metres wrong at one end of it whichever number you pick.
 */
export function unfinishedTopAt(stage: BayStage, bayGroundY: number, localGround: number): number {
  return stage === 'footing'
    // A footing is two things at two references, and the top is whichever is higher here:
    // `buildFootingSite`'s concrete pour, *level* across the whole bay at
    // `min(g0,g1) + plinthHeight + 1`, and `buildCurtainBay`'s travertine plinth, which
    // follows the ground.
    ? Math.max(bayGroundY + WALL.plinthHeight + 1.0, localGround + WALL.plinthHeight)
    // `buildGapBarricade`: rammed earth and rubble, crest 2.5..3.4 m over the ground it
    // sits on, which it follows. The palisade above it is stakes, not a surface.
    : localGround + 3.4;
}

/**
 * Where the top of this bay is, and where on it a man can stand.
 *
 * **The single source of truth for the wall-walk's height**, called both by the geometry
 * builder that emits the stone and by the garrison API that puts men on it. They used to
 * derive it separately and disagreed: `Bay.topY` is the quantised construction level, but
 * a half-built bay is built at `max(g0,g1) + 3.4` instead and then carries 0.3 m of
 * exposed rubble core on top, so a garrison placed at `topY` stood a third of a metre
 * inside the masonry on exactly the bays the assault is aimed at.
 *
 * Offsets are measured along the outward normal from the bay centreline.
 */
function walkGeometry(bay: Bay): {
  walkY: number;
  crestY: number;
  sillY: number;
  parapetInner: number;
  parapetOuter: number;
  innerOff: number;
  outerOff: number;
  garrisonable: boolean;
} {
  const T = WALL.thickness;
  const gMin = Math.min(bay.g0, bay.g1);
  const stage = bay.stage;
  // Matches `buildCurtainBay` exactly.
  const topY = stage === 'half-built' ? Math.max(bay.g0, bay.g1) + 3.4 : bay.topY;
  // Outer face leans back 1-in-30 over the lift, so the walkway's outer lip is inboard
  // of the nominal half-thickness by the batter times the rise.
  const walkOuter = T * 0.5 - WALL.batter * Math.max(0, topY - (gMin + WALL.plinthHeight));
  // Body radius of a man, from `resolveCrowding`. He may not overlap the stonework.
  const BODY = 0.42;
  // The inner lip of the walk quad, less the walk's own 25 mm inset.
  const innerLip = -(T * 0.5 - 0.025);

  if (stage === 'footing' || stage === 'gap') {
    // No walkway: a footing is a knee-high concrete pour and a gap is an earth rampart
    // with a palisade on it. Both are places to fight *at*, not on.
    //
    // The height reported is what has been *built*, not `bay.topY`, which is the level
    // the finished wall will eventually reach. Those are the same number nowhere on this
    // circuit and forty metres apart on the Tiber bank, where bay 2's footing is a pour
    // at ground + 2.35 and its construction level is 48.4 because the level is held over
    // pairs of bays and its neighbour climbs a hill. `masonryTopAt` reported the latter,
    // so an arrow shot at an ankle-high footing stopped dead in clear air above it, and a
    // gap bay's obstacle box was a forty-metre invisible tower.
    //
    // One number for a whole bay, so it is the bay-wide *maximum*: `unfinishedTopAt`
    // evaluated at the highest ground in the run. `masonryTopAt` re-evaluates it per point.
    const built = unfinishedTopAt(stage, gMin, bay.gMax);
    return {
      walkY: built, crestY: built, sillY: built,
      parapetInner: 0, parapetOuter: 0,
      innerOff: 0, outerOff: 0, garrisonable: false,
    };
  }

  if (stage === 'half-built') {
    // Standing on the exposed rubble core, which is 0.3 m proud of the finished lift and
    // 2.95 m wide. No parapet at all, so keep men back from both lips.
    const half = (T - 0.55) * 0.5;
    return {
      walkY: topY + 0.3,
      crestY: topY + 0.3,
      sillY: topY + 0.3,
      parapetInner: half,
      parapetOuter: half,
      innerOff: -half + BODY,
      outerOff: half - BODY - 0.25,
      garrisonable: true,
    };
  }

  if (stage === 'no-parapet') {
    // Parapet not raised yet: dressed merlon blocks are stacked on the walk 1.1 m in
    // from the outer lip and are 0.8 m across, so the outward limit is inboard of them.
    return {
      walkY: topY,
      crestY: topY + 1.26,
      sillY: topY,
      // The stacked merlon blocks waiting to be set: 0.8 m across, 1.1 m in from the lip.
      parapetInner: walkOuter - 1.5,
      parapetOuter: walkOuter - 0.7,
      innerOff: innerLip + BODY,
      outerOff: walkOuter - 1.1 - 0.4 - BODY,
      garrisonable: true,
    };
  }

  // Finished. The parapet occupies [walkOuter - parapetThickness, walkOuter], and the
  // front rank stands with its shoulders against the inner face of it, which is what
  // shooting over a merlon looks like.
  //
  // Bays carrying the covered gallery have piers 0.6 m across on the centre of the
  // cityward half, spanning offsets [-1.55, -0.95]. The cityward limit is pulled in
  // clear of them rather than letting the rear rank stand inside a colonnade.
  const gallery = bay.index % 5 === 1;
  return {
    walkY: topY,
    crestY: topY + WALL.parapetHeight,
    // `buildCurtainBay` lays a solid 0.6 m sill and stands the merlons on top of it.
    sillY: topY + 0.6,
    parapetInner: walkOuter - WALL.parapetThickness,
    parapetOuter: walkOuter,
    innerOff: gallery ? -0.88 : innerLip + BODY,
    outerOff: walkOuter - WALL.parapetThickness - BODY,
    garrisonable: true,
  };
}

export function buildWall(heightAt: (x: number, z: number) => number, rngSeed: string): WallBuildOutput {
  const rng = new Rng(rngSeed);
  const path = fitWallPath(heightAt);
  const towerCount = Math.floor(WALL_LENGTH / WALL.towerSpacing) + 1;
  const gateBay = clamp(Math.round((GATE_X - WALL_X_MIN) / WALL.towerSpacing), 1, towerCount - 3);

  const zAt = (x: number): number => {
    if (x <= path[0].x) return path[0].z;
    const last = path[path.length - 1];
    if (x >= last.x) return last.z;
    const span = path[1].x - path[0].x;
    const i = Math.min(path.length - 2, Math.floor((x - path[0].x) / span));
    const t = (x - path[i].x) / (path[i + 1].x - path[i].x);
    return lerp(path[i].z, path[i + 1].z, t);
  };

  // --- bays, and a stepped wall-walk level for each --------------------------
  const nBays = towerCount - 1;
  const need = new Float64Array(nBays);
  /**
   * Highest terrain under each run, on a 1.5 m sample.
   *
   * Deliberately *not* the same seven samples `need` uses. `need` sets the quantised
   * construction level and changing its sampling moves the whole circuit's heights, but
   * the stages that follow the ground rather than a level — a footing's plinth, a gap's
   * rampart — need the real peak, and seven samples over 35.5 m misses it by a metre.
   */
  const gMaxOf = new Float64Array(nBays);
  for (let b = 0; b < nBays; b++) {
    const x0 = WALL_X_MIN + b * WALL.towerSpacing;
    const x1 = x0 + WALL.towerSpacing;
    let gmax = -Infinity;
    for (let s = 0; s <= 6; s++) {
      const x = lerp(x0, x1, s / 6);
      const g = heightAt(x, zAt(x));
      if (g > gmax) gmax = g;
    }
    need[b] = gmax + WALL.height;
    let fine = gmax;
    for (let s = 0; s <= 24; s++) {
      const x = lerp(x0, x1, s / 24);
      const g = heightAt(x, zAt(x));
      if (g > fine) fine = g;
    }
    gMaxOf[b] = fine;
  }
  // Quantise to 0.55 m construction increments, held over pairs of bays: flat runs
  // of ~71 m with a visible step between them.
  const level = new Float64Array(nBays);
  for (let b = 0; b < nBays; b++) {
    const pair = b - (b % 2);
    level[b] = Math.ceil(Math.max(need[pair], need[Math.min(nBays - 1, pair + 1)]) / 0.55) * 0.55;
  }

  const bays: Bay[] = [];
  const segments: WallSegmentOut[] = [];
  const blockers: Blocker[] = [];
  const bayStages: BayStage[] = [];
  const trees: TreeRequest[] = [];
  const garrisonBays: GarrisonBay[] = [];

  for (let b = 0; b < nBays; b++) {
    const x0 = WALL_X_MIN + b * WALL.towerSpacing;
    const x1 = x0 + WALL.towerSpacing;
    const isGate = b === gateBay;
    const stage: BayStage = isGate ? 'finished' : bayStage(b, nBays, gateBay);
    const bay: Bay = {
      index: b,
      x0,
      z0: zAt(x0),
      x1,
      z1: zAt(x1),
      topY: level[b],
      g0: heightAt(x0, zAt(x0)),
      g1: heightAt(x1, zAt(x1)),
      gMax: gMaxOf[b],
      stage,
      isGate,
      dress: true,
    };
    bays.push(bay);
    bayStages.push(stage);
    const h = stage === 'footing' ? 1.1 : stage === 'gap' ? 3.1 : stage === 'half-built' ? 3.4 : WALL.height;
    segments.push({
      x1: bay.x0, z1: bay.z0, x2: bay.x1, z2: bay.z1, height: h,
      gate: isGate,
      halfThickness: WALL.thickness * 0.5,
    });
    // A bare footing does not stop a man; everything else does.
    if (stage !== 'footing') {
      blockers.push({ x1: bay.x0, z1: bay.z0, x2: bay.x1, z2: bay.z1, halfW: WALL.thickness * 0.5 });
    }

    const f = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
    const walk = walkGeometry(bay);
    // A tower stands at the west end of every bay, and its ballista chamber occupies the
    // walkway there, so the garrison line is broken at each one. The only exception is a
    // west end that falls inside the gatehouse block, which has its own flanking towers.
    //
    // Keyed on where the block *is*, not on which bay is flagged `isGate`. The old rule
    // suppressed the towers at both ends of the gate bay, and the east one — 42.5 m from
    // the gate, in open curtain — was simply missing: the wall east of the Porta Flaminia
    // ended in a bare vertical face with nothing on it.
    const hasTower = !inGateBlock(bay.x0);
    garrisonBays.push({
      index: b,
      x0: bay.x0, z0: bay.z0, x1: bay.x1, z1: bay.z1,
      nx: f.nx, nz: f.nz, dx: f.dx, dz: f.dz, length: f.len,
      stage,
      walkY: walk.walkY,
      groundY: Math.min(bay.g0, bay.g1),
      crestY: walk.crestY,
      sillY: walk.sillY,
      parapetInner: walk.parapetInner,
      parapetOuter: walk.parapetOuter,
      innerOff: walk.innerOff,
      outerOff: walk.outerOff,
      // The gate block interrupts this run with monumental masonry whose crown is at its
      // own level, so no rank may be laid across it and the bay stands down as a whole.
      //
      // The 30 m of curtain this fix restored east of the block *is* an ordinary walk and
      // could carry a rank — pushing `towerHalf` past the block is enough to express it,
      // and it was tried. It is deliberately not done: bay 20's walk stands 14.50 m over
      // its own ground, because the construction level is held over the pair 20/21 and
      // bay 21 climbs to 36 m while bay 20's west end is at 28. `probe-siege` requires
      // every bay within five of the gate to be under 14 m so an escalade can reach it,
      // and manning a bay the ladders cannot take is worse than leaving it empty.
      garrisonable: walk.garrisonable && !isGate,
      walkable: walk.garrisonable,
      towerHalf: hasTower ? WALL.towerWidth * 0.5 : 0,
      hasTower,
      isGate,
    });
  }

  const gateBayRef = bays[gateBay];
  const gFrame = frameOf(gateBayRef.x0, gateBayRef.z0, gateBayRef.x1, gateBayRef.z1);
  const gateCz = lerp(gateBayRef.z0, gateBayRef.z1, (GATE_X - gateBayRef.x0) / WALL.towerSpacing);
  const gates: GateOut[] = [
    { id: 'porta-flaminia', x: GATE_X, z: gateCz, facing: Math.atan2(gFrame.nx, gFrame.nz), open: true },
  ];
  // The gatehouse as a solid, for the consumers that need to know where the masonry is.
  // Held separately from the bays because the block straddles two of them: reading it off
  // `bay.isGate` reported the block over 35.5 m of ground it does not stand on and missed
  // the 12.5 m of it that stands in the bay next door.
  const gateBlock: GateBlockOut = {
    x: GATE_X,
    z: gateCz,
    nx: gFrame.nx, nz: gFrame.nz, dx: gFrame.dx, dz: gFrame.dz,
    halfRun: GATE_BLOCK_W * 0.5,
    halfDepth: GATE_BLOCK_D * 0.5 + 0.45,
    topY: heightAt(GATE_X, gateCz) + GATE_PASS_H + GATE_ATTIC + GATE_MERLON_H,
    openHalf: GATE_OPEN_WIDTH * 0.5,
  };

  // --- chunk the curtain for culling and LOD --------------------------------
  const BAYS_PER_CHUNK = 8;
  const chunks: CityChunkSpec[] = [];
  for (let c = 0; c * BAYS_PER_CHUNK < bays.length; c++) {
    const from = c * BAYS_PER_CHUNK;
    const to = Math.min(bays.length, from + BAYS_PER_CHUNK);
    const slice = bays.slice(from, to);
    const cx = (slice[0].x0 + slice[slice.length - 1].x1) * 0.5;
    const cz = (slice[0].z0 + slice[slice.length - 1].z1) * 0.5;
    const radius = (slice[slice.length - 1].x1 - slice[0].x0) * 0.62 + 46;
    chunks.push({
      name: `wall-${c}`,
      cx,
      cz,
      radius,
      castShadow: true,
      lodSwitch: [340, 940],
      build: (batch, detail) => {
        batch.setUvOrigin(cx, 0, cz);
        const spans: [number, number][] = [];
        for (const bay of slice) {
          // Curtain everywhere the gatehouse is not, *including* across the gate bay.
          // The gate does not replace a bay; it is cut into one.
          curtainSpans(bay.x0, bay.x1, spans);
          for (let i = 0; i < spans.length; i++) {
            const [ax, bx] = spans[i];
            // A sliver shorter than a course band is not worth a panel.
            if (bx - ax < 0.5) continue;
            buildCurtainBay(
              batch, detail, clipBay(bay, ax, bx, i === 0), heightAt,
              rng.fork(i === 0 ? `bay-${bay.index}` : `bay-${bay.index}-${i}`)
            );
          }
          if (bay.isGate) buildGate(batch, detail, bay, heightAt, rng.fork(`gate-${bay.index}`));
        }
        // A tower at the west end of every bay, plus the far end of the last chunk.
        // A west end swallowed by the gatehouse gets none: the gate carries its own pair
        // of semicircular towers instead.
        for (const bay of slice) {
          if (inGateBlock(bay.x0)) continue;
          const prev = bays[bay.index - 1];
          const topY = Math.max(bay.topY, prev ? prev.topY : bay.topY);
          buildTower(batch, detail, bay.x0, bay.z0, topY, heightAt, bay.index, bay.stage, frameOf(bay.x0, bay.z0, bay.x1, bay.z1));
        }
        if (to === bays.length) {
          const last = slice[slice.length - 1];
          buildTower(batch, detail, last.x1, last.z1, last.topY, heightAt, bays.length, last.stage, frameOf(last.x0, last.z0, last.x1, last.z1));
        }
        if (from === 0) buildRiverTerminus(batch, detail, bays[0], heightAt);
      },
    });
  }

  // Cypress and pine against the inner face — the *pomerium* strip was planted.
  for (let i = 0; i < 220; i++) {
    const x = rng.range(WALL_X_MIN + 30, WALL_X_MAX - 30);
    if (Math.abs(x - GATE_X) < 30) continue;
    trees.push({
      x,
      // Kept clear of the curtain: a 20 m cypress planted three metres from the wall
      // swallows the camera on any close viewpoint.
      z: zAt(x) + rng.range(34, 76),
      kind: rng.bool(0.64) ? 'cypress' : 'pine',
      scale: rng.range(0.78, 1.12),
    });
  }

  return {
    path, chunks, segments, gates, gateBlock, blockers, trees,
    towerCount, bayStages, garrisonBays, wallZAt: zAt,
  };
}

// ---------------------------------------------------------------------------
// Curtain
// ---------------------------------------------------------------------------

/**
 * One face panel of the curtain: a quad at `centreline + n*off`, looking along
 * `n * faceSign`. Split per sub-bay so the base follows the ground.
 */
function facePanel(
  st: GeoStream,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  nx: number,
  nz: number,
  off0: number,
  off1: number,
  y0: number,
  y1: number,
  cLow: THREE.Color,
  cHigh: THREE.Color,
  faceSign: number
): void {
  P0.set(ax + nx * off0, y0, az + nz * off0);
  P1.set(bx + nx * off0, y0, bz + nz * off0);
  P2.set(bx + nx * off1, y1, bz + nz * off1);
  P3.set(ax + nx * off1, y1, az + nz * off1);
  OUT.set(nx * faceSign, 0, nz * faceSign);
  st.quadN(OUT, P0, P1, P2, P3, cLow, cLow, cHigh, cHigh);
}

function buildCurtainBay(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number,
  rng: Rng
): void {
  if (bay.stage === 'gap') {
    buildGapBarricade(batch, detail, bay, heightAt, rng);
    return;
  }

  const brick = batch.s('brick');
  const stone = batch.s('stone');
  const f = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const { nx, nz, dx, dz, len } = f;
  const stage = bay.stage;
  const T = WALL.thickness;
  const gMin = Math.min(bay.g0, bay.g1);
  const topY = stage === 'half-built' ? Math.max(bay.g0, bay.g1) + 3.4 : bay.topY;
  const subs = detail >= 2 ? 16 : detail === 1 ? 5 : 1;
  const plinthTop = (g: number): number => g + WALL.plinthHeight;

  const brickLow = new THREE.Color().copy(PAL.brick).multiplyScalar(0.68);
  const brickHigh = new THREE.Color().copy(PAL.brickPale).multiplyScalar(1.08);

  // ---- travertine footing, following the ground ----------------------------
  for (let s = 0; s < subs; s++) {
    const t0 = s / subs;
    const t1 = (s + 1) / subs;
    const ax = lerp(bay.x0, bay.x1, t0);
    const az = lerp(bay.z0, bay.z1, t0);
    const bx = lerp(bay.x0, bay.x1, t1);
    const bz = lerp(bay.z0, bay.z1, t1);
    const gA = heightAt(ax, az);
    const gB = heightAt(bx, bz);
    const gm = Math.min(gA, gB);
    const dirty = new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(0.88 + hash2(s, bay.index, 7) * 0.24);
    // Sunk 1.8 m so no gap can open if the heightfield is regenerated under us, and
    // topped from the *higher* end of the sub-bay, not the lower.
    //
    // Taking the top from `gm` meant that wherever the ground climbed more than the
    // 1.35 m plinth across one 2.2 m sub-bay, the course was buried and nothing stood
    // above the turf. On the Tiber bank, where bay 2's footing crosses a knoll, that
    // erased nine metres of the circuit: rays cast across the wall at a metre above the
    // ground came out the other side. A footing follows the slope; it does not drown in it.
    quadPrism(stone, ax, az, bx, bz, nx, nz, T + WALL.plinthProject * 2, gm - 1.8, Math.max(gA, gB) + WALL.plinthHeight, dirty, PAL.travertine, {
      ends: false,
    });
  }

  if (stage === 'footing') {
    buildFootingSite(batch, detail, bay, heightAt, rng);
    return;
  }

  // ---- brick face in bands, with the batter leaning the outer face back ----
  const bandH = WALL.courseBand;
  const outerOff = (y: number, baseY: number): number => T * 0.5 - WALL.batter * Math.max(0, y - baseY);

  for (let s = 0; s < subs; s++) {
    const t0 = s / subs;
    const t1 = (s + 1) / subs;
    const ax = lerp(bay.x0, bay.x1, t0);
    const az = lerp(bay.z0, bay.z1, t0);
    const bx = lerp(bay.x0, bay.x1, t1);
    const bz = lerp(bay.z0, bay.z1, t1);
    const gm = Math.min(heightAt(ax, az), heightAt(bx, bz));
    const y0 = plinthTop(gm);
    if (topY - y0 < 0.25) continue;
    const bands = detail >= 2 ? Math.max(1, Math.round((topY - y0) / bandH)) : 1;

    for (let k = 0; k < bands; k++) {
      const by0 = y0 + ((topY - y0) * k) / bands;
      const by1 = y0 + ((topY - y0) * (k + 1)) / bands;
      // Alternate lifts are set back 45 mm. A single day's work was one lift of
      // facing brick against the poured core, and the setback is what makes the
      // 6.5 m of masonry read as courses rather than as an extruded box.
      const proud = k % 2 === 0 ? 0 : -0.045;
      // Brick came from many kilns and stretches were patched: vary each panel by a
      // low-frequency hash so the face is blotchy at the metre scale, not just the
      // millimetre scale the texture handles.
      // Halved from 0.2.
      //
      // A blind critic separated our frames from Rome II's on exactly this surface, and the
      // strongest thing it named was "a flat diffuse brick tile with visible horizontal UV
      // seams". The missing normal map is in `city/materials.ts` and not this workstream's to
      // add, but the *seams* it read are partly authored here: a per-panel tone drawn from a
      // hash on `floor(s / 3)` steps in value every third sub-bay, which at 16 sub-bays to a
      // 35.5 m run puts a visible vertical join every 6.7 m along the wall and makes adjacent
      // panels look offset. The blotchiness is worth having; this much of it is not.
      const patch = hash2(Math.floor(s / 3), Math.floor(k / 2) + bay.index * 5, 811) * 0.5;
      // Weathering, top to bottom: sun-bleached at the parapet, rain-washed through the
      // middle, and a metre of splash-back dirt at the footing. This is the *only*
      // vertical gradient the face should carry, and it runs over the whole 6.5 m.
      const fLo = (by0 - y0) / Math.max(1, topY - y0);
      const fHi = (by1 - y0) / Math.max(1, topY - y0);
      const weather = (f: number): number =>
        0.72 + 0.30 * Math.min(1, f * 3.4) + 0.12 * f;
      const tone = clamp(0.90 + hash2(s, k * 13 + bay.index, 3) * 0.05 + patch * 0.2, 0.82, 1.10);
      // Per-lift shading is now *slight*. At 1.1 m per lift a strong low-to-high ramp
      // stacks into six pale-and-dark stripes up the wall, and that banding, not the
      // brickwork, becomes what the eye reads — the single worst thing about the first
      // pass of this curtain.
      const cLo = new THREE.Color()
        .copy(k === 0 ? brickLow : PAL.brick)
        .multiplyScalar(tone * weather(fLo) * 0.97);
      const cHi = new THREE.Color()
        .copy(by1 > topY - 1.3 ? brickHigh : PAL.brick)
        .multiplyScalar(tone * weather(fHi) * 1.03);
      facePanel(brick, ax, az, bx, bz, nx, nz, outerOff(by0, y0) + proud, outerOff(by1, y0) + proud, by0, by1, cLo, cHi, 1);
      facePanel(brick, ax, az, bx, bz, nx, nz, -T * 0.5, -T * 0.5, by0, by1, cLo, cHi, -1);
    }
  }

  // Tile string courses: bands of *bipedales* projecting 60 mm — the bonding courses
  // that tie the brick face into the concrete core, and the wall's strongest rhythm.
  if (detail >= 1) {
    const y0 = plinthTop(gMin);
    // Bonding courses at every second lift, not every one: at 1.1 m spacing the face
    // reads as a striped fence rather than as brickwork.
    const nBands = Math.max(1, Math.round((topY - y0) / bandH));
    for (let k = 2; k < nBands; k += 2) {
      const y = y0 + ((topY - y0) * k) / nBands;
      quadPrism(brick, bay.x0, bay.z0, bay.x1, bay.z1, nx, nz, T + 0.17, y - 0.11, y, PAL.tileCourse, PAL.brickDark, {
        ends: false,
      });
    }
  }

  // A projecting dado two courses above the footing: standard practice, and it
  // stops the base of the wall reading as a knife edge against the ground.
  if (detail >= 1) {
    const dy = plinthTop(gMin) + 0.34;
    quadPrism(brick, bay.x0, bay.z0, bay.x1, bay.z1, nx, nz, T + 0.44, dy - 0.2, dy, PAL.brickDark, PAL.travertine, { ends: false });
  }

  // Blind arched recesses in the inner face. The Aurelianic builders saved material
  // and mortar this way, and the arcading is the strongest thing you see looking
  // along the inside of the curtain.
  if (detail >= 1 && topY - plinthTop(gMin) > 4.4) {
    const nArch = Math.max(3, Math.round(len / WALL.innerArchSpacing));
    const aw = len / nArch;
    for (let i = 0; i < nArch; i++) {
      const t = (i + 0.5) / nArch;
      // 6 mm proud of the inner face, not flush with it.
      //
      // `archPanel` draws its own solid field around the opening, and at `T * 0.5` exactly
      // that field is coplanar with the curtain's inner face quad. Two coplanar surfaces
      // z-fight, and the arcading — the strongest thing you see looking along the inside of
      // the wall — dissolved into checkerboard stipple at every distance. A reviewer given
      // only the renders named it the most repeated blemish on the circuit.
      const px = lerp(bay.x0, bay.x1, t) - nx * (T * 0.5 + 0.006);
      const pz = lerp(bay.z0, bay.z1, t) - nz * (T * 0.5 + 0.006);
      const gA = heightAt(px, pz);
      const y0 = plinthTop(gA) + 0.5;
      const h = topY - 0.9 - y0;
      if (h < 3.2) continue;
      brick.push(new THREE.Matrix4().makeRotationY(f.rotY + Math.PI).setPosition(px, y0, pz));
      archPanel(brick, aw + 0.02, h, PAL.brick, {
        depth: 0.55,
        spring: h - aw * 0.42,
        openWidth: aw * 0.74,
        segments: detail >= 2 ? 8 : 5,
        voidCol: new THREE.Color().copy(PAL.brickDark).multiplyScalar(0.5),
      });
      // Back of the recess, 0.55 m in — a blind arch, not a hole through the wall.
      box(brick, -aw * 0.4, 0, 0.55, aw * 0.4, h - aw * 0.42 + aw * 0.37, 0.66, new THREE.Color().copy(PAL.brick).multiplyScalar(0.6), {
        zMin: false,
      });
      brick.pop();
    }
  }

  // Weep holes just under the wall-walk, draining the rubble core.
  if (detail >= 2) {
    const dark = new THREE.Color(0.03, 0.026, 0.021);
    for (let i = 0; i < 9; i++) {
      const t = (i + 0.5) / 9;
      const px = lerp(bay.x0, bay.x1, t) + nx * (outerOff(topY - 0.7, plinthTop(gMin)) - 0.04);
      const pz = lerp(bay.z0, bay.z1, t) + nz * (outerOff(topY - 0.7, plinthTop(gMin)) - 0.04);
      quadPrism(brick, px - dx * 0.13, pz - dz * 0.13, px + dx * 0.13, pz + dz * 0.13, nx, nz, 0.2, topY - 0.9, topY - 0.68, dark, dark, {
        ends: false,
      });
    }
  }

  // Putlog holes: the sockets the scaffold poles left, on the 1.1 m lift grid.
  // Drawn as small dark prisms sitting a hair proud of the face rather than modelled
  // recesses — beyond a few metres the read is identical for a fraction of the
  // triangles, and there are several thousand of them round the circuit.
  if (detail >= 2) {
    const y0 = plinthTop(gMin);
    const dark = new THREE.Color(0.022, 0.02, 0.017);
    const nLifts = Math.max(1, Math.floor((topY - y0 - 1.2) / (bandH * 2)));
    for (let k = 0; k < nLifts; k++) {
      const y = y0 + 1.0 + k * bandH * 2;
      for (let s = 0; s < 12; s++) {
        if (hash2(s, k + bay.index * 17, 41) < 0.42) continue;
        const t = (s + 0.5) / 12;
        const px = lerp(bay.x0, bay.x1, t) + nx * (outerOff(y, y0) - 0.06);
        const pz = lerp(bay.z0, bay.z1, t) + nz * (outerOff(y, y0) - 0.06);
        quadPrism(brick, px - dx * 0.1, pz - dz * 0.1, px + dx * 0.1, pz + dz * 0.1, nx, nz, 0.22, y, y + 0.2, dark, dark, {
          ends: false,
        });
      }
    }
  }

  // ---- wall-walk ----------------------------------------------------------
  const walkOuter = outerOff(topY, plinthTop(gMin));
  // The wall-walk is a working surface: trodden, dusty and much darker than the
  // dressed travertine it is made of.
  quadPrism(
    stone,
    bay.x0,
    bay.z0,
    bay.x1,
    bay.z1,
    nx,
    nz,
    T - 0.05,
    topY - 0.24,
    topY,
    PAL.travertineDirty,
    new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(0.86),
    { ends: false }
  );

  if (stage === 'half-built') {
    // Exposed rubble core on top of the unfinished lift.
    const core = batch.s('concrete');
    quadPrism(core, bay.x0, bay.z0, bay.x1, bay.z1, nx, nz, T - 0.55, topY - 0.06, topY + 0.3, PAL.concrete, PAL.mortar, {
      ends: false,
    });
    if (bay.dress) {
      buildScaffold(batch, detail, bay, heightAt, topY, rng);
      buildYard(batch, detail, bay, heightAt, rng);
    }
    return;
  }

  // ---- parapet -------------------------------------------------------------
  if (stage !== 'no-parapet') {
    const pT = WALL.parapetThickness;
    const lipOff = walkOuter - pT * 0.5;
    const px0 = bay.x0 + nx * lipOff;
    const pz0 = bay.z0 + nz * lipOff;
    const px1 = bay.x1 + nx * lipOff;
    const pz1 = bay.z1 + nz * lipOff;
    // Sill, then merlons on top of it. The merlons carry their own travertine cap —
    // a continuous coping over the whole run turns the battlements into a dentil
    // frieze and the wall stops reading as defensible.
    quadPrism(brick, px0, pz0, px1, pz1, nx, nz, pT, topY, topY + 0.6, PAL.brick, PAL.travertine, { ends: false });
    crenellation(brick, px0, pz0, px1, pz1, topY + 0.6, WALL.parapetHeight - 0.6, pT, PAL.brick, 1.7, 0.95, detail >= 1);
  } else {
    // Parapet not raised yet: dressed merlon blocks stacked on the walk, waiting.
    for (let s = 0; s < 5; s++) {
      const t = 0.12 + s * 0.19;
      const px = lerp(bay.x0, bay.x1, t) + nx * (walkOuter - 1.1);
      const pz = lerp(bay.z0, bay.z1, t) + nz * (walkOuter - 1.1);
      const rows = 1 + Math.floor(hash2(s, bay.index, 5) * 3);
      for (let r = 0; r < rows; r++) {
        quadPrism(
          stone,
          px - dx * 0.7,
          pz - dz * 0.7,
          px + dx * 0.7,
          pz + dz * 0.7,
          nx,
          nz,
          0.8,
          topY + r * 0.42,
          topY + (r + 1) * 0.42 - 0.03,
          PAL.travertine,
          PAL.travertine
        );
      }
    }
    if (bay.dress) {
      buildScaffold(batch, detail, bay, heightAt, topY, rng);
      buildYard(batch, detail, bay, heightAt, rng);
    }
  }

  // Covered gallery over the wall-walk on some finished stretches. Strictly this
  // belongs to the Honorian rebuild; the brief asks for it and it gives the
  // silhouette a rhythm the bare curtain lacks.
  if (stage === 'finished' && detail >= 1 && bay.index % 5 === 1) {
    const roofSt = batch.s('roof');
    const piers = 8;
    const innerOff = -(T * 0.5 - 0.5);
    for (let s = 0; s <= piers; s++) {
      const t = s / piers;
      const px = lerp(bay.x0, bay.x1, t) + nx * innerOff;
      const pz = lerp(bay.z0, bay.z1, t) + nz * innerOff;
      quadPrism(brick, px - dx * 0.3, pz - dz * 0.3, px + dx * 0.3, pz + dz * 0.3, nx, nz, 0.6, topY, topY + 2.6, PAL.brick, PAL.travertine);
    }
    const oOff = walkOuter - 0.15;
    P0.set(bay.x0 + nx * oOff, topY + WALL.parapetHeight + 0.25, bay.z0 + nz * oOff);
    P1.set(bay.x1 + nx * oOff, topY + WALL.parapetHeight + 0.25, bay.z1 + nz * oOff);
    P2.set(bay.x1 + nx * (innerOff - 0.55), topY + 3.0, bay.z1 + nz * (innerOff - 0.55));
    P3.set(bay.x0 + nx * (innerOff - 0.55), topY + 3.0, bay.z0 + nz * (innerOff - 0.55));
    OUT.set(nx * 0.4, 1, nz * 0.4).normalize();
    roofSt.quadN(OUT, P0, P1, P2, P3, PAL.roofTile, PAL.roofTile, PAL.roofTileOld, PAL.roofTileOld);
  }
}

// ---------------------------------------------------------------------------
// Towers
// ---------------------------------------------------------------------------

function buildTower(
  batch: Batch,
  detail: number,
  x: number,
  z: number,
  topY: number,
  heightAt: (x: number, z: number) => number,
  index: number,
  stage: BayStage,
  f: Frame
): void {
  const brick = batch.s('brick');
  const stone = batch.s('stone');
  const roof = batch.s('roof');
  const g = heightAt(x, z);
  const W = WALL.towerWidth;
  const T = WALL.thickness;
  const proj = WALL.towerProject;
  // Modules are authored with −Z outward; `f.rotY` turns that onto the wall run.
  const m = new THREE.Matrix4().makeRotationY(f.rotY).setPosition(x, 0, z);
  // Through `pushAll`, which resolves material aliases: at far detail all three of these
  // are the same stream, and pushing per key composed the placement matrix three times —
  // towers scattered to roughly 3x their position. See `Batch.distinct`.
  const used = batch.pushAll(TOWER_KEYS, m);

  const zOuter = -(T * 0.5 + proj);
  const zInner = T * 0.5;
  const unfinished = stage === 'footing' || stage === 'gap';
  const bodyTop = unfinished ? g + 2.7 : topY;

  box(stone, -W / 2 - 0.32, g - 2.0, zOuter - 0.32, W / 2 + 0.32, g + WALL.plinthHeight, zInner + 0.32, PAL.travertineDirty, {
    topGain: 1.1,
  });
  box(brick, -W / 2, g + WALL.plinthHeight, zOuter, W / 2, bodyTop, zInner, PAL.brick, {
    batter: WALL.batter * 0.6,
    groundShade: 0.3,
    topGain: 1.05,
  });

  if (detail >= 2 && !unfinished) {
    // Travertine quoins up each outer corner: the strongest single cue that this is
    // dressed masonry and not a box.
    for (const sx of [-1, 1]) {
      const cx = (sx * W) / 2;
      const n = Math.floor((bodyTop - g - WALL.plinthHeight) / 0.62);
      for (let k = 0; k < n; k += 2) {
        const y = g + WALL.plinthHeight + k * 0.62;
        box(stone, cx - (sx > 0 ? 0.66 : 0.05), y, zOuter - 0.05, cx + (sx > 0 ? 0.05 : 0.66), y + 0.55, zOuter + 0.5, PAL.travertine, {
          zMax: false,
        });
      }
    }
    const nb = Math.max(1, Math.round((bodyTop - g - WALL.plinthHeight) / WALL.courseBand));
    for (let k = 1; k < nb; k++) {
      const y = g + WALL.plinthHeight + ((bodyTop - g - WALL.plinthHeight) * k) / nb;
      box(brick, -W / 2 - 0.08, y - 0.09, zOuter - 0.08, W / 2 + 0.08, y, zInner + 0.08, PAL.brickDark, { topGain: 1.22 });
    }
  }

  if (unfinished) {
    batch.popAll(used);
    return;
  }

  // ---- ballista chamber ---------------------------------------------------
  const chH = WALL.towerChamberHeight;
  const chTop = topY + chH;
  const inset = 0.16;
  const wallT = 0.75;
  // Projecting cornice at the wall-walk line. Without it the chamber looks like a
  // smaller box balanced on a bigger one instead of a storey of the same tower.
  box(stone, -W / 2 - 0.34, topY - 0.42, zOuter - 0.34, W / 2 + 0.34, topY, zInner + 0.34, PAL.travertine, { topGain: 1.2 });
  const cx0 = -W / 2 + inset;
  const cx1 = W / 2 - inset;
  const cz0 = zOuter + inset;
  const cz1 = zInner - inset;
  box(stone, cx0, topY - 0.12, cz0, cx1, topY, cz1, PAL.travertineDirty, { topGain: 1.06 });
  const chTone = (k: number): THREE.Color =>
    new THREE.Color().copy(PAL.brick).multiplyScalar(0.82 + hash2(index, k, 331) * 0.34);
  /**
   * The chamber's two side walls, pierced on the line of the wall-walk.
   *
   * They used to be solid, so the walk ran into 0.75 m of blank brick at every one of
   * forty-eight towers — a reviewer reading only the frames called it a dead end, and it
   * is: the only way in was a doorway on the *city* face, which a man walking the parapet
   * cannot reach. A chamber astride the walk has to be walked through.
   *
   * The opening spans the clear standing band `walkGeometry` publishes — from the inner
   * face of the parapet to the walk's cityward lip — rather than being centred on the
   * chamber, whose centre is 1.75 m outboard of the walk over the tower's projection.
   */
  const doorOuter = -0.35;
  const doorInner = 1.35;
  const doorHead = topY + 2.25;
  for (const sx of [-1, 1]) {
    const a = sx < 0 ? cx0 : cx1 - wallT;
    const b = sx < 0 ? cx0 + wallT : cx1;
    const tone = chTone(sx < 0 ? 1 : 2);
    if (detail < 1) {
      box(brick, a, topY, cz0, b, chTop, cz1, tone, { topGain: 1.1, groundShade: 0.14 });
      continue;
    }
    box(brick, a, topY, cz0, b, chTop, doorOuter, tone, { topGain: 1.1, groundShade: 0.14 });
    box(brick, a, topY, doorInner, b, chTop, cz1, tone, { topGain: 1.1, groundShade: 0.14 });
    box(brick, a, doorHead, doorOuter, b, chTop, doorInner, tone, { topGain: 1.1, groundShade: 0.14 });
    // Travertine lintel over the opening, so the head reads as dressed rather than sawn.
    box(stone, a - 0.06, doorHead - 0.22, doorOuter - 0.06, b + 0.06, doorHead, doorInner + 0.06, PAL.travertine, {
      topGain: 1.16,
    });
  }
  box(brick, cx0 + wallT, topY, cz1 - wallT, cx1 - wallT, chTop, cz1, chTone(3), { topGain: 1.1, groundShade: 0.14 });

  // Front wall pierced by the ballista embrasure.
  brick.pushTranslate(0, topY, cz0);
  archPanel(brick, cx1 - cx0, chH, PAL.brick, {
    depth: wallT,
    spring: 1.5,
    openWidth: Math.min(2.5, (cx1 - cx0) * 0.5),
    segments: detail >= 2 ? 9 : 5,
    archivolt: detail >= 2 ? 0.13 : 0,
  });
  brick.pop();

  if (detail >= 1) {
    // Side loopholes covering the curtain either way.
    const dark = new THREE.Color(0.016, 0.015, 0.013);
    for (const sx of [-1, 1]) {
      const px = sx * (W / 2 - inset - wallT * 0.5);
      box(brick, px - 0.13, topY + 1.4, -0.4, px + 0.13, topY + 2.9, 0.4, dark, { top: false });
    }
  }

  // Tiled hip roof: the chamber was covered, because the ballista needed cover.
  hipRoof(roof, W - inset * 2 + 0.9, zInner - zOuter - inset * 2 + 0.9, chTop, WALL.towerRoofHeight, 0.45, PAL.roofTileOld);
  box(brick, cx0 - 0.4, chTop - 0.2, cz0 - 0.4, cx1 + 0.4, chTop, cz1 + 0.4, PAL.brickDark, { top: false });

  // Doorway from the wall-walk into the chamber, on the city side.
  brick.pushTranslate(0, topY, cz1 - wallT);
  archPanel(brick, cx1 - cx0 - wallT * 2, chH, PAL.brick, { depth: wallT, spring: 1.45, openWidth: 1.15, segments: detail >= 2 ? 7 : 4 });
  brick.pop();

  // Stair down to the ground on the inner face every fourth tower — the way the
  // garrison actually got up there.
  if (detail >= 1 && index % 4 === 2) {
    stone.pushTranslate(0, 0, zInner);
    const rise = 0.31;
    const n = Math.max(4, Math.round((topY - g) / rise));
    steps(stone, 2.4, g, n * 0.34 + 0.5, n, rise, 0.34, PAL.travertineDirty);
    stone.pop();
  }

  batch.popAll(used);
}

/** Every stream `buildTower` touches. See `Batch.distinct`. */
const TOWER_KEYS: readonly CityMatKey[] = ['brick', 'stone', 'roof'];

// ---------------------------------------------------------------------------
// Gate — the Porta Flaminia, on the axis of the Via Flaminia
// ---------------------------------------------------------------------------

/** Every stream `buildGate` touches. See `Batch.distinct`. */
const GATE_KEYS: readonly CityMatKey[] = ['brick', 'stone', 'metal', 'timber', 'roof', 'road'];

function buildGate(batch: Batch, detail: number, bay: Bay, heightAt: (x: number, z: number) => number, rng: Rng): void {
  const brick = batch.s('brick');
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const timber = batch.s('timber');
  const roof = batch.s('roof');
  const road = batch.s('road');

  const f = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const cx = GATE_X;
  const cz = lerp(bay.z0, bay.z1, (GATE_X - bay.x0) / WALL.towerSpacing);
  const g = heightAt(cx, cz);

  // The approach: built in world space before the gate's own frame is pushed, so the
  // carriageway can follow the ground. Everything the camera sees in the foreground of
  // the standard `city` viewpoint lives here, and without it that frame is half grass.
  buildGateApproach(batch, detail, cx, cz, f, heightAt, rng);

  const m = new THREE.Matrix4().makeRotationY(f.rotY).setPosition(cx, 0, cz);
  // See `Batch.distinct`: at mid detail these six keys are three streams and at far detail
  // one, so pushing per key put the whole 25 x 11 m gate block at `m^3` and `m^6`.
  const used = batch.pushAll(GATE_KEYS, m);

  // 11 m of masonry front to back so the passage is a real tunnel, and an attic
  // above the arch for the dedicatory inscription. The curtain is cut back to leave this
  // span clear — see `GATE_BLOCK_W` and `curtainSpans`.
  const blockW = GATE_BLOCK_W;
  const blockD = GATE_BLOCK_D;
  const passH = GATE_PASS_H;
  const attic = GATE_ATTIC;
  const blockTop = g + passH + attic;
  const zF = -blockD * 0.5;

  // Travertine socle, in two piers with the carriageway between them.
  //
  // It used to be one box across the whole 25 m, which put 1.15 m of solid stone across
  // the passage: the brick face starts at `g + 1.15` and the socle filled everything
  // below it, so the one road into Rome had a chest-high step in it, 3.4 m behind the
  // doors where no camera could see it. A ray down the centreline at 0.5 m struck it.
  const socleHalf = blockW / 2 + 0.45;
  const openHalf = GATE_OPEN_WIDTH * 0.5;
  for (const s of [-1, 1]) {
    box(stone, s > 0 ? openHalf : -socleHalf, g - 2.4, zF - 0.45, s > 0 ? socleHalf : -openHalf, g + 1.15, blockD * 0.5 + 0.45, PAL.travertineDirty, {
      topGain: 1.08,
    });
  }
  // A threshold slab in the opening: a real gate has one, worn into ruts, and it caps the
  // ground under the tunnel so the terrain cannot show through the basalt.
  box(stone, -openHalf, g - 2.4, zF - 0.45, openHalf, g + 0.12, blockD * 0.5 + 0.45, PAL.travertineDirty, {
    topGain: 1.14,
  });

  brick.pushTranslate(0, g + 1.15, zF);
  archPanel(brick, blockW, passH + attic - 1.15, PAL.brick, {
    depth: blockD,
    spring: 4.3,
    openWidth: GATE_OPEN_WIDTH,
    segments: detail >= 2 ? 16 : 8,
    backFace: true,
    archivolt: detail >= 1 ? 0.4 : 0,
    voidCol: new THREE.Color(0.028, 0.026, 0.022),
  });
  brick.pop();

  /**
   * End walls closing the block.
   *
   * `archPanel` builds a front face, a back face and the reveals between them — it has no
   * end caps, so the 25 x 11 m gate block was a shell open along both of its 11 m ends.
   * The curtain only covers 3.5 m of that, which left roughly 4 m of full-height daylight
   * either side of it: from an oblique camera east or west of the gate you looked straight
   * in one end of the gatehouse and out of the other. The cornice caps the top and the
   * socle the bottom, so only the storey between them needs closing.
   */
  for (const s of [-1, 1]) {
    const ex = (s * blockW) / 2;
    box(brick, Math.min(ex, ex - s * 0.09), g + 1.15, zF, Math.max(ex, ex - s * 0.09), blockTop, blockD * 0.5, PAL.brick, {
      groundShade: 0.18,
      topGain: 1.04,
    });
  }

  // Travertine voussoirs framing the arch. The gate was dressed in stone even where
  // the curtain is bare brick, because it is the face the city shows the world.
  if (detail >= 1) {
    const r = GATE_OPEN_WIDTH * 0.5;
    const spring = g + 1.15 + 4.3;
    const nV = 13;
    const midR = r + 0.32;
    for (let i = 0; i < nV; i++) {
      const a0 = Math.PI - (Math.PI * i) / nV;
      const a1 = Math.PI - (Math.PI * (i + 1)) / nV;
      const am = (a0 + a1) * 0.5;
      const halfArc = ((Math.PI / nV) * midR) / 2;
      const tx = -Math.sin(am);
      const ty = Math.cos(am);
      const vx = Math.cos(am) * midR;
      const vy = spring + Math.sin(am) * midR;
      const c = new THREE.Color().copy(PAL.travertine).multiplyScalar(0.92 + hash2(i, 3, 11) * 0.17);
      P0.set(vx - tx * halfArc, vy - ty * halfArc, zF - 0.5);
      P1.set(vx + tx * halfArc, vy + ty * halfArc, zF - 0.5);
      P2.set(P1.x + Math.cos(am) * 0.66, P1.y + Math.sin(am) * 0.66, zF - 0.5);
      P3.set(P0.x + Math.cos(am) * 0.66, P0.y + Math.sin(am) * 0.66, zF - 0.5);
      OUT.set(0, 0, -1);
      stone.quadN(OUT, P0, P1, P2, P3, c);
      OUT.set(Math.cos(am), Math.sin(am), 0);
      P0.set(P3.x, P3.y, zF - 0.5);
      P1.set(P2.x, P2.y, zF - 0.5);
      P2.set(P1.x, P1.y, zF);
      P3.set(P0.x, P0.y, zF);
      stone.quadN(OUT, P0, P1, P2, P3, new THREE.Color().copy(c).multiplyScalar(0.78));
    }
  }

  // ---- inscribed attic ----------------------------------------------------
  const insY = g + passH + 1.0;
  box(stone, -7.6, insY, zF - 0.58, 7.6, insY + 2.8, zF, PAL.marble, { topGain: 1.1 });
  box(stone, -8.1, insY - 0.38, zF - 0.76, 8.1, insY, zF, PAL.travertine, { topGain: 1.2 });
  box(stone, -8.1, insY + 2.8, zF - 0.76, 8.1, insY + 3.2, zF, PAL.travertine, { topGain: 1.2 });
  if (detail >= 1) {
    // The inscription: gilt-bronze letters set into cut beds. Modelled as rows of
    // small raised blocks — legible as lettering at 60 m, which is all that matters.
    for (let line = 0; line < 3; line++) {
      const y = insY + 2.05 - line * 0.78;
      let px = -6.6 - hash2(line, 1, 5) * 0.35;
      while (px < 6.3) {
        const w = 0.22 + hash2(Math.round(px * 10), line, 9) * 0.2;
        box(metal, px, y, zF - 0.65, px + w, y + 0.46, zF - 0.58, PAL.gilt, { zMax: false });
        px += w + 0.15 + hash2(Math.round(px * 7), line + 3, 13) * 0.12;
      }
    }
  }

  // ---- crowning cornice and battlements -----------------------------------
  box(stone, -blockW / 2 - 0.65, blockTop - 0.55, zF - 0.65, blockW / 2 + 0.65, blockTop, blockD * 0.5 + 0.65, PAL.travertine, {
    topGain: 1.18,
  });
  crenellation(brick, -blockW / 2, zF + 0.5, blockW / 2, zF + 0.5, blockTop, GATE_MERLON_H, 0.9, PAL.brick, 1.5, 0.8, detail >= 1);

  // ---- flanking semicircular towers ---------------------------------------
  // Aurelian's major gates were flanked by semicircular towers rising well above the
  // curtain; the Porta Flaminia's survive inside the later Porta del Popolo.
  // Slender enough to read as towers rather than chimneys: 9.2 m across, 18.6 tall.
  const towerR = 4.6;
  const towerX = GATE_OPEN_WIDTH * 0.5 + towerR + 1.9;
  const towerTop = g + 18.6;
  const seg = detail >= 2 ? 16 : detail === 1 ? 10 : 6;
  for (const s of [-1, 1]) {
    const tx = s * towerX;
    const tz = zF + 0.5;
    cylinder(stone, tx, g - 2.0, tz, towerR + 0.78, towerR + 0.52, 3.3, seg, PAL.travertineDirty, { arcFrom: Math.PI, arcTo: Math.PI * 2 });
    cylinder(brick, tx, g + 1.3, tz, towerR + 0.52, towerR * 0.94, towerTop - g - 1.3, seg, PAL.brick, {
      arcFrom: Math.PI,
      arcTo: Math.PI * 2,
      shadeLow: 0.26,
    });
    // Flat chord closing the back of the semicircle, buried in the gate block.
    box(brick, tx - towerR - 0.6, g - 2.0, tz - 0.12, tx + towerR + 0.6, towerTop, tz, PAL.brick, { zMin: false });
    // The drum tapers, so a string course has to be sized from the radius at its own
    // height or it disappears inside the brickwork.
    const drumR = (y: number): number => {
      const t = clamp((y - (g + 1.3)) / (towerTop - g - 1.3), 0, 1);
      return towerR + 0.52 + (towerR * 0.94 - towerR - 0.52) * t;
    };
    if (detail >= 1) {
      const nb = Math.round((towerTop - g - 1.3) / WALL.courseBand);
      for (let k = 1; k < nb; k++) {
        const y = g + 1.3 + ((towerTop - g - 1.3) * k) / nb;
        const rr = drumR(y) + 0.16;
        // `bottom` as well as `top`: these project 0.16 m past the drum and an open
        // underside is the same daylight sliver the cornice had, thirty times over.
        cylinder(brick, tx, y - 0.14, tz, rr, rr, 0.14, seg, PAL.tileCourse, {
          arcFrom: Math.PI,
          arcTo: Math.PI * 2,
          top: true,
          bottom: true,
        });
      }
      // Arched windows lighting the tower chambers. Set 0.3 m proud of the drum so the
      // curvature cannot swallow a flat panel, which reads as a stone surround.
      for (let lv = 0; lv < 2; lv++) {
        const wy = g + 6.6 + lv * 5.1;
        brick.pushTranslate(tx, wy, tz - drumR(wy) - 0.3);
        archPanel(brick, 2.5, 3.9, PAL.brick, {
          depth: 1.2,
          spring: 1.6,
          openWidth: 1.2,
          segments: detail >= 2 ? 8 : 5,
          archivolt: detail >= 2 ? 0.14 : 0,
          voidCol: new THREE.Color(0.018, 0.016, 0.013),
        });
        brick.pop();
      }
    }
    /**
     * Crowning cornice, splayed out of the drum rather than perched on it.
     *
     * The ring alone was 1.08 R over a drum that tapers to 0.94 R, and `cylinder` emits no
     * bottom face unless asked: 0.65 m of open annulus with the sky behind it, all the way
     * round. From any low camera outside the gate it read as a crack straight through the
     * tower, right under the battlement. The cavetto closes the soffit.
     */
    cylinder(stone, tx, towerTop - 0.28, tz, towerR * 0.94, towerR * 1.08, 0.28, seg, PAL.travertine, {
      arcFrom: Math.PI,
      arcTo: Math.PI * 2,
    });
    cylinder(stone, tx, towerTop, tz, towerR * 1.08, towerR * 1.08, 0.6, seg, PAL.travertine, {
      arcFrom: Math.PI,
      arcTo: Math.PI * 2,
      top: true,
    });
    const nm = detail >= 1 ? 9 : 5;
    for (let k = 0; k < nm; k++) {
      const a = Math.PI + (Math.PI * (k + 0.5)) / nm;
      const ax = tx + Math.cos(a) * towerR;
      const az = tz + Math.sin(a) * towerR;
      const tg = a + Math.PI * 0.5;
      quadPrism(
        brick,
        ax - Math.cos(tg) * 0.72,
        az - Math.sin(tg) * 0.72,
        ax + Math.cos(tg) * 0.72,
        az + Math.sin(tg) * 0.72,
        Math.cos(a),
        Math.sin(a),
        0.85,
        towerTop + 0.6,
        towerTop + 2.2,
        PAL.brick,
        PAL.travertine
      );
    }
  }

  // ---- portcullis, doors, carriageway -------------------------------------
  // The *cataracta* is raised, so the passage is open — but it is there, hanging in
  // its slot, which is how you tell a gate from a hole in a wall.
  const barTop = g + passH - 0.15;
  const barBottom = g + passH - 3.1;
  for (let i = 0; i <= 12; i++) {
    const bx = -GATE_OPEN_WIDTH * 0.5 + (GATE_OPEN_WIDTH * i) / 12;
    box(metal, bx - 0.05, barBottom, zF + 0.85, bx + 0.05, barTop, zF + 0.98, PAL.iron);
  }
  for (let k = 0; k < 3; k++) {
    const y = barBottom + k * 1.35;
    box(metal, -GATE_OPEN_WIDTH * 0.5, y, zF + 0.83, GATE_OPEN_WIDTH * 0.5, y + 0.12, zF + 1.0, PAL.iron);
  }
  box(metal, -GATE_OPEN_WIDTH * 0.5, barBottom - 0.38, zF + 0.82, GATE_OPEN_WIDTH * 0.5, barBottom, zF + 1.01, PAL.iron);

  // Twin timber leaves, swung back flat against the reveals.
  for (const s of [-1, 1]) {
    const leafW = GATE_OPEN_WIDTH * 0.47;
    const mm = new THREE.Matrix4().makeRotationY(s * 1.72).setPosition((s * GATE_OPEN_WIDTH) / 2, 0, zF + 5.4);
    const leaf = batch.pushAll(LEAF_KEYS, mm);
    box(timber, Math.min(0, s * leafW), g + 0.1, -0.1, Math.max(0, s * leafW), g + 5.7, 0.1, PAL.timberDark);
    if (detail >= 1) {
      for (let k = 0; k < 4; k++) {
        const y = g + 0.65 + k * 1.32;
        box(metal, Math.min(0, s * leafW), y, -0.14, Math.max(0, s * leafW), y + 0.17, 0.14, PAL.iron);
      }
    }
    batch.popAll(leaf);
  }

  // Polygonal basalt carriageway, rutted by two centuries of carts.
  box(road, -GATE_OPEN_WIDTH * 0.5 - 0.6, g + 0.02, zF - 0.5, GATE_OPEN_WIDTH * 0.5 + 0.6, g + 0.1, blockD * 0.5 + 18, PAL.basalt);

  // Guardhouse lean-to inside the gate.
  if (detail >= 1) {
    const gx = 13.5;
    const gz = 10.5;
    const gg = heightAt(cx + gx * Math.cos(f.rotY), cz + gz) - g;
    const guard = batch.pushAllTranslate(GUARD_KEYS, gx, gg, gz);
    box(brick, -4.2, g, -3.1, 4.2, g + 3.3, 3.1, PAL.ochreDeep, { groundShade: 0.2 });
    hipRoof(roof, 9.2, 7.1, g + 3.3, 1.6, 0.45, PAL.roofTileOld);
    batch.popAll(guard);
  }

  batch.popAll(used);
}

/** Gate leaves and their ironwork; one stream at far detail. See `Batch.distinct`. */
const LEAF_KEYS: readonly CityMatKey[] = ['timber', 'metal'];
/** Guardhouse walls and roof; one stream at far detail. See `Batch.distinct`. */
const GUARD_KEYS: readonly CityMatKey[] = ['brick', 'roof'];

/**
 * The ground outside the Porta Flaminia: the paved apron of the Via Flaminia widening
 * into the gate, the material yard where stone and timber came off the carts for the
 * new wall, and a pair of wayside monuments. Historically the approach to a Roman gate
 * was the busiest ground in the suburbs, and it is also the whole foreground of the
 * standard establishing viewpoint.
 */
function buildGateApproach(
  batch: Batch,
  detail: number,
  cx: number,
  cz: number,
  f: Frame,
  heightAt: (x: number, z: number) => number,
  rng: Rng
): void {
  const road = batch.s('road');
  const stone = batch.s('stone');
  const timber = batch.s('timber');
  const { nx, nz, dx, dz } = f;

  // Apron: a straight run of polygonal basalt from the gate out to z ≈ 258, splayed so
  // it funnels into the carriageway. Emitted as terrain-following strips.
  const from = 7;
  const to = 175;
  const strips = detail >= 1 ? 44 : 12;
  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const pD = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < strips; i++) {
    const t0 = from + ((to - from) * i) / strips;
    const t1 = from + ((to - from) * (i + 1)) / strips;
    // Splay from 5.5 m at the gate to 11 m at the far end.
    // Splayed at the gate, then settling to a consular carriageway of 4.6 m.
    const w0 = lerp(3.1, 2.35, Math.min(1, ((t0 - from) / 34) ** 0.7));
    const w1 = lerp(3.1, 2.35, Math.min(1, ((t1 - from) / 34) ** 0.7));
    const ax = cx + nx * t0;
    const az = cz + nz * t0;
    const bx = cx + nx * t1;
    const bz = cz + nz * t1;
    pA.set(ax - dx * w0, heightAt(ax - dx * w0, az - dz * w0) + 0.09, az - dz * w0);
    pB.set(bx - dx * w1, heightAt(bx - dx * w1, bz - dz * w1) + 0.09, bz - dz * w1);
    pC.set(bx + dx * w1, heightAt(bx + dx * w1, bz + dz * w1) + 0.09, bz + dz * w1);
    pD.set(ax + dx * w0, heightAt(ax + dx * w0, az + dz * w0) + 0.09, az + dz * w0);
    col.copy(PAL.basalt).multiplyScalar(0.82 + hash2(i, 3, 55) * 0.4);
    UPV.set(0, 1, 0);
    road.quadN(UPV, pA, pB, pC, pD, col);
    // Cart ruts polished into the setts down the centre of the carriageway.
    if (detail >= 2) {
      for (const side of [-1, 1]) {
        const o = side * 0.72;
        pA.set(ax + dx * (o - 0.16), heightAt(ax, az) + 0.1, az + dz * (o - 0.16));
        pB.set(bx + dx * (o - 0.16), heightAt(bx, bz) + 0.1, bz + dz * (o - 0.16));
        pC.set(bx + dx * (o + 0.16), heightAt(bx, bz) + 0.1, bz + dz * (o + 0.16));
        pD.set(ax + dx * (o + 0.16), heightAt(ax, az) + 0.1, az + dz * (o + 0.16));
        road.quadN(UPV, pA, pB, pC, pD, new THREE.Color().copy(PAL.basalt).multiplyScalar(1.45));
      }
    }
  }

  // Material yard: travertine and tufa off the carts, waiting to go through the gate.
  for (let i = 0; i < (detail >= 1 ? 9 : 3); i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const along = rng.range(14, 58);
    const off = side * rng.range(9, 26);
    const px = cx + nx * along + dx * off;
    const pz = cz + nz * along + dz * off;
    const g = heightAt(px, pz);
    const cols = 2 + rng.int(0, 2);
    const rows = 1 + rng.int(0, 3);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols - (r > 1 ? 1 : 0); c++) {
        const ox = (c - (cols - 1) * 0.5) * 1.3;
        const bx = px + dx * ox;
        const bz = pz + dz * ox;
        const tone = 0.6 + hash2(i * 5 + c, r, 71) * 0.5;
        const cc = new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(tone);
        quadPrism(stone, bx - dx * 0.6, bz - dz * 0.6, bx + dx * 0.6, bz + dz * 0.6, nx, nz, 0.62, g + r * 0.62, g + (r + 1) * 0.62 - 0.02, cc, cc);
      }
    }
  }
  // Timber baulks and a stack of scaffold poles.
  if (detail >= 1) {
    for (let i = 0; i < 3; i++) {
      const along = rng.range(16, 52);
      const off = (i % 2 === 0 ? -1 : 1) * rng.range(12, 24);
      const px = cx + nx * along + dx * off;
      const pz = cz + nz * along + dz * off;
      const g = heightAt(px, pz);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          cylinderBetween(
            timber,
            px + nx * (c - 1) * 0.34 - dx * 3.0,
            g + 0.17 + r * 0.32,
            pz + nz * (c - 1) * 0.34 - dz * 3.0,
            px + nx * (c - 1) * 0.34 + dx * 3.0,
            g + 0.17 + r * 0.32,
            pz + nz * (c - 1) * 0.34 + dz * 3.0,
            0.15,
            PAL.timber
          );
        }
      }
    }
  }
  // Kerbstones down both sides of the carriageway.
  if (detail >= 1) {
    for (let i = 0; i < strips; i++) {
      const t0 = from + ((to - from) * i) / strips;
      const t1 = from + ((to - from) * (i + 1)) / strips;
      const w0 = lerp(3.1, 2.35, Math.min(1, ((t0 - from) / 34) ** 0.7));
      const w1 = lerp(3.1, 2.35, Math.min(1, ((t1 - from) / 34) ** 0.7));
      for (const side of [-1, 1]) {
        const ax = cx + nx * t0 + dx * side * w0;
        const az = cz + nz * t0 + dz * side * w0;
        const bx = cx + nx * t1 + dx * side * w1;
        const bz = cz + nz * t1 + dz * side * w1;
        const gk = Math.min(heightAt(ax, az), heightAt(bx, bz));
        quadPrism(stone, ax, az, bx, bz, dx * side, dz * side, 0.34, gk - 0.2, gk + 0.24, PAL.peperino, PAL.travertineDirty, {
          ends: false,
        });
      }
    }
  }

  // Wayside honorific columns either side of the road, 40 m out.
  for (const side of [-1, 1]) {
    const px = cx + nx * 40 + dx * side * 8.5;
    const pz = cz + nz * 40 + dz * side * 8.5;
    const g = heightAt(px, pz);
    box(stone, px - 1.1, g - 0.4, pz - 1.1, px + 1.1, g + 1.5, pz + 1.1, PAL.travertineDirty, { topGain: 1.12 });
    column(stone, px, g + 1.5, pz, 0.42, 6.2, 'corinthian', PAL.travertine, detail);
    if (detail >= 1) statue(batch.s('metal'), px, g + 7.8, pz, 2.9, PAL.bronze, Math.PI + side * 0.4, detail >= 2 ? 8 : 5);
  }
}

const UPV = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Construction site dressing
// ---------------------------------------------------------------------------

/**
 * Where the circuit meets the Tiber.
 *
 * The Aurelian Wall did not run masonry into the river: it ended in a round tower on
 * the bank, with a *posterula* — a small postern for the towpath — beside it. A round
 * plan resists undermining by the current far better than a square one, which is why
 * every Roman river terminus is round.
 */
function buildRiverTerminus(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number
): void {
  const brick = batch.s('brick');
  const stone = batch.s('stone');
  const roof = batch.s('roof');
  const f = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const g = heightAt(bay.x0, bay.z0);
  const R = 7.6;
  const top = Math.max(bay.topY, g + 6.5) + 5.6;
  const seg = detail >= 2 ? 22 : detail === 1 ? 13 : 7;
  const cx = bay.x0 - f.dx * 2.5;
  const cz = bay.z0 - f.dz * 2.5;

  // Battered travertine footing carried well below the flood line.
  cylinder(stone, cx, g - 4.5, cz, R + 1.5, R + 0.7, 5.4, seg, PAL.travertineDirty, { shadeLow: 0.28 });
  cylinder(brick, cx, g + 0.9, cz, R + 0.7, R * 0.92, top - g - 0.9, seg, PAL.brick, { shadeLow: 0.3 });
  if (detail >= 1) {
    const nb = Math.max(2, Math.round((top - g) / WALL.courseBand));
    for (let k = 1; k < nb; k++) {
      const t = k / nb;
      const y = g + 0.9 + (top - g - 0.9) * t;
      const rr = R + 0.7 + (R * 0.92 - R - 0.7) * t + 0.15;
      cylinder(brick, cx, y - 0.12, cz, rr, rr, 0.12, seg, PAL.tileCourse, { top: true, bottom: true });
    }
    // Postern for the towpath, facing the water.
    brick.push(new THREE.Matrix4().makeRotationY(Math.atan2(-1, 0.2)).setPosition(cx - R * 0.9, g + 0.9, cz));
    archPanel(brick, 4.2, 5.0, PAL.brick, {
      depth: 1.6,
      spring: 2.0,
      openWidth: 1.8,
      segments: detail >= 2 ? 9 : 5,
      archivolt: 0.18,
      voidCol: new THREE.Color(0.024, 0.022, 0.018),
    });
    brick.pop();
  }
  // Cornice, then a crenellated crown and a tiled cap over the guard chamber.
  // Splayed out of the drum, for the same reason as the gate towers': a ring at 1.02 R
  // over a drum tapering to 0.92 R has 0.76 m of open soffit and shows sky through it.
  cylinder(stone, cx, top - 0.3, cz, R * 0.92, R * 1.02, 0.3, seg, PAL.travertine);
  cylinder(stone, cx, top, cz, R * 1.02, R * 1.02, 0.7, seg, PAL.travertine, { top: true });
  const nm = detail >= 1 ? 14 : 7;
  for (let k = 0; k < nm; k++) {
    const a = (Math.PI * 2 * (k + 0.5)) / nm;
    const ax = cx + Math.cos(a) * R * 0.94;
    const az = cz + Math.sin(a) * R * 0.94;
    const tg = a + Math.PI * 0.5;
    quadPrism(
      brick,
      ax - Math.cos(tg) * 0.78,
      az - Math.sin(tg) * 0.78,
      ax + Math.cos(tg) * 0.78,
      az + Math.sin(tg) * 0.78,
      Math.cos(a),
      Math.sin(a),
      0.9,
      top + 0.7,
      top + 2.4,
      PAL.brick,
      PAL.travertine
    );
  }
  cylinder(brick, cx, top + 0.7, cz, R * 0.62, R * 0.62, 3.4, seg, PAL.brick, { shadeLow: 0.1 });
  roof.pushTranslate(cx, 0, cz);
  hipRoof(roof, R * 1.35, R * 1.35, top + 4.1, R * 0.42, 0.5, PAL.roofTileOld);
  roof.pop();
}

/** Timber scaffolding on the outer face: standards, ledgers, putlogs, plank lifts. */
function buildScaffold(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number,
  topY: number,
  rng: Rng
): void {
  if (detail < 1) return;
  const timber = batch.s('timber');
  const { nx, nz, dx, dz } = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const standOff = WALL.thickness * 0.5 + 1.6;
  const nStands = 12;

  for (let s = 0; s <= nStands; s++) {
    const t = s / nStands;
    const px = lerp(bay.x0, bay.x1, t) + nx * standOff;
    const pz = lerp(bay.z0, bay.z1, t) + nz * standOff;
    const g = heightAt(px, pz);
    const h = topY + 2.8 - g;
    const c = new THREE.Color().copy(PAL.timber).multiplyScalar(0.84 + hash2(s, bay.index, 3) * 0.32);
    cylinder(timber, px, g, pz, 0.17, 0.14, h, 6, c);
    // Inner standard: real scaffolding is two rows of poles, not one.
    cylinder(timber, px + nx * 1.0, g, pz + nz * 1.0, 0.15, 0.12, h - 0.5, 5, c);
    if (s % 2 === 0 && detail >= 1) {
      const bxp = px + nx * 1.7;
      const bzp = pz + nz * 1.7;
      strut(timber, P0.set(px, g + h * 0.9, pz), P1.set(bxp, heightAt(bxp, bzp), bzp), 0.1, c);
    }
  }

  const gBase = Math.min(bay.g0, bay.g1);
  const lifts = Math.max(1, Math.floor((topY - gBase) / 1.9));
  for (let k = 1; k <= lifts; k++) {
    const y = gBase + k * 1.9;
    const ax = bay.x0 + nx * standOff;
    const az = bay.z0 + nz * standOff;
    const bx = bay.x1 + nx * standOff;
    const bz = bay.z1 + nz * standOff;
    cylinderBetween(timber, ax, y, az, bx, y, bz, 0.07, PAL.timber);
    if (k >= 1) {
      // Plank deck between the scaffold and the wall face.
      const iOff = WALL.thickness * 0.5 - 0.15;
      P0.set(ax, y + 0.08, az);
      P1.set(bx, y + 0.08, bz);
      P2.set(bay.x1 + nx * iOff, y + 0.08, bay.z1 + nz * iOff);
      P3.set(bay.x0 + nx * iOff, y + 0.08, bay.z0 + nz * iOff);
      OUT.set(0, 1, 0);
      timber.quadN(OUT, P0, P1, P2, P3, PAL.timber, PAL.timberDark, PAL.timber, PAL.timberDark);
    }
    if (detail >= 2) {
      for (let s = 0; s < 10; s++) {
        const t = (s + 0.5) / 10;
        const px = lerp(bay.x0, bay.x1, t);
        const pz = lerp(bay.z0, bay.z1, t);
        cylinderBetween(
          timber,
          px + nx * (standOff + 0.35),
          y,
          pz + nz * (standOff + 0.35),
          px + nx * (WALL.thickness * 0.5 - 0.5),
          y,
          pz + nz * (WALL.thickness * 0.5 - 0.5),
          0.06,
          PAL.timberDark
        );
      }
    }
  }

  if (bay.index % 2 === 0) buildCrane(batch, detail, bay, topY, rng);
  void dx;
  void dz;
}

/**
 * A Roman *polyspaston*: raking timber legs, a treadwheel driving the tackle, and a
 * dressed block hanging in the fall. Vitruvius X.2 describes exactly this machine.
 */
function buildCrane(batch: Batch, detail: number, bay: Bay, topY: number, rng: Rng): void {
  const timber = batch.s('timber');
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const { nx, nz, dx, dz } = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const t = rng.range(0.3, 0.7);
  const bxp = lerp(bay.x0, bay.x1, t);
  const bzp = lerp(bay.z0, bay.z1, t);
  const baseY = topY + 0.22;
  const mastH = 15.5;
  const lean = 2.6;

  const apex = new THREE.Vector3(bxp + nx * lean, baseY + mastH, bzp + nz * lean);
  for (const s of [-1, 1]) {
    strut(
      timber,
      P0.set(bxp + dx * s * 1.6 - nx * 0.7, baseY, bzp + dz * s * 1.6 - nz * 0.7),
      apex,
      0.18,
      PAL.timber
    );
  }
  strut(timber, apex, P0.set(bxp - nx * 3.2, baseY, bzp - nz * 3.2), 0.16, PAL.timberDark);
  // Jib carrying the fall out beyond the wall face.
  strut(timber, apex, P0.set(bxp + nx * 6.5, baseY + mastH * 0.62, bzp + nz * 6.5), 0.15, PAL.timber);

  // Treadwheel: two rims joined by treads, big enough for two men to walk in.
  if (detail >= 1) {
    const R = 2.9;
    const wcx = bxp - nx * 1.5;
    const wcz = bzp - nz * 1.5;
    const wheelY = baseY + 0.35 + R;
    const rimSeg = detail >= 2 ? 16 : 9;
    for (const s of [-1, 1]) {
      const ox = dx * s * 0.6;
      const oz = dz * s * 0.6;
      // Rim drawn as a thin ring in the vertical plane: a torus is overkill, a short
      // cylinder rotated onto its side reads correctly at this distance.
      const rm = new THREE.Matrix4()
        .makeRotationX(Math.PI / 2)
        .premultiply(new THREE.Matrix4().makeRotationY(Math.atan2(dx, dz)))
        .setPosition(wcx + ox, wheelY, wcz + oz);
      timber.push(rm);
      cylinder(timber, 0, -0.06, 0, R, R, 0.12, rimSeg, PAL.timber, { top: true, bottom: true });
      cylinder(timber, 0, -0.05, 0, R * 0.86, R * 0.86, 0.1, rimSeg, PAL.timberDark, { top: true });
      timber.pop();
    }
    for (let k = 0; k < 12; k++) {
      const a = (Math.PI * 2 * k) / 12;
      const rx = wcx + nx * Math.cos(a) * R;
      const rz = wcz + nz * Math.cos(a) * R;
      const yy = wheelY + Math.sin(a) * R;
      cylinderBetween(timber, rx - dx * 0.6, yy, rz - dz * 0.6, rx + dx * 0.6, yy, rz + dz * 0.6, 0.055, PAL.timberDark);
    }
    cylinderBetween(metal, wcx - dx * 0.85, wheelY, wcz - dz * 0.85, wcx + dx * 0.85, wheelY, wcz + dz * 0.85, 0.09, PAL.iron);
  }

  // The load: a dressed travertine block on the fall, halfway up.
  const loadY = baseY + mastH * 0.4;
  cylinderBetween(metal, apex.x, apex.y - 0.25, apex.z, apex.x, loadY + 1.0, apex.z, 0.035, PAL.iron, 4);
  box(stone, apex.x - 0.62, loadY, apex.z - 0.44, apex.x + 0.62, loadY + 0.86, apex.z + 0.44, PAL.travertine, { bottom: true });
}

/** Stockpiles, mortar pits and rubble on the city side of a working stretch. */
function buildYard(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number,
  rng: Rng
): void {
  const stone = batch.s('stone');
  const brick = batch.s('brick');
  const concrete = batch.s('concrete');
  const timber = batch.s('timber');
  const { nx, nz, dx, dz } = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);

  // Yards sit on the city side: you do not stack your building stone outside the
  // wall with a Germanic host on the plain.
  const yardOff = -(WALL.thickness * 0.5 + rng.range(8, 20));
  const nStacks = detail >= 1 ? 5 : 2;
  for (let i = 0; i < nStacks; i++) {
    const t = rng.next();
    const px = lerp(bay.x0, bay.x1, t) + nx * (yardOff + rng.jitter(5));
    const pz = lerp(bay.z0, bay.z1, t) + nz * (yardOff + rng.jitter(5));
    const g = heightAt(px, pz);
    // Dressed travertine in 1.2 × 0.6 × 0.6 m blocks, a few courses high.
    const cols = 2 + rng.int(0, 2);
    const rows = 2 + rng.int(0, 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols - (r > 1 ? 1 : 0); c++) {
        const ox = (c - (cols - 1) * 0.5) * 1.3;
        const bx2 = px + dx * ox;
        const bz2 = pz + dz * ox;
        const tone = 0.62 + hash2(i * 7 + c, r, 21) * 0.5;
        const col = new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(tone);
        quadPrism(stone, bx2 - dx * 0.6, bz2 - dz * 0.6, bx2 + dx * 0.6, bz2 + dz * 0.6, nx, nz, 0.62, g + r * 0.62, g + (r + 1) * 0.62 - 0.02, col, col);
      }
    }
  }

  if (detail >= 1) {
    // Brick pallets: *bipedales* stacked on edge.
    for (let i = 0; i < 3; i++) {
      const t = rng.next();
      const px = lerp(bay.x0, bay.x1, t) + nx * (yardOff + rng.range(-7, 7));
      const pz = lerp(bay.z0, bay.z1, t) + nz * (yardOff + rng.range(-7, 7));
      const g = heightAt(px, pz);
      quadPrism(brick, px - dx * 0.85, pz - dz * 0.85, px + dx * 0.85, pz + dz * 0.85, nx, nz, 1.2, g, g + rng.range(0.7, 1.5), PAL.brick, PAL.brickPale);
    }
  }

  // Mortar pit: slaked lime, blindingly pale, with a spoil bank round it.
  const mpT = rng.next();
  const mx = lerp(bay.x0, bay.x1, mpT) + nx * (yardOff - rng.range(3, 10));
  const mz = lerp(bay.z0, bay.z1, mpT) + nz * (yardOff - rng.range(3, 10));
  const mg = heightAt(mx, mz);
  box(concrete, mx - 2.7, mg + 0.04, mz - 2.0, mx + 2.7, mg + 0.12, mz + 2.0, new THREE.Color(0.82, 0.81, 0.75));
  for (const s of [-1, 1]) {
    box(concrete, mx - 3.05, mg, mz + s * 2.1 - 0.32, mx + 3.05, mg + 0.45, mz + s * 2.1 + 0.32, PAL.dust);
    box(concrete, mx + s * 3.05 - 0.32, mg, mz - 2.1, mx + s * 3.05 + 0.32, mg + 0.45, mz + 2.1, PAL.dust);
  }

  // Rubble heaps of broken tufa and tile for the core.
  for (let i = 0; i < (detail >= 1 ? 4 : 1); i++) {
    const t = rng.next();
    const px = lerp(bay.x0, bay.x1, t) + nx * (yardOff + rng.range(-9, 9));
    const pz = lerp(bay.z0, bay.z1, t) + nz * (yardOff + rng.range(-9, 9));
    const g = heightAt(px, pz);
    const r = rng.range(1.7, 3.5);
    cylinder(concrete, px, g, pz, r, r * 0.22, r * 0.52, 7, PAL.concrete, { top: true });
  }

  if (detail >= 1) {
    // Timber stack for the shuttering and the scaffold.
    const t = rng.next();
    const px = lerp(bay.x0, bay.x1, t) + nx * (yardOff + rng.range(-5, 5));
    const pz = lerp(bay.z0, bay.z1, t) + nz * (yardOff + rng.range(-5, 5));
    const g = heightAt(px, pz);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 3; c++) {
        const off = (c - 1) * 0.34;
        cylinderBetween(
          timber,
          px + nx * off - dx * 2.5,
          g + 0.16 + r * 0.3,
          pz + nz * off - dz * 2.5,
          px + nx * off + dx * 2.5,
          g + 0.16 + r * 0.3,
          pz + nz * off + dz * 2.5,
          0.14,
          PAL.timber
        );
      }
    }
  }
}

/** A footing-only stretch: shuttering boards and the first lift of poured concrete. */
function buildFootingSite(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number,
  rng: Rng
): void {
  const timber = batch.s('timber');
  const concrete = batch.s('concrete');
  const { nx, nz } = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const gm = Math.min(bay.g0, bay.g1);

  for (const s of [-1, 1]) {
    const off = s * (WALL.thickness * 0.5 + 0.16);
    quadPrism(
      timber,
      bay.x0 + nx * off,
      bay.z0 + nz * off,
      bay.x1 + nx * off,
      bay.z1 + nz * off,
      nx,
      nz,
      0.1,
      gm + WALL.plinthHeight,
      gm + WALL.plinthHeight + 1.2,
      PAL.timber,
      PAL.timberDark,
      { ends: false }
    );
    if (detail >= 1) {
      for (let k = 0; k <= 10; k++) {
        const t = k / 10;
        const px = lerp(bay.x0, bay.x1, t) + nx * (off + s * 0.32);
        const pz = lerp(bay.z0, bay.z1, t) + nz * (off + s * 0.32);
        cylinder(timber, px, heightAt(px, pz), pz, 0.08, 0.07, WALL.plinthHeight + 1.45, 5, PAL.timberDark);
      }
    }
  }
  quadPrism(
    concrete,
    bay.x0,
    bay.z0,
    bay.x1,
    bay.z1,
    nx,
    nz,
    WALL.thickness,
    gm + WALL.plinthHeight,
    gm + WALL.plinthHeight + 1.0,
    PAL.concrete,
    PAL.mortar,
    { ends: false }
  );
  if (bay.dress) buildYard(batch, detail, bay, heightAt, rng);
}

/**
 * A gap in the circuit blocked in a hurry: an earth-and-rubble rampart with a timber
 * palisade on its crest. This is what Aurelian's men would actually have thrown
 * across an unfinished stretch with a Germanic host on the plain.
 */
function buildGapBarricade(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number,
  rng: Rng
): void {
  const concrete = batch.s('concrete');
  const timber = batch.s('timber');
  const stone = batch.s('stone');
  const { nx, nz, dx, dz } = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const subs = detail >= 1 ? 14 : 4;

  for (let s = 0; s < subs; s++) {
    const t0 = s / subs;
    const t1 = (s + 1) / subs;
    const ax = lerp(bay.x0, bay.x1, t0);
    const az = lerp(bay.z0, bay.z1, t0);
    const bx = lerp(bay.x0, bay.x1, t1);
    const bz = lerp(bay.z0, bay.z1, t1);
    const g = Math.min(heightAt(ax, az), heightAt(bx, bz));
    const h = 2.5 + hash2(s, bay.index, 77) * 0.9;
    quadPrism(concrete, ax, az, bx, bz, nx, nz, WALL.thickness + 3.6, g - 0.8, g + h, PAL.concrete, PAL.dust, {
      ends: false,
      batter: 0.44,
    });
    if (detail >= 1 && hash2(s, bay.index, 91) > 0.5) {
      const bxx = lerp(ax, bx, 0.5) + nx * (WALL.thickness * 0.5 + 1.3);
      const bzz = lerp(az, bz, 0.5) + nz * (WALL.thickness * 0.5 + 1.3);
      quadPrism(stone, bxx - dx * 0.7, bzz - dz * 0.7, bxx + dx * 0.7, bzz + dz * 0.7, nx, nz, 0.7, g, g + 0.66, PAL.travertineDirty, PAL.travertine);
    }
  }

  // Palisade of split stakes on the crest, sharpened and leaning outward.
  const stakes = detail >= 1 ? 46 : 14;
  for (let s = 0; s < stakes; s++) {
    const t = (s + 0.5) / stakes;
    const px = lerp(bay.x0, bay.x1, t);
    const pz = lerp(bay.z0, bay.z1, t);
    const base = heightAt(px, pz) + 2.4 + hash2(s, bay.index, 77) * 0.9;
    const h = 2.3 + hash2(s, bay.index, 5) * 0.7;
    const leanX = nx * 0.3 + dx * (hash2(s, bay.index, 9) - 0.5) * 0.22;
    const leanZ = nz * 0.3 + dz * (hash2(s, bay.index, 9) - 0.5) * 0.22;
    strut(timber, P0.set(px, base - 0.6, pz), P1.set(px + leanX, base + h, pz + leanZ), 0.11 + hash2(s, bay.index, 13) * 0.045, PAL.timber);
  }
  for (let k = 0; k < 2; k++) {
    const y0 = heightAt(bay.x0, bay.z0) + 3.4 + k * 1.2;
    const y1 = heightAt(bay.x1, bay.z1) + 3.4 + k * 1.2;
    cylinderBetween(timber, bay.x0 - nx * 0.28, y0, bay.z0 - nz * 0.28, bay.x1 - nx * 0.28, y1, bay.z1 - nz * 0.28, 0.1, PAL.timberDark);
  }
}

// ---------------------------------------------------------------------------
// Small helpers, exported for the other city builders
// ---------------------------------------------------------------------------

const SEG_A = new THREE.Vector3();
const SEG_B = new THREE.Vector3();
const SEG_D = new THREE.Vector3();
const SEG_M = new THREE.Matrix4();
const SEG_Q = new THREE.Quaternion();
const SEG_UP = new THREE.Vector3(0, 1, 0);
const SEG_S = new THREE.Vector3(1, 1, 1);
const SEG_TMP_A = new THREE.Vector3();
const SEG_TMP_B = new THREE.Vector3();

/** A cylindrical strut between two arbitrary points — poles, braces, ropes, stakes. */
export function strut(st: GeoStream, a: THREE.Vector3, b: THREE.Vector3, radius: number, col: THREE.Color, seg = 5): void {
  SEG_A.copy(a);
  SEG_B.copy(b);
  SEG_D.subVectors(SEG_B, SEG_A);
  const len = SEG_D.length();
  if (len < 1e-4) return;
  SEG_D.divideScalar(len);
  SEG_Q.setFromUnitVectors(SEG_UP, SEG_D);
  SEG_M.compose(SEG_A, SEG_Q, SEG_S);
  st.push(SEG_M);
  cylinder(st, 0, 0, 0, radius, radius * 0.85, len, seg, col);
  st.pop();
}

/** `strut` from raw coordinates. */
export function cylinderBetween(
  st: GeoStream,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  radius: number,
  col: THREE.Color,
  seg = 5
): void {
  strut(st, SEG_TMP_A.set(x0, y0, z0), SEG_TMP_B.set(x1, y1, z1), radius, col, seg);
}
