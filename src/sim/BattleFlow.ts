import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from './BattleSystem';
import { ALL_FACTIONS, Faction, isBroken, UnitOrder, type UnitGroupState } from './types';

/**
 * Battle flow: decides when the engagement is over and who won.
 *
 * Without this the simulation runs forever — an army whose units have all broken keeps
 * "existing" while its men trickle off the map, and nothing ever announces a result.
 *
 * A battle in this period does not end when one side is annihilated; it ends when one
 * side stops being an army. So the win condition is about cohesion, not corpses:
 *   - no unbroken units left, or
 *   - so few effectives left that the force cannot hold a line, or
 *   - so badly beaten by what is still standing opposite that the result is not in doubt.
 * Casualties are the consequence, not the criterion.
 *
 * **A storm is judged on different evidence, because a storm is about ground.** A garrison
 * that has lost half its men and still holds the parapet has not lost, and a besieger with
 * a whole host in reserve who never gets over the wall has not won. So an assault carries a
 * real objective — the wall itself, taken or held — and it is the only thing that can decide
 * one either way inside the clock. See `censusWall`.
 */

/** Fraction of starting strength below which a faction is judged spent. */
const COLLAPSE_STRENGTH = 0.22;
/** Seconds a faction must stay collapsed before the result is called, so a momentary
 *  wobble mid-melee does not end the battle prematurely. */
const CONFIRM_SECONDS = 6;
/**
 * Hard stop, in simulated seconds.
 *
 * Raised from 1200 once break depth was fixed. Units now fight to 33-52% casualties
 * instead of 12-28%, and an evenly-matched AI-vs-AI battle was still genuinely contested
 * at t+500 - so a 20-minute ceiling would have started deciding battles by timeout rather
 * than by anyone breaking, which is the one outcome this system exists to avoid.
 */
const TIMEOUT_SECONDS = 2400;

/**
 * The margin at which a field battle stops being in question.
 *
 * Measured, not guessed. A passive Rome on the Campus Martius is ground from 3,772 down to
 * 1,141 by t+1200 while the Juthungi still have 3,951 in order — a third of the men against
 * three and a half times as many. That battle is over, and `COLLAPSE_STRENGTH` above cannot
 * see it, because 1,141 is thirty per cent of Rome's own establishment and the floor only
 * ever compares a side against itself. Nothing then happened for another twelve hundred
 * seconds and the result was declared by the clock: **sixteen and a half real minutes of a
 * frozen scoreboard.**
 *
 * Both halves are required. The ratio alone would call a storm the moment the garrison was
 * outnumbered, which is the normal state of a garrison; the absolute term alone is the floor
 * that already exists. So: beaten below half of what you brought, *and* holding less than a
 * third of what is still standing opposite you.
 *
 * Deliberately **not applied to a storm** — see `decisiveApplies`.
 */
const DECISIVE_RATIO = 0.33;
const DECISIVE_OWN = 0.5;

/**
 * Seconds with no casualty anywhere on the field before the battle is judged to have stopped.
 *
 * The backstop for the case the margin cannot reach: two armies that have stopped fighting at
 * parity. Not a heuristic about intent — it is the observation that in a battle, men die. Two
 * minutes without a single one, across eight thousand of them, means nothing is happening and
 * nothing is going to. It only counts silence *after* the first casualty, so two armies that
 * have simply not met yet are not a stalemate.
 *
 * A grind cannot trip it: `even-grind` and `legionary-vs-warband`, the two calibration
 * matchups, kill someone every few seconds throughout — and `matchup.mjs` neuters this system
 * anyway.
 */
const STALL_SECONDS = 120;

// ---------------------------------------------------------------------------
// The assault's objective
// ---------------------------------------------------------------------------

/**
 * Men of the storming side who must be standing on the wall for it to count as taken.
 *
 * One man over the parapet is a foothold, not a capture. Twenty-four is about a third of a
 * bay's standing run at the sim's 0.72 m rank pitch, which is the smallest body that can hold
 * a stretch of walkway against a counter-attack up a stair.
 */
export const WALL_FOOTHOLD = 24;
/**
 * Seconds the storming side must hold the parapet uncontested.
 *
 * Long enough that a garrison run which is merely momentarily empty — every man on it dead in
 * the same second, the next unit already climbing — does not hand over the city, and short
 * enough that the player is not left watching a decided wall.
 */
export const WALL_HOLD_SECONDS = 20;
/**
 * Men of the storming side loose *inside* the city, at which point the wall is irrelevant.
 *
 * A storm that is in the streets has won whatever is still happening on the parapet behind
 * it. Sized at roughly one warband: a body a reserve cohort cannot simply push back into the
 * ditch. This is the condition the wall-descent work will satisfy, and it is written now so
 * that the moment men can get down the inside face the battle has somewhere to end.
 */
export const BREAK_IN = 60;
/** Metres past the curtain's own line a man must be to be "in the city" rather than on it. */
export const INSIDE_MARGIN = 14;

