import * as THREE from 'three';
import { lerp } from '../../util/math';
import type { BayStage } from '../layout';

/**
 * The cross-section of the Aurelian curtain — `docs/ROME.md` §4.3 — and the per-bay
 * primitives built from it.
 *
 * Split out of `wall.ts` by §15 task 0 so that the three modules that build Rome's stone
 * (`circuit.ts`, `apertures.ts`, `works.ts`) can share one definition of what a bay is and
 * how thick the wall is **without importing each other**. That acyclicity is deliberate:
 * this module imports none of them, so there is no order in which a constant here can be
 * read before it is initialised. The repository has shipped a temporal dead zone before.
 *
 * `WALL` is the historical section (Richmond's measurements); `CURTAIN_T` is the *playable*
 * one and the two differ on purpose — see each.
 */

/**
 * Aurelian Wall dimensions, first phase (AD 271–275).
 *
 * Height 6.5 m to the wall-walk and 3.5 m thick: Richmond, *The City Wall of
 * Imperial Rome* (1930), measuring the surviving Aurelianic core before Maxentius
 * doubled the height. Tower spacing is one *actus* — 120 Roman *pedes* of 0.296 m,
 * so 35.5 m (parts of the circuit run at 100 pedes, 29.6 m).
 */
export const WALL = {
  height: 6.5,
  /**
   * **Historical reference only. Nothing builds or collides against this number.**
   *
   * Richmond's 3.5 m is what he measured on the surviving Aurelianic core, and it is kept
   * here because it is the citation. The curtain the game actually stands on is `CURTAIN_T`
   * in `wall.ts` — 6.0 m, widened so an army can form up on the walk — and every consumer
   * that needs the built thickness reads `GarrisonBay.halfThickness` from the same function
   * that emits the stone. A live-looking constant that nothing reads is how the next person
   * builds against the wrong number, so: this one is a footnote, not an input.
   */
  thickness: 3.5,
  /** Travertine/tufa footing course below the brick face. */
  plinthHeight: 1.35,
  plinthProject: 0.42,
  /** Crenellated parapet on the outer lip of the walkway. */
  parapetHeight: 2.05,
  parapetThickness: 0.9,
  /** Face batter: Roman curtains lean back about 1 in 30. */
  batter: 0.032,
  towerSpacing: 35.5,
  /** Blind arched recesses in the inner face, an Aurelianic economy measure. */
  innerArchSpacing: 6.4,
  /** Towers are square, project 3.5 m beyond the outer face, and stand 7.5 m wide. */
  towerWidth: 7.6,
  towerProject: 3.5,
  /** Ballista chamber rises one storey above the walkway. */
  towerChamberHeight: 5.0,
  towerRoofHeight: 2.3,
  /** Height of one *opus testaceum* band between tile string courses. */
  courseBand: 1.1,
} as const;

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

/**
 * Thickness of the curtain, metres.
 *
 * **Deliberately not `WALL.thickness`**, which is the historical 3.5 m that Richmond
 * measured on the surviving Aurelianic core and which `layout.ts` publishes to the rest
 * of the city. This is a *playable* wall and the difference is the point.
 *
 * Why 6.0. Three things fix it, and they very nearly meet:
 *
 *  - **Precedent.** 3.5 m is the low end of the late-Roman range, not the norm for a
 *    great circuit. The Theodosian inner wall at Constantinople — Aurelian's idea carried
 *    to its conclusion 140 years later — is 4.5 to 6.0 m thick. 6.0 is the top of the real
 *    range rather than an invention, and Rome II's own playable walls are wider than life
 *    for exactly the reason the player gives: a wall you cannot put an army on is scenery.
 *
 *  - **It is the width at which the *worst* bay still seats five ranks.** The clear
 *    standing band works out at `T - 1.765 - batter * rise` (see `walkGeometry`). Bay 3's
 *    walk stands 40.55 m above its own footing, so the 1-in-30 batter has eaten 1.25 m off
 *    the outer lip by the time it reaches the walk, leaving 2.98 m — and five ranks at the
 *    sim's 0.72 m interlocking pitch need 2.88 m. At 5.5 m thick the tall bays drop to four
 *    ranks and the garrison thins exactly where the wall is highest.
 *
 *  - **A hard ceiling at 6.6.** `probe-siege` asserts that no garrisoned man stands more
 *    than 1.90 m from the bay centreline. The front rank stands at `T/2 - batter*rise -
 *    1.32`, which on the shallowest bay on the circuit is 1.58 m at T = 6.0. T = 6.7 breaches
 *    it. So the useful range is 5.5..6.6 and 6.0 sits in it with 0.32 m of margin.
 *
 * What it costs: the curtain now reads 0.70 of its own height in section rather than 0.41,
 * which is chunkier than the real Aurelianic wall and is visible looking along the top and
 * at the tower returns; and the towers, which are `T + towerProject` deep by construction,
 * grow from 7.0 m to 9.5 m against a 7.6 m width, so they are now deeper than they are wide.
 * Both are accepted: neither is visible from the field, which is where the wall is seen.
 */
