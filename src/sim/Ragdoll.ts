import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from './BattleSystem';
import { SoldierState } from './types';
import { clamp, clamp01 } from '../util/math';
import { hash01 } from '../util/rand';

/**
 * Deaths and corpses.
 *
 * Full rigid-body ragdolls for six thousand men are not in the budget, so this runs
 * two tiers:
 *
 *   **Simulated** — a real position-based (verlet) ragdoll of eight particles and
 *   thirteen distance constraints, for the `SIM_MAX` deaths nearest the camera. These
 *   collapse over the terrain, tangle with the slope, and take the killing blow's
 *   momentum with them. This is the tier you see in a close shot.
 *
 *   **Cheap** — an integrated tip-over about the axis perpendicular to the death
 *   direction, with a rebound and a slide, for everyone else. Two dozen flops a tick.
 *
 * Both freeze into a final pose once they stop moving and then cost nothing at all,
 * which is what lets bodies pile up permanently where the fighting was heaviest.
 *
 * **This system writes nothing to `SoldierPool`.** The corpse pose lives in arrays it
 * owns and is published through `getCorpsePose` / `getCorpseJoints` so the unit
 * renderer can draw it. See the note above those methods for the exact contract.
 */

/** Corpses that get the real solve. Budgeted against the fixedUpdate ceiling. */
const SIM_MAX = 40;
/** Beyond this distance from the camera a death is never worth simulating, metres. */
const SIM_RANGE = 75;
/** Cheap falls in flight at once. Overflow settles immediately. */
const CHEAP_MAX = 900;
/** Verlet solver iterations. Four is enough for a thirteen-constraint skeleton. */
const SOLVER_ITERATIONS = 4;
const PARTICLE_RADIUS = 0.085;
const GRAVITY = 9.81;

/** Particle indices in the ragdoll skeleton, and in `getCorpseJoints` output. */
export const CORPSE_JOINTS = [
  'pelvis', 'chest', 'head', 'handL', 'handR', 'footL', 'footR', 'weaponTip',
] as const;
const P_PELVIS = 0;
const P_CHEST = 1;
const P_HEAD = 2;
const P_HANDL = 3;
const P_HANDR = 4;
const P_FOOTL = 5;
const P_FOOTR = 6;
const P_WEAPON = 7;
const PARTICLES = 8;

/** Rest layout in the man's own frame at 1.0 scale: +Y up, +Z forward, +X right. */
const REST = new Float32Array([
  0.00, 0.95, 0.00, // pelvis
  0.00, 1.34, 0.00, // chest
  0.00, 1.63, 0.00, // head
  -0.33, 1.14, 0.10, // left hand (shield)
  0.33, 1.16, 0.06, // right hand (weapon)
  -0.13, 0.06, 0.02, // left foot
  0.13, 0.06, -0.02, // right foot
  0.34, 1.30, 0.62, // weapon tip
]);

/** Constraint pairs. Deliberately over-braced: a floppy corpse reads as a bug. */
const LINKS = new Int32Array([
  P_PELVIS, P_CHEST,
  P_CHEST, P_HEAD,
  P_PELVIS, P_HEAD,
  P_CHEST, P_HANDL,
  P_CHEST, P_HANDR,
  P_HANDL, P_HANDR,
  P_PELVIS, P_FOOTL,
  P_PELVIS, P_FOOTR,
  P_FOOTL, P_FOOTR,
  P_PELVIS, P_HANDL,
  P_PELVIS, P_HANDR,
  P_HANDR, P_WEAPON,
  P_CHEST, P_WEAPON,
]);
const LINK_COUNT = LINKS.length / 2;

const enum Tier {
  None = 0,
  Cheap = 1,
  Simulated = 2,
  Settled = 3,
}

export interface CorpsePose {
  /** World position of the mesh origin — the man's feet in the standing pose. */
  x: number;
  y: number;
  z: number;
  /** Orientation as a quaternion. Includes the yaw he died facing. */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** 0 at the instant of death (still upright), 1 once the body has settled. */
  settle: number;
  /** True while the full ragdoll solve is driving this corpse. */
  simulated: boolean;
}

const HALF_PI = Math.PI / 2;

// Module-scope scratch: the pose derivation runs per corpse per tick.
const vUp = new THREE.Vector3();
const vRight = new THREE.Vector3();
const vFwd = new THREE.Vector3();
const vNormal = new THREE.Vector3();
const vTmp = new THREE.Vector3();
const mBasis = new THREE.Matrix4();
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();
const AXIS_Y = new THREE.Vector3(0, 1, 0);

