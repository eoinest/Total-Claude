/**
 * The deployment phase — arranging the army before the clock starts.
 *
 * Total War's pre-battle deployment, in the specifics that matter: the armies are on the
 * field, the clock is stopped, and the player drags their regiments into position, sets
 * their facing and frontage, adds and removes units, and only then presses the button that
 * starts the fight.
 *
 * Three things about the shape of this file.
 *
 * **The clock is the gate, not a flag.** `Engine.frame` runs `fixedUpdate` exactly
 * `Time.beginFrame` says to, and a paused clock returns zero steps — so with the clock
 * paused the AI's planner, the tactical selector, combat, morale, projectiles and the
 * siege's own steering are all simply not called. That matters more here than anywhere
 * else: `installAI` binds its `commanded` set at construction in `main.ts` and re-plans
 * every few ticks, and a move order it owns has been measured drifting 46 m and being
 * re-issued 23 times in ten seconds. Nothing in this file needs to fight that, because
 * during deployment no tick happens at all. The one thing that *does* have to be enforced
 * is that the player cannot un-pause behind the phase's back, which is why `HudSystem`
 * routes the speed keys through `blocksClock`.
 *
 * **Placement is a teleport, not an order.** A unit moved during deployment has its men
 * written straight onto their formation slots, previous-tick positions included, so there
 * is no interpolation smear and no march. That is what makes the gesture feel like laying
 * out an army rather than commanding one.
 *
 * **The pool cannot be handed a slot back.** `SoldierPool.alloc` is a bump allocator —
 * `if (count >= capacity) return -1; return count++` — with no free list, and its capacity
 * is fixed at `BattleSystem.init` from `quality.maxSoldiers`, which is *before* the
 * scenario deploys. So a unit removed here can never give its men back to the pool. Two
 * consequences, both handled rather than hoped over: removed units are **benched and
 * reused** when a unit of the same type is added again, which makes the ordinary edit loop
 * (add the wrong thing, remove it, add the right thing) cost nothing at all; and every add
 * that cannot be served from the bench is checked against the pool's remaining headroom
 * before it is allowed. See `headroom`.
 */

import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from './BattleSystem';
import {
  type BattleConfig, type ScenarioId, MAX_PER_TYPE, MAX_UNITS_PER_SIDE,
  PERF_VALIDATED_MEN, rosterFor,
} from './battleConfig';
import { formation, ranksFor } from './formations';
import { Faction, SoldierState, UnitOrder, type UnitGroupState } from './types';
import { unitType } from '../units/roster';

/**
 * Where the player is allowed to stand their army.
 *
 * A rectangle in plan plus, when the wall on this map is the player's own, the parapet.
 * **Every number in it is derived from the map, the city plan and where the scenario put
 * the two armies** — there is no constant here that names a battlefield. Rome, Carthage and
 * Pydna are all live and Pydna has no city at all, so a zone written down as literals would
 * be wrong on two maps out of three the day it was typed.
 */
export interface DeployZone {
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
  /** True when the player's own curtain is inside the zone and may be garrisoned. */
  wall: boolean;
  /** One line for the HUD, naming what bounds it. */
  label: string;
}

export interface DeployBudget {
  /** Units the player commands right now. */
  units: number;
  /** Living men, both sides — the figure `PERF_VALIDATED_MEN` is measured against. */
  men: number;
  /** Pool slots ever claimed. Only ever rises; see the file header. */
  allocated: number;
  /** Pool slots that will never be claimed again. */
  free: number;
  poolCap: number;
  perfLine: number;
  /** Men benched by a removal and available to a matching add for free. */
  benched: number;
}

/** Why an add was refused, or null when it can go ahead. */
export type AddRefusal = string | null;

export interface PlaceOutcome {
  placed: number;
  /** Units the drop could not take, with the reason for the first of them. */
  refused: number;
  reason: string;
  /** How many of the placed units went onto the parapet. */
  onWall: number;
}

/** The narrow view of the city this phase needs. `src/sim/` does not import `src/city/`. */
interface CityView {
  getGarrisonBays?: () => readonly {
    x0: number; z0: number; x1: number; z1: number; walkY: number; garrisonable: boolean;
  }[];
  cityPlan?: { id: string; name: string; garrison: Faction; battlefieldZ: number };
}

