/**
 * Deterministic pseudo-random number generation.
 *
 * Every stochastic decision in the simulation — unit jitter, damage rolls, morale
 * wobble, vegetation scatter — draws from a seeded stream so that a battle replays
 * identically given the same seed. `Math.random()` must never be used in sim code.
 */

/** Mulberry32: small, fast, good enough distribution for gameplay. */
export class Rng {
  private s: number;

  constructor(seed: number | string = 0xc0ffee) {
    this.s = typeof seed === 'string' ? Rng.hashString(seed) : seed >>> 0;
    if (this.s === 0) this.s = 0x9e3779b9;
  }

  static hashString(str: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return Math.floor(lo + this.next() * (hi - lo + 1));
  }

  /** Symmetric jitter in [-mag, mag). */
  jitter(mag = 1): number {
    return (this.next() * 2 - 1) * mag;
  }

  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }

  /** Approximately normal via sum of uniforms (Irwin–Hall, n=4). Mean 0, sd ~= 1. */
  normal(mean = 0, sd = 1): number {
    const u = this.next() + this.next() + this.next() + this.next() - 2;
    return mean + u * 0.8660254 * sd;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Weighted pick. `weights` need not be normalised. */
  pickWeighted<T>(arr: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (let i = 0; i < arr.length; i++) total += weights[i];
    let r = this.next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

  /** Fisher–Yates, in place. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Uniform point in the unit disc, written into `out`. */
  inDisc(out: { x: number; y: number }, radius = 1): void {
    const r = radius * Math.sqrt(this.next());
    const a = this.next() * Math.PI * 2;
    out.x = Math.cos(a) * r;
    out.y = Math.sin(a) * r;
  }

  /** Fork a child stream — lets a subsystem draw without perturbing the parent sequence. */
  fork(salt: number | string = 0): Rng {
    const s = typeof salt === 'string' ? Rng.hashString(salt) : salt;
    return new Rng((this.s ^ Math.imul(s + 1, 0x9e3779b9)) >>> 0);
  }

  /** Snapshot / restore for deterministic save-scumming and replays. */
  getState(): number {
    return this.s;
  }
  setState(s: number): void {
    this.s = s >>> 0;
  }
}

/**
 * Stable per-index hash in [0,1). Use for "random but fixed" per-instance detail
 * (soldier height variation, shield emblem pick) where you want the same value
 * every frame without storing it.
 */
export const hash01 = (i: number, salt = 0): number => {
  let h = (i ^ Math.imul(salt + 1, 0x27d4eb2d)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  h = Math.imul(h, 0x9e3779b1);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** 2D value hash in [0,1) — for terrain scatter and texture variation. */
export const hash2 = (x: number, y: number, salt = 0): number => {
  let h = (Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(salt, 0xcb1ab31f)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
};

/** The one global stream. Subsystems should `.fork()` a named child from it. */
export const world = new Rng('SPQR-271AD');
