/**
 * Procedural sound synthesis.
 *
 * There are no audio files in this project and none are coming, so every sound in the
 * game is arithmetic evaluated once at start-up: noise bursts through shaped envelopes,
 * banks of two-pole resonators standing in for the modes of a struck shield or helmet,
 * Karplus–Strong loops for bowstrings, glottal pulse trains through formant filters for
 * voices, and granular layering for anything that has to sound like a thousand men.
 *
 * Everything here is offline DSP over `Float32Array`. It runs once, during load, and the
 * results are cached as `AudioBuffer`s — nothing in this file is ever called from the
 * frame loop. All randomness comes from the seeded `Rng`, so a build sounds identical
 * every run and the offline level measurements in `selftest.ts` are reproducible.
 */

import { Rng } from '../util/rand';
import { TAU, clamp, clamp01, lerp } from '../util/math';

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

/** A mono or stereo block of float samples under construction. */
export interface Pcm {
  readonly sr: number;
  readonly ch: Float32Array[];
  readonly len: number;
}

export function makePcm(sr: number, seconds: number, channels = 1): Pcm {
  const len = Math.max(1, Math.round(sr * seconds));
  const ch: Float32Array[] = [];
  for (let c = 0; c < channels; c++) ch.push(new Float32Array(len));
  return { sr, ch, len };
}

/** Trim a Pcm to `len` samples, sharing the underlying storage. */
function trim(p: Pcm, len: number): Pcm {
  const n = clamp(Math.round(len), 1, p.len);
  return { sr: p.sr, len: n, ch: p.ch.map((c) => c.subarray(0, n)) };
}

// ---------------------------------------------------------------------------
// Noise sources
// ---------------------------------------------------------------------------

export function whiteNoise(out: Float32Array, rng: Rng, amp = 1): void {
  for (let i = 0; i < out.length; i++) out[i] = (rng.next() * 2 - 1) * amp;
}

/** Paul Kellet's economical pink filter — the standard cheap 1/f approximation. */
export function pinkNoise(out: Float32Array, rng: Rng, amp = 1): void {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.14 * amp;
    b6 = w * 0.115926;
  }
}

/** A short noise burst with a percussive envelope — the exciter for every impact. */
export function burst(n: number, sr: number, rng: Rng, decay: number, attack = 0.0003): Float32Array {
  const b = new Float32Array(n);
  whiteNoise(b, rng, 1);
  impactEnv(b, sr, attack, decay);
  return b;
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/**
 * Multiply in place by a percussive envelope: a linear rise over `attack` seconds then
 * an exponential fall reaching -60 dB after `decay` seconds. `shape` > 1 makes the tail
 * fall away faster than exponential, which reads as a drier, smaller object.
 */
export function impactEnv(buf: Float32Array, sr: number, attack: number, decay: number, shape = 1): void {
  const a = Math.max(1, Math.round(attack * sr));
  const g = Math.exp(-6.907755 / Math.max(1, decay * sr));
  let e = 0;
  for (let i = 0; i < buf.length; i++) {
    e = i < a ? i / a : e * g;
    buf[i] *= shape === 1 ? e : Math.pow(e, shape);
  }
}

/** Multiply in place by an arbitrary envelope evaluated on normalised time. */
export function shapeEnv(buf: Float32Array, fn: (t01: number) => number): void {
  const n = buf.length;
  for (let i = 0; i < n; i++) buf[i] *= fn(i / n);
}

export function fadeIn(buf: Float32Array, sr: number, seconds: number): void {
  const n = Math.min(buf.length, Math.max(1, Math.round(seconds * sr)));
  for (let i = 0; i < n; i++) buf[i] *= i / n;
}

export function fadeOut(buf: Float32Array, sr: number, seconds: number): void {
  const n = Math.min(buf.length, Math.max(1, Math.round(seconds * sr)));
  const start = buf.length - n;
  for (let i = 0; i < n; i++) buf[start + i] *= 1 - i / n;
}

// ---------------------------------------------------------------------------
// Biquads — Audio EQ Cookbook coefficients, direct form 1
// ---------------------------------------------------------------------------

export interface BiquadCoeffs {
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

const cook = (b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): BiquadCoeffs =>
  ({ b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 });

const omega = (f0: number, sr: number): number => (TAU * clamp(f0, 4, sr * 0.49)) / sr;

export function lowpassC(f0: number, q: number, sr: number): BiquadCoeffs {
  const w = omega(f0, sr), c = Math.cos(w), al = Math.sin(w) / (2 * Math.max(0.05, q));
  return cook((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
}

export function highpassC(f0: number, q: number, sr: number): BiquadCoeffs {
  const w = omega(f0, sr), c = Math.cos(w), al = Math.sin(w) / (2 * Math.max(0.05, q));
  return cook((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
}

export function bandpassC(f0: number, q: number, sr: number): BiquadCoeffs {
  const w = omega(f0, sr), c = Math.cos(w), s = Math.sin(w), al = s / (2 * Math.max(0.05, q));
  return cook(al, 0, -al, 1 + al, -2 * c, 1 - al);
}

export function peakingC(f0: number, q: number, dB: number, sr: number): BiquadCoeffs {
  const A = Math.pow(10, dB / 40);
  const w = omega(f0, sr), c = Math.cos(w), al = Math.sin(w) / (2 * Math.max(0.05, q));
  return cook(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
}

export function runBiquad(buf: Float32Array, c: BiquadCoeffs, passes = 1): void {
  for (let p = 0; p < passes; p++) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      buf[i] = y;
    }
  }
}

/** First-order highpass, used mostly to strip DC that resonators and pulse trains leave. */
export function dcBlock(buf: Float32Array, sr: number, f0 = 22): void {
  const a = Math.exp((-TAU * f0) / sr);
  let x1 = 0, y1 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = a * y1 + 0.5 * (1 + a) * (x - x1);
    x1 = x; y1 = y;
    buf[i] = y;
  }
}

// ---------------------------------------------------------------------------
// Time-varying filter — topology-preserving-transform state variable filter.
// Stable under fast modulation, which a cookbook biquad is not, so this is what
// every swept whoosh, scrape and arrow whistle runs through.
// ---------------------------------------------------------------------------

export type SvfMode = 'lp' | 'bp' | 'hp';

export function svfSweep(
  buf: Float32Array,
  sr: number,
  fAt: (t01: number) => number,
  q: number,
  mode: SvfMode = 'bp'
): void {
  const n = buf.length;
  const k = 1 / Math.max(0.05, q);
  let ic1 = 0, ic2 = 0;
  let a1 = 0, a2 = 0, a3 = 0;
  // Coefficients are refreshed every 16 samples rather than every sample. The cutoff
  // trajectories here are audio-rate at most in a whoosh and glacial in wind, so the
  // difference is inaudible, and `Math.tan` per sample was over a third of total build time.
  const STRIDE = 16;
  for (let i = 0; i < n; i++) {
    if ((i & (STRIDE - 1)) === 0) {
      const fc = clamp(fAt(i / n), 16, sr * 0.45);
      const g = Math.tan((Math.PI * fc) / sr);
      a1 = 1 / (1 + g * (g + k));
      a2 = g * a1;
      a3 = g * a2;
    }
    const x = buf[i];
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    buf[i] = mode === 'lp' ? v2 : mode === 'bp' ? v1 * k : x - k * v1 - v2;
  }
}

// ---------------------------------------------------------------------------
// Modal synthesis
// ---------------------------------------------------------------------------

/** One resonant mode of a struck object. `decay` is the time to fall 60 dB. */
export interface Mode {
  f: number;
  decay: number;
  amp: number;
}

/**
 * Sum a bank of two-pole resonators driven by `ex`, adding into `out`.
 *
 * This is the whole trick behind the metal in this game: a helmet, a shield boss or a
 * blade is a handful of lightly-damped inharmonic modes, and a 2 ms noise burst through
 * them is indistinguishable from having struck the thing. Inharmonic ratios (not integer
 * multiples) are what separate "metal" from "musical instrument".
 */
export function modalRing(
  out: Float32Array,
  ex: Float32Array,
  modes: readonly Mode[],
  sr: number,
  gain = 1
): void {
  const n = Math.min(out.length, ex.length);
  for (const m of modes) {
    const r = Math.exp(-6.907755 / Math.max(1, m.decay * sr));
    const w = omega(m.f, sr);
    const a1 = 2 * r * Math.cos(w);
    const a2 = -r * r;
    // (1-r) keeps peak amplitude roughly independent of decay time, so `amp` alone
    // controls the balance between a short knock and a long ring.
    const g = (1 - r) * m.amp * gain;
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const y = g * ex[i] + a1 * y1 + a2 * y2;
      y2 = y1; y1 = y;
      out[i] += y;
    }
  }
}

/** Inharmonic partial ratios typical of a struck iron shell (helmet, boss, mail mass). */
const IRON_RATIOS = [1, 2.41, 3.79, 5.18, 6.87, 8.94];

function ironModes(f0: number, decay: number, amp: number, spread: number, rng: Rng): Mode[] {
  return IRON_RATIOS.map((r, i) => ({
    f: f0 * r * (1 + rng.jitter(spread)),
    decay: decay * Math.pow(0.72, i),
    amp: amp * Math.pow(0.63, i),
  }));
}

// ---------------------------------------------------------------------------
// Karplus–Strong — bowstrings and spear shafts
// ---------------------------------------------------------------------------

export function karplus(
  out: Float32Array,
  sr: number,
  f0: number,
  decay: number,
  rng: Rng,
  damp = 0.4,
  amp = 1
): void {
  const N = Math.max(2, Math.round(sr / Math.max(20, f0)));
  const line = new Float32Array(N);
  for (let i = 0; i < N; i++) line[i] = rng.next() * 2 - 1;
  const loss = Math.exp(-6.907755 / Math.max(1, decay * sr));
  let idx = 0;
  let prev = 0;
  const d = clamp01(damp);
  for (let i = 0; i < out.length; i++) {
    const cur = line[idx];
    const y = ((1 - d) * cur + d * prev) * loss;
    prev = cur;
    line[idx] = y;
    out[i] += y * amp;
    idx = idx + 1 === N ? 0 : idx + 1;
  }
}

// ---------------------------------------------------------------------------
// Voice: glottal source + formant bank
// ---------------------------------------------------------------------------

export interface Formant {
  f: number;
  /** -3 dB bandwidth in Hz. Wider reads as more shouted and less sung. */
  bw: number;
  gain: number;
}

/**
 * Vowel formant sets for an adult male, from Peterson & Barney's classic measurements.
 * A shout pushes F1 up and widens every band, which is baked into the bandwidths here.
 */
export const VOWELS = {
  /** "ah" — the open vowel of a battle cry. */
  a: [{ f: 730, bw: 130, gain: 1 }, { f: 1090, bw: 150, gain: 0.62 }, { f: 2440, bw: 220, gain: 0.3 }, { f: 3400, bw: 320, gain: 0.14 }],
  /** "oh" — cupped, chest-heavy; the barritus vowel. */
  o: [{ f: 460, bw: 110, gain: 1 }, { f: 800, bw: 140, gain: 0.55 }, { f: 2600, bw: 260, gain: 0.16 }, { f: 3300, bw: 340, gain: 0.08 }],
  /** "eh" — brighter, cuts through a crowd. */
  e: [{ f: 530, bw: 120, gain: 1 }, { f: 1840, bw: 180, gain: 0.7 }, { f: 2480, bw: 240, gain: 0.35 }, { f: 3600, bw: 340, gain: 0.15 }],
  /** "aa" — strained, the vowel of a scream. */
  ae: [{ f: 660, bw: 160, gain: 1 }, { f: 1720, bw: 200, gain: 0.78 }, { f: 2410, bw: 260, gain: 0.4 }, { f: 3700, bw: 360, gain: 0.2 }],
} as const satisfies Record<string, readonly Formant[]>;

/**
 * Glottal flow source: one raised-cosine closing pulse per period, with period jitter
 * and amplitude shimmer. Differentiating afterwards gives the +6 dB/oct tilt of the
 * radiated flow derivative, which is what makes it read as a voice rather than a buzzer.
 */
export function glottal(
  out: Float32Array,
  sr: number,
  f0At: (t01: number) => number,
  rng: Rng,
  jitter = 0.025,
  shimmer = 0.14,
  openFrac = 0.36
): void {
  const n = out.length;
  let phase = 1;
  let period = sr / Math.max(40, f0At(0));
  let amp = 1;
  for (let i = 0; i < n; i++) {
    if (phase >= 1) {
      phase -= 1;
      const f0 = Math.max(40, f0At(i / n)) * (1 + rng.jitter(jitter));
      period = sr / f0;
      amp = 1 + rng.jitter(shimmer);
    }
    const p = phase / openFrac;
    out[i] += p < 1 ? amp * 0.5 * (1 - Math.cos(TAU * p)) * (1 - p * 0.35) : 0;
    phase += 1 / period;
  }
  // Flow derivative, then strip the residual DC step.
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const x = out[i];
    out[i] = x - prev * 0.92;
    prev = x;
  }
}

/** Parallel formant resonators. Writes into `out` (cleared first). */
export function formantFilter(
  out: Float32Array,
  src: Float32Array,
  formants: readonly Formant[],
  sr: number
): void {
  out.fill(0);
  const n = Math.min(out.length, src.length);
  for (const F of formants) {
    const r = Math.exp((-Math.PI * F.bw) / sr);
    const w = omega(F.f, sr);
    const a1 = 2 * r * Math.cos(w);
    const a2 = -r * r;
    const g = (1 - r) * F.gain;
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const y = g * src[i] + a1 * y1 + a2 * y2;
      y2 = y1; y1 = y;
      out[i] += y;
    }
  }
}

// ---------------------------------------------------------------------------
// Granular layering
// ---------------------------------------------------------------------------

/**
 * Add `src` into `dst` starting at `dstOffset`, resampled by `rate` (a pitch shift) with
 * linear interpolation. When `wrap` is set the grain folds around the end of `dst`, which
 * makes a granular bed loop seamlessly with no crossfade at all.
 */
export function addResampled(
  dst: Float32Array,
  src: Float32Array,
  dstOffset: number,
  rate: number,
  gain: number,
  wrap = false
): void {
  const N = dst.length;
  const M = src.length;
  let pos = 0;
  let i = Math.round(dstOffset);
  if (i < 0) {
    pos = -i * rate;
    i = 0;
  }
  while (pos + 1 < M) {
    const i0 = pos | 0;
    const fr = pos - i0;
    const s = (src[i0] + (src[i0 + 1] - src[i0]) * fr) * gain;
    if (i < N) dst[i] += s;
    else if (wrap) dst[i - N] += s;
    else break;
    i++;
    if (wrap && i >= N * 2) break;
    pos += rate;
  }
}

// ---------------------------------------------------------------------------
// Space: Schroeder reverberator and stereo decorrelation
// ---------------------------------------------------------------------------

const COMB_MS = [29.7, 37.1, 41.1, 43.7, 47.3, 53.9];
const ALLPASS_MS = [12.6, 10.0, 7.7];

/**
 * Four-to-six parallel feedback combs into a chain of allpasses. Crude next to a
 * convolution, but for a *baked* tail on a one-shot it is indistinguishable and free at
 * run time. Adds `wet * reverb(src)` into `out`.
 */
export function schroederTail(
  out: Float32Array,
  src: Float32Array,
  sr: number,
  decayS: number,
  wet: number,
  size = 1
): void {
  const n = Math.min(out.length, src.length);
  const acc = new Float32Array(n);
  for (const ms of COMB_MS) {
    const d = Math.max(2, Math.round((ms * size * sr) / 1000));
    const g = Math.pow(10, (-3 * (d / sr)) / Math.max(0.05, decayS));
    const line = new Float32Array(d);
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const y = line[idx];
      line[idx] = src[i] + y * g;
      idx = idx + 1 === d ? 0 : idx + 1;
      acc[i] += y;
    }
  }
  const scale = 1 / COMB_MS.length;
  for (let i = 0; i < n; i++) acc[i] *= scale;

  for (const ms of ALLPASS_MS) {
    const d = Math.max(2, Math.round((ms * size * sr) / 1000));
    const g = 0.62;
    const line = new Float32Array(d);
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const v = line[idx];
      const x = acc[i];
      const y = -g * x + v;
      line[idx] = x + g * y;
      idx = idx + 1 === d ? 0 : idx + 1;
      acc[i] = y;
    }
  }
  for (let i = 0; i < n; i++) out[i] += acc[i] * wet;
}

