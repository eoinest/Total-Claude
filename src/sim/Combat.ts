import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from './BattleSystem';
import { Clip, SoldierState, UnitOrder } from './types';
import type { ClipInfo, SoldierPool, UnitGroupState, UnitTypeDef } from './types';
import { formation } from './formations';
import type { FormationDef } from './formations';
import { isCavalry } from '../units/roster';
import { clamp, clamp01, turnToward, wrapAngle } from '../util/math';
import { hash01 } from '../util/rand';
import type { Rng } from '../util/rand';
import {
  ARMOUR_BITE, ASPECT_ARMOUR_BYPASS, ASPECT_DAMAGE, ASPECT_DEFENCE,
  Aspect, armourReduction, aspectOf, decaySignals, modsOf, resetCombatShared,
  shieldCoverage, signalsOf,
} from './combatShared';
import type { UnitMods } from './combatShared';

/**
 * Soldier-level melee.
 *
 * The model, in the order it is applied:
 *
 *  1. **Target acquisition.** A man looks for the nearest living enemy inside his
 *     weapon's reach, biased hard toward whatever is in front of him, and holds that
 *     opponent until it dies or slips out of reach. Acquisition is striped across
 *     ticks and goes through the battle's spatial hash — never an O(n²) sweep.
 *
 *  2. **Only the men who can reach.** Three limits, in order of authority: a man needs
 *     an enemy inside his weapon's reach; no opponent may have more than
 *     `CROWD_HARD_CAP` men on him; and a formation may put no more men into the fight
 *     than `ENGAGE_PER_WIDTH` per metre of its own frontage. The last is the one that
 *     makes frontage decide a melee, which is how Total War works — without it two
 *     blocks that have pressed into each other interleave and fight with every man at
 *     once, and a whole block flailing is the single biggest tell that a melee is fake.
 *     Men behind the fighting line close up into it (`BattleSystem`'s press), so the
 *     hole a dead front-ranker leaves is filled rather than ending the fight.
 *
 *  3. **Blows timed to the animation.** A swing starts when the attack cooldown
 *     expires, and the blow lands at `clipInfo(AttackThrust).hitFrame` through it, so
 *     the damage coincides with the weapon actually connecting. Without an animation
 *     system registered we assume the same 0.45 normalised hit point.
 *
 *  4. **Resolution.** Attack skill against defence skill plus whatever fraction of the
 *     shield genuinely faces the blow; armour eats non-AP damage on a diminishing
 *     curve; AP goes straight through. Charge bonus decays over a window after
 *     contact and scales with closing speed. Spears get their anti-cavalry bonus as
 *     mostly-AP damage, which is what makes a horse die on a hedge of ash.
 *
 *  5. **Push.** The heavier, denser, better-nerved formation displaces the other, along
 *     the *contact normal* averaged over every man who has an opponent — not along the
 *     bearing to the enemy's anchor, which is a different direction once two blocks have
 *     met off-centre and which made a pair of units rotate about each other instead of
 *     one giving ground. The displacement goes into the unit anchor and into individual
 *     velocities, so the line bends and gives way instead of standing in a neat row.
 *
 * The contact *lock* itself is not owned here — `BattleSystem` sets `u.contactLock` from
 * front-rank-to-front-rank geometry, because that is where the advance lives. This file
 * mirrors it onto the shared blackboard and adds the "blows are landing" case.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Seconds a charge bonus survives after contact. Rome II is around four. */
const CHARGE_WINDOW = 4.0;
/** Fallback normalised hit point when no animation system is registered. */
const DEFAULT_HIT_FRAME = 0.45;
/** Fallback attack clip length in seconds. */
const DEFAULT_ATTACK_DURATION = 0.9;
/** Metres of extra distance a target directly ahead is worth during acquisition. */
const FRONT_BIAS = 1.6;
/** How many men may pile onto one opponent before he stops looking attractive. */
const CROWD_SOFT_CAP = 2;
/**
 * And how many may pile on before he is simply unreachable.
 *
 * A hard cap, not a preference. Melee in Total War is *paired*: two entities lock into a
 * duel and the men behind them wait. Without a ceiling here, two 160-man blocks that have
 * pressed into each other interleave along the seam until every man on both sides has
 * somebody within reach, and 63% of both units fight at once — which triples the kill rate
 * and turns a two-minute grind into a twenty-second massacre. Three is the most that can
 * physically get at one man.
 */
const CROWD_HARD_CAP = 4;
/** Unit-anchor separation under which we look for individual contact at all. */
const CONTACT_SCAN_RANGE = 90;
/** Seconds of no contact before a pinned formation is released to advance again. */
const CONTACT_RELEASE = 2.5;
/** meleeHit events allowed per tick for non-lethal blows. */
const HIT_EVENT_BUDGET = 22;
/** Hard ceiling on meleeHit events per tick including lethal ones. */
const HIT_EVENT_CEILING = 52;
/** Minimum speed at which a horse's contact counts as a charge impact. */
const TRAMPLE_SPEED = 3.0;
/**
 * Share of engagements that become a *matched duel* rather than two men independently
 * swinging at each other's position.
 *
 * Rome II ships `matched_combat_percentage = 25`, and CA's own description of the feature
 * is "a single animation with two entities" — a quarter of pairs lock into one
 * choreographed strike-and-parry exchange with a roll deciding the outcome. It is the
 * single biggest reason a Rome II contact line reads as men *fighting* rather than as two
 * crowds overlapping. This is the cheap version of it: the pair stops dead, faces each
 * other exactly, is exempt from being shoved about by the push, and has its two swing
 * clocks phased half an interval apart so one is striking while the other covers.
 */
const MATCHED_COMBAT_SHARE = 0.25;
/** Floor and ceiling on melee hit chance. Rome II ships 0.15 and 0.75. */
const HIT_FLOOR = 0.15;
const HIT_CEIL = 0.75;
/**
 * How many men a formation can get into the fight, as a multiple of its front-rank
 * width. Frontage is what decides a Total War melee: a measured Rome II engagement puts
 * about 35 of a 160-man unit in contact — roughly 1.2 men per metre of frontage — and the
 * rest wait their turn. Without this ceiling two blocks that have pressed into each other
 * interleave along the seam until 60% of both units is swinging, which triples the kill
 * rate and finishes a fight in twenty seconds instead of ninety. Spears reach past the
 * man in front, so they get a deeper share; that is the entire point of a spear.
 */
const ENGAGE_PER_WIDTH = 1.2;
const ENGAGE_PER_WIDTH_SPEAR = 1.8;

// ---------------------------------------------------------------------------
// Module-scope scratch. Hoisted so the per-soldier loops allocate nothing at all:
// the spatial hash takes a callback, and a closure per man per tick would be
// thousands of allocations a second.
// ---------------------------------------------------------------------------

let POOL: SoldierPool | null = null;

let ACQ_X = 0;
let ACQ_Z = 0;
let ACQ_FX = 0;
let ACQ_FZ = 0;
let ACQ_R = 1;
let ACQ_ENEMY = 0;
let ACQ_SELF = -1;
let ACQ_BEST = -1;
let ACQ_BEST_SCORE = -1e9;
let ACQ_COUNTS: Int16Array | null = null;

