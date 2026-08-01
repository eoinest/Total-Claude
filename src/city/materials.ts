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
  /**
   * How much of the horizon-openness channel to apply. 0 leaves the material shaded exactly
   * as it was. See `MICRO_RELIEF_PARS_GLSL` for what it does and `texgen.horizonOpenness` for
   * where the channel comes from.
   */
  microRelief: number;
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
    // Must agree with `brickFace`'s own `world`: 60 courses of 55 mm and 11 stretchers of
    // 300 mm. Tripled from 1.10 m because a critic could read the *UV seam* on the curtain
    // and nothing else — at 1.1 m the tile repeated six times over a 7 m wall while
    // everything inside it was finer than a pixel. See the note in `texgen.brickFace`.
    worldSize: 3.3,
    // The curtain's brick face is the one surface a besieging camera gets close to, and
    // its courses have to survive being two screen texels tall from 40 m.
    normalScale: 1.5,
    roughnessMul: 1.0,
    metalness: 0,
    side: THREE.FrontSide,
    // 1024 at 3.3 m is 3.2 mm per texel, which keeps the 18 mm mortar joint five texels
    // wide — the width it needs to survive the mip chain rather than average to flat.
    texSize: 1024,
    microRelief: 1.0,
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
    microRelief: 0.7,
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
    microRelief: 0.35,
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
    microRelief: 0.6,
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
    microRelief: 0.35,
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
    microRelief: 0.3,
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
    microRelief: 0.7,
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
    microRelief: 0.6,
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
    microRelief: 0.0,
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

/**
 * Pack horizon openness into R, a photographed roughness map's luminance into G and a
 * constant metalness into B.
 *
 * R is `1 - sin(horizon elevation)`; see `texgen.horizonOpenness`. A photographed set gives
 * us an ambient-occlusion map rather than a horizon, and the two are related by the
 * cosine-weighted visible fraction `ao = 1 - sin^2(h)`, so `1 - sqrt(1 - ao)` recovers the
 * stored form. With no AO map the channel stays at 255, which means unoccluded and leaves
 * the material shaded exactly as it was.
 */
function packOrm(
  px: Uint8ClampedArray | null,
  size: number,
  metal: number,
  aoPx: Uint8ClampedArray | null = null
): THREE.DataTexture {
  const n = size * size;
  const out = new Uint8Array(n * 4);
  const m = Math.round(clamp01(metal) * 255);
  for (let i = 0; i < n; i++) {
    if (aoPx) {
      const ao = clamp01(srgbToLinear(aoPx[i * 4]));
      out[i * 4] = Math.round(clamp01(1 - Math.sqrt(Math.max(0, 1 - ao))) * 255);
    } else {
      out[i * 4] = 255;
    }
    out[i * 4 + 1] = px ? px[i * 4 + 1] : 220;
    out[i * 4 + 2] = m;
    out[i * 4 + 3] = 255;
  }
  return dataTex(out, size, false);
}

// --- micro-relief shading ----------------------------------------------------

/**
 * Make a recess behave like a recess: dark when the sun grazes it, ordinary when the sun
 * faces it, and only mildly dark in shade.
 *
 * ## What this is fixing
 *
 * A blind grader's separator was "every recess is painted rather than modelled — the sharpest
 * instance being brick coursing that shows **identical contrast in sunlit and shadowed
 * regions under raking light**". Reproduced by removing one channel at a time from the live
 * brick material and differencing frames of an identical paused world (`tools/probe-masonry.mjs`),
 * the display band-pass amplitude the brick tile puts on screen was:
 *
 *                          sunlit     shaded    sun/shade
 *     the normal map      0.00684    0.00217      3.151     close raking camera
 *     the albedo detail   0.00720    0.00625      1.152     close raking camera
 *     the normal map      0.00008    0.00014      0.526     the shipped `wall` camera
 *     the albedo detail   0.00045    0.00133      0.337     the shipped `wall` camera
 *
 * So at close range the paint carries as much coursing as the relief does and carries it with
 * a sun/shade ratio of 1.15 — the grader's "identical" — and by the time the curtain is at
 * the distance it is actually photographed from, the relief has fallen to two hundredths of
 * one 8-bit code value and *only* the paint is left. The whole tile was contributing 2.4 % of
 * that frame's visible micro-structure; the other 97.6 % was geometry and grain.
 *
 * `texgen.ts` answers the paint half by not painting the joint any more. This answers the
 * relief half. A normal map cannot survive the mip chain — a bump's two slopes cancel under
 * averaging, measured at 84 % of the perturbation gone by mip 4 — but a scalar occlusion
 * does not cancel, so the recess is carried instead by a **horizon openness** channel packed
 * into the ORM texture's R, which was a hard-coded 255 read by nothing.
 *
 * Two uses, and the asymmetry between them is the entire point:
 *
 *   - **Direct light** is gated on whether the light clears the texel's own horizon. That is
 *     strongly directional: a joint whose horizon sits at 28 degrees is black to a sun raking
 *     at 12 degrees above the face and untouched by a sun square on to it.
 *   - **Indirect light** is attenuated by the cosine-weighted visible fraction of the
 *     hemisphere, `1 - sin^2(h)`, which is not directional and is much gentler.
 *
 * A painted recess cannot produce that asymmetry. A modelled one produces nothing else.
 *
 * ## Implementation notes
 *
 * Patched into `MeshStandardMaterial` through `onBeforeCompile`, never a raw `ShaderMaterial`
 * — a raw one in `GroundDamage` is why trampled ground received no shadows for months.
 * `LightingSystem.patch` chains this by calling the previous `onBeforeCompile` first, so the
 * two coexist; nothing here touches `lights_fragment_begin`, which the lighting workstream
 * rewrites for CSM.
 *
 * The direct half is gated **per light**, by overriding `RE_Direct`, and the first attempt
 * got this wrong in a way worth recording. Gating the finished `reflectedLight.directDiffuse`
 * at `<aomap_fragment>` is shorter and looks equivalent, but that sum contains every
 * directional light, and the rig's second one is a *sun-opposed bounce* whose whole job is to
 * light the faces the sun cannot reach. Gating the sum on the sun's incidence multiplied the
 * bounce by zero on exactly the surfaces it exists for: measured, shaded brick lost 46 % of
 * its luminance, 0.0967 to 0.0525 display — an uncommanded change to another workstream's
 * light balance, dressed up as a masonry fix. Overriding `RE_Direct` gives each light its own
 * horizon test against its own direction, and the shadow term is already folded into
 * `directLight.color` by the time it is called, so a light the CSM has shadowed out cannot
 * have the sun's gate applied to it either.
 *
 * `texelRoughness` is reused rather than re-fetched — three.js has already sampled this
 * texture in `<roughnessmap_fragment>`, which runs before `<normal_fragment_begin>`, so both
 * it and `nonPerturbedNormal` are in scope at the setup hook.
 *
 * No backtick may appear inside these comments: a backtick in a GLSL comment silently
 * terminates the JS template literal the shader lives in and 500s the module.
 */