/**
 * Which of the objective's two conditions ended the battle.
 *
 * There are two ways to win a storm and they are not the same event — `parapet` is a
 * lodgement held on the walkway for `WALL_HOLD_SECONDS`, `breakIn` is `BREAK_IN` men loose
 * behind the curtain — and both used to leave the same footprint: `reason === 'objective'`.
 * So the card had to guess which had fired, and guessed the one that never does. It printed
 * *"The wall was carried"* under a gate held at 85 %, zero breaches, 869 of the garrison
 * still on the parapet and a roll of honour reading HELD five times.
 *
 * That is the **fourth** card this project has shipped naming a condition that did not decide
 * the battle, so the fix is not the string. The arbiter knows which one fired; it publishes
 * it, and `src/ui/BattleFlow.ts` keys its sentence off a total map, so a third condition
 * cannot be added without a sentence and the two cannot drift apart again.
 */
export type WallCondition = 'parapet' | 'breakIn';

/**
 * Fraction of its establishment below which a unit has stopped being one.
 *
 * A cohort of 320 down to 79 men is not a cohort; it is a knot of survivors. It has not
 * broken and it has not been destroyed, and calling it either would be false, so it gets its
 * own word.
 */
export const UNIT_SPENT_FRACTION = 0.25;

/** How a unit ended the battle. Ordered worst first, which is also the order it is decided. */
export type UnitOutcome = 'destroyed' | 'routed' | 'mauled' | 'held';

/**
 * How this unit ended the battle — the *one* definition of it.
 *
 * Why it is a function and not two pieces of arithmetic in two files: the card prints a
 * headline count of "Units lost" from the arbiter, and beside it a roll of honour labelling
 * each unit HELD / ROUTED / DESTROYED from the HUD's own view of the same army. Those were
 * two rules. The arbiter's counted a unit under a quarter strength as lost — correctly; the
 * roll had no word for it and printed **HELD**. So a card could read "Units lost 3 of 12"
 * over twelve rows none of which said anything had happened, which is the same defect as the
 * verdict sentence one panel up, one size smaller. `mauled` is the missing word.
 *
 * Takes primitives rather than a `UnitGroupState` so the HUD can ask it about a `UnitView`
 * without `src/ui` reaching into simulation state.
 */
export const unitOutcome = (
  destroyed: boolean,
  routing: boolean,
  alive: number,
  establishment: number
): UnitOutcome => (destroyed ? 'destroyed'
  : routing ? 'routed'
    : alive < establishment * UNIT_SPENT_FRACTION ? 'mauled' : 'held');

/**
 * Seconds an assault may go without reducing the garrison's hold on the parapet before it is
 * judged to have been thrown back.
 *
 * The garrison's half of the objective, and the reason a storm needs one at all. Measured on
 * the Aurelian Wall from the menu with a passive Rome: the garrison on the walkway falls
 * 606 -> 492 -> 474 -> 324 -> 193 -> **170, and then stops**. From t+450 to t+800 that number
 * does not move, Rome's strength does not move off 502, and the Juthungi lose about twenty men
 * every hundred seconds to the carroballistae — a grind that would take another two hours to
 * reach anybody's collapse floor. Nothing is frozen, so the no-casualty watchdog cannot see
 * it; what has stopped is *progress against the objective*.
 *
 * A low-water mark rather than a rate, so any real pressure — a run cleared, men dying on the
 * walkway — resets it and only a genuine plateau runs it out. Three minutes: long enough for a
 * fresh ladder party to climb and re-engage between two pushes, short enough that the answer
 * arrives while the player is still watching.
 */
export const STORM_STALL_SECONDS = 180;

interface Side {
  faction: Faction;
  initialMen: number;
  initialUnits: number;
}

/** The bays of a wall, flattened to the two things an objective needs to know about them. */
interface WallLine {
  /** Bay midpoints and outward (away from the city) normals, parallel arrays. */
  mx: Float64Array;
  mz: Float64Array;
  nx: Float64Array;
  nz: Float64Array;
  /**
   * Half the frontage of each bay, along the wall's own tangent.
   *
   * Carried because a bay's normal defines an infinite line and the wall is 37 m of it. See
   * the lateral test in `censusWall`.
   */
  half: Float64Array;
  /** x of bay 0's midpoint and the uniform pitch, so a man's bay is arithmetic, not a search. */
  x0: number;
  pitch: number;
  /** Whose wall it is, and who is trying to take it. */
  garrison: Faction;
  storm: Faction;
}

/** What the objective is reading off the field this second. */
interface WallCensus {
  stormOnWall: number;
  garrisonOnWall: number;
  stormInside: number;
  /**
   * Of `stormOnWall`, the men standing on ground the garrison has stopped contesting.
   *
   * The scoped form of "the wall is ours". See `censusWall`; this is the number condition A
   * is decided on, and it is at most `stormOnWall`.
   */
  stormHolding: number;
  /** Runs carrying those men, lowest first — what the storm actually holds, for the HUD. */
  holdingRuns: number[];
}

/** The narrow structural view of the city. `src/sim/` must not import `src/city/`. */
interface CityView {
  getGarrisonBays?: () => readonly {
    index: number; x0: number; z0: number; x1: number; z1: number;
    nx: number; nz: number; walkY: number; garrisonable: boolean;
    isGate: boolean; stage: string;
  }[];
}

