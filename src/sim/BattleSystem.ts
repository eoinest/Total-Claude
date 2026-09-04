import type { EngineContext, Subsystem } from '../core/Engine';
import { Rng, hash01 } from '../util/rand';
import { clamp, clamp01, damp, turnToward, wrapAngle } from '../util/math';
import {
  BASE_SPACING_X, BASE_SPACING_Z, closestPointOnSegment, formation, frontSegment, makeSegment,
  ranksFor, segmentDistance,
} from './formations';
import { assignSlots, formationCentroid } from './reform';
import { unitType, isCavalry } from '../units/roster';
import { ridesElephant } from '../units/kit';
import type { TerrainSystem } from '../terrain/TerrainSystem';
import {
  ALL_FACTIONS, Clip, Faction, SOLDIER_POOL_CAPACITY, SoldierPool, SoldierState, SpatialHash,
  UnitOrder, isAlive, type UnitGroupState, type UnitTypeDef,
} from './types';
import { Siege } from './Siege';
import { quantiseUnit } from './quantise';
import { ObstacleField, ROUGH_SLOWS_MOVEMENT, type Obstacle, type Resolved, type RoughBox } from './Obstacles';

/**
 * What the sim needs from the city subsystem, duck-typed.
 *
 * The CITY agent owns the real interface and Pydna registers no city at all, so this is
 * probed rather than imported: a map with no city yields an empty `ObstacleField` and the
 * whole collision path costs one `empty` test per tick.
 */
export interface ObstacleSource {
  getObstacles(): readonly Obstacle[];
  /**
   * Standing work a body crosses at a price rather than stops at — an unfinished bay.
   *
   * Optional, and probed rather than required, for the same reason the rest of this
   * interface is: the city agent owns it, Pydna has no city, and a circuit with nothing
   * half-built answers with an empty list. A sim that has not been taught about it simply
   * runs the collision path it always did.
   */
  getRoughGround?(): readonly RoughBox[];
  obstacleGeneration?: number;
}

/**
 * What the sim needs from the pathfinder, duck-typed for the same reason.
 *
 * Until now nothing outside `src/ai` ever asked it anything: the AI routed its own units
 * and the player's clicks went straight to a destination with no route at all. So a player
 * ordering a cohort to the far side of the Aurelian Wall got a unit that walked into it and
 * stopped, which is the second half of "they should path find around the wall".
 */
export interface NavProvider {
  directRouteClear(x1: number, z1: number, x2: number, z2: number, radius: number): boolean;
  clearLineFraction(x1: number, z1: number, x2: number, z2: number, radius: number): number;
  requestPath(
    unitId: number, sx: number, sz: number, gx: number, gz: number,
    radius: number, minRadius: number, priority?: number
  ): void;
  pathFor(unitId: number): { pts: number[]; n: number; goalX: number; goalZ: number; ok: boolean } | null;
  pending(unitId: number): boolean;
  clearPath(unitId: number): void;
  findStandable(x: number, z: number, radius: number, out: { x: number; z: number }): boolean;
}

/** A player move order waiting on a route. */
interface PendingRoute {
  gx: number;
  gz: number;
  facing: number;
  /** Ticks left before this attempt is abandoned. */
  ttl: number;
  /**
   * Attempts left after this one.
   *
   * A player order is worth re-asking for. The pathfinder drops a request whose TTL runs
   * out and caps a search that runs too long, and either way the caller hears nothing;
   * without a retry the unit keeps whatever destination the order came in with for the
   * rest of the battle. Measured before this existed: of eight units ordered across the
   * Aurelian Wall at once, six were never searched at all.
   */
  retries: number;
}

/**
 * Footprint radius a player-ordered route is searched for, metres.
 *
 * Deliberately narrow. Searching at the unit's true half-frontage (11 m for a cohort in
 * line) makes most city streets unroutable and the order silently fails; the per-man
 * collision then sorts out the frontage on the ground, spilling men into the side streets
 * as a real column does. What the route has to guarantee is that the *centre line* exists.
 */
const ROUTE_RADIUS = 2.2;

/**
 * Ticks a queued route may wait before the straight-line order simply stands.
 *
 * Four seconds. A city-crossing search is budgeted at 2,400 node expansions a tick against
 * a grid with 134,000 reachable cells, so a long one genuinely takes a second or two; the
 * unit is already walking the straight line in the meantime, so the only cost of waiting
 * is that the correction arrives late.
 */
const ROUTE_TTL = 120;

/** Times a player order will re-ask for a route before it settles for what it can reach. */
const ROUTE_RETRIES = 4;

/**
 * Times a unit that has walked a route to its end, short of where it was sent, will plan
 * again from where it got to.
 *
 * A\* returns the best route it found even when it could not reach the goal, and inside
 * Rome it very often cannot: the nav grid pads every solid by half a cell, so the narrower
 * streets are closed in it, and a destination in one of them is unreachable from outside.
 * The unit used to walk its partial route, run out of waypoints and stop — measured, six of
 * eight ordered 140 m inside the wall ended between 14 and 190 m short with an empty queue.
 * A fresh search from 80 m closer is a different and much smaller problem, and usually
 * solves it. Three attempts, so a genuinely unreachable goal costs three searches and then
 * the unit settles where it got to, which is the honest answer.
 */
const ROUTE_RESUMES = 3;

/** Within this of the ordered destination, a unit has arrived and stops re-planning. */
const ROUTE_ARRIVE_TOL = 7;

/**
 * Ticks between two attempts at re-planning the same order.
 *
 * Two seconds, and without it the retry budget evaporates in three ticks. A unit whose
 * straight line is blocked from the very first metre gets `holdShortOfSolid` reach of zero,
 * so its destination is where it already stands, so it "arrives" on the next tick, so it
 * re-plans — and the three attempts are gone before the first search has even been popped
 * off the queue. Measured: **71 of 71 units forced to Hold**, every one of them having spent
 * its whole budget inside a tenth of a second.
 */
const RESUME_COOLDOWN = 60;

/**
 * Ticks of a move order making no progress before the unit gives up on its current leg.
 *
 * A second and a half. The anchor slides along masonry rather than through it, and when
 * both axes are blocked it stops dead — but `updateUnitOrder` only pops the next waypoint
 * once the anchor gets within 0.35 m of the current one, so a jammed anchor holds a queue
 * of legs it will never consume. Measured on eight units funnelled through the Porta
 * Flaminia at once: four ended the run with 12 to 39 waypoints still queued and 0.0 m of
 * movement over the previous five seconds, 1.2 to 2.9 m from masonry. Nothing was wrong
 * with their routes; they simply could not reach the next point on one.
 */
const STALL_TICKS = 45;
/** Metres of anchor movement in a tick that counts as progress. Well under a walk step. */
const STALL_EPS = 0.02;

/**
 * How often a unit chasing an enemy re-examines its route, in ticks.
 *
 * A second and a half. The target moves, so the route staleness is real, but a formation
 * that re-plans every tick never commits to a leg — the same reason `OrderBook` holds a
 * facing order for 45 ticks.
 */
const ATTACK_REROUTE_TICKS = 45;

/** Scratch for the standable-goal nudge. */
const ROUTE_GOAL = { x: 0, z: 0 };

// ---------------------------------------------------------------------------
// Apertures — a formation entering a hole narrower than itself
//
// `ROUTE_RADIUS` above is the width a *route* is proved at, and it is deliberately far
// narrower than any formation on the field. That bargain — prove the centre line, let the
// per-man collider sort out the frontage — holds down a street and fails at a hole in a
// wall, because a street has room either side of the corridor and a gate has three and a
// half metres of masonry. Measured on Carthage's Porta Byrsae at the playable scale, 60
// equites in wedge with 23.32 m of frontage ordered through a 5.2 m carriageway: of 34,974
// man-ticks spent inside the gatehouse, 32,698 were outside the carriageway; 264 in every
// thousand man-ticks of the whole transit had the mount's own footprint overlapping stone;
// one man was pressed against the same face for 61 seconds; and fourteen of the sixty were
// still outside the wall seventy seconds after the order.
//
// The pathfinder already has a name for this — `NavPath.narrow`, "the route only fits if
// the unit narrows its frontage first" — and `TacticalAI` already acts on it by switching
// to `narrowestFormation`. Neither can reach this case:
//
//   * the sim asks for its routes with `radius === minRadius === ROUTE_RADIUS`, and
//     `narrow` is set from `radius < wantRadius - 0.5`, so a player order can never be
//     flagged narrow. Measured: one `requestPath` call per gate order, (2.2, 2.2), and
//     `narrow: false` on the path that came back.
//   * and it would not help if it could. `narrowestFormation` returns the narrowest
//     formation the *roster* offers, and for every cavalry unit in the game that is the
//     wedge it is already in — `footprintOf` gives equites max 8.07, min 8.07. Of the
//     eleven unit types on the Carthage field, three have a narrowest footprint that fits
//     inside a gate. No cavalry unit has one, in any formation, on any map.
//
// So the frontage has to be set by the hole rather than chosen from a menu, which is what
// this does: file up on the way in, spread out on the way out.
// ---------------------------------------------------------------------------

/**
 * How far ahead along the line of march the corridor is measured, metres.
 *
 * A unit-depth of warning. Shorter and a block reaches the gate before it has decided to
 * file up; longer and it files up for a hole it may never be sent through, in a city where
 * something is nearly always narrow somewhere ahead.
 */
const APERTURE_LOOK = 22;
/**
 * And behind it, in metres of the block's own depth.
 *
 * **The trailing half is what makes re-forming work, and leaving it out is not a small
 * error.** With look-ahead alone a unit spreads back out the instant its *anchor* is
 * through the gate, which is when its tail is still thirty metres back inside the passage:
 * measured, a squeezed column of equites filed up for exactly one second of a seventy-second
 * transit and spent the rest of it nine files wide with its own rear ranks in the gatehouse.
 * A formation is through an aperture when its last rank is through it.
 *
 * The cap is generous because the thing being measured is genuinely long: sixty horses at
 * two files is thirty ranks and 88 m of column. Capped at 34 m the tail beyond that was
 * invisible, the squeeze released with a third of the squadron still in the passage, and the
 * frames show twelve mounts back in the stone. It costs one cheap box test per 1.5 m.
 */
const APERTURE_TRAIL_MAX = 90;
/**
 * Spacing of the samples along that span, metres.
 *
 * **Fixed, and fine enough that no masonry can fall between two of them.** The first cut of
 * this sampled at four named look-aheads and three fractions of the block depth, and the
 * consequence is worth recording because it is the same class of defect as an instrument
 * that cannot see what it is measuring: a curtain wall is 3.5 m thick, the trailing samples
 * for a 38 m column land 13.6, 25.5 and 34 m behind the anchor, and all three of them
 * stepped clean over the gate the column was still standing in. The squeeze released after
 * four seconds of a transit that takes thirteen.
 *
 * 1.5 m is under half the thinnest thing on either circuit.
 */
const APERTURE_SCAN = 1.5;
/**
 * Most lateral corridor measurements one pass will make.
 *
 * The cheap gate — one fat-radius `solidAt` per sample — answers "is anything near this
 * line at all" for the whole span at about forty box tests. Only the samples it trips on
 * get the full lateral walk, and inside a city that can be most of them, so the walks are
 * capped and taken nearest-to-the-unit first: a corridor four metres ahead decides what
 * this formation does next, and one thirty metres behind does not.
 */
const APERTURE_PROBES = 8;
/** Lateral sampling step for the corridor measurement, metres. Under half a file. */
const APERTURE_STEP = 0.6;
/** Ticks between two corridor measurements for the same unit. A third of a second. */
const APERTURE_TICKS = 10;
/**
 * Metres of slack the corridor must gain before a filed-up unit spreads out again.
 *
 * Pure hysteresis, and it has to be at least a sampling step wide or a block sitting in a
 * gate mouth measures 5.4 m, spreads, measures 5.3 m, files up, and does that every ten
 * ticks for as long as it stands there. 2 m is a file and a half of infantry.
 */
const APERTURE_RELEASE = 2;
/**
 * Fewest files a formation will ever be squeezed to.
 *
 * Two, not one. A single file through a gate is a five-minute transit for a cohort and it
 * is not what a gate is for — the Porta Byrsae is 5.2 m precisely so that a cart and a
 * file of men pass at once. One file is reserved for a hole that genuinely admits one man,
 * where the alternative is not entering at all.
 */
const APERTURE_MIN_FILES = 2;

// ---------------------------------------------------------------------------
// A broken unit, and the wall in front of it
// ---------------------------------------------------------------------------

/**
 * Metres of the flight line a broken unit needs clear before it will commit to running
 * down it.
 *
 * The flight target has always been `position + threatBearing * 60` with nothing between
 * it and the ground truth — no route, no corridor test, not one call into the pathfinder.
 * On open field that is exactly right and this whole section costs one `empty` test. Inside
 * a city it is a unit running at a wall: measured on Carthage, a cohort broken 35 m inside
 * the circuit spent **40% of its routing ticks with a solid inside three metres of its own
 * heading**, came within half a metre of two successive faces and slid along both, put 121
 * of every thousand man-ticks of the flight with a body in the stone, and never found its
 * way back out through the gate it had come in by. Zero pathfinder requests were made on
 * its behalf in the whole flight, and not one waypoint was ever queued.
 *
 * 22 m is about seven seconds of running. Shorter and a unit commits to a direction it
 * cannot use; longer and it refuses headings that would have served perfectly well for the
 * next few seconds, which on a battlefield full of masonry is most of them.
 */
const ROUT_LOOK = 22;
/** Metres of clear run below which the current flight heading is abandoned. */
const ROUT_MIN_RUN = 7;
/**
 * Half-width the flight corridor is tested at, metres.
 *
 * A file of running men, not a formation — deliberately narrower than `ROUTE_RADIUS`,
 * because a rout is the one movement in the game that genuinely is a stream of individuals
 * and the alternative to a narrow gap is standing still while being cut down.
 */
const ROUT_CORRIDOR = 1.2;
/** Step along a flight ray while testing it, metres. Under a running stride. */
const ROUT_RAY_STEP = 0.9;
/** Seconds a chosen deviation from the threat bearing is held before being re-examined. */
const ROUT_STEER_HOLD = 1.1;
/**
 * Deviations from the threat bearing a broken unit will consider, radians, nearest first.
 *
 * Nearest-first order is what makes the choice deterministic without a tie-break rule: the
 * scan keeps a candidate only on a strictly longer clear run, so among equals the smallest
 * deviation wins by arriving first. Capped at 90 degrees — running past the enemy is not
 * fleeing, and a corner with the enemy behind it is what the breadcrumb trail is for.
 */
const ROUT_FAN = [
  0, 0.3927, -0.3927, 0.7854, -0.7854, 1.1781, -1.1781, 1.5708, -1.5708,
] as const;

/**
 * Offset applied to a unit id when the sim asks the pathfinder for a route.
 *
 * `PathfindingSystem` keys its request queue and its result cache by the id it is handed,
 * and a second request for the same id *cancels the first*. The AI requests routes for the
 * units it commands under their real ids, so if the sim used the same key a player's click
 * would silently cancel the AI's in-flight search — and, worse, `TacticalAI` would then
 * read the sim's narrow-footprint path out of the shared cache and march a cohort in line
 * down a route only a column fits. Offsetting puts the sim's requests in a keyspace of
 * their own; the pathfinder does not care what an id means.
 */
const SIM_ROUTE_ID = 1_000_000;

/**
 * The battle simulation hub.
 *
 * Owns the soldier pool and the unit groups, and runs the per-tick pipeline:
 *   1. rebuild the spatial hash
 *   2. per-unit order resolution (where does this formation want to be?)
 *   3. per-soldier steering toward its formation slot, plus crowd separation
 *   4. melee acquisition and resolution
 *   5. morale, fatigue and rout checks
 *
 * Combat resolution, morale and AI are refined by their own subsystems, which read
 * and write this state through the accessors below rather than owning parallel copies.
 */

const SCRATCH = { x: 0, z: 0 };
/** Second scratch, for the rally lookup that runs inside the slot loop. */
const SCRATCH2 = { x: 0, z: 0 };
/** Scratch for the formation anchor's collision test; see `updateUnitOrder`. */
const ANCHOR_HIT: Resolved = { x: 0, z: 0, hit: false, blockedX: false, blockedZ: false };

const AIM = { x: 0, z: 0 };
const SEG_SELF = makeSegment();
const SEG_OTHER = makeSegment();

/**
 * Front-to-front distance at which two formations are locked together and stop
 * advancing. 1.0 m of centre-to-centre separation with a 0.84 m body diameter is
 * shields touching — the point at which a Rome II line stops and starts grinding.
 */
const CONTACT_ENTER = 1.6;
/** And the distance it must open back up to before either is free to advance again. */
const CONTACT_EXIT = 4.5;
/** Metres the anchors are held apart while locked, so ranks never interpenetrate. */
const CONTACT_GAP = 1.0;
/**
 * Front-to-front distance inside which a formation closes the last stride into contact by
 * itself, even standing under a Hold order. See `closeToContact`.
 *
 * Deliberately *larger* than `CONTACT_EXIT`, which is the opposite of the obvious choice.
 * Setting it below the release distance looks like sensible hysteresis and quietly
 * recreates the very bug this exists to kill: the loser of a shoving match gives ground
 * until the fronts are `CONTACT_EXIT` apart, the lock drops, `resolvePush` stops (it only
 * runs while locked) — and if closing cannot reach that far, both units are left standing
 * 4.5 m apart under long-satisfied orders with nothing to bring them back together. A
 * fight would simply stop, mid-fight, and never restart.
 *
 * Re-attaching is the *correct* behaviour for two units with no orders: it is what
 * "these two are fighting each other" means. A unit that has genuinely been told to leave
 * is held off by `breakingOff` and `orderGrace` instead, which is where that decision
 * belongs.
 */
const ENGAGE_REACH = 5.0;
/**
 * And how fast it takes that stride, in metres per second.
 *
 * Half a walking pace. This is men leaning into a fight that is already at their faces,
 * not an advance — at anything brisk a Hold order stops reading as "hold".
 */
const ENGAGE_CLOSE_SPEED = 0.8;

/**
 * Breadcrumbs kept per unit, and the metres of anchor travel between them.
 *
 * 28 at five metres is 140 m of history. The first cut of this was eight at six — 42 m —
 * which sounded ample and was useless: a cohort marching out of the Porta Flaminia covers
 * 115 m, so by the time it is clear of the wall *every* crumb is already outside, a man
 * stranded on the inside can see none of them through the curtain, and the rally falls
 * back to the behaviour it was written to replace. Measured, that cut changed the stranded
 * count from 49 to 58, which is to say it did nothing. The trail has to be longer than the
 * journey, not longer than the obstacle.
 */
const TRAIL_LEN = 28;
const TRAIL_SPACING = 5;
/**
 * Metres from his formation slot beyond which a man is treated as *separated* and allowed
 * to route back along his unit's trail rather than walk straight at a slot he cannot reach.
 *
 * A formation in good order never approaches this: a 320-man cohort is about 35 m across
 * and 8 deep, and a man closing up into the press is a metre or two out. 14 m means he is
 * not in the block at all. Measured on a gate transit before this existed: 49 of one
 * cohort's 160 men finished more than 30 m from the body, the furthest 71 m away, 94 of
 * them still on the wrong side of the curtain — and sixty further seconds under a halt
 * order moved not one of them, because `steerSoldiers` walks a man in a straight line at
 * his slot and `integrate` slides him along the masonry into a corner and leaves him there.
 */
const STRAGGLER_DIST = 14;
/** Seconds between re-plans of a separated man's rally point. */
const RALLY_REPLAN = 0.6;
/** Most breadcrumbs given a corridor trace on one re-plan. See `rallyPoint`. */
const RALLY_SCAN = 8;
/**
 * Metres a unit may drift from the last position it was *ordered* to hold, closing on
 * enemies of its own accord.
 *
 * A radius about a remembered point, not a decrementing allowance, and the difference
 * matters. The allowance had to be refilled by something, and the only available signal —
 * the enemy stepping back beyond `ENGAGE_REACH` — is one a skirmisher generates on purpose
 * twice a minute, so a Hold cohort could be walked off a gate eight metres at a time,
 * indefinitely. Against a remembered point there is nothing to refill: the unit may stand
 * up to eight metres from where the player put it, and the only thing that moves the point
 * is another order.
 *
 * The honest cost of this design: a unit ordered to withdraw to a spot that happens to be
 * within a stride of an enemy will still turn and fight rather than stand with its back
 * turned. The alternative safeguard would have been `breakingOff`, and it cannot serve —
 * it is only ever assigned inside `u.contactLock && distToTarget > 0.35`, while this runs
 * under `!u.contactLock && distToTarget < 0.35`, so at this call site it is always false.
 */
const ENGAGE_BUDGET = 8;
/**
 * How fast an unengaged man closes up into the press, in metres per second. A rank
 * three men back covers the 3 m to the front line in about three seconds, which is
 * what fills the hole a dead front-ranker leaves.
 */
const PRESS_RATE = 1.1;
/** And how fast the block opens back out into ranks once the fight is over. */
const PRESS_RELAX = 1.6;
/**
 * How deep the press may reach, in **ranks**.
 *
 * Bounded, because unbounded it is not a press but a collapse: every rank walks onto the
 * contact line, the two blocks interleave, and both units fight with every man at once.
 * Two and a half ranks closing up is what fills the hole a dead front-ranker leaves; the
 * ranks behind that stay in formation and wait, which is what a formation is for.
 *
 * In ranks and not metres, because the two are wildly different for cavalry: a horse
 * occupies 2.95 m of depth against an infantryman's 1.02. A flat 2.5 m limit let a
 * wedge's second row close up by less than one horse-length, so once its leading two rows
 * had been killed on a spear wall the remaining fifty riders physically could not reach
 * anything — measured as a dead stop with the fronts half a metre apart, zero men on
 * either side fighting, and the engagement never resolving.
 */
const PRESS_RANKS = 2.5;
/**
 * Seconds an order suppresses the contact lock. Long enough to clear CONTACT_EXIT (4.5 m)
 * at a walk — a disengaging formation needs about three seconds — and short enough that a
 * unit ordered *into* a fight still locks up promptly on arrival.
 */
const ORDER_GRACE = 3.2;

/**
 * Vertical separation, in metres, beyond which two men are treated as not sharing a
 * space at all — no shoving, no melee, no formation contact.
 *
 * The spatial hash is a two-dimensional uniform grid and always has been: it buckets on
 * (x, z) and never reads `y`. That was harmless while every man stood on the terrain and
 * catastrophic the moment one stood on a wall-walk, because a defender 7 m up and an
 * attacker at the foot of the masonry are neighbours in the grid. Measured before this
 * gate existed: garrison and besiegers shoved each other apart through three and a half
 * metres of brick, and the front rank of both fought a melee through the wall.
 *
 * Rebuilding the hash in three dimensions would cost every query on the field to fix a
 * case that affects a few hundred men, so the gate is applied in the visitors instead:
 * one `y` read per candidate, in loops that already read four other arrays.
 *
 * 1.9 m is a little over a man's height — two men on the same walkway differ by
 * centimetres, and a walkway is never within 1.9 m of the ground beneath it.
 */
export const SAME_LEVEL_DY = 1.9;

/** `support[i]` when a man is standing on the terrain rather than on a structure. */
export const NO_SUPPORT = -1e9;

