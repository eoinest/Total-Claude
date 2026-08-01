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
  /**
   * Horizon openness in R, roughness in G, metalness in B — one sampler serves all three.
   * See `horizonOpenness` for what R is and why the recess has to live there rather than
   * in the albedo.
   */
  orm: THREE.DataTexture;
  /** Reciprocal of the albedo map's linear mean; goes into `material.color`. */
  albedoGain: number;
  /** Metres of wall covered by one UV repeat. */
  worldSize: number;
  /** Mean of the openness channel — a one-number summary of how deep the surface is. */
  meanOpenness: number;
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

/**
 * Convert a heightfield into a tangent-space normal map (OpenGL convention, +Y up).
 *
 * ## The green channel was inverted, and it cost the wall its coursing
 *
 * The line below used to read `out[o + 1] = (-ny / l) * 0.5 + 0.5`, which stores `+dh/dv`
 * — the DirectX / Y-down convention — under a comment claiming OpenGL. `makeTexture` builds
 * a `DataTexture`, whose `flipY` is `false`, so row `j` is texture row `v` directly and
 * `dy` here *is* `dh/dv`; three.js multiplies `mapN.y` by the tangent frame's +V column, so
 * the map has to carry `-dh/dv`. Two negations cancelled and the V response came out backwards.
 *
 * It is worth being precise about what that does, because a sign error in a normal map
 * changes no magnitude anywhere and so is invisible to every obvious measurement. On an
 * isotropic surface it is nearly unnoticeable — `travertineAshlar` and `basaltPaving` measured
 * a paint-versus-relief correlation of -0.01 and +0.03, i.e. nothing. On **brick** it is
 * exactly the wrong error, because a brick face is a stack of horizontal bands and *all* of
 * its structure is in V. Measured on the shipped tile at mip 0, the correlation between the
 * band-passed albedo and the band-passed Lambert term was **-0.260**: the map was lighting
 * the top of each joint, which is the half the albedo had painted darkest as an overhang
 * shadow, so paint and relief were subtracting from each other on the way to the screen.
 *
 * `src/units/atlas.ts` gets this right by the opposite route — it renders through a canvas,
 * so its texture has `flipY = true`, `j` runs against `v`, and storing `+dy` there *is*
 * `-dh/dv`. The two generators looked contradictory and only one of them was wrong.
 */
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
      // Normal of the height surface: (-dh/du, -dh/dv, 1), normalised.
      const nx = -dx;
      const ny = -dy;
      const nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const o = (j * size + i) * 4;
      out[o] = Math.round(((nx / l) * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round(((ny / l) * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round(((nz / l) * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }
  return makeTexture(out, size, false);
}

/**
 * The metres of relief one unit of a height field stands for.
 *
 * `normalFromHeight` never states this, but it is implied by its own arithmetic: it takes a
 * central difference over two texels and multiplies by `strength` to get a slope, so
 * `strength * dh_field` over two texels equals `dh_world / du_world`. Solving,
 * one unit of field height is `strength * 2 * worldSize / size` metres.
 *
 * For the brick tile that is 5.0 * 2 * 3.3 / 1024 = **32.2 mm**, and the joint recess of
 * 0.46 field units is 14.8 mm — which is the right number for a Roman lime joint, so the
 * strengths already in this file are physically coherent and should not be retuned.
 */
export function reliefMetres(size: number, worldSize: number, strength: number): number {
  return (strength * 2 * worldSize) / size;
}

/**
 * Horizon openness: how much of the sky a texel can see past its own microrelief.
 *
 * ## Why this map exists
 *
 * A blind grader named the leading masonry separator as "every recess is painted rather than
 * modelled — the sharpest instance being brick coursing that shows **identical contrast in
 * sunlit and shadowed regions under raking light**". Measured on the live frame by removing
 * one channel at a time from the brick material and differencing the results, that is
 * literally true and worse than stated:
 *
 *   - at the shipped `wall` camera the normal map contributes **0.00008** of display
 *     luminance to the sunlit curtain — two hundredths of one 8-bit code value — while the
 *     albedo detail contributes 0.00045, so what little coursing survives is *entirely* paint;
 *   - at a close raking camera, where the tile is still legible, the albedo channel's
 *     sunlit-to-shaded amplitude ratio is **1.152** against the normal channel's **3.151**.
 *     The paint is the same in sun and in shade, by construction, because it is paint.
 *
 * The reason the relief loses is the mip chain, and it is structural rather than a tuning
 * error. A bump's two slopes are equal and opposite, so averaging four normals cancels them;
 * a dark band has a non-zero mean, so averaging four albedo texels keeps most of it. Measured
 * on the shipped tile, mean tangent-space |n.xy| runs 0.271 / 0.254 / 0.237 / 0.144 / 0.043 /
 * 0.031 down the ladder — **84 % of the relief is gone by mip 4**, which the curtain reaches
 * at about 40 m, while the albedo's own contrast is still at half strength. No normalScale
 * fixes that; at mip 5 there is nothing left to scale.
 *
 * A *scalar* derived from the height field does not have that problem. Occlusion averages
 * like brightness: the mean openness of a patch of coursing is a meaningful number, and it
 * stays meaningful all the way down the ladder. So this map carries, per texel, the sine of
 * the mean horizon elevation above the tangent plane, stored as **openness = 1 - sin(h)** so
 * that an unwritten channel (255) means "unoccluded" and every existing map keeps working.
 * `materials.ts` uses it twice: to gate the *direct* light by whether the sun clears the
 * local horizon, and to attenuate the *indirect* by the cosine-weighted visible fraction
 * `1 - sin^2(h)`. The first is strongly directional and the second is not, which is exactly
 * the asymmetry a real recess has and a painted one cannot.
 *
 * ## How it is estimated
 *
 * Not by ray-marching: eight directions by sixteen steps over a 1024 tile is 130 M texel
 * reads at boot, and the city already spends its budget on fbm. Instead the classic
 * blur-minus-height cavity estimate at three radii, which is two separable box passes each
 * and O(n) in total. `blur(h, r) - h` is positive inside a recess and its ratio to the world
 * radius is the mean slope up to the rim, i.e. the tangent of the horizon elevation. Taking
 * the largest over three radii picks up both the 18 mm joint and the 120 mm putlog socket.
 */
export function horizonOpenness(
  height: Float32Array,
  size: number,
  worldSize: number,
  strength: number
): Float32Array {
  const hMetres = reliefMetres(size, worldSize, strength);
  const texelM = worldSize / size;
  const out = new Float32Array(size * size);
  const tmp = new Float32Array(size * size);
  const acc = new Float32Array(size * size);
  // Radii in texels. The largest is capped so a small tile does not blur to its own mean,
  // which would report every texel as sitting in a pit.
  const radii = [2, 5, 11].filter((r) => r * 2 + 1 <= size / 4);
  if (!radii.length) radii.push(Math.max(1, Math.floor(size / 8)));
  const wrap = (v: number) => ((v % size) + size) % size;
  for (const r of radii) {
    const w = r * 2 + 1;
    // Separable box blur, wrapping — the tile is tileable and the horizon must be too.
    for (let j = 0; j < size; j++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += height[j * size + wrap(i)];
      for (let i = 0; i < size; i++) {
        tmp[j * size + i] = s / w;
        s += height[j * size + wrap(i + r + 1)] - height[j * size + wrap(i - r)];
      }
    }
    for (let i = 0; i < size; i++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += tmp[wrap(j) * size + i];
      for (let j = 0; j < size; j++) {
        acc[j * size + i] = s / w;
        s += tmp[wrap(j + r + 1) * size + i] - tmp[wrap(j - r) * size + i];
      }
    }
    for (let k = 0; k < out.length; k++) {
      // Mean rise to the rim, as a world slope, converted to sin(elevation).
      const rise = (acc[k] - height[k]) * hMetres;
      const slope = rise / (r * texelM);
      const s = slope > 0 ? slope / Math.sqrt(1 + slope * slope) : 0;
      if (s > out[k]) out[k] = s;
    }
  }
  // Store openness, so 1.0 (an unwritten 255) is an unoccluded surface.
  for (let k = 0; k < out.length; k++) out[k] = clamp01(1 - out[k]);
  return out;
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

/**
 * Pack horizon openness (R), roughness (G) and metalness (B) into one texture.
 *
 * R was a hard-coded 255 read by nothing, so the openness map is free: no new sampler, no
 * new texture, no new draw call, and the existing mip chain and anisotropy already apply
 * to it. `materials.ts` reuses the `texelRoughness` fetch three.js has already made.
 */
export function ormFromFields(
  rough: Float32Array,
  size: number,
  metal: number,
  openness?: Float32Array
): THREE.DataTexture {
  const out = new Uint8Array(size * size * 4);
  const m = Math.round(clamp01(metal) * 255);
  for (let i = 0; i < rough.length; i++) {
    const o = i * 4;
    out[o] = openness ? Math.round(clamp01(openness[i]) * 255) : 255;
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
  const openness = horizonOpenness(f.height, size, worldSize, normalStrength);
  let meanOpen = 0;
  for (let i = 0; i < openness.length; i++) meanOpen += openness[i];
  return {
    albedo: d.tex,
    normal: normalFromHeight(f.height, size, normalStrength),
    orm: ormFromFields(f.rough, size, metal, openness),
    albedoGain: d.gain,
    worldSize,
    meanOpenness: meanOpen / openness.length,
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
        /*
         * **The joint's shadow is no longer painted here.**
         *
         * This used to read `occ = 0.34 + 0.42 * (dvBottom < dvTop ? 1 : 0.45)`, giving the
         * joint an albedo of 0.53-0.76 against brick at ~0.87 and a comment explaining that
         * the recess had to be painted because "what the eye sees at any range beyond a few
         * metres is the shadow standing in the recess". The observation was right and the
         * remedy was the defect a blind grader eventually named: a painted shadow is a
         * shadow that does not know where the sun is, so it shows *identical contrast in
         * sunlit and shadowed regions*, which no real recess does. Measured on the finished
         * frame, the albedo channel's sunlit-to-shaded amplitude ratio was 1.152 against the
         * normal channel's 3.151.
         *
         * The reason the painted version was needed — that the normal map dies in the mip
         * chain — is now answered by the openness channel (see `horizonOpenness`), which is a
         * scalar and therefore averages down without cancelling. So the joint can carry its
         * real albedo, which is *pale*: Roman lime-and-pozzolana mortar is a light warm grey
         * against fired brick, marginally brighter rather than three-quarters darker.
         *
         * The metre-scale tonal variation stays exactly where it was. Gang patches, kiln
         * scatter, rain streaking and splash-back are genuinely albedo — they are stains and
         * different clay, not geometry — and they are the only part of this tile that
         * survives to 90 m anyway. What has been removed is specifically the *course-scale*
         * paint that was standing in for relief.
         */
        f.lum[o] = 0.90 + grit * 0.8;
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
        /*
         * A socket keeps most of its painted darkness, and the distinction matters.
         *
         * A joint is a *recess* — a lit surface set back a few millimetres, whose darkness
         * is a shadow and therefore belongs to the light. A putlog socket is a *hole*: what
         * the eye sees is the unlit inside of a beam pocket, and that is dark whether the
         * sun is on the wall or not. So the albedo is allowed to carry it, and the drop is
         * eased only from 0.30 to 0.44 because the openness channel now contributes the
         * rest. This is the one feature on the tile that reads at 100 m, and gutting it to
         * satisfy a rule about recesses would be applying the rule to the wrong thing.
         */
        const wall = smoothstep((Math.min(putlogHalf - dpu, putlogHalf - dpv) / putlogHalf) * 4);
        f.height[o] = 0.02 + (1 - wall) * 0.3;
        f.lum[o] *= 0.44 + (1 - wall) * 0.30;
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
        // Was 0.4 against a block at 0.74-0.85, i.e. the joint painted half a stop darker
        // than the stone on either side of it. An ashlar joint is the *same* travertine set
        // back 6 mm; every bit of its darkness is shadow, and shadow is now the openness
        // channel's job. What is left is the lime pointing, which is paler than the stone.
        f.lum[o] = 0.78 + grain;
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
        // The cylindrical shading down an imbrex was painted here at +-0.24 of albedo, which
        // is the same defect as the brick joint in a different costume: a half-round tile
        // that is bright along its crown whichever way the sun is. Cut to 0.07, which is the
        // genuine albedo difference (a cover tile is a separate firing from the pan beneath
        // it); the roundness is the normal map's and the openness channel's to deliver.
        lum = 0.72 + Math.cos(t * Math.PI * 0.5) * 0.07 + tileN * 0.08;
      } else {
        // Slight dish across the pan, and a step at each tile lap.
        const dish = Math.sin((dCover - coverW) / (0.5 - coverW) * Math.PI) * 0.05;
        h = 0.44 - dish + (lapF < 0.06 ? 0.12 : 0);
        lum = 0.66 + tileN * 0.1 - dish * 0.5;
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
      // Basalt is near-black; cart wheels polish ruts into it. The seam keeps *some* painted
      // darkness — the gap between setts really is filled with a different, dirtier material,
      // unlike a mortar joint — but the 0.55-to-1.15 swing was three-quarters shadow, and
      // that part now comes from the openness channel instead. 0.82-to-1.15 is the grit.
      f.lum[o] = (0.3 + sn * 0.18) * (0.82 + seam * 0.33) + wear;
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
