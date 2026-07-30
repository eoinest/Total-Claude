import { hash01, hash2 } from '../util/rand';
import { clamp01 } from '../util/math';
import { PGround, PLayer, type ParticleSystem } from './ParticleSystem';
import { PT, DT } from './atlas';
import type { GroundDamageLayer } from './GroundDamage';

/**
 * Smoke and fire: hearths, braziers, torches and burning siege material.
 *
 * Rome behind the Roman line has to look inhabited, and the single cheapest way to say
 * "a hundred thousand people live here" is a dozen thin smoke columns leaning downwind
 * over the rooftops. They are also what stops the sky reading as an empty gradient in a
 * wide shot.
 *
 * Fire is layered the way real flame renders: an additive core that is genuinely
 * brighter than white (so the bloom pass catches it), a dimmer additive halo, a rising
 * ember stream, and a dark absorptive smoke column above. The heat shimmer is faked
 * per-particle through the turbulence term rather than as a screen-space distortion
 * pass, which would need to own the framebuffer.
 */

export enum EmitterKind {
  /** A rooftop hearth: smoke only, tall and thin. */
  Hearth = 0,
  /** A brazier or watchfire: flame, embers and a little smoke. */
  Brazier = 1,
  /** Burning siege material: a large ragged fire with heavy black smoke. */
  Pyre = 2,
  /** A carried torch: small, bright, no smoke to speak of. */
  Torch = 3,
}

interface Emitter {
  kind: EmitterKind;
  x: number;
  y: number;
  z: number;
  /** 0 = out, 1 = fully alight. */
  intensity: number;
  /** Fractional particle accumulator per stream. */
  carrySmoke: number;
  carryFlame: number;
  carryEmber: number;
  seed: number;
  /** Metres; drives all the sizes. */
  scale: number;
  /** Whether ground scorch has been stamped yet. */
  scorched: boolean;
}

export class SmokeFire {
  private emitters: Emitter[] = [];
  private t = 0;

  /**
   * Place the standing fires of the scenario. The city sits at +Z behind the Roman
   * line, so hearths are scattered over that ground at rooftop height; braziers stand
   * along the wall line; the Juthungi camp burns behind their host.
   */
  seedScenario(groundAt: (x: number, z: number) => number): void {
    // Insulae hearths across the city quarter. Height above ground stands in for the
    // roofline until the city agent's actual buildings are there to sit them on.
    for (let i = 0; i < 11; i++) {
      const h1 = hash01(i, 701);
      const h2 = hash01(i, 709);
      const h3 = hash01(i, 719);
      const x = -420 + h1 * 840;
      const z = 340 + h2 * 420;
      this.add(EmitterKind.Hearth, x, groundAt(x, z) + 10 + h3 * 14, z, 0.85 + h3 * 0.5, 1);
    }
    // Watchfires on the wall line and behind the Roman reserve.
    for (let i = 0; i < 7; i++) {
      const h1 = hash01(i, 727);
      const h2 = hash01(i, 733);
      const x = -240 + h1 * 480;
      const z = 246 + h2 * 34;
      this.add(EmitterKind.Brazier, x, groundAt(x, z), z, 0.9 + h2 * 0.45, 1);
    }
    // The Juthungi camp: two pyres of burning captured material.
    for (let i = 0; i < 3; i++) {
      const h1 = hash01(i, 739);
      const h2 = hash01(i, 743);
      const x = -170 + h1 * 340;
      const z = -300 - h2 * 90;
      this.add(EmitterKind.Pyre, x, groundAt(x, z), z, 1.5 + h2 * 0.9, 1);
    }
  }

  add(kind: EmitterKind, x: number, y: number, z: number, scale: number, intensity: number): number {
    this.emitters.push({
      kind, x, y, z,
      intensity: clamp01(intensity),
      carrySmoke: 0, carryFlame: 0, carryEmber: 0,
      seed: (this.emitters.length * 977 + 13) | 0,
      scale,
      scorched: false,
    });
    return this.emitters.length - 1;
  }

  setIntensity(index: number, v: number): void {
    const e = this.emitters[index];
    if (e) e.intensity = clamp01(v);
  }

