import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from './BattleSystem';
import { SoldierState, UnitOrder } from './types';
import type { SoldierPool, UnitGroupState, UnitTypeDef, WeaponKind } from './types';
import { formation } from './formations';
import { clamp01, closestOnSegment } from '../util/math';
import { hash01 } from '../util/rand';
import type { Rng } from '../util/rand';
import {
  ARMOUR_BITE, armourReduction, modsOf, shieldCoverage, signalsOf,
} from './combatShared';

/**
 * Missiles: real ballistics, ragged volleys, and arrows you can see stuck in the turf
 * afterwards.
 *
 * Trajectories are integrated with gravity and quadratic drag from a pooled set of
 * typed arrays — never an object per arrow, because a single archer unit puts a
 * hundred in the air at once and an arrow storm several times that.
 *
 * Launch is solved for the target's *predicted* position. `arc: 'high'` (bows, slings)
 * lofts at a fixed pleasing elevation and varies draw weight, which is what real
 * archers do and what makes the trajectory read as an arc rather than a laser.
 * `arc: 'flat'` (pila, javelins, bolts) takes the low ballistic root at full power.
 *
 * Two things that matter more than they sound:
 *   - **Misses must land plausibly.** Scatter grows with range, movement and fatigue,
 *     and every miss buries itself in the ground where it fell. A field stubbled with
 *     spent arrows and pila is one of Rome II's signatures.
 *   - **Flat trajectories cannot pass through your own men.** Only the men with a
 *     clear lane throw. Arrows lofted over the front rank mostly clear it, so they
 *     only check the man immediately ahead.
 */

// ---------------------------------------------------------------------------
// Physical parameters per weapon
// ---------------------------------------------------------------------------

interface MissilePhysics {
  /** Muzzle / release speed in metres per second at full power. */
  speed: number;
  /** Quadratic drag coefficient, 1/m: a = -k·|v|·v. */
  drag: number;
  /** Shaft length in metres, for rendering. */
  length: number;
  /**
   * Range compensation. The launch solve is drag-free, so we aim past the target by
   * this fraction per metre; tuned so the mean impact lands on the target at range.
   */
  dragComp: number;
  event: 'pilum' | 'arrow' | 'javelin' | 'sling' | 'bolt';
}

const PHYSICS: Record<string, MissilePhysics> = {
  bow: { speed: 55, drag: 0.0026, length: 0.72, dragComp: 0.0016, event: 'arrow' },
  sling: { speed: 32, drag: 0.0020, length: 0.10, dragComp: 0.0012, event: 'sling' },
  javelin: { speed: 24, drag: 0.0013, length: 1.55, dragComp: 0.0007, event: 'javelin' },
  framea: { speed: 23, drag: 0.0014, length: 1.45, dragComp: 0.0007, event: 'javelin' },
  pilum: { speed: 21, drag: 0.0011, length: 1.95, dragComp: 0.0004, event: 'pilum' },
  bolt: { speed: 78, drag: 0.0011, length: 0.62, dragComp: 0.0009, event: 'bolt' },
  // A one-talent onager stone is about 26 kg. Vitruvius X.11 gives the sling length and
  // arm travel; the muzzle velocity that follows puts a stone of that mass out to roughly
  // 220 m, which is the range in the unit definition. Very low drag for its speed because
  // the ballistic coefficient of a rounded 26 kg tufa ball is enormous next to an arrow's.
  boulder: { speed: 46, drag: 0.00022, length: 0.44, dragComp: 0.0003, event: 'sling' },
};

const physicsOf = (kind: WeaponKind): MissilePhysics => PHYSICS[kind] ?? PHYSICS.javelin;

const GRAVITY = 9.81;
/** Elevation a lofted shot is fired at, in radians (34 degrees). */
const LOFT = 0.6;
/** Soldier torso radius for a projectile intersection, metres. */
const HIT_RADIUS = 0.4;
/** Top of the hittable volume above a man's feet. */
const HIT_TOP = 1.85;
/** Seconds of flight before a projectile can hit anyone, so nobody shoots himself. */
const ARM_TIME = 0.06;

const MAX_PROJECTILES = 2600;
const MAX_STUCK = 1400;
/** Of those, how many may be tracking a shield rather than planted in the ground. */
const MAX_ATTACHED = 260;

const enum Phase {
  Idle = 0,
  Aiming = 1,
  Releasing = 2,
  Reloading = 3,
}

/** Seconds spent drawing / winding up before a volley leaves. */
const AIM_TIME = 0.55;
/** Width of a normal ragged volley's release window, seconds. */
const RAGGED_WINDOW = 0.8;
/** Width of a commanded volley's release window. */
const TIGHT_WINDOW = 0.16;

// ---------------------------------------------------------------------------
// Module-scope scratch for the hash callbacks.
// ---------------------------------------------------------------------------

let POOL: SoldierPool | null = null;

/** Line-of-fire probe: is one of our own men standing in the lane? */
let LOS_X = 0;
let LOS_Z = 0;
let LOS_Y = 0;
let LOS_FACTION = 0;
let LOS_SELF = -1;
let LOS_BLOCKED = false;

