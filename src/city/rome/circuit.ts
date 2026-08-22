import * as THREE from 'three';
// `terrain/topography`, not `terrain/TerrainSystem`, which merely re-exports the same
// constant. `TerrainSystem` imports `activeMap`, so taking it from there closes an ESM cycle
// the moment a map declares its city: maps/index -> campusMartius -> city/rome/plan ->
// city/rome/circuit -> terrain/TerrainSystem -> maps/index. `topography` imports nothing.
import {
  MURO_TORTO,
  muroTortoTopAt,
  romeWallZ,
  WALL_LENGTH,
  WALL_X_MAX,
  WALL_X_MIN,
} from '../../terrain/topography';
import { clamp, lerp } from '../../util/math';
import { Rng, hash2 } from '../../util/rand';
import { archPanel, box, crenellation, hipRoof, quadPrism, type Batch, type GeoStream } from '../build';
import type { BayStage, WallNode } from '../layout';
import type { CityMatKey } from '../materials';
import { PAL } from '../palette';
import {
  type Blocker,
  type CityChunkSpec,
  type GarrisonBay,
  type GateBlockOut,
  type GateDoorOut,
  type GateOut,
  type RoughGround,
  type TreeRequest,
  type WallBuildOutput,
  type WallSegmentOut,
  type WallStair,
} from '../wall';
import { assertRomeSection, type RomeSection } from './assertions';
import {
  APERTURES,
  apertureOfBay,
  buildGate,
  buildGateLeaves,
  buildPosterula,
  curtainSpans,
  GATES,
  GATE_ATTIC,
  GATE_CREN_INSET,
  type Aperture,
  GATE_CREN_T,
  GATE_CRENEL_W,
  GATE_DOOR_H,
  GATE_DOOR_SET,
  GATE_DOOR_SILL,
  GATE_DOOR_T,
  GATE_MERLON_H,
  GATE_MERLON_W,
  GATE_PASS_H,
  inGateBlock,
} from './apertures';
import {
  BAY_COUNT,
  clipBay,
  CURTAIN_T,
  frameOf,
  GALLERY_PIER_OFF,
  HALF_T,
  MIN_LANE,
  OUT,
  P0,
  P1,
  P2,
  P3,
  TOWER_CH_INSET,
  TOWER_CH_WALL,
  TOWER_PASS_HEAD,
  towerLane,
  unfinishedTopAt,
  WALL,
  walkGeometry,
  worstRiseOf,
  type Bay,
  type Frame,
  type TowerPassOut,
} from './section';
import {
  buildFootingSite,
  buildGapBarricade,
  buildRiverTerminus,
  buildRiverWall,
  buildScaffold,
  buildYard,
  riverTerminusPlan,
  riverWallPlan,
} from './works';

/**
 * The Aurelian circuit — `docs/ROME.md` §4 — its line, its bays, its towers and its stairs.
 *
 * Aurelian began the circuit *because of* this invasion, so in 271 the wall is a
 * building site: finished stretches near the gate, half-built curtains with
 * scaffolding and treadwheel cranes, stockpiled travertine and brick, mortar pits,
 * and gaps blocked in a hurry with palisade and rubble. `bayStage` decides which is which
 * and `./works` dresses it.
 *
 * Dimensions (sources in `./section`): 6.5 m to the wall-walk, `CURTAIN_T` thick,
 * brick-faced concrete on a travertine footing, square towers projecting 3.5 m at
 * one *actus* (35.5 m) intervals, each carrying a ballista chamber under a tiled
 * roof. The monumental gate sits on the axis of the Via Flaminia.
 *
 * The curtain is built bay by bay between towers. Within a bay the wall-walk is
 * *level*; between bays it steps. That is how real Roman curtains cross sloping
 * ground — they step the courses rather than shearing them.
 *
 * This file is `carthageWall.ts`'s peer, and `buildWall` returns the same `WallBuildOutput`
 * `buildCarthageWall` does, which is what lets `CitySystem` drive either with one
 * implementation of wall traversal. It is the top of the Rome wall tree: it imports
 * `./section`, `./apertures` and `./works`, and none of them import it.
 *
 * §14.5 records that Rome's wall line exists in more than one place today —
 * `crestZAt` is both the terrain's crest and the wall's line. §15 task 2 is where that
 * stops being true; `WALL_X_MIN`, `wallCrestZ` and `fitWallPath` below are the three
 * exports that will change shape when it does.
 */


/**
 * The circuit's two anchors and its line, **re-exported from one definition**.
 *
 * All three used to be computed here, off `crestZAt` — the terrain's own crest, which was
 * simultaneously the hill's brow, the wall's line, the scatter's glacis datum and the
 * city fabric's inner limit. §14.5 is about exactly that: four meanings of one function and
 * nothing to change when one of them has to move. They now live in `terrain/topography.ts`
 * beside the bench that is graded under them, which is Carthage's arrangement
 * (`maps/carthage/topography.ts` owns `carthageWallZ`, `WALL_X_MIN/MAX` and
 * `WALL_BENCH_HALF`, and `city/carthage/circuit.ts` re-exports them), and it is the
 * arrangement the import graph forces: `terrain/heightfield.ts` cannot import this file.
 *
 * `WALL_X_MIN` moved from **-631 to +1** when the Tiber went onto the survey: it was
 * derived from the modelled channel's bank, and the modelled channel was 594 world metres
 * west of the real one at that latitude, so five bays of Aurelian curtain stood at 3.5-9.1 m
 * — at and below `WATER_LEVEL` — and 633 world metres of it stood where the Tiber belongs.
 * §2.5 puts the surveyed north-west angle at x +2.2; the derivation lands on +1.
 */
