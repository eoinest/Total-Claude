import * as THREE from 'three';
import { clamp01, smoothstep } from '../util/math';
import { hash2 } from '../util/rand';

/**
 * Procedural texture generation for the city's PBR materials.
 *
 * Deterministic (`hash2` only) and file-free, so the city still renders with an empty
 * `public/assets/`. With the manifest present `materials.ts` prefers the photographed
 * maps, except where the CC0 set has no usable albedo: brick, granite, veined marble,
 * and plaster, whose photograph is a featureless grey wall.
 *
 * Every map tiles: the lattice noise wraps on `period` and the brick, tile and plank
 * layouts fit an integer number of units. `worldSize` is the metres one repeat covers.
 */

export interface GeneratedMaps {
  /**
   * Albedo, mean-normalised per channel: variation at full strength, mean neutral, hue
   * still set by the vertex colour. Grey-only mottle averages to a flat tint at range.
   */
  albedo: THREE.DataTexture;
  normal: THREE.DataTexture;
  /** Roughness in G, metalness in B — packed so one sampler serves both. */
  orm: THREE.DataTexture;
  /** Reciprocal of the albedo map's linear mean; goes into `material.color`. */
  albedoGain: number;
  /** Metres of wall covered by one UV repeat. */
  worldSize: number;
}

// --- noise ------------------------------------------------------------------

/** Periodic value noise. `period` must be an integer lattice size for tiling. */
function vnoise(x: number, y: number, period: number, salt: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = smoothstep(x - xi);
  const ty = smoothstep(y - yi);
  const w = (v: number) => ((v % period) + period) % period;
  const x0 = w(xi);
  const x1 = w(xi + 1);
  const y0 = w(yi);
  const y1 = w(yi + 1);
  const a = hash2(x0, y0, salt);
  const b = hash2(x1, y0, salt);
  const c = hash2(x0, y1, salt);
  const d = hash2(x1, y1, salt);
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}

/** Fractal sum of periodic value noise, normalised to roughly 0..1. */
export function fbm(x: number, y: number, octaves: number, period: number, salt: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let p = period;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(x * f, y * f, p, salt + o * 7919) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
    p *= 2;
  }
  return sum / norm;
}

/** Sharp ridged noise, for cracks and chipped stone edges. */
function ridge(x: number, y: number, octaves: number, period: number, salt: number): number {
  return 1 - Math.abs(fbm(x, y, octaves, period, salt) * 2 - 1);
}

// --- texture assembly -------------------------------------------------------

function makeTexture(data: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  // Only albedo carries sRGB-encoded values; normals and ORM are raw data.
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 16;
  t.needsUpdate = true;
  return t;
}

const toSrgbByte = (linear: number): number => {
  const c = clamp01(linear);
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
};

