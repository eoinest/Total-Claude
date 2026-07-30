import * as THREE from 'three';
import { clamp01, smoothstep } from '../util/math';
import { hash2 } from '../util/rand';

/**
 * Procedural texture generation for the city's PBR materials.
 *
 * Everything here is deterministic (`hash2` only, never `Math.random()`) and runs
 * without any files on disk, so the city still renders with an empty
 * `public/assets/`. When the manifest *is* present, `materials.ts` swaps the
 * procedural normal/roughness for the photographed ones and keeps only the
 * albedo-detail channel procedural — the palette must stay under our control
 * because Roman buildings were painted, and a photo of grey stone fights that.
 *
 * All generators emit tileable maps: the lattice noise wraps on `period`, and the
 * brick / tile / plank layouts are laid out so an integer number of units fits the
 * texture. The world size each texture covers is returned in `worldSize` so the
 * geometry builder can set UV repeats in metres rather than guessing.
 */

export interface GeneratedMaps {
  /** Albedo *detail* — mean-normalised luminance, multiplied by vertex colour. */
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

/** Sharp ridged noise — good for cracks and chipped stone edges. */
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
  t.anisotropy = 8;
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

/**
 * Turn a linear-space luminance field into an albedo detail map whose mean is
 * pushed to a known value, and report the gain the material must apply so the
 * product `map * color` lands on the intended albedo.
 */
export function detailFromField(field: Float32Array, size: number): { tex: THREE.DataTexture; gain: number } {
  let mean = 0;
  for (let i = 0; i < field.length; i++) mean += field[i];
  mean /= field.length;
  if (mean < 1e-4) mean = 1e-4;

  // Scale so the brightest texel just reaches 1.0 — no clipping, maximum contrast.
  let max = 0;
  for (let i = 0; i < field.length; i++) if (field[i] > max) max = field[i];
  const scale = max > 1e-4 ? 1 / max : 1;

  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < field.length; i++) {
    const b = toSrgbByte(field[i] * scale);
    const o = i * 4;
    out[o] = b;
    out[o + 1] = b;
    out[o + 2] = b;
    out[o + 3] = 255;
  }
  return { tex: makeTexture(out, size, true), gain: 1 / (mean * scale) };
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
}

function fields(size: number): FieldSet {
  const n = size * size;
  return { height: new Float32Array(n), lum: new Float32Array(n), rough: new Float32Array(n) };
}

function assemble(f: FieldSet, size: number, worldSize: number, normalStrength: number, metal: number): GeneratedMaps {
  const d = detailFromField(f.lum, size);
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
 * *Opus testaceum* — the brick face of the Aurelian Wall.
 *
 * Roman wall bricks of this date are *bessales* cut into triangles, laid with a
 * finished course pitch of about 55 mm (roughly 40 mm of brick to 15 mm of mortar)
 * and about 200 mm of exposed face length. The texture covers 1.10 m so exactly
 * 20 courses and 5 stretchers fit, which keeps it seamless when tiled per metre.
 */
export function brickFace(size = 512): GeneratedMaps {
  const world = 1.1;
  const courses = 20; // 1.10 m / 0.055 m
  const perRow = 5; // 1.10 m / 0.22 m
  const f = fields(size);
  const mortarPx = size / courses * 0.28; // ~15 mm of the 55 mm pitch
  for (let j = 0; j < size; j++) {
    const v = j / size;
    const row = Math.floor(v * courses);
    const rowF = v * courses - row;
    // Alternate courses offset half a brick, as in every Roman brick face.
    const off = row % 2 === 0 ? 0 : 0.5;
    const rowJit = hash2(row, 3, 91) * 0.22 - 0.11;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const col = Math.floor(u * perRow + off);
      const colF = (u * perRow + off) - col;
      const o = j * size + i;

      // Distance from the nearest joint in texels, on both axes.
      const dvBottom = rowF * (size / courses);
      const dvTop = (1 - rowF) * (size / courses);
      const duLeft = colF * (size / perRow);
      const duRight = (1 - colF) * (size / perRow);
      const dJoint = Math.min(dvBottom, dvTop, duLeft, duRight);
      const inMortar = dJoint < mortarPx;

      const brickN = hash2(col, row, 17);
      // Faces are hand-laid: each brick sits a fraction of a millimetre proud.
      const proud = 0.62 + brickN * 0.16 + rowJit * 0.5;
      const grit = fbm(u * 26, v * 26, 3, 26, 5) * 0.06;
      // Chipped arrises: erode the height near the brick edge.
      const edge = smoothstep((dJoint - mortarPx) / (size / courses * 0.22));
      const chip = ridge(u * 40 + col * 3.1, v * 40 + row * 5.7, 2, 40, 33) * 0.12 * (1 - edge);

      f.height[o] = inMortar ? 0.16 + grit * 0.5 : proud * edge + 0.2 * (1 - edge) + grit - chip;

      if (inMortar) {
        // Lime mortar reads pale and slightly greenish-grey; keep it brighter than brick.
        f.lum[o] = 0.72 + grit * 2.5;
        f.rough[o] = 0.94;
      } else {
        // Brick luminance varies course to course — kilns were uneven.
        const kiln = hash2(col * 7, row * 13, 71);
        f.lum[o] = 0.44 + brickN * 0.16 + kiln * 0.1 + grit * 1.6 - chip * 0.5;
        f.rough[o] = 0.78 + brickN * 0.1;
      }
      // Salt efflorescence and rain streaks running down the face.
      const streak = fbm(u * 7, v * 1.4, 4, 7, 12);
      f.lum[o] *= 0.86 + streak * 0.28;
    }
  }
  return assemble(f, size, world, 2.6, 0.0);
}