/**
 * Turn a mono source into a wide stereo pair using two different short comb delays.
 * Cheaper and more predictable than a real Haas treatment, and because the two channels
 * get different combs the pair survives a fold-down to mono without cancelling.
 */
export function spreadStereo(
  l: Float32Array,
  r: Float32Array,
  mono: Float32Array,
  sr: number,
  msL = 11,
  msR = 17,
  depth = 0.45
): void {
  const dL = Math.max(1, Math.round((msL * sr) / 1000));
  const dR = Math.max(1, Math.round((msR * sr) / 1000));
  const n = Math.min(l.length, r.length, mono.length);
  for (let i = 0; i < n; i++) {
    l[i] += mono[i] + (i >= dL ? mono[i - dL] * depth : 0);
    r[i] += mono[i] + (i >= dR ? mono[i - dR] * -depth : 0);
  }
}

// ---------------------------------------------------------------------------
// Shaping and measurement
// ---------------------------------------------------------------------------

/** tanh saturation, gain-compensated so `drive` adds density rather than loudness. */
export function softClip(buf: Float32Array, drive = 1.5): void {
  const k = Math.tanh(drive);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive) / k;
}

export function peakOf(chans: readonly Float32Array[]): number {
  let p = 0;
  for (const c of chans) for (let i = 0; i < c.length; i++) {
    const a = c[i] < 0 ? -c[i] : c[i];
    if (a > p) p = a;
  }
  return p;
}

export function rmsOf(chans: readonly Float32Array[]): number {
  let s = 0;
  let n = 0;
  for (const c of chans) {
    for (let i = 0; i < c.length; i++) s += c[i] * c[i];
    n += c.length;
  }
  return n ? Math.sqrt(s / n) : 0;
}

export function normalizePeak(chans: readonly Float32Array[], target: number): void {
  const p = peakOf(chans);
  if (p < 1e-9) return;
  const g = target / p;
  for (const c of chans) for (let i = 0; i < c.length; i++) c[i] *= g;
}

/**
 * Fold the tail of a buffer into its head so it loops without a click, returning the
 * shortened buffer. Used for continuous noise beds; granular beds use `addResampled`
 * with `wrap` instead, which is exact.
 */