export { WALL_LENGTH, WALL_X_MAX, WALL_X_MIN };

/**
 * Wall-line helper, straight from the terrain contract — and now the *only* line.
 *
 * `romeWallZ` is what the heightfield's bench, this file's `fitWallPath`, `ScatterField`'s
 * glacis clearance and `campusMartius.ts`'s scatter exclusion all read. §15 task 3 replaces
 * its body with the projected survey polyline and every one of them moves with it.
 */
export const wallCrestZ = romeWallZ;

/**
 * Clear ground between the wall's centreline and the nearest building, metres.
 *
 * Rome kept a consecrated strip inside the circuit — the *pomerium* — free of building,
 * and Aurelian's engineers needed a military road behind the curtain to move men to a
 * threatened stretch. So the institution is real; the number is chosen for the battle.
 *
 * It has to hold three things at once, one behind the other:
 *   - a lateral movement corridor so a reserve can run the length of the wall   ~20 m
 *   - depth to form up facing a breach: a cohort in line is 35 m across and about
 *     five metres deep, and it needs room to wheel into position                ~25 m
 *   - slack, so a unit forming up is not standing in the movement corridor      ~15 m
 *
 * Sixty metres. It was twelve, measured on the plot *centre* rather than its edge, which
 * in practice put insula walls 1.2 m off the back of the curtain and left the defenders
 * of a breach nowhere to stand.
 */
export const POMERIUM = 60;

/**
 * How far a bay may be lifted by being held at its neighbour's construction level, metres.
 *
 * Four 0.55 m increments. See the levelling loop in `buildWall` for the derivation: it is
 * half of what `Siege.stepAcross` will carry across a 5.4 m tower gap, and the paired joint
 * is about twice the lift.
 */
const PAIR_MAX_LIFT = 2.2;

/**
 * Sample the wall line. Real fortification practice puts the curtain on the crest, and
 * the terrain publishes exactly that line, so there is nothing to search for: follow
 * `crestZAt` and let the wall wander the 150 m in plan that it wants to.
 */
export function fitWallPath(
  heightAt: (x: number, z: number) => number,
  spacing = 55,
  /**
   * The span to fit, defaulting to the circuit's own.
   *
   * Only `carthageWall.ts`'s `aurelianLine` passes anything else, and it passes the span
   * Rome's circuit had when `probe-carthage-wall`'s assertions were written. See there.
   */
  xMin = WALL_X_MIN,
  xMax = WALL_X_MAX
): WallNode[] {
  const length = xMax - xMin;
  const n = Math.round(length / spacing) + 1;
  const out: WallNode[] = [];
  for (let i = 0; i < n; i++) {
    const x = xMin + (i * length) / (n - 1);
    const z = wallCrestZ(x);
    out.push({ x, z, ground: heightAt(x, z) });
  }
  return out;
}

/**
 * What stage of construction each of the 36 bays is at, **and now there is a reason**.
 * §4.8, §15 task 3.
 *
 * The old rule keyed every stage off `k = bayIndex − gateBay` and explicitly discarded
 * `bayCount`, and its own comment gave the reason as a *camera* one: the stages were *"placed
 * close to the gate on purpose, so the construction story lands in the frames that matter"*.
 * Where the wall was, what it stood on, and what was already there when Aurelian's surveyors
 * arrived had no bearing on it at all.
 *
 * §4.8 replaces that with the archaeology, and the archaeology is arithmetic. Lanciani lists
 * the ready-made works the surveyors took into the line on this front — the Horti Aciliorum's
 * terrace substruction at 550 real m, the Horti Sallustiani's enclosure at 1,200, the Castra
 * Praetoria's north and east walls at 1,050 — **2,800 m of about 4,000, seventy per cent**.
 * The stretch with nothing to reuse is Cozza's 263 m from the Tiber angle to the Porta
 * Flaminia plus his 114 m from the gate to the Pincian's north-west corner: 377 real m, which
 * at `KX` is 167 world metres and four and a half bays, and which is exactly the flat Campus
 * Martius neck between the river and the hill.
 *
 * *The only stretch of this circuit Aurelian had to build from nothing is the stretch the map
 * is named after, and it is the stretch with no terrain advantage, at the end of the only
 * road, in the funnel.* So bays 0, 2 and 4 are `footing` and bay 3 is a `gap`, which is where
 * the assault goes; bays 5–11 are the Muro Torto, finished before the wall was begun; and the
 * two garden estates and the camp carry the rest.
 *
 * Written as a table against **absolute** bay indices because §4.8's is, and because a
 * construction state that moves when the gate moves is the thing being replaced. It is only
 * meaningful for `BAY_COUNT = 36`; anything else falls through to `finished`, and
 * `assertRomeSection` grades the resulting stage census against §4.8's own totals.
 */
