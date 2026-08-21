// `romeWallZ` rather than `./circuit`'s `wallCrestZ`, which is the same function under
// another name: `./circuit` now calls `assertRomeSection` below, and importing it back would
// close a cycle in a file tree the wall modules are deliberately a tree in.
import { MURO_TORTO, romeWallZ as wallCrestZ, WATER_LEVEL } from '../../terrain/topography';
import { lerp } from '../../util/math';
import { obbOverlap, type Obb } from '../layout';
import { BAY_COUNT, CURTAIN_T, MIN_LANE, WALL } from './section';
import {
  LANDMARKS,
  PRECINCT,
  TOPOLOGY,
  WAY_RANK,
  WAYS,
} from './layout';
import { ROME } from './survey';

/**
 * Build-time checks on Rome's plan.
 *
 * `src/city/carthage/assertions.ts` is the exemplar and says why the instrument is the
 * point: an assertion whose name reads like a guarantee and whose body samples the wrong
 * population reports zero, correctly, while the player looks at the fault. Each check here
 * names in its result exactly what it compared.
 *
 * Split out of `layout.ts` by §15 task 0. §15 task 3 adds `assertRomeSection` — the
 * build-time self-check Rome's wall builder has never had and `carthageWall.ts` has three of
 * (§14.4a) — and this is the file it goes in.
 */

/**
 * Build-time proof that no two monuments interpenetrate.
 *
 * Called from `CitySystem.init` and reported in `stats()`. `pad` is deliberately 0 here
 * — the resolver asks for a nine-metre street between footprints, and this asks only
 * that the masonry does not intersect, so a pair that ends up sharing a party wall is
 * reported as a warning rather than an error.
 */
export function assertNoFootprintOverlaps(): {
  ok: boolean;
  count: number;
  worst: number;
  pairs: { a: string; b: string; depth: number }[];
} {
  const pairs: { a: string; b: string; depth: number }[] = [];
  let worst = 0;
  for (let i = 0; i < LANDMARKS.length; i++) {
    for (let j = i + 1; j < LANDMARKS.length; j++) {
      const a = LANDMARKS[i];
      const b = LANDMARKS[j];
      // Gardens, hills and the island are landscape, not masonry.
      if (a.soft || b.soft) continue;
      // Divide the precinct margin back out: two precincts may touch, two buildings
      // may not.
      const ab: Obb = { x: a.x, z: a.z, hw: a.hw / PRECINCT, hd: a.hd / PRECINCT, rot: a.rot };
      const bb: Obb = { x: b.x, z: b.z, hw: b.hw / PRECINCT, hd: b.hd / PRECINCT, rot: b.rot };
      const hit = obbOverlap(ab, bb, 0);
      if (!hit) continue;
      pairs.push({ a: a.id, b: b.id, depth: +hit.depth.toFixed(2) });
      worst = Math.max(worst, hit.depth);
    }
  }
  return { ok: pairs.length === 0, count: pairs.length, worst: +worst.toFixed(2), pairs };
}


export function assertTopology(): { ok: boolean; checks: number; failures: string[] } {
  const by = new Map(LANDMARKS.map((l) => [l.id, l]));
  const failures: string[] = [];
  for (const t of TOPOLOGY) {
    const a = by.get(t.a);
    const b = by.get(t.b);
    if (!a || !b) {
      failures.push(`unknown id in rule: ${t.a} / ${t.b}`);
      continue;
    }
    if (t.rule === 'between') {
      const c = by.get(t.c);
      if (!c) {
        failures.push(`unknown id in rule: ${t.c}`);
        continue;
      }
      // `a` must lie inside the band between b and c, and nearer their line than either
      // of them is to the midpoint — i.e. genuinely in the valley, not beyond one end.
      const ux = c.x - b.x;
      const uz = c.z - b.z;
      const len2 = ux * ux + uz * uz;
      const s = ((a.x - b.x) * ux + (a.z - b.z) * uz) / len2;
      const px = b.x + ux * s;
      const pz = b.z + uz * s;
      const off = Math.sqrt((a.x - px) * (a.x - px) + (a.z - pz) * (a.z - pz));
      if (s < 0.15 || s > 0.85 || off > Math.sqrt(len2) * 0.5) {
        failures.push(`${t.a} is not between ${t.b} and ${t.c} (t=${s.toFixed(2)}, offset ${off.toFixed(0)} m)`);
      }
      continue;
    }
    const ok =
      t.rule === 'north' ? a.z < b.z
      : t.rule === 'south' ? a.z > b.z
      : t.rule === 'east' ? a.x > b.x
      : a.x < b.x;
    if (!ok) failures.push(`${t.a} is not ${t.rule} of ${t.b}`);
  }
  return { ok: failures.length === 0, checks: TOPOLOGY.length, failures };
}


