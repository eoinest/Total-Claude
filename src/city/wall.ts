import * as THREE from 'three';
import { clamp, lerp } from '../util/math';
import { Rng, hash2 } from '../util/rand';
import type { CityMatKey } from './materials';
import {
  archPanel,
  box,
  column,
  crenellation,
  cylinder,
  hipRoof,
  quadPrism,
  statue,
  type Batch,
  type GeoStream,
} from './build';
import {
  bayStage,
  fitWallPath,
  GATE_OPEN_WIDTH,
  GATE_X,
  WALL,
  WALL_LENGTH,
  WALL_X_MAX,
  WALL_X_MIN,
  type BayStage,
  type WallNode,
} from './layout';
import { PAL } from './palette';

/**
 * The Aurelian Wall, under construction.
 *
 * Aurelian began the circuit *because of* this invasion, so in 271 the wall is a
 * building site: finished stretches near the gate, half-built curtains with
 * scaffolding and treadwheel cranes, stockpiled travertine and brick, mortar pits,
 * and gaps blocked in a hurry with palisade and rubble.
 *
 * Dimensions (sources in `layout.ts`): 6.5 m to the wall-walk, `CURTAIN_T` thick,
 * brick-faced concrete on a travertine footing, square towers projecting 3.5 m at
 * one *actus* (35.5 m) intervals, each carrying a ballista chamber under a tiled
 * roof. The monumental gate sits on the axis of the Via Flaminia.
 *
 * The curtain is built bay by bay between towers. Within a bay the wall-walk is
 * *level*; between bays it steps. That is how real Roman curtains cross sloping
 * ground — they step the courses rather than shearing them.
 */

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

/**
 * Thickness of the curtain, metres.
 *
 * **Deliberately not `WALL.thickness`**, which is the historical 3.5 m that Richmond
 * measured on the surviving Aurelianic core and which `layout.ts` publishes to the rest
 * of the city. This is a *playable* wall and the difference is the point.
 *
 * Why 6.0. Three things fix it, and they very nearly meet:
 *
 *  - **Precedent.** 3.5 m is the low end of the late-Roman range, not the norm for a
 *    great circuit. The Theodosian inner wall at Constantinople — Aurelian's idea carried
 *    to its conclusion 140 years later — is 4.5 to 6.0 m thick. 6.0 is the top of the real
 *    range rather than an invention, and Rome II's own playable walls are wider than life
 *    for exactly the reason the player gives: a wall you cannot put an army on is scenery.
 *
 *  - **It is the width at which the *worst* bay still seats five ranks.** The clear
 *    standing band works out at `T - 1.765 - batter * rise` (see `walkGeometry`). Bay 3's
 *    walk stands 40.55 m above its own footing, so the 1-in-30 batter has eaten 1.25 m off
 *    the outer lip by the time it reaches the walk, leaving 2.98 m — and five ranks at the
 *    sim's 0.72 m interlocking pitch need 2.88 m. At 5.5 m thick the tall bays drop to four
 *    ranks and the garrison thins exactly where the wall is highest.
 *
 *  - **A hard ceiling at 6.6.** `probe-siege` asserts that no garrisoned man stands more
 *    than 1.90 m from the bay centreline. The front rank stands at `T/2 - batter*rise -
 *    1.32`, which on the shallowest bay on the circuit is 1.58 m at T = 6.0. T = 6.7 breaches
 *    it. So the useful range is 5.5..6.6 and 6.0 sits in it with 0.32 m of margin.
 *
 * What it costs: the curtain now reads 0.70 of its own height in section rather than 0.41,
 * which is chunkier than the real Aurelianic wall and is visible looking along the top and
 * at the tower returns; and the towers, which are `T + towerProject` deep by construction,
 * grow from 7.0 m to 9.5 m against a 7.6 m width, so they are now deeper than they are wide.
 * Both are accepted: neither is visible from the field, which is where the wall is seen.
 */
export const CURTAIN_T = 6.0;
/** Half-thickness, which is what almost every caller actually wants. */
const HALF_T = CURTAIN_T * 0.5;

/**
 * Body radius of a man, from `resolveCrowding`. He may not overlap the stonework.
 */
const BODY = 0.42;
/**
 * How far back from an *unprotected* lip a rank will stand, metres.
 *
 * A finished bay has a 0.9 m parapet to lean on and the front rank stands against it. A
 * half-built lift has nothing: on 3.5 m of curtain the old rule kept men 0.67 m from a
 * ten-metre drop, which was survivable only because the wall was too narrow for it to
 * matter. On 6.0 m it puts the front rank 2.06 m off the centreline and breaks
 * `probe-siege`'s 1.90 m limit — correctly, because a man will not fight at the edge of an
 * unfinished wall. 1.2 m is a body length back from the void, both sides.
 */
const OPEN_EDGE_SETBACK = 1.2;
/**
 * The covered gallery's piers: 0.6 m across, their cityward face 0.35 m off the walk's
 * inner lip. Shared by `walkGeometry` and `buildCurtainBay` so the garrison's cityward
 * limit and the stone it is clear of are the same number.
 */
const GALLERY_PIER_HALF = 0.3;
const GALLERY_PIER_OFF = -(HALF_T - 0.35 - GALLERY_PIER_HALF);

/**
 * The ballista chamber's own walls: how far its shell is set in from the tower's face, and
 * how thick that shell is. Hoisted out of `buildTower` because `towerLane` has to know how
 * much stone the chamber keeps behind the passage.
 */
const TOWER_CH_INSET = 0.16;
const TOWER_CH_WALL = 0.75;
/** Clear head over the *higher* of the two walks a tower joins, metres. */
export const TOWER_PASS_HEAD = 2.3;

/**
 * The lane through a tower, from the two walks it joins.
 *
 * **One helper, two consumers, and they used to be three metres apart.** `buildTower` cut a
 * 1.7 m opening at `-0.35 .. +1.35` — the clear band of a 3.5 m curtain, never re-derived
 * when the curtain went to 6.0 — while `Siege.linkPath` walked men across at the walk's
 * cityward lip, `innerOff - 0.15`, which is 1.36 m past the far jamb and inside the
 * chamber's back wall. Measured: the traversal path was inside masonry at 42 of Rome's 42
 * walkable towers. So the lane is derived once, published on `GarrisonBay`, and both the
 * stone and the path read it.
 *
 * The lane is the intersection of the two bays' standing bands — a man may not be walked
 * anywhere he could not stand — pulled clear of the chamber's back wall so the tower keeps
 * one. `keepInner` is how much stone must be left on the cityward side; pass the chamber's
 * own shell where there is one and the wall's back thickness where there is not.
 */
function towerLane(
  a: { innerOff: number; outerOff: number; walkY: number },
  b: { innerOff: number; outerOff: number; walkY: number },
  halfThickness: number,
  keepInner: number
): { outer: number; inner: number; loY: number; hiY: number; loIsWest: boolean } {
  const outer = Math.min(a.outerOff, b.outerOff);
  // Never cityward of the stone that has to stay standing behind it.
  const backLimit = -(halfThickness - keepInner);
  const inner = Math.max(Math.max(a.innerOff, b.innerOff), backLimit);
  return {
    outer,
    inner,
    loY: Math.min(a.walkY, b.walkY),
    hiY: Math.max(a.walkY, b.walkY),
    // `b` is the western neighbour at every call site: the tower stands at the eastern
    // bay's `x0`.
    loIsWest: b.walkY <= a.walkY,
  };
}

/** A man is 0.84 m across the shoulders; anything narrower is not a doorway. */
const MIN_LANE = 0.9;

/** What `buildTower` needs to know about the doorway it is cutting. See `towerLane`. */
interface TowerPassOut {
  outer: number;
  inner: number;
  loY: number;
  hiY: number;
  /** True when the *west* neighbour is the lower walk, so the flight inside climbs east. */
  loIsWest: boolean;
}

export interface WallSegmentOut {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  /**
   * Rise of the masonry above its own footing, **not** an absolute Y. A consumer that
   * wants the height of the wall-walk above the datum must add the ground height under
   * the bay — or, better, read `GarrisonBay.walkY`, which is absolute and is the same
   * number the geometry is actually built at.
   */
  height: number;
  /** True for the bay the gate passage runs through: masonry, but with a hole in it. */
  gate: boolean;
  /**
   * True for a bay whose work is standing but is not a barrier — today, a bare footing.
   *
   * It exists to close a disagreement between two published views of the same stone.
   * `blockers`, and therefore `getObstacles()` and the occupancy raster, omit a footing bay
   * entirely; `segments` has always included it, at a height, and `Pathfinding`'s
   * `stampWallSegments` fallback would have stamped it solid. Only one of those two
   * providers is live — the city publishes `getObstacles`, so the fallback never runs — so
   * the disagreement has never cost anything. It is exactly the shape of the four
   * cross-subsystem faults found this week, two of which meant a feature had never worked
   * in any shipped build, and it is a one-line edit away from mattering.
   *
   * A consumer that turns a segment into a barrier must skip these. A consumer that wants
   * to know what a body has to get over should read `roughGround`, which carries the
   * measured rise rather than a nominal height.
   */
  rough: boolean;
  /** Half-thickness of the curtain, so a consumer stamping an obstacle gets it right. */
  halfThickness: number;
}

/**
 * Built work that stands in a body's way without stopping it.
 *
 * The Aurelian circuit in 271 is a building site, and three of its fifty bays are at stage
 * `footing`: a travertine plinth and the first lift of poured concrete between shuttering
 * boards. Those three bays are deliberately open — they are the only way into Rome that
 * does not need a ladder, and closing them would make the battle unlosable — but until this
 * existed they were open in the strongest possible sense. They emitted no blocker, so no
 * obstacle box, so no occupancy cell and no nav stamp, and *nothing in the game knew there
 * was anything there at all*: a squadron of horse crossed 6.8 m of concrete in 3.4 seconds
 * at a flat gallop, and the nav raster charged 1.18 for the cell on the wall's centreline
 * against 1.77 for the open grass seven metres in front of it. The cheapest lane across the
 * battlefield ran through the wall.
 *
 * So this is the third state the wall never had: **standing work, passable, at a price.**
 *
 * `rise` is what a body actually has to get over, and it is not a nominal figure — it is
 * `unfinishedTopAt` (the function the stone itself is cut from) evaluated against the
 * ground under the same point, taken at its worst along the run. Measured on the shipped
 * circuit: bay 2 1.35–3.54 m, bay 28 1.35–2.33 m, bay 29 1.94–2.75 m. Four comments in this
 * repository called that pour "ankle-high" or "knee-high"; it is chest-high on a man and
 * withers-high on a horse, and those comments have been corrected rather than the stone,
 * because the stone is what Roman construction actually gives you: 1.35 m of travertine
 * plinth with a 1.0 m lift of concrete on top of it.
 */
export interface RoughGround {
  /** Which bay this is, so a consumer can name it. */
  bay: number;
  /** Centre of the footprint. */
  x: number;
  z: number;
  /** Half-extents along the run and across it. */
  hw: number;
  hd: number;
  /** Yaw of the run about +Y. */
  rot: number;
  /** Absolute Y of the top of the built work, at its highest along the run. */
  crestY: number;
  /**
   * Metres a body must climb to get over it, worst case along the run.
   *
   * Worst case rather than mean, because a formation crosses on a frontage and the man on
   * the bad metre is the one who holds it up.
   */
  rise: number;
  stage: BayStage;
}

/**
 * A bay of the curtain described as somewhere a man can stand.
 *
 * This is the contract between the wall geometry and the siege simulation, and it exists
 * because the two were derived independently once and disagreed. `walkY` is **absolute**
 * and is produced by the same function the wall-walk quad is built from, so a garrisoned
 * man cannot be at a different height from the stone under his feet.
 *
 * Offsets are along the bay's outward normal: negative is cityward. The clear standing
 * band runs from `innerOff` (nearest the city) to `outerOff` (up against the parapet).
 */
export interface GarrisonBay {
  index: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Outward (northward) unit normal of the run. */
  nx: number;
  nz: number;
  /** Unit vector along the run, x0 -> x1. */
  dx: number;
  dz: number;
  length: number;
  stage: BayStage;
  /** Absolute Y of the surface a man's feet rest on. */
  walkY: number;
  /** Ground under the bay — the lower of its two ends. */
  groundY: number;
  /** Absolute Y of the top of the merlons. What a flat shot must clear. */
  crestY: number;
  /**
   * Absolute Y of the sill between the merlons — the bottom of a crenel.
   *
   * A defender shoots *through* the embrasure, not over the battlement: the merlons are
   * 1.45 m of brick on top of a 0.6 m sill, and a 1.75 m man behind a merlon cannot see
   * out at all. Equal to `walkY` where there is no parapet raised yet.
   */
  sillY: number;
  /** Normal-offsets of the parapet's inner and outer faces. Equal where there is none. */
  parapetInner: number;
  parapetOuter: number;
  /** Normal-offset of the cityward limit of the clear standing band. */
  innerOff: number;
  /** Normal-offset of the outward limit, clear of the parapet or the merlon stacks. */
  outerOff: number;
  /**
   * False for footing and gap bays, which have no walkway to stand on, and false for the
   * bay the gatehouse stands in — that bay *has* a walkway either side of the block, but
   * the block breaks the run in two and a garrison rank must not be laid across it.
   */
  garrisonable: boolean;
  /**
   * True where there is a wall-walk at `walkY`, whether or not a garrison is posted on it.
   *
   * This, not `garrisonable`, is what the movement grid takes an obstacle's top from: the
   * gate bay's curtain is a walking surface at `walkY` and stamping it to `crestY` put its
   * top two metres inside the merlons.
   */
  walkable: boolean;
  /**
   * Half-thickness of the curtain here, so a consumer testing "is this point inside the
   * masonry" does not have to know `CURTAIN_T`.
   *
   * Published because the curtain is no longer `WALL.thickness` wide and one consumer still
   * reads that constant — `CitySystem.masonryTopAt` tests `|off| > WALL.thickness * 0.5`,
   * which on a 6 m wall makes the rear 1.25 m of the wall-walk and the whole parapet
   * footprint transparent to arrows. Read this instead.
   */
  halfThickness: number;
  /** Half-length of the tower footprint at `x0`, which the walkway does not pass through. */
  towerHalf: number;
  /**
   * Whether a curtain tower actually stands at `x0`.
   *
   * Not the same question as `towerHalf > 0`, and kept separate because the two were
   * conflated: the movement grid decided whether to stamp a tower box from `towerHalf`,
   * which is a *standing* offset and can be non-zero for reasons that are not a tower.
   */
  hasTower: boolean;
  /**
   * The clear lane cut through the tower at `x0`, as offsets along the outward normal.
   *
   * **This is the doorway, published, and it is the thing that was missing.** A tower stands
   * on the full thickness of the curtain on both circuits — Rome's is 9.5 m deep on a 6.0 m
   * wall and Carthage's 14.6 m on a 9.1 m one, both flush with the inner face — so there is
   * no ground to walk *round* one, and the pass has to go *through*. `Siege.linkPath` walks
   * a man across a tower on the centre of this band, and `buildTower`/`buildPunicTower` cut
   * the stone out of the same band. They used to be derived separately and disagreed by
   * 1.36 m, which is how forty-two towers came to have a doorway nobody walked through.
   *
   * `passOuter` is the fieldward limit and `passInner` the cityward one, so
   * `passInner <= passOuter` exactly as with `innerOff`/`outerOff`. Both are 0 where there
   * is no tower, or where the two bays the tower joins leave no lane between them.
   */
  passOuter: number;
  passInner: number;
  /**
   * Absolute Y of the lower and higher of the two wall-walks the tower at `x0` joins.
   *
   * The walk steps at a tower — median 1.65 m on Rome, up to 7.70 m — because `walkY` is a
   * quantised construction level held over pairs of bays and the ground under the circuit
   * rolls. The tower carries a flight between the two inside its own footprint; these are
   * its ends, so the crossing path and the stone agree about which way is up.
   */
  passLoY: number;
  passHiY: number;
  isGate: boolean;
}

export interface GateOut {
  id: string;
  x: number;
  z: number;
  facing: number;
  open: boolean;
}

/**
 * The gatehouse as a solid: an oriented box on the wall line, with the carriageway
 * through it.
 *
 * Separate from the bays on purpose. The block is 25 m long and centred on where the Via
 * Flaminia actually crosses, so it straddles two bays; anything that reads it off the bay
 * flagged `isGate` gets the wrong 35.5 m of ground. That is precisely how `masonryTopAt`
 * came to report a fifteen-metre gatehouse standing over 23 m of open grass.
 */
export interface GateBlockOut {
  /** Centre of the carriageway, on the wall line. */
  x: number;
  z: number;
  /** Outward normal and along-run direction of the block, matching the bay's. */
  nx: number;
  nz: number;
  dx: number;
  dz: number;
  /** Half-extent along the run. */
  halfRun: number;
  /** Half-extent across the run, front face to back face. */
  halfDepth: number;
  /** Absolute Y of the top of the block's battlements. */
  topY: number;
  /**
   * The gatehouse's **battlement**, and why it took four fields to say what a bay says in
   * two.
   *
   * `topY` used to be the whole of it, and `CitySystem.masonryTopAt` returned it flat across
   * the block's entire 25 x 11.9 m footprint. Both halves of that were wrong and both were
   * measurable:
   *
   *  - The crown a man's shot has to clear is `sillY`, not `topY`. The roof of the block and
   *    the cornice round it stand at the merlons' feet, so **11 of the block's 11.9 m of
   *    depth were being reported two metres too high**, and a shot from the wall-walk on
   *    either side that would have skimmed the roof broke on air.
   *  - The merlon line itself is crenellated in stone — `buildGate` lays a real
   *    `crenellation()` on it — and was modelled as a solid barrier. A bay's parapet has
   *    alternated merlon and crenel since the day an archer was found shooting his own
   *    battlement; the gatehouse never did, so the 25 m of frontage between two garrisoned
   *    bays was a wall nobody could shoot through.
   *
   * Measured at 4e3145f on Rome: `masonryTopAt` returned **one** distinct height over the
   * 24 m at the gate, against two over an ordinary 25 m of curtain twenty metres away.
   */
  /** Absolute Y of the crenel sills: the crown the merlons stand on, and the roof behind. */
  sillY: number;
  /** Normal-offsets of the fieldward merlon line's inner and outer faces. */
  parapetInner: number;
  parapetOuter: number;
  /**
   * True where the cityward face carries a merlon line as well, mirrored about the
   * centreline. Rome's gate is crenellated on its field face only; Carthage's is a keep and
   * is crenellated on both, which is what a gatehouse in a casemated wall is for.
   */
  crenelledCityward: boolean;
  /**
   * Merlon and crenel lengths **as the stone was cut**, which on Rome is not what the plan
   * states: `buildGate` lays 1.5 / 0.8 while `rome/plan.ts` publishes 1.7 / 0.95 for the
   * curtain. Resolving the block through the plan's numbers would put the collision model
   * out of register with its own masonry by a whole merlon at the block's far end — the
   * exact failure `crenellationRun` was written to prevent. So the block carries its own.
   */
  merlonLength: number;
  crenelLength: number;
  /** Half the clear width of the carriageway. */
  openHalf: number;
}

/**
 * The Porta Flaminia's twin leaves, as a thing that can be shut, opened or broken.
 *
 * **They start shut**, which is the fourth of the player's reports and the one that changes
 * behaviour rather than geometry: the gate stood open by default, so the Juthungi could
 * simply walk into Rome and the battering ram in the siege train had nothing to do. The
 * geometry here is the shut state; the *breaking* of it belongs to the siege system, and
 * this is the surface it drives.
 *
 * The leaves hang on pintles at `±halfWidth` along the run and swing about those hinges.
 * A consumer animating them needs only the hinge line and the leaf extent; a consumer
 * replacing them with wreckage needs the plane. `CitySystem.setGateOpen` already exists and
 * already re-cuts the movement obstacles, so opening the gate is one call — what was
 * missing was that it was never shut to begin with.
 */
export interface GateDoorOut {
  /** The gate these leaves close. Matches `GateOut.id`. */
  gateId: string;
  /** Centre of the door plane, on the wall line, at threshold level. */
  x: number;
  y: number;
  z: number;
  /** Outward normal — the way the leaves face the field. */
  nx: number;
  nz: number;
  /** Along-run unit vector. The hinges are at `±halfWidth` along it. */
  dx: number;
  dz: number;
  /** Half the clear width of the opening, i.e. the hinge offset from the centreline. */
  halfWidth: number;
  /** Height of a leaf above the threshold. */
  height: number;
  /** Leaf thickness, front to back. */
  thickness: number;
  /** How far the door plane stands behind the outer face of the gatehouse block. */
  setback: number;
  /**
   * False. The leaves are shut and barred, and the ram has to bring them down.
   *
   * Mirrors `GateOut.open` for the same gate; kept on the door as well so a consumer
   * animating the leaves does not have to go and find the gate record.
   */
  open: boolean;
  /**
   * True once the ram has brought them down and the wreckage is what is drawn.
   *
   * Distinct from `open`, and the distinction is load-bearing: `Siege.armGate` shuts the
   * gate on the first tick of every battle, so a leaf state derived from `open` alone would
   * hang a wrecked gate's doors back on the next thing that closed it. Written by
   * `CitySystem.setGateDoorBroken(id)` and read back here, so the mesh, this record and
   * `isGateDoorBroken` cannot disagree.
   */
  broken: boolean;
}

/**
 * A masonry stair climbing the **inner** face of the curtain, parallel to it.
 *
 * This is the contract for anything that wants to walk a man up onto the wall, and it is
 * deliberately three points and a width rather than a mesh. Everything a mover needs:
 *
 *  - `foot` is on the ground outside the wall's own footprint, `head` is on the walkway
 *    level at the top of the rake, and the surface between them is a **straight linear
 *    ramp**: at parameter `s` in 0..1 the tread is at `lerp(foot, head, s)` in all three
 *    axes. There are treads, but they are 0.29 m risers on a 0.42 m going and a mover can
 *    treat the flight as a plane without ever being more than 0.15 m off the stone.
 *  - `top` is where the landing at the head meets the wall-walk, at `headY`. Foot → head →
 *    top is the whole path onto the wall; the last leg is flat, 2.2 m of level landing.
 *  - **Up is `top`, down is `foot`,** and they are never at the same height: `rise` is
 *    always positive and always equals `topY - footY`. `side` is −1 on every flight on this
 *    circuit, because they are all cityward; it is published rather than implied so a
 *    consumer never has to infer the sense of the normal to tell inside from outside.
 *  - `bay` is the index of the `GarrisonBay` the flight delivers onto, so a mover can join
 *    the stair to the garrison spine's stations without a spatial query.
 *  - `width` is the clear width between the curtain and the stair's own parapet. Two men
 *    abreast, so a relief going up can pass a casualty coming down.
 *
 * The field names `footX/footY/footZ`, `topX/topY/topZ`, `width` and `side` are the ones
 * `Siege.ts`'s `CityStairView` already asks for, so `CitySystem.getWallStairs()` hands this
 * record straight over with no adapter and no chance of the two drifting.
 *
 * Offsets: the flight is built entirely on the city side. `foot`, `head` and `top` are
 * absolute world positions, so a consumer needs none of the wall's internal frame.
 */
