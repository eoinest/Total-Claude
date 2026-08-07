import * as THREE from 'three';
import { clamp, lerp } from '../util/math';
import { hash2, Rng } from '../util/rand';
import {
  archPanel,
  box,
  crenellation,
  place,
  quadPrism,
  type Batch,
  type GeoStream,
} from './build';
import {
  fitWallPath,
  GATE_X,
  WALL_X_MAX,
  WALL_X_MIN,
  type WallNode,
} from './layout';
import { PAL } from './palette';
import type {
  Blocker,
  CityChunkSpec,
  GarrisonBay,
  GateBlockOut,
  GateDoorOut,
  GateOut,
  TreeRequest,
  WallBuildOutput,
  WallSegmentOut,
  WallStair,
} from './wall';

/**
 * The landward defence of Carthage, 149 BC — a *triple* wall with a casemated main line.
 *
 * This is deliberately not `wall.ts` with different numbers. Rome's Aurelian curtain is a
 * single skin of brick-faced concrete you stand on top of; Carthage's isthmus wall is three
 * lines stepping down a glacis, the innermost of which is **hollow** and has an army
 * quartered inside it. Those are different tactical objects and the difference is the whole
 * reason for the map.
 *
 * ## The source
 *
 * Appian, *Punica* 95, describing the defences Scipio Aemilianus had to break:
 *
 * > "…the city was protected by a triple wall, of which the outermost, facing the isthmus,
 * > was thirty cubits high, apart from the parapets and towers, and thirty feet broad.
 * > …towers at intervals of two plethra, each of four storeys. The wall was hollow
 * > throughout, and within it were stalls for three hundred elephants with magazines for
 * > their fodder, and stables for four thousand horses with granaries; and barracks for
 * > twenty thousand foot and four thousand horse."
 *
 * Every dimension below is that passage converted at Attic measure, and each constant
 * carries the ancient figure it came from so it can be re-derived rather than trusted.
 * **Where Appian gives no number** — the interval between the three lines, the depth of the
 * gallery's two storeys, the rake of a ramp — the constant says so and gives the
 * archaeological or playability reason instead. There is no third category.
 *
 * ## What the sim sees
 *
 * The **main** line, and only the main line, publishes `GarrisonBay`s and `WallStair`s, so
 * `CitySystem.bayAt`'s index arithmetic still holds and `Siege.ts` drives this circuit with
 * the same four accessors it drives Rome's. The outer and middle lines are published as
 * `OutworkOut` — real masonry that stops men and arrows, but not a garrison line, because
 * one x cannot index two bays.
 */

// ---------------------------------------------------------------------------
// Ancient measure
// ---------------------------------------------------------------------------

/** Attic *pēchys*, for the record. `docs/CARTHAGE.md` §4.3 resolves which one to build at. */
const CUBIT = 0.462;
/** Attic *pous*. 200 of them is the tower interval. */
const GK_FOOT = 0.308;

/**
 * The section, as Appian gives it and as this builds it.
 *
 * Exported so a probe measures the geometry against the *stated* figure rather than against
 * a number it re-derives — the failure mode this project has hit repeatedly is an assertion
 * that recomputes the thing it is testing and therefore cannot fail.
 */
export const PUNIC = {
  /**
   * 30 cubits to the wall-walk, "apart from the parapets and towers".
   *
   * `docs/CARTHAGE.md` §4.3 settles the cubit: at the Attic 0.462 m this is 13.86 m and at
   * the Punic 0.515 m it is 15.5 m, and the spec picks **13.7** — Appian's own gloss of
   * 45 Roman feet. Taken from the spec rather than re-derived, so the two cannot drift.
   */
  mainHeight: 13.7,
  /** 30 ft across. This is what makes the wall hollow-able at all. §4.3. */
  mainThickness: 9.1,
  /** 200 ft between towers, at the Attic pous. §4.5. */
  towerSpacing: 59.2,
  /** "Each of four storeys." */
  towerStoreys: 4,
  /** Appian's stabling, for the record the probe checks the gallery's capacity against. */
  elephants: 300,
  horses: 4000,
  foot: 20000,
  cavalry: 4000,
} as const;

/** Half the built thickness. Almost every caller wants this and not the whole. */
const HALF_T = PUNIC.mainThickness * 0.5;

/**
 * Face batter of the main wall, inward lean per metre of rise.
 *
 * Not from Appian. The surviving Punic curtain on the Byrsa and the contemporary Hellenistic
 * fortifications at Selinus and Syracuse are built in header-and-stretcher ashlar with a
 * pronounced battered plinth and a near-vertical face above it; 1-in-40 above the plinth is
 * the shallow end of that range and is chosen because a steeper batter eats the walkway.
 * Rome's curtain uses 1-in-30 for the same reason. See `walkGeometry`.
 */
const BATTER = 0.04;

/** Battered ashlar plinth: the *euthynteria* and the courses above it. */
const PLINTH_H = 1.75;
const PLINTH_PROJECT = 0.55;
const PLINTH_BATTER = 0.10;

/**
 * The parapets.
 *
 * Both faces get one, which the Aurelian curtain does not: a wall this wide is a fighting
 * platform rather than a walkway, and men manoeuvring five deep on it need something on the
 * city side that is not a fourteen-metre drop. The outer is thick enough to shelter a man
 * behind a merlon; the inner is a chest-high kerb.
 */
const PARAPET_T = 1.2;
const PARAPET_H = 2.2;
const INNER_PARAPET_T = 0.8;
const INNER_PARAPET_H = 1.2;

/** Body radius of a man, from `resolveCrowding`. He may not stand inside the stonework. */
const BODY = 0.42;

// ---------------------------------------------------------------------------
// The casemate
// ---------------------------------------------------------------------------

/**
 * The two masonry skins that carry the hollow wall, measured along the outward normal.
 *
 * Appian says the wall was hollow; he does not say how thick the skins were. These come from
 * the load: 3.26 m of solid masonry plus a fighting platform has to be carried over a 4.6 m
 * span on two barrel vaults, and a 2.3 m field skin is the thinnest that also survives being
 * hit — it is thicker than the whole Aurelian curtain Richmond measured.
 *
 * `field + gallery + city` must equal `mainThickness`, and `assertSection` proves it does.
 */
const SKIN_FIELD = 1.5;
const SKIN_CITY = 1.2;
const GALLERY_W = PUNIC.mainThickness - SKIN_FIELD - SKIN_CITY;

/**
 * The two storeys inside the wall.
 *
 * Lower is Appian's elephant stalls: a Carthaginian war elephant is *Loxodonta africana
 * cyclotis*, the North African forest elephant, about 2.5 m at the shoulder, so a 2.9 m
 * springing on a 2.3 m barrel gives 5.2 m to the crown and a beast can be led under it
 * wearing a tower. Upper is the horse lines and the barrack, which need only headroom.
 */
/**
 * Solid footing below the lower floor. §4.4's arithmetic leaves exactly this much, and it is
 * the reason the elephants need a ramp: the stalls are three and a half metres up.
 */
const FOOTING_H = 3.5;
/** Lower vault: clear to the crown. An African forest elephant with a mahout needs 4 m+. */
const STALL_CLEAR = 4.6;
/** Vault between the two levels, and the slab under the wall-walk. §4.4. */
const GALLERY_SLAB = 1.0;
const WALK_SLAB = 1.0;
/** Upper gallery: clear to the crown. */
const UPPER_CLEAR = 3.6;

const STALL_FLOOR = FOOTING_H;
const STALL_CROWN = STALL_FLOOR + STALL_CLEAR;
const UPPER_FLOOR = STALL_CROWN + GALLERY_SLAB;
const UPPER_CROWN = UPPER_FLOOR + UPPER_CLEAR;
/** Masonry between the upper vault's crown and the wall-walk. */
const CASEMATE_COVER = PUNIC.mainHeight - UPPER_CROWN;

/**
 * Along-wall pitch of one stall bay, and the clear width of its door.
 *
 * 3.6 m is a stall an elephant can be backed into and turned in a 4.6 m gallery; the
 * 2.6 m door is the width Appian's animals have to come *out* through. It also sets the
 * rhythm the wall reads by: at the wall camera's 90 m this is a 4-pixel-per-metre arcade,
 * which is metre-scale geometry and survives the mip chain, where a 55 mm course does not.
 */
const STALL_PITCH = 6.6;
const STALL_DOOR_W = 3.2;

/**
 * Minimum clear rise from the gallery floor to the wall-walk before a bay may be hollowed.
 *
 * The gallery's floor follows the *lowest* ground under a bay and the walk follows the
 * *highest*, so on a slope the cover over the upper vault thins. Below this the bay is built
 * solid, which is what a real builder does and is why the hollow runs in stretches.
 */
const CASEMATE_MIN_RISE = UPPER_CROWN + WALK_SLAB * 0.8;

// ---------------------------------------------------------------------------
// The outworks
// ---------------------------------------------------------------------------

/**
 * The belt, front to back, as offsets along the outward normal from the main wall's
 * centreline. `docs/CARTHAGE.md` §4.2 gives the clear gaps; these are the sums.
 *
 * The headline this exists to deliver is **12.4×**, and it is a depth ratio, not a height
 * one. Every height in the spec's comparison table is under 2.1× Rome's; what changes is the
 * *number of things between the attacker and the city*. Nothing here should be scaled up.
 */
const HALF_T_NOM = PUNIC.mainThickness * 0.5;
/** Outer face of the main wall. */
const MAIN_FACE = HALF_T_NOM;
/** §4.2 row 5: killing ground, 18 m of it, overlooked from 16 m by a wall nobody has touched. */
const KILLING_GROUND = 18.0;
/** §4.2 row 4: plain ashlar, no casemates, no towers. */
const MIDDLE_T = 4.0;
const MIDDLE_H = 8.0;
const MIDDLE_PARAPET = 1.8;
const MIDDLE_OFF = MAIN_FACE + KILLING_GROUND + MIDDLE_T * 0.5;
/** §4.2 row 3. */
const OUTWORK_GAP = 12.0;
/** §4.2 row 2: earth and rubble, stone-revetted on the ditch face, palisade on the crest. */
const RAMPART_T = 6.0;
const RAMPART_H = 4.0;
const PALISADE_H = 1.8;
const OUTER_OFF = MIDDLE_OFF + MIDDLE_T * 0.5 + OUTWORK_GAP + RAMPART_T * 0.5;
/** §4.2 row 1. */
const BERM = 5.0;
/** §4.2 row 0: dry, V-profile with a 2 m flat bottom. */
const DITCH_W = 20.0;
const DITCH_D = 6.0;
const DITCH_INNER_LIP = OUTER_OFF + RAMPART_T * 0.5 + BERM;
const DITCH_OFF = DITCH_INNER_LIP + DITCH_W * 0.5;
/** Ditch lip to the back of the main wall. The spec's 74.1 m, and `assertSection` proves it. */
const BELT_DEPTH = DITCH_INNER_LIP + DITCH_W + MAIN_FACE;

/**
 * How far from the gate axis the triple belt runs.
 *
 * The spec puts it across the whole isthmus — "no way round" (§8.4). On this map the circuit
 * is Rome's and both ends die in terrain the belt has no business standing on, so it stops
 * 120 m short of each and the ends of the circuit carry the main wall alone, which is also
 * what the seaward stretch of the real city did.
 */
const TRIPLE_END_MARGIN = 120;

/**
 * The least the main wall's walk must stand above a forward line's merlons.
 *
 * Four metres is a man plus his shield plus the arc of a thrown stone: enough that a party
 * that has taken the outwork is being shot down at rather than across.
 */
const MIN_COMMAND = 4.0;

/** One outwork bay. Half a tower interval, so the two lines step in step with the main wall. */
const OUTWORK_PITCH = PUNIC.towerSpacing * 0.5;

interface OutworkSpec {
  id: 'outer' | 'middle';
  /** Offset along the outward normal from the main wall's centreline. */
  off: number;
  /** Height of the walk above its own footing. */
  height: number;
  thickness: number;
  parapetH: number;
  /** Where this line's passage crosses, as a lateral offset from the gate axis. */
  gateShift: number;
  /** True where the crest carries a timber palisade rather than a merlon line. */
  palisade: boolean;
}

/**
 * The two forward lines.
 *
 * Their passages are **staggered**: §4.5 requires that a ram cannot see daylight through the
 * three openings, and 8 m of lateral offset per line does it — a column bound for the main
 * gate turns four times inside 74 m with a wall on both sides of it. The spec calls that
 * single decision worth more to the map than any texture, and it is the only part of the gate
 * that costs nothing to build.
 */
const OUTWORKS: readonly OutworkSpec[] = [
  {
    id: 'outer', off: OUTER_OFF, height: RAMPART_H, thickness: RAMPART_T,
    parapetH: PALISADE_H, gateShift: -8, palisade: true,
  },
  {
    id: 'middle', off: MIDDLE_OFF, height: MIDDLE_H, thickness: MIDDLE_T,
    parapetH: MIDDLE_PARAPET, gateShift: +8, palisade: false,
  },
];

/**
 * The gallery access ramp: 1 in 6, per §4.4, and wide enough for the beast that uses it.
 */
const GALLERY_RAMP_GRADE = 6;
const GALLERY_RAMP_W = 4.4;

