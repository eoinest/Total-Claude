import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { UnitOrder, type UnitGroupState } from '../sim/types';
import { angleDelta } from '../util/math';

/**
 * The AI's only hand on the simulation.
 *
 * Every order goes out as the same `orderIssued` event the player's mouse produces, so
 * the AI can never do anything a human could not, and the sim needs no AI-specific
 * entry points. The one job this class adds is **de-duplication**: `applyOrder` clears
 * a unit's waypoint queue on every non-queued move, so re-sending "go there" each tick
 * would reset the unit's route thirty times a second and it would never arrive. We
 * therefore remember what each unit was last told and stay quiet until the instruction
 * genuinely changes.
 */

/** Re-issue a move only when the destination has shifted at least this far. */
const MOVE_EPS = 4.0;
/**
 * Re-issue a facing order only past this angular change.
 *
 * Raised from 0.2 rad (11 degrees) to 0.45 (26 degrees). A formation wheels at about
 * 34 deg/s, so an 11-degree threshold is reachable in a third of a second and let ordinary
 * threat-assessment noise re-aim a cohort continuously. A wheel is a commitment: it should
 * take a real change of situation to order one, not a neighbour shifting a few metres.
 */
const FACING_EPS = 0.45;
/**
 * And never more often than this. Raised from 10 ticks to 45 (1.5 s at 30 Hz) for the same
 * reason: a cohort that re-aims three times a second never finishes turning, so it presents
 * its flank to everything for the whole battle instead of squaring up to one thing.
 */
const FACING_REISSUE_TICKS = 45;
/** Never re-issue the same kind of order more often than this, whatever changed. */
const MIN_REISSUE_TICKS = 6;

interface OrderRecord {
  kind: string;
  x: number;
  z: number;
  facing: number;
  targetUnitId: number;
  running: boolean;
  formation: string;
  pathHash: number;
  tick: number;
  facingTick: number;
  /** Ability id -> tick at which it may be used again. */
  abilityReady: Map<string, number>;
}

export class OrderBook {
  private events: EventBus<GameEvents>;
  private last = new Map<number, OrderRecord>();
  private tick = 0;

  /** Counters for the debug overlay. */
  readonly stats = { moves: 0, attacks: 0, halts: 0, facings: 0, formations: 0, abilities: 0, paths: 0 };

  constructor(events: EventBus<GameEvents>) {
    this.events = events;
  }

  setTick(t: number): void {
    this.tick = t;
  }

  private rec(unitId: number): OrderRecord {
    let r = this.last.get(unitId);
    if (!r) {
      r = {
        kind: '', x: NaN, z: NaN, facing: NaN, targetUnitId: -1,
        running: false, formation: '', pathHash: 0, tick: -999, facingTick: -999,
        abilityReady: new Map(),
      };
      this.last.set(unitId, r);
    }
    return r;
  }

  /** Forget a unit's history — call when it is destroyed so the map cannot grow. */
  forget(unitId: number): void {
    this.last.delete(unitId);
  }

  /**
   * Drop the memory of an order the simulation has since overwritten. **Call before
   * deciding, every tick, for every unit.**
   *
   * De-duplication is what stops a route being reset thirty times a second, and it works by
   * remembering what we last *said*. But the sim also writes `u.order` on its own account,
   * in three places: a `MoveTo` that arrives settles to `Hold`, a `MoveTo` that runs out of
   * route settles to `Hold`, and an `AttackUnit` whose target dies is put on `Hold` at its
   * own feet with `targetUnitId` cleared. None of those reaches this book, so it goes on
   * believing the unit is moving or attacking, suppresses the identical order the behaviour
   * layer keeps re-issuing, and **the unit stands still for the rest of the battle.**
   *
   * Measured on the shipped field battle with a passive Rome: at t+1200 eighteen of the
   * nineteen Juthungi units were on `Hold` with `targetX === x`, three of them scoring
   * `engage` as their chosen behaviour with a Roman cohort 20, 29 and 39 m away. Nothing had
   * been ordered for the previous two hundred seconds and the scoreboard did not move again
   * before the 2,400 s timeout — sixteen and a half real minutes at 1x.
   *
   * The test is deliberately narrow: only a *movement* or *attack* record is dropped, and
   * only when the unit's own order disagrees with it. A `halt` record matches `Hold` and is
   * left alone, so a line that has been told to stand is still quiet.
   */
  reconcile(u: UnitGroupState): void {
    const r = this.last.get(u.id);
    if (!r) return;
    if (r.kind === 'move' || r.kind === 'path') {
      if (u.order !== UnitOrder.MoveTo && u.order !== UnitOrder.AttackMove) r.kind = '';
    } else if (r.kind === 'attack') {
      if (u.order !== UnitOrder.AttackUnit || u.targetUnitId !== r.targetUnitId) r.kind = '';
    }
  }

  /** What we last told this unit to do, for the debug overlay. */
  lastKind(unitId: number): string {
    return this.last.get(unitId)?.kind ?? '';
  }

  // -------------------------------------------------------------------------
  // Movement
  // -------------------------------------------------------------------------

