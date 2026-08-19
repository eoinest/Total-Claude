import * as THREE from 'three';
import { hash2 } from '../util/rand';
import { clamp01, smoothstep } from '../util/math';

/**
 * Procedural texture generation for every VFX surface.
 *
 * The whole atlas set is synthesised at init from a single tileable noise sheet, so
 * the effects layer has no asset dependency at all: with an empty `public/assets/`
 * the battlefield still gets dust, smoke, blood, sparks and decals.
 *
 * Written into `DataTexture` rather than a 2D canvas on purpose. Canvas 2D composites
 * in premultiplied alpha, which destroys the RGB detail of any pixel with low alpha —
 * exactly the pixels that make up 90% of a smoke puff. Writing the bytes directly
 * keeps straight alpha and full precision in the faint edges.
 */

// ---------------------------------------------------------------------------
// Tileable value-noise sheet — computed once, sampled by every shape below.
// ---------------------------------------------------------------------------

const SHEET = 256;

const wrapHash = (xi: number, yi: number, period: number, salt: number): number => {
  const x = ((xi % period) + period) % period;
  const y = ((yi % period) + period) % period;
  return hash2(x, y, salt);
};

/** Periodic value noise so the sheet wraps seamlessly at `period` cells. */
const tileNoise = (x: number, y: number, period: number, salt: number): number => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = x - xi;
  const ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = wrapHash(xi, yi, period, salt);
  const b = wrapHash(xi + 1, yi, period, salt);
  const c = wrapHash(xi, yi + 1, period, salt);
  const d = wrapHash(xi + 1, yi + 1, period, salt);
  const t0 = a + (b - a) * sx;
  const t1 = c + (d - c) * sx;
  return t0 + (t1 - t0) * sy;
};

let sheet: Float32Array | null = null;

function noiseSheet(): Float32Array {
  if (sheet) return sheet;
  const n = new Float32Array(SHEET * SHEET);
  for (let j = 0; j < SHEET; j++) {
    for (let i = 0; i < SHEET; i++) {
      let s = 0;
      let amp = 0.5;
      let per = 8;
      for (let o = 0; o < 4; o++) {
        s += amp * tileNoise((i / SHEET) * per, (j / SHEET) * per, per, 17 + o * 131);
        amp *= 0.5;
        per *= 2;
      }
      n[j * SHEET + i] = s / 0.9375;
    }
  }
  sheet = n;
  return n;
}

/** Bilinear, wrapping lookup into the noise sheet. `u`/`v` are in sheet texels. */
function ns(u: number, v: number): number {
  const s = noiseSheet();
  const x = u - Math.floor(u / SHEET) * SHEET;
  const y = v - Math.floor(v / SHEET) * SHEET;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = (x0 + 1) % SHEET;
  const y1 = (y0 + 1) % SHEET;
  const fx = x - x0;
  const fy = y - y0;
  const a = s[y0 * SHEET + x0];
  const b = s[y0 * SHEET + x1];
  const c = s[y1 * SHEET + x0];
  const d = s[y1 * SHEET + x1];
  const t0 = a + (b - a) * fx;
  const t1 = c + (d - c) * fx;
  return t0 + (t1 - t0) * fy;
}

/** Value noise indexed by angle — used for ragged silhouettes on debris. */
function angularNoise(theta: number, lobes: number, salt: number): number {
  const t = (theta / (Math.PI * 2)) * lobes;
  const i0 = Math.floor(t);
  const f = t - i0;
  const s = f * f * (3 - 2 * f);
  const a = hash2(((i0 % lobes) + lobes) % lobes, salt, 991);
  const b = hash2((((i0 + 1) % lobes) + lobes) % lobes, salt, 991);
  return a + (b - a) * s;
}

// ---------------------------------------------------------------------------
// Particle atlas
// ---------------------------------------------------------------------------