/** Convert a heightfield into a tangent-space normal map (OpenGL convention, +Y up). */
export function normalFromHeight(
  height: Float32Array,
  size: number,
  strength: number
): THREE.DataTexture {
  const out = new Uint8Array(size * size * 4);
  const at = (i: number, j: number) => height[(((j % size) + size) % size) * size + (((i % size) + size) % size)];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const dx = (at(i + 1, j) - at(i - 1, j)) * strength;
      const dy = (at(i, j + 1) - at(i, j - 1)) * strength;
      // Normal of the height surface: (-dh/dx, -dh/dy, 1), normalised.
      const nx = -dx;
      const ny = -dy;
      const nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const o = (j * size + i) * 4;
      out[o] = Math.round(((nx / l) * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round(((-ny / l) * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round(((nz / l) * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }
  return makeTexture(out, size, false);
}

/** Colourless wrapper over `detailFromRgb`. */
export function detailFromField(field: Float32Array, size: number): { tex: THREE.DataTexture; gain: number } {
  const n = size * size;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = field[i];
    rgb[i * 3 + 1] = field[i];
    rgb[i * 3 + 2] = field[i];
  }
  return detailFromRgb(rgb, size);
}

/**
 * The one normalisation used by both the generators and the photographed sets. The scale
 * is a 99.6th percentile, not the maximum: one specular highlight otherwise quantises
 * every real variation into three byte levels, a second route to a flat surface.
 */
export function detailFromRgb(rgb: Float32Array, size: number): { tex: THREE.DataTexture; gain: number } {
  const n = size * size;
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    mr += rgb[i * 3];
    mg += rgb[i * 3 + 1];
    mb += rgb[i * 3 + 2];
  }
  mr = Math.max(1e-5, mr / n);
  mg = Math.max(1e-5, mg / n);
  mb = Math.max(1e-5, mb / n);

  const BUCKETS = 512;
  const TOP = 4;
  const hist = new Uint32Array(BUCKETS + 1);
  const ratio = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3] / mr;
    const g = rgb[i * 3 + 1] / mg;
    const b = rgb[i * 3 + 2] / mb;
    ratio[i * 3] = r;
    ratio[i * 3 + 1] = g;
    ratio[i * 3 + 2] = b;
    hist[Math.min(BUCKETS, Math.floor((Math.max(r, g, b) / TOP) * BUCKETS))]++;
  }
  const cut = n * 0.996;
  let acc = 0;
  let bucket = BUCKETS;
  for (let i = 0; i <= BUCKETS; i++) {
    acc += hist[i];
    if (acc >= cut) {
      bucket = i;
      break;
    }
  }
  const scale = 1 / Math.max(1.02, ((bucket + 1) / BUCKETS) * TOP);

  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[o] = toSrgbByte(ratio[i * 3] * scale);
    out[o + 1] = toSrgbByte(ratio[i * 3 + 1] * scale);
    out[o + 2] = toSrgbByte(ratio[i * 3 + 2] * scale);
    out[o + 3] = 255;
  }
  return { tex: makeTexture(out, size, true), gain: 1 / scale };
}

/**
 * Variation at the scale a distant camera resolves, sampled in world space by the shader
 * patch in `materials.ts`. A world-projected UV repeats every `worldSize` metres, so
 * nothing inside a tile varies at 10 m. R is brightness, G warm/cool, B a second octave.
 */
export function macroVariation(size = 256): THREE.DataTexture {
  const out = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const o = (j * size + i) * 4;
      const broad = fbm(u * 3, v * 3, 4, 3, 1301);
      // Patchy, not smooth: weathering arrives in zones with edges.
      const patch = smoothstep((fbm(u * 5, v * 5, 3, 5, 4507) - 0.46) * 3.4);
      out[o] = Math.round(clamp01(broad * 0.55 + patch * 0.45) * 255);
      out[o + 1] = Math.round(clamp01(fbm(u * 4, v * 4, 4, 4, 8809)) * 255);
      out[o + 2] = Math.round(clamp01(fbm(u * 7, v * 7, 3, 7, 2213)) * 255);
      out[o + 3] = 255;
    }
  }
  const t = makeTexture(out, size, false);
  t.anisotropy = 4;
  return t;
}

/** Pack roughness (G) and metalness (B) from two fields into one texture. */
export function ormFromFields(
  rough: Float32Array,
  size: number,
  metal: number
): THREE.DataTexture {
  const out = new Uint8Array(size * size * 4);
  const m = Math.round(clamp01(metal) * 255);
  for (let i = 0; i < rough.length; i++) {
    const o = i * 4;
    out[o] = 255;
    out[o + 1] = Math.round(clamp01(rough[i]) * 255);
    out[o + 2] = m;
    out[o + 3] = 255;
  }
  return makeTexture(out, size, false);
}

interface FieldSet {
  height: Float32Array;
  lum: Float32Array;
  rough: Float32Array;
  /** Per-texel chroma multipliers on `lum`. Absent means neutral grey. */
  chroma: Float32Array | null;
}