export class RagdollSystem implements Subsystem {
  readonly name = 'ragdoll';
  readonly order = 120;

  private battle!: BattleSystem;
  private ctx!: EngineContext;

  // ---- per-soldier corpse state ----
  private tier = new Uint8Array(0);
  /** 8 floats per soldier: x, y, z, qx, qy, qz, qw, settle. */
  private pose = new Float32Array(0);
  /** Cheap tier: tip-over angle and its rate. */
  private angle = new Float32Array(0);
  private angVel = new Float32Array(0);
  private axisX = new Float32Array(0);
  private axisZ = new Float32Array(0);
  /** Cheap tier owns its own horizontal slide so a thrown body keeps going. */
  private cx = new Float32Array(0);
  private cz = new Float32Array(0);
  private cvx = new Float32Array(0);
  private cvz = new Float32Array(0);
  private age = new Float32Array(0);
  private bounces = new Uint8Array(0);
  /** Simulated tier: which slot, or -1. */
  private slotOf = new Int32Array(0);

  // ---- active lists ----
  private cheapList = new Int32Array(CHEAP_MAX);
  private cheapCount = 0;
  /** Soldier index occupying each sim slot, or -1. */
  private slotOwner = new Int32Array(SIM_MAX).fill(-1);
  private slotAge = new Float32Array(SIM_MAX);
  /** Particle positions: SIM_MAX * PARTICLES * 3. */
  private sp = new Float32Array(SIM_MAX * PARTICLES * 3);
  private spPrev = new Float32Array(SIM_MAX * PARTICLES * 3);
  /** Rest lengths per slot, scaled by the man's height. */
  private restLen = new Float32Array(SIM_MAX * LINK_COUNT);
  /** World-space joints copied out for `getCorpseJoints`. */
  private jointOut = new Float32Array(PARTICLES * 3);
  /** Lifetime tallies, for the debug overlay and for budgeting the sim tier. */
  private deaths = 0;
  private simulated = 0;

  lastCostMs = 0;

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.battle = ctx.get<BattleSystem>('battle');
    const cap = this.battle.pool.capacity;
    this.tier = new Uint8Array(cap);
    this.pose = new Float32Array(cap * 8);
    this.angle = new Float32Array(cap);
    this.angVel = new Float32Array(cap);
    this.axisX = new Float32Array(cap);
    this.axisZ = new Float32Array(cap);
    this.cx = new Float32Array(cap);
    this.cz = new Float32Array(cap);
    this.cvx = new Float32Array(cap);
    this.cvz = new Float32Array(cap);
    this.age = new Float32Array(cap);
    this.bounces = new Uint8Array(cap);
    this.slotOf = new Int32Array(cap).fill(-1);

