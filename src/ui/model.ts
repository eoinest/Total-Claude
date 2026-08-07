/**
 * The HUD's read model.
 *
 * Panels never walk the soldier pool themselves. Once every 100 ms this builds one
 * digest per unit — the handful of derived numbers the cards, banners and minimap all
 * want — and every panel renders from that. One pass over the army instead of six, and
 * a single place where "is this unit in melee" is defined.
 */

import { ranksFor } from '../sim/formations';
import type { BattleSystem } from '../sim/BattleSystem';
import {
  Faction, SoldierState, UnitOrder,
  type UnitGroupState, type UnitTypeDef,
} from '../sim/types';
import { moraleStateOf, PLAYER_FACTION, type MoraleState, type Phase } from './theme';

const ROMAN_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

export interface UnitView {
  id: number;
  unit: UnitGroupState;
  def: UnitTypeDef;
  faction: Faction;
  /** "Legionary Cohort II" — the roster name plus an ordinal when there is more than one. */
  title: string;
  /** Just the ordinal — "II", or '' when the type is unique. Compact cards show only this. */
  ordinal: string;
  alive: number;
  initial: number;
  strengthFrac: number;
  moraleFrac: number;
  morale: MoraleState;
  fatigue: number;
  ammoFrac: number;
  hasMissiles: boolean;
  engaged: boolean;
  /** Men currently locked in melee. */
  fighting: number;
  charging: boolean;
  braced: boolean;
  routing: boolean;
  shooting: boolean;
  destroyed: boolean;
  kills: number;
  order: UnitOrder;
  /**
   * Centre of the block in world space, plus ground height — the minimap, the selection
   * marker and camera-snap use it.
   *
   * This is the formation *rectangle's* centre, which is where the unit is supposed to be
   * rather than where its men actually are. It is deliberately not what the banners use:
   * a routing unit's men scatter over a hundred metres while this keeps marching, and a
   * digest refreshed at 10 Hz cannot follow a block that changes shape inside one tick.
   * `Banners` samples the pool per frame instead.
   */
  cx: number;
  cy: number;
  cz: number;
  frontage: number;
  depth: number;
  /** True while the player owns this unit and may give it orders. */
  own: boolean;
}

export class HudModel {
  readonly views: UnitView[] = [];
  private byId = new Map<number, UnitView>();

  /** Unit ids currently selected, in click order. */
  selection: number[] = [];
  hoveredId = -1;

  strength: Record<number, number> = { 0: 0, 1: 0 };
  initialStrength: Record<number, number> = { 0: 0, 1: 0 };
  routing: Record<number, number> = { 0: 0, 1: 0 };
  unitsLeft: Record<number, number> = { 0: 0, 1: 0 };
  kills: Record<number, number> = { 0: 0, 1: 0 };
  engagedCount = 0;
  /** Closest approach between the two armies, in metres. */
  lineGap = Infinity;
  phase: Phase = 'deployment';
  over = false;
  victor: Faction | -1 = -1;

  /**
   * Bumped whenever the unit list itself changes. Panels compare it to know when their
   * DOM needs rebuilding — the army is deployed after every subsystem has initialised,
   * so the HUD always starts with an empty roster and fills in on the first frame.
   */
  generation = 0;

  private labelled = false;

  view(id: number): UnitView | undefined {
    return this.byId.get(id);
  }

  get selectedViews(): UnitView[] {
    const out: UnitView[] = [];
    for (const id of this.selection) {
      const v = this.byId.get(id);
      if (v && !v.destroyed) out.push(v);
    }
    return out;
  }

  isSelected(id: number): boolean {
    return this.selection.includes(id);
  }

  /** Drop dead units from the selection; returns true if it changed. */
  pruneSelection(): boolean {
    const before = this.selection.length;
    this.selection = this.selection.filter((id) => {
      const v = this.byId.get(id);
      return v !== undefined && !v.destroyed;
    });
    return this.selection.length !== before;
  }

  refresh(battle: BattleSystem, simTime: number): void {
    const pool = battle.pool;

    if (this.staleViews(battle)) this.rebuild(battle);

    this.strength[Faction.Rome] = 0;
    this.strength[Faction.Germanic] = 0;
    this.routing[Faction.Rome] = 0;
    this.routing[Faction.Germanic] = 0;
    this.unitsLeft[Faction.Rome] = 0;
    this.unitsLeft[Faction.Germanic] = 0;
    this.kills[Faction.Rome] = 0;
    this.kills[Faction.Germanic] = 0;
    this.engagedCount = 0;

    for (const v of this.views) {
      const u = v.unit;
      v.alive = u.alive;
      v.destroyed = u.destroyed;
      v.strengthFrac = v.initial > 0 ? u.alive / v.initial : 0;
      v.moraleFrac = u.maxMorale > 0 ? Math.max(0, Math.min(1, u.morale / u.maxMorale)) : 0;
      v.morale = moraleStateOf(u);
      v.fatigue = Math.max(0, Math.min(1, u.fatigue));
      v.ammoFrac = v.hasMissiles ? Math.max(0, Math.min(1, u.ammo / (v.def.missile?.ammo ?? 1))) : 0;
      v.engaged = u.engaged;
      v.routing = u.order === UnitOrder.Rout;
      v.charging = u.chargeTimer > 0;
      v.kills = u.kills;
      v.order = u.order;

      let fighting = 0;
      let bracing = 0;
      let shooting = 0;
      if (!u.destroyed) {
        for (let k = 0; k < u.members.length; k++) {
          const st = pool.state[u.members[k]];
          if (st === SoldierState.Fighting) fighting++;
          else if (st === SoldierState.Bracing) bracing++;
          else if (st === SoldierState.Shooting || st === SoldierState.Throwing) shooting++;
        }
      }
      v.fighting = fighting;
      v.braced = bracing > u.members.length * 0.3;
      v.shooting = shooting > 0;

      const ranks = ranksFor(Math.max(1, u.alive), u.width);
      v.frontage = Math.max(2, u.width * u.spacingX);
      v.depth = Math.max(1.4, (ranks - 1) * u.spacingZ + 1.3);
      const s = Math.sin(u.facing);
      const c = Math.cos(u.facing);
      v.cx = u.x - s * v.depth * 0.5;
      v.cz = u.z - c * v.depth * 0.5;
      v.cy = battle.groundAt(v.cx, v.cz);

      if (!u.destroyed) {
        this.strength[u.faction] += u.alive;
        this.unitsLeft[u.faction]++;
        if (v.routing) this.routing[u.faction]++;
        if (v.engaged) this.engagedCount++;
      }
      this.kills[u.faction] += u.kills;
    }

    this.lineGap = this.closestApproach();
    this.phase = this.derivePhase(simTime);
  }

