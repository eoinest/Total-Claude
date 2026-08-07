import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from './BattleSystem';
import { SoldierState, UnitOrder } from './types';
import type { SoldierPool, UnitGroupState, UnitTypeDef, WeaponKind } from './types';
import { formation } from './formations';
import { clamp01, closestOnSegment } from '../util/math';
import { hash01 } from '../util/rand';
import type { Rng } from '../util/rand';
import {
  ARMOUR_BITE, armourReduction, modsOf, shieldCoverage, signalsOf,
} from './combatShared';
import {
  CREW_OF, EngineKind, MUZZLE_OF, engineAnchor, engineCountOf, engineKindOf, engineReadyAt,
  isEngineUnit, type EngineSite,
} from '../units/engines';

/**
 * Missiles: real ballistics, ragged volleys, and arrows you can see stuck in the turf
 * afterwards.
 *
 * Trajectories are integrated with gravity and quadratic drag from a pooled set of
 * typed arrays — never an object per arrow, because a single archer unit puts a
 * hundred in the air at once and an arrow storm several times that.
 *
 * Launch is solved for the target's *predicted* position. `arc: 'high'` (bows, slings)
 * lofts at a fixed pleasing elevation and varies draw weight, which is what real
 * archers do and what makes the trajectory read as an arc rather than a laser.
 * `arc: 'flat'` (pila, javelins, bolts) takes the low ballistic root at full power.
 *
 * Two things that matter more than they sound:
 *   - **Misses must land plausibly.** Scatter grows with range, movement and fatigue,
 *     and every miss buries itself in the ground where it fell. A field stubbled with
 *     spent arrows and pila is one of Rome II's signatures.
 *   - **Flat trajectories cannot pass through your own men.** Only the men with a
 *     clear lane throw. Arrows lofted over the front rank mostly clear it, so they
 *     only check the man immediately ahead.
 */

// ---------------------------------------------------------------------------
// Physical parameters per weapon
// ---------------------------------------------------------------------------

/**
 * Which mesh draws a missile.
 *
 * There used to be exactly one — a fletched arrow — and every kind was instanced from it with
 * only its length scaled. A 26 kg onager stone was therefore drawn as a 0.44 m arrow, a lead
 * sling bullet as a 0.10 m arrow, and a ballista bolt as a short arrow of an archer's own
 * thickness. That is the whole of the "the scorpions and catapults shoot a volley of arrows"
 * report as far as the *geometry* goes; the other half is in the emitter, see `fireBattery`.
 *
 * Three classes rather than one per kind, because a draw call per weapon is not worth it and
 * the within-class differences (an arrow against a pilum) are honestly carried by girth and
 * tint, while the between-class ones (a shaft against a stone) are not carried by anything.
 */
const enum Visual {
  /** A fletched shaft: arrow, javelin, framea, pilum. */
  Shaft = 0,
  /** A ballista bolt: short, thick, square-sectioned, with a long iron head and stiff vanes. */
  Bolt = 1,
  /** A stone or a sling bullet: no shaft, no head, no fletching, and it tumbles. */
  Stone = 2,
}

const VISUAL_NAME = ['shaft', 'bolt', 'stone'] as const;
const VISUAL_COUNT = 3;

interface MissilePhysics {
  /** Muzzle / release speed in metres per second at full power. */
  speed: number;
  /** Quadratic drag coefficient, 1/m: a = -k·|v|·v. */
  drag: number;
  /** Shaft length in metres — or, for `Visual.Stone`, the stone's diameter. */
  length: number;
  /**
   * Range compensation. The launch solve is drag-free, so we aim past the target by
   * this fraction per metre; tuned so the mean impact lands on the target at range.
   */
  dragComp: number;
  event: 'pilum' | 'arrow' | 'javelin' | 'sling' | 'bolt';
  /** Which mesh draws it. */
  visual: Visual;
  /**
   * Radial multiplier on the shaft geometry, which is authored at an arrow's 13.5 mm. A pilum's
   * shaft is a man's thumb and a javelin's is close behind it; drawing all of them at an
   * arrow's thickness is the second reason a pilum volley and an arrow volley looked identical.
   * Ignored by `Visual.Stone`, which is sized by `length` alone.
   */
  girth: number;
  /** Per-instance tint over the geometry's own vertex colours, so one mesh serves four kinds. */
  tint: number;
  /**
   * Radius in metres over which the impact hurts men other than the one struck, 0 for none.
   *
   * A 26 kg stone arriving at 50 m/s carries about 33 kJ, which is roughly a rifle round times
   * forty, and it does not stop at the first man: Josephus (BJ V.6.3) has a single stone from
   * a Roman engine carry off several men at once, and Ammianus XXIII.4.5 says the same. A
   * one-man hit test is why an onager measured 334 shots for about one kill.
   */
  blast: number;
  /**
   * Fraction of a blocked shot that still hurts the man behind the shield.
   *
   * An arrow that hits a scutum is in the scutum and that is the end of it, so 0 is right for
   * everything with a point. A sling bullet is the exception the weapon is famous for: it is a
   * 50 g lead ovoid arriving at 50 m/s with no penetrating geometry at all, so what it delivers
   * is impulse, and plywood and hide transmit impulse. Xenophon (Anabasis III.3) has Rhodian
   * slingers driving off shielded Persian cavalry that archers could not touch, and Livy has
   * Balearic shot breaking limbs through cover.
   *
   * Measured, this is the difference between a unit that does literally nothing and one that
   * works: against a legionary cohort the scutum was stopping 87% of every volley outright.
   */
  shieldBypass: number;
  /**
   * How many further men the missile can pass through after killing one.
   *
   * The scorpio's own roster line is "a single shot punches through a shield, the man behind
   * it, and the man behind him", and until now it stopped at the first man like an arrow. A
   * three-span bolt leaves at 78 m/s and arrives at nearly 60; Caesar (BG VII.82) has one pin a
   * man to the ground through his shield, and Procopius (Wars I.21) describes one carrying a
   * man off his horse and pinning him to a tree. Over-penetration is the whole reason a
   * bolt-thrower is worth its crew against a formed line rather than a skirmish screen.
   */
  pierce: number;
}

const PHYSICS: Record<string, MissilePhysics> = {
  bow: {
    speed: 55, drag: 0.0026, length: 0.72, dragComp: 0.0016, event: 'arrow',
    visual: Visual.Shaft, girth: 1, tint: 0xf4ecd8, blast: 0, shieldBypass: 0, pierce: 0,
  },
  // 50 m/s, up from 32, and the change is a bug fix rather than a buff — see `maxRange`. At 32
  // the physical ceiling was 104 m against a roster range of 180, so a Balearic slinger firing
  // at anything past about 110 m was throwing stones into empty grass and could not be told.
  // 50 m/s with a lead glans is at the top of what a slinger achieves but it is inside it;
  // the distance records the weapon is famous for need more than this, not less.
  sling: {
    speed: 50, drag: 0.0020, length: 0.055, dragComp: 0.0012, event: 'sling',
    visual: Visual.Stone, girth: 1, tint: 0x9a978f, blast: 0, shieldBypass: 0.45, pierce: 0,
  },
  javelin: {
    speed: 24, drag: 0.0013, length: 1.55, dragComp: 0.0007, event: 'javelin',
    visual: Visual.Shaft, girth: 1.5, tint: 0xd9bb8a, blast: 0, shieldBypass: 0, pierce: 0,
  },
  framea: {
    speed: 23, drag: 0.0014, length: 1.45, dragComp: 0.0007, event: 'javelin',
    visual: Visual.Shaft, girth: 1.45, tint: 0xbfa478, blast: 0, shieldBypass: 0, pierce: 0,
  },
  // Cool grey: most of a pilum's length is the iron shank, and that is what the silhouette
  // should read as. Volleyed against the sky it is the one missile that is not wood-coloured.
  pilum: {
    speed: 21, drag: 0.0011, length: 1.95, dragComp: 0.0004, event: 'pilum',
    visual: Visual.Shaft, girth: 1.7, tint: 0xa9abb1, blast: 0, shieldBypass: 0, pierce: 0,
  },
  bolt: {
    speed: 78, drag: 0.0011, length: 0.62, dragComp: 0.0009, event: 'bolt',
    visual: Visual.Bolt, girth: 1, tint: 0xffffff, blast: 0, shieldBypass: 0, pierce: 2,
  },
  // A one-talent onager stone is about 26 kg, which at tufa's density is a ball 0.30 m across;
  // 0.34 is the top of the class and the smallest that reads at the range these are shot from.
  //
  // 52 m/s, up from 46. The old figure could not reach the unit's own 220 m at any elevation —
  // 46 m/s tops out at 215 m in vacuum and the solve gave up and fired at 45 degrees, so the
  // stones fell short and the shortfall was invisible. Very low drag for its speed because the
  // ballistic coefficient of a rounded 26 kg ball is enormous next to an arrow's.
  boulder: {
    speed: 52, drag: 0.00022, length: 0.34, dragComp: 0.0003, event: 'sling',
    visual: Visual.Stone, girth: 1, tint: 0xffffff, blast: 2.4, shieldBypass: 0, pierce: 0,
  },
};

const physicsOf = (kind: WeaponKind): MissilePhysics => PHYSICS[kind] ?? PHYSICS.javelin;

/**
 * Weapons the roster throws on `arc: 'high'`, for the friendly-fire census only.
 *
 * Every one of the roster's nine missile lines agrees with this and the arc that is actually
 * flown still comes from `m.arc`, so a divergence here mislabels a census row and nothing else.
 */
const LOFTED_KINDS: ReadonlySet<string> = new Set(['bow', 'sling', 'boulder']);

const GRAVITY = 9.81;
/** Elevation a lofted shot is fired at, in radians (34 degrees). */
const LOFT = 0.6;

/**
 * The furthest a weapon can actually throw, in metres, drag-free and over level ground.
 *
 * This exists because `PHYSICS.speed` and `missile.range` were independent numbers that nobody
 * had ever compared, and for both `arc: 'high'` weapons they disagreed badly: a sling could
 * reach 104 m and claimed 180, an onager 215 m and claimed 220. The launch solve's response to
 * an unreachable target is to fall through to `lowRoot`, whose discriminant is negative, which
 * returns a flat 45 degrees — so the shot leaves at full power on the maximum-range elevation
 * and lands as far short as the numbers disagree, every time, silently.
 *
 * A lofted weapon is held to the 45-degree maximum rather than to `LOFT`'s 34, because the
 * solve legitimately steepens toward 45 as it runs out of reach.
 */
export const maxRange = (kind: WeaponKind): number => {
  const p = physicsOf(kind);
  // d_compensated = d(1 + c·d) is what the solve actually has to satisfy, so invert it to get
  // the true ground distance the weapon covers.
  const dComp = (p.speed * p.speed) / GRAVITY;
  const c = p.dragComp;
  return c > 0 ? (Math.sqrt(1 + 4 * c * dComp) - 1) / (2 * c) : dComp;
};
/** Soldier torso radius for a projectile intersection, metres. */
const HIT_RADIUS = 0.4;

/**
 * Rank buckets for the garrison-shot census: five wall ranks plus one for everything else.
 * `MAX_WALL_RANKS` is 5 in `Siege.ts`; a man with no rank lands in the last bucket.
 */
const WALL_DIAG_RANKS = 6;

/**
 * Distance-from-release bands for the friendly-fire census, metres. See `ffDist`.
 *
 * Chosen against the two lengths that matter and not round-numbered for its own sake: 0.86 m
 * is a file's lateral spacing and roughly a rank's depth on open ground, 0.72 m is a rank on
 * a wall-walk, and 4.7 m is how far a ballista bolt travels in `ARM_TIME`. The last band is
 * open-ended and holds the shots that are nobody's fault.
 */
const FF_BAND_M = [0.9, 1.8, 2.7, 3.6, 4.7, 7, 12] as const;
/** Flight-time bands, seconds, over the same hits. `ARM_TIME` is the first edge. */
const FF_BAND_S = [0.06, 0.12, 0.2, 0.35, 0.6, 1.0, 2.0] as const;
const FF_BINS = FF_BAND_M.length + 1;
const ffBand = (v: number, edges: readonly number[]): number => {
  for (let k = 0; k < edges.length; k++) if (v < edges[k]) return k;
  return edges.length;
};

/**
 * Where a shot leaves a man, above his feet. Shoulder height on a 1.75 m soldier.
 *
 * Named because it is load-bearing twice over: on the flat it is only the origin of an arrow,
 * but on a battlement it is 0.60 m *below* the top of the merlon in front of him, and that
 * difference is the whole of the player's report.
 */
const SHOULDER = 1.45;

/**
 * One gap in a battlement, as `CitySystem.embrasureAt` publishes it.
 *
 * A structural mirror, not an import: `src/sim/` does not depend on `src/city/`. Kept
 * deliberately narrow — the fields a launch solve needs and nothing else.
 */
interface EmbrasureView {
  x: number;
  z: number;
  nx: number;
  nz: number;
  walkY: number;
  sillY: number;
  crestY: number;
  parapetInner: number;
  parapetOuter: number;
  halfThickness: number;
  hasParapet: boolean;
}

/**
 * How far back from the parapet a man can still step into the gap beside him.
 *
 * The front rank stands `BODY` = 0.42 m inboard of the parapet's inner face (`wall.ts`), the
 * next rank 0.72 m behind that (`WALL_RANK_PITCH` in `Siege.ts`). 0.75 m therefore admits the
 * front rank and nobody else, which is the intent: a man at the battlement leans into the
 * embrasure, and a man with another man's back in front of him cannot.
 */
const EMBRASURE_REACH = 0.75;

/** How far inside the parapet's outer face he looses from, once he is in the gap. */
const EMBRASURE_INSET = 0.1;

/** Clearance over the crenel sill for a shot leaving the gap. */
const SILL_CLEAR = 0.3;

/** Clearance over the merlon's inner top edge for a shot lobbed from a rear rank. */
const MERLON_CLEAR = 0.2;

/** Clearance over the outer lip of the wall-walk for a shot depressed off a parapet-less bay. */
const WALK_CLEAR = 0.1;

/**
 * How far a man's feet may be from a bay's walkway and still count as standing on it.
 *
 * The guard that keeps this off everything else `elevated` covers — a boarding ramp, a siege
 * tower's fighting top, a ladder, a tower chamber a storey above the walk. `bayAt` indexes
 * arithmetically in x and will happily name a bay for a man who is nowhere near it.
 */
const ON_WALK_TOL = 0.6;

/** Scratch for `aimOverParapet`, in the module-global style the hash visitors use. */
let PARAPET_X = 0;
let PARAPET_Y = 0;
let PARAPET_Z = 0;
/** Lowest elevation that clears the man's own battlement; `-Infinity` when nothing is in the way. */
let PARAPET_PITCH = -Infinity;
/** Whether the release point was moved into an embrasure. Diagnostic only. */
let PARAPET_STEPPED = false;

/**
 * A shot that dies on masonry sooner than this came down on the wall it was fired from.
 *
 * A parapet is 0.9 m thick and an arrow leaves at 20-60 m/s, so a shot that clears its own
 * battlement is 20 m away inside half a second; anything that reports stone before then hit
 * the merlon in front of the man who loosed it.
 */
