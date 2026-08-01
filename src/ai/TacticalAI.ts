import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from '../sim/BattleSystem';
import { ALL_FACTIONS, Faction, UnitOrder, type UnitGroupState, type UnitTypeDef } from '../sim/types';
import { angleDelta } from '../util/math';
import type { Rng } from '../util/rand';
import { AIWorld, isLineUnit, type UnitInfo } from './AIWorld';
import { OrderBook } from './Orders';
import { footprintOf, narrowestFormation, type PathfindingSystem } from './Pathfinding';
import { profileBegin, profileEnd } from './profile';
import {
  DIFFICULTY, isAntiCavalry, isCavalryClass, isMissileClass, matchup,
  type Difficulty, type DifficultyProfile, type UnitCommand,
} from './types';

/**
 * Per-unit tactical behaviour.
 *
 * Structured as a **utility selector**: every tick a unit re-thinks, each candidate
 * behaviour scores itself against the situation and the highest score acts. Utility
 * beats a behaviour tree here because unit-level decisions are genuinely continuous
 * trade-offs — "is this missile fire bad enough to be worth losing my attack" has no
 * natural place in a tree, but it is one subtraction in a utility score. The scores
 * share one 0-100 scale so they can be compared and printed, the winner is recorded on
 * the unit's brain for the F3 overlay, and the incumbent gets a small bonus so units
 * commit to a decision instead of oscillating between two near-equal options.
 *
 * Thinking is staggered: a unit re-evaluates every `thinkInterval` ticks, offset by its
 * id, so the cost is spread evenly instead of spiking. Two events force an immediate
 * re-think regardless — coming into contact, and something fast closing on us — because
 * being a third of a second late to brace is the difference between holding and breaking.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Ability cooldowns in ticks (30 Hz). */
const CD_WARCRY = 30 * 22;
const CD_VOLLEY = 30 * 8;
const CD_TESTUDO = 30 * 6;
const CD_CHARGE = 30 * 14;
const CD_FRENZY = 30 * 30;
const CD_INSPIRE = 30 * 25;
const CD_ARROW_STORM = 30 * 28;
const CD_BRACE = 30 * 10;
const CD_SKIRMISH_MODE = 30 * 40;

/** Distance at which an infantry unit stops marching and locks onto a target. */
const ENGAGE_RANGE = 34;
/** Cavalry that has been stuck in a melee this long is being wasted. */
const CAV_STUCK_TICKS = 30 * 7;
/** Seconds a disengaged cavalry unit spends re-forming before it charges again. */
const CAV_REFORM_TICKS = 30 * 5;
/** Missile weight above which shields go up. */
const TESTUDO_PRESSURE = 0.55;
/** A hole in the line wider than this must be plugged. */
const GAP_LIMIT = 30;
/** Enemy horse inside this range of our wing has to be screened. */
const CAVALRY_SCREEN_RANGE = 220;
/** Metres of height that make a step off the ordered line worth taking. */
const MIN_GROUND_GAIN = 0.9;
/** Candidate offsets along the facing axis when looking for better ground, metres. */
const GROUND_OFFSETS = [-12, 12];

// ---------------------------------------------------------------------------
// Brain state
// ---------------------------------------------------------------------------

type CavPhase = 'hunt' | 'swing' | 'charge' | 'stuck' | 'withdraw' | 'reform';
type SkirmishPhase = 'advance' | 'loose' | 'withdraw';

interface UnitBrain {
  unitId: number;
  nextThinkTick: number;
  behaviour: string;
  score: number;
  since: number;
  /** Snapshot of contact state, so a change can force an immediate re-think. */
  wasInContact: boolean;
  /** Snapshot of "something fast is nearly on us", for the same reason. */
  wasClosingNear: boolean;

  cavPhase: CavPhase;
  cavPhaseSince: number;
  cavTargetId: number;
  swingX: number;
  swingZ: number;

  skirmPhase: SkirmishPhase;
  skirmPhaseSince: number;

  fireTargetId: number;
  /** Formation the AI has decided this unit should be in. */
  wantFormation: string;
  /** Set while traversing a route that only a narrow frontage fits through. */
  squeezing: boolean;
  /**
   * The general's station, adjusted locally for neighbour dressing and better ground.
   * Recomputed once per think so scoring and acting agree, and so local adjustment
   * never accumulates drift into the general's own plan.
   */
  standX: number;
  standZ: number;
  standFacing: number;
}

// ---------------------------------------------------------------------------
// Scratch
// ---------------------------------------------------------------------------

const STAND = { x: 0, z: 0 };
/** Output buffer for flow-field routes. */
const FLOW_OUT: number[] = [];

// ---------------------------------------------------------------------------
// Behaviour interface
// ---------------------------------------------------------------------------

interface Ctx {
  self: TacticalAISystem;
  w: AIWorld;
  info: UnitInfo;
  brain: UnitBrain;
  cmd: UnitCommand;
  prof: DifficultyProfile;
  u: UnitGroupState;
  def: UnitTypeDef;
  /** Live unit behind a perception record, or undefined if it has left the field. */
  battleUnit(id: number): UnitGroupState | undefined;
}

interface Behaviour {
  name: string;
  /** Cheap gate so the scorer skips behaviours that can never apply to this unit. */
  applies(c: Ctx): boolean;
  /** Utility, 0-100. Negative means "never". */
  score(c: Ctx): number;
  act(c: Ctx): void;
}

const CTX: Ctx = {
  self: null as unknown as TacticalAISystem,
  w: null as unknown as AIWorld,
  info: null as unknown as UnitInfo,
  brain: null as unknown as UnitBrain,
  cmd: null as unknown as UnitCommand,
  prof: DIFFICULTY.normal,
  u: null as unknown as UnitGroupState,
  def: null as unknown as UnitTypeDef,
  battleUnit: () => undefined,
};

// ---------------------------------------------------------------------------
// Shared predicates
// ---------------------------------------------------------------------------

const isFoot = (c: Ctx): boolean => isLineUnit(c.def.unitClass);
const isHorse = (c: Ctx): boolean => isCavalryClass(c.def.unitClass);
const isShooter = (c: Ctx): boolean => c.def.unitClass === 'missile-infantry';
const isGun = (c: Ctx): boolean => c.def.unitClass === 'artillery';

/** Distance from our front rank to the enemy's, using the blackboard's segment maths. */
const distToEnemy = (c: Ctx, enemyId: number): number => {
  const mem = c.w.perceived(c.u.faction, enemyId);
  if (!mem) return Infinity;
  return Math.max(0, Math.hypot(mem.x - c.u.x, mem.z - c.u.z) - c.info.halfFront * 0.4 - mem.halfFront * 0.4);
};

// ---------------------------------------------------------------------------
// Behaviours: infantry
// ---------------------------------------------------------------------------

/**
 * Stand where the general put you, dressed on your neighbours. The base behaviour of
 * every line unit and the thing that makes a line look like a line.
 */
const HoldLine: Behaviour = {
  name: 'hold-line',
  applies: (c) => isFoot(c) || isGun(c),
  score: (c) => {
    if (c.info.inContact) return 8; // fighting beats standing
    const d = Math.hypot(c.brain.standX - c.u.x, c.brain.standZ - c.u.z);
    // High when already in place; the march behaviour outbids it when we are not.
    return d < c.prof.lineTolerance ? 34 : 12;
  },
  act: (c) => {
    c.self.orders.halt(c.u);
    c.self.orders.face(c.u, c.brain.standFacing);
    c.self.chooseFormation(c);
  },
};

