import * as THREE from 'three';
import {
  generateDetailNormal,
  generateLayer,
  generateMacroVariation,
  generateWaterNormal,
  type LayerKind,
} from './proctex';

/**
 * Assembles the ground material's texture set.
 *
 * Eight splat layers are packed into two array textures so the shader can sample any
 * layer with a dynamic index — that is what makes "pick the three strongest layers and
 * sample only those" possible. Sampling eight separate uniform samplers would need
 * either 24 unconditional fetches or a dynamic sampler index, which GLSL forbids.
 *
 *   albedo array : RGB albedo, A = surface height (for height-blending)
 *   nrm array    : RG normal.xy, B roughness, A ambient occlusion
 *
 * Layers come from `public/assets/manifest.json` where the pack has something suitable
 * and are synthesised otherwise. A missing manifest, a missing file or a decode failure
 * all fall through to the procedural path, so the game runs with no assets at all.
 */

export interface GroundLayerSpec {
  name: string;
  kind: LayerKind;
  /** Texture id in the manifest, or null to always synthesise. */
  manifestId: string | null;
  /** Metres per tile for the broad sample. */
  farScale: number;
  /** Metres per tile for the close-up sample. */
  detailScale: number;
  /** How much of the close-up sample is mixed in. 0 for structured layers like paving. */
  detailMix: number;
  /** Base roughness; modulated by surface height in the shader. */
  roughness: number;
  /**
   * Authored albedo, sRGB 0–255. The layer's own mean is divided out and replaced by
   * this, so the palette is under our control rather than the photographer's — see
   * `recolourLayer`. Linear luminance is held in 0.09–0.36, which is where real ground
   * sits; anything brighter looks chalky the moment the sun comes round.
   */
  albedo: readonly [number, number, number];
  /** Micro-contrast gain. >1 makes individual stones and blades read; 1 is neutral. */
  contrast: number;
  /** How much of the photograph's own hue variation survives the recolour, 0–1. */
  chroma: number;
  /** Added to the layer's surface height during height-blending — lets gravel win over grass. */
  heightBias: number;
}

/**
 * Layer order is fixed: the shader's rule set and the control texture both index it.
 *
 * `farScale` and `detailScale` are metres per tile. **They must stay close to the real
 * size of the thing photographed.** The CC0 ground set covers 0.5–1 m per image
 * (`tiling` in the manifest); an earlier revision ran the 1 m dry-grass thatch at 8.5 m
 * per tile, which magnified every straw eight times and turned a beautiful mat of dead
 * grass into featureless mottled brown at eye level. Two incommensurate scales per layer
 * (a ratio near 3.7, never an integer) plus the macro colour bands are what hide the
 * repeat; stretching the texture is not.
 *
 * Albedos are authored so that no two layers likely to meet share a value *or* a hue:
 * straw 0.26 yellow-ochre, meadow 0.16 green, dirt 0.15 red-brown, mud 0.08 dark, gravel
 * 0.26 cool neutral, limestone 0.38 pale cool, sand 0.32 warm pale, basalt 0.11 cold.
 *
 * **These are chromatic on purpose.** Judged against real Rome II frames the ground is
 * warm and *colourful* — green pasture, yellow-brown stubble, pale grey rock and bare
 * red-brown earth all separated in one shot — and an earlier "sun-bleached, slightly
 * desaturated" reading of the art direction collapsed the whole plain into one dust-beige
 * wash. Value separation alone is not enough; the hues have to part company too.
 */
