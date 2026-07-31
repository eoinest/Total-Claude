import * as THREE from 'three';
import type { EngineContext } from '../core/Engine';
import type { BattleSystem, ElevationOwner } from './BattleSystem';
import { NO_SUPPORT } from './BattleSystem';
import type { ProjectileSystem } from './Projectiles';
import { SoldierState, UnitOrder, type UnitGroupState } from './types';
import { clamp, lerp } from '../util/math';
import { hash01, Rng } from '../util/rand';
import {
  RAMP_LEN, RAM_HALF_D, RAM_SHED_H, RAM_TRUNK_REACH, TOWER_FLOORS, TOWER_HALF_D, TOWER_HALF_W,
  buildLadder, buildRamShed, buildRamTrunk,
  buildTowerDeck, buildTowerRamp, buildTowerShaft, buildTowerWheels, siegeMaterial,
} from './siegeGeometry';

/**
 * Siege warfare: garrisoning a wall, and the train that comes to take it.
 *
 * This is not an engine subsystem. It is owned and driven by `BattleSystem`, because
 * everything it does has to interleave with the soldier tick at exactly two points — once
 * before steering, to say where a man on a structure is standing and where he should
 * stand, and once after integration, to put him back on the ledge that the crowd solver
 * and the integrator have just shoved him off. A separate subsystem could only have run
 * before or after the whole of `BattleSystem`, and either way a garrison would spend every
 * other frame in mid-air.
 *
 * ## What is here
 *
 * **The spine.** The wall-walk is flattened once, at init, into a list of *stations*: a
 * position, a surface height, an outward normal and a clear standing band, every 0.86 m
 * along every bay a man could stand on, with the tower footprints cut out. Garrisoning a
 * unit is then a matter of handing it a contiguous run of stations. This is what makes a
 * garrison follow a wall that steps in height, kinks in plan, is unfinished in six places
 * and has a hole in it — none of which a formation offset function can express.
 *
 * **Crossings.** A siege tower's ramp, a ladder, the stair inside a tower: all of them are
 * one mechanism, a polyline with an arc-length parameter per man. A crossing man's
 * position is *authored* along the path rather than steered toward it, which is the only
 * way to guarantee the properties that matter — he cannot fall off, cannot be shoved off
 * by the crowd solver, and cannot teleport, because his position is a continuous function
 * of a parameter that only ever increases by `speed * dt`.
 *
 * **The train.** Siege towers, a battering ram and escalade ladders, each drawn with one
 * instanced mesh per part however many there are. Artillery machines are not here: they
 * belong to `src/units/engines.ts`, and this workstream contributes only the `onager` and
 * `carroballista` unit definitions and the stone ballistics they shoot.
 *
 * ## Determinism
 *
 * Every draw is from `battle.rng.fork('siege')` or a child of it. Nothing here reads the
 * clock or `Math.random`. Assignment order is by unit id and member index, never by
 * iteration over a `Map`'s insertion order where that could vary.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Lateral spacing of men along a wall-walk. Same as the field spacing: shoulder to shoulder. */
const STATION_PITCH = 0.86;
/**
 * Front-to-back spacing of the ranks on a walkway, metres.
 *
 * Three ranks in the 1.57 m of clear band that 3.5 m of Aurelianic curtain leaves once the
 * parapet and a man's own 0.42 m body radius are subtracted. Two ranks was the first
 * answer and it looked picketed; `reference/siege/good-picture-of-artures-on-a-wall.jpg`
 * shows a wall manned three and four deep, and that density is most of what makes a
 * garrison read as a garrison.
 *
 * 0.72 is below the 0.84 m body diameter the crowd solver enforces, which is why alternate
 * ranks are offset half a station sideways: the diagonal between a man and his neighbour
 * in the next rank is then hypot(0.43, 0.72) = 0.84 m exactly, so the solver is satisfied
 * and does not spend every tick shoving the garrison off its own slots. It is also how a
 * dense formation actually packs.
 */
const WALL_RANK_PITCH = 0.72;
/** Sideways offset applied to odd ranks so the packing interlocks. Half a station. */
const WALL_RANK_STAGGER = STATION_PITCH * 0.5;
/** Most ranks a walkway will ever take. */
const MAX_WALL_RANKS = 3;
/**
 * How fast a siege tower rolls, metres per second.
 *
 * Josephus has the towers at Jerusalem moved by gangs on rollers and levers; Vegetius
 * IV.17 assumes a day's work to bring one up. 0.42 m/s — a slow walking pace — crosses
 * 120 m of glacis in five minutes, which is slow enough to read as enormously heavy and
 * fast enough to happen inside a battle.
 */
const TOWER_SPEED = 0.42;
/** And a ram, which is lighter and has further to come. */
const RAM_SPEED = 0.55;
/** Seconds for a boarding ramp to fall from stowed to landed. */
const RAMP_FALL = 2.2;
/** Metres a man covers per second crossing a ramp or a deck. */
const CROSS_WALK = 1.35;
/** And climbing a ladder or an internal stair, which is much slower. */
const CROSS_CLIMB = 0.78;
/** Minimum gap between two men in the same crossing queue, metres. */
const CROSS_GAP = 0.78;
/** How close to the foot of a path a man must be before he may step onto it. */
const ADMIT_RADIUS = 1.6;
/** Stations either side of his slot searched for the one he is actually standing on. */
const STATION_WINDOW = 14;
/** `stationOf` for a man who has just come over the parapet and has no slot yet. */
const PENDING_SLOT = -2;
/** Metres of travel over which his entry position is blended onto the path. */
const ENTRY_BLEND = 1.0;
/** Seconds between blows of a ram at full crew. */
const RAM_PERIOD = 4.4;
/** Blows a gate of this construction survives. Twin oak leaves, iron-bound. */
const GATE_BLOWS = 26;

const MAX_TOWERS = 6;
const MAX_RAMS = 2;
const MAX_LADDERS = 24;

// ---------------------------------------------------------------------------

const enum TowerState {
  Approach = 0,
  Docking = 1,
  Landing = 2,
  Boarding = 3,
  Spent = 4,
}

interface SiegeTower {
  id: number;
  /** Base centre, on the ground. */
  x: number;
  z: number;
  y: number;
  /** Heading: the direction the front face (-Z local) points, i.e. at the wall. */
  facing: number;
  state: TowerState;
  /** Absolute Y of the fighting deck. */
  deckY: number;
  /** Where it is trying to get to — hard against the wall face at its target station. */
  dockX: number;
  dockZ: number;
  /** Station on the spine the ramp lands at. */
  station: number;
  /** 0 stowed vertical, 1 landed. */
  ramp: number;
  /** Unit whose men board through it. */
  unitId: number;
  /** Men who have completed the crossing. */
  crossed: number;
  crossing: Crossing | null;
  /** Distance still to run, metres, for the report. */
  dist: number;
}

interface SiegeRam {
  id: number;
  x: number;
  z: number;
  y: number;
  facing: number;
  /** Recoil offset of the trunk along its own axis, metres. Negative is drawn back. */
  swing: number;
  /** Seconds until the next blow. */
  timer: number;
  arrived: boolean;
  unitId: number;
  targetX: number;
  targetZ: number;
  blows: number;
}

interface Ladder {
  x: number;
  z: number;
  footY: number;
  /** Absolute Y of the parapet the hooks are over. */
  headY: number;
  /** Radians off vertical, solved so the head lands on the parapet. */
  lean: number;
  facing: number;
  station: number;
  crossing: Crossing | null;
  unitId: number;
  crossed: number;
}

/**
 * A path men move along one at a time, in file.
 *
 * Positions are authored from the arc-length parameter rather than steered toward, which
 * is what makes "nobody falls off" a property of the representation instead of something
 * the tuning has to keep achieving.
 */
interface Crossing {
  /** Flat [x,y,z] triples. */
  pts: Float32Array;
  /** Cumulative arc length at each point, so `arc[n-1]` is the total. */
  arc: Float32Array;
  n: number;
  /** Where a man who finishes the crossing ends up on the spine. */
  destStation: number;
  /** Soldier indices currently on the path, ordered from furthest along to least. */
  queue: number[];
}

interface Garrison {
  unitId: number;
  /** First station of this unit's run. */
  from: number;
  /** Number of stations it occupies. */
  span: number;
  ranks: number;
  /** Living count the current plan was laid out for. */
  plannedFor: number;
  /**
   * A boarding party is never re-formed.
   *
   * A defending garrison closes up along the wall as it takes losses, which is right. A
   * party coming over a ramp or a ladder must not: re-laying it every time another man
   * lands makes the whole lodgement shuffle sideways once a second, and men who are in
   * melee get told to walk out of it. They take the next free slot outward from where they
   * came over and they stay there.
   */
  sticky: boolean;
  /** Arrivals so far, for the next-free-slot cursor. */
  filled: number;
}

