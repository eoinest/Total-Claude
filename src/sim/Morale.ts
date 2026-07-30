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
 * `discipline` divides all of it: a praetorian at 1.42 takes about a third less morale
 * damage than a warband at 0.98 from the same event.
 *
 * Bands: steady → wavering → broken. Broken units rout. A routed unit that gets
 * clear, is not pursued and recovers its nerve re-forms and can fight again. And
 * routs are contagious, which is what turns one broken cohort into a lost battle.
 *
 * Two structural rules keep the contagion a cascade rather than an avalanche, and they
 * matter more than any individual coefficient:
 *
 *   - the army-level term is computed from **casualties**, which cannot run away, rather
 *     than from how many units are still standing in order, which feeds back on itself;
 *   - the net fall is **rate-limited** (`MAX_FALL_RATE`), so no pile-up of simultaneous
 *     horrors can empty a full-strength unit's nerve in a second.
 *
 * Without them, a measured battle had three full-strength Juthungi spear blocks break at
 * 97% strength with an attrition term of 0.01, and 1,517 men routing inside twelve
 * seconds of first contact.
 */

// ---------------------------------------------------------------------------
// Tuning. All pressures are morale points per second before discipline.
// ---------------------------------------------------------------------------

/** Fraction of max morale below which a unit visibly wavers. */
const WAVER_FRAC = 0.5;
/**
 * Fraction of max morale below which it breaks.
 *
 * Together with the attrition curve below, this is what sets **how deep a unit fights
 * before it runs**, and that — not the damage curve — is what actually decides how long a
 * battle lasts. Reconstructing Divide et Impera's much-advertised damage, armour and
 * health cuts shows they very nearly cancel: hits-to-kill moves from 6.00 to 6.15. Its
 * 20-40 minute battles come from routing at 50-60% casualties where vanilla routs at
 * 15-20%. Creative Assembly reached the same conclusion the hard way — Patch 3 raised
 * health and cut damage, Patch 9 cut all three hit-chance constants, and neither worked;
 * only at Patch 15, when they finally edited the morale table, did the notes read "the
 * pace of battles and combat has been reduced, and morale values adjusted so battles last
 * longer and are more dynamic".
 */
const BREAK_FRAC = 0.12;
/** Fraction it must climb back to before a routed unit will re-form. */
const RALLY_FRAC = 0.34;
/** Metres a routed unit must put between itself and the enemy before it can rally. */
const RALLY_CLEAR = 95;
/** Seconds it must spend running first. Nobody stops the instant they break. */
const RALLY_DELAY = 12;
/** How far a rout is visible and infectious, in metres. */
const CONTAGION_RANGE = 145;
/**
 * Morale points a friendly unit breaking within arm's reach costs you, once.
 *
 * Was 11, which was most of the way to breaking a warband (62 morale, routs at 11) from
 * three neighbours going. Combined with the army term below it cascaded 1,500 men in
 * about twelve seconds. A cascade is right; a cascade inside one tick is not.
 */
const CONTAGION_SHOCK = 4;
/** Minimum change before another `unitMoraleChanged` is published. */
const EMIT_THRESHOLD = 3;

/**
 * Hard ceiling on how fast morale may fall, in points per second.
 *
 * The single most important number in this file. Every individual term can be argued
 * about; what actually broke the battle was that they *summed* to twenty-odd points a
 * second, so a full-strength unit went from steady to broken in three seconds and took
 * its neighbours with it. Ancient battles are decided by morale over minutes: Rome II's
 * own melees run one to three minutes before a line gives. At 5 points a second even the
 * worst imaginable situation — half the unit dead, surrounded, cavalry in the rear,
 * general down — takes ten seconds to break a 60-morale unit, and an ordinary losing
 * fight takes one to three minutes. Rises are not capped: recovering nerve should feel
 * immediate when a unit is pulled out.
 */
const MAX_FALL_RATE = 5;

/**
 * Time constant, in seconds, of the low-pass on morale pressure.
 *
 * Total War does not apply a morale modifier the instant it appears: `_kv_morale` carries
 * `percent_update_per_tick = 0.15`, so the value chases its target and a step change
 * takes several seconds to land in full. That single mechanism is why a Rome II army
 * coming apart *looks* like a cascade — units start to waver visibly before they go —
 * rather than like a switch being thrown. Four seconds reproduces the same feel at our
 * tick rate, and it composes with the hard fall-rate cap above: the cap bounds the worst
 * case, the smoothing shapes the approach to it.
 *
 * One-shot shocks (a neighbour breaking, a war cry) deliberately bypass this and hit
 * `morale` directly. A shock is supposed to feel like a shock.
 */
const PRESSURE_TAU = 4.0;

