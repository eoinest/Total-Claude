import * as THREE from 'three';
import type { ClipSet } from './clips';
import { frameGlobals } from './pose';

/**
 * The animation texture — the core of the GPU skinning path.
 *
 * ## What is stored
 * For every (frame, bone) pair, the *skinning transform*
 *
 *     M = W(frame) · Wrest⁻¹
 *
 * where `W` is the bone's world transform in the pose and `Wrest` its bind transform.
 * Both are rigid, so `M` is rigid too, and a rigid transform is exactly a unit
 * quaternion plus a translation: **two RGBA texels**, not three rows of matrix.
 *
 * ## Why this rather than per-vertex position VAT
 * The brief's default technique is to bake skinned vertex *positions* into a texture.
 * That works, but at this project's shape it loses badly:
 *
 *   - A position VAT is per-mesh. Two factions x three LODs x a horse is six separate
 *     bakes, ~60 MB of RGBA16F and several hundred milliseconds of load-time skinning.
 *     A bone texture is per-*rig*: two textures, 350 KB total, and every LOD and every
 *     kit variant reads the same one.
 *   - Baked positions cannot be re-posed, so attachments (a gladius in a fist, a scutum
 *     strapped to a forearm) have to be baked into the mesh as extra vertices for every
 *     clip. With bone transforms the weapon is simply skinned to the hand.
 *   - Normals from a position VAT need a second texture and come out of finite
 *     differences; rotating a normal by a quaternion is exact and free.
 *   - Cross-fading two clips costs 4 texel fetches per bone either way, but blending
 *     quaternions is a proper rotation blend, while lerping baked positions collapses
 *     limbs through the body on a 90-degree difference.
 *
 * Cost per vertex in the shader: 2 bone influences x 2 frames x 2 texels = 8 fetches on
 * the common path, 16 while cross-fading. A stock `SkinnedMesh` does 16 unconditionally.
 *
 * ## Layout
 *     width  = boneCount * 2      (quaternion texel, translation texel)
 *     height = sum of every packed clip's frame count
 * Clips occupy contiguous row ranges; the renderer computes absolute rows on the CPU and
 * hands them to the shader as instance attributes, so the shader needs no lookup table.
 *
 * RGBA16F throughout. Half float carries ~0.0005 of angular error on a quaternion
 * component and about a millimetre on a translation at these magnitudes — both an order
 * of magnitude below what a 1600-pixel frame resolves — at half the bandwidth of full
 * float, which matters because these fetches are the shader's inner loop.
 */

export interface AnimTexture {
  readonly texture: THREE.DataTexture;
  readonly boneCount: number;
  readonly width: number;
  readonly height: number;
  dispose(): void;
}

export function bakeAnimTexture(set: ClipSet, label: string): AnimTexture {
  const rig = set.rig;
  const n = rig.boneCount;
  const width = n * 2;
  const height = set.totalRows;
  const data = new Uint16Array(width * height * 4);

  const worldQ = new Float32Array(n * 4);
  const worldT = new Float32Array(n * 3);
  const half = THREE.DataUtils.toHalfFloat;

  for (let ci = 0; ci < set.clips.length; ci++) {
    const clip = set.clips[ci];
    const row0 = set.rows[ci];
    for (let f = 0; f < clip.frames; f++) {
      frameGlobals(rig, clip, f, worldQ, worldT);
      const rowBase = (row0 + f) * width * 4;
      for (let b = 0; b < n; b++) {
        // q = W.q * bindInv.q
        const ax = worldQ[b * 4], ay = worldQ[b * 4 + 1], az = worldQ[b * 4 + 2], aw = worldQ[b * 4 + 3];
        const bx = rig.bindInvQ[b * 4], by = rig.bindInvQ[b * 4 + 1];
        const bz = rig.bindInvQ[b * 4 + 2], bw = rig.bindInvQ[b * 4 + 3];
        let qx = aw * bx + ax * bw + ay * bz - az * by;
        let qy = aw * by - ax * bz + ay * bw + az * bx;
        let qz = aw * bz + ax * by - ay * bx + az * bw;
        let qw = aw * bw - ax * bx - ay * by - az * bz;
        const l = Math.hypot(qx, qy, qz, qw) || 1;
        qx /= l; qy /= l; qz /= l; qw /= l;
        // Keep w positive so the shader's shortest-arc test between adjacent frames has
        // the easiest possible job.
        if (qw < 0) { qx = -qx; qy = -qy; qz = -qz; qw = -qw; }

        // t = W.q * bindInv.t + W.t
        const vx = rig.bindInvT[b * 3], vy = rig.bindInvT[b * 3 + 1], vz = rig.bindInvT[b * 3 + 2];
        const cx = 2 * (ay * vz - az * vy);
        const cy = 2 * (az * vx - ax * vz);
        const cz = 2 * (ax * vy - ay * vx);
        const tx = vx + aw * cx + (ay * cz - az * cy) + worldT[b * 3];
        const ty = vy + aw * cy + (az * cx - ax * cz) + worldT[b * 3 + 1];
        const tz = vz + aw * cz + (ax * cy - ay * cx) + worldT[b * 3 + 2];

        const o = rowBase + b * 8;
        data[o] = half(qx);
        data[o + 1] = half(qy);
        data[o + 2] = half(qz);
        data[o + 3] = half(qw);
        data[o + 4] = half(tx);
        data[o + 5] = half(ty);
        data[o + 6] = half(tz);
        data[o + 7] = 0;
      }
    }
  }

  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  // Nearest everywhere: the shader fetches two specific rows and interpolates itself, so
  // hardware filtering would only smear neighbouring bones into each other.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.name = `anim-${label}`;

  return {
    texture,
    boneCount: n,
    width,
    height,
    dispose(): void {
      texture.dispose();
    },
  };
}