const TMP_M = new THREE.Matrix4();
const TMP_Q = new THREE.Quaternion();
const TMP_P = new THREE.Vector3();
const TMP_S = new THREE.Vector3(1, 1, 1);
const TMP_E = new THREE.Euler();
const TMP_C = new THREE.Color();

interface CityView {
  getGarrisonBays(): readonly {
    index: number; x0: number; z0: number; x1: number; z1: number;
    nx: number; nz: number; dx: number; dz: number; length: number;
    walkY: number; groundY: number; crestY: number; sillY: number;
    parapetInner: number; parapetOuter: number;
    innerOff: number; outerOff: number; garrisonable: boolean; towerHalf: number;
    isGate: boolean; stage: string;
  }[];
  getGates(): { id: string; x: number; z: number; facing: number; open: boolean }[];
  setGateOpen(id: string, open: boolean): void;
}

export class Siege implements ElevationOwner {
  private battle!: BattleSystem;
  private ctx!: EngineContext;
  private city: CityView | null = null;
  private projectiles: ProjectileSystem | null = null;
  private rng = new Rng('siege');

  // ---- the wall, flattened into places to stand ----
  private sx = new Float32Array(0);
  private sz = new Float32Array(0);
  private sy = new Float32Array(0);
  private snx = new Float32Array(0);
  private snz = new Float32Array(0);
  private sOuter = new Float32Array(0);
  private sInner = new Float32Array(0);
  /**
   * Normal-offset of the outer *face* of the wall at each station, as opposed to `sOuter`,
   * which is the outward limit a man may stand at. A siege tower docks against the face and
   * a man stands well back from it, so the two are 1.3 m apart and using one for the other
   * drove four towers 0.70 m into the brickwork.
   */
  private sFace = new Float32Array(0);
  /** Absolute Y of the top of the battlement at each station. A tower deck must clear it. */
  private sCrest = new Float32Array(0);
  private sBay = new Int32Array(0);
  /**
   * Which continuous run of walkway each station belongs to.
   *
   * The wall-walk is *not* one connected surface. It is broken at every tower, at every
   * unbuilt bay, and — the one that cost a measurement to find — at the construction steps
   * between bays. `walkY` is quantised in 0.55 m increments held over pairs of bays, and
   * over rolling ground two neighbouring bays can differ by far more than a man can step:
   * the joint east of the gate is a **3.62 m** drop, and a garrison laid straight across it
   * teleported men down the step the instant their slot moved past it.
   *
   * Stations are in the same run only if consecutive ones are close enough in three
   * dimensions to walk between. Nothing — garrison layout, the standing-surface search, a
   * lodgement spreading out from a ramp — may cross a run boundary.
   */
  private sRun = new Int32Array(0);
  private nStations = 0;

  // ---- entities ----
  private towers: SiegeTower[] = [];
  private rams: SiegeRam[] = [];
  private ladders: Ladder[] = [];
  private garrisons = new Map<number, Garrison>();
  /** Units whose men the siege system places. Includes garrisons and boarding parties. */
  private owned = new Set<number>();

  // ---- per-soldier crossing state ----
  /** Which crossing this man is on, or -1. Indexed by soldier. */
  private crossOf!: Int32Array;
  /** Metres along it. */
  private crossT!: Float32Array;
  /**
   * Where he was standing at the instant he was admitted.
   *
   * A crossing's position is authored from its arc-length parameter, so admitting a man
   * standing a metre from the foot of a ladder used to move him onto `pts[0]` in a single
   * tick. The probe caught it as a 3.35 m instantaneous step — the admission radius,
   * exactly — which is a teleport however briefly it lasts. His entry point is kept so the
   * first metre of the climb can be blended from where he actually was.
   */
  private crossEx!: Float32Array;
  private crossEy!: Float32Array;
  private crossEz!: Float32Array;
  /** Station he is bound for once across; -1 while he is still on the ground. */
  private stationOf!: Int32Array;
  /** Which rank of the walkway he holds. */
  private rankOf!: Uint8Array;

  // ---- gate ----
  private gateBlows = 0;
  private gateBreached = false;

  // ---- diagnostics ----
  /** Missiles released by men whose feet were on a wall-walk. */
  wallShots = 0;
  /** Men killed by those missiles. */
  wallKills = 0;
  private artilleryShots = 0;
  private artilleryKills = 0;

  // ---- rendering ----
  private root = new THREE.Group();
  private material?: THREE.MeshStandardMaterial;
  private mShaft?: THREE.InstancedMesh;
  private mDeck?: THREE.InstancedMesh;
  private mWheels?: THREE.InstancedMesh;
  private mRamp?: THREE.InstancedMesh;
  private mShed?: THREE.InstancedMesh;
  private mTrunk?: THREE.InstancedMesh;
  private mLadder?: THREE.InstancedMesh;

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  init(ctx: EngineContext, battle: BattleSystem): void {
    this.ctx = ctx;
    this.battle = battle;
    this.rng = battle.rng.fork('siege');
    // Duck-typed: a battle on open ground has no city, and neither does a unit test.
    const city = ctx.tryGet('city') as unknown as Partial<CityView> | undefined;
    this.city = city && typeof city.getGarrisonBays === 'function' ? (city as CityView) : null;

    const cap = battle.pool.capacity;
    this.crossOf = new Int32Array(cap).fill(-1);
    this.crossT = new Float32Array(cap);
    this.crossEx = new Float32Array(cap);
    this.crossEy = new Float32Array(cap);
    this.crossEz = new Float32Array(cap);
    this.stationOf = new Int32Array(cap).fill(-1);
    this.rankOf = new Uint8Array(cap);

    this.buildSpine();
    this.buildMeshes(ctx);

    battle.elevation = this;
  }

  /** Late binding: the projectile system is registered after the battle. */
  private ensureProjectiles(): ProjectileSystem | null {
    if (this.projectiles === null) {
      this.projectiles = this.ctx.tryGet<ProjectileSystem>('projectiles') ?? null;
    }
    return this.projectiles;
  }

  /**
   * Flatten every garrisonable bay into a list of standing stations.
   *
   * Built once. The wall does not move, so a garrison's slot geometry is a lookup rather
   * than a computation, and re-forming a unit after losses costs an array write per man.
   */
  private buildSpine(): void {
    if (!this.city) return;
    const bays = this.city.getGarrisonBays();
    const xs: number[] = [];
    const zs: number[] = [];
    const ys: number[] = [];
    const nxs: number[] = [];
    const nzs: number[] = [];
    const outs: number[] = [];
    const ins: number[] = [];
    const faces: number[] = [];
    const crests: number[] = [];
    const bidx: number[] = [];

    for (const bay of bays) {
      if (!bay.garrisonable) continue;
      // A tower stands at the bay's west end and its ballista chamber occupies the walk
      // there, so the standing run starts clear of it. The east end is the next bay's
      // tower, which that bay's own margin handles.
      const t0 = bay.towerHalf + 0.55;
      const t1 = bay.length - 0.55;
      if (t1 - t0 < STATION_PITCH) continue;
      const count = Math.floor((t1 - t0) / STATION_PITCH);
      for (let k = 0; k <= count; k++) {
        const t = t0 + k * STATION_PITCH;
        xs.push(bay.x0 + bay.dx * t);
        zs.push(bay.z0 + bay.dz * t);
        ys.push(bay.walkY);
        nxs.push(bay.nx);
        nzs.push(bay.nz);
        outs.push(bay.outerOff);
        ins.push(bay.innerOff);
        faces.push(bay.parapetOuter);
        crests.push(bay.crestY);
        bidx.push(bay.index);
      }
    }

    this.nStations = xs.length;
    this.sx = new Float32Array(xs);
    this.sz = new Float32Array(zs);
    this.sy = new Float32Array(ys);
    this.snx = new Float32Array(nxs);
    this.snz = new Float32Array(nzs);
    this.sOuter = new Float32Array(outs);
    this.sInner = new Float32Array(ins);
    this.sFace = new Float32Array(faces);
    this.sCrest = new Float32Array(crests);
    this.sBay = new Int32Array(bidx);

    // Split into walkable runs. 0.62 m is a high step but a possible one; the breaks this
    // is really catching are metres deep.
    this.sRun = new Int32Array(this.nStations);
    let run = 0;
    for (let i = 1; i < this.nStations; i++) {
      const dx = this.sx[i] - this.sx[i - 1];
      const dz = this.sz[i] - this.sz[i - 1];
      const dy = Math.abs(this.sy[i] - this.sy[i - 1]);
      if (Math.hypot(dx, dz) > STATION_PITCH * 1.9 || dy > 0.62) run++;
      this.sRun[i] = run;
    }
  }