function fields(size: number, chroma = false): FieldSet {
  const n = size * size;
  return {
    height: new Float32Array(n),
    lum: new Float32Array(n),
    rough: new Float32Array(n),
    chroma: chroma ? new Float32Array(n * 3).fill(1) : null,
  };
}

function assemble(f: FieldSet, size: number, worldSize: number, normalStrength: number, metal: number): GeneratedMaps {
  let d: { tex: THREE.DataTexture; gain: number };
  if (f.chroma) {
    const n = size * size;
    const rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = f.lum[i] * f.chroma[i * 3];
      rgb[i * 3 + 1] = f.lum[i] * f.chroma[i * 3 + 1];
      rgb[i * 3 + 2] = f.lum[i] * f.chroma[i * 3 + 2];
    }
    d = detailFromRgb(rgb, size);
  } else {
    d = detailFromField(f.lum, size);
  }
  return {
    albedo: d.tex,
    normal: normalFromHeight(f.height, size, normalStrength),
    orm: ormFromFields(f.rough, size, metal),
    albedoGain: d.gain,
    worldSize,
  };
}

// --- surfaces ---------------------------------------------------------------

/**
 * *Opus testaceum*, the brick face of the Aurelian Wall.
 *
 * Course pitch 55 mm (40 mm of brick over a 15 mm lime bed), 290 mm of exposed face,
 * half-lap stretcher bond. 32 courses wrap the tile at 1.76 m. One course in eight is
 * a bonding course of pale *bipedales*, and at 0.44 m that rhythm is the only part of
 * the bond a besieging camera can still resolve. Bed and perpend get separate widths:
 * one shared figure gave vertical joints three times their real 10 mm.
 */
export function brickFace(size = 1024): GeneratedMaps {
  const courses = 32;
  const world = courses * 0.055;
  const perRow = 6;
  const bondEvery = 8;
  const bondPerRow = 3;
  const f = fields(size, true);
  const texPerM = size / world;
  const coursePx = size / courses;
  const bedPx = 0.016 * texPerM;
  const perpPx = 0.01 * texPerM;

  for (let j = 0; j < size; j++) {
    const v = j / size;
    const row = Math.floor(v * courses);
    const rowF = v * courses - row;
    const bond = row % bondEvery === 0;
    const cols = bond ? bondPerRow : perRow;
    const off = bond ? 0 : row % 2 === 0 ? 0 : 0.5;
    const colPx = size / cols;
    const rowJit = hash2(row, 3, 91) * 0.2 - 0.1;

    for (let i = 0; i < size; i++) {
      const u = i / size;
      const col = Math.floor(u * cols + off);
      const colF = u * cols + off - col;
      const o = j * size + i;
      const o3 = o * 3;

      const dvBottom = rowF * coursePx;
      const dvTop = (1 - rowF) * coursePx;
      const dBed = Math.min(dvBottom, dvTop);
      const dPerp = Math.min(colF, 1 - colF) * colPx;
      // Continuous: a hard in-joint test pitted every brick corner black.
      const joint = Math.max(1 - smoothstep((dBed / bedPx) * 0.8), 1 - smoothstep((dPerp / perpPx) * 0.8));

      const brickN = hash2(col, row, 17);
      const kiln = hash2(col * 7, row * 13, 71);
      // Runs of three courses came from one kiln load; one brick in seven has spalled.
      const load = hash2(3, Math.floor(row / 3), 337);
      const grit = fbm(u * 34, v * 34, 3, 34, 5) * 0.06;
      const chip = ridge(u * 52 + col * 3.1, v * 52 + row * 5.7, 2, 52, 33) * 0.09 * joint;
      const spall = smoothstep((hash2(col * 3 + 1, row * 5 + 2, 613) - 0.86) * 22);
      const repoint = smoothstep((fbm(u * 6, v * 6, 3, 6, 7717) - 0.58) * 6);

      const faceLum =
        (0.5 + brickN * 0.42 + kiln * 0.24 + load * 0.22 + grit * 1.3 - chip * 0.5 + spall * 0.2) * (bond ? 1.06 : 1);
      // A joint authored brighter than the brick cancels the normal map and mips flat.
      const mortarLum = (0.3 + repoint * 0.24) * (dvTop < dvBottom ? 0.84 : 1) + grit * 0.9;
      const proud = 0.66 + brickN * 0.14 + rowJit * 0.5;
      // Bonding tiles held at 1.06: at 1.14 they read as 0.6 m ashlar, not as brick.
      const warm = (brickN * 0.5 + kiln * 0.25 + load * 0.25) * (1 - joint);
      const b = bond ? 0.3 * (1 - joint) : 0;

      f.height[o] = (proud + grit - chip - spall * 0.18) * (1 - joint) + (0.1 + repoint * 0.04) * joint;
      f.lum[o] = faceLum * (1 - joint) + mortarLum * joint;
      f.rough[o] = (0.78 + brickN * 0.1 + spall * 0.1) * (1 - joint) + 0.94 * joint;
      f.chroma![o3] = 1.0 + warm * 0.19 + b * 0.06 - spall * 0.05 + joint * 0.03;
      f.chroma![o3 + 1] = 1.0 - warm * 0.03 + b * 0.01 + joint * 0.01;
      f.chroma![o3 + 2] = 1.0 - warm * 0.22 - b * 0.1 + spall * 0.06 - joint * 0.04;

      const streak = fbm(u * 7, v * 1.4, 4, 7, 12);
      const damp = smoothstep((fbm(u * 7, v * 4, 4, 7, 9091) - 0.62) * 5);
      f.lum[o] *= (0.88 + streak * 0.26) * (1 - damp * 0.2);
      f.chroma![o3] *= 1 - damp * 0.09;
      f.chroma![o3 + 1] *= 1 + damp * 0.04;
      f.chroma![o3 + 2] *= 1 - damp * 0.03;
      f.rough[o] += damp * 0.05;
    }
  }
  return assemble(f, size, world, 4.6, 0.0);
}

