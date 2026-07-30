import * as THREE from 'three';
import { hash2 } from '../util/rand';
import { EMBLEMS } from './kit';

/**
 * The soldier texture atlas, generated procedurally at load.
 *
 * One 1024x1024 albedo, one normal and one packed AO/roughness/metalness, laid out as:
 *
 *     canvas rows    0..511    8 x 4 grid of 128 px material tiles
 *     canvas rows  512..1023   4 x 2 grid of 256 px painted shield faces
 *
 * Everything in the frame therefore samples one texture set, which is what lets a whole
 * faction's infantry — five helmet types, four armours, three shields, seven weapons and
 * twelve unit types — render in a single draw call per LOD.
 *
 * Procedural rather than loaded, for three reasons: the game must run with an empty
 * `public/assets/`; painted shield devices for a specific army do not exist as CC0
 * photographs; and a hand-written generator can guarantee the tiles are seamless and
 * consistently lit, which a mixture of scanned Poly Haven surfaces cannot.
 */

export const ATLAS_SIZE = 1024;
const TILE = 128;
const TILES_PER_ROW = 8;
const MAT_ROWS = 4;
const EMBLEM_TILE_PX = 256;
const EMBLEM_TOP = 512;

/** Material tile ids. Index maps to a cell of the 8 x 4 grid, row-major. */
export const enum Mat {
  IronWorn = 0,
  IronPlate = 1,
  Bronze = 2,
  Mail = 3,
  Scale = 4,
  LeatherBrown = 5,
  LeatherDark = 6,
  WoolCoarse = 7,
  Linen = 8,
  Skin = 9,
  Hair = 10,
  WoodPlank = 11,
  Fur = 12,
  Plume = 13,
  Rope = 14,
  Bands = 15,
  HideBay = 16,
  HideGrey = 17,
  HideBlack = 18,
  SaddleLeather = 19,
  Hoof = 20,
  Mane = 21,
  Bone = 22,
  ClothFine = 23,
  Count = 24,
}

export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * UV rectangle of a material tile.
 *
 * The V flip is baked in here because `CanvasTexture` uploads with `flipY = true`, so
 * canvas row 0 becomes v = 1. A 3-texel inset keeps mip level 2 and below from bleeding a
 * neighbouring tile into a silhouette edge.
 */
export function matUv(id: Mat): UvRect {
  const col = id % TILES_PER_ROW;
  const row = Math.floor(id / TILES_PER_ROW);
  const inset = 3 / ATLAS_SIZE;
  const u0 = (col * TILE) / ATLAS_SIZE + inset;
  const u1 = ((col + 1) * TILE) / ATLAS_SIZE - inset;
  const v1 = 1 - (row * TILE) / ATLAS_SIZE - inset;
  const v0 = 1 - ((row + 1) * TILE) / ATLAS_SIZE + inset;
  return { u0, v0, u1, v1 };
}

/**
 * Where the emblem block sits, in the form the shader wants.
 *
 * V is fiddly because `CanvasTexture` uploads flipped: within a tile V rises with the
 * shield's own up, but the tile *index* runs the other way, since row 1 is lower down the
 * canvas and therefore lower in V. Hence the shader's `(u + tile.x, v - tile.y)`.
 */
export const EMBLEM_ORIGIN: [number, number] = [
  0,
  1 - (EMBLEM_TOP + EMBLEM_TILE_PX) / ATLAS_SIZE,
];
export const EMBLEM_TILE: [number, number] = [
  EMBLEM_TILE_PX / ATLAS_SIZE,
  EMBLEM_TILE_PX / ATLAS_SIZE,
];

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

/** Tileable value noise: the lattice wraps at `period` so tiles have no seam. */
function vnoise(x: number, y: number, period: number, salt: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const w = (t: number): number => t * t * (3 - 2 * t);
  const u = w(xf);
  const v = w(yf);
  const m = (a: number): number => ((a % period) + period) % period;
  const a = hash2(m(xi), m(yi), salt);
  const b = hash2(m(xi + 1), m(yi), salt);
  const c = hash2(m(xi), m(yi + 1), salt);
  const d = hash2(m(xi + 1), m(yi + 1), salt);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x: number, y: number, octaves: number, period: number, salt: number): number {
  let sum = 0;
  let amp = 0.5;
  let total = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(x * f, y * f, period * f, salt + o * 17) * amp;
    total += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / total;
}

// ---------------------------------------------------------------------------
// Material definitions
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

interface MatDef {
  /** Base colour in sRGB 0..1 at (u, v) in [0,1). */
  colour(u: number, v: number, out: Rgb): void;
  /** Surface height 0..1, used to derive the normal map and a cavity term. */
  height(u: number, v: number): number;
  roughness: number;
  metalness: number;
  /** How strongly the height field bends normals. */
  bump: number;
}

const mix3 = (a: Rgb, b: Rgb, t: number, out: Rgb): void => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
};