export class BattleFlowSystem implements Subsystem {
  readonly name = 'battleFlow';
  /** After morale (30) so a rout registered this tick counts toward the result. */
  readonly order = 50;

  private battle!: BattleSystem;
  private sides: Side[] = [];
  private collapsedFor = new Map<Faction, number>();
  private ended = false;
  private elapsed = 0;
  /** Living men on the field the last time anything changed, and how long ago that was. */
  private lastLiving = -1;
  private startLiving = -1;
  private quietFor = 0;
  /** Null in a field battle. */
  private wall: WallLine | null = null;
  private wallCensus: WallCensus = {
    stormOnWall: 0, garrisonOnWall: 0, stormInside: 0, stormHolding: 0, holdingRuns: [],
  };
  /**
   * Every run the garrison has stood on at any point in the battle.
   *
   * The memory that makes "taken" mean taken. Rome's 810 men do not cover the circuit: they
   * stand in eight or nine blocks of about a hundred, five ranks deep over twenty stations,
   * and most of the 45 runs have nobody on them from the first tick to the last. Without this
   * set, a scoped condition A would be satisfied by putting a ladder against a bay nobody was
   * ever defending and standing on it for twenty seconds — the wall "uncontested" because the
   * fight is four hundred metres away. A run enters the set the moment a defender is counted
   * on it and never leaves, so the ground the storm is holding has to be ground the garrison
   * held, and a garrison that marches to meet a lodgement makes that bay count from then on
   * whether it wins the fight there or loses it.
   */
  private contestedRuns = new Set<number>();
  /** Seconds the storming side has held the parapet with nobody contesting it. */
  private parapetHeldFor = 0;
  /** Fewest men the garrison has ever had on the walkway, and how long since it last fell. */
  private wallLowWater = Infinity;
  private noProgressFor = 0;
  private censusDue = 0;

  /** Result, once decided. Read by the HUD for the post-battle screen. */
  result: {
    victor: Faction | -1;
    reason: 'annihilation' | 'rout' | 'timeout' | 'objective' | 'stalemate' | 'repulsed';
    /**
     * Which objective condition fired, or null when the battle did not end on one.
     *
     * Non-null exactly when `reason === 'objective'`. Published so the card does not have to
     * infer it — see `WallCondition`.
     */
    condition: WallCondition | null;
    casualties: Record<number, number>;
    survivors: Record<number, number>;
    /** Units destroyed, broken, or reduced below a quarter strength. */
    unitsLost: Record<number, number>;
    unitsTotal: Record<number, number>;
    at: number;
  } | null = null;

  init(ctx: EngineContext): void {
    this.battle = ctx.get<BattleSystem>('battle');
    // Snapshot the order of battle after deployment. `init` runs before the scenario
    // spawns, so defer the snapshot to the first tick that sees any units.
    this.sides = [];
    this.collapsedFor.clear();
    // Which bays were defended is a fact about *this* battle, and the one piece of state
    // here that would silently hand the next one a wall it had already taken.
    this.contestedRuns.clear();
  }

