import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';
import type { GroundTextures } from './groundTextures';
import { HALF_EXTENT } from './topography';
import type { TerrainSystem } from './TerrainSystem';

/**
 * Open water, for any map that declares some.
 *
 * This was `RiverWater`, a ribbon of geometry built along `riverCentreX` — the Tiber's
 * meander train — which made the Tiber the only thing in the engine that could render as
 * water. Carthage then shipped a gulf, a lagoon and two harbour basins as *terrain below the
 * datum painted by the splat*, and the owner's report on it was "I see the ocean but no
 * lagoon, it's just the beach": a flat desaturated diffuse surface with no specular, no
 * animation and no depth cue reads as wet sand under a low sun, which is precisely the case
 * a specular surface wins hardest.
 *
 * So the centreline is gone and a map declares a `WaterProfile` instead. Two things make
 * that cheap enough to be worth doing:
 *
 *  - **The wetted extent comes out of the heightfield, not out of an authored polygon.**
 *    Water is wherever the bed is under the map's `waterLevel`, tested per pixel against the
 *    same height texture and the same edge-drift the terrain material uses, so the shoreline
 *    sits exactly on the bed contour at any zoom and no map can declare a coast that
 *    disagrees with its own topography. The mesh is only a carrier for those pixels.
 *
 *  - **It is one draw call for every water body on a map.** The carrier is a single indexed
 *    mesh: a 16 m grid over the battlefield with the dry cells left out, a coarse ring
 *    outside it so the sea runs to the horizon rather than stopping at the map edge, and any
 *    authored basins welded into the same buffers with their surface height and depth per
 *    vertex. Nothing here is a second pass, a second camera or a render target.
 *
 * Everything else happens in the fragment shader:
 *
 *  - Depth is read from the heightfield texture, not from the depth buffer. That is both
 *    exact and always available: the water knows the bed's real elevation, so absorption,
 *    the shoreline and the foam line all follow the actual bathymetry. If the post chain
 *    does publish a depth texture it is used *in addition*, to soften the surface against
 *    soldiers standing in the shallows — geometry the heightfield knows nothing about.
 *
 *  - Two normal maps scroll at different speeds and scales; their beat gives a surface that
 *    never reads as a looping texture. A river advects both downstream; a sea rolls a swell
 *    shoreward instead, so still water still moves.
 *
 *  - Reflection is Fresnel-weighted. `MeshStandardMaterial` already does that against
 *    `scene.environment`, which `SkySystem` keeps current, and a horizon-graded analytic
 *    term is added on top of it so the sky is right in the mirror direction even where the
 *    PMREM is coarse.
 */

/** A still basin the heightfield cannot see, because its bed is built geometry. */
export interface WaterBasin {
  /**
   * Plan shape. A disc with a non-zero `innerR` is an annulus — the cothon's ring of water
   * round its admiralty island.
   */
  readonly shape:
    | { readonly kind: 'disc'; readonly x: number; readonly z: number; readonly outerR: number; readonly innerR?: number }
    | { readonly kind: 'rect'; readonly x: number; readonly z: number; readonly hw: number; readonly hd: number };
  /**
   * Surface height in world metres. **Absolute, not an offset from the ground.**
   *
   * It was `dy`, added to `heightAt(centre)`, on the reasoning that a quay is built at ground
   * level and the water sits a freeboard below it. That is true of the quay and false of the
   * water: Carthage's two basins join the Mediterranean through 21 m channels, and one ground
   * sample at +0.34 and another at +1.76 gave them surfaces at −1.46 and −0.04 against a sea
   * at 0. Connected water is at one height by definition, and that height is a property of
   * the sea and not of the bed under the middle of the basin — which for the cothon is not
   * bed at all, it is the admiralty island. Take it from the quay builder's own constant
   * (`harbour.ts:BASIN_WATER_Y`) so the plate and the surface cannot drift apart.
   */
  readonly y: number;
  /** Water depth. The heightfield here is at quay level, so it cannot supply one. */
  readonly depth: number;
}

/** One scrolling normal layer. */
export interface WaterWave {
  /** World tiling, cycles per metre. Two non-harmonic values beat without a visible period. */
  readonly scale: number;
  /** Drift in world metres per second. */
  readonly drift: readonly [number, number];
  /** Contribution to the perturbed normal. */
  readonly weight: number;
}