/**
 * There is exactly one Flavian Amphitheatre.
 *
 * The user's report was blun— "in your map there are multiple colosseums" — so this is a
 * build-time count rather than a comment. What actually produced the extra ones was not a
 * duplicated landmark: `LANDMARKS` has always had one entry. It was three things that each
 * *looked* like one from the air:
 *
 *  1. the Circus Maximus's *sphendone*, a 91 m half-disc of stepped seating, emitted at the
 *     monument's own origin instead of at the end of the track — the `pushTranslate` meant
 *     to place it was applied after the call and popped immediately, so a second tiered
 *     ellipse stood in the middle of the racetrack;
 *  2. `buildMound` drawing the Capitol and the Palatine as three concentric stepped rings,
 *     which reads as a cavea;
 *  3. the two theatres, whose flat 117 m scaenae-frons slab and thin radial seating made
 *     them read as half-amphitheatres rather than as theatres.
 *
 * All three are fixed in `monuments.ts`. This assertion guards the fourth possibility — a
 * landmark accidentally duplicated or an amphitheatre kit reused — by name and by the
 * geometry that actually gets an arcaded elliptical façade.
 */
export function assertOneAmphitheatre(): { ok: boolean; count: number; ids: string[] } {
  const ids = LANDMARKS.filter((l) => AMPHITHEATRE_IDS.has(l.id)).map((l) => l.id);
  return { ok: ids.length === 1, count: ids.length, ids };
}

/** Every landmark id that `buildLandmark` routes to the elliptical arcaded amphitheatre. */
export const AMPHITHEATRE_IDS: ReadonlySet<string> = new Set(['colosseum']);

/**
 * Clockwise ring of monuments seen from the Palatine, checked for cyclic order.
 *
 * This is the single most useful test that a heavily compressed plan still reads as Rome:
 * get the ring order right and the city is recognisable however hard the distances are
 * squeezed. The published ring of bearings from the Palatine is
 * Capitoline 326° → Pincian 347° → Quirinal 004° → Viminal 034° → Oppius 056° →
 * Esquiline 066° → Caelian 140° → Aventinus Maior 228° → Janiculum 278°, and the survey in
 * `survey.ts` reproduces it: Capitolium 318°, Serapis (Quirinal) 000°, Castra (Viminal) 040°,
 * Baths of Trajan (Oppius) 056°, Baths of Titus (Esquiline) 062°, Caelian 116°,
 * Aventine 231°, Janiculum 271° — seven of eight within 6°, which is a good independent
 * check on the coordinates. (The Horti Sallustiani sit in the *valley* between the Pincian
 * and the Quirinal rather than on the Pincian summit, so they come at 014° rather than 347°.)
 *
 * The Castra Praetoria is deliberately not in the ring. It stands at the far north-east *end*
 * of the Viminal rather than on the hill, and it is the one thing in the plan pinned hard
 * against the east edge of the heightfield, so its bearing from the Palatine inflates to 71°
 * against a true 40° and it is a poor proxy for the Viminal. Its position relative to the
 * Baths of Trajan is asserted directly in `TOPOLOGY` instead, which is the fact that matters.
 *
 * The expected order is therefore derived from the survey itself rather than hardcoded:
 * what is being asserted is that the projection and the overlap solver preserved the real
 * angular order, which is the property the plan's legibility depends on.
 */
const RING_TOLERANCE = 15;
const HILL_RING: readonly string[] = [
  'temple-jupiter',
  'temple-serapis',
  'gardens-sallust',
  'baths-trajan',
  'baths-titus',
  'caelian-villas',
  'aventine-temples',
  'janiculum',
];

/** Bearing from a to b in world space, degrees clockwise from north (−Z). */
const worldBearing = (ax: number, az: number, bx: number, bz: number): number => {
  let b = (Math.atan2(bx - ax, -(bz - az)) * 180) / Math.PI;
  if (b < 0) b += 360;
  return b;
};

