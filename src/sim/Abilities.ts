import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from './BattleSystem';
import { FACTIONS, UnitOrder } from './types';
import type { UnitGroupState } from './types';
import { isCavalry } from '../units/roster';
import { clamp01 } from '../util/math';
import { clearMods, modsOf, signalsOf } from './combatShared';
import type { UnitMods } from './combatShared';

/**
 * Unit abilities.
 *
 * Every ability named in `src/units/roster.ts` lives here: what it costs, how long it
 * lasts, what it changes, and — because there is no tactical AI or HUD wired up yet —
 * a heuristic for when a unit will use it unprompted. The heuristics are deliberately
 * simple and are superseded the moment something starts publishing `orderIssued`
 * events with `kind: 'ability'`; a player order always takes priority over the
 * heuristic and resets the cooldown normally.
 *
 * All stat effects are published through the shared blackboard rather than mutating
 * the roster (which is a module constant shared by every unit of that type). The mods
 * are cleared and rebuilt every tick, so an effect can never leak past its duration.
 */

interface AbilityDef {
  id: string;
  name: string;
  /** Seconds the effect lasts. Zero for toggles and passives. */
  duration: number;
  cooldown: number;
  mode: 'timed' | 'toggle' | 'passive';
  /** Sound id for the audio system. */
  sound?: string;
}

const ABILITIES: Record<string, AbilityDef> = {
  testudo: { id: 'testudo', name: 'Testudo', duration: 32, cooldown: 55, mode: 'timed', sound: 'order_testudo' },
  'pilum-volley': { id: 'pilum-volley', name: 'Pilum Volley', duration: 2.5, cooldown: 34, mode: 'timed', sound: 'order_volley' },
  'framea-volley': { id: 'framea-volley', name: 'Framea Volley', duration: 2.5, cooldown: 30, mode: 'timed', sound: 'order_volley' },
  inspire: { id: 'inspire', name: 'Inspire', duration: 26, cooldown: 70, mode: 'timed', sound: 'order_inspire' },
  brace: { id: 'brace', name: 'Brace', duration: 22, cooldown: 12, mode: 'timed', sound: 'order_brace' },
  'fire-at-will': { id: 'fire-at-will', name: 'Fire at Will', duration: 0, cooldown: 2, mode: 'toggle' },
  'arrow-storm': { id: 'arrow-storm', name: 'Arrow Storm', duration: 18, cooldown: 85, mode: 'timed', sound: 'order_arrowstorm' },
  charge: { id: 'charge', name: 'Charge', duration: 12, cooldown: 42, mode: 'timed', sound: 'order_charge' },
  warcry: { id: 'warcry', name: 'War Cry', duration: 20, cooldown: 66, mode: 'timed' },
  frenzy: { id: 'frenzy', name: 'Frenzy', duration: 26, cooldown: 78, mode: 'timed', sound: 'order_frenzy' },
  unbreakable: { id: 'unbreakable', name: 'Unbreakable', duration: 0, cooldown: 0, mode: 'passive' },
  'skirmish-mode': { id: 'skirmish-mode', name: 'Skirmish Mode', duration: 0, cooldown: 2, mode: 'toggle' },
};

export const abilityDef = (id: string): AbilityDef | undefined => ABILITIES[id];

interface AbilityState {
  id: string;
  active: boolean;
  /** Seconds of effect remaining. */
  left: number;
  /** Seconds until it may be used again. */
  cooldown: number;
  /** Formation to restore when a formation-changing ability ends. */
  restoreFormation: string;
}

/** Radius within which `inspire` steadies friendly units, metres. */
const INSPIRE_RANGE = 92;
/** Radius within which a war cry unnerves the enemy. */
const WARCRY_RANGE = 55;
/** Morale a war cry strips from an enemy unit at point-blank range, before discipline. */
const WARCRY_SHOCK = 5;
/** Metres a skirmisher tries to keep between itself and anything with a sword. */
const SKIRMISH_STANDOFF = 30;
const SKIRMISH_FALLBACK = 52;

export class AbilitySystem implements Subsystem {
  readonly name = 'abilities';
  readonly order = 35;

  private battle!: BattleSystem;
  private ctx!: EngineContext;
  private states = new Map<number, AbilityState[]>();

