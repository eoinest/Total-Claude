import type { BakedRigData } from './bakedTypes';
import type { Rig } from './rig';
import { qmul, qconj, qnormalise, qrotate, qslerp, qnlerp, qMirrorX } from './quat';

/**
 * Pose clips and the forward kinematics over them.
 *
 * A `PoseClip` is a dense table of local bone rotations, one row per sampled frame, plus
 * a root translation per frame. That is the single representation every producer targets:
 * the offline retargeter's base64 payload decodes into it, hand-authored keyframes
 * evaluate into it, and overlays combine two of them into a third. Downstream, only the
 * animation-texture baker reads it.
 *
 * Rotations are LOCAL (relative to the parent) because that is what composes; the baker
 * turns them into world transforms once, at load.
 */

export interface PoseClip {
  readonly name: string;
  readonly frames: number;
  /** Intended wall-clock period in seconds at playback rate 1.0. */
  duration: number;
  loop: boolean;
  /** Metres of ground covered per second at rate 1.0; 0 for a stationary clip. */
  rootSpeed: number;
  /** Normalised time at which a blow lands or a missile releases. */
  hitFrame?: number;
  /** Local rotations, ((frame * bones) + bone) * 4, xyzw. */
  readonly rot: Float32Array;
  /** Root translation offset from the rest position, frame * 3. */
  readonly rootT: Float32Array;
}

const b64ToInt16 = (s: string): Int16Array => {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
};

/** Expand a generated payload into PoseClips keyed by name. */
export function decodeBaked(data: BakedRigData): Map<string, PoseClip> {
  const rotQ = b64ToInt16(data.rot);
  const trnQ = b64ToInt16(data.rootT);
  const n = data.boneCount;
  const out = new Map<string, PoseClip>();
  let rotOff = 0;
  let trnOff = 0;
  for (const meta of data.clips) {
    const count = meta.frames * n * 4;
    const rot = new Float32Array(count);
    for (let i = 0; i < count; i++) rot[i] = rotQ[rotOff + i] / 32767;
    // Re-normalise: 15-bit rounding leaves each quaternion a hair off unit length, and
    // that error compounds through a 24-deep chain of products.
    for (let i = 0; i < count; i += 4) qnormalise(rot, i);
    rotOff += count;

    const tcount = meta.frames * 3;
    const rootT = new Float32Array(tcount);
    for (let i = 0; i < tcount; i++) rootT[i] = trnQ[trnOff + i] / 10000;
    trnOff += tcount;

    out.set(meta.name, {
      name: meta.name,
      frames: meta.frames,
      duration: meta.duration,
      loop: meta.loop,
      rootSpeed: meta.rootSpeed,
      rot,
      rootT,
    });
  }
  return out;
}

/** A clip holding the rest pose on every frame — the base for fully authored clips. */
export function restClip(rig: Rig, name: string, frames: number): PoseClip {
  const rot = new Float32Array(frames * rig.boneCount * 4);
  for (let f = 0; f < frames; f++) {
    for (let b = 0; b < rig.boneCount; b++) {
      const o = (f * rig.boneCount + b) * 4;
      rot[o] = rig.localQ[b * 4];
      rot[o + 1] = rig.localQ[b * 4 + 1];
      rot[o + 2] = rig.localQ[b * 4 + 2];
      rot[o + 3] = rig.localQ[b * 4 + 3];
    }
  }
  return {
    name, frames, duration: 1, loop: true, rootSpeed: 0,
    rot, rootT: new Float32Array(frames * 3),
  };
}

// ---------------------------------------------------------------------------
// Forward kinematics
// ---------------------------------------------------------------------------

/**
 * World transforms for one frame of a clip.
 *
 * Single forward sweep in bone order; the rig is topologically sorted so a parent is
 * always resolved before its children.
 */