const acquireVisit = (j: number): void => {
  const p = POOL!;
  if (j === ACQ_SELF) return;
  if (p.faction[j] !== ACQ_ENEMY) return;
  const st = p.state[j];
  if (st === SoldierState.Dead || st === SoldierState.Dying) return;
  const dx = p.x[j] - ACQ_X;
  const dz = p.z[j] - ACQ_Z;
  const d2 = dx * dx + dz * dz;
  if (d2 > ACQ_R * ACQ_R || d2 < 1e-6) return;
  const d = Math.sqrt(d2);
  const dot = (dx * ACQ_FX + dz * ACQ_FZ) / d;
  const crowd = ACQ_COUNTS![j];
  if (crowd >= CROWD_HARD_CAP) return;
  let score = -d + dot * FRONT_BIAS;
  if (crowd >= CROWD_SOFT_CAP) score -= (crowd - CROWD_SOFT_CAP + 1) * 1.15;
  if (score > ACQ_BEST_SCORE) {
    ACQ_BEST_SCORE = score;
    ACQ_BEST = j;
  }
};

/** Nearest-enemy probe used for contact detection; distance only, no scoring. */
let NEAR_X = 0;
let NEAR_Z = 0;
let NEAR_ENEMY = 0;
let NEAR_BEST_D2 = 0;
let NEAR_BEST = -1;

const nearestEnemyVisit = (j: number): void => {
  const p = POOL!;
  if (p.faction[j] !== NEAR_ENEMY) return;
  const st = p.state[j];
  if (st === SoldierState.Dead || st === SoldierState.Dying) return;
  const dx = p.x[j] - NEAR_X;
  const dz = p.z[j] - NEAR_Z;
  const d2 = dx * dx + dz * dz;
  if (d2 < NEAR_BEST_D2) {
    NEAR_BEST_D2 = d2;
    NEAR_BEST = j;
  }
};

/** Extra victims caught by a cavalry impact. */
const TRAMPLE_HITS = new Int32Array(3);
let TRAMPLE_N = 0;
let TRA_X = 0;
let TRA_Z = 0;
let TRA_R2 = 0;
let TRA_ENEMY = 0;
let TRA_SKIP = -1;

const trampleVisit = (j: number): void => {
  if (TRAMPLE_N >= TRAMPLE_HITS.length) return;
  const p = POOL!;
  if (j === TRA_SKIP) return;
  if (p.faction[j] !== TRA_ENEMY) return;
  const st = p.state[j];
  if (st === SoldierState.Dead || st === SoldierState.Dying) return;
  const dx = p.x[j] - TRA_X;
  const dz = p.z[j] - TRA_Z;
  if (dx * dx + dz * dz > TRA_R2) return;
  TRAMPLE_HITS[TRAMPLE_N++] = j;
};

/**
 * Tally of which enemy units this unit's men are actually fighting. Four slots is
 * plenty — a formation in contact with five different enemies at once is already
 * surrounded, and the modal answer is all this is for. Module scope so the fight loop
 * allocates nothing.
 */
const VOTE_ID = new Int32Array(4);
const VOTE_COUNT = new Int32Array(4);
let VOTE_N = 0;

const voteFor = (id: number): void => {
  for (let k = 0; k < VOTE_N; k++) {
    if (VOTE_ID[k] === id) {
      VOTE_COUNT[k]++;
      return;
    }
  }
  if (VOTE_N < VOTE_ID.length) {
    VOTE_ID[VOTE_N] = id;
    VOTE_COUNT[VOTE_N] = 1;
    VOTE_N++;
  }
};

const modalVote = (): number => {
  let best = VOTE_ID[0];
  let bestN = VOTE_COUNT[0];
  for (let k = 1; k < VOTE_N; k++) {
    if (VOTE_COUNT[k] > bestN) {
      bestN = VOTE_COUNT[k];
      best = VOTE_ID[k];
    }
  }
  return best;
};

/** The subset of an animation system this file needs, resolved defensively. */
interface AnimationProvider extends Subsystem {
  clipInfo(clip: Clip): ClipInfo;
}

/**
 * Blow timing comes from the animation clip table so damage lands when the weapon
 * actually connects. Two ways in, because the contract in ARCHITECTURE.md allows
 * either: a registered subsystem named `animation` exposing `clipInfo`, or the module
 * function the animation agent ships in `src/anim/clips.ts`. Both are resolved
 * defensively — the module is loaded dynamically and a failure is not fatal, so a
 * mid-edit animation module cannot take the melee down with it.
 */
async function resolveClipInfo(ctx: EngineContext): Promise<((c: Clip) => ClipInfo) | null> {
  const sys = ctx.tryGet<AnimationProvider>('animation');
  if (sys && typeof sys.clipInfo === 'function') return (c) => sys.clipInfo(c);
  try {
    const mod = await import('../anim/clips');
    if (typeof mod.clipInfo === 'function') return mod.clipInfo;
  } catch {
    /* No animation module yet; the defaults below are close enough to read right. */
  }
  return null;
}

// ---------------------------------------------------------------------------

export class CombatSystem implements Subsystem {
  readonly name = 'combat';
  readonly order = 20;

  private battle!: BattleSystem;
  private ctx!: EngineContext;
  private rng!: Rng;

  /** Seconds into the current blow, or -1 when the man is between swings. */
  private swing = new Float32Array(0);
  /** 1 once this swing's blow has been resolved, so it lands exactly once. */
  private swingFired = new Uint8Array(0);
  /** 1 once a horseman has spent his charge impact on the current opponent. */
  private impacted = new Uint8Array(0);
  /**
   * Decaying peak speed, tracked for cavalry only. The tick a horse makes contact it
   * is already being braked by the crowd and the formation halt, so sampling the
   * instantaneous velocity loses the charge; this remembers how fast he came in.
   */
  private approach = new Float32Array(0);
  /** How many men are currently attacking each soldier. */
  private attackers = new Int16Array(0);
  /** Partner in a matched duel, or -1. See `MATCHED_COMBAT_SHARE`. */
  private matchedWith = new Int32Array(0);

