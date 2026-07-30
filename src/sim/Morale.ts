import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from './BattleSystem';
import { Faction, SoldierState, UnitOrder } from './types';
import type { UnitGroupState } from './types';
import { formation } from './formations';
import { isCavalry } from '../units/roster';
import { clamp, clamp01 } from '../util/math';
import { modsOf, signalsOf } from './combatShared';

/**
 * Morale — the thing that actually decides ancient battles.
 *
 * Men are not killed to the last; a formation reaches the point where the man in the
 * second rank decides the cost is not worth it, and then the whole thing comes apart
 * in under a minute. This system models that as a single scalar per unit under
 * competing pressure and recovery, with the pressure terms Rome II uses:
 *
 *   attrition (accelerating as the unit thins), the shock of men dying right now,
 *   being flanked, being surrounded, losing the local exchange, cavalry in your face
 *   when you have no spears, exhaustion, incoming missiles, friends routing where you
 *   can see them, enemies routing where you can see them, a general's presence,
 *   the ground you are standing on, and whatever the formation and abilities add.
 *
 * `discipline` divides all of it: a praetorian at 1.7 takes barely half the morale
 * damage a warband at 0.82 does from the same event.
 *
 * Bands: steady → wavering → broken. Broken units rout. A routed unit that gets
 * clear, is not pursued and recovers its nerve re-forms and can fight again. And
 * routs are contagious, which is what turns one broken cohort into a lost battle.
 */

// ---------------------------------------------------------------------------
// Tuning. All pressures are morale points per second before discipline.
// ---------------------------------------------------------------------------

/** Fraction of max morale below which a unit visibly wavers. */
const WAVER_FRAC = 0.5;
/** Fraction of max morale below which it breaks. */
const BREAK_FRAC = 0.18;
/** Fraction it must climb back to before a routed unit will re-form. */
const RALLY_FRAC = 0.34;
/** Metres a routed unit must put between itself and the enemy before it can rally. */
const RALLY_CLEAR = 95;
/** Seconds it must spend running first. Nobody stops the instant they break. */
const RALLY_DELAY = 12;
/** How far a rout is visible and infectious, in metres. */
const CONTAGION_RANGE = 145;
/** Morale points a friendly unit breaking within arm's reach costs you, once. */
const CONTAGION_SHOCK = 11;
/** Minimum change before another `unitMoraleChanged` is published. */
const EMIT_THRESHOLD = 3;

/**
 * Every break leaves a mark. A unit that has already run once holds far less well the
 * second time, and after this many breaks it is finished as a fighting formation and
 * leaves the field for good — which is what stops a battle oscillating for ever
 * between rout and rally.
 */
const MAX_RALLIES = 1;
/** Morale points permanently lost per break. */
const SHAKEN_PENALTY = 9;

// Pressure coefficients, in morale points per second before discipline. Tuned so a
// losing unit of average discipline breaks after roughly a minute of melee having
// lost a quarter to a third of its men — Rome II's pacing, not a fight to the death.
const P_ATTRITION = 10;
const P_ATTRITION_EXP = 1.9;
const P_CASUALTY = 0.22;
const P_FLANKED = 6;
const P_SURROUNDED = 7;
/**
 * How much the local exchange matters. This term is signed, so a unit that is killing
 * faster than it is dying gains nerve. Without a strong enough coupling here every
 * unit in a long melee eventually breaks regardless of whether it is winning, which
 * inverts the whole battle: the better army breaks first because it fights longest.
 */
const P_EXCHANGE = 2.4;
/** Softening constant in the exchange ratio; small so modest edges still register. */
const P_EXCHANGE_FLOOR = 0.6;
const P_CAVALRY = 4.5;
const P_FATIGUE = 0.45;
const P_MISSILE = 0.14;
const P_MISSILE_CAP = 3.5;
/**
 * Army morale. Men know whether their side is winning, not just whether their own
 * cohort is, and an army that has been beaten across the field comes apart even in the
 * places that are still holding. Without this term a battle never finishes: the last
 * intact units of a broken army stand about indefinitely because nothing local is
 * happening to them.
 */
const P_ARMY = 8;
/** A winning army's steadiness bonus is worth less than a losing one's dread. */
const P_ARMY_WINNING = 0.4;
const P_WITNESS_FRIEND = 2.8;
const P_WITNESS_ENEMY = 3.0;
const P_WITNESS_CAP = 5;
const P_PURSUED = 2.2;

/**
 * Recovery. While a unit is in contact its nerve barely recovers at all — you do not
 * calm down in the middle of a melee — but out of contact it comes back quickly. The
 * asymmetry is what makes morale a resource a commander manages by pulling units out,
 * rather than a spring that always pushes back toward the baseline.
 */
