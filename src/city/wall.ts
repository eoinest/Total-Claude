import * as THREE from 'three';
import { cylinder, type Batch, type GeoStream } from './build';
import type { BayStage, WallNode } from './layout';
import type { CityMatKey } from './materials';

/**
 * The contract a city's fortification publishes, and nothing else.
 *
 * Rome's Aurelian curtain used to be this file: 3,825 lines of which the interfaces below
 * were the first six hundred and the rest was Rome. `docs/ROME.md` §14.6 — the city that
 * never got a directory — is about exactly that, and the stone has moved to
 * `src/city/rome/`: the line, the section, the curtain, the towers and the stairs to
 * `rome/circuit.ts`, the Porta Flaminia to `rome/apertures.ts`, the building site to
 * `rome/works.ts`, the cross-section primitives they share to `rome/section.ts`.
 *
 * What stays is what a **third** city has to satisfy, which is the whole point of
 * `cityPlan.ts`: `WallBuildOutput` and the eleven records it carries. Two mesh helpers ride
 * along at the bottom for want of a better home; see the note above them.
 *
 * **One thing did not divide cleanly, and it is recorded rather than fixed.**
 * `unfinishedTopAt` — the top of the masonry on a bay that is a bare footing or a rubble
 * gap — is read by `CitySystem.masonryTopAt` and `obstacleTopAt` for *whichever* city is
 * standing, but its answer is Rome's construction programme and Rome's plinth height. It
 * has moved to `rome/section.ts` with the section it measures, and `CitySystem` now imports
 * it from there in the open. Carthage never reaches the branch — every Punic bay is
 * `finished` — so nothing changed; what changed is that the Rome-shaped hole in the
 * generic machinery is now visible in an import line instead of hidden in this file.
 *
 * `carthageWall.ts` is the proof it is a real contract: it returns a `WallBuildOutput` and
 * `CitySystem` drives it with no second implementation of wall traversal.
 */

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

// ---------------------------------------------------------------------------
// Two mesh helpers, kept here because they are geometry and not a wall
//
// Both are generic — a capsule between two points — and both are, as of §15 task 0, used
// only by Rome's builders (`rome/apertures.ts`, `rome/works.ts`, `rome/monuments.ts`,
// `rome/fabric.ts`); Carthage builds its timber out of `build.ts`'s `quadPrism`. The banner
// above them used to claim "the other city builders", which was never true. They arguably
// belong in `build.ts` beside `cylinder`; moving them is a decision about `build.ts`, not
// about this file, so it is recorded rather than taken here.
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
