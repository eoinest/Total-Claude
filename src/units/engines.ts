import type { UnitTypeDef } from '../sim/types';
import { Clip } from '../sim/types';
import { hash01 } from '../util/rand';
import { ARM_DRAWN, ARM_REST, CLAW_DRAWN_Z, CLAW_REST_Z } from './engineMesh';

/**
 * Siege engines as *units*: how many machines a battery fields, where its crew stand, and
 * what the machine is doing at any moment.
 *
 * ## The shape of the problem
 * The simulation has no concept of a machine. It knows a `scorpio` unit is N men in a
 * formation with a missile whose `rate` is 3 shots a minute, and `Projectiles.ts` runs one
 * volley state machine per *unit*: aim 0.55 s, release over a 0.92 s ragged window, then
 * reload for `60 / rate` seconds. That is the whole of what the sim will tell us.
 *
 * It turns out to be enough, and it is a much better clock than anything invented here would
 * be, because it is the clock the bolts actually leave on. A 20 s reload is exactly the
 * winching time a two-man crew needs for a three-span engine, so the machine's cycle is
 * derived from it rather than run alongside it:
 *
 *     release ──▶ recover 0.9 s ──▶ wind 0..1 ──▶ load ──▶ held at full draw ──▶ release
 *
 * The release itself is detected from the crew's `ammo`, which `Projectiles.ts` decrements on
 * the frame a bolt is created. So the string lets go on the frame a bolt appears, and no part
 * of this has to guess.
 *
 * ## Crew placement is visual only
 * The sim puts the crew in a `line` formation like any other infantry: 0.86 m apart in ranks.
 * A crew serving a machine does not stand in ranks, so the renderer moves them onto stations
 * around their engine — the same licence `UnitRenderSystem`'s `slotOff` already takes, an
 * order of magnitude larger. Nothing writes back to the pool, so collision, the spatial hash,
 * combat reach and the projectile origin all still see the formation slot. The engines are
 * laid out on a pitch close to the formation's own frontage precisely to keep that divergence
 * small: at `ENGINE_PITCH` a man is never more than about 2 m from where the sim has him.
 */

/**
 * Men to a machine.
 *
 * Vitruvius' three-span scorpio is a two-man engine and Vegetius' *carroballista* has eleven,
 * but most of those eleven are mule handlers. Three is what a battery looks like in action:
 * one on the windlass and trigger, one laying the bolt, one bringing them up.
 */
export const CREW_PER_ENGINE = 3;

/**
 * Metres between engines in a battery.
 *
 * Wide enough to swing a handspike and pass a bolt between two guns, narrow enough that the
 * battery still reads as one object in a wide shot — and close to the frontage the sim's own
 * `line` formation gives the crew, which is what keeps the visual offset small.
 */
export const ENGINE_PITCH = 3.6;

/** Is this unit type drawn as machines with crews rather than as men in ranks? */
export const isEngineUnit = (def: UnitTypeDef): boolean => def.unitClass === 'artillery';

/** How many machines a battery of this many men fields. */
export const engineCount = (crew: number): number =>
  Math.max(1, Math.round(crew / CREW_PER_ENGINE));

/** Lateral offset of engine `k` of `n`, in the unit's own frame. */
export const engineOffsetX = (k: number, n: number): number =>
  (k - (n - 1) * 0.5) * ENGINE_PITCH;

/**
 * A crew station: where a man stands relative to his engine, and which way he faces.
 *
 * `x` is lateral and `z` is downrange, both in the engine's own frame — the same convention
 * `engineMesh.ts` builds in. `turn` is added to the engine's yaw.
 *
 * The clearances are not arbitrary. The arms sweep out to |x| = 0.66 between z = 0 and
 * z = 0.62, so anyone standing beside the machine has to be outboard of that and behind it,
 * or an arm goes through his chest on every shot. The windlass man stands clear of the rear
 * tripod legs at z = -0.54, and the ammunition server stands at the bolt basket.
 */
export interface CrewStation {
  readonly x: number;
  readonly z: number;
  readonly turn: number;
  /** Label, for the probe's benefit. */
  readonly role: 'windlass' | 'loader' | 'server';
}

export const CREW_STATIONS: readonly CrewStation[] = [
  // On the centreline behind the drum, where his weight goes onto the handspikes and where
  // he can sight down the groove. This is also the station that keeps the sim's bolt origin
  // honest: `Projectiles.ts` launches from the firing man's own position, so the man nearest
  // the machine's axis is the one who should be shooting.
  { x: 0, z: -1.42, turn: 0, role: 'windlass' },
  // Outboard of the arm sweep on the left, turned in to the groove.
  { x: -1.02, z: -0.26, turn: 1.30, role: 'loader' },
  // At the bolt basket, half turned toward the gun.
  { x: 1.08, z: -0.94, turn: -1.85, role: 'server' },
];

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

/** Seconds after a shot before the crew close back up on the machine. */
const RECOVER = 0.9;
/** Seconds the crew spend laying the bolt in the groove once the winch is home. */
const LOAD_TIME = 1.6;
/** Longest a crew is shown winding, whatever the roster's reload is. */
const WIND_MAX = 13.5;
/** Fraction of the reload the winding takes when the reload is short. */
const WIND_FRACTION = 0.62;

