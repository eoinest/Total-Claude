import * as THREE from 'three';
// `terrain/topography`, not `terrain/TerrainSystem`, which merely re-exports the same
// constant. `TerrainSystem` imports `activeMap`, so taking it from there closes an ESM cycle
// the moment a map declares its city: maps/index -> campusMartius -> city/rome/plan ->
// city/rome/circuit -> terrain/TerrainSystem -> maps/index. `topography` imports nothing.
import { crestZAt, HALF_EXTENT, RIVER_HALF_WIDTH, riverCentreX } from '../../terrain/topography';
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
import {
  buildGate,
  buildGateLeaves,
  curtainSpans,
  GATE_ATTIC,
  GATE_BLOCK_D,
  GATE_BLOCK_W,
  GATE_CREN_INSET,
  GATE_CREN_T,
  GATE_CRENEL_W,
  GATE_DOOR_H,
  GATE_DOOR_SET,
  GATE_DOOR_SILL,
  GATE_DOOR_T,
  GATE_MERLON_H,
  GATE_MERLON_W,
  GATE_OPEN_WIDTH,
  GATE_PASS_H,
  GATE_X,
  inGateBlock,
} from './apertures';
import {
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
  buildScaffold,
  buildYard,
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
 * West end of the circuit. The Tiber crosses the crest line near x = −687, and the
 * historical wall terminated at the river with a tower rather than running masonry
 * into water, so the westernmost bay sits just clear of the bank.
 */
export const WALL_X_MIN = Math.round(riverCentreX(crestZAt(-660)) + RIVER_HALF_WIDTH + 8);
/**
 * East end: the Castra Praetoria. Aurelian took the camp's own north and east walls
 * into the circuit, so the curtain does not stop in open country — it runs into the
 * Praetorian barracks. This is also one of the two anchors that fix the plan's
 * east–west scale; see `KX` in `survey.ts`.
 */
export const WALL_X_MAX = 1150;
export const WALL_LENGTH = WALL_X_MAX - WALL_X_MIN;

/** Wall-line helper, straight from the terrain contract. */
export const wallCrestZ = (x: number): number => crestZAt(clamp(x, -HALF_EXTENT, HALF_EXTENT));

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
 * Sample the wall line. Real fortification practice puts the curtain on the crest, and
 * the terrain publishes exactly that line, so there is nothing to search for: follow
 * `crestZAt` and let the wall wander the 150 m in plan that it wants to.
 */
export function fitWallPath(heightAt: (x: number, z: number) => number, spacing = 55): WallNode[] {
  const n = Math.round(WALL_LENGTH / spacing) + 1;
  const out: WallNode[] = [];
  for (let i = 0; i < n; i++) {
    const x = WALL_X_MIN + (i * WALL_LENGTH) / (n - 1);
    const z = wallCrestZ(x);
    out.push({ x, z, ground: heightAt(x, z) });
  }
  return out;
}

export function bayStage(bayIndex: number, bayCount: number, gateBay: number): BayStage {
  // Only the gate itself and its immediate flanks were finished first; everything else
  // in 271 is somewhere between a trench and a parapet. The stages are placed close to
  // the gate on purpose, so the construction story lands in the frames that matter.
  const k = bayIndex - gateBay;
  if (k === 0 || k === 1 || k === -1) return 'finished';
  if (k === 3 || k === 4) return 'half-built';
  if (k === -3 || k === -4 || k === -5) return 'no-parapet';
  if (k === 7) return 'gap';
  if (k === 8 || k === 9) return 'footing';
  if (k === -9 || k === -10) return 'half-built';
  if (k === 13 || k === -14) return 'no-parapet';
  if (k === 17 || k === 18) return 'half-built';
  if (k === -18) return 'footing';
  void bayCount;
  return 'finished';
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