/**
 * Travertine ashlar for footings, podia and gate dressings. Blocks on the
 * Aurelian footing run about 1.2 m by 0.55 m; travertine's signature is its
 * vesicular pitting, which is what sells it up close.
 */
export function travertineAshlar(size = 1024): GeneratedMaps {
  const world = 2.4; // 2 blocks across, ~4.4 courses high
  const cols = 2;
  const rows = 4;
  const f = fields(size, true);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    const row = Math.floor(v * rows);
    const rowF = v * rows - row;
    const off = row % 2 === 0 ? 0 : 0.42;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const col = Math.floor(u * cols + off);
      const colF = u * cols + off - col;
      const o = j * size + i;

      const dv = Math.min(rowF, 1 - rowF) * (size / rows);
      const du = Math.min(colF, 1 - colF) * (size / cols);
      const dJoint = Math.min(dv, du);
      const jointPx = size * 0.008;
      const inJoint = dJoint < jointPx;

      const blockN = hash2(col, row, 401);
      // Vesicular pitting: sparse deep holes plus general granularity.
      const pit = Math.pow(fbm(u * 46, v * 46, 3, 46, 77), 3) * 2.2;
      const grain = fbm(u * 14, v * 14, 4, 14, 5) * 0.1;
      const bedding = Math.sin(v * Math.PI * 2 * 9 + blockN * 6) * 0.015;

      const o3 = o * 3;
      // Weathering: soot and lichen collect on the upper arris of each block.
      const soil = smoothstep((fbm(u * 8, v * 8, 4, 8, 3313) - 0.54) * 5) * (1 - rowF * 0.6);
      f.height[o] = inJoint ? 0.1 : 0.72 + blockN * 0.06 + grain - pit * 0.35 + bedding;
      if (inJoint) {
        f.lum[o] = 0.4 + grain;
        f.rough[o] = 0.95;
      } else {
        f.lum[o] = (0.74 + blockN * 0.1 + grain * 1.5 - pit * 0.3) * (1 - soil * 0.22);
        f.rough[o] = 0.7 + pit * 0.2 + blockN * 0.06;
      }
      // Tivoli travertine runs cream to buff block to block; grime cools it.
      const warm = blockN * 0.6 + hash2(col * 11, row * 3, 227) * 0.4;
      f.chroma![o3] = 1.0 + warm * 0.1 - soil * 0.06;
      f.chroma![o3 + 1] = 1.0 + warm * 0.01;
      f.chroma![o3 + 2] = 1.0 - warm * 0.12 + soil * 0.07;
    }
  }
  return assemble(f, size, world, 2.2, 0.0);
}