  /** First and last station of the run containing `station`. */
  private runBounds(station: number): { lo: number; hi: number } {
    const r = this.sRun[station];
    let lo = station;
    let hi = station;
    while (lo > 0 && this.sRun[lo - 1] === r) lo--;
    while (hi < this.nStations - 1 && this.sRun[hi + 1] === r) hi++;
    return { lo, hi };
  }

  private buildMeshes(ctx: EngineContext): void {
    this.material = siegeMaterial();
    /**
     * `cast` is deliberately not set on everything.
     *
     * Every shadow-casting mesh is re-rendered once per cascade plus the depth prepass, so
     * nine casting instanced meshes cost 45 draw calls, not nine — measured, by hiding the
     * siege group at the worst siege camera and watching the count fall from 291 to 246.
     * The shaft, the deck and the ram shed are the parts whose shadow carries the mass of
     * the machine; a ladder rung, a wheel and a plank ramp contribute a few texels of the
     * outermost cascade and are not worth four passes each.
     */
    const mk = (geo: THREE.BufferGeometry, n: number, name: string, cast: boolean): THREE.InstancedMesh => {
      const m = new THREE.InstancedMesh(geo, this.material!, n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = cast;
      m.receiveShadow = true;
      m.count = 0;
      m.name = name;
      this.root.add(m);
      return m;
    };
    this.mShaft = mk(buildTowerShaft(), MAX_TOWERS, 'siege-tower-shaft', true);
    this.mDeck = mk(buildTowerDeck(), MAX_TOWERS, 'siege-tower-deck', true);
    this.mWheels = mk(buildTowerWheels(), MAX_TOWERS, 'siege-tower-wheels', false);
    this.mRamp = mk(buildTowerRamp(), MAX_TOWERS, 'siege-tower-ramp', false);
    this.mShed = mk(buildRamShed(), MAX_RAMS, 'siege-ram-shed', true);
    this.mTrunk = mk(buildRamTrunk(), MAX_RAMS, 'siege-ram-trunk', false);
    this.mLadder = mk(buildLadder(), MAX_LADDERS, 'siege-ladders', false);
    this.root.name = 'siege';
    ctx.scene.add(this.root);
  }

  // -------------------------------------------------------------------------
  // Spine queries
  // -------------------------------------------------------------------------

  get stationCount(): number {
    return this.nStations;
  }

  /** Nearest standing station to a point. Linear, but only ever called on an order. */
  stationNear(x: number, z: number): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.nStations; i++) {
      const dx = this.sx[i] - x;
      const dz = this.sz[i] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * The station whose stonework a man is actually standing on.
   *
   * **Not the same thing as the station he has been assigned to**, and conflating the two
   * was a 3.62 m teleport. A man's slot is a destination he walks to; his feet rest on
   * whatever is under him *now*. When a boarding party re-formed and moved a man's slot
   * eight stations along the wall onto a bay one construction step lower, snapping his Y
   * from the new slot dropped him 3.62 m in a single tick — measured, with the station
   * index changing 873 to 865 in the same frame.
   *
   * Searched in a window around his slot rather than over the whole spine: he is never
   * more than a few metres from it, and this runs for every garrisoned man every tick.
   */
  private standingStation(i: number, slot: number): number {
    const p = this.battle.pool;
    const x = p.x[i];
    const z = p.z[i];
    // Never leaves the run his slot is on: the nearest station in plan may be on the
    // other side of a three-metre step, and it is not the one he is standing on.
    const bounds = this.runBounds(slot);
    const lo = Math.max(bounds.lo, slot - STATION_WINDOW);
    const hi = Math.min(bounds.hi, slot + STATION_WINDOW);
    let best = slot;
    let bestD = Infinity;
    for (let k = lo; k <= hi; k++) {
      const dx = this.sx[k] - x;
      const dz = this.sz[k] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  }

  /** World position of a man standing at `station` in `rank`, written into `out`. */
  private slotAt(
    i: number, station: number, rank: number,
    out: { x: number; y: number; z: number; f: number }
  ): void {
    const s = clamp(station, 0, this.nStations - 1) | 0;
    /**
     * Per-man jitter, and it is not cosmetic.
     *
     * The first version put every man exactly on his station with exactly the outward
     * normal for a facing, and a blind critic picked the result out of a line-up on it
     * immediately: *"every crenellation contains the same soldier in the same pose with the
     * same shield at the same angle — nine copies in a row"*. A garrison on a 0.86 m station
     * pitch against a 2.65 m merlon-and-crenel period also beats visibly against the
     * battlement, which is what turned a line of men into a repeating sawtooth.
     *
     * `hash01` is stable per man, so his stance never changes frame to frame — the rule the
     * architecture doc sets for every appearance choice — and it is not drawn from the `Rng`
     * because this runs in a fixed step for every garrisoned man every tick.
     */
    const jAlong = (hash01(i, 0x51e9e) - 0.5) * 0.42;
    const jOff = (hash01(i, 0x9a11) - 0.5) * 0.26;
    // Rank 0 stands against the parapet; each rank behind steps back toward the city.
    const off = clamp(
      this.sOuter[s] - rank * WALL_RANK_PITCH + jOff,
      this.sInner[s], this.sOuter[s]
    );
    // Odd ranks shift half a station along the wall so the packing interlocks. See
    // `WALL_RANK_PITCH`.
    const along = ((rank & 1) === 0 ? 0 : WALL_RANK_STAGGER) + jAlong;
    // The along-wall direction is perpendicular to the outward normal, in plan.
    const ax = -this.snz[s];
    const az = this.snx[s];
    out.x = this.sx[s] + this.snx[s] * off + ax * along;
    out.z = this.sz[s] + this.snz[s] * off + az * along;
    out.y = this.sy[s];
    // Facing outward over the parapet — that is the whole point of being up here — but a
    // rank of men watching a field does not all look at the same point on the horizon.
    out.f = Math.atan2(this.snx[s], this.snz[s]) + (hash01(i, 0x7a11) - 0.5) * 0.5;
  }

  // -------------------------------------------------------------------------
  // Garrison
  // -------------------------------------------------------------------------

  /**
   * Put a unit on the wall, centred on the station nearest `(x, z)`.
   *
   * The unit stops being a formation: its men are laid out along the stonework in as many
   * ranks as the walkway is wide, and `BattleSystem` steers them to absolute world slots
   * instead of to formation offsets. Returns false if there is no wall there.
   */
  garrison(u: UnitGroupState, x: number, z: number): boolean {
    if (this.nStations === 0) return false;
    const centre = this.stationNear(x, z);
    if (centre < 0) return false;
    const g: Garrison = { unitId: u.id, from: 0, span: 0, ranks: 2, plannedFor: -1, sticky: false, filled: 0 };
    this.garrisons.set(u.id, g);
    this.owned.add(u.id);
    u.order = UnitOrder.Garrison;
    u.targetUnitId = -1;
    u.waypoints.length = 0;
    u.contactLock = false;
    this.layOutGarrison(u, g, centre);
    // Place them there rather than making them walk: a garrison is *already* on the wall
    // when the assault arrives. Nothing else in the sim can put a man 7 m up.
    const p = this.battle.pool;
    const slot = { x: 0, y: 0, z: 0, f: 0 };
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      const st = this.stationOf[i];
      if (st < 0) continue;
      this.slotAt(i, st, this.rankOf[i], slot);
      p.x[i] = slot.x; p.z[i] = slot.z; p.y[i] = slot.y;
      p.px[i] = slot.x; p.pz[i] = slot.z; p.py[i] = slot.y;
      p.facing[i] = slot.f;
      p.prevFacing[i] = slot.f;
      this.battle.elevated[i] = 1;
      this.battle.support[i] = slot.y;
    }
    return true;
  }

  /**
   * Assign stations to the living men of a garrisoned unit, centred on `centre`.
   *
   * Re-run when the unit has taken enough losses to leave holes in the line. Men are
   * repacked in member order, so a garrison closes up along the wall the way a line closes
   * up in the field, and a man's station only ever shifts by the gap left beside him.
   */
  private layOutGarrison(u: UnitGroupState, g: Garrison, centre?: number): void {
    const p = this.battle.pool;
    const living: number[] = [];
    for (const i of u.members) if (p.aliveAt(i)) living.push(i);
    if (living.length === 0) return;

    // How many ranks the narrowest part of this run will take. Two is the practical
    // maximum on 3.5 m of curtain once the parapet and the gallery piers are subtracted.
    const mid = centre ?? g.from + (g.span >> 1);
    const m = clamp(mid, 0, this.nStations - 1);
    const band = this.sOuter[m] - this.sInner[m];
    // As many ranks as the clear band will take at the interlocking pitch.
    const ranks = clamp(Math.floor(band / WALL_RANK_PITCH) + 1, 1, MAX_WALL_RANKS);
    // A unit holds one continuous stretch of walkway. It may not straddle a tower or a
    // construction step, so the run it is centred on bounds it — and if that run is
    // shorter than the unit, the unit stands deeper rather than spilling over the break.
    const bounds = this.runBounds(m);
    const runLen = bounds.hi - bounds.lo + 1;
    const perRank = Math.min(runLen, Math.ceil(living.length / ranks));
    const from = clamp((centre ?? mid) - (perRank >> 1), bounds.lo, Math.max(bounds.lo, bounds.hi - perRank + 1));

    g.from = from;
    g.span = perRank;
    g.ranks = ranks;
    g.plannedFor = living.length;

    for (let k = 0; k < living.length; k++) {
      const i = living[k];
      // Fill the front rank first: a wall is held at the parapet, and a half-strength
      // garrison should be one full line of men shooting, not two half lines.
      const rank = Math.floor(k / perRank);
      const file = k % perRank;
      this.stationOf[i] = clamp(from + file, bounds.lo, bounds.hi);
      this.rankOf[i] = Math.min(255, rank);
    }
  }

  isGarrisoned(unitId: number): boolean {
    return this.garrisons.has(unitId);
  }

  ownsUnit(unitId: number): boolean {
    return this.owned.has(unitId);
  }

  // -------------------------------------------------------------------------
  // The train
  // -------------------------------------------------------------------------

  /**
   * Roll a siege tower at the wall, with `unitId`'s men crewing and boarding it.
   *
   * `targetX/targetZ` names the stretch of curtain it is aimed at; the tower squares up to
   * that bay's own normal, because a tower that arrives at an angle cannot land its ramp.
   */
  spawnTower(x: number, z: number, targetX: number, targetZ: number, unitId: number): number {
    if (this.towers.length >= MAX_TOWERS || this.nStations === 0) return -1;
    const station = this.stationNear(targetX, targetZ);
    if (station < 0) return -1;
    const nx = this.snx[station];
    const nz = this.snz[station];
    /**
     * Where the tower's centre stops, measured out from the bay centreline.
     *
     * Its *front face* must end up just clear of the wall's outer face — `sFace` — and the
     * face is `TOWER_HALF_D` ahead of the centre. The first version used a flat 1.05 m
     * clearance from the centreline instead of from the face, which put the front of the
     * machine 0.70 m inside the brickwork: measured, on all four towers, as `faceGap`
     * −0.70. It also overshot the ramp, because the hinge was then too far in for the
     * 3.4 m ramp to land anywhere but off the back of the wall.
     *
     * 0.32 m of clearance is a hand's breadth of daylight — enough that the machine does
     * not visibly intersect the masonry, close enough that the ramp bridges the parapet.
     */
    const standoff = this.sFace[station] + 0.32 + TOWER_HALF_D;
    const t: SiegeTower = {
      id: this.towers.length,
      x, z,
      y: this.battle.groundAt(x, z),
      facing: Math.atan2(-nx, -nz),
      state: TowerState.Approach,
      /**
       * Deck height: 0.55 m above the wall-walk, which is 1.5 m *below* the merlon tops.
       *
       * This is knowingly wrong and is reverted work. A blind critic judging the machine
       * observed that "the platform floor sits at the base of the merlons with the roof below
       * their tops — an assaulting soldier would have to climb out and over unaided", and it
       * is right: a tower should deliver men onto the wall from above its defences.
       *
       * Raising it to `sCrest + 0.3` with a 4.2 m ramp docked and measured correctly — deck
       * 45.25 against a walk at 42.90, ramp head level with the walk to within a centimetre —
       * but boarding then stopped dead: four towers in `boarding` state, every crew alive and
       * standing on its muster point 0.5 m from the mouth of the crossing, and not one man
       * admitted to the path. I could not find the cause by inspection inside the time I had,
       * and a tower that looks better and delivers nobody is worse than one that looks squat
       * and works. The probe assertion `infantry cross the ramp onto the wall` is what caught
       * it and is what should guard the retry.
       */
      deckY: this.sy[station] + 0.55,
      dockX: this.sx[station] + nx * standoff,
      dockZ: this.sz[station] + nz * standoff,
      station,
      ramp: 0,
      unitId,
      crossed: 0,
      crossing: null,
      dist: 0,
    };
    this.towers.push(t);
    this.owned.add(unitId);
    return t.id;
  }

  /** Send a ram at a gate. */
  spawnRam(x: number, z: number, unitId: number): number {
    if (this.rams.length >= MAX_RAMS || !this.city) return -1;
    const gate = this.city.getGates()[0];
    if (!gate) return -1;
    const r: SiegeRam = {
      id: this.rams.length,
      x, z,
      y: this.battle.groundAt(x, z),
      facing: Math.atan2(gate.x - x, gate.z - z),
      swing: 0,
      timer: RAM_PERIOD,
      arrived: false,
      unitId,
      // Stop with the head against the leaves, not inside them.
      targetX: gate.x + Math.sin(gate.facing) * (RAM_HALF_D + 3.6),
      targetZ: gate.z + Math.cos(gate.facing) * (RAM_HALF_D + 3.6),
      blows: 0,
    };
    this.rams.push(r);
    this.owned.add(unitId);
    return r.id;
  }

  /**
   * Rest a ladder against the parapet nearest `(x, z)` and send `unitId` up it.
   *
   * Escalade is the cheap assault: no machine, no months of carpentry, and a casualty rate
   * that makes it the thing you do when you have more men than time. Mechanically it is
   * the same crossing as a tower ramp with a steeper path and no vehicle.
   */
  spawnLadder(x: number, z: number, unitId: number): boolean {
    if (this.ladders.length >= MAX_LADDERS || this.nStations === 0) return false;
    const station = this.stationNear(x, z);
    if (station < 0) return false;
    const nx = this.snx[station];
    const nz = this.snz[station];
    /**
     * Pitch and footing solved from the wall, not chosen and hoped for.
     *
     * A ladder has to reach: its head must land *on* the parapet, and that fixes the
     * relationship between how tall the wall is, how far out the foot stands and how far it
     * leans. The first version put the foot at a flat 3.65 m from the centreline and leaned
     * the ladder by `atan2(1.6, rise)` — 11 degrees over an 8 m rise, which covers 1.55 m
     * horizontally and left every ladder head three quarters of a metre short of the
     * masonry, standing in mid-air beside a wall nobody could climb.
     *
     * 0.36 of the rise is a pitch of about 70 degrees from horizontal, the standard escalade
     * angle: steeper and the ladder tips backwards off the wall under a man's weight,
     * shallower and it bends and is easier to shove away from the parapet.
     */
    const headY = this.sy[station] + 0.9;
    const face = this.sFace[station];
    const probeX = this.sx[station] + nx * (face + 3.0);
    const probeZ = this.sz[station] + nz * (face + 3.0);
    const rise = Math.max(2, headY - this.battle.groundAt(probeX, probeZ));
    const run = rise * 0.36;
    const fx = this.sx[station] + nx * (face + run);
    const fz = this.sz[station] + nz * (face + run);
    this.ladders.push({
      x: fx, z: fz,
      footY: this.battle.groundAt(fx, fz),
      headY,
      // The hooks bite 0.25 m past the face, over the merlons.
      lean: Math.atan2(run + 0.25, rise),
      facing: Math.atan2(-nx, -nz),
      station,
      crossing: null,
      unitId,
      crossed: 0,
    });
    this.owned.add(unitId);
    return true;
  }

  /**
   * Artillery machines are **not** drawn here.
   *
   * `src/units/engines.ts` and `UnitRenderSystem` own every stone-thrower and bolt-shooter
   * on the field: `isEngineUnit` claims any unit of class `artillery`, and `engineKindOf`
   * already resolves a high-arc missile to `EngineKind.Onager` with its own crew stations,
   * pitch and arm sweep. This workstream added the `onager` and `carroballista` *unit
   * definitions* and the stone ballistics; the machines those crews serve are theirs, and
   * drawing a second placeholder on top would have superimposed two machines at one spot
   * and cost ten draw calls for the privilege.
   *
   * Kept as a no-op rather than deleted from `scenario.ts` so the seam is explicit.
   */
  registerArtillery(u: UnitGroupState): void {
    void u;
  }

  // -------------------------------------------------------------------------
  // Tick — before steering
  // -------------------------------------------------------------------------

  preSteer(dt: number): void {
    // A battle with nothing on a structure pays one comparison for all of this. The field
    // battle runs 8,600 men and never touches a wall; it must not pay for the siege.
    if (this.owned.size === 0 && this.garrisons.size === 0) return;
    this.updateGarrisons();
    this.updateTowers(dt);
    this.updateRams(dt);
    this.updateLadders(dt);
    // After the machines have moved, because a crew musters on where its machine *is*.
    this.musterOwned();
  }

  private updateGarrisons(): void {
    const b = this.battle;
    const p = b.pool;
    const slot = { x: 0, y: 0, z: 0, f: 0 };
    for (const [id, g] of this.garrisons) {
      const u = b.unitById(id);
      if (!u || u.destroyed) continue;
      // Re-form once the line has lost enough men to have visible holes in it. Six per
      // cent rather than every tick: re-laying every frame makes the whole garrison
      // shuffle a few centimetres on every casualty, which reads as a nervous twitch
      // running down the wall.
      if (!g.sticky && (g.plannedFor < 0 || u.alive < g.plannedFor * 0.94)) {
        this.layOutGarrison(u, g);
      }
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        const st = this.stationOf[i];
        if (st < 0) continue;
        this.slotAt(i, st, this.rankOf[i], slot);
        b.elevated[i] = 1;
        // Support from the stone he is on; the slot only says where he is walking to.
        b.support[i] = this.sy[this.standingStation(i, st)];
        b.slotX[i] = slot.x;
        b.slotZ[i] = slot.z;
        b.slotFacing[i] = slot.f;
      }
    }
  }