/**
 * Every break leaves a mark. A unit that has already run once holds far less well the
 * second time, and after this many breaks it is finished as a fighting formation and
 * leaves the field for good — which is what stops a battle oscillating for ever
 * between rout and rally.
 */
const MAX_RALLIES = 1;
/** Morale points permanently lost per break. */
const SHAKEN_PENALTY = 9;

// Pressure coefficients, in morale points per second before discipline.
//
// The attrition curve is cubic and deliberately almost flat at the bottom: 0.18 pts/s at
// 20% losses, 0.59 at 30%, 1.41 at 40%, 2.75 at 50%, 4.75 at 60%. Below about a third of
// the unit it does not even overcome the in-contact recovery, so pure attrition cannot
// break a formation early; past half it folds in seconds. Creative Assembly flattened the
// same curve deliberately — Patch 2: "the low level casualty morale penalties have been
// significantly reduced in battles" — and it is what makes a unit fight to 40-55% instead
// of running at 15-20%.
//
// The consequence is that *tactics* break units and grinding does not: a flanked or
// surrounded unit is under 8-17 pts/s and folds inside a minute, while the same unit
// fought frontally holds for three. That asymmetry is the whole game.
const P_ATTRITION = 22;
const P_ATTRITION_EXP = 3.0;
const P_CASUALTY = 0.22;
/**
 * Being taken in the flank and being surrounded, in points per second at full exposure.
 *
 * Deliberately the harshest situational terms in the file, because refusing a flank is the
 * decision the player is here to make. Rome II applies *three* simultaneous penalties to a
 * flanked unit and rates a rear attack at -30 morale on a base of 40-60; ours is a rate, so
 * a unit taking most of its blows from the side loses its nerve in well under a minute
 * while the same unit fought frontally holds for two or three.
 */
const P_FLANKED = 8;
const P_SURROUNDED = 9;
/**
 * Share of blows that must be arriving off the front before any of it counts.
 *
 * Not cosmetic. In a real press a quarter to a third of blows always land at an angle:
 * the two front ranks interleave along the seam, men turn to meet whoever is nearest, and
 * `aspectOf` — which deliberately measures against the *unit's* facing so a cohort being
 * rolled up cannot hide behind its individuals turning round — reports those as flank
 * hits. Without a deadband that noise was worth over two morale points a second in a
 * head-on fight, and it is what actually made units break at ten to twenty per cent
 * casualties with an attrition term of almost nothing: a warband fighting an urban cohort
 * frontally broke at 12% losses. Being *flanked* means most of the blows are off the
 * front, not a few of them.
 */
const FLANK_DEADBAND = 0.28;
/**
 * How much the local exchange matters. This term is signed, so a unit that is killing
 * faster than it is dying gains nerve. Without a strong enough coupling here every
 * unit in a long melee eventually breaks regardless of whether it is winning, which
 * inverts the whole battle: the better army breaks first because it fights longest.
 */
const P_EXCHANGE = 3.0;
/** Softening constant in the exchange ratio; small so modest edges still register. */
const P_EXCHANGE_FLOOR = 0.6;
const P_CAVALRY = 4.5;
const P_FATIGUE = 0.45;
const P_MISSILE = 0.14;
const P_MISSILE_CAP = 3.0;
/**
 * Army morale. Men know whether their side is winning, not just whether their own
 * cohort is, and an army that has been beaten across the field comes apart even in the
 * places that are still holding. Without this term a battle never finishes: the last
 * intact units of a broken army stand about indefinitely because nothing local is
 * happening to them.
 *
 * It is measured from **casualties**, not from how many units are currently standing in
 * order, and that distinction is the whole fix. The old version divided living men in
 * unbroken units by the deployed strength, so the instant one unit routed the entire
 * army's denominator-to-numerator ratio jumped and *every* unit's pressure rose — which
 * made the next rout more likely, which raised it again. Measured 8.5 points per second
 * of pure army-mood pressure on Juthungi units that had lost three per cent of their men
 * and were not in contact with anything: three full-strength spear blocks broke at 97%
 * strength with an attrition term of 0.01. Casualties cannot run away like that.
 */
const P_ARMY = 3.0;
/** A winning army's steadiness bonus is worth less than a losing one's dread. */
const P_ARMY_WINNING = 0.4;
/**
 * Separate, and capped: the dread of watching your own army come apart. Scales with the
 * share of the army that has broken, so it moves in steps as units go rather than
 * compounding, and it can never exceed the cap however bad things get.
 */
const P_ARMY_BROKEN = 4.0;
const P_ARMY_BROKEN_CAP = 2.2;
const P_WITNESS_FRIEND = 1.5;
const P_WITNESS_ENEMY = 2.2;
const P_WITNESS_CAP = 3.0;
const P_PURSUED = 2.2;

