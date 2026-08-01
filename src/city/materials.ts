import * as THREE from 'three';
import { clamp01 } from '../util/math';
import {
  basaltPaving,
  brickFace,
  detailFromRgb,
  foliageCanopy,
  graniteSpeckled,
  hammeredMetal,
  macroVariation,
  marbleVeined,
  paintedStucco,
  roofTiles,
  rubbleConcrete,
  timberPlanks,
  travertineAshlar,
  type GeneratedMaps,
} from './texgen';

/**
 * The city's material library, kept small: every extra material is an extra draw call
 * in every chunk that uses it. Albedo is the photographed or generated surface
 * mean-normalised per channel, so real mottling reaches the screen at full strength
 * while the vertex colour still sets hue and holds the palette in `palette.ts`. Keeping
 * 40 % of the chroma over a grey bump, as an earlier revision did, is why every roof was
 * one flat terracotta plane and every wall one flat cream plane.
 */

export type CityMatKey =
  | 'brick'
  | 'stone'
  | 'marble'
  | 'granite'
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
  /** Take only normal and roughness from the photograph, keep the generated albedo. */
  surfaceOnly?: boolean;
  /** Fraction of the photographed AO folded into the albedo, deepening real joints. */
  aoMix: number;
  /** World-space macro variation: brightness amount, then warm/cool amount. */
  macro: readonly [number, number];
}

/**
 * There is no brick or granite in the CC0 set, and the one called `white-marble` is a
 * cream limestone slab with no veining at all, so all three are generated. Where a
 * photograph exists it wins on surface detail, which is what `surfaceOnly` keeps when
 * only its albedo is unusable.
 */
const SPECS: Record<CityMatKey, MatSpec> = {
  brick: {
    manifestId: null,
    gen: brickFace,
    worldSize: 1.76,
    normalScale: 1.6,
    roughnessMul: 1.0,
    metalness: 0,
    side: THREE.FrontSide,
    texSize: 1024,
    aoMix: 0,
    macro: [0.3, 0.16],
  },
  stone: {
    manifestId: 'roman-travertine-blocks',
    gen: travertineAshlar,
    worldSize: 3.0,
    normalScale: 1.0,
    roughnessMul: 1.0,
    metalness: 0,
    side: THREE.FrontSide,
    texSize: 1024,
    aoMix: 0.6,
    // Higher than the rest: the biggest flat surfaces in the city are its travertine
    // precinct paving and arena floors, and they have nothing else to break them up.
    macro: [0.34, 0.17],
  },
  marble: {
    manifestId: 'white-marble',
    gen: marbleVeined,
    worldSize: 2.4,
    normalScale: 0.6,
    roughnessMul: 0.78,
    metalness: 0,
    side: THREE.FrontSide,
    texSize: 512,
    surfaceOnly: true,
    aoMix: 0.35,
    macro: [0.15, 0.07],
  },
  granite: {
    manifestId: null,
    gen: graniteSpeckled,
    worldSize: 0.6,
    normalScale: 0.7,
    roughnessMul: 0.55,
    metalness: 0,
    side: THREE.FrontSide,
    texSize: 512,
    aoMix: 0,
    macro: [0.1, 0.05],
  },
  stucco: {
    manifestId: 'painted-plaster',
    gen: paintedStucco,
    worldSize: 3.0,
    normalScale: 0.7,
    roughnessMul: 1.0,
    metalness: 0,
    side: THREE.FrontSide,
    texSize: 512,
    surfaceOnly: true,
    aoMix: 0.3,
    macro: [0.3, 0.18],
  },
  roof: {
    manifestId: 'terracotta-roof-tiles',
    gen: roofTiles,
    worldSize: 3.6,
    normalScale: 1.0,
    roughnessMul: 0.95,
    metalness: 0,
    side: THREE.FrontSide,
    texSize: 512,
    aoMix: 0.6,
    macro: [0.28, 0.2],
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
    aoMix: 0.4,
    macro: [0.18, 0.1],
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
    aoMix: 0.3,
    macro: [0.1, 0.04],
  },
  road: {
    manifestId: 'cobblestone-road',
    gen: basaltPaving,
    worldSize: 2.3,
    normalScale: 1.0,
    roughnessMul: 1.0,
    metalness: 0,
    side: THREE.FrontSide,
    texSize: 1024,
    aoMix: 0.7,
    macro: [0.34, 0.16],
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
    aoMix: 0,
    macro: [0.24, 0.12],
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
    aoMix: 0,
    macro: [0.14, 0.1],
  },
};

