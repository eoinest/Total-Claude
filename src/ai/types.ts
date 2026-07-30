/**
 * Shared AI vocabulary: difficulty profiles, tactical roles, and the combat-power
 * and matchup model every layer reasons with.
 *
 * Keeping the numbers here — rather than sprinkled through the behaviours — means the
 * whole AI can be retuned from one screen, and the critics can read the doctrine
 * assumptions without tracing call graphs.
 */

import type { UnitClass, UnitTypeDef, UnitGroupState } from '../sim/types';
import { formation } from '../sim/formations';

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

export type Difficulty = 'easy' | 'normal' | 'hard' | 'legendary';

/**
 * Difficulty changes *how well the AI plays*, never the troops it commands.
 * No stat bonuses, no extra vision, no reading the player's orders. The knobs are:
 * how fast it notices things, how good its plan is, and how ruthlessly it exploits.
 */
export interface DifficultyProfile {
  id: Difficulty;
  /** Seconds between army-level plan re-evaluations. */
  planInterval: number;
  /** Seconds a threat must persist before the general responds — its reaction time. */
  reactionTime: number;
  /** Fixed ticks between per-unit tactical re-evaluations (staggered by unit id). */
  thinkInterval: number;
  /** 0 = mass on the enemy centre, 1 = always find the true weak seam. */
  concentration: number;
  /** Will it manoeuvre wide for a flank, or just walk at the nearest enemy? */
  flanking: boolean;
  /** 0 = cavalry gets stuck in melees forever, 1 = pulls out and re-charges cleanly. */
  cavalryDiscipline: number;
  /** Chance it recognises a braced spear front and refuses the charge. */
  spearAwareness: number;
  /** Weight on subtle-but-correct choices: formation swaps, ability timing, LOS. */
  finesse: number;
  /** Force ratio at which it will commit its reserve. Lower = bolder. */
  reserveNerve: number;
  /** Metres of slop tolerated when dressing the line — sloppier AI looks sloppier. */
  lineTolerance: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultyProfile> = {
  // Reacts a full second and a half late, aims at the middle of the enemy line,
  // never swings wide, and leaves its reserve standing while the line buckles.
  easy: {
    id: 'easy', planInterval: 4.0, reactionTime: 3.2, thinkInterval: 20,
    concentration: 0.0, flanking: false, cavalryDiscipline: 0.15,
    spearAwareness: 0.2, finesse: 0.2, reserveNerve: 0.45, lineTolerance: 14,
  },
  normal: {
    id: 'normal', planInterval: 2.2, reactionTime: 1.6, thinkInterval: 14,
    concentration: 0.55, flanking: true, cavalryDiscipline: 0.55,
    spearAwareness: 0.65, finesse: 0.55, reserveNerve: 0.85, lineTolerance: 9,
  },
  hard: {
    id: 'hard', planInterval: 1.4, reactionTime: 0.7, thinkInterval: 10,
    concentration: 0.85, flanking: true, cavalryDiscipline: 0.85,
    spearAwareness: 0.9, finesse: 0.85, reserveNerve: 1.0, lineTolerance: 6,
  },
  // Reads the battle almost immediately, concentrates hard, and cycles its cavalry
  // in and out of contact instead of letting it grind.
  legendary: {
    id: 'legendary', planInterval: 0.9, reactionTime: 0.3, thinkInterval: 8,
    concentration: 1.0, flanking: true, cavalryDiscipline: 1.0,
    spearAwareness: 1.0, finesse: 1.0, reserveNerve: 1.15, lineTolerance: 4,
  },
};

// ---------------------------------------------------------------------------
// Roles and phases
// ---------------------------------------------------------------------------

/** What the general has told this unit it is *for*. The tactical layer decides how. */
export type AIRole =
  | 'line'        // stand in the battle line, keep contact with your neighbours
  | 'anchor'      // refuse a flank: the end of the line, turned outward
  | 'screen'      // skirmish forward of the line, then get out of the way
  | 'missile'     // shoot over the line from behind it
  | 'artillery'   // static, long-range, never move into danger
  | 'reserve'     // wait, then plug or exploit
  | 'flank'       // manoeuvre wide for a flank or rear attack
  | 'shock'       // the hammer: aimed at one point in the enemy line
  | 'pursuit';    // run down what is already broken

export type BattlePhase =
  | 'deploy'
  | 'skirmish'
  | 'advance'
  | 'engagement'
  | 'exploit'
  | 'pursuit'
  | 'withdraw';

/** The general's instruction to one unit. The tactical layer may override locally. */
export interface UnitCommand {
  unitId: number;
  role: AIRole;
  /** Where the general wants this unit standing. */
  stationX: number;
  stationZ: number;
  stationFacing: number;
  /** Preferred enemy, or -1 for "use your judgement". */
  preferredTargetId: number;
  /** 0 = hold ground at all costs, 1 = press the attack. */
  aggression: number;
  /** March discipline. A line that runs arrives out of order. */
  pace: 'walk' | 'run';
  /** May this unit leave the line to chase? */
  allowPursuit: boolean;
  /** Set while the unit is being deliberately held back. */
  held: boolean;
  /** Tick the command was last rewritten — used by the debug overlay. */
  issuedTick: number;
}

// ---------------------------------------------------------------------------
// Matchups
// ---------------------------------------------------------------------------

const CLASS_INDEX: Record<UnitClass, number> = {
  'heavy-infantry': 0,
  'light-infantry': 1,
  'spear-infantry': 2,
  'missile-infantry': 3,
  'shock-infantry': 4,
  'heavy-cavalry': 5,
  'light-cavalry': 6,
  artillery: 7,
  general: 8,
};

/**
 * Rock-paper-scissors multiplier: how well row (attacker) does against column
 * (defender) in a straight fight, all else equal. 1.0 is neutral.
 *
 * The historical shape of it: horse runs down bowmen and artillery and shatters
 * anything already broken, but dies on a spear hedge. Spears in turn are soft
 * against sword infantry that can get inside the reach of the point. Missile troops
 * lose any melee they are forced into.
 */
const MATCHUP: number[][] = (() => {
  const n = 9;
  const m: number[][] = [];
  for (let i = 0; i < n; i++) m.push(new Array<number>(n).fill(1));
  const set = (a: UnitClass, d: UnitClass, v: number) => {
    m[CLASS_INDEX[a]][CLASS_INDEX[d]] = v;
  };

  set('heavy-infantry', 'light-infantry', 1.55);
  set('heavy-infantry', 'missile-infantry', 2.1);
  set('heavy-infantry', 'artillery', 2.4);
  set('heavy-infantry', 'spear-infantry', 1.25);
  set('heavy-infantry', 'shock-infantry', 0.9);
  set('heavy-infantry', 'heavy-cavalry', 0.85);
  set('heavy-infantry', 'light-cavalry', 1.05);

  set('light-infantry', 'heavy-infantry', 0.6);
  set('light-infantry', 'missile-infantry', 1.8);
  set('light-infantry', 'artillery', 2.2);
  set('light-infantry', 'spear-infantry', 0.85);
  set('light-infantry', 'heavy-cavalry', 0.55);
  set('light-infantry', 'light-cavalry', 0.8);

  set('spear-infantry', 'heavy-cavalry', 2.35);
  set('spear-infantry', 'light-cavalry', 2.6);
  set('spear-infantry', 'heavy-infantry', 0.8);
  set('spear-infantry', 'shock-infantry', 0.75);
  set('spear-infantry', 'missile-infantry', 1.7);

  set('shock-infantry', 'heavy-infantry', 1.15);
  set('shock-infantry', 'light-infantry', 1.7);
  set('shock-infantry', 'spear-infantry', 1.2);
  set('shock-infantry', 'missile-infantry', 2.3);
  set('shock-infantry', 'artillery', 2.5);
  set('shock-infantry', 'heavy-cavalry', 0.95);

  set('heavy-cavalry', 'missile-infantry', 2.8);
  set('heavy-cavalry', 'artillery', 3.0);
  set('heavy-cavalry', 'light-infantry', 1.7);
  set('heavy-cavalry', 'heavy-infantry', 0.8);
  set('heavy-cavalry', 'spear-infantry', 0.3);
  set('heavy-cavalry', 'shock-infantry', 0.85);
  set('heavy-cavalry', 'light-cavalry', 1.5);

  set('light-cavalry', 'missile-infantry', 2.4);
  set('light-cavalry', 'artillery', 2.8);
  set('light-cavalry', 'light-infantry', 1.2);
  set('light-cavalry', 'heavy-infantry', 0.5);
  set('light-cavalry', 'spear-infantry', 0.22);
  set('light-cavalry', 'shock-infantry', 0.6);
  set('light-cavalry', 'heavy-cavalry', 0.7);

  set('missile-infantry', 'heavy-infantry', 0.28);
  set('missile-infantry', 'light-infantry', 0.4);
  set('missile-infantry', 'spear-infantry', 0.3);
  set('missile-infantry', 'shock-infantry', 0.2);
  set('missile-infantry', 'heavy-cavalry', 0.15);
  set('missile-infantry', 'light-cavalry', 0.2);

  set('artillery', 'heavy-infantry', 0.12);
  set('artillery', 'light-infantry', 0.18);
  set('artillery', 'heavy-cavalry', 0.08);
  set('artillery', 'light-cavalry', 0.1);

  return m;
})();

/** Melee matchup multiplier for `a` fighting `d`. */
export const matchup = (a: UnitClass, d: UnitClass): number =>
  MATCHUP[CLASS_INDEX[a]][CLASS_INDEX[d]];

export const isCavalryClass = (c: UnitClass): boolean =>
  c === 'heavy-cavalry' || c === 'light-cavalry';

export const isMissileClass = (c: UnitClass): boolean =>
  c === 'missile-infantry' || c === 'artillery';

/** Spear blocks with a real anti-cavalry bonus are the ones horses must not charge. */
export const isAntiCavalry = (def: UnitTypeDef): boolean =>
  def.bonusVsCavalry >= 15 && def.reach >= 2.2;

// ---------------------------------------------------------------------------
// Power model
// ---------------------------------------------------------------------------

/**
 * A single scalar for "how much fight is left in this unit". Used for force ratios,
 * target selection and weak-point detection, so it must fold in numbers, quality,
 * armour, morale, fatigue and the formation currently held.
 *
 * Calibrated so a full-strength legionary cohort scores ~1.0.
 */
export const combatPower = (u: UnitGroupState, def: UnitTypeDef): number => {
  if (u.destroyed || u.alive <= 0) return 0;
  const f = formation(u.formationId);
  const offence = (def.meleeAttack * 0.6 + def.meleeDamage + def.apDamage * 1.6) * def.attackRate;
  const defence = 1 + (def.meleeDefence + def.armour * 0.8 + def.shieldDefence * f.mods.shield) / 120;
  const moraleFactor = 0.35 + 0.65 * (u.morale / Math.max(1, u.maxMorale));
  const fatigueFactor = 1 - u.fatigue * 0.3;
  return (u.alive * offence * defence * moraleFactor * fatigueFactor) / 5400;
};

/** How hard this unit is to shift out of its ground — used to find the weak seam. */
export const defensivePower = (u: UnitGroupState, def: UnitTypeDef): number => {
  if (u.destroyed || u.alive <= 0) return 0;
  const f = formation(u.formationId);
  const soak = 1 + (def.meleeDefence + def.armour + def.shieldDefence * f.mods.shield) / 90;
  const grit = (u.morale / Math.max(1, u.maxMorale)) * def.discipline;
  return (u.alive / Math.max(1, u.initialStrength)) * soak * grit * Math.sqrt(u.alive);
};

/**
 * Value as a missile target: dense, unarmoured, numerous and dangerous is best.
 * Deliberately independent of distance — the caller weights that in.
 */
export const missileValue = (u: UnitGroupState, def: UnitTypeDef): number => {
  const f = formation(u.formationId);
  // Loose and skirmish formations bleed far less to arrows; shooting them is waste.
  // `missileTaken` already encodes how tightly packed the formation is: a testudo
  // takes 0.16x, a skirmish screen 0.42x, a horde 1.22x. Shoot the horde.
  const density = f.mods.missileTaken;
  const soft = 1 / (1 + def.armour / 34);
  // A unit that is about to hurt us is worth shooting even if it is armoured.
  const menace = isCavalryClass(def.unitClass) ? 1.5 : def.unitClass === 'shock-infantry' ? 1.35 : 1;
  return u.alive * soft * menace * density;
};
