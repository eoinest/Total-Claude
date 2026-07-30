import type { BattleSystem } from '../sim/BattleSystem';
import type { TerrainSystem } from '../terrain/TerrainSystem';
import { SoldierState, type UnitGroupState } from '../sim/types';
import { isCavalry } from '../units/roster';
import { clamp, clamp01 } from '../util/math';
import { hash01, hash2 } from '../util/rand';
import { PGround, PLayer, type ParticleSystem } from './ParticleSystem';
import { PT, DT } from './atlas';
import type { GroundDamageLayer } from './GroundDamage';

/**
 * Formation dust — the signature Total War effect.
 *
 * Dust is derived straight from `battle.pool` velocities rather than from events, so it
 * works whether or not the combat systems are emitting anything. Three tiers stack to
 * give the effect its depth:
 *
 *   grit    small, fast, short-lived puffs at the heel — reads as individual footfalls
 *   haze    medium puffs a metre up, blending into a continuous trail behind a cohort
 *   billow  rare, large, long-lived clouds that roll and merge into the wall of dust a
 *           cavalry charge throws up
 *
 * Emission scales with speed³ᐟ² (a walk barely disturbs the ground, a gallop tears it
 * open), with unit mass (a horse displaces five times an infantryman's weight of soil),
 * and with a large-scale dryness field so the same march is dustier on the baked flat
 * than on the river meadow.
 *
 * Standing formations still work the ground: every unit periodically stamps a trample
 * splat into the accumulation buffer, so a line that has held for ten minutes leaves a
 * visibly churned footprint.
 */

/**
 * Warm ochre, and deliberately near-white in the red channel. Airborne dust has a
 * very high single-scatter albedo, so sunlit dust is *brighter* than the ground that
 * produced it — get this wrong and the dust vanishes into the field it came from.
 */
const DUST_R = 1.12;
const DUST_G = 0.87;
const DUST_B = 0.56;

export interface DustBudget {
  /** Hard cap on dust spawns per frame, protecting the CPU and the fill rate. */
  maxSpawnsPerFrame: number;
  /** Global emission multiplier from the quality tier. */
  density: number;
}

export class DustEmitter {
  budget: DustBudget = { maxSpawnsPerFrame: 320, density: 1 };
  /** Multiplier from the weather preset — wet ground raises almost nothing. */
  wetness = 1;

  private carry = new Float32Array(0);
  private trampleTimer = new Float32Array(0);
  private frame = 0;
  private spawned = 0;

  /** Two-octave dryness field: the flat bakes hard, hollows stay damp. */
  private drynessAt(x: number, z: number): number {
    const a = hash2(Math.floor(x / 90), Math.floor(z / 90), 7);
    const b = hash2(Math.floor(x / 28), Math.floor(z / 28), 11);
    return 0.45 + 0.42 * a + 0.2 * b;
  }

