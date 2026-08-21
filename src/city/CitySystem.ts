import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';
import type { Obstacle } from '../sim/Obstacles';
import type { TerrainSystem } from '../terrain/TerrainSystem';
import { HALF_EXTENT } from '../terrain/topography';
import { clamp, lerp } from '../util/math';
import { Batch, crenellationRun } from './build';
import type {
  CARTHAGE_SECTION, CarthageDitch, CasemateOut, OutworkOut,
} from './carthageWall';
import type {
  CityAssertion, CityBuild, CityChecks, CityLandmarkRef, CityPlan, PlanRect,
} from './cityPlan';
import type { Lane } from './cityPlan';
import { CITY_MAT_KEYS, CityMaterials } from './materials';
import { buildReferenceOverlay, type OverlayOptions, type ReferencePlan } from './overlay';
import { romeAmphitheatreCount } from './rome/plan';
/**
 * Rome's, and knowingly so — see the note in `wall.ts`. A bay that is a bare footing or a
 * rubble gap has no walk level to report, and what is standing there is Aurelian's
 * construction programme and Aurelian's plinth. Carthage never reaches the branch: every
 * Punic bay is `finished`. A third city that ships unfinished stretches has to publish its
 * own answer, and the honest place for it is the bay record rather than an import.
 */
import { unfinishedTopAt } from './rome/section';
import {
  type CityChunkSpec, type GarrisonBay, type GateBlockOut, type GateDoorOut,
  type GateOut, type RoughGround, type WallSegmentOut, type WallStair,
} from './wall';

/**
 * One gap in a battlement, as somewhere a shot can leave from. See `CitySystem.embrasureAt`.
 *
 * Declared here rather than in `wall.ts` beside `GarrisonBay` because it is not a property of
 * the stone: the two lengths that generate it come off the `CityPlan`, and the accessor that
 * resolves them against a bay is this system's. Everything on it is absolute or a normal-
 * offset, the same conventions `GarrisonBay` uses.
 */
export interface Embrasure {
  /** Index of the `GarrisonBay` the gap is in. */
  bay: number;
  /** World point on the bay's **centreline**, level with the middle of the gap. */
  x: number;
  z: number;
  /** Outward unit normal of the bay. */
  nx: number;
  nz: number;
  /** Unit vector along the run, `x0 -> x1`. */
  dx: number;
  dz: number;
  /** Absolute Y of the walkway behind the gap. */
  walkY: number;
  /** Absolute Y of the sill — the bottom of the gap, and the lowest a shot may pass. */
  sillY: number;
  /** Absolute Y of the merlon tops either side of it. */
  crestY: number;
  /** Normal-offsets of the parapet's inner and outer faces. */
  parapetInner: number;
  parapetOuter: number;
  /** Clear width of the gap along the run. Zero where there is no parapet to gap. */
  width: number;
  /** Signed metres along `dx, dz` from the query point to the centre of the gap. */
  step: number;
  /** Half the curtain's thickness here — the outer lip of the walk, as a normal-offset. */
  halfThickness: number;
  /**
   * Whether a battlement has been raised on this bay at all.
   *
   * False on a bay still under construction, where `masonryTopAt` answers `walkY` across the
   * whole cross-section: there is no tooth to shoot through and no gap to step to, and the
   * only thing in a man's way is the outer lip of the walk he is standing on. The heights
   * below are normalised to what the collision model will actually report, so a caller never
   * has to know which case it is in.
   */
  hasParapet: boolean;
}

/**
 * A besieged city: a curtain, its gates and its stairs, and the fabric behind them.
 *
 * **Which** city is a constructor argument. `CityPlan` (`./cityPlan.ts`) is a data object plus
 * one `build` function, supplied by the map through `MapDefinition.city`, so a map that
 * carries no plan gets no city and `main.ts` does not register this system at all. That is
 * not a stylistic choice. It replaces `hidesCity: boolean`, under which Rome's wall was built
 * onto the plain of Pydna and merely made invisible — where it blocked movement on a map it
 * was nowhere on screen in. Read the header of `cityPlan.ts` before adding a city, and before
 * adding a second implementation of one.
 *
 * Structure: every part of a city is authored as a `CityChunkSpec` — a centre, a radius and a
 * build function that takes a detail level. `init` bakes each chunk into one merged mesh per
 * material per detail level, and `preRender` swaps whole levels by camera distance. That is
 * what keeps 5 million triangles of city inside a hundred draw calls: a district of two
 * hundred insulae is two meshes, not four hundred objects.
 *
 * The system also maintains a coarse masonry occupancy grid so pathfinding and siege logic
 * can ask whether a line of movement is blocked without knowing anything about the geometry.
 */

interface LodLevel {
  group: THREE.Group;
  triangles: number;
}

interface Chunk {
  name: string;
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  /** Distant scenery: the horizon ring, which is meant to be off the map. */
  scenery: boolean;
  levels: LodLevel[];
  /** Distance at which level i+1 takes over from level i. */
  switchAt: number[];
  current: number;
  /** Which of this chunk's meshes may cast, and whether they currently do. */
  casters: THREE.Mesh[];
  casting: boolean;
  /** This chunk is a gate's shut leaves. `CityChunkSpec.gateDoorFor`. */
  gateDoorFor: string | null;
  /** This chunk is a gate's wreckage, drawn only once it is broken. */
  gateWreckFor: string | null;
  /**
   * Held off the screen by something other than distance — today, gate state.
   *
   * Kept as a chunk field rather than as a raw `group.visible = false`, because the LOD
   * swap in `preRender` writes `visible` on every level it moves between and would have
   * turned the leaves back on the first time the camera crossed a switch distance. Three
   * places read the current level's group — the swap, `debugForceLod` and the draw ledger
   * in `getStats` — and all three have to agree that a suppressed chunk is not there.
   */
  suppressed: boolean;
}

/**
 * Beyond this distance a chunk stops casting.
 *
 * Every shadow-casting mesh is re-rendered once per cascade, so the shadow passes, not the
 * colour pass, are where a city of this size spends its draw calls. At three quarters of a
 * kilometre an insula's shadow is a couple of texels of the outermost cascade and its
 * contribution is a slightly darker smudge; the four extra draw calls buy nothing. Near
 * geometry — the curtain, its towers, the scaffolding — keeps casting, which is where
 * shadow actually carries the mass of the masonry.
 */
const SHADOW_CUTOFF = 700;

/**
 * How far past its declared radius a chunk's geometry may reach before it is reported.
 * A chunk's radius is computed from its members' centres and clearances, and a monument's
 * own steps and precinct paving legitimately overhang that a little.
 */
const STRAY_RADIUS_TOLERANCE = 1.35;

/**
 * The material a shadow proxy carries. It is never shaded — the shadow pass substitutes a
 * depth material — and it is never seen, because the proxy's draw range is zero outside the
 * shadow pass. It exists only because `WebGLShadowMap` skips an object whose material is
 * invisible, so the proxy cannot simply be hidden.
 */
const PROXY_MATERIAL = new THREE.MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
  depthTest: false,
});

/**
 * One depth-only mesh standing in for a chunk's whole casting set.
 *
 * A chunk is split into one mesh per material for the colour pass, and that split is
 * multiplied by the cascade count in the shadow pass: measured at the Rome assault camera,
 * 19 city meshes went into each of four cascades for 76 of the frame's 279 draw calls. The
 * split buys nothing there — every one of those meshes resolves to the same opaque depth
 * material, so the four passes are drawing one silhouette in six pieces.
 *
 * This merges the casting geometry into a single position-and-index buffer and lets only
 * that cast. The silhouette is identical to the pixel, because it is the same triangles.
 *
 * The awkward part is keeping it out of the colour pass, and three.js leaves exactly one
 * seam to do it through. `WebGLShadowMap.renderObject` skips an object whose `visible` or
 * whose `material.visible` is false, so neither flag can hide the proxy from the colour pass
 * alone. Draw range can: `WebGLRenderer.projectObject` builds the colour render list without
 * consulting it, and `onBeforeShadow`/`onAfterShadow` fire around the shadow draw and nowhere
 * else. So the proxy sits at a zero draw range and opens only for the cascades. It still
 * costs one call per casting chunk in the colour pass — `renderBufferDirect` early-returns
 * only on a *negative* count, not a zero one — which is honest, counted, and a twentieth of
 * what it saves.
 */