export interface WallStair {
  /** Index of the `GarrisonBay` this flight serves. */
  bay: number;
  /** Bottom of the flight, on the ground in the pomerium. */
  footX: number;
  footY: number;
  footZ: number;
  /** Top of the rake, on the flight's own centreline, level with the walk. */
  headX: number;
  headY: number;
  headZ: number;
  /** Where the landing at the head meets the wall-walk. Flat from `head`. */
  topX: number;
  topY: number;
  topZ: number;
  /** Unit vector foot → head, in plan. */
  dx: number;
  dz: number;
  /** Outward normal of the curtain the flight is built against. */
  nx: number;
  nz: number;
  /** Clear width of the treads. */
  width: number;
  /** Plan distance foot → head. */
  run: number;
  /** `topY - footY`, always positive: the flight only ever climbs from foot to top. */
  rise: number;
  /** Number of risers in the rake. `rise / steps` is the riser height. */
  steps: number;
  /** −1 cityward, +1 outward. Always −1 here: a Roman wall stair is inside its own wall. */
  side: -1 | 1;
}

export interface Blocker {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  halfW: number;
}

export interface TreeRequest {
  x: number;
  z: number;
  kind: 'cypress' | 'pine' | 'umbrella';
  scale: number;
  /** Absolute base height. Omit to plant on the terrain; set it for roof gardens
   *  and for the cypresses on top of the Mausoleum's tumulus. */
  y?: number;
}

export interface CityChunkSpec {
  name: string;
  cx: number;
  cz: number;
  radius: number;
  /** `detail` runs 0 (far silhouette) .. 2 (full). */
  build: (b: Batch, detail: number) => void;
  castShadow: boolean;
  /** Distance at which each detail level takes over, near to far. */
  lodSwitch: [number, number];
  /** Material the far level collapses into. Defaults to `stone`. */
  farMaterial?: CityMatKey;
  /**
   * Distant scenery that deliberately lies outside the heightfield — only the horizon
   * ring. Exempt from `assertNoStrayGeometry`'s battlefield test, and required by it to
   * stay wholly beyond the map instead.
   */
  scenery?: boolean;
  /**
   * This chunk is one gate's leaves, and `CitySystem.setGateDoorBroken(id)` hides it.
   *
   * A gate's leaves are the one piece of city geometry that has to *disappear* at runtime,
   * and until now they could not: they were `box()` calls merged into a wall chunk's timber
   * stream, so `setGateOpen` re-cut the occupancy raster and the obstacle boxes while the
   * doors stayed drawn, shut, for the rest of the battle. The ram lands twenty-six blows,
   * the gate opens, men walk through the arch — and the player watches two leaves that never
   * move. `getGateDoor()` has published the hinge line and the leaf extent for exactly this
   * since it was written, with the comment "the siege system swings or wrecks these by
   * hiding this geometry and drawing its own", and there was nothing to hide.
   *
   * A chunk is the seam that already exists for it: it bakes, it culls, it is measured by
   * `assertNoStrayGeometry`, and its group's `visible` is already owned by one place. So the
   * leaves are authored into their own chunk instead of into the gatehouse's, and hiding
   * them is one call. The id is carried rather than encoded in the name, because
   * `7e72785` was the second bug caused by a hard-coded `'porta-flaminia'`.
   */
  gateDoorFor?: string;
  /**
   * This chunk is one gate's **wreckage**, drawn only after `setGateDoorBroken(id)`.
   *
   * The counterpart to `gateDoorFor`, and the difference between a gate that reads as broken
   * and one that reads as merely missing. Hiding the leaves on a breach leaves a clean
   * archway with the portcullis still raised behind it — which is what an *opened* gate
   * looks like, and the player has been told a ram spent two minutes on it. So the same
   * leaves are authored a second time in the pose the ram left them: one half hanging off
   * its harr-post, canted into the passage with its head splintered away, the other down
   * across the threshold, and the drawbar snapped in two.
   *
   * `CitySystem.bakeChunk` bakes this level and immediately hides it, so it costs nothing
   * until it is wanted: three.js skips a hidden group in `projectObject`, and the intact
   * leaves it replaces are hidden in the same call. The swap is draw-call neutral in both
   * directions and it is measured that way in `getStats().visibleMeshes`.
   */
  gateWreckFor?: string;
}

export interface WallBuildOutput {
  path: WallNode[];
  chunks: CityChunkSpec[];
  segments: WallSegmentOut[];
  gates: GateOut[];
  /** Where the gatehouse masonry actually stands. See `GateBlockOut`. */
  gateBlock: GateBlockOut;
  blockers: Blocker[];
  /** Standing work that slows a body without stopping it. See `RoughGround`. */
  roughGround: RoughGround[];
  trees: TreeRequest[];
  towerCount: number;
  bayStages: BayStage[];
  /** Every bay described as a place to stand. See `GarrisonBay`. */
  garrisonBays: GarrisonBay[];
  /** Every masonry flight onto the wall-walk. See `WallStair`. */
  stairs: WallStair[];
  /** The Porta Flaminia's leaves. Shut. See `GateDoorOut`. */
  gateDoor: GateDoorOut;
  /** Where the wall line sits, for the insula generator to build up against. */
  wallZAt: (x: number) => number;
}

interface Bay {
  index: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Level of the wall-walk in this bay; flat across the bay, stepped between them. */
  topY: number;
  g0: number;
  g1: number;
  /** Highest terrain anywhere under the run, not only at its two ends. */
  gMax: number;
  stage: BayStage;
  isGate: boolean;
  /**
   * True for the piece of a run that carries the bay's one-off construction dressing —
   * the scaffold, the material yard, the shuttering. A run cut in two by the gatehouse
   * would otherwise put two cranes on one bay. See `curtainSpans`.
   */
  dress: boolean;
}

// ---------------------------------------------------------------------------
// The gatehouse block, as a span the curtain has to make room for
// ---------------------------------------------------------------------------

/**
 * Along-run width of the Porta Flaminia's masonry block. `buildGate` builds to this.
 *
 * The block is centred on `GATE_X` — where the Via Flaminia crosses the crest, solved
 * from the Lanciani georeference — and `GATE_X` is not a bay boundary and need not even
 * lie in the bay the gate is booked to. So the curtain is *cut* to receive the block
 * rather than one whole bay being replaced by it.
 *
 * Replacing a whole bay is what this fixes. The gate is at x = 72, which falls in bay 19,
 * while `gateBay` rounds to 20 — so `buildGate` ran instead of `buildCurtainBay` for the
 * 35.5 m of bay 20, covered 5.5 m of it with the east end of the block, and left 28.4 m
 * of open grass immediately east of the Porta Flaminia. Meanwhile bay 19's curtain was
 * built straight through the middle of the gate passage, so the one way into Rome was
 * bricked up 3.75 m behind the doors.
 */
const GATE_BLOCK_W = 25;
/** Front-to-back depth of the block, so the passage is a real tunnel. */
const GATE_BLOCK_D = 11;
/** Clear height of the carriageway to the springing of the vault. */
const GATE_PASS_H = 8.4;
/** The attic above the arch, carrying the dedicatory inscription. */
const GATE_ATTIC = 4.8;
/** Merlon height on the gate block's crown. */
const GATE_MERLON_H = 2.0;
/**
 * The crown's crenellation, as three numbers the stone and the collision model share.
 *
 * `buildGate` used to carry these as literals in its `crenellation()` call and
 * `GateBlockOut` published none of them, so `masonryTopAt` had nothing to alternate with and
 * reported the block solid. Named here because two callers now need the same answer.
 */
const GATE_CREN_INSET = 0.5;
const GATE_CREN_T = 0.9;
const GATE_MERLON_W = 1.5;
const GATE_CRENEL_W = 0.8;
/** Height of the brick face's springing above the road, where the barrel vault starts. */
const GATE_SPRING = 1.15 + 4.3;
/**
 * How far the door plane stands behind the outer face of the block.
 *
 * The *cataracta* drops in its slot 0.85 m inside the face; the leaves hang 1.35 m behind
 * it, which is the arrangement at the Porta Appia and gives the portcullis somewhere to
 * fall that is not on top of the doors. Keeping them near the front also matters to the
 * siege system: a ram parks against the gatehouse and has to be able to reach what it is
 * breaking, not drive seven metres up a tunnel first.
 */
const GATE_DOOR_SET = 2.2;
/** Top of the threshold slab, which the leaves close down onto. */
const GATE_DOOR_SILL = 0.12;
/** Leaves run from the threshold to the springing; the lunette above is filled in brick. */
const GATE_DOOR_H = GATE_SPRING - GATE_DOOR_SILL;
/** Twin oak leaves, iron-bound. Thick enough to need 26 blows of a ram. */
const GATE_DOOR_T = 0.22;
/**
 * Half-width of the span the curtain is cut out of, 0.3 m inside the block's own face so
 * the curtain dies *inside* the brick and no seam can open between the two.
 */
const GATE_CLIP_HALF = GATE_BLOCK_W * 0.5 - 0.3;

/** True where the gatehouse block stands, so nothing else may be built there. */
function inGateBlock(x: number): boolean {
  return Math.abs(x - GATE_X) <= GATE_CLIP_HALF;
}

/**
 * The lane through the tower at `bay.x0`, or null where there is not one.
 *
 * **The single place the doorway is decided**, called by the bay record the siege system
 * reads *and* by the stone `buildTower` lays, so the two cannot disagree. That is not
 * tidiness: they were derived separately, drifted 1.36 m apart, and forty-two towers ended
 * up with an opening in one place and a file of men walking through the brick beside it.
 *
 * Null where there is no walk on both sides — a footing, a gap, or the far end of the
 * circuit. A doorway onto a bare footing is a door onto air.
 */
function towerPassOf(bay: Bay, prev: Bay | undefined): TowerPassOut | null {
  if (!prev || inGateBlock(bay.x0)) return null;
  const here = walkGeometry(bay);
  const west = walkGeometry(prev);
  if (!here.garrisonable || !west.garrisonable) return null;
  const lane = towerLane(here, west, HALF_T, TOWER_CH_INSET + TOWER_CH_WALL);
  return lane.outer - lane.inner >= MIN_LANE ? lane : null;
}

/**
 * The parts of a run from `x0` to `x1` that the gatehouse does not stand in: the whole
 * run, one piece of it, or the two flanks either side of the block.
 */
function curtainSpans(x0: number, x1: number, out: [number, number][]): [number, number][] {
  out.length = 0;
  const a = GATE_X - GATE_CLIP_HALF;
  const b = GATE_X + GATE_CLIP_HALF;
  if (b <= x0 || a >= x1) {
    out.push([x0, x1]);
    return out;
  }
  if (x0 < a) out.push([x0, Math.min(a, x1)]);
  if (x1 > b) out.push([Math.max(b, x0), x1]);
  return out;
}

/**
 * One piece of a bay, as a bay in its own right.
 *
 * `topY`, `g0`, `g1` and `gMax` are deliberately the *parent's*: the wall-walk is level
 * across a whole bay by construction, and `walkGeometry` has to give the piece the same
 * answer it gives the garrison API for the bay, or the two disagree again.
 */
function clipBay(bay: Bay, ax: number, bx: number, dress: boolean): Bay {
  if (ax === bay.x0 && bx === bay.x1 && dress) return bay;
  const span = bay.x1 - bay.x0;
  return {
    ...bay,
    x0: ax,
    z0: lerp(bay.z0, bay.z1, (ax - bay.x0) / span),
    x1: bx,
    z1: lerp(bay.z0, bay.z1, (bx - bay.x0) / span),
    dress,
  };
}

const OUT = new THREE.Vector3();
const P0 = new THREE.Vector3();
const P1 = new THREE.Vector3();
const P2 = new THREE.Vector3();
const P3 = new THREE.Vector3();

interface Frame {
  nx: number;
  nz: number;
  dx: number;
  dz: number;
  len: number;
  rotY: number;
}

/**
 * Local frame of a wall run. `n` is the outward (northward) normal; `rotY` rotates a
 * module authored with −Z outward onto this run.
 */
function frameOf(x0: number, z0: number, x1: number, z1: number): Frame {
  const len = Math.hypot(x1 - x0, z1 - z0) || 1;
  const dx = (x1 - x0) / len;
  const dz = (z1 - z0) / len;
  // A run heading +X has its outward side toward −Z, i.e. toward the Juthungi.
  const nx = dz;
  const nz = -dx;
  return { nx, nz, dx, dz, len, rotY: Math.atan2(-nx, -nz) };
}

/**
 * Absolute top of the built work on a stage that has no construction level — a bare
 * footing or a rubble gap — at a point where the terrain stands at `localGround`.
 *
 * Exported because two things need the same answer and derived it separately once
 * already: `walkGeometry`, which reports one number per bay, and `CitySystem.masonryTopAt`,
 * which is asked per point and must not answer with the bay's maximum. Bay 2 crosses a
 * knoll and its footing runs from 10.4 m at the ends to 19.5 m over the rise, so a single
 * number for the bay is nine metres wrong at one end of it whichever number you pick.
 */
export function unfinishedTopAt(stage: BayStage, bayGroundY: number, localGround: number): number {
  return stage === 'footing'
    // A footing is two things at two references, and the top is whichever is higher here:
    // `buildFootingSite`'s concrete pour, *level* across the whole bay at
    // `min(g0,g1) + plinthHeight + 1`, and `buildCurtainBay`'s travertine plinth, which
    // follows the ground.
    ? Math.max(bayGroundY + WALL.plinthHeight + 1.0, localGround + WALL.plinthHeight)
    // `buildGapBarricade`: rammed earth and rubble, crest 2.5..3.4 m over the ground it
    // sits on, which it follows. The palisade above it is stakes, not a surface.
    : localGround + 3.4;
}

/**
 * Worst rise of an unfinished bay's work above the ground under that very point, metres.
 *
 * The number a body has to get over, and deliberately not the number the bay reports as
 * its height. `unfinishedTopAt` answers per point because the work follows the ground
 * across 35.5 m of terrain that varies by ten metres; subtract the ground at the same
 * point and you have the step. Taken at its maximum along the run, because a formation
 * crosses on a frontage and the worst metre is the one that holds it up.
 *
 * Sampled at 1/32 intervals **strictly inside** the run. Sampling the endpoints is how the
 * first instrument to ask this question reported bay 2's pour as standing 40.55 m proud:
 * `x0` belongs to the previous bay by index arithmetic, and bay 2's neighbour is finished
 * curtain with its walk 40 m up.
 */
export function worstRiseOf(
  bay: { x0: number; z0: number; x1: number; z1: number; g0: number; g1: number; gMax: number; stage: BayStage },
  heightAt: (x: number, z: number) => number
): number {
  const gMin = Math.min(bay.g0, bay.g1);
  let worst = 0;
  for (let k = 0; k <= 32; k++) {
    const t = 0.02 + (k / 32) * 0.96;
    const px = lerp(bay.x0, bay.x1, t);
    const pz = lerp(bay.z0, bay.z1, t);
    const g = heightAt(px, pz);
    const rise = unfinishedTopAt(bay.stage, gMin, g) - g;
    if (rise > worst) worst = rise;
  }
  return worst;
}

/**
 * Where the top of this bay is, and where on it a man can stand.
 *
 * **The single source of truth for the wall-walk's height**, called both by the geometry
 * builder that emits the stone and by the garrison API that puts men on it. They used to
 * derive it separately and disagreed: `Bay.topY` is the quantised construction level, but
 * a half-built bay is built at `max(g0,g1) + 3.4` instead and then carries 0.3 m of
 * exposed rubble core on top, so a garrison placed at `topY` stood a third of a metre
 * inside the masonry on exactly the bays the assault is aimed at.
 *
 * Offsets are measured along the outward normal from the bay centreline.
 */
function walkGeometry(bay: Bay): {
  walkY: number;
  crestY: number;
  sillY: number;
  parapetInner: number;
  parapetOuter: number;
  innerOff: number;
  outerOff: number;
  garrisonable: boolean;
} {
  const T = CURTAIN_T;
  const gMin = Math.min(bay.g0, bay.g1);
  const stage = bay.stage;
  // Matches `buildCurtainBay` exactly.
  const topY = stage === 'half-built' ? Math.max(bay.g0, bay.g1) + 3.4 : bay.topY;
  // Outer face leans back 1-in-30 over the lift, so the walkway's outer lip is inboard
  // of the nominal half-thickness by the batter times the rise.
  const walkOuter = T * 0.5 - WALL.batter * Math.max(0, topY - (gMin + WALL.plinthHeight));
  // The inner lip of the walk quad, less the walk's own 25 mm inset.
  const innerLip = -(T * 0.5 - 0.025);

  if (stage === 'footing' || stage === 'gap') {
    // No walkway: a footing is the first lift of a concrete pour on its travertine plinth,
    // and a gap is an earth rampart with a palisade on it. Both are places to fight *at*,
    // not on.
    //
    // **Not knee-high, whatever this comment used to say.** `unfinishedTopAt` puts the
    // pour at `min(g0,g1) + 1.35 + 1.0`, and measured against the ground under each point
    // of the shipped circuit that is 1.35–3.54 m on bay 2, 1.35–2.33 on bay 28 and
    // 1.94–2.75 on bay 29 — chest-high on a man, withers-high on a horse. The stone is
    // right; Roman practice is a 1.35 m plinth with a 1.0 m lift on it. The description
    // was wrong, and it was wrong in four places, one of which (`Obstacles.TOP_SLACK`)
    // sized a step-up allowance at 0.4 m for "a low footing course" that is six times
    // that. See `RoughGround`.
    //
    // The height reported is what has been *built*, not `bay.topY`, which is the level
    // the finished wall will eventually reach. Those are the same number nowhere on this
    // circuit and forty metres apart on the Tiber bank, where bay 2's footing is a pour
    // at ground + 2.35 and its construction level is 48.4 because the level is held over
    // pairs of bays and its neighbour climbs a hill. `masonryTopAt` reported the latter,
    // so an arrow shot at a chest-high footing stopped dead in clear air above it, and a
    // gap bay's obstacle box was a forty-metre invisible tower.
    //
    // One number for a whole bay, so it is the bay-wide *maximum*: `unfinishedTopAt`
    // evaluated at the highest ground in the run. `masonryTopAt` re-evaluates it per point.
    const built = unfinishedTopAt(stage, gMin, bay.gMax);
    return {
      walkY: built, crestY: built, sillY: built,
      parapetInner: 0, parapetOuter: 0,
      innerOff: 0, outerOff: 0, garrisonable: false,
    };
  }

  if (stage === 'half-built') {
    // Standing on the exposed rubble core, 0.3 m proud of the finished lift and inboard of
    // both facing skins. No parapet on either side, so the line stands a body length back
    // from both lips — see `OPEN_EDGE_SETBACK`. Symmetric, because the drop into the
    // pomerium kills a man exactly as well as the drop onto the glacis.
    const half = (T - 0.55) * 0.5;
    return {
      walkY: topY + 0.3,
      crestY: topY + 0.3,
      sillY: topY + 0.3,
      parapetInner: half,
      parapetOuter: half,
      innerOff: -half + OPEN_EDGE_SETBACK + BODY,
      outerOff: half - OPEN_EDGE_SETBACK - BODY,
      garrisonable: true,
    };
  }

  if (stage === 'no-parapet') {
    // Parapet not raised yet: dressed merlon blocks are stacked on the walk 1.1 m in
    // from the outer lip and are 0.8 m across, so the outward limit is inboard of them.
    return {
      walkY: topY,
      crestY: topY + 1.26,
      sillY: topY,
      // The stacked merlon blocks waiting to be set: 0.8 m across, 1.1 m in from the lip.
      parapetInner: walkOuter - 1.5,
      parapetOuter: walkOuter - 0.7,
      innerOff: innerLip + BODY,
      outerOff: walkOuter - 1.1 - 0.4 - BODY,
      garrisonable: true,
    };
  }

  // Finished. The parapet occupies [walkOuter - parapetThickness, walkOuter], and the
  // front rank stands with its shoulders against the inner face of it, which is what
  // shooting over a merlon looks like.
  //
  // Bays carrying the covered gallery have piers standing just inboard of the walk's
  // cityward lip. The cityward limit is pulled in clear of them rather than letting the
  // rear rank stand inside a colonnade.
  const gallery = bay.index % 5 === 1;
  return {
    walkY: topY,
    crestY: topY + WALL.parapetHeight,
    // `buildCurtainBay` lays a solid 0.6 m sill and stands the merlons on top of it.
    sillY: topY + 0.6,
    parapetInner: walkOuter - WALL.parapetThickness,
    parapetOuter: walkOuter,
    innerOff: gallery ? GALLERY_PIER_OFF + GALLERY_PIER_HALF + BODY : innerLip + BODY,
    outerOff: walkOuter - WALL.parapetThickness - BODY,
    garrisonable: true,
  };
}

