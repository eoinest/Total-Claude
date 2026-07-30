import * as THREE from 'three';
import type { EngineContext } from '../core/Engine';
import type { BattleSystem } from '../sim/BattleSystem';
import { Faction, SoldierState } from '../sim/types';
import { clamp, clamp01 } from '../util/math';
import { hash01, hash2 } from '../util/rand';
import { PGround, PLayer, type ParticleSystem } from './ParticleSystem';
import { DT, PT } from './atlas';
import type { GroundDamageLayer } from './GroundDamage';
import type { DecalPool } from './DecalPool';
import type { LitterField, ShaftKind } from './Litter';

/**
 * Blood, impacts and the shock of contact.
 *
 * Rome II is bloody without being a splatter film, and the difference is entirely in
 * the physics: blood behaves like a fluid thrown by a specific blow in a specific
 * direction, then lands and stays. So every spray here is oriented along the line from
 * the attacker to the victim, and every spray deposits ground staining where its
 * droplets would fall. Nothing is a radial red firework.
 *
 * Impacts are differentiated by what the blow struck, because that is the read the
 * player uses to judge whether their line is winning:
 *   armour  bright, short, additive sparks — steel skidding off steel
 *   shield  pale wood splinters and a hard dust crack
 *   flesh   a dull, dark, low spray with no sparkle at all
 *   parry   a fast bright ring plus a couple of sparks — the "your man survived" tell
 *
 * Every subscription is optional. Where the combat systems are not yet emitting, the
 * same effects are derived from `battle.pool` state transitions instead, so the
 * battlefield is never sterile just because a producer has not landed.
 */

/** Venous blood, unlit; the particle shader's sun term brightens it. */
const BLOOD_R = 0.235;
const BLOOD_G = 0.030;
const BLOOD_B = 0.026;
/** Arterial blood is brighter and more orange — oxygenated. */
const ART_R = 0.40;
const ART_G = 0.048;
const ART_B = 0.036;

export type MeleeKind = 'flesh' | 'shield' | 'armour' | 'parry' | 'miss';

interface Pulse {
  t: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  strength: number;
  kind: 0 | 1;
}

interface CorpsePool {
  t: number;
  x: number;
  z: number;
  seed: number;
}

export interface CombatFXHooks {
  /** Raise a soldier's accumulated blood/dirt. Wired by the integrator. */
  grimeSink: ((soldierIndex: number, amount: number) => void) | null;
}

export class CombatFX {
  readonly hooks: CombatFXHooks = { grimeSink: null };

  /** Set false if another system already forwards `cameraShake` to the rig. */
  forwardCameraShake = true;

  private ps!: ParticleSystem;
  private damage!: GroundDamageLayer;
  private decals!: DecalPool;
  private litter!: LitterField;
  private battle!: BattleSystem;
  private ctx!: EngineContext;

  /** Delayed arterial pulses — a killing blow bleeds in beats, not one burst. */
  private pulses: Pulse[] = [];
  private pulseCount = 0;
  /** Corpse pools grow in over a few seconds rather than appearing instantly. */
  private pools: CorpsePool[] = [];
  private poolCount = 0;

  /** Death already processed, so event and state-transition paths cannot double up. */
  private deathSeen!: Uint8Array;
  /** Previous soldier state, for deriving transitions the sim does not announce. */
  private prevState!: Uint8Array;

  private t = 0;
  private lastRealHit = -100;
  private lastRealClash = -100;
  private derivedHitCarry = 0;
  /** Monotonic seed for spent shafts, so no two share a length, lean or colour. */
  private shaftSeed = 1;
  private impactsThisFrame = 0;
  private hitsSeen = 0;
  private deathsSeen = 0;

  init(
    ctx: EngineContext,
    battle: BattleSystem,
    ps: ParticleSystem,
    damage: GroundDamageLayer,
    decals: DecalPool,
    litter: LitterField
  ): void {
    this.ctx = ctx;
    this.battle = battle;
    this.ps = ps;
    this.damage = damage;
    this.decals = decals;
    this.litter = litter;

    const cap = battle.pool.capacity;
    this.deathSeen = new Uint8Array(cap);
    this.prevState = new Uint8Array(cap);

    const e = ctx.events;
    e.on('meleeHit', (h) => {
      if (!h) return;
      this.lastRealHit = this.t;
      this.hitsSeen++;
      this.meleeHit(h.x, h.y, h.z, h.kind, h.lethal, h.attackerFaction);
    });
    e.on('projectileImpact', (h) => {
      if (!h) return;
      this.projectileImpact(h.x, h.y, h.z, h.material, h.hitTarget, h.kind);
    });
    e.on('soldierDied', (d) => {
      if (!d) return;
      this.soldierDied(d.index, d.x, d.y, d.z);
    });
    e.on('linesClashed', (c) => {
      if (!c) return;
      this.lastRealClash = this.t;
      this.clash(c.x, c.z, c.intensity, false);
    });
    e.on('cavalryCharge', (c) => {
      if (!c) return;
      this.lastRealClash = this.t;
      this.clash(c.x, c.z, c.intensity, true);
    });
    e.on('volleyFired', (v) => {
      if (!v) return;
      this.volley(v.x, v.y, v.z, v.count);
    });
    e.on('cameraShake', (s) => {
      if (!s || !this.forwardCameraShake) return;
      ctx.rig.shake(s.amplitude, s.decay ?? 3.2);
    });
  }