  private updateTowers(dt: number): void {
    const b = this.battle;
    for (const t of this.towers) {
      const dx = t.dockX - t.x;
      const dz = t.dockZ - t.z;
      t.dist = Math.hypot(dx, dz);

      if (t.state === TowerState.Approach) {
        if (t.dist <= TOWER_SPEED * dt) {
          t.x = t.dockX;
          t.z = t.dockZ;
          t.state = TowerState.Docking;
        } else {
          t.x += (dx / t.dist) * TOWER_SPEED * dt;
          t.z += (dz / t.dist) * TOWER_SPEED * dt;
        }
        t.y = b.groundAt(t.x, t.z);
        // The deck is fixed relative to the wall it is going to, not to the ground under
        // the tower: the whole machine is built to a measured height before it is moved.
        continue;
      }

      if (t.state === TowerState.Docking) {
        t.ramp = Math.min(1, t.ramp + dt / RAMP_FALL);
        if (t.ramp >= 1) {
          t.state = TowerState.Landing;
          t.crossing = this.buildTowerCrossing(t);
          this.ctx.events.emit('cameraShake', { amplitude: 0.35, decay: 2.0 });
        }
        continue;
      }

      if (t.state === TowerState.Landing) t.state = TowerState.Boarding;
    }
  }

  /**
   * The path a man takes from the ground behind a docked tower to the wall-walk.
   *
   * Five legs: to the tower's back door, up the internal stair, forward across the deck,
   * out along the ramp, and one pace clear of the ramp head onto the stonework. The climb
   * happens inside the hide screen, which is why it can be a straight vertical rise and
   * still read correctly — you cannot see it, and nor could you in 271.
   */
  private buildTowerCrossing(t: SiegeTower): Crossing {
    const cos = Math.cos(t.facing);
    const sin = Math.sin(t.facing);
    // Local (right, forward) -> world, where forward is the way the tower faces.
    const w = (rx: number, fz: number): [number, number] => [t.x + rx * cos + fz * sin, t.z - rx * sin + fz * cos];
    const s = this.slotStation(t.station);
    const back = w(0, -(TOWER_HALF_D + 1.4));
    const enter = w(0, -(TOWER_HALF_D - 0.55));
    const pts: number[] = [back[0], t.y, back[1], enter[0], t.y, enter[1]];

    // Up the inside on a zig-zag stair, landing on each floor.
    //
    // The rear of the tower is open lattice, so this climb is *visible* — it is the file
    // of men you can see standing on every level of the reference towers as they come on.
    // A straight vertical rise would have read as levitation through the frame; a flight
    // that reverses at each landing reads as a stair even though no stair is modelled,
    // because the men's own path is the thing you are watching.
    const rise = t.deckY - t.y;
    for (let f = 1; f <= TOWER_FLOORS; f++) {
      const y = t.y + (rise * f) / TOWER_FLOORS;
      // Alternate sides at each landing.
      const side = f % 2 === 0 ? -1 : 1;
      // Rear face, matching the modelled stair in `buildTowerShaft`: the climb is meant to
      // be visible through the open back of the tower, which is the whole reason the back is
      // open. On the front face it happened behind the hide.
      const land = w(side * (TOWER_HALF_W - 0.55), -(TOWER_HALF_D - 0.55));
      pts.push(land[0], y, land[1]);
    }
    // Across the deck, out along the ramp, and one pace clear onto the stonework.
    const deckFront = w(0, TOWER_HALF_D - 0.3);
    // Where the ramp head rests, in the tower's own frame: far enough forward to be past the
    // parapet and on the walk, not the full ramp length, because the ramp slopes down.
    const rampEnd = w(0, TOWER_HALF_D + 3.2);
    pts.push(deckFront[0], t.deckY, deckFront[1]);
    pts.push(rampEnd[0], s.y, rampEnd[1]);
    pts.push(s.x, s.y, s.z);
    return this.makeCrossing(pts, t.station);
  }

