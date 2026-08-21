import type { Faction } from '../sim/types';
import type { WayClass } from './layout';

/**
 * The seam between `CitySystem` and *which city it is building*.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION, AND WHY
 * ---------------------------------------------------------------------------
 *
 * Carthage is the second besiegeable city. The choice was between parameterising
 * `CitySystem` so one subsystem builds either city from data, and standing a sibling
 * subsystem up beside it behind a shared interface. **It is parameterised, and this file is
 * the parameter.** Four reasons, in order of weight.
 *
 * 1. **`CitySystem` contains almost no Rome.** Of its ~1,300 lines, the Aurelian-specific
 *    part is the plan block at the top of `init` (~110 lines), `getLandmarks`, and four
 *    constants. Everything else — the chunk bake, the LOD and shadow-cutoff swap, the 4 m
 *    masonry occupancy raster, the oriented-box obstacle set, `pushWallBox`, `stairSolid`,
 *    `blocksMovement`, `bayAt`, `masonryTopAt` — is generic machinery over a `WallBuildOutput`
 *    and two lists of footprints. A sibling would copy that machinery to gain nothing.
 *
 *    And the machinery is where the bugs live. `occRot` (monument boxes mirrored, the Circus
 *    Maximus's collision volume 68° off its masonry), `stairSolid` (nine wall stairs nothing
 *    collided with), and `pushWallBox` (the 23 m hole beside the Porta Flaminia) were each
 *    found and fixed separately, in three different commits, after shipping. A Carthage
 *    sibling forked today would have inherited all three bugs and none of the fixes, and
 *    every future fix would have to land twice or silently not land at all.
 *
 * 2. **The siege system must not learn that there are two cities.** Wall traversal reads
 *    `ctx.tryGet('city')` and then `getWallStairs()`, `getGateDoor()`, `getWallSegments()`,
 *    `getGarrisonBays()` and `masonryTopAt()`. One class registered under `name = 'city'`
 *    means that resolution stays one call against one type, `Siege.ts` is not edited, and
 *    Carthage gets stair-climbing, lateral movement along the walk and descent into the city
 *    the day its geometry exists. Two siblings registered under the same name would need the
 *    interface extracted anyway — which is this file, with extra steps and a second
 *    implementation to keep in step with it.
 *
 * 3. **A map owns its city, or owns none — and that is what closes the Pydna bug class.**
 *    `MapDefinition.hidesCity` was a boolean you had to remember to set, and its failure mode
 *    was invisible: `CitySystem` planned the Aurelian circuit against the Tiber, built it onto
 *    whatever heightfield was loaded, and was then merely made invisible — so **Rome's wall
 *    blocked movement across the plain of Pydna while being nowhere on screen**. `main.ts`
 *    now skips registration entirely, which fixed that instance and left the shape of the
 *    error alive: a third map that forgets the flag repeats it.
 *
 *    `MapDefinition.city: CityPlan | null` retires the flag. A city is no longer something a
 *    map *hides*; it is something a map *carries*. The absence of a city is the absence of
 *    data, `main.ts` builds whatever the map hands it and nothing when it hands nothing, and
 *    a map author cannot forget a field that does not exist. Nothing downstream may reinstate
 *    a "which city is this really" test — if a consumer needs to know, it reads `plan.id`
 *    through the city it was given.
 *
 * 4. **File ownership stays exclusive, which is the practical half.** Rome's plan is
 *    `src/city/rome/plan.ts` and is a straight lift of what was inline in `CitySystem.init`.
 *    Carthage's is `src/city/carthage/`. The walls workstream owns
 *    `src/city/carthage/wall.ts`, the fabric workstream owns `src/city/carthage/fabric.ts`,
 *    neither edits the other's file, and neither edits `CitySystem.ts` at all.
 *
 * ---------------------------------------------------------------------------
 * THE RULING ON THE TWO SEAMS THAT ARRIVED WHILE THIS WAS BEING WRITTEN
 * ---------------------------------------------------------------------------
 *
 * Two workstreams reached this file independently and shipped different halves of it. They
 * are **composable, not contradictory**, and both are kept.
 *
 *  - **`setFortification('carthage')`** (`fortification.ts`) chose *which wall*, and
 *    `buildCarthageWall` returns the same `WallBuildOutput` `buildWall` does — so the chunk
 *    baker, the raster, the obstacle set and all four siege accessors were already one code
 *    path for both cities, and `Siege.ts` was never touched. That is exactly the contract
 *    this file specifies, satisfied before it was written down.
 *  - **`CityPlan`** chose *which city*, and pulled Rome out of `CitySystem.init` so the
 *    shared machinery knows about neither. That is the half that scales to a third city.
 *
 * **The ruling: a plan chooses its own fortification, and the selection has exactly one
 * home.** Two module singletons that must agree with each other — one for the fabric, one
 * for the masonry — is the same shape of bug as `hidesCity`: a plan naming Rome's fabric
 * with Carthage's wall describes no city that ever existed, and nothing would stop it. So
 * `CityPlan.build` calls its own wall builder, and the one selector is `MapDefinition.city`.
 *
 * What that cost each side: nothing structural. A multi-line circuit publishes more than a
 * single-line one — outworks, casemates, a ditch, a taller tower, a separate raster list —
 * and those now ride on `CityBuild` as optionals that `CitySystem` reads with defaults,
 * which is what the branch in `init` was doing anyway. `?fort=carthage` survives as a
 * **development rig** on Rome's plan (see `rome/plan.ts`), because building and grading a
 * wall before its map exists is genuinely useful; it is not the product path and it says so.
 * Both probes stay green: `probe-wall` 19/19, `probe-carthage-wall` 44/44.
 *
 * **Three definitions of Carthage's wall line existed and only one could be true. Settled:
 * there is now one, and it is the terrain's.**
 *
 *     maps/carthage/topography.ts  carthageWallZ   527 − 0.06241x + 2.945e−5x²,  x −968..1013
 *     city/carthage/circuit.ts     circuitZAt      re-exports carthageWallZ, clamped
 *     city/carthageWall.ts         WallLine        the line is now an argument
 *
 * The two survey-derived definitions agreed at all three §2.5 anchors and **not between
 * them**: the quadratic passes through them, while `circuit.ts` interpolated linearly and
 * then bowed the result 25 m toward the field, so at mid-span the two were 25 m apart and at
 * x +500 they were 10.6 m apart. That is a bowed wall against a straight bench, and the
 * difference is bigger than the bench is wide (`WALL_BENCH_HALF = 40`), so half the circuit
 * would have stood off its own footing. The bow was the junior claim and it is gone.
 *
 * It moved to the terrain's line and not the other way round because the heightfield has
 * already graded a bench under `carthageWallZ` and the vegetation scatter already clears its
 * glacis there — a wall built anywhere else stands on ungraded ground with trees through it,
 * and `Siege.layOutGarrison` walks one continuous run of stations along a walkway that would
 * then step by metres between bays.
 *
 * `buildCarthageWall` therefore takes an optional `WallLine` (`xMin`, `xMax`, `gateX`, `zAt`)
 * and defaults to Rome's, so the `?fort=carthage` rig keeps building on the Aurelian circuit
 * and `probe-carthage-wall` keeps measuring the same 44 things, while the Carthage plan hands
 * it the terrain's line and the masonry lands on the bench.
 *
 * ---------------------------------------------------------------------------
 * WHAT A CITY MUST NOT DO
 * ---------------------------------------------------------------------------
 *
 * Three constraints, all of them load-bearing in code this file does not own.
 *
 *  - **The wall runs broadly along x, and the city is at +Z.** `CitySystem.bayAt` indexes
 *    bays arithmetically in x (`(x - bayX0) / bayPitch`) because it is called once per
 *    projectile per tick; `scenario.ts` deploys the attacker at z −190 and the defender at
 *    z +130; `Siege.ts` reads `GarrisonBay.nx/nz` as the outward normal. A circuit whose bays
 *    are not on a uniform x pitch will index wrongly and silently. `CitySystem` asserts the
 *    pitch at build time and warns; do not make it warn.
 *  - **No geometry at z below `battlefieldZ`, at any detail level.** `assertNoStrayGeometry`
 *    walks every baked vertex of every LOD and reports offenders. It exists because a
 *    monument once appeared at the world origin in the *mid* and *far* levels only, which is
 *    invisible from anywhere near the city and materialises out of nowhere as the camera
 *    pulls back.
 *  - **Draw calls.** The whole-frame cap is 220 and Rome sits at 200-218. A second city is
 *    never on screen at the same time as the first, so the budget is per map, not summed —
 *    but Carthage has the same ceiling and no more.
 */

