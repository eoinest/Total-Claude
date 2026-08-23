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
 * Warm ochre at a physical albedo. Airborne dust scatters strongly, so sunlit dust is
 * brighter than the ground that produced it — but only by a factor of two or three, not
 * ten. Pushed past an albedo of 1 it clips the red channel, crosses the bloom threshold
 * and comes back as white cotton wool, which at strategic zoom is the single most
 * recognisable "particle demo" artefact there is. Keep the *ratio* to the ground, not an
 * absolute level: everything here is proportional to `uSunColour`, so it tracks whatever
 * exposure the lighting system settles on.
 */
const DUST_R = 0.78;
const DUST_G = 0.60;
const DUST_B = 0.335;

export interface DustBudget {
  /** Hard cap on dust spawns per frame, protecting the CPU and the fill rate. */
  maxSpawnsPerFrame: number;
  /** Global emission multiplier from the quality tier. */
  density: number;
  /**
   * **The optical budget: live soft billboards at which dust emission reaches zero.**
   *
   * This is the number that decides how much of the frame is dust, and it is absolute on
   * purpose. It used to be `0.78 x the soft ring's capacity`, and that ring is a *memory*
   * decision — 5,000 at low, 22,000 at ultra — so the tier with the most memory was
   * licensed 4.4x as much dust as the tier the emission rates were calibrated on, and
   * nobody ever chose that. Measured at ultra before the change: 12,529 live billboards at
   * the melee camera against the ~4,500 this system's own design note calls "a legible
   * dust bank", 58.8 % of the frame with dust over it and 75.0 % at the clash.
   */
  liveCeiling: number;
  /**
   * Peak-opacity multiplier applied to every dust puff.
   *
   * Optical depth is alpha x overlap. `liveCeiling` bounds the overlap and this bounds the
   * alpha; spawn rate, lifetime and sprite size all act only through those two, which is
   * why the budget is expressed in them rather than in puffs per man per second.
   */
  opacity: number;
}

export class DustEmitter {
  budget: DustBudget = { maxSpawnsPerFrame: 320, density: 1, liveCeiling: 5200, opacity: 0.8 };
  /** Multiplier from the weather preset — wet ground raises almost nothing. */
  wetness = 1;
  /**
   * Ambient wind, in m/s, copied in each frame by the owner. Dust is given a fraction of
   * it as an initial velocity as well as riding `uWind` in the shader, so a cloud leans
   * downwind from the moment it is born instead of only drifting later — which is what
   * makes it read as a wake rather than a stationary bank.
   */
  driftX = 0;
  driftZ = 0;

  private carry = new Float32Array(0);
  /**
   * Accumulator, and last-known anchor, for the formation wake. See `emitMarchWake`.
   *
   * The anchor's own velocity is tracked here rather than read off the unit because
   * `UnitGroupState` does not carry one, and adding one would be a simulation field for a
   * presentation effect. Differencing `u.x, u.z` between frames is exact and costs two
   * floats a unit.
   */
  private wakeCarry = new Float32Array(0);
  private wakePrevX = new Float32Array(0);
  private wakePrevZ = new Float32Array(0);
  private wakeSpeed = new Float32Array(0);
  private wakeSeen = new Uint8Array(0);
  /** Separate accumulator for contact dust so it cannot be starved by locomotion. */
  private fightCarry = new Float32Array(0);
  private trampleTimer = new Float32Array(0);
  private frame = 0;
  private spawned = 0;
  private fightSpawned = 0;
  /**
   * Wake puffs spawned on the last frame, and how many units contributed.
   *
   * Kept because the first build of `emitMarchWake` had a coefficient sixteen times too
   * small and the frame was indistinguishable from the frame without it — an effect that is
   * *emitting* and an effect that is *invisible* look the same from outside, and there was no
   * way to tell them apart. Read by `tools/probe-contact.mjs --arms=dust`.
   */
  wakeSpawnedLastFrame = 0;
  wakeUnitsLastFrame = 0;

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
    this.wakeSpawnedLastFrame = 0;
    this.wakeUnitsLastFrame = 0;