  // -------------------------------------------------------------------------
  // Melee impacts
  // -------------------------------------------------------------------------

  /**
   * Direction the blow travelled, derived from the nearest living enemy of the
   * attacking faction. Falls back to the deployment axis, which for this scenario is
   * always a decent guess: Rome fights north, the Juthungi south.
   */
  private blowDirection(x: number, z: number, attackerFaction: number, out: THREE.Vector2): void {
    const b = this.battle;
    const p = b.pool;
    const j = b.hash.nearest(x, z, 2.4, p.x, p.z, (i) =>
      p.faction[i] === attackerFaction && p.aliveAt(i)
    );
    if (j >= 0) {
      const dx = x - p.x[j];
      const dz = z - p.z[j];
      const l = Math.hypot(dx, dz);
      if (l > 0.05) {
        out.set(dx / l, dz / l);
        return;
      }
    }
    const s = attackerFaction === Faction.Rome ? -1 : 1;
    out.set(0, s);
  }

  private dirScratch = new THREE.Vector2();

  meleeHit(x: number, y: number, z: number, kind: MeleeKind, lethal: boolean, attackerFaction: number): void {
    if (kind === 'miss') return;
    if (this.impactsThisFrame > 90) return;
    this.impactsThisFrame++;

    this.blowDirection(x, z, attackerFaction, this.dirScratch);
    const dx = this.dirScratch.x;
    const dz = this.dirScratch.y;
    // Chest height: blows land on the torso, not at the feet.
    const hy = y + 1.05;
    const salt = (this.t * 9173) | 0;

    switch (kind) {
      case 'armour':
        this.sparks(x, hy, z, dx, dz, 1, salt);
        this.dullPuff(x, hy, z, 0.30, 0.085, salt, 0.70, 0.64, 0.54);
        break;
      case 'shield':
        this.splinters(x, hy, z, dx, dz, salt);
        this.dullPuff(x, hy, z, 0.46, 0.105, salt, 0.80, 0.70, 0.52);
        break;
      case 'parry':
        this.parryRing(x, hy, z, salt);
        this.sparks(x, hy, z, dx, dz, 0.45, salt + 7);
        break;
      case 'flesh':
        this.bloodSpray(x, hy, z, dx, dz, lethal ? 1.5 : 0.7, lethal);
        break;
    }
    if (lethal && kind !== 'flesh') {
      this.bloodSpray(x, hy, z, dx, dz, 1.2, true);
    }
  }