  move(u: UnitGroupState, x: number, z: number, facing: number, running: boolean): boolean {
    const r = this.rec(u.id);
    const same =
      r.kind === 'move' &&
      Math.sqrt((x - r.x) * (x - r.x) + (z - r.z) * (z - r.z)) < MOVE_EPS &&
      Math.abs(angleDelta(r.facing, facing)) < FACING_EPS &&
      r.running === running;
    if (same) return false;
    if (this.tick - r.tick < MIN_REISSUE_TICKS && r.kind === 'move') return false;

    this.events.emit('orderIssued', { unitIds: [u.id], kind: 'move', source: 'ai', x, z, facing, running });
    r.kind = 'move';
    r.x = x;
    r.z = z;
    r.facing = facing;
    r.running = running;
    r.targetUnitId = -1;
    r.pathHash = 0;
    r.tick = this.tick;
    this.stats.moves++;
    return true;
  }

  /**
   * Walk a multi-leg route. The first leg replaces the current order; the rest go into
   * the sim's own waypoint queue, which pops them as the anchor arrives. Intermediate
   * legs face along the direction of travel; only the last carries the ordered facing.
   */
  followPath(u: UnitGroupState, pts: number[], n: number, finalFacing: number, running: boolean): boolean {
    if (n < 2) return false;
    let hash = (n * 131) ^ (running ? 977 : 0);
    for (let i = 0; i < n * 2; i++) hash = (hash * 31 + Math.round(pts[i])) | 0;

    const r = this.rec(u.id);
    if (r.kind === 'path' && r.pathHash === hash) return false;
    if (this.tick - r.tick < MIN_REISSUE_TICKS && r.kind === 'path') return false;

    for (let i = 1; i < n; i++) {
      const x = pts[i * 2];
      const z = pts[i * 2 + 1];
      const facing =
        i === n - 1 ? finalFacing : Math.atan2(pts[i * 2] - pts[(i - 1) * 2], pts[i * 2 + 1] - pts[(i - 1) * 2 + 1]);
      this.events.emit('orderIssued', {
        unitIds: [u.id], kind: 'move', source: 'ai', x, z, facing, running, queued: i > 1,
      });
    }
    r.kind = 'path';
    r.x = pts[(n - 1) * 2];
    r.z = pts[(n - 1) * 2 + 1];
    r.facing = finalFacing;
    r.running = running;
    r.targetUnitId = -1;
    r.pathHash = hash;
    r.tick = this.tick;
    this.stats.paths++;
    return true;
  }

  attack(u: UnitGroupState, targetUnitId: number): boolean {
    const r = this.rec(u.id);
    if (r.kind === 'attack' && r.targetUnitId === targetUnitId) return false;
    if (this.tick - r.tick < MIN_REISSUE_TICKS && r.kind === 'attack') return false;

    this.events.emit('orderIssued', { unitIds: [u.id], kind: 'attack', source: 'ai', targetUnitId });
    r.kind = 'attack';
    r.targetUnitId = targetUnitId;
    r.running = true;
    r.pathHash = 0;
    r.tick = this.tick;
    this.stats.attacks++;
    return true;
  }

  halt(u: UnitGroupState): boolean {
    const r = this.rec(u.id);
    if (r.kind === 'halt') return false;
    this.events.emit('orderIssued', { unitIds: [u.id], kind: 'halt', source: 'ai' });
    r.kind = 'halt';
    r.x = u.x;
    r.z = u.z;
    r.targetUnitId = -1;
    r.pathHash = 0;
    r.tick = this.tick;
    this.stats.halts++;
    return true;
  }

  /**
   * Facing is independent of the movement order, so it keeps its own tolerance and its
   * own re-issue clock. Without the clock, a unit bracing against a moving target
   * re-aims on every think and fills the event bus with sub-degree corrections.
   */
  face(u: UnitGroupState, facing: number): boolean {
    const r = this.rec(u.id);
    if (Math.abs(angleDelta(u.targetFacing, facing)) < FACING_EPS) return false;
    if (this.tick - r.facingTick < FACING_REISSUE_TICKS) return false;
    this.events.emit('orderIssued', { unitIds: [u.id], kind: 'facing', source: 'ai', facing });
    r.facing = facing;
    r.facingTick = this.tick;
    this.stats.facings++;
    return true;
  }

  formation(u: UnitGroupState, id: string): boolean {
    if (u.formationId === id) return false;
    const r = this.rec(u.id);
    if (r.formation === id && this.tick - r.tick < 30) return false;
    this.events.emit('orderIssued', { unitIds: [u.id], kind: 'formation', source: 'ai', formation: id });
    r.formation = id;
    this.stats.formations++;
    return true;
  }

  /**
   * Fire an ability. Cooldowns are tracked here rather than in the behaviours so no
   * amount of dithering upstream can spam the event bus.
   */
  ability(u: UnitGroupState, id: string, cooldownTicks: number): boolean {
    const r = this.rec(u.id);
    const ready = r.abilityReady.get(id) ?? -1;
    if (this.tick < ready) return false;
    r.abilityReady.set(id, this.tick + cooldownTicks);
    this.events.emit('orderIssued', { unitIds: [u.id], kind: 'ability', source: 'ai', ability: id });
    this.stats.abilities++;
    return true;
  }

  /** True if the ability is off cooldown, without using it. */
  abilityReady(unitId: number, id: string): boolean {
    const r = this.last.get(unitId);
    if (!r) return true;
    return this.tick >= (r.abilityReady.get(id) ?? -1);
  }
}
