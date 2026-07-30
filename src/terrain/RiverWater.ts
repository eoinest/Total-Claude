import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';
import type { GroundTextures } from './groundTextures';
import {
  FORD_Z,
  HALF_EXTENT,
  RIVER_HALF_WIDTH,
  WATER_LEVEL,
  riverCentreX,
} from './topography';
import type { TerrainSystem } from './TerrainSystem';

/**
 * The Tiber's surface.
 *
 * A ribbon of geometry following the channel centreline, held flat at the water level.
 * Everything interesting happens in the fragment shader:
 *
 *  - Depth is read from the heightfield texture, not from the depth buffer. That is both
 *    exact and always available: the water knows the bed's real elevation, so absorption,
 *    the shoreline and the foam line all follow the actual bathymetry rather than an
 *    approximation from a depth prepass. If the post-processing chain does publish a
 *    depth texture, it is used *in addition*, to soften the water against soldiers
 *    standing in the shallows — geometry the heightfield knows nothing about.
 *
 *  - Two normal maps scroll at different speeds and scales; their beat gives a surface
 *    that never reads as a looping texture.
 *
 *  - Reflection is Fresnel-weighted. `MeshStandardMaterial` already does that against
 *    `scene.environment`, and a sky-coloured analytic term is added on top so the water
 *    still reads as water before the render agent installs an HDRI.
 */

/** Depth over which the water goes from clear to fully absorbing, in metres. */
const ABSORB_DEPTH = 2.6;

export class RiverWater {
  private mesh?: THREE.Mesh;
  private material?: THREE.MeshStandardMaterial;
  private uniforms: Record<string, THREE.IUniform> = {};
  private time = 0;

  constructor(private readonly terrain: TerrainSystem) {}