export function assertHillRing(): { ok: boolean; checks: number; failures: string[] } {
  const by = new Map(LANDMARKS.map((l) => [l.id, l]));
  const survey = new Map(ROME.map((m) => [m.id, m]));
  const hub = by.get('palatine');
  const hubReal = survey.get('palatine');
  const failures: string[] = [];
  if (!hub || !hubReal) return { ok: false, checks: 0, failures: ['no palatine'] };

  // Expected order: sorted by the *real* bearing from the Palatine.
  const ring = HILL_RING.map((id) => {
    const l = by.get(id)!;
    const m = survey.get(id)!;
    // Real bearing, degrees clockwise from north, in the survey's own east/north frame.
    let real = (Math.atan2(m.e - hubReal.e, m.n - hubReal.n) * 180) / Math.PI;
    if (real < 0) real += 360;
    return { id, real, world: worldBearing(hub.x, hub.z, l.x, l.z) };
  }).sort((a, b) => a.real - b.real);

  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    // Signed shortest turn from a to b. Positive is clockwise, the direction the ring runs.
    let step = b.world - a.world;
    while (step <= -180) step += 360;
    while (step > 180) step -= 360;
    // Tolerance. The map inflates every bearing toward east-west — a real 40° becomes 51°
    // under a 1.45:1 frame — and the two things pinned hardest, the Castra Praetoria at the
    // east edge of the heightfield and the Baths of Trajan wedged against it, land within
    // 13° of each other in the wrong order. This check exists to catch a hill on the wrong
    // *side* of the city, which is what makes a plan unrecognisable; a degree-level
    // inversion between two complexes in the same quarter is not visible in any frame.
    if (step < -RING_TOLERANCE) {
      failures.push(
        `hill ring out of order: ${a.id} (${a.world.toFixed(0)}°, real ${a.real.toFixed(0)}°) ` +
          `then ${b.id} (${b.world.toFixed(0)}°, real ${b.real.toFixed(0)}°)`
      );
    }
  }
  return { ok: failures.length === 0, checks: ring.length - 1, failures };
}

/**
 * How much of the ranked network still runs inside a monument.
 *
 * The counterpart to `assertNoFabricOverlaps`, and it exists for the same reason: a check
 * that only compares monuments with monuments will report a clean plan while the player is
 * looking at a temple standing in a road. Rings are excluded — hugging a precinct is what a
 * ring is for — and so is anything below `secondary`, because a *vicus* stopping at a
 * precinct wall and picking up on the far side is correct.
 *
 * **This one is expected to be non-zero and is reported rather than enforced**, and the
 * distinction is the point. It was 24 % of the ranked length before the ways were deflected
 * round the resolved monument positions, and 90 % on the Via Appia alone; the deflector
 * brings it down but cannot reach zero, because compressing Rome's depth 4.5× while
 * monuments keep 65 % of their true footprint genuinely leaves no 42 m line through parts of
 * the Campus Martius (see `PLAN_SCALE`). What the residual costs is nothing on the ground —
 * the monument already occupies that reservation and `onMonument` keeps the paving off it —
 * so cutting the runs out to make the number green would be exactly the kind of green
 * assertion over a real defect this file has been bitten by before. Watch it for
 * *regressions*, which mean the resolver has moved a monument onto a road again.
 */
export function assertWaysClearOfMonuments(): {
  ok: boolean;
  samples: number;
  inside: number;
  worst: { id: string; pct: number } | null;
} {
  const solids = LANDMARKS.filter((l) => !l.soft);
  const pt: Obb = { x: 0, z: 0, hw: 0.1, hd: 0.1, rot: 0 };
  let samples = 0;
  let inside = 0;
  let worst: { id: string; pct: number } | null = null;
  for (const w of WAYS) {
    if (w.id.startsWith('ring-') || WAY_RANK[w.cls] < WAY_RANK.secondary) continue;
    let n = 0;
    let bad = 0;
    for (let i = 0; i + 1 < w.path.length; i++) {
      const a = w.path[i];
      const b = w.path[i + 1];
      const steps = Math.max(1, Math.round(Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z)) / 10));
      for (let s = 0; s <= steps; s++) {
        const x = lerp(a.x, b.x, s / steps);
        const z = lerp(a.z, b.z, s / steps);
        if (z < wallCrestZ(x)) continue;
        n++;
        pt.x = x;
        pt.z = z;
        // The carriageway, not the centreline: half the road has to clear the masonry.
        if (solids.some((l) => obbOverlap(pt, l, w.width * 0.5) !== null)) bad++;
      }
    }
    if (!n) continue;
    samples += n;
    inside += bad;
    const pct = (bad / n) * 100;
    if (!worst || pct > worst.pct) worst = { id: w.id, pct: +pct.toFixed(0) };
  }
  return { ok: inside === 0, samples, inside, worst };
}

