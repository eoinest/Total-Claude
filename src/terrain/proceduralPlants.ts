import * as THREE from 'three';
import { hash01 } from '../util/rand';
import { tileFbm } from './noise';

/**
 * Procedural Italian vegetation.
 *
 * The asset pack's Quaternius nature models are stylised low-poly trees of the wrong
 * species — common tree, palm, willow — with no cypress and no olive, and their textures
 * are not part of the download. Since the two species that most immediately say "Rome"
 * are the Italian cypress and the umbrella pine, and neither is in the pack, the trees
 * here are generated: trunk and limb geometry plus alpha-tested foliage cards.
 *
 * Everything shares one procedurally generated atlas — bark in one cell, four kinds of
 * foliage in the others — so every species, at every level of detail, renders with the
 * same material. That is what keeps a wooded battlefield inside the draw-call budget.
 */

/** Atlas layout: 3 columns × 2 rows of 256² cells. */
const ATLAS_COLS = 3;
const ATLAS_ROWS = 2;
const CELL_PX = 256;
export const ATLAS_W = ATLAS_COLS * CELL_PX;
export const ATLAS_H = ATLAS_ROWS * CELL_PX;

export type AtlasCell = 'bark' | 'broadleaf' | 'needle' | 'olive' | 'spire' | 'shrub';

const CELL_POS: Record<AtlasCell, [number, number]> = {
  bark: [0, 0],
  broadleaf: [1, 0],
  needle: [2, 0],
  olive: [0, 1],
  spire: [1, 1],
  shrub: [2, 1],
};

/** UV rectangle of a cell: [u0, v0, du, dv]. */
export const cellUv = (cell: AtlasCell): [number, number, number, number] => {
  const [c, r] = CELL_POS[cell];
  return [c / ATLAS_COLS, r / ATLAS_ROWS, 1 / ATLAS_COLS, 1 / ATLAS_ROWS];
};

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/**
 * Accumulator for one atlas cell. Colour is summed weighted by coverage and normalised
 * at the end rather than blended against the buffer, because blending against an empty
 * (black) buffer puts a dark rim on every leaf — which is exactly what makes procedural
 * foliage look like soot.
 */
interface CellAccum {
  rgb: Float32Array;
  weight: Float32Array;
  alpha: Float32Array;
  sum: [number, number, number];
  count: number;
}

const newAccum = (): CellAccum => ({
  rgb: new Float32Array(CELL_PX * CELL_PX * 3),
  weight: new Float32Array(CELL_PX * CELL_PX),
  alpha: new Float32Array(CELL_PX * CELL_PX),
  sum: [0, 0, 0],
  count: 0,
});

/** Stamp a soft-edged leaf ellipse into a cell accumulator. */
function stampLeaf(
  acc: CellAccum,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rot: number,
  col: [number, number, number]
): void {
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const r = Math.ceil(Math.max(rx, ry)) + 1;
  acc.sum[0] += col[0];
  acc.sum[1] += col[1];
  acc.sum[2] += col[2];
  acc.count++;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const lx = (dx * cs + dy * sn) / rx;
      const ly = (-dx * sn + dy * cs) / ry;
      const d = lx * lx + ly * ly;
      if (d > 1) continue;
      const px = Math.round(cx) + dx;
      const py = Math.round(cy) + dy;
      if (px < 0 || py < 0 || px >= CELL_PX || py >= CELL_PX) continue;
      const i = py * CELL_PX + px;
      // Coverage falls off only in the last fifth of the ellipse, so leaves have solid
      // interiors and the alpha test cuts a leaf-shaped edge rather than a soft cloud.
      const a = Math.min(1, (1 - d) * 4.5);
      const shade = 0.74 + 0.5 * (1 - d);
      acc.rgb[i * 3] += col[0] * shade * a;
      acc.rgb[i * 3 + 1] += col[1] * shade * a;
      acc.rgb[i * 3 + 2] += col[2] * shade * a;
      acc.weight[i] += a;
      if (a > acc.alpha[i]) acc.alpha[i] = a;
    }
  }
}