/**
 * Terracotta roof tiling: flat *tegulae* about 0.45 m wide with semicircular
 * *imbrices* covering every joint. Texture covers 0.9 m across (two pans) and
 * 1.2 m up the slope (two tile laps).
 */
export function roofTiles(size = 512): GeneratedMaps {
  const world = 0.9;
  const pans = 2;
  const laps = 2;
  const f = fields(size, true);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    const lap = Math.floor(v * laps);
    const lapF = v * laps - lap;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const pan = Math.floor(u * pans);
      const panF = u * pans - pan;
      const o = j * size + i;

      // Imbrex: half-round cover tile sitting over the pan boundary.
      const dCover = Math.min(panF, 1 - panF);
      const coverW = 0.17;
      const inCover = dCover < coverW;
      const tileN = hash2(pan, lap, 907);
      const grain = fbm(u * 30, v * 30, 3, 30, 21) * 0.09;

      let h: number;
      let lum: number;
      if (inCover) {
        const t = dCover / coverW; // 0 at the ridge line, 1 at the pan
        h = 0.62 + Math.cos(t * Math.PI * 0.5) * 0.34;
        lum = 0.6 + Math.cos(t * Math.PI * 0.5) * 0.24 + tileN * 0.08;
      } else {
        // Slight dish across the pan, and a step at each tile lap.
        const dish = Math.sin((dCover - coverW) / (0.5 - coverW) * Math.PI) * 0.05;
        h = 0.44 - dish + (lapF < 0.06 ? 0.12 : 0);
        lum = 0.44 + tileN * 0.1 - dish * 1.2;
      }
      // Weathering: lichen and soot pool along the laps.
      const moss = Math.pow(fbm(u * 9 + 3, v * 9, 4, 9, 55), 2.2);
      const o3 = o * 3;
      f.height[o] = h + grain;
      f.lum[o] = lum * (0.82 + grain * 2) * (1 - moss * 0.4);
      f.rough[o] = 0.72 + moss * 0.18 + grain;
      // Tile to tile the clay fires bright orange to dark brown, and moss is green.
      const fire = tileN * 0.7 + hash2(pan * 13, lap * 5, 419) * 0.3;
      f.chroma![o3] = 1.0 + fire * 0.2 - moss * 0.16;
      f.chroma![o3 + 1] = 1.0 - fire * 0.04 + moss * 0.06;
      f.chroma![o3 + 2] = 1.0 - fire * 0.22 - moss * 0.02;
    }
  }
  return assemble(f, size, world, 3.0, 0.0);
}

/**
 * Painted lime stucco. Roman street façades were rendered and painted, and the
 * detail that matters at distance is the patchy loss of render exposing the
 * rubble core beneath — that is what stops a wall reading as a flat polygon.
 */
