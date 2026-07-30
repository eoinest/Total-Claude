/**
 * Shared per-unit combat blackboard.
 *
 * Combat, Projectiles, Morale and Abilities each need state the others produce, but
 * they run at different `order` values and must not hold references to one another —
 * a four-way `ctx.get` cycle would be worse than a module of plain data. Everything
 * here is per-unit, indexed by `UnitGroupState.id`, which `BattleSystem` allocates
 * densely from zero.
 *
 * Two kinds of record live here:
 *   `UnitMods`    — what the ability system is *doing* to a unit right now.
 *   `UnitSignals` — what the melee and missile systems *observed* about it.
 *
 * Also holds the two combat curves every system must agree on: how armour eats
 * damage, and how much of a shield actually faces an incoming blow.
 */

import { smoothstep } from '../util/math';

// ---------------------------------------------------------------------------
// Combat curves
// ---------------------------------------------------------------------------

/**
 * Armour value at which incoming non-AP damage is halved.
 *
 * The roster comment calls armour a flat subtraction, but at these numbers that is
 * degenerate: legionary armour of 58 against a warband's 27 damage would mean a
 * tribesman literally cannot kill a legionary except through his 5 points of AP,
 * and the melee deadlocks. A diminishing-returns curve keeps armour decisive
 * (58 armour still removes 44% of the blow) without ever zeroing a weapon out.
 */
export const ARMOUR_HALF = 55;

/** 0 (no protection) .. 1 (total). Scaled by ARMOUR_BITE before it is applied. */
export const armourReduction = (armour: number): number =>
  armour <= 0 ? 0 : armour / (armour + ARMOUR_HALF);

/** Even the best mail leaves gaps; cap the fraction of a blow armour can absorb. */
export const ARMOUR_BITE = 0.85;

const COS_SHIELD_INNER = 0.643; // 50 deg — fully behind the boss
const COS_SHIELD_OUTER = -0.174; // 100 deg — the shield is edge-on and useless

/**
 * How much of a shield's defence applies to a blow arriving from `cosToAttacker`,
 * the cosine of the angle between the defender's own facing and the attacker.
 * This is what makes flanking bypass shields rather than merely inconvenience them.
 */
export const shieldCoverage = (cosToAttacker: number): number =>
  smoothstep((cosToAttacker - COS_SHIELD_OUTER) / (COS_SHIELD_INNER - COS_SHIELD_OUTER));

export const enum Aspect {
  Front = 0,
  Flank = 1,
  Rear = 2,
}

/**
 * Which face of a formation a blow landed on, from the cosine between the *unit's*
 * facing and the direction to the attacker. Deliberately uses the unit facing, not
 * the individual's: a man can turn to meet his attacker, but his cohort is still
 * being rolled up from the side.
 */
export const aspectOf = (cosUnitToAttacker: number): Aspect =>
  cosUnitToAttacker > 0.2 ? Aspect.Front : cosUnitToAttacker > -0.5 ? Aspect.Flank : Aspect.Rear;

/** Damage multiplier for a blow landing on the given face. */
export const ASPECT_DAMAGE = [1, 1.22, 1.45];
/** Fraction of the defender's armour a blow on this face bypasses. */
export const ASPECT_ARMOUR_BYPASS = [0, 0.12, 0.28];
/** Multiplier on the defender's defence skill for a blow on this face. */
export const ASPECT_DEFENCE = [1, 0.82, 0.6];

// ---------------------------------------------------------------------------
// Ability modifiers
// ---------------------------------------------------------------------------

/** Everything an ability can change about a unit. Multipliers default to 1, adders to 0. */
export interface UnitMods {
  /** Multiplier on melee attack skill. */
  attack: number;
  /** Multiplier on melee defence skill. */
  defence: number;
  armour: number;
  /** Multiplier on shield defence, on top of the formation's own. */
  shield: number;
  /** Multiplier on melee damage. */
  damage: number;
  /** Multiplier on the charge bonus. */
  charge: number;
  /** Multiplier on blows per second. */
  attackRate: number;
  /** Flat addition to the morale baseline the unit recovers toward. */
  moraleBonus: number;
  /** Extra morale points per second. */
  moraleRegen: number;
  /** Divides all incoming morale pressure. Discipline is applied separately. */
  moraleResist: number;
  /** Multiplier on shots per minute. */
  missileRate: number;
  /** Multiplier on angular spread — below 1 is tighter. */
  missileSpread: number;
  /** Multiplier on incoming missile damage, on top of the formation's. */
  missileTaken: number;
  /** Standing to receive a charge: no advance, spears set. */
  braced: boolean;
  /** Never routs, whatever the morale. */
  unbreakable: boolean;
  /** May pick its own missile targets. */
  fireAtWill: boolean;
  /** Backs away from anything that closes to melee range. */
  skirmishing: boolean;
  /** Volleys the ability system has ordered; Projectiles consumes one per release. */
  orderedVolleys: number;
  /** Release the next volley on a single command rather than as a ragged one. */
  tightVolley: boolean;
  /** Multiplier on that volley's damage. */
  volleyPower: number;
}