const losVisit = (j: number): void => {
  if (LOS_BLOCKED) return;
  const p = POOL!;
  if (j === LOS_SELF) return;
  if (p.faction[j] !== LOS_FACTION) return;
  const st = p.state[j];
  if (st === SoldierState.Dead || st === SoldierState.Dying) return;
  const dx = p.x[j] - LOS_X;
  const dz = p.z[j] - LOS_Z;
  if (dx * dx + dz * dz > 0.34) return;
  // Only a man tall enough to be in the way actually blocks the lane.
  if (LOS_Y < p.y[j] + 0.3 || LOS_Y > p.y[j] + HIT_TOP) return;
  LOS_BLOCKED = true;
};

/** Flight collision: earliest soldier along this tick's flight segment. */
let SEG_X0 = 0;
let SEG_Z0 = 0;
let SEG_Y0 = 0;
let SEG_X1 = 0;
let SEG_Z1 = 0;
let SEG_Y1 = 0;
let SEG_BEST_T = 2;
let SEG_BEST = -1;

const segmentVisit = (j: number): void => {
  const p = POOL!;
  const st = p.state[j];
  if (st === SoldierState.Dead || st === SoldierState.Dying) return;
  const t = closestOnSegment(p.x[j], p.z[j], SEG_X0, SEG_Z0, SEG_X1, SEG_Z1);
  if (t >= SEG_BEST_T) return;
  const cx = SEG_X0 + (SEG_X1 - SEG_X0) * t;
  const cz = SEG_Z0 + (SEG_Z1 - SEG_Z0) * t;
  const dx = cx - p.x[j];
  const dz = cz - p.z[j];
  if (dx * dx + dz * dz > HIT_RADIUS * HIT_RADIUS) return;
  const cy = SEG_Y0 + (SEG_Y1 - SEG_Y0) * t;
  const foot = p.y[j];
  if (cy < foot - 0.05 || cy > foot + HIT_TOP) return;
  SEG_BEST_T = t;
  SEG_BEST = j;
};

// ---------------------------------------------------------------------------