export function makeSeamless(p: Pcm, xfadeS: number): Pcm {
  const x = clamp(Math.round(xfadeS * p.sr), 1, Math.floor(p.len / 3));
  const keep = p.len - x;
  for (const c of p.ch) {
    for (let i = 0; i < x; i++) {
      const w = i / x;
      c[i] = c[i] * w + c[keep + i] * (1 - w);
    }
  }
  return trim(p, keep);
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export interface Recipe {
  /**
   * Generation sample rate. Long beds render at 22.05 kHz — they are noise and voices
   * with little above 10 kHz, and it halves both build time and memory. `0` means
   * "match the audio context", which convolution impulse responses require.
   */
  rate: number;
  /** Peak-normalise the result to this amplitude; 0 leaves levels as synthesised. */
  peak: number;
  /** True for beds that the mixer plays with `loop = true`. */
  loop?: boolean;
  make(sr: number, rng: Rng): Pcm;
}

const RECIPES: Record<string, Recipe> = {};

function def(id: string, r: Recipe): void {
  RECIPES[id] = r;
}

/** Register `count` numbered variants of one sound so no two blows sound identical. */
function family(
  base: string,
  count: number,
  rate: number,
  peak: number,
  make: (sr: number, rng: Rng, k: number, of: number) => Pcm
): void {
  for (let k = 0; k < count; k++) {
    RECIPES[`${base}_${k}`] = { rate, peak, make: (sr, rng) => make(sr, rng, k, count) };
  }
}

/** Number of registered variants for a family base name. */
const FAMILY_SIZE: Record<string, number> = {};
function familySizes(): void {
  for (const id of Object.keys(RECIPES)) {
    const m = id.match(/^(.*)_(\d+)$/);
    if (!m) continue;
    FAMILY_SIZE[m[1]] = Math.max(FAMILY_SIZE[m[1]] ?? 0, Number(m[2]) + 1);
  }
}

/** Pick a variant id from a family using a 0..1 selector (a soldier's `variant`, say). */
export function variantId(base: string, t01: number): string {
  const n = FAMILY_SIZE[base] ?? 0;
  if (n <= 0) return base;
  const k = clamp(Math.floor(clamp01(t01) * n), 0, n - 1);
  return `${base}_${k}`;
}

// ---- Melee impacts --------------------------------------------------------

/**
 * Sword on shield. A late-Roman shield is glued limewood planks about 8 mm thick with a
 * rawhide rim and an iron boss, so the sound is three things at once: the broadband
 * *crack* of the blade biting the face, the low plate modes of a 0.9 m board, and — when
 * the blade catches the umbo — a bright iron ring.
 */
family('hit_shield', 3, 44100, 0.95, (sr, rng, k) => {
  const p = makePcm(sr, 0.44);
  const d = p.ch[0];
  const n = p.len;
  const v = (k - 1) * 0.5;

  const crack = burst(n, sr, rng, 0.018);
  runBiquad(crack, bandpassC(1450 * (1 + v * 0.22), 1.05, sr));
  runBiquad(crack, highpassC(300, 0.7, sr));
  for (let i = 0; i < n; i++) d[i] += crack[i] * 1.15;

  const board = burst(n, sr, rng, 0.005);
  modalRing(d, board, [
    { f: 118 * (1 + v * 0.12), decay: 0.17, amp: 1.0 },
    { f: 233 * (1 + v * 0.12), decay: 0.13, amp: 0.66 },
    { f: 417 * (1 + v * 0.14), decay: 0.095, amp: 0.46 },
    { f: 694 * (1 + v * 0.16), decay: 0.06, amp: 0.3 },
    { f: 1180 * (1 + v * 0.16), decay: 0.04, amp: 0.16 },
  ], sr, 0.95);

  const boss = burst(n, sr, rng, 0.0025);
  modalRing(d, boss, ironModes(2540 * (1 + v * 0.14), 0.13, 0.34, 0.03, rng), sr);

  // The arm behind the shield takes the blow: a soft low thump under everything.
  const body = burst(n, sr, rng, 0.03);
  runBiquad(body, lowpassC(150, 0.9, sr), 2);
  for (let i = 0; i < n; i++) d[i] += body[i] * 1.6;

  dcBlock(d, sr);
  softClip(d, 1.35);
  return p;
});

/**
 * Sword on armour. Ring mail over a padded subarmalis and an iron helmet: a bright clang
 * with a genuinely long modal tail, plus the dense rustle of thousands of rings moving.
 */
family('hit_armour', 3, 44100, 0.95, (sr, rng, k) => {
  const p = makePcm(sr, 0.62);
  const d = p.ch[0];
  const n = p.len;
  const v = (k - 1) * 0.5;

  const strike = burst(n, sr, rng, 0.0022);
  modalRing(d, strike, ironModes(880 * (1 + v * 0.18), 0.42, 1.0, 0.04, rng), sr);
  modalRing(d, strike, ironModes(1970 * (1 + v * 0.2), 0.24, 0.4, 0.05, rng), sr);

  const edge = burst(n, sr, rng, 0.008);
  runBiquad(edge, bandpassC(4200 * (1 + v * 0.15), 0.8, sr));
  for (let i = 0; i < n; i++) d[i] += edge[i] * 0.75;

  // Mail rustle: dense high-band noise decaying over ~120 ms as the rings settle.
  const rings = burst(n, sr, rng, 0.11, 0.001);
  runBiquad(rings, bandpassC(6200, 0.55, sr));
  for (let i = 0; i < n; i++) d[i] += rings[i] * 0.35;

  const thud = burst(n, sr, rng, 0.035);
  runBiquad(thud, lowpassC(190, 0.9, sr), 2);
  for (let i = 0; i < n; i++) d[i] += thud[i] * 1.2;

  dcBlock(d, sr);
  softClip(d, 1.5);
  return p;
});

/**
 * Blade in flesh. Almost no high frequency survives: a low body thump, a band of dull
 * lowpassed noise, and a short wet transient around 1.2 kHz. Deliberately restrained —
 * an over-designed gore sound is the fastest way to make a battle sound comic.
 */
family('hit_flesh', 3, 44100, 0.9, (sr, rng, k) => {
  const p = makePcm(sr, 0.34);
  const d = p.ch[0];
  const n = p.len;
  const v = (k - 1) * 0.5;

  const thud = burst(n, sr, rng, 0.055, 0.0008);
  runBiquad(thud, lowpassC(280 * (1 + v * 0.2), 0.8, sr), 2);
  for (let i = 0; i < n; i++) d[i] += thud[i] * 1.4;

  // Body resonance of a torso struck hard — one heavily damped low mode.
  const bodyEx = burst(n, sr, rng, 0.004);
  modalRing(d, bodyEx, [
    { f: 74 * (1 + v * 0.16), decay: 0.1, amp: 1.0 },
    { f: 138 * (1 + v * 0.16), decay: 0.07, amp: 0.5 },
  ], sr, 1.5);

  const wet = burst(n, sr, rng, 0.016);
  runBiquad(wet, bandpassC(1250 * (1 + v * 0.25), 1.6, sr));
  for (let i = 0; i < n; i++) d[i] += wet[i] * 0.42;

  dcBlock(d, sr);
  softClip(d, 1.2);
  return p;
});

/**
 * Parry. Two blades in contact and sliding: a metallic two-tone with the pitch of each
 * tone gliding as the contact point travels up the edge, plus swept bandpass scrape noise.
 */
family('parry', 2, 44100, 0.9, (sr, rng, k) => {
  const p = makePcm(sr, 0.4);
  const d = p.ch[0];
  const n = p.len;
  const dir = k === 0 ? 1 : -1;

  const scrape = new Float32Array(n);
  whiteNoise(scrape, rng, 1);
  shapeEnv(scrape, (t) => Math.pow(1 - t, 1.6) * Math.min(1, t * 45));
  svfSweep(scrape, sr, (t) => lerp(2600, 6200, dir > 0 ? t : 1 - t), 3.2, 'bp');
  for (let i = 0; i < n; i++) d[i] += scrape[i] * 1.1;

  // Two ringing tones a tritone apart — the interval reads as "wrong metal on metal".
  const ex = burst(n, sr, rng, 0.003);
  modalRing(d, ex, [
    { f: 1480, decay: 0.2, amp: 0.8 },
    { f: 2090, decay: 0.16, amp: 0.6 },
    { f: 3260, decay: 0.11, amp: 0.34 },
    { f: 4980, decay: 0.07, amp: 0.18 },
  ], sr);

  dcBlock(d, sr);
  softClip(d, 1.3);
  return p;
});

/** A blade cutting air and finding nothing — swept bandpass noise, no transient at all. */
family('swing_miss', 2, 44100, 0.7, (sr, rng, k) => {
  const p = makePcm(sr, 0.26);
  const d = p.ch[0];
  const n = p.len;
  whiteNoise(d, rng, 1);
  // Doppler of the blade tip passing the ear: rise then fall, peaking at mid-swing.
  svfSweep(d, sr, (t) => 700 + 2300 * Math.sin(Math.PI * t) * (k === 0 ? 1 : 0.8), 1.5, 'bp');
  shapeEnv(d, (t) => Math.pow(Math.sin(Math.PI * clamp01(t)), 2.2));
  dcBlock(d, sr, 120);
  return p;
});

/** Shield boss driven into a man — mostly board and body, very little edge. */
def('shield_bash', {
  rate: 44100, peak: 0.95,
  make(sr, rng) {
    const p = makePcm(sr, 0.5);
    const d = p.ch[0];
    const n = p.len;
    const hit = burst(n, sr, rng, 0.03, 0.0006);
    runBiquad(hit, lowpassC(520, 0.8, sr), 2);
    for (let i = 0; i < n; i++) d[i] += hit[i] * 1.5;
    const ex = burst(n, sr, rng, 0.004);
    modalRing(d, ex, [
      { f: 96, decay: 0.26, amp: 1.2 },
      { f: 188, decay: 0.18, amp: 0.7 },
      { f: 372, decay: 0.11, amp: 0.4 },
    ], sr, 1.2);
    modalRing(d, ex, ironModes(2100, 0.1, 0.16, 0.03, rng), sr);
    dcBlock(d, sr);
    softClip(d, 1.4);
    return p;
  },
});

// ---- The money sound: two shield walls meeting ----------------------------

/**
 * `linesClashed`. Everything at once, and the one sound the whole game is judged on:
 *
 *   1. a *massed* wooden crack — sixty board impacts inside 110 ms, pitch-spread, which
 *      is what makes it read as hundreds of shields rather than one big object;
 *   2. a sub-bass impact with a falling pitch, the momentum of two formations stopping;
 *   3. a metal wash of mail, helmets and blade edges;
 *   4. a two-second reverberant tail with a crowd shout folded into it, because on open
 *      ground the crash itself is dry and it is the roar behind it that gives it scale.
 */
def('clash_shieldwall', {
  rate: 44100, peak: 0.99,
  make(sr, rng) {
    const p = makePcm(sr, 2.7, 2);
    const n = p.len;
    const mono = new Float32Array(n);

    // 1. Massed board impacts.
    const grain = makePcm(sr, 0.3).ch[0];
    {
      const g = burst(grain.length, sr, rng, 0.014);
      runBiquad(g, bandpassC(1300, 1.0, sr));
      for (let i = 0; i < grain.length; i++) grain[i] = g[i];
      const boardEx = burst(grain.length, sr, rng, 0.005);
      modalRing(grain, boardEx, [
        { f: 124, decay: 0.16, amp: 1.0 },
        { f: 246, decay: 0.12, amp: 0.6 },
        { f: 440, decay: 0.08, amp: 0.36 },
      ], sr, 0.9);
    }
    const L = p.ch[0];
    const R = p.ch[1];
    for (let i = 0; i < 64; i++) {
      // Front ranks meet first and the collision runs back through the ranks, so the
      // grain density is front-loaded with a tail of stragglers.
      const t = Math.pow(rng.next(), 0.55) * 0.19;
      const rate = Math.pow(2, rng.jitter(0.42));
      const gain = rng.range(0.24, 0.62) * (1 - t * 2.2);
      const pan = rng.jitter(0.85);
      addResampled(L, grain, t * sr, rate, gain * (0.5 - pan * 0.5 + 0.5));
      addResampled(R, grain, t * sr, rate, gain * (0.5 + pan * 0.5 + 0.5) * 0.98);
    }

    // 2. Sub impact: two masses stopping. Falling pitch sells the weight.
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const f = 78 * Math.exp(-t * 3.1) + 34;
      const e = Math.exp(-t * 5.2) * Math.min(1, t * 900);
      mono[i] += Math.sin(TAU * f * t) * e * 1.5;
    }

    // 3. Metal wash.
    const wash = new Float32Array(n);
    whiteNoise(wash, rng, 1);
    svfSweep(wash, sr, (t) => 3800 * Math.exp(-t * 3.4) + 420, 0.8, 'bp');
    shapeEnv(wash, (t) => Math.exp(-t * 7.5) * Math.min(1, t * 260));
    for (let i = 0; i < n; i++) mono[i] += wash[i] * 1.3;

    // 4. Shout folded into the tail.
    const shout = new Float32Array(n);
    {
      const src = new Float32Array(Math.round(sr * 0.9));
      glottal(src, sr, (t) => lerp(150, 118, t), rng, 0.05, 0.2);
      const vo = new Float32Array(src.length);
      formantFilter(vo, src, VOWELS.a, sr);
      for (let v = 0; v < 26; v++) {
        addResampled(shout, vo, rng.range(0.0, 0.45) * sr, Math.pow(2, rng.jitter(0.3)), rng.range(0.12, 0.3));
      }
      shapeEnv(shout, (t) => Math.min(1, t * 12) * Math.exp(-t * 2.2));
      runBiquad(shout, lowpassC(3400, 0.7, sr));
    }
    for (let i = 0; i < n; i++) mono[i] += shout[i] * 0.9;

    softClip(mono, 1.9);
    schroederTail(mono, mono, sr, 1.9, 0.42, 1.25);
    dcBlock(mono, sr);
    spreadStereo(L, R, mono, sr, 13, 21, 0.4);
    fadeOut(L, sr, 0.35);
    fadeOut(R, sr, 0.35);
    return p;
  },
});

/**
 * A cavalry charge landing. Roughly a second of hooves closing and accelerating, then the
 * crunch: horse chest into shield, timber breaking, a low body impact. Ammianus is clear
 * that what broke infantry was the *noise* of it arriving, so the build matters as much
 * as the hit.
 */
def('cavalry_impact', {
  rate: 44100, peak: 0.99,
  make(sr, rng) {
    const p = makePcm(sr, 2.4, 2);
    const n = p.len;
    const L = p.ch[0];
    const R = p.ch[1];
    const mono = new Float32Array(n);

    // Hoof grain, reused for the whole build-up.
    const hoof = new Float32Array(Math.round(sr * 0.2));
    {
      const h = burst(hoof.length, sr, rng, 0.02, 0.0004);
      runBiquad(h, bandpassC(430, 1.1, sr));
      for (let i = 0; i < hoof.length; i++) hoof[i] = h[i] * 1.2;
      const ex = burst(hoof.length, sr, rng, 0.004);
      modalRing(hoof, ex, [
        { f: 88, decay: 0.09, amp: 1.0 },
        { f: 205, decay: 0.06, amp: 0.5 },
      ], sr, 1.3);
    }

    // Gallop pattern accelerating from 2.6 to 4.2 beats/second over the approach.
    const IMPACT = 1.05;
    let t = 0;
    while (t < IMPACT) {
      const remain = 1 - t / IMPACT;
      const bps = lerp(4.4, 2.6, remain);
      // Four-beat gallop: three quick, one gap. Uneven spacing is the whole character.
      const pattern = [0, 0.16, 0.3, 0.52];
      for (const off of pattern) {
        const tt = t + off / bps;
        if (tt > IMPACT) break;
        const gain = lerp(0.06, 0.5, 1 - remain) * rng.range(0.7, 1.1);
        // Many horses, so each "beat" is a smear of eight hooves.
        for (let h = 0; h < 8; h++) {
          const pan = rng.jitter(0.8);
          const gg = gain * rng.range(0.4, 1) * 0.32;
          const at = (tt + rng.jitter(0.035)) * sr;
          addResampled(L, hoof, at, Math.pow(2, rng.jitter(0.22)), gg * (1 - pan * 0.5));
          addResampled(R, hoof, at, Math.pow(2, rng.jitter(0.22)), gg * (1 + pan * 0.5));
        }
      }
      t += 1 / bps;
    }

    // The crunch.
    const i0 = Math.round(IMPACT * sr);
    for (let i = i0; i < n; i++) {
      const tt = (i - i0) / sr;
      const f = 62 * Math.exp(-tt * 2.6) + 28;
      mono[i] += Math.sin(TAU * f * tt) * Math.exp(-tt * 4.0) * Math.min(1, tt * 700) * 2.0;
    }
    const crunch = new Float32Array(n - i0);
    whiteNoise(crunch, rng, 1);
    // Splintering timber: a scatter of short crackles, not a single burst.
    shapeEnv(crunch, (t01) => {
      const e = Math.exp(-t01 * 12);
      return e * (0.35 + 0.65 * (Math.sin(t01 * 940) > 0.2 ? 1 : 0.15));
    });
    svfSweep(crunch, sr, (t01) => 2400 * Math.exp(-t01 * 5) + 300, 1.1, 'bp');
    for (let i = 0; i < crunch.length; i++) mono[i0 + i] += crunch[i] * 1.5;

    const flesh = burst(n - i0, sr, rng, 0.08, 0.001);
    runBiquad(flesh, lowpassC(320, 0.8, sr), 2);
    for (let i = 0; i < flesh.length; i++) mono[i0 + i] += flesh[i] * 1.1;

    softClip(mono, 1.7);
    schroederTail(mono, mono, sr, 1.4, 0.3, 1.1);
    dcBlock(mono, sr);
    for (let i = 0; i < n; i++) {
      L[i] += mono[i];
      R[i] += mono[i] * 0.97;
    }
    fadeOut(L, sr, 0.3);
    fadeOut(R, sr, 0.3);
    return p;
  },
});