export const GROUND_LAYERS: readonly GroundLayerSpec[] = [
  // Straw and pasture are the two states that cover most of the map, so *their* separation
  // is what a strategic camera reads. It has to be tonally close: 0.219 against 0.174
  // linear luminance, a ratio of 1.26. An earlier pair at 0.26 against 0.156 — a ratio of
  // 1.67, and further apart in saturation too — made a plain of high-contrast green and tan
  // patches that read as DPM camouflage from altitude. Real Rome II ground varies in
  // brightness and saturation far more than it varies in hue.
  { name: 'dry grass',   kind: 'dryGrass',       manifestId: 'dry-grass',       farScale: 4.3,  detailScale: 1.15, detailMix: 0.50, roughness: 0.94, albedo: [140, 128,  86], contrast: 1.32, chroma: 0.55, heightBias: 0.0 },
  { name: 'meadow grass',kind: 'meadowGrass',    manifestId: 'meadow-grass',    farScale: 3.9,  detailScale: 1.05, detailMix: 0.50, roughness: 0.92, albedo: [100, 124,  62], contrast: 1.38, chroma: 0.55, heightBias: 0.02 },
  // Redder and a stop darker than the straw above it. Pulling straw down toward pasture
  // brought it to within 20° of hue and 1.18 stops of this, at which point trodden earth and
  // burnt-off grass were the same colour and the plain lost a material rather than gaining
  // tonal cohesion. Straw against dirt must stay separated even while straw against pasture
  // closes up.
  { name: 'trampled dirt',kind: 'compactedEarth',manifestId: null,              farScale: 4.6,  detailScale: 1.30, detailMix: 0.45, roughness: 0.95, albedo: [138, 104,  76], contrast: 1.25, chroma: 0.45, heightBias: 0.06 },
  { name: 'mud',         kind: 'mud',            manifestId: 'mud',             farScale: 2.6,  detailScale: 0.72, detailMix: 0.45, roughness: 0.74, albedo: [ 88,  76,  58], contrast: 1.05, chroma: 0.35, heightBias: 0.04 },
  { name: 'gravel',      kind: 'gravel',         manifestId: 'dirt-gravel',     farScale: 2.3,  detailScale: 0.62, detailMix: 0.50, roughness: 0.96, albedo: [146, 141, 128], contrast: 1.45, chroma: 0.60, heightBias: 0.12 },
  { name: 'limestone',   kind: 'limestone',      manifestId: null,              farScale: 6.0,  detailScale: 1.70, detailMix: 0.40, roughness: 0.86, albedo: [168, 166, 152], contrast: 1.35, chroma: 0.40, heightBias: 0.22 },
  { name: 'river sand',  kind: 'sand',           manifestId: 'sand',            farScale: 2.8,  detailScale: 0.78, detailMix: 0.45, roughness: 0.88, albedo: [166, 152, 122], contrast: 1.18, chroma: 0.40, heightBias: -0.04 },
  // Consular roads were paved in basalt (silex) — a cool dark grey, not the pale
  // limestone setts the pack ships. 1.1 m per tile puts the polygons at ~35 cm, which is
  // the size they are on the surviving stretch outside the Porta Appia.
  { name: 'paving',      kind: 'cobbles',        manifestId: 'cobblestone-road',farScale: 1.1,  detailScale: 1.1,  detailMix: 0.0,  roughness: 0.80, albedo: [ 94,  94,  97], contrast: 1.30, chroma: 0.30, heightBias: 0.30 },
];

export const LAYER_COUNT = GROUND_LAYERS.length;
const ALBEDO_SIZE = 1024;
const NRM_SIZE = 512;

export interface GroundTextures {
  albedo: THREE.DataArrayTexture;
  nrm: THREE.DataArrayTexture;
  macro: THREE.DataTexture;
  detailNormal: THREE.DataTexture;
  waterNormalA: THREE.DataTexture;
  waterNormalB: THREE.DataTexture;
  /** Which layers came from the asset pack, for the boot log. */
  sourced: string[];
  dispose(): void;
}

interface ManifestTexture {
  id: string;
  maps: { albedo?: string | null; normal?: string | null; roughness?: string | null; ao?: string | null; displacement?: string | null };
  author?: string;
  license?: string;
}

interface Manifest {
  textures?: ManifestTexture[];
  models?: { id: string; path: string; category?: string; tags?: string[] }[];
}

let manifestPromise: Promise<Manifest | null> | null = null;

/** Fetch and cache the asset manifest. A missing or malformed manifest is not an error. */
export function loadManifest(): Promise<Manifest | null> {
  if (!manifestPromise) {
    manifestPromise = fetch('assets/manifest.json')
      .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : null))
      .catch(() => null);
  }
  return manifestPromise;
}

function makeCanvas(size: number): { ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(size, size);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (ctx) return { ctx };
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (ctx) return { ctx };
  }
  return null;
}

/**
 * Decode an image straight to the size we want. `resizeWidth` lets the browser decode
 * a 2048² JPEG at half resolution, which is both faster and better filtered than
 * decoding full size and scaling afterwards.
 */
