import * as THREE from 'three';
import { clamp01 } from '../util/math';
import {
  basaltPaving,
  brickFace,
  foliageCanopy,
  hammeredMetal,
  paintedStucco,
  roofTiles,
  rubbleConcrete,
  timberPlanks,
  travertineAshlar,
  type GeneratedMaps,
} from './texgen';

/**
 * The city's material library — deliberately small, because every extra material is
 * an extra draw call in every spatial chunk that uses it.
 *
 * Design decision: **albedo colour lives in vertex colours, not textures.** Each
 * material carries a mean-normalised luminance *detail* map, a normal map and a
 * packed roughness/metalness map; the actual hue comes from the per-vertex colour
 * written by the geometry builders. That buys three things at once — a controllable
 * Roman palette (painted stucco in reds and ochres, not photographic grey), free
 * per-building and per-brick variation with no new textures, and one material
 * covering every travertine surface in the city.
 *
 * If `public/assets/manifest.json` is present we take the *normal* and *roughness*
 * from the photographed CC0 sets (real surface detail beats procedural noise) and
 * still normalise their albedo into a colourless detail map. With an empty asset
 * folder everything falls back to `texgen.ts`.
 */

export type CityMatKey =
  | 'brick'
  | 'stone'
  | 'stucco'
  | 'roof'
  | 'timber'
  | 'metal'
  | 'road'
  | 'concrete'
  | 'foliage';

interface ManifestTextureEntry {
  id: string;
  maps?: {
    albedo?: string | null;
    normal?: string | null;
    roughness?: string | null;
    ao?: string | null;
    displacement?: string | null;
  };
  author?: string;
  license?: string;
}

interface Manifest {
  textures?: ManifestTextureEntry[];
}

interface MatSpec {
  /** Manifest texture id to prefer, if it exists. */
  manifestId: string | null;
  /** Procedural generator, always available. */
  gen: (size?: number) => GeneratedMaps;
  /** Metres of surface covered by one UV repeat. */
  worldSize: number;
  normalScale: number;
  roughnessMul: number;
  metalness: number;
  side: THREE.Side;
  /** Resample size for manifest images; brick and stone are seen close up. */
  texSize: number;
}

/**
 * Note there is no brick texture in the CC0 set, which is fine: the Aurelian
 * curtain's *opus testaceum* face is the one surface the camera gets close to, and
 * a procedurally laid brick bond with the correct 55 mm course pitch reads far
 * better than any tiled photograph of modern brickwork.
 */
const SPECS: Record<CityMatKey, MatSpec> = {
  brick: {
    manifestId: null,
    gen: brickFace,
    worldSize: 1.1,
    normalScale: 1.15,
    roughnessMul: 1.0,
    metalness: 0,
    side: THREE.FrontSide,
    texSize: 512,
  },
  stone: {
    manifestId: 'roman-travertine-blocks',
    gen: travertineAshlar,
    worldSize: 2.3,
    normalScale: 0.95,
    roughnessMul: 1.0,
    metalness: 0,
    side: THREE.FrontSide,
    texSize: 512,
  },
  stucco: {
    manifestId: 'painted-plaster',
    gen: paintedStucco,
    worldSize: 3.2,
    normalScale: 0.7,
    roughnessMul: 1.0,
    metalness: 0,
    side: THREE.FrontSide,
    texSize: 256,
  },
  roof: {
    manifestId: 'terracotta-roof-tiles',
    gen: roofTiles,
    worldSize: 1.35,
    normalScale: 1.0,
    roughnessMul: 0.95,
    metalness: 0,
    side: THREE.FrontSide,
    texSize: 512,
  },
  timber: {
    manifestId: 'weathered-wood-planks',
    gen: timberPlanks,
    worldSize: 1.6,
    normalScale: 0.9,
    roughnessMul: 1.0,
    metalness: 0,
    side: THREE.FrontSide,
    texSize: 256,
  },
  metal: {
    manifestId: 'worn-iron',
    gen: hammeredMetal,
    worldSize: 1.2,
    normalScale: 0.8,
    roughnessMul: 1.0,
    metalness: 0.85,
    side: THREE.FrontSide,
    texSize: 256,
  },
  road: {
    manifestId: 'cobblestone-road',
    gen: basaltPaving,
    worldSize: 3.0,
    normalScale: 0.85,
    roughnessMul: 1.0,
    metalness: 0,
    side: THREE.FrontSide,
    texSize: 256,
  },
  concrete: {
    manifestId: null,
    gen: rubbleConcrete,
    worldSize: 2.0,
    normalScale: 1.1,
    roughnessMul: 1.0,
    metalness: 0,
    side: THREE.FrontSide,
    texSize: 256,
  },
  foliage: {
    manifestId: null,
    gen: foliageCanopy,
    worldSize: 1.4,
    normalScale: 0.6,
    roughnessMul: 1.0,
    metalness: 0,
    side: THREE.DoubleSide,
    texSize: 128,
  },
};

