import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from '../sim/BattleSystem';
import { ALL_FACTIONS, Faction, type UnitGroupState } from '../sim/types';
import { angleDelta, wrapAngle } from '../util/math';
import type { Rng } from '../util/rand';
import { AIWorld, isLineUnit, type PerceivedEnemy } from './AIWorld';
import { footprintOf, type PathfindingSystem } from './Pathfinding';
import { profileBegin, profileEnd } from './profile';
import {
  DIFFICULTY, isCavalryClass, isMissileClass,
  type AIRole, type BattlePhase, type Difficulty, type DifficultyProfile, type UnitCommand,
} from './types';

/**
 * Army-level command: the layer that makes the enemy feel like an opponent.
 *
 * Structured as a **phase machine with guarded transitions**, wrapped around a
 * utility scorer for the two decisions that are genuinely continuous — where to mass,
 * and when to spend the reserve.
 *
 * Why not a behaviour tree at this level? Because a tree re-evaluated at 30 Hz dithers.
 * An army has to *commit*: once it has begun its advance, changing its mind every half
 * second produces a mob milling in the middle of the field, which is exactly the tell
 * of a bad RTS AI. A phase, entered on an explicit condition and left on another
 * explicit condition, gives the battle a shape you can name — screen, advance, clash,
 * exploit, pursuit — and it prints in one line for debugging.
 *
 * Two doctrines, and they should be recognisable from the stands:
 *
 *  - **Juthungi (germanic-shock).** Skirmishers screen and empty their hands, the
 *    warbands come on fast in a mass, the Chosen form a wedge aimed at the weakest
 *    point of the Roman line, and the horse raiders ride wide for the flanks. It is a
 *    doctrine that spends everything on the first shock, because Germanic armies of
 *    the third century had no mechanism for a second one.
 *  - **Rome (roman-attrition).** Advance in order to chosen ground, halt, dress the
 *    line, kill the charge with pila and archery, refuse both flanks with spears, hold
 *    the Praetorians out of it, and put the cavalry in only when there is a flank to
 *    take or a line to save. Rome wins battles by not losing them for long enough.
 *
 * Difficulty never touches a stat and never sees through fog: it changes reaction time,
 * how well the weak point is identified, whether flanking is attempted at all, and how
 * boldly the reserve is spent.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Lateral gap left between neighbouring units in a fully dressed battle line. */
const LINE_INTERVAL = 15;
/** Anchors sit this far behind the line, turned outward. */
const ANCHOR_SETBACK = 16;
/** Angle an anchor turns away from the line's front. */
const ANCHOR_SPLAY = Math.PI * 0.22;
/** Missile troops shoot from this far behind the line. */
const MISSILE_SETBACK = 52;
/** Artillery is further back still. */
const ARTILLERY_SETBACK = 110;
/** The reserve waits this far behind the point of decision. */
const RESERVE_SETBACK = 62;
/** Cavalry waits this far behind the line, out beyond its flank. */
const CAVALRY_SETBACK = 70;
const CAVALRY_OUTBOARD = 58;

/**
 * Fraction of the ground between the armies that Rome is willing to give up. A third,
 * because the point of advancing at all is to fight clear of the unfinished wall — not
 * to meet the Juthungi halfway and hand them the choice of ground.
 */
const ROMAN_CLOSE_FRACTION = 0.45;
/** Hard cap on the Roman advance — the wall behind them is unfinished, not useless. */
const ROMAN_CLOSE_MAX = 150;

/** Below this share of its starting power an army starts thinking about leaving. */
const WITHDRAW_POWER = 0.26;
/** And above this share it has rallied enough to turn round and fight again. */
const RALLY_POWER = 0.42;
/**
 * Hard cap on how far forward a pursuit will carry the line. Running broken men down is
 * worth doing; marching the whole army off the edge of the field after them is not.
 */
const PURSUIT_MAX = 330;
/** Beyond this distance there is nothing left within reach and the pursuit is over. */
const PURSUIT_GIVE_UP = 250;

// ---------------------------------------------------------------------------
// Plan state
// ---------------------------------------------------------------------------

/**
 * How an army fights. Two named doctrines and a default for anyone else.
 *
 * `roman-attrition` and `germanic-shock` were a closed two-member union chosen by
 * `f === Faction.Rome`, which silently made every other faction Germanic. Carthage fights
 * like neither — a professional army built round a heavy centre and a decisive cavalry
 * wing — but giving it a doctrine of its own is a tuning job for whoever owns that roster,
 * so it takes the attritional plan, which is the one that does not throw everything at the
 * first shock, and the choice is now written down in one place instead of inferred.
 */
export type Doctrine = 'roman-attrition' | 'germanic-shock';

export function doctrineFor(f: Faction): Doctrine {
  return f === Faction.Germanic ? 'germanic-shock' : 'roman-attrition';
}

/**
 * Which way a faction faces before it has seen anybody, in radians.
 *
 * Only the opening frame depends on this — `replan` overwrites it from the enemy's actual
 * bearing as soon as perception runs — so it needs to be sane rather than correct. Rome
 * holds the city and faces out; everyone else is arriving and faces in.
 */
export function openingFacing(f: Faction): number {
  return f === Faction.Rome ? Math.PI : 0;
}

export interface FactionPlan {
  faction: Faction;
  doctrine: Doctrine;
  phase: BattlePhase;
  phaseSince: number;

  /** Where the battle line should stand, in world space. */
  lineX: number;
  lineZ: number;
  lineFacing: number;
  /** Half the total frontage of the line as laid out, metres. */
  lineHalf: number;

  /** Deployment line, captured on the first plan. */
  deployX: number;
  deployZ: number;
  deployFacing: number;
  /** Metres forward of the deployment line that Rome has chosen to fight on. */
  holdAdvance: number;
  /** The advance the last plan settled on, so a stalled pursuit can freeze in place. */
  lastAdvance: number;

  /** Target of main effort — the point we are massing against. */
  effortX: number;
  effortZ: number;
  effortEnemyId: number;

  /** Which of our flanks we are trying to turn: -1, 0 or +1. */
  flankSide: number;
  /** Which of our flanks is being turned, if any. */
  threatenedSide: number;

  reserveCommitted: boolean;
  reserveTargetX: number;
  reserveTargetZ: number;
  /** An enemy unit is loose behind our line right now. Transient, unlike the above. */
  rearThreat: boolean;
  rearThreatX: number;
  rearThreatZ: number;

