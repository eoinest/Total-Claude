import { Clip, type ClipInfo } from '../sim/types';
import { MAN_BAKED } from './generated/manBaked.gen';
import { HORSE_BAKED } from './generated/horseBaked.gen';
import { MAN_RIG, HORSE_RIG, type Rig } from './rig';
import { decodeBaked, buildOverlay, measureRootSpeed, frameGlobals, type PoseClip } from './pose';
import { qrotate } from './quat';
import {
  MAN_OVERLAYS, HORSE_OVERLAYS, MAN_CONTACTS, HORSE_CONTACTS,
} from './authored';

/**
 * The clip registry: the bridge between `Clip` in the simulation and the animation data.
 *
 * The sim knows 24 clips. The renderer needs more than that — a mounted man cannot play
 * the same March as a man on foot — so the registry holds a superset and maps the enum
 * onto it twice, once for infantry and once for riders, plus a third map that picks the
 * horse's own gait from the rider's state.
 *
 * Everything is built once at module load: decode the baked payloads, evaluate the
 * authored overlays, then measure the locomotion clips' real stride so `rootSpeed` is
 * the truth rather than the intent.
 */

function buildSet(
  rig: Rig,
  baked: ReturnType<typeof decodeBaked>,
  overlays: { base: string; def: import('./pose').OverlayDef }[],
  contacts: readonly number[]
): Map<string, PoseClip> {
  const out = new Map(baked);
  for (const { base, def } of overlays) {
    const b = out.get(base);
    if (!b) throw new Error(`[clips] overlay "${def.name}" wants missing base "${base}"`);
    out.set(def.name, buildOverlay(rig, b, def));
  }
  // Re-measure locomotion. An overlay that amplifies hip flexion lengthens the stride,
  // and the renderer picks playback rate from rootSpeed, so a stale value shows up
  // immediately as sliding feet.
  for (const clip of out.values()) {
    if (clip.rootSpeed > 0.1) clip.rootSpeed = measureRootSpeed(rig, clip, contacts) || clip.rootSpeed;
  }
  return out;
}

const manClips = buildSet(MAN_RIG, decodeBaked(MAN_BAKED), MAN_OVERLAYS, MAN_CONTACTS);
const horseClips = buildSet(HORSE_RIG, decodeBaked(HORSE_BAKED), HORSE_OVERLAYS, HORSE_CONTACTS);

// ---------------------------------------------------------------------------
// Clip -> data mapping
// ---------------------------------------------------------------------------

/** Infantry: the clip a man on foot plays for each simulation clip. */
const FOOT_NAMES: Record<Clip, string> = {
  [Clip.IdleRelaxed]: 'idleRelaxedReady',
  [Clip.IdleAlert]: 'idleAlertReady',
  [Clip.IdleBrace]: 'idleBrace',
  [Clip.Walk]: 'walkLoose',
  [Clip.March]: 'march',
  [Clip.Run]: 'runReady',
  [Clip.Charge]: 'charge',
  [Clip.AttackOverhead]: 'attackOverhead',
  [Clip.AttackThrust]: 'attackThrust',
  [Clip.AttackSlash]: 'attackSlash',
  [Clip.ShieldBash]: 'shieldBash',
  [Clip.Block]: 'block',
  [Clip.Parry]: 'parry',
  [Clip.Stagger]: 'stagger',
  [Clip.ThrowPilum]: 'throwPilum',
  [Clip.DrawBow]: 'drawBow',
  [Clip.ReleaseBow]: 'releaseBow',
  [Clip.DeathBack]: 'deathBack',
  [Clip.DeathForward]: 'deathForward',
  [Clip.DeathSide]: 'deathSide',
  [Clip.DeathKneel]: 'deathKneel',
  [Clip.Flee]: 'flee',
  [Clip.Cheer]: 'cheer',
  [Clip.ClimbLadder]: 'climbLadder',
  [Clip.Count]: 'idleAlertReady',
};

/**
 * Shape variants of the infantry clips, chosen per man from his stable hash.
 *
 * Bucket 0 is always the clip named in `FOOT_NAMES`, so anything that does not list
 * variants here simply resolves to the same clip three times over and the renderer needs
 * no special case. The clips that *do* list variants are the ones a formation spends its
 * time in — standing, walking, and the two blows that get thrown most often — because
 * that is where a repeated silhouette is visible for long enough to be noticed.
 */
export const FOOT_VARIANTS = 3;

