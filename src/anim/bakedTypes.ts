/**
 * Shape of the data emitted by `src/anim/bake/retarget.mjs`.
 *
 * Kept in its own module so the generated files depend on nothing but a type, and a
 * re-bake can never introduce an import cycle.
 */

export interface BakedBone {
  name: string;
  /** Index into the bone array, or -1 for the root. */
  parent: number;
  /** Rest world rotation, xyzw. */
  restQ: number[];
  /** Rest world position, metres. */
  restT: number[];
  /** Rest rotation relative to the parent. */
  localQ: number[];
  /** Rest offset from the parent, in the parent's frame. */
  localT: number[];
}

export interface BakedClipMeta {
  name: string;
  frames: number;
  /** Intended wall-clock period in seconds. */
  duration: number;
  loop: boolean;
  /** Metres of ground covered per second at playback rate 1.0. */
  rootSpeed: number;
}

export interface BakedRigData {
  boneCount: number;
  bones: BakedBone[];
  clips: BakedClipMeta[];
  /** base64 Int16Array of local quaternions, (frame * bones + bone) * 4, scaled 32767. */
  rot: string;
  /** base64 Int16Array of root translation offsets, frame * 3, scaled 10000. */
  rootT: string;
}
