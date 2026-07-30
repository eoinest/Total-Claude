import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from './BattleSystem';
import { Faction, UnitOrder, type UnitGroupState } from './types';

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
 *   - a total collapse of morale across the whole army.
 * Casualties are the consequence, not the criterion.
 */

/** Fraction of starting strength below which a faction is judged spent. */
const COLLAPSE_STRENGTH = 0.22;
/** Seconds a faction must stay collapsed before the result is called, so a momentary
 *  wobble mid-melee does not end the battle prematurely. */
const CONFIRM_SECONDS = 6;
/** Hard stop, in simulated seconds. Historical field battles of this scale were decided
 *  in well under an hour; 20 minutes of sim is generous and stops a stalemate hanging. */
const TIMEOUT_SECONDS = 1200;

interface Side {
  faction: Faction;
  initialMen: number;
  initialUnits: number;
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

  /** Result, once decided. Read by the HUD for the post-battle screen. */
  result: {
    victor: Faction | -1;
    reason: 'annihilation' | 'rout' | 'timeout' | 'objective';
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
    this.collapsedFor.set(Faction.Rome, 0);
    this.collapsedFor.set(Faction.Germanic, 0);
  }

  fixedUpdate(dt: number, ctx: EngineContext): void {
    const b = this.battle;
    if (b.units.length === 0) return;

    if (this.sides.length === 0) {
      for (const f of [Faction.Rome, Faction.Germanic]) {
        const own = b.units.filter((u) => u.faction === f);
        this.sides.push({
          faction: f,
          initialMen: own.reduce((a, u) => a + u.initialStrength, 0),
          initialUnits: own.length,
        });
      }
      return;
    }

    this.elapsed += dt;
    if (this.ended) return;

    let loser: Faction | -1 = -1;
    let bothSpent = true;

    for (const side of this.sides) {
      const own = b.units.filter((u) => u.faction === side.faction && !u.destroyed);
      const effective = own.filter((u) => u.order !== UnitOrder.Rout);
      const men = effective.reduce((a, u) => a + u.alive, 0);
      const frac = side.initialMen > 0 ? men / side.initialMen : 0;

      // Spent if nothing is still standing in order, or the remnant is too thin to fight.
      const spent = effective.length === 0 || frac < COLLAPSE_STRENGTH;
      const held = (this.collapsedFor.get(side.faction) ?? 0) + (spent ? dt : -dt * 2);
      this.collapsedFor.set(side.faction, Math.max(0, Math.min(CONFIRM_SECONDS + 1, held)));

      if (!spent) bothSpent = false;
      if ((this.collapsedFor.get(side.faction) ?? 0) >= CONFIRM_SECONDS) {
        loser = side.faction;
      }
    }

    if (loser !== -1) {
      const winner = bothSpent ? -1 : loser === Faction.Rome ? Faction.Germanic : Faction.Rome;
      // Annihilation only if the loser genuinely has no living men; otherwise they broke.
      const loserAlive = b.units
        .filter((u) => u.faction === loser && !u.destroyed)
        .reduce((a, u) => a + u.alive, 0);
      this.finish(ctx, winner, loserAlive === 0 ? 'annihilation' : 'rout');
      return;
    }

    if (this.elapsed > TIMEOUT_SECONDS) {
      // Whoever still has more men in order takes a marginal victory.
      const score = this.sides.map((s) => {
        const own = b.units.filter(
          (u) => u.faction === s.faction && !u.destroyed && u.order !== UnitOrder.Rout
        );
        return own.reduce((a, u) => a + u.alive, 0) / Math.max(1, s.initialMen);
      });
      const victor = Math.abs(score[0] - score[1]) < 0.05
        ? -1
        : score[0] > score[1] ? Faction.Rome : Faction.Germanic;
      this.finish(ctx, victor, 'timeout');
    }
  }

  private finish(ctx: EngineContext, victor: Faction | -1, reason: 'annihilation' | 'rout' | 'timeout' | 'objective'): void {
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
      unitsLost[side.faction] = own.filter(
        (u) => u.destroyed || u.order === UnitOrder.Rout || u.alive < u.initialStrength * 0.25
      ).length;
    }
    this.result = {
      victor, reason, casualties, survivors, unitsLost, unitsTotal, at: this.elapsed,
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