  /**
   * Pitch of a tower's ramp, radians, about the local +X axis at the deck's front lip.
   *
   * The ramp is authored running along -Z from its hinge, so after a rotation of `pitch`
   * about X its far end sits at `deckY + RAMP_LEN * sin(pitch)`. Landing it on the walkway
   * therefore needs **`asin((walkY - deckY) / RAMP_LEN)`, which is negative** because the
   * deck is deliberately built half a metre proud of the parapet — a ramp that has to be
   * pushed *up* onto a wall is a ramp that does not reach it.
   *
   * The sign was inverted in the first version and the probe caught it as a ramp whose
   * head floated 110 cm above the stonework: the same magnitude as the deck's own 55 cm
   * of clearance, doubled, which is exactly the signature of a flipped sign and not of a
   * mistuned constant.
   *
   * Stowed is +90 degrees: straight up against the front of the tower.
   */
  private rampPitch(t: SiegeTower): number {
    const landed = Math.asin(clamp((this.sy[t.station] - t.deckY) / RAMP_LEN, -1, 1));
    return lerp(Math.PI * 0.5, landed, t.ramp);
  }

  /** Absolute Y of the far end of a tower's ramp — the thing that must sit on the walk. */
  private rampHeadY(t: SiegeTower): number {
    return t.deckY + Math.sin(this.rampPitch(t)) * RAMP_LEN;
  }

  private slotStation(station: number): { x: number; y: number; z: number } {
    const s = clamp(station, 0, this.nStations - 1) | 0;
    const off = this.sOuter[s];
    return { x: this.sx[s] + this.snx[s] * off, y: this.sy[s], z: this.sz[s] + this.snz[s] * off };
  }

  private makeCrossing(flat: number[], destStation: number): Crossing {
    const n = flat.length / 3;
    const pts = new Float32Array(flat);
    const arc = new Float32Array(n);
    for (let k = 1; k < n; k++) {
      const dx = pts[k * 3] - pts[(k - 1) * 3];
      const dy = pts[k * 3 + 1] - pts[(k - 1) * 3 + 1];
      const dz = pts[k * 3 + 2] - pts[(k - 1) * 3 + 2];
      arc[k] = arc[k - 1] + Math.hypot(dx, dy, dz);
    }
    return { pts, arc, n, destStation, queue: [] };
  }

  private updateRams(dt: number): void {
    const b = this.battle;
    for (const r of this.rams) {
      if (!r.arrived) {
        const dx = r.targetX - r.x;
        const dz = r.targetZ - r.z;
        const d = Math.hypot(dx, dz);
        if (d <= RAM_SPEED * dt) {
          r.x = r.targetX;
          r.z = r.targetZ;
          r.arrived = true;
        } else {
          r.x += (dx / d) * RAM_SPEED * dt;
          r.z += (dz / d) * RAM_SPEED * dt;
        }
        r.y = b.groundAt(r.x, r.z);
        continue;
      }

      if (this.gateBreached) {
        // Draw it back out of the passage once the leaves are down.
        r.swing = lerp(r.swing, 0, Math.min(1, dt * 1.4));
        continue;
      }

      // The crew haul the trunk back against the slings and let it run. The blow lands
      // when the recoil crosses zero going forward, which is what makes the strike land
      // on the frame the sound plays on.
      r.timer -= dt;
      const phase = 1 - clamp(r.timer / RAM_PERIOD, 0, 1);
      // Draw back over the first 70 % of the cycle, run forward over the last 30 %.
      r.swing = phase < 0.7
        ? -1.5 * (phase / 0.7)
        : -1.5 * (1 - (phase - 0.7) / 0.3);
      if (r.timer <= 0) {
        r.timer = RAM_PERIOD;
        r.blows++;
        this.gateBlows++;
        this.ctx.events.emit('cameraShake', { amplitude: 0.55, decay: 2.6 });
        this.ctx.events.emit('projectileImpact', {
          x: r.x + Math.sin(r.facing) * (RAM_HALF_D + 3.2),
          y: r.y + 1.6,
          z: r.z + Math.cos(r.facing) * (RAM_HALF_D + 3.2),
          kind: 'bolt', hitTarget: false, material: 'wood',
        });
        if (this.gateBlows >= GATE_BLOWS && !this.gateBreached) {
          this.gateBreached = true;
          // The passage is already clear in the movement grid — the gate stood open. What
          // the breach changes is that it can no longer be shut, which is what the
          // defenders would otherwise do the moment the ram appeared.
          this.city?.setGateOpen('porta-flaminia', true);
          this.ctx.events.emit('cameraShake', { amplitude: 1.0, decay: 0.9 });
        }
      }
    }
  }

