import { Clip, type ClipInfo } from '../sim/types';
import { MAN_BAKED } from './generated/manBaked.gen';
import { HORSE_BAKED } from './generated/horseBaked.gen';
import { MAN_RIG, HORSE_RIG, type Rig } from './rig';
import { decodeBaked, buildOverlay, measureRootSpeed, type PoseClip } from './pose';
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
  [Clip.Run]: ['runReady', 'runLow', 'runReady'],
  [Clip.Charge]: ['charge', 'chargeHigh', 'charge'],
  [Clip.Flee]: ['flee', 'fleeOther', 'flee'],
  [Clip.AttackThrust]: ['attackThrust', 'attackThrustHigh', 'attackThrust'],
  [Clip.AttackOverhead]: ['attackOverhead', 'attackOverheadCross', 'attackOverhead'],
};

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

/** The horse's own gait, chosen from what its rider is doing. */
const HORSE_NAMES: Record<Clip, string> = {
  [Clip.IdleRelaxed]: 'idle',
  [Clip.IdleAlert]: 'idle',
  [Clip.IdleBrace]: 'idle',
  [Clip.Walk]: 'walk',
  [Clip.March]: 'walk',
  [Clip.Run]: 'trot',
  [Clip.Charge]: 'charge',
  [Clip.AttackOverhead]: 'walk',
  [Clip.AttackThrust]: 'walk',
  [Clip.AttackSlash]: 'walk',
  [Clip.ShieldBash]: 'walk',
  [Clip.Block]: 'idle',
  [Clip.Parry]: 'walk',
  [Clip.Stagger]: 'rear',
  [Clip.ThrowPilum]: 'walk',
  [Clip.DrawBow]: 'walk',
  [Clip.ReleaseBow]: 'walk',
  [Clip.DeathBack]: 'death',
  [Clip.DeathForward]: 'death',
  [Clip.DeathSide]: 'death',
  [Clip.DeathKneel]: 'death',
  [Clip.Flee]: 'gallop',
  [Clip.Cheer]: 'idle',
  [Clip.ClimbLadder]: 'idle',
  [Clip.Count]: 'idle',
};

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
];
export const MAN_CLIP_SET = packSet(MAN_RIG, manClips, manUsed);
export const HORSE_CLIP_SET = packSet(HORSE_RIG, horseClips, Object.values(HORSE_NAMES));

const mapTo = (set: ClipSet, names: Record<Clip, string>): Int32Array => {
  const out = new Int32Array(Clip.Count);
  for (let c = 0; c < Clip.Count; c++) out[c] = set.index(names[c as Clip]);
  return out;
};

/** `Clip` -> index into `MAN_CLIP_SET.clips`, for a man on foot. */
export const FOOT_CLIP_MAP = mapTo(MAN_CLIP_SET, FOOT_NAMES);

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
/** `Clip` -> index into `HORSE_CLIP_SET.clips`. */
export const HORSE_CLIP_MAP = mapTo(HORSE_CLIP_SET, HORSE_NAMES);

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
