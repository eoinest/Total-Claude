import type { EngineContext, Subsystem } from '../core/Engine';
import { Rng } from '../util/rand';
import { clamp, clamp01, damp, turnToward, wrapAngle } from '../util/math';
import {
  BASE_SPACING_X, BASE_SPACING_Z, closestPointOnSegment, formation, frontSegment, makeSegment,
  ranksFor, segmentDistance,
} from './formations';
import { unitType, isCavalry } from '../units/roster';
import type { TerrainSystem } from '../terrain/TerrainSystem';
import {
  Clip, Faction, MeleeAction, SoldierPool, SoldierState, SpatialHash, UnitOrder,
  isAlive, type UnitGroupState, type UnitTypeDef,
} from './types';

/**
 * The battle simulation hub.
 *
 * Owns the soldier pool and the unit groups, and runs the per-tick pipeline:
 *   1. rebuild the spatial hash
 *   2. per-unit order resolution (where does this formation want to be?)
 *   3. per-soldier steering toward its formation slot, plus crowd separation
 *   4. melee acquisition and resolution
 *   5. morale, fatigue and rout checks
 *
 * Combat resolution, morale and AI are refined by their own subsystems, which read
 * and write this state through the accessors below rather than owning parallel copies.
 */

const SCRATCH = { x: 0, z: 0 };

const AIM = { x: 0, z: 0 };
const SEG_SELF = makeSegment();
const SEG_OTHER = makeSegment();

/**
 * Front-to-front distance at which two formations are locked together and stop
 * advancing. 1.0 m of centre-to-centre separation with a 0.84 m body diameter is
 * shields touching — the point at which a Rome II line stops and starts grinding.
 */
const CONTACT_ENTER = 1.6;
/** And the distance it must open back up to before either is free to advance again. */
const CONTACT_EXIT = 4.5;
/**
 * Metres the anchors are held apart while locked. Separation is what stops ranks
 * interpenetrating now, and it holds a hard 0.84 m, so this no longer has to: at 1.0 m the
 * front ranks were told to stand further apart than two men can physically be, which left a
 * lane of open ground down the contact line and half the front rank with nothing in reach.
 */
const CONTACT_GAP = 0.55;
/**
 * How fast an unengaged man closes up into the press, in metres per second. A rank
 * three men back covers the 3 m to the front line in about three seconds, which is
 * what fills the hole a dead front-ranker leaves.
 */
const PRESS_RATE = 1.1;
/** And how fast the block opens back out into ranks once the fight is over. */
const PRESS_RELAX = 1.6;
/**
 * How deep the press may reach, in **ranks**.
 *
 * Bounded, because unbounded it is not a press but a collapse: every rank walks onto the
 * contact line, the two blocks interleave, and both units fight with every man at once.
 * Two and a half ranks closing up is what fills the hole a dead front-ranker leaves; the
 * ranks behind that stay in formation and wait, which is what a formation is for.
 *
 * In ranks and not metres, because the two are wildly different for cavalry: a horse
 * occupies 2.95 m of depth against an infantryman's 1.02. A flat 2.5 m limit let a
 * wedge's second row close up by less than one horse-length, so once its leading two rows
 * had been killed on a spear wall the remaining fifty riders physically could not reach
 * anything — measured as a dead stop with the fronts half a metre apart, zero men on
 * either side fighting, and the engagement never resolving.
 */
const PRESS_RANKS = 2.5;
/**
 * Rank interval a pressing formation closes *to*, in metres. The press used to let a man
 * close his whole setback, which puts every rank on the contact line and is not a press but
 * a heap: measured with 97% of the men in a melee standing inside their neighbour's 0.84 m
 * body. He now closes to a tight rank rather than onto the back of the man in front.
 */
const PRESS_TIGHT_Z = 1.02;
/**
 * Seconds an order suppresses the contact lock. Long enough to clear CONTACT_EXIT (4.5 m)
 * at a walk — a disengaging formation needs about three seconds — and short enough that a
 * unit ordered *into* a fight still locks up promptly on arrival.
 */
const ORDER_GRACE = 3.2;

/** Centre to centre at which two men touch. A man is half a metre across the shoulders. */
const BODY_DIAMETER = 0.84;
/**
 * Fraction of an overlap separation removes per tick, and the ceiling on one man's whole
 * correction. Half was not enough: slot-seeking and the press pull inward every tick, so
 * equilibrium sat 0.11 m inside contact and a melee compressed into a solid mass. The ceiling
 * exists because six neighbours mean six corrections at once.
 */
const SEPARATION_RELAX = 0.85;
const SEP_MAX_STEP = 0.16;

let SEP_POOL: SoldierPool | null = null;
let SEP_MOUNTED: Uint8Array | null = null;
let SEP_I = -1;
let SEP_X = 0;
let SEP_Z = 0;
let SEP_MI = 1;
let SEP_PUSH_X = 0;
let SEP_PUSH_Z = 0;

const separationVisit = (j: number): void => {
  if (j <= SEP_I) return;
  const p = SEP_POOL!;
  const st = p.state[j];
  if (st === SoldierState.Dead || st === SoldierState.Dying) return;
  const dx = p.x[j] - SEP_X;
  const dz = p.z[j] - SEP_Z;
  const d2 = dx * dx + dz * dz;
  if (d2 >= BODY_DIAMETER * BODY_DIAMETER || d2 < 1e-8) return;
  const d = Math.sqrt(d2);
  const overlap = (BODY_DIAMETER - d) * SEPARATION_RELAX;
  const nx = dx / d;
  const nz = dz / d;
  const mj = SEP_MOUNTED![j] ? 5 : 1;
  const total = SEP_MI + mj;
  const si = overlap * (mj / total);
  const sj = overlap * (SEP_MI / total);
  SEP_PUSH_X -= nx * si;
  SEP_PUSH_Z -= nz * si;
  p.x[j] += nx * sj;
  p.z[j] += nz * sj;
};

export class BattleSystem implements Subsystem {
  readonly name = 'battle';
  readonly order = 10;

