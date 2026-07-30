import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from './BattleSystem';
import { UnitOrder } from './types';
import type { UnitGroupState } from './types';
import { isCavalry } from '../units/roster';
import { clamp01 } from '../util/math';
import { modsOf, signalsOf } from './combatShared';

/**
 * Stopgap engagement driver.
 *
 * `scenario.ts` deploys both armies on `UnitOrder.Hold`, and until the AI subsystem
 * lands nothing ever orders them forward — which means combat, morale, projectiles and
 * ragdolls are all unreachable and unverifiable. This walks the two armies into each
 * other so the rest of the simulation can be exercised and screenshotted.
 *
 * **It is designed to be deleted.** It switches itself off permanently the moment
 * either of these happens:
 *   - a subsystem with a recognised AI name is registered, or
 *   - it observes an `orderIssued` event it did not publish itself.
 *
 * So as soon as a real tactical AI or the HUD starts issuing orders, this stands down
 * without a code change. `enabled` is also public for an explicit override.
 */

/** Names an AI subsystem is likely to register under. Any of them disables this. */
const AI_NAMES = [
  'ai', 'tactical-ai', 'general-ai', 'battle-ai', 'army-ai', 'command-ai',
  'tacticalAI', 'generalAI', 'battleAI', 'armyAI', 'commandAI',
];

/** Sim seconds before the first order — long enough for deployment to settle. */
const START_DELAY = 1.5;
/** How often a free unit reconsiders its objective. */
const RETARGET_PERIOD = 2.5;
/** Cavalry sits on the wing until the infantry are committed. */
const CAVALRY_RELEASE_ROME = 20;
const CAVALRY_RELEASE_GERMANIC = 6;
/** A horseman turns to meet enemy horse inside this radius rather than riding past. */
const CAVALRY_SCREEN = 90;
/** Fatigue at which a unit drops from a run to a march while still far from contact. */
const BLOWN = 0.6;
const RECOVERED = 0.38;
/** Beyond this distance from contact, pace matters more than speed. */
const PACE_RANGE = 80;
/** A broken unit further away than this cannot be run down and is not worth chasing. */
const CATCHABLE_ROUT = 80;

export class AutoEngageSystem implements Subsystem {
  readonly name = 'autoEngage';
  readonly order = 15;

  /** Set false to hand control to something else. */
  enabled = true;