export const CITY_MAT_KEYS = Object.keys(SPECS) as CityMatKey[];

/** Periods of the two macro octaves, metres. */
const MACRO_METRES = [18, 5.4] as const;

const MACRO_VERT_PARS = 'varying vec3 tcWorld;\n';
const MACRO_VERT_BODY = '\ttcWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n';
const MACRO_FRAG_PARS = `
uniform sampler2D tcMacro;
uniform vec2 tcMacroScale;
uniform vec2 tcMacroAmt;
varying vec3 tcWorld;
`;
// Sampled in world space, not UV space: the UV origin is per chunk, so a UV-space macro
// steps in brightness where two stretches of the same curtain meet. Folding y into the
// horizontal lookup gives vertical faces variation along their height for one fetch.
const MACRO_FRAG_BODY = `
{
  vec3 mA = texture2D( tcMacro, ( tcWorld.xz + tcWorld.y * 0.42 ) * tcMacroScale.x ).rgb;
  float mB = texture2D( tcMacro, ( tcWorld.zx - tcWorld.y * 0.31 ) * tcMacroScale.y ).b;
  float bright = 1.0 + ( mA.r - 0.5 ) * tcMacroAmt.x + ( mB - 0.5 ) * tcMacroAmt.x * 0.6;
  float warm = ( mA.g - 0.5 ) * tcMacroAmt.y;
  diffuseColor.rgb *= max( vec3( 0.0 ), bright * vec3( 1.0 + warm * 0.9, 1.0, 1.0 - warm * 0.85 ) );
}
`;

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
  t.anisotropy = 16;
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
 * A photographed albedo ready to multiply against a vertex colour: full chroma
 * *variation* kept, only the mean cast normalised away, with the photographed AO folded
 * in rather than bound as a second sampler.
 */
function albedoToTintable(
  px: Uint8ClampedArray,
  aoPx: Uint8ClampedArray | null,
  aoMix: number,
  size: number
): { tex: THREE.DataTexture; gain: number } {
  const n = size * size;
  const lin = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let ao = 1;
    if (aoPx && aoMix > 0) ao = 1 - aoMix * (1 - srgbToLinear(aoPx[i * 4 + 1]));
    lin[i * 3] = srgbToLinear(px[i * 4]) * ao;
    lin[i * 3 + 1] = srgbToLinear(px[i * 4 + 1]) * ao;
    lin[i * 3 + 2] = srgbToLinear(px[i * 4 + 2]) * ao;
  }
  return detailFromRgb(lin, size);
}

