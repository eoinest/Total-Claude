import { tileFbm, tileRidged } from './noise';

/**
 * Procedural substitutes for the ground layers.
 *
 * The game has to run and still look like a place with an empty `public/assets/` folder,
 * so every splat layer has a synthesised version here. Two of them (compacted earth and
 * natural limestone) are used even when the asset pack is present, because the pack has
 * no equivalent — its "limestone" is dressed masonry, which would be absurd on a cliff.
 *
 * Everything is generated on a wrapping lattice so it tiles, and at half the final
 * resolution — the array texture upsamples it, which costs nothing visually once the
 * detail normal and macro variation are on top, and saves three quarters of the CPU.
 */

export type LayerKind =
  | 'dryGrass'
  | 'meadowGrass'
  | 'compactedEarth'
  | 'mud'
  | 'gravel'
  | 'limestone'
  | 'sand'
  | 'cobbles';

export interface ProcLayer {
  /** RGB albedo, A = surface height for height-blending. */
  albedo: Uint8Array;
  size: number;
  /** RG = normal xy, B = roughness, A = ambient occlusion. */
  nrm: Uint8Array;
  nrmSize: number;
}

const SIZE = 512;
const NRM = 512;

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const sat = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** sRGB-ish colour triples, authored by eye against Roman campagna reference. */
const PALETTE: Record<LayerKind, [number, number, number][]> = {
  // Sun-bleached summer grass: straw over a little surviving green.
  dryGrass: [
    [104, 96, 62],
    [156, 145, 96],
    [188, 178, 130],
    [86, 92, 56],
  ],
  meadowGrass: [
    [62, 74, 42],
    [92, 108, 58],
    [124, 136, 76],
    [70, 84, 46],
  ],
  compactedEarth: [
    [88, 72, 52],
    [126, 106, 78],
    [158, 138, 108],
    [102, 86, 64],
  ],
  mud: [
    [52, 42, 31],
    [78, 63, 46],
    [102, 84, 62],
    [44, 37, 28],
  ],
  gravel: [
    [96, 90, 80],
    [134, 127, 113],
    [172, 165, 150],
    [80, 76, 68],
  ],
  limestone: [
    [122, 119, 106],
    [166, 162, 148],
    [204, 200, 186],
    [98, 95, 86],
  ],
  sand: [
    [150, 134, 106],
    [186, 170, 138],
    [212, 198, 168],
    [134, 120, 96],
  ],
  cobbles: [
    [78, 76, 72],
    [112, 109, 102],
    [146, 142, 132],
    [92, 88, 80],
  ],
};

/**
 * Per-kind height field in [0, 1]. This drives the normal map, the AO, the roughness
 * and — crucially — the alpha channel the splat shader height-blends with.
 */
