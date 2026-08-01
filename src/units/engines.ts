import type { UnitTypeDef } from '../sim/types';
import { Clip } from '../sim/types';
import { hash01 } from '../util/rand';
import type { Silhouette } from './engineMesh';
import {
  ARM_DRAWN, ARM_REST, CLAW_DRAWN_Z, CLAW_REST_Z, MUZZLE, ON_ARM_COCKED, ON_ARM_RELEASED,
  ON_ARM_R, ON_SLING, ONAGER_SILHOUETTE, SCORPIO_SILHOUETTE, onArmPoint,
} from './engineMesh';

/**
 * Which machine a battery is made of.
 *
 * Discriminated on the roster's own missile arc rather than on a unit id, because the arc *is*
 * the distinction: a bolt-thrower shoots flat at a man and a stone-thrower lobs at a wall, and
 * everything else about the two machines follows from that. A new artillery type needs no
 * change here.
 */
export const enum EngineKind {
  Scorpio = 0,
  Onager = 1,
}

export const engineKindOf = (def: UnitTypeDef): EngineKind =>
  def.missile?.arc === 'high' ? EngineKind.Onager : EngineKind.Scorpio;

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
 * Men to a machine, by kind.
 *
 * An onager takes four where a scorpio takes three, and that is the low end: Vegetius wants
 * eight to eleven on a stone-thrower, because winding a two-tonne machine down against its
 * skein is not a two-man job and somebody has to carry a 4 kg stone to it. Four is what fits
 * round the chassis without men standing inside the arm's sweep.
 */
export const CREW_OF: Record<EngineKind, number> = {
  [EngineKind.Scorpio]: 3,
  [EngineKind.Onager]: 4,
};

/**
 * Metres between engines in a battery.
 *
 * 4.4 m, up from 3.6. A critic measuring the battery off crew height objected that at the old
 * interval "adjacent arms nearly touch and crews foul each other", and the arithmetic backs it:
 * the arms span 1.9 m tip to tip and two crews work the ground between two guns, so 3.6 m left
 * about 0.85 m a side. The cost is that the machines now stand further from the formation slots
 * the simulation gave their crews — see the note on visual-only placement above — and about
 * 3 m of divergence at the wings is the price of a battery that reads as workable.
 */
export const ENGINE_PITCH = 4.4;

/**
 * Metres between engines, by kind. An onager's chassis is 3.8 m long and 1.1 m wide and its arm
 * sweeps the full height of the machine, so two of them on a scorpio's 3.6 m pitch would be
 * winding into each other.
 */
export const PITCH_OF: Record<EngineKind, number> = {
  [EngineKind.Scorpio]: ENGINE_PITCH,
  [EngineKind.Onager]: 6.2,
};

/**
 * How far forward of the unit anchor each kind's machine stands.
 *
 * The crew stations are all behind their engine, so the machine sits forward of the anchor to
 * bring the men back onto the formation slots the simulation actually gave them. An onager is
 * far longer than a scorpio and its crew work at the rear, so it needs more.
 */
export const FORWARD_OF: Record<EngineKind, number> = {
  [EngineKind.Scorpio]: 0.55,
  [EngineKind.Onager]: 1.35,
};

/** Is this unit type drawn as machines with crews rather than as men in ranks? */
export const isEngineUnit = (def: UnitTypeDef): boolean => def.unitClass === 'artillery';

/** How many machines a battery of this many men fields. */
export const engineCount = (crew: number): number =>
  Math.max(1, Math.round(crew / CREW_PER_ENGINE));

/** How many machines a battery of this many men fields, for a given machine. */
export const engineCountOf = (kind: EngineKind, men: number): number =>
  Math.max(1, Math.round(men / CREW_OF[kind]));

/** Lateral offset of engine `k` of `n`, in the unit's own frame. */
export const engineOffsetX = (k: number, n: number): number =>
  (k - (n - 1) * 0.5) * ENGINE_PITCH;

/**
 * Where engine `k` of `n` stands, given its unit's anchor and facing.
 *
 * The single source of the battery's layout. It lives here rather than in the renderer because
 * it stopped being a purely visual fact the moment the shot started leaving the *machine*
 * instead of leaving whichever crewman the volley loop happened to reach: the muzzle is now a
 * simulation position, and a renderer that computed it separately would draw the string letting
 * go somewhere the stone did not come from.
 */
export function engineAnchor(
  ux: number, uz: number, facing: number, kind: EngineKind, k: number, n: number,
  out: { x: number; z: number },
  site?: EngineSite
): void {
  const c = Math.cos(facing);
  const s = Math.sin(facing);
  const lx = (k - (n - 1) * 0.5) * PITCH_OF[kind];
  const fwd = FORWARD_OF[kind];
  out.x = ux + lx * c + fwd * s;
  out.z = uz - lx * s + fwd * c;
  if (site) siteEngine(out, s, c, kind, site);
}

