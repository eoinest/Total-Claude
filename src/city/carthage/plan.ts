import { Faction } from '../../sim/types';
import { buildCarthageWall, CARTHAGE_SECTION, PUNIC } from '../carthageWall';
import type { CityBuild, CityPlan, PlanRect } from '../cityPlan';
import type { Lane } from '../insulae';
import { KeepOut } from '../layout';
import { buildTreeChunks } from '../props';
import type { Blocker, CityChunkSpec, TreeRequest } from '../wall';
import { assertCarthage, type TaggedRect } from './assertions';
import { buildByrsa, carthageGroundAt } from './byrsa';
import {
  buildLineZAt, CARTHAGE_WALL_LINE, CIRCUIT_X_MAX, CIRCUIT_X_MIN, circuitZAt,
} from './circuit';
import { buildFabric } from './fabric';
import { buildHarbours } from './harbour';
import { BYRSA, MONUMENTS, PUNIC_FRONTAGE, PUNIC_WAYS } from './layout';
import { buildMonuments } from './monuments';
import { buildStreets } from './streets';

/**
 * Carthage, spring 146 BC, as a `CityPlan`.
 *
 * ## The order below **is** the design
 *
 *   1. The wall, on the terrain's line — and the military way it owes itself.
 *   2. Monuments, the citadel and the harbours — authored at final coordinates, built, and
 *      their footprints taken. **No resolver.**
 *   3. Ways — projected against those final positions and reserved.
 *   4. Fabric — cut last into what is left, snapped to the 30 × 60 cubit module.
 *   5. Streets — surfaced over the named ways *and* the lanes the fabric cut for itself.
 *   6. Assertions — over the built result.
 *
 * Rome's great roads ran 73-91% through masonry because step 2 happened *after* step 3 and
 * nothing re-ran it. Here step 2 cannot move, so step 3 cannot go stale.
 *
 * ## A plan chooses its own fortification
 *
 * `build` calls `buildCarthageWall` itself, passing `CARTHAGE_WALL_LINE`. That is the seam
 * `cityPlan.ts` rules on: a plan naming Rome's fabric with Carthage's wall describes no city
 * that ever existed, so the selection has exactly one home and it is `MapDefinition.city`.
 * The line is a parameter because the same builder still serves the `?fort=carthage`
 * development rig on Rome's circuit, which is where `probe-carthage-wall`'s 44 assertions
 * were measured.
 *
 * ## The hill is the heightfield's
 *
 * `groundAt` is `max(terrain, byrsaGroundAt)`. It used to be `terrain + byrsaReliefAt` with a
 * hill this workstream synthesised, because there was no Carthage map; the map landed, the
 * relief collapsed to zero, and nothing downstream changed — which is what the seam was
 * shaped for.
 */

/**
 * How far a Punic tower rises above the wall-walk, when the wall does not say.
 *
 * `buildCarthageWall` publishes `towerRise` on every build, so this is the fallback that
 * `CitySystem` never reaches on this city. 22.5 m to the tower merlons (§4.5) less 13.7 m to
 * the walk (§4.3) less the 2.2 m parapet.
 */
const TOWER_CHAMBER_H = 22.5 - PUNIC.mainHeight - 2.2;