export function frameGlobals(
  rig: Rig,
  clip: PoseClip,
  frame: number,
  outQ: Float32Array,
  outT: Float32Array
): void {
  const n = rig.boneCount;
  const base = frame * n * 4;
  for (let b = 0; b < n; b++) {
    const p = rig.parent[b];
    const qo = b * 4;
    const to = b * 3;
    if (p < 0) {
      outQ[qo] = clip.rot[base + qo];
      outQ[qo + 1] = clip.rot[base + qo + 1];
      outQ[qo + 2] = clip.rot[base + qo + 2];
      outQ[qo + 3] = clip.rot[base + qo + 3];
      outT[to] = rig.restT[to] + clip.rootT[frame * 3];
      outT[to + 1] = rig.restT[to + 1] + clip.rootT[frame * 3 + 1];
      outT[to + 2] = rig.restT[to + 2] + clip.rootT[frame * 3 + 2];
    } else {
      qmul(outQ, qo, outQ, p * 4, clip.rot, base + qo);
      qnormalise(outQ, qo);
      qrotate(outT, to, outQ, p * 4, rig.localT, to);
      outT[to] += outT[p * 3];
      outT[to + 1] += outT[p * 3 + 1];
      outT[to + 2] += outT[p * 3 + 2];
    }
  }
}

/** World transforms at a normalised playhead, interpolating between frames. */
export function sampleGlobals(
  rig: Rig,
  clip: PoseClip,
  t: number,
  outQ: Float32Array,
  outT: Float32Array
): void {
  const n = rig.boneCount;
  const f = t * clip.frames;
  const f0 = Math.floor(f) % clip.frames;
  const f1 = clip.loop ? (f0 + 1) % clip.frames : Math.min(f0 + 1, clip.frames - 1);
  const mix = f - Math.floor(f);
  const blended = new Float32Array(n * 4);
  const a = f0 * n * 4;
  const b = f1 * n * 4;
  for (let i = 0; i < n * 4; i += 4) qnlerp(blended, i, clip.rot, a + i, clip.rot, b + i, mix);
  const tmp: PoseClip = {
    name: clip.name, frames: 1, duration: clip.duration, loop: false, rootSpeed: 0,
    rot: blended,
    rootT: new Float32Array([
      clip.rootT[f0 * 3] + (clip.rootT[f1 * 3] - clip.rootT[f0 * 3]) * mix,
      clip.rootT[f0 * 3 + 1] + (clip.rootT[f1 * 3 + 1] - clip.rootT[f0 * 3 + 1]) * mix,
      clip.rootT[f0 * 3 + 2] + (clip.rootT[f1 * 3 + 2] - clip.rootT[f0 * 3 + 2]) * mix,
    ]),
  };
  frameGlobals(rig, tmp, 0, outQ, outT);
}

// ---------------------------------------------------------------------------
// Authoring: overlays on a base clip
// ---------------------------------------------------------------------------

/**
 * One bone's authored motion: rotation keys in **degrees about the world axes of the
 * rest pose**, at normalised times.
 *
 * World-axis authoring is the whole point. "Swing the thigh 25 degrees about X" means
 * exactly what it sounds like — leg forward — regardless of how the bone's local frame
 * happens to be oriented, and the delta is carried by whatever the parent is doing:
 *
 *     L_b = Wbase_parent⁻¹ · delta_b · Wbase_b
 *
 * With `delta` identity this reduces to the base clip's own local rotation, so a track
 * only ever describes the change.
 */
export interface BoneTrack {
  bone: number;
  /** [normalised time, rx, ry, rz] with rotations in degrees. */
  keys: readonly (readonly [number, number, number, number])[];
  /**
   * Hold this bone's base world orientation instead of inheriting the parents'
   * accumulated delta, and reset the accumulation for its children. Feet stabilise so
   * they stay flat when the legs bend; the head stabilises so it stays level when the
   * spine leans.
   */
  stab?: boolean;
  /**
   * Ignore the base clip for this bone and set its world orientation from the rest pose:
   * `W = delta · Wrest`. Children still inherit the difference, so a chain stays intact.
   *
   * This is how the arms are posed. The rest pose is a T-pose, so a *relative* delta
   * depends entirely on what the base clip happened to be doing with that arm, and a
   * damped arm collapses back to sticking out sideways — which puts a scutum flat like a
   * tea tray. An absolute pose says where the limb is, full stop, and the same shield
   * placement then holds in every clip that uses it.
   */
  abs?: boolean;
}