/** Clear width of a passage through an outwork, and of a postern in the main wall. */
const PASSAGE_W = 6.0;
/** A postern through an outwork every this many of its bays. */
const POSTERN_EVERY = 4;

// ---------------------------------------------------------------------------
// Towers, gate and ramps
// ---------------------------------------------------------------------------

/**
 * Four storeys, Appian says, and `docs/CARTHAGE.md` §4.5 gives the built figures.
 *
 * 20.0 m to the top storey's walk and 22.5 m to its merlons, on an 11 × 11 m footprint
 * projecting 5.5 m past the outer face. That is 6.6 m clear above the wall-walk — Rome's
 * towers stand 13.8 m and there are fifty of them, so the silhouettes are deliberately
 * different objects: **Rome's wall is a serrated line, Carthage's is a row of keeps joined by
 * a rampart.** Only 1.6× the height, and a third of the number.
 */
const TOWER_TOP = 20.0;
const TOWER_MERLON = 22.5;
const TOWER_STOREY = TOWER_TOP / PUNIC.towerStoreys;
const TOWER_W = 11.0;
const TOWER_PROJECT = 5.5;
/** Height of the tower's own top above the bay's crest, for an obstacle box. */
const TOWER_RISE = TOWER_MERLON - PUNIC.mainHeight - PARAPET_H;

/**
 * The ramp onto the wall.
 *
 * Punic and Hellenistic practice is a broad masonry ramp built against the inner face, not a
 * timber stair — the Byrsa's own casemate blocks are reached that way and so is every gate
 * tower at Selinus. 0.26 on 0.45 is 30°, shallower than Rome's 34.6° because there is 61.6 m
 * of bay to run in instead of 35.5, and because these ramps have to take horses.
 */
const RAMP_RISE = 0.26;
const RAMP_TREAD = 0.45;
/** Three men abreast, or one horse with a man each side. */
const RAMP_W = 3.4;
const RAMP_PARAPET_W = 0.5;
const RAMP_PARAPET_H = 1.0;
/** Level landing where the ramp meets the walk. */
const RAMP_LANDING = 2.6;
/** Longest ramp worth building; past this the ground has fallen away and the bay gets none. */
const RAMP_MAX_RUN = 34;

/**
 * The gatehouse block: two square towers with the passage between them.
 *
 * §4.5 makes a gate "not a door, it is a 90 m tunnel through the whole belt" — a bridged
 * ditch, a gap in the outwork, a gap in the middle wall, and only then the leaves. The three
 * forward openings are laterally offset so a ram cannot see through; that lives in
 * `OUTWORKS[].gateShift` and in `gateAxes` below.
 */
const GATE_BLOCK_W = 30;
const GATE_BLOCK_D = PUNIC.mainThickness + 7.5;
const GATE_PASS_W = 5.2;
const GATE_PASS_H = 8.0;
const GATE_ATTIC = 5.4;
const GATE_MERLON_H = 2.1;
/**
 * Where the three gates cross, as offsets in x from the map's own gate axis.
 *
 * §4.5 puts the Porta Byrsae on the isthmus road, the Porta Uticensis 560 m north and the
 * Porta Maritima 760 m south. Those are positions on *Carthage's* survey; on this circuit
 * they are offsets from `GATE_X`, clamped to the wall, and the main gate keeps the axis so
 * `getGates()[0]` is still the one the siege train is pointed at.
 */
const GATE_AXES: readonly { id: string; shift: number; leaves: boolean }[] = [
  { id: 'porta-byrsae', shift: 0, leaves: true },
  { id: 'porta-uticensis', shift: 560, leaves: false },
  { id: 'porta-maritima', shift: -560, leaves: false },
];
/** How far behind the outer face the leaves hang. A Punic gate passage is a long one. */
const GATE_DOOR_SET = 3.4;
const GATE_DOOR_SILL = 0.14;
const GATE_DOOR_T = 0.26;

// ---------------------------------------------------------------------------
// Published records
// ---------------------------------------------------------------------------

/**
 * One hollow stretch of the main wall: the two-storey gallery inside it.
 *
 * Published because it is the thing that makes this wall a different object, and because
 * **whether it is enterable is a policy decision this record has to state rather than
 * imply.** See `enterable`.
 */
export interface CasemateOut {
  /** Index of the `GarrisonBay` this gallery runs inside. */
  bay: number;
  /** Centreline of the gallery in plan, at its two ends. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Along-run unit vector and outward normal, matching the bay's. */
  dx: number;
  dz: number;
  nx: number;
  nz: number;
  /** Offset of the gallery's centreline from the bay centreline, along the normal. */
  centreOff: number;
  /** Clear width between the two skins. */
  width: number;
  /** Absolute Y of the lower (elephant) floor and of the upper (horse and barrack) floor. */
  lowerFloorY: number;
  upperFloorY: number;
  /** Clear height to the crown of each barrel vault. */
  lowerCrown: number;
  upperCrown: number;
  /** Stalls in this stretch, at `STALL_PITCH`. Both storeys, so twice the along-run count. */
  stalls: number;
  /**
   * Whether a man may be **inside** this gallery as far as movement is concerned.
   *
   * **True for the lower vault**, which `docs/CARTHAGE.md` §4.4 settles by arithmetic:
   * 4,434 m of wall at a 6.4 m internal span is 28,378 m² a level, and Appian's 300
   * elephants take 94 m² each — six times what an elephant needs. The stabling is real, so
   * the space is real, so the space is playable. The same arithmetic kills the barracks at
   * 0.52 m² a man, which is why the upper level is built as a fighting gallery and not a
   * dormitory.
   *
   * **How it is made enterable, and the one asymmetry that is deliberate.** The obstacle box
   * set gets *two* boxes per hollow bay — the field skin and the city skin — with the
   * corridor between them open, and that is what the pathfinder and the collision surface
   * both read. The 4 m occupancy raster keeps the whole wall solid, because a 1.5 m skin is
   * not representable in a 4 m cell and painting the skins would leave a 2.4 m hole clean
   * through the curtain in `blocksMovement`.
   *
   * That is a disagreement, and it is the *safe* direction of one. `blocksMovement` answers
   * "does a straight line between two points cross masonry", and a line crossing this wall
   * does cross masonry — the skins. Saying so is conservative: it can make a missile check
   * pessimistic, it can never route a man into stone. The direction that has actually cost
   * this project time is the opposite one, where the raster was open and the boxes were not
   * and units were routed at a gate the collision surface did not open.
   */
  enterable: boolean;
  /** Where the gallery is entered from the city, along the run from `x0`, or null. */
  entranceAt: number | null;
}

/** One of the two forward lines of the triple wall, as a thing that stops men and arrows. */
export interface OutworkOut {
  id: 'outer' | 'middle';
  /** Index within this line, west to east. */
  index: number;
  /**
   * The `GarrisonBay` that stands directly behind this bay, so nothing has to do a spatial
   * query to find out what commands it.
   *
   * Published for the same reason `WallStair.bay` is, and it is not cosmetic: the outwork is
   * offset up to 41.6 m along the normal, and where the wall line bends the hardest that is
   * **19 m of x** — most of a bay. Deriving it twice put the builder's command clamp on one
   * bay and the probe's command test on its neighbour, and the disagreement read as a wall
   * standing 4.8 m over the one behind it.
   */
  bay: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  dx: number;
  dz: number;
  nx: number;
  nz: number;
  /** Half-thickness, so a consumer stamping an obstacle does not need the constant. */
  halfThickness: number;
  /** Absolute Y of the walk and of the top of the merlons. */
  walkY: number;
  crestY: number;
  /**
   * Where a passage cuts this bay, as an offset along its run from `x0`, or null for solid.
   *
   * **Not a boolean.** It was one, and a boolean voided the whole 29.7 m bay for a 6 m gap —
   * which silently threw away the entire point of §4.5's staggered openings, because an
   * opening 29.7 m wide is in line with everything. The one assertion that tests the thing
   * the spec calls "worth more to this map than any texture" was the one that caught it.
   */
  passageAt: number | null;
  /** True where the line gives out here because the ground rises past what can be commanded. */
  standsDown: boolean;
  /** True where the crest carries a timber palisade rather than a merlon line. */
  palisade: boolean;
}

/** The ditch, as a request to whoever owns the heightfield. See `CarthageWallOutput.ditch`. */
export interface CarthageDitch {
  /** Centreline of the ditch, in world space, west to east. */
  path: readonly { x: number; z: number }[];
  width: number;
  depth: number;
  /** Width of the flat bottom of the V. */
  bottomWidth: number;
  /** Offset of the centreline from the main wall, along the outward normal. */
  offset: number;
  /** Always false. Nothing here cuts terrain. */
  built: false;
}