/**
 * Recovery. While a unit is in contact its nerve barely recovers at all — you do not
 * calm down in the middle of a melee — but out of contact it comes back quickly. The
 * asymmetry is what makes morale a resource a commander manages by pulling units out,
 * rather than a spring that always pushes back toward the baseline.
 */
const R_ENGAGED = 0.9;
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
  /** Low-passed total pressure per unit; see `PRESSURE_TAU`. */
  private smoothed = new Float32Array(0);
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
  /** Share of its deployed strength each faction still has alive, routing or not. */
  private power: [number, number] = [1, 1];
  /** Share of each faction's surviving units that are currently broken. */
  private brokenShare: [number, number] = [0, 0];

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
    const sm = new Float32Array(size);
    sm.set(this.smoothed);
    this.smoothed = sm;
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
        // Units already gone were never part of *this* order of battle. Only matters
        // after `redeploy`, but getting it wrong there makes every army-level morale
        // reading meaningless.
        if (units[k].destroyed) continue;
        this.deployed[units[k].faction === Faction.Rome ? 0 : 1] += units[k].initialStrength;
      }
    }

    // Army-level state first, since every unit's morale reads it. Two separate
    // measurements, because they behave completely differently: men still alive (slow,
    // monotonic, cannot be undone by a rally) and units currently broken (steps up and
    // down, and is capped where it is read).
    let rome = 0;
    let germ = 0;
    const brokenN: [number, number] = [0, 0];
    const totalN: [number, number] = [0, 0];
    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (u.destroyed) continue;
      const f = u.faction === Faction.Rome ? 0 : 1;
      totalN[f]++;
      if (u.order === UnitOrder.Rout) brokenN[f]++;
      if (u.alive === 0) continue;
      if (u.faction === Faction.Rome) rome += u.alive;
      else germ += u.alive;
    }
    this.power[0] = rome / Math.max(1, this.deployed[0]);
    this.power[1] = germ / Math.max(1, this.deployed[1]);
    this.brokenShare[0] = brokenN[0] / Math.max(1, totalN[0]);
    this.brokenShare[1] = brokenN[1] / Math.max(1, totalN[1]);

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
    const flanked = Math.max(0, s.flankedFraction - FLANK_DEADBAND) / (1 - FLANK_DEADBAND);
    const tFlank = flanked * P_FLANKED + (surrounded ? P_SURROUNDED : 0);

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

    // How the battle as a whole is going. Positive when we have been bled harder than
    // they have, plus a capped step term for how much of our own army has already run.
    const side = u.faction === Faction.Rome ? 0 : 1;
    const own = this.power[side];
    const foe = this.power[1 - side];
    const gap = clamp(foe - own, -0.6, 1);
    const tArmy = gap * P_ARMY * (gap > 0 ? 1 : P_ARMY_WINNING)
      + Math.min(P_ARMY_BROKEN_CAP, this.brokenShare[side] * P_ARMY_BROKEN);

    const raw = tAttrition + tCasualty + tFlank + tExchange + tCavalry
      + tFatigue + tMissile + tWitness + tGround + tArmy;
    // Chase the instantaneous pressure rather than applying it, so a step change in the
    // situation ramps in over a few seconds. See `PRESSURE_TAU`.
    const k = 1 - Math.exp(-dt / PRESSURE_TAU);
    this.smoothed[u.id] += (raw - this.smoothed[u.id]) * k;
    let p = this.smoothed[u.id];

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

    // The rate limiter. Applied to the net, after discipline, so no combination of
    // simultaneous horrors can empty a unit's nerve inside a second or two.
    const net = Math.max(-MAX_FALL_RATE, recovery - p / resist);
    u.morale = clamp(u.morale + net * dt, 0, baseline * 1.05);

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
    // Both thresholds sit above the seam noise a head-on melee generates on its own.
    return s.flankedFraction > 0.58 && s.rearFraction > 0.2;
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

  /**
   * Forget the current order of battle. Called when a scenario is torn down and a new
   * one deployed into the same running engine — the balance harness does exactly that,
   * and without it every unit reads army-level morale off the *previous* battle's
   * headcount and breaks for no visible reason.
   */
  redeploy(): void {
    this.deployed[0] = 0;
    this.deployed[1] = 0;
    this.power[0] = 1;
    this.power[1] = 1;
    this.battleOver = false;
    this.collapseTimer = 0;
    this.emitted.fill(0);
    this.band.fill(0);
    this.shock.fill(0);
    this.routCount.fill(0);
    this.terms.fill(0);
    this.smoothed.fill(0);
  }
}