async function fetchPixels(url: string | null | undefined, size: number): Promise<Uint8ClampedArray | null> {
  if (!url) return null;
  try {
    const res = await fetch(url.replace(/^\//, ''));
    if (!res.ok) return null;
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob, {
      resizeWidth: size,
      resizeHeight: size,
      resizeQuality: 'high',
    });
    const cv = makeCanvas(size);
    if (!cv) {
      bmp.close();
      return null;
    }
    cv.ctx.drawImage(bmp as unknown as CanvasImageSource, 0, 0, size, size);
    bmp.close();
    return cv.ctx.getImageData(0, 0, size, size).data;
  } catch {
    return null;
  }
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** Bilinear-free nearest resample used to lift the 512² procedural layers to 1024². */
function upsampleInto(
  src: Uint8Array,
  srcSize: number,
  dst: Uint8Array,
  dstOffset: number,
  dstSize: number
): void {
  const ratio = srcSize / dstSize;
  for (let y = 0; y < dstSize; y++) {
    const sy0 = Math.min(srcSize - 1, (y * ratio) | 0);
    const sy1 = Math.min(srcSize - 1, sy0 + 1);
    const fy = y * ratio - sy0;
    for (let x = 0; x < dstSize; x++) {
      const sx0 = Math.min(srcSize - 1, (x * ratio) | 0);
      const sx1 = Math.min(srcSize - 1, sx0 + 1);
      const fx = x * ratio - sx0;
      const o = dstOffset + (y * dstSize + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = src[(sy0 * srcSize + sx0) * 4 + c];
        const b = src[(sy0 * srcSize + sx1) * 4 + c];
        const d = src[(sy1 * srcSize + sx0) * 4 + c];
        const e = src[(sy1 * srcSize + sx1) * 4 + c];
        dst[o + c] = clamp255((a + (b - a) * fx) + ((d + (e - d) * fx) - (a + (b - a) * fx)) * fy);
      }
    }
  }
}

// sRGB transfer, tabulated: the recolour touches 8 M texels and a `Math.pow` per channel
// would cost about a second of boot on its own.
const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LIN_TO_SRGB = new Uint8Array(4096);
for (let i = 0; i < 4096; i++) {
  const c = i / 4095;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  LIN_TO_SRGB[i] = (s * 255 + 0.5) | 0;
}
const encode = (v: number): number => LIN_TO_SRGB[v <= 0 ? 0 : v >= 1 ? 4095 : (v * 4095) | 0];

/**
 * Re-centre one layer's albedo on its authored colour.
 *
 * The photograph (or the procedural substitute) supplies *structure*: which texels are
 * straw and which are the leaf lying on top of it. What it must not supply is the overall
 * colour, because two photographs of different things routinely land within a few per
 * cent of each other — the CC0 dry-grass and meadow-grass plates both average to the same
 * olive tan, and no amount of clever splatting can make two identically-coloured layers
 * read as two materials.
 *
 * So: divide out the layer's own mean, keep the relative luminance (raised to `contrast`
 * to sharpen or soften the micro-detail), keep a fraction of the chroma deviation so the
 * result is not a monochrome tint, and multiply by the target. The mean of the output is
 * the target by construction.
 */
function recolourLayer(data: Uint8Array, offset: number, count: number, spec: GroundLayerSpec): void {
  const lum = new Float32Array(count);
  const dr = new Float32Array(count);
  const dg = new Float32Array(count);
  const db = new Float32Array(count);
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let i = 0; i < count; i++) {
    const o = offset + i * 4;
    const r = SRGB_TO_LIN[data[o]];
    const g = SRGB_TO_LIN[data[o + 1]];
    const b = SRGB_TO_LIN[data[o + 2]];
    dr[i] = r;
    dg[i] = g;
    db[i] = b;
    mr += r;
    mg += g;
    mb += b;
  }
  const inv = 1 / count;
  mr = Math.max(1e-4, mr * inv);
  mg = Math.max(1e-4, mg * inv);
  mb = Math.max(1e-4, mb * inv);

  let meanL = 0;
  for (let i = 0; i < count; i++) {
    // Ratio space: each channel relative to its own mean, so a warm photograph does not
    // bias the luminance it reports.
    const r = dr[i] / mr;
    const g = dg[i] / mg;
    const b = db[i] / mb;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum[i] = l;
    dr[i] = r - l;
    dg[i] = g - l;
    db[i] = b - l;
    meanL += l;
  }
  meanL = Math.max(1e-4, meanL * inv);

  // Contrast is applied about the mean, then the whole field is renormalised so the
  // gain does not also change the layer's brightness.
  const gamma = spec.contrast;
  const POW_N = 1024;
  const POW_MAX = 6;
  const powLut = new Float32Array(POW_N + 1);
  for (let i = 0; i <= POW_N; i++) powLut[i] = Math.pow((i / POW_N) * POW_MAX, gamma);
  const powOf = (v: number): number => {
    const t = v <= 0 ? 0 : v >= POW_MAX ? POW_MAX : v;
    const f = (t / POW_MAX) * POW_N;
    const i0 = f | 0;
    const i1 = i0 < POW_N ? i0 + 1 : POW_N;
    const fr = f - i0;
    return powLut[i0] + (powLut[i1] - powLut[i0]) * fr;
  };
  let meanP = 0;
  for (let i = 0; i < count; i++) {
    const p = powOf(lum[i]);
    lum[i] = p;
    meanP += p;
  }
  const renorm = meanL / Math.max(1e-4, meanP * inv);

  const tr = SRGB_TO_LIN[spec.albedo[0]] / meanL;
  const tg = SRGB_TO_LIN[spec.albedo[1]] / meanL;
  const tb = SRGB_TO_LIN[spec.albedo[2]] / meanL;
  const k = spec.chroma;
  for (let i = 0; i < count; i++) {
    const l = lum[i] * renorm;
    const o = offset + i * 4;
    data[o] = encode(tr * (l + dr[i] * k));
    data[o + 1] = encode(tg * (l + dg[i] * k));
    data[o + 2] = encode(tb * (l + db[i] * k));
  }
}

export async function loadGroundTextures(): Promise<GroundTextures> {
  const manifest = await loadManifest();
  const byId = new Map<string, ManifestTexture>();
  for (const t of manifest?.textures ?? []) byId.set(t.id, t);

  const albedoData = new Uint8Array(ALBEDO_SIZE * ALBEDO_SIZE * 4 * LAYER_COUNT);
  const nrmData = new Uint8Array(NRM_SIZE * NRM_SIZE * 4 * LAYER_COUNT);
  const sourced: string[] = [];

  await Promise.all(
    GROUND_LAYERS.map(async (spec, layer) => {
      const entry = spec.manifestId ? byId.get(spec.manifestId) : undefined;
      const albOff = layer * ALBEDO_SIZE * ALBEDO_SIZE * 4;
      const nrmOff = layer * NRM_SIZE * NRM_SIZE * 4;

      // Roughness and AO are deliberately not fetched: a per-layer constant modulated
      // by surface height is visually indistinguishable on ground at these scales and
      // saves sixteen 2048² JPEG decodes at boot.
      const [alb, nor, disp] = entry
        ? await Promise.all([
            fetchPixels(entry.maps.albedo, ALBEDO_SIZE),
            fetchPixels(entry.maps.normal, NRM_SIZE),
            fetchPixels(entry.maps.displacement, ALBEDO_SIZE),
          ])
        : [null, null, null];

      if (!alb) {
        const proc = generateLayer(spec.kind, 17 + layer * 31);
        upsampleInto(proc.albedo, proc.size, albedoData, albOff, ALBEDO_SIZE);
        nrmData.set(proc.nrm, nrmOff);
        // Procedural layers go through the same recolour as photographed ones, so the
        // palette above is the single place layer colour is decided.
        recolourLayer(albedoData, albOff, ALBEDO_SIZE * ALBEDO_SIZE, spec);
        return;
      }

      sourced.push(spec.name);
      for (let i = 0; i < ALBEDO_SIZE * ALBEDO_SIZE; i++) {
        const o = albOff + i * 4;
        albedoData[o] = alb[i * 4];
        albedoData[o + 1] = alb[i * 4 + 1];
        albedoData[o + 2] = alb[i * 4 + 2];
        // Surface height for height-blending: the displacement map if the pack has one,
        // otherwise luma, which correlates well enough for ground materials.
        albedoData[o + 3] = disp
          ? disp[i * 4]
          : clamp255(alb[i * 4] * 0.299 + alb[i * 4 + 1] * 0.587 + alb[i * 4 + 2] * 0.114);
      }
      recolourLayer(albedoData, albOff, ALBEDO_SIZE * ALBEDO_SIZE, spec);

      if (nor) {
        for (let i = 0; i < NRM_SIZE * NRM_SIZE; i++) {
          const o = nrmOff + i * 4;
          nrmData[o] = nor[i * 4];
          nrmData[o + 1] = nor[i * 4 + 1];
          // Height sampled from the albedo array's alpha at the matching texel; used
          // for the roughness and AO modulation.
          const hx = (i % NRM_SIZE) * (ALBEDO_SIZE / NRM_SIZE);
          const hy = ((i / NRM_SIZE) | 0) * (ALBEDO_SIZE / NRM_SIZE);
          const h = albedoData[albOff + (hy * ALBEDO_SIZE + hx) * 4 + 3] / 255;
          nrmData[o + 2] = clamp255((spec.roughness + (1 - h) * 0.08) * 255);
          nrmData[o + 3] = clamp255((0.45 + h * 0.6) * 255);
        }
      } else {
        // Albedo but no normal: synthesise both from the procedural layer so the surface
        // still has relief.
        const proc = generateLayer(spec.kind, 17 + layer * 31);
        nrmData.set(proc.nrm, nrmOff);
      }
    })
  );

  const albedo = new THREE.DataArrayTexture(albedoData, ALBEDO_SIZE, ALBEDO_SIZE, LAYER_COUNT);
  albedo.format = THREE.RGBAFormat;
  albedo.type = THREE.UnsignedByteType;
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = THREE.RepeatWrapping;
  albedo.wrapT = THREE.RepeatWrapping;
  albedo.magFilter = THREE.LinearFilter;
  albedo.minFilter = THREE.LinearMipmapLinearFilter;
  albedo.generateMipmaps = true;
  // Ground is nearly always seen at a grazing angle; anisotropy is the single cheapest
  // sharpness win available on a terrain.
  albedo.anisotropy = 8;
  albedo.needsUpdate = true;

  const nrm = new THREE.DataArrayTexture(nrmData, NRM_SIZE, NRM_SIZE, LAYER_COUNT);
  nrm.format = THREE.RGBAFormat;
  nrm.type = THREE.UnsignedByteType;
  nrm.wrapS = THREE.RepeatWrapping;
  nrm.wrapT = THREE.RepeatWrapping;
  nrm.magFilter = THREE.LinearFilter;
  nrm.minFilter = THREE.LinearMipmapLinearFilter;
  nrm.generateMipmaps = true;
  nrm.anisotropy = 4;
  nrm.needsUpdate = true;

  const macro = new THREE.DataTexture(generateMacroVariation(512, 7), 512, 512, THREE.RGBAFormat);
  macro.wrapS = macro.wrapT = THREE.RepeatWrapping;
  macro.minFilter = THREE.LinearMipmapLinearFilter;
  macro.magFilter = THREE.LinearFilter;
  macro.generateMipmaps = true;
  macro.needsUpdate = true;

  const detailNormal = new THREE.DataTexture(generateDetailNormal(256, 13), 256, 256, THREE.RGBAFormat);
  detailNormal.wrapS = detailNormal.wrapT = THREE.RepeatWrapping;
  detailNormal.minFilter = THREE.LinearMipmapLinearFilter;
  detailNormal.magFilter = THREE.LinearFilter;
  detailNormal.generateMipmaps = true;
  detailNormal.needsUpdate = true;

  const mkWater = (seed: number, lattice: number): THREE.DataTexture => {
    const t = new THREE.DataTexture(generateWaterNormal(256, seed, lattice), 256, 256, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  };
  // Lattice counts chosen coprime-ish and high enough that neither layer's cell
  // structure is visible as a grid once tiled over open water.
  const waterNormalA = mkWater(3, 23);
  const waterNormalB = mkWater(23, 31);

  return {
    albedo,
    nrm,
    macro,
    detailNormal,
    waterNormalA,
    waterNormalB,
    sourced,
    dispose() {
      albedo.dispose();
      nrm.dispose();
      macro.dispose();
      detailNormal.dispose();
      waterNormalA.dispose();
      waterNormalB.dispose();
    },
  };
}