const FOOT_VARIANT_NAMES: Partial<Record<Clip, readonly string[]>> = {
  [Clip.IdleRelaxed]: ['idleRelaxedReady', 'idleRelaxedLean', 'idleAlertShift'],
  [Clip.IdleAlert]: ['idleAlertReady', 'idleAlertShift', 'idleAlertWatch'],
  [Clip.IdleBrace]: ['idleBrace', 'idleBraceLow', 'idleBrace'],
  [Clip.Walk]: ['walkLoose', 'walkLooseRoll', 'marchShort'],
  [Clip.March]: ['march', 'marchShort', 'marchLong'],
  // Every locomotion clip lists three *distinct* variants with three different measured
  // strides. A repeated name is not a free pass: playback rate is ground speed over stride,
  // so two men on the same clip in the same unit run at exactly the same cadence and their
  // relative phase never drifts. That frozen phase relationship is what a rank in lockstep
  // looks like, and it is why Run, Charge and Flee — which used to name two clips between
  // three buckets — were the worst offenders.
  [Clip.Run]: ['runReady', 'runLow', 'runLong'],
  [Clip.Charge]: ['charge', 'chargeHigh', 'chargeLow'],
  [Clip.Flee]: ['flee', 'fleeOther', 'fleePanic'],
  [Clip.AttackThrust]: ['attackThrust', 'attackThrustHigh', 'attackThrust'],
  [Clip.AttackOverhead]: ['attackOverhead', 'attackOverheadCross', 'attackOverhead'],
};

/**
 * The testudo's own clip table, keyed by a man's place in the shell rather than by `Clip`.
 *
 * It is separate from `FOOT_NAMES` and from `FOOT_VARIANT_NAMES` on purpose, and the reason
 * is the whole shape of the feature. Every other clip in this file is chosen by what a man
 * is *doing*, which is a simulation fact and reaches the renderer through `pool.animClip`.
 * Which board of a testudo a man is holding is decided by where he is standing in it —
 * front rank, second rank, an interior tile course, a flank — and that is a *rendering*
 * fact, derived from `pool.slot` and the unit's live width. Routing it through `Clip` would
 * mean five new simulation states that the simulation has no use for and that
 * `stateHash.ts` would then have to have an opinion about.
 *
 * `UnitRenderSystem.testudoClip` picks the role; this maps the role and whether he is
 * walking onto the clip. See the big comment over the poses in `authored.ts`.
 */
export const enum TestudoRole {
  /** Front rank: board upright and planted. */
  Face = 0,
  /** Second rank: the 46° glacis that closes the band at head height. */
  Nose = 1,
  /** Interior, tile course one: level. */
  RoofA = 2,
  /** Interior, tile course two: 4° off level, so the courses lap. */
  RoofB = 3,
  /** Flanks and rear, turned outward: board upright and proud of the roof line. */
  Flank = 4,
  Count = 5,
}

const TESTUDO_NAMES: readonly string[] = [
  'testudoFace', 'testudoNose', 'testudoRoofA', 'testudoRoofB', 'testudoFlank',
];
const TESTUDO_MARCH_NAMES: readonly string[] = TESTUDO_NAMES.map((n) => `${n}March`);

/** Riders: seated variants. A mounted man never plays a footed locomotion clip. */
const RIDE_NAMES: Record<Clip, string> = {
  [Clip.IdleRelaxed]: 'rideIdle',
  [Clip.IdleAlert]: 'rideIdle',
  [Clip.IdleBrace]: 'rideIdle',
  [Clip.Walk]: 'rideMove',
  [Clip.March]: 'rideMove',
  [Clip.Run]: 'rideGallop',
  [Clip.Charge]: 'rideCharge',
  [Clip.AttackOverhead]: 'rideCharge',
  [Clip.AttackThrust]: 'rideCharge',
  [Clip.AttackSlash]: 'rideCharge',
  [Clip.ShieldBash]: 'rideCharge',
  [Clip.Block]: 'rideIdle',
  [Clip.Parry]: 'rideMove',
  [Clip.Stagger]: 'rideMove',
  [Clip.ThrowPilum]: 'rideCharge',
  [Clip.DrawBow]: 'rideMove',
  [Clip.ReleaseBow]: 'rideMove',
  [Clip.DeathBack]: 'rideDeath',
  [Clip.DeathForward]: 'rideDeath',
  [Clip.DeathSide]: 'rideDeath',
  [Clip.DeathKneel]: 'rideDeath',
  [Clip.Flee]: 'rideGallop',
  [Clip.Cheer]: 'rideIdle',
  [Clip.ClimbLadder]: 'rideIdle',
  [Clip.Count]: 'rideIdle',
};

