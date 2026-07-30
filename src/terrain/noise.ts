/**
 * Deterministic 2-D gradient noise and the fBm variants the heightfield is built from.
 *
 * Everything here is allocation-free and table-driven: terrain generation evaluates
 * these functions ~40 million times at boot, so a single `Math.sin` on the hot path
 * costs a visible second of load time. Gradients come from a 256-entry unit-circle
 * table indexed by an integer hash, which is why there is no trigonometry below the
 * module-level setup.
 */

const GRAD_COUNT = 256;
const GRAD_MASK = GRAD_COUNT - 1;
const GRAD_X = new Float32Array(GRAD_COUNT);
const GRAD_Y = new Float32Array(GRAD_COUNT);
for (let i = 0; i < GRAD_COUNT; i++) {
  const a = (i / GRAD_COUNT) * Math.PI * 2;
  GRAD_X[i] = Math.cos(a);
  GRAD_Y[i] = Math.sin(a);
}

/** Integer hash → gradient table index. Same mixing constants as `util/rand.hash2`. */
const gradIndex = (ix: number, iy: number, seed: number): number => {
  let h = (Math.imul(ix, 0x8da6b343) ^ Math.imul(iy, 0xd8163841) ^ Math.imul(seed, 0xcb1ab31f)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 3) & GRAD_MASK;
};

/**
 * Perlin-style gradient noise in roughly [-1, 1].
 * Quintic fade keeps the second derivative continuous, which matters because the
 * terrain normal is a derivative of this — a cubic fade shows faint creases on
 * lattice lines under raking sunlight.
 */
export const gnoise = (x: number, y: number, seed = 0): number => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

  let g = gradIndex(xi, yi, seed);
  const n00 = GRAD_X[g] * xf + GRAD_Y[g] * yf;
  g = gradIndex(xi + 1, yi, seed);
  const n10 = GRAD_X[g] * (xf - 1) + GRAD_Y[g] * yf;
  g = gradIndex(xi, yi + 1, seed);
  const n01 = GRAD_X[g] * xf + GRAD_Y[g] * (yf - 1);
  g = gradIndex(xi + 1, yi + 1, seed);
  const n11 = GRAD_X[g] * (xf - 1) + GRAD_Y[g] * (yf - 1);

  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  // 1.4142 brings the theoretical 2-D Perlin range (±1/sqrt(2)) up to ±1.
  return (a + (b - a) * v) * 1.4142135;
};

/** Plain fBm: sum of octaves, each half the amplitude and twice the frequency. */
export const fbm = (
  x: number,
  y: number,
  octaves: number,
  freq: number,
  seed = 0,
  gain = 0.5,
  lacunarity = 2.0
): number => {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    sum += gnoise(x * f, y * f, seed + o * 131) * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
};

/**
 * Ridged multifractal in [0, 1]. `1 - |n|` folds the noise so zero-crossings become
 * sharp crests; weighting each octave by the previous one concentrates detail on the
 * ridges and leaves the valleys smooth, which is what real dissected uplands do.
 */
export const ridged = (
  x: number,
  y: number,
  octaves: number,
  freq: number,
  seed = 0,
  gain = 0.5,
  lacunarity = 2.07
): number => {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = freq;
  let weight = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(gnoise(x * f, y * f, seed + o * 977));
    n *= n;
    n *= weight;
    weight = n < 1 ? n * 1.9 : 1;
    sum += n * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
};

/** Billow (|noise|) fBm in [0, 1] — rounded, cumulus-like lumps. Good for soft hills. */
export const billow = (
  x: number,
  y: number,
  octaves: number,
  freq: number,
  seed = 0,
  gain = 0.5,
  lacunarity = 2.0
): number => {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    sum += Math.abs(gnoise(x * f, y * f, seed + o * 613)) * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
};

/**
 * Domain-warped fBm. Offsetting the sample point by another noise field bends the
 * lattice, which removes the tell-tale axis-aligned "quilt" of straight fBm and
 * produces the swirled, contour-following look of water-shaped ground.
 */
export const warpedFbm = (
  x: number,
  y: number,
  octaves: number,
  freq: number,
  seed = 0,
  warp = 1.0
): number => {
  const wx = gnoise(x * freq * 0.5 + 11.3, y * freq * 0.5 - 7.1, seed + 4211);
  const wy = gnoise(x * freq * 0.5 - 3.7, y * freq * 0.5 + 19.4, seed + 8123);
  const k = warp / freq;
  return fbm(x + wx * k, y + wy * k, octaves, freq, seed);
};

/**
 * Gradient noise whose lattice wraps every `period` cells, so a texture generated from
 * it tiles seamlessly. Procedural ground layers must tile or the whole splat system
 * shows a seam every few metres.
 */
export const pgnoise = (x: number, y: number, period: number, seed = 0): number => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;

  let g = gradIndex(x0, y0, seed);
  const n00 = GRAD_X[g] * xf + GRAD_Y[g] * yf;
  g = gradIndex(x1, y0, seed);
  const n10 = GRAD_X[g] * (xf - 1) + GRAD_Y[g] * yf;
  g = gradIndex(x0, y1, seed);
  const n01 = GRAD_X[g] * xf + GRAD_Y[g] * (yf - 1);
  g = gradIndex(x1, y1, seed);
  const n11 = GRAD_X[g] * (xf - 1) + GRAD_Y[g] * (yf - 1);

  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.4142135;
};

/**
 * Tileable fBm over the unit square. `base` is the lattice count of the first octave,
 * so every octave's period stays an integer and the result wraps exactly.
 * `stretch` squashes the y axis, which is how grass-blade streaks are made.
 */
export const tileFbm = (
  u: number,
  v: number,
  octaves: number,
  base: number,
  seed = 0,
  gain = 0.5,
  stretch = 1
): number => {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let lat = base;
  for (let o = 0; o < octaves; o++) {
    sum += pgnoise(u * lat, v * lat * stretch, lat, seed + o * 331) * amp;
    norm += amp;
    amp *= gain;
    lat *= 2;
  }
  return sum / norm;
};

/** Tileable ridged fBm in [0, 1] — sharp creases, for rock cracks and pebble edges. */
export const tileRidged = (
  u: number,
  v: number,
  octaves: number,
  base: number,
  seed = 0,
  gain = 0.55
): number => {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let lat = base;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(pgnoise(u * lat, v * lat, lat, seed + o * 733));
    sum += n * n * amp;
    norm += amp;
    amp *= gain;
    lat *= 2;
  }
  return sum / norm;
};

/** Smooth 0→1 ramp; duplicated from util/math so this module stays dependency-free. */
export const sstep = (edge0: number, edge1: number, v: number): number => {
  if (edge0 === edge1) return v < edge0 ? 0 : 1;
  let t = (v - edge0) / (edge1 - edge0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};