const BAY_STAGES: readonly BayStage[] = [
  /*  0 */ 'footing',     // the Tiber angle and the corner tower *Lo Trullo* — nothing here
  /*  1 */ 'finished',    // Porta Flaminia: everything, first, because a circuit with no way
  /*  2 */ 'footing',     //   through it is useless to the city inside it
  /*  3 */ 'gap',         // the Campus neck — 190 world m of unbuilt wall either side of the
  /*  4 */ 'footing',     //   finished gate, on the flat, at the end of the road
  /*  5 */ 'finished',    // ---- the Muro Torto: 550 real m of standing terrace, gigantic,
  /*  6 */ 'finished',    //      and Lanciani records that Aurelian added nothing to it
  /*  7 */ 'finished',
  /*  8 */ 'finished',
  /*  9 */ 'finished',
  /* 10 */ 'finished',
  /* 11 */ 'finished',
  /* 12 */ 'no-parapet',  // the Pincian crest: *horti* enclosure walls, heightened
  /* 13 */ 'no-parapet',
  /* 14 */ 'half-built',  // Posterula Pinciana, in a garden wall
  /* 15 */ 'half-built',  // ---- the Horti Sallustiani, west: 1,200 real m of standing
  /* 16 */ 'half-built',  //      enclosure
  /* 17 */ 'finished',
  /* 18 */ 'finished',
  /* 19 */ 'finished',
  /* 20 */ 'finished',    // Porta Salaria
  /* 21 */ 'no-parapet',  // ---- the Sallustian east shoulder and the tomb frontage
  /* 22 */ 'no-parapet',
  /* 23 */ 'finished',
  /* 24 */ 'finished',
  /* 25 */ 'finished',
  /* 26 */ 'finished',
  /* 27 */ 'finished',
  /* 28 */ 'finished',
  /* 29 */ 'half-built',  // Porta Nomentana
  /* 30 */ 'no-parapet',  // the approach to the camp: little to reuse
  /* 31 */ 'finished',    // ---- the Castra Praetoria: 1,050 real m of standing military
  /* 32 */ 'finished',    //      wall, heightened by the men who lived inside it
  /* 33 */ 'finished',
  /* 34 */ 'finished',
  /* 35 */ 'finished',
];

export function bayStage(bayIndex: number, bayCount: number, gateBay: number): BayStage {
  void bayCount;
  void gateBay;
  return BAY_STAGES[bayIndex] ?? 'finished';
}