export function buildWall(heightAt: (x: number, z: number) => number, rngSeed: string): WallBuildOutput {
  const rng = new Rng(rngSeed);
  const path = fitWallPath(heightAt);
  const towerCount = Math.floor(WALL_LENGTH / WALL.towerSpacing) + 1;
  const gateBay = clamp(Math.round((GATE_X - WALL_X_MIN) / WALL.towerSpacing), 1, towerCount - 3);

  const zAt = (x: number): number => {
    if (x <= path[0].x) return path[0].z;
    const last = path[path.length - 1];
    if (x >= last.x) return last.z;
    const span = path[1].x - path[0].x;
    const i = Math.min(path.length - 2, Math.floor((x - path[0].x) / span));
    const t = (x - path[i].x) / (path[i + 1].x - path[i].x);
    return lerp(path[i].z, path[i + 1].z, t);
  };

  // --- bays, and a stepped wall-walk level for each --------------------------
  const nBays = towerCount - 1;
  const need = new Float64Array(nBays);
  /**
   * Highest terrain under each run, on a 1.5 m sample.
   *
   * Deliberately *not* the same seven samples `need` uses. `need` sets the quantised
   * construction level and changing its sampling moves the whole circuit's heights, but
   * the stages that follow the ground rather than a level — a footing's plinth, a gap's
   * rampart — need the real peak, and seven samples over 35.5 m misses it by a metre.
   */
  const gMaxOf = new Float64Array(nBays);
  for (let b = 0; b < nBays; b++) {
    const x0 = WALL_X_MIN + b * WALL.towerSpacing;
    const x1 = x0 + WALL.towerSpacing;
    let gmax = -Infinity;
    for (let s = 0; s <= 6; s++) {
      const x = lerp(x0, x1, s / 6);
      const g = heightAt(x, zAt(x));
      if (g > gmax) gmax = g;
    }
    need[b] = gmax + WALL.height;
    let fine = gmax;
    for (let s = 0; s <= 24; s++) {
      const x = lerp(x0, x1, s / 24);
      const g = heightAt(x, zAt(x));
      if (g > fine) fine = g;
    }
    gMaxOf[b] = fine;
  }
  // Quantise to 0.55 m construction increments, held over pairs of bays: flat runs
  // of ~71 m with a visible step between them.
  const level = new Float64Array(nBays);
  for (let b = 0; b < nBays; b++) {
    const pair = b - (b % 2);
    level[b] = Math.ceil(Math.max(need[pair], need[Math.min(nBays - 1, pair + 1)]) / 0.55) * 0.55;
  }

  const bays: Bay[] = [];
  const segments: WallSegmentOut[] = [];
  const blockers: Blocker[] = [];
  const roughGround: RoughGround[] = [];
  const bayStages: BayStage[] = [];
  const trees: TreeRequest[] = [];
  const garrisonBays: GarrisonBay[] = [];

  for (let b = 0; b < nBays; b++) {
    const x0 = WALL_X_MIN + b * WALL.towerSpacing;
    const x1 = x0 + WALL.towerSpacing;
    const isGate = b === gateBay;
    const stage: BayStage = isGate ? 'finished' : bayStage(b, nBays, gateBay);
    const bay: Bay = {
      index: b,
      x0,
      z0: zAt(x0),
      x1,
      z1: zAt(x1),
      topY: level[b],
      g0: heightAt(x0, zAt(x0)),
      g1: heightAt(x1, zAt(x1)),
      gMax: gMaxOf[b],
      stage,
      isGate,
      dress: true,
    };
    bays.push(bay);
    bayStages.push(stage);
    /*
     * Rise of the work above the ground under it.
     *
     * A footing's is **derived**, not a literal. It was `1.1`, and `unfinishedTopAt` — the
     * function `buildFootingSite` and `masonryTopAt` both answer from — puts the pour at
     * `min(g0,g1) + plinthHeight + 1.0`, which is 2.35 m over the low end of the bay and
     * more where the ground falls away under it. Two numbers for one piece of concrete, in
     * one file, two hundred lines apart, and the smaller one is what every consumer of
     * `getWallSegments()` was being told.
     */
    const footingRise = stage === 'footing' ? worstRiseOf(bay, heightAt) : 0;
    const h = stage === 'footing' ? footingRise
      : stage === 'gap' ? 3.1 : stage === 'half-built' ? 3.4 : WALL.height;
    segments.push({
      x1: bay.x0, z1: bay.z0, x2: bay.x1, z2: bay.z1, height: h,
      gate: isGate,
      rough: stage === 'footing',
      halfThickness: HALF_T,
    });
    /*
     * A bare footing does not *stop* a man; everything else does.
     *
     * It does not follow that it costs him nothing, and for as long as this was the whole
     * story it did: no blocker means no obstacle box, no occupancy cell and no nav stamp,
     * so the pour existed in the geometry and in nothing else. The third state is
     * `roughGround` — published below, standing work that is crossed at a price.
     */
    if (stage !== 'footing') {
      blockers.push({ x1: bay.x0, z1: bay.z0, x2: bay.x1, z2: bay.z1, halfW: HALF_T });
    } else {
      const f0 = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
      roughGround.push({
        bay: b,
        x: (bay.x0 + bay.x1) * 0.5,
        z: (bay.z0 + bay.z1) * 0.5,
        // Along the run and across it. The pour is `CURTAIN_T` wide and the travertine
        // plinth projects `plinthProject` beyond it on both faces, which is the footprint
        // a body actually has to climb over.
        hw: f0.len * 0.5,
        hd: HALF_T + WALL.plinthProject,
        rot: Math.atan2(f0.dz, f0.dx),
        crestY: unfinishedTopAt(stage, Math.min(bay.g0, bay.g1), bay.gMax),
        rise: footingRise,
        stage,
      });
    }

    const f = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
    const walk = walkGeometry(bay);
    // A tower stands at the west end of every bay, and its ballista chamber occupies the
    // walkway there, so the garrison line is broken at each one. The only exception is a
    // west end that falls inside the gatehouse block, which has its own flanking towers.
    //
    // Keyed on where the block *is*, not on which bay is flagged `isGate`. The old rule
    // suppressed the towers at both ends of the gate bay, and the east one — 42.5 m from
    // the gate, in open curtain — was simply missing: the wall east of the Porta Flaminia
    // ended in a bare vertical face with nothing on it.
    const hasTower = !inGateBlock(bay.x0);
    // The lane through this bay's west tower, from the same helper the stone is cut with.
    const lane = towerPassOf(bay, bays[b - 1]);
    garrisonBays.push({
      index: b,
      x0: bay.x0, z0: bay.z0, x1: bay.x1, z1: bay.z1,
      nx: f.nx, nz: f.nz, dx: f.dx, dz: f.dz, length: f.len,
      stage,
      walkY: walk.walkY,
      groundY: Math.min(bay.g0, bay.g1),
      crestY: walk.crestY,
      sillY: walk.sillY,
      parapetInner: walk.parapetInner,
      parapetOuter: walk.parapetOuter,
      innerOff: walk.innerOff,
      outerOff: walk.outerOff,
      // The gate block interrupts this run with monumental masonry whose crown is at its
      // own level, so no rank may be laid across it and the bay stands down as a whole.
      //
      // The 30 m of curtain this fix restored east of the block *is* an ordinary walk and
      // could carry a rank — pushing `towerHalf` past the block is enough to express it,
      // and it was tried. It is deliberately not done: bay 20's walk stands 14.50 m over
      // its own ground, because the construction level is held over the pair 20/21 and
      // bay 21 climbs to 36 m while bay 20's west end is at 28. `probe-siege` requires
      // every bay within five of the gate to be under 14 m so an escalade can reach it,
      // and manning a bay the ladders cannot take is worse than leaving it empty.
      garrisonable: walk.garrisonable && !isGate,
      walkable: walk.garrisonable,
      halfThickness: HALF_T,
      towerHalf: hasTower ? WALL.towerWidth * 0.5 : 0,
      hasTower,
      passOuter: lane ? lane.outer : 0,
      passInner: lane ? lane.inner : 0,
      passLoY: lane ? lane.loY : 0,
      passHiY: lane ? lane.hiY : 0,
      isGate,
    });
  }

  /**
   * Where the garrison actually gets up there.
   *
   * A flight every fourth bay — about one per 142 m of circuit, which is roughly the
   * spacing of the surviving Aurelianic stairs — plus one immediately east of the Porta
   * Flaminia, because a gate is the one place on a circuit that always has its own stair
   * and because that is the bay the assault is aimed at.
   *
   * **Finished bays only.** A stair is the last thing built, not the first: a bay still
   * carrying its scaffold has a timber ramp, not dressed travertine. It also keeps the two
   * apart in the pomerium — the scaffold occupies −3.0..−4.9 and the stair −3.0..−6.2, and
   * they would foul each other on the same bay.
   */
  const stairs: WallStair[] = [];
  for (const bay of bays) {
    if (bay.stage !== 'finished') continue;
    if (bay.index % 4 !== 2 && bay.index !== gateBay + 1) continue;
    // Not into the gatehouse block, which owns its own 25 m of the circuit.
    if (inGateBlock(bay.x0) || inGateBlock(bay.x0 + STAIR_MAX_RUN)) continue;
    const plan = stairPlan(bay, walkGeometry(bay).walkY, heightAt);
    if (plan) stairs.push(plan);
  }
  const stairByBay = new Map<number, WallStair>();
  for (const s of stairs) stairByBay.set(s.bay, s);

  const gateBayRef = bays[gateBay];
  const gFrame = frameOf(gateBayRef.x0, gateBayRef.z0, gateBayRef.x1, gateBayRef.z1);
  const gateCz = lerp(gateBayRef.z0, gateBayRef.z1, (GATE_X - gateBayRef.x0) / WALL.towerSpacing);
  /**
   * **Shut.**
   *
   * It was `open: true`, so the one road into Rome stood wide open with a Germanic host on
   * the plain, the ram in the siege train had nothing to break, and the assault could walk
   * in. The leaves are geometry — see `buildGate` — and this is the flag every consumer
   * reads: `CitySystem.pushWallBox` stops punching the carriageway out of the movement
   * obstacles, and `setGateOpen('porta-flaminia', true)` is what the siege system calls when
   * the ram finally brings them down.
   */
  const gates: GateOut[] = [
    { id: 'porta-flaminia', x: GATE_X, z: gateCz, facing: Math.atan2(gFrame.nx, gFrame.nz), open: false },
  ];
  const gateG = heightAt(GATE_X, gateCz);
  const gateDoor: GateDoorOut = {
    gateId: 'porta-flaminia',
    x: GATE_X + gFrame.nx * (GATE_BLOCK_D * 0.5 - GATE_DOOR_SET),
    y: gateG + GATE_DOOR_SILL,
    z: gateCz + gFrame.nz * (GATE_BLOCK_D * 0.5 - GATE_DOOR_SET),
    nx: gFrame.nx, nz: gFrame.nz, dx: gFrame.dx, dz: gFrame.dz,
    halfWidth: GATE_OPEN_WIDTH * 0.5,
    height: GATE_DOOR_H,
    thickness: GATE_DOOR_T,
    setback: GATE_DOOR_SET,
    open: false,
    broken: false,
  };
  // The gatehouse as a solid, for the consumers that need to know where the masonry is.
  // Held separately from the bays because the block straddles two of them: reading it off
  // `bay.isGate` reported the block over 35.5 m of ground it does not stand on and missed
  // the 12.5 m of it that stands in the bay next door.
  const gateBlock: GateBlockOut = {
    x: GATE_X,
    z: gateCz,
    nx: gFrame.nx, nz: gFrame.nz, dx: gFrame.dx, dz: gFrame.dz,
    halfRun: GATE_BLOCK_W * 0.5,
    halfDepth: GATE_BLOCK_D * 0.5 + 0.45,
    topY: heightAt(GATE_X, gateCz) + GATE_PASS_H + GATE_ATTIC + GATE_MERLON_H,
    // The crown, at the merlons' feet. `buildGate` calls the same expression `blockTop`.
    sillY: heightAt(GATE_X, gateCz) + GATE_PASS_H + GATE_ATTIC,
    // `buildGate` authors the merlon line at local z = `zF + GATE_CREN_INSET`, and modules
    // are authored with −Z outward (see `frameOf`), so its offset along `n` is positive.
    parapetInner: GATE_BLOCK_D * 0.5 - GATE_CREN_INSET - GATE_CREN_T * 0.5,
    parapetOuter: GATE_BLOCK_D * 0.5 - GATE_CREN_INSET + GATE_CREN_T * 0.5,
    crenelledCityward: false,
    merlonLength: GATE_MERLON_W,
    crenelLength: GATE_CRENEL_W,
    openHalf: GATE_OPEN_WIDTH * 0.5,
  };

  // --- chunk the curtain for culling and LOD --------------------------------
  const BAYS_PER_CHUNK = 8;
  const chunks: CityChunkSpec[] = [];
  for (let c = 0; c * BAYS_PER_CHUNK < bays.length; c++) {
    const from = c * BAYS_PER_CHUNK;
    const to = Math.min(bays.length, from + BAYS_PER_CHUNK);
    const slice = bays.slice(from, to);
    const cx = (slice[0].x0 + slice[slice.length - 1].x1) * 0.5;
    const cz = (slice[0].z0 + slice[slice.length - 1].z1) * 0.5;
    const radius = (slice[slice.length - 1].x1 - slice[0].x0) * 0.62 + 46;
    chunks.push({
      name: `wall-${c}`,
      cx,
      cz,
      radius,
      castShadow: true,
      lodSwitch: [340, 940],
      build: (batch, detail) => {
        batch.setUvOrigin(cx, 0, cz);
        const spans: [number, number][] = [];
        for (const bay of slice) {
          // Curtain everywhere the gatehouse is not, *including* across the gate bay.
          // The gate does not replace a bay; it is cut into one.
          curtainSpans(bay.x0, bay.x1, spans);
          for (let i = 0; i < spans.length; i++) {
            const [ax, bx] = spans[i];
            // A sliver shorter than a course band is not worth a panel.
            if (bx - ax < 0.5) continue;
            buildCurtainBay(
              batch, detail, clipBay(bay, ax, bx, i === 0), heightAt,
              rng.fork(i === 0 ? `bay-${bay.index}` : `bay-${bay.index}-${i}`)
            );
          }
          if (bay.isGate) buildGate(batch, detail, bay, heightAt, rng.fork(`gate-${bay.index}`));
          // The flight up onto the walk, against the inner face. Planned once in
          // `buildWall` and looked up here, so the stone and the published `WallStair`
          // cannot disagree about where it is.
          const stair = stairByBay.get(bay.index);
          if (stair) buildWallStair(batch, detail, bay, stair, heightAt);
        }
        // A tower at the west end of every bay, plus the far end of the last chunk.
        // A west end swallowed by the gatehouse gets none: the gate carries its own pair
        // of semicircular towers instead.
        for (const bay of slice) {
          if (inGateBlock(bay.x0)) continue;
          const prev = bays[bay.index - 1];
          const topY = Math.max(bay.topY, prev ? prev.topY : bay.topY);
          buildTower(batch, detail, bay.x0, bay.z0, topY, heightAt, bay.index, bay.stage,
            frameOf(bay.x0, bay.z0, bay.x1, bay.z1), towerPassOf(bay, prev));
        }
        if (to === bays.length) {
          const last = slice[slice.length - 1];
          // The far end of the circuit: a tower with a walk on one side only, so it gets no
          // passage — there is nothing on the other side of it to walk to.
          buildTower(batch, detail, last.x1, last.z1, last.topY, heightAt, bays.length, last.stage, frameOf(last.x0, last.z0, last.x1, last.z1), null);
        }
        if (from === 0) buildRiverTerminus(batch, detail, bays[0], heightAt);
      },
    });
  }

  /**
   * The Porta Flaminia's leaves, as their own chunk so the ram's work shows.
   *
   * One detail level and no shadow: it is under a thousand triangles hanging 2.2 m inside an
   * 11 m barrel vault, so there is nothing for a mid tier to drop and its shadow falls
   * entirely inside the gatehouse's own. `castShadow: false` also keeps it out of
   * `buildShadowProxy`, which would otherwise have baked a copy of the leaves into the
   * gatehouse chunk's merged caster and gone on drawing their shadow after they were hidden.
   *
   * `lodSwitch` at 1e9 is the documented way to ask `bakeChunk` for a single level; the
   * radius covers the 11 m opening and the drawbar's sockets either side of it.
   */
  {
    const gb = gateBayRef;
    chunks.push({
      name: 'gate-door',
      cx: GATE_X,
      cz: gateCz,
      radius: 16,
      castShadow: false,
      lodSwitch: [1e9, 1e9],
      gateDoorFor: gateDoor.gateId,
      build: (batch, detail) => {
        batch.setUvOrigin(GATE_X, 0, gb.z0);
        buildGateLeaves(batch, detail, gb, heightAt);
      },
    });
    // The same leaves in the pose the ram left them. Baked and hidden; `setGateDoorBroken`
    // swaps the two, so the pair costs one chunk's worth of draws whichever is on screen.
    chunks.push({
      name: 'gate-wreck',
      cx: GATE_X,
      cz: gateCz,
      radius: 22,
      castShadow: false,
      lodSwitch: [1e9, 1e9],
      gateWreckFor: gateDoor.gateId,
      build: (batch, detail) => {
        batch.setUvOrigin(GATE_X, 0, gb.z0);
        buildGateLeaves(batch, detail, gb, heightAt, true);
      },
    });
  }

  // Cypress and pine against the inner face — the *pomerium* strip was planted.
  for (let i = 0; i < 220; i++) {
    const x = rng.range(WALL_X_MIN + 30, WALL_X_MAX - 30);
    if (Math.abs(x - GATE_X) < 30) continue;
    trees.push({
      x,
      // Kept clear of the curtain: a 20 m cypress planted three metres from the wall
      // swallows the camera on any close viewpoint.
      z: zAt(x) + rng.range(34, 76),
      kind: rng.bool(0.64) ? 'cypress' : 'pine',
      scale: rng.range(0.78, 1.12),
    });
  }

  return {
    path, chunks, segments, gates, gateBlock, gateDoor, blockers, roughGround, trees,
    towerCount, bayStages, garrisonBays, stairs, wallZAt: zAt,
  };
}

// ---------------------------------------------------------------------------
// Curtain
// ---------------------------------------------------------------------------

/**
 * One face panel of the curtain: a quad at `centreline + n*off`, looking along
 * `n * faceSign`. Split per sub-bay so the base follows the ground.
 */
function facePanel(
  st: GeoStream,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  nx: number,
  nz: number,
  off0: number,
  off1: number,
  y0: number,
  y1: number,
  cLow: THREE.Color,
  cHigh: THREE.Color,
  faceSign: number
): void {
  P0.set(ax + nx * off0, y0, az + nz * off0);
  P1.set(bx + nx * off0, y0, bz + nz * off0);
  P2.set(bx + nx * off1, y1, bz + nz * off1);
  P3.set(ax + nx * off1, y1, az + nz * off1);
  OUT.set(nx * faceSign, 0, nz * faceSign);
  st.quadN(OUT, P0, P1, P2, P3, cLow, cLow, cHigh, cHigh);
}