export interface CarthageWallOutput extends WallBuildOutput {
  /** The hollow stretches of the main wall. See `CasemateOut`. */
  casemates: readonly CasemateOut[];
  /** The outer and middle lines. See `OutworkOut`. */
  outworks: readonly OutworkOut[];
  /**
   * Absolute Y of the top of the outer or middle line at a point, or `-Infinity`.
   *
   * A closure rather than a table because `CitySystem.masonryTopAt` is a per-projectile hot
   * path and this has to be O(1): both lines are indexed by the same arithmetic in x that
   * `bayAt` uses. Without it an arrow lofted at the outer wall passes through two lines of
   * masonry and buries itself in the glacis behind them.
   */
  outworkTopAt(x: number, z: number): number;
  /** Extra height of a curtain tower above the bay crest, for the obstacle box. */
  towerRise: number;
  /**
   * What the 4 m occupancy raster is painted from, as opposed to `blockers`, which is what
   * the oriented-box set is built from.
   *
   * They are the same list on a solid wall and they differ on a hollow one: the boxes express
   * the casemate and the raster cannot. See `CasemateOut.enterable` for why the difference is
   * in the safe direction.
   */
  occBlockers: readonly Blocker[];
  /**
   * The ditch, as a **request** rather than as geometry.
   *
   * §4.2 puts a 20 × 6 m dry ditch in front of the outwork and it is 27% of the belt's depth.
   * It cannot be built here: a ditch is a cut in the heightfield and `src/terrain/` is not
   * this workstream's, and a trench liner emitted at the right depth would simply be buried
   * by the ground it is supposed to be cut into. So the plan and the profile are published
   * for whoever owns the terrain, and the built belt is honestly 54.1 m and not 74.1 m until
   * that lands. Saying which is which is the point of publishing it.
   */
  ditch: CarthageDitch;
  /**
   * Every posted result of `assertSection`, so a probe can read the builder's own arithmetic
   * instead of re-deriving it. Empty means the section closes.
   */
  sectionFaults: readonly string[];
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

interface Frame {
  nx: number;
  nz: number;
  dx: number;
  dz: number;
  len: number;
}

/**
 * Local frame of a run. A run heading +X has its outward side toward −Z, i.e. toward the
 * attacker's deployment — identical to `wall.ts`'s `frameOf`, and deliberately the same
 * convention so a consumer that reads one reads the other.
 */
function frameOf(x0: number, z0: number, x1: number, z1: number): Frame {
  const len = Math.hypot(x1 - x0, z1 - z0) || 1;
  const dx = (x1 - x0) / len;
  const dz = (z1 - z0) / len;
  return { nx: dz, nz: -dx, dx, dz, len };
}

interface MainBay {
  index: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Quantised construction level of the wall-walk, absolute. */
  walkY: number;
  /** Lowest and highest terrain under the run. */
  gMin: number;
  gMax: number;
  frame: Frame;
  isGate: boolean;
  /** Gallery inside this bay, or null where the ground leaves no cover over the vault. */
  casemate: CasemateOut | null;
  /** Along-run offset of a postern through this bay from `x0`, or null. */
  posternAt: number | null;
}

/**
 * Where a man may stand on the main wall.
 *
 * The single source of truth for the walk, called by the geometry builder and by the
 * garrison API, because deriving it twice is how Rome's garrison ended up standing a third
 * of a metre inside its own masonry.
 */
function walkGeometry(bay: MainBay): {
  walkY: number;
  crestY: number;
  sillY: number;
  parapetInner: number;
  parapetOuter: number;
  innerOff: number;
  outerOff: number;
} {
  const rise = Math.max(0, bay.walkY - (bay.gMin + PLINTH_H));
  // The outer face leans back over the lift, so the walk's outer lip is inboard of the
  // nominal half-thickness by the batter times that rise.
  const walkOuter = HALF_T - BATTER * rise;
  const innerLip = -(HALF_T - 0.025);
  return {
    walkY: bay.walkY,
    crestY: bay.walkY + PARAPET_H,
    // A solid sill is laid across the walk and the merlons stand on it.
    sillY: bay.walkY + 0.65,
    parapetInner: walkOuter - PARAPET_T,
    parapetOuter: walkOuter,
    // The cityward limit clears the inner parapet, which the Aurelian curtain has not got.
    innerOff: innerLip + INNER_PARAPET_T + BODY,
    outerOff: walkOuter - PARAPET_T - BODY,
  };
}

/**
 * Where a ramp would stand on this bay, or null if one cannot.
 *
 * Pure in `heightAt` so `buildCarthageWall` calls it once and hands the answer both to the
 * stone and to the published `WallStair`. Fixed-point in three passes, a fixed count rather
 * than a convergence test so the result is deterministic whether or not it settles: the run
 * and the foot are mutually dependent, because a longer ramp reaches further along the bay
 * where the ground is at a different height.
 */
function rampPlan(
  bay: MainBay,
  headTower: boolean,
  heightAt: (x: number, z: number) => number
): WallStair | null {
  const f = bay.frame;
  const walkY = bay.walkY;
  // Centreline of the treads, hard against the inner face and reaching into the intervallum
  // by the ramp's own width.
  const off = -(HALF_T + RAMP_W * 0.5);
  const at = (t: number, o: number): { x: number; z: number } => ({
    x: bay.x0 + f.dx * t + f.nx * o,
    z: bay.z0 + f.dz * t + f.nz * o,
  });
  /**
   * Where the head of the rake stands, measured along the run from the bay's west end.
   *
   * It has to clear the landing always and the tower only when there is one. Towers now
   * stand at every *other* bay, and pretending otherwise costs the whole flight: a 30 cubit
   * rise at 30° is a 24 m rake, a bay is 31.8 m, and reserving 5.7 m for a tower that is not
   * there fails the fit test on every bay on the circuit. Ramps are placed on odd bays for
   * exactly this reason — see the cadence in `buildCarthageWall`.
   */
  const headT = (headTower ? TOWER_W * 0.5 + 1.2 : 1.4) + RAMP_LANDING;

  let run = 12;
  let footG = 0;
  let n = 0;
  for (let pass = 0; pass < 3; pass++) {
    const p = at(headT + run, off);
    footG = heightAt(p.x, p.z);
    const rise = walkY - footG;
    if (rise < 2.5) return null;
    n = Math.max(8, Math.round(rise / RAMP_RISE));
    run = n * RAMP_TREAD;
  }
  if (run > RAMP_MAX_RUN) return null;
  // Ramp, landing and a metre of clearance all have to fit inside the bay.
  if (headT + run > f.len - 1.0) return null;

  const foot = at(headT + run, off);
  const head = at(headT, off);
  /**
   * Where the landing delivers onto the walk.
   *
   * Taken **from `walkGeometry`'s own `innerOff`** rather than from a hand-chosen offset off
   * the inner lip. The obvious `-(HALF_T - 1.1)` was tried and is 4.5 cm *outside* the clear
   * band, because the band's cityward limit is the inner parapet plus a body radius and not
   * the lip — so a man stepping off the ramp stood inside the kerb, which the probe caught
   * and prose would not have. Two numbers derived separately from the same section is this
   * file's most reliable way of producing a bug.
   */
  const top = at(headT - RAMP_LANDING * 0.5, walkGeometry(bay).innerOff + 0.35);

  return {
    bay: bay.index,
    footX: foot.x, footY: footG, footZ: foot.z,
    headX: head.x, headY: walkY, headZ: head.z,
    topX: top.x, topY: walkY, topZ: top.z,
    // Foot → head climbs back along the bay, i.e. against the run direction.
    dx: -f.dx, dz: -f.dz,
    nx: f.nx, nz: f.nz,
    width: RAMP_W,
    run,
    rise: walkY - footG,
    steps: n,
    // Every ramp on this circuit is built against the inner face.
    side: -1,
  };
}

/**
 * Does the section close?
 *
 * A list of faults rather than a throw, published on the output, because a build-time
 * `console.warn` is invisible to a probe and an exception takes the page down. Every one of
 * these is arithmetic the comments above assert in prose, and prose does not run.
 */
function assertSection(): string[] {
  const f: string[] = [];
  const sum = SKIN_FIELD + GALLERY_W + SKIN_CITY;
  if (Math.abs(sum - PUNIC.mainThickness) > 1e-9) {
    f.push(`section sums to ${sum.toFixed(4)} m, not ${PUNIC.mainThickness.toFixed(4)}`);
  }
  // §4.4: 3.5 + 4.6 + 1.0 + 3.6 + 1.0 = 13.7. If this does not close, the vault crown is
  // inside the wall-walk and no amount of geometry will hide it.
  const stack = FOOTING_H + STALL_CLEAR + GALLERY_SLAB + UPPER_CLEAR + WALK_SLAB;
  if (Math.abs(stack - PUNIC.mainHeight) > 1e-9) {
    f.push(`casemate stack sums to ${stack.toFixed(4)} m, not ${PUNIC.mainHeight.toFixed(4)}`);
  }
  if (Math.abs(CASEMATE_COVER - WALK_SLAB) > 1e-9) {
    f.push(`cover over the upper vault is ${CASEMATE_COVER.toFixed(3)} m, not ${WALK_SLAB}`);
  }
  // §4.2: 74.1 m from the ditch's outer lip to the back of the main wall.
  if (Math.abs(BELT_DEPTH - 74.1) > 0.05) {
    f.push(`belt is ${BELT_DEPTH.toFixed(2)} m deep, not the spec's 74.1`);
  }
  // §4.3: 9.1 − 1.2 − 0.8 = 7.1 m of clear masonry on the walk.
  const clear = PUNIC.mainThickness - PARAPET_T - INNER_PARAPET_T;
  if (Math.abs(clear - 7.1) > 1e-9) f.push(`clear walk is ${clear.toFixed(2)} m, not 7.1`);
  // Five ranks at the sim's interlocking pitch is what `MAX_WALL_RANKS` asks for; the band
  // a *man* gets is the clear masonry less a body radius at each end.
  const band = clear - 2 * BODY;
  if (band < 5 * 0.72) f.push(`standing band ${band.toFixed(2)} m holds under five ranks`);
  if (STALL_DOOR_W + 0.6 > STALL_PITCH) f.push('stall doors overlap their own piers');
  if (GATE_PASS_W + 1.0 > GATE_BLOCK_W * 0.5) f.push('gate passage wider than its own pier');
  // The whole point of the staggered openings: no straight line through the belt.
  for (const a of OUTWORKS) {
    for (const b of OUTWORKS) {
      if (a === b) continue;
      if (Math.abs(a.gateShift - b.gateShift) < PASSAGE_W) {
        f.push(`${a.id} and ${b.id} passages are in line — a ram can see the leaves`);
      }
    }
    if (Math.abs(a.gateShift) < PASSAGE_W) {
      f.push(`${a.id} passage is in line with the main gate`);
    }
  }
  return f;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Where the circuit runs — **an argument, because there were three answers and only one
 * could be true.**
 *
 * This wall was developed as a swap onto Rome's line, so it read `WALL_X_MIN`, `WALL_X_MAX`
 * and `GATE_X` out of the Campus Martius' `layout.ts`. Meanwhile the Carthage map published
 * `carthageWallZ`, graded a 40 m bench under it and had the vegetation scatter clear its
 * glacis — and `city/carthage/circuit.ts` published a third line, the same three surveyed
 * anchors interpolated linearly and then bowed 25 m toward the field.
 *
 * The ruling (see `cityPlan.ts`) is that the masonry moves to the terrain's line, because
 * that is the one the ground was prepared for. Rather than hard-swapping it — which would
 * take the `?fort=carthage` development rig, and `probe-carthage-wall`'s 44 assertions with
 * it, off the circuit they were measured on — the line is a parameter and Rome's is the
 * default. Carthage's plan passes the terrain's.
 *
 * **`zAt` must be single-valued in x and its slope bounded**, because `CitySystem.bayAt`
 * indexes bays by arithmetic in x. `carthageWallZ` rises 121 m across 1,981 m, a 6 % skew.
 */
export interface WallLine {
  /** West/south end of the frontage. Beyond it the land wall does not exist. */
  xMin: number;
  /** East/north end. */
  xMax: number;
  /** Where the principal gate — the one with leaves, the one the ram is driven at — stands. */
  gateX: number;
  /** Centreline z for each x. */
  zAt: (x: number) => number;
}

/**
 * Rome's Aurelian line, which is where the Punic wall was built and graded.
 *
 * Reproduces exactly what this function did before the line became a parameter: the same
 * `fitWallPath` nodes at the same 55 m spacing, interpolated the same way. Kept so the
 * `?fort=carthage` rig and its probe measure an unchanged wall.
 */
function aurelianLine(heightAt: (x: number, z: number) => number): WallLine {
  const p: WallNode[] = fitWallPath(heightAt);
  return {
    xMin: WALL_X_MIN,
    xMax: WALL_X_MAX,
    gateX: GATE_X,
    zAt: (x: number): number => {
      if (x <= p[0].x) return p[0].z;
      const last = p[p.length - 1];
      if (x >= last.x) return last.z;
      const span = p[1].x - p[0].x;
      const i = Math.min(p.length - 2, Math.floor((x - p[0].x) / span));
      const t = (x - p[i].x) / (p[i + 1].x - p[i].x);
      return lerp(p[i].z, p[i + 1].z, t);
    },
  };
}

export function buildCarthageWall(
  heightAt: (x: number, z: number) => number,
  rngSeed: string,
  line?: WallLine
): CarthageWallOutput {
  const rng = new Rng(rngSeed);
  const spec = line ?? aurelianLine(heightAt);
  const WALL_X_MIN = spec.xMin;
  const WALL_X_MAX = spec.xMax;
  const WALL_LENGTH = WALL_X_MAX - WALL_X_MIN;
  const GATE_X = spec.gateX;
  const zAt = spec.zAt;

  /**
   * The circuit as nodes, at the same 55 m spacing `fitWallPath` uses.
   *
   * Published on `WallBuildOutput.path` and read by the insula generator; sampled rather than
   * taken from the caller so the two cities' outputs have the same shape whichever line they
   * were built on.
   */
  const path: WallNode[] = [];
  {
    const n = Math.round(WALL_LENGTH / 55) + 1;
    for (let i = 0; i < n; i++) {
      const x = WALL_X_MIN + (i * WALL_LENGTH) / (n - 1);
      const z = zAt(x);
      path.push({ x, z, ground: heightAt(x, z) });
    }
  }

  /**
   * Bays step at **one** plethron; towers stand at **two**, which is Appian's figure.
   *
   * The obvious reading — one bay per tower, 61.6 m — was built first and measured: the walk
   * is `mainHeight` over the highest ground in its run, so a 61.6 m run crossing the Pincian
   * shoulder put the wall **43 m** over the ground at its low end and stepped 21 m at the
   * joint. Rome hits the same wall at 40.55 m with 35.5 m bays and accepts it, but there is
   * no reason to accept twice as much: courses step far more often than towers stand, and
   * halving the run halves both numbers without moving a single tower off Appian's interval.
   *
   * The pitch also has to stay uniform, because `CitySystem.bayAt` is index arithmetic in x
   * and a variable pitch silently returns the wrong bay to every projectile in the game.
   */
  const nBays = Math.max(4, Math.round(WALL_LENGTH / (PUNIC.towerSpacing * 0.5)) & ~1);
  const pitch = WALL_LENGTH / nBays;
  const gateBay = clamp(Math.floor((GATE_X - WALL_X_MIN) / pitch), 1, nBays - 2);
  /**
   * A tower stands at the west end of every *other* bay — 200 ft, §4.5 — and never inside the
   * gatehouse block, which carries its own pair. Keyed on where the block *is*, not on which
   * bay is flagged `isGate`: rounding a gate to the nearest tower is how Rome lost 23 m of
   * curtain beside the Porta Flaminia.
   */
  const towerAt = (bayIndex: number, bayX0: number): boolean =>
    bayIndex % 2 === 0 && Math.abs(bayX0 - GATE_X) > GATE_BLOCK_W * 0.5 + TOWER_W * 0.5;

  // --- the main line ---------------------------------------------------------
  const bays: MainBay[] = [];
  const segments: WallSegmentOut[] = [];
  const blockers: Blocker[] = [];
  const occBlockers: Blocker[] = [];
  const garrisonBays: GarrisonBay[] = [];
  const casemates: CasemateOut[] = [];

  for (let b = 0; b < nBays; b++) {
    const x0 = WALL_X_MIN + b * pitch;
    const x1 = x0 + pitch;
    const z0 = zAt(x0);
    const z1 = zAt(x1);
    let gMin = Infinity;
    let gMax = -Infinity;
    for (let s = 0; s <= 20; s++) {
      const x = lerp(x0, x1, s / 20);
      const g = heightAt(x, zAt(x));
      if (g < gMin) gMin = g;
      if (g > gMax) gMax = g;
    }
    /**
     * The walk is `mainHeight` over the *highest* ground in the run, quantised to a 0.5 m
     * course module.
     *
     * Per bay rather than held over pairs as Rome's is. Rome's circuit is a building site
     * whose levels step in visible lifts; this one is a finished monumental wall, and the
     * reason to quantise at all is that the courses are a real module, not that the work
     * was interrupted. Per-bay also keeps the excess over the lowest ground down, which
     * matters because an escalade has to be able to reach the top of it.
     */
    const walkY = Math.ceil((gMax + PUNIC.mainHeight) / 0.5) * 0.5;
    const bay: MainBay = {
      index: b, x0, z0, x1, z1,
      walkY, gMin, gMax,
      frame: frameOf(x0, z0, x1, z1),
      isGate: b === gateBay,
      casemate: null,
      posternAt: null,
    };
    bays.push(bay);
  }

  // Posterns: the ways an elephant gets out. Every fifth bay and never the gate bay, and
  // published as *open gates* so `CitySystem.pushWallBox` splits the obstacle box and the
  // occupancy raster clears the passage through the exact same code path the Porta
  // Flaminia's carriageway uses. Nothing new had to be taught how to cut a hole in a wall.
  for (const bay of bays) {
    if (bay.isGate || bay.index % 8 !== 5) continue;
    bay.posternAt = bay.frame.len * 0.5;
  }

  /**
   * The gallery, where the ground leaves cover over its upper vault.
   *
   * `entranceAt` is set at **every second tower**, which §4.4 gives as the access cadence —
   * a stair-and-ramp block in the inner face climbing the 3.5 m from the intervallum to the
   * stall floor at 1 in 6, so an elephant or a handcart can use it. Towers stand at every
   * other bay, so every second tower is every fourth bay; the wall-walk ramps take bays
   * `% 4 === 1` and the gallery entrances take `% 4 === 3`, so the two never foul each other
   * on the same stretch of inner face.
   */
  for (const bay of bays) {
    if (bay.isGate) continue;
    if (bay.walkY - bay.gMin < CASEMATE_MIN_RISE) continue;
    const f = bay.frame;
    const centreOff = HALF_T - SKIN_FIELD - GALLERY_W * 0.5;
    const end = (t: number): { x: number; z: number } => ({
      x: bay.x0 + f.dx * t + f.nx * centreOff,
      z: bay.z0 + f.dz * t + f.nz * centreOff,
    });
    const a = end(1.0);
    const c = end(f.len - 1.0);
    const alongStalls = Math.max(1, Math.floor((f.len - 2.0) / STALL_PITCH));
    const cm: CasemateOut = {
      bay: bay.index,
      x0: a.x, z0: a.z, x1: c.x, z1: c.z,
      dx: f.dx, dz: f.dz, nx: f.nx, nz: f.nz,
      centreOff,
      width: GALLERY_W,
      lowerFloorY: bay.gMin + STALL_FLOOR,
      upperFloorY: bay.gMin + UPPER_FLOOR,
      lowerCrown: STALL_CLEAR,
      upperCrown: UPPER_CLEAR,
      // The lower level is the stabling and its magazines; the upper is a fighting gallery
      // and carries no stalls of its own, so this is the along-run count and not twice it.
      stalls: alongStalls,
      enterable: true,
      /**
       * §4.4: an access block at every second tower. Towers stand at every other bay, so
       * that is every fourth — 118.7 m at this pitch, which is the spec's 118 to a metre.
       * Posterns take `% 8 === 5` so the two cadences never land on one bay and cost each
       * other a door; before that split, half the access blocks were being suppressed and
       * the enterable gallery was reachable only every 297 m.
       */
      entranceAt: bay.index % 4 === 3 ? f.len * 0.5 : null,
    };
    bay.casemate = cm;
    casemates.push(cm);
  }

  for (const bay of bays) {
    const f = bay.frame;
    const w = walkGeometry(bay);
    segments.push({
      x1: bay.x0, z1: bay.z0, x2: bay.x1, z2: bay.z1,
      height: PUNIC.mainHeight,
      gate: bay.isGate,
      halfThickness: HALF_T,
    });
    /**
     * The oriented-box set gets the wall's **two skins** where it is hollow and one solid
     * box where it is not, so the casemate is a place a man can be. The raster gets the
     * solid box either way — see `CasemateOut.enterable`, which explains why the two lists
     * differ and why this is the safe direction for them to differ in.
     */
    occBlockers.push({ x1: bay.x0, z1: bay.z0, x2: bay.x1, z2: bay.z1, halfW: HALF_T });
    if (bay.casemate) {
      for (const [off, half] of [
        [HALF_T - SKIN_FIELD * 0.5, SKIN_FIELD * 0.5],
        [-(HALF_T - SKIN_CITY * 0.5), SKIN_CITY * 0.5],
      ] as [number, number][]) {
        blockers.push({
          x1: bay.x0 + f.nx * off, z1: bay.z0 + f.nz * off,
          x2: bay.x1 + f.nx * off, z2: bay.z1 + f.nz * off,
          halfW: half,
        });
      }
    } else {
      blockers.push({ x1: bay.x0, z1: bay.z0, x2: bay.x1, z2: bay.z1, halfW: HALF_T });
    }
    const hasTower = towerAt(bay.index, bay.x0);
    garrisonBays.push({
      index: bay.index,
      x0: bay.x0, z0: bay.z0, x1: bay.x1, z1: bay.z1,
      nx: f.nx, nz: f.nz, dx: f.dx, dz: f.dz, length: f.len,
      // Every bay on this circuit is finished masonry. Carthage in 149 is three years into
      // a siege, not three months into a building programme.
      stage: 'finished',
      walkY: w.walkY,
      groundY: bay.gMin,
      crestY: w.crestY,
      sillY: w.sillY,
      parapetInner: w.parapetInner,
      parapetOuter: w.parapetOuter,
      innerOff: w.innerOff,
      outerOff: w.outerOff,
      // The gatehouse interrupts this run with masonry at its own level, so no rank may be
      // laid across it and the bay stands down as a whole.
      garrisonable: !bay.isGate,
      walkable: true,
      halfThickness: HALF_T,
      towerHalf: hasTower ? TOWER_W * 0.5 : 0,
      hasTower,
      isGate: bay.isGate,
    });
  }

  // --- ramps -----------------------------------------------------------------
  /**
   * One flight every fourth bay — about 127 m of circuit, against Rome's 142 — plus one
   * immediately east of the gate, because a gate always has its own and because that is the
   * bay the assault is aimed at. A wall you can put five ranks on is worth nothing if the
   * garrison cannot get onto it before the ladders do.
   *
   * Odd bays only, so a ramp never runs into the tower at an even bay's west end.
   */
  const stairs: WallStair[] = [];
  for (const bay of bays) {
    if (bay.isGate) continue;
    if (bay.index % 4 !== 1 && bay.index !== gateBay + 1) continue;
    // Not into the gatehouse block, which owns its own stretch of the circuit.
    if (Math.abs(bay.x0 - GATE_X) < GATE_BLOCK_W * 0.5 + RAMP_MAX_RUN) continue;
    const plan = rampPlan(bay, towerAt(bay.index, bay.x0), heightAt);
    if (plan) stairs.push(plan);
  }
  const rampByBay = new Map<number, WallStair>();
  for (const s of stairs) rampByBay.set(s.bay, s);

  // --- the gates -------------------------------------------------------------
  /**
   * Three gates, and each one is a tunnel through the whole belt rather than a door.
   *
   * The main gate keeps the map's own axis, so `getGates()[0]` is still what the siege train
   * is pointed at and `Siege.ts` needs to know nothing about the other two. Only the main one
   * carries leaves; the flanking gates are gatehouses whose passages are barred by masonry,
   * which is what an ancient city does with the gates it is not using during a siege.
   */
  const gateAxes = GATE_AXES.map((ga) => {
    const x = clamp(GATE_X + ga.shift, WALL_X_MIN + 90, WALL_X_MAX - 90);
    const bi = clamp(Math.floor((x - WALL_X_MIN) / pitch), 1, nBays - 2);
    const b = bays[bi];
    const cz = lerp(b.z0, b.z1, clamp((x - b.x0) / b.frame.len, 0, 1));
    return { ...ga, x, z: cz, bay: bi, frame: b.frame };
  });
  const gb = bays[gateBay];
  const gf = gb.frame;
  const gateCz = gateAxes[0].z;
  const gateG = heightAt(GATE_X, gateCz);
  const gates: GateOut[] = gateAxes.map((ga) => ({
    id: ga.id,
    x: ga.x,
    z: ga.z,
    facing: Math.atan2(ga.frame.nx, ga.frame.nz),
    // Shut. The ram has to bring them down; `setGateOpen(id, true)` is what the siege calls.
    open: false,
  }));
  /**
   * The posterns, published as gates that are already **open**.
   *
   * This is the whole mechanism by which a casemate wall is a wall you can pass *through*
   * rather than only over, and it needed no new code anywhere: `CitySystem.pushWallBox`
   * already splits a bay's obstacle box at every open gate, and `CitySystem.init` already
   * clears an open gate's carriageway out of the occupancy raster. Both were written for one
   * gate and neither cares how many there are — which is also how the elephants get out of
   * the stalls Appian puts them in.
   */
  for (const bay of bays) {
    if (bay.posternAt === null) continue;
    const f = bay.frame;
    gates.push({
      id: `postern-${bay.index}`,
      x: bay.x0 + f.dx * bay.posternAt,
      z: bay.z0 + f.dz * bay.posternAt,
      facing: Math.atan2(f.nx, f.nz),
      open: true,
    });
  }

  const gateDoor: GateDoorOut = {
    gateId: gateAxes[0].id,
    x: GATE_X + gf.nx * (GATE_BLOCK_D * 0.5 - GATE_DOOR_SET),
    y: gateG + GATE_DOOR_SILL,
    z: gateCz + gf.nz * (GATE_BLOCK_D * 0.5 - GATE_DOOR_SET),
    nx: gf.nx, nz: gf.nz, dx: gf.dx, dz: gf.dz,
    halfWidth: GATE_PASS_W * 0.5,
    height: GATE_PASS_H - GATE_DOOR_SILL,
    thickness: GATE_DOOR_T,
    setback: GATE_DOOR_SET,
    open: false,
  };
  const gateBlock: GateBlockOut = {
    x: GATE_X, z: gateCz,
    nx: gf.nx, nz: gf.nz, dx: gf.dx, dz: gf.dz,
    halfRun: GATE_BLOCK_W * 0.5,
    halfDepth: GATE_BLOCK_D * 0.5 + 0.5,
    topY: gateG + GATE_PASS_H + GATE_ATTIC + GATE_MERLON_H,
    openHalf: GATE_PASS_W * 0.5,
  };

  // --- the outer and middle lines -------------------------------------------
  const outworks: OutworkOut[] = [];
  const owX0 = WALL_X_MIN + TRIPLE_END_MARGIN;
  const owX1 = WALL_X_MAX - TRIPLE_END_MARGIN;
  const owN = Math.max(2, Math.round((owX1 - owX0) / OUTWORK_PITCH));
  const owPitch = (owX1 - owX0) / owN;

  for (const spec of OUTWORKS) {
    for (let i = 0; i < owN; i++) {
      const x0 = clamp(owX0 + i * owPitch, WALL_X_MIN, WALL_X_MAX);
      const x1 = clamp(x0 + owPitch, WALL_X_MIN, WALL_X_MAX);
      if (x1 - x0 < 1) continue;
      const mf = frameOf(x0, zAt(x0), x1, zAt(x1));
      const a = { x: x0 + mf.nx * spec.off, z: zAt(x0) + mf.nz * spec.off };
      const c = { x: x1 + mf.nx * spec.off, z: zAt(x1) + mf.nz * spec.off };
      const f = frameOf(a.x, a.z, c.x, c.z);
      let gMax = -Infinity;
      for (let s = 0; s <= 8; s++) {
        const g = heightAt(lerp(a.x, c.x, s / 8), lerp(a.z, c.z, s / 8));
        if (g > gMax) gMax = g;
      }
      /**
       * This line's own passages: one per gate, each shifted laterally by `gateShift` so the
       * three openings in the belt are not in line and a ram at the ditch cannot see the
       * leaves. Plus a postern every few bays, so a storming party is never more than half a
       * bay from a way in and the frontage is a defence rather than a lid.
       */
      let passageAt: number | null = null;
      for (const ga of gateAxes) {
        const gx = ga.x + spec.gateShift;
        if (gx < x0 || gx > x1) continue;
        passageAt = ((gx - a.x) * f.dx + (zAt(gx) + f.nz * spec.off - a.z) * f.dz);
      }
      // A postern every few bays, so a storming party is never more than half a bay from a
      // way in and the frontage is a defence rather than a lid.
      if (passageAt === null && i % POSTERN_EVERY === 2) {
        passageAt = Math.hypot(c.x - a.x, c.z - a.z) * 0.5;
      }
      /**
       * Stepped **down** from the wall behind it, and clamped so it stays that way.
       *
       * §4.2's whole arrangement is a stepped system: each line lower than the one behind,
       * so all three can be fought from at once and the main wall dominates everything in
       * front of it. Following the ground alone does not deliver that — the wall line sits on
       * a crest whose fall is not uniform, and measured over the full circuit there are
       * stretches where the ground 41 m out is *higher* than the ground under the main wall.
       * Left alone those bays put a merlon line 4.8 m **above** the wall it is supposed to
       * screen, which hands the attacker a firing step.
       *
       * So the crest is capped at the main wall's walk less `MIN_COMMAND`, and where the
       * ground rises so far that even a 2 m revetment breaks the cap, the line simply gives
       * out and the bay becomes a passage. A forward work that cannot be commanded is not
       * built, which is also what a real engineer does with one.
       */
      // The bay behind this one is found at the outwork's **own** world x, after the offset
      // along the normal has moved it — not at the main-line x it was generated from.
      const backing = clamp(Math.floor(((a.x + c.x) * 0.5 - WALL_X_MIN) / pitch), 0, nBays - 1);
      const mainBay = bays[backing];
      const wanted = Math.ceil((gMax + spec.height) / 0.5) * 0.5;
      const cap = mainBay.walkY - MIN_COMMAND - spec.parapetH;
      const walkY = Math.min(wanted, cap);
      const givesOut = walkY < gMax + 2.0;
      outworks.push({
        id: spec.id,
        index: i,
        bay: backing,
        x0: a.x, z0: a.z, x1: c.x, z1: c.z,
        dx: f.dx, dz: f.dz, nx: f.nx, nz: f.nz,
        halfThickness: spec.thickness * 0.5,
        walkY,
        crestY: walkY + spec.parapetH,
        passageAt,
        standsDown: givesOut,
        palisade: spec.palisade,
      });
    }
  }

  /**
   * O(1) masonry lookup for the two forward lines.
   *
   * Index arithmetic in x against each line's own uniform pitch, then a signed distance to
   * that bay's centreline — the same two steps `CitySystem.masonryTopAt` already does for
   * the main wall, so the cost of the triple wall to a per-projectile hot path is two extra
   * distance tests and no allocation.
   */
  /**
   * `line[id][i]`, so the lookup never assumes a line kept all `owN` of its bays.
   *
   * It does today, but a line clipped by `WALL_X_MIN` would drop one and every index after
   * it would then name the wrong bay — a silent off-by-one in a hot path, which is exactly
   * the class of bug that put a gatehouse over 23 m of open grass.
   */
  const byIndex = new Map<string, (OutworkOut | undefined)[]>();
  for (const spec of OUTWORKS) byIndex.set(spec.id, new Array(owN));
  for (const ow of outworks) byIndex.get(ow.id)![ow.index] = ow;

  const outworkTopAt = (x: number, z: number): number => {
    let best = -Infinity;
    for (const spec of OUTWORKS) {
      const i = Math.floor((x - owX0) / owPitch);
      if (i < 0 || i >= owN) continue;
      const ow = byIndex.get(spec.id)![i];
      if (!ow || ow.standsDown) continue;
      const t = (x - ow.x0) * ow.dx + (z - ow.z0) * ow.dz;
      const px = ow.x0 + ow.dx * t;
      const pz = ow.z0 + ow.dz * t;
      const off = (x - px) * ow.nx + (z - pz) * ow.nz;
      if (Math.abs(off) > ow.halfThickness) continue;
      const len = Math.hypot(ow.x1 - ow.x0, ow.z1 - ow.z0);
      if (t < 0 || t > len) continue;
      // Only the passage itself is a hole, not the bay it is cut in.
      if (ow.passageAt !== null && Math.abs(t - ow.passageAt) <= PASSAGE_W * 0.5) continue;
      if (ow.crestY > best) best = ow.crestY;
    }
    return best;
  };

  // --- chunks ----------------------------------------------------------------
  /**
   * Everything — three lines, towers, gate, ramps and the galleries — goes into the same
   * `Batch` streams inside the same chunks, so a triple wall costs the *same* number of
   * draw calls as a single curtain. `Batch.toMeshes` bakes one mesh per material per detail
   * level, and the material set has not grown: `brick`, `stone`, `timber`, `metal`, `roof`.
   * That is not a cleanup pass, it is the only reason a wall with three times the geometry
   * fits inside a 220-call frame at all.
   */
  const BAYS_PER_CHUNK = 10;
  const chunks: CityChunkSpec[] = [];
  const owByChunk = (cx0: number, cx1: number): OutworkOut[] =>
    outworks.filter((o) => o.x1 > cx0 && o.x0 <= cx1);

  for (let c = 0; c * BAYS_PER_CHUNK < bays.length; c++) {
    const from = c * BAYS_PER_CHUNK;
    const to = Math.min(bays.length, from + BAYS_PER_CHUNK);
    const slice = bays.slice(from, to);
    const spanX0 = slice[0].x0;
    const spanX1 = slice[slice.length - 1].x1;
    const mine = owByChunk(spanX0, spanX1);
    const cx = (spanX0 + spanX1) * 0.5;
    // Pulled toward the field so the sphere covers the outworks as well as the main line;
    // `assertNoStrayGeometry` measures every vertex against this radius.
    const cz = (slice[0].z0 + slice[slice.length - 1].z1) * 0.5 - OUTER_OFF * 0.5;
    const radius = (spanX1 - spanX0) * 0.62 + OUTER_OFF * 0.5 + 58;
    chunks.push({
      name: `wall-${c}`,
      cx, cz, radius,
      castShadow: true,
      lodSwitch: [340, 940],
      build: (batch, detail) => {
        batch.setUvOrigin(cx, 0, cz);
        for (const bay of slice) {
          buildMainBay(batch, detail, bay, heightAt, rng.fork(`bay-${bay.index}`));
          for (const ga of gateAxes) {
            if (ga.bay === bay.index) {
              buildPunicGate(batch, detail, bay, ga.x, ga.z, ga.leaves, heightAt);
            }
          }
          const ramp = rampByBay.get(bay.index);
          if (ramp) buildRamp(batch, detail, bay, ramp, heightAt);
        }
        for (const bay of slice) {
          if (!towerAt(bay.index, bay.x0)) continue;
          const prev = bays[bay.index - 1];
          const topY = Math.max(bay.walkY, prev ? prev.walkY : bay.walkY);
          buildPunicTower(batch, detail, bay, topY, heightAt);
        }
        if (to === bays.length) {
          const last = slice[slice.length - 1];
          buildPunicTower(
            batch, detail,
            { ...last, x0: last.x1, z0: last.z1, index: bays.length },
            last.walkY, heightAt
          );
        }
        for (const ow of mine) buildOutworkBay(batch, detail, ow, heightAt);
      },
    });
  }

  // --- planting --------------------------------------------------------------
  // The intervallum behind the wall was open ground; the orchard belt is further in. Only a
  // sparse line of umbrella pine along the military road, kept well clear of the ramps.
  const trees: TreeRequest[] = [];
  for (let i = 0; i < 120; i++) {
    const x = rng.range(WALL_X_MIN + 40, WALL_X_MAX - 40);
    if (Math.abs(x - GATE_X) < 40) continue;
    trees.push({
      x,
      z: zAt(x) + rng.range(46, 84),
      kind: rng.bool(0.7) ? 'umbrella' : 'cypress',
      scale: rng.range(0.8, 1.15),
    });
  }

  /**
   * The ditch, published rather than built. See the field's own comment on the output type:
   * a 6 m cut belongs to the heightfield and this workstream does not own it.
   */
  const ditchPath: { x: number; z: number }[] = [];
  for (let k = 0; k <= 24; k++) {
    const x = lerp(owX0, owX1, k / 24);
    const b = bays[clamp(Math.floor((x - WALL_X_MIN) / pitch), 0, nBays - 1)];
    ditchPath.push({ x: x + b.frame.nx * DITCH_OFF, z: zAt(x) + b.frame.nz * DITCH_OFF });
  }

  return {
    path,
    chunks,
    segments,
    gates,
    gateBlock,
    gateDoor,
    blockers,
    trees,
    towerCount: bays.filter((b) => towerAt(b.index, b.x0)).length + 1,
    // Every bay of a finished monumental circuit. `BayStage` exists for Aurelian's building
    // site and Carthage has none of it, but the field is on the contract so it is answered.
    bayStages: bays.map(() => 'finished' as const),
    garrisonBays,
    stairs,
    wallZAt: zAt,
    casemates,
    outworks,
    outworkTopAt,
    towerRise: TOWER_RISE,
    occBlockers,
    ditch: {
      path: ditchPath,
      width: DITCH_W,
      depth: DITCH_D,
      bottomWidth: 2.0,
      offset: DITCH_OFF,
      built: false,
    },
    sectionFaults: assertSection(),
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const P0 = new THREE.Vector3();
const P1 = new THREE.Vector3();
const P2 = new THREE.Vector3();
const P3 = new THREE.Vector3();
const NRM = new THREE.Vector3();

/**
 * One bay of the main wall: battered ashlar plinth, two faces, the wall-walk, two parapets,
 * and — where the bay is hollow — the gallery behind an arcade of stall doors.
 *
 * Sub-divided along the run so the plinth follows the ground rather than floating over a
 * dip, which is what a masonry wall does and what a single 61.6 m quad cannot.
 */
function buildMainBay(
  batch: Batch,
  detail: number,
  bay: MainBay,
  heightAt: (x: number, z: number) => number,
  rng: Rng
): void {
  const stone = batch.s('stone');
  const brick = batch.s('brick');
  const f = bay.frame;
  const w = walkGeometry(bay);
  const nSub = detail >= 2 ? Math.max(4, Math.round(f.len / 7)) : detail === 1 ? 4 : 2;

  const at = (t: number): { x: number; z: number } => ({
    x: bay.x0 + f.dx * t,
    z: bay.z0 + f.dz * t,
  });
  const groundAt = (t: number): number => {
    const p = at(t);
    return heightAt(p.x, p.z);
  };

  // --- plinth and body, sub-bay by sub-bay ----------------------------------
  for (let s = 0; s < nSub; s++) {
    const ta = (f.len * s) / nSub;
    const tb = (f.len * (s + 1)) / nSub;
    const a = at(ta);
    const b = at(tb);
    const g = Math.min(groundAt(ta), groundAt(tb));
    const plinthTop = g + PLINTH_H;
    // Squared ashlar, laid in header-and-stretcher. The tone varies course-band by
    // course-band, which is what a quarry-run wall does; the *relief* comes from the
    // material's baked horizon-openness channel, never from painted shade.
    const tone = 0.94 + hash2(s, bay.index, 17) * 0.13;
    const bodyCol = new THREE.Color().copy(PAL.tufa).multiplyScalar(tone);
    const plinthCol = new THREE.Color().copy(PAL.travertine).multiplyScalar(tone * 0.97);

    quadPrism(
      stone, a.x, a.z, b.x, b.z, f.nx, f.nz,
      PUNIC.mainThickness + PLINTH_PROJECT * 2,
      g - 1.6, plinthTop, plinthCol, plinthCol,
      { ends: s === 0 || s === nSub - 1, batter: PLINTH_BATTER, top: false }
    );
    quadPrism(
      stone, a.x, a.z, b.x, b.z, f.nx, f.nz,
      PUNIC.mainThickness,
      plinthTop, bay.walkY, bodyCol, bodyCol,
      { ends: s === 0 || s === nSub - 1, batter: BATTER, top: false }
    );
  }

  // --- the wall-walk ---------------------------------------------------------
  const aEnd = at(0);
  const bEnd = at(f.len);
  const walkCol = new THREE.Color().copy(PAL.travertine).multiplyScalar(1.03);
  P0.set(aEnd.x + f.nx * w.parapetOuter, bay.walkY, aEnd.z + f.nz * w.parapetOuter);
  P1.set(bEnd.x + f.nx * w.parapetOuter, bay.walkY, bEnd.z + f.nz * w.parapetOuter);
  P2.set(bEnd.x - f.nx * (HALF_T - 0.025), bay.walkY, bEnd.z - f.nz * (HALF_T - 0.025));
  P3.set(aEnd.x - f.nx * (HALF_T - 0.025), bay.walkY, aEnd.z - f.nz * (HALF_T - 0.025));
  NRM.set(0, 1, 0);
  stone.quadN(NRM, P0, P1, P2, P3, walkCol, walkCol, walkCol, walkCol);

  // --- parapets --------------------------------------------------------------
  const outerMid = w.parapetOuter - PARAPET_T * 0.5;
  const merlonCol = new THREE.Color().copy(PAL.tufa).multiplyScalar(1.02);
  // A solid sill across the walk with the merlons standing on it: the merlon line is the
  // wall's silhouette and a gap that runs all the way to the deck reads as a broken wall.
  quadPrism(
    stone,
    aEnd.x + f.nx * outerMid, aEnd.z + f.nz * outerMid,
    bEnd.x + f.nx * outerMid, bEnd.z + f.nz * outerMid,
    f.nx, f.nz, PARAPET_T, bay.walkY, w.sillY, merlonCol, merlonCol, { ends: true }
  );
  crenellation(
    stone,
    aEnd.x + f.nx * outerMid, aEnd.z + f.nz * outerMid,
    bEnd.x + f.nx * outerMid, bEnd.z + f.nz * outerMid,
    w.sillY, PARAPET_H - 0.65, PARAPET_T, merlonCol,
    1.55, 0.80, detail >= 1
  );
  // The cityward kerb, which the Aurelian curtain has not got. Solid: men form up against it.
  const innerMid = -(HALF_T - 0.025) + INNER_PARAPET_T * 0.5;
  quadPrism(
    stone,
    aEnd.x + f.nx * innerMid, aEnd.z + f.nz * innerMid,
    bEnd.x + f.nx * innerMid, bEnd.z + f.nz * innerMid,
    f.nx, f.nz, INNER_PARAPET_T,
    bay.walkY, bay.walkY + INNER_PARAPET_H, merlonCol, walkCol, { ends: true }
  );

  // --- string course ---------------------------------------------------------
  /**
   * A projecting string course at the springing of the upper vault, both faces.
   *
   * This is metre-scale geometry and it is the single cheapest thing on the wall: a 0.22 m
   * projection is 3 px of hard shadow line at the wall camera's 90 m, where a 55 mm course
   * is 0.8 px and gone by mip 4. It is also true — a Punic ashlar wall of this height is
   * built in lifts and the lift joint is dressed as a string.
   */
  if (detail >= 1) {
    const stringY = bay.gMin + UPPER_FLOOR;
    if (stringY < bay.walkY - 1.5) {
      const rise = Math.max(0, stringY - (bay.gMin + PLINTH_H));
      const t = PUNIC.mainThickness - 2 * BATTER * rise + 0.44;
      const col = new THREE.Color().copy(PAL.travertine).multiplyScalar(0.99);
      quadPrism(
        stone, aEnd.x, aEnd.z, bEnd.x, bEnd.z, f.nx, f.nz, t,
        stringY, stringY + 0.30, col, col, { ends: false }
      );
    }
  }

  if (bay.casemate && detail >= 1) {
    buildGallery(batch, detail, bay, bay.casemate, rng);
    buildGalleryRamp(batch, detail, bay, bay.casemate, heightAt);
  }
  if (bay.posternAt !== null) buildPostern(batch, detail, bay, heightAt);
  void brick;
}

/**
 * The hollow wall: an arcade of stall doors on the city face, loops on the field face, and
 * two barrel-vaulted galleries behind them.
 *
 * The arcade is the whole point. Appian's three hundred elephants are invisible from the
 * field, but a 61 m run of 2.6 m arches at a 3.6 m pitch is a rhythm nothing on the Aurelian
 * curtain has, and it is the cue that says *this wall has an inside*. It is emitted from
 * detail 1 upward for that reason; the vaults behind it are detail 2 only, because they are
 * only visible through a 2.6 m hole.
 */
function buildGallery(
  batch: Batch,
  detail: number,
  bay: MainBay,
  cm: CasemateOut,
  rng: Rng
): void {
  const stone = batch.s('stone');
  const f = bay.frame;
  const n = Math.max(1, Math.floor((f.len - 2.4) / STALL_PITCH));
  const t0 = (f.len - n * STALL_PITCH) * 0.5;
  const floorY = cm.lowerFloorY;
  const innerFace = -(HALF_T - 0.025);
  const rotY = Math.atan2(-f.nx, -f.nz);
  const voidWarm = new THREE.Color().copy(PAL.voidWarm);
  const voidDark = new THREE.Color().copy(PAL.voidDark);
  const wallCol = new THREE.Color().copy(PAL.tufa).multiplyScalar(0.98);

  for (let i = 0; i < n; i++) {
    const t = t0 + (i + 0.5) * STALL_PITCH;
    const px = bay.x0 + f.dx * t + f.nx * innerFace;
    const pz = bay.z0 + f.dz * t + f.nz * innerFace;

    // Ground storey: the stall door. `archPanel`'s local frame has its front at z = 0
    // looking toward −Z, so the placement rotation faces it at the city, i.e. along +n.
    //
    // The doors stand 3.5 m up, on the solid footing §4.4's arithmetic leaves under the
    // stalls — which is why the elephants need the ramps at every second tower and is the
    // most legible thing on the whole inner face: a raised arcade, not a row of holes.
    stone.push(place(px, floorY, pz, rotY + Math.PI));
    archPanel(stone, STALL_PITCH, STALL_CLEAR + 0.4, wallCol, {
      depth: 1.0,
      spring: STALL_DOOR_W * 0.5 + 1.4,
      openWidth: STALL_DOOR_W,
      segments: detail >= 2 ? 9 : 5,
      voidCol: voidWarm,
      archivolt: detail >= 2 ? 0.16 : 0,
    });
    stone.pop();

    // Upper storey: a light into the fighting gallery. Not a dormitory window — §4.4 rules
    // the barracks out at 0.52 m² a man — so it is sized as an embrasure.
    const upY = cm.upperFloorY;
    stone.push(place(px, upY, pz, rotY + Math.PI));
    archPanel(stone, STALL_PITCH, UPPER_CLEAR + 0.3, wallCol, {
      depth: 0.9,
      spring: 1.4,
      openWidth: 1.6,
      segments: detail >= 2 ? 7 : 4,
      voidCol: voidDark,
      archivolt: detail >= 2 ? 0.10 : 0,
    });
    stone.pop();

    // Field face: a loop into the upper gallery, every other stall. Modelled as a recess
    // rather than painted, because a painted slit has the same contrast in sun and shade
    // and that is the defect this project just finished removing from Rome's brick.
    if (detail >= 2) {
      // §4.4: loopholes at 3.5 m centres in the outer face of the upper level. Two per
      // 6.6 m stall bay. Modelled as recesses, never painted — a painted slit shows the
      // same contrast in sun and in shade, which is the defect just removed from Rome.
      const rise = Math.max(0, upY + 1.4 - (bay.gMin + PLINTH_H));
      const outFace = HALF_T - BATTER * rise;
      for (const sub of [-1, 1]) {
        const tt = t + sub * 1.75;
        const ox = bay.x0 + f.dx * tt + f.nx * outFace;
        const oz = bay.z0 + f.dz * tt + f.nz * outFace;
        quadPrism(
          stone,
          ox - f.dx * 0.14, oz - f.dz * 0.14,
          ox + f.dx * 0.14, oz + f.dz * 0.14,
          f.nx, f.nz, 0.7, upY + 0.8, upY + 2.4, voidDark, voidDark, { ends: false }
        );
      }
    }
  }

  if (detail < 2) return;

  // --- the two barrel vaults -------------------------------------------------
  // Only at full detail: they are 4.6 m inside the wall behind a 2.6 m opening, and every
  // triangle of them is invisible from anywhere the wall is normally seen.
  const co = cm.centreOff;
  const r = GALLERY_W * 0.5;
  const SEG = 6;
  const ends: [number, number][] = [[t0, t0 + n * STALL_PITCH]];
  for (const [ta, tb] of ends) {
    for (const [floor, clear] of [
      [floorY, STALL_CLEAR],
      [cm.upperFloorY, UPPER_CLEAR],
    ] as [number, number][]) {
      /**
       * Springing and rise of the barrel, from the clear height rather than assumed
       * semicircular. A 6.4 m span wants a 3.2 m rise to be a semicircle, which the 3.6 m
       * upper level has no room for, so that one is segmental and the lower one is not.
       */
      const rise = Math.min(GALLERY_W * 0.5, clear - 0.9);
      const spring = clear - rise;
      // Springing walls.
      for (const side of [-1, 1]) {
        const o = co + side * r;
        const ax = bay.x0 + f.dx * ta + f.nx * o;
        const az = bay.z0 + f.dz * ta + f.nz * o;
        const bx = bay.x0 + f.dx * tb + f.nx * o;
        const bz = bay.z0 + f.dz * tb + f.nz * o;
        NRM.set(-side * f.nx, 0, -side * f.nz);
        P0.set(ax, floor, az);
        P1.set(bx, floor, bz);
        P2.set(bx, floor + spring, bz);
        P3.set(ax, floor + spring, az);
        if (side < 0) stone.quadN(NRM, P0, P1, P2, P3, voidWarm, voidWarm, voidWarm, voidWarm);
        else stone.quadN(NRM, P3, P2, P1, P0, voidWarm, voidWarm, voidWarm, voidWarm);
      }
      // The barrel itself, faceted.
      for (let k = 0; k < SEG; k++) {
        const a0 = (Math.PI * k) / SEG;
        const a1 = (Math.PI * (k + 1)) / SEG;
        const o0 = co - Math.cos(a0) * r;
        const o1 = co - Math.cos(a1) * r;
        const y0 = floor + spring + Math.sin(a0) * rise;
        const y1 = floor + spring + Math.sin(a1) * rise;
        P0.set(bay.x0 + f.dx * ta + f.nx * o0, y0, bay.z0 + f.dz * ta + f.nz * o0);
        P1.set(bay.x0 + f.dx * tb + f.nx * o0, y0, bay.z0 + f.dz * tb + f.nz * o0);
        P2.set(bay.x0 + f.dx * tb + f.nx * o1, y1, bay.z0 + f.dz * tb + f.nz * o1);
        P3.set(bay.x0 + f.dx * ta + f.nx * o1, y1, bay.z0 + f.dz * ta + f.nz * o1);
        NRM.set(0, -1, 0);
        stone.quadN(NRM, P3, P2, P1, P0, voidDark, voidDark, voidWarm, voidWarm);
      }
      // Floor of the storey.
      P0.set(bay.x0 + f.dx * ta + f.nx * (co - r), floor, bay.z0 + f.dz * ta + f.nz * (co - r));
      P1.set(bay.x0 + f.dx * tb + f.nx * (co - r), floor, bay.z0 + f.dz * tb + f.nz * (co - r));
      P2.set(bay.x0 + f.dx * tb + f.nx * (co + r), floor, bay.z0 + f.dz * tb + f.nz * (co + r));
      P3.set(bay.x0 + f.dx * ta + f.nx * (co + r), floor, bay.z0 + f.dz * ta + f.nz * (co + r));
      NRM.set(0, 1, 0);
      stone.quadN(NRM, P0, P1, P2, P3, voidWarm, voidWarm, voidWarm, voidWarm);
    }
  }
  void rng;
}

/**
 * The stair-and-ramp block that gets an elephant into the wall.
 *
 * §4.4: an access block in the inner face at every second tower, gradient **1 in 6** so a
 * beast or a handcart can use it. It climbs the 3.5 m of solid footing that the casemate
 * arithmetic leaves under the stall floor, which is 21 m of run — a third of a tower
 * interval, and the reason the wall-walk ramps and these are placed on different bays.
 *
 * This is the thing that makes the interior *reachable*, and without it the enterable
 * casemate is a room with no door. It is emitted as a solid masonry mass rather than as
 * steps: a ramp an elephant can use is a ramp, not a flight.
 */
function buildGalleryRamp(
  batch: Batch,
  detail: number,
  bay: MainBay,
  cm: CasemateOut,
  heightAt: (x: number, z: number) => number
): void {
  if (cm.entranceAt === null) return;
  const stone = batch.s('stone');
  const f = bay.frame;
  const rise = cm.lowerFloorY - bay.gMin;
  if (rise < 0.5) return;
  const run = rise * GALLERY_RAMP_GRADE;
  const t1 = cm.entranceAt;
  const t0 = t1 - run;
  if (t0 < 1.0) return;
  const off = -(HALF_T + GALLERY_RAMP_W * 0.5);
  const col = new THREE.Color().copy(PAL.tufa).multiplyScalar(0.97);
  const capCol = new THREE.Color().copy(PAL.travertine).multiplyScalar(1.02);
  const nSub = detail >= 2 ? 8 : 3;

  for (let k = 0; k < nSub; k++) {
    const ta = lerp(t0, t1, k / nSub);
    const tb = lerp(t0, t1, (k + 1) / nSub);
    const ax = bay.x0 + f.dx * ta + f.nx * off;
    const az = bay.z0 + f.dz * ta + f.nz * off;
    const bx = bay.x0 + f.dx * tb + f.nx * off;
    const bz = bay.z0 + f.dz * tb + f.nz * off;
    const g = Math.min(heightAt(ax, az), heightAt(bx, bz)) - 1.2;
    // A smooth rake, not treads: the top of each sub-panel is the ramp surface at `tb`.
    const yTop = bay.gMin + (rise * (k + 1)) / nSub;
    quadPrism(stone, ax, az, bx, bz, f.nx, f.nz, GALLERY_RAMP_W, g, yTop, col, capCol, {
      ends: k === 0,
    });
  }
  // The mouth: an arch through the city skin at the head of the ramp.
  const px = bay.x0 + f.dx * t1 + f.nx * -(HALF_T - 0.02);
  const pz = bay.z0 + f.dz * t1 + f.nz * -(HALF_T - 0.02);
  stone.push(place(px, cm.lowerFloorY, pz, Math.atan2(-f.nx, -f.nz) + Math.PI));
  archPanel(stone, GALLERY_RAMP_W + 3.0, STALL_CLEAR + 0.4, col, {
    depth: SKIN_CITY + 0.2,
    spring: GALLERY_RAMP_W * 0.5 + 1.0,
    openWidth: GALLERY_RAMP_W,
    segments: detail >= 2 ? 10 : 5,
    voidCol: new THREE.Color().copy(PAL.voidWarm),
    archivolt: detail >= 2 ? 0.18 : 0,
  });
  stone.pop();
}

/**
 * A postern straight through the wall: the way Appian's elephants get out.
 *
 * 6.0 m clear, which is wider than the Porta Flaminia's carriageway and is set by the animal
 * rather than by the man — an elephant in harness needs to turn in it. The passage is
 * published as an already-open `GateOut`, so the obstacle box and the occupancy raster are
 * cut by the same code that opens the main gate.
 */
function buildPostern(
  batch: Batch,
  detail: number,
  bay: MainBay,
  heightAt: (x: number, z: number) => number
): void {
  if (bay.posternAt === null) return;
  const stone = batch.s('stone');
  const f = bay.frame;
  const t = bay.posternAt;
  const cx = bay.x0 + f.dx * t;
  const cz = bay.z0 + f.dz * t;
  const g = heightAt(cx, cz);
  const rotY = Math.atan2(-f.nx, -f.nz);
  const wallCol = new THREE.Color().copy(PAL.tufa);
  const voidWarm = new THREE.Color().copy(PAL.voidWarm);
  const h = Math.min(bay.walkY - g - 1.0, PASSAGE_W * 0.5 + 3.2);

  // Both mouths, each a panel pierced by the passage arch and set into the face.
  for (const side of [-1, 1]) {
    const rise = Math.max(0, g + h - (bay.gMin + PLINTH_H));
    const off = side * (HALF_T - BATTER * rise - 0.05);
    const px = cx + f.nx * off;
    const pz = cz + f.nz * off;
    stone.push(place(px, g, pz, side > 0 ? rotY : rotY + Math.PI));
    archPanel(stone, PASSAGE_W + 4.4, h + 0.9, wallCol, {
      depth: 1.1,
      spring: PASSAGE_W * 0.5 + 1.1,
      openWidth: PASSAGE_W,
      segments: detail >= 2 ? 10 : 5,
      voidCol: voidWarm,
      archivolt: detail >= 2 ? 0.2 : 0,
    });
    stone.pop();
  }
  // The barrel of the passage, so it is a tunnel and not two holes.
  if (detail >= 2) {
    const r = PASSAGE_W * 0.5;
    const spring = g + PASSAGE_W * 0.5 + 1.1;
    for (let k = 0; k < 7; k++) {
      const a0 = (Math.PI * k) / 7;
      const a1 = (Math.PI * (k + 1)) / 7;
      for (const [ang, next] of [[a0, a1]] as [number, number][]) {
        const s0 = -Math.cos(ang) * r;
        const s1 = -Math.cos(next) * r;
        const y0 = spring + Math.sin(ang) * r;
        const y1 = spring + Math.sin(next) * r;
        P0.set(cx + f.dx * s0 - f.nx * HALF_T, y0, cz + f.dz * s0 - f.nz * HALF_T);
        P1.set(cx + f.dx * s0 + f.nx * HALF_T, y0, cz + f.dz * s0 + f.nz * HALF_T);
        P2.set(cx + f.dx * s1 + f.nx * HALF_T, y1, cz + f.dz * s1 + f.nz * HALF_T);
        P3.set(cx + f.dx * s1 - f.nx * HALF_T, y1, cz + f.dz * s1 - f.nz * HALF_T);
        NRM.set(0, -1, 0);
        stone.quadN(NRM, P3, P2, P1, P0, voidWarm, voidWarm, voidWarm, voidWarm);
      }
    }
    // Jambs, so the passage has sides.
    for (const side of [-1, 1]) {
      const s = side * PASSAGE_W * 0.5;
      P0.set(cx + f.dx * s - f.nx * HALF_T, g, cz + f.dz * s - f.nz * HALF_T);
      P1.set(cx + f.dx * s + f.nx * HALF_T, g, cz + f.dz * s + f.nz * HALF_T);
      P2.set(cx + f.dx * s + f.nx * HALF_T, spring, cz + f.dz * s + f.nz * HALF_T);
      P3.set(cx + f.dx * s - f.nx * HALF_T, spring, cz + f.dz * s - f.nz * HALF_T);
      NRM.set(-side * f.dx, 0, -side * f.dz);
      if (side < 0) stone.quadN(NRM, P0, P1, P2, P3, voidWarm, voidWarm, voidWarm, voidWarm);
      else stone.quadN(NRM, P3, P2, P1, P0, voidWarm, voidWarm, voidWarm, voidWarm);
    }
  }
}

/**
 * A four-storey tower, as Appian counts them.
 *
 * Square, projecting past both faces, and rising 2.3 m clear of the walk so the storey above
 * the wall-walk reads as a storey. The floor lines are marked outside by string courses,
 * which is the cheapest way to make "four storeys" legible at battle distance — a tower with
 * no horizontal is a featureless prism whatever its texture is doing.
 */
function buildPunicTower(
  batch: Batch,
  detail: number,
  bay: MainBay,
  walkY: number,
  heightAt: (x: number, z: number) => number
): void {
  const stone = batch.s('stone');
  const roof = batch.s('roof');
  const f = bay.frame;
  const cx = bay.x0;
  const cz = bay.z0;
  const g = heightAt(cx, cz);
  const rotY = Math.atan2(-f.nx, -f.nz);
  const hw = TOWER_W * 0.5;
  // Deep enough to project past the outer face and to sit flush with the inner one.
  const hd = (PUNIC.mainThickness + TOWER_PROJECT) * 0.5;
  const centreOff = TOWER_PROJECT * 0.5;
  const top = g + PUNIC.towerStoreys * TOWER_STOREY;
  const col = new THREE.Color().copy(PAL.tufa).multiplyScalar(1.01);
  const plinthCol = new THREE.Color().copy(PAL.travertine);

  const m = place(cx + f.nx * centreOff, 0, cz + f.nz * centreOff, rotY);
  stone.push(m);
  box(stone, -hw - 0.5, g - 1.8, -hd - 0.5, hw + 0.5, g + PLINTH_H, hd + 0.5, plinthCol, {
    batter: PLINTH_BATTER, top: false, bottom: false,
  });
  box(stone, -hw, g + PLINTH_H, -hd, hw, top, hd, col, {
    batter: BATTER * 0.6, bottom: false, top: false, groundShade: 0.05,
  });
  // Storey lines. Four storeys is a *count*, and a count has to be visible.
  if (detail >= 1) {
    for (let s = 1; s < PUNIC.towerStoreys; s++) {
      const y = g + s * TOWER_STOREY;
      const inset = BATTER * 0.6 * (y - (g + PLINTH_H));
      box(
        stone,
        -hw - 0.20 + inset, y, -hd - 0.20 + inset,
        hw + 0.20 - inset, y + 0.26, hd + 0.20 - inset,
        plinthCol, { bottom: false }
      );
    }
  }
  // The chamber's openings: a tall arched window per face per storey above the walk, and
  // paired loops below it. Real cavities, so they read under raking light.
  if (detail >= 2) {
    const voidDark = new THREE.Color().copy(PAL.voidDark);
    for (let s = 1; s < PUNIC.towerStoreys; s++) {
      const y = g + s * TOWER_STOREY + 0.9;
      if (y + 2.2 > top) continue;
      for (const [ox, oz, sx] of [
        [0, -hd, 1], [0, hd, 1], [-hw, 0, 0], [hw, 0, 0],
      ] as [number, number, number][]) {
        const w2 = sx ? 0.34 : 0.34;
        box(
          stone,
          ox - (sx ? w2 : 0.45), y, oz - (sx ? 0.45 : w2),
          ox + (sx ? w2 : 0.45), y + 2.0, oz + (sx ? 0.45 : w2),
          voidDark, { bottom: false, top: false }
        );
      }
    }
  }
  // Crenellated crown and a low tiled roof over the top chamber.
  crenellation(stone, -hw, -hd + 0.4, hw, -hd + 0.4, top, 2.0, 0.85, col, 1.5, 0.8, detail >= 1);
  crenellation(stone, -hw, hd - 0.4, hw, hd - 0.4, top, 2.0, 0.85, col, 1.5, 0.8, detail >= 1);
  crenellation(stone, -hw + 0.4, -hd, -hw + 0.4, hd, top, 2.0, 0.85, col, 1.5, 0.8, false);
  crenellation(stone, hw - 0.4, -hd, hw - 0.4, hd, top, 2.0, 0.85, col, 1.5, 0.8, false);
  stone.pop();

  if (detail >= 1) {
    roof.push(m);
    box(roof, -hw + 1.2, top + 1.9, -hd + 1.2, hw - 1.2, top + 2.5, hd - 1.2, PAL.roofTileOld, {
      bottom: false, topGain: 1.06,
    });
    roof.pop();
  }
  void walkY;
}

/**
 * The gate: a passage through nine metres of wall between two square towers, shut.
 *
 * Modelled as its own block rather than as a modified bay, for the reason Rome's gate note
 * gives at length: a block that is 30 m wide standing in a 61.6 m bay leaves 31 m of curtain
 * that still has to be built, and a builder that "replaces the gate bay" leaves a hole
 * beside the gate. Here the curtain is built across the whole bay by `buildMainBay` and the
 * gate is cut *into* it, so there is no span either builder believes the other owns.
 */
function buildPunicGate(
  batch: Batch,
  detail: number,
  bay: MainBay,
  gateX: number,
  gateCz: number,
  leaves: boolean,
  heightAt: (x: number, z: number) => number
): void {
  const stone = batch.s('stone');
  const timber = batch.s('timber');
  const metal = batch.s('metal');
  const f = bay.frame;
  const g = heightAt(gateX, gateCz);
  const rotY = Math.atan2(-f.nx, -f.nz);
  const col = new THREE.Color().copy(PAL.tufa).multiplyScalar(1.02);
  const plinthCol = new THREE.Color().copy(PAL.travertine);
  const hd = GATE_BLOCK_D * 0.5;
  const top = g + GATE_PASS_H + GATE_ATTIC;

  const m = place(gateX, 0, gateCz, rotY);
  stone.push(m);
  // Two piers flanking the carriageway, each carrying its own tower.
  for (const side of [-1, 1]) {
    const inner = side * GATE_PASS_W * 0.5;
    const outer = side * GATE_BLOCK_W * 0.5;
    const x0 = Math.min(inner, outer);
    const x1 = Math.max(inner, outer);
    box(stone, x0 - 0.5, g - 1.8, -hd - 0.5, x1 + 0.5, g + PLINTH_H, hd + 0.5, plinthCol, {
      batter: PLINTH_BATTER, top: false, bottom: false,
    });
    box(stone, x0, g + PLINTH_H, -hd, x1, top, hd, col, { bottom: false, top: false, groundShade: 0.05 });
    if (detail >= 1) {
      box(stone, x0 - 0.24, g + GATE_PASS_H, -hd - 0.24, x1 + 0.24, g + GATE_PASS_H + 0.3, hd + 0.24, plinthCol, {
        bottom: false,
      });
    }
  }
  // The lintel band over the passage, and the attic above it.
  box(
    stone, -GATE_PASS_W * 0.5 - 0.1, g + GATE_PASS_H, -hd,
    GATE_PASS_W * 0.5 + 0.1, top, hd, col, { bottom: false, top: false }
  );
  // Crenellated crown across the whole block.
  crenellation(
    stone, -GATE_BLOCK_W * 0.5, -hd + 0.45, GATE_BLOCK_W * 0.5, -hd + 0.45,
    top, GATE_MERLON_H, 0.95, col, 1.55, 0.8, detail >= 1
  );
  crenellation(
    stone, -GATE_BLOCK_W * 0.5, hd - 0.45, GATE_BLOCK_W * 0.5, hd - 0.45,
    top, GATE_MERLON_H, 0.95, col, 1.55, 0.8, false
  );
  // The passage soffit: a flat coffered ceiling, which is what a Punic gate has where a
  // Roman one has a barrel.
  if (detail >= 1) {
    const dark = new THREE.Color().copy(PAL.voidWarm);
    box(
      stone, -GATE_PASS_W * 0.5, g + GATE_PASS_H - 0.12, -hd,
      GATE_PASS_W * 0.5, g + GATE_PASS_H, hd, dark, { top: false, bottom: true }
    );
    for (const side of [-1, 1]) {
      box(
        stone, side * GATE_PASS_W * 0.5 - 0.06, g, -hd,
        side * GATE_PASS_W * 0.5 + 0.06, g + GATE_PASS_H, hd, dark, { top: false, bottom: false }
      );
    }
  }
  stone.pop();

  // --- the leaves, shut and barred ------------------------------------------
  //
  // Only the main gate has them. §4.5 gives three gates and `Siege.ts` besieges
  // `getGates()[0]`; the other two are gatehouses whose passages are walled up, which is
  // what a city under siege does with the gates it is not using, and it keeps the flanking
  // gates from reading as two more ways in that nothing defends.
  if (!leaves) {
    const blockCol = new THREE.Color().copy(PAL.tufa).multiplyScalar(0.9);
    stone.push(m);
    box(stone, -GATE_PASS_W * 0.5, g, -0.9, GATE_PASS_W * 0.5, g + GATE_PASS_H, 0.9,
      blockCol, { bottom: false });
    stone.pop();
    return;
  }
  const doorY = g + GATE_DOOR_SILL;
  const dm = place(
    gateX + f.nx * (hd - GATE_DOOR_SET),
    0,
    gateCz + f.nz * (hd - GATE_DOOR_SET),
    rotY
  );
  timber.push(dm);
  const leafW = GATE_PASS_W * 0.5;
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -leafW : 0.03;
    const x1 = side < 0 ? -0.03 : leafW;
    box(timber, x0, doorY, -GATE_DOOR_T * 0.5, x1, doorY + GATE_PASS_H - GATE_DOOR_SILL,
      GATE_DOOR_T * 0.5, PAL.timberDark, { bottom: false });
    if (detail >= 1) {
      for (let k = 0; k < 5; k++) {
        const y = doorY + 0.7 + k * ((GATE_PASS_H - 1.6) / 4);
        box(timber, x0 + 0.05, y, -GATE_DOOR_T * 0.5 - 0.05, x1 - 0.05, y + 0.16,
          -GATE_DOOR_T * 0.5, PAL.timber, { bottom: false });
      }
    }
  }
  timber.pop();
  if (detail >= 1) {
    metal.push(dm);
    // The drawbar: this gate is barred, not merely closed.
    box(metal, -leafW + 0.2, doorY + GATE_PASS_H * 0.44, -GATE_DOOR_T * 0.5 - 0.16,
      leafW - 0.2, doorY + GATE_PASS_H * 0.44 + 0.3, -GATE_DOOR_T * 0.5 - 0.02,
      PAL.iron, { bottom: false });
    metal.pop();
  }
}

/**
 * One bay of the outer or middle line.
 *
 * Deliberately plainer than the main wall: a battered scarp, a walk and a merlon line, and
 * nothing else. Three walls that all carry the same detail read as one wall drawn three
 * times; three walls of *descending* elaboration read as a defence in depth, which is what
 * this is. A bay flagged `passage` emits only its two jamb returns, so the gap is framed
 * rather than simply missing.
 */
function buildOutworkBay(
  batch: Batch,
  detail: number,
  ow: OutworkOut,
  heightAt: (x: number, z: number) => number
): void {
  const stone = batch.s('stone');
  const len = Math.hypot(ow.x1 - ow.x0, ow.z1 - ow.z0);
  if (len < 1) return;
  const t = ow.halfThickness * 2;
  const col = new THREE.Color()
    .copy(PAL.tufa)
    .multiplyScalar(ow.id === 'outer' ? 0.93 : 0.97);
  const capCol = new THREE.Color().copy(PAL.travertine).multiplyScalar(0.96);

  if (ow.standsDown) return;
  /** The bay, or the two stubs either side of the passage where one is cut. */
  const pa = ow.passageAt;
  const spans: [number, number][] = pa === null
    ? [[0, len]]
    : [[0, Math.max(0, pa - PASSAGE_W * 0.5)], [Math.min(len, pa + PASSAGE_W * 0.5), len]];

  const nSub = detail >= 2 ? 4 : 2;
  for (const [sa, sb] of spans) {
    if (sb - sa < 0.6) continue;
    for (let s = 0; s < nSub; s++) {
      const ta = lerp(sa, sb, s / nSub);
      const tb = lerp(sa, sb, (s + 1) / nSub);
      const ax = ow.x0 + ow.dx * ta;
      const az = ow.z0 + ow.dz * ta;
      const bx = ow.x0 + ow.dx * tb;
      const bz = ow.z0 + ow.dz * tb;
      const g = Math.min(heightAt(ax, az), heightAt(bx, bz));
      quadPrism(stone, ax, az, bx, bz, ow.nx, ow.nz, t, g - 1.4, ow.walkY, col, capCol, {
        // A steeper batter than the main wall: these are scarps, not fighting platforms,
        // and the lean is what makes them read as a glacis from the field.
        batter: 0.055,
        ends: (s === 0 && sa > 0.01) || (s === nSub - 1 && sb < len - 0.01),
      });
    }
    const ax = ow.x0 + ow.dx * sa;
    const az = ow.z0 + ow.dz * sa;
    const bx = ow.x0 + ow.dx * sb;
    const bz = ow.z0 + ow.dz * sb;
    if (ow.palisade) {
      /**
       * A timber palisade, not a merlon line. §4.2 row 2: the outer work is earth and
       * rubble, stone-revetted on the ditch face, with stakes on the crest — and the change
       * of *material* between the three lines is what stops them reading as one wall drawn
       * three times at the strategic camera.
       */
      const timber = batch.s('timber');
      const len2 = sb - sa;
      const n = Math.max(2, Math.round(len2 / 0.62));
      const stakeCol = new THREE.Color().copy(PAL.timberDark);
      for (let k = 0; k < n; k++) {
        const tt = sa + ((k + 0.5) * len2) / n;
        const sx = ow.x0 + ow.dx * tt;
        const sz = ow.z0 + ow.dz * tt;
        const jitter = hash2(k, ow.index, 41);
        quadPrism(
          timber,
          sx - ow.dx * 0.11, sz - ow.dz * 0.11,
          sx + ow.dx * 0.11, sz + ow.dz * 0.11,
          ow.nx, ow.nz, 0.22, ow.walkY - 0.4,
          ow.crestY - 0.1 + jitter * 0.22, stakeCol, stakeCol, { ends: detail >= 2 }
        );
      }
      // A waling piece behind the stakes, so the palisade reads as a built thing.
      quadPrism(
        timber,
        ax - ow.nx * 0.22, az - ow.nz * 0.22, bx - ow.nx * 0.22, bz - ow.nz * 0.22,
        ow.nx, ow.nz, 0.18, ow.walkY + 0.55, ow.walkY + 0.8,
        PAL.timber, PAL.timber, { ends: false }
      );
    } else {
      crenellation(
        stone, ax, az, bx, bz, ow.walkY, ow.crestY - ow.walkY,
        Math.max(0.6, t - 0.9), col, 1.5, 0.9, detail >= 2
      );
    }
  }
}

/**
 * The ramp onto the wall: a solid masonry mass against the inner face with a raking coping.
 *
 * The coping is one straight line from the apron to the landing and does **not** step with
 * the treads. That is not decoration: three independent reviewers looking at Rome's stair
 * reported "no parapet — a raw stepped brick arris" while a 0.95 m parapet was being emitted,
 * because a stepped pale line above a stepped rake reads as more treads. One unbroken
 * diagonal is the entire cue that says "walled ramp".
 */
function buildRamp(
  batch: Batch,
  detail: number,
  bay: MainBay,
  plan: WallStair,
  heightAt: (x: number, z: number) => number
): void {
  const stone = batch.s('stone');
  const f = bay.frame;
  const off = -(HALF_T + RAMP_W * 0.5);
  const parapetOff = -(HALF_T + RAMP_W + RAMP_PARAPET_W * 0.5);
  const tOf = (px: number, pz: number): number => (px - bay.x0) * f.dx + (pz - bay.z0) * f.dz;
  const t0 = tOf(plan.headX, plan.headZ);
  const t1 = tOf(plan.footX, plan.footZ);

  const nEmit =
    detail >= 2 ? plan.steps : detail === 1 ? Math.max(5, Math.ceil(plan.steps / 3)) : Math.max(3, Math.ceil(plan.steps / 7));
  const dy = plan.rise / nEmit;
  const dt = (t1 - t0) / nEmit;
  const hw = RAMP_W * 0.5;
  const treadCol = new THREE.Color().copy(PAL.travertine).multiplyScalar(1.02);
  const bodyBase = new THREE.Color().copy(PAL.tufa).multiplyScalar(0.96);

  const groundAt = (t: number): number =>
    heightAt(bay.x0 + f.dx * t + f.nx * off, bay.z0 + f.dz * t + f.nz * off);

  for (let k = 0; k < nEmit; k++) {
    const ta = t1 - (k + 1) * dt;
    const tb = t1 - k * dt;
    const yTop = plan.footY + (k + 1) * dy;
    const base = Math.min(groundAt(ta), groundAt(tb)) - 1.3;
    const ax = bay.x0 + f.dx * ta + f.nx * off;
    const az = bay.z0 + f.dz * ta + f.nz * off;
    const bx = bay.x0 + f.dx * tb + f.nx * off;
    const bz = bay.z0 + f.dz * tb + f.nz * off;
    const body = new THREE.Color().copy(bodyBase).multiplyScalar(0.94 + hash2(k, bay.index, 31) * 0.12);
    const nose = detail >= 1 ? 0.08 : 0;
    quadPrism(stone, ax, az, bx, bz, f.nx, f.nz, RAMP_W, base, yTop - nose, body, treadCol, {
      ends: k === 0,
    });
    if (nose > 0) {
      quadPrism(stone, ax, az, bx, bz, f.nx, f.nz, RAMP_W + 0.07, yTop - nose, yTop, treadCol, treadCol, {
        ends: false,
      });
    }
    // The riser, standing on the tread below rather than running to the foundation.
    P0.set(bx + f.nx * hw, yTop - dy, bz + f.nz * hw);
    P1.set(bx - f.nx * hw, yTop - dy, bz - f.nz * hw);
    P2.set(bx - f.nx * hw, yTop, bz - f.nz * hw);
    P3.set(bx + f.nx * hw, yTop, bz + f.nz * hw);
    NRM.set(f.dx, 0, f.dz);
    stone.quadN(NRM, P0, P1, P2, P3, body, body, treadCol, treadCol);
  }

  // The cheek wall, stepping with the courses, and a coping that does not.
  const cheekCol = new THREE.Color().copy(PAL.tufa).multiplyScalar(0.99);
  for (let k = 0; k < nEmit; k++) {
    const ta = t1 - (k + 1) * dt;
    const tb = t1 - k * dt;
    const yTop = plan.footY + (k + 1) * dy + RAMP_PARAPET_H - 0.18;
    const base = Math.min(groundAt(ta), groundAt(tb)) - 1.3;
    const ax = bay.x0 + f.dx * ta + f.nx * parapetOff;
    const az = bay.z0 + f.dz * ta + f.nz * parapetOff;
    const bx = bay.x0 + f.dx * tb + f.nx * parapetOff;
    const bz = bay.z0 + f.dz * tb + f.nz * parapetOff;
    quadPrism(stone, ax, az, bx, bz, f.nx, f.nz, RAMP_PARAPET_W, base, yTop, cheekCol, cheekCol, {
      ends: k === 0,
      top: false,
    });
  }
  // One unbroken raking coping, foot to landing.
  {
    const ax = bay.x0 + f.dx * t1 + f.nx * parapetOff;
    const az = bay.z0 + f.dz * t1 + f.nz * parapetOff;
    const bx = bay.x0 + f.dx * t0 + f.nx * parapetOff;
    const bz = bay.z0 + f.dz * t0 + f.nz * parapetOff;
    const yA = plan.footY + dy + RAMP_PARAPET_H - 0.18;
    const yB = plan.footY + plan.rise + RAMP_PARAPET_H - 0.18;
    const hwp = RAMP_PARAPET_W * 0.5 + 0.06;
    for (const s of [-1, 1]) {
      P0.set(ax + f.nx * s * hwp, yA, az + f.nz * s * hwp);
      P1.set(bx + f.nx * s * hwp, yB, bz + f.nz * s * hwp);
      P2.set(bx + f.nx * s * hwp, yB + 0.2, bz + f.nz * s * hwp);
      P3.set(ax + f.nx * s * hwp, yA + 0.2, az + f.nz * s * hwp);
      NRM.set(s * f.nx, 0, s * f.nz);
      if (s > 0) stone.quadN(NRM, P0, P1, P2, P3, cheekCol, cheekCol, treadCol, treadCol);
      else stone.quadN(NRM, P3, P2, P1, P0, cheekCol, cheekCol, treadCol, treadCol);
    }
    P0.set(ax - f.nx * hwp, yA + 0.2, az - f.nz * hwp);
    P1.set(bx - f.nx * hwp, yB + 0.2, bz - f.nz * hwp);
    P2.set(bx + f.nx * hwp, yB + 0.2, bz + f.nz * hwp);
    P3.set(ax + f.nx * hwp, yA + 0.2, az + f.nz * hwp);
    NRM.set(0, 1, 0);
    stone.quadN(NRM, P0, P1, P2, P3, treadCol, treadCol, treadCol, treadCol);
  }
  // The landing: flat from the head across to the walk.
  {
    const la = t0;
    const lb = t0 - RAMP_LANDING;
    const g0 = Math.min(groundAt(Math.max(0, lb)), groundAt(la)) - 1.3;
    const ax = bay.x0 + f.dx * la + f.nx * off;
    const az = bay.z0 + f.dz * la + f.nz * off;
    const bx = bay.x0 + f.dx * lb + f.nx * off;
    const bz = bay.z0 + f.dz * lb + f.nz * off;
    quadPrism(stone, ax, az, bx, bz, f.nx, f.nz, RAMP_W, g0, plan.topY, bodyBase, treadCol, {
      ends: true,
    });
  }
  void detail;
}

/** Which `GeoStream` the wall's mass lands in. Exported for a probe that wants to find it. */
export const CARTHAGE_WALL_STREAMS: readonly string[] = ['stone', 'timber', 'metal', 'roof'];

/** For a probe: the section, so it measures against the stated figure and not a re-derivation. */
export const CARTHAGE_SECTION = {
  halfThickness: HALF_T,
  plinthHeight: PLINTH_H,
  parapetThickness: PARAPET_T,
  parapetHeight: PARAPET_H,
  innerParapetThickness: INNER_PARAPET_T,
  batter: BATTER,
  skinField: SKIN_FIELD,
  skinCity: SKIN_CITY,
  galleryWidth: GALLERY_W,
  stallPitch: STALL_PITCH,
  stallDoorWidth: STALL_DOOR_W,
  towerWidth: TOWER_W,
  towerProject: TOWER_PROJECT,
  towerRise: TOWER_RISE,
  rampWidth: RAMP_W,
  rampMaxRun: RAMP_MAX_RUN,
  passageWidth: PASSAGE_W,
  middleOffset: MIDDLE_OFF,
  outerOffset: OUTER_OFF,
  beltDepth: BELT_DEPTH,
  ditchWidth: DITCH_W,
  ditchDepth: DITCH_D,
  mainHeight: PUNIC.mainHeight,
  mainThickness: PUNIC.mainThickness,
  towerSpacing: PUNIC.towerSpacing,
  towerMerlonHeight: TOWER_MERLON,
  clearWalk: PUNIC.mainThickness - PARAPET_T - INNER_PARAPET_T,
  galleryLowerClear: STALL_CLEAR,
  galleryUpperClear: UPPER_CLEAR,
  galleryFloorHeight: FOOTING_H,
  gateBlockWidth: GATE_BLOCK_W,
  gateBlockDepth: GATE_BLOCK_D,
  gatePassageWidth: GATE_PASS_W,
} as const;

/** Silence the unused-symbol check for a stream the mass does not currently reach. */
void (undefined as unknown as GeoStream);