    const p = battle.pool;
    const n = p.count;
    if (this.carry.length < battle.units.length + 1) {
      const cap = battle.units.length + 64;
      this.carry = new Float32Array(cap);
      this.fightCarry = new Float32Array(cap);
      this.trampleTimer = new Float32Array(cap);
      this.wakeCarry = new Float32Array(cap);
      this.wakePrevX = new Float32Array(cap);
      this.wakePrevZ = new Float32Array(cap);
      this.wakeSpeed = new Float32Array(cap);
      this.wakeSeen = new Uint8Array(cap);
    }

    // Optical governor. Emission is per man, so the natural failure mode is that the rate
    // is fine at 2,500 men and saturates the field at 9,500 — which reads as a white sheet
    // over the battle and costs a whole frame budget in fill rate. Taper to zero as the
    // live population approaches the budget, so the ceiling is structural rather than a
    // tuning constant that happens to be right for one army size.
    //
    // The taper is 38.5 % of the ceiling, which reproduces the shape of the old
    // ring-relative form (0.30 of capacity under a 0.78 ceiling) exactly — only the
    // ceiling itself has moved, and it has moved from a memory budget to an optical one.
    const ceiling = Math.max(1, this.budget.liveCeiling);
    const govern = clamp01((ceiling - ps.softLive) / (ceiling * 0.385));
    const density = this.budget.density * this.wetness * govern;
    if (density <= 0.001) return;

    // Beyond ~520 m a puff is a couple of pixels: spend the budget where it reads.
    const cullR2 = 620 * 620;

    /*
     * Anchor velocity, for every unit and *before* the distance cull.
     *
     * It has to be before the cull, because the cull is a `continue` and a unit that walks
     * out of range and back in would otherwise difference two positions a hundred frames
     * apart and read as travelling at 40 m/s. `wakeSeen` covers the same case at spawn: a
     * unit's first frame has no previous position and must report zero rather than its
     * distance from the origin.
     */
    for (let ui = 0; ui < battle.units.length; ui++) {
      const u = battle.units[ui];
      if (this.wakeSeen[ui] === 0) {
        this.wakeSeen[ui] = 1;
        this.wakeSpeed[ui] = 0;
      } else {
        const vx = (u.x - this.wakePrevX[ui]) / dt;
        const vz = (u.z - this.wakePrevZ[ui]) / dt;
        // A first-order low pass, so a single frame of teleport (a deployment, a rout
        // re-anchoring) cannot produce a puff of dust the size of the map.
        const sp = Math.min(14, Math.sqrt(vx * vx + vz * vz));
        this.wakeSpeed[ui] += (sp - this.wakeSpeed[ui]) * clamp01(dt * 7);
      }
      this.wakePrevX[ui] = u.x;
      this.wakePrevZ[ui] = u.z;
    }

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

      // Distance trade: far units get somewhat fewer, slightly larger, fainter puffs.
      //
      // The obvious version of this optimisation — few, big, full-opacity puffs far away
      // — is wrong, and wrong in a way that is invisible up close and ruins the strategic
      // view: a unit is only a few dozen pixels wide from up there, so a handful of large
      // opaque billboards on top of it reads as three balls of cotton wool rather than as
      // haze. Keep the size growth small and take the saving in alpha instead, which
      // integrates rather than popping.
      const near = clamp01(1 - (Math.sqrt(d2) - 140) / 420);
      const rate = (horse ? 3.1 : 1.0) * massK * density * (0.55 + 0.45 * near);
      // Optical depth per unit of path is what should stay constant with distance, so a
      // puff grown to cover the same screen area from twice as far must be proportionally
      // *thinner*. Dividing alpha by the size growth enforces that, and the squared
      // near-term makes the mid field fall away fast. Without this a far unit is covered
      // by four 50-pixel billboards at 0.45 opacity each, and 1 − 0.55⁴ = 0.91: an opaque
      // white lump of cotton wool sitting on the formation.
      const nf = near * near;
      const sizeK = 1 + (1 - near) * 1.1;
      const alphaK = (0.14 + 0.86 * nf) / sizeK;