function buildCurtainBay(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number,
  rng: Rng
): void {
  if (bay.stage === 'gap') {
    buildGapBarricade(batch, detail, bay, heightAt, rng);
    return;
  }

  const brick = batch.s('brick');
  const stone = batch.s('stone');
  const f = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const { nx, nz, dx, dz, len } = f;
  const stage = bay.stage;
  const T = CURTAIN_T;
  const gMin = Math.min(bay.g0, bay.g1);
  const topY = stage === 'half-built' ? Math.max(bay.g0, bay.g1) + 3.4 : bay.topY;
  const subs = detail >= 2 ? 16 : detail === 1 ? 5 : 1;
  const plinthTop = (g: number): number => g + WALL.plinthHeight;

  const brickLow = new THREE.Color().copy(PAL.brick).multiplyScalar(0.68);
  const brickHigh = new THREE.Color().copy(PAL.brickPale).multiplyScalar(1.08);

  // ---- travertine footing, following the ground ----------------------------
  for (let s = 0; s < subs; s++) {
    const t0 = s / subs;
    const t1 = (s + 1) / subs;
    const ax = lerp(bay.x0, bay.x1, t0);
    const az = lerp(bay.z0, bay.z1, t0);
    const bx = lerp(bay.x0, bay.x1, t1);
    const bz = lerp(bay.z0, bay.z1, t1);
    const gA = heightAt(ax, az);
    const gB = heightAt(bx, bz);
    const gm = Math.min(gA, gB);
    const dirty = new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(0.88 + hash2(s, bay.index, 7) * 0.24);
    // Sunk 1.8 m so no gap can open if the heightfield is regenerated under us, and
    // topped from the *higher* end of the sub-bay, not the lower.
    //
    // Taking the top from `gm` meant that wherever the ground climbed more than the
    // 1.35 m plinth across one 2.2 m sub-bay, the course was buried and nothing stood
    // above the turf. On the Tiber bank, where bay 2's footing crosses a knoll, that
    // erased nine metres of the circuit: rays cast across the wall at a metre above the
    // ground came out the other side. A footing follows the slope; it does not drown in it.
    quadPrism(stone, ax, az, bx, bz, nx, nz, T + WALL.plinthProject * 2, gm - 1.8, Math.max(gA, gB) + WALL.plinthHeight, dirty, PAL.travertine, {
      ends: false,
    });
  }

  if (stage === 'footing') {
    buildFootingSite(batch, detail, bay, heightAt, rng);
    return;
  }

  // ---- brick face in bands, with the batter leaning the outer face back ----
  const bandH = WALL.courseBand;
  const outerOff = (y: number, baseY: number): number => T * 0.5 - WALL.batter * Math.max(0, y - baseY);

  for (let s = 0; s < subs; s++) {
    const t0 = s / subs;
    const t1 = (s + 1) / subs;
    const ax = lerp(bay.x0, bay.x1, t0);
    const az = lerp(bay.z0, bay.z1, t0);
    const bx = lerp(bay.x0, bay.x1, t1);
    const bz = lerp(bay.z0, bay.z1, t1);
    const gm = Math.min(heightAt(ax, az), heightAt(bx, bz));
    const y0 = plinthTop(gm);
    if (topY - y0 < 0.25) continue;
    const bands = detail >= 2 ? Math.max(1, Math.round((topY - y0) / bandH)) : 1;

    for (let k = 0; k < bands; k++) {
      const by0 = y0 + ((topY - y0) * k) / bands;
      const by1 = y0 + ((topY - y0) * (k + 1)) / bands;
      // Alternate lifts are set back 45 mm. A single day's work was one lift of
      // facing brick against the poured core, and the setback is what makes the
      // 6.5 m of masonry read as courses rather than as an extruded box.
      const proud = k % 2 === 0 ? 0 : -0.045;
      // Brick came from many kilns and stretches were patched: vary each panel by a
      // low-frequency hash so the face is blotchy at the metre scale, not just the
      // millimetre scale the texture handles.
      // Halved from 0.2.
      //
      // A blind critic separated our frames from Rome II's on exactly this surface, and the
      // strongest thing it named was "a flat diffuse brick tile with visible horizontal UV
      // seams". The missing normal map is in `city/materials.ts` and not this workstream's to
      // add, but the *seams* it read are partly authored here: a per-panel tone drawn from a
      // hash on `floor(s / 3)` steps in value every third sub-bay, which at 16 sub-bays to a
      // 35.5 m run puts a visible vertical join every 6.7 m along the wall and makes adjacent
      // panels look offset. The blotchiness is worth having; this much of it is not.
      const patch = hash2(Math.floor(s / 3), Math.floor(k / 2) + bay.index * 5, 811) * 0.5;
      // Weathering, top to bottom: sun-bleached at the parapet, rain-washed through the
      // middle, and a metre of splash-back dirt at the footing. This is the *only*
      // vertical gradient the face should carry, and it runs over the whole 6.5 m.
      const fLo = (by0 - y0) / Math.max(1, topY - y0);
      const fHi = (by1 - y0) / Math.max(1, topY - y0);
      const weather = (f: number): number =>
        0.72 + 0.30 * Math.min(1, f * 3.4) + 0.12 * f;
      const tone = clamp(0.90 + hash2(s, k * 13 + bay.index, 3) * 0.05 + patch * 0.2, 0.82, 1.10);
      // Per-lift shading is now *slight*. At 1.1 m per lift a strong low-to-high ramp
      // stacks into six pale-and-dark stripes up the wall, and that banding, not the
      // brickwork, becomes what the eye reads — the single worst thing about the first
      // pass of this curtain.
      const cLo = new THREE.Color()
        .copy(k === 0 ? brickLow : PAL.brick)
        .multiplyScalar(tone * weather(fLo) * 0.97);
      const cHi = new THREE.Color()
        .copy(by1 > topY - 1.3 ? brickHigh : PAL.brick)
        .multiplyScalar(tone * weather(fHi) * 1.03);
      facePanel(brick, ax, az, bx, bz, nx, nz, outerOff(by0, y0) + proud, outerOff(by1, y0) + proud, by0, by1, cLo, cHi, 1);
      facePanel(brick, ax, az, bx, bz, nx, nz, -T * 0.5, -T * 0.5, by0, by1, cLo, cHi, -1);
    }
  }

  // Tile string courses: bands of *bipedales* projecting 60 mm — the bonding courses
  // that tie the brick face into the concrete core, and the wall's strongest rhythm.
  if (detail >= 1) {
    const y0 = plinthTop(gMin);
    // Bonding courses at every second lift, not every one: at 1.1 m spacing the face
    // reads as a striped fence rather than as brickwork.
    const nBands = Math.max(1, Math.round((topY - y0) / bandH));
    for (let k = 2; k < nBands; k += 2) {
      const y = y0 + ((topY - y0) * k) / nBands;
      quadPrism(brick, bay.x0, bay.z0, bay.x1, bay.z1, nx, nz, T + 0.17, y - 0.11, y, PAL.tileCourse, PAL.brickDark, {
        ends: false,
      });
    }
  }

  // A projecting dado two courses above the footing: standard practice, and it
  // stops the base of the wall reading as a knife edge against the ground.
  if (detail >= 1) {
    const dy = plinthTop(gMin) + 0.34;
    quadPrism(brick, bay.x0, bay.z0, bay.x1, bay.z1, nx, nz, T + 0.44, dy - 0.2, dy, PAL.brickDark, PAL.travertine, { ends: false });
  }

  // Blind arched recesses in the inner face. The Aurelianic builders saved material
  // and mortar this way, and the arcading is the strongest thing you see looking
  // along the inside of the curtain.
  if (detail >= 1 && topY - plinthTop(gMin) > 4.4) {
    const nArch = Math.max(3, Math.round(len / WALL.innerArchSpacing));
    const aw = len / nArch;
    for (let i = 0; i < nArch; i++) {
      const t = (i + 0.5) / nArch;
      // 6 mm proud of the inner face, not flush with it.
      //
      // `archPanel` draws its own solid field around the opening, and at `T * 0.5` exactly
      // that field is coplanar with the curtain's inner face quad. Two coplanar surfaces
      // z-fight, and the arcading — the strongest thing you see looking along the inside of
      // the wall — dissolved into checkerboard stipple at every distance. A reviewer given
      // only the renders named it the most repeated blemish on the circuit.
      const px = lerp(bay.x0, bay.x1, t) - nx * (T * 0.5 + 0.006);
      const pz = lerp(bay.z0, bay.z1, t) - nz * (T * 0.5 + 0.006);
      const gA = heightAt(px, pz);
      const y0 = plinthTop(gA) + 0.5;
      const h = topY - 0.9 - y0;
      if (h < 3.2) continue;
      brick.push(new THREE.Matrix4().makeRotationY(f.rotY + Math.PI).setPosition(px, y0, pz));
      archPanel(brick, aw + 0.02, h, PAL.brick, {
        depth: 0.55,
        spring: h - aw * 0.42,
        openWidth: aw * 0.74,
        segments: detail >= 2 ? 8 : 5,
        voidCol: new THREE.Color().copy(PAL.brickDark).multiplyScalar(0.5),
      });
      // Back of the recess, 0.55 m in — a blind arch, not a hole through the wall.
      box(brick, -aw * 0.4, 0, 0.55, aw * 0.4, h - aw * 0.42 + aw * 0.37, 0.66, new THREE.Color().copy(PAL.brick).multiplyScalar(0.6), {
        zMin: false,
      });
      brick.pop();
    }
  }

  // Weep holes just under the wall-walk, draining the rubble core.
  if (detail >= 2) {
    const dark = new THREE.Color(0.03, 0.026, 0.021);
    for (let i = 0; i < 9; i++) {
      const t = (i + 0.5) / 9;
      const px = lerp(bay.x0, bay.x1, t) + nx * (outerOff(topY - 0.7, plinthTop(gMin)) - 0.04);
      const pz = lerp(bay.z0, bay.z1, t) + nz * (outerOff(topY - 0.7, plinthTop(gMin)) - 0.04);
      quadPrism(brick, px - dx * 0.13, pz - dz * 0.13, px + dx * 0.13, pz + dz * 0.13, nx, nz, 0.2, topY - 0.9, topY - 0.68, dark, dark, {
        ends: false,
      });
    }
  }

  // Putlog holes: the sockets the scaffold poles left, on the 1.1 m lift grid.
  // Drawn as small dark prisms sitting a hair proud of the face rather than modelled
  // recesses — beyond a few metres the read is identical for a fraction of the
  // triangles, and there are several thousand of them round the circuit.
  if (detail >= 2) {
    const y0 = plinthTop(gMin);
    const dark = new THREE.Color(0.022, 0.02, 0.017);
    const nLifts = Math.max(1, Math.floor((topY - y0 - 1.2) / (bandH * 2)));
    for (let k = 0; k < nLifts; k++) {
      const y = y0 + 1.0 + k * bandH * 2;
      for (let s = 0; s < 12; s++) {
        // Keyed on the *column* alone, not on the lift.
        //
        // Putlogs stack vertically because the standards they socketed into are vertical, so
        // a socket that is open on one lift is open on all of them. Culling per hole instead
        // scattered them to random heights and random spacings, and a reviewer reported the
        // right feature with the wrong logic: "it reads as noise instead of as evidence of
        // the scaffold you have literally modelled 50 m away."
        if (hash2(s, bay.index, 41) < 0.42) continue;
        const t = (s + 0.5) / 12;
        const px = lerp(bay.x0, bay.x1, t) + nx * (outerOff(y, y0) - 0.06);
        const pz = lerp(bay.z0, bay.z1, t) + nz * (outerOff(y, y0) - 0.06);
        quadPrism(brick, px - dx * 0.1, pz - dz * 0.1, px + dx * 0.1, pz + dz * 0.1, nx, nz, 0.22, y, y + 0.2, dark, dark, {
          ends: false,
        });
      }
    }
  }

  // ---- wall-walk ----------------------------------------------------------
  const walkOuter = outerOff(topY, plinthTop(gMin));
  // The wall-walk is a working surface: trodden, dusty and much darker than the
  // dressed travertine it is made of.
  //
  // Its top is 30 mm below `topY` so the paving below can sit on it without z-fighting;
  // `walkY` is `topY`, the paving's surface, which is what a man's feet rest on.
  quadPrism(
    stone,
    bay.x0,
    bay.z0,
    bay.x1,
    bay.z1,
    nx,
    nz,
    T - 0.05,
    topY - 0.24,
    stage === 'half-built' ? topY : topY - 0.03,
    PAL.travertineDirty,
    new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(0.86),
    { ends: false }
  );

  /**
   * Paving on the walk.
   *
   * Six metres of bare quad is a runway. At the old 3.5 m the walk was mostly parapet and
   * merlon shadow and one flat surface was enough; widened, it is the largest unbroken
   * plane anywhere on the circuit and it reads as untextured ground from any camera above
   * it. Rome II's own walk — `reference/siege/army-on-walls.jpg` — is laid in big irregular
   * flags, and that paving is most of what makes the surface read as masonry a man is
   * standing on rather than as a ribbon.
   *
   * Emitted as top quads only, over a substrate 30 mm lower, so the 25 mm joints are the
   * darker stone showing through. Two triangles per flag, full detail only.
   */
  if (detail >= 2 && stage !== 'half-built') {
    const across = 3;
    const along = Math.max(1, Math.round(len / 2.1));
    const halfW = (T - 0.05) * 0.5;
    for (let a = 0; a < along; a++) {
      for (let c = 0; c < across; c++) {
        const ta = (a + 0.0) / along;
        const tb = (a + 1.0) / along;
        // 25 mm joint on every edge.
        const o0 = -halfW + ((2 * halfW * c) / across) + 0.025;
        const o1 = -halfW + ((2 * halfW * (c + 1)) / across) - 0.025;
        const ax = lerp(bay.x0, bay.x1, ta);
        const az = lerp(bay.z0, bay.z1, ta);
        const bx = lerp(bay.x0, bay.x1, tb);
        const bz = lerp(bay.z0, bay.z1, tb);
        const jx = dx * 0.025;
        const jz = dz * 0.025;
        const flag = new THREE.Color()
          .copy(PAL.travertineDirty)
          .multiplyScalar(0.9 + hash2(a, c + bay.index * 3, 137) * 0.26);
        P0.set(ax + jx + nx * o0, topY, az + jz + nz * o0);
        P1.set(bx - jx + nx * o0, topY, bz - jz + nz * o0);
        P2.set(bx - jx + nx * o1, topY, bz - jz + nz * o1);
        P3.set(ax + jx + nx * o1, topY, az + jz + nz * o1);
        OUT.set(0, 1, 0);
        stone.quadN(OUT, P0, P1, P2, P3, flag);
      }
    }
  }

  if (stage === 'half-built') {
    // Exposed rubble core on top of the unfinished lift.
    const core = batch.s('concrete');
    quadPrism(core, bay.x0, bay.z0, bay.x1, bay.z1, nx, nz, T - 0.55, topY - 0.06, topY + 0.3, PAL.concrete, PAL.mortar, {
      ends: false,
    });
    if (bay.dress) {
      buildScaffold(batch, detail, bay, heightAt, topY, rng);
      buildYard(batch, detail, bay, heightAt, rng);
    }
    return;
  }

  // ---- parapet -------------------------------------------------------------
  if (stage !== 'no-parapet') {
    const pT = WALL.parapetThickness;
    const lipOff = walkOuter - pT * 0.5;
    const px0 = bay.x0 + nx * lipOff;
    const pz0 = bay.z0 + nz * lipOff;
    const px1 = bay.x1 + nx * lipOff;
    const pz1 = bay.z1 + nz * lipOff;
    // Sill, then merlons on top of it. The merlons carry their own travertine cap —
    // a continuous coping over the whole run turns the battlements into a dentil
    // frieze and the wall stops reading as defensible.
    quadPrism(brick, px0, pz0, px1, pz1, nx, nz, pT, topY, topY + 0.6, PAL.brick, PAL.travertine, { ends: false });
    crenellation(brick, px0, pz0, px1, pz1, topY + 0.6, WALL.parapetHeight - 0.6, pT, PAL.brick, 1.7, 0.95, detail >= 1);
  } else {
    // Parapet not raised yet: dressed merlon blocks stacked on the walk, waiting.
    for (let s = 0; s < 5; s++) {
      const t = 0.12 + s * 0.19;
      const px = lerp(bay.x0, bay.x1, t) + nx * (walkOuter - 1.1);
      const pz = lerp(bay.z0, bay.z1, t) + nz * (walkOuter - 1.1);
      const rows = 1 + Math.floor(hash2(s, bay.index, 5) * 3);
      for (let r = 0; r < rows; r++) {
        quadPrism(
          stone,
          px - dx * 0.7,
          pz - dz * 0.7,
          px + dx * 0.7,
          pz + dz * 0.7,
          nx,
          nz,
          0.8,
          topY + r * 0.42,
          topY + (r + 1) * 0.42 - 0.03,
          PAL.travertine,
          PAL.travertine
        );
      }
    }
    if (bay.dress) {
      buildScaffold(batch, detail, bay, heightAt, topY, rng);
      buildYard(batch, detail, bay, heightAt, rng);
    }
  }

  /**
   * Covered gallery on some finished stretches — a *porticus* along the **cityward edge**
   * of the walk, not a roof over the whole of it.
   *
   * Strictly Honorian rather than Aurelianic; the brief asks for it and it gives the
   * silhouette a rhythm the bare curtain lacks. What it must not do is hide the thing the
   * player asked to see. Its eaves used to land on the parapet's outer lip, 0.25 m above
   * the crest, so from any camera outside the wall the tiles began flush behind the merlon
   * line and roofed the crenels: a critic shown the render reported "the wall-walk is
   * effectively zero width and the legionaries are clipped into the parapet" on the one
   * frame that happened to catch a galleried bay. On a 3.5 m curtain that was merely wrong;
   * on 6.0 m it hides the entire gain, because the roof got 2.5 m wider with the wall.
   *
   * So the penthouse now covers the rear 2.3 m and stops 0.6 m short of the centreline,
   * leaving 2.5 m of walk open to the sky in front of it — the front two ranks shoot from
   * an open parapet, the reserve stands in shade, and from outside you read merlons, men,
   * open walk, then a roof set well back behind them. That is also the only arrangement in
   * which a defender can shoot over his own battlement, which the old one prevented.
   */
  if (stage === 'finished' && detail >= 1 && bay.index % 5 === 1) {
    const roofSt = batch.s('roof');
    const piers = 8;
    // `GALLERY_PIER_OFF`, not a local constant: `walkGeometry` pulls the rear rank's
    // cityward limit clear of these piers, and when the two were derived separately the
    // rear rank stood inside the colonnade. One number, both places.
    const innerOff = GALLERY_PIER_OFF;
    /** Eaves offset: 0.6 m cityward of the bay centreline, well behind the parapet. */
    const eaveOff = -0.6;
    const eaveY = topY + 2.5;
    const ridgeOff = innerOff - 0.55;
    const ridgeY = topY + 3.4;
    // Pier tops meet the roof plane where it crosses them, so the colonnade carries the
    // penthouse instead of standing under it with a gap.
    const pierTop = eaveY + (ridgeY - eaveY) * ((eaveOff - innerOff) / (eaveOff - ridgeOff));
    for (let s = 0; s <= piers; s++) {
      const t = s / piers;
      const px = lerp(bay.x0, bay.x1, t) + nx * innerOff;
      const pz = lerp(bay.z0, bay.z1, t) + nz * innerOff;
      quadPrism(brick, px - dx * 0.3, pz - dz * 0.3, px + dx * 0.3, pz + dz * 0.3, nx, nz, 0.6, topY, pierTop, PAL.brick, PAL.travertine);
    }
    P0.set(bay.x0 + nx * eaveOff, eaveY, bay.z0 + nz * eaveOff);
    P1.set(bay.x1 + nx * eaveOff, eaveY, bay.z1 + nz * eaveOff);
    P2.set(bay.x1 + nx * ridgeOff, ridgeY, bay.z1 + nz * ridgeOff);
    P3.set(bay.x0 + nx * ridgeOff, ridgeY, bay.z0 + nz * ridgeOff);
    OUT.set(nx * 0.4, 1, nz * 0.4).normalize();
    roofSt.quadN(OUT, P0, P1, P2, P3, PAL.roofTile, PAL.roofTile, PAL.roofTileOld, PAL.roofTileOld);
  }
}

// ---------------------------------------------------------------------------
// Towers
// ---------------------------------------------------------------------------

/**
 * The lane through one tower, in the tower's own local frame.
 *
 * Local `-Z` is outward (see `frameOf`), so an offset along the outward normal maps to
 * `-offset` and the fieldward jamb is the *lower* local z. Returned as `null` where the bay
 * published no lane — a west end inside the gate block, or a neighbour with no walk on it.
 */
function localLane(pass: TowerPassOut | null): { z0: number; z1: number } | null {
  if (!pass || pass.outer - pass.inner < MIN_LANE) return null;
  return { z0: -pass.outer, z1: -pass.inner };
}

function buildTower(
  batch: Batch,
  detail: number,
  x: number,
  z: number,
  topY: number,
  heightAt: (x: number, z: number) => number,
  index: number,
  stage: BayStage,
  f: Frame,
  pass: TowerPassOut | null
): void {
  const brick = batch.s('brick');
  const stone = batch.s('stone');
  const roof = batch.s('roof');
  const g = heightAt(x, z);
  const W = WALL.towerWidth;
  const T = CURTAIN_T;
  const proj = WALL.towerProject;
  // Modules are authored with −Z outward; `f.rotY` turns that onto the wall run.
  const m = new THREE.Matrix4().makeRotationY(f.rotY).setPosition(x, 0, z);
  // Through `pushAll`, which resolves material aliases: at far detail all three of these
  // are the same stream, and pushing per key composed the placement matrix three times —
  // towers scattered to roughly 3x their position. See `Batch.distinct`.
  const used = batch.pushAll(TOWER_KEYS, m);

  const zOuter = -(T * 0.5 + proj);
  const zInner = T * 0.5;
  const unfinished = stage === 'footing' || stage === 'gap';
  const bodyTop = unfinished ? g + 2.7 : topY;
  const lane = unfinished ? null : localLane(pass);
  const bat = WALL.batter * 0.6;

  box(stone, -W / 2 - 0.32, g - 2.0, zOuter - 0.32, W / 2 + 0.32, g + WALL.plinthHeight, zInner + 0.32, PAL.travertineDirty, {
    topGain: 1.1,
  });
  /**
   * The body, with the passage cut out of it.
   *
   * The tower's floor is its own body top at `topY`, which is the *higher* of the two bays'
   * construction levels — so where the walk steps, the low side meets solid brick and the
   * chamber's doorway is that step above his head. Cutting the slot in the body is what
   * lets the low side in at all; the flight below carries him up to the floor.
   *
   * Split rather than punched: `box` batters by insetting the top face, so the piece above
   * the sill starts at the inset the piece below it ended on and the two faces are flush.
   */
  if (!lane || pass!.loY >= bodyTop - 0.05) {
    box(brick, -W / 2, g + WALL.plinthHeight, zOuter, W / 2, bodyTop, zInner, PAL.brick, {
      batter: bat, groundShade: 0.3, topGain: 1.05,
    });
  } else {
    const sill = Math.max(g + WALL.plinthHeight + 0.1, pass!.loY);
    box(brick, -W / 2, g + WALL.plinthHeight, zOuter, W / 2, sill, zInner, PAL.brick, {
      batter: bat, groundShade: 0.3, topGain: 1.05,
    });
    const in0 = bat * (sill - (g + WALL.plinthHeight));
    // Field side of the lane, and city side of it. Both run up to the floor.
    box(brick, -W / 2 + in0, sill, zOuter + in0, W / 2 - in0, bodyTop, lane.z0, PAL.brick,
      { groundShade: 0.3, topGain: 1.05 });
    box(brick, -W / 2 + in0, sill, lane.z1, W / 2 - in0, bodyTop, zInner - in0, PAL.brick,
      { groundShade: 0.3, topGain: 1.05 });
  }

  if (detail >= 2 && !unfinished) {
    // Travertine quoins up each outer corner: the strongest single cue that this is
    // dressed masonry and not a box.
    for (const sx of [-1, 1]) {
      const cx = (sx * W) / 2;
      const n = Math.floor((bodyTop - g - WALL.plinthHeight) / 0.62);
      for (let k = 0; k < n; k += 2) {
        const y = g + WALL.plinthHeight + k * 0.62;
        box(stone, cx - (sx > 0 ? 0.66 : 0.05), y, zOuter - 0.05, cx + (sx > 0 ? 0.05 : 0.66), y + 0.55, zOuter + 0.5, PAL.travertine, {
          zMax: false,
        });
      }
    }
    /*
     * String courses, cut around the passage.
     *
     * They wrap the tower's whole depth, and on a finished joint that is free — the body
     * stops at the walk, so every band is under a man's feet. Where the two bays are still
     * half-built the tower is up to its full height and the walk is on a 3.4 m lift, so the
     * bands cross the doorway at 0.9 m intervals: four of Rome's forty-two passes measured
     * 0.00 m of lane with the blocking triangle 0.10 to 0.22 m over the walk, which is a
     * 90 mm band and nothing else.
     */
    const nb = Math.max(1, Math.round((bodyTop - g - WALL.plinthHeight) / WALL.courseBand));
    const voidLo = lane ? pass!.loY - 0.15 : Infinity;
    const voidHi = lane ? Math.max(pass!.hiY, topY) + TOWER_PASS_HEAD + 0.15 : -Infinity;
    for (let k = 1; k < nb; k++) {
      const y = g + WALL.plinthHeight + ((bodyTop - g - WALL.plinthHeight) * k) / nb;
      if (lane && y > voidLo && y - 0.09 < voidHi) {
        box(brick, -W / 2 - 0.08, y - 0.09, zOuter - 0.08, W / 2 + 0.08, y, lane.z0, PAL.brickDark, { topGain: 1.22 });
        box(brick, -W / 2 - 0.08, y - 0.09, lane.z1, W / 2 + 0.08, y, zInner + 0.08, PAL.brickDark, { topGain: 1.22 });
        continue;
      }
      box(brick, -W / 2 - 0.08, y - 0.09, zOuter - 0.08, W / 2 + 0.08, y, zInner + 0.08, PAL.brickDark, { topGain: 1.22 });
    }
  }

  if (unfinished) {
    batch.popAll(used);
    return;
  }

  // ---- ballista chamber ---------------------------------------------------
  const chH = WALL.towerChamberHeight;
  const chTop = topY + chH;
  const inset = TOWER_CH_INSET;
  const wallT = TOWER_CH_WALL;
  // Projecting cornice at the wall-walk line. Without it the chamber looks like a
  // smaller box balanced on a bigger one instead of a storey of the same tower.
  box(stone, -W / 2 - 0.34, topY - 0.42, zOuter - 0.34, W / 2 + 0.34, topY, zInner + 0.34, PAL.travertine, { topGain: 1.2 });
  const cx0 = -W / 2 + inset;
  const cx1 = W / 2 - inset;
  const cz0 = zOuter + inset;
  const cz1 = zInner - inset;
  const chTone = (k: number): THREE.Color =>
    new THREE.Color().copy(PAL.brick).multiplyScalar(0.82 + hash2(index, k, 331) * 0.34);
  /**
   * The chamber's two side walls, pierced on the line of the wall-walk.
   *
   * They used to be solid, so the walk ran into 0.75 m of blank brick at every one of
   * forty-eight towers — a reviewer reading only the frames called it a dead end, and it
   * is: the only way in was a doorway on the *city* face, which a man walking the parapet
   * cannot reach. A chamber astride the walk has to be walked through.
   *
   * **The opening was then authored as a constant, and the constant went stale.**
   * `-0.35 .. +1.35` is 1.7 m, which was the clear band of a 3.5 m curtain; the curtain has
   * been 6.0 m for two workstreams and the walk is 4.0 m wide, so the door had become a
   * 1.7 m slot offset to the field side of a lane nobody used. It comes off `towerLane`
   * now, which is the same call the bay publishes to the siege system, so the hole and the
   * path through it cannot drift apart again.
   *
   * Its head is `TOWER_PASS_HEAD` over the *higher* of the two walks, not over `topY`,
   * because on a stepped joint the tower's floor and the low side's walk are different
   * levels and a man crossing has to clear both.
   */
  const doorOuter = lane ? lane.z0 : -0.35;
  const doorInner = lane ? lane.z1 : 1.35;
  const doorHead = (lane ? Math.max(pass!.hiY, topY) : topY) + TOWER_PASS_HEAD;
  // Chamber paving, with the lane taken out of it so the flight below can come up through.
  if (lane) {
    box(stone, cx0, topY - 0.12, cz0, cx1, topY, doorOuter, PAL.travertineDirty, { topGain: 1.06 });
    box(stone, cx0, topY - 0.12, doorInner, cx1, topY, cz1, PAL.travertineDirty, { topGain: 1.06 });
  } else {
    box(stone, cx0, topY - 0.12, cz0, cx1, topY, cz1, PAL.travertineDirty, { topGain: 1.06 });
  }
  for (const sx of [-1, 1]) {
    const a = sx < 0 ? cx0 : cx1 - wallT;
    const b = sx < 0 ? cx0 + wallT : cx1;
    const tone = chTone(sx < 0 ? 1 : 2);
    if (detail < 1) {
      box(brick, a, topY, cz0, b, chTop, cz1, tone, { topGain: 1.1, groundShade: 0.14 });
      continue;
    }
    box(brick, a, topY, cz0, b, chTop, doorOuter, tone, { topGain: 1.1, groundShade: 0.14 });
    box(brick, a, topY, doorInner, b, chTop, cz1, tone, { topGain: 1.1, groundShade: 0.14 });
    if (doorHead < chTop) {
      box(brick, a, doorHead, doorOuter, b, chTop, doorInner, tone, { topGain: 1.1, groundShade: 0.14 });
      // Travertine lintel over the opening, so the head reads as dressed rather than sawn.
      box(stone, a - 0.06, doorHead - 0.22, doorOuter - 0.06, b + 0.06, doorHead, doorInner + 0.06, PAL.travertine, {
        topGain: 1.16,
      });
    }
  }
  box(brick, cx0 + wallT, topY, cz1 - wallT, cx1 - wallT, chTop, cz1, chTone(3), { topGain: 1.1, groundShade: 0.14 });
  /**
   * The passage floor, and the flight that carries it over the construction step.
   *
   * The chamber's own paving is laid at `topY` and the low side arrives at `pass.loY`, so
   * without this a man walking in from the low side steps into a hole. Treads at the wall
   * stair's own 0.31 rise where the tower is wide enough for them, and a plain ramp where
   * it is not — Rome's worst walkable joint steps 7.70 m across a 7.6 m tower, which is
   * 45 degrees and is a tower stair rather than a flight, but it is stone under his feet.
   */
  if (lane) {
    const loY = pass!.loY;
    const hiY = Math.max(pass!.hiY, topY);
    const rise = hiY - loY;
    const treads = rise < 0.06 ? 1 : Math.min(26, Math.max(1, Math.ceil(rise / 0.31)));
    // Local +X runs from `x0` toward `x1` — east — so a flight climbing away from a low
    // west neighbour advances in +X. Signed, because the same arithmetic run the wrong way
    // builds a staircase descending into the wall it is meant to climb out of, and this
    // project has shipped exactly that mistake twice.
    const east = pass!.loIsWest ? 1 : -1;
    const going = Math.min(0.34, (W + 0.6) / treads);
    for (let k = 0; k < treads; k++) {
      const y = loY + (rise * (k + 1)) / treads;
      const cut = k * going;
      const a = east > 0 ? -W / 2 - 0.3 + cut : -W / 2 - 0.3;
      const b = east > 0 ? W / 2 + 0.3 : W / 2 + 0.3 - cut;
      box(stone, a, loY - 0.35, doorOuter, b, y, doorInner, PAL.travertineDirty, {
        topGain: 1.08, bottom: false,
      });
    }
  }

  // Front wall pierced by the ballista embrasure.
  brick.pushTranslate(0, topY, cz0);
  archPanel(brick, cx1 - cx0, chH, PAL.brick, {
    depth: wallT,
    spring: 1.5,
    openWidth: Math.min(2.5, (cx1 - cx0) * 0.5),
    segments: detail >= 2 ? 9 : 5,
    archivolt: detail >= 2 ? 0.13 : 0,
  });
  brick.pop();

  if (detail >= 1) {
    /**
     * Side loopholes covering the curtain either way.
     *
     * Set in the *solid* part of the jamb, on the field side of the doorway. They used to
     * be centred on the chamber's own axis at `z = 0`, which is inside the passage: the
     * head ray through the lane hit them at 1.5 m and the tower had 1.4 m of clear
     * headroom over a walk a man is 1.75 m tall on. A loophole is a slot in a wall and the
     * wall it is in is the one either side of the door.
     */
    const dark = new THREE.Color(0.016, 0.015, 0.013);
    const slotZ = lane ? (cz0 + wallT + lane.z0) * 0.5 : 0;
    const room = lane ? lane.z0 - (cz0 + wallT) : 1.0;
    if (room > 0.9) {
      for (const sx of [-1, 1]) {
        const px = sx * (W / 2 - inset - wallT * 0.5);
        box(brick, px - 0.13, topY + 1.4, slotZ - 0.4, px + 0.13, topY + 2.9, slotZ + 0.4, dark, { top: false });
      }
    }
  }

  /**
   * Tiled hip roof: the chamber was covered, because the ballista needed cover.
   *
   * **Translated onto the chamber's own centre first.** `hipRoof` builds symmetrically
   * about the local origin, and the chamber is not centred there: it runs from `cz0` on the
   * field side to `cz1` on the city side, whose midpoint is 1.75 m cityward of the tower's
   * placement point. Emitted at the origin, the roof overhung the back of the tower by
   * 1.75 m and left the same depth of the front wall standing in the open with sky above
   * it. A critic reading the renders called this out as a 43% overhang and it was dismissed
   * by measuring the tower's *width*, which was never the axis at fault; widening the
   * curtain to 6 m only moves the error, so it is fixed rather than re-measured.
   */
  roof.pushTranslate(0, 0, (cz0 + cz1) * 0.5);
  hipRoof(roof, W - inset * 2 + 0.9, cz1 - cz0 + 0.9, chTop, WALL.towerRoofHeight, 0.45, PAL.roofTileOld);
  roof.pop();
  box(brick, cx0 - 0.4, chTop - 0.2, cz0 - 0.4, cx1 + 0.4, chTop, cz1 + 0.4, PAL.brickDark, { top: false });

  // Doorway from the wall-walk into the chamber, on the city side.
  brick.pushTranslate(0, topY, cz1 - wallT);
  archPanel(brick, cx1 - cx0 - wallT * 2, chH, PAL.brick, { depth: wallT, spring: 1.45, openWidth: 1.15, segments: detail >= 2 ? 7 : 4 });
  brick.pop();

  // The stair down to the ground is no longer built here. It used to run *out of the
  // tower's city face, perpendicular to the wall*, projecting into the pomerium — which
  // is not how a Roman wall stair works and is the second thing the player called out.
  // See `buildWallStair`: the flight now climbs along the inner face, parallel to it.

  batch.popAll(used);
}

