import type { CityAssertion, CityPlan } from './cityPlan';
import { buildDistricts } from './insulae';
import { buildLandmarks } from './landmarks';
import {
  AQUEDUCTS,
  assertHillRing,
  assertNoFabricOverlaps,
  assertNoFootprintOverlaps,
  assertOneAmphitheatre,
  assertTopology,
  assertWaysClearOfMonuments,
  KeepOut,
  LANDMARKS,
  PLAZAS,
  WALL,
  WALL_X_MAX,
  WALL_X_MIN,
  WAY_FRONTAGE,
  wayMix,
  WAYS,
} from './layout';
import { buildTreeChunks } from './props';
import { buildWall, type CityChunkSpec, type TreeRequest } from './wall';

/**
 * Rome, 271 AD: the Aurelian Wall under construction and the city behind it.
 *
 * This is `CitySystem.init`'s old plan block, lifted verbatim behind `CityPlan` so a second
 * city can go through the same baker. Nothing about Rome changed in the move — the same
 * seeds, the same call order, the same assertions — and the numeric results of those
 * assertions still travel in their own fields on `stats()` because two tools read them.
 */

/** Rome's Rome-only assertion results, kept in their published shape for `stats()`. */
export interface RomeAssertionResults {
  overlaps: ReturnType<typeof assertNoFootprintOverlaps>;
  fabricOverlaps: ReturnType<typeof assertNoFabricOverlaps>;
  wayClearance: ReturnType<typeof assertWaysClearOfMonuments>;
  topology: ReturnType<typeof assertTopology>;
  amphitheatres: ReturnType<typeof assertOneAmphitheatre>;
}

export interface RomePlan extends CityPlan {
  rome: RomeAssertionResults;
}

export function buildRomePlan(heightAt: (x: number, z: number) => number): RomePlan {
  const wall = buildWall(heightAt, 'aurelian-271');

  // Reserve every landmark's *oriented rectangular* footprint before a single insula
  // is generated. A circle is not good enough: the Circus Maximus is 621 × 118 m, and
  // the circle that used to stand in for it left five sixths of its footprint free for
  // the fabric to grow through — which is precisely what happened.
  const keepOut = new KeepOut();
  for (const l of LANDMARKS) {
    keepOut.addRect(l.x, l.z, l.hw, l.hd, l.rot);
    // A mound is bigger in plan than the building on it.
    if (l.mound) keepOut.addCircle(l.x, l.z, (l.moundRadius ?? l.clear) * 1.02);
  }
  // The whole armature, not just the nine named viae: the military road behind the
  // curtain, the ring round every monument and the feeders that connect them all reserve
  // their carriageway plus a margin, so the fabric presents a frontage to the street
  // instead of growing into it. See `WAY_FRONTAGE` for why the margin is by rank.
  for (const w of WAYS) keepOut.addPath(w.path, w.width * 0.5 + WAY_FRONTAGE[w.cls]);
  for (const p of PLAZAS) keepOut.addRect(p.x, p.z, p.hw + 2, p.hd + 2, p.rot);
  for (const a of AQUEDUCTS) keepOut.addPath(a.path, 8);

  const overlaps = assertNoFootprintOverlaps();
  const base = assertTopology();
  const ring = assertHillRing();
  const topology = {
    ok: base.ok && ring.ok,
    checks: base.checks + ring.checks,
    failures: [...base.failures, ...ring.failures],
  };
  const amphitheatres = assertOneAmphitheatre();

  const landmarks = buildLandmarks(heightAt, 'rome-monuments');
  const districts = buildDistricts(heightAt, keepOut, 'rome-fabric', wall.wallZAt);

  const fabricOverlaps = assertNoFabricOverlaps(landmarks.footprints, districts.footprints);
  const wayClearance = assertWaysClearOfMonuments();

  const trees: TreeRequest[] = [...wall.trees, ...landmarks.trees, ...districts.trees];
  const chunks: CityChunkSpec[] = [
    ...wall.chunks,
    ...landmarks.chunks,
    ...districts.chunks,
    ...buildTreeChunks(trees, heightAt),
  ];

  const assertions: CityAssertion[] = [
    {
      name: 'landmark/landmark overlap',
      ok: overlaps.ok,
      detail: `${overlaps.count} pair(s), worst ${overlaps.worst} m. Compares monuments with monuments only and skips \`soft\` ones — it has never looked at an insula.`,
    },
    {
      name: 'monument/insula overlap',
      ok: fabricOverlaps.ok,
      detail: `${fabricOverlaps.count} overlap(s) across ${fabricOverlaps.buildingsHit} building(s), worst ${fabricOverlaps.worst} m.`,
    },
    {
      name: 'ways clear of monuments',
      ok: wayClearance.ok,
      detail: `${wayClearance.inside}/${wayClearance.samples} ranked-way centreline samples inside a monument; worst ${wayClearance.worst?.id ?? 'none'} at ${wayClearance.worst?.pct ?? 0}%. Deliberately non-zero.`,
    },
    {
      name: 'topology',
      ok: topology.ok,
      detail: `${topology.checks - topology.failures.length}/${topology.checks} adjacency checks pass.`,
    },
  ];

  return {
    id: 'rome',
    chunks,
    trees,
    footprints: [...landmarks.footprints, ...districts.footprints],
    // Tower footprints project beyond the curtain, and a tower is a disc to the raster.
    occCircles: wall.segments.map((s) => ({ x: s.x1, z: s.z1, r: WALL.towerWidth * 0.5 })),
    occSegments: [],
    lanes: districts.lanes,
    ways: wayMix(districts.lanes),
    landmarks: LANDMARKS.map((l) => ({ id: l.id, name: l.name, x: l.x, z: l.z })),
    wall,
    circuitZAt: wall.wallZAt,
    circuitXRange: [WALL_X_MIN, WALL_X_MAX],
    assertions,
    rome: { overlaps, fabricOverlaps, wayClearance, topology, amphitheatres },
  };
}