export const CARTHAGE_PLAN: CityPlan = {
  id: 'carthage',
  name: 'Carthage',
  /**
   * Whose city it is. Not a label: `deployAssault` used to put `Faction.Rome` on the parapet
   * because Rome was the only city there was, and on this one that is the wrong army on the
   * wrong side of a wall it is besieging.
   */
  garrison: Faction.Carthage,
  /**
   * The one gate with leaves, on the axis of the road from Tunis and of the Byrsa itself.
   * Must match a `WallBuildOutput.gates[].id`, because `setGateOpen(id, true)` is how the ram
   * wins; `carthageWall.ts:GATE_AXES` is where the id comes from.
   */
  siegeGateId: 'porta-byrsae',
  /**
   * North edge of the city — the same 250 as Rome, because both armies deploy in the same
   * boxes (`scenario.ts`, z −190 and z +130) whatever the map is. The wall's ditch lip lands
   * at z ≈ 452 at mid-span, so the attacker has 642 m of approach, against Rome's 620.
   */
  battlefieldZ: 250,
  towerChamberHeight: TOWER_CHAMBER_H,
  /**
   * 1.55 m merlons on 0.80 m gaps, which is exactly what the `crenellation()` call for the
   * main wall's outer parapet in `carthageWall.ts` builds. They must match: `masonryTopAt`
   * alternates the two per projectile per tick to decide whether a shot passes through an
   * embrasure or breaks on a merlon, and Rome's mismatch put 491 missile impacts on its own
   * masonry in one minute of battle.
   */
  merlonLength: 1.55,
  crenelLength: 0.8,
  /** `GATE_PASS_W` — the clear passage through the gatehouse block. */
  gateOpenWidth: 5.2,

  build(heightAt): CityBuild {
    const groundAt = carthageGroundAt(heightAt);

    // ---- 1. the wall, and the military way behind it -----------------------
    const wall = buildCarthageWall(heightAt, 'carthage-146', CARTHAGE_WALL_LINE);
    if (wall.sectionFaults.length > 0) {
      console.warn(`[city:carthage] section faults: ${wall.sectionFaults.join('; ')}`);
    }

    const keepOut = new KeepOut();
    for (let x = CIRCUIT_X_MIN - 40; x <= CIRCUIT_X_MAX + 40; x += 20) {
      // Forward of the circuit as well as behind it: the ditch, the outwork and the middle
      // wall stand 74 m into the field (§4.2) and no fabric may grow into the belt from
      // either side.
      const z0 = circuitZAt(x) - 80;
      const z1 = buildLineZAt(x);
      keepOut.addRect(x, (z0 + z1) * 0.5, 12, (z1 - z0) * 0.5, 0);
    }

    // ---- 2. monuments, the citadel and the harbours, at final positions ----
    for (const m of MONUMENTS) keepOut.addRect(m.x, m.z, m.hw + m.clear, m.hd + m.clear, m.rot);

    const byrsa = buildByrsa(groundAt);
    const harbours = buildHarbours(heightAt);
    const monuments = buildMonuments(groundAt);

    // ---- 3. the ways, against those positions -------------------------------
    for (const w of PUNIC_WAYS) keepOut.addPath(w.path, w.width * 0.5 + PUNIC_FRONTAGE[w.cls]);
    // The ceremonial stair down the citadel's landward face, and the ground either side of it.
    keepOut.addRect(BYRSA.x - BYRSA.summitHw - 16, BYRSA.z, 22, 9, 0);

    // ---- 4. the fabric, into what is left -----------------------------------
    const fabric = buildFabric(groundAt, keepOut, 'carthage-fabric');

    // ---- 5. street surfaces over both networks ------------------------------
    const streetChunks = buildStreets(groundAt, fabric.lanes);

    // ---- assemble ------------------------------------------------------------
    const trees: TreeRequest[] = [
      ...wall.trees, ...byrsa.trees, ...monuments.trees, ...fabric.trees,
    ];

    /**
     * Monuments, the citadel platform and **the harbour water**.
     *
     * The basins are here rather than left to a slope the pathfinder refuses, because there
     * is no slope: `docs/ARCHITECTURE.md` — water on this map is terrain below the datum and
     * the open coast is held by a 9.5 m scarp in 12, but a quay is *level with the town* and
     * its water is two metres down. Nothing in the simulation knows what water is, so a
     * harbour basin is only a hole if the city says it is one.
     */
    const landmarkFootprints: PlanRect[] = [
      ...byrsa.footprints,
      ...harbours.footprints,
      ...monuments.footprints,
    ];
    const buildingFootprints: PlanRect[] = [...fabric.footprints];

    /**
     * The circular basin and the two channels, as thick lines rather than rectangles.
     *
     * `CityBuild` has no field for a segment solid, and it should not grow one for a
     * one-city case: `CitySystem` already turns a `Blocker` into an oriented box for the
     * curtain, and the same arithmetic here turns each chord into a `PlanRect`. So they go
     * in as landmarks — `kind: 'monument'`, which is the only value in `ObstacleKind` that
     * means "large civic solid, not a house" — and both the 4 m raster and the box set see
     * them, which is the whole point.
     */
    const water = harbourRects(harbours.occSegments);

    const chunks: CityChunkSpec[] = [
      ...wall.chunks,
      ...byrsa.chunks,
      ...harbours.chunks,
      ...monuments.chunks,
      ...fabric.chunks,
      ...streetChunks,
      ...buildTreeChunks(trees, heightAt),
    ];

    const lanes: Lane[] = [
      ...PUNIC_WAYS.map((w) => ({ path: [...w.path], cls: w.cls, width: w.width })),
      ...fabric.lanes,
    ];

    const solids: TaggedRect[] = [
      ...landmarkFootprints.map((f) => ({ ...f, kind: 'monument' as const })),
      ...buildingFootprints.map((f) => ({ ...f, kind: 'building' as const })),
    ];
    const checks = assertCarthage({
      footprints: solids,
      occSegments: harbours.occSegments,
      lanes,
      blocksByQuarter: fabric.blocksByQuarter,
      shedCount: harbours.shedCount,
      heightAt,
      // The towers as the wall itself published them, at the west end of the bay that carries
      // one — not re-derived from a pitch, which is how a check ends up measuring its own
      // arithmetic rather than the masonry.
      towers: wall.garrisonBays
        .filter((b) => b.hasTower)
        .map((b) => ({ x: b.x0, z: b.z0, hw: b.towerHalf })),
    });

    // The water goes into the obstacle set *after* the checks are taken, so the assertion's
    // stated population is the one it measured. It is not exempt from anything — see the
    // interpenetration check, which tests every chord against every footprint and only
    // declines to test the chords against each other.
    for (const b of water) landmarkFootprints.push(b);

    // Network summary by rank, the same shape Rome's `wayMix` publishes.
    const acc = new Map<string, { count: number; km: number }>();
    for (const l of lanes) {
      let km = 0;
      for (let i = 0; i + 1 < l.path.length; i++) {
        km += Math.hypot(l.path[i + 1].x - l.path[i].x, l.path[i + 1].z - l.path[i].z);
      }
      const row = acc.get(l.cls) ?? { count: 0, km: 0 };
      row.count++;
      row.km += km / 1000;
      acc.set(l.cls, row);
    }
    const ways = ['artery', 'secondary', 'local', 'vicus']
      .filter((c) => acc.has(c))
      .map((c) => ({ cls: c, count: acc.get(c)!.count, km: +acc.get(c)!.km.toFixed(2) }));

    return {
      wall,
      chunks,
      landmarkFootprints,
      buildingFootprints,
      lanes,
      landmarks: MONUMENTS.map((m) => ({ id: m.id, name: m.name, x: m.x, z: m.z })),
      // The multi-line extras. Every one of them is read with a default by `CitySystem`, so
      // a single-line city need not know they exist; see `CityBuild`.
      towerRise: wall.towerRise,
      outworks: wall.outworks,
      outworkTopAt: wall.outworkTopAt,
      casemates: wall.casemates,
      ditch: wall.ditch,
      occBlockers: wall.occBlockers,
      punicSection: { ...CARTHAGE_SECTION, faults: wall.sectionFaults },
      checks: {
        assertions: checks.assertions,
        footprintOverlaps: checks.footprintOverlaps,
        footprintOverlapWorst: checks.footprintOverlapWorst,
        fabricOverlaps: checks.fabricOverlaps,
        fabricOverlapWorst: checks.fabricOverlapWorst,
        wayInsideMonument: checks.wayInsideMonument,
        waySamples: checks.waySamples,
        ways,
        // No topology assertion is made, so the fields are left out rather than filled with
        // a zero. `CityChecks` defaults them to "nothing measured", which is the truth.
      },
    };
  },
};

/** A thick line as the oriented rectangle `CitySystem` would have made of it anyway. */
function harbourRects(segs: readonly Blocker[]): PlanRect[] {
  const out: PlanRect[] = [];
  for (const b of segs) {
    const dx = b.x2 - b.x1;
    const dz = b.z2 - b.z1;
    const len = Math.hypot(dx, dz);
    if (len < 0.4) continue;
    out.push({
      x: (b.x1 + b.x2) * 0.5,
      z: (b.z1 + b.z2) * 0.5,
      hw: len * 0.5,
      hd: b.halfW,
      /**
       * Negated, because `PlanRect.rot` is the *plan* rotation in three.js's hand and
       * `Math.atan2(dz, dx)` is in the occupancy grid's. `CitySystem` negates again at the
       * boundary; publishing the raster's hand here would mirror every chord about the
       * cothon's centre and leave the harbour open on the two sides a road runs along.
       */
      rot: -Math.atan2(dz, dx),
    });
  }
  return out;
}