/**
 * Travertine ashlar for footings, podia and gate dressings. Blocks on the
 * Aurelian footing run about 1.2 m by 0.55 m; travertine's signature is its
 * vesicular pitting, which is what sells it up close.
 */
export function travertineAshlar(size = 512): GeneratedMaps {
  const world = 2.4; // 2 blocks across, ~4.4 courses high
  const cols = 2;
  const rows = 4;
  const f = fields(size);
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

      f.height[o] = inJoint ? 0.1 : 0.72 + blockN * 0.06 + grain - pit * 0.35 + bedding;
      if (inJoint) {
        f.lum[o] = 0.4 + grain;
        f.rough[o] = 0.95;
      } else {
        f.lum[o] = 0.74 + blockN * 0.1 + grain * 1.5 - pit * 0.3;
        f.rough[o] = 0.7 + pit * 0.2 + blockN * 0.06;
      }
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
  const f = fields(size);
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
      f.height[o] = h + grain;
      f.lum[o] = lum * (0.82 + grain * 2) * (1 - moss * 0.4);
      f.rough[o] = 0.72 + moss * 0.18 + grain;
    }
  }
  return assemble(f, size, world, 3.0, 0.0);
}

/**
 * Painted lime stucco. Roman street façades were rendered and painted, and the
 * detail that matters at distance is the patchy loss of render exposing the
 * rubble core beneath — that is what stops a wall reading as a flat polygon.
 */
export function paintedStucco(size = 256): GeneratedMaps {
  const world = 3.0;
  const f = fields(size);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const o = j * size + i;
      const base = fbm(u * 6, v * 6, 5, 6, 3);
      const trowel = fbm(u * 22, v * 18, 3, 22, 8);
      // Spalled patches where the render has fallen away.
      const spall = smoothstep((fbm(u * 4.5, v * 4.5, 4, 5, 44) - 0.62) * 7);
      const crack = Math.pow(ridge(u * 8, v * 8, 3, 8, 61), 9) * 0.6;
      f.height[o] = 0.75 + trowel * 0.1 - spall * 0.5 - crack * 0.35;
      f.lum[o] = (0.82 + base * 0.2 + trowel * 0.08) * (1 - spall * 0.42) * (1 - crack * 0.3);
      f.rough[o] = 0.82 + spall * 0.12 + base * 0.06;
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
 * Polygonal basalt paving (*silex*) as used on the Via Flaminia and the major
 * urban streets — irregular interlocking setts about 0.3 m across, not cobbles.
 */
export function basaltPaving(size = 256): GeneratedMaps {
  const world = 3.0;
  const cells = 10; // ~0.3 m setts
  const f = fields(size);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const o = j * size + i;
      // Worley-ish: nearest of 9 jittered lattice sites gives polygonal cells.
      const gx = Math.floor(u * cells);
      const gy = Math.floor(v * cells);
      let d0 = 9;
      let d1 = 9;
      let id = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cx = ((gx + ox) % cells + cells) % cells;
          const cy = ((gy + oy) % cells + cells) % cells;
          const px = (gx + ox + hash2(cx, cy, 5)) / cells;
          const py = (gy + oy + hash2(cx, cy, 9)) / cells;
          const d = Math.hypot(u - px, v - py);
          if (d < d0) {
            d1 = d0;
            d0 = d;
            id = cx * 31 + cy;
          } else if (d < d1) d1 = d;
        }
      }
      const seam = smoothstep((d1 - d0) * cells * 3.2);
      const sn = hash2(id, 3, 17);
      const wear = fbm(u * 20, v * 20, 3, 20, 41) * 0.08;
      f.height[o] = 0.25 + seam * 0.6 + wear - sn * 0.05;
      // Basalt is near-black; cart wheels polish ruts into it.
      f.lum[o] = (0.3 + sn * 0.18) * (0.55 + seam * 0.6) + wear;
      f.rough[o] = 0.58 + wear * 2 + (1 - seam) * 0.25;
    }
  }
  return assemble(f, size, world, 2.4, 0.0);
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
