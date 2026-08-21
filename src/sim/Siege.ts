import * as THREE from 'three';
import type { EngineContext } from '../core/Engine';
import type { BattleSystem, ElevationOwner } from './BattleSystem';
import { NO_SUPPORT } from './BattleSystem';
import type { ProjectileSystem } from './Projectiles';
import { SoldierState, UnitOrder, type UnitGroupState } from './types';
import { modsOf } from './combatShared';
import { clamp, lerp } from '../util/math';
import { hash01, Rng } from '../util/rand';
import {
  GREAT_RAM_HALF_D, GREAT_RAM_HALF_W, GREAT_RAM_REACH, GREAT_RAM_SHED_H,
  RAMP_LEN, RAM_HALF_D, RAM_HALF_W, RAM_SHED_H, RAM_TRUNK_REACH, TOWER_FLOORS, TOWER_HALF_D, TOWER_HALF_W,
  buildGreatRamShed, buildGreatRamTrunk, buildLadder, buildRamShed, buildRamTrunk,
  buildTowerDeck, buildTowerRamp, buildTowerShaft, buildTowerWheels, siegeMaterial,
} from './siegeGeometry';

/**
 * Siege warfare: garrisoning a wall, and the train that comes to take it.
 *
 * This is not an engine subsystem. It is owned and driven by `BattleSystem`, because
 * everything it does has to interleave with the soldier tick at exactly two points — once
 * before steering, to say where a man on a structure is standing and where he should
 * stand, and once after integration, to put him back on the ledge that the crowd solver
 * and the integrator have just shoved him off. A separate subsystem could only have run
 * before or after the whole of `BattleSystem`, and either way a garrison would spend every
 * other frame in mid-air.
 *
 * ## What is here
 *
 * **The spine.** The wall-walk is flattened once, at init, into a list of *stations*: a
 * position, a surface height, an outward normal and a clear standing band, every 0.86 m
 * along every bay a man could stand on, with the tower footprints cut out. Garrisoning a
 * unit is then a matter of handing it a contiguous run of stations. This is what makes a
 * garrison follow a wall that steps in height, kinks in plan, is unfinished in six places
 * and has a hole in it — none of which a formation offset function can express.
 *
 * **Crossings.** A siege tower's ramp, a ladder, the stair inside a tower: all of them are
 * one mechanism, a polyline with an arc-length parameter per man. A crossing man's
 * position is *authored* along the path rather than steered toward it, which is the only
 * way to guarantee the properties that matter — he cannot fall off, cannot be shoved off
 * by the crowd solver, and cannot teleport, because his position is a continuous function
 * of a parameter that only ever increases by `speed * dt`.
 *
 * **The train.** Siege towers, a battering ram and escalade ladders, each drawn with one
 * instanced mesh per part however many there are. Artillery machines are not here: they
 * belong to `src/units/engines.ts`, and this workstream contributes only the `onager` and
 * `carroballista` unit definitions and the stone ballistics they shoot.
 *
 * ## Determinism
 *
 * Every draw is from `battle.rng.fork('siege')` or a child of it. Nothing here reads the
 * clock or `Math.random`. Assignment order is by unit id and member index, never by
 * iteration over a `Map`'s insertion order where that could vary.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Lateral spacing of men along a wall-walk. Same as the field spacing: shoulder to shoulder. */
const STATION_PITCH = 0.86;
/**
 * Front-to-back spacing of the ranks on a walkway, metres.
 *
 * Three ranks in the 1.57 m of clear band that 3.5 m of Aurelianic curtain leaves once the
 * parapet and a man's own 0.42 m body radius are subtracted. Two ranks was the first
 * answer and it looked picketed; `reference/siege/good-picture-of-artures-on-a-wall.jpg`
 * shows a wall manned three and four deep, and that density is most of what makes a
 * garrison read as a garrison.
 *
 * 0.72 is below the 0.84 m body diameter the crowd solver enforces, which is why alternate
 * ranks are offset half a station sideways: the diagonal between a man and his neighbour
 * in the next rank is then hypot(0.43, 0.72) = 0.84 m exactly, so the solver is satisfied
 * and does not spend every tick shoving the garrison off its own slots. It is also how a
 * dense formation actually packs.
 */
const WALL_RANK_PITCH = 0.72;
/** Sideways offset applied to odd ranks so the packing interlocks. Half a station. */
const WALL_RANK_STAGGER = STATION_PITCH * 0.5;
/**
 * Most ranks a walkway will ever take.
 *
 * Five, not three. The curtain workstream widened the wall from 3.5 to 6.0 m and the clear
 * standing band with it, from 1.57 m to a measured **2.21-4.06 m** — which is four to six
 * ranks at the 0.72 m interlocking pitch. `layOutGarrison` already computes the depth the
 * band will take, so the only thing capping it at three was this constant, and the result
 * was one rank at the parapet with bare stone behind: precisely what two blind critics read
 * as "the walk has zero width".
 *
 * The player asked for a wider wall *so that more men fit on it*. Leaving this at three
 * accepted the geometry and threw away the point of it.
 */
const MAX_WALL_RANKS = 5;
/**
 * How fast a siege tower rolls, metres per second.
 *
 * Josephus has the towers at Jerusalem moved by gangs on rollers and levers; Vegetius
 * IV.17 assumes a day's work to bring one up. 0.42 m/s — a slow walking pace — crosses
 * 120 m of glacis in five minutes, which is slow enough to read as enormously heavy and
 * fast enough to happen inside a battle.
 */
const TOWER_SPEED = 0.42;
/**
 * How fast the gang can lever the machine round onto a new bearing, radians per second.
 *
 * 0.09 is a right angle in seventeen seconds, which is about as fast as sixty men with
 * levers and rollers turn a fifteen-tonne frame and slow enough that a player watching one
 * being re-aimed can see it happening.
 */
const TOWER_SLEW = 0.09;
/** Seconds a re-aimed tower stands still while its rollers are shifted. See `orderTowerTo`. */
const TOWER_HEAVE = 14;
/**
 * Inside this many metres of its bay a tower will not be turned.
 *
 * The gang is squaring the machine on the masonry by eye at that range and the ramp is about
 * to fall. Committing here is the honest half of "hard to redirect": the refusal has to bite
 * at the end of the approach, where changing your mind is most tempting and least possible.
 */
const TOWER_COMMIT = 12;
/**
 * Seconds a re-aimed ram stands still while the crew take up the poles.
 *
 * The tower's `TOWER_HEAVE` is fourteen because fifteen tonnes on rollers has to be levered
 * bodily round; a ram is a shed on four wheels with a trunk slung inside it and turning one
 * is a job for the same gang in a quarter of the time. Six seconds is still long enough that
 * a player who changes their mind at the gate watches the cost of it, which is the point of
 * having a number here at all rather than an instant pivot.
 */
const RAM_HEAVE = 6;
/**
 * How fast that gang swings the shed onto its new bearing, radians per second.
 *
 * `TOWER_SLEW` is 0.09 — a right angle in seventeen seconds. A ram is lighter and shorter in
 * the wheelbase, so 0.16 turns it in nine, and the two machines still read as different
 * weights of thing when you order them both round in the same second.
 */
const RAM_SLEW = 0.16;
/**
 * How near a gate a click has to land before a ram order means *that* gate, metres.
 *
 * Generous on purpose. The player is aiming at a gatehouse from a hundred metres up and
 * behind, the ray lands on whatever masonry is nearest the cursor, and the carriageway
 * itself is 5.2 m of a 40 m block. Carthage's three gates are 560 m apart, so 55 m cannot
 * pick the wrong one; what it can do is refuse a click that meant the curtain, which is a
 * refusal the player needs to see rather than a target the machine invents.
 */
const GATE_PICK_R = 55;
/**
 * Metres of separation two towers' dock points need before both are allowed to stand there.
 *
 * `TOWER_HALF_W` is the half-frontage, so two machines whose centres are inside four
 * half-widths of each other are drawn intersecting. The refusal exists because "send it to
 * that bay" is the one order the player can give a tower and the one answer that must never
 * be "yes, on top of the other one".
 */
const TOWER_BERTH = TOWER_HALF_W * 4;
/**
 * How near the wall a click has to land before it means the wall, metres.
 *
 * `stationNear` has no distance cap — it is a nearest-neighbour search over the whole spine
 * and it always answers — so without this a click on open grass three hundred metres from
 * the circuit resolves to "the bay at the far end" and the cursor cheerfully offers to send
 * fifteen tonnes of timber there. `wallTargetAt` is asked first and is the strict test (the
 * standing band plus `WALL_CLICK_BAND`, about 4.9 m); this is the loose one, for the case
 * the strict test rejects because the ray landed on the glacis at the foot of the masonry
 * rather than on the walk. Thirty metres is a bay's own frontage, so a click anywhere along
 * a bay's apron means that bay and a click out in the field means nothing.
 */
const MACHINE_AIM_R = 30;
/**
 * Seconds a docked tower stands with an empty file before it is **spent**.
 *
 * `TowerState.Spent` was declared and never assigned: a machine went Approach -> Docking ->
 * Landing -> Boarding and stayed at `Boarding` for the rest of the battle, whether its file
 * had crossed, died or never existed. Reported from a playtest as four towers frozen at
 * `boarding` at t+904. The cost was not cosmetic — `crewsAMachine` is true for a tower's gang
 * for ever, so the cohort that pushed it could never be given another order, `escalade`
 * skips a spent tower but not a boarding one, and the berth was never released.
 *
 * Twenty seconds rather than one tick, because the file empties and refills: the last man of
 * one cohort steps onto the ramp a few seconds before the next cohort's first man reaches the
 * mouth, and a machine that retired in that gap would drop the rest of the assault.
 */
const TOWER_IDLE_LIMIT = 20;
/**
 * Incoming missile damage a gang takes while it is working a ram, as a multiplier.
 *
 * **This is the whole reason a *testudo arietaria* has a roof, and the simulation had the
 * roof drawn and not modelled.** Measured on the Campus Martius by wrapping
 * `BattleSystem.damage` and attributing every point of it: the ram crew is 32 men at t+0 and
 * 6 by t+40, and **4,846 of the 4,846 points that killed them came from two units** —
 * `ballistarii#0` and `ballistarii#1`, shooting from 53-60 m. Rome's garrison plan puts two
 * hundred and sixteen hand-spanned crossbowmen on the curtain either side of the gate, at 62
 * damage and 40 armour-piercing a bolt, and the ram is the nearest thing on the field because
 * it spawns 62 m out while the towers start at 74-101. The machine has never once landed a
 * blow on Rome's gate — twelve runs of twelve — and this is why. On Carthage, whose garrison
 * carries a levy and slings instead, the identical machine takes **zero damage** on the
 * identical approach and batters the gate down on schedule.
 *
 * So the fix is the shed, not the ballista, and it is applied to the gang and not to the
 * machine, because what is being protected is men.
 *
 * **This comment claimed the opposite of the number for its whole life.** It read *"0.2 is a
 * shade weaker than the `testudo` formation's own 0.16"*. The constant has been 0.12 since
 * `64dfb88`, and 0.12 is *less* incoming damage than 0.16 — so a roof of hides and green
 * timber is already better cover than a roof of shields, and the proposal to take it to 0.08
 * would make it twice as good. That inverted sentence is what the proposal was being read
 * against.
 *
 * **It stays at 0.12, and the reason is that the figure it would be tuned against does not
 * exist.** `docs/tech/SIEGE.md` 5.1 pins "26 blows, the gate open at t+220" and prices
 * `0.12 -> 0.08` as restoring it. Measured at `cc72ea6` with `tools/scratch/sf-ram-emc.mjs`
 * over twelve seeds of the same battle, the blows this machine lands are
 * **0, 3, 3, 9, 19, 20, 21, 22, 23, 23, 25, 26** — median 20.5, and the gate opens on one
 * seed of twelve. 26 is the top of a wide distribution, not a schedule. The blow count is
 * `(crewRoutTime - 100) / 4.4` to within a blow on every seed, because the crew's life is the
 * only variable in it.
 *
 * And on the far side of the gate there is nothing to buy. Forcing the Porta Flaminia open at
 * t+220 on two live seeds and leaving it open for the rest of the battle
 * (`tools/scratch/sf-gate-emc.mjs`) changed **not one number**: men ever inside 60 -> 60 and
 * 99 -> 99, peak inside 42 -> 42, same verdict. The Juthungi host holds 132 m out and does not
 * use it. Until somebody walks through the gate, every constant upstream of it is decoration.
 *
 * It is also, in practice, a **Rome-only** constant. On Carthage the identical machine takes
 * *zero damage* — not "less damage", zero, attributed at `cc72ea6` with
 * `tools/scratch/so-ramkill.mjs`: `killed by: nobody, damage by: none` over 140 s including
 * forty of battering — so any multiplier applied to it is a multiplier on nothing. See
 * `GARRISON_PLANS` for why, which is where the ram's real dial turned out to be.
 */
const RAM_SHED_COVER = 0.12;
/**
 * Metres behind the machine's own tail that still count as being under its roof.
 *
 * Not a new arrangement of men: it is `musterRams`' own layout read back. That function puts
 * rows 0-3 alongside the trunk at `fz = 1.6 - row * 1.1` and every row after them behind the
 * tail at `-(halfD + (row - 3) * 0.95)`, so a full 32-man gate crew four abreast reaches
 * `RAM_HALF_D + 4 * 0.95 = 8.0 m` from the machine's centre. 4.6 clears that by 0.4 m and
 * nothing more, which is the point: it is the depth of the crew the machine has, not a radius
 * with an opinion.
 */
const SHED_COVER_REACH = 4.6;
/**
 * Units that may queue at one machine at once, crew included.
 *
 * A cap rather than a rule about who: four cohorts is already a file long enough to reach
 * back off the glacis, and without one an AI storm that keeps re-issuing move orders at a
 * bay could enrol its whole host on one bank of ladders.
 */
const MAX_BOARDING_UNITS = 4;
/** And a ram, which is lighter and has further to come. */
const RAM_SPEED = 0.55;
/** Seconds for a boarding ramp to fall from stowed to landed. */
const RAMP_FALL = 2.2;
/** Metres a man covers per second crossing a ramp or a deck. */
const CROSS_WALK = 1.35;
/** And climbing a ladder or an internal stair, which is much slower. */
const CROSS_CLIMB = 0.78;
/** Minimum gap between two men in the same crossing queue, metres. */
const CROSS_GAP = 0.78;
/** How close to the foot of a path a man must be before he may step onto it. */
const ADMIT_RADIUS = 1.6;
/**
 * What a man who is not of the party that raised the machine climbs it at.
 *
 * Anybody may go up a ladder or a boarding ramp — the alternative is a scenario deciding
 * the player's assault for them — but an escalade party has drilled at it and is equipped
 * for it, and a legionary of the line is carrying a scutum up a rung he has never seen. 0.72
 * is about forty seconds against thirty on an 8 m ladder, which is enough to be worth
 * spending the specialists first and small enough not to feel like a punishment.
 */
const ESCALADE_PACE = 0.72;
/**
 * Stations either side of the clicked one that count as "this stretch of wall" when the
 * player picks an escalade for a unit standing in the field.
 *
 * A station is a metre of curtain, so this is a twenty-metre window — about a bay. Wider and
 * a click at one end of the wall would enrol men on a ladder out of sight at the other.
 */
const ESCALADE_REACH = 20;
/** Stations either side of his slot searched for the one he is actually standing on. */
const STATION_WINDOW = 14;
/** `stationOf` for a man who has just come over the parapet and has no slot yet. */
const PENDING_SLOT = -2;
/**
 * `stationOf` for a man who is inside a tower doorway, on a stair or in a breach.
 *
 * Distinct from `PENDING_SLOT` on purpose. Both mean "not standing on a station", and every
 * consumer keys on `< 0` so both are skipped by the layout, the surface search and the
 * lateral clamp — but `adoptBoarders` claims exactly the `PENDING_SLOT` men, and a man half
 * way through a tower door is not a boarder to be adopted into a lodgement. Sharing the
 * sentinel would have deposited a man in mid-air on the far side of the wall the first time
 * a unit used a ramp and a tower pass in the same second.
 */
const ON_LINK = -3;
/** Metres of travel over which his entry position is blended onto the path. */
const ENTRY_BLEND = 1.0;
/** Seconds between blows of a ram at full crew. */
const RAM_PERIOD = 4.4;
/** Blows a gate of this construction survives. Twin oak leaves, iron-bound. */
const GATE_BLOWS = 26;
/**
 * Seconds between blows of the great ram, and the blows a curtain bay survives.
 *
 * The *testudo arietaria* at scale swings a trunk two or three times the mass of a gate
 * ram, so the crew cannot cycle it as fast — 7.0 s against 4.4 — and 3.5 m of Aurelianic
 * concrete-and-brick is not a pair of oak leaves. 74 blows at 7 s is about nine minutes of
 * battering, which is fast for masonry and slow enough that the defence has a real chance
 * to sally, burn the shed or drop a millstone on it. Vegetius IV.23 is explicit that the
 * counter to a ram is the counter-weight and the fire, not the wall.
 */
const GREAT_RAM_PERIOD = 7.0;
const WALL_BLOWS = 74;
/**
 * How far a derelict machine will look for a fresh gang, and how long it waits.
 *
 * The radius is meant to be inside the assault's own frontage, so a ram at the gate draws on
 * the storm column behind it and never on a unit that has no business being there. 40 s is
 * long enough that a momentary rout does not write the machine off and short enough that an
 * abandoned one stops being a live threat inside the span of a battle.
 *
 * **This comment said "55 m" while the constant said 95, and the gap matters.** Measured on
 * Rome's assault at ultra at `8f26f7f`: the gate crew breaks at t+210 having landed **24 of
 * the 26 blows**, and the machine stands derelict at (72, 520) two blows from opening the
 * Porta Flaminia. Inside 95 m there are three units — `tower-assault` at 12.4 m, an
 * `escalade-party` at 80.7 m, another `tower-assault` at 90.4 m — and every one of them is
 * routing at zero morale, so `recrew` refuses all three and returns false. The nearest gang
 * that would actually take the ropes is `juthungi-warband` at **123 m with 180 men at morale
 * 60**, with five more behind it at 135–179 m. Forty seconds later the ram is a wreck and
 * 1,080 fresh men are standing just outside the search that was looking for them.
 *
 * The number is deliberately left alone here rather than widened to 125. The nearest eligible
 * gang is the idle host, so moving this constant is a decision about what that host is for,
 * and that decision is the owner's and is reserved — see this workstream's report. If the
 * host is ever given a storm order it will walk past the machine anyway and this radius stops
 * mattering; if it is not, widening this alone would hand it a job by the back door.
 */
const RECREW_RADIUS = 95;
const DERELICT_LIMIT = 40;
/** Ticks a wall order may run before it is abandoned as impossible. See `advancePlans`. */
const PLAN_TIMEOUT = 30 * 60 * 10;
/**
 * Fraction of a unit's living men that must still be up on the stone for it to count as a
 * garrison when an order arrives.
 *
 * **Not a timeout, and the first attempt at this was one.** Rome: 152 men ordered down, 143
 * on the terrain, 9 still on the stone, plan open at **age 9,111** — five minutes in which
 * the unit stayed `garrisoned`, so the next order was read as a traverse and it could not be
 * sent back up. The obvious fix — end a descent that has stopped descending and give the unit
 * back — is *wrong*, and the probe said so in one line: `releaseToGround` clears `elevated`
 * and `support` for every man, so the nine still on the parapet were dropped off it at
 * **313 m/s**, and a legitimate descent that takes 106.8 s was cut off at 20.
 *
 * So the plan is left alone and the *question* is fixed instead. "Is this unit on the wall"
 * is a question about where its men are standing now, not about which map it has a record
 * in — the same distinction `standingStation` draws against an assigned station, and the same
 * one that made a 3.62 m teleport. A third is the crossing point because it is comfortably
 * clear of both cases: a cohort that has begun a descent and a cohort that has nearly
 * finished one are on opposite sides of it, and nobody falls.
 */
const ON_WALL_FRACTION = 1 / 3;
/**
 * Metres the order destination must jump before it counts as a new order.
 *
 * `trackOwnedAnchors` mirrors a siege-owned unit's centroid into `targetX/targetZ`, so the
 * value drifts by centimetres a tick as the men shuffle. A click moves it by metres. Four is
 * far above the drift and far below any order worth giving.
 */
const ORDER_JUMP = 4;

/**
 * Speed a man moves along a wall-walk while traversing between runs, m/s.
 *
 * Slower than the 1.35 m/s of a boarding ramp: a tower pass threads a doorway barely a man
 * wide and turns twice inside the chamber, and the construction steps between bays are
 * uneven. It is also what keeps a lateral redeployment feeling like a decision with a cost
 * — 35 m of curtain plus a tower is about forty seconds — rather than a teleport.
 */
const CROSS_PASS = 1.05;
/**
 * How far apart two consecutive runs' ends may be and still be linked, metres.
 *
 * A run break is one of three things: a tower (the stations stop `towerHalf + 0.55` short
 * of the tower centre on each side, so the gap across a 3.8 m half-footprint is about
 * 8.7 m), a construction step where `walkY` jumps, or a bay that carries no walkway at all.
 * The first two are crossable and the third is a hole in the wall. 14 m separates them:
 * measured, the tower gaps on this circuit run 8.3–9.4 m and the nearest unbuilt-bay gap is
 * 44 m, so the classifier has thirty metres of daylight in it.
 */
const LINK_MAX_GAP = 14;
/**
 * Height a man steps over without changing gait, metres.
 *
 * **This is the number `recut` and `buildLinks` were disagreeing about, and it is now one
 * number in one place.** `recut` severed a run when consecutive stations differed by more
 * than 0.62 m; `buildLinks` then rejoined the two halves on horizontal gap alone, having
 * computed the very same height and written `void step;` under a comment describing a
 * classifier that used it. So the wall was cut on height and sewn back together on
 * distance, and the joint between the two was a levitation: a link is a `Crossing`, an
 * authored polyline sampled by arc length, which is exactly what makes a man on it
 * unfallable — and therefore exactly what let a 7.70 m rise across 5.03 m of plan be a way
 * through. Measured on Rome at `596e03b` by `tools/scratch/probe-linkstep.mjs`: 22 of 41
 * walk-to-walk crossings bridged more than this, 11 more than a storey, 3 more than the
 * curtain is tall, and the worst of them ran 3.16 m above the surface
 * `CitySystem.walkableTopAt` reports at its own mouth.
 *
 * `advanceQueue` was not *quite* walking him up it at strolling pace — `segmentAt` has a
 * per-leg steepness test and puts anything over 36.9 degrees on `CROSS_CLIMB` with the
 * climbing clip, so the 57 degree leg was crossed at 0.78 m/s. That is the difference
 * between a man strolling up a wall and a man climbing one hand over hand with nothing
 * under his feet, and it is not a defence of either.
 *
 * Both files now ask `stepAcross` instead, and it is the same call with the same two
 * arguments. 0.62 m is a high step but a possible one; keeping the old value is deliberate,
 * because moving it would change which runs exist as well as which are joined, and only one
 * of those two is this pass's business.
 */
const WALK_STEP_OVER = 0.62;
/**
 * Steepest flight a man may be walked up, as rise over plan run.
 *
 * 0.31 m of rise on 0.34 m of going, which is not a number invented here: it is
 * `STAIR_SLOPE` inverted, and it is the pair `wall.ts` lays every tread of the tower flight
 * out from (`treads = ceil(rise / 0.31)`, `going = min(0.34, ...)`). A crossing steeper than
 * this cannot be built out of the stairs this project builds stairs from, so there is no
 * stone under it and it is not a way through.
 *
 * **A height alone cannot answer this and the two circuits prove it in opposite
 * directions.** Carthage joins two walks 2.00 m apart across a 7.32 m tower — a 15 degree
 * ramp any man walks — and also two walks 1.50 m apart across 1.30 m of plan, which is 49
 * degrees and which `CitySystem.walkableTopAt` says runs 0.91 m *inside the masonry*. A cap
 * of `STAIR_STEP_OVER = 1.2 m` refuses both; this refuses the second and keeps the first.
 * See `stepAcross`.
 *
 * **This is the third pitch-shaped threshold in the file and the three are now ordered, on
 * purpose.** `WALK_STEP_OVER` says when a joint stops being level; `segmentAt`'s
 * `dy / len > 0.6` — a *sine*, so 36.9 degrees, not the 31 it reads like — says when a leg
 * stops being walked and becomes `CROSS_CLIMB` with the climbing clip; and this says when
 * there stops being stone. Walk, climb, nothing, in that order and with daylight between
 * them, so every flight this admits steeper than 36.9 degrees is already climbed rather than
 * strolled. No fourth pace was added here, deliberately: a second opinion about how fast a
 * man goes up a slope is the same class of defect as the one being fixed.
 */
const FLIGHT_PITCH = 0.31 / 0.34;
/** Farthest a click may be from the wall's plan footprint and still mean "get on the wall". */
const WALL_CLICK_BAND = 1.7;
/**
 * Metres of ordinary walking a man will do to reach a link mouth before he is admitted.
 *
 * The mouth of a stair or a tower pass is a point on the walkway, and a man walking to it
 * is steered there by `steerToSlots` like any other slot. Only once he is inside this
 * radius does the crossing take him over, which is what stops a man on the far side of the
 * bay being snatched onto a path he has not reached.
 */
const LINK_ADMIT = 2.0;
/**
 * Lanes a practicable breach is stormed in abreast, and how wide the hole is.
 *
 * 4.5 m either side of the point of impact is a 9 m breach, which is the width a ram working
 * one spot actually brings down once the arch of the surrounding masonry gives. Five lanes
 * at 1.6 m centres is 8 m of storming front inside it — nearly twice the 4.3 m of the gate
 * carriageway, and that ratio is the entire argument for building the machine.
 *
 * `BREACH_STUB_DROP` is how far below the old walkway the rubble saddle sits. Not to ground
 * level: a breach is practicable when you can climb it, not when it is a doorway, and the
 * stub of core-work left standing is what a man goes over.
 */
const BREACH_LANES = 5;
const BREACH_HALF_W = 4.5;
const BREACH_STUB_DROP = 2.4;

/**
 * Cadence of the **synthesised fallback** stairs, in bays, and the pitch of a flight.
 *
 * These mirror `src/city/wall.ts buildTower`, which emits a stone flight on the curtain's
 * inner face when `index % 4 === 2`, with `rise 0.31` and `tread 0.34`. They are the only
 * numbers in this file that duplicate a rule owned by another workstream, and they exist for
 * exactly one reason: **the city publishes no stair record today**.
 *
 * `buildStairs` asks for `city.getWallStairs()` first and believes it absolutely when it is
 * there, never reading these again. The wall workstream is rebuilding the flights to run
 * parallel to the curtain, at which point a synthesised perpendicular flight would be men
 * walking up thin air — which is the ladder failure in a new costume. So the probe prints
 * the provenance on every run: `published` or `synthesised`. The day the API lands the
 * output changes and no line of this file does. The patch is in the report.
 */
const STAIR_MOD = 4;
const STAIR_PHASE = 2;
const STAIR_SLOPE = 0.34 / 0.31;

const MAX_TOWERS = 6;
const MAX_RAMS = 2;
const MAX_LADDERS = 24;
/** Great rams. Two is already a siege train nobody could afford twice. */
const MAX_GREAT_RAMS = 2;

// ---------------------------------------------------------------------------

const enum TowerState {
  Approach = 0,
  Docking = 1,
  Landing = 2,
  Boarding = 3,
  Spent = 4,
}

interface SiegeTower {
  id: number;
  /** Base centre, on the ground. */
  x: number;
  z: number;
  y: number;
  /** Heading: the direction the front face (-Z local) points, i.e. at the wall. */
  facing: number;
  /**
   * The heading its bay wants. Equal to `facing` except while the gang is levering it round
   * after the player has re-aimed it. See `orderTowerTo`.
   */
  wantFacing: number;
  /** Seconds the gang is still shifting rollers and will not roll the machine forward. */
  heave: number;
  /** Seconds docked with nobody left to send up. See `TOWER_IDLE_LIMIT`. */
  idle: number;
  state: TowerState;
  /** Absolute Y of the fighting deck. */
  deckY: number;
  /** Where it is trying to get to — hard against the wall face at its target station. */
  dockX: number;
  dockZ: number;
  /** Station on the spine the ramp lands at. */
  station: number;
  /** 0 stowed vertical, 1 landed. */
  ramp: number;
  /** Unit that crews it — the gang on the levers, and the first in the boarding file. */
  unitId: number;
  /**
   * Every unit allowed up it, crew first. See `stepCrossing` and `escalade`.
   *
   * A machine belongs to an army, not to one cohort. This is the list the player extends by
   * ordering another unit at the same stretch of wall.
   */
  boarders: number[];
  /** Men who have completed the crossing. */
  crossed: number;
  crossing: Crossing | null;
  /** Distance still to run, metres, for the report. */
  dist: number;
  /** Slant length the *pons* was cut to, and the pitch that lands it. See `spawnTower`. */
  rampLen: number;
  rampLanded: number;
  /** Horizontal distance from the hinge to where the lip lands, along the bay's normal. */
  rampReach: number;
}

/**
 * Which machine, and therefore what it is trying to knock down.
 *
 * The light ram goes for the gate because the gate is the one part of a circuit that is
 * made of wood. The *great* ram goes for the curtain, which is the only reason to build
 * something that heavy: you accept nine minutes of battering and a crew of eighty to make a
 * hole where the defence has not built a killing ground, instead of walking into the one
 * they have.
 */
const enum RamKind {
  Gate = 0,
  Great = 1,
}

/**
 * What a ram is doing, and — the part that matters — what it does once it has won.
 *
 * A ram that breaks a gate and then sits in the hole is the worst outcome the feature has:
 * it corks the only way in, it cannot be killed, and it cannot be moved, so an assault
 * stalls on its own success. Reported by the player in exactly those terms. Three of these
 * five states exist to make sure that cannot happen.
 *
 * `Withdrawing` is the real answer and it is also the historical one. You do not leave a
 * *testudo arietaria* standing in the gateway you have just opened; the storming column is
 * behind it and the shed is in their way. The crew haul it back off the threshold and the
 * column goes in past it. Ammianus has the Persians at Amida clearing their engines before
 * the assault went in, for the same unremarkable reason.
 */
const enum RamState {
  Approach = 0,
  Battering = 1,
  /** Hauling back out of the passage it has just opened. */
  Withdrawing = 2,
  /** Parked clear, job done. Still drawn, no longer in anybody's way. */
  Spent = 3,
  /** Crew dead or fled. A low, passable heap of burnt timber. */
  Wreck = 4,
}

interface SiegeRam {
  id: number;
  kind: RamKind;
  state: RamState;
  /** Where it hauls back to once the gate is down: clear of the threshold, on its own side. */
  parkX: number;
  parkZ: number;
  /** True once the crew are gone and the machine is a ruin rather than a weapon. */
  wreck: boolean;
  /** Seconds with nobody working it. See `DERELICT_LIMIT`. */
  derelictFor: number;
  x: number;
  z: number;
  y: number;
  facing: number;
  /**
   * The bearing the crew are levering the shed round onto, which is `facing` at rest.
   *
   * A ram used to be built pointing at its gate and never turned again, because there was
   * only ever one gate and it was chosen at spawn. The moment the player can re-aim it, a
   * shed that snapped ninety degrees on the frame of the click would read as a bug; this is
   * the same two-field arrangement the tower has had since it could be re-aimed.
   */
  wantFacing: number;
  /** Seconds the gang is still shifting poles and will not roll the machine. See `RAM_HEAVE`. */
  heave: number;
  /**
   * The gate this machine is beating on, by id, or `''` for a great ram at the curtain.
   *
   * **Never a literal.** `armGate`, `spawnRam` and the breach all used `getGates()[0]` while
   * the breach itself once said `'porta-flaminia'` out loud, and on Carthage — which has no
   * such gate — the ram landed all twenty-six blows into a carriageway that stayed solid for
   * the rest of the battle. Carrying the id on the machine is what lets three gates exist and
   * still keeps every consumer reading the same one: the blow counter, the leaves, the
   * occupancy raster and the report are all keyed off this field.
   */
  gateId: string;
  /** Recoil offset of the trunk along its own axis, metres. Negative is drawn back. */
  swing: number;
  /** Seconds until the next blow. */
  timer: number;
  arrived: boolean;
  unitId: number;
  targetX: number;
  targetZ: number;
  blows: number;
  /** For a great ram: the bay it is breaking, and the station it is squared up to. */
  bay: number;
  station: number;
}

/**
 * A stair from the ground to the wall-walk.
 *
 * Read from the city where the city publishes them and synthesised from the bays where it
 * does not — see `buildStairs`. Either way nothing here knows or cares which, because both
 * paths produce the same record and the crossing is built from the record.
 */
interface WallStair {
  /** Foot, on the ground, at the bottom of the flight. */
  footX: number;
  footZ: number;
  footY: number;
  /** Head, on the walkway. */
  topX: number;
  topZ: number;
  topY: number;
  /** Spine station the head lands on. */
  station: number;
  /** Which side of the wall the flight is on: -1 cityward, +1 outward. */
  side: -1 | 1;
  /** Clear width of the flight, metres. Only used to space the file that climbs it. */
  width: number;
  /** True when the city published it; false when this is a synthesised fallback. */
  fromCity: boolean;
}

/**
 * How two things a man can stand on are joined.
 *
 * This is the whole of "the wall is traversable terrain". A run of walkway is a place; a
 * link is the only way between two places; and a link is a `Crossing`, so every property
 * the crossing representation already guarantees — cannot fall, cannot be shoved off,
 * cannot teleport, one man at a time in file — is inherited rather than re-argued.
 */
const enum LinkKind {
  /** Through a tower chamber, from the run on one side to the run on the other. */
  TowerPass = 0,
  /** Over a construction step between two bays whose walkways are at different heights. */
  Step = 1,
  /** Ground to walkway. Traversable in both directions, which is the point. */
  Stair = 2,
  /** Through a hole the great ram made: outside ground to inside ground. */
  Breach = 3,
}

/**
 * What the stone does between two places a man can stand.
 *
 * Three answers, and they are the whole of the reconciliation between `recut` and
 * `buildLinks`: one is "keep walking", one is "this is a boundary and there is a flight over
 * it", one is "this is a boundary and there is nothing over it". `recut` cuts a run wherever
 * the answer is not `Level`; `buildLinks` bridges wherever it is not `Broken`. Neither owns
 * the predicate. See `Siege.stepAcross`.
 */
const enum Joint {
  /** A man walks it without changing gait. Not a run boundary at all. */
  Level = 0,
  /** A flight: real stone at a rake the tread module can carry, climbed rather than walked. */
  Flight = 1,
  /** Neither. No arrangement of treads reaches from one to the other. */
  Broken = 2,
}

interface WallLink {
  id: number;
  kind: LinkKind;
  /** Run at the `a` end. -1 means the ground. */
  runA: number;
  /** Run at the `b` end. -1 means the ground. */
  runB: number;
  /** Station at each end; -1 at a ground end. */
  stationA: number;
  stationB: number;
  /** Mouth of the link at each end, in world space — where a man must get to. */
  ax: number; az: number; ay: number;
  bx: number; bz: number; by: number;
  /**
   * Height the link climbs, a to b, signed. Negative is a descent.
   *
   * **This is the number that used to be `void step;`.** It is kept rather than recomputed
   * because three separate things need it and each of them recomputing `by - ay` is three
   * chances to take the absolute value in one place and not another: the pace the crossing
   * is walked at, the report, and the assertion in the probe.
   */
  rise: number;
  /** Paths, authored a->b and b->a. Built lazily, because most links are never used. */
  ab: Crossing | null;
  ba: Crossing | null;
  /** Men who have completed it, either way. For the report. */
  used: number;
  /** A breach lane is one of `BREACH_LANES` parallel copies; this is which. */
  lane: number;
}

/** What a unit has been told to do about the wall. */
const enum WallGoal {
  /** Nothing; it is a garrison standing where it stands. */
  Hold = 0,
  /** Get onto the wall at `destStation`, from the ground, via `stair`. */
  Ascend = 1,
  /** Move along the wall to `destStation`, through whatever links are between. */
  Traverse = 2,
  /** Get off the wall to (gx, gz), via `stair`. */
  Descend = 3,
  /** Storm a practicable breach: outside ground, up the rubble, down into the city. */
  Storm = 4,
}

interface WallPlan {
  goal: WallGoal;
  /** Station the unit is forming on once it arrives. */
  destStation: number;
  destRun: number;
  /** Stair index for an ascent or a descent, or -1. */
  stair: number;
  /** Ground point for a descent. */
  gx: number;
  gz: number;
  /** Ticks the plan has been running, so a stuck one can be reported rather than hidden. */
  age: number;
  /** Men this plan could not move on the last tick. Reported, never silently absorbed. */
  stuck: number;
}

interface Ladder {
  x: number;
  z: number;
  footY: number;
  /** Absolute Y of the parapet the hooks are over. */
  headY: number;
  /** Radians off vertical, solved so the head lands on the parapet. */
  lean: number;
  facing: number;
  station: number;
  crossing: Crossing | null;
  /** The party that raised it, and the first in the file. */
  unitId: number;
  /** Every unit allowed up it, that party first. See `stepCrossing` and `escalade`. */
  boarders: number[];
  crossed: number;
}

/**
 * A path men move along one at a time, in file.
 *
 * Positions are authored from the arc-length parameter rather than steered toward, which
 * is what makes "nobody falls off" a property of the representation instead of something
 * the tuning has to keep achieving.
 */
interface Crossing {
  /** Flat [x,y,z] triples. */
  pts: Float32Array;
  /** Cumulative arc length at each point, so `arc[n-1]` is the total. */
  arc: Float32Array;
  n: number;
  /**
   * Where a man who finishes the crossing ends up on the spine, or -1 if it ends on the
   * ground — which is what a stair traversed downward and a breach both do.
   */
  destStation: number;
  /** Soldier indices currently on the path, ordered from furthest along to least. */
  queue: number[];
  /**
   * Speed multiplier for the non-steep legs.
   *
   * A tower pass is threaded through a doorway and turns twice; a boarding ramp is a
   * straight run at a charge. Both are `CROSS_WALK` legs by the steepness test and they are
   * not the same movement, so the path carries its own pace.
   */
  pace: number;
}