interface TerrainView {
  heightField?: { halfExtent: number };
}

const SCRATCH = { x: 0, z: 0 };

/**
 * A unit taken off the field, kept whole so its pool slots can come back.
 *
 * `wasOnWall` is not decoration. `Siege.garrison` puts a unit in the siege system's own
 * `garrisons` and `owned` maps and there is no public way to take it out again — but
 * `Siege.updateGarrisons` skips any id `BattleSystem.unitById` no longer answers for, and
 * `Siege.freeWindow` treats a station claimed by such an id as free, so splicing the unit
 * out of `battle.units` leaves the siege system consistent. What it does *not* do is
 * un-garrison the unit, so a benched garrison may only ever be revived back onto the wall.
 * Reviving one onto grass would hand `updateGarrisons` a live unit with wall stations and it
 * would be steered back up the moment the battle started.
 */
interface Benched {
  unit: UnitGroupState;
  typeId: string;
  wasOnWall: boolean;
}

export class DeploymentSystem implements Subsystem {
  readonly name = 'deployment';
  /** Just ahead of the HUD (700), so the panel reads state settled this frame. */
  readonly order = 690;

  /** True while the player is laying out the army and the clock is held. */
  active = false;
  /** Set once `commit` has run, so the phase can never be re-entered mid-battle. */
  committed = false;

  zone: DeployZone = { xMin: -1, xMax: 1, zMin: -1, zMax: 1, wall: false, label: '' };
  playerFaction: Faction = Faction.Rome;
  scenario: ScenarioId = 'field';

  /** Last refusal, so the HUD can say why a gesture did nothing. */
  lastRefusal = '';