export const CURTAIN_T = 6.0;
/** Half-thickness, which is what almost every caller actually wants. */
export const HALF_T = CURTAIN_T * 0.5;

/**
 * Body radius of a man, from `resolveCrowding`. He may not overlap the stonework.
 */
export const BODY = 0.42;
/**
 * How far back from an *unprotected* lip a rank will stand, metres.
 *
 * A finished bay has a 0.9 m parapet to lean on and the front rank stands against it. A
 * half-built lift has nothing: on 3.5 m of curtain the old rule kept men 0.67 m from a
 * ten-metre drop, which was survivable only because the wall was too narrow for it to
 * matter. On 6.0 m it puts the front rank 2.06 m off the centreline and breaks
 * `probe-siege`'s 1.90 m limit — correctly, because a man will not fight at the edge of an
 * unfinished wall. 1.2 m is a body length back from the void, both sides.
 */
export const OPEN_EDGE_SETBACK = 1.2;
/**
 * The covered gallery's piers: 0.6 m across, their cityward face 0.35 m off the walk's
 * inner lip. Shared by `walkGeometry` and `buildCurtainBay` so the garrison's cityward
 * limit and the stone it is clear of are the same number.
 */
export const GALLERY_PIER_HALF = 0.3;
export const GALLERY_PIER_OFF = -(HALF_T - 0.35 - GALLERY_PIER_HALF);

/**
 * The ballista chamber's own walls: how far its shell is set in from the tower's face, and
 * how thick that shell is. Hoisted out of `buildTower` because `towerLane` has to know how
 * much stone the chamber keeps behind the passage.
 */
export const TOWER_CH_INSET = 0.16;
export const TOWER_CH_WALL = 0.75;
/** Clear head over the *higher* of the two walks a tower joins, metres. */
export const TOWER_PASS_HEAD = 2.3;

/**
 * The lane through a tower, from the two walks it joins.
 *
 * **One helper, two consumers, and they used to be three metres apart.** `buildTower` cut a
 * 1.7 m opening at `-0.35 .. +1.35` — the clear band of a 3.5 m curtain, never re-derived
 * when the curtain went to 6.0 — while `Siege.linkPath` walked men across at the walk's
 * cityward lip, `innerOff - 0.15`, which is 1.36 m past the far jamb and inside the
 * chamber's back wall. Measured: the traversal path was inside masonry at 42 of Rome's 42
 * walkable towers. So the lane is derived once, published on `GarrisonBay`, and both the
 * stone and the path read it.
 *
 * The lane is the intersection of the two bays' standing bands — a man may not be walked
 * anywhere he could not stand — pulled clear of the chamber's back wall so the tower keeps
 * one. `keepInner` is how much stone must be left on the cityward side; pass the chamber's
 * own shell where there is one and the wall's back thickness where there is not.
 */
export function towerLane(
  a: { innerOff: number; outerOff: number; walkY: number },
  b: { innerOff: number; outerOff: number; walkY: number },
  halfThickness: number,
  keepInner: number
): { outer: number; inner: number; loY: number; hiY: number; loIsWest: boolean } {
  const outer = Math.min(a.outerOff, b.outerOff);
  // Never cityward of the stone that has to stay standing behind it.
  const backLimit = -(halfThickness - keepInner);
  const inner = Math.max(Math.max(a.innerOff, b.innerOff), backLimit);
  return {
    outer,
    inner,
    loY: Math.min(a.walkY, b.walkY),
    hiY: Math.max(a.walkY, b.walkY),
    // `b` is the western neighbour at every call site: the tower stands at the eastern
    // bay's `x0`.
    loIsWest: b.walkY <= a.walkY,
  };
}

/** A man is 0.84 m across the shoulders; anything narrower is not a doorway. */
export const MIN_LANE = 0.9;

/** What `buildTower` needs to know about the doorway it is cutting. See `towerLane`. */
export interface TowerPassOut {
  outer: number;
  inner: number;
  loY: number;
  hiY: number;
  /** True when the *west* neighbour is the lower walk, so the flight inside climbs east. */
  loIsWest: boolean;
}