  // Per-unit scratch, indexed by unit id.
  private nearestEnemyUnit = new Int32Array(0);
  private nearestEnemyDist = new Float32Array(0);
  /** Unit direction toward the enemy it is fighting or closing on. */
  private enemyDirX = new Float32Array(0);
  private enemyDirZ = new Float32Array(0);
  /**
   * The direction the fight actually is, averaged over every man who has an opponent.
   * The bearing to the enemy *anchor* is not the same thing once two blocks have met
   * off-centre, and using it made a unit pivot toward a point that was not in front of
   * it, then push along that bearing, then pivot again — the pair rotated.
   */
  private normalX = new Float32Array(0);
  private normalZ = new Float32Array(0);
  /** Decaying peak anchor speed, so a charge braked by contact still counts as a charge. */
  private approachSpeed = new Float32Array(0);
  /** Seconds since this unit last had front-line contact. */
  private clearFor = new Float32Array(0);
  /** Closing speed measured at the instant of contact; scales the charge bonus. */
  private impactSpeed = new Float32Array(0);
  /** Anchor position last tick, to measure closing speed. */
  private lastAnchorX = new Float32Array(0);
  private lastAnchorZ = new Float32Array(0);
  /** Cooldown on the linesClashed / cavalryCharge events, in seconds. */
  private clashCooldown = new Float32Array(0);
  private chargeEventCooldown = new Float32Array(0);
  /** Blows landed / taken per unit this tick, used for the push balance. */
  private blowsDealt = new Float32Array(0);
  private blowsTaken = new Float32Array(0);
  private flankBlows = new Float32Array(0);
  private rearBlows = new Float32Array(0);
  private allBlows = new Float32Array(0);
  private cavalryBlows = new Float32Array(0);

  private unitsById: (UnitGroupState | undefined)[] = [];
  private unitCountCache = -1;

  /** Normalised point in the attack clip at which the blow lands. */
  attackHitFrame = DEFAULT_HIT_FRAME;
  /** Length of the attack clip in seconds. */
  attackDuration = DEFAULT_ATTACK_DURATION;

  private tick = 0;
  private hitEvents = 0;
  private hitBudget = 0;

  /** Rolling measurement of this system's own cost, in milliseconds. */
  lastCostMs = 0;

  async init(ctx: EngineContext): Promise<void> {
    this.ctx = ctx;
    this.battle = ctx.get<BattleSystem>('battle');
    // Forked once: `Rng.fork` derives from the parent's *current* state, so forking
    // every tick would hand back the identical stream every time.
    this.rng = this.battle.rng.fork('combat');
    resetCombatShared();

    const cap = this.battle.pool.capacity;
    this.swing = new Float32Array(cap).fill(-1);
    this.swingFired = new Uint8Array(cap);
    this.impacted = new Uint8Array(cap);
    this.approach = new Float32Array(cap);
    this.attackers = new Int16Array(cap);
    this.matchedWith = new Int32Array(cap).fill(-1);
    POOL = this.battle.pool;
    ACQ_COUNTS = this.attackers;

    this.growUnitArrays(64);

    const clipInfo = await resolveClipInfo(ctx);
    if (clipInfo) {
      const info = clipInfo(Clip.AttackThrust);
      if (info) {
        this.attackDuration = info.duration > 0.05 ? info.duration : DEFAULT_ATTACK_DURATION;
        this.attackHitFrame = info.hitFrame ?? DEFAULT_HIT_FRAME;
      }
    }

    ctx.events.on('soldierDied', (e) => {
      signalsOf(e.unitId).casualtyPulse += 1;
      const i = e.index;
      this.swing[i] = -1;
      this.attackers[i] = 0;
      this.breakPair(i);
    });
    ctx.events.on('unitRouted', (e) => this.releaseUnit(e.unitId));
  }

  private growUnitArrays(n: number): void {
    if (this.nearestEnemyUnit.length >= n) return;
    const size = Math.max(n, this.nearestEnemyUnit.length * 2, 64);
    const f = (old: Float32Array): Float32Array<ArrayBuffer> => {
      const a = new Float32Array(size);
      a.set(old);
      return a;
    };
    const prev = this.nearestEnemyUnit;
    this.nearestEnemyUnit = new Int32Array(size).fill(-1);
    this.nearestEnemyUnit.set(prev);
    this.nearestEnemyDist = f(this.nearestEnemyDist);
    this.enemyDirX = f(this.enemyDirX);
    this.enemyDirZ = f(this.enemyDirZ);
    this.normalX = f(this.normalX);
    this.normalZ = f(this.normalZ);
    this.approachSpeed = f(this.approachSpeed);
    this.clearFor = f(this.clearFor);
    this.impactSpeed = f(this.impactSpeed);
    this.lastAnchorX = f(this.lastAnchorX);
    this.lastAnchorZ = f(this.lastAnchorZ);
    this.clashCooldown = f(this.clashCooldown);
    this.chargeEventCooldown = f(this.chargeEventCooldown);
    this.blowsDealt = f(this.blowsDealt);
    this.blowsTaken = f(this.blowsTaken);
    this.flankBlows = f(this.flankBlows);
    this.rearBlows = f(this.rearBlows);
    this.allBlows = f(this.allBlows);
    this.cavalryBlows = f(this.cavalryBlows);
  }

  /** Drop every melee target in a unit — used when it breaks. */
  private releaseUnit(unitId: number): void {
    const u = this.unitById(unitId);
    if (!u) return;
    const p = this.battle.pool;
    for (let k = 0; k < u.members.length; k++) {
      const i = u.members[k];
      const t = p.target[i];
      if (t >= 0) {
        p.target[i] = -1;
        if (this.attackers[t] > 0) this.attackers[t]--;
      }
      this.swing[i] = -1;
      this.breakPair(i);
    }
    signalsOf(unitId).contactLock = false;
  }

  private unitById(id: number): UnitGroupState | undefined {
    const units = this.battle.units;
    if (units.length !== this.unitCountCache) {
      this.unitsById.length = 0;
      for (let k = 0; k < units.length; k++) this.unitsById[units[k].id] = units[k];
      this.unitCountCache = units.length;
    }
    return this.unitsById[id];
  }

  // -------------------------------------------------------------------------

  fixedUpdate(dt: number, ctx: EngineContext): void {
    const t0 = performance.now();
    const b = this.battle;
    const p = b.pool;
    POOL = p;
    ACQ_COUNTS = this.attackers;
    this.tick++;
    this.hitEvents = 0;
    this.hitBudget = HIT_EVENT_BUDGET;

    const units = b.units;
    let maxId = 0;
    for (let k = 0; k < units.length; k++) if (units[k].id > maxId) maxId = units[k].id;
    this.growUnitArrays(maxId + 1);

    this.rebuildAttackerCounts();
    this.surveyUnits(dt);
    this.fightUnits(dt);
    this.resolvePush(dt);
    void ctx;
    this.lastCostMs = performance.now() - t0;
  }

  /**
   * Recount how many men are attacking each soldier. A full O(n) rebuild is cheaper
   * and far more robust than incrementing and decrementing on every retarget, and it
   * self-heals after a rout or a mass death.
   */
  private rebuildAttackerCounts(): void {
    const p = this.battle.pool;
    const n = p.count;
    const a = this.attackers;
    a.fill(0, 0, n);
    for (let i = 0; i < n; i++) {
      const t = p.target[i];
      if (t >= 0 && p.aliveAt(i)) a[t]++;
    }
  }

