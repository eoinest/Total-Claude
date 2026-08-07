import type { CityPlan, CityPlanRect } from '../cityPlan';
import type { Lane } from '../insulae';
import { KeepOut } from '../layout';
import { buildTreeChunks } from '../props';
import type { Blocker, CityChunkSpec, TreeRequest } from '../wall';
import { assertCarthage } from './assertions';
import { buildByrsa, byrsaReliefAt } from './byrsa';
import { buildLineZAt, CIRCUIT_X_MAX, CIRCUIT_X_MIN, circuitZAt } from './circuit';
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
 *   1. Circuit and military way — fixed in `circuit.ts`, nothing moves them.
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
 * ## The hill is a function, not a heightfield
 *
 * `groundAt` is the terrain plus `byrsaReliefAt`. The map workstream owns the heightfield and
 * the Carthage map has not landed, so the Byrsa raises itself — but every consumer reads one
 * function, so the streets, the terraced housing and the citadel cannot end up at different
 * heights from each other. When the real hill arrives this becomes a `max` against the
 * terrain and nothing downstream changes.
 *
 * ## The wall
 *
 * `wall: null`. The triple wall is a separate workstream and this plan does not invent one:
 * a provisional curtain would have to satisfy `GarrisonBay`, `WallStair`, `GateDoorOut` and
 * the siege system's contracts, and would then be thrown away. What this plan *does* publish
 * is `circuitZAt`, `CIRCUIT_GATES` and `STAIR_APRONS`, so the wall lands against a city that
 * has already made room for it.
 */
export function buildCarthagePlan(heightAt: (x: number, z: number) => number): CityPlan {
  const groundAt = (x: number, z: number): number => heightAt(x, z) + byrsaReliefAt(x, z);

  // ---- 1. the circuit is fixed. Reserve the military way. ----------------
  const keepOut = new KeepOut();
  for (let x = CIRCUIT_X_MIN - 40; x <= CIRCUIT_X_MAX + 40; x += 20) {
    const z0 = circuitZAt(x) - 80;
    const z1 = buildLineZAt(x);
    keepOut.addRect(x, (z0 + z1) * 0.5, 12, (z1 - z0) * 0.5, 0);
  }

  // ---- 2. monuments, the citadel and the harbours, at final positions ----
  for (const m of MONUMENTS) keepOut.addRect(m.x, m.z, m.hw + m.clear, m.hd + m.clear, m.rot);

  const byrsa = buildByrsa(heightAt);
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
  const trees: TreeRequest[] = [...byrsa.trees, ...monuments.trees, ...fabric.trees];
  const footprints: CityPlanRect[] = [
    ...byrsa.footprints.map((f) => ({ ...f, kind: 'monument' as const })),
    ...harbours.footprints.map((f) => ({ ...f, kind: 'monument' as const })),
    ...monuments.footprints.map((f) => ({ ...f, kind: 'monument' as const })),
    ...fabric.footprints.map((f) => ({ ...f, kind: 'building' as const })),
  ];
  const occSegments: Blocker[] = [...harbours.occSegments];

  const chunks: CityChunkSpec[] = [
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

  const assertions = assertCarthage({
    footprints,
    occSegments,
    lanes,
    blocksByQuarter: fabric.blocksByQuarter,
    shedCount: harbours.shedCount,
  });

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
    id: 'carthage',
    chunks,
    trees,
    footprints,
    occCircles: [],
    occSegments,
    lanes,
    ways,
    landmarks: MONUMENTS.map((m) => ({ id: m.id, name: m.name, x: m.x, z: m.z })),
    wall: null,
    circuitZAt,
    circuitXRange: [CIRCUIT_X_MIN, CIRCUIT_X_MAX],
    assertions,
  };
}

export { byrsaReliefAt, byrsaTopY } from './byrsa';