// ---------------------------------------------------------------------------
// The wall contract
// ---------------------------------------------------------------------------

/**
 * Everything a city's curtain must publish, re-exported from the one place it is currently
 * defined.
 *
 * **These are `export type`, so importing them here costs nothing at runtime.** TypeScript
 * erases a type-only re-export entirely, which means `src/city/carthage/wall.ts` can import
 * the whole contract from this module without pulling Rome's 135 KB `wall.ts` — and its
 * Aurelian brick coursing, relieving arches, scaffolding and cranes — into the module graph.
 * Verify that with `import type` on the far side too; a value import of any of these names
 * would drag the lot in.
 *
 * `WallBuildOutput` is the single interface a second wall has to satisfy. Satisfy it field
 * for field and `CitySystem` will bake the chunks, raster the occupancy grid, build the
 * obstacle boxes, publish the stairs and answer `masonryTopAt` with no further work — which
 * is the entire point of the seam.
 */
export type {
  Blocker,
  CityChunkSpec,
  GarrisonBay,
  GateBlockOut,
  GateDoorOut,
  GateOut,
  TreeRequest,
  WallBuildOutput,
  WallSegmentOut,
  WallStair,
} from './wall';

/**
 * The extras a **multi-line** fortification publishes on top of `WallBuildOutput`.
 *
 * Rome's circuit is one wall and needs none of them. Carthage's is Appian's triple wall — an
 * outer palisade and ditch, a middle wall, and a main wall that is *hollow*, with elephant
 * stables and barracks in its thickness — and those are things a single-line contract has no
 * words for. Rather than widen `WallBuildOutput` for every city, they ride on `CityBuild` as
 * optionals, and `CitySystem` reads each with a default so a one-wall city need not know they
 * exist.
 *
 * `export type`, so this is erased: importing the contract does not import Carthage.
 */