const SELF_WALL_T = 0.5;
/** Top of the hittable volume above a man's feet. */
const HIT_TOP = 1.85;
/** Seconds of flight before a projectile can hit anyone, so nobody shoots himself. */
const ARM_TIME = 0.06;

const MAX_PROJECTILES = 2600;
const MAX_STUCK = 1400;
/** Of those, how many may be tracking a shield rather than planted in the ground. */
const MAX_ATTACHED = 260;

const enum Phase {
  Idle = 0,
  Aiming = 1,
  Releasing = 2,
  Reloading = 3,
}

/** Seconds spent drawing / winding up before a volley leaves. */
const AIM_TIME = 0.55;
/** Width of a normal ragged volley's release window, seconds. */
const RAGGED_WINDOW = 0.8;
/** Width of a commanded volley's release window. */
const TIGHT_WINDOW = 0.16;

// ---------------------------------------------------------------------------
// Module-scope scratch for the hash callbacks.
// ---------------------------------------------------------------------------

let POOL: SoldierPool | null = null;

/** Line-of-fire probe: is one of our own men standing in the lane? */
let LOS_X = 0;
let LOS_Z = 0;
let LOS_Y = 0;
let LOS_FACTION = 0;
let LOS_SELF = -1;
let LOS_BLOCKED = false;

const losVisit = (j: number): void => {
  if (LOS_BLOCKED) return;
  const p = POOL!;
  if (j === LOS_SELF) return;
  if (p.faction[j] !== LOS_FACTION) return;
  const st = p.state[j];
  if (st === SoldierState.Dead || st === SoldierState.Dying) return;
  const dx = p.x[j] - LOS_X;
  const dz = p.z[j] - LOS_Z;
  if (dx * dx + dz * dz > 0.34) return;
  // Only a man tall enough to be in the way actually blocks the lane.
  if (LOS_Y < p.y[j] + 0.3 || LOS_Y > p.y[j] + HIT_TOP) return;
  LOS_BLOCKED = true;
};

/** Flight collision: earliest soldier along this tick's flight segment. */
let SEG_X0 = 0;
let SEG_Z0 = 0;
let SEG_Y0 = 0;
let SEG_X1 = 0;
let SEG_Z1 = 0;
let SEG_Y1 = 0;
let SEG_BEST_T = 2;
let SEG_BEST = -1;
/** A man this shot has already passed through, so an over-penetrating bolt cannot re-hit him. */
let SEG_SKIP = -1;

const segmentVisit = (j: number): void => {
  if (j === SEG_SKIP) return;
  const p = POOL!;
  const st = p.state[j];
  if (st === SoldierState.Dead || st === SoldierState.Dying) return;
  const t = closestOnSegment(p.x[j], p.z[j], SEG_X0, SEG_Z0, SEG_X1, SEG_Z1);
  if (t >= SEG_BEST_T) return;
  const cx = SEG_X0 + (SEG_X1 - SEG_X0) * t;
  const cz = SEG_Z0 + (SEG_Z1 - SEG_Z0) * t;
  const dx = cx - p.x[j];
  const dz = cz - p.z[j];
  if (dx * dx + dz * dz > HIT_RADIUS * HIT_RADIUS) return;
  const cy = SEG_Y0 + (SEG_Y1 - SEG_Y0) * t;
  const foot = p.y[j];
  if (cy < foot - 0.05 || cy > foot + HIT_TOP) return;
  SEG_BEST_T = t;
  SEG_BEST = j;
};

// ---------------------------------------------------------------------------

/**
 * Blast gather: everyone standing near where a stone came down.
 *
 * Collected first and damaged after, because `BattleSystem.damage` can kill a man and a kill
 * mutates the structures the spatial hash query is walking.
 */
let BLAST_X = 0;
let BLAST_Y = 0;
let BLAST_Z = 0;
let BLAST_R2 = 0;
let BLAST_SKIP = -1;
let BLAST_N = 0;
const BLAST_MAX = 48;
const BLAST_HIT = new Int32Array(BLAST_MAX);

const blastVisit = (j: number): void => {
  if (BLAST_N >= BLAST_MAX || j === BLAST_SKIP) return;
  const p = POOL!;
  const st = p.state[j];
  if (st === SoldierState.Dead || st === SoldierState.Dying) return;
  const dx = p.x[j] - BLAST_X;
  const dz = p.z[j] - BLAST_Z;
  // Vertical too: a stone that comes down in the ditch does not hurt the wall-walk above it.
  const dy = p.y[j] + 0.9 - BLAST_Y;
  if (dx * dx + dz * dz + dy * dy > BLAST_R2) return;
  BLAST_HIT[BLAST_N++] = j;
};

/**
 * A flat-shaded triangle soup builder, shared by the three projectile geometries.
 *
 * Flat rather than smooth throughout: everything here is a faceted object at a few centimetres
 * and a per-face normal is both cheaper and more legible at the range these are seen from.
 */
const triBuffer = (): {
  pos: number[]; nrm: number[]; col: number[]; idx: number[];
  pushTri(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number, r: number, g: number, bl: number
  ): void;
} => {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const pushTri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    r: number, g: number, bl: number
  ): void => {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx2 = cx - ax, vy2 = cy - ay, vz2 = cz - az;
    let nx = uy * vz2 - uz * vy2;
    let ny = uz * vx2 - ux * vz2;
    let nz = ux * vy2 - uy * vx2;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const base = pos.length / 3;
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let k = 0; k < 3; k++) {
      nrm.push(nx, ny, nz);
      col.push(r, g, bl);
    }
    idx.push(base, base + 1, base + 2);
  };
  return { pos, nrm, col, idx, pushTri };
};

const finishGeometry = (
  pos: number[], nrm: number[], col: number[], idx: number[]
): THREE.BufferGeometry => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
};

const tmpMat = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3(1, 1, 1);
const tmpDir = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** One battery's firing state, one entry per machine. See `ProjectileSystem.batteries`. */
interface FiringBattery {
  kind: EngineKind;
  crew: number;
  count: number;
  /** Seconds since machine k released. */
  sinceShot: Float32Array;
  /** Enemy unit this machine is laid on, or -1. Re-solved once a cycle, not once a tick. */
  target: Int32Array;
  /**
   * Ranging: which target the correction belongs to, how many consecutive shots have gone onto
   * it, and where it was when this machine last fired.
   *
   * A gun crew does not shoot its whole allowance at the opening elevation. It fires, watches
   * the fall of shot and corrects — Ammianus XXIII.4 describes exactly that — which is why a
   * battery that has been engaging one block for a minute is dangerous and one that has just
   * been re-laid is not. Modelled as a shrinking spread rather than as a bias correction,
   * because scatter is what a bracket actually removes.
   *
   * It is also the honest answer to a measurement: an onager at 180 m with `accuracy: 0.045`
   * scatters with a standard deviation of about 12 m, and a 2.4 m blast inside a 12 m scatter
   * almost never lands on the formation. Tightening the roster constant instead would have made
   * the first shot as accurate as the fourth, which is the wrong shape for the fix.
   */
  rangedOn: Int32Array;
  onTarget: Int32Array;
  lastAimX: Float32Array;
  lastAimZ: Float32Array;
}

export class ProjectileSystem implements Subsystem {
  readonly name = 'projectiles';
  readonly order = 25;

  private battle!: BattleSystem;
  private ctx!: EngineContext;
  private rng!: Rng;
  /**
   * A separate forked stream for the engines.
   *
   * A battery fires on its own clock, not inside the volley window, so its draws would
   * otherwise interleave with the infantry's in an order that depends on how many machines
   * happened to be ready on a given tick. Forked, both streams stay reproducible on their own.
   */
  private artRng!: Rng;
  /**
   * The city, if there is one, for the masonry collision test. Duck-typed and optional so
   * a battle on open ground — and every unit test — needs no city at all.
   */
  private city: { masonryTopAt(x: number, z: number): number } | null = null;
  /**
   * The battlement, if the city publishes one, for placing a garrison's shots.
   *
   * A structural view rather than an import: `src/sim/` does not depend on `src/city/`, which
   * is what lets a second city be built in parallel with the simulation that fights over it.
   * Kept separate from `city` above, and duck-typed on its own, so a tree whose `CitySystem`
   * predates `embrasureAt` still collides against masonry correctly and merely loses the
   * placement — a missing method here must not take the wall's collision with it.
   */
  private wall: { embrasureAt(x: number, z: number): EmbrasureView | null } | null = null;

  // ---- projectile pool (structure of arrays) ----
  private px = new Float32Array(MAX_PROJECTILES);
  private py = new Float32Array(MAX_PROJECTILES);
  private pz = new Float32Array(MAX_PROJECTILES);
  /** Position at the start of this tick, for the swept collision test and interpolation. */
  private ox = new Float32Array(MAX_PROJECTILES);
  private oy = new Float32Array(MAX_PROJECTILES);
  private oz = new Float32Array(MAX_PROJECTILES);
  private vx = new Float32Array(MAX_PROJECTILES);
  private vy = new Float32Array(MAX_PROJECTILES);
  private vz = new Float32Array(MAX_PROJECTILES);
  private life = new Float32Array(MAX_PROJECTILES);
  private dmg = new Float32Array(MAX_PROJECTILES);
  private apDmg = new Float32Array(MAX_PROJECTILES);
  private drag = new Float32Array(MAX_PROJECTILES);
  private len = new Float32Array(MAX_PROJECTILES);
  private kindIdx = new Uint8Array(MAX_PROJECTILES);
  private ownerUnit = new Int32Array(MAX_PROJECTILES);
  /**
   * The point the launch solve was aimed at. Carried so a landing can be scored against its
   * own intent: "the slingers do no damage" has two completely different causes — the stones
   * land on the enemy and are stopped, or they never get there — and the distance between
   * this and the impact separates them in one number.
   */
  private aimX = new Float32Array(MAX_PROJECTILES);
  private aimZ = new Float32Array(MAX_PROJECTILES);
  /** Men this shot may still pass through, and the last one it struck. */
  private pierceLeft = new Uint8Array(MAX_PROJECTILES);
  private lastHit = new Int32Array(MAX_PROJECTILES);
  /**
   * 1 when the man who loosed this was standing on a structure rather than the ground.
   *
   * Carried on the projectile because the shooter's index is not kept and he may be dead
   * by the time it lands. It is the only honest way to answer "did the garrison kill
   * anybody", which is the assertion the siege probe is built around.
   */
  private fromWall = new Uint8Array(MAX_PROJECTILES);
  private alive = new Uint8Array(MAX_PROJECTILES);
  private freeList = new Int32Array(MAX_PROJECTILES);
  private freeCount = 0;
  private highWater = 0;
  private liveCount = 0;

  /** Distinct missile kinds, so a projectile can carry a one-byte kind index. */
  private kinds: WeaponKind[] = [];

  /**
   * Per-kind census, for `tools/probe-artillery.mjs`.
   *
   * "The scorpions shoot arrows" is a claim about what is *drawn*, and eyeballing a frame
   * cannot separate "the wrong geometry was chosen" from "the wrong weapon was fired". These
   * counters are indexed by the same `kindIdx` the renderer routes on, so a census of them
   * against a census of instances per mesh answers both halves separately.
   *
   * Simulation-visible only in that it counts; nothing reads these back into the sim, so they
   * cannot perturb the hash.
   */
  private cLaunched = new Int32Array(32);
  private cHitMan = new Int32Array(32);
  private cBlocked = new Int32Array(32);
  private cKilled = new Int32Array(32);
  private cGround = new Int32Array(32);
  private cMasonry = new Int32Array(32);
  private cDamage = new Float64Array(32);
  /** Summed metres between where a shot came down and the man it was solved for. */
  private cMiss = new Float64Array(32);
  private cMissN = new Int32Array(32);
  /** Shots the launch solve refused because the target was beyond the weapon's real reach. */
  private cUnreachable = new Int32Array(32);