  /**
   * A spray of blood along the blow direction. `amount` scales droplet count and
   * spread; `arterial` adds the bright pulsing jet a severed artery throws.
   */
  bloodSpray(x: number, y: number, z: number, dx: number, dz: number, amount: number, arterial: boolean): void {
    const ps = this.ps;
    const salt = ((this.t * 7919 + x * 13 + z * 7) | 0) ^ 0x5bd1;
    const n = Math.min(26, Math.round((arterial ? 14 : 6) * amount));

    // Cone of droplets. Blood leaves a wound fast and decelerates hard in air.
    for (let k = 0; k < n; k++) {
      const h1 = hash01(k, salt);
      const h2 = hash01(k, salt + 1);
      const h3 = hash01(k, salt + 2);
      const h4 = hash01(k, salt + 3);
      // ±55° around the blow direction, biased forward.
      const spread = (h1 - 0.5) * 1.9;
      const cs = Math.cos(spread);
      const sn = Math.sin(spread);
      const ox = dx * cs - dz * sn;
      const oz = dx * sn + dz * cs;
      const speed = (arterial ? 4.2 : 2.6) * (0.45 + h2 * 1.15) * amount;

      const rec = ps.reset(PLayer.Soft, h3 < 0.4 ? PT.bloodSpray : PT.bloodDrop);
      rec.x = x + ox * 0.22;
      rec.y = y + (h4 - 0.4) * 0.32;
      rec.z = z + oz * 0.22;
      rec.vx = ox * speed;
      rec.vz = oz * speed;
      rec.vy = 1.1 + h2 * 2.6 + (arterial ? 1.4 : 0);
      rec.life = 0.55 + h3 * 0.6;
      rec.size0 = 0.055 + h1 * 0.085;
      rec.size1 = rec.size0 * 1.25;
      rec.spin = (h4 - 0.5) * 9;
      rec.r = arterial ? ART_R : BLOOD_R;
      rec.g = arterial ? ART_G : BLOOD_G;
      rec.b = arterial ? ART_B : BLOOD_B;
      rec.a = 0.88;
      rec.gravity = 9.81;
      rec.drag = 1.5;
      rec.windFactor = 0.12;
      ps.push();
    }

    // Fine mist hanging where the blow landed. This is what makes a hit read as wet.
    const mistN = arterial ? 5 : 3;
    for (let k = 0; k < mistN; k++) {
      const h1 = hash01(k, salt + 11);
      const h2 = hash01(k, salt + 12);
      const rec = ps.reset(PLayer.Soft, PT.smokeSoft);
      rec.x = x + dx * 0.3 + (h1 - 0.5) * 0.3;
      rec.y = y + (h2 - 0.5) * 0.3;
      rec.z = z + dz * 0.3 + (h2 - 0.5) * 0.3;
      rec.vx = dx * 1.1;
      rec.vz = dz * 1.1;
      rec.vy = 0.5;
      rec.life = 0.42 + h1 * 0.38;
      // Kept under half a metre. A blood mist puff scaled to two metres stops being mist
      // and becomes a discrete red ball floating over the ranks — the exact "flat unlit
      // billboard" read the whole layer is meant to avoid.
      rec.size0 = 0.16 + h2 * 0.16;
      rec.size1 = rec.size0 * 2.1;
      rec.r = BLOOD_R * 1.5;
      rec.g = BLOOD_G * 1.7;
      rec.b = BLOOD_B * 1.7;
      rec.a = 0.34 * clamp01(amount);
      rec.gravity = 1.2;
      rec.drag = 3.2;
      rec.turb = 0.2;
      rec.windFactor = 0.6;
      ps.push();
    }

    // Where the droplets land: soak into the accumulation buffer, plus one sharp
    // cast-off decal for the near view.
    const reach = (arterial ? 2.6 : 1.5) * amount;
    for (let k = 0; k < 3; k++) {
      const h1 = hash01(k, salt + 21);
      const h2 = hash01(k, salt + 22);
      const d = 0.35 + h1 * reach;
      this.damage.splat(
        x + dx * d + (h2 - 0.5) * 0.9,
        z + dz * d + (h1 - 0.5) * 0.9,
        0.85 + h2 * 0.9,
        DT.bloodDrops,
        h1 * 6.283,
        (arterial ? 0.44 : 0.24) * clamp01(amount),
        0,
        0
      );
    }
    if (arterial) {
      const h1 = hash01(0, salt + 31);
      this.decals.add(
        x + dx * (0.6 + h1 * 1.2),
        z + dz * (0.6 + h1 * 1.2),
        1.5 + h1 * 1.3,
        1.9 + h1 * 1.5,
        Math.atan2(dx, dz),
        DT.bloodSplatter,
        0.20, 0.040, 0.033, 0.85,
        260
      );
      // Two follow-up beats: the heart is still pumping for a second or two.
      this.queuePulse(x, y, z, dx, dz, amount * 0.7, 0.14);
      this.queuePulse(x, y, z, dx, dz, amount * 0.45, 0.34);
    }
  }

  private queuePulse(x: number, y: number, z: number, dx: number, dz: number, strength: number, delay: number): void {
    if (this.pulseCount >= 96) return;
    const p = this.pulses[this.pulseCount] ?? { t: 0, x: 0, y: 0, z: 0, dx: 0, dz: 0, strength: 0, kind: 0 as 0 | 1 };
    p.t = this.t + delay;
    p.x = x; p.y = y; p.z = z;
    p.dx = dx; p.dz = dz;
    p.strength = strength;
    p.kind = 1;
    this.pulses[this.pulseCount++] = p;
  }