/** March to the assigned station, pathing round anything in the way. */
const MarchToStation: Behaviour = {
  name: 'march',
  applies: (c) => !isHorse(c),
  score: (c) => {
    if (c.info.inContact) return 6;
    const d = Math.hypot(c.brain.standX - c.u.x, c.brain.standZ - c.u.z);
    if (d < c.prof.lineTolerance) return 4;
    // Grows with distance so a badly out-of-place unit prioritises getting back.
    return 30 + Math.min(22, d * 0.22);
  },
  act: (c) => {
    c.self.chooseFormation(c);
    c.self.moveTo(c, c.brain.standX, c.brain.standZ, c.brain.standFacing, c.cmd.pace === 'run');
  },
};

/**
 * Close with the enemy and fight. Deliberately outbids marching only when there is
 * something within reach — a line that charges the moment it sees the enemy comes
 * apart before it arrives.
 */
const Engage: Behaviour = {
  name: 'engage',
  applies: (c) => isFoot(c),
  score: (c) => {
    const targetId = c.self.pickMeleeTarget(c);
    if (targetId < 0) return -1;
    const d = distToEnemy(c, targetId);
    if (c.info.inContact) return 62;
    if (d > ENGAGE_RANGE + c.cmd.aggression * 90) return -1;
    // Aggression is the general's dial: a holding line will not step forward at all.
    // The shock wedge is the exception — its entire purpose is to go through, so it
    // outbids its own station rather than standing behind the line looking useful.
    const shockBonus = c.cmd.role === 'shock' ? 20 : 0;
    return 30 + c.cmd.aggression * 34 + shockBonus - Math.min(18, d * 0.25);
  },
  act: (c) => {
    const targetId = c.self.pickMeleeTarget(c);
    if (targetId < 0) return;
    c.self.chooseFormation(c);
    const d = distToEnemy(c, targetId);
    const mem = c.w.perceived(c.u.faction, targetId);
    if (!mem) return;

    // Warcry just before contact, when it still has time to land on morale.
    if (d < 46 && d > 8 && c.def.abilities.includes('warcry')) {
      c.self.orders.ability(c.u, 'warcry', CD_WARCRY);
    }
    // Pila at the last possible moment: 26 m is two seconds before the crash.
    if (c.def.missile && c.u.ammo > 0 && d < c.def.missile.range * 0.95) {
      if (c.def.abilities.includes('pilum-volley')) c.self.orders.ability(c.u, 'pilum-volley', CD_VOLLEY);
      else if (c.def.abilities.includes('framea-volley')) c.self.orders.ability(c.u, 'framea-volley', CD_VOLLEY);
    }
    if (d < 16 && c.def.abilities.includes('frenzy')) c.self.orders.ability(c.u, 'frenzy', CD_FRENZY);

    // A unit holding the line closes *straight forward*, keeping its lateral station.
    // An `attack` order steers the anchor at the enemy's centre, which over thirty
    // seconds of closing drags every cohort sideways toward whatever it picked and tears
    // a hole in the middle of the line. Only once the ranks are actually touching is it
    // safe to hand steering to the target.
    const holdsLine = c.cmd.role === 'line' || c.cmd.role === 'anchor';
    if (c.info.inContact || d <= (holdsLine ? 12 : ENGAGE_RANGE)) {
      c.self.orders.attack(c.u, targetId);
      return;
    }
    if (holdsLine) {
      const fwdX = Math.sin(c.brain.standFacing);
      const fwdZ = Math.cos(c.brain.standFacing);
      // How far ahead is the enemy, measured along our own front?
      const ahead = (mem.x - c.u.x) * fwdX + (mem.z - c.u.z) * fwdZ;
      const step = Math.max(0, ahead - 6);
      c.self.moveTo(
        c,
        c.brain.standX + fwdX * step,
        c.brain.standZ + fwdZ * step,
        c.brain.standFacing,
        c.cmd.pace === 'run'
      );
      return;
    }
    // Skirmishers, shock wedges and the reserve are allowed to converge on a target.
    c.self.moveTo(c, mem.x, mem.z, Math.atan2(mem.x - c.u.x, mem.z - c.u.z), c.cmd.pace === 'run');
  },
};

/**
 * Receive a charge standing still, shields locked. Moving into a charge is how a line
 * gets ridden over; halting and bracing is how it survives one.
 */
const Brace: Behaviour = {
  name: 'brace',
  applies: (c) => isFoot(c),
  score: (c) => {
    const id = c.info.closingEnemyId;
    if (id < 0) return -1;
    const mem = c.w.perceived(c.u.faction, id);
    if (!mem) return -1;
    const shock = isCavalryClass(mem.unitClass) || mem.unitClass === 'shock-infantry';
    if (!shock) return -1;
    const d = c.info.closingDist;
    if (d > 70) return -1;
    // Only worth bracing if it is actually coming at our front.
    const bearing = Math.atan2(mem.x - c.u.x, mem.z - c.u.z);
    const off = Math.abs(angleDelta(c.u.facing, bearing));
    if (off > Math.PI * 0.42) return -1;
    return 72 - d * 0.25 + c.prof.finesse * 8;
  },
  act: (c) => {
    const id = c.info.closingEnemyId;
    const mem = c.w.perceived(c.u.faction, id);
    if (!mem) return;
    c.self.orders.halt(c.u);
    // Turn toward the charge, but a unit in the middle of the line may only turn so far
    // before it opens a hole in the line either side of it. Only the ends of the line —
    // and the anchors, whose whole job is to face outward — may wheel freely.
    const wantFacing = Math.atan2(mem.x - c.u.x, mem.z - c.u.z);
    const free =
      c.cmd.role === 'anchor' || c.info.leftNeighbour < 0 || c.info.rightNeighbour < 0;
    const limit = free ? Math.PI : 0.6;
    const off = angleDelta(c.brain.standFacing, wantFacing);
    c.self.orders.face(
      c.u,
      Math.abs(off) <= limit ? wantFacing : c.brain.standFacing + Math.sign(off) * limit
    );
    if (c.def.abilities.includes('brace')) c.self.orders.ability(c.u, 'brace', CD_BRACE);
    // Spears and shield walls are the two answers to a charge; pick what we have.
    const wantForm = c.def.formations.includes('shieldwall') ? 'shieldwall' : c.def.formations[0];
    c.brain.wantFormation = wantForm;
    c.self.orders.formation(c.u, wantForm);
  },
};

/** Shields up under a beaten zone. Nearly helpless in melee, so only out of contact. */
const Testudo: Behaviour = {
  name: 'testudo',
  applies: (c) => c.def.formations.includes('testudo'),
  score: (c) => {
    if (c.info.inContact) return -1;
    if (c.info.missilePressure < TESTUDO_PRESSURE) return -1;
    // A charge arriving beats arrows: never be in testudo when horse is 40 m out.
    if (c.info.closingDist < 60) return -1;
    return 48 + Math.min(20, c.info.missilePressure * 12) * c.prof.finesse;
  },
  act: (c) => {
    c.brain.wantFormation = 'testudo';
    c.self.orders.formation(c.u, 'testudo');
    c.self.orders.ability(c.u, 'testudo', CD_TESTUDO);
    // Keep walking toward the objective under shields rather than standing to be shot.
    const d = Math.hypot(c.brain.standX - c.u.x, c.brain.standZ - c.u.z);
    if (d > c.prof.lineTolerance) c.self.moveTo(c, c.brain.standX, c.brain.standZ, c.brain.standFacing, false);
    else c.self.orders.halt(c.u);
  },
};

