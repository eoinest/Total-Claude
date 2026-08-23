import { Faction } from '../../sim/types';
import { buildCarthageWall, CARTHAGE_SECTION } from '../carthageWall';
import { activeFortification } from '../fortification';
import type { CityAssertion, CityBuild, CityPlan } from '../cityPlan';
import { assertNoFabricOverlaps, KeepOut } from '../layout';
import { buildTreeChunks } from '../props';
import { type CityChunkSpec, type TreeRequest } from '../wall';
import { GATE_OPEN_WIDTH } from './apertures';
import {
  assertHillRing,
  assertNoFootprintOverlaps,
  assertOneAmphitheatre,
  assertRomeFrame,
  assertTopology,
  assertGateAxisClear,
  assertWayGraph,
  assertWaysClearOfMonuments,
} from './assertions';
import { buildWall } from './circuit';
import { assertBlockBearingSign, assertBlocksAreFaces, buildDistricts } from './fabric';
import { assertRegionPartition, OFF_FRAME_REGIONES, regionFallbacks } from './regions';
import { AQUEDUCTS, LANDMARKS, PLAZAS, WAY_FRONTAGE, wayMix, WAYS } from './layout';
import { buildLandmarks } from './monuments';
import { WALL } from './section';

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
   * `circuit.ts` builds. They must match: `masonryTopAt` alternates the two per projectile per
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
     * `GATE_X` from Rome's `apertures.ts` and `fitWallPath` from Rome's `circuit.ts`, so the triple wall is currently
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
    /**
     * **`assertRomeSection`, printed once at boot.** §14.4a, §15 tasks 3 and 5.
     *
     * *"`wall.ts` has no build-time self-check of any kind. This is the largest structural
     * asymmetry between the two wall files and the most portable thing Carthage has."* It has
     * one now, and the two lines below are what §15 requires *printed*: the bay grid against
     * its two surveyed anchors, and — for each aperture — the snap distance and the masonry
     * left either side of its clear opening inside its own bay, which is §14.3's test.
     *
     * Printed with `console.info` and not `console.warn` when it passes, because a boot line
     * that reads as a problem when nothing is wrong is a boot line people stop reading. The
     * faults themselves go out as warnings, and the whole record goes onto `CityChecks` so a
     * probe reads numbers rather than parsing a log.
     */
    const rome = cw ? null : (wall as ReturnType<typeof buildWall>).section;
    const romeAssertions: CityAssertion[] = [];
    /**
     * **`assertRomeFrame`, printed once at boot, beside the section.** `ROME-FABRIC.md` §4.1's
     * closing list — *"sanity checks that must hold **after** the build"* — in
     * `CARTHAGE.md` §2.5's format.
     *
     * It is printed for the whole map and not only for Rome-the-fortification, and it goes
     * *before* the section line, because the section is one system inside a frame and the frame
     * is what decides whether any of it can work. `ROME-FABRIC.md` §1.1 step 4's finding on
     * Carthage is the reason it exists at all: Carthage wrote four whole-map numbers into its
     * document and never instrumented one of them.
     *
     * Rows whose `pending` is set are printed with the phase that closes them and are excluded
     * from the fault list. See `RomeFrameCheck` for why they are here before they can pass.
     */
    const frame = cw ? null : assertRomeFrame();
    if (frame) {
      console.info(
        `[city:rome] frame: KX ${frame.kx} KZ ${frame.kz} (anisotropy ${frame.anisotropy.toFixed(2)}x), ` +
          `gate at x ${frame.gateX.toFixed(1)} z ${frame.gateZ.toFixed(1)}; ` +
          `${frame.offMap.length} survey row(s) past the +Z edge: ${frame.offMap.join(', ') || 'none'}`
      );
      for (const c of frame.checks) {
        const mark = c.pending ? 'PENDING' : c.ok ? 'ok     ' : 'FAULT  ';
        console.info(
          `[city:rome]   ${mark} ${c.name}: ${c.detail}` +
            `  [target ${c.target}]${c.pending ? `  <- ${c.pending}` : ''}`
        );
      }
      for (const s of frame.faults) console.warn(`[city:rome] frame fault: ${s}`);
      romeAssertions.push({
        name: 'frame',
        ok: frame.faults.length === 0,
        detail:
          `KX ${frame.kx} KZ ${frame.kz}; ` +
          `${frame.checks.filter((c) => c.ok).length} of ${frame.checks.length} checks pass, ` +
          `${frame.checks.filter((c) => c.pending).length} pending a later phase, ` +
          `${frame.faults.length} fault(s)`,
      });
    }
    if (rome) {
      console.info(
        `[city:rome] circuit: ${rome.bays} bays at ${rome.pitch.toFixed(2)} m, ` +
          `x ${rome.westEnd.toFixed(1)} .. ${rome.eastEnd.toFixed(1)} ` +
          `(survey +2 / +1335), worst pitch deviation ${(rome.pitchDeviation * 100).toFixed(1)} %, ` +
          `worst walk step ${rome.worstWalkStep.toFixed(2)} m at x ${rome.worstWalkStepX.toFixed(0)} ` +
          `(rake ${rome.worstWalkRake.toFixed(2)}), ${rome.baysBelowWater} bay(s) below water, ` +
          `worst tower lane ${rome.worstLane.toFixed(2)} m`
      );
      console.info(
        `[city:rome] apertures: ${rome.apertures
          .map((a) => `${a.id} x ${a.x.toFixed(1)} bay ${a.bay} snap ${a.snap >= 0 ? '+' : ''}${a.snap.toFixed(2)} m, ` +
            `${a.clearance.toFixed(2)} m of masonry inside its bay`)
          .join('; ')}`
      );
      for (const s of rome.faults) console.warn(`[city:rome] section fault: ${s}`);
      romeAssertions.push(
        {
          name: 'section',
          ok: rome.faults.length === 0,
          detail: `${rome.bays} bays at ${rome.pitch.toFixed(2)} m x-pitch, deviation ` +
            `${(rome.pitchDeviation * 100).toFixed(1)} %; section sums to ` +
            `${rome.sectionSum.toFixed(2)} m against ${rome.sectionTarget.toFixed(2)}; ` +
            `${rome.faults.length} fault(s)`,
        },
        {
          name: 'apertures fit their bays',
          ok: rome.apertures.every((a) => a.clearance >= 1.0),
          detail: rome.apertures
            .map((a) => `${a.id} ${a.clearance.toFixed(2)} m (snap ${a.snap.toFixed(2)} m)`)
            .join(', '),
        },
        {
          name: 'the Muro Torto is walked onto, not climbed',
          ok: rome.tortoBays === 7 && rome.tortoWorstApron <= 0.62,
          detail: `${rome.tortoBays} bays, worst apron rise ${rome.tortoWorstApron.toFixed(2)} m ` +
            '(a level joint is 0.62)',
        }
      );
    }

    // Reserve every landmark's *oriented rectangular* footprint before a single insula is
    // generated. A circle is not good enough: the Circus Maximus is 621 × 118 m, and the
    // circle that used to stand in for it left five sixths of its footprint free for the
    // fabric to grow through — which is precisely what happened.
    const keepOut = new KeepOut();
    /**
     * **A monument gets a keep-out, not a non-intersection, and that margin is the whole point.**
     *
     * `l.hw`/`l.hd` are already the precinct box, but `PRECINCT` = 1.07 buys a monument 3.5 % of
     * its own half-width — about 1.3 m on the Pantheon — and two separate instruments say that is
     * not enough. `probe-fabric` G9 wants `CLEAR_MON_BLD` = 1.5 m, the *ambitus* of the XII
     * Tables and the oldest surviving Roman rule on exactly this question, and it fails at
     * **0.69 m** between the Ara Pacis and an insula. G16 wants no monument's drawn stone inside
     * a building, and it fails wherever a builder's cornice or podium oversails its own box,
     * which G14 measures separately and independently.
     *
     * Reserving the *ambitus* plus a metre of oversail here makes both pass **by construction**
     * rather than by where an insula happened to fall — which is how they were passing, as this
     * pass discovered by moving the Janiculum 404 m and watching an unrelated insula land on the
     * Theatre of Pompey. A ground judge asked for this in as many words: *"a monument needs a
     * keep-out, not a non-intersection… G9 is right and too weak."*
     *
     * It is deliberately small. The same judge also wants the Pantheon's 60 m paved forecourt,
     * and that is a *plaza* — an authored piece of the plan with its own shape and paving — not a
     * uniform margin, and it belongs to phase 5 with the rest of the fabric. This is the floor,
     * not the answer.
     *
     * **Phase 3 raised it from 2.5 to 4.0, and the extra 1.5 m comes off a measurement rather
     * than off an instance.** Re-laying the road armature moved every quarter's grain, which
     * moved the insulae, and one of them landed where the Baths of Trajan's drawn stone
     * oversails its own declared box — G16 went red at **0.94 m** of intrusion. §9.7 predicted
     * exactly that: it said G16 *"was passing on where an insula happened to fall"*, and this is
     * the pass that made it fall somewhere else. Tuning the constant until that one insula
     * clears would be the same fault again, so the number is taken from `probe-fabric` G14's own
     * table instead: six of twenty-seven monuments draw stone outside their box, by **2.52 m**
     * (the Tabularium) to **13.65 m** (the Stadium of Domitian). 2.52 is the *smallest* oversail
     * any monument has, so below `1.5 + 2.52` the reservation is provably too small for every
     * one of the six — that is the floor, and 4.0 m is it.
     *
     * **It does not cover the Stadium's 13.65 m and is not meant to.** The fix for that is
     * `MAP-METHOD.md` rule 11 — derive the reserved rectangle *from the geometry builder's own
     * extents* instead of typing it into a survey table — and it is monument work, not road
     * work. `buildLandmarks` already runs in this function; it runs *after* the keep-out is
     * built, and swapping those two lines is the whole of the plumbing.
     */
    const MON_AMBITUS = 4;
    for (const l of LANDMARKS) {
      keepOut.addRect(l.x, l.z, l.hw + MON_AMBITUS, l.hd + MON_AMBITUS, l.rot);
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
    /**
     * **The rules and ring members the frame ruled out, printed by name.**
     *
     * At `KZ` = 0.35 six survey rows are past the +Z edge, so eleven topology rules and three
     * ring members cannot be checked. That is a real reduction in what the build proves about
     * itself and it is printed rather than absorbed, because a check count that quietly falls
     * is the shape of every fault `MAP-METHOD.md` rule 6 is about. `assertTopology` separates
     * an off-map id from an unknown one so that a genuine typo is still a fault.
     */
    if (topo.offMapSkips > 0 || ring.offMapSkips > 0) {
      console.info(
        `[city:rome] frame: ${topo.offMapSkips} topology rule(s) and ${ring.offMapSkips} hill-ring ` +
          `member(s) are off this map and not checked — ${[...topo.skipped, ...ring.skipped].join(', ')}`
      );
    }
    // Exactly one Flavian Amphitheatre. See `assertOneAmphitheatre`.
    const amphitheatres = assertOneAmphitheatre();
    if (!amphitheatres.ok) {
      console.warn(
        `[city] expected 1 amphitheatre, found ${amphitheatres.count}: ${amphitheatres.ids.join(', ')}`
      );
    }

    const landmarks = buildLandmarks(heightAt, 'rome-monuments');

    /*
     * **Phase 4's three grid assertions, before the fabric is built and after it.**
     * `docs/ROME-FABRIC.md` §5 phase 4.
     */
    const partition = assertRegionPartition();
    if (!partition.ok) {
      console.warn(
        `[city] the regiones do not partition: ${partition.danglingEdges} dangling edge(s), `
          + `${partition.foldedEdges} folded, ${partition.sameDirectionEdges} wound the same way; `
          + `frame covered ${partition.frameCovered}; off-frame rows that are on the frame: `
          + `${partition.offFrameOnFrame.join(', ') || 'none'}`
      );
    }
    console.info(
      `[city:rome] regiones: ${partition.regions} on this frame partition it exactly; `
        + `${partition.offFrame.length} off the +Z edge and not authored — ${partition.offFrame.join(', ')}`
    );
    const sign = assertBlockBearingSign();
    if (!sign.ok) {
      console.warn(
        `[city] the block frame is mirrored: worst ${sign.worstDeg.toFixed(3)} deg over `
          + `${sign.cases.length} asymmetric cases — `
          + sign.cases.filter((c) => !c.ok).map((c) => `${c.inputDeg} deg -> drawn ${c.drawnDeg.toFixed(2)}`).join('; ')
      );
    }

    const districts = buildDistricts(heightAt, keepOut, 'rome-fabric', wall.wallZAt);

    const blocksAreFaces = assertBlocksAreFaces(districts.footprints);
    if (!blocksAreFaces.ok) {
      console.warn(
        `[city] ${blocksAreFaces.straddling} plot(s) of ${blocksAreFaces.plots} straddle a street `
          + `centreline, worst ${blocksAreFaces.worstDepthM.toFixed(2)} m: ${blocksAreFaces.worst.join('; ')}`
      );
    }
    if (regionFallbacks() > 0) {
      console.info(`[city:rome] regionAt fell back to the nearest ring ${regionFallbacks()} time(s)`);
    }
    romeAssertions.push(
      {
        name: 'regiones-partition',
        ok: partition.ok,
        detail: `${partition.regions} regions tile the frame; ${OFF_FRAME_REGIONES.length} off-frame `
          + `(${partition.offFrame.join(', ')}); ${partition.danglingEdges} dangling, `
          + `${partition.foldedEdges} folded, ${partition.sameDirectionEdges} same-direction edges`,
      },
      {
        name: 'block-bearing-sign',
        ok: sign.ok,
        detail: `${sign.cases.filter((c) => c.ok).length}/${sign.cases.length} asymmetric cases; `
          + `worst ${sign.worstDeg.toFixed(6)} deg between the input bearing and the drawn long axis`,
      },
      {
        name: 'blocks-are-faces',
        ok: blocksAreFaces.ok,
        detail: `${blocksAreFaces.plots} plots, ${blocksAreFaces.straddling} straddling a street `
          + `centreline, worst ${blocksAreFaces.worstDepthM.toFixed(2)} m; `
          + `${districts.report.blocks} blocks from ${districts.report.faces} faces, `
          + `${districts.report.nonConvexFaces} of them re-entrant`,
      }
    );

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
          `inside a monument; worst ${wayClearance.worst?.id} at ${wayClearance.worst?.pct}%` +
          `; per way: ${wayClearance.byWay
            .filter((w) => w.inside > 0)
            .map((w) => `${w.id} ${w.pct}% (${w.inside}/${w.samples}: ${w.hit.join('+')})`)
            .join(', ')}`
      );
    }
    /**
     * **And the same question in survey metres, printed beside it, because they are different
     * questions and the record kept quoting one as the other.**
     *
     * The world-frame number above is what the game collides with and is dominated by the
     * projection: `KX` 0.443 and `KZ` 0.35 compress the *distance* between a street and a
     * building while the building keeps its true cross-section. The survey number is what the
     * road survey is actually responsible for. See `surveyFrameIntrusion`.
     */
    const sf = wayClearance.survey;
    console.info(
      `[city:rome] ranked ways inside a monument: ${wayClearance.inside}/${wayClearance.samples} = ` +
        `${((100 * wayClearance.inside) / Math.max(1, wayClearance.samples)).toFixed(1)}% in WORLD metres ` +
        `(the frame's number), ${sf.inside}/${sf.samples} = ${sf.pct}% in SURVEY metres against the ` +
        `published footprints (the road survey's number)` +
        (sf.byWay.some((w) => w.inside)
          ? `; survey-frame residual: ${sf.byWay
              .filter((w) => w.inside > 0)
              .map((w) => `${w.id} ${w.pct}% (${w.hit.join('+')})`)
              .join(', ')}`
          : '')
    );
    /**
     * The gate axis, printed beside the carriageway rather than instead of it. A ground judge's
     * headline is measured on this line and the record could not re-derive it; now it can, and
     * the difference between the two numbers is visible in one place. See `assertGateAxisClear`.
     */
    /**
     * Phase 3's acceptance, printed at every boot: is the armature one graph, and is every gate
     * mouth on a consular way? `feeders` used to manufacture the first and nothing checked the
     * second. See `assertWayGraph`.
     */
    const graph = assertWayGraph();
    console.info(
      `[city:rome] armature: ${graph.ways} ways, consular-and-above in ${graph.rankedComponents} ` +
        `piece(s); gate mouths: ${graph.gates.map((g) => `${g.id} -> ${g.on ?? 'NOTHING'}${g.cls ? ` (${g.cls})` : ''}`).join(', ')}` +
        `; ends joined to nothing: ${graph.dangling.length} (` +
        `${['map edge', 'gate', 'outside the curtain', 'STUB']
          .map((k) => `${graph.dangling.filter((d) => d.why === k).length} ${k}`)
          .join(', ')})`
    );
    for (const f of graph.faults) console.warn(`[city:rome] armature fault: ${f}`);
    const axis = assertGateAxisClear();
    console.info(
      `[city:rome] gate axis (the straight normal out of the Porta Flaminia, NOT the ` +
        `carriageway, which is a different line and is measured above): ` +
        `${axis.inside}/${axis.samples} = ${axis.pct}% ` +
        `inside masonry over the first 700 m` +
        (axis.blockers.length
          ? `; blocked by ${axis.blockers.map((b) => `${b.id} ${b.from}-${b.to} m`).join(', ')}`
          : '')
    );

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
      // The whole `assertRomeSection` record, so a probe reads the builder's own arithmetic
      // rather than re-deriving it from the bays. Absent under the `?fort=carthage` rig.
      romeSection: rome,
      // The whole `assertRomeFrame` record. `tools/probe-fabric.mjs` reads this rather than
      // re-deriving the projection, which is what stops a second, drifting copy of it.
      romeFrame: frame,
      checks: {
        assertions: romeAssertions,
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