// ---- Missiles -------------------------------------------------------------

/** Composite bow release: string snap, limb thump, and the arrow leaving the rest. */
family('bow_release', 2, 44100, 0.85, (sr, rng, k) => {
  const p = makePcm(sr, 0.3);
  const d = p.ch[0];
  const n = p.len;
  // Sinew string under 40 kg of draw: very short, very damped.
  karplus(d, sr, 172 * (1 + k * 0.12), 0.055, rng, 0.55, 1.0);
  const limb = burst(n, sr, rng, 0.03);
  runBiquad(limb, bandpassC(240, 0.9, sr));
  for (let i = 0; i < n; i++) d[i] += limb[i] * 1.1;
  const thwip = new Float32Array(n);
  whiteNoise(thwip, rng, 1);
  shapeEnv(thwip, (t) => Math.exp(-t * 26) * Math.min(1, t * 400));
  svfSweep(thwip, sr, (t) => lerp(1800, 5200, t), 1.4, 'bp');
  for (let i = 0; i < n; i++) d[i] += thwip[i] * 0.7;
  dcBlock(d, sr);
  return p;
});

/** Pilum throw: a heavy shaft leaving the hand — leather, wood, and a lot of air. */
family('pilum_throw', 2, 44100, 0.8, (sr, rng, k) => {
  const p = makePcm(sr, 0.36);
  const d = p.ch[0];
  const n = p.len;
  whiteNoise(d, rng, 1);
  svfSweep(d, sr, (t) => lerp(320, 1500 + k * 300, Math.sin(Math.PI * t * 0.7)), 1.1, 'bp');
  shapeEnv(d, (t) => Math.pow(Math.sin(Math.PI * clamp01(t * 0.9)), 1.8));
  const wood = burst(n, sr, rng, 0.012);
  modalRing(d, wood, [
    { f: 320, decay: 0.05, amp: 0.5 },
    { f: 740, decay: 0.03, amp: 0.3 },
  ], sr);
  dcBlock(d, sr, 90);
  return p;
});

def('sling_release', {
  rate: 44100, peak: 0.8,
  make(sr, rng) {
    const p = makePcm(sr, 0.34);
    const d = p.ch[0];
    whiteNoise(d, rng, 1);
    // The sling is whirled, so the pitch rises then cuts off at release.
    svfSweep(d, sr, (t) => (t < 0.75 ? lerp(600, 2600, t / 0.75) : 3200), 2.4, 'bp');
    shapeEnv(d, (t) => (t < 0.75 ? Math.pow(t / 0.75, 1.4) * 0.7 : Math.exp(-(t - 0.75) * 40)));
    dcBlock(d, sr, 120);
    return p;
  },
});

/** Scorpio release: torsion springs letting go and a slider slamming its stop. */
def('bolt_release', {
  rate: 44100, peak: 0.95,
  make(sr, rng) {
    const p = makePcm(sr, 0.5);
    const d = p.ch[0];
    const n = p.len;
    const ex = burst(n, sr, rng, 0.006);
    modalRing(d, ex, [
      { f: 150, decay: 0.14, amp: 1.2 },
      { f: 297, decay: 0.1, amp: 0.7 },
      { f: 620, decay: 0.07, amp: 0.4 },
    ], sr, 1.2);
    modalRing(d, ex, ironModes(1450, 0.16, 0.3, 0.04, rng), sr);
    const snap = burst(n, sr, rng, 0.02);
    runBiquad(snap, bandpassC(900, 0.8, sr));
    for (let i = 0; i < n; i++) d[i] += snap[i] * 1.3;
    dcBlock(d, sr);
    softClip(d, 1.4);
    return p;
  },
});

/** Loopable arrow-in-flight whistle. Played with `playbackRate` for Doppler. */
def('arrow_flight', {
  rate: 22050, peak: 0.5, loop: true,
  make(sr, rng) {
    const p = makePcm(sr, 1.0);
    const d = p.ch[0];
    whiteNoise(d, rng, 1);
    // Fletching turning in the airstream gives a slow warble around 1.6 kHz.
    svfSweep(d, sr, (t) => 1600 * (1 + 0.22 * Math.sin(TAU * t * 6)), 5.5, 'bp');
    runBiquad(d, highpassC(700, 0.7, sr));
    return makeSeamless(p, 0.05);
  },
});

function impactRecipe(
  id: string,
  build: (sr: number, rng: Rng, d: Float32Array, n: number) => void,
  seconds = 0.36
): void {
  def(id, {
    rate: 44100, peak: 0.9,
    make(sr, rng) {
      const p = makePcm(sr, seconds);
      build(sr, rng, p.ch[0], p.len);
      dcBlock(p.ch[0], sr);
      softClip(p.ch[0], 1.3);
      return p;
    },
  });
}

/** Arrow into earth: a dull dirt thud and the shaft twanging as it stops. */
impactRecipe('impact_ground', (sr, rng, d, n) => {
  const soil = burst(n, sr, rng, 0.04, 0.0006);
  runBiquad(soil, lowpassC(420, 0.7, sr), 2);
  for (let i = 0; i < n; i++) d[i] += soil[i] * 1.4;
  karplus(d, sr, 420, 0.12, rng, 0.62, 0.35);
});

/** Arrow into a shield: a hard *thock* through 8 mm of limewood, then shaft twang. */
impactRecipe('impact_shield', (sr, rng, d, n) => {
  const punch = burst(n, sr, rng, 0.012);
  runBiquad(punch, bandpassC(1050, 0.9, sr));
  for (let i = 0; i < n; i++) d[i] += punch[i] * 1.2;
  const ex = burst(n, sr, rng, 0.004);
  modalRing(d, ex, [
    { f: 132, decay: 0.14, amp: 1.0 },
    { f: 268, decay: 0.1, amp: 0.55 },
    { f: 505, decay: 0.07, amp: 0.3 },
  ], sr, 1.1);
  karplus(d, sr, 390, 0.16, rng, 0.55, 0.4);
});

impactRecipe('impact_flesh', (sr, rng, d, n) => {
  const thud = burst(n, sr, rng, 0.045, 0.0008);
  runBiquad(thud, lowpassC(260, 0.8, sr), 2);
  for (let i = 0; i < n; i++) d[i] += thud[i] * 1.5;
  const wet = burst(n, sr, rng, 0.012);
  runBiquad(wet, bandpassC(1400, 1.8, sr));
  for (let i = 0; i < n; i++) d[i] += wet[i] * 0.4;
  karplus(d, sr, 360, 0.09, rng, 0.7, 0.22);
});

/** Arrow off mail or a helmet: mostly a ricochet, which is why armour worked. */
impactRecipe('impact_armour', (sr, rng, d, n) => {
  const ex = burst(n, sr, rng, 0.0018);
  modalRing(d, ex, ironModes(1250, 0.3, 1.0, 0.05, rng), sr);
  const skid = new Float32Array(n);
  whiteNoise(skid, rng, 1);
  shapeEnv(skid, (t) => Math.exp(-t * 22) * Math.min(1, t * 500));
  svfSweep(skid, sr, (t) => lerp(5200, 2200, t), 2.2, 'bp');
  for (let i = 0; i < n; i++) d[i] += skid[i] * 0.8;
});

impactRecipe('impact_stone', (sr, rng, d, n) => {
  const ex = burst(n, sr, rng, 0.0015);
  modalRing(d, ex, [
    { f: 2100, decay: 0.05, amp: 1.0 },
    { f: 3450, decay: 0.035, amp: 0.6 },
    { f: 5900, decay: 0.02, amp: 0.3 },
  ], sr);
  const chip = burst(n, sr, rng, 0.008);
  runBiquad(chip, highpassC(2200, 0.7, sr));
  for (let i = 0; i < n; i++) d[i] += chip[i] * 1.0;
});

impactRecipe('impact_wood', (sr, rng, d, n) => {
  const knock = burst(n, sr, rng, 0.016);
  runBiquad(knock, bandpassC(760, 0.9, sr));
  for (let i = 0; i < n; i++) d[i] += knock[i] * 1.3;
  const ex = burst(n, sr, rng, 0.004);
  modalRing(d, ex, [
    { f: 196, decay: 0.13, amp: 1.0 },
    { f: 385, decay: 0.09, amp: 0.5 },
    { f: 830, decay: 0.05, amp: 0.28 },
  ], sr, 1.1);
});

/**
 * A volley. One man's release is a click; eighty men releasing inside 200 ms is a *wave*.
 * Built by scattering the single-shot grain with pitch and pan spread, then laying a
 * rising mass-whoosh over it as the flight noise of the whole flock builds.
 */
function volleyRecipe(id: string, grainId: string, opts: { spread: number; count: number; whoosh: number }): void {
  def(id, {
    rate: 22050, peak: 0.95,
    make(sr, rng) {
      const p = makePcm(sr, 1.4, 2);
      const L = p.ch[0];
      const R = p.ch[1];
      const grain = RECIPES[grainId].make(sr, rng.fork(grainId));
      normalizePeak(grain.ch, 0.9);
      for (let i = 0; i < opts.count; i++) {
        const t = Math.pow(rng.next(), 0.7) * opts.spread;
        const rate = Math.pow(2, rng.jitter(0.18));
        const g = rng.range(0.1, 0.3);
        const pan = rng.jitter(0.9);
        addResampled(L, grain.ch[0], t * sr, rate, g * (1 - pan * 0.55));
        addResampled(R, grain.ch[0], t * sr, rate, g * (1 + pan * 0.55));
      }
      // The flock's collective flight noise, arriving after the releases.
      const wh = new Float32Array(p.len);
      whiteNoise(wh, rng, 1);
      svfSweep(wh, sr, (t) => 900 + 1500 * Math.sin(Math.PI * clamp01(t * 1.5)), 1.2, 'bp');
      shapeEnv(wh, (t) => Math.pow(Math.sin(Math.PI * clamp01(t * 0.85)), 1.6));
      for (let i = 0; i < p.len; i++) {
        L[i] += wh[i] * opts.whoosh;
        R[i] += wh[i] * opts.whoosh * 0.94;
      }
      softClip(L, 1.4);
      softClip(R, 1.4);
      fadeOut(L, sr, 0.2);
      fadeOut(R, sr, 0.2);
      return p;
    },
  });
}

volleyRecipe('volley_arrow', 'bow_release_0', { spread: 0.26, count: 70, whoosh: 0.6 });
volleyRecipe('volley_pilum', 'pilum_throw_0', { spread: 0.34, count: 46, whoosh: 0.75 });
volleyRecipe('volley_javelin', 'pilum_throw_1', { spread: 0.4, count: 40, whoosh: 0.7 });
volleyRecipe('volley_sling', 'sling_release', { spread: 0.3, count: 34, whoosh: 0.5 });
volleyRecipe('volley_bolt', 'bolt_release', { spread: 0.5, count: 8, whoosh: 0.3 });

// ---- Movement -------------------------------------------------------------

