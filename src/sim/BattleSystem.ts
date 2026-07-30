import type { EngineContext, Subsystem } from '../core/Engine';
import { Rng } from '../util/rand';
import { clamp, clamp01, damp, turnToward, wrapAngle } from '../util/math';
import { formation, ranksFor } from './formations';
import { unitType, isCavalry } from '../units/roster';
import type { TerrainSystem } from '../terrain/TerrainSystem';
import {
  Clip, Faction, SoldierPool, SoldierState, SpatialHash, UnitOrder,
  isAlive, type UnitGroupState, type UnitTypeDef,
} from './types';

/**
 * The battle simulation hub.
 *
 * Owns the soldier pool and the unit groups, and runs the per-tick pipeline:
 *   1. rebuild the spatial hash
 *   2. per-unit order resolution (where does this formation want to be?)
 *   3. per-soldier steering toward its formation slot, plus crowd separation
 *   4. melee acquisition and resolution
 *   5. morale, fatigue and rout checks
 *
 * Combat resolution, morale and AI are refined by their own subsystems, which read
 * and write this state through the accessors below rather than owning parallel copies.
 */

const SCRATCH = { x: 0, z: 0 };

export class BattleSystem implements Subsystem {
  readonly name = 'battle';
  readonly order = 10;

  pool!: SoldierPool;
  units: UnitGroupState[] = [];
  hash!: SpatialHash;
  rng = new Rng('battle-271');

  private terrain?: TerrainSystem;
  private ctx!: EngineContext;
  private nextUnitId = 0;
  /** Per-faction living soldier tally, refreshed each tick. */
  readonly strength: Record<number, number> = { 0: 0, 1: 0 };

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.terrain = ctx.tryGet<TerrainSystem>('terrain');
    this.pool = new SoldierPool(ctx.quality.maxSoldiers);
    this.mounted = new Uint8Array(ctx.quality.maxSoldiers);
    this.hash = new SpatialHash(1500, 3.5);