/** Every stream `buildTower` touches. See `Batch.distinct`. */
const TOWER_KEYS: readonly CityMatKey[] = ['brick', 'stone', 'roof'];

// ---------------------------------------------------------------------------
// Gate — the Porta Flaminia, on the axis of the Via Flaminia
// ---------------------------------------------------------------------------

/** Every stream `buildGate` touches. See `Batch.distinct`. */
const GATE_KEYS: readonly CityMatKey[] = ['brick', 'stone', 'metal', 'timber', 'roof', 'road'];

function buildGate(batch: Batch, detail: number, bay: Bay, heightAt: (x: number, z: number) => number, rng: Rng): void {
  const brick = batch.s('brick');
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const timber = batch.s('timber');
  const roof = batch.s('roof');
  const road = batch.s('road');

  const f = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const cx = GATE_X;
  const cz = lerp(bay.z0, bay.z1, (GATE_X - bay.x0) / WALL.towerSpacing);
  const g = heightAt(cx, cz);

  // The approach: built in world space before the gate's own frame is pushed, so the
  // carriageway can follow the ground. Everything the camera sees in the foreground of
  // the standard `city` viewpoint lives here, and without it that frame is half grass.
  buildGateApproach(batch, detail, cx, cz, f, heightAt, rng);

  const m = new THREE.Matrix4().makeRotationY(f.rotY).setPosition(cx, 0, cz);
  // See `Batch.distinct`: at mid detail these six keys are three streams and at far detail
  // one, so pushing per key put the whole 25 x 11 m gate block at `m^3` and `m^6`.
  const used = batch.pushAll(GATE_KEYS, m);

  // 11 m of masonry front to back so the passage is a real tunnel, and an attic
  // above the arch for the dedicatory inscription. The curtain is cut back to leave this
  // span clear — see `GATE_BLOCK_W` and `curtainSpans`.
  const blockW = GATE_BLOCK_W;
  const blockD = GATE_BLOCK_D;
  const passH = GATE_PASS_H;
  const attic = GATE_ATTIC;
  const blockTop = g + passH + attic;
  const zF = -blockD * 0.5;

  // Travertine socle, in two piers with the carriageway between them.
  //
  // It used to be one box across the whole 25 m, which put 1.15 m of solid stone across
  // the passage: the brick face starts at `g + 1.15` and the socle filled everything
  // below it, so the one road into Rome had a chest-high step in it, 3.4 m behind the
  // doors where no camera could see it. A ray down the centreline at 0.5 m struck it.
  const socleHalf = blockW / 2 + 0.45;
  const openHalf = GATE_OPEN_WIDTH * 0.5;
  for (const s of [-1, 1]) {
    box(stone, s > 0 ? openHalf : -socleHalf, g - 2.4, zF - 0.45, s > 0 ? socleHalf : -openHalf, g + 1.15, blockD * 0.5 + 0.45, PAL.travertineDirty, {
      topGain: 1.08,
    });
  }
  // A threshold slab in the opening: a real gate has one, worn into ruts, and it caps the
  // ground under the tunnel so the terrain cannot show through the basalt.
  box(stone, -openHalf, g - 2.4, zF - 0.45, openHalf, g + 0.12, blockD * 0.5 + 0.45, PAL.travertineDirty, {
    topGain: 1.14,
  });

  brick.pushTranslate(0, g + 1.15, zF);
  archPanel(brick, blockW, passH + attic - 1.15, PAL.brick, {
    depth: blockD,
    spring: 4.3,
    openWidth: GATE_OPEN_WIDTH,
    segments: detail >= 2 ? 16 : 8,
    backFace: true,
    archivolt: detail >= 1 ? 0.4 : 0,
    voidCol: new THREE.Color(0.028, 0.026, 0.022),
  });
  brick.pop();

  /**
   * End walls closing the block.
   *
   * `archPanel` builds a front face, a back face and the reveals between them — it has no
   * end caps, so the 25 x 11 m gate block was a shell open along both of its 11 m ends.
   * The curtain only covers 3.5 m of that, which left roughly 4 m of full-height daylight
   * either side of it: from an oblique camera east or west of the gate you looked straight
   * in one end of the gatehouse and out of the other. The cornice caps the top and the
   * socle the bottom, so only the storey between them needs closing.
   */
  for (const s of [-1, 1]) {
    const ex = (s * blockW) / 2;
    box(brick, Math.min(ex, ex - s * 0.09), g + 1.15, zF, Math.max(ex, ex - s * 0.09), blockTop, blockD * 0.5, PAL.brick, {
      groundShade: 0.18,
      topGain: 1.04,
    });
  }

  // Travertine voussoirs framing the arch. The gate was dressed in stone even where
  // the curtain is bare brick, because it is the face the city shows the world.
  if (detail >= 1) {
    const r = GATE_OPEN_WIDTH * 0.5;
    const spring = g + 1.15 + 4.3;
    const nV = 13;
    const midR = r + 0.32;
    for (let i = 0; i < nV; i++) {
      const a0 = Math.PI - (Math.PI * i) / nV;
      const a1 = Math.PI - (Math.PI * (i + 1)) / nV;
      const am = (a0 + a1) * 0.5;
      const halfArc = ((Math.PI / nV) * midR) / 2;
      const tx = -Math.sin(am);
      const ty = Math.cos(am);
      const vx = Math.cos(am) * midR;
      const vy = spring + Math.sin(am) * midR;
      const c = new THREE.Color().copy(PAL.travertine).multiplyScalar(0.92 + hash2(i, 3, 11) * 0.17);
      P0.set(vx - tx * halfArc, vy - ty * halfArc, zF - 0.5);
      P1.set(vx + tx * halfArc, vy + ty * halfArc, zF - 0.5);
      P2.set(P1.x + Math.cos(am) * 0.66, P1.y + Math.sin(am) * 0.66, zF - 0.5);
      P3.set(P0.x + Math.cos(am) * 0.66, P0.y + Math.sin(am) * 0.66, zF - 0.5);
      OUT.set(0, 0, -1);
      stone.quadN(OUT, P0, P1, P2, P3, c);
      OUT.set(Math.cos(am), Math.sin(am), 0);
      P0.set(P3.x, P3.y, zF - 0.5);
      P1.set(P2.x, P2.y, zF - 0.5);
      P2.set(P1.x, P1.y, zF);
      P3.set(P0.x, P0.y, zF);
      stone.quadN(OUT, P0, P1, P2, P3, new THREE.Color().copy(c).multiplyScalar(0.78));
    }
  }

  // ---- inscribed attic ----------------------------------------------------
  const insY = g + passH + 1.0;
  box(stone, -7.6, insY, zF - 0.58, 7.6, insY + 2.8, zF, PAL.marble, { topGain: 1.1 });
  box(stone, -8.1, insY - 0.38, zF - 0.76, 8.1, insY, zF, PAL.travertine, { topGain: 1.2 });
  box(stone, -8.1, insY + 2.8, zF - 0.76, 8.1, insY + 3.2, zF, PAL.travertine, { topGain: 1.2 });
  if (detail >= 1) {
    // The inscription: gilt-bronze letters set into cut beds. Modelled as rows of
    // small raised blocks — legible as lettering at 60 m, which is all that matters.
    for (let line = 0; line < 3; line++) {
      const y = insY + 2.05 - line * 0.78;
      let px = -6.6 - hash2(line, 1, 5) * 0.35;
      while (px < 6.3) {
        const w = 0.22 + hash2(Math.round(px * 10), line, 9) * 0.2;
        box(metal, px, y, zF - 0.65, px + w, y + 0.46, zF - 0.58, PAL.gilt, { zMax: false });
        px += w + 0.15 + hash2(Math.round(px * 7), line + 3, 13) * 0.12;
      }
    }
  }

  // ---- crowning cornice and battlements -----------------------------------
  box(stone, -blockW / 2 - 0.65, blockTop - 0.55, zF - 0.65, blockW / 2 + 0.65, blockTop, blockD * 0.5 + 0.65, PAL.travertine, {
    topGain: 1.18,
  });
  crenellation(
    brick, -blockW / 2, zF + GATE_CREN_INSET, blockW / 2, zF + GATE_CREN_INSET,
    blockTop, GATE_MERLON_H, GATE_CREN_T, PAL.brick, GATE_MERLON_W, GATE_CRENEL_W, detail >= 1,
  );

  // ---- flanking semicircular towers ---------------------------------------
  // Aurelian's major gates were flanked by semicircular towers rising well above the
  // curtain; the Porta Flaminia's survive inside the later Porta del Popolo.
  // Slender enough to read as towers rather than chimneys: 9.2 m across, 18.6 tall.
  const towerR = 4.6;
  const towerX = GATE_OPEN_WIDTH * 0.5 + towerR + 1.9;
  const towerTop = g + 18.6;
  const seg = detail >= 2 ? 16 : detail === 1 ? 10 : 6;
  for (const s of [-1, 1]) {
    const tx = s * towerX;
    const tz = zF + 0.5;
    cylinder(stone, tx, g - 2.0, tz, towerR + 0.78, towerR + 0.52, 3.3, seg, PAL.travertineDirty, { arcFrom: Math.PI, arcTo: Math.PI * 2 });
    cylinder(brick, tx, g + 1.3, tz, towerR + 0.52, towerR * 0.94, towerTop - g - 1.3, seg, PAL.brick, {
      arcFrom: Math.PI,
      arcTo: Math.PI * 2,
      shadeLow: 0.26,
    });
    // Flat chord closing the back of the semicircle, buried in the gate block.
    box(brick, tx - towerR - 0.6, g - 2.0, tz - 0.12, tx + towerR + 0.6, towerTop, tz, PAL.brick, { zMin: false });
    // The drum tapers, so a string course has to be sized from the radius at its own
    // height or it disappears inside the brickwork.
    const drumR = (y: number): number => {
      const t = clamp((y - (g + 1.3)) / (towerTop - g - 1.3), 0, 1);
      return towerR + 0.52 + (towerR * 0.94 - towerR - 0.52) * t;
    };
    if (detail >= 1) {
      const nb = Math.round((towerTop - g - 1.3) / WALL.courseBand);
      for (let k = 1; k < nb; k++) {
        const y = g + 1.3 + ((towerTop - g - 1.3) * k) / nb;
        const rr = drumR(y) + 0.16;
        // `bottom` as well as `top`: these project 0.16 m past the drum and an open
        // underside is the same daylight sliver the cornice had, thirty times over.
        cylinder(brick, tx, y - 0.14, tz, rr, rr, 0.14, seg, PAL.tileCourse, {
          arcFrom: Math.PI,
          arcTo: Math.PI * 2,
          top: true,
          bottom: true,
        });
      }
      // Arched windows lighting the tower chambers. Set 0.3 m proud of the drum so the
      // curvature cannot swallow a flat panel, which reads as a stone surround.
      for (let lv = 0; lv < 2; lv++) {
        const wy = g + 6.6 + lv * 5.1;
        brick.pushTranslate(tx, wy, tz - drumR(wy) - 0.3);
        archPanel(brick, 2.5, 3.9, PAL.brick, {
          depth: 1.2,
          spring: 1.6,
          openWidth: 1.2,
          segments: detail >= 2 ? 8 : 5,
          archivolt: detail >= 2 ? 0.14 : 0,
          voidCol: new THREE.Color(0.018, 0.016, 0.013),
        });
        brick.pop();
      }
    }
    /**
     * Crowning cornice, splayed out of the drum rather than perched on it.
     *
     * The ring alone was 1.08 R over a drum that tapers to 0.94 R, and `cylinder` emits no
     * bottom face unless asked: 0.65 m of open annulus with the sky behind it, all the way
     * round. From any low camera outside the gate it read as a crack straight through the
     * tower, right under the battlement. The cavetto closes the soffit.
     */
    cylinder(stone, tx, towerTop - 0.28, tz, towerR * 0.94, towerR * 1.08, 0.28, seg, PAL.travertine, {
      arcFrom: Math.PI,
      arcTo: Math.PI * 2,
    });
    cylinder(stone, tx, towerTop, tz, towerR * 1.08, towerR * 1.08, 0.6, seg, PAL.travertine, {
      arcFrom: Math.PI,
      arcTo: Math.PI * 2,
      top: true,
    });
    const nm = detail >= 1 ? 9 : 5;
    for (let k = 0; k < nm; k++) {
      const a = Math.PI + (Math.PI * (k + 0.5)) / nm;
      const ax = tx + Math.cos(a) * towerR;
      const az = tz + Math.sin(a) * towerR;
      const tg = a + Math.PI * 0.5;
      quadPrism(
        brick,
        ax - Math.cos(tg) * 0.72,
        az - Math.sin(tg) * 0.72,
        ax + Math.cos(tg) * 0.72,
        az + Math.sin(tg) * 0.72,
        Math.cos(a),
        Math.sin(a),
        0.85,
        towerTop + 0.6,
        towerTop + 2.2,
        PAL.brick,
        PAL.travertine
      );
    }
  }

  // ---- portcullis, doors, carriageway -------------------------------------
  /**
   * The *cataracta*, hanging raised in its slot 0.85 m inside the outer face.
   *
   * Left raised on purpose now that the leaves below are shut. It is the second line, not
   * the first: you drop it when the doors fail, and dropping it now would put a curtain of
   * iron bars in front of the thing the player asked to see shut. It also gives the siege
   * system somewhere to go after the ram wins — the geometry is already here.
   */
  const barTop = g + passH - 0.15;
  const barBottom = g + passH - 3.1;
  for (let i = 0; i <= 12; i++) {
    const bx = -GATE_OPEN_WIDTH * 0.5 + (GATE_OPEN_WIDTH * i) / 12;
    box(metal, bx - 0.05, barBottom, zF + 0.85, bx + 0.05, barTop, zF + 0.98, PAL.iron);
  }
  for (let k = 0; k < 3; k++) {
    const y = barBottom + k * 1.35;
    box(metal, -GATE_OPEN_WIDTH * 0.5, y, zF + 0.83, GATE_OPEN_WIDTH * 0.5, y + 0.12, zF + 1.0, PAL.iron);
  }
  box(metal, -GATE_OPEN_WIDTH * 0.5, barBottom - 0.38, zF + 0.82, GATE_OPEN_WIDTH * 0.5, barBottom, zF + 1.01, PAL.iron);

  const doorZ = zF + GATE_DOOR_SET;
  const leafHalf = GATE_OPEN_WIDTH * 0.5;
  const headY = g + GATE_SPRING;

  /**
   * The lunette over the doors, filled in brick.
   *
   * The leaves are rectangular and stop at the springing, so without this there is a 4.3 m
   * semicircular hole above them and the gate is shut only as far as a man's head. Emitted
   * as vertical columns whose tops are taken from the arc at each column's **inner** edge,
   * so every column rises to or above the intrados and the fill can never leave a gap
   * against it; the surplus is buried in the arch's own masonry.
   */
  {
    const cols = detail >= 2 ? 14 : detail === 1 ? 8 : 4;
    const r = leafHalf;
    for (let j = 0; j < cols; j++) {
      const a = -r + (2 * r * j) / cols;
      const b = -r + (2 * r * (j + 1)) / cols;
      const inner = Math.min(Math.abs(a), Math.abs(b));
      const h = Math.sqrt(Math.max(0, r * r - inner * inner));
      box(brick, a, headY - 0.05, doorZ - 0.26, b, headY + h, doorZ + 0.26, new THREE.Color().copy(PAL.brick).multiplyScalar(0.86 + hash2(j, 5, 23) * 0.2));
    }
  }

  // Polygonal basalt carriageway, rutted by two centuries of carts.
  box(road, -GATE_OPEN_WIDTH * 0.5 - 0.6, g + 0.02, zF - 0.5, GATE_OPEN_WIDTH * 0.5 + 0.6, g + 0.1, blockD * 0.5 + 18, PAL.basalt);

  // Guardhouse lean-to inside the gate.
  if (detail >= 1) {
    const gx = 13.5;
    const gz = 10.5;
    const gg = heightAt(cx + gx * Math.cos(f.rotY), cz + gz) - g;
    const guard = batch.pushAllTranslate(GUARD_KEYS, gx, gg, gz);
    box(brick, -4.2, g, -3.1, 4.2, g + 3.3, 3.1, PAL.ochreDeep, { groundShade: 0.2 });
    hipRoof(roof, 9.2, 7.1, g + 3.3, 1.6, 0.45, PAL.roofTileOld);
    batch.popAll(guard);
  }

  batch.popAll(used);
}

/** Guardhouse walls and roof; one stream at far detail. See `Batch.distinct`. */
const GUARD_KEYS: readonly CityMatKey[] = ['brick', 'roof'];

/** The two streams the leaves and their ironwork land in. See `Batch.distinct`. */
const GATE_DOOR_KEYS: readonly CityMatKey[] = ['timber', 'metal'];

/**
 * The twin leaves, **shut and barred** — and in their own chunk, so they can stop being.
 *
 * They used to be swung flat back against the reveals, which is the fourth thing the
 * player reported: "The main gate door is open by default. it should be closed. It should
 * have to be battered down by the battering ram." A gate standing open is not a gate, and
 * an open gate makes the whole siege train decorative — the ram had nothing to break and
 * the assault could walk up the Via Flaminia into the city.
 *
 * Built shut in the door plane rather than as two swung boxes: the leaves meet on the
 * centreline, close down onto the threshold slab and up to the springing of the vault, and
 * the semicircular lunette above them is filled in brick. Nothing can see through.
 *
 * **Why this is not part of `buildGate`.** The *state* lives in `GateDoorOut` and
 * `GateOut.open`, and the published comment has always said the siege system "swings or
 * wrecks these by hiding this geometry and drawing its own" — but the leaves were merged
 * into the gatehouse's own timber and metal streams and there was nothing separable to
 * hide. `setGateOpen` re-cut the raster and the boxes and the doors stayed drawn, so a ram
 * could land twenty-six blows, open the gate and let men through the arch while the player
 * watched two leaves that never moved. They are their own `CityChunkSpec` now, tagged
 * `gateDoorFor`, and `CitySystem.setGateDoorBroken(id)` takes them off the screen.
 *
 * The lunette stays with the gatehouse. It is brick fill above the springing and a ram
 * that breaks the doors has not taken the arch down with them.
 *
 * **`wrecked` builds the same leaves in the pose the ram left them**, into a second chunk
 * tagged `gateWreckFor`. One function and one set of constants for both states, because two
 * would drift: a wreck authored from remembered dimensions is how you get splinters that do
 * not line up with the jambs the doors hung in. See `WRECK` for what the pose is and why
 * hiding the leaves alone is not enough.
 */