/** A single hobnailed caliga landing on dry trampled earth. */
family('footfall', 4, 44100, 0.75, (sr, rng, k) => {
  const p = makePcm(sr, 0.22);
  const d = p.ch[0];
  const n = p.len;
  const v = k * 0.25;
  const soil = burst(n, sr, rng, 0.03 + v * 0.01, 0.0005);
  runBiquad(soil, lowpassC(520 * (1 + v * 0.3), 0.8, sr), 2);
  for (let i = 0; i < n; i++) d[i] += soil[i] * 1.3;
  // Iron hobnails on grit: a thin scatter of high clicks.
  const nails = burst(n, sr, rng, 0.014);
  runBiquad(nails, bandpassC(4600 * (1 + v * 0.2), 0.7, sr));
  for (let i = 0; i < n; i++) d[i] += nails[i] * 0.3;
  const ex = burst(n, sr, rng, 0.003);
  modalRing(d, ex, [{ f: 62, decay: 0.07, amp: 1.0 }], sr, 1.4);
  dcBlock(d, sr);
  return p;
});

/** Mail skirt, scabbard fittings and a canteen — the jingle of kit in motion. */
family('kit_jingle', 3, 44100, 0.55, (sr, rng, k) => {
  const p = makePcm(sr, 0.3);
  const d = p.ch[0];
  const n = p.len;
  const count = 9 + k * 3;
  for (let j = 0; j < count; j++) {
    const off = Math.round(rng.range(0, 0.09) * sr);
    const len = n - off;
    if (len < 32) continue;
    const ex = burst(len, sr, rng, 0.0012);
    const seg = new Float32Array(len);
    modalRing(seg, ex, [
      { f: rng.range(3200, 7800), decay: rng.range(0.02, 0.07), amp: 1 },
      { f: rng.range(5200, 11000), decay: rng.range(0.01, 0.04), amp: 0.5 },
    ], sr, rng.range(0.3, 1));
    for (let i = 0; i < len; i++) d[off + i] += seg[i];
  }
  shapeEnv(d, (t) => Math.exp(-t * 5));
  dcBlock(d, sr, 200);
  return p;
});

/**
 * A whole rank's boots landing together. A cohort marching is not a sequence of steps,
 * it is a *pulse*: twenty-odd men inside a 60 ms window, never quite in unison. Playing
 * this one buffer per step at the formation's real cadence is what turns eight hundred
 * men into a rhythm instead of eight hundred voices.
 */
family('march_mass', 3, 22050, 0.9, (sr, rng, k) => {
  const p = makePcm(sr, 0.5, 2);
  const L = p.ch[0];
  const R = p.ch[1];
  const grain = RECIPES[`footfall_${k}`].make(sr, rng.fork('mm'));
  normalizePeak(grain.ch, 0.8);
  const jingle = RECIPES[`kit_jingle_${k % 3}`].make(sr, rng.fork('mj'));
  normalizePeak(jingle.ch, 0.5);
  for (let i = 0; i < 22; i++) {
    // Discipline shows up as tightness: ±28 ms, not ±120 ms.
    const t = Math.abs(rng.normal(0, 0.022));
    const rate = Math.pow(2, rng.jitter(0.3));
    const g = rng.range(0.18, 0.42);
    const pan = rng.jitter(1);
    addResampled(L, grain.ch[0], t * sr, rate, g * (1 - pan * 0.5));
    addResampled(R, grain.ch[0], t * sr, rate, g * (1 + pan * 0.5));
  }
  for (let i = 0; i < 8; i++) {
    const t = rng.range(0, 0.09);
    const pan = rng.jitter(1);
    const g = rng.range(0.08, 0.2);
    addResampled(L, jingle.ch[0], t * sr, Math.pow(2, rng.jitter(0.3)), g * (1 - pan * 0.5));
    addResampled(R, jingle.ch[0], t * sr, Math.pow(2, rng.jitter(0.3)), g * (1 + pan * 0.5));
  }
  softClip(L, 1.2);
  softClip(R, 1.2);
  return p;
});

/** One unshod hoof on turf. Horseshoes are medieval; this is horn on soil. */
family('hoof', 4, 44100, 0.8, (sr, rng, k) => {
  const p = makePcm(sr, 0.26);
  const d = p.ch[0];
  const n = p.len;
  const v = k * 0.22;
  const strike = burst(n, sr, rng, 0.018, 0.0004);
  runBiquad(strike, bandpassC(440 * (1 + v * 0.25), 1.0, sr));
  for (let i = 0; i < n; i++) d[i] += strike[i] * 1.3;
  const ex = burst(n, sr, rng, 0.004);
  modalRing(d, ex, [
    { f: 84 * (1 + v * 0.15), decay: 0.1, amp: 1.2 },
    { f: 198 * (1 + v * 0.15), decay: 0.07, amp: 0.55 },
    { f: 1120 * (1 + v * 0.2), decay: 0.03, amp: 0.24 },
  ], sr, 1.3);
  const turf = burst(n, sr, rng, 0.05, 0.001);
  runBiquad(turf, bandpassC(1700, 0.6, sr));
  for (let i = 0; i < n; i++) d[i] += turf[i] * 0.32;
  dcBlock(d, sr);
  return p;
});

/** Whinny: a hard glottal source with a steep falling contour and heavy vibrato. */
family('horse_whinny', 2, 22050, 0.85, (sr, rng, k) => {
  const p = makePcm(sr, 1.4);
  const d = p.ch[0];
  const n = p.len;
  const src = new Float32Array(n);
  const top = 400 + k * 70;
  glottal(src, sr, (t) => {
    // Squeal up, then a broken descending series of pulses.
    const rise = t < 0.14 ? lerp(180, top, t / 0.14) : top * Math.exp(-(t - 0.14) * 1.5);
    return rise * (1 + 0.09 * Math.sin(TAU * t * (14 + k * 4)));
  }, rng, 0.05, 0.28, 0.3);
  const vo = new Float32Array(n);
  formantFilter(vo, src, [
    { f: 620, bw: 150, gain: 1 },
    { f: 1580, bw: 220, gain: 0.7 },
    { f: 2900, bw: 320, gain: 0.35 },
  ], sr);
  const breath = new Float32Array(n);
  whiteNoise(breath, rng, 1);
  svfSweep(breath, sr, (t) => lerp(1200, 500, t), 1.0, 'bp');
  for (let i = 0; i < n; i++) d[i] = vo[i] * 1.4 + breath[i] * 0.22;
  shapeEnv(d, (t) => Math.min(1, t * 24) * (t < 0.7 ? 1 : Math.exp(-(t - 0.7) * 9)));
  dcBlock(d, sr, 70);
  softClip(d, 1.5);
  return p;
});

/**
 * A loopable bed for a squadron of horse at distance — the aggregate of dozens of hooves
 * rather than any single one. This is what plays instead of forty discrete hoof voices.
 */
def('hooves_mass', {
  rate: 22050, peak: 0.85, loop: true,
  make(sr, rng) {
    const p = makePcm(sr, 3.0, 2);
    const L = p.ch[0];
    const R = p.ch[1];
    const grain = RECIPES.hoof_0.make(sr, rng.fork('hm'));
    normalizePeak(grain.ch, 0.8);
    // ~9 hoof strikes per second per horse at the trot; 14 horses.
    const total = Math.round(3.0 * 9 * 14 * 0.45);
    for (let i = 0; i < total; i++) {
      const t = rng.next() * 3.0;
      const rate = Math.pow(2, rng.jitter(0.35));
      const g = rng.range(0.05, 0.16);
      const pan = rng.jitter(1);
      addResampled(L, grain.ch[0], t * sr, rate, g * (1 - pan * 0.5), true);
      addResampled(R, grain.ch[0], t * sr, rate, g * (1 + pan * 0.5), true);
    }
    softClip(L, 1.3);
    softClip(R, 1.3);
    return p;
  },
});

// ---- Voices ---------------------------------------------------------------

/**
 * A death scream. Honestly the weakest thing synthesis does: a single human voice in
 * extremity has irregularities no formant model reproduces, so these lean on pitch
 * instability, a rasp layer and an early break into breath noise, and the mixer leans on
 * playing them rarely, quietly and behind the crowd bed.
 */
family('scream', 4, 22050, 0.9, (sr, rng, k) => {
  const p = makePcm(sr, 1.25);
  const d = p.ch[0];
  const n = p.len;
  const base = 190 + k * 34;
  const src = new Float32Array(n);
  glottal(src, sr, (t) => {
    const attack = Math.min(1, t / 0.06);
    const fall = t > 0.45 ? Math.exp(-(t - 0.45) * 1.9) : 1;
    return base * (0.72 + 0.4 * attack) * fall * (1 + 0.05 * Math.sin(TAU * t * 7.5));
  }, rng, 0.075, 0.3, 0.3);
  const vowel = k % 2 === 0 ? VOWELS.ae : VOWELS.a;
  const vo = new Float32Array(n);
  formantFilter(vo, src, vowel, sr);
  // Rasp: the voice tearing. A ring-modulated noise band, gated by the envelope.
  const rasp = new Float32Array(n);
  whiteNoise(rasp, rng, 1);
  runBiquad(rasp, bandpassC(1900 + k * 260, 0.9, sr));
  for (let i = 0; i < n; i++) rasp[i] *= 0.5 + 0.5 * Math.sin((TAU * base * i) / sr);
  for (let i = 0; i < n; i++) d[i] = vo[i] * 1.5 + rasp[i] * 0.3;
  // Breaks into breath at the end rather than fading — a scream stops when air stops.
  shapeEnv(d, (t) => Math.min(1, t * 22) * (t < 0.62 ? 1 : Math.pow(1 - (t - 0.62) / 0.38, 1.5)));
  const breath = new Float32Array(n);
  whiteNoise(breath, rng, 1);
  runBiquad(breath, bandpassC(900, 0.7, sr));
  shapeEnv(breath, (t) => (t > 0.55 ? Math.exp(-(t - 0.55) * 5) * 0.5 : 0.04));
  for (let i = 0; i < n; i++) d[i] += breath[i] * 0.5;
  dcBlock(d, sr, 80);
  softClip(d, 1.6);
  return p;
});

/** The far commoner death sound: a short grunt as the wind goes out of a man. */
family('death_grunt', 3, 22050, 0.8, (sr, rng, k) => {
  const p = makePcm(sr, 0.7);
  const d = p.ch[0];
  const n = p.len;
  const src = new Float32Array(n);
  glottal(src, sr, (t) => (128 + k * 18) * (1 - t * 0.4), rng, 0.06, 0.25, 0.42);
  const vo = new Float32Array(n);
  formantFilter(vo, src, k === 1 ? VOWELS.o : VOWELS.a, sr);
  const air = new Float32Array(n);
  whiteNoise(air, rng, 1);
  runBiquad(air, bandpassC(700, 0.6, sr));
  for (let i = 0; i < n; i++) d[i] = vo[i] * 1.3 + air[i] * 0.35;
  shapeEnv(d, (t) => Math.min(1, t * 30) * Math.exp(-t * 4.5));
  dcBlock(d, sr, 70);
  return p;
});

/**
 * Crowd vocalisation, the single most load-bearing sound in the game.
 *
 * One synthesised voice is unconvincing; sixty of them, pitch-spread over a male range,
 * scattered in time and panned wide, is a *crowd* — and a crowd is what a battle actually
 * sounds like. Grains wrap around the buffer end so the bed loops with no seam.
 */