/**
 * Slide along the line to close a hole. An isolated block gets surrounded and dies;
 * keeping the line continuous is worth more than keeping any one unit's ideal ground.
 */
const PlugGap: Behaviour = {
  name: 'plug-gap',
  applies: (c) => isFoot(c),
  score: (c) => {
    const gap = Math.max(
      c.info.leftGap === Infinity ? 0 : c.info.leftGap,
      c.info.rightGap === Infinity ? 0 : c.info.rightGap
    );
    if (gap < GAP_LIMIT) return -1;
    if (c.info.inContact) return -1;
    return 40 + Math.min(18, (gap - GAP_LIMIT) * 0.3) * c.prof.finesse;
  },
  act: (c) => {
    const left = c.info.leftGap === Infinity ? -1 : c.info.leftGap;
    const right = c.info.rightGap === Infinity ? -1 : c.info.rightGap;
    const toLeft = left > right;
    const gap = toLeft ? left : right;
    // Take half the hole; the unit on the other side of it takes the rest.
    const shift = Math.min(gap * 0.5, 26) * (toLeft ? -1 : 1);
    c.self.moveTo(c, c.u.x + shift, c.brain.standZ, c.brain.standFacing, true);
    c.self.chooseFormation(c);
  },
};

/**
 * Turn the end of the line outward. Recognising that you are being flanked and
 * refusing it is half of not losing a battle.
 */
const RefuseFlank: Behaviour = {
  name: 'refuse-flank',
  applies: (c) => isFoot(c),
  score: (c) => {
    if (c.info.flankThreat < 0.12) return -1;
    if (Number.isNaN(c.info.flankBearing)) return -1;
    // Only the end of the line can refuse a flank; a unit in the middle cannot turn.
    const isEnd = c.info.leftNeighbour < 0 || c.info.rightNeighbour < 0 || c.cmd.role === 'anchor';
    if (!isEnd) return -1;
    return 52 + Math.min(20, c.info.flankThreat * 22) * (c.prof.flanking ? 1 : 0.4);
  },
  act: (c) => {
    // Face the threat and lock shields; do not chase it.
    c.self.orders.halt(c.u);
    c.self.orders.face(c.u, c.info.flankBearing);
    const want = c.def.formations.includes('shieldwall') ? 'shieldwall' : c.def.formations[0];
    c.brain.wantFormation = want;
    c.self.orders.formation(c.u, want);
    if (c.def.abilities.includes('brace')) c.self.orders.ability(c.u, 'brace', CD_BRACE);
  },
};

// ---------------------------------------------------------------------------
// Behaviours: missile troops
// ---------------------------------------------------------------------------

/**
 * Stand at the edge of our range and shoot the most profitable thing we can reach,
 * without dropping arrows on our own front rank.
 */
const Shoot: Behaviour = {
  name: 'shoot',
  applies: (c) => (isShooter(c) || isGun(c)) && !!c.def.missile,
  score: (c) => {
    if (c.u.ammo <= 0) return -1;
    if (c.info.inContact) return -1;
    const t = c.self.pickMissileTarget(c);
    if (t < 0) return -1;
    return 54;
  },
  act: (c) => {
    const t = c.self.pickMissileTarget(c);
    if (t < 0) return;
    const mem = c.w.perceived(c.u.faction, t);
    if (!mem) return;
    c.brain.fireTargetId = t;
    const range = c.def.missile!.range;
    const d = Math.hypot(mem.x - c.u.x, mem.z - c.u.z);
    const bearing = Math.atan2(mem.x - c.u.x, mem.z - c.u.z);

    c.self.orders.ability(c.u, 'fire-at-will', 30 * 60);
    // Massed volley on a target worth it: a dense unarmoured block in the open.
    if (c.def.abilities.includes('arrow-storm') && mem.shootValue > 120 && d < range * 0.8) {
      c.self.orders.ability(c.u, 'arrow-storm', CD_ARROW_STORM);
    }

    // Keep at the far edge of our envelope: every metre closer is a metre they can
    // cross. Only step forward if the target is out of reach — and never with a
    // bolt-thrower, which is emplaced and would take a minute to move ten metres.
    if (d > range * 0.97 && c.def.unitClass !== 'artillery') {
      const step = d - range * 0.85;
      c.self.moveTo(c, c.u.x + Math.sin(bearing) * step, c.u.z + Math.cos(bearing) * step, bearing, true);
    } else if (d < range * 0.5 && c.def.unitClass === 'missile-infantry') {
      const back = range * 0.75 - d;
      c.self.moveTo(c, c.u.x - Math.sin(bearing) * back, c.u.z - Math.cos(bearing) * back, bearing, true);
    } else {
      c.self.orders.halt(c.u);
      c.self.orders.face(c.u, bearing);
    }
    c.self.chooseFormation(c);
  },
};

/**
 * Get behind the infantry. Archers caught in the open by anything are dead archers,
 * so this outbids shooting by a wide margin once the threat is real.
 */
const MissileWithdraw: Behaviour = {
  name: 'missile-withdraw',
  applies: (c) => isShooter(c) || isGun(c),
  score: (c) => {
    const d = c.info.nearestEnemyDist;
    const id = c.info.nearestEnemyId;
    if (id < 0) return -1;
    const mem = c.w.perceived(c.u.faction, id);
    if (!mem || mem.routing) return -1;
    // Horse can cover 90 m in eleven seconds; that is the trigger distance for it.
    const trigger = isCavalryClass(mem.unitClass) ? 110 : 42;
    if (d > trigger) return -1;
    if (c.info.inContact) return 90;
    return 66 + (1 - d / trigger) * 24;
  },
  act: (c) => {
    // Retreat toward the friendly line's rear, not just "away" — running backwards
    // into open ground is how skirmishers get run down one at a time.
    const v = c.w.view(c.u.faction);
    const behind = 62;
    const bx = v.lineX - Math.sin(v.lineFacing) * behind;
    const bz = v.lineZ - Math.cos(v.lineFacing) * behind;
    c.self.moveTo(c, bx, bz, v.lineFacing, true);
    if (c.def.formations.includes('loose')) {
      c.brain.wantFormation = 'loose';
      c.self.orders.formation(c.u, 'loose');
    }
  },
};

// ---------------------------------------------------------------------------
// Behaviours: skirmishers
// ---------------------------------------------------------------------------

/**
 * Advance to throwing range, empty the hand, get out before contact. The whole point
 * of a javelin screen is that it never has to fight.
 */