/**
 * Body radius used against solid geometry, metres.
 *
 * The same 0.42 m `resolveCrowding` uses for man-on-man separation, so a man stands off a
 * wall by exactly the distance he stands off his neighbour and a rank pressed against the
 * curtain still dresses. It also sets the effective clear width of the gate: the carriage-
 * way is cut 5.3 m wide, which leaves 4.46 m of centre-line for a column to thread.
 */
const SOLDIER_RADIUS = 0.42;

/**
 * How much room a mounted man needs beside something he cannot walk through, metres.
 *
 * Used by `partCarcasses` and nowhere else, on purpose. `resolveCrowding` carries no
 * per-man radius — one diameter for the whole crowd, with a rider distinguished only by an
 * inverse mass of 5 — and that is the right model for men shoving each other, where the
 * question is who gives way. Against a body lying on the ground the question is instead how
 * wide the thing is, and a cavalryman is a 2.4 m horse drawn around a point that the crowd
 * solver treats as 0.42 m wide.
 *
 * 1.05 m is a little under the horse's own half-length, so a nose or a tail may cross the
 * grass beside a carcass while the barrel never enters it. Larger would have a squadron
 * bulging round a two-metre body from four metres out, which is the failure the capsule
 * shape exists to avoid in the first place.
 */
const MOUNTED_RADIUS = 1.05;

/**
 * Body radius used for the *formation anchor* against solid geometry, metres.
 *
 * Deliberately much smaller than a unit's frontage. The anchor is a point, and the men are
 * collided individually; inflating it to the half-frontage would stop a cohort 11 m short
 * of a building its flank would have cleared. Its only job is to stop the anchor itself
 * being driven inside masonry, which would drag every slot in with it.
 */
const ANCHOR_RADIUS = 0.6;

/**
 * Most metres crowd separation may move one man in one tick. See `resolveCrowding`.
 *
 * Separation is a positional fix-up, not a force, so its magnitude is the sum of a man's
 * overlaps — and where many men are jammed into a small area that sum has no ceiling. On
 * open ground it never mattered, because formations cannot stack that hard. On a 3.45 m
 * wall-walk with a lodgement coming over a boarding ramp into a garrison already standing
 * there, it very much can: measured at 58 cm of purely lateral movement in a single 33 ms
 * tick, which is 17 m/s and reads as a man being flung along the parapet.
 *
 * 0.22 m at 30 Hz is 6.6 m/s — far faster than anyone needs to be pushed, and slow enough
 * that clearing a bad overlap takes a few frames instead of one.
 */
const MAX_SEPARATION_STEP = 0.22;

/**
 * And the same budget for a man who is in melee, metres per tick.
 *
 * 0.08 m at 30 Hz is 2.4 m/s — still far quicker than anything needs to be pushed, and
 * still enough to clear a bad overlap in two or three frames, but a third of what a loose
 * body gets. Together with the mass term in `resolveCrowding` this is what stops the
 * fighting line being steered sideways by the press behind it.
 */
const MAX_SEPARATION_FIGHTING = 0.08;

/**
 * How far from his dressed slot a man in melee may work, metres.
 *
 * A fighting man used to be frozen: `steerSoldiers` damped his velocity to zero the tick he
 * acquired a target and he never chose a footing again. Measured with
 * `tools/probe-hivemind.mjs`, that is why a melee thirty seconds old is still two rectangles
 * with the file-stripes visible from above — the lattice the cohort *marched* in is the
 * lattice it *fights* in, because nothing was ever allowed to disturb it.
 *
 * This is the radius inside which he owns his own feet. It is deliberately smaller than a
 * rank interval (1.02 m for a line): the formation still decides where he stands, and he only
 * decides the last third of a metre of it. Bigger and the line stops reading as a line, which
 * is a different fault and not an improvement; the owner's boundary is that a shape a player
 * ordered has to survive.
 *
 * This is a gameplay change and not only a visual one — a front-ranker who can lean 0.34 m
 * into the seam is inside a reach he was outside of — so `tools/determinism-baseline.json` is
 * re-recorded in the same commit, and `tools/matchup.mjs` is the thing that says what it did
 * to the result.
 */
const MELEE_FOOTING = 0.34;

/**
 * And how fast he may take it, metres per second.
 *
 * A shuffle, not a step: 0.45 m/s crosses `MELEE_FOOTING` in about three quarters of a
 * second, so a man settles onto his opponent over a couple of exchanges rather than
 * snapping onto him. Anything quicker and the whole front rank arrives at the seam on the
 * same tick, which is the coherent motion this is meant to remove.
 */
const MELEE_FOOTING_SPEED = 0.45;

/**
 * How near his place a man on a structure has to get before he stops walking at it.
 *
 * Six centimetres — the value this replaced — is a tenth of a body and is unreachable by
 * anybody standing in a crowd. `resolveCrowding` will not let two men closer than
 * `SOLDIER_RADIUS * 2 = 0.84 m`, so on a wall-walk that is carrying more men than it has
 * places, every man is permanently outside his own arrival radius: `steerToSlots` drives him
 * at a full walk, `resolveCrowding` shoves him back off, and the pair repeat at 30 Hz for the
 * rest of the battle. Measured on a 160-man cohort ordered onto a 12 m run: mean speed pinned
 * at **1.49 m/s** — the unit's whole walk speed — with the mean distance to slot flat at
 * 4.4 m and not falling, four minutes after the last man got off the ladder. Men walking on
 * the spot for ever is what the owner was looking at.
 *
 * A body radius, near enough. A man who is within one of his post *is at his post*; the
 * remaining shove is the crowd, and the crowd is allowed to win. Only `steerToSlots` reads
 * this, so it touches units the siege system places and nothing in the field.
 */
const SLOT_ARRIVED = 0.4;

/**
 * Radians of heading change after which a unit re-solves which man holds which slot.
 *
 * See `src/sim/reform.ts` for what the re-solve is and why it exists. This is how often it
 * happens, and both directions are a real cost.
 *
 * **Too coarse and the men chase.** The lattice rotates between re-solves, so a man's target
 * runs away from him at the block's edge speed and he walks after it. At 0.35 rad — the value
 * this started at — a 180-degree order on a 24 m line still moved the median man 7 m.
 *
 * **Too fine and it is a sort per unit per tick.** The standing wheel is 0.6 rad/s, so 0.02
 * rad is every tick, and re-solving eight thousand men every tick to service the two units
 * that are actually turning is the shape of cost this project has removed twice.
 *
 * 0.05 rad is 2.9 degrees, which is one re-solve every 2.5 ticks of a standing wheel and
 * never more than one file of lateral drift at the flank of the widest formation in the
 * game. The cost is bounded by the number of units *turning*, which is normally zero.
 */
const REFORM_ANGLE = 0.05;

/**
 * How fast a man who is standing still turns to face the way his unit does, radians a second,
 * before his own variation.
 *
 * ## The bug this exists for
 *
 * `integrate` wrote `p.facing[i]` in exactly one place, guarded by `speed > 0.22`: **a man
 * who was not walking never changed the way he was pointing.** So the only way a body of men
 * could come to face a new direction was for every one of them to walk somewhere, and where
 * they ended up pointing was whatever bearing they happened to arrive on.
 *
 * Measured before this existed (`tools/probe-aboutface.mjs`): a legionary cohort ordered to
 * about-face had its *unit* heading exactly right — 0.0 degrees off the order — and its
 * *men* a median of **75.6 degrees off it**, thirty seconds later, having walked 20 m each to
 * get there. Sixty cavalry: 108.3 degrees. That is the second half of "they would not turn
 * around to face", and no amount of work on where a man walks could have fixed it, because
 * the man was never asked to turn.
 *
 * ## Why it is per man
 *
 * A thousand men turning at one rate to one bearing on one tick is precisely the coherent
 * motion the dressing work in `FormationDef.dress` was done to remove — "they all sway left
 * and right magically along some sort of function". So the rate is scaled per man from his
 * own stable hash, and the bearing he settles on carries a dressing error scaled by his
 * formation's own `dress`, which keeps a testudo crisp (+-0.9 degrees) and lets a battle
 * line look dressed by eye (+-4.3 degrees) without a second constant to keep in step.
 *
 * 2.6 rad/s with +-35% is an about-face in a little over a second at the median, which is
 * about right for a man who is standing still and has been told to turn round, and slow
 * enough that the turn is legible rather than a pop.
 */
const STAND_TURN_RATE = 2.6;
/** Peak-to-peak fraction of `STAND_TURN_RATE` taken from the man's own hash. */
const STAND_TURN_SPREAD = 0.7;
/**
 * Radians of remaining turn below which a standing unit is *not* treated as turning.
 *
 * One degree. `turningInPlace` freezes a unit's men where they stand, so the one thing it
 * must never do is latch: a unit sitting on its ordered bearing with a bearing that moves by
 * rounding would otherwise never dress onto its slots again. Everything a player or the AI
 * would call a turn is orders of magnitude above this — the AI's own facing deadband is
 * 0.26 rad — and everything below it is arithmetic.
 */
const TURN_HOLD_MIN = 0.0175;

/**
 * The footprint of a fallen war elephant, as a capsule on the ground.
 *
 * A live animal is about 4.2 m nose to tail and 2.0 m across the body. Lying on its side
 * it keeps the length and gains width, because what is now across the ground is belly to
 * spine. So: a segment `CARCASS_HALF_LEN` either side of the animal's centre along the
 * heading it died facing, inflated by `CARCASS_RADIUS` — 4.7 m by 2.6 m, scaled per animal
 * by the same size hash the renderer draws it at.
 *
 * A capsule and not a circle because the difference is the whole point. A circle big enough
 * to contain the body is 2.4 m across the *short* axis too, which makes a cohort walking
 * past a carcass bulge round something a metre wider than the thing they can see.
 */
const CARCASS_HALF_LEN = 1.05;
const CARCASS_RADIUS = 1.30;

/**
 * Carcasses tracked at once. Two elephant units at `ultra` is 32 animals; this is headroom,
 * and the cap exists only so a pathological battle cannot grow the per-tick pass without
 * bound. Overflow simply gets no body — worse than a body, better than an unbounded loop.
 */
const CARCASS_MAX = 64;

/**
 * What a soldier standing on something other than the ground needs the sim to know.
 *
 * Implemented by `Siege`, which owns every structure a man can stand on. Kept as an
 * interface so `BattleSystem` does not depend on the siege module's internals, and so a
 * battle with no siege in it allocates nothing and branches once.
 */
export interface ElevationOwner {
  /** Runs before steering: refresh support heights and slot targets. */
  preSteer(dt: number): void;
  /** Runs after integration: hold men on their surface and off the edges. */
  postIntegrate(dt: number): void;
  /** True while this unit's men are placed by the siege system rather than by a formation. */
  ownsUnit(unitId: number): boolean;
  /**
   * True while *this man* is standing on a structure or walking a path onto one.
   *
   * Per soldier, and deliberately not derivable from `ownsUnit`. A boarding party is one
   * unit spread over three places — the parapet, the rungs and the grass — and every fault
   * this area has produced came from answering a per-man question with the unit's flag.
   */
  manOnStructure(index: number): boolean;
}

export class BattleSystem implements Subsystem {
  readonly name = 'battle';
  readonly order = 10;

  pool!: SoldierPool;
  units: UnitGroupState[] = [];
  hash!: SpatialHash;
  rng = new Rng('battle-271');

  // -------------------------------------------------------------------------
  // Elevation — men who are not standing on the terrain
  // -------------------------------------------------------------------------

  /**
   * 1 while this man stands on a structure. Zero for the overwhelming majority, which is
   * why this is a byte array tested in the hot loop rather than a callback.
   */
  elevated!: Uint8Array;
  /** Absolute Y of the surface under his feet while `elevated`; `NO_SUPPORT` otherwise. */
  support!: Float32Array;
  /** World-space position he is steering toward while `elevated`. */
  slotX!: Float32Array;
  slotZ!: Float32Array;
  /** Yaw he should hold while `elevated` — outward over the parapet, not at his slot. */
  slotFacing!: Float32Array;
  /** Set by whoever owns the structures. Null in a battle with no siege. */
  elevation: ElevationOwner | null = null;
  /**
   * Siege warfare: wall garrisons, towers, ladders, rams and artillery.
   *
   * Owned here rather than registered as its own subsystem because it has to run at two
   * precise points *inside* the soldier tick — see the header of `Siege.ts`. Constructing
   * it here also keeps `main.ts`, which this workstream does not own, unchanged.
   */
  readonly siege = new Siege();
  /** Representative surface height per unit, for the formation-contact test. */
  private unitY = new Float32Array(64);

  /**
   * Solid world geometry. Empty on any map without a city, which is why every use of it
   * is guarded by `empty` rather than by a null check on the city subsystem.
   */
  readonly masonry = new ObstacleField();
  /** `obstacleGeneration` the field was last indexed against. */
  private masonryGen = -1;
  private obstacleSource: ObstacleSource | null = null;
  private readonly hitScratch: Resolved = { x: 0, z: 0, hit: false, blockedX: false, blockedZ: false };
  private nav: NavProvider | null = null;
  /** Player move orders whose route has been asked for and not yet arrived. */
  private readonly pendingRoutes = new Map<number, PendingRoute>();
  /**
   * The destination a move order actually named, kept alive after its route is installed.
   *
   * `pendingRoutes` is the in-flight request and is deleted the moment a route lands, so it
   * cannot answer "did this unit get where it was sent". This can.
   */
  private readonly routeGoals = new Map<number, {
    gx: number; gz: number; facing: number; tries: number;
    /** Earliest tick another attempt may be spent. See `RESUME_COOLDOWN`. */
    nextTick: number;
  }>();
  /**
   * Fixed steps since the system started. Owned here rather than read off `ctx.time` so
   * every rate limit in this file counts the same thing whatever drives the clock, and so
   * nothing in `fixedUpdate` depends on wall time.
   */
  private tickCount = 0;

  private terrain?: TerrainSystem;
  private ctx!: EngineContext;
  private nextUnitId = 0;
  /** Per-faction living soldier tally, refreshed each tick. */
  /*
   * Typed `Record<Faction, number>` rather than `Record<number, number>` on purpose: the
   * loose form let `{ 0: 0, 1: 0 }` compile while a third faction existed, so `strength[2]`
   * was `undefined` and every `+=` against it produced NaN from the first tick. The HUD
   * reads this and the sim does not, so the symptom was cosmetic — which is exactly why it
   * needs to be a compile error rather than a number nobody checks.
   */
  readonly strength: Record<Faction, number> = Object.fromEntries(
    ALL_FACTIONS.map((f) => [f, 0])
  ) as Record<Faction, number>;

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.terrain = ctx.tryGet<TerrainSystem>('terrain');
    /*
     * `SOLDIER_POOL_CAPACITY`, not `ctx.quality.maxSoldiers`, and that is the whole of the
     * quality/simulation split. The pool used to be sized by the graphics tier, which fitted
     * `unitSizeScale` to it and made the army — and therefore the battle — a function of a
     * shadow-quality dropdown. Nothing on the settings path reaches the simulation now; see the
     * constant's own comment in `./types` for the measurement that forced this.
     */
    const cap = SOLDIER_POOL_CAPACITY;
    this.pool = new SoldierPool(cap);
    this.mounted = new Uint8Array(cap);
    this.onElephant = new Uint8Array(cap);
    this.orderGrace = new Float32Array(256);
    this.breakingOff = new Uint8Array(256);
    this.press = new Float32Array(cap);
    this.standFacing = new Float32Array(cap);
    this.sepUsed = new Float32Array(cap);
    // 0.42 is `resolveCrowding`'s own default body radius, written here so the array is
    // valid before the first tick even if nothing is in a packed formation.
    this.packR = new Float32Array(cap).fill(0.42);
    this.roughDrag = new Float32Array(cap).fill(1);
    this.rallyX = new Float32Array(cap);
    this.rallyZ = new Float32Array(cap);
    this.rallyOn = new Uint8Array(cap);
    this.rallyUntil = new Float32Array(cap);
    // 2.0 m cells. The separation pass asks for everything within 0.84 m once per man per
    // tick, and at 3.5 m cells that scanned about 37 candidates to find 6. The rebuild can
    // afford the finer grid because it only ever touches the rectangle the armies stand on.
    this.hash = new SpatialHash(1500, 2.0);

    this.elevated = new Uint8Array(cap);
    this.support = new Float32Array(cap).fill(NO_SUPPORT);
    this.slotX = new Float32Array(cap);
    this.slotZ = new Float32Array(cap);
    this.slotFacing = new Float32Array(cap);

    this.siege.init(ctx, this);
    this.bindObstacles(ctx);