// ---------------------------------------------------------------------------
// assertRomeSection — §14.4a, §15 task 3
// ---------------------------------------------------------------------------

/** §2.5's two anchors, as the acceptance in §15 task 3 states them. */
const SURVEY_WEST = 2;
const SURVEY_EAST = 1335;
/** §14.3's own figure: masonry either side of a clear opening, inside its own bay. */
const GATE_BAY_MARGIN = 1.0;
/**
 * `Siege`'s `WALK_STEP_OVER`, restated: a joint under this is `Level` and needs no flight.
 *
 * Restated and not imported, because `city/` may not depend on `sim/` and because this is an
 * acceptance target rather than a shared input — §14.1's rule is that the instrument states
 * what it is grading against so a source that drifts measures as wrong instead of as itself.
 */
const WALK_STEP_OVER = 0.62;
/**
 * **§4.8's stage census.** A table of thirty-six entries is easy to mistype and impossible to
 * eyeball; this is the count the document itself publishes, so a slip shows up as a fault.
 */
const STAGE_CENSUS: Readonly<Record<string, number>> = {
  finished: 23, 'half-built': 4, 'no-parapet': 5, footing: 3, gap: 1,
};

/**
 * Everything `assertRomeSection` measured, as data on the wall's own output.
 *
 * §14.4a is the whole argument for this type existing: *"`wall.ts` has no build-time
 * self-check of any kind. This is the largest structural asymmetry between the two wall files
 * and the most portable thing Carthage has."* `carthageWall.ts` publishes three —
 * `assertSection`, `cutFaults` and `sectionFaults` — *"all as data on the output, not as a
 * `console.warn` and not as a throw"*, and its own comment says why: *"a build-time
 * `console.warn` is invisible to a probe and an exception takes the page down… prose does not
 * run."*
 *
 * *"Nothing checks that Rome's section closes, that a gate fits its bay, that `walkY` steps
 * are survivable, or that a bay's published `passOuter`/`passInner` match the stone it cut.
 * Every defect in §4.1 and §5 above is one an eight-line assertion would have printed at
 * every boot for the last six months."* This is that assertion, and every scalar below is one
 * §15 task 3 names by hand.
 */
export interface RomeSection {
  /** Plinth + lift + parapet, against the height to the merlon tops. */
  sectionSum: number;
  sectionTarget: number;
  /** Bays laid, and the pitch they were laid at. */
  bays: number;
  pitch: number;
  /** Worst deviation of a bay's own x-pitch from the nominal, as a fraction. §2.1. */
  pitchDeviation: number;
  /** The two anchors, as built. §2.5 puts them at +2 and +1335. */
  westEnd: number;
  eastEnd: number;
  /** Worst bay-to-bay `walkY` step, and the x it is at. */
  worstWalkStep: number;
  worstWalkStepX: number;
  /** Worst rake of a bay-to-bay joint, as rise over the tower gap it is bridged across. */
  worstWalkRake: number;
  /** Bays whose footing stands at or below `WATER_LEVEL`. §4.1: five of them used to. */
  baysBelowWater: number;
  /** Narrowest published tower lane, against `MIN_LANE`, and how many are under it. */
  worstLane: number;
  lanesUnderMin: number;
  /** Every aperture, with what §14.3's test asks of it. */
  apertures: {
    id: string;
    x: number;
    /** How far it was moved to reach a bay centre. §15 task 5 requires this printed. */
    snap: number;
    bay: number;
    clearWidth: number;
    /** `min(distance from either edge of the clear opening to the end of its bay)`. */
    clearance: number;
  }[];
  /** The Muro Torto: its seven bays, and the worst rise a man steps up off the hillside. */
  tortoBays: number;
  tortoWorstApron: number;
  /** Stage census, against §4.8's own totals. */
  stages: Record<string, number>;
  /** Empty means every one of the above closed. */
  faults: string[];
}

/** What `assertRomeSection` grades. Supplied by `buildWall` from what it has just built. */
export interface RomeSectionInput {
  bays: readonly {
    index: number; x0: number; x1: number; stage: string; walkY: number; groundY: number;
    garrisonable: boolean; passOuter: number; passInner: number; hasTower: boolean;
  }[];
  apertures: readonly { id: string; x: number; snap: number; bay: number; clearWidth: number }[];
  stairs: readonly { bay: number; rise: number }[];
  pitch: number;
  xMin: number;
  xMax: number;
  /** Plan gap a joint is bridged across — the tower's own footprint plus its two margins. */
  towerGap: number;
}