/** What a map has to say about its water for this system to render it. */
export interface WaterProfile {
  /**
   * Linear-light colour just under the surface and at full absorption. Numeric triples, so
   * they are linear already: `Color.setHex` would decode them from display-referred sRGB and
   * the water would come out a stop and a half too dark. See the convention beside `tcLuma`.
   */
  readonly shallow_lin: readonly [number, number, number];
  readonly deep_lin: readonly [number, number, number];
  /** Aerated water, not paint: keep it under the brightest ground layer. */
  readonly foam_lin: readonly [number, number, number];
  /** Depth over which the water goes from clear to fully absorbing, metres. */
  readonly absorbDepth: number;
  /**
   * Microroughness. Low but never zero: a real surface has enough microdetail to broaden the
   * sun glint from a point into a sheet, and a mirror-smooth plane loses the glint entirely
   * unless the eye is exactly in the mirror direction.
   */
  readonly roughness: number;
  /**
   * Roughness the surface converges on with distance, and it is not a style choice.
   *
   * A bump's two slopes are equal and opposite, so they cancel under averaging: this project
   * has measured a procedural normal map losing **84 % of its perturbation by mip 4**. Past a
   * few hundred metres the wave normals are therefore gone and the surface becomes a mirror
   * with `roughness` — one enormous specular lobe that either hits a pixel or does not, which
   * renders as a field of unfiltered white sparkles and is exactly the pixel-scale energy the
   * blind deck separates us on. The variance the mip chain destroys has to come back as
   * roughness, which is what a Toksvig or LEAN filter does properly and what this ramp does
   * cheaply. Set it high enough that the far sea integrates into a sheet.
   */
  readonly farRoughness: number;
  /** Scale on the environment reflection. Water reflects far more sky than ground does. */
  readonly envIntensity: number;
  readonly waves: readonly [WaterWave, WaterWave];
  /**
   * Amplitude of the perturbed normal, as the tangent of the surface slope.
   *
   * **This is the knob that decides whether there is a sun *path* or a sheet of glitter over
   * the whole surface**, and the first pass got it badly wrong. At 0.92 the waves reach 43
   * degrees of slope; a real sea runs an RMS slope of 5-15 degrees. With a sun 20 degrees up
   * and an RTS camera 40 degrees down, a 43-degree wave field puts *some* facet at the
   * specular peak in nearly every pixel, so the gulf rendered as hammered foil from edge to
   * edge instead of as water with a glitter path across it.
   */
  readonly chop: number;
  /**
   * Strength of the analytic horizon-graded sky term that sits under `scene.environment`'s
   * own reflection. The two double-count by construction, so this is a small correction and
   * not the main reflection.
   */
  readonly skyReflect: number;
  /**
   * Swell: how far the waterline breathes in and out, in metres, and therefore how much surf
   * the shoreline carries. Zero for a river, which has a bank rather than a beach.
   */
  readonly surge: number;
  /** Foam over shoaling water — a river's ford, a lagoon's bar. Zero for still water. */
  readonly shoalFoam: number;
  /** Basins whose bed is built geometry rather than terrain. */
  readonly basins?: readonly WaterBasin[];
  /** Distinguishes this map's water program in three's cache. */
  readonly cacheKey: string;
}

/**
 * Carrier resolution over the battlefield, metres.
 *
 * The surface is a plane and every vertex of it sits at exactly the same height, so this
 * buys no shape at all — interpolating a plane is exact at any subdivision. What it buys is
 * how tightly the carrier hugs the wetted ground, and therefore how many fragments get as
 * far as the shader's `discard`. 16 m against the Tiber's 94 m channel is snug; against the
 * Gulf of Tunis it is irrelevant because the gulf is solid water.
 */
const CELL = 16;
/**
 * The ring outside the battlefield, and its resolution.
 *
 * `farHeight` is where the clipmap drifts outside +/-HALF_EXTENT, and on a peninsula that is
 * under the datum — so the sea has to continue past the map edge or there is a ring of
 * painted splat between real water and the horizon. The clipmap reaches 3,072 m from a
 * camera that may itself be 1,288 m out, so 4,400 covers everything the eye can reach. The
 * cells are coarse because out there the bed is a constant and the discard rule is
 * per-pixel regardless.
 */
const RING_REACH = 4400;
const RING_CELL = 200;

/** Segments round a basin's rim. A 325 m cothon at 64 segments is a 16 m chord. */
const BASIN_SEGMENTS = 64;