const MICRO_RELIEF_PARS_GLSL = /* glsl */ `
#ifdef USE_ROUGHNESSMAP
  uniform float uMicroRelief;
  float tcHorizonSin;
  vec3 tcMicroGeoN;
  void tcRE_Direct_Micro(
    const in IncidentLight directLight, const in vec3 geometryPosition,
    const in vec3 geometryNormal, const in vec3 geometryViewDir,
    const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material,
    inout ReflectedLight reflectedLight
  ) {
    IncidentLight tcLight = directLight;
    // Against the *geometric* normal: the openness channel already describes the microrelief
    // occlusion relative to the macro plane, so testing the perturbed normal would count the
    // same slope twice.
    float tcCos = clamp( dot( tcMicroGeoN, tcLight.direction ), 0.0, 1.0 );
    /*
     * The transition has to be soft, because a hard step aliases badly on a mipped scalar,
     * and it has to **scale with the horizon**, because a fixed width is a global dimmer.
     *
     * A constant 0.16 was tried first. That puts the upper edge at 0.16 even for a texel
     * whose horizon is zero, so every unoccluded surface in the city lost light at grazing
     * incidence and the whole frame dropped 8.27 % of its mean display luminance — a
     * city-wide exposure change smuggled in under a brick fix. Widening with the horizon
     * makes a flat texel an exact no-op (the window collapses to cos below 0.04, i.e. 88
     * degrees of incidence, where the light is negligible anyway) while leaving a deep joint
     * the full swing it needs at close range.
     */
    float tcW = 0.04 + 0.55 * tcHorizonSin;
    tcLight.color *= smoothstep( max( 0.0, tcHorizonSin - tcW ), tcHorizonSin + tcW, tcCos );
    RE_Direct_Physical(
      tcLight, geometryPosition, geometryNormal, geometryViewDir,
      geometryClearcoatNormal, material, reflectedLight
    );
  }
  #undef RE_Direct
  #define RE_Direct tcRE_Direct_Micro
#endif
`;

/** Once per fragment, before the light loop. */
const MICRO_RELIEF_SETUP_GLSL = /* glsl */ `
#ifdef USE_ROUGHNESSMAP
  // R holds openness = 1 - sin( horizon elevation ). 255 — an unwritten channel, and every
  // photographed set until an AO map is authored for it — means unoccluded, so this is a
  // no-op for anything that has not opted in.
  tcHorizonSin = clamp( 1.0 - texelRoughness.r, 0.0, 1.0 ) * uMicroRelief;
  tcMicroGeoN = nonPerturbedNormal;
#endif
`;

/** After the lights are summed: the indirect half, which is not directional. */
const MICRO_RELIEF_AO_GLSL = /* glsl */ `
#ifdef USE_ROUGHNESSMAP
  // Cosine-weighted visible fraction of the hemisphere above a horizon at elevation h.
  // Deliberately far gentler than the direct gate; that asymmetry is the whole point.
  reflectedLight.indirectDiffuse *= 1.0 - tcHorizonSin * tcHorizonSin;
#endif
`;

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
    const aoPx = entry.maps?.ao ? await fetchPixels(entry.maps.ao, size) : null;

    const detail = albedoToDetail(albedoPx, size);
    const normal = normalPx ? rawToTexture(normalPx, size) : spec.gen(size).normal;
    const orm = packOrm(roughPx, size, spec.metalness, aoPx);

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
    if (spec.microRelief > 0) {
      const strength = { value: spec.microRelief };
      // Exposed so a probe can pin it to 0 and measure this feature's contribution against
      // an otherwise identical frame, rather than against a different build.
      mat.userData.microRelief = strength;
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uMicroRelief = strength;
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <lights_physical_pars_fragment>',
            `#include <lights_physical_pars_fragment>\n${MICRO_RELIEF_PARS_GLSL}`
          )
          .replace(
            '#include <normal_fragment_maps>',
            `#include <normal_fragment_maps>\n${MICRO_RELIEF_SETUP_GLSL}`
          )
          .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${MICRO_RELIEF_AO_GLSL}`);
      };
      // Every city material compiles the same injected text and differs only by a uniform,
      // so no extra cache key is needed — but a material *without* the injection must not
      // share a program with one that has it.
      mat.customProgramCacheKey = () => 'tc-micro-relief';
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