  private sparks(x: number, y: number, z: number, dx: number, dz: number, scale: number, salt: number): void {
    const ps = this.ps;
    const n = Math.round(12 * scale) + 4;
    for (let k = 0; k < n; k++) {
      const h1 = hash01(k, salt);
      const h2 = hash01(k, salt + 1);
      const h3 = hash01(k, salt + 2);
      // Sparks scatter into a wide fan reflected off the struck surface.
      const a = (h1 - 0.5) * 3.4;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      const ox = dx * cs - dz * sn;
      const oz = dx * sn + dz * cs;
      const speed = 3.5 + h2 * 7;
      const rec = ps.reset(PLayer.Additive, h3 < 0.75 ? PT.spark : PT.ember);
      rec.ground = PGround.Free;
      rec.x = x; rec.y = y; rec.z = z;
      rec.vx = ox * speed;
      rec.vz = oz * speed;
      rec.vy = 1.4 + h3 * 4.2;
      rec.life = 0.22 + h2 * 0.38;
      rec.size0 = 0.13 + h1 * 0.20;
      rec.size1 = rec.size0 * 0.45;
      rec.spin = (h3 - 0.5) * 2;
      rec.r = 1.7; rec.g = 1.05; rec.b = 0.42;
      rec.a = 0.95 * scale;
      rec.gravity = 12;
      rec.drag = 2.4;
      rec.windFactor = 0.05;
      ps.push();
    }
    // The strike flash itself: one frame of white-hot contact, which is what the eye
    // actually catches in a crush where individual sparks are only a few pixels.
    const flash = ps.reset(PLayer.Additive, PT.glow);
    flash.ground = PGround.Free;
    flash.x = x; flash.y = y; flash.z = z;
    flash.life = 0.09;
    flash.size0 = 0.42 * scale + 0.16;
    flash.size1 = 0.12;
    flash.r = 1.9; flash.g = 1.35; flash.b = 0.72;
    flash.a = 0.7 * scale;
    flash.gravity = 0;
    flash.drag = 6;
    flash.windFactor = 0;
    ps.push();
  }

  private splinters(x: number, y: number, z: number, dx: number, dz: number, salt: number): void {
    const ps = this.ps;
    for (let k = 0; k < 7; k++) {
      const h1 = hash01(k, salt + 5);
      const h2 = hash01(k, salt + 6);
      const h3 = hash01(k, salt + 7);
      const a = (h1 - 0.5) * 2.6;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      const rec = ps.reset(PLayer.Soft, h2 < 0.6 ? PT.splinter : PT.debrisChip);
      rec.ground = PGround.Free;
      rec.x = x; rec.y = y; rec.z = z;
      rec.vx = (dx * cs - dz * sn) * (2.4 + h2 * 4);
      rec.vz = (dx * sn + dz * cs) * (2.4 + h2 * 4);
      rec.vy = 1.6 + h3 * 3.4;
      rec.life = 0.7 + h3 * 0.7;
      rec.size0 = 0.10 + h1 * 0.15;
      rec.size1 = rec.size0;
      rec.spin = (h2 - 0.5) * 22;
      // Limewood shield board: pale, slightly yellow.
      rec.r = 0.78; rec.g = 0.68; rec.b = 0.50;
      rec.a = 1;
      rec.gravity = 11;
      rec.drag = 1.2;
      rec.windFactor = 0.08;
      ps.push();
    }
  }

  private dullPuff(
    x: number, y: number, z: number, size: number, alpha: number, salt: number,
    r: number, g: number, b: number
  ): void {
    const ps = this.ps;
    for (let k = 0; k < 2; k++) {
      const h1 = hash01(k, salt + 41);
      const h2 = hash01(k, salt + 42);
      const rec = ps.reset(PLayer.Soft, PT.smokeSoft);
      rec.ground = PGround.Free;
      rec.x = x + (h1 - 0.5) * 0.2;
      rec.y = y + (h2 - 0.5) * 0.2;
      rec.z = z + (h2 - 0.5) * 0.2;
      rec.vy = 0.7 + h1 * 0.6;
      rec.life = 0.34 + h2 * 0.32;
      rec.size0 = size * (0.5 + h1 * 0.45);
      rec.size1 = rec.size0 * 2.0;
      rec.r = r; rec.g = g; rec.b = b;
      rec.a = alpha;
      rec.gravity = 0.4;
      rec.drag = 3;
      rec.windFactor = 0.8;
      ps.push();
    }
  }