  pool!: SoldierPool;
  units: UnitGroupState[] = [];
  hash!: SpatialHash;
  rng = new Rng('battle-271');

  private terrain?: TerrainSystem;
  private ctx!: EngineContext;
  private nextUnitId = 0;
  /** Per-faction living soldier tally, refreshed each tick. */
  readonly strength: Record<number, number> = { 0: 0, 1: 0 };

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.terrain = ctx.tryGet<TerrainSystem>('terrain');
    this.pool = new SoldierPool(ctx.quality.maxSoldiers);
    this.mounted = new Uint8Array(ctx.quality.maxSoldiers);
    this.orderGrace = new Float32Array(256);
    this.breakingOff = new Uint8Array(256);
    this.press = new Float32Array(ctx.quality.maxSoldiers);
    // 2.0 m cells. The separation pass asks for everything within 0.84 m once per man per
    // tick, and at 3.5 m cells that scanned 37 candidates to find 6. The rebuild can afford
    // the finer grid because it only ever touches the rectangle the armies stand on.
    this.hash = new SpatialHash(1500, 2.0);

    ctx.events.on('orderIssued', (o) => this.applyOrder(o));
  }

  // -------------------------------------------------------------------------
  // Army construction
  // -------------------------------------------------------------------------

  /**
   * Global multiplier on every unit's roster strength — the equivalent of Total War's
   * unit-size setting. The roster's numbers are authored at a readable baseline; a
   * scenario raises this to fill the field. Set before spawning; changing it afterwards
   * has no effect on units already deployed.
   */
  unitSizeScale = 1;

  /**
   * Spawn a unit group with its front rank centred on (x, z), facing `facing`.
   * Returns the new unit's id, or -1 if the soldier pool is full.
   */
  spawnUnit(typeId: string, x: number, z: number, facing: number, formationId?: string): number {
    const def = unitType(typeId);
    const fdef = formation(formationId ?? def.formations[0]);
    // Artillery crews are a fixed establishment — a scorpion needs two men whatever the
    // unit-size setting — so they do not scale.
    const scale = def.unitClass === 'artillery' ? 1 : this.unitSizeScale;
    const strength = Math.max(1, Math.round(def.strength * scale));
    const width = fdef.width(strength);

    const u: UnitGroupState = {
      id: this.nextUnitId++,
      typeId,
      faction: def.faction,
      members: [],
      alive: 0,
      initialStrength: strength,
      x, z, facing,
      targetX: x, targetZ: z, targetFacing: facing,
      order: UnitOrder.Hold,
      targetUnitId: -1,
      waypoints: [],
      running: false,
      formationId: fdef.id,
      width,
      spacingX: this.baseSpacingX(def) * fdef.spacingXMul,
      spacingZ: this.baseSpacingZ(def) * fdef.spacingZMul,
      morale: def.morale,
      maxMorale: def.morale,
      fatigue: 0,
      ammo: def.missile?.ammo ?? 0,
      engaged: false,
      chargeTimer: 0,
      contactLock: false,
      charging: false,
      routTimer: 0,
      kills: 0,
      destroyed: false,
      selected: false,
      concealed: false,
    };

    const ranks = ranksFor(strength, width);
    const rng = this.rng.fork(`unit${u.id}`);
    const mounted = isCavalry(def);

    for (let s = 0; s < strength; s++) {
      const i = this.pool.alloc();
      if (i < 0) break;
      u.members.push(i);

      fdef.offset(SCRATCH, s, width, ranks, u.spacingX, u.spacingZ);
      const [wx, wz] = this.localToWorld(u, SCRATCH.x, SCRATCH.z);

      const p = this.pool;
      p.x[i] = wx;
      p.z[i] = wz;
      p.y[i] = this.groundAt(wx, wz);
      p.px[i] = wx; p.pz[i] = wz; p.py[i] = p.y[i];
      p.vx[i] = 0; p.vz[i] = 0; p.vy[i] = 0;
      p.facing[i] = facing;
      p.prevFacing[i] = facing;
      p.lean[i] = 0;

      p.unitId[i] = u.id;
      p.faction[i] = def.faction;
      p.slot[i] = s;
      p.rank[i] = Math.min(255, Math.floor(s / width));
      p.file[i] = Math.min(255, s % width);

      // One hit point per man; damage accumulates until a blow finishes him.
      p.maxHp[i] = 100;
      p.hp[i] = 100;
      p.state[i] = SoldierState.Idle;
      p.stateTime[i] = rng.range(0, 3);
      p.target[i] = -1;
      p.attackCooldown[i] = rng.range(0, 1 / def.attackRate);
      p.fatigue[i] = 0;
      p.ammo[i] = def.missile?.ammo ?? 0;

      p.animClip[i] = Clip.IdleAlert;
      p.animTime[i] = rng.next();
      p.animPrevClip[i] = Clip.IdleAlert;
      p.animPrevTime[i] = 0;
      p.animBlend[i] = 1;
      // +/-8% rate so a hundred idle men never breathe in unison.
      p.animRate[i] = rng.range(0.92, 1.08);

      p.scale[i] = def.appearance.heightScale * rng.range(0.965, 1.035);
      p.variant[i] = rng.next();
      p.grime[i] = rng.range(0, 0.12);
      p.deathVariant[i] = rng.int(0, 3);
      p.deathDirX[i] = 0;
      p.deathDirZ[i] = 0;
      this.mounted[i] = mounted ? 1 : 0;
    }

    u.alive = u.members.length;
    u.initialStrength = u.members.length;
    this.units.push(u);
    return u.id;
  }

  /**
   * 0.95 m laterally is Polybius' three Roman feet per man plus the room to use a sword: at
   * the 0.86 m this was, a scutum went through the man beside him. 1.32 m front to back
   * matters more, because a scutum stands 0.75 m off its owner's chest and at 1.02 m of rank
   * interval it reached into the back of the man in front.
   */
  private baseSpacingX(def: UnitTypeDef): number {
    return isCavalry(def) ? BASE_SPACING_X.mounted : BASE_SPACING_X.foot;
  }
  private baseSpacingZ(def: UnitTypeDef): number {
    return isCavalry(def) ? BASE_SPACING_Z.mounted : BASE_SPACING_Z.foot;
  }

  /** Transform a formation-local offset into world space. */
  private localToWorld(u: UnitGroupState, lx: number, lz: number): [number, number] {
    const s = Math.sin(u.facing);
    const c = Math.cos(u.facing);
    return [u.x + lx * c + lz * s, u.z - lx * s + lz * c];
  }

  groundAt(x: number, z: number): number {
    return this.terrain?.heightAt(x, z) ?? 0;
  }

  unitById(id: number): UnitGroupState | undefined {
    return this.units.find((u) => u.id === id);
  }

  typeOf(u: UnitGroupState): UnitTypeDef {
    return unitType(u.typeId);
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  private applyOrder(o: {
    unitIds: number[];
    kind: string;
    x?: number; z?: number; facing?: number;
    targetUnitId?: number; formation?: string;
    width?: number;
    queued?: boolean; running?: boolean;
  }): void {
    for (const id of o.unitIds) {
      const u = this.unitById(id);
      if (!u || u.destroyed) continue;

      // Any order that changes the unit's destination breaks contact. Without this the
      // geometric lock re-asserts on the next tick and the order is silently discarded.
      if (o.kind === 'move' || o.kind === 'attackMove' || o.kind === 'attack' || o.kind === 'halt') {
        this.growUnitScratch(u.id + 1);
        u.contactLock = false;
        u.charging = false;
        this.orderGrace[u.id] = ORDER_GRACE;
      }

      switch (o.kind) {
        case 'move':
        case 'attackMove': {
          if (o.x === undefined || o.z === undefined) break;
          if (o.queued) {
            u.waypoints.push(o.x, o.z, o.facing ?? u.targetFacing);
          } else {
            u.waypoints.length = 0;
            u.targetX = o.x;
            u.targetZ = o.z;
            if (o.facing !== undefined) u.targetFacing = o.facing;
            else u.targetFacing = Math.atan2(o.x - u.x, o.z - u.z);
          }
          u.order = o.kind === 'attackMove' ? UnitOrder.AttackMove : UnitOrder.MoveTo;
          u.running = !!o.running;
          u.targetUnitId = -1;
          // A right-click-drag sets frontage as well as destination. Reading it here means
          // the UI no longer has to reach in and write `u.width` itself.
          if (o.width !== undefined && o.width > 0) {
            u.width = Math.max(1, Math.round(o.width));
          }
          break;
        }
        case 'attack': {
          if (o.targetUnitId === undefined) break;
          u.order = UnitOrder.AttackUnit;
          u.targetUnitId = o.targetUnitId;
          u.running = true;
          u.waypoints.length = 0;
          break;
        }
        case 'halt': {
          u.order = UnitOrder.Hold;
          u.targetX = u.x;
          u.targetZ = u.z;
          u.targetUnitId = -1;
          u.waypoints.length = 0;
          break;
        }
        case 'facing': {
          if (o.facing !== undefined) u.targetFacing = o.facing;
          break;
        }
        case 'formation': {
          if (o.formation) this.setFormation(u, o.formation);
          break;
        }
        case 'ability':
          // Deliberately a no-op here: AbilitySystem subscribes to `orderIssued`
          // directly and owns cooldowns, durations and stat modifiers. Listed so the
          // contract is explicit rather than looking like an unhandled case.
          break;
      }
    }
  }

  setFormation(u: UnitGroupState, id: string): void {
    const def = this.typeOf(u);
    if (!def.formations.includes(id)) return;
    const f = formation(id);
    u.formationId = id;
    u.width = f.width(u.alive || u.initialStrength);
    u.spacingX = this.baseSpacingX(def) * f.spacingXMul;
    u.spacingZ = this.baseSpacingZ(def) * f.spacingZMul;
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  fixedUpdate(dt: number, ctx: EngineContext): void {
    const p = this.pool;
    p.savePrevious();
    this.hash.rebuild(p);

    this.strength[Faction.Rome] = 0;
    this.strength[Faction.Germanic] = 0;

    for (const u of this.units) {
      if (u.destroyed) continue;
      this.updateUnitOrder(u, dt);
      this.updateUnitCohesion(u);
      this.strength[u.faction] += u.alive;
    }

    this.steerSoldiers(dt);
    this.integrate(dt);
    this.resolveCrowding();
    this.settleSoldiers(dt);
    this.updateAnimationState(dt, ctx);
  }

  /**
   * Front-to-front distance to the nearest enemy formation, metres, refreshed every
   * tick. Kept here rather than on `UnitGroupState` so the shape of the shared unit
   * record — which several subsystems construct in tests — does not grow.
   */
  private frontGaps = new Float32Array(64).fill(Infinity);
  private frontEnemies = new Int32Array(64).fill(-1);
  /** The direction a broken unit committed to running in. Zero when it is not routing. */
  private routDirX = new Float32Array(64);
  private routDirZ = new Float32Array(64);
  /** Seconds before a broken unit may pick a new direction to run in. */
  private routHold = new Float32Array(64);

  private growUnitScratch(n: number): void {
    if (this.frontGaps.length >= n) return;
    const size = Math.max(n, this.frontGaps.length * 2);
    const g = new Float32Array(size).fill(Infinity);
    g.set(this.frontGaps);
    this.frontGaps = g;
    const e = new Int32Array(size).fill(-1);
    e.set(this.frontEnemies);
    this.frontEnemies = e;
    const rx = new Float32Array(size);
    rx.set(this.routDirX);
    this.routDirX = rx;
    const rz = new Float32Array(size);
    rz.set(this.routDirZ);
    this.routDirZ = rz;
    const rh = new Float32Array(size);
    rh.set(this.routHold);
    this.routHold = rh;
    const og = new Float32Array(size);
    og.set(this.orderGrace);
    this.orderGrace = og;
    const bo = new Uint8Array(size);
    bo.set(this.breakingOff);
    this.breakingOff = bo;
  }

  /** Metres between this unit's front rank and the nearest enemy's. */
  frontGapOf(unitId: number): number {
    return this.frontGaps[unitId] ?? Infinity;
  }

  /** The enemy unit whose front rank is nearest, or -1. */
  frontEnemyOf(unitId: number): number {
    return this.frontEnemies[unitId] ?? -1;
  }

  /** Half the frontage of a unit's front rank, in metres. */
  frontHalf(u: UnitGroupState): number {
    const men = Math.max(1, Math.min(u.width, u.alive));
    return Math.max(1.2, men * formation(u.formationId).frontMul * u.spacingX * 0.5);
  }

  /**
   * Front-to-front distance to the nearest enemy formation, and the unit id it belongs
   * to. Anchors lie about contact: two cohorts standing shoulder to shoulder have
   * anchors twenty metres apart and front ranks touching, while two blocks that have
   * slid through each other have coincident anchors and are fighting nobody in front.
   * Everything about meeting an enemy is measured between the front-rank *segments*.
   */
  private nearestEnemyFront(u: UnitGroupState): { dist: number; id: number } {
    frontSegment(u.x, u.z, u.facing, this.frontHalf(u), SEG_SELF);
    let best = Infinity;
    let bestId = -1;
    for (const o of this.units) {
      if (o.destroyed || o.faction === u.faction || o.alive === 0) continue;
      if (o.order === UnitOrder.Rout) continue;
      // Cheap reject before the segment maths.
      const cx = o.x - u.x;
      const cz = o.z - u.z;
      const reach = 60 + this.frontHalf(u) + this.frontHalf(o);
      if (cx * cx + cz * cz > reach * reach) continue;
      frontSegment(o.x, o.z, o.facing, this.frontHalf(o), SEG_OTHER);
      const d = segmentDistance(SEG_SELF, SEG_OTHER);
      if (d < best) {
        best = d;
        bestId = o.id;
      }
    }
    return { dist: best, id: bestId };
  }

  /** Move the formation anchor toward its objective and consume waypoints. */
  private updateUnitOrder(u: UnitGroupState, dt: number): void {
    const def = this.typeOf(u);
    const routing = u.order === UnitOrder.Rout;

    // ---- contact lock -------------------------------------------------------
    // Geometric, hysteretic, and owned here rather than in Combat: this is the flag
    // that stops a formation advancing, and the advance lives in this function. Combat
    // mirrors it onto the shared blackboard and adds the blows-are-landing case.
    this.growUnitScratch(u.id + 1);
    const near = routing ? { dist: Infinity, id: -1 } : this.nearestEnemyFront(u);
    this.frontGaps[u.id] = near.dist;
    this.frontEnemies[u.id] = near.id;
    const grace = this.orderGrace[u.id] > 0;
    if (grace) this.orderGrace[u.id] = Math.max(0, this.orderGrace[u.id] - dt);

    if (routing || grace) {
      u.contactLock = false;
    } else if (u.contactLock) {
      if (near.dist > CONTACT_EXIT) {
        u.contactLock = false;
        // Release with the anchor where the shoving match left it, not where the order
        // that brought the unit here was aiming.
        if (u.order === UnitOrder.Hold) {
          u.targetX = u.x;
          u.targetZ = u.z;
        }
      }
    } else if (near.dist < CONTACT_ENTER) {
      u.contactLock = true;
    }

    // Chasing a specific enemy unit: aim at the nearest point of its frontage.
    if (u.order === UnitOrder.AttackUnit) {
      const t = this.unitById(u.targetUnitId);
      if (!t || t.destroyed || t.alive === 0) {
        u.order = UnitOrder.Hold;
        u.targetUnitId = -1;
        u.targetX = u.x;
        u.targetZ = u.z;
      } else if (!u.contactLock) {
        frontSegment(t.x, t.z, t.facing, this.frontHalf(t), SEG_OTHER);
        closestPointOnSegment(u.x, u.z, SEG_OTHER, AIM);
        const dx = AIM.x - u.x;
        const dz = AIM.z - u.z;
        const d = Math.hypot(dx, dz) || 1;
        // Stop with the fronts a shield's width apart. `resolveCrowding` and the press
        // then close the last few centimetres, which is what makes the seam ragged.
        const standoff = CONTACT_GAP;
        u.targetX = AIM.x - (dx / d) * standoff;
        u.targetZ = AIM.z - (dz / d) * standoff;
        u.targetFacing = Math.atan2(dx, dz);
      }
    }

    if (routing) {
      u.routTimer += dt;
      // Flee away from the enemy's centre of mass — but commit to a direction. Recomputed
      // every tick, the threat bearing swings as pursuing cavalry rides around the mob,
      // and the unit turns at the rate limit for the whole flight: measured 68 degrees a
      // second of pure spin on broken warbands. Men running for their lives run in a
      // straight line; they only change their minds when something gets in the way.
      const away = this.threatDirection(u);
      const cx = this.routDirX[u.id];
      const cz = this.routDirZ[u.id];
      const committed = cx !== 0 || cz !== 0;
      // 0.34 is about 70 degrees: a genuinely new threat, not the same one drifting. And
      // never more than once every three seconds, because a horseman circling a broken mob
      // can drag the threat bearing past 70 degrees again and again, and each re-aim costs
      // the whole unit another turn.
      this.routHold[u.id] = Math.max(0, this.routHold[u.id] - dt);
      if (!committed || (this.routHold[u.id] <= 0 && away.x * cx + away.z * cz < 0.34)) {
        this.routDirX[u.id] = away.x;
        this.routDirZ[u.id] = away.z;
        this.routHold[u.id] = 3;
      }
      u.targetX = u.x + this.routDirX[u.id] * 60;
      u.targetZ = u.z + this.routDirZ[u.id] * 60;
      u.targetFacing = Math.atan2(this.routDirX[u.id], this.routDirZ[u.id]);
    } else if (this.routDirX[u.id] !== 0 || this.routDirZ[u.id] !== 0) {
      this.routDirX[u.id] = 0;
      this.routDirZ[u.id] = 0;
    }

    const dx = u.targetX - u.x;
    const dz = u.targetZ - u.z;
    const distToTarget = Math.hypot(dx, dz);

    // Locked in contact: hold the anchor and only pivot, slowly. `Combat.resolvePush`
    // is the only thing allowed to move the anchor from here, so a line that is losing
    // gives ground and a line that is winning walks forward, and neither slides
    // sideways chasing the other's centre.
    //
    // But the lock exists to stop two lines walking *through* each other, not to pin a
    // unit that has been told to leave. If the order sends it away from the enemy it is
    // locked with, let it go — otherwise a pursued unit is frozen the instant its pursuer
    // catches up, and a withdraw order can never be carried out. A timed grace was not
    // enough: the unit broke off, moved five metres, was caught, and stopped again.
    let breakingOff = false;
    if (u.contactLock && distToTarget > 0.35) {
      const eid = this.frontEnemies[u.id];
      const e = eid >= 0 ? this.unitById(eid) : undefined;
      if (!e) breakingOff = true;
      else {
        // Positive dot = the ordered move closes on the enemy; negative = it opens away.
        const toE = Math.hypot(e.x - u.x, e.z - u.z) || 1;
        const dot = ((e.x - u.x) / toE) * (dx / distToTarget)
                  + ((e.z - u.z) / toE) * (dz / distToTarget);
        breakingOff = dot < -0.25;
      }
    }

    this.breakingOff[u.id] = breakingOff ? 1 : 0;

    if (u.contactLock && !breakingOff) {
      u.facing = turnToward(u.facing, u.targetFacing, dt * 0.35);
      const drain = u.engaged ? dt / (def.stamina * 2.4) : -dt / 26;
      u.fatigue = clamp01(u.fatigue + drain);
      if (u.chargeTimer > 0) u.chargeTimer = Math.max(0, u.chargeTimer - dt);
      return;
    }

    // Arrived: pop the next queued waypoint, else settle.
    if (distToTarget < 0.35) {
      if (u.waypoints.length >= 3) {
        u.targetX = u.waypoints.shift()!;
        u.targetZ = u.waypoints.shift()!;
        u.targetFacing = u.waypoints.shift()!;
      } else if (u.order === UnitOrder.MoveTo) {
        u.order = UnitOrder.Hold;
      }
    } else {
      const f = formation(u.formationId);
      const base = routing ? def.runSpeed * 1.06
        : u.charging ? def.chargeSpeed
        : u.running ? def.runSpeed
        : def.walkSpeed;
      // Fatigue and formation drag both bite into speed.
      const speed = base * f.mods.speed * (1 - u.fatigue * 0.42);

      // Face the direction of travel while moving; hold the ordered facing on arrival.
      const travelFacing = Math.atan2(dx, dz);
      const wantFacing = distToTarget > 4 ? travelFacing : u.targetFacing;
      u.facing = turnToward(u.facing, wantFacing, dt * 1.9);

      // A formation wheels; it does not strafe. Translating the anchor at full speed in
      // any direction while the heading independently chases a moving target is exactly
      // the recipe for a cyclic-pursuit spiral, and it is what made two units that met
      // orbit each other instead of fighting. Scaling the step by how much of the
      // heading points at the objective means a unit must turn before it can move, and
      // the path straightens out.
      const align = Math.cos(wrapAngle(u.facing - travelFacing));
      const heading = align > 0 ? 0.25 + 0.75 * align : Math.max(0.06, 0.25 + align * 0.19);
      let step = Math.min(distToTarget, speed * heading * dt);

      // Block collision: never walk the front rank through an enemy's. Routing units
      // are exempt — broken men go through anything — and so is anyone whose objective
      // takes them away from the enemy in front of them.
      if (!routing && near.dist < Infinity) {
        const closing = (dx / distToTarget) * Math.sin(u.targetFacing)
          + (dz / distToTarget) * Math.cos(u.targetFacing);
        if (closing > -0.2) step = Math.min(step, Math.max(0, near.dist - CONTACT_GAP));
      }

      u.x += (dx / distToTarget) * step;
      u.z += (dz / distToTarget) * step;
    }

    if (distToTarget <= 0.35) {
      // A formation standing still wheels *slowly* — 0.6 rad/s is a 180-degree about-face
      // in five seconds, which is about right for several hundred men and, more to the
      // point, bounds how badly a jittery facing order can read. At 1.5 rad/s a unit whose
      // ordered facing flipped between two threats span on the spot at 86 degrees a second
      // for the whole battle; that was measured at 2,578 degrees over thirty seconds.
      u.facing = turnToward(u.facing, u.targetFacing, dt * 0.6);
    }

    // Fatigue: running and fighting drain, standing still recovers.
    const exerting = distToTarget > 0.8 && (u.running || routing);
    const drain = exerting ? dt / Math.max(8, def.stamina) : u.engaged ? dt / (def.stamina * 2.4) : -dt / 26;
    u.fatigue = clamp01(u.fatigue + drain);

    if (u.chargeTimer > 0) u.chargeTimer = Math.max(0, u.chargeTimer - dt);
  }

  /** Direction pointing away from the nearest enemy mass. */
  private threatDirection(u: UnitGroupState): { x: number; z: number } {
    let ex = 0;
    let ez = 0;
    let n = 0;
    for (const o of this.units) {
      if (o.destroyed || o.faction === u.faction) continue;
      const d = Math.hypot(o.x - u.x, o.z - u.z);
      if (d > 220) continue;
      const w = 1 / Math.max(12, d);
      ex += (o.x - u.x) * w;
      ez += (o.z - u.z) * w;
      n++;
    }
    if (n === 0) return { x: 0, z: -1 };
    const l = Math.hypot(ex, ez) || 1;
    return { x: -ex / l, z: -ez / l };
  }

  /** Refresh living count, prune the dead from the roster, and check for destruction. */
  private updateUnitCohesion(u: UnitGroupState): void {
    const p = this.pool;
    let alive = 0;
    for (const i of u.members) if (isAlive(p.state[i] as SoldierState)) alive++;
    u.alive = alive;

    if (alive === 0 && !u.destroyed) {
      u.destroyed = true;
      this.ctx.events.emit('unitDestroyed', { unitId: u.id, faction: u.faction });
      return;
    }
    // A routed unit leaves the field once it is genuinely out of the fight. Requiring it
    // to reach the map edge (±1280 m) took over three minutes of flight at 4.4 m/s, so
    // broken units loitered mid-field for the rest of the battle and the engagement never
    // resolved. "Escaped" is better defined as distance from the nearest enemy: a unit
    // 260 m clear with nobody chasing it has left the battle in every sense that matters.
    if (u.order === UnitOrder.Rout && u.routTimer > 18) {
      const edge = Math.abs(u.x) > 1180 || Math.abs(u.z) > 1180;
      let nearestEnemy = Infinity;
      for (const o of this.units) {
        if (o.destroyed || o.faction === u.faction || o.order === UnitOrder.Rout) continue;
        const d = Math.hypot(o.x - u.x, o.z - u.z);
        if (d < nearestEnemy) nearestEnemy = d;
      }
      if (edge || nearestEnemy > 260) {
        u.destroyed = true;
        // Its men have quit the field, so retire them from the simulation rather than
        // leaving them alive-but-unsteered. `steerSoldiers` skips destroyed units, so
        // without this the unit's anchor stops tracking its men — one unit's anchor was
        // measured 770 m away from where its soldiers actually were — while 2,220 living
        // men stayed in the spatial hash and in every faction strength tally.
        for (const i of u.members) {
          if (p.aliveAt(i)) p.setState(i, SoldierState.Dead);
        }
        u.alive = 0;
        this.ctx.events.emit('unitDestroyed', { unitId: u.id, faction: u.faction });
      }
    }
  }

  /** Drive each soldier toward his formation slot. */
  private steerSoldiers(dt: number): void {
    const p = this.pool;
    for (const u of this.units) {
      if (u.destroyed) continue;
      const def = this.typeOf(u);
      const f = formation(u.formationId);
      const ranks = ranksFor(u.members.length, u.width);
      const routing = u.order === UnitOrder.Rout;

      const maxSpeed = (routing ? def.runSpeed * 1.06
        : u.charging ? def.chargeSpeed
        : u.running ? def.runSpeed
        : def.walkSpeed) * f.mods.speed * (1 - u.fatigue * 0.42);
      const accel = maxSpeed * 5.5;

      const s = Math.sin(u.facing);
      const c = Math.cos(u.facing);
      // A formation in contact is a press, not a parade. Men behind the fighting line
      // close up into it, which is the only thing that fills the hole a dead
      // front-ranker leaves: on slot-seeking alone the second rank stays 1 m back, out
      // of every weapon's reach, and a unit whose front rank has been killed stops
      // fighting altogether while still nominally engaged.
      const pressing = u.contactLock && !routing;
      const pressLimit = PRESS_RANKS * u.spacingZ;
      // Share of his own setback a man gives up, which is what closes the rank interval from
      // `spacingZ` to `PRESS_TIGHT_Z`. A fraction rather than a per-rank figure because
      // `pool.rank` is a grid row and a wedge is a triangle: keyed off `rank`, a wedge's rows
      // all read as row 0, so the moment its two leading riders died the other fifty-eight
      // were frozen four metres short and a charge cost the spearmen nobody.
      //
      // Mounted units are exempt. A horse is 2.95 m long, so rank interval is not what keeps
      // horses out of each other; the press is the only thing that gets a second row of them
      // into reach at all.
      const pressFrac = isCavalry(def)
        ? 1
        : Math.max(0, 1 - PRESS_TIGHT_Z / Math.max(0.1, u.spacingZ));
      // While an order is breaking contact, men in melee must follow their slot like
      // everyone else. Holding them made a withdraw order physically impossible: the
      // anchor crept away but every front-ranker stayed where he was, so the unit moved
      // 1.8 m in three seconds, never cleared CONTACT_EXIT, and re-locked — which is what
      // "the units would not always listen to me" was.
      // Fighting men follow their slot while the unit is breaking contact — either inside
      // the post-order window, or because its orders are actively taking it away.
      const disengaging = this.orderGrace[u.id] > 0 || this.breakingOff[u.id] === 1;

      for (const i of u.members) {
        const st = p.state[i] as SoldierState;
        if (st === SoldierState.Dead || st === SoldierState.Dying) continue;
        // A man locked in melee holds his ground rather than chasing his slot — unless he
        // has been ordered out of it.
        if (st === SoldierState.Fighting && !disengaging) {
          this.press[i] = 0;
          p.vx[i] = damp(p.vx[i], 0, 9, dt);
          p.vz[i] = damp(p.vz[i], 0, 9, dt);
          continue;
        }
        if (st === SoldierState.Fighting && disengaging) {
          // Break off: drop the opponent and let the state machine pick a locomotion clip,
          // so the man visibly turns and walks out instead of swinging at nothing.
          p.target[i] = -1;
          p.setState(i, u.running ? SoldierState.Running : SoldierState.Marching);
        }

        f.offset(SCRATCH, p.slot[i], u.width, ranks, u.spacingX, u.spacingZ);
        if (pressing) {
          // Creep forward, but only as far as a tight rank, never past the front rank, and
          // never more than `pressLimit`.
          const own = Math.max(0, -SCRATCH.z * pressFrac);
          this.press[i] = Math.min(own, pressLimit, this.press[i] + PRESS_RATE * dt);
          SCRATCH.z += this.press[i];
        } else if (this.press[i] > 0) {
          this.press[i] = Math.max(0, this.press[i] - PRESS_RELAX * dt);
          SCRATCH.z += this.press[i];
        }
        const tx = u.x + SCRATCH.x * c + SCRATCH.z * s;
        const tz = u.z - SCRATCH.x * s + SCRATCH.z * c;

        const dx = tx - p.x[i];
        const dz = tz - p.z[i];
        const d = Math.hypot(dx, dz);

        if (d < 0.06) {
          p.vx[i] = damp(p.vx[i], 0, 11, dt);
          p.vz[i] = damp(p.vz[i], 0, 11, dt);
        } else {
          // Arrive behaviour: ease off in the last two metres so nobody overshoots
          // and oscillates around his slot.
          const want = Math.min(maxSpeed, d * 2.6);
          const wx = (dx / d) * want;
          const wz = (dz / d) * want;
          const k = 1 - Math.exp(-(accel / Math.max(0.2, maxSpeed)) * dt);
          p.vx[i] += (wx - p.vx[i]) * k;
          p.vz[i] += (wz - p.vz[i]) * k;
        }
      }
    }
  }

  /** Soft body separation. See `separationVisit` for the strength and why it moved here. */
  private resolveCrowding(): void {
    const p = this.pool;
    const n = p.count;
    SEP_POOL = p;
    SEP_MOUNTED = this.mounted;
    for (let i = 0; i < n; i++) {
      if (!p.aliveAt(i)) continue;
      SEP_I = i;
      SEP_X = p.x[i];
      SEP_Z = p.z[i];
      SEP_PUSH_X = 0;
      SEP_PUSH_Z = 0;
      SEP_MI = this.mounted[i] ? 5 : 1;
      this.hash.query(SEP_X, SEP_Z, BODY_DIAMETER, separationVisit);
      const l2 = SEP_PUSH_X * SEP_PUSH_X + SEP_PUSH_Z * SEP_PUSH_Z;
      if (l2 > SEP_MAX_STEP * SEP_MAX_STEP) {
        const g = SEP_MAX_STEP / Math.sqrt(l2);
        SEP_PUSH_X *= g;
        SEP_PUSH_Z *= g;
      }
      p.x[i] += SEP_PUSH_X;
      p.z[i] += SEP_PUSH_Z;
    }
  }

  /**
   * Seconds of immunity from the geometric contact lock, per unit.
   *
   * A locked formation ignores its move target — that is what stops two lines walking
   * through each other. But the lock is set from front-to-front distance alone, so once a
   * unit was engaged it could never be ordered out: the player's order cleared the flag and
   * the very next tick re-set it, because the enemy was still a metre and a half away. The
   * unit went on pursuing whatever it had hold of and read as disobedient, which is exactly
   * how it was reported.
   *
   * An order now buys a window in which the lock cannot re-assert, long enough to physically
   * walk out of contact. An order is the player overriding the situation; the situation must
   * not immediately override the order.
   */
  private orderGrace!: Float32Array;
  /** 1 while a unit's current order is taking it away from the enemy it is locked with. */
  private breakingOff!: Uint8Array;

  /** 1 if this soldier is mounted. Set at spawn; read in the crowd-separation inner loop. */
  private mounted!: Uint8Array;
  /** Metres this man has closed up into the press, forward of his formation slot. */
  private press!: Float32Array;

  /** Cache of soldier index -> unit, rebuilt lazily. */
  private soldierUnitCache: (UnitGroupState | undefined)[] = [];
  private unitOfSoldier(i: number): UnitGroupState | undefined {
    let u = this.soldierUnitCache[i];
    if (u && u.id === this.pool.unitId[i]) return u;
    u = this.unitById(this.pool.unitId[i]);
    this.soldierUnitCache[i] = u;
    return u;
  }

  private integrate(dt: number): void {
    const p = this.pool;
    const n = p.count;
    for (let i = 0; i < n; i++) {
      if (p.state[i] === SoldierState.Dead) continue;
      p.x[i] += p.vx[i] * dt;
      p.z[i] += p.vz[i] * dt;
    }
  }

  /** Ground, facing and lean, after separation has had the final say on x and z. */
  private settleSoldiers(dt: number): void {
    const p = this.pool;
    const n = p.count;
    for (let i = 0; i < n; i++) {
      const st = p.state[i] as SoldierState;
      if (st === SoldierState.Dead) continue;

      const ground = this.groundAt(p.x[i], p.z[i]);
      // Feet stay planted; the vertical is snapped rather than simulated for the living.
      p.y[i] = st === SoldierState.Dying ? Math.max(ground, p.y[i] - 1.8 * dt) : ground;

      // Face the direction of travel, but only once actually moving.
      const speed = Math.hypot(p.vx[i], p.vz[i]);
      if (speed > 0.22 && st !== SoldierState.Fighting) {
        const want = Math.atan2(p.vx[i], p.vz[i]);
        p.facing[i] = turnToward(p.facing[i], want, dt * 7.5);
      }
      // Lean into acceleration for weight.
      const targetLean = clamp(speed * 0.055, 0, 0.16);
      p.lean[i] = damp(p.lean[i], targetLean, 6, dt);
    }
  }

  /**
   * The clip for a man in a melee. The *choice* is the combat system's, because only it
   * knows whether he is striking, covering a blow it has seen coming, or getting his weapon
   * back after one was turned aside; this is the table that turns that into animation.
   */
  private meleeClipFor(i: number): Clip {
    switch (this.pool.meleeAction[i] as MeleeAction) {
      case MeleeAction.Thrust: return Clip.AttackThrust;
      case MeleeAction.Overhead: return Clip.AttackOverhead;
      case MeleeAction.Slash: return Clip.AttackSlash;
      case MeleeAction.Bash: return Clip.ShieldBash;
      case MeleeAction.Block: return Clip.Block;
      case MeleeAction.Parry: return Clip.Parry;
      case MeleeAction.Recover: return Clip.Stagger;
      default: return Clip.IdleBrace;
    }
  }

  /** Pick the clip each soldier should be playing and advance its playhead. */
  private updateAnimationState(dt: number, ctx: EngineContext): void {
    const p = this.pool;
    const n = p.count;

    for (let i = 0; i < n; i++) {
      const st = p.state[i] as SoldierState;
      p.stateTime[i] += dt;

      if (st === SoldierState.Dead) continue;

      let clip: Clip;
      let rateScale = 1;
      const speed = Math.hypot(p.vx[i], p.vz[i]);

      switch (st) {
        case SoldierState.Dying:
          clip = (Clip.DeathBack + (p.deathVariant[i] % 4)) as Clip;
          break;
        case SoldierState.Fighting:
          clip = this.meleeClipFor(i);
          break;
        case SoldierState.Bracing:
          clip = Clip.IdleBrace;
          break;
        case SoldierState.Routing:
          clip = Clip.Flee;
          rateScale = clamp(speed / 4.2, 0.7, 1.5);
          break;
        case SoldierState.Charging:
          clip = Clip.Charge;
          rateScale = clamp(speed / 5.0, 0.75, 1.4);
          break;
        case SoldierState.Throwing:
          clip = Clip.ThrowPilum;
          break;
        case SoldierState.Shooting:
          clip = Clip.ReleaseBow;
          break;
        case SoldierState.Staggered:
          clip = Clip.Stagger;
          break;
        default: {
          if (speed > 2.6) {
            clip = Clip.Run;
            rateScale = clamp(speed / 3.6, 0.75, 1.45);
          } else if (speed > 0.28) {
            clip = Clip.March;
            rateScale = clamp(speed / 1.55, 0.6, 1.5);
          } else {
            const u = this.unitOfSoldier(i);
            const pose = u ? formation(u.formationId).idlePose : 'alert';
            clip = pose === 'brace' ? Clip.IdleBrace : pose === 'relaxed' ? Clip.IdleRelaxed : Clip.IdleAlert;
          }
        }
      }

      if (p.animClip[i] !== clip) {
        p.animPrevClip[i] = p.animClip[i];
        p.animPrevTime[i] = p.animTime[i];
        p.animBlend[i] = 0;
        p.animClip[i] = clip;
        // Locomotion clips resume mid-cycle so a stop-start never resets the gait.
        p.animTime[i] = clip === Clip.March || clip === Clip.Run ? p.animTime[i] : 0;
      }

      // Cross-fade over ~0.18 s.
      if (p.animBlend[i] < 1) p.animBlend[i] = Math.min(1, p.animBlend[i] + dt / 0.18);

      const loop = st !== SoldierState.Dying;
      const adv = dt * p.animRate[i] * rateScale;
      p.animTime[i] += adv;
      if (loop) {
        if (p.animTime[i] >= 1) p.animTime[i] -= Math.floor(p.animTime[i]);
      } else if (p.animTime[i] >= 1) {
        p.animTime[i] = 1;
        // Death animation finished — become a corpse.
        p.state[i] = SoldierState.Dead;
      }
      p.animPrevTime[i] = (p.animPrevTime[i] + adv) % 1;
    }
    void ctx;
  }

  /**
   * Apply damage to a soldier. Returns true if the blow was lethal.
   * The combat subsystem calls this; it is the single place a man can die.
   */
  damage(i: number, amount: number, fromX: number, fromZ: number, attackerUnitId: number): boolean {
    const p = this.pool;
    if (!p.aliveAt(i)) return false;
    p.hp[i] -= amount;
    p.grime[i] = clamp01(p.grime[i] + amount * 0.004);
    if (p.hp[i] > 0) return false;

    const dx = p.x[i] - fromX;
    const dz = p.z[i] - fromZ;
    const l = Math.hypot(dx, dz) || 1;
    p.deathDirX[i] = dx / l;
    p.deathDirZ[i] = dz / l;
    p.setState(i, SoldierState.Dying);
    p.vx[i] = (dx / l) * 1.4;
    p.vz[i] = (dz / l) * 1.4;
    p.target[i] = -1;

    const killer = this.unitById(attackerUnitId);
    if (killer) killer.kills++;

    this.ctx.events.emit('soldierDied', {
      x: p.x[i], y: p.y[i], z: p.z[i],
      unitId: p.unitId[i], faction: p.faction[i], index: i,
    });
    return true;
  }

  /** Break a unit. Idempotent. */
  rout(u: UnitGroupState): void {
    if (u.order === UnitOrder.Rout || u.destroyed) return;
    u.order = UnitOrder.Rout;
    u.routTimer = 0;
    u.targetUnitId = -1;
    u.waypoints.length = 0;
    const p = this.pool;
    for (const i of u.members) {
      if (p.aliveAt(i)) p.setState(i, SoldierState.Routing);
    }
    this.ctx.events.emit('unitRouted', { unitId: u.id, faction: u.faction });
  }

  /**
   * Bring a broken unit back into order. The counterpart to `rout`, called by the morale
   * system once a routed unit has got clear, recovered its nerve and is not being chased.
   */
  rally(u: UnitGroupState): void {
    if (u.destroyed || u.order !== UnitOrder.Rout) return;
    u.order = UnitOrder.Hold;
    u.routTimer = 0;
    u.contactLock = false;
    u.charging = false;
    u.targetX = u.x;
    u.targetZ = u.z;
    const p = this.pool;
    for (const i of u.members) {
      if (p.aliveAt(i)) p.setState(i, SoldierState.Idle);
    }
    // Re-form on the spot rather than teleporting back to the line.
    this.setFormation(u, u.formationId);
    this.ctx.events.emit('unitRallied', { unitId: u.id, faction: u.faction });
  }

  /** Units of a faction that are still fighting. */
  activeUnits(faction?: Faction): UnitGroupState[] {
    return this.units.filter(
      (u) => !u.destroyed && (faction === undefined || u.faction === faction) && u.order !== UnitOrder.Rout
    );
  }

  /** Interpolated render position for a soldier, using the frame's `alpha`. */
  renderPos(i: number, alpha: number, out: { x: number; y: number; z: number }): void {
    const p = this.pool;
    out.x = p.px[i] + (p.x[i] - p.px[i]) * alpha;
    out.y = p.py[i] + (p.y[i] - p.py[i]) * alpha;
    out.z = p.pz[i] + (p.z[i] - p.pz[i]) * alpha;
  }

  renderFacing(i: number, alpha: number): number {
    const p = this.pool;
    return p.prevFacing[i] + wrapAngle(p.facing[i] - p.prevFacing[i]) * alpha;
  }
}
