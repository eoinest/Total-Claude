import * as THREE from 'three';
import { HORSE_CLIP_SET, MAN_CLIP_SET } from '../anim/clips';
import { HORSE_RIG, MAN_RIG, type Rig } from '../anim/rig';
import { frameGlobals } from '../anim/pose';

/**
 * The skeleton, drawn over the posed mesh.
 *
 * Every deformation defect in this pipeline is a rig defect wearing a mesh: a limb that comes
 * apart at the hip, a shoulder that collapses, a weapon that leaves the hand. None of those
 * can be diagnosed from the outside — you need to see where the joints actually are on the
 * frame you are looking at.
 *
 * The GPU never tells us. Bone transforms live in a half-float texture and are resolved in the
 * vertex shader, so the CPU has no idea where any joint is. The answer is to run the *same*
 * forward kinematics the bone texture was baked from: `frameGlobals(rig, clip, frame, …)` is
 * literally the function `bakeAnimTexture` calls, so the joints drawn here are the joints the
 * shader is skinning to — not an approximation of them, the same numbers.
 *
 * One caveat, stated rather than hidden: the shader also applies a per-man pose *variation*
 * (a few degrees of spine, head and arm jitter keyed off the man's hash) that the CPU does not
 * reproduce. So the overlay is the clip's skeleton, and a man with a high `variance` will show
 * his mesh a degree or two off the bones. That is under a centimetre at the wrist.
 */

const MAX_BONES = 64;

export class SkeletonOverlay {
  readonly object: THREE.Group;
  private readonly lines: THREE.LineSegments;
  private readonly joints: THREE.Points;
  private readonly linePos: Float32Array;
  private readonly jointPos: Float32Array;
  private readonly worldQ = new Float32Array(MAX_BONES * 4);
  private readonly worldT = new Float32Array(MAX_BONES * 3);
  private lineCount = 0;
  private jointCount = 0;

  constructor() {
    this.linePos = new Float32Array(MAX_BONES * 6);
    this.jointPos = new Float32Array(MAX_BONES * 3);

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3));
    // No depth test: a skeleton you can only see where the mesh happens not to cover it is a
    // skeleton you cannot follow. This is a diagnostic; it is meant to be read through armour.
    this.lines = new THREE.LineSegments(
      lineGeo,
      new THREE.LineBasicMaterial({ color: 0x35d0ff, depthTest: false, transparent: true, opacity: 0.95 })
    );
    this.lines.renderOrder = 60;
    this.lines.frustumCulled = false;

    const jointGeo = new THREE.BufferGeometry();
    jointGeo.setAttribute('position', new THREE.BufferAttribute(this.jointPos, 3));
    this.joints = new THREE.Points(
      jointGeo,
      new THREE.PointsMaterial({ color: 0xffd23f, size: 7, sizeAttenuation: false, depthTest: false, transparent: true })
    );
    this.joints.renderOrder = 61;
    this.joints.frustumCulled = false;

    this.object = new THREE.Group();
    this.object.name = 'viewer-skeleton';
    this.object.add(this.lines, this.joints);
    this.object.visible = false;
  }

  get boneCount(): number {
    return this.jointCount;
  }

  /**
   * Pose the overlay onto one subject.
   *
   * `frame` is the integer frame the instance attributes point at, not the interpolated
   * playhead: the shader lerps between two rows and the overlay would have to lerp two
   * quaternion sets to match exactly. At 24-34 frames a clip the difference is a few
   * millimetres and showing the exact frame the texture is read from is the more useful lie.
   */
  poseMan(
    clipIndex: number, phase: number, x: number, y: number, z: number, yaw: number, scale: number
  ): void {
    this.pose(MAN_RIG, MAN_CLIP_SET, clipIndex, phase, x, y, z, yaw, scale);
  }

  poseHorse(
    clipIndex: number, phase: number, x: number, y: number, z: number, yaw: number, scale: number
  ): void {
    this.pose(HORSE_RIG, HORSE_CLIP_SET, clipIndex, phase, x, y, z, yaw, scale);
  }

  private pose(
    rig: Rig, set: typeof MAN_CLIP_SET, clipIndex: number, phase: number,
    x: number, y: number, z: number, yaw: number, scale: number
  ): void {
    const clip = set.clips[clipIndex] ?? set.clips[0];
    const frame = Math.min(clip.frames - 1, Math.max(0, Math.floor(phase * clip.frames)));
    frameGlobals(rig, clip, frame, this.worldQ, this.worldT);

    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const place = (b: number, out: Float32Array, o: number): void => {
      const lx = this.worldT[b * 3] * scale;
      const ly = this.worldT[b * 3 + 1] * scale;
      const lz = this.worldT[b * 3 + 2] * scale;
      out[o] = x + lx * cy + lz * sy;
      out[o + 1] = y + ly;
      out[o + 2] = z - lx * sy + lz * cy;
    };

    let li = 0;
    for (let b = 0; b < rig.boneCount && b < MAX_BONES; b++) {
      place(b, this.jointPos, b * 3);
      const p = rig.parent[b];
      if (p >= 0) {
        place(p, this.linePos, li * 6);
        place(b, this.linePos, li * 6 + 3);
        li++;
      }
    }
    this.jointCount = Math.min(rig.boneCount, MAX_BONES);
    this.lineCount = li;

    this.lines.geometry.setDrawRange(0, this.lineCount * 2);
    this.joints.geometry.setDrawRange(0, this.jointCount);
    (this.lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.joints.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.object.visible = true;
  }

  hide(): void {
    this.object.visible = false;
  }

  dispose(): void {
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.joints.geometry.dispose();
    (this.joints.material as THREE.Material).dispose();
  }
}
