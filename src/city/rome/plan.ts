import { Faction } from '../../sim/types';
import { buildCarthageWall, CARTHAGE_SECTION } from '../carthageWall';
import { activeFortification } from '../fortification';
import type { CityBuild, CityPlan } from '../cityPlan';
import { buildDistricts } from '../insulae';
import { buildLandmarks } from '../landmarks';
import {
  AQUEDUCTS,
  assertHillRing,
  assertNoFabricOverlaps,
  assertNoFootprintOverlaps,
  assertOneAmphitheatre,
  assertTopology,
  assertWaysClearOfMonuments,
  GATE_OPEN_WIDTH,
  KeepOut,
  LANDMARKS,
  PLAZAS,
  WALL,
  WAY_FRONTAGE,
  wayMix,
  WAYS,
} from '../layout';
import { buildTreeChunks } from '../props';
import { buildWall, type CityChunkSpec, type TreeRequest } from '../wall';

/**
 * Rome, 271 AD: the Aurelian Wall under construction and the city behind it.
 *
 * **Nothing here is new.** Every line of `build` below was inline in `CitySystem.init` and is
 * lifted unchanged — same call order, same seed labels, same assertions, same warnings. The
 * move is the whole point: `CitySystem` was ~1,300 lines of which about 110 were Rome, and
 * those 110 are these. What remains in `CitySystem` is machinery that works for any city, and
 * that is what lets Carthage have wall traversal without a second implementation of it. See
 * `src/city/cityPlan.ts` for the argument.
 *
 * The one thing that did change shape: the build-time assertions used to write straight into
 * private fields on `CitySystem` and be read back out by `stats()`. They now come back in a
 * `CityChecks` bag. A city that has not written its assertions yet leaves the fields out and
 * reports honestly, rather than reporting a zero that reads as a pass.
 */
