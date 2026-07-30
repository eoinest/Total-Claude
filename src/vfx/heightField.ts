import * as THREE from 'three';
import type { TerrainSystem } from '../terrain/TerrainSystem';

/**
 * A GPU-readable copy of the terrain heightfield.
 *
 * Dust that drifts over a rise has to rise with it, and a decal quad has to sit on
 * the ground rather than through it. Both are vertex-shader problems, so the
 * heightfield has to be a texture. 8 bits is ample: the whole field spans well under
 * 60 m of relief, so one byte gives ~0.2 m steps, an order of magnitude finer than
 * the size of the particles being grounded.
 */
export interface HeightTexture {
  texture: THREE.Texture;
  /** Height in metres for texel value 0. */
  min: number;
  /** Metres spanned by the full 0..1 texel range. */
  range: number;
  /** Samples per side. */
  res: number;
  /** Battlefield half-size in metres that the texture covers. */
  halfExtent: number;
}

export function buildHeightTexture(terrain: TerrainSystem | undefined): HeightTexture {
  if (!terrain) {
    // No terrain registered: a flat datum keeps every shader path valid.
    const data = new Uint8Array(4 * 4);
    const tex = new THREE.DataTexture(data, 4, 4, THREE.RedFormat, THREE.UnsignedByteType);
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return { texture: tex, min: 0, range: 0, res: 4, halfExtent: 1400 };
  }

  const hf = terrain.heightField;
  const res = hf.res;
  const src = hf.data;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < src.length; i++) {
    const h = src[i];
    if (h < min) min = h;
    if (h > max) max = h;
  }
  // Pad so quantisation never clips at either end.
  min -= 0.5;
  max += 0.5;
  const range = Math.max(1e-3, max - min);

  const data = new Uint8Array(res * res);
  const inv = 255 / range;
  for (let i = 0; i < src.length; i++) {
    data[i] = Math.max(0, Math.min(255, Math.round((src[i] - min) * inv)));
  }

  const tex = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  return { texture: tex, min, range, res, halfExtent: hf.halfExtent };
}

/**
 * GLSL for sampling the height texture. Shared verbatim by the particle, decal and
 * damage-layer shaders so all three agree on where the ground is.
 */
export const HEIGHT_GLSL = /* glsl */ `
uniform sampler2D uHeightTex;
/** (minHeight, heightRange, resolution) */
uniform vec3 uHeightInfo;
uniform float uHeightHalf;

float terrainHeight(vec2 wxz) {
  float res = uHeightInfo.z;
  vec2 g = (wxz + uHeightHalf) / (2.0 * uHeightHalf);
  // Heightfield samples sit on grid corners, texels at texel centres.
  vec2 uv = (clamp(g, 0.0, 1.0) * (res - 1.0) + 0.5) / res;
  return uHeightInfo.x + texture2D(uHeightTex, uv).r * uHeightInfo.y;
}
`;