  /**
   * Per-unit pass: which enemy is nearest, are we in contact, and should the advance
   * be pinned so the ranks meet instead of walking through each other.
   */
  private surveyUnits(dt: number): void {
    const b = this.battle;
    const units = b.units;

    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (u.destroyed) continue;
      const id = u.id;
      const s = signalsOf(id);
      decaySignals(s, dt);
      this.blowsDealt[id] = 0;
      this.blowsTaken[id] = 0;
      this.flankBlows[id] = 0;
      this.rearBlows[id] = 0;
      this.allBlows[id] = 0;
      this.cavalryBlows[id] = 0;
      if (this.clashCooldown[id] > 0) this.clashCooldown[id] -= dt;
      if (this.chargeEventCooldown[id] > 0) this.chargeEventCooldown[id] -= dt;

      // Closing speed of the formation as a whole, for the charge bonus.
      const adx = u.x - this.lastAnchorX[id];
      const adz = u.z - this.lastAnchorZ[id];
      const anchorSpeed = Math.hypot(adx, adz) / dt;
      this.lastAnchorX[id] = u.x;
      this.lastAnchorZ[id] = u.z;
      // Peak-hold with a two-second half-life, so the speed a unit was making when it
      // began its final bound survives the deceleration into contact.
      const decayed = this.approachSpeed[id] * 0.985;
      this.approachSpeed[id] = anchorSpeed > decayed ? anchorSpeed : decayed;

      // Nearest enemy formation. O(units²) with a couple of dozen units.
      let best = -1;
      let bestD = 1e9;
      let bx = 0;
      let bz = 0;
      for (let j = 0; j < units.length; j++) {
        const o = units[j];
        if (o.destroyed || o.faction === u.faction || o.alive === 0) continue;
        const dx = o.x - u.x;
        const dz = o.z - u.z;
        const d = Math.hypot(dx, dz);
        if (d < bestD) {
          bestD = d;
          best = o.id;
          bx = dx / (d || 1);
          bz = dz / (d || 1);
        }
      }
      this.nearestEnemyUnit[id] = best;
      this.nearestEnemyDist[id] = bestD;
      if (best >= 0) {
        this.enemyDirX[id] = bx;
        this.enemyDirZ[id] = bz;
      }

      const def = b.typeOf(u);
      const routing = u.order === UnitOrder.Rout;
      const frontGap = b.frontGapOf(id);

      // Distance to the nearest enemy *man*, which is what abilities and the skirmish
      // logic want. The unit-level contact test itself is front-segment geometry and
      // lives in `BattleSystem`; a single hash probe at the anchor cannot see a
      // formation that has met this one edge to edge.
      if (!routing && bestD < CONTACT_SCAN_RANGE) {
        NEAR_X = u.x;
        NEAR_Z = u.z;
        NEAR_ENEMY = u.faction === 0 ? 1 : 0;
        const probe = Math.max(def.reach + 1.5, Math.min(40, frontGap + 6));
        NEAR_BEST_D2 = probe * probe;
        NEAR_BEST = -1;
        b.hash.query(u.x, u.z, probe, nearestEnemyVisit);
        s.nearestEnemy = NEAR_BEST >= 0 ? Math.sqrt(NEAR_BEST_D2) : Math.min(bestD, frontGap);
      } else {
        s.nearestEnemy = Math.min(bestD, frontGap);
      }

      // `BattleSystem` owns the geometric lock; blows landing count as contact too, so
      // a formation whose ranks have been shredded and spread out is still engaged.
      const contact = !routing && (u.contactLock || s.engagedFraction > 0.02);

      if (contact) {
        if (this.clearFor[id] > CONTACT_RELEASE || !s.contactLock) {
          // Fresh contact: bank the closing speed and open the charge window. The peak
          // approach speed is used rather than this tick's, because the block-collision
          // clamp has already braked the anchor by the time the fronts actually touch —
          // sampling the instantaneous speed here threw the charge bonus away.
          this.impactSpeed[id] = Math.max(anchorSpeed, this.approachSpeed[id]);
          if (u.chargeTimer <= 0.01) u.chargeTimer = CHARGE_WINDOW;
          if (this.clashCooldown[id] <= 0) {
            const other = best >= 0 ? this.unitById(best) : undefined;
            const mass = def.mass * Math.max(1, u.alive);
            const otherMass = other ? b.typeOf(other).mass * Math.max(1, other.alive) : mass;
            const intensity = clamp01(Math.min(mass, otherMass) / 9000)
              * clamp01(0.35 + this.impactSpeed[id] / 5);
            this.ctx.events.emit('linesClashed', {
              x: u.x, z: u.z, intensity, attackerFaction: u.faction,
            });
            this.ctx.events.emit('cameraShake', { amplitude: 0.18 + intensity * 0.5, decay: 2.6 });
            this.clashCooldown[id] = 8;
          }
        }
        this.clearFor[id] = 0;
        s.contactSeconds += dt;
        s.contactLock = true;
        u.engaged = true;
      } else {
        this.clearFor[id] += dt;
        if (this.clearFor[id] > CONTACT_RELEASE) {
          if (s.contactLock) {
            s.contactLock = false;
            s.contactSeconds = 0;
            s.meleeEnemy = -1;
          }
          u.engaged = false;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Melee
  // -------------------------------------------------------------------------

  private fightUnits(dt: number): void {
    const b = this.battle;
    const p = b.pool;
    const units = b.units;
    const phase = this.tick & 7;

    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (u.destroyed || u.alive === 0) continue;
      const id = u.id;
      if (this.nearestEnemyDist[id] > CONTACT_SCAN_RANGE) {
        // Far from any enemy: only decay swings so nobody freezes mid-blow.
        this.idleUnit(u, dt);
        continue;
      }

      const def = b.typeOf(u);
      const f = formation(u.formationId);
      const mods = modsOf(id);
      const s = signalsOf(id);
      const enemyFaction = u.faction === 0 ? 1 : 0;
      const cav = isCavalry(def);
      const acquireR = def.reach + 0.25;
      const keepR = def.reach + 0.9;
      const keepR2 = keepR * keepR;
      const loose = u.spacingX > 1.3;
      // Press along the direction the fight is in if we know it, else at the enemy
      // formation we are closing on.
      const haveNormal = this.normalX[id] !== 0 || this.normalZ[id] !== 0;
      const edx = haveNormal ? this.normalX[id] : this.enemyDirX[id];
      const edz = haveNormal ? this.normalZ[id] : this.enemyDirZ[id];
      const chargeF = this.chargeFactor(u, def, f, mods, id);
      const rate = def.attackRate * mods.attackRate * f.mods.attack;
      const members = u.members;
      const engageCap = Math.max(
        6,
        Math.round(Math.min(u.width, u.alive)
          * (def.reach >= 2.2 ? ENGAGE_PER_WIDTH_SPEAR : ENGAGE_PER_WIDTH))
      );
      let engaged = 0;
      let holding = this.engagedNow(u);
      // Accumulators for this tick's contact normal and for who we are actually fighting.
      let nx = 0;
      let nz = 0;
      VOTE_N = 0;

      for (let m = 0; m < members.length; m++) {
        const i = members[m];
        const st = p.state[i];
        if (st === SoldierState.Dead || st === SoldierState.Dying) continue;

        if (st === SoldierState.Routing) {
          const old = p.target[i];
          if (old >= 0) {
            p.target[i] = -1;
            if (this.attackers[old] > 0) this.attackers[old]--;
          }
          this.swing[i] = -1;
          continue;
        }

        if (st === SoldierState.Staggered) {
          if (p.stateTime[i] > 0.85) p.setState(i, SoldierState.Idle);
          this.swing[i] = -1;
          continue;
        }

        if (cav) {
          const sp = Math.hypot(p.vx[i], p.vz[i]);
          const decayed = this.approach[i] * 0.9;
          this.approach[i] = sp > decayed ? sp : decayed;
        }

        // --- keep or drop the current opponent ---
        let t = p.target[i];
        if (t >= 0) {
          if (!p.aliveAt(t)) {
            t = -1;
          } else {
            const dx = p.x[t] - p.x[i];
            const dz = p.z[t] - p.z[i];
            if (dx * dx + dz * dz > keepR2) t = -1;
          }
          if (t < 0) {
            const old = p.target[i];
            p.target[i] = -1;
            if (old >= 0 && this.attackers[old] > 0) this.attackers[old]--;
          }
        }

        // --- acquire, striped across ticks ---
        if (t < 0 && holding < engageCap) {
          // Front ranks and anyone in a loose order look every 8 ticks; deep ranks
          // only every 32, because they almost never have anything in reach and the
          // hash probe is the most expensive thing in this loop.
          const eager = p.rank[i] <= 2 || loose || cav || s.contactSeconds > 4;
          const due = eager ? ((i + phase) & 7) === 0 : ((i + this.tick) & 31) === 0;
          if (due) {
            ACQ_X = p.x[i];
            ACQ_Z = p.z[i];
            ACQ_FX = Math.sin(p.facing[i]);
            ACQ_FZ = Math.cos(p.facing[i]);
            ACQ_R = acquireR;
            ACQ_ENEMY = enemyFaction;
            ACQ_SELF = i;
            ACQ_BEST = -1;
            ACQ_BEST_SCORE = -1e9;
            b.hash.query(ACQ_X, ACQ_Z, acquireR, acquireVisit);
            t = ACQ_BEST;
            if (t >= 0) {
              p.target[i] = t;
              this.attackers[t]++;
              holding++;
            }
          }
        }

        // --- fight, or press ---
        if (t >= 0) {
          // A horse arriving at speed hits before the rider's arm does. This has to
          // be sampled here, on the tick contact is made, because the moment the man
          // enters `Fighting` the battle system damps his velocity to nothing.
          if (cav && this.impacted[i] === 0) {
            const closing = Math.max(this.approach[i], this.impactSpeed[id]);
            if (closing > TRAMPLE_SPEED) {
              this.impacted[i] = 1;
              this.approach[i] = 0;
              this.cavalryImpact(i, t, u, def, mods, Math.max(chargeF, 0.35), closing);
              if (!p.aliveAt(t) || !p.aliveAt(i)) {
                if (p.target[i] >= 0) {
                  if (this.attackers[t] > 0) this.attackers[t]--;
                  p.target[i] = -1;
                }
                continue;
              }
            }
          }

          engaged++;
          const tx = p.x[t];
          const tz = p.z[t];
          nx += tx - p.x[i];
          nz += tz - p.z[i];
          voteFor(p.unitId[t]);
          const want = Math.atan2(tx - p.x[i], tz - p.z[i]);

          // Matched combat. Only a mutual pairing can become a duel, and only a fixed
          // share of them do, chosen from the pair's own stable hash so the same two men
          // always reach the same answer without either needing to see the other's roll.
          const mutual = p.target[t] === i;
          const lead = i < t ? i : t;
          const duel = mutual && hash01(lead, 313) < MATCHED_COMBAT_SHARE;
          const fat = p.fatigue[i];
          const interval = 1 / Math.max(0.08, rate * (1 - 0.45 * fat));
          if (duel) {
            if (this.matchedWith[i] !== t) {
              this.matchedWith[i] = t;
              // The follower's clock starts half a beat late, so the exchange alternates
              // strike and parry instead of both men flailing in unison.
              if (i !== lead) p.attackCooldown[i] += interval * 0.5;
            }
            // Locked: a duel does not drift. Facing is snapped, not eased, because the two
            // men are squared up on each other by definition.
            p.vx[i] = 0;
            p.vz[i] = 0;
            p.facing[i] = want;
          } else {
            if (this.matchedWith[i] >= 0) this.matchedWith[i] = -1;
            p.facing[i] = turnToward(p.facing[i], want, dt * 6.5);
          }
          if (st !== SoldierState.Fighting) p.setState(i, SoldierState.Fighting);

          // Fatigue drains while fighting; the melee visibly slows as it wears on.
          p.fatigue[i] = clamp01(p.fatigue[i] + dt / Math.max(10, def.stamina * 1.5));

          const dur = Math.min(this.attackDuration, interval * 0.85);
          const hitAt = dur * this.attackHitFrame;

          let sw = this.swing[i];
          if (sw < 0) {
            p.attackCooldown[i] -= dt;
            if (p.attackCooldown[i] <= 0) {
              sw = 0;
              this.swing[i] = 0;
              this.swingFired[i] = 0;
            }
          }
          if (sw >= 0) {
            const prev = sw;
            sw += dt;
            this.swing[i] = sw;
            if (this.swingFired[i] === 0 && (prev < hitAt ? sw >= hitAt : sw >= dur)) {
              this.swingFired[i] = 1;
              this.resolveBlow(i, t, u, def, f, mods, chargeF, cav);
            }
            if (sw >= dur) {
              this.swing[i] = -1;
              p.attackCooldown[i] = Math.max(0, interval - dur);
            }
            // Drive the visible swing so the blow and the animation coincide.
            p.animTime[i] = clamp01(sw / Math.max(0.05, dur));
          }
        } else {
          this.swing[i] = -1;
          if (this.matchedWith[i] >= 0) this.matchedWith[i] = -1;
          // Free of an opponent: the next contact can be a fresh charge.
          this.impacted[i] = 0;
          if (st === SoldierState.Fighting) {
            p.setState(i, mods.braced ? SoldierState.Bracing : SoldierState.Idle);
          }
          if (mods.braced && st !== SoldierState.Bracing) {
            p.setState(i, SoldierState.Bracing);
          }
          // Close the last few metres.
          //
          // `BattleSystem` stops a formation with its front rank `CONTACT_GAP` from the
          // enemy's and, once locked, moves the men up through the press. What is left
          // for this to do is the approach: a unit that has come to rest just outside
          // weapon range, and cavalry, whose whole value is the speed it arrives at.
          const closing = !s.contactLock && s.nearestEnemy < (cav ? 34 : 7);
          if (!mods.braced && !mods.skirmishing && closing) {
            if (cav) {
              // A horse covers the last thirty metres at the gallop; that speed is
              // the entire point of cavalry and it has to survive to the impact.
              p.vx[i] += edx * 7 * dt;
              p.vz[i] += edz * 7 * dt;
              const sp = Math.hypot(p.vx[i], p.vz[i]);
              if (sp > def.chargeSpeed) {
                const g = def.chargeSpeed / sp;
                p.vx[i] *= g;
                p.vz[i] *= g;
              }
              if (st !== SoldierState.Charging) p.setState(i, SoldierState.Charging);
            } else {
              const nerve = s.nerve;
              // A wavering unit shuffles backwards instead of pressing forward.
              const push = nerve < 0.32 ? -1.2 : 2.2 * (0.45 + 0.55 * nerve);
              p.vx[i] += edx * push * dt;
              p.vz[i] += edz * push * dt;
              const sp = Math.hypot(p.vx[i], p.vz[i]);
              if (sp > 1.1) {
                const g = 1.1 / sp;
                p.vx[i] *= g;
                p.vz[i] *= g;
              }
            }
          }
          // Fatigue recovers slowly while waiting your turn in the crush.
          p.fatigue[i] = clamp01(p.fatigue[i] - dt / 34);
        }
      }

      const alive = Math.max(1, u.alive);
      s.engagedFraction = engaged / alive;
      const blows = this.allBlows[id];
      s.flankedFraction = blows > 0 ? this.flankBlows[id] / blows : 0;
      s.rearFraction = blows > 0 ? this.rearBlows[id] / blows : 0;
      s.cavalryPressure = blows > 0 ? clamp01(this.cavalryBlows[id] / blows) : 0;

      // Publish where the fight is and who it is against. Both are low-passed: the
      // instantaneous average over a few dozen duels jitters, and a unit that re-aims on
      // the jitter wheels on the spot instead of fighting.
      const nl = Math.hypot(nx, nz);
      if (nl > 1e-3) {
        const k = 0.12;
        this.normalX[id] += (nx / nl - this.normalX[id]) * k;
        this.normalZ[id] += (nz / nl - this.normalZ[id]) * k;
        const l2 = Math.hypot(this.normalX[id], this.normalZ[id]) || 1;
        this.normalX[id] /= l2;
        this.normalZ[id] /= l2;
      } else if (!s.contactLock) {
        this.normalX[id] = 0;
        this.normalZ[id] = 0;
      }
      // Who we are fighting is whoever most of our men have their hands on, not whichever
      // enemy anchor happens to be nearest. With the nearest-anchor answer two units in
      // the same melee could each name a *different* opponent, and `resolvePush` then
      // shoved them along two unrelated axes — a pair of blocks that rotated about each
      // other rather than one giving ground to the other.
      s.meleeEnemy = VOTE_N > 0 ? modalVote() : b.frontEnemyOf(id);

      // Pivot to face the fight, with a deadband so small asymmetries in the seam do not
      // keep the block turning. `BattleSystem` turns at 0.35 rad/s while locked, so this
      // is a target, not a snap.
      if (s.contactLock && (this.normalX[id] !== 0 || this.normalZ[id] !== 0)) {
        const want = Math.atan2(this.normalX[id], this.normalZ[id]);
        if (Math.abs(wrapAngle(want - u.targetFacing)) > 0.26) u.targetFacing = want;
      }
    }
  }

  /** How many of a unit's living men currently have an opponent. */
  private engagedNow(u: UnitGroupState): number {
    const p = this.battle.pool;
    const members = u.members;
    let n = 0;
    for (let m = 0; m < members.length; m++) {
      const i = members[m];
      if (p.target[i] >= 0 && p.aliveAt(i)) n++;
    }
    return n;
  }

  /** Units with nothing near them: bleed swings and recover wind. */
  private idleUnit(u: UnitGroupState, dt: number): void {
    const p = this.battle.pool;
    const s = signalsOf(u.id);
    s.engagedFraction = 0;
    s.contactLock = false;
    s.contactSeconds = 0;
    u.engaged = false;
    for (let m = 0; m < u.members.length; m++) {
      const i = u.members[m];
      if (!p.aliveAt(i)) continue;
      if (this.swing[i] >= 0) this.swing[i] = -1;
      if (p.target[i] >= 0) p.target[i] = -1;
      if (p.state[i] === SoldierState.Fighting) p.setState(i, SoldierState.Idle);
      if (p.fatigue[i] > 0) p.fatigue[i] = clamp01(p.fatigue[i] - dt / 34);
    }
  }

  /**
   * How much of the charge bonus is live: a window that decays after contact,
   * scaled by how fast the formation was actually moving when it hit.
   */
  private chargeFactor(
    u: UnitGroupState, def: UnitTypeDef, f: FormationDef, mods: UnitMods, id: number
  ): number {
    if (u.chargeTimer <= 0) return 0;
    const window = clamp01(u.chargeTimer / CHARGE_WINDOW);
    const speed = clamp(this.impactSpeed[id] / Math.max(1, def.chargeSpeed), 0.2, 1.25);
    // Capped. The multipliers compound — a wedge (1.45) with the charge ability (1.4)
    // arriving above its own charge speed reached 2.5, and at that value a heavy
    // cavalry charge added a hundred points of attack skill and sixty of damage, which
    // killed better than half a formed cohort on the tick of impact. A charge should
    // shock a line, not delete it.
    return Math.min(1.6, window * speed * f.mods.charge * mods.charge);
  }

  // -------------------------------------------------------------------------
  // Blow resolution
  // -------------------------------------------------------------------------

  private resolveBlow(
    i: number,
    t: number,
    u: UnitGroupState,
    def: UnitTypeDef,
    f: FormationDef,
    mods: UnitMods,
    chargeF: number,
    attackerIsCavalry: boolean
  ): void {
    const b = this.battle;
    const p = b.pool;
    const dv = this.unitById(p.unitId[t]);
    if (!dv) return;
    const ddef = b.typeOf(dv);
    const dmods = modsOf(dv.id);
    const df = formation(dv.formationId);

    const dx = p.x[t] - p.x[i];
    const dz = p.z[t] - p.z[i];
    const d = Math.hypot(dx, dz) || 1;
    // Direction from the defender back to his attacker.
    const bx = -dx / d;
    const bz = -dz / d;

    // Shield cover comes from the man's own facing: he can turn to meet a blow.
    const cosMan = bx * Math.sin(p.facing[t]) + bz * Math.cos(p.facing[t]);
    const cover = shieldCoverage(cosMan);
    // Flank and rear come from the unit facing: the cohort is still being rolled up.
    const cosUnit = bx * Math.sin(dv.facing) + bz * Math.cos(dv.facing);
    const aspect = aspectOf(cosUnit);

    const fatI = p.fatigue[i];
    const fatT = p.fatigue[t];
    const defenderIsCavalry = isCavalry(ddef);
    const defenderIsSpear = ddef.reach >= 2.2;

    // ---- attack skill ----
    let atk = def.meleeAttack * mods.attack * f.mods.attack * (1 - 0.30 * fatI);
    if (chargeF > 0) atk += def.chargeBonus * chargeF * 0.9;
    if (defenderIsCavalry) atk += def.bonusVsCavalry * 0.8;
    // Horses baulk at a set spear wall; the rider fights badly from a shying mount.
    if (attackerIsCavalry && defenderIsSpear && (dmods.braced || df.mods.shield > 1.2)) atk *= 0.7;

    // ---- defence skill ----
    let dfn = ddef.meleeDefence * dmods.defence * (1 - 0.30 * fatT);
    dfn += ddef.shieldDefence * dmods.shield * df.mods.shield * cover;
    dfn *= ASPECT_DEFENCE[aspect];
    if (dmods.braced && attackerIsCavalry) dfn *= 1.15;

    // Rome II clamps melee hit chance to a floor and a ceiling, and the *floor* is the
    // dominant term in every lopsided or heavily-armoured matchup — it is the first knob
    // CA changed (Patch 9: "Reduced minimum hit chance, base hit chance and maximum hit
    // chance for melee combat") and the first knob every battle-pacing mod changes. The
    // documented vanilla triple is base 40, min 15, max 75. Ours was 7 to 93, which let a
    // favourable matchup land nine blows in ten and finish a unit in seconds.
    const hitChance = clamp(0.5 + 0.5 * (atk - dfn) / (atk + dfn + 1e-3), HIT_FLOOR, HIT_CEIL);
    const roll = this.rng.next();

    const hx = p.x[t];
    const hy = p.y[t] + 1.15;
    const hz = p.z[t];

    this.allBlows[dv.id] += 1;
    if (aspect !== Aspect.Front) this.flankBlows[dv.id] += 1;
    if (aspect === Aspect.Rear) this.rearBlows[dv.id] += 1;
    if (attackerIsCavalry) this.cavalryBlows[dv.id] += 1;
    this.blowsTaken[dv.id] += 1;
    this.blowsDealt[u.id] += 1;

    if (roll >= hitChance) {
      // Where did it go? Shields first, then a parry, then clean air.
      const r2 = this.rng.next();
      const kind: 'shield' | 'parry' | 'miss' =
        cover > 0.35 && ddef.shieldDefence > 4 && r2 < 0.55 ? 'shield'
          : r2 < 0.78 ? 'parry' : 'miss';
      this.emitHit(hx, hy, hz, kind, false, u.faction);
      return;
    }

    // ---- damage ----
    let dmg = def.meleeDamage * mods.damage * (1 - 0.22 * fatI);
    let ap = def.apDamage * mods.damage;
    if (chargeF > 0) dmg += def.chargeBonus * chargeF * 0.55;
    if (defenderIsCavalry) {
      // A spear stopping a horse is mostly a penetrating wound, so most of the
      // anti-cavalry bonus ignores armour. Without this, mail beats ash and the
      // whole spear-versus-horse relationship inverts.
      dmg += def.bonusVsCavalry * 0.4;
      ap += def.bonusVsCavalry * 0.6;
    }
    const aspectMul = ASPECT_DAMAGE[aspect];
    dmg *= aspectMul;
    ap *= aspectMul;

    const armour = ddef.armour * dmods.armour * (1 - ASPECT_ARMOUR_BYPASS[aspect]);
    const through = 1 - armourReduction(armour) * ARMOUR_BITE;
    const total = (dmg * through + ap) * this.rng.range(0.82, 1.18);

    const lethal = b.damage(t, total, p.x[i], p.z[i], u.id);
    if (lethal) {
      signalsOf(u.id).killPulse += 1;
      // Carry the blow's momentum into the fall.
      const shove = attackerIsCavalry ? 3.4 : 1.0 + total * 0.02;
      p.vx[t] = -bx * shove;
      p.vz[t] = -bz * shove;
    }
    const kind: 'flesh' | 'armour' = armour > 34 && this.rng.next() < 0.55 ? 'armour' : 'flesh';
    this.emitHit(hx, hy, hz, kind, lethal, u.faction);
  }

  private emitHit(
    x: number, y: number, z: number,
    kind: 'flesh' | 'shield' | 'armour' | 'parry' | 'miss',
    lethal: boolean, faction: number
  ): void {
    if (this.hitEvents >= HIT_EVENT_CEILING) return;
    if (!lethal) {
      if (this.hitBudget <= 0) return;
      this.hitBudget--;
    }
    this.hitEvents++;
    this.ctx.events.emit('meleeHit', { x, y, z, kind, lethal, attackerFaction: faction });
  }

  /**
   * A horse arriving at speed. The rider's normal blow has already landed; this is
   * the physical impact: heavy extra damage to the man in front, a smaller share to
   * whoever is jammed in behind him, and everybody knocked off balance. If the
   * target is a braced spearman the exchange runs the other way and the horse takes
   * the wall in the chest.
   */
  private cavalryImpact(
    i: number, t: number, u: UnitGroupState, def: UnitTypeDef,
    mods: UnitMods, chargeF: number, speed: number
  ): void {
    const b = this.battle;
    const p = b.pool;
    const dv = this.unitById(p.unitId[t]);
    if (!dv) return;
    const ddef = b.typeOf(dv);
    const dmods = modsOf(dv.id);
    const df = formation(dv.formationId);
    const braced = ddef.reach >= 2.2 && (dmods.braced || df.mods.shield > 1.2);

    const dx = p.x[t] - p.x[i];
    const dz = p.z[t] - p.z[i];
    const d = Math.hypot(dx, dz) || 1;
    const nx = dx / d;
    const nz = dz / d;

    const momentum = clamp(speed / Math.max(1, def.chargeSpeed), 0.3, 1.2);
    // The physical impact, on top of the rider's own blow. Deliberately sub-linear in
    // the charge factor: at `(0.5 + chargeF)` a wedge with the charge ability arrived at
    // over 200 points of impact damage, which killed every man it touched and took better
    // than half a cohort off the field in one second. A charge should stagger a line and
    // kill its front rank, not delete the formation.
    let power = def.chargeBonus * (0.35 + chargeF * 0.55) * momentum * mods.charge;

    if (braced) {
      // The counter-charge: the spearman's blow lands on the horse at full force,
      // and the impact itself is blunted on the shafts.
      power *= 0.3;
      const counterArmour = def.armour * mods.armour * 0.6;
      const through = 1 - armourReduction(counterArmour) * ARMOUR_BITE;
      const counter = (ddef.meleeDamage * 0.9 * through + ddef.apDamage + ddef.bonusVsCavalry * 1.15)
        * this.rng.range(0.9, 1.25);
      if (b.damage(i, counter, p.x[t], p.z[t], dv.id)) {
        signalsOf(dv.id).killPulse += 1;
        p.vx[i] = -nx * 2.2;
        p.vz[i] = -nz * 2.2;
      }
      p.vx[i] *= 0.15;
      p.vz[i] *= 0.15;
    }

    const armourThrough = 1 - armourReduction(ddef.armour * dmods.armour * 0.85) * ARMOUR_BITE;
    const impact = power * armourThrough * this.rng.range(0.85, 1.2);
    if (b.damage(t, impact, p.x[i], p.z[i], u.id)) {
      signalsOf(u.id).killPulse += 1;
      p.vx[t] = nx * 5.5;
      p.vz[t] = nz * 5.5;
      p.vy[t] = 2.2;
    } else if (!braced) {
      p.setState(t, SoldierState.Staggered);
      p.vx[t] += nx * 2.4;
      p.vz[t] += nz * 2.4;
    }

    // Splash onto the men jammed in behind the first victim.
    if (!braced) {
      TRA_X = p.x[t] + nx * 0.9;
      TRA_Z = p.z[t] + nz * 0.9;
      TRA_R2 = 1.1 * 1.1;
      TRA_ENEMY = u.faction === 0 ? 1 : 0;
      TRA_SKIP = t;
      TRAMPLE_N = 0;
      b.hash.query(TRA_X, TRA_Z, 1.1, trampleVisit);
      for (let k = 0; k < TRAMPLE_N; k++) {
        const j = TRAMPLE_HITS[k];
        if (b.damage(j, impact * 0.45, p.x[i], p.z[i], u.id)) signalsOf(u.id).killPulse += 1;
        else p.setState(j, SoldierState.Staggered);
        p.vx[j] += nx * 1.6;
        p.vz[j] += nz * 1.6;
      }
    }

    if (this.chargeEventCooldown[u.id] <= 0) {
      this.chargeEventCooldown[u.id] = 2.5;
      const intensity = clamp01(momentum * (0.4 + u.alive / 60));
      this.ctx.events.emit('cavalryCharge', { x: p.x[i], z: p.z[i], intensity, unitId: u.id });
      this.ctx.events.emit('cameraShake', { amplitude: 0.3 + intensity * 0.6, decay: 2.2 });
    }
    // Bleed the horse's speed so the charge bonus does not re-trigger next tick.
    p.vx[i] *= 0.35;
    p.vz[i] *= 0.35;
  }

  // -------------------------------------------------------------------------
  // The shoving match
  // -------------------------------------------------------------------------

  /**
   * Two formations in contact do not stand still. Whichever brings more mass per
   * metre of frontage, more nerve and fresher legs walks the other backwards.
   * The result goes into the anchor (the whole block gives ground) and into
   * individual velocities with a per-man bias (the line buckles unevenly).
   */
  private resolvePush(dt: number): void {
    const b = this.battle;
    const p = b.pool;
    const units = b.units;

    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (u.destroyed || u.alive === 0) continue;
      const id = u.id;
      const s = signalsOf(id);
      if (!s.contactLock || u.order === UnitOrder.Rout) {
        s.pushBalance = 0;
        continue;
      }
      const enemyId = s.meleeEnemy;
      const enemy = enemyId >= 0 ? this.unitById(enemyId) : undefined;
      if (!enemy) {
        s.pushBalance = 0;
        continue;
      }

      // Three things decide who walks whom backwards: weight of metal per metre of
      // frontage, whose nerve is holding, and who is actually killing. Mass alone is
      // nearly symmetric between two infantry blocks, so on its own it produces a
      // shoving match that never moves — and a contact line that never moves is the
      // clearest sign a melee is a stalemate animation rather than a fight.
      const mine = this.shovePower(u);
      const theirs = this.shovePower(enemy);
      const physical = (mine - theirs) / (mine + theirs + 1e-3);
      const es = signalsOf(enemy.id);
      const nerveDiff = clamp(s.nerve - es.nerve, -1, 1);
      const killDiff = clamp(
        (s.killPulse - s.casualtyPulse) / (s.killPulse + s.casualtyPulse + 1),
        -1, 1
      );
      const balance = clamp(physical * 0.5 + nerveDiff * 0.7 + killDiff * 0.6, -1, 1);
      s.pushBalance = balance;

      // 0.42 m/s at total dominance. A Rome II line that is losing gives ground at a
      // slow shuffle, not a walking pace: at 1.1 m/s a beaten cohort travelled 60 m in a
      // minute, which walked the whole engagement across the field and pulled units out
      // of contact faster than the melee could kill anyone.
      const speed = balance * 0.42;
      // Push along the contact normal — where our men's hands actually are. Using the
      // bearing to the enemy anchor let two units in one melee push along two different
      // axes, which rotates the pair instead of moving one backwards.
      const edx = this.normalX[id] || this.enemyDirX[id];
      const edz = this.normalZ[id] || this.enemyDirZ[id];
      u.x += edx * speed * dt;
      u.z += edz * speed * dt;
      // Deliberately NOT writing `u.targetX/targetZ`: while `contactLock` holds,
      // `BattleSystem` does not read them, and clobbering them every tick destroyed the
      // standing order the unit will resume the moment the lock releases.

      // Local buckling: front-rank men inherit the push with a fixed per-man bias,
      // so the contact line reads as an irregular seam rather than a ruled edge.
      const members = u.members;
      for (let m = 0; m < members.length; m++) {
        const i = members[m];
        if (p.state[i] !== SoldierState.Fighting) continue;
        if (this.matchedWith[i] >= 0) continue;
        const bias = 0.55 + hash01(i, 91) * 0.9;
        p.vx[i] += edx * speed * bias * 2.2 * dt;
        p.vz[i] += edz * speed * bias * 2.2 * dt;
      }
    }
  }

  /** Mass per metre of frontage, weighted by nerve, wind and who is winning. */
  private shovePower(u: UnitGroupState): number {
    const b = this.battle;
    const def = b.typeOf(u);
    const s = signalsOf(u.id);
    const density = clamp(0.86 / Math.max(0.3, u.spacingX), 0.45, 1.8);
    // Men actually leaning on the enemy, not the formation's widest row. A wedge counted
    // its full width here, and since a horse weighs 520 to an infantryman's 86, sixty
    // riders in a wedge out-shoved a hundred and seventy spearmen and walked a set spear
    // wall backwards.
    const front = Math.max(1, Math.min(u.width, u.alive) * formation(u.formationId).frontMul);
    const local = clamp(1 + (this.blowsDealt[u.id] - this.blowsTaken[u.id]) * 0.02, 0.7, 1.3);
    return def.mass * front * density
      * (0.35 + 0.65 * clamp01(s.nerve))
      * (1 - 0.3 * u.fatigue)
      * local;
  }

  // -------------------------------------------------------------------------
  // Read API for UI / debug
  // -------------------------------------------------------------------------

  /** Seconds into the current blow for a soldier, or -1 between swings. */
  swingPhase(i: number): number {
    return this.swing[i] ?? -1;
  }

  /** How many men are currently attacking this soldier. */
  attackerCount(i: number): number {
    return this.attackers[i] ?? 0;
  }

  /**
   * The soldier this man is locked in a matched duel with, or -1.
   *
   * Exposed for the animation system: a genuine paired clip (one shared strike-and-parry
   * animation driven from the leader's playhead) is what Rome II does with these pairs,
   * and it needs to know which men are in one.
   */
  duelPartner(i: number): number {
    return this.matchedWith[i] ?? -1;
  }

  private breakPair(i: number): void {
    const partner = this.matchedWith[i];
    if (partner >= 0 && this.matchedWith[partner] === i) this.matchedWith[partner] = -1;
    this.matchedWith[i] = -1;
  }

  dispose(): void {
    POOL = null;
    ACQ_COUNTS = null;
  }
}
