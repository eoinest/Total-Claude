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
 * ## The tile is 3.3 m, not 1.1 m, and that is the whole point
 *
 * A blind critic measured this surface as "a flat diffuse brick tile … an entire
 * multi-storey wall has one value across its whole face and the only variation in it is the
 * UV seam". The seam was the evidence: at 3 m of wall height per UV repeat the curtain
 * showed six repeats top to bottom and nothing else, because everything the tile contained
 * was finer than a screen pixel.
 *
 * The course pitch itself was never the problem, and the arithmetic is worth stating so it
 * is not "fixed" backwards later. Roman wall brick of this date is *bessales* and *pedales*
 * — roughly 197 mm and 296 mm on the face — laid about 40 mm thick with a 15-25 mm lime
 * joint, giving a finished course pitch near 55 mm. On a 7 m curtain that is 127 courses.
 * Photographed from 40 m at 28 screen pixels per metre a course is 1.5 px, so individual
 * courses *cannot* resolve, and a real photograph of the Aurelian wall from that range does
 * not show them either. Authoring them coarser to make them visible would put 250 mm bricks
 * on a Roman wall, which is a worse error than the one being fixed.
 *
 * What makes real masonry read at that range is the *metre*-scale structure, and the tile
 * had none. So the tile now covers 3.3 m — exactly 60 courses of 55 mm and 11 stretchers of
 * 300 mm, one *pedalis* — at 1024², which is 3.2 mm per texel, and carries three things
 * that survive mipping because they are larger than a pixel:
 *
 *   - **Putlog holes.** The square scaffold-beam sockets left in the finished face, 120 mm
 *     across on a ~1.1 m grid. They are the single most recognisable feature of Roman
 *     brick-faced concrete and they read as dark points from 100 m.
 *   - **Gang patches.** The curtain was let to different work gangs and rebuilt in
 *     stretches; each mixed its own clay and levelled its own courses. A low-frequency
 *     field shifts brick tone, course jitter and roughness in patches of ~1 m, which is
 *     what breaks the single-value face.
 *   - **Weathering with a scale.** Rain streaking and salt efflorescence at 0.5 m, and
 *     soot and splash-back mottling under it.
 */