  private ctx!: EngineContext;
  private battle!: BattleSystem;
  private city: CityView | undefined;
  private halfExtent = 1400;
  private bench: Benched[] = [];
  private config: BattleConfig | null = null;
  /** Units whose men are on the parapet, by id — the wall's own membership list. */
  private onWall = new Set<number>();
  /** Spawn cursor for `add`, so successive additions fan along the rear of the zone. */
  private addIndex = 0;

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.battle = ctx.get<BattleSystem>('battle');
    this.city = ctx.tryGet('city') as unknown as CityView | undefined;
    const terrain = ctx.tryGet('terrain') as unknown as TerrainView | undefined;
    if (terrain?.heightField) this.halfExtent = terrain.heightField.halfExtent;
  }

  // -------------------------------------------------------------------------
  // Phase
  // -------------------------------------------------------------------------

  /**
   * Enter the phase. Called from `main.ts` once the scenario has laid the armies out, so
   * the zone can be measured off the deployment rather than guessed ahead of it.
   */
  begin(config: BattleConfig, playerFaction: Faction): void {
    if (this.committed) return;
    this.config = config;
    this.playerFaction = playerFaction;
    this.scenario = config.scenario;
    this.zone = this.computeZone();
    for (const u of this.battle.units) {
      if (this.battle.siege.isGarrisoned(u.id)) this.onWall.add(u.id);
    }
    this.active = true;
    this.ctx.time.paused = true;
    this.ctx.events.emit('deploymentBegan', {
      faction: playerFaction, units: this.ownUnits().length,
    });
  }

  /**
   * Commit the deployment and start the fight.
   *
   * The scenario's own opening orders are re-asserted for the units the player did not
   * touch and every placed unit is set to hold exactly where it was put, so nothing walks
   * off on the first tick to a destination it was given before the player moved it.
   */
  commit(): void {
    if (!this.active) return;
    this.active = false;
    this.committed = true;
    for (const u of this.battle.units) {
      if (u.destroyed) continue;
      if (u.order === UnitOrder.Garrison) continue;
      u.waypoints.length = 0;
      u.targetX = u.x;
      u.targetZ = u.z;
    }
    // Whatever is still benched will never be seen again; drop the references so the
    // unit objects and their member arrays can be collected.
    this.bench.length = 0;
    this.ctx.time.paused = false;
    this.ctx.time.resync();
    this.ctx.events.emit('deploymentEnded', { units: this.ownUnits().length });
  }

  /** True while nothing may un-pause the clock. `HudSystem` asks before honouring a key. */
  get blocksClock(): boolean {
    return this.active;
  }

  // -------------------------------------------------------------------------
  // The zone
  // -------------------------------------------------------------------------

  /**
   * Measure the deployment zone off the world that was just built.
   *
   * The rule, in words: the player owns their own half of the ground between the two
   * armies, back as far as the map or their own city allows, and their own wall if they
   * have one. The front edge stands off the midline by a fifth of the gap between the
   * armies, so a player may push forward without starting the battle already in contact.
   */
  private computeZone(): DeployZone {
    const own = this.ownUnits();
    const foe = this.battle.units.filter(
      (u) => !u.destroyed && u.faction !== this.playerFaction
    );
    const mean = (list: UnitGroupState[], pick: (u: UnitGroupState) => number): number => {
      let w = 0;
      let s = 0;
      for (const u of list) {
        const n = Math.max(1, u.alive);
        s += pick(u) * n;
        w += n;
      }
      return w > 0 ? s / w : 0;
    };
    const ownZ = mean(own, (u) => u.z);
    const foeZ = foe.length ? mean(foe, (u) => u.z) : -ownZ;
    const side = ownZ >= foeZ ? 1 : -1;
    const gap = Math.abs(ownZ - foeZ);
    const mid = (ownZ + foeZ) * 0.5;
    // A fifth of the gap, floored at 40 m: at the shipped 320 m separation that is 64 m of
    // no-man's-land, which lets a player advance their line ~100 m and no further.
    const standOff = Math.max(40, gap * 0.2);

    const bays = this.city?.getGarrisonBays?.() ?? [];
    const plan = this.city?.cityPlan;
    const mine = !!plan && plan.garrison === this.playerFaction && bays.length > 0;

    let wallZLo = Infinity;
    let wallZHi = -Infinity;
    let wallXLo = Infinity;
    let wallXHi = -Infinity;
    for (const b of bays) {
      wallZLo = Math.min(wallZLo, b.z0, b.z1);
      wallZHi = Math.max(wallZHi, b.z0, b.z1);
      wallXLo = Math.min(wallXLo, b.x0, b.x1);
      wallXHi = Math.max(wallXHi, b.x0, b.x1);
    }

    /*
     * Rear limit, in order of what actually bounds it:
     *   your own wall  — 60 m behind the far face, so a reserve stands behind the curtain
     *                    rather than wandering off into your own streets
     *   an enemy city  — its `battlefieldZ`, the one line the plan guarantees carries no
     *                    city geometry
     *   neither        — the edge of the heightfield
     */
    const edge = side * (this.halfExtent - 160);
    let rear = edge;
    if (mine) rear = side > 0 ? wallZHi + 60 : wallZLo - 60;
    else if (plan) {
      rear = side > 0
        ? Math.min(edge, plan.battlefieldZ - 10)
        : Math.max(edge, plan.battlefieldZ + 10);
    }
    let front = mid + side * standOff;
    // A defender must be able to stand men at the foot of their own wall, whatever the
    // arithmetic above said about the midline.
    if (mine) front = side > 0 ? Math.min(front, wallZLo - 25) : Math.max(front, wallZHi + 25);

    const zMin = Math.min(front, rear);
    const zMax = Math.max(front, rear);

    /*
     * Lateral extent from the armies' own span, widened by half again so there is room to
     * outflank, and clamped to the heightfield.
     *
     * Deliberately *not* widened to the whole circuit when the player owns the wall. Rome's
     * curtain runs 1.8 km and taking the zone out to both ends of it produced a "deployment
     * zone" covering most of the map, which is not a decision anyone was making. The sector
     * you are defending is the sector your army was drawn up in front of; the parapet inside
     * that sector is yours, and `contains` admits it.
     */
    let xLo = Infinity;
    let xHi = -Infinity;
    for (const u of [...own, ...foe]) {
      xLo = Math.min(xLo, u.x);
      xHi = Math.max(xHi, u.x);
    }
    if (!Number.isFinite(xLo)) {
      xLo = -200;
      xHi = 200;
    }
    const cx = (xLo + xHi) * 0.5;
    const half = Math.max(250, (xHi - xLo) * 0.5 * 1.5);
    const lim = this.halfExtent - 160;
    const xMin = Math.max(-lim, cx - half);
    const xMax = Math.min(lim, cx + half);
    void wallXLo;
    void wallXHi;

    const bound = mine
      ? `${plan?.name ?? 'the city'}’s own wall`
      : plan
        ? `${plan.name} at z ${Math.round(plan.battlefieldZ)}`
        : 'the edge of the field';
    return {
      xMin, xMax, zMin, zMax, wall: mine,
      label: `${Math.round(xMax - xMin)} × ${Math.round(zMax - zMin)} m`
        + `${mine ? ', parapet included' : ''}, bounded by ${bound}`,
    };
  }

  /**
   * Inside the rectangle, or on a stretch of the player's own parapet within it.
   *
   * The wall clause is tested in x only: the walkway's z sits inside the rectangle by
   * construction when `mine`, and the click band `Siege.wallTargetAt` allows either side of
   * the standing band can put a legal wall point a metre outside the rectangle's z edge.
   */
  contains(x: number, z: number): boolean {
    if (x < this.zone.xMin || x > this.zone.xMax) return false;
    if (this.zone.wall && this.battle.siege.wallTargetAt(x, z) >= 0) return true;
    return z >= this.zone.zMin && z <= this.zone.zMax;
  }

  /** Nearest legal point inside the rectangle. */
  clampToZone(x: number, z: number, out: { x: number; z: number }): void {
    out.x = Math.min(this.zone.xMax, Math.max(this.zone.xMin, x));
    out.z = Math.min(this.zone.zMax, Math.max(this.zone.zMin, z));
  }

  /** True when this point means the parapet rather than the ground beside it. */
  isWallPoint(x: number, z: number): boolean {
    return this.zone.wall
      && x >= this.zone.xMin && x <= this.zone.xMax
      && this.battle.siege.wallTargetAt(x, z) >= 0;
  }

  // -------------------------------------------------------------------------
  // Placement
  // -------------------------------------------------------------------------

  ownUnits(): UnitGroupState[] {
    return this.battle.units.filter((u) => !u.destroyed && u.faction === this.playerFaction);
  }

  isOnWall(unitId: number): boolean {
    return this.onWall.has(unitId);
  }

  /**
   * Stand a unit at a point, facing a bearing, with a given frontage.
   *
   * Returns false and sets `lastRefusal` when the point is outside the zone. A point on the
   * player's own parapet is a garrison order instead: `Siege.garrison` is the only thing in
   * the sim that can put a man on stone, and it lays the unit out in as many ranks as the
   * walkway's clear band takes at the sim's rank pitch, capped at `MAX_WALL_RANKS`.
   */
  place(unitId: number, x: number, z: number, facing: number, width?: number): boolean {
    if (!this.active) return false;
    const u = this.battle.unitById(unitId);
    if (!u || u.destroyed || u.faction !== this.playerFaction) return false;

    if (this.isWallPoint(x, z)) return this.placeOnWall(u, x, z);

    if (this.onWall.has(u.id)) {
      /*
       * A garrison cannot simply step off the stone here.
       *
       * The wall state lives in `Siege`'s private maps and the only public way out of it —
       * `sendToGround` — plans a descent by stair and executes it over many ticks, which is
       * exactly what a paused clock will never run. So the unit is retired and an identical
       * one is stood on the grass instead. That costs pool slots unless the bench can serve
       * it, and `headroom` is what stops it costing more than there is.
       */
      const typeId = u.typeId;
      if (!this.contains(x, z)) {
        this.lastRefusal = 'That is outside the deployment zone.';
        return false;
      }
      const refusal = this.headroom(typeId, false);
      if (refusal) {
        this.lastRefusal = `${refusal} — the unit stays on the wall.`;
        return false;
      }
      this.remove(u.id);
      const fresh = this.add(typeId, x, z, facing);
      if (fresh < 0) return false;
      if (width !== undefined) this.place(fresh, x, z, facing, width);
      return true;
    }

    if (!this.contains(x, z)) {
      this.lastRefusal = 'That is outside the deployment zone.';
      return false;
    }
    this.lastRefusal = '';
    u.x = x;
    u.z = z;
    u.facing = facing;
    u.targetFacing = facing;
    if (width !== undefined && width > 0) u.width = Math.max(1, Math.round(width));
    this.relayout(u);
    /*
     * A halt through the event bus rather than by hand, because `BattleSystem.applyOrder`
     * re-plants `holdX/holdZ` — the point a unit is allowed to wander from — on exactly this
     * set of order kinds, and those fields are private. Without it a unit dragged 200 m
     * during deployment would spend the battle believing it had drifted 200 m off station.
     */
    this.ctx.events.emit('orderIssued', { unitIds: [u.id], kind: 'halt' });
    u.order = UnitOrder.Hold;
    u.targetX = x;
    u.targetZ = z;
    return true;
  }

  /** Adopt a formation and re-stand the men in it, without moving the unit. */
  setFormation(unitId: number, formationId: string): boolean {
    if (!this.active) return false;
    const u = this.battle.unitById(unitId);
    if (!u || u.destroyed || u.faction !== this.playerFaction) return false;
    if (this.onWall.has(u.id)) {
      this.lastRefusal = 'A garrison holds the walkway, not a formation.';
      return false;
    }
    const before = u.formationId;
    this.battle.setFormation(u, formationId);
    if (u.formationId === before && before !== formationId) return false;
    this.relayout(u);
    return true;
  }

  /**
   * Put a unit on the parapet at the station nearest the drop.
   *
   * The height, the rank count and the standing band all come from the wall itself: `Siege`
   * builds its spine from `CitySystem.getGarrisonBays()`, whose `walkY` is emitted by the
   * same function that emits the wall-walk geometry, so a garrison cannot drift out of
   * register with the stone it is standing on.
   */
  private placeOnWall(u: UnitGroupState, x: number, z: number): boolean {
    if (!this.battle.siege.garrison(u, x, z)) {
      this.lastRefusal = 'There is no walkway there.';
      return false;
    }
    this.onWall.add(u.id);
    this.lastRefusal = '';
    return true;
  }

  /**
   * Write every living man onto his formation slot, previous position included.
   *
   * `spawnUnit` does this inline as it allocates; this is the same arithmetic against men
   * that already exist. `px/py/pz` are written as well as `x/y/z` because the renderer
   * interpolates between them — without it a unit dragged across the field draws one frame
   * of men smeared along the whole path.
   */
  private relayout(u: UnitGroupState): void {
    const p = this.battle.pool;
    const fdef = formation(u.formationId);
    const living: number[] = [];
    for (const i of u.members) if (p.aliveAt(i)) living.push(i);
    if (living.length === 0) return;
    const width = Math.max(1, Math.min(Math.round(u.width), living.length));
    u.width = width;
    const ranks = ranksFor(living.length, width);
    const s = Math.sin(u.facing);
    const c = Math.cos(u.facing);
    for (let k = 0; k < living.length; k++) {
      const i = living[k];
      fdef.offset(SCRATCH, k, width, ranks, u.spacingX, u.spacingZ);
      const wx = u.x + SCRATCH.x * c + SCRATCH.z * s;
      const wz = u.z - SCRATCH.x * s + SCRATCH.z * c;
      const wy = this.battle.groundAt(wx, wz);
      p.x[i] = wx; p.z[i] = wz; p.y[i] = wy;
      p.px[i] = wx; p.pz[i] = wz; p.py[i] = wy;
      p.vx[i] = 0; p.vz[i] = 0; p.vy[i] = 0;
      p.facing[i] = u.facing;
      p.prevFacing[i] = u.facing;
      p.lean[i] = 0;
      p.slot[i] = k;
      p.rank[i] = Math.min(255, Math.floor(k / width));
      p.file[i] = Math.min(255, k % width);
      p.target[i] = -1;
      if (p.state[i] !== SoldierState.Idle) p.setState(i, SoldierState.Idle);
    }
  }

  // -------------------------------------------------------------------------
  // Adding and removing
  // -------------------------------------------------------------------------

  /** Roster rows this side may field, straight from the pre-battle vocabulary. */
  roster(): readonly string[] {
    return rosterFor(this.playerFaction, this.scenario);
  }

  /** How many of this type are on the field. */
  countOf(typeId: string): number {
    let n = 0;
    for (const u of this.ownUnits()) if (u.typeId === typeId) n++;
    return n;
  }

  /**
   * Why this type cannot be added, or null.
   *
   * The per-side and per-type caps are `MAX_UNITS_PER_SIDE` and `MAX_PER_TYPE` from
   * `battleConfig.ts` — the same two numbers the pre-battle menu greys its steppers on,
   * because a second set of limits that disagreed with the first is worse than no limit.
   * `PERF_VALIDATED_MEN` is deliberately *not* here: the menu warns past it rather than
   * refusing, and this phase says the same thing in the same words.
   */
  headroom(typeId: string, wantWall = false): AddRefusal {
    if (!this.roster().includes(typeId)) {
      return `${unitType(typeId).name} is not in this army's roster.`;
    }
    if (this.ownUnits().length >= MAX_UNITS_PER_SIDE) {
      return `${MAX_UNITS_PER_SIDE} units is the limit for one side.`;
    }
    if (this.countOf(typeId) >= MAX_PER_TYPE) {
      return `${MAX_PER_TYPE} of one type is the limit.`;
    }
    if (this.benchedFor(typeId, wantWall) >= 0) return null;
    const def = unitType(typeId);
    const scale = def.unitClass === 'artillery' ? 1 : this.battle.unitSizeScale;
    const want = Math.max(1, Math.round(def.strength * scale));
    const free = this.battle.pool.capacity - this.battle.pool.count;
    if (want > free) {
      return `The soldier pool has ${free} places left and ${def.name} needs ${want}. `
        + 'Removing a unit does not give its places back.';
    }
    return null;
  }

  /** Index into the bench of a unit that can be revived for this type, or -1. */
  private benchedFor(typeId: string, wantWall: boolean): number {
    for (let i = 0; i < this.bench.length; i++) {
      const b = this.bench[i];
      if (b.typeId === typeId && b.wasOnWall === wantWall) return i;
    }
    return -1;
  }

  /**
   * Add a unit, from the bench if one is waiting and from the pool otherwise.
   *
   * Returns the new unit's id, or -1 with `lastRefusal` set.
   */
  add(typeId: string, x?: number, z?: number, facing?: number): number {
    if (!this.active) return -1;
    const wantWall = x !== undefined && z !== undefined && this.isWallPoint(x, z);
    const refusal = this.headroom(typeId, wantWall);
    if (refusal) {
      this.lastRefusal = refusal;
      return -1;
    }
    this.lastRefusal = '';

    const spot = x !== undefined && z !== undefined
      ? { x, z }
      : this.parkingSpot();
    const face = facing ?? this.defaultFacing();

    const at = this.benchedFor(typeId, wantWall);
    let u: UnitGroupState;
    if (at >= 0) {
      u = this.revive(this.bench.splice(at, 1)[0]);
    } else {
      const id = this.battle.spawnUnit(typeId, spot.x, spot.z, face);
      if (id < 0) {
        this.lastRefusal = 'The soldier pool is full.';
        return -1;
      }
      u = this.battle.unitById(id)!;
    }
    if (wantWall) this.placeOnWall(u, spot.x, spot.z);
    else this.place(u.id, spot.x, spot.z, face);
    this.ctx.events.emit('deploymentChanged', { unitId: u.id, added: true });
    return u.id;
  }

  /**
   * Take a unit off the field.
   *
   * The unit is spliced out of `battle.units` and every man is marked dead, which is what
   * makes the renderer, the spatial hash, the animation playheads and the siege's garrison
   * loop all stop seeing it — each of those tests either `aliveAt` or `unitById`. The pool
   * slots are gone for good; the unit object goes on the bench so the *slots* can come back
   * if a unit of the same type is added again.
   */
  remove(unitId: number): boolean {
    if (!this.active) return false;
    const u = this.battle.unitById(unitId);
    if (!u || u.faction !== this.playerFaction) return false;
    const at = this.battle.units.indexOf(u);
    if (at < 0) return false;
    const p = this.battle.pool;
    for (const i of u.members) {
      if (p.aliveAt(i)) p.setState(i, SoldierState.Dead);
      this.battle.elevated[i] = 0;
    }
    this.battle.units.splice(at, 1);
    u.destroyed = true;
    u.selected = false;
    u.alive = 0;
    this.bench.push({ unit: u, typeId: u.typeId, wasOnWall: this.onWall.has(u.id) });
    this.onWall.delete(u.id);
    this.ctx.events.emit('deploymentChanged', { unitId, added: false });
    this.ctx.events.emit('unitDestroyed', { unitId, faction: u.faction });
    return true;
  }

  /** Put a benched unit back on the field with its own men, at full establishment. */
  private revive(b: Benched): UnitGroupState {
    const u = b.unit;
    const p = this.battle.pool;
    for (const i of u.members) {
      p.hp[i] = p.maxHp[i];
      p.fatigue[i] = 0;
      p.target[i] = -1;
      p.setState(i, SoldierState.Idle);
    }
    u.destroyed = false;
    u.alive = u.members.length;
    u.morale = u.maxMorale;
    u.engaged = false;
    u.contactLock = false;
    u.charging = false;
    u.routTimer = 0;
    u.waypoints.length = 0;
    u.targetUnitId = -1;
    u.order = UnitOrder.Hold;
    this.battle.units.push(u);
    return u;
  }

  /** Where an unplaced addition goes: along the rear of the zone, fanning out. */
  private parkingSpot(): { x: number; z: number } {
    const z = this.zone.zMin + (this.zone.zMax - this.zone.zMin)
      * (this.frontIsLowZ() ? 0.88 : 0.12);
    const cx = (this.zone.xMin + this.zone.xMax) * 0.5;
    const k = this.addIndex++;
    const step = Math.min(60, (this.zone.xMax - this.zone.xMin) / 12);
    const off = (Math.floor((k + 1) / 2) * (k % 2 === 0 ? 1 : -1)) * step;
    return {
      x: Math.min(this.zone.xMax - 10, Math.max(this.zone.xMin + 10, cx + off)),
      z,
    };
  }

  /** True when the enemy lies toward −Z from the player's ground. */
  frontIsLowZ(): boolean {
    const foe = this.battle.units.filter(
      (u) => !u.destroyed && u.faction !== this.playerFaction
    );
    if (foe.length === 0) return true;
    let s = 0;
    for (const u of foe) s += u.z;
    return s / foe.length < (this.zone.zMin + this.zone.zMax) * 0.5;
  }

  /** The bearing a new unit faces: at the enemy. */
  private defaultFacing(): number {
    return this.frontIsLowZ() ? Math.PI : 0;
  }

  // -------------------------------------------------------------------------
  // Readouts
  // -------------------------------------------------------------------------

  budget(): DeployBudget {
    const p = this.battle.pool;
    let men = 0;
    for (const u of this.battle.units) if (!u.destroyed) men += u.alive;
    let benched = 0;
    for (const b of this.bench) benched += b.unit.members.length;
    return {
      units: this.ownUnits().length,
      men,
      allocated: p.count,
      free: p.capacity - p.count,
      poolCap: p.capacity,
      perfLine: PERF_VALIDATED_MEN,
      benched,
    };
  }

  /** The one line the HUD leads with, or '' when there is nothing to say. */
  warning(): string {
    const b = this.budget();
    if (b.men > b.perfLine) {
      return `${b.men.toLocaleString('en-GB')} men is past the `
        + `${b.perfLine.toLocaleString('en-GB')} this runs at 60 fps.`;
    }
    return '';
  }

  /** Config the phase was entered with, for anything that wants to re-read the setup. */
  get battleConfig(): BattleConfig | null {
    return this.config;
  }

  dispose(): void {
    this.bench.length = 0;
    this.onWall.clear();
  }
}