export interface OverlayDef {
  name: string;
  frames: number;
  duration: number;
  loop: boolean;
  hitFrame?: number;
  rootSpeed?: number;
  /** Scale a bone's base rotation away from rest. >1 amplifies, <1 damps. */
  amp?: readonly (readonly [number, number])[];
  /** Sample the base clip at a phase offset for these bones, in cycles. */
  phase?: readonly (readonly [number, number])[];
  /** Mirror the base pose left/right before applying tracks. */
  mirror?: boolean;
  tracks?: readonly BoneTrack[];
  /** Root translation keys, [t, x, y, z] in metres, added to the base. */
  root?: readonly (readonly [number, number, number, number])[];
  /** Ease applied to every track's key interpolation. */
  ease?: 'linear' | 'smooth';
}

const DEG = Math.PI / 180;

/** Cubic ease in/out — the difference between keyframes and animation. */
const smooth = (t: number): number => t * t * (3 - 2 * t);

function sampleKeys(
  keys: readonly (readonly [number, number, number, number])[],
  t: number,
  ease: boolean,
  out: [number, number, number]
): void {
  const n = keys.length;
  if (n === 0) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    return;
  }
  if (t <= keys[0][0]) {
    out[0] = keys[0][1]; out[1] = keys[0][2]; out[2] = keys[0][3];
    return;
  }
  if (t >= keys[n - 1][0]) {
    out[0] = keys[n - 1][1]; out[1] = keys[n - 1][2]; out[2] = keys[n - 1][3];
    return;
  }
  let i = 0;
  while (i < n - 2 && keys[i + 1][0] < t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  let f = (t - a[0]) / (b[0] - a[0] || 1);
  if (ease) f = smooth(f);
  out[0] = a[1] + (b[1] - a[1]) * f;
  out[1] = a[2] + (b[2] - a[2]) * f;
  out[2] = a[3] + (b[3] - a[3]) * f;
}

/**
 * Build a clip by transforming a base clip.
 *
 * Order of operations per frame: sample the base (optionally per-bone phase shifted),
 * mirror it, scale amplitudes, recompose world rotations, then apply the authored world
 * deltas and convert back to local. The recompose in the middle is what makes amplitude
 * scaling behave — a damped shoulder must not drag the forearm out of alignment.
 */