function layerHeight(kind: LayerKind, u: number, v: number, seed: number): number {
  switch (kind) {
    case 'dryGrass':
    case 'meadowGrass': {
      // Streaks stretched along one axis read as lying blades; the low octave is the
      // clumping of tussocks.
      const blades = tileFbm(u, v, 4, 48, seed, 0.55, 0.22) * 0.5 + 0.5;
      const tussock = tileFbm(u, v, 3, 6, seed + 17) * 0.5 + 0.5;
      return sat(blades * 0.62 + tussock * 0.38);
    }
    case 'compactedEarth': {
      const base = tileFbm(u, v, 5, 7, seed) * 0.5 + 0.5;
      // Small stones pressed into the surface by traffic.
      const pebbles = Math.max(0, tileRidged(u, v, 2, 54, seed + 31) - 0.62) * 2.6;
      return sat(base * 0.72 + pebbles * 0.42);
    }
    case 'mud': {
      const base = tileFbm(u, v, 5, 5, seed) * 0.5 + 0.5;
      // Dried polygonal cracking: ridged noise inverted and thresholded.
      const crack = sat((tileRidged(u, v, 2, 13, seed + 41) - 0.74) * 5.5);
      return sat(base * 0.8 - crack * 0.55 + 0.2);
    }
    case 'gravel': {
      const stones = tileRidged(u, v, 3, 34, seed + 51);
      const bed = tileFbm(u, v, 3, 9, seed + 52) * 0.5 + 0.5;
      return sat(stones * 0.75 + bed * 0.3);
    }
    case 'limestone': {
      // Bedding planes plus jointing: a stretched low octave crossed with sharp ridges.
      const bedding = tileFbm(u, v, 3, 5, seed + 61, 0.5, 3.4) * 0.5 + 0.5;
      const joints = sat((tileRidged(u, v, 3, 11, seed + 62) - 0.6) * 3.0);
      const grain = tileFbm(u, v, 4, 40, seed + 63) * 0.5 + 0.5;
      return sat(bedding * 0.55 + grain * 0.3 - joints * 0.45 + 0.2);
    }
    case 'sand': {
      // Wind and current ripples: a strongly stretched mid octave.
      const ripple = tileFbm(u, v, 3, 26, seed + 71, 0.5, 0.14) * 0.5 + 0.5;
      const drift = tileFbm(u, v, 3, 7, seed + 72) * 0.5 + 0.5;
      return sat(ripple * 0.55 + drift * 0.5);
    }
    case 'cobbles': {
      // Roman silex paving: irregular polygonal blocks with deep joints. A jittered
      // lattice of cells, each raised, with the joint carved between them.
      const cells = 9;
      const cu = u * cells;
      const cv = v * cells;
      const iu = Math.floor(cu);
      const iv = Math.floor(cv);
      let best = 4;
      let second = 4;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const gx = ((iu + dx) % cells + cells) % cells;
          const gy = ((iv + dy) % cells + cells) % cells;
          const jx = pgnoiseCell(gx, gy, seed + 81);
          const jy = pgnoiseCell(gx, gy, seed + 82);
          const px = iu + dx + 0.5 + jx * 0.36;
          const py = iv + dy + 0.5 + jy * 0.36;
          const d = Math.hypot(cu - px, cv - py);
          if (d < best) {
            second = best;
            best = d;
          } else if (d < second) second = d;
        }
      }
      const joint = sat((second - best) * 3.4);
      const face = tileFbm(u, v, 3, 40, seed + 83) * 0.5 + 0.5;
      return sat(joint * 0.82 + face * 0.22);
    }
  }
}

/** Deterministic per-cell jitter in [-1, 1] for the cobble lattice. */
function pgnoiseCell(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(seed, 0xcb1ab31f)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  h ^= h >>> 15;
  return ((h >>> 0) / 2147483648 - 1);
}

/** Extra colour breakup on top of the height ramp, so albedo is not a grey-scale tint. */
function layerTint(kind: LayerKind, u: number, v: number, seed: number): number {
  switch (kind) {
    case 'dryGrass':
      return tileFbm(u, v, 3, 4, seed + 101) * 0.5 + 0.5;
    case 'meadowGrass':
      return tileFbm(u, v, 3, 5, seed + 102) * 0.5 + 0.5;
    case 'limestone':
      return tileFbm(u, v, 2, 3, seed + 103) * 0.5 + 0.5;
    default:
      return tileFbm(u, v, 3, 6, seed + 104) * 0.5 + 0.5;
  }
}