const tmpMat = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3(1, 1, 1);
const tmpDir = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class ProjectileSystem implements Subsystem {
  readonly name = 'projectiles';
  readonly order = 25;

  private battle!: BattleSystem;
  private ctx!: EngineContext;
  private rng!: Rng;
  /**
   * The city, if there is one, for the masonry collision test. Duck-typed and optional so
   * a battle on open ground — and every unit test — needs no city at all.
   */
  private city: { masonryTopAt(x: number, z: number): number } | null = null;

  // ---- projectile pool (structure of arrays) ----
  private px = new Float32Array(MAX_PROJECTILES);
  private py = new Float32Array(MAX_PROJECTILES);
  private pz = new Float32Array(MAX_PROJECTILES);
  /** Position at the start of this tick, for the swept collision test and interpolation. */
  private ox = new Float32Array(MAX_PROJECTILES);
  private oy = new Float32Array(MAX_PROJECTILES);
  private oz = new Float32Array(MAX_PROJECTILES);
  private vx = new Float32Array(MAX_PROJECTILES);
  private vy = new Float32Array(MAX_PROJECTILES);
  private vz = new Float32Array(MAX_PROJECTILES);
  private life = new Float32Array(MAX_PROJECTILES);
  private dmg = new Float32Array(MAX_PROJECTILES);
  private apDmg = new Float32Array(MAX_PROJECTILES);
  private drag = new Float32Array(MAX_PROJECTILES);
  private len = new Float32Array(MAX_PROJECTILES);
  private kindIdx = new Uint8Array(MAX_PROJECTILES);
  private ownerUnit = new Int32Array(MAX_PROJECTILES);
  /**
   * 1 when the man who loosed this was standing on a structure rather than the ground.
   *
   * Carried on the projectile because the shooter's index is not kept and he may be dead
   * by the time it lands. It is the only honest way to answer "did the garrison kill
   * anybody", which is the assertion the siege probe is built around.
   */
  private fromWall = new Uint8Array(MAX_PROJECTILES);
  private alive = new Uint8Array(MAX_PROJECTILES);
  private freeList = new Int32Array(MAX_PROJECTILES);
  private freeCount = 0;
  private highWater = 0;
  private liveCount = 0;

  /** Distinct missile kinds, so a projectile can carry a one-byte kind index. */
  private kinds: WeaponKind[] = [];

  // ---- spent projectiles ----
  private sx = new Float32Array(MAX_STUCK);
  private sy = new Float32Array(MAX_STUCK);
  private sz = new Float32Array(MAX_STUCK);
  /** Frozen direction of travel, normalised. */
  private sdx = new Float32Array(MAX_STUCK);
  private sdy = new Float32Array(MAX_STUCK);
  private sdz = new Float32Array(MAX_STUCK);
  private slen = new Float32Array(MAX_STUCK);
  /** Soldier this one is stuck in, or -1 for planted in the ground. */
  private sAttach = new Int32Array(MAX_STUCK);
  /** Offset from the soldier's origin, in his local frame. */
  private sOffX = new Float32Array(MAX_STUCK);
  private sOffY = new Float32Array(MAX_STUCK);
  private sOffZ = new Float32Array(MAX_STUCK);
  private stuckCount = 0;
  private stuckCursor = 0;
  private attachedCount = 0;

  // ---- per-unit volley state, indexed by unit id ----
  private phase = new Uint8Array(0);
  private timer = new Float32Array(0);
  private targetUnit = new Int32Array(0);
  private window = new Float32Array(0);
  private reload = new Float32Array(0);
  private serial = new Int32Array(0);
  /** Volley serial a soldier last fired in. */
  private firedSerial = new Int32Array(0);
  private nextSerial = 1;

  // ---- rendering ----
  private flightMesh?: THREE.InstancedMesh;
  private stuckMesh?: THREE.InstancedMesh;
  private geometry?: THREE.BufferGeometry;
  private material?: THREE.Material;

  lastCostMs = 0;

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.battle = ctx.get<BattleSystem>('battle');
    this.rng = this.battle.rng.fork('projectiles');
    POOL = this.battle.pool;
    const city = ctx.tryGet('city') as unknown as { masonryTopAt?: (x: number, z: number) => number } | undefined;
    this.city = city && typeof city.masonryTopAt === 'function'
      ? (city as { masonryTopAt(x: number, z: number): number })
      : null;

    this.firedSerial = new Int32Array(this.battle.pool.capacity);
    this.growUnits(64);
    for (let i = MAX_PROJECTILES - 1; i >= 0; i--) this.freeList[this.freeCount++] = i;

    this.buildMeshes(ctx);
  }

  private growUnits(n: number): void {
    if (this.phase.length >= n) return;
    const size = Math.max(n, this.phase.length * 2, 64);
    const u8 = new Uint8Array(size); u8.set(this.phase); this.phase = u8;
    const t = new Float32Array(size); t.set(this.timer); this.timer = t;
    const tu = new Int32Array(size).fill(-1); tu.set(this.targetUnit); this.targetUnit = tu;
    const w = new Float32Array(size); w.set(this.window); this.window = w;
    const r = new Float32Array(size); r.set(this.reload); this.reload = r;
    const s = new Int32Array(size); s.set(this.serial); this.serial = s;
  }

  private kindIndexOf(kind: WeaponKind): number {
    let k = this.kinds.indexOf(kind);
    if (k < 0) {
      k = this.kinds.length;
      this.kinds.push(kind);
    }
    return k;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  fixedUpdate(dt: number, ctx: EngineContext): void {
    const t0 = performance.now();
    POOL = this.battle.pool;
    const units = this.battle.units;
    let maxId = 0;
    for (let k = 0; k < units.length; k++) if (units[k].id > maxId) maxId = units[k].id;
    this.growUnits(maxId + 1);

    for (let k = 0; k < units.length; k++) {
      const u = units[k];
      if (u.destroyed) continue;
      this.updateVolley(u, dt);
    }
    this.integrate(dt);
    void ctx;
    this.lastCostMs = performance.now() - t0;
  }

  /** The volley state machine: aim, release raggedly, reload, repeat. */
  private updateVolley(u: UnitGroupState, dt: number): void {
    const b = this.battle;
    const def = b.typeOf(u);
    const m = def.missile;
    const id = u.id;
    if (!m) return;

    const mods = modsOf(id);
    const sig = signalsOf(id);
    const routing = u.order === UnitOrder.Rout;
    const inMelee = sig.contactLock || sig.engagedFraction > 0.18;

    if (routing || inMelee || u.alive === 0) {
      this.phase[id] = Phase.Idle;
      this.timer[id] = 0;
      return;
    }

    // ---- pick a target formation ----
    if (this.phase[id] === Phase.Idle || this.phase[id] === Phase.Reloading) {
      let best = -1;
      let bestD = m.range;
      const units = b.units;
      for (let k = 0; k < units.length; k++) {
        const o = units[k];
        if (o.destroyed || o.faction === u.faction || o.alive === 0) continue;
        const d = Math.hypot(o.x - u.x, o.z - u.z);
        if (d < bestD) {
          bestD = d;
          best = o.id;
        }
      }
      this.targetUnit[id] = best;
    }

    const ordered = mods.orderedVolleys > 0;
    const canFire = this.targetUnit[id] >= 0 && (mods.fireAtWill || ordered) && u.ammo > 0;

    switch (this.phase[id] as Phase) {
      case Phase.Idle:
        if (canFire) {
          this.phase[id] = Phase.Aiming;
          this.timer[id] = 0;
          this.setUnitState(u, m.kind === 'bow' || m.kind === 'sling'
            ? SoldierState.Shooting : SoldierState.Throwing);
        }
        break;

      case Phase.Aiming: {
        this.timer[id] += dt;
        if (!canFire) {
          this.phase[id] = Phase.Idle;
          this.timer[id] = 0;
          break;
        }
        if (this.timer[id] >= AIM_TIME * (ordered ? 0.6 : 1)) {
          this.phase[id] = Phase.Releasing;
          this.timer[id] = 0;
          this.serial[id] = this.nextSerial++;
          this.window[id] = mods.tightVolley || ordered ? TIGHT_WINDOW : RAGGED_WINDOW;
          if (ordered) mods.orderedVolleys--;
          let count = 0;
          const p = b.pool;
          for (let k = 0; k < u.members.length; k++) {
            const i = u.members[k];
            if (p.aliveAt(i) && p.ammo[i] > 0) count++;
          }
          if (count > 0) {
            this.ctx.events.emit('volleyFired', {
              x: u.x, y: b.groundAt(u.x, u.z) + 1.5, z: u.z,
              count, kind: physicsOf(m.kind).event,
            });
          }
        }
        break;
      }

      case Phase.Releasing: {
        this.timer[id] += dt;
        const win = this.window[id];
        const target = this.unitById(this.targetUnit[id]);
        if (target && target.alive > 0) {
          const p = b.pool;
          const serial = this.serial[id];
          for (let k = 0; k < u.members.length; k++) {
            const i = u.members[k];
            if (this.firedSerial[i] === serial) continue;
            if (!p.aliveAt(i) || p.ammo[i] === 0) continue;
            if (p.state[i] === SoldierState.Fighting) continue;
            // Every man's own release moment inside the window — this is what makes
            // a volley ragged instead of a single wall of arrows.
            const offset = hash01(i, serial & 0xffff) * win;
            if (this.timer[id] < offset) continue;
            this.firedSerial[i] = serial;
            this.launch(i, u, def.missile!, target, mods.volleyPower);
          }
        }
        if (this.timer[id] >= win + 0.12) {
          this.phase[id] = Phase.Reloading;
          this.timer[id] = 0;
          const rate = Math.max(0.5, m.rate * mods.missileRate);
          this.reload[id] = (60 / rate) * (1 + u.fatigue * 0.5);
          this.refreshAmmo(u);
          this.setUnitState(u, SoldierState.Idle);
        }
        break;
      }

      case Phase.Reloading:
        this.timer[id] += dt;
        if (this.timer[id] >= this.reload[id]) {
          this.phase[id] = Phase.Idle;
          this.timer[id] = 0;
        }
        break;
    }
  }

  /** Put a whole unit into a state without disturbing anyone locked in melee. */
  private setUnitState(u: UnitGroupState, state: SoldierState): void {
    const p = this.battle.pool;
    for (let k = 0; k < u.members.length; k++) {
      const i = u.members[k];
      if (!p.aliveAt(i)) continue;
      const st = p.state[i];
      if (st === SoldierState.Fighting || st === SoldierState.Routing
        || st === SoldierState.Staggered) continue;
      p.setState(i, state);
    }
  }

  private refreshAmmo(u: UnitGroupState): void {
    const p = this.battle.pool;
    let total = 0;
    let n = 0;
    for (let k = 0; k < u.members.length; k++) {
      const i = u.members[k];
      if (!p.aliveAt(i)) continue;
      total += p.ammo[i];
      n++;
    }
    u.ammo = n > 0 ? Math.round(total / n) : 0;
  }

  // -------------------------------------------------------------------------
  // Launch
  // -------------------------------------------------------------------------

  private launch(
    i: number,
    u: UnitGroupState,
    m: NonNullable<UnitTypeDef['missile']>,
    target: UnitGroupState,
    power: number
  ): void {
    const b = this.battle;
    const p = b.pool;
    const phys = physicsOf(m.kind);

    // ---- choose a man to shoot at ----
    // Three candidates, nearest wins: arcing fire spreads over the formation, flat
    // fire concentrates on whoever is closest, which is how both actually behave.
    let t = -1;
    let bestD2 = Infinity;
    const members = target.members;
    for (let a = 0; a < 3; a++) {
      const cand = members[this.rng.int(0, members.length - 1)];
      if (!p.aliveAt(cand)) continue;
      const dx = p.x[cand] - p.x[i];
      const dz = p.z[cand] - p.z[i];
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        t = cand;
      }
    }
    if (t < 0) return;

    const sx = p.x[i];
    const sy = p.y[i] + 1.45;
    const sz = p.z[i];

    // ---- predicted aim point, two passes ----
    let tx = p.x[t];
    let tz = p.z[t];
    let d = Math.hypot(tx - sx, tz - sz);
    if (d > m.range * 1.08 || d < 1.5) return;
    let tof = d / Math.max(6, phys.speed * 0.8);
    for (let pass = 0; pass < 2; pass++) {
      tx = p.x[t] + p.vx[t] * tof;
      tz = p.z[t] + p.vz[t] * tof;
      d = Math.hypot(tx - sx, tz - sz);
      tof = d / Math.max(6, phys.speed * 0.8);
    }
    // Aim at the man, not at the ground he is nominally over. This read used to be
    // `groundAt(tx, tz) + 1.0`, which is the same answer for everybody standing on the
    // terrain and wrong by the full height of the masonry for anybody on a wall: every
    // arrow shot at a garrison was solved for a point 7 m below him and buried itself in
    // the brickwork, and every arrow shot *by* one was solved for a point at its own
    // feet. Predicted forward the same way the XZ aim point is, so a man walking a
    // boarding ramp is led correctly in all three axes.
    const ty = p.y[t] + p.vy[t] * tof + 1.0;

    // ---- line of fire ----
    const dirX = (tx - sx) / (d || 1);
    const dirZ = (tz - sz) / (d || 1);
    const lofted = m.arc === 'high';
    const probes = lofted ? 1 : 3;
    LOS_FACTION = u.faction;
    LOS_SELF = i;
    LOS_BLOCKED = false;
    for (let k = 1; k <= probes; k++) {
      const dist = k * 1.5;
      if (dist > d) break;
      LOS_X = sx + dirX * dist;
      LOS_Z = sz + dirZ * dist;
      // Height along a straight line to the aim point is a good enough proxy over
      // the couple of metres that matter for a blocked lane.
      LOS_Y = sy + (ty - sy) * (dist / d) + (lofted ? dist * 0.5 : 0);
      b.hash.query(LOS_X, LOS_Z, 0.6, losVisit);
      if (LOS_BLOCKED) break;
    }
    if (LOS_BLOCKED) return;

    // ---- ballistic solve ----
    const h = ty - sy;
    const dComp = d * (1 + phys.dragComp * d);
    let v = phys.speed;
    let theta: number;
    if (lofted) {
      // Loft at a fixed elevation and draw only as hard as the range needs.
      const c = Math.cos(LOFT);
      const need = (GRAVITY * dComp * dComp) / (2 * c * c * (dComp * Math.tan(LOFT) - h));
      if (need > 0 && need <= v * v) {
        v = Math.sqrt(need);
        theta = LOFT;
      } else {
        theta = this.lowRoot(v, dComp, h);
      }
    } else {
      theta = this.lowRoot(v, dComp, h);
    }

    // ---- accuracy ----
    const moving = Math.hypot(p.vx[i], p.vz[i]) > 0.5 ? 1 : 0;
    const mods = modsOf(u.id);
    const spread = m.accuracy * mods.missileSpread
      * (1 + 0.9 * (d / m.range))
      * (1 + 0.5 * p.fatigue[i])
      * (1 + 0.8 * moving);
    const yaw = Math.atan2(dirX, dirZ) + this.rng.normal(0, spread);
    const pitch = theta + this.rng.normal(0, spread * 0.8);

    const idx = this.spawn();
    if (idx < 0) return;
    const cp = Math.cos(pitch);
    this.px[idx] = sx; this.py[idx] = sy; this.pz[idx] = sz;
    this.ox[idx] = sx; this.oy[idx] = sy; this.oz[idx] = sz;
    this.vx[idx] = v * cp * Math.sin(yaw);
    this.vy[idx] = v * Math.sin(pitch);
    this.vz[idx] = v * cp * Math.cos(yaw);
    this.life[idx] = 0;
    this.dmg[idx] = m.damage * power;
    this.apDmg[idx] = m.apDamage * power;
    this.drag[idx] = phys.drag;
    this.len[idx] = phys.length;
    this.kindIdx[idx] = this.kindIndexOf(m.kind);
    this.ownerUnit[idx] = u.id;
    const elevated = b.elevated[i] !== 0;
    this.fromWall[idx] = elevated ? 1 : 0;
    if (elevated) b.siege.noteWallShot();
    if (m.kind === 'boulder') b.siege.noteArtillery(1, 0);

    if (p.ammo[i] > 0) p.ammo[i]--;
  }

  /**
   * Throw one projectile from an arbitrary point at an arbitrary point.
   *
   * The volley state machine above is built around a unit of men each shooting at a man,
   * which is not what a siege engine is: an onager is one machine served by a crew, it
   * shoots at a *place* — a stretch of parapet, a gate, a knot of men — and it does so on
   * its own clock. Rather than bend the volley machine into a shape that fits both, this
   * exposes the ballistics, the pool and the collision sweep directly.
   *
   * Returns false when the pool is full or the solve has no answer at this range.
   */
  launchBallistic(opts: {
    kind: WeaponKind;
    fromX: number; fromY: number; fromZ: number;
    toX: number; toY: number; toZ: number;
    damage: number; apDamage: number;
    /** Angular scatter, radians. Applied to yaw and, at 0.8x, to pitch. */
    spread: number;
    ownerUnit: number;
    /** Draw from a forked stream so the caller keeps determinism under its own control. */
    rng: Rng;
    /** Loft it like a stone-thrower rather than taking the flat root. */
    lofted?: boolean;
  }): boolean {
    const phys = physicsOf(opts.kind);
    const dx = opts.toX - opts.fromX;
    const dz = opts.toZ - opts.fromZ;
    const d = Math.hypot(dx, dz);
    if (d < 1) return false;
    const h = opts.toY - opts.fromY;
    const dComp = d * (1 + phys.dragComp * d);
    let v = phys.speed;
    let theta: number;
    if (opts.lofted) {
      const c = Math.cos(LOFT);
      const need = (GRAVITY * dComp * dComp) / (2 * c * c * (dComp * Math.tan(LOFT) - h));
      if (need > 0 && need <= v * v) {
        v = Math.sqrt(need);
        theta = LOFT;
      } else {
        theta = this.lowRoot(v, dComp, h);
      }
    } else {
      theta = this.lowRoot(v, dComp, h);
    }

    const idx = this.spawn();
    if (idx < 0) return false;
    const yaw = Math.atan2(dx / d, dz / d) + opts.rng.normal(0, opts.spread);
    const pitch = theta + opts.rng.normal(0, opts.spread * 0.8);
    const cp = Math.cos(pitch);
    this.px[idx] = opts.fromX; this.py[idx] = opts.fromY; this.pz[idx] = opts.fromZ;
    this.ox[idx] = opts.fromX; this.oy[idx] = opts.fromY; this.oz[idx] = opts.fromZ;
    this.vx[idx] = v * cp * Math.sin(yaw);
    this.vy[idx] = v * Math.sin(pitch);
    this.vz[idx] = v * cp * Math.cos(yaw);
    this.life[idx] = 0;
    this.dmg[idx] = opts.damage;
    this.apDmg[idx] = opts.apDamage;
    this.drag[idx] = phys.drag;
    this.len[idx] = phys.length;
    this.kindIdx[idx] = this.kindIndexOf(opts.kind);
    this.ownerUnit[idx] = opts.ownerUnit;
    this.fromWall[idx] = 0;
    return true;
  }

  /** Flattest of the two ballistic solutions; 45 degrees when the target is out of reach. */
  private lowRoot(v: number, d: number, h: number): number {
    const v2 = v * v;
    const disc = v2 * v2 - GRAVITY * (GRAVITY * d * d + 2 * h * v2);
    if (disc <= 0) return Math.PI / 4;
    return Math.atan((v2 - Math.sqrt(disc)) / (GRAVITY * d));
  }

  private spawn(): number {
    if (this.freeCount === 0) return -1;
    const i = this.freeList[--this.freeCount];
    this.alive[i] = 1;
    this.liveCount++;
    if (i >= this.highWater) this.highWater = i + 1;
    return i;
  }

  private release(i: number): void {
    if (this.alive[i] === 0) return;
    this.alive[i] = 0;
    this.liveCount--;
    this.freeList[this.freeCount++] = i;
  }

  // -------------------------------------------------------------------------
  // Flight
  // -------------------------------------------------------------------------

  private integrate(dt: number): void {
    const b = this.battle;
    const n = this.highWater;
    for (let i = 0; i < n; i++) {
      if (this.alive[i] === 0) continue;

      const x0 = this.px[i];
      const y0 = this.py[i];
      const z0 = this.pz[i];
      this.ox[i] = x0;
      this.oy[i] = y0;
      this.oz[i] = z0;

      let vx = this.vx[i];
      let vy = this.vy[i];
      let vz = this.vz[i];
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const k = this.drag[i] * sp;
      vx -= vx * k * dt;
      vy -= (vy * k + GRAVITY) * dt;
      vz -= vz * k * dt;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;

      const x1 = x0 + vx * dt;
      const y1 = y0 + vy * dt;
      const z1 = z0 + vz * dt;
      this.px[i] = x1;
      this.py[i] = y1;
      this.pz[i] = z1;
      this.life[i] += dt;

      // ---- soldiers ----
      if (this.life[i] > ARM_TIME) {
        const midX = (x0 + x1) * 0.5;
        const midZ = (z0 + z1) * 0.5;
        const half = Math.hypot(x1 - x0, z1 - z0) * 0.5;
        SEG_X0 = x0; SEG_Z0 = z0; SEG_Y0 = y0;
        SEG_X1 = x1; SEG_Z1 = z1; SEG_Y1 = y1;
        SEG_BEST_T = 2;
        SEG_BEST = -1;
        b.hash.query(midX, midZ, half + HIT_RADIUS + 0.2, segmentVisit);
        if (SEG_BEST >= 0) {
          this.impactSoldier(i, SEG_BEST, SEG_BEST_T);
          continue;
        }
      }

      // ---- masonry ----
      // A wall is 6.5 m of brick that a shaft has to clear or stick in. Without this test
      // an arrow aimed over the parapet carried straight through the curtain and planted
      // itself in the turf on the city side, and a boulder passed through the gatehouse.
      // O(1) — see `CitySystem.masonryTopAt`.
      if (this.city !== null) {
        const top = this.city.masonryTopAt(x1, z1);
        if (y1 <= top) {
          this.impactMasonry(i, x1, Math.min(y0, top), z1);
          continue;
        }
      }

      // ---- ground ----
      const ground = b.groundAt(x1, z1);
      if (y1 <= ground) {
        this.impactGround(i, x1, ground, z1);
        continue;
      }
      // Nothing flies for ever, and nothing leaves the field.
      if (this.life[i] > 14 || Math.abs(x1) > 1390 || Math.abs(z1) > 1390) this.release(i);
    }
  }

  /**
   * A shaft or a stone striking masonry.
   *
   * Stones shatter and are gone; arrows and pila lodge in the mortar joints, which is
   * what makes a besieged wall face look besieged after a few minutes of shooting.
   */
  private impactMasonry(i: number, x: number, y: number, z: number): void {
    const weapon = this.kinds[this.kindIdx[i]];
    const kind = physicsOf(weapon).event;
    this.ctx.events.emit('projectileImpact', {
      x, y, z, kind, hitTarget: false, material: 'stone',
    });
    this.masonryHits++;
    if (weapon === 'boulder') {
      // A hundred-kilo stone does not stand up in a wall; it breaks and falls.
      this.release(i);
      return;
    }
    this.plant(i, x, y, z, -1, 0, 0, 0);
    this.release(i);
  }

  /** Missiles that have struck the city's masonry this battle. Read by the siege probe. */
  masonryHits = 0;

  private impactGround(i: number, x: number, y: number, z: number): void {
    const kind = physicsOf(this.kinds[this.kindIdx[i]]).event;
    this.ctx.events.emit('projectileImpact', {
      x, y, z, kind, hitTarget: false, material: 'ground',
    });
    this.plant(i, x, y, z, -1, 0, 0, 0);
    this.release(i);
  }

  private impactSoldier(i: number, j: number, t: number): void {
    const b = this.battle;
    const p = b.pool;
    const hx = this.ox[i] + (this.px[i] - this.ox[i]) * t;
    const hy = this.oy[i] + (this.py[i] - this.oy[i]) * t;
    const hz = this.oz[i] + (this.pz[i] - this.oz[i]) * t;
    const kind = physicsOf(this.kinds[this.kindIdx[i]]).event;

    const dv = this.unitById(p.unitId[j]);
    if (!dv) {
      this.release(i);
      return;
    }
    const ddef = b.typeOf(dv);
    const dmods = modsOf(dv.id);
    const df = formation(dv.formationId);

    // Incoming direction, from the defender's point of view.
    const sp = Math.hypot(this.vx[i], this.vz[i]) || 1;
    const bx = -this.vx[i] / sp;
    const bz = -this.vz[i] / sp;
    const cosMan = bx * Math.sin(p.facing[j]) + bz * Math.cos(p.facing[j]);
    const cover = shieldCoverage(cosMan) * df.mods.shield * dmods.shield;
    // A scutum held into a volley stops most of it; edge-on it stops nothing.
    const block = clamp01((ddef.shieldDefence / 46) * cover);

    if (ddef.shieldDefence > 4 && this.rng.next() < Math.min(0.9, block)) {
      this.ctx.events.emit('projectileImpact', {
        x: hx, y: hy, z: hz, kind, hitTarget: true, material: 'shield',
      });
      // Pila stuck in a shield are the whole point of the weapon.
      const lx = -0.28;
      this.plant(i, hx, hy, hz, j, lx, hy - p.y[j], 0.16);
      this.release(i);
      return;
    }

    const taken = df.mods.missileTaken * dmods.missileTaken;
    const through = 1 - armourReduction(ddef.armour * dmods.armour) * ARMOUR_BITE;
    const total = (this.dmg[i] * through + this.apDmg[i]) * taken * this.rng.range(0.85, 1.15);
    const lethal = b.damage(j, total, this.ox[i], this.oz[i], this.ownerUnit[i]);
    const dsig = signalsOf(dv.id);
    dsig.missilePulse += 1;
    if (lethal) {
      signalsOf(this.ownerUnit[i]).killPulse += 1;
      if (this.fromWall[i] !== 0) b.siege.noteWallKill();
      if (this.kinds[this.kindIdx[i]] === 'boulder') b.siege.noteArtillery(0, 1);
      p.vx[j] = -bx * 1.3;
      p.vz[j] = -bz * 1.3;
    }

    this.ctx.events.emit('projectileImpact', {
      x: hx, y: hy, z: hz, kind, hitTarget: true,
      material: ddef.armour > 34 ? 'armour' : 'flesh',
    });
    this.release(i);
  }

  /**
   * Keep a spent projectile on the field. Ring buffer, so the oldest shafts quietly
   * disappear once the cap is reached rather than the count growing without limit.
   */
  private plant(
    i: number, x: number, y: number, z: number,
    attach: number, offX: number, offY: number, offZ: number
  ): void {
    if (attach >= 0 && this.attachedCount >= MAX_ATTACHED) attach = -1;
    const s = this.stuckCursor;
    if (this.sAttach[s] >= 0) this.attachedCount--;
    this.stuckCursor = (s + 1) % MAX_STUCK;
    if (this.stuckCount < MAX_STUCK) this.stuckCount++;

    const sp = Math.hypot(this.vx[i], this.vy[i], this.vz[i]) || 1;
    this.sx[s] = x;
    this.sy[s] = y;
    this.sz[s] = z;
    this.sdx[s] = this.vx[i] / sp;
    this.sdy[s] = this.vy[i] / sp;
    this.sdz[s] = this.vz[i] / sp;
    this.slen[s] = this.len[i];
    this.sAttach[s] = attach;
    this.sOffX[s] = offX;
    this.sOffY[s] = offY;
    this.sOffZ[s] = offZ;
    if (attach >= 0) this.attachedCount++;
  }

  private unitById(id: number): UnitGroupState | undefined {
    const units = this.battle.units;
    for (let k = 0; k < units.length; k++) if (units[k].id === id) return units[k];
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Rendering — two instanced draw calls, whatever is in the air
  // -------------------------------------------------------------------------

  private buildMeshes(ctx: EngineContext): void {
    const geo = this.buildShaftGeometry();
    this.geometry = geo;
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.68,
      metalness: 0.2,
    });

    this.flightMesh = new THREE.InstancedMesh(geo, this.material, MAX_PROJECTILES);
    this.flightMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flightMesh.frustumCulled = false;
    this.flightMesh.castShadow = false;
    this.flightMesh.count = 0;
    this.flightMesh.name = 'projectiles-flight';
    ctx.scene.add(this.flightMesh);

    this.stuckMesh = new THREE.InstancedMesh(geo, this.material, MAX_STUCK);
    this.stuckMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.stuckMesh.frustumCulled = false;
    this.stuckMesh.castShadow = false;
    this.stuckMesh.receiveShadow = false;
    this.stuckMesh.count = 0;
    this.stuckMesh.name = 'projectiles-spent';
    ctx.scene.add(this.stuckMesh);
  }

  /**
   * A unit-length shaft lying along -Y so the head sits at the origin: the instance
   * position is then the point of impact and the shaft trails behind it. Shaft, iron
   * head and fletching are separated by vertex colour, so all kinds share one
   * material and therefore one draw call.
   */
  private buildShaftGeometry(): THREE.BufferGeometry {
    const pos: number[] = [];
    const nrm: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];

    const pushTri = (
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      cx: number, cy: number, cz: number,
      r: number, g: number, bl: number
    ): void => {
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx2 = cx - ax, vy2 = cy - ay, vz2 = cz - az;
      let nx = uy * vz2 - uz * vy2;
      let ny = uz * vx2 - ux * vz2;
      let nz = ux * vy2 - uy * vx2;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const base = pos.length / 3;
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      for (let k = 0; k < 3; k++) {
        nrm.push(nx, ny, nz);
        col.push(r, g, bl);
      }
      idx.push(base, base + 1, base + 2);
    };

    // Shaft: a 5-sided prism from y=-1 to y=-0.09.
    const R = 0.0135;
    const SEG = 5;
    for (let s = 0; s < SEG; s++) {
      const a0 = (s / SEG) * Math.PI * 2;
      const a1 = ((s + 1) / SEG) * Math.PI * 2;
      const x0 = Math.cos(a0) * R, z0 = Math.sin(a0) * R;
      const x1 = Math.cos(a1) * R, z1 = Math.sin(a1) * R;
      pushTri(x0, -1, z0, x1, -1, z1, x1, -0.09, z1, 0.42, 0.33, 0.21);
      pushTri(x0, -1, z0, x1, -0.09, z1, x0, -0.09, z0, 0.42, 0.33, 0.21);
    }
    // Iron head: a short pyramid closing on the origin.
    const HR = 0.026;
    for (let s = 0; s < SEG; s++) {
      const a0 = (s / SEG) * Math.PI * 2;
      const a1 = ((s + 1) / SEG) * Math.PI * 2;
      pushTri(
        Math.cos(a0) * HR, -0.12, Math.sin(a0) * HR,
        Math.cos(a1) * HR, -0.12, Math.sin(a1) * HR,
        0, 0, 0, 0.52, 0.55, 0.58
      );
    }
    // Fletching: two crossed vanes at the nock, visible when the camera is close.
    const FL = 0.055;
    for (let v = 0; v < 2; v++) {
      const a = v * Math.PI * 0.5;
      const fx = Math.cos(a) * FL;
      const fz = Math.sin(a) * FL;
      pushTri(0, -0.99, 0, fx, -0.95, fz, fx * 0.7, -0.82, fz * 0.7, 0.85, 0.82, 0.74);
      pushTri(0, -0.99, 0, -fx, -0.95, -fz, -fx * 0.7, -0.82, -fz * 0.7, 0.85, 0.82, 0.74);
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }

  preRender(ctx: EngineContext): void {
    const flight = this.flightMesh;
    const stuck = this.stuckMesh;
    if (!flight || !stuck) return;
    const alpha = ctx.time.alpha;

    let n = 0;
    for (let i = 0; i < this.highWater && n < MAX_PROJECTILES; i++) {
      if (this.alive[i] === 0) continue;
      const x = this.ox[i] + (this.px[i] - this.ox[i]) * alpha;
      const y = this.oy[i] + (this.py[i] - this.oy[i]) * alpha;
      const z = this.oz[i] + (this.pz[i] - this.oz[i]) * alpha;
      tmpDir.set(this.vx[i], this.vy[i], this.vz[i]);
      if (tmpDir.lengthSq() < 1e-6) tmpDir.set(0, -1, 0);
      tmpDir.normalize();
      tmpQuat.setFromUnitVectors(UP, tmpDir);
      tmpPos.set(x, y, z);
      const l = this.len[i];
      tmpScale.set(1, l, 1);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      flight.setMatrixAt(n++, tmpMat);
    }
    flight.count = n;
    flight.visible = n > 0;
    if (n > 0) flight.instanceMatrix.needsUpdate = true;

    const p = this.battle.pool;
    let sn = 0;
    for (let s = 0; s < this.stuckCount && sn < MAX_STUCK; s++) {
      const at = this.sAttach[s];
      let x = this.sx[s];
      let y = this.sy[s];
      let z = this.sz[s];
      if (at >= 0) {
        // Riding in a shield: follow the man until he falls, then let it lie.
        const f = p.facing[at];
        const c = Math.cos(f);
        const si = Math.sin(f);
        x = p.x[at] + this.sOffX[s] * c + this.sOffZ[s] * si;
        z = p.z[at] - this.sOffX[s] * si + this.sOffZ[s] * c;
        y = p.y[at] + this.sOffY[s];
      }
      tmpDir.set(this.sdx[s], this.sdy[s], this.sdz[s]);
      if (tmpDir.lengthSq() < 1e-6) tmpDir.set(0, -1, 0);
      tmpDir.normalize();
      tmpQuat.setFromUnitVectors(UP, tmpDir);
      tmpPos.set(x, y, z);
      tmpScale.set(1, this.slen[s], 1);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      stuck.setMatrixAt(sn++, tmpMat);
    }
    stuck.count = sn;
    stuck.visible = sn > 0;
    if (sn > 0) stuck.instanceMatrix.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Read API
  // -------------------------------------------------------------------------

  /** Projectiles currently in the air. */
  get inFlight(): number {
    return this.liveCount;
  }

  /** Spent shafts on the field. */
  get spent(): number {
    return this.stuckCount;
  }

  dispose(): void {
    this.flightMesh?.dispose();
    this.stuckMesh?.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    POOL = null;
  }
}