export function buildOverlay(rig: Rig, base: PoseClip, def: OverlayDef): PoseClip {
  const n = rig.boneCount;
  const frames = def.frames;
  const rot = new Float32Array(frames * n * 4);
  const rootT = new Float32Array(frames * 3);
  const ease = def.ease !== 'linear';

  const ampOf = new Float32Array(n).fill(1);
  if (def.amp) for (const [b, k] of def.amp) ampOf[b] = k;
  const phaseOf = new Float32Array(n);
  if (def.phase) for (const [b, k] of def.phase) phaseOf[b] = k;

  const trackOf = new Array<BoneTrack | undefined>(n);
  if (def.tracks) for (const tr of def.tracks) trackOf[tr.bone] = tr;

  const local = new Float32Array(n * 4);
  const worldQ = new Float32Array(n * 4);
  const outWorldQ = new Float32Array(n * 4);
  const accum = new Float32Array(n * 4);
  const delta = new Float32Array(4);
  const invParent = new Float32Array(4);
  const tmp = new Float32Array(4);
  const euler: [number, number, number] = [0, 0, 0];

  for (let f = 0; f < frames; f++) {
    const t = frames > 1 ? f / (def.loop ? frames : frames - 1) : 0;

    // ---- base locals, per-bone phase shifted --------------------------------
    for (let b = 0; b < n; b++) {
      const bt = phaseOf[b] === 0 ? t : (t + phaseOf[b]) % 1;
      const fb = bt * base.frames;
      const f0 = Math.floor(fb) % base.frames;
      const f1 = base.loop ? (f0 + 1) % base.frames : Math.min(f0 + 1, base.frames - 1);
      const mix = fb - Math.floor(fb);
      qnlerp(local, b * 4, base.rot, (f0 * n + b) * 4, base.rot, (f1 * n + b) * 4, mix);
      if (def.mirror) qMirrorX(local, b * 4, local, b * 4);
      if (ampOf[b] !== 1) qslerp(local, b * 4, rig.localQ, b * 4, local, b * 4, ampOf[b]);
    }

    // Mirroring swaps which physical limb a bone drives, so swap the pairs back.
    if (def.mirror) {
      for (let b = 0; b < n; b++) {
        const name = rig.names[b];
        if (!name.endsWith('L')) continue;
        const other = rig.names.indexOf(`${name.slice(0, -1)}R`);
        if (other < 0) continue;
        for (let c = 0; c < 4; c++) {
          const a = local[b * 4 + c];
          local[b * 4 + c] = local[other * 4 + c];
          local[other * 4 + c] = a;
        }
      }
    }

    // ---- base world rotations ----------------------------------------------
    for (let b = 0; b < n; b++) {
      const p = rig.parent[b];
      if (p < 0) {
        worldQ.set(local.subarray(b * 4, b * 4 + 4), b * 4);
      } else {
        qmul(worldQ, b * 4, worldQ, p * 4, local, b * 4);
        qnormalise(worldQ, b * 4);
      }
    }

    // ---- authored world deltas --------------------------------------------
    // Deltas accumulate down the chain, so twisting the chest carries the arms with it,
    // which is how an animator expects a rig to behave. A `stab` track opts out: it
    // holds its base world orientation and resets the accumulation for its children.
    for (let b = 0; b < n; b++) {
      const tr = trackOf[b];
      const p = rig.parent[b];
      if (tr && tr.keys.length) {
        sampleKeys(tr.keys, t, ease, euler);
        const cx = Math.cos(euler[0] * DEG * 0.5), sx = Math.sin(euler[0] * DEG * 0.5);
        const cy = Math.cos(euler[1] * DEG * 0.5), sy = Math.sin(euler[1] * DEG * 0.5);
        const cz = Math.cos(euler[2] * DEG * 0.5), sz = Math.sin(euler[2] * DEG * 0.5);
        delta[0] = sx * cy * cz + cx * sy * sz;
        delta[1] = cx * sy * cz - sx * cy * sz;
        delta[2] = cx * cy * sz + sx * sy * cz;
        delta[3] = cx * cy * cz - sx * sy * sz;
      } else {
        delta[0] = 0; delta[1] = 0; delta[2] = 0; delta[3] = 1;
      }
      if (p < 0) {
        accum.set(delta.subarray(0, 4), b * 4);
      } else {
        qmul(accum, b * 4, accum, p * 4, delta, 0);
        qnormalise(accum, b * 4);
      }
      if (tr && tr.stab) {
        outWorldQ.set(worldQ.subarray(b * 4, b * 4 + 4), b * 4);
        accum[b * 4] = 0; accum[b * 4 + 1] = 0; accum[b * 4 + 2] = 0; accum[b * 4 + 3] = 1;
      } else if (tr && tr.abs) {
        qmul(outWorldQ, b * 4, delta, 0, rig.restQ, b * 4);
        qnormalise(outWorldQ, b * 4);
        // Children inherit the difference from the base, so the rest of the chain follows.
        qconj(invParent, 0, worldQ, b * 4);
        qmul(accum, b * 4, outWorldQ, b * 4, invParent, 0);
        qnormalise(accum, b * 4);
      } else {
        qmul(outWorldQ, b * 4, accum, b * 4, worldQ, b * 4);
        qnormalise(outWorldQ, b * 4);
      }
      // Convert the result back to a local rotation against the *authored* parent.
      const o = (f * n + b) * 4;
      if (p < 0) {
        rot[o] = outWorldQ[b * 4];
        rot[o + 1] = outWorldQ[b * 4 + 1];
        rot[o + 2] = outWorldQ[b * 4 + 2];
        rot[o + 3] = outWorldQ[b * 4 + 3];
      } else {
        qconj(invParent, 0, outWorldQ, p * 4);
        qmul(tmp, 0, invParent, 0, outWorldQ, b * 4);
        qnormalise(tmp, 0);
        rot[o] = tmp[0];
        rot[o + 1] = tmp[1];
        rot[o + 2] = tmp[2];
        rot[o + 3] = tmp[3];
      }
    }

    // ---- root translation --------------------------------------------------
    const bf = t * base.frames;
    const bf0 = Math.floor(bf) % base.frames;
    const bf1 = base.loop ? (bf0 + 1) % base.frames : Math.min(bf0 + 1, base.frames - 1);
    const bmix = bf - Math.floor(bf);
    for (let c = 0; c < 3; c++) {
      const v0 = base.rootT[bf0 * 3 + c];
      const v1 = base.rootT[bf1 * 3 + c];
      rootT[f * 3 + c] = v0 + (v1 - v0) * bmix;
    }
    if (def.mirror) rootT[f * 3] = -rootT[f * 3];
    if (def.root) {
      sampleKeys(def.root, t, ease, euler);
      rootT[f * 3] += euler[0];
      rootT[f * 3 + 1] += euler[1];
      rootT[f * 3 + 2] += euler[2];
    }
  }

  return {
    name: def.name,
    frames,
    duration: def.duration,
    loop: def.loop,
    rootSpeed: def.rootSpeed ?? (base.rootSpeed * base.duration) / def.duration,
    hitFrame: def.hitFrame,
    rot,
    rootT,
  };
}