export function paintedStucco(size = 512): GeneratedMaps {
  const world = 3.0;
  const f = fields(size, true);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const o = j * size + i;
      const o3 = o * 3;
      const base = fbm(u * 6, v * 6, 5, 6, 3);
      const trowel = fbm(u * 22, v * 18, 3, 22, 8);
      // Spalled patches where the render has fallen away.
      const spall = smoothstep((fbm(u * 4.5, v * 4.5, 4, 5, 44) - 0.62) * 7);
      const crack = Math.pow(ridge(u * 8, v * 8, 3, 8, 61), 9) * 0.6;
      // Rising damp off the street and a bleached band where the sun hits hardest.
      const damp = smoothstep((0.24 - v) * 5) * (0.5 + fbm(u * 5, v * 3, 3, 5, 733) * 0.5);
      const bleach = smoothstep((fbm(u * 3.5, v * 3.5, 3, 4, 1979) - 0.5) * 4);
      f.height[o] = 0.75 + trowel * 0.1 - spall * 0.5 - crack * 0.35;
      f.lum[o] =
        (0.82 + base * 0.2 + trowel * 0.08) * (1 - spall * 0.42) * (1 - crack * 0.3) * (1 - damp * 0.28) *
        (1 + bleach * 0.14);
      f.rough[o] = 0.82 + spall * 0.12 + base * 0.06 + damp * 0.06;
      // Spalls show the warm rubble core, damp is slightly cold. Both kept mild: a
      // painted Roman façade is warm, and pushing the damp blue turned every insula grey.
      f.chroma![o3] = 1.0 + spall * 0.13 - damp * 0.05;
      f.chroma![o3 + 1] = 1.0 + spall * 0.03 + bleach * 0.01;
      f.chroma![o3 + 2] = 1.0 - spall * 0.13 + damp * 0.06 + bleach * 0.03;
    }
  }
  return assemble(f, size, world, 1.5, 0.0);
}

/** Sawn oak and fir: scaffolding poles, crane frames, doors, palisade stakes. */
export function timberPlanks(size = 256): GeneratedMaps {
  const world = 1.2;
  const boards = 5; // 0.24 m boards — a common Roman sawn width
  const f = fields(size);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const board = Math.floor(u * boards);
      const bF = u * boards - board;
      const o = j * size + i;
      const bn = hash2(board, 1, 233);
      // Grain runs along the board; knots are localised ring compressions.
      const grain = fbm(u * 60 + bn * 30, v * 5, 4, 60, 3 + board);
      const rings = Math.sin((grain * 6 + v * 2.2 + bn * 9) * Math.PI * 2) * 0.5 + 0.5;
      const knot = Math.pow(fbm(u * 5, v * 7 + bn * 4, 3, 7, 19), 6) * 3;
      const gap = Math.min(bF, 1 - bF) < 0.03;
      f.height[o] = gap ? 0.2 : 0.76 + rings * 0.08 - knot * 0.2;
      f.lum[o] = gap ? 0.22 : (0.6 + bn * 0.16) * (0.78 + rings * 0.3) * (1 - knot * 0.35);
      f.rough[o] = 0.84 + rings * 0.08;
    }
  }
  return assemble(f, size, world, 1.8, 0.0);
}

/** Hammered bronze and wrought iron: portcullis, door bosses, gilded tiles, statues. */
export function hammeredMetal(size = 256): GeneratedMaps {
  const world = 1.0;
  const f = fields(size);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const o = j * size + i;
      const dents = fbm(u * 18, v * 18, 3, 18, 71);
      const pit = Math.pow(fbm(u * 44, v * 44, 2, 44, 13), 4) * 1.8;
      const patina = smoothstep((fbm(u * 7, v * 7, 4, 7, 29) - 0.5) * 4);
      f.height[o] = 0.7 + dents * 0.18 - pit * 0.4;
      f.lum[o] = (0.72 + dents * 0.24) * (1 - pit * 0.4);
      // Corroded patches scatter light; polished metal stays sharp.
      f.rough[o] = 0.22 + patina * 0.5 + pit * 0.3;
    }
  }
  return assemble(f, size, world, 1.6, 0.9);
}

/**
 * Polygonal *silex* paving: interlocking basalt setts about 0.19 m across, cambered
 * so each stone crowns and the joints hold grit. The seam has to be a real fraction of
 * the sett rather than a hairline, or the street mips into one grey sheet and reads as
 * a pattern instead of as stones.
 */
