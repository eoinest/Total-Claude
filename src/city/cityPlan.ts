import type { Lane } from './insulae';

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

export type { Lane } from './insulae';

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
 * Build-time self-checks, surfaced through `CitySystem.stats()` and the debug overlay.
 *
 * Every field is optional and defaults to "passed with nothing measured", so a young city
 * that has not written its assertions yet reports honestly rather than reporting a lie. Do
 * not default a check to `ok` by filling in a zero — leave it out.
 */
export interface CityChecks {
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
   * The gate the siege drives its ram at. Must match one of `WallBuildOutput.gates[].id`,
   * because `setGateOpen(id, true)` is how the ram wins.
   */
  readonly siegeGateId: string;
  /**
   * North edge of the city: no city geometry may stand at z below this, at any detail level.
   * The battlefield is everything below it and both armies deploy there.
   */
  readonly battlefieldZ: number;
  /** Plan width of a curtain tower, for its footprint circle and its obstacle box. */
  readonly towerWidth: number;
  /** Rise of the tower chamber above the bay crest, for the tower box's top. */
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