    ctx.events.on('orderIssued', (o) => this.applyOrder(o));
  }

  // -------------------------------------------------------------------------
  // Army construction
  // -------------------------------------------------------------------------

  /**
   * Global multiplier on every unit's roster strength — the equivalent of Total War's
   * unit-size setting. The roster's numbers are authored at a readable baseline; a
   * scenario raises this to fill the field. Set before spawning; changing it afterwards
   * has no effect on units already deployed.
   */
  unitSizeScale = 1;

  /**
   * Spawn a unit group with its front rank centred on (x, z), facing `facing`.
   * Returns the new unit's id, or -1 if the soldier pool is full.
   */
  spawnUnit(typeId: string, x: number, z: number, facing: number, formationId?: string): number {
    const def = unitType(typeId);
    const fdef = formation(formationId ?? def.formations[0]);
    // Artillery crews are a fixed establishment — a scorpion needs two men whatever the
    // unit-size setting — so they do not scale.
    const scale = def.unitClass === 'artillery' ? 1 : this.unitSizeScale;
    const strength = Math.max(1, Math.round(def.strength * scale));
    const width = fdef.width(strength);

    const u: UnitGroupState = {
      id: this.nextUnitId++,
      typeId,
      faction: def.faction,
      members: [],
      alive: 0,
      initialStrength: strength,
      x, z, facing,
      targetX: x, targetZ: z, targetFacing: facing,
      order: UnitOrder.Hold,
      targetUnitId: -1,
      waypoints: [],
      running: false,
      formationId: fdef.id,
      width,
      spacingX: this.baseSpacingX(def) * fdef.spacingXMul,
      spacingZ: this.baseSpacingZ(def) * fdef.spacingZMul,
      morale: def.morale,
      maxMorale: def.morale,
      fatigue: 0,
      ammo: def.missile?.ammo ?? 0,
      engaged: false,
      chargeTimer: 0,
      contactLock: false,
      charging: false,
      routTimer: 0,
      kills: 0,
      destroyed: false,
      selected: false,
      concealed: false,
    };

    const ranks = ranksFor(strength, width);
    const rng = this.rng.fork(`unit${u.id}`);
    const mounted = isCavalry(def);

    for (let s = 0; s < strength; s++) {
      const i = this.pool.alloc();
      if (i < 0) break;
      u.members.push(i);

      fdef.offset(SCRATCH, s, width, ranks, u.spacingX, u.spacingZ);
      const [wx, wz] = this.localToWorld(u, SCRATCH.x, SCRATCH.z);

      const p = this.pool;
      p.x[i] = wx;
      p.z[i] = wz;
      p.y[i] = this.groundAt(wx, wz);
      p.px[i] = wx; p.pz[i] = wz; p.py[i] = p.y[i];
      p.vx[i] = 0; p.vz[i] = 0; p.vy[i] = 0;
      p.facing[i] = facing;
      p.prevFacing[i] = facing;
      p.lean[i] = 0;

      p.unitId[i] = u.id;
      p.faction[i] = def.faction;
      p.slot[i] = s;
      p.rank[i] = Math.min(255, Math.floor(s / width));
      p.file[i] = Math.min(255, s % width);

      // One hit point per man; damage accumulates until a blow finishes him.
      p.maxHp[i] = 100;
      p.hp[i] = 100;
      p.state[i] = SoldierState.Idle;
      p.stateTime[i] = rng.range(0, 3);
      p.target[i] = -1;
      p.attackCooldown[i] = rng.range(0, 1 / def.attackRate);
      p.fatigue[i] = 0;
      p.ammo[i] = def.missile?.ammo ?? 0;

      p.animClip[i] = Clip.IdleAlert;
      p.animTime[i] = rng.next();
      p.animPrevClip[i] = Clip.IdleAlert;
      p.animPrevTime[i] = 0;
      p.animBlend[i] = 1;
      // +/-8% rate so a hundred idle men never breathe in unison.
      p.animRate[i] = rng.range(0.92, 1.08);

      p.scale[i] = def.appearance.heightScale * rng.range(0.965, 1.035);
      p.variant[i] = rng.next();
      p.grime[i] = rng.range(0, 0.12);
      p.deathVariant[i] = rng.int(0, 3);
      p.deathDirX[i] = 0;
      p.deathDirZ[i] = 0;
      this.mounted[i] = mounted ? 1 : 0;
    }

    u.alive = u.members.length;
    u.initialStrength = u.members.length;
    this.units.push(u);
    return u.id;
  }

  private baseSpacingX(def: UnitTypeDef): number {
    return isCavalry(def) ? 1.95 : 0.86;
  }
  private baseSpacingZ(def: UnitTypeDef): number {
    return isCavalry(def) ? 3.1 : 1.02;
  }

  /** Transform a formation-local offset into world space. */
  private localToWorld(u: UnitGroupState, lx: number, lz: number): [number, number] {
    const s = Math.sin(u.facing);
    const c = Math.cos(u.facing);
    return [u.x + lx * c + lz * s, u.z - lx * s + lz * c];
  }

  groundAt(x: number, z: number): number {
    return this.terrain?.heightAt(x, z) ?? 0;
  }

  unitById(id: number): UnitGroupState | undefined {
    return this.units.find((u) => u.id === id);
  }

  typeOf(u: UnitGroupState): UnitTypeDef {
    return unitType(u.typeId);
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  private applyOrder(o: {
    unitIds: number[];
    kind: string;
    x?: number; z?: number; facing?: number;
    targetUnitId?: number; formation?: string;
    queued?: boolean; running?: boolean;
  }): void {
    for (const id of o.unitIds) {
      const u = this.unitById(id);
      if (!u || u.destroyed) continue;

      switch (o.kind) {
        case 'move':
        case 'attackMove': {
          if (o.x === undefined || o.z === undefined) break;
          if (o.queued) {
            u.waypoints.push(o.x, o.z, o.facing ?? u.targetFacing);
          } else {
            u.waypoints.length = 0;
            u.targetX = o.x;
            u.targetZ = o.z;
            if (o.facing !== undefined) u.targetFacing = o.facing;
            else u.targetFacing = Math.atan2(o.x - u.x, o.z - u.z);
          }
          u.order = o.kind === 'attackMove' ? UnitOrder.AttackMove : UnitOrder.MoveTo;
          u.running = !!o.running;
          u.targetUnitId = -1;
          break;
        }
        case 'attack': {
          if (o.targetUnitId === undefined) break;
          u.order = UnitOrder.AttackUnit;
          u.targetUnitId = o.targetUnitId;
          u.running = true;
          u.waypoints.length = 0;
          break;
        }
        case 'halt': {
          u.order = UnitOrder.Hold;
          u.targetX = u.x;
          u.targetZ = u.z;
          u.targetUnitId = -1;
          u.waypoints.length = 0;
          break;
        }
        case 'facing': {
          if (o.facing !== undefined) u.targetFacing = o.facing;
          break;
        }
        case 'formation': {
          if (o.formation) this.setFormation(u, o.formation);
          break;
        }
        case 'ability':
          // Deliberately a no-op here: AbilitySystem subscribes to `orderIssued`
          // directly and owns cooldowns, durations and stat modifiers. Listed so the
          // contract is explicit rather than looking like an unhandled case.
          break;
      }
    }
  }

  setFormation(u: UnitGroupState, id: string): void {
    const def = this.typeOf(u);
    if (!def.formations.includes(id)) return;
    const f = formation(id);
    u.formationId = id;
    u.width = f.width(u.alive || u.initialStrength);
    u.spacingX = this.baseSpacingX(def) * f.spacingXMul;
    u.spacingZ = this.baseSpacingZ(def) * f.spacingZMul;
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  fixedUpdate(dt: number, ctx: EngineContext): void {
    const p = this.pool;
    p.savePrevious();
    this.hash.rebuild(p);

    this.strength[Faction.Rome] = 0;
    this.strength[Faction.Germanic] = 0;

    for (const u of this.units) {
      if (u.destroyed) continue;
      this.updateUnitOrder(u, dt);
      this.updateUnitCohesion(u);
      this.strength[u.faction] += u.alive;
    }

    this.steerSoldiers(dt);
    this.resolveCrowding(dt);
    this.integrate(dt);
    this.updateAnimationState(dt, ctx);
  }

  /** Move the formation anchor toward its objective and consume waypoints. */
  private updateUnitOrder(u: UnitGroupState, dt: number): void {
    const def = this.typeOf(u);

    // Chasing a specific enemy unit: re-target the anchor at it every tick.
    if (u.order === UnitOrder.AttackUnit) {
      const t = this.unitById(u.targetUnitId);
      if (!t || t.destroyed) {
        u.order = UnitOrder.Hold;
        u.targetUnitId = -1;
      } else {
        const dx = t.x - u.x;
        const dz = t.z - u.z;
        const d = Math.hypot(dx, dz) || 1;
        // Stop just short so the ranks meet rather than interpenetrating. Kept tight:
        // combined with the arrival tolerance below, anything larger leaves the two front
        // ranks further apart than the weapons can reach and the units stare at each other.
        const standoff = def.reach + 0.15;
        u.targetX = t.x - (dx / d) * standoff;
        u.targetZ = t.z - (dz / d) * standoff;
        u.targetFacing = Math.atan2(dx, dz);
      }
    }

    if (u.order === UnitOrder.Rout) {
      u.routTimer += dt;
      // Flee directly away from the enemy's centre of mass.
      const away = this.threatDirection(u);
      u.targetX = u.x + away.x * 60;
      u.targetZ = u.z + away.z * 60;
      u.targetFacing = Math.atan2(away.x, away.z);
    }

    const dx = u.targetX - u.x;
    const dz = u.targetZ - u.z;
    const distToTarget = Math.hypot(dx, dz);

    // Locked in contact: hold the anchor and only pivot. Combat owns this flag.
    if (u.contactLock && u.order !== UnitOrder.Rout) {
      u.facing = turnToward(u.facing, u.targetFacing, dt * 1.1);
      const drain = u.engaged ? dt / (def.stamina * 2.4) : -dt / 26;
      u.fatigue = clamp01(u.fatigue + drain);
      if (u.chargeTimer > 0) u.chargeTimer = Math.max(0, u.chargeTimer - dt);
      return;
    }

    // Arrived: pop the next queued waypoint, else settle. The tolerance is tight because
    // it stacks on top of the attack standoff above.
    if (distToTarget < 0.25) {
      if (u.waypoints.length >= 3) {
        u.targetX = u.waypoints.shift()!;
        u.targetZ = u.waypoints.shift()!;
        u.targetFacing = u.waypoints.shift()!;
      } else if (u.order === UnitOrder.MoveTo) {
        u.order = UnitOrder.Hold;
      }
    } else {
      const f = formation(u.formationId);
      const routing = u.order === UnitOrder.Rout;
      const base = routing ? def.runSpeed * 1.06
        : u.charging ? def.chargeSpeed
        : u.running ? def.runSpeed
        : def.walkSpeed;
      // Fatigue and formation drag both bite into speed.
      const speed = base * f.mods.speed * (1 - u.fatigue * 0.42);
      const step = Math.min(distToTarget, speed * dt);
      u.x += (dx / distToTarget) * step;
      u.z += (dz / distToTarget) * step;

      // Face the direction of travel while moving; hold the ordered facing on arrival.
      const travelFacing = Math.atan2(dx, dz);
      const wantFacing = distToTarget > 4 ? travelFacing : u.targetFacing;
      u.facing = turnToward(u.facing, wantFacing, dt * 1.9);
    }

    if (distToTarget <= 0.25) {
      u.facing = turnToward(u.facing, u.targetFacing, dt * 1.5);
    }

    // Fatigue: running and fighting drain, standing still recovers.
    const exerting = distToTarget > 0.8 && (u.running || u.order === UnitOrder.Rout);
    const drain = exerting ? dt / Math.max(8, def.stamina) : u.engaged ? dt / (def.stamina * 2.4) : -dt / 26;
    u.fatigue = clamp01(u.fatigue + drain);

    if (u.chargeTimer > 0) u.chargeTimer = Math.max(0, u.chargeTimer - dt);
  }

  /** Direction pointing away from the nearest enemy mass. */
  private threatDirection(u: UnitGroupState): { x: number; z: number } {
    let ex = 0;
    let ez = 0;
    let n = 0;
    for (const o of this.units) {
      if (o.destroyed || o.faction === u.faction) continue;
      const d = Math.hypot(o.x - u.x, o.z - u.z);
      if (d > 220) continue;
      const w = 1 / Math.max(12, d);
      ex += (o.x - u.x) * w;
      ez += (o.z - u.z) * w;
      n++;
    }
    if (n === 0) return { x: 0, z: -1 };
    const l = Math.hypot(ex, ez) || 1;
    return { x: -ex / l, z: -ez / l };
  }

  /** Refresh living count, prune the dead from the roster, and check for destruction. */
  private updateUnitCohesion(u: UnitGroupState): void {
    const p = this.pool;
    let alive = 0;
    for (const i of u.members) if (isAlive(p.state[i] as SoldierState)) alive++;
    u.alive = alive;

    if (alive === 0 && !u.destroyed) {
      u.destroyed = true;
      this.ctx.events.emit('unitDestroyed', { unitId: u.id, faction: u.faction });
      return;
    }
    // A routed unit leaves the field once it is genuinely out of the fight. Requiring it
    // to reach the map edge (±1280 m) took over three minutes of flight at 4.4 m/s, so
    // broken units loitered mid-field for the rest of the battle and the engagement never
    // resolved. "Escaped" is better defined as distance from the nearest enemy: a unit
    // 260 m clear with nobody chasing it has left the battle in every sense that matters.
    if (u.order === UnitOrder.Rout && u.routTimer > 18) {
      const edge = Math.abs(u.x) > 1180 || Math.abs(u.z) > 1180;
      let nearestEnemy = Infinity;
      for (const o of this.units) {
        if (o.destroyed || o.faction === u.faction || o.order === UnitOrder.Rout) continue;
        const d = Math.hypot(o.x - u.x, o.z - u.z);
        if (d < nearestEnemy) nearestEnemy = d;
      }
      if (edge || nearestEnemy > 260) {
        u.destroyed = true;
        // Its men have quit the field, so retire them from the simulation rather than
        // leaving them alive-but-unsteered. `steerSoldiers` skips destroyed units, so
        // without this the unit's anchor stops tracking its men — one unit's anchor was
        // measured 770 m away from where its soldiers actually were — while 2,220 living
        // men stayed in the spatial hash and in every faction strength tally.
        for (const i of u.members) {
          if (p.aliveAt(i)) p.setState(i, SoldierState.Dead);
        }
        u.alive = 0;
        this.ctx.events.emit('unitDestroyed', { unitId: u.id, faction: u.faction });
      }
    }
  }

  /** Drive each soldier toward his formation slot. */
  private steerSoldiers(dt: number): void {
    const p = this.pool;
    for (const u of this.units) {
      if (u.destroyed) continue;
      const def = this.typeOf(u);
      const f = formation(u.formationId);
      const ranks = ranksFor(u.members.length, u.width);
      const routing = u.order === UnitOrder.Rout;

      const maxSpeed = (routing ? def.runSpeed * 1.06
        : u.charging ? def.chargeSpeed
        : u.running ? def.runSpeed
        : def.walkSpeed) * f.mods.speed * (1 - u.fatigue * 0.42);
      const accel = maxSpeed * 5.5;

      const s = Math.sin(u.facing);
      const c = Math.cos(u.facing);

      for (const i of u.members) {
        const st = p.state[i] as SoldierState;
        if (st === SoldierState.Dead || st === SoldierState.Dying) continue;
        // A man locked in melee holds his ground rather than chasing his slot.
        if (st === SoldierState.Fighting) {
          p.vx[i] = damp(p.vx[i], 0, 9, dt);
          p.vz[i] = damp(p.vz[i], 0, 9, dt);
          continue;
        }

        f.offset(SCRATCH, p.slot[i], u.width, ranks, u.spacingX, u.spacingZ);
        const tx = u.x + SCRATCH.x * c + SCRATCH.z * s;
        const tz = u.z - SCRATCH.x * s + SCRATCH.z * c;

        const dx = tx - p.x[i];
        const dz = tz - p.z[i];
        const d = Math.hypot(dx, dz);

        if (d < 0.06) {
          p.vx[i] = damp(p.vx[i], 0, 11, dt);
          p.vz[i] = damp(p.vz[i], 0, 11, dt);
        } else {
          // Arrive behaviour: ease off in the last two metres so nobody overshoots
          // and oscillates around his slot.
          const want = Math.min(maxSpeed, d * 2.6);
          const wx = (dx / d) * want;
          const wz = (dz / d) * want;
          const k = 1 - Math.exp(-(accel / Math.max(0.2, maxSpeed)) * dt);
          p.vx[i] += (wx - p.vx[i]) * k;
          p.vz[i] += (wz - p.vz[i]) * k;
        }
      }
    }
  }

  /**
   * Soft body separation. Men are pushed apart so ranks never occupy the same metre,
   * with mass deciding who yields — a horse displaces an infantryman, not the reverse.
   */
  private resolveCrowding(dt: number): void {
    const p = this.pool;
    const n = p.count;
    const radius = 0.42;
    const diameter = radius * 2;

    for (let i = 0; i < n; i++) {
      if (!p.aliveAt(i)) continue;
      const xi = p.x[i];
      const zi = p.z[i];
      let pushX = 0;
      let pushZ = 0;

      this.hash.query(xi, zi, diameter, (j) => {
        if (j <= i) return;
        if (!p.aliveAt(j)) return;
        const dx = p.x[j] - xi;
        const dz = p.z[j] - zi;
        const d2 = dx * dx + dz * dz;
        if (d2 >= diameter * diameter || d2 < 1e-8) return;
        const d = Math.sqrt(d2);
        const overlap = diameter - d;
        const nx = dx / d;
        const nz = dz / d;
        // Split the correction by inverse mass. Mounted/foot is baked per soldier at
        // spawn: resolving the unit and then its type for both members of every
        // neighbour pair was the single most expensive thing in the tick.
        const mi = this.mounted[i] ? 5 : 1;
        const mj = this.mounted[j] ? 5 : 1;
        const total = mi + mj;
        const si = (overlap * (mj / total)) * 0.5;
        const sj = (overlap * (mi / total)) * 0.5;
        pushX -= nx * si;
        pushZ -= nz * si;
        p.x[j] += nx * sj;
        p.z[j] += nz * sj;
      });

      p.x[i] += pushX;
      p.z[i] += pushZ;
    }
    void dt;
  }

  /** 1 if this soldier is mounted. Set at spawn; read in the crowd-separation inner loop. */
  private mounted!: Uint8Array;

  /** Cache of soldier index -> unit, rebuilt lazily. */
  private soldierUnitCache: (UnitGroupState | undefined)[] = [];
  private unitOfSoldier(i: number): UnitGroupState | undefined {
    let u = this.soldierUnitCache[i];
    if (u && u.id === this.pool.unitId[i]) return u;
    u = this.unitById(this.pool.unitId[i]);
    this.soldierUnitCache[i] = u;
    return u;
  }

  private integrate(dt: number): void {
    const p = this.pool;
    const n = p.count;
    for (let i = 0; i < n; i++) {
      const st = p.state[i] as SoldierState;
      if (st === SoldierState.Dead) continue;

      p.x[i] += p.vx[i] * dt;
      p.z[i] += p.vz[i] * dt;

      const ground = this.groundAt(p.x[i], p.z[i]);
      // Feet stay planted; the vertical is snapped rather than simulated for the living.
      p.y[i] = st === SoldierState.Dying ? Math.max(ground, p.y[i] - 1.8 * dt) : ground;

      // Face the direction of travel, but only once actually moving.
      const speed = Math.hypot(p.vx[i], p.vz[i]);
      if (speed > 0.22 && st !== SoldierState.Fighting) {
        const want = Math.atan2(p.vx[i], p.vz[i]);
        p.facing[i] = turnToward(p.facing[i], want, dt * 7.5);
      }
      // Lean into acceleration for weight.
      const targetLean = clamp(speed * 0.055, 0, 0.16);
      p.lean[i] = damp(p.lean[i], targetLean, 6, dt);
    }
  }

  /**
   * Choose a melee clip for a man who is fighting.
   *
   * Every fighting man used to play `AttackThrust`, which meant a thousand-man melee was
   * a thousand identical underarm stabs — and it left `AttackOverhead`, `AttackSlash`,
   * `ShieldBash`, `Block` and `Parry` authored, baked and never once selected.
   *
   * The choice is driven by the weapon, because the weapon really does dictate the
   * stroke: a gladius behind a scutum is a short thrust into the gap, a Germanic axe or a
   * long spatha is swung overhead, and a spear is levelled. Within that, the man's stable
   * per-man hash picks a variant so neighbours differ, and men who are engaged but not
   * currently swinging defend instead of attacking — which is what actually happens in a
   * press, and what makes a line read as fighting rather than as a row of windmills.
   */
  private meleeClipFor(i: number): Clip {
    const p = this.pool;
    const u = this.unitOfSoldier(i);
    const weapon = u ? this.typeOf(u).appearance.weapon : 'gladius';
    const v = p.variant[i];

    // Only a fraction of an engaged rank is mid-stroke at any instant; the rest are
    // covering, recovering or shoving. `attackCooldown` is the sim's own notion of that.
    const swinging = p.attackCooldown[i] <= 0.42;
    if (!swinging) {
      // Split the non-swinging men between a braced guard and an active parry so the
      // defensive half of the line is not uniform either.
      return v < 0.62 ? Clip.Block : Clip.Parry;
    }

    switch (weapon) {
      case 'axe':
      case 'club':
        // Overhead is the natural axe stroke; occasionally a wide slash.
        return v < 0.72 ? Clip.AttackOverhead : Clip.AttackSlash;
      case 'spatha':
        return v < 0.45 ? Clip.AttackSlash : v < 0.85 ? Clip.AttackOverhead : Clip.AttackThrust;
      case 'spear':
      case 'pike':
        // A spear is thrust, always — a levelled point is the whole reason to carry one.
        return Clip.AttackThrust;
      case 'gladius':
      default:
        // Shield-forward fighting: mostly the short thrust, with the boss used as a
        // weapon often enough to see it happen.
        return v < 0.68 ? Clip.AttackThrust : v < 0.86 ? Clip.ShieldBash : Clip.AttackSlash;
    }
  }

  /** Pick the clip each soldier should be playing and advance its playhead. */
  private updateAnimationState(dt: number, ctx: EngineContext): void {
    const p = this.pool;
    const n = p.count;

    for (let i = 0; i < n; i++) {
      const st = p.state[i] as SoldierState;
      p.stateTime[i] += dt;

      if (st === SoldierState.Dead) continue;

      let clip: Clip;
      let rateScale = 1;
      const speed = Math.hypot(p.vx[i], p.vz[i]);

      switch (st) {
        case SoldierState.Dying:
          clip = (Clip.DeathBack + (p.deathVariant[i] % 4)) as Clip;
          break;
        case SoldierState.Fighting:
          clip = this.meleeClipFor(i);
          break;
        case SoldierState.Bracing:
          clip = Clip.IdleBrace;
          break;
        case SoldierState.Routing:
          clip = Clip.Flee;
          rateScale = clamp(speed / 4.2, 0.7, 1.5);
          break;
        case SoldierState.Charging:
          clip = Clip.Charge;
          rateScale = clamp(speed / 5.0, 0.75, 1.4);
          break;
        case SoldierState.Throwing:
          clip = Clip.ThrowPilum;
          break;
        case SoldierState.Shooting:
          clip = Clip.ReleaseBow;
          break;
        case SoldierState.Staggered:
          clip = Clip.Stagger;
          break;
        default: {
          if (speed > 2.6) {
            clip = Clip.Run;
            rateScale = clamp(speed / 3.6, 0.75, 1.45);
          } else if (speed > 0.28) {
            clip = Clip.March;
            rateScale = clamp(speed / 1.55, 0.6, 1.5);
          } else {
            const u = this.unitOfSoldier(i);
            const pose = u ? formation(u.formationId).idlePose : 'alert';
            clip = pose === 'brace' ? Clip.IdleBrace : pose === 'relaxed' ? Clip.IdleRelaxed : Clip.IdleAlert;
          }
        }
      }

      if (p.animClip[i] !== clip) {
        p.animPrevClip[i] = p.animClip[i];
        p.animPrevTime[i] = p.animTime[i];
        p.animBlend[i] = 0;
        p.animClip[i] = clip;
        // Locomotion clips resume mid-cycle so a stop-start never resets the gait.
        p.animTime[i] = clip === Clip.March || clip === Clip.Run ? p.animTime[i] : 0;
      }

      // Cross-fade over ~0.18 s.
      if (p.animBlend[i] < 1) p.animBlend[i] = Math.min(1, p.animBlend[i] + dt / 0.18);

      const loop = st !== SoldierState.Dying;
      const adv = dt * p.animRate[i] * rateScale;
      p.animTime[i] += adv;
      if (loop) {
        if (p.animTime[i] >= 1) p.animTime[i] -= Math.floor(p.animTime[i]);
      } else if (p.animTime[i] >= 1) {
        p.animTime[i] = 1;
        // Death animation finished — become a corpse.
        p.state[i] = SoldierState.Dead;
      }
      p.animPrevTime[i] = (p.animPrevTime[i] + adv) % 1;
    }
    void ctx;
  }

  /**
   * Apply damage to a soldier. Returns true if the blow was lethal.
   * The combat subsystem calls this; it is the single place a man can die.
   */
  damage(i: number, amount: number, fromX: number, fromZ: number, attackerUnitId: number): boolean {
    const p = this.pool;
    if (!p.aliveAt(i)) return false;
    p.hp[i] -= amount;
    p.grime[i] = clamp01(p.grime[i] + amount * 0.004);
    if (p.hp[i] > 0) return false;

    const dx = p.x[i] - fromX;
    const dz = p.z[i] - fromZ;
    const l = Math.hypot(dx, dz) || 1;
    p.deathDirX[i] = dx / l;
    p.deathDirZ[i] = dz / l;
    p.setState(i, SoldierState.Dying);
    p.vx[i] = (dx / l) * 1.4;
    p.vz[i] = (dz / l) * 1.4;
    p.target[i] = -1;

    const killer = this.unitById(attackerUnitId);
    if (killer) killer.kills++;

    this.ctx.events.emit('soldierDied', {
      x: p.x[i], y: p.y[i], z: p.z[i],
      unitId: p.unitId[i], faction: p.faction[i], index: i,
    });
    return true;
  }

  /** Break a unit. Idempotent. */
  rout(u: UnitGroupState): void {
    if (u.order === UnitOrder.Rout || u.destroyed) return;
    u.order = UnitOrder.Rout;
    u.routTimer = 0;
    u.targetUnitId = -1;
    u.waypoints.length = 0;
    const p = this.pool;
    for (const i of u.members) {
      if (p.aliveAt(i)) p.setState(i, SoldierState.Routing);
    }
    this.ctx.events.emit('unitRouted', { unitId: u.id, faction: u.faction });
  }

  /**
   * Bring a broken unit back into order. The counterpart to `rout`, called by the morale
   * system once a routed unit has got clear, recovered its nerve and is not being chased.
   */
  rally(u: UnitGroupState): void {
    if (u.destroyed || u.order !== UnitOrder.Rout) return;
    u.order = UnitOrder.Hold;
    u.routTimer = 0;
    u.contactLock = false;
    u.charging = false;
    u.targetX = u.x;
    u.targetZ = u.z;
    const p = this.pool;
    for (const i of u.members) {
      if (p.aliveAt(i)) p.setState(i, SoldierState.Idle);
    }
    // Re-form on the spot rather than teleporting back to the line.
    this.setFormation(u, u.formationId);
    this.ctx.events.emit('unitRallied', { unitId: u.id, faction: u.faction });
  }

  /** Units of a faction that are still fighting. */
  activeUnits(faction?: Faction): UnitGroupState[] {
    return this.units.filter(
      (u) => !u.destroyed && (faction === undefined || u.faction === faction) && u.order !== UnitOrder.Rout
    );
  }

  /** Interpolated render position for a soldier, using the frame's `alpha`. */
  renderPos(i: number, alpha: number, out: { x: number; y: number; z: number }): void {
    const p = this.pool;
    out.x = p.px[i] + (p.x[i] - p.px[i]) * alpha;
    out.y = p.py[i] + (p.y[i] - p.py[i]) * alpha;
    out.z = p.pz[i] + (p.z[i] - p.pz[i]) * alpha;
  }

  renderFacing(i: number, alpha: number): number {
    const p = this.pool;
    return p.prevFacing[i] + wrapAngle(p.facing[i] - p.prevFacing[i]) * alpha;
  }
}