/**
 * Does Rome's section close, does every gate fit its bay, and can a man walk the wall?
 *
 * Faults are returned, never thrown and never logged from here — see `RomeSection`. The
 * caller (`rome/plan.ts`) prints them once at boot and publishes the whole record through
 * `CitySystem.stats()`, which is what makes them measurable by a probe rather than by reading
 * a console.
 */
export function assertRomeSection(inp: RomeSectionInput): RomeSection {
  const f: string[] = [];

  // ---- the section sums to the height it claims ---------------------------
  // §4.3: 1.35 m of travertine plinth carries 5.15 m of brick-faced lift to a 6.5 m walk,
  // and a 2.05 m parapet stands on that for 8.55 m to the merlon tops. If this does not
  // close, `crestY` is not where the drawn crenellation is and every shot at a merlon is
  // resolved against air.
  const lift = WALL.height - WALL.plinthHeight;
  const sectionSum = WALL.plinthHeight + lift + WALL.parapetHeight;
  const sectionTarget = WALL.height + WALL.parapetHeight;
  if (Math.abs(sectionSum - sectionTarget) > 1e-9) {
    f.push(`section sums to ${sectionSum.toFixed(3)} m, not ${sectionTarget.toFixed(3)}`);
  }
  // §4.3a: the clear standing band has to seat five ranks at the sim's 0.72 m pitch on the
  // *worst* bay, which is the tallest — the batter has eaten most off its outer lip there.
  const tallest = inp.bays.reduce((m, b) => Math.max(m, b.walkY - b.groundY), 0);
  const band = CURTAIN_T - WALL.parapetThickness - 0.8 - WALL.batter * tallest;
  if (band < 5 * 0.72) {
    f.push(`clear standing band ${band.toFixed(2)} m on the tallest bay holds under five ranks`);
  }

  // ---- the bay grid -------------------------------------------------------
  if (inp.bays.length !== BAY_COUNT) f.push(`${inp.bays.length} bays laid, not ${BAY_COUNT}`);
  let pitchDeviation = 0;
  for (let i = 1; i < inp.bays.length; i++) {
    const d = inp.bays[i].x0 - inp.bays[i - 1].x0;
    pitchDeviation = Math.max(pitchDeviation, Math.abs(d - inp.pitch) / Math.abs(inp.pitch));
  }
  // `CitySystem.bayAt` indexes arithmetically in x and `assertUniformBayPitch` warns past
  // 12 %. Graded here as well so the number is *printed* rather than only warned about.
  if (pitchDeviation > 0.12) {
    f.push(`bay pitch deviates ${(pitchDeviation * 100).toFixed(1)} %, past \`bayAt\`'s 12 % tolerance`);
  }
  const westEnd = inp.xMin;
  const eastEnd = inp.xMax;
  if (Math.abs(westEnd - SURVEY_WEST) > 2) {
    f.push(`west end at x ${westEnd.toFixed(2)}, ${Math.abs(westEnd - SURVEY_WEST).toFixed(2)} m off the surveyed +${SURVEY_WEST}`);
  }
  if (Math.abs(eastEnd - SURVEY_EAST) > 2) {
    f.push(`east end at x ${eastEnd.toFixed(2)}, ${Math.abs(eastEnd - SURVEY_EAST).toFixed(2)} m off the surveyed +${SURVEY_EAST}`);
  }

  // ---- the walk a garrison has to move along ------------------------------
  let worstWalkStep = 0;
  let worstWalkStepX = 0;
  let worstWalkRake = 0;
  for (let i = 1; i < inp.bays.length; i++) {
    const a = inp.bays[i - 1];
    const b = inp.bays[i];
    if (!a.garrisonable || !b.garrisonable) continue;
    const step = Math.abs(b.walkY - a.walkY);
    if (step > worstWalkStep) {
      worstWalkStep = step;
      worstWalkStepX = b.x0;
    }
    worstWalkRake = Math.max(worstWalkRake, step / inp.towerGap);
  }
  /*
   * §15 task 3 asked for a bare 1.2 m cap and the measurement disagreed with it: `stepAcross`
   * tests the **rake**, because a bare height refuses Carthage's 2.00 m tower passes (15°
   * ramps any man walks) and admits a 1.50 m step across 1.30 m of plan that runs 0.91 m
   * inside the masonry. `STAIR_SLOPE` inverted — 0.31 of rise on 0.34 of going — is the
   * steepest flight this project builds flights out of, so it is the steepest joint there is
   * stone under, and it is the number the wall is graded against here as well.
   */
  if (worstWalkRake > 0.31 / 0.34) {
    f.push(`worst bay joint rakes ${worstWalkRake.toFixed(2)} at x ${worstWalkStepX.toFixed(0)}, past the tread module`);
  }

  // ---- five bays of Aurelian curtain used to stand in the Tiber -----------
  const baysBelowWater = inp.bays.filter((b) => b.groundY <= WATER_LEVEL).length;
  if (baysBelowWater > 0) {
    f.push(`${baysBelowWater} bay(s) footed at or below WATER_LEVEL ${WATER_LEVEL} m`);
  }

  // ---- the doorway through every tower ------------------------------------
  let worstLane = Infinity;
  let lanesUnderMin = 0;
  for (const b of inp.bays) {
    if (!b.hasTower || b.passOuter === 0) continue;
    const lane = b.passOuter - b.passInner;
    worstLane = Math.min(worstLane, lane);
    if (lane < MIN_LANE) lanesUnderMin++;
  }
  if (!Number.isFinite(worstLane)) worstLane = 0;
  if (lanesUnderMin > 0) {
    f.push(`${lanesUnderMin} tower lane(s) narrower than MIN_LANE ${MIN_LANE} m, worst ${worstLane.toFixed(2)}`);
  }

  /*
   * ---- §14.3's test: does every aperture fit the bay it is cut through? ----
   *
   * Carthage prints *"porta-uticensis is cut past the end of bay 50"* at every boot and has
   * done for four commits, because *"the gate's x was chosen in the survey and the bay grid
   * was laid independently, so nothing forced them to agree."* §15 task 5: *"at boot, for each
   * gate, `min(distance from either edge of the clear opening to the end of its bay) >= 1.0 m`,
   * printed. Any gate that cannot satisfy it moves a bay."*
   */
  const apertures = inp.apertures.map((a) => {
    const b = inp.bays[a.bay];
    const half = a.clearWidth * 0.5;
    const clearance = b ? Math.min(a.x - half - b.x0, b.x1 - (a.x + half)) : -Infinity;
    if (!b) f.push(`${a.id} is booked to bay ${a.bay}, which does not exist`);
    else if (clearance < GATE_BAY_MARGIN) {
      f.push(`${a.id} leaves ${clearance.toFixed(2)} m of masonry inside bay ${a.bay}, under ${GATE_BAY_MARGIN}`);
    }
    return { id: a.id, x: a.x, snap: a.snap, bay: a.bay, clearWidth: a.clearWidth, clearance };
  });

  // ---- the Muro Torto walks onto the hillside -----------------------------
  const torto = inp.bays.filter((b) => b.x1 > MURO_TORTO.x0 + 1 && b.x0 < MURO_TORTO.x1 - 1);
  const aprons = torto.map((b) => inp.stairs.find((s) => s.bay === b.index));
  const missing = aprons.filter((s) => s === undefined).length;
  const tortoWorstApron = aprons.reduce((m, s) => Math.max(m, s ? s.rise : Infinity), 0);
  if (missing > 0) {
    f.push(`${missing} of the Muro Torto's ${torto.length} bays have no apron onto the hillside`);
  } else if (tortoWorstApron > WALK_STEP_OVER) {
    f.push(`the Muro Torto's worst apron rises ${tortoWorstApron.toFixed(2)} m, past a level joint at ${WALK_STEP_OVER}`);
  }

  // ---- §4.8's stage census ------------------------------------------------
  const stages: Record<string, number> = {};
  for (const b of inp.bays) stages[b.stage] = (stages[b.stage] ?? 0) + 1;
  for (const [k, want] of Object.entries(STAGE_CENSUS)) {
    if ((stages[k] ?? 0) !== want) f.push(`${stages[k] ?? 0} \`${k}\` bays, not §4.8's ${want}`);
  }

  return {
    sectionSum, sectionTarget,
    bays: inp.bays.length, pitch: inp.pitch, pitchDeviation,
    westEnd, eastEnd,
    worstWalkStep, worstWalkStepX, worstWalkRake,
    baysBelowWater,
    worstLane, lanesUnderMin,
    apertures,
    tortoBays: torto.length, tortoWorstApron,
    stages,
    faults: f,
  };
}