const R_ENGAGED = 0.5;
const R_CLEAR = 2.4;
const R_CLEAR_SPRING = 0.06;
const R_RALLYING = 3.4;

/**
 * When the battle is over.
 *
 * An ancient army is beaten long before its last man falls: it is beaten when it can
 * no longer put a fighting line in the field. "Power" here is living men who are still
 * willing to stand, weighted by how much nerve they have left, and a side is finished
 * either when its own power collapses outright or when it is so badly outmatched that
 * the rest is a pursuit rather than a battle.
 */
const DECISIVE_FRACTION = 0.2;
/** Or: this share of the enemy's power, while also well below its own start. */
const DECISIVE_RATIO = 0.3;
const DECISIVE_RATIO_OWN = 0.45;
/** Seconds the condition must hold before the battle is called. */
const DECISIVE_HOLD = 14;

/** Layout of the per-unit pressure breakdown exposed by `moraleTerms`. */
export const TERM_NAMES = [
  'attrition', 'casualties', 'flanked', 'exchange', 'cavalry',
  'fatigue', 'missiles', 'witness', 'ground', 'army', 'recovery',
] as const;
const TERM_COUNT = TERM_NAMES.length;

export const enum MoraleBand {
  Steady = 0,
  Wavering = 1,
  Broken = 2,
}

export class MoraleSystem implements Subsystem {
  readonly name = 'morale';
  readonly order = 30;

  private battle!: BattleSystem;
  private ctx!: EngineContext;

  /** Last published morale per unit id, for event throttling. */
  private emitted = new Float32Array(0);
  private band = new Uint8Array(0);
  /** One-shot contagion shock queued for next tick, per unit id. */
  private shock = new Float32Array(0);
  /** How many times each unit has broken. Each time costs it permanent nerve. */
  private routCount = new Uint8Array(0);
  /**
   * Last tick's pressure breakdown per unit: 10 slots, laid out as `TERM_NAMES`.
   * Kept unconditionally — it is ten stores for a couple of dozen units, and both the
   * unit card's "why is this cohort wavering" tooltip and any balance pass need it.
   */
  private terms = new Float32Array(0);
  private battleOver = false;
  /** Seconds one side has been beaten below the decisive threshold. */
  private collapseTimer = 0;
  /** Men each faction deployed with, for the collapse test. */
  private deployed: [number, number] = [0, 0];
  /** Share of its deployed strength each faction still has standing and willing. */
  private power: [number, number] = [1, 1];