export function generateLayer(kind: LayerKind, seed = 1): ProcLayer {
  const albedo = new Uint8Array(SIZE * SIZE * 4);
  const height = new Float32Array(SIZE * SIZE);
  const pal = PALETTE[kind];

  for (let y = 0; y < SIZE; y++) {
    const v = y / SIZE;
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const i = y * SIZE + x;
      const h = layerHeight(kind, u, v, seed);
      height[i] = h;
      const t = layerTint(kind, u, v, seed);

      // Three-stop ramp on height, then pushed toward the fourth (shadow) colour by
      // the independent tint field so the result is not a monochrome relief map.
      const a = h < 0.5 ? pal[0] : pal[1];
      const b = h < 0.5 ? pal[1] : pal[2];
      const f = h < 0.5 ? h * 2 : (h - 0.5) * 2;
      const shade = sat((t - 0.42) * 1.5);
      const o = i * 4;
      albedo[o] = clamp255(mix(mix(a[0], b[0], f), pal[3][0], 1 - shade) * 1.0);
      albedo[o + 1] = clamp255(mix(mix(a[1], b[1], f), pal[3][1], 1 - shade));
      albedo[o + 2] = clamp255(mix(mix(a[2], b[2], f), pal[3][2], 1 - shade));
      albedo[o + 3] = clamp255(h * 255);
    }
  }

  // Normal + roughness + AO from the height field. Sobel over the wrapped field so the
  // normal map tiles as cleanly as the albedo.
  const nrm = new Uint8Array(NRM * NRM * 4);
  const scale = NRM / SIZE;
  const bump = kind === 'cobbles' ? 5.2 : kind === 'limestone' ? 4.4 : 3.0;
  for (let y = 0; y < NRM; y++) {
    const sy = Math.min(SIZE - 1, (y / scale) | 0);
    for (let x = 0; x < NRM; x++) {
      const sx = Math.min(SIZE - 1, (x / scale) | 0);
      const xm = (sx - 1 + SIZE) % SIZE;
      const xp = (sx + 1) % SIZE;
      const ym = (sy - 1 + SIZE) % SIZE;
      const yp = (sy + 1) % SIZE;
      const hL = height[sy * SIZE + xm];
      const hR = height[sy * SIZE + xp];
      const hD = height[ym * SIZE + sx];
      const hU = height[yp * SIZE + sx];
      const h = height[sy * SIZE + sx];
      let nx = (hL - hR) * bump;
      let ny = (hD - hU) * bump;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;

      // Rough surfaces are rougher in their hollows (dust collects); wet-looking mud is
      // smoother overall.
      const baseRough =
        kind === 'mud' ? 0.68 : kind === 'cobbles' ? 0.78 : kind === 'limestone' ? 0.84 : 0.92;
      const rough = sat(baseRough + (1 - h) * 0.1);
      const ao = sat(0.42 + h * 0.62);

      const o = (y * NRM + x) * 4;
      nrm[o] = clamp255((nx * 0.5 + 0.5) * 255);
      nrm[o + 1] = clamp255((ny * 0.5 + 0.5) * 255);
      nrm[o + 2] = clamp255(rough * 255);
      nrm[o + 3] = clamp255(ao * 255);
    }
  }

  return { albedo, size: SIZE, nrm, nrmSize: NRM };
}

/**
 * Large-scale colour variation. Tiled at hundreds of metres and multiplied into the
 * splat result, this is the single most effective anti-tiling measure available: the eye
 * finds repetition through colour long before it finds it through pattern.
 */
export function generateMacroVariation(size = 512, seed = 7): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      // Three bands with different lattices so the product has no obvious period.
      const a = tileFbm(u, v, 4, 3, seed) * 0.5 + 0.5;
      const b = tileFbm(u, v, 3, 7, seed + 21) * 0.5 + 0.5;
      const c = tileFbm(u, v, 2, 13, seed + 22) * 0.5 + 0.5;
      const o = (y * size + x) * 4;
      // Warm/cool swing of about ±12%, plus a brightness swing of ±18%.
      data[o] = clamp255(128 + (a - 0.5) * 62 + (c - 0.5) * 18);
      // The green and blue channels double as splat masks, so their contrast is
      // stretched: fBm crowds around its mean and an unstretched mask never crosses a
      // threshold decisively enough to make a visible patch.
      data[o + 1] = clamp255(128 + (a - 0.5) * 48 + (b - 0.5) * 26);
      data[o + 2] = clamp255(128 + (c - 0.5) * 210);
      // Alpha carries a separate mask used to nudge the splat weights around.
      data[o + 3] = clamp255((0.5 + (b - 0.5) * 2.0) * 255);
    }
  }
  return data;
}