/** Tile indices into the particle atlas. Keep in sync with `PARTICLE_ATLAS_DIM`. */
export const PT = {
  smokeSoft: 0,
  smokeDense: 1,
  dustWisp: 2,
  dustBillow: 3,
  bloodDrop: 4,
  bloodSpray: 5,
  spark: 6,
  ember: 7,
  debrisChip: 8,
  feather: 9,
  splinter: 10,
  ring: 11,
  flame: 12,
  glow: 13,
  clod: 14,
  rainStreak: 15,
} as const;

export const PARTICLE_ATLAS_DIM = 4;

interface Px {
  r: number;
  g: number;
  b: number;
  a: number;
}

const out: Px = { r: 0, g: 0, b: 0, a: 0 };

/**
 * Shade one atlas pixel.
 * `u`,`v` run -1..1 across the tile with +v up; `p`,`q` are the same in 0..1.
 */
function shadeTile(tile: number, u: number, v: number, p: number, q: number): void {
  const r = Math.hypot(u, v);
  const theta = Math.atan2(v, u);
  // Distinct noise regions per tile so no two shapes share a silhouette.
  const ox = (tile % 4) * 61;
  const oy = Math.floor(tile / 4) * 79;
  out.r = 1;
  out.g = 1;
  out.b = 1;
  out.a = 0;

  switch (tile) {
    case PT.smokeSoft:
    case PT.smokeDense: {
      const dense = tile === PT.smokeDense;
      const f = ns(p * 96 + ox, q * 96 + oy);
      const f2 = ns(p * 210 + ox * 3, q * 210 + oy * 3);
      // Perturb the radius rather than the alpha so the silhouette itself is lumpy.
      const rr = r * (1 + (f - 0.5) * (dense ? 0.42 : 0.62));
      let a = clamp01(1 - rr);
      a = Math.pow(a, dense ? 1.35 : 2.0);
      a *= 0.72 + 0.28 * f2;
      out.a = a;
      // Internal density variation; the shader uses .r as a light-scattering modulation.
      //
      // Wide on purpose. This is the tile that carries most of the dust in the game, and a
      // bank built from dozens of overlapping puffs integrates toward the *mean* of this
      // field — so a narrow range gives a bank with the right optical depth and no interior
      // at all, which is what turns a charge's dust into a flat ochre wash. The mean is
      // unchanged; only the contrast is raised, so the cloud has lit crowns and shadowed
      // hollows without becoming any thinner.
      out.r = out.g = out.b = clamp01(0.20 + 0.98 * (f * 0.65 + f2 * 0.35));
      break;
    }
    case PT.dustWisp: {
      // Sheared, torn wisp: reads as kicked-up grit rather than a soft ball.
      const su = u * 0.72 + v * 0.18;
      const sv = v * 1.35;
      const e = Math.hypot(su, sv);
      const f = ns(p * 150 + ox, q * 74 + oy);
      const rr = e * (1 + (f - 0.5) * 0.95);
      let a = clamp01(1 - rr);
      a = Math.pow(a, 1.55) * smoothstep((f - 0.16) * 3.4);
      out.a = a;
      out.r = out.g = out.b = clamp01(0.38 + 0.62 * f);
      break;
    }
    case PT.dustBillow: {
      // The big rolling front of a charge — cauliflower lobes, flat-ish bottom.
      const f = ns(p * 56 + ox, q * 56 + oy);
      const lobe = 0.62 + 0.3 * angularNoise(theta, 7, 3) + 0.16 * (f - 0.5);
      let a = clamp01((lobe - r) / 0.52);
      a = Math.pow(a, 1.2);
      // Heavier and flatter underneath, as if the ground shears the base off.
      a *= 0.55 + 0.45 * clamp01((v + 1.15) * 0.7);
      out.a = a * (0.78 + 0.22 * f);
      out.r = out.g = out.b = clamp01(0.34 + 0.66 * (f * 0.5 + 0.5 * clamp01(v * 0.5 + 0.6)));
      break;
    }
    case PT.bloodDrop: {
      const f = ns(p * 190 + ox, q * 190 + oy);
      const rr = r * (1 + (f - 0.5) * 0.22);
      out.a = Math.pow(clamp01((0.9 - rr) / 0.34), 0.8);
      // Wet highlight on the upper-left so droplets are not flat discs.
      out.r = out.g = out.b = clamp01(0.6 + 0.5 * clamp01(0.4 - u) * clamp01(v + 0.5));
      break;
    }
    case PT.bloodSpray: {
      // Teardrop with a broken tail — a flung streak of blood, not a dot.
      const sv = (v + 0.35) * 0.72;
      const taper = 1 - clamp01((v + 0.2) * 0.55);
      const e = Math.hypot(u / Math.max(0.16, taper * 0.72), sv);
      const f = ns(p * 170 + ox, q * 120 + oy);
      let a = clamp01((0.92 - e) / 0.3);
      a *= smoothstep((f - 0.1) * 3.0);
      out.a = Math.pow(a, 0.85);
      out.r = out.g = out.b = clamp01(0.55 + 0.45 * f);
      break;
    }
    case PT.spark: {
      // Thin hot streak. Additive, so RGB carries the temperature falloff.
      const w = 0.045 + 0.05 * clamp01(1 - Math.abs(v));
      const core = Math.exp(-(u * u) / (w * w));
      const along = Math.pow(clamp01(1 - Math.abs(v)), 1.4);
      out.a = clamp01(core * along);
      const hot = clamp01(core * 1.1);
      out.r = 1;
      out.g = 0.42 + 0.58 * hot;
      out.b = 0.1 + 0.7 * hot * hot;
      break;
    }
    case PT.ember: {
      const g = Math.exp(-r * r * 5.5);
      out.a = clamp01(g * 1.15);
      out.r = 1;
      out.g = clamp01(0.35 + 0.65 * g);
      out.b = clamp01(0.06 + 0.5 * g * g);
      break;
    }
    case PT.debrisChip: {
      const rad = 0.44 + 0.3 * angularNoise(theta, 6, 11);
      out.a = r < rad ? 1 : clamp01((rad + 0.06 - r) / 0.06);
      const f = ns(p * 130 + ox, q * 130 + oy);
      // Faceted: one side catches the light, the other is in shadow.
      out.r = out.g = out.b = clamp01(0.3 + 0.5 * f + 0.3 * clamp01(u * 0.6 + v * 0.4 + 0.3));
      break;
    }
    case PT.feather: {
      const sv = v * 0.62;
      const e = Math.hypot(u * 1.9, sv);
      const quill = Math.exp(-(u * u) / 0.002) * clamp01(1 - Math.abs(v));
      const vane = clamp01((0.86 - e) / 0.2);
      // Barb notches so the edge is combed rather than smooth.
      const notch = 0.72 + 0.28 * Math.abs(Math.sin(v * 22));
      out.a = clamp01(Math.max(vane * notch, quill));
      out.r = out.g = out.b = clamp01(0.55 + 0.45 * (1 - Math.abs(u)));
      break;
    }
    case PT.splinter: {
      // Long wood shard flung off a shield boss.
      const taper = clamp01(0.9 - Math.abs(v) * 0.55);
      const e = Math.abs(u) / Math.max(0.05, taper * 0.2);
      const a = clamp01((1 - e) / 0.35) * clamp01((1 - Math.abs(v)) * 3);
      out.a = a;
      const f = ns(p * 260 + ox, q * 60 + oy);
      out.r = out.g = out.b = clamp01(0.4 + 0.6 * f);
      break;
    }
    case PT.ring: {
      // Expanding shock ring for parries and charge impacts.
      const d = r - 0.74;
      out.a = clamp01(Math.exp(-(d * d) / 0.0055) * (0.75 + 0.25 * angularNoise(theta, 12, 5)));
      out.r = 1;
      out.g = 0.94;
      out.b = 0.82;
      break;
    }
    case PT.flame: {
      // Upward lick, eroded by noise; additive.
      const sv = (v + 0.55) * 0.62;
      const taper = clamp01(1.05 - (v + 0.5) * 0.72);
      const e = Math.hypot(u / Math.max(0.12, taper * 0.62), sv);
      const f = ns(p * 120 + ox, (q * 120 - 40) + oy);
      let a = clamp01((0.96 - e) / 0.42);
      a *= smoothstep((f - 0.06) * 2.6);
      a = Math.pow(a, 1.1);
      out.a = a;
      // Hot white-yellow core cooling to orange at the tips.
      const heat = clamp01(a * 1.5 - clamp01(v * 0.6 + 0.2));
      out.r = 1;
      out.g = clamp01(0.34 + 0.66 * heat);
      out.b = clamp01(0.03 + 0.42 * heat * heat);
      break;
    }
    case PT.glow: {
      const g = Math.exp(-r * r * 2.6);
      out.a = clamp01(g);
      out.r = 1;
      out.g = 0.86;
      out.b = 0.66;
      break;
    }
    case PT.clod: {
      const rad = 0.52 + 0.24 * angularNoise(theta, 9, 23);
      const f = ns(p * 170 + ox, q * 170 + oy);
      out.a = clamp01((rad - r) / 0.13) * (0.8 + 0.2 * f);
      out.r = out.g = out.b = clamp01(0.24 + 0.62 * f);
      break;
    }
    case PT.rainStreak: {
      const core = Math.exp(-(u * u) / 0.0012);
      out.a = clamp01(core * Math.pow(clamp01(1 - Math.abs(v)), 0.55) * 0.9);
      out.r = 0.78;
      out.g = 0.84;
      out.b = 0.92;
      break;
    }
  }

  // Guarantee alpha reaches zero inside the tile border so mip generation cannot
  // bleed one shape into its neighbour.
  const edge = Math.min(Math.min(p, 1 - p), Math.min(q, 1 - q));
  out.a *= smoothstep(edge * 22);
}