function buildGateLeaves(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number,
  wrecked = false
): void {
  const metal = batch.s('metal');
  const timber = batch.s('timber');
  const f = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const cx = GATE_X;
  const cz = lerp(bay.z0, bay.z1, (GATE_X - bay.x0) / WALL.towerSpacing);
  const g = heightAt(cx, cz);
  const zF = -GATE_BLOCK_D * 0.5;
  const used = batch.pushAll(GATE_DOOR_KEYS, new THREE.Matrix4().makeRotationY(f.rotY).setPosition(cx, 0, cz));

  const doorZ = zF + GATE_DOOR_SET;
  const leafHalf = GATE_OPEN_WIDTH * 0.5;
  const sillY = g + GATE_DOOR_SILL;
  const headY = g + GATE_SPRING;
  const planks = detail >= 2 ? 11 : detail === 1 ? 6 : 1;
  /**
   * The meeting stile: a 45 mm shadow gap on the centreline.
   *
   * Two leaves built hard against each other are one slab. A reviewer shown the shut gate
   * said exactly that — "the plank field runs continuously with no vertical joint anywhere;
   * as rendered this is one slab" — and the centre joint is the single cue that says *twin
   * leaves* at any distance. The gap is a real void down the middle, closed behind by the
   * rebate below so nothing can see through it.
   */
  const MEET = 0.045;
  for (const s of [-1, 1]) {
    /**
     * The wrecked pose, as a transform around the intact leaf.
     *
     * `s = -1` is still on its harr-post: swung `WRECK.swing` into the passage, canted off
     * plumb because the upper pintle has torn out, and with its head beaten away. `s = +1`
     * came off altogether and lies face-up across the carriageway inside the arch. Both are
     * hinged **inward**, which is the only way a ram can drive them; local `+z` is the city
     * side here, the same convention the guardhouse and the carriageway are placed in.
     *
     * A rotation about the hinge, not a hand-placed box: the hinge line is
     * `GateDoorOut.halfWidth` and the sill is `GATE_DOOR_SILL`, so the wreck stands in the
     * same jambs the doors hung in and cannot drift from them. Composed as
     * `T(hinge)·R·T(-hinge)` and pushed onto both streams, so every plank, strap, boss and
     * brace of the intact leaf comes along without being re-authored.
     */
    const hingeX = s * leafHalf;
    let posed: GeoStream[] | null = null;
    if (wrecked) {
      const m = new THREE.Matrix4();
      if (s < 0) {
        m.makeTranslation(hingeX, sillY, doorZ)
          .multiply(new THREE.Matrix4().makeRotationY(s * WRECK.swing))
          .multiply(new THREE.Matrix4().makeRotationX(WRECK.cant))
          .multiply(new THREE.Matrix4().makeTranslation(-hingeX, -sillY, -doorZ));
      } else {
        m.makeTranslation(hingeX * WRECK.slide, g + WRECK.lie, doorZ + WRECK.shove)
          .multiply(new THREE.Matrix4().makeRotationY(WRECK.yaw))
          .multiply(new THREE.Matrix4().makeRotationX(WRECK.flat))
          .multiply(new THREE.Matrix4().makeTranslation(-hingeX, -sillY, -doorZ));
      }
      posed = batch.pushAll(GATE_DOOR_KEYS, m);
    }
    /**
     * How much of each plank column survives, and why the head goes first.
     *
     * A ram strikes the meeting stile, so the loss is greatest on the centreline and tapers
     * to the hanging stile, which is braced against the jamb — which is also what leaves the
     * unmistakable silhouette of a broken gate: a ragged V bitten out of the middle, not a
     * clean rectangle of missing door. `j` counts outward from the centre, so the profile is
     * a straight function of it, hashed a little so no two columns break level.
     */
    const survives = (j: number): number =>
      !wrecked
        ? 1
        : Math.min(1, (s < 0 ? 0.26 : 0.5) + (0.5 * j) / planks + hash2(j, s + 3, 71) * 0.16);
    const topAt = (j: number): number => sillY + (headY - sillY) * survives(j);
    /** The hanging stile: the tallest thing still standing on this leaf. */
    const leafTop = topAt(planks - 1);
    /** Inner edge of the first column still standing at height `y`, for clipping a strap. */
    const standingFrom = (y: number): number => {
      for (let j = 0; j < planks; j++) {
        if (topAt(j) >= y) return s * (MEET + ((leafHalf - MEET) * j) / planks);
      }
      return s * leafHalf;
    };
    /**
     * Vertical oak boarding.
     *
     * Vertical is not a detail. Roman gate leaves — and effectively all pre-modern ones —
     * are vertically planked onto horizontal ledges, because horizontal boards put every
     * plank in bending across the full width of the leaf with nothing to hang them from. The
     * planks are stepped 20 mm proud and shy of each other in turn, which is what puts a
     * vertical shadow line between them: without it the timber material's own horizontal
     * grain wins and the leaf reads as horizontal boarding, which is how the first pass was
     * described.
     */
    for (let j = 0; j < planks; j++) {
      const a = MEET + ((leafHalf - MEET) * j) / planks;
      const b = MEET + ((leafHalf - MEET) * (j + 1)) / planks;
      const jut = planks > 1 ? (j % 2 === 0 ? 0.02 : -0.014) + (hash2(j, s + 1, 17) - 0.5) * 0.01 : 0;
      /**
       * Weathered oak, not the dark timber the rest of the site is built from.
       *
       * The leaves hang 2.2 m inside an 11 m barrel vault with no bounce light in the engine,
       * so at `timberDark` they render as a black rectangle and a reviewer reported the ram's
       * target — the most important object on the map for a siege — as simply invisible. Oak
       * that has stood in the weather on the north face of a city gate for a century is
       * silver-grey, not brown, so the brighter value is also the truer one; it is what lets
       * the boarding and the meeting stile read at all in that shadow.
       */
      const tone = 1.02 + hash2(j, s + 7, 53) * 0.34;
      box(
        timber,
        Math.min(s * a, s * b), sillY, doorZ - GATE_DOOR_T * 0.5 - jut,
        Math.max(s * a, s * b), topAt(j), doorZ + GATE_DOOR_T * 0.5 + jut,
        new THREE.Color().copy(PAL.timber).multiplyScalar(tone)
      );
    }
    // The rebate the leaf shuts against, one plank thickness behind the meeting stile, so
    // the shadow gap is a joint between two doors and not a slot through the gate.
    box(
      timber,
      Math.min(0, s * (MEET + 0.06)), sillY, doorZ + GATE_DOOR_T * 0.5 - 0.02,
      Math.max(0, s * (MEET + 0.06)), topAt(0), doorZ + GATE_DOOR_T * 0.5 + 0.07,
      new THREE.Color().copy(PAL.timber).multiplyScalar(0.62)
    );
    if (detail >= 1) {
      // Iron straps across the boarding, and the pintle band at the hinge stile. A strap
      // whose boarding has gone is clipped back to the first column still under it, so the
      // ironwork ends where the timber does instead of hanging in the gap.
      for (let k = 0; k < 4; k++) {
        const y = sillY + 0.62 + k * 1.24;
        if (y + 0.15 > leafTop) continue;
        const inner = standingFrom(y + 0.15);
        box(metal, Math.min(inner, s * leafHalf), y, doorZ - GATE_DOOR_T * 0.5 - 0.05, Math.max(inner, s * leafHalf), y + 0.15, doorZ + GATE_DOOR_T * 0.5 + 0.05, PAL.iron);
      }
      const hx = s * leafHalf;
      box(metal, Math.min(hx, hx - s * 0.26), sillY, doorZ - GATE_DOOR_T * 0.5 - 0.06, Math.max(hx, hx - s * 0.26), leafTop, doorZ + GATE_DOOR_T * 0.5 + 0.06, PAL.iron);
      /**
       * Pintles, and the harr-post they turn on.
       *
       * A Roman leaf does not hang on hinges in the mediaeval sense: its hanging stile runs
       * down past the sill as a *harr*-post and turns in a socket cut in the threshold, with
       * iron collars strapping it to the jamb. That socket is the detail that reads as "this
       * is a gate that swings" rather than a panel dropped into a hole, and its absence was
       * the first thing named about the closure.
       */
      // Upper pintle first: on a wrecked leaf it is the collar that tore out of the jamb and
      // let the leaf drop, so it is the one piece of ironwork that must *not* still be there.
      for (const hy of wrecked ? [sillY + 0.55] : [sillY + 0.55, headY - 0.75]) {
        box(metal, Math.min(hx, hx + s * 0.3), hy, doorZ - 0.2, Math.max(hx, hx + s * 0.3), hy + 0.26, doorZ + 0.2, PAL.iron);
      }
      // The harr-post itself, and its bronze-lined socket worn into the threshold slab.
      box(timber, Math.min(hx, hx - s * 0.2), sillY - 0.14, doorZ - 0.17, Math.max(hx, hx - s * 0.2), leafTop, doorZ + 0.17, PAL.timberDark);
      box(metal, hx - 0.24, sillY - 0.02, doorZ - 0.24, hx + 0.24, sillY + 0.06, doorZ + 0.24, PAL.bronze);
      // Diagonal ledge-brace on the city face, rising from the hanging stile. Cut short with
      // the boarding it braces: a brace running up through nothing reads as a bug.
      const braceTop = Math.min(headY - 0.8, leafTop - 0.25);
      if (braceTop > sillY + 0.8) {
        const reach = (braceTop - (sillY + 0.5)) / Math.max(1e-3, headY - 0.8 - (sillY + 0.5));
        strut(
          timber,
          P0.set(hx - s * 0.18, sillY + 0.5, doorZ + GATE_DOOR_T * 0.5 + 0.06),
          P1.set(lerp(hx - s * 0.18, s * MEET, reach), braceTop, doorZ + GATE_DOOR_T * 0.5 + 0.06),
          0.075,
          PAL.timber,
          4
        );
      }
    }
    if (detail >= 2) {
      // Bosses: square-headed nails on the strap crossings.
      for (let k = 0; k < 4; k++) {
        for (let j = 0; j < 3; j++) {
          const bx = s * (0.45 + j * 0.72);
          const y = sillY + 0.62 + k * 1.24;
          if (y + 0.21 > topAt(Math.min(planks - 1, Math.floor(((Math.abs(bx) - MEET) * planks) / (leafHalf - MEET))))) continue;
          box(metal, bx - 0.06, y - 0.06, doorZ - GATE_DOOR_T * 0.5 - 0.11, bx + 0.06, y + 0.21, doorZ - GATE_DOOR_T * 0.5 - 0.05, PAL.iron);
        }
      }
    }
    if (posed) batch.popAll(posed);
  }
  /**
   * The drawbar: one oak baulk across both leaves, dropped into sockets cut in the piers.
   * This is what actually holds a gate, and what a ram has to snap — so on the wrecked pose
   * it is snapped, in two pieces on the paving with the iron collars still on them. Nothing
   * else in the frame says "this was barred and the bar gave way".
   */
  if (!wrecked) {
    box(timber, -leafHalf - 0.55, g + 2.35, doorZ + GATE_DOOR_T * 0.5, leafHalf + 0.55, g + 2.68, doorZ + GATE_DOOR_T * 0.5 + 0.3, PAL.timber);
    if (detail >= 1) {
      for (const s of [-1, 1]) {
        box(metal, s * leafHalf * 0.62 - 0.08, g + 2.3, doorZ + GATE_DOOR_T * 0.5 - 0.03, s * leafHalf * 0.62 + 0.08, g + 2.73, doorZ + GATE_DOOR_T * 0.5 + 0.35, PAL.iron);
      }
    }
  } else {
    for (const s of [-1, 1]) {
      const yaw = s * 0.42 + WRECK.yaw * 0.5;
      const bm = new THREE.Matrix4()
        .makeTranslation(s * leafHalf * 0.5, g + 0.28, doorZ + 1.5 + s * 0.9)
        .multiply(new THREE.Matrix4().makeRotationY(yaw))
        .multiply(new THREE.Matrix4().makeRotationZ(s * 0.06));
      const bs = batch.pushAll(GATE_DOOR_KEYS, bm);
      const half = leafHalf * 0.55 + 0.3;
      // Split square across the bar, then torn back along the grain on one side, which is
      // how a baulk in bending actually fails.
      box(timber, -half, -0.165, -0.15, half, 0.165, 0.15, PAL.timber);
      box(timber, half - 0.02, -0.06, -0.11, half + 0.44 + s * 0.2, 0.05, 0.02, PAL.timber);
      if (detail >= 1) {
        box(metal, -0.08, -0.19, -0.19, 0.08, 0.19, 0.19, PAL.iron);
      }
      batch.popAll(bs);
    }
    /**
     * Splinters and plank ends, scattered **through** the arch and not just behind it.
     *
     * The leaves hang 2.2 m inside an 11 m barrel vault, so anything modelled at the door
     * plane is behind a stone reveal and in shadow: from the field the broken gate and the
     * merely open gate photograph as the same dark rectangle. The player watches the ram from
     * outside, so the wreck has to reach outside — the run below straddles the outer face at
     * local z −5.5 and puts timber on the apron of the Via Flaminia, which is also where a
     * ram striking a leaf's outer face throws it.
     */
    for (let k = 0; k < 10; k++) {
      const hx0 = hash2(k, 3, 91);
      const hz0 = hash2(k, 8, 37);
      const ha = hash2(k, 12, 61);
      const px = (hx0 - 0.5) * GATE_OPEN_WIDTH * 1.45;
      const pz = doorZ - 5.2 + hz0 * 11.0;
      const sm = new THREE.Matrix4()
        .makeTranslation(px, g + 0.12, pz)
        .multiply(new THREE.Matrix4().makeRotationY(ha * Math.PI))
        .multiply(new THREE.Matrix4().makeRotationZ((ha - 0.5) * 0.3));
      const ss = batch.pushAll(GATE_DOOR_KEYS, sm);
      const ln = 0.5 + ha * 1.5;
      box(timber, -ln, -0.055, -0.11, ln, 0.055, 0.11, new THREE.Color().copy(PAL.timber).multiplyScalar(0.9 + hz0 * 0.3));
      batch.popAll(ss);
    }
  }
  batch.popAll(used);
}

/**
 * The pose the ram leaves the leaves in, and the reason the wreck is modelled at all.
 *
 * Hiding the doors on a breach is one line and it is not enough: an empty archway with the
 * portcullis still raised behind it is what an *opened* gate looks like, and the player has
 * just watched a ram spend two minutes on it. What says "broken" is timber that is still
 * there and is in the wrong place — one leaf hanging skewed off its harr-post with its head
 * beaten in, the other down across the carriageway, and the drawbar snapped.
 *
 * Angles in radians, distances in metres, all applied about the leaf's own hinge line so the
 * wreck stands in the jambs the intact doors hung in. Local `+z` is the city side.
 */
const WRECK = {
  /** Swing of the surviving leaf into the passage. 41 deg: enough to read at battle range. */
  swing: 0.72,
  /** Cant off plumb, the upper collar having torn out of the jamb. */
  cant: 0.085,
  /** Tip of the fallen leaf: 84 deg, so it lies on the paving with its head slightly raised. */
  flat: 1.466,
  /** Skew of the fallen leaf across the carriageway. */
  yaw: -0.31,
  /** How far its foot slid off the hinge line, as a fraction of the half-width. */
  slide: 0.62,
  /** How far in from the door plane it came to rest. */
  shove: 0.85,
  /** Height of its foot above the ground under the gate. */
  lie: 0.19,
} as const;

/**
 * The ground outside the Porta Flaminia: the paved apron of the Via Flaminia widening
 * into the gate, the material yard where stone and timber came off the carts for the
 * new wall, and a pair of wayside monuments. Historically the approach to a Roman gate
 * was the busiest ground in the suburbs, and it is also the whole foreground of the
 * standard establishing viewpoint.
 */
function buildGateApproach(
  batch: Batch,
  detail: number,
  cx: number,
  cz: number,
  f: Frame,
  heightAt: (x: number, z: number) => number,
  rng: Rng
): void {
  const road = batch.s('road');
  const stone = batch.s('stone');
  const timber = batch.s('timber');
  const { nx, nz, dx, dz } = f;

  // Apron: a straight run of polygonal basalt from the gate out to z ≈ 258, splayed so
  // it funnels into the carriageway. Emitted as terrain-following strips.
  const from = 7;
  const to = 175;
  const strips = detail >= 1 ? 44 : 12;
  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const pD = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < strips; i++) {
    const t0 = from + ((to - from) * i) / strips;
    const t1 = from + ((to - from) * (i + 1)) / strips;
    // Splay from 5.5 m at the gate to 11 m at the far end.
    // Splayed at the gate, then settling to a consular carriageway of 4.6 m.
    const w0 = lerp(3.1, 2.35, Math.min(1, ((t0 - from) / 34) ** 0.7));
    const w1 = lerp(3.1, 2.35, Math.min(1, ((t1 - from) / 34) ** 0.7));
    const ax = cx + nx * t0;
    const az = cz + nz * t0;
    const bx = cx + nx * t1;
    const bz = cz + nz * t1;
    pA.set(ax - dx * w0, heightAt(ax - dx * w0, az - dz * w0) + 0.09, az - dz * w0);
    pB.set(bx - dx * w1, heightAt(bx - dx * w1, bz - dz * w1) + 0.09, bz - dz * w1);
    pC.set(bx + dx * w1, heightAt(bx + dx * w1, bz + dz * w1) + 0.09, bz + dz * w1);
    pD.set(ax + dx * w0, heightAt(ax + dx * w0, az + dz * w0) + 0.09, az + dz * w0);
    col.copy(PAL.basalt).multiplyScalar(0.82 + hash2(i, 3, 55) * 0.4);
    UPV.set(0, 1, 0);
    road.quadN(UPV, pA, pB, pC, pD, col);
    // Cart ruts polished into the setts down the centre of the carriageway.
    if (detail >= 2) {
      for (const side of [-1, 1]) {
        const o = side * 0.72;
        pA.set(ax + dx * (o - 0.16), heightAt(ax, az) + 0.1, az + dz * (o - 0.16));
        pB.set(bx + dx * (o - 0.16), heightAt(bx, bz) + 0.1, bz + dz * (o - 0.16));
        pC.set(bx + dx * (o + 0.16), heightAt(bx, bz) + 0.1, bz + dz * (o + 0.16));
        pD.set(ax + dx * (o + 0.16), heightAt(ax, az) + 0.1, az + dz * (o + 0.16));
        road.quadN(UPV, pA, pB, pC, pD, new THREE.Color().copy(PAL.basalt).multiplyScalar(1.45));
      }
    }
  }

  // Material yard: travertine and tufa off the carts, waiting to go through the gate.
  for (let i = 0; i < (detail >= 1 ? 9 : 3); i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const along = rng.range(14, 58);
    const off = side * rng.range(9, 26);
    const px = cx + nx * along + dx * off;
    const pz = cz + nz * along + dz * off;
    const g = heightAt(px, pz);
    const cols = 2 + rng.int(0, 2);
    const rows = 1 + rng.int(0, 3);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols - (r > 1 ? 1 : 0); c++) {
        const ox = (c - (cols - 1) * 0.5) * 1.3;
        const bx = px + dx * ox;
        const bz = pz + dz * ox;
        const tone = 0.6 + hash2(i * 5 + c, r, 71) * 0.5;
        const cc = new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(tone);
        quadPrism(stone, bx - dx * 0.6, bz - dz * 0.6, bx + dx * 0.6, bz + dz * 0.6, nx, nz, 0.62, g + r * 0.62, g + (r + 1) * 0.62 - 0.02, cc, cc);
      }
    }
  }
  // Timber baulks and a stack of scaffold poles.
  if (detail >= 1) {
    for (let i = 0; i < 3; i++) {
      const along = rng.range(16, 52);
      const off = (i % 2 === 0 ? -1 : 1) * rng.range(12, 24);
      const px = cx + nx * along + dx * off;
      const pz = cz + nz * along + dz * off;
      const g = heightAt(px, pz);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          cylinderBetween(
            timber,
            px + nx * (c - 1) * 0.34 - dx * 3.0,
            g + 0.17 + r * 0.32,
            pz + nz * (c - 1) * 0.34 - dz * 3.0,
            px + nx * (c - 1) * 0.34 + dx * 3.0,
            g + 0.17 + r * 0.32,
            pz + nz * (c - 1) * 0.34 + dz * 3.0,
            0.15,
            PAL.timber
          );
        }
      }
    }
  }
  // Kerbstones down both sides of the carriageway.
  if (detail >= 1) {
    for (let i = 0; i < strips; i++) {
      const t0 = from + ((to - from) * i) / strips;
      const t1 = from + ((to - from) * (i + 1)) / strips;
      const w0 = lerp(3.1, 2.35, Math.min(1, ((t0 - from) / 34) ** 0.7));
      const w1 = lerp(3.1, 2.35, Math.min(1, ((t1 - from) / 34) ** 0.7));
      for (const side of [-1, 1]) {
        const ax = cx + nx * t0 + dx * side * w0;
        const az = cz + nz * t0 + dz * side * w0;
        const bx = cx + nx * t1 + dx * side * w1;
        const bz = cz + nz * t1 + dz * side * w1;
        const gk = Math.min(heightAt(ax, az), heightAt(bx, bz));
        quadPrism(stone, ax, az, bx, bz, dx * side, dz * side, 0.34, gk - 0.2, gk + 0.24, PAL.peperino, PAL.travertineDirty, {
          ends: false,
        });
      }
    }
  }

  // Wayside honorific columns either side of the road, 40 m out.
  for (const side of [-1, 1]) {
    const px = cx + nx * 40 + dx * side * 8.5;
    const pz = cz + nz * 40 + dz * side * 8.5;
    const g = heightAt(px, pz);
    box(stone, px - 1.1, g - 0.4, pz - 1.1, px + 1.1, g + 1.5, pz + 1.1, PAL.travertineDirty, { topGain: 1.12 });
    column(stone, px, g + 1.5, pz, 0.42, 6.2, 'corinthian', PAL.travertine, detail);
    if (detail >= 1) statue(batch.s('metal'), px, g + 7.8, pz, 2.9, PAL.bronze, Math.PI + side * 0.4, detail >= 2 ? 8 : 5);
  }
}

const UPV = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Construction site dressing
// ---------------------------------------------------------------------------

/**
 * Where the circuit meets the Tiber.
 *
 * The Aurelian Wall did not run masonry into the river: it ended in a round tower on
 * the bank, with a *posterula* — a small postern for the towpath — beside it. A round
 * plan resists undermining by the current far better than a square one, which is why
 * every Roman river terminus is round.
 */