export interface Bay {
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

/**
 * One piece of a bay, as a bay in its own right.
 *
 * `topY`, `g0`, `g1` and `gMax` are deliberately the *parent's*: the wall-walk is level
 * across a whole bay by construction, and `walkGeometry` has to give the piece the same
 * answer it gives the garrison API for the bay, or the two disagree again.
 */
export function clipBay(bay: Bay, ax: number, bx: number, dress: boolean): Bay {
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

export const OUT = new THREE.Vector3();
export const P0 = new THREE.Vector3();
export const P1 = new THREE.Vector3();
export const P2 = new THREE.Vector3();
export const P3 = new THREE.Vector3();

export interface Frame {
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
export function frameOf(x0: number, z0: number, x1: number, z1: number): Frame {
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
 * Worst rise of an unfinished bay's work above the ground under that very point, metres.
 *
 * The number a body has to get over, and deliberately not the number the bay reports as
 * its height. `unfinishedTopAt` answers per point because the work follows the ground
 * across 35.5 m of terrain that varies by ten metres; subtract the ground at the same
 * point and you have the step. Taken at its maximum along the run, because a formation
 * crosses on a frontage and the worst metre is the one that holds it up.
 *
 * Sampled at 1/32 intervals **strictly inside** the run. Sampling the endpoints is how the
 * first instrument to ask this question reported bay 2's pour as standing 40.55 m proud:
 * `x0` belongs to the previous bay by index arithmetic, and bay 2's neighbour is finished
 * curtain with its walk 40 m up.
 */
export function worstRiseOf(
  bay: { x0: number; z0: number; x1: number; z1: number; g0: number; g1: number; gMax: number; stage: BayStage },
  heightAt: (x: number, z: number) => number
): number {
  const gMin = Math.min(bay.g0, bay.g1);
  let worst = 0;
  for (let k = 0; k <= 32; k++) {
    const t = 0.02 + (k / 32) * 0.96;
    const px = lerp(bay.x0, bay.x1, t);
    const pz = lerp(bay.z0, bay.z1, t);
    const g = heightAt(px, pz);
    const rise = unfinishedTopAt(bay.stage, gMin, g) - g;
    if (rise > worst) worst = rise;
  }
  return worst;
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
export function walkGeometry(bay: Bay): {
  walkY: number;
  crestY: number;
  sillY: number;
  parapetInner: number;
  parapetOuter: number;
  innerOff: number;
  outerOff: number;
  garrisonable: boolean;
} {
  const T = CURTAIN_T;
  const gMin = Math.min(bay.g0, bay.g1);
  const stage = bay.stage;
  // Matches `buildCurtainBay` exactly.
  const topY = stage === 'half-built' ? Math.max(bay.g0, bay.g1) + 3.4 : bay.topY;
  // Outer face leans back 1-in-30 over the lift, so the walkway's outer lip is inboard
  // of the nominal half-thickness by the batter times the rise.
  const walkOuter = T * 0.5 - WALL.batter * Math.max(0, topY - (gMin + WALL.plinthHeight));
  // The inner lip of the walk quad, less the walk's own 25 mm inset.
  const innerLip = -(T * 0.5 - 0.025);

  if (stage === 'footing' || stage === 'gap') {
    // No walkway: a footing is the first lift of a concrete pour on its travertine plinth,
    // and a gap is an earth rampart with a palisade on it. Both are places to fight *at*,
    // not on.
    //
    // **Not knee-high, whatever this comment used to say.** `unfinishedTopAt` puts the
    // pour at `min(g0,g1) + 1.35 + 1.0`, and measured against the ground under each point
    // of the shipped circuit that is 1.35–3.54 m on bay 2, 1.35–2.33 on bay 28 and
    // 1.94–2.75 on bay 29 — chest-high on a man, withers-high on a horse. The stone is
    // right; Roman practice is a 1.35 m plinth with a 1.0 m lift on it. The description
    // was wrong, and it was wrong in four places, one of which (`Obstacles.TOP_SLACK`)
    // sized a step-up allowance at 0.4 m for "a low footing course" that is six times
    // that. See `RoughGround`.
    //
    // The height reported is what has been *built*, not `bay.topY`, which is the level
    // the finished wall will eventually reach. Those are the same number nowhere on this
    // circuit and forty metres apart on the Tiber bank, where bay 2's footing is a pour
    // at ground + 2.35 and its construction level is 48.4 because the level is held over
    // pairs of bays and its neighbour climbs a hill. `masonryTopAt` reported the latter,
    // so an arrow shot at a chest-high footing stopped dead in clear air above it, and a
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
    // Standing on the exposed rubble core, 0.3 m proud of the finished lift and inboard of
    // both facing skins. No parapet on either side, so the line stands a body length back
    // from both lips — see `OPEN_EDGE_SETBACK`. Symmetric, because the drop into the
    // pomerium kills a man exactly as well as the drop onto the glacis.
    const half = (T - 0.55) * 0.5;
    return {
      walkY: topY + 0.3,
      crestY: topY + 0.3,
      sillY: topY + 0.3,
      parapetInner: half,
      parapetOuter: half,
      innerOff: -half + OPEN_EDGE_SETBACK + BODY,
      outerOff: half - OPEN_EDGE_SETBACK - BODY,
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
  // Bays carrying the covered gallery have piers standing just inboard of the walk's
  // cityward lip. The cityward limit is pulled in clear of them rather than letting the
  // rear rank stand inside a colonnade.
  const gallery = bay.index % 5 === 1;
  return {
    walkY: topY,
    crestY: topY + WALL.parapetHeight,
    // `buildCurtainBay` lays a solid 0.6 m sill and stands the merlons on top of it.
    sillY: topY + 0.6,
    parapetInner: walkOuter - WALL.parapetThickness,
    parapetOuter: walkOuter,
    innerOff: gallery ? GALLERY_PIER_OFF + GALLERY_PIER_HALF + BODY : innerLip + BODY,
    outerOff: walkOuter - WALL.parapetThickness - BODY,
    garrisonable: true,
  };
}