/** Fold a photographed AO into an already-generated albedo, in place. */
function foldAoIntoAlbedo(tex: THREE.DataTexture, aoPx: Uint8ClampedArray, aoMix: number): void {
  const data = tex.image.data as Uint8Array;
  const n = Math.min(data.length, aoPx.length) / 4;
  for (let i = 0; i < n; i++) {
    const ao = 1 - aoMix * (1 - srgbToLinear(aoPx[i * 4 + 1]));
    for (let c = 0; c < 3; c++) {
      data[i * 4 + c] = linearToSrgbByte(srgbToLinear(data[i * 4 + c]) * ao);
    }
  }
  tex.needsUpdate = true;
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

/** Bytes a texture occupies once resident, mip chain included. */
function textureBytes(t: THREE.Texture): number {
  const img = t.image as { width?: number; height?: number } | undefined;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  return Math.round(w * h * 4 * (t.generateMipmaps ? 4 / 3 : 1));
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

  private macro: THREE.DataTexture | null = null;
  private readonly macroScale = new THREE.Vector2(1 / MACRO_METRES[0], 1 / MACRO_METRES[1]);

  async load(): Promise<void> {
    const manifest = this.proceduralOnly ? null : await this.fetchManifest();
    const byId = new Map<string, ManifestTextureEntry>();
    for (const t of manifest?.textures ?? []) byId.set(t.id, t);

    this.macro = macroVariation(256);
    this.textures.push(this.macro);

    for (const key of CITY_MAT_KEYS) {
      const spec = SPECS[key];
      const entry = spec.manifestId ? byId.get(spec.manifestId) : undefined;
      let mat: THREE.MeshStandardMaterial | null = null;
      if (entry?.maps?.albedo) mat = await this.fromManifest(key, spec, entry);
      if (!mat) mat = this.fromProcedural(key, spec);
      this.built.set(key, mat);
    }
  }

  /** Texture bytes this library holds resident, for the performance budget. */
  get residentTextureBytes(): number {
    let n = 0;
    for (const t of this.textures) n += textureBytes(t);
    return n;
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
    // A `surfaceOnly` spec discards the photographed albedo, so do not decode it at all.
    const albedoPx = spec.surfaceOnly || !entry.maps?.albedo ? null : await fetchPixels(entry.maps.albedo, size);
    if (!spec.surfaceOnly && !albedoPx) return null;
    const normalPx = entry.maps?.normal ? await fetchPixels(entry.maps.normal, size) : null;
    // Roughness and metalness carry no fine structure worth a full-size map.
    const ormSize = Math.max(64, size >> 1);
    const roughPx = entry.maps?.roughness ? await fetchPixels(entry.maps.roughness, ormSize) : null;
    const aoPx = spec.aoMix > 0 && entry.maps?.ao ? await fetchPixels(entry.maps.ao, size) : null;

    const generated = spec.surfaceOnly || !normalPx ? spec.gen(size) : null;
    generated?.orm.dispose();

    let albedo: THREE.Texture;
    let gain: number;
    if (albedoPx) {
      generated?.albedo.dispose();
      const d = albedoToTintable(albedoPx, aoPx, spec.aoMix, size);
      albedo = d.tex;
      gain = d.gain;
    } else if (generated) {
      if (aoPx) foldAoIntoAlbedo(generated.albedo, aoPx, spec.aoMix);
      albedo = generated.albedo;
      gain = generated.albedoGain;
    } else {
      return null;
    }

    let normal: THREE.Texture;
    if (normalPx) {
      generated?.normal.dispose();
      normal = rawToTexture(normalPx, size);
    } else if (generated) {
      normal = generated.normal;
    } else {
      return null;
    }
    const orm = packOrm(roughPx, ormSize, spec.metalness);

    this.usedManifest = true;
    if (entry.author) this.credits.push(`${entry.id} — ${entry.author} (${entry.license ?? 'see manifest'})`);
    this.textures.push(albedo, normal, orm);
    return this.assemble(key, spec, albedo, gain, normal, orm);
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
    // The map is mean-normalised, so the gain restores the intended albedo level;
    // vertex colours then supply the hue.
    mat.color.setScalar(gain);
    mat.normalScale.set(spec.normalScale, spec.normalScale);
    mat.envMapIntensity = key === 'metal' ? 1.35 : 0.9;
    if (key === 'foliage') {
      mat.envMapIntensity = 0.6;
      // Cypress and pine canopies are modelled as solid cones; two-sided shading
      // with a slight normal flattening keeps them from looking like plastic.
      mat.normalScale.set(0.4, 0.4);
    }
    this.patchMacro(mat, spec);
    return mat;
  }

  /** Assigned before the mesh reaches the scene, so `LightingSystem` chains onto it. */
  private patchMacro(mat: THREE.MeshStandardMaterial, spec: MatSpec): void {
    const macro = this.macro;
    if (!macro || (spec.macro[0] <= 0 && spec.macro[1] <= 0)) return;
    const amount = new THREE.Vector2(spec.macro[0], spec.macro[1]);
    const scale = this.macroScale;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.tcMacro = { value: macro };
      shader.uniforms.tcMacroScale = { value: scale };
      shader.uniforms.tcMacroAmt = { value: amount };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${MACRO_VERT_PARS}`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n${MACRO_VERT_BODY}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${MACRO_FRAG_PARS}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${MACRO_FRAG_BODY}`);
    };
    mat.customProgramCacheKey = () => 'city-macro-v1';
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