export class WaterSurface {
  private mesh?: THREE.Mesh;
  private material?: THREE.MeshStandardMaterial;
  private uniforms: Record<string, THREE.IUniform> = {};
  private time = 0;

  /** Quads emitted, so the cost of the carrier is reportable rather than assumed. */
  stats = { quads: 0, vertices: 0, basins: 0 };

  constructor(
    private readonly terrain: TerrainSystem,
    private readonly profile: WaterProfile,
    private readonly waterLevel: number,
    private readonly farHeight: number
  ) {}

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  /**
   * The bed under a point, mirroring `TerrainMaterial`'s `terrainHeightLod` exactly.
   *
   * The two must agree: the CPU decides which cells to emit and the GPU decides which
   * fragments survive, and a disagreement is a shoreline that stops at a straight line.
   */
  private bedAt(x: number, z: number): number {
    const h = this.terrain.heightAt(x, z);
    const outward = Math.max(Math.abs(x), Math.abs(z));
    const t = Math.min(
      1,
      Math.max(0, (outward - HALF_EXTENT * 0.97) / (HALF_EXTENT * 1.6 - HALF_EXTENT * 0.97))
    );
    return h + (this.farHeight - h) * (t * t * (3 - 2 * t));
  }

  private buildGeometry(): THREE.BufferGeometry {
    const pos: number[] = [];
    const moulded: number[] = [];
    const idx: number[] = [];

    /** Emit one quad, sharing nothing: the buffer is small and welding would cost more. */
    const quad = (
      x0: number,
      z0: number,
      x1: number,
      z1: number,
      y: number,
      depth: number
    ): void => {
      const b = pos.length / 3;
      pos.push(x0, y, z0, x1, y, z0, x0, y, z1, x1, y, z1);
      moulded.push(depth, depth, depth, depth);
      idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    };

    // ---- The battlefield, at heightfield resolution -------------------------
    // Mark a cell wet if any height sample inside it is under the datum, then dilate by one
    // cell so the shoreline never lands on the carrier's own edge.
    const nx = Math.ceil((HALF_EXTENT * 2) / CELL);
    const field = this.terrain.heightField;
    const wet = new Uint8Array(nx * nx);
    for (let j = 0; j < field.res; j++) {
      const wz = -HALF_EXTENT + j * field.spacing;
      const cj = Math.min(nx - 1, Math.max(0, ((wz + HALF_EXTENT) / CELL) | 0));
      const row = j * field.res;
      for (let i = 0; i < field.res; i++) {
        if (field.data[row + i] >= this.waterLevel) continue;
        const wx = -HALF_EXTENT + i * field.spacing;
        const ci = Math.min(nx - 1, Math.max(0, ((wx + HALF_EXTENT) / CELL) | 0));
        wet[cj * nx + ci] = 1;
      }
    }
    const grown = new Uint8Array(wet);
    for (let j = 0; j < nx; j++) {
      for (let i = 0; i < nx; i++) {
        if (!wet[j * nx + i]) continue;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= nx) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= nx) continue;
            grown[jj * nx + ii] = 1;
          }
        }
      }
    }
    for (let j = 0; j < nx; j++) {
      for (let i = 0; i < nx; i++) {
        if (!grown[j * nx + i]) continue;
        const x0 = -HALF_EXTENT + i * CELL;
        const z0 = -HALF_EXTENT + j * CELL;
        quad(x0, z0, x0 + CELL, z0 + CELL, this.waterLevel, 0);
      }
    }

    // ---- The ring outside it ------------------------------------------------
    // Five taps per cell is ample: past the map edge the bed is a smooth drift to
    // `farHeight` with no structure in it, and anything the taps miss the shader's own
    // per-pixel test catches.
    const rn = Math.ceil(RING_REACH / RING_CELL);
    for (let j = -rn; j < rn; j++) {
      for (let i = -rn; i < rn; i++) {
        const x0 = i * RING_CELL;
        const z0 = j * RING_CELL;
        const x1 = x0 + RING_CELL;
        const z1 = z0 + RING_CELL;
        if (x1 <= HALF_EXTENT && x0 >= -HALF_EXTENT && z1 <= HALF_EXTENT && z0 >= -HALF_EXTENT) {
          continue; // covered by the fine tier, and the two share the +/-1400 grid line
        }
        const cx = (x0 + x1) * 0.5;
        const cz = (z0 + z1) * 0.5;
        const anyWet =
          this.bedAt(x0, z0) < this.waterLevel ||
          this.bedAt(x1, z0) < this.waterLevel ||
          this.bedAt(x0, z1) < this.waterLevel ||
          this.bedAt(x1, z1) < this.waterLevel ||
          this.bedAt(cx, cz) < this.waterLevel;
        if (anyWet) quad(x0, z0, x1, z1, this.waterLevel, 0);
      }
    }

    // ---- Authored basins ----------------------------------------------------
    for (const b of this.profile.basins ?? []) {
      const s = b.shape;
      const y = b.y;
      if (s.kind === 'rect') {
        quad(s.x - s.hw, s.z - s.hd, s.x + s.hw, s.z + s.hd, y, b.depth);
      } else {
        const inner = s.innerR ?? 0;
        for (let k = 0; k < BASIN_SEGMENTS; k++) {
          const a0 = (k / BASIN_SEGMENTS) * Math.PI * 2;
          const a1 = ((k + 1) / BASIN_SEGMENTS) * Math.PI * 2;
          const base = pos.length / 3;
          pos.push(
            s.x + Math.cos(a0) * inner, y, s.z + Math.sin(a0) * inner,
            s.x + Math.cos(a1) * inner, y, s.z + Math.sin(a1) * inner,
            s.x + Math.cos(a0) * s.outerR, y, s.z + Math.sin(a0) * s.outerR,
            s.x + Math.cos(a1) * s.outerR, y, s.z + Math.sin(a1) * s.outerR
          );
          moulded.push(b.depth, b.depth, b.depth, b.depth);
          idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
        }
      }
      this.stats.basins++;
    }

    const count = pos.length / 3;
    const normals = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) normals[i * 3 + 1] = 1;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('aMoulded', new THREE.BufferAttribute(new Float32Array(moulded), 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    this.stats.quads = idx.length / 6;
    this.stats.vertices = count;
    return geo;
  }

  // -------------------------------------------------------------------------
  // Material
  // -------------------------------------------------------------------------

  async init(ctx: EngineContext, tex: GroundTextures, heightMap: THREE.Texture): Promise<void> {
    const p = this.profile;
    const geo = this.buildGeometry();

    // Structurally typed views of the two subsystems: the water only needs the sky's ambient
    // colour and, if the post chain has one, its depth prepass.
    const sky = ctx.tryGet<Subsystem & { ambientColour?: THREE.Color }>('sky');
    const postfx = ctx.tryGet<Subsystem & { depthTexture?: THREE.DepthTexture | null }>('postfx');
    const sceneDepth = postfx?.depthTexture ?? null;

    const [wa, wb] = p.waves;
    this.uniforms = {
      uHeightMap: { value: heightMap },
      uHalfExtent: { value: HALF_EXTENT },
      uFarHeight: { value: this.farHeight },
      uWaveA: { value: tex.waterNormalA },
      uWaveB: { value: tex.waterNormalB },
      uTime: { value: 0 },
      uSkyColour: { value: new THREE.Color(0.42, 0.58, 0.78) },
      uShallow: { value: new THREE.Color(...p.shallow_lin) },
      uDeep: { value: new THREE.Color(...p.deep_lin) },
      uFoam: { value: new THREE.Color(...p.foam_lin) },
      uAbsorb: { value: p.absorbDepth },
      // xy: layer A tiling and weight; zw: layer B.
      uWaveScale: { value: new THREE.Vector4(wa.scale, wa.weight, wb.scale, wb.weight) },
      uWaveDrift: { value: new THREE.Vector4(wa.drift[0], wa.drift[1], wb.drift[0], wb.drift[1]) },
      uChop: { value: p.chop },
      uSkyReflect: { value: p.skyReflect },
      // x: the roughness distance converges on; y, z: the ramp's near and far metres. The
      // ramp is tied to the coarse layer's own wavelength, because that is the thing whose
      // mip level decides when the perturbation has gone: it is spent by the time one tile
      // is a few pixels across.
      uFarRough: { value: new THREE.Vector3(p.farRoughness, 150, 6 / Math.max(1e-4, wb.scale)) },
      uSurge: { value: p.surge },
      uShoalFoam: { value: p.shoalFoam },
      uSceneDepth: { value: sceneDepth },
      uDepthParams: { value: new THREE.Vector4(1, 1000, 1, 1) },
    };
    if (sky?.ambientColour) (this.uniforms.uSkyColour.value as THREE.Color).copy(sky.ambientColour);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: p.roughness,
      metalness: 0,
      envMapIntensity: p.envIntensity,
      transparent: true,
      // The water blends over ground and men already in the depth buffer; writing depth would
      // let it occlude anything drawn after it in the transparent pass.
      depthWrite: false,
      side: THREE.FrontSide,
    });
    if (sceneDepth) mat.defines = { ...(mat.defines ?? {}), USE_SCENE_DEPTH: '' };

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vWater;\nvarying float vMoulded;\nattribute float aMoulded;'
        )
        .replace(
          '#include <begin_vertex>',
          'vec3 transformed = vec3(position);\n  vWater = transformed;\n  vMoulded = aMoulded;'
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
varying vec3 vWater;
varying float vMoulded;
uniform sampler2D uHeightMap;
uniform sampler2D uWaveA;
uniform sampler2D uWaveB;
uniform float uHalfExtent;
uniform float uFarHeight;
uniform float uTime;
uniform float uAbsorb;
uniform float uChop;
uniform float uSkyReflect;
uniform vec3 uFarRough;
uniform float uSurge;
uniform float uShoalFoam;
uniform vec4 uWaveScale;
uniform vec4 uWaveDrift;
uniform vec3 uSkyColour;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoam;
#ifdef USE_SCENE_DEPTH
uniform sampler2D uSceneDepth;
uniform vec4 uDepthParams;
#endif

// Mirrors TerrainMaterial's terrainHeightLod. If the two ever disagree the shoreline
// stops being the bed contour and becomes the carrier's edge.
float bedHeight(vec2 wxz) {
  vec2 uv = (wxz + uHalfExtent) / (2.0 * uHalfExtent);
  float h = texture2D(uHeightMap, clamp(uv, 0.0, 1.0)).r;
  float outward = max(abs(wxz.x), abs(wxz.y));
  return mix(h, uFarHeight, smoothstep(uHalfExtent * 0.97, uHalfExtent * 1.6, outward));
}`
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
  // A basin's bed is built geometry, so its depth is carried on the vertex; everywhere
  // else the bed is terrain and the heightfield knows it exactly.
  float wDepth = vMoulded > 0.0 ? vMoulded : (vWater.y - bedHeight(vWater.xz));

  // The swell: the waterline breathes in and out rather than sitting on one contour.
  // Two incommensurate wavelengths along the shore so no stretch of beach is in phase
  // with the next. Zero for a river, which has a bank and not a beach.
  float alongShore = vWater.x * 0.021 + vWater.z * 0.017;
  float swell = uSurge * (sin(alongShore * 3.1 - uTime * 0.55)
                        + 0.6 * sin(alongShore * 7.7 + uTime * 0.83)) * 0.5;
  float shoreDepth = wDepth + swell;

  // Outside the wetted ground there is no water at all; discarding rather than fading keeps
  // the shoreline exactly on the bed contour at any zoom.
  if (shoreDepth <= 0.0) discard;

  vec2 wuvA = vWater.xz * uWaveScale.x - uWaveDrift.xy * uTime * uWaveScale.x;
  vec2 wuvB = vWater.xz * uWaveScale.z + vec2(0.31, -0.17) - uWaveDrift.zw * uTime * uWaveScale.z;
  vec3 nA = texture2D(uWaveA, wuvA).xyz * 2.0 - 1.0;
  vec3 nB = texture2D(uWaveB, wuvB).xyz * 2.0 - 1.0;
  // Chop is suppressed in the shallows where the bed drags on the flow.
  float chop = (0.35 + 0.65 * smoothstep(0.15, 1.4, wDepth)) * uChop;
  vec2 waveXY = (nA.xy * uWaveScale.y + nB.xy * uWaveScale.w) * chop;

  float absorb = 1.0 - exp(-max(wDepth, 0.0) / uAbsorb);
  vec3 waterCol = mix(uShallow, uDeep, absorb);

  // Foam, in two places a real surface makes it: a band at the waterline broken up by a
  // scrolling noise so it reads as moving water rather than a painted outline, and over
  // shoaling water where the bed makes the flow break — a ford, a bar, a reef.
  float edge = 1.0 - smoothstep(0.0, 0.3 + uSurge * 1.9, shoreDepth);
  // Two scrolling layers multiplied, clamped: without the clamp the product exceeds one
  // over a shoal and the whole of it blows out to a sheet of white.
  float foamNoise = clamp(
    texture2D(uWaveB, vWater.xz * 0.28 - uWaveDrift.xy * uTime * 0.14).x * 1.5 *
    texture2D(uWaveA, vWater.xz * 0.09 + uWaveDrift.xy * uTime * 0.05).y * 1.5, 0.0, 1.0);
  float shoal = uShoalFoam * (1.0 - smoothstep(0.25, 0.9, wDepth)) * (1.0 - edge);
  float foam = clamp(edge * (0.25 + 0.9 * foamNoise) + shoal * foamNoise * 0.75, 0.0, 1.0);
  // Capped well below one: foam is aerated water, not paint.
  foam = smoothstep(0.45, 0.95, foam) * 0.55;

  float alpha = clamp(absorb * 0.92 + 0.18, 0.0, 1.0);
  alpha = max(alpha, foam * 1.4);
  // Feather the last few centimetres of the waterline so the swell does not chatter along
  // a pixel-wide contour as it advances.
  alpha *= smoothstep(0.0, 0.12, shoreDepth);
#ifdef USE_SCENE_DEPTH
  // Soften where the surface meets anything the heightfield cannot know about — a man
  // wading, a quay wall, a bridge pier — using the depth prepass the post chain publishes.
  vec2 sUv = gl_FragCoord.xy * uDepthParams.zw;
  float dRaw = texture2D(uSceneDepth, sUv).x;
  float zNear = uDepthParams.x;
  float zFar = uDepthParams.y;
  float sceneZ = zNear * zFar / (zFar - dRaw * (zFar - zNear));
  float ownZ = -vViewPosition.z;
  alpha *= clamp((sceneZ - ownZ) * 1.6, 0.0, 1.0);
#endif

  diffuseColor.rgb *= mix(waterCol, uFoam, foam);
  diffuseColor.a *= alpha;
`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `
  // Give back as roughness the normal variance the mip chain has taken away, then let foam
  // override both: aerated water is genuinely rough.
  float toEye = length(vViewPosition);
  float mipped = smoothstep(uFarRough.y, uFarRough.z, toEye);
  float roughnessFactor = mix(mix(roughness, uFarRough.x, mipped), 0.72, foam);`
        )
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
  normal = normalize(vec3(waveXY.x, 1.0, waveXY.y));
  nonPerturbedNormal = normal;`
        )
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `
  // A horizon-graded sky in the mirror direction. The physically correct term is the
  // envmap radiance three already adds from scene.environment; this sits under it and
  // carries the part a coarse PMREM loses near the horizon, which on a water plane seen
  // from an RTS camera is almost the whole reflection.
  vec3 mirror = reflect(-normalize(vViewPosition), normal);
  float up = clamp(mirror.y, 0.0, 1.0);
  vec3 sky_lin = mix(uSkyColour * 1.2, uSkyColour * 0.62, sqrt(up));
  float fres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 4.0);
  totalEmissiveRadiance += sky_lin * fres * uSkyReflect * (1.0 - foam * 0.7);
`
        );
    };
    mat.customProgramCacheKey = () =>
      `water-${p.cacheKey}-v1-${sceneDepth ? 'depth' : 'nodepth'}`;

    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'water';
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    // The carrier is far larger than the wetted ground, so the default transparent sort by
    // centroid distance is not reliable; draw after the ground and before the VFX.
    this.mesh.renderOrder = 2;
    ctx.scene.add(this.mesh);

    console.info(
      `[water] ${p.cacheKey}: 1 draw, ${this.stats.quads} quads, ` +
        `${this.stats.vertices} verts, ${this.stats.basins} basins`
    );
  }

  update(dt: number, _ctx: EngineContext): void {
    this.time += dt;
    if (this.uniforms.uTime) this.uniforms.uTime.value = this.time;
  }

  preRender(ctx: EngineContext): void {
    const p = this.uniforms.uDepthParams?.value as THREE.Vector4 | undefined;
    if (p) {
      const cam = ctx.camera;
      const pr = ctx.renderer.getPixelRatio();
      p.set(cam.near, cam.far, 1 / (ctx.viewW * pr), 1 / (ctx.viewH * pr));
    }
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.material?.dispose();
  }
}