/**
 * Fine detail normal, tiled at half a metre. Without this the ground turns to mush the
 * moment the camera drops to eye level in a melee, no matter how good the splat is.
 *
 * RG carry the normal. **B carries the height field itself**, which the ground shader
 * multiplies into albedo near the camera: the pebbles and clods need to be visible as
 * light and shade as well as as relief, because a low sun leaves half of them facing
 * away from the light where a pure normal perturbation does nothing at all. A carries a
 * sparser, harder threshold of the same field — the individual small stones.
 */
export function generateDetailNormal(size = 256, seed = 13): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const stone = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Three bands: clods at ~8 cm, granularity at ~2 cm, and a sparse ridged field
      // thresholded into discrete stones.
      const clod = tileFbm(u, v, 4, 12, seed) * 0.5 + 0.5;
      const grain = tileFbm(u, v, 3, 58, seed + 9) * 0.5 + 0.5;
      const st = Math.max(0, tileRidged(u, v, 2, 42, seed + 5) - 0.66) * 2.9;
      stone[y * size + x] = sat(st);
      h[y * size + x] = clod * 0.72 + grain * 0.28 + st * 0.85;
    }
  }
  let lo = 1e9;
  let hi = -1e9;
  for (let i = 0; i < h.length; i++) {
    if (h[i] < lo) lo = h[i];
    if (h[i] > hi) hi = h[i];
  }
  const span = 1 / Math.max(1e-4, hi - lo);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const ym = (y - 1 + size) % size;
      const yp = (y + 1) % size;
      let nx = (h[y * size + xm] - h[y * size + xp]) * 2.9;
      let ny = (h[ym * size + x] - h[yp * size + x]) * 2.9;
      const len = Math.hypot(nx, ny, 1);
      nx /= len;
      ny /= len;
      const o = (y * size + x) * 4;
      data[o] = clamp255((nx * 0.5 + 0.5) * 255);
      data[o + 1] = clamp255((ny * 0.5 + 0.5) * 255);
      data[o + 2] = clamp255((h[y * size + x] - lo) * span * 255);
      data[o + 3] = clamp255(stone[y * size + x] * 255);
    }
  }
  return data;
}

/**
 * Grass card atlas: two 256² cells side by side, each holding a stand of about a dozen
 * blades rising from the bottom edge.
 *
 * A card is worth twelve geometry blades for the cost of one quad, which is the only way
 * to reach a believable sward density — a real pasture has hundreds of blades per square
 * metre, and instanced strip geometry runs out of triangles two orders of magnitude
 * short of that.
 */