    ctx.events.on('soldierDied', (e) => this.registerDeath(e.index));
  }

  // -------------------------------------------------------------------------
  // Death registration
  // -------------------------------------------------------------------------

  private registerDeath(i: number): void {
    if (i < 0 || i >= this.tier.length) return;
    if (this.tier[i] !== Tier.None) return;
    const p = this.battle.pool;

    this.age[i] = 0;
    this.bounces[i] = 0;
    this.cx[i] = p.x[i];
    this.cz[i] = p.z[i];
    this.cvx[i] = p.vx[i];
    this.cvz[i] = p.vz[i];

    // The axis perpendicular to the killing blow: rotating about it tips the head
    // in the direction the blow pushed him.
    let dx = p.deathDirX[i];
    let dz = p.deathDirZ[i];
    if (dx * dx + dz * dz < 1e-6) {
      // No recorded direction (attrition, drowning, a stray bolt): fall forward.
      dx = Math.sin(p.facing[i]);
      dz = Math.cos(p.facing[i]);
    }
    this.axisX[i] = dz;
    this.axisZ[i] = -dx;
    this.angle[i] = 0;
    // Momentum from the blow becomes rotational energy. A horse throws a man;
    // a sword leaves him folding at the knees.
    const speed = Math.hypot(p.vx[i], p.vz[i]);
    this.angVel[i] = 0.6 + speed * 0.42 + hash01(i, 17) * 0.5;

    this.deaths++;
    const slot = this.claimSlot(i);
    if (slot >= 0) {
      this.simulated++;
      this.tier[i] = Tier.Simulated;
      this.slotOf[i] = slot;
      this.seedSlot(slot, i);
      return;
    }

    if (this.cheapCount < CHEAP_MAX) {
      this.tier[i] = Tier.Cheap;
      this.cheapList[this.cheapCount++] = i;
    } else {
      // Over budget: skip straight to the settled pose so the body still lies down.
      this.tier[i] = Tier.Cheap;
      this.angle[i] = HALF_PI;
      this.angVel[i] = 0;
      this.writeCheapPose(i, 1);
      this.tier[i] = Tier.Settled;
    }
  }

  /**
   * A free ragdoll slot if this death is close enough to the camera to be worth one.
   * Camera distance is a rendering decision, not a simulation one — nothing here
   * feeds back into the soldier pool, so the battle stays bit-identical either way.
   */
  private claimSlot(i: number): number {
    const p = this.battle.pool;
    const cam = this.ctx.camera.position;
    const dx = p.x[i] - cam.x;
    const dy = p.y[i] - cam.y;
    const dz = p.z[i] - cam.z;
    if (dx * dx + dy * dy + dz * dz > SIM_RANGE * SIM_RANGE) return -1;
    for (let s = 0; s < SIM_MAX; s++) if (this.slotOwner[s] < 0) return s;
    return -1;
  }

  /** Plant the skeleton in the man's standing pose and give it his momentum. */
  private seedSlot(slot: number, i: number): void {
    const p = this.battle.pool;
    const scale = p.scale[i] || 1;
    const f = p.facing[i];
    const cf = Math.cos(f);
    const sf = Math.sin(f);
    const base = slot * PARTICLES * 3;
    const dt = 1 / 30;

    // A shove away from the blow plus a little lift, so the collapse starts moving.
    const vx = p.vx[i];
    const vz = p.vz[i];
    const vy = p.vy[i];
    const spin = this.angVel[i];

    for (let k = 0; k < PARTICLES; k++) {
      const lx = REST[k * 3] * scale;
      const ly = REST[k * 3 + 1] * scale;
      const lz = REST[k * 3 + 2] * scale;
      // Local -> world: +Z is facing, +X is right.
      const wx = p.x[i] + lx * cf + lz * sf;
      const wz = p.z[i] - lx * sf + lz * cf;
      const wy = p.y[i] + ly;
      const o = base + k * 3;
      this.sp[o] = wx;
      this.sp[o + 1] = wy;
      this.sp[o + 2] = wz;
      // Verlet velocity: higher points get more of the tipping motion.
      const lever = ly / Math.max(0.2, 1.6 * scale);
      const tipX = this.axisZ[i] * -spin * lever;
      const tipZ = this.axisX[i] * spin * lever;
      this.spPrev[o] = wx - (vx + tipX) * dt;
      this.spPrev[o + 1] = wy - vy * dt;
      this.spPrev[o + 2] = wz - (vz + tipZ) * dt;
    }

    for (let l = 0; l < LINK_COUNT; l++) {
      const a = LINKS[l * 2] * 3;
      const b = LINKS[l * 2 + 1] * 3;
      const dx = (REST[a] - REST[b]) * scale;
      const dy = (REST[a + 1] - REST[b + 1]) * scale;
      const dz = (REST[a + 2] - REST[b + 2]) * scale;
      this.restLen[slot * LINK_COUNT + l] = Math.hypot(dx, dy, dz);
    }

    this.slotOwner[slot] = i;
    this.slotAge[slot] = 0;
  }

  // -------------------------------------------------------------------------
  // Step
  // -------------------------------------------------------------------------

  fixedUpdate(dt: number, ctx: EngineContext): void {
    const t0 = performance.now();
    this.stepSimulated(dt);
    this.stepCheap(dt);
    void ctx;
    this.lastCostMs = performance.now() - t0;
  }

  private stepSimulated(dt: number): void {
    const b = this.battle;
    const damping = 0.985;
    const g = -GRAVITY * dt * dt;

    for (let slot = 0; slot < SIM_MAX; slot++) {
      const i = this.slotOwner[slot];
      if (i < 0) continue;
      this.slotAge[slot] += dt;
      const base = slot * PARTICLES * 3;

      // ---- integrate ----
      let moving = 0;
      for (let k = 0; k < PARTICLES; k++) {
        const o = base + k * 3;
        const x = this.sp[o];
        const y = this.sp[o + 1];
        const z = this.sp[o + 2];
        const vx = (x - this.spPrev[o]) * damping;
        const vy = (y - this.spPrev[o + 1]) * damping;
        const vz = (z - this.spPrev[o + 2]) * damping;
        this.spPrev[o] = x;
        this.spPrev[o + 1] = y;
        this.spPrev[o + 2] = z;
        this.sp[o] = x + vx;
        this.sp[o + 1] = y + vy + g;
        this.sp[o + 2] = z + vz;
        moving += vx * vx + vy * vy + vz * vz;
      }

      // ---- satisfy the skeleton ----
      for (let it = 0; it < SOLVER_ITERATIONS; it++) {
        for (let l = 0; l < LINK_COUNT; l++) {
          const oa = base + LINKS[l * 2] * 3;
          const ob = base + LINKS[l * 2 + 1] * 3;
          const dx = this.sp[ob] - this.sp[oa];
          const dy = this.sp[ob + 1] - this.sp[oa + 1];
          const dz = this.sp[ob + 2] - this.sp[oa + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < 1e-5) continue;
          const rest = this.restLen[slot * LINK_COUNT + l];
          const corr = ((d - rest) / d) * 0.5;
          const cxx = dx * corr;
          const cyy = dy * corr;
          const czz = dz * corr;
          this.sp[oa] += cxx;
          this.sp[oa + 1] += cyy;
          this.sp[oa + 2] += czz;
          this.sp[ob] -= cxx;
          this.sp[ob + 1] -= cyy;
          this.sp[ob + 2] -= czz;
        }

        // ---- the ground, which is not flat ----
        for (let k = 0; k < PARTICLES; k++) {
          const o = base + k * 3;
          const floor = b.groundAt(this.sp[o], this.sp[o + 2]) + PARTICLE_RADIUS;
          if (this.sp[o + 1] < floor) {
            this.sp[o + 1] = floor;
            // Friction: a body that lands stops sliding almost at once.
            this.spPrev[o] += (this.sp[o] - this.spPrev[o]) * 0.55;
            this.spPrev[o + 2] += (this.sp[o + 2] - this.spPrev[o + 2]) * 0.55;
          }
        }
      }

      this.writeSimPose(slot, i, clamp01(this.slotAge[slot] / 0.55));

      // ---- retire ----
      if (this.slotAge[slot] > 2.6 || (this.slotAge[slot] > 0.9 && moving < 4e-5)) {
        this.tier[i] = Tier.Settled;
        this.slotOf[i] = -1;
        this.slotOwner[slot] = -1;
      }
    }
  }

  private stepCheap(dt: number): void {
    let w = 0;
    for (let n = 0; n < this.cheapCount; n++) {
      const i = this.cheapList[n];
      if (this.tier[i] !== Tier.Cheap) continue;
      this.age[i] += dt;

      // Torque grows as the body leaves the vertical: a real fall accelerates.
      this.angVel[i] += (2.6 * Math.sin(this.angle[i]) + 1.15) * dt;
      this.angle[i] += this.angVel[i] * dt;

      // Slide, with the ground taking the momentum out quickly.
      const fr = Math.exp(-4.2 * dt);
      this.cvx[i] *= fr;
      this.cvz[i] *= fr;
      this.cx[i] += this.cvx[i] * dt;
      this.cz[i] += this.cvz[i] * dt;

      let done = false;
      if (this.angle[i] >= HALF_PI) {
        const over = this.angle[i] - HALF_PI;
        this.angle[i] = HALF_PI - over * 0.22;
        this.angVel[i] = -this.angVel[i] * 0.22;
        this.bounces[i]++;
        if (this.bounces[i] >= 3 || Math.abs(this.angVel[i]) < 0.45) {
          this.angle[i] = HALF_PI;
          this.angVel[i] = 0;
          done = true;
        }
      }
      if (this.age[i] > 3.2) done = true;

      this.writeCheapPose(i, clamp01(this.age[i] / 0.4));
      if (done) {
        this.tier[i] = Tier.Settled;
      } else {
        this.cheapList[w++] = i;
      }
    }
    this.cheapCount = w;
  }

  // -------------------------------------------------------------------------
  // Pose derivation
  // -------------------------------------------------------------------------

  private writeCheapPose(i: number, blend: number): void {
    const p = this.battle.pool;
    const o = i * 8;
    const ang = this.angle[i] * blend;
    const settle = clamp01(ang / HALF_PI);

    qA.setFromAxisAngle(AXIS_Y, p.facing[i]);
    vTmp.set(this.axisX[i], 0, this.axisZ[i]);
    if (vTmp.lengthSq() < 1e-8) vTmp.set(1, 0, 0);
    vTmp.normalize();
    qB.setFromAxisAngle(vTmp, ang);
    // Tip in world space, after the yaw: qB * qA.
    qB.multiply(qA);

    this.conformToSlope(qB, this.cx[i], this.cz[i], settle);

    this.pose[o] = this.cx[i];
    this.pose[o + 1] = this.battle.groundAt(this.cx[i], this.cz[i]) + settle * 0.15;
    this.pose[o + 2] = this.cz[i];
    this.pose[o + 3] = qB.x;
    this.pose[o + 4] = qB.y;
    this.pose[o + 5] = qB.z;
    this.pose[o + 6] = qB.w;
    this.pose[o + 7] = settle;
  }

  /**
   * Turn the solved particle cloud back into something a rigid mesh can be drawn
   * with: the spine gives the body's up axis, the shoulders give its right axis, and
   * the mesh origin sits one pelvis-height back down the spine — the man's feet.
   */
  private writeSimPose(slot: number, i: number, blend: number): void {
    const base = slot * PARTICLES * 3;
    const p = this.battle.pool;
    const scale = p.scale[i] || 1;

    const px = this.sp[base + P_PELVIS * 3];
    const py = this.sp[base + P_PELVIS * 3 + 1];
    const pz = this.sp[base + P_PELVIS * 3 + 2];

    vUp.set(
      this.sp[base + P_CHEST * 3] - px,
      this.sp[base + P_CHEST * 3 + 1] - py,
      this.sp[base + P_CHEST * 3 + 2] - pz
    );
    if (vUp.lengthSq() < 1e-8) vUp.set(0, 1, 0);
    vUp.normalize();

    vRight.set(
      this.sp[base + P_HANDR * 3] - this.sp[base + P_HANDL * 3],
      this.sp[base + P_HANDR * 3 + 1] - this.sp[base + P_HANDL * 3 + 1],
      this.sp[base + P_HANDR * 3 + 2] - this.sp[base + P_HANDL * 3 + 2]
    );
    // Gram-Schmidt against the spine so the basis stays orthonormal.
    vTmp.copy(vUp).multiplyScalar(vRight.dot(vUp));
    vRight.sub(vTmp);
    if (vRight.lengthSq() < 1e-6) {
      vRight.set(1, 0, 0);
      vTmp.copy(vUp).multiplyScalar(vRight.dot(vUp));
      vRight.sub(vTmp);
      if (vRight.lengthSq() < 1e-6) vRight.set(0, 0, 1);
    }
    vRight.normalize();
    vFwd.copy(vRight).cross(vUp);

    mBasis.makeBasis(vRight, vUp, vFwd);
    qB.setFromRotationMatrix(mBasis);

    // Blend out of the death animation's upright pose over the first half second.
    if (blend < 1) {
      qA.setFromAxisAngle(AXIS_Y, p.facing[i]);
      qB.slerp(qA, 1 - blend);
    }

    const restPelvis = REST[P_PELVIS * 3 + 1] * scale;
    const o = i * 8;
    this.pose[o] = px - vUp.x * restPelvis;
    this.pose[o + 1] = py - vUp.y * restPelvis;
    this.pose[o + 2] = pz - vUp.z * restPelvis;
    this.pose[o + 3] = qB.x;
    this.pose[o + 4] = qB.y;
    this.pose[o + 5] = qB.z;
    this.pose[o + 6] = qB.w;
    // How horizontal the spine has become is a good proxy for how settled it is.
    this.pose[o + 7] = clamp01(1 - Math.abs(vUp.y));
  }

  /**
   * A body lying across a slope should follow it. The long axis of the corpse is now
   * roughly horizontal, so project it into the ground plane and rotate to match.
   */
  private conformToSlope(q: THREE.Quaternion, x: number, z: number, settle: number): void {
    if (settle < 0.5) return;
    const b = this.battle;
    const e = 1.2;
    const hL = b.groundAt(x - e, z);
    const hR = b.groundAt(x + e, z);
    const hD = b.groundAt(x, z - e);
    const hU = b.groundAt(x, z + e);
    vNormal.set(hL - hR, 2 * e, hD - hU).normalize();
    if (vNormal.y > 0.998) return;

    vUp.set(0, 1, 0).applyQuaternion(q);
    const along = vUp.dot(vNormal);
    vTmp.copy(vNormal).multiplyScalar(along);
    vFwd.copy(vUp).sub(vTmp);
    if (vFwd.lengthSq() < 1e-6) return;
    vFwd.normalize();
    qA.setFromUnitVectors(vUp, vFwd);
    // Ease in with the fall so the correction is not a visible snap.
    const t = clamp01((settle - 0.5) * 2);
    qB.identity().slerp(qA, t);
    q.premultiply(qB);
  }

  // -------------------------------------------------------------------------
  // Read API — this is the contract the unit renderer draws corpses from
  // -------------------------------------------------------------------------

  /**
   * Fill `out` with the corpse pose for soldier `i` and return true, or return false
   * if that soldier has no corpse (still alive, or never registered).
   *
   * Usage in a renderer's `preRender`:
   * ```ts
   * if (ragdoll?.getCorpsePose(i, pose)) {
   *   quat.set(pose.qx, pose.qy, pose.qz, pose.qw);
   *   mat.compose(vec.set(pose.x, pose.y, pose.z), quat, scaleVec);
   * } else {
   *   // normal living transform
   * }
   * ```
   * The position is the mesh origin — the man's feet in his standing pose — so the
   * same mesh and the same scale work unchanged. `settle` is 0 at the instant of
   * death and 1 once the body has come to rest, which is also the weight to use if
   * you want to cross-fade out of the death animation.
   */
  getCorpsePose(i: number, out: CorpsePose): boolean {
    if (i < 0 || i >= this.tier.length || this.tier[i] === Tier.None) return false;
    const o = i * 8;
    out.x = this.pose[o];
    out.y = this.pose[o + 1];
    out.z = this.pose[o + 2];
    out.qx = this.pose[o + 3];
    out.qy = this.pose[o + 4];
    out.qz = this.pose[o + 5];
    out.qw = this.pose[o + 6];
    out.settle = this.pose[o + 7];
    out.simulated = this.tier[i] === Tier.Simulated;
    return true;
  }

  /**
   * World-space joint positions for a simulated corpse: 24 floats, three per joint,
   * ordered as `CORPSE_JOINTS`. Returns null for cheap and settled corpses, which
   * have no per-joint solution. The returned array is reused between calls — copy it
   * if you need to keep it.
   */
  getCorpseJoints(i: number): Float32Array | null {
    if (i < 0 || i >= this.tier.length) return null;
    const slot = this.slotOf[i];
    if (slot < 0 || this.slotOwner[slot] !== i) return null;
    const base = slot * PARTICLES * 3;
    for (let k = 0; k < PARTICLES * 3; k++) this.jointOut[k] = this.sp[base + k];
    return this.jointOut;
  }

  /** True once soldier `i` has a corpse pose worth drawing. */
  hasCorpse(i: number): boolean {
    return i >= 0 && i < this.tier.length && this.tier[i] !== Tier.None;
  }

  /** Ragdolls under full simulation right now. */
  get simulatedCount(): number {
    let n = 0;
    for (let s = 0; s < SIM_MAX; s++) if (this.slotOwner[s] >= 0) n++;
    return n;
  }

  /** Deaths registered since the battle began, and how many got the real solve. */
  get census(): { deaths: number; simulated: number } {
    return { deaths: this.deaths, simulated: this.simulated };
  }

  /** Cheap falls still in motion. */
  get fallingCount(): number {
    return this.cheapCount;
  }

  /**
   * Sanity check for the harness: how many registered corpses are floating above or
   * sunk below the terrain by more than a tolerance. Should stay at zero.
   */
  groundErrors(tolerance = 0.35): number {
    const b = this.battle;
    const p = this.battle.pool;
    let bad = 0;
    for (let i = 0; i < p.count; i++) {
      if (this.tier[i] === Tier.None) continue;
      if (p.state[i] !== SoldierState.Dead && p.state[i] !== SoldierState.Dying) continue;
      const o = i * 8;
      const g = b.groundAt(this.pose[o], this.pose[o + 2]);
      if (Math.abs(this.pose[o + 1] - g) > tolerance) bad++;
    }
    return bad;
  }

  dispose(): void {
    this.cheapCount = 0;
    this.slotOwner.fill(-1);
  }
}

/** Allocate a reusable pose record. Renderers should keep one, not one per man. */
export const makeCorpsePose = (): CorpsePose => ({
  x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, settle: 0, simulated: false,
});

/** Kept for callers that want to clamp their own blend weights the same way. */
export const corpseBlend = (settle: number): number => clamp(settle, 0, 1);