export type { CarthageDitch, CasemateOut, OutworkOut } from './carthageWall';

/**
 * A lane a district cut for itself, in world space. Drawn with the rest of the network.
 *
 * Defined here rather than in a city's own fabric module because both cities' generators
 * emit it and `CityBuild` carries it: a shared shape belongs with the contract, not inside
 * whichever city happened to declare it first. It lived in Rome's insula generator until
 * `src/city/rome/` existed, which made every Carthage module import a Rome file for a type.
 */
export interface Lane {
  path: { x: number; z: number }[];
  cls: WayClass;
  width: number;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** An oriented rectangle in plan: a monument's or a building's footprint. */
export interface PlanRect {
  x: number;
  z: number;
  hw: number;
  hd: number;
  /**
   * Plan rotation, three.js convention — `makeRotationY(rot)` sends local +X to world
   * `(cos, −sin)`. `CitySystem` negates it at the boundary to reach the occupancy grid's
   * opposite hand. Publish the *plan* rotation; do not pre-mirror it.
   */
  rot: number;
}

/** A named monument, for the camera, the minimap and objective markers. */
export interface CityLandmarkRef {
  id: string;
  name: string;
  x: number;
  z: number;
}

/**
 * One build-time check, with the sentence that says what it measured.
 *
 * **`detail` is not decoration; it is the whole instrument.** Rome shipped
 * `assertNoFootprintOverlaps`, whose name reads like a guarantee and whose body compared
 * landmarks with landmarks, skipped anything `soft`, and had never in its life looked at an
 * insula. It reported zero — correctly, and about a different question — while the player was
 * staring at monuments dropped across housing. A scalar on `CityChecks` cannot carry the
 * population it sampled; this can, and it is what a reader needs to know whether `ok: true`
 * means anything.
 *
 * A non-zero result is **reported rather than suppressed**. An honest number with the
 * reasoning written down beats a green board, so `ok: true` is legitimate on a measurement
 * that is not a pass/fail at all — roof coverage, for one — provided `detail` says so.
 */
export interface CityAssertion {
  name: string;
  ok: boolean;
  /** Human-readable measurement, always populated — including when `ok`. */
  detail: string;
}

/**
 * Build-time self-checks, surfaced through `CitySystem.stats()` and the debug overlay.
 *
 * Every field is optional and defaults to "passed with nothing measured", so a young city
 * that has not written its assertions yet reports honestly rather than reporting a lie. Do
 * not default a check to `ok` by filling in a zero — leave it out.
 */
export interface CityChecks {
  /**
   * Every check the plan made, in the order it made them. See `CityAssertion`.
   *
   * The scalar fields below are the subset the stats panel and the debug overlay have
   * columns for; this is the full set with its reasoning, and it is what
   * `tools/probe-carthage.mjs` prints. A city may publish assertions the scalars have no
   * room for — Carthage's roof coverage, its stair-foot aprons, its ship-shed count — without
   * either widening this interface for every future city or dropping the measurement.
   */
  assertions?: readonly CityAssertion[];
  /** Landmark-on-landmark footprint overlaps. Must be 0. */
  footprintOverlaps?: number;
  footprintOverlapWorst?: number;
  /** Adjacency assertions passed, and how many were made. */
  topologyPass?: number;
  topologyChecks?: number;
  /** Buildings standing inside a monument. Must be 0. */
  fabricOverlaps?: number;
  fabricOverlapWorst?: number;
  /** Ranked-street centreline samples with masonry in the carriageway. Must be 0. */
  wayInsideMonument?: number;
  waySamples?: number;
  /** Street network by rank, for the stats panel. */
  ways?: { cls: string; count: number; km: number }[];
  /** Anything else the plan wants to shout about, one line each. Logged once at build. */
  warnings?: string[];
}

/** What `CityPlan.build` hands back. `CitySystem` does everything else. */
export interface CityBuild {
  /** The curtain, its gates, its bays and its stairs. See `WallBuildOutput`. */
  wall: import('./wall').WallBuildOutput;
  /**
   * Every chunk to bake, the wall's own included, in the order they should be registered.
   * `CitySystem` bakes each into one merged mesh per material per detail level.
   */
  chunks: import('./wall').CityChunkSpec[];
  /** Monument footprints: solid to any height, `kind: 'monument'` in the obstacle set. */
  landmarkFootprints: readonly PlanRect[];
  /** Ordinary fabric: houses, insulae, blocks. `kind: 'building'`. */
  buildingFootprints: readonly PlanRect[];
  /** Every street the districts cut for themselves. See `CitySystem.getLanes`. */
  lanes: readonly Lane[];
  /** Named monuments. See `CitySystem.getLandmarks`. */
  landmarks: readonly CityLandmarkRef[];
  checks: CityChecks;