/** Ring mail: interlocked rows, each row offset half a ring from its neighbours. */
const mailHeight = (u: number, v: number, rings: number): number => {
  const gy = v * rings;
  const row = Math.floor(gy);
  const fy = gy - row;
  const gx = u * rings + (row % 2) * 0.5;
  const fx = gx - Math.floor(gx);
  const dx = fx - 0.5;
  const dy = fy - 0.5;
  const r = Math.hypot(dx, dy) * 2;
  // A torus profile: highest on the ring itself, lowest in the hole and between rings.
  const ring = Math.exp(-((r - 0.62) ** 2) / 0.055);
  return Math.min(1, ring * 0.95 + 0.05);
};

const IRON: Rgb = [0.5, 0.485, 0.45];
const IRON_DARK: Rgb = [0.26, 0.25, 0.235];
const RUST: Rgb = [0.36, 0.22, 0.14];
const BRONZE: Rgb = [0.72, 0.56, 0.26];
const BRONZE_DARK: Rgb = [0.4, 0.29, 0.12];

const MATS: Record<Mat, MatDef> = {
  // Pitted, scratched iron — the default for a soldier's ironmongery. Rome II's armour
  // reads as metal because it is dark and broken up, not because it is shiny.
  [Mat.IronWorn]: {
    colour(u, v, out) {
      const n = fbm(u * 9, v * 9, 4, 9, 3);
      const scratch = vnoise(u * 3, v * 46, 3, 11);
      const rust = Math.max(0, fbm(u * 5, v * 5, 3, 5, 21) - 0.62) * 2.6;
      mix3(IRON_DARK, IRON, n * 0.85 + scratch * 0.15, out);
      mix3(out, RUST, Math.min(0.7, rust), out);
    },
    height: (u, v) => fbm(u * 14, v * 14, 3, 14, 3) * 0.6 + vnoise(u * 3, v * 40, 3, 11) * 0.4,
    roughness: 0.55,
    metalness: 0.42,
    bump: 0.5,
  },
  // Cleaner plate for helmets and bosses.
  [Mat.IronPlate]: {
    colour(u, v, out) {
      const n = fbm(u * 6, v * 6, 3, 6, 5);
      const brush = vnoise(u * 60, v * 2, 60, 7);
      mix3([0.3, 0.295, 0.28], [0.6, 0.585, 0.55], n * 0.7 + brush * 0.3, out);
    },
    height: (u, v) => vnoise(u * 56, v * 2, 56, 7) * 0.35 + fbm(u * 8, v * 8, 3, 8, 5) * 0.65,
    roughness: 0.42,
    metalness: 0.5,
    bump: 0.25,
  },
  // Gilded bronze: praetorian fittings, helmet trim, harness bosses.
  [Mat.Bronze]: {
    colour(u, v, out) {
      const n = fbm(u * 7, v * 7, 3, 7, 9);
      const patina = Math.max(0, fbm(u * 4, v * 4, 3, 4, 31) - 0.58) * 2;
      mix3(BRONZE_DARK, BRONZE, n, out);
      mix3(out, [0.34, 0.5, 0.4], Math.min(0.45, patina), out);
    },
    height: (u, v) => fbm(u * 10, v * 10, 3, 10, 9),
    roughness: 0.34,
    metalness: 0.5,
    bump: 0.3,
  },
  [Mat.Mail]: {
    colour(u, v, out) {
      const h = mailHeight(u, v, 18);
      const grime = fbm(u * 5, v * 5, 3, 5, 13);
      mix3([0.2, 0.195, 0.185], [0.54, 0.53, 0.5], h * (0.7 + grime * 0.3), out);
    },
    height: (u, v) => mailHeight(u, v, 18),
    roughness: 0.6,
    metalness: 0.4,
    bump: 1.0,
  },
  // Lorica squamata: overlapping bronze-washed scales wired to a linen backing.
  [Mat.Scale]: {
    colour(u, v, out) {
      const rows = 14;
      const gy = v * rows;
      const row = Math.floor(gy);
      const fy = gy - row;
      const gx = u * rows + (row % 2) * 0.5;
      const fx = gx - Math.floor(gx);
      // Scale plate: rounded bottom edge, darker in the overlap gutter.
      const edge = Math.min(1, Math.max(0, (1 - fy) * 3));
      const side = 1 - Math.abs(fx - 0.5) * 1.6;
      const lit = Math.max(0, edge * side);
      const n = fbm(u * 8, v * 8, 3, 8, 17);
      mix3(BRONZE_DARK, BRONZE, lit * 0.8 + n * 0.2, out);
      if (fy > 0.9) mix3(out, [0.1, 0.08, 0.05], 0.7, out);
    },
    height(u, v) {
      const rows = 14;
      const gy = v * rows;
      const row = Math.floor(gy);
      const fy = gy - row;
      const gx = u * rows + (row % 2) * 0.5;
      const fx = gx - Math.floor(gx);
      const side = 1 - Math.abs(fx - 0.5) * 1.7;
      return Math.max(0, Math.min(1, (1 - fy * 0.85) * Math.max(0, side)));
    },
    roughness: 0.42,
    metalness: 0.4,
    bump: 0.9,
  },
  [Mat.LeatherBrown]: {
    colour(u, v, out) {
      const n = fbm(u * 16, v * 16, 4, 16, 23);
      const crack = Math.max(0, vnoise(u * 11, v * 11, 11, 29) - 0.55) * 2;
      mix3([0.24, 0.15, 0.09], [0.46, 0.31, 0.18], n, out);
      mix3(out, [0.13, 0.08, 0.05], Math.min(0.6, crack), out);
    },
    height: (u, v) => fbm(u * 20, v * 20, 4, 20, 23),
    roughness: 0.7,
    metalness: 0.02,
    bump: 0.55,
  },
  [Mat.LeatherDark]: {
    colour(u, v, out) {
      const n = fbm(u * 18, v * 18, 4, 18, 37);
      mix3([0.11, 0.08, 0.06], [0.26, 0.19, 0.13], n, out);
    },
    height: (u, v) => fbm(u * 22, v * 22, 4, 22, 37),
    roughness: 0.74,
    metalness: 0.02,
    bump: 0.5,
  },
  // Coarse wool: the tunic and the sagum. A visible weave at close range is most of what
  // makes cloth read as cloth rather than plastic.
  [Mat.WoolCoarse]: {
    colour(u, v, out) {
      const warp = Math.sin(u * Math.PI * 2 * 36) * 0.5 + 0.5;
      const weft = Math.sin(v * Math.PI * 2 * 36) * 0.5 + 0.5;
      const weave = (warp * 0.5 + weft * 0.5) * 0.35 + 0.65;
      const slub = fbm(u * 12, v * 12, 3, 12, 41);
      const g = weave * (0.78 + slub * 0.3);
      out[0] = g; out[1] = g * 0.99; out[2] = g * 0.97;
    },
    height(u, v) {
      const warp = Math.sin(u * Math.PI * 2 * 36) * 0.5 + 0.5;
      const weft = Math.sin(v * Math.PI * 2 * 36) * 0.5 + 0.5;
      return Math.max(warp, weft) * 0.7 + fbm(u * 16, v * 16, 3, 16, 41) * 0.3;
    },
    roughness: 0.9,
    metalness: 0,
    bump: 0.5,
  },
  [Mat.Linen]: {
    colour(u, v, out) {
      const warp = Math.sin(u * Math.PI * 2 * 52) * 0.5 + 0.5;
      const weft = Math.sin(v * Math.PI * 2 * 52) * 0.5 + 0.5;
      const g = 0.78 + (warp * 0.5 + weft * 0.5) * 0.22 + fbm(u * 14, v * 14, 3, 14, 43) * 0.12;
      out[0] = Math.min(1, g); out[1] = Math.min(1, g * 0.98); out[2] = Math.min(1, g * 0.9);
    },
    height(u, v) {
      const warp = Math.sin(u * Math.PI * 2 * 52) * 0.5 + 0.5;
      const weft = Math.sin(v * Math.PI * 2 * 52) * 0.5 + 0.5;
      return Math.max(warp, weft);
    },
    roughness: 0.86,
    metalness: 0,
    bump: 0.3,
  },
  // Skin is tinted per man in the shader; the tile carries only pore and shading detail.
  [Mat.Skin]: {
    colour(u, v, out) {
      const pore = fbm(u * 40, v * 40, 3, 40, 47) * 0.1;
      const blotch = fbm(u * 7, v * 7, 3, 7, 53) * 0.14;
      // Kept mid-grey: the per-man skin tone is applied as a tint, and a bright tile
      // would blow the whole face out once the sun and the tint are both on it.
      const g = 0.72 + pore - blotch * 0.5;
      out[0] = Math.min(1, g); out[1] = Math.min(1, g * 0.97); out[2] = Math.min(1, g * 0.94);
    },
    height: (u, v) => fbm(u * 44, v * 44, 3, 44, 47),
    roughness: 0.62,
    metalness: 0,
    bump: 0.12,
  },
  // Hair and beard: strands, tinted per man.
  [Mat.Hair]: {
    colour(u, v, out) {
      const strand = vnoise(u * 70, v * 5, 70, 59);
      const g = 0.55 + strand * 0.45;
      out[0] = g; out[1] = g * 0.96; out[2] = g * 0.92;
    },
    height: (u, v) => vnoise(u * 70, v * 5, 70, 59),
    roughness: 0.78,
    metalness: 0,
    bump: 0.7,
  },
  // Limewood shield planks and spear shafts: straight grain with knots.
  [Mat.WoodPlank]: {
    colour(u, v, out) {
      const plank = Math.floor(v * 6);
      const shade = 0.82 + hash2(plank, 3, 61) * 0.28;
      const grain = vnoise(u * 4, v * 90, 4, 67);
      const knot = Math.max(0, fbm(u * 6, v * 6, 3, 6, 71) - 0.72) * 3;
      mix3([0.42, 0.31, 0.19], [0.66, 0.52, 0.34], grain * shade, out);
      mix3(out, [0.2, 0.13, 0.07], Math.min(0.8, knot), out);
      // Plank seam.
      const seam = Math.abs(v * 6 - plank - 0.5) > 0.47 ? 0.55 : 1;
      out[0] *= seam; out[1] *= seam; out[2] *= seam;
    },
    height(u, v) {
      const plank = Math.floor(v * 6);
      const seam = Math.abs(v * 6 - plank - 0.5) > 0.47 ? 0 : 1;
      return seam * (0.6 + vnoise(u * 4, v * 90, 4, 67) * 0.4);
    },
    roughness: 0.78,
    metalness: 0,
    bump: 0.5,
  },
  [Mat.Fur]: {
    colour(u, v, out) {
      const tuft = fbm(u * 26, v * 26, 4, 26, 73);
      const strand = vnoise(u * 50, v * 12, 50, 79);
      mix3([0.17, 0.13, 0.1], [0.5, 0.41, 0.32], tuft * 0.6 + strand * 0.4, out);
    },
    height: (u, v) => fbm(u * 30, v * 30, 4, 30, 73),
    roughness: 0.92,
    metalness: 0,
    bump: 1.0,
  },
  // Dyed horsehair crest.
  [Mat.Plume]: {
    colour(u, v, out) {
      const strand = vnoise(u * 90, v * 6, 90, 83);
      const g = 0.5 + strand * 0.5;
      out[0] = g * 0.72; out[1] = g * 0.1; out[2] = g * 0.11;
    },
    height: (u, v) => vnoise(u * 90, v * 6, 90, 83),
    roughness: 0.82,
    metalness: 0,
    bump: 0.8,
  },
  [Mat.Rope]: {
    colour(u, v, out) {
      const twist = Math.sin((u + v) * Math.PI * 2 * 14) * 0.5 + 0.5;
      const g = 0.5 + twist * 0.35 + fbm(u * 20, v * 20, 3, 20, 89) * 0.2;
      out[0] = g * 0.82; out[1] = g * 0.72; out[2] = g * 0.52;
    },
    height: (u, v) => Math.sin((u + v) * Math.PI * 2 * 14) * 0.5 + 0.5,
    roughness: 0.88,
    metalness: 0,
    bump: 0.7,
  },
  // Lorica segmentata: horizontal iron girdle plates with visible leather lacing and the
  // bright rivet line along each band. This is the single most recognisable Roman texture.
  [Mat.Bands]: {
    colour(u, v, out) {
      const bands = 7;
      const gy = v * bands;
      const band = Math.floor(gy);
      const fy = gy - band;
      const n = fbm(u * 10, v * 20, 3, 10, 97);
      // Lit along the top of each plate, shadowed in the overlap at the bottom.
      const shade = 0.55 + (1 - fy) * 0.55;
      mix3(IRON_DARK, IRON, Math.min(1, shade * (0.75 + n * 0.35)), out);
      if (fy > 0.86) mix3(out, [0.08, 0.07, 0.06], 0.75, out);
      // Rivets: a row of bright dots near the top edge of every plate.
      const rivets = 9;
      const rx = u * rivets;
      const dr = Math.hypot(rx - Math.floor(rx) - 0.5, (fy - 0.22) * bands * 0.5);
      if (dr < 0.2) mix3(out, [0.78, 0.79, 0.8], 1 - dr / 0.2, out);
      // Bronze plate edging every other band, as on the Corbridge finds.
      if (band % 2 === 1 && fy < 0.08) mix3(out, BRONZE, 0.7, out);
    },
    height(u, v) {
      const bands = 7;
      const gy = v * bands;
      const fy = gy - Math.floor(gy);
      const plate = fy > 0.88 ? 0 : 0.4 + (1 - fy) * 0.6;
      const rivets = 9;
      const rx = u * rivets;
      const dr = Math.hypot(rx - Math.floor(rx) - 0.5, (fy - 0.22) * bands * 0.5);
      return Math.min(1, plate + (dr < 0.2 ? (1 - dr / 0.2) * 0.5 : 0));
    },
    roughness: 0.46,
    metalness: 0.45,
    bump: 0.9,
  },
  [Mat.HideBay]: {
    colour(u, v, out) {
      const n = fbm(u * 10, v * 10, 4, 10, 101);
      const sheen = vnoise(u * 30, v * 30, 30, 103);
      mix3([0.24, 0.13, 0.06], [0.48, 0.28, 0.13], n * 0.8 + sheen * 0.2, out);
    },
    height: (u, v) => fbm(u * 26, v * 26, 3, 26, 101),
    roughness: 0.56,
    metalness: 0,
    bump: 0.15,
  },
  [Mat.HideGrey]: {
    colour(u, v, out) {
      const n = fbm(u * 10, v * 10, 4, 10, 107);
      const dapple = Math.max(0, fbm(u * 5, v * 5, 2, 5, 109) - 0.5) * 2;
      mix3([0.42, 0.41, 0.4], [0.72, 0.71, 0.7], n, out);
      mix3(out, [0.3, 0.29, 0.29], Math.min(0.5, dapple), out);
    },
    height: (u, v) => fbm(u * 26, v * 26, 3, 26, 107),
    roughness: 0.58,
    metalness: 0,
    bump: 0.15,
  },
  [Mat.HideBlack]: {
    colour(u, v, out) {
      const n = fbm(u * 10, v * 10, 4, 10, 113);
      mix3([0.06, 0.055, 0.05], [0.2, 0.18, 0.17], n, out);
    },
    height: (u, v) => fbm(u * 26, v * 26, 3, 26, 113),
    roughness: 0.5,
    metalness: 0,
    bump: 0.15,
  },
  [Mat.SaddleLeather]: {
    colour(u, v, out) {
      const n = fbm(u * 14, v * 14, 4, 14, 127);
      const stitch = Math.abs(((v * 8) % 1) - 0.5) > 0.46 ? 0.6 : 1;
      mix3([0.2, 0.11, 0.06], [0.4, 0.24, 0.13], n, out);
      out[0] *= stitch; out[1] *= stitch; out[2] *= stitch;
    },
    height: (u, v) => fbm(u * 18, v * 18, 3, 18, 127),
    roughness: 0.66,
    metalness: 0.02,
    bump: 0.4,
  },
  [Mat.Hoof]: {
    colour(u, v, out) {
      const n = vnoise(u * 3, v * 24, 3, 131);
      mix3([0.12, 0.1, 0.09], [0.3, 0.27, 0.24], n, out);
    },
    height: (u, v) => vnoise(u * 3, v * 24, 3, 131),
    roughness: 0.42,
    metalness: 0,
    bump: 0.3,
  },
  [Mat.Mane]: {
    colour(u, v, out) {
      const strand = vnoise(u * 60, v * 4, 60, 137);
      const g = 0.35 + strand * 0.4;
      out[0] = g * 0.6; out[1] = g * 0.48; out[2] = g * 0.34;
    },
    height: (u, v) => vnoise(u * 60, v * 4, 60, 137),
    roughness: 0.8,
    metalness: 0,
    bump: 0.8,
  },
  [Mat.Bone]: {
    colour(u, v, out) {
      const n = fbm(u * 12, v * 12, 3, 12, 139);
      mix3([0.62, 0.58, 0.48], [0.86, 0.83, 0.72], n, out);
    },
    height: (u, v) => fbm(u * 16, v * 16, 3, 16, 139),
    roughness: 0.55,
    metalness: 0,
    bump: 0.2,
  },
  // Finer wool for cloaks and officer cloth.
  [Mat.ClothFine]: {
    colour(u, v, out) {
      const warp = Math.sin(u * Math.PI * 2 * 64) * 0.5 + 0.5;
      const weft = Math.sin(v * Math.PI * 2 * 64) * 0.5 + 0.5;
      const g = 0.8 + (warp * 0.5 + weft * 0.5) * 0.2 + fbm(u * 10, v * 10, 3, 10, 149) * 0.1;
      out[0] = Math.min(1, g); out[1] = Math.min(1, g); out[2] = Math.min(1, g * 0.98);
    },
    height(u, v) {
      const warp = Math.sin(u * Math.PI * 2 * 64) * 0.5 + 0.5;
      const weft = Math.sin(v * Math.PI * 2 * 64) * 0.5 + 0.5;
      return Math.max(warp, weft);
    },
    roughness: 0.82,
    metalness: 0,
    bump: 0.25,
  },
  [Mat.Count]: {
    colour(_u, _v, out) { out[0] = 0.5; out[1] = 0.5; out[2] = 0.5; },
    height: () => 0.5,
    roughness: 0.7,
    metalness: 0,
    bump: 0,
  },
};