function crowdRecipe(
  id: string,
  opts: {
    seconds: number;
    voices: number;
    f0: [number, number];
    vowels: readonly (readonly Formant[])[];
    /** Pitch contour applied to every grain: 1 = flat, >1 rising. */
    rise: number;
    noise: number;
    lp: number;
    hp: number;
    /** Grain length in seconds. Short = chanting, long = sustained roar. */
    grain: number;
  }
): void {
  def(id, {
    rate: 22050, peak: 0.9, loop: true,
    make(sr, rng) {
      const p = makePcm(sr, opts.seconds, 2);
      const L = p.ch[0];
      const R = p.ch[1];
      const gl = Math.round(opts.grain * sr);
      // A few distinct source voices; every grain is a resampled slice of one of them,
      // which is why sixty voices costs about as much as three.
      const sources: Float32Array[] = [];
      for (const vowel of opts.vowels) {
        const src = new Float32Array(gl);
        glottal(src, sr, (t) => lerp(opts.f0[0], opts.f0[0] * opts.rise, t), rng, 0.05, 0.22);
        const vo = new Float32Array(gl);
        formantFilter(vo, src, vowel, sr);
        shapeEnv(vo, (t) => Math.min(1, t * 8) * Math.min(1, (1 - t) * 6));
        sources.push(vo);
      }
      const spread = opts.f0[1] / opts.f0[0];
      for (let i = 0; i < opts.voices; i++) {
        const src = sources[i % sources.length];
        const t = rng.next() * opts.seconds;
        const rate = Math.pow(spread, rng.next()) * Math.pow(2, rng.jitter(0.06));
        const g = rng.range(0.1, 0.34);
        const pan = rng.jitter(1);
        addResampled(L, src, t * sr, rate, g * (1 - pan * 0.5), true);
        addResampled(R, src, t * sr, rate, g * (1 + pan * 0.5), true);
      }
      if (opts.noise > 0) {
        // Unvoiced mass: breath, shuffling, the parts of a crowd that are not pitched.
        const nz = new Float32Array(p.len);
        pinkNoise(nz, rng, 1);
        runBiquad(nz, bandpassC(1100, 0.6, sr));
        for (let i = 0; i < p.len; i++) {
          const m = 0.7 + 0.3 * Math.sin((TAU * i) / p.len * 3);
          L[i] += nz[i] * opts.noise * m;
          R[i] += nz[p.len - 1 - i] * opts.noise * m;
        }
      }
      for (const c of p.ch) {
        runBiquad(c, highpassC(opts.hp, 0.7, sr));
        runBiquad(c, lowpassC(opts.lp, 0.7, sr));
        softClip(c, 1.8);
      }
      return p;
    },
  });
}

crowdRecipe('crowd_roar_low', {
  seconds: 4.2, voices: 52, f0: [96, 150], vowels: [VOWELS.o, VOWELS.a],
  rise: 1.0, noise: 0.3, lp: 3200, hp: 90, grain: 1.1,
});
crowdRecipe('crowd_roar_high', {
  seconds: 4.2, voices: 64, f0: [120, 210], vowels: [VOWELS.a, VOWELS.ae, VOWELS.e],
  rise: 1.08, noise: 0.22, lp: 5200, hp: 130, grain: 0.85,
});
crowdRecipe('crowd_panic', {
  seconds: 3.6, voices: 46, f0: [160, 300], vowels: [VOWELS.ae, VOWELS.e],
  rise: 1.22, noise: 0.16, lp: 6000, hp: 180, grain: 0.6,
});
crowdRecipe('crowd_cheer', {
  seconds: 3.6, voices: 58, f0: [130, 240], vowels: [VOWELS.a, VOWELS.e],
  rise: 1.05, noise: 0.3, lp: 5600, hp: 140, grain: 0.7,
});

/**
 * The texture of a melee: hundreds of blows a second, none of them individually audible.
 * A granular bed of shield, armour and flesh impacts, wrapped for a seamless loop. Played
 * under a handful of discrete near hits, this is what stops a big fight sounding like a
 * small fight played very fast.
 */
def('melee_clatter', {
  rate: 22050, peak: 0.9, loop: true,
  make(sr, rng) {
    const p = makePcm(sr, 3.4, 2);
    const L = p.ch[0];
    const R = p.ch[1];
    const grains = [
      RECIPES.hit_shield_0.make(sr, rng.fork('c1')),
      RECIPES.hit_armour_1.make(sr, rng.fork('c2')),
      RECIPES.hit_flesh_0.make(sr, rng.fork('c3')),
      RECIPES.parry_0.make(sr, rng.fork('c4')),
    ];
    for (const g of grains) normalizePeak(g.ch, 0.85);
    const weights = [1.0, 0.75, 0.5, 0.4];
    const perSecond = 42;
    const total = Math.round(3.4 * perSecond);
    for (let i = 0; i < total; i++) {
      const gi = rng.pickWeighted([0, 1, 2, 3], weights);
      const src = grains[gi].ch[0];
      const t = rng.next() * 3.4;
      const rate = Math.pow(2, rng.jitter(0.4));
      const g = rng.range(0.06, 0.22);
      const pan = rng.jitter(1);
      addResampled(L, src, t * sr, rate, g * (1 - pan * 0.55), true);
      addResampled(R, src, t * sr, rate, g * (1 + pan * 0.55), true);
    }
    for (const c of p.ch) {
      runBiquad(c, highpassC(110, 0.7, sr));
      softClip(c, 1.6);
    }
    return p;
  },
});

/**
 * `cry_roma` — the Roman war cry as a *disciplined* sound: a short unison shout on a
 * two-beat pulse with gladius hafts beaten on shield rims underneath. Vegetius warns
 * against shouting before contact precisely because Roman practice was controlled noise
 * on command, so this is tight (±10 ms onset spread), pitched in unison, and rhythmic.
 */
def('cry_roma', {
  rate: 22050, peak: 0.95,
  make(sr, rng) {
    const p = makePcm(sr, 3.2, 2);
    const L = p.ch[0];
    const R = p.ch[1];
    const n = p.len;

    // Two syllables: a closed "RO" then an open "MA".
    const syl = (vowel: readonly Formant[], seconds: number, f0: number): Float32Array => {
      const m = Math.round(seconds * sr);
      const src = new Float32Array(m);
      glottal(src, sr, (t) => f0 * (1 + 0.06 * Math.min(1, t * 4)), rng, 0.03, 0.16);
      const vo = new Float32Array(m);
      formantFilter(vo, src, vowel, sr);
      shapeEnv(vo, (t) => Math.min(1, t * 16) * (t < 0.6 ? 1 : Math.pow(1 - (t - 0.6) / 0.4, 1.2)));
      return vo;
    };
    const ro = syl(VOWELS.o, 0.3, 118);
    const ma = syl(VOWELS.a, 0.38, 122);

    const knock = RECIPES.impact_wood.make(sr, rng.fork('rim'));
    normalizePeak(knock.ch, 0.8);

    // 100 bpm: SHOUT-shout, SHOUT-shout, SHOUUUT.
    const beat = 0.6;
    const hits: Array<[number, Float32Array, number]> = [
      [0.0, ro, 1.0], [beat * 0.5, ma, 0.95],
      [beat * 1.5, ro, 1.0], [beat * 2.0, ma, 0.95],
      [beat * 3.0, ro, 1.0], [beat * 3.5, ma, 1.1],
    ];
    for (const [t0, grain, amp] of hits) {
      for (let v = 0; v < 30; v++) {
        // ±6 cents of detune and ±10 ms of onset: unison, but human.
        const rate = Math.pow(2, rng.jitter(0.03));
        const t = t0 + Math.abs(rng.normal(0, 0.009));
        const g = rng.range(0.14, 0.26) * amp;
        const pan = rng.jitter(0.75);
        addResampled(L, grain, t * sr, rate, g * (1 - pan * 0.5));
        addResampled(R, grain, t * sr, rate, g * (1 + pan * 0.5));
      }
      // Weapon on shield rim on every shout. Kept under the voices — the rim knocks are
      // sharp transients and left level-matched they take the whole peak to themselves.
      for (let v = 0; v < 14; v++) {
        const t = t0 + Math.abs(rng.normal(0, 0.014));
        const g = rng.range(0.035, 0.09) * amp;
        const pan = rng.jitter(1);
        addResampled(L, knock.ch[0], t * sr, Math.pow(2, rng.jitter(0.3)), g * (1 - pan * 0.5));
        addResampled(R, knock.ch[0], t * sr, Math.pow(2, rng.jitter(0.3)), g * (1 + pan * 0.5));
      }
    }
    for (const c of p.ch) {
      runBiquad(c, highpassC(110, 0.7, sr));
      runBiquad(c, lowpassC(5200, 0.7, sr));
      softClip(c, 1.6);
    }
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5;
    schroederTail(L, mono, sr, 1.3, 0.2, 1.2);
    schroederTail(R, mono, sr, 1.3, 0.2, 1.35);
    fadeOut(L, sr, 0.25);
    fadeOut(R, sr, 0.25);
    return p;
  },
});

/**
 * `cry_germanic` — the *barritus*. Tacitus (Germania 3) describes a cry that begins low
 * and swells, roughened by holding the shield to the mouth; Ammianus (16.12.43) has it
 * rising "from a low murmur to a mighty roar". So: three and a half seconds of one
 * continuous crescendo, pitch climbing about a fifth, run through a comb filter and a
 * strong 380 Hz resonance to imply a hollow shield-face in front of every mouth.
 */
def('cry_germanic', {
  rate: 22050, peak: 0.98,
  make(sr, rng) {
    const p = makePcm(sr, 4.0, 2);
    const L = p.ch[0];
    const R = p.ch[1];
    const n = p.len;
    const mono = new Float32Array(n);

    // Long grains so the crescendo is continuous rather than a sequence of shouts.
    const gl = Math.round(1.8 * sr);
    const sources: Float32Array[] = [];
    for (const vowel of [VOWELS.o, VOWELS.a, VOWELS.o]) {
      const src = new Float32Array(gl);
      glottal(src, sr, (t) => lerp(86, 132, Math.pow(t, 1.4)), rng, 0.05, 0.2);
      const vo = new Float32Array(gl);
      formantFilter(vo, src, vowel, sr);
      shapeEnv(vo, (t) => Math.min(1, t * 6) * Math.min(1, (1 - t) * 6));
      sources.push(vo);
    }
    for (let i = 0; i < 74; i++) {
      const src = sources[i % sources.length];
      // Grain start time biased late: the host joins in progressively.
      const t = Math.pow(rng.next(), 0.72) * 3.4;
      const rise = lerp(1.0, 1.45, t / 3.4);
      const rate = rise * Math.pow(2, rng.jitter(0.1)) * rng.range(0.86, 1.2);
      const g = rng.range(0.08, 0.3) * lerp(0.35, 1.25, t / 3.4);
      const pan = rng.jitter(1);
      addResampled(L, src, t * sr, rate, g * (1 - pan * 0.5));
      addResampled(R, src, t * sr, rate, g * (1 + pan * 0.5));
    }
    for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5;

    // Shield in front of the mouth: a short feedback comb (≈ 2.6 ms, a 0.44 m board's
    // round trip) plus a fat resonance where a cupped hollow reinforces.
    const d = Math.max(2, Math.round(0.0026 * sr));
    const line = new Float32Array(d);
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const y = line[idx];
      line[idx] = mono[i] + y * 0.52;
      idx = idx + 1 === d ? 0 : idx + 1;
      mono[i] = mono[i] * 0.6 + y * 0.55;
    }
    runBiquad(mono, peakingC(380, 1.1, 7, sr));
    runBiquad(mono, peakingC(760, 1.4, 4, sr));
    runBiquad(mono, highpassC(80, 0.7, sr));
    runBiquad(mono, lowpassC(4600, 0.7, sr));
    shapeEnv(mono, (t) => Math.min(1, t * 5) * (t < 0.88 ? 1 : Math.pow(1 - (t - 0.88) / 0.12, 1.4)));
    softClip(mono, 2.2);

    L.fill(0);
    R.fill(0);
    spreadStereo(L, R, mono, sr, 15, 23, 0.5);
    schroederTail(L, mono, sr, 1.8, 0.26, 1.3);
    schroederTail(R, mono, sr, 1.8, 0.26, 1.45);
    fadeOut(L, sr, 0.3);
    fadeOut(R, sr, 0.3);
    return p;
  },
});