function buildRiverTerminus(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number
): void {
  const brick = batch.s('brick');
  const stone = batch.s('stone');
  const roof = batch.s('roof');
  const f = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const g = heightAt(bay.x0, bay.z0);
  const R = 7.6;
  const top = Math.max(bay.topY, g + 6.5) + 5.6;
  const seg = detail >= 2 ? 22 : detail === 1 ? 13 : 7;
  const cx = bay.x0 - f.dx * 2.5;
  const cz = bay.z0 - f.dz * 2.5;

  // Battered travertine footing carried well below the flood line.
  cylinder(stone, cx, g - 4.5, cz, R + 1.5, R + 0.7, 5.4, seg, PAL.travertineDirty, { shadeLow: 0.28 });
  cylinder(brick, cx, g + 0.9, cz, R + 0.7, R * 0.92, top - g - 0.9, seg, PAL.brick, { shadeLow: 0.3 });
  if (detail >= 1) {
    const nb = Math.max(2, Math.round((top - g) / WALL.courseBand));
    for (let k = 1; k < nb; k++) {
      const t = k / nb;
      const y = g + 0.9 + (top - g - 0.9) * t;
      const rr = R + 0.7 + (R * 0.92 - R - 0.7) * t + 0.15;
      cylinder(brick, cx, y - 0.12, cz, rr, rr, 0.12, seg, PAL.tileCourse, { top: true, bottom: true });
    }
    // Postern for the towpath, facing the water.
    brick.push(new THREE.Matrix4().makeRotationY(Math.atan2(-1, 0.2)).setPosition(cx - R * 0.9, g + 0.9, cz));
    archPanel(brick, 4.2, 5.0, PAL.brick, {
      depth: 1.6,
      spring: 2.0,
      openWidth: 1.8,
      segments: detail >= 2 ? 9 : 5,
      archivolt: 0.18,
      voidCol: new THREE.Color(0.024, 0.022, 0.018),
    });
    brick.pop();
  }
  // Cornice, then a crenellated crown and a tiled cap over the guard chamber.
  // Splayed out of the drum, for the same reason as the gate towers': a ring at 1.02 R
  // over a drum tapering to 0.92 R has 0.76 m of open soffit and shows sky through it.
  cylinder(stone, cx, top - 0.3, cz, R * 0.92, R * 1.02, 0.3, seg, PAL.travertine);
  cylinder(stone, cx, top, cz, R * 1.02, R * 1.02, 0.7, seg, PAL.travertine, { top: true });
  const nm = detail >= 1 ? 14 : 7;
  for (let k = 0; k < nm; k++) {
    const a = (Math.PI * 2 * (k + 0.5)) / nm;
    const ax = cx + Math.cos(a) * R * 0.94;
    const az = cz + Math.sin(a) * R * 0.94;
    const tg = a + Math.PI * 0.5;
    quadPrism(
      brick,
      ax - Math.cos(tg) * 0.78,
      az - Math.sin(tg) * 0.78,
      ax + Math.cos(tg) * 0.78,
      az + Math.sin(tg) * 0.78,
      Math.cos(a),
      Math.sin(a),
      0.9,
      top + 0.7,
      top + 2.4,
      PAL.brick,
      PAL.travertine
    );
  }
  cylinder(brick, cx, top + 0.7, cz, R * 0.62, R * 0.62, 3.4, seg, PAL.brick, { shadeLow: 0.1 });
  roof.pushTranslate(cx, 0, cz);
  hipRoof(roof, R * 1.35, R * 1.35, top + 4.1, R * 0.42, 0.5, PAL.roofTileOld);
  roof.pop();
}

// ---------------------------------------------------------------------------
// Wall stairs — parallel to the curtain, on its inner face
// ---------------------------------------------------------------------------

/**
 * Riser and going of a wall stair.
 *
 * A Roman *gradus* is about three quarters of a pes high on a pes and a half of going.
 * 0.29 on 0.42 is 34.6° — steep enough to fit a flight against one bay, shallow enough
 * that a man in mail can run up it, and close to what survives on the Aurelianic stairs
 * behind the Porta Asinaria and on the Theodosian walls.
 */
const STAIR_RISE = 0.29;
const STAIR_TREAD = 0.42;
/** Clear width: two men abreast with shields, so a relief can pass a casualty coming down. */
const STAIR_W = 2.8;
/** Solid parapet on the open side of the flight, and its height above the treads. */
const STAIR_PARAPET_W = 0.42;
const STAIR_PARAPET_H = 0.95;
/** Depth of the landing at the head, between the tower and the top of the flight. */
const STAIR_LANDING = 2.2;
/**
 * Longest flight worth building.
 *
 * Beyond this the ground under the bay has fallen away so far that a single straight flight
 * is a lie — bay 3's walk stands 40.55 m over its own footing, which would want a 59 m ramp
 * against a 35.5 m bay. Those stretches get no stair rather than a fictional one.
 */
const STAIR_MAX_RUN = 26;

/**
 * Where a flight would stand on this bay, or null if one cannot.
 *
 * Pure in `heightAt`, so `buildWall` can call it once and hand the answer both to the
 * geometry and to the published contract — the mistake this codebase has already made
 * twice is deriving the same number in two places and letting them drift.
 *
 * The run and the foot are mutually dependent: a longer flight reaches further along the
 * bay, where the ground is at a different height, which changes the rise, which changes the
 * run. Solved by three passes of fixed-point iteration — a fixed count rather than a
 * convergence test, so the result is deterministic whether or not it settles.
 */
function stairPlan(
  bay: Bay,
  walkY: number,
  heightAt: (x: number, z: number) => number
): WallStair | null {
  const f = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  // Centreline of the treads, hard against the curtain's inner face and reaching out into
  // the pomerium by the stair's own width.
  const off = -(HALF_T + STAIR_W * 0.5);
  const at = (t: number, o: number): { x: number; z: number } => ({
    x: bay.x0 + f.dx * t + f.nx * o,
    z: bay.z0 + f.dz * t + f.nz * o,
  });
  // The head of the flight sits clear of the tower at the bay's west end, and of the
  // landing that bridges from the flight across to the walkway.
  const headT = WALL.towerWidth * 0.5 + 0.9 + STAIR_LANDING;

  let run = 9;
  let footG = 0;
  let n = 0;
  for (let pass = 0; pass < 3; pass++) {
    const p = at(headT + run, off);
    footG = heightAt(p.x, p.z);
    const rise = walkY - footG;
    if (rise < 2.2) return null;
    n = Math.max(6, Math.round(rise / STAIR_RISE));
    run = n * STAIR_TREAD;
  }
  if (run > STAIR_MAX_RUN) return null;
  // Flight, landing and a metre of clearance all have to fit inside the bay.
  if (headT + run > f.len - 1.0) return null;

  const foot = at(headT + run, off);
  const head = at(headT, off);
  /**
   * Where the landing delivers onto the walkway.
   *
   * 0.6 m inboard of the walk's cityward lip, which is inside the clear standing band
   * `walkGeometry` publishes at every stage — so a man stepping off the stair is on the
   * walkway rather than balanced on its edge, and a mover can hand him straight to the
   * garrison spine without a correction step.
   */
  const top = at(headT - STAIR_LANDING * 0.5, -(HALF_T - 0.6));

  return {
    bay: bay.index,
    footX: foot.x, footY: footG, footZ: foot.z,
    headX: head.x, headY: walkY, headZ: head.z,
    topX: top.x, topY: walkY, topZ: top.z,
    // Foot → head climbs back along the bay, i.e. against the run direction.
    dx: -f.dx, dz: -f.dz,
    nx: f.nx, nz: f.nz,
    width: STAIR_W,
    run,
    rise: walkY - footG,
    steps: n,
    // Every flight on this circuit is built against the inner face; see `buildWallStair`.
    side: -1,
  };
}

/**
 * A masonry stair against the inner face, climbing parallel to the curtain.
 *
 * The flight it replaces ran **out of the tower's city face at right angles to the wall**,
 * projecting into the pomerium as a free-standing staircase — which is not a thing Roman
 * engineers built, and is what the player meant by "it should go parallel to the wall not
 * perpendicular. Reference the outside." A wall stair is a solid ramp of masonry raised
 * against the back of the curtain: dressed treads on a brick core, a walled parapet on the
 * open side, the rake stepped rather than smooth, and a landing at the head. Pompeii, Ostia,
 * the Aurelianic circuit itself and the Theodosian walls all do it this way, and so does
 * Rome II — `reference/siege/army-on-walls.jpg` shows a broad flight descending *along* the
 * inner face, never out of it.
 *
 * Emitted into the curtain's own `brick` and `stone` streams, so it costs no draw call.
 */
function buildWallStair(
  batch: Batch,
  detail: number,
  bay: Bay,
  plan: WallStair,
  heightAt: (x: number, z: number) => number
): void {
  const brick = batch.s('brick');
  const stone = batch.s('stone');
  const f = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const { nx, nz } = f;
  const off = -(HALF_T + STAIR_W * 0.5);
  const parapetOff = -(HALF_T + STAIR_W + STAIR_PARAPET_W * 0.5);
  const tOf = (px: number, pz: number): number => (px - bay.x0) * f.dx + (pz - bay.z0) * f.dz;
  const t0 = tOf(plan.headX, plan.headZ);
  const t1 = tOf(plan.footX, plan.footZ);

  // Coarser steps at distance: what carries at range is the rake, not the treads.
  const nEmit =
    detail >= 2 ? plan.steps : detail === 1 ? Math.max(4, Math.ceil(plan.steps / 3)) : Math.max(3, Math.ceil(plan.steps / 6));
  const dy = plan.rise / nEmit;
  const dt = (t1 - t0) / nEmit;
  const hw = STAIR_W * 0.5;

  const treadCol = new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(1.04);
  const riserCol = new THREE.Color().copy(PAL.brick).multiplyScalar(0.9);

  /** Ground under the flight at along-run parameter `t`, on the treads' centreline. */
  const groundAt = (t: number): number =>
    heightAt(bay.x0 + f.dx * t + nx * off, bay.z0 + f.dz * t + nz * off);

  // Treads, counted from the foot, so step k's surface is at `footY + (k + 1) * dy`.
  for (let k = 0; k < nEmit; k++) {
    const ta = t1 - (k + 1) * dt;
    const tb = t1 - k * dt;
    const yTop = plan.footY + (k + 1) * dy;
    const base = Math.min(groundAt(ta), groundAt(tb)) - 1.2;
    const ax = bay.x0 + f.dx * ta + nx * off;
    const az = bay.z0 + f.dz * ta + nz * off;
    const bx = bay.x0 + f.dx * tb + nx * off;
    const bz = bay.z0 + f.dz * tb + nz * off;
    const body = new THREE.Color().copy(PAL.brick).multiplyScalar(0.9 + hash2(k, bay.index, 29) * 0.16);
    const nose = detail >= 1 ? 0.09 : 0;
    // The mass. `ends` only on the bottom step: every other end cap is buried inside the
    // step below it, and two coplanar caps at each junction z-fight the length of the rake.
    quadPrism(brick, ax, az, bx, bz, nx, nz, STAIR_W, base, yTop - nose, body, riserCol, {
      ends: k === 0,
    });
    if (nose > 0) {
      // Dressed travertine tread, 40 mm proud of the brick each side so it reads as a nosing.
      quadPrism(stone, ax, az, bx, bz, nx, nz, STAIR_W + 0.08, yTop - nose, yTop, treadCol, treadCol, {
        ends: false,
      });
    }
    // The riser, standing on the tread below. An explicit quad rather than a prism end cap,
    // so it lands exactly on the step under it instead of running down to the foundation.
    P0.set(bx + nx * hw, yTop - dy, bz + nz * hw);
    P1.set(bx - nx * hw, yTop - dy, bz - nz * hw);
    P2.set(bx - nx * hw, yTop, bz - nz * hw);
    P3.set(bx + nx * hw, yTop, bz + nz * hw);
    OUT.set(f.dx, 0, f.dz);
    stone.quadN(OUT, P0, P1, P2, P3, riserCol, riserCol, treadCol, treadCol);
  }

  /**
   * The cheek wall on the open side, with a **continuously raking coping**.
   *
   * The parapet is not the problem; the *silhouette* of its top was. It used to step with
   * the treads, one 0.29 m jump per going, and a stepped top line above a stepped rake is
   * visually the same object twice: three independent reviewers looking at three different
   * renders all reported "no parapet, cheek wall or coping on the open side — a raw stepped
   * brick arris", while the builder was emitting a 0.95 m wall and `probe-wall` was
   * measuring it at 0.90-0.96 m over the treads. They were not wrong about what they saw.
   * A staircase-shaped pale line reads as *treads*, because that is what treads look like.
   *
   * A real Roman stair parapet rakes smoothly: the cheek wall is built up in courses and
   * the coping is laid as a raking string on top of it, one straight line from the apron to
   * the landing. That single unbroken diagonal is the whole cue — it is what makes the
   * reference plate's flight (`reference/siege/army-on-walls.jpg`) read as a walled stair
   * rather than as steps stuck to a wall. So the brickwork below still steps, because
   * brickwork does, and the coping above it does not.
   *
   * Emitted as explicit sloped quads rather than a prism because `quadPrism` has a flat
   * top by construction. The coping is 0.34 m deep, which is deeper than one riser, so the
   * stepped brick beneath can never poke through the sloping soffit.
   */
  const COPE = 0.34;
  /** Y of the rake's chord at along-run parameter `t`: `t1` is the foot, `t0` the head. */
  const chordY = (t: number): number => plan.footY + (plan.rise * (t1 - t)) / (t1 - t0);
  const pHalf = STAIR_PARAPET_W * 0.5;
  const cHalf = pHalf + 0.06;
  for (let k = 0; k < nEmit; k++) {
    const ta = t1 - (k + 1) * dt;
    const tb = t1 - k * dt;
    const base = Math.min(groundAt(ta), groundAt(tb)) - 1.2;
    // The brick body stops below the coping's soffit at the *lower* end of the segment, so
    // the sloping soffit is always clear of it.
    quadPrism(
      brick,
      bay.x0 + f.dx * ta + nx * parapetOff,
      bay.z0 + f.dz * ta + nz * parapetOff,
      bay.x0 + f.dx * tb + nx * parapetOff,
      bay.z0 + f.dz * tb + nz * parapetOff,
      nx,
      nz,
      STAIR_PARAPET_W,
      base,
      chordY(tb) + STAIR_PARAPET_H - COPE,
      PAL.brick,
      PAL.travertine,
      { ends: k === 0 }
    );
    if (detail >= 1) {
      const yA = chordY(ta) + STAIR_PARAPET_H;
      const yB = chordY(tb) + STAIR_PARAPET_H;
      const ax = bay.x0 + f.dx * ta;
      const az = bay.z0 + f.dz * ta;
      const bx = bay.x0 + f.dx * tb;
      const bz = bay.z0 + f.dz * tb;
      const oIn = parapetOff + cHalf;
      const oOut = parapetOff - cHalf;
      // Top of the coping: one continuous sloping plane the length of the flight.
      P0.set(ax + nx * oOut, yA, az + nz * oOut);
      P1.set(bx + nx * oOut, yB, bz + nz * oOut);
      P2.set(bx + nx * oIn, yB, bz + nz * oIn);
      P3.set(ax + nx * oIn, yA, az + nz * oIn);
      OUT.set(0, 1, 0);
      stone.quadN(OUT, P0, P1, P2, P3, PAL.travertine);
      // Its two faces, which are what carry the raking line in silhouette.
      for (const s of [-1, 1]) {
        const o = parapetOff + s * cHalf;
        P0.set(ax + nx * o, yA - COPE, az + nz * o);
        P1.set(bx + nx * o, yB - COPE, bz + nz * o);
        P2.set(bx + nx * o, yB, bz + nz * o);
        P3.set(ax + nx * o, yA, az + nz * o);
        OUT.set(nx * s, 0, nz * s);
        stone.quadN(OUT, P0, P1, P2, P3, PAL.travertine, PAL.travertine, PAL.travertineDirty, PAL.travertineDirty);
      }
    }
  }

  /**
   * The apron at the foot.
   *
   * The bottom step used to end in a blunt vertical face a riser above the turf — "the
   * flight discharges into raw lawn with no paved surface, no threshold". A stair that
   * carries a cohort to the wall lands on something: a travertine pad, one tread deep and
   * wider than the flight, bedded into the ground.
   */
  {
    const pa = t1 + 0.1;
    const pb = t1 + 1.9;
    const pg = Math.min(groundAt(pa), groundAt(pb), plan.footY);
    quadPrism(
      stone,
      bay.x0 + f.dx * pa + nx * off,
      bay.z0 + f.dz * pa + nz * off,
      bay.x0 + f.dx * pb + nx * off,
      bay.z0 + f.dz * pb + nz * off,
      nx,
      nz,
      STAIR_W + 0.7,
      pg - 0.9,
      plan.footY + 0.06,
      PAL.travertineDirty,
      PAL.travertineDirty
    );
  }

  // ---- landing at the head, level with the wall-walk -----------------------
  const la = t0 - STAIR_LANDING;
  const lb = t0;
  const lBase = Math.min(groundAt(la), groundAt(lb)) - 1.2;
  // From the curtain's inner face out past the stair's parapet.
  const inner = -HALF_T;
  const outer = parapetOff - STAIR_PARAPET_W * 0.5;
  const midOff = (inner + outer) * 0.5;
  const spanW = inner - outer;
  const lax = bay.x0 + f.dx * la + nx * midOff;
  const laz = bay.z0 + f.dz * la + nz * midOff;
  const lbx = bay.x0 + f.dx * lb + nx * midOff;
  const lbz = bay.z0 + f.dz * lb + nz * midOff;
  quadPrism(brick, lax, laz, lbx, lbz, nx, nz, spanW, lBase, plan.headY - 0.09, PAL.brick, riserCol, { ends: true });
  quadPrism(stone, lax, laz, lbx, lbz, nx, nz, spanW, plan.headY - 0.09, plan.headY, treadCol, treadCol, {
    ends: false,
  });
  // The landing's own parapet, closing the open side.
  quadPrism(
    brick,
    bay.x0 + f.dx * la + nx * parapetOff,
    bay.z0 + f.dz * la + nz * parapetOff,
    bay.x0 + f.dx * lb + nx * parapetOff,
    bay.z0 + f.dz * lb + nz * parapetOff,
    nx,
    nz,
    STAIR_PARAPET_W,
    lBase,
    plan.headY + STAIR_PARAPET_H,
    PAL.brick,
    PAL.travertine,
    { ends: true }
  );
  if (detail >= 1) {
    // Return wall across the head of the landing, so it does not open onto a drop.
    quadPrism(
      brick,
      bay.x0 + f.dx * (la + 0.21) + nx * midOff,
      bay.z0 + f.dz * (la + 0.21) + nz * midOff,
      bay.x0 + f.dx * (la - 0.21) + nx * midOff,
      bay.z0 + f.dz * (la - 0.21) + nz * midOff,
      nx,
      nz,
      spanW,
      plan.headY,
      plan.headY + STAIR_PARAPET_H,
      PAL.brick,
      PAL.travertine,
      { ends: false }
    );
  }
}

/**
 * Timber scaffolding: standards, ledgers, putlogs and plank lifts, **on the city face**.
 *
 * Every offset here is negative along the outward normal, and that is the whole point.
 * The scaffold used to stand on the field side, which put two rows of poles, a plank deck
 * and a fifteen-metre treadwheel crane on the *glacis* of a wall being assaulted by a
 * Germanic host — a free ladder for the Juthungi and the first thing a player notices is
 * wrong. Aurelian's men worked from inside their own circuit for the same reason his
 * material yard is inside it (see `buildYard`): the outside of an unfinished wall in 271
 * is enemy ground.
 *
 * It also means the scaffold, the yard and the wall stair all share the pomerium, so their
 * offsets are chosen not to foul each other: scaffold −3.0..−4.9, stair −3.0..−6.2, yard
 * −11..−23. Stairs are built on finished bays only and scaffolds on unfinished ones, so the
 * two never occupy the same bay.
 */