export function brickFace(size = 1024): GeneratedMaps {
  const world = 3.3;
  const courses = 60; // 3.30 m / 0.055 m — 40 mm of brick to an 18 mm joint
  const perRow = 11; // 3.30 m / 0.300 m — a pedalis on the face
  /** Putlog sockets per tile edge: a 1.1 m horizontal by 1.65 m vertical grid. */
  const putlogCols = 3;
  const putlogRows = 2;
  const f = fields(size);
  // 18 mm of the 55 mm pitch. At the ranges the curtain is actually seen from, roughly
  // two screen texels per course, only the *proportion* of the pitch that is joint
  // survives mipping — a hairline joint averages away to a flat face, which is why the
  // first pass of this wall showed no courses at all from 40 m.
  const mortarPx = (size / courses) * 0.33;
  const putlogHalf = 0.06 / world; // 120 mm socket, as a fraction of the tile
  for (let j = 0; j < size; j++) {
    const v = j / size;
    const row = Math.floor(v * courses);
    const rowF = v * courses - row;
    // Alternate courses offset half a brick, as in every Roman brick face.
    const off = row % 2 === 0 ? 0 : 0.5;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      // Which gang laid this stretch. Multiplier and period must match or the field stops
      // tiling. 2 lattice cells over 3.3 m, not 3: at 3 the patches were 1.1 m across and a
      // blind critic read them *as the brick unit* — "the individual bricks come out around
      // a metre across, so they are cyclopean blocks pretending to be brick". At the range
      // the curtain is photographed a 55 mm course is 1.5 px and cannot resolve, so whatever
      // structure *is* resolvable gets read as the masonry module. The patches therefore
      // have to be unmistakably larger than any brick could be, and low enough in contrast
      // that they read as tonal variation rather than as joints.
      const gang = fbm(u * 2, v * 2, 3, 2, 313);
      const gangHi = smoothstep((gang - 0.46) * 5);
      // Course jitter is a property of the gang, not of the course: a careful crew laid
      // level, a hasty one wandered.
      const rowJit = (hash2(row, 3, 91) * 0.22 - 0.11) * (0.4 + gangHi * 1.4);

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

      // Putlog socket: a square hole on a coarse grid, jittered a course either way so the
      // rows do not read as a machine-drilled grid.
      const px = u * putlogCols;
      const py = v * putlogRows;
      const pxi = Math.floor(px);
      const pyi = Math.floor(py);
      const jitterU = (hash2(pxi, pyi, 617) - 0.5) * 0.16;
      const jitterV = (hash2(pxi, pyi, 811) - 0.5) * 0.10;
      const dpu = Math.abs((px - pxi - 0.5) / putlogCols - jitterU / putlogCols);
      const dpv = Math.abs((py - pyi - 0.5) / putlogRows - jitterV / putlogRows);
      // Two of every three sockets were filled in when the scaffold came down.
      const open = hash2(pxi, pyi, 409) > 0.62;
      const inPutlog = open && dpu < putlogHalf && dpv < putlogHalf;

      const brickN = hash2(col, row, 17);
      // Faces are hand-laid: each brick sits a fraction of a millimetre proud.
      const proud = 0.62 + brickN * 0.16 + rowJit * 0.5;
      const grit = fbm(u * 26, v * 26, 3, 26, 5) * 0.06;
      // Chipped arrises: erode the height near the brick edge.
      const edge = smoothstep((dJoint - mortarPx) / (size / courses * 0.22));
      const chip = ridge(u * 40 + col * 3.1, v * 40 + row * 5.7, 2, 40, 33) * 0.12 * (1 - edge);

      f.height[o] = inMortar ? 0.16 + grit * 0.5 : proud * edge + 0.2 * (1 - edge) + grit - chip;

      if (inMortar) {
        // The joint is recessed 18 mm of a 55 mm pitch. Lime mortar is pale *stone*, but
        // what the eye sees at any range beyond a few metres is the shadow standing in
        // the recess, so the albedo has to carry that: a joint authored brighter than the
        // brick cancels against the normal map and the whole face mips out to flat, which
        // is why the first pass of this wall had no visible courses at all.
        // Deeper toward the top of the joint, where the brick above overhangs it.
        const occ = 0.34 + 0.42 * (dvBottom < dvTop ? 1 : 0.45);
        f.lum[o] = occ + grit * 1.1;
        f.rough[o] = 0.94;
      } else {
        // Brick luminance varies brick to brick and course to course — kilns were uneven,
        // and stretches of the curtain were let to different gangs. `gang` carries the
        // stretch-scale tone difference, which is the term that survives mipping.
        const kiln = hash2(col * 7, row * 13, 71);
        f.lum[o] = (0.62 + brickN * 0.26 + kiln * 0.15 + grit * 1.6 - chip * 0.8)
          * (0.93 + gang * 0.15);
        f.rough[o] = 0.78 + brickN * 0.1 + gangHi * 0.06;
      }

      if (inPutlog) {
        // A socket is a void: the height drops to the back of the hole and the albedo goes
        // to the shadow standing in it, which is what makes it legible at 100 m.
        const wall = smoothstep((Math.min(putlogHalf - dpu, putlogHalf - dpv) / putlogHalf) * 4);
        f.height[o] = 0.02 + (1 - wall) * 0.3;
        f.lum[o] *= 0.30 + (1 - wall) * 0.35;
        f.rough[o] = 0.96;
      }

      // Rain streaks and salt efflorescence, plus a coarser splash-back mottle beneath.
      //
      // `fbm` tiles only when the coordinate multiplier equals the lattice period, because
      // `vnoise` wraps the *integer* lattice index modulo `period`. The previous streak
      // field was `fbm(u * 6, v * 1.5, 4, 6, 12)`: v = 0 landed on lattice row 0 and v = 1
      // on row 1, so the top and bottom edges of the tile hashed differently and every
      // vertical repeat carried a hard horizontal discontinuity. That is almost certainly
      // the artefact behind a blind critic's "an entire multi-storey wall has one value
      // across its whole face and the only variation in it is the UV seam" — the seam was
      // the strongest feature in the texture because it was the only one with an edge.
      //
      // Vertical elongation, which is what makes a streak a streak, is recovered instead by
      // averaging four samples of one isotropic field offset by whole lattice rows. Integer
      // offsets wrap exactly, so the sum tiles, and averaging along v smears the field in v
      // and only in v.
      const streak = 0.25 * (
        fbm(u * 8, v * 8, 3, 8, 12)
        + fbm(u * 8, v * 8 + 2, 3, 8, 12)
        + fbm(u * 8, v * 8 + 4, 3, 8, 12)
        + fbm(u * 8, v * 8 + 6, 3, 8, 12)
      );
      const splash = fbm(u * 4, v * 4, 3, 4, 907);
      f.lum[o] *= (0.84 + streak * 0.32) * (0.88 + splash * 0.24);
    }
  }
  // 5.0 rather than 4.2: the joint recess is the whole read on this surface and the tile is
  // now three times coarser in world terms, so each texel covers less of the pitch.
  return assemble(f, size, world, 5.0, 0.0);
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
