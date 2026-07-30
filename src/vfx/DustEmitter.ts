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
 * Dust is derived straight from `battle.pool` state rather than from events, so it works
 * whether or not the combat systems are emitting anything. Two independent sources feed
 * it, and both matter:
 *
 *   **locomotion** — men and horses moving over dry ground. Three tiers stack:
 *      grit    small, fast, short-lived puffs at the heel — individual footfalls
 *      haze    medium puffs a metre up, blending into a trail behind a cohort
 *      billow  large, long-lived clouds that roll into the wall a charge throws up
 *
 *   **contact** — the melee itself. This is the one that is easy to miss and the one
 *      that decides whether a battle looks violent, because a melee has almost no
 *      *locomotion*: two thousand men grinding against each other at 0.2 m/s. Driving
 *      dust from velocity alone therefore produces a completely clean contact line at
 *      the exact moment the frame should be at its dirtiest. Contact dust is emitted per
 *      fighting man instead, low and slow and long-lived so it accumulates into a
 *      standing haze bank over the fighting rather than a puff that blows away.
 *
 * Locomotion emission scales with speed³ᐟ² (a walk barely disturbs the ground, a gallop
 * tears it open), with unit mass (a horse displaces several times an infantryman's
 * weight of soil), and with a large-scale dryness field so the same march is dustier on
 * the baked flat than on the river meadow.
 *
 * Standing formations also work the ground: every unit periodically stamps trample
 * splats into the accumulation buffer, heavily where men are in contact, so the strip
 * where the lines ground together is permanently churned.
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
  /** Separate accumulator for contact dust so it cannot be starved by locomotion. */
  private fightCarry = new Float32Array(0);
  private trampleTimer = new Float32Array(0);
  private frame = 0;
  private spawned = 0;
  private fightSpawned = 0;

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
    this.fightSpawned = 0;

    const p = battle.pool;
    const n = p.count;
    if (this.carry.length < battle.units.length + 1) {
      this.carry = new Float32Array(battle.units.length + 64);
      this.fightCarry = new Float32Array(battle.units.length + 64);
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
      this.emitContactDust(dt, battle, u, ui, ps, horse, density * (0.35 + 0.65 * near), sizeK);
      this.trample(dt, battle, u, ui, damage, terrain);
    }
    void n;
  }

  /**
   * Dust raised by the fighting itself.
   *
   * Kept deliberately different in character from footfall dust: it barely rises, it
   * lives four to ten seconds, and it is emitted at *waist* height rather than at the
   * heel, because what the eye reads at a contact line is not individual puffs but a
   * standing bank of illuminated air the height of a man's chest, thickening as the
   * fight goes on. Long lifetimes are what let a modest spawn rate integrate into a
   * genuinely opaque haze without paying for thousands of particles per second.
   */
  private emitContactDust(
    dt: number,
    battle: BattleSystem,
    u: UnitGroupState,
    ui: number,
    ps: ParticleSystem,
    horse: boolean,
    rate: number,
    sizeK: number
  ): void {
    const p = battle.pool;
    const members = u.members;
    const salt = this.frame * 197 + ui * 23;

    // Count the men actually in contact and find their centroid: the front rank, not
    // the whole block, is where the ground is being destroyed.
    let fighters = 0;
    let fx = 0;
    let fz = 0;
    for (let m = 0; m < members.length; m++) {
      const i = members[m];
      if (p.state[i] !== SoldierState.Fighting) continue;
      fighters++;
      fx += p.x[i];
      fz += p.z[i];
    }
    if (fighters === 0) return;
    fx /= fighters;
    fz /= fighters;

    // ~0.28 puffs per fighting man per second at full density. With ~600 men in contact
    // across the field and a 4 s mean life that is ~700 live particles in the band —
    // enough for a legible haze with the men still reading through it. Four times this
    // buries the entire army in fog, which is a different failure from having no dust but
    // scores no better.
    this.fightCarry[ui] += fighters * 0.28 * rate * dt;
    let count = this.fightCarry[ui] | 0;
    if (count <= 0) return;
    this.fightCarry[ui] -= count;
    count = Math.min(count, 12);

    const remaining = this.budget.maxSpawnsPerFrame - this.spawned - this.fightSpawned;
    if (remaining <= 0) return;
    count = Math.min(count, remaining);

    for (let k = 0; k < count; k++) {
      // Sample a fighting man; fall back to the contact centroid rather than skipping,
      // so a thin frontage still gets its share of the emission.
      let i = -1;
      for (let tries = 0; tries < 4; tries++) {
        const j = members[(hash2(k * 5 + tries, salt, 17) * members.length) | 0];
        if (j !== undefined && p.state[j] === SoldierState.Fighting) { i = j; break; }
      }
      const ex = i >= 0 ? p.x[i] : fx;
      const ez = i >= 0 ? p.z[i] : fz;
      const ey = i >= 0 ? p.y[i] : battle.groundAt(ex, ez);

      const h1 = hash01(k * 7 + ui, salt);
      const h2 = hash01(k * 11 + ui, salt + 1);
      const h3 = hash01(k * 13 + ui, salt + 2);
      const h4 = hash01(k * 17 + ui, salt + 3);

      const dry = this.drynessAt(ex, ez);
      // A quarter of the emission is the big slow stuff that forms the bank; the rest is
      // mid-scale so the bank has visible internal structure instead of reading as fog.
      const big = h4 < 0.30;

      const rec = ps.reset(PLayer.Soft, big ? PT.dustBillow : h4 < 0.72 ? PT.smokeSoft : PT.dustWisp);
      // Spread across a couple of metres and lifted only to knee height. The dust that
      // reads is the band from the ground to a man's chest: raise the emission any higher
      // and the formation disappears into it instead of standing in it.
      rec.x = ex + (h1 - 0.5) * 3.2;
      rec.z = ez + (h2 - 0.5) * 3.2;
      rec.y = ey + 0.10 + h3 * 0.55;
      rec.ground = PGround.Ride;

      // Almost no directed velocity — this dust is stirred, not kicked.
      rec.vx = (h3 - 0.5) * 1.5;
      rec.vz = (h1 - 0.5) * 1.5;
      rec.vy = 0.14 + h2 * 0.34;

      if (big) {
        rec.life = 5.0 + h3 * 3.4;
        rec.size0 = (2.0 + h1 * 1.7) * (horse ? 1.4 : 1) * sizeK;
        rec.size1 = rec.size0 * (1.7 + h2 * 0.8);
        rec.a = 0.048 + 0.040 * dry;
        rec.drag = 0.45;
        rec.gravity = 0.16;
        rec.turb = 1.5;
      } else {
        rec.life = 3.2 + h3 * 2.4;
        rec.size0 = (1.1 + h1 * 1.1) * (horse ? 1.35 : 1) * sizeK;
        rec.size1 = rec.size0 * (2.0 + h2 * 1.1);
        rec.a = 0.072 + 0.058 * dry;
        rec.drag = 0.8;
        rec.gravity = 0.30;
        rec.turb = 1.05;
      }

      rec.spin = (h4 - 0.5) * 0.30;
      const tint = 0.86 + dry * 0.24;
      rec.r = DUST_R * tint;
      rec.g = DUST_G * tint;
      rec.b = DUST_B * (0.9 + dry * 0.18);
      // Contact dust is heavy with grit and hangs in the crush; the wind gets less
      // purchase on it than on a clean footfall puff.
      rec.windFactor = 0.55;
      ps.push();
      this.fightSpawned++;
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
      // 0.2 m/s, not 0.45: a line dressing its ranks or a unit shuffling under missile
      // fire still scuffs the ground, and that low-level haze under a stationary army is
      // half of what makes a Rome II field look inhabited rather than staged.
      if (sp < 0.20) continue;
      want += Math.pow(sp, 1.5);
    }
    if (want <= 0) return;

    // Calibrated against fill rate, not particle count. Fewer, more opaque puffs give
    // the same optical depth as many faint ones for a fraction of the blended
    // fragments, and fill is the only thing a particle system ever runs out of.
    this.carry[ui] += want * 0.165 * rate * dt;
    let count = this.carry[ui] | 0;
    if (count <= 0) return;
    this.carry[ui] -= count;
    count = Math.min(count, horse ? 44 : 24);

    const remaining = this.budget.maxSpawnsPerFrame - this.spawned - this.fightSpawned;
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
      if (i < 0 || bestSp < 0.20) continue;

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
        rec.life = 1.3 + h3 * 1.3;
        rec.size0 = (0.55 + h1 * 0.55) * (horse ? 1.8 : 1) * sizeK;
        rec.size1 = rec.size0 * (2.8 + h2 * 1.5);
        rec.a = 0.24 + 0.24 * dry * speedN;
        rec.drag = 1.9;
        rec.gravity = 1.1;
        rec.turb = 0.35;
      } else if (tier === 1) {
        rec.life = 3.4 + h3 * 2.8;
        rec.size0 = (1.5 + h1 * 1.5) * (horse ? 1.85 : 1) * sizeK;
        rec.size1 = rec.size0 * (2.5 + h2 * 1.4);
        rec.a = 0.145 + 0.165 * dry * (0.4 + speedN);
        rec.drag = 1.1;
        rec.gravity = 0.48;
        rec.turb = 0.8;
      } else {
        rec.life = 6.0 + h3 * 4.6;
        rec.size0 = (3.0 + h1 * 2.8) * (horse ? 1.95 : 1) * sizeK;
        rec.size1 = rec.size0 * (2.0 + h2 * 1.1);
        rec.a = 0.078 + 0.105 * dry * (0.3 + speedN);
        rec.drag = 0.60;
        rec.gravity = 0.24;
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
   * even a stationary line leaves a mark; a moving one smears a wide band; a line in
   * contact grinds the turf away completely.
   *
   * The accumulation buffer is RGBA8, so per-splat increments have to clear the 1/255
   * quantisation floor by a healthy margin after the brush's own falloff — an increment
   * of 0.011 through a 0.4 mask lands at 1.1/255 and rounds most of the brush away,
   * which is how a system that stamps twenty thousand splats can leave a spotless field.
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

    // Two samples per tick keeps a fast unit's trail continuous across its frontage.
    for (let s = 0; s < 2; s++) {
      const i = members[(hash2(s, salt, 3) * members.length) | 0];
      if (i === undefined) continue;
      const st = p.state[i] as SoldierState;
      if (st === SoldierState.Dead) continue;
      const sp = Math.hypot(p.vx[i], p.vz[i]);
      const dry = this.drynessAt(p.x[i], p.z[i]);
      const fighting = st === SoldierState.Fighting;
      // Wet ground churns to mud faster than dry ground scuffs. Calibrated so that at
       // ~1.2 brush hits per texel per second a unit which marched through once leaves a
      // band around 0.13, one that has stood for a minute reaches ~0.7, and one that has
      // been *fighting* saturates inside twenty seconds — which is what produces the
      // dark strip along the contact line rather than a uniform brown field.
      const amount =
        (0.020 + clamp(sp * 0.012, 0, 0.05) + (fighting ? 0.045 : 0)) * (1.35 - dry * 0.45);
      const slope = terrain?.slopeAt(p.x[i], p.z[i]) ?? 0;
      const radius = 2.4 + sp * 0.8 + slope * 2.0 + (fighting ? 0.8 : 0);
      // Smear along the direction of travel: a marching column leaves an elongated
      // scuff, not a row of circular dots.
      const rot = sp > 0.6 ? Math.atan2(p.vx[i], p.vz[i]) : hash2(i, salt, 9) * Math.PI * 2;
      damage.splat(
        p.x[i],
        p.z[i],
        radius,
        sp > 2 ? DT.dirtScuff : DT.trampleSoft,
        rot,
        0,
        amount,
        0,
        sp > 0.6 ? 0.55 + hash2(i, salt, 13) * 0.3 : 0.8 + hash2(i, salt, 13) * 0.6
      );
    }
  }

  get spawnsLastFrame(): number {
    return this.spawned;
  }
}