  lastCostMs = 0;

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.battle = ctx.get<BattleSystem>('battle');
    ctx.events.on('orderIssued', (o) => {
      if (o.kind !== 'ability' || !o.ability) return;
      for (const id of o.unitIds) {
        const u = this.battle.unitById(id);
        if (u) this.request(u, o.ability);
      }
    });
  }

  private statesOf(u: UnitGroupState): AbilityState[] {
    let list = this.states.get(u.id);
    if (!list) {
      list = [];
      for (const id of this.battle.typeOf(u).abilities) {
        const def = ABILITIES[id];
        if (!def) continue;
        list.push({
          id,
          // Passives are always on; the two toggles start engaged, which is how
          // Total War ships missile units: shooting unless told otherwise.
          active: def.mode === 'passive' || def.mode === 'toggle',
          left: def.mode === 'timed' ? 0 : Infinity,
          cooldown: 0,
          restoreFormation: u.formationId,
        });
      }
      this.states.set(u.id, list);
    }
    return list;
  }

  // -------------------------------------------------------------------------

  fixedUpdate(dt: number, ctx: EngineContext): void {
    const t0 = performance.now();
    const units = this.battle.units;

    // Pass 1: expire, tick cooldowns, decide auto-activations.
    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (u.destroyed) continue;
      const list = this.statesOf(u);
      for (let a = 0; a < list.length; a++) {
        const st = list[a];
        const def = ABILITIES[st.id];
        if (st.cooldown > 0) st.cooldown = Math.max(0, st.cooldown - dt);
        if (def.mode === 'timed' && st.active) {
          st.left -= dt;
          if (st.left <= 0) this.deactivate(u, st);
        }
        if (!st.active && def.mode === 'timed' && st.cooldown <= 0 && this.shouldAuto(u, st.id)) {
          this.activate(u, st);
        } else if (st.active && def.mode === 'timed' && this.shouldCancel(u, st.id)) {
          this.deactivate(u, st);
        }
      }
    }

    // Pass 2: rebuild every unit's modifiers from scratch.
    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (u.destroyed) continue;
      const mods = modsOf(u.id);
      clearMods(mods);
      const list = this.statesOf(u);
      for (let a = 0; a < list.length; a++) {
        const st = list[a];
        if (st.active) this.applyOwn(u, st.id, mods);
      }
    }

    // Pass 3: auras, which write into *other* units' modifiers.
    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (u.destroyed || u.order === UnitOrder.Rout) continue;
      const list = this.statesOf(u);
      for (let a = 0; a < list.length; a++) {
        if (list[a].active && list[a].id === 'inspire') this.applyInspire(u);
      }
    }

    // Pass 4: behavioural abilities that move the unit rather than change its stats.
    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (u.destroyed) continue;
      if (modsOf(u.id).skirmishing) this.runSkirmish(u);
    }

    void ctx;
    this.lastCostMs = performance.now() - t0;
  }

  // -------------------------------------------------------------------------
  // Activation
  // -------------------------------------------------------------------------

  /** Player or AI request. Toggles flip; timed abilities fire if off cooldown. */
  request(u: UnitGroupState, abilityId: string): boolean {
    const def = ABILITIES[abilityId];
    if (!def) return false;
    const list = this.statesOf(u);
    for (let a = 0; a < list.length; a++) {
      const st = list[a];
      if (st.id !== abilityId) continue;
      if (def.mode === 'toggle') {
        st.active = !st.active;
        this.ctx.events.emit('abilityActivated', {
          unitId: u.id, ability: abilityId, active: st.active,
        });
        return true;
      }
      if (def.mode === 'passive' || st.active || st.cooldown > 0) return false;
      this.activate(u, st);
      return true;
    }
    return false;
  }

  private activate(u: UnitGroupState, st: AbilityState): void {
    const def = ABILITIES[st.id];
    st.active = true;
    st.left = def.duration;
    st.cooldown = def.cooldown + def.duration;
    const mods = modsOf(u.id);

    switch (st.id) {
      case 'testudo': {
        st.restoreFormation = u.formationId;
        this.battle.setFormation(u, 'testudo');
        break;
      }
      case 'pilum-volley':
      case 'framea-volley': {
        // One commanded volley, thrown together and harder than a ragged one.
        mods.orderedVolleys += 1;
        break;
      }
      case 'charge': {
        u.running = true;
        u.chargeTimer = 4;
        break;
      }
      case 'warcry': {
        // The cry itself lands on the enemy once, not continuously.
        const units = this.battle.units;
        for (let k = 0; k < units.length; k++) {
          const o = units[k];
          if (o.destroyed || o.faction === u.faction || o.alive === 0) continue;
          const d = Math.hypot(o.x - u.x, o.z - u.z);
          if (d > WARCRY_RANGE) continue;
          const odef = this.battle.typeOf(o);
          o.morale = Math.max(
            0,
            o.morale - (WARCRY_SHOCK * (1 - d / WARCRY_RANGE)) / Math.max(0.4, odef.discipline)
          );
        }
        this.ctx.events.emit('playSound', {
          id: FACTIONS[u.faction].warCrySound, x: u.x, y: this.battle.groundAt(u.x, u.z), z: u.z, volume: 1,
        });
        break;
      }
    }

    if (def.sound) {
      this.ctx.events.emit('playSound', {
        id: def.sound, x: u.x, y: this.battle.groundAt(u.x, u.z), z: u.z, volume: 0.8,
      });
    }
    this.ctx.events.emit('abilityActivated', { unitId: u.id, ability: st.id, active: true });
  }

  private deactivate(u: UnitGroupState, st: AbilityState): void {
    if (!st.active) return;
    st.active = false;
    st.left = 0;
    if (st.id === 'testudo') {
      this.battle.setFormation(u, st.restoreFormation);
    }
    this.ctx.events.emit('abilityExpired', { unitId: u.id, ability: st.id });
  }

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  private applyOwn(u: UnitGroupState, id: string, mods: UnitMods): void {
    switch (id) {
      case 'unbreakable':
        mods.unbreakable = true;
        break;
      case 'fire-at-will':
        mods.fireAtWill = true;
        break;
      case 'skirmish-mode':
        mods.skirmishing = true;
        break;
      case 'brace':
        // Spears set, shields grounded, nobody takes a step. Attack suffers.
        mods.braced = true;
        mods.shield *= 1.25;
        mods.defence *= 1.12;
        mods.attack *= 0.85;
        mods.moraleBonus += 5;
        break;
      case 'frenzy':
        // All offence, no guard, and past caring about the odds.
        mods.attack *= 1.25;
        mods.damage *= 1.2;
        mods.defence *= 0.75;
        mods.moraleResist *= 2;
        break;
      case 'warcry':
        mods.attack *= 1.12;
        mods.moraleBonus += 10;
        break;
      case 'arrow-storm':
        // Draw and loose as fast as the arms allow; aim suffers badly.
        mods.missileRate *= 2.2;
        mods.missileSpread *= 1.45;
        break;
      case 'charge':
        mods.charge *= 1.4;
        mods.attack *= 1.08;
        break;
      case 'pilum-volley':
      case 'framea-volley':
        mods.tightVolley = true;
        mods.volleyPower = 1.25;
        break;
      case 'testudo':
        // The formation itself carries the shield and missile modifiers.
        mods.moraleBonus += 4;
        break;
      case 'inspire':
        mods.moraleRegen += 2;
        break;
    }
  }

  private applyInspire(u: UnitGroupState): void {
    const units = this.battle.units;
    for (let k = 0; k < units.length; k++) {
      const o = units[k];
      if (o.destroyed || o.faction !== u.faction || o.alive === 0) continue;
      const d = Math.hypot(o.x - u.x, o.z - u.z);
      if (d > INSPIRE_RANGE) continue;
      const near = 1 - d / INSPIRE_RANGE;
      const m = modsOf(o.id);
      m.moraleRegen += 5 * near;
      m.moraleResist *= 1 + 0.3 * near;
    }
  }

  /**
   * Skirmishers exist to throw and run. When anything with a sword closes inside
   * `SKIRMISH_STANDOFF` they fall back, and they stop falling back once they have
   * bought themselves room again.
   */
  private runSkirmish(u: UnitGroupState): void {
    if (u.order === UnitOrder.Rout) return;
    const s = signalsOf(u.id);
    const b = this.battle;
    if (s.nearestEnemy < SKIRMISH_STANDOFF) {
      let ex = 0;
      let ez = 0;
      const units = b.units;
      for (let k = 0; k < units.length; k++) {
        const o = units[k];
        if (o.destroyed || o.faction === u.faction || o.alive === 0) continue;
        const dx = o.x - u.x;
        const dz = o.z - u.z;
        const d = Math.hypot(dx, dz);
        if (d > 70) continue;
        const w = 1 / Math.max(8, d);
        ex += dx * w;
        ez += dz * w;
      }
      const l = Math.hypot(ex, ez) || 1;
      u.order = UnitOrder.MoveTo;
      u.running = true;
      u.waypoints.length = 0;
      u.targetX = u.x - (ex / l) * SKIRMISH_FALLBACK;
      u.targetZ = u.z - (ez / l) * SKIRMISH_FALLBACK;
      // Keep facing the enemy while backing off, so they can still throw.
      u.targetFacing = Math.atan2(ex / l, ez / l);
    } else if (u.order === UnitOrder.MoveTo && s.nearestEnemy > SKIRMISH_FALLBACK * 0.85) {
      u.order = UnitOrder.Hold;
      u.targetX = u.x;
      u.targetZ = u.z;
    }
  }

  // -------------------------------------------------------------------------
  // Auto-use heuristics
  // -------------------------------------------------------------------------

  private shouldAuto(u: UnitGroupState, id: string): boolean {
    if (u.order === UnitOrder.Rout || u.alive === 0) return false;
    const b = this.battle;
    const def = b.typeOf(u);
    const s = signalsOf(u.id);

    switch (id) {
      case 'testudo':
        // Shields up under a rain of arrows, but never with the enemy line arriving.
        return s.missilePulse > 2.5 && s.nearestEnemy > 34 && !s.contactLock;
      case 'pilum-volley':
      case 'framea-volley': {
        const m = def.missile;
        if (!m || u.ammo === 0) return false;
        return s.nearestEnemy < m.range * 0.9 && s.nearestEnemy > 7 && !s.contactLock;
      }
      case 'inspire': {
        if (s.contactSeconds > 6) return true;
        const units = b.units;
        for (let k = 0; k < units.length; k++) {
          const o = units[k];
          if (o.destroyed || o.faction !== u.faction || o.id === u.id) continue;
          if (signalsOf(o.id).band === 0) continue;
          if (Math.hypot(o.x - u.x, o.z - u.z) < INSPIRE_RANGE) return true;
        }
        return false;
      }
      case 'brace': {
        if (s.contactLock && s.cavalryPressure > 0.15) return true;
        // Set the spears before the horses arrive, not after.
        const units = b.units;
        for (let k = 0; k < units.length; k++) {
          const o = units[k];
          if (o.destroyed || o.faction === u.faction || o.alive === 0) continue;
          if (!isCavalry(b.typeOf(o))) continue;
          if (Math.hypot(o.x - u.x, o.z - u.z) < 48) return true;
        }
        return false;
      }
      case 'arrow-storm': {
        const m = def.missile;
        if (!m) return false;
        return s.nearestEnemy < m.range * 0.72 && u.ammo > m.ammo * 0.45 && !s.contactLock;
      }
      case 'charge':
        return s.nearestEnemy < 62 && s.nearestEnemy > 14 && !s.contactLock;
      case 'warcry':
        return s.nearestEnemy < 72;
      case 'frenzy':
        return s.contactLock || s.nearestEnemy < 16;
      default:
        return false;
    }
  }

  private shouldCancel(u: UnitGroupState, id: string): boolean {
    const s = signalsOf(u.id);
    switch (id) {
      case 'testudo':
        // The tortoise cannot fight; break it open before the line lands.
        return s.nearestEnemy < 24 || s.contactLock;
      case 'brace':
        return s.contactLock && s.cavalryPressure < 0.02 && s.contactSeconds > 6;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Read API for the HUD
  // -------------------------------------------------------------------------

  /** Ability ids currently in effect on a unit. Allocates — UI use only. */
  activeOn(unitId: number): string[] {
    const u = this.battle.unitById(unitId);
    if (!u) return [];
    const out: string[] = [];
    for (const st of this.statesOf(u)) if (st.active) out.push(st.id);
    return out;
  }

  /** 0 = ready, 1 = just used. For drawing a cooldown sweep on the unit card. */
  cooldownFraction(unitId: number, abilityId: string): number {
    const u = this.battle.unitById(unitId);
    const def = ABILITIES[abilityId];
    if (!u || !def) return 0;
    for (const st of this.statesOf(u)) {
      if (st.id === abilityId) {
        const total = def.cooldown + def.duration;
        return total > 0 ? clamp01(st.cooldown / total) : 0;
      }
    }
    return 0;
  }
}