function buildShadowProxy(meshes: readonly THREE.Mesh[], name: string): THREE.Mesh | null {
  const casters = meshes.filter((m) => m.castShadow && m.geometry.getAttribute('position'));
  // Two meshes are the break-even point: one proxy costs one colour call plus one call per
  // cascade, so it only pays from the second caster on.
  if (casters.length < 2) return null;

  let vCount = 0;
  let iCount = 0;
  for (const m of casters) {
    vCount += m.geometry.getAttribute('position').count;
    const idx = m.geometry.getIndex();
    iCount += idx ? idx.count : m.geometry.getAttribute('position').count;
  }
  const pos = new Float32Array(vCount * 3);
  // A city chunk runs to hundreds of thousands of vertices, past what a Uint16 index holds.
  const idxArr = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let vAt = 0;
  let iAt = 0;
  for (const m of casters) {
    const p = m.geometry.getAttribute('position');
    pos.set(p.array as ArrayLike<number>, vAt * 3);
    const idx = m.geometry.getIndex();
    if (idx) {
      const a = idx.array as ArrayLike<number>;
      for (let i = 0; i < idx.count; i++) idxArr[iAt + i] = a[i] + vAt;
      iAt += idx.count;
    } else {
      for (let i = 0; i < p.count; i++) idxArr[iAt + i] = i + vAt;
      iAt += p.count;
    }
    vAt += p.count;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idxArr, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  // Closed outside the shadow pass. `Infinity` is three.js's own "all of it" sentinel and is
  // what `BufferGeometry` starts with.
  g.setDrawRange(0, 0);

  const proxy = new THREE.Mesh(g, PROXY_MATERIAL);
  proxy.name = `${name}-shadow`;
  proxy.castShadow = true;
  proxy.receiveShadow = false;
  proxy.matrixAutoUpdate = false;
  proxy.updateMatrix();
  proxy.onBeforeShadow = () => g.setDrawRange(0, Infinity);
  proxy.onAfterShadow = () => g.setDrawRange(0, 0);
  for (const m of casters) m.castShadow = false;
  // The meshes this proxy stands in for, so `setShadowProxies` can hand the job back and the
  // claim "the silhouette is identical" can be checked against pixels in one session rather
  // than asserted across two.
  proxy.userData.replaces = casters;
  for (const m of casters) m.userData.replacedBy = proxy;
  return proxy;
}

interface StrayReport {
  ok: boolean;
  /** Worst overshoot past a chunk's declared radius, metres. */
  worst: number;
  offenders: { chunk: string; level: number; kind: string; x: number; z: number }[];
}

/**
 * The standing masonry of one outwork bay: the whole run, or the two stubs either side of a
 * passage.
 *
 * One helper, three consumers — the occupancy raster, the obstacle boxes and the geometry
 * builder in `carthageWall.ts` all derive their spans from `passageAt` the same way. The
 * staggered gate openings only mean anything if all three cut in the *same* six metres, and
 * a boolean "this bay is a passage" already once threw away a 29.7 m bay for a 6 m gap.
 */
function outworkSpans(ow: OutworkOut): [number, number, number, number][] {
  if (ow.standsDown) return [];
  const len = Math.hypot(ow.x1 - ow.x0, ow.z1 - ow.z0);
  const at = (t: number): [number, number] => [ow.x0 + ow.dx * t, ow.z0 + ow.dz * t];
  if (ow.passageAt === null) return [[ow.x0, ow.z0, ow.x1, ow.z1]];
  const half = 3.0;
  const out: [number, number, number, number][] = [];
  const a = Math.max(0, ow.passageAt - half);
  const b = Math.min(len, ow.passageAt + half);
  if (a > 0.5) out.push([...at(0), ...at(a)] as [number, number, number, number]);
  if (b < len - 0.5) out.push([...at(b), ...at(len)] as [number, number, number, number]);
  return out;
}

/** A curtain bay that stops movement, as `buildWall` reports it. */
interface WallBlocker {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  halfW: number;
}


/**
 * Convert a **plan** rotation into an **occupancy** rotation. They are mirror images, and
 * for years everything here has quietly conflated them.
 *
 * A footprint out of `layout.ts` or `landmarks.ts` follows three.js: `makeRotationY(r)`
 * sends the box's local +X to world `(cos r, −sin r)` and +Z to `(sin r, cos r)`, and
 * `rome.ts`'s `worldRot` says so in as many words. The occupancy grid's `markRect` and
 * `Obstacles.ts` use the opposite hand — local u to `(cos r, +sin r)` — which is the same
 * rectangle reflected in the X axis.
 *
 * For a district at ±0.08 rad the error is nine degrees and merely blurs a wall. For a
 * monument it is not small: the Circus Maximus stands at 0.6 rad, so its collision box was
 * rotated 68° off the masonry — 600 m of racetrack whose solid volume lay diagonally across
 * the Vallis Murcia rather than along it. Nothing caught it because the occupancy grid and
 * the obstacle list were painted from the *same* wrong convention, so every probe that
 * grades one against the other agreed with itself.
 *
 * `Obstacles.ts` belongs to the sim and its convention is self-consistent, so the fix is a
 * negation at the boundary rather than a change to anyone else's axes.
 */
const occRot = (planRot: number): number => -planRot;

/**
 * How far a flight must stand above its own foot before it stops a man on the ground.
 *
 * A wall stair is a ramp, not a wall: at its bottom tread it is 0.29 m of stone that anybody
 * walks up, and at its head it is six metres of masonry nobody walks through. A single box
 * over the whole flight would be wrong at one end or the other, and wrong at the bottom is
 * the dangerous direction — the siege system queues its garrison *at the foot* and clears
 * `elevated` while they stand there (`Siege.ts`, `footSlot`), so a man waiting his turn is
 * subject to masonry collision like anyone else. Boxing the foot would shove the queue off
 * its own staircase, which is a worse bug than the one this fixes.
 *
 * 1.2 m is mid-thigh to chest: below it the stone is something to step onto, above it
 * something to walk round. On this circuit the flights rise 2.2–6 m over 14.2–20.4 m, so
 * this leaves the bottom 3–4 m of every rake open and makes the remaining three quarters
 * solid.
 */
const STAIR_STEP_OVER = 1.2;

/**
 * The part of a flight that is solid to a man on the ground, as a thick segment.
 *
 * One helper, two consumers: the occupancy raster stamps it and `buildObstacles` pushes it
 * as an oriented box. `getObstacles()` and `blocksMovement()` disagreeing about the same
 * masonry is the exact bug this file produced with the gate carriageway, so the geometry is
 * derived once.
 *
 * Foot → head is a straight linear ramp never more than 0.15 m off the stone, so height
 * above the foot is simply the fraction along times the rise. The direction is taken from
 * the two endpoints rather than the published `dx/dz`, because the endpoints are what the
 * stone was built from.
 */
function stairSolid(s: WallStair): {
  x1: number; z1: number; x2: number; z2: number; halfW: number; topY: number;
} | null {
  const dx = s.headX - s.footX;
  const dz = s.headZ - s.footZ;
  const len = Math.hypot(dx, dz);
  if (!(len > 1e-3) || !(s.rise > 0)) return null;
  // Fraction of the rake left open at the foot. Capped at half the flight so a shallow
  // stair — one that never gets 1.2 m off the ground — still presents a solid upper half
  // rather than vanishing from the obstacle set altogether.
  const t0 = Math.min(0.5, STAIR_STEP_OVER / s.rise);
  return {
    x1: s.footX + dx * t0, z1: s.footZ + dz * t0,
    x2: s.headX, z2: s.headZ,
    halfW: s.width * 0.5,
    // Solid to the head, not to the sky: a man on the wall-walk is above it and unobstructed.
    topY: s.headY,
  };
}

/** Cell size of the masonry occupancy grid, in metres. */
const OCC_CELL = 4;
const OCC_RES = Math.ceil((HALF_EXTENT * 2) / OCC_CELL);

export class CitySystem implements Subsystem {
  readonly name = 'city';
  // Static world: after terrain (−50), before anything that reads the city.
  readonly order = -20;

  private mats = new CityMaterials();

  /**
   * Which city, and everything about it that is not generic machinery.
   *
   * A constructor argument rather than a module import, so this file has no idea whether it
   * is building Rome or Carthage and cannot acquire one. See `./cityPlan.ts`.
   */
  constructor(private readonly plan: CityPlan) {}

  /** The city being built. Consumers wanting a display name or a gate id read it from here. */
  get cityPlan(): CityPlan {
    return this.plan;
  }

  /**
   * Skip the asset manifest and build every material procedurally. The city has to run
   * with an empty `public/assets/`, and this is how that gets tested in a frame rather
   * than asserted in a comment.
   */
  useProceduralTexturesOnly(on: boolean): void {
    this.mats.proceduralOnly = on;
  }
  private root = new THREE.Group();
  private chunks: Chunk[] = [];
  private segments: WallSegmentOut[] = [];
  private gateList: GateOut[] = [];
  /** Where the gatehouse masonry stands. Straddles two bays; see `GateBlockOut`. */
  private gateBlock: GateBlockOut | null = null;
  private bays: GarrisonBay[] = [];
  /** Every masonry flight onto the wall-walk. See `getWallStairs`. */
  private stairs: readonly WallStair[] = [];
  /** The Porta Flaminia's leaves, and whether they are shut. See `getGateDoor`. */
  private gateDoor: GateDoorOut | null = null;
  /** Gates whose leaves the ram has brought down. See `setGateDoorBroken`. */
  private brokenGates = new Set<string>();
  /**
   * Bay index by x, for the O(1) masonry lookup a projectile needs. Bays are on a fixed
   * `WALL.towerSpacing` pitch from `WALL_X_MIN`, so the index is arithmetic, not a search:
   * a search over fifty segments per arrow per tick, at two thousand arrows, is not free.
   */
  private bayPitch = 1;
  private bayX0 = 0;
  /**
   * Carthage's outer and middle lines, and the O(1) lookup that reports their tops.
   *
   * Empty and null on the Aurelian circuit, which has one wall line and needs neither. They
   * are held here rather than folded into `bays` because `bayAt` is index arithmetic in x
   * and cannot answer with three different bays for one x — see `getOutworks`.
   */
  private outworks: readonly OutworkOut[] = [];
  private outworkTopAt: ((x: number, z: number) => number) | null = null;
  private casemates: readonly CasemateOut[] = [];
  private ditch: CarthageDitch | null = null;
  private punic: NonNullable<CityBuild['punicSection']> | null = null;
  /**
   * What the 4 m occupancy raster is painted from, when it differs from `blockers`.
   *
   * Null on Rome, where the wall is solid and the two are the same list. Carthage's main wall
   * is hollow and its obstacle boxes say so — two skins with a walkable corridor between —
   * but a 1.5 m skin cannot be expressed in a 4 m cell, and painting the skins into the
   * raster would leave a 2.4 m hole clean through the curtain in `blocksMovement`. So the
   * raster paints the solid section and the boxes carry the casemate. See `CasemateOut`.
   */
  private rasterBlockers: readonly WallBlocker[] | null = null;
  /**
   * How far a curtain tower rises above the bay crest, for its obstacle box.
   *
   * `WALL.towerChamberHeight` is Aurelian's 5.0 m ballista chamber; Appian's Punic towers
   * are four storeys and stand 2.3 m clear of a wall that is itself twice as high. Held as
   * a field so `buildObstacles` does not hard-code one circuit's tower into the other's.
   */
  private towerRise = 0;
  private occ = new Uint8Array(OCC_RES * OCC_RES);
  /** Oriented-box form of everything in `occ`. See `buildObstacles`. */
  private obstacles: Obstacle[] = [];
  /** Kept so opening or closing a gate can re-cut the curtain boxes. */
  private wallBlockers: readonly WallBlocker[] = [];
  /** Standing work that is crossed at a price rather than stopped at. See `RoughGround`. */
  private rough: readonly RoughGround[] = [];
  /**
   * Bumped whenever `getObstacles()` changes shape — a gate opening, a wall breached — so
   * consumers holding a spatial index know to rebuild it.
   *
   * Started at 2, not 1: the initial set changed shape when the hole beside the Porta
   * Flaminia was closed. It gained a tower at the east end of the gate bay and its curtain
   * boxes now have stone standing in them, so any index cached against generation 1 is
   * describing a different city.
   *
   * Now 3. The street rebuild replaced the BSP fabric with terraces of party-walled
   * insulae, so both the *count* and the *shape* of every building box changed, and the
   * monuments' boxes are no longer mirrored (`occRot`). Any consumer holding an index
   * built against generation 2 is describing a city that no longer exists.
   */
  obstacleGeneration = 3;
  private totalTris = 0;
  private meshCount = 0;
  /** Whatever the plan asserted about itself at build time. See `CityChecks`. */
  private checks: CityChecks = {};
  /** Every lane the quarters cut for themselves, in world space. See `getLanes`. */
  private lanes: readonly Lane[] = [];
  /** Named monuments, from the plan. See `getLandmarks`. */
  private landmarkRefs: readonly CityLandmarkRef[] = [];
  private stray: StrayReport = { ok: true, worst: 0, offenders: [] };
  /** Diagnostics only: see `debugForceLod`. */
  private forcedLod: number | null = null;
  /** Whether merged proxies carry shadow casting, or the per-material meshes do. */
  private shadowProxies = true;
  private overlay: THREE.Mesh | null = null;
  /** Terrain sampler kept for the debug overlay, which is built after `init`. */
  private overlayGround: ((x: number, z: number) => number) | null = null;
  /**
   * Terrain sampler, for the stages of the wall that follow the ground instead of a
   * construction level. See `unfinishedTopAt`.
   */
  private groundAt: ((x: number, z: number) => number) | null = null;

  async init(ctx: EngineContext): Promise<void> {
    const terrain = ctx.get<TerrainSystem>('terrain');
    const heightAt = (x: number, z: number): number =>
      terrain.heightAt(clamp(x, -HALF_EXTENT, HALF_EXTENT), clamp(z, -HALF_EXTENT, HALF_EXTENT));

    await this.mats.load();

    this.root.name = 'city';
    ctx.scene.add(this.root);
    this.overlayGround = heightAt;
    this.groundAt = heightAt;

    // ---- plan ---------------------------------------------------------------
    /**
     * Everything city-specific happens inside this one call, **including which circuit
     * stands on the crest.**
     *
     * This is the reconciliation of two seams that arrived independently. One selected the
     * *fortification* through a module singleton (`setFortification('carthage')`, `?fort=`);
     * the other selected the *city plan*. They are one decision, not two: a plan that named
     * Rome's fabric and Carthage's wall describes no city that ever existed, and two
     * singletons that must agree is the same shape of bug as `hidesCity`, which is what put
     * Rome's wall across the plain of Pydna. So the plan calls its own wall builder and the
     * selection has exactly one home — `MapDefinition.city`.
     *
     * Both builders return the same `WallBuildOutput`, so everything downstream of this line
     * — the chunk baker, the occupancy raster, the obstacle set and all four accessors the
     * siege system drives — is one code path for both cities. A multi-line circuit *adds*
     * fields (outworks, casemates, a ditch, a taller tower, a separate raster list); it
     * changes none, and every one of them is read with a default so a single-line wall need
     * not know they exist.
     */
    const built = this.plan.build(heightAt);
    const wall = built.wall;
    this.outworks = built.outworks ?? [];
    this.outworkTopAt = built.outworkTopAt ?? null;
    this.casemates = built.casemates ?? [];
    this.towerRise = built.towerRise ?? this.plan.towerChamberHeight;
    this.rasterBlockers = built.occBlockers ?? null;
    this.ditch = built.ditch ?? null;
    this.punic = built.punicSection ?? null;
    // The builder's own arithmetic, surfaced rather than trusted: a section that does not sum
    // to its own stated thickness is a bug nobody sees until a probe walks the stone.
    if (this.punic && this.punic.faults.length > 0) {
      console.warn(`[city:${this.plan.id}] section faults: ${this.punic.faults.join('; ')}`);
    }
    this.segments = wall.segments;
    this.rough = wall.roughGround;
    this.gateList = wall.gates;
    this.gateBlock = wall.gateBlock;
    this.bays = wall.garrisonBays;
    this.stairs = wall.stairs;
    this.gateDoor = wall.gateDoor;
    this.lanes = built.lanes;
    this.landmarkRefs = built.landmarks;
    this.checks = built.checks;
    if (this.bays.length > 1) {
      this.bayX0 = this.bays[0].x0;
      this.bayPitch = this.bays[1].x0 - this.bays[0].x0;
    }
    // Resolve each bay's battlement against its own run once, here, rather than in
    // `masonryTopAt` — which runs per projectile per tick — and so that the collision model
    // and `embrasureAt` cannot drift apart. See `crenellationRun`.
    this.crenStep = new Float64Array(this.bays.length);
    this.crenMerlon = new Float64Array(this.bays.length);
    /**
     * Each bay's tower, resolved here for the same reason and from the same numbers
     * `buildObstacles` stamps its tower box from.
     *
     * A tower was solid to a *body* and transparent to a *shot*: `buildObstacles` pushes an
     * oriented box `towerHalf` square rising `towerRise` above the crest, and `masonryTopAt`
     * had no tower branch at all — it resolved a bay and tested the curtain cross-section, so
     * it answered `walkY` at the centre of a tower standing 7 m higher. Measured on Rome at
     * 7dd9616: a lofted onager stone aimed into a tower's upper storey crossed the whole
     * footprint with the model reporting 52.8 against an obstacle top of 59.85 and landed
     * 37 m inside the city. That is the reported "catapult projectiles pass through walls".
     *
     * `towerTopY` is `-Infinity` where there is no tower, or where the bay has no finite crest
     * to raise one from — the branch then falls through to the curtain test rather than
     * shadowing it with a height taken from an unbuilt bay.
     */
    this.towerHalfY = new Float64Array(this.bays.length);
    this.towerTopY = new Float64Array(this.bays.length);
    for (let i = 0; i < this.bays.length; i++) {
      const r = crenellationRun(this.bays[i].length, this.plan.merlonLength, this.plan.crenelLength);
      this.crenStep[i] = r.step;
      this.crenMerlon[i] = r.merlon;
      const bay = this.bays[i];
      // `hasTower`, not `towerHalf > 0`, exactly as `buildObstacles` does: `towerHalf` also
      // carries the gatehouse's intrusion into the bay it lands in, and a tower there is a
      // phantom the obstacle set does not stamp either.
      const solid = bay.hasTower && bay.towerHalf > 0 && Number.isFinite(bay.crestY);
      this.towerHalfY[i] = solid ? bay.towerHalf : 0;
      this.towerTopY[i] = solid ? bay.crestY + this.towerRise : -Infinity;
    }
    // The gatehouse's battlement, resolved once against its own run for the same reason.
    // It cannot go through `crenStep` — the block straddles two bays and one x cannot name
    // two runs, which is why it is a separate record in the first place — and it cannot use
    // the plan's merlon lengths, because on Rome the stone was cut at 1.5 / 0.8 and the plan
    // states 1.7 / 0.95. See `GateBlockOut.merlonLength`.
    if (this.gateBlock) {
      const gr = crenellationRun(
        this.gateBlock.halfRun * 2,
        this.gateBlock.merlonLength,
        this.gateBlock.crenelLength,
      );
      this.gateStep = gr.step;
      this.gateMerlon = gr.merlon;
    }
    this.assertUniformBayPitch();
    for (const w of this.checks.warnings ?? []) console.warn(`[city:${this.plan.id}] ${w}`);

    /**
     * Hand the camera rig the surface a body could stand on, the way `TerrainSystem` hands it
     * the earth (`ctx.rig.heightAt`, `TerrainSystem.init`).
     *
     * The rig resolved every height it needed from the heightfield, which is bare earth, so a
     * focus standing on a wall-walk 13.8 m up on Carthage put the eye 1.7 m over the ground at
     * the *foot* of the wall — 12.1 m under the walkway, inside the masonry, looking up. This
     * is the query that fixes it and there is nothing else to it: the clearance logic that was
     * already there does the rest. See `RTSCamera.walkableTopAt` and `src/core/seams.ts`.
     *
     * Installed here rather than resolved by the rig through `tryGet('city')` for the same
     * reason the terrain is: a map with no city registers no provider, and a null function
     * pointer is a state the rig already handles, where a registry miss is a silent one.
     */
    /*
     * `bind`, and not `(x, z) => this.walkableTopAt(x, z)` the way the terrain sampler next
     * door is written. That arrow is what was here first and it silently dropped the third
     * argument — the storey the caller is standing on — so the rig asked every question with
     * the default, and a camera marching through the Punic gate climbed 13.4 m onto the
     * gatehouse roof and back down again over 55 m of pan. Measured; see
     * `tools/probe-walleye.mjs`, walk `through-the-arch`.
     *
     * TypeScript cannot see it: a two-parameter function is assignable to a three-parameter
     * type, which is the whole point of that rule and is exactly wrong here. `bind` forwards
     * whatever it is given and cannot be written with the wrong arity.
     */
    ctx.rig.walkableTopAt = this.walkableTopAt.bind(this);

    // ---- bake ---------------------------------------------------------------
    for (const spec of built.chunks) this.bakeChunk(spec, heightAt);

    // ---- build-time proof that nothing stands in the battlefield ------------
    this.stray = this.assertNoStrayGeometry();
    if (!this.stray.ok) {
      console.warn(
        `[city] ${this.stray.offenders.length} stray-geometry offender(s): ` +
          this.stray.offenders
            .map((o) => `${o.chunk}/lod${o.level} ${o.kind} @ (${o.x.toFixed(0)}, ${o.z.toFixed(0)})`)
            .join('; ')
      );
    }

    // ---- movement blocking --------------------------------------------------
    for (const b of this.rasterBlockers ?? wall.blockers) {
      this.markSegment(b.x1, b.z1, b.x2, b.z2, b.halfW);
    }
    /**
     * Carthage's forward lines, stamped from the same records `buildObstacles` reads.
     *
     * A bay flagged `passage` is skipped in *both* views, which is the whole reason the two
     * are derived from one list: the staggered gate gaps and the posterns are what make a
     * triple wall permeable, and a raster that closed them while the box set left them open
     * would route a column at a gap the collision surface does not have.
     */
    for (const ow of this.outworks) {
      for (const [ax, az, bx, bz] of outworkSpans(ow)) {
        this.markSegment(ax, az, bx, bz, ow.halfThickness);
      }
    }
    // Tower footprints project beyond the curtain.
    for (const seg of this.segments) {
      // `bay.towerHalf`, from the bay the wall itself published — not a plan-level constant.
      // A circuit whose towers vary along it (Carthage's gate towers are not its curtain
      // towers) can then say so per bay, and there is one fewer number for a plan to get
      // wrong. The fallback is the bay's own thickness, not any city's tower width.
      const bay = this.bayAt(seg.x1);
      const towerHalf = bay && bay.towerHalf > 0 ? bay.towerHalf : (bay?.halfThickness ?? 0);
      if (towerHalf > 0) this.markCircle(seg.x1, seg.z1, towerHalf);
    }
    /**
     * The nine flights onto the wall-walk, from the same helper `buildObstacles` uses, so
     * the raster and the box set cannot disagree about a stair the way they once did about
     * the gate carriageway.
     *
     * The start is pulled further up the rake than the box's, and only here. `markSegment`
     * paints every cell within `halfW + OCC_CELL/2` of the line — 3.4 m for a 2.8 m flight —
     * so stamping the box's own extent would bleed back over the open foot and take the
     * pathfinder's access to it with it. Measured: two of the nine feet stopped being
     * routable. Backing the raster off by exactly that bleed leaves the same ground open in
     * both views, which is the whole point of deriving them from one helper.
     */
    for (const s of this.stairs) {
      const solid = stairSolid(s);
      if (!solid) continue;
      const dx = solid.x2 - solid.x1;
      const dz = solid.z2 - solid.z1;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      const back = Math.min(0.6, (OCC_CELL * 0.5 + solid.halfW) / len);
      this.markSegment(
        solid.x1 + dx * back, solid.z1 + dz * back, solid.x2, solid.z2, solid.halfW
      );
    }
    for (const f of built.landmarkFootprints) this.markRect(f.x, f.z, f.hw, f.hd, occRot(f.rot));
    for (const f of built.buildingFootprints) this.markRect(f.x, f.z, f.hw, f.hd, occRot(f.rot));
    /**
     * A gate that is **open** has its carriageway cleared again so units can march through.
     *
     * This used to be unconditional, from when the Porta Flaminia stood open and there was
     * no other case. The leaves are now shut at build time (`GateOut.open === false`), and
     * clearing regardless left the two views of the city disagreeing about the one thing
     * the player asked to change: `getObstacles()` — which is what the pathfinder stamps —
     * had no cut in the curtain, while `blocksMovement()` reported a 4.8 m corridor straight
     * through it. A unit would then be routed at a gate the collision surface does not open.
     * `setGateOpen(id, true)` performs exactly this clear when the ram wins.
     */
    this.assertGatePassages(heightAt);
    for (const gate of this.gateList) {
      if (!gate.open || this.unpierced.has(gate.id)) continue;
      this.clearSegment(gate.x, gate.z - 20, gate.x, gate.z + 20, 2.4);
    }

    this.buildObstacles(wall.blockers, built.landmarkFootprints, built.buildingFootprints);

    /**
     * One line at boot naming what the city costs and where.
     *
     * The whole-frame cap is 220 and the live assault camera has measured **259**, so Rome is
     * already over before a second city exists. A single total cannot be acted on; the family
     * breakdown can, and printing it every boot means the next person to add 33 towers and
     * 4.4 km of vaulting sees the bill on the run that adds them rather than in a probe three
     * days later. `visibleMeshes` is the city's upper bound before frustum culling, which is
     * the honest number to budget against.
     */
    const s = this.stats();
    console.info(
      `[city:${this.plan.id}] ${s.visibleMeshes} draws (cap 220 whole-frame), ` +
        `${(s.visibleTriangles / 1e6).toFixed(2)} M tris visible, ${s.chunks} chunks — ` +
        s.drawsByFamily.slice(0, 6).map((f) => `${f.family} ${f.meshes}`).join(', ')
    );
  }

  /**
   * `bayAt` indexes bays arithmetically in x. Prove the circuit it was handed can be.
   *
   * `Math.floor((x - bayX0) / bayPitch)` costs nothing and runs once per projectile per tick,
   * which is why it is arithmetic and not a search — but it is only correct for bays on a
   * uniform pitch along x, and nothing before this checked. On Rome the curtain is a shallow
   * polyline on a fixed `WALL.towerSpacing`, so it has always held by construction and the
   * assumption was invisible. A second city can break it silently: every masonry query on the
   * wall — `masonryTopAt`, the tower boxes, the obstacle tops — would answer for the wrong
   * bay, and the failure looks like arrows passing through stone rather than like an index bug.
   *
   * 12 % because a circuit that steps round a corner legitimately shortens a bay or two.
   */
  private assertUniformBayPitch(): void {
    if (this.bays.length < 3) return;
    let worst = 0;
    let at = -1;
    for (let i = 1; i < this.bays.length; i++) {
      const d = this.bays[i].x0 - this.bays[i - 1].x0;
      const err = Math.abs(d - this.bayPitch) / Math.abs(this.bayPitch);
      if (err > worst) {
        worst = err;
        at = i;
      }
    }
    if (worst > 0.12) {
      console.warn(
        `[city:${this.plan.id}] bay pitch is not uniform in x — worst ${(worst * 100).toFixed(0)}% ` +
          `at bay ${at}, against a nominal ${this.bayPitch.toFixed(2)} m. \`bayAt\` indexes ` +
          'arithmetically and will answer for the wrong bay. See cityPlan.ts.'
      );
    }
  }

  /**
   * The same solids as the occupancy grid, kept as oriented boxes instead of a 4 m raster.
   *
   * The raster answers "is this cell masonry"; the sim needs "how far, and which way, is
   * out", which a raster cannot give without a distance transform. Keeping both costs one
   * array of ~3,000 rectangles and means the collision surface a man feels is the geometry
   * he can see rather than a staircase quantised to 4 m.
   */
  private buildObstacles(
    blockers: readonly WallBlocker[],
    landmarkFootprints: readonly PlanRect[],
    districtFootprints: readonly PlanRect[]
  ): void {
    this.wallBlockers = blockers;
    const out: Obstacle[] = [];

    this.pushWallFamily(out);

    // ---- towers -------------------------------------------------------------
    // Square, projecting 3.5 m beyond the outer face. Their tops are a storey above the
    // walk, but the garrison that passes through a tower chamber is flagged `elevated` and
    // exempt from collision, so a solid box costs nothing and stops a besieger walking
    // through the base.
    for (const seg of this.segments) {
      const bay = this.bayAt(seg.x1);
      // `hasTower`, not `towerHalf > 0`: `towerHalf` also carries the gatehouse's
      // intrusion into the bay it lands in, and a tower box there would be a phantom.
      if (!bay || !bay.hasTower) continue;
      // `this.towerRise`, not a constant: Aurelian's is a 5 m ballista chamber and Appian's
      // Punic tower is four storeys on a wall already twice as high. `bay.towerHalf` for the
      // same reason — it is `WALL.towerWidth * 0.5` on Rome, so this stays Rome-identical.
      const top = (Number.isFinite(bay.crestY) ? bay.crestY : 0) + this.towerRise;
      out.push({
        x: seg.x1, z: seg.z1,
        hw: bay.towerHalf,
        hd: bay.towerHalf,
        rot: Math.atan2(seg.x2 - seg.x1, seg.z2 - seg.z1),
        topY: top,
        kind: 'tower',
      });
    }

    // ---- fabric -------------------------------------------------------------
    // Roofs are not walkable in this game, so a monument and an insula are solid to any
    // height. 1e4 rather than Infinity keeps the value finite in a Float32Array.
    for (const f of landmarkFootprints) {
      out.push({ x: f.x, z: f.z, hw: f.hw, hd: f.hd, rot: occRot(f.rot), topY: 1e4, kind: 'monument' });
    }
    for (const f of districtFootprints) {
      out.push({ x: f.x, z: f.z, hw: f.hw, hd: f.hd, rot: occRot(f.rot), topY: 1e4, kind: 'building' });
    }

    this.obstacles = out;
  }

  /**
   * Every solid filed under `kind: 'wall'` — curtain, forward lines and stairs.
   *
   * **One producer, two callers, and that is the whole point of it existing.** The build
   * emitted these in three separate loops and `recutWallObstacles` — which runs whenever a
   * gate opens or shuts — rebuilt only the first, then concatenated back everything whose
   * kind was *not* `'wall'`. The stairs and the forward lines are `'wall'`, so they were
   * dropped by the filter and never re-emitted.
   *
   * That was not a rare path. `Siege.armGate` shuts the gate on the first tick of every
   * battle and deliberately toggles it open-then-shut to force the raster, so **two recuts
   * happen before a man has moved**: measured, Rome went 56 wall boxes to 47 and Carthage
   * 160 to 147 within one tick of load, taking all nine and all thirteen flights — 14–20 m
   * of masonry apiece, the longest solids in the city — out of the collision set for the
   * rest of the battle. On Carthage the stair boxes were also the only thing standing
   * across seven of the eight postern gaps, so losing them opened seven 6 m holes in a
   * curtain that is drawn solid.
   *
   * This is the same defect as the gate carriageway being cleared from the occupancy grid
   * unconditionally, in the same file, one level up: two views of one piece of stone,
   * derived twice.
   */
  private pushWallFamily(out: Obstacle[]): void {
    // ---- curtain ------------------------------------------------------------
    // One box per blocked bay, with the wall-walk as its top so the garrison standing on
    // it is *on* the wall rather than inside it. `blockers` omits the bare footing bays,
    // which the occupancy grid deliberately leaves open — and which are **not** ankle-high,
    // whatever this comment used to claim: measured, 1.35–3.54 m of standing concrete. They
    // are published separately by `getRoughGround()`, so what is open is still open and is
    // no longer free.
    for (const b of this.wallBlockers) {
      const mx = (b.x1 + b.x2) * 0.5;
      const bay = this.bayAt(mx);
      // A gap bay is rubble and a palisade — no walkway, so its top is the rampart crest.
      // `walkable`, not `garrisonable`: the gate bay carries a wall-walk on both flanks of
      // the gatehouse and no garrison, and taking its top from `crestY` buried the walking
      // surface two metres inside the merlons.
      const top = bay ? (bay.walkable ? bay.walkY : bay.crestY) : this.masonryTopAt(mx, (b.z1 + b.z2) * 0.5);
      this.pushWallBox(out, b.x1, b.z1, b.x2, b.z2, b.halfW, Number.isFinite(top) ? top : 1e4);
    }

    // ---- forward lines ------------------------------------------------------
    /**
     * Real masonry, but not a garrison line. Empty on both circuits as they now stand —
     * Carthage's outer and middle walls were removed at `dd57abf` — and kept because
     * `getOutworks()` is still the published way for a plan to declare one.
     *
     * `bayAt` is index arithmetic in x and one x cannot name two bays, so a forward line is
     * published as its own record rather than folded into `getGarrisonBays()`.
     */
    for (const ow of this.outworks) {
      for (const [ax, az, bx, bz] of outworkSpans(ow)) {
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.5) continue;
        out.push({
          x: (ax + bx) * 0.5, z: (az + bz) * 0.5,
          hw: len * 0.5, hd: ow.halfThickness,
          rot: Math.atan2(bz - az, bx - ax),
          topY: ow.walkY,
          kind: 'wall',
        });
      }
    }

    // ---- wall stairs --------------------------------------------------------
    /**
     * The flights onto the walkway, which nothing collided with until `27a9e85`.
     *
     * Ground units walked straight through 14–20 m of masonry apiece. That was tolerable
     * when a flight projected 3.3 m out of a tower's city face; since the rebuild put them
     * *along* the curtain they are the longest solids in the city.
     *
     * `kind` is `'wall'` rather than a new kind of its own. A flight is built hard against
     * the inner face and lies wholly within the twelve metres of the centreline that every
     * consumer already treats as curtain, so calling it anything else would split one piece
     * of masonry across two categories for no gain — and `ObstacleKind` lives in the sim,
     * which is not this workstream's to widen. The cost of that choice was the bug this
     * method exists to prevent: read `recutWallObstacles` before adding a fourth family.
     */
    for (const s of this.stairs) {
      const solid = stairSolid(s);
      if (!solid) continue;
      const dx = solid.x2 - solid.x1;
      const dz = solid.z2 - solid.z1;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      out.push({
        x: (solid.x1 + solid.x2) * 0.5, z: (solid.z1 + solid.z2) * 0.5,
        // u along the flight, v across its width — the same convention as a curtain bay.
        hw: len * 0.5, hd: solid.halfW,
        rot: Math.atan2(dz, dx),
        topY: solid.topY,
        kind: 'wall',
      });
    }
  }

  /**
   * Push a curtain bay as one or two boxes, punching out any open gate carriageway that
   * crosses it.
   *
   * The gate is at x = 72, which falls in bay 19 while the gatehouse *geometry* is centred
   * on bay 20 — so the carriageway the occupancy grid clears sits inside a neighbouring
   * bay's blocker. Splitting the box is what keeps the one way into the city open.
   */
  private pushWallBox(
    out: Obstacle[],
    x1: number, z1: number, x2: number, z2: number,
    halfW: number, topY: number
  ): void {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return;
    // `rot` is the yaw of the box's u axis, and the u axis is (cos rot, sin rot) in (x,z) —
    // the same convention `markRect` uses — so this points u along the wall.
    const rot = Math.atan2(dz, dx);
    const emit = (t0: number, t1: number): void => {
      if (t1 - t0 < 0.02) return;
      const ax = x1 + dx * t0;
      const az = z1 + dz * t0;
      const bx = x1 + dx * t1;
      const bz = z1 + dz * t1;
      out.push({
        x: (ax + bx) * 0.5, z: (az + bz) * 0.5,
        // u runs along the wall, v across its thickness.
        hw: len * (t1 - t0) * 0.5, hd: halfW,
        rot, topY, kind: 'wall',
      });
    };

    // Clear width plus a body radius either side, so a column can actually enter.
    const half = this.plan.gateOpenWidth * 0.5 + 0.5;
    let cut: [number, number] | null = null;
    for (const gate of this.gateList) {
      // `unpierced` is a gate that says it is open and whose stone is not cut. Punching the
      // box anyway is a hole in a wall the player can see standing. See `assertGatePassages`.
      if (!gate.open || this.unpierced.has(gate.id)) continue;
      const t = ((gate.x - x1) * dx + (gate.z - z1) * dz) / (len * len);
      const dt = half / len;
      if (t + dt <= 0 || t - dt >= 1) continue;
      cut = [Math.max(0, t - dt), Math.min(1, t + dt)];
      break;
    }
    if (!cut) {
      emit(0, 1);
      return;
    }
    emit(0, cut[0]);
    emit(cut[1], 1);
  }

  /** Build every detail level of one chunk and register it for LOD swapping. */
  private bakeChunk(spec: CityChunkSpec, heightAt: (x: number, z: number) => number): void {
    const levels: LodLevel[] = [];
    const switchAt: number[] = [];
    const casters: THREE.Mesh[] = [];
    // Only build the levels the switch distances actually reach.
    const wanted: number[] = [2];
    if (spec.lodSwitch[0] < 1e8) wanted.push(1);
    if (spec.lodSwitch[1] < 1e8) wanted.push(0);
    wanted.sort((a, b) => b - a); // 2 (full) first

    for (let i = 0; i < wanted.length; i++) {
      const detail = wanted[i];
      // The cheapest level collapses into one material, so a whole district or a whole
      // stretch of wall becomes one mesh at long range. The middle level folds the trim
      // materials away, which halves its mesh count for no visible loss — see
      // `TRIM_MERGE` in build.ts.
      const batch = new Batch(
        this.mats,
        detail === 0 ? (spec.farMaterial ?? 'stone') : undefined,
        detail === 1
      );
      spec.build(batch, detail);
      const group = new THREE.Group();
      group.name = `${spec.name}-lod${i}`;
      group.visible = i === 0;
      // Only the nearest level casts. A chunk at its mid level is beyond its own
      // `lodSwitch[0]` — several hundred metres — where its shadow is already inside the
      // outer cascades' texel footprint, and re-rendering it four times to blur it away
      // was costing more calls than the whole city's main pass.
      const meshes = batch.toMeshes(spec.name, spec.castShadow && detail >= 2);
      // Built before the meshes are parented, because it clears `castShadow` on the ones it
      // takes over from.
      const proxy = buildShadowProxy(meshes, `${spec.name}-lod${i}`);
      for (const mesh of meshes) {
        group.add(mesh);
        if (mesh.castShadow) casters.push(mesh);
      }
      if (proxy) {
        group.add(proxy);
        // Both the proxy and the meshes it stands in for go on the caster list, so the
        // distance cutoff in `preRender` keeps working whichever way `setShadowProxies` has
        // it. `applyCasting` decides which of the two actually carries the flag.
        casters.push(proxy, ...(proxy.userData.replaces as THREE.Mesh[]));
      }
      this.meshCount += meshes.length;
      levels.push({ group, triangles: batch.triangleCount });
      this.totalTris += batch.triangleCount;
      this.root.add(group);
      // Indexed by the *tier that takes over*, not by array position: `lodSwitch[0]` is where
      // mid detail replaces full and `lodSwitch[1]` where far replaces mid. A spec that skips
      // the mid tier used to take its only switch distance from `lodSwitch[0]`, so its far
      // tier could never appear.
      if (i < wanted.length - 1) switchAt.push(spec.lodSwitch[wanted[i + 1] === 1 ? 0 : 1]);
    }

    // Wreckage is authored for a state the battle has not reached, so it is baked and then
    // held off the screen. Costing nothing to draw is the whole reason it can be built at
    // all: a hidden group is skipped by `WebGLRenderer.projectObject`, so the broken gate is
    // free until it is broken and the intact leaves it replaces are free afterwards.
    const suppressed = spec.gateWreckFor !== undefined;
    if (suppressed) for (const l of levels) l.group.visible = false;

    this.chunks.push({
      name: spec.name,
      cx: spec.cx,
      cy: heightAt(spec.cx, spec.cz) + 8,
      cz: spec.cz,
      radius: spec.radius,
      scenery: spec.scenery === true,
      levels,
      switchAt,
      current: 0,
      casters,
      casting: true,
      gateDoorFor: spec.gateDoorFor ?? null,
      gateWreckFor: spec.gateWreckFor ?? null,
      suppressed,
    });
  }

  /**
   * Build-time proof that no city geometry stands in the battlefield or outside the chunk
   * whose bounding volume culls it — **at every detail level, not just the one a screenshot
   * happens to show.**
   *
   * This is the assertion the user's report needed and the build did not have. Rome is
   * behind the wall at z > 450; the battlefield is z < 250 and both armies deploy in it. A
   * monument emitted at the world origin therefore stands in the middle of the parade
   * ground — and because the fault was in the *mid* and *far* detail levels only, it was
   * invisible from anywhere near the city and appeared out of nowhere as the camera pulled
   * back. Checking vertices rather than bounding boxes is deliberate: a bounding box wide
   * enough to hold a district also holds the origin, so a box test proves nothing.
   *
   * Costs one pass over the baked position buffers, about 4 ms for the whole city.
   */
  private assertNoStrayGeometry(): StrayReport {
    const offenders: { chunk: string; level: number; kind: string; x: number; z: number }[] = [];
    const battlefieldZ = this.plan.battlefieldZ;
    let worst = 0;
    for (const c of this.chunks) {
      for (let li = 0; li < c.levels.length; li++) {
        for (const child of c.levels[li].group.children) {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh) continue;
          const pos = mesh.geometry.getAttribute('position');
          if (!pos) continue;
          const arr = pos.array as ArrayLike<number>;
          let inField = 0;
          let onMap = 0;
          let far = 0;
          let fx = 0;
          let fz = 0;
          let farD = 0;
          for (let i = 0; i < pos.count; i++) {
            const x = arr[i * 3];
            const z = arr[i * 3 + 2];
            const d = Math.hypot(x - c.cx, z - c.cz);
            if (d > farD) {
              farD = d;
              fx = x;
              fz = z;
            }
            if (c.scenery) {
              // The horizon ring must lie wholly outside the heightfield.
              if (Math.abs(x) < HALF_EXTENT && Math.abs(z) < HALF_EXTENT) onMap++;
            } else if (z < battlefieldZ && z > -HALF_EXTENT && Math.abs(x) < HALF_EXTENT) {
              inField++;
            }
          }
          if (farD > c.radius * STRAY_RADIUS_TOLERANCE + 12) far++;
          if (inField > 0) {
            offenders.push({ chunk: c.name, level: li, kind: `${inField} vertices in the battlefield`, x: fx, z: fz });
          }
          if (onMap > 0) {
            offenders.push({ chunk: c.name, level: li, kind: `${onMap} scenery vertices on the heightfield`, x: fx, z: fz });
          }
          if (far > 0) {
            offenders.push({
              chunk: c.name,
              level: li,
              kind: `${farD.toFixed(0)} m from the chunk centre, radius ${c.radius.toFixed(0)} m`,
              x: fx,
              z: fz,
            });
          }
          worst = Math.max(worst, farD - c.radius);
        }
      }
    }
    return { ok: offenders.length === 0, worst: +worst.toFixed(1), offenders };
  }

  /**
   * Gates that stand open at build time and whose **drawn stone has no passage**.
   *
   * See `assertGatePassages`. Empty on Rome.
   */
  private unpierced = new Set<string>();
  /** What `assertGatePassages` found at build, so shutting a gate can re-arm the refusal. */
  private unpiercedAtBuild = new Set<string>();

  /** Gates whose collision cut was refused because the stone is not pierced. Diagnostics. */
  getUnpiercedGates(): readonly string[] {
    return [...this.unpierced];
  }

  /**
   * Refuse to cut a hole in the collision surface where the drawn stone has none.
   *
   * `CitySystem` opens a carriageway in the occupancy raster and in the oriented boxes for
   * every gate whose record says `open`. That is a *claim by the wall builder* that it has
   * cut a passage, and until now nothing checked it. Carthage publishes eight posterns as
   * already-open gates — the mechanism by which a casemate wall is a wall you can pass
   * through, and it needed no new code because `pushWallBox` and the raster clear were
   * already there — but `buildPostern` sets a pierced arch *panel* into each face and never
   * cuts the wall's own skins. Measured with a raycast against the baked chunks: at every
   * height from 0.5 m to 5.0 m and every lateral offset out to ±8 m, a ray down a postern
   * axis is stopped at the outer face, 9.2 m from a start 14 m out. There is no hole.
   *
   * From the player's seat that is a column of men walking through a wall, and it is
   * invisible to every man-tick counter in this repo, because those measure against the
   * obstacle set — which agrees with itself. It is the same two-halves-disagree defect as
   * the carriageway being cleared from the occupancy grid unconditionally, running the
   * other way: the collision surface says open, the stone says solid.
   *
   * Two deliberate limits, both of them fail-open:
   *
   *  - **Only gates that are already open before anything has happened.** A gate the siege
   *    opens is trusted absolutely (`setGateOpen` clears the id below), because a ram that
   *    has beaten the leaves down has earned its hole and refusing it would make a city
   *    untakeable. Carthage's three main gates are not pierced either — measured the same
   *    way, `porta-byrsae` stops a ray at 9.1 m with the leaves excluded — so this rule is
   *    load-bearing and not theoretical.
   *  - **All three heights must be blocked.** One stopped ray is a threshold slab or a
   *    dropped portcullis groove; three is a wall.
   *
   * The check retires itself: the day the stone is cut, the rays pass and the postern opens
   * with no further change here.
   */
  private assertGatePassages(heightAt: (x: number, z: number) => number): void {
    this.unpierced.clear();
    this.unpiercedAtBuild.clear();
    const solid: string[] = [];
    const t0 = performance.now();
    for (const gate of this.gateList) {
      if (!gate.open) continue;
      // Outward normal of the circuit at this gate. `facing` points out of the city.
      const nx = Math.sin(gate.facing);
      const nz = Math.cos(gate.facing);
      // Reach just past both faces of the curtain and no further. A longer probe finds the
      // stair that stands 1.7 m behind the inner face and reads it as the wall.
      const half = (this.bayAt(gate.x)?.halfThickness ?? 3) + 0.6;
      const g = heightAt(gate.x, gate.z);
      let blocked = 0;
      for (const h of [0.8, 1.6, 2.4]) {
        const y = g + h;
        if (this.segmentHitsStone(
          gate.x + nx * half, y, gate.z + nz * half,
          gate.x - nx * half, y, gate.z - nz * half
        )) blocked++;
      }
      if (blocked === 3) {
        this.unpierced.add(gate.id);
        this.unpiercedAtBuild.add(gate.id);
        solid.push(gate.id);
      }
    }
    if (solid.length) {
      console.warn(
        `[city:${this.plan.id}] ${solid.length} gate(s) stand open with no passage cut in ` +
        `the stone — the collision cut is refused so men do not walk through a solid wall: ` +
        `${solid.join(', ')}. Cut the passage in the wall builder and this retires itself. ` +
        `(${(performance.now() - t0).toFixed(1)} ms)`
      );
    }
  }

  /**
   * Does a short world segment meet any baked city triangle?
   *
   * Möller–Trumbore over the full-detail level of every chunk whose bounding sphere the
   * segment could reach. The gate leaves are excluded by tag: a door is not a wall, and
   * `setGateOpen(id, true)` re-cuts the boxes *before* `applyGateDoorState` hides them, so
   * a check that counted them would refuse to open a gate the ram had just broken.
   *
   * Build-time only, a few dozen rays. It walks index buffers rather than using a
   * `Raycaster` so it costs no scene traversal and no matrix work — the baked positions are
   * already world-space, which `assertNoStrayGeometry` relies on too.
   */
  private segmentHitsStone(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number
  ): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
    const reach = Math.hypot(dx, dy, dz) * 0.5;
    for (const c of this.chunks) {
      if (c.gateDoorFor || c.gateWreckFor || c.scenery) continue;
      if (Math.hypot(c.cx - mx, c.cz - mz) > c.radius + reach) continue;
      for (const child of c.levels[0].group.children) {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) continue;
        const pos = mesh.geometry.getAttribute('position');
        if (!pos) continue;
        const p = pos.array as ArrayLike<number>;
        const idx = mesh.geometry.getIndex();
        const ind = idx ? (idx.array as ArrayLike<number>) : null;
        const tris = ind ? ind.length / 3 : pos.count / 3;
        for (let t = 0; t < tris; t++) {
          const i0 = (ind ? ind[t * 3] : t * 3) * 3;
          const i1 = (ind ? ind[t * 3 + 1] : t * 3 + 1) * 3;
          const i2 = (ind ? ind[t * 3 + 2] : t * 3 + 2) * 3;
          const e1x = p[i1] - p[i0], e1y = p[i1 + 1] - p[i0 + 1], e1z = p[i1 + 2] - p[i0 + 2];
          const e2x = p[i2] - p[i0], e2y = p[i2 + 1] - p[i0 + 1], e2z = p[i2 + 2] - p[i0 + 2];
          const hx = dy * e2z - dz * e2y;
          const hy = dz * e2x - dx * e2z;
          const hz = dx * e2y - dy * e2x;
          const a = e1x * hx + e1y * hy + e1z * hz;
          // Two-sided: the inner face of a skin is wound away from the field and a
          // one-sided test would walk straight out through the back of the wall.
          if (a > -1e-9 && a < 1e-9) continue;
          const f = 1 / a;
          const sx = ax - p[i0], sy = ay - p[i0 + 1], sz = az - p[i0 + 2];
          const u = f * (sx * hx + sy * hy + sz * hz);
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y;
          const qy = sz * e1x - sx * e1z;
          const qz = sx * e1y - sy * e1x;
          const v = f * (dx * qx + dy * qy + dz * qz);
          if (v < 0 || u + v > 1) continue;
          const s = f * (e2x * qx + e2y * qy + e2z * qz);
          if (s > 1e-6 && s < 1) return true;
        }
      }
    }
    return false;
  }

  /**
   * How much of a chunk's radius the distance test forgives.
   *
   * Measuring to a chunk's surface rather than its centre is right in principle — a district
   * a kilometre across should not drop to a silhouette because its midpoint is far away —
   * but subtracting a flat 55 % of the radius made the near switch unreachable for every
   * chunk wider than about twice that distance, and Rome's are. Measured at the shipped
   * `city` camera: `monuments-d` is 1,526 m across, so the correction was 840 m against a
   * switch at 400; `city-campus-n` 619 m against 300; `city-south` 533 m against 280. Six of
   * twenty-one chunks could never leave full detail from anywhere on a 2.8 km map, and
   * `insulae.ts` had already worked around it by merging six districts into one chunk with
   * the comment that "a chunk 700 m across is never far away by that measure".
   *
   * Capping the forgiveness at half the near switch distance keeps the intent — a big chunk
   * still gets the benefit of the doubt — while guaranteeing the ladder can always be
   * climbed, because the remaining half of the switch distance is always reachable.
   *
   * Carthage avoids the whole problem by capping chunk radius at 140 m against the same
   * 340 m switch, which is the better answer where the geometry allows it. Rome's districts
   * are single authored masses and cannot be cut that small without adding the draw calls
   * the merge was there to remove, so it is fixed here instead of in the chunk layout.
   */
  private surfaceCorrection(c: Chunk): number {
    const nearSwitch = c.switchAt.length > 0 ? c.switchAt[0] : Infinity;
    return Math.min(c.radius * 0.55, nearSwitch * 0.5);
  }

  /**
   * Point a chunk's shadow flag at whichever caster set is currently in charge.
   *
   * A chunk with a single casting mesh gets no proxy — one merged mesh standing in for one
   * mesh saves nothing — and that mesh must keep casting in *both* modes. Reading the mode
   * off "is this a proxy" alone silenced every such chunk, which cost the city's cypresses
   * their shadows over 8.5 % of the `city` frame before the pixel A/B caught it.
   */
  private applyCasting(c: Chunk): void {
    for (const m of c.casters) {
      const paired = m.userData.replaces !== undefined || m.userData.replacedBy !== undefined;
      const wanted = !paired || (m.userData.replaces !== undefined) === this.shadowProxies;
      m.castShadow = c.casting && wanted;
    }
  }

  /**
   * Swap detail levels by camera distance. Hysteresis of 12 % stops a chunk flipping
   * back and forth while the camera hovers on a threshold.
   */
  preRender(ctx: EngineContext): void {
    if (this.forcedLod !== null) return;
    const cam = ctx.camera.position;
    for (const c of this.chunks) {
      if (c.suppressed) continue;
      const dx = cam.x - c.cx;
      const dy = cam.y - c.cy;
      const dz = cam.z - c.cz;
      const d = Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - this.surfaceCorrection(c));

      // Shadow casting by distance, with 15 % hysteresis so a hovering camera does not
      // flip a district's shadow on and off.
      if (c.casters.length > 0) {
        const want = d < SHADOW_CUTOFF * (c.casting ? 1.15 : 1.0);
        if (want !== c.casting) {
          c.casting = want;
          this.applyCasting(c);
        }
      }

      if (c.levels.length < 2) continue;
      let want = c.levels.length - 1;
      for (let i = 0; i < c.switchAt.length; i++) {
        // 12 % hysteresis, applied only when coming *back* to a nearer level, so a camera
        // hovering on a threshold does not flip the chunk every frame.
        if (d < c.switchAt[i] * (c.current > i ? 0.88 : 1.0)) {
          want = i;
          break;
        }
      }
      if (want !== c.current) {
        c.levels[c.current].group.visible = false;
        c.levels[want].group.visible = true;
        c.current = want;
      }
    }
  }

  // ------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------

  /** Wall segments as world-space line segments, for pathfinding and siege logic. */
  getWallSegments(): { x1: number; z1: number; x2: number; z2: number; height: number }[] {
    return this.segments;
  }

  /**
   * Every solid in the city as an oriented box with an absolute top.
   *
   * This is the same set the occupancy grid is painted from — curtain bays that are not
   * bare footings, the towers, the monuments and all 2,907 insulae — but in a form a
   * moving body can be pushed *out* of rather than merely tested against. The open gate's
   * carriageway is already punched through the bay it crosses.
   *
   * Consumers must honour `topY`: a man standing on the wall-walk is on the wall, not in
   * it, and the garrison would be evicted from its own parapet by anything that ignored
   * the third dimension here.
   */
  getObstacles(): readonly Obstacle[] {
    return this.obstacles;
  }

  /**
   * Built work a body can cross but should not cross for free.
   *
   * The third state the wall never had. `getObstacles()` answers "is this solid" and the
   * occupancy raster answers "is this shut", and a bay at stage `footing` is neither: it is
   * 6.8 m of travertine and poured concrete standing 1.4–3.5 m above the ground beside it,
   * deliberately open because it is the only way into Rome that needs no ladder, and until
   * this existed it was open in the sense that *nothing in the game knew it was there*.
   *
   * Empty on any circuit with no unfinished bays, which today is Carthage. Read through the
   * optional-method idiom the pathfinder and the sim already use for this API, so a consumer
   * that has not been taught about it degrades to the old behaviour rather than failing.
   *
   * **Deliberately not folded into `getObstacles()`.** Every consumer of that list treats
   * what it finds as impassable — the nav stamp, the push-out, the picker — so adding the
   * footing bays there would seal the three bays the assault depends on, which is the one
   * outcome this must not have.
   */
  getRoughGround(): readonly RoughGround[] {
    return this.rough;
  }

  /** Gate positions and whether they are open. `facing` points out of the city. */
  getGates(): { id: string; x: number; z: number; facing: number; open: boolean }[] {
    return this.gateList;
  }

  /**
   * Open or close a gate. Closing it fills the passage in the movement grid.
   *
   * **This now moves the leaves too.** It used to write the occupancy raster, re-cut the
   * oriented boxes and touch no mesh, so a gate the ram had opened went on being *drawn*
   * shut for the rest of the battle: measured on Rome, the ram reaches the leaves at t+100,
   * lands 26 blows, the gate is open at t+220 and three men are on the carriageway by t+300
   * — and the player watches two doors that never move. Drawing shut leaves across a
   * carriageway that pathfinding, the crowd solver and the obstacle push-out all treat as
   * open is not a stylisation, it is the two halves of one state disagreeing, which is the
   * bug class `getGateDoor` already re-reads `open` off the gate record to avoid.
   */
  setGateOpen(id: string, open: boolean): void {
    const gate = this.gateList.find((g) => g.id === id);
    if (!gate || gate.open === open) return;
    gate.open = open;
    /*
     * An explicit call outranks the build-time passage check, in both directions.
     *
     * A ram that has beaten the leaves down has earned its hole whatever the stone still
     * says — refusing it would make a city untakeable, and on Carthage no gate's passage is
     * cut, so this is load-bearing rather than theoretical. Shutting a gate re-arms the
     * check for it, so `Siege.armGate`'s deliberate open-then-shut on the first tick leaves
     * the world exactly as the build left it.
     */
    if (open) this.unpierced.delete(id);
    else if (this.unpiercedAtBuild.has(id)) this.unpierced.add(id);
    if (open) this.clearSegment(gate.x, gate.z - 20, gate.x, gate.z + 20, 2.4);
    else this.markSegment(gate.x, gate.z - 6, gate.x, gate.z + 6, 2.6);
    this.recutWallObstacles();
    this.applyGateDoorState(id);
  }

  /**
   * The leaves of gate `id` are **wreckage**: hide them and put the splinters on the ground.
   *
   * This is the seam the siege workstream asked for, in its words — "emit the twin leaves as
   * their own object, or add `CitySystem.setGateDoorBroken(id)`". Both were done: the leaves
   * are their own `CityChunkSpec` on both circuits, tagged `gateDoorFor`, and a second chunk
   * tagged `gateWreckFor` carries the broken pose. This call swaps one for the other.
   *
   * The exact call, from `Siege.ts`, at the point where `gateBreached` is set:
   *
   * ```ts
   * const broken = this.city?.getGates()[0];
   * if (broken) {
   *   this.city?.setGateOpen(broken.id, true);
   *   this.city?.setGateDoorBroken(broken.id);   // ← the new line
   * }
   * ```
   *
   * Read the id off the same gate the rest of the siege uses and never name one: `7e72785`
   * was landed because the breach said `'porta-flaminia'` while `armGate` and `spawnRam`
   * used `getGates()[0]`, and on Carthage the ram then landed every blow into a carriageway
   * that stayed solid for ever. `setGateDoorBroken` takes an id for the same reason and does
   * nothing at all if no chunk claims it, so a circuit with no modelled leaves is not a
   * crash.
   *
   * **`setGateOpen(id, true)` alone already hides the intact leaves**, because an open gate
   * with its doors drawn shut is simply wrong however it was opened. What this adds is the
   * *broken* state, and it is sticky: `setGateOpen(id, false)` re-hangs leaves that are
   * merely shut, and `armGate` shuts the gate on the first tick of every battle, so without
   * the distinction a wrecked gate would grow its doors back the moment anything closed it.
   * Pass `false` to un-break — scenario restart, not gameplay.
   *
   * Visual only. It writes no raster, no obstacle and no `GateOut`, so it cannot be a source
   * of divergence and it is safe to call outside `fixedUpdate`.
   */
  setGateDoorBroken(id: string, broken = true): void {
    if (broken) this.brokenGates.add(id);
    else this.brokenGates.delete(id);
    this.applyGateDoorState(id);
  }

  /** True once `setGateDoorBroken` has been called for this gate. */
  isGateDoorBroken(id: string): boolean {
    return this.brokenGates.has(id);
  }

  /**
   * Point the leaf and wreck chunks at the gate's current state.
   *
   * Derived from `GateOut.open` and the broken set every time rather than tracked, because
   * two records that can disagree about whether Rome is open is the bug this file keeps
   * producing.
   */
  private applyGateDoorState(id: string): void {
    const broken = this.brokenGates.has(id);
    const open = this.gateList.find((g) => g.id === id)?.open ?? false;
    const hangs = !broken && !open;
    for (const c of this.chunks) {
      if (c.gateDoorFor === id) this.suppressChunk(c, !hangs);
      else if (c.gateWreckFor === id) this.suppressChunk(c, !broken);
    }
  }

  /** Take a chunk off the screen, or put it back at whatever level it was on. */
  private suppressChunk(c: Chunk, off: boolean): void {
    if (c.suppressed === off) return;
    c.suppressed = off;
    for (let i = 0; i < c.levels.length; i++) c.levels[i].group.visible = !off && i === c.current;
    // A hidden group is skipped by the colour pass but **not** by the shadow pass unless the
    // flag comes off the meshes: `WebGLShadowMap.render` walks the scene itself. These two
    // chunks ship `castShadow: false` so the list is empty, but a future one need not.
    if (off) for (const m of c.casters) m.castShadow = false;
    else this.applyCasting(c);
  }

  /**
   * Rebuild the whole `'wall'` family after a gate has opened or closed. The fabric and the
   * towers never move, so they are left alone; a ram breaking the gate must not cost a
   * rebuild of three thousand rectangles.
   *
   * It must be the *whole* family and not just the curtain. The filter below drops every
   * box whose kind is `'wall'`, and the stairs and the forward lines are `'wall'` too — so
   * a version of this that re-emitted only `wallBlockers` deleted them. See
   * `pushWallFamily`, which is now the single producer both callers share.
   */
  private recutWallObstacles(): void {
    const kept = this.obstacles.filter((o) => o.kind !== 'wall');
    const walls: Obstacle[] = [];
    this.pushWallFamily(walls);
    this.obstacles = walls.concat(kept);
    this.obstacleGeneration++;
  }

  /**
   * True if a straight line between two points crosses masonry. Walks the occupancy
   * grid with a DDA, so cost is proportional to length, not to the number of
   * buildings — a unit can ask this every tick.
   */
  blocksMovement(x1: number, z1: number, x2: number, z2: number): boolean {
    let ix = this.cellOf(x1);
    let iz = this.cellOf(z1);
    const ex = this.cellOf(x2);
    const ez = this.cellOf(z2);
    if (this.occAt(ix, iz)) return true;
    if (ix === ex && iz === ez) return false;

    const dx = x2 - x1;
    const dz = z2 - z1;
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    // Parametric length of the segment spent crossing one cell on each axis.
    const tPerX = dx !== 0 ? OCC_CELL / Math.abs(dx) : Infinity;
    const tPerZ = dz !== 0 ? OCC_CELL / Math.abs(dz) : Infinity;
    const fx = (x1 + HALF_EXTENT) / OCC_CELL - ix;
    const fz = (z1 + HALF_EXTENT) / OCC_CELL - iz;
    // Parameter at which the ray first crosses a cell boundary on each axis.
    let tx = dx !== 0 ? (dx > 0 ? 1 - fx : fx) * tPerX : Infinity;
    let tz = dz !== 0 ? (dz > 0 ? 1 - fz : fz) * tPerZ : Infinity;

    // `tx` and `tz` increase strictly, so the walk terminates once both pass 1.
    for (let guard = 0; guard < 4096; guard++) {
      if (tx < tz) {
        if (tx > 1) return false;
        ix += stepX;
        tx += tPerX;
      } else {
        if (tz > 1) return false;
        iz += stepZ;
        tz += tPerZ;
      }
      if (this.occAt(ix, iz)) return true;
      if (ix === ex && iz === ez) return false;
    }
    return false;
  }

  /**
   * Every bay of the curtain, described as a place a man can stand. See `GarrisonBay`.
   *
   * `walkY` is **absolute**, and is produced by the same function that emits the wall-walk
   * geometry, so a garrison cannot drift out of register with the stone it stands on.
   */
  getGarrisonBays(): readonly GarrisonBay[] {
    return this.bays;
  }

  /**
   * The lanes each quarter cut for itself — the *other* 38 km of Rome's streets.
   *
   * `layout.ts`'s exported `WAYS` is the named armature only: twenty-two viae, 11 km. The
   * district generator then cuts a spine-and-rib lattice per quarter and returns it in
   * `DistrictOutput.lanes` — 374 lanes and 38 km, more than three times the armature — and
   * until now nothing outside `wayMix`'s running total could see them.
   *
   * That blind spot was not academic. The land audit built its street keep-out from `WAYS`
   * alone, so every vicus and every local lane in the city was scored as *unbuilt ground*,
   * and the walled city read 20.5 % built with 35.6 % "free". Roughly 39 hectares of that
   * free ground is carriageway. Any density judgement made against that ledger is measuring
   * the generator's own streets as a failure to build.
   */
  getLanes(): readonly Lane[] {
    return this.lanes;
  }

  /**
   * Every masonry flight from the pomerium up onto the wall-walk. See `WallStair`.
   *
   * **This is the accessor the siege system's wall traversal is built on**, and it exists
   * so that nothing outside `wall.ts` ever has to know the cadence of the flights, their
   * rake, or which end of a bay they stand at. Those all changed once already — the old
   * stair ran out of a tower's city face at right angles to the curtain — and a consumer
   * that had encoded them would have marched men up thin air the day it changed.
   *
   * Endpoints are absolute world positions and the record satisfies `Siege.ts`'s
   * `CityStairView` field for field: `footX/footY/footZ` on the ground, `topX/topY/topZ`
   * where the flight's landing meets the walkway, `width` clear between the curtain and
   * the flight's own parapet, and `side` = −1 for cityward. `bay` names the `GarrisonBay`
   * whose walkway run the flight delivers onto, so joining a stair to the garrison spine
   * needs no spatial query. Up is `top`, down is `foot`, and `rise` is positive always.
   *
   * The list is generated with the stone — `buildWall` plans each flight once and hands
   * the same record to the mesh builder and to this — so a published stair and the stone a
   * man is drawn climbing cannot disagree.
   */
  getWallStairs(): readonly WallStair[] {
    return this.stairs;
  }

  /**
   * The Porta Flaminia's leaves: where the door plane is, how big it is, and whether it is
   * shut. Null on a map with no gate.
   *
   * The split of responsibility is deliberate. This workstream owns the door — its plane,
   * its hinge line, its extent and its state — and the siege system owns the *breaking* of
   * it. `open` starts **false**, which is the state the player asked for; the siege system
   * drives it through `setGateOpen(gateId, true)` when its ram wins, which already re-cuts
   * the movement obstacles and the occupancy grid in one call.
   *
   * `open` is re-read from the gate record on every call rather than kept in step by hand,
   * because `setGateOpen` writes only the gate and two records that can disagree about
   * whether Rome is open is exactly the bug class this whole file keeps producing. The same
   * object is returned each time, so a consumer may hold it and poll it per frame.
   */
  /**
   * The gatehouse as a solid, with its battlement. Null on a circuit with no gate block.
   *
   * Published because two consumers need the block's *plan footprint* and neither can get
   * it from `getGarrisonBays()`: the block straddles two bays and one x cannot name two
   * runs, which is why it was a separate record in the first place.
   *
   * The one that matters is `Siege.buildSpine`. It lays a standing station every 0.86 m
   * along every garrisonable bay, and `wall.ts curtainSpans` cuts the curtain out where the
   * gatehouse stands — so on Rome, 22 of bay 19's 36 stations sit at x 59.89 to 77.94 on
   * masonry that was never built, at `walkY` 35.75, which is 6.57 m below the gatehouse
   * crown occupying that ground. Every shot from those 22 men is discarded. This is the
   * footprint they have to be clipped against; the clip itself is `Siege.ts`'s and is not
   * this workstream's to make.
   */
  getGateBlock(): GateBlockOut | null {
    return this.gateBlock;
  }

  getGateDoor(): GateDoorOut | null {
    const door = this.gateDoor;
    if (!door) return null;
    const gate = this.gateList.find((g) => g.id === door.gateId);
    door.open = gate ? gate.open : false;
    door.broken = this.brokenGates.has(door.gateId);
    return door;
  }

  /**
   * The hollow stretches of Carthage's main wall. Empty on the Aurelian circuit.
   *
   * Deliberately *not* part of the four accessors the siege system drives. A casemate is a
   * second level inside the wall and `GarrisonBay` describes exactly one walking surface per
   * bay, so publishing galleries through `getGarrisonBays()` would put a garrison rank at a
   * height there is no stone at. Anything that wants the inside of the wall — a stabling
   * animation, a fire that spreads along it, a spec that decides the galleries are enterable
   * — reads this instead, and the siege system carries on knowing nothing about it.
   */
  getCasemates(): readonly CasemateOut[] {
    return this.casemates;
  }

  /**
   * Carthage's outer and middle lines. Empty on the Aurelian circuit.
   *
   * `passage: true` marks the staggered gate gaps and the posterns — the bays where there is
   * deliberately no masonry — and both the occupancy raster and `getObstacles()` skip exactly
   * those, from this list, so the two cannot drift.
   */
  getOutworks(): readonly OutworkOut[] {
    return this.outworks;
  }

  /**
   * The ditch in front of Carthage's outwork, **as a request rather than as geometry**.
   *
   * `built` is false: a 20 × 6 m ditch is a cut in the heightfield and `src/terrain/` is not
   * the city's to edit, so the plan and the profile are published for whoever owns it. Until
   * that lands, the belt is 54.1 m of standing works and not the spec's 74.1, and saying
   * which is which is the whole point of publishing it. Null on the Aurelian circuit.
   */
  getDitch(): CarthageDitch | null {
    return this.ditch;
  }

  /**
   * The Punic section, as the builder computed it, plus its own fault list.
   *
   * A probe that re-derives the arithmetic it is testing cannot fail, so this hands over the
   * numbers the stone was actually built from. `faults` is empty when the section closes.
   * Null on the Aurelian circuit.
   */
  punicSection(): (typeof CARTHAGE_SECTION & { faults: readonly string[] }) | null {
    return this.punic;
  }

  /** The bay whose run contains `x`, or undefined off either end of the circuit. */
  bayAt(x: number): GarrisonBay | undefined {
    const i = this.bayIndexAt(x);
    return i < 0 ? undefined : this.bays[i];
  }

  /**
   * The same lookup, keeping the index — `crenStep` and `crenMerlon` are parallel to `bays`
   * and the hot path should not have to search for a record it has just resolved.
   */
  private bayIndexAt(x: number): number {
    if (this.bays.length === 0) return -1;
    const i = Math.floor((x - this.bayX0) / this.bayPitch);
    return i >= 0 && i < this.bays.length ? i : -1;
  }

  /** Per-bay battlement geometry, parallel to `bays`. See `crenellationRun`. */
  private crenStep = new Float64Array(0);
  private crenMerlon = new Float64Array(0);
  /**
   * Per-bay tower geometry, parallel to `bays`. Half-extent of the box at the bay's `x0` end,
   * and the absolute Y of its roof; `0` / `-Infinity` where that bay carries no tower.
   */
  private towerHalfY = new Float64Array(0);
  private towerTopY = new Float64Array(0);
  /** The gatehouse's, on its own run. See `GateBlockOut.merlonLength`. */
  private gateStep = 0;
  private gateMerlon = 0;

  /**
   * Absolute Y of the top of the masonry at a point, or `-Infinity` where there is none.
   *
   * This is what makes an arrow stop at a wall instead of passing through it and burying
   * itself in the terrain on the far side. O(1): the bay index is arithmetic in x, and the
   * cross-section test is a distance to the bay centreline.
   *
   * The gatehouse reports **its own battlement**, on the same merlon/crenel model as a bay
   * and at its own period — see `gateTopAt`. It used to report `topY` flat across the whole
   * block, which put its roof two metres into the air and made 25 m of crenellated stone
   * between two garrisoned bays into a solid barrier.
   *
   * It still ignores the carriageway, which is deliberate — a missile through the open gate
   * is a one-in-a-thousand shot and not worth a second branch in a per-projectile hot path.
   *
   * The block is tested as its own oriented box rather than as "the bay flagged `isGate`".
   * It is 25 m long, centred on where the Via Flaminia actually crosses, and straddles two
   * 35.5 m bays; reading it off the flagged bay reported a fifteen-metre gatehouse standing
   * over 23 m of open grass and reported nothing at all over the half of the block that
   * stands in the bay next door.
   */
  masonryTopAt(x: number, z: number): number {
    const gb = this.gateBlock;
    if (gb) {
      const gt = (x - gb.x) * gb.dx + (z - gb.z) * gb.dz;
      const goff = (x - gb.x) * gb.nx + (z - gb.z) * gb.nz;
      if (Math.abs(gt) <= gb.halfRun && Math.abs(goff) <= gb.halfDepth) {
        return this.gateTopAt(gb, gt, goff);
      }
    }
    /**
     * Carthage's forward lines, tested **before** the main wall.
     *
     * They stand 20 and 40 m out along the outward normal, which is well outside every bay's
     * `halfThickness`, so without this an arrow lofted at the outer wall reports no masonry,
     * passes through two lines of it and buries itself in the glacis behind them. Null on
     * the Aurelian circuit, so Rome pays one null check per projectile and nothing else.
     */
    if (this.outworkTopAt !== null) {
      const ow = this.outworkTopAt(x, z);
      if (ow > -Infinity) return ow;
    }
    const bi = this.bayIndexAt(x);
    if (bi < 0) return -Infinity;
    const bay = this.bays[bi];
    // Signed perpendicular offset from the bay centreline, positive outward.
    const t = (x - bay.x0) * bay.dx + (z - bay.z0) * bay.dz;
    const px = bay.x0 + bay.dx * t;
    const pz = bay.z0 + bay.dz * t;
    const off = (x - px) * bay.nx + (z - pz) * bay.nz;

    /**
     * ---- towers ----
     *
     * Before the curtain test, because a tower is wider than the curtain: it is `towerHalf`
     * square against a `halfThickness` of 3 m, so it projects past the outer face on the
     * besieger's side and past the inner one on the city's. Testing the cross-section first
     * would reject the projecting part as "not masonry" and never reach this.
     *
     * A tower stands at each bay's `x0` end — the segment joint — which is where
     * `buildObstacles` puts its box, so the footprint test is `|t| <= towerHalf` against the
     * distance already computed along this bay's run. Two candidates, not one: the joint at
     * the far end of this bay belongs to the *next* bay's record, and a point within
     * `towerHalf` of it is inside that tower while still resolving to this bay in x. Both are
     * an index and two compares, so `masonryTopAt` stays O(1) — it runs per projectile per
     * tick and is the reason these tables are resolved at build time.
     *
     * The neighbour's offset is measured in *this* bay's frame. The circuit turns a few
     * degrees at a joint, so that is out by a centimetre or two at the corner of the box,
     * which is far below the 0.34 m of the smallest thing it has to stop.
     */
    const th = this.towerHalfY[bi];
    if (th > 0 && t < th && t > -th && off < th && off > -th) return this.towerTopY[bi];
    const nb = bi + 1;
    if (nb < this.bays.length) {
      const th2 = this.towerHalfY[nb];
      if (th2 > 0 && off < th2 && off > -th2) {
        const tn = t - bay.length;
        if (tn < th2 && tn > -th2) return this.towerTopY[nb];
      }
    }

    /**
     * `bay.halfThickness`, **not** `WALL.thickness * 0.5`.
     *
     * `WALL.thickness` is the historical 3.5 m Richmond measured on the surviving Aurelianic
     * core and is what `layout.ts` publishes to the rest of the city. The curtain that is
     * actually built is 6.0 m — see `CURTAIN_T` in `wall.ts` — so the old constant made the
     * rear 1.25 m of every wall-walk, and the whole footprint of the cityward parapet,
     * transparent: an arrow lofted at the battlement reported no masonry there and buried
     * itself in the terrain eight metres below the men it should have hit.
     */
    if (Math.abs(off) > bay.halfThickness) return -Infinity;
    // `walkable`, not `garrisonable`: the gate bay's curtain is ordinary finished wall with
    // a walk and a battlement, and treating it as a solid block to `crestY` put an arrow's
    // stopping height two metres above the surface it should have landed on.
    //
    // A footing or a gap has no level to report: the work follows the ground across 35.5 m
    // of terrain that can vary by ten metres, so it is evaluated here rather than read off
    // the bay. `bay.crestY` is the maximum over the run and is what an obstacle box has to
    // use; it is not what is standing at this particular point.
    if (!bay.walkable) {
      const gnd = this.groundAt ? this.groundAt(x, z) : bay.groundY;
      return unfinishedTopAt(bay.stage, bay.groundY, gnd);
    }

    // A bay whose parapet has not been raised has no battlement to alternate: the dressed
    // merlon blocks are five stacks waiting on the walk, not a continuous crest. Running
    // the crenellation model over it stopped an arrow 1.26 m above bare travertine along
    // two thirds of every unfinished stretch — which is where the escalade goes in.
    if (bay.stage === 'no-parapet') return bay.walkY;

    // Inboard of the parapet it is the walking surface — which is what a lofted shot
    // aimed over the battlement has to land on, and what a stone from an onager breaks on.
    if (off < bay.parapetInner) return bay.walkY;

    /**
     * In the parapet band, alternate merlon and crenel along the run.
     *
     * This is not decoration. With the parapet modelled as a solid 2.05 m barrier, a
     * defender's own bolts — released at 1.45 m above his feet — struck it on the way out,
     * and every stone lobbed at the garrison broke on the battlement instead of landing
     * among them. Measured before this: 491 missile impacts on our own masonry in one
     * minute of a battle in which the garrison never once had a clear lane.
     *
     * **The period is not `merlonLength + crenelLength` and the first merlon does not start
     * at `t = 0`.** That is what this said for as long as the model existed and it was wrong
     * both ways. `crenellation()` fits a whole number of merlons to the run and rescales —
     * Rome's built step is 2.7308 m against a nominal 2.65, Carthage's 2.2769 against 2.35 —
     * and it centres each merlon in its step, so half a gap stands at each end of a bay and a
     * whole gap straddles every joint. Measured against the stone at 1 mm, the nominal model
     * agreed on **36 % of Rome's parapet**: worse than a random phase, because the 0.08 m of
     * drift per period walks the model a whole merlon out of register by the far end of a
     * bay. Arrows stopped in mid-air over embrasures and passed through solid merlons.
     *
     * It was invisible to every instrument on it because only the merlon *fraction* survives
     * the rescale exactly, so anything that bins along x or counts stone-versus-air over a
     * whole bay comes out right. `crenellationRun` is the generator's own arithmetic and is
     * resolved per bay at build time, so this stays a compare and a floor in the hot path.
     */
    const step = this.crenStep[bi];
    const phase = t - Math.floor(t / step) * step;
    return Math.abs(phase - step * 0.5) <= this.crenMerlon[bi] * 0.5 ? bay.crestY : bay.sillY;
  }

  /**
   * Absolute Y of the topmost surface a **body could stand on** at a point, or `-Infinity`
   * where there is none.
   *
   * Not `masonryTopAt`, and the difference is the parapet. That one answers "what stops a
   * missile", so through the battlement band it alternates merlon crest and crenel sill two
   * metres over the walk, and over the gatehouse it answers the merlon line's own crown.
   * Neither of those is a surface anything stands on. This answers the walk *under* all of
   * it, and it adds the three things a walk is reached by that a missile has never needed:
   *
   *  - **The stair flights.** `masonryTopAt` reports `-Infinity` over every tread on both
   *    circuits — nine flights on Rome, thirteen on Carthage — because an arrow that lands
   *    on a staircase has landed on the ground as far as it is concerned.
   *  - **The tower passes.** The walk *steps* at a tower — 1.00 m on Carthage, median 1.65 m
   *    on Rome and up to 7.70 — and the tower carries the flight between the two walks
   *    inside its own footprint (`GarrisonBay.passLoY`/`passHiY`). `masonryTopAt` puts the
   *    whole step at the bay joint, in nought metres.
   *  - **The gatehouse crown**, at `sillY`: the roof the merlons stand on, which is the
   *    surface, and not `topY`, which is two metres of merlon above it.
   *
   * Written for the camera rig, which asks it twice a frame rather than two thousand times a
   * tick, so the stair test is a linear pass over the flights on the circuit instead of an
   * index. Everything else is the same O(1) bay arithmetic `masonryTopAt` uses.
   *
   * Two things are deliberately not modelled. The part of a tower's footprint that projects
   * past the curtain's own faces — 0.80 m each side on Rome, 0.95 on Carthage — because the
   * walk does not go out there; the pass lane is a band *inside* the thickness. And
   * Carthage's forward lines, which do publish a `walkY`: `getOutworks()` is empty on both
   * circuits as built, and a branch no data reaches is a branch nothing has ever checked.
   */
  walkableTopAt(x: number, z: number, fromY = Infinity): number {
    /*
     * The gatehouse, tested first and returned from, as its own oriented box — for the reason
     * `masonryTopAt` does it that way: the block is 25 m long, straddles two 35.5 m bays and
     * is not "the bay flagged `isGate`". Reading it off the flagged bay reported a fifteen-
     * metre gatehouse standing over 23 m of open grass. Returning rather than taking a
     * maximum with the curtain matters on Carthage, where the walk beside the gate stands
     * 0.58 m *above* the keep's roof: the block is what is built here, and stepping down onto
     * it and up again is what the stone does.
     *
     * **And the carriageway, which `masonryTopAt` deliberately does not model.** It can
     * afford not to: a missile through an open gate is a one-in-a-thousand shot and not worth
     * a branch in a per-projectile path. A camera cannot — the player marches through that
     * gate the moment the ram is done, and answering "the roof" to a query from inside the
     * passage would lift the eye thirteen metres through the vault. `fromY` is what makes one
     * number enough for a footprint with two surfaces in it: the crown for a caller already
     * up on the wall, the road for one underneath it. The 2 m margin is a hand's breadth
     * either side of the walk that reaches the crown, which is the only way onto it.
     */
    const gb = this.gateBlock;
    if (gb) {
      const gt = (x - gb.x) * gb.dx + (z - gb.z) * gb.dz;
      const goff = (x - gb.x) * gb.nx + (z - gb.z) * gb.nz;
      if (Math.abs(gt) <= gb.halfRun && Math.abs(goff) <= gb.halfDepth) {
        const underTheVault = Math.abs(gt) <= gb.openHalf && fromY < gb.sillY - 2;
        return underTheVault ? -Infinity : gb.sillY;
      }
    }

    let top = -Infinity;
    const bi = this.bayIndexAt(x);
    if (bi >= 0) {
      const bay = this.bays[bi];
      const t = (x - bay.x0) * bay.dx + (z - bay.z0) * bay.dz;
      const px = bay.x0 + bay.dx * t;
      const pz = bay.z0 + bay.dz * t;
      const off = (x - px) * bay.nx + (z - pz) * bay.nz;
      // `bay.halfThickness`, not `WALL.thickness * 0.5`: the curtain that is built is 6.0 m
      // on Rome and 9.1 on Carthage, and the constant is the historical 3.5.
      if (Math.abs(off) <= bay.halfThickness) {
        const w = this.curtainWalkAt(bi, bay, t, x, z);
        if (w > top) top = w;
      }
    }

    for (let i = 0; i < this.stairs.length; i++) {
      const w = stairSurfaceAt(this.stairs[i], x, z);
      if (w > top) top = w;
    }

    return top;
  }

  /**
   * The walking surface of one bay at along-run parameter `t`, ramped through its towers.
   *
   * Both sides of a tower resolve to the same ramp — the bay to the west enters it through
   * the `next` branch at `t = lenToNext - towerHalf` and the bay to the east through the
   * `prev` branch at `t = -towerHalf`, and at the joint itself both read the midpoint — which
   * is what makes the crossing continuous rather than a step at whichever bay index
   * `bayIndexAt` happens to award the boundary x to.
   */
  private curtainWalkAt(bi: number, bay: GarrisonBay, t: number, x: number, z: number): number {
    /*
     * A footing or a rubble gap has no construction level to report. The work follows the
     * ground across 35.5 m of terrain that can vary by ten metres, so it is evaluated per
     * point exactly as `masonryTopAt` does it: `bay.crestY` is the maximum over the run and
     * stands nine metres proud at one end of Rome's bay 2.
     */
    if (!bay.walkable) {
      const gnd = this.groundAt ? this.groundAt(x, z) : bay.groundY;
      return unfinishedTopAt(bay.stage, bay.groundY, gnd);
    }

    const prev = bi > 0 ? this.bays[bi - 1] : undefined;
    if (bay.hasTower && bay.towerHalf > 0 && t <= bay.towerHalf && prev && prev.walkable) {
      const s = clamp((t + bay.towerHalf) / (2 * bay.towerHalf), 0, 1);
      return lerp(prev.walkY, bay.walkY, s);
    }

    const next = this.bays[bi + 1];
    if (next && next.hasTower && next.towerHalf > 0 && next.walkable) {
      // Along-run distance to the next bay's origin, measured rather than read off
      // `bay.length`: the bay index is a fixed pitch in x and the chord of a bowed run is not
      // the pitch. Carthage's line is bowed; Rome's is straight and the two agree there.
      const lenToNext = (next.x0 - bay.x0) * bay.dx + (next.z0 - bay.z0) * bay.dz;
      if (t >= lenToNext - next.towerHalf) {
        const s = clamp((t - (lenToNext - next.towerHalf)) / (2 * next.towerHalf), 0, 1);
        return lerp(bay.walkY, next.walkY, s);
      }
    }

    return bay.walkY;
  }

  /**
   * The nearest embrasure to a point on the wall-walk, or null where there is none.
   *
   * A crenellated parapet is merlon (the solid tooth) alternating with embrasure (the gap),
   * and a garrison archer does not shoot *through* his own merlon — he shoots through the
   * gap, or steps to one. `masonryTopAt` has modelled that alternation since the parapet
   * stopped being a solid barrier, but only as a *collision* surface: nothing published
   * where the gaps are, so a man loosed from wherever he happened to be standing and 64 % of
   * the run is tooth. This is the other half of the same arithmetic, exposed the way
   * `getWallStairs()` exposes the flights, so the sim never has to know the cadence of a
   * battlement any more than it has to know the rake of a stair.
   *
   * Derived from the same `merlonLength`/`crenelLength` the collision model uses and phased
   * off the same `bay.x0`, so a gap this reports and a gap a shot can pass through cannot
   * disagree. Both cities come through unchanged: the plan supplies the two lengths and the
   * bay supplies `sillY`/`crestY`, and neither number appears here.
   *
   * `x, z` is on the bay's **centreline**, level with the middle of the gap; compose a point
   * in the gap itself as `x + nx * off`, `z + nz * off` for an `off` between `parapetInner`
   * and `parapetOuter`. `step` is how far along the run the caller would have to move to get
   * there, signed along `dx, dz`.
   *
   * Null only where there is no wall-walk to stand on: off the circuit, or on an unwalkable
   * bay. A bay whose parapet is not raised yet **does** answer, with `hasParapet: false` and
   * its heights flattened to the walk — because "there is no tooth here" is an answer a
   * shooter needs, and returning null for it left a rear rank ploughing its shots into its
   * own walkway with nothing to tell it not to.
   *
   * **The gatehouse used to be in that list and no longer is.** It answered null across its
   * whole 25 x 11.9 m plan footprint, on a test with no height term in it — so it swallowed
   * not only its own crown but 22.25 m of the *garrisonable bay next door*, whose run it
   * straddles. Measured on Rome at 4e3145f: 22 of the 49 `Siege` stations within 40 m of
   * the gate, every one of them on bay 19, stood where the city said there was no
   * battlement, and 823 garrison shots in four minutes were discarded for it.
   *
   * It now answers with the block's own battlement. Note what that does *not* fix: those 22
   * stations are 6.6 m below the gatehouse's crown, so `Projectiles.aimOverParapet` still
   * declines them — but now at `notOnThisWalk` rather than `noBattlement`, which is the true
   * reason. A man cannot shoot over a battlement he is standing six metres underneath, and
   * the defect that put him inside the block is `Siege.buildSpine`'s, not this file's.
   */
  embrasureAt(x: number, z: number): Embrasure | null {
    const gb = this.gateBlock;
    if (gb) {
      const gt = (x - gb.x) * gb.dx + (z - gb.z) * gb.dz;
      const goff = (x - gb.x) * gb.nx + (z - gb.z) * gb.nz;
      if (Math.abs(gt) <= gb.halfRun && Math.abs(goff) <= gb.halfDepth) {
        return this.gateEmbrasure(gb, gt, x);
      }
    }
    const bi = this.bayIndexAt(x);
    if (bi < 0) return null;
    const bay = this.bays[bi];
    if (!bay.walkable) return null;

    /**
     * What `masonryTopAt` will actually report here, which is not always what the bay records.
     *
     * A `no-parapet` bay publishes a `crestY` 1.26 m over the walk — the height of the five
     * stacks of dressed merlon blocks waiting to be set — and the collision model does not
     * know about them, so handing that number to a shooter invents a tooth that is not there.
     * A `half-built` bay has crest, sill and walk all at one height already.
     */
    if (bay.stage === 'no-parapet' || bay.crestY <= bay.walkY + 0.05) {
      const t0 = (x - bay.x0) * bay.dx + (z - bay.z0) * bay.dz;
      return {
        bay: bay.index,
        x: bay.x0 + bay.dx * t0, z: bay.z0 + bay.dz * t0,
        nx: bay.nx, nz: bay.nz, dx: bay.dx, dz: bay.dz,
        walkY: bay.walkY, sillY: bay.walkY, crestY: bay.walkY,
        parapetInner: bay.halfThickness, parapetOuter: bay.halfThickness,
        width: 0, step: 0, halfThickness: bay.halfThickness, hasParapet: false,
      };
    }

    const step = this.crenStep[bi];
    const merlon = this.crenMerlon[bi];
    const crenel = step - merlon;
    if (!(step > 0) || !(crenel > 0)) return null;

    // `crenellation()` centres each merlon in its step, so the gaps sit **on** the step
    // boundaries: centres at `k * step`, and the ones at `k = 0` and `k = count` are the two
    // halves of the whole gap that straddles each joint between bays. Deriving this from the
    // generator's own numbers rather than from the nominal pitch is the difference between a
    // gap and a tooth — every one of Rome's thirteen nominal centres lands inside stone.
    const t = (x - bay.x0) * bay.dx + (z - bay.z0) * bay.dz;
    let tc = Math.round(t / step) * step;

    // A gap has to be on walkway the man could actually reach. The tower at `x0` interrupts
    // the run — the walkway does not pass through it — and the far end of the bay is the next
    // bay's business.
    const lo = bay.towerHalf + crenel * 0.5;
    const hi = bay.length - crenel * 0.5;
    if (lo > hi) return null;
    while (tc < lo) tc += step;
    while (tc > hi) tc -= step;
    if (tc < lo || tc > hi) return null;
    // A man leans, sidesteps or turns to a loophole; he does not cross a merlon and a gap to
    // reach one. Half a step is the worst case from anywhere on the run, so anything past a
    // whole one means the clamp above pushed the answer somewhere he cannot go.
    const reach = tc - t;
    if (Math.abs(reach) > step) return null;

    return {
      bay: bay.index,
      x: bay.x0 + bay.dx * tc,
      z: bay.z0 + bay.dz * tc,
      nx: bay.nx, nz: bay.nz,
      dx: bay.dx, dz: bay.dz,
      walkY: bay.walkY,
      sillY: bay.sillY,
      crestY: bay.crestY,
      parapetInner: bay.parapetInner,
      parapetOuter: bay.parapetOuter,
      width: crenel,
      step: reach,
      halfThickness: bay.halfThickness,
      hasParapet: true,
    };
  }

  /**
   * The gatehouse's battlement as a place a shot can leave from.
   *
   * Same solve as the bay branch of `embrasureAt`, on the block's own run: snap to the
   * nearest crenel centre, keep it on the block, and report the heights of the crown rather
   * than of whichever bay's arithmetic happens to reach this x.
   *
   * `bay` is the index of the bay whose run contains the point, which keeps that field
   * meaning what its comment says. Nothing in `src/sim/` reads it today.
   */
  private gateEmbrasure(gb: GateBlockOut, gt: number, x: number): Embrasure {
    const step = this.gateStep > 0 ? this.gateStep : gb.halfRun * 2;
    const crenel = Math.max(0.01, step - this.gateMerlon);
    // Run coordinate from the west end, where `crenellation()` starts laying.
    const t = gt + gb.halfRun;
    const len = gb.halfRun * 2;
    let tc = Math.round(t / step) * step;
    const lo = crenel * 0.5;
    const hi = len - crenel * 0.5;
    while (tc < lo) tc += step;
    while (tc > hi) tc -= step;
    const mid = clamp(tc, lo, hi) - gb.halfRun;
    return {
      bay: this.bayIndexAt(x),
      x: gb.x + gb.dx * mid,
      z: gb.z + gb.dz * mid,
      nx: gb.nx, nz: gb.nz,
      dx: gb.dx, dz: gb.dz,
      // The crown is what a man on the gatehouse stands on. It is also `sillY`: there is no
      // walkway set below the merlons here, the roof *is* the walk.
      walkY: gb.sillY,
      sillY: gb.sillY,
      crestY: gb.topY,
      parapetInner: gb.parapetInner,
      parapetOuter: gb.parapetOuter,
      width: crenel,
      step: mid - gt,
      halfThickness: gb.halfDepth,
      hasParapet: true,
    };
  }

  /**
   * The top of the gatehouse's masonry at a point already known to be inside its footprint.
   *
   * The same three-band model `masonryTopAt` runs over a bay, at the block's own
   * crenellation period rather than the plan's:
   *
   *  - **behind or outboard of the merlon line** — the roof of the block and the cornice
   *    round it, both at `sillY`. This is the band that was two metres too high, and it is
   *    11 of the block's 11.9 m of depth.
   *  - **in the merlon line, on a tooth** — `topY`.
   *  - **in the merlon line, in a gap** — `sillY`, which is what makes a shot from the
   *    wall-walk on either side able to cross the gate frontage at all.
   *
   * `gt` runs from `-halfRun` at the west end, and `crenellation()` lays merlon `i` centred
   * at `(i + 0.5) * step` from the run's start with half a gap at each end, so the phase is
   * taken from `gt + halfRun`. Same arithmetic as the bay branch, and for the same reason:
   * the nominal `merlonW + gapW` pitch is not what the stone was built at.
   *
   * Carthage's block carries a mirrored line on its cityward face; Rome's does not.
   */
  private gateTopAt(gb: GateBlockOut, gt: number, goff: number): number {
    const a = Math.abs(goff);
    const inBand = a >= gb.parapetInner && a <= gb.parapetOuter
      && (goff > 0 || gb.crenelledCityward);
    if (!inBand) return gb.sillY;
    const step = this.gateStep;
    if (step <= 0) return gb.topY;
    const t = gt + gb.halfRun;
    const phase = t - Math.floor(t / step) * step;
    return Math.abs(phase - step * 0.5) <= this.gateMerlon * 0.5 ? gb.topY : gb.sillY;
  }

  /**
   * Deprecated in favour of `getGarrisonBays`. Returns the masonry's rise above its own
   * footing, which is what `WallSegmentOut.height` has always meant — **not** an absolute
   * Y. The name reads as though it were one, and something did use it that way.
   */
  wallHeightNear(x: number, z: number): number {
    let best = 0;
    let bestD = Infinity;
    for (const s of this.segments) {
      const ax = s.x2 - s.x1;
      const az = s.z2 - s.z1;
      const len2 = ax * ax + az * az;
      const t = len2 < 1e-6 ? 0 : clamp(((x - s.x1) * ax + (z - s.z1) * az) / len2, 0, 1);
      const px = s.x1 + ax * t;
      const pz = s.z1 + az * t;
      const d = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d < bestD) {
        bestD = d;
        best = s.height;
      }
    }
    return bestD < 400 ? best : 0;
  }

  /** Named monument positions, for the camera, the minimap and objective markers. */
  getLandmarks(): readonly CityLandmarkRef[] {
    return this.landmarkRefs;
  }

  /**
   * Every build-time check the plan made, with what each one measured. See `CityAssertion`.
   *
   * Separate from the scalars on `stats()` because a scalar cannot carry the population it
   * sampled, and that gap is the one that let Rome report zero footprint overlaps while the
   * player was looking at monuments dropped across housing.
   */
  getAssertions(): readonly CityAssertion[] {
    return this.checks.assertions ?? [];
  }

  /**
   * Where the defended circuit runs, sampled, **whether or not masonry stands on it**.
   *
   * `getWallSegments()` answers "where is the stone" and is the right question for a siege.
   * This answers "where is the line", which is what a plan-view probe needs: it can draw the
   * circuit without importing a layout constant, so a divergence between what the plan
   * intended and what the city baked shows up as two lines on one drawing rather than as
   * nothing at all. Derived from the bays, so it is the built line and not the intent.
   */
  getCircuitSamples(step = 20): { x: number; z: number }[] {
    if (this.bays.length === 0) return [];
    const out: { x: number; z: number }[] = [];
    const first = this.bays[0];
    const last = this.bays[this.bays.length - 1];
    for (let x = first.x0; x <= last.x1; x += step) {
      const b = this.bayAt(x) ?? last;
      const t = clamp((x - b.x0) / Math.max(1e-3, b.x1 - b.x0), 0, 1);
      out.push({ x, z: b.z0 + (b.z1 - b.z0) * t });
    }
    return out;
  }

  /**
   * Diagnostics only: pin every chunk to one detail level, or `null` to resume
   * distance-based swapping. The plan view looks at the whole city from 1.5 km up, where
   * distance culling would drop all of it to silhouettes and there would be nothing to
   * measure. Not called from the game.
   */
  debugForceLod(level: number | null): void {
    this.forcedLod = level;
    if (level === null) return;
    for (const c of this.chunks) {
      const want = clamp(level, 0, c.levels.length - 1);
      if (want === c.current) continue;
      c.current = want;
      if (c.suppressed) continue;
      for (let i = 0; i < c.levels.length; i++) c.levels[i].group.visible = i === want;
    }
  }

  /**
   * Hand shadow casting back to the per-material meshes, or to the merged proxies.
   *
   * `buildShadowProxy` claims the merged silhouette is identical because it is the same
   * triangles. That is the kind of claim this project has been wrong about before, and the
   * only way to check it is to photograph both arms in one session — two sessions differ on
   * half their pixels from VFX reseeding alone. So the swap is a supported switch, not test
   * scaffolding: it also gives the next agent a one-line way to price the technique.
   */
  setShadowProxies(on: boolean): void {
    this.shadowProxies = on;
    for (const c of this.chunks) this.applyCasting(c);
  }

  /** Diagnostics only: hide the whole city, for a reference-plan-only plan view. */
  setDebugVisible(on: boolean): void {
    this.root.visible = on;
  }

  /** Diagnostics only: show or hide the reference overlay without rebuilding its texture. */
  setOverlayVisible(on: boolean): void {
    if (this.overlay) this.overlay.visible = on;
  }

  /**
   * Diagnostics only: drape a georeferenced archaeological plan of Rome over the ground,
   * projected through the same `worldOf` the city is built with, so the layout can be
   * graded against the real plan from directly overhead. See `overlay.ts`.
   *
   * Refuses outside a dev server, and the rasters live in gitignored `reference/`, so
   * there is no shipping code path and no shipping asset. Returns false when the raster
   * is not present, which is the normal state of a clean checkout.
   */
  async setReferenceOverlay(
    plan: ReferencePlan | null,
    opts?: OverlayOptions
  ): Promise<boolean> {
    if (this.overlay) {
      this.overlay.removeFromParent();
      this.overlay.geometry.dispose();
      const m = this.overlay.material as THREE.MeshBasicMaterial;
      m.map?.dispose();
      m.dispose();
      this.overlay = null;
    }
    if (!plan || !import.meta.env.DEV || !this.overlayGround) return false;
    const mesh = await buildReferenceOverlay(plan, this.overlayGround, opts);
    if (!mesh) return false;
    this.overlay = mesh;
    this.root.parent?.add(mesh);
    return true;
  }

  /**
   * Build statistics for the debug overlay. `visibleMeshes` is the city's own upper
   * bound on draw calls this frame (before frustum culling), which is the number the
   * performance budget actually cares about.
   */
  stats(): {
    /**
     * Which city was built — `plan.id`, read through the city rather than guessed at.
     *
     * Every Rome-specific scalar below is meaningless when this is not `'rome'`, and a probe
     * that could not tell which city it had measured is a probe that can silently grade the
     * wrong one. This is the sanctioned way to ask: `cityPlan.ts` forbids reinstating a
     * "which city is this really" test anywhere else.
     */
    id: string;
    chunks: number;
    meshes: number;
    visibleMeshes: number;
    visibleTriangles: number;
    triangles: number;
    materials: number;
    usedManifest: boolean;
    /** Result of the build-time landmark footprint-overlap assertion. */
    footprintOverlaps: number;
    footprintOverlapWorst: number;
    /** Adjacency checks passed / total, from `assertTopology`. */
    topologyPass: number;
    topologyChecks: number;
    /** Count of Flavian-Amphitheatre-form buildings. Must be 1. */
    amphitheatres: number;
    /** Chunks with geometry in the battlefield or outside their own bounding volume. */
    strayGeometry: number;
    /** Buildings standing inside a monument. See `assertNoFabricOverlaps`. Must be 0. */
    fabricOverlaps: number;
    fabricOverlapWorst: number;
    /** Ranked-way centreline samples with masonry in the carriageway. Must be 0. */
    wayInsideMonument: number;
    waySamples: number;
    /** Street network by rank: how many ways of each class, and their total length. */
    ways: { cls: string; count: number; km: number }[];
    /**
     * Every build-time check with what it measured, which the scalars above cannot carry.
     *
     * Empty on a city that has not written any. See `CityAssertion` for why a sentence is
     * part of the measurement and not commentary on it.
     */
    assertions: readonly CityAssertion[];
    /**
     * Visible meshes per chunk family, descending — the city's own draw-call ledger.
     *
     * `visibleMeshes` is a single number and a single number cannot be acted on. The assault
     * camera has been measured at 259 calls against a 220 cap, and the only question that
     * matters then is *which part of the city is spending them*, which is this. A family is
     * a chunk name up to its first dash, so `wall-bay-17` and `wall-gate` both land under
     * `wall`.
     */
    drawsByFamily: { family: string; meshes: number }[];
  } {
    let visibleMeshes = 0;
    let visibleTriangles = 0;
    const byFamily = new Map<string, number>();
    for (const c of this.chunks) {
      // A suppressed chunk draws nothing, so it must not appear in the ledger the draw-call
      // budget is argued from. The gate's wreckage is baked from t=0 and is not on screen.
      if (c.suppressed) continue;
      const lvl = c.levels[c.current];
      const n = lvl.group.children.length;
      visibleMeshes += n;
      visibleTriangles += lvl.triangles;
      const family = c.name.split('-')[0];
      byFamily.set(family, (byFamily.get(family) ?? 0) + n);
    }
    const c = this.checks;
    return {
      id: this.plan.id,
      chunks: this.chunks.length,
      meshes: this.meshCount,
      visibleMeshes,
      visibleTriangles,
      triangles: this.totalTris,
      materials: CITY_MAT_KEYS.length,
      usedManifest: this.mats.usedManifest,
      footprintOverlaps: c.footprintOverlaps ?? 0,
      footprintOverlapWorst: c.footprintOverlapWorst ?? 0,
      topologyPass: c.topologyPass ?? 0,
      topologyChecks: c.topologyChecks ?? 0,
      // Rome-specific and stays Rome-specific: nothing in Carthage is a Flavian
      // Amphitheatre, and putting it on `CityChecks` would make every future city carry a
      // field it can only answer with a lie.
      amphitheatres: this.plan.id === 'rome' ? romeAmphitheatreCount() : 0,
      strayGeometry: this.stray.offenders.length,
      fabricOverlaps: c.fabricOverlaps ?? 0,
      fabricOverlapWorst: c.fabricOverlapWorst ?? 0,
      wayInsideMonument: c.wayInsideMonument ?? 0,
      waySamples: c.waySamples ?? 0,
      ways: c.ways ?? [],
      assertions: c.assertions ?? [],
      drawsByFamily: [...byFamily.entries()]
        .map(([family, meshes]) => ({ family, meshes }))
        .sort((a, b) => b.meshes - a.meshes),
    };
  }

  /** Full stray-geometry report, for the plan diagnostic. */
  get strayReport(): StrayReport {
    return this.stray;
  }

  /** Texture attribution gathered from the asset manifest, for ASSETS.md. */
  get credits(): readonly string[] {
    return this.mats.credits;
  }

  // ------------------------------------------------------------------------
  // Occupancy grid
  // ------------------------------------------------------------------------

  private cellOf(v: number): number {
    return clamp(Math.floor((v + HALF_EXTENT) / OCC_CELL), 0, OCC_RES - 1);
  }

  private occAt(ix: number, iz: number): boolean {
    if (ix < 0 || iz < 0 || ix >= OCC_RES || iz >= OCC_RES) return false;
    return this.occ[iz * OCC_RES + ix] !== 0;
  }

  private paint(ix: number, iz: number, value: number): void {
    if (ix < 0 || iz < 0 || ix >= OCC_RES || iz >= OCC_RES) return;
    this.occ[iz * OCC_RES + ix] = value;
  }

  private markSegment(x1: number, z1: number, x2: number, z2: number, halfW: number, value = 1): void {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const steps = Math.max(1, Math.ceil(len / (OCC_CELL * 0.5)));
    const r = Math.ceil((halfW + OCC_CELL) / OCC_CELL);
    // Distance-tested rather than a square stamp: a square would clear or block a
    // corridor two cells wider than asked, and the gate passage is only 4.3 m across.
    const lim = halfW + OCC_CELL * 0.5;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = x1 + (x2 - x1) * t;
      const pz = z1 + (z2 - z1) * t;
      const cx = this.cellOf(px);
      const cz = this.cellOf(pz);
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          const wx = (cx + i) * OCC_CELL - HALF_EXTENT + OCC_CELL * 0.5;
          const wz = (cz + j) * OCC_CELL - HALF_EXTENT + OCC_CELL * 0.5;
          if (Math.hypot(wx - px, wz - pz) > lim) continue;
          this.paint(cx + i, cz + j, value);
        }
      }
    }
  }

  private clearSegment(x1: number, z1: number, x2: number, z2: number, halfW: number): void {
    this.markSegment(x1, z1, x2, z2, halfW, 0);
  }

  private markCircle(x: number, z: number, radius: number): void {
    const cx = this.cellOf(x);
    const cz = this.cellOf(z);
    const r = Math.ceil(radius / OCC_CELL);
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        if (i * i + j * j > r * r) continue;
        this.paint(cx + i, cz + j, 1);
      }
    }
  }

  private markRect(x: number, z: number, hw: number, hd: number, rot: number): void {
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const nu = Math.max(1, Math.ceil((hw * 2) / (OCC_CELL * 0.6)));
    const nv = Math.max(1, Math.ceil((hd * 2) / (OCC_CELL * 0.6)));
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const u = -hw + (hw * 2 * i) / nu;
        const v = -hd + (hd * 2 * j) / nv;
        this.paint(this.cellOf(x + u * cs - v * sn), this.cellOf(z + u * sn + v * cs), 1);
      }
    }
  }

  dispose(): void {
    for (const c of this.chunks) {
      for (const lvl of c.levels) {
        lvl.group.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) mesh.geometry.dispose();
        });
        lvl.group.removeFromParent();
      }
    }
    this.chunks.length = 0;
    void this.setReferenceOverlay(null);
    this.root.removeFromParent();
    this.mats.dispose();
  }
}