interface Garrison {
  unitId: number;
  /** First station of this unit's run. */
  from: number;
  /** Number of stations it occupies. */
  span: number;
  ranks: number;
  /** Living count the current plan was laid out for. */
  plannedFor: number;
  /**
   * A boarding party is never re-formed.
   *
   * A defending garrison closes up along the wall as it takes losses, which is right. A
   * party coming over a ramp or a ladder must not: re-laying it every time another man
   * lands makes the whole lodgement shuffle sideways once a second, and men who are in
   * melee get told to walk out of it. They take the next free slot outward from where they
   * came over and they stay there.
   */
  sticky: boolean;
  /** Arrivals so far, for the next-free-slot cursor. */
  filled: number;
  /** Men the last layout could not fit on this run. See `layOutGarrison`. */
  overflow: number;
  /**
   * The order destination this garrison was last seen with.
   *
   * `interceptOrders` compares against it to tell a real click from the sim changing
   * `u.order` on its own. Seeded from the unit's own position, which is where
   * `trackOwnedAnchors` keeps the target while the siege system owns the unit.
   */
  lastTx: number;
  lastTz: number;
}

const TMP_M = new THREE.Matrix4();
const TMP_Q = new THREE.Quaternion();
const TMP_P = new THREE.Vector3();
const TMP_S = new THREE.Vector3(1, 1, 1);
const TMP_E = new THREE.Euler();
const TMP_C = new THREE.Color();
/** Read-back scratch for the diagnostics, kept clear of the ones `setInstance` writes. */
const TMP_R = new THREE.Vector3();

export interface CityBayView {
  index: number; x0: number; z0: number; x1: number; z1: number;
  nx: number; nz: number; dx: number; dz: number; length: number;
  walkY: number; groundY: number; crestY: number; sillY: number;
  parapetInner: number; parapetOuter: number;
  innerOff: number; outerOff: number; garrisonable: boolean; towerHalf: number;
  isGate: boolean; stage: string;
  /**
   * The clear lane cut through the tower at this bay's west end, as offsets along the
   * outward normal, or a zero-width band where there is no lane.
   *
   * Optional in the view because it is the city's to publish and a city that has not is
   * still a city; `linkPath` falls back to the cityward lip, which is where it walked men
   * before this existed. It is *not* optional in practice — both circuits publish it, and
   * without it the path is inside masonry at every tower on both of them.
   */
  passOuter?: number;
  passInner?: number;
}

/**
 * What a stair looks like when the city publishes one.
 *
 * Deliberately in world space and deliberately not a description of the geometry. The wall
 * workstream is rebuilding the flights to run *parallel* to the curtain instead of
 * perpendicular to it, and a record that said "perpendicular, 2.4 m wide, at the tower"
 * would have to be renegotiated the moment that landed. Two endpoints and a width survive
 * any arrangement of treads between them.
 */
export interface CityStairView {
  footX: number; footZ: number; footY: number;
  topX: number; topZ: number; topY: number;
  /** Optional; derived from the endpoints when absent. */
  width?: number;
  /** Optional; derived from which side of the wall the foot stands on when absent. */
  side?: number;
}

/**
 * The gatehouse as a solid, in plan — the six numbers `buildSpine` needs and no more.
 *
 * **Field-for-field a subset of `GateBlockOut` in `src/city/wall.ts`**, and it has to stay
 * that way. It is declared here rather than imported because `src/city/` imports
 * `src/sim/types` and an import the other way would close the cycle; that is also exactly
 * why nothing checks the two against each other, so the pair is registered in
 * `src/core/seams.ts` and compared against the live `CitySystem` at wiring time. If you
 * rename a field here, that check fails at boot with both name lists in the message.
 */
export interface CityGateBlockView {
  /** Centre of the carriageway, on the wall line. */
  x: number;
  z: number;
  /** Outward normal of the block, matching the bay's. */
  nx: number;
  nz: number;
  /** Along-run unit vector. */
  dx: number;
  dz: number;
  /** Half-extent along the run: the block is 2 x this long on the wall line. */
  halfRun: number;
  /** Half-extent across the run, front face to back face. */
  halfDepth: number;
  /** Absolute Y of the top of the block's battlements. */
  topY: number;
}

export interface CityView {
  getGarrisonBays(): readonly CityBayView[];
  getGates(): { id: string; x: number; z: number; facing: number; open: boolean }[];
  setGateOpen(id: string, open: boolean): void;
  /**
   * Optional. Swaps a gate's intact leaves for the pose the ram left them in.
   *
   * Optional rather than required because it is *visual only* — it writes no raster, no
   * obstacle and no `GateOut` — so a city that has not baked a wrecked twin is a gate that
   * opens rather than a crash. Both circuits have one today.
   */
  setGateDoorBroken?(id: string, broken?: boolean): void;
  /** Optional. True once `setGateDoorBroken` has been called for this gate. */
  isGateDoorBroken?(id: string): boolean;
  /**
   * Optional. The gatehouse's own footprint and the height of its crown.
   *
   * Absent until the city workstream lands it, and `buildSpine` no-ops without it — the same
   * arrangement as `getWallStairs` and `breachWall`. What it is for: `curtainSpans` cuts the
   * curtain out where the gatehouse stands, but the spine lays a station every
   * `STATION_PITCH` along every garrisonable bay clipped only by `towerHalf`, so on Rome
   * **22 of bay 19's 36 stations stand inside the gatehouse footprint with no curtain under
   * them, 6.574 m below the crown** — and every shot they take is thrown into the block.
   */
  getGateBlock?(): CityGateBlockView | null;
  /**
   * Optional, and the whole reason the stair mechanic reads the city instead of guessing.
   *
   * Absent today. `buildStairs` synthesises a set from the bays when it is, and reports
   * which of the two it used, so the day this lands the probe's assertion goes from
   * "synthesised" to "published" without a line of this file changing.
   */
  getWallStairs?(): readonly CityStairView[];
  /**
   * Optional. Cuts a passage through the curtain where the great ram has broken it, in the
   * occupancy grid and in the oriented-box set, exactly as `setGateOpen(id, true)` does for
   * the gate. Absent today; see the patch in this workstream's report.
   */
  breachWall?(x: number, z: number, halfWidth: number): void;
}

/**
 * What kind of machine a unit's gang is working, as the UI needs to name it.
 *
 * `ram` and `greatRam` are one `SiegeRam` with two `RamKind`s in the simulation and two
 * different orders to the player: one goes at a gate and one goes at masonry, and a cursor
 * that says "break the gate" while hovering a stretch of curtain would be lying.
 */
export type SiegeMachineKind = 'tower' | 'ram' | 'greatRam';

/**
 * Why a machine order was refused, or `none` when it was not.
 *
 * Every one of these is a sentence the player has to be able to read *before* the click.
 * The tower's refusals in particular are the character of the machine — fifteen tonnes of
 * green timber is meant to be hard to redirect — but a silent refusal is not character, it
 * is a broken button, and that distinction is the whole reason this enum exists rather than
 * a bare `false`.
 */
export type SiegeRefusal =
  /** It will be obeyed. */
  | 'none'
  /** The ramp is falling or down: it is landing on the bay it is over. */
  | 'landed'
  /** Inside `TOWER_COMMIT` of its bay, where the gang is squaring it on the masonry by eye. */
  | 'committed'
  /** It is already going there. */
  | 'already'
  /** Another machine has that berth. */
  | 'taken'
  /** No stretch of wall under the cursor. */
  | 'noWall'
  /** No gate under the cursor that is still shut. */
  | 'noGate'
  /** A gate ram cannot break masonry, and a great ram is not for gates. */
  | 'wrongTarget'
  /** Wrecked, withdrawing or parked: it has no work left in it. */
  | 'spent'
  /** Nobody is pushing it. */
  | 'unmanned';

/**
 * What a right-click at a point would do to one machine — the answer to the question the
 * cursor has to ask before the player commits.
 *
 * **One predicate, shared.** `machineOrderAt` and the code that actually moves the machine
 * both call `resolveMachineOrder` and nothing else, so the hint and the order cannot
 * disagree. Three separate features in this project have now shipped a preview computed one
 * way and an action computed another, and every one of them showed up as a control that
 * looked like it worked.
 */
export interface SiegeMachineOrder {
  kind: SiegeMachineKind;
  /** Index into `towers` or `rams`. */
  machineId: number;
  /** The gang. */
  unitId: number;
  /** True when a click here will be obeyed. */
  ok: boolean;
  refusal: SiegeRefusal;
  /** Where the machine will end up standing, or where it is standing now on a refusal. */
  x: number;
  z: number;
  y: number;
  /** The station it will square up to, or -1 for a gate. */
  station: number;
  /** The curtain bay that station belongs to, or -1. */
  bay: number;
  /** The gate it will beat on, or `''`. */
  gateId: string;
  /** Metres the machine still has to roll to get there. */
  distance: number;
  /**
   * Seconds that will take, heave included.
   *
   * Published rather than left to the UI to divide, because the divisor is a property of the
   * machine and the UI does not have it. It is also the number the player most needs and
   * least expects: a playtest re-aimed a tower and measured **590 seconds** before it reached
   * the new bay, which is not a bug — 0.42 m/s is the speed a gang on levers and rollers
   * moves fifteen tonnes of green timber, and the owner asked for exactly that — but a cost
   * of ten minutes has to be quoted *before* the click, not discovered after it.
   */
  seconds: number;
}

/**
 * Whether a unit is a machine's gang, and whether that machine is still theirs to aim.
 *
 * The answer to a question the UI was asking a different function: `SiegeOrders` decided a
 * selected unit was a crew if `machineDestinationOf` gave it anything, and a tower's
 * `unitId` is never cleared, so a party that had crossed its own ramp and was standing on
 * the parapet went on being answered about the machine for the rest of the battle. See
 * `Siege.machineWithWork` for the measurement.
 */
export interface SiegeCrewStatus {
  /** They are a machine's own gang — including one whose machine has finished. */
  crew: boolean;
  /**
   * The machine still has work for them and will still take a destination from them.
   *
   * False is the interesting value: it means these men are infantry now, wherever they are
   * standing, and every order given to them is an order about men.
   */
  commands: boolean;
  kind: SiegeMachineKind | 'ladder' | null;
  /** Why it is no longer theirs to aim: `''` while it still is. */
  done: '' | 'landed' | 'spent';
}

/**
 * Is this point inside the gatehouse's plan footprint?
 *
 * Plan only, deliberately: the question `buildSpine` is asking is "is there curtain under
 * this station", and the gatehouse's answer does not depend on height — it replaces the
 * curtain for its whole footprint. Height comes back in through `topY` when a crown run is
 * laid, which is the better fix this one is holding the place for.
 *
 * **The frame is the block's own, not an angle.** This used to take `{ hw, hd, rot }` and
 * build a rotation from `rot`, and no city has ever published any of those three: the record
 * carries the along-run and outward-normal unit vectors it was built from, precisely so that
 * nothing downstream has to round-trip them through an `atan2`. The consequence of asking for
 * the wrong three was not a wrong answer, it was **no answer** — `Math.abs(...) <= undefined`
 * is `false`, so the clip reported "not inside the gatehouse" for every point on the map and
 * the feature never fired once. Measured on Rome before the rename: 22 of bay 19's 36
 * stations inside the footprint, 0 clipped.
 */
function insideBlock(b: CityGateBlockView, x: number, z: number): boolean {
  const ex = x - b.x;
  const ez = z - b.z;
  return Math.abs(ex * b.dx + ez * b.dz) <= b.halfRun
    && Math.abs(ex * b.nx + ez * b.nz) <= b.halfDepth;
}

export class Siege implements ElevationOwner {
  private battle!: BattleSystem;
  private ctx!: EngineContext;
  private city: CityView | null = null;
  private projectiles: ProjectileSystem | null = null;
  private rng = new Rng('siege');

  // ---- the wall, flattened into places to stand ----
  private sx = new Float32Array(0);
  private sz = new Float32Array(0);
  private sy = new Float32Array(0);
  private snx = new Float32Array(0);
  private snz = new Float32Array(0);
  private sOuter = new Float32Array(0);
  private sInner = new Float32Array(0);
  /**
   * Normal-offset of the outer *face* of the wall at each station, as opposed to `sOuter`,
   * which is the outward limit a man may stand at. A siege tower docks against the face and
   * a man stands well back from it, so the two are 1.3 m apart and using one for the other
   * drove four towers 0.70 m into the brickwork.
   */
  private sFace = new Float32Array(0);
  /** Absolute Y of the top of the battlement at each station. A tower deck must clear it. */
  private sCrest = new Float32Array(0);
  private sBay = new Int32Array(0);
  /**
   * Centre of the lane through the tower at this station's bay's *west* end, as an offset
   * along the outward normal, and its half-width. `sPassHalf` is 0 where there is no lane.
   *
   * Carried per station rather than looked up per link because a link's far end is always
   * the first station of the bay whose west tower it crosses, which makes this an array
   * read in a function that already has the index.
   */
  private sPassMid = new Float32Array(0);
  private sPassHalf = new Float32Array(0);
  /**
   * Which continuous run of walkway each station belongs to.
   *
   * The wall-walk is *not* one connected surface. It is broken at every tower, at every
   * unbuilt bay, and — the one that cost a measurement to find — at the construction steps
   * between bays. `walkY` is quantised in 0.55 m increments held over pairs of bays, and
   * over rolling ground two neighbouring bays can differ by far more than a man can step:
   * the joint east of the gate is a **3.62 m** drop, and a garrison laid straight across it
   * teleported men down the step the instant their slot moved past it.
   *
   * Stations are in the same run only if consecutive ones are close enough in three
   * dimensions to walk between. Nothing — garrison layout, the standing-surface search, a
   * lodgement spreading out from a ramp — may cross a run boundary.
   */
  private sRun = new Int32Array(0);
  private nStations = 0;
  /**
   * First and last station of each run, indexed by run.
   *
   * `runBounds` used to walk outward from a station comparing run ids, which is O(run
   * length) and ran twice for every garrisoned man every tick — 810 men times a mean run of
   * 38 stations. Precomputing it is the difference between 62,000 comparisons a tick and two
   * array reads, and the wall does not move.
   */
  private runLo = new Int32Array(0);
  private runHi = new Int32Array(0);
  private nRuns = 0;
  /**
   * 1 where the great ram has brought the walkway down. A dead station is not a place to
   * stand and not a place to walk through, so it splits its run in two.
   */
  private sDead = new Uint8Array(0);
  /**
   * Which unit holds each station, or -1. The ledger behind "the run you want is occupied":
   * a garrison laying out along a run takes the free window and no more.
   */
  private sOwner = new Int32Array(0);

  // ---- the wall as a graph ----
  private stairs: WallStair[] = [];
  private links: WallLink[] = [];
  /** Link joining run k to run k+1, or -1. Indexed by run. */
  private runNext = new Int32Array(0);
  /** Links whose foot is on the ground, by run they reach. Indexed by run; -1 if none. */
  private runStair = new Int32Array(0);
  private stairsFromCity = false;

  // ---- entities ----
  private towers: SiegeTower[] = [];
  private rams: SiegeRam[] = [];
  private ladders: Ladder[] = [];
  private garrisons = new Map<number, Garrison>();
  /** Units whose men the siege system places. Includes garrisons and boarding parties. */
  private owned = new Set<number>();
  /**
   * Machine crews this system let go of *because they broke*, and may take back on a rally.
   *
   * Distinct from "not owned" on purpose. A party leaves `owned` for two quite different
   * reasons — it has broken, or the player has ordered it down off the wall and
   * `releaseToGround` has handed it back to the field — and only the first of those should
   * be undone when the unit rallies. Without the distinction, `releaseBrokenCrews` would
   * re-adopt an escalade party the tick after it was released and steer it back to the
   * ladders it had just been ordered to leave.
   */
  private brokeOff = new Set<number>();
  /** Movement orders the player or the AI has given a unit about the wall. */
  private plans = new Map<number, WallPlan>();

  /**
   * Where a move order was actually aimed, taken off the event rather than off the unit.
   *
   * **This is the whole reason a unit on the wall could not be ordered down, and the
   * measurement is worth writing out because the symptom points nowhere near the cause.**
   * Logged live for a cohort of 108 men standing on the parapet, immediately after a real
   * `orderIssued` move event to a rally point 62 m away inside the city:
   *
   * ```
   * before-click       order Garrison  target 61.2,529.4  moved 0.07  -> G2 order===Garrison
   * after-applyOrder   order MoveTo    target 61.2,529.4  moved 0.07  -> G4 moved < ORDER_JUMP
   * tick+1..tick+8     order Garrison  target 61.2,529.4  moved 0.00  -> G2 order===Garrison
   * after-120s         onWall 108, onGround 0, goal none, stair crossings 0
   * ```
   *
   * `u.order` became `MoveTo`, so `applyOrder` plainly ran — and `u.targetX/targetZ` did not
   * move a centimetre off the unit's own anchor. That pair cannot both be true of a click
   * 62 m away, and it is `BattleSystem.holdShortOfSolid` that makes them: the anchor of a
   * garrison **is inside the curtain's footprint**, so `clearLineFraction` from it is 0, the
   * order is clamped to `u.x, u.z` as "the last point on the straight line it can legally
   * reach", and the destination the player clicked is gone before `preSteer` ever runs.
   * `interceptOrders` then measured a 7 cm displacement, correctly concluded no click had
   * happened, and put the unit back to `Garrison` — for ever. Every gate in that loop was
   * behaving exactly as documented; the input it reads had already been destroyed.
   *
   * That clamp is right for a field unit and must not change: no order the sim holds may
   * point through masonry. So the fix is to stop reading the clamped value. `orderIssued`
   * carries the point the player actually clicked, the AI emits the same event through
   * `OrderBook`, and both arrive before anything has had a chance to rewrite them.
   *
   * Recorded here and consumed inside `preSteer` rather than acted on in the handler, so
   * every mutation still happens inside the fixed step and the tick stays deterministic.
   */
  private ordered = new Map<number, { x: number; z: number }>();

  // ---- per-soldier crossing state ----
  /** Which crossing this man is on, or -1. Indexed by soldier. */
  private crossOf!: Int32Array;
  /** Metres along it. */
  private crossT!: Float32Array;
  /**
   * Where he was standing at the instant he was admitted.
   *
   * A crossing's position is authored from its arc-length parameter, so admitting a man
   * standing a metre from the foot of a ladder used to move him onto `pts[0]` in a single
   * tick. The probe caught it as a 3.35 m instantaneous step — the admission radius,
   * exactly — which is a teleport however briefly it lasts. His entry point is kept so the
   * first metre of the climb can be blended from where he actually was.
   */
  private crossEx!: Float32Array;
  private crossEy!: Float32Array;
  private crossEz!: Float32Array;
  /**
   * Multiplier on this man's pace along the path he is on. 1 for the party the machine
   * belongs to, `ESCALADE_PACE` for anybody else the player has sent up it.
   *
   * Per soldier rather than per crossing because a ladder now carries men of two or three
   * different units at once, in one file, and they do not climb at the same rate.
   */
  private crossPace!: Float32Array;
  /** Station he is bound for once across; -1 while he is still on the ground. */
  private stationOf!: Int32Array;
  /** Which rank of the walkway he holds. */
  private rankOf!: Uint8Array;
  /** The link he is on, or -1. */
  private linkOf!: Int32Array;
  /** 0 while he is walking it a->b, 1 for b->a. */
  private linkDir!: Uint8Array;
  /** The link he is walking toward and will be admitted to, or -1. */
  private wantLink!: Int32Array;
  private wantDir!: Uint8Array;
  /**
   * How deep each file of one machine's muster is, this tick. Scratch for `musterOwned`.
   *
   * One array reused by both branches — a tower column is four files and a ladder bank is
   * one file per rail, and `MAX_LADDERS` is the larger — because this is rebuilt from zero
   * for every machine in the tick and allocating it there would be per-tick garbage in a
   * function that already runs over every man of every boarding party.
   */
  private fileRows = new Int32Array(MAX_LADDERS);
  /**
   * Which men `layOutArrived` is allowed to place this tick. Scratch, one bit per soldier.
   *
   * A typed array rather than the `Set` this obviously wants to be, because `advancePlans`
   * runs it for every unit under orders on every fixed step, and the set would be per-tick
   * garbage in the hottest loop this file has. Written and cleared over the arrival list
   * only, never over the pool.
   */
  private placeMark!: Uint8Array;

  // ---- gate ----
  /**
   * Blows landed on each gate, by id — not one counter for "the gate".
   *
   * Rome has one gate and Carthage has three plus eight posterns, and a single running total
   * meant a ram re-aimed half way through its work carried its blows across to the new
   * timber. Keyed by id for the same reason `SiegeRam.gateId` is: it is the one identifier
   * every other consumer of the gate — the leaves, the occupancy raster and the report —
   * already agrees on. Two rams beating the same gate still share one counter, which is what
   * they should do and what the single total used to do by accident.
   */
  private gateBlowsBy = new Map<string, number>();
  /** Gates whose leaves are down, in the order they fell. */
  private breachedGates: string[] = [];
  /**
   * The worst-battered gate's tally, which is what "the gate" meant when there was one.
   *
   * `engineReport` and `gateReport` are read by probes that were written against a single
   * gate; a maximum keeps them measuring the gate the ram is actually working on instead of
   * a sum across three that never adds up to a percentage.
   */
  private get gateBlows(): number {
    let most = 0;
    for (const n of this.gateBlowsBy.values()) if (n > most) most = n;
    return most;
  }
  private gateBreached = false;
  /**
   * The gate starts **shut**, and this is the flag that says so before anything has hit it.
   *
   * Reverted work, stated plainly: the first version left the leaves open and the ram's only
   * effect was that they could no longer be closed, which is a mechanic nobody can see. A
   * gate that is already a hole is not a target. `init` shuts it against the city's own
   * movement grid, so a column ordered into Rome has to go round or wait for the ram.
   */
  private gateShutAtStart = false;
  /** Whether `armGate` has run. See it for why this is not done in `init`. */
  private gateArmed = false;
  /** Blows landed on each curtain bay by a great ram, indexed by bay index. */
  private bayBlows = new Map<number, number>();
  /** Bays the great ram has brought down, in the order they fell. */
  private breachedBays: number[] = [];
  /** Link ids of the storming lanes through those breaches. */
  private breachLinks: number[] = [];

  // ---- diagnostics ----
  /** Missiles released by men whose feet were on a wall-walk. */
  wallShots = 0;
  /** Men killed by those missiles. */
  wallKills = 0;
  private artilleryShots = 0;
  private artilleryKills = 0;

  // ---- rendering ----
  private root = new THREE.Group();
  private material?: THREE.MeshStandardMaterial;
  private mShaft?: THREE.InstancedMesh;
  private mDeck?: THREE.InstancedMesh;
  private mWheels?: THREE.InstancedMesh;
  private mRamp?: THREE.InstancedMesh;
  private mShed?: THREE.InstancedMesh;
  private mTrunk?: THREE.InstancedMesh;
  private mLadder?: THREE.InstancedMesh;
  private mGreatShed?: THREE.InstancedMesh;
  private mGreatTrunk?: THREE.InstancedMesh;

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  init(ctx: EngineContext, battle: BattleSystem): void {
    this.ctx = ctx;
    this.battle = battle;
    this.rng = battle.rng.fork('siege');
    // Duck-typed: a battle on open ground has no city, and neither does a unit test.
    const city = ctx.tryGet('city') as unknown as Partial<CityView> | undefined;
    this.city = city && typeof city.getGarrisonBays === 'function' ? (city as CityView) : null;

    const cap = battle.pool.capacity;
    this.crossOf = new Int32Array(cap).fill(-1);
    this.crossT = new Float32Array(cap);
    this.crossEx = new Float32Array(cap);
    this.crossEy = new Float32Array(cap);
    this.crossEz = new Float32Array(cap);
    this.crossPace = new Float32Array(cap).fill(1);
    this.stationOf = new Int32Array(cap).fill(-1);
    this.rankOf = new Uint8Array(cap);
    this.linkOf = new Int32Array(cap).fill(-1);
    this.linkDir = new Uint8Array(cap);
    this.wantLink = new Int32Array(cap).fill(-1);
    this.wantDir = new Uint8Array(cap);
    this.placeMark = new Uint8Array(cap);

    this.buildSpine();
    this.buildStairs();
    this.buildLinks();
    this.buildMeshes(ctx);

    /**
     * The only subscription this system has, and it exists because the polling loop it
     * replaces reads a value that has already been clamped. See `ordered`.
     *
     * Both the player's mouse and `ai/Orders.ts` emit this, so one handler serves a
     * right-click and an AI redeployment identically — which is the point: a defender told
     * to fall back off the wall and an attacker's lodgement told to come down into the
     * streets are the same order.
     */
    ctx.events.on('orderIssued', (o) => {
      if (o.kind !== 'move' && o.kind !== 'attackMove') return;
      if (o.x === undefined || o.z === undefined) return;
      // A queued waypoint appends to a march that is already running; it is not a decision
      // about the wall and taking it as one would hijack the second click of a two-click path.
      if (o.queued) return;
      for (const id of o.unitIds) this.ordered.set(id, { x: o.x, z: o.z });
    });

    battle.elevation = this;
  }

  /**
   * Close the Porta Flaminia, on the first tick rather than in `init`.
   *
   * `CitySystem.setGateOpen(id, false)` paints the carriageway back into the occupancy
   * raster and re-cuts the curtain's oriented boxes, and that is the one call that makes a
   * shut gate a *wall* as far as pathfinding, the crowd solver and the obstacle push-out are
   * concerned — without it the closed gate is a picture of a door.
   *
   * Doing it in `init` looked right and did not work. `CitySystem` clears the carriageway
   * unconditionally as part of its own build — "the gate passage is open: clear it again so
   * units can march through" — and that clear lands *after* `BattleSystem.init` runs. So the
   * flag flipped, `getGates()[0].open` read false, and the raster was wide open behind it:
   * measured, `blocksMovement` straight through the gateway returned false at t=0 while a
   * manual open-then-shut toggle in the same session returned true. A state that reports
   * itself correct while being wrong is the worst kind, so this now runs once the world is
   * built and *verifies* rather than assuming.
   */
  private armGate(): void {
    this.gateArmed = true;
    const city = this.city;
    const gate = city?.getGates()[0];
    if (!city || !gate) return;
    // Force the mark even if the flag already says shut: the flag and the raster had come
    // apart once and only the raster decides whether anybody can walk through.
    if (gate.open) city.setGateOpen(gate.id, false);
    else { city.setGateOpen(gate.id, true); city.setGateOpen(gate.id, false); }
    this.gateShutAtStart = true;
  }

  /** Late binding: the projectile system is registered after the battle. */
  private ensureProjectiles(): ProjectileSystem | null {
    if (this.projectiles === null) {
      this.projectiles = this.ctx.tryGet<ProjectileSystem>('projectiles') ?? null;
    }
    return this.projectiles;
  }

  /**
   * Flatten every garrisonable bay into a list of standing stations.
   *
   * Built once. The wall does not move, so a garrison's slot geometry is a lookup rather
   * than a computation, and re-forming a unit after losses costs an array write per man.
   */
  private buildSpine(): void {
    if (!this.city) return;
    const bays = this.city.getGarrisonBays();
    const xs: number[] = [];
    const zs: number[] = [];
    const ys: number[] = [];
    const nxs: number[] = [];
    const nzs: number[] = [];
    const outs: number[] = [];
    const ins: number[] = [];
    const faces: number[] = [];
    const crests: number[] = [];
    const bidx: number[] = [];
    const pmid: number[] = [];
    const phalf: number[] = [];

    /** The gatehouse, if this city publishes one. Read once: the wall does not move. */
    const gateBlock = this.city.getGateBlock?.() ?? null;
    for (const bay of bays) {
      if (!bay.garrisonable) continue;
      // The doorway through this bay's west tower, as the city cut it. Zero-width where the
      // city publishes none, which puts `linkPath` back on the cityward lip.
      const pOut = bay.passOuter ?? 0;
      const pIn = bay.passInner ?? 0;
      const laneMid = (pOut + pIn) * 0.5;
      const laneHalf = Math.max(0, (pOut - pIn) * 0.5);
      // A tower stands at the bay's west end and its ballista chamber occupies the walk
      // there, so the standing run starts clear of it. The east end is the next bay's
      // tower, which that bay's own margin handles.
      const t0 = bay.towerHalf + 0.55;
      const t1 = bay.length - 0.55;
      if (t1 - t0 < STATION_PITCH) continue;
      const count = Math.floor((t1 - t0) / STATION_PITCH);
      for (let k = 0; k <= count; k++) {
        const t = t0 + k * STATION_PITCH;
        const px = bay.x0 + bay.dx * t;
        const pz = bay.z0 + bay.dz * t;
        /**
         * Not where the gatehouse is.
         *
         * The bay's own run is clipped at its west end by `towerHalf`, because a tower
         * chamber occupies the walk there; a gatehouse occupies it in exactly the same way
         * and nothing clipped it. `curtainSpans` cuts the curtain out under the block, so
         * those stations had **no stone beneath them** — measured on Rome as 22 of bay 19's
         * 36, standing 6.574 m below the crown and firing 823 shots that were all discarded.
         *
         * A garrison *should* be able to stand on a gatehouse roof, and that is the better
         * fix: a run laid on the crown at the block's own `topY`, with links to the walks
         * either side. This is the safe half of it — men are no longer placed in mid-air —
         * and it is written as a clip rather than a special case, so the day the city
         * publishes a crown run, deleting this is the whole change.
         */
        if (gateBlock && insideBlock(gateBlock, px, pz)) continue;
        xs.push(px);
        zs.push(pz);
        ys.push(bay.walkY);
        nxs.push(bay.nx);
        nzs.push(bay.nz);
        outs.push(bay.outerOff);
        ins.push(bay.innerOff);
        faces.push(bay.parapetOuter);
        crests.push(bay.crestY);
        bidx.push(bay.index);
        pmid.push(laneMid);
        phalf.push(laneHalf);
      }
    }

    this.nStations = xs.length;
    this.sx = new Float32Array(xs);
    this.sz = new Float32Array(zs);
    this.sy = new Float32Array(ys);
    this.snx = new Float32Array(nxs);
    this.snz = new Float32Array(nzs);
    this.sOuter = new Float32Array(outs);
    this.sInner = new Float32Array(ins);
    this.sFace = new Float32Array(faces);
    this.sCrest = new Float32Array(crests);
    this.sBay = new Int32Array(bidx);
    this.sPassMid = new Float32Array(pmid);
    this.sPassHalf = new Float32Array(phalf);

    this.sDead = new Uint8Array(this.nStations);
    this.sOwner = new Int32Array(this.nStations).fill(-1);
    this.recut();
  }

  /**
   * What the stone does between two places a man could stand, given the height and the plan
   * run between them.
   *
   * **One question, asked in one place, by both of the functions that used to answer it
   * differently.** `recut` severed a run on height; `buildLinks` rejoined it on horizontal
   * distance, having measured the height, named it `step`, and written `void step;` under a
   * comment describing a classifier that used it. The wall was therefore cut by one rule and
   * sewn up by another, and every joint where the two disagreed became a way through a face
   * no man could get up. Measured on Rome: the worst was 7.70 m of rise across 5.03 m of
   * plan — one 9.20 m leg at 56.8 degrees, with the man 3.16 m clear of the stone
   * `CitySystem.walkableTopAt` reports at the mouth he starts from.
   *
   * Three answers and no fourth:
   *
   *  - **`Level`** — under `WALK_STEP_OVER`. A man steps over it without changing gait, and
   *    it is not a run boundary at all.
   *  - **`Flight`** — over that, but shallow enough that the tread module can carry it.
   *    There is stone here and a man climbs it. It *is* a run boundary — a run is a stretch
   *    you walk along without changing gait — and `buildLinks` bridges it. The pace is not
   *    set here: `segmentAt` already prices a crossing leg by leg, `CROSS_CLIMB` and the
   *    climbing clip above 36.9 degrees and `CROSS_PASS` below, which is the right answer
   *    for a 4 degree tower ramp and for a 41 degree tower stair alike.
   *  - **`Broken`** — steeper than any flight this project builds. `recut` cuts here and
   *    `buildLinks` leaves it cut, so `runNext` stays -1, `runsConnected` says no, and
   *    `moveAlongWall` refuses the order in front of the player instead of accepting it and
   *    levitating a cohort. Nothing else needs a special case: the whole file already treats
   *    an unbridged boundary as the edge of the world, because a breach makes one.
   *
   * **Why the answer is not "make it a one-way drop".** A man can fall further than he can
   * climb, so a descent-only link is physically the honest asymmetry — and it is a trap. The
   * run chain is walked in both directions by `nextHop`, `runsConnected` and `walkDistance`,
   * and a one-way edge would make "reachable" mean two different things depending on which
   * way you asked; worse, a cohort that drops onto a run with no stair can never leave it,
   * and this file's failure mode of record is men who cannot finish an order. A trapdoor is
   * a stuck-man factory. Where the stone carries a flight, both directions are real; where
   * it does not, neither is.
   *
   * `run` is the *plan* distance the crossing actually has, not the tower's footprint. Those
   * differ on both circuits — `buildSpine` clips a bay's west end by `towerHalf + 0.55` and
   * its east end by 0.55, so a bay's last stations stand inside the next tower's footprint
   * (four of them on Rome) and the crossing gets about 5 m of plan where the flight
   * `wall.ts` draws gets about 8 — but the crossing is what a man is walked along, and
   * licensing a path with a length the path does not have is the shape of half the defects
   * in this file's history.
   * The asymmetry is measured in `probe-linkstep.mjs` and is not fixed here; when it is,
   * these gaps grow and four of Rome's five refusals become flights with no change to this.
   */
  private stepAcross(rise: number, run: number): Joint {
    const dy = Math.abs(rise);
    if (dy <= WALK_STEP_OVER) return Joint.Level;
    return dy <= run * FLIGHT_PITCH ? Joint.Flight : Joint.Broken;
  }

  /**
   * (Re)split the spine into walkable runs and index their bounds.
   *
   * Called at init and again whenever a great ram takes a bay down, because a breach is
   * exactly a new run boundary: the stations over the hole stop being places to stand, and
   * the walkway either side of it becomes two separate runs that a man can no longer walk
   * between. Everything downstream — garrison layout, the standing-surface search, a
   * lodgement spreading out — already refuses to cross a run boundary, so a breach needs no
   * special case anywhere but here.
   *
   * 0.62 m is a high step but a possible one; the breaks this is really catching are metres
   * deep. The threshold is `stepAcross`'s, not this function's — see there for why the two
   * ends of the same joint used to be measured by two different rules.
   */
  private recut(): void {
    this.sRun = new Int32Array(this.nStations);
    let run = 0;
    for (let i = 0; i < this.nStations; i++) {
      if (i > 0) {
        const dx = this.sx[i] - this.sx[i - 1];
        const dz = this.sz[i] - this.sz[i - 1];
        const plan = Math.sqrt(dx * dx + dz * dz);
        const dy = Math.abs(this.sy[i] - this.sy[i - 1]);
        // A dead station on either side of the joint is a break: you cannot walk over a
        // hole, and you cannot walk out of one.
        if (plan > STATION_PITCH * 1.9 || this.stepAcross(dy, plan) !== Joint.Level
          || this.sDead[i] !== this.sDead[i - 1]) run++;
      }
      this.sRun[i] = run;
    }
    this.nRuns = this.nStations === 0 ? 0 : run + 1;
    this.runLo = new Int32Array(this.nRuns).fill(-1);
    this.runHi = new Int32Array(this.nRuns).fill(-1);
    for (let i = 0; i < this.nStations; i++) {
      const r = this.sRun[i];
      if (this.runLo[r] < 0) this.runLo[r] = i;
      this.runHi[r] = i;
    }
  }

  /** First and last station of the run containing `station`. O(1); see `runLo`. */
  private runBounds(station: number): { lo: number; hi: number } {
    const r = this.sRun[station];
    return { lo: this.runLo[r], hi: this.runHi[r] };
  }

  /** True where the walkway is gone, so nobody may stand on or walk through this station. */
  private dead(station: number): boolean {
    return this.sDead[station] === 1;
  }

  /**
   * Find every stair between the ground and the wall-walk.
   *
   * Two sources, one record. The city is asked first and believed absolutely — it owns the
   * masonry and it is rebuilding the flights to run parallel to the curtain, so anything
   * this file thinks it knows about where a stair is will be wrong before long. Only when
   * there is no API at all does it fall back to assuming the cadence the geometry currently
   * uses, and it says so in `stairReport`.
   */
  private buildStairs(): void {
    this.stairs = [];
    this.stairsFromCity = false;
    if (!this.city || this.nStations === 0) return;

    const published = this.city.getWallStairs?.();
    if (published && published.length > 0) {
      this.stairsFromCity = true;
      for (const s of published) {
        const station = this.stationNear(s.topX, s.topZ);
        if (station < 0 || this.dead(station)) continue;
        // Reject a published flight whose head is nowhere near the standing surface: a
        // stair that does not actually reach the walk is not a way onto the wall, and
        // silently accepting one would put men on a path to nothing.
        if (Math.sqrt((s.topX - this.sx[station]) * (s.topX - this.sx[station]) + (s.topZ - this.sz[station]) * (s.topZ - this.sz[station])) > 6) continue;
        const dx = s.footX - this.sx[station];
        const dz = s.footZ - this.sz[station];
        const off = dx * this.snx[station] + dz * this.snz[station];
        this.stairs.push({
          footX: s.footX, footZ: s.footZ, footY: s.footY,
          topX: s.topX, topZ: s.topZ, topY: s.topY,
          station,
          side: (s.side !== undefined ? (s.side < 0 ? -1 : 1) : (off < 0 ? -1 : 1)),
          width: s.width ?? 2.4,
          fromCity: true,
        });
      }
      if (this.stairs.length > 0) return;
      // A published-but-unusable set falls through to the synthesis rather than leaving the
      // wall with no way up, and `stairsFromCity` is reset so the report does not claim a
      // provenance it did not get.
      this.stairsFromCity = false;
    }

    // ---- fallback ----------------------------------------------------------
    const bays = this.city.getGarrisonBays();
    for (const bay of bays) {
      if (!bay.garrisonable) continue;
      if (((bay.index % STAIR_MOD) + STAIR_MOD) % STAIR_MOD !== STAIR_PHASE) continue;
      // The flight stands against the tower at the bay's start, so the station it serves is
      // the first one clear of that tower — which is this bay's first station.
      const station = this.stationNear(bay.x0 + bay.dx * (bay.towerHalf + 0.6),
        bay.z0 + bay.dz * (bay.towerHalf + 0.6));
      if (station < 0 || this.dead(station)) continue;
      // Head on the walk at the run's cityward lip; foot out from it by the flight's own
      // horizontal run, which the rise and the tread ratio fix between them.
      const headOff = this.sInner[station];
      const topY = this.sy[station];
      const hx = this.sx[station] + this.snx[station] * headOff;
      const hz = this.sz[station] + this.snz[station] * headOff;
      // Probe the ground where the foot will land before committing to a length, then solve
      // the run from the rise that probe gives: a flight on a slope is longer than one on
      // the flat and a fixed length would leave the bottom tread buried or in mid-air.
      const guessOff = headOff - (topY - bay.groundY) * STAIR_SLOPE;
      const gx = this.sx[station] + this.snx[station] * guessOff;
      const gz = this.sz[station] + this.snz[station] * guessOff;
      const footY = this.battle.groundAt(gx, gz);
      const run = Math.max(1.5, (topY - footY) * STAIR_SLOPE);
      const footOff = headOff - run;
      const fx = this.sx[station] + this.snx[station] * footOff;
      const fz = this.sz[station] + this.snz[station] * footOff;
      this.stairs.push({
        footX: fx, footZ: fz, footY: this.battle.groundAt(fx, fz),
        topX: hx, topZ: hz, topY,
        station, side: -1, width: 2.4, fromCity: false,
      });
    }
  }