function buildAtlas(tileCount: number, tilePx: number, dim: number): THREE.DataTexture {
  const size = tilePx * dim;
  const data = new Uint8Array(size * size * 4);
  for (let tile = 0; tile < tileCount; tile++) {
    const bx = (tile % dim) * tilePx;
    const by = Math.floor(tile / dim) * tilePx;
    for (let py = 0; py < tilePx; py++) {
      const q = (py + 0.5) / tilePx;
      const v = q * 2 - 1;
      for (let px = 0; px < tilePx; px++) {
        const p = (px + 0.5) / tilePx;
        const u = p * 2 - 1;
        shadeTile(tile, u, v, p, q);
        const o = ((by + py) * size + bx + px) * 4;
        data[o] = (out.r * 255) | 0;
        data[o + 1] = (out.g * 255) | 0;
        data[o + 2] = (out.b * 255) | 0;
        data[o + 3] = (clamp01(out.a) * 255) | 0;
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** 1024², 4×4 tiles of 256 px. One texture for every particle in the game. */
export function makeParticleAtlas(): THREE.DataTexture {
  return buildAtlas(16, 256, PARTICLE_ATLAS_DIM);
}

// ---------------------------------------------------------------------------
// Decal atlas
// ---------------------------------------------------------------------------

/** Tile indices into the decal atlas. */
export const DT = {
  bloodPool: 0,
  bloodSplatter: 1,
  bloodStreak: 2,
  scorch: 3,
  trampleSoft: 4,
  dirtScuff: 5,
  bloodDrops: 6,
  hoofScuff: 7,
} as const;

export const DECAL_ATLAS_DIM = 4;

function shadeDecal(tile: number, u: number, v: number, p: number, q: number): void {
  const r = Math.hypot(u, v);
  const theta = Math.atan2(v, u);
  const ox = 311 + (tile % 4) * 47;
  const oy = 173 + Math.floor(tile / 4) * 53;
  out.r = 1;
  out.g = 1;
  out.b = 1;
  out.a = 0;

  switch (tile) {
    case DT.bloodPool: {
      // A soaked stain: lobed outline, dark centre, dried crust at the rim.
      const f = ns(p * 84 + ox, q * 84 + oy);
      const rad = 0.58 + 0.22 * angularNoise(theta, 8, 41) + 0.12 * (f - 0.5);
      const core = clamp01((rad - r) / 0.3);
      out.a = Math.pow(core, 0.62) * (0.82 + 0.18 * f);
      // .r modulates darkness: the middle of a pool is nearly black.
      out.r = out.g = out.b = clamp01(0.28 + 0.72 * (1 - core) * 0.9 + 0.16 * f);
      break;
    }
    case DT.bloodSplatter: {
      // Radial cast-off: a central blot plus satellite droplets on spokes.
      const f = ns(p * 210 + ox, q * 210 + oy);
      let a = Math.pow(clamp01((0.32 - r) / 0.2), 0.8);
      for (let k = 0; k < 14; k++) {
        const ang = hash2(k, tile, 7) * Math.PI * 2;
        const dist = 0.3 + hash2(k, tile, 13) * 0.62;
        const sz = 0.035 + hash2(k, tile, 19) * 0.075;
        const dx = u - Math.cos(ang) * dist;
        const dy = v - Math.sin(ang) * dist;
        a = Math.max(a, clamp01((sz - Math.hypot(dx, dy * 1.5)) / (sz * 0.7)));
      }
      out.a = clamp01(a * (0.85 + 0.15 * f));
      out.r = out.g = out.b = clamp01(0.34 + 0.5 * f);
      break;
    }
    case DT.bloodStreak: {
      // Drag mark: a wounded man crawling, or a body hauled clear.
      const sv = v * 0.42;
      const taper = clamp01(1 - (v * 0.5 + 0.5) * 0.6);
      const e = Math.hypot(u / Math.max(0.12, taper * 0.55), sv);
      const f = ns(p * 190 + ox, q * 70 + oy);
      out.a = clamp01((0.95 - e) / 0.42) * smoothstep((f - 0.12) * 3.2);
      out.r = out.g = out.b = clamp01(0.4 + 0.55 * f);
      break;
    }
    case DT.scorch: {
      const f = ns(p * 70 + ox, q * 70 + oy);
      const rad = 0.66 + 0.2 * (f - 0.5);
      out.a = Math.pow(clamp01((rad - r) / 0.5), 1.1) * (0.75 + 0.25 * f);
      out.r = out.g = out.b = clamp01(0.1 + 0.5 * f);
      break;
    }
    case DT.trampleSoft: {
      // Featureless soft blob: the accumulation brush for churned ground.
      const f = ns(p * 46 + ox, q * 46 + oy);
      out.a = Math.pow(clamp01(1 - r * (1 + (f - 0.5) * 0.4)), 1.8) * (0.7 + 0.3 * f);
      out.r = out.g = out.b = clamp01(0.35 + 0.65 * f);
      break;
    }
    case DT.dirtScuff: {
      // Boot-churn: streaky, directional, torn at the edges.
      const f = ns(p * 130 + ox, q * 48 + oy);
      const f2 = ns(p * 320 + ox, q * 320 + oy);
      const rad = 0.72 + 0.22 * (f - 0.5);
      let a = clamp01((rad - r) / 0.44);
      a *= smoothstep((f * 0.7 + f2 * 0.3 - 0.18) * 2.6);
      out.a = a;
      out.r = out.g = out.b = clamp01(0.28 + 0.7 * f2);
      break;
    }
    case DT.bloodDrops: {
      // Sparse spatter for droplet landings, no central blot.
      let a = 0;
      for (let k = 0; k < 22; k++) {
        const ang = hash2(k, tile, 3) * Math.PI * 2;
        const dist = Math.sqrt(hash2(k, tile, 5)) * 0.86;
        const sz = 0.024 + hash2(k, tile, 29) * 0.055;
        const dx = u - Math.cos(ang) * dist;
        const dy = v - Math.sin(ang) * dist;
        a = Math.max(a, clamp01((sz - Math.hypot(dx, dy)) / (sz * 0.65)));
      }
      out.a = a;
      out.r = out.g = out.b = 0.5;
      break;
    }
    case DT.hoofScuff: {
      // Two crescent gouges: a hoof strike at the gallop.
      const f = ns(p * 200 + ox, q * 200 + oy);
      let a = 0;
      for (let k = 0; k < 2; k++) {
        const cy = (k - 0.5) * 0.5;
        const d = Math.hypot(u * 1.5, (v - cy) * 2.4);
        a = Math.max(a, clamp01((0.62 - d) / 0.3));
      }
      out.a = a * (0.7 + 0.3 * f);
      out.r = out.g = out.b = clamp01(0.22 + 0.6 * f);
      break;
    }
  }

  const edge = Math.min(Math.min(p, 1 - p), Math.min(q, 1 - q));
  out.a *= smoothstep(edge * 20);
}

/** 512², 4×4 tiles of 128 px. Shared by the damage layer and the decal pool. */
export function makeDecalAtlas(): THREE.DataTexture {
  const tilePx = 128;
  const dim = DECAL_ATLAS_DIM;
  const size = tilePx * dim;
  const data = new Uint8Array(size * size * 4);
  for (let tile = 0; tile < 8; tile++) {
    const bx = (tile % dim) * tilePx;
    const by = Math.floor(tile / dim) * tilePx;
    for (let py = 0; py < tilePx; py++) {
      const q = (py + 0.5) / tilePx;
      const v = q * 2 - 1;
      for (let px = 0; px < tilePx; px++) {
        const p = (px + 0.5) / tilePx;
        const u = p * 2 - 1;
        shadeDecal(tile, u, v, p, q);
        const o = ((by + py) * size + bx + px) * 4;
        data[o] = (out.r * 255) | 0;
        data[o + 1] = (out.g * 255) | 0;
        data[o + 2] = (out.b * 255) | 0;
        data[o + 3] = (clamp01(out.a) * 255) | 0;
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Small tiling grayscale noise, used to add high-frequency grain to the ground
 * damage layer so a 1 m/texel accumulation buffer still reads as real staining.
 */
export function makeNoiseTexture(): THREE.DataTexture {
  const s = noiseSheet();
  const data = new Uint8Array(SHEET * SHEET * 4);
  for (let i = 0; i < SHEET * SHEET; i++) {
    const v = (clamp01(s[i]) * 255) | 0;
    data[i * 4] = v;
    // Second channel at a different phase gives the shader two decorrelated fields.
    data[i * 4 + 1] = (clamp01(s[(i * 7 + 971) % (SHEET * SHEET)]) * 255) | 0;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, SHEET, SHEET, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Banner cloth: one 512² texture, 2×2 tiles of the four standards flown on this field.
 *
 * Channels are a small material system rather than a picture, because the cloth is
 * tinted per unit and a baked-in colour would be destroyed by that tint:
 *   R  cloth luminance — weave, wear, shading
 *   G  device mask — where the painted or gilded device sits
 *   B  unused, reserved
 *   A  silhouette, including fringes, swallow-tails and torn edges
 *
 * The shader tints R with the unit's dye colour and G with the faction's metal or
 * paint colour, so a gold wreath stays gold on a blood-red vexillum.
 */
export const BANNER_TILE = {
  vexillum: 0,
  signum: 1,
  totem: 2,
  plain: 3,
} as const;

export function makeBannerTexture(): THREE.DataTexture {
  const tilePx = 256;
  const dim = 2;
  const size = tilePx * dim;
  const data = new Uint8Array(size * size * 4);

  for (let tile = 0; tile < 4; tile++) {
    const bx = (tile % dim) * tilePx;
    const by = Math.floor(tile / dim) * tilePx;
    for (let py = 0; py < tilePx; py++) {
      const q = (py + 0.5) / tilePx;
      for (let px = 0; px < tilePx; px++) {
        const p = (px + 0.5) / tilePx;
        const u = p * 2 - 1;
        const v = q * 2 - 1;
        let a = 1;
        let lum = 1;
        let device = 0;
        const f = ns(p * 140 + tile * 37, q * 140 + tile * 61);
        const f2 = ns(p * 420 + tile * 13, q * 420 + tile * 29);
        // Weave plus wear: keeps flat cloth from reading as vinyl.
        const weave = 0.80 + 0.20 * f * (0.6 + 0.4 * f2);

        if (tile === BANNER_TILE.vexillum) {
          /*
           * Square cloth with a gilded wreath and bar device; fringed lower edge.
           *
           * The fringe was `sin(p * 46)` thresholded to a hard 0/1, i.e. seven and a bit
           * identical teeth of identical length with a hard alpha step at every tip. Three
           * independent blind graders wrote down "a hem cut as a hard sawtooth" as one of
           * the things that gave the standard away, and a pure sine is exactly what that
           * phrase describes — pinking shears, not a fringe.
           *
           * A vexillum fringe is a row of *threads*. They are unequal, they are finer than
           * seven per metre, and they thin to nothing at the tip rather than ending in a
           * cliff. All three are here: pitch is thirty strands across the tile, length comes
           * off the noise sheet per strand, and alpha ramps out over the last third of each.
           */
          const strandN = 30;
          const si = Math.floor(p * strandN);
          const sPhase = p * strandN - si;
          const sLen = 0.030 + 0.070 * ns(si * 4.3 + tile * 9.1, 0.5);
          const across = Math.abs(sPhase - 0.5) * 2;
          const strand = clamp01((0.86 - across) / 0.34);
          a = q >= sLen ? 1 : strand * clamp01((q / Math.max(1e-4, sLen)) * 1.5);
          // A gilded laurel wreath enclosing a fulmen — Jupiter's thunderbolt, the
          // commonest device on a legionary vexillum. Deliberately not a bar across
          // the wreath: that reads as a modern prohibition sign at any distance.
          const cy = v + 0.06;
          const rw = Math.abs(Math.hypot(u * 1.05, cy * 1.05) - 0.50);
          // Laurel: the ring is beaded rather than smooth.
          const bead = 0.9 + 0.35 * Math.sin(Math.atan2(cy, u) * 16);
          const wreath = clamp01((0.062 * bead - rw) / 0.03);
          const shaft = clamp01((0.038 - Math.abs(u)) / 0.02) * clamp01((0.30 - Math.abs(cy)) / 0.05);
          const flashA = clamp01((0.045 - Math.abs(u - cy * 0.75)) / 0.03) * clamp01((0.17 - Math.abs(cy - 0.11)) / 0.05);
          const flashB = clamp01((0.045 - Math.abs(u + cy * 0.75)) / 0.03) * clamp01((0.17 - Math.abs(cy + 0.11)) / 0.05);
          const wings = clamp01((0.030 - Math.abs(cy - 0.30)) / 0.018) * clamp01((0.21 - Math.abs(u)) / 0.05);
          device = clamp01(Math.max(Math.max(wreath, shaft), Math.max(Math.max(flashA, flashB), wings)));
          lum = weave;
        } else if (tile === BANNER_TILE.signum) {
          // Tall narrow pennant: horizontal bands, swallow-tailed at the bottom.
          const inU = clamp01((0.58 - Math.abs(u)) * 90);
          // The swallow-tail is a cut rather than a fringe, so it stays a V — but a cut made
          // with shears wanders, and the wander is what stops it reading as a vector path.
          const notch = 0.24 + 0.020 * (ns(p * 9 + 31, 0.5) - 0.5);
          const tail = clamp01((Math.abs(u) - (notch - q) * 2.6) * 60);
          a = inU * (q < notch + 0.03 ? tail : 1);
          device = Math.abs(((q * 5.5) % 1) - 0.5) < 0.20 ? 1 : 0;
          lum = weave;
        } else if (tile === BANNER_TILE.totem) {
          // Germanic war-streamer: torn, uneven, with a crude painted rune.
          a = clamp01((0.82 - Math.abs(u)) * 4) * clamp01((0.96 - Math.abs(v)) * 5);
          /*
           * Ragged lower edge: this cloth has been carried through several summers.
           *
           * `sin(p * 27)` thresholded is not ragged, it is scalloped — a repeating unit four
           * and a bit times across the streamer, every lobe the same depth. Cloth tears
           * along the weave in runs of unequal length, so the depth comes off two octaves of
           * noise and the torn ends feather instead of stepping.
           */
          if (q < 0.30) {
            const tear = 0.26 * (0.35 + 0.65 * ns(p * 17 + 7, 3.5))
              * (0.55 + 0.45 * ns(p * 61 + 19, 8.5));
            a *= clamp01((q - tear) * 26 + 0.5);
          }
          // A vertical stroke with two diagonals — a runic mark, not a logo.
          const stem = clamp01((0.055 - Math.abs(u + 0.08)) / 0.03) * clamp01((0.64 - Math.abs(v)) / 0.1);
          const d1 = clamp01((0.065 - Math.abs(u + 0.08 - (v - 0.12) * 0.9)) / 0.04) * clamp01((0.3 - Math.abs(v - 0.26)) / 0.1);
          const d2 = clamp01((0.065 - Math.abs(u + 0.08 + (v + 0.12) * 0.9)) / 0.04) * clamp01((0.3 - Math.abs(v + 0.26)) / 0.1);
          device = clamp01(Math.max(stem, Math.max(d1, d2)));
          // Heavier soiling than a Roman standard: this one lives outdoors.
          lum = 0.62 + 0.38 * f;
        } else {
          // The spare tile. Deliberately *empty*, not a plain square of cloth.
          //
          // Nothing assigns `BANNER_TILE.plain`, but a fully-opaque 256 px square with
          // `lum` near 1 sitting next to the vexillum is a loaded gun: this atlas is
          // mip-mapped and anisotropically filtered, and cloth is nearly always viewed at a
          // glancing angle, so a banner samples across the tile seam at coarse mip levels
          // and pulls in whatever the neighbour holds. With alpha 1 that defeated the
          // `t.a < 0.4` discard and painted an opaque mottled quad per cloth cell — pale,
          // hard-edged, roughly ten pixels across. Keeping the luminance but zeroing the
          // alpha means the worst a seam can now do is trim a distant banner slightly.
          a = 0;
          lum = weave;
          device = 0;
        }

        // Fade alpha to zero inside the tile border, exactly as the particle atlas does,
        // so mip generation cannot bleed one standard's silhouette into another's.
        const edge = Math.min(Math.min(p, 1 - p), Math.min(q, 1 - q));
        a *= smoothstep(edge * 26);

        const o = ((by + py) * size + bx + px) * 4;
        data[o] = (clamp01(lum) * 255) | 0;
        data[o + 1] = (clamp01(device) * 255) | 0;
        data[o + 2] = 255;
        data[o + 3] = (clamp01(a) * 255) | 0;
      }
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  // Data, not colour: the shader combines the channels itself.
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