/**
 * What a machine needs to know about the ground it is being put on.
 *
 * Duck-typed and optional, so a battle on open grass — and every unit test, and the model
 * viewer — needs no city at all. `masonryTopAt` is `CitySystem`'s O(1) query.
 */
export interface EngineSite {
  groundAt(x: number, z: number): number;
  masonryTopAt?(x: number, z: number): number;
}

/** How far a machine will walk itself backwards to get off masonry, and in what steps. */
const SITE_STEP = 1.3;
const SITE_TRIES = 8;
/** Metres of stone above the terrain before a spot counts as "on the wall" rather than "on a kerb". */
const SITE_CLEARANCE = 0.7;

/**
 * Refuse to emplace a machine on masonry, and step it back until it is on open ground.
 *
 * The player's report was that the big catapults "should not be located on the walls", and he is
 * right twice over: an onager is a field engine that Rome II sites behind the line, and a 3.8 m
 * chassis that rears against its own front sleeper cannot be worked on a wall-walk at all.
 *
 * Done as a *runtime query against whatever masonry exists* rather than as a coordinate rule,
 * because the curtain is being widened and its stairs rebuilt by another workstream while this
 * is being written. Any position hard-coded against today's wall would be wrong within the day;
 * "not standing on stone" stays true whatever shape the stone is.
 *
 * The machine walks backwards along its unit's own facing, which is the direction its crew came
 * from, so a battery pushed off a rampart ends up behind it rather than beside it.
 */
function siteEngine(
  out: { x: number; z: number },
  sinFacing: number, cosFacing: number,
  kind: EngineKind,
  site: EngineSite
): void {
  const top = site.masonryTopAt;
  if (!top) return;
  // A scorpio on a tripod is a two-man lift and Roman practice really did put carroballistae on
  // towers and wall-walks; Trajan's Column shows exactly that. Only the stone-thrower is barred.
  if (kind !== EngineKind.Onager) return;
  for (let i = 0; i < SITE_TRIES; i++) {
    if (top.call(site, out.x, out.z) <= site.groundAt(out.x, out.z) + SITE_CLEARANCE) return;
    out.x -= sinFacing * SITE_STEP;
    out.z -= cosFacing * SITE_STEP;
  }
}

/**
 * Where the shot actually leaves each machine, in the machine's own frame: `x` lateral,
 * `y` above the ground it stands on, `z` downrange.
 *
 * A scorpio's bolt leaves the front of the slider case, a little above the stock and on the
 * centreline. An onager's stone leaves the sling at the top of the arm's sweep, which is high
 * and slightly forward of the chassis — that is the whole reason a stone-thrower can shoot over
 * a friendly line and a bolt-thrower cannot.
 *
 * These were previously nowhere: every missile in the game left from `pool.y[i] + 1.45`, the
 * chest of whichever man in the crew the volley loop had got to, and for a battery on 4.4 m
 * centres that is up to three metres from the gun and never the muzzle.
 */
export const MUZZLE_OF: Record<EngineKind, readonly [number, number, number]> = {
  // The front of the scorpio's frame window, read out of the mesh so it cannot go stale when a
  // part moves.
  [EngineKind.Scorpio]: MUZZLE,
  // The onager's is *not* `onPouch(ON_ARM_RELEASED)`, which is where the pouch hangs when the
  // arm is home against its buffer — 1.39 m up and behind the arm tip. The stone does not leave
  // from there. The arm stops dead on the padded buffer and the loaded sling keeps going,
  // whipping up and over until one end lifts off the release pin with the sling roughly in line
  // with the arm; that is three quarters of a sling-length beyond the tip, and it is the reason
  // a stone-thrower can shoot over a friendly line while a bolt-thrower cannot. 3.7 m.
  [EngineKind.Onager]: onArmPoint(ON_ARM_R + ON_SLING * 0.75, ON_ARM_RELEASED),
};

/**
 * Seconds from a shot until the machine is wound, loaded and waiting.
 *
 * The cycle in `enginePose` is derived from the reload rather than the other way round, so this
 * is what the pose function will report as `EnginePhase.Ready` — the sim uses it to hold fire
 * until the machine actually is ready, which is the difference between a bolt leaving on the
 * release frame and a bolt leaving on an arbitrary tick.
 */
export const engineReadyAt = (reload: number): number =>
  RECOVER + Math.min(WIND_MAX, Math.max(2.5, reload * WIND_FRACTION)) + LOAD_TIME;

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

/**
 * Onager crew stations.
 *
 * Two men on the windlass at the rear, which is where the work is; one at the shot pile on the
 * right, where `buildOnagerGeometry` stacks the stones; one forward on the left beside the
 * buffer frame, clear of the arm's sweep. Nobody stands inside the plane the arm travels
 * through — an onager's arm goes from lying over the windlass to vertical in a tenth of a
 * second and it would take a man's head off.
 */