  private battle!: BattleSystem;
  private ctx!: EngineContext;
  private elapsed = 0;
  private accum = 0;
  private emitting = false;
  private standDown = false;

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.battle = ctx.get<BattleSystem>('battle');
    for (const n of AI_NAMES) {
      if (ctx.tryGet(n)) {
        this.standDown = true;
        return;
      }
    }
    ctx.events.on('orderIssued', () => {
      if (!this.emitting) this.standDown = true;
    });
  }

  fixedUpdate(dt: number, ctx: EngineContext): void {
    if (!this.enabled || this.standDown) return;
    this.elapsed += dt;
    if (this.elapsed < START_DELAY) return;

    // Pace management runs every tick; retargeting is much cheaper spread out.
    const units = this.battle.units;
    for (let k = 0; k < units.length; k++) this.managePace(units[k]);

    this.accum += dt;
    if (this.accum < RETARGET_PERIOD) return;
    this.accum = 0;
    for (let k = 0; k < units.length; k++) this.retarget(units[k]);
    void ctx;
  }

  /**
   * Run when it matters, march when it does not. Sprinting the whole approach
   * arrives with an army that can barely lift a shield.
   */
  private managePace(u: UnitGroupState): void {
    if (u.destroyed || u.order === UnitOrder.Rout || u.order === UnitOrder.Hold) return;
    const s = signalsOf(u.id);
    if (s.nearestEnemy < PACE_RANGE) {
      u.running = true;
      return;
    }
    if (u.running && u.fatigue > BLOWN) u.running = false;
    else if (!u.running && u.fatigue < RECOVERED) u.running = true;
  }

  private retarget(u: UnitGroupState): void {
    if (u.destroyed || u.alive === 0) return;
    if (u.order === UnitOrder.Rout) return;
    const s = signalsOf(u.id);
    // Combat has this formation pinned in contact; leave it alone.
    if (s.contactLock) return;
    // Abilities is running this skirmisher's withdrawal.
    if (modsOf(u.id).skirmishing && u.order === UnitOrder.MoveTo) return;

    const b = this.battle;
    const def = b.typeOf(u);
    const cav = isCavalry(def);

    if (cav) {
      const release = u.faction === 0 ? CAVALRY_RELEASE_ROME : CAVALRY_RELEASE_GERMANIC;
      if (this.elapsed < release) return;
    }

    // Still moving toward a live objective: don't second-guess it, unless the
    // objective has stopped being one.
    if (u.order === UnitOrder.AttackUnit) {
      const t = b.unitById(u.targetUnitId);
      if (t && !t.destroyed && t.alive > 0) {
        // Chasing something that has broken is how a line walks itself off the map:
        // a routing unit runs slightly faster than anything pursuing it, so the
        // pursuer never catches it and never fights anything else either.
        const chasingARout = t.order === UnitOrder.Rout;
        // Something much closer has appeared — usually a flanking move landing.
        // Cavalry is exempt: it picks a deep objective on purpose, and re-deciding
        // every couple of seconds costs it the momentum its whole value depends on.
        const better = !cav && s.nearestEnemy > 6
          && Math.hypot(t.x - u.x, t.z - u.z) > s.nearestEnemy * 1.9;
        if (!chasingARout && !better) {
          // Except: horse turns to meet horse rather than riding past it.
          if (!cav || !this.screenCavalry(u)) return;
        }
      }
    }

    const target = this.pickTarget(u, cav);
    if (target < 0) return;
    this.emitting = true;
    this.ctx.events.emit('orderIssued', {
      unitIds: [u.id],
      kind: 'attack',
      targetUnitId: target,
      running: true,
    });
    this.emitting = false;
  }

  /** True when enemy cavalry is close enough that it must be dealt with first. */
  private screenCavalry(u: UnitGroupState): boolean {
    const b = this.battle;
    const units = b.units;
    for (let k = 0; k < units.length; k++) {
      const o = units[k];
      if (o.destroyed || o.faction === u.faction || o.alive === 0) continue;
      if (o.id === u.targetUnitId) continue;
      if (!isCavalry(b.typeOf(o))) continue;
      if (Math.hypot(o.x - u.x, o.z - u.z) < CAVALRY_SCREEN) return true;
    }
    return false;
  }

  /**
   * Nearest enemy, weighted by how sensible a target it is.
   *
   * The directional term matters more than it looks. Picking purely by distance makes
   * a battle line tear itself apart: every cohort peels off after whatever skirmisher
   * happens to be nearest, the two armies slide past each other onto the wings, and
   * the centre empties. Weighting against off-axis targets keeps a line a line, and
   * heavy infantry is additionally told not to chase javelin-men it can never catch.
   */
  private pickTarget(u: UnitGroupState, cav: boolean): number {
    const b = this.battle;
    const units = b.units;
    const fx = Math.sin(u.facing);
    const fz = Math.cos(u.facing);
    let best = -1;
    let bestScore = Infinity;
    for (let k = 0; k < units.length; k++) {
      const o = units[k];
      if (o.destroyed || o.faction === u.faction || o.alive === 0) continue;
      const odef = b.typeOf(o);
      const dx = o.x - u.x;
      const dz = o.z - u.z;
      const d = Math.hypot(dx, dz);
      const ahead = d > 1e-3 ? (dx * fx + dz * fz) / d : 1;
      let weight = 1;
      const skirmisher = odef.unitClass === 'missile-infantry' || odef.unitClass === 'artillery';
      // A rout is only worth chasing if you can catch it. Broken men run slightly
      // faster than anything pursuing them, so a distant rout is a trap that walks
      // the pursuer off the field and leaves the battle unfinished.
      const routing = o.order === UnitOrder.Rout;
      const catchable = routing && d < CATCHABLE_ROUT;
      if (cav) {
        // Horse deals with horse before it goes hunting: riding past the enemy's
        // wing to get at his archers just puts them behind you.
        if (isCavalry(odef)) weight = 0.6;
        else if (skirmisher) weight = 0.55;
        else if (odef.bonusVsCavalry >= 18) weight = 2.6;
        if (catchable) weight *= 0.35;
        else if (routing) weight *= 2.2;
        // Horse is allowed to swing wide, but not to wander.
        weight *= 1 + 0.6 * (1 - clamp01(ahead));
      } else {
        if (skirmisher) weight = 1.6;
        // Infantry does not chase a rout across the field; it keeps its line.
        if (routing) weight *= catchable ? 1.4 : 2.6;
        weight *= 1 + 1.9 * (1 - clamp01(ahead));
      }
      const score = d * weight;
      if (score < bestScore) {
        bestScore = score;
        best = o.id;
      }
    }
    return best;
  }

  /** True while this stopgap is actually steering the battle. */
  get active(): boolean {
    return this.enabled && !this.standDown;
  }
}