  private parryRing(x: number, y: number, z: number, salt: number): void {
    const ps = this.ps;
    const rec = ps.reset(PLayer.Additive, PT.ring);
    rec.ground = PGround.Free;
    rec.x = x; rec.y = y; rec.z = z;
    rec.life = 0.17;
    rec.size0 = 0.20;
    rec.size1 = 1.15;
    rec.spin = (hash01(0, salt) - 0.5) * 6;
    rec.r = 1.6; rec.g = 1.5; rec.b = 1.28;
    rec.a = 0.85;
    rec.gravity = 0;
    rec.drag = 4;
    rec.windFactor = 0;
    ps.push();

    const flash = ps.reset(PLayer.Additive, PT.glow);
    flash.ground = PGround.Free;
    flash.x = x; flash.y = y; flash.z = z;
    flash.life = 0.11;
    flash.size0 = 0.62;
    flash.size1 = 0.2;
    flash.r = 1.7; flash.g = 1.5; flash.b = 1.2;
    flash.a = 0.65;
    flash.gravity = 0;
    flash.drag = 6;
    flash.windFactor = 0;
    ps.push();
  }

  // -------------------------------------------------------------------------
  // Projectiles
  // -------------------------------------------------------------------------

  projectileImpact(
    x: number, y: number, z: number,
    material: 'ground' | 'shield' | 'flesh' | 'armour' | 'stone' | 'wood',
    hitTarget: boolean,
    kind: ShaftKind = 'arrow'
  ): void {
    const salt = ((this.t * 4409 + x * 3) | 0) ^ 0x2f1d;
    // Every missile that is not a sling stone leaves its shaft behind. Ground misses
    // stand where they fell; a shaft that glanced off a shield or a helmet drops at the
    // man's feet. Four thousand volleyed missiles over a battle is what fills a Rome II
    // field with spent kit, and it is the single most legible record of the fight.
    if (material === 'ground') {
      this.litter.plantShaft(kind, x, z, this.shaftSeed++);
    } else if (material === 'shield' || material === 'armour' || material === 'wood') {
      if (hash01(this.shaftSeed, 0x9e3) < 0.5) {
        const a = hash01(this.shaftSeed, 0x7f1) * 6.283;
        const r = 0.5 + hash01(this.shaftSeed, 0x5a3) * 1.1;
        this.litter.plantShaft(kind, x + Math.cos(a) * r, z + Math.sin(a) * r, this.shaftSeed);
      }
      this.shaftSeed++;
    }
    switch (material) {
      case 'ground': {
        // Dirt kicked up, plus a lasting scuff where the shaft went in.
        const ps = this.ps;
        for (let k = 0; k < 5; k++) {
          const h1 = hash01(k, salt);
          const h2 = hash01(k, salt + 1);
          const rec = ps.reset(PLayer.Soft, h1 < 0.5 ? PT.clod : PT.dustWisp);
          rec.x = x; rec.y = y + 0.1; rec.z = z;
          rec.vx = (h1 - 0.5) * 2.6;
          rec.vz = (h2 - 0.5) * 2.6;
          rec.vy = 1.8 + h2 * 2.4;
          rec.life = 0.6 + h2 * 0.6;
          rec.size0 = 0.11 + h1 * 0.2;
          rec.size1 = rec.size0 * 2.4;
          rec.spin = (h2 - 0.5) * 12;
          rec.r = 0.52; rec.g = 0.44; rec.b = 0.33;
          rec.a = 0.7;
          rec.gravity = 10;
          rec.drag = 2.2;
          rec.windFactor = 0.3;
          ps.push();
        }
        this.damage.splat(x, z, 0.9, DT.dirtScuff, hash01(1, salt) * 6.283, 0, 0.20, 0);
        break;
      }
      case 'flesh':
        this.blowDirection(x, z, Faction.Rome, this.dirScratch);
        this.bloodSpray(x, y + 1.0, z, this.dirScratch.x, this.dirScratch.y, 0.8, false);
        break;
      case 'armour':
      case 'stone':
        this.sparks(x, y + 0.9, z, 0, 1, 0.7, salt);
        break;
      case 'shield':
      case 'wood':
        this.splinters(x, y + 1.0, z, 0, 1, salt);
        break;
    }
    void hitTarget;
  }

  /** A volley leaving the line: dust off the ground, a ripple of movement. */
  volley(x: number, y: number, z: number, count: number): void {
    const ps = this.ps;
    const salt = ((this.t * 3313) | 0) ^ 0x77a1;
    const n = Math.min(14, 3 + (count / 12) | 0);
    for (let k = 0; k < n; k++) {
      const h1 = hash01(k, salt);
      const h2 = hash01(k, salt + 1);
      const rec = ps.reset(PLayer.Soft, PT.dustWisp);
      rec.x = x + (h1 - 0.5) * 18;
      rec.y = y + 0.1;
      rec.z = z + (h2 - 0.5) * 6;
      rec.vy = 0.7 + h1 * 0.6;
      rec.life = 1.6 + h2 * 1.4;
      rec.size0 = 0.6 + h1 * 0.7;
      rec.size1 = rec.size0 * 3.6;
      rec.r = 0.70; rec.g = 0.62; rec.b = 0.48;
      rec.a = 0.10;
      rec.gravity = 0.4;
      rec.drag = 1.3;
      rec.turb = 0.5;
      ps.push();
    }
  }