  fixedUpdate(dt: number, ctx: EngineContext): void {
    const b = this.battle;
    if (b.units.length === 0) return;

    if (this.sides.length === 0) {
      /**
       * The two sides are whoever actually deployed, not `[Rome, Germanic]`.
       *
       * That literal ended the storm of Carthage six seconds after it began. Carthage fields
       * no Juthungi, so the Germanic side snapshotted `initialMen: 0`, scored `frac = 0`,
       * was judged spent on the first tick and confirmed as the loser at `CONFIRM_SECONDS` —
       * handing Rome an instant victory over an army that was never there while a real
       * battle went on around it. `checkVictory` in `scenario.ts` had already been made
       * faction-agnostic for the same reason; this is the other half of it.
       *
       * A side with no units is not a side. Built from the deployment in faction order, so
       * `sides[0]` is still Rome in every battle that has Rome in it and the timeout's
       * score comparison keeps its meaning.
       */
      for (const f of ALL_FACTIONS) {
        const own = b.units.filter((u) => u.faction === f);
        if (own.length === 0) continue;
        this.collapsedFor.set(f, 0);
        this.sides.push({
          faction: f,
          initialMen: own.reduce((a, u) => a + u.initialStrength, 0),
          initialUnits: own.length,
        });
      }
      // One side on the field is not a battle, and calling it would be worse than waiting.
      if (this.sides.length < 2) this.sides.length = 0;
      else this.wall = this.findWall(ctx);
      return;
    }

    this.elapsed += dt;
    if (this.ended) return;

    // ---- the objective, where there is one ---------------------------------
    if (this.wall) {
      this.censusDue -= dt;
      if (this.censusDue <= 0) {
        // Once a second. The census walks every unit and the whole pool, so it is not a
        // per-tick cost — and a wall does not change hands inside a second.
        this.censusDue = 1;
        this.wallCensus = this.censusWall(this.wall);
      }
      const c = this.wallCensus;
      /*
       * `stormHolding`, not `stormOnWall` against an empty circuit. The old pair of terms
       * asked the storm to put two dozen men on the parapet *and* clear every other bay of
       * the city's wall at the same time; the second half of that was unreachable by
       * construction and is the whole reason this condition never fired. See `censusWall`.
       */
      const taken = c.stormHolding >= WALL_FOOTHOLD;
      this.parapetHeldFor = taken ? this.parapetHeldFor + dt : 0;
      // Named separately, and the name is published. See `WallCondition`.
      const carried = this.parapetHeldFor >= WALL_HOLD_SECONDS;
      const brokeIn = c.stormInside >= BREAK_IN;
      if (carried || brokeIn) {
        this.finish(ctx, this.wall.storm, 'objective', carried ? 'parapet' : 'breakIn');
        return;
      }
      /*
       * And the garrison's half of it: an assault that has stopped reducing the defence of
       * the parapet has been thrown back, whatever it still has standing in the open.
       *
       * Only while the garrison is actually up there. With it off the wall a plateau at zero
       * would run this timer out and hand the city to an army that is dead — the objective
       * above and the collapse floor below both own that case.
       */
      if (c.garrisonOnWall > 0 && c.stormInside < BREAK_IN) {
        if (c.garrisonOnWall < this.wallLowWater) {
          this.wallLowWater = c.garrisonOnWall;
          this.noProgressFor = 0;
        } else {
          this.noProgressFor += dt;
        }
        if (this.noProgressFor > STORM_STALL_SECONDS) {
          this.finish(ctx, this.wall.garrison, 'repulsed');
          return;
        }
      } else {
        this.noProgressFor = 0;
      }
    }

    // ---- has anything happened at all? -------------------------------------
    let living = 0;
    for (const u of b.units) if (!u.destroyed) living += u.alive;
    if (this.startLiving < 0) this.startLiving = living;
    if (living !== this.lastLiving) {
      this.lastLiving = living;
      this.quietFor = 0;
    } else if (living < this.startLiving) {
      this.quietFor += dt;
    }
    if (this.quietFor > STALL_SECONDS) {
      this.finish(ctx, this.onPoints(), 'stalemate');
      return;
    }

    // ---- cohesion ----------------------------------------------------------
    let strongest = 0;
    for (const s2 of this.sides) strongest = Math.max(strongest, this.effectiveMen(s2.faction));

    let loser: Faction | -1 = -1;
    let bothSpent = true;

    for (const side of this.sides) {
      const own = b.units.filter((u) => u.faction === side.faction && !u.destroyed);
      const effective = own.filter((u) => u.order !== UnitOrder.Rout);
      const men = effective.reduce((a, u) => a + u.alive, 0);
      const frac = side.initialMen > 0 ? men / side.initialMen : 0;

      // Spent if nothing is still standing in order, if the remnant is too thin to fight,
      // or if what is left is so far behind what is still standing opposite that the result
      // is not in question. See `DECISIVE_RATIO`.
      const rel = strongest > 0 ? men / strongest : 1;
      const spent = effective.length === 0
        || frac < COLLAPSE_STRENGTH
        || (this.decisiveApplies(side.faction) && frac < DECISIVE_OWN && rel < DECISIVE_RATIO);
      const held = (this.collapsedFor.get(side.faction) ?? 0) + (spent ? dt : -dt * 2);
      this.collapsedFor.set(side.faction, Math.max(0, Math.min(CONFIRM_SECONDS + 1, held)));

      if (!spent) bothSpent = false;
      if ((this.collapsedFor.get(side.faction) ?? 0) >= CONFIRM_SECONDS) {
        loser = side.faction;
      }
    }

    if (loser !== -1) {
      const winner = bothSpent
        ? -1
        : (this.sides.find((s2) => s2.faction !== loser)?.faction ?? -1);
      // Annihilation only if the loser genuinely has no living men; otherwise they broke.
      const loserAlive = b.units
        .filter((u) => u.faction === loser && !u.destroyed)
        .reduce((a, u) => a + u.alive, 0);
      this.finish(ctx, winner, loserAlive === 0 ? 'annihilation' : 'rout');
      return;
    }

    if (this.elapsed > TIMEOUT_SECONDS) {
      /*
       * A besieger who has not taken the city by nightfall has failed, and that is not the
       * same rule as "whoever has more men in order". Under the field rule the Juthungi took
       * the assault on a timeout with 1,917 men still outside a wall they never got over,
       * against a garrison of 343 that had held it all day.
       */
      if (this.wall) this.finish(ctx, this.wall.garrison, 'repulsed');
      // Otherwise whoever still has more men in order takes a marginal victory.
      else this.finish(ctx, this.onPoints(), 'timeout');
    }
  }

  /** Living men of a faction that are still in order — routers are not an army. */
  private effectiveMen(f: Faction): number {
    let men = 0;
    for (const u of this.battle.units) {
      if (u.destroyed || u.faction !== f || u.order === UnitOrder.Rout) continue;
      men += u.alive;
    }
    return men;
  }