/**
 * Resolve an accumulator into the atlas. Uncovered pixels are filled with the cluster's
 * mean colour at zero alpha: mip generation averages RGB regardless of alpha, so leaving
 * them black would ring every distant tree with a dark halo.
 */
function resolveCell(acc: CellAccum, data: Uint8Array, cell: AtlasCell): void {
  const [c, r] = CELL_POS[cell];
  const x0 = c * CELL_PX;
  const y0 = r * CELL_PX;
  const mean: [number, number, number] = [
    acc.sum[0] / Math.max(1, acc.count),
    acc.sum[1] / Math.max(1, acc.count),
    acc.sum[2] / Math.max(1, acc.count),
  ];
  for (let py = 0; py < CELL_PX; py++) {
    for (let px = 0; px < CELL_PX; px++) {
      const i = py * CELL_PX + px;
      const o = ((y0 + py) * ATLAS_W + x0 + px) * 4;
      const w = acc.weight[i];
      if (w > 1e-4) {
        data[o] = clamp255(acc.rgb[i * 3] / w);
        data[o + 1] = clamp255(acc.rgb[i * 3 + 1] / w);
        data[o + 2] = clamp255(acc.rgb[i * 3 + 2] / w);
      } else {
        data[o] = clamp255(mean[0]);
        data[o + 1] = clamp255(mean[1]);
        data[o + 2] = clamp255(mean[2]);
      }
      data[o + 3] = clamp255(acc.alpha[i] * 255);
    }
  }
}

/**
 * Build the shared vegetation atlas. Deterministic: driven by `hash01`, so the same
 * leaves land in the same places every run.
 */