  // -------------------------------------------------------------------------
  // Death
  // -------------------------------------------------------------------------

  soldierDied(index: number, x: number, y: number, z: number): void {
    if (index >= 0 && index < this.deathSeen.length) {
      if (this.deathSeen[index]) return;
      this.deathSeen[index] = 1;
    }
    this.deathsSeen++;

    const p = this.battle.pool;
    // Death direction is the direction the blow threw him, so the spray follows it.
    const dx = index >= 0 ? p.deathDirX[index] : 0;
    const dz = index >= 0 ? p.deathDirZ[index] : 1;
    const l = Math.hypot(dx, dz) || 1;

    this.bloodSpray(x, y + 1.0, z, dx / l, dz / l, 1.35, true);
    this.hooks.grimeSink?.(index, 0.5);

    // The pool arrives as the body settles, not the instant he is hit. The queue has to
    // be deep enough to absorb a rout, where a hundred men can fall inside a second.
    if (this.poolCount < 384) {
      const rec = this.pools[this.poolCount] ?? { t: 0, x: 0, z: 0, seed: 0 };
      rec.t = this.t + 0.7 + hash01(index, 3) * 0.9;
      rec.x = x + (dx / l) * 0.4;
      rec.z = z + (dz / l) * 0.4;
      rec.seed = index;
      this.pools[this.poolCount++] = rec;
    }

    this.litter.dropFrom(index, x, y, z, this.battle);
  }

  // -------------------------------------------------------------------------
  // Charges and clashes
  // -------------------------------------------------------------------------

  /** Shockwave of dust and debris where two bodies of men meet. */
  clash(x: number, z: number, intensity: number, cavalry: boolean): void {
    const ps = this.ps;
    const b = this.battle;
    const y = b.groundAt(x, z);
    const salt = ((this.t * 6151 + x) | 0) ^ 0x1a3b;
    const k = clamp(intensity, 0.15, 3);
    const n = Math.round((cavalry ? 130 : 90) * clamp(k, 0.35, 2));

    // Ring of dust thrown outward and up: reads as displaced air, not an explosion.
    // Deliberately over-scaled relative to the clods and sparks, because the shockwave's
    // whole job is to make one frame of the battle unmistakably the frame where the lines
    // met — from a strategic camera the individual debris is two pixels and the dust is
    // the only thing that carries the event.
    for (let i = 0; i < n; i++) {
      const h1 = hash01(i, salt);
      const h2 = hash01(i, salt + 1);
      const h3 = hash01(i, salt + 2);
      const a = (i / n) * Math.PI * 2 + (h1 - 0.5) * 0.7;
      const speed = (cavalry ? 6.5 : 4.2) * (0.4 + h2 * 1.2) * k;
      const rec = ps.reset(PLayer.Soft, h3 < 0.45 ? PT.dustBillow : PT.smokeSoft);
      // Thrown along the whole frontage, not out of a point: two lines meet over tens of
      // metres, and a circular puff at the centroid reads as a grenade.
      const r0 = (cavalry ? 5.5 : 4.0) * (0.3 + h3 * 1.5);
      rec.x = x + Math.cos(a) * r0 * 2.2;
      rec.z = z + Math.sin(a) * r0;
      rec.y = y + 0.15 + h1 * 0.4;
      rec.vx = Math.cos(a) * speed;
      rec.vz = Math.sin(a) * speed;
      rec.vy = 1.4 + h2 * 3.2;
      rec.life = 4.2 + h3 * 5.0;
      rec.size0 = (cavalry ? 2.4 : 1.7) * (0.6 + h1 * 1.1);
      rec.size1 = rec.size0 * (3.4 + h2 * 2.6);
      rec.spin = (h3 - 0.5) * 0.5;
      rec.r = 1.12; rec.g = 0.90; rec.b = 0.60;
      rec.a = 0.15 + 0.10 * k;
      rec.gravity = 0.5;
      rec.drag = 0.85;
      rec.turb = 1.1;
      rec.windFactor = 0.7;
      ps.push();
    }

    // Clods and chips torn out of the turf.
    for (let i = 0; i < (cavalry ? 22 : 12); i++) {
      const h1 = hash01(i, salt + 11);
      const h2 = hash01(i, salt + 12);
      const h3 = hash01(i, salt + 13);
      const a = h1 * Math.PI * 2;
      const rec = ps.reset(PLayer.Soft, h2 < 0.6 ? PT.clod : PT.debrisChip);
      rec.ground = PGround.Free;
      rec.x = x + Math.cos(a) * h2 * 2.5;
      rec.y = y + 0.2;
      rec.z = z + Math.sin(a) * h2 * 2.5;
      rec.vx = Math.cos(a) * (3 + h3 * 7);
      rec.vz = Math.sin(a) * (3 + h3 * 7);
      rec.vy = 3.5 + h3 * 5.5;
      rec.life = 1.1 + h1 * 0.9;
      rec.size0 = 0.1 + h2 * 0.24;
      rec.size1 = rec.size0;
      rec.spin = (h3 - 0.5) * 20;
      rec.r = 0.44; rec.g = 0.37; rec.b = 0.27;
      rec.a = 1;
      rec.gravity = 11;
      rec.drag = 0.7;
      rec.windFactor = 0.05;
      ps.push();
    }

    // Ground churned by the collision, permanently.
    const rad = cavalry ? 16 : 11;
    for (let i = 0; i < 12; i++) {
      const h1 = hash01(i, salt + 21);
      const h2 = hash01(i, salt + 22);
      const a = h1 * Math.PI * 2;
      const d = h2 * rad;
      this.damage.splat(
        x + Math.cos(a) * d,
        z + Math.sin(a) * d,
        3.0 + h2 * 4.0,
        cavalry ? DT.hoofScuff : DT.dirtScuff,
        a,
        0,
        0.16 + 0.12 * k,
        0
      );
    }

    // Camera shake, attenuated with distance so a clash across the map is not felt.
    const cam = this.ctx.camera.position;
    const d = Math.hypot(cam.x - x, cam.z - z);
    const amp = clamp01((cavalry ? 0.5 : 0.34) * k * (1 - clamp01((d - 25) / 180)));
    if (amp > 0.004) {
      this.ctx.events.emit('cameraShake', { amplitude: amp, decay: cavalry ? 2.4 : 3.4 });
    }
  }