    ctx.events.on('orderIssued', (o) => this.applyOrder(o));
  }

  /**
   * Take the city's solids, if there are any.
   *
   * Probed and wrapped for the same reason `Pathfinding` probes it: the city agent owns
   * that API, `main.ts` does not register `CitySystem` on maps whose `hidesCity` is set,
   * and a battle on the plain of Pydna must not fail because Rome is absent.
   */
  private bindObstacles(ctx: EngineContext): void {
    const nav = ctx.tryGet('pathfinding') as unknown as NavProvider | undefined;
    if (nav && typeof nav.requestPath === 'function' && typeof nav.pathFor === 'function') {
      this.nav = nav;
    }
    const src = ctx.tryGet('city') as unknown as ObstacleSource | undefined;
    if (!src || typeof src.getObstacles !== 'function') return;
    this.obstacleSource = src;
    this.refreshObstacles();
  }

  /**
   * Ask the pathfinder for a route to a player-ordered destination.
   *
   * The straight line stands in the meantime — the unit sets off immediately, as a player
   * expects, and the route replaces it a few ticks later when the search lands. That is
   * the same bargain `TacticalAI.moveTo` strikes, and it matters more here: a click that
   * produced no movement for half a second would read as the order being ignored.
   */
  private requestRoute(u: UnitGroupState, gx: number, gz: number, facing: number): void {
    const nav = this.nav;
    if (!nav) return;
    this.pendingRoutes.delete(u.id);
    // The overwhelmingly common case, and the one an AI path leg always falls into: the
    // leg came out of the string-puller, so its corridor is already known clear.
    if (nav.directRouteClear(u.x, u.z, gx, gz, ROUTE_RADIUS)) return;

    // The straight line is not walkable, so the destination `applyOrder` just wrote is an
    // order to walk into masonry. Hold the anchor short of it until a route arrives.
    this.holdShortOfSolid(u, gx, gz);

    /**
     * Pull the destination onto ground a body can actually stand on before searching.
     *
     * A click lands where the mouse pointed, and inside a city that is very often the roof
     * of an insula. A\* cannot reach a blocked goal cell, so it expands until the budget
     * runs out and returns a partial route flagged `ok: false` — which is what made the
     * first version of this silently do nothing at all: a unit ordered 140 m inside the
     * wall walked to the curtain, stopped, and no route was ever installed.
     */
    if (nav.findStandable(gx, gz, ROUTE_RADIUS, ROUTE_GOAL)) {
      gx = ROUTE_GOAL.x;
      gz = ROUTE_GOAL.z;
    }
    const key = u.id + SIM_ROUTE_ID;
    // Drop any result from a previous order for this unit. `collectRoutes` accepts a path
    // whose goal is within 8 m of what it asked for, and a stale one can satisfy that test
    // before this request has even been searched.
    nav.clearPath(key);
    if (!nav.pending(key)) {
      nav.requestPath(key, u.x, u.z, gx, gz, ROUTE_RADIUS, ROUTE_RADIUS, 3);
    }
    this.pendingRoutes.set(u.id, { gx, gz, facing, ttl: ROUTE_TTL, retries: ROUTE_RETRIES });
  }

  /**
   * Aim the anchor at the last point on the straight line it can legally reach.
   *
   * The invariant this exists to keep is simple and testable: **no order the sim holds
   * ever points through masonry.** A unit whose route has not arrived yet still walks —
   * as far as the ground allows — and then waits, rather than pressing its front rank into
   * the curtain. Backing off by `ROUTE_RADIUS` leaves the formation clear of the face
   * instead of exactly on it, so the collider is not fighting the order every tick.
   */
  private holdShortOfSolid(u: UnitGroupState, gx: number, gz: number): void {
    const nav = this.nav;
    if (!nav) return;
    const dx = gx - u.x;
    const dz = gz - u.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-3) return;
    const f = nav.clearLineFraction(u.x, u.z, gx, gz, ROUTE_RADIUS);
    const reach = Math.max(0, len * f - ROUTE_RADIUS);
    u.targetX = u.x + (dx / len) * reach;
    u.targetZ = u.z + (dz / len) * reach;
  }

  /**
   * Install any route that has arrived, as the sim's own waypoint queue.
   *
   * `pts[0]` is the unit's position at the moment of the request, so the first leg is
   * `pts[1]`; intermediate legs face along the direction of travel and only the last
   * carries the ordered facing. This mirrors `OrderBook.followPath`, which does the same
   * job for the AI through the event bus.
   */
  private collectRoutes(): void {
    const nav = this.nav;
    if (!nav || this.pendingRoutes.size === 0) return;
    for (const [id, req] of this.pendingRoutes) {
      const u = this.unitById(id);
      if (!u || u.destroyed) {
        this.pendingRoutes.delete(id);
        this.routeGoals.delete(id);
        continue;
      }
      // The unit changed its mind: a halt or a new order supersedes the route. An attack
      // is not a change of mind — it wants a route too, and used to get none at all.
      if (u.order !== UnitOrder.MoveTo && u.order !== UnitOrder.AttackMove
        && u.order !== UnitOrder.AttackUnit) {
        this.pendingRoutes.delete(id);
        continue;
      }
      // Somebody else — the AI — has already given this unit a multi-leg route. Its plan
      // wins; the sim only routes orders nothing else has routed.
      if (u.waypoints.length > 0) {
        this.pendingRoutes.delete(id);
        continue;
      }
      const key = id + SIM_ROUTE_ID;
      const p = nav.pathFor(key);
      // A partial route is accepted. `ok` is false whenever the search did not reach the
      // exact goal cell, but `store` still writes the best route it found, and walking as
      // far toward the objective as the ground allows is what a player expects from a
      // click — certainly more than standing still because the last ten metres are a wall.
      const fresh = p && p.n >= 2 && Math.sqrt((p.goalX - req.gx) * (p.goalX - req.gx) + (p.goalZ - req.gz) * (p.goalZ - req.gz)) < 8;
      if (!fresh) {
        /*
         * Nothing is in flight and nothing usable came back, so the pathfinder has given
         * up on this one — its request TTL expired, or its search was capped, or the goal
         * was unreachable and the single-point failure marker is all there is. Ask again.
         *
         * This is the difference between "the click is being worked on" and "the click was
         * silently binned", and the sim cannot tell them apart from the outside. Without
         * the retry, six of eight units ordered across the wall kept their original
         * straight line for the rest of the battle.
         */
        if (--req.ttl <= 0) {
          if (req.retries > 0 && !nav.pending(key)) {
            req.retries--;
            req.ttl = ROUTE_TTL;
            nav.clearPath(key);
            nav.requestPath(key, u.x, u.z, req.gx, req.gz, ROUTE_RADIUS, ROUTE_RADIUS, 3);
          } else {
            this.pendingRoutes.delete(id);
          }
        }
        continue;
      }
      u.targetX = p.pts[2];
      u.targetZ = p.pts[3];
      u.targetFacing = p.n === 2 ? req.facing : Math.atan2(p.pts[2] - p.pts[0], p.pts[3] - p.pts[1]);
      for (let i = 2; i < p.n; i++) {
        const f = i === p.n - 1
          ? req.facing
          : Math.atan2(p.pts[i * 2] - p.pts[(i - 1) * 2], p.pts[i * 2 + 1] - p.pts[(i - 1) * 2 + 1]);
        u.waypoints.push(p.pts[i * 2], p.pts[i * 2 + 1], f);
      }
      this.pendingRoutes.delete(id);
    }
  }

  /**
   * Keep a siege-owned unit's anchor with its men.
   *
   * `Siege` teleports a garrison onto the wall-walk and carries a boarding party up a
   * tower, but it never touches `u.x/u.z` — so the anchor stays wherever the unit spawned.
   * For a tower party that is 74 to 101 m out in the field, and *everything* keyed off the
   * anchor was wrong by that much: `UnitOrder.AttackUnit` aims at `t.x, t.z`, so ordering a
   * unit to attack a tower party sent it to an empty patch of grass — measured at 90.8 m
   * from the tower. The selection box, the order arrow and the click footprint were all
   * out by the same amount, while the banner tracked the men correctly, which is why the
   * click sometimes appeared to work and the movement never did.
   */
  private trackOwnedAnchors(): void {
    const owner = this.elevation;
    if (!owner) return;
    const p = this.pool;
    for (const u of this.units) {
      if (u.destroyed || !owner.ownsUnit(u.id)) continue;
      let sx = 0;
      let sz = 0;
      let n = 0;
      for (const i of u.members) {
        if (!isAlive(p.state[i] as SoldierState)) continue;
        sx += p.x[i];
        sz += p.z[i];
        n++;
      }
      if (n === 0) continue;
      u.x = sx / n;
      u.z = sz / n;
      u.targetX = u.x;
      u.targetZ = u.z;
    }
  }

  /** Re-index the solids if the city says they have changed. Cheap when they have not. */
  private refreshObstacles(): void {
    const src = this.obstacleSource;
    if (!src) return;
    const gen = src.obstacleGeneration ?? 1;
    if (gen === this.masonryGen) return;
    try {
      this.masonry.set(src.getObstacles());
      /*
       * The nav raster charges for standing work unconditionally, because charging nothing
       * to cross a concrete pour was a defect. Whether a *body* is slowed by it is a
       * balance question with a measured answer the owner has not chosen yet — see
       * `ROUGH_SLOWS_MOVEMENT`. Off, the field stays empty and the whole path costs one
       * boolean a tick.
       */
      this.masonry.setRough(ROUGH_SLOWS_MOVEMENT ? (src.getRoughGround?.() ?? []) : []);
      this.masonryGen = gen;
    } catch (err) {
      // A foreign API that throws must not take the simulation down with it.
      console.warn('[sim/battle] city obstacle query failed, running without collision:', err);
      this.obstacleSource = null;
    }
  }

  // -------------------------------------------------------------------------
  // Army construction
  // -------------------------------------------------------------------------

  /**
   * Global multiplier on every unit's roster strength — the equivalent of Total War's
   * unit-size setting. The roster's numbers are authored at a readable baseline; a
   * scenario raises this to fill the field. Set before spawning; changing it afterwards
   * has no effect on units already deployed.
   */
  unitSizeScale = 1;

  /**
   * Spawn a unit group with its front rank centred on (x, z), facing `facing`.
   * Returns the new unit's id, or -1 if the soldier pool is full.
   */
  spawnUnit(typeId: string, x: number, z: number, facing: number, formationId?: string): number {
    const def = unitType(typeId);
    const fdef = formation(formationId ?? def.formations[0]);
    // Artillery crews are a fixed establishment — a scorpion needs two men whatever the
    // unit-size setting — so they do not scale.
    const scale = def.unitClass === 'artillery' ? 1 : this.unitSizeScale;
    const strength = Math.max(1, Math.round(def.strength * scale));
    const width = fdef.width(strength);

    const u: UnitGroupState = {
      id: this.nextUnitId++,
      typeId,
      faction: def.faction,
      members: [],
      alive: 0,
      initialStrength: strength,
      x, z, facing,
      targetX: x, targetZ: z, targetFacing: facing,
      order: UnitOrder.Hold,
      targetUnitId: -1,
      waypoints: [],
      running: false,
      formationId: fdef.id,
      width,
      spacingX: this.baseSpacingX(def) * fdef.spacingXMul,
      spacingZ: this.baseSpacingZ(def) * fdef.spacingZMul,
      morale: def.morale,
      maxMorale: def.morale,
      fatigue: 0,
      ammo: def.missile?.ammo ?? 0,
      engaged: false,
      chargeTimer: 0,
      contactLock: false,
      charging: false,
      routTimer: 0,
      kills: 0,
      destroyed: false,
      selected: false,
      concealed: false,
    };

    /*
     * The float32 firewall, on the way in. `src/sim/quantise.ts` keeps this layer quantised at
     * the end of every tick; a unit has to enter it already quantised or the t+0 hash — the one
     * a lobby handshake and the replay record's refusal both key on — carries whatever
     * `Math.atan2` returned in this browser. Measured at 26 differing float64 fields on the
     * Carthage assault before this line existed.
     */
    quantiseUnit(u);

    const ranks = ranksFor(strength, width);
    const rng = this.rng.fork(`unit${u.id}`);
    const mounted = isCavalry(def);
    const elephant = ridesElephant(def);
    // Where it was deployed counts as where it was told to stand, so a unit that is never
    // given an order still has a point to measure its self-initiated drift against.
    this.growUnitScratch(u.id + 1);
    this.holdX[u.id] = u.x;
    this.holdZ[u.id] = u.z;
    this.holdSet[u.id] = 1;

    for (let s = 0; s < strength; s++) {
      const i = this.pool.alloc();
      if (i < 0) break;
      u.members.push(i);

      fdef.offset(SCRATCH, s, width, ranks, u.spacingX, u.spacingZ);
      const [wx, wz] = this.localToWorld(u, SCRATCH.x, SCRATCH.z);

      const p = this.pool;
      p.x[i] = wx;
      p.z[i] = wz;
      p.y[i] = this.groundAt(wx, wz);
      p.px[i] = wx; p.pz[i] = wz; p.py[i] = p.y[i];
      p.vx[i] = 0; p.vz[i] = 0; p.vy[i] = 0;
      p.facing[i] = facing;
      p.prevFacing[i] = facing;
      p.lean[i] = 0;

      p.unitId[i] = u.id;
      p.faction[i] = def.faction;
      p.slot[i] = s;
      p.rank[i] = Math.min(255, Math.floor(s / width));
      p.file[i] = Math.min(255, s % width);

      // One hit point per man; damage accumulates until a blow finishes him.
      p.maxHp[i] = 100;
      p.hp[i] = 100;
      p.state[i] = SoldierState.Idle;
      p.stateTime[i] = rng.range(0, 3);
      p.target[i] = -1;
      p.attackCooldown[i] = rng.range(0, 1 / def.attackRate);
      p.fatigue[i] = 0;
      p.ammo[i] = def.missile?.ammo ?? 0;

      p.animClip[i] = Clip.IdleAlert;
      p.animTime[i] = rng.next();
      p.animPrevClip[i] = Clip.IdleAlert;
      p.animPrevTime[i] = 0;
      p.animBlend[i] = 1;
      // +/-8% rate so a hundred idle men never breathe in unison.
      p.animRate[i] = rng.range(0.92, 1.08);

      p.scale[i] = def.appearance.heightScale * rng.range(0.965, 1.035);
      p.variant[i] = rng.next();
      p.grime[i] = rng.range(0, 0.12);
      p.deathVariant[i] = rng.int(0, 3);
      p.deathDirX[i] = 0;
      p.deathDirZ[i] = 0;
      this.mounted[i] = mounted ? 1 : 0;
      this.onElephant[i] = elephant ? 1 : 0;
    }

    u.alive = u.members.length;
    u.initialStrength = u.members.length;
    this.units.push(u);
    return u.id;
  }

  /**
   * Slide every unit already deployed, and every man in it, `dx` metres along x.
   *
   * A deployment is laid out about x 0 — `centred`, `flanking` — because every block in it is
   * symmetric about the line of advance, and that is the shape it reads best in. Where that
   * line *is* on a given map is the map's business, not the order of battle's, so the two are
   * separated: `sim/scenario.ts` builds the deployment about zero and then puts it on the
   * ground the map prepared. See `standOnDeploymentGround` there for the rule.
   *
   * It lives here rather than in the scenario because moving a unit is not just moving its
   * anchor. A man's `y` is sampled off the heightfield at spawn and has to be re-sampled at
   * his new x, the interpolation history has to move with him or the first frame draws every
   * soldier sliding, and `holdX` — where a unit was told to stand, which its self-initiated
   * drift is measured against — has to move too. Three of those are private to this class.
   *
   * **Deployment only.** It rewrites positions without consulting crowding, obstacles or
   * masonry, which is safe before the first tick and is not safe afterwards. Nothing calls it
   * mid-battle and nothing should.
   */
  translateDeployment(dx: number): void {
    if (dx === 0) return;
    const p = this.pool;
    for (const u of this.units) {
      u.x += dx;
      u.targetX += dx;
      // Flat [x, z, facing] triples. Empty at deployment; moved anyway, so this stays correct
      // if a scenario ever queues a march before handing the battle over.
      for (let k = 0; k < u.waypoints.length; k += 3) u.waypoints[k] += dx;
      this.growUnitScratch(u.id + 1);
      if (this.holdSet[u.id]) this.holdX[u.id] += dx;
      for (const i of u.members) {
        const x = p.x[i] + dx;
        p.x[i] = x;
        p.px[i] = x;
        p.y[i] = this.groundAt(x, p.z[i]);
        p.py[i] = p.y[i];
      }
    }
  }

  private baseSpacingX(def: UnitTypeDef): number {
    return isCavalry(def) ? BASE_SPACING_X.mounted : BASE_SPACING_X.foot;
  }
  private baseSpacingZ(def: UnitTypeDef): number {
    return isCavalry(def) ? BASE_SPACING_Z.mounted : BASE_SPACING_Z.foot;
  }

  /** Transform a formation-local offset into world space. */
  private localToWorld(u: UnitGroupState, lx: number, lz: number): [number, number] {
    const s = Math.sin(u.facing);
    const c = Math.cos(u.facing);
    return [u.x + lx * c + lz * s, u.z - lx * s + lz * c];
  }

  groundAt(x: number, z: number): number {
    return this.terrain?.heightAt(x, z) ?? 0;
  }

  unitById(id: number): UnitGroupState | undefined {
    return this.units.find((u) => u.id === id);
  }

  typeOf(u: UnitGroupState): UnitTypeDef {
    return unitType(u.typeId);
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  private applyOrder(o: {
    unitIds: number[];
    kind: string;
    x?: number; z?: number; facing?: number;
    targetUnitId?: number; formation?: string;
    width?: number;
    queued?: boolean; running?: boolean;
  }): void {
    for (const id of o.unitIds) {
      const u = this.unitById(id);
      if (!u || u.destroyed) continue;

      // Any order that changes the unit's destination breaks contact. Without this the
      // geometric lock re-asserts on the next tick and the order is silently discarded.
      if (o.kind === 'move' || o.kind === 'attackMove' || o.kind === 'attack' || o.kind === 'halt') {
        this.growUnitScratch(u.id + 1);
        u.contactLock = false;
        u.charging = false;
        this.orderGrace[u.id] = ORDER_GRACE;
        // An order re-plants the point this unit is allowed to wander from. For a move that
        // is the destination it has been sent to, not where it is standing now.
        this.holdX[u.id] = o.x ?? u.x;
        this.holdZ[u.id] = o.z ?? u.z;
        this.holdSet[u.id] = 1;
      }

      switch (o.kind) {
        case 'move':
        case 'attackMove': {
          if (o.x === undefined || o.z === undefined) break;
          if (o.queued) {
            u.waypoints.push(o.x, o.z, o.facing ?? u.targetFacing);
          } else {
            u.waypoints.length = 0;
            u.targetX = o.x;
            u.targetZ = o.z;
            const face = o.facing ?? Math.atan2(o.x - u.x, o.z - u.z);
            u.targetFacing = face;
            // A destination the unit cannot walk to in a straight line needs a route.
            // `requestRoute` short-circuits when the straight line is already clear, which
            // is what every leg of an AI route is by construction, so this costs the AI
            // one corridor test and never displaces its plan.
            this.requestRoute(u, o.x, o.z, face);
            this.routeGoals.set(u.id, {
              gx: o.x, gz: o.z, facing: face, tries: ROUTE_RESUMES, nextTick: this.tickCount,
            });
          }
          u.order = o.kind === 'attackMove' ? UnitOrder.AttackMove : UnitOrder.MoveTo;
          u.running = !!o.running;
          u.targetUnitId = -1;
          // A right-click-drag sets frontage as well as destination. Reading it here means
          // the UI no longer has to reach in and write `u.width` itself.
          if (o.width !== undefined && o.width > 0) {
            // The drag outranks anything an aperture squeezed this unit down to, and it
            // replaces what a later release would have spread it back out to. Dropping the
            // remembered width rather than overwriting it: the player has just said what
            // the frontage is, and the next corridor measurement will squeeze *that*.
            this.growUnitScratch(u.id + 1);
            this.fileRestore[u.id] = -1;
            u.width = Math.max(1, Math.round(o.width));
          }
          break;
        }
        case 'attack': {
          if (o.targetUnitId === undefined) break;
          u.order = UnitOrder.AttackUnit;
          u.targetUnitId = o.targetUnitId;
          u.running = true;
          u.waypoints.length = 0;
          this.pendingRoutes.delete(u.id);
          this.routeGoals.delete(u.id);
          // Let `steerAttack` route it on the very next tick rather than after the usual
          // interval. An attack order used to bypass the pathfinder entirely: measured, a
          // cohort told to attack an enemy 177 m away on the far side of the wall was given
          // a single straight leg with 8 m of it inside the curtain, and spent 970 of the
          // next 1,800 ticks with its anchor in masonry without ever crossing.
          this.growUnitScratch(u.id + 1);
          this.attackRouteAt[u.id] = -1e9;
          break;
        }
        case 'garrison': {
          // The order the enum has carried since the beginning with nothing behind it.
          // `Siege` decides whether there is a wall at that point and lays the unit out
          // along it; if there is not, the order degrades to a move, which is the least
          // surprising thing for a misclick to do.
          if (o.x === undefined || o.z === undefined) break;
          if (!this.siege.garrison(u, o.x, o.z)) {
            u.order = UnitOrder.MoveTo;
            u.targetX = o.x;
            u.targetZ = o.z;
          }
          break;
        }
        case 'halt': {
          u.order = UnitOrder.Hold;
          u.targetX = u.x;
          u.targetZ = u.z;
          u.targetUnitId = -1;
          u.waypoints.length = 0;
          this.pendingRoutes.delete(u.id);
          this.routeGoals.delete(u.id);
          break;
        }
        case 'gait': {
          /*
           * Change pace without changing anything else.
           *
           * The run toggle used to be a latch on the *next* order: pressing R set a flag in
           * the selection controller that was read the next time the player right-clicked.
           * So R pressed while a cohort was already marching did nothing whatsoever — no
           * order was issued, `u.running` was never written, and the unit carried on at
           * `walkSpeed`. Measured, walking and running legs of an already-moving unit came
           * out at the same speed to three decimal places, which is exactly the report:
           * "when I hit R they seem to move at the same pace".
           *
           * This is deliberately *not* one of the kinds that clears `contactLock` and buys
           * `ORDER_GRACE` above: changing pace is not a change of mind about where to go,
           * and letting it break a unit out of a melee would make R an escape button.
           */
          if (o.running !== undefined) u.running = !!o.running;
          break;
        }
        case 'facing': {
          if (o.facing !== undefined) u.targetFacing = o.facing;
          break;
        }
        case 'formation': {
          if (o.formation) this.setFormation(u, o.formation);
          break;
        }
        case 'ability':
          // Deliberately a no-op here: AbilitySystem subscribes to `orderIssued`
          // directly and owns cooldowns, durations and stat modifiers. Listed so the
          // contract is explicit rather than looking like an unhandled case.
          break;
      }
    }
  }

  setFormation(u: UnitGroupState, id: string): void {
    const def = this.typeOf(u);
    if (!def.formations.includes(id)) return;
    const f = formation(id);
    u.formationId = id;
    // A new formation is a new frontage, so whatever an aperture had this unit squeezed
    // down from is stale. Leaving it would spread a testudo back out to the line's files
    // the next time the corridor opened, at the testudo's much tighter spacing.
    this.growUnitScratch(u.id + 1);
    this.fileRestore[u.id] = -1;
    u.width = f.width(u.alive || u.initialStrength);
    u.spacingX = this.baseSpacingX(def) * f.spacingXMul;
    u.spacingZ = this.baseSpacingZ(def) * f.spacingZMul;
    // A new lattice on the same ground: who holds which place in it has to be decided
    // again, or a cohort ordered into testudo walks the shape rather than closing into it.
    // The formation id is a string and does not belong in `maybeReform`'s numeric mark, so
    // the mark is cleared here instead and the next tick solves.
    this.reformShape[u.id] = NaN;
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  fixedUpdate(dt: number, ctx: EngineContext): void {
    const p = this.pool;
    this.tickCount++;
    p.savePrevious();
    this.hash.rebuild(p);
    // A gate opening or a wall coming down changes what is solid. One integer compare when
    // nothing has moved, which is every tick but a handful.
    this.refreshObstacles();

    for (const f of ALL_FACTIONS) this.strength[f] = 0;

    // Structures resolve first: a man's support height and his slot on a wall-walk have
    // to be current before anything steers him or asks how far away an enemy is.
    this.elevation?.preSteer(dt);
    // Then any route the pathfinder finished for a player order last tick.
    this.collectRoutes();

    for (const u of this.units) {
      if (u.destroyed) continue;
      // Before the order is resolved, not after: `frontHalf` — and so the contact test at
      // the top of `updateUnitOrder` — is computed from `u.width`, and a block that is
      // filing into a gate has a two-man front while it does so.
      this.fitToAperture(u);
      this.updateUnitOrder(u, dt);
      this.layTrail(u);
      this.updateUnitCohesion(u);
      this.strength[u.faction] += u.alive;
    }

    // Before anything writes a position: what is under each man's feet, as a multiplier.
    this.refreshRoughDrag();
    this.steerSoldiers(dt);
    this.resolveCrowding(dt);
    this.integrate(dt);
    // Crowd separation and integration both move men in the XZ plane with no idea that
    // some of them are on a ledge 3.45 m wide. This puts them back on it.
    this.elevation?.postIntegrate(dt);
    // The men are final for this tick, so a siege-owned unit's anchor can be put where
    // they actually are. Must be after `postIntegrate`, which is what moves them.
    this.trackOwnedAnchors();
    this.updateAnimationState(dt, ctx);
  }

  /**
   * Front-to-front distance to the nearest enemy formation, metres, refreshed every
   * tick. Kept here rather than on `UnitGroupState` so the shape of the shared unit
   * record — which several subsystems construct in tests — does not grow.
   */
  private frontGaps = new Float32Array(64).fill(Infinity);
  private frontEnemies = new Int32Array(64).fill(-1);
  /**
   * The heading, and the shape, this unit's slot assignment was last solved against.
   *
   * Two marks rather than one because a formation re-solves for two different reasons and
   * they have nothing to do with each other: the block turned (`reformFacing`), or the block
   * changed shape under it (`reformShape` — width, formation and the size of the slot
   * lattice). `NaN` means "never solved", which is the state every unit is born in and which
   * forces exactly one no-op solve on its first tick.
   */
  private reformFacing = new Float32Array(64).fill(NaN);
  private reformShape = new Float64Array(64).fill(NaN);
  /**
   * 1 while this unit is turning on the spot, and its men should hold their ground.
   *
   * **Face first, then re-form**, which is the owner's spec in four words. A body of men
   * told to turn round does not march anywhere: it turns, and only then dresses back onto
   * the shape.
   *
   * Without this the lattice sweeps through the whole arc and every man chases his own slot
   * around it. The slots' *intermediate* positions are not a shape anybody ordered — a
   * 29-wide block half way through a turn is a 29-wide block at 47 degrees, and the man
   * whose place it is has to walk sideways to it and then walk back — so the whole of that
   * motion is work done toward a configuration that was never the destination. Measured with
   * the men following it: a 160-man cohort ordered to about-face walked a median of 5.49 m
   * and took 15.9 s to settle, having finished exactly where it began. Holding them still
   * for the 1.2 s the turn takes costs nothing and removes all of it.
   */
  private turningInPlace = new Uint8Array(64);
  /** The direction a broken unit committed to running in. Zero when it is not routing. */
  private routDirX = new Float32Array(64);
  private routDirZ = new Float32Array(64);
  /** Seconds before a broken unit may pick a new direction to run in. */
  private routHold = new Float32Array(64);
  /**
   * The heading a broken unit is actually running on, which is the threat bearing deflected
   * around whatever is in the way. Zero until it has been chosen. See `ROUT_FAN`.
   *
   * Kept apart from `routDir` on purpose: `routDir` is *why* the unit is running and is
   * what the 70-degree re-aim test is measured against, so folding a wall deflection into
   * it would make every corner look like a new threat and cost the unit another turn.
   */
  private routSteerX = new Float32Array(64);
  private routSteerZ = new Float32Array(64);
  /** Seconds before the deflection is re-examined. See `ROUT_STEER_HOLD`. */
  private routSteerHold = new Float32Array(64);
  /**
   * Files this unit had before an aperture squeezed it, or -1 when it has not been
   * squeezed. See `fitToAperture`.
   *
   * The original rather than a boolean, because what the unit spreads back out to is a
   * number the player may have chosen with a right-click drag and which `formation.width`
   * cannot reproduce.
   */
  private fileRestore = new Int32Array(64).fill(-1);
  /** Tick each unit last measured the corridor ahead of it. */
  private apertureAt = new Float32Array(64).fill(-1e9);
  /**
   * And where it stood at the time, so a unit that has not moved does not measure again.
   *
   * The great majority of units in a siege are standing still — in a melee, on a wall, in
   * reserve — and the corridor round a stationary block cannot change unless the masonry
   * does, which `masonryGen` covers. Without this the measurement runs for every unit for
   * the whole battle to re-derive an answer it already has.
   */
  private apertureX = new Float32Array(64).fill(NaN);
  private apertureZ = new Float32Array(64).fill(NaN);
  /** `masonryGen` the last measurement was taken against. */
  private apertureGen = new Int32Array(64).fill(-1);
  /**
   * The narrowest corridor each unit's last measurement found, metres.
   *
   * Kept only so the instruments can read it. A probe that can see the frontage but not the
   * width it was compared against can tell you that a unit filed up and not whether it
   * should have, and this project has lost more time to that than to any single defect.
   */
  private apertureFree = new Float32Array(64).fill(Infinity);
  /**
   * Tick at which each unit last examined its route to the enemy it is attacking.
   *
   * Filled with a large negative so a unit's first attack order routes immediately rather
   * than after `ATTACK_REROUTE_TICKS`.
   */
  private attackRouteAt = new Float32Array(64).fill(-1e9);
  /** Consecutive ticks a unit under a move order has failed to advance. See `STALL_TICKS`. */
  private stallTicks = new Float32Array(64);
  /**
   * A breadcrumb trail of where each unit's anchor has been, newest last.
   *
   * Flat, `TRAIL_LEN` slots per unit, so it costs two floats per breadcrumb and no objects.
   * `trailN` is how many are valid; once full it shifts down by one, which is `TRAIL_LEN`
   * copies on the rare tick a crumb is laid and nothing at all otherwise.
   */
  private trailX = new Float32Array(64 * TRAIL_LEN);
  private trailZ = new Float32Array(64 * TRAIL_LEN);
  private trailN = new Int32Array(64);
  /** The last position a unit was *ordered* to hold. See `ENGAGE_BUDGET`. */
  private holdX = new Float32Array(64);
  private holdZ = new Float32Array(64);
  private holdSet = new Uint8Array(64);
  /**
   * Where a separated man is currently heading to get back, and when to re-plan.
   *
   * `rallyOn` is a flag rather than a sentinel coordinate: (0, 0) is the centre of the
   * battlefield, not a value that can mean "none".
   */
  private rallyX!: Float32Array;
  private rallyZ!: Float32Array;
  private rallyOn!: Uint8Array;
  private rallyUntil!: Float32Array;

  private growUnitScratch(n: number): void {
    if (this.frontGaps.length >= n) return;
    const size = Math.max(n, this.frontGaps.length * 2);
    const g = new Float32Array(size).fill(Infinity);
    g.set(this.frontGaps);
    this.frontGaps = g;
    const e = new Int32Array(size).fill(-1);
    e.set(this.frontEnemies);
    this.frontEnemies = e;
    const rf = new Float32Array(size).fill(NaN);
    rf.set(this.reformFacing);
    this.reformFacing = rf;
    const rs = new Float64Array(size).fill(NaN);
    rs.set(this.reformShape);
    this.reformShape = rs;
    const tip = new Uint8Array(size);
    tip.set(this.turningInPlace);
    this.turningInPlace = tip;
    const rx = new Float32Array(size);
    rx.set(this.routDirX);
    this.routDirX = rx;
    const rz = new Float32Array(size);
    rz.set(this.routDirZ);
    this.routDirZ = rz;
    const rh = new Float32Array(size);
    rh.set(this.routHold);
    this.routHold = rh;
    const og = new Float32Array(size);
    og.set(this.orderGrace);
    this.orderGrace = og;
    const ar = new Float32Array(size).fill(-1e9);
    ar.set(this.attackRouteAt);
    this.attackRouteAt = ar;
    const stl = new Float32Array(size);
    stl.set(this.stallTicks);
    this.stallTicks = stl;
    const tx = new Float32Array(size * TRAIL_LEN);
    tx.set(this.trailX);
    this.trailX = tx;
    const tz = new Float32Array(size * TRAIL_LEN);
    tz.set(this.trailZ);
    this.trailZ = tz;
    const tn = new Int32Array(size);
    tn.set(this.trailN);
    this.trailN = tn;
    const hx = new Float32Array(size);
    hx.set(this.holdX);
    this.holdX = hx;
    const hz = new Float32Array(size);
    hz.set(this.holdZ);
    this.holdZ = hz;
    const hs = new Uint8Array(size);
    hs.set(this.holdSet);
    this.holdSet = hs;
    const bo = new Uint8Array(size);
    bo.set(this.breakingOff);
    this.breakingOff = bo;
    const uy = new Float32Array(size);
    uy.set(this.unitY);
    this.unitY = uy;
    const rsx = new Float32Array(size);
    rsx.set(this.routSteerX);
    this.routSteerX = rsx;
    const rsz = new Float32Array(size);
    rsz.set(this.routSteerZ);
    this.routSteerZ = rsz;
    const rsh = new Float32Array(size);
    rsh.set(this.routSteerHold);
    this.routSteerHold = rsh;
    const fr = new Int32Array(size).fill(-1);
    fr.set(this.fileRestore);
    this.fileRestore = fr;
    const aa = new Float32Array(size).fill(-1e9);
    aa.set(this.apertureAt);
    this.apertureAt = aa;
    const af = new Float32Array(size).fill(Infinity);
    af.set(this.apertureFree);
    this.apertureFree = af;
    const apx = new Float32Array(size).fill(NaN);
    apx.set(this.apertureX);
    this.apertureX = apx;
    const apz = new Float32Array(size).fill(NaN);
    apz.set(this.apertureZ);
    this.apertureZ = apz;
    const apg = new Int32Array(size).fill(-1);
    apg.set(this.apertureGen);
    this.apertureGen = apg;
  }

  /** Mean foot height of a unit's living men. Terrain height for everyone on the ground. */
  levelOf(unitId: number): number {
    return this.unitY[unitId] ?? 0;
  }

  /** Metres between this unit's front rank and the nearest enemy's. */
  frontGapOf(unitId: number): number {
    return this.frontGaps[unitId] ?? Infinity;
  }

  /** The enemy unit whose front rank is nearest, or -1. */
  frontEnemyOf(unitId: number): number {
    return this.frontEnemies[unitId] ?? -1;
  }

  /** Half the frontage of a unit's front rank, in metres. */
  frontHalf(u: UnitGroupState): number {
    const men = Math.max(1, Math.min(u.width, u.alive));
    return Math.max(1.2, men * formation(u.formationId).frontMul * u.spacingX * 0.5);
  }

  /**
   * Front-to-front distance to the nearest enemy formation, and the unit id it belongs
   * to. Anchors lie about contact: two cohorts standing shoulder to shoulder have
   * anchors twenty metres apart and front ranks touching, while two blocks that have
   * slid through each other have coincident anchors and are fighting nobody in front.
   * Everything about meeting an enemy is measured between the front-rank *segments*.
   */
  private nearestEnemyFront(u: UnitGroupState): { dist: number; id: number } {
    frontSegment(u.x, u.z, u.facing, this.frontHalf(u), SEG_SELF);
    let best = Infinity;
    let bestId = -1;
    const selfY = this.unitY[u.id] ?? 0;
    for (const o of this.units) {
      if (o.destroyed || o.faction === u.faction || o.alive === 0) continue;
      if (o.order === UnitOrder.Rout) continue;
      // Two formations at different heights are not in contact whatever their frontages
      // say. Without this a garrison on the wall-walk locks against the besiegers at the
      // foot of it, stops advancing (it was not going anywhere) and — much worse — the
      // volley state machine reads the lock as "in melee" and the garrison stops shooting,
      // which is the one thing it is up there to do.
      if (Math.abs((this.unitY[o.id] ?? 0) - selfY) > SAME_LEVEL_DY) continue;
      // Cheap reject before the segment maths.
      const cx = o.x - u.x;
      const cz = o.z - u.z;
      const reach = 60 + this.frontHalf(u) + this.frontHalf(o);
      if (cx * cx + cz * cz > reach * reach) continue;
      frontSegment(o.x, o.z, o.facing, this.frontHalf(o), SEG_OTHER);
      const d = segmentDistance(SEG_SELF, SEG_OTHER);
      if (d < best) {
        best = d;
        bestId = o.id;
      }
    }
    return { dist: best, id: bestId };
  }

  // -------------------------------------------------------------------------
  // Apertures
  // -------------------------------------------------------------------------

  /**
   * Metres of clear ground along a ray, up to `maxLen`, for a body of `radius`.
   *
   * Against `masonry` and not against the nav grid, and the difference is the whole reason
   * this exists rather than calling `NavProvider.clearLineFraction`. That walks the 7 m nav
   * lattice and consults `clearance`, so it cannot see a 5.2 m gate at all — the grid
   * reports 7 m of clearance in the gate cell because one cell step is as fine as it gets,
   * which is exactly why `routeThroughPortals` has to lock a route onto the gate's axis by
   * hand. `masonry` is the oriented-box field the integrator itself collides against, with
   * the carriageway punched out of it by the city, so it is the only truth in the process
   * that agrees with where a man is actually allowed to stand.
   */
  private clearRun(
    x: number, z: number, dx: number, dz: number, y: number, maxLen: number, radius: number
  ): number {
    const solids = this.masonry;
    if (solids.empty) return maxLen;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) return maxLen;
    const ux = dx / len;
    const uz = dz / len;
    for (let d = ROUT_RAY_STEP; d <= maxLen; d += ROUT_RAY_STEP) {
      if (solids.blocked(x + ux * d, z + uz * d, y, radius)) return d - ROUT_RAY_STEP;
    }
    return maxLen;
  }

  /**
   * Metres of lateral room a body has at (x,z), measured across (dx,dz), capped at `want`.
   *
   * The span available to a man's *centre*, so it is directly comparable with a formation's
   * frontage: `width` files at `spacingX` need `(width - 1) * spacingX` of it. Probed with
   * `SOLDIER_RADIUS`, which is the radius the integrator stops a man at, so the answer is
   * the room the men will actually find rather than the room the geometry contains.
   *
   * Returns `want` when the centre itself is solid. A probe point inside masonry cannot
   * report a corridor — it is not in one — and returning zero there would file a unit up
   * because its look-ahead happened to land in a building it is walking past.
   */
  private corridorAt(
    x: number, z: number, dx: number, dz: number, y: number, want: number
  ): number {
    const solids = this.masonry;
    if (solids.empty) return want;
    if (solids.blocked(x, z, y, SOLDIER_RADIUS)) return want;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) return want;
    // Lateral unit vector: the direction of travel rotated a quarter turn.
    const lx = -dz / len;
    const lz = dx / len;
    let left = want;
    for (let d = APERTURE_STEP; d <= want; d += APERTURE_STEP) {
      if (solids.blocked(x - lx * d, z - lz * d, y, SOLDIER_RADIUS)) {
        left = d - APERTURE_STEP;
        break;
      }
    }
    let right = want;
    for (let d = APERTURE_STEP; d <= want; d += APERTURE_STEP) {
      if (solids.blocked(x + lx * d, z + lz * d, y, SOLDIER_RADIUS)) {
        right = d - APERTURE_STEP;
        break;
      }
    }
    return Math.min(want, left + right);
  }

  /**
   * Files of this unit's own lateral spacing that fit in `free` metres of room.
   *
   * `width` files span `(width - 1) * spacingX`, so the arithmetic is `free / spacingX + 1`
   * — and this deliberately does not add the 1. One file of conservatism is what keeps a
   * column off the jambs rather than flush against them, and flush against them is the
   * thing being fixed.
   *
   * Public because the wall is the same problem one storey up: a 3.25 m wall-walk is an
   * aperture with a 41-file cohort being asked to enter it, and `Siege` owns that placement.
   * This is the primitive it needs, and `narrowToFiles` is the write.
   */
  filesInWidth(u: UnitGroupState, free: number): number {
    const sx = u.spacingX > 1e-3 ? u.spacingX : 1;
    return Math.max(1, Math.floor(free / sx));
  }

  /**
   * Squeeze a unit's frontage to `files`, remembering what it had.
   *
   * Idempotent and re-entrant: called every measurement while the unit is in a gate, and
   * the remembered width is only captured on the first one.
   */
  narrowToFiles(u: UnitGroupState, files: number): void {
    this.growUnitScratch(u.id + 1);
    const want = Math.max(1, Math.min(files, u.width));
    if (this.fileRestore[u.id] < 0) this.fileRestore[u.id] = u.width;
    u.width = want;
  }

  /** Spread a squeezed unit back out. A no-op for a unit that was never squeezed. */
  restoreFiles(u: UnitGroupState): void {
    this.growUnitScratch(u.id + 1);
    const was = this.fileRestore[u.id];
    if (was < 0) return;
    this.fileRestore[u.id] = -1;
    u.width = was;
  }

  /** Files this unit is squeezed down from, or -1. Read by the probes and the HUD. */
  squeezedFrom(unitId: number): number {
    return this.fileRestore[unitId] ?? -1;
  }

  /** The narrowest corridor this unit's last measurement found, metres. */
  corridorOf(unitId: number): number {
    return this.apertureFree[unitId] ?? Infinity;
  }

  /**
   * File up to enter a hole narrower than the formation, and spread out once through it.
   *
   * Geometric and continuous rather than a flag on a route, which is what makes one
   * mechanism serve three cases that were being argued about separately: a player order
   * through a gate, an AI attack order through the same gate, and a broken unit squeezing
   * back out of one. None of them has to be taught about apertures; the corridor is
   * measured where the unit is going and the frontage follows it.
   *
   * Costs one boolean on any map with no city on it. On a map with one, measured on the
   * Carthage assault by wrapping `ObstacleField.solidAt` and counting: 1,287 box tests a
   * tick before this pass and 1,388 after — about a hundred a tick across thirty units,
   * against the several hundred thousand pair tests `resolveCrowding` already runs every
   * second. The whole-tick cost, A/B'd against a worktree pinned at 7dd9616 with the two
   * arms **interleaved**, is 1.035x. Interleaved because the same measurement taken as two
   * ordered runs on this shared box reported 2.42 and then 5.03 ms/tick, and then 3.20 for
   * a repeat of the *first* arm.
   */
  private fitToAperture(u: UnitGroupState): void {
    const solids = this.masonry;
    if (solids.empty) return;
    // A unit the siege system places is not in a formation this code can reason about: its
    // men stand where the stonework says. See `steerSoldiers`.
    if (this.siege.ownsUnit(u.id)) return;
    /*
     * And a unit that is locked in a fight keeps whatever frontage it brought to it.
     *
     * Both directions of this are wrong mid-melee and the reasons differ. Squeezing a line
     * that is fighting with its back to a building would collapse a contact front into a
     * column, and because `frontHalf` is computed from `u.width` the contact test would then
     * stop seeing the enemy it is fighting — the lock would drop and the two blocks would
     * walk through each other. Spreading one out would push men sideways into the masonry
     * that made the corridor narrow in the first place. The width a unit fights at is the
     * width it arrived at, and that is the whole of the rule.
     *
     * `contactLock` is a tick stale here — `updateUnitOrder` writes it a few lines later —
     * which costs one tick of the wrong answer at the moment of contact and is the price of
     * this running before the frontage is read rather than after.
     */
    if (u.contactLock) return;
    this.growUnitScratch(u.id + 1);
    if (this.tickCount - this.apertureAt[u.id] < APERTURE_TICKS) return;
    // A block that has not moved a sampling step since its last measurement, over masonry
    // that has not changed, will get the same answer. A squeezed unit is exempt: it is the
    // one that has to notice the moment it may spread out again, and it may be standing
    // still in a gate mouth while it waits.
    if (this.fileRestore[u.id] < 0 && this.apertureGen[u.id] === this.masonryGen
      && Math.abs(u.x - this.apertureX[u.id]) + Math.abs(u.z - this.apertureZ[u.id])
        < APERTURE_SCAN) {
      return;
    }
    this.apertureAt[u.id] = this.tickCount;
    this.apertureX[u.id] = u.x;
    this.apertureZ[u.id] = u.z;
    this.apertureGen[u.id] = this.masonryGen;

    // Where is it going? The current target, which after `routeThroughPortals` is the
    // gate's own axis for anything routed through one. A unit with nowhere to be measures
    // along its facing, so a formation standing in a gate mouth stays filed up.
    let dx = u.targetX - u.x;
    let dz = u.targetZ - u.z;
    let len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.35) {
      dx = Math.sin(u.facing);
      dz = Math.cos(u.facing);
      len = 1;
    }
    const ux = dx / len;
    const uz = dz / len;

    const was = this.fileRestore[u.id];
    const files = was >= 0 ? was : u.width;
    const frontage = Math.max(0, files - 1) * u.spacingX;
    // Nothing to reconcile: a two-file column and a scorpion crew fit anything.
    if (frontage < APERTURE_STEP) {
      this.apertureFree[u.id] = Infinity;
      this.restoreFiles(u);
      return;
    }
    const want = frontage + APERTURE_RELEASE;
    const y = this.unitY[u.id] ?? this.groundAt(u.x, u.z);
    /*
     * How long is the block?
     *
     * While it is *moving*, against the width it currently has, because the tail being
     * measured is where the men actually are: sixty horses are five ranks and 15 m deep at
     * thirteen files and thirty ranks and 88 m deep at two.
     *
     * Once it has **arrived**, against the width it is going back to — and that clause is
     * load-bearing rather than a refinement. A squeezed column's own tail is longer than the
     * approach to any gate, so measured against the current width it always contains the
     * gate, so the release condition can never be met: measured, a squadron ordered 60 m
     * inside Carthage halted at its destination as an 88 m two-file column with twenty of
     * its sixty men still outside the wall, and stood in it. A formation at rest takes the
     * shape it was ordered into; the stragglers then walk through the hole one at a time,
     * which is what the straggler rally already exists to handle.
     *
     * A unit *halted inside a gate* is not caught by this, and must not be: the sample at
     * its own position still reads the carriageway, so `free` is still 4.8 m and it stays a
     * column.
     */
    const moving = u.waypoints.length > 0
      || (u.targetX - u.x) * (u.targetX - u.x) + (u.targetZ - u.z) * (u.targetZ - u.z) > 4;
    const depth = Math.min(
      APERTURE_TRAIL_MAX,
      ranksFor(u.members.length, Math.max(1, moving ? u.width : files)) * u.spacingZ
    );
    // Ahead only as far as there is somewhere to go: a unit ordered *into* a gate mouth
    // would otherwise measure the open ground beyond it and spread out on arrival.
    const ahead = Math.min(APERTURE_LOOK, Math.max(0, len));
    const half = want * 0.5 + SOLDIER_RADIUS;

    /*
     * Sample the span nearest-first, in one pass, so an early exit keeps the constraints
     * that matter. `k` walks outward from the unit and `sign` alternates, which visits
     * 0, +1.5, -1.5, +3.0, -3.0 … — the order the cap below wants.
     */
    const steps = Math.ceil(Math.max(ahead, depth) / APERTURE_SCAN);
    let free = want;
    let probes = 0;
    let tight = false;
    for (let k = 0; k <= steps; k++) {
      for (let sign = 1; sign >= -1; sign -= 2) {
        if (k === 0 && sign < 0) continue;
        const d = sign * k * APERTURE_SCAN;
        if (d > ahead || -d > depth) continue;
        const px = u.x + ux * d;
        const pz = u.z + uz * d;
        // The cheap gate: could a block this wide be centred here at all? One box test
        // against an inflated footprint, and on open ground it is the only test that runs.
        if (!solids.blocked(px, pz, y, half)) continue;
        tight = true;
        if (probes >= APERTURE_PROBES) continue;
        probes++;
        const w = this.corridorAt(px, pz, ux, uz, y, want);
        if (w < free) free = w;
      }
      // Already down to the floor: nothing further along the span can change the answer.
      if (free < APERTURE_MIN_FILES * u.spacingX) break;
    }

    this.apertureFree[u.id] = tight ? free : Infinity;
    if (!tight || free >= want) {
      this.restoreFiles(u);
      return;
    }
    // Tight, but the frontage still fits without its margin: hold whatever it has rather
    // than flapping between two widths on the hysteresis boundary.
    if (free >= frontage) return;
    const fit = Math.max(APERTURE_MIN_FILES, this.filesInWidth(u, free));
    // Never widen through this path: only the release above may do that, and only on the
    // hysteresis margin. Without the guard a column halfway through a gate whose far probes
    // have cleared the wall would spread inside the passage.
    if (fit >= u.width) return;
    this.narrowToFiles(u, fit);
  }

  // -------------------------------------------------------------------------
  // Flight
  // -------------------------------------------------------------------------

  /**
   * Where a broken unit should actually run, given where it wants to run.
   *
   * Three tiers, cheapest first. On a map with no masonry only the first exists.
   *
   *   1. the threat bearing, if the ground ahead is clear. This is the behaviour that was
   *      here before and it is right nine times out of ten.
   *   2. the least deflection from it with a longer clear run — `ROUT_FAN`, nearest first.
   *   3. the unit's own breadcrumb trail, walked backwards. A trail is a route the unit
   *      demonstrably walked, so it is walkable by construction, and walking it backwards
   *      is "flee the way you came in" without a path search. This is what gets a broken
   *      invader back out of a city rather than sliding along an insula for nine seconds.
   */
  private aimRout(u: UnitGroupState, dt: number): void {
    const id = u.id;
    const ax = this.routDirX[id];
    const az = this.routDirZ[id];
    // Open field: one boolean, and the flight line is the answer it always was.
    if (this.masonry.empty) {
      u.targetX = u.x + ax * 60;
      u.targetZ = u.z + az * 60;
      u.targetFacing = Math.atan2(ax, az);
      return;
    }

    const y = this.unitY[id] ?? this.groundAt(u.x, u.z);
    this.routSteerHold[id] = Math.max(0, this.routSteerHold[id] - dt);
    let sx = this.routSteerX[id];
    let sz = this.routSteerZ[id];
    const committed = sx !== 0 || sz !== 0;
    const run = committed ? this.clearRun(u.x, u.z, sx, sz, y, ROUT_LOOK, ROUT_CORRIDOR) : 0;
    // Re-choose when there is nothing committed, when the hold has run out, or the moment
    // the committed line stops being usable — a unit that has just met a wall must not
    // spend another second walking into it waiting for a timer.
    if (!committed || run < ROUT_MIN_RUN || this.routSteerHold[id] <= 0) {
      let bestX = ax;
      let bestZ = az;
      let bestRun = -1;
      for (const dev of ROUT_FAN) {
        // Rotate the threat bearing by `dev`. (ax, az) is (sin, cos) of a yaw, so this is
        // a yaw addition and not a vector rotation, which keeps it consistent with every
        // other heading in this file.
        const c = Math.cos(dev);
        const s2 = Math.sin(dev);
        const hx = ax * c + az * s2;
        const hz = az * c - ax * s2;
        const r = this.clearRun(u.x, u.z, hx, hz, y, ROUT_LOOK, ROUT_CORRIDOR);
        if (r > bestRun) {
          bestRun = r;
          bestX = hx;
          bestZ = hz;
        }
        // Nothing beats a clear run to the horizon, and the nearest deflection that
        // achieves one is the one wanted, so stop looking.
        if (r >= ROUT_LOOK) break;
      }
      if (bestRun < ROUT_MIN_RUN && this.flightTrail(u, y, SCRATCH2)) {
        u.targetX = SCRATCH2.x;
        u.targetZ = SCRATCH2.z;
        u.targetFacing = Math.atan2(SCRATCH2.x - u.x, SCRATCH2.z - u.z);
        // Deliberately not committed as a steer: the crumb is a point, not a bearing, and
        // the next measurement should pick a fresh one from wherever the unit has got to.
        this.routSteerX[id] = 0;
        this.routSteerZ[id] = 0;
        this.routSteerHold[id] = ROUT_STEER_HOLD;
        return;
      }
      sx = bestX;
      sz = bestZ;
      this.routSteerX[id] = sx;
      this.routSteerZ[id] = sz;
      this.routSteerHold[id] = ROUT_STEER_HOLD;
    }
    u.targetX = u.x + sx * 60;
    u.targetZ = u.z + sz * 60;
    u.targetFacing = Math.atan2(sx, sz);
  }

  /**
   * The oldest breadcrumb this unit can see, as a flight destination.
   *
   * Oldest and not newest, which is the opposite of `rallyPoint` and for the opposite
   * reason: a straggler wants to catch up with his unit, and a broken unit wants to be as
   * far back down the road it came by as it can get to in one leg. Bounded by `RALLY_SCAN`
   * traces for the same cost reason.
   */
  private flightTrail(u: UnitGroupState, y: number, out: { x: number; z: number }): boolean {
    const id = u.id;
    const n = this.trailN[id];
    if (n === 0) return false;
    const base = id * TRAIL_LEN;
    const scanned = Math.min(n, RALLY_SCAN);
    for (let k = 0; k < scanned; k++) {
      const cx = this.trailX[base + k];
      const cz = this.trailZ[base + k];
      const dx = cx - u.x;
      const dz = cz - u.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      // A crumb underfoot is not somewhere to run to.
      if (d < ROUT_MIN_RUN) continue;
      if (this.clearRun(u.x, u.z, dx, dz, y, d, ROUT_CORRIDOR) < d - ROUT_RAY_STEP) continue;
      out.x = cx;
      out.z = cz;
      return true;
    }
    return false;
  }

  /** Move the formation anchor toward its objective and consume waypoints. */
  private updateUnitOrder(u: UnitGroupState, dt: number): void {
    const def = this.typeOf(u);
    const routing = u.order === UnitOrder.Rout;

    // ---- contact lock -------------------------------------------------------
    // Geometric, hysteretic, and owned here rather than in Combat: this is the flag
    // that stops a formation advancing, and the advance lives in this function. Combat
    // mirrors it onto the shared blackboard and adds the blows-are-landing case.
    this.growUnitScratch(u.id + 1);
    // Cleared here and set in exactly one place — the standing wheel at the bottom — so a
    // unit that starts moving, breaks into a fight or routs cannot be left holding station
    // because of a turn it was part way through.
    this.turningInPlace[u.id] = 0;
    const near = routing ? { dist: Infinity, id: -1 } : this.nearestEnemyFront(u);
    this.frontGaps[u.id] = near.dist;
    this.frontEnemies[u.id] = near.id;
    if (this.holdSet[u.id] === 0) {
      this.holdX[u.id] = u.x;
      this.holdZ[u.id] = u.z;
      this.holdSet[u.id] = 1;
    }
    const grace = this.orderGrace[u.id] > 0;
    if (grace) this.orderGrace[u.id] = Math.max(0, this.orderGrace[u.id] - dt);

    if (routing || grace) {
      u.contactLock = false;
    } else if (u.contactLock) {
      if (near.dist > CONTACT_EXIT) {
        u.contactLock = false;
        // Release with the anchor where the shoving match left it, not where the order
        // that brought the unit here was aiming.
        if (u.order === UnitOrder.Hold) {
          u.targetX = u.x;
          u.targetZ = u.z;
        }
      }
    } else if (near.dist < CONTACT_ENTER) {
      u.contactLock = true;
    }

    // Chasing a specific enemy unit: aim at the nearest point of its frontage.
    if (u.order === UnitOrder.AttackUnit) {
      const t = this.unitById(u.targetUnitId);
      if (!t || t.destroyed || t.alive === 0) {
        u.order = UnitOrder.Hold;
        u.targetUnitId = -1;
        u.targetX = u.x;
        u.targetZ = u.z;
      } else if (!u.contactLock) {
        frontSegment(t.x, t.z, t.facing, this.frontHalf(t), SEG_OTHER);
        closestPointOnSegment(u.x, u.z, SEG_OTHER, AIM);
        const dx = AIM.x - u.x;
        const dz = AIM.z - u.z;
        const d = Math.sqrt(dx * dx + dz * dz) || 1;
        // Stop with the fronts a shield's width apart. `resolveCrowding` and the press
        // then close the last few centimetres, which is what makes the seam ragged.
        const standoff = CONTACT_GAP;
        const ax = AIM.x - (dx / d) * standoff;
        const az = AIM.z - (dz / d) * standoff;
        u.targetFacing = Math.atan2(dx, dz);
        // Straight at him only if a straight line is something a formation can walk. When
        // it is not, `steerAttack` owns the destination until a route arrives.
        if (!this.steerAttack(u, ax, az)) {
          u.targetX = ax;
          u.targetZ = az;
        }
      }
    }

    if (routing) {
      u.routTimer += dt;
      // Flee away from the enemy's centre of mass — but commit to a direction. Recomputed
      // every tick, the threat bearing swings as pursuing cavalry rides around the mob,
      // and the unit turns at the rate limit for the whole flight: measured 68 degrees a
      // second of pure spin on broken warbands. Men running for their lives run in a
      // straight line; they only change their minds when something gets in the way.
      const away = this.threatDirection(u);
      const cx = this.routDirX[u.id];
      const cz = this.routDirZ[u.id];
      const committed = cx !== 0 || cz !== 0;
      // 0.34 is about 70 degrees: a genuinely new threat, not the same one drifting. And
      // never more than once every three seconds, because a horseman circling a broken mob
      // can drag the threat bearing past 70 degrees again and again, and each re-aim costs
      // the whole unit another turn.
      this.routHold[u.id] = Math.max(0, this.routHold[u.id] - dt);
      if (!committed || (this.routHold[u.id] <= 0 && away.x * cx + away.z * cz < 0.34)) {
        this.routDirX[u.id] = away.x;
        this.routDirZ[u.id] = away.z;
        this.routHold[u.id] = 3;
      }
      // And then run somewhere that is not a wall. `aimRout` owns the destination from
      // here: on open ground it is `position + bearing * 60` exactly as before, and inside
      // a city it is the least deflection from that bearing with somewhere to go.
      this.aimRout(u, dt);
    } else if (this.routDirX[u.id] !== 0 || this.routDirZ[u.id] !== 0) {
      this.routDirX[u.id] = 0;
      this.routDirZ[u.id] = 0;
      this.routSteerX[u.id] = 0;
      this.routSteerZ[u.id] = 0;
      this.routSteerHold[u.id] = 0;
    }

    const dx = u.targetX - u.x;
    const dz = u.targetZ - u.z;
    const distToTarget = Math.sqrt(dx * dx + dz * dz);
    // Where the anchor stood before this step, for the stall watchdog below.
    const beforeX = u.x;
    const beforeZ = u.z;
    let moving = false;
    /** How much of the heading points at the objective; see the movement branch. */
    let headingAlign = 1;

    // Locked in contact: hold the anchor and only pivot, slowly. `Combat.resolvePush`
    // is the only thing allowed to move the anchor from here, so a line that is losing
    // gives ground and a line that is winning walks forward, and neither slides
    // sideways chasing the other's centre.
    //
    // But the lock exists to stop two lines walking *through* each other, not to pin a
    // unit that has been told to leave. If the order sends it away from the enemy it is
    // locked with, let it go — otherwise a pursued unit is frozen the instant its pursuer
    // catches up, and a withdraw order can never be carried out. A timed grace was not
    // enough: the unit broke off, moved five metres, was caught, and stopped again.
    let breakingOff = false;
    if (u.contactLock && distToTarget > 0.35) {
      const eid = this.frontEnemies[u.id];
      const e = eid >= 0 ? this.unitById(eid) : undefined;
      if (!e) breakingOff = true;
      else {
        // Positive dot = the ordered move closes on the enemy; negative = it opens away.
        const toE = Math.sqrt((e.x - u.x) * (e.x - u.x) + (e.z - u.z) * (e.z - u.z)) || 1;
        const dot = ((e.x - u.x) / toE) * (dx / distToTarget)
                  + ((e.z - u.z) / toE) * (dz / distToTarget);
        breakingOff = dot < -0.25;
      }
    }

    this.breakingOff[u.id] = breakingOff ? 1 : 0;

    if (u.contactLock && !breakingOff) {
      // Locked in a fight, not stuck. Clear the watchdog so a long engagement does not
      // leave a nearly-expired count that fires on the first tick after it breaks off.
      this.growUnitScratch(u.id + 1);
      this.stallTicks[u.id] = 0;
      u.facing = turnToward(u.facing, u.targetFacing, dt * 0.35);
      const drain = u.engaged ? dt / (def.stamina * 2.4) : -dt / 26;
      u.fatigue = clamp01(u.fatigue + drain);
      if (u.chargeTimer > 0) u.chargeTimer = Math.max(0, u.chargeTimer - dt);
      return;
    }

    // Arrived: pop the next queued waypoint, else settle.
    if (distToTarget < 0.35) {
      if (u.waypoints.length >= 3) {
        u.targetX = u.waypoints.shift()!;
        u.targetZ = u.waypoints.shift()!;
        u.targetFacing = u.waypoints.shift()!;
      } else if (u.order === UnitOrder.MoveTo) {
        // The queue is empty. Either the unit is where it was sent, or it walked a route
        // that stopped short of it and should plan again from here.
        if (!this.resumeRoute(u)) u.order = UnitOrder.Hold;
      }
      // Standing still with an enemy a stride away: take the stride. Re-checking the
      // distance to target catches the case where `resumeRoute` just installed a new leg,
      // which is a unit with somewhere to be rather than one standing about.
      if (!routing && !breakingOff && !u.contactLock && this.orderGrace[u.id] <= 0
        && u.waypoints.length < 3
        && Math.sqrt((u.targetX - u.x) * (u.targetX - u.x) + (u.targetZ - u.z) * (u.targetZ - u.z)) < 0.35) {
        this.closeToContact(u, near.dist, near.id, dt);
      }
    } else {
      moving = true;
      const f = formation(u.formationId);
      const base = routing ? def.runSpeed * 1.06
        : u.charging ? def.chargeSpeed
        : u.running ? def.runSpeed
        : def.walkSpeed;
      // Fatigue and formation drag both bite into speed.
      const speed = base * f.mods.speed * (1 - u.fatigue * 0.42);

      // Face the direction of travel while moving; hold the ordered facing on arrival.
      const travelFacing = Math.atan2(dx, dz);
      const wantFacing = distToTarget > 4 ? travelFacing : u.targetFacing;
      u.facing = turnToward(u.facing, wantFacing, dt * 1.9);

      // A formation wheels; it does not strafe. Translating the anchor at full speed in
      // any direction while the heading independently chases a moving target is exactly
      // the recipe for a cyclic-pursuit spiral, and it is what made two units that met
      // orbit each other instead of fighting. Scaling the step by how much of the
      // heading points at the objective means a unit must turn before it can move, and
      // the path straightens out.
      const align = Math.cos(wrapAngle(u.facing - travelFacing));
      headingAlign = align;
      const heading = align > 0 ? 0.25 + 0.75 * align : Math.max(0.06, 0.25 + align * 0.19);
      // The block pays the same toll its men do while its anchor is on standing work, so
      // `u.x` — which the tactical layer reads to decide where the unit *is* — does not
      // sail across a half-built rampart while the men are still scrambling over it.
      const anchorDrag = this.masonry.noRough ? 1 : this.masonry.dragAt(u.x, u.z);
      let step = Math.min(distToTarget, speed * heading * dt * anchorDrag);

      // Block collision: never walk the front rank through an enemy's. Routing units
      // are exempt — broken men go through anything — and so is anyone whose objective
      // takes them away from the enemy in front of them.
      if (!routing && near.dist < Infinity) {
        const closing = (dx / distToTarget) * Math.sin(u.targetFacing)
          + (dz / distToTarget) * Math.cos(u.targetFacing);
        if (closing > -0.2) step = Math.min(step, Math.max(0, near.dist - CONTACT_GAP));
      }

      const ax = u.x + (dx / distToTarget) * step;
      const az = u.z + (dz / distToTarget) * step;
      // The anchor slides along masonry rather than through it. Sliding rather than
      // stopping matters: a line that meets the curtain at an angle should walk along it
      // toward the breach, which is what a real assault does and what a hard stop would
      // turn into a thousand men standing in a field.
      if (!this.masonry.empty && !this.siege.ownsUnit(u.id)) {
        this.masonry.resolve(u.x, u.z, ax, az, this.unitY[u.id] ?? this.groundAt(u.x, u.z), ANCHOR_RADIUS, ANCHOR_HIT);
        u.x = ANCHOR_HIT.x;
        u.z = ANCHOR_HIT.z;
      } else {
        u.x = ax;
        u.z = az;
      }
    }

    this.checkStall(u, moving, headingAlign, beforeX, beforeZ, distToTarget);

    if (distToTarget <= 0.35) {
      /*
       * A formation standing still turns as fast as its men do, and no faster.
       *
       * This was 0.6 rad/s — a 180-degree about-face in five seconds — and the reason given
       * was that several hundred men take time to wheel, and that a slow rate bounds how
       * badly a jittery facing order can read (at 1.5 rad/s a unit whose ordered facing
       * flipped between two threats span on the spot at 86 degrees a second for a whole
       * battle; 2,578 degrees over thirty seconds, measured).
       *
       * The first half of that was true of the code and not of the world. A body of men
       * turning on the spot was *implemented* as the slot lattice sweeping through five
       * seconds of arc with every man chasing his own slot around it, so a slow rate was
       * the only thing keeping the sweep survivable. It is not implemented that way any
       * more: `pivotAboutCentre` keeps the ground, `maybeReform` keeps each man on the slot
       * nearest him, and `STAND_TURN_RATE` turns his head. What is left for the block's own
       * heading to represent is the men's heading, so it should move at the men's rate.
       *
       * Measured (`tools/probe-aboutface.mjs`), a 160-man cohort ordered to about-face with
       * everything else in this branch already in place: at 0.6 rad/s the median man walked
       * **9.61 m**, because the lattice was five seconds away from where it was going and he
       * followed it the whole way. The rate is not a detail of presentation; it is how long
       * the men spend chasing a shape that has not arrived.
       *
       * The second half of the old rationale survives intact. This is still a rate limit,
       * and a facing order that flips every tick still cannot spin a unit faster than a man
       * can turn his own body — which is the bound that actually means something, because
       * the unit's heading is now a claim about which way its men are looking.
       */
      const was = u.facing;
      const toGo = Math.abs(wrapAngle(u.targetFacing - was));
      u.facing = turnToward(u.facing, u.targetFacing, dt * STAND_TURN_RATE);
      if (u.facing !== was) {
        // A body of men turning on the spot pivots about itself, not about the middle of
        // its own front rank. See `pivotAboutCentre`.
        this.pivotAboutCentre(u, was);
        // And its men hold their ground while it does. See `turningInPlace`. The threshold
        // is one degree, so a unit that has arrived on its bearing and is being nudged by
        // rounding is never frozen; anything a player or the AI would call a turn is.
        if (toGo > TURN_HOLD_MIN) this.turningInPlace[u.id] = 1;
      }
    }

    // Fatigue: running and fighting drain, standing still recovers.
    const exerting = distToTarget > 0.8 && (u.running || routing);
    const drain = exerting ? dt / Math.max(8, def.stamina) : u.engaged ? dt / (def.stamina * 2.4) : -dt / 26;
    u.fatigue = clamp01(u.fatigue + drain);

    if (u.chargeTimer > 0) u.chargeTimer = Math.max(0, u.chargeTimer - dt);
  }

  /**
   * Drop a breadcrumb where the anchor is, if it has moved far enough since the last one.
   *
   * The trail is the route the unit demonstrably walked, so it is walkable by construction
   * — which is the whole point. A man who has been left on the wrong side of a wall does
   * not need a pathfinder; he needs to know where his unit came from, and his unit has
   * just been there.
   */
  private layTrail(u: UnitGroupState): void {
    const id = u.id;
    const base = id * TRAIL_LEN;
    const n = this.trailN[id];
    if (n > 0) {
      const lx = this.trailX[base + n - 1];
      const lz = this.trailZ[base + n - 1];
      if ((u.x - lx) * (u.x - lx) + (u.z - lz) * (u.z - lz) < TRAIL_SPACING * TRAIL_SPACING) return;
    }
    if (n < TRAIL_LEN) {
      this.trailX[base + n] = u.x;
      this.trailZ[base + n] = u.z;
      this.trailN[id] = n + 1;
      return;
    }
    for (let k = 1; k < TRAIL_LEN; k++) {
      this.trailX[base + k - 1] = this.trailX[base + k];
      this.trailZ[base + k - 1] = this.trailZ[base + k];
    }
    this.trailX[base + TRAIL_LEN - 1] = u.x;
    this.trailZ[base + TRAIL_LEN - 1] = u.z;
  }

  /**
   * Where should a separated man walk to get back to his unit?
   *
   * The newest breadcrumb he has an unobstructed line to. Walking to that puts him
   * somewhere his unit stood recently, from which the *next* breadcrumb is visible, and so
   * on up the trail — which is string-pulling along a route already proven walkable, for
   * one corridor test per man per `RALLY_REPLAN` instead of a path search per man.
   *
   * Returns false when there is no trail or no crumb is reachable, in which case the
   * caller falls back to walking at the slot: no worse than before, and correct on every
   * map with no city on it, where `nav` is null and nothing can be blocked anyway.
   */
  private rallyPoint(i: number, u: UnitGroupState, out: { x: number; z: number }): boolean {
    const nav = this.nav;
    if (!nav) return false;
    const id = u.id;
    const n = this.trailN[id];
    if (n === 0) return false;
    const base = id * TRAIL_LEN;
    const p = this.pool;
    let nearest = -1;
    let nearestD2 = Infinity;
    /*
     * Only the newest few crumbs get a corridor trace. Each `directRouteClear` is a lattice
     * walk plus a DDA over the city's occupancy grid, and scanning all 28 for every
     * stranded man was ~29 traces each — with a hundred men stuck at a gate and their
     * replan clocks all started on the same tick, that lands as ~4,500 traces on one tick
     * in every eighteen, against 0.34 ms of headroom. A spike like that never shows up in a
     * mean. The distance fallback below needs no traces at all, so bounding the scan costs
     * accuracy only in the case where a far-back crumb is visible and a recent one is not.
     */
    const scanFrom = Math.max(0, n - RALLY_SCAN);
    for (let k = n - 1; k >= 0; k--) {
      if (k < scanFrom) {
        // Still worth knowing which is nearest, but not worth a corridor trace.
        const cx2 = this.trailX[base + k];
        const cz2 = this.trailZ[base + k];
        const dx2 = cx2 - p.x[i];
        const dz2 = cz2 - p.z[i];
        if (this.crumbIsAhead(u, cx2, cz2, i)) {
          const dd = dx2 * dx2 + dz2 * dz2;
          if (dd < nearestD2) { nearestD2 = dd; nearest = k; }
        }
        continue;
      }
      const cx = this.trailX[base + k];
      const cz = this.trailZ[base + k];
      if (nav.directRouteClear(p.x[i], p.z[i], cx, cz, SOLDIER_RADIUS)) {
        out.x = cx;
        out.z = cz;
        return true;
      }
      if (this.crumbIsAhead(u, cx, cz, i)) {
        const dx = cx - p.x[i];
        const dz = cz - p.z[i];
        const d2 = dx * dx + dz * dz;
        if (d2 < nearestD2) {
          nearestD2 = d2;
          nearest = k;
        }
      }
    }
    /*
     * Nothing visible. Head for the closest crumb anyway.
     *
     * This is not a fallback for tidiness; without it the rally almost never fires. A man
     * left behind at a gate is by definition jammed against masonry, and a corridor test
     * that starts inside — or within a body radius of — solid geometry fails against every
     * target, visible or not. Measured on a Porta Flaminia transit: of 99 men far enough
     * from their slot to qualify, 6 had a clear line to the slot itself and **91 could not
     * see a single one of the 25 breadcrumbs**, so the rally engaged for one man in the
     * whole cohort and the fix did nothing at all.
     *
     * A crumb is a place the unit's own anchor stood, so it is somewhere a body fits. The
     * worst case of walking at one blind is that `integrate` slides him along a wall on the
     * way — which is exactly what he would do anyway, except now he is sliding toward
     * somewhere his unit has actually been instead of at a slot on the far side of a
     * curtain wall.
     */
    if (nearest >= 0) {
      out.x = this.trailX[base + nearest];
      out.z = this.trailZ[base + nearest];
      return true;
    }
    return false;
  }

  /**
   * Is this breadcrumb *towards* the unit, rather than further back down the trail?
   *
   * The blind fallback picks the nearest crumb, and without this a man who has dropped off
   * the back of a column picks the one he has already walked past: he turns round, walks to
   * it, re-plans, picks the same one, and stands there while his unit marches away. Which
   * is to say the mechanism written to recover stragglers would manufacture them.
   */
  private crumbIsAhead(u: UnitGroupState, cx: number, cz: number, i: number): boolean {
    const p = this.pool;
    const mine = (u.x - p.x[i]) * (u.x - p.x[i]) + (u.z - p.z[i]) * (u.z - p.z[i]);
    return (u.x - cx) * (u.x - cx) + (u.z - cz) * (u.z - cz) <= mine;
  }

  /**
   * Close the last stride into contact.
   *
   * **Nothing else in the tick does this**, and that is why two formations could stand and
   * look at each other indefinitely. Every mechanism that closes distance stops short:
   *
   *  - the anchor stops the moment its order is satisfied, and a Hold order is satisfied
   *    where the unit is standing;
   *  - the geometric lock only engages inside `CONTACT_ENTER`, so it cannot *create*
   *    contact, only recognise it;
   *  - the press moves the rear ranks up and by construction cannot move the front one —
   *    a front-ranker's slot offset is zero, so `press[i]` is `min(-0, …)`, which is zero;
   *  - and `Combat`'s closing nudge is not overwritten but *balanced*: it runs at order 20,
   *    after this system's integrate at order 10, so the next tick's `steerSoldiers` lerps
   *    the velocity back toward the slot at `k = 1 - exp(-5.5 dt) = 0.1675`. The two settle
   *    at a fixed point, and solving it gives 0.140 m of forward creep — which is what the
   *    front rank was measured holding, to three figures.
   *
   * Measured on open ground, both units on Hold, fronts 3.5, 4, 5 and 7 m apart: zero men
   * in melee after sixty seconds, the front-to-front gap unchanged to the centimetre, and
   * the front rank crept 0.14 m forward and stopped dead there — against a gladius reach
   * of 1.1 m. The player's report was "the units are right in front of each other just
   * standing there not fighting"; this is precisely that, and it is why the *only* thing
   * that reliably started a fight was an order actively driving an anchor forward.
   *
   * So a formation takes the last few metres itself. Deliberately short-ranged and slow:
   * it closes a gap it is already touching, it does not cross a field, and it is
   * suppressed entirely while an order is taking the unit somewhere else.
   */
  private closeToContact(u: UnitGroupState, dist: number, enemyId: number, dt: number): void {
    if (enemyId < 0 || dist <= CONTACT_GAP || dist > ENGAGE_REACH) return;
    // Cheapest gate first, before any geometry: has this unit already wandered as far from
    // its ordered position as it is allowed to? See `ENGAGE_BUDGET`.
    const wx = u.x - this.holdX[u.id];
    const wz = u.z - this.holdZ[u.id];
    if (wx * wx + wz * wz >= ENGAGE_BUDGET * ENGAGE_BUDGET) return;
    // A unit the siege system places is not steered by its anchor at all — `steerToSlots`
    // drives each man to a world slot on the stonework — so closing the anchor would move
    // a point nothing reads and that `trackOwnedAnchors` overwrites at the end of the tick.
    if (this.siege.ownsUnit(u.id)) return;
    const e = this.unitById(enemyId);
    if (!e || e.destroyed || e.alive === 0 || e.order === UnitOrder.Rout) return;

    // Aim at the nearest point of his frontage, not at his centre. Two laterally-offset
    // blocks each crabbing onto the other's centre is mutual pursuit, whose solution curve
    // is a spiral — the same reason `AttackUnit` projects onto the segment.
    frontSegment(e.x, e.z, e.facing, this.frontHalf(e), SEG_OTHER);
    closestPointOnSegment(u.x, u.z, SEG_OTHER, AIM);
    const dx = AIM.x - u.x;
    const dz = AIM.z - u.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-3) return;
    const want = Math.atan2(dx, dz);

    /*
     * Is there anything between us?
     *
     * `nearestEnemyFront` compares front segments and knows nothing about masonry, so two
     * units either side of the 6 m Aurelian curtain can have anchors 5 m apart and pass
     * every other test here. Without a check the anchor grinds into the wall (harmless) and
     * `targetFacing` is written (not harmless) — the block turns to face an enemy through
     * three metres of brick, overriding a facing the player set, at exactly the chokepoint
     * this whole change exists to improve.
     *
     * Marched against `masonry` rather than asked of the pathfinder, and that distinction
     * decides whether this works at all. `nav.directRouteClear` tests the navigation grid's
     * *tight* mask, which carries a pad of up to 5.25 m around a curtain bay and 2.6 m
     * around every insula, and it samples from `s = 0` — so a unit whose own anchor sits in
     * that pad fails the test against every target in every direction. Pressed against the
     * curtain, behind a gate jamb, or in any street narrower than about five metres, the
     * whole behaviour would have switched itself off. That is not hypothetical: it is the
     * measured failure `rallyPoint` needed a distance fallback for, 91 men in 99.
     * `ObstacleField` is the exact oriented-box geometry the men are actually collided
     * against, it is already indexed, and half a metre of step cannot miss a wall.
     */
    if (!this.masonry.empty) {
      const y = this.unitY[u.id] ?? this.groundAt(u.x, u.z);
      const steps = Math.max(2, Math.ceil(d / 0.5));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        if (this.masonry.blocked(u.x + dx * t, u.z + dz * t, y, ANCHOR_RADIUS)) return;
      }
    }

    // Forwards only. A block meets a flank attack by wheeling, and the wheel is the
    // deliberately slow one at the bottom of `updateUnitOrder`.
    if ((dx / d) * Math.sin(u.facing) + (dz / d) * Math.cos(u.facing) < 0.26) {
      if (Math.abs(wrapAngle(want - u.targetFacing)) > 0.26) u.targetFacing = want;
      return;
    }

    /*
     * How far a unit may close on its own initiative before it has to be told to do
     * something. Without a bound this is a pursuit: `ENGAGE_CLOSE_SPEED` is 0.8 m/s and a
     * shieldwall withdraws at `1.55 * 0.5 = 0.775`, a testudo at `1.55 * 0.36 = 0.558`, so
     * an idle unit with no orders at all would follow either of them across the entire map
     * and they could never break away. The budget is refilled by an order, or by the enemy
     * getting further off than `ENGAGE_REACH` — that is, by the situation actually changing.
     */
    /*
     * Wheel, do not strafe.
     *
     * The movement branch scales its step by how much of the heading points at the
     * objective, and says why: translating an anchor at full speed in a direction the block
     * is not facing is what made two units that met orbit each other instead of fighting.
     * Closing had the same freedom — up to 75 degrees off the bow at the full rate — so it
     * broke that invariant at the one moment two formations are closest together. Scaling
     * by the same alignment means a unit turns onto its enemy before it walks at him.
     */
    const align = (dx / d) * Math.sin(u.facing) + (dz / d) * Math.cos(u.facing);
    const step = Math.min(dist - CONTACT_GAP, ENGAGE_CLOSE_SPEED * align * dt);
    if (step <= 0) return;
    const ax = u.x + (dx / d) * step;
    const az = u.z + (dz / d) * step;
    if (!this.masonry.empty && !this.siege.ownsUnit(u.id)) {
      this.masonry.resolve(
        u.x, u.z, ax, az, this.unitY[u.id] ?? this.groundAt(u.x, u.z), ANCHOR_RADIUS, ANCHOR_HIT
      );
      u.x = ANCHOR_HIT.x;
      u.z = ANCHOR_HIT.z;
    } else {
      u.x = ax;
      u.z = az;
    }
    // Adopt the new position as the standing order. Without this the unit walks a
    // centimetre forward and then spends the next tick walking back to where the Hold
    // order says it should be, which is an oscillation rather than an advance.
    u.targetX = u.x;
    u.targetZ = u.z;
    if (Math.abs(wrapAngle(want - u.targetFacing)) > 0.26) u.targetFacing = want;
  }

  /**
   * Break a unit out of a leg it cannot walk.
   *
   * The anchor is stopped by masonry, or wedged behind other cohorts queueing for the same
   * gate, and the arrival test that pops the next waypoint never fires. Rather than pick a
   * cause, this watches the only thing that matters — is the unit getting anywhere — and
   * after `STALL_TICKS` of nothing, drops the leg it is stuck on and takes the next. When
   * the queue runs out it re-plans from where it actually is, which is a different search
   * from the one that produced the leg and usually a solvable one.
   *
   * Contact is exempt: a unit locked front to front with an enemy is not stuck, it is
   * fighting, and `contactLock` already holds the anchor deliberately.
   */
  private checkStall(
    u: UnitGroupState, moving: boolean, headingAlign: number,
    beforeX: number, beforeZ: number, distToTarget: number
  ): void {
    this.growUnitScratch(u.id + 1);
    /*
     * A wheeling formation is not a stuck one. The step is scaled by how much of the
     * heading points at the objective, and the floor on that factor is 0.06 — so a cohort
     * turning through a large angle translates about 6 mm a tick, well under `STALL_EPS`,
     * for the second or two the turn takes. Counting that as a stall made the watchdog drop
     * a perfectly good leg mid-wheel: the reach case went from arriving 12 m short to
     * stopping 53.3 m short, having travelled 66 m less. 0.5 is 60 degrees off the line of
     * march, by which point the unit is genuinely walking rather than pivoting.
     */
    const wanted = moving
      && headingAlign > 0.5
      && (u.order === UnitOrder.MoveTo || u.order === UnitOrder.AttackMove || u.order === UnitOrder.AttackUnit)
      && !u.contactLock
      && distToTarget > 0.35;
    if (!wanted) {
      this.stallTicks[u.id] = 0;
      return;
    }
    if (Math.sqrt((u.x - beforeX) * (u.x - beforeX) + (u.z - beforeZ) * (u.z - beforeZ)) > STALL_EPS) {
      this.stallTicks[u.id] = 0;
      return;
    }
    if (++this.stallTicks[u.id] < STALL_TICKS) return;
    this.stallTicks[u.id] = 0;
    if (u.waypoints.length >= 3) {
      u.targetX = u.waypoints.shift()!;
      u.targetZ = u.waypoints.shift()!;
      u.targetFacing = u.waypoints.shift()!;
      return;
    }
    if (u.order === UnitOrder.MoveTo && this.resumeRoute(u)) return;
    // Nothing left to try. Settle here rather than lean on the stone for the whole battle.
    if (u.order === UnitOrder.MoveTo) {
      u.order = UnitOrder.Hold;
      u.targetX = u.x;
      u.targetZ = u.z;
    }
  }

  /**
   * A unit has reached the end of its route without reaching its order. Plan again.
   *
   * Returns true when a new attempt is under way, so the caller leaves the order standing;
   * false when the unit has arrived, has run out of attempts, or was never routed.
   */
  private resumeRoute(u: UnitGroupState): boolean {
    const g = this.routeGoals.get(u.id);
    if (!g) return false;
    if (Math.sqrt((g.gx - u.x) * (g.gx - u.x) + (g.gz - u.z) * (g.gz - u.z)) <= ROUTE_ARRIVE_TOL) {
      this.routeGoals.delete(u.id);
      return false;
    }
    // A search is already in flight for this unit. Keep the order alive and wait for it
    // rather than spending another attempt on the same question.
    if (this.pendingRoutes.has(u.id)) return true;
    if (this.tickCount < g.nextTick) return true;
    if (g.tries <= 0) {
      this.routeGoals.delete(u.id);
      return false;
    }
    g.tries--;
    g.nextTick = this.tickCount + RESUME_COOLDOWN;
    this.requestRoute(u, g.gx, g.gz, g.facing);
    // `requestRoute` short-circuits and queues nothing when the straight line is now clear
    // — the unit has moved, so it often is — in which case simply finish the job.
    if (!this.pendingRoutes.has(u.id)) {
      u.targetX = g.gx;
      u.targetZ = g.gz;
      u.targetFacing = g.facing;
    }
    return true;
  }

  /**
   * Take charge of an attacking unit's destination when it cannot walk straight at its
   * quarry. Returns true when it has set `targetX/targetZ` itself.
   *
   * An attack is a move order with a destination that keeps moving, and it needs the
   * pathfinder for exactly the same reason a move does. It never had it: `applyOrder` set
   * `AttackUnit` and the aim above pointed the anchor at the enemy's front rank every
   * tick, wall or no wall. The player's words were "when I select them to try to attack an
   * enemy they do try to walk to that enemy in a straight line, which could be through the
   * wall".
   *
   * While a route is being followed this leaves the waypoint queue alone. It only re-checks
   * the direct line every `ATTACK_REROUTE_TICKS`, because a formation that re-plans every
   * tick never commits to a leg, and because the check costs a corridor trace.
   */
  private steerAttack(u: UnitGroupState, ax: number, az: number): boolean {
    const nav = this.nav;
    if (!nav) return false;
    this.growUnitScratch(u.id + 1);
    const due = this.tickCount - this.attackRouteAt[u.id] >= ATTACK_REROUTE_TICKS;

    if (u.waypoints.length > 0) {
      // Following a route. Abandon it the moment the quarry is in the open ahead — the
      // detour exists to get round something, and holding it after that reads as the unit
      // ignoring an enemy it could simply walk at.
      if (due) {
        this.attackRouteAt[u.id] = this.tickCount;
        if (nav.directRouteClear(u.x, u.z, ax, az, ROUTE_RADIUS)) {
          u.waypoints.length = 0;
          this.pendingRoutes.delete(u.id);
          return false;
        }
      }
      return true;
    }

    if (nav.directRouteClear(u.x, u.z, ax, az, ROUTE_RADIUS)) {
      this.pendingRoutes.delete(u.id);
      return false;
    }
    // Blocked. Walk as far up the straight line as the ground allows, and ask for a route.
    if (due) {
      this.attackRouteAt[u.id] = this.tickCount;
      this.requestRoute(u, ax, az, u.targetFacing);
      return true;
    }
    this.holdShortOfSolid(u, ax, az);
    return true;
  }

  /** Direction pointing away from the nearest enemy mass. */
  private threatDirection(u: UnitGroupState): { x: number; z: number } {
    let ex = 0;
    let ez = 0;
    let n = 0;
    for (const o of this.units) {
      if (o.destroyed || o.faction === u.faction) continue;
      const d = Math.sqrt((o.x - u.x) * (o.x - u.x) + (o.z - u.z) * (o.z - u.z));
      if (d > 220) continue;
      const w = 1 / Math.max(12, d);
      ex += (o.x - u.x) * w;
      ez += (o.z - u.z) * w;
      n++;
    }
    if (n === 0) return { x: 0, z: -1 };
    const l = Math.sqrt(ex * ex + ez * ez) || 1;
    return { x: -ex / l, z: -ez / l };
  }

  /** Refresh living count, prune the dead from the roster, and check for destruction. */
  private updateUnitCohesion(u: UnitGroupState): void {
    const p = this.pool;
    let alive = 0;
    let sumY = 0;
    for (const i of u.members) {
      if (!isAlive(p.state[i] as SoldierState)) continue;
      alive++;
      sumY += p.y[i];
    }
    u.alive = alive;
    this.growUnitScratch(u.id + 1);
    // Mean foot height of the living, used by the formation-contact test. A mean rather
    // than a sample because a unit half-across a boarding ramp is genuinely spread over
    // the two levels, and either endpoint alone would lie about it.
    if (alive > 0) this.unitY[u.id] = sumY / alive;

    if (alive === 0 && !u.destroyed) {
      u.destroyed = true;
      this.ctx.events.emit('unitDestroyed', { unitId: u.id, faction: u.faction });
      return;
    }
    // A routed unit leaves the field once it is genuinely out of the fight. Requiring it
    // to reach the map edge (±1280 m) took over three minutes of flight at 4.4 m/s, so
    // broken units loitered mid-field for the rest of the battle and the engagement never
    // resolved. "Escaped" is better defined as distance from the nearest enemy: a unit
    // 260 m clear with nobody chasing it has left the battle in every sense that matters.
    if (u.order === UnitOrder.Rout && u.routTimer > 18) {
      const edge = Math.abs(u.x) > 1180 || Math.abs(u.z) > 1180;
      let nearestEnemy = Infinity;
      for (const o of this.units) {
        if (o.destroyed || o.faction === u.faction || o.order === UnitOrder.Rout) continue;
        const d = Math.sqrt((o.x - u.x) * (o.x - u.x) + (o.z - u.z) * (o.z - u.z));
        if (d < nearestEnemy) nearestEnemy = d;
      }
      if (edge || nearestEnemy > 260) {
        u.destroyed = true;
        // Its men have quit the field, so retire them from the simulation rather than
        // leaving them alive-but-unsteered. `steerSoldiers` skips destroyed units, so
        // without this the unit's anchor stops tracking its men — one unit's anchor was
        // measured 770 m away from where its soldiers actually were — while 2,220 living
        // men stayed in the spatial hash and in every faction strength tally.
        for (const i of u.members) {
          if (p.aliveAt(i)) p.setState(i, SoldierState.Dead);
        }
        u.alive = 0;
        this.ctx.events.emit('unitDestroyed', { unitId: u.id, faction: u.faction });
      }
    }
  }

  /**
   * Re-decide which man holds which slot, when the shape has moved out from under them.
   *
   * `src/sim/reform.ts` has the argument and the measurements; this is the trigger. Two
   * things can invalidate an assignment and they are unrelated: the block turned, or the
   * block changed shape (a new formation, a new frontage, or men lost so the lattice is a
   * different size). Neither is common, so the normal cost of this is two compares per unit
   * per tick and nothing else.
   *
   * ## Three units it deliberately does not touch
   *
   * **A unit in contact.** A man in melee is bounded to `MELEE_FOOTING` of his dressed slot,
   * so moving his slot moves him — and re-labelling a fighting line mid-fight would drag men
   * across a seam they are holding. The marks are *not* updated in that case, on purpose, so
   * the moment the unit breaks off it re-forms once against everything that changed while it
   * was busy, which is the same minimal-travel solve it would have made all along.
   *
   * **A unit the elevation owner has.** Its men are not in a formation in any sense this
   * code understands — `Siege` writes their world slots off the stonework — and the caller
   * has already sent them to `steerToSlots`.
   *
   * **A battery.** `UnitRenderSystem` reads `p.slot` to decide which engine a man crews and
   * where he stands at it, so renumbering a battery would have crews swapping machines. One
   * pool slot is a crewman at a station, not a place in a rank, and this has nothing useful
   * to say about it.
   */
  private maybeReform(u: UnitGroupState, def: UnitTypeDef, sinF: number, cosF: number): void {
    if (def.unitClass === 'artillery') return;
    const id = u.id;
    this.growUnitScratch(id + 1);
    // Width and lattice size, packed. Both are small integers, so the sum is exact and a
    // change in either is a change in the number. A change of *formation* comes in through
    // `setFormation`, which clears the mark: the id is a string and does not belong here.
    const shape = u.width * 65536 + u.members.length;
    const turned = !(Math.abs(wrapAngle(u.facing - this.reformFacing[id])) < REFORM_ANGLE);
    if (!turned && this.reformShape[id] === shape) return;
    // Not while the block is still turning, and not while it is fighting. Both leave the
    // marks alone on purpose, so the solve happens once, on the tick the reason to wait
    // goes away, against the frame the shape has actually settled on. Re-solving *during*
    // a turn is worse than not re-solving at all: the intermediate frames of a rotating
    // block sort a 29-wide line into 24 rows of 6, and a man handed a place in that is
    // handed a place on the far side of his own unit for a third of a second.
    if (u.contactLock || this.turningInPlace[id] === 1) return;
    this.reformFacing[id] = u.facing;
    this.reformShape[id] = shape;
    assignSlots(this.pool, u.members, formation(u.formationId), u.x, u.z, cosF, sinF,
      u.width, ranksFor(u.members.length, u.width), u.spacingX, u.spacingZ);
  }

  /**
   * Turn a standing formation about its own centre rather than about its anchor.
   *
   * `formation.offset` puts rank 0 at `z = 0` and every rank behind it at negative z, so
   * `u.x, u.z` is the **middle of the front rank**. Rotating the lattice about that point
   * swings the whole body around it: measured before this existed, a 160-man cohort ordered
   * to stand still and face the other way finished with its centroid **4.75 m** from where
   * it started and its along-facing extent moved from -5.21..0.10 to -0.16..5.28 — the slab,
   * forward by its own depth, having been told only to turn round.
   *
   * The owner's spec is that "the block keeps its footprint", so the anchor is moved along
   * the arc that keeps the lattice's own centre where it is. `targetX/targetZ` and the hold
   * point go with it, because the unit has not been told to be anywhere else and leaving
   * them behind would make it walk back to a destination it never left.
   *
   * The front rank ends up where the rear rank was. That is the point: the front rank
   * becomes the rear rank by *facing*, and no man has to march to make it true.
   */
  private pivotAboutCentre(u: UnitGroupState, was: number): void {
    const slots = u.members.length;
    if (slots < 2) return;
    const f = formation(u.formationId);
    formationCentroid(f, slots, u.width, ranksFor(slots, u.width), u.spacingX, u.spacingZ, SCRATCH);
    if (SCRATCH.x === 0 && SCRATCH.z === 0) return;
    const s0 = Math.sin(was);
    const c0 = Math.cos(was);
    const s1 = Math.sin(u.facing);
    const c1 = Math.cos(u.facing);
    // The lattice centre in the world, before and after, must be the same point.
    const dx = (SCRATCH.x * c0 + SCRATCH.z * s0) - (SCRATCH.x * c1 + SCRATCH.z * s1);
    const dz = (-SCRATCH.x * s0 + SCRATCH.z * c0) - (-SCRATCH.x * s1 + SCRATCH.z * c1);
    u.x += dx;
    u.z += dz;
    u.targetX += dx;
    u.targetZ += dz;
    this.growUnitScratch(u.id + 1);
    if (this.holdSet[u.id]) {
      this.holdX[u.id] += dx;
      this.holdZ[u.id] += dz;
    }
  }

  /** Drive each soldier toward his formation slot. */
  private steerSoldiers(dt: number): void {
    const p = this.pool;
    const owner = this.elevation;
    for (const u of this.units) {
      if (u.destroyed) continue;
      const def = this.typeOf(u);
      // A unit on a structure is not in a formation in any sense this code understands:
      // its men stand in a line dictated by the stonework, broken at every tower, and
      // stepping between bays. `Siege` has already written each man's world slot.
      if (owner !== null && owner.ownsUnit(u.id)) {
        this.steerToSlots(u, def, dt);
        continue;
      }
      const f = formation(u.formationId);
      const ranks = ranksFor(u.members.length, u.width);
      const routing = u.order === UnitOrder.Rout;

      const maxSpeed = (routing ? def.runSpeed * 1.06
        : u.charging ? def.chargeSpeed
        : u.running ? def.runSpeed
        : def.walkSpeed) * f.mods.speed * (1 - u.fatigue * 0.42);
      const accel = maxSpeed * 5.5;

      const s = Math.sin(u.facing);
      const c = Math.cos(u.facing);
      // Who holds which slot, before anybody is steered at one. See `maybeReform`.
      this.maybeReform(u, def, s, c);
      // How far off his unit's heading this man dresses when he is standing still. Scaled
      // by the formation's own `dress`, so the one knob that says how geometric a shape is
      // allowed to be says it about bearings too: +-4.3 degrees for a line, +-0.9 for a
      // testudo. Without a per-man term a thousand men turn as one object, which is the
      // coherent motion `dress` exists to remove.
      const bearingSpread = f.dress * 0.5;
      // A formation in contact is a press, not a parade. Men behind the fighting line
      // close up into it, which is the only thing that fills the hole a dead
      // front-ranker leaves: on slot-seeking alone the second rank stays 1 m back, out
      // of every weapon's reach, and a unit whose front rank has been killed stops
      // fighting altogether while still nominally engaged.
      const pressing = u.contactLock && !routing;
      const pressLimit = PRESS_RANKS * u.spacingZ;
      // While an order is breaking contact, men in melee must follow their slot like
      // everyone else. Holding them made a withdraw order physically impossible: the
      // anchor crept away but every front-ranker stayed where he was, so the unit moved
      // 1.8 m in three seconds, never cleared CONTACT_EXIT, and re-locked — which is what
      // "the units would not always listen to me" was.
      // Fighting men follow their slot while the unit is breaking contact — either inside
      // the post-order window, or because its orders are actively taking it away.
      const disengaging = this.orderGrace[u.id] > 0 || this.breakingOff[u.id] === 1;
      const turning = this.turningInPlace[u.id] === 1;

      for (const i of u.members) {
        const st = p.state[i] as SoldierState;
        if (st === SoldierState.Dead || st === SoldierState.Dying) continue;
        this.standFacing[i] = u.facing + (hash01(i, 0x3f19) - 0.5) * bearingSpread;
        if (turning && st !== SoldierState.Fighting) {
          // Face first, then re-form. He is not going anywhere until the block has finished
          // turning — `integrate` is turning his body, `maybeReform` will hand him the slot
          // he is already standing on when the turn lands, and walking in the meantime is
          // walking toward a place the shape has not decided on yet. See `turningInPlace`.
          p.vx[i] = damp(p.vx[i], 0, 11, dt);
          p.vz[i] = damp(p.vz[i], 0, 11, dt);
          continue;
        }
        if (st === SoldierState.Fighting && disengaging) {
          // Break off: drop the opponent and let the state machine pick a locomotion clip,
          // so the man visibly turns and walks out instead of swinging at nothing.
          p.target[i] = -1;
          p.setState(i, u.running ? SoldierState.Running : SoldierState.Marching);
        }

        f.offset(SCRATCH, p.slot[i], u.width, ranks, u.spacingX, u.spacingZ);
        // How loosely this man dresses on his slot. See `FormationDef.dress`: the lattice
        // was exact — 0.860 m at every percentile, standard deviation 0.000 — and no amount
        // of variation in kit, stature or gait can break a lattice that is in the positions.
        // Keyed on the soldier index so two units of the same width never share a pattern.
        if (f.dress > 0) {
          SCRATCH.x += (hash01(i, 0x5d4e) - 0.5) * u.spacingX * f.dress;
          SCRATCH.z += (hash01(i, 0x2b17) - 0.5) * u.spacingZ * f.dress;
        }

        // A man locked in melee is not on a parade slot. He holds his *place* — the press
        // behind him and the crowd solver see to that — but he works on the man in front of
        // him, and where that man is standing is his own business and not the formation's.
        //
        // Until this existed he was frozen outright: `v` damped to zero the tick he acquired
        // a target, so the rectangle a cohort marched in was exactly the rectangle it fought
        // in, thirty seconds later, with the file-stripes still legible from above. That is
        // the whole of "two lines meeting stay two rectangles".
        //
        // The footing he is allowed is bounded to `MELEE_FOOTING` around his dressed slot, so
        // the line still reads as a line and nobody wanders off into the enemy mass. Within
        // that radius he closes on his own opponent to a working distance and no closer.
        if (st === SoldierState.Fighting && !disengaging) {
          this.press[i] = 0;
          let wx = 0;
          let wz = 0;
          const tgt = p.target[i];
          if (tgt >= 0 && p.state[tgt] !== SoldierState.Dead) {
            // Where he would stand if only his opponent existed: a working distance short of
            // him, along the line between them.
            const ddx = p.x[tgt] - p.x[i];
            const ddz = p.z[tgt] - p.z[i];
            const d = Math.sqrt(ddx * ddx + ddz * ddz);
            if (d > 1e-4) {
              // How close *this* man likes to work, and which way he works around his
              // opponent's shield. Both from his own hash, and both are the difference
              // between a rank closing on the enemy and a rank of men each closing on his
              // own: with one shared working distance every front-ranker leans in on the
              // same tick by the same amount, which is coherent motion added in the course
              // of removing some. A bolder man stands 0.70 of his reach off, a warier one
              // 0.96, and each circles his man one way or the other.
              const want = Math.max(0.55, def.reach * (0.70 + hash01(i, 203) * 0.26));
              const step = d - want;
              // Zero-mean across the unit, so the fighting line keeps its bulk position and
              // only loses its straightness.
              const circle = (hash01(i, 211) - 0.5) * 0.55;
              // Clamp the footing to a bounded shuffle around the dressed slot, so the
              // formation still owns where he is and he only owns the last few centimetres.
              const sx0 = u.x + SCRATCH.x * c + SCRATCH.z * s;
              const sz0 = u.z - SCRATCH.x * s + SCRATCH.z * c;
              // Along the line to his man, plus a sidestep perpendicular to it.
              let fx = p.x[i] + (ddx / d) * step - (ddz / d) * circle;
              let fz = p.z[i] + (ddz / d) * step + (ddx / d) * circle;
              const ox = fx - sx0;
              const oz = fz - sz0;
              const od = Math.sqrt(ox * ox + oz * oz);
              if (od > MELEE_FOOTING) {
                fx = sx0 + (ox / od) * MELEE_FOOTING;
                fz = sz0 + (oz / od) * MELEE_FOOTING;
              }
              const gx = fx - p.x[i];
              const gz = fz - p.z[i];
              const gd = Math.sqrt(gx * gx + gz * gz);
              if (gd > 0.01) {
                const v = Math.min(MELEE_FOOTING_SPEED, gd * 2.2);
                wx = (gx / gd) * v;
                wz = (gz / gd) * v;
              }
            }
          }
          p.vx[i] = damp(p.vx[i], wx, 9, dt);
          p.vz[i] = damp(p.vz[i], wz, 9, dt);
          continue;
        }

        if (pressing) {
          // Creep forward, but never in front of the front rank: `-SCRATCH.z` is this
          // man's own setback, so the press closes his own gap and no more. Crowd
          // separation stops him walking into the back of the man ahead.
          /*
           * Never negative.
           *
           * `-SCRATCH.z` is a man's own setback, and it is zero or positive only for the
           * *ranked* formations. Four are not ranked: `horde` carries a bulge of up to
           * `1.4 * spacingZ` plus `+-0.75 * spacingZ` of jitter, and `loose` and `skirmish`
           * carry jitter alone — so their foremost men have a slot **in front of** their own
           * anchor. Computed maxima: horde +2.19 m on foot, skirmish +3.74 m mounted,
           * loose +2.37 m mounted. `Math.min` bounds from above, so a negative result
           * bypassed `PRESS_RATE` entirely and arrived whole: those men were retargeted onto
           * the anchor line the instant the unit locked, and walked back to it — away from
           * an enemy they had not yet acquired, which is a way of never acquiring him.
           *
           * Clamping keeps the bulge at contact instead of flattening it, so it does change
           * who can reach whom in the centre files of a warband. That is a balance change,
           * not a free correction, and `tools/matchup.mjs` is the thing that says so.
           */
          this.press[i] = Math.max(0,
            Math.min(-SCRATCH.z, pressLimit, this.press[i] + PRESS_RATE * dt));
          SCRATCH.z += this.press[i];
        } else if (this.press[i] > 0) {
          this.press[i] = Math.max(0, this.press[i] - PRESS_RELAX * dt);
          SCRATCH.z += this.press[i];
        }
        let tx = u.x + SCRATCH.x * c + SCRATCH.z * s;
        let tz = u.z - SCRATCH.x * s + SCRATCH.z * c;

        // Separated, and the way home may be through a wall. Walk the unit's own trail
        // back instead of leaning on the masonry until the battle ends. Re-planned twice a
        // second and only for men who are genuinely adrift, so in a formation that is
        // holding together this costs one distance compare per man.
        // Manhattan first because it is two subtractions and never *under*-estimates the
        // real distance, so it cannot miss a straggler; the exact test then runs only for
        // the handful it lets through, instead of a square root for every man every tick.
        if (Math.abs(tx - p.x[i]) + Math.abs(tz - p.z[i]) > STRAGGLER_DIST
          && Math.sqrt((tx - p.x[i]) * (tx - p.x[i]) + (tz - p.z[i]) * (tz - p.z[i])) > STRAGGLER_DIST) {
          const now = this.tickCount * dt;
          if (now >= this.rallyUntil[i]) {
            // Phase-jittered per man from his own stable hash, so a cohort that is stranded
            // together does not re-plan in lockstep for the rest of the battle. Stable and
            // deterministic: `hash01` of the soldier index, not of anything clock-derived.
            this.rallyUntil[i] = now + RALLY_REPLAN * (0.6 + 0.8 * hash01(i, 17));
            if (this.nav && !this.nav.directRouteClear(p.x[i], p.z[i], tx, tz, SOLDIER_RADIUS)
              && this.rallyPoint(i, u, SCRATCH2)) {
              this.rallyX[i] = SCRATCH2.x;
              this.rallyZ[i] = SCRATCH2.z;
              this.rallyOn[i] = 1;
            } else {
              this.rallyOn[i] = 0;
            }
          }
          if (this.rallyOn[i] !== 0) {
            tx = this.rallyX[i];
            tz = this.rallyZ[i];
          }
        } else if (this.rallyOn[i] !== 0) {
          // Back in the block: drop the rally point so he dresses on his slot again.
          this.rallyOn[i] = 0;
        }

        const dx = tx - p.x[i];
        const dz = tz - p.z[i];
        const d = Math.sqrt(dx * dx + dz * dz);

        if (d < 0.06) {
          p.vx[i] = damp(p.vx[i], 0, 11, dt);
          p.vz[i] = damp(p.vz[i], 0, 11, dt);
        } else {
          // Arrive behaviour: ease off in the last two metres so nobody overshoots
          // and oscillates around his slot.
          const want = Math.min(maxSpeed, d * 2.6);
          const wx = (dx / d) * want;
          const wz = (dz / d) * want;
          const k = 1 - Math.exp(-(accel / Math.max(0.2, maxSpeed)) * dt);
          p.vx[i] += (wx - p.vx[i]) * k;
          p.vz[i] += (wz - p.vz[i]) * k;
        }
      }
    }
  }

  /**
   * Arrive-steer every man toward the absolute world slot the elevation owner gave him.
   *
   * The same easing as the formation path, minus everything that assumes a rectangular
   * block: no press, no rank offsets, no wheeling. A man on a wall-walk who is locked in
   * melee holds his ground exactly as he would on the flat, because a garrison that walks
   * back to its slot mid-fight steps off a 3.45 m ledge to do it.
   */
  private steerToSlots(u: UnitGroupState, def: UnitTypeDef, dt: number): void {
    const p = this.pool;
    const owner = this.elevation;
    // Men shuffling along a walkway move at a walk whatever the unit's orders say. There
    // is no room up there to run and nowhere to run to.
    const walk = def.walkSpeed * (1 - u.fatigue * 0.42);
    /**
     * A broken man who is already on the grass runs, and he is the only one who does.
     *
     * The wall keeps its walk: there is no room to run on a 3.25 m parapet and a man who
     * sprinted along one would be shoved off it. But a party that broke half way up a wall
     * stays siege-owned while any of it is on the stone — `Siege.routOffTheWall` — and
     * without this its men at the foot flee at 1.55 m/s against the 4.35 m/s a routing man
     * runs at, which is the pin this whole area has been bitten by twice. Decided per man
     * rather than per unit, because "on the wall" is a per-man fact and the unit is in three
     * places at once.
     */
    const flee = u.order === UnitOrder.Rout ? def.runSpeed * 1.06 * (1 - u.fatigue * 0.42) : 0;
    for (const i of u.members) {
      const st = p.state[i] as SoldierState;
      if (st === SoldierState.Dead || st === SoldierState.Dying) continue;
      // A siege-owned man's standing bearing is the one the stonework gave him, not his
      // unit's. Written here so `integrate` has a single rule for every man on the field;
      // the man who is actually *on* the structure keeps today's behaviour exactly, because
      // `integrate` only reads this for men with `elevated` clear.
      this.standFacing[i] = this.slotFacing[i];
      const maxSpeed = flee > 0 && owner !== null && !owner.manOnStructure(i) ? flee : walk;
      const accel = maxSpeed * 5.5;
      if (st === SoldierState.Fighting) {
        p.vx[i] = damp(p.vx[i], 0, 9, dt);
        p.vz[i] = damp(p.vz[i], 0, 9, dt);
        continue;
      }
      const dx = this.slotX[i] - p.x[i];
      const dz = this.slotZ[i] - p.z[i];
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < SLOT_ARRIVED) {
        p.vx[i] = damp(p.vx[i], 0, 11, dt);
        p.vz[i] = damp(p.vz[i], 0, 11, dt);
        // Standing at his post, a defender faces the way the wall faces, not the way he
        // last walked. `integrate` only turns a man who is actually moving, so this is
        // the only thing that aims a static garrison over the parapet.
        p.facing[i] = turnToward(p.facing[i], this.slotFacing[i], dt * 2.2);
      } else {
        const want = Math.min(maxSpeed, d * 2.6);
        const k = 1 - Math.exp(-(accel / Math.max(0.2, maxSpeed)) * dt);
        p.vx[i] += ((dx / d) * want - p.vx[i]) * k;
        p.vz[i] += ((dz / d) * want - p.vz[i]) * k;
      }
    }
  }

  /**
   * Per-man body radius for this tick, from the formation each man's unit is holding.
   *
   * Refreshed rather than cached because `setFormation` can be called from an order, an
   * ability, the tactical AI or a rally, and a stale radius is a formation that silently
   * keeps the last one's spacing. The whole pass is one fill plus the members of the units
   * that actually declare a `packRadius`, and it is skipped entirely — including the fill —
   * on the overwhelmingly common tick where nobody is in shieldwall or testudo and nobody
   * was on the previous tick either. `dirty` is what makes the *last* such tick still write
   * the defaults back.
   */
  private resolvePackRadii(n: number, dflt: number): Float32Array {
    if (this.packR.length < n) this.packR = new Float32Array(this.pool.capacity).fill(dflt);
    let any = false;
    for (const u of this.units) {
      if (u.destroyed) continue;
      if (formation(u.formationId).packRadius !== undefined) { any = true; break; }
    }
    if (!any && !this.packDirty) return this.packR;
    this.packR.fill(dflt, 0, n);
    for (const u of this.units) {
      if (u.destroyed) continue;
      const pr = formation(u.formationId).packRadius;
      if (pr === undefined) continue;
      for (const i of u.members) this.packR[i] = pr;
    }
    this.packDirty = any;
    return this.packR;
  }

  /**
   * Soft body separation. Men are pushed apart so ranks never occupy the same metre,
   * with mass deciding who yields — a horse displaces an infantryman, not the reverse.
   */
  private resolveCrowding(dt: number): void {
    const p = this.pool;
    const n = p.count;
    const radius = 0.42;
    const diameter = radius * 2;
    const packR = this.resolvePackRadii(n, radius);
    // Displacement budget, reset each tick. See `MAX_SEPARATION_STEP`.
    const used = this.sepUsed;
    used.fill(0, 0, n);
    const solids = this.masonry;
    const collide = !solids.empty;
    const hit = this.hitScratch;

    for (let i = 0; i < n; i++) {
      if (!p.aliveAt(i)) continue;
      const xi = p.x[i];
      const zi = p.z[i];
      const yi = p.y[i];
      // Half the space this man needs. A horse keeps the default whatever formation its
      // unit claims; a man in shieldwall or testudo gets his own formation's, because
      // those two ask for files closer together than two default bodies will allow. See
      // `FormationDef.packRadius`.
      const ri = this.mounted[i] ? radius : packR[i];
      // Matched to `budgetJ` below, including the mounted case: a horse in a melee is
      // still a horse and keeps the loose-body budget. Testing only `Fighting` here while
      // the neighbour side tested `mounted ? 5 : fighting ? 3 : 1` gave a mounted fighter a
      // 0.08 budget as `i` and 0.22 as `j` against the same `used[i]` counter, so once his
      // neighbours had spent the smaller figure his own correction was silently dropped.
      const budgetI = (!this.mounted[i] && p.state[i] === SoldierState.Fighting
        ? MAX_SEPARATION_FIGHTING : MAX_SEPARATION_STEP) * this.roughDrag[i];
      let pushX = 0;
      let pushZ = 0;

      this.hash.query(xi, zi, diameter, (j) => {
        if (j <= i) return;
        if (!p.aliveAt(j)) return;
        // The hash is 2D: a man on the wall-walk and a man at the foot of the masonry
        // land in the same cell. See `SAME_LEVEL_DY`.
        if (Math.abs(p.y[j] - yi) > SAME_LEVEL_DY) return;
        const dx = p.x[j] - xi;
        const dz = p.z[j] - zi;
        const d2 = dx * dx + dz * dz;
        // The broadphase still asks at the widest body on the field, because the hash cell
        // size and the query radius have to bound every pair; the *test* is the sum of the
        // two men's own radii. Two defaults sum to `radius + radius`, which is exactly the
        // `radius * 2` this used to compare against — doubling is exact in binary floating
        // point — so a field with no shieldwall and no testudo on it is bit-identical.
        const sep = ri + (this.mounted[j] ? radius : packR[j]);
        if (d2 >= sep * sep || d2 < 1e-8) return;
        const d = Math.sqrt(d2);
        const overlap = sep - d;
        const nx = dx / d;
        const nz = dz / d;
        // Split the correction by inverse mass. Mounted/foot is baked per soldier at
        // spawn: resolving the unit and then its type for both members of every
        // neighbour pair was the single most expensive thing in the tick.
        //
        // A man in melee counts as heavier, because a man in melee is *set*: feet planted,
        // shoulder behind the shield, leaning into someone. He is not a loose body to be
        // slid about by whoever walks into the back of him. Without this the front rank of
        // a formation jammed into a gate is shoved sideways by the whole weight of the
        // column behind it — measured in the Porta Flaminia carriageway at 0.202 m of
        // purely lateral movement per fighting man per second, which over a thirty-second
        // engagement is six metres of sideways wander and is exactly the "snake like
        // pattern when fighting" in the report. Two men who are both fighting still split
        // it evenly, so a contact line still gives and buckles; it is the crowd *behind*
        // that stops steering it.
        const mi = this.mounted[i] ? 5 : p.state[i] === SoldierState.Fighting ? 3 : 1;
        const mj = this.mounted[j] ? 5 : p.state[j] === SoldierState.Fighting ? 3 : 1;
        const total = mi + mj;
        const si = (overlap * (mj / total)) * 0.5;
        const sj = (overlap * (mi / total)) * 0.5;
        pushX -= nx * si;
        pushZ -= nz * si;
        // The neighbour is displaced immediately so later pairs see him where he now is —
        // Gauss-Seidel, which is what makes this converge in one pass. But it means a man
        // in a dense stack is written once per neighbour, and *that* side of the correction
        // had no bound at all: only the accumulator for `i` was clamped, so a man being
        // shoved by twenty others still moved 58 cm in a tick. Spending from a per-man
        // budget bounds both sides without changing the iteration order, so the result stays
        // deterministic and is identical whenever nothing is stacked hard enough to matter.
        // `sj` is a magnitude, never negative: `overlap` is positive by the test above and
        // both masses are positive. So no `Math.abs`, and the divide only happens on the
        // rare pair that actually exhausts the budget — this is the innermost line of the
        // whole tick and it runs a few hundred thousand times a second.
        // `mj === 3` is exactly "on foot and in melee"; see the mass term above.
        const budgetJ = (mj === 3 ? MAX_SEPARATION_FIGHTING : MAX_SEPARATION_STEP) * this.roughDrag[j];
        const uj = used[j];
        if (uj < budgetJ) {
          const room = budgetJ - uj;
          const kj = sj <= room ? 1 : room / sj;
          const jx = p.x[j] + nx * sj * kj;
          const jz = p.z[j] + nz * sj * kj;
          // The neighbour half of the Gauss-Seidel correction needs the same masonry guard
          // as a man's own accumulator, and by net displacement it needs it *more*: the
          // accumulator sums vectorially so opposite neighbours cancel, while these land
          // one at a time and do not. Guarding only the accumulator left the tunnelling
          // path open on the writes that actually move men into a gate jamb.
          if (!collide || sj * kj <= 0.01 || this.elevated[j] !== 0
            || !solids.blocked(jx, jz, p.y[j], SOLDIER_RADIUS)) {
            p.x[j] = jx;
            p.z[j] = jz;
          }
          used[j] = uj + sj * kj;
        }
      });

      // And bound this man's own accumulated correction against the same budget.
      const push2 = pushX * pushX + pushZ * pushZ;
      if (push2 > 1e-12) {
        const mag = Math.sqrt(push2);
        const room = Math.max(0, budgetI - used[i]);
        const k = mag > room ? room / mag : 1;
        /*
         * Separation is a positional write, and it was the one place in the tick that
         * could put a man somewhere solid. `integrate` collides the *velocity* step and
         * takes whatever position separation left behind as its starting point, so a man
         * shoved into a gate jamb by the column behind him began the next tick inside the
         * stone and was then dug back out at `escape`'s pace — two systems fighting over
         * the same metre, every tick, for as long as the crush lasted. And `escape` takes
         * the *shortest* way out, which for a man pushed past the middle of a wall is the
         * far side: that is a tunnelling mechanism, not just jitter. Measured in the Porta
         * Flaminia carriageway before this: men were inside masonry for 312 of every 1,000
         * man-ticks spent within 12 m of the arch, and 28 of 158 crossings of the wall
         * plane happened more than 2.23 m off the carriageway — through the jamb.
         */
        // Only worth asking when the shove is big enough to matter. A dressed formation
        // stands at 0.86 m with a 0.84 m body, so almost every man has a millimetre of
        // overlap with a neighbour every tick and testing all of them against the city
        // would cost a broadphase query per man per tick for nothing. A centimetre is the
        // line between "the rank is breathing" and "he is being pushed somewhere".
        if (collide && mag * k > 0.01 && this.elevated[i] === 0) {
          // Ask only whether the *destination* is solid, and if it is, decline to shove
          // him at all. The obvious form — handing `resolve` the whole step — takes the
          // "already inside" branch whenever he is already in stone, which is the premise
          // here, and that branch calls `escape`: it discards the requested displacement
          // and moves him up to `MAX_PUSH` = 1.1 m, five times the loose-body budget and
          // fourteen times the fighting one, off a single centimetre of intended shove.
          // `blocked` is that question and only that question — one `solidAt`, no `escape`,
          // no `Resolved` to write. Digging a man out is `integrate`'s job, once per tick,
          // against its own budget; and if the shove happens to move him *out* of stone,
          // the destination is clear, so it is applied.
          const tx2 = xi + pushX * k;
          const tz2 = zi + pushZ * k;
          if (!solids.blocked(tx2, tz2, p.y[i], SOLDIER_RADIUS)) {
            p.x[i] = tx2;
            p.z[i] = tz2;
          }
        } else {
          p.x[i] += pushX * k;
          p.z[i] += pushZ * k;
        }
        used[i] += mag * k;
      }
    }
    this.partCarcasses();
    void dt;
  }

  /**
   * Men flow round a dead elephant.
   *
   * `resolveCrowding`'s main loop skips anything `aliveAt` is false for, which is right for
   * a man — a corpse is 25 cm high and gets walked over — and wrong for four tonnes of
   * animal lying across the line of advance. Without this a Punic elephant that goes down
   * in front of its own line is a thing the whole battle marches straight through, which is
   * the same defect as the animal vanishing, one layer down.
   *
   * Deliberately *not* an entry in `ObstacleField` and *not* in the nav grid. Those are
   * static masonry, rebuilt on a generation counter, and pathing round a carcass is not
   * worth a dynamic obstacle system. Contact separation is what a player actually sees: the
   * rank in front of the body parts and closes up behind it. Note also `Obstacles.ts:206`
   * deliberately skips a box whose top is below a man's feet, so a 1.4 m carcass would have
   * been *taller* than the harbour boxes that rule exists for — a second reason to keep it
   * out of that field rather than tune the rule around it.
   *
   * Cost is one broadphase query per carcass per tick — 32 against the main loop's 8,600.
   */
  private partCarcasses(): void {
    const list = this.carcasses;
    if (list.length === 0) return;
    const p = this.pool;
    const used = this.sepUsed;
    const solids = this.masonry;
    const collide = !solids.empty;
    /**
     * The carcass gets a full allowance, not the crowd's leftovers.
     *
     * This pass runs at the end of `resolveCrowding` and shared `sepUsed` with it, so a man
     * in a dense block had already spent his whole 0.22 m on shoving his neighbours by the
     * time the one *immovable* thing in the tick got a word in, and `room <= 0` dropped his
     * correction entirely. Measured on a 57-horse squadron ordered over a body: the
     * squadron settled with riders **1.8 m inside** the animal and stayed there, because the
     * formation pull was unopposed. Nothing reads `sepUsed` after this pass, so resetting it
     * here costs one fill of a few thousand floats — under the noise floor of the tick's own
     * measurement — and re-establishes the priority that matters: a neighbour can be leaned
     * on, a dead elephant cannot. The cap still applies, so a man who wanders into the middle
     * of a body walks out of it rather than being flung.
     */
    used.fill(0, 0, p.count);

    for (let c = 0; c < list.length; c++) {
      const e = list[c];
      /**
       * Only once it is down. The fall takes about a second of sim time and the animal is
       * still on its feet for most of it, so an obstacle that appeared on the killing blow
       * would shove the rank that killed it away from a beast still standing in front of
       * them. `Dead` is exactly "the death animation has finished".
       */
      if (p.state[e] !== SoldierState.Dead) continue;
      const ex = p.x[e];
      const ez = p.z[e];
      const ey = p.y[e];
      // The same size hash `UnitRenderSystem.pushElephant` draws the animal at, so the body
      // a man is pushed out of is the body he can see.
      const size = 0.9 + p.variant[e] * 0.2;
      const half = CARCASS_HALF_LEN * size;
      const rad = CARCASS_RADIUS * size;
      // It fell along the heading it died facing; +Z is forward, matching `renderFacing`.
      const ax = Math.sin(p.facing[e]) * half;
      const az = Math.cos(p.facing[e]) * half;
      const reach = rad + SOLDIER_RADIUS;
      const reachMounted = rad + MOUNTED_RADIUS;

      this.hash.query(ex, ez, half + reachMounted, (j) => {
        if (!p.aliveAt(j)) return;
        // One animal does not shove another out of the way of a third's body: an elephant
        // is far too big for this capsule to be the right shape, and the pair would fight.
        if (this.onElephant[j] !== 0) return;
        if (Math.abs(p.y[j] - ey) > SAME_LEVEL_DY) return;
        /**
         * A horse is not a man, and this is the one place in the tick where that is a
         * *shape* rather than a mass.
         *
         * `resolveCrowding` has no per-man radius at all — one `diameter` for everybody,
         * and the only thing that distinguishes a rider is his inverse mass of 5. That is
         * right for men shoving each other, where what matters is who gives way. It is
         * wrong against a static body, where what matters is how much room the thing needs:
         * a cavalryman is drawn as a 2.4 m horse around a point with a 0.42 m keep-out, so
         * an ala ordered over a carcass rode *through* it — measured, and photographed, with
         * the barrel of the horse inside the animal while the rider's own centre was legally
         * outside it. This is the case the brief flags, and it is the only exception the
         * pass needs, so it is a second radius here and not a new field on the pool.
         */
        const r = this.mounted[j] !== 0 ? reachMounted : reach;
        // Closest point on the body's spine to this man, clamped to the segment.
        const rx = p.x[j] - ex;
        const rz = p.z[j] - ez;
        const len2 = ax * ax + az * az;
        const t = len2 > 1e-9 ? clamp((rx * ax + rz * az) / len2, -1, 1) : 0;
        const dx = rx - ax * t;
        const dz = rz - az * t;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) return;
        // Dead centre: push him out along the body's normal rather than nowhere at all.
        let nx: number;
        let nz: number;
        let overlap: number;
        if (d2 < 1e-8) {
          nx = az; nz = -ax;
          const l = Math.sqrt(nx * nx + nz * nz) || 1;
          nx /= l; nz /= l;
          overlap = r;
        } else {
          const d = Math.sqrt(d2);
          nx = dx / d; nz = dz / d;
          overlap = r - d;
        }
        // The carcass is immovable, so the man takes the whole correction — bounded by the
        // same per-tick budget as every other positional write in this tick, which is what
        // stops a man who wanders into the middle of a body being flung out of it.
        const budget = (p.state[j] === SoldierState.Fighting
          ? MAX_SEPARATION_FIGHTING : MAX_SEPARATION_STEP) * this.roughDrag[j];
        const room = budget - used[j];
        if (room <= 0) return;
        const step = Math.min(overlap, room);
        const tx = p.x[j] + nx * step;
        const tz = p.z[j] + nz * step;
        if (collide && step > 0.01 && this.elevated[j] === 0
          && solids.blocked(tx, tz, p.y[j], SOLDIER_RADIUS)) return;
        p.x[j] = tx;
        p.z[j] = tz;
        used[j] += step;
      });
    }
  }

  /**
   * True if this pool entry is a war elephant — the animal, not a man riding one.
   *
   * Published because at least two systems outside the sim have to branch on it and both of
   * them got it wrong by not being able to ask: `RagdollSystem` gave a four-tonne animal a
   * man's eight-particle skeleton, and `UnitRenderSystem` then stopped drawing the animal
   * the moment that skeleton existed.
   */
  ridesElephantAt(i: number): boolean {
    return i >= 0 && i < this.onElephant.length && this.onElephant[i] !== 0;
  }

  /** Pool indices of the elephants that have been killed, in the order they died. */
  get elephantCarcasses(): readonly number[] {
    return this.carcasses;
  }

  /**
   * Seconds of immunity from the geometric contact lock, per unit.
   *
   * A locked formation ignores its move target — that is what stops two lines walking
   * through each other. But the lock is set from front-to-front distance alone, so once a
   * unit was engaged it could never be ordered out: the player's order cleared the flag and
   * the very next tick re-set it, because the enemy was still a metre and a half away. The
   * unit went on pursuing whatever it had hold of and read as disobedient, which is exactly
   * how it was reported.
   *
   * An order now buys a window in which the lock cannot re-assert, long enough to physically
   * walk out of contact. An order is the player overriding the situation; the situation must
   * not immediately override the order.
   */
  private orderGrace!: Float32Array;
  /** 1 while a unit's current order is taking it away from the enemy it is locked with. */
  private breakingOff!: Uint8Array;

  /** 1 if this soldier is mounted. Set at spawn; read in the crowd-separation inner loop. */
  private mounted!: Uint8Array;
  /**
   * 1 if this pool entry is a war elephant rather than a man.
   *
   * One pool slot is one whole animal plus its mahout and tower crew — see `war-elephants`
   * in `roster.ts` — so several systems that are correct for a man are simply wrong here,
   * and every one of them needs to be able to ask. Baked at spawn beside `mounted` for the
   * same reason: resolving the unit and then its type inside a per-tick loop was the single
   * most expensive thing in the tick.
   */
  private onElephant!: Uint8Array;
  /**
   * Pool indices of elephants that have been killed, in the order they died.
   *
   * A four-tonne carcass is a feature of the battlefield, not a decal: `partCarcasses`
   * walks this list every tick and pushes the living out of the body. Insertion order is
   * the order `damage` was called in, which is deterministic, so the pass is too.
   */
  private readonly carcasses: number[] = [];
  /**
   * The bearing this man holds while he is standing still, radians.
   *
   * His unit's heading plus his own dressing error, written once a tick by `steerSoldiers`
   * and read by `integrate`. An array rather than a lookup because `integrate` walks the
   * pool and not the order of battle, and resolving a unit per man per tick is the single
   * most expensive shape of thing in this file — see `unitOfSoldier`.
   */
  private standFacing!: Float32Array;
  /** Metres this man has closed up into the press, forward of his formation slot. */
  private press!: Float32Array;
  /** Metres of crowd separation already spent on each man this tick. */
  private sepUsed!: Float32Array;
  /**
   * Per-man body radius, from `FormationDef.packRadius`. `packDirty` says whether the last
   * tick wrote anything but the default into it, so the fill can be skipped on the ticks
   * where no unit on the field declares one — which is most of them.
   */
  private packR!: Float32Array;
  private packDirty = false;
  /**
   * Movement multiplier from standing work under each man, refreshed once a tick.
   *
   * **Every metre a body moves on rubble is slowed, not only the metres it chose**, and
   * getting that wrong is not a matter of degree. The first version of this scaled the
   * integrator's step and left `resolveCrowding` alone — so on a half-built rampart a horse
   * advanced 7 m/s x 0.227 / 30 = 0.053 m a tick while his neighbours could still shove him
   * 0.22 m a tick. The crowd solver outran intent four to one, the squadron was squeezed
   * back out of the band, and a change meant to make a crossing *cost* something instead
   * stopped it dead: measured over twelve seeds, 187 crossings became **zero**.
   *
   * So the drag is resolved once per man per tick into this array and every positional
   * write in the tick reads it — the integrator's step and all three separation budgets.
   * One `dragAt` per living man, against the several hundred thousand pair tests the
   * innermost crowd loop runs a second, which is why this is an array and not a call.
   */
  private roughDrag!: Float32Array;
  /** True while the array holds anything but ones, so a clear happens exactly once. */
  private roughDragLive = false;

  /** Cache of soldier index -> unit, rebuilt lazily. */
  private soldierUnitCache: (UnitGroupState | undefined)[] = [];
  private unitOfSoldier(i: number): UnitGroupState | undefined {
    let u = this.soldierUnitCache[i];
    if (u && u.id === this.pool.unitId[i]) return u;
    u = this.unitById(this.pool.unitId[i]);
    this.soldierUnitCache[i] = u;
    return u;
  }

  /**
   * Resolve the standing-work multiplier for every living man.
   *
   * Cleared exactly once when the rough set empties rather than every tick, so a map with
   * no unfinished bays — which is Carthage, Pydna, and Rome once the circuit is finished —
   * costs one boolean per tick and nothing else.
   */
  private refreshRoughDrag(): void {
    const p = this.pool;
    const d = this.roughDrag;
    if (this.masonry.noRough) {
      if (this.roughDragLive) {
        d.fill(1);
        this.roughDragLive = false;
      }
      return;
    }
    for (let i = 0; i < p.count; i++) d[i] = this.masonry.dragAt(p.x[i], p.z[i]);
    this.roughDragLive = true;
  }

  private integrate(dt: number): void {
    const p = this.pool;
    const n = p.count;
    const solids = this.masonry;
    const collide = !solids.empty;
    const hit = this.hitScratch;
    for (let i = 0; i < n; i++) {
      const st = p.state[i] as SoldierState;
      if (st === SoldierState.Dead) continue;

      const ox = p.x[i];
      const oz = p.z[i];
      /**
       * Rubble is crossed at a walk.
       *
       * `roughDrag` is 1 everywhere except on standing work the city has published as
       * passable-at-a-price — today, the three bays of the Aurelian circuit still at
       * footing level. It scales the *step*, not `vx`/`vz`: writing it back would compound
       * every tick and a man who touched the pour would never get off it.
       *
       * The same multiplier is applied to all three crowd-separation budgets. It has to be:
       * see `roughDrag`, where dragging intent alone turned a 4.4x slowdown into a wall.
       *
       * Applied per man rather than to the block, which is what breaks the formation up.
       * A squadron of fifty enters the pour in line and comes out of it as a straggle,
       * because the men on the concrete are doing a quarter of the speed of the men who
       * are already past — and that is what a half-built rampart does to a charge.
       */
      const drag = this.roughDrag[i];
      let nx = ox + p.vx[i] * dt * drag;
      let nz = oz + p.vz[i] * dt * drag;

      /**
       * Masonry is solid.
       *
       * Men the siege system has placed are exempt: `elevated` covers the garrison on the
       * wall-walk, a boarding party on a tower ramp and anyone mid-crossing, and `Siege`
       * rewrites their positions in `postIntegrate` anyway — colliding them here would be
       * a fight between two systems over the same metre, which the one that runs last
       * always wins.
       *
       * The dead are exempt too: a corpse lying half in a doorway is scenery, and pushing
       * bodies around for the rest of the battle is pure cost.
       */
      if (collide && this.elevated[i] === 0 && st !== SoldierState.Dying) {
        solids.resolve(ox, oz, nx, nz, p.y[i], SOLDIER_RADIUS, hit);
        if (hit.hit) {
          nx = hit.x;
          nz = hit.z;
          // Kill the velocity into the surface, keep the component along it. Without this
          // a man walks at a wall for the rest of the battle at full speed, and the
          // moment the formation clears the corner he is fired sideways.
          if (hit.blockedX) p.vx[i] = 0;
          if (hit.blockedZ) p.vz[i] = 0;
        }
      }

      p.x[i] = nx;
      p.z[i] = nz;

      // Feet stay planted; the vertical is snapped rather than simulated for the living.
      // A man on a structure is snapped to *its* surface instead of the terrain — this
      // one line is the difference between garrisoning a wall and being teleported to the
      // grass under it on the next tick.
      const ground = this.elevated[i] !== 0 ? this.support[i] : this.groundAt(p.x[i], p.z[i]);
      p.y[i] = st === SoldierState.Dying ? Math.max(ground, p.y[i] - 1.8 * dt) : ground;

      // Face the direction of travel, but only once actually moving.
      const speed = Math.sqrt(p.vx[i] * p.vx[i] + p.vz[i] * p.vz[i]);
      if (speed > 0.22 && st !== SoldierState.Fighting) {
        const want = Math.atan2(p.vx[i], p.vz[i]);
        p.facing[i] = turnToward(p.facing[i], want, dt * 7.5);
      } else if (this.elevated[i] === 0
        && st !== SoldierState.Fighting && st !== SoldierState.Staggered
        && st !== SoldierState.Dying && st !== SoldierState.Climbing) {
        /*
         * And turn on the spot when he is not.
         *
         * This branch did not exist, and its absence is half of "they would not turn around
         * to face". A man's heading was written in one place — the line above — so a man who
         * was not walking never turned, and a formation could only come to face a new way by
         * every man in it walking somewhere. Measured on a cohort ordered to about-face and
         * left for thirty seconds: the *unit* heading was 0.0 degrees off the order and the
         * men a median of 75.6 degrees off it, having walked 20 m each to get there.
         *
         * The rate is per man, from his own stable hash. A thousand men turning at one rate
         * on one tick is the same coherent motion `FormationDef.dress` exists to remove, and
         * it would be a new instance of it introduced in the course of fixing another.
         *
         * `elevated` is excluded: `steerToSlots` already aims a garrison over its parapet
         * and two systems turning the same head is a fight neither wins.
         */
        const rate = STAND_TURN_RATE * (1 + (hash01(i, 0x6b2d) - 0.5) * STAND_TURN_SPREAD);
        p.facing[i] = turnToward(p.facing[i], this.standFacing[i], dt * rate);
      }
      // Lean into acceleration for weight.
      const targetLean = clamp(speed * 0.055, 0, 0.16);
      p.lean[i] = damp(p.lean[i], targetLean, 6, dt);
    }
  }

  /**
   * Choose a melee clip for a man who is fighting.
   *
   * Every fighting man used to play `AttackThrust`, which meant a thousand-man melee was
   * a thousand identical underarm stabs — and it left `AttackOverhead`, `AttackSlash`,
   * `ShieldBash`, `Block` and `Parry` authored, baked and never once selected.
   *
   * The choice is driven by the weapon, because the weapon really does dictate the
   * stroke: a gladius behind a scutum is a short thrust into the gap, a Germanic axe or a
   * long spatha is swung overhead, and a spear is levelled. Within that, the man's stable
   * per-man hash picks a variant so neighbours differ, and men who are engaged but not
   * currently swinging defend instead of attacking — which is what actually happens in a
   * press, and what makes a line read as fighting rather than as a row of windmills.
   */
  private meleeClipFor(i: number): Clip {
    const p = this.pool;
    const u = this.unitOfSoldier(i);
    const weapon = u ? this.typeOf(u).appearance.weapon : 'gladius';
    const v = p.variant[i];

    // Only a fraction of an engaged rank is mid-stroke at any instant; the rest are
    // covering, recovering or shoving. `attackCooldown` is the sim's own notion of that.
    const swinging = p.attackCooldown[i] <= 0.42;
    if (!swinging) {
      // Split the non-swinging men between a braced guard and an active parry so the
      // defensive half of the line is not uniform either.
      return v < 0.62 ? Clip.Block : Clip.Parry;
    }

    switch (weapon) {
      case 'axe':
      case 'club':
        // Overhead is the natural axe stroke; occasionally a wide slash.
        return v < 0.72 ? Clip.AttackOverhead : Clip.AttackSlash;
      case 'spatha':
        return v < 0.45 ? Clip.AttackSlash : v < 0.85 ? Clip.AttackOverhead : Clip.AttackThrust;
      case 'spear':
      case 'pike':
        // A spear is thrust, always — a levelled point is the whole reason to carry one.
        return Clip.AttackThrust;
      case 'gladius':
      default:
        // Shield-forward fighting: mostly the short thrust, with the boss used as a
        // weapon often enough to see it happen.
        return v < 0.68 ? Clip.AttackThrust : v < 0.86 ? Clip.ShieldBash : Clip.AttackSlash;
    }
  }

  /** Pick the clip each soldier should be playing and advance its playhead. */
  private updateAnimationState(dt: number, ctx: EngineContext): void {
    const p = this.pool;
    const n = p.count;

    for (let i = 0; i < n; i++) {
      const st = p.state[i] as SoldierState;
      p.stateTime[i] += dt;

      if (st === SoldierState.Dead) continue;

      let clip: Clip;
      let rateScale = 1;
      const speed = Math.sqrt(p.vx[i] * p.vx[i] + p.vz[i] * p.vz[i]);

      switch (st) {
        case SoldierState.Dying:
          clip = (Clip.DeathBack + (p.deathVariant[i] % 4)) as Clip;
          break;
        case SoldierState.Fighting:
          clip = this.meleeClipFor(i);
          break;
        case SoldierState.Bracing:
          clip = Clip.IdleBrace;
          break;
        case SoldierState.Routing:
          clip = Clip.Flee;
          rateScale = clamp(speed / 4.2, 0.7, 1.5);
          break;
        case SoldierState.Charging:
          clip = Clip.Charge;
          rateScale = clamp(speed / 5.0, 0.75, 1.4);
          break;
        case SoldierState.Throwing:
          clip = Clip.ThrowPilum;
          break;
        case SoldierState.Shooting:
          clip = Clip.ReleaseBow;
          break;
        case SoldierState.Staggered:
          clip = Clip.Stagger;
          break;
        case SoldierState.Climbing:
          // Both `SoldierState.Climbing` and `Clip.ClimbLadder` were authored, baked and
          // never once selected, because nothing in the game could put a man on a ladder.
          // The siege system's crossings now can.
          clip = Clip.ClimbLadder;
          break;
        default: {
          if (speed > 2.6) {
            clip = Clip.Run;
            rateScale = clamp(speed / 3.6, 0.75, 1.45);
          } else if (speed > 0.28) {
            clip = Clip.March;
            rateScale = clamp(speed / 1.55, 0.6, 1.5);
          } else {
            const u = this.unitOfSoldier(i);
            const pose = u ? formation(u.formationId).idlePose : 'alert';
            clip = pose === 'brace' ? Clip.IdleBrace : pose === 'relaxed' ? Clip.IdleRelaxed : Clip.IdleAlert;
          }
        }
      }

      if (p.animClip[i] !== clip) {
        p.animPrevClip[i] = p.animClip[i];
        p.animPrevTime[i] = p.animTime[i];
        p.animBlend[i] = 0;
        p.animClip[i] = clip;
        // Locomotion clips resume mid-cycle so a stop-start never resets the gait.
        p.animTime[i] = clip === Clip.March || clip === Clip.Run ? p.animTime[i] : 0;
      }

      // Cross-fade over ~0.18 s.
      if (p.animBlend[i] < 1) p.animBlend[i] = Math.min(1, p.animBlend[i] + dt / 0.18);

      const loop = st !== SoldierState.Dying;
      const adv = dt * p.animRate[i] * rateScale;
      p.animTime[i] += adv;
      if (loop) {
        if (p.animTime[i] >= 1) p.animTime[i] -= Math.floor(p.animTime[i]);
      } else if (p.animTime[i] >= 1) {
        p.animTime[i] = 1;
        // Death animation finished — become a corpse.
        p.state[i] = SoldierState.Dead;
      }
      p.animPrevTime[i] = (p.animPrevTime[i] + adv) % 1;
    }
    void ctx;
  }

  /**
   * Lethal blows this battle for which a unit was named as the killer and refused the credit
   * because the man who fell was one of its own. Diagnostic; nothing reads it back into the
   * sim. It should be zero, and a probe that finds it climbing has found a real regression.
   */
  private friendlyCredit = 0;
  get creditRefused(): number {
    return this.friendlyCredit;
  }

  /**
   * Apply damage to a soldier. Returns true if the blow was lethal.
   * The combat subsystem calls this; it is the single place a man can die.
   */
  damage(i: number, amount: number, fromX: number, fromZ: number, attackerUnitId: number): boolean {
    const p = this.pool;
    if (!p.aliveAt(i)) return false;
    p.hp[i] -= amount;
    p.grime[i] = clamp01(p.grime[i] + amount * 0.004);
    if (p.hp[i] > 0) return false;

    const dx = p.x[i] - fromX;
    const dz = p.z[i] - fromZ;
    const l = Math.sqrt(dx * dx + dz * dz) || 1;
    p.deathDirX[i] = dx / l;
    p.deathDirZ[i] = dz / l;
    p.setState(i, SoldierState.Dying);
    p.vx[i] = (dx / l) * 1.4;
    p.vz[i] = (dz / l) * 1.4;
    p.target[i] = -1;

    /**
     * **Nobody is credited with killing his own man**, at the one door every caller comes
     * through rather than at each caller in turn.
     *
     * `Projectiles` already refuses to name a killer for a friendly casualty by passing -1,
     * and that is the stronger statement and should stay — it also skips `killPulse` and
     * `noteWallKill`, so a shot into one's own file buys nothing at all. This is the backstop
     * underneath it, and the reason it is here rather than repeated at four melee call sites
     * is that the rule belongs to `kills`, not to whoever happens to be swinging.
     *
     * Melee cannot reach it today and that was measured, not assumed: `acquireVisit` and
     * `trampleVisit` are the only two things that ever hand `Combat` a victim, and both reject
     * `p.faction[j] === own` before scoring. Wrapping this method in the page over three
     * battles — the Rome assault, the Carthage assault and the Campus Martius, 662 s of sim —
     * records **2,781 lethal blows, of which 1,889 were melee, and not one same-faction
     * credit**; the only uncredited deaths are the 46 the missile path deliberately gives to
     * nobody. So this comparison changes no number in the game as it stands. `creditRefused`
     * is here so that stays checkable rather than becoming folklore.
     */
    const killer = this.unitById(attackerUnitId);
    if (killer) {
      if (killer.faction !== p.faction[i]) killer.kills++;
      else this.friendlyCredit++;
    }

    // A dead elephant is scenery with mass. Registered here rather than off `soldierDied`
    // because this is the one door into `Dying` and the list has to stay in kill order.
    if (this.onElephant[i] !== 0 && this.carcasses.length < CARCASS_MAX) this.carcasses.push(i);

    this.ctx.events.emit('soldierDied', {
      x: p.x[i], y: p.y[i], z: p.z[i],
      unitId: p.unitId[i], faction: p.faction[i], index: i,
    });
    return true;
  }

  /** Break a unit. Idempotent. */
  rout(u: UnitGroupState): void {
    if (u.order === UnitOrder.Rout || u.destroyed) return;
    u.order = UnitOrder.Rout;
    u.routTimer = 0;
    u.targetUnitId = -1;
    u.waypoints.length = 0;
    const p = this.pool;
    for (const i of u.members) {
      if (p.aliveAt(i)) p.setState(i, SoldierState.Routing);
    }
    this.ctx.events.emit('unitRouted', { unitId: u.id, faction: u.faction });
  }

  /**
   * Bring a broken unit back into order. The counterpart to `rout`, called by the morale
   * system once a routed unit has got clear, recovered its nerve and is not being chased.
   */
  rally(u: UnitGroupState): void {
    if (u.destroyed || u.order !== UnitOrder.Rout) return;
    u.order = UnitOrder.Hold;
    u.routTimer = 0;
    u.contactLock = false;
    u.charging = false;
    u.targetX = u.x;
    u.targetZ = u.z;
    const p = this.pool;
    for (const i of u.members) {
      if (p.aliveAt(i)) p.setState(i, SoldierState.Idle);
    }
    // Re-form on the spot rather than teleporting back to the line.
    this.setFormation(u, u.formationId);
    this.ctx.events.emit('unitRallied', { unitId: u.id, faction: u.faction });
  }

  /** Units of a faction that are still fighting. */
  activeUnits(faction?: Faction): UnitGroupState[] {
    return this.units.filter(
      (u) => !u.destroyed && (faction === undefined || u.faction === faction) && u.order !== UnitOrder.Rout
    );
  }

  /** Interpolated render position for a soldier, using the frame's `alpha`. */
  renderPos(i: number, alpha: number, out: { x: number; y: number; z: number }): void {
    const p = this.pool;
    out.x = p.px[i] + (p.x[i] - p.px[i]) * alpha;
    out.y = p.py[i] + (p.y[i] - p.py[i]) * alpha;
    out.z = p.pz[i] + (p.z[i] - p.pz[i]) * alpha;
  }

  renderFacing(i: number, alpha: number): number {
    const p = this.pool;
    return p.prevFacing[i] + wrapAngle(p.facing[i] - p.prevFacing[i]) * alpha;
  }

  preRender(): void {
    this.siege.preRender();
  }

  dispose(): void {
    this.siege.dispose();
  }
}