/**
 * The horse's gait ladder, slowest first.
 *
 * A mount's gait belongs to its *speed*, not to its rider's state. Mapping it off the
 * rider — as this used to — puts a horse into a trot because the man on it is in
 * `Clip.Run`, which for the roster's cavalry means 7.4 m/s: two and a half times what a
 * horse trots at. Playback rate is ground speed over measured stride, so the trot then had
 * to run at 2.2x to keep the hooves planted and the animal became a sewing machine.
 *
 * With a ladder the renderer picks the gait whose own tempo is closest to how fast the
 * animal is actually going, and every gait plays near rate 1. The band edges live in the
 * render system, with hysteresis, because that is where the measured speed is.
 */
const HORSE_GAIT_NAMES = ['idle', 'walk', 'trot', 'gallopOpen'] as const;

/**
 * The charge is the gallop with a different carriage, and it is chosen by intent rather
 * than speed: a horse driven at a line of men stretches its neck out, one merely running
 * away does not.
 */
const HORSE_CHARGE_NAME = 'charge';

/** Where the rider's state, not his speed, settles what the animal does. */
const HORSE_STATE_NAMES: Partial<Record<Clip, string>> = {
  [Clip.Stagger]: 'rear',
  [Clip.DeathBack]: 'death',
  [Clip.DeathForward]: 'death',
  [Clip.DeathSide]: 'death',
  [Clip.DeathKneel]: 'death',
};

/** Rider states that call for the charge carriage once the animal is up to speed. */
const HORSE_CHARGE_CLIPS: readonly Clip[] = [
  Clip.Charge, Clip.AttackOverhead, Clip.AttackThrust, Clip.AttackSlash,
  Clip.ShieldBash, Clip.ThrowPilum,
];

/**
 * Impact timing the combat system needs. The baked clips carry no hit frame of their own
 * because the source library was never authored against a hit-detection window, so these
 * are read off the motion: the frame at which the weapon is at full extension.
 */
const HIT_FRAMES: Record<string, number> = {
  attackThrust: 0.46,
  attackThrustHigh: 0.46,
  attackOverhead: 0.44,
  attackOverheadCross: 0.44,
  attackSlash: 0.42,
  shieldBash: 0.4,
  throwPilum: 0.52,
  releaseBow: 0.34,
  rideCharge: 0.5,
  stagger: 0.18,
};

/**
 * A packed set of clips plus the row each occupies in the animation texture.
 * Only clips actually referenced by a map are packed; the bases some overlays are built
 * from (a fantasy sword slash, a wave) never reach the GPU.
 */
export interface ClipSet {
  readonly rig: Rig;
  readonly clips: readonly PoseClip[];
  /** First texture row of each clip. */
  readonly rows: Int32Array;
  readonly totalRows: number;
  index(name: string): number;
}

function packSet(rig: Rig, source: Map<string, PoseClip>, used: readonly string[]): ClipSet {
  const names = [...new Set(used)];
  const clips: PoseClip[] = [];
  const rows = new Int32Array(names.length);
  const index = new Map<string, number>();
  let row = 0;
  names.forEach((name, i) => {
    const c = source.get(name);
    if (!c) throw new Error(`[clips] missing clip "${name}"`);
    if (HIT_FRAMES[name] !== undefined) c.hitFrame = HIT_FRAMES[name];
    clips.push(c);
    rows[i] = row;
    row += c.frames;
    index.set(name, i);
  });
  return {
    rig,
    clips,
    rows,
    totalRows: row,
    index(name: string): number {
      const i = index.get(name);
      if (i === undefined) throw new Error(`[clips] "${name}" is not packed`);
      return i;
    },
  };
}

const manUsed = [
  ...Object.values(FOOT_NAMES),
  ...Object.values(RIDE_NAMES),
  ...Object.values(FOOT_VARIANT_NAMES).flat(),
  ...TESTUDO_NAMES,
  ...TESTUDO_MARCH_NAMES,
];
export const MAN_CLIP_SET = packSet(MAN_RIG, manClips, manUsed);
export const HORSE_CLIP_SET = packSet(HORSE_RIG, horseClips, [
  ...HORSE_GAIT_NAMES,
  HORSE_CHARGE_NAME,
  ...Object.values(HORSE_STATE_NAMES),
]);