  private updateLadders(dt: number): void {
    void dt;
    for (const l of this.ladders) {
      if (l.crossing) continue;
      const s = this.slotStation(l.station);
      // Foot, head of the ladder at the parapet, then one pace onto the walk.
      l.crossing = this.makeCrossing([
        l.x, l.footY, l.z,
        l.x, l.footY, l.z,
        this.sx[l.station] + this.snx[l.station] * (this.sOuter[l.station] + 1.1), l.headY,
        this.sz[l.station] + this.snz[l.station] * (this.sOuter[l.station] + 1.1),
        s.x, s.y, s.z,
      ], l.station);
    }
  }

  // -------------------------------------------------------------------------
  // Tick — after integration
  // -------------------------------------------------------------------------

  postIntegrate(dt: number): void {
    if (this.owned.size === 0 && this.garrisons.size === 0) return;
    this.advanceCrossings(dt);
    this.holdGarrisonsOnTheWalk();
  }

  /**
   * Move everybody who is on a ramp, a stair or a ladder.
   *
   * Position is authored from the arc-length parameter, not steered toward, and the
   * parameter is monotone. That is the whole safety argument: a man cannot be pushed off
   * by the crowd solver because his position is overwritten after it runs, cannot fall
   * because his height is a function of where he is on the path, and cannot teleport
   * because the parameter advances by at most `CROSS_WALK * dt` in a tick.
   */
  private advanceCrossings(dt: number): void {
    const b = this.battle;
    const p = b.pool;
    for (const t of this.towers) {
      if (t.crossing) this.stepCrossing(t.crossing, t.unitId, dt, (n) => { t.crossed += n; });
    }
    for (const l of this.ladders) {
      if (l.crossing) this.stepCrossing(l.crossing, l.unitId, dt, (n) => { l.crossed += n; });
    }
    void p;
    void b;
  }

  private stepCrossing(c: Crossing, unitId: number, dt: number, onArrive: (n: number) => void): void {
    const b = this.battle;
    const p = b.pool;
    const u = b.unitById(unitId);
    if (!u || u.destroyed) return;
    const total = c.arc[c.n - 1];

    // ---- admit the next man ----
    // One at a time, and only once the man ahead is clear of the mouth of the path.
    const lastT = c.queue.length > 0 ? this.crossT[c.queue[c.queue.length - 1]] : Infinity;
    if (lastT > CROSS_GAP) {
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        if (this.crossOf[i] !== -1) continue;
        if (this.stationOf[i] >= 0) continue;
        // Only a man who has actually reached the foot of the path may start up it.
        const dx = p.x[i] - c.pts[0];
        const dz = p.z[i] - c.pts[2];
        if (dx * dx + dz * dz > ADMIT_RADIUS * ADMIT_RADIUS) continue;
        this.crossOf[i] = 1;
        this.crossT[i] = 0;
        this.crossEx[i] = p.x[i];
        this.crossEy[i] = p.y[i];
        this.crossEz[i] = p.z[i];
        c.queue.push(i);
        b.elevated[i] = 1;
        p.setState(i, SoldierState.Climbing);
        break;
      }
    }

