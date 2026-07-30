#!/usr/bin/env node
/**
 * Offline animation retargeter — author-time tool, not shipped code.
 *
 *   node src/anim/bake/retarget.mjs [--diag]
 *
 * Reads the CC0 Quaternius rigs in `public/assets/models/` and rewrites
 * `src/anim/generated/*.gen.ts` with:
 *   - the target rig's rest pose (bone parents, rest world rotation + position)
 *   - a set of clips retargeted onto that rig, quantised to Int16 and base64'd
 *
 * WHY bake offline rather than retarget at runtime:
 *   1. The game must run with an empty `public/assets/` folder. Committed generated
 *      data has no asset dependency at all.
 *   2. Retargeting 60-odd source bones across 30 clips costs real milliseconds at load,
 *      and would have to happen on every boot for data that never changes.
 *   3. The output is inspectable and diffable, so a bad bake is visible in review.
 *
 * Retarget maths. Both rigs are rigid, and the target rig deliberately adopts the
 * SOURCE's rest world *rotations* while overriding bone *lengths* with human
 * anthropometry (Drillis & Contini segment fractions of stature). Under those
 * conditions the world-space delta retarget
 *
 *     Wtarget_b(t) = ( Wsource_s(t) · Wsource_rest_s⁻¹ ) · Wtarget_rest_b
 *
 * is exact for every mapped bone: the rest rotations cancel and the target bone simply
 * takes the source bone's world orientation. Local rotations then fall out of
 * `L_b = Wtarget_parent(t)⁻¹ · Wtarget_b(t)`. Changing the limb lengths changes stride
 * length, so the baker measures the resulting foot travel and emits it as `rootSpeed`.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadGltf, readAnimation, bindPose, mat3ToQuat } from './gltf.mjs';
import { qmul, qinv, qnorm, qrot, qslerp, qaxis, rcompose, rinv, DEG } from './qmath.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DIAG = process.argv.includes('--diag');

// ---------------------------------------------------------------------------
// Target rigs
// ---------------------------------------------------------------------------
// `src`      source bone whose world rotation drives this bone (null = procedural)
// `len`      bone length in metres, measured along the source's rest direction
// `off`      explicit rest offset from the parent in world axes, used for branch
//            points and for bones with no source counterpart
//
// Lengths follow Drillis & Contini's segment fractions for a stature of 1.75 m, the
// figure `docs/ARCHITECTURE.md` fixes as "a man". Rome II's legionaries read as
// broad-shouldered but they are not heroic proportions, so no stylisation here.
const MAN_BONES = [
  { name: 'root', src: 'Root', parent: -1, world: [0, 0, 0] },
  // Pelvis at 0.95 m: sacral promontory of a 1.75 m man. This is the animation root
  // for everything above the hips.
  { name: 'pelvis', src: 'Body', parent: 'root', world: [0, 0.95, 0] },
  { name: 'spineLow', src: 'Hips', parent: 'pelvis', len: 0.055 },
  { name: 'spineMid', src: 'Abdomen', parent: 'spineLow', len: 0.14 },
  { name: 'spineUp', src: 'Torso', parent: 'spineMid', len: 0.145 },
  // Chest top at 1.43 m ≈ 0.818 H, the acromion / C7 height.
  { name: 'chest', src: 'Chest', parent: 'spineUp', len: 0.14 },
  { name: 'neck', src: 'Neck', parent: 'chest', len: 0.09 },
  { name: 'head', src: 'Head', parent: 'neck', len: 0.095 },

  // Sternoclavicular joint 0.055 m off the midline and a touch above the chest bone.
  { name: 'clavL', src: 'Shoulder.L', parent: 'chest', off: [0.055, 0.015, 0.005] },
  // Shoulder joint centre ±0.175 m: slightly inboard of the acromion so the deltoid
  // volume sits over the joint rather than outside the silhouette.
  { name: 'upperArmL', src: 'UpperArm.L', parent: 'clavL', off: [0.12, -0.06, 0] },
  { name: 'lowerArmL', src: 'LowerArm.L', parent: 'upperArmL', len: 0.3 },
  { name: 'handL', src: 'Wrist.L', parent: 'lowerArmL', len: 0.255 },
  { name: 'clavR', src: 'Shoulder.R', parent: 'chest', off: [-0.055, 0.015, 0.005] },
  { name: 'upperArmR', src: 'UpperArm.R', parent: 'clavR', off: [-0.12, -0.06, 0] },
  { name: 'lowerArmR', src: 'LowerArm.R', parent: 'upperArmR', len: 0.3 },
  { name: 'handR', src: 'Wrist.R', parent: 'lowerArmR', len: 0.255 },

  // Hip joint (greater trochanter) at 0.9275 m = 0.53 H, ±0.095 m lateral.
  { name: 'thighL', src: 'UpperLeg.L', parent: 'pelvis', off: [0.095, -0.0225, 0] },
  { name: 'shinL', src: 'LowerLeg.L', parent: 'thighL', len: 0.429 },
  // Ankle at 0.068 m = 0.039 H. Foot and toe have no source counterpart — the source
  // rig drives its feet with root-parented IK controls whose rest placement is
  // arbitrary — so they are procedural (see footPose).
  { name: 'footL', src: null, parent: 'shinL', off: [0, -0.4305, 0], rest: 'foot' },
  { name: 'toeL', src: null, parent: 'footL', off: [0, -0.038, 0.125], rest: 'foot' },
  { name: 'thighR', src: 'UpperLeg.R', parent: 'pelvis', off: [-0.095, -0.0225, 0] },
  { name: 'shinR', src: 'LowerLeg.R', parent: 'thighR', len: 0.429 },
  { name: 'footR', src: null, parent: 'shinR', off: [0, -0.4305, 0], rest: 'foot' },
  { name: 'toeR', src: null, parent: 'footR', off: [0, -0.038, 0.125], rest: 'foot' },
];

// A 15.2-hand cavalry horse: 1.55 m at the withers, 2.35 m nose to tail. Roman
// cavalry mounts were small by modern standards — closer to a modern Camargue or
// Barb than a warmblood — which is why the rider's legs hang so low in the reliefs.
const HORSE_BONES = [
  // Bone lengths are left at the source's own (scaled) proportions — `auto` — because
  // the gait was animated for them and re-proportioning a quadruped's leg segments
  // wrecks the hoof trajectory in a way nobody can un-see. Only the overall size is
  // ours: the source horse is 2.4x life size, and 2.05 m to the ear tips puts the
  // withers at about 1.5 m, a 15-hand animal of the sort Roman cavalry actually rode.
  { name: 'hind', src: 'Body', parent: -1, world: 'src' },
  { name: 'croup', src: 'Back', parent: 'hind', auto: true },
  { name: 'loin', src: 'Torso', parent: 'croup', auto: true },
  { name: 'barrel', src: 'Torso2', parent: 'loin', auto: true },
  { name: 'withers', src: 'Torso3', parent: 'barrel', auto: true },
  { name: 'neck1', src: 'Neck1', parent: 'withers', auto: true },
  { name: 'neck2', src: 'Neck2', parent: 'neck1', auto: true },
  { name: 'neck3', src: 'Neck3', parent: 'neck2', auto: true },
  { name: 'head', src: 'Head', parent: 'neck3', auto: true },

  { name: 'fShoulderL', src: 'FrontShoulder.L', parent: 'barrel', auto: true },
  { name: 'fUpperL', src: 'FrontUpperLeg.L', parent: 'fShoulderL', auto: true },
  { name: 'fLowerL', src: 'FrontLowerLeg.L', parent: 'fUpperL', auto: true },
  { name: 'fHoofL', src: null, parent: 'fLowerL', posFrom: 'IKFrontLeg.L' },
  { name: 'fShoulderR', src: 'FrontShoulder.R', parent: 'barrel', auto: true },
  { name: 'fUpperR', src: 'FrontUpperLeg.R', parent: 'fShoulderR', auto: true },
  { name: 'fLowerR', src: 'FrontLowerLeg.R', parent: 'fUpperR', auto: true },
  { name: 'fHoofR', src: null, parent: 'fLowerR', posFrom: 'IKFrontLeg.R' },

  { name: 'bHipL', src: 'BackShoulder.L', parent: 'croup', auto: true },
  { name: 'bFemurL', src: 'BackLeg.L', parent: 'bHipL', auto: true },
  { name: 'bTibiaL', src: 'BackUpperLeg.L', parent: 'bFemurL', auto: true },
  { name: 'bCannonL', src: 'BackLowerLeg.L', parent: 'bTibiaL', auto: true },
  { name: 'bHoofL', src: null, parent: 'bCannonL', posFrom: 'IKBackLeg.L' },
  { name: 'bHipR', src: 'BackShoulder.R', parent: 'croup', auto: true },
  { name: 'bFemurR', src: 'BackLeg.R', parent: 'bHipR', auto: true },
  { name: 'bTibiaR', src: 'BackUpperLeg.R', parent: 'bFemurR', auto: true },
  { name: 'bCannonR', src: 'BackLowerLeg.R', parent: 'bTibiaR', auto: true },
  { name: 'bHoofR', src: null, parent: 'bCannonR', posFrom: 'IKBackLeg.R' },

  { name: 'tail1', src: 'Tail1', parent: 'croup', auto: true },
  { name: 'tail2', src: 'Tail3', parent: 'tail1', auto: true },
];

// ---------------------------------------------------------------------------
// Clips to lift from the source rigs
// ---------------------------------------------------------------------------
// Only clips whose weight and secondary motion are genuinely hard to hand-key are
// taken from the assets. Everything Roman-specific — the march cadence, the gladius
// thrust, the testudo brace, the pilum throw — is authored in `src/anim/authored.ts`
// as an overlay on top of these, or from scratch.
const MAN_CLIPS = [
  // `dur` is the clip's intended wall-clock period, `amp` scales a joint's rotation
  // away from rest in the local domain (>1 amplifies, <1 damps). Amplifying hip
  // flexion is how the stride is tuned to the roster's ground speeds: with the render
  // rate driven by `groundSpeed / rootSpeed`, a stride that matches means feet that
  // never skate. Targets: march 1.55 m/s at 120 paces/min (the gradus militaris that
  // Vegetius times at 20 miles in five summer hours), run 3.5 m/s.
  { out: 'walk', src: 'Walk', loop: true, frames: 30, dur: 1.0, amp: { thighL: 0.9, thighR: 0.9 } },
  { out: 'run', src: 'Run', loop: true, frames: 26, dur: 0.71, amp: { thighL: 1.2, thighR: 1.2, shinL: 1.05, shinR: 1.05 } },
  { out: 'idleRelaxed', src: 'Idle_Neutral', loop: true, frames: 30, dur: 3.6 },
  { out: 'idleAlert', src: 'Idle_Sword', loop: true, frames: 30, dur: 3.1 },
  { out: 'slash', src: 'Sword_Slash', loop: false, frames: 26, dur: 1.0 },
  { out: 'punch', src: 'Punch_Right', loop: false, frames: 22, dur: 0.86 },
  { out: 'hitReact', src: 'HitRecieve', loop: false, frames: 18, dur: 0.62 },
  { out: 'death', src: 'Death', loop: false, frames: 30, dur: 1.15 },
  { out: 'wave', src: 'Wave', loop: true, frames: 34, dur: 1.9 },
  { out: 'interact', src: 'Interact', loop: false, frames: 26, dur: 1.3 },
];

const HORSE_CLIPS = [
  // A horse at a hand gallop covers 6-7 m per stride at roughly 1.5 strides a second;
  // 0.62 s per cycle with a 6 m stride lands on the roster's 9.6 m/s charge.
  { out: 'idle', src: 'Idle', loop: true, frames: 34, dur: 3.4 },
  // The source gait is stylised short-strided; reaching further is the only way to cut
  // hoof skate at the roster's 9.6 m/s charge. Even amplified it under-reaches, so the
  // renderer clamps playback rate rather than spinning the legs into a blur.
  { out: 'walk', src: 'Walk', loop: true, frames: 30, dur: 1.05,
    amp: { fUpperL: 1.35, fUpperR: 1.35, bFemurL: 1.35, bFemurR: 1.35 } },
  { out: 'gallop', src: 'Gallop', loop: true, frames: 22, dur: 0.62,
    amp: { fShoulderL: 1.4, fShoulderR: 1.4, fUpperL: 1.7, fUpperR: 1.7,
           bHipL: 1.3, bHipR: 1.3, bFemurL: 1.7, bFemurR: 1.7, bTibiaL: 1.25, bTibiaR: 1.25 } },
  { out: 'rear', src: 'Attack_Headbutt', loop: false, frames: 26, dur: 1.1 },
  { out: 'kick', src: 'Attack_Kick', loop: false, frames: 26, dur: 1.0 },
  { out: 'death', src: 'Death', loop: false, frames: 28, dur: 1.2 },
];

// ---------------------------------------------------------------------------
// Source rest pose
// ---------------------------------------------------------------------------

function sourceRest(gltf, scale) {
  const bind = bindPose(gltf);
  const world = new Array(gltf.nodes.length);
  for (const [node, m] of bind) {
    world[node] = { q: mat3ToQuat(m.r), t: [m.t[0] * scale, m.t[1] * scale, m.t[2] * scale] };
  }
  // Non-joint nodes (mesh holders, IK targets outside the skin) fall back to identity;
  // nothing in the target rigs maps to them.
  for (let i = 0; i < world.length; i++) {
    if (!world[i]) world[i] = { q: [0, 0, 0, 1], t: [0, 0, 0] };
  }
  return world;
}

/** Sample a node's local rotation / translation at time `t` (LINEAR, as exported). */
function sampleTrack(track, t, isQuat) {
  const { times, values, stride } = track;
  const n = times.length;
  if (t <= times[0]) return Array.from(values.subarray(0, stride));
  if (t >= times[n - 1]) return Array.from(values.subarray((n - 1) * stride, n * stride));
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const f = (t - times[lo]) / (times[hi] - times[lo] || 1);
  const a = Array.from(values.subarray(lo * stride, (lo + 1) * stride));
  const b = Array.from(values.subarray(hi * stride, (hi + 1) * stride));
  if (isQuat) return qslerp(a, b, f);
  return a.map((v, i) => v + (b[i] - v) * f);
}