const mapTo = (set: ClipSet, names: Record<Clip, string>): Int32Array => {
  const out = new Int32Array(Clip.Count);
  for (let c = 0; c < Clip.Count; c++) out[c] = set.index(names[c as Clip]);
  return out;
};

/** `Clip` -> index into `MAN_CLIP_SET.clips`, for a man on foot. */
export const FOOT_CLIP_MAP = mapTo(MAN_CLIP_SET, FOOT_NAMES);

/** `TestudoRole * 2 + (moving ? 1 : 0)` -> index into `MAN_CLIP_SET.clips`. */
export const TESTUDO_CLIP_MAP = ((): Int32Array => {
  const out = new Int32Array(TestudoRole.Count * 2);
  for (let r = 0; r < TestudoRole.Count; r++) {
    out[r * 2] = MAN_CLIP_SET.index(TESTUDO_NAMES[r]);
    out[r * 2 + 1] = MAN_CLIP_SET.index(TESTUDO_MARCH_NAMES[r]);
  }
  return out;
})();

/**
 * `Clip * FOOT_VARIANTS + bucket` -> index into `MAN_CLIP_SET.clips`, for a man on foot.
 * Bucket 0 always equals `FOOT_CLIP_MAP`.
 */
export const FOOT_CLIP_VARIANT_MAP = ((): Int32Array => {
  const out = new Int32Array(Clip.Count * FOOT_VARIANTS);
  for (let c = 0; c < Clip.Count; c++) {
    const names = FOOT_VARIANT_NAMES[c as Clip];
    for (let v = 0; v < FOOT_VARIANTS; v++) {
      out[c * FOOT_VARIANTS + v] = names
        ? MAN_CLIP_SET.index(names[v % names.length])
        : FOOT_CLIP_MAP[c];
    }
  }
  return out;
})();
/** `Clip` -> index into `MAN_CLIP_SET.clips`, for a mounted man. */
export const RIDE_CLIP_MAP = mapTo(MAN_CLIP_SET, RIDE_NAMES);

/**
 * Gait ladder as indices into `HORSE_CLIP_SET.clips`, slowest first, with the natural
 * ground speed each one was measured to cover. The render system walks this against a
 * mount's own speed; `HORSE_GAIT_STRIDE[g]` is the metres one cycle covers, so cycles per
 * second is simply speed / stride.
 */
export const HORSE_GAIT_LADDER: Int32Array =
  Int32Array.from(HORSE_GAIT_NAMES, (n) => HORSE_CLIP_SET.index(n));
export const HORSE_GAIT_STRIDE: Float32Array = Float32Array.from(HORSE_GAIT_LADDER, (i) => {
  const c = HORSE_CLIP_SET.clips[i];
  return c.rootSpeed * c.duration;
});
/** Index of the charge carriage; substituted for the top gait when the rider means it. */
export const HORSE_CHARGE_CLIP = HORSE_CLIP_SET.index(HORSE_CHARGE_NAME);
/** Index into `HORSE_CLIP_SET.clips` of the rear, the one-shot a checked horse plays. */
export const HORSE_REAR_CLIP = HORSE_CLIP_SET.index('rear');
/**
 * The walk's rung on `HORSE_GAIT_LADDER`.
 *
 * Named because the render system needs the walk/trot crossover for something other than
 * choosing a gait — see `REAR_EDGE` in `UnitRenderSystem` — and a literal `1` there would
 * be a silent lie the day a rung is inserted.
 */
export const HORSE_WALK_RUNG = HORSE_GAIT_NAMES.indexOf('walk');
/**
 * `Clip` -> index into `HORSE_CLIP_SET.clips`, or -1 when the mount's own speed decides.
 * Positive entries are one-shots (a rear, a fall) and must not be rate-matched.
 */
export const HORSE_STATE_MAP: Int32Array = ((): Int32Array => {
  const out = new Int32Array(Clip.Count).fill(-1);
  for (const [c, name] of Object.entries(HORSE_STATE_NAMES)) {
    out[Number(c) as Clip] = HORSE_CLIP_SET.index(name as string);
  }
  return out;
})();
/** Rider clips that want the charge carriage rather than the plain gallop. */
export const HORSE_CHARGE_MASK: Uint8Array = ((): Uint8Array => {
  const out = new Uint8Array(Clip.Count);
  for (const c of HORSE_CHARGE_CLIPS) out[c] = 1;
  return out;
})();