export interface EnginePose {
  /** 0 = string forward and relaxed, 1 = full draw. */
  draw: number;
  /** 0 = at rest, 1 = the instant of the shot. Rings down over about half a second. */
  recoil: number;
  /** 1 while a bolt is in the groove. */
  loaded: number;
  /** Which phase, for choosing what the crew are doing. */
  phase: EnginePhase;
}

export const enum EnginePhase {
  /** Just shot: slider thrown forward, machine rocking, crew stepping back in. */
  Recover = 0,
  /** On the windlass. */
  Wind = 1,
  /** Bolt going into the groove. */
  Load = 2,
  /** Wound, loaded, waiting for the order. */
  Ready = 3,
}

/**
 * Where the machine is in its cycle, `t` seconds after it last shot.
 *
 * `reload` is the sim's own reload gap in seconds, so a fatigued crew — whose reload
 * `Projectiles.ts` stretches by up to half — is visibly slower on the winch rather than
 * winding at parade speed and then standing about.
 */
export function enginePose(t: number, reload: number, out: EnginePose): EnginePose {
  const wind = Math.min(WIND_MAX, Math.max(2.5, reload * WIND_FRACTION));
  // The kick: a damped ring at about 4 Hz. Torsion engines are heavy and stiff, so this is
  // over inside half a second — a long floaty recoil reads as a spring, not as timber.
  out.recoil = t < 0.65 ? Math.exp(-t * 7.4) * Math.cos(t * 26) : 0;
  if (t < RECOVER) {
    out.draw = 0;
    out.loaded = 0;
    out.phase = EnginePhase.Recover;
  } else if (t < RECOVER + wind) {
    // Ease the winch: a windlass starts hard against the untwisted springs and the last
    // turns are the slowest, so a linear ramp is the one shape it is not.
    const k = (t - RECOVER) / wind;
    out.draw = k * k * (3 - 2 * k);
    out.loaded = 0;
    out.phase = EnginePhase.Wind;
  } else if (t < RECOVER + wind + LOAD_TIME) {
    out.draw = 1;
    // The bolt appears part way through the load, not at the start of it.
    out.loaded = t - (RECOVER + wind) > LOAD_TIME * 0.45 ? 1 : 0;
    out.phase = EnginePhase.Load;
  } else {
    out.draw = 1;
    out.loaded = 1;
    out.phase = EnginePhase.Ready;
  }
  return out;
}

export const emptyPose = (): EnginePose => ({
  draw: 1, recoil: 0, loaded: 1, phase: EnginePhase.Ready,
});

/** Local slider position for a draw fraction. */
export const sliderZOf = (draw: number): number =>
  CLAW_REST_Z + (CLAW_DRAWN_Z - CLAW_REST_Z) * draw;

/** Arm sweep for a draw fraction, radians. */
export const armPhiOf = (draw: number): number =>
  ARM_REST + (ARM_DRAWN - ARM_REST) * draw;

/** An engine whose crew are all dead: string forward, groove empty, nobody serving it. */
export const ABANDONED: EnginePose = {
  draw: 0, recoil: 0, loaded: 0, phase: EnginePhase.Recover,
};

/**
 * What a crewman is doing, as a `Clip` the renderer can look up.
 *
 * Only consulted while the *simulation* has the man idle. During the volley itself the sim
 * puts the whole crew into `Throwing` and the throw clip plays, which is the right pose for
 * heaving on a lever anyway; overriding it there would fight the state machine and desync the
 * pose from the bolt.
 *
 * There is no purpose-authored artillery clip to reach for — `src/anim` is a fixed set of 24
 * — so these are chosen for what they read as at thirty metres rather than for their names.
 * `ThrowPilum` is a whole-body wind-up and heave, which is a windlass stroke; `AttackThrust`
 * is a forward lunge with both hands, which is a bolt going home in the groove.
 */
export function crewClip(station: number, phase: EnginePhase): Clip {
  const role = CREW_STATIONS[station % CREW_STATIONS.length].role;
  if (role === 'windlass') {
    return phase === EnginePhase.Wind ? Clip.ThrowPilum
      : phase === EnginePhase.Recover ? Clip.IdleAlert
        : Clip.IdleBrace;
  }
  if (role === 'loader') {
    return phase === EnginePhase.Load ? Clip.AttackThrust
      : phase === EnginePhase.Ready ? Clip.IdleAlert
        : Clip.IdleRelaxed;
  }
  return phase === EnginePhase.Wind ? Clip.IdleRelaxed : Clip.IdleAlert;
}

/**
 * Per-man stand-off from his station.
 *
 * Three men serving a machine are not on marks. Drawn from the man's stable hash so his own
 * untidiness is his for the battle, and kept under 0.2 m so he still reads as being at his
 * post rather than wandering.
 */
export function stationJitter(variant: number, out: [number, number, number]): void {
  const seed = Math.floor(variant * 16777216);
  out[0] = (hash01(seed, 141) - 0.5) * 0.34;
  out[1] = (hash01(seed, 142) - 0.5) * 0.30;
  out[2] = (hash01(seed, 143) - 0.5) * 0.55;
}