  /**
   * Join everything a man can stand on into a graph.
   *
   * Three kinds of edge and one rule: an edge exists only where a man could physically get
   * from one surface to the other. Consecutive runs are joined where the gap between their
   * ends is a tower or a construction step and *not* where it is a missing bay — the wall
   * really is broken there and no amount of ordering should walk a cohort across forty
   * metres of air. Stairs join the ground to a run at both ends, which is what makes "pull
   * the archers back and put infantry up" one mechanism rather than two.
   */
  private buildLinks(): void {
    this.links = [];
    this.runNext = new Int32Array(Math.max(1, this.nRuns)).fill(-1);
    this.runStair = new Int32Array(Math.max(1, this.nRuns)).fill(-1);
    if (this.nStations === 0) return;

    // ---- run to run --------------------------------------------------------
    for (let r = 0; r + 1 < this.nRuns; r++) {
      const a = this.runHi[r];
      const b = this.runLo[r + 1];
      if (a < 0 || b < 0) continue;
      if (this.dead(a) || this.dead(b)) continue;
      const gap = Math.sqrt((this.sx[b] - this.sx[a]) * (this.sx[b] - this.sx[a]) + (this.sz[b] - this.sz[a]) * (this.sz[b] - this.sz[a]));
      if (gap > LINK_MAX_GAP) continue;
      const rise = this.sy[b] - this.sy[a];
      /**
       * The height, and whether there is any stone that carries it.
       *
       * This is the line that read `void step;`. `recut` had already severed this joint —
       * on the height, or on the plan gap where a tower stands — and the only question left
       * is whether the sever was a doorway or a hole. `stepAcross` answers it with the same
       * two numbers `recut` used, which is what stops the two ends of one joint being
       * measured by two rules.
       */
      if (this.stepAcross(rise, gap) === Joint.Broken) continue;
      // A tower is a long gap in plan; a construction step is a short one with a jump in
      // height. Both are crossable and they are drawn differently, so they are named
      // differently, but the path is built the same way — and `segmentAt` prices the rise
      // out of the path's own geometry, so nothing further is needed here.
      const kind = gap > STATION_PITCH * 3 ? LinkKind.TowerPass : LinkKind.Step;
      this.runNext[r] = this.links.length;
      this.links.push({
        id: this.links.length, kind,
        runA: r, runB: r + 1, stationA: a, stationB: b,
        ax: this.sx[a], az: this.sz[a], ay: this.sy[a],
        bx: this.sx[b], bz: this.sz[b], by: this.sy[b],
        rise,
        ab: null, ba: null, used: 0, lane: 0,
      });
    }

    // ---- ground to run -----------------------------------------------------
    for (const s of this.stairs) {
      const r = this.sRun[s.station];
      // One stair per run is enough for the graph: a second flight onto a run a man can
      // already reach adds a choice the router would have to make and no reachability.
      if (this.runStair[r] >= 0) continue;
      this.runStair[r] = this.links.length;
      this.links.push({
        id: this.links.length, kind: LinkKind.Stair,
        runA: -1, runB: r, stationA: -1, stationB: s.station,
        ax: s.footX, az: s.footZ, ay: s.footY,
        bx: this.sx[s.station] + this.snx[s.station] * this.sInner[s.station],
        bz: this.sz[s.station] + this.snz[s.station] * this.sInner[s.station],
        by: s.topY,
        // A flight is authored at its own rake by whoever built it, so this is recorded and
        // not classified: `stepAcross` would refuse most of them, and rightly — a stair from
        // the ground to a 14 m walk is not a joint between two runs.
        rise: s.topY - s.footY,
        ab: null, ba: null, used: 0, lane: 0,
      });
    }
  }

  /** The path along a link, built the first time somebody needs it. */
  private linkPath(l: WallLink, forward: boolean): Crossing {
    const cached = forward ? l.ab : l.ba;
    if (cached) return cached;
    const pts: number[] = [];
    const dest = forward ? l.stationB : l.stationA;
    if (l.kind === LinkKind.Stair) {
      const s = this.stairs.find((q) => q.station === l.stationB);
      const st = l.stationB;
      // Ground, foot of the flight, head of the flight, then one pace onto the walkway
      // proper. The last leg is what takes a man off the top tread and into the standing
      // band, and it is what a garrison closing up then spreads him along.
      const legs: number[] = [
        l.ax, l.ay, l.az,
        s ? s.topX : l.bx, s ? s.topY : l.by, s ? s.topZ : l.bz,
        this.sx[st] + this.snx[st] * this.sInner[st], this.sy[st],
        this.sz[st] + this.snz[st] * this.sInner[st],
        this.sx[st] + this.snx[st] * this.sOuter[st], this.sy[st],
        this.sz[st] + this.snz[st] * this.sOuter[st],
      ];
      if (forward) pts.push(...legs);
      else for (let k = legs.length - 3; k >= 0; k -= 3) pts.push(legs[k], legs[k + 1], legs[k + 2]);
    } else if (l.kind === LinkKind.Breach) {
      if (forward) pts.push(l.ax, l.ay, l.az, l.bx, l.by, l.bz);
      else pts.push(l.bx, l.by, l.bz, l.ax, l.ay, l.az);
    } else {
      /**
       * Through the tower, or over the step.
       *
       * **Both used to go by way of the cityward lip, and that was the bug the owner was
       * looking at.** The comment here read "the tower's only door onto the walk is on the
       * city face", quoting `wall.ts` — but `wall.ts` had said that about a *previous*
       * tower and then pierced the chamber's side walls on the line of the walk. So the
       * path ran along the lip at `innerOff - 0.15` and the hole was 1.36 m out to the
       * field of it, and the file walked through 0.75 m of chamber wall and the chamber's
       * back wall at every one of forty-two towers on Rome and all thirty-one on Carthage,
       * where there was no hole at all. Measured with a ray along the wall axis against the
       * geometry the renderer had: path inside masonry, 73 towers of 73.
       *
       * The lane is now published on the bay — `sPassMid`, from `GarrisonBay.passOuter`
       * and `passInner` — and it is the *same call* the stone is cut with. Read off the
       * far end of the link, because the tower stands at the west end of the bay the far
       * station belongs to. Where there is no lane published, this falls back to the lip:
       * a construction step is not a tower and has no doorway to aim at.
       */
      const a = l.stationA;
      const b = l.stationB;
      const doorway = this.sPassHalf[b] > 0;
      const inA = doorway ? this.sPassMid[b] : this.sInner[a] - 0.15;
      const inB = doorway ? this.sPassMid[b] : this.sInner[b] - 0.15;
      const legs: number[] = [
        this.sx[a], this.sy[a], this.sz[a],
        this.sx[a] + this.snx[a] * inA, this.sy[a], this.sz[a] + this.snz[a] * inA,
        this.sx[b] + this.snx[b] * inB, this.sy[b], this.sz[b] + this.snz[b] * inB,
        this.sx[b], this.sy[b], this.sz[b],
      ];
      if (forward) pts.push(...legs);
      else for (let k = legs.length - 3; k >= 0; k -= 3) pts.push(legs[k], legs[k + 1], legs[k + 2]);
    }
    const c = this.makeCrossing(pts, dest, l.kind === LinkKind.Stair ? CROSS_WALK : CROSS_PASS);
    if (forward) l.ab = c;
    else l.ba = c;
    return c;
  }

  private buildMeshes(ctx: EngineContext): void {
    this.material = siegeMaterial();
    /**
     * `cast` is deliberately not set on everything.
     *
     * Every shadow-casting mesh is re-rendered once per cascade plus the depth prepass, so
     * nine casting instanced meshes cost 45 draw calls, not nine — measured, by hiding the
     * siege group at the worst siege camera and watching the count fall from 291 to 246.
     * The shaft, the deck and the ram shed are the parts whose shadow carries the mass of
     * the machine; a ladder rung, a wheel and a plank ramp contribute a few texels of the
     * outermost cascade and are not worth four passes each.
     */
    const mk = (geo: THREE.BufferGeometry, n: number, name: string, cast: boolean): THREE.InstancedMesh => {
      const m = new THREE.InstancedMesh(geo, this.material!, n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = cast;
      m.receiveShadow = true;
      m.count = 0;
      m.name = name;
      this.root.add(m);
      return m;
    };
    this.mShaft = mk(buildTowerShaft(), MAX_TOWERS, 'siege-tower-shaft', true);
    this.mDeck = mk(buildTowerDeck(), MAX_TOWERS, 'siege-tower-deck', true);
    this.mWheels = mk(buildTowerWheels(), MAX_TOWERS, 'siege-tower-wheels', false);
    this.mRamp = mk(buildTowerRamp(), MAX_TOWERS, 'siege-tower-ramp', false);
    this.mShed = mk(buildRamShed(), MAX_RAMS, 'siege-ram-shed', true);
    this.mTrunk = mk(buildRamTrunk(), MAX_RAMS, 'siege-ram-trunk', false);
    this.mLadder = mk(buildLadder(), MAX_LADDERS, 'siege-ladders', false);
    // The great ram is the one machine on the field whose shadow is worth four passes: it is
    // the largest solid here and it stands against the curtain, where the cascade is tight.
    this.mGreatShed = mk(buildGreatRamShed(), MAX_GREAT_RAMS, 'siege-greatram-shed', true);
    this.mGreatTrunk = mk(buildGreatRamTrunk(), MAX_GREAT_RAMS, 'siege-greatram-trunk', false);
    this.root.name = 'siege';
    ctx.scene.add(this.root);
  }

  // -------------------------------------------------------------------------
  // Spine queries
  // -------------------------------------------------------------------------

  get stationCount(): number {
    return this.nStations;
  }

  /** Nearest standing station to a point. Linear, but only ever called on an order. */
  stationNear(x: number, z: number): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.nStations; i++) {
      const dx = this.sx[i] - x;
      const dz = this.sz[i] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * The station whose stonework a man is actually standing on.
   *
   * **Not the same thing as the station he has been assigned to**, and conflating the two
   * was a 3.62 m teleport. A man's slot is a destination he walks to; his feet rest on
   * whatever is under him *now*. When a boarding party re-formed and moved a man's slot
   * eight stations along the wall onto a bay one construction step lower, snapping his Y
   * from the new slot dropped him 3.62 m in a single tick — measured, with the station
   * index changing 873 to 865 in the same frame.
   *
   * Searched in a window around his slot rather than over the whole spine: he is never
   * more than a few metres from it, and this runs for every garrisoned man every tick.
   */
  private standingStation(i: number, slot: number): number {
    const p = this.battle.pool;
    const x = p.x[i];
    const z = p.z[i];
    // Never leaves the run his slot is on: the nearest station in plan may be on the
    // other side of a three-metre step, and it is not the one he is standing on.
    const bounds = this.runBounds(slot);
    const lo = Math.max(bounds.lo, slot - STATION_WINDOW);
    const hi = Math.min(bounds.hi, slot + STATION_WINDOW);
    let best = slot;
    let bestD = Infinity;
    for (let k = lo; k <= hi; k++) {
      const dx = this.sx[k] - x;
      const dz = this.sz[k] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  }

  /**
   * How many ranks the walkway will take here. **A property of the wall, not of the unit.**
   *
   * This is the whole of a unit's frontage once it is on the stone, and it is the number the
   * owner's report turns on: a `legio-cohort` is 160 men at a 41 m frontage in the field, and
   * a wall-walk on the Aurelian circuit is a 3.251 m band — 2.21 to 4.055 m across the 45
   * garrisonable bays — which takes four or five men at `WALL_RANK_PITCH`. A unit up here is
   * not a rectangle that has been squeezed; it is a file as deep as the stone allows and as
   * long as the run needs, and everything that lays men out has to agree on the depth or two
   * of them end up at the same offset.
   */
  private ranksAt(station: number): number {
    const s = clamp(station, 0, this.nStations - 1) | 0;
    const band = this.sOuter[s] - this.sInner[s];
    return clamp(Math.floor(band / WALL_RANK_PITCH) + 1, 1, MAX_WALL_RANKS);
  }

  /**
   * The depth the *narrowest* station of a run will take, which is the depth the whole file
   * must use.
   *
   * A file laid out at the centre station's depth and then run along a bay that pinches
   * would have its back rank clamped into the rank in front of it by `slotAt`, which is the
   * collapse this pass exists to remove. One number for the run, taken from its worst point.
   */
  private ranksOnRun(station: number): number {
    const b = this.runBounds(station);
    let r = MAX_WALL_RANKS;
    for (let s = b.lo; s <= b.hi; s++) {
      const n = this.ranksAt(s);
      if (n < r) r = n;
    }
    return Math.max(1, r);
  }

  /** World position of a man standing at `station` in `rank`, written into `out`. */
  private slotAt(
    i: number, station: number, rank: number,
    out: { x: number; y: number; z: number; f: number }
  ): void {
    const s = clamp(station, 0, this.nStations - 1) | 0;
    /**
     * Per-man jitter, and it is not cosmetic.
     *
     * The first version put every man exactly on his station with exactly the outward
     * normal for a facing, and a blind critic picked the result out of a line-up on it
     * immediately: *"every crenellation contains the same soldier in the same pose with the
     * same shield at the same angle — nine copies in a row"*. A garrison on a 0.86 m station
     * pitch against a 2.65 m merlon-and-crenel period also beats visibly against the
     * battlement, which is what turned a line of men into a repeating sawtooth.
     *
     * `hash01` is stable per man, so his stance never changes frame to frame — the rule the
     * architecture doc sets for every appearance choice — and it is not drawn from the `Rng`
     * because this runs in a fixed step for every garrisoned man every tick.
     */
    const jAlong = (hash01(i, 0x51e9e) - 0.5) * 0.42;
    const jOff = (hash01(i, 0x9a11) - 0.5) * 0.26;
    /**
     * Never two ranks at one offset, and this line is the fault the owner was looking at.
     *
     * The clamp below is load-bearing — a man must not be placed off the walk — but for
     * years it was also the only thing standing between a caller and nonsense: a rank
     * deeper than the band takes clamps to `sInner`, and *every* rank past that clamps to
     * the same `sInner`. Measured on the shipped tree, a 160-man cohort ordered onto a
     * 14-station run whose stations were already claimed: `layOutArrived` handed out ranks
     * 0 to **142** on a walkway five deep, and 149 men were being steered at **17 distinct
     * points, 45 of them at one point**. They never arrive, so `steerToSlots` drives them
     * at a full 1.49 m/s walk for the rest of the battle while `resolveCrowding` shoves
     * them apart and `holdGarrisonsOnTheWalk` pushes them back in. That churn is what
     * "they get stuck" looks like from the chair.
     *
     * `ranksAt` is the wall's own answer to how deep a file may be, so folding the rank
     * into it here means no caller can produce a duplicate place however it counts. The
     * clamp stays underneath as the guard it was always meant to be.
     */
    const r = Math.min(rank, this.ranksAt(s) - 1);
    // Rank 0 stands against the parapet; each rank behind steps back toward the city.
    const off = clamp(
      this.sOuter[s] - r * WALL_RANK_PITCH + jOff,
      this.sInner[s], this.sOuter[s]
    );
    // Odd ranks shift half a station along the wall so the packing interlocks. See
    // `WALL_RANK_PITCH`.
    const along = ((r & 1) === 0 ? 0 : WALL_RANK_STAGGER) + jAlong;
    // The along-wall direction is perpendicular to the outward normal, in plan.
    const ax = -this.snz[s];
    const az = this.snx[s];
    out.x = this.sx[s] + this.snx[s] * off + ax * along;
    out.z = this.sz[s] + this.snz[s] * off + az * along;
    out.y = this.sy[s];
    // Facing outward over the parapet — that is the whole point of being up here — but a
    // rank of men watching a field does not all look at the same point on the horizon.
    out.f = Math.atan2(this.snx[s], this.snz[s]) + (hash01(i, 0x7a11) - 0.5) * 0.5;
  }

  // -------------------------------------------------------------------------
  // Garrison
  // -------------------------------------------------------------------------

  /**
   * Put a unit on the wall, centred on the station nearest `(x, z)`.
   *
   * The unit stops being a formation: its men are laid out along the stonework in as many
   * ranks as the walkway is wide, and `BattleSystem` steers them to absolute world slots
   * instead of to formation offsets. Returns false if there is no wall there.
   */
  garrison(u: UnitGroupState, x: number, z: number): boolean {
    if (this.nStations === 0) return false;
    const centre = this.stationNear(x, z);
    if (centre < 0) return false;
    const g: Garrison = { unitId: u.id, from: 0, span: 0, ranks: 2, plannedFor: -1, sticky: false, filled: 0, overflow: 0, lastTx: u.x, lastTz: u.z };
    this.garrisons.set(u.id, g);
    this.owned.add(u.id);
    u.order = UnitOrder.Garrison;
    u.targetUnitId = -1;
    u.waypoints.length = 0;
    u.contactLock = false;
    this.layOutGarrison(u, g, centre);
    // Place them there rather than making them walk: a garrison is *already* on the wall
    // when the assault arrives. Nothing else in the sim can put a man 7 m up.
    const p = this.battle.pool;
    const slot = { x: 0, y: 0, z: 0, f: 0 };
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      const st = this.stationOf[i];
      if (st < 0) continue;
      this.slotAt(i, st, this.rankOf[i], slot);
      p.x[i] = slot.x; p.z[i] = slot.z; p.y[i] = slot.y;
      p.px[i] = slot.x; p.pz[i] = slot.z; p.py[i] = slot.y;
      p.facing[i] = slot.f;
      p.prevFacing[i] = slot.f;
      this.battle.elevated[i] = 1;
      this.battle.support[i] = slot.y;
    }
    return true;
  }

  /**
   * Assign stations to the living men of a garrisoned unit, centred on `centre`.
   *
   * Re-run when the unit has taken enough losses to leave holes in the line. Men are
   * repacked in member order, so a garrison closes up along the wall the way a line closes
   * up in the field, and a man's station only ever shifts by the gap left beside him.
   */
  private layOutGarrison(u: UnitGroupState, g: Garrison, centre?: number, onlyPlaced = false): void {
    const p = this.battle.pool;
    const living: number[] = [];
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      // A unit half way up a stair lays out only the half that is up. Placing the ones
      // still on the grass would give them a slot 8 m in the air, and `steerToSlots` would
      // walk them into the masonry trying to reach it.
      if (onlyPlaced && this.stationOf[i] < 0) continue;
      living.push(i);
    }
    if (living.length === 0) return;
    this.layOutOnWall(u, g, centre ?? g.from + (g.span >> 1), living);
    g.plannedFor = living.length;
  }

  /**
   * Lay a body of men out along one run of the wall-walk, and write the garrison window.
   *
   * **One solver, shared by the garrison path and the arrival path**, because there were two
   * and they disagreed. `layOutGarrison` deepened a unit before spilling it and recorded an
   * `overflow`; `layOutArrived` did neither and let `rank` run away without limit. They are
   * the same question — where do these men stand on this stretch of stone — and the answer
   * has to be the same or a unit changes shape the moment its plan completes.
   *
   * The model, stated once:
   *
   *  - **Depth is the wall's**. `ranksOnRun` — four or five on this circuit, one on a ledge.
   *    Nothing about the unit changes it. A unit up here is not a formation with a frontage.
   *  - **Length is the roster's**, bounded only by the run. `ceil(n / ranks)` files, up to
   *    the whole run. This is the change that matters: the old code bounded the file by
   *    `freeWindow`, the largest stretch *no other living friendly unit had claimed*, and on
   *    a bay that already had a garrison on it that is zero — so `freeWindow` fell through to
   *    its one-station fallback and the entire cohort was assigned **one station**. Measured
   *    on the shipped tree: 149 men, `span` 1, ranks 0–142, 45 men at a single point.
   *    Ownership is a preference for *where to start*, not a fence. Two friendly units
   *    holding one stretch of wall stand among each other, which is what they do.
   *  - **Surplus is admitted and counted, not hidden.** A run seats `files * ranks` men. If
   *    the roster is larger — 160 men want 32 files and the shortest run on the circuit has
   *    14 — the remainder wraps evenly over the same places rather than piling on the last
   *    one, so the worst crush is `ceil(n / seats)` men deep and every man still has a
   *    distinct rank. `g.overflow` records how many the stone could not seat properly.
   *
   * Fill order is front rank first, unchanged: a wall is held at the parapet, and a
   * half-strength garrison should be one full line of men shooting, not two half lines.
   */
  private layOutOnWall(
    u: UnitGroupState, g: Garrison, centre: number, men: readonly number[],
    place?: (i: number) => boolean
  ): void {
    if (men.length === 0 || this.nStations === 0) return;
    const m = clamp(centre, 0, this.nStations - 1) | 0;
    const ranks = this.ranksOnRun(m);
    const bounds = this.runBounds(m);
    const runLen = bounds.hi - bounds.lo + 1;
    const want = Math.ceil(men.length / ranks);
    // The free window still chooses *where*: a unit sent onto a busy stretch prefers the
    // gap if the gap will hold it, and only overlaps its neighbours when it must.
    const free = this.freeWindow(m, bounds, u.id, want);
    const files = clamp(Math.max(want, free.span), 1, runLen);
    const from = clamp(free.from, bounds.lo, Math.max(bounds.lo, bounds.hi - files + 1));
    const seats = files * ranks;

    this.releaseClaim(g);
    g.from = from;
    g.span = files;
    g.ranks = ranks;
    g.overflow = Math.max(0, men.length - seats);
    for (let f = 0; f < files; f++) this.sOwner[clamp(from + f, bounds.lo, bounds.hi)] = u.id;

    for (let k = 0; k < men.length; k++) {
      const i = men[k];
      if (place && !place(i)) continue;
      // Wraps over the run's places when the roster is bigger than the stone. `seat` is
      // always inside `seats`, so `rank` is always inside the band and `slotAt` can never
      // be handed two ranks that resolve to one offset.
      const seat = k % seats;
      this.stationOf[i] = clamp(from + (seat % files), bounds.lo, bounds.hi);
      this.rankOf[i] = Math.min(255, Math.floor(seat / files));
    }
  }

  /**
   * Give back the stations a garrison currently holds.
   *
   * Only its own window, not a scan of the spine. A garrison shuffling one station along the
   * wall has to release before it re-claims or it finds its own slots occupied by itself,
   * and the obvious way to write that — sweep `sOwner` for this unit id — is 1,695 array
   * reads per re-layout, which happens every time any garrison loses six per cent of its
   * men. `from`/`span` already record exactly what was taken.
   */
  private releaseClaim(g: Garrison): void {
    for (let f = 0; f < g.span; f++) {
      const s = g.from + f;
      if (s >= 0 && s < this.nStations && this.sOwner[s] === g.unitId) this.sOwner[s] = -1;
    }
  }

  /**
   * The longest stretch of this run that no *other* living unit has claimed, nearest to
   * `want`.
   *
   * Ownership is by station and by unit id, so a friendly cohort sent onto a manned stretch
   * takes what is left rather than standing inside the men already there. An enemy claim is
   * ignored on purpose: taking a wall off somebody is not an allocation problem, it is a
   * melee, and the lodgement wants to land exactly where they are standing.
   */
  private freeWindow(
    want: number, bounds: { lo: number; hi: number }, unitId: number, need: number
  ): { from: number; span: number } {
    const b = this.battle;
    const mine = (s: number): boolean => {
      const o = this.sOwner[s];
      if (o < 0 || o === unitId) return true;
      const other = b.unitById(o);
      if (!other || other.destroyed || other.alive === 0) return true;
      const me = b.unitById(unitId);
      // Only a unit on the same side yields ground. See the note above.
      return !!me && other.faction !== me.faction;
    };
    let best = { from: bounds.lo, span: 0 };
    let bestScore = -Infinity;
    let s = bounds.lo;
    while (s <= bounds.hi) {
      if (!mine(s)) { s++; continue; }
      let e = s;
      while (e + 1 <= bounds.hi && mine(e + 1)) e++;
      const span = e - s + 1;
      // Prefer a window that can hold the unit and sits near where it was told to stand.
      const usable = Math.min(span, need);
      const centre = s + (span >> 1);
      const score = usable * 1000 - Math.abs(centre - want);
      if (score > bestScore) {
        bestScore = score;
        const from = clamp(want - (Math.min(span, need) >> 1), s, Math.max(s, e - Math.min(span, need) + 1));
        best = { from, span: Math.min(span, Math.max(need, 1)) };
      }
      s = e + 1;
    }
    if (best.span === 0) {
      // Nothing free at all. Stand on the requested station and let the crowd solver and the
      // melee sort it out; refusing the order outright would be worse.
      best = { from: clamp(want, bounds.lo, bounds.hi), span: 1 };
    }
    return best;
  }

  isGarrisoned(unitId: number): boolean {
    return this.garrisons.has(unitId);
  }