export function basaltPaving(size = 1024): GeneratedMaps {
  const world = 2.3;
  const cells = 12;
  const f = fields(size, true);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const o = j * size + i;
      const o3 = o * 3;
      const gx = Math.floor(u * cells);
      const gy = Math.floor(v * cells);
      let d0 = 9;
      let d1 = 9;
      let id = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cx = (((gx + ox) % cells) + cells) % cells;
          const cy = (((gy + oy) % cells) + cells) % cells;
          const px = (gx + ox + 0.15 + hash2(cx, cy, 5) * 0.7) / cells;
          const py = (gy + oy + 0.15 + hash2(cx, cy, 9) * 0.7) / cells;
          const d = Math.hypot(u - px, v - py);
          if (d < d0) {
            d1 = d0;
            d0 = d;
            id = cx * 31 + cy;
          } else if (d < d1) d1 = d;
        }
      }
      const border = (d1 - d0) * cells;
      const seam = smoothstep(border * 2.2);
      const crown = smoothstep(border * 0.9);
      const sn = hash2(id, 3, 17);
      const tone = hash2(id * 5 + 1, 7, 811);
      const grain = fbm(u * 90, v * 90, 3, 90, 41) * 0.09;
      const wear = fbm(u * 11, v * 11, 4, 11, 4409);

      f.height[o] = 0.1 + seam * 0.5 + crown * 0.28 + grain - sn * 0.05;
      f.lum[o] = (0.34 + sn * 0.3 + tone * 0.16) * (0.4 + seam * 0.72) + grain + wear * 0.06;
      // Cart wheels polish the crowns; joint grit stays matt.
      f.rough[o] = 0.52 + (1 - crown) * 0.34 + grain * 2 + wear * 0.1;
      // Setts were quarried from several flows, so they run blue-grey to warm tan.
      const warm = tone * 0.8 + sn * 0.2;
      f.chroma![o3] = 1.0 + warm * 0.16 - (1 - seam) * 0.03;
      f.chroma![o3 + 1] = 1.0 + warm * 0.02;
      f.chroma![o3 + 2] = 1.0 - warm * 0.17 + (1 - seam) * 0.04;
    }
  }
  return assemble(f, size, world, 3.0, 0.0);
}

/**
 * Luna marble for temple orders, revetment and statuary: sugary crystal ground with
 * grey veins swept along a bedding direction, plus faint 1.2 m slab joints so a large
 * revetted face does not read as one plane.
 */
export function marbleVeined(size = 1024): GeneratedMaps {
  const world = 2.4;
  const slabs = 2;
  const f = fields(size, true);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const o = j * size + i;
      const o3 = o * 3;
      const warp = fbm(u * 3, v * 3, 4, 3, 5501) - 0.5;
      const vein = Math.pow(ridge(u * 5 + warp * 2.4, v * 2.6 + warp * 1.1, 4, 5, 173), 5.5);
      const hair = Math.pow(ridge(u * 17 + warp * 4, v * 9, 3, 17, 977), 9) * 0.7;
      const sugar = fbm(u * 120, v * 120, 2, 120, 61) * 0.1;
      const cloud = fbm(u * 6, v * 6, 4, 6, 1451);
      const dj = Math.min(
        Math.min(u * slabs - Math.floor(u * slabs), 1 - (u * slabs - Math.floor(u * slabs))),
        Math.min(v * slabs - Math.floor(v * slabs), 1 - (v * slabs - Math.floor(v * slabs)))
      );
      const joint = smoothstep((dj - 0.004) * 260);

      f.height[o] = 0.82 - (1 - joint) * 0.5 + sugar - vein * 0.05;
      f.lum[o] = (0.94 + cloud * 0.1 + sugar) * (1 - vein * 0.42 - hair * 0.3) * (0.55 + joint * 0.45);
      f.rough[o] = 0.38 + vein * 0.2 + sugar * 2 + (1 - joint) * 0.4;
      // Veins are grey to blue-grey against a faintly warm ground.
      const g = vein * 0.7 + hair * 0.3;
      f.chroma![o3] = 1.0 + cloud * 0.05 - g * 0.09;
      f.chroma![o3 + 1] = 1.0 - g * 0.01;
      f.chroma![o3 + 2] = 1.0 - cloud * 0.05 + g * 0.13;
    }
  }
  return assemble(f, size, world, 1.4, 0.0);
}

