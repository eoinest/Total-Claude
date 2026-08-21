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
import { type WallNode } from './layout';
/**
 * Rome's line, imported only by `aurelianLine` below — the `?fort=carthage` development rig
 * that stands the Punic wall on the Aurelian circuit so one dev server can drive both. It is
 * the last Carthage->Rome edge in the tree and `docs/ROME.md` §14.6 is why it is now visible
 * as one: it used to read as a generic import from `city/layout.ts`.
 */
import { GATE_X } from './rome/apertures';
import { fitWallPath } from './rome/circuit';
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
 * The landward defence of Carthage, 149 BC — a ditched, casemated wall.
 *
 * This is deliberately not `wall.ts` with different numbers. Rome's Aurelian curtain is a
 * single skin of brick-faced concrete you stand on top of; Carthage's isthmus wall is
 * **hollow**, with an army quartered inside it. Those are different tactical objects and the
 * difference is the whole reason for the map.
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
 * **Where Appian gives no number** — the depth of the gallery's two storeys, the rake of a
 * ramp — the constant says so and gives the archaeological or playability reason instead.
 * There is no third category.
 *
 * ## One wall, and where the other two went
 *
 * Appian's belt is three lines, and all three were built here: a palisaded outwork, a plain
 * middle wall, and this one. They shared these chunks and these four material streams, which
 * is why three lines cost fewer visible meshes than Rome's single curtain. They are gone
 * anyway, on the owner's ruling, and the argument is draw calls and clarity:
 *
 * - **Nothing could happen on them.** Only the main line publishes `GarrisonBay`s and
 *   `WallStair`s, because `CitySystem.bayAt` is index arithmetic in x and one x cannot name
 *   three bays. Nobody was ever posted on a forward line, nobody could storm one and hold
 *   it; they stopped men and arrows and did nothing else a player could see or use.
 * - **Three parallel crenellated lines read as three walls**, not as one wall with two
 *   screens in front of it, and a player who cannot tell which one his men will fight on
 *   misreads the approach. With one line the question does not arise.
 * - **Sharing the streams made them cheap, not free.** The palisade is the only reason most
 *   wall chunks carried a `timber` mesh at all, so every visible chunk paid a colour-pass
 *   call for stakes; and the chunk bounding spheres had to be pushed 20.8 m toward the field
 *   and grown by the same to cover geometry that was 41.6 m out.
 *
 * The **ditch** stays, moved back onto this wall's own glacis (§4.2 rows 0-1). It is a cut in
 * the heightfield rather than masonry — zero triangles and zero draw calls — and nobody
 * mistakes a hole in the ground for the wall standing behind it.
 *
 * ## What the sim sees
 *
 * One line, publishing `GarrisonBay`s and `WallStair`s, so `CitySystem.bayAt`'s index
 * arithmetic holds and `Siege.ts` drives this circuit with the same four accessors it drives
 * Rome's. `getOutworks()` answers empty here, exactly as it does on the Aurelian circuit;
 * the record type stays because the contract is a live one and a future circuit may have
 * forward lines, but Carthage's history is now `[]`.
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
// The ditch
// ---------------------------------------------------------------------------

/** Outer face of the main wall, along the outward normal from its centreline. */
const MAIN_FACE = PUNIC.mainThickness * 0.5;

/**
 * §4.2 row 1: the berm between the wall's footing and the ditch's counterscarp.
 *
 * The spec puts these five metres between the ditch and the *outwork*. With the outwork gone
 * they belong here, and for the reason a berm exists at all: a ditch cut hard against a wall
 * undermines its own footing, and this wall stands on 3.5 m of solid masonry over a rubble
 * base that a 6 m cut would drain into.
 */
const BERM = 5.0;
/** §4.2 row 0: dry, V-profile with a 2 m flat bottom. */
const DITCH_W = 20.0;
const DITCH_D = 6.0;
/**
 * The flat of the V, metres. Was a literal in the published record; named because the
 * heightfield now cuts against it and a profile the terrain and the plan disagree about is
 * worse than no profile at all.
 */
const DITCH_BOTTOM_W = 2.0;
const DITCH_INNER_LIP = MAIN_FACE + BERM;
const DITCH_OFF = DITCH_INNER_LIP + DITCH_W * 0.5;
/**
 * Ditch's outer lip to the back of the main wall — the whole landward defence, now.
 *
 * §4.2's belt was 74.1 m and that number bought the spec's **12.4×** headline against Rome's
 * six. It is 34.1 m here, which is still 5.7× Rome's, and it is the honest figure:
 * `assertSection` derives it from the same three §4.2 rows that are still standing rather
 * than leaving the old constant in place as a claim about geometry that is not there.
 */
const BELT_DEPTH = DITCH_INNER_LIP + DITCH_W + MAIN_FACE;

/**
 * How far short of each end of the frontage the ditch stops.
 *
 * §2.2: "the wall's two ends both die on water." A cut carried into a lagoon margin is a
 * channel, not a ditch, and it would flood to the datum `WallLine.waterLevel` carries. The
 * curtain runs the whole frontage; its ditch does not.
 */
const DITCH_END_MARGIN = 120;

/**
 * The gallery access ramp: 1 in 6, per §4.4, and wide enough for the beast that uses it.
 */
const GALLERY_RAMP_GRADE = 6;
const GALLERY_RAMP_W = 4.4;

/** Clear width of a postern through the main wall. */
const PASSAGE_W = 6.0;
/**
 * Jamb height below the springing of a postern's arch.
 *
 * The arch is semicircular on the opening, so a 6.0 m postern carries a 3.0 m rise and this
 * is the straight jamb under it; the two together are the clear head.
 */
const PASSAGE_SPRING = 1.1;
/**
 * Shortest jamb worth calling a jamb, where a postern has to duck under the upper gallery.
 *
 * The head is clamped to leave `PASSAGE_UNDER_GALLERY` of masonry beneath the upper vault's
 * floor (see `passageOf`), and on a bay whose ground climbs under the run that clamp bites.
 * Rather than let the arch grow taller than the hole it is set into — which is the one thing
 * `archPanel` answers by drawing **nothing at all**, `crown > h` returning early — the
 * opening narrows instead and the head stays where the masonry needs it.
 */
const PASSAGE_MIN_JAMB = 1.8;
/** Masonry left between a postern's soffit and the floor of the upper gallery over it. */
const PASSAGE_UNDER_GALLERY = 0.4;
/**
 * How far outboard of a mouth's own jamb the void through the curtain is cut.
 *
 * Not slack. The arch panel's reveal and the curtain's cut face are two surfaces at the same
 * station facing the same way, and coincident coplanar faces z-fight. Sixty millimetres puts
 * the dressed jamb proud of the rubble behind it, which is what a set doorway looks like, and
 * makes the fault unexpressible. A gate's void takes **zero** reveal for the opposite reason:
 * its piers stand exactly on the line and are 16.6 m deep, so anything outboard of them is a
 * slot straight through the wall.
 */
const PASSAGE_REVEAL = 0.06;
/** Dressed surround each side of a postern's arch, inside the cut and therefore visible. */
const PASSAGE_SURROUND = 0.3;
/**
 * How far behind the outer mouth a postern's leaves hang, and how thick they are.
 *
 * **A postern is a sally door and it is shut.** For two releases it was an aperture: r4
 * found the eight of them cut out of the collision surface and not out of the stone, r5 cut
 * the stone — and nothing was ever hung in the resulting doorway, so the curtain carried
 * eight 6 m openings you could see the far ground through and walk a column down. That is
 * what `WallCut.faceEnds`'s own note meant by *"True at a postern, which has nothing else to
 * close it"*: it was describing the defect and reading as a design decision.
 *
 * 1.5 m of the 9.1 m passage is close to the fifth-of-the-depth the Porta Byrsae's leaves
 * hang at (3.4 m of 16.6). It has to clear the mouth's own 1.1 m reveal — a leaf flush with
 * that is two coplanar faces and a z-fight — and it wants to be no deeper than that, because
 * every centimetre further in is a centimetre further into a recess no sun reaches. Measured
 * at four times of day from 08:30 to 18:00, direct light never enters this opening: the door
 * is read entirely by its own albedo and the sky, which is why the boarding below is the
 * *light* timber and the ledges the dark one, the reverse of the great gate's leaves.
 */
const POSTERN_DOOR_SET = 1.5;
const POSTERN_DOOR_T = 0.22;
/**
 * How far below the void's own floor the leaf is carried.
 *
 * The ground under a 6 m opening is not level — the void's floor is cut to `lowGround - 1.8`
 * for exactly that reason — so a leaf whose sill sat at `groundY` would stand clear of the
 * dip at one jamb and leave a slot under itself. It starts at the lowest ground the void was
 * cut against, less this, and the terrain buries the surplus.
 */
const POSTERN_DOOR_BURY = 0.3;

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
 * ditch, a gap in the outwork, a gap in the middle wall, and only then the leaves. Two of
 * those three are gone with the forward lines, and what is left is the ditch causeway and
 * the leaves: 16.6 m of gatehouse behind 20 m of trench that has to be bridged first.
 */
const GATE_BLOCK_W = 30;
const GATE_BLOCK_D = PUNIC.mainThickness + 7.5;
const GATE_PASS_W = 5.2;
const GATE_PASS_H = 8.0;
const GATE_ATTIC = 5.4;
const GATE_MERLON_H = 2.1;
/**
 * The crown's crenellation, shared by the stone `buildPunicGate` lays and the battlement
 * `GateBlockOut` publishes. See that type: the block used to publish only `topY` and the
 * collision model reported it flat across the whole footprint.
 *
 * Carthage's block is crenellated on **both** faces — it is a four-storey keep in a
 * casemated wall, not a decorated arch — so the two lines are mirrored about the centreline
 * and `crenelledCityward` is true.
 */
