import type { BattleSystem } from '../sim/BattleSystem';
import { ALL_FACTIONS, Faction, UnitOrder, type UnitGroupState, type UnitTypeDef, type UnitClass } from '../sim/types';
import { angleDelta } from '../util/math';
import { footprintOf, type PathfindingSystem } from './Pathfinding';
import {
  combatPower, defensivePower, isCavalryClass, isMissileClass, matchup, missileValue,
  type UnitCommand,
} from './types';

/**
 * The AI blackboard.
 *
 * Both the tactical and the general layer need the same derived facts every tick —
 * who is in contact, who is closing, where the enemy line is thin. Computing them once
 * here and reading them twice is the difference between a 0.3 ms AI and a 3 ms one,
 * and it guarantees the two layers never disagree about the state of the battle.
 *
 * `refresh()` is idempotent within a tick: whichever system runs first pays for it.
 *
 * Perception is deliberately indirect. A faction sees an enemy unit only if it is not
 * `concealed`, or if one of its own units is close enough to spot it anyway, and it
 * remembers where it last saw things. Every difficulty level reads this same fogged
 * view — the AI is made better by thinking better, never by seeing more.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** A concealed unit is spotted anyway inside this range. */
const SPOT_RANGE = 70;
/** Front ranks this close are shoving at each other, whatever the combat system says. */
const CONTACT_RANGE = 7;
/**
 * Enemies beyond this are situational awareness, not a threat. It has to exceed the
 * distance between the two deployment lines (320 m on this field) or the generals begin
 * the battle believing the enemy does not exist.
 */
const THREAT_RANGE = 360;
/** Bearing off our own front beyond which an enemy counts as a flank threat. */
const FLANK_ANGLE = Math.PI * 0.36; // 65 degrees
/** Forget a unit we have not seen for this long. */
const MEMORY_TTL = 600; // ticks (20 s)

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface PerceivedEnemy {
  unitId: number;
  typeId: string;
  unitClass: UnitClass;
  /** Last known formation anchor. */
  x: number;
  z: number;
  facing: number;
  alive: number;
  morale: number;
  maxMorale: number;
  routing: boolean;
  /** Half-frontage in metres at the time it was seen. */
  halfFront: number;
  power: number;
  defence: number;
  shootValue: number;
  /** In line of sight right now. */
  visible: boolean;
  seenTick: number;
}

export interface UnitInfo {
  unitId: number;
  faction: Faction;
  unit: UnitGroupState;
  def: UnitTypeDef;
  halfFront: number;
  minHalfFront: number;
  power: number;

  /** Contact detected geometrically — does not depend on the combat subsystem. */
  inContact: boolean;
  contactEnemyId: number;
  contactCount: number;
  nearestEnemyId: number;
  nearestEnemyDist: number;
  /**
   * Nearest enemy *line* unit. Kept separate because a javelin screen 40 m in front of
   * an army is not the army: an advance that halts because it has met the screen has
   * been stopped by a hundred boys with throwing spears.
   */
  nearestLineEnemyDist: number;
  /** Nearest enemy that is *closing* rather than standing. */
  closingEnemyId: number;
  closingDist: number;

  /** Weighted enemy power bearing down on us. */
  threat: number;
  /** The part of it arriving off a flank or the rear. */
  flankThreat: number;
  /** Bearing of the worst flank threat, or NaN. */
  flankBearing: number;
  /**
   * Weight of the strongest flanking threat seen this tick, so `flankBearing` can be the
   * bearing of the *worst* one rather than of whichever enemy the iterator happened to
   * visit last. Reset every tick alongside `flankBearing`.
   */
  flankWorst: number;
  /** Enemy missile weight that can currently reach us. */
  missilePressure: number;

  /** Distance to the friendly line unit immediately left/right along the line. */
  leftGap: number;
  rightGap: number;
  leftNeighbour: number;
  rightNeighbour: number;

  /** Metres of height held over the ground 26 m ahead. Positive = fighting downhill. */
  heightEdge: number;
  /** True if standing in the river margin or on ground too steep to fight on. */
  badGround: boolean;
}