export function generateFoliageAtlas(): Uint8Array {
  const data = new Uint8Array(ATLAS_W * ATLAS_H * 4);

  // ---- bark: vertical fissured streaks, fully opaque ---------------------
  {
    const [c, r] = CELL_POS.bark;
    const x0 = c * CELL_PX;
    const y0 = r * CELL_PX;
    for (let y = 0; y < CELL_PX; y++) {
      for (let x = 0; x < CELL_PX; x++) {
        const u = x / CELL_PX;
        const v = y / CELL_PX;
        // Strongly stretched noise: bark fissures run with the grain.
        const n = tileFbm(u, v, 5, 9, 101, 0.55, 0.14) * 0.5 + 0.5;
        const fine = tileFbm(u, v, 3, 44, 102, 0.5, 0.3) * 0.5 + 0.5;
        const t = n * 0.75 + fine * 0.3;
        const o = ((y0 + y) * ATLAS_W + x0 + x) * 4;
        data[o] = clamp255(46 + t * 84);
        data[o + 1] = clamp255(37 + t * 66);
        data[o + 2] = clamp255(29 + t * 48);
        data[o + 3] = 255;
      }
    }
  }

  // ---- foliage clusters --------------------------------------------------
  const clusters: { cell: AtlasCell; leaves: number; rx: number; ry: number; spread: number; cols: [number, number, number][] }[] = [
    {
      cell: 'broadleaf',
      leaves: 210,
      rx: 15,
      ry: 9,
      spread: 0.46,
      // Holm oak: dark, slightly blue-green, with sunlit highlights on the crown.
      cols: [
        [58, 78, 42],
        [80, 104, 54],
        [108, 132, 70],
        [42, 58, 32],
      ],
    },
    {
      cell: 'needle',
      leaves: 340,
      rx: 22,
      ry: 3.4,
      spread: 0.47,
      // Umbrella pine: long needles, a deep blue-green that reads almost black against
      // a bright sky, which is exactly how a stone pine looks on a Roman skyline.
      cols: [
        [44, 62, 40],
        [62, 84, 52],
        [86, 106, 62],
        [32, 48, 30],
      ],
    },
    {
      cell: 'olive',
      leaves: 280,
      rx: 13,
      ry: 3.8,
      spread: 0.44,
      // Olive: the silver underside of the leaf is the whole point of the tree — but it is
      // *silver-green*, not white. An earlier set topped out at sRGB 190, a linear albedo
      // of 0.52, which is brighter than travertine: in a sunlit frame a quarter of every
      // olive crown clipped to white and the tree read as a snowball.
      cols: [
        [ 84,  94,  66],
        [106, 116,  86],
        [132, 140, 112],
        [ 62,  72,  52],
      ],
    },
    {
      cell: 'shrub',
      leaves: 200,
      rx: 11,
      ry: 6.5,
      spread: 0.42,
      cols: [
        [72, 86, 46],
        [98, 114, 60],
        [128, 140, 78],
        [56, 68, 38],
      ],
    },
  ];

  for (const cl of clusters) {
    const [c, r] = CELL_POS[cl.cell];
    const acc = newAccum();
    for (let i = 0; i < cl.leaves; i++) {
      const a = hash01(i, 700 + c * 13 + r * 7) * Math.PI * 2;
      // sqrt keeps the density uniform rather than piling everything in the middle.
      const rad = Math.sqrt(hash01(i, 800 + c * 13 + r * 7)) * CELL_PX * cl.spread;
      const cx = CELL_PX * 0.5 + Math.cos(a) * rad;
      const cy = CELL_PX * 0.5 + Math.sin(a) * rad * 0.92;
      const rot = hash01(i, 900 + c) * Math.PI * 2;
      const col = cl.cols[(hash01(i, 1000 + c) * cl.cols.length) | 0];
      const s = 0.7 + hash01(i, 1100 + c) * 0.7;
      stampLeaf(acc, cx, cy, cl.rx * s, cl.ry * s, rot, col);
    }
    resolveCell(acc, data, cl.cell);
  }

  // ---- cypress spire: a tall narrow flame of dense needles ---------------
  {
    const acc = newAccum();
    const cols: [number, number, number][] = [
      [48, 70, 48],
      [66, 90, 60],
      [88, 112, 74],
      [36, 54, 38],
    ];
    for (let i = 0; i < 1400; i++) {
      const t = hash01(i, 1301);
      // The spire is widest at a third of its height and comes to a point.
      const halfW = Math.sin(Math.pow(t, 0.62) * Math.PI) * CELL_PX * 0.21 + 4;
      // Lateral placement biased toward the axis, so coverage thins out toward the outline
      // and the material's alpha test carves a ragged edge. A uniform fill gave near-solid
      // alpha right up to the boundary, and a cypress rendered as a flat dark cone —
      // which is the single most obvious "tech demo" tell in any Italian landscape.
      const u = hash01(i, 1302) * 2 - 1;
      const cx = CELL_PX * 0.5 + Math.sign(u) * Math.pow(Math.abs(u), 0.62) * halfW;
      const cy = t * (CELL_PX - 8) + 4;
      const col = cols[(hash01(i, 1303) * 4) | 0];
      stampLeaf(acc, cx, cy, 7 + hash01(i, 1304) * 5, 3.5 + hash01(i, 1305) * 3, hash01(i, 1306) * 3, col);
    }
    // Sprigs breaking the outline. A cypress is not a cone: individual branchlets stand
    // clear of the mass, and a handful of them is what separates the silhouette from a
    // solid shape at any distance the tree is still geometry rather than a billboard.
    for (let i = 0; i < 90; i++) {
      const t = 0.08 + hash01(i, 1311) * 0.9;
      const halfW = Math.sin(Math.pow(t, 0.62) * Math.PI) * CELL_PX * 0.21 + 4;
      const side = hash01(i, 1312) < 0.5 ? -1 : 1;
      const cx = CELL_PX * 0.5 + side * (halfW + 1.5 + hash01(i, 1313) * 6);
      const cy = t * (CELL_PX - 8) + 4;
      const col = cols[(hash01(i, 1314) * 4) | 0];
      stampLeaf(acc, cx, cy, 5 + hash01(i, 1315) * 4, 2.2, side * (0.5 + hash01(i, 1316)), col);
    }
    resolveCell(acc, data, 'spire');
  }

  return data;
}