function buildScaffold(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number,
  topY: number,
  rng: Rng
): void {
  if (detail < 1) return;
  const timber = batch.s('timber');
  const { nx, nz, dx, dz } = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  // Cityward. A working scaffold stands about 1.6 m off the face — near enough to reach
  // the work from the deck, far enough to walk behind.
  const standOff = -(HALF_T + 1.6);
  // Inner standard, i.e. the row *nearer the wall*. Cityward offsets grow more negative
  // going away from the wall, so the near row is the larger (less negative) offset.
  const nearOff = standOff + 1.0;
  const nStands = 12;

  for (let s = 0; s <= nStands; s++) {
    const t = s / nStands;
    const px = lerp(bay.x0, bay.x1, t) + nx * standOff;
    const pz = lerp(bay.z0, bay.z1, t) + nz * standOff;
    const g = heightAt(px, pz);
    const h = topY + 2.8 - g;
    const c = new THREE.Color().copy(PAL.timber).multiplyScalar(0.84 + hash2(s, bay.index, 3) * 0.32);
    cylinder(timber, px, g, pz, 0.17, 0.14, h, 6, c);
    // Two rows of poles, not one: a real scaffold is a frame, not a fence.
    const qx = lerp(bay.x0, bay.x1, t) + nx * nearOff;
    const qz = lerp(bay.z0, bay.z1, t) + nz * nearOff;
    cylinder(timber, qx, heightAt(qx, qz), qz, 0.15, 0.12, h - 0.5, 5, c);
    if (detail >= 2) {
      // Sole plates. A 170 mm pole carrying four lifts punches straight through soft ground
      // without one, and a critic reading the frames named the standards "poking into grass
      // with no base pad" before naming anything else about the timber.
      const sole = new THREE.Color().copy(PAL.timberDark).multiplyScalar(0.9);
      box(timber, px - 0.34, g - 0.06, pz - 0.28, px + 0.34, g + 0.1, pz + 0.28, sole);
      box(timber, qx - 0.3, heightAt(qx, qz) - 0.06, qz - 0.24, qx + 0.3, heightAt(qx, qz) + 0.1, qz + 0.24, sole);
    }
    if (s % 2 === 0) {
      // Raking brace out into the pomerium, footed on the ground behind the scaffold.
      const braceOff = standOff - 1.7;
      const bxp = lerp(bay.x0, bay.x1, t) + nx * braceOff;
      const bzp = lerp(bay.z0, bay.z1, t) + nz * braceOff;
      strut(timber, P0.set(px, g + h * 0.9, pz), P1.set(bxp, heightAt(bxp, bzp), bzp), 0.1, c);
    }
  }

  const gBase = Math.min(bay.g0, bay.g1);
  const lifts = Math.max(1, Math.floor((topY - gBase) / 1.9));
  // Inner edge of the plank deck, hard against the curtain's city face.
  const deckOff = -(HALF_T - 0.15);
  for (let k = 1; k <= lifts; k++) {
    const y = gBase + k * 1.9;
    const ax = bay.x0 + nx * standOff;
    const az = bay.z0 + nz * standOff;
    const bx = bay.x1 + nx * standOff;
    const bz = bay.z1 + nz * standOff;
    cylinderBetween(timber, ax, y, az, bx, y, bz, 0.07, PAL.timber);
    /**
     * A ledger on the **inner** row too, and raking braces in the plane of the face.
     *
     * Without these the scaffold is thirteen bare uprights per bay and reads as a picket
     * fence — which is exactly what it looked like once it was moved to the city side where
     * the camera can actually see it. A scaffold is a *frame*: what makes it legible is the
     * horizontals and the diagonals, not the standards. Vitruvius' *machinae* and every
     * surviving depiction of Roman staging show the same triangulated bay.
     */
    const nax = bay.x0 + nx * nearOff;
    const naz = bay.z0 + nz * nearOff;
    const nbx = bay.x1 + nx * nearOff;
    const nbz = bay.z1 + nz * nearOff;
    cylinderBetween(timber, nax, y - 0.5, naz, nbx, y - 0.5, nbz, 0.06, PAL.timberDark);
    if (detail >= 2 && k < lifts) {
      /**
       * Face-plane diagonals, **one standard bay each**.
       *
       * The first attempt at this ran each brace from t = 0 to t = 0.5 of the *wall* bay —
       * 17.75 m along against 1.9 m of rise, a 6° member that is a second ledger with a
       * slope on it, not a brace. A critic shown the render said there was no bracing in the
       * frame at all, and was right to. A scaffold bay here is 35.5 / 12 = 2.96 m, so a
       * proper diagonal over one lift rises 1.9 m in 2.96 and lands at 33°, which is what
       * triangulates the frame and what breaks the orthogonal grid at a distance.
       */
      for (let s = 0; s < nStands; s++) {
        if ((s + k + bay.index) % 2 !== 0) continue;
        // Alternate the hand so the run reads as a braced frame, not a row of parallel ticks.
        const up = (s + k) % 4 < 2;
        const t0 = (up ? s : s + 1) / nStands;
        const t1 = (up ? s + 1 : s) / nStands;
        strut(
          timber,
          P0.set(lerp(ax, bx, t0), y, lerp(az, bz, t0)),
          P1.set(lerp(ax, bx, t1), y + 1.9, lerp(az, bz, t1)),
          0.055,
          PAL.timberDark
        );
      }
      // Rope lashings where a ledger crosses a standard. Roman staging is tied, not nailed,
      // and the binding is the detail that separates modelled staging from decorative.
      for (let s = 0; s <= nStands; s += 2) {
        const t2 = s / nStands;
        const lx = lerp(ax, bx, t2);
        const lz = lerp(az, bz, t2);
        cylinder(timber, lx, y - 0.11, lz, 0.215, 0.215, 0.22, 6, PAL.timberDark);
      }
    }
    /**
     * The plank deck: **boards, not a slab.**
     *
     * It was one quad the length of the bay, which from anywhere near it is a 35 m sheet of
     * timber with one clean straight edge — "no individual board ends, no differing lengths,
     * no overlaps, no gaps". Scaffold boards are about four metres long and are laid four or
     * five abreast with the ends butted wherever a putlog falls, so the deck is emitted as a
     * grid of them with a joint between each and a little tone and height variation.
     *
     * Each board gets a soffit as well. A deck emitted as a single upward quad is invisible
     * from underneath, and now that the staging is on the city side there is a whole
     * pomerium to stand in and look up from.
     */
    const across = detail >= 2 ? 4 : 1;
    const along = detail >= 2 ? 9 : 1;
    for (let c2 = 0; c2 < across; c2++) {
      const w0 = c2 / across;
      const w1 = (c2 + 1) / across;
      for (let a2 = 0; a2 < along; a2++) {
        // 25 mm between boards, and a board sits a few millimetres off its neighbour.
        const j = across > 1 ? 0.012 : 0;
        const s0 = a2 / along;
        const s1 = (a2 + 1) / along;
        const dyB = across > 1 ? hash2(a2, c2 + bay.index * 7 + k * 3, 59) * 0.02 : 0;
        const yb = y + 0.08 + dyB;
        const oA = lerp(standOff, deckOff, w0);
        const oB = lerp(standOff, deckOff, w1) - (across > 1 ? 0.025 : 0);
        const tone = new THREE.Color()
          .copy(PAL.timber)
          .multiplyScalar(0.84 + hash2(a2 * 3 + c2, bay.index + k, 131) * 0.34);
        const pA = { x: lerp(bay.x0, bay.x1, s0), z: lerp(bay.z0, bay.z1, s0) };
        const pB = { x: lerp(bay.x0, bay.x1, s1), z: lerp(bay.z0, bay.z1, s1) };
        const gap = across > 1 ? 0.02 : 0;
        P0.set(pA.x + nx * oB + dx * gap, yb, pA.z + nz * oB + dz * gap);
        P1.set(pB.x + nx * oB - dx * gap, yb, pB.z + nz * oB - dz * gap);
        P2.set(pB.x + nx * oA - dx * gap, yb, pB.z + nz * oA - dz * gap);
        P3.set(pA.x + nx * oA + dx * gap, yb, pA.z + nz * oA + dz * gap);
        OUT.set(0, 1, 0);
        timber.quadN(OUT, P0, P1, P2, P3, tone, tone, tone, tone);
        P0.set(pA.x + nx * oA + dx * gap, yb - 0.055 - j, pA.z + nz * oA + dz * gap);
        P1.set(pB.x + nx * oA - dx * gap, yb - 0.055 - j, pB.z + nz * oA - dz * gap);
        P2.set(pB.x + nx * oB - dx * gap, yb - 0.055 - j, pB.z + nz * oB - dz * gap);
        P3.set(pA.x + nx * oB + dx * gap, yb - 0.055 - j, pA.z + nz * oB + dz * gap);
        OUT.set(0, -1, 0);
        timber.quadN(OUT, P0, P1, P2, P3, PAL.timberDark);
      }
    }
    if (detail >= 2 && k < lifts) {
      // A ladder to the lift above. Four decks with no way between them is a scaffold no
      // builder can use, and it was the first thing a reviewer said was missing outright.
      const lt = 0.18 + ((k * 5 + bay.index) % 7) * 0.1;
      const lOff = standOff + 0.55;
      const lx = lerp(bay.x0, bay.x1, lt) + nx * lOff;
      const lz = lerp(bay.z0, bay.z1, lt) + nz * lOff;
      const foot = 0.55;
      for (const sr of [-1, 1]) {
        strut(
          timber,
          P0.set(lx + dx * sr * 0.24 - nx * foot, y + 0.1, lz + dz * sr * 0.24 - nz * foot),
          P1.set(lx + dx * sr * 0.24, y + 2.0, lz + dz * sr * 0.24),
          0.045,
          PAL.timber
        );
      }
      for (let r = 1; r < 7; r++) {
        const f2 = r / 7;
        const rx = lx - nx * foot * (1 - f2);
        const rz = lz - nz * foot * (1 - f2);
        const ry = y + 0.1 + f2 * 1.9;
        cylinderBetween(timber, rx - dx * 0.24, ry, rz - dz * 0.24, rx + dx * 0.24, ry, rz + dz * 0.24, 0.033, PAL.timberDark, 4);
      }
    }
    if (detail >= 2) {
      // Putlogs: the transoms that carry the deck, one end socketed into the wall.
      for (let s = 0; s < 10; s++) {
        const t = (s + 0.5) / 10;
        const px = lerp(bay.x0, bay.x1, t);
        const pz = lerp(bay.z0, bay.z1, t);
        cylinderBetween(
          timber,
          px + nx * (standOff - 0.35),
          y,
          pz + nz * (standOff - 0.35),
          px + nx * (-(HALF_T - 0.5)),
          y,
          pz + nz * (-(HALF_T - 0.5)),
          0.06,
          PAL.timberDark
        );
      }
    }
  }

  if (bay.index % 2 === 0) buildCrane(batch, detail, bay, topY, rng);
}

/**
 * A Roman *polyspaston*: raking timber legs, a treadwheel driving the tackle, and a
 * dressed block hanging in the fall. Vitruvius X.2 describes exactly this machine.
 */
function buildCrane(batch: Batch, detail: number, bay: Bay, topY: number, rng: Rng): void {
  const timber = batch.s('timber');
  const stone = batch.s('stone');
  const metal = batch.s('metal');
  const { nx, nz, dx, dz } = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const t = rng.range(0.3, 0.7);
  const bxp = lerp(bay.x0, bay.x1, t);
  const bzp = lerp(bay.z0, bay.z1, t);
  const baseY = topY + 0.22;
  const mastH = 15.5;
  /**
   * The mast leans **cityward**, and the jib swings over the pomerium.
   *
   * A *polyspaston* is fed from the ground it stands over, and the ground the stone is
   * stacked on is inside the wall — `buildYard` puts the travertine, the brick pallets and
   * the mortar pit at −11..−23 m, because you do not stockpile your building material on
   * the enemy's side of an unfinished wall. The crane used to lean the other way and hang
   * its load out over the glacis, lifting blocks from a yard that is not there.
   */
  const lean = -2.6;

  const apex = new THREE.Vector3(bxp + nx * lean, baseY + mastH, bzp + nz * lean);
  for (const s of [-1, 1]) {
    strut(
      timber,
      P0.set(bxp + dx * s * 1.6 + nx * 0.7, baseY, bzp + dz * s * 1.6 + nz * 0.7),
      apex,
      0.18,
      PAL.timber
    );
  }
  // Backstay taking the overturning moment, footed on the outer lip of the lift. Brought
  // in from 3.2 m to 2.2: the exposed core is 5.45 m wide, so 3.2 stood in mid-air.
  strut(timber, apex, P0.set(bxp + nx * 2.2, baseY, bzp + nz * 2.2), 0.16, PAL.timberDark);
  // Jib carrying the fall out over the yard behind the wall.
  strut(timber, apex, P0.set(bxp - nx * 6.5, baseY + mastH * 0.62, bzp - nz * 6.5), 0.15, PAL.timber);

  // Treadwheel: two rims joined by treads, big enough for two men to walk in.
  //
  // Centred on the lift rather than offset to one side of it. The wheel is 5.8 m across and
  // stands in the plane *across* the wall, so any offset at all hangs most of it over one
  // face or the other: at 1.5 m to the field side it reached 4.4 m out — further than the
  // scaffold it replaced and, being a wheel, a rather better ladder. On the centreline it
  // overhangs the 5.45 m core by 175 mm each way, which is what a real one would do.
  if (detail >= 1) {
    const R = 2.9;
    const wcx = bxp;
    const wcz = bzp;
    const wheelY = baseY + 0.35 + R;
    const rimSeg = detail >= 2 ? 16 : 9;
    for (const s of [-1, 1]) {
      const ox = dx * s * 0.6;
      const oz = dz * s * 0.6;
      // Rim drawn as a thin ring in the vertical plane: a torus is overkill, a short
      // cylinder rotated onto its side reads correctly at this distance.
      const rm = new THREE.Matrix4()
        .makeRotationX(Math.PI / 2)
        .premultiply(new THREE.Matrix4().makeRotationY(Math.atan2(dx, dz)))
        .setPosition(wcx + ox, wheelY, wcz + oz);
      timber.push(rm);
      cylinder(timber, 0, -0.06, 0, R, R, 0.12, rimSeg, PAL.timber, { top: true, bottom: true });
      cylinder(timber, 0, -0.05, 0, R * 0.86, R * 0.86, 0.1, rimSeg, PAL.timberDark, { top: true });
      timber.pop();
    }
    for (let k = 0; k < 12; k++) {
      const a = (Math.PI * 2 * k) / 12;
      const rx = wcx + nx * Math.cos(a) * R;
      const rz = wcz + nz * Math.cos(a) * R;
      const yy = wheelY + Math.sin(a) * R;
      cylinderBetween(timber, rx - dx * 0.6, yy, rz - dz * 0.6, rx + dx * 0.6, yy, rz + dz * 0.6, 0.055, PAL.timberDark);
    }
    cylinderBetween(metal, wcx - dx * 0.85, wheelY, wcz - dz * 0.85, wcx + dx * 0.85, wheelY, wcz + dz * 0.85, 0.09, PAL.iron);
  }

  // The load: a dressed travertine block on the fall, halfway up.
  const loadY = baseY + mastH * 0.4;
  cylinderBetween(metal, apex.x, apex.y - 0.25, apex.z, apex.x, loadY + 1.0, apex.z, 0.035, PAL.iron, 4);
  box(stone, apex.x - 0.62, loadY, apex.z - 0.44, apex.x + 0.62, loadY + 0.86, apex.z + 0.44, PAL.travertine, { bottom: true });
}

/** Stockpiles, mortar pits and rubble on the city side of a working stretch. */
function buildYard(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number,
  rng: Rng
): void {
  const stone = batch.s('stone');
  const brick = batch.s('brick');
  const concrete = batch.s('concrete');
  const timber = batch.s('timber');
  const { nx, nz, dx, dz } = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);

  // Yards sit on the city side: you do not stack your building stone outside the
  // wall with a Germanic host on the plain.
  const yardOff = -(HALF_T + rng.range(8, 20));
  const nStacks = detail >= 1 ? 5 : 2;
  for (let i = 0; i < nStacks; i++) {
    const t = rng.next();
    const px = lerp(bay.x0, bay.x1, t) + nx * (yardOff + rng.jitter(5));
    const pz = lerp(bay.z0, bay.z1, t) + nz * (yardOff + rng.jitter(5));
    const g = heightAt(px, pz);
    // Dressed travertine in 1.2 × 0.6 × 0.6 m blocks, a few courses high.
    const cols = 2 + rng.int(0, 2);
    const rows = 2 + rng.int(0, 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols - (r > 1 ? 1 : 0); c++) {
        const ox = (c - (cols - 1) * 0.5) * 1.3;
        const bx2 = px + dx * ox;
        const bz2 = pz + dz * ox;
        const tone = 0.62 + hash2(i * 7 + c, r, 21) * 0.5;
        const col = new THREE.Color().copy(PAL.travertineDirty).multiplyScalar(tone);
        quadPrism(stone, bx2 - dx * 0.6, bz2 - dz * 0.6, bx2 + dx * 0.6, bz2 + dz * 0.6, nx, nz, 0.62, g + r * 0.62, g + (r + 1) * 0.62 - 0.02, col, col);
      }
    }
  }

  if (detail >= 1) {
    // Brick pallets: *bipedales* stacked on edge.
    for (let i = 0; i < 3; i++) {
      const t = rng.next();
      const px = lerp(bay.x0, bay.x1, t) + nx * (yardOff + rng.range(-7, 7));
      const pz = lerp(bay.z0, bay.z1, t) + nz * (yardOff + rng.range(-7, 7));
      const g = heightAt(px, pz);
      quadPrism(brick, px - dx * 0.85, pz - dz * 0.85, px + dx * 0.85, pz + dz * 0.85, nx, nz, 1.2, g, g + rng.range(0.7, 1.5), PAL.brick, PAL.brickPale);
    }
  }

  // Mortar pit: slaked lime, blindingly pale, with a spoil bank round it.
  const mpT = rng.next();
  const mx = lerp(bay.x0, bay.x1, mpT) + nx * (yardOff - rng.range(3, 10));
  const mz = lerp(bay.z0, bay.z1, mpT) + nz * (yardOff - rng.range(3, 10));
  const mg = heightAt(mx, mz);
  box(concrete, mx - 2.7, mg + 0.04, mz - 2.0, mx + 2.7, mg + 0.12, mz + 2.0, new THREE.Color(0.82, 0.81, 0.75));
  for (const s of [-1, 1]) {
    box(concrete, mx - 3.05, mg, mz + s * 2.1 - 0.32, mx + 3.05, mg + 0.45, mz + s * 2.1 + 0.32, PAL.dust);
    box(concrete, mx + s * 3.05 - 0.32, mg, mz - 2.1, mx + s * 3.05 + 0.32, mg + 0.45, mz + 2.1, PAL.dust);
  }

  // Rubble heaps of broken tufa and tile for the core.
  for (let i = 0; i < (detail >= 1 ? 4 : 1); i++) {
    const t = rng.next();
    const px = lerp(bay.x0, bay.x1, t) + nx * (yardOff + rng.range(-9, 9));
    const pz = lerp(bay.z0, bay.z1, t) + nz * (yardOff + rng.range(-9, 9));
    const g = heightAt(px, pz);
    const r = rng.range(1.7, 3.5);
    cylinder(concrete, px, g, pz, r, r * 0.22, r * 0.52, 7, PAL.concrete, { top: true });
  }

  if (detail >= 1) {
    // Timber stack for the shuttering and the scaffold.
    const t = rng.next();
    const px = lerp(bay.x0, bay.x1, t) + nx * (yardOff + rng.range(-5, 5));
    const pz = lerp(bay.z0, bay.z1, t) + nz * (yardOff + rng.range(-5, 5));
    const g = heightAt(px, pz);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 3; c++) {
        const off = (c - 1) * 0.34;
        cylinderBetween(
          timber,
          px + nx * off - dx * 2.5,
          g + 0.16 + r * 0.3,
          pz + nz * off - dz * 2.5,
          px + nx * off + dx * 2.5,
          g + 0.16 + r * 0.3,
          pz + nz * off + dz * 2.5,
          0.14,
          PAL.timber
        );
      }
    }
  }
}

/** A footing-only stretch: shuttering boards and the first lift of poured concrete. */
function buildFootingSite(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number,
  rng: Rng
): void {
  const timber = batch.s('timber');
  const concrete = batch.s('concrete');
  const { nx, nz } = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const gm = Math.min(bay.g0, bay.g1);

  for (const s of [-1, 1]) {
    const off = s * (HALF_T + 0.16);
    quadPrism(
      timber,
      bay.x0 + nx * off,
      bay.z0 + nz * off,
      bay.x1 + nx * off,
      bay.z1 + nz * off,
      nx,
      nz,
      0.1,
      gm + WALL.plinthHeight,
      gm + WALL.plinthHeight + 1.2,
      PAL.timber,
      PAL.timberDark,
      { ends: false }
    );
    if (detail >= 1) {
      for (let k = 0; k <= 10; k++) {
        const t = k / 10;
        const px = lerp(bay.x0, bay.x1, t) + nx * (off + s * 0.32);
        const pz = lerp(bay.z0, bay.z1, t) + nz * (off + s * 0.32);
        cylinder(timber, px, heightAt(px, pz), pz, 0.08, 0.07, WALL.plinthHeight + 1.45, 5, PAL.timberDark);
      }
    }
  }
  quadPrism(
    concrete,
    bay.x0,
    bay.z0,
    bay.x1,
    bay.z1,
    nx,
    nz,
    CURTAIN_T,
    gm + WALL.plinthHeight,
    gm + WALL.plinthHeight + 1.0,
    PAL.concrete,
    PAL.mortar,
    { ends: false }
  );
  if (bay.dress) buildYard(batch, detail, bay, heightAt, rng);
}

/**
 * A gap in the circuit blocked in a hurry: an earth-and-rubble rampart with a timber
 * palisade on its crest. This is what Aurelian's men would actually have thrown
 * across an unfinished stretch with a Germanic host on the plain.
 */
function buildGapBarricade(
  batch: Batch,
  detail: number,
  bay: Bay,
  heightAt: (x: number, z: number) => number,
  rng: Rng
): void {
  const concrete = batch.s('concrete');
  const timber = batch.s('timber');
  const stone = batch.s('stone');
  const { nx, nz, dx, dz } = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  const subs = detail >= 1 ? 14 : 4;

  for (let s = 0; s < subs; s++) {
    const t0 = s / subs;
    const t1 = (s + 1) / subs;
    const ax = lerp(bay.x0, bay.x1, t0);
    const az = lerp(bay.z0, bay.z1, t0);
    const bx = lerp(bay.x0, bay.x1, t1);
    const bz = lerp(bay.z0, bay.z1, t1);
    const g = Math.min(heightAt(ax, az), heightAt(bx, bz));
    const h = 2.5 + hash2(s, bay.index, 77) * 0.9;
    quadPrism(concrete, ax, az, bx, bz, nx, nz, CURTAIN_T + 3.6, g - 0.8, g + h, PAL.concrete, PAL.dust, {
      ends: false,
      batter: 0.44,
    });
    if (detail >= 1 && hash2(s, bay.index, 91) > 0.5) {
      const bxx = lerp(ax, bx, 0.5) + nx * (HALF_T + 1.3);
      const bzz = lerp(az, bz, 0.5) + nz * (HALF_T + 1.3);
      quadPrism(stone, bxx - dx * 0.7, bzz - dz * 0.7, bxx + dx * 0.7, bzz + dz * 0.7, nx, nz, 0.7, g, g + 0.66, PAL.travertineDirty, PAL.travertine);
    }
  }

  // Palisade of split stakes on the crest, sharpened and leaning outward.
  const stakes = detail >= 1 ? 46 : 14;
  for (let s = 0; s < stakes; s++) {
    const t = (s + 0.5) / stakes;
    const px = lerp(bay.x0, bay.x1, t);
    const pz = lerp(bay.z0, bay.z1, t);
    const base = heightAt(px, pz) + 2.4 + hash2(s, bay.index, 77) * 0.9;
    const h = 2.3 + hash2(s, bay.index, 5) * 0.7;
    const leanX = nx * 0.3 + dx * (hash2(s, bay.index, 9) - 0.5) * 0.22;
    const leanZ = nz * 0.3 + dz * (hash2(s, bay.index, 9) - 0.5) * 0.22;
    strut(timber, P0.set(px, base - 0.6, pz), P1.set(px + leanX, base + h, pz + leanZ), 0.11 + hash2(s, bay.index, 13) * 0.045, PAL.timber);
  }
  for (let k = 0; k < 2; k++) {
    const y0 = heightAt(bay.x0, bay.z0) + 3.4 + k * 1.2;
    const y1 = heightAt(bay.x1, bay.z1) + 3.4 + k * 1.2;
    cylinderBetween(timber, bay.x0 - nx * 0.28, y0, bay.z0 - nz * 0.28, bay.x1 - nx * 0.28, y1, bay.z1 - nz * 0.28, 0.1, PAL.timberDark);
  }
}

// ---------------------------------------------------------------------------
// Small helpers, exported for the other city builders
// ---------------------------------------------------------------------------

const SEG_A = new THREE.Vector3();
const SEG_B = new THREE.Vector3();
const SEG_D = new THREE.Vector3();
const SEG_M = new THREE.Matrix4();
const SEG_Q = new THREE.Quaternion();
const SEG_UP = new THREE.Vector3(0, 1, 0);
const SEG_S = new THREE.Vector3(1, 1, 1);
const SEG_TMP_A = new THREE.Vector3();
const SEG_TMP_B = new THREE.Vector3();

/** A cylindrical strut between two arbitrary points — poles, braces, ropes, stakes. */
export function strut(st: GeoStream, a: THREE.Vector3, b: THREE.Vector3, radius: number, col: THREE.Color, seg = 5): void {
  SEG_A.copy(a);
  SEG_B.copy(b);
  SEG_D.subVectors(SEG_B, SEG_A);
  const len = SEG_D.length();
  if (len < 1e-4) return;
  SEG_D.divideScalar(len);
  SEG_Q.setFromUnitVectors(SEG_UP, SEG_D);
  SEG_M.compose(SEG_A, SEG_Q, SEG_S);
  st.push(SEG_M);
  cylinder(st, 0, 0, 0, radius, radius * 0.85, len, seg, col);
  st.pop();
}

/** `strut` from raw coordinates. */
export function cylinderBetween(
  st: GeoStream,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  radius: number,
  col: THREE.Color,
  seg = 5
): void {
  strut(st, SEG_TMP_A.set(x0, y0, z0), SEG_TMP_B.set(x1, y1, z1), radius, col, seg);
}