export const ONAGER_STATIONS: readonly CrewStation[] = [
  { x: -0.52, z: -2.35, turn: 0.22, role: 'windlass' },
  { x: 0.56, z: -2.35, turn: -0.22, role: 'windlass' },
  { x: 1.62, z: -0.62, turn: -1.72, role: 'server' },
  { x: -1.46, z: 0.72, turn: 1.44, role: 'loader' },
];

export const CREW_STATIONS: readonly CrewStation[] = [
  // On the centreline behind the drum, where his weight goes onto the handspikes and where
  // he can sight down the groove. This is also the station that keeps the sim's bolt origin
  // honest: `Projectiles.ts` launches from the firing man's own position, so the man nearest
  // the machine's axis is the one who should be shooting.
  { x: 0, z: -1.42, turn: 0, role: 'windlass' },
  // Outboard of the arm sweep on the left, turned in to the groove.
  // Well outboard of the arm sweep, which reaches x = 0.75 at z = -0.08 at full draw. At
  // -1.02 a critic read him as "standing inside the arms' swing arc"; -1.32 puts a clear half
  // metre between his chest and the arm at its widest.
  { x: -1.32, z: -0.44, turn: 1.24, role: 'loader' },
  // At the bolt basket, half turned toward the gun.
  { x: 1.08, z: -0.94, turn: -1.85, role: 'server' },
];

export const STATIONS_OF: Record<EngineKind, readonly CrewStation[]> = {
  [EngineKind.Scorpio]: CREW_STATIONS,
  [EngineKind.Onager]: ONAGER_STATIONS,
};

/** The outline points of each kind, for the bench camera's framing solve. */
export const SILHOUETTE_OF: Record<EngineKind, Silhouette> = {
  [EngineKind.Scorpio]: SCORPIO_SILHOUETTE,
  [EngineKind.Onager]: ONAGER_SILHOUETTE,
};

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

/**
 * Where in its cycle a gun starts when the battery is first seen.
 *
 * Not "wound and loaded", which is what it was, because that made every machine in a battery
 * identical until the first volley and a blind critic read it straight off the frame: "the same
 * helmet/tunic/pose triple repeats verbatim across all three weapon crews". The crews' poses
 * come from their engine's phase, so identical engines mean identical crews.
 *
 * Spread across the whole visible cycle instead, from just after a shot to fully wound. A
 * battery that has been in position for any length of time is genuinely like this — guns get
 * re-laid, a skein gets re-tensioned, one crew is always slower — and it means a battery
 * photographed at a random moment shows one gun wound, one loading and one on the winch.
 */
export const initialSinceShot = (h: number): number =>
  RECOVER + h * (WIND_MAX + LOAD_TIME + 5);

export const emptyPose = (): EnginePose => ({
  draw: 1, recoil: 0, loaded: 1, phase: EnginePhase.Ready,
});

/** Local slider position for a draw fraction. */
export const sliderZOf = (draw: number): number =>
  CLAW_REST_Z + (CLAW_DRAWN_Z - CLAW_REST_Z) * draw;

/** Scorpio arm sweep for a draw fraction, radians. */
export const armPhiOf = (draw: number): number =>
  ARM_REST + (ARM_DRAWN - ARM_REST) * draw;

/** Onager arm sweep for a draw fraction, radians off vertical. */
export const onagerArmOf = (draw: number): number =>
  ON_ARM_RELEASED + (ON_ARM_COCKED - ON_ARM_RELEASED) * draw;

/**
 * The value the shader reads out of `iState.x`, whichever machine this is.
 *
 * One instance attribute serves both because both articulate on exactly one angle; the shader
 * knows which frame that angle is in from the part id, so the renderer only has to agree on
 * the number.
 */
export const armStateOf = (kind: EngineKind, draw: number): number =>
  kind === EngineKind.Onager ? onagerArmOf(draw) : armPhiOf(draw);

/**
 * An onager's arm tip, in the machine's own frame, for a draw fraction.
 *
 * Exists so `tools/probe-scorpion.mjs` can answer "does the arm move, and through what arc?"
 * with metres rather than with a pixel diff — a diff of two rendered frames of a battery is
 * swamped by the crew's own animation and by cloud shadow crossing the field.
 */
export const onArmTip = (draw: number): [number, number, number] => {
  const p = onArmPoint(ON_ARM_R, onagerArmOf(draw));
  return [+p[0].toFixed(3), +p[1].toFixed(3), +p[2].toFixed(3)];
};

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
export function crewClip(kind: EngineKind, station: number, phase: EnginePhase): Clip {
  const table = STATIONS_OF[kind];
  const role = table[station % table.length].role;
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