/**
 * Absolute Y of a stair's treads at a point, or `-Infinity` off the flight.
 *
 * Derived **entirely from the published `WallStair` record** — the two segments `foot -> head`
 * and `head -> top`, and the record's own `width` — so it cannot drift from the stone the way
 * a second copy of `STAIR_RISE`, `STAIR_W` and `STAIR_LANDING` would. That is not a
 * hypothetical on this wall: the tower pass was derived twice and the two answers were 1.36 m
 * apart, which is how forty-two towers came to have a doorway nobody walked through.
 *
 * Each segment is a **capsule**, not a rectangle, and not two discs at the ends. Rome's
 * landing is 2.31 m long against a 2.80 m tread width, so two discs of radius `width / 2`
 * would just cover it; Carthage's is 3.53 m against 3.40 m and two discs leave a 0.13 m hole
 * straight through the middle of the one surface that joins the stair to the wall. A swept
 * segment cannot leave one at any width.
 *
 * The rake is the **chord**, not the treads. A tread stands half a riser above the chord and
 * steps 0.29 m at a time; a camera walking up at 11 m/s crosses twenty-six of them a second,
 * and 0.29 m of bob at that rate is not a stair, it is a fault.
 */
function stairSurfaceAt(s: WallStair, x: number, z: number): number {
  const r2 = s.width * s.width * 0.25;
  let top = -Infinity;

  // The landing at the head, flat at the walk's own level. `topY === headY` by construction.
  const lx = s.topX - s.headX;
  const lz = s.topZ - s.headZ;
  const ll = lx * lx + lz * lz;
  const lt = ll > 1e-9 ? clamp(((x - s.headX) * lx + (z - s.headZ) * lz) / ll, 0, 1) : 0;
  const lqx = x - (s.headX + lx * lt);
  const lqz = z - (s.headZ + lz * lt);
  if (lqx * lqx + lqz * lqz <= r2) top = s.topY;

  // The rake, foot to head.
  const rx = s.headX - s.footX;
  const rz = s.headZ - s.footZ;
  const rl = rx * rx + rz * rz;
  if (rl > 1e-9) {
    const rt = clamp(((x - s.footX) * rx + (z - s.footZ) * rz) / rl, 0, 1);
    const rqx = x - (s.footX + rx * rt);
    const rqz = z - (s.footZ + rz * rt);
    if (rqx * rqx + rqz * rqz <= r2) {
      const y = s.footY + (s.headY - s.footY) * rt;
      if (y > top) top = y;
    }
  }

  return top;
}
