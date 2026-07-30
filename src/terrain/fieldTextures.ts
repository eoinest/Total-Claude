import * as THREE from 'three';

/**
 * Uploads the heightfield and the splat control map to the GPU.
 *
 * The heightfield is the vertex shader's only source of geometry, so it needs a mip
 * chain: the coarse clipmap levels sample it at 32 m intervals and would otherwise pick
 * an arbitrary detail sample per vertex, which shimmers every time the clipmap recentres.
 *
 * The chain is built on the CPU rather than with `generateMipmap`. R16F is only
 * colour-renderable in WebGL2 when a float-buffer extension happens to be enabled, and
 * `generateMipmap` requires colour-renderability — so relying on it is a coin toss on
 * some drivers. Twelve box reductions of a 2049² field cost about ten milliseconds.
 */

interface Mip {
  data: Uint16Array;
  width: number;
  height: number;
}

export function buildHeightTexture(heights: Float32Array, res: number): THREE.DataTexture {
  const mips: Mip[] = [];
  let src = heights;
  let size = res;
  for (;;) {
    const half = new Uint16Array(size * size);
    for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(src[i]);
    mips.push({ data: half, width: size, height: size });
    if (size === 1) break;
    // GL's rule for the next level is max(1, floor(w / 2)), which `>> 1` matches for
    // odd sizes too (2049 >> 1 === 1024).
    const next = size >> 1;
    const down = new Float32Array(next * next);
    for (let j = 0; j < next; j++) {
      const j0 = Math.min(size - 1, j * 2);
      const j1 = Math.min(size - 1, j * 2 + 1);
      for (let i = 0; i < next; i++) {
        const i0 = Math.min(size - 1, i * 2);
        const i1 = Math.min(size - 1, i * 2 + 1);
        down[j * next + i] =
          (src[j0 * size + i0] + src[j0 * size + i1] + src[j1 * size + i0] + src[j1 * size + i1]) *
          0.25;
      }
    }
    src = down;
    size = next;
  }

  const tex = new THREE.DataTexture(mips[0].data, res, res, THREE.RedFormat, THREE.HalfFloatType);
  // Height is metres above datum, so half-float's ~1 cm precision at 40 m is far below
  // anything visible and halves the memory of a full-float field.
  // `mipmaps` is typed loosely in three's declarations; the renderer only reads
  // width/height/data from each entry.
  tex.mipmaps = mips as unknown as typeof tex.mipmaps;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export function buildControlTexture(control: Uint8Array, res: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(control, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // RGBA8 is unconditionally colour-renderable, so driver mip generation is safe here.
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