const defaultMods = (): UnitMods => ({
  attack: 1, defence: 1, armour: 1, shield: 1, damage: 1, charge: 1, attackRate: 1,
  moraleBonus: 0, moraleRegen: 0, moraleResist: 1,
  missileRate: 1, missileSpread: 1, missileTaken: 1,
  braced: false, unbreakable: false, fireAtWill: true, skirmishing: false,
  orderedVolleys: 0, tightVolley: false, volleyPower: 1,
});

/** Reset every field to neutral without reallocating. Abilities re-applies each tick. */
export function clearMods(m: UnitMods): void {
  m.attack = 1; m.defence = 1; m.armour = 1; m.shield = 1; m.damage = 1;
  m.charge = 1; m.attackRate = 1;
  m.moraleBonus = 0; m.moraleRegen = 0; m.moraleResist = 1;
  m.missileRate = 1; m.missileSpread = 1; m.missileTaken = 1;
  m.braced = false; m.unbreakable = false; m.skirmishing = false;
  m.tightVolley = false; m.volleyPower = 1;
  // `fireAtWill` and `orderedVolleys` are latched state, not per-tick modifiers.
}

// ---------------------------------------------------------------------------
// Observed signals
// ---------------------------------------------------------------------------

/**
 * What the melee and missile systems saw. The pulses are exponentially decaying
 * accumulators over roughly a two-second window, so morale reads a smooth rate
 * regardless of which system wrote to them or in what order.
 */
export interface UnitSignals {
  /** 0..1 fraction of living men who have a melee opponent. */
  engagedFraction: number;
  /** Seconds of unbroken front-line contact; 0 once clear. */
  contactSeconds: number;
  /** True while Combat is pinning the formation at contact instead of advancing. */
  contactLock: boolean;
  /** The unit currently being fought, or -1. */
  meleeEnemy: number;
  /** 0..1 share of blows taken on the flank or rear. */
  flankedFraction: number;
  /** 0..1 share of blows taken squarely in the back. */
  rearFraction: number;
  /** True when the unit is taking blows from the front and the rear at once. */
  surrounded: boolean;
  /** Decaying count of men lost. */
  casualtyPulse: number;
  /** Decaying count of men killed. */
  killPulse: number;
  /** Decaying count of missile hits taken. */
  missilePulse: number;
  /** 0..1 — how much of the contact is against cavalry. */
  cavalryPressure: number;
  /** -1 giving ground .. +1 driving the enemy back. */
  pushBalance: number;
  /** Published by Morale: 0 steady, 1 wavering, 2 broken. */
  band: number;
  /** Published by Morale: morale / maxMorale, cached for cheap reads in Combat. */
  nerve: number;
  /** Metres to the nearest enemy soldier seen this tick, or a large number. */
  nearestEnemy: number;
}

const defaultSignals = (): UnitSignals => ({
  engagedFraction: 0, contactSeconds: 0, contactLock: false, meleeEnemy: -1,
  flankedFraction: 0, rearFraction: 0, surrounded: false,
  casualtyPulse: 0, killPulse: 0, missilePulse: 0,
  cavalryPressure: 0, pushBalance: 0,
  band: 0, nerve: 1, nearestEnemy: 1e6,
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const MODS: UnitMods[] = [];
const SIGNALS: UnitSignals[] = [];

/** Per-unit modifier record, created on first touch. Never called in a hot loop. */
export function modsOf(unitId: number): UnitMods {
  let m = MODS[unitId];
  if (m === undefined) {
    m = defaultMods();
    MODS[unitId] = m;
  }
  return m;
}

export function signalsOf(unitId: number): UnitSignals {
  let s = SIGNALS[unitId];
  if (s === undefined) {
    s = defaultSignals();
    SIGNALS[unitId] = s;
  }
  return s;
}

/** Pulse half-life in seconds — long enough to smooth, short enough to feel current. */
const PULSE_WINDOW = 2.0;

/** Bleed the decaying accumulators. Combat calls this once per unit per tick. */
export function decaySignals(s: UnitSignals, dt: number): void {
  const k = Math.exp(-dt / PULSE_WINDOW);
  s.casualtyPulse *= k;
  s.killPulse *= k;
  s.missilePulse *= k;
}

/** Drop all blackboard state. Call when a battle is torn down or re-deployed. */
export function resetCombatShared(): void {
  MODS.length = 0;
  SIGNALS.length = 0;
}