export const CITY_MAT_KEYS = Object.keys(SPECS) as CityMatKey[];

// --- image helpers ----------------------------------------------------------

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Downsample a source image into raw RGBA at `size`, or null if it will not load. */
async function fetchPixels(url: string, size: number): Promise<Uint8ClampedArray | null> {
  const img = await loadImage(url);
  if (!img || !img.naturalWidth) return null;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0, size, size);
  try {
    return g.getImageData(0, 0, size, size).data;
  } catch {
    // Tainted canvas (should not happen for same-origin assets) — fall back.
    return null;
  }
}

function dataTex(data: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

const srgbToLinear = (b: number): number => {
  const c = b / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const linearToSrgbByte = (v: number): number => {
  const c = clamp01(v);
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
};

/**
 * Strip the overall colour cast out of a photographed albedo, leaving surface
 * *detail* that multiplies cleanly with a vertex colour. 40 % of the original chroma
 * is retained so brick still varies warm-to-cool brick to brick.
 */
function albedoToDetail(px: Uint8ClampedArray, size: number): { tex: THREE.DataTexture; gain: number } {
  const n = size * size;
  const lin = new Float32Array(n * 3);
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    const r = srgbToLinear(px[i * 4]);
    const g = srgbToLinear(px[i * 4 + 1]);
    const b = srgbToLinear(px[i * 4 + 2]);
    lin[i * 3] = r;
    lin[i * 3 + 1] = g;
    lin[i * 3 + 2] = b;
    mr += r;
    mg += g;
    mb += b;
  }
  mr = Math.max(1e-4, mr / n);
  mg = Math.max(1e-4, mg / n);
  mb = Math.max(1e-4, mb / n);
  const keepChroma = 0.4;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const r = lin[i * 3] / mr;
    const g = lin[i * 3 + 1] / mg;
    const b = lin[i * 3 + 2] / mb;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const cr = l + (r - l) * keepChroma;
    const cg = l + (g - l) * keepChroma;
    const cb = l + (b - l) * keepChroma;
    lin[i * 3] = cr;
    lin[i * 3 + 1] = cg;
    lin[i * 3 + 2] = cb;
    if (cr > max) max = cr;
    if (cg > max) max = cg;
    if (cb > max) max = cb;
  }
  // Normalised so the brightest texel is 1.0 — the gain goes into material.color.
  const scale = max > 1e-4 ? 1 / max : 1;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = linearToSrgbByte(lin[i * 3] * scale);
    out[i * 4 + 1] = linearToSrgbByte(lin[i * 3 + 1] * scale);
    out[i * 4 + 2] = linearToSrgbByte(lin[i * 3 + 2] * scale);
    out[i * 4 + 3] = 255;
  }
  return { tex: dataTex(out, size, true), gain: 1 / scale };
}

function rawToTexture(px: Uint8ClampedArray, size: number): THREE.DataTexture {
  const out = new Uint8Array(px.length);
  out.set(px);
  return dataTex(out, size, false);
}

/** Pack a photographed roughness map's luminance into G and a constant metalness into B. */
function packOrm(px: Uint8ClampedArray | null, size: number, metal: number): THREE.DataTexture {
  const n = size * size;
  const out = new Uint8Array(n * 4);
  const m = Math.round(clamp01(metal) * 255);
  for (let i = 0; i < n; i++) {
    out[i * 4] = 255;
    out[i * 4 + 1] = px ? px[i * 4 + 1] : 220;
    out[i * 4 + 2] = m;
    out[i * 4 + 3] = 255;
  }
  return dataTex(out, size, false);
}

// --- library ----------------------------------------------------------------

export class CityMaterials {
  private readonly built = new Map<CityMatKey, THREE.MeshStandardMaterial>();
  private readonly textures: THREE.Texture[] = [];
  /** Attribution collected from the manifest, surfaced for ASSETS.md. */
  readonly credits: string[] = [];
  /** True when at least one photographed set was found. */
  usedManifest = false;

