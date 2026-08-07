import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';
import type { Obstacle } from '../sim/Obstacles';
import type { TerrainSystem } from '../terrain/TerrainSystem';
import { HALF_EXTENT } from '../terrain/topography';
import { clamp } from '../util/math';
import { Batch } from './build';
import type {
  CARTHAGE_SECTION, CarthageDitch, CasemateOut, OutworkOut,
} from './carthageWall';
import type { CityBuild, CityChecks, CityLandmarkRef, CityPlan, PlanRect } from './cityPlan';
import type { Lane } from './insulae';
import { CITY_MAT_KEYS, CityMaterials } from './materials';
import { buildReferenceOverlay, type OverlayOptions, type ReferencePlan } from './overlay';
import { romeAmphitheatreCount } from './rome/plan';
import {
  unfinishedTopAt, type CityChunkSpec, type GarrisonBay, type GateBlockOut, type GateDoorOut,
  type GateOut, type WallSegmentOut, type WallStair,
} from './wall';

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
    this.assertUniformBayPitch();
    for (const w of this.checks.warnings ?? []) console.warn(`[city:${this.plan.id}] ${w}`);

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
    for (const gate of this.gateList) {
      if (!gate.open) continue;
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

    // ---- curtain ------------------------------------------------------------
    // One box per blocked bay, with the wall-walk as its top so the garrison standing on
    // it is *on* the wall rather than inside it. `blockers` already omits the bare footing
    // courses, which are ankle-high and which the occupancy grid deliberately leaves open.
    const bayOf = (x: number): GarrisonBay | undefined => this.bayAt(x);
    for (const b of blockers) {
      const mx = (b.x1 + b.x2) * 0.5;
      const bay = bayOf(mx);
      // A gap bay is rubble and a palisade — no walkway, so its top is the rampart crest.
      // `walkable`, not `garrisonable`: the gate bay carries a wall-walk on both flanks of
      // the gatehouse and no garrison, and taking its top from `crestY` buried the walking
      // surface two metres inside the merlons.
      const top = bay ? (bay.walkable ? bay.walkY : bay.crestY) : this.masonryTopAt(mx, (b.z1 + b.z2) * 0.5);
      const topY = Number.isFinite(top) ? top : 1e4;
      this.pushWallBox(out, b.x1, b.z1, b.x2, b.z2, b.halfW, topY);
    }

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

    // ---- Carthage's outer and middle lines ----------------------------------
    /**
     * Real masonry, but not a garrison line.
     *
     * `bayAt` is index arithmetic in x and one x cannot name three bays, so the forward
     * lines are published as their own records and stamped here rather than folded into
     * `getGarrisonBays()`. Their `topY` is their own crest, which is metres below the main
     * wall's walk: an attacker who takes the outer line is standing sixteen metres under the
     * men shooting at him, and that is the arithmetic that makes a defence in depth mean
     * something rather than being three walls in a row.
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
     * The nine flights onto the walkway, which nothing has ever collided with.
     *
     * Ground units walked straight through 14–20 m of masonry apiece. That was tolerable
     * when a flight projected 3.3 m out of a tower's city face; since the rebuild put them
     * *along* the curtain they are the longest unstamped solids in the city.
     *
     * `kind` is `'wall'` rather than a new kind of its own. A flight is built hard against
     * the inner face and lies wholly within the twelve metres of the centreline that every
     * consumer already treats as curtain, so calling it anything else would split one piece
     * of masonry across two categories for no gain — and `ObstacleKind` lives in the sim,
     * which is not this workstream's to widen.
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
      if (!gate.open) continue;
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
      for (const mesh of meshes) {
        group.add(mesh);
        if (mesh.castShadow) casters.push(mesh);
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
   * Swap detail levels by camera distance. Hysteresis of 12 % stops a chunk flipping
   * back and forth while the camera hovers on a threshold.
   */
  preRender(ctx: EngineContext): void {
    if (this.forcedLod !== null) return;
    const cam = ctx.camera.position;
    for (const c of this.chunks) {
      const dx = cam.x - c.cx;
      const dy = cam.y - c.cy;
      const dz = cam.z - c.cz;
      // Distance to the chunk's surface, not its centre: a 1 km-wide district should
      // not drop to silhouette just because its midpoint is far away.
      const d = Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - c.radius * 0.55);

      // Shadow casting by distance, with 15 % hysteresis so a hovering camera does not
      // flip a district's shadow on and off.
      if (c.casters.length > 0) {
        const want = d < SHADOW_CUTOFF * (c.casting ? 1.15 : 1.0);
        if (want !== c.casting) {
          c.casting = want;
          for (const m of c.casters) m.castShadow = want;
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

  /** Gate positions and whether they are open. `facing` points out of the city. */
  getGates(): { id: string; x: number; z: number; facing: number; open: boolean }[] {
    return this.gateList;
  }

  /** Open or close a gate. Closing it fills the passage in the movement grid. */
  setGateOpen(id: string, open: boolean): void {
    const gate = this.gateList.find((g) => g.id === id);
    if (!gate || gate.open === open) return;
    gate.open = open;
    if (open) this.clearSegment(gate.x, gate.z - 20, gate.x, gate.z + 20, 2.4);
    else this.markSegment(gate.x, gate.z - 6, gate.x, gate.z + 6, 2.6);
    this.recutWallObstacles();
  }

  /**
   * Rebuild just the curtain boxes after a gate has opened or closed. The fabric and the
   * towers never move, so they are left alone; a ram breaking the gate must not cost a
   * rebuild of three thousand rectangles.
   */
  private recutWallObstacles(): void {
    const kept = this.obstacles.filter((o) => o.kind !== 'wall');
    const walls: Obstacle[] = [];
    for (const b of this.wallBlockers) {
      const mx = (b.x1 + b.x2) * 0.5;
      const bay = this.bayAt(mx);
      const top = bay ? (bay.walkable ? bay.walkY : bay.crestY) : this.masonryTopAt(mx, (b.z1 + b.z2) * 0.5);
      this.pushWallBox(walls, b.x1, b.z1, b.x2, b.z2, b.halfW, Number.isFinite(top) ? top : 1e4);
    }
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
  getGateDoor(): GateDoorOut | null {
    const door = this.gateDoor;
    if (!door) return null;
    const gate = this.gateList.find((g) => g.id === door.gateId);
    door.open = gate ? gate.open : false;
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
    if (this.bays.length === 0) return undefined;
    const i = Math.floor((x - this.bayX0) / this.bayPitch);
    return i >= 0 && i < this.bays.length ? this.bays[i] : undefined;
  }

  /**
   * Absolute Y of the top of the masonry at a point, or `-Infinity` where there is none.
   *
   * This is what makes an arrow stop at a wall instead of passing through it and burying
   * itself in the terrain on the far side. O(1): the bay index is arithmetic in x, and the
   * cross-section test is a distance to the bay centreline.
   *
   * The gatehouse reports its block height across the whole 25 m of the block and ignores
   * the carriageway, which is deliberate — a missile through the open gate is a
   * one-in-a-thousand shot and not worth a second branch in a per-projectile hot path.
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
      if (Math.abs(gt) <= gb.halfRun && Math.abs(goff) <= gb.halfDepth) return gb.topY;
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
    const bay = this.bayAt(x);
    if (!bay) return -Infinity;
    // Signed perpendicular offset from the bay centreline, positive outward.
    const t = (x - bay.x0) * bay.dx + (z - bay.z0) * bay.dz;
    const px = bay.x0 + bay.dx * t;
    const pz = bay.z0 + bay.dz * t;
    const off = (x - px) * bay.nx + (z - pz) * bay.nz;

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
     * The period matches the `crenellation()` call in `wall.ts` exactly: 1.7 m merlons on
     * 0.95 m gaps. `hash2`-free and purely arithmetic, because this runs per projectile
     * per tick.
     */
    const period = this.plan.merlonLength + this.plan.crenelLength;
    const phase = t - Math.floor(t / period) * period;
    return phase < this.plan.merlonLength ? bay.crestY : bay.sillY;
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
      c.levels[c.current].group.visible = false;
      c.levels[want].group.visible = true;
      c.current = want;
    }
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
      const lvl = c.levels[c.current];
      const n = lvl.group.children.length;
      visibleMeshes += n;
      visibleTriangles += lvl.triangles;
      const family = c.name.split('-')[0];
      byFamily.set(family, (byFamily.get(family) ?? 0) + n);
    }
    const c = this.checks;
    return {
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