  // -- multi-line fortifications only; every one defaulted by `CitySystem` ----------------

  /**
   * How far a curtain tower rises above the bay crest, for its obstacle box. Defaults to
   * `CityPlan.towerChamberHeight`.
   */
  towerRise?: number;
  /** The outer and middle lines, if there are any. */
  outworks?: readonly import('./carthageWall').OutworkOut[];
  /** O(1) top-of-masonry over those lines, which `bayAt` cannot answer — it indexes one bay. */
  outworkTopAt?: (x: number, z: number) => number;
  /** Chambers inside the thickness of the main wall. */
  casemates?: readonly import('./carthageWall').CasemateOut[];
  ditch?: import('./carthageWall').CarthageDitch | null;
  /**
   * What the 4 m occupancy raster is painted from, when it differs from `wall.blockers`.
   *
   * A hollow wall's obstacle boxes are two skins with a walkable corridor between them, and a
   * 1.5 m skin cannot be expressed in a 4 m cell — painting the skins would leave a 2.4 m
   * hole clean through the curtain in `blocksMovement`. So the raster paints the solid
   * section and the boxes carry the casemate.
   */
  occBlockers?: readonly { x1: number; z1: number; x2: number; z2: number; halfW: number }[];
  /**
   * The wall's own cross-section arithmetic, surfaced for a probe rather than trusted.
   *
   * **This is the one Carthage-shaped hole in a contract that is otherwise city-agnostic**,
   * and it is named rather than hidden: the type is `CARTHAGE_SECTION`'s. Generalise it when
   * a *third* multi-line fortification exists and there is a second instance to generalise
   * against; inventing the abstraction now would be inventing it from one example.
   */
  punicSection?: (typeof import('./carthageWall').CARTHAGE_SECTION & {
    faults: readonly string[];
  }) | null;
}

/**
 * A city, as data plus one build function.
 *
 * The constants below are not decoration: each one replaces a Rome-specific module constant
 * that `CitySystem` used to read directly, and each is consumed in a path that must not
 * branch on which city it is.
 */
export interface CityPlan {
  /** Stable key. `'rome'`, `'carthage'`. Never parsed for behaviour by a consumer. */
  readonly id: string;
  /** Display name, for objectives, the results screen and the assault's menu subtitle. */
  readonly name: string;
  /**
   * Whose city it is — the faction that garrisons the wall in an assault.
   *
   * Not derivable and not optional. `deployAssault` used to put `Faction.Rome` on the parapet
   * because Rome was the only city there was; on a second city that is not merely a label, it
   * is the wrong army on the wrong side of the wall. The storming side is then "whichever
   * belligerent is not this one", which is how the deployment stays free of a list of cities.
   */
  readonly garrison: Faction;
  /**
   * The gate the siege drives its ram at. Must match one of `WallBuildOutput.gates[].id`,
   * because `setGateOpen(id, true)` is how the ram wins.
   */
  readonly siegeGateId: string;
  /**
   * North edge of the city: no city geometry may stand at z below this, at any detail level.
   * The battlefield is everything below it and both armies deploy there.
   */
  readonly battlefieldZ: number;
  /**
   * Default rise of a tower chamber above the bay crest, for the tower box's top. A wall that
   * publishes `CityBuild.towerRise` overrides it.
   *
   * **There is deliberately no `towerWidth` here.** A tower's plan half-width is read from
   * `GarrisonBay.towerHalf`, which the wall builder publishes per bay — so a circuit whose
   * gate towers differ from its curtain towers can say so, and there is one fewer number for
   * a plan to get wrong.
   */
  readonly towerChamberHeight: number;
  /**
   * Crenellation period along a bay: merlon length, then the crenel gap between merlons.
   *
   * `masonryTopAt` alternates the two so a defender's own bolt is not stopped by his own
   * parapet on the way out, and so an onager stone lands among the garrison instead of
   * breaking on the battlement. It is arithmetic in a per-projectile hot path, so the period
   * is read from here rather than measured off the geometry — **it must match whatever the
   * wall's own `crenellation()` call uses, exactly.** 491 impacts on our own masonry in one
   * minute of battle is what a mismatch looks like.
   */
  readonly merlonLength: number;
  readonly crenelLength: number;
  /** Clear width of an open gate's carriageway, before the body-radius margin. */
  readonly gateOpenWidth: number;
  /**
   * Build the whole city onto this heightfield. Called exactly once, from `CitySystem.init`,
   * after the terrain exists and before anything reads a wall accessor.
   *
   * `heightAt` is already clamped to `±HALF_EXTENT`, so a plan may sample it anywhere without
   * guarding. It is the only source of ground height a plan may use: sampling the terrain
   * system directly would break the harness's fixed-size path.
   */
  build(heightAt: (x: number, z: number) => number): CityBuild;
}