  // -------------------------------------------------------------------------
  // Frame update: derived effects and deferred work
  // -------------------------------------------------------------------------

  update(dt: number): void {
    this.t += dt;
    this.impactsThisFrame = 0;

    this.runPulses();
    this.runPools();
    this.deriveDeaths();
    this.deriveMelee(dt);
  }

  private runPulses(): void {
    for (let i = this.pulseCount - 1; i >= 0; i--) {
      const p = this.pulses[i];
      if (p.t > this.t) continue;
      this.bloodSpray(p.x, p.y, p.z, p.dx, p.dz, p.strength, false);
      this.pulses[i] = this.pulses[this.pulseCount - 1];
      this.pulses[this.pulseCount - 1] = p;
      this.pulseCount--;
    }
  }

  private runPools(): void {
    for (let i = this.poolCount - 1; i >= 0; i--) {
      const c = this.pools[i];
      if (c.t > this.t) continue;
      const h1 = hash01(c.seed, 71);
      const h2 = hash01(c.seed, 73);
      const h3 = hash01(c.seed, 79);
      // A man holds about five litres. On packed earth that soaks and spreads to
      // roughly two metres across before it stops moving.
      this.decals.add(
        c.x, c.z,
        1.8 + h1 * 1.3,
        2.0 + h2 * 1.4,
        h3 * 6.283,
        DT.bloodPool,
        0.145, 0.032, 0.026,
        0.95,
        900
      );
      this.damage.splat(c.x, c.z, 2.6 + h1 * 1.8, DT.bloodPool, h3 * 6.283, 0.85, 0.14, 0);
      // Satellites: the ground around a body is never a clean disc.
      for (let k = 0; k < 3; k++) {
        const a = hash01(c.seed * 3 + k, 83) * 6.283;
        const r = 1.0 + hash01(c.seed * 3 + k, 89) * 2.4;
        this.damage.splat(
          c.x + Math.cos(a) * r,
          c.z + Math.sin(a) * r,
          1.5 + hash01(c.seed * 3 + k, 97) * 1.6,
          k === 0 ? DT.bloodStreak : DT.bloodDrops,
          a,
          0.38, 0.07, 0
        );
      }
      // A wide, faint soak beyond the pool. This is what turns a scatter of discs into
      // one continuous stained area where the fighting was heaviest — the read that
      // separates "a battle happened here" from "someone stamped some decals".
      this.damage.splat(c.x, c.z, 5.5 + h2 * 3.0, DT.trampleSoft, h1 * 6.283, 0.11, 0.09, 0);
      this.pools[i] = this.pools[this.poolCount - 1];
      this.pools[this.poolCount - 1] = c;
      this.poolCount--;
    }
  }