/**
 * `cry_carthage` — a mercenary army has no single war cry, and that is the sound.
 *
 * Polybius makes the point directly: the Punic host had no common language, so it could not
 * be given one word of command, let alone one shout. Livy at the Trebia describes the noise
 * of Hannibal's line as many cries in many tongues at once.
 *
 * So this is deliberately the opposite of `cry_roma`. Where the Roman cry is unison on a
 * two-beat pulse with a ±10 ms onset spread, this is four overlapping groups at four
 * unrelated pitches with onsets spread over 700 ms and no shared rhythm at all — plus the
 * one thing that is unmistakably this army and nobody else's, an elephant trumpeting over
 * the top of it.
 */
def('cry_carthage', {
  rate: 22050, peak: 0.98,
  make(sr, rng) {
    const p = makePcm(sr, 4.4, 2);
    const L = p.ch[0];
    const R = p.ch[1];
    const n = p.len;
    const mono = new Float32Array(n);

    // Four contingents, each with its own pitch centre, onset and vowel colour. The pitches
    // are deliberately not harmonically related: a chord would read as one army singing.
    const groups: readonly [number, number, number][] = [
      [0.00, 118, 1.05],
      [0.21, 143, 0.95],
      [0.47, 97, 1.10],
      [0.68, 167, 0.85],
    ];
    for (const [onset, f0, dur] of groups) {
      const start = Math.floor(onset * sr);
      const len = Math.min(n - start, Math.floor(dur * sr));
      if (len <= 0) continue;
      // Many throats: 40 voices per group with wide pitch scatter, which is what turns a
      // shout into a roar rather than a chorus.
      for (let v = 0; v < 40; v++) {
        const det = 1 + (rng.next() - 0.5) * 0.13;
        const skew = Math.floor(rng.next() * 0.09 * sr);
        const amp = 0.010 + rng.next() * 0.012;
        let ph = rng.next();
        const f = f0 * det;
        for (let i = 0; i < len; i++) {
          const k = start + i + skew;
          if (k >= n) break;
          ph += f / sr;
          if (ph >= 1) ph -= 1;
          // A glottal buzz: a sawtooth is the right raw larynx before formants.
          const t = i / len;
          const env = Math.min(1, t * 7) * (t < 0.7 ? 1 : Math.pow(1 - (t - 0.7) / 0.3, 1.5));
          mono[k] += (ph * 2 - 1) * amp * env;
        }
      }
    }

    // Vowel colour, broad and open — these are shouts, not words.
    runBiquad(mono, peakingC(620, 1.0, 8, sr));
    runBiquad(mono, peakingC(1180, 1.2, 5, sr));
    runBiquad(mono, highpassC(95, 0.7, sr));

    /**
     * The elephant, over the top.
     *
     * A trumpet is a rising glissando through roughly 300 to 900 Hz with strong odd
     * harmonics and a hard rasp, made by forcing air through the trunk. It is the single
     * most identifiable animal sound there is, and it is the reason this cue can never be
     * confused with the Juthungi barritus even at low volume across a battlefield.
     */
    {
      const start = Math.floor(0.95 * sr);
      const len = Math.min(n - start, Math.floor(1.5 * sr));
      let ph = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Up fast, hold, then fall away — the shape of a real trumpet call.
        const f = 300 + 600 * Math.min(1, t * 3.2) * (1 - t * 0.35);
        ph += f / sr;
        if (ph >= 1) ph -= 1;
        // Odd harmonics only, which is what makes it read as a horn rather than a voice.
        const sq = ph < 0.5 ? 1 : -1;
        const saw = ph * 2 - 1;
        const rasp = (rng.next() - 0.5) * 0.35;
        const env = Math.min(1, t * 12) * (t < 0.6 ? 1 : Math.pow(1 - (t - 0.6) / 0.4, 1.3));
        mono[start + i] += (sq * 0.55 + saw * 0.3 + rasp) * 0.30 * env;
      }
    }

    runBiquad(mono, lowpassC(5200, 0.7, sr));
    shapeEnv(mono, (t) => Math.min(1, t * 4) * (t < 0.86 ? 1 : Math.pow(1 - (t - 0.86) / 0.14, 1.4)));
    softClip(mono, 2.1);

    L.fill(0);
    R.fill(0);
    // Wider than the Roman cry and wider than the barritus: this army is not standing in
    // one place, and the stereo spread is the cheapest way to say so.
    spreadStereo(L, R, mono, sr, 18, 27, 0.62);
    schroederTail(L, mono, sr, 1.9, 0.27, 1.35);
    schroederTail(R, mono, sr, 1.9, 0.27, 1.5);
    fadeOut(L, sr, 0.3);
    fadeOut(R, sr, 0.3);
    return p;
  },
});


/**
 * A barked order. One officer, close, shouting over a battle: a short sequence of
 * syllables on a falling contour, with the throat pushed hard enough that F1 rises and the
 * bands widen. `crowd` layers the unit shouting the acknowledgement back, which is what
 * makes an order sound like it was obeyed.
 *
 * `Abilities.ts` emits `playSound` with these ids, so each one has to exist or the
 * ability system is silent.
 */
function commandRecipe(
  id: string,
  opts: {
    syllables: Array<[readonly Formant[], number]>;
    f0: number;
    gap: number;
    crowd?: number;
    /** 0 = a parade-ground bark, 1 = a Germanic howl. */
    wild?: number;
  }
): void {
  def(id, {
    rate: 22050, peak: 0.92,
    make(sr, rng) {
      const wild = opts.wild ?? 0;
      const total = opts.syllables.reduce((a, s) => a + s[1] + opts.gap, 0.5);
      const p = makePcm(sr, total);
      const d = p.ch[0];
      let t = 0.02;
      let k = 0;
      for (const [vowel, secs] of opts.syllables) {
        const m = Math.round(secs * sr);
        const off = Math.round(t * sr);
        if (off + m > p.len) break;
        const src = new Float32Array(m);
        // Each successive syllable drops in pitch; the last one drops hardest.
        const f0 = opts.f0 * Math.pow(0.93, k) * (1 + wild * 0.35);
        glottal(src, sr, (u) => f0 * (1 + 0.16 * Math.min(1, u * 5) - 0.24 * u * u), rng,
          0.03 + wild * 0.05, 0.16 + wild * 0.2, 0.34);
        const vo = new Float32Array(m);
        formantFilter(vo, src, vowel, sr);
        shapeEnv(vo, (u) => Math.min(1, u * 20) * (u < 0.65 ? 1 : Math.pow(1 - (u - 0.65) / 0.35, 1.2)));
        for (let i = 0; i < m; i++) d[off + i] += vo[i] * 1.4;
        t += secs + opts.gap;
        k++;
      }
      if (opts.crowd && opts.crowd > 0) {
        // The unit answering, a beat behind and blurred by thirty men not quite together.
        const gl = Math.round(0.4 * sr);
        const src = new Float32Array(gl);
        glottal(src, sr, (u) => opts.f0 * 0.85 * (1 - u * 0.2), rng, 0.05, 0.24);
        const vo = new Float32Array(gl);
        formantFilter(vo, src, VOWELS.a, sr);
        shapeEnv(vo, (u) => Math.min(1, u * 10) * Math.min(1, (1 - u) * 5));
        for (let v = 0; v < 22; v++) {
          addResampled(d, vo, (t - opts.gap * 0.4) * sr + rng.range(0, 0.07) * sr,
            Math.pow(2, rng.jitter(0.12)), rng.range(0.06, 0.18) * opts.crowd);
        }
      }
      runBiquad(d, highpassC(120, 0.7, sr));
      runBiquad(d, lowpassC(5600, 0.7, sr));
      dcBlock(d, sr, 80);
      softClip(d, 1.5 + wild);
      return p;
    },
  });
}

// "Testudo!" — two syllables, flat and procedural, the way a drilled order sounds.
commandRecipe('order_testudo', { syllables: [[VOWELS.e, 0.16], [VOWELS.o, 0.28]], f0: 132, gap: 0.05, crowd: 0.7 });
// "Iacite!" — one hard syllable; a volley order has to cut through everything.
commandRecipe('order_volley', { syllables: [[VOWELS.a, 0.13], [VOWELS.e, 0.2]], f0: 148, gap: 0.03 });
// An officer's exhortation: longer, more syllables, and the men answer.
commandRecipe('order_inspire', {
  syllables: [[VOWELS.o, 0.2], [VOWELS.a, 0.22], [VOWELS.e, 0.3]], f0: 124, gap: 0.07, crowd: 1.0,
});
commandRecipe('order_brace', { syllables: [[VOWELS.a, 0.24]], f0: 140, gap: 0.04, crowd: 0.5 });
commandRecipe('order_arrowstorm', { syllables: [[VOWELS.e, 0.14], [VOWELS.a, 0.24]], f0: 152, gap: 0.04 });
commandRecipe('order_charge', { syllables: [[VOWELS.a, 0.3]], f0: 158, gap: 0.05, crowd: 1.2 });
// Not an order at all — the fanatics working themselves up.
commandRecipe('order_frenzy', {
  syllables: [[VOWELS.ae, 0.34], [VOWELS.a, 0.42]], f0: 168, gap: 0.06, crowd: 1.1, wild: 1,
});

/**
 * Cornu. A coiled G-shaped bronze horn with a conical bore, so: strong odd harmonics, a
 * buzzy lip transient, and a slow bloom as the bore fills. Used for signals and as the
 * brass voice of the score.
 */
function cornuRecipe(id: string, f0: number, seconds: number, contour: (t: number) => number): void {
  def(id, {
    rate: 44100, peak: 0.9,
    make(sr, rng) {
      const p = makePcm(sr, seconds);
      const d = p.ch[0];
      const n = p.len;
      const partials = [1, 2, 3, 4, 5, 6, 7, 9, 11];
      const weight = [1.0, 0.52, 0.62, 0.3, 0.34, 0.16, 0.18, 0.09, 0.05];
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const t01 = i / n;
        const f = f0 * contour(t01);
        // Brass brightens as it gets louder — the partial tilt tracks the envelope.
        const env = Math.min(1, t / 0.09) * (t01 < 0.7 ? 1 : Math.pow(1 - (t01 - 0.7) / 0.3, 1.3));
        const tilt = 0.45 + 0.55 * env;
        let s = 0;
        for (let k = 0; k < partials.length; k++) {
          s += Math.sin(TAU * f * partials[k] * t) * weight[k] * Math.pow(tilt, k * 0.8);
        }
        d[i] = s * env * 0.25;
      }
      // Lip buzz and breath.
      const air = new Float32Array(n);
      whiteNoise(air, rng, 1);
      runBiquad(air, bandpassC(f0 * 6, 0.8, sr));
      shapeEnv(air, (t) => Math.min(1, t * 14) * Math.exp(-t * 2.4) * 0.4);
      for (let i = 0; i < n; i++) d[i] += air[i] * 0.35;
      runBiquad(d, peakingC(f0 * 3.2, 1.2, 5, sr));
      runBiquad(d, lowpassC(4200, 0.7, sr));
      dcBlock(d, sr, 50);
      softClip(d, 1.3);
      return p;
    },
  });
}

// A rising fourth is the simplest signal that reads as a military call rather than a note.
cornuRecipe('cornu_call', 98, 2.3, (t) => (t < 0.34 ? 1 : t < 0.72 ? 4 / 3 : 1.5));
cornuRecipe('cornu_low', 73.4, 2.8, (t) => (t < 0.5 ? 1 : 1.125));

// ---- Ambience -------------------------------------------------------------

function windRecipe(id: string, opts: { seconds: number; lo: number; hi: number; gust: number; rate: number }): void {
  def(id, {
    rate: 22050, peak: 0.8, loop: true,
    make(sr, rng) {
      const p = makePcm(sr, opts.seconds, 2);
      for (let c = 0; c < 2; c++) {
        const d = p.ch[c];
        pinkNoise(d, rng, 1);
        // Gusting: the filter walks, which reads as wind far better than gain alone.
        svfSweep(d, sr, (t) => {
          const g =
            0.5 + 0.5 * Math.sin(TAU * (t * opts.rate + c * 0.31)) *
            (0.6 + 0.4 * Math.sin(TAU * (t * opts.rate * 2.7 + c * 0.13)));
          return lerp(opts.lo, opts.hi, g);
        }, 0.9, 'lp');
        shapeEnv(d, (t) => 1 - opts.gust * 0.5 * (0.5 + 0.5 * Math.sin(TAU * (t * opts.rate * 1.7 + c * 0.5))));
        runBiquad(d, highpassC(45, 0.7, sr));
      }
      return makeSeamless(p, 0.5);
    },
  });
}