  async init(ctx: EngineContext, tex: GroundTextures, heightMap: THREE.Texture): Promise<void> {
    // ---- Geometry: a strip following the channel -------------------------
    // 6 m along the flow is ample for a flat surface; 130 m either side of the
    // centreline covers the widened ford and leaves margin for the shoreline fade.
    const along = 6;
    const across = 130;
    const segZ = Math.ceil((HALF_EXTENT * 2) / along);
    const segX = 16;
    const verts = (segZ + 1) * (segX + 1);
    const pos = new Float32Array(verts * 3);
    const nor = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    for (let j = 0; j <= segZ; j++) {
      const z = -HALF_EXTENT + (j / segZ) * HALF_EXTENT * 2;
      const cx = riverCentreX(z);
      for (let i = 0; i <= segX; i++) {
        const t = i / segX - 0.5;
        const o = (j * (segX + 1) + i) * 3;
        pos[o] = cx + t * across * 2;
        pos[o + 1] = WATER_LEVEL;
        pos[o + 2] = z;
        nor[o + 1] = 1;
        const u = (j * (segX + 1) + i) * 2;
        uv[u] = t;
        uv[u + 1] = j / segZ;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < segZ; j++) {
      for (let i = 0; i < segX; i++) {
        const a = j * (segX + 1) + i;
        const b = a + 1;
        const c = a + segX + 1;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();

    // ---- Material -------------------------------------------------------
    // Structurally typed views of the two subsystems: the terrain only needs the sky's
    // ambient colour and, if the post chain has one, its depth prepass.
    const sky = ctx.tryGet<Subsystem & { ambientColour?: THREE.Color }>('sky');
    const postfx = ctx.tryGet<Subsystem & { depthTexture?: THREE.DepthTexture | null }>('postfx');
    const sceneDepth = postfx?.depthTexture ?? null;

    this.uniforms = {
      uHeightMap: { value: heightMap },
      uHalfExtent: { value: HALF_EXTENT },
      uWaterLevel: { value: WATER_LEVEL },
      uWaveA: { value: tex.waterNormalA },
      uWaveB: { value: tex.waterNormalB },
      uTime: { value: 0 },
      uSkyColour: { value: new THREE.Color(0.42, 0.58, 0.78) },
      // "Flavus Tiberis" — the yellow Tiber. Horace and Virgil both call it that, and
      // it is still an ochre-brown river: the Apennine marl it carries never settles.
      uShallow: { value: new THREE.Color(0.34, 0.30, 0.18) },
      uDeep: { value: new THREE.Color(0.075, 0.085, 0.055) },
      uAbsorb: { value: ABSORB_DEPTH },
      uFordZ: { value: FORD_Z },
      uSceneDepth: { value: sceneDepth },
      uDepthParams: { value: new THREE.Vector4(1, 1000, 1, 1) },
    };
    if (sky?.ambientColour) (this.uniforms.uSkyColour.value as THREE.Color).copy(sky.ambientColour);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      // Low but not zero: a real river has enough microdetail to broaden the sun glint
      // into a sheet rather than a point.
      roughness: 0.13,
      metalness: 0,
      transparent: true,
      // The water blends over ground and men already in the depth buffer; writing depth
      // would let it occlude anything drawn after it in the transparent pass.
      depthWrite: false,
      side: THREE.FrontSide,
    });
    if (sceneDepth) mat.defines = { ...(mat.defines ?? {}), USE_SCENE_DEPTH: '' };

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWater;')
        .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position);\n  vWater = transformed;');

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
varying vec3 vWater;
uniform sampler2D uHeightMap;
uniform sampler2D uWaveA;
uniform sampler2D uWaveB;
uniform float uHalfExtent;
uniform float uWaterLevel;
uniform float uTime;
uniform float uAbsorb;
uniform float uFordZ;
uniform vec3 uSkyColour;
uniform vec3 uShallow;
uniform vec3 uDeep;
#ifdef USE_SCENE_DEPTH
uniform sampler2D uSceneDepth;
uniform vec4 uDepthParams;
#endif

float bedHeight(vec2 wxz) {
  vec2 uv = (wxz + uHalfExtent) / (2.0 * uHalfExtent);
  return texture2D(uHeightMap, clamp(uv, 0.0, 1.0)).r;
}`
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
  float wDepth = uWaterLevel - bedHeight(vWater.xz);
  // Outside the wetted channel there is no water at all; discarding rather than fading
  // keeps the shoreline exactly on the bed contour at any zoom.
  if (wDepth <= 0.0) discard;

  // The current runs south through the city; scroll both wave layers with it. The two
  // scales are deliberately non-harmonic so their beat has no visible period.
  vec2 flow = vec2(0.12, 1.0);
  vec2 wuvA = vWater.xz * 0.155 - flow * uTime * 0.075;
  vec2 wuvB = vWater.xz * 0.058 + vec2(0.31, -0.17) - flow * uTime * 0.028;
  vec3 nA = texture2D(uWaveA, wuvA).xyz * 2.0 - 1.0;
  vec3 nB = texture2D(uWaveB, wuvB).xyz * 2.0 - 1.0;
  // Chop is suppressed in the shallows where the bed drags on the flow.
  float chop = 0.35 + 0.65 * smoothstep(0.15, 1.4, wDepth);
  vec2 waveXY = (nA.xy * 0.62 + nB.xy * 0.48) * chop;

  float absorb = 1.0 - exp(-wDepth / uAbsorb);
  vec3 waterCol = mix(uShallow, uDeep, absorb);

  // Foam: a band at the water's edge, broken up by a scrolling noise so it reads as
  // moving water rather than a painted outline, plus a wide patch over the ford where
  // the shoal makes the flow break.
  float edge = 1.0 - smoothstep(0.0, 0.3, wDepth);
  float ford = exp(-pow((vWater.z - uFordZ) / 120.0, 2.0));
  // Two scrolling layers multiplied, clamped: without the clamp the product exceeds one
  // over the shoal and the whole ford blows out to a sheet of white.
  float foamNoise = clamp(
    texture2D(uWaveB, vWater.xz * 0.28 - flow * uTime * 0.14).x * 1.5 *
    texture2D(uWaveA, vWater.xz * 0.09 + flow * uTime * 0.05).y * 1.5, 0.0, 1.0);
  float foam = clamp(edge * (0.25 + 0.9 * foamNoise)
             + ford * (1.0 - smoothstep(0.25, 0.9, wDepth)) * foamNoise * 0.45, 0.0, 1.0);
  // Capped well below one: foam is aerated water, not paint.
  foam = smoothstep(0.45, 0.95, foam) * 0.55;

  float alpha = clamp(absorb * 0.92 + 0.18, 0.0, 1.0);
  alpha = max(alpha, foam * 1.4);
#ifdef USE_SCENE_DEPTH
  // Soften where the surface meets anything the heightfield cannot know about — a man
  // wading, a bridge pier — using the depth prepass published by the post chain.
  vec2 sUv = gl_FragCoord.xy * uDepthParams.zw;
  float dRaw = texture2D(uSceneDepth, sUv).x;
  float zNear = uDepthParams.x;
  float zFar = uDepthParams.y;
  float sceneZ = zNear * zFar / (zFar - dRaw * (zFar - zNear));
  float ownZ = -vViewPosition.z;
  alpha *= clamp((sceneZ - ownZ) * 1.6, 0.0, 1.0);
#endif

  diffuseColor.rgb *= mix(waterCol, vec3(0.62, 0.62, 0.58), foam);
  diffuseColor.a *= alpha;
`
        )
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, 0.72, foam);')
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
  normal = normalize(vec3(waveXY.x * 0.85, 1.0, waveXY.y * 0.85));
  nonPerturbedNormal = normal;`
        )
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `
  // Analytic sky reflection so the surface still reads before an HDRI environment is
  // installed; when one is, this sits under the physically correct envmap term.
  float fres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 4.0);
  totalEmissiveRadiance += uSkyColour * fres * 0.55 * (1.0 - foam * 0.7);
`
        );
    };
    mat.customProgramCacheKey = () => `river-water-v1-${sceneDepth ? 'depth' : 'nodepth'}`;

    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'tiber';
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    // Draw after the ground; the ribbon is far larger than the wetted channel so the
    // default sort by centroid distance is not reliable.
    this.mesh.renderOrder = 2;
    ctx.scene.add(this.mesh);
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

  /** True where the wetted channel is, used by the scatter to keep trees out of the river. */
  isWater(x: number, z: number): boolean {
    return (
      Math.abs(x - riverCentreX(z)) < RIVER_HALF_WIDTH * 2.2 &&
      this.terrain.heightAt(x, z) < WATER_LEVEL + 0.25
    );
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.material?.dispose();
  }
}