  /**
   * Where a *garrison's own* shots end up, bucketed by the shooter's rank on the walkway.
   *
   * The player's report is that men on the parapet "cannot throw spears or shoot over the
   * edge — it gets stuck on the little pieces of cover facing the enemies", and none of the
   * census above can distinguish that from a weapon that is simply out of range: both come
   * out as "not many kills". These buckets answer the only question that matters, which is
   * *what the shot hit*, and they answer it per rank, because a man at the parapet and a man
   * two ranks behind him have completely different geometry to solve.
   *
   * Diagnostic only. Nothing reads these back into the sim, so they cannot move the hash.
   */
  private wRank = new Int8Array(MAX_PROJECTILES);
  /** Absolute Y of the walkway under the shooter, so an impact can be placed on the section. */
  private wFootY = new Float32Array(MAX_PROJECTILES);
  private wLaunched = new Int32Array(WALL_DIAG_RANKS);
  private wHitMan = new Int32Array(WALL_DIAG_RANKS);
  private wKilled = new Int32Array(WALL_DIAG_RANKS);
  private wGround = new Int32Array(WALL_DIAG_RANKS);
  /** Struck masonry standing at merlon height — his own battlement. */
  private wCrest = new Int32Array(WALL_DIAG_RANKS);
  /** Struck the crenel sill, i.e. he was at an embrasure and shot too low through it. */
  private wSill = new Int32Array(WALL_DIAG_RANKS);
  /** Struck the walking surface itself. */
  private wWalk = new Int32Array(WALL_DIAG_RANKS);
  /** Struck masonry below the walk — the curtain face, a tower, an outwork. */
  private wBelow = new Int32Array(WALL_DIAG_RANKS);
  /** Struck masonry more than `SELF_WALL_T` after release, so not the wall he stood on. */
  private wFarMasonry = new Int32Array(WALL_DIAG_RANKS);
  /** Summed seconds of flight for shots that died on their own wall — a sanity check. */
  private wSelfLife = new Float64Array(WALL_DIAG_RANKS);
  /** Garrison shots `aimOverParapet` moved into an embrasure. */
  private wStepped = new Int32Array(WALL_DIAG_RANKS);
  /** Garrison shots it gave a minimum elevation to instead. */
  private wFloored = new Int32Array(WALL_DIAG_RANKS);
  /** Summed metres from the release point to a shot's death on its own wall. */
  private wSelfRange = new Float64Array(WALL_DIAG_RANKS);
  /** Summed normal-offset from the wall centreline where a self-wall death happened. */
  private wSelfOff = new Float64Array(WALL_DIAG_RANKS);
  /** Summed height over the shooter's walkway where a self-wall death happened. */
  private wSelfUp = new Float64Array(WALL_DIAG_RANKS);
  /** Summed |along-run| metres from the release point to a self-wall death. */
  private wSelfRun = new Float64Array(WALL_DIAG_RANKS);
  /** Self-wall deaths on masonry that publishes no battlement — the gatehouse block, mostly. */
  private wSelfNoBay = new Int32Array(WALL_DIAG_RANKS);
  /**
   * Friendly fire, separated by *where along its own flight* a shot found one of its own.
   *
   * Three different faults produce a friendly casualty and they need three different fixes, so
   * a single "friendly hits" total is useless. What tells them apart is the distance from the
   * release point, because each fault owns a band of it:
   *
   *   - **inside the arming window** — the shot became live inside the file it was loosed
   *     from. `ARM_TIME` is a *time*, and 0.06 s is 1.3 m for a pilum and 4.7 m for a bolt,
   *     so the window is a different size for every weapon and for two of them it is deeper
   *     than the formation.
   *   - **inside the shooter's own block but past arming** — the lane test should have
   *     refused the shot and did not. That is either no test at all (lofted fire probes once,
   *     at 1.5 m) or the stepping hole: probes at 1.5 m over ranks 0.86 m apart.
   *   - **beyond it** — a genuinely stray shot. Scatter, a friendly unit crossing the lane
   *     after release, an arcing volley falling on the wrong block. This one is *supposed* to
   *     happen and must not be engineered away.
   *
   * The bands are recorded as a histogram rather than as three counters so the thresholds can
   * be argued about afterwards without re-running the battle, and split by arc because the
   * lofted and flat lane tests are different code with different holes.
   */
  private ffDist = new Int32Array(2 * FF_BINS);
  private ffTime = new Int32Array(2 * FF_BINS);
  /** Of those, the ones that killed. */
  private ffKillDist = new Int32Array(2 * FF_BINS);
  /** Every hit, friend or foe, in the same bands — the denominator the histogram needs. */
  private ffAllDist = new Int32Array(2 * FF_BINS);
  /** Friendly hits and kills per weapon kind, so `cHitMan` can be split into enemy and own. */
  private ffHitKind = new Int32Array(32);
  private ffKillKind = new Int32Array(32);
  /**
   * Was the man hit in the shooter's own unit, and was he standing in front of him?
   *
   * A hit on one's own unit is a lane fault; a hit on the unit next door is a crossfire fault,
   * and no line-of-fire test a man could plausibly run would catch it. `ahead` is the subset
   * where the victim's rank is lower than the shooter's — the literal "shot through my own
   * front rank" case, which is the one the brief names.
   */
  private ffSameUnit = new Int32Array(3);
  /** Friendly hits, kills and blast casualties from a shot loosed off a wall. */
  private ffWall = new Int32Array(2);
  /** Blast: a stone does not ask whose men are standing round where it came down. */
  private ffBlast = new Int32Array(2);
  private allBlast = new Int32Array(2);
  /** Enemy hits and kills, so the report does not have to subtract two arrays to get them. */
  private ffEnemy = new Int32Array(2);
  /** Denominator for the three means above. */
  private wSelfOn = new Int32Array(WALL_DIAG_RANKS);
  /**
   * Where each shot left from, and the rank of the man who loosed it.
   *
   * Carried on the projectile because the shooter's index is not kept and he may well be dead
   * before it lands. Every friendly-fire question — did it arm inside its own file, did it go
   * through the rank in front — is a question about the distance from *here*, so nothing that
   * re-derives the release point from the owning unit's centre can answer it.
   */
  private srcX = new Float32Array(MAX_PROJECTILES);
  private srcY = new Float32Array(MAX_PROJECTILES);
  private srcZ = new Float32Array(MAX_PROJECTILES);
  private srcRank = new Int8Array(MAX_PROJECTILES);
  /**
   * Why `aimOverParapet` left a garrison shot alone: no battlement published here, his feet
   * are not on this walk, he is shooting inward, he is outboard of the parapet, or the crest
   * is already below his shoulder. A rank that fires into its own stone while reporting none
   * of these is a rank the fix reached and failed on, which is a different bug.
   */
  private wSkip = new Int32Array(8);
  /** Garrison shots that struck a man of the shooter's own faction. */
  private wFriendly = new Int32Array(WALL_DIAG_RANKS);

  // ---- spent projectiles ----
  private sx = new Float32Array(MAX_STUCK);
  private sy = new Float32Array(MAX_STUCK);
  private sz = new Float32Array(MAX_STUCK);
  /** Frozen direction of travel, normalised. */
  private sdx = new Float32Array(MAX_STUCK);
  private sdy = new Float32Array(MAX_STUCK);
  private sdz = new Float32Array(MAX_STUCK);
  private slen = new Float32Array(MAX_STUCK);
  /** Soldier this one is stuck in, or -1 for planted in the ground. */
  /**
   * Which mesh draws it, how thick, and what tint — the spent ring outlives the projectile that
   * made it, so its appearance has to be copied out of the kind rather than looked up from it.
   */
  private sVis = new Uint8Array(MAX_STUCK);
  private sGirth = new Float32Array(MAX_STUCK);
  private sTintR = new Float32Array(MAX_STUCK);
  private sTintG = new Float32Array(MAX_STUCK);
  private sTintB = new Float32Array(MAX_STUCK);
  private sAttach = new Int32Array(MAX_STUCK);
  /** Offset from the soldier's origin, in his local frame. */
  private sOffX = new Float32Array(MAX_STUCK);
  private sOffY = new Float32Array(MAX_STUCK);
  private sOffZ = new Float32Array(MAX_STUCK);
  private stuckCount = 0;
  private stuckCursor = 0;
  private attachedCount = 0;

  // ---- per-unit volley state, indexed by unit id ----
  private phase = new Uint8Array(0);
  private timer = new Float32Array(0);
  private targetUnit = new Int32Array(0);
  private window = new Float32Array(0);
  private reload = new Float32Array(0);
  private serial = new Int32Array(0);
  /** Volley serial a soldier last fired in. */
  private firedSerial = new Int32Array(0);
  private nextSerial = 1;

  // ---- rendering ----
  /** Flight and spent instanced meshes, one pair per `Visual`. */
  private flightMesh: (THREE.InstancedMesh | undefined)[] = [];
  private stuckMesh: (THREE.InstancedMesh | undefined)[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private material?: THREE.Material;
  /** Per-kind-index lookups, so the render loop reads one array rather than a hash. */
  private kindVisual = new Uint8Array(32);
  private kindGirth = new Float32Array(32);
  private kindTint = new Float32Array(32 * 3);
  /**
   * 1 for a weapon the roster throws on `arc: 'high'`. Census only.
   *
   * A mirror of the roster rather than a read of it, because a projectile in flight no longer
   * knows which `UnitTypeDef` threw it — and the lofted and flat lane tests are different
   * code with different holes, so a friendly-fire figure that pools them says nothing.
   */
  private kindLofted = new Uint8Array(32);

  lastCostMs = 0;

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.battle = ctx.get<BattleSystem>('battle');
    this.rng = this.battle.rng.fork('projectiles');
    this.artRng = this.battle.rng.fork('artillery');
    POOL = this.battle.pool;
    const city = ctx.tryGet('city') as unknown as { masonryTopAt?: (x: number, z: number) => number } | undefined;
    this.city = city && typeof city.masonryTopAt === 'function'
      ? (city as { masonryTopAt(x: number, z: number): number })
      : null;
    const battlement = city as unknown as
      { embrasureAt?: (x: number, z: number) => EmbrasureView | null } | undefined;
    this.wall = battlement && typeof battlement.embrasureAt === 'function'
      ? (battlement as { embrasureAt(x: number, z: number): EmbrasureView | null })
      : null;
    const b = this.battle;
    const masonry = this.city;
    this.site = masonry
      ? {
        groundAt: (x, z) => b.groundAt(x, z),
        masonryTopAt: (x, z) => masonry.masonryTopAt(x, z),
      }
      : { groundAt: (x, z) => b.groundAt(x, z) };

    // Register every kind up front rather than on first shot. A projectile's one-byte kind
    // index then depends only on this table's declaration order, not on which unit happened to
    // loose first — which is one fewer thing for a replay to disagree about, and it means the
    // census can be read before a battle has started.
    for (const kind of Object.keys(PHYSICS)) this.kindIndexOf(kind as WeaponKind);

    this.firedSerial = new Int32Array(this.battle.pool.capacity);
    this.growUnits(64);
    for (let i = MAX_PROJECTILES - 1; i >= 0; i--) this.freeList[this.freeCount++] = i;

    this.buildMeshes(ctx);
  }

  private growUnits(n: number): void {
    if (this.phase.length >= n) return;
    const size = Math.max(n, this.phase.length * 2, 64);
    const u8 = new Uint8Array(size); u8.set(this.phase); this.phase = u8;
    const t = new Float32Array(size); t.set(this.timer); this.timer = t;
    const tu = new Int32Array(size).fill(-1); tu.set(this.targetUnit); this.targetUnit = tu;
    const w = new Float32Array(size); w.set(this.window); this.window = w;
    const r = new Float32Array(size); r.set(this.reload); this.reload = r;
    const s = new Int32Array(size); s.set(this.serial); this.serial = s;
  }

  private kindIndexOf(kind: WeaponKind): number {
    let k = this.kinds.indexOf(kind);
    if (k < 0) {
      k = this.kinds.length;
      this.kinds.push(kind);
      const phys = physicsOf(kind);
      this.kindVisual[k] = phys.visual;
      this.kindLofted[k] = LOFTED_KINDS.has(kind) ? 1 : 0;
      this.kindGirth[k] = phys.girth;
      this.kindTint[k * 3] = ((phys.tint >> 16) & 0xff) / 255;
      this.kindTint[k * 3 + 1] = ((phys.tint >> 8) & 0xff) / 255;
      this.kindTint[k * 3 + 2] = (phys.tint & 0xff) / 255;
    }
    return k;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  fixedUpdate(dt: number, ctx: EngineContext): void {
    const t0 = performance.now();
    const b = this.battle;
    POOL = b.pool;
    const units = b.units;
    let maxId = 0;
    for (let k = 0; k < units.length; k++) if (units[k].id > maxId) maxId = units[k].id;
    this.growUnits(maxId + 1);

    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (u.destroyed) continue;
      // Artillery is not a unit of men each shooting at a man. It is N machines, each on its
      // own cycle, each firing once from its own muzzle. Running both paths over a battery is
      // what put twelve bolts in the air for four engines — the other half of "they shoot a
      // volley of arrows".
      if (isEngineUnit(b.typeOf(u))) this.updateBattery(u, dt);
      else this.updateVolley(u, dt);
    }
    this.integrate(dt);
    void ctx;
    this.lastCostMs = performance.now() - t0;
  }