export function generateGrassCards(cellSize = 256, cells = 3): { data: Uint8Array; width: number; height: number } {
  const w = cellSize * cells;
  const h = cellSize;
  const data = new Uint8Array(w * h * 4);

  // Green dominant, with straw and bleached dead blades through it. Measured against real
  // Rome II frames the sward is unmistakably *green* — chlorophyll, not beige — with dry
  // stems mixed in; an earlier straw-dominant set left the ground cover indistinguishable
  // from the dirt it stood in. The mean still has to sit near the ground albedo, or every
  // clump reads as a foreign object stuck into the soil.
  const bladeCols: [number, number, number][] = [
    [106, 128, 58],
    [132, 152, 76],
    [ 84, 106, 46],
    [152, 162, 92],
    [ 70,  92, 42],
    [168, 152, 96],
  ];

  for (let c = 0; c < cells; c++) {
    const x0 = c * cellSize;
    // 34 blades, of which the short two thirds form a basal mat. A card with a dozen
    // tall blades and nothing underneath leaves daylight between every clump, which is
    // exactly what made the sward read as isolated tufts.
    const blades = 34;
    for (let b = 0; b < blades; b++) {
      const seed = c * 197 + b * 7;
      const rootX = (hashF(seed, 11) * 0.94 + 0.03) * cellSize;
      const tipDx = (hashF(seed, 1) - 0.5) * cellSize * 0.5;
      // Two populations: a low mat and a scatter of full-height blades.
      const tall = b % 3 === 0
        ? (0.58 + hashF(seed, 2) * 0.42) * cellSize
        : (0.16 + hashF(seed, 2) * 0.34) * cellSize;
      const baseW = (2.2 + hashF(seed, 3) * 2.4) * (cellSize / 256);
      const col = bladeCols[(hashF(seed, 4) * bladeCols.length) | 0];
      // Quadratic arc from root to tip: grass leans, it does not stand to attention.
      const steps = Math.ceil(tall);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const cx = rootX + tipDx * t * t;
        const cy = tall * t;
        const halfW = (baseW * (1 - t * t * 0.94)) * 0.5;
        // Blades are lighter toward the tip and toward the light-facing side.
        const shade = 0.6 + 0.52 * t;
        for (let dx = -Math.ceil(halfW) - 1; dx <= Math.ceil(halfW) + 1; dx++) {
          const px = Math.round(cx) + dx;
          const py = Math.round(cy);
          if (px < 0 || px >= cellSize || py < 0 || py >= h) continue;
          const cov = Math.min(1, Math.max(0, halfW - Math.abs(dx) + 0.5));
          if (cov <= 0.02) continue;
          // Row 0 of the data is the bottom of the card, matching the geometry's UVs.
          const o = ((py * w) + x0 + px) * 4;
          if (cov * 255 > data[o + 3]) {
            data[o] = clamp255(col[0] * shade);
            data[o + 1] = clamp255(col[1] * shade);
            data[o + 2] = clamp255(col[2] * shade);
            data[o + 3] = clamp255(cov * 255);
          }
        }
      }
    }
    // A band of dead thatch across the bottom eighth: the litter layer every real
    // pasture has, and what visually welds a clump to the ground it grows out of.
    const matTop = Math.max(3, Math.round(cellSize * 0.1));
    for (let py = 0; py < matTop; py++) {
      const fade = 1 - py / matTop;
      for (let px = 0; px < cellSize; px++) {
        const n = tileFbm(px / cellSize, py / cellSize, 3, 26, 611) * 0.5 + 0.5;
        const cov = clamp255((n * 1.45 - 0.28) * fade * 255);
        const o = (py * w + x0 + px) * 4;
        if (cov > data[o + 3]) {
          const sh = 0.56 + n * 0.4;
          data[o] = clamp255(146 * sh);
          data[o + 1] = clamp255(140 * sh);
          data[o + 2] = clamp255(86 * sh);
          data[o + 3] = cov;
        }
      }
    }
    // Fill the gaps with the mean blade colour so mip levels do not fade to black.
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < cellSize; px++) {
        const o = ((py * w) + x0 + px) * 4;
        if (data[o + 3] === 0) {
          data[o] = 118;
          data[o + 1] = 134;
          data[o + 2] = 72;
        }
      }
    }
  }
  return { data, width: w, height: h };
}