function sourcePose(gltf, anim, t, restLocal) {
  const { nodes, parent } = gltf;
  const local = nodes.map((n, i) => {
    const tr = anim.tracks.get(i);
    return {
      q: tr && tr.rotation ? qnorm(sampleTrack(tr.rotation, t, true)) : restLocal[i].q,
      t: tr && tr.translation ? sampleTrack(tr.translation, t, false) : restLocal[i].t,
    };
  });
  const world = new Array(nodes.length);
  const resolve = (i) => {
    if (world[i]) return world[i];
    const p = parent[i];
    world[i] = p < 0 ? local[i] : rcompose(resolve(p), local[i]);
    return world[i];
  };
  for (let i = 0; i < nodes.length; i++) resolve(i);
  return world;
}

// ---------------------------------------------------------------------------
// Target rig assembly
// ---------------------------------------------------------------------------

/** Rest rotation for procedural bones: bone +Y along +Z so the foot points forward. */
const FOOT_REST = qaxis(1, 0, 0, -Math.PI / 2);

function buildRig(gltf, bones, srcWorldRest) {
  const index = new Map(bones.map((b, i) => [b.name, i]));
  const out = bones.map((b) => ({
    name: b.name,
    parent: b.parent === -1 ? -1 : index.get(b.parent),
    src: b.src ? gltf.byName.get(b.src) : -1,
    restQ: [0, 0, 0, 1],
    restT: [0, 0, 0],
  }));
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i];
    const o = out[i];
    // Rest rotation: adopt the source bone's, so the world-delta retarget is exact.
    // Procedural bones use an authored rest instead.
    if (o.src >= 0) o.restQ = [...srcWorldRest[o.src].q];
    else if (b.rest === 'foot') o.restQ = [...FOOT_REST];
    else if (o.parent >= 0) o.restQ = [...out[o.parent].restQ];

    if (b.world === 'src') {
      // Sit the rig exactly where the source's bind pose put it, at our scale.
      o.restT = [...srcWorldRest[o.src].t];
    } else if (b.world) {
      o.restT = [...b.world];
    } else if (b.posFrom) {
      // Rest position lifted straight from a source control bone (the horse's hoof IK
      // targets sit exactly on the hooves), rotation inherited from the parent.
      const src = srcWorldRest[gltf.byName.get(b.posFrom)];
      const p = out[o.parent];
      o.restQ = [...p.restQ];
      // Keep the source's offset from the parent bone, in the parent's own frame, so
      // the hoof stays put when we re-root the animal.
      const psrc = srcWorldRest[out[o.parent].src];
      o.restT = [
        p.restT[0] + (src.t[0] - psrc.t[0]),
        p.restT[1] + (src.t[1] - psrc.t[1]),
        p.restT[2] + (src.t[2] - psrc.t[2]),
      ];
    } else {
      const p = out[o.parent];
      if (b.off) {
        o.restT = [p.restT[0] + b.off[0], p.restT[1] + b.off[1], p.restT[2] + b.off[2]];
      } else if (b.auto) {
        // Keep the source's own bone vector, scaled to metres.
        const src = srcWorldRest[o.src];
        const psrc = srcWorldRest[p.src];
        o.restT = [
          p.restT[0] + (src.t[0] - psrc.t[0]),
          p.restT[1] + (src.t[1] - psrc.t[1]),
          p.restT[2] + (src.t[2] - psrc.t[2]),
        ];
      } else {
        // Walk `len` metres along the source's rest direction for this bone, which is
        // the parent's local +Y axis in Blender's bone convention.
        const dir = qrot(p.restQ, [0, 1, 0]);
        const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
        o.restT = [
          p.restT[0] + (dir[0] / l) * b.len,
          p.restT[1] + (dir[1] / l) * b.len,
          p.restT[2] + (dir[2] / l) * b.len,
        ];
      }
    }
  }
  // Local rest transforms, needed by the runtime pose evaluator.
  for (const o of out) {
    if (o.parent < 0) {
      o.localQ = [...o.restQ];
      o.localT = [...o.restT];
    } else {
      const p = out[o.parent];
      const inv = rinv({ q: p.restQ, t: p.restT });
      const l = rcompose(inv, { q: o.restQ, t: o.restT });
      o.localQ = l.q;
      o.localT = l.t;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Procedural feet
// ---------------------------------------------------------------------------

/**
 * The source rig has no usable ankle, so the foot is solved here.
 *
 * Rule: while the ankle is low enough to be bearing weight the sole is held parallel
 * to the ground (that is what stops the skate); as the ankle rises into swing the foot
 * relaxes toward the shin's own direction, which gives the natural toe-down carry and
 * the toe-off plantarflexion for free.
 */
function footPose(shinWorld, restQ, ankleY) {
  // The shin's +Y points knee → ankle, so its world direction is the leg's downward axis.
  const down = qrot(shinWorld.q, [0, 1, 0]);
  // Signed forward tilt of the shin: positive when the ankle is ahead of the knee.
  const tilt = Math.atan2(down[2], -down[1]);
  // 0 planted, 1 fully airborne. 0.055 m is roughly a caliga sole plus the ankle radius.
  const air = Math.min(1, Math.max(0, (ankleY - 0.075) / 0.16));
  const level = -tilt; // cancel the shin tilt entirely -> sole flat
  const follow = tilt * 0.25; // in swing let the toe drop with the shin
  const pitch = level * (1 - air) + follow * air;
  // Keep the leg's yaw so the foot points where the leg points.
  const fwd = qrot(shinWorld.q, [0, 0, 1]);
  const yaw = Math.atan2(fwd[0], fwd[2]);
  const q = qmul(qaxis(0, 1, 0, yaw), qaxis(1, 0, 0, pitch));
  return qnorm(qmul(q, restQ));
}

// ---------------------------------------------------------------------------
// Retarget
// ---------------------------------------------------------------------------

/** Solve one frame's world transforms for the target rig. */
function solveFrame(rig, sw, srcWorldRest, rootDelta) {
  const n = rig.length;
  const world = new Array(n);
  for (let b = 0; b < n; b++) {
    const bone = rig[b];
    let wq;
    if (bone.src >= 0) {
      // World-space delta: Wsrc(t) · Wsrc_rest⁻¹, then applied to our rest.
      const d = qmul(sw[bone.src].q, qinv(srcWorldRest[bone.src].q));
      wq = qnorm(qmul(d, bone.restQ));
    } else {
      // Procedural bones ride their parent until the foot pass fixes them up.
      wq = [...world[bone.parent].q];
    }
    let wt;
    if (bone.parent < 0) {
      wt = [bone.restT[0] + rootDelta[0], bone.restT[1] + rootDelta[1], bone.restT[2] + rootDelta[2]];
    } else {
      const p = world[bone.parent];
      const off = qrot(p.q, bone.localT);
      wt = [p.t[0] + off[0], p.t[1] + off[1], p.t[2] + off[2]];
    }
    world[b] = { q: wq, t: wt };
  }
  // Feet, once ankle heights are known. Toes then inherit the corrected foot.
  for (let b = 0; b < n; b++) {
    const bone = rig[b];
    if (bone.src >= 0 || !bone.name.startsWith('foot')) continue;
    world[b].q = footPose(world[bone.parent], bone.restQ, world[b].t[1]);
    for (let c = b + 1; c < n; c++) {
      if (rig[c].parent !== b) continue;
      const off = qrot(world[b].q, rig[c].localT);
      world[c] = {
        q: [...world[b].q],
        t: [world[b].t[0] + off[0], world[b].t[1] + off[1], world[b].t[2] + off[2]],
      };
    }
  }
  return world;
}

/**
 * Scale selected joints' rotation away from rest.
 *
 * Done in the local domain and re-composed down the chain: slerping a joint's local
 * rotation past its rest pose amplifies that joint alone and lets the children ride
 * along, which is what "swing the hip further" means. Scaling the world delta instead
 * would amplify the hip and leave the knee's absolute orientation behind, folding the
 * leg into the wrong shape.
 */
function applyAmp(rig, world, amp) {
  const n = rig.length;
  const out = new Array(n);
  for (let b = 0; b < n; b++) {
    const bone = rig[b];
    if (bone.parent < 0) {
      out[b] = { q: [...world[b].q], t: [...world[b].t] };
      continue;
    }
    let lq = qnorm(qmul(qinv(world[bone.parent].q), world[b].q));
    const k = amp[bone.name];
    if (k !== undefined && k !== 1) lq = qnorm(qslerp(bone.localQ, lq, k));
    const p = out[bone.parent];
    const q = qnorm(qmul(p.q, lq));
    const off = qrot(p.q, bone.localT);
    out[b] = { q, t: [p.t[0] + off[0], p.t[1] + off[1], p.t[2] + off[2]] };
  }
  return out;
}

function retargetClip(gltf, rig, srcWorldRest, restLocal, spec, scale) {
  const anim = readAnimation(gltf, spec.src);
  const frames = spec.frames;
  const n = rig.length;
  // A looping clip samples [0, duration) so frame 0 and frame N-1 are one step apart;
  // a one-shot samples [0, duration] so the final pose is reached exactly.
  const span = spec.loop ? anim.duration * (1 - 1 / frames) : anim.duration;
  const rootSrc = rig[0].src >= 0 ? rig[0].src : -1;
  // Some rigs animate the root, others the first spine bone below it.
  const rootDriver = rootSrc >= 0 && gltf.json.animations
    .find((a) => a.name === spec.src).channels
    .some((c) => c.target.node === rootSrc && c.target.path === 'translation')
    ? rootSrc
    : (rig[1] ? rig[1].src : -1);

  const poses = [];
  const rootRaw = [];
  for (let f = 0; f < frames; f++) {
    const t = (f / Math.max(1, frames - 1)) * span;
    const sw = sourcePose(gltf, anim, t, restLocal);
    rootRaw.push(rootDriver >= 0 ? [sw[rootDriver].t[0] * scale, sw[rootDriver].t[1] * scale, sw[rootDriver].t[2] * scale] : [0, 0, 0]);
    poses.push(sw);
  }

  // Root translation reference: a looping cycle oscillates about its own mean, a
  // one-shot starts from its first frame so the pose the blend comes from is neutral.
  const ref = [0, 0, 0];
  if (spec.loop) {
    for (const r of rootRaw) for (let c = 0; c < 3; c++) ref[c] += r[c] / frames;
  } else {
    for (let c = 0; c < 3; c++) ref[c] = rootRaw[0][c];
  }

  const worlds = poses.map((sw, f) =>
    solveFrame(rig, sw, srcWorldRest, [
      rootRaw[f][0] - ref[0],
      rootRaw[f][1] - ref[1],
      rootRaw[f][2] - ref[2],
    ])
  );

  if (spec.amp) for (let f = 0; f < frames; f++) worlds[f] = applyAmp(rig, worlds[f], spec.amp);

  // ---- Ground the clip -------------------------------------------------------
  // Our limb lengths differ from the source's, so the retargeted pelvis height leaves
  // the feet floating or buried. One constant offset per clip fixes that without
  // flattening the vertical bob that gives a march its weight.
  const contacts = rig
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.name.startsWith('toe') || b.name.startsWith('foot') ||
      b.name.startsWith('fHoof') || b.name.startsWith('bHoof'));
  let groundOffset = 0;
  if (contacts.length) {
    const window = spec.loop ? worlds : worlds.slice(0, Math.max(2, Math.round(frames * 0.2)));
    let lowest = Infinity;
    for (const w of window) for (const { i } of contacts) lowest = Math.min(lowest, w[i].t[1]);
    // 0.02 m: a caliga sole / hoof leaves the bone centre just above the ground plane.
    groundOffset = 0.02 - lowest;
  }

  // ---- Emit ------------------------------------------------------------------
  const rot = new Float32Array(frames * n * 4);
  const rootT = new Float32Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    const world = worlds[f];
    for (let b = 0; b < n; b++) {
      const bone = rig[b];
      const lq = bone.parent < 0
        ? world[b].q
        : qnorm(qmul(qinv(world[bone.parent].q), world[b].q));
      rot[(f * n + b) * 4 + 0] = lq[0];
      rot[(f * n + b) * 4 + 1] = lq[1];
      rot[(f * n + b) * 4 + 2] = lq[2];
      rot[(f * n + b) * 4 + 3] = lq[3];
    }
    rootT[f * 3 + 0] = world[0].t[0] - rig[0].restT[0];
    rootT[f * 3 + 1] = world[0].t[1] - rig[0].restT[1] + groundOffset;
    rootT[f * 3 + 2] = world[0].t[2] - rig[0].restT[2];
  }

  // ---- Stride ----------------------------------------------------------------
  // Ground speed is measured where it actually lives: the backward drift of a foot
  // while it is planted. Fitting that beats guessing from peak-to-peak swing, which
  // over-reads by the swing overshoot.
  let rootSpeed = 0;
  const feet = contacts.filter(({ b }) => b.name === 'footL' || b.name === 'footR' ||
    b.name === 'fHoofL' || b.name === 'fHoofR');
  const dt = span / Math.max(1, frames - 1);
  for (const { i } of feet) {
    let lowest = Infinity;
    for (const w of worlds) lowest = Math.min(lowest, w[i].t[1]);
    // Planted = within 3 cm of this foot's lowest point across the cycle.
    let bestRun = null;
    let run = null;
    for (let f = 0; f < frames; f++) {
      if (worlds[f][i].t[1] < lowest + 0.03) {
        if (!run) run = [f, f];
        else run[1] = f;
      } else if (run) {
        if (!bestRun || run[1] - run[0] > bestRun[1] - bestRun[0]) bestRun = run;
        run = null;
      }
    }
    if (run && (!bestRun || run[1] - run[0] > bestRun[1] - bestRun[0])) bestRun = run;
    if (!bestRun || bestRun[1] === bestRun[0]) continue;
    const dz = worlds[bestRun[0]][i].t[2] - worlds[bestRun[1]][i].t[2];
    const v = dz / ((bestRun[1] - bestRun[0]) * dt);
    if (v > rootSpeed) rootSpeed = v;
  }

  // Convert the measured ground speed at the source's own timing into the speed the
  // clip will actually have once it is played over `dur` seconds. `rootSpeed` is what
  // the renderer divides the man's real ground speed by, so this is the number that
  // decides whether feet skate.
  const targetDuration = spec.dur || anim.duration;
  const stride = rootSpeed * anim.duration;

  return {
    name: spec.out,
    duration: targetDuration,
    loop: spec.loop,
    frames,
    bones: n,
    rot,
    rootT,
    rootSpeed: stride / targetDuration,
    stride,
  };
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const b64 = (i16) => Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).toString('base64');