/** True where this bay is one of the Muro Torto's seven. §4.5. */
export function onMuroTorto(bayIndex: number): boolean {
  const x0 = WALL_X_MIN + bayIndex * WALL.towerSpacing;
  const x1 = x0 + WALL.towerSpacing;
  return x1 > MURO_TORTO.x0 + 1 && x0 < MURO_TORTO.x1 - 1;
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
 * What Rome's builder returns: `WallBuildOutput`, plus its own build-time self-check.
 *
 * `carthageWall.ts` has `CarthageWallOutput extends WallBuildOutput` for exactly this reason
 * — a city may add fields to the contract and may not change one. §14.4a asked for
 * `assertRomeSection`'s results *as data on the output*, and this is the type that carries
 * them narrowly enough for `rome/plan.ts` to read without a cast.
 */
export interface RomeWallOutput extends WallBuildOutput {
  gateBlocks: GateBlockOut[];
  section: RomeSection;
  sectionFaults: readonly string[];
}

export function buildWall(heightAt: (x: number, z: number) => number, rngSeed: string): RomeWallOutput {
  const rng = new Rng(rngSeed);
  const path = fitWallPath(heightAt);
  /*
   * **36 bays between two surveyed anchors, and the count is the input.** §4.4, §15 task 3.
   *
   * It was `floor(WALL_LENGTH / WALL.towerSpacing) + 1`, which is the right shape when the
   * pitch is chosen and the ends fall where they may. Both ends of this circuit are survey
   * positions — the Tiber angle at x +2.0 and the Castra Praetoria's north-east angle at
   * x +1334.6 — so the count is what is chosen and the pitch is derived from it
   * (`WALL.towerSpacing`). Deriving it back out of a floating-point division would also put
   * the whole circuit one bay short on the wrong side of a rounding boundary.
   */
  const towerCount = BAY_COUNT + 1;

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
    /*
     * §4.5: the Muro Torto is a garden-terrace substruction and *"the tallest thing on the
     * northern front"*, so its seven bays are built to `MURO_TORTO.height` and not to the
     * curtain's 6.5 m. See that constant for why the figure is 13.32 m and not §4.5's 15.
     */
    /*
     * On the Muro Torto the level is taken from **the terrace the heightfield graded**, not
     * from the measured ground under the centreline, and the two are different numbers.
     * `muroTortoTopAt` is the same call stage 4d2 banks the hillside to; `gmax` is that call
     * plus whatever eight per cent of natural relief the bench left standing on the wall
     * line. Levelling to `gmax` therefore puts the walk up to a metre above the ground a man
     * is supposed to step onto it from, uncorrelated bay by bay, and the apron carries the
     * error. Levelling to the published terrace means the wall and the hill behind it are
     * derived from one function, which is §14.5's rule applied across the terrain seam.
     */
    need[b] = onMuroTorto(b)
      ? Math.max(muroTortoTopAt(x0), muroTortoTopAt(x1))
      : gmax + WALL.height;
    let fine = gmax;
    for (let s = 0; s <= 24; s++) {
      const x = lerp(x0, x1, s / 24);
      const g = heightAt(x, zAt(x));
      if (g > fine) fine = g;
    }
    gMaxOf[b] = fine;
  }
  /*
   * Quantise to 0.55 m construction increments, held over pairs of bays: flat runs of ~71 m
   * with a visible step between them.
   *
   * **Except where the pair would double a step the ground is already making.** Holding two
   * bays at one level takes the higher of the two, so on a climb the second bay is lifted by
   * a whole bay's worth of rise and the joint at the *pair* boundary carries twice what a
   * bay boundary would. On flat ground that is free and it is why the rule exists. On the
   * Muro Torto, where §3.5's profile climbs 36 m over 259 world metres, it is not: measured
   * with the bench in and the pairing unconditional, the worst bay-to-bay `walkY` step was
   * **10.45 m at x 286** — two bays' rise of 4.9 m each, welded into one — against 4.95 m
   * when each bay takes its own level.
   *
   * That difference decides whether a man can get up the hill. A tower gap is about 5.4 m of
   * plan, and `Siege.stepAcross` admits a joint up to `gap x 0.912` — the tread module the
   * flight would be built from — so a 4.95 m step at pitch 0.909 is a flight and a 10.45 m
   * step at 1.9 is a hole. `PAIR_MAX_LIFT` is set so a paired joint stays inside what the
   * tread module can carry: pairing lifts the lower bay by one bay's rise, the paired joint
   * is about twice that, and 2.2 m of lift is 4 construction increments and a joint of about
   * 4.4 m against the 4.9 m limit.
   *
   * This is not a smoothing of the step. §3.5 is explicit that *"every bay boundary on the
   * Muro Torto and in the Vallis Sallustiana will sever a run. That is correct behaviour and
   * it is what §9 budgets stairs against; it is not a bug to smooth away."* The steps stay;
   * they are the ones the ground makes, not twice them.
   */
  const level = new Float64Array(nBays);
  for (let b = 0; b < nBays; b++) {
    const pair = b - (b % 2);
    const paired = Math.ceil(Math.max(need[pair], need[Math.min(nBays - 1, pair + 1)]) / 0.55) * 0.55;
    /*
     * **And the Muro Torto is not quantised at all**, because nothing was built here.
     *
     * 0.55 m is a *construction increment* — the lift a gang pours in one operation, which is
     * why the finished curtain steps in multiples of it. §4.5's whole point is that Aurelian's
     * men laid no lifts on this stretch: it is the Horti Aciliorum's terrace substruction,
     * standing since the Julio-Claudians, and Lanciani records that the extra works added to
     * it were *none*. Its crest is the terrace's own level, and rounding that up to the next
     * pour puts the walk up to 0.55 m above the hillside a man steps onto it from — half the
     * apron's whole error budget, spent on a lift nobody poured.
     */
    const own = onMuroTorto(b) ? need[b] : Math.ceil(need[b] / 0.55) * 0.55;
    /*
     * **And never on the Muro Torto**, whatever `PAIR_MAX_LIFT` would allow. §4.5, §15 task 4.
     *
     * Everywhere else a paired lift buys a flat 74 m run for the price of a slightly taller
     * bay. Here it costs the thing the stretch exists for: the earth is banked against the
     * back of the mass to crest level, and a bay held 2.2 m above its own need is a bay whose
     * walk stands 2.2 m over the hillside it is supposed to be walked onto. Measured with the
     * pairing left in, the worst apron rose **2.12 m** against a 0.62 m level joint, and every
     * centimetre of it was the pair lift.
     */
    level[b] = !onMuroTorto(b) && paired - own <= PAIR_MAX_LIFT ? paired : own;
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
    // Which bay carries which aperture is `APERTURES`' answer, by containment and not by
    // rounding: §14.3's fault at Carthage is a gate whose index and whose x disagree.
    const ap = apertureOfBay(b);
    const isGate = ap !== null && ap.kind !== 'posterula';
    const stage: BayStage = bayStage(b, nBays, 0);
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
      /**
       * **A gate bay is garrisonable again, and the arithmetic in §4.8 is why.**
       *
       * It was `walk.garrisonable && !isGate`, and the reason given was escalade: on the old
       * circuit bay 20's walk stood 14.50 m over its own ground because the construction
       * level was held over the pair 20/21 while bay 21 climbed a hill, and `probe-siege`
       * refuses any bay within five of the gate that rises past 14 m. On the redesigned
       * circuit the Porta Flaminia is bay 1, on the 12.2 m Campus Martius plain between two
       * `footing` bays, and it rises 6.5 m. *That is not luck; it is the reason the gate is
       * where it is* (§5.4).
       *
       * §4.8's census wants **32** garrisonable bays out of 36 — every bay that is not one of
       * the three `footing`s or the `gap` — and the curtain either side of a gatehouse is
       * ordinary curtain a rank can stand on. What must not happen is a rank laid *across* the
       * block, and that is `Siege.buildSpine`'s gate-block clip, which is now published for
       * all three blocks through `getGateBlocks()`. `Siege.recut` then severs the two stubs
       * into their own runs, because 25 m of masonry is a long way past `STATION_PITCH`.
       */
      garrisonable: walk.garrisonable,
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

  /*
   * The river terminus is masonry, and it now says so.
   *
   * A degenerate segment blocker is a disc, which is the drum's plan. It closes the last
   * metres between the circuit's west end and the Tiber: `WALL_RIVER_CLEAR` is set so the
   * drum's west face reaches the water's edge, and without this the tower was drawn and
   * collided with nothing. §4.6's river wall down the left bank (§15 task 9) is the proper
   * closure; this is the one that exists today.
   */
  {
    const t = riverTerminusPlan(bays[0]);
    blockers.push({ x1: t.cx, z1: t.cz, x2: t.cx, z2: t.cz, halfW: t.radius });
    /*
     * **The first thirty metres of §4.6's west return, built early because task 3 opened a
     * hole that was not there before.**
     *
     * `WALL_X_MIN` was solved from the water — `riverBankX(romeWallZ(x), 1) + 12` — so the
     * drum's west face reached the channel and the circuit's west end was shut. §15 task 3
     * moves the anchor onto the survey's north-west angle at x +2.0, which is **40.5 m east
     * of the modelled east bank**: the two are independently projected surveys and they do
     * not agree, whatever the comment on `WALL_RIVER_CLEAR` used to claim. Left alone that
     * is 30 m of dry, level, unblocked ground round the end of the Aurelian Wall — the
     * *east* flank's defect (§4.1) reproduced on the west, by this pass, tonight.
     *
     * So the return starts here rather than in task 9. It is §4.6's own section and not the
     * land curtain: **1.20 m thick and 5–6 m high**, the dimensions of the one surviving
     * fragment of the river wall opposite the ex-Mattatoio, *"markedly lighter"* than the
     * land walls in Dey's words. Drawn by `buildRiverWall` and blockered here, so the width
     * the eye sees and the width the collision surface sees are the same 1.20 m.
     */
    const rw = riverWallPlan(bays[0]);
    if (rw) blockers.push({ x1: rw.x0, z1: rw.z, x2: rw.x1, z2: rw.z, halfW: rw.halfT });
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
  /**
   * Which bays could carry a masonry flight at all, in order along the circuit.
   *
   * The cadence used to be `bay.index % 4 !== 2`, an arithmetic every-fourth-bay taken over
   * the whole circuit, and §4.8's construction programme broke it: the finished stretches are
   * now *clustered* — the two garden estates and the camp — and the unfinished ones are the
   * western third, so an every-fourth-bay rule landed on three finished bays out of thirty-six
   * and left the east half with a flight every 148 m and the west with none at all.
   *
   * So the cadence runs along the bays that can actually take one: every second **eligible**
   * bay, which is one per 74 m of finished curtain — near enough the spacing of the surviving
   * Aurelianic stairs, and the interval §9 is written against. Task 10 deletes all of them and
   * puts the stair inside the tower, at which point this whole rule goes.
   */
  const stairable = bays.filter((bay) =>
    bay.stage === 'finished'
    && !onMuroTorto(bay.index)
    && !inGateBlock(bay.x0)
    && !inGateBlock(bay.x0 + STAIR_MAX_RUN));
  const stairBays = new Set(stairable.filter((_, k) => k % 2 === 0).map((b) => b.index));
  for (const bay of bays) {
    /*
     * **The Muro Torto gets an apron, not a flight.** §4.5, §15 task 4.
     *
     * *"It needs no stairs, because a man walks onto it off the Pincian's own hillside. It
     * publishes a `WallStair` with a rise near zero at each end, or a graded apron, so the
     * garrison is not stranded — which is exactly the failure runs 0 and 1 have today,
     * arrived at from the opposite direction."* `muroTortoApron` below is that object; a
     * masonry flight here would be the *"extra works of defence"* Lanciani records Aurelian
     * as having added none of.
     */
    if (onMuroTorto(bay.index)) {
      const apron = muroTortoApron(bay, walkGeometry(bay).walkY, heightAt);
      if (apron) stairs.push(apron);
      continue;
    }
    if (!stairBays.has(bay.index)) continue;
    const plan = stairPlan(bay, walkGeometry(bay).walkY, heightAt);
    if (plan) stairs.push(plan);
  }
  const stairByBay = new Map<number, WallStair>();
  for (const s of stairs) stairByBay.set(s.bay, s);

  /**
   * **Three gates and a *posterula*, from one table.** §5.1, §14.3, §15 task 5.
   *
   * Every aperture's position, class, block and clear width comes off `APERTURES`, which is
   * also where the snap to the bay grid happens and where the snap distance is recorded.
   * Nothing here chooses a width: §5.2's rule is that a gate publishes `clearWidth` and
   * nothing else computes one, and the three views that still disagree about it —
   * drawn / collided / rastered — are task 6's to reconcile against this record.
   *
   * The *posterula* is deliberately **not** in `gates`. §5.1: *"Porta Pinciana is a postern
   * in 271 and must not be built as a gate."* It is drawn by `buildPosterula` into the
   * curtain's own chunk, it publishes no `GateOut`, no `GateBlockOut` and no passage, and it
   * is shut. §15 task 7 gives it a `Crossing`.
   */
  const gates: GateOut[] = [];
  const gateBlocks: GateBlockOut[] = [];
  for (const ap of GATES) {
    const ref = bays[ap.bay];
    const fr = frameOf(ref.x0, ref.z0, ref.x1, ref.z1);
    const cz = lerp(ref.z0, ref.z1, (ap.x - ref.x0) / WALL.towerSpacing);
    const gg = heightAt(ap.x, cz);
    // A second-class gate is a lower building; `buildGate` takes the same two numbers off
    // `ap.kind` and this has to agree with it or `masonryTopAt` reports a crown that is not
    // there. Kept as one expression per class in one place for that reason.
    const passH = ap.kind === 'first' ? GATE_PASS_H : GATE_PASS_H - 1.2;
    const attic = ap.kind === 'first' ? GATE_ATTIC : GATE_ATTIC - 1.4;
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
    gates.push({ id: ap.id, x: ap.x, z: cz, facing: Math.atan2(fr.nx, fr.nz), open: false });
    // The gatehouse as a solid, for the consumers that need to know where the masonry is.
    // Held separately from the bays because a block straddles two of them: reading it off
    // `bay.isGate` reported the block over 37 m of ground it does not stand on and missed
    // the metres of it that stand in the bay next door.
    gateBlocks.push({
      id: ap.id,
      x: ap.x,
      z: cz,
      nx: fr.nx, nz: fr.nz, dx: fr.dx, dz: fr.dz,
      halfRun: ap.blockW * 0.5,
      halfDepth: ap.blockD * 0.5 + 0.45,
      topY: gg + passH + attic + GATE_MERLON_H,
      // The crown, at the merlons' feet. `buildGate` calls the same expression `blockTop`.
      sillY: gg + passH + attic,
      // `buildGate` authors the merlon line at local z = `zF + GATE_CREN_INSET`, and modules
      // are authored with -Z outward (see `frameOf`), so its offset along `n` is positive.
      parapetInner: ap.blockD * 0.5 - GATE_CREN_INSET - GATE_CREN_T * 0.5,
      parapetOuter: ap.blockD * 0.5 - GATE_CREN_INSET + GATE_CREN_T * 0.5,
      crenelledCityward: false,
      merlonLength: GATE_MERLON_W,
      crenelLength: GATE_CRENEL_W,
      openHalf: ap.clearWidth * 0.5,
    });
  }

  /**
   * The leaves the ram breaks, and there is still exactly one set of them.
   *
   * `siegeGateId` stays `porta-flaminia` (§5.1): it is on firm ground, at the end of the one
   * road, and the only aperture on the map a ram can reach (§3.6). The Salaria and the
   * Nomentana are shut and are drawn shut; giving them a `GateDoorOut` would publish two more
   * things the siege system can be told to break and cannot get to.
   */
  const siegeAp = GATES.find((a) => a.siege) as Aperture;
  const gateBayRef = bays[siegeAp.bay];
  const gFrame = frameOf(gateBayRef.x0, gateBayRef.z0, gateBayRef.x1, gateBayRef.z1);
  const gateCz = lerp(gateBayRef.z0, gateBayRef.z1, (siegeAp.x - gateBayRef.x0) / WALL.towerSpacing);
  const gateG = heightAt(siegeAp.x, gateCz);
  const gateDoor: GateDoorOut = {
    gateId: siegeAp.id,
    x: siegeAp.x + gFrame.nx * (siegeAp.blockD * 0.5 - GATE_DOOR_SET),
    y: gateG + GATE_DOOR_SILL,
    z: gateCz + gFrame.nz * (siegeAp.blockD * 0.5 - GATE_DOOR_SET),
    nx: gFrame.nx, nz: gFrame.nz, dx: gFrame.dx, dz: gFrame.dz,
    halfWidth: siegeAp.clearWidth * 0.5,
    height: GATE_DOOR_H,
    thickness: GATE_DOOR_T,
    setback: GATE_DOOR_SET,
    open: false,
    broken: false,
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
          const ap = apertureOfBay(bay.index);
          if (ap && ap.kind === 'posterula') {
            buildPosterula(batch, detail, bay, ap, heightAt);
          } else if (ap) {
            buildGate(batch, detail, bay, ap, heightAt, rng.fork(`gate-${bay.index}`));
            /*
             * **And its leaves, unless the ram can reach it.** §14.2.
             *
             * The Porta Flaminia's hang in their own chunk so `setGateDoorBroken` can swap
             * them for the wreck; the other two are shut for the whole battle and are built
             * into the curtain's chunk, which costs no draw call of its own and is §4.10's
             * *"merge the leaves into one stream per chunk"*.
             *
             * Leaving them out is not an option and `probe-wall` proved it in one run: with
             * the two new gates drawn and unhung, **eight rays out of 1,215 passed clean
             * through the circuit** at x 759.5–762.5 and x 1092.5–1093.5. That is §14.2's
             * defect — *"posterns that were arches with nothing hung in them"* — arriving on
             * Rome by way of two gates that had never had a door modelled.
             */
            if (!ap.siege) buildGateLeaves(batch, detail, bay, ap, heightAt);
          }
          // The flight up onto the walk, against the inner face. Planned once in
          // `buildWall` and looked up here, so the stone and the published `WallStair`
          // cannot disagree about where it is.
          //
          // The Muro Torto's is an *apron* — banked earth, cut by the heightfield, not
          // masonry — so it publishes a `WallStair` and lays no stone. See `muroTortoApron`.
          const stair = stairByBay.get(bay.index);
          if (stair && !onMuroTorto(bay.index)) buildWallStair(batch, detail, bay, stair, heightAt);
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
        if (from === 0) {
          buildRiverTerminus(batch, detail, bays[0], heightAt);
          buildRiverWall(batch, detail, bays[0], heightAt);
        }
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
      cx: siegeAp.x,
      cz: gateCz,
      radius: 16,
      castShadow: false,
      lodSwitch: [1e9, 1e9],
      gateDoorFor: gateDoor.gateId,
      build: (batch, detail) => {
        batch.setUvOrigin(siegeAp.x, 0, gb.z0);
        buildGateLeaves(batch, detail, gb, siegeAp, heightAt);
      },
    });
    // The same leaves in the pose the ram left them. Baked and hidden; `setGateDoorBroken`
    // swaps the two, so the pair costs one chunk's worth of draws whichever is on screen.
    chunks.push({
      name: 'gate-wreck',
      cx: siegeAp.x,
      cz: gateCz,
      radius: 22,
      castShadow: false,
      lodSwitch: [1e9, 1e9],
      gateWreckFor: gateDoor.gateId,
      build: (batch, detail) => {
        batch.setUvOrigin(siegeAp.x, 0, gb.z0);
        buildGateLeaves(batch, detail, gb, siegeAp, heightAt, true);
      },
    });
  }

  /**
   * **The build-time self-check `wall.ts` has never had.** §14.4a, §15 task 3.
   *
   * Run here, on what was just built, and published on the output as data — not warned, not
   * thrown. `carthageWall.ts` has had three of these for months and its own comment gives the
   * reason: *"a build-time `console.warn` is invisible to a probe and an exception takes the
   * page down… prose does not run."* `rome/plan.ts` prints the faults once and hands the whole
   * record to `CitySystem.stats()`, so a probe reads the builder's own arithmetic instead of
   * re-deriving it.
   *
   * The tower gap it grades joints against is the plan distance `Siege.buildLinks` actually
   * bridges: a tower's own width plus the two `STATION_CLEAR` margins either side of it.
   */
  const section = assertRomeSection({
    bays: garrisonBays,
    apertures: APERTURES,
    stairs,
    pitch: WALL.towerSpacing,
    xMin: bays[0].x0,
    xMax: bays[bays.length - 1].x1,
    towerGap: WALL.towerWidth + 2 * 0.55,
  });

  // Cypress and pine against the inner face — the *pomerium* strip was planted.
  for (let i = 0; i < 220; i++) {
    const x = rng.range(WALL_X_MIN + 30, WALL_X_MAX - 30);
    if (GATES.some((a) => Math.abs(x - a.x) < 30)) continue;
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
    path, chunks, segments, gates, gateBlocks, gateDoor, blockers, roughGround, trees,
    towerCount, bayStages, garrisonBays, stairs, wallZAt: zAt,
    section, sectionFaults: section.faults,
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
 * The Muro Torto's apron — **a way onto the crest that is not a stair.** §4.5, §15 task 4.
 *
 * The Horti Aciliorum's terrace substruction is *"completamente costruito contro terra"*
 * (Cozza 1992): solid mass built against the hillside, with no wall-gallery and sentries on
 * the crest. `heightfield.ts` stage 4d2 banks that hillside up behind it, so the ground on
 * the city side reaches crest level about 46 m back. This publishes the last step of the
 * walk onto it as a `WallStair`, because a `WallStair` is the object `Siege.buildStairs`
 * reads and `wallReport().reachable` floods from — but with a **rise near zero**, which is
 * §4.5's own phrase and is the whole difference between this and a flight.
 *
 * The foot is placed at the x within the bay where the banked ground comes closest to the
 * bay's own walk level, not at the bay's midpoint. It has to be: the bank follows §3.5's
 * smooth profile plus 13.32 m, while `walkY` is quantised to 0.55 m construction increments
 * and held to the highest ground in the bay, so on a stretch climbing 5 m per bay the two
 * are level at one end and five metres apart at the other. Searching for the level end costs
 * eleven `heightAt` calls per bay at build time and is the difference between an apron and a
 * step a man cannot take.
 *
 * Returns null if nothing inside the bay gets within `STAIR_RISE` of the walk, which is the
 * honest answer: the bank did not reach and `assertRomeSection` will say so.
 */
function muroTortoApron(
  bay: Bay,
  walkY: number,
  heightAt: (x: number, z: number) => number
): WallStair | null {
  const f = frameOf(bay.x0, bay.z0, bay.x1, bay.z1);
  /** How far cityward the foot stands: the top of the bank, plus the curtain's half-thickness. */
  const off = -(HALF_T + MURO_TORTO.bank);
  const at = (t: number, o: number): { x: number; z: number } => ({
    x: bay.x0 + f.dx * t + f.nx * o,
    z: bay.z0 + f.dz * t + f.nz * o,
  });
  let bestT = -1;
  let bestOff = off;
  let bestG = 0;
  let best = Infinity;
  /*
   * The **foot** may stand anywhere on the terrace behind this bay; only the **top** has to
   * land where a station is, and `Siege.buildStairs` rejects a published flight whose head is
   * more than 6 m from one. So the two are searched separately: the foot across the bay's
   * whole width in x and out along 72 m of level terrace, and the top clamped back inside the
   * band the towers leave. Searching them together is what left two of the seven bays without
   * an apron — the terrace is highest at a bay's east end and the stations stop 4.8 m short of
   * it, which on a stretch climbing 5 m a bay is two thirds of a metre the apron cannot lose.
   */
  for (let k = 0; k <= 16; k++) {
    // Past the bay's own east end by a bay's worth of the normal offset: the foot stands
    // `MURO_TORTO.bank` metres cityward, the run's normal carries 13 % of that into x, and
    // the terrace climbs 5 m a bay — so the ground level with *this* bay's crest lies a few
    // metres east of where a purely lateral search can reach. The crossing runs obliquely;
    // it is a path up a hillside, not a flight bolted to a wall.
    const t = -4 + ((f.len + 18) * k) / 16;
    /*
     * The foot stays inside the *pomerium*. `POMERIUM` is 60 m of consecrated clear ground
     * behind the curtain and the fabric generator honours it; past that is the Horti
     * Aciliorum, and searching out to 120 m put two of the seven aprons' feet **inside a
     * building** — `NavGrid.blockedAt` true at the published foot, so the route to it failed
     * while the apron itself measured a perfect zero rise. A way onto the wall that ends in
     * somebody's *piscina* is not a way onto the wall.
     */
    for (let j = 0; j <= 3; j++) {
      const o = off - j * 3;
      const p = at(t, o);
      const g = heightAt(p.x, p.z);
      /*
       * **Never above the crest.** `WallStair.rise` is contracted as *"always positive: the
       * flight only ever climbs from foot to top"*, and a plain nearest-match search does not
       * respect it — one of the seven aprons came out at **−0.10 m**, a flight that descends,
       * which `probe-siege`'s *"every stair stands on the ground and reaches the walkway"*
       * correctly reads as a head below its own foot. So ground above the walk is not a
       * candidate at all; the terrace ramps up to it from bench level over 46 m, so there is
       * always ground just under the crest to stand the foot on.
       */
      if (g > walkY) continue;
      const d = walkY - g;
      if (d < best) {
        best = d;
        bestT = t;
        bestOff = o;
        bestG = g;
      }
    }
  }
  // A rise this side of one tread is not a step at all; anything past a flight's worth of
  // rise means the bank did not arrive and the bay should report as unserved rather than
  // pretend a ramp.
  if (bestT < 0 || walkY - bestG > 3.0) return null;

  // Where the apron delivers onto the walk: inside the band the two towers leave, which is
  // where `buildSpine` lays stations and therefore the only place a `WallStair` head can be.
  const margin = WALL.towerWidth * 0.5 + 1.6;
  const topT = Math.min(Math.max(bestT, margin), f.len - margin);
  const foot = at(bestT, bestOff);
  const head = at(topT, -(HALF_T + 1.2));
  const top = at(topT, -(HALF_T - 0.6));
  const run = Math.sqrt((foot.x - head.x) * (foot.x - head.x)
    + (foot.z - head.z) * (foot.z - head.z));
  return {
    bay: bay.index,
    footX: foot.x, footY: bestG, footZ: foot.z,
    headX: head.x, headY: walkY, headZ: head.z,
    topX: top.x, topY: walkY, topZ: top.z,
    // The apron runs *across* the wall, from the hillside onto the crest, not along it —
    // and obliquely where the terrace's high point is not opposite a station.
    dx: (head.x - foot.x) / Math.max(1e-6, run), dz: (head.z - foot.z) / Math.max(1e-6, run),
    nx: f.nx, nz: f.nz,
    width: 6.0,
    run,
    rise: Math.max(0, walkY - bestG),
    steps: Math.max(1, Math.round(Math.max(0, walkY - bestG) / STAIR_RISE)),
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
