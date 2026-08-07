import type { Lane } from './insulae';
import type { Blocker, CityChunkSpec, TreeRequest, WallBuildOutput } from './wall';

/**
 * The seam between `CitySystem` — which bakes, LODs, rasterises and collides — and the
 * particular city being built.
 *
 * `CitySystem.init` used to *be* the plan of Rome: it called `buildWall`, `buildLandmarks`
 * and `buildDistricts` by name against module constants in `layout.ts`, so there was no
 * way to put a second city through the same machinery without forking eight hundred lines
 * of baking, occupancy rasterising and obstacle building. Everything Rome-specific has
 * moved to `romePlan.ts` behind this interface; `carthage/` implements it too.
 *
 * **What a plan owes the system.** Geometry as chunks, solids as oriented rectangles, the
 * street network for the diagnostics, and — optionally — a defended circuit. A city with
 * `wall: null` is legal: it builds, collides and navigates, it simply has no curtain to
 * storm yet. That is deliberate, because Carthage's triple wall is a separate workstream
 * and the fabric inside it must be buildable and measurable before the wall lands.
 */

/** An oriented rectangle in plan: a monument's or a building's footprint. */
export interface CityPlanRect {
  x: number;
  z: number;
  hw: number;
  hd: number;
  /** Plan rotation, three.js convention. `CitySystem` negates it for the occupancy grid. */
  rot: number;
  /**
   * What this solid *is*, which `probe-nav` reads to tell "a cohort walked through the wall"
   * from "a cohort walked through a house". Defaults to a building, because that is the
   * overwhelming majority and a mislabelled monument is a less dangerous error than a
   * mislabelled curtain.
   */
  kind?: 'monument' | 'building';
}

/**
 * A build-time check, reported through `stats()` rather than thrown.
 *
 * **An assertion here states what it measures, and a non-zero result is allowed to stand
 * if the reasoning is written down.** Rome shipped `assertNoFootprintOverlaps`, which
 * compared landmarks with landmarks, skipped anything `soft`, and had never looked at an
 * insula — it reported zero correctly and uselessly while the player was looking at
 * monuments dropped across housing. So: `detail` is not decoration. It is the sentence a
 * reader needs to know whether `ok: true` means anything.
 */
export interface CityAssertion {
  name: string;
  ok: boolean;
  /** Human-readable measurement, always populated — including when `ok`. */
  detail: string;
}

export interface CityPlan {
  readonly id: CityId;
  /** Everything to bake, one merged mesh set per chunk per detail level. */
  chunks: CityChunkSpec[];
  trees: TreeRequest[];
  /** Every solid on the ground: monuments, housing, precinct walls, quays. */
  footprints: CityPlanRect[];
  /** Extra solids that are better described as discs — tower bases, wells, cisterns. */
  occCircles: { x: number; z: number; r: number }[];
  /** Thick line solids that are not part of a wall circuit — terrace revetments, moles. */
  occSegments: Blocker[];
  /** Every street the plan cut, for the plan view and the network statistics. */
  lanes: Lane[];
  ways: { cls: string; count: number; km: number }[];
  landmarks: { id: string; name: string; x: number; z: number }[];
  /** The defended circuit, when one has been built. See the note above. */
  wall: WallBuildOutput | null;
  /**
   * Where the defended circuit runs, whether or not masonry stands on it.
   *
   * Separate from `wall` on purpose: the fabric generator, the intervallum and every nav
   * measurement need the line long before the stone exists, and a city whose fabric is
   * planned against a *different* line from the one the walls eventually follow is a seam
   * nobody can see until a cohort walks into a house.
   */
  circuitZAt: (x: number) => number;
  circuitXRange: readonly [number, number];
  assertions: CityAssertion[];
}

export type CityId = 'rome' | 'carthage';

/**
 * Which city this session is building.
 *
 * Two sources, in order:
 *
 *  1. `?city=carthage` on the URL. A developer and a probe override, and the only way to
 *     put Carthage on screen until the Carthage *map* lands — the fabric, the citadel and
 *     the harbours are buildable and measurable against any heightfield, and blocking that
 *     work on another workstream's terrain would have been the wrong dependency.
 *  2. The active map. `campus-martius` carries Rome; `carthage` will carry Carthage.
 *
 * Read once per call and never cached, because `main.ts` resolves the map before any
 * subsystem is constructed and `CitySystem.init` is the only caller.
 */
export function resolveCityId(activeMapId: string): CityId {
  if (typeof location !== 'undefined') {
    const forced = new URLSearchParams(location.search).get('city');
    if (forced === 'carthage' || forced === 'rome') return forced;
  }
  return activeMapId === 'carthage' ? 'carthage' : 'rome';
}
