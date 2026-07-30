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
  /** Albedo multiplier, used to pull pack textures toward the Roman campagna palette. */
  tint: readonly [number, number, number];
  /** Added to the layer's surface height during height-blending — lets gravel win over grass. */
  heightBias: number;
}

/**
 * Layer order is fixed: the shader's rule set and the control texture both index it.
 * Scales are in metres per tile, chosen from the real size of the thing depicted —
 * a 2048² grass photo covers about eight metres of ground, paving stones about a third
 * of a metre each.
 */
export const GROUND_LAYERS: readonly GroundLayerSpec[] = [
  // The pack's "dry grass" is a pinkish tan that reads as bare dirt; the tint pulls it
  // back to the olive-straw of an Italian pasture at the end of summer.
  { name: 'dry grass',   kind: 'dryGrass',       manifestId: 'dry-grass',       farScale: 8.5,  detailScale: 1.9,  detailMix: 0.42, roughness: 0.94, tint: [0.84, 0.86, 0.56], heightBias: 0.0 },
  { name: 'meadow grass',kind: 'meadowGrass',    manifestId: 'meadow-grass',    farScale: 7.5,  detailScale: 1.7,  detailMix: 0.42, roughness: 0.92, tint: [0.82, 0.94, 0.62], heightBias: 0.02 },
  { name: 'trampled dirt',kind: 'compactedEarth',manifestId: null,              farScale: 6.0,  detailScale: 1.35, detailMix: 0.40, roughness: 0.95, tint: [1.02, 0.94, 0.80], heightBias: 0.06 },
  { name: 'mud',         kind: 'mud',            manifestId: 'mud',             farScale: 5.0,  detailScale: 1.15, detailMix: 0.38, roughness: 0.74, tint: [0.90, 0.84, 0.70], heightBias: 0.04 },
  { name: 'gravel',      kind: 'gravel',         manifestId: 'dirt-gravel',     farScale: 4.4,  detailScale: 1.0,  detailMix: 0.40, roughness: 0.96, tint: [0.98, 0.92, 0.80], heightBias: 0.12 },
  { name: 'limestone',   kind: 'limestone',      manifestId: null,              farScale: 11.0, detailScale: 2.5,  detailMix: 0.36, roughness: 0.86, tint: [1.06, 1.02, 0.94], heightBias: 0.22 },
  { name: 'river sand',  kind: 'sand',           manifestId: 'sand',            farScale: 5.5,  detailScale: 1.25, detailMix: 0.38, roughness: 0.88, tint: [1.08, 1.00, 0.88], heightBias: -0.04 },
  // Consular roads were paved in basalt (silex) — a cool dark grey, not the pale
  // limestone cobbles the pack ships.
  { name: 'paving',      kind: 'cobbles',        manifestId: 'cobblestone-road',farScale: 3.4,  detailScale: 3.4,  detailMix: 0.0,  roughness: 0.80, tint: [0.56, 0.57, 0.60], heightBias: 0.30 },
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
        return;
      }

      sourced.push(spec.name);
      const [tr, tg, tb] = spec.tint;
      for (let i = 0; i < ALBEDO_SIZE * ALBEDO_SIZE; i++) {
        const r = alb[i * 4] * tr;
        const g = alb[i * 4 + 1] * tg;
        const b = alb[i * 4 + 2] * tb;
        // A touch of desaturation across the board: the Rome II palette is dusty, and
        // photographic ground textures are almost always too saturated for it.
        const luma = r * 0.299 + g * 0.587 + b * 0.114;
        const o = albOff + i * 4;
        albedoData[o] = clamp255(r + (luma - r) * 0.07);
        albedoData[o + 1] = clamp255(g + (luma - g) * 0.07);
        albedoData[o + 2] = clamp255(b + (luma - b) * 0.07);
        // Surface height for height-blending: the displacement map if the pack has one,
        // otherwise luma, which correlates well enough for ground materials.
        albedoData[o + 3] = disp ? disp[i * 4] : clamp255(luma);
      }

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