  /**
   * Whether the view list still describes the army.
   *
   * This tested `views.length !== battle.units.length`, which is true for every way a unit
   * could leave the field *in a battle* — men die, units are destroyed, the list only
   * shrinks. The deployment phase can swap one unit for another in a single frame (taking a
   * garrison off the wall retires it and stands a new one on the grass), and the length is
   * then unchanged: the card bar kept a phantom card for the unit that had gone, had none
   * for the one that had arrived, and any selection of the new unit was pruned on the next
   * tick because it had no view. Comparing identities is forty reference compares at 10 Hz.
   */
  private staleViews(battle: BattleSystem): boolean {
    if (this.views.length !== battle.units.length) return true;
    for (let i = 0; i < this.views.length; i++) {
      if (this.views[i].unit !== battle.units[i]) return true;
    }
    return false;
  }

  private rebuild(battle: BattleSystem): void {
    this.generation++;
    this.views.length = 0;
    this.byId.clear();
    const seen = new Map<string, number>();
    const total = new Map<string, number>();
    for (const u of battle.units) total.set(u.typeId, (total.get(u.typeId) ?? 0) + 1);

    for (const u of battle.units) {
      const def = battle.typeOf(u);
      const n = (seen.get(u.typeId) ?? 0) + 1;
      seen.set(u.typeId, n);
      const many = (total.get(u.typeId) ?? 1) > 1;
      const ordinal = many ? String(ROMAN_NUMERALS[n - 1] ?? n) : '';
      const v: UnitView = {
        id: u.id,
        unit: u,
        def,
        faction: u.faction,
        title: ordinal ? `${def.name} ${ordinal}` : def.name,
        ordinal,
        alive: u.alive,
        initial: u.initialStrength || def.strength,
        strengthFrac: 1,
        moraleFrac: 1,
        morale: 'steady',
        fatigue: 0,
        ammoFrac: 1,
        hasMissiles: !!def.missile,
        engaged: false,
        fighting: 0,
        charging: false,
        braced: false,
        routing: false,
        shooting: false,
        destroyed: false,
        kills: 0,
        order: u.order,
        cx: u.x,
        cy: 0,
        cz: u.z,
        frontage: u.width * u.spacingX,
        depth: 4,
        own: u.faction === PLAYER_FACTION,
      };
      this.views.push(v);
      this.byId.set(u.id, v);
    }

    if (!this.labelled && this.views.length > 0) {
      this.initialStrength[Faction.Rome] = 0;
      this.initialStrength[Faction.Germanic] = 0;
      for (const v of this.views) this.initialStrength[v.faction] += v.initial;
      this.labelled = true;
    }

    /*
     * Re-assert the highlight, because `SelectionController.commit` writes `unit.selected`
     * *through the views* and a unit can be selected before it has one. The deployment phase
     * does exactly that when it rebuilds a unit: the replacement is put into the selection in
     * the same frame it is created, one tick before this list knows about it.
     */
    for (const v of this.views) v.unit.selected = this.selection.includes(v.id);
  }

  /** Nearest distance between any two opposing units' centres. */
  private closestApproach(): number {
    let best = Infinity;
    for (const a of this.views) {
      if (a.destroyed || a.faction !== Faction.Rome || a.routing) continue;
      for (const b of this.views) {
        if (b.destroyed || b.faction !== Faction.Germanic || b.routing) continue;
        const d = Math.hypot(a.cx - b.cx, a.cz - b.cz) - (a.depth + b.depth) * 0.5;
        if (d < best) best = d;
      }
    }
    return best;
  }

  private derivePhase(simTime: number): Phase {
    if (this.over) return 'aftermath';
    const rTotal = Math.max(1, this.unitsLeft[Faction.Rome] + this.routing[Faction.Rome]);
    const gTotal = Math.max(1, this.unitsLeft[Faction.Germanic] + this.routing[Faction.Germanic]);
    const broken =
      this.routing[Faction.Rome] / rTotal > 0.34 || this.routing[Faction.Germanic] / gTotal > 0.34;
    if (broken) return 'rout';
    if (this.engagedCount > 0) return 'clash';
    // 165 m is the longest bow range in the roster, so inside it arrows are already flying.
    if (this.lineGap < 165) return 'skirmish';
    if (simTime < 6) return 'deployment';
    return 'advance';
  }
}