// ---------------------------------------------------------------------------
// Shield devices
// ---------------------------------------------------------------------------

/**
 * Painted shield faces.
 *
 * Roman shields were painted per unit, the devices recorded on the Dura-Europos finds and
 * the Notitia Dignitatum: a coloured field with a bold central device and a rim. Germanic
 * shields were painted individually, and the spiral and sunwheel are the two motifs that
 * turn up most often in the archaeology.
 */
function drawEmblem(ctx: CanvasRenderingContext2D, name: string, size: number): void {
  const c = size / 2;
  ctx.save();
  ctx.translate(size * 0.5, size * 0.5);

  const field = (colour: string, rim: string): void => {
    ctx.fillStyle = colour;
    ctx.fillRect(-c, -c, size, size);
    // Rim binding: a band of stitched hide or bronze around the edge, narrow enough that
    // it reads as a binding rather than a picture frame.
    ctx.strokeStyle = rim;
    ctx.lineWidth = size * 0.036;
    ctx.strokeRect(-c + size * 0.018, -c + size * 0.018, size * 0.964, size * 0.964);
  };

  // Weathering: streaks and scuffs over whatever device is painted.
  const weather = (): void => {
    ctx.globalAlpha = 0.14;
    for (let i = 0; i < 90; i++) {
      const x = (hash2(i, 1, 5) - 0.5) * size;
      const y = (hash2(i, 2, 5) - 0.5) * size;
      const w = hash2(i, 3, 5) * size * 0.22 + 2;
      ctx.fillStyle = hash2(i, 4, 5) > 0.5 ? '#000' : '#fff';
      ctx.fillRect(x, y, w, size * 0.012 + 1);
    }
    ctx.globalAlpha = 1;
  };

  switch (name) {
    case 'legio-thunderbolt': {
      // Red field with a gilt winged thunderbolt: the device on the Dura-Europos scutum and
      // the one every reconstruction uses. Drawn broad and simple, because at 40 m a shield
      // is 20 px across and fine linework turns to mush.
      field('#8e1f24', '#5d4522');
      const gold = '#d8ae48';
      ctx.strokeStyle = gold;
      ctx.fillStyle = gold;
      // A pair of wings sweeping the full width from behind the boss.
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * size * 0.05, -size * 0.09);
        ctx.quadraticCurveTo(s * size * 0.3, -size * 0.28, s * size * 0.47, -size * 0.15);
        ctx.quadraticCurveTo(s * size * 0.3, -size * 0.1, s * size * 0.46, size * 0.02);
        ctx.quadraticCurveTo(s * size * 0.28, size * 0.0, s * size * 0.44, size * 0.16);
        ctx.quadraticCurveTo(s * size * 0.2, size * 0.08, s * size * 0.05, size * 0.09);
        ctx.closePath();
        ctx.fill();
      }
      // Four zig-zag bolts, above and below, thick enough to survive a mip level or two.
      ctx.lineWidth = size * 0.055;
      ctx.lineJoin = 'miter';
      for (const s of [-1, 1]) {
        for (const dir of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * size * 0.07, dir * size * 0.44);
          ctx.lineTo(s * size * 0.19, dir * size * 0.28);
          ctx.lineTo(s * size * 0.07, dir * size * 0.2);
          ctx.lineTo(s * size * 0.17, dir * size * 0.08);
          ctx.stroke();
        }
      }
      break;
    }
    case 'praetorian-scorpion': {
      // Dark red with the scorpion of the praetorians (Tiberius' birth sign).
      field('#6d161c', '#7a5c26');
      ctx.strokeStyle = '#d9c07a';
      ctx.lineWidth = size * 0.04;
      ctx.beginPath();
      ctx.ellipse(0, size * 0.02, size * 0.075, size * 0.17, 0, 0, Math.PI * 2);
      ctx.stroke();
      // Tail curling over the back.
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.15);
      ctx.quadraticCurveTo(size * 0.02, -size * 0.34, size * 0.16, -size * 0.36);
      ctx.quadraticCurveTo(size * 0.26, -size * 0.36, size * 0.22, -size * 0.26);
      ctx.stroke();
      // Legs and pincers.
      for (const s of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const y = -size * 0.05 + i * size * 0.075;
          ctx.beginPath();
          ctx.moveTo(s * size * 0.06, y);
          ctx.quadraticCurveTo(s * size * 0.2, y + size * 0.02, s * size * 0.28, y + size * 0.09);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(s * size * 0.05, -size * 0.14);
        ctx.quadraticCurveTo(s * size * 0.24, -size * 0.22, s * size * 0.3, -size * 0.12);
        ctx.stroke();
      }
      break;
    }
    case 'urban-wreath': {
      // Ochre field with a laurel wreath: the city cohorts, a civic device.
      field('#a9622f', '#54401f');
      ctx.strokeStyle = '#dcd0a4';
      ctx.lineWidth = size * 0.038;
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.3, Math.PI * 0.62, Math.PI * 2.38);
      ctx.stroke();
      for (let i = 0; i < 18; i++) {
        const a = Math.PI * 0.62 + (i / 17) * Math.PI * 1.76;
        const x = Math.cos(a) * size * 0.3;
        const y = Math.sin(a) * size * 0.3;
        ctx.beginPath();
        ctx.ellipse(x, y, size * 0.055, size * 0.022, a, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
    case 'equites-star': {
      // Blue-green field with an eight-pointed star, a common cavalry device.
      field('#25493f', '#5d4522');
      ctx.fillStyle = '#d8c273';
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * size * 0.4, Math.sin(a) * size * 0.4);
        ctx.lineTo(Math.cos(a + 0.22) * size * 0.12, Math.sin(a + 0.22) * size * 0.12);
        ctx.lineTo(Math.cos(a - 0.22) * size * 0.12, Math.sin(a - 0.22) * size * 0.12);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 'germanic-spiral': {
      field('#5a6b4a', '#3a2c1c');
      ctx.strokeStyle = '#d6cbb0';
      ctx.lineWidth = size * 0.05;
      ctx.beginPath();
      for (let i = 0; i <= 220; i++) {
        const t = i / 220;
        const a = t * Math.PI * 6;
        const r = t * size * 0.4;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      break;
    }
    case 'germanic-sunwheel': {
      field('#7a4526', '#31251a');
      ctx.strokeStyle = '#e0d4b4';
      ctx.lineWidth = size * 0.055;
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.32, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * size * 0.42, Math.sin(a) * size * 0.42);
        ctx.stroke();
      }
      break;
    }
    case 'germanic-wolf': {
      // A wolf's head, stylised down to what survives on a shield at 30 m.
      field('#3f4a3c', '#2a1f15');
      ctx.fillStyle = '#cdbfa2';
      ctx.beginPath();
      ctx.moveTo(-size * 0.24, -size * 0.06);
      ctx.lineTo(-size * 0.3, -size * 0.3);
      ctx.lineTo(-size * 0.1, -size * 0.2);
      ctx.lineTo(size * 0.1, -size * 0.24);
      ctx.lineTo(size * 0.28, -size * 0.32);
      ctx.lineTo(size * 0.24, -size * 0.04);
      ctx.lineTo(size * 0.34, size * 0.14);
      ctx.lineTo(size * 0.04, size * 0.34);
      ctx.lineTo(-size * 0.22, size * 0.18);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#3f4a3c';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(s * size * 0.1, -size * 0.04, size * 0.045, size * 0.03, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#efe6d0';
      for (let i = 0; i < 4; i++) {
        const x = -size * 0.1 + i * size * 0.07;
        ctx.beginPath();
        ctx.moveTo(x, size * 0.2);
        ctx.lineTo(x + size * 0.03, size * 0.3);
        ctx.lineTo(x + size * 0.06, size * 0.2);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    default: {
      // Plain limewood with a painted rim and a bare iron boss — the commonest shield in
      // the host, and the one that reads as "this man made his own kit".
      field('#8a6a42', '#39291a');
      ctx.strokeStyle = '#6d3a24';
      ctx.lineWidth = size * 0.05;
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.34, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.5;
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = '#5f4a2e';
        ctx.fillRect(-c, -c + (i * size) / 6, size, size * 0.01);
      }
      ctx.globalAlpha = 1;
      break;
    }
  }
  weather();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface SoldierAtlas {
  readonly albedo: THREE.Texture;
  readonly normal: THREE.Texture;
  /** R = ambient occlusion, G = roughness, B = metalness. */
  readonly orm: THREE.Texture;
  dispose(): void;
}

function canvas2d(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('[atlas] 2D canvas unavailable');
  return { canvas, ctx };
}

export function buildSoldierAtlas(anisotropy: number): SoldierAtlas {
  const alb = canvas2d(ATLAS_SIZE);
  const nrm = canvas2d(ATLAS_SIZE);
  const orm = canvas2d(ATLAS_SIZE);

  const albData = alb.ctx.createImageData(ATLAS_SIZE, ATLAS_SIZE);
  const nrmData = nrm.ctx.createImageData(ATLAS_SIZE, ATLAS_SIZE);
  const ormData = orm.ctx.createImageData(ATLAS_SIZE, ATLAS_SIZE);
  // Sensible defaults for any part of the atlas nothing writes.
  for (let i = 0; i < ATLAS_SIZE * ATLAS_SIZE; i++) {
    albData.data[i * 4 + 3] = 255;
    nrmData.data[i * 4] = 128;
    nrmData.data[i * 4 + 1] = 128;
    nrmData.data[i * 4 + 2] = 255;
    nrmData.data[i * 4 + 3] = 255;
    ormData.data[i * 4] = 255;
    ormData.data[i * 4 + 1] = 200;
    ormData.data[i * 4 + 3] = 255;
  }

  const rgb: Rgb = [0, 0, 0];
  const heights = new Float32Array(TILE * TILE);

  for (let id = 0; id < Mat.Count; id++) {
    const def = MATS[id as Mat];
    const col = id % TILES_PER_ROW;
    const row = Math.floor(id / TILES_PER_ROW);
    if (row >= MAT_ROWS) break;
    const ox = col * TILE;
    const oy = row * TILE;

    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        heights[y * TILE + x] = def.height((x + 0.5) / TILE, (y + 0.5) / TILE);
      }
    }

    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const u = (x + 0.5) / TILE;
        const v = (y + 0.5) / TILE;
        def.colour(u, v, rgb);
        const o = ((oy + y) * ATLAS_SIZE + ox + x) * 4;
        albData.data[o] = Math.round(Math.min(1, Math.max(0, rgb[0])) * 255);
        albData.data[o + 1] = Math.round(Math.min(1, Math.max(0, rgb[1])) * 255);
        albData.data[o + 2] = Math.round(Math.min(1, Math.max(0, rgb[2])) * 255);
        albData.data[o + 3] = 255;

        // Central differences on the tileable height field.
        const xm = (x - 1 + TILE) % TILE;
        const xp = (x + 1) % TILE;
        const ym = (y - 1 + TILE) % TILE;
        const yp = (y + 1) % TILE;
        const dx = (heights[y * TILE + xp] - heights[y * TILE + xm]) * def.bump * TILE * 0.02;
        // Canvas Y runs down while the tangent-space green channel runs up.
        const dy = (heights[ym * TILE + x] - heights[yp * TILE + x]) * def.bump * TILE * 0.02;
        const len = Math.hypot(-dx, -dy, 1);
        nrmData.data[o] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
        nrmData.data[o + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
        nrmData.data[o + 2] = Math.round((1 / len) * 0.5 * 255 + 127.5);
        nrmData.data[o + 3] = 255;

        // Cavity AO from the height field: crevices between mail rings and under the
        // overlap of plate bands are what make armour read as assembled rather than
        // painted on.
        const h = heights[y * TILE + x];
        const ao = 0.55 + h * 0.45;
        ormData.data[o] = Math.round(Math.min(1, ao) * 255);
        ormData.data[o + 1] = Math.round(Math.min(1, def.roughness * (0.85 + (1 - h) * 0.3)) * 255);
        ormData.data[o + 2] = Math.round(def.metalness * 255);
        ormData.data[o + 3] = 255;
      }
    }
  }

  alb.ctx.putImageData(albData, 0, 0);
  nrm.ctx.putImageData(nrmData, 0, 0);
  orm.ctx.putImageData(ormData, 0, 0);

  // Shield faces are drawn with vector operations — a thunderbolt or a wolf's head is a
  // path, not a noise field — into the lower half of the albedo. Their normal and ORM
  // cells stay at the plank defaults, which is right: paint does not change the surface.
  for (let e = 0; e < EMBLEMS.length; e++) {
    const col = e % 4;
    const row = Math.floor(e / 4);
    alb.ctx.save();
    alb.ctx.translate(col * EMBLEM_TILE_PX, EMBLEM_TOP + row * EMBLEM_TILE_PX);
    drawEmblem(alb.ctx, EMBLEMS[e], EMBLEM_TILE_PX);
    alb.ctx.restore();

    // Give the emblem block a plank-like normal so a shield face is not glassy.
    const ox = col * EMBLEM_TILE_PX;
    const oy = EMBLEM_TOP + row * EMBLEM_TILE_PX;
    const planks = nrm.ctx.getImageData(ox, oy, EMBLEM_TILE_PX, EMBLEM_TILE_PX);
    const ormBlock = orm.ctx.getImageData(ox, oy, EMBLEM_TILE_PX, EMBLEM_TILE_PX);
    for (let y = 0; y < EMBLEM_TILE_PX; y++) {
      for (let x = 0; x < EMBLEM_TILE_PX; x++) {
        const o = (y * EMBLEM_TILE_PX + x) * 4;
        const g = vnoise((x / EMBLEM_TILE_PX) * 4, (y / EMBLEM_TILE_PX) * 60, 4, 67);
        planks.data[o] = 128;
        planks.data[o + 1] = Math.round(120 + g * 16);
        planks.data[o + 2] = 250;
        planks.data[o + 3] = 255;
        ormBlock.data[o] = 245;
        ormBlock.data[o + 1] = Math.round(190 + g * 30);
        ormBlock.data[o + 2] = 0;
        ormBlock.data[o + 3] = 255;
      }
    }
    nrm.ctx.putImageData(planks, ox, oy);
    orm.ctx.putImageData(ormBlock, ox, oy);
  }

  const make = (c: HTMLCanvasElement, srgb: boolean, name: string): THREE.CanvasTexture => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = anisotropy;
    t.name = name;
    t.needsUpdate = true;
    return t;
  };

  const albedo = make(alb.canvas, true, 'soldier-albedo');
  const normal = make(nrm.canvas, false, 'soldier-normal');
  const ormTex = make(orm.canvas, false, 'soldier-orm');

  return {
    albedo,
    normal,
    orm: ormTex,
    dispose(): void {
      albedo.dispose();
      normal.dispose();
      ormTex.dispose();
    },
  };
}