  /**
   * Drop the scenario's guessed emitter placements. The city system knows where its
   * roofs and braziers actually are; once it does, it should clear these and re-add
   * them at real anchor points.
   */
  clear(): void {
    this.emitters.length = 0;
  }

  update(dt: number, ps: ParticleSystem, damage: GroundDamageLayer, camX: number, camZ: number): void {
    if (dt <= 0) return;
    this.t += dt;
    const salt = (this.t * 613) | 0;

    for (let ei = 0; ei < this.emitters.length; ei++) {
      const e = this.emitters[ei];
      if (e.intensity <= 0.01) continue;

      // Nothing beyond a kilometre is worth a particle.
      const dx = e.x - camX;
      const dz = e.z - camZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > 1300 * 1300) continue;
      // Far emitters emit fewer, larger puffs: same silhouette, a tenth of the cost.
      const far = clamp01((Math.sqrt(d2) - 220) / 500);
      const rateK = 1 - far * 0.72;
      const sizeK = 1 + far * 1.3;

      if (!e.scorched && e.kind !== EmitterKind.Hearth) {
        e.scorched = true;
        damage.splat(e.x, e.z, 1.4 * e.scale, DT.scorch, hash01(e.seed, 5) * 6.283, 0, 0.12, 0.72);
      }

      switch (e.kind) {
        case EmitterKind.Hearth:
          this.smokeColumn(dt, ps, e, salt + ei, 0.55 * rateK, sizeK, 0.30, 0.30, 0.31, 0.10);
          break;
        case EmitterKind.Brazier:
          this.flame(dt, ps, e, salt + ei, 12 * rateK, 0.85);
          this.embers(dt, ps, e, salt + ei, 5 * rateK);
          this.smokeColumn(dt, ps, e, salt + ei, 1.1 * rateK, sizeK, 0.20, 0.19, 0.19, 0.14);
          break;
        case EmitterKind.Pyre:
          this.flame(dt, ps, e, salt + ei, 26 * rateK, 1.7);
          this.embers(dt, ps, e, salt + ei, 14 * rateK);
          this.smokeColumn(dt, ps, e, salt + ei, 2.6 * rateK, sizeK, 0.115, 0.105, 0.10, 0.22);
          break;
        case EmitterKind.Torch:
          this.flame(dt, ps, e, salt + ei, 9 * rateK, 0.32);
          this.embers(dt, ps, e, salt + ei, 1.4 * rateK);
          break;
      }
    }
  }

  /** Rising column: buoyant, wind-carried, cooling and spreading as it climbs. */
  private smokeColumn(
    dt: number, ps: ParticleSystem, e: Emitter, salt: number,
    rate: number, sizeK: number, r: number, g: number, b: number, alpha: number
  ): void {
    e.carrySmoke += rate * e.intensity * dt;
    let n = e.carrySmoke | 0;
    if (n <= 0) return;
    e.carrySmoke -= n;
    n = Math.min(n, 4);

    for (let k = 0; k < n; k++) {
      const h1 = hash2(k, salt, 3);
      const h2 = hash2(k, salt, 5);
      const h3 = hash2(k, salt, 7);
      const rec = ps.reset(PLayer.Soft, h3 < 0.5 ? PT.smokeSoft : PT.smokeDense);
      rec.ground = PGround.Free;
      rec.x = e.x + (h1 - 0.5) * 0.5 * e.scale;
      rec.y = e.y + 0.4 * e.scale;
      rec.z = e.z + (h2 - 0.5) * 0.5 * e.scale;
      rec.vx = (h1 - 0.5) * 0.5;
      rec.vz = (h2 - 0.5) * 0.5;
      rec.vy = 2.4 + h3 * 1.8;
      rec.life = 12 + h1 * 14;
      rec.size0 = (1.1 + h2 * 1.1) * e.scale * sizeK;
      rec.size1 = rec.size0 * (5.5 + h3 * 4);
      rec.spin = (h3 - 0.5) * 0.16;
      rec.r = r; rec.g = g; rec.b = b;
      rec.a = alpha * e.intensity;
      // Negative gravity is buoyancy: hot smoke accelerates upward before it cools.
      rec.gravity = -0.55;
      rec.drag = 0.24;
      rec.turb = 2.2;
      rec.windFactor = 1.25;
      ps.push();
    }
  }

  /**
   * Flame body. Two overlapping additive layers: a small very bright core and a larger
   * dimmer envelope. The bright core exceeds 1.0 so the bloom pass has something to
   * find, which is what makes fire read as emitting light rather than being orange.
   */
  private flame(dt: number, ps: ParticleSystem, e: Emitter, salt: number, rate: number, scale: number): void {
    e.carryFlame += rate * e.intensity * dt;
    let n = e.carryFlame | 0;
    if (n <= 0) return;
    e.carryFlame -= n;
    n = Math.min(n, 6);

    for (let k = 0; k < n; k++) {
      const h1 = hash2(k, salt, 11);
      const h2 = hash2(k, salt, 13);
      const h3 = hash2(k, salt, 17);
      const inner = h3 < 0.45;

      const rec = ps.reset(PLayer.Additive, inner ? PT.flame : PT.glow);
      rec.ground = PGround.Free;
      const spread = inner ? 0.16 : 0.3;
      rec.x = e.x + (h1 - 0.5) * spread * scale;
      rec.y = e.y + 0.12 * scale + h2 * 0.2 * scale;
      rec.z = e.z + (h2 - 0.5) * spread * scale;
      rec.vx = (h1 - 0.5) * 0.5;
      rec.vz = (h2 - 0.5) * 0.5;
      rec.vy = (1.9 + h3 * 1.5) * scale;
      rec.life = inner ? 0.34 + h1 * 0.3 : 0.5 + h2 * 0.4;
      rec.size0 = (inner ? 0.36 : 0.62) * scale * (0.7 + h1 * 0.6);
      rec.size1 = rec.size0 * (inner ? 0.5 : 1.5);
      rec.spin = (h3 - 0.5) * 0.7;
      if (inner) {
        rec.r = 1.9; rec.g = 1.25; rec.b = 0.52;
        rec.a = 0.85;
      } else {
        rec.r = 1.15; rec.g = 0.44; rec.b = 0.12;
        rec.a = 0.36;
      }
      rec.gravity = -5.5;
      rec.drag = 2.6;
      // Turbulence is the fake heat shimmer: the licks wander instead of rising true.
      rec.turb = 0.42 * scale;
      rec.windFactor = 0.55;
      ps.push();
    }
  }

  private embers(dt: number, ps: ParticleSystem, e: Emitter, salt: number, rate: number): void {
    e.carryEmber += rate * e.intensity * dt;
    let n = e.carryEmber | 0;
    if (n <= 0) return;
    e.carryEmber -= n;
    n = Math.min(n, 5);

    for (let k = 0; k < n; k++) {
      const h1 = hash2(k, salt, 19);
      const h2 = hash2(k, salt, 23);
      const h3 = hash2(k, salt, 29);
      const rec = ps.reset(PLayer.Additive, PT.ember);
      rec.ground = PGround.Free;
      rec.x = e.x + (h1 - 0.5) * 0.4 * e.scale;
      rec.y = e.y + 0.5 * e.scale;
      rec.z = e.z + (h2 - 0.5) * 0.4 * e.scale;
      rec.vx = (h1 - 0.5) * 1.2;
      rec.vz = (h2 - 0.5) * 1.2;
      rec.vy = 3.4 + h3 * 3.4;
      rec.life = 2.2 + h1 * 2.8;
      rec.size0 = 0.05 + h2 * 0.05;
      rec.size1 = rec.size0 * 0.4;
      rec.r = 1.5; rec.g = 0.6; rec.b = 0.16;
      rec.a = 0.8;
      // Embers cool and sink once the updraught lets go of them.
      rec.gravity = -1.4;
      rec.drag = 0.7;
      rec.turb = 1.6;
      rec.windFactor = 1.5;
      ps.push();
    }
  }

  get count(): number {
    return this.emitters.length;
  }
}