/**
 * Where a point rigidly bound to one or two bones ends up, on every frame of every packed
 * clip. Three floats per animation row, indexed exactly as the animation texture is:
 * `(set.rows[clip] + frame) * 3`.
 *
 * This exists because the renderer has to place one instanced mesh against a moving point
 * on another — the rider on the saddle. The saddle is skinned to the horse's barrel and
 * loin, so where it *is* on a given frame is only knowable by running the horse's forward
 * kinematics, and the horse's back rises and falls by 15 cm through a gallop. Pinning the
 * rider to a rest-pose offset instead leaves him floating on the way down and sunk on the
 * way up, which is exactly what a static offset looked like.
 *
 * A rigid point needs no skinning matrix: express it once in the bone's rest frame and it
 * is a rotate-and-add per frame. Baked at init, ~170 rows for the horse, and read with two
 * array lookups in the hot loop.
 */
export function bakePointTrack(
  set: ClipSet,
  point: readonly [number, number, number],
  bone0: number,
  bone1 = bone0,
  weight0 = 1
): Float32Array {
  const rig = set.rig;
  const n = rig.boneCount;
  const out = new Float32Array(set.totalRows * 3);
  const worldQ = new Float32Array(n * 4);
  const worldT = new Float32Array(n * 3);
  const p = Float32Array.from(point);
  // The point in each bone's rest frame: bindInv applied once.
  const local = new Float32Array(6);
  const bones = [bone0, bone1];
  for (let k = 0; k < 2; k++) {
    const b = bones[k];
    qrotate(local, k * 3, rig.bindInvQ, b * 4, p, 0);
    local[k * 3] += rig.bindInvT[b * 3];
    local[k * 3 + 1] += rig.bindInvT[b * 3 + 1];
    local[k * 3 + 2] += rig.bindInvT[b * 3 + 2];
  }
  const w = [weight0, 1 - weight0];
  const tmp = new Float32Array(3);
  for (let ci = 0; ci < set.clips.length; ci++) {
    const clip = set.clips[ci];
    for (let f = 0; f < clip.frames; f++) {
      frameGlobals(rig, clip, f, worldQ, worldT);
      const o = (set.rows[ci] + f) * 3;
      for (let k = 0; k < 2; k++) {
        if (w[k] <= 0) continue;
        const b = bones[k];
        qrotate(tmp, 0, worldQ, b * 4, local, k * 3);
        out[o] += (tmp[0] + worldT[b * 3]) * w[k];
        out[o + 1] += (tmp[1] + worldT[b * 3 + 1]) * w[k];
        out[o + 2] += (tmp[2] + worldT[b * 3 + 2]) * w[k];
      }
    }
  }
  return out;
}

/** Mean of a baked point track over one clip — the clip's resting value for that point. */
export function meanPointOverClip(
  set: ClipSet,
  track: Float32Array,
  clipIndex: number
): [number, number, number] {
  const frames = set.clips[clipIndex].frames;
  const row = set.rows[clipIndex];
  let x = 0;
  let y = 0;
  let z = 0;
  for (let f = 0; f < frames; f++) {
    const o = (row + f) * 3;
    x += track[o]; y += track[o + 1]; z += track[o + 2];
  }
  return [x / frames, y / frames, z / frames];
}

/**
 * Clip metadata for the simulation and combat systems.
 *
 * Covers every value in the `Clip` enum, 0..`Clip.Count`. Reported against the infantry
 * variant, which is the one the sim's own state machine is written for.
 */
export function clipInfo(clip: Clip): ClipInfo {
  const idx = clip >= 0 && clip < Clip.Count ? FOOT_CLIP_MAP[clip] : FOOT_CLIP_MAP[Clip.IdleAlert];
  const c = MAN_CLIP_SET.clips[idx];
  return {
    clip,
    name: c.name,
    duration: c.duration,
    loop: c.loop,
    hitFrame: c.hitFrame,
    rootSpeed: c.rootSpeed > 0.05 ? c.rootSpeed : undefined,
  };
}

/** All clip metadata, for a debug overlay or a sanity check at boot. */
export const ALL_CLIP_INFO: ClipInfo[] = Array.from({ length: Clip.Count }, (_, i) => clipInfo(i as Clip));