  /**
   * Catch deaths that arrive as a state transition without an event. The sim's
   * `damage()` does emit `soldierDied`, but a ragdoll or morale system killing a man
   * another way must not leave a bloodless corpse.
   */
  private deriveDeaths(): void {
    const p = this.battle.pool;
    const n = Math.min(p.count, this.prevState.length);
    for (let i = 0; i < n; i++) {
      const st = p.state[i];
      const prev = this.prevState[i];
      if (st !== prev) {
        this.prevState[i] = st;
        if (
          (st === SoldierState.Dying || st === SoldierState.Dead) &&
          prev !== SoldierState.Dying && prev !== SoldierState.Dead &&
          !this.deathSeen[i]
        ) {
          this.soldierDied(i, p.x[i], p.y[i], p.z[i]);
        }
      }
    }
  }

  /**
   * Derived melee impacts. While the combat subsystem is silent, a melee still has to
   * spark and spray, so impacts are synthesised from the men actually in the
   * `Fighting` state at a rate matched to their attack rate. Suppressed the moment
   * real `meleeHit` events start arriving, so the two never double up.
   */
  private deriveMelee(dt: number): void {
    if (this.t - this.lastRealHit < 2.5) return;
    const b = this.battle;
    const p = b.pool;
    const n = p.count;

    let fighting = 0;
    for (let i = 0; i < n; i++) if (p.state[i] === SoldierState.Fighting) fighting++;
    if (fighting === 0) return;

    // Roughly one landed blow per man per 1.6 s, of which a third are worth showing.
    this.derivedHitCarry += fighting * dt * 0.21;
    let count = Math.min(70, this.derivedHitCarry | 0);
    if (count <= 0) return;
    this.derivedHitCarry -= count;

    const salt = (this.t * 5381) | 0;
    for (let k = 0; k < count; k++) {
      // Reservoir-free sampling: walk from a hashed offset until a fighter turns up.
      let i = (hash2(k, salt, 3) * n) | 0;
      let guard = 0;
      while (guard++ < 24 && p.state[i] !== SoldierState.Fighting) i = (i + 977) % n;
      if (p.state[i] !== SoldierState.Fighting) continue;

      const tgt = p.target[i];
      let dx: number;
      let dz: number;
      let hx: number;
      let hz: number;
      if (tgt >= 0 && tgt < n) {
        dx = p.x[tgt] - p.x[i];
        dz = p.z[tgt] - p.z[i];
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        hx = (p.x[i] + p.x[tgt]) * 0.5;
        hz = (p.z[i] + p.z[tgt]) * 0.5;
      } else {
        dx = Math.sin(p.facing[i]);
        dz = Math.cos(p.facing[i]);
        hx = p.x[i] + dx * 0.6;
        hz = p.z[i] + dz * 0.6;
      }

      const roll = hash01(i + k, salt + 5);
      const kind: MeleeKind = roll < 0.34 ? 'shield' : roll < 0.58 ? 'armour' : roll < 0.82 ? 'parry' : 'flesh';
      const hy = b.groundAt(hx, hz) + 1.0;
      this.dirScratch.set(dx, dz);
      switch (kind) {
        case 'armour':
          this.sparks(hx, hy, hz, dx, dz, 0.8, salt + k);
          break;
        case 'shield':
          this.splinters(hx, hy, hz, dx, dz, salt + k);
          this.dullPuff(hx, hy, hz, 0.42, 0.10, salt + k, 0.80, 0.70, 0.52);
          break;
        case 'parry':
          this.parryRing(hx, hy, hz, salt + k);
          break;
        case 'flesh':
          this.bloodSpray(hx, hy, hz, dx, dz, 0.55, false);
          this.hooks.grimeSink?.(i, 0.02);
          break;
      }
    }
  }

  /**
   * Derived clash: when a large number of men enter contact at once and no
   * `linesClashed` has arrived, synthesise the shockwave locally.
   */
  deriveClash(unitX: number, unitZ: number, intensity: number, cavalry: boolean): void {
    if (this.t - this.lastRealClash < 4) return;
    this.clash(unitX, unitZ, intensity, cavalry);
    this.lastRealClash = this.t - 3;
  }

  stats(): { hits: number; deaths: number; pulses: number; pools: number } {
    return { hits: this.hitsSeen, deaths: this.deathsSeen, pulses: this.pulseCount, pools: this.poolCount };
  }
}