  /**
   * Whether a side may be judged beaten on the *margin* rather than on the absolute floor.
   *
   * A garrison is meant to be outnumbered — Rome holds the Aurelian Wall with 1,154 against
   * 1,920 — so applying the ratio to a storm would call the city taken at the opening
   * whistle, and later would end it the moment the garrison was worn down even while it
   * still held every bay. In a storm the wall decides, and nothing else may.
   */
  private decisiveApplies(f: Faction): boolean {
    return this.wall === null || (f !== this.wall.garrison && f !== this.wall.storm);
  }

  /** Whoever is furthest ahead on surviving effectives; a draw inside five per cent. */
  private onPoints(): Faction | -1 {
    let best: Faction | -1 = -1;
    let bestScore = -1;
    let second = -1;
    for (const s of this.sides) {
      const score = this.effectiveMen(s.faction) / Math.max(1, s.initialMen);
      if (score > bestScore) {
        second = bestScore;
        bestScore = score;
        best = s.faction;
      } else if (score > second) second = score;
    }
    return bestScore - second < 0.05 ? -1 : best;
  }

  // -------------------------------------------------------------------------
  // The wall
  // -------------------------------------------------------------------------

  /**
   * Is this a storm, and if so whose wall is it?
   *
   * Read off the deployment rather than out of the city plan. `CityPlan.garrison` is the
   * right answer and it is an *intention*: this asks the field instead, so it cannot
   * disagree with the battle in front of it whatever a roster or a plan later does. Whoever
   * the siege system has standing on the stonework when the battle opens is the garrison.
   */
  private findWall(ctx: EngineContext): WallLine | null {
    const city = ctx.tryGet('city') as unknown as CityView | undefined;
    const bays = city?.getGarrisonBays?.() ?? [];
    if (bays.length < 2) return null;

    const held = new Map<Faction, number>();
    for (const u of this.battle.units) {
      // `siege.isGarrisoned` rather than `u.order === Garrison`: the order is a mutable field
      // that any halt overwrites, and the tactical layer updates at order 42 — one slot ahead
      // of this system — so on an autoplay boot the garrison can already have been told to
      // hold by the time this snapshot runs. The siege's own register cannot be clobbered.
      if (!this.battle.siege.isGarrisoned(u.id) && u.order !== UnitOrder.Garrison) continue;
      held.set(u.faction, (held.get(u.faction) ?? 0) + u.alive);
    }
    let garrison: Faction | -1 = -1;
    let most = 0;
    for (const [f, n] of held) if (n > most) { most = n; garrison = f; }
    if (garrison === -1) return null;

    // The storming side is whichever other faction brought men. There are never more than
    // two armies in one battle, so "the other one" is well defined.
    let storm: Faction | -1 = -1;
    for (const s of this.sides) if (s.faction !== garrison) storm = s.faction;
    if (storm === -1) return null;

    const n = bays.length;
    const mx = new Float64Array(n);
    const mz = new Float64Array(n);
    const nx = new Float64Array(n);
    const nz = new Float64Array(n);
    const half = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const bay = bays[i];
      mx[i] = (bay.x0 + bay.x1) * 0.5;
      mz[i] = (bay.z0 + bay.z1) * 0.5;
      nx[i] = bay.nx;
      nz[i] = bay.nz;
      const dx = bay.x1 - bay.x0;
      const dz = bay.z1 - bay.z0;
      half[i] = 0.5 * Math.sqrt(dx * dx + dz * dz);
    }
    // Bays run broadly along x on every map — `CitySystem` asserts a uniform pitch and
    // `bayAt` already indexes them arithmetically for the same reason — so a man's bay is a
    // division rather than a search over forty of them, once per living man per second.
    const pitch = (mx[n - 1] - mx[0]) / (n - 1);
    if (!Number.isFinite(pitch) || Math.abs(pitch) < 1) return null;