  nextPlanTick: number;
  /** Ticks a flank threat has persisted; gates the response by reaction time. */
  flankAlarm: number;
  /** Ticks a friendly unit has been in trouble; gates reserve commitment. */
  distressAlarm: number;
  /** Ticks our screen has been inside throwing range of the enemy. */
  screenAlarm: number;
  /** One-line explanation of the current decision, for the F3 overlay. */
  note: string;
}

interface Assignment {
  unitId: number;
  role: AIRole;
  /** Where the unit deployed, in world space. */
  homeX: number;
  homeZ: number;
  /**
   * Its deployed position measured along the line's own lateral axis. This, not world
   * X, is the sort key for laying out the line — sorting by X mirrors the order for an
   * army facing -Z and sends the left-hand cohort to the right-hand station.
   */
  homeLateral: number;
}

// ---------------------------------------------------------------------------
// Scratch
// ---------------------------------------------------------------------------

const LINE_ORDER: Assignment[] = [];
const STAND = { x: 0, z: 0 };
const CLUSTER_POOL: PerceivedEnemy[] = [];
const CLUSTER_OF: number[] = [];
const CLUSTER_MASS: number[] = [];
const CLUSTER_X: number[] = [];
const CLUSTER_Z: number[] = [];

/**
 * Metres between two enemy units before they stop being one body.
 *
 * A deployed line stands on 46-64 m centres and its wing units sit up to 90 m beyond the
 * end of it, so anything below about a hundred metres would split a healthy line into
 * pieces and send the army at one cohort of it. Above about a hundred and fifty it welds
 * two wings back together and reintroduces the defect this exists to fix. 120 sits in the
 * middle of that window with room either side.
 */
const CLUSTER_LINK = 120;

/**
 * Strength-weighted centroid of the heaviest connected group.
 *
 * Single linkage by flood fill over an n^2 adjacency test. n is the number of enemy units
 * in view — twenty at most, and this runs once per `planInterval` (1.4 s at `hard`) per
 * army, so the quadratic is 400 distance tests a second across the whole game.
 */