/**
 * Measure a clip's true ground speed from the backward drift of a planted foot.
 *
 * Used to keep `rootSpeed` honest after an overlay has changed a stride, because
 * `rootSpeed` is exactly what the renderer divides ground speed by to pick a playback
 * rate — get it wrong and the feet skate.
 */
export function measureRootSpeed(rig: Rig, clip: PoseClip, contactBones: readonly number[]): number {
  const n = rig.boneCount;
  const q = new Float32Array(n * 4);
  const t = new Float32Array(n * 3);
  const y: number[][] = contactBones.map(() => []);
  const z: number[][] = contactBones.map(() => []);
  for (let f = 0; f < clip.frames; f++) {
    frameGlobals(rig, clip, f, q, t);
    contactBones.forEach((b, i) => {
      y[i].push(t[b * 3 + 1]);
      z[i].push(t[b * 3 + 2]);
    });
  }
  const dt = clip.duration / clip.frames;
  let best = 0;
  for (let i = 0; i < contactBones.length; i++) {
    const lowest = Math.min(...y[i]);
    let run: [number, number] | null = null;
    let bestRun: [number, number] | null = null;
    for (let f = 0; f < clip.frames; f++) {
      if (y[i][f] < lowest + 0.03) {
        if (!run) run = [f, f];
        else run[1] = f;
      } else if (run) {
        if (!bestRun || run[1] - run[0] > bestRun[1] - bestRun[0]) bestRun = run;
        run = null;
      }
    }
    if (run && (!bestRun || run[1] - run[0] > bestRun[1] - bestRun[0])) bestRun = run;
    if (!bestRun || bestRun[1] === bestRun[0]) continue;
    const v = (z[i][bestRun[0]] - z[i][bestRun[1]]) / ((bestRun[1] - bestRun[0]) * dt);
    if (v > best) best = v;
  }
  return best;
}