  /**
   * Is this unit *standing on the wall right now*, as opposed to having a record saying so?
   *
   * `garrisons.has(id)` survives a descent for as long as the plan does, and a plan survives
   * until its last man is down or `PLAN_TIMEOUT` fires ten minutes later. Every order given
   * in that window was read as a move along the parapet, so a cohort that had walked into the
   * city could not be sent back up it. Counting men is the only answer that cannot drift from
   * the thing it describes. See `ON_WALL_FRACTION`.
   */
  private standingOnWall(unitId: number): boolean {
    const u = this.battle.unitById(unitId);
    if (!u) return false;
    const p = this.battle.pool;
    let alive = 0;
    let up = 0;
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      alive++;
      if (this.stationOf[i] >= 0 || this.crossOf[i] !== -1) up++;
    }
    return alive > 0 && up >= alive * ON_WALL_FRACTION;
  }

  ownsUnit(unitId: number): boolean {
    return this.owned.has(unitId);
  }

  /**
   * Is this man on the stonework, or on a path onto it?
   *
   * `-1` is the only `stationOf` value that means the grass — `PENDING_SLOT` and `ON_LINK`
   * are both negative and both mean he is up. The same predicate `releaseBrokenCrews` uses
   * to decide whose `support` it may cut, published so `BattleSystem` can ask it about one
   * man instead of inferring it from his unit.
   */
  manOnStructure(index: number): boolean {
    return this.crossOf[index] !== -1 || this.stationOf[index] !== -1;
  }

  // -------------------------------------------------------------------------
  // The wall as somewhere you can be ordered
  // -------------------------------------------------------------------------

  /**
   * The station a click at `(x, z)` means, or -1 if the click did not mean the wall.
   *
   * The test is against the wall's **plan footprint** rather than a radius, because a radius
   * cannot tell "on the parapet" from "at the foot of it" and those are opposite orders. A
   * point counts if it is inside the standing band widened by `WALL_CLICK_BAND` either side
   * — about 4.9 m across a 3.5 m curtain — and within a station pitch of the run in plan.
   *
   * Public so the UI can ask before it commits to a cursor: see the patch in the report.
   */
  wallTargetAt(x: number, z: number): number {
    if (this.nStations === 0) return -1;
    const s = this.stationNear(x, z);
    if (s < 0 || this.dead(s)) return -1;
    const dx = x - this.sx[s];
    const dz = z - this.sz[s];
    const off = dx * this.snx[s] + dz * this.snz[s];
    // Along the wall, he must be beside a station and not off the end of the run.
    const along = Math.abs(-this.snz[s] * dx + this.snx[s] * dz);
    if (along > STATION_PITCH * 1.5) return -1;
    if (off < this.sInner[s] - WALL_CLICK_BAND || off > this.sOuter[s] + WALL_CLICK_BAND) return -1;
    return s;
  }

  /**
   * Which side of the wall a point is on: -1 inside the city, +1 out in the field.
   *
   * Published because the UI has to draw the same distinction the sim acts on. A click on
   * the parapet from inside means "walk up the stairs"; the same pixel with a besieging
   * cohort selected means "storm it", and the cursor has to be able to say which before the
   * player commits.
   */
  wallSideAt(x: number, z: number): -1 | 1 {
    return this.sideOf(x, z);
  }

  /** Which side of the wall a point is on: -1 inside the city, +1 out in the field. */
  private sideOf(x: number, z: number): -1 | 1 {
    const s = this.stationNear(x, z);
    if (s < 0) return 1;
    const off = (x - this.sx[s]) * this.snx[s] + (z - this.sz[s]) * this.snz[s];
    return off < 0 ? -1 : 1;
  }

  /** The run a man is standing on, or -1 for the ground. */
  private runOfMan(i: number): number {
    const st = this.stationOf[i];
    if (st < 0 || st >= this.nStations) return -1;
    return this.sRun[st];
  }

  /**
   * Order a unit that is on the ground up onto the wall, by the nearest stair.
   *
   * Nothing teleports. The unit becomes siege-owned so its men are steered to absolute
   * slots, they walk to the foot of a flight, they go up it one at a time in file, and they
   * form a garrison as they arrive. Returns false when there is no wall there or no stair
   * that reaches it — a caller should degrade that to an ordinary move rather than silently
   * eat the order.
   */
  sendToWall(u: UnitGroupState, x: number, z: number): boolean {
    const dest = this.wallTargetAt(x, z) >= 0 ? this.wallTargetAt(x, z) : this.stationNear(x, z);
    if (dest < 0 || this.dead(dest)) return false;
    const destRun = this.sRun[dest];
    const stair = this.nearestStairLink(u.x, u.z, destRun);
    if (stair < 0) return false;
    this.owned.add(u.id);
    if (!this.garrisons.has(u.id)) {
      this.garrisons.set(u.id, {
        unitId: u.id, from: dest, span: 1, ranks: MAX_WALL_RANKS,
        plannedFor: -1, sticky: false, filled: 0, overflow: 0, lastTx: u.x, lastTz: u.z,
      });
    }
    u.order = UnitOrder.Garrison;
    u.targetUnitId = -1;
    u.waypoints.length = 0;
    u.contactLock = false;
    this.plans.set(u.id, {
      goal: WallGoal.Ascend, destStation: dest, destRun, stair, gx: x, gz: z, age: 0, stuck: 0,
    });
    return true;
  }

  /**
   * Order a unit already on the wall to another stretch of it.
   *
   * The unit walks: along its own run to the tower at the end of it, through the chamber,
   * out onto the next run, and so on until it reaches the one it was sent to. Every hop is a
   * crossing, so a cohort redeploying six bays along the curtain files through five towers
   * and takes about four minutes, which is what it should cost.
   */
  moveAlongWall(u: UnitGroupState, x: number, z: number): boolean {
    if (!this.garrisons.has(u.id)) return false;
    const dest = this.wallTargetAt(x, z);
    if (dest < 0) return false;
    const destRun = this.sRun[dest];
    /**
     * Refuse a run the wall does not join to this one.
     *
     * The runs are a chain — run k abuts run k+1 across a tower or a construction step and
     * nothing else — so a missing link anywhere between here and there is a gap no man can
     * cross, and `nextHop` returns -1 for every man on every tick. The order used to be
     * accepted anyway: measured, **152 of 152 men frozen and the plan still open at age
     * 3,656**, with nothing said to the player at any point. An order that cannot be carried
     * out has to be refused where it is given.
     */
    const here = this.stationNear(u.x, u.z);
    const fromRun = here >= 0 ? this.sRun[here] : -1;
    if (!this.runsConnected(fromRun, destRun)) return false;
    this.plans.set(u.id, {
      goal: WallGoal.Traverse, destStation: dest, destRun, stair: -1, gx: x, gz: z, age: 0, stuck: 0,
    });
    // A unit walking somewhere else must be free to re-form when it gets there, even if it
    // arrived as a boarding party. Stickiness is a property of a lodgement, not of a unit.
    const g = this.garrisons.get(u.id);
    if (g) g.sticky = false;
    return true;
  }

  /**
   * Order a unit off the wall to a point on the ground, by the nearest stair.
   *
   * This is the half of the feature the player asked for twice: draw the archers back so the
   * infantry can go up, and — from the other side — an attacker who has taken the wall comes
   * down off it into the streets. Once every man is down the unit stops being siege-owned
   * and goes back to being an ordinary formation, which is exactly right: it is in the city
   * now, and the city is ground.
   */
  sendToGround(u: UnitGroupState, x: number, z: number): boolean {
    if (!this.garrisons.has(u.id)) return false;
    // The stair is chosen from where the unit *is*, not from where it is going: a garrison
    // told to fall back walks to the nearest way down, not to the one nearest the rally
    // point forty bays away.
    const here = this.stationNear(u.x, u.z);
    const stair = this.nearestStairLink(u.x, u.z, here >= 0 ? this.sRun[here] : -1);
    if (stair < 0) return false;
    this.plans.set(u.id, {
      goal: WallGoal.Descend, destStation: -1, destRun: this.links[stair].runB,
      stair, gx: x, gz: z, age: 0, stuck: 0,
    });
    const g = this.garrisons.get(u.id);
    if (g) g.sticky = false;
    return true;
  }

  /**
   * What this unit could climb at `(x, z)`, and why it could not.
   *
   * **One predicate, shared.** `escalade` acts on this and `escaladeOfferAt` draws it, so the
   * cursor cannot promise a storm the simulation will not perform. That promise is exactly
   * what a playtest caught: a storm order given at a bay with no ladder and no ramp within
   * reach was *accepted* by the cursor, dropped in silence by `escalade`'s bare `return
   * false`, and the cohort then read "Garrison · Steady" standing in an open field. From the
   * player's chair a refusal nobody mentions is indistinguishable from a bug.
   *
   * The refusals are distinguished because they are different sentences with different
   * answers. "Nothing to climb here" means bring a machine or pick another bay; "every file
   * at that bay is full" means wait or pick another bay; "this unit is working a machine of
   * its own" means it is not free to go and never will be while it has one.
   */
  private findEscalade(unitId: number, x: number, z: number): {
    refusal: 'none' | 'crew' | 'noWall' | 'noWay' | 'full' | 'notFoot';
    kind: 'tower' | 'ladder' | null;
    tower: SiegeTower | null;
    group: Ladder[] | null;
    station: number;
    distance: number;
  } {
    const none = (refusal: 'crew' | 'noWall' | 'noWay' | 'full' | 'notFoot', station = -1) =>
      ({ refusal, kind: null, tower: null, group: null, station, distance: Infinity } as const);
    /*
     * A gang with a machine that still needs working is not free to go up anything.
     *
     * Sending the ram crew up a ladder would abandon the ram in the carriageway, which is the
     * failure this workstream has already fixed once. What this must *not* do is refuse men
     * whose machine is finished with them: `crewsAMachine` used to mean "was this unit ever
     * given a machine", so every tower party, ram crew and escalade party in the army was
     * refused for the whole battle. On Carthage the units nearest the wall are all machine
     * crews, and a ladder party — whose ladder is planted and needs nobody — was refused the
     * one order it exists to be given, in silence, while the cursor read "Storm the wall
     * here". See `machineWithWork`.
     */
    if (this.crewsAMachine(unitId)) return none('crew');
    /**
     * A horse does not climb a ladder, and neither does a cart.
     *
     * Reported from a hand run with a number on it: **26 horsemen standing on the parapet**,
     * and ballistae admitted to a boarding file as well. `escalade` asked whether there was a
     * machine within reach and never whether the unit could use one, so any unit type in the
     * game could be enrolled — which on Carthage is easy to do by accident, because the units
     * nearest the wall are cavalry screens.
     *
     * Tested on `unitClass` rather than on a list of type ids, so a new mounted or wheeled
     * unit is excluded the day it is added instead of the day somebody notices.
     */
    if (!this.mayClimb(unitId)) return none('notFoot');
    const dest = this.wallTargetAt(x, z) >= 0 ? this.wallTargetAt(x, z) : this.stationNear(x, z);
    if (dest < 0) return none('noWall');
    const u = this.battle.unitById(unitId);
    if (!u) return none('noWall', dest);

    let bestKind: 'tower' | 'ladder' | null = null;
    let bestD = Infinity;
    let bestTower: SiegeTower | null = null;
    let bestGroup: Ladder[] | null = null;
    /** Something was in reach but its file was full — a different sentence from "nothing". */
    let sawFull = false;

    for (const t of this.towers) {
      // A machine still trundling across the glacis is a promise; one whose ramp is down is
      // a road. Both count — the men walk out with it and go up when it lands — but a spent
      // one does not.
      if (t.state === TowerState.Spent) continue;
      if (Math.abs(t.station - dest) > ESCALADE_REACH) continue;
      if (t.boarders.length >= MAX_BOARDING_UNITS && !t.boarders.includes(unitId)) {
        sawFull = true;
        continue;
      }
      const d = Math.sqrt((t.x - u.x) * (t.x - u.x) + (t.z - u.z) * (t.z - u.z));
      if (d < bestD) { bestD = d; bestKind = 'tower'; bestTower = t; bestGroup = null; }
    }
    for (const l of this.ladders) {
      if (Math.abs(l.station - dest) > ESCALADE_REACH) continue;
      if (l.boarders.length >= MAX_BOARDING_UNITS && !l.boarders.includes(unitId)) {
        sawFull = true;
        continue;
      }
      const d = Math.sqrt((l.x - u.x) * (l.x - u.x) + (l.z - u.z) * (l.z - u.z));
      if (d < bestD) {
        bestD = d;
        bestKind = 'ladder';
        bestTower = null;
        bestGroup = this.ladders.filter((k) => k.unitId === l.unitId);
      }
    }
    if (bestKind === null) return none(sawFull ? 'full' : 'noWay', dest);
    return { refusal: 'none', kind: bestKind, tower: bestTower, group: bestGroup,
      station: dest, distance: bestD };
  }

  /**
   * Whether a storm order at `(x, z)` would be obeyed, for the cursor to say so first.
   *
   * Pure. The UI's whole job here is to stop offering an order the sim will drop; see
   * `findEscalade` for the report this came out of.
   */
  escaladeOfferAt(unitId: number, x: number, z: number): {
    ok: boolean; refusal: string; kind: 'tower' | 'ladder' | null; bay: number;
    /**
     * Whether the thing they would climb is a road yet or still a promise.
     *
     * A tower still trundling across the glacis is a legal escalade target — the men walk out
     * with it and go up when its ramp falls — and that is *why* a cohort given a storm order
     * ends up standing in an open field with nothing apparently happening. It is queueing,
     * correctly, for a machine a hundred metres away. Nothing was wrong except that nobody
     * said so, which is the same defect as the silent refusal wearing better clothes.
     */
    ready: boolean;
    /** Metres the machine still has to roll before anyone can climb it. */
    machineDistance: number;
    /** And how long that is. */
    machineSeconds: number;
  } {
    const f = this.findEscalade(unitId, x, z);
    const t = f.tower;
    const run = t ? Math.sqrt((t.dockX - t.x) * (t.dockX - t.x) + (t.dockZ - t.z) * (t.dockZ - t.z)) : 0;
    return {
      ok: f.refusal === 'none',
      refusal: f.refusal,
      kind: f.kind,
      bay: f.station >= 0 && f.station < this.nStations ? this.sBay[f.station] : -1,
      // A ladder is raised where it stands, so it is a road the moment it exists; a tower is
      // one only once its ramp is on the parapet.
      ready: f.kind === 'ladder' || (!!t && t.state !== TowerState.Approach),
      machineDistance: run,
      machineSeconds: run / TOWER_SPEED + (t ? Math.max(0, t.heave) : 0),
    };
  }

  /**
   * Order a unit standing in the field up onto the wall by whatever is leaning on it.
   *
   * The mirror of `sendToWall`, and the half that did not exist. A besieger is not entitled
   * to walk up the defenders' stairs — he comes over a ramp, up a ladder or through a
   * breach — and until now `interceptOrders` enforced the first clause and had nothing to
   * offer for the second, so a click on the enemy parapet from the storming side was
   * silently discarded. From the player's chair that is indistinguishable from the feature
   * not existing, which is exactly how it was reported.
   *
   * Enrolment is on a *bank* of ladders rather than one rail, because `musterOwned`
   * round-robins a party's ladders and admission must agree with the muster or men queue at
   * a foot they are not allowed to climb.
   *
   * Returns false when there is no practicable way up within `ESCALADE_REACH` of the point,
   * which a caller should degrade to an ordinary move — standing at the foot of a wall you
   * cannot climb is a real order and this must not eat it.
   */
  escalade(u: UnitGroupState, x: number, z: number): boolean {
    const found = this.findEscalade(u.id, x, z);
    if (found.refusal !== 'none') return false;
    const bestTower = found.tower;
    const bestGroup = found.group;

    // A unit cannot be queuing at two machines at once, and it cannot be halfway up a stair
    // either. Take it off whatever it was doing first — every file except the one it is
    // joining, which it may already be at the head of. See `dropFromFiles`.
    this.dropFromFiles(
      u.id, bestTower ? [bestTower.boarders] : bestGroup!.map((l) => l.boarders), true);
    this.plans.delete(u.id);

    const enrol = (list: number[]): void => { if (!list.includes(u.id)) list.push(u.id); };
    if (bestTower) enrol(bestTower.boarders);
    else for (const l of bestGroup!) enrol(l.boarders);

    this.owned.add(u.id);
    /*
     * Reclaim the order for the same reason every other wall verb does: these men are placed
     * by `musterOwned` from now on, and leaving the unit on `MoveTo` would have
     * `steerToSlots` and the formation path writing the same slots on alternate ticks.
     */
    u.order = UnitOrder.Garrison;
    u.targetUnitId = -1;
    u.waypoints.length = 0;
    u.contactLock = false;
    return true;
  }

  /**
   * Take a unit off every machine it was queuing at.
   *
   * Public because there was no way to countermand a siege order at all — see the note on
   * `cancelWallPlan` — and because `escalade` needs it internally to keep the invariant that
   * a unit appears in at most one boarder list.
   *
   * The crew of a machine is never released this way: `boarders[0]` is the gang, and a gang
   * that stops being enrolled stops pushing.
   *
   * **That rule survived an attempt to relax it, and the measurement is why it is written
   * down twice.** The obvious improvement, once a docked tower's gang could be ordered
   * about, was to let the crew slot go for any machine that no longer needs a gang — a
   * planted ladder needs nobody, so a ladder party could finally be countermanded off its
   * own rails. What that missed is *who calls this*. `interceptOrders` calls it for **any**
   * move order whose destination is not a wall point, and on an AI-driven assault that is
   * every routine repositioning order the army gives. Measured on the Carthage assault under
   * the determinism harness: every ladder went from `boarders: [18]` to `boarders: []`
   * within thirty seconds, the four escalade parties were dropped from `owned`, and **327
   * men who cross the rails by t+91 became 0 men, ever**. The whole escalade stopped
   * happening and 191 more men were alive at t+200 because nobody was climbing into the
   * killing ground.
   *
   * So the generic countermand keeps every crew where it is, and the one caller that has
   * earned the right to move a gang — `escalade`, which is about to enrol it somewhere else
   * on purpose — asks for that explicitly. See `dropFromFiles`.
   */
  releaseEscalade(unitId: number): boolean {
    return this.dropFromFiles(unitId, null, false);
  }

  /**
   * `releaseEscalade`, with two things the generic countermand must not do.
   *
   * `keep` is the file the unit is about to join. `escalade` releases before it enrols and
   * `enrol` pushes at the *back*, so without this, re-issuing a storm order at the bank a
   * party is already queuing on takes it out of its place and puts it behind everyone who
   * arrived later — and takes a gang out of the head of its own boarding file for pointing
   * at the bay its own ramp is on. That is the queue-index trap this file has paid for three
   * times: a place in a file is a fact about the man, not a side effect of the order that
   * put him there.
   *
   * `freeCrew` is the permission to give up a crew slot at all, and only `escalade` has it.
   * It is safe there and nowhere else, because `findEscalade` refuses any unit whose machine
   * still has work in it (`crewsAMachine`), so the only gangs that reach this call are ones
   * whose machine is finished with them — a planted ladder's party, or a tower's gang after
   * the ramp is down.
   */
  private dropFromFiles(unitId: number, keep: number[][] | null, freeCrew: boolean): boolean {
    let found = false;
    const drop = (list: number[]): void => {
      if (keep !== null && keep.includes(list)) return;
      const k = list.indexOf(unitId);
      if (k < 0 || (k === 0 && !freeCrew)) return;
      list.splice(k, 1);
      found = true;
    };
    for (const t of this.towers) drop(t.boarders);
    for (const l of this.ladders) drop(l.boarders);
    return found;
  }

  /**
   * May this unit hold a place in a boarding file?
   *
   * **A broken party at the head of a file blocks everyone behind it, and that is how a
   * feature that measured green stopped working.** `musterOwned` lays the file out and
   * `stepCrossing` admits from it, and the two used different tests: admission skipped a
   * routing unit, the layout did not. So a routed escalade party went on occupying rows 0-14
   * at the foot of its own ladders while refusing to climb them, and the cohort the player
   * had sent was laid out behind it — measured at **14.6 m from a mouth with a 1.6 m
   * admission radius**, frozen there for the whole battle. That is the queue-index defect
   * that broke wall descent wearing different clothes: a place in a file handed to a man who
   * is never going to use it.
   *
   * Same shape as the ram's rule and for the same reason: a machine is a thing you abandon.
   */
  private mayBoard(u: UnitGroupState | undefined): u is UnitGroupState {
    return !!u && !u.destroyed && u.alive > 0 && u.order !== UnitOrder.Rout
      && this.mayClimb(u.id);
  }

  /**
   * Has this unit stopped being able to work a machine or hold a place in its file?
   *
   * The one predicate behind all three of "the siege is still driving men who have broken":
   * the ram crew that fled while the ram went on rolling, the tower gang, and the escalade
   * party that stood at the foot of its own ladders playing a run cycle. Each of those was
   * written out longhand at its own call site, and the three copies did not agree.
   *
   * Deliberately **not** `!mayBoard(u)`. That is a type predicate, so its false branch
   * narrows `u` to `undefined` — which is exactly wrong here, because a live unit that is
   * merely routing is the case this exists for and its men are the ones to let go of. It is
   * also a different question: `mayBoard` additionally asks whether a man *can* climb, and
   * a squadron of horse is not broken merely because it cannot go up a ladder.
   */
  private broken(u: UnitGroupState | undefined): boolean {
    return !u || u.destroyed || u.alive === 0 || u.order === UnitOrder.Rout;
  }

  /**
   * Whether this unit's men can go up a ladder or a boarding ramp at all.
   *
   * Foot only. Cavalry cannot lead a horse up eight metres of rungs and a wheeled engine
   * cannot be carried up at all, and both were being admitted — a hand run put twenty-six
   * horsemen on the wall-walk. Shared with `mayBoard`, which is the predicate `stepCrossing`
   * admits by and `updateTowers` decides an empty file by, so a unit that cannot climb is
   * never queued for, never waited on and never let on.
   */
  private mayClimb(unitId: number): boolean {
    const u = this.battle.unitById(unitId);
    if (!u) return false;
    const cls = this.battle.typeOf(u).unitClass;
    return cls !== 'artillery' && cls !== 'heavy-cavalry' && cls !== 'light-cavalry';
  }

  /**
   * Take every routed unit off one machine's boarder list, crew excepted.
   *
   * Men already on the rungs keep going: `advanceQueue` does not read the list, and pulling
   * a climbing man off a ladder because his cohort broke would drop him eight metres.
   */
  private dropBrokenBoarders(list: number[]): void {
    for (let k = list.length - 1; k > 0; k--) {
      const u = this.battle.unitById(list[k]);
      if (u && !u.destroyed && u.alive > 0 && u.order !== UnitOrder.Rout) continue;
      const id = list[k];
      list.splice(k, 1);
      // Only let go of him entirely once no other machine still has him and he is not a
      // garrison somewhere: `owned` is one set across the whole siege.
      if (this.garrisons.has(id) || this.crewsAMachine(id) || this.isBoarder(id)) continue;
      this.owned.delete(id);
      if (!u) continue;
      for (const i of u.members) {
        if (this.crossOf[i] !== -1 || this.stationOf[i] >= 0) continue;
        this.battle.elevated[i] = 0;
        this.battle.support[i] = NO_SUPPORT;
      }
    }
  }

  /** True while any machine still has this unit in its boarding file. */
  private isBoarder(unitId: number): boolean {
    for (const t of this.towers) if (t.boarders.includes(unitId)) return true;
    for (const l of this.ladders) if (l.boarders.includes(unitId)) return true;
    return false;
  }

  /** The tower this unit's gang pushes, or null. */
  private towerOf(unitId: number): SiegeTower | null {
    for (const t of this.towers) if (t.unitId === unitId) return t;
    return null;
  }

  /**
   * The ram this unit's gang works, or null.
   *
   * A wreck is deliberately still returned. It is the crew's machine right up until they are
   * given another one, and the honest answer to "send it there" is a refusal that says the
   * thing is burnt, not the silence you get from pretending they crew nothing.
   */
  private ramOf(unitId: number): SiegeRam | null {
    for (const r of this.rams) if (r.unitId === unitId) return r;
    return null;
  }

  /**
   * The machine this unit's gang **still has work at**, or null — the one predicate behind
   * "is this man a crew, or is he infantry standing somewhere".
   *
   * This used to be `crewsAMachine`, and it asked a question one word away from this one:
   * *has this unit ever been given a machine*. A tower's `unitId` is written at spawn and
   * never cleared, so the answer stayed true for the rest of the battle — and that single
   * word is the owner's report. Once a tower has docked and put its ramp on the parapet,
   * its gang is eighty men standing on a wall; the game went on treating them as a crew,
   * answered every right-click with a sentence about the machine, and refused it. Measured
   * on Carthage at t+290, with all seventy-eight of unit 14's men on the walk of run 20 and
   * `isGarrisoned` true: `machineOrderAt` returned `refusal: 'spent'`, the cursor read
   * `refuse`, and the hint read *"The siege tower has finished its work"* over a cohort the
   * simulation was perfectly willing to march along the parapet.
   *
   * So the test is **work left**, per machine kind, and each answer is the window in which
   * the machine can still be given a destination *and* still needs the gang to give it one:
   *
   *  - **A tower** while it is on `Approach`. Past that it is landing its ramp on the bay it
   *    is over and no order will ever be accepted again — every branch of
   *    `resolveTowerOrder` from `Docking` on is a refusal — so there is nothing left for the
   *    gang to command and nothing left for them to push.
   *  - **A ram** while it is a weapon rather than a wreck or a parked machine. Unchanged in
   *    meaning; the `wreck` clause was already here, and `Withdrawing`/`Spent` join it
   *    because `resolveRamOrder` already refuses both with `spent`.
   *  - **A ladder, never.** It is planted where `spawnLadder` raises it and needs nobody to
   *    hold it up. The party that raised it is only ever *first in the file*, which is a
   *    place in a queue and not a job — and treating it as a job is what made every escalade
   *    party in the game unable to be given the one order it exists for. See `findEscalade`.
   */
  private machineWithWork(unitId: number): SiegeMachineKind | null {
    const t = this.towerOf(unitId);
    if (t) return t.state === TowerState.Approach ? 'tower' : null;
    const r = this.ramOf(unitId);
    if (!r) return null;
    if (r.wreck || r.state === RamState.Wreck) return null;
    if (r.state === RamState.Withdrawing || r.state === RamState.Spent) return null;
    return r.kind === RamKind.Great ? 'greatRam' : 'ram';
  }

  /** True when this unit is somebody's gang and that machine still has work for it. */
  private crewsAMachine(unitId: number): boolean {
    return this.machineWithWork(unitId) !== null;
  }

  /**
   * What this unit is to the siege train right now, for the cursor to ask before it draws.
   *
   * **Pure, and published for the same reason `machineOrderAt` and `escaladeOfferAt` are.**
   * The UI has to decide, every frame, whether the men under the cursor are a crew — whose
   * sentence is about a machine — or infantry, whose sentence is about the ground. It had no
   * way to ask, so it inferred it from `machineDestinationOf` returning non-null, which is a
   * different question and answered yes for ever.
   *
   * `crew` and `commands` are deliberately two fields. A tower's gang whose machine has
   * docked is still that machine's gang — they are `boarders[0]`, they will be first up their
   * own ramp, and `SiegeOrders` should not draw a berth marker for a machine that has
   * arrived — but they no longer command it, and every order a player gives them is an order
   * about men.
   */
  crewStatusOf(unitId: number): SiegeCrewStatus {
    const commands = this.machineWithWork(unitId) !== null;
    const t = this.towerOf(unitId);
    const r = this.ramOf(unitId);
    const kind: SiegeCrewStatus['kind'] = t ? 'tower'
      : r ? (r.kind === RamKind.Great ? 'greatRam' : 'ram')
      : this.ladders.some((l) => l.unitId === unitId) ? 'ladder' : null;
    // `done` is only about a machine that *could* be aimed and no longer can. A ladder is
    // planted where it was raised and never took a destination, so its party is a crew that
    // commands nothing and has finished nothing.
    let done: SiegeCrewStatus['done'] = '';
    if (!commands && t) done = t.state === TowerState.Spent ? 'spent' : 'landed';
    else if (!commands && r) done = 'spent';
    return { crew: kind !== null, commands, kind, done };
  }

  /**
   * Point a tower at a stretch of wall, and cut its ramp to the span it will have to bridge.
   *
   * Every number a docked tower depends on is solved here from the bay it is aimed at, and
   * it is one function rather than two so that `orderTowerTo` cannot dock to a different
   * standard than `spawnTower` does. The measured contract is 0.32 m of daylight between the
   * front face and the masonry and a ramp lip level with the walk; both fall out of this.
   */
  private aimTowerAt(t: SiegeTower, station: number): void {
    const nx = this.snx[station];
    const nz = this.snz[station];
    /**
     * Where the tower's centre stops, measured out from the bay centreline.
     *
     * Its *front face* must end up just clear of the wall's outer face — `sFace` — and the
     * face is `TOWER_HALF_D` ahead of the centre. The first version used a flat 1.05 m
     * clearance from the centreline instead of from the face, which put the front of the
     * machine 0.70 m inside the brickwork: measured, on all four towers, as `faceGap`
     * −0.70. It also overshot the ramp, because the hinge was then too far in for the
     * 3.4 m ramp to land anywhere but off the back of the wall.
     *
     * 0.32 m of clearance is a hand's breadth of daylight — enough that the machine does
     * not visibly intersect the masonry, close enough that the ramp bridges the parapet.
     */
    const standoff = this.sFace[station] + 0.32 + TOWER_HALF_D;
    t.station = station;
    t.wantFacing = Math.atan2(-nx, -nz);
    t.dockX = this.sx[station] + nx * standoff;
    t.dockZ = this.sz[station] + nz * standoff;
    /**
     * Deck height: 0.55 m above the wall-walk, which is 1.5 m *below* the merlon tops.
     *
     * This is knowingly wrong and is reverted work. A blind critic judging the machine
     * observed that "the platform floor sits at the base of the merlons with the roof below
     * their tops — an assaulting soldier would have to climb out and over unaided", and it
     * is right: a tower should deliver men onto the wall from above its defences.
     *
     * Raising it to `sCrest + 0.3` with a 4.2 m ramp docked and measured correctly — deck
     * 45.25 against a walk at 42.90, ramp head level with the walk to within a centimetre —
     * but boarding then stopped dead: four towers in `boarding` state, every crew alive and
     * standing on its muster point 0.5 m from the mouth of the crossing, and not one man
     * admitted to the path. I could not find the cause by inspection inside the time I had,
     * and a tower that looks better and delivers nobody is worse than one that looks squat
     * and works. The probe assertion `infantry cross the ramp onto the wall` is what caught
     * it and is what should guard the retry.
     */
    t.deckY = this.sy[station] + 0.55;
    /**
     * Cut the ramp to the span it will actually have to bridge.
     *
     * The hinge ends up `sFace + 0.32` out from the bay centreline and the lip has to reach
     * the outward limit of the standing band, so the horizontal reach is fixed by the wall
     * and the standoff between them — 1.64 m on this curtain, not the 3.4 m the geometry is
     * authored at. Measured: a correctly-yawed 3.4 m ramp overshoots the walkway's cityward
     * lip by 1.6 m and cantilevers over the street.
     *
     * Solved rather than tuned, and solved from the *bay*, so the wall workstream widening
     * the curtain moves this with it instead of breaking it.
     */
    const hingeOff = this.sFace[station] + 0.32;
    t.rampReach = Math.max(0.6, hingeOff - this.sOuter[station]);
    const drop = this.sy[station] - t.deckY;
    t.rampLen = Math.sqrt(t.rampReach * t.rampReach + drop * drop);
    t.rampLanded = Math.atan2(drop, t.rampReach);
  }

  /**
   * Send a tower at a stretch of wall the player has chosen.
   *
   * The third of the owner's three complaints: *"the siege towers, you cannot choose where
   * they attack — they always go to their predetermined destination"*. `dockX/dockZ` was
   * written once at spawn and never again, so the scenario picked the bay and the player
   * watched.
   *
   * Three refusals, and they are the character of the machine rather than caution. Fifteen
   * tonnes of green timber on rollers is **committed**: once the ramp has started to fall it
   * is landing on the bay it is over (`state !== Approach`), and inside the last
   * `TOWER_COMMIT` metres the gang is lining it up on the masonry and will not be turned. A
   * re-aim that does clear those buys a `TOWER_HEAVE` halt while the gang shifts the rollers
   * and levers the frame round — during which the machine slews toward its new bearing and
   * does not advance a metre. That is the cost of changing your mind about a tower, and it
   * is what stops the thing behaving like a unit that pivots.
   */
  orderTowerTo(u: UnitGroupState, x: number, z: number): boolean {
    const o = this.resolveMachineOrder(u.id, x, z);
    if (!o || o.kind !== 'tower' || !o.ok) return false;
    return this.applyMachineOrder(o);
  }

  /**
   * Send a ram at a gate the player has chosen — or, for the great ram, at a stretch of
   * curtain.
   *
   * The second half of the owner's ask: *"making the battering ram go wherever you want"*.
   * `spawnRam` read `getGates()[0]` and nothing ever wrote the target again, so the machine
   * was aimed once at whichever gate the city happened to publish first and the player had no
   * say at all. That is a real limitation and not a theoretical one: Rome has one gate, but
   * **Carthage has three** — Byrsae, Uticensis and Maritima — and the assault could only ever
   * be delivered against the first of them.
   *
   * A ram is lighter than a tower and it is a shed, not a fifteen-tonne frame, so it is
   * cheaper to change your mind about: `RAM_HEAVE` is six seconds against the tower's
   * fourteen and it will take a new bearing right up until it has finished. What it will not
   * do is go back to work once it has withdrawn — a spent machine has been hauled clear on
   * purpose and dragging it back into the carriageway it just cleared is the corking bug the
   * withdrawal exists to prevent.
   */
  orderRamTo(u: UnitGroupState, x: number, z: number): boolean {
    const o = this.resolveMachineOrder(u.id, x, z);
    if (!o || o.kind === 'tower' || !o.ok) return false;
    return this.applyMachineOrder(o);
  }

  /**
   * What a right-click at `(x, z)` would do to whatever machine this unit crews, or null if
   * it crews none. **Pure — it moves nothing.**
   *
   * This is the half the owner could not see. The mechanic existed and worked; what a player
   * got for hovering the bay they were about to send fifteen tonnes of timber at was the same
   * "Storm the wall here" cursor a cohort of the line gets, and what they got for a refused
   * order was nothing whatsoever. Both halves now come out of `resolveMachineOrder`, so the
   * sentence under the cursor is produced by the same code that will or will not obey it.
   */
  machineOrderAt(unitId: number, x: number, z: number): SiegeMachineOrder | null {
    return this.resolveMachineOrder(unitId, x, z);
  }

  /**
   * Where a machine is already going, so the UI can draw the standing order.
   *
   * Not the same question as `machineOrderAt`, which is about a point the cursor is over.
   * A player who has just sent a tower down the wall needs to be able to look away and look
   * back and still see where it is bound; that is the difference between an order that
   * happened and an order you can tell happened.
   */
  machineDestinationOf(unitId: number): SiegeMachineOrder | null {
    // Same gate as `resolveMachineOrder`, and it has to be: this is what the HUD counts to
    // decide a selected unit is a crew at all, so a machine that has arrived must stop
    // answering here too or the men go on being drawn a berth they are already standing on.
    if (!this.crewsAMachine(unitId)) return null;
    const t = this.towerOf(unitId);
    if (t) {
      const d = this.describe('tower', t.id, unitId, t.station, '', t.dockX, t.dockZ,
        Math.sqrt((t.dockX - t.x) * (t.dockX - t.x) + (t.dockZ - t.z) * (t.dockZ - t.z)), 'none');
      // Its *remaining* run, not the cost of a fresh order: the heave it is part way through
      // is `t.heave`, and quoting a full one on a machine already rolling would be a lie.
      d.seconds = d.distance / TOWER_SPEED + Math.max(0, t.heave);
      return d;
    }
    const r = this.ramOf(unitId);
    if (!r) return null;
    const kind: SiegeMachineKind = r.kind === RamKind.Great ? 'greatRam' : 'ram';
    const d = this.describe(kind, r.id, unitId, r.station, r.gateId, r.targetX, r.targetZ,
      Math.sqrt((r.targetX - r.x) * (r.targetX - r.x) + (r.targetZ - r.z) * (r.targetZ - r.z)), 'none');
    d.seconds = d.distance / RAM_SPEED + Math.max(0, r.heave);
    return d;
  }

  /**
   * Queue a player's machine order for the next tick.
   *
   * **Not applied here**, and that is the whole reason this method exists rather than the UI
   * calling `orderTowerTo` straight. A mouse event arrives in `update`, at whatever rate the
   * frame is running; every mutation of the simulation has to happen inside `fixedUpdate` or
   * the battle stops replaying identically. `Siege` already buffers the player's ordinary
   * move orders exactly this way (see `ordered`), and this is the same arrangement for the
   * orders that have no `orderIssued` shape — "beat on *that* gate" is not a move order and
   * pretending it is one is what left the ram unaimable in the first place.
   *
   * Deliberately player-only. `src/ai/Orders.ts` emits `orderIssued` through the same channel
   * the mouse does, so a machine verb wired into `interceptOrders` is a verb the AI can fire
   * as well — and an AI that drags the ram off the gate every few seconds is worse than no
   * order at all.
   */
  requestMachineOrder(unitId: number, x: number, z: number): void {
    this.machineOrders.push({ unitId, x, z });
  }

  /** Player machine orders waiting for the next tick. See `requestMachineOrder`. */
  private machineOrders: { unitId: number; x: number; z: number }[] = [];

  /** Fill in one order description. Every field the UI reads comes through here. */
  private describe(
    kind: SiegeMachineKind, machineId: number, unitId: number, station: number,
    gateId: string, x: number, z: number, distance: number, refusal: SiegeRefusal
  ): SiegeMachineOrder {
    const tower = kind === 'tower';
    const speed = tower ? TOWER_SPEED : RAM_SPEED;
    return {
      kind, machineId, unitId,
      ok: refusal === 'none',
      refusal,
      x, z,
      y: this.battle.groundAt(x, z),
      station,
      bay: station >= 0 && station < this.nStations ? this.sBay[station] : -1,
      gateId,
      distance,
      seconds: distance / speed + (tower ? TOWER_HEAVE : RAM_HEAVE),
    };
  }

  /**
   * The one predicate. What a right-click at `(x, z)` means for this unit's machine.
   *
   * Both the cursor and the order call this and nothing else calls anything else. The trap
   * this is written against has been paid for three times in this repo — most recently
   * `musterOwned` and `stepCrossing` disagreeing about which men were in a file, which froze
   * the player's cohort 14.6 m from a 1.6 m admission radius — and it is always the same
   * shape: two pieces of code answering one question with two slightly different tests.
   */
  private resolveMachineOrder(unitId: number, x: number, z: number): SiegeMachineOrder | null {
    /**
     * A gang whose machine has finished is not answered about the machine at all.
     *
     * `null` and a refusal are two different things and the difference is the owner's
     * report. A refusal means *this order, here, no* — the tower is committed, the bay is
     * taken, a ram cannot break masonry — and it is worth a sentence and a cursor, because
     * a different click would be obeyed. `null` means *this is not a machine question*, and
     * it is what has to come back once no click anywhere on the map would be obeyed: the
     * ramp is down, the men are on the wall, and the thing the player is pointing at is
     * ground for them to walk on. Answering `refusal: 'landed'` for the rest of the battle
     * put a red no-entry cursor and *"Too late — the ramp is down on bay 31"* over eighty
     * men the simulation would have marched anywhere they were sent.
     *
     * Gated here rather than in `machineOrderAt` so that `orderTowerTo`, `orderRamTo`,
     * `interceptOrders` and the cursor all stop at the same line. One predicate, shared —
     * the same rule the rest of this function was written for.
     */
    if (!this.crewsAMachine(unitId)) return null;
    const t = this.towerOf(unitId);
    if (t) return this.resolveTowerOrder(t, x, z);
    const r = this.ramOf(unitId);
    if (r) return this.resolveRamOrder(r, x, z);
    return null;
  }

  /**
   * Where a tower would go, and the three reasons it would not.
   *
   * The refusals are the machine's character and they are listed in the order they bite:
   * a spent tower is scenery, a docking one is landing its ramp on the bay it is over, and
   * one inside `TOWER_COMMIT` is being squared on the masonry by eye. The fourth — `taken` —
   * is new, and it answers the question the mechanic never had an answer for: two towers
   * ordered onto one bay used to both accept and then be drawn through each other.
   */
  private resolveTowerOrder(t: SiegeTower, x: number, z: number): SiegeMachineOrder {
    const here = (refusal: SiegeRefusal, station = t.station): SiegeMachineOrder =>
      this.describe('tower', t.id, t.unitId, station, '', t.dockX, t.dockZ, t.dist, refusal);

    const onWall = this.wallTargetAt(x, z);
    const station = onWall >= 0 ? onWall : this.nearWallStation(x, z);
    if (station < 0 || this.dead(station)) return here('noWall', -1);

    const standoff = this.sFace[station] + 0.32 + TOWER_HALF_D;
    const dockX = this.sx[station] + this.snx[station] * standoff;
    const dockZ = this.sz[station] + this.snz[station] * standoff;
    const at = (refusal: SiegeRefusal): SiegeMachineOrder =>
      this.describe('tower', t.id, t.unitId, station, '', dockX, dockZ,
        Math.sqrt((dockX - t.x) * (dockX - t.x) + (dockZ - t.z) * (dockZ - t.z)), refusal);

    if (t.state === TowerState.Spent) return at('spent');
    if (t.state !== TowerState.Approach) return at('landed');
    if (station === t.station) return at('already');
    if (t.dist > 0 && t.dist < TOWER_COMMIT) return at('committed');
    /**
     * Somebody else's berth, tested by **bay** as well as by metres.
     *
     * The distance test alone is the engineer's answer — two machines whose centres are
     * inside four half-widths of each other are drawn intersecting — and it is not the
     * player's. A player clicking "the bay that tower is taking" is pointing at a thirty-metre
     * length of curtain between two towers, and the ray lands wherever the parapet happens to
     * be under the cursor; measured, a click meant for a bay another machine held resolved
     * 94 m along the wall and was accepted. A bay is the unit the assault is echeloned in —
     * the scenario aims four towers at four *adjacent* bays, one apiece — so one machine per
     * bay is both what the deployment already does and what the sentence says.
     */
    const bay = this.sBay[station];
    for (const k of this.towers) {
      if (k.id === t.id || k.state === TowerState.Spent) continue;
      if (k.station >= 0 && k.station < this.nStations && this.sBay[k.station] === bay) {
        return at('taken');
      }
      if (Math.sqrt((k.dockX - dockX) * (k.dockX - dockX) + (k.dockZ - dockZ) * (k.dockZ - dockZ)) < TOWER_BERTH) return at('taken');
    }
    return at('none');
  }

  /**
   * Where a ram would go: a shut gate for the light one, a stretch of curtain for the great.
   *
   * The two kinds refuse each other's target rather than doing something approximate with it.
   * A gate ram against 3.5 m of concrete-and-brick would beat on it for ever — twenty-six
   * blows are sized for twin oak leaves — and the great ram exists precisely so that you can
   * *refuse* the gate and its killing ground, so aiming it at one throws away the only reason
   * to have built it. Both refusals are named, and named differently from "there is nothing
   * there", because "you cannot do that with this machine" is a different sentence from "you
   * are not pointing at anything".
   *
   * An **open** gate is not a target either: a ram sent to break a hole that is already a
   * hole would land twenty-six blows and change nothing. That is now the only thing the
   * `g.open` skip in `gateNear` is for — a gate this ram or another has already broken, or
   * one the defender opened to sally. It used to also exclude Carthage's eight posterns,
   * which were published open; since `385474f` they are hung with doors and shut at build.
   *
   * **So a shut postern is a valid light-ram target, and that is deliberate.** It arrived
   * implicitly with the doors and is kept on three grounds. A sally door is a door and a ram
   * is the machine that breaks doors, so refusing it would be arbitrary. Refusing it would
   * also have to be written as a test on the id or the name, and a literal gate id in this
   * decision is the exact mistake that made the breach a no-op on Carthage for a whole
   * workstream (`7e72785`) — `gateNear` reads `getGates()` uniformly and must keep doing so.
   * And a postern a ram can open is one more way into a city that is measurably short of
   * them: see this workstream's report, where the shipped Rome assault opens its great gate
   * and sends nobody through it.
   *
   * The cost is that `GATE_PICK_R` is 55 m and `postern-30` stands 52.5 m from the Porta
   * Byrsae, so a click about 26 m off the great gate's axis resolves to the postern instead.
   * That margin is *visible* rather than silent: `SiegeOrders` builds its hint from
   * `gateName(o.gateId)`, so the cursor reads "Break the Postern 30" or "Break the Porta
   * Byrsae" before the player commits. Measured by hand rather than assumed — `gw-postern`.
   */
  private resolveRamOrder(r: SiegeRam, x: number, z: number): SiegeMachineOrder {
    const great = r.kind === RamKind.Great;
    const kind: SiegeMachineKind = great ? 'greatRam' : 'ram';
    const here = (refusal: SiegeRefusal): SiegeMachineOrder =>
      this.describe(kind, r.id, r.unitId, r.station, r.gateId, r.targetX, r.targetZ,
        Math.sqrt((r.targetX - r.x) * (r.targetX - r.x) + (r.targetZ - r.z) * (r.targetZ - r.z)), refusal);

    if (r.wreck || r.state === RamState.Wreck) return here('spent');
    if (r.state === RamState.Withdrawing || r.state === RamState.Spent) return here('spent');

    if (great) {
      const onWall = this.wallTargetAt(x, z);
      const station = onWall >= 0 ? onWall : this.nearWallStation(x, z);
      if (station < 0 || this.dead(station)) return here('noWall');
      const standoff = this.sFace[station] + 0.4 + GREAT_RAM_HALF_D;
      const tx = this.sx[station] + this.snx[station] * standoff;
      const tz = this.sz[station] + this.snz[station] * standoff;
      const at = (refusal: SiegeRefusal): SiegeMachineOrder =>
        this.describe(kind, r.id, r.unitId, station, '', tx, tz,
          Math.sqrt((tx - r.x) * (tx - r.x) + (tz - r.z) * (tz - r.z)), refusal);
      if (station === r.station) return at('already');
      return at('none');
    }

    const gate = this.gateNear(x, z);
    if (!gate) {
      // Distinguish "you are pointing at the wall, which this machine cannot break" from
      // "you are pointing at open grass". Both refuse; only one is worth explaining.
      return here(this.wallTargetAt(x, z) >= 0 ? 'wrongTarget' : 'noGate');
    }
    const tx = gate.x + Math.sin(gate.facing) * (RAM_HALF_D + 3.6);
    const tz = gate.z + Math.cos(gate.facing) * (RAM_HALF_D + 3.6);
    const at = (refusal: SiegeRefusal): SiegeMachineOrder =>
      this.describe(kind, r.id, r.unitId, -1, gate.id, tx, tz,
        Math.sqrt((tx - r.x) * (tx - r.x) + (tz - r.z) * (tz - r.z)), refusal);
    if (gate.id === r.gateId) return at('already');
    return at('none');
  }

  /**
   * The nearest station to a point, but only if the point is near the wall at all.
   *
   * The loose half of the wall test. See `MACHINE_AIM_R` for why `stationNear` on its own is
   * not usable here: it always answers, however far away the click was.
   */
  private nearWallStation(x: number, z: number): number {
    const s = this.stationNear(x, z);
    if (s < 0) return -1;
    return Math.sqrt((this.sx[s] - x) * (this.sx[s] - x) + (this.sz[s] - z) * (this.sz[s] - z)) <= MACHINE_AIM_R ? s : -1;
  }

  /**
   * The nearest gate to a point that is still shut, within `GATE_PICK_R`, or null.
   *
   * Read off `getGates()` every time and never cached, and never a literal id. `7e72785` was
   * landed because one call site said `'porta-flaminia'` while the other two said
   * `getGates()[0]`; on Carthage the ram landed every blow and the carriageway stayed solid
   * for the rest of the battle. Ties break on the smaller index, so the answer is
   * deterministic when two gates are somehow equidistant.
   */
  private gateNear(x: number, z: number): { id: string; x: number; z: number; facing: number } | null {
    const gates = this.city?.getGates();
    if (!gates) return null;
    let best: { id: string; x: number; z: number; facing: number } | null = null;
    let bestD = GATE_PICK_R * GATE_PICK_R;
    for (const g of gates) {
      if (g.open) continue;
      const d = (g.x - x) * (g.x - x) + (g.z - z) * (g.z - z);
      if (d < bestD - 1e-6) { bestD = d; best = g; }
    }
    return best;
  }

  /**
   * Carry out an order `resolveMachineOrder` has already said yes to.
   *
   * Re-resolves nothing and decides nothing: every question was settled by the predicate, so
   * there is no second test here to drift out of step with the first one.
   */
  private applyMachineOrder(o: SiegeMachineOrder): boolean {
    if (!o.ok) return false;
    if (o.kind === 'tower') {
      const t = this.towers[o.machineId];
      if (!t) return false;
      this.aimTowerAt(t, o.station);
      t.heave = TOWER_HEAVE;
      return true;
    }
    const r = this.rams[o.machineId];
    if (!r) return false;
    r.targetX = o.x;
    r.targetZ = o.z;
    r.gateId = o.gateId;
    r.station = o.station;
    r.bay = o.station >= 0 ? this.sBay[o.station] : -1;
    /**
     * Which way the trunk points when it gets there.
     *
     * Solved from the *target*, not from where the machine happens to be standing now. A ram
     * re-aimed 560 m down the circuit arrives on a bearing that has nothing to do with the
     * gate it is going to beat on, and `spawnRam`'s `atan2(gate - spawn)` was only ever right
     * because the scenario put the machine on the gate's own axis. Squared on the bay's
     * normal for a great ram, because a machine that arrives at an angle beats on the corner
     * of a block instead of the face of it.
     */
    if (o.station >= 0) {
      r.wantFacing = Math.atan2(-this.snx[o.station], -this.snz[o.station]);
    } else {
      const g = this.city?.getGates().find((k) => k.id === o.gateId);
      r.wantFacing = g ? Math.atan2(g.x - o.x, g.z - o.z) : Math.atan2(o.x - r.x, o.z - r.z);
    }
    r.heave = RAM_HEAVE;
    r.arrived = false;
    r.state = RamState.Approach;
    // The trunk goes back to rest and the blow clock restarts: the crew are off the ropes.
    r.timer = r.kind === RamKind.Great ? GREAT_RAM_PERIOD : RAM_PERIOD;
    return true;
  }

  /**
   * Countermand whatever the wall was told to do with this unit.
   *
   * `Siege` had no public way to cancel a plan, which is why a descent whose last man is
   * blocked by a friendly holds its plan open for thousands of ticks and the cohort can
   * never form line in the city it has just entered. Publishing the verb does not fix that
   * on its own — somebody still has to call it — but it makes the fix expressible.
   */
  cancelWallPlan(unitId: number): boolean {
    return this.plans.delete(unitId);
  }

  /**
   * Send a unit through a breach the great ram has made.
   *
   * Without this the lanes were unreachable. `wantLink` is only ever written by the stair
   * branch and by `queueAtLink`, and `queueAtLink` is only ever fed by `nextHop`, which walks
   * `runNext` — and a breach lane belongs to no run at either end. So five perfectly good
   * paths existed, were counted by `breachReport().lanes`, and no man could be admitted to
   * one. The probe asserted that the lanes *existed*, which they did.
   *
   * A breach is the reason to build a great ram, so it has to be an order you can give.
   */
  stormBreach(u: UnitGroupState, gx: number, gz: number): boolean {
    if (this.breachLinks.length === 0) return false;
    this.owned.add(u.id);
    u.order = UnitOrder.Garrison;
    u.targetUnitId = -1;
    u.waypoints.length = 0;
    this.plans.set(u.id, {
      goal: WallGoal.Storm, destStation: -1, destRun: -1,
      stair: this.breachLinks[0], gx, gz, age: 0, stuck: 0,
    });
    return true;
  }

  /**
   * How far it is *along the walk* from `station` to the near end of `run`, or `Infinity`
   * if the wall does not join them.
   *
   * Metres, and the only metric in this file that means anything for a man on a parapet. A
   * wall is a chain of runs joined at towers; two points 10 m apart in plan can be on
   * opposite sides of a severed joint and infinitely far apart on foot. Rome's circuit is
   * **four** such components (runs 0–1, 2–18, 19–24, 25–44) and Carthage's is two — measured,
   * not assumed — so this is not a hypothetical.
   *
   * Stations are charged at `STATION_PITCH` and each intervening tower pass at its own plan
   * length, which is what `linkPath` will actually make the man walk.
   */
  private walkDistance(station: number, run: number): number {
    if (station < 0 || run < 0 || run >= this.nRuns) return Infinity;
    const from = this.sRun[station];
    if (from === run) {
      const mid = (this.runLo[run] + this.runHi[run]) >> 1;
      return Math.abs(station - mid) * STATION_PITCH;
    }
    const lo = Math.min(from, run);
    const hi = Math.max(from, run);
    let d = from < run
      ? (this.runHi[from] - station) * STATION_PITCH
      : (station - this.runLo[from]) * STATION_PITCH;
    for (let r = lo; r < hi; r++) {
      const l = this.links[this.runNext[r]];
      if (!l) return Infinity;
      d += Math.sqrt((l.ax - l.bx) * (l.ax - l.bx) + (l.az - l.bz) * (l.az - l.bz)) + Math.abs(l.ay - l.by);
      // Every run strictly between the two is crossed end to end.
      if (r + 1 < hi) d += (this.runHi[r + 1] - this.runLo[r + 1]) * STATION_PITCH;
    }
    // And half of the destination run, to its middle, so two stairs on one run are still
    // separable and the answer does not depend on which end the caller happened to name.
    const mid = (this.runLo[run] + this.runHi[run]) >> 1;
    d += Math.abs((from < run ? this.runLo[run] : this.runHi[run]) - mid) * STATION_PITCH;
    return d;
  }

  /**
   * The stair link that best serves a unit at `(x, z)` wanting run `run`.
   *
   * **Rewritten, because it measured the wrong thing twice.** The old body did this:
   *
   * ```
   * if (l.runB === run) { onRun = onRun < 0 ? l.id : onRun; }   // first in array order
   * const d = (l.ax - x) ** 2 + (l.az - z) ** 2;                // plan distance
   * if (d < bestD - 1e-6) { bestD = d; best = l.id; }
   * return onRun >= 0 ? onRun : best;
   * ```
   *
   * — which is (a) *the first* stair on the wanted run in `this.links` order rather than the
   * nearest one, set once and never improved, and (b) a fallback that ranks every other
   * stair on the whole circuit by straight-line distance with **no reachability test at
   * all**. Both are the same error: a wall is a graph and this was measuring across it.
   *
   * Measured on the shipped tree before the change, walking every run's midpoint through
   * both maps: Rome runs 0 and 1 — 78 stations of finished curtain — were told to use the
   * stair on run 13, which is in a different component of the walk and which no man
   * standing there can ever reach; Carthage run 21 was told to use the stair on run 19,
   * across the severed joint at 20, when the reachable one on run 23 is 81 m away along the
   * stone. An order aimed at one of those is accepted, the men walk to a link mouth that
   * leads nowhere, `advancePlans` reports `stuck` for every one of them, and the plan sits
   * open until `PLAN_TIMEOUT` ten minutes later. That is the "152 men frozen, plan still
   * open at age 3,656" signature this file already carries a note about, arriving by a
   * second route.
   *
   * Now: only stairs whose wall end is on a run the walk actually joins to `run` are
   * eligible, and among those the nearest **along the walk** wins — the ground approach to
   * the foot is added, because a unit still has to get there. -1 when the wall offers this
   * unit no way up or down at all, which is a refusal the caller must pass on rather than
   * an order that cannot complete. Deterministic: ties break on link id.
   */
  private nearestStairLink(x: number, z: number, run: number): number {
    let best = -1;
    let bestD = Infinity;
    for (const l of this.links) {
      if (l.kind !== LinkKind.Stair) continue;
      if (l.stationB < 0 || this.dead(l.stationB)) continue;
      // Reachability first, and it is not a tie-break. A stair the unit cannot walk from to
      // where it is going is not a worse choice, it is not a choice.
      const along = this.walkDistance(l.stationB, run);
      if (!isFinite(along)) continue;
      // Plus the walk to the foot of the flight, which is ground and is not free either.
      const approach = Math.sqrt((l.ax - x) * (l.ax - x) + (l.az - z) * (l.az - z));
      const d = along + approach;
      if (d < bestD - 1e-6) { bestD = d; best = l.id; }
    }
    return best;
  }

  /**
   * Take a plain move order given to a unit the siege system owns and turn it into a wall
   * order.
   *
   * **This is the whole player-facing integration, and it needs no patch to any file this
   * workstream does not own.** `Siege.garrison` sets `u.order = UnitOrder.Garrison`, and
   * nothing else in the sim ever writes that value; `BattleSystem.trackOwnedAnchors` moves
   * the anchor but never the order. So a garrisoned unit whose order is no longer `Garrison`
   * has been given a new one by the player or the AI in the window between two ticks, and
   * `preSteer` runs before `trackOwnedAnchors` can overwrite the target it came with.
   *
   * Where the order points decides which of the two things it means: a point on the wall's
   * own footprint is a lateral redeployment along the parapet, anything else is "come down".
   */
  private interceptOrders(): void {
    const b = this.battle;

    /**
     * The player's machine orders, carried out first.
     *
     * Before the move orders below, deliberately. A right-click with a tower party selected
     * emits an ordinary `orderIssued` as well — the HUD does not know or care that this
     * cohort happens to be pushing a machine — and the tower branch of that loop would
     * otherwise re-decide the same order a second time on the same tick. Applying this one
     * first makes the second decision a no-op (`already`), rather than two heaves for one
     * click.
     */
    if (this.machineOrders.length > 0) {
      for (const m of this.machineOrders) {
        const u = b.unitById(m.unitId);
        if (!u || u.destroyed || u.alive === 0) continue;
        const o = this.resolveMachineOrder(m.unitId, m.x, m.z);
        if (o && o.ok) this.applyMachineOrder(o);
      }
      this.machineOrders.length = 0;
    }

    /**
     * Orders taken off the event, which is the only place the clicked point survives intact.
     *
     * Runs before the polling loop below and settles the same three questions from a
     * destination that has not been through `holdShortOfSolid`. A unit handled here is left
     * with `lastTx/lastTz` at its own anchor, so the poll sees no displacement and does not
     * then re-decide the order it has already carried out.
     */
    for (const [id, dest] of this.ordered) {
      const u = b.unitById(id);
      if (!u || u.destroyed || u.alive === 0) continue;
      if (u.order === UnitOrder.Rout) continue;
      // Where his men are, not which map he is in. See `standingOnWall`.
      const onWall = this.garrisons.has(id) && this.standingOnWall(id);
      if (onWall) {
        // On the stone already: either along it, or off it. `wallTargetAt` is the same query
        // the UI uses to decide a click landed on the parapet.
        if (this.wallTargetAt(dest.x, dest.z) >= 0) this.moveAlongWall(u, dest.x, dest.z);
        else this.sendToGround(u, dest.x, dest.z);
        // Reclaim the order: this unit's men are placed by the stonework, and leaving it on
        // `MoveTo` would have `steerToSlots` and the formation path fighting over the same
        // men on alternate ticks.
        u.order = UnitOrder.Garrison;
        u.waypoints.length = 0;
        const g = this.garrisons.get(id);
        if (g) { g.lastTx = u.x; g.lastTz = u.z; }
      } else if (this.wallTargetAt(dest.x, dest.z) >= 0) {
        /**
         * On the ground and told to get on the wall. Which way up depends on which side of
         * it he is standing.
         *
         * The city side walks up the defenders' own stairs. The field side does not — a
         * besieger is not entitled to those — but it is entitled to the ramp or the ladder
         * its own army has put against the stone, and until `escalade` existed this branch
         * simply dropped the order. That silence is the owner's report: *"I cannot send units
         * up the stairs and onto the wall"*, and *"others cannot climb those same siege
         * instruments"*, which are one missing verb.
         */
        if (this.sideOf(u.x, u.z) === -1) {
          if (!this.owned.has(id)) this.sendToWall(u, dest.x, dest.z);
        } else if (this.crewsAMachine(id) && this.towerOf(id)) {
          /*
           * A tower's own gang told to go at a different stretch of wall moves the tower —
           * but only while the tower is still theirs to aim.
           *
           * `towerOf` alone sent every wall order the gang was ever given into
           * `orderTowerTo` for the rest of the battle, and `orderTowerTo` returns false for
           * a docked machine, so the click bought a walk to the foot of the wall and no
           * escalade. Falling through to `escalade` is the right reading once the ramp is
           * down: their own tower is a road, it is within `ESCALADE_REACH` of the bay they
           * are pointing at, and enrolling a unit already at the head of that file is a
           * no-op.
           */
          this.orderTowerTo(u, dest.x, dest.z);
        } else {
          this.escalade(u, dest.x, dest.z);
        }
      } else if (this.releaseEscalade(id)) {
        /**
         * Out of the queue.
         *
         * Enrolling a unit on a ladder makes the siege system place its men, and without
         * this there was no way back: a cohort sent at a bank of ladders would have stood
         * in that file for the rest of the battle whatever the player clicked afterwards,
         * because every later order pointed at ground the wall code does not read. An order
         * you cannot countermand is worse than an order you cannot give.
         *
         * Men already on the rungs are left alone — `advanceQueue` does not consult the
         * enrolment — so nobody is dropped off a ladder by a change of mind.
         */
        this.owned.delete(id);
        for (const i of u.members) {
          if (this.crossOf[i] !== -1 || this.stationOf[i] >= 0) continue;
          b.elevated[i] = 0;
          b.support[i] = NO_SUPPORT;
        }
      }
    }
    if (this.ordered.size > 0) this.ordered.clear();

    for (const [id, g] of this.garrisons) {
      const u = b.unitById(id);
      if (!u || u.destroyed) continue;
      // Already executing an order. Re-reading `u.order` while a plan is running is what
      // destroyed the plan the tick after it was issued — see below.
      if (this.plans.has(id)) continue;
      if (u.order === UnitOrder.Garrison || u.order === UnitOrder.Rout) continue;
      if (u.order !== UnitOrder.MoveTo && u.order !== UnitOrder.AttackMove) continue;

      /**
       * A *new* order, not merely a changed `u.order`.
       *
       * This was the bug that stopped the whole feature working, and it is worth writing
       * down because the reasoning that produced it was so nearly right. `Siege.garrison`
       * sets `u.order = UnitOrder.Garrison` and nothing else in the sim writes that value,
       * so "the order is no longer Garrison" looked like a sound proxy for "the player has
       * given this unit a new order".
       *
       * It is not. `BattleSystem.updateUnitOrder` runs for every unit every tick and changes
       * `u.order` on its own for reasons that have nothing to do with the player — coming
       * into contact, resuming a route, breaking off. Measured: a cohort sent up a stair was
       * owned with a live Ascend plan at the instant the order was given, and **five seconds
       * later had no plan and was no longer siege-owned**. The sim flipped its order, this
       * loop read that as a fresh click, saw the target was not on the wall, converted the
       * ascent into a *descent*, found every man already on the ground, concluded the descent
       * was complete and released the unit. Nobody ever reached a stair.
       *
       * The honest signal is the order's *destination* changing, because that is the thing a
       * click actually carries. `trackOwnedAnchors` mirrors the unit's own centroid into
       * these fields while the siege system owns it, so they move — but they move
       * continuously, by centimetres, and a click moves them metres at once.
       */
      const moved = Math.sqrt((u.targetX - g.lastTx) * (u.targetX - g.lastTx) + (u.targetZ - g.lastTz) * (u.targetZ - g.lastTz));
      g.lastTx = u.targetX;
      g.lastTz = u.targetZ;
      if (moved < ORDER_JUMP) {
        // Not a new order — the sim changed the order kind by itself. Take the unit back
        // and leave it standing where it is.
        u.order = UnitOrder.Garrison;
        continue;
      }
      if (this.wallTargetAt(u.targetX, u.targetZ) >= 0) this.moveAlongWall(u, u.targetX, u.targetZ);
      else this.sendToGround(u, u.targetX, u.targetZ);
      // Reclaim the order either way: this unit's men are placed by the stonework, and
      // leaving it on `MoveTo` would have `steerToSlots` and the formation path fighting
      // over the same men on alternate ticks.
      u.order = UnitOrder.Garrison;
      u.waypoints.length = 0;
    }

    /**
     * A unit that is *not* on the wall and has been ordered into it.
     *
     * The UI pushes an order point out of any solid it lands on — `orderPointForSolid` — so a
     * click on the parapet arrives as a point a body radius clear of the nearest face, on the
     * side the player was looking from. Read from inside the city that is unambiguous: a
     * cohort told to stand with its anchor inside the curtain's own footprint is being told
     * to get on the wall, because there is nothing else there to stand on.
     *
     * Restricted to units on the **city side**, and that restriction is not a hedge. A
     * besieger at the foot of the outer face is not entitled to walk up the defenders'
     * stairs; he comes over a ramp, up a ladder or through a breach. Confining the shortcut
     * to the inside is both the historically correct rule and the one that cannot fire by
     * accident on the assault.
     */
    for (const u of b.units) {
      if (u.destroyed || u.alive === 0) continue;
      if (this.owned.has(u.id)) continue;
      if (u.order !== UnitOrder.MoveTo && u.order !== UnitOrder.AttackMove) continue;
      if (this.wallTargetAt(u.targetX, u.targetZ) < 0) continue;
      if (this.sideOf(u.x, u.z) !== -1) continue;
      this.sendToWall(u, u.targetX, u.targetZ);
    }
  }

  /**
   * The link a man on run `cur` should take next to reach run `target`, and which way.
   *
   * The runs are a chain along the curtain — run k abuts run k+1 across a tower or a
   * construction step and nothing else — so "route" is a comparison rather than a search.
   * That is worth saying out loud: a general graph search here would be a fifty-line A* run
   * for every man every tick to answer a question that has one bit in it.
   */
  /**
   * Whether the walk joins these two runs without leaving the wall.
   *
   * The chain again: every hop between them must exist. Cheap — the whole circuit is 45 runs
   * — and it is the same `runNext` the traversal itself walks, so a route this says exists is
   * a route `nextHop` can produce, hop for hop, rather than a second opinion about it.
   */
  private runsConnected(from: number, to: number): boolean {
    if (from < 0 || to < 0) return false;
    if (from === to) return true;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    for (let r = lo; r < hi; r++) if (this.runNext[r] < 0) return false;
    return true;
  }

  /**
   * Whether a lateral move along the wall to `(x, z)` would be carried out, for the cursor.
   *
   * Published for the same reason `escaladeOfferAt` is: `moveAlongWall` now refuses a run it
   * cannot reach, and a refusal the player cannot see is the defect this pass keeps finding.
   * Pure.
   */
  traverseOfferAt(unitId: number, x: number, z: number): {
    ok: boolean; refusal: 'none' | 'notOnWall' | 'noWall' | 'noRoute'; bay: number;
  } {
    const u = this.battle.unitById(unitId);
    if (!u || !this.garrisons.has(unitId)) {
      return { ok: false, refusal: 'notOnWall', bay: -1 };
    }
    const dest = this.wallTargetAt(x, z);
    if (dest < 0) return { ok: false, refusal: 'noWall', bay: -1 };
    const bay = this.sBay[dest];
    const here = this.stationNear(u.x, u.z);
    const fromRun = here >= 0 ? this.sRun[here] : -1;
    if (!this.runsConnected(fromRun, this.sRun[dest])) {
      return { ok: false, refusal: 'noRoute', bay };
    }
    return { ok: true, refusal: 'none', bay };
  }

  private nextHop(cur: number, target: number): { link: number; dir: 0 | 1 } {
    if (cur === target || cur < 0 || target < 0) return { link: -1, dir: 0 };
    if (cur < target) return { link: this.runNext[cur] ?? -1, dir: 0 };
    return { link: this.runNext[cur - 1] ?? -1, dir: 1 };
  }

  /**
   * Drive every unit that has been told to go somewhere by way of the wall.
   *
   * Each man is in exactly one of three states and the function's whole job is to say which
   * and give him a slot for it: on a path (leave him alone, `advanceLinks` owns him),
   * arrived (lay him out as part of a garrison), or transiting (queue him at the mouth of
   * the next link). Queueing is done by *assigning him a station near the mouth*, which
   * means the whole of the existing garrison machinery — the slot geometry, the rank
   * stagger, the surface search, the lateral clamp — carries him there with nothing new.
   */
  private advancePlans(): void {
    const b = this.battle;
    const p = b.pool;
    // Rebuilt from scratch each tick: a waiter is a fact about this instant, and carrying
    // one over would admit a man who has since died, been shoved away or changed his mind.
    if (this.waiters.size > 0) this.waiters.clear();
    for (const [id, plan] of this.plans) {
      const u = b.unitById(id);
      if (!u || u.destroyed || u.alive === 0) { this.plans.delete(id); continue; }
      plan.age++;
      const arrived: number[] = [];
      let moving = 0;
      /**
       * Men the plan cannot move, and they must not be counted as having arrived.
       *
       * The first version pushed them into `arrived`, which handed them to `layOutArrived`
       * — and that lays men out around `plan.destStation`, on the destination run. A man
       * stranded on run 3 was therefore given a slot on run 7, and `holdGarrisonsOnTheWalk`
       * then snapped his Y to that station's height. That is precisely the 3.62 m teleport
       * this file already carries a long comment about, reintroduced by a convenience.
       *
       * A man who cannot be moved is left exactly where he is standing. That is always a
       * legal place to be, because he was standing there a tick ago.
       */
      let stuck = 0;

      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        if (this.crossOf[i] !== -1) { moving++; continue; }
        const cur = this.runOfMan(i);

        if (plan.goal === WallGoal.Storm) {
          /**
           * Through the hole, in five files abreast.
           *
           * Lanes are handed out round-robin on the man's index within the unit, so a cohort
           * spreads across the whole width of the breach instead of forming one queue at the
           * left-hand lane. That width is the entire point of preferring a breach to a gate:
           * eight metres of storming front against the carriageway's four.
           */
          if (this.sideOf(p.x[i], p.z[i]) < 0) {
            // Inside the city. He is through; form up on the rally point.
            this.groundSlot(i, u, plan.gx, plan.gz, arrived.length);
            arrived.push(i);
            continue;
          }
          const lane = this.links[this.breachLinks[moving % this.breachLinks.length]];
          if (!lane) { stuck++; continue; }
          this.footSlot(i, lane);
          this.wantLink[i] = lane.id;
          this.wantDir[i] = 0;
          this.noteWaiting(i, lane.id, 0);
          moving++;
          continue;
        }

        if (plan.goal === WallGoal.Descend) {
          const stair = this.links[plan.stair];
          if (!stair) { stuck++; continue; }
          if (cur < 0) {
            // Down and out. He is on the grass and steers to the rally point like anybody
            // else, in a loose block so a cohort coming off a stair does not form a queue
            // forty metres long across a street.
            this.groundSlot(i, u, plan.gx, plan.gz, arrived.length);
            arrived.push(i);
            continue;
          }
          if (cur === stair.runB) {
            this.queueAtLink(i, stair, 1);
          } else {
            const hop = this.nextHop(cur, stair.runB);
            if (hop.link < 0) { stuck++; continue; }
            this.queueAtLink(i, this.links[hop.link], hop.dir);
          }
          moving++;
          continue;
        }

        if (cur === plan.destRun) { arrived.push(i); continue; }

        if (cur < 0) {
          // At the foot of a flight, waiting his turn. `elevated` is cleared because he is
          // demonstrably standing on the ground, and anything else would have `integrate`
          // hold him at a support height he is not on.
          const stair = this.links[plan.stair];
          if (!stair) { stuck++; continue; }
          this.footSlot(i, stair);
          this.wantLink[i] = stair.id;
          this.wantDir[i] = 0;
          this.noteWaiting(i, stair.id, 0);
          moving++;
          continue;
        }

        const hop = this.nextHop(cur, plan.destRun);
        if (hop.link < 0) {
          // The wall is broken between here and there. He stops where he is rather than
          // walking into the gap, and the plan times out rather than being retried forever.
          stuck++;
          continue;
        }
        this.queueAtLink(i, this.links[hop.link], hop.dir);
        moving++;
      }

      plan.stuck = stuck;
      // The men who are there form up; the ones still coming do not disturb them.
      const g = this.garrisons.get(id);
      if (g && plan.goal !== WallGoal.Descend && plan.goal !== WallGoal.Storm && arrived.length > 0) {
        this.layOutArrived(u, g, plan.destStation, arrived);
      }

      if (moving === 0) {
        if (plan.goal === WallGoal.Descend || plan.goal === WallGoal.Storm) this.releaseToGround(u, plan.gx, plan.gz);
        else if (g) { g.plannedFor = -1; }
        this.plans.delete(id);
      } else if (plan.age > PLAN_TIMEOUT) {
        /**
         * Abandon an order that is never going to finish.
         *
         * Some orders genuinely cannot complete: a unit told to reach a run on the far side
         * of an unbuilt bay, or told to come down when the great ram has taken out the only
         * stair it could reach. Without this it would spend the rest of the battle walking
         * at a link mouth that leads nowhere, and — worse — `updateGarrisons` defers to the
         * plan, so the unit would never re-form either. Dropping the plan leaves the men
         * standing on the stonework they are on, which is always a legal place to be.
         *
         * Ten minutes at 30 Hz. A legitimate traverse of six bays and five towers is about
         * four, so this is well clear of anything real.
         */
        this.plans.delete(id);
        if (g) { g.plannedFor = -1; g.sticky = false; }
        for (const i of u.members) this.wantLink[i] = -1;
      }
    }
  }

  /**
   * Lay the men who have reached the destination run out along it, and no others.
   *
   * The same solver the settled garrison uses — see `layOutOnWall` for why there is only
   * one of them now.
   *
   * **Sized for the whole cohort, filled by the men who have arrived**, and the difference
   * is the second half of "they get stuck". Sized for the arrivals alone, the window is a
   * different width on every tick of an ascent: the file was 1 station wide when the first
   * man topped the stair, 5 when a fifth of them were up and 14 when the run filled, and
   * `from` walked six stations along the wall as it grew. Every man's seat therefore moved
   * under him every tick, so nobody was ever within `steerToSlots`' 6 cm arrival radius and
   * the whole cohort walked at a flat 1.5 m/s for as long as the plan was open. Reserving
   * each man's place from the first tick — a hole in the line until he gets there, which is
   * what a place *is* — makes the file stand still while the rest of it files up.
   */
  private layOutArrived(
    u: UnitGroupState, g: Garrison, centre: number, arrived: readonly number[]
  ): void {
    if (centre < 0) return;
    const p = this.battle.pool;
    const roll: number[] = [];
    for (const i of u.members) if (p.aliveAt(i)) roll.push(i);
    if (roll.length === 0) return;
    const mark = this.placeMark;
    for (const i of arrived) mark[i] = 1;
    this.layOutOnWall(u, g, centre, roll, (i) => mark[i] === 1);
    for (const i of arrived) mark[i] = 0;
  }

  /**
   * A man's place in the file at one link mouth, this tick.
   *
   * **This is the whole reason a garrison could not leave a wall, and it is a counter, not a
   * mechanic.** `advancePlans` used to hand `queueAtLink` and `footSlot` its running `moving`
   * tally as the queue index. That tally counts every man of the unit who is in motion —
   * men already on a crossing, men queued at a *different* doorway, men bound for the far
   * end of the curtain — so the first man actually waiting at a given mouth was handed an
   * index equal to however many of his mates were busy elsewhere. `queueAtLink` then parks
   * index `q` at `floor(q / MAX_WALL_RANKS)` stations back and rank `q % MAX_WALL_RANKS` in,
   * and `pickWaiting` only admits a man within `LINK_ADMIT` of the mouth.
   *
   * Measured on a 53-man cohort ordered off the parapet: twelve men crossed the tower pass,
   * and from that moment the head of the file behind them sat at station +2, rank 4 —
   * **2.26 m from a mouth with a 2.00 m admission radius** — where it stayed for the rest of
   * the battle. Forty-one men, no plan failure, no timeout, nobody stuck by the geometry;
   * the queue had simply been laid out beyond its own doorway. It is self-reinforcing, which
   * is why it reads as permanent: every man who gets onto the path pushes the next one
   * further back.
   *
   * `waiters` is rebuilt from scratch each tick and every waiting man is pushed into it, so
   * the count already in this bucket *is* the man's place in this file. Shared across units
   * on purpose: two cohorts changing places at one tower door form one queue, which is what
   * `advanceLinks` already assumes when it admits by proximity rather than by unit.
   */
  private fileIndex(linkId: number, dir: 0 | 1): number {
    return this.waiters.get(linkId * 2 + dir)?.length ?? 0;
  }

  /** Park a man in the file waiting at the wall-walk end of a link. */
  private queueAtLink(i: number, l: WallLink, dir: 0 | 1): void {
    const st = dir === 0 ? l.stationA : l.stationB;
    if (st < 0) return;
    const q = this.fileIndex(l.id, dir);
    const bounds = this.runBounds(st);
    /**
     * As many abreast as the walkway takes here, not a constant.
     *
     * Was `MAX_WALL_RANKS`, which is the *cap* on the depth and not the depth. On a bay
     * whose clear band is 2.21 m — the narrowest of the 45 on this circuit — the walk takes
     * four, so the man handed rank 4 stood at exactly the offset `slotAt` had already
     * clamped rank 3 to, and two men in a queue shared one place. `ranksAt` is the wall's
     * own answer and is now the only source of it anywhere in this file.
     */
    const abreast = this.ranksAt(st);
    // Step back into the run away from the mouth, so a hundred men waiting for a tower
    // door are a crowd on the walkway and not a single file across two bays.
    const back = Math.floor(q / abreast);
    // Which way "back" is depends on which end of the run the mouth is.
    const inward = st === bounds.hi ? -1 : 1;
    this.stationOf[i] = clamp(st + inward * back, bounds.lo, bounds.hi);
    this.rankOf[i] = q % abreast;
    this.wantLink[i] = l.id;
    this.wantDir[i] = dir;
    this.noteWaiting(i, l.id, dir);
  }

  /**
   * Park a man in the file waiting at the foot of a stair, on the ground.
   *
   * The ground end of a link is only ever entered a->b, so the file is the `dir 0` bucket.
   * See `fileIndex` for why the index is per-link and not the plan's `moving` tally: the
   * ascent had the identical defect, and it bites harder here because `footSlot` steps back
   * 0.85 m per row against the same 2 m admission radius — index 12 stands 4.2 m out.
   */
  private footSlot(i: number, l: WallLink): void {
    const b = this.battle;
    const q = this.fileIndex(l.id, 0);
    // Back away from the flight along its own axis, four abreast.
    let ax = l.ax - l.bx;
    let az = l.az - l.bz;
    const len = Math.sqrt(ax * ax + az * az) || 1;
    ax /= len; az /= len;
    /**
     * The head of the queue must stand inside `LINK_ADMIT` of the mouth, or nobody starts.
     *
     * Three abreast at 0.8 m centres and 0.7 m back puts the worst man of the first row at
     * `hypot(0.8, 0.7) = 1.06 m` from the foot, which clears the admission test with room to
     * spare. The four-abreast layout this replaced put files 0 and 3 of the first row at
     * `hypot(0.9, 1.35) = 1.62 m`.
     *
     * **The prose that used to be here reasoned against "the 1.5 m admission radius", and
     * there has never been such a number.** The radius that governs this queue is
     * `LINK_ADMIT`, and it is 2.0 m — `footSlot` hands its men to `noteWaiting`, which puts
     * them in the bucket `advanceLinks` reads and `pickWaiting` admits from, and
     * `pickWaiting` measures against `LINK_ADMIT`. `ADMIT_RADIUS` (1.6 m) is a different
     * thing for a different mechanism: it is what `stepCrossing` admits a *machine's*
     * boarders by, and no man placed by this function is ever tested against it. 1.5 m is
     * neither. It was written in the same commit that set `LINK_ADMIT = 2.0` and was wrong
     * on the day it was written.
     *
     * That matters beyond tidiness, because the arithmetic it was attached to no longer
     * supports its conclusion: 1.62 m is *inside* a 2.0 m radius, so "nobody is in range and
     * nobody ever will be" cannot have been what deadlocked the measured `0/160 men on the
     * wall`. Whatever that was, it was not this geometry failing to reach. Three abreast is
     * kept because it demonstrably works and is comfortably inside both radii — not because
     * four abreast is out of range, which it is not.
     */
    const file = (q % 3) - 1;
    const row = Math.floor(q / 3);
    b.elevated[i] = 0;
    b.support[i] = NO_SUPPORT;
    b.slotX[i] = l.ax + ax * (0.7 + row * 0.85) + -az * file * 0.8;
    b.slotZ[i] = l.az + az * (0.7 + row * 0.85) + ax * file * 0.8;
    b.slotFacing[i] = Math.atan2(-ax, -az);
  }

  /** Has this unit anybody on the stonework or on a path up it, right now? */
  private someoneOnTheStone(u: UnitGroupState): boolean {
    const p = this.battle.pool;
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      if (this.crossOf[i] !== -1 || this.stationOf[i] !== -1) return true;
    }
    return false;
  }

  /**
   * A broken party runs for the stairs, and keeps the men who cannot reach one on the stone.
   *
   * Called once per tick for a party that has broken while any of it is still up. Opening a
   * plan is idempotent — `plans.has` guards it — so this is a no-op on all but the first
   * tick and on the ticks after an existing plan has finished.
   *
   * The rally point is the foot of the flight pushed 40 m further along the wall's own
   * outward normal *on the side the unit is fleeing to*, which is the city for a garrison
   * and the field for a lodgement. It is not the unit's anchor: the anchor of a party half
   * way up a wall is inside the masonry, and `groundSlot` would then form the survivors up
   * inside the curtain.
   *
   * **When there is no reachable stair there is nothing honest to do but hold.** A lodgement
   * that has broken on a parapet cannot use the defenders' flights — they come out among the
   * men who just threw it off — and it did not come up one, it came up a ladder, which this
   * system only runs upward. Held, it stands and fights and dies where it is, which is what
   * a broken lodgement does; released, it walks at a slot on the far side of a wall it
   * cannot leave, which is what the owner reported. Held is also *safe*: nothing clears
   * `elevated` for a man on the stone, so nobody falls. Going down a ladder under fire is
   * the next piece of work and it is named in the report rather than half-built here.
   */
  private routOffTheWall(u: UnitGroupState): void {
    this.owned.add(u.id);
    this.brokeOff.delete(u.id);
    if (this.plans.has(u.id)) return;
    if (!this.garrisons.has(u.id)) return;
    const here = this.stationNear(u.x, u.z);
    if (here < 0) return;
    const stair = this.nearestStairLink(u.x, u.z, this.sRun[here]);
    if (stair < 0) return;
    const l = this.links[stair];
    const st = l.stationB >= 0 ? l.stationB : here;
    // Inward for a defender, outward for a besieger: away from whoever broke him.
    const side = this.sideOf(u.x, u.z);
    const gx = l.ax + this.snx[st] * side * 40;
    const gz = l.az + this.snz[st] * side * 40;
    this.plans.set(u.id, {
      goal: WallGoal.Descend, destStation: -1, destRun: l.runB,
      stair, gx, gz, age: 0, stuck: 0,
    });
    const g = this.garrisons.get(u.id);
    if (g) g.sticky = false;
  }

  /**
   * Where a man of a broken party who is already on the grass should run.
   *
   * Straight away from the wall, on the side he is standing. Recomputed from his own
   * position each tick, so it is a receding point rather than a destination — which is what
   * flight is, and which lets `BattleSystem`'s "escaped" test retire him at 260 m from the
   * nearest enemy exactly as it does for any other routing man.
   *
   * This exists because the party stays siege-owned while its mates are on the parapet (see
   * `routOffTheWall`), and a siege-owned man whose slot nobody writes keeps walking at a
   * **slot frozen at the last tick before he broke** — the measured 1.11 m/s pin this file
   * already carries a note about, arriving by a new route. Writing the flight slot is what
   * makes keeping the unit safe.
   */
  private fleeSlot(i: number, u: UnitGroupState): void {
    const b = this.battle;
    const p = b.pool;
    const st = this.stationNear(p.x[i], p.z[i]);
    b.elevated[i] = 0;
    b.support[i] = NO_SUPPORT;
    if (st < 0) {
      b.slotX[i] = p.x[i];
      b.slotZ[i] = p.z[i];
      return;
    }
    const side = this.sideOf(p.x[i], p.z[i]);
    const nx = this.snx[st] * side;
    const nz = this.snz[st] * side;
    b.slotX[i] = p.x[i] + nx * 60;
    b.slotZ[i] = p.z[i] + nz * 60;
    b.slotFacing[i] = Math.atan2(nx, nz);
    void u;
  }

  /** Steer a man who has come off the wall toward the rally point, in a loose block. */
  private groundSlot(i: number, u: UnitGroupState, gx: number, gz: number, q: number): void {
    const b = this.battle;
    const file = (q % 8) - 3.5;
    const row = Math.floor(q / 8);
    const c = Math.cos(u.facing);
    const s = Math.sin(u.facing);
    b.elevated[i] = 0;
    b.support[i] = NO_SUPPORT;
    b.slotX[i] = gx + file * 0.9 * c + -row * 0.9 * s;
    b.slotZ[i] = gz - file * 0.9 * s + -row * 0.9 * c;
    b.slotFacing[i] = u.facing;
  }

  /**
   * Hand a unit back to the field once every man is off the wall.
   *
   * The point of coming down is to be an ordinary cohort in an ordinary street fight. Left
   * siege-owned it would keep being steered to absolute slots by `steerToSlots`, which has
   * no formation, no wheeling and no charge — a unit that had taken the wall and descended
   * would then be unable to form line in the city it had just entered.
   */
  private releaseToGround(u: UnitGroupState, gx: number, gz: number): void {
    const p = this.battle.pool;
    for (const i of u.members) {
      /**
       * Never take the floor out from under a man who is still on one.
       *
       * The caller only reaches this when its `moving` tally is zero, so on paper nobody is
       * on a crossing — but this function is one stall timeout away from being called on a
       * party that is, and the last time that happened **nine men who were still climbing
       * fell from full height at 313 m/s**. The measured safe state after that fix is a
       * worst vertical step of 0.049 m and zero falls, and it is held by asking the
       * question per man rather than by trusting the caller's arithmetic. A blanket clear
       * on a per-unit flag is precisely the shape of the fault.
       */
      if (this.crossOf[i] !== -1) continue;
      this.stationOf[i] = -1;
      this.rankOf[i] = 0;
      this.wantLink[i] = -1;
      this.linkOf[i] = -1;
      this.battle.elevated[i] = 0;
      this.battle.support[i] = NO_SUPPORT;
      if (p.state[i] === SoldierState.Climbing) p.setState(i, SoldierState.Idle);
    }
    for (let s = 0; s < this.nStations; s++) if (this.sOwner[s] === u.id) this.sOwner[s] = -1;
    const g = this.garrisons.get(u.id);
    if (g) this.releaseClaim(g);
    this.garrisons.delete(u.id);
    this.owned.delete(u.id);
    /**
     * Point the order at the rally point, and that is not tidiness.
     *
     * `interceptOrders` reads a ground unit's `targetX/targetZ` to decide whether the player
     * has clicked the parapet, and `trackOwnedAnchors` has been mirroring this unit's own
     * centroid into those fields for as long as the siege system owned it. A cohort that has
     * just walked down a stair therefore has a target sitting at the foot of the wall, on the
     * city side — which is exactly the signature the auto-ascend rule looks for. Released
     * without this, it would about-face and climb straight back up, for ever.
     */
    u.order = UnitOrder.MoveTo;
    u.targetX = gx;
    u.targetZ = gz;
    u.waypoints.length = 0;
  }

  /**
   * Admit men to links and move everybody who is on one.
   *
   * Admission is by desire and proximity rather than by unit, because a stair or a tower
   * door is shared: two cohorts changing places on the same stretch of wall queue up at the
   * same doorway and go through it one at a time, in whatever order they reach it. That is
   * both the correct behaviour and the reason this cannot reuse `stepCrossing`, which admits
   * from a single unit's member list.
   */
  private advanceLinks(dt: number): void {
    const b = this.battle;
    const p = b.pool;
    // Ninety-odd links on this circuit and a handful ever in use, so the common case must
    // cost nothing: no waiters and no path already built means the link is skipped entirely.
    for (const l of this.links) {
      for (let dir = 0; dir < 2; dir++) {
        const existing = dir === 0 ? l.ab : l.ba;
        if (!existing && !this.waiters.has(l.id * 2 + dir)) continue;
        const c = this.linkPath(l, dir === 0);
        if (this.mouthClear(c)) {
          const cand = this.pickWaiting(l.id, dir as 0 | 1, c);
          if (cand >= 0) {
            this.admitTo(c, cand);
            this.linkOf[cand] = l.id;
            this.linkDir[cand] = dir;
            this.wantLink[cand] = -1;
            // Off the ledger while he is in the doorway: he is neither standing on a station
            // nor available to be laid out, and every consumer keys on `stationOf < 0`.
            this.stationOf[cand] = ON_LINK;
          }
        }
        this.advanceQueue(c, dt, (i) => {
          l.used++;
          this.linkOf[i] = -1;
          const dest = c.destStation;
          if (dest < 0) {
            // Off the bottom of a stair, or out of a breach: he is on the ground now.
            this.stationOf[i] = -1;
            b.elevated[i] = 0;
            b.support[i] = NO_SUPPORT;
          } else {
            this.stationOf[i] = dest;
            this.rankOf[i] = 0;
            b.elevated[i] = 1;
            b.support[i] = this.sy[dest];
          }
          p.setState(i, SoldierState.Idle);
        });
      }
    }
  }

  /**
   * Everybody waiting at a link mouth this tick, bucketed by `linkId * 2 + dir`.
   *
   * Rebuilt once per tick by `advancePlans`, which is already walking exactly these men, and
   * then read by `advanceLinks`. The first version had `advanceLinks` search for its own
   * candidates, which is `links x 2 x planned men` — 90 links against a cohort of 80 is
   * 14,400 array reads per tick to admit at most a handful of people, and it ran inside
   * `postIntegrate` where the budget is 4 ms for six thousand men. This is O(planned men).
   *
   * A plain `Map` of arrays rather than a per-link field so a battle with no orders in
   * progress allocates nothing and the whole system costs one `size === 0` test.
   */
  private waiters = new Map<number, number[]>();

  private noteWaiting(i: number, linkId: number, dir: 0 | 1): void {
    const key = linkId * 2 + dir;
    const arr = this.waiters.get(key);
    if (arr) arr.push(i);
    else this.waiters.set(key, [i]);
  }

  /**
   * The waiting man nearest the mouth, or -1.
   *
   * Nearest rather than first in member order, because the file that forms at a doorway is
   * physical: the man at the front goes through, and which man that is depends on where the
   * unit came from. Ties break on the lower soldier index, so it is deterministic.
   */
  private pickWaiting(linkId: number, dir: 0 | 1, c: Crossing): number {
    const p = this.battle.pool;
    const arr = this.waiters.get(linkId * 2 + dir);
    if (!arr) return -1;
    let best = -1;
    let bestD = LINK_ADMIT * LINK_ADMIT;
    for (const i of arr) {
      if (!p.aliveAt(i)) continue;
      if (this.crossOf[i] !== -1) continue;
      const dx = p.x[i] - c.pts[0];
      const dz = p.z[i] - c.pts[2];
      const d = dx * dx + dz * dz;
      if (d < bestD - 1e-9) { bestD = d; best = i; }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // The train
  // -------------------------------------------------------------------------

  /**
   * Roll a siege tower at the wall, with `unitId`'s men crewing and boarding it.
   *
   * `targetX/targetZ` names the stretch of curtain it is aimed at; the tower squares up to
   * that bay's own normal, because a tower that arrives at an angle cannot land its ramp.
   */
  spawnTower(x: number, z: number, targetX: number, targetZ: number, unitId: number): number {
    if (this.towers.length >= MAX_TOWERS || this.nStations === 0) return -1;
    const station = this.stationNear(targetX, targetZ);
    if (station < 0) return -1;
    const t: SiegeTower = {
      id: this.towers.length,
      x, z,
      y: this.battle.groundAt(x, z),
      facing: 0,
      wantFacing: 0,
      heave: 0,
      idle: 0,
      state: TowerState.Approach,
      deckY: 0,
      dockX: x,
      dockZ: z,
      station,
      ramp: 0,
      unitId,
      boarders: [unitId],
      crossed: 0,
      crossing: null,
      dist: 0,
      rampLen: RAMP_LEN,
      rampLanded: 0,
      rampReach: 0,
    };
    // Every docking number is solved in one place so that a tower the player re-aims docks
    // to the same standard as one the scenario placed. See `aimTowerAt`.
    this.aimTowerAt(t, station);
    t.facing = t.wantFacing;
    this.towers.push(t);
    this.owned.add(unitId);
    return t.id;
  }

  /**
   * Send a ram at a gate.
   *
   * `gateId` is optional and defaults to the city's first gate, which is what every caller
   * used to get whether it wanted it or not. Naming it is how a scenario points two crews at
   * two different gates on a city that has three; leaving it out is how the Rome and Carthage
   * assaults keep the deployment they were measured with. **The default is `getGates()[0]`
   * and never a literal** — see `SiegeRam.gateId`.
   */
  spawnRam(x: number, z: number, unitId: number, gateId?: string): number {
    // Counted by kind, not by `rams.length`: the two machines draw from separate instanced
    // meshes with separate capacities, and sharing one counter meant a great ram on the
    // field silently used up a gate ram's slot.
    const gates = this.rams.reduce((a, r) => a + (r.kind === RamKind.Gate ? 1 : 0), 0);
    if (gates >= MAX_RAMS || !this.city) return -1;
    const all = this.city.getGates();
    const gate = (gateId ? all.find((g) => g.id === gateId) : undefined) ?? all[0];
    if (!gate) return -1;
    const r: SiegeRam = {
      id: this.rams.length,
      kind: RamKind.Gate,
      x, z,
      y: this.battle.groundAt(x, z),
      facing: Math.atan2(gate.x - x, gate.z - z),
      wantFacing: Math.atan2(gate.x - x, gate.z - z),
      heave: 0,
      gateId: gate.id,
      swing: 0,
      timer: RAM_PERIOD,
      arrived: false,
      unitId,
      // Stop with the head against the leaves, not inside them.
      targetX: gate.x + Math.sin(gate.facing) * (RAM_HALF_D + 3.6),
      targetZ: gate.z + Math.cos(gate.facing) * (RAM_HALF_D + 3.6),
      blows: 0,
      bay: -1,
      station: -1,
      state: RamState.Approach,
      parkX: x,
      parkZ: z,
      wreck: false,
      derelictFor: 0,
    };
    this.rams.push(r);
    this.owned.add(unitId);
    return r.id;
  }

  /**
   * Roll the great ram at a stretch of curtain — the *testudo arietaria* proper.
   *
   * Distinct from the gate ram in target as well as in size, and that is the decision the
   * brief asked for: **it attacks the curtain, not the gate.** A gate is a pair of oak
   * leaves and 26 blows from a light ram will have them down; there is no reason to build
   * something three times the mass to do a job a smaller machine already does. The only
   * reason to build this is to make a hole where the defence has not prepared one — to
   * refuse the killing ground behind the gate and take the wall somewhere of your choosing.
   * So it squares up to a bay and works on masonry, at 74 blows and seven seconds a blow.
   */
  spawnGreatRam(x: number, z: number, targetX: number, targetZ: number, unitId: number): number {
    const greats = this.rams.reduce((a, r) => a + (r.kind === RamKind.Great ? 1 : 0), 0);
    if (greats >= MAX_GREAT_RAMS || this.nStations === 0) return -1;
    const station = this.stationNear(targetX, targetZ);
    if (station < 0) return -1;
    const nx = this.snx[station];
    const nz = this.snz[station];
    // Head against the masonry, shed clear of it: the same face-relative standoff the tower
    // uses, because the same mistake — measuring from the bay centreline instead of from the
    // wall's outer face — drove four towers 0.70 m into the brickwork.
    const standoff = this.sFace[station] + 0.4 + GREAT_RAM_HALF_D + GREAT_RAM_REACH * 0.0;
    const tx = this.sx[station] + nx * standoff;
    const tz = this.sz[station] + nz * standoff;
    const r: SiegeRam = {
      id: this.rams.length,
      kind: RamKind.Great,
      state: RamState.Approach,
      x, z,
      y: this.battle.groundAt(x, z),
      facing: Math.atan2(-nx, -nz),
      wantFacing: Math.atan2(-nx, -nz),
      heave: 0,
      gateId: '',
      swing: 0,
      timer: GREAT_RAM_PERIOD,
      arrived: false,
      unitId,
      targetX: tx,
      targetZ: tz,
      blows: 0,
      bay: this.sBay[station],
      station,
      parkX: x,
      parkZ: z,
      wreck: false,
      derelictFor: 0,
    };
    this.rams.push(r);
    this.owned.add(unitId);
    return r.id;
  }

  /** One blow of the great ram on the bay it is squared up to. */
  private strikeCurtain(r: SiegeRam): void {
    if (r.bay < 0) return;
    const n = (this.bayBlows.get(r.bay) ?? 0) + 1;
    this.bayBlows.set(r.bay, n);
    if (n < WALL_BLOWS || this.breachedBays.includes(r.bay)) return;
    this.breachBay(r);
  }

  /**
   * Bring a bay down, and say what a breach in a curtain actually *is*.
   *
   * A hole in a wall is not a doorway. What a ram leaves is a **practicable breach**: the
   * face collapses outward into a slope of its own rubble, and the storming party goes up
   * that slope, over the stub, and down the inside. It is climbed, not walked through. That
   * matters mechanically as well as historically, because it means a breach is the same
   * object as everything else on this wall — a `Crossing` — and inherits the properties the
   * representation already guarantees rather than needing a hole punched in the nav grid to
   * be safe.
   *
   * It is stormed in `BREACH_LANES` files abreast rather than one, because the whole point
   * of preferring a breach to a gate is that it is wider than a gate. Five lanes at 1.6 m
   * centres is 8 m of front — twice the 4.3 m carriageway, which is the number that makes
   * the machine worth building.
   *
   * Three things happen to the wall itself. The stations over the hole stop being places to
   * stand; `recut` therefore splits the run in two, and every consumer that already refuses
   * to cross a run boundary refuses to cross the breach with no new code. Any garrison
   * standing on the collapsed stretch has to go somewhere, and does. And the city is asked
   * to cut the passage in its own occupancy raster if it can — see `breachWall` on
   * `CityView`, and the patch in this workstream's report for the day it can.
   */
  private breachBay(r: SiegeRam): void {
    const st = r.station;
    if (st < 0 || this.breachedBays.includes(r.bay)) return;
    this.breachedBays.push(r.bay);

    // ---- the masonry comes down -------------------------------------------
    const bounds = this.runBounds(st);
    const half = Math.max(1, Math.round(BREACH_HALF_W / STATION_PITCH));
    const lo = Math.max(bounds.lo, st - half);
    const hi = Math.min(bounds.hi, st + half);
    for (let s = lo; s <= hi; s++) {
      this.sDead[s] = 1;
      this.sOwner[s] = -1;
    }
    this.recut();
    this.buildLinks();
    this.invalidateWallTraffic();

    // ---- the men who were standing on it ----------------------------------
    this.rehouseTheFallen(lo, hi);

    // ---- the way through --------------------------------------------------
    const nx = this.snx[st];
    const nz = this.snz[st];
    const ax = -nz;
    const az = nx;
    const outFoot = this.sFace[st] + 5.0;
    const inFoot = this.sInner[st] - 5.0;
    const crestY = this.sy[st] - BREACH_STUB_DROP;
    for (let k = 0; k < BREACH_LANES; k++) {
      const along = (k - (BREACH_LANES - 1) * 0.5) * 1.6;
      const cx = this.sx[st] + ax * along;
      const cz = this.sz[st] + az * along;
      const ox = cx + nx * outFoot;
      const oz = cz + nz * outFoot;
      const ix = cx + nx * inFoot;
      const iz = cz + nz * inFoot;
      const l: WallLink = {
        id: this.links.length, kind: LinkKind.Breach,
        runA: -1, runB: -1, stationA: -1, stationB: -1,
        ax: ox, az: oz, ay: this.battle.groundAt(ox, oz),
        bx: ix, bz: iz, by: this.battle.groundAt(ix, iz),
        rise: this.battle.groundAt(ix, iz) - this.battle.groundAt(ox, oz),
        ab: null, ba: null, used: 0, lane: k,
      };
      // Over the rubble in the middle: a breach is climbed, and the stub of wall left
      // standing is what a man goes over.
      l.ab = this.makeCrossing([
        l.ax, l.ay, l.az,
        cx + nx * (this.sFace[st] * 0.5), crestY, cz + nz * (this.sFace[st] * 0.5),
        cx + nx * (this.sInner[st] * 0.5), crestY, cz + nz * (this.sInner[st] * 0.5),
        l.bx, l.by, l.bz,
      ], -1, CROSS_PASS);
      l.ba = this.makeCrossing([
        l.bx, l.by, l.bz,
        cx + nx * (this.sInner[st] * 0.5), crestY, cz + nz * (this.sInner[st] * 0.5),
        cx + nx * (this.sFace[st] * 0.5), crestY, cz + nz * (this.sFace[st] * 0.5),
        l.ax, l.ay, l.az,
      ], -1, CROSS_PASS);
      this.links.push(l);
      this.breachLinks.push(l.id);
    }

    // The city cuts its own nav if it knows how; absent, the breach is still crossable by
    // the lanes above, which is the mechanic. See the report.
    this.city?.breachWall?.(this.sx[st], this.sz[st], BREACH_HALF_W);
    this.ctx.events.emit('cameraShake', { amplitude: 1.6, decay: 0.7 });
    // The machine has done what it was built for. Get it off the rubble.
    this.beginWithdraw(r);
  }

  /**
   * Throw away every reference to the wall graph that the collapse has just invalidated.
   *
   * `recut` renumbers the runs and `buildLinks` rebuilds `this.links` from scratch, so after
   * a breach every stored index is pointing at something else or at nothing:
   *
   *   - `plan.stair` and `plan.destRun` are integers into arrays that no longer mean what
   *     they meant. A descent whose `stair` index now names a tower pass would walk a cohort
   *     into a doorway instead of down a flight, and one that is now out of range would take
   *     the `!stair` branch every tick for ever.
   *   - Worse, a man mid-crossing is in the `queue` of a `Crossing` hanging off the *old*
   *     link objects. `advanceLinks` only ever walks `this.links`, so nothing would advance
   *     him again: he would hang in a tower doorway at the height he had reached, for the
   *     rest of the battle, with `crossOf` permanently set.
   *
   * Both are silent. Neither would fail an assertion that was not looking for it. So the
   * collapse discards all of it and puts everyone back on a station they are demonstrably
   * standing on — orders are cheap to reissue and a man frozen in mid-air is not recoverable.
   */
  private invalidateWallTraffic(): void {
    const b = this.battle;
    const p = b.pool;
    for (const l of this.links) { l.ab = null; l.ba = null; }
    this.plans.clear();
    this.waiters.clear();
    for (let i = 0; i < this.crossOf.length; i++) {
      this.wantLink[i] = -1;
      if (this.linkOf[i] < 0) continue;
      // He was inside a doorway that no longer exists. Put him on the nearest live station,
      // or on the ground if the whole run has gone.
      this.linkOf[i] = -1;
      this.crossOf[i] = -1;
      const st = p.aliveAt(i) ? this.stationNear(p.x[i], p.z[i]) : -1;
      if (st >= 0 && !this.dead(st)) {
        this.stationOf[i] = st;
        this.rankOf[i] = 0;
        b.elevated[i] = 1;
        b.support[i] = this.sy[st];
      } else {
        this.stationOf[i] = -1;
        b.elevated[i] = 0;
        b.support[i] = NO_SUPPORT;
      }
      if (p.aliveAt(i) && p.state[i] === SoldierState.Climbing) p.setState(i, SoldierState.Idle);
    }
  }

  /**
   * Move anybody who was standing on the stretch that just fell.
   *
   * They are not killed here. `BattleSystem.damage` is the only thing in the sim allowed to
   * kill a man and this is not it — a collapsing wall throwing men down is a Combat
   * decision, not a geometry one. What this guarantees is the invariant this file owns:
   * nobody is left standing on a station that no longer exists, which would leave him
   * hovering at the old walkway height over an eight-metre hole.
   */
  private rehouseTheFallen(lo: number, hi: number): void {
    const b = this.battle;
    const p = b.pool;
    for (const [id] of this.garrisons) {
      const u = b.unitById(id);
      if (!u || u.destroyed) continue;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        const s = this.stationOf[i];
        if (s < lo || s > hi) continue;
        // Nearest surviving station on either side of the hole, else down to the ground.
        let dest = -1;
        for (let k = 1; k < 400; k++) {
          if (lo - k >= 0 && !this.dead(lo - k)) { dest = lo - k; break; }
          if (hi + k < this.nStations && !this.dead(hi + k)) { dest = hi + k; break; }
        }
        if (dest < 0) {
          this.stationOf[i] = -1;
          b.elevated[i] = 0;
          b.support[i] = NO_SUPPORT;
          continue;
        }
        this.stationOf[i] = dest;
        this.rankOf[i] = 0;
        b.support[i] = this.sy[dest];
      }
    }
  }

  /**
   * Rest a ladder against the parapet nearest `(x, z)` and send `unitId` up it.
   *
   * Escalade is the cheap assault: no machine, no months of carpentry, and a casualty rate
   * that makes it the thing you do when you have more men than time. Mechanically it is
   * the same crossing as a tower ramp with a steeper path and no vehicle.
   */
  spawnLadder(x: number, z: number, unitId: number): boolean {
    if (this.ladders.length >= MAX_LADDERS || this.nStations === 0) return false;
    const station = this.stationNear(x, z);
    if (station < 0) return false;
    const nx = this.snx[station];
    const nz = this.snz[station];
    /**
     * Pitch and footing solved from the wall, not chosen and hoped for.
     *
     * A ladder has to reach: its head must land *on* the parapet, and that fixes the
     * relationship between how tall the wall is, how far out the foot stands and how far it
     * leans. The first version put the foot at a flat 3.65 m from the centreline and leaned
     * the ladder by `atan2(1.6, rise)` — 11 degrees over an 8 m rise, which covers 1.55 m
     * horizontally and left every ladder head three quarters of a metre short of the
     * masonry, standing in mid-air beside a wall nobody could climb.
     *
     * 0.36 of the rise is a pitch of about 70 degrees from horizontal, the standard escalade
     * angle: steeper and the ladder tips backwards off the wall under a man's weight,
     * shallower and it bends and is easier to shove away from the parapet.
     */
    const headY = this.sy[station] + 0.9;
    const face = this.sFace[station];
    const probeX = this.sx[station] + nx * (face + 3.0);
    const probeZ = this.sz[station] + nz * (face + 3.0);
    const rise = Math.max(2, headY - this.battle.groundAt(probeX, probeZ));
    const run = rise * 0.36;
    const fx = this.sx[station] + nx * (face + run);
    const fz = this.sz[station] + nz * (face + run);
    this.ladders.push({
      x: fx, z: fz,
      footY: this.battle.groundAt(fx, fz),
      headY,
      // The hooks bite 0.25 m past the face, over the merlons.
      lean: Math.atan2(run + 0.25, rise),
      facing: Math.atan2(-nx, -nz),
      station,
      crossing: null,
      unitId,
      boarders: [unitId],
      crossed: 0,
    });
    this.owned.add(unitId);
    return true;
  }

  /**
   * Artillery machines are **not** drawn here.
   *
   * `src/units/engines.ts` and `UnitRenderSystem` own every stone-thrower and bolt-shooter
   * on the field: `isEngineUnit` claims any unit of class `artillery`, and `engineKindOf`
   * already resolves a high-arc missile to `EngineKind.Onager` with its own crew stations,
   * pitch and arm sweep. This workstream added the `onager` and `carroballista` *unit
   * definitions* and the stone ballistics; the machines those crews serve are theirs, and
   * drawing a second placeholder on top would have superimposed two machines at one spot
   * and cost ten draw calls for the privilege.
   *
   * Kept as a no-op rather than deleted from `scenario.ts` so the seam is explicit.
   */
  registerArtillery(u: UnitGroupState): void {
    void u;
  }

  // -------------------------------------------------------------------------
  // Tick — before steering
  // -------------------------------------------------------------------------

  preSteer(dt: number): void {
    // Before the early-out: a city's gate is shut whether or not anybody is standing on the
    // wall, and this must not depend on a garrison existing. One boolean per tick.
    if (!this.gateArmed) this.armGate();
    // A battle with nothing on a structure pays one comparison for all of this. The field
    // battle runs 8,600 men and never touches a wall; it must not pay for the siege.
    //
    // `ordered` is in the test because a unit ordered *onto* an ungarrisoned wall is the one
    // case where nothing is owned yet and there is still work to do — and because a queue
    // left unconsumed would grow for the length of a field battle.
    if (this.owned.size === 0 && this.garrisons.size === 0 && this.ordered.size === 0) return;
    // A player order arrives between ticks and this runs before `trackOwnedAnchors` can
    // overwrite the target it came with, which is the whole reason the interception works
    // without a patch anywhere else. See `interceptOrders`.
    this.interceptOrders();
    this.releaseBrokenCrews(dt);
    this.updateGarrisons();
    this.advancePlans();
    this.updateTowers(dt);
    this.updateRams(dt);
    this.updateLadders(dt);
    // After the machines have moved, because a crew musters on where its machine *is*.
    this.musterOwned();
  }

  /**
   * Let a crew that has broken actually run.
   *
   * `BattleSystem.steerSoldiers` tests `ownsUnit` *before* it tests for a rout, so a
   * siege-owned unit is steered to its muster slots whatever its morale — and `musterRams`
   * rewrites those slots at the machine every tick. The result was reported by the player
   * and is worth stating exactly: a ram crew that broke could not leave, so the defenders
   * went on killing men who were pinned to the machine in the middle of the carriageway, and
   * the gate the ram had just opened stayed corked by the fight in it. Nothing died, nothing
   * moved, and the assault stalled on its own success.
   *
   * A machine is a thing you abandon. The moment its crew breaks they stop being the crew,
   * the siege system lets go of them, and they rout like anybody else.
   */
  private releaseBrokenCrews(dt: number): void {
    const b = this.battle;
    /**
     * A cohort that has broken is not queuing for a ladder either.
     *
     * The same rule as the ram, applied to the men the player *added* to a machine rather
     * than to the gang that owns it. Without it a routed cohort stays `owned`, stays
     * mustered in the file, and cannot run — the exact pin that kept a broken ram crew
     * standing in a gateway being killed. Crews are index 0 and are never dropped here; a
     * machine with no gang stops, which `updateTowers` already handles.
     */
    for (const t of this.towers) this.dropBrokenBoarders(t.boarders);
    for (const l of this.ladders) this.dropBrokenBoarders(l.boarders);
    /**
     * And the gang itself, once it has broken.
     *
     * `updateTowers` already halts a machine whose crew has routed, but the crew stayed
     * `owned`, so `steerToSlots` held it at a muster point it was trying to run from — the
     * same pin the ram had. Released here, it becomes an ordinary routing formation. It is
     * *not* dropped from `boarders`, because a rally puts it straight back to work; the
     * `mayBoard` test is what keeps it out of the file in the meantime.
     *
     * **The release used to be skipped entirely for any party that was also a garrison, and
     * that is the second thing the owner reported.** `adoptBoarders` creates a `garrisons`
     * entry the moment the *first* man of an escalade party gets over the parapet, so from
     * that instant `garrisons.has(unitId)` was true and this loop `continue`d past the party
     * for the rest of the battle. When it then broke, the forty men still standing at the
     * foot of the ladders stayed `owned`; `musterOwned` had already stopped writing their
     * slots, because `mayBoard` is false for a routing unit, so `steerToSlots` went on
     * driving each of them at a **muster slot frozen at the last tick before they broke**.
     *
     * Measured at the storm of Rome, one escalade party over 3 s of rout: median speed over
     * the ground **1.11 m/s against the 4.35 m/s a routing man runs at** — and 1.11 is not
     * even a walk toward safety, it is `steerToSlots`' walk toward the wall — with 13.5% of
     * all man-ticks under 0.2 m/s and the men who had already arrived at their stale slot
     * sitting at exactly `|v| = 0`. A man rooted to the spot playing a run cycle: the
     * animation was the only honest part of it.
     *
     * Keyed on the unit while rout is keyed on the man is what made this hard to see, and it
     * is why the guard is now on the *man* — `stationOf === -1`, he is on the grass — and not
     * on whether some mate of his is up a ladder.
     */
    for (const m of [...this.towers, ...this.ladders]) {
      const u = b.unitById(m.unitId);
      if (!this.broken(u)) {
        // Rallied, and the machine is still theirs. Only a unit this loop let go of is taken
        // back: `releaseToGround` also drops a party out of `owned`, on purpose, when the
        // player has ordered it down off the wall — re-adopting that one would pin an
        // escalade party to the ladders it had just been ordered to leave.
        if (this.brokeOff.delete(m.unitId)) this.owned.add(m.unitId);
        continue;
      }
      /**
       * A party that breaks half way up a wall is in three places, and the release has to
       * answer for each of them separately.
       *
       * This is the owner's second report — *"some of the soldiers on top of the wall are
       * routed, some of the soldiers at the bottom are routed, and so they kind of are all
       * stuck half on the wall half off"* — and it is what "release the unit" means when the
       * unit is not in one place. Traced on an escalade party of 92 at the storm of Rome, 2
       * men on the parapet, 41 on the rungs and 49 on the grass at the instant it broke:
       *
       *  - the 49 on the grass were released and ran, correctly;
       *  - the 41 on the rungs **finished climbing onto the wall they were fleeing**, so the
       *    parapet count went 2 → 38 while the unit was routing;
       *  - and every one of those men, the unit no longer being siege-owned, was handed a
       *    *field formation slot* at the rout point — 260 m away in the mean and 325 m at
       *    the worst, on the ground, through solid masonry. `holdGarrisonsOnTheWalk` keeps
       *    him on the stone because he is still in `garrisons`, so he grinds along the
       *    parapet at the end of his run for the rest of the battle.
       *
       * So the release is now conditional on where the men actually are. A party with
       * anybody still on the stonework or on a path **stays siege-owned** — that is the only
       * thing in this simulation that can place a man on a wall — and is given a descent
       * plan, which is what a broken garrison does: it runs for the stairs. Its men on the
       * grass are steered away by `musterOwned`'s flight slot, at a run, so keeping the unit
       * does not re-create the pin that this loop exists to prevent. Only when the last man
       * is off the stone does the unit go back to the field.
       */
      if (u && this.someoneOnTheStone(u)) {
        this.routOffTheWall(u);
        continue;
      }
      if (this.owned.delete(m.unitId)) this.brokeOff.add(m.unitId);
      if (!u) continue;
      for (const i of u.members) {
        /**
         * Only a man who is demonstrably standing on the ground.
         *
         * Was `stationOf[i] >= 0`, which is the test every *layout* consumer uses and the
         * wrong one here: `PENDING_SLOT` and `ON_LINK` are both negative, so a man who had
         * just come over the parapet — or who was standing in a tower doorway — read as
         * "on the ground" and had his `support` cut from under him. `crossOf` covers the
         * doorway case today and so it never fired, but this is the shape of the fault that
         * once dropped nine climbing men from eight metres, and it costs nothing to ask the
         * question that is actually meant. `-1` is the only value that means the grass.
         */
        if (this.crossOf[i] !== -1 || this.stationOf[i] !== -1) continue;
        b.elevated[i] = 0;
        b.support[i] = NO_SUPPORT;
      }
    }
    for (const r of this.rams) {
      if (r.wreck) continue;
      const u = b.unitById(r.unitId);

      if (this.broken(u)) {
        /**
         * Derelict. Somebody else can have a turn.
         *
         * The scenario crews this machine with sixteen men and they are shot off it on the
         * way in — measured: the crew is down to one man by t+90 and the unit is destroyed by
         * t+270, and with the pin removed the ram then stood 16 m short of the gate for the
         * rest of the battle and landed **0 blows** where the unmodified tree landed 26.
         *
         * That is worth being blunt about: the 26 blows the old code scored were a *product
         * of the bug*. A routed crew that could not run away kept its hands on the machine
         * and kept pushing it. Fixing the pin honestly and changing nothing else would have
         * traded the player's complaint for a gate that never opens, which is worse.
         *
         * A ram is not one small unit's toy, it is an army's asset, and an army that has
         * spent a month building one does not abandon it because the first gang broke. So it
         * takes a fresh gang from whoever is nearest. If nobody comes for `DERELICT_LIMIT`
         * seconds it really has been abandoned, and then it is a wreck.
         */
        if (this.owned.has(r.unitId)) {
          this.owned.delete(r.unitId);
          const old = b.unitById(r.unitId);
          if (old) {
            for (const i of old.members) {
              b.elevated[i] = 0;
              b.support[i] = NO_SUPPORT;
            }
          }
        }
        if (this.recrew(r)) continue;
        r.derelictFor += dt;
        if (r.derelictFor >= DERELICT_LIMIT) {
          r.wreck = true;
          r.state = RamState.Wreck;
        }
        continue;
      }
      r.derelictFor = 0;

      // Working normally. `broken` is an ordinary boolean rather than a type predicate — see
      // the note on it — so `u` is narrowed here by hand rather than by control flow.
      if (u && !this.owned.has(u.id)) this.owned.add(u.id);
    }
  }

  private updateGarrisons(): void {
    const b = this.battle;
    const p = b.pool;
    const slot = { x: 0, y: 0, z: 0, f: 0 };
    for (const [id, g] of this.garrisons) {
      const u = b.unitById(id);
      if (!u || u.destroyed) continue;
      // Re-form once the line has lost enough men to have visible holes in it. Six per
      // cent rather than every tick: re-laying every frame makes the whole garrison
      // shuffle a few centimetres on every casualty, which reads as a nervous twitch
      // running down the wall.
      // A unit under orders is laid out by `advancePlans`, which knows which of its men are
      // actually up here and which are still on a stair. Re-forming it from this side as
      // well would fight that every tick: the two disagree about the roll, so the unit would
      // shuffle between two layouts at 30 Hz.
      const planned = this.plans.has(id);
      if (!planned && !g.sticky && (g.plannedFor < 0 || u.alive < g.plannedFor * 0.94)) {
        this.layOutGarrison(u, g, undefined, true);
      }
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        const st = this.stationOf[i];
        if (st < 0) continue;
        this.slotAt(i, st, this.rankOf[i], slot);
        b.elevated[i] = 1;
        // Support from the stone he is on; the slot only says where he is walking to.
        b.support[i] = this.sy[this.standingStation(i, st)];
        b.slotX[i] = slot.x;
        b.slotZ[i] = slot.z;
        b.slotFacing[i] = slot.f;
      }
    }
  }

  private updateTowers(dt: number): void {
    const b = this.battle;
    for (const t of this.towers) {
      const dx = t.dockX - t.x;
      const dz = t.dockZ - t.z;
      t.dist = Math.sqrt(dx * dx + dz * dz);

      /**
       * A tower nobody is pushing does not roll. Same defect as the ram, same fix.
       *
       * Reported from a playtest as "the ram gets routed and the people flee yet it keeps
       * moving forward", and a *turris ambulatoria* had exactly the same hole: `t.x` and
       * `t.z` were advanced every tick with no reference to whether the crew still existed.
       * Fifteen tonnes of green timber is moved by a gang on levers and rollers; when the
       * gang breaks it stops, and it stops *where it is*, in the open, which is the moment
       * the defenders have been waiting for.
       *
       * The mesh follows because `writeTowers` positions the shaft, deck, wheels and ramp
       * from `t.x/t.y/t.z` — these fields, not the crew unit's anchor — so freezing the
       * simulation freezes what the player sees. (Artillery is the opposite case: its mesh
       * is placed off the *unit* anchor, which is why the onager's answer is a zero walk
       * speed in `siegeUnits.ts` rather than a gate here.)
       */
      const crew = b.unitById(t.unitId);
      const manned = !!crew && !crew.destroyed && crew.alive > 0
        && crew.order !== UnitOrder.Rout;
      if (!manned && t.state === TowerState.Approach) {
        t.y = b.groundAt(t.x, t.z);
        continue;
      }

      if (t.state === TowerState.Approach) {
        /**
         * Levering the frame round after the player has re-aimed it.
         *
         * A tower does not turn, it is turned: the rollers come out, go back in across the
         * new bearing, and the gang heaves. `TOWER_HEAVE` seconds of that with no forward
         * movement is what makes a change of target a decision with a price rather than a
         * free steer, and it is the difference between commanding fifteen tonnes of green
         * timber and driving it.
         */
        if (t.wantFacing !== t.facing) {
          let d = t.wantFacing - t.facing;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          const step = TOWER_SLEW * dt;
          t.facing = Math.abs(d) <= step ? t.wantFacing : t.facing + Math.sign(d) * step;
        }
        if (t.heave > 0) {
          t.heave -= dt;
          t.y = b.groundAt(t.x, t.z);
          continue;
        }
        if (t.dist <= TOWER_SPEED * dt) {
          t.x = t.dockX;
          t.z = t.dockZ;
          t.facing = t.wantFacing;
          t.state = TowerState.Docking;
        } else {
          t.x += (dx / t.dist) * TOWER_SPEED * dt;
          t.z += (dz / t.dist) * TOWER_SPEED * dt;
        }
        t.y = b.groundAt(t.x, t.z);
        // The deck is fixed relative to the wall it is going to, not to the ground under
        // the tower: the whole machine is built to a measured height before it is moved.
        continue;
      }

      if (t.state === TowerState.Docking) {
        t.ramp = Math.min(1, t.ramp + dt / RAMP_FALL);
        if (t.ramp >= 1) {
          t.state = TowerState.Landing;
          t.crossing = this.buildTowerCrossing(t);
          this.ctx.events.emit('cameraShake', { amplitude: 0.35, decay: 2.0 });
        }
        continue;
      }

      if (t.state === TowerState.Landing) t.state = TowerState.Boarding;

      /**
       * A tower whose file is empty has finished, and says so.
       *
       * The condition is asked with `mayBoard` — **the same predicate `stepCrossing` admits
       * men by** — and not with a hand-rolled "is anybody left" test. That is the trap this
       * file has paid for three times: `musterOwned` and `stepCrossing` once used different
       * tests for the same question and a routed party froze the player's cohort 14.6 m from
       * a 1.6 m admission radius. If a unit is not one this machine will admit, it is not a
       * unit this machine is waiting for.
       *
       * Spending it hands the gang back, exactly as the ram's `Spent` branch does and for the
       * same reason: a machine that is finished has no further claim on a cohort, and a unit
       * the siege system owns is steered to absolute muster slots and cannot form line,
       * charge or be given a formation.
       */
      if (t.state === TowerState.Boarding) {
        let waiting = t.crossing ? t.crossing.queue.length : 0;
        for (const id of t.boarders) {
          const bu = b.unitById(id);
          if (!this.mayBoard(bu)) continue;
          for (const i of bu.members) {
            if (!b.pool.aliveAt(i)) continue;
            // Still on the field side: not up on the stone and not already on the ramp.
            if (this.stationOf[i] < 0 && this.crossOf[i] === -1 && b.elevated[i] === 0) waiting++;
          }
        }
        if (waiting > 0) t.idle = 0;
        else {
          t.idle += dt;
          if (t.idle >= TOWER_IDLE_LIMIT) {
            t.state = TowerState.Spent;
            this.releaseCrew(t.unitId);
          }
        }
      }
    }
  }

  /**
   * Give a machine's gang back to the player.
   *
   * Lifted out of the ram's `Spent` branch so the tower cannot do three quarters of it. Men
   * who are up on the stonework or on a crossing are left alone — they are the siege system's
   * until they are somewhere a formation can stand — and only the ones still on the ground
   * are handed back to `steerToSlots`.
   */
  private releaseCrew(unitId: number): void {
    if (!this.owned.has(unitId)) return;
    this.owned.delete(unitId);
    const u = this.battle.unitById(unitId);
    if (!u) return;
    for (const i of u.members) {
      if (this.stationOf[i] >= 0 || this.crossOf[i] !== -1) continue;
      this.battle.elevated[i] = 0;
      this.battle.support[i] = NO_SUPPORT;
    }
    if (u.order === UnitOrder.Garrison) u.order = UnitOrder.MoveTo;
  }

  /**
   * The path a man takes from the ground behind a docked tower to the wall-walk.
   *
   * Five legs: to the tower's back door, up the internal stair, forward across the deck,
   * out along the ramp, and one pace clear of the ramp head onto the stonework. The climb
   * happens inside the hide screen, which is why it can be a straight vertical rise and
   * still read correctly — you cannot see it, and nor could you in 271.
   */
  private buildTowerCrossing(t: SiegeTower): Crossing {
    const cos = Math.cos(t.facing);
    const sin = Math.sin(t.facing);
    // Local (right, forward) -> world, where forward is the way the tower faces.
    const w = (rx: number, fz: number): [number, number] => [t.x + rx * cos + fz * sin, t.z - rx * sin + fz * cos];
    const s = this.slotStation(t.station);
    const back = w(0, -(TOWER_HALF_D + 1.4));
    const enter = w(0, -(TOWER_HALF_D - 0.55));
    const pts: number[] = [back[0], t.y, back[1], enter[0], t.y, enter[1]];

    // Up the inside on a zig-zag stair, landing on each floor.
    //
    // The rear of the tower is open lattice, so this climb is *visible* — it is the file
    // of men you can see standing on every level of the reference towers as they come on.
    // A straight vertical rise would have read as levitation through the frame; a flight
    // that reverses at each landing reads as a stair even though no stair is modelled,
    // because the men's own path is the thing you are watching.
    const rise = t.deckY - t.y;
    for (let f = 1; f <= TOWER_FLOORS; f++) {
      const y = t.y + (rise * f) / TOWER_FLOORS;
      // Alternate sides at each landing.
      const side = f % 2 === 0 ? -1 : 1;
      // Rear face, matching the modelled stair in `buildTowerShaft`: the climb is meant to
      // be visible through the open back of the tower, which is the whole reason the back is
      // open. On the front face it happened behind the hide.
      const land = w(side * (TOWER_HALF_W - 0.55), -(TOWER_HALF_D - 0.55));
      pts.push(land[0], y, land[1]);
    }
    // Across the deck, out along the ramp, and one pace clear onto the stonework.
    const deckFront = w(0, TOWER_HALF_D - 0.3);
    /**
     * Where the ramp head rests, in the tower's own frame.
     *
     * `t.rampReach`, not a hand-picked 3.2 m: this is the same number the renderer scales
     * and pitches the timber by, so the men walk on the plank that is drawn rather than
     * beside it. The two were independent before, which is survivable only while both happen
     * to be right — and the drawn one was not.
     */
    const rampEnd = w(0, TOWER_HALF_D + t.rampReach);
    pts.push(deckFront[0], t.deckY, deckFront[1]);
    pts.push(rampEnd[0], s.y, rampEnd[1]);
    pts.push(s.x, s.y, s.z);
    return this.makeCrossing(pts, t.station);
  }

  /**
   * How long the *pons* is and how it is pitched right now.
   *
   * Both are cut to the machine at spawn — see `spawnTower` — because a boarding ramp is a
   * piece of timber, not a telescope. Only the pitch animates: `+90 degrees` stowed, upright
   * against the front of the tower, easing down to the angle that lands the lip on the walk.
   *
   * The landed pitch is **negative**, and that sign is load-bearing. The deck is built half a
   * metre proud of the walkway, so the ramp falls onto the wall; a ramp that has to be
   * pushed *up* onto a parapet is one that does not reach it. An earlier version had the
   * sign inverted and the probe caught it as a head floating 110 cm above the stonework —
   * twice the deck's own 55 cm of clearance, which is the signature of a flipped sign rather
   * than a mistuned constant.
   */
  private rampSpan(t: SiegeTower): { len: number; pitch: number } {
    return { len: t.rampLen, pitch: lerp(Math.PI * 0.5, t.rampLanded, t.ramp) };
  }

  /**
   * Where a tower's ramp head has actually been **drawn**, read back out of the instance
   * matrix the renderer wrote rather than recomputed from the numbers that produced it.
   *
   * This replaces `rampHeadY`, and the replacement is the entire point. `rampHeadY` returned
   * `deckY + sin(pitch)·RAMP_LEN` — the head's height derived analytically from the same
   * inputs as the transform — so it agreed with the renderer's mistake perfectly and
   * reported all four heads 0.0 cm from the walkway while every one of them was drawn 3.36 m
   * out from the wall, raked backwards over the machine. Twenty-five assertions passed on
   * top of a ramp a player could see was wrong, which is precisely what happened to the
   * ladders before them and precisely what `drawnLadderHead` exists to prevent.
   *
   * Returns false before the first frame, when there is no matrix to read; the probe treats
   * a head it could not measure as a failure rather than as a pass.
   */
  private drawnRampHead(n: number, out: THREE.Vector3): boolean {
    if (!this.mRamp || n >= this.mRamp.count) return false;
    this.mRamp.getMatrixAt(n, TMP_M);
    // (0, 0, -RAMP_LEN) is the iron-shod lip in `buildTowerRamp`, before the per-instance
    // stretch that the matrix itself carries.
    out.set(0, 0, -RAMP_LEN).applyMatrix4(TMP_M);
    return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z);
  }

  private slotStation(station: number): { x: number; y: number; z: number } {
    const s = clamp(station, 0, this.nStations - 1) | 0;
    const off = this.sOuter[s];
    return { x: this.sx[s] + this.snx[s] * off, y: this.sy[s], z: this.sz[s] + this.snz[s] * off };
  }

  private makeCrossing(flat: number[], destStation: number, pace = CROSS_WALK): Crossing {
    const n = flat.length / 3;
    const pts = new Float32Array(flat);
    const arc = new Float32Array(n);
    for (let k = 1; k < n; k++) {
      const dx = pts[k * 3] - pts[(k - 1) * 3];
      const dy = pts[k * 3 + 1] - pts[(k - 1) * 3 + 1];
      const dz = pts[k * 3 + 2] - pts[(k - 1) * 3 + 2];
      arc[k] = arc[k - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return { pts, arc, n, destStation, queue: [], pace };
  }

  /**
   * Unit ids whose `missileTaken` this system has written, so it can put them back.
   *
   * `modsOf` is a shared per-unit table that `Abilities` also writes, so a multiplier left
   * behind on a cohort that has stopped crewing anything would follow it round the field for
   * the rest of the battle. Tracked explicitly and restored the tick the machine stops being
   * theirs — `recrew` reassigns gangs mid-battle, so this cannot be done at spawn.
   */
  private sheltered = new Set<number>();

  /** Put the gang of every live ram under its own roof, and take everyone else out from under it. */
  private applyShedCover(): void {
    const want = new Set<number>();
    for (const r of this.rams) {
      if (r.wreck || r.state === RamState.Wreck || r.state === RamState.Spent) continue;
      if (!this.owned.has(r.unitId)) continue;
      if (!this.atTheMachine(r)) continue;
      want.add(r.unitId);
    }
    for (const id of this.sheltered) {
      if (want.has(id)) continue;
      modsOf(id).missileTaken = 1;
      this.sheltered.delete(id);
    }
    for (const id of want) {
      modsOf(id).missileTaken = RAM_SHED_COVER;
      this.sheltered.add(id);
    }
  }

  /**
   * Is this machine's gang actually at it, and small enough to shelter under it?
   *
   * **`applyShedCover` had no distance test and no size test.** It wrote `missileTaken` on
   * whichever unit `SiegeRam.unitId` named, wherever its men were standing and however many
   * of them there were. That is harmless for as long as the crew is the sixteen-to-thirty-two
   * men who spawned with the machine and never leave its muster — and it is exactly wrong the
   * moment `recrew` hands the ropes to a body that is not there yet. The nearest gang the
   * search can reach on Rome is a `juthungi-warband` of **180 men at 123 m**, and under the
   * old rule all 180 of them took a fifth of the missile damage they should from the instant
   * of assignment, for the whole fifty-second walk, in the open. A roof they were nowhere
   * near. Any widening of `RECREW_RADIUS` had to be blocked on this and was.
   *
   * Two tests, because two different things are wrong and one predicate cannot say both:
   *
   *  - **Distance.** The gang's anchor has to be within the muster `musterRams` lays out, so
   *    the cover starts when the men arrive rather than when the machine is assigned.
   *  - **Share.** At least half the unit's living men have to be inside that muster. A shed
   *    is 3.8 x 8.4 m of hides and green timber over a crew; a warband of 180 does not fit
   *    under one, and it should not get to behave as though it does merely because its
   *    anchor is on the machine. This is the honest answer available to a *per-unit*
   *    multiplier: `missileTaken` is a property of the whole unit, so the choice is cover for
   *    all of them or none, and "half of them are under it" is the fairest place to put the
   *    line. A finer model would weight the multiplier by the share, and that is a change to
   *    what the shed *is* rather than a fix to where it is; it is not made here.
   *
   * Both tests are no-ops on the shipped deployment — the gate crew is 32 men laid out in
   * eight rows reaching 8.0 m back, inside `SHED_COVER_REACH`, and the share is 1.0 — which
   * is deliberate: `tools/scratch/so-ramline.mjs` prints the same timeline across this
   * change, so a movement in the ram's figures after it is a real one.
   */
  private atTheMachine(r: SiegeRam): boolean {
    const u = this.battle.unitById(r.unitId);
    if (!u || u.destroyed || u.alive === 0) return false;
    const great = r.kind === RamKind.Great;
    const reach = (great ? GREAT_RAM_HALF_D : RAM_HALF_D) + SHED_COVER_REACH;
    const r2 = reach * reach;
    const p = this.battle.pool;
    let near = 0;
    let live = 0;
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      live++;
      const dx = p.x[i] - r.x;
      const dz = p.z[i] - r.z;
      if (dx * dx + dz * dz <= r2) near++;
    }
    return live > 0 && near * 2 >= live;
  }

  private updateRams(dt: number): void {
    const b = this.battle;
    this.applyShedCover();
    for (const r of this.rams) {
      const great = r.kind === RamKind.Great;
      const period = great ? GREAT_RAM_PERIOD : RAM_PERIOD;

      // A wreck is scenery. It never swings, never blocks and is never a target again.
      if (r.state === RamState.Wreck) {
        r.swing = lerp(r.swing, 0, Math.min(1, dt * 0.6));
        continue;
      }
      // Crew broken but alive: the machine stands where it is until they rally. Nobody is
      // hauling it and nobody is on the ropes, so it neither rolls nor swings.
      if (!this.owned.has(r.unitId)) {
        r.swing = lerp(r.swing, 0, Math.min(1, dt * 1.2));
        continue;
      }

      if (r.state === RamState.Approach) {
        /**
         * Levering the shed round after the player has re-aimed it.
         *
         * Same two-phase arrangement as the tower and for the same reason: a machine that
         * changes bearing on the frame of the click is a cursor, not fifteen hundredweight
         * of oak on four wheels. The gang stop, shift the poles across the new bearing and
         * heave, and only then does it start rolling again.
         */
        if (r.wantFacing !== r.facing) {
          let df = r.wantFacing - r.facing;
          while (df > Math.PI) df -= Math.PI * 2;
          while (df < -Math.PI) df += Math.PI * 2;
          const step = RAM_SLEW * dt;
          r.facing = Math.abs(df) <= step ? r.wantFacing : r.facing + Math.sign(df) * step;
        }
        if (r.heave > 0) {
          r.heave -= dt;
          r.swing = lerp(r.swing, 0, Math.min(1, dt * 1.2));
          r.y = b.groundAt(r.x, r.z);
          continue;
        }
        const dx = r.targetX - r.x;
        const dz = r.targetZ - r.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d <= RAM_SPEED * dt) {
          r.x = r.targetX;
          r.z = r.targetZ;
          r.facing = r.wantFacing;
          r.arrived = true;
          r.state = RamState.Battering;
        } else {
          r.x += (dx / d) * RAM_SPEED * dt;
          r.z += (dz / d) * RAM_SPEED * dt;
        }
        r.y = b.groundAt(r.x, r.z);
        continue;
      }

      /**
       * Hauling clear of the hole it has just made.
       *
       * This is the answer to the ram corking its own breach, and it is worth being precise
       * about what was actually blocking. The shed is not a physical obstacle — the sim's
       * only obstacle source is the city — so the machine never stopped anybody. What
       * stopped them was the *crew*: eighty men mustered on a machine standing in a 4.3 m
       * carriageway, in a melee they could not disengage from. Backing the machine off the
       * threshold takes its muster points with it, which takes the crew out of the gateway,
       * which is what actually clears the road. `releaseBrokenCrews` covers the other case.
       */
      if (r.state === RamState.Withdrawing) {
        r.swing = lerp(r.swing, 0, Math.min(1, dt * 1.4));
        const dx = r.parkX - r.x;
        const dz = r.parkZ - r.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d <= RAM_SPEED * dt) {
          r.x = r.parkX;
          r.z = r.parkZ;
          r.state = RamState.Spent;
        } else {
          // Backing a loaded shed out is slower than rolling it up. It is also the moment
          // the crew are most exposed, which is why they hurry and still take casualties.
          r.x += (dx / d) * RAM_SPEED * 0.8 * dt;
          r.z += (dz / d) * RAM_SPEED * 0.8 * dt;
        }
        r.y = b.groundAt(r.x, r.z);
        continue;
      }

      if (r.state === RamState.Spent) {
        r.swing = lerp(r.swing, 0, Math.min(1, dt * 1.4));
        /**
         * Give the gang back.
         *
         * A machine that is parked and finished has no further claim on a cohort, and
         * keeping it would be a second version of the pin the player reported: a unit held
         * by the siege system is steered to absolute muster slots by `steerToSlots` and
         * cannot form line, charge or be given a formation. The men who hauled the ram out
         * of the gateway should be free to walk in through it.
         */
        if (this.owned.has(r.unitId)) {
          this.owned.delete(r.unitId);
          const u = b.unitById(r.unitId);
          if (u) {
            for (const i of u.members) {
              b.elevated[i] = 0;
              b.support[i] = NO_SUPPORT;
            }
            u.order = UnitOrder.MoveTo;
          }
        }
        continue;
      }

      // ---- battering ----
      // The crew haul the trunk back against the slings and let it run. The blow lands
      // when the recoil crosses zero going forward, which is what makes the strike land
      // on the frame the sound plays on.
      r.timer -= dt;
      const phase = 1 - clamp(r.timer / period, 0, 1);
      // Draw back over the first 70 % of the cycle, run forward over the last 30 %. The
      // great ram is slung further back because there is more of it.
      const draw = great ? 2.6 : 1.5;
      r.swing = phase < 0.7
        ? -draw * (phase / 0.7)
        : -draw * (1 - (phase - 0.7) / 0.3);
      if (r.timer > 0) continue;

      r.timer = period;
      r.blows++;
      const reach = (great ? GREAT_RAM_HALF_D : RAM_HALF_D) + (great ? 4.4 : 3.2);
      this.ctx.events.emit('cameraShake', { amplitude: great ? 0.9 : 0.55, decay: 2.6 });
      this.ctx.events.emit('projectileImpact', {
        x: r.x + Math.sin(r.facing) * reach,
        y: r.y + 1.6,
        z: r.z + Math.cos(r.facing) * reach,
        kind: 'bolt', hitTarget: false, material: great ? 'stone' : 'wood',
      });

      if (great) {
        this.strikeCurtain(r);
        continue;
      }

      /**
       * The blow lands on **this machine's** gate.
       *
       * It was one counter called `gateBlows` for the whole circuit, which is correct exactly
       * as long as there is one gate and nobody can re-aim the machine. Both of those stopped
       * being true in the same commit: Carthage publishes three gates and the player can now
       * pick which one the ram goes at, and a running total shared between them would carry
       * a half-broken gate's twenty blows across to a fresh one.
       */
      const gid = r.gateId || this.city?.getGates()[0]?.id || '';
      const struck = (this.gateBlowsBy.get(gid) ?? 0) + 1;
      this.gateBlowsBy.set(gid, struck);
      if (struck >= GATE_BLOWS && !this.breachedGates.includes(gid)) {
        this.breachedGates.push(gid);
        this.gateBreached = true;
        /**
         * The leaves come down and the passage opens — *now*, not at the start of the
         * battle.
         *
         * This is the line the whole gate mechanic turns on and it used to be a no-op.
         * `Siege.init` shuts the gate against the city's own occupancy raster and oriented
         * boxes, so until this fires the carriageway is solid to pathfinding, to the crowd
         * solver and to the obstacle push-out. Before, the gate stood open from t=0 and the
         * only thing 26 blows achieved was that it could no longer be closed — a mechanic
         * with nothing on the other side of it.
         *
         * The gate is read off the city rather than named. `'porta-flaminia'` is Rome's, and
         * `armGate` shuts `getGates()[0]` by *its* id while `spawnRam` aims at
         * `getGates()[0]` — so on any other city the ram landed its twenty-six blows, set
         * `gateBreached`, and then asked `CitySystem` to open a gate that does not exist.
         * The carriageway stayed solid to pathfinding, the crowd solver and the obstacle
         * push-out for the rest of the battle. Reading the id off the same gate the other
         * two paths use makes all three agree by construction.
         */
        const broken = this.city?.getGates().find((g) => g.id === gid);
        if (broken) {
          this.city?.setGateOpen(broken.id, true);
          /**
           * And the leaves are **wreckage**, not merely absent.
           *
           * `setGateOpen(id, true)` hides the intact leaves, because an open gate drawn shut
           * is wrong however it was opened — but hiding them leaves a clean empty arch where
           * twenty-six blows of an iron-shod trunk have just landed. `setGateDoorBroken` swaps
           * the intact chunk for the broken pose the wall workstream baked for exactly this.
           * Visual only: it writes no raster, no obstacle and no `GateOut`, so it cannot be a
           * source of divergence. It does nothing on a gate with no modelled leaves, which is
           * two of Carthage's three, and that is a no-op rather than a crash.
           */
          this.city?.setGateDoorBroken?.(broken.id);
        }
        this.ctx.events.emit('cameraShake', { amplitude: 1.0, decay: 0.9 });
        /**
         * Say so in the feed, by the gate's own name.
         *
         * `objectiveChanged`'s own comment is "gates breached, walls scaled, capture points
         * taken", and the HUD already renders it — so the one thing a player most needs to be
         * told about a siege needed no new channel and no new file. It matters more now than
         * it did with one gate: on Carthage the ram may be at any of three, and "a gate is
         * down" is not the same information as "the Porta Uticensis is down".
         */
        const crew = this.battle.unitById(r.unitId);
        this.ctx.events.emit('objectiveChanged', {
          id: gid, holder: crew ? crew.faction : -1, progress: 1,
        });
        // And get out of the way of the men who have been waiting behind it.
        this.beginWithdraw(r);
      }
    }
  }

  /**
   * Put a fresh gang on a derelict machine.
   *
   * The nearest formed body of the right side that is not already doing something a siege
   * engine cannot interrupt. Deterministic: `battle.units` is iterated in order and ties
   * break on the smaller unit id, so two equidistant warbands always resolve the same way.
   *
   * Deliberately *not* a unit in contact. Pulling a cohort out of a melee to push a shed is
   * not a trade any commander makes, and mechanically it would let a machine reach across
   * the field and unstick a fight.
   */
  private recrew(r: SiegeRam): boolean {
    const b = this.battle;
    const previous = b.unitById(r.unitId);
    const faction = previous ? previous.faction : -1;
    if (faction < 0) return false;
    let best = -1;
    let bestD = RECREW_RADIUS * RECREW_RADIUS;
    for (const u of b.units) {
      if (u.destroyed || u.alive === 0) continue;
      if (u.faction !== faction) continue;
      if (u.id === r.unitId) continue;
      if (this.owned.has(u.id)) continue;
      if (u.order === UnitOrder.Rout || u.contactLock) continue;
      const d = (u.x - r.x) * (u.x - r.x) + (u.z - r.z) * (u.z - r.z);
      if (d < bestD - 1e-6) { bestD = d; best = u.id; }
    }
    if (best < 0) return false;
    r.unitId = best;
    r.derelictFor = 0;
    this.owned.add(best);
    const fresh = b.unitById(best);
    if (fresh) {
      fresh.waypoints.length = 0;
      fresh.targetUnitId = -1;
    }
    return true;
  }

  /**
   * Back a ram off the passage it has opened, to a park clear of the threshold.
   *
   * Straight back down its own axis, on the side it came from, far enough that neither the
   * shed nor the crew mustered around it is inside the carriageway any more. `RAM_HALF_D`
   * puts the tail of the shed on the threshold; the muster extends about four rows further
   * back again, so the park has to clear both.
   */
  private beginWithdraw(r: SiegeRam): void {
    const great = r.kind === RamKind.Great;
    const clear = (great ? GREAT_RAM_HALF_D : RAM_HALF_D) * 2 + 9;
    r.parkX = r.x - Math.sin(r.facing) * clear;
    r.parkZ = r.z - Math.cos(r.facing) * clear;
    r.state = RamState.Withdrawing;
  }

  private updateLadders(dt: number): void {
    void dt;
    for (const l of this.ladders) {
      if (l.crossing) continue;
      const s = this.slotStation(l.station);
      // Foot, head of the ladder at the parapet, then one pace onto the walk.
      l.crossing = this.makeCrossing([
        l.x, l.footY, l.z,
        l.x, l.footY, l.z,
        this.sx[l.station] + this.snx[l.station] * (this.sOuter[l.station] + 1.1), l.headY,
        this.sz[l.station] + this.snz[l.station] * (this.sOuter[l.station] + 1.1),
        s.x, s.y, s.z,
      ], l.station);
    }
  }

  // -------------------------------------------------------------------------
  // Tick — after integration
  // -------------------------------------------------------------------------

  postIntegrate(dt: number): void {
    if (this.owned.size === 0 && this.garrisons.size === 0) return;
    this.advanceCrossings(dt);
    this.advanceLinks(dt);
    this.holdGarrisonsOnTheWalk();
  }

  /**
   * Move everybody who is on a ramp, a stair or a ladder.
   *
   * Position is authored from the arc-length parameter, not steered toward, and the
   * parameter is monotone. That is the whole safety argument: a man cannot be pushed off
   * by the crowd solver because his position is overwritten after it runs, cannot fall
   * because his height is a function of where he is on the path, and cannot teleport
   * because the parameter advances by at most `CROSS_WALK * dt` in a tick.
   */
  private advanceCrossings(dt: number): void {
    const b = this.battle;
    const p = b.pool;
    for (const t of this.towers) {
      if (t.crossing) this.stepCrossing(t.crossing, t.boarders, dt, (n) => { t.crossed += n; });
    }
    for (const l of this.ladders) {
      if (l.crossing) this.stepCrossing(l.crossing, l.boarders, dt, (n) => { l.crossed += n; });
    }
    void p;
    void b;
  }

  /**
   * Common bookkeeping for putting a man onto a path. See `crossEx` for the entry blend.
   *
   * `pace` is the one thing that stays differential once anybody may climb anything. A
   * *miles* of an escalade party has done this before and has both hands free; a legionary
   * of the line is carrying a scutum up a ladder he has never seen. Both get up it, and one
   * gets up it faster — which is a reason to keep specialists rather than a rule forbidding
   * everyone else.
   */
  private admitTo(c: Crossing, i: number, pace = 1): void {
    const b = this.battle;
    const p = b.pool;
    this.crossOf[i] = 1;
    this.crossT[i] = 0;
    this.crossPace[i] = pace;
    this.crossEx[i] = p.x[i];
    this.crossEy[i] = p.y[i];
    this.crossEz[i] = p.z[i];
    c.queue.push(i);
    b.elevated[i] = 1;
    p.setState(i, SoldierState.Climbing);
  }

  /** True when the tail of the queue has moved far enough off the mouth to admit another. */
  private mouthClear(c: Crossing): boolean {
    return c.queue.length === 0 || this.crossT[c.queue[c.queue.length - 1]] > CROSS_GAP;
  }

  /**
   * Move everyone already on a path, and hand back each man who reaches the end.
   *
   * Shared by every kind of crossing — a boarding ramp, a ladder, a stair, a tower pass and
   * a breach lane are one mechanism, and this is it. `onArrive` is the only thing that
   * differs, because a ramp deposits a man into a lodgement and a stair going down deposits
   * him on the grass.
   */
  private advanceQueue(c: Crossing, dt: number, onArrive: (i: number) => void): number {
    const b = this.battle;
    const p = b.pool;
    const total = c.arc[c.n - 1];
    let arrived = 0;
    // Back of the queue first, so nobody is blocked by a stale position.
    for (let k = c.queue.length - 1; k >= 0; k--) {
      const i = c.queue[k];
      if (!p.aliveAt(i)) {
        // A man shot off a ramp is simply gone from the queue; his corpse keeps the Y he
        // died at, which is what `elevated` is still doing for him.
        c.queue.splice(k, 1);
        this.crossOf[i] = -1;
        this.linkOf[i] = -1;
        continue;
      }
      // Nobody overtakes: the man ahead is the one before him in the queue.
      const ahead = k > 0 ? this.crossT[c.queue[k - 1]] - CROSS_GAP : Infinity;
      const seg = this.segmentAt(c, this.crossT[i]);
      // `crossPace` is 1 for the men whose machine this is and less for anyone else the
      // player has sent up it. See `admitTo`.
      const speed = (seg.steep ? CROSS_CLIMB : c.pace) * (this.crossPace[i] || 1);
      const want = Math.min(this.crossT[i] + speed * dt, ahead, total);
      this.crossT[i] = Math.max(this.crossT[i], want);

      const pos = this.sampleCrossing(c, this.crossT[i]);
      // Ease off his entry point over the first metre so stepping onto the path is a step
      // and not a jump. At `crossT` 0 this is exactly where he already was.
      const w = clamp(this.crossT[i] / ENTRY_BLEND, 0, 1);
      pos.x = lerp(this.crossEx[i], pos.x, w);
      pos.y = lerp(this.crossEy[i], pos.y, w);
      pos.z = lerp(this.crossEz[i], pos.z, w);
      p.x[i] = pos.x; p.y[i] = pos.y; p.z[i] = pos.z;
      b.support[i] = pos.y;
      b.elevated[i] = 1;
      // Velocity is set, not integrated, so the animation state machine sees a man
      // walking and picks a locomotion clip instead of an idle. `integrate` will add it to
      // the position next tick and this function will overwrite that — the path is
      // authoritative and the double-step never accumulates.
      p.vx[i] = pos.tx * speed;
      p.vz[i] = pos.tz * speed;
      if (pos.tx !== 0 || pos.tz !== 0) p.facing[i] = Math.atan2(pos.tx, pos.tz);
      if (seg.steep && p.state[i] !== SoldierState.Climbing) p.setState(i, SoldierState.Climbing);
      else if (!seg.steep && p.state[i] === SoldierState.Climbing) p.setState(i, SoldierState.Running);

      if (this.crossT[i] >= total - 1e-3) {
        c.queue.splice(k, 1);
        this.crossOf[i] = -1;
        onArrive(i);
        arrived++;
      }
    }
    return arrived;
  }

  /**
   * Drive one machine's path: admit whoever is next in the file, move everybody on it.
   *
   * `boarders` is a list rather than a unit, and that is the whole of the second half of the
   * owner's report. A ladder used to carry the single `unitId` that planted it, so a
   * legionary cohort standing at the foot of a ladder its own army had raised could not set
   * a boot on it: the admission loop only ever walked one unit's `members`. That is a
   * scenario convenience — *this* party climbs *its* ladder — dressed up as a rule, and it
   * removes the only decision worth making in an escalade, which is who goes up.
   *
   * The list is ordered and the order matters: the party that owns the machine is always
   * first, so the specialists keep the head of the queue and anyone the player has sent
   * afterwards falls in behind them.
   */
  private stepCrossing(c: Crossing, boarders: readonly number[], dt: number,
    onArrive: (n: number) => void): void {
    const b = this.battle;
    const p = b.pool;

    // ---- admit the next man ----
    // One at a time, and only once the man ahead is clear of the mouth of the path.
    if (this.mouthClear(c)) {
      admit: for (const unitId of boarders) {
        const u = b.unitById(unitId);
        // Left in the list, because a rout can rally and the machine is still theirs to use.
        if (!this.mayBoard(u)) continue;
        for (const i of u.members) {
          if (!p.aliveAt(i)) continue;
          if (this.crossOf[i] !== -1) continue;
          if (this.stationOf[i] >= 0) continue;
          // Only a man who has actually reached the foot of the path may start up it.
          const dx = p.x[i] - c.pts[0];
          const dz = p.z[i] - c.pts[2];
          if (dx * dx + dz * dz > ADMIT_RADIUS * ADMIT_RADIUS) continue;
          this.admitTo(c, i, unitId === boarders[0] ? 1 : ESCALADE_PACE);
          break admit;
        }
      }
    }

    /**
     * Which units put a man over the parapet this tick, so each is adopted into its own
     * lodgement.
     *
     * Rebuilt per call rather than kept: at most one man is admitted per tick per machine,
     * so this set holds one entry in every realistic case and allocating it is cheaper than
     * the branch that would avoid it.
     */
    const landed = new Set<number>();
    const arrived = this.advanceQueue(c, dt, (i) => {
      // Onto the wall. He joins the garrison of whatever bay the path ends at. Flagged
      // rather than placed: `adoptBoarders` decides where in the lodgement he goes, and it
      // must be able to tell him from the men already standing there.
      this.stationOf[i] = PENDING_SLOT;
      this.rankOf[i] = 0;
      p.setState(i, SoldierState.Idle);
      landed.add(p.unitId[i]);
    });
    if (arrived > 0) {
      onArrive(arrived);
      for (const id of landed) {
        const u = b.unitById(id);
        if (u && !u.destroyed) this.adoptBoarders(u, c.destStation);
      }
    }
  }

  /**
   * Once men are across, the unit becomes a garrison of the bay it took.
   *
   * Its men keep arriving one at a time, so the layout is re-run each time somebody
   * lands — which is also what spreads the ones already up there along the wall to make
   * room, instead of stacking the whole cohort on one station.
   */
  private adoptBoarders(u: UnitGroupState, destStation: number): void {
    let g = this.garrisons.get(u.id);
    if (!g) {
      g = {
        unitId: u.id, from: destStation, span: 1, ranks: MAX_WALL_RANKS,
        plannedFor: -1, sticky: true, filled: 0, overflow: 0, lastTx: u.x, lastTz: u.z,
      };
      this.garrisons.set(u.id, g);
      u.order = UnitOrder.Garrison;
    }
    // Men newly over the parapet are flagged with `PENDING_SLOT` by `stepCrossing`. They
    // fan out from the head of the ramp, alternating left and right, filling the ranks
    // behind before spreading further along the wall — a lodgement widening from a point,
    // which is what a lodgement does.
    const p = this.battle.pool;
    // The lodgement is as deep as the bay it lands on, for the same reason `queueAtLink` is.
    const abreast = this.ranksAt(destStation);
    for (const i of u.members) {
      if (!p.aliveAt(i) || this.stationOf[i] !== PENDING_SLOT) continue;
      const n = g.filled++;
      const rank = n % abreast;
      const step = Math.floor(n / abreast);
      // 0, +1, -1, +2, -2, ... outward from where they came over.
      const spread = (step % 2 === 0 ? 1 : -1) * Math.ceil(step / 2);
      const bounds = this.runBounds(destStation);
      this.stationOf[i] = clamp(destStation + spread, bounds.lo, bounds.hi);
      this.rankOf[i] = rank;
      g.from = Math.min(g.from, this.stationOf[i]);
      g.span = Math.max(g.span, this.stationOf[i] - g.from + 1);
    }
  }

  /** Which leg of the path a parameter falls on, and whether it is a climb. */
  private segmentAt(c: Crossing, t: number): { k: number; steep: boolean } {
    let k = 1;
    while (k < c.n - 1 && c.arc[k] < t) k++;
    const dy = Math.abs(c.pts[k * 3 + 1] - c.pts[(k - 1) * 3 + 1]);
    const len = c.arc[k] - c.arc[k - 1];
    return { k, steep: len > 1e-4 && dy / len > 0.6 };
  }

  private sampleCrossing(c: Crossing, t: number): { x: number; y: number; z: number; tx: number; tz: number } {
    let k = 1;
    while (k < c.n - 1 && c.arc[k] < t) k++;
    const seg = Math.max(1e-4, c.arc[k] - c.arc[k - 1]);
    const f = clamp((t - c.arc[k - 1]) / seg, 0, 1);
    const a = (k - 1) * 3;
    const bI = k * 3;
    const x = lerp(c.pts[a], c.pts[bI], f);
    const y = lerp(c.pts[a + 1], c.pts[bI + 1], f);
    const z = lerp(c.pts[a + 2], c.pts[bI + 2], f);
    let tx = c.pts[bI] - c.pts[a];
    let tz = c.pts[bI + 2] - c.pts[a + 2];
    const l = Math.sqrt(tx * tx + tz * tz);
    if (l > 1e-4) { tx /= l; tz /= l; } else { tx = 0; tz = 0; }
    return { x, y, z, tx, tz };
  }

  /**
   * Put every garrisoned man back on the stonework.
   *
   * `resolveCrowding` and `integrate` have just run and neither knows the walkway is
   * 3.45 m wide. Left alone, the shove from a man arriving off a ramp walks the rank in
   * front of him off the parapet at about 4 cm a tick — slow enough to look like nothing
   * for ten seconds and then drop a cohort into the ditch. Clamping the *lateral* offset
   * and leaving the along-wall position alone keeps the shoving that makes a line look
   * alive and removes only the component that can kill.
   */
  private holdGarrisonsOnTheWalk(): void {
    const b = this.battle;
    const p = b.pool;
    for (const [id, g] of this.garrisons) {
      void g;
      const u = b.unitById(id);
      if (!u || u.destroyed) continue;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        const slot = this.stationOf[i];
        if (slot < 0) continue;
        // Measured against the bay he is standing over, not the one he is walking toward.
        const st = this.standingStation(i, slot);
        const nx = this.snx[st];
        const nz = this.snz[st];
        // Signed distance from this station's centreline, along the outward normal.
        const dx = p.x[i] - this.sx[st];
        const dz = p.z[i] - this.sz[st];
        const off = dx * nx + dz * nz;
        const lo = this.sInner[st];
        const hi = this.sOuter[st];
        if (off < lo || off > hi) {
          const want = clamp(off, lo, hi);
          const corr = want - off;
          p.x[i] += nx * corr;
          p.z[i] += nz * corr;
        }
        p.y[i] = this.sy[st];
        b.support[i] = this.sy[st];
      }
    }
  }

  // -------------------------------------------------------------------------
  // Boarding party ground behaviour
  // -------------------------------------------------------------------------

  /**
   * Where a man of an owned unit who is not yet on a structure should stand.
   *
   * Called from `preSteer` for every owned unit so that `BattleSystem.steerToSlots` has
   * somewhere to send the men who are still on the grass: crews muster behind their
   * machine and walk with it, and a boarding party queues up at the foot of the path.
   */
  private musterOwned(): void {
    const b = this.battle;
    const p = b.pool;
    /**
     * A broken party's men on the grass are given flight, not a muster place.
     *
     * First, and for every owned unit rather than only the ones on a machine, because a
     * party that has broken while half of it is on the parapet stays owned — see
     * `routOffTheWall` — and the loops below skip it (`mayBoard` is false for a routing
     * unit), which is exactly the state that leaves a man walking at a slot frozen at the
     * tick before he broke.
     */
    for (const id of this.owned) {
      const u = b.unitById(id);
      if (!u || u.destroyed || u.order !== UnitOrder.Rout) continue;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        // Men on the stone or on a path keep their siege slot; only the grass runs.
        if (this.crossOf[i] !== -1 || this.stationOf[i] !== -1) continue;
        this.fleeSlot(i, u);
      }
    }
    for (const t of this.towers) {
      const cos = Math.cos(t.facing);
      const sin = Math.sin(t.facing);
      /**
       * One running index for the whole machine, not one per unit.
       *
       * This is the queue trap that broke wall descent, restated: a man's place in a file is
       * a fact about the *file*, and counting it per unit gives two men the same slot and
       * neither of them the mouth. The crew are first in `boarders`, so the gang on the
       * levers keeps the front of the column and anybody the player has sent falls in behind.
       *
       * Split in two for the same reason the ladder bank below is: the *file* a man stands in
       * is his own and must not move when somebody else boards, while the *row* he stands in
       * is a live count and should close up when the man in front of him goes up the ramp.
       * A tower column is only 0.9 m between files against a ladder bank's 6.88 m, so this
       * never earned a bug report of its own — but it is the same rotation and it is two
       * lines away from the one that did.
       */
      let seat = 0;
      const rows = this.fileRows;
      rows.fill(0, 0, 4);
      for (const uid of t.boarders) {
        const u = b.unitById(uid);
        if (!this.mayBoard(u)) continue;
        for (const i of u.members) {
          // A column behind the tower, four abreast, which is also the gang pushing it.
          const file = seat++ % 4;
          if (!p.aliveAt(i)) continue;
          if (this.stationOf[i] >= 0 || this.crossOf[i] !== -1) continue;
          const row = rows[file]++;
          const rx = (file - 1.5) * 0.9;
          /**
           * Local −Z, which is the side *away* from the wall.
           *
           * The tower's local +Z points along its facing, which is at the wall, so local −Z is
           * where the pushing gang stands and where the crossing path must begin. Flipping this
           * to +Z on the assumption that +Z was the rear put the muster point in the 0.32 m gap
           * between the machine and the masonry: nobody came within admission range of the path
           * and not one man boarded. The probe caught it immediately as `0 men across a boarding
           * ramp`, which is exactly the kind of silent break it exists for.
           */
          const fz = -(TOWER_HALF_D + 1.6 + row * 0.95);
          b.elevated[i] = 0;
          b.support[i] = NO_SUPPORT;
          b.slotX[i] = t.x + rx * cos + fz * sin;
          b.slotZ[i] = t.z - rx * sin + fz * cos;
          b.slotFacing[i] = t.facing;
        }
      }
    }
    // Escalade parties queue at the foot of their own ladders, spread across them.
    //
    // The grouping map is built only when there are ladders: allocating an empty `Map`
    // every tick of every battle to serve a feature that is not in use is exactly the kind
    // of per-tick garbage that shows up as a jitter and never as a hot function.
    //
    // Without this they were `owned` — so `BattleSystem.steerToSlots` placed them — but
    // had no slot written, which is a `Float32Array` of zeroes: four hundred men walked
    // steadily toward the world origin, a kilometre from the wall, and no assertion in the
    // probe was looking at them. Anything the siege system claims to own it must place.
    if (this.ladders.length === 0) return this.musterRams();
    const byUnit = new Map<number, Ladder[]>();
    for (const l of this.ladders) {
      const arr = byUnit.get(l.unitId);
      if (arr) arr.push(l);
      else byUnit.set(l.unitId, [l]);
    }
    for (const group of byUnit.values()) {
      // Every ladder a party raised is one bank, and `escalade` enrols a unit on the bank
      // rather than on one rail of it, so the whole group shares a boarder list.
      /**
       * **The reported shuffle, and it is the queue-index trap wearing its third costume.**
       *
       * Round-robin across the party's ladders is right; deriving it from a tally of the men
       * who *happen to be waiting this tick* is not. `q` counted only men who were alive, on
       * the ground and not already on a crossing, so the instant anybody was admitted to a
       * rung — or shot — every man behind him in the bank decremented by one and therefore
       * changed **which ladder he was queuing for**. The rails of a bank are planted 7 m
       * apart (`scenario.ts` spreads three across the bay's frontage), so that is not a
       * nudge: it is the whole file picking itself up and walking to the next ladder,
       * repeatedly, in lockstep, for as long as the escalade lasts.
       *
       * Measured at the storm of Rome, 40 men of one party over 5 s: **147 slot
       * reassignments, every one of them larger than 3 m, median 6.88 m — exactly the rail
       * pitch — and 13.77 m at the worst.** 0.74 rail changes per man per second. The men
       * walked a median of 5.98 m to make 1.15 m of headway, so five sixths of all the
       * walking done at the foot of a ladder was this. Carthage measured worse, at 1.07.
       * The rail traces are unmistakable once you print them: `111…000…222`, every man of
       * the party rotating one rail to the left together each time a rung came free.
       *
       * The fix is to make the rail a fact about *the man* rather than about the length of a
       * list. `seat` counts every member of every unit in the file — dead, climbing, already
       * over the parapet, it does not matter — so it cannot move under him: `u.members` is
       * append-only (`BattleSystem` pushes at spawn and never splices) and `boarders` only
       * changes when a whole unit joins or leaves the bank, which is a real event and should
       * move the file. His *row* is still a live count, per rail, which is the part that
       * ought to change: when the man ahead of him steps onto the rungs he closes up 0.9 m
       * toward the foot, and nobody on the other two rails moves at all.
       */
      let seat = 0;
      const rows = this.fileRows;
      rows.fill(0, 0, group.length);
      for (const uid of group[0].boarders) {
        const u = b.unitById(uid);
        if (!this.mayBoard(u)) continue;
        for (const i of u.members) {
          // Before the liveness tests, or it is a tally of the waiting again.
          const rail = seat++ % group.length;
          if (!p.aliveAt(i)) continue;
          if (this.stationOf[i] >= 0 || this.crossOf[i] !== -1) continue;
          // The admission test in `stepCrossing` only takes a man within `ADMIT_RADIUS` of
          // the foot, so the file feeds itself: the head of it is admitted and his own rail
          // shuffles up one row behind him.
          const l = group[rail];
          const row = rows[rail]++;
          const back = 1.1 + row * 0.9;
          b.elevated[i] = 0;
          b.support[i] = NO_SUPPORT;
          b.slotX[i] = l.x + Math.sin(l.facing + Math.PI) * back;
          b.slotZ[i] = l.z + Math.cos(l.facing + Math.PI) * back;
          b.slotFacing[i] = l.facing;
        }
      }
    }

    this.musterRams();
  }

  /** Half the crew are under the shed with both hands on the trunk, the rest pushing. */
  private musterRams(): void {
    const b = this.battle;
    const p = b.pool;
    for (const r of this.rams) {
      // A wreck has no crew to muster, and a crew that has broken is no longer mustered on
      // anything — it is running. Holding either of them here is the pin that stopped a
      // routed crew leaving the carriageway. See `releaseBrokenCrews`.
      if (r.wreck) continue;
      const u = b.unitById(r.unitId);
      if (!u || u.destroyed || u.order === UnitOrder.Rout) continue;
      const halfD = r.kind === RamKind.Great ? GREAT_RAM_HALF_D : RAM_HALF_D;
      const abreast = r.kind === RamKind.Great ? 6 : 4;
      const cos = Math.cos(r.facing);
      const sin = Math.sin(r.facing);
      let q = 0;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        const file = q % abreast;
        const row = Math.floor(q / abreast);
        q++;
        const rx = (file - (abreast - 1) * 0.5) * 0.85;
        const fz = row < 4 ? 1.6 - row * 1.1 : -(halfD + (row - 3) * 0.95);
        b.elevated[i] = 0;
        b.support[i] = NO_SUPPORT;
        b.slotX[i] = r.x + rx * cos + fz * sin;
        b.slotZ[i] = r.z - rx * sin + fz * cos;
        b.slotFacing[i] = r.facing;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  preRender(): void {
    this.writeTowers();
    this.writeRams();
    this.writeLadders();
  }

  private setInstance(
    mesh: THREE.InstancedMesh | undefined, n: number,
    x: number, y: number, z: number, yaw: number,
    sx = 1, sy = 1, sz = 1, pitch = 0
  ): void {
    if (!mesh) return;
    TMP_E.set(pitch, yaw, 0, 'YXZ');
    TMP_Q.setFromEuler(TMP_E);
    TMP_P.set(x, y, z);
    TMP_S.set(sx, sy, sz);
    TMP_M.compose(TMP_P, TMP_Q, TMP_S);
    mesh.setMatrixAt(n, TMP_M);
  }

  /**
   * A stable per-instance tint, so two machines built by different gangs out of different
   * timber are not the same object twice.
   *
   * `InstancedMesh.setColorAt` multiplies the vertex colour, and a blind critic called the
   * first pass *"untextured grey and tan planes"* — most of that is the absence of a texture,
   * which is not fixable here, but four identical silhouettes in identical colour made it
   * far worse than it needed to be.
   */
  private tint(mesh: THREE.InstancedMesh | undefined, n: number, id: number): void {
    if (!mesh) return;
    const v = hash01(id, 0x7016);
    TMP_C.setRGB(0.86 + v * 0.30, 0.88 + v * 0.24, 0.82 + v * 0.22);
    mesh.setColorAt(n, TMP_C);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private writeTowers(): void {
    let n = 0;
    for (const t of this.towers) {
      /**
       * The whole machine takes the half turn, not just the ramp.
       *
       * Fixing `mRamp` alone was a half fix and it left the more visible half of the player's
       * report in place. Every one of these geometries is authored with **local −Z as the
       * front** — `buildTowerShaft`'s comment says so outright, "−Z is the front, the face
       * that goes against the wall" — and under `Ry(yaw)` local −Z lands on
       * `(−sin yaw, −cos yaw)`, the opposite of the bearing `yaw` names. Drawn at
       * `yaw = t.facing` the tower therefore presented its *back* to the wall:
       *
       *   - the hide screen, which exists to stop what the defenders throw, faced the open
       *     field, and the open lattice faced the parapet;
       *   - `buildTowerDeck`'s front cheeks and its iron hinge pintles sat on the far side,
       *     so the ramp — correctly hinged on the wall side in world space — came out
       *     *through the solid rear breastwork* while the opening pointed at nothing.
       *
       * That last one is "the door opens backwards", and no assertion could see it: the probe
       * reads back `mRamp` and `mLadder` and has never read a matrix from the shaft, the deck,
       * the wheels or either shed.
       */
      const h = Math.max(2, t.deckY - t.y);
      const yaw = t.facing + Math.PI;
      this.setInstance(this.mShaft, n, t.x, t.y, t.z, yaw, 1, h, 1);
      this.setInstance(this.mDeck, n, t.x, t.deckY, t.z, yaw);
      this.setInstance(this.mWheels, n, t.x, t.y, t.z, yaw);
      /**
       * The ramp hinges at the deck's front lip, and it is yawed by `facing + PI`.
       *
       * **That half turn is the reported bug, and it is the ladder bug over again.**
       * `buildTowerRamp` authors the *pons* running out along local **−Z** — the same
       * "business end along −Z" convention as `buildRamTrunk` and `buildLadder` — and
       * `setInstance` composes `Ry(yaw)·Rx(pitch)`, under which local −Z lands on world
       * `(−sin yaw, −cos yaw)`. `t.facing` is `atan2(−nx, −nz)`, which points *at* the wall.
       * Drawn at `yaw = t.facing`, therefore, the ramp reached out along `(nx, nz)` — away
       * from the wall, backwards over the tower's own roof.
       *
       * Measured off this `InstancedMesh`'s matrix before the fix, all four ramps had their
       * head **3.36 m further from the wall than their own hinge**: a signed reach of −3.36
       * where it must be positive. The player saw it as "the draw bridge is a bit backwards
       * on their top — the ropes are pointed forward and the door opens backwards", which is
       * exactly what a half-turned ramp looks like: the hoisting ropes, authored from the
       * far end back over the hinge, end up on the wall side pointing forward while the deck
       * swings out over the back.
       *
       * And the reason twenty-five assertions sat green on top of it is the same reason
       * twenty-four sat green on the ladders. `rampHeadY` computed the head **analytically**,
       * as `deckY + sin(pitch)·RAMP_LEN`, from the same inputs as the bug — so it reported
       * the head 0.0 cm from the walkway while the renderer put it in mid-air behind the
       * machine. `drawnRampHead` now reads the matrix instead, and the assertion on it is
       * signed. A check that shares its inputs with the thing it is checking is not a check.
       *
       * The Z scale is the second half of the fix. `RAMP_LEN` is 3.4 m and the span actually
       * wanted here is `hypot(reach, drop)` — measured at 1.7 m on this curtain, because the
       * tower docks 0.32 m off the face and the standing band starts 1.3 m inboard of it. A
       * correctly-yawed 3.4 m ramp lands 1.6 m past the walkway's cityward lip, cantilevered
       * over the street. Scaling to the span is also what keeps this right when the wall
       * workstream widens the curtain, since nothing here is a constant.
       */
      const sin = Math.sin(t.facing);
      const cos = Math.cos(t.facing);
      const hx = t.x + TOWER_HALF_D * sin;
      const hz = t.z + TOWER_HALF_D * cos;
      const span = this.rampSpan(t);
      this.setInstance(this.mRamp, n, hx, t.deckY, hz, t.facing + Math.PI,
        1, 1, span.len / RAMP_LEN, span.pitch);
      this.tint(this.mShaft, n, t.id);
      this.tint(this.mDeck, n, t.id);
      this.tint(this.mRamp, n, t.id + 41);
      this.tint(this.mWheels, n, t.id + 17);
      n++;
    }
    for (const m of [this.mShaft, this.mDeck, this.mWheels, this.mRamp]) {
      if (!m) continue;
      m.count = n;
      m.visible = n > 0;
      if (n > 0) m.instanceMatrix.needsUpdate = true;
    }
  }

  private writeRams(): void {
    let n = 0;
    let gn = 0;
    for (const r of this.rams) {
      const great = r.kind === RamKind.Great;
      const halfD = great ? GREAT_RAM_HALF_D : RAM_HALF_D;
      const shedH = great ? GREAT_RAM_SHED_H : RAM_SHED_H;
      const reach = great ? GREAT_RAM_REACH : RAM_TRUNK_REACH;
      const cos = Math.cos(r.facing);
      const sin = Math.sin(r.facing);
      /**
       * A wreck settles.
       *
       * Scaled to 40 % of its height and dropped a little into the ground, so what is left is
       * a low heap of burnt frame rather than a full-height shed standing in the gateway with
       * nobody in it. It is the honest middle answer to the machine that corked its own
       * breach: the thing that happened is still visible, and it is no longer a wall.
       */
      const sy = r.wreck ? 0.4 : 1;
      const yy = r.wreck ? r.y - 0.25 : r.y;
      /**
       * Where the trunk hangs.
       *
       * The trunk is authored from its origin along **-Z** with the iron head `reach` metres
       * out, and `facing + PI` turns that to point forward, so the origin has to sit that far
       * *behind* where the head should be. An early version placed the origin 5.4 m ahead of
       * the shed instead, which put the head 12.5 m in front of it — through the gate, out
       * the other side and invisible in every frame of the machine.
       *
       * The head is wanted a metre proud of the shed's front, plus the recoil.
       */
      const headAt = halfD + 1.0 + r.swing;
      const originAt = headAt - reach;
      const trunkY = yy + shedH * sy - (great ? 1.9 : 1.35) * sy;

      // Same half turn, same reason: the trunk already gets it, and the shed it hangs in is
      // authored front-along-−Z like everything else here. The plain shed is symmetric in Z
      // so this is invisible on it; the great ram's hide apron hangs down its front face and
      // was facing away from the wall it is battering.
      const shedYaw = r.facing + Math.PI;
      if (great) {
        this.setInstance(this.mGreatShed, gn, r.x, yy, r.z, shedYaw, 1, sy, 1);
        this.setInstance(this.mGreatTrunk, gn,
          r.x + originAt * sin, trunkY, r.z + originAt * cos, r.facing + Math.PI);
        this.tint(this.mGreatShed, gn, r.id + 91);
        this.tint(this.mGreatTrunk, gn, r.id + 23);
        gn++;
      } else {
        this.setInstance(this.mShed, n, r.x, yy, r.z, shedYaw, 1, sy, 1);
        this.setInstance(this.mTrunk, n,
          r.x + originAt * sin, trunkY, r.z + originAt * cos, r.facing + Math.PI);
        n++;
      }
    }
    for (const m of [this.mShed, this.mTrunk]) {
      if (!m) continue;
      m.count = n;
      m.visible = n > 0;
      if (n > 0) m.instanceMatrix.needsUpdate = true;
    }
    for (const m of [this.mGreatShed, this.mGreatTrunk]) {
      if (!m) continue;
      m.count = gn;
      m.visible = gn > 0;
      if (gn > 0) m.instanceMatrix.needsUpdate = true;
    }
  }

  private writeLadders(): void {
    let n = 0;
    for (const l of this.ladders) {
      /**
       * Yawed by `facing + PI`, and that half turn is the whole ladder.
       *
       * `buildLadder` authors the rails up +Y with the iron hooks running from the head
       * toward local **−Z**, the same "business end along −Z" convention as `buildTowerRamp`
       * and `buildRamTrunk`. `setInstance` composes `Ry(yaw)·Rx(pitch)`, under which local −Z
       * lands on world `(−sin yaw, −cos yaw)` — the *opposite* of the bearing `yaw` names. And
       * `l.facing` is `atan2(−nx, −nz)`, which points from the ladder **at** the wall, because
       * the escalade party musters behind the foot looking at the masonry.
       *
       * Drawn at `yaw = l.facing`, therefore, the negative pitch tipped the head and its hooks
       * the wrong way down the normal: measured off the instance matrix, all twelve heads stood
       * 4 to 9 m *out* from the wall, at exactly the right height and against nothing, the
       * ladders raking backwards into the open field. The men still climbed correctly, because
       * `updateLadders` builds their path from the station rather than from this transform, so
       * the only thing wrong was the object they appeared to be climbing — which is precisely
       * how it was reported. `writeRams` applies the same half turn to the trunk for the same
       * authoring reason; see `engineReport` for the assertion that now measures this.
       *
       * Scaled by the *slant* length, so the head arrives at the right height once the lean
       * has been applied, not the vertical rise.
       */
      const rise = Math.max(1, l.headY - l.footY);
      this.setInstance(this.mLadder, n, l.x, l.footY, l.z, l.facing + Math.PI,
        1, rise / Math.cos(l.lean), 1, -l.lean);
      this.tint(this.mLadder, n, n * 7 + 3);
      n++;
    }
    if (this.mLadder) {
      this.mLadder.count = n;
      this.mLadder.visible = n > 0;
      if (n > 0) this.mLadder.instanceMatrix.needsUpdate = true;
    }
  }

  // -------------------------------------------------------------------------
  // Diagnostics — read by tools/probe-siege.mjs
  // -------------------------------------------------------------------------

  /** Everything the probe needs to know about where one man is actually standing. */
  probeMan(i: number): {
    surfaceY: number; terrainY: number; lateralOffset: number;
    insideMasonry: boolean; bay: number; station: number;
  } {
    const b = this.battle;
    const st = this.stationOf[i];
    const terrainY = b.groundAt(b.pool.x[i], b.pool.z[i]);
    if (st < 0) {
      return { surfaceY: b.support[i], terrainY, lateralOffset: 0, insideMasonry: false, bay: -1, station: -1 };
    }
    const dx = b.pool.x[i] - this.sx[st];
    const dz = b.pool.z[i] - this.sz[st];
    const off = dx * this.snx[st] + dz * this.snz[st];
    return {
      surfaceY: this.sy[st],
      terrainY,
      lateralOffset: off,
      // Inside the stonework means below the walking surface by more than a tolerance.
      insideMasonry: b.pool.y[i] < this.sy[st] - 0.05,
      bay: this.sBay[st],
      station: st,
    };
  }

  towerReport(): {
    id: number; state: string; dist: number; docked: boolean;
    rampDrawn: boolean; rampY: number; rampHeadOff: number; rampHingeOff: number;
    rampReach: number; wantHeadOff: number; innerOff: number;
    walkY: number; crossed: number; queued: number;
    x: number; z: number; baseY: number; groundY: number; deckY: number;
    /** Horizontal gap between the tower's front face and the wall's outer face. */
    faceGap: number;
  }[] {
    const names = ['approach', 'docking', 'landing', 'boarding', 'spent'];
    return this.towers.map((t) => {
      const s = t.station;
      // Distance from the tower's front face to the bay centreline, less the half-thickness:
      // how far the ramp has to bridge, and negative if the machine is inside the masonry.
      const dx = t.x - this.sx[s];
      const dz = t.z - this.sz[s];
      const outward = dx * this.snx[s] + dz * this.snz[s];
      /**
       * The ramp, measured off the matrix the renderer wrote. See `drawnRampHead`.
       *
       * `reach` is the signed one and it is the assertion that matters: the head must end up
       * *closer* to the wall than its own hinge. Every other number here is a magnitude, and
       * a ramp yawed 180 degrees satisfies all of them — right height, plausible pitch, men
       * still crossing, because the boarding path is built from the station and not from the
       * mesh. That is the exact state this suite passed 25/25 in.
       */
      const drawn = this.drawnRampHead(t.id, TMP_R);
      const headOff = drawn
        ? (TMP_R.x - this.sx[s]) * this.snx[s] + (TMP_R.z - this.sz[s]) * this.snz[s]
        : NaN;
      const hingeOff = (t.x + Math.sin(t.facing) * TOWER_HALF_D - this.sx[s]) * this.snx[s]
        + (t.z + Math.cos(t.facing) * TOWER_HALF_D - this.sz[s]) * this.snz[s];
      return {
        id: t.id,
        state: names[t.state],
        dist: t.dist,
        docked: t.state >= TowerState.Landing,
        rampDrawn: drawn,
        rampY: drawn ? TMP_R.y : NaN,
        rampHeadOff: headOff,
        rampHingeOff: hingeOff,
        /** Positive when the lip reaches toward the wall; negative is the reported bug. */
        rampReach: hingeOff - headOff,
        /** Where the lip must land: the outward limit of the standing band. */
        wantHeadOff: this.sOuter[s],
        innerOff: this.sInner[s],
        walkY: this.sy[s],
        crossed: t.crossed,
        queued: t.crossing ? t.crossing.queue.length : 0,
        x: t.x,
        z: t.z,
        baseY: t.y,
        groundY: this.battle.groundAt(t.x, t.z),
        deckY: t.deckY,
        faceGap: outward - TOWER_HALF_D - this.sFace[s],
      };
    });
  }

  /**
   * Where ladder `n`'s head has actually been *drawn*, read back out of the instance matrix
   * the renderer wrote rather than recomputed from the numbers that produced it.
   *
   * The distinction is the entire lesson of this diagnostic. The first version of
   * `ladderHeadMiss` derived the head analytically as `foot − run` along the wall normal —
   * which is where a correctly pitched ladder puts it — and duly reported all twelve heads
   * within 4 cm of the masonry while `writeLadders` was raking every one of them the other
   * way, heads 4 to 9 m out in the open air. A twenty-four-assertion suite sat green on top of
   * a ladder a player could see was wrong, because the check and the bug were computing the
   * same wrong thing from the same inputs. Transforming the local head through the matrix that
   * reaches the GPU is the only version of this that cannot agree with the renderer's mistake.
   *
   * Returns false before the first frame, when there is no matrix to read; the probe treats a
   * head it could not measure as a failure rather than as a pass.
   */
  private drawnLadderHead(n: number, out: THREE.Vector3): boolean {
    if (!this.mLadder || n >= this.mLadder.count) return false;
    this.mLadder.getMatrixAt(n, TMP_M);
    // (0, 1, 0) is the top of the rails in `buildLadder`, before the per-instance stretch.
    out.set(0, 1, 0).applyMatrix4(TMP_M);
    return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z);
  }

  engineReport(): {
    shots: number; hits: number; kills: number; ramBlows: number; gateHp: number;
    ladders: number; laddersCrossed: number;
    /** Per ladder: how far its head misses the wall face and the parapet, in metres. */
    ladderHeadMiss: {
      face: number; crest: number; leanDeg: number;
      /** Foot and drawn head, as signed offsets along the bay's outward normal. */
      footOff: number; headOff: number;
      /** How far inboard of the foot the lean says the head must be: `rise · tan(lean)`. */
      rake: number;
      /** False when there was no instance matrix to measure, which is not a pass. */
      drawn: boolean;
    }[];
  } {
    return {
      shots: this.artilleryShots,
      hits: this.ensureProjectiles()?.masonryHits ?? 0,
      kills: this.artilleryKills,
      ramBlows: this.rams.reduce((a, r) => a + r.blows, 0),
      gateHp: Math.max(0, 1 - this.gateBlows / GATE_BLOWS),
      ladders: this.ladders.length,
      laddersCrossed: this.ladders.reduce((a, l) => a + l.crossed, 0),
      ladderHeadMiss: this.ladders.map((l, n) => {
        const st = l.station;
        const rise = Math.max(1, l.headY - l.footY);
        const dx = l.x - this.sx[st];
        const dz = l.z - this.sz[st];
        const footOff = dx * this.snx[st] + dz * this.snz[st];
        const drawn = this.drawnLadderHead(n, TMP_R);
        const headOff = drawn
          ? (TMP_R.x - this.sx[st]) * this.snx[st] + (TMP_R.z - this.sz[st]) * this.snz[st]
          : NaN;
        return {
          // Positive means the head stops short of the wall face; negative means it is
          // biting over the merlon. Measured from the drawn head, so a ladder pointing the
          // wrong way reports the 9 m miss it really has instead of a tidy 25 cm.
          face: headOff - this.sFace[st],
          crest: (drawn ? TMP_R.y : NaN) - (this.sy[st] + 0.9),
          leanDeg: (l.lean * 180) / Math.PI,
          footOff,
          headOff,
          rake: rise * Math.tan(l.lean),
          drawn,
        };
      }),
    };
  }

  /**
   * The wall as a graph: where you can stand, and how you get between the places.
   *
   * `source` is the one number a reader should look at first. `published` means the city
   * told us where its flights are; `synthesised` means it did not and this file assumed the
   * cadence the geometry currently uses, which is a standing invitation for men to walk up
   * stone that is not there. See `STAIR_MOD`.
   */
  wallReport(): {
    source: 'published' | 'synthesised' | 'none';
    stairs: number; runs: number; stations: number; deadStations: number;
    links: { towerPass: number; step: number; stair: number; breach: number };
    /** Runs reachable from the ground without leaving the wall, over total runs. */
    reachable: number;
    /**
     * Consecutive run pairs the walk does **not** join, and why.
     *
     * `unbridged` counts every `r -> r + 1` with no link, whatever the reason — a missing
     * bay, a breach, or a joint `stepAcross` refused. `refusedSteps` is the last of those on
     * its own, and it is the number `buildLinks` used to report as zero by bridging them:
     * five on Rome and four on Carthage at `596e03b`. `worstStep`/`worstPitch` are the
     * tallest and the steepest joint that *was* bridged, which is what an acceptance test
     * asserts on.
     */
    unbridged: number;
    refusedSteps: number;
    worstStep: number;
    worstPitch: number;
    stairDetail: {
      station: number; run: number; footY: number; topY: number;
      terrainAtFoot: number; walkYAtHead: number; side: number; rise: number;
    }[];
    linkUse: {
      id: number; kind: string; runA: number; runB: number; used: number; gap: number;
      /** Signed height a to b, and the rake it implies. See `stepAcross`. */
      rise: number; pitch: number;
    }[];
  } {
    const kinds = ['towerPass', 'step', 'stair', 'breach'] as const;
    const counts = { towerPass: 0, step: 0, stair: 0, breach: 0 };
    for (const l of this.links) counts[kinds[l.kind]]++;

    // Flood the run chain outward from every run a stair lands on: this is literally the
    // question "can a man ordered onto this stretch of wall actually get there".
    const seen = new Uint8Array(Math.max(1, this.nRuns));
    const stack: number[] = [];
    for (const l of this.links) if (l.kind === LinkKind.Stair && l.runB >= 0) stack.push(l.runB);
    while (stack.length > 0) {
      const r = stack.pop() as number;
      if (r < 0 || r >= this.nRuns || seen[r]) continue;
      seen[r] = 1;
      if (this.runNext[r] >= 0) stack.push(r + 1);
      if (r > 0 && this.runNext[r - 1] >= 0) stack.push(r - 1);
    }
    let reachable = 0;
    for (let r = 0; r < this.nRuns; r++) if (seen[r]) reachable++;

    let deadStations = 0;
    for (let s = 0; s < this.nStations; s++) if (this.sDead[s]) deadStations++;

    // The joints the walk does not cross, split into "nothing was ever built here" and
    // "`stepAcross` looked at it and said no". Recomputed from the spine rather than
    // remembered by `buildLinks`, so a disagreement between the two shows up as a wrong
    // number in the report instead of being hidden behind a shared variable.
    let unbridged = 0;
    let refusedSteps = 0;
    let worstStep = 0;
    let worstPitch = 0;
    for (let r = 0; r + 1 < this.nRuns; r++) {
      if (this.runNext[r] >= 0) continue;
      unbridged++;
      const a = this.runHi[r];
      const b = this.runLo[r + 1];
      if (a < 0 || b < 0 || this.dead(a) || this.dead(b)) continue;
      const gap = Math.sqrt((this.sx[b] - this.sx[a]) * (this.sx[b] - this.sx[a]) + (this.sz[b] - this.sz[a]) * (this.sz[b] - this.sz[a]));
      if (gap > LINK_MAX_GAP) continue;
      if (this.stepAcross(this.sy[b] - this.sy[a], gap) === Joint.Broken) refusedSteps++;
    }
    for (const l of this.links) {
      if (l.kind !== LinkKind.TowerPass && l.kind !== LinkKind.Step) continue;
      const gap = Math.sqrt((l.bx - l.ax) * (l.bx - l.ax) + (l.bz - l.az) * (l.bz - l.az));
      const dy = Math.abs(l.rise);
      if (dy > worstStep) worstStep = dy;
      const pitch = gap > 1e-6 ? dy / gap : Infinity;
      if (pitch > worstPitch) worstPitch = pitch;
    }

    return {
      source: this.stairs.length === 0 ? 'none' : (this.stairsFromCity ? 'published' : 'synthesised'),
      stairs: this.stairs.length,
      runs: this.nRuns,
      stations: this.nStations,
      deadStations,
      links: counts,
      reachable,
      unbridged,
      refusedSteps,
      worstStep,
      worstPitch,
      stairDetail: this.stairs.map((s) => ({
        station: s.station,
        run: this.sRun[s.station],
        footY: s.footY,
        topY: s.topY,
        terrainAtFoot: this.battle.groundAt(s.footX, s.footZ),
        walkYAtHead: this.sy[s.station],
        side: s.side,
        rise: s.topY - s.footY,
      })),
      linkUse: this.links.map((l) => {
        const gap = Math.sqrt((l.bx - l.ax) * (l.bx - l.ax) + (l.bz - l.az) * (l.bz - l.az));
        return {
          id: l.id, kind: kinds[l.kind], runA: l.runA, runB: l.runB, used: l.used, gap,
          rise: l.rise, pitch: gap > 1e-6 ? Math.abs(l.rise) / gap : Infinity,
        };
      }),
    };
  }

  /** A world point in the middle of a run, for ordering a unit to that stretch of wall. */
  stationWorld(run: number): { x: number; z: number; y: number; station: number } {
    if (run < 0 || run >= this.nRuns) return { x: NaN, z: NaN, y: NaN, station: -1 };
    const s = (this.runLo[run] + this.runHi[run]) >> 1;
    return { x: this.sx[s], z: this.sz[s], y: this.sy[s], station: s };
  }

  /**
   * How many stations have men of both units standing on them.
   *
   * The measurable form of "the run you wanted is occupied". Two friendly units sharing a
   * stretch of walkway must divide it, not stand inside one another — so this is zero when
   * the allocation is working and rises the moment `freeWindow` stops being honoured.
   */
  stationOverlap(a: number, b: number): number {
    const p = this.battle.pool;
    const ua = this.battle.unitById(a);
    const ub = this.battle.unitById(b);
    if (!ua || !ub) return -1;
    const held = new Set<number>();
    for (const i of ua.members) {
      if (p.aliveAt(i) && this.stationOf[i] >= 0) held.add(this.stationOf[i]);
    }
    let n = 0;
    const counted = new Set<number>();
    for (const i of ub.members) {
      if (!p.aliveAt(i)) continue;
      const s = this.stationOf[i];
      if (s >= 0 && held.has(s) && !counted.has(s)) { counted.add(s); n++; }
    }
    return n;
  }

  /** Where every man of a unit is with respect to the wall. Drives the traversal assertions. */
  unitWallState(unitId: number): {
    onWall: number; onGround: number; onLink: number;
    runs: number[]; goal: string; destRun: number; planAge: number; stuck: number;
    /** How many men stand on each run the unit occupies, keyed by run. */
    runCounts: Record<number, number>;
    worstFeetError: number;
  } {
    const b = this.battle;
    const p = b.pool;
    const u = b.unitById(unitId);
    const runs: number[] = [];
    const runCounts: Record<number, number> = {};
    let onWall = 0;
    let onGround = 0;
    let onLink = 0;
    let worst = 0;
    if (u) {
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        if (this.crossOf[i] !== -1) { onLink++; continue; }
        const s = this.stationOf[i];
        if (s < 0) { onGround++; continue; }
        onWall++;
        const r = this.sRun[s];
        if (!runs.includes(r)) runs.push(r);
        runCounts[r] = (runCounts[r] ?? 0) + 1;
        const err = Math.abs(p.y[i] - this.sy[this.standingStation(i, s)]);
        if (err > worst) worst = err;
      }
    }
    const plan = this.plans.get(unitId);
    const names = ['hold', 'ascend', 'traverse', 'descend', 'storm'];
    runs.sort((a, c) => a - c);
    return {
      onWall, onGround, onLink, runs, runCounts,
      goal: plan ? names[plan.goal] : 'none',
      destRun: plan ? plan.destRun : -1,
      planAge: plan ? plan.age : -1,
      stuck: plan ? plan.stuck : 0,
      worstFeetError: worst,
    };
  }

  /**
   * The rams, and specifically whether either of them is corking the hole it made.
   *
   * `inPassage` is the assertion the player's report turns on: after a breach, no ram and no
   * crew of one may still be standing in the carriageway. `crewPinned` is the other half —
   * men who have broken and are still being held on a machine they should have abandoned.
   */
  ramReport(): {
    id: number; kind: 'gate' | 'great'; state: string; blows: number;
    /**
     * The gang currently working it.
     *
     * Absent until now, which is why every consumer that wanted "who crews this ram" had to
     * scan `owned` or guess. `recrew` reassigns it mid-battle, so it is not derivable from
     * the deployment either.
     */
    unitId: number;
    /** The gate this machine is aimed at, by id, or `''` for a great ram. */
    gateId: string; gateBlows: number; heave: number; facing: number; wantFacing: number;
    targetX: number; targetZ: number;
    x: number; z: number; distFromTarget: number; wreck: boolean;
    crewAlive: number; crewRouting: boolean; crewPinned: boolean; owned: boolean;
    bay: number; bayBlows: number;
    /**
     * The machine's actual dimensions, so "much larger" is a measurement.
     *
     * Written out because the alternative — a probe that prints "11.6 x 3.4 against 8.4 x
     * 3.8" as literal text in its own detail string — asserts nothing at all. Set
     * `GREAT_RAM_HALF_D` to 0.1 and a prose claim still prints; these change.
     */
    dims: { halfW: number; halfD: number; shedH: number; reach: number; footprint: number };
  }[] {
    const names = ['approach', 'battering', 'withdrawing', 'spent', 'wreck'];
    return this.rams.map((r) => {
      const u = this.battle.unitById(r.unitId);
      const routing = !!u && u.order === UnitOrder.Rout;
      const great = r.kind === RamKind.Great;
      const halfW = great ? GREAT_RAM_HALF_W : RAM_HALF_W;
      const halfD = great ? GREAT_RAM_HALF_D : RAM_HALF_D;
      return {
        dims: {
          halfW, halfD,
          shedH: great ? GREAT_RAM_SHED_H : RAM_SHED_H,
          reach: great ? GREAT_RAM_REACH : RAM_TRUNK_REACH,
          footprint: halfW * 2 * halfD * 2,
        },
        id: r.id,
        kind: r.kind === RamKind.Great ? 'great' as const : 'gate' as const,
        state: names[r.state],
        blows: r.blows,
        unitId: r.unitId,
        gateId: r.gateId,
        gateBlows: r.gateId ? (this.gateBlowsBy.get(r.gateId) ?? 0) : 0,
        heave: r.heave,
        facing: r.facing,
        wantFacing: r.wantFacing,
        targetX: r.targetX, targetZ: r.targetZ,
        x: r.x, z: r.z,
        distFromTarget: Math.sqrt((r.x - r.targetX) * (r.x - r.targetX) + (r.z - r.targetZ) * (r.z - r.targetZ)),
        wreck: r.wreck,
        crewAlive: u ? u.alive : 0,
        crewRouting: routing,
        // The bug in one boolean: broken, and still owned by the siege system, which means
        // still being steered to a muster point instead of running away.
        crewPinned: routing && this.owned.has(r.unitId),
        owned: this.owned.has(r.unitId),
        bay: r.bay,
        bayBlows: r.bay >= 0 ? (this.bayBlows.get(r.bay) ?? 0) : 0,
      };
    });
  }

  /** Breaches the great ram has made, and how many men have stormed through them. */
  breachReport(): {
    bays: number[]; lanes: number; through: number; deadStations: number;
    integrity: { bay: number; hp: number }[];
  } {
    let through = 0;
    for (const id of this.breachLinks) through += this.links[id]?.used ?? 0;
    let deadStations = 0;
    for (let s = 0; s < this.nStations; s++) if (this.sDead[s]) deadStations++;
    const integrity: { bay: number; hp: number }[] = [];
    for (const [bay, blows] of this.bayBlows) {
      integrity.push({ bay, hp: Math.max(0, 1 - blows / WALL_BLOWS) });
    }
    return { bays: this.breachedBays.slice(), lanes: this.breachLinks.length, through, deadStations, integrity };
  }

  /**
   * Whether the gate is shut, and what has been done to it. Drives the gate assertions.
   *
   * The scalar half is **the gate a ram is actually working on**, not `getGates()[0]`. With
   * one gate those are the same thing and every figure this has ever reported is unchanged;
   * with three they are not, and a report pinned to the first gate would say "shut, 0 blows,
   * 100%" all the way through a successful assault on the second one.
   *
   * `gates` is the whole circuit, so a probe can assert about a gate by name instead of by
   * position in an array. Posterns are in it too — they are `GateOut`s that start open — and
   * `open: true` with `blows: 0` is the honest description of one.
   */
  gateReport(): {
    shutAtStart: boolean; open: boolean; breached: boolean;
    blows: number; hp: number; x: number; z: number; id: string;
    gates: { id: string; x: number; z: number; open: boolean; broken: boolean;
      blows: number; hp: number }[];
  } {
    const all = this.city?.getGates() ?? [];
    // The gate under attack: whichever a live gate ram is aimed at, else the worst battered,
    // else the city's first. One expression so the four fields below cannot name two gates.
    let focus = all[0];
    let mostBlows = -1;
    for (const r of this.rams) {
      if (r.kind !== RamKind.Gate || !r.gateId) continue;
      const n = this.gateBlowsBy.get(r.gateId) ?? 0;
      if (n > mostBlows) { mostBlows = n; focus = all.find((g) => g.id === r.gateId) ?? focus; }
    }
    const blows = focus ? (this.gateBlowsBy.get(focus.id) ?? 0) : 0;
    const broken = (id: string): boolean =>
      this.city?.isGateDoorBroken?.(id) ?? this.breachedGates.includes(id);
    return {
      shutAtStart: this.gateShutAtStart,
      open: focus ? focus.open : true,
      breached: this.gateBreached,
      blows,
      hp: Math.max(0, 1 - blows / GATE_BLOWS),
      x: focus ? focus.x : NaN,
      z: focus ? focus.z : NaN,
      id: focus ? focus.id : '',
      gates: all.map((g) => {
        const n = this.gateBlowsBy.get(g.id) ?? 0;
        return { id: g.id, x: g.x, z: g.z, open: g.open, broken: broken(g.id),
          blows: n, hp: Math.max(0, 1 - n / GATE_BLOWS) };
      }),
    };
  }

  stats(): {
    stations: number; garrisoned: number; garrisonMen: number;
    towers: number; rams: number; ladders: number;
    crossing: number; gateBreached: boolean;
  } {
    const p = this.battle.pool;
    let men = 0;
    let crossing = 0;
    for (const [id] of this.garrisons) {
      const u = this.battle.unitById(id);
      if (!u) continue;
      for (const i of u.members) if (p.aliveAt(i) && this.stationOf[i] >= 0) men++;
    }
    for (const t of this.towers) crossing += t.crossing ? t.crossing.queue.length : 0;
    for (const l of this.ladders) crossing += l.crossing ? l.crossing.queue.length : 0;
    return {
      stations: this.nStations,
      garrisoned: this.garrisons.size,
      garrisonMen: men,
      towers: this.towers.length,
      rams: this.rams.length,
      ladders: this.ladders.length,
      crossing,
      gateBreached: this.gateBreached,
    };
  }

  /** Count a missile released from the wall-walk. Called by the projectile system. */
  noteWallShot(): void {
    this.wallShots++;
  }
  noteWallKill(): void {
    this.wallKills++;
  }
  noteArtillery(shots: number, kills: number): void {
    this.artilleryShots += shots;
    this.artilleryKills += kills;
  }

  dispose(): void {
    for (const m of [this.mShaft, this.mDeck, this.mWheels, this.mRamp, this.mShed,
      this.mTrunk, this.mLadder, this.mGreatShed, this.mGreatTrunk]) {
      m?.geometry.dispose();
      m?.dispose();
    }
    this.material?.dispose();
    this.root.removeFromParent();
  }
}