  /** The volley state machine: aim, release raggedly, reload, repeat. */
  private updateVolley(u: UnitGroupState, dt: number): void {
    const b = this.battle;
    const def = b.typeOf(u);
    const m = def.missile;
    const id = u.id;
    if (!m) return;

    const mods = modsOf(id);
    const sig = signalsOf(id);
    const routing = u.order === UnitOrder.Rout;
    const inMelee = sig.contactLock || sig.engagedFraction > 0.18;

    if (routing || inMelee || u.alive === 0) {
      this.phase[id] = Phase.Idle;
      this.timer[id] = 0;
      return;
    }

    // ---- pick a target formation ----
    if (this.phase[id] === Phase.Idle || this.phase[id] === Phase.Reloading) {
      let best = -1;
      let bestD = this.effectiveRange(m.kind, m.range);
      const units = b.units;
      for (let k = 0; k < units.length; k++) {
        const o = units[k];
        if (o.destroyed || o.faction === u.faction || o.alive === 0) continue;
        const d = Math.hypot(o.x - u.x, o.z - u.z);
        if (d < bestD) {
          bestD = d;
          best = o.id;
        }
      }
      this.targetUnit[id] = best;
    }

    const ordered = mods.orderedVolleys > 0;
    const canFire = this.targetUnit[id] >= 0 && (mods.fireAtWill || ordered) && u.ammo > 0;

    switch (this.phase[id] as Phase) {
      case Phase.Idle:
        if (canFire) {
          this.phase[id] = Phase.Aiming;
          this.timer[id] = 0;
          this.setUnitState(u, m.kind === 'bow' || m.kind === 'sling'
            ? SoldierState.Shooting : SoldierState.Throwing);
        }
        break;

      case Phase.Aiming: {
        this.timer[id] += dt;
        if (!canFire) {
          this.phase[id] = Phase.Idle;
          this.timer[id] = 0;
          break;
        }
        if (this.timer[id] >= AIM_TIME * (ordered ? 0.6 : 1)) {
          this.phase[id] = Phase.Releasing;
          this.timer[id] = 0;
          this.serial[id] = this.nextSerial++;
          this.window[id] = mods.tightVolley || ordered ? TIGHT_WINDOW : RAGGED_WINDOW;
          if (ordered) mods.orderedVolleys--;
          let count = 0;
          const p = b.pool;
          for (let k = 0; k < u.members.length; k++) {
            const i = u.members[k];
            if (p.aliveAt(i) && p.ammo[i] > 0) count++;
          }
          if (count > 0) {
            this.ctx.events.emit('volleyFired', {
              x: u.x, y: b.groundAt(u.x, u.z) + 1.5, z: u.z,
              count, kind: physicsOf(m.kind).event,
            });
          }
        }
        break;
      }

      case Phase.Releasing: {
        this.timer[id] += dt;
        const win = this.window[id];
        const target = this.unitById(this.targetUnit[id]);
        if (target && target.alive > 0) {
          const p = b.pool;
          const serial = this.serial[id];
          for (let k = 0; k < u.members.length; k++) {
            const i = u.members[k];
            if (this.firedSerial[i] === serial) continue;
            if (!p.aliveAt(i) || p.ammo[i] === 0) continue;
            if (p.state[i] === SoldierState.Fighting) continue;
            // Every man's own release moment inside the window — this is what makes
            // a volley ragged instead of a single wall of arrows.
            const offset = hash01(i, serial & 0xffff) * win;
            if (this.timer[id] < offset) continue;
            this.firedSerial[i] = serial;
            this.launch(i, u, def.missile!, target, mods.volleyPower);
          }
        }
        if (this.timer[id] >= win + 0.12) {
          this.phase[id] = Phase.Reloading;
          this.timer[id] = 0;
          const rate = Math.max(0.5, m.rate * mods.missileRate);
          this.reload[id] = (60 / rate) * (1 + u.fatigue * 0.5);
          this.refreshAmmo(u);
          this.setUnitState(u, SoldierState.Idle);
        }
        break;
      }

      case Phase.Reloading:
        this.timer[id] += dt;
        if (this.timer[id] >= this.reload[id]) {
          this.phase[id] = Phase.Idle;
          this.timer[id] = 0;
        }
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Artillery: N machines, each on its own clock
  // -------------------------------------------------------------------------

  /**
   * A battery's firing state, one entry per machine.
   *
   * This is the simulation's copy of the cycle `UnitRenderSystem` animates. It used to be the
   * other way round: the renderer kept the clock and reset it whenever the crew's ammunition
   * fell, because the shot could happen at any moment inside a 0.92 s hashed volley window and
   * no independent timer could stay inside it. That worked as well as it could and was still
   * wrong in three ways — three bolts left one gun per volley (one per crewman), each from the
   * crewman's own formation slot up to 3 m off the machine, and each reset the recoil so the
   * string was seen to let go up to three times for one shot.
   *
   * With the sim owning the clock, all three collapse: the machine fires once, from its own
   * muzzle, on the tick `sinceShot` resets — and the renderer reads that same number.
   */
  private batteries = new Map<number, FiringBattery>();

  /** Read by `UnitRenderSystem` so the animation and the shot cannot drift apart. */
  engineCycle(unitId: number): Readonly<Float32Array> | undefined {
    return this.batteries.get(unitId)?.sinceShot;
  }

  /**
   * The enemy unit each machine is currently laid on, or -1.
   *
   * So the renderer can traverse the machine onto the thing it is actually going to shoot at
   * rather than leaving it square to its formation. "It should be able to aim" was part of the
   * report, and a gun that never moves off its unit's facing does not look like one that is.
   */
  engineTargets(unitId: number): Readonly<Int32Array> | undefined {
    return this.batteries.get(unitId)?.target;
  }

  private batteryState(u: UnitGroupState, def: UnitTypeDef): FiringBattery {
    const kind = engineKindOf(def);
    const count = engineCountOf(kind, u.members.length);
    let bat = this.batteries.get(u.id);
    if (!bat || bat.count !== count || bat.kind !== kind) {
      bat = {
        kind, crew: CREW_OF[kind], count,
        sinceShot: new Float32Array(count),
        target: new Int32Array(count).fill(-1),
        rangedOn: new Int32Array(count).fill(-1),
        onTarget: new Int32Array(count),
        lastAimX: new Float32Array(count),
        lastAimZ: new Float32Array(count),
      };
      // Stagger the guns across the cycle so a battery does not fire as one salvo and then
      // stand idle for twenty seconds. Deterministic in the unit id, not drawn from the rng,
      // so a battery's rhythm is the same in every replay.
      for (let k = 0; k < count; k++) bat.sinceShot[k] = hash01(u.id * 977 + k * 131, 153) * 14;
      this.batteries.set(u.id, bat);
    }
    return bat;
  }

  /**
   * Advance every machine in a battery and fire the ones that are wound, loaded and laid.
   *
   * The release condition is `sinceShot >= max(reload, readyAt)`, and it matters that both
   * terms are there. `readyAt` is when `enginePose` finishes winding and loading, so a machine
   * physically cannot shoot before it; `reload` is the roster's own rate, so a machine that is
   * ready early waits at `EnginePhase.Ready` — wound, loaded, waiting for the order — rather
   * than firing faster than its establishment allows.
   */
  private updateBattery(u: UnitGroupState, dt: number): void {
    const b = this.battle;
    const p = b.pool;
    const def = b.typeOf(u);
    const m = def.missile;
    if (!m) return;
    const bat = this.batteryState(u, def);
    const mods = modsOf(u.id);
    const sig = signalsOf(u.id);

    // A crew fighting for its life is not winding. The machine stays wherever it was.
    if (u.order === UnitOrder.Rout || sig.contactLock || sig.engagedFraction > 0.18
      || u.alive === 0) {
      return;
    }

    const rate = Math.max(0.4, m.rate * mods.missileRate);
    const reload = (60 / rate) * (1 + u.fatigue * 0.5);
    const fireAt = Math.max(reload, engineReadyAt(reload));
    const range = this.effectiveRange(m.kind, m.range);
    const lofted = m.arc === 'high';

    for (let k = 0; k < bat.count; k++) {
      bat.sinceShot[k] += dt;
      if (bat.sinceShot[k] < fireAt) continue;
      if (!(mods.fireAtWill || mods.orderedVolleys > 0)) continue;

      // Which man serves this gun, and has he a shot left? A machine whose crew are all down
      // is abandoned where it stands, which is what the renderer already draws.
      let server = -1;
      for (let c = 0; c < bat.crew; c++) {
        const i = u.members[k * bat.crew + c];
        if (i !== undefined && p.aliveAt(i) && p.ammo[i] > 0) { server = i; break; }
      }
      if (server < 0) continue;

      const target = this.pickBatteryTarget(u, bat.kind, range);
      bat.target[k] = target ? target.id : -1;
      if (!target) continue;
      if (this.fireEngine(u, bat, k, m, target, server, range, lofted)) {
        bat.sinceShot[k] = 0;
        if (mods.orderedVolleys > 0) mods.orderedVolleys--;
      }
    }
    this.refreshAmmo(u);
  }

  /**
   * What a machine lays on.
   *
   * A bolt-thrower is a precision weapon and takes the nearest enemy, which is what it did
   * before and is right. A stone-thrower is not: 26 kg of tufa is wasted on a skirmish screen
   * and ruinous on a packed block, so it scores by how many men are standing in the beaten
   * zone, discounted by range. It also discounts a target on a wall heavily — a stone lobbed at
   * a parapet mostly takes a merlon, which is exactly what an earlier measurement found when an
   * onager put 334 shots into 1,049 masonry impacts and about one kill.
   */
  private pickBatteryTarget(
    u: UnitGroupState, kind: EngineKind, range: number
  ): UnitGroupState | null {
    const b = this.battle;
    const units = b.units;
    const stone = kind === EngineKind.Onager;
    let best: UnitGroupState | null = null;
    let bestScore = -Infinity;
    for (let k = 0; k < units.length; k++) {
      const o = units[k];
      if (o.destroyed || o.faction === u.faction || o.alive === 0) continue;
      const d = Math.hypot(o.x - u.x, o.z - u.z);
      if (d > range) continue;
      let score: number;
      if (stone) {
        score = o.alive / (1 + d / range);
        if (this.mostlyElevated(o)) score *= 0.3;
      } else {
        score = -d;
      }
      if (score > bestScore) { bestScore = score; best = o; }
    }
    return best;
  }

  /** Is most of this unit standing on masonry rather than on the ground? */
  private mostlyElevated(o: UnitGroupState): boolean {
    const b = this.battle;
    const p = b.pool;
    let up = 0;
    let n = 0;
    // Every eighth man is plenty to tell a wall detachment from a field block.
    for (let k = 0; k < o.members.length; k += 8) {
      const i = o.members[k];
      if (!p.aliveAt(i)) continue;
      n++;
      if (b.elevated[i] !== 0) up++;
    }
    return n > 0 && up / n > 0.5;
  }

  /** Loose one shot from machine `k`. Returns false if the solve had no answer. */
  private fireEngine(
    u: UnitGroupState,
    bat: FiringBattery,
    k: number,
    m: NonNullable<UnitTypeDef['missile']>,
    target: UnitGroupState,
    server: number,
    range: number,
    lofted: boolean
  ): boolean {
    const b = this.battle;
    const p = b.pool;
    const phys = physicsOf(m.kind);

    engineAnchor(u.x, u.z, u.facing, bat.kind, k, bat.count, this.anchor, this.site);
    const muzzle = MUZZLE_OF[bat.kind];
    const c = Math.cos(u.facing);
    const s = Math.sin(u.facing);
    const fx = this.anchor.x + muzzle[0] * c + muzzle[2] * s;
    const fz = this.anchor.z - muzzle[0] * s + muzzle[2] * c;
    const fy = b.groundAt(fx, fz) + muzzle[1];

    // What to lay on. A bolt is aimed at a man; a stone is laid on the mass, because its
    // blast radius makes the middle of the formation the highest-value point on the field.
    let tx: number;
    let tz: number;
    let ty: number;
    let tvx = 0;
    let tvz = 0;
    if (phys.blast > 0) {
      tx = target.x; tz = target.z;
      ty = b.groundAt(tx, tz) + 1.0;
      const mid = target.members[(target.members.length >> 1)];
      if (mid !== undefined && p.aliveAt(mid)) {
        tvx = p.vx[mid]; tvz = p.vz[mid];
        ty = p.y[mid] + 1.0;
      }
    } else {
      let man = -1;
      for (let a = 0; a < 3 && man < 0; a++) {
        const cand = target.members[this.artRng.int(0, target.members.length - 1)];
        if (p.aliveAt(cand)) man = cand;
      }
      if (man < 0) return false;
      tx = p.x[man]; tz = p.z[man];
      tvx = p.vx[man]; tvz = p.vz[man];
      ty = p.y[man] + 1.0;
    }

    // Two passes of lead, same as the volley solve.
    let d = Math.hypot(tx - fx, tz - fz);
    for (let pass = 0; pass < 2; pass++) {
      const tof = d / Math.max(6, phys.speed * 0.8);
      const lx = tx + tvx * tof;
      const lz = tz + tvz * tof;
      d = Math.hypot(lx - fx, lz - fz);
      if (pass === 1) { tx = lx; tz = lz; }
    }
    if (d < 8 || d > range) return false;

    // ---- ranging ----
    // The correction survives only while this machine keeps shooting at the same block and
    // that block stays roughly where it was. A target that has moved 18 m has moved further
    // than the bracket is worth, and the crew starts again.
    const moved = Math.hypot(tx - bat.lastAimX[k], tz - bat.lastAimZ[k]);
    if (bat.rangedOn[k] !== target.id || moved > 18) {
      bat.rangedOn[k] = target.id;
      bat.onTarget[k] = 0;
    }
    bat.lastAimX[k] = tx;
    bat.lastAimZ[k] = tz;
    const ranged = 1 / (1 + 0.9 * Math.min(bat.onTarget[k], 3));

    const mods = modsOf(u.id);
    const spread = m.accuracy * mods.missileSpread * (1 + 0.55 * (d / range)) * ranged;
    const ok = this.launchBallistic({
      kind: m.kind,
      fromX: fx, fromY: fy, fromZ: fz,
      toX: tx, toY: ty, toZ: tz,
      damage: m.damage * mods.volleyPower,
      apDamage: m.apDamage * mods.volleyPower,
      spread,
      ownerUnit: u.id,
      rng: this.artRng,
      lofted,
    });
    if (!ok) return false;
    bat.onTarget[k]++;

    if (p.ammo[server] > 0) p.ammo[server]--;
    if (b.elevated[server] !== 0) b.siege.noteWallShot();
    if (m.kind === 'boulder') b.siege.noteArtillery(1, 0);
    this.ctx.events.emit('volleyFired', {
      x: fx, y: fy, z: fz, count: 1, kind: phys.event,
    });
    return true;
  }

  /** Scratch for `engineAnchor`. */
  private anchor = { x: 0, z: 0 };

  /**
   * The ground an engine is standing on, for `engineAnchor`'s masonry test.
   *
   * Assembled from the battle and the city rather than passed in, so a scenario with no city
   * simply has no `masonryTopAt` and every machine sites where it was put.
   */
  private site!: EngineSite;

  /** Where machine `k` of a battery stands, for anything outside that needs it. */
  engineSite(): EngineSite {
    return this.site;
  }

  /** Put a whole unit into a state without disturbing anyone locked in melee. */
  private setUnitState(u: UnitGroupState, state: SoldierState): void {
    const p = this.battle.pool;
    for (let k = 0; k < u.members.length; k++) {
      const i = u.members[k];
      if (!p.aliveAt(i)) continue;
      const st = p.state[i];
      if (st === SoldierState.Fighting || st === SoldierState.Routing
        || st === SoldierState.Staggered) continue;
      p.setState(i, state);
    }
  }

  private refreshAmmo(u: UnitGroupState): void {
    const p = this.battle.pool;
    let total = 0;
    let n = 0;
    for (let k = 0; k < u.members.length; k++) {
      const i = u.members[k];
      if (!p.aliveAt(i)) continue;
      total += p.ammo[i];
      n++;
    }
    u.ammo = n > 0 ? Math.round(total / n) : 0;
  }

  // -------------------------------------------------------------------------
  // Launch
  // -------------------------------------------------------------------------

  /**
   * Put a garrison's shot where a garrison's shot actually leaves from, and tell the solve
   * what it has to clear. Writes `PARAPET_X/Y/Z` and `PARAPET_PITCH`.
   *
   * A crenellated parapet is merlon alternating with embrasure, and 64 % of Rome's run is
   * merlon. A man loosing from wherever he happens to be standing therefore shoots his own
   * battlement about two thirds of the time — and he does it *inside the stone*, not by
   * grazing it: the front rank stands 1.32 m in from the parapet's outer face and releases
   * 0.60 m below the crest, so even at the lofted 0.6 rad the shaft is still 0.15 m under the
   * merlon's top when it reaches the far side of the tooth. It cannot be fixed with elevation.
   * That is the player's "it gets stuck on the little pieces of cover facing the enemies", and
   * it is the same defect from the other side as the 491 impacts on our own masonry that put
   * the crenellation model into `masonryTopAt` in the first place — that fix stopped the
   * parapet blocking *incoming* fire wholesale and left the outgoing case standing.
   *
   * Two men, two answers, because they have two different problems:
   *
   * - **The front rank steps to the gap.** He is within reach of an embrasure, so he looses
   *   from its mouth. This is what the architecture is for and it is why the wall has teeth:
   *   he is behind 0.9 m of brick between shots and exposed in the gap while he shoots.
   * - **A rear rank lobs over the tooth.** He cannot reach the gap — there is a man in front
   *   of him — so the shot is given a floor: the elevation that clears the merlon's inner top
   *   edge, which is the corner that actually binds. Ranks 1 and back already clear it at the
   *   lofted 0.6 rad; what this rescues is every `arc: 'flat'` weapon, whose low root shooting
   *   *downhill* off a wall is depressed and goes straight into the brick from any rank.
   *
   * Deliberately **not** done: exempting a shot from the masonry test. The player ruled that
   * out and he is right — a defender who can be shot through his own merlon is worse than one
   * who cannot shoot. Incoming fire still stops on the crest exactly as before; only where a
   * defender's own shot *starts* has moved.
   */
  private aimOverParapet(i: number, toX: number, toZ: number): void {
    const b = this.battle;
    const p = b.pool;
    PARAPET_X = p.x[i];
    PARAPET_Y = p.y[i] + SHOULDER;
    PARAPET_Z = p.z[i];
    PARAPET_PITCH = -Infinity;
    PARAPET_STEPPED = false;
    const wall = this.wall;
    if (wall === null || b.elevated[i] === 0) return;
    const e = wall.embrasureAt(PARAPET_X, PARAPET_Z);
    if (e === null) { this.wSkip[1]++; return; }
    // His feet on this bay's walkway, not a storey above it in a tower chamber and not on a
    // boarding ramp that happens to be over the same stretch of x.
    if (Math.abs(b.support[i] - e.walkY) > ON_WALK_TOL) { this.wSkip[2]++; return; }

    const dx = toX - PARAPET_X;
    const dz = toZ - PARAPET_Z;
    const dLen = Math.hypot(dx, dz);
    if (dLen < 1e-3) { this.wSkip[3]++; return; }
    // Only an outward shot has a battlement in front of it. A man shooting back into the city
    // — at besiegers who have taken a stretch of the walk, or down the stair behind him — has
    // nothing to clear and must not be moved sideways for it.
    const cosOut = (dx * e.nx + dz * e.nz) / dLen;
    if (cosOut <= 0) { this.wSkip[4]++; return; }

    const off = (PARAPET_X - e.x) * e.nx + (PARAPET_Z - e.z) * e.nz;
    if (off > e.parapetOuter) { this.wSkip[5]++; return; }

    if (e.hasParapet && off >= e.parapetInner - EMBRASURE_REACH) {
      const mouth = e.parapetOuter - EMBRASURE_INSET;
      PARAPET_X = e.x + e.nx * mouth;
      PARAPET_Z = e.z + e.nz * mouth;
      // Never below the sill. A no-op on Rome, where a 1.45 m shoulder already stands 0.85 m
      // over a 0.6 m sill, and a guard for a city whose sill is higher.
      PARAPET_Y = Math.max(PARAPET_Y, e.sillY + SILL_CLEAR);
      PARAPET_STEPPED = true;
      return;
    }

    /**
     * Two corners bind a shot going out over a wall-walk, and which one is higher depends on
     * how finished the bay is.
     *
     * On a raised parapet it is the merlon's **inner** top edge — the first thing a rising
     * shot meets and the point where it is lowest inside the band. On a bay whose parapet is
     * not up yet there is no tooth at all, and the binding edge is the **outer lip of the walk
     * itself**: a man depressing onto an enemy at the foot of his own wall ploughs into six
     * metres of curtain top two metres in front of his feet. Measured, that second case was
     * the larger one — 94 % of the deepest rank's shots and 143 of 240 self-wall deaths, all
     * of them at or *below* walkway level, and every one of them invisible to a floor that
     * only knew about merlons.
     *
     * `atan2` of a negative rise is a negative angle, so this is a **depression limit** in
     * that case rather than a minimum loft, and the same `Math.max` handles both.
     */
    const cos = Math.max(0.25, cosOut);
    const runToCrest = (e.parapetInner - off) / cos;
    const runToLip = (e.halfThickness - off) / cos;
    let pitch = -Infinity;
    if (runToCrest > 0) pitch = Math.atan2(e.crestY + MERLON_CLEAR - PARAPET_Y, runToCrest);
    if (runToLip > 0) {
      pitch = Math.max(pitch, Math.atan2(e.walkY + WALK_CLEAR - PARAPET_Y, runToLip));
    }
    if (pitch === -Infinity) { this.wSkip[6]++; return; }
    PARAPET_PITCH = pitch;
  }

  private launch(
    i: number,
    u: UnitGroupState,
    m: NonNullable<UnitTypeDef['missile']>,
    target: UnitGroupState,
    power: number
  ): void {
    const b = this.battle;
    const p = b.pool;
    const phys = physicsOf(m.kind);

    // ---- choose a man to shoot at ----
    // Three candidates, nearest wins: arcing fire spreads over the formation, flat
    // fire concentrates on whoever is closest, which is how both actually behave.
    let t = -1;
    let bestD2 = Infinity;
    const members = target.members;
    for (let a = 0; a < 3; a++) {
      const cand = members[this.rng.int(0, members.length - 1)];
      if (!p.aliveAt(cand)) continue;
      const dx = p.x[cand] - p.x[i];
      const dz = p.z[cand] - p.z[i];
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        t = cand;
      }
    }
    if (t < 0) return;

    // ---- where the shot leaves from ----
    // On the flat this is his shoulder and nothing else happens. On a battlement it is the
    // mouth of the nearest embrasure, and a rear rank comes back with a minimum elevation.
    // See `aimOverParapet`. Aimed at the man's current position rather than the predicted
    // one: which side of the wall the enemy is on does not change over a second of lead.
    this.aimOverParapet(i, p.x[t], p.z[t]);
    const sx = PARAPET_X;
    const sy = PARAPET_Y;
    const sz = PARAPET_Z;
    const clearPitch = PARAPET_PITCH;

    // ---- predicted aim point, two passes ----
    let tx = p.x[t];
    let tz = p.z[t];
    let d = Math.hypot(tx - sx, tz - sz);
    // Both bounds, and the second is the fix for the Balearic slingers. `m.range` is what the
    // roster claims; `effectiveRange` is what the physics can actually deliver, and for the two
    // `arc: 'high'` weapons those disagreed — a sling could throw 104 m and claimed 180. Past
    // its real reach the lofted solve's discriminant goes negative and `lowRoot` returns a flat
    // 45 degrees, so the stone left at full power on the maximum-range elevation and buried
    // itself in the turf as far short as the two numbers differ. Nothing reported it: the shot
    // was fired, the ammunition was spent, and the impact was a plausible-looking divot.
    // The 8% over the roster range is the tolerance that was always here — a man on the wing
    // shoots at someone slightly beyond the unit's nominal reach. Only the *physical* bound is
    // new, and it is the one that has to be hard.
    if (d < 1.5) return;
    if (d > this.effectiveRange(m.kind, m.range * 1.08)) {
      this.cUnreachable[this.kindIndexOf(m.kind)]++;
      return;
    }
    let tof = d / Math.max(6, phys.speed * 0.8);
    for (let pass = 0; pass < 2; pass++) {
      tx = p.x[t] + p.vx[t] * tof;
      tz = p.z[t] + p.vz[t] * tof;
      d = Math.hypot(tx - sx, tz - sz);
      tof = d / Math.max(6, phys.speed * 0.8);
    }
    // Aim at the man, not at the ground he is nominally over. This read used to be
    // `groundAt(tx, tz) + 1.0`, which is the same answer for everybody standing on the
    // terrain and wrong by the full height of the masonry for anybody on a wall: every
    // arrow shot at a garrison was solved for a point 7 m below him and buried itself in
    // the brickwork, and every arrow shot *by* one was solved for a point at its own
    // feet. Predicted forward the same way the XZ aim point is, so a man walking a
    // boarding ramp is led correctly in all three axes.
    const ty = p.y[t] + p.vy[t] * tof + 1.0;

    // ---- line of fire ----
    const dirX = (tx - sx) / (d || 1);
    const dirZ = (tz - sz) / (d || 1);
    const lofted = m.arc === 'high';
    /**
     * On a battlement, also probe the man immediately in front.
     *
     * The probes step at 1.5 m, and a wall rank is 0.72 m deep, so the two ranks nearest a
     * rear-rank man have never been on the line at all. On open ground that hole is small —
     * a formation is 0.86 m deep and the shot is roughly level, so it passes over shoulders.
     * On a wall it is the whole problem: a rank-3 man's shot has to be lifted over his own
     * merlon, and the elevation that just clears a merlon 2.6 m away does **not** clear the
     * head of a man 0.72 m away. He was shooting his own front rank in the back of the neck.
     * Extra probes only where there is a parapet, so every field battle keeps its own
     * geometry and its own hash.
     */
    const onWall = clearPitch > -Infinity || PARAPET_STEPPED;
    const probes = lofted ? (onWall ? 3 : 1) : (onWall ? 5 : 3);
    const probeStep = onWall ? 0.72 : 1.5;
    LOS_FACTION = u.faction;
    LOS_SELF = i;
    LOS_BLOCKED = false;
    for (let k = 1; k <= probes; k++) {
      const dist = k * probeStep;
      if (dist > d) break;
      LOS_X = sx + dirX * dist;
      LOS_Z = sz + dirZ * dist;
      // Height along a straight line to the aim point is a good enough proxy over
      // the couple of metres that matter for a blocked lane — except where the shot is
      // being lifted over a parapet, in which case the lane it will actually take is the
      // lifted one and the straight line is metres below it.
      LOS_Y = clearPitch > -Infinity
        ? sy + Math.tan(clearPitch) * dist
        : sy + (ty - sy) * (dist / d) + (lofted ? dist * 0.5 : 0);
      b.hash.query(LOS_X, LOS_Z, 0.6, losVisit);
      if (LOS_BLOCKED) break;
    }
    if (LOS_BLOCKED) return;

    // ---- ballistic solve ----
    const h = ty - sy;
    const dComp = d * (1 + phys.dragComp * d);
    let v = phys.speed;
    let theta: number;
    if (lofted) {
      // Loft at a fixed elevation and draw only as hard as the range needs.
      const c = Math.cos(LOFT);
      const need = (GRAVITY * dComp * dComp) / (2 * c * c * (dComp * Math.tan(LOFT) - h));
      if (need > 0 && need <= v * v) {
        v = Math.sqrt(need);
        theta = LOFT;
      } else {
        theta = this.lowRoot(v, dComp, h);
      }
    } else {
      theta = this.lowRoot(v, dComp, h);
    }

    /**
     * Everything above is the answer the weapon wants. This is the answer his own wall
     * leaves him, and it only bites when the two disagree.
     *
     * `clearPitch` is `-Infinity` for every man not standing on a battlement, so this whole
     * block is dead on open ground and every field battle in the game is byte-identical.
     * When it does bind it is the same closed form the lofted branch uses, asked at the
     * limiting angle: the shot is re-drawn to whatever power still puts it on the man at that
     * elevation. Note the limit can be **negative** — a depression limit, for a man who would
     * otherwise plough his shot into the walk he is standing on — and the arithmetic is the
     * same either way.
     */
    if (theta < clearPitch) {
      const c = Math.cos(clearPitch);
      const v0 = phys.speed;
      const need = (GRAVITY * dComp * dComp) / (2 * c * c * (dComp * Math.tan(clearPitch) - h));
      // No power reaches the target at that elevation: shoot anyway, over the wall. A shot
      // that sails past its man is a miss; a shot into one's own parapet is a miss *and* a
      // garrison that reads as broken, which is what the player was looking at.
      v = need > 0 && need <= v0 * v0 ? Math.sqrt(need) : v0;
      theta = clearPitch;
    }

    // ---- accuracy ----
    const moving = Math.hypot(p.vx[i], p.vz[i]) > 0.5 ? 1 : 0;
    const mods = modsOf(u.id);
    const spread = m.accuracy * mods.missileSpread
      * (1 + 0.9 * (d / m.range))
      * (1 + 0.5 * p.fatigue[i])
      * (1 + 0.8 * moving);
    const yaw = Math.atan2(dirX, dirZ) + this.rng.normal(0, spread);
    const pitch = theta + this.rng.normal(0, spread * 0.8);

    const idx = this.spawn();
    if (idx < 0) return;
    const cp = Math.cos(pitch);
    this.px[idx] = sx; this.py[idx] = sy; this.pz[idx] = sz;
    this.ox[idx] = sx; this.oy[idx] = sy; this.oz[idx] = sz;
    this.vx[idx] = v * cp * Math.sin(yaw);
    this.vy[idx] = v * Math.sin(pitch);
    this.vz[idx] = v * cp * Math.cos(yaw);
    this.life[idx] = 0;
    this.dmg[idx] = m.damage * power;
    this.apDmg[idx] = m.apDamage * power;
    this.drag[idx] = phys.drag;
    this.len[idx] = phys.length;
    const ki = this.kindIndexOf(m.kind);
    this.kindIdx[idx] = ki;
    this.ownerUnit[idx] = u.id;
    this.aimX[idx] = tx;
    this.aimZ[idx] = tz;
    this.cLaunched[ki]++;
    this.pierceLeft[idx] = phys.pierce;
    this.lastHit[idx] = -1;
    this.srcX[idx] = sx; this.srcY[idx] = sy; this.srcZ[idx] = sz;
    this.srcRank[idx] = p.rank[i];
    const elevated = b.elevated[i] !== 0;
    this.fromWall[idx] = elevated ? 1 : 0;
    this.wRank[idx] = -1;
    if (elevated) {
      b.siege.noteWallShot();
      const r = p.rank[i];
      const bucket = r >= 0 && r < WALL_DIAG_RANKS - 1 ? r : WALL_DIAG_RANKS - 1;
      this.wRank[idx] = bucket;
      // His feet, not his shoulders: an impact is classified by how far it stands above the
      // walkway, which is the only frame in which "merlon" and "sill" mean anything.
      this.wFootY[idx] = b.support[i];
      this.wLaunched[bucket]++;
      if (PARAPET_STEPPED) this.wStepped[bucket]++;
      else if (clearPitch > -Infinity) this.wFloored[bucket]++;
    }
    if (m.kind === 'boulder') b.siege.noteArtillery(1, 0);

    if (p.ammo[i] > 0) p.ammo[i]--;
  }

  /**
   * Throw one projectile from an arbitrary point at an arbitrary point.
   *
   * The volley state machine above is built around a unit of men each shooting at a man,
   * which is not what a siege engine is: an onager is one machine served by a crew, it
   * shoots at a *place* — a stretch of parapet, a gate, a knot of men — and it does so on
   * its own clock. Rather than bend the volley machine into a shape that fits both, this
   * exposes the ballistics, the pool and the collision sweep directly.
   *
   * Returns false when the pool is full or the solve has no answer at this range.
   */
  launchBallistic(opts: {
    kind: WeaponKind;
    fromX: number; fromY: number; fromZ: number;
    toX: number; toY: number; toZ: number;
    damage: number; apDamage: number;
    /** Angular scatter, radians. Applied to yaw and, at 0.8x, to pitch. */
    spread: number;
    ownerUnit: number;
    /** Draw from a forked stream so the caller keeps determinism under its own control. */
    rng: Rng;
    /** Loft it like a stone-thrower rather than taking the flat root. */
    lofted?: boolean;
  }): boolean {
    const phys = physicsOf(opts.kind);
    const dx = opts.toX - opts.fromX;
    const dz = opts.toZ - opts.fromZ;
    const d = Math.hypot(dx, dz);
    if (d < 1) return false;
    const h = opts.toY - opts.fromY;
    const dComp = d * (1 + phys.dragComp * d);
    let v = phys.speed;
    let theta: number;
    if (opts.lofted) {
      const c = Math.cos(LOFT);
      const need = (GRAVITY * dComp * dComp) / (2 * c * c * (dComp * Math.tan(LOFT) - h));
      if (need > 0 && need <= v * v) {
        v = Math.sqrt(need);
        theta = LOFT;
      } else {
        theta = this.lowRoot(v, dComp, h);
      }
    } else {
      theta = this.lowRoot(v, dComp, h);
    }

    const idx = this.spawn();
    if (idx < 0) return false;
    const yaw = Math.atan2(dx / d, dz / d) + opts.rng.normal(0, opts.spread);
    const pitch = theta + opts.rng.normal(0, opts.spread * 0.8);
    const cp = Math.cos(pitch);
    this.px[idx] = opts.fromX; this.py[idx] = opts.fromY; this.pz[idx] = opts.fromZ;
    this.ox[idx] = opts.fromX; this.oy[idx] = opts.fromY; this.oz[idx] = opts.fromZ;
    this.vx[idx] = v * cp * Math.sin(yaw);
    this.vy[idx] = v * Math.sin(pitch);
    this.vz[idx] = v * cp * Math.cos(yaw);
    this.life[idx] = 0;
    this.dmg[idx] = opts.damage;
    this.apDmg[idx] = opts.apDamage;
    this.drag[idx] = phys.drag;
    this.len[idx] = phys.length;
    const ki = this.kindIndexOf(opts.kind);
    this.kindIdx[idx] = ki;
    this.ownerUnit[idx] = opts.ownerUnit;
    this.aimX[idx] = opts.toX;
    this.aimZ[idx] = opts.toZ;
    this.cLaunched[ki]++;
    this.pierceLeft[idx] = phys.pierce;
    this.lastHit[idx] = -1;
    this.srcX[idx] = opts.fromX; this.srcY[idx] = opts.fromY; this.srcZ[idx] = opts.fromZ;
    this.srcRank[idx] = -1;
    this.fromWall[idx] = 0;
    this.wRank[idx] = -1;
    return true;
  }

  /**
   * The shorter of what the roster claims and what the weapon can physically throw, less a
   * small margin so the last few metres of reach are not fired at a 45-degree elevation that
   * lands every shot on the same point.
   *
   * Memoised because it takes a square root and is asked once per unit per target search.
   */
  private effectiveRange(kind: WeaponKind, rosterRange: number): number {
    let r = this.rangeCache.get(kind);
    if (r === undefined) {
      r = maxRange(kind) * 0.97;
      this.rangeCache.set(kind, r);
    }
    return Math.min(rosterRange, r);
  }

  private rangeCache = new Map<WeaponKind, number>();

  /** Flattest of the two ballistic solutions; 45 degrees when the target is out of reach. */
  private lowRoot(v: number, d: number, h: number): number {
    const v2 = v * v;
    const disc = v2 * v2 - GRAVITY * (GRAVITY * d * d + 2 * h * v2);
    if (disc <= 0) return Math.PI / 4;
    return Math.atan((v2 - Math.sqrt(disc)) / (GRAVITY * d));
  }

  private spawn(): number {
    if (this.freeCount === 0) return -1;
    const i = this.freeList[--this.freeCount];
    this.alive[i] = 1;
    this.liveCount++;
    if (i >= this.highWater) this.highWater = i + 1;
    return i;
  }

  private release(i: number): void {
    if (this.alive[i] === 0) return;
    this.alive[i] = 0;
    this.liveCount--;
    this.freeList[this.freeCount++] = i;
  }

  // -------------------------------------------------------------------------
  // Flight
  // -------------------------------------------------------------------------

  private integrate(dt: number): void {
    const b = this.battle;
    const n = this.highWater;
    for (let i = 0; i < n; i++) {
      if (this.alive[i] === 0) continue;

      const x0 = this.px[i];
      const y0 = this.py[i];
      const z0 = this.pz[i];
      this.ox[i] = x0;
      this.oy[i] = y0;
      this.oz[i] = z0;

      let vx = this.vx[i];
      let vy = this.vy[i];
      let vz = this.vz[i];
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const k = this.drag[i] * sp;
      vx -= vx * k * dt;
      vy -= (vy * k + GRAVITY) * dt;
      vz -= vz * k * dt;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;

      const x1 = x0 + vx * dt;
      const y1 = y0 + vy * dt;
      const z1 = z0 + vz * dt;
      this.px[i] = x1;
      this.py[i] = y1;
      this.pz[i] = z1;
      this.life[i] += dt;

      // ---- soldiers ----
      if (this.life[i] > ARM_TIME) {
        const midX = (x0 + x1) * 0.5;
        const midZ = (z0 + z1) * 0.5;
        const half = Math.hypot(x1 - x0, z1 - z0) * 0.5;
        SEG_X0 = x0; SEG_Z0 = z0; SEG_Y0 = y0;
        SEG_X1 = x1; SEG_Z1 = z1; SEG_Y1 = y1;
        SEG_BEST_T = 2;
        SEG_BEST = -1;
        SEG_SKIP = this.lastHit[i];
        b.hash.query(midX, midZ, half + HIT_RADIUS + 0.2, segmentVisit);
        if (SEG_BEST >= 0) {
          this.impactSoldier(i, SEG_BEST, SEG_BEST_T);
          continue;
        }
      }

      // ---- masonry ----
      // A wall is 6.5 m of brick that a shaft has to clear or stick in. Without this test
      // an arrow aimed over the parapet carried straight through the curtain and planted
      // itself in the turf on the city side, and a boulder passed through the gatehouse.
      // O(1) — see `CitySystem.masonryTopAt`.
      if (this.city !== null) {
        const top = this.city.masonryTopAt(x1, z1);
        if (y1 <= top) {
          this.impactMasonry(i, x1, Math.min(y0, top), z1, top);
          continue;
        }
      }

      // ---- ground ----
      const ground = b.groundAt(x1, z1);
      if (y1 <= ground) {
        this.impactGround(i, x1, ground, z1);
        continue;
      }
      // Nothing flies for ever, and nothing leaves the field.
      if (this.life[i] > 14 || Math.abs(x1) > 1390 || Math.abs(z1) > 1390) this.release(i);
    }
  }

  /**
   * A shaft or a stone striking masonry.
   *
   * Stones shatter and are gone; arrows and pila lodge in the mortar joints, which is
   * what makes a besieged wall face look besieged after a few minutes of shooting.
   */
  private impactMasonry(i: number, x: number, y: number, z: number, top: number): void {
    const weapon = this.kinds[this.kindIdx[i]];
    const kind = physicsOf(weapon).event;
    this.noteWallShotEnd(i, top);
    this.ctx.events.emit('projectileImpact', {
      x, y, z, kind, hitTarget: false, material: 'stone',
    });
    this.masonryHits++;
    this.cMasonry[this.kindIdx[i]]++;
    this.noteMiss(i, x, z);
    if (physicsOf(weapon).blast > 0) {
      // A stone does not stand up in a wall; it breaks, and the splinters and the shock take
      // whoever is standing on the walk behind the merlon it struck.
      this.applyBlast(i, x, y, z, -1);
      this.release(i);
      return;
    }
    this.plant(i, x, y, z, -1, 0, 0, 0);
    this.release(i);
  }

  /** Missiles that have struck the city's masonry this battle. Read by the siege probe. */
  masonryHits = 0;

  /**
   * A stone coming down among men.
   *
   * Not an explosion — there is no chemistry in a torsion engine — but a 26 kg ball arriving at
   * 50 m/s carries about 33 kJ and does not stop at the first man it meets. Josephus (BJ V.6.3)
   * watched one carry off several at a stroke and Ammianus XXIII.4.5 says the same. Modelling it
   * as one man hit is why an onager measured 334 shots for about one kill, which made the most
   * expensive unit on the field the least useful.
   *
   * The falloff is deliberately steep — `(1 - d/R)²` peaking at 0.7 of the direct hit — so a
   * stone into a line at 0.86 m spacing hurts four or five men badly rather than the fifteen a
   * flat 2.4 m disc would contain. Armour and formation still apply; shields do not, because a
   * scutum against a one-talent stone is a splinter shower.
   */
  private applyBlast(i: number, x: number, y: number, z: number, skip: number): void {
    const phys = physicsOf(this.kinds[this.kindIdx[i]]);
    const R = phys.blast;
    if (R <= 0) return;
    const b = this.battle;
    const p = b.pool;
    BLAST_X = x; BLAST_Y = y + 0.35; BLAST_Z = z;
    BLAST_R2 = R * R;
    BLAST_SKIP = skip;
    BLAST_N = 0;
    b.hash.query(x, z, R, blastVisit);

    for (let n = 0; n < BLAST_N; n++) {
      const j = BLAST_HIT[n];
      const dv = this.unitById(p.unitId[j]);
      if (!dv) continue;
      const d = Math.hypot(p.x[j] - x, p.z[j] - z);
      const t = 1 - Math.min(1, d / R);
      const f = t * t * 0.7;
      if (f < 0.02) continue;
      const ddef = b.typeOf(dv);
      const dmods = modsOf(dv.id);
      const df = formation(dv.formationId);
      const through = 1 - armourReduction(ddef.armour * dmods.armour) * ARMOUR_BITE;
      const total = (this.dmg[i] * through + this.apDmg[i]) * f
        * df.mods.missileTaken * dmods.missileTaken * this.rng.range(0.8, 1.2);
      const lethal = b.damage(j, total, x, z, this.ownerUnit[i]);
      this.cDamage[this.kindIdx[i]] += total;
      signalsOf(dv.id).missilePulse += 1;
      // A stone does not ask whose men are standing round where it came down, and unlike a
      // shaft it never had a lane to be refused: the census keeps it apart for that reason.
      const own = this.unitById(this.ownerUnit[i]);
      const friendly = own !== undefined && own.faction === dv.faction;
      this.allBlast[0]++;
      if (friendly) this.ffBlast[0]++;
      if (lethal) {
        this.cKilled[this.kindIdx[i]]++;
        this.allBlast[1]++;
        if (friendly) this.ffBlast[1]++;
        signalsOf(this.ownerUnit[i]).killPulse += 1;
        b.siege.noteArtillery(0, 1);
      }
      // Knocked off their feet, away from where it landed.
      const inv = 1 / Math.max(0.3, d);
      p.vx[j] += (p.x[j] - x) * inv * 2.1 * f;
      p.vz[j] += (p.z[j] - z) * inv * 2.1 * f;
    }
  }

  /**
   * Place a garrison shot's death on the section of the wall it was fired from.
   *
   * `top` is the masonry height the collision test actually read, so the classification is
   * against the same number that stopped the shaft rather than against a re-derived one —
   * the rule this project keeps relearning is that an instrument which recomputes what it is
   * testing cannot fail. The bands are relative to the shooter's own walkway, so they carry
   * from Rome's 2.05 m parapet to Carthage's 2.2 m without a constant.
   */
  private noteWallShotEnd(i: number, top: number): void {
    const r = this.wRank[i];
    if (r < 0) return;
    if (this.life[i] > SELF_WALL_T) {
      this.wFarMasonry[r]++;
      return;
    }
    this.wSelfLife[r] += this.life[i];
    this.wSelfRange[r] += Math.hypot(this.px[i] - this.srcX[i], this.pz[i] - this.srcZ[i]);
    this.wSelfUp[r] += this.py[i] - this.wFootY[i];
    const e = this.wall !== null ? this.wall.embrasureAt(this.px[i], this.pz[i]) : null;
    if (e === null) this.wSelfNoBay[r]++;
    if (e !== null) {
      this.wSelfOn[r]++;
      this.wSelfOff[r] += (this.px[i] - e.x) * e.nx + (this.pz[i] - e.z) * e.nz;
      this.wSelfRun[r] += Math.abs(
        (this.px[i] - this.srcX[i]) * -e.nz + (this.pz[i] - this.srcZ[i]) * e.nx
      );
    }
    const d = top - this.wFootY[i];
    if (d > 1.3) this.wCrest[r]++;
    else if (d > 0.25) this.wSill[r]++;
    else if (d > -0.25) this.wWalk[r]++;
    else this.wBelow[r]++;
  }

  /**
   * Classify one man-hit for the friendly-fire census. See `ffDist`.
   *
   * The band a hit lands in is the whole point: `bin` is set here and read again by
   * `noteFriendlyKill` on the same projectile, so the hit and the kill histograms cannot
   * disagree about which band a shot was in.
   */
  private ffBin = 0;
  private ffArc = 0;

  /**
   * The last few friendly hits, in full, as a ring.
   *
   * A histogram can only confirm a mechanism somebody already thought of. The first run of
   * this census produced a band — friendly hits under 0.9 m from a muzzle whose bolt leaves
   * at 78 m/s and covers 2.6 m in one tick — that could not be true given its neighbour, and
   * only the raw record said which of the two numbers was lying.
   */
  private ffSample: number[][] = [];
  private ffSampleAt = 0;

  private noteFriendlyFire(
    i: number, j: number, friendly: boolean, hx: number, hz: number, victimUnit: number
  ): void {
    const arc = this.kindLofted[this.kindIdx[i]];
    const bin = ffBand(Math.hypot(hx - this.srcX[i], hz - this.srcZ[i]), FF_BAND_M);
    if (friendly && this.ffSampleAt < 4096) {
      const p0 = this.battle.pool;
      this.ffSample[this.ffSampleAt++ % 48] = [
        this.kindIdx[i], +this.life[i].toFixed(4),
        +Math.hypot(hx - this.srcX[i], hz - this.srcZ[i]).toFixed(3),
        +Math.hypot(this.vx[i], this.vy[i], this.vz[i]).toFixed(2),
        this.srcRank[i], p0.rank[j], this.ownerUnit[i], victimUnit,
        +this.srcY[i].toFixed(2), +p0.y[j].toFixed(2), this.fromWall[i],
      ];
    }
    this.ffArc = arc;
    this.ffBin = bin;
    this.ffAllDist[arc * FF_BINS + bin]++;
    if (!friendly) { this.ffEnemy[0]++; return; }
    this.ffDist[arc * FF_BINS + bin]++;
    this.ffTime[arc * FF_BINS + ffBand(this.life[i], FF_BAND_S)]++;
    this.ffHitKind[this.kindIdx[i]]++;
    if (this.fromWall[i] !== 0) this.ffWall[0]++;
    const p = this.battle.pool;
    if (victimUnit === this.ownerUnit[i]) {
      this.ffSameUnit[0]++;
      // Rank counts outward from the front, so a lower rank is a man standing in front of the
      // shooter. That is the literal "the rear rank shot through its own front rank" case and
      // it is the only one a line-of-fire test could ever have prevented.
      if (this.srcRank[i] >= 0 && p.rank[j] >= 0 && p.rank[j] < this.srcRank[i]) {
        this.ffSameUnit[2]++;
      }
    } else {
      this.ffSameUnit[1]++;
    }
  }

  private noteFriendlyKill(i: number, friendly: boolean): void {
    if (!friendly) { this.ffEnemy[1]++; return; }
    this.ffKillDist[this.ffArc * FF_BINS + this.ffBin]++;
    this.ffKillKind[this.kindIdx[i]]++;
    if (this.fromWall[i] !== 0) this.ffWall[1]++;
  }

  /** Score a landing against the point it was solved for. See `aimX`. */
  private noteMiss(i: number, x: number, z: number): void {
    const k = this.kindIdx[i];
    this.cMiss[k] += Math.hypot(x - this.aimX[i], z - this.aimZ[i]);
    this.cMissN[k]++;
  }

  private impactGround(i: number, x: number, y: number, z: number): void {
    this.cGround[this.kindIdx[i]]++;
    if (this.wRank[i] >= 0) this.wGround[this.wRank[i]]++;
    this.noteMiss(i, x, z);
    const kind = physicsOf(this.kinds[this.kindIdx[i]]).event;
    this.ctx.events.emit('projectileImpact', {
      x, y, z, kind, hitTarget: false, material: 'ground',
    });
    this.applyBlast(i, x, y, z, -1);
    this.plant(i, x, y, z, -1, 0, 0, 0);
    this.release(i);
  }

  private impactSoldier(i: number, j: number, t: number): void {
    const b = this.battle;
    const p = b.pool;
    const hx = this.ox[i] + (this.px[i] - this.ox[i]) * t;
    const hy = this.oy[i] + (this.py[i] - this.oy[i]) * t;
    const hz = this.oz[i] + (this.pz[i] - this.oz[i]) * t;
    const kind = physicsOf(this.kinds[this.kindIdx[i]]).event;

    const dv = this.unitById(p.unitId[j]);
    if (!dv) {
      this.release(i);
      return;
    }
    const ddef = b.typeOf(dv);
    const dmods = modsOf(dv.id);
    const df = formation(dv.formationId);

    // Incoming direction, from the defender's point of view.
    const sp = Math.hypot(this.vx[i], this.vz[i]) || 1;
    const bx = -this.vx[i] / sp;
    const bz = -this.vz[i] / sp;
    const cosMan = bx * Math.sin(p.facing[j]) + bz * Math.cos(p.facing[j]);
    const cover = shieldCoverage(cosMan) * df.mods.shield * dmods.shield;
    // A scutum held into a volley stops most of it; edge-on it stops nothing.
    const block = clamp01((ddef.shieldDefence / 46) * cover);

    this.cHitMan[this.kindIdx[i]]++;
    const own = this.unitById(this.ownerUnit[i]);
    const friendly = own !== undefined && own.faction === dv.faction;
    if (this.wRank[i] >= 0) {
      this.wHitMan[this.wRank[i]]++;
      if (friendly) this.wFriendly[this.wRank[i]]++;
    }
    this.noteFriendlyFire(i, j, friendly, hx, hz, dv.id);
    this.noteMiss(i, hx, hz);
    // A shield stops an arrow and a pilum. It does not stop a stone from an engine, so a
    // weapon with a blast radius skips the block roll entirely.
    const phys = physicsOf(this.kinds[this.kindIdx[i]]);
    const stoppable = phys.blast === 0;
    let bypass = 1;
    if (stoppable && ddef.shieldDefence > 4 && this.rng.next() < Math.min(0.9, block)) {
      this.cBlocked[this.kindIdx[i]]++;
      this.ctx.events.emit('projectileImpact', {
        x: hx, y: hy, z: hz, kind, hitTarget: true, material: 'shield',
      });
      // Anything with a point is now in the shield and out of the fight — pila stuck in a
      // scutum are the whole purpose of the weapon. A blunt missile is not stopped, only
      // blunted: see `shieldBypass`.
      if (phys.shieldBypass <= 0) {
        this.plant(i, hx, hy, hz, j, -0.28, hy - p.y[j], 0.16);
        this.release(i);
        return;
      }
      bypass = phys.shieldBypass;
    }

    const taken = df.mods.missileTaken * dmods.missileTaken;
    const through = 1 - armourReduction(ddef.armour * dmods.armour) * ARMOUR_BITE;
    const total = (this.dmg[i] * through + this.apDmg[i]) * taken * bypass
      * this.rng.range(0.85, 1.15);
    const lethal = b.damage(j, total, this.ox[i], this.oz[i], this.ownerUnit[i]);
    this.cDamage[this.kindIdx[i]] += total;
    if (lethal) {
      this.cKilled[this.kindIdx[i]]++;
      if (this.wRank[i] >= 0) this.wKilled[this.wRank[i]]++;
      this.noteFriendlyKill(i, friendly);
    }
    const dsig = signalsOf(dv.id);
    dsig.missilePulse += 1;
    if (lethal) {
      signalsOf(this.ownerUnit[i]).killPulse += 1;
      if (this.fromWall[i] !== 0) b.siege.noteWallKill();
      if (this.kinds[this.kindIdx[i]] === 'boulder') b.siege.noteArtillery(0, 1);
      p.vx[j] = -bx * 1.3;
      p.vz[j] = -bz * 1.3;
    }

    this.ctx.events.emit('projectileImpact', {
      x: hx, y: hy, z: hz, kind, hitTarget: true,
      material: ddef.armour > 34 ? 'armour' : 'flesh',
    });
    this.applyBlast(i, hx, hy, hz, j);

    // Over-penetration. A bolt that has just killed a man keeps going, at a cost — see
    // `pierce`. It only carries on through a man it actually *killed*: a shot stopped by
    // armour or by a shield has already spent itself, and letting a survivable hit continue
    // would turn every glancing blow into a burst.
    if (lethal && this.pierceLeft[i] > 0) {
      this.pierceLeft[i]--;
      this.lastHit[i] = j;
      this.dmg[i] *= 0.55;
      this.apDmg[i] *= 0.55;
      // Bleed a little speed so the second man is hit measurably harder than the third.
      this.vx[i] *= 0.86; this.vy[i] *= 0.86; this.vz[i] *= 0.86;
      return;
    }
    this.release(i);
  }

  /**
   * Keep a spent projectile on the field. Ring buffer, so the oldest shafts quietly
   * disappear once the cap is reached rather than the count growing without limit.
   */
  private plant(
    i: number, x: number, y: number, z: number,
    attach: number, offX: number, offY: number, offZ: number
  ): void {
    if (attach >= 0 && this.attachedCount >= MAX_ATTACHED) attach = -1;
    const k = this.kindIdx[i];
    // A stone does not lodge in a shield; it breaks the arm behind it and drops.
    if (this.kindVisual[k] === Visual.Stone) attach = -1;
    const s = this.stuckCursor;
    if (this.sAttach[s] >= 0) this.attachedCount--;
    this.stuckCursor = (s + 1) % MAX_STUCK;
    if (this.stuckCount < MAX_STUCK) this.stuckCount++;

    const sp = Math.hypot(this.vx[i], this.vy[i], this.vz[i]) || 1;
    this.sx[s] = x;
    this.sy[s] = y;
    this.sz[s] = z;
    this.sdx[s] = this.vx[i] / sp;
    this.sdy[s] = this.vy[i] / sp;
    this.sdz[s] = this.vz[i] / sp;
    this.slen[s] = this.len[i];
    this.sVis[s] = this.kindVisual[k];
    this.sGirth[s] = this.kindGirth[k];
    this.sTintR[s] = this.kindTint[k * 3];
    this.sTintG[s] = this.kindTint[k * 3 + 1];
    this.sTintB[s] = this.kindTint[k * 3 + 2];
    this.sAttach[s] = attach;
    this.sOffX[s] = offX;
    this.sOffY[s] = offY;
    this.sOffZ[s] = offZ;
    if (attach >= 0) this.attachedCount++;
  }

  private unitById(id: number): UnitGroupState | undefined {
    const units = this.battle.units;
    for (let k = 0; k < units.length; k++) if (units[k].id === id) return units[k];
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Rendering — two instanced draw calls, whatever is in the air
  // -------------------------------------------------------------------------

  /**
   * Six instanced meshes: a flight and a spent pair for each `Visual`, all on one material.
   *
   * Six rather than two costs four draw calls out of a 220 budget, and only when more than one
   * class is in the air at once — an empty `InstancedMesh` is set invisible below and a hidden
   * mesh is not drawn. Against that, it is the only way a stone can be a stone: geometry cannot
   * be selected per instance without a shader, and a shader for six hundred projectiles is a
   * worse trade than four draws.
   */
  private buildMeshes(ctx: EngineContext): void {
    this.geometries[Visual.Shaft] = this.buildShaftGeometry();
    this.geometries[Visual.Bolt] = this.buildBoltGeometry();
    this.geometries[Visual.Stone] = this.buildStoneGeometry();
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.68,
      metalness: 0.2,
    });

    const add = (v: Visual, cap: number, spent: boolean): THREE.InstancedMesh => {
      const m = new THREE.InstancedMesh(this.geometries[v], this.material!, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // One tint per weapon kind over the geometry's own vertex colours, so a pilum's iron
      // shank, a javelin's honey ash and an arrow's bleached one come off one mesh.
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      m.count = 0;
      m.visible = false;
      m.name = `projectiles-${spent ? 'spent' : 'flight'}-${VISUAL_NAME[v]}`;
      ctx.scene.add(m);
      return m;
    };
    for (let v = 0; v < VISUAL_COUNT; v++) {
      this.flightMesh[v] = add(v, MAX_PROJECTILES, false);
      this.stuckMesh[v] = add(v, MAX_STUCK, true);
    }
  }

  /** Instances written per mesh on the last frame, for `debugProjectiles`. */
  private meshInfo(): unknown {
    const out: Record<string, number> = {};
    for (let v = 0; v < VISUAL_COUNT; v++) {
      out[`flight-${VISUAL_NAME[v]}`] = this.flightMesh[v]?.count ?? 0;
      out[`spent-${VISUAL_NAME[v]}`] = this.stuckMesh[v]?.count ?? 0;
    }
    return out;
  }

  /**
   * A unit-length shaft lying along -Y so the head sits at the origin: the instance
   * position is then the point of impact and the shaft trails behind it. Shaft, iron
   * head and fletching are separated by vertex colour, so all kinds share one
   * material and therefore one draw call.
   */
  private buildShaftGeometry(): THREE.BufferGeometry {
    const { pos, nrm, col, idx, pushTri } = triBuffer();

    // Shaft: a 5-sided prism from y=-1 to y=-0.09.
    const R = 0.0135;
    const SEG = 5;
    for (let s = 0; s < SEG; s++) {
      const a0 = (s / SEG) * Math.PI * 2;
      const a1 = ((s + 1) / SEG) * Math.PI * 2;
      const x0 = Math.cos(a0) * R, z0 = Math.sin(a0) * R;
      const x1 = Math.cos(a1) * R, z1 = Math.sin(a1) * R;
      pushTri(x0, -1, z0, x1, -1, z1, x1, -0.09, z1, 0.42, 0.33, 0.21);
      pushTri(x0, -1, z0, x1, -0.09, z1, x0, -0.09, z0, 0.42, 0.33, 0.21);
    }
    // Iron head: a short pyramid closing on the origin.
    const HR = 0.026;
    for (let s = 0; s < SEG; s++) {
      const a0 = (s / SEG) * Math.PI * 2;
      const a1 = ((s + 1) / SEG) * Math.PI * 2;
      pushTri(
        Math.cos(a0) * HR, -0.12, Math.sin(a0) * HR,
        Math.cos(a1) * HR, -0.12, Math.sin(a1) * HR,
        0, 0, 0, 0.52, 0.55, 0.58
      );
    }
    // Fletching: two crossed vanes at the nock, visible when the camera is close.
    const FL = 0.055;
    for (let v = 0; v < 2; v++) {
      const a = v * Math.PI * 0.5;
      const fx = Math.cos(a) * FL;
      const fz = Math.sin(a) * FL;
      pushTri(0, -0.99, 0, fx, -0.95, fz, fx * 0.7, -0.82, fz * 0.7, 0.85, 0.82, 0.74);
      pushTri(0, -0.99, 0, -fx, -0.95, -fz, -fx * 0.7, -0.82, -fz * 0.7, 0.85, 0.82, 0.74);
    }

    return finishGeometry(pos, nrm, col, idx);
  }

  /**
   * A ballista bolt, on the same -Y unit-length convention as the shaft.
   *
   * Not an arrow. The Dura-Europos and Vindonissa finds are square-sectioned shafts a good deal
   * thicker than an arrow's, carrying a long pyramidal iron head with a pronounced shoulder over
   * a bronze socket, and three stiff flights that are cut from wood or leather rather than
   * feathered — a bolt spends its flight at 78 m/s and a feather would strip. The head is 30% of
   * the length here against an arrow's 12%, which is the proportion that reads at thirty metres
   * and is roughly what the finds show once the socket is counted.
   */
  private buildBoltGeometry(): THREE.BufferGeometry {
    const { pos, nrm, col, idx, pushTri } = triBuffer();
    const OAK = [0.35, 0.26, 0.16] as const;
    const IRON = [0.44, 0.46, 0.50] as const;
    const BRONZE = [0.55, 0.44, 0.24] as const;

    /** A square box between two y planes, tapering from `r0` to `r1`, rotated 45 deg per level. */
    const box = (y0: number, y1: number, r0: number, r1: number, c: readonly number[]): void => {
      for (let s = 0; s < 4; s++) {
        const a0 = (s / 4) * Math.PI * 2 + Math.PI / 4;
        const a1 = ((s + 1) / 4) * Math.PI * 2 + Math.PI / 4;
        const x0 = Math.cos(a0), z0 = Math.sin(a0);
        const x1 = Math.cos(a1), z1 = Math.sin(a1);
        pushTri(x0 * r0, y0, z0 * r0, x1 * r0, y0, z1 * r0, x1 * r1, y1, z1 * r1, c[0], c[1], c[2]);
        pushTri(x0 * r0, y0, z0 * r0, x1 * r1, y1, z1 * r1, x0 * r1, y1, z0 * r1, c[0], c[1], c[2]);
      }
    };

    // Shaft, 22 mm across the flats.
    box(-1, -0.34, 0.0110, 0.0115, OAK);
    // Bronze socket collar — the visual break between wood and iron, and where the eye reads
    // "this is a machine's ammunition" rather than "this is a long arrow".
    box(-0.35, -0.295, 0.0170, 0.0165, BRONZE);
    // The head: a long square-section pyramid with a shoulder, closing on the origin.
    box(-0.295, -0.24, 0.0155, 0.0250, IRON);
    box(-0.24, 0, 0.0250, 0.0006, IRON);
    // Three stiff rectangular flights, standing well proud of a 22 mm shaft so they survive the
    // distance an arrow's soft fletching does not.
    const FL = 0.062;
    for (let v = 0; v < 3; v++) {
      const a = (v / 3) * Math.PI * 2;
      const fx = Math.cos(a) * FL;
      const fz = Math.sin(a) * FL;
      const bx = Math.cos(a) * 0.011;
      const bz = Math.sin(a) * 0.011;
      // The vane as a quad, then the same two triangles wound the other way so it reads from
      // either face — a flat vane culled from behind flickers as the bolt rolls.
      const quad = [
        [bx, -1.0, bz], [fx, -0.97, fz], [fx, -0.845, fz], [bx, -0.795, bz],
      ] as const;
      const tris: readonly (readonly number[])[][] = [
        [quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]],
        [quad[2], quad[1], quad[0]], [quad[3], quad[2], quad[0]],
      ];
      for (const t of tris) {
        pushTri(
          t[0][0], t[0][1], t[0][2], t[1][0], t[1][1], t[1][2], t[2][0], t[2][1], t[2][2],
          0.30, 0.23, 0.15
        );
      }
    }
    return finishGeometry(pos, nrm, col, idx);
  }