    return { mx, mz, nx, nz, half, x0: mx[0], pitch, garrison, storm };
  }

  /**
   * Where both armies are with respect to the stonework.
   *
   * Men on the wall come from `Siege.unitWallState`, which counts a man only when he holds a
   * station on the spine. That is stricter than "off the ground" and the difference matters:
   * a boarding party riding a tower deck 74 m out and a file halfway up a ladder are both
   * `elevated` and neither is on the parapet, so counting elevation would hand the storming
   * side a foothold before it had one.
   *
   * Men in the city come from a pool walk, because the wall system has no notion of "inside"
   * — it is a fact about the curtain's geometry, and the bays carry it in their own normals.
   *
   * ## A normal defines an infinite line, and the wall is 37 m of it
   *
   * That pool walk found a man's bay by arithmetic, **clamped the index to the ends of the
   * circuit**, and then asked whether he was more than `INSIDE_MARGIN` past that bay's
   * midline. Both halves are needed and the second was missing: a bay's outward normal
   * defines a half-plane that runs to the edge of the map, so any man on the cityward side of
   * the *extension* of the end bay's line was counted as being inside the city.
   *
   * Measured on the storm of Rome, at the tick condition B fired — world positions read out
   * of the pool, not the census's opinion of them:
   *
   * ```
   *   t+72  stormInside 67, stormHolding 0, stormOnWall 147
   *   86 men counted inside; 50 of them are one cavalry squadron at x -110, z 575-584
   *   the circuit's west end is x = 2, so those men are 112 m past the end of the wall
   *   their arithmetic bay index is -4, clamped to 0, depth read -20 to -32 m
   * ```
   *
   * **And picking the nearest bay instead of the clamped one does not help** — bay 0 *is* the
   * nearest, at 135-142 m, and it reads them just as deep. The fault is the half-plane, not
   * the clamp. So the test now also asks that the man be within the bay's own frontage along
   * the wall's tangent, `half[k] + INSIDE_MARGIN`: 32.5 m either side of a 37 m bay's centre,
   * which admits a man who has just come round a corner and excludes one standing in open
   * country a hundred metres off the end.
   *
   * Two thirds of a twelve-seed campaign's verdicts were being decided by this. It does not
   * touch the legitimate route: the 36 men behind bay 2's `footing` at that same tick are the
   * building site the design intends to be walkable (`ROME.md` §8.8.2) and they still count.
   * **Whether cavalry should be able to ride round the unbuilt west end of the circuit at all
   * is a separate question and not this file's** — `ROME.md` §15 task 9 closes the flanks.
   *
   * ## What the storm is *holding*, as against what it is standing on
   *
   * `garrisonOnWall` is a sum over the whole circuit, and condition A used to ask it to reach
   * zero. On the Aurelian Wall that is 810 men over 1.78 km, and across twelve seeded runs of
   * the assault the smallest it ever reached was 542 — the bar was never approached, let
   * alone met, because emptying a mile and a half of parapet is not what taking a wall means
   * and no assault was ever going to do it. A storm takes a *stretch*.
   *
   * So the same walk also bins both sides by run — `Siege` cuts the spine into runs, maximal
   * stretches a man can walk without leaving the wall, and there is one per garrisonable bay
   * because every break on either circuit is a tower: ~38 m and ~38 stations apiece, so a run
   * is a bay. **The run is the unit of decision**, and it is held on two things:
   *
   *   - no man of the garrison stands on it;
   *   - it is ground the garrison has held (`contestedRuns`).
   *
   * `stormHolding` is the men on every run that passes. Condition A then asks that number,
   * not `stormOnWall`, to reach `WALL_FOOTHOLD` and stay there for `WALL_HOLD_SECONDS` —
   * which is the same twenty-four men and the same twenty seconds as before, now asked about
   * the ground they are actually on.
   *
   * ## Why a run and not a lodgement, which is the third time this has been narrowed
   *
   * The rule this replaces judged a **maximal block of consecutive runs the storm had men
   * on**, all or nothing: one defender anywhere in the block and none of it counted. That is
   * the shoulder again — it asks the storm to clear ground it is not fighting for — and this
   * time it was the whole footprint of the escalade rather than one bay either side of it. A
   * shipped storm plants four banks of ladders on four adjacent bays and spills men onto the
   * two beyond them, so the block is five or six runs and about a hundred and fifty
   * defenders. Measured over twelve seeded runs of the Aurelian Wall with the host storming,
   * both rules on the same seeds: the block form reported **`stormHolding` 0 in 12 of 12 and
   * never within an order of magnitude of the 24 it wants**, while `stormOnWall` peaked at
   * 115-164 and the garrison on the walkway was driven from 810 down to 661-778. Off the
   * shipped plan, with the escalade aimed at a stretch it could actually take, the block form
   * stayed at 0 through peaks of 237 men on the parapet and the per-run form read 220. Two
   * hundred men on the parapet and the number the win is read off never leaving zero is an
   * instrument disagreeing with the battle in front of it.
   *
   * The same sentence that killed the shoulder decides this: **a run is its own margin.** It
   * is 38 m, a lodgement of two dozen men occupies about 17 m of it, and to count at all it
   * must be ground the garrison chose to hold and has been driven off. If that is enough
   * margin to stop counting the defender one station past the joint, it is enough to stop
   * counting the one two bays away — and "the block" was counting him.
   *
   * What would change this back: a circuit whose runs are much shorter than a bay, where 24
   * men on one run would be a foothold rather than a capture and the block would be doing
   * real work. `Siege.wallReport().runs` is the number to check.
   *
   * ## Why there is no shoulder, which is the one thing here that was measured twice
   *
   * The first version of this also required the run *either side* of the lodgement to be
   * clear, on the reasoning that a run boundary is a fact about the masonry rather than about
   * the fight and a defender one station the far side of a joint is a metre away. That
   * reasoning is sound and the rule it produced was **useless**: it never fired, not in twelve
   * seeded runs of the shipped assault and not in any of six lighter garrisons swept down from
   * 810 men on the parapet to 108. Which is to say it was the same defect as the one above,
   * one order of magnitude smaller.
   *
   * The measurement that killed it. On a three-bay garrison the storm fought for bay 18 from
   * t+251 with 25 men against 57, killed the last defender on it by t+297, and then stood on
   * it with 55 to 84 men and nobody else for the next fifty seconds — while 65 defenders on
   * bay 19 held exactly 65 men and took **not one casualty** from t+251 to t+347. Rome's
   * garrison holds the bay it is given; it does not counter-attack along the walkway. So "a
   * defender within one bay" is not a measurement of contest at all — it is a demand that the
   * storm also destroy a body of men who are not fighting it, which is annihilation again.
   *
   * A run is its own margin. It is 38 m, and a lodgement of two dozen men occupies about 17 m
   * of that, so clearing the run already puts the nearest possible defender ten metres beyond
   * either flank — and to be counted at all that defender must be standing somewhere the
   * garrison chose to hold, having been driven off ground it did hold.
   *
   * ## And a unit that has broken is not contesting anything
   *
   * `garrisonOnWall` counts men, because it is a physical fact and condition C reads it as
   * one. **`garrisonRun` counts defenders**, and a unit under `UnitOrder.Rout` is not one.
   * That is not a special case invented here: `effectiveMen` in this file already excludes
   * routers from an army, `Siege.mayBoard` refuses a broken unit a place in a file,
   * `WallDoctrine.decideWall` skips a routing enemy, and the whole victory model in the
   * header is "a battle ends when one side stops being an army".
   *
   * It matters because a routed man on a parapet has nowhere to run to. Measured at the end
   * of seeded storms of the Aurelian Wall: **three to six of Rome's garrison units had broken
   * and were still standing on 6 to 170 stations** — up to five bays' worth of curtain, denied
   * to the storm for the rest of the battle by men who had stopped fighting. Counting them is
   * the annihilation demand for the third time, at the smallest scale yet: one terrified man
   * holds 38 m for ever. On the arm where condition A becomes reachable at all, excluding them
   * is what takes `stormHolding` from 0 to 66-220 and fires the condition.
   */
  private censusWall(w: WallLine): WallCensus {
    const b = this.battle;
    const p = b.pool;
    const out: WallCensus = {
      stormOnWall: 0, garrisonOnWall: 0, stormInside: 0, stormHolding: 0, holdingRuns: [],
    };
    const stormRun = new Map<number, number>();
    const garrisonRun = new Map<number, number>();
    /**
     * Storm units that have broken, by id — read by **both** halves of this function.
     *
     * Collected in the walk that bins the parapet rather than tested inside the pool loop
     * below, because that loop runs over every slot in the pool and `unitById` is a search.
     * Thirty-five entries against nine thousand lookups.
     *
     * It was written here and read nowhere for one commit, so the exclusion reached condition
     * A — where it changes nothing, because `stormHolding` has never been non-zero — and not
     * condition B, which is the condition that decides every siege in this game. A set with
     * one writer and no reader is the exact shape of a fix that was designed and not wired,
     * and the compiler cannot see it because the write is legal on its own.
     */
    const routed = new Set<number>();
    for (const u of b.units) {
      if (u.destroyed || u.alive === 0) continue;
      if (u.faction !== w.garrison && u.faction !== w.storm) continue;
      const st = b.siege.unitWallState(u.id);
      if (u.faction === w.storm && isBroken(u)) {
        routed.add(u.id);
        // Still counted where he stands — `stormOnWall` is a description of the parapet and
        // a man running along it is on it — but he takes no part in a lodgement, and the
        // pool walk below will not count him as having got inside either.
        out.stormOnWall += st.onWall;
        continue;
      }
      if (st.onWall === 0) continue;
      const held = u.faction === w.garrison;
      if (held) out.garrisonOnWall += st.onWall;
      else out.stormOnWall += st.onWall;
      // A broken unit is still men on the stone — `garrisonOnWall` above counts them — and it
      // is no longer a defence, so it does not deny a run. See the note on breaking.
      const contests = !held || u.order !== UnitOrder.Rout;
      for (const key of Object.keys(st.runCounts)) {
        const r = Number(key);
        if (contests) {
          const byRun = held ? garrisonRun : stormRun;
          byRun.set(r, (byRun.get(r) ?? 0) + st.runCounts[r]);
        }
        // Ground the garrison stood on counts as ground it held whether it is still fighting
        // for it or not: a run that has been taken from a unit that then broke on it is
        // exactly the case condition A exists to reward.
        if (held) this.contestedRuns.add(r);
      }
    }
    // Run by run, each judged on its own occupants and its own history. A storm split
    // between two cleared stretches holds both, and a run it has a toe-hold on but has not
    // cleared costs it nothing.
    const runs = [...stormRun.keys()].sort((a, c) => a - c);
    for (const r of runs) {
      if ((garrisonRun.get(r) ?? 0) !== 0) continue;
      if (!this.contestedRuns.has(r)) continue;
      out.stormHolding += stormRun.get(r) ?? 0;
      out.holdingRuns.push(r);
    }
    const last = w.mx.length - 1;
    for (let i = 0; i < p.count; i++) {
      if (p.faction[i] !== w.storm || b.elevated[i] !== 0 || !p.aliveAt(i)) continue;
      /*
       * The rout test, on the condition that actually decides both sieges.
       *
       * `pool.unitId` is the canonical owner of a man — `BattleSystem` writes it at spawn and
       * `unitOfSoldier`, `Combat`, `Projectiles` and `Siege` all read it — so this needs no
       * new index and costs one set lookup per living man of the storm. That is the whole
       * price of asking the question at all, which is worth stating because the first cut of
       * this walked units instead and could not, having no unit in hand.
       */
      if (routed.has(p.unitId[i])) continue;
      const k = Math.max(0, Math.min(last, Math.round((p.x[i] - w.x0) / w.pitch)));
      const dx = p.x[i] - w.mx[k];
      const dz = p.z[i] - w.mz[k];
      // Negative is cityward: a bay's normal points away from the city by contract.
      const depth = dx * w.nx[k] + dz * w.nz[k];
      if (depth >= -INSIDE_MARGIN) continue;
      /*
       * And he has to be *behind the bay*, not merely on the cityward side of the infinite
       * line its normal defines. The tangent is the normal turned 90 degrees, so this is the
       * same two multiplies again. See the note on the half-plane above `censusWall`.
       */
      const lateral = Math.abs(dx * -w.nz[k] + dz * w.nx[k]);
      if (lateral > w.half[k] + INSIDE_MARGIN) continue;
      out.stormInside++;
    }
    return out;
  }

  /**
   * How the storm is doing against the objective, and what the objective *is*. Null in a
   * field battle.
   *
   * The thresholds ride along with the census deliberately. Every one of them was a private
   * constant in this file and nothing on screen said any of them, so the winning move — get
   * sixty men fourteen metres past the curtain — was undiscoverable: a hands-off assault that
   * put ~350 men on the parapet lost at t+286 with 41% casualties, while one cohort through
   * the broken gate won at t+336. A HUD that read the census but re-declared the numbers
   * would be a second copy of the rules to drift from, so they are published from the one
   * place that enforces them.
   */
  get objective(): (WallCensus & {
    heldFor: number;
    storm: Faction;
    garrison: Faction;
    /** Men inside that end it, and how far past the curtain counts as inside. */
    needInside: number;
    insideMargin: number;
    /** Men holding taken parapet that end it, and for how long. */
    needFoothold: number;
    holdSeconds: number;
    /** Seconds without progress against the parapet before the storm is judged thrown back,
     *  and how many of them have run. */
    stallSeconds: number;
    stalledFor: number;
  }) | null {
    if (!this.wall) return null;
    return {
      ...this.wallCensus,
      heldFor: this.parapetHeldFor,
      storm: this.wall.storm,
      garrison: this.wall.garrison,
      needInside: BREAK_IN,
      insideMargin: INSIDE_MARGIN,
      needFoothold: WALL_FOOTHOLD,
      holdSeconds: WALL_HOLD_SECONDS,
      stallSeconds: STORM_STALL_SECONDS,
      stalledFor: this.noProgressFor,
    };
  }

  private finish(
    ctx: EngineContext,
    victor: Faction | -1,
    reason: 'annihilation' | 'rout' | 'timeout' | 'objective' | 'stalemate' | 'repulsed',
    condition: WallCondition | null = null
  ): void {
    this.ended = true;
    const b = this.battle;
    const casualties: Record<number, number> = {};
    const survivors: Record<number, number> = {};
    const unitsLost: Record<number, number> = {};
    const unitsTotal: Record<number, number> = {};
    for (const side of this.sides) {
      const own = b.units.filter((u) => u.faction === side.faction);
      const alive = own.reduce((a, u) => a + (u.destroyed ? 0 : u.alive), 0);
      survivors[side.faction] = alive;
      casualties[side.faction] = Math.max(0, side.initialMen - alive);
      unitsTotal[side.faction] = own.length;
      // A unit counts as lost if it is gone, if it has broken, or if it has been reduced
      // below a quarter of its establishment. Snapshotting only `destroyed` at the instant
      // of victory reported "0 of 21 lost" on a battle whose roll of honour listed cohorts
      // at 18 of 320 men and flagged ROUTED — units are flagged destroyed later, as they
      // leave the field, long after the result is called.
      //
      // Through `unitOutcome`, which is the same function the roll of honour labels its rows
      // with. It used to be this expression here and a different one in the card.
      unitsLost[side.faction] = own.filter(
        (u) => unitOutcome(u.destroyed, u.order === UnitOrder.Rout, u.alive, u.initialStrength)
          !== 'held'
      ).length;
    }
    this.result = {
      victor, reason, condition, casualties, survivors, unitsLost, unitsTotal, at: this.elapsed,
    };

    ctx.events.emit('battleEnded', { victor: victor as number, reason });
    ctx.events.emit('musicCue', {
      id: victor === Faction.Rome ? 'victory' : victor === -1 ? 'tension' : 'defeat',
    });

    // Let the winners celebrate: it reads as a conclusion rather than a freeze.
    for (const u of b.units) {
      if (u.destroyed || u.order === UnitOrder.Rout) continue;
      if (u.faction === victor) this.cheer(u);
    }
  }

  private cheer(u: UnitGroupState): void {
    u.order = UnitOrder.Hold;
    u.targetUnitId = -1;
    u.waypoints.length = 0;
  }

  get isOver(): boolean {
    return this.ended;
  }
}