const Skirmish: Behaviour = {
  name: 'skirmish',
  applies: (c) => !!c.def.missile && c.def.abilities.includes('skirmish-mode'),
  score: (c) => {
    if (c.u.ammo <= 0) return -1;
    if (c.info.inContact) return -1;
    if (c.cmd.role !== 'screen' && c.cmd.role !== 'missile') return -1;
    const t = c.self.pickMissileTarget(c);
    if (t < 0) return -1;
    return 58;
  },
  act: (c) => {
    const t = c.self.pickMissileTarget(c);
    if (t < 0) return;
    const mem = c.w.perceived(c.u.faction, t);
    if (!mem) return;
    const range = c.def.missile!.range;
    const d = Math.hypot(mem.x - c.u.x, mem.z - c.u.z);
    const bearing = Math.atan2(mem.x - c.u.x, mem.z - c.u.z);
    const brain = c.brain;
    const tick = c.w.tick;

    c.self.orders.ability(c.u, 'skirmish-mode', CD_SKIRMISH_MODE);
    if (c.def.formations.includes('skirmish')) {
      brain.wantFormation = 'skirmish';
      c.self.orders.formation(c.u, 'skirmish');
    }

    switch (brain.skirmPhase) {
      case 'advance':
        if (d <= range * 0.9) {
          brain.skirmPhase = 'loose';
          brain.skirmPhaseSince = tick;
        } else {
          const step = d - range * 0.8;
          c.self.moveTo(c, c.u.x + Math.sin(bearing) * step, c.u.z + Math.cos(bearing) * step, bearing, true);
        }
        break;
      case 'loose':
        c.self.orders.halt(c.u);
        c.self.orders.face(c.u, bearing);
        // Four seconds is three or four throws; then get out before they arrive.
        if (tick - brain.skirmPhaseSince > 30 * 4 || d < range * 0.45) {
          brain.skirmPhase = 'withdraw';
          brain.skirmPhaseSince = tick;
        }
        break;
      case 'withdraw': {
        const v = c.w.view(c.u.faction);
        const bx = v.lineX - Math.sin(v.lineFacing) * 70;
        const bz = v.lineZ - Math.cos(v.lineFacing) * 70;
        c.self.moveTo(c, bx, bz, v.lineFacing, true);
        // Once clear and still holding javelins, go again.
        if (tick - brain.skirmPhaseSince > 30 * 7 && d > range * 1.6 && c.u.ammo > 0) {
          brain.skirmPhase = 'advance';
          brain.skirmPhaseSince = tick;
        }
        break;
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Behaviours: cavalry
// ---------------------------------------------------------------------------

/**
 * The cavalry cycle: find something worth hitting, swing wide to reach its flank,
 * charge, and — crucially — come out again. Cavalry sitting in a melee is 60 men doing
 * an infantryman's job badly.
 */
const CavalryCycle: Behaviour = {
  name: 'cavalry',
  applies: (c) => isHorse(c),
  score: (c) => 46 + c.cmd.aggression * 12,
  act: (c) => {
    const brain = c.brain;
    const tick = c.w.tick;
    const self = c.self;

    if (c.def.formations.includes('wedge') && brain.cavPhase === 'charge') {
      brain.wantFormation = 'wedge';
      self.orders.formation(c.u, 'wedge');
    }

    switch (brain.cavPhase) {
      case 'hunt': {
        const t = self.pickCavalryTarget(c);
        const target = t >= 0 ? c.battleUnit(t) : undefined;
        const mem = t >= 0 ? c.w.perceived(c.u.faction, t) : undefined;
        if (!target || !mem) {
          // Nothing worth charging: sit on the assigned wing and watch.
          self.moveTo(c, c.brain.standX, c.brain.standZ, c.brain.standFacing, false);
          return;
        }
        brain.cavTargetId = t;
        const exposure = c.w.exposure(target, c.u.x, c.u.z);
        // A soft target is worth charging head-on — but only if we can actually get at
        // it. Archers standing behind an intact line are not reachable in a straight
        // line however soft they are.
        const screened = c.w.approachScreened(c.u.faction, c.u.x, c.u.z, t);
        const soft = (isMissileClass(mem.unitClass) || mem.routing) && !screened;
        if ((exposure > 0.45 && !screened) || soft || !c.prof.flanking) {
          brain.cavPhase = 'charge';
          brain.cavPhaseSince = tick;
        } else {
          self.planSwing(c, t);
          brain.cavPhase = 'swing';
          brain.cavPhaseSince = tick;
        }
        break;
      }
      case 'swing': {
        const t = brain.cavTargetId;
        const mem = c.w.perceived(c.u.faction, t);
        if (!mem || mem.alive <= 0) {
          brain.cavPhase = 'hunt';
          brain.cavPhaseSince = tick;
          return;
        }
        // Caught on the way round. Fight or run, but do not keep riding for a staging
        // point with somebody's spear in your horse.
        if (c.info.inContact) {
          brain.cavPhase = 'stuck';
          brain.cavPhaseSince = tick;
          return;
        }
        const d = Math.hypot(brain.swingX - c.u.x, brain.swingZ - c.u.z);
        self.moveTo(c, brain.swingX, brain.swingZ, Math.atan2(mem.x - brain.swingX, mem.z - brain.swingZ), true);
        // Arrived on the flank, or the swing has taken too long and the moment is gone.
        if (d < 26 || tick - brain.cavPhaseSince > 30 * 22) {
          brain.cavPhase = 'charge';
          brain.cavPhaseSince = tick;
        }
        break;
      }
      case 'charge': {
        const t = brain.cavTargetId;
        const target = c.battleUnit(t);
        const mem = c.w.perceived(c.u.faction, t);
        if (!target || target.destroyed || !mem) {
          brain.cavPhase = 'hunt';
          brain.cavPhaseSince = tick;
          return;
        }
        const d = distToEnemy(c, t);
        if (d < 90) self.orders.ability(c.u, 'charge', CD_CHARGE);
        if (d < 60 && c.def.abilities.includes('warcry')) self.orders.ability(c.u, 'warcry', CD_WARCRY);
        self.orders.attack(c.u, t);
        if (c.info.inContact) {
          brain.cavPhase = 'stuck';
          brain.cavPhaseSince = tick;
        }
        break;
      }
      case 'stuck': {
        const t = brain.cavTargetId;
        const mem = c.w.perceived(c.u.faction, t);
        // Keep fighting while the fight is still going our way; the charge bonus is
        // spent within a few seconds, and after that we are just losing horses.
        const worth = mem ? matchup(c.def.unitClass, mem.unitClass) : 0;
        const stuckFor = tick - brain.cavPhaseSince;
        const patience = CAV_STUCK_TICKS * (1.4 - c.prof.cavalryDiscipline);
        if (!c.info.inContact) {
          brain.cavPhase = 'hunt';
          brain.cavPhaseSince = tick;
        } else if (stuckFor > patience || worth < 0.7) {
          brain.cavPhase = 'withdraw';
          brain.cavPhaseSince = tick;
        } else if (mem) {
          self.orders.attack(c.u, t);
        }
        break;
      }
      case 'withdraw': {
        // Pull back onto our own side of the field, out of reach, then re-form.
        const v = c.w.view(c.u.faction);
        const bx = c.u.x + (c.u.x - v.lineX) * 0.15 - Math.sin(v.lineFacing) * 90;
        const bz = c.u.z - Math.cos(v.lineFacing) * 90;
        self.moveTo(c, bx, bz, v.lineFacing, true);
        if (!c.info.inContact && tick - brain.cavPhaseSince > 30 * 3) {
          brain.cavPhase = 'reform';
          brain.cavPhaseSince = tick;
        }
        break;
      }
      case 'reform': {
        self.orders.halt(c.u);
        if (c.def.formations.includes('wedge')) {
          brain.wantFormation = 'wedge';
          self.orders.formation(c.u, 'wedge');
        }
        if (tick - brain.cavPhaseSince > CAV_REFORM_TICKS) {
          brain.cavPhase = 'hunt';
          brain.cavPhaseSince = tick;
        }
        break;
      }
    }
  },
};

/** Run down the broken. Nothing else on the field is worth this much for this little. */
const Pursue: Behaviour = {
  name: 'pursue',
  applies: (c) => c.cmd.allowPursuit && (isHorse(c) || c.def.unitClass === 'light-infantry'),
  score: (c) => {
    const t = c.self.pickRoutingTarget(c);
    if (t < 0) return -1;
    return 68;
  },
  act: (c) => {
    const t = c.self.pickRoutingTarget(c);
    if (t < 0) return;
    c.self.orders.attack(c.u, t);
  },
};

// ---------------------------------------------------------------------------
// Behaviours: general officers and last resorts
// ---------------------------------------------------------------------------

/** Stand behind the line where the standard can be seen, and inspire. */
const Inspire: Behaviour = {
  name: 'inspire',
  applies: (c) => c.def.abilities.includes('inspire'),
  score: (c) => {
    // Worth using when neighbours are wavering, not as an opener.
    let wobbly = 0;
    for (const rec of c.w.info.values()) {
      if (rec.faction !== c.u.faction || rec.unitId === c.u.id) continue;
      if (Math.hypot(rec.unit.x - c.u.x, rec.unit.z - c.u.z) > 90) continue;
      if (rec.unit.morale < rec.unit.maxMorale * 0.55) wobbly++;
    }
    return wobbly >= 2 ? 46 + wobbly * 3 : -1;
  },
  act: (c) => {
    c.self.orders.ability(c.u, 'inspire', CD_INSPIRE);
    // Inspiring is not an excuse to stop doing our job.
    c.self.moveTo(c, c.brain.standX, c.brain.standZ, c.brain.standFacing, false);
  },
};

/**
 * Sit on the wing and watch. Cavalry that has not been released by the general holds
 * its ground: the whole value of a mounted reserve is that it is still there when the
 * moment arrives, and horse that goes hunting on its own initiative in the first minute
 * is horse that is blown and out of position when it is needed.
 */
const CavalryHold: Behaviour = {
  name: 'cavalry-hold',
  applies: (c) => isHorse(c),
  score: (c) => {
    if (c.cmd.aggression >= 0.5) return -1;
    if (c.info.inContact) return -1;
    // Enemy horse on our wing is the screen's business, not the holding station's.
    if (c.self.enemyHorseOnOurWing(c) >= 0) return -1;
    return 58;
  },
  act: (c) => {
    c.brain.cavPhase = 'hunt';
    c.brain.cavTargetId = -1;
    const d = Math.hypot(c.brain.standX - c.u.x, c.brain.standZ - c.u.z);
    if (d > 14) c.self.moveTo(c, c.brain.standX, c.brain.standZ, c.brain.standFacing, d > 90);
    else {
      c.self.orders.halt(c.u);
      c.self.orders.face(c.u, c.brain.standFacing);
    }
    c.self.chooseFormation(c);
  },
};

/**
 * Screen our own wing against enemy horse.
 *
 * Cavalry that has not been released should not go hunting the moment enemy riders
 * appear — but it must not stand and watch them go round the flank either. The answer,
 * and what Roman cavalry on a wing was actually for, is to interpose: keep station
 * between the threat and the end of our own line, matching it as it moves, and only
 * charge once it is close enough that the charge will land. That keeps our own horse
 * fresh, in position and available for the counter-punch.
 */
const CavalryScreen: Behaviour = {
  name: 'cavalry-screen',
  applies: (c) => isHorse(c),
  score: (c) => {
    if (c.cmd.aggression >= 0.5) return -1;
    if (c.info.inContact) return -1;
    return c.self.enemyHorseOnOurWing(c) >= 0 ? 64 : -1;
  },
  act: (c) => {
    const threatId = c.self.enemyHorseOnOurWing(c);
    const mem = threatId >= 0 ? c.w.perceived(c.u.faction, threatId) : undefined;
    if (!mem) return;
    const d = Math.hypot(mem.x - c.u.x, mem.z - c.u.z);
    const bearing = Math.atan2(mem.x - c.u.x, mem.z - c.u.z);

    // Inside charge range the screen becomes a charge: better to hit them moving than to
    // be hit standing, and light horse loses a stationary fight against heavy horse.
    if (d < 55) {
      c.brain.cavPhase = 'charge';
      c.brain.cavTargetId = threatId;
      c.brain.cavPhaseSince = c.w.tick;
      c.self.orders.ability(c.u, 'charge', CD_CHARGE);
      c.self.orders.attack(c.u, threatId);
      return;
    }
    // Otherwise interpose: two thirds of the way from our station toward them, so we
    // stay tied to the wing we are covering.
    const ix = c.brain.standX + (mem.x - c.brain.standX) * 0.34;
    const iz = c.brain.standZ + (mem.z - c.brain.standZ) * 0.34;
    c.self.moveTo(c, ix, iz, bearing, d > 120);
    c.self.chooseFormation(c);
  },
};

const BEHAVIOURS: Behaviour[] = [
  HoldLine, MarchToStation, Engage, Brace, Testudo, PlugGap, RefuseFlank,
  Shoot, MissileWithdraw, Skirmish, CavalryHold, CavalryScreen, CavalryCycle, Pursue, Inspire,
];

// ---------------------------------------------------------------------------
// The subsystem
// ---------------------------------------------------------------------------

export class TacticalAISystem implements Subsystem {
  readonly name = 'tactical-ai';
  readonly order = 42;

  readonly world: AIWorld;
  orders!: OrderBook;
  private battle!: BattleSystem;
  private nav!: PathfindingSystem;
  private brains = new Map<number, UnitBrain>();
  private rng!: Rng;
  private tick = 0;
  difficulty: Difficulty;

  readonly stats = { thinks: 0, forcedThinks: 0 };

  /**
   * Factions this layer issues orders for. Anything not listed is left alone.
   *
   * Without this the tactical layer commanded *every* unit on the field regardless of
   * side, so a human player's orders were overwritten within half a second — a move order
   * was re-issued 25 times in ten seconds and drifted 46 m off the ordered point, and a
   * formation change was undone as soon as the clock was unpaused. `commanded` was being
   * passed to `GeneralAISystem` and silently dropped here.
   */
  private commanded: Set<Faction>;

  constructor(world: AIWorld, difficulty: Difficulty = 'hard', commanded: Faction[] = [...ALL_FACTIONS]) {
    this.commanded = new Set(commanded);
    this.world = world;
    this.difficulty = difficulty;
  }

  init(ctx: EngineContext): void {
    this.battle = ctx.get<BattleSystem>('battle');
    this.nav = ctx.get<PathfindingSystem>('pathfinding');
    this.orders = new OrderBook(ctx.events);
    // Forked once, held forever: `fork` does not advance the parent, so forking every
    // tick would hand out the same stream over and over.
    this.rng = this.battle.rng.fork('ai-tactical');
    if (!this.world.battle) this.world.attach(this.battle, this.nav);

    CTX.self = this;
    CTX.w = this.world;
    CTX.battleUnit = (id: number) => this.battle.unitById(id);
  }

  get profile(): DifficultyProfile {
    return DIFFICULTY[this.difficulty];
  }

  brainOf(unitId: number): UnitBrain | undefined {
    return this.brains.get(unitId);
  }

  fixedUpdate(dt: number, ctx: EngineContext): void {
    const t0 = profileBegin();
    this.tick++;
    this.orders.setTick(this.tick);
    this.world.refresh(this.tick, ctx.time.simTime);
    const prof = this.profile;

    for (const info of this.world.info.values()) {
      const u = info.unit;
      if (u.destroyed) continue;
      // Not our army — the player, or another controller, owns this unit.
      if (!this.commanded.has(u.faction)) continue;
      // A broken unit takes no orders; the sim drives it off the field.
      if (u.order === UnitOrder.Rout) continue;

      const brain = this.brain(u.id, prof);
      // Contact starting or stopping, or something fast arriving, cannot wait for the
      // next scheduled think — being a third of a second late to brace is the difference
      // between holding and breaking. Both are *edges*, not states: re-thinking every
      // tick while a charge is inbound would triple the cost and change nothing.
      const closingNear = info.closingDist < 55;
      const forced =
        brain.wasInContact !== info.inContact ||
        (closingNear && !brain.wasClosingNear);
      brain.wasInContact = info.inContact;
      brain.wasClosingNear = closingNear;

      if (this.tick < brain.nextThinkTick && !forced) continue;
      if (forced && this.tick < brain.nextThinkTick) this.stats.forcedThinks++;
      brain.nextThinkTick = this.tick + prof.thinkInterval;
      this.stats.thinks++;

      this.think(u, info, brain, prof);
    }

    // Drop bookkeeping for units that have left the field. Ten-second interval because
    // it is pure housekeeping and there is no reason to pay for it every tick.
    if (this.tick % 300 === 0) {
      for (const id of this.brains.keys()) {
        if (!this.world.info.has(id)) {
          this.brains.delete(id);
          this.orders.forget(id);
          this.nav.clearPath(id);
        }
      }
    }

    void dt;
    profileEnd('tactical', t0);
  }

  private brain(unitId: number, prof: DifficultyProfile): UnitBrain {
    let b = this.brains.get(unitId);
    if (!b) {
      b = {
        unitId,
        // Stagger the first think across the interval so nothing all fires at once.
        nextThinkTick: this.tick + (unitId % prof.thinkInterval),
        behaviour: '', score: 0, since: this.tick,
        wasInContact: false, wasClosingNear: false,
        cavPhase: 'hunt', cavPhaseSince: this.tick, cavTargetId: -1, swingX: 0, swingZ: 0,
        skirmPhase: 'advance', skirmPhaseSince: this.tick,
        fireTargetId: -1, wantFormation: '', squeezing: false,
        standX: 0, standZ: 0, standFacing: 0,
      };
      this.brains.set(unitId, b);
    }
    return b;
  }

  /** Score every applicable behaviour and run the winner. */
  private think(u: UnitGroupState, info: UnitInfo, brain: UnitBrain, prof: DifficultyProfile): void {
    const cmd = this.world.commandOf(u.id) ?? this.fallbackCommand(u);
    CTX.info = info;
    CTX.brain = brain;
    CTX.cmd = cmd;
    CTX.prof = prof;
    CTX.u = u;
    CTX.def = info.def;

    // Resolve the stand position once, so every score and act sees the same answer.
    this.resolveStation(CTX);

    let best: Behaviour | null = null;
    let bestScore = -Infinity;
    for (const b of BEHAVIOURS) {
      if (!b.applies(CTX)) continue;
      let s = b.score(CTX);
      if (s < 0) continue;
      // Hysteresis: the incumbent is worth a few points, so units commit.
      if (b.name === brain.behaviour) s += 6;
      if (s > bestScore) {
        bestScore = s;
        best = b;
      }
    }
    if (!best) return;
    if (best.name !== brain.behaviour) {
      brain.behaviour = best.name;
      brain.since = this.tick;
    }
    brain.score = bestScore;
    best.act(CTX);
  }

  /** Used before the general has issued anything, and if a unit is somehow orphaned. */
  private fallbackCommand(u: UnitGroupState): UnitCommand {
    return {
      unitId: u.id, role: 'line',
      stationX: u.x, stationZ: u.z, stationFacing: u.facing,
      preferredTargetId: -1, aggression: 0.2, pace: 'walk',
      allowPursuit: false, held: false, issuedTick: this.tick,
    };
  }

  // -------------------------------------------------------------------------
  // Movement helpers used by the behaviours
  // -------------------------------------------------------------------------

  /**
   * Issue a move, going through the navigation grid only when the straight line does
   * not work. On open ground that is almost always, and it costs one corridor test.
   */
  moveTo(c: Ctx, x: number, z: number, facing: number, running: boolean): void {
    const u = c.u;
    const fp = footprintOf(u, c.def);
    // Never order a formation into the river or onto a cliff.
    if (!this.nav.findStandable(x, z, fp.min, STAND)) {
      STAND.x = x;
      STAND.z = z;
    }
    const gx = STAND.x;
    const gz = STAND.z;

    if (this.nav.directRouteClear(u.x, u.z, gx, gz, fp.max)) {
      if (c.brain.squeezing) {
        c.brain.squeezing = false;
        this.chooseFormation(c);
      }
      this.orders.move(u, gx, gz, facing, running);
      return;
    }

    // Something is in the way. If the whole army is heading for the same objective,
    // read the shared flow field rather than running a search per unit — that is the
    // case a flow field exists for.
    const key = `army${u.faction}`;
    const field = this.nav.flowField(key, c.cmd.stationX, c.cmd.stationZ);
    if (field.ready && Math.hypot(field.goalX - gx, field.goalZ - gz) < 45) {
      const n = this.nav.flowRoute(key, gx, gz, u.x, u.z, fp.max, FLOW_OUT);
      if (n >= 2) {
        this.orders.followPath(u, FLOW_OUT, n, facing, running);
        return;
      }
    }

    const cached = this.nav.pathFor(u.id);
    if (!cached || this.nav.pathStale(cached, gx, gz)) {
      if (!this.nav.pending(u.id)) {
        this.nav.requestPath(u.id, u.x, u.z, gx, gz, fp.max, fp.min, c.cmd.role === 'line' ? 2 : 1);
      }
      // Until the route lands, close the distance on the straight line — the sim's
      // crowd solver will keep men out of each other, and one tick of imperfect
      // movement is better than standing still under fire.
      if (cached && cached.ok) this.orders.followPath(u, cached.pts, cached.n, facing, running);
      return;
    }
    // A route that only a column fits through: narrow the frontage before entering it.
    if (cached.narrow && !c.brain.squeezing) {
      c.brain.squeezing = true;
      const narrow = narrowestFormation(c.def, u.alive || u.initialStrength);
      c.brain.wantFormation = narrow;
      this.orders.formation(u, narrow);
    }
    this.orders.followPath(u, cached.pts, cached.n, facing, running);
  }

  /**
   * Resolve the position this unit should actually stand on: the general's station,
   * shifted to keep contact with its neighbours and moved onto the better of the ground
   * on offer. Written to the brain, never back into the general's plan — a local
   * adjustment must not accumulate into army-level drift.
   *
   * Rome II's lines look deliberate because units dress on each other rather than each
   * marching to an abstract point.
   */
  private resolveStation(c: Ctx): void {
    const brain = c.brain;
    const info = c.info;
    brain.standX = c.cmd.stationX;
    brain.standZ = c.cmd.stationZ;
    brain.standFacing = c.cmd.stationFacing;
    if (!isLineUnit(c.def.unitClass)) return;

    let shift = 0;
    if (info.leftGap !== Infinity && info.leftGap > 6) shift -= Math.min(info.leftGap * 0.35, 12);
    if (info.rightGap !== Infinity && info.rightGap > 6) shift += Math.min(info.rightGap * 0.35, 12);
    // Overlapping is worse than a gap: back off hard if we are inside a neighbour.
    if (info.leftGap !== Infinity && info.leftGap < 0) shift -= info.leftGap * 0.6;
    if (info.rightGap !== Infinity && info.rightGap < 0) shift += info.rightGap * 0.6;
    brain.standX += shift * 0.5;
    this.pickGround(brain, info.nearestLineEnemyDist);
  }

  /**
   * Enemy cavalry heading for the wing this unit is covering, or -1. "Our wing" is the
   * half of the line our station sits on; horse crossing to the far wing is somebody
   * else's problem and chasing it uncovers our own.
   */
  enemyHorseOnOurWing(c: Ctx): number {
    const v = this.world.view(c.u.faction);
    const ourSide = Math.sign(c.brain.standX - v.lineX) || 1;
    let best = -1;
    let bestD = CAVALRY_SCREEN_RANGE;
    for (const mem of v.seen.values()) {
      if (!isCavalryClass(mem.unitClass) || mem.routing || mem.alive <= 0) continue;
      if (Math.sign(mem.x - v.lineX) !== ourSide) continue;
      const d = Math.hypot(mem.x - c.u.x, mem.z - c.u.z);
      if (d < bestD) {
        bestD = d;
        best = mem.unitId;
      }
    }
    return best;
  }

  /**
   * Choose the staging point for a flanking charge: off the target's exposed side and
   * a little behind its front rank, on the *outside* of the enemy line where there is
   * open ground, unless our own side is dramatically closer.
   */
  planSwing(c: Ctx, targetId: number): void {
    const target = this.battle.unitById(targetId);
    if (!target) return;
    const mem = this.world.perceived(c.u.faction, targetId);
    const half = mem?.halfFront ?? 12;

    // The target's right-hand vector, and its forward.
    const rx = Math.cos(target.facing);
    const rz = -Math.sin(target.facing);
    const fx = Math.sin(target.facing);
    const fz = Math.cos(target.facing);

    // Where does the enemy line end? Measured from our own perception, projected onto
    // the target's lateral axis. The swing has to clear the whole line, not merely the
    // target's own flank, or the ride ends inside somebody else's formation.
    let latMin = -half;
    let latMax = half;
    for (const mem of this.world.view(c.u.faction).seen.values()) {
      if (mem.routing || mem.alive <= 0) continue;
      if (!isLineUnit(mem.unitClass)) continue;
      const lat = (mem.x - target.x) * rx + (mem.z - target.z) * rz;
      latMin = Math.min(latMin, lat - mem.halfFront);
      latMax = Math.max(latMax, lat + mem.halfFront);
    }

    // The line to swing around is the *target's own* army's, not "the other side's".
    // `enemyOf` is a two-faction flip, so with a third army on the field a cohort sent to
    // flank a Carthaginian was measuring outwards from the Germanic line and picking its
    // side from a formation on the far side of the battlefield.
    const enemyView = this.world.view(target.faction);
    const outward = (target.x - enemyView.lineX) * rx + (target.z - enemyView.lineZ) * rz;
    let side = outward >= 0 ? 1 : -1;
    const reachFor = (s: number): number => (s > 0 ? latMax : -latMin) + 62;
    const ourSide = (c.u.x - target.x) * rx + (c.u.z - target.z) * rz >= 0 ? 1 : -1;
    if (ourSide !== side) {
      // Riding the long way round the whole line is usually worse than taking the near
      // flank; only insist on the outside if it is not much further.
      const dOut = Math.hypot(
        target.x + rx * side * reachFor(side) - c.u.x,
        target.z + rz * side * reachFor(side) - c.u.z
      );
      const dOur = Math.hypot(
        target.x + rx * ourSide * reachFor(ourSide) - c.u.x,
        target.z + rz * ourSide * reachFor(ourSide) - c.u.z
      );
      if (dOur + 70 < dOut) side = ourSide;
    }

    const reach = reachFor(side);
    const px = target.x + rx * side * reach - fx * 30;
    const pz = target.z + rz * side * reach - fz * 30;
    const fp = footprintOf(c.u, c.def);
    if (!this.nav.findStandable(px, pz, fp.min, STAND)) {
      STAND.x = px;
      STAND.z = pz;
    }
    c.brain.swingX = STAND.x;
    c.brain.swingZ = STAND.z;
  }

  /**
   * Fight downhill where the choice exists: two candidate positions a short bound in
   * front of and behind the station, taken only if one is *meaningfully* higher.
   *
   * The threshold matters more than it looks. The Campus Martius rises about one per
   * cent, so a 10 m step back gains 25 cm — and an AI that takes it steps back,
   * re-measures, steps back again, and spends the battle walking backwards up an
   * imperceptible slope with its flank to the enemy. Below MIN_GROUND_GAIN the ground is
   * flat and the ordered station is the right answer. And once the enemy is close there
   * is no time to be choosy: giving ground for a foot of height with a charge inbound is
   * worse than standing still.
   */
  private pickGround(brain: UnitBrain, enemyDist: number): void {
    if (enemyDist < 70) return;
    const fx = Math.sin(brain.standFacing);
    const fz = Math.cos(brain.standFacing);
    const base = this.nav.groundHeight(brain.standX, brain.standZ);
    let bestGain = MIN_GROUND_GAIN;
    let bestX = brain.standX;
    let bestZ = brain.standZ;
    for (const off of GROUND_OFFSETS) {
      const px = brain.standX - fx * off;
      const pz = brain.standZ - fz * off;
      if (this.nav.isWater(px, pz)) continue;
      if (this.nav.slopeAt(px, pz) > 0.4) continue;
      const gain = this.nav.groundHeight(px, pz) - base;
      if (gain > bestGain) {
        bestGain = gain;
        bestX = px;
        bestZ = pz;
      }
    }
    brain.standX = bestX;
    brain.standZ = bestZ;
  }

  // -------------------------------------------------------------------------
  // Target selection
  // -------------------------------------------------------------------------

  /** Best enemy for an infantry unit to fight: the general's pick unless it is silly. */
  pickMeleeTarget(c: Ctx): number {
    const w = this.world;
    // Already fighting someone. Turning away from the man in front of you to deal with
    // something behind you is how a line comes apart — that is the reserve's problem,
    // not the front rank's.
    if (c.info.inContact && c.info.contactEnemyId >= 0) return c.info.contactEnemyId;

    const holdsLine = c.cmd.role === 'line' || c.cmd.role === 'anchor';
    const arc = holdsLine ? 1.4 : Math.PI; // 80 degrees either side of the ordered front

    const pref = c.cmd.preferredTargetId;
    if (pref >= 0) {
      const mem = w.perceived(c.u.faction, pref);
      if (mem && mem.alive > 0 && !mem.routing) {
        const d = Math.hypot(mem.x - c.u.x, mem.z - c.u.z);
        const off = Math.abs(angleDelta(c.brain.standFacing, Math.atan2(mem.x - c.u.x, mem.z - c.u.z)));
        if (d < 260 && off < arc) return pref;
      }
    }
    // Otherwise the nearest thing in front of us that we do not lose to outright.
    let best = -1;
    let bestScore = -Infinity;
    for (const mem of w.view(c.u.faction).seen.values()) {
      if (mem.alive <= 0 || mem.routing) continue;
      const dx = mem.x - c.u.x;
      const dz = mem.z - c.u.z;
      const d = Math.hypot(dx, dz);
      if (d > 240) continue;
      const bearing = Math.atan2(dx, dz);
      const off = Math.abs(angleDelta(c.brain.standFacing, bearing));
      if (off > arc) continue;
      const mu = matchup(c.def.unitClass, mem.unitClass);
      // Close, in front, and beatable.
      const s = (140 / (20 + d)) * 10 + mu * 8 - off * 6;
      if (s > bestScore) {
        bestScore = s;
        best = mem.unitId;
      }
    }
    return best;
  }

  /**
   * Missile target selection: the juiciest thing we can actually hit. Value first
   * (dense, unarmoured, dangerous), then range, then a hard veto if our own men are
   * in the beaten zone.
   */
  pickMissileTarget(c: Ctx): number {
    const m = c.def.missile;
    if (!m) return -1;
    const w = this.world;
    let best = -1;
    let bestScore = -Infinity;
    for (const mem of w.view(c.u.faction).seen.values()) {
      if (!mem.visible || mem.alive <= 0) continue;
      const d = Math.hypot(mem.x - c.u.x, mem.z - c.u.z);
      if (d > m.range * 1.35) continue;
      // A flat-trajectory weapon needs a clear line; an arcing one drops over hills.
      if (m.arc === 'flat' && !this.nav.directRouteClear(c.u.x, c.u.z, mem.x, mem.z, 0)) continue;
      // Never loose into a melee our own men are in.
      if (w.friendlyFireRisk(c.u, mem.x, mem.z)) continue;
      let s = mem.shootValue * 0.6;
      // Prefer things inside our envelope, and heavily prefer what is coming at us.
      s -= Math.max(0, d - m.range) * 2.2;
      s += (isCavalryClass(mem.unitClass) ? 40 : 0) * c.prof.finesse;
      if (mem.routing) s *= 0.3;
      if (s > bestScore) {
        bestScore = s;
        best = mem.unitId;
      }
    }
    return best;
  }

  /**
   * Cavalry target selection, which is where most AI cavalry embarrasses itself.
   * Rules, in order of weight: never the front of a braced spear wall; artillery and
   * archers first; then an exposed flank, best of all one already pinned by our
   * infantry; then anything already broken.
   */
  pickCavalryTarget(c: Ctx): number {
    const w = this.world;
    let best = -1;
    let bestScore = 0;
    for (const mem of w.view(c.u.faction).seen.values()) {
      if (mem.alive <= 0) continue;
      const target = this.battle.unitById(mem.unitId);
      if (!target || target.destroyed) continue;
      const d = Math.hypot(mem.x - c.u.x, mem.z - c.u.z);
      if (d > 420) continue;

      const def = this.battle.typeOf(target);
      const exposure = w.exposure(target, c.u.x, c.u.z);

      // The one hard rule of cavalry: not into the points.
      if (isAntiCavalry(def) && exposure < 0.4) {
        // A worse AI sometimes does it anyway — that is what "easy" means.
        if (this.rng.next() < c.prof.spearAwareness) continue;
      }

      let s = 20;
      s += matchup(c.def.unitClass, mem.unitClass) * 26;
      s += exposure * 34;
      if (isMissileClass(mem.unitClass)) s += 30;
      if (mem.routing) s += 40;
      // Something we have to ride round the enemy line to reach is worth less than the
      // same prize sitting in the open, because getting there costs a minute.
      if (w.approachScreened(c.u.faction, c.u.x, c.u.z, mem.unitId)) s -= 22;
      // A unit already fighting our infantry cannot turn to face us. This is the shot.
      const trec = w.infoOf(mem.unitId);
      if (trec?.inContact) s += 26;
      s -= d * 0.09;
      // Do not ride across the whole field past closer opportunities.
      if (d > 260) s -= 25;
      if (s > bestScore) {
        bestScore = s;
        best = mem.unitId;
      }
    }
    return best;
  }

  /** Nearest broken enemy worth chasing. */
  pickRoutingTarget(c: Ctx): number {
    const w = this.world;
    let best = -1;
    let bestD = 260;
    for (const mem of w.view(c.u.faction).seen.values()) {
      if (!mem.routing || mem.alive <= 0) continue;
      const d = Math.hypot(mem.x - c.u.x, mem.z - c.u.z);
      if (d < bestD) {
        bestD = d;
        best = mem.unitId;
      }
    }
    return best;
  }

  /**
   * Default formation for the situation, used by every behaviour that is not making a
   * specific formation choice of its own.
   */
  chooseFormation(c: Ctx): void {
    if (c.brain.squeezing) return; // threading a gap: keep the narrow frontage
    const def = c.def;
    const info = c.info;
    let want = def.formations[0];

    if (isCavalryClass(def.unitClass)) {
      want = def.formations.includes('wedge') ? 'wedge' : def.formations[0];
    } else if (def.unitClass === 'missile-infantry') {
      want = def.formations.includes('skirmish') && def.abilities.includes('skirmish-mode')
        ? 'skirmish'
        : def.formations.includes('loose') ? 'loose' : def.formations[0];
    } else if (c.cmd.role === 'shock') {
      want = def.formations.includes('wedge') ? 'wedge' : def.formations[0];
    } else if (isLineUnit(def.unitClass)) {
      // Hysteresis on every threshold. Changing formation costs seconds of shuffling,
      // so a unit that flips between line and shield wall as a horseman drifts across
      // the 80 m mark spends the whole battle re-dressing instead of fighting.
      const held = c.brain.wantFormation;
      const shockDist = held === 'shieldwall' ? 130 : 80;
      const shockClosing =
        info.closingEnemyId >= 0 &&
        info.closingDist < shockDist &&
        (() => {
          const mem = c.w.perceived(c.u.faction, info.closingEnemyId);
          return !!mem && (isCavalryClass(mem.unitClass) || mem.unitClass === 'shock-infantry');
        })();
      const testudoIn = held === 'testudo' ? TESTUDO_PRESSURE * 0.6 : TESTUDO_PRESSURE;
      const looseIn = held === 'loose' ? TESTUDO_PRESSURE * 0.4 : TESTUDO_PRESSURE * 0.7;
      // Testudo and loose order are both answers to missiles, and both are answers you
      // must be out of before contact: a tortoise has an attack modifier of 0.42.
      const canOpenUp = !info.inContact && info.nearestLineEnemyDist > 45;
      if (shockClosing && def.formations.includes('shieldwall')) want = 'shieldwall';
      else if (info.missilePressure > testudoIn && def.formations.includes('testudo') && canOpenUp) {
        want = 'testudo';
      } else if (info.missilePressure > looseIn && def.formations.includes('loose') && canOpenUp) {
        // Tribesmen have no testudo; spreading out is their answer to arrows.
        want = 'loose';
      } else if (def.formations.includes('horde') && c.cmd.aggression > 0.6) {
        want = 'horde';
      } else {
        want = def.formations.includes('line') ? 'line' : def.formations[0];
      }
    }

    if (want !== c.brain.wantFormation) c.brain.wantFormation = want;
    this.orders.formation(c.u, want);
  }

  /** Debug read-out: what each unit is currently doing. */
  describe(unitId: number): string {
    const b = this.brains.get(unitId);
    if (!b) return '-';
    if (b.behaviour === 'cavalry') return `cavalry:${b.cavPhase}`;
    if (b.behaviour === 'skirmish') return `skirmish:${b.skirmPhase}`;
    return b.behaviour;
  }
}