  /**
   * A stone of unit diameter, so the instance scale is the stone's own size in metres.
   *
   * A subdivided icosahedron with its radius pushed about by a smooth function of direction —
   * smooth rather than hashed per vertex because the base geometry is non-indexed, so a shared
   * corner appears three or four times and a per-vertex random would tear the surface open. The
   * result is a faceted, slightly lumpy ball that reads as dressed tufa rather than as a marble,
   * which is what an onager actually threw: Rome's own engines fired local tufa and travertine.
   */
  private buildStoneGeometry(): THREE.BufferGeometry {
    const base = new THREE.IcosahedronGeometry(0.5, 1);
    const p = base.getAttribute('position') as THREE.BufferAttribute;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const l = Math.hypot(x, y, z) || 1;
      const ux = x / l, uy = y / l, uz = z / l;
      // Two octaves of a direction-only lumpiness. Continuous in direction, so every copy of a
      // shared corner lands on exactly the same point.
      const lump = 1
        + 0.155 * Math.sin(3.1 * ux + 1.7) * Math.cos(2.7 * uy + 0.4)
        + 0.095 * Math.sin(4.3 * uz + 2.2) * Math.cos(3.7 * ux - 1.1);
      const r = 0.5 * lump;
      p.setXYZ(i, ux * r, uy * r, uz * r);
      // Pale warm grey with a little mottle, again from direction so it is stable.
      const m = 0.055 * Math.sin(5.9 * ux + 2.1) * Math.sin(4.7 * uz - 0.6);
      col[i * 3] = 0.70 + m;
      col[i * 3 + 1] = 0.665 + m;
      col[i * 3 + 2] = 0.60 + m * 0.8;
    }
    base.setAttribute('color', new THREE.BufferAttribute(col, 3));
    base.computeVertexNormals();
    base.computeBoundingSphere();
    return base;
  }

  preRender(ctx: EngineContext): void {
    if (this.flightMesh.length === 0) return;
    const alpha = ctx.time.alpha;
    const counts = this.visCount;

    counts.fill(0);
    for (let i = 0; i < this.highWater; i++) {
      if (this.alive[i] === 0) continue;
      const k = this.kindIdx[i];
      const v = this.kindVisual[k];
      const mesh = this.flightMesh[v];
      if (!mesh) continue;
      const x = this.ox[i] + (this.px[i] - this.ox[i]) * alpha;
      const y = this.oy[i] + (this.py[i] - this.oy[i]) * alpha;
      const z = this.oz[i] + (this.pz[i] - this.oz[i]) * alpha;
      const l = this.len[i];
      if (v === Visual.Stone) {
        // A stone does not point where it is going; it tumbles, and that is the single
        // clearest signal that what is in the air is not a shaft. Axis and rate from the
        // projectile's slot, which is stable for its whole flight, and the angle from its
        // own age — visual-only, so `hash01` here is inside the rules.
        const ax = hash01(i, 0x51e) - 0.5;
        const ay = hash01(i, 0x52f) - 0.5;
        const az = hash01(i, 0x53a) - 0.5;
        tmpDir.set(ax, ay, az);
        if (tmpDir.lengthSq() < 1e-6) tmpDir.set(0, 1, 0);
        tmpDir.normalize();
        tmpQuat.setFromAxisAngle(tmpDir, (this.life[i] + alpha * 0.033) * (3.2 + hash01(i, 0x54b) * 5.5));
        tmpScale.set(l, l, l);
      } else {
        tmpDir.set(this.vx[i], this.vy[i], this.vz[i]);
        if (tmpDir.lengthSq() < 1e-6) tmpDir.set(0, -1, 0);
        tmpDir.normalize();
        tmpQuat.setFromUnitVectors(UP, tmpDir);
        const g = this.kindGirth[k];
        tmpScale.set(g, l, g);
      }
      tmpPos.set(x, y, z);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      const n = counts[v]++;
      mesh.setMatrixAt(n, tmpMat);
      const c = mesh.instanceColor!;
      c.setXYZ(n, this.kindTint[k * 3], this.kindTint[k * 3 + 1], this.kindTint[k * 3 + 2]);
    }
    for (let v = 0; v < VISUAL_COUNT; v++) {
      const m = this.flightMesh[v];
      if (!m) continue;
      m.count = counts[v];
      m.visible = counts[v] > 0;
      if (counts[v] > 0) {
        m.instanceMatrix.needsUpdate = true;
        m.instanceColor!.needsUpdate = true;
      }
    }

    const p = this.battle.pool;
    counts.fill(0);
    for (let s = 0; s < this.stuckCount; s++) {
      const v = this.sVis[s];
      const mesh = this.stuckMesh[v];
      if (!mesh) continue;
      const at = this.sAttach[s];
      let x = this.sx[s];
      let y = this.sy[s];
      let z = this.sz[s];
      if (at >= 0) {
        // Riding in a shield: follow the man until he falls, then let it lie.
        const f = p.facing[at];
        const c = Math.cos(f);
        const si = Math.sin(f);
        x = p.x[at] + this.sOffX[s] * c + this.sOffZ[s] * si;
        z = p.z[at] - this.sOffX[s] * si + this.sOffZ[s] * c;
        y = p.y[at] + this.sOffY[s];
      }
      const g = this.sGirth[s];
      if (v === Visual.Stone) {
        // Settled where it stopped rolling, in whatever attitude it came to rest in.
        tmpDir.set(hash01(s, 0x61e) - 0.5, hash01(s, 0x62f) - 0.5, hash01(s, 0x63a) - 0.5);
        if (tmpDir.lengthSq() < 1e-6) tmpDir.set(0, 1, 0);
        tmpDir.normalize();
        tmpQuat.setFromAxisAngle(tmpDir, hash01(s, 0x64b) * 6.283);
        tmpScale.set(this.slen[s], this.slen[s], this.slen[s]);
      } else {
        tmpDir.set(this.sdx[s], this.sdy[s], this.sdz[s]);
        if (tmpDir.lengthSq() < 1e-6) tmpDir.set(0, -1, 0);
        tmpDir.normalize();
        tmpQuat.setFromUnitVectors(UP, tmpDir);
        tmpScale.set(g, this.slen[s], g);
      }
      tmpPos.set(x, y, z);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      const n = counts[v]++;
      mesh.setMatrixAt(n, tmpMat);
      mesh.instanceColor!.setXYZ(n, this.sTintR[s], this.sTintG[s], this.sTintB[s]);
    }
    for (let v = 0; v < VISUAL_COUNT; v++) {
      const m = this.stuckMesh[v];
      if (!m) continue;
      m.count = counts[v];
      m.visible = counts[v] > 0;
      if (counts[v] > 0) {
        m.instanceMatrix.needsUpdate = true;
        m.instanceColor!.needsUpdate = true;
      }
    }
  }

  /** Scratch for `preRender`'s per-mesh instance counters. */
  private visCount = new Int32Array(VISUAL_COUNT);

  // -------------------------------------------------------------------------
  // Read API
  // -------------------------------------------------------------------------

  /** Projectiles currently in the air. */
  get inFlight(): number {
    return this.liveCount;
  }

  /** Spent shafts on the field. */
  get spent(): number {
    return this.stuckCount;
  }

  /**
   * Everything `tools/probe-artillery.mjs` needs to answer "what is actually being drawn, and
   * where do the shots go" without reading a pixel. Not used by the game.
   *
   * `visual` is the name of the instanced mesh the kind's live projectiles were routed into on
   * the last `preRender`, counted rather than inferred — the whole reason this exists is that a
   * still frame cannot distinguish a stone drawn as an arrow from an arrow.
   */
  debugProjectiles(): unknown {
    const kinds = this.kinds.map((kind, k) => {
      const phys = physicsOf(kind);
      return {
        kind,
        event: phys.event,
        visual: VISUAL_NAME[phys.visual],
        speed: phys.speed,
        drag: phys.drag,
        length: phys.length,
        maxRangeM: +maxRange(kind).toFixed(1),
        launched: this.cLaunched[k],
        unreachable: this.cUnreachable[k],
        hitMan: this.cHitMan[k],
        blockedByShield: this.cBlocked[k],
        killed: this.cKilled[k],
        intoGround: this.cGround[k],
        intoMasonry: this.cMasonry[k],
        damage: +this.cDamage[k].toFixed(1),
        meanMissM: this.cMissN[k] ? +(this.cMiss[k] / this.cMissN[k]).toFixed(2) : null,
      };
    });
    return {
      kinds,
      inFlight: this.liveCount,
      spent: this.stuckCount,
      // Instances actually written per mesh on the last frame. This is the counted answer to
      // "which visual does each weapon emit".
      meshes: this.meshInfo(),
      batteries: [...this.batteries].map(([unit, b]) => ({
        unit,
        kind: b.kind === EngineKind.Onager ? 'onager' : 'scorpio',
        machines: b.count,
        sinceShot: [...b.sinceShot].map((v) => +v.toFixed(2)),
        target: [...b.target],
        shotsOnTarget: [...b.onTarget],
      })),
    };
  }

  /**
   * The garrison's own shots, per rank on the walkway. See `wCrest`.
   *
   * `crest` is the number this whole workstream exists for: a shot that struck masonry
   * standing more than 1.3 m above the walk within half a second of leaving the bow is a man
   * shooting his own merlon.
   */
  debugWallShots(): unknown {
    const rank = (r: number) => ({
      rank: r === WALL_DIAG_RANKS - 1 ? 'other' : r,
      launched: this.wLaunched[r],
      steppedToGap: this.wStepped[r],
      elevationFloored: this.wFloored[r],
      hitMan: this.wHitMan[r],
      hitOwnSide: this.wFriendly[r],
      killed: this.wKilled[r],
      intoGround: this.wGround[r],
      ownMerlon: this.wCrest[r],
      ownSill: this.wSill[r],
      ownWalkway: this.wWalk[r],
      ownCurtainFace: this.wBelow[r],
      farMasonry: this.wFarMasonry[r],
      meanSelfLifeS: this.wCrest[r] + this.wSill[r] + this.wWalk[r] + this.wBelow[r]
        ? +(this.wSelfLife[r] / (this.wCrest[r] + this.wSill[r] + this.wWalk[r] + this.wBelow[r])).toFixed(3)
        : null,
      meanSelfRangeM: this.wCrest[r] + this.wSill[r] + this.wWalk[r] + this.wBelow[r]
        ? +(this.wSelfRange[r] / (this.wCrest[r] + this.wSill[r] + this.wWalk[r] + this.wBelow[r])).toFixed(2)
        : null,
      selfWallOffCircuit: this.wSelfNoBay[r],
      meanSelfOffM: this.wSelfOn[r] ? +(this.wSelfOff[r] / this.wSelfOn[r]).toFixed(2) : null,
      meanSelfAlongM: this.wSelfOn[r] ? +(this.wSelfRun[r] / this.wSelfOn[r]).toFixed(2) : null,
      meanSelfUpM: this.wCrest[r] + this.wSill[r] + this.wWalk[r] + this.wBelow[r]
        ? +(this.wSelfUp[r] / (this.wCrest[r] + this.wSill[r] + this.wWalk[r] + this.wBelow[r])).toFixed(2)
        : null,
    });
    const rows = [];
    for (let r = 0; r < WALL_DIAG_RANKS; r++) if (this.wLaunched[r] > 0) rows.push(rank(r));
    const sum = (a: Int32Array) => a.reduce((s, v) => s + v, 0);
    const launched = sum(this.wLaunched);
    const selfWall = sum(this.wCrest) + sum(this.wSill) + sum(this.wWalk) + sum(this.wBelow);
    return {
      byRank: rows,
      skips: {
        noBattlement: this.wSkip[1], notOnThisWalk: this.wSkip[2], zeroRange: this.wSkip[3],
        shootingInward: this.wSkip[4], outboardOfParapet: this.wSkip[5], crestBelowShoulder: this.wSkip[6],
      },
      total: {
        launched,
        steppedToGap: sum(this.wStepped),
        elevationFloored: sum(this.wFloored),
        hitMan: sum(this.wHitMan),
        hitOwnSide: sum(this.wFriendly),
        killed: sum(this.wKilled),
        intoGround: sum(this.wGround),
        ownMerlon: sum(this.wCrest),
        ownSill: sum(this.wSill),
        ownWalkway: sum(this.wWalk),
        ownCurtainFace: sum(this.wBelow),
        farMasonry: sum(this.wFarMasonry),
        selfWall,
        selfWallPct: launched ? +((100 * selfWall) / launched).toFixed(1) : 0,
      },
    };
  }

  /**
   * Who a missile hit that it should not have, and how far from the muzzle it happened.
   *
   * The one number this exists to separate: a friendly casualty 0.9 m from the release point
   * and a friendly casualty 40 m from it are two different bugs with two different fixes, and
   * `hitOwnSide` pooled them.
   */
  debugFriendlyFire(): unknown {
    const band = (a: Int32Array, arc: number): number[] =>
      Array.from({ length: FF_BINS }, (_, k) => a[arc * FF_BINS + k]);
    const sum = (a: Int32Array): number => a.reduce((s, v) => s + v, 0);
    const hits = sum(this.ffDist);
    const all = sum(this.ffAllDist);
    return {
      // Edges, printed with the data so a reader never has to find them in the source.
      distEdgesM: [...FF_BAND_M],
      timeEdgesS: [...FF_BAND_S],
      shaft: {
        friendlyByDist: band(this.ffDist, 0),
        friendlyKillsByDist: band(this.ffKillDist, 0),
        allHitsByDist: band(this.ffAllDist, 0),
        friendlyByTime: band(this.ffTime, 0),
      },
      lofted: {
        friendlyByDist: band(this.ffDist, 1),
        friendlyKillsByDist: band(this.ffKillDist, 1),
        allHitsByDist: band(this.ffAllDist, 1),
        friendlyByTime: band(this.ffTime, 1),
      },
      // kindIdx, life s, ground metres from the muzzle, speed, shooter rank, victim rank,
      // shooter unit, victim unit, muzzle Y, victim foot Y, off a wall.
      sampleFields: 'kind life distM speed srcRank dstRank srcUnit dstUnit srcY dstY wall',
      kindNames: [...this.kinds],
      samples: this.ffSample.slice(),
      total: {
        hitsOnMen: all,
        friendlyHits: hits,
        friendlyKills: sum(this.ffKillDist),
        friendlyPct: all ? +((100 * hits) / all).toFixed(1) : 0,
        enemyHits: this.ffEnemy[0],
        enemyKills: this.ffEnemy[1],
        fromWallHits: this.ffWall[0],
        fromWallKills: this.ffWall[1],
        sameUnit: this.ffSameUnit[0],
        otherFriendlyUnit: this.ffSameUnit[1],
        sameUnitAhead: this.ffSameUnit[2],
        blastHits: this.allBlast[0],
        blastKills: this.allBlast[1],
        blastFriendlyHits: this.ffBlast[0],
        blastFriendlyKills: this.ffBlast[1],
      },
    };
  }

  /** Reset the census, so a probe can measure one interval rather than the whole battle. */
  debugResetCensus(): void {
    this.ffDist.fill(0); this.ffTime.fill(0); this.ffKillDist.fill(0);
    this.ffAllDist.fill(0); this.ffHitKind.fill(0); this.ffKillKind.fill(0);
    this.ffSameUnit.fill(0); this.ffWall.fill(0);
    this.ffBlast.fill(0); this.allBlast.fill(0); this.ffEnemy.fill(0);
    this.ffSample.length = 0; this.ffSampleAt = 0;
    this.wLaunched.fill(0); this.wHitMan.fill(0); this.wKilled.fill(0);
    this.wGround.fill(0); this.wCrest.fill(0); this.wSill.fill(0);
    this.wWalk.fill(0); this.wBelow.fill(0); this.wFarMasonry.fill(0);
    this.wSelfLife.fill(0); this.wSelfRange.fill(0);
    this.wSelfOff.fill(0); this.wSelfUp.fill(0); this.wSelfRun.fill(0);
    this.wSelfNoBay.fill(0); this.wSelfOn.fill(0);
    this.wSkip.fill(0); this.wFriendly.fill(0);
    this.wStepped.fill(0); this.wFloored.fill(0);
    this.cLaunched.fill(0); this.cHitMan.fill(0); this.cBlocked.fill(0);
    this.cKilled.fill(0); this.cGround.fill(0); this.cMasonry.fill(0);
    this.cDamage.fill(0); this.cMiss.fill(0); this.cMissN.fill(0);
    this.cUnreachable.fill(0);
    this.masonryHits = 0;
  }

  dispose(): void {
    for (const m of this.flightMesh) m?.dispose();
    for (const m of this.stuckMesh) m?.dispose();
    for (const g of this.geometries) g.dispose();
    this.flightMesh.length = 0;
    this.stuckMesh.length = 0;
    this.geometries.length = 0;
    this.material?.dispose();
    POOL = null;
  }
}