  /** Force the procedural path, ignoring any manifest. Used to verify the empty-assets
   *  case without deleting anything from `public/`. */
  proceduralOnly = false;

  async load(): Promise<void> {
    const manifest = this.proceduralOnly ? null : await this.fetchManifest();
    const byId = new Map<string, ManifestTextureEntry>();
    for (const t of manifest?.textures ?? []) byId.set(t.id, t);

    for (const key of CITY_MAT_KEYS) {
      const spec = SPECS[key];
      const entry = spec.manifestId ? byId.get(spec.manifestId) : undefined;
      let mat: THREE.MeshStandardMaterial | null = null;
      if (entry?.maps?.albedo) mat = await this.fromManifest(key, spec, entry);
      if (!mat) mat = this.fromProcedural(key, spec);
      this.built.set(key, mat);
    }
  }

  private async fetchManifest(): Promise<Manifest | null> {
    // A missing manifest is expected and non-fatal; the city must run on nothing.
    // Absolute first: a relative path resolves against the *page*, which is wrong for
    // anything served from a subdirectory.
    for (const url of ['/assets/manifest.json', 'assets/manifest.json']) {
      try {
        const r = await fetch(url, { cache: 'force-cache' });
        if (!r.ok) continue;
        return (await r.json()) as Manifest;
      } catch {
        /* try the next candidate */
      }
    }
    return null;
  }

  private async fromManifest(
    key: CityMatKey,
    spec: MatSpec,
    entry: ManifestTextureEntry
  ): Promise<THREE.MeshStandardMaterial | null> {
    const size = spec.texSize;
    const albedoPx = entry.maps?.albedo ? await fetchPixels(entry.maps.albedo, size) : null;
    if (!albedoPx) return null;
    const normalPx = entry.maps?.normal ? await fetchPixels(entry.maps.normal, size) : null;
    const roughPx = entry.maps?.roughness ? await fetchPixels(entry.maps.roughness, size) : null;

    const detail = albedoToDetail(albedoPx, size);
    const normal = normalPx ? rawToTexture(normalPx, size) : spec.gen(size).normal;
    const orm = packOrm(roughPx, size, spec.metalness);

    this.usedManifest = true;
    if (entry.author) this.credits.push(`${entry.id} — ${entry.author} (${entry.license ?? 'see manifest'})`);
    this.textures.push(detail.tex, normal, orm);
    return this.assemble(key, spec, detail.tex, detail.gain, normal, orm);
  }

  private fromProcedural(key: CityMatKey, spec: MatSpec): THREE.MeshStandardMaterial {
    const g = spec.gen(spec.texSize);
    this.textures.push(g.albedo, g.normal, g.orm);
    return this.assemble(key, spec, g.albedo, g.albedoGain, g.normal, g.orm);
  }

  private assemble(
    key: CityMatKey,
    spec: MatSpec,
    albedo: THREE.Texture,
    gain: number,
    normal: THREE.Texture,
    orm: THREE.Texture
  ): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      name: `city-${key}`,
      map: albedo,
      normalMap: normal,
      roughnessMap: orm,
      metalnessMap: orm,
      vertexColors: true,
      roughness: spec.roughnessMul,
      metalness: spec.metalness > 0 ? 1 : 0,
      side: spec.side,
      dithering: true, // large flat stucco faces band badly without it
    });
    // The detail map is mean-normalised, so the gain restores the intended albedo
    // level; vertex colours then supply the hue.
    mat.color.setScalar(gain);
    mat.normalScale.set(spec.normalScale, spec.normalScale);
    mat.envMapIntensity = key === 'metal' ? 1.35 : 0.9;
    if (key === 'foliage') {
      mat.envMapIntensity = 0.6;
      // Cypress and pine canopies are modelled as solid cones; two-sided shading
      // with a slight normal flattening keeps them from looking like plastic.
      mat.normalScale.set(0.4, 0.4);
    }
    return mat;
  }

  get(key: CityMatKey): THREE.MeshStandardMaterial {
    const m = this.built.get(key);
    if (!m) throw new Error(`[city] material "${key}" requested before load()`);
    return m;
  }

  /** Metres covered by one UV repeat — geometry builders divide world size by this. */
  worldSize(key: CityMatKey): number {
    return SPECS[key].worldSize;
  }

  dispose(): void {
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
    for (const m of this.built.values()) m.dispose();
    this.built.clear();
  }
}