const GATE_CREN_INSET = 0.45;
const GATE_CREN_T = 0.95;
const GATE_MERLON_W = 1.55;
const GATE_CRENEL_W = 0.8;
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

/**
 * How many bays the frontage is divided into, and their pitch — **derived from the line
 * alone**, so anything that needs the wall's bay lattice can have it without building the
 * wall first.
 *
 * `buildCarthageWall` computes the identical pair from the identical expression a few
 * hundred lines below. It has to: `CitySystem.bayAt` is index arithmetic in x and a second
 * opinion about the pitch would silently hand every projectile in the game the wrong bay.
 */
export function carthageBayLattice(line: WallLine): { nBays: number; pitch: number } {
  const length = line.xMax - line.xMin;
  const nBays = Math.max(4, Math.round(length / (PUNIC.towerSpacing * 0.5)) & ~1);
  return { nBays, pitch: length / nBays };
}

/**
 * The ditch's section, as numbers rather than as geometry.
 *
 * Published so `src/maps/carthage/heightfield.ts` can cut the real thing. Before this
 * existed the ditch was a `CarthageDitch` with `built: false` and nothing on the other side
 * of the seam: the plan said 20 x 6 m and the ground the soldiers walked on was flat to
 * within 16 cm across the whole glacis, measured. The defence existed in a record and not in
 * the world, which is the worst of the three possible states — a probe reading the record
 * would have reported a 34.1 m belt that no assault ever had to cross.
 */
export const CARTHAGE_DITCH_SECTION = {
  /** Lip to lip. */
  width: DITCH_W,
  /** Lip to the flat of the V. */
  depth: DITCH_D,
  bottomWidth: DITCH_BOTTOM_W,
  /** Centreline offset from the wall's, along the **outward** (fieldward) normal. */
  offset: DITCH_OFF,
  /** Wall face to counterscarp: the berm the footing stands on. */
  innerLip: DITCH_INNER_LIP,
  berm: BERM,
  /** How far short of each anchor the cut stops. See `DITCH_END_MARGIN`. */
  endMargin: DITCH_END_MARGIN,
  /** Width of the gatehouse block, which is what a causeway across the ditch has to carry. */
  gateBlockWidth: GATE_BLOCK_W,
} as const;

/**
 * The ditch's centreline for a given wall line — **the one definition**, called both by the
 * builder that publishes it and by the heightfield that cuts it.
 *
 * Offset along each bay's **own** outward normal rather than straight in −z, because on
 * Carthage's line the curtain leans 6 % and a ditch laid off a global axis would run into the
 * wall's footing at one end of the frontage and 3 m clear of the berm at the other.
 */
export function carthageDitchPath(
  line: WallLine,
  samples = 24,
): { x: number; z: number }[] {
  const { nBays, pitch } = carthageBayLattice(line);
  const x0 = line.xMin + DITCH_END_MARGIN;
  const x1 = line.xMax - DITCH_END_MARGIN;
  const out: { x: number; z: number }[] = [];
  for (let k = 0; k <= samples; k++) {
    const x = lerp(x0, x1, k / samples);
    const b = clamp(Math.floor((x - line.xMin) / pitch), 0, nBays - 1);
    const bx0 = line.xMin + b * pitch;
    const f = frameOf(bx0, line.zAt(bx0), bx0 + pitch, line.zAt(bx0 + pitch));
    out.push({ x: x + f.nx * DITCH_OFF, z: line.zAt(x) + f.nz * DITCH_OFF });
  }
  return out;
}

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

/**
 * A forward line of a multi-line circuit, as a thing that stops men and arrows.
 *
 * **Nothing publishes one today.** Carthage's outer and middle lines were built to this
 * record and were removed; `getOutworks()` now answers `[]` on both circuits, which is the
 * value it has always had on Rome's and which every consumer already handles. The type
 * stays because it is a live contract read by the siege, AI and HUD workstreams and because
 * it is the shape a second line would take — not because anything fills it.
 */
export interface OutworkOut {
  id: 'outer' | 'middle';
  /** Index within this line, west to east. */
  index: number;
  /**
   * The `GarrisonBay` that stands directly behind this bay, so nothing has to do a spatial
   * query to find out what commands it.
   *
   * Published for the same reason `WallStair.bay` is, and it is not cosmetic: the outwork was
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
   * opening 29.7 m wide is in line with everything. Kept as an offset in the record so the
   * mistake is not expressible if a forward line is ever built again.
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
  /**
   * Whether the ground under this plan has actually been cut.
   *
   * It was `false` by type — "nothing here cuts terrain" — for as long as no heightfield
   * honoured the request. `src/maps/carthage/heightfield.ts` stage 4h now does, so the
   * answer is a fact about the map rather than about this file, and it comes in on
   * `WallLine.ditchIsCut`. It stays false on Rome's circuit under the `?fort=carthage` rig,
   * where the same masonry stands on a heightfield that cuts nothing.
   */
  built: boolean;
}

export interface CarthageWallOutput extends WallBuildOutput {
  /** The hollow stretches of the main wall. See `CasemateOut`. */
  casemates: readonly CasemateOut[];
  /**
   * Forward lines, if a circuit has any. **This one has none** — see the header.
   *
   * Both this and `outworkTopAt` are omitted rather than answered empty, which is not
   * pedantry: `CityBuild` declares them optional and `CitySystem` reads them as `?? []` and
   * `?? null`, and the null is what takes the outwork branch out of `masonryTopAt` — a
   * per-projectile hot path that would otherwise call a closure to be told there is nothing
   * there, two thousand arrows a tick.
   */
  outworks?: readonly OutworkOut[];
  /** Absolute Y of the top of a forward line at a point, or `-Infinity`. Omitted here. */
  outworkTopAt?(x: number, z: number): number;
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
   * §4.2 puts a 20 × 6 m dry ditch at the front of the belt, and with the two forward lines
   * gone it stands on the main wall's own glacis, across a 5 m berm. It is 59% of what is
   * left of the belt's depth and it is the only forward work still in the design.
   *
   * It cannot be built here: a ditch is a cut in the heightfield and `src/terrain/` is not
   * this workstream's, and a trench liner emitted at the right depth would simply be buried
   * by the ground it is supposed to be cut into. So the plan and the profile are published
   * for whoever owns the terrain, and the built belt is honestly 14.1 m and not 34.1 m until
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
  const len = Math.sqrt((x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0)) || 1;
  const dx = (x1 - x0) / len;
  const dz = (z1 - z0) / len;
  return { nx: dz, nz: -dx, dx, dz, len };
}

/**
 * A void cut clean through the curtain — a gate's carriageway, or a postern.
 *
 * **The one place a passage through this wall is decided**, in the same shape and for the
 * same reason as `punicTowerPass`: the stone `buildMainBay` lays, the mouth `buildPostern`
 * sets into it and the stretch of gallery `buildGallery` stands down are all read off this
 * one record, so a hole and the thing that is supposed to fit through it cannot drift apart.
 *
 * It exists because they had. `buildPostern` set a pierced arch **panel** into each face and
 * the wall's own body ran straight across behind it; eight posterns were published as
 * already-open `GateOut`s, so `CitySystem` cut them out of the collision surface and the
 * simulation walked men down a carriageway through stone that was still standing. Measured
 * with a ray against the baked chunks, a postern stopped one at 8.1 m — the curtain's
 * cityward face — at every height and every lateral offset, and `porta-byrsae` stopped one
 * at 8.4 m with the leaves excluded. Nothing in the sim could see it: every penetration
 * counter in this repo grades men against the *obstacle set*, which agreed.
 */