export function createFoliageAtlas(): THREE.DataTexture {
  const tex = new THREE.DataTexture(generateFoliageAtlas(), ATLAS_W, ATLAS_H, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Geometry building
// ---------------------------------------------------------------------------

const V = new THREE.Vector3();
const N = new THREE.Vector3();

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  idx: number[] = [];

  private push(m: THREE.Matrix4, x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): void {
    V.set(x, y, z).applyMatrix4(m);
    N.set(nx, ny, nz).transformDirection(m);
    this.pos.push(V.x, V.y, V.z);
    this.nor.push(N.x, N.y, N.z);
    this.uv.push(u, v);
  }

  /**
   * A quad in the XY plane. `pivot` is the fraction of the height below the origin, so 0
   * gives a card standing on the origin and 0.5 one centred on it.
   */
  quad(m: THREE.Matrix4, w: number, h: number, cell: AtlasCell, inset = 0.06, pivot = 0): void {
    const [u0, v0, du, dv] = cellUv(cell);
    const a = this.pos.length / 3;
    const hw = w * 0.5;
    const y0 = -h * pivot;
    const y1 = h * (1 - pivot);
    // Foliage cards are lit as if they were a rounded mass, not a flat plane: the normal
    // leans away from the card centre so a cluster reads as volume.
    const iu = u0 + du * inset;
    const iv = v0 + dv * inset;
    const su = du * (1 - inset * 2);
    const sv = dv * (1 - inset * 2);
    this.push(m, -hw, y0, 0, -0.45, 0.2, 0.87, iu, iv);
    this.push(m, hw, y0, 0, 0.45, 0.2, 0.87, iu + su, iv);
    this.push(m, hw, y1, 0, 0.45, 0.55, 0.7, iu + su, iv + sv);
    this.push(m, -hw, y1, 0, -0.45, 0.55, 0.7, iu, iv + sv);
    this.idx.push(a, a + 1, a + 2, a, a + 2, a + 3);
  }

  /** Tapered cylinder along +Y, base at y = 0, textured with bark. */
  trunk(m: THREE.Matrix4, r0: number, r1: number, h: number, seg: number, vRepeat = 1): void {
    const [u0, v0, du, dv] = cellUv('bark');
    const a = this.pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const ang = t * Math.PI * 2;
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      // Slight per-column radius wobble so the trunk is not a machined tube.
      const wob = 1 + 0.14 * Math.sin(ang * 3 + 1.1);
      this.push(m, cs * r0 * wob, 0, sn * r0 * wob, cs, 0.1, sn, u0 + du * t * 2 * vRepeat, v0 + dv * 0.02);
      this.push(m, cs * r1 * wob, h, sn * r1 * wob, cs, 0.1, sn, u0 + du * t * 2 * vRepeat, v0 + dv * 0.96);
    }
    for (let i = 0; i < seg; i++) {
      const b = a + i * 2;
      this.idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const mat4 = (): THREE.Matrix4 => new THREE.Matrix4();

/** Position/rotate/scale helper: translate, then rotate about Y, then tilt about X. */
function place(x: number, y: number, z: number, yaw: number, tilt = 0, roll = 0): THREE.Matrix4 {
  const m = mat4();
  const e = new THREE.Euler(tilt, yaw, roll, 'YXZ');
  m.makeRotationFromEuler(e);
  m.setPosition(x, y, z);
  return m;
}

export type Species = 'cypress' | 'pine' | 'oak' | 'olive' | 'willow';

export interface PlantGeometry {
  lod0: THREE.BufferGeometry;
  lod1: THREE.BufferGeometry;
  /** Nominal height in metres, used to size the billboard tier. */
  height: number;
  /** Which atlas cell the billboard tier should use for this species. */
  billboard: AtlasCell;
}

/**
 * Italian cypress. Height 9–14 m, crown barely a metre and a half wide. Built from
 * crossed spire cards: five of them read as a solid column of foliage from any angle
 * while costing ten triangles.
 */
function buildCypress(detail: boolean): THREE.BufferGeometry {
  const b = new Builder();
  const h = 12;
  b.trunk(place(0, 0, 0, 0), 0.24, 0.12, h * 0.55, detail ? 7 : 4);
  const cards = detail ? 5 : 3;
  for (let i = 0; i < cards; i++) {
    const yaw = (i / cards) * Math.PI;
    b.quad(place(0, 0.5, 0, yaw), 3.0, h - 0.5, 'spire', 0.02);
  }
  // A second, shorter set inset from the first stops the silhouette looking like a
  // cardboard cut-out when the sun is behind the tree.
  if (detail) {
    for (let i = 0; i < 3; i++) {
      const yaw = (i / 3) * Math.PI + 0.5;
      b.quad(place(0, 2.4, 0, yaw), 2.2, h - 4.2, 'spire', 0.04);
    }
  }
  return b.build();
}

/**
 * Umbrella pine (Pinus pinea). A long bare trunk, often leaning, carrying a broad flat
 * parasol of needles — the single most recognisable tree of the Roman campagna.
 */
function buildPine(detail: boolean): THREE.BufferGeometry {
  const b = new Builder();
  const h = 13.5;
  const lean = 0.06;
  b.trunk(place(0, 0, 0, 0, lean), 0.55, 0.3, h * 0.72, detail ? 8 : 5);
  const top = h * 0.72;
  const cards = detail ? 10 : 5;
  for (let i = 0; i < cards; i++) {
    const yaw = (i / cards) * Math.PI * 2 + 0.3;
    const r = 1.6 + (i % 3) * 0.9;
    const y = top - 0.5 + (i % 2) * 1.1;
    // Nearly horizontal cards, tipped up at the outer edge: the parasol.
    b.quad(place(Math.cos(yaw) * r * 0.5, y, Math.sin(yaw) * r * 0.5, yaw, -1.28), 9.0, 6.6, 'needle', 0.03, 0.5);
  }
  if (detail) {
    for (let i = 0; i < 4; i++) {
      const yaw = (i / 4) * Math.PI * 2 + 1.1;
      b.quad(place(0, top + 1.4, 0, yaw, -0.35), 6.4, 4.0, 'needle', 0.05, 0.5);
    }
    // A couple of lower limbs, as old pines keep.
    for (let i = 0; i < 2; i++) {
      const yaw = i * 2.4;
      b.trunk(place(0, h * 0.44, 0, yaw, 0, -1.0), 0.16, 0.08, 2.6, 4);
    }
  }
  return b.build();
}

/** Holm oak: a dense, dark, rounded evergreen crown on a short thick trunk. */
function buildOak(detail: boolean): THREE.BufferGeometry {
  const b = new Builder();
  const h = 10;
  b.trunk(place(0, 0, 0, 0), 0.62, 0.42, h * 0.34, detail ? 8 : 5);
  const limbs = detail ? 4 : 2;
  for (let i = 0; i < limbs; i++) {
    const yaw = (i / limbs) * Math.PI * 2 + 0.4;
    b.trunk(place(0, h * 0.32, 0, yaw, 0, -0.55), 0.3, 0.14, 3.4, 4);
  }
  const cards = detail ? 16 : 7;
  for (let i = 0; i < cards; i++) {
    const yaw = hash01(i, 41) * Math.PI * 2;
    const rad = 1.0 + hash01(i, 42) * 2.3;
    const y = h * 0.5 + hash01(i, 43) * h * 0.45;
    const s = 4.6 + hash01(i, 44) * 2.8;
    b.quad(
      place(Math.cos(yaw) * rad, y, Math.sin(yaw) * rad, yaw + 1.2, (hash01(i, 45) - 0.5) * 0.8),
      s,
      s * 0.84,
      'broadleaf',
      0.04,
      0.5
    );
  }
  return b.build();
}

/** Olive: a low gnarled trunk that splits almost at once, silver-grey crown. */
function buildOlive(detail: boolean): THREE.BufferGeometry {
  const b = new Builder();
  b.trunk(place(0, 0, 0, 0), 0.42, 0.3, 1.5, detail ? 7 : 5);
  const limbs = detail ? 3 : 2;
  for (let i = 0; i < limbs; i++) {
    const yaw = (i / limbs) * Math.PI * 2;
    b.trunk(place(Math.cos(yaw) * 0.14, 1.35, Math.sin(yaw) * 0.14, yaw, 0, -0.42), 0.2, 0.1, 2.1, 4);
  }
  // Many small cards rather than a few large ones. Eleven 4 m cards on a 5 m tree is one
  // card per face of the crown, so each card's own rectangle shows through and the tree
  // reads as a cabbage; 24 at 2 m overlap enough to give a broken, foliage-like edge.
  const cards = detail ? 24 : 8;
  for (let i = 0; i < cards; i++) {
    const yaw = hash01(i, 51) * Math.PI * 2;
    const rad = 0.5 + hash01(i, 52) * 2.0;
    const y = 2.2 + hash01(i, 53) * 2.4;
    const s = 1.8 + hash01(i, 54) * 1.4;
    b.quad(place(Math.cos(yaw) * rad, y, Math.sin(yaw) * rad, yaw + 0.9, (hash01(i, 55) - 0.5) * 0.7), s, s * 0.78, 'olive', 0.04, 0.5);
  }
  return b.build();
}

/** Riverside willow: a leaning trunk and drooping curtains of leaves. */
function buildWillow(detail: boolean): THREE.BufferGeometry {
  const b = new Builder();
  const h = 8.5;
  b.trunk(place(0, 0, 0, 0.4, 0.14), 0.5, 0.26, h * 0.5, detail ? 7 : 4);
  const cards = detail ? 12 : 5;
  for (let i = 0; i < cards; i++) {
    const yaw = hash01(i, 61) * Math.PI * 2;
    const rad = 1.2 + hash01(i, 62) * 2.8;
    const y = h * 0.55 + hash01(i, 63) * 1.8;
    // Cards hang downward from their top edge: pivot 1 puts the origin at the branch.
    b.quad(place(Math.cos(yaw) * rad, y, Math.sin(yaw) * rad, yaw + 1.0, 0.22), 4.2, 5.2, 'broadleaf', 0.05, 0.86);
  }
  return b.build();
}

/**
 * Real mature heights of the species, in metres, against which every built geometry is
 * normalised. Nothing downstream is allowed to trust the numbers baked into a builder:
 * a plant whose scale is wrong by 5× fills the whole frame with foliage and ruins every
 * other agent's screenshots, so the size is asserted here and checked at build time.
 *
 *   Italian cypress   Cupressus sempervirens   12–20 m, crown barely 1/8 of its height
 *   umbrella pine     Pinus pinea              15–20 m, parasol 8–10 m across
 *   holm oak          Quercus ilex             10–15 m, dense rounded crown
 *   olive             Olea europaea            4–6 m, wider than tall
 *   white willow      Salix alba               8–12 m on a river terrace
 */
const SPECIES_HEIGHT: Record<Species, number> = {
  cypress: 15,
  pine: 16.5,
  oak: 12,
  olive: 5,
  willow: 9.5,
};

/** Expected width/height of the crown; a cypress that is not narrow is not a cypress. */
const SPECIES_ASPECT: Record<Species, number> = {
  cypress: 0.2,
  pine: 0.62,
  oak: 0.78,
  olive: 1.15,
  willow: 0.85,
};

/**
 * Rescale a geometry to a known real height and sit its base on y = 0. Warns if the
 * result is outside anything a plant could plausibly be — that single guard catches an
 * entire class of "why is the screen full of foliage" bug at load instead of at
 * screenshot time.
 */
function normaliseHeight(geo: THREE.BufferGeometry, target: number, label: string, aspect?: number): void {
  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const h = box.max.y - box.min.y;
  if (h < 1e-4) return;
  const s = target / h;
  geo.scale(s, s, s);
  geo.translate(0, -box.min.y * s, 0);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const fb = geo.boundingBox!;
  const fh = fb.max.y - fb.min.y;
  const fw = Math.max(fb.max.x - fb.min.x, fb.max.z - fb.min.z);
  if (fh > 25 || fh < 0.05) {
    console.warn(`[terrain] ${label} normalised to an implausible ${fh.toFixed(2)} m`);
  }
  if (aspect !== undefined && Math.abs(fw / fh - aspect) > aspect * 0.75) {
    console.warn(
      `[terrain] ${label} aspect ${(fw / fh).toFixed(2)} is far from the expected ${aspect.toFixed(2)}`
    );
  }
}

export function buildSpecies(species: Species): PlantGeometry {
  const raw: Record<Species, [THREE.BufferGeometry, THREE.BufferGeometry, AtlasCell]> = {
    cypress: [buildCypress(true), buildCypress(false), 'spire'],
    pine: [buildPine(true), buildPine(false), 'needle'],
    oak: [buildOak(true), buildOak(false), 'broadleaf'],
    olive: [buildOlive(true), buildOlive(false), 'olive'],
    willow: [buildWillow(true), buildWillow(false), 'broadleaf'],
  };
  // Only the requested species is used; the others are discarded immediately so the
  // table above stays a single readable place for the mapping.
  for (const k of Object.keys(raw) as Species[]) {
    if (k !== species) {
      raw[k][0].dispose();
      raw[k][1].dispose();
    }
  }
  const [lod0, lod1, billboard] = raw[species];
  const target = SPECIES_HEIGHT[species];
  normaliseHeight(lod0, target, `${species} lod0`, SPECIES_ASPECT[species]);
  normaliseHeight(lod1, target, `${species} lod1`);
  return { lod0, lod1, height: target, billboard };
}

/** A low scrub bush: three crossed cards. Mediterranean maquis stands 1–2 m. */
export function buildBush(): THREE.BufferGeometry {
  const b = new Builder();
  for (let i = 0; i < 3; i++) {
    b.quad(place(0, 0, 0, (i / 3) * Math.PI, 0.1), 2.3, 1.5, 'shrub', 0.05);
  }
  const g = b.build();
  normaliseHeight(g, 1.4, 'bush');
  return g;
}

/** Reeds for the water's edge. Phragmites australis stands 2–3 m in a river margin. */
export function buildReeds(): THREE.BufferGeometry {
  const b = new Builder();
  for (let i = 0; i < 4; i++) {
    const yaw = (i / 4) * Math.PI;
    b.quad(place(0, 0, 0, yaw, (hash01(i, 71) - 0.5) * 0.22), 1.5, 2.2, 'shrub', 0.04);
  }
  const g = b.build();
  normaliseHeight(g, 2.3, 'reeds');
  return g;
}

/**
 * A rock: an icosahedron pushed around by noise. Unit radius, so the instance scale is
 * the boulder's real half-width in metres. Colour is baked into the vertices so rocks
 * share one untextured material.
 */
export function buildRock(seed: number): THREE.BufferGeometry {
  // Subdivision 1 (80 faces) is plenty: these are boulders a metre across seen from at
  // least a few metres away, and there are well over a thousand of them.
  const geo = new THREE.IcosahedronGeometry(1, 1).toNonIndexed();
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Two scales of displacement: broad facets, then a chipped surface.
    const d =
      1 +
      tileFbm((x + 2) * 0.19, (z + 2) * 0.19, 3, 4, seed) * 0.34 +
      tileFbm((y + 3) * 0.5, (x + 1) * 0.5, 2, 9, seed + 3) * 0.12;
    // Squash: boulders sit lower than they are wide.
    pos.setXYZ(i, x * d, y * d * 0.66, z * d);
    const shade = 0.78 + tileFbm((x + 5) * 0.7, (z + 5) * 0.7, 2, 7, seed + 9) * 0.3;
    // Travertine and tufa: warm pale grey.
    col[i * 3] = 0.52 * shade;
    col[i * 3 + 1] = 0.5 * shade;
    col[i * 3 + 2] = 0.45 * shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