windRecipe('wind_soft', { seconds: 6.5, lo: 240, hi: 900, gust: 0.4, rate: 0.9 });
windRecipe('wind_gust', { seconds: 5.5, lo: 500, hi: 3400, gust: 0.8, rate: 1.7 });

/** Birdsong: FM sine with a fast pitch contour. Four species-ish variants. */
family('bird', 4, 44100, 0.55, (sr, rng, k) => {
  const p = makePcm(sr, 0.7);
  const d = p.ch[0];
  const n = p.len;
  const notes = 2 + k;
  const base = [2600, 3400, 2100, 4200][k];
  for (let j = 0; j < notes; j++) {
    const t0 = j * (0.11 + k * 0.02) + rng.range(0, 0.02);
    const dur = rng.range(0.045, 0.1);
    const i0 = Math.round(t0 * sr);
    const len = Math.round(dur * sr);
    const up = rng.bool(0.6) ? 1 : -1;
    for (let i = 0; i < len && i0 + i < n; i++) {
      const t = i / len;
      const f = base * (1 + up * 0.28 * t) * (1 + 0.05 * Math.sin(TAU * t * 40));
      const e = Math.sin(Math.PI * t);
      d[i0 + i] += Math.sin((TAU * f * i) / sr) * e * 0.8;
    }
  }
  runBiquad(d, highpassC(1200, 0.7, sr));
  return p;
});

/** Cicadas and crickets: amplitude-modulated high band, the trill rate of a warm day. */
def('insects', {
  rate: 22050, peak: 0.45, loop: true,
  make(sr, rng) {
    const p = makePcm(sr, 4.5, 2);
    for (let c = 0; c < 2; c++) {
      const d = p.ch[c];
      whiteNoise(d, rng, 1);
      runBiquad(d, bandpassC(c === 0 ? 4300 : 4900, 3.0, sr), 2);
      const trill = 42 + c * 6;
      for (let i = 0; i < p.len; i++) {
        const t = i / sr;
        const m = 0.5 + 0.5 * Math.sin(TAU * trill * t);
        // Groups of insects fade in and out of earshot.
        const slow = 0.55 + 0.45 * Math.sin(TAU * (t * 0.13 + c * 0.4));
        d[i] *= Math.pow(m, 1.6) * slow;
      }
    }
    return makeSeamless(p, 0.3);
  },
});

/**
 * Rome, heard across the Campus Martius: a city of a million people is a low, formless
 * rumble with the occasional cart or shout surfacing out of it.
 */
def('city_distant', {
  rate: 22050, peak: 0.5, loop: true,
  make(sr, rng) {
    const p = makePcm(sr, 6.0, 2);
    const L = p.ch[0];
    const R = p.ch[1];
    const gl = Math.round(1.2 * sr);
    const src = new Float32Array(gl);
    glottal(src, sr, (t) => lerp(112, 128, t), rng, 0.06, 0.25);
    const vo = new Float32Array(gl);
    formantFilter(vo, src, VOWELS.a, sr);
    shapeEnv(vo, (t) => Math.min(1, t * 5) * Math.min(1, (1 - t) * 5));
    for (let i = 0; i < 40; i++) {
      const t = rng.next() * 6.0;
      const rate = Math.pow(2, rng.jitter(0.5));
      const pan = rng.jitter(0.6);
      const g = rng.range(0.04, 0.14);
      addResampled(L, vo, t * sr, rate, g * (1 - pan * 0.5), true);
      addResampled(R, vo, t * sr, rate, g * (1 + pan * 0.5), true);
    }
    const rumble = new Float32Array(p.len);
    pinkNoise(rumble, rng, 1);
    runBiquad(rumble, lowpassC(280, 0.8, sr), 2);
    for (let i = 0; i < p.len; i++) {
      L[i] += rumble[i] * 0.8;
      R[i] += rumble[p.len - 1 - i] * 0.8;
    }
    for (const c of p.ch) {
      // Distance: everything above 1.4 kHz has been absorbed by 600 m of air.
      runBiquad(c, lowpassC(1400, 0.7, sr), 2);
      runBiquad(c, highpassC(60, 0.7, sr));
    }
    return makeSeamless(p, 0.4);
  },
});

// ---- Music percussion -----------------------------------------------------

/** Frame drum: a goatskin membrane on a wooden hoop. Two low modes plus skin slap. */
family('drum_frame', 3, 44100, 0.9, (sr, rng, k) => {
  const p = makePcm(sr, 0.85);
  const d = p.ch[0];
  const n = p.len;
  const f0 = [82, 104, 128][k];
  const ex = burst(n, sr, rng, 0.0035);
  modalRing(d, ex, [
    { f: f0, decay: 0.42, amp: 1.0 },
    { f: f0 * 1.59, decay: 0.26, amp: 0.44 },
    { f: f0 * 2.14, decay: 0.17, amp: 0.24 },
    { f: f0 * 2.92, decay: 0.1, amp: 0.12 },
  ], sr, 1.4);
  const slap = burst(n, sr, rng, 0.012);
  runBiquad(slap, bandpassC(1500, 0.7, sr));
  for (let i = 0; i < n; i++) d[i] += slap[i] * 0.55;
  const hoop = burst(n, sr, rng, 0.03);
  runBiquad(hoop, bandpassC(430, 1.2, sr));
  for (let i = 0; i < n; i++) d[i] += hoop[i] * 0.3;
  dcBlock(d, sr, 30);
  softClip(d, 1.3);
  return p;
});

/** A war drum big enough to be felt: long, low, and slightly detuned against itself. */
def('drum_bass', {
  rate: 44100, peak: 0.95,
  make(sr, rng) {
    const p = makePcm(sr, 1.3);
    const d = p.ch[0];
    const n = p.len;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const f = 52 * Math.exp(-t * 1.4) + 33;
      d[i] += Math.sin(TAU * f * t) * Math.exp(-t * 3.1) * Math.min(1, t * 400) * 1.4;
      d[i] += Math.sin(TAU * f * 1.51 * t + 1.1) * Math.exp(-t * 5.5) * Math.min(1, t * 500) * 0.35;
    }
    const skin = burst(n, sr, rng, 0.02);
    runBiquad(skin, bandpassC(700, 0.7, sr));
    for (let i = 0; i < n; i++) d[i] += skin[i] * 0.4;
    dcBlock(d, sr, 24);
    softClip(d, 1.5);
    return p;
  },
});

/** A struck bronze disc for accents — long, inharmonic, faintly menacing. */
def('metal_tam', {
  rate: 44100, peak: 0.85,
  make(sr, rng) {
    const p = makePcm(sr, 2.6);
    const d = p.ch[0];
    const n = p.len;
    const ex = burst(n, sr, rng, 0.01);
    const modes: Mode[] = [];
    for (let i = 0; i < 14; i++) {
      modes.push({
        f: 210 * Math.pow(1.41, i * 0.72) * (1 + rng.jitter(0.05)),
        decay: 2.2 * Math.pow(0.86, i),
        amp: 0.9 * Math.pow(0.83, i),
      });
    }
    modalRing(d, ex, modes, sr, 1.2);
    dcBlock(d, sr, 40);
    softClip(d, 1.2);
    return p;
  },
});

// ---- Convolution impulse responses ---------------------------------------

/**
 * Impulse responses must match the context sample rate (`rate: 0`) — `ConvolverNode`
 * refuses anything else, unlike `AudioBufferSourceNode`.
 */
def('ir_field', {
  rate: 0, peak: 0.5,
  make(sr, rng) {
    const p = makePcm(sr, 1.0, 2);
    for (let c = 0; c < 2; c++) {
      const d = p.ch[c];
      whiteNoise(d, rng, 1);
      // Open ground: no early reflections to speak of, just a fast diffuse decay and a
      // ground slap. Air absorption means the tail is much darker than the direct sound.
      shapeEnv(d, (t) => Math.exp(-t * 9) * (t < 0.002 ? 0.1 : 1));
      runBiquad(d, lowpassC(2600, 0.7, sr), 2);
      runBiquad(d, highpassC(120, 0.7, sr));
      const slapAt = Math.round((0.011 + c * 0.0017) * sr);
      if (slapAt < d.length) d[slapAt] += 0.35;
    }
    return p;
  },
});

def('ir_hall', {
  rate: 0, peak: 0.5,
  make(sr, rng) {
    const p = makePcm(sr, 2.4, 2);
    for (let c = 0; c < 2; c++) {
      const d = p.ch[c];
      whiteNoise(d, rng, 1);
      shapeEnv(d, (t) => Math.pow(1 - t, 0.4) * Math.exp(-t * 3.2) * Math.min(1, t * 220));
      runBiquad(d, lowpassC(4200 - c * 300, 0.7, sr), 2);
      runBiquad(d, highpassC(90, 0.7, sr));
    }
    return p;
  },
});

familySizes();

// ---------------------------------------------------------------------------
// Bank
// ---------------------------------------------------------------------------

export interface BankStats {
  /** Wall-clock milliseconds spent synthesising. */
  buildMs: number;
  count: number;
  totalSamples: number;
  totalBytes: number;
}

/**
 * Every synthesised sound, keyed by id. Built once; `get` is a plain map lookup and is
 * safe to call from the frame loop.
 */
export class SoundBank {
  private map = new Map<string, AudioBuffer>();
  private loops = new Set<string>();
  readonly stats: BankStats = { buildMs: 0, count: 0, totalSamples: 0, totalBytes: 0 };

  get(id: string): AudioBuffer | null {
    return this.map.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  isLoop(id: string): boolean {
    return this.loops.has(id);
  }

  get ids(): string[] {
    return [...this.map.keys()];
  }
}

/**
 * Synthesise the whole bank against a context. Any single recipe that throws is skipped
 * rather than taking the game down — a missing sound is a missing sound, not a crash.
 */
export function buildSoundBank(actx: BaseAudioContext, seed = 'total-claude-audio'): SoundBank {
  const bank = new SoundBank();
  // Reaching through to the private maps is deliberate: they are read-only to every
  // consumer, and only this function is allowed to fill them.
  const self = bank as unknown as { map: Map<string, AudioBuffer>; loops: Set<string> };
  const t0 = now();
  const root = new Rng(seed);

  for (const id of Object.keys(RECIPES)) {
    const r = RECIPES[id];
    try {
      const sr = r.rate === 0 ? actx.sampleRate : r.rate;
      const pcm = r.make(sr, root.fork(id));
      if (r.peak > 0) normalizePeak(pcm.ch, r.peak);
      const buf = actx.createBuffer(pcm.ch.length, pcm.len, sr);
      // `getChannelData().set()` rather than `copyToChannel()`: our working buffers are
      // often subarray views, which the latter's stricter typing rejects.
      for (let c = 0; c < pcm.ch.length; c++) buf.getChannelData(c).set(pcm.ch[c]);
      self.map.set(id, buf);
      if (r.loop) self.loops.add(id);
      bank.stats.count++;
      bank.stats.totalSamples += pcm.len * pcm.ch.length;
    } catch (err) {
      console.warn(`[audio] recipe "${id}" failed to synthesise:`, err);
    }
  }
  bank.stats.buildMs = now() - t0;
  bank.stats.totalBytes = bank.stats.totalSamples * 4;
  return bank;
}

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/** All registered ids, for the offline level test. */
export const recipeIds = (): string[] => Object.keys(RECIPES);

/** Nominal duration of a recipe without building it — used by the self-test report. */
export const recipeRate = (id: string): number => RECIPES[id]?.rate ?? 0;