function quantise(clips) {
  let total = 0;
  for (const c of clips) total += c.frames * c.bones * 4;
  const rotQ = new Int16Array(total);
  let o = 0;
  for (const c of clips) {
    for (let k = 0; k < c.frames * c.bones * 4; k++) {
      // Unit quaternion components live in [-1, 1]; 15 bits gives ~0.006 degrees of
      // angular error, far below what a 1600 px frame can show.
      rotQ[o++] = Math.max(-32767, Math.min(32767, Math.round(c.rot[k] * 32767)));
    }
  }
  let ttotal = 0;
  for (const c of clips) ttotal += c.frames * 3;
  const trnQ = new Int16Array(ttotal);
  o = 0;
  for (const c of clips) {
    for (let k = 0; k < c.frames * 3; k++) {
      // 0.1 mm quantum, ±3.2 m range — plenty for a root that never leaves the body.
      trnQ[o++] = Math.max(-32767, Math.min(32767, Math.round(c.rootT[k] * 10000)));
    }
  }
  return { rotQ, trnQ };
}

function emit(file, rigName, rig, clips, meta) {
  const { rotQ, trnQ } = quantise(clips);
  const lines = [];
  lines.push('/* eslint-disable */');
  lines.push('/**');
  lines.push(` * GENERATED by src/anim/bake/retarget.mjs — do not edit by hand.`);
  lines.push(` * Source: ${meta.source} (Quaternius, CC0-1.0). Scale ${meta.scale.toFixed(5)}.`);
  lines.push(' *');
  lines.push(' * Rest pose plus retargeted clips for the ' + rigName + ' rig. Rotations are unit');
  lines.push(' * quaternions quantised to Int16 (×32767); root translations to 0.1 mm.');
  lines.push(' */');
  lines.push('');
  lines.push("import type { BakedRigData } from '../bakedTypes';");
  lines.push('');
  lines.push(`export const ${rigName}: BakedRigData = {`);
  lines.push(`  boneCount: ${rig.length},`);
  lines.push('  bones: [');
  for (const b of rig) {
    const f = (v) => Number(v.toFixed(6));
    lines.push(
      `    { name: '${b.name}', parent: ${b.parent}, ` +
      `restQ: [${b.restQ.map(f).join(', ')}], restT: [${b.restT.map(f).join(', ')}], ` +
      `localQ: [${b.localQ.map(f).join(', ')}], localT: [${b.localT.map(f).join(', ')}] },`
    );
  }
  lines.push('  ],');
  lines.push('  clips: [');
  for (const c of clips) {
    lines.push(
      `    { name: '${c.name}', frames: ${c.frames}, duration: ${Number(c.duration.toFixed(4))}, ` +
      `loop: ${c.loop}, rootSpeed: ${Number(c.rootSpeed.toFixed(4))} },`
    );
  }
  lines.push('  ],');
  lines.push(`  rot: '${b64(rotQ)}',`);
  lines.push(`  rootT: '${b64(trnQ)}',`);
  lines.push('};');
  lines.push('');
  writeFileSync(file, lines.join('\n'));
  const kb = (rotQ.byteLength + trnQ.byteLength) / 1024;
  console.log(`  → ${path.relative(ROOT, file)}  ${rig.length} bones, ${clips.length} clips, ${kb.toFixed(1)} KB payload`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run(assetPath, bones, clipSpecs, rigName, outFile, targetHeightHint) {
  const file = path.join(ROOT, assetPath);
  console.log(`• ${assetPath}`);
  const gltf = loadGltf(file);
  const restLocal = gltf.nodes.map((n) => ({
    q: qnorm([...(n.rotation || [0, 0, 0, 1])]),
    t: [...(n.translation || [0, 0, 0])],
  }));

  // Bind-pose height of the source mesh: the scale that maps source units to metres.
  let hi = -Infinity;
  let lo = Infinity;
  for (const n of gltf.nodes) {
    if (n.mesh === undefined || n.skin === undefined) continue;
    for (const pr of gltf.json.meshes[n.mesh].primitives) {
      const P = gltf.accessor(pr.attributes.POSITION);
      for (let k = 0; k < P.count; k++) {
        const y = P.data[k * 3 + 1];
        if (y > hi) hi = y;
        if (y < lo) lo = y;
      }
    }
  }
  const scale = targetHeightHint / (hi - lo);
  const srcWorldRest = sourceRest(gltf, scale);
  const rig = buildRig(gltf, bones, srcWorldRest);

  if (DIAG) {
    console.log(`  source bind height ${(hi - lo).toFixed(3)} -> scale ${scale.toFixed(4)}`);
    for (const b of rig) {
      const d = qrot(b.restQ, [0, 1, 0]);
      console.log(
        `    ${b.name.padEnd(11)} p=${String(b.parent).padStart(2)} ` +
        `rest=(${b.restT.map((v) => v.toFixed(3)).join(',')}) ` +
        `dir=(${d.map((v) => v.toFixed(2)).join(',')})`
      );
    }
  }

  const clips = clipSpecs.map((s) =>
    retargetClip(gltf, rig, srcWorldRest, restLocal, s, scale)
  );
  for (const c of clips) {
    console.log(
      `    ${c.name.padEnd(12)} ${c.frames}f dur ${c.duration.toFixed(2)}s ` +
      `stride ${c.stride.toFixed(2)}m -> ${c.rootSpeed.toFixed(2)} m/s`
    );
  }
  emit(path.join(ROOT, outFile), rigName, rig, clips, { source: assetPath, scale });
}

run(
  'public/assets/models/characters/Adventurer.gltf',
  MAN_BONES,
  MAN_CLIPS,
  'MAN_BAKED',
  'src/anim/generated/manBaked.gen.ts',
  1.75
);

run(
  'public/assets/models/animals/Horse.gltf',
  HORSE_BONES,
  HORSE_CLIPS,
  'HORSE_BAKED',
  'src/anim/generated/horseBaked.gen.ts',
  2.05
);
