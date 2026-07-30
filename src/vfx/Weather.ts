import * as THREE from 'three';
import { clamp01 } from '../util/math';
import { hash2 } from '../util/rand';
import { PGround, PLayer, ParticleSystem } from './ParticleSystem';
import { PT } from './atlas';

/**
 * Wind and weather.
 *
 * Wind is the single most useful shared quantity in the whole effects layer: it drives
 * dust drift, smoke columns, banner cloth, ember travel and rain slant, and it is what
 * makes a still frame feel like outdoors rather than a diorama. It is exposed on the
 * VFX subsystem so vegetation and cloth elsewhere can read the same vector and agree.
 *
 * The model is a steady breeze plus two incommensurate gust oscillators plus a slow
 * direction wander. Gusts arrive in the 4–11 s band, which is roughly what a real
 * gusty day does and slow enough for the eye to read the banners answering it.
 */

export type WeatherKind = 'clear' | 'overcast' | 'rain';

export interface WeatherPreset {
  /** Steady wind speed in m/s. */
  windSpeed: number;
  /** Compass bearing the wind blows toward, radians. */
  windBearing: number;
  gustiness: number;
  /** Multiplier on dust emission — wet ground barely raises any. */
  dustFactor: number;
  /** Ground mist particle density, 0..1. */
  mist: number;
  /** Rain particles per second across the camera volume. */
  rainRate: number;
}

export const WEATHER: Record<WeatherKind, WeatherPreset> = {
  clear: {
    // A dry late-summer afternoon on the Campus Martius. Deliberately a crosswind to
    // the north-south axis of the battle: dust and banners both read best when the
    // wind cuts across the line of advance rather than running along it.
    windSpeed: 4.2, windBearing: Math.PI * 0.44, gustiness: 0.6,
    dustFactor: 1, mist: 0.1, rainRate: 0,
  },
  overcast: {
    windSpeed: 6.2, windBearing: Math.PI * 0.48, gustiness: 0.9,
    dustFactor: 0.72, mist: 0.45, rainRate: 0,
  },
  rain: {
    windSpeed: 7.8, windBearing: Math.PI * 0.52, gustiness: 1.05,
    dustFactor: 0.16, mist: 0.8, rainRate: 2600,
  },
};

export class Weather {
  kind: WeatherKind = 'clear';
  preset: WeatherPreset = WEATHER.clear;

  /** Instantaneous wind, including gusts. Metres per second, world space. */
  readonly wind = new THREE.Vector3();
  /** Steady component only — useful for anything that should not jitter. */
  readonly windSteady = new THREE.Vector3();
  /** 0..1 gust envelope; cloth and grass can use it directly. */
  gust = 0;

  private t = 0;
  private rainCarry = 0;
  private mistCarry = 0;

  set(kind: WeatherKind): void {
    this.kind = kind;
    this.preset = WEATHER[kind];
  }

  update(dt: number): void {
    this.t += dt;
    const p = this.preset;

    // Direction wanders a few degrees; a perfectly fixed wind reads as a fan.
    const wander = Math.sin(this.t * 0.037) * 0.22 + Math.sin(this.t * 0.011) * 0.14;
    const bearing = p.windBearing + wander * p.gustiness;

    // Two gust oscillators an octave-and-a-bit apart never repeat audibly.
    const g = 0.5 + 0.32 * Math.sin(this.t * 0.63) + 0.18 * Math.sin(this.t * 0.271 + 1.7);
    this.gust = clamp01(g);
    const speed = p.windSpeed * (0.62 + 0.78 * this.gust * p.gustiness);

    this.windSteady.set(Math.sin(p.windBearing) * p.windSpeed, 0, Math.cos(p.windBearing) * p.windSpeed);
    this.wind.set(Math.sin(bearing) * speed, Math.sin(this.t * 0.9) * 0.35, Math.cos(bearing) * speed);
  }

  /**
   * Spawn rain and ground mist around the camera. Both ride the shared particle
   * layers, so weather costs no extra draw calls.
   */
  emit(
    ps: ParticleSystem,
    dt: number,
    camX: number,
    camY: number,
    camZ: number,
    groundAt: (x: number, z: number) => number
  ): void {
    const p = this.preset;
    let salt = (this.t * 977) | 0;

    if (p.rainRate > 0) {
      this.rainCarry += p.rainRate * dt;
      const n = Math.min(420, this.rainCarry | 0);
      this.rainCarry -= n;
      // A slab above and around the camera; streaks fall through the visible volume.
      for (let k = 0; k < n; k++) {
        salt++;
        const a = hash2(k, salt, 1) * Math.PI * 2;
        const r = Math.sqrt(hash2(k, salt, 2)) * 46;
        const x = camX + Math.cos(a) * r;
        const z = camZ + Math.sin(a) * r;
        const y = camY + 6 + hash2(k, salt, 3) * 26;
        const rec = ps.reset(PLayer.Soft, PT.rainStreak);
        rec.ground = PGround.Free;
        rec.x = x; rec.y = y; rec.z = z;
        rec.vx = this.wind.x * 0.5;
        rec.vy = -16 - hash2(k, salt, 4) * 5;
        rec.vz = this.wind.z * 0.5;
        rec.life = 0.9 + hash2(k, salt, 5) * 0.4;
        rec.size0 = 0.5 + hash2(k, salt, 6) * 0.4;
        rec.size1 = rec.size0;
        rec.spin = 0;
        rec.r = 0.66; rec.g = 0.72; rec.b = 0.80;
        rec.a = 0.24;
        rec.gravity = 3;
        rec.drag = 0.1;
        rec.windFactor = 0.35;
        ps.push();
      }
    }

    if (p.mist > 0.02) {
      this.mistCarry += p.mist * 26 * dt;
      const n = Math.min(24, this.mistCarry | 0);
      this.mistCarry -= n;
      for (let k = 0; k < n; k++) {
        salt++;
        const a = hash2(k, salt, 11) * Math.PI * 2;
        const r = 24 + Math.sqrt(hash2(k, salt, 12)) * 150;
        const x = camX + Math.cos(a) * r;
        const z = camZ + Math.sin(a) * r;
        const rec = ps.reset(PLayer.Soft, PT.smokeSoft);
        rec.x = x;
        rec.y = groundAt(x, z) + 0.6 + hash2(k, salt, 13) * 1.8;
        rec.z = z;
        rec.vx = this.wind.x * 0.3;
        rec.vy = 0.05;
        rec.vz = this.wind.z * 0.3;
        rec.life = 14 + hash2(k, salt, 14) * 10;
        rec.size0 = 9 + hash2(k, salt, 15) * 10;
        rec.size1 = rec.size0 * 2.1;
        rec.spin = (hash2(k, salt, 16) - 0.5) * 0.06;
        rec.r = 0.72; rec.g = 0.76; rec.b = 0.80;
        rec.a = 0.05 * p.mist;
        rec.gravity = -0.04;
        rec.drag = 0.3;
        rec.turb = 0.6;
        rec.windFactor = 1;
        ps.push();
      }
    }
  }
}