/** Small deterministic hash used by the card generator. */
function hashF(a: number, salt: number): number {
  let x = (Math.imul(a + 1, 0x27d4eb2d) ^ Math.imul(salt + 7, 0x165667b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x2545f491);
  return ((x ^ (x >>> 13)) >>> 0) / 4294967296;
}

/**
 * Two scrolling water normal maps, packed one per texture. Different lattice counts so
 * the two layers never beat against each other into a visible pattern.
 */
export function generateWaterNormal(size = 256, seed = 3, lattice = 9): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Stretched along x: river surface texture is drawn out by the current.
      h[y * size + x] = tileFbm(x / size, y / size, 4, lattice, seed, 0.52, 0.55);
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const ym = (y - 1 + size) % size;
      const yp = (y + 1) % size;
      let nx = (h[y * size + xm] - h[y * size + xp]) * 3.2;
      let ny = (h[ym * size + x] - h[yp * size + x]) * 3.2;
      const len = Math.hypot(nx, ny, 1);
      const o = (y * size + x) * 4;
      data[o] = clamp255((nx / len * 0.5 + 0.5) * 255);
      data[o + 1] = clamp255((ny / len * 0.5 + 0.5) * 255);
      data[o + 2] = clamp255((1 / len * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  return data;
}

/**
 * Build a coverage-preserving mip chain for an alpha-tested card texture.
 *
 * A grass card is mostly empty: blades cover roughly a third of it. Box-filtering that
 * alpha down a mip chain drives the *mean* alpha toward that third, so at some mip level
 * almost every texel falls below the alpha test and the card stops drawing — not gradually,
 * but over the one or two mip levels where the mean crosses the threshold. On flat ground
 * a mip level is a band of constant distance, and a band of constant distance under a low
 * camera projects to a horizontal line. That is the hard seam across the frame: the sward
 * is not fading out with distance, it is being alpha-tested out of existence at a mip
 * boundary, and no amount of adjusting the ring fade distances can move it because the ring
 * fade is not what is drawing the line.
 *
 * The fix is the standard one (Castano, "Computing Alpha Mipmaps"): after building each
 * level, scale its alpha so that the *fraction of texels passing the alpha test* matches
 * level 0. Coverage, not mean alpha, is what the rasteriser is being asked to reproduce.
 *
 * Colour is premultiplied-averaged so that the transparent gutter between blades cannot
 * bleed its (undefined) colour into the blade as the chain shrinks — the other half of why
 * distant alpha cards go dark and muddy.
 */
export function coveragePreservingMipmaps(
  base: Uint8Array,
  width: number,
  height: number,
  alphaTest: number,
): { data: Uint8Array; width: number; height: number }[] {
  const levels: { data: Uint8Array; width: number; height: number }[] = [
    { data: base, width, height },
  ];

  const cutoff = Math.round(alphaTest * 255);
  const coverageOf = (d: Uint8Array, scale: number): number => {
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] * scale >= cutoff) n++;
    return n / (d.length / 4);
  };
  const target = coverageOf(base, 1);

  let src = base;
  let w = width;
  let h = height;
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const dst = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(w - 1, x * 2);
        const x1 = Math.min(w - 1, x * 2 + 1);
        const y0 = Math.min(h - 1, y * 2);
        const y1 = Math.min(h - 1, y * 2 + 1);
        let r = 0, g = 0, b = 0, a = 0;
        for (const yy of [y0, y1]) {
          for (const xx of [x0, x1]) {
            const o = (yy * w + xx) * 4;
            // Premultiplied: a texel that is invisible contributes no colour, only weight.
            const wa = src[o + 3] / 255;
            r += src[o] * wa;
            g += src[o + 1] * wa;
            b += src[o + 2] * wa;
            a += src[o + 3];
          }
        }
        const o = (y * nw + x) * 4;
        const aw = (r + g + b) > 0 ? a / 255 : 0;
        dst[o] = aw > 0 ? Math.min(255, Math.round(r / aw)) : 0;
        dst[o + 1] = aw > 0 ? Math.min(255, Math.round(g / aw)) : 0;
        dst[o + 2] = aw > 0 ? Math.min(255, Math.round(b / aw)) : 0;
        dst[o + 3] = Math.round(a / 4);
      }
    }

    // Bisect for the alpha scale that reproduces level 0's coverage. Ten iterations
    // resolves the scale to about a thousandth, which is far finer than an 8-bit alpha
    // can express, and the whole loop runs once at init on a 768x256 card.
    let lo = 1;
    let hi = 8;
    if (coverageOf(dst, hi) >= target) {
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) * 0.5;
        if (coverageOf(dst, mid) < target) lo = mid; else hi = mid;
      }
    }
    const scale = (lo + hi) * 0.5;
    if (scale > 1.001) {
      for (let i = 3; i < dst.length; i += 4) dst[i] = Math.min(255, Math.round(dst[i] * scale));
    }

    levels.push({ data: dst, width: nw, height: nh });
    src = dst;
    w = nw;
    h = nh;
  }

  return levels;
}