  lastCostMs = 0;

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.battle = ctx.get<BattleSystem>('battle');
    this.grow(64);
    ctx.events.on('unitRouted', (e) => this.spreadPanic(e.unitId));
  }

  private grow(n: number): void {
    if (this.emitted.length >= n) return;
    const size = Math.max(n, this.emitted.length * 2, 64);
    const e = new Float32Array(size);
    e.set(this.emitted);
    this.emitted = e;
    const b = new Uint8Array(size);
    b.set(this.band);
    this.band = b;
    const s = new Float32Array(size);
    s.set(this.shock);
    this.shock = s;
    const r = new Uint8Array(size);
    r.set(this.routCount);
    this.routCount = r;
    const t = new Float32Array(size * TERM_COUNT);
    t.set(this.terms);
    this.terms = t;
  }

  fixedUpdate(dt: number, ctx: EngineContext): void {
    const t0 = performance.now();
    const b = this.battle;
    const units = b.units;
    let maxId = 0;
    for (let k = 0; k < units.length; k++) if (units[k].id > maxId) maxId = units[k].id;
    this.grow(maxId + 1);

    if (this.deployed[0] === 0 && this.deployed[1] === 0) {
      for (let k = 0; k < units.length; k++) {
        this.deployed[units[k].faction === Faction.Rome ? 0 : 1] += units[k].initialStrength;
      }
    }

    // Army-level standing first, since every unit's morale reads it.
    let rome = 0;
    let germ = 0;
    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (u.destroyed || u.alive === 0 || u.order === UnitOrder.Rout) continue;
      if (u.faction === Faction.Rome) rome += u.alive;
      else germ += u.alive;
    }
    this.power[0] = rome / Math.max(1, this.deployed[0]);
    this.power[1] = germ / Math.max(1, this.deployed[1]);

    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (u.destroyed) continue;
      this.updateUnit(u, dt);
    }

    this.checkResolution(dt);
    void ctx;
    this.lastCostMs = performance.now() - t0;
  }

  // -------------------------------------------------------------------------

  private updateUnit(u: UnitGroupState, dt: number): void {
    const b = this.battle;
    const def = b.typeOf(u);
    const f = formation(u.formationId);
    const mods = modsOf(u.id);
    const s = signalsOf(u.id);
    const prev = u.morale;
    const routing = u.order === UnitOrder.Rout;

    const aliveFrac = clamp01(u.alive / Math.max(1, u.initialStrength));
    const lossFrac = 1 - aliveFrac;
    const baseline = clamp(
      u.maxMorale + f.mods.morale + mods.moraleBonus + this.auraBonus(u)
      - this.routCount[u.id] * SHAKEN_PENALTY,
      6, u.maxMorale * 1.4
    );

    // ---- pressure ----
    // Attrition. The exponent is what makes the last third of a unit fold much
    // faster than the first third: 20% losses is uncomfortable, 50% is terminal.
    const tAttrition = P_ATTRITION * Math.pow(lossFrac, P_ATTRITION_EXP);
    // The immediate shock of men going down, amplified once the unit is thin.
    const tCasualty = (s.casualtyPulse * P_CASUALTY) / (0.4 + aliveFrac);

    // Being outflanked and being surrounded are separate horrors.
    const surrounded = this.isSurrounded(s);
    s.surrounded = surrounded;
    const tFlank = s.flankedFraction * P_FLANKED + (surrounded ? P_SURROUNDED : 0);

    // Who is winning the exchange in front of you.
    const exch = (s.killPulse - s.casualtyPulse)
      / (s.killPulse + s.casualtyPulse + P_EXCHANGE_FLOOR);
    const tExchange = -exch * P_EXCHANGE;

    // Infantry with no answer to horses.
    const tCavalry = !isCavalry(def) && def.bonusVsCavalry < 12
      ? s.cavalryPressure * P_CAVALRY : 0;

    const tFatigue = u.fatigue * P_FATIGUE;
    const tMissile = Math.min(s.missilePulse * P_MISSILE, P_MISSILE_CAP);

    // What the men can see happening to either side.
    const tWitness = this.witnessPressure(u);

    // Ground. Two metres of slope in your favour is worth real nerve.
    const enemy = s.meleeEnemy >= 0 ? this.unitById(s.meleeEnemy) : undefined;
    let tGround = 0;
    if (enemy) {
      const dh = b.groundAt(u.x, u.z) - b.groundAt(enemy.x, enemy.z);
      tGround = -clamp(dh / 8, -1, 1) * 2;
    }

    // Being chased is its own pressure; a rout that is not pursued calms down.
    if (routing && s.nearestEnemy < 60) tGround += P_PURSUED;

    // How the battle as a whole is going. Positive when the other side has more of
    // its army still in hand than you do.
    const own = u.faction === Faction.Rome ? this.power[0] : this.power[1];
    const foe = u.faction === Faction.Rome ? this.power[1] : this.power[0];
    const gap = clamp(foe - own, -0.6, 1);
    const tArmy = gap * P_ARMY * (gap > 0 ? 1 : P_ARMY_WINNING);

    let p = tAttrition + tCasualty + tFlank + tExchange + tCavalry
      + tFatigue + tMissile + tWitness + tGround + tArmy;

    const resist = Math.max(0.3, def.discipline * mods.moraleResist);

    // ---- recovery ----
    let recovery = mods.moraleRegen;
    // "Engaged" for morale means men of this unit are actually trading blows, not
    // that its anchor happens to be near an enemy.
    const fighting = u.engaged || s.engagedFraction > 0.02;
    recovery += fighting
      ? R_ENGAGED
      : R_CLEAR + Math.max(0, baseline - u.morale) * R_CLEAR_SPRING;
    if (routing && u.routTimer > RALLY_DELAY && s.nearestEnemy > RALLY_CLEAR) recovery += R_RALLYING;

    const oneShot = this.shock[u.id];
    if (oneShot !== 0) {
      this.shock[u.id] = 0;
      u.morale -= oneShot / resist;
    }

    const to = u.id * TERM_COUNT;
    this.terms[to] = tAttrition / resist;
    this.terms[to + 1] = tCasualty / resist;
    this.terms[to + 2] = tFlank / resist;
    this.terms[to + 3] = tExchange / resist;
    this.terms[to + 4] = tCavalry / resist;
    this.terms[to + 5] = tFatigue / resist;
    this.terms[to + 6] = tMissile / resist;
    this.terms[to + 7] = tWitness / resist;
    this.terms[to + 8] = tGround / resist;
    this.terms[to + 9] = tArmy / resist;
    this.terms[to + 10] = recovery;

    u.morale = clamp(u.morale + (recovery - p / resist) * dt, 0, baseline * 1.05);

    if (mods.unbreakable) {
      // Fanatics who stripped to the waist to prove they did not expect to return
      // do not run. Their morale still sinks so the UI reads their state.
      u.morale = Math.max(u.morale, u.maxMorale * 0.24);
    }

    // ---- bands ----
    const frac = u.morale / Math.max(1, u.maxMorale);
    s.nerve = clamp01(frac);
    let band: MoraleBand;
    if (frac < BREAK_FRAC && !mods.unbreakable) band = MoraleBand.Broken;
    else if (frac < WAVER_FRAC) band = MoraleBand.Wavering;
    else band = MoraleBand.Steady;
    s.band = band;

    if (band === MoraleBand.Broken && !routing) {
      this.routCount[u.id]++;
      b.rout(u);
    } else if (routing && !mods.unbreakable) {
      // Each rally is harder to reach than the last, and a unit that has broken
      // twice is spent — it keeps running until it leaves the field.
      const rallies = this.routCount[u.id];
      const canRally = rallies <= MAX_RALLIES
        && u.routTimer > RALLY_DELAY
        && s.nearestEnemy > RALLY_CLEAR
        && frac > RALLY_FRAC + 0.09 * (rallies - 1)
        && u.alive >= Math.max(6, u.initialStrength * 0.2);
      if (canRally) this.rally(u);
    }

    if (this.band[u.id] !== band || Math.abs(u.morale - this.emitted[u.id]) >= EMIT_THRESHOLD) {
      this.band[u.id] = band;
      this.emitted[u.id] = u.morale;
      this.ctx.events.emit('unitMoraleChanged', { unitId: u.id, morale: u.morale, previous: prev });
    }
  }

  /**
   * Friendly units breaking where you can see them, and enemy units breaking where
   * you can see them. This is the coupling that makes a collapse cascade instead of
   * each unit dying alone.
   */
  private witnessPressure(u: UnitGroupState): number {
    const units = this.battle.units;
    let friend = 0;
    let foe = 0;
    for (let k = 0; k < units.length; k++) {
      const o = units[k];
      if (o === u || o.destroyed || o.alive === 0) continue;
      if (o.order !== UnitOrder.Rout) continue;
      const d = Math.hypot(o.x - u.x, o.z - u.z);
      if (d > CONTAGION_RANGE) continue;
      const near = 1 - d / CONTAGION_RANGE;
      if (o.faction === u.faction) friend += P_WITNESS_FRIEND * near;
      else foe += P_WITNESS_ENEMY * near;
    }
    // Capped: a general collapse should cascade over tens of seconds, not instantly.
    return Math.min(friend, P_WITNESS_CAP) - Math.min(foe, P_WITNESS_CAP);
  }

  /** A friendly general or an active `inspire` steadies everyone around it. */
  private auraBonus(u: UnitGroupState): number {
    const units = this.battle.units;
    let best = 0;
    for (let k = 0; k < units.length; k++) {
      const o = units[k];
      if (o.destroyed || o.faction !== u.faction || o === u) continue;
      if (this.battle.typeOf(o).unitClass !== 'general') continue;
      if (o.order === UnitOrder.Rout) continue;
      const d = Math.hypot(o.x - u.x, o.z - u.z);
      if (d > 110) continue;
      best = Math.max(best, 9 * (1 - d / 110));
    }
    return best;
  }

  /**
   * Genuinely encircled.
   *
   * Derived from where the blows are actually landing rather than from where enemy
   * formation anchors happen to sit: once ranks interpenetrate, anchor geometry lies,
   * and two enemy blocks off the front corners of a cohort in a battle line is the
   * normal state of affairs rather than an encirclement. Men being cut down from
   * behind while the front is still fighting is not ambiguous.
   */
  private isSurrounded(s: { flankedFraction: number; rearFraction: number }): boolean {
    return s.flankedFraction > 0.45 && s.rearFraction > 0.12;
  }

  /** A unit has broken: everyone nearby who can see it takes an immediate knock. */
  private spreadPanic(unitId: number): void {
    const units = this.battle.units;
    const src = this.unitById(unitId);
    if (!src) return;
    this.grow(unitId + 1);
    for (let k = 0; k < units.length; k++) {
      const o = units[k];
      if (o.destroyed || o.id === unitId || o.faction !== src.faction) continue;
      if (o.order === UnitOrder.Rout) continue;
      const d = Math.hypot(o.x - src.x, o.z - src.z);
      if (d > CONTAGION_RANGE) continue;
      this.grow(o.id + 1);
      this.shock[o.id] += CONTAGION_SHOCK * (1 - d / CONTAGION_RANGE);
    }
  }

  /** Re-form a routed unit: it stops, turns round and can fight again. */
  private rally(u: UnitGroupState): void {
    const b = this.battle;
    const p = b.pool;
    u.order = UnitOrder.Hold;
    u.routTimer = 0;
    u.running = false;
    u.targetX = u.x;
    u.targetZ = u.z;
    u.waypoints.length = 0;
    u.targetUnitId = -1;
    const s = signalsOf(u.id);
    const enemy = s.meleeEnemy >= 0 ? this.unitById(s.meleeEnemy) : undefined;
    if (enemy) u.targetFacing = Math.atan2(enemy.x - u.x, enemy.z - u.z);
    for (let k = 0; k < u.members.length; k++) {
      const i = u.members[k];
      if (p.aliveAt(i)) p.setState(i, SoldierState.Idle);
    }
    this.ctx.events.emit('unitRallied', { unitId: u.id, faction: u.faction });
  }

  private unitById(id: number): UnitGroupState | undefined {
    const units = this.battle.units;
    for (let k = 0; k < units.length; k++) if (units[k].id === id) return units[k];
    return undefined;
  }

  /**
   * A battle is decided when one side has nothing left that is still willing to
   * stand. Nobody else owns this check yet, and morale is what ends battles.
   */
  private checkResolution(dt: number): void {
    if (this.battleOver) return;
    const units = this.battle.units;
    let rome = 0;
    let germ = 0;
    let romeTotal = 0;
    let germTotal = 0;
    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (u.destroyed || u.alive === 0) continue;
      const nerve = clamp01(u.morale / Math.max(1, u.maxMorale * 0.5));
      if (u.faction === Faction.Rome) {
        romeTotal += u.alive;
        if (u.order !== UnitOrder.Rout) rome += u.alive * nerve;
      } else {
        germTotal += u.alive;
        if (u.order !== UnitOrder.Rout) germ += u.alive * nerve;
      }
    }
    if (romeTotal === 0 && germTotal === 0) return;

    const romeFrac = rome / Math.max(1, this.deployed[0]);
    const germFrac = germ / Math.max(1, this.deployed[1]);
    const romeBeaten = romeFrac < DECISIVE_FRACTION
      || (rome < germ * DECISIVE_RATIO && romeFrac < DECISIVE_RATIO_OWN);
    const germBeaten = germFrac < DECISIVE_FRACTION
      || (germ < rome * DECISIVE_RATIO && germFrac < DECISIVE_RATIO_OWN);
    if (!romeBeaten && !germBeaten) {
      this.collapseTimer = 0;
      return;
    }
    // Both sides collapsing at once is a mutual failure, not a decision; wait it out.
    if (romeBeaten && germBeaten && rome > 0 && germ > 0) {
      this.collapseTimer = 0;
      return;
    }
    this.collapseTimer += dt;
    if (this.collapseTimer < DECISIVE_HOLD) return;

    this.battleOver = true;
    // The announcement is deliberately NOT made here. `BattleFlowSystem` (order 50) is
    // the single authority for the result: it carries the casualty and survivor tallies
    // the post-battle screen needs, handles the timeout case, and sets the winners to
    // cheer. Both systems reach the same verdict within a few seconds of each other, so
    // emitting from both fired `battleEnded` twice and showed the results panel twice.
    // `decided` and `bandOf`/`moraleTerms` remain the read API for the UI.
  }

  // -------------------------------------------------------------------------
  // Read API for the UI
  // -------------------------------------------------------------------------

  /** 0 steady, 1 wavering, 2 broken. */
  bandOf(unitId: number): MoraleBand {
    return (this.band[unitId] ?? 0) as MoraleBand;
  }

  /**
   * Last tick's morale pressure breakdown for a unit, in morale points per second
   * after discipline. Positive entries push morale down; the final `recovery` entry
   * pushes it up. Keys match `TERM_NAMES`. Allocates — for UI and balancing only.
   */
  moraleTerms(unitId: number): Record<string, number> {
    const out: Record<string, number> = {};
    const base = unitId * TERM_COUNT;
    if (base + TERM_COUNT > this.terms.length) return out;
    for (let k = 0; k < TERM_COUNT; k++) {
      out[TERM_NAMES[k]] = Math.round(this.terms[base + k] * 100) / 100;
    }
    return out;
  }

  /** How many times a unit has broken so far. */
  breaksOf(unitId: number): number {
    return this.routCount[unitId] ?? 0;
  }

  /** True once one side has been decided. */
  get decided(): boolean {
    return this.battleOver;
  }
}