export const ROME_PLAN: CityPlan = {
  id: 'rome',
  name: 'Rome',
  garrison: Faction.Rome,
  // The one gate in the circuit, on the axis of the Via Flaminia. `Siege` drives its ram at
  // this and `CitySystem.setGateOpen(id, true)` is how it wins.
  siegeGateId: 'porta-flaminia',
  /**
   * North edge of the city. The battlefield is z < 250 and must stay completely clear of
   * masonry: `assertNoStrayGeometry` enforces it against every baked vertex, at every detail
   * level. It exists because a monument once appeared at the world origin in the *mid* and
   * *far* levels only, so it was invisible from anywhere near the city and materialised out
   * of nowhere as the camera pulled back.
   */
  battlefieldZ: 250,
  towerChamberHeight: WALL.towerChamberHeight,
  /**
   * 1.7 m merlons on 0.95 m gaps, which is exactly what the `crenellation()` call in
   * `wall.ts` builds. They must match: `masonryTopAt` alternates the two per projectile per
   * tick to decide whether a shot passes through an embrasure or breaks on a merlon, and a
   * mismatch is what put 491 missile impacts on our own masonry in one minute of battle.
   */
  merlonLength: 1.7,
  crenelLength: 0.95,
  gateOpenWidth: GATE_OPEN_WIDTH,

  build(heightAt): CityBuild {
    /**
     * **The wall-development rig, and it is not the product path.**
     *
     * `?fort=carthage` swaps the Punic triple wall onto Rome's circuit line so the masonry
     * could be built and graded — `tools/probe-carthage-wall.mjs`, 44 assertions — before a
     * Carthage map existed to stand it on. It is genuinely useful and it stays.
     *
     * It lives *here*, in Rome's plan, rather than in `CitySystem`, because the selection of
     * which city to build has exactly one home and that home is `MapDefinition.city`. Two
     * module singletons that must agree with each other — one for the fabric, one for the
     * masonry — is the same shape of bug as `hidesCity`, and a plan naming Rome's fabric with
     * Carthage's wall describes no city that ever existed. Under this override that is
     * precisely what you get, which is why it is a rig and says so.
     *
     * Note what it is standing on: `carthageWall.ts` takes `WALL_X_MIN`, `WALL_X_MAX`,
     * `GATE_X` and `fitWallPath` from Rome's `layout.ts`, so the triple wall is currently
     * built along the **Aurelian** line. On the Carthage map the line is
     * `maps/carthage/topography.ts:carthageWallZ` — the terrain has already graded a bench
     * under it and the scatter already clears its glacis there. See the seam note in
     * `cityPlan.ts`.
     */
    const punic = activeFortification() === 'carthage';
    const wall = punic
      ? buildCarthageWall(heightAt, 'carthage-149')
      : buildWall(heightAt, 'aurelian-271');
    const cw = punic ? (wall as ReturnType<typeof buildCarthageWall>) : null;
    if (cw && cw.sectionFaults.length > 0) {
      console.warn(`[city] Punic section faults: ${cw.sectionFaults.join('; ')}`);
    }

    // Reserve every landmark's *oriented rectangular* footprint before a single insula is
    // generated. A circle is not good enough: the Circus Maximus is 621 × 118 m, and the
    // circle that used to stand in for it left five sixths of its footprint free for the
    // fabric to grow through — which is precisely what happened.
    const keepOut = new KeepOut();
    for (const l of LANDMARKS) {
      keepOut.addRect(l.x, l.z, l.hw, l.hd, l.rot);
      // A mound is bigger in plan than the building on it.
      if (l.mound) keepOut.addCircle(l.x, l.z, (l.moundRadius ?? l.clear) * 1.02);
    }
    // The whole armature, not just the nine named viae: the military road behind the curtain,
    // the ring round every monument and the feeders that connect them all reserve their
    // carriageway plus a margin, so the fabric presents a frontage to the street instead of
    // growing into it. See `WAY_FRONTAGE` for why the margin is by rank.
    for (const w of WAYS) keepOut.addPath(w.path, w.width * 0.5 + WAY_FRONTAGE[w.cls]);
    for (const p of PLAZAS) keepOut.addRect(p.x, p.z, p.hw + 2, p.hd + 2, p.rot);
    for (const a of AQUEDUCTS) keepOut.addPath(a.path, 8);

    // Build-time assertion: no two monuments interpenetrate. Reported in `stats()` and logged
    // once, because a layout regression is otherwise invisible until someone notices a temple
    // inside a racetrack.
    //
    // **Read the name carefully, because it is narrower than it sounds and that gap is a bug
    // the user found before the build did.** This compares landmarks with landmarks and skips
    // anything `soft`. It has never looked at an insula. So while the user was reporting
    // monuments "smacked down across multiple buildings" it was reporting zero overlaps —
    // correctly, and about a different question. `assertNoFabricOverlaps` below is the one
    // that answers the question that was actually being asked.
    const overlaps = assertNoFootprintOverlaps();
    if (!overlaps.ok) {
      console.warn(
        `[city] ${overlaps.count} landmark footprint overlap(s), worst ${overlaps.worst} m: ` +
          overlaps.pairs.map((p) => `${p.a}/${p.b}`).join(', ')
      );
    }
    // ...and that separating them did not destroy the plan.
    const topo = assertTopology();
    const ring = assertHillRing();
    const topology = {
      ok: topo.ok && ring.ok,
      checks: topo.checks + ring.checks,
      failures: [...topo.failures, ...ring.failures],
    };
    if (!topology.ok) {
      console.warn(`[city] topology check failed: ${topology.failures.join('; ')}`);
    }
    // Exactly one Flavian Amphitheatre. See `assertOneAmphitheatre`.
    const amphitheatres = assertOneAmphitheatre();
    if (!amphitheatres.ok) {
      console.warn(
        `[city] expected 1 amphitheatre, found ${amphitheatres.count}: ${amphitheatres.ids.join(', ')}`
      );
    }

    const landmarks = buildLandmarks(heightAt, 'rome-monuments');
    const districts = buildDistricts(heightAt, keepOut, 'rome-fabric', wall.wallZAt);

    // The check whose absence let the user see what the build could not: does any house stand
    // inside a monument? Counted against the same rectangles `getObstacles()` publishes, so it
    // grades the collision surface rather than the intent.
    const fabricOverlaps = assertNoFabricOverlaps(landmarks.footprints, districts.footprints);
    if (!fabricOverlaps.ok) {
      console.warn(
        `[city] ${fabricOverlaps.count} monument/insula overlap(s) across ` +
          `${fabricOverlaps.buildingsHit} building(s), worst ${fabricOverlaps.worst} m`
      );
    }
    // ...and the same question asked of the streets, which is where it was worst. See
    // `assertWaysClearOfMonuments`: before the ways were deflected round the resolved monument
    // positions, nine tenths of the Via Appia and the Via Triumphalis ran through masonry at
    // zero clearance and nothing in the build said so.
    const wayClearance = assertWaysClearOfMonuments();
    if (!wayClearance.ok) {
      console.warn(
        `[city] ${wayClearance.inside}/${wayClearance.samples} ranked-way samples ` +
          `inside a monument; worst ${wayClearance.worst?.id} at ${wayClearance.worst?.pct}%`
      );
    }

    const trees: TreeRequest[] = [...wall.trees, ...landmarks.trees, ...districts.trees];
    const chunks: CityChunkSpec[] = [
      ...wall.chunks,
      ...landmarks.chunks,
      ...districts.chunks,
      ...buildTreeChunks(trees, heightAt),
    ];

    return {
      wall,
      chunks,
      // Present only under the `?fort=carthage` rig above; every one of them is defaulted by
      // `CitySystem`, so the Aurelian circuit passes `undefined` and nothing downstream cares.
      towerRise: cw?.towerRise,
      outworks: cw?.outworks,
      outworkTopAt: cw?.outworkTopAt,
      casemates: cw?.casemates,
      ditch: cw?.ditch ?? null,
      occBlockers: cw?.occBlockers,
      punicSection: cw ? { ...CARTHAGE_SECTION, faults: cw.sectionFaults } : null,
      landmarkFootprints: landmarks.footprints,
      buildingFootprints: districts.footprints,
      lanes: districts.lanes,
      landmarks: LANDMARKS.map((l) => ({ id: l.id, name: l.name, x: l.x, z: l.z })),
      checks: {
        footprintOverlaps: overlaps.count,
        footprintOverlapWorst: overlaps.worst,
        topologyPass: topology.checks - topology.failures.length,
        topologyChecks: topology.checks,
        fabricOverlaps: fabricOverlaps.count,
        fabricOverlapWorst: fabricOverlaps.worst,
        wayInsideMonument: wayClearance.inside,
        waySamples: wayClearance.samples,
        // The armature *and* the lanes each quarter cut for itself. See `wayMix`: the named
        // viae are 11 km and the district generator cuts a further 374 lanes and 38 km, and
        // an audit that could not see the second number read every vicus in Rome as unbuilt
        // ground.
        ways: wayMix(districts.lanes),
      },
    };
  },
};

/**
 * Count of Flavian-Amphitheatre-form buildings, which must be 1.
 *
 * Rome-specific and therefore not on `CityChecks`, which is the shared shape. `stats()` used
 * to publish it and the plan diagnostic reads it, so it is exported rather than dropped.
 */
export const romeAmphitheatreCount = (): number => assertOneAmphitheatre().count;