interface WallCut {
  /** Gate id this void serves, so a probe or a fault can name it. */
  id: string;
  /** Centre of the void along the bay's run, measured from `x0`. */
  at: number;
  /** Half-width of the void along the run. */
  half: number;
  /** Absolute Y of the soffit: the underside of the lintel the void is cut beneath. */
  headY: number;
  /** Absolute Y below which nothing is cut. The lowest ground under the void, less a metre. */
  floorY: number;
  /** Ground at the void's own centreline — the floor the mouths stand on. */
  groundY: number;
  /** Clear width of the mouth, and its springing above `groundY`. Zero where a gate's own
   *  block carries the opening and the curtain only has to get out of its way. */
  openW: number;
  spring: number;
  /**
   * Whether the void's own side faces are emitted.
   *
   * False at a gate, whose piers stand exactly on the line of the cut and are 7.5 m deeper
   * than the curtain, so the curtain's own reveal would either z-fight them or open a slot
   * outboard of them. True at a postern, which has nothing else to close it.
   */
  faceEnds: boolean;
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
  /** The void through this bay, or null where the curtain runs solid. */
  cut: WallCut | null;
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
  /**
   * §4.2 rows 0, 1 and 6, which are the three that are still standing: a 20 m ditch, a 5 m
   * berm and 9.1 m of wall is 34.1 m from the ditch's outer lip to the back of the curtain.
   *
   * The spec's own figure is 74.1 m and it counts the outwork, the middle wall and the
   * killing ground between them. Testing against 74.1 with those gone would be an assertion
   * that passes on arithmetic while the ground it describes is empty, which is the exact
   * failure this whole file's comment style exists to prevent — so the constant moved and
   * says what it now measures.
   */
  const belt = DITCH_W + BERM + PUNIC.mainThickness;
  if (Math.abs(BELT_DEPTH - belt) > 1e-9) {
    f.push(`belt is ${BELT_DEPTH.toFixed(2)} m deep, not ditch + berm + wall = ${belt.toFixed(2)}`);
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
  /**
   * The ditch is in front of the wall and clear of its footing.
   *
   * A sign error here is the whole of the risk in moving it: `DITCH_OFF` is an offset along
   * the *outward* normal, so a negative one puts a 6 m trench through the intervallum behind
   * the wall, where the pathfinder has no idea it is and the garrison forms up.
   */
  if (DITCH_INNER_LIP <= MAIN_FACE) f.push("the ditch is cut into the wall's own footing");
  if (DITCH_OFF - DITCH_W * 0.5 - MAIN_FACE + 1e-9 < BERM) {
    f.push(`berm is ${(DITCH_OFF - DITCH_W * 0.5 - MAIN_FACE).toFixed(2)} m, not ${BERM}`);
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
  /**
   * This map's water datum, when the wall's ends run down to water.
   *
   * A **curtain** may die in a lagoon — at Carthage both ends do, and that is the design:
   * §2.2, "the wall's two ends both die on water. There is no flank march on this map." A
   * **tower** may not. It is a 22.5 m four-storey keep with a garrison bay and a bolt-shooter
   * on its top, and the south anchor's stood on ground at **−0.75 m**, which nobody could see
   * while the lagoon was painted splat and everybody can see now that it is a surface.
   *
   * Omitted by Rome, whose circuit touches no water, and then no footing test is made.
   */
  waterLevel?: number;
  /**
   * Whether the map behind this line cuts the ditch this builder publishes.
   *
   * The wall cannot find this out for itself: it is handed a `heightAt` and has no way to
   * ask whether the dip it samples is a trench somebody dug for it or a hollow in the
   * ground. So the map says. It reaches `CarthageDitch.built`, and that field is what
   * `CitySystem.getDitch()` hands to anything reasoning about the belt's real depth.
   */
  ditchIsCut?: boolean;
}

/**
 * Rome's Aurelian line, which is where the Punic wall was built and graded.
 *
 * Reproduces exactly what this function did before the line became a parameter: the same
 * `fitWallPath` nodes at the same 55 m spacing, interpolated the same way. Kept so the
 * `?fort=carthage` rig and its probe measure an unchanged wall.
 *
 * **And the span is pinned, because "unchanged" has to mean unchanged.** It read
 * `rome/circuit.ts`'s live `WALL_X_MIN`/`WALL_X_MAX`, so when `ROME.md` §15 task 1 put the
 * Tiber on the survey and Rome's west anchor moved from x -631 to x -28, this rig's wall
 * lost 603 m with it: **60 bays became 40, seven posterns became five, and
 * `probe-carthage-wall` went from 48/48 to 43/48** — two apertures landing in one bay, a
 * postern with no leaf, a ditch tolerance — none of it about Carthage, all of it about a
 * fixture that moved under its own test. The shipped Carthage map was bit-identical across
 * the same change, measured by `qa-determinism --battle=map=carthage&scenario=assault`.
 *
 * So the rig's frontage is the 1,781 m the Aurelian circuit was when these assertions were
 * written, and it stays there whatever Rome does. It is a test fixture; that is the point
 * of one.
 */
const RIG_X_MIN = -631;
const RIG_X_MAX = 1150;

function aurelianLine(heightAt: (x: number, z: number) => number): WallLine {
  const p: WallNode[] = fitWallPath(heightAt, 55, RIG_X_MIN, RIG_X_MAX);
  return {
    xMin: RIG_X_MIN,
    xMax: RIG_X_MAX,
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
  const { nBays, pitch } = carthageBayLattice(spec);
  const gateBay = clamp(Math.floor((GATE_X - WALL_X_MIN) / pitch), 1, nBays - 2);
  /**
   * A tower stands at the west end of every *other* bay — 200 ft, §4.5 — and never inside the
   * gatehouse block, which carries its own pair. Keyed on where the block *is*, not on which
   * bay is flagged `isGate`: rounding a gate to the nearest tower is how Rome lost 23 m of
   * curtain beside the Porta Flaminia.
   *
   * **And never on a footing under water.** See `WallLine.waterLevel`. The test is the
   * tower's own 11 m footprint and its 5.5 m projection past the face, not the centreline
   * point, because the anchor tower's ground falls 0.3 m across its own width.
   */
  const dryFooting = (x: number): boolean => {
    const wl = spec.waterLevel;
    if (wl === undefined) return true;
    for (let i = -1; i <= 1; i++) {
      const tx = x + i * TOWER_W * 0.5;
      const cz = zAt(tx);
      for (const dz of [-TOWER_PROJECT, 0, TOWER_W * 0.5]) {
        if (heightAt(tx, cz + dz) < wl) return false;
      }
    }
    return true;
  };
  const towerAt = (bayIndex: number, bayX0: number): boolean =>
    bayIndex % 2 === 0 && Math.abs(bayX0 - GATE_X) > GATE_BLOCK_W * 0.5 + TOWER_W * 0.5
    && dryFooting(bayX0);

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
      cut: null,
    };
    bays.push(bay);
  }

  /**
   * Posterns: the ways an elephant gets out. Every eighth bay and never the gate bay, and
   * published as *open gates* so `CitySystem.pushWallBox` splits the obstacle box and the
   * occupancy raster clears the passage through the exact same code path the Porta Byrsae's
   * carriageway uses. Nothing new had to be taught how to cut a hole in a wall.
   *
   * **An even bay, and that is the whole of the reason for `% 8 === 6`.** These stood on
   * `% 8 === 5`, and every one of those is `% 4 === 1`, which is the wall-walk ramp's own
   * cadence — a 3.4 m masonry mass laid hard against the inner face from t = 4 to t = 28 of
   * a 30 m bay, climbing thirteen metres. The postern sits at the bay's centre, so five of
   * the seven on the development circuit opened their cityward mouth into the *side of a
   * ramp*: a tunnel cut clean through nine metres of wall and then stopped dead by the
   * stair. Even bays carry a tower at their west end and nothing at their centre, the
   * gallery access blocks take `% 4 === 3`, and the cadence and the count are unchanged.
   */
  for (const bay of bays) {
    if (bay.isGate || bay.index % 8 !== 6) continue;
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
       * Posterns take `% 8 === 6` so the two cadences never land on one bay and cost each
       * other a door; before that split, half the access blocks were being suppressed and
       * the enterable gallery was reachable only every 297 m. (This comment said `=== 5`
       * for three releases after the cadence moved above at r5's `8213709`, which is the
       * cheapest possible way to send the next reader to the wrong bays.)
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
      // Every bay of a finished monumental circuit is a barrier. See `RoughGround`.
      rough: false,
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
    // The lane through this bay's west tower, from the same helper the stone is cut with.
    const lane = hasTower ? punicTowerPass(bay, bays[bay.index - 1]) : null;
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
      passOuter: lane ? lane.outer : 0,
      passInner: lane ? lane.inner : 0,
      passLoY: lane ? lane.loY : 0,
      passHiY: lane ? lane.hiY : 0,
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

  /**
   * The voids, derived once and hung on the bay for everything that has to agree with them.
   *
   * A bay carries at most one: the gate cadence and the postern cadence are disjoint by
   * construction, and the `set` helper below says so out loud rather than leaving it to be
   * believed. (It was called `assertPassages` in this comment and has never existed under
   * that name anywhere in the tree.) Both go through `cutFaults` so a passage that cannot
   * be cut — an arch taller than the wall that carries it, a mouth narrower than a man — is
   * reported on the output beside the section's own arithmetic instead of silently drawing
   * nothing.
   */
  const cutFaults: string[] = [];
  {
    const spanGround = (bay: MainBay, t0: number, t1: number): { lo: number; hi: number } => {
      const f = bay.frame;
      let lo = Infinity;
      let hi = -Infinity;
      for (let s = 0; s <= 6; s++) {
        const t = lerp(t0, t1, s / 6);
        const h = heightAt(bay.x0 + f.dx * t, bay.z0 + f.dz * t);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
      return { lo, hi };
    };
    const lowGround = (bay: MainBay, t0: number, t1: number): number => spanGround(bay, t0, t1).lo;
    const set = (bay: MainBay, cut: WallCut): void => {
      if (bay.cut) {
        cutFaults.push(`bay ${bay.index} carries both ${bay.cut.id} and ${cut.id}`);
        return;
      }
      bay.cut = cut;
    };
    for (const ga of gateAxes) {
      const bay = bays[ga.bay];
      const f = bay.frame;
      const at = (ga.x - bay.x0) * f.dx + (ga.z - bay.z0) * f.dz;
      const half = GATE_PASS_W * 0.5;
      const groundY = heightAt(ga.x, ga.z);
      set(bay, {
        id: ga.id, at, half,
        // The block's own soffit. Its lintel band and its coffered ceiling are 0.1 m wider
        // and 7.5 m deeper than the curtain, so they cover the cut's head from every side.
        headY: groundY + GATE_PASS_H,
        floorY: lowGround(bay, at - half, at + half) - 1.8,
        groundY,
        openW: 0, spring: 0,
        faceEnds: false,
      });
    }
    for (const bay of bays) {
      if (bay.posternAt === null) continue;
      const f = bay.frame;
      const at = bay.posternAt;
      const groundY = heightAt(bay.x0 + f.dx * at, bay.z0 + f.dz * at);
      /**
       * The head, and the only thing on this circuit that moves it.
       *
       * A postern is a hole at ground level and the lower gallery's floor is 3.5 m up, so
       * the passage runs through the solid footing §4.4 leaves under the stalls and breaks
       * the *lower* vault where its arch reaches into it — which is what a sally port
       * through a casemate does, and the upper gallery bridges over it. What it may not do
       * is reach the **upper** floor, because a void that swallows both storeys has nothing
       * left to carry the wall-walk. Where the ground climbs under the run — 2.4 m across
       * one bay on the development circuit — the clamp bites and the opening narrows.
       */
      const crownMax = bay.casemate
        ? bay.casemate.upperFloorY - PASSAGE_UNDER_GALLERY
        : bay.walkY - 1.0;
      const clearH = Math.min(PASSAGE_SPRING + PASSAGE_W, crownMax - groundY);
      const openW = Math.min(PASSAGE_W, 2 * (clearH - PASSAGE_MIN_JAMB));
      if (openW < 2.4 || clearH < 2.8) {
        cutFaults.push(
          `postern-${bay.index} has ${openW.toFixed(2)} m of opening under a ` +
          `${clearH.toFixed(2)} m head and is not a passage`
        );
        bay.posternAt = null;
        continue;
      }
      set(bay, {
        id: `postern-${bay.index}`,
        at,
        half: openW * 0.5 + PASSAGE_REVEAL,
        headY: groundY + clearH,
        floorY: lowGround(bay, at - openW * 0.5 - PASSAGE_REVEAL, at + openW * 0.5 + PASSAGE_REVEAL) - 1.8,
        groundY,
        openW,
        spring: clearH - openW * 0.5,
        faceEnds: true,
      });
    }
    for (const bay of bays) {
      const cut = bay.cut;
      if (!cut) continue;
      /**
       * A void wider than the bay, or one whose soffit is under the plinth it is cut
       * through, is a hole beside the opening rather than an opening. Rome lost 23 m of
       * curtain that way and the lesson was to say so at build time.
       *
       * **Two conditions, said apart, because one of them was crying wolf.** This was a
       * single test at a 0.5 m margin reporting `is cut past the end of bay N`, and
       * Carthage has printed `porta-uticensis is cut past the end of bay 50` at every boot
       * since. It is not. Measured: bay 50 is 30.029 m long, the gate axis lands at
       * `at = 27.255`, and a 5.2 m carriageway therefore ends at 29.855 — **0.174 m inside
       * the bay**, not past it. The void is whole, the panels either side of it are whole,
       * and the 0.17 m rib of tufa left at the joint stands inside a 30 m gatehouse where
       * nothing can see it. What tripped was the *margin*, which is a different sentence.
       *
       * The margin is still worth having and is still reported: 0.17 m of clearance is one
       * retune of `pitch` or `GATE_PASS_W` away from a clipped carriageway, and the reason
       * the gate lands there at all is that `gateAxes` clamps x into the frontage and then
       * floors it into a bay without ever asking where in that bay it fell. But a warning
       * that misstates its own finding gets read once and discounted for ever, so the hard
       * fault and the near miss now say what each of them actually is.
       */
      const over = Math.max(0 - (cut.at - cut.half), cut.at + cut.half - bay.frame.len);
      if (over > 0) {
        cutFaults.push(
          `${cut.id} is cut ${over.toFixed(2)} m past the end of bay ${bay.index}`
        );
      } else if (cut.at - cut.half < 0.5 || cut.at + cut.half > bay.frame.len - 0.5) {
        const clear = Math.min(cut.at - cut.half, bay.frame.len - (cut.at + cut.half));
        cutFaults.push(
          `${cut.id} clears the end of bay ${bay.index} by only ${clear.toFixed(2)} m`
        );
      }
      // The plinth's top follows the *lowest* ground under each sub-panel, so the highest
      // ground inside the void's own span is the worst case a soffit has to clear.
      if (cut.headY <= spanGround(bay, cut.at - cut.half, cut.at + cut.half).hi + PLINTH_H) {
        cutFaults.push(`${cut.id}'s soffit is inside the plinth of bay ${bay.index}`);
      }
    }
  }
  const gates: GateOut[] = gateAxes.map((ga) => ({
    id: ga.id,
    x: ga.x,
    z: ga.z,
    facing: Math.atan2(ga.frame.nx, ga.frame.nz),
    // Shut. The ram has to bring them down; `setGateOpen(id, true)` is what the siege calls.
    open: false,
  }));
  /**
   * The posterns, published as gates that are **shut**, like every other way through here.
   *
   * They used to be published `open: true`, and that was not a small thing. `open` is the
   * one word in this record the rest of the engine acts on: `CitySystem.pushWallBox` splits
   * a bay's obstacle box at an open gate, `CitySystem.init` clears its carriageway out of
   * the occupancy raster, and `PathfindingSystem.openGates` punches its axis through the nav
   * grid and locks a route onto it. Eight of them said open, so **measured at `3f4c203` the
   * curtain failed a 32 m crossing test at 29 of 990 stations in eight bands 4-6 m wide, one
   * on each postern** — eight unguarded ways into Carthage, no ram needed, on a wall that is
   * drawn as continuous masonry from every camera that is not standing in one of the eight.
   *
   * The justification on the way in was that "a casemate wall is a wall you can pass
   * *through* rather than only over". It is — the men inside the gallery use these, and so
   * do Appian's elephants. What a sally port is not is an *aperture*: it is a small door,
   * shut and barred, that the garrison opens when it wants to come out and nobody else can
   * use. Shut is therefore the resting state, and the affordance is unchanged and unmoved —
   * `setGateOpen('postern-N', true)` opens exactly this passage through exactly the code
   * path the Porta Byrsae uses, and `buildPosternDoor`'s chunk is tagged `gateDoorFor` so
   * the leaves come off the screen when it does.
   *
   * The stone stays cut. r5's work is not undone and must not be: the hole is real, the
   * mouths are real, and `probe-carthage-wall`'s E7 still casts its rays through the passage
   * with the leaves excluded by name, because a door is not a wall.
   */
  for (const bay of bays) {
    if (bay.posternAt === null) continue;
    const f = bay.frame;
    gates.push({
      id: `postern-${bay.index}`,
      x: bay.x0 + f.dx * bay.posternAt,
      z: bay.z0 + f.dz * bay.posternAt,
      facing: Math.atan2(f.nx, f.nz),
      open: false,
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
    broken: false,
  };
  const gateBlock: GateBlockOut = {
    x: GATE_X, z: gateCz,
    nx: gf.nx, nz: gf.nz, dx: gf.dx, dz: gf.dz,
    halfRun: GATE_BLOCK_W * 0.5,
    halfDepth: GATE_BLOCK_D * 0.5 + 0.5,
    topY: gateG + GATE_PASS_H + GATE_ATTIC + GATE_MERLON_H,
    // `buildPunicGate` calls this `top`: the crown the merlons stand on.
    sillY: gateG + GATE_PASS_H + GATE_ATTIC,
    // Authored at local z = `-hd + GATE_CREN_INSET`, and −Z is outward, so the offset along
    // `n` is positive. The cityward line is its mirror.
    parapetInner: GATE_BLOCK_D * 0.5 - GATE_CREN_INSET - GATE_CREN_T * 0.5,
    parapetOuter: GATE_BLOCK_D * 0.5 - GATE_CREN_INSET + GATE_CREN_T * 0.5,
    crenelledCityward: true,
    merlonLength: GATE_MERLON_W,
    crenelLength: GATE_CRENEL_W,
    openHalf: GATE_PASS_W * 0.5,
  };

  // --- chunks ----------------------------------------------------------------
  /**
   * Curtain, towers, gates, ramps and the galleries all go into the same `Batch` streams
   * inside the same chunks. `Batch.toMeshes` bakes one mesh per material per detail level,
   * so the wall's whole cost is its *material set* — `stone`, `timber`, `metal`, `roof` —
   * and not how much of it there is.
   *
   * With the palisade gone, `timber` and `metal` survive only where a gate has leaves and a
   * drawbar: **one chunk in seven**, instead of every chunk in the circuit.
   */
  const BAYS_PER_CHUNK = 10;
  const chunks: CityChunkSpec[] = [];

  for (let c = 0; c * BAYS_PER_CHUNK < bays.length; c++) {
    const from = c * BAYS_PER_CHUNK;
    const to = Math.min(bays.length, from + BAYS_PER_CHUNK);
    const slice = bays.slice(from, to);
    const spanX0 = slice[0].x0;
    const spanX1 = slice[slice.length - 1].x1;
    const cx = (spanX0 + spanX1) * 0.5;
    /**
     * The sphere sits on the wall line now.
     *
     * It used to be pushed 20.8 m toward the field with the radius grown by the same, to
     * cover an outwork 41.6 m out. Nothing stands out there, so leaving it would declare a
     * chunk half again as deep as the geometry in it — which is not free: `surfaceCorrection`
     * takes `radius * 0.55` off the LOD distance, so an over-declared radius holds a chunk at
     * full detail longer than it has any reason to be. `assertNoStrayGeometry` measures every
     * vertex against this and will say so if it is now too small.
     */
    const cz = (slice[0].z0 + slice[slice.length - 1].z1) * 0.5;
    const radius = (spanX1 - spanX0) * 0.62 + 58;
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
          buildPunicTower(batch, detail, bay, topY, heightAt, punicTowerPass(bay, prev));
        }
        if (to === bays.length) {
          const last = slice[slice.length - 1];
          // The far end of the circuit: a walk on one side only, so nothing to pass to.
          buildPunicTower(
            batch, detail,
            { ...last, x0: last.x1, z0: last.z1, index: bays.length },
            last.walkY, heightAt, null
          );
        }
      },
    });
  }

  /**
   * The Porta Byrsae's leaves, as their own chunk so a breach is visible.
   *
   * One detail level and no shadow: 130 triangles hanging 3.4 m inside a 16.6 m passage, so
   * there is nothing for a mid tier to drop and the shadow falls wholly inside the
   * gatehouse's. `castShadow: false` also keeps them out of `buildShadowProxy`, which would
   * otherwise bake a copy into the wall chunk's merged caster and go on drawing their shadow
   * after they were hidden.
   *
   * It costs this circuit nothing. `timber` and `metal` in the gate chunk were the leaves and
   * the drawbar and nothing else once the palisade went, so the two meshes move rather than
   * multiply — and they come back on an 18 m sphere at the gate instead of a 250 m one across
   * ten bays.
   */
  {
    const ga = gateAxes[0];
    chunks.push({
      name: 'gate-door',
      cx: ga.x,
      cz: ga.z,
      radius: 18,
      castShadow: false,
      lodSwitch: [1e9, 1e9],
      gateDoorFor: ga.id,
      build: (batch, detail) => {
        batch.setUvOrigin(ga.x, 0, ga.z);
        buildPunicGateLeaves(batch, detail, bays[ga.bay], ga.x, ga.z, heightAt);
      },
    });
    // The same leaves after the ram. Baked and held off the screen; `setGateDoorBroken`
    // swaps the two, so the pair costs one chunk's draws whichever of them is showing.
    chunks.push({
      name: 'gate-wreck',
      cx: ga.x,
      cz: ga.z,
      radius: 22,
      castShadow: false,
      lodSwitch: [1e9, 1e9],
      gateWreckFor: ga.id,
      build: (batch, detail) => {
        batch.setUvOrigin(ga.x, 0, ga.z);
        buildPunicGateLeaves(batch, detail, bays[ga.bay], ga.x, ga.z, heightAt, true);
      },
    });
  }

  /**
   * One chunk per postern, for the same reason the gate's leaves are one: a door that a
   * sally can open has to be separable from the wall it is set in.
   *
   * Eight chunks and eight draws, measured, on a circuit that sat at 180 against a cap of
   * 220 — see `buildPosternDoor` for why each is a single `timber` stream. `radius: 7`
   * covers a 6.1 m leaf and its ledges with a metre to spare and no more;
   * `assertNoStrayGeometry` measures every vertex against it and will say so if that is
   * ever wrong. `castShadow: false` follows `gate-door` exactly, and for the same second
   * reason: it keeps the leaves out of `buildShadowProxy`, which would otherwise bake a
   * copy into the wall chunk's merged caster and go on drawing the shadow of a door that a
   * sally had opened.
   */
  for (const bay of bays) {
    if (bay.posternAt === null || !bay.cut) continue;
    const f = bay.frame;
    const px = bay.x0 + f.dx * bay.cut.at;
    const pz = bay.z0 + f.dz * bay.cut.at;
    const b = bay;
    chunks.push({
      name: `postern-door-${bay.index}`,
      cx: px,
      cz: pz,
      radius: 7,
      castShadow: false,
      lodSwitch: [1e9, 1e9],
      gateDoorFor: `postern-${bay.index}`,
      build: (batch, detail) => {
        batch.setUvOrigin(px, 0, pz);
        buildPosternDoor(batch, detail, b);
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
   *
   * Offset along each bay's **own** outward normal rather than straight in −z, because on
   * Carthage's line the curtain leans 6 % and a ditch laid off a global axis would run into
   * the wall's footing at one end of the frontage and 3 m clear of the berm at the other.
   */
  const ditchPath = carthageDitchPath(spec);

  return {
    path,
    chunks,
    segments,
    gates,
    gateBlock,
    gateDoor,
    blockers,
    // Nothing on this circuit is standing-but-passable: the eight posterns were shut at
    // `385474f` and every bay is finished. The field is on the contract, so it is answered.
    roughGround: [],
    trees,
    towerCount: bays.filter((b) => towerAt(b.index, b.x0)).length + 1,
    // Every bay of a finished monumental circuit. `BayStage` exists for Aurelian's building
    // site and Carthage has none of it, but the field is on the contract so it is answered.
    bayStages: bays.map(() => 'finished' as const),
    garrisonBays,
    stairs,
    wallZAt: zAt,
    casemates,
    // `outworks` and `outworkTopAt` are deliberately absent, not empty. See the output type.
    towerRise: TOWER_RISE,
    occBlockers,
    ditch: {
      path: ditchPath,
      width: DITCH_W,
      depth: DITCH_D,
      bottomWidth: DITCH_BOTTOM_W,
      offset: DITCH_OFF,
      /**
       * **True on this map now.** `src/maps/carthage/heightfield.ts` stage 4h cuts the
       * profile above into the field, so a consumer reading this record is reading a
       * request that has been honoured. Left on the type as a boolean rather than deleted
       * because the `?fort=carthage` rig stands the same wall on Rome's circuit, where the
       * Campus Martius heightfield cuts nothing and the answer is still false.
       */
      built: spec.ditchIsCut === true,
    },
    sectionFaults: [...assertSection(), ...cutFaults],
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

  /**
   * Where the sub-panels break, with the void's own two edges forced in as breaks.
   *
   * The passage is cut by **leaving the panels out** rather than by punching a hole, and a
   * panel that straddles the edge of the void cannot do either. Inserting the edges as stops
   * means every panel is wholly inside the void or wholly outside it, and the panel next to
   * the void carries the reveal on its own end face — the cross-section then matches the
   * cut exactly, batter and plinth projection included, with nothing hand-derived to drift.
   */
  const cut = bay.cut;
  const stops: number[] = [];
  for (let s = 0; s <= nSub; s++) stops.push((f.len * s) / nSub);
  if (cut) stops.push(cut.at - cut.half, cut.at + cut.half);
  stops.sort((p, q) => p - q);

  // --- plinth and body, sub-bay by sub-bay ----------------------------------
  for (let s = 0; s < stops.length - 1; s++) {
    const ta = stops[s];
    const tb = stops[s + 1];
    if (tb - ta < 0.05) continue;
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
    const voided = !!cut && ta > cut.at - cut.half - 1e-6 && tb < cut.at + cut.half + 1e-6
      && cut.headY > plinthTop && cut.floorY <= g - 1.6 + 1e-6;
    // The reveal is on the panel that stands beside the void, and only at a postern: a
    // gate's piers are on the same line and 7.5 m deeper, so a curtain reveal there is
    // either coplanar with them or a slot outboard of them.
    const beside = !!cut && cut.faceEnds
      && (Math.abs(tb - (cut.at - cut.half)) < 1e-6 || Math.abs(ta - (cut.at + cut.half)) < 1e-6);
    const ends = ta < 1e-6 || tb > f.len - 1e-6 || beside;

    if (!voided) {
      quadPrism(
        stone, a.x, a.z, b.x, b.z, f.nx, f.nz,
        PUNIC.mainThickness + PLINTH_PROJECT * 2,
        g - 1.6, plinthTop, plinthCol, plinthCol,
        { ends, batter: PLINTH_BATTER, top: false }
      );
      quadPrism(
        stone, a.x, a.z, b.x, b.z, f.nx, f.nz,
        PUNIC.mainThickness,
        plinthTop, bay.walkY, bodyCol, bodyCol,
        { ends, batter: BATTER, top: false }
      );
      continue;
    }
    /**
     * Over the void: the lintel only, and the soffit it stands on.
     *
     * The lintel's thickness is the body's own cross-section **at the soffit** rather than
     * the nominal 9.1 m, because `quadPrism` batters by insetting its top face — so a piece
     * restarted at the nominal thickness would step 0.2 m proud of the panel beside it. The
     * same figure is the soffit's width, which is why the two cannot disagree.
     */
    const lintelT = Math.max(1.0, PUNIC.mainThickness - 2 * BATTER * (cut.headY - plinthTop));
    quadPrism(
      stone, a.x, a.z, b.x, b.z, f.nx, f.nz, lintelT,
      cut.headY, bay.walkY, bodyCol, bodyCol, { ends: false, batter: BATTER, top: false }
    );
    const ht = lintelT * 0.5;
    P0.set(a.x + f.nx * ht, cut.headY, a.z + f.nz * ht);
    P1.set(b.x + f.nx * ht, cut.headY, b.z + f.nz * ht);
    P2.set(b.x - f.nx * ht, cut.headY, b.z - f.nz * ht);
    P3.set(a.x - f.nx * ht, cut.headY, a.z - f.nz * ht);
    NRM.set(0, -1, 0);
    stone.quadN(NRM, P3, P2, P1, P0, plinthCol, plinthCol, plinthCol, plinthCol);
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
  if (bay.posternAt !== null) buildPostern(batch, detail, bay);
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
  /**
   * Where a gate or a postern crosses this stretch, the gallery stands down.
   *
   * A passage cut through the curtain runs *across* the gallery, so anything the gallery
   * puts inside the void — a stall front on the face that is no longer there, a floor slab
   * or a barrel arching over the carriageway — ends up standing in the passage. The stretch
   * is therefore broken at the void and the two halves are walled off, which is what a sally
   * port through a casemate is: the lower vault stops each side of it and the upper vault
   * bridges over. See `WallCut`.
   */
  const cut = bay.cut;
  const cutLo = cut ? cut.at - cut.half : 0;
  const cutHi = cut ? cut.at + cut.half : 0;
  /** Does a storey between `y0` and `y1` reach into the void at all? */
  const crossesVoid = (y0: number, y1: number): boolean =>
    !!cut && y1 > cut.floorY && y0 < cut.headY;

  for (let i = 0; i < n; i++) {
    const t = t0 + (i + 0.5) * STALL_PITCH;
    // A panel that straddles the void has no face left to stand on.
    if (cut && t + STALL_PITCH * 0.5 > cutLo && t - STALL_PITCH * 0.5 < cutHi) continue;
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
  const runEnd = t0 + n * STALL_PITCH;
  for (const [floor, clear] of [
    [floorY, STALL_CLEAR],
    [cm.upperFloorY, UPPER_CLEAR],
  ] as [number, number][]) {
    /**
     * One run, or two with the passage between them.
     *
     * A storey that never reaches the void keeps its single run — on this circuit that is
     * the upper gallery at every postern, because the head is clamped to stay under its
     * floor. The lower one is broken, and each broken end gets a wall across the full
     * section: without it a sight line down the gallery and through a stall door runs out
     * of vault, out of the severed end and clean through the wall.
     */
    const broken = crossesVoid(floor, floor + clear);
    const ends: [number, number][] = broken
      ? [[t0, cutLo - 0.05], [cutHi + 0.05, runEnd]]
      : [[t0, runEnd]];
    if (broken) {
      const crossCol = new THREE.Color().copy(PAL.tufa).multiplyScalar(0.9);
      for (const [tc, sign] of [[cutLo - 0.05, -1], [cutHi + 0.05, 1]] as [number, number][]) {
        if (tc < t0 || tc > runEnd) continue;
        const cxp = bay.x0 + f.dx * tc;
        const czp = bay.z0 + f.dz * tc;
        P0.set(cxp + f.nx * (co - r), floor, czp + f.nz * (co - r));
        P1.set(cxp + f.nx * (co + r), floor, czp + f.nz * (co + r));
        P2.set(cxp + f.nx * (co + r), floor + clear, czp + f.nz * (co + r));
        P3.set(cxp + f.nx * (co - r), floor + clear, czp + f.nz * (co - r));
        NRM.set(sign * f.dx, 0, sign * f.dz);
        if (sign > 0) stone.quadN(NRM, P0, P1, P2, P3, crossCol, crossCol, crossCol, crossCol);
        else stone.quadN(NRM, P3, P2, P1, P0, crossCol, crossCol, crossCol, crossCol);
      }
    }
    for (const [ta, tb] of ends) {
      if (tb - ta < 0.4) continue;
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
 *
 * **This function used to be the whole of the postern, and that was the bug.** It set a
 * pierced arch *panel* into each face and modelled a barrel between them, and every one of
 * those triangles was buried inside a curtain that ran straight across behind it — a mouth
 * at each end of nine metres of solid tufa. What cuts the stone is `WallCut`, read by
 * `buildMainBay`; this now draws only the two dressed mouths that stand in the hole, and it
 * takes their width, their springing and their head off the same record, so a mouth cannot
 * be a different size from the passage it fronts.
 *
 * The lining is gone with the barrel. The void's own side faces are the curtain's cut
 * cross-section, which carries the plinth's projection and the face batter exactly because
 * it *is* the curtain, and the soffit is `buildMainBay`'s. A flat-soffited passage under a
 * relieving arch is also the right idiom here — `buildPunicGate` already argues it: "a flat
 * coffered ceiling, which is what a Punic gate has where a Roman one has a barrel."
 */
function buildPostern(batch: Batch, detail: number, bay: MainBay): void {
  const cut = bay.cut;
  if (bay.posternAt === null || !cut || cut.openW <= 0) return;
  const stone = batch.s('stone');
  const f = bay.frame;
  const cx = bay.x0 + f.dx * cut.at;
  const cz = bay.z0 + f.dz * cut.at;
  const rotY = Math.atan2(-f.nx, -f.nz);
  const wallCol = new THREE.Color().copy(PAL.tufa);
  const voidWarm = new THREE.Color().copy(PAL.voidWarm);
  const h = cut.headY - cut.groundY;

  for (const side of [-1, 1]) {
    const rise = Math.max(0, cut.headY - (bay.gMin + PLINTH_H));
    const off = side * (HALF_T - BATTER * rise - 0.05);
    const px = cx + f.nx * off;
    const pz = cz + f.nz * off;
    stone.push(place(px, cut.groundY, pz, side > 0 ? rotY : rotY + Math.PI));
    /**
     * The surround is 0.3 m, not 2.2 m, and `backFace` is on.
     *
     * The panel used to be 10.4 m wide, which was a frame standing on a face; with the hole
     * cut it is a frame standing in *front of* one, and everything outside the void is
     * behind masonry and never seen. What is seen is the spandrel over the arch — and that
     * is a single-sided slab unless the back is drawn, so from inside the passage the
     * stonework between the arch and the square head was a hole to the sky.
     */
    archPanel(stone, cut.openW + PASSAGE_SURROUND * 2, h, wallCol, {
      depth: 1.1,
      spring: cut.spring,
      openWidth: cut.openW,
      segments: detail >= 2 ? 10 : 5,
      voidCol: voidWarm,
      backFace: true,
      archivolt: detail >= 2 ? 0.2 : 0,
    });
    stone.pop();
  }
}

/**
 * The leaves that shut a postern, in their own chunk so a sally shows.
 *
 * **The thing the owner was looking at when he said *"there are some straight up holes in
 * the wall which don't seem like a great defensive strategy"*.** There were: eight of them,
 * one per postern, 6 m wide and 5 m high with the far ground visible through each.
 *
 * This is deliberately the Porta Byrsae's mechanism at a fifth of the scale rather than a
 * second one. Same idiom as `buildPunicGateLeaves` — twin leaves meeting on the centreline,
 * boarded, ledged, hung behind the mouth's reveal — and the same wiring: a `CityChunkSpec`
 * tagged `gateDoorFor: 'postern-N'`, so `CitySystem.setGateOpen('postern-N', true)` re-cuts
 * the raster and the boxes *and* takes the leaves off the screen, with no new call anywhere.
 * Nothing in `src/sim/` had to learn a new word.
 *
 * Three deliberate differences from the great gate's leaves, all of them cost:
 *
 *  - **One material stream.** The Porta Byrsae spends `timber` and `metal`, the second on a
 *    drawbar you can read at 40 m across a causeway. `Batch.toMeshes` bakes one mesh per
 *    material, so a second stream here is eight more draw calls on a circuit measured at
 *    180 against a whole-frame cap of 220. The ledges carry the banding instead, in the
 *    lighter `PAL.timber` against the leaf's `timberDark`, which is what actually reads at
 *    the distance a postern is ever seen from.
 *  - **No wrecked pose.** The gate has a second chunk for the shape the ram left it in
 *    because that gate is the one a player assaults and watches. A postern that is broken
 *    open is simply open; `applyGateDoorState` hides the leaves and finds no wreck to show,
 *    which is exactly what the two masonry-barred flanking gates already do.
 *  - **The leaf spans the void, not the mouth.** `2 * cut.half` is `openW` plus the 0.06 m
 *    reveal each side, so the meeting stiles run into the dressed jamb instead of stopping
 *    on the visible arch line. A 60 mm slot down the edge of a shut door is a ray straight
 *    through it, and this file has already paid for that lesson once — see the note on the
 *    gate leaves meeting at x = 0.
 */
function buildPosternDoor(batch: Batch, detail: number, bay: MainBay): void {
  const cut = bay.cut;
  if (bay.posternAt === null || !cut || cut.openW <= 0) return;
  const timber = batch.s('timber');
  const f = bay.frame;
  const cx = bay.x0 + f.dx * cut.at;
  const cz = bay.z0 + f.dz * cut.at;
  const rotY = Math.atan2(-f.nx, -f.nz);
  // The outer face at the soffit, less the setback: the plane the leaves hang in. Same
  // batter term `buildPostern` sets its mouths on, so the two cannot drift apart.
  const rise = Math.max(0, cut.headY - (bay.gMin + PLINTH_H));
  const off = HALF_T - BATTER * rise - 0.05 - POSTERN_DOOR_SET;
  const dm = place(cx + f.nx * off, 0, cz + f.nz * off, rotY);
  timber.push(dm);

  // `floorY` is `lowGround - 1.8`; the leaf starts on the lowest ground under its own span.
  const sillY = cut.floorY + 1.8 - POSTERN_DOOR_BURY;
  // Up to the soffit. The void behind the arch is a rectangle — `buildMainBay` emits a flat
  // lintel over it, not a barrel — so a rectangular leaf plugs it exactly and the top
  // corners stand behind the spandrel the mouth's `archPanel` draws.
  const headY = cut.headY;
  const leafW = cut.half;
  for (const side of [-1, 1]) {
    // The leaves meet on the centreline. See `buildPunicGateLeaves`: the two faces at x = 0
    // are coincident and face opposite ways, so each is back-facing from the other's side.
    const x0 = side < 0 ? -leafW : 0;
    const x1 = side < 0 ? 0 : leafW;
    box(timber, x0, sillY, -POSTERN_DOOR_T * 0.5, x1, headY, POSTERN_DOOR_T * 0.5,
      PAL.timber, { bottom: false });
    if (detail >= 1) {
      // Three ledges, proud on the field side. Dark on light, which is the way round that
      // survives being in permanent shade — the first pass had it the other way and the
      // leaf photographed as a black rectangle indistinguishable from the hole it replaced.
      for (let k = 0; k < 3; k++) {
        const y = sillY + 0.55 + (k * (headY - sillY - 1.1)) / 2;
        box(timber, x0 + 0.04, y, -POSTERN_DOOR_T * 0.5 - 0.06, x1 - 0.04, y + 0.14,
          -POSTERN_DOOR_T * 0.5, PAL.timberDark, { bottom: false });
      }
    }
  }
  if (detail >= 1) {
    /**
     * The drawbar: this door is barred, not merely shut. Timber, and not `PAL.iron`.
     *
     * The Porta Byrsae's bar is iron because it is 5.2 m of it on a gate a ram is driven
     * at. Here `PAL.iron` is a neutral grey (0x4b4842) in a recess lit by nothing but sky,
     * so it took the sky's colour and photographed as a **bright blue stripe** across the
     * door — the one thing in the frame that drew the eye, and it read as a rendering
     * fault. A drawn-back timber bar is what a sally port has anyway.
     */
    box(timber, -leafW + 0.25, sillY + (headY - sillY) * 0.42, -POSTERN_DOOR_T * 0.5 - 0.16,
      leafW - 0.25, sillY + (headY - sillY) * 0.42 + 0.24, -POSTERN_DOOR_T * 0.5 - 0.02,
      PAL.timberDark, { bottom: false });
  }
  timber.pop();
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
  heightAt: (x: number, z: number) => number,
  pass: TowerPass | null
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
  /**
   * The shaft, with the wall-walk cut through it.
   *
   * **This is what the owner was looking at.** The tower was one 20 m prism from the plinth
   * to the crown, 11 m along the wall and flush with the curtain's inner face, and this
   * function's `walkY` argument ended at `void walkY;` — there was no opening at any height
   * on any of the thirty-one of them, and the wall-walk simply stopped. Appian's four
   * storeys are exactly why there is room for a passage: the storey the walk arrives at is
   * a chamber, and a chamber astride a walk has to be walked through.
   *
   * The shaft is split rather than punched because `box` batters by insetting its own top
   * face, so each piece starts at the inset the piece below it finished on and the faces
   * stay flush. Same stream, so it costs triangles and not a draw call.
   */
  const bat = BATTER * 0.6;
  const lane = pass && pass.outer - pass.inner >= PUNIC_MIN_LANE ? pass : null;
  if (!lane) {
    box(stone, -hw, g + PLINTH_H, -hd, hw, top, hd, col, {
      batter: bat, bottom: false, top: false, groundShade: 0.05,
    });
  } else {
    // Wall-normal offsets into the tower's own frame: local +Z is cityward and the module
    // stands `centreOff` out along the normal, so an offset `o` is at `centreOff - o`.
    const lz0 = centreOff - lane.outer;
    const lz1 = centreOff - lane.inner;
    const voidLo = Math.max(g + PLINTH_H + 0.2, lane.loY);
    const voidHi = Math.min(top - 0.6, lane.hiY + PUNIC_PASS_HEAD);
    const i0 = bat * (voidLo - (g + PLINTH_H));
    const i1 = i0 + bat * (voidHi - voidLo);
    box(stone, -hw, g + PLINTH_H, -hd, hw, voidLo, hd, col, {
      batter: bat, bottom: false, top: false, groundShade: 0.05,
    });
    // Field side of the lane, city side of it, and the storeys above it.
    box(stone, -hw + i0, voidLo, -hd + i0, hw - i0, voidHi, lz0, col,
      { batter: bat, bottom: false, top: false, groundShade: 0.05 });
    box(stone, -hw + i0, voidLo, lz1, hw - i0, voidHi, hd - i0, col,
      { batter: bat, bottom: false, top: false, groundShade: 0.05 });
    box(stone, -hw + i1, voidHi, -hd + i1, hw - i1, top, hd - i1, col,
      { batter: bat, bottom: false, top: false, groundShade: 0.05 });
    /**
     * The passage floor, and the flight that carries it over the bay-to-bay step.
     *
     * Carthage steps its construction level every bay and its towers stand every other
     * one, so thirteen of thirty-one joints climb 0.5 to 2.0 m inside the tower. Local +X
     * runs west to east; the sign is the whole of the correctness here.
     */
    const rise = lane.hiY - lane.loY;
    const treads = rise < 0.06 ? 1 : Math.min(12, Math.max(1, Math.ceil(rise / 0.31)));
    const east = lane.loIsWest ? 1 : -1;
    const going = Math.min(0.4, (TOWER_W + 1.0) / treads);
    for (let k = 0; k < treads; k++) {
      const y = lane.loY + (rise * (k + 1)) / treads;
      const cut = k * going;
      const a = east > 0 ? -hw - 0.5 + cut : -hw - 0.5;
      const b = east > 0 ? hw + 0.5 : hw + 0.5 - cut;
      box(stone, a, lane.loY - 0.4, lz0, b, y, lz1, plinthCol, { bottom: false, topGain: 1.05 });
    }
  }
  /**
   * Storey lines. Four storeys is a *count*, and a count has to be visible.
   *
   * Cut around the doorway where one lands inside it. The third course sits at `g + 15`
   * against a walk at `g + 13.7`, so it ran as a solid 0.26 m slab across the tower 0.9 m
   * over a man's head-height passage — and it is a *string course*, an external band, not
   * a floor: measured, it was the thing that took nine of the thirty-one passages back
   * under a shoulder's width at chest height after the shaft had been opened.
   */
  if (detail >= 1) {
    const laneBand = lane
      ? { z0: centreOff - lane.outer, z1: centreOff - lane.inner,
        lo: lane.loY - 0.1, hi: Math.min(top - 0.6, lane.hiY + PUNIC_PASS_HEAD) + 0.1 }
      : null;
    for (let s = 1; s < PUNIC.towerStoreys; s++) {
      const y = g + s * TOWER_STOREY;
      const inset = BATTER * 0.6 * (y - (g + PLINTH_H));
      const a = -hw - 0.20 + inset;
      const b = hw + 0.20 - inset;
      const c0 = -hd - 0.20 + inset;
      const c1 = hd + 0.20 - inset;
      if (laneBand && y + 0.26 > laneBand.lo && y < laneBand.hi) {
        box(stone, a, y, c0, b, y + 0.26, laneBand.z0, plinthCol, { bottom: false });
        box(stone, a, y, laneBand.z1, b, y + 0.26, c1, plinthCol, { bottom: false });
      } else {
        box(stone, a, y, c0, b, y + 0.26, c1, plinthCol, { bottom: false });
      }
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

/** A man is 0.84 m across the shoulders; anything narrower is not a doorway. */
const PUNIC_MIN_LANE = 0.9;
/** Clear head over the higher of the two walks a tower joins, metres. */
const PUNIC_PASS_HEAD = 2.3;
/** Stone left standing behind the passage, on the tower's city face. */
const PUNIC_PASS_BACK = 1.0;

/** The lane through a tower, and the two walks it joins. Mirrors `wall.ts towerLane`. */
interface TowerPass {
  outer: number;
  inner: number;
  loY: number;
  hiY: number;
  /** True when the *west* neighbour is the lower walk, so the flight inside climbs east. */
  loIsWest: boolean;
}

/**
 * The lane through the tower at `bay.x0`, or null where there is not one.
 *
 * **The one place the doorway is decided on this circuit**, called by the bay record the
 * siege system reads and by the stone `buildPunicTower` lays, so a hole and the path
 * through it cannot drift apart. Rome learned that the expensive way: its opening was a
 * pair of constants sized for a 3.5 m curtain and the path ran 1.36 m past the far jamb.
 *
 * Carthage's wall is 9.1 m thick and its standing band 5.7 m, so the lane is the whole
 * band — which is not a licence, it is what a *casemated* wall is. The tower keeps
 * `PUNIC_PASS_BACK` of stone on its city face and all 7.7 m of its projection.
 */
function punicTowerPass(bay: MainBay, prev: MainBay | undefined): TowerPass | null {
  if (!prev) return null;
  const here = walkGeometry(bay);
  const west = walkGeometry(prev);
  const outer = Math.min(here.outerOff, west.outerOff);
  const inner = Math.max(
    Math.max(here.innerOff, west.innerOff),
    -(HALF_T - PUNIC_PASS_BACK)
  );
  if (outer - inner < PUNIC_MIN_LANE) return null;
  return {
    outer, inner,
    loY: Math.min(bay.walkY, prev.walkY),
    hiY: Math.max(bay.walkY, prev.walkY),
    loIsWest: prev.walkY <= bay.walkY,
  };
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
  // The lintel band over the passage, and the attic above it. Its underside is drawn at
  // every detail level, because with the curtain behind it cut the coffered ceiling below
  // — which is detail 1 and up — is the only other thing between the carriageway and the
  // hollow of the attic, and at detail 0 there would be nothing.
  box(
    stone, -GATE_PASS_W * 0.5 - 0.1, g + GATE_PASS_H, -hd,
    GATE_PASS_W * 0.5 + 0.1, top, hd, col, { bottom: true, top: false }
  );
  // Crenellated crown across the whole block, on both faces.
  crenellation(
    stone, -GATE_BLOCK_W * 0.5, -hd + GATE_CREN_INSET, GATE_BLOCK_W * 0.5, -hd + GATE_CREN_INSET,
    top, GATE_MERLON_H, GATE_CREN_T, col, GATE_MERLON_W, GATE_CRENEL_W, detail >= 1
  );
  crenellation(
    stone, -GATE_BLOCK_W * 0.5, hd - GATE_CREN_INSET, GATE_BLOCK_W * 0.5, hd - GATE_CREN_INSET,
    top, GATE_MERLON_H, GATE_CREN_T, col, GATE_MERLON_W, GATE_CRENEL_W, false
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

  // --- the leaves ------------------------------------------------------------
  //
  // Only the main gate has them. §4.5 gives three gates and `Siege.ts` besieges
  // `getGates()[0]`; the other two are gatehouses whose passages are walled up, which is
  // what a city under siege does with the gates it is not using, and it keeps the flanking
  // gates from reading as two more ways in that nothing defends.
  //
  // The leaves themselves are **not built here** — they are their own chunk, so the ram can
  // take them off the screen. See `buildPunicGateLeaves` and `CityChunkSpec.gateDoorFor`.
  if (!leaves) {
    const blockCol = new THREE.Color().copy(PAL.tufa).multiplyScalar(0.9);
    stone.push(m);
    box(stone, -GATE_PASS_W * 0.5, g, -0.9, GATE_PASS_W * 0.5, g + GATE_PASS_H, 0.9,
      blockCol, { bottom: false });
    stone.pop();
  }
}

/**
 * The Porta Byrsae's twin leaves, in their own chunk so the ram's work shows.
 *
 * `CitySystem.setGateOpen` re-cuts the occupancy raster and the obstacle boxes and touches
 * no mesh, so a gate that has been broken open goes on being *drawn* shut for the rest of
 * the battle: the player watches a ram land twenty-six blows and two leaves that never move.
 * `getGateDoor()` has published the hinge line, the leaf extent and the door plane for
 * exactly this purpose since it was written and had no consumer, because the leaves were
 * `box()` calls merged into the gatehouse chunk's timber stream and there was nothing
 * separable to hide.
 *
 * They are a `CityChunkSpec` tagged `gateDoorFor` now, and `setGateDoorBroken(id)` hides
 * them. Same shape on both circuits — see `buildGateLeaves` in `wall.ts`.
 *
 * **`wrecked` is the pose the ram left them in**, into a second chunk tagged `gateWreckFor`.
 * Same constants, same hinge line, same door plane, because a wreck authored from remembered
 * dimensions is how you get splinters that do not line up with the jambs. Carthage's gate is
 * the one a player will actually assault — the Byrsa is behind it — so this is the frame the
 * whole seam exists to produce. See `PUNIC_WRECK`.
 */
function buildPunicGateLeaves(
  batch: Batch,
  detail: number,
  bay: MainBay,
  gateX: number,
  gateCz: number,
  heightAt: (x: number, z: number) => number,
  wrecked = false
): void {
  const timber = batch.s('timber');
  const metal = batch.s('metal');
  const f = bay.frame;
  const g = heightAt(gateX, gateCz);
  const rotY = Math.atan2(-f.nx, -f.nz);
  const hd = GATE_BLOCK_D * 0.5;
  const doorY = g + GATE_DOOR_SILL;
  const dm = place(
    gateX + f.nx * (hd - GATE_DOOR_SET),
    0,
    gateCz + f.nz * (hd - GATE_DOOR_SET),
    rotY
  );
  timber.push(dm);
  const leafW = GATE_PASS_W * 0.5;
  const headY = doorY + GATE_PASS_H - GATE_DOOR_SILL;
  for (const side of [-1, 1]) {
    /**
     * The leaves **meet**. They used to stop 30 mm short of the centreline apiece.
     *
     * A 60 mm slot down the middle of a shut gate is a ray straight through it, and a ray
     * straight through it is what the whole of this file's passage work is about. The two
     * boxes now share the plane at x = 0: the faces there are coincident and face opposite
     * ways, so each is back-facing from the side the other is seen from and neither can
     * z-fight. A wrecked leaf swings about its own harr-post and takes its edge with it, so
     * the pose is unaffected.
     */
    const x0 = side < 0 ? -leafW : 0;
    const x1 = side < 0 ? 0 : leafW;
    /**
     * The wrecked pose, about this leaf's own harr-post.
     *
     * `side = -1` is still hanging, swung into the passage and canted because its upper
     * collar tore out; `side = +1` went down flat across the carriageway. Local `+z` is the
     * city side here — `rotY` is `atan2(-nx, -nz)`, so `+z` runs *against* the wall's
     * outward normal — which is the only direction a ram can drive a leaf.
     */
    const hingeX = side * leafW;
    if (wrecked) {
      const m = new THREE.Matrix4();
      if (side < 0) {
        m.makeTranslation(hingeX, doorY, 0)
          .multiply(new THREE.Matrix4().makeRotationY(side * PUNIC_WRECK.swing))
          .multiply(new THREE.Matrix4().makeRotationX(PUNIC_WRECK.cant))
          .multiply(new THREE.Matrix4().makeTranslation(-hingeX, -doorY, 0));
      } else {
        m.makeTranslation(hingeX * PUNIC_WRECK.slide, g + PUNIC_WRECK.lie, PUNIC_WRECK.shove)
          .multiply(new THREE.Matrix4().makeRotationY(PUNIC_WRECK.yaw))
          .multiply(new THREE.Matrix4().makeRotationX(PUNIC_WRECK.flat))
          .multiply(new THREE.Matrix4().makeTranslation(-hingeX, -doorY, 0));
      }
      timber.push(m);
    }
    if (!wrecked) {
      box(timber, x0, doorY, -GATE_DOOR_T * 0.5, x1, headY,
        GATE_DOOR_T * 0.5, PAL.timberDark, { bottom: false });
    } else {
      /**
       * Broken into its plank columns, because a slab cannot have a ragged edge.
       *
       * The shut leaf is one box — at 5.2 m of passage that is the right cost and nobody can
       * see a joint at battle range. A *broken* one is read entirely by its top edge, so the
       * wrecked pose spends eight columns on each leaf to get a jagged one. The loss is
       * greatest at the meeting stile, where the ram lands, and tapers to the braced hanging
       * stile: a V bitten out of the middle, not a rectangle of missing door.
       */
      const cols = detail >= 1 ? 8 : 4;
      for (let j = 0; j < cols; j++) {
        const a = lerp(x0, x1, j / cols);
        const b = lerp(x0, x1, (j + 1) / cols);
        // `j` runs from the meeting stile outward on the +side and inward on the −side.
        const out = side < 0 ? j / cols : 1 - (j + 1) / cols;
        const keep = Math.min(1, (side < 0 ? 0.30 : 0.54) + 0.5 * (1 - out) + hash2(j, side + 3, 71) * 0.15);
        const top = doorY + (headY - doorY) * keep;
        box(timber, Math.min(a, b), doorY, -GATE_DOOR_T * 0.5, Math.max(a, b), top,
          GATE_DOOR_T * 0.5, new THREE.Color().copy(PAL.timberDark).multiplyScalar(0.94 + hash2(j, side + 9, 23) * 0.22),
          { bottom: false });
      }
    }
    if (detail >= 1) {
      // Ledges. On the wrecked leaf only the ones still under timber survive; the top of the
      // leaf went with the boarding it was nailed to.
      const survive = wrecked ? (side < 0 ? 2 : 3) : 5;
      for (let k = 0; k < survive; k++) {
        const y = doorY + 0.7 + k * ((GATE_PASS_H - 1.6) / 4);
        box(timber, x0 + 0.05, y, -GATE_DOOR_T * 0.5 - 0.05, x1 - 0.05, y + 0.16,
          -GATE_DOOR_T * 0.5, PAL.timber, { bottom: false });
      }
    }
    if (wrecked) timber.pop();
  }
  if (wrecked) {
    /**
     * Plank ends and splinters, scattered **through** the arch and not just behind it.
     *
     * The leaves are 3.4 m inside a 16.6 m passage, so everything modelled at the door plane
     * is in shadow behind a stone reveal: shot from the field at 70 m the broken gate and the
     * open gate are the same dark rectangle, which is the whole failure this work exists to
     * fix restated one step further in. The player watches the ram from outside, so the wreck
     * has to reach outside. `-9.5` is 4.6 m clear of the block's own outer face, on the paved
     * apron the ram stood on; a ram breaks a leaf by striking its outer face and the timber it
     * takes off it goes that way.
     */
    for (let k = 0; k < 10; k++) {
      const hx0 = hash2(k, 3, 91);
      const hz0 = hash2(k, 8, 37);
      const ha = hash2(k, 12, 61);
      const sm = new THREE.Matrix4()
        .makeTranslation((hx0 - 0.5) * GATE_PASS_W * 1.5, g + 0.12, -9.5 + hz0 * 14.0)
        .multiply(new THREE.Matrix4().makeRotationY(ha * Math.PI))
        .multiply(new THREE.Matrix4().makeRotationZ((ha - 0.5) * 0.3));
      timber.push(sm);
      const ln = 0.4 + ha * 1.3;
      box(timber, -ln, -0.055, -0.1, ln, 0.055, 0.1,
        new THREE.Color().copy(PAL.timberDark).multiplyScalar(1.0 + hz0 * 0.3));
      timber.pop();
    }
  }
  timber.pop();
  if (detail >= 1) {
    metal.push(dm);
    if (!wrecked) {
      // The drawbar: this gate is barred, not merely closed.
      box(metal, -leafW + 0.2, doorY + GATE_PASS_H * 0.44, -GATE_DOOR_T * 0.5 - 0.16,
        leafW - 0.2, doorY + GATE_PASS_H * 0.44 + 0.3, -GATE_DOOR_T * 0.5 - 0.02,
        PAL.iron, { bottom: false });
    } else {
      // And snapped, in two pieces on the paving. Nothing else in the frame says the gate
      // was *barred* and the bar gave way.
      for (const side of [-1, 1]) {
        const bm = new THREE.Matrix4()
          .makeTranslation(side * leafW * 0.5, g + 0.26, 1.2 + side * 0.7)
          .multiply(new THREE.Matrix4().makeRotationY(side * 0.44 + PUNIC_WRECK.yaw * 0.5))
          .multiply(new THREE.Matrix4().makeRotationZ(side * 0.06));
        metal.push(bm);
        const half = leafW * 0.5 - 0.1;
        box(metal, -half, -0.15, -0.14, half, 0.15, 0.14, PAL.iron);
        metal.pop();
      }
    }
    metal.pop();
  }
}

/**
 * The pose the ram leaves the Porta Byrsae in. See `WRECK` in `wall.ts` for the argument;
 * the numbers differ because this passage is 5.2 m wide against Rome's 8.6 and 16.6 m deep
 * against 11, so a leaf that fell as far as Rome's would still be under the arch.
 */
const PUNIC_WRECK = {
  /** Swing of the surviving leaf into the passage, radians. 43 deg. */
  swing: 0.75,
  /** Cant off plumb, the upper collar having torn out of the jamb. */
  cant: 0.09,
  /** Tip of the fallen leaf: 83 deg, head slightly raised off the paving. */
  flat: 1.449,
  /** Skew of the fallen leaf across the carriageway. */
  yaw: -0.27,
  /** How far its foot slid off the hinge line, as a fraction of the half-width. */
  slide: 0.6,
  /** How far in from the door plane it came to rest. */
  shove: 0.7,
  /** Height of its foot above the ground under the gate. */
  lie: 0.17,
} as const;

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
  beltDepth: BELT_DEPTH,
  /** Berm between the outer face and the ditch's counterscarp. */
  berm: BERM,
  /** Signed offset of the ditch centreline from the wall's, along the **outward** normal. */
  ditchOffset: DITCH_OFF,
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