  update(
    dt: number,
    battle: BattleSystem,
    terrain: TerrainSystem | undefined,
    ps: ParticleSystem,
    damage: GroundDamageLayer,
    camX: number,
    camZ: number
  ): void {
    if (dt <= 0) return;
    this.frame++;
    this.spawned = 0;

    const p = battle.pool;
    const n = p.count;
    if (this.carry.length < battle.units.length + 1) {
      this.carry = new Float32Array(battle.units.length + 64);
      this.trampleTimer = new Float32Array(battle.units.length + 64);
    }

    const density = this.budget.density * this.wetness;
    if (density <= 0.001) return;

    // Beyond ~520 m a puff is a couple of pixels: spend the budget where it reads.
    const cullR2 = 620 * 620;

    for (let ui = 0; ui < battle.units.length; ui++) {
      const u = battle.units[ui];
      if (u.destroyed || u.alive === 0) continue;

      const ddx = u.x - camX;
      const ddz = u.z - camZ;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 > cullR2) continue;

      const def = battle.typeOf(u);
      const horse = isCavalry(def);
      // Mass relative to a legionary at 96 kg, softened so cavalry is ~2.3x not 5x.
      const massK = Math.pow(def.mass / 96, 0.52);

      // Distance trade: far units get fewer but proportionally larger puffs. Screen
      // coverage stays the same while the fill rate — which is what actually limits a
      // particle system — falls with the square of the count.
      const near = clamp01(1 - (Math.sqrt(d2) - 140) / 420);
      const rate = (horse ? 3.1 : 1.0) * massK * density * (0.30 + 0.70 * near);
      const sizeK = 1 + (1 - near) * 0.9;

      this.emitForUnit(dt, battle, u, ui, ps, horse, rate, sizeK, cullR2, camX, camZ);
      this.trample(dt, battle, u, ui, damage, terrain);
    }
  }

  private emitForUnit(
    dt: number,
    battle: BattleSystem,
    u: UnitGroupState,
    ui: number,
    ps: ParticleSystem,
    horse: boolean,
    rate: number,
    sizeK: number,
    cullR2: number,
    camX: number,
    camZ: number
  ): void {
    const p = battle.pool;
    const members = u.members;
    const salt = this.frame * 131 + ui * 17;

    // Accumulated fractional emission for the unit, so slow marches still emit.
    let want = 0;
    for (let m = 0; m < members.length; m++) {
      const i = members[m];
      const st = p.state[i] as SoldierState;
      if (st === SoldierState.Dead || st === SoldierState.Dying) continue;
      const sp = Math.hypot(p.vx[i], p.vz[i]);
      if (sp < 0.45) continue;
      want += Math.pow(sp, 1.5);
    }
    if (want <= 0) return;

    // Calibrated against fill rate, not particle count. Fewer, more opaque puffs give
    // the same optical depth as many faint ones for a fraction of the blended
    // fragments, and fill is the only thing a particle system ever runs out of.
    this.carry[ui] += want * 0.058 * rate * dt;
    let count = this.carry[ui] | 0;
    if (count <= 0) return;
    this.carry[ui] -= count;
    count = Math.min(count, horse ? 28 : 15);

    const remaining = this.budget.maxSpawnsPerFrame - this.spawned;
    if (remaining <= 0) return;
    count = Math.min(count, remaining);

    for (let k = 0; k < count; k++) {
      // Pick an emitting man weighted toward the fast ones by rejection sampling.
      let i = -1;
      let bestSp = 0;
      for (let tries = 0; tries < 3; tries++) {
        const j = members[(hash2(k * 3 + tries, salt, 5) * members.length) | 0];
        if (j === undefined) continue;
        const st = p.state[j] as SoldierState;
        if (st === SoldierState.Dead || st === SoldierState.Dying) continue;
        const sp = Math.hypot(p.vx[j], p.vz[j]);
        if (sp > bestSp) {
          bestSp = sp;
          i = j;
        }
      }
      if (i < 0 || bestSp < 0.45) continue;

      const dx = p.x[i] - camX;
      const dz = p.z[i] - camZ;
      if (dx * dx + dz * dz > cullR2) continue;

      const h1 = hash01(i * 7 + k, salt);
      const h2 = hash01(i * 11 + k, salt + 1);
      const h3 = hash01(i * 13 + k, salt + 2);
      const h4 = hash01(i * 17 + k, salt + 3);

      const dry = this.drynessAt(p.x[i], p.z[i]);
      const speedN = clamp01(bestSp / (horse ? 9 : 4));
      // Kick direction: grit is thrown backwards out from under the heel.
      const invSp = 1 / Math.max(0.2, bestSp);
      const bx = -p.vx[i] * invSp;
      const bz = -p.vz[i] * invSp;

      // Which tier? Fast movement biases toward the big rolling stuff, but the bulk
      // stays as grit and haze at boot height — that is where dust belongs. Only a
      // gallop earns a real billow.
      const tier = h4 < 0.05 + speedN * (horse ? 0.24 : 0.09) ? 2 : h4 < 0.44 ? 1 : 0;

      const rec = ps.reset(
        PLayer.Soft,
        tier === 2 ? PT.dustBillow : tier === 1 ? PT.smokeSoft : PT.dustWisp
      );
      rec.x = p.x[i] + (h1 - 0.5) * (horse ? 1.5 : 0.7);
      rec.z = p.z[i] + (h2 - 0.5) * (horse ? 1.5 : 0.7);
      rec.y = p.y[i] + 0.06;
      rec.ground = PGround.Ride;

      const kickSpeed = (tier === 0 ? 1.5 : 0.85) * (0.4 + speedN * 1.5) * (horse ? 1.7 : 1);
      rec.vx = bx * kickSpeed + (h3 - 0.5) * 1.1;
      rec.vz = bz * kickSpeed + (h1 - 0.5) * 1.1;
      // Dust barely lifts: it is heavy mineral grit, not steam. Keeping the vertical
      // component low is what makes it hug the ranks instead of forming a cloud bank.
      rec.vy = (tier === 0 ? 0.9 : 0.32) * (0.5 + speedN) + h2 * 0.3;

      if (tier === 0) {
        rec.life = 1.0 + h3 * 1.1;
        rec.size0 = (0.45 + h1 * 0.45) * (horse ? 1.8 : 1) * sizeK;
        rec.size1 = rec.size0 * (2.6 + h2 * 1.4);
        rec.a = 0.18 + 0.20 * dry * speedN;
        rec.drag = 1.9;
        rec.gravity = 1.1;
        rec.turb = 0.35;
      } else if (tier === 1) {
        rec.life = 2.6 + h3 * 2.2;
        rec.size0 = (1.3 + h1 * 1.3) * (horse ? 1.85 : 1) * sizeK;
        rec.size1 = rec.size0 * (2.3 + h2 * 1.3);
        rec.a = 0.095 + 0.135 * dry * (0.4 + speedN);
        rec.drag = 1.1;
        rec.gravity = 0.48;
        rec.turb = 0.8;
      } else {
        rec.life = 4.4 + h3 * 3.8;
        rec.size0 = (2.6 + h1 * 2.4) * (horse ? 1.95 : 1) * sizeK;
        rec.size1 = rec.size0 * (1.8 + h2 * 1.0);
        rec.a = 0.048 + 0.082 * dry * (0.3 + speedN);
        rec.drag = 0.60;
        rec.gravity = 0.30;
        rec.turb = 1.3;
      }

      rec.spin = (h4 - 0.5) * (tier === 0 ? 1.6 : 0.35);
      // Drier soil throws paler, warmer dust.
      const tint = 0.86 + dry * 0.24;
      rec.r = DUST_R * tint;
      rec.g = DUST_G * tint;
      rec.b = DUST_B * (0.9 + dry * 0.18);
      rec.windFactor = tier === 0 ? 0.55 : 1.0;
      ps.push();
      this.spawned++;
    }
  }

  /**
   * Churn under a formation. Men standing shoulder to shoulder destroy grass fast, so
   * even a stationary line leaves a mark; a moving one smears a wide band.
   */
  private trample(
    dt: number,
    battle: BattleSystem,
    u: UnitGroupState,
    ui: number,
    damage: GroundDamageLayer,
    terrain: TerrainSystem | undefined
  ): void {
    this.trampleTimer[ui] += dt;
    // ~3 splats/second per unit: enough to paint a moving unit's whole path.
    const period = 0.33;
    if (this.trampleTimer[ui] < period) return;
    this.trampleTimer[ui] -= period;

    const p = battle.pool;
    const members = u.members;
    if (members.length === 0) return;
    const salt = this.frame * 29 + ui;

    // Two samples per tick keeps a fast unit's trail continuous.
    for (let s = 0; s < 2; s++) {
      const i = members[(hash2(s, salt, 3) * members.length) | 0];
      if (i === undefined) continue;
      const st = p.state[i] as SoldierState;
      if (st === SoldierState.Dead) continue;
      const sp = Math.hypot(p.vx[i], p.vz[i]);
      const dry = this.drynessAt(p.x[i], p.z[i]);
      // Wet ground churns to mud faster than dry ground scuffs. Small per-splat
      // increments on purpose: a line that has stood ten minutes should saturate, a
      // unit that marched through once should leave a faint band.
      const amount = (0.011 + clamp(sp * 0.005, 0, 0.02)) * (1.35 - dry * 0.45);
      const slope = terrain?.slopeAt(p.x[i], p.z[i]) ?? 0;
      const radius = 1.3 + sp * 0.35 + slope * 1.5;
      damage.splat(
        p.x[i],
        p.z[i],
        radius,
        sp > 2 ? DT.dirtScuff : DT.trampleSoft,
        hash2(i, salt, 9) * Math.PI * 2,
        0,
        amount,
        0,
        0.8 + hash2(i, salt, 13) * 0.6
      );
    }
  }

  get spawnsLastFrame(): number {
    return this.spawned;
  }
}