export interface FactionView {
  faction: Faction;
  /** Non-destroyed, non-routing units. */
  fighting: UnitGroupState[];
  routing: number;
  men: number;
  initialMen: number;
  power: number;
  initialPower: number;
  /** Centre of mass of the infantry line. */
  lineX: number;
  lineZ: number;
  /** Mean facing of the line, radians. */
  lineFacing: number;
  /** Extremes of the infantry line along its own lateral axis. */
  leftEndX: number;
  rightEndX: number;
  /** Perceived enemy units, live view plus memory. */
  seen: Map<number, PerceivedEnemy>;
  /** Combat power of the enemy units we can actually see. Never the true total. */
  seenPower: number;
  /** Visible enemy units still fighting. */
  seenFighting: number;
  /** High-water mark of distinct enemy units we have ever identified. */
  seenKnown: number;
  /** Enemy unit judged weakest in the line, or -1. */
  weakestEnemyId: number;
  /** Widest gap between adjacent enemy line units: the seam to aim at. */
  seamX: number;
  seamZ: number;
  seamWidth: number;
  /** Enemies we can see that are broken and running. */
  routingEnemies: number;
  /** True while more than a third of our fighting units are in contact. */
  linesJoined: boolean;
  contactCount: number;
  /**
   * Closest our own battle line has got to theirs, in metres — measured from the
   * troops, not from the plan. The plan can say anything; this is where the men are.
   */
  closestEnemy: number;
}

// ---------------------------------------------------------------------------
// Scratch
// ---------------------------------------------------------------------------

const SEG_A = { x1: 0, z1: 0, x2: 0, z2: 0 };
const SEG_B = { x1: 0, z1: 0, x2: 0, z2: 0 };
const LINE_SORT: UnitGroupState[] = [];