/**
 * Grey Mons Claudianus granite, the stone of the monolithic column shafts and the
 * obelisk bases. Feldspar and quartz grains a few millimetres across on a darker
 * ground, so the tile covers only 0.6 m; polished shafts, hence the low roughness.
 */
export function graniteSpeckled(size = 512): GeneratedMaps {
  const world = 0.6;
  const f = fields(size, true);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const o = j * size + i;
      const o3 = o * 3;
      const feld = smoothstep((fbm(u * 46, v * 46, 2, 46, 331) - 0.52) * 8);
      const quartz = smoothstep((fbm(u * 78, v * 78, 2, 78, 1187) - 0.66) * 14);
      const mica = smoothstep((fbm(u * 96, v * 96, 2, 96, 2749) - 0.72) * 16);
      const fine = fbm(u * 180, v * 180, 2, 180, 17) * 0.12;
      const blotch = fbm(u * 5, v * 5, 3, 5, 6151);

      f.height[o] = 0.7 + feld * 0.1 + quartz * 0.06 - mica * 0.12 + fine;
      f.lum[o] = (0.5 + feld * 0.42 + quartz * 0.5 - mica * 0.34) * (0.9 + blotch * 0.2) + fine;
      f.rough[o] = 0.3 + mica * 0.14 + fine * 1.5;
      // Feldspar is pink, quartz near-neutral, mica cold.
      f.chroma![o3] = 1.0 + feld * 0.1 - mica * 0.04;
      f.chroma![o3 + 1] = 1.0 - feld * 0.02;
      f.chroma![o3 + 2] = 1.0 - feld * 0.08 + mica * 0.09;
    }
  }
  return assemble(f, size, world, 1.2, 0.0);
}

/** Foliage canopy: cypress and pine needles, and vine leaves on pergolas. */
export function foliageCanopy(size = 128): GeneratedMaps {
  const world = 1.4;
  const f = fields(size);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const o = j * size + i;
      const clump = fbm(u * 9, v * 9, 4, 9, 3);
      const needle = fbm(u * 40, v * 12, 2, 40, 88);
      f.height[o] = 0.5 + clump * 0.4 + needle * 0.14;
      f.lum[o] = 0.4 + clump * 0.5 + needle * 0.2;
      f.rough[o] = 0.86 + clump * 0.08;
    }
  }
  return assemble(f, size, world, 2.0, 0.0);
}

/** Rubble concrete core (*opus caementicium*) — exposed in the unfinished courses. */
export function rubbleConcrete(size = 256): GeneratedMaps {
  const world = 2.0;
  const f = fields(size);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const o = j * size + i;
      // Aggregate: broken tufa and tile lumps set in lime mortar.
      const lump = fbm(u * 16, v * 16, 3, 16, 601);
      const stone = smoothstep((lump - 0.52) * 8);
      const fine = fbm(u * 48, v * 48, 3, 48, 17) * 0.12;
      const sn = fbm(u * 16 + 0.5, v * 16 + 0.5, 1, 16, 909);
      f.height[o] = 0.4 + stone * 0.4 + fine;
      f.lum[o] = (0.6 + sn * 0.35) * (0.7 + stone * 0.4) + fine;
      f.rough[o] = 0.9 - stone * 0.08 + fine;
    }
  }
  return assemble(f, size, world, 2.6, 0.0);
}