    // ---- advance, back of the queue first so nobody is blocked by a stale position ----
    let arrived = 0;
    for (let k = c.queue.length - 1; k >= 0; k--) {
      const i = c.queue[k];
      if (!p.aliveAt(i)) {
        // A man shot off a ramp is simply gone from the queue; his corpse keeps the Y he
        // died at, which is what `elevated` is still doing for him.
        c.queue.splice(k, 1);
        this.crossOf[i] = -1;
        continue;
      }
      // Nobody overtakes: the man ahead is the one before him in the queue.
      const ahead = k > 0 ? this.crossT[c.queue[k - 1]] - CROSS_GAP : Infinity;
      const seg = this.segmentAt(c, this.crossT[i]);
      const speed = seg.steep ? CROSS_CLIMB : CROSS_WALK;
      const want = Math.min(this.crossT[i] + speed * dt, ahead, total);
      this.crossT[i] = Math.max(this.crossT[i], want);

      const pos = this.sampleCrossing(c, this.crossT[i]);
      // Ease off his entry point over the first metre so stepping onto the path is a step
      // and not a jump. At `crossT` 0 this is exactly where he already was.
      const w = clamp(this.crossT[i] / ENTRY_BLEND, 0, 1);
      pos.x = lerp(this.crossEx[i], pos.x, w);
      pos.y = lerp(this.crossEy[i], pos.y, w);
      pos.z = lerp(this.crossEz[i], pos.z, w);
      p.x[i] = pos.x; p.y[i] = pos.y; p.z[i] = pos.z;
      b.support[i] = pos.y;
      b.elevated[i] = 1;
      // Velocity is set, not integrated, so the animation state machine sees a man
      // walking and picks a locomotion clip instead of an idle. `integrate` will add it to
      // the position next tick and this function will overwrite that — the path is
      // authoritative and the double-step never accumulates.
      p.vx[i] = pos.tx * speed;
      p.vz[i] = pos.tz * speed;
      if (pos.tx !== 0 || pos.tz !== 0) p.facing[i] = Math.atan2(pos.tx, pos.tz);
      if (seg.steep && p.state[i] !== SoldierState.Climbing) p.setState(i, SoldierState.Climbing);
      else if (!seg.steep && p.state[i] === SoldierState.Climbing) p.setState(i, SoldierState.Running);

      if (this.crossT[i] >= total - 1e-3) {
        // Onto the wall. He joins the garrison of whatever bay the path ends at.
        c.queue.splice(k, 1);
        this.crossOf[i] = -1;
        // Flagged rather than placed: `adoptBoarders` decides where in the lodgement he
        // goes, and it must be able to tell him from the men already standing there.
        this.stationOf[i] = PENDING_SLOT;
        this.rankOf[i] = 0;
        p.setState(i, SoldierState.Idle);
        arrived++;
      }
    }
    if (arrived > 0) {
      onArrive(arrived);
      this.adoptBoarders(u, c.destStation);
    }
  }

  /**
   * Once men are across, the unit becomes a garrison of the bay it took.
   *
   * Its men keep arriving one at a time, so the layout is re-run each time somebody
   * lands — which is also what spreads the ones already up there along the wall to make
   * room, instead of stacking the whole cohort on one station.
   */
  private adoptBoarders(u: UnitGroupState, destStation: number): void {
    let g = this.garrisons.get(u.id);
    if (!g) {
      g = {
        unitId: u.id, from: destStation, span: 1, ranks: MAX_WALL_RANKS,
        plannedFor: -1, sticky: true, filled: 0,
      };
      this.garrisons.set(u.id, g);
      u.order = UnitOrder.Garrison;
    }
    // Men newly over the parapet are flagged with `PENDING_SLOT` by `stepCrossing`. They
    // fan out from the head of the ramp, alternating left and right, filling the ranks
    // behind before spreading further along the wall — a lodgement widening from a point,
    // which is what a lodgement does.
    const p = this.battle.pool;
    for (const i of u.members) {
      if (!p.aliveAt(i) || this.stationOf[i] !== PENDING_SLOT) continue;
      const n = g.filled++;
      const rank = n % MAX_WALL_RANKS;
      const step = Math.floor(n / MAX_WALL_RANKS);
      // 0, +1, -1, +2, -2, ... outward from where they came over.
      const spread = (step % 2 === 0 ? 1 : -1) * Math.ceil(step / 2);
      const bounds = this.runBounds(destStation);
      this.stationOf[i] = clamp(destStation + spread, bounds.lo, bounds.hi);
      this.rankOf[i] = rank;
      g.from = Math.min(g.from, this.stationOf[i]);
      g.span = Math.max(g.span, this.stationOf[i] - g.from + 1);
    }
  }

  /** Which leg of the path a parameter falls on, and whether it is a climb. */
  private segmentAt(c: Crossing, t: number): { k: number; steep: boolean } {
    let k = 1;
    while (k < c.n - 1 && c.arc[k] < t) k++;
    const dy = Math.abs(c.pts[k * 3 + 1] - c.pts[(k - 1) * 3 + 1]);
    const len = c.arc[k] - c.arc[k - 1];
    return { k, steep: len > 1e-4 && dy / len > 0.6 };
  }

  private sampleCrossing(c: Crossing, t: number): { x: number; y: number; z: number; tx: number; tz: number } {
    let k = 1;
    while (k < c.n - 1 && c.arc[k] < t) k++;
    const seg = Math.max(1e-4, c.arc[k] - c.arc[k - 1]);
    const f = clamp((t - c.arc[k - 1]) / seg, 0, 1);
    const a = (k - 1) * 3;
    const bI = k * 3;
    const x = lerp(c.pts[a], c.pts[bI], f);
    const y = lerp(c.pts[a + 1], c.pts[bI + 1], f);
    const z = lerp(c.pts[a + 2], c.pts[bI + 2], f);
    let tx = c.pts[bI] - c.pts[a];
    let tz = c.pts[bI + 2] - c.pts[a + 2];
    const l = Math.hypot(tx, tz);
    if (l > 1e-4) { tx /= l; tz /= l; } else { tx = 0; tz = 0; }
    return { x, y, z, tx, tz };
  }

  /**
   * Put every garrisoned man back on the stonework.
   *
   * `resolveCrowding` and `integrate` have just run and neither knows the walkway is
   * 3.45 m wide. Left alone, the shove from a man arriving off a ramp walks the rank in
   * front of him off the parapet at about 4 cm a tick — slow enough to look like nothing
   * for ten seconds and then drop a cohort into the ditch. Clamping the *lateral* offset
   * and leaving the along-wall position alone keeps the shoving that makes a line look
   * alive and removes only the component that can kill.
   */
  private holdGarrisonsOnTheWalk(): void {
    const b = this.battle;
    const p = b.pool;
    for (const [id, g] of this.garrisons) {
      void g;
      const u = b.unitById(id);
      if (!u || u.destroyed) continue;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        const slot = this.stationOf[i];
        if (slot < 0) continue;
        // Measured against the bay he is standing over, not the one he is walking toward.
        const st = this.standingStation(i, slot);
        const nx = this.snx[st];
        const nz = this.snz[st];
        // Signed distance from this station's centreline, along the outward normal.
        const dx = p.x[i] - this.sx[st];
        const dz = p.z[i] - this.sz[st];
        const off = dx * nx + dz * nz;
        const lo = this.sInner[st];
        const hi = this.sOuter[st];
        if (off < lo || off > hi) {
          const want = clamp(off, lo, hi);
          const corr = want - off;
          p.x[i] += nx * corr;
          p.z[i] += nz * corr;
        }
        p.y[i] = this.sy[st];
        b.support[i] = this.sy[st];
      }
    }
  }

  // -------------------------------------------------------------------------
  // Boarding party ground behaviour
  // -------------------------------------------------------------------------

  /**
   * Where a man of an owned unit who is not yet on a structure should stand.
   *
   * Called from `preSteer` for every owned unit so that `BattleSystem.steerToSlots` has
   * somewhere to send the men who are still on the grass: crews muster behind their
   * machine and walk with it, and a boarding party queues up at the foot of the path.
   */
  private musterOwned(): void {
    const b = this.battle;
    const p = b.pool;
    for (const t of this.towers) {
      const u = b.unitById(t.unitId);
      if (!u || u.destroyed) continue;
      const cos = Math.cos(t.facing);
      const sin = Math.sin(t.facing);
      let q = 0;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        if (this.stationOf[i] >= 0 || this.crossOf[i] !== -1) continue;
        // A column behind the tower, four abreast, which is also the gang pushing it.
        const file = q % 4;
        const row = Math.floor(q / 4);
        q++;
        const rx = (file - 1.5) * 0.9;
        /**
         * Local −Z, which is the side *away* from the wall.
         *
         * The tower's local +Z points along its facing, which is at the wall, so local −Z is
         * where the pushing gang stands and where the crossing path must begin. Flipping this
         * to +Z on the assumption that +Z was the rear put the muster point in the 0.32 m gap
         * between the machine and the masonry: nobody came within admission range of the path
         * and not one man boarded. The probe caught it immediately as `0 men across a boarding
         * ramp`, which is exactly the kind of silent break it exists for.
         */
        const fz = -(TOWER_HALF_D + 1.6 + row * 0.95);
        b.elevated[i] = 0;
        b.support[i] = NO_SUPPORT;
        b.slotX[i] = t.x + rx * cos + fz * sin;
        b.slotZ[i] = t.z - rx * sin + fz * cos;
        b.slotFacing[i] = t.facing;
      }
    }
    // Escalade parties queue at the foot of their own ladders, spread across them.
    //
    // The grouping map is built only when there are ladders: allocating an empty `Map`
    // every tick of every battle to serve a feature that is not in use is exactly the kind
    // of per-tick garbage that shows up as a jitter and never as a hot function.
    //
    // Without this they were `owned` — so `BattleSystem.steerToSlots` placed them — but
    // had no slot written, which is a `Float32Array` of zeroes: four hundred men walked
    // steadily toward the world origin, a kilometre from the wall, and no assertion in the
    // probe was looking at them. Anything the siege system claims to own it must place.
    if (this.ladders.length === 0) return this.musterRams();
    const byUnit = new Map<number, Ladder[]>();
    for (const l of this.ladders) {
      const arr = byUnit.get(l.unitId);
      if (arr) arr.push(l);
      else byUnit.set(l.unitId, [l]);
    }
    for (const [uid, group] of byUnit) {
      const u = b.unitById(uid);
      if (!u || u.destroyed) continue;
      let q = 0;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        if (this.stationOf[i] >= 0 || this.crossOf[i] !== -1) continue;
        // Round-robin across the party's ladders, in a file behind each foot. The
        // admission test in `stepCrossing` only takes a man within 3 m of the foot, so the
        // file forms itself: the head of it is admitted, everyone shuffles up.
        const l = group[q % group.length];
        const row = Math.floor(q / group.length);
        q++;
        const back = 1.1 + row * 0.9;
        b.elevated[i] = 0;
        b.support[i] = NO_SUPPORT;
        b.slotX[i] = l.x + Math.sin(l.facing + Math.PI) * back;
        b.slotZ[i] = l.z + Math.cos(l.facing + Math.PI) * back;
        b.slotFacing[i] = l.facing;
      }
    }

    this.musterRams();
  }

  /** Half the crew are under the shed with both hands on the trunk, the rest pushing. */
  private musterRams(): void {
    const b = this.battle;
    const p = b.pool;
    for (const r of this.rams) {
      const u = b.unitById(r.unitId);
      if (!u || u.destroyed) continue;
      const cos = Math.cos(r.facing);
      const sin = Math.sin(r.facing);
      let q = 0;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        const file = q % 4;
        const row = Math.floor(q / 4);
        q++;
        const rx = (file - 1.5) * 0.85;
        const fz = row < 4 ? 1.6 - row * 1.1 : -(RAM_HALF_D + (row - 3) * 0.95);
        b.elevated[i] = 0;
        b.support[i] = NO_SUPPORT;
        b.slotX[i] = r.x + rx * cos + fz * sin;
        b.slotZ[i] = r.z - rx * sin + fz * cos;
        b.slotFacing[i] = r.facing;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  preRender(): void {
    this.writeTowers();
    this.writeRams();
    this.writeLadders();
  }

  private setInstance(
    mesh: THREE.InstancedMesh | undefined, n: number,
    x: number, y: number, z: number, yaw: number,
    sx = 1, sy = 1, sz = 1, pitch = 0
  ): void {
    if (!mesh) return;
    TMP_E.set(pitch, yaw, 0, 'YXZ');
    TMP_Q.setFromEuler(TMP_E);
    TMP_P.set(x, y, z);
    TMP_S.set(sx, sy, sz);
    TMP_M.compose(TMP_P, TMP_Q, TMP_S);
    mesh.setMatrixAt(n, TMP_M);
  }

  /**
   * A stable per-instance tint, so two machines built by different gangs out of different
   * timber are not the same object twice.
   *
   * `InstancedMesh.setColorAt` multiplies the vertex colour, and a blind critic called the
   * first pass *"untextured grey and tan planes"* — most of that is the absence of a texture,
   * which is not fixable here, but four identical silhouettes in identical colour made it
   * far worse than it needed to be.
   */
  private tint(mesh: THREE.InstancedMesh | undefined, n: number, id: number): void {
    if (!mesh) return;
    const v = hash01(id, 0x7016);
    TMP_C.setRGB(0.86 + v * 0.30, 0.88 + v * 0.24, 0.82 + v * 0.22);
    mesh.setColorAt(n, TMP_C);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private writeTowers(): void {
    let n = 0;
    for (const t of this.towers) {
      const h = Math.max(2, t.deckY - t.y);
      this.setInstance(this.mShaft, n, t.x, t.y, t.z, t.facing, 1, h, 1);
      this.setInstance(this.mDeck, n, t.x, t.deckY, t.z, t.facing);
      this.setInstance(this.mWheels, n, t.x, t.y, t.z, t.facing);
      // The ramp hinges at the deck's front lip. Stowed it stands straight up against
      // the front of the tower; landed it lies flat, reaching the parapet.
      const cos = Math.cos(t.facing);
      const sin = Math.sin(t.facing);
      const hx = t.x + TOWER_HALF_D * sin;
      const hz = t.z + TOWER_HALF_D * cos;
      this.setInstance(this.mRamp, n, hx, t.deckY, hz, t.facing, 1, 1, 1, this.rampPitch(t));
      this.tint(this.mShaft, n, t.id);
      this.tint(this.mDeck, n, t.id);
      this.tint(this.mRamp, n, t.id + 41);
      this.tint(this.mWheels, n, t.id + 17);
      n++;
    }
    for (const m of [this.mShaft, this.mDeck, this.mWheels, this.mRamp]) {
      if (!m) continue;
      m.count = n;
      m.visible = n > 0;
      if (n > 0) m.instanceMatrix.needsUpdate = true;
    }
  }

  private writeRams(): void {
    let n = 0;
    for (const r of this.rams) {
      this.setInstance(this.mShed, n, r.x, r.y, r.z, r.facing);
      const cos = Math.cos(r.facing);
      const sin = Math.sin(r.facing);
      /**
       * Where the trunk hangs.
       *
       * `buildRamTrunk` authors the baulk from its origin along **-Z** with the iron head
       * 7.15 m out, and `facing + PI` turns that to point forward, so the origin has to sit
       * that far *behind* where the head should be. The first version placed the origin
       * 5.4 m ahead of the shed instead, which put the head 12.5 m in front of it — through
       * the gate, out the other side and invisible in every frame of the machine.
       *
       * The head is wanted a metre proud of the shed's front, plus the recoil.
       */
      const headAt = RAM_HALF_D + 1.0 + r.swing;
      const originAt = headAt - RAM_TRUNK_REACH;
      this.setInstance(this.mTrunk, n,
        r.x + originAt * sin, r.y + RAM_SHED_H - 1.35, r.z + originAt * cos,
        r.facing + Math.PI);
      n++;
    }
    for (const m of [this.mShed, this.mTrunk]) {
      if (!m) continue;
      m.count = n;
      m.visible = n > 0;
      if (n > 0) m.instanceMatrix.needsUpdate = true;
    }
  }

  private writeLadders(): void {
    let n = 0;
    for (const l of this.ladders) {
      // The geometry runs up +Y, so a negative pitch tips its head toward -Z local, which is
      // the wall. Scaled by the *slant* length so the head arrives at the right height once
      // the lean has been applied, not the vertical rise.
      const rise = Math.max(1, l.headY - l.footY);
      this.setInstance(this.mLadder, n, l.x, l.footY, l.z, l.facing,
        1, rise / Math.cos(l.lean), 1, -l.lean);
      this.tint(this.mLadder, n, n * 7 + 3);
      n++;
    }
    if (this.mLadder) {
      this.mLadder.count = n;
      this.mLadder.visible = n > 0;
      if (n > 0) this.mLadder.instanceMatrix.needsUpdate = true;
    }
  }

  // -------------------------------------------------------------------------
  // Diagnostics — read by tools/probe-siege.mjs
  // -------------------------------------------------------------------------

  /** Everything the probe needs to know about where one man is actually standing. */
  probeMan(i: number): {
    surfaceY: number; terrainY: number; lateralOffset: number;
    insideMasonry: boolean; bay: number; station: number;
  } {
    const b = this.battle;
    const st = this.stationOf[i];
    const terrainY = b.groundAt(b.pool.x[i], b.pool.z[i]);
    if (st < 0) {
      return { surfaceY: b.support[i], terrainY, lateralOffset: 0, insideMasonry: false, bay: -1, station: -1 };
    }
    const dx = b.pool.x[i] - this.sx[st];
    const dz = b.pool.z[i] - this.sz[st];
    const off = dx * this.snx[st] + dz * this.snz[st];
    return {
      surfaceY: this.sy[st],
      terrainY,
      lateralOffset: off,
      // Inside the stonework means below the walking surface by more than a tolerance.
      insideMasonry: b.pool.y[i] < this.sy[st] - 0.05,
      bay: this.sBay[st],
      station: st,
    };
  }

  towerReport(): {
    id: number; state: string; dist: number; docked: boolean;
    rampY: number; walkY: number; crossed: number; queued: number;
    x: number; z: number; baseY: number; groundY: number; deckY: number;
    /** Horizontal gap between the tower's front face and the wall's outer face. */
    faceGap: number;
  }[] {
    const names = ['approach', 'docking', 'landing', 'boarding', 'spent'];
    return this.towers.map((t) => {
      const s = t.station;
      // Distance from the tower's front face to the bay centreline, less the half-thickness:
      // how far the ramp has to bridge, and negative if the machine is inside the masonry.
      const dx = t.x - this.sx[s];
      const dz = t.z - this.sz[s];
      const outward = dx * this.snx[s] + dz * this.snz[s];
      return {
        id: t.id,
        state: names[t.state],
        dist: t.dist,
        docked: t.state >= TowerState.Landing,
        rampY: this.rampHeadY(t),
        walkY: this.sy[s],
        crossed: t.crossed,
        queued: t.crossing ? t.crossing.queue.length : 0,
        x: t.x,
        z: t.z,
        baseY: t.y,
        groundY: this.battle.groundAt(t.x, t.z),
        deckY: t.deckY,
        faceGap: outward - TOWER_HALF_D - this.sFace[s],
      };
    });
  }

  engineReport(): {
    shots: number; hits: number; kills: number; ramBlows: number; gateHp: number;
    ladders: number; laddersCrossed: number;
    /** Per ladder: how far its head misses the wall face and the parapet, in metres. */
    ladderHeadMiss: { face: number; crest: number; leanDeg: number }[];
  } {
    return {
      shots: this.artilleryShots,
      hits: this.ensureProjectiles()?.masonryHits ?? 0,
      kills: this.artilleryKills,
      ramBlows: this.rams.reduce((a, r) => a + r.blows, 0),
      gateHp: Math.max(0, 1 - this.gateBlows / GATE_BLOWS),
      ladders: this.ladders.length,
      laddersCrossed: this.ladders.reduce((a, l) => a + l.crossed, 0),
      ladderHeadMiss: this.ladders.map((l) => {
        const st = l.station;
        const rise = Math.max(1, l.headY - l.footY);
        const run = Math.tan(l.lean) * rise;
        const dx = l.x - this.sx[st];
        const dz = l.z - this.sz[st];
        const footOff = dx * this.snx[st] + dz * this.snz[st];
        return {
          // Positive means the head stops short of the wall face; negative means it is
          // buried in the masonry.
          face: footOff - run - this.sFace[st],
          crest: l.footY + rise - (this.sy[st] + 0.9),
          leanDeg: (l.lean * 180) / Math.PI,
        };
      }),
    };
  }

  stats(): {
    stations: number; garrisoned: number; garrisonMen: number;
    towers: number; rams: number; ladders: number;
    crossing: number; gateBreached: boolean;
  } {
    const p = this.battle.pool;
    let men = 0;
    let crossing = 0;
    for (const [id] of this.garrisons) {
      const u = this.battle.unitById(id);
      if (!u) continue;
      for (const i of u.members) if (p.aliveAt(i) && this.stationOf[i] >= 0) men++;
    }
    for (const t of this.towers) crossing += t.crossing ? t.crossing.queue.length : 0;
    for (const l of this.ladders) crossing += l.crossing ? l.crossing.queue.length : 0;
    return {
      stations: this.nStations,
      garrisoned: this.garrisons.size,
      garrisonMen: men,
      towers: this.towers.length,
      rams: this.rams.length,
      ladders: this.ladders.length,
      crossing,
      gateBreached: this.gateBreached,
    };
  }

  /** Count a missile released from the wall-walk. Called by the projectile system. */
  noteWallShot(): void {
    this.wallShots++;
  }
  noteWallKill(): void {
    this.wallKills++;
  }
  noteArtillery(shots: number, kills: number): void {
    this.artilleryShots += shots;
    this.artilleryKills += kills;
  }

  dispose(): void {
    for (const m of [this.mShaft, this.mDeck, this.mWheels, this.mRamp, this.mShed,
      this.mTrunk, this.mLadder]) {
      m?.geometry.dispose();
      m?.dispose();
    }
    this.material?.dispose();
    this.root.removeFromParent();
  }
}