/** Squared distance from point P to segment AB. */
const pointSegDist2 = (px: number, pz: number, ax: number, az: number, bx: number, bz: number): number => {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = 0;
  if (len2 > 1e-9) {
    t = ((px - ax) * abx + (pz - az) * abz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const dx = px - (ax + abx * t);
  const dz = pz - (az + abz * t);
  return dx * dx + dz * dz;
};

/**
 * Distance between two segments. Two front ranks are segments, not points: a cohort
 * 22 m wide standing alongside another is *in contact* even though the anchors are
 * 20 m apart, and the point-to-point test would miss it.
 */
const segSegDist = (
  a: { x1: number; z1: number; x2: number; z2: number },
  b: { x1: number; z1: number; x2: number; z2: number }
): number => {
  // Proper intersection test first — crossed segments are at zero distance.
  const d1x = a.x2 - a.x1;
  const d1z = a.z2 - a.z1;
  const d2x = b.x2 - b.x1;
  const d2z = b.z2 - b.z1;
  const denom = d1x * d2z - d1z * d2x;
  if (Math.abs(denom) > 1e-9) {
    const sx = b.x1 - a.x1;
    const sz = b.z1 - a.z1;
    const t = (sx * d2z - sz * d2x) / denom;
    const s = (sx * d1z - sz * d1x) / denom;
    if (t >= 0 && t <= 1 && s >= 0 && s <= 1) return 0;
  }
  let best = pointSegDist2(a.x1, a.z1, b.x1, b.z1, b.x2, b.z2);
  best = Math.min(best, pointSegDist2(a.x2, a.z2, b.x1, b.z1, b.x2, b.z2));
  best = Math.min(best, pointSegDist2(b.x1, b.z1, a.x1, a.z1, a.x2, a.z2));
  best = Math.min(best, pointSegDist2(b.x2, b.z2, a.x1, a.z1, a.x2, a.z2));
  return Math.sqrt(best);
};

/** Write a unit's front-rank segment into `out`. */
const frontSegment = (
  u: UnitGroupState,
  halfFront: number,
  out: { x1: number; z1: number; x2: number; z2: number }
): void => {
  // The unit's right-hand vector: facing rotated +90 degrees.
  const rx = Math.cos(u.facing);
  const rz = -Math.sin(u.facing);
  out.x1 = u.x - rx * halfFront;
  out.z1 = u.z - rz * halfFront;
  out.x2 = u.x + rx * halfFront;
  out.z2 = u.z + rz * halfFront;
};

/** Is this unit part of the shield line, as opposed to a screen or a wing? */
export const isLineUnit = (c: UnitClass): boolean =>
  c === 'heavy-infantry' || c === 'spear-infantry' || c === 'shock-infantry' || c === 'light-infantry';

// ---------------------------------------------------------------------------
// The blackboard
// ---------------------------------------------------------------------------

export class AIWorld {
  battle!: BattleSystem;
  nav!: PathfindingSystem;
  tick = 0;
  simTime = 0;

  readonly info = new Map<number, UnitInfo>();
  readonly views = new Map<Faction, FactionView>();
  /** The general's standing instruction per unit; written by GeneralAI, read by TacticalAI. */
  readonly commands = new Map<number, UnitCommand>();

  private lastRefresh = -1;

  attach(battle: BattleSystem, nav: PathfindingSystem): void {
    this.battle = battle;
    this.nav = nav;
    // Every faction the roster knows, not the two this file used to name. A third side
    // landed and `view()` laundered the missing entry through a non-null assertion, so the
    // first tick a Carthaginian unit existed threw "Cannot read properties of undefined
    // (reading 'seen')" out of `buildThreats`.
    for (const f of ALL_FACTIONS) this.views.set(f, this.blankView(f));
  }

  private blankView(f: Faction): FactionView {
    return {
      faction: f, fighting: [], routing: 0, men: 0, initialMen: 0,
      power: 0, initialPower: 0,
      lineX: 0, lineZ: 0, lineFacing: 0, leftEndX: 0, rightEndX: 0,
      seen: new Map(), seenPower: 0, seenFighting: 0, seenKnown: 0,
      weakestEnemyId: -1,
      seamX: 0, seamZ: 0, seamWidth: 0,
      routingEnemies: 0, linesJoined: false, contactCount: 0,
      closestEnemy: Infinity,
    };
  }

  /**
   * A faction's view, created on demand.
   *
   * The lazy branch is not defensive padding: a scenario may field a faction the roster did
   * not list, and returning a blank view is enormously better than the non-null assertion
   * that used to stand here, which turned an unlisted faction into a crash three call
   * levels away in `buildThreats`.
   */
  /**
   * Factions with anything left on the field, plus any the roster declares.
   *
   * Derived rather than hard-coded so a scenario that fields two of three sides does not
   * pay for the third, and one that fields a fourth is not silently ignored. Iterated in
   * `ALL_FACTIONS` order and then by numeric id, so the sequence is stable across runs —
   * this feeds `fixedUpdate`, and a Set's insertion order would depend on spawn order.
   */
  private activeFactions(): Faction[] {
    const out: Faction[] = [];
    for (const f of ALL_FACTIONS) if (this.views.has(f)) out.push(f);
    const extra: Faction[] = [];
    for (const f of this.views.keys()) if (!out.includes(f)) extra.push(f);
    extra.sort((a, b) => a - b);
    return out.concat(extra);
  }

  view(f: Faction): FactionView {
    let v = this.views.get(f);
    if (!v) {
      v = this.blankView(f);
      this.views.set(f, v);
    }
    return v;
  }

  infoOf(unitId: number): UnitInfo | undefined {
    return this.info.get(unitId);
  }

  commandOf(unitId: number): UnitCommand | undefined {
    return this.commands.get(unitId);
  }

  /** Rebuild every derived fact. Safe to call from more than one system per tick. */
  refresh(tick: number, simTime: number): void {
    if (tick === this.lastRefresh) return;
    this.lastRefresh = tick;
    this.tick = tick;
    this.simTime = simTime;

    this.buildUnitInfo();
    this.buildFactionViews();
    // One pass per faction, each seeing everyone who is not itself. With two sides this is
    // the pair of calls it replaces; with three it is the only formulation that does not
    // silently omit a matchup.
    for (const f of this.activeFactions()) this.buildPerception(f);
    this.buildThreats();
    for (const f of this.activeFactions()) this.buildWeakPoints(f);
  }

  // -------------------------------------------------------------------------
  // Per-unit facts
  // -------------------------------------------------------------------------

  private buildUnitInfo(): void {
    const battle = this.battle;
    // Reuse the info records; only drop them when a unit leaves the field for good.
    for (const [id, rec] of this.info) {
      if (rec.unit.destroyed) this.info.delete(id);
    }

    for (const u of battle.units) {
      if (u.destroyed) continue;
      const def = battle.typeOf(u);
      const fp = footprintOf(u, def);
      let rec = this.info.get(u.id);
      if (!rec) {
        rec = {
          unitId: u.id, faction: u.faction, unit: u, def,
          halfFront: fp.max, minHalfFront: fp.min, power: 0,
          inContact: false, contactEnemyId: -1, contactCount: 0,
          nearestEnemyId: -1, nearestEnemyDist: Infinity, nearestLineEnemyDist: Infinity,
          closingEnemyId: -1, closingDist: Infinity,
          threat: 0, flankThreat: 0, flankBearing: NaN, flankWorst: 0, missilePressure: 0,
          leftGap: Infinity, rightGap: Infinity, leftNeighbour: -1, rightNeighbour: -1,
          heightEdge: 0, badGround: false,
        };
        this.info.set(u.id, rec);
      }
      rec.unit = u;
      rec.def = def;
      rec.halfFront = fp.max;
      rec.minHalfFront = fp.min;
      rec.power = combatPower(u, def);
      rec.inContact = false;
      rec.contactEnemyId = -1;
      rec.contactCount = 0;
      rec.nearestEnemyId = -1;
      rec.nearestEnemyDist = Infinity;
      rec.nearestLineEnemyDist = Infinity;
      rec.closingEnemyId = -1;
      rec.closingDist = Infinity;
      rec.threat = 0;
      rec.flankThreat = 0;
      rec.flankBearing = NaN;
      rec.flankWorst = 0;
      rec.missilePressure = 0;
      rec.leftGap = Infinity;
      rec.rightGap = Infinity;
      rec.leftNeighbour = -1;
      rec.rightNeighbour = -1;
      rec.heightEdge = this.nav.heightAdvantage(u.x, u.z, u.facing);
      rec.badGround = this.nav.isWater(u.x, u.z) || this.nav.slopeAt(u.x, u.z) > 0.42;
    }
  }

  private buildFactionViews(): void {
    for (const f of this.activeFactions()) {
      const v = this.view(f);
      v.fighting.length = 0;
      v.routing = 0;
      v.men = 0;
      v.initialMen = 0;
      v.power = 0;
      v.initialPower = 0;
      v.contactCount = 0;

      let sx = 0;
      let sz = 0;
      let sw = 0;
      let fx = 0;
      let fz = 0;
      let left = Infinity;
      let right = -Infinity;

      for (const u of this.battle.units) {
        if (u.faction !== f) continue;
        v.initialMen += u.initialStrength;
        if (u.destroyed) continue;
        v.men += u.alive;
        const rec = this.info.get(u.id);
        if (!rec) continue;
        v.initialPower += rec.power * (u.initialStrength / Math.max(1, u.alive));
        if (u.order === UnitOrder.Rout) {
          v.routing++;
          continue;
        }
        v.fighting.push(u);
        v.power += rec.power;

        if (isLineUnit(rec.def.unitClass)) {
          const w = u.alive;
          sx += u.x * w;
          sz += u.z * w;
          sw += w;
          fx += Math.sin(u.facing) * w;
          fz += Math.cos(u.facing) * w;
          // "Left" and "right" are measured along the unit's own lateral axis, which
          // for both armies here is world X.
          if (u.x - rec.halfFront < left) left = u.x - rec.halfFront;
          if (u.x + rec.halfFront > right) right = u.x + rec.halfFront;
        }
      }

      if (sw > 0) {
        v.lineX = sx / sw;
        v.lineZ = sz / sw;
        v.lineFacing = Math.atan2(fx, fz);
        v.leftEndX = left;
        v.rightEndX = right;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------

  /**
   * What `observer` can see of everyone else.
   *
   * "Everyone who is not me", not "the other side". The two-faction form took a single
   * `target` and filtered `e.faction !== target`, which with a third side on the field
   * meant each observer perceived exactly one of its two enemies and was blind to the
   * other — no threat, no weak point, no reaction.
   */
  private buildPerception(observer: Faction): void {
    const v = this.view(observer);
    const mine = v.fighting;
    v.routingEnemies = 0;
    v.seenPower = 0;
    v.seenFighting = 0;

    for (const e of this.battle.units) {
      if (e.faction === observer) continue;
      const rec = this.info.get(e.id);

      if (e.destroyed) {
        // We only learn a unit is gone once we could have seen it happen.
        const mem = v.seen.get(e.id);
        if (mem && (mem.visible || this.tick - mem.seenTick > MEMORY_TTL)) v.seen.delete(e.id);
        else if (mem) mem.visible = false;
        continue;
      }
      if (!rec) continue;

      let visible = !e.concealed;
      if (!visible) {
        for (const m of mine) {
          if (Math.hypot(m.x - e.x, m.z - e.z) <= SPOT_RANGE) {
            visible = true;
            break;
          }
        }
      }

      let mem = v.seen.get(e.id);
      if (!mem) {
        if (!visible) continue; // never seen it, so it does not exist to us
        mem = {
          unitId: e.id, typeId: e.typeId, unitClass: rec.def.unitClass,
          x: e.x, z: e.z, facing: e.facing,
          alive: e.alive, morale: e.morale, maxMorale: e.maxMorale,
          routing: false, halfFront: rec.halfFront,
          power: 0, defence: 0, shootValue: 0,
          visible: true, seenTick: this.tick,
        };
        v.seen.set(e.id, mem);
      }

      mem.visible = visible;
      if (visible) {
        mem.x = e.x;
        mem.z = e.z;
        mem.facing = e.facing;
        mem.alive = e.alive;
        mem.morale = e.morale;
        mem.routing = e.order === UnitOrder.Rout;
        mem.halfFront = rec.halfFront;
        mem.power = rec.power;
        mem.defence = defensivePower(e, rec.def);
        mem.shootValue = missileValue(e, rec.def);
        mem.seenTick = this.tick;
        if (mem.routing) v.routingEnemies++;
        else {
          v.seenFighting++;
          v.seenPower += mem.power;
        }
      } else if (this.tick - mem.seenTick > MEMORY_TTL) {
        v.seen.delete(e.id);
      }
    }
    // The high-water mark only ever grows: once we have counted an enemy standard on
    // the field, we know it was there even after it has been wiped out.
    if (v.seen.size > v.seenKnown) v.seenKnown = v.seen.size;
  }

  // -------------------------------------------------------------------------
  // Threat and contact
  // -------------------------------------------------------------------------

  private buildThreats(): void {
    const battle = this.battle;

    for (const rec of this.info.values()) {
      const u = rec.unit;
      if (u.order === UnitOrder.Rout) continue;
      const v = this.view(u.faction);
      frontSegment(u, rec.halfFront, SEG_A);

      for (const mem of v.seen.values()) {
        // React only to what we can see or have recently seen — no omniscience.
        const other = battle.unitById(mem.unitId);
        if (!other || other.destroyed) continue;
        const dxc = mem.x - u.x;
        const dzc = mem.z - u.z;
        const centreDist = Math.hypot(dxc, dzc);
        if (centreDist > THREAT_RANGE + rec.halfFront + mem.halfFront) continue;

        frontSegment(other, mem.halfFront, SEG_B);
        // Use last-known position for a unit we cannot see right now.
        if (!mem.visible) {
          const ox = mem.x - other.x;
          const oz = mem.z - other.z;
          SEG_B.x1 += ox; SEG_B.x2 += ox;
          SEG_B.z1 += oz; SEG_B.z2 += oz;
        }
        const gap = segSegDist(SEG_A, SEG_B);

        if (gap < rec.nearestEnemyDist) {
          rec.nearestEnemyDist = gap;
          rec.nearestEnemyId = mem.unitId;
        }
        if (isLineUnit(mem.unitClass) && !mem.routing && gap < rec.nearestLineEnemyDist) {
          rec.nearestLineEnemyDist = gap;
        }
        if (gap <= CONTACT_RANGE && !mem.routing) {
          rec.inContact = true;
          rec.contactCount++;
          if (rec.contactEnemyId < 0) rec.contactEnemyId = mem.unitId;
        }

        // Is it coming for us? Compare its ordered destination with its position.
        const movingAtUs =
          other.order !== UnitOrder.Hold &&
          (other.targetX - mem.x) * dxc * -1 + (other.targetZ - mem.z) * dzc * -1 > 0;
        if (movingAtUs && gap < rec.closingDist) {
          rec.closingDist = gap;
          rec.closingEnemyId = mem.unitId;
        }

        if (!mem.routing) {
          const mu = matchup(mem.unitClass, rec.def.unitClass);
          // Threat falls off with distance: a unit 200 m away is a problem for later.
          const proximity = 1 / (1 + gap / 45);
          const w = mem.power * mu * proximity;
          rec.threat += w;

          const bearing = Math.atan2(dxc, dzc);
          const rel = Math.abs(angleDelta(u.facing, bearing));
          if (rel > FLANK_ANGLE && gap < 150) {
            rec.flankThreat += w;
            // `w` is a product of three positive quantities, so the old `w > 0` test was
            // always true and this reduced to "take the last flanking enemy the iterator
            // visits". RefuseFlank then re-aimed at an unrelated bearing several times a
            // second. Keep the bearing of the strongest threat instead.
            if (Number.isNaN(rec.flankBearing) || w > rec.flankWorst) {
              rec.flankWorst = w;
              rec.flankBearing = bearing;
            }
          }
        }

        // Missile pressure: only counts if they can actually reach us.
        const edef = battle.typeOf(other);
        if (edef.missile && other.ammo > 0 && centreDist <= edef.missile.range) {
          rec.missilePressure +=
            (mem.alive * (edef.missile.damage + edef.missile.apDamage) * edef.missile.rate) / 6000;
        }
      }
    }

    // Line dressing: for each line unit, find the friendly line unit nearest on each
    // side along the line's lateral axis, and the metres of open ground between them.
    for (const f of this.activeFactions()) {
      const v = this.view(f);
      LINE_SORT.length = 0;
      for (const u of v.fighting) {
        const rec = this.info.get(u.id);
        if (rec && isLineUnit(rec.def.unitClass)) LINE_SORT.push(u);
      }
      LINE_SORT.sort((a, b) => a.x - b.x);
      let joined = 0;
      let closest = Infinity;
      for (let i = 0; i < LINE_SORT.length; i++) {
        const u = LINE_SORT[i];
        const rec = this.info.get(u.id)!;
        if (rec.inContact) joined++;
        if (rec.nearestLineEnemyDist < closest) closest = rec.nearestLineEnemyDist;
        if (i > 0) {
          const l = LINE_SORT[i - 1];
          const lrec = this.info.get(l.id)!;
          rec.leftNeighbour = l.id;
          rec.leftGap = u.x - rec.halfFront - (l.x + lrec.halfFront);
        }
        if (i < LINE_SORT.length - 1) {
          const r = LINE_SORT[i + 1];
          const rrec = this.info.get(r.id)!;
          rec.rightNeighbour = r.id;
          rec.rightGap = r.x - rrec.halfFront - (u.x + rec.halfFront);
        }
      }
      v.contactCount = joined;
      v.closestEnemy = closest;
      v.linesJoined = LINE_SORT.length > 0 && joined * 3 >= LINE_SORT.length;
    }
  }

  // -------------------------------------------------------------------------
  // Weak points: the whole basis of concentration of force
  // -------------------------------------------------------------------------

  private buildWeakPoints(observer: Faction): void {
    const v = this.view(observer);
    v.weakestEnemyId = -1;
    v.seamWidth = 0;

    // Only the enemy's shield line is worth attacking — the seam behind an archer
    // screen is not a hole, it is bait.
    LINE_SORT.length = 0;
    let weakest = -1;
    let weakestScore = Infinity;
    for (const mem of v.seen.values()) {
      if (!mem.visible || mem.routing || mem.alive <= 0) continue;
      const u = this.battle.unitById(mem.unitId);
      if (!u || u.destroyed) continue;
      if (!isLineUnit(mem.unitClass)) continue;
      LINE_SORT.push(u);
      if (mem.defence < weakestScore) {
        weakestScore = mem.defence;
        weakest = mem.unitId;
      }
    }
    v.weakestEnemyId = weakest;

    if (LINE_SORT.length < 2) {
      // A single enemy block has no seam; aim at its centre.
      if (LINE_SORT.length === 1) {
        v.seamX = LINE_SORT[0].x;
        v.seamZ = LINE_SORT[0].z;
      }
      return;
    }

    LINE_SORT.sort((a, b) => a.x - b.x);
    let bestGap = -Infinity;
    let bestX = LINE_SORT[0].x;
    let bestZ = LINE_SORT[0].z;
    for (let i = 1; i < LINE_SORT.length; i++) {
      const a = LINE_SORT[i - 1];
      const b = LINE_SORT[i];
      const ah = v.seen.get(a.id)?.halfFront ?? 10;
      const bh = v.seen.get(b.id)?.halfFront ?? 10;
      const gap = b.x - bh - (a.x + ah);
      if (gap > bestGap) {
        bestGap = gap;
        bestX = (a.x + ah + b.x - bh) * 0.5;
        bestZ = (a.z + b.z) * 0.5;
      }
    }
    v.seamX = bestX;
    v.seamZ = bestZ;
    v.seamWidth = Math.max(0, bestGap);
  }

  // -------------------------------------------------------------------------
  // Shared queries used by both layers
  // -------------------------------------------------------------------------

  /** Perceived enemy record for `unitId` as seen by `observer`, or undefined. */
  perceived(observer: Faction, unitId: number): PerceivedEnemy | undefined {
    return this.view(observer).seen.get(unitId);
  }

  /**
   * Would shooting at `target` from `shooter` risk hitting our own men? True when a
   * friendly unit is inside the beaten zone: within 22 m of the line of fire and
   * closer to the target than we are.
   */
  friendlyFireRisk(shooter: UnitGroupState, targetX: number, targetZ: number): boolean {
    const dx = targetX - shooter.x;
    const dz = targetZ - shooter.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return false;
    const ux = dx / len;
    const uz = dz / len;
    for (const rec of this.info.values()) {
      const o = rec.unit;
      if (o.faction !== shooter.faction || o.id === shooter.id) continue;
      const ox = o.x - shooter.x;
      const oz = o.z - shooter.z;
      const along = ox * ux + oz * uz;
      // Behind us, or beyond the target: not in the way.
      if (along <= 0 || along >= len - 6) continue;
      const lateral = Math.abs(-ox * uz + oz * ux);
      // Half the friendly frontage plus a dispersion allowance for a plunging volley.
      if (lateral < rec.halfFront * 0.8 + 8) return true;
    }
    return false;
  }

  /** Front-rank segment for a unit, written into a caller-owned object. */
  frontSegmentOf(u: UnitGroupState, halfFront: number, out: { x1: number; z1: number; x2: number; z2: number }): void {
    frontSegment(u, halfFront, out);
  }

  /**
   * How exposed is `target`'s flank or rear to an attack coming from (fromX, fromZ)?
   * 0 = dead ahead of them, 1 = straight into the back of the formation.
   */
  exposure(target: UnitGroupState, fromX: number, fromZ: number): number {
    const bearing = Math.atan2(fromX - target.x, fromZ - target.z);
    const rel = Math.abs(angleDelta(target.facing, bearing));
    // 0 at the front, 1 at the rear, with the knee at 70 degrees where a formation
        // can no longer turn to face in time.
    return Math.min(1, Math.max(0, (rel - Math.PI * 0.28) / (Math.PI * 0.72)));
  }

  /**
   * Is the straight run from (fromX,fromZ) to `targetId` screened by an enemy line unit?
   *
   * This is the generalisation of "never charge the front of a spear wall": the archers
   * behind an intact line are not reachable, however soft they are, and cavalry that
   * rides at them frontally arrives inside the enemy formation with no charge left. If
   * the approach is screened the horse must go round.
   */
  approachScreened(observer: Faction, fromX: number, fromZ: number, targetId: number): boolean {
    const v = this.view(observer);
    const target = v.seen.get(targetId);
    if (!target) return false;
    for (const mem of v.seen.values()) {
      if (mem.unitId === targetId || mem.routing || mem.alive <= 0) continue;
      if (!isLineUnit(mem.unitClass)) continue;
      // How far is this block from the line of the charge, and is it in the way rather
      // than off to one side or already behind the target?
      const d2 = pointSegDist2(mem.x, mem.z, fromX, fromZ, target.x, target.z);
      if (d2 > (mem.halfFront + 22) * (mem.halfFront + 22)) continue;
      const toTarget = Math.hypot(target.x - fromX, target.z - fromZ);
      const toBlock = Math.hypot(mem.x - fromX, mem.z - fromZ);
      if (toBlock < toTarget - 6) return true;
    }
    return false;
  }

  /** Convenience: is this class one the cavalry should be hunting? */
  isSoftTarget(c: UnitClass): boolean {
    return isMissileClass(c) || (!isCavalryClass(c) && c === 'light-infantry');
  }
}