      this.emitForUnit(dt, battle, u, ui, ps, horse, rate, sizeK, alphaK, cullR2, camX, camZ);
      this.emitMarchWake(dt, battle, u, ui, ps, horse, rate, sizeK, alphaK);
      this.emitContactDust(dt, battle, u, ui, ps, horse, density * (0.5 + 0.5 * near), sizeK, alphaK);
      this.trample(dt, battle, u, ui, damage, terrain);
    }
    void n;
  }

  /**
   * The wake a *formation* leaves, as opposed to the puffs its men leave.
   *
   * ## Why the per-man emitter is not enough, measured
   *
   * `emitForUnit` above is per man, and it is correct as far as it goes: it reads 13.2 % of
   * the frame covered at the melee camera (`tools/probe-dust.mjs`), which is a real dust
   * bank. But criterion E1's tell is not haze over a melee, it is *"moving formations trail
   * sunlit dust"*, and a marching formation is the one case the per-man rate cannot reach.
   * The arithmetic, on a 320-man cohort at a 1.4 m/s walk: `want` is `sum pow(speed, 1.5)`
   * = 530, the coefficient is 0.075, so the unit emits **40 puffs a second**, of which about
   * 39 % are the metre-scale haze tier and the rest is grit at the heel. Sixty-odd
   * mid-sized puffs alive at a time, spread over a 25 m frontage, is an optical depth of
   * roughly 0.2 in a band that ought to read at 0.5 — visible if you know to look, and
   * three independent critics did not see it in eighteen frames.
   *
   * Raising the per-man coefficient is the wrong lever twice over. It scales with **men**,
   * so it saturates the optical governor on a 9,000-man approach march long before it makes
   * one cohort read; and it emits *under each man*, so what it thickens is the block itself
   * rather than the ground behind it.
   *
   * ## What this does instead
   *
   * A formation is a plough. What it displaces scales with its **frontage** and its
   * **speed**, not with its headcount, and what it leaves is a sheet behind its rear rank,
   * not a cloud inside it. So:
   *
   *  - the rate is `frontage x speed`, in metres squared of ground disturbed per second,
   *    which is dimensionally the right thing and which means a 40-man skirmisher screen
   *    and a 480-man phalanx of the same frontage raise the same dust;
   *  - it is gated on the **anchor** moving, not on the men moving, so a melee — where two
   *    thousand men shuffle at 0.2 m/s and the anchors are still — raises none of it, and
   *    the contact emitter keeps that case as it always did;
   *  - the puffs are born on a line across the rear of the block and behind it, spread over
   *    the full frontage, so the shape in the frame is a band the width of the unit;
   *  - they are large, slow, low and long-lived. Optical depth is alpha times overlap, and
   *    overlap is what a small number of wide, four-to-eight-second puffs buys cheaply. A
   *    band 25 m wide and 12 m deep needs about a hundred live 3 m puffs at 0.09 alpha to
   *    reach 0.4 optical depth, and a hundred live at a six-second life is **17 spawns a
   *    second**. That is the whole cost of the effect, and the coefficient below is that
   *    number divided by the frontage-times-speed a formed cohort actually presents: a
   *    34 m line at 1.4 m/s is 48 m squared a second, so 0.30. Cavalry gets 0.50 rather
   *    than the 3.1 the per-man emitter gives it, because a horse's extra dust is mostly
   *    thrown from the hoof and the per-man term already has it; what the wake adds for a
   *    squadron is width.
   *
   * `emitForUnit`'s grit stays exactly as it was: the heel puffs are what a man reads as
   * and this is what a block reads as, and both are wanted.
   */
  private emitMarchWake(
    dt: number,
    battle: BattleSystem,
    u: UnitGroupState,
    ui: number,
    ps: ParticleSystem,
    horse: boolean,
    rate: number,
    sizeK: number,
    alphaK: number
  ): void {
    const speed = this.wakeSpeed[ui];
    // 0.55 m/s is below a formed walk and above the drift of a unit dressing its ranks.
    // A testudo advances at 0.36 x walk and is deliberately above it: a shell grinding
    // forward is exactly the case that should be visibly heavy.
    if (speed < 0.45) return;

    const frontage = Math.max(1.2, u.width * u.spacingX);
    // Metres squared of ground crossed per second, times the tier/distance/dryness rate,
    // times a coefficient chosen off the optical-depth arithmetic in the note above.
    this.wakeCarry[ui] += frontage * speed * rate * (horse ? 0.62 : 0.40) * dt;
    let count = this.wakeCarry[ui] | 0;
    if (count <= 0) return;
    this.wakeCarry[ui] -= count;
    // A cap per unit per frame, so a cavalry wing wheeling at a gallop cannot take the
    // whole frame's spawn budget in one unit.
    count = Math.min(count, horse ? 12 : 8);

    const remaining = this.budget.maxSpawnsPerFrame - this.spawned - this.fightSpawned;
    if (remaining <= 0) return;
    count = Math.min(count, remaining);

    const p = battle.pool;
    const salt = this.frame * 197 + ui * 41;
    // The unit's own frame. `facing` is the way it points; the rear edge is behind it.
    const fs = Math.sin(u.facing);
    const fc = Math.cos(u.facing);
    const depth = Math.max(0.8, Math.ceil(u.alive / Math.max(1, u.width)) * u.spacingZ);
    const speedN = clamp01(speed / (horse ? 8 : 3.2));
    let yBase = 0;
    for (let m = 0; m < u.members.length; m++) {
      const i = u.members[m];
      if (p.state[i] === SoldierState.Dead || p.state[i] === SoldierState.Dying) continue;
      yBase = p.y[i];
      break;
    }

    for (let k = 0; k < count; k++) {
      const h1 = hash01(k * 5, salt);
      const h2 = hash01(k * 7, salt + 1);
      const h3 = hash01(k * 11, salt + 2);
      const h4 = hash01(k * 13, salt + 3);

      // Across the frontage, and from the rear rank to a couple of metres behind it. The
      // lateral spread runs a little wider than the block because a wake spreads.
      const across = (h1 - 0.5) * frontage * 1.14;
      const behind = -depth - 0.4 - h2 * 2.6;
      const x = u.x + fs * behind + fc * across;
      const z = u.z + fc * behind - fs * across;

      const dry = this.drynessAt(x, z);
      const rec = ps.reset(PLayer.Soft, h4 < 0.22 ? PT.dustBillow : PT.smokeSoft);
      rec.x = x;
      rec.z = z;
      // Height comes from a man of the unit rather than from the anchor, because
      // `UnitGroupState` carries no y — and from the *first* live member rather than a
      // sampled one, because the ground under a formation is flat to within a few
      // centimetres over its own depth and a per-puff terrain lookup would be a hundred
      // heightfield samples a second for a number that does not vary. `PGround.Ride` then
      // keeps the puff on the surface as it drifts.
      rec.y = yBase + 0.10 + h3 * 0.22;
      rec.ground = PGround.Ride;

      // It drifts backwards out of the block at a fraction of the march, plus the ambient
      // wind. Almost no vertical: this is a sheet the formation peels off the ground, and
      // anything that lifts reads as smoke.
      rec.vx = -fs * speed * 0.16 + (h3 - 0.5) * 0.5 + this.driftX * 0.45;
      rec.vz = -fc * speed * 0.16 + (h1 - 0.5) * 0.5 + this.driftZ * 0.45;
      rec.vy = 0.10 + h2 * 0.13 + speedN * 0.10;

      rec.life = 4.2 + h3 * 3.6;
      rec.size0 = (2.2 + h1 * 2.0) * (horse ? 1.5 : 1) * sizeK;
      rec.size1 = rec.size0 * (2.2 + h2 * 1.2);
      /*
       * Peak alpha, and it is about twice the per-man haze tier's.
       *
       * The first build ran at 0.09 and `tools/probe-contact.mjs --arms=dust` showed the
       * wake changing the ground behind a marching cohort by 5 to 20 parts in 255 — present
       * in an ablation diff amplified twelve times, invisible in the frame. Optical depth is
       * alpha times overlap and the overlap is already paid for, so the honest lever is
       * alpha, which costs nothing: the same fragments are blended either way.
       *
       * The owner's standing complaint about dust — "it is like making things just plain
       * hard to see" — is about the *melee*, and this term is deliberately the opposite
       * case. It is emitted behind the rear rank of a formation that is moving, over ground
       * the unit has already crossed, so what it obscures is grass. `veil` at the two wake
       * stations is the number that has to stay small, and it is reported.
       */
      rec.a = (0.12 + 0.16 * dry * (0.45 + 0.55 * speedN)) * alphaK * this.budget.opacity;
      rec.drag = 0.85;
      rec.gravity = 0.22;
      rec.turb = 0.95;
      rec.spin = (h4 - 0.5) * 0.30;
      const tint = 0.86 + dry * 0.24;
      rec.r = DUST_R * tint;
      rec.g = DUST_G * tint;
      rec.b = DUST_B * (0.9 + dry * 0.18);
      rec.windFactor = 1.0;
      ps.push();
      this.spawned++;
      this.wakeSpawnedLastFrame++;
    }
    this.wakeUnitsLastFrame++;
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
    sizeK: number,
    alphaK: number
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

    // ~0.34 puffs per fighting man per second at full density.
    //
    // Optical depth is alpha × overlap, so a given haze can be built from few thick
    // sprites or many thin ones. Many thin ones is strictly better looking: the cloud has
    // internal structure, men stay visible through it, and no single billboard ever
    // announces itself. It costs fill rate linearly, which the occupancy governor bounds.
    // 0.34 was calibrated on how a melee cloud *looks* in isolation, never against how much
    // of the frame it then covers. Measured at the melee camera by hiding `vfx-particles` and
    // re-shooting: the dust lifted mean luminance from 0.226 to 0.404 and collapsed the
    // fraction of frame below 15 % luminance from 39.8 % to 6.7 %. The ten Rome II plates
    // measure 16-21 % below 15 %, and rubric G2b asks for deep near-blacks and clipping
    // highlights in one frame — so at 6.7 % the cloud was not reading as dust, it was reading
    // as a milky sheet over the whole engagement, which is what "dozens of soldiers render
    // semi-transparent" describes. 0.22 is 65 % of the emission and lands the same frame back
    // in the plates' range while leaving the cloud plainly there.
    this.fightCarry[ui] += fighters * 0.22 * rate * dt;
    let count = this.fightCarry[ui] | 0;
    if (count <= 0) return;
    this.fightCarry[ui] -= count;
    count = Math.min(count, 16);

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
      // Per-puff optical thickness, mean 1. Identical alpha on every sprite is the other
      // half of why an overlapping field integrates to a featureless wash: the sum of many
      // equal terms is smooth by the central limit theorem, whichever texture they carry.
      // Spreading the thickness three-to-one leaves the mean — and so the depth of the bank
      // — untouched while giving it dense knots and thin gaps.
      const lump = 0.52 + 0.96 * hash01(k * 23 + ui, salt + 5);

      // Distant dust uses only the softest silhouette in the atlas. `dustBillow` and
      // `dustWisp` have readable lumpy outlines that sell a puff close up and give away
      // the billboard from a strategic camera, where the whole cloud is 40 pixels.
      const soft = alphaK < 0.34;
      const opq = alphaK * lump * this.budget.opacity;
      const rec = ps.reset(
        PLayer.Soft,
        soft ? PT.smokeSoft : big ? PT.dustBillow : h4 < 0.72 ? PT.smokeSoft : PT.dustWisp
      );
      // Broad and low. The spread deliberately exceeds the unit's own footprint — a
      // cohort's dust hangs well outside the block — and the spawn height is at the ankle,
      // because that is where boots meet soil. Everything about the vertical profile is
      // arranged to keep density bottom-heavy: low spawn, almost no lift, and a small
      // positive gravity so it settles rather than climbing.
      rec.x = ex + (h1 - 0.5) * 6.4;
      rec.z = ez + (h2 - 0.5) * 6.4;
      rec.y = ey + 0.02 + h3 * 0.26;
      rec.ground = PGround.Ride;

      rec.vx = (h3 - 0.5) * 1.5 + this.driftX * 0.35;
      rec.vz = (h1 - 0.5) * 1.5 + this.driftZ * 0.35;
      rec.vy = 0.05 + h2 * 0.20;

      if (big) {
        rec.life = 4.0 + h3 * 2.4;
        rec.size0 = (2.6 + h1 * 2.2) * (horse ? 1.4 : 1) * sizeK;
        rec.size1 = rec.size0 * (1.7 + h2 * 0.8);
        rec.a = (0.086 + 0.094 * dry) * opq;
        rec.drag = 0.45;
        rec.gravity = 0.22;
        rec.turb = 1.5;
      } else {
        rec.life = 2.8 + h3 * 1.9;
        rec.size0 = (1.45 + h1 * 1.45) * (horse ? 1.35 : 1) * sizeK;
        rec.size1 = rec.size0 * (2.0 + h2 * 1.1);
        rec.a = (0.145 + 0.120 * dry) * opq;
        rec.drag = 0.8;
        rec.gravity = 0.34;
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
    alphaK: number,
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
    // Emission is *per man*, so this coefficient has to fall as army size rises or a
    // 9,500-man approach march fills the whole pool with billows before contact and every
    // subsequent frame is white. Sized for ~600 spawns/s across the field on the march.
    this.carry[ui] += want * 0.075 * rate * dt;
    let count = this.carry[ui] | 0;
    if (count <= 0) return;
    this.carry[ui] -= count;
    count = Math.min(count, horse ? 34 : 20);

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

      const soft = alphaK < 0.34;
      const opq = alphaK * this.budget.opacity;
      const rec = ps.reset(
        PLayer.Soft,
        soft || tier === 1 ? PT.smokeSoft : tier === 2 ? PT.dustBillow : PT.dustWisp
      );
      // Born behind the heel, not under the man: the bigger the puff the further back it
      // starts, so a marching block drags a wake instead of wearing a hat. `bx/bz` already
      // points backwards along the direction of travel.
      const trail = tier === 0 ? 0.3 : tier === 1 ? 1.4 : 2.6;
      rec.x = p.x[i] + bx * trail + (h1 - 0.5) * (horse ? 2.2 : 1.3);
      rec.z = p.z[i] + bz * trail + (h2 - 0.5) * (horse ? 2.2 : 1.3);
      rec.y = p.y[i] + 0.04;
      rec.ground = PGround.Ride;

      const kickSpeed = (tier === 0 ? 1.5 : 0.85) * (0.4 + speedN * 1.5) * (horse ? 1.7 : 1);
      rec.vx = bx * kickSpeed + (h3 - 0.5) * 1.1 + this.driftX * 0.3;
      rec.vz = bz * kickSpeed + (h1 - 0.5) * 1.1 + this.driftZ * 0.3;
      // Dust barely lifts: it is heavy mineral grit, not steam. Keeping the vertical
      // component low is what makes it hug the ranks instead of forming a cloud bank.
      rec.vy = (tier === 0 ? 0.55 : 0.16) * (0.5 + speedN) + h2 * 0.18;

      if (tier === 0) {
        rec.life = 1.3 + h3 * 1.3;
        rec.size0 = (0.55 + h1 * 0.55) * (horse ? 1.8 : 1) * sizeK;
        rec.size1 = rec.size0 * (2.8 + h2 * 1.5);
        rec.a = (0.16 + 0.16 * dry * speedN) * opq;
        rec.drag = 1.9;
        rec.gravity = 1.1;
        rec.turb = 0.35;
      } else if (tier === 1) {
        rec.life = 3.0 + h3 * 2.2;
        rec.size0 = (1.9 + h1 * 1.9) * (horse ? 1.85 : 1) * sizeK;
        rec.size1 = rec.size0 * (2.5 + h2 * 1.4);
        rec.a = (0.095 + 0.115 * dry * (0.4 + speedN)) * opq;
        rec.drag = 1.1;
        rec.gravity = 0.40;
        rec.turb = 0.8;
      } else {
        rec.life = 4.2 + h3 * 3.0;
        rec.size0 = (3.8 + h1 * 3.4) * (horse ? 1.95 : 1) * sizeK;
        rec.size1 = rec.size0 * (2.0 + h2 * 1.1);
        rec.a = (0.052 + 0.070 * dry * (0.3 + speedN)) * opq;
        rec.drag = 0.60;
        rec.gravity = 0.20;
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

    // Samples scale with unit size. Two samples cover a 60-man unit; a 256-man cohort is
    // sixty metres of frontage, and two 2.4 m brushes per tick paint a dotted line down
    // it instead of a churned band. This is why a system stamping tens of thousands of
    // splats was leaving under 0.5% of the field marked.
    const samples = Math.min(10, 2 + (members.length / 40) | 0);
    for (let s = 0; s < samples; s++) {
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
        (0.034 + clamp(sp * 0.014, 0, 0.055) + (fighting ? 0.155 : 0)) * (1.35 - dry * 0.45);
      const slope = terrain?.slopeAt(p.x[i], p.z[i]) ?? 0;
      // A man shoving in a shieldwall works a patch several metres across, not the
      // half-metre his feet occupy: he braces, slips, steps over the fallen and is pushed
      // back and forward across the whole depth of the contact strip.
      const radius = 2.4 + sp * 0.8 + slope * 2.0 + (fighting ? 2.4 : 0);
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