function heaviestCluster(pool: readonly PerceivedEnemy[]): { x: number; z: number } {
  const n = pool.length;
  CLUSTER_OF.length = 0;
  for (let i = 0; i < n; i++) CLUSTER_OF.push(-1);
  CLUSTER_MASS.length = 0;
  CLUSTER_X.length = 0;
  CLUSTER_Z.length = 0;

  const link2 = CLUSTER_LINK * CLUSTER_LINK;
  const stack: number[] = [];
  for (let seed = 0; seed < n; seed++) {
    if (CLUSTER_OF[seed] !== -1) continue;
    const c = CLUSTER_MASS.length;
    CLUSTER_MASS.push(0);
    CLUSTER_X.push(0);
    CLUSTER_Z.push(0);
    CLUSTER_OF[seed] = c;
    stack.length = 0;
    stack.push(seed);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      const m = pool[i];
      CLUSTER_MASS[c] += m.alive;
      CLUSTER_X[c] += m.x * m.alive;
      CLUSTER_Z[c] += m.z * m.alive;
      for (let j = 0; j < n; j++) {
        if (CLUSTER_OF[j] !== -1) continue;
        const dx = pool[j].x - m.x;
        const dz = pool[j].z - m.z;
        if (dx * dx + dz * dz > link2) continue;
        CLUSTER_OF[j] = c;
        stack.push(j);
      }
    }
  }

  let best = 0;
  for (let c = 1; c < CLUSTER_MASS.length; c++) {
    if (CLUSTER_MASS[c] > CLUSTER_MASS[best]) best = c;
  }
  const w = Math.max(1, CLUSTER_MASS[best]);
  return { x: CLUSTER_X[best] / w, z: CLUSTER_Z[best] / w };
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export class GeneralAISystem implements Subsystem {
  readonly name = 'general-ai';
  readonly order = 45;

  readonly world: AIWorld;
  private battle!: BattleSystem;
  private nav!: PathfindingSystem;
  private rng!: Rng;
  private tick = 0;
  private plans = new Map<Faction, FactionPlan>();
  private assignments = new Map<number, Assignment>();
  /** Factions this AI commands. Anything not listed is left to the player. */
  readonly commanded: Faction[];
  difficulty: Difficulty;

  constructor(world: AIWorld, difficulty: Difficulty = 'hard', commanded: Faction[] = [...ALL_FACTIONS]) {
    this.world = world;
    this.difficulty = difficulty;
    this.commanded = commanded;
  }

  init(ctx: EngineContext): void {
    this.battle = ctx.get<BattleSystem>('battle');
    this.nav = ctx.get<PathfindingSystem>('pathfinding');
    this.rng = this.battle.rng.fork('ai-general');
    if (!this.world.battle) this.world.attach(this.battle, this.nav);

    for (const f of this.commanded) this.plans.set(f, this.newPlan(f));
    // Plan once at init so the tactical layer has orders on the very first tick
    // instead of standing about for one frame.
    this.world.refresh(0, 0);
    for (const f of this.commanded) this.replan(this.plans.get(f)!);
  }

  get profile(): DifficultyProfile {
    return DIFFICULTY[this.difficulty];
  }

  planOf(faction: Faction): FactionPlan | undefined {
    return this.plans.get(faction);
  }

  private newPlan(f: Faction): FactionPlan {
    return {
      faction: f,
      doctrine: doctrineFor(f),
      phase: 'deploy',
      phaseSince: 0,
      lineX: 0, lineZ: 0, lineFacing: openingFacing(f), lineHalf: 0,
      deployX: NaN, deployZ: NaN, deployFacing: openingFacing(f),
      holdAdvance: NaN, lastAdvance: 0,
      effortX: 0, effortZ: 0, effortEnemyId: -1,
      flankSide: 0, threatenedSide: 0,
      reserveCommitted: false, reserveTargetX: 0, reserveTargetZ: 0,
      rearThreat: false, rearThreatX: 0, rearThreatZ: 0,
      nextPlanTick: 0, flankAlarm: 0, distressAlarm: 0, screenAlarm: 0,
      note: 'forming up',
    };
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  fixedUpdate(dt: number, ctx: EngineContext): void {
    const t0 = profileBegin();
    this.tick++;
    this.world.refresh(this.tick, ctx.time.simTime);

    for (const f of this.commanded) {
      const plan = this.plans.get(f);
      if (!plan) continue;
      // Alarms tick every frame — reaction time is a real delay, not a lucky poll.
      this.updateAlarms(plan);
      // Phase transitions are checked every tick because they are cheap and because
      // being a second late into "engagement" means a second of not fighting back.
      this.updatePhase(plan);
      if (this.tick >= plan.nextPlanTick) this.replan(plan);
    }

    void dt;
    profileEnd('general', t0);
  }

  // -------------------------------------------------------------------------
  // Situation awareness
  // -------------------------------------------------------------------------

  private updateAlarms(plan: FactionPlan): void {
    const w = this.world;
    const v = w.view(plan.faction);

    // Are we being flanked? Take the worst flank threat among the units that would
    // feel it first: the ends of the line, the archers and the artillery.
    let worst = 0;
    let side = 0;
    for (const u of v.fighting) {
      const rec = w.infoOf(u.id);
      if (!rec) continue;
      const exposed =
        rec.leftNeighbour < 0 || rec.rightNeighbour < 0 || isMissileClass(rec.def.unitClass);
      if (!exposed) continue;
      if (rec.flankThreat > worst) {
        worst = rec.flankThreat;
        // Which of our flanks: measured along the line's right-hand axis.
        const rx = Math.cos(plan.lineFacing);
        const rz = -Math.sin(plan.lineFacing);
        side = (u.x - plan.lineX) * rx + (u.z - plan.lineZ) * rz >= 0 ? 1 : -1;
      }
    }
    if (worst > 0.16) {
      plan.flankAlarm++;
      plan.threatenedSide = side;
    } else {
      plan.flankAlarm = Math.max(0, plan.flankAlarm - 2);
      if (plan.flankAlarm === 0) plan.threatenedSide = 0;
    }

    // Is any part of the line in trouble? Strength or morale collapsing counts.
    let distress = false;
    for (const u of v.fighting) {
      const rec = w.infoOf(u.id);
      if (!rec || !isLineUnit(rec.def.unitClass)) continue;
      const strength = u.alive / Math.max(1, u.initialStrength);
      const morale = u.morale / Math.max(1, u.maxMorale);
      if ((strength < 0.55 || morale < 0.45) && rec.inContact) distress = true;
    }
    if (distress) plan.distressAlarm++;
    else plan.distressAlarm = Math.max(0, plan.distressAlarm - 2);

    // Has the screen reached the enemy? Ammunition is the primary signal that it has
    // done its job, but a screen standing inside throwing range for a few seconds has
    // manifestly arrived whether or not the projectile subsystem is running.
    let screenClose = false;
    for (const u of v.fighting) {
      const a = this.assignments.get(u.id);
      if (!a || a.role !== 'screen') continue;
      const rec = w.infoOf(u.id);
      if (!rec) continue;
      const reach = (rec.def.missile?.range ?? 30) + 18;
      if (rec.nearestEnemyDist < reach) screenClose = true;
    }
    if (screenClose) plan.screenAlarm++;
    else plan.screenAlarm = Math.max(0, plan.screenAlarm - 1);
  }

  /** Ticks a signal must persist before this general acts on it. */
  private reactionTicks(): number {
    return Math.round(this.profile.reactionTime * 30);
  }

  // -------------------------------------------------------------------------
  // Phases — every transition is a condition on the battle, never a timer alone
  // -------------------------------------------------------------------------

  private updatePhase(plan: FactionPlan): void {
    const w = this.world;
    const v = w.view(plan.faction);
    const elapsed = (this.tick - plan.phaseSince) / 30;
    // Distance measured from the troops, not from the plan: the moment the plan says
    // "stand where they are standing" the planned gap is zero while the men are still
    // three hundred metres away.
    const gap = v.closestEnemy;

    // Losing the army overrides everything else.
    const powerLeft = v.initialPower > 0 ? v.power / v.initialPower : 1;
    if (plan.phase !== 'withdraw' && powerLeft < WITHDRAW_POWER && v.routing >= 2) {
      this.enterPhase(plan, 'withdraw', 'army spent — falling back');
      return;
    }

    switch (plan.phase) {
      case 'deploy': {
        // Formed up means every line unit is standing on its station.
        let formed = true;
        for (const u of v.fighting) {
          const a = this.assignments.get(u.id);
          if (!a || a.role !== 'line') continue;
          const cmd = w.commandOf(u.id);
          if (!cmd) continue;
          if (Math.sqrt((cmd.stationX - u.x) * (cmd.stationX - u.x) + (cmd.stationZ - u.z) * (cmd.stationZ - u.z)) > this.profile.lineTolerance * 2.5) {
            formed = false;
            break;
          }
        }
        // The timeout is a backstop, not the trigger.
        if (formed || elapsed > 8) this.enterPhase(plan, 'skirmish', 'screen forward');
        break;
      }

      case 'skirmish': {
        // Three ways the screening phase ends, all of them conditions on the battle:
        //   1. the screen has thrown most of its javelins;
        //   2. the screen has been inside throwing range long enough to have done so
        //      (the same fact, observable without an ammunition counter);
        //   3. the screen is standing on its forward station with nothing in range —
        //      it cannot contribute anything more from where it is, so the army has to
        //      move up and bring it into range.
        let screenSpent = true;
        let screenIdle = false;
        let hasScreen = false;
        for (const u of v.fighting) {
          const a = this.assignments.get(u.id);
          if (!a || a.role !== 'screen') continue;
          hasScreen = true;
          const def = this.battle.typeOf(u);
          const startAmmo = def.missile?.ammo ?? 1;
          if (u.ammo > startAmmo * 0.55) screenSpent = false;
          const cmd = w.commandOf(u.id);
          const rec = w.infoOf(u.id);
          if (cmd && rec) {
            const onStation = Math.sqrt((cmd.stationX - u.x) * (cmd.stationX - u.x) + (cmd.stationZ - u.z) * (cmd.stationZ - u.z)) < 22;
            const reach = (rec.def.missile?.range ?? 30) * 1.2;
            if (onStation && rec.nearestEnemyDist > reach) screenIdle = true;
          }
        }
        if (!hasScreen) screenSpent = elapsed > 4;
        if (plan.screenAlarm > 90) screenSpent = true;
        if (screenSpent || screenIdle || gap < 220 || elapsed > 30) {
          this.enterPhase(plan, 'advance', 'general advance');
        }
        break;
      }

      case 'advance': {
        // Contact, or close enough that the next thing to happen is contact.
        if (v.contactCount > 0 || gap < 24) this.enterPhase(plan, 'engagement', 'lines joined');
        break;
      }

      case 'engagement': {
        // A hole in the enemy line, or crushing local superiority, means exploit.
        // Everything here is read from perception: units we have identified minus units
        // still standing in their line is the number that has broken or been destroyed.
        const enemyBroken = Math.max(0, v.seenKnown - v.seenFighting);
        const ratio = v.seenPower > 0.001 ? v.power / v.seenPower : 4;
        const nerve = this.profile.reserveNerve;
        // A twenty per cent edge is not a breakthrough. Exploitation is committing the
        // last of the army in one direction, so the bar is deliberately high, and the
        // fight has to have been going on long enough for the edge to mean anything.
        const overwhelming = ratio > 2.0 - nerve * 0.35 && elapsed > 18;
        if (enemyBroken >= 1 || overwhelming) {
          this.enterPhase(plan, 'exploit', enemyBroken >= 1 ? 'hole in their line' : 'we have the weight');
        }
        break;
      }

      case 'exploit': {
        const collapsed =
          v.seenKnown > 0 && v.seenFighting <= Math.max(1, Math.floor(v.seenKnown * 0.3));
        if (collapsed) this.enterPhase(plan, 'pursuit', 'they are breaking — run them down');
        // If the exploitation stalls and we are being ground down, drop back to a
        // straight fight rather than feeding units into a hole that closed.
        else if (v.seenPower > v.power * 1.1) this.enterPhase(plan, 'engagement', 'exploitation stalled');
        break;
      }

      case 'pursuit':
        break;

      case 'withdraw':
        // An army that rallies stops running. Morale recovers, routing units re-form,
        // and a general who keeps retreating after that has thrown the battle away.
        if (powerLeft > RALLY_POWER && v.routing < 2) {
          this.enterPhase(plan, 'engagement', 'rallied — back into the line');
        }
        break;
    }
  }

  private enterPhase(plan: FactionPlan, phase: BattlePhase, note: string): void {
    if (plan.phase === phase) return;
    plan.phase = phase;
    plan.phaseSince = this.tick;
    plan.note = note;
    // A phase change is a new plan, immediately.
    plan.nextPlanTick = this.tick;
  }

  private destroyedCount(f: Faction): number {
    let n = 0;
    for (const u of this.battle.units) if (u.faction === f && u.destroyed) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  private replan(plan: FactionPlan): void {
    plan.nextPlanTick = this.tick + Math.max(1, Math.round(this.profile.planInterval * 30));
    const w = this.world;
    const v = w.view(plan.faction);
    if (v.fighting.length === 0) return;

    // The deployment frame has to exist before roles and stations can be measured
    // against it, so it is captured on the very first plan and never moves again.
    if (Number.isNaN(plan.deployZ)) {
      plan.deployX = v.lineX;
      plan.deployZ = v.lineZ;
      plan.lineFacing = v.lineFacing;
      plan.deployFacing = v.lineFacing;
      plan.lineX = v.lineX;
      plan.lineZ = v.lineZ;
    }
    this.refreshAssignments(plan);
    this.chooseMainEffort(plan);
    this.chooseLinePosition(plan);
    this.chooseFlank(plan);
    this.commitReserve(plan);
    this.issueCommands(plan);
  }

  /** Roles are assigned once, from unit class and doctrine, and then kept. */
  private refreshAssignments(plan: FactionPlan): void {
    // Rome keeps one heavy cohort out of the line entirely. Whichever of its heavy
    // infantry has the steadiest morale is the one worth holding back: that is the
    // Praetorians without ever naming them.
    let reserveId = -1;
    if (plan.doctrine === 'roman-attrition') {
      let bestDiscipline = -1;
      let heavies = 0;
      for (const u of this.battle.units) {
        if (u.faction !== plan.faction || u.destroyed) continue;
        const def = this.battle.typeOf(u);
        if (def.unitClass !== 'heavy-infantry') continue;
        heavies++;
        if (def.discipline > bestDiscipline) {
          bestDiscipline = def.discipline;
          reserveId = u.id;
        }
      }
      if (heavies < 3) reserveId = -1; // too few cohorts to hold one back
    }

    for (const u of this.battle.units) {
      if (u.faction !== plan.faction || u.destroyed) continue;
      let a = this.assignments.get(u.id);
      if (!a) {
        const rx = Math.cos(plan.deployFacing);
        const rz = -Math.sin(plan.deployFacing);
        a = {
          unitId: u.id, role: 'line', homeX: u.x, homeZ: u.z,
          homeLateral: (u.x - plan.deployX) * rx + (u.z - plan.deployZ) * rz,
        };
        this.assignments.set(u.id, a);
        a.role = this.roleFor(u, plan, reserveId);
      }
    }
  }

  private roleFor(u: UnitGroupState, plan: FactionPlan, reserveId: number): AIRole {
    const def = this.battle.typeOf(u);
    const c = def.unitClass;
    if (c === 'artillery') return 'artillery';
    if (isCavalryClass(c)) return 'flank';
    if (c === 'missile-infantry') {
      // A unit built to run in, throw and run out is a screen. A unit with a 165 m bow
      // is a firing line and belongs behind the infantry.
      return def.abilities.includes('skirmish-mode') ? 'screen' : 'missile';
    }
    if (u.id === reserveId) return 'reserve';
    if (c === 'shock-infantry') return plan.doctrine === 'germanic-shock' ? 'shock' : 'line';
    if (c === 'spear-infantry' && plan.doctrine === 'roman-attrition') return 'anchor';
    return 'line';
  }

  /**
   * Concentration of force. Two candidate aim points: the weakest unit in the enemy
   * line, and the widest seam between two of their units. Which we can see is limited
   * by perception; how well we identify it is limited by difficulty — a poor general
   * simply aims at the middle.
   */
  private chooseMainEffort(plan: FactionPlan): void {
    const w = this.world;
    const v = w.view(plan.faction);
    const enemy = this.enemyLine(plan);
    const conc = this.profile.concentration;

    let aimX = enemy.x;
    let aimZ = enemy.z;
    let aimId = -1;

    // A seam wide enough to march into beats a merely weak unit: getting behind the
    // line is worth more than grinding through the softest part of it.
    if (v.seamWidth > 26) {
      aimX = v.seamX;
      aimZ = v.seamZ;
    } else if (v.weakestEnemyId >= 0) {
      const mem = w.perceived(plan.faction, v.weakestEnemyId);
      if (mem) {
        aimX = mem.x;
        aimZ = mem.z;
        aimId = mem.unitId;
      }
    }

    // Blend toward the enemy centre by however much this general fails to concentrate.
    const wantX = enemy.x + (aimX - enemy.x) * conc;
    const wantZ = enemy.z + (aimZ - enemy.z) * conc;
    // Low-pass the aim point. The widest seam changes every time a unit shuffles, and
    // an army that re-aims every second never masses anywhere.
    if (plan.phase === 'deploy') {
      plan.effortX = wantX;
      plan.effortZ = wantZ;
    } else {
      plan.effortX += (wantX - plan.effortX) * 0.3;
      plan.effortZ += (wantZ - plan.effortZ) * 0.3;
    }
    plan.effortEnemyId = conc > 0.4 ? aimId : -1;
  }

  /**
   * Where the line should stand. Rome advances a measured distance to chosen ground and
   * then holds; the Juthungi advance until they are on top of the enemy.
   */
  private chooseLinePosition(plan: FactionPlan): void {
    const w = this.world;
    const v = w.view(plan.faction);
    const enemy = this.enemyLine(plan);
    const fwdX = Math.sin(plan.lineFacing);
    const fwdZ = Math.cos(plan.lineFacing);

    // Mass laterally against the point of main effort. A quarter of the offset is
    // enough to be visible without unhinging the line from its flanks.
    const rx = Math.cos(plan.lineFacing);
    const rz = -Math.sin(plan.lineFacing);
    const effortLateral = (plan.effortX - plan.deployX) * rx + (plan.effortZ - plan.deployZ) * rz;
    const shift = effortLateral * 0.25 * this.profile.concentration;

    const separation = enemy.seen
      ? Math.max(0, (enemy.x - plan.deployX) * fwdX + (enemy.z - plan.deployZ) * fwdZ)
      : 0;

    let advance = 0;
    switch (plan.phase) {
      case 'deploy':
        advance = 0;
        break;
      case 'skirmish':
        // Edge forward while the screen works, so the advance does not start from cold.
        advance = 18;
        break;
      case 'advance':
      case 'engagement':
      case 'exploit':
      case 'pursuit': {
        if (plan.doctrine === 'germanic-shock') {
          // Straight at them: stand where they are standing.
          advance = separation - 4;
        } else {
          // Rome picks its ground *once*, when the advance begins, and then holds it.
          // Recomputing every plan makes the objective drift backwards as the enemy
          // closes, and a line that keeps re-deciding where to stand never stands.
          if (Number.isNaN(plan.holdAdvance)) {
            plan.holdAdvance = Math.min(ROMAN_CLOSE_MAX, separation * ROMAN_CLOSE_FRACTION);
          }
          advance = plan.holdAdvance;
        }
        if (plan.phase === 'pursuit') {
          // Chase, but not off the map. Once nothing is within reach the pursuit is
          // finished and the army re-forms on the ground it holds.
          advance = Math.min(separation - 4, PURSUIT_MAX);
          if (v.closestEnemy > PURSUIT_GIVE_UP) advance = plan.lastAdvance;
        }
        break;
      }
      case 'withdraw':
        // Back toward our own edge of the field, in order.
        advance = -90;
        break;
    }

    plan.lastAdvance = advance;
    plan.lineX = plan.deployX + fwdX * advance + rx * shift;
    plan.lineZ = plan.deployZ + fwdZ * advance + rz * shift;
    // Never advance past the enemy: that is how a line ends up fighting backwards.
    if (enemy.seen) {
      const past = (plan.lineX - enemy.x) * fwdX + (plan.lineZ - enemy.z) * fwdZ;
      if (past > 0) {
        plan.lineX -= fwdX * past;
        plan.lineZ -= fwdZ * past;
      }
    }

    // Face the enemy, but only take a bearing while they are still at a distance. Once
    // the lines are close the centroid bearing swings wildly with every casualty, and a
    // line that chases it spends the battle wheeling instead of fighting.
    if (enemy.seen) {
      const d = Math.sqrt((enemy.x - plan.lineX) * (enemy.x - plan.lineX) + (enemy.z - plan.lineZ) * (enemy.z - plan.lineZ));
      if (d > 110) {
        const want = Math.atan2(enemy.x - plan.lineX, enemy.z - plan.lineZ);
        let f = plan.lineFacing + angleDelta(plan.lineFacing, want) * 0.35;
        /*
         * And never turn more than 50 degrees off the ground we deployed on — while there
         * is still a line to hold.
         *
         * The whole position is `deploy + forward * advance`, so the bearing is also the
         * only thing that decides *where the army can go*: a remnant more than 50 degrees
         * off the deployment axis is unreachable, and the line saturates at the cap and
         * stops. That is a correct rule for a battle line, which must not wheel away from
         * its own flanks, and the wrong one for the mopping up: by the time the enemy has
         * come apart into fragments on both wings there are no flanks left to keep.
         */
        const cap = plan.phase === 'exploit' || plan.phase === 'pursuit' ? Math.PI : 0.87;
        const off = angleDelta(plan.deployFacing, f);
        if (Math.abs(off) > cap) f = plan.deployFacing + Math.sign(off) * cap;
        plan.lineFacing = wrapAngle(f);
      }
    }
    void v;
  }

  /** Decide whether, and on which side, to try to turn a flank. */
  private chooseFlank(plan: FactionPlan): void {
    if (!this.profile.flanking) {
      plan.flankSide = 0;
      return;
    }
    // Defend first: if a flank of ours is being turned, the horse goes there instead.
    if (plan.flankAlarm > this.reactionTicks()) {
      plan.flankSide = plan.threatenedSide;
      plan.note = plan.threatenedSide > 0 ? 'right flank threatened' : 'left flank threatened';
      return;
    }
    // The Juthungi ride wide from the start; Rome waits for the decisive moment.
    const ready =
      plan.doctrine === 'germanic-shock'
        ? plan.phase === 'advance' || plan.phase === 'engagement' || plan.phase === 'exploit' || plan.phase === 'pursuit'
        : plan.phase === 'engagement' || plan.phase === 'exploit' || plan.phase === 'pursuit';
    if (!ready) {
      plan.flankSide = 0;
      return;
    }
    // Go round the shorter way: whichever end of the enemy line is nearer our horse.
    const w = this.world;
    const v = w.view(plan.faction);
    let side = 0;
    let bestLateral = 0;
    let bestD = Infinity;
    for (const u of v.fighting) {
      const rec = w.infoOf(u.id);
      if (!rec || !isCavalryClass(rec.def.unitClass)) continue;
      const rx = Math.cos(plan.lineFacing);
      const rz = -Math.sin(plan.lineFacing);
      const lateral = (u.x - plan.lineX) * rx + (u.z - plan.lineZ) * rz;
      // Go round the end our horse is already nearest to; the far flank costs a minute
      // of riding that the infantry does not have.
      const d = Math.abs(Math.abs(lateral) - plan.lineHalf);
      if (d < bestD) {
        bestD = d;
        bestLateral = lateral;
      }
    }
    // A dead heat between two wings is broken from the seeded stream, not Math.random.
    side = Math.abs(bestLateral) < 1 ? (this.rng.bool() ? 1 : -1) : bestLateral >= 0 ? 1 : -1;
    plan.flankSide = side;
  }

  /**
   * Reserve management. A reserve is only worth having if it is spent at the right
   * moment: into a hole that has opened, or into a sector that is about to give way.
   */
  private commitReserve(plan: FactionPlan): void {
    const w = this.world;
    const v = w.view(plan.faction);
    const react = this.reactionTicks();

    // ---- Something loose in our rear ----
    // Cavalry among the archers and the artillery will end the battle on its own if
    // nothing is sent to deal with it, and unlike a buckling front this needs no
    // casualties to be worth reacting to. It is also *transient*: once the incursion is
    // gone the reserve is a reserve again, so this does not spend the commitment.
    plan.rearThreat = false;
    if (plan.phase !== 'deploy' && plan.phase !== 'skirmish') {
      const fwdX = Math.sin(plan.lineFacing);
      const fwdZ = Math.cos(plan.lineFacing);
      for (const mem of v.seen.values()) {
        if (mem.routing || mem.alive <= 0) continue;
        // Behind our own line, measured along the front-to-back axis.
        const behindBy = -((mem.x - plan.lineX) * fwdX + (mem.z - plan.lineZ) * fwdZ);
        if (behindBy < 25) continue;
        let nearSoft = false;
        for (const u of v.fighting) {
          const rec = w.infoOf(u.id);
          if (!rec || !isMissileClass(rec.def.unitClass)) continue;
          if (Math.sqrt((u.x - mem.x) * (u.x - mem.x) + (u.z - mem.z) * (u.z - mem.z)) < 90) nearSoft = true;
        }
        if (!nearSoft) continue;
        plan.rearThreat = true;
        plan.rearThreatX = mem.x;
        plan.rearThreatZ = mem.z;
        plan.note = 'reserve to clear our rear';
        break;
      }
    }

    if (plan.reserveCommitted) return;

    // Exploitation: an enemy line unit has broken, so there is a gap to drive into.
    if (plan.phase === 'exploit' || plan.phase === 'pursuit') {
      let holeX = plan.effortX;
      let holeZ = plan.effortZ;
      for (const mem of v.seen.values()) {
        if (mem.routing) {
          holeX = mem.x;
          holeZ = mem.z;
          break;
        }
      }
      plan.reserveCommitted = true;
      plan.reserveTargetX = holeX;
      plan.reserveTargetZ = holeZ;
      plan.note = 'reserve into the gap';
      return;
    }

    // Rescue: some part of our line is breaking and needs weight behind it.
    if (plan.distressAlarm > react && (plan.phase === 'engagement' || plan.phase === 'advance')) {
      let worstId = -1;
      let worst = Infinity;
      for (const u of v.fighting) {
        const rec = w.infoOf(u.id);
        if (!rec || !isLineUnit(rec.def.unitClass) || !rec.inContact) continue;
        const health = (u.alive / Math.max(1, u.initialStrength)) * (u.morale / Math.max(1, u.maxMorale));
        if (health < worst) {
          worst = health;
          worstId = u.id;
        }
      }
      if (worstId >= 0) {
        const u = this.battle.unitById(worstId)!;
        // A timid general keeps the reserve back and loses the line with it.
        if (this.profile.reserveNerve > 0.5 || v.power < v.seenPower) {
          plan.reserveCommitted = true;
          plan.reserveTargetX = u.x;
          plan.reserveTargetZ = u.z;
          plan.note = 'reserve to the buckling sector';
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Turning the plan into per-unit commands
  // -------------------------------------------------------------------------

  private issueCommands(plan: FactionPlan): void {
    const w = this.world;
    const v = w.view(plan.faction);
    const rx = Math.cos(plan.lineFacing);
    const rz = -Math.sin(plan.lineFacing);
    const fx = Math.sin(plan.lineFacing);
    const fz = Math.cos(plan.lineFacing);

    // ---- Lay the line out, in the order the units deployed ----
    LINE_ORDER.length = 0;
    for (const u of v.fighting) {
      const a = this.assignments.get(u.id);
      if (!a) continue;
      if (a.role === 'line' || a.role === 'shock') LINE_ORDER.push(a);
    }
    LINE_ORDER.sort((p, q) => p.homeLateral - q.homeLateral);

    let total = 0;
    for (const a of LINE_ORDER) {
      const rec = w.infoOf(a.unitId);
      if (!rec) continue;
      total += rec.halfFront * 2 + LINE_INTERVAL;
    }
    total -= LINE_INTERVAL;
    const packedHalf = Math.max(20, total * 0.5);

    // An army does not shuffle sideways on the spot to dress its line — it closes up as
    // it advances. Compression ramps with the phase so the lateral movement is folded
    // into the forward march, where it looks (and is) deliberate.
    const compression =
      plan.phase === 'deploy' ? 0 : plan.phase === 'skirmish' ? 0.4 : 1;
    let deployedHalf = 20;
    for (const a of LINE_ORDER) {
      const rec = w.infoOf(a.unitId);
      if (rec) deployedHalf = Math.max(deployedHalf, Math.abs(a.homeLateral) + rec.halfFront);
    }
    plan.lineHalf = deployedHalf + (packedHalf - deployedHalf) * compression;

    // The shock wedge does not stand in the line: it forms up behind it, aimed at the
    // point of main effort, and goes through when the phase says so.
    let cursor = -packedHalf;
    const aggression = this.aggressionFor(plan);
    const pace = this.paceFor(plan);

    for (const a of LINE_ORDER) {
      const rec = w.infoOf(a.unitId);
      if (!rec) continue;
      const halfFront = rec.halfFront;
      const packedLateral = cursor + halfFront;
      cursor += halfFront * 2 + LINE_INTERVAL;
      const lateral = a.homeLateral + (packedLateral - a.homeLateral) * compression;

      if (a.role === 'shock') {
        // Line up the wedge on the main effort, one bound behind the line.
        const effortLateral = (plan.effortX - plan.lineX) * rx + (plan.effortZ - plan.lineZ) * rz;
        const behind = plan.phase === 'deploy' || plan.phase === 'skirmish' ? -46 : -22;
        this.setCommand(
          a, plan,
          plan.lineX + rx * effortLateral + fx * behind,
          plan.lineZ + rz * effortLateral + fz * behind,
          plan.lineFacing,
          plan.effortEnemyId,
          Math.min(1, aggression + 0.25),
          'run',
          plan.phase === 'pursuit'
        );
        continue;
      }

      this.setCommand(
        a, plan,
        plan.lineX + rx * lateral,
        plan.lineZ + rz * lateral,
        plan.lineFacing,
        // Units near the main effort are told to focus on it; the rest use judgement.
        Math.abs(lateral - ((plan.effortX - plan.lineX) * rx + (plan.effortZ - plan.lineZ) * rz)) < 60
          ? plan.effortEnemyId
          : -1,
        aggression,
        pace,
        plan.phase === 'pursuit'
      );
    }

    // ---- Everything that is not in the line ----
    // Anchors are placed by where they deployed, not by iteration order, so the left
    // one stays on the left for the whole battle.
    let anchorMedian = 0;
    let anchorCount = 0;
    let anchorSum = 0;
    for (const u of v.fighting) {
      const a = this.assignments.get(u.id);
      if (a?.role === 'anchor') {
        anchorSum += a.homeLateral;
        anchorCount++;
      }
    }
    if (anchorCount > 0) anchorMedian = anchorSum / anchorCount;

    let missileSlot = 0;
    for (const u of v.fighting) {
      const a = this.assignments.get(u.id);
      if (!a) continue;
      const rec = w.infoOf(u.id);
      if (!rec) continue;

      switch (a.role) {
        case 'anchor': {
          // One at each end, turned outward: this is what "refuse the flank" means.
          const side = a.homeLateral >= anchorMedian ? 1 : -1;
          const lateral = side * (plan.lineHalf + rec.halfFront + 6);
          this.setCommand(
            a, plan,
            plan.lineX + rx * lateral - fx * ANCHOR_SETBACK,
            plan.lineZ + rz * lateral - fz * ANCHOR_SETBACK,
            plan.lineFacing + ANCHOR_SPLAY * side * -1,
            -1,
            Math.min(aggression, 0.25), // anchors hold; they do not attack
            'walk',
            false
          );
          break;
        }
        case 'missile': {
          const spread = plan.lineHalf * 0.6;
          const lateral = missileSlot === 0 ? -spread : spread;
          missileSlot++;
          this.setCommand(
            a, plan,
            plan.lineX + rx * lateral - fx * MISSILE_SETBACK,
            plan.lineZ + rz * lateral - fz * MISSILE_SETBACK,
            plan.lineFacing, -1, 0.1, 'run', false
          );
          break;
        }
        case 'artillery':
          // Bolt-throwers are emplaced. They stay where they were sited and shoot over
          // everyone's heads; dragging a scorpio across a battlefield is not a plan.
          this.setCommand(a, plan, a.homeX, a.homeZ, plan.lineFacing, -1, 0, 'walk', false);
          break;
        case 'screen': {
          // Well forward while screening — a javelin has to get inside 34 m to matter —
          // leading the advance once it starts, and behind the line once the ammunition
          // is gone and there is nothing left to contribute.
          const forward =
            plan.phase === 'deploy' ? 40
            : plan.phase === 'skirmish' ? 105
            : plan.phase === 'advance' ? 45
            : -MISSILE_SETBACK;
          const lateral = a.homeLateral * 0.8;
          this.setCommand(
            a, plan,
            plan.lineX + rx * lateral + fx * forward,
            plan.lineZ + rz * lateral + fz * forward,
            plan.lineFacing, -1, 0.3, 'run', false
          );
          break;
        }
        case 'reserve': {
          // Priority order: clear our own rear, then reinforce where we were sent, then
          // stand behind the point of decision doing nothing, which is the job.
          if (plan.rearThreat) {
            this.setCommand(
              a, plan, plan.rearThreatX, plan.rearThreatZ,
              Math.atan2(plan.rearThreatX - u.x, plan.rearThreatZ - u.z),
              -1, 1, 'run', false
            );
            break;
          }
          const effortLateral = (plan.effortX - plan.lineX) * rx + (plan.effortZ - plan.lineZ) * rz;
          const lateral = plan.reserveCommitted
            ? (plan.reserveTargetX - plan.lineX) * rx + (plan.reserveTargetZ - plan.lineZ) * rz
            : effortLateral * 0.5;
          const behind = plan.reserveCommitted ? -8 : -RESERVE_SETBACK;
          this.setCommand(
            a, plan,
            plan.lineX + rx * lateral + fx * behind,
            plan.lineZ + rz * lateral + fz * behind,
            plan.lineFacing,
            plan.reserveCommitted ? plan.effortEnemyId : -1,
            plan.reserveCommitted ? Math.min(1, aggression + 0.35) : 0.0,
            'run',
            false
          );
          break;
        }
        case 'flank': {
          const side = plan.flankSide !== 0 ? plan.flankSide : (a.homeLateral >= 0 ? 1 : -1);
          const committed = this.cavalryCommitted(plan);
          // Outboard of the line, and never closer in than where it deployed. Cavalry
          // was put on the wing for a reason; drawing it in behind the infantry gives up
          // the room it needs to get round anything.
          const lateral =
            side * Math.max(plan.lineHalf + CAVALRY_OUTBOARD, Math.abs(a.homeLateral));
          // Uncommitted horse waits behind its wing, in sight of the flank it will take.
          const behind = committed ? 10 : -CAVALRY_SETBACK;
          this.setCommand(
            a, plan,
            plan.lineX + rx * lateral + fx * behind,
            plan.lineZ + rz * lateral + fz * behind,
            plan.lineFacing,
            -1,
            committed ? 1 : 0.15,
            'run',
            plan.phase === 'exploit' || plan.phase === 'pursuit'
          );
          break;
        }
        default:
          break;
      }
    }
  }

  /** Is the horse released? Rome holds it for the counter-punch; the tribes do not. */
  private cavalryCommitted(plan: FactionPlan): boolean {
    if (plan.phase === 'exploit' || plan.phase === 'pursuit') return true;
    if (plan.flankAlarm > this.reactionTicks()) return true; // answering their horse
    if (plan.doctrine === 'germanic-shock') return plan.phase === 'advance' || plan.phase === 'engagement';
    // Rome commits once the infantry fight is joined and the enemy is fixed in place.
    return plan.phase === 'engagement' && (this.tick - plan.phaseSince) / 30 > 6;
  }

  private aggressionFor(plan: FactionPlan): number {
    switch (plan.phase) {
      case 'deploy':
        return 0;
      case 'skirmish':
        return 0.05;
      case 'advance':
        // The Juthungi come on hard; Rome walks up and stops.
        return plan.doctrine === 'germanic-shock' ? 0.85 : 0.2;
      case 'engagement':
        return plan.doctrine === 'germanic-shock' ? 0.95 : 0.55;
      case 'exploit':
        return 1;
      case 'pursuit':
        return 1;
      case 'withdraw':
        return 0;
    }
  }

  private paceFor(plan: FactionPlan): 'walk' | 'run' {
    if (plan.phase === 'deploy') return 'walk';
    if (plan.phase === 'withdraw') return 'run';
    if (plan.doctrine === 'germanic-shock') return plan.phase === 'skirmish' ? 'walk' : 'run';
    // Rome closes the distance at the double, then halts to dress the line. Standing
    // still under a Germanic charge is the whole plan, so arriving early matters.
    return plan.phase === 'advance' ? 'run' : 'walk';
  }

  private setCommand(
    a: Assignment,
    plan: FactionPlan,
    x: number,
    z: number,
    facing: number,
    targetId: number,
    aggression: number,
    pace: 'walk' | 'run',
    allowPursuit: boolean
  ): void {
    // Never station a unit in the river or on a slope it cannot hold.
    const u = this.battle.unitById(a.unitId);
    let sx = x;
    let sz = z;
    if (u) {
      const fp = footprintOf(u, this.battle.typeOf(u));
      if (this.nav.findStandable(x, z, Math.min(fp.max, 14), STAND)) {
        sx = STAND.x;
        sz = STAND.z;
      }
    }

    let cmd = this.world.commands.get(a.unitId);
    if (!cmd) {
      cmd = {
        unitId: a.unitId, role: a.role,
        stationX: sx, stationZ: sz, stationFacing: facing,
        preferredTargetId: targetId, aggression, pace,
        allowPursuit, held: false, issuedTick: this.tick,
      };
      this.world.commands.set(a.unitId, cmd);
      return;
    }
    cmd.role = a.role;
    cmd.stationX = sx;
    cmd.stationZ = sz;
    cmd.stationFacing = facing;
    cmd.preferredTargetId = targetId;
    cmd.aggression = aggression;
    cmd.pace = pace;
    cmd.allowPursuit = allowPursuit;
    cmd.held = a.role === 'reserve' && !plan.reserveCommitted;
    cmd.issuedTick = this.tick;
  }

  // -------------------------------------------------------------------------
  // Perceived enemy line
  // -------------------------------------------------------------------------

  /**
   * Where we believe the enemy's line is. Built from perception, so an army that has
   * not seen its enemy does not know where it is.
   *
   * **The heaviest body of them, not the mean of all of them, and the difference is a
   * battle that stops.** This was a straight strength-weighted centroid over every enemy
   * unit in view, which is correct while the enemy is a line and catastrophic once it is
   * not. Measured on the shipped field battle with a passive Rome: by t+1000 the Roman
   * remnant was three fragments at (296, 35), (−350, 91) and (−261, 235) — 650 m apart on
   * opposite wings — whose mean is (−81, 119), *empty ground between them*. The Juthungi
   * marched their whole line to that point, arrived, and held: `Engage` reaches
   * `34 + aggression * 90` = 124 m and the nearest Roman was 200 m away, so no unit had
   * anything to attack and nothing else moves an army. **Eighteen units stood still for the
   * next 1,400 seconds** while the scoreboard did not change by one man, until the 2,400 s
   * clock ended it — sixteen and a half real minutes at 1x.
   *
   * Single-linkage at `CLUSTER_LINK`, which is wide enough that a deployed line is one
   * cluster (Rome's cohorts stand on 64 m centres and the urban cohorts 90 m beyond the
   * end of the line) and narrow enough that the late-battle fragments above are three. So
   * this is identical to the mean for as long as the enemy *has* a line, and only differs
   * once there is no single body to average — which is exactly when the mean is a lie.
   */
  private enemyLine(plan: FactionPlan): { x: number; z: number; seen: boolean } {
    const v = this.world.view(plan.faction);
    CLUSTER_POOL.length = 0;
    for (const mem of v.seen.values()) {
      if (mem.alive <= 0 || mem.routing) continue;
      if (!isLineUnit(mem.unitClass)) continue;
      CLUSTER_POOL.push(mem);
    }
    if (CLUSTER_POOL.length === 0) {
      // No line troops in view: fall back on anything at all we have seen. A broken enemy
      // is still worth chasing, so routers are not excluded from this pass.
      for (const mem of v.seen.values()) {
        if (mem.alive <= 0) continue;
        CLUSTER_POOL.push(mem);
      }
    }
    if (CLUSTER_POOL.length === 0) {
      return { x: plan.deployX || 0, z: plan.deployZ || 0, seen: false };
    }
    return { ...heaviestCluster(CLUSTER_POOL), seen: true };
  }

  // -------------------------------------------------------------------------
  // Debug
  // -------------------------------------------------------------------------

  /** One-line summary per faction for the overlay. */
  summary(faction: Faction): string {
    const plan = this.plans.get(faction);
    if (!plan) return 'not commanded';
    const v = this.world.view(faction);
    return (
      `${plan.doctrine} | ${plan.phase} ${((this.tick - plan.phaseSince) / 30).toFixed(0)}s | ` +
      `line z=${plan.lineZ.toFixed(0)} | effort x=${plan.effortX.toFixed(0)} | ` +
      `flank ${plan.flankSide} | reserve ${plan.rearThreat ? 'REAR' : plan.reserveCommitted ? 'IN' : 'held'} | ` +
      `power ${(v.initialPower > 0 ? v.power / v.initialPower : 1).toFixed(2)} | ${plan.note}`
    );
  }

  roleOf(unitId: number): AIRole | '-' {
    return this.assignments.get(unitId)?.role ?? '-';
  }
}
