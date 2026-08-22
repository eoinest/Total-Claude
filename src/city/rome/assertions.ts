// `romeWallZ` rather than `./circuit`'s `wallCrestZ`, which is the same function under
// another name: `./circuit` now calls `assertRomeSection` below, and importing it back would
// close a cycle in a file tree the wall modules are deliberately a tree in.
import {
  GATE_Z,
  MURO_TORTO,
  romeWallZ as wallCrestZ,
  WALL_LENGTH,
  WALL_X_MAX,
  WALL_X_MIN,
  WATER_LEVEL,
} from '../../terrain/topography';
import { lerp } from '../../util/math';
import { obbOverlap, type Obb } from '../layout';
import { BAY_COUNT, CURTAIN_T, MIN_LANE, WALL } from './section';
import {
  LANDMARKS,
  PRECINCT,
  STREET_GAP,
  TOPOLOGY,
  WAY_RANK,
  WAYS,
} from './layout';
import { GATE_X, KX, KZ, ROME, worldOf, type RomeMonument } from './survey';

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
 * **How deep two structures in one declared `complex` may interpenetrate before it is a fault.**
 *
 * This constant is the correction of a documentation fault that a ground judge caught and that
 * was worse than it looked. `assertNoFootprintOverlaps`'s docstring claimed the abutment
 * population was *"gated at `ABUT_DEPTH`, not exempt"*, and **`ABUT_DEPTH` existed nowhere in
 * `src/`**: the function pushed every same-complex overlap into an array, printed it, and gated
 * only `pairs.length === 0`. The only place the bound was enforced was
 * `tools/scratch/rome-landmarks.mjs`, where it is `+arg('abut', '2.4')` — command-line
 * overridable, in the offline script that chose `draw` in the first place. So the licence was
 * granted and checked by the same file, which is `MAP-METHOD.md` rule 6's forbidden shape, and
 * the docstring asserting otherwise is rule 2's: *a number in prose without a source is a guess
 * that will be read as a measurement.*
 *
 * The value is **not** invented here. It is `tools/probe-fabric.mjs`'s own `ABUT_DEPTH_M = 2.5`
 * less the 0.1 m the allocator holds in reserve, so a footprint this file passes is a footprint
 * the external gate also classes as a joint in one structure rather than two buildings inside
 * each other. `survey.ts:RomeMonument.complex` carries the per-complex evidence.
 */
export const ABUT_DEPTH = 2.4;

/**
 * **The separation inside which two monuments share one frame, and the size deadband.**
 *
 * `VISUAL-RUBRIC.md` H8's own tell is *"pick two monuments **visible in one frame** and compare
 * which is bigger against which really was"*, so the relation that has to hold is about
 * co-visibility rather than about the whole city. `FRAME_RANGE` is measured rather than chosen:
 * the ground judge's `lm2-colosseum-200m.jpg` stands 200 m from a 108 m amphitheatre at a man's
 * eye and **the Colosseum is not in the picture** — a sliver of attic over a roofline, everything
 * else three- and four-storey insulae. If Rome's largest monument is already hidden by its own
 * fabric at 200 m, two monuments 400 m apart are not one view, and 150 m is the honest bound.
 *
 * `SIZE_DEADBAND` is the fraction of the shorter plan within which the survey is treated as
 * asserting **no** order. It is relative because length is: twelve metres between two 130 m
 * buildings is nothing and between two 18 m buildings is everything. 20 % is about the eye's
 * discrimination threshold for comparing two plan extents at different distances and elevations,
 * and inside it the ranking is the author's to make rather than the archaeology's — which is why
 * the Tabularium (73 m) is deliberately drawn smaller than the Temple of Jupiter (63 m) it is
 * 1.16x the length of: the Capitolium is the datum the whole survey is measured from and it
 * already reads as a warehouse with a gable. `tools/scratch/rome-landmarks.mjs --audit` prints
 * the inversion count at every band and at a 5 % deadband, so that choice is visible and counted
 * rather than absorbed.
 */
export const FRAME_RANGE = 150;
export const SIZE_DEADBAND = 0.2;

/**
 * **Do two monuments in one frame have the size order the archaeology gives them?**
 *
 * The invariant nobody had, and the one a person can actually see. Phase 2's proudest number was
 * *"0 of 860 spatial relations inverted"* — is the Pantheon still north of the Theatre of Pompey
 * — and it is a proof rather than a measurement, because `worldOf` is strictly monotone in both
 * axes and cannot invert a position. **Nobody asked the same question about size**, and the
 * answer was 52 of 331 pairs reversed, one in ten of the ones close enough to share a frame,
 * against **zero** before, because the single global `PLAN_SCALE` it replaced was uniform and a
 * uniform scale preserves order by definition.
 *
 * `MAP-METHOD.md` rule 17 is the general form: *when you replace a constant with a table, write
 * down what the constant was silently guaranteeing.* A scalar made this free; twenty-seven
 * authored footprints do not, because the allocation is driven by **crowding**, which is
 * uncorrelated with real size — the max-min floor holds a crowded 180 m porticus at 0.339 while
 * the raise pass lifts an uncrowded 135 m temple to 0.863. The result was a Castra Praetoria
 * drawn 0.87x the length of a tomb it is 4.60x longer than.
 *
 * The reference is outside the build: `len`/`wid` are the published dimensions each row cites,
 * and what is compared against them is `len × draw`, which is what gets drawn. Nothing here reads
 * the allocation's own intention (`MAP-METHOD.md` rule 6).
 *
 * Rows held down by a `drawMax` are counted apart and named rather than excluded: the frame or
 * the curtain is holding them, the inversion is real either way, and the reader is owed the split
 * rather than a smaller number (rule 16).
 */
export function assertSizeOrder(): {
  ok: boolean;
  relations: number;
  inverted: number;
  cappedInverted: number;
  worst: { big: string; small: string; real: number; drawn: number } | null;
  capped: string[];
} {
  const longOf = (m: { len: number; wid: number }) => Math.max(m.len, m.wid);
  const rows = LANDMARKS.filter((l) => !l.soft)
    .map((l) => ({ l, m: ROME.find((r) => r.id === l.id) }))
    .filter((e): e is { l: (typeof LANDMARKS)[number]; m: RomeMonument } => e.m !== undefined);
  let relations = 0;
  let inverted = 0;
  let cappedInverted = 0;
  let worst: { big: string; small: string; real: number; drawn: number } | null = null;
  const capped = rows.filter((e) => e.m.drawMax !== undefined).map((e) => e.l.id);
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      const la = longOf(a.m);
      const lb = longOf(b.m);
      if (Math.abs(la - lb) <= SIZE_DEADBAND * Math.min(la, lb)) continue;
      if (Math.hypot(a.l.x - b.l.x, a.l.z - b.l.z) > FRAME_RANGE) continue;
      relations++;
      const da = la * a.l.planScale;
      const db = lb * b.l.planScale;
      // A tie has lost the relation, not reversed it: two rows compressed to the same drawn
      // length is the allocation working, and `Math.sign(0)` would call it a fault.
      if (la > lb ? da >= db : da <= db) continue;
      if (a.m.drawMax !== undefined || b.m.drawMax !== undefined) cappedInverted++;
      else inverted++;
      const big = la > lb ? a : b;
      const small = la > lb ? b : a;
      const real = longOf(big.m) / longOf(small.m);
      const drawn = (longOf(big.m) * big.l.planScale) / (longOf(small.m) * small.l.planScale);
      if (worst === null || real / drawn > worst.real / worst.drawn) {
        worst = { big: big.l.id, small: small.l.id, real, drawn };
      }
    }
  }
  return { ok: inverted === 0, relations, inverted, cappedInverted, worst, capped };
}

/**
 * Build-time proof that the monument layout is correct **by construction**.
 *
 * Called from `CitySystem.init` and reported in `stats()`. Until phase 2 this was a check on a
 * solver's output: `resolveOverlaps` pushed footprints apart until they cleared, and then this
 * reported that they cleared. That is `MAP-METHOD.md` rule 6's forbidden shape — an instrument
 * grading the thing it was built from — and it passed happily on a city whose monuments were a
 * mean of 142 world metres from their surveyed positions. The solver is gone, so this now
 * measures a layout that nothing has corrected, and it can therefore fail.
 *
 * Three populations, reported separately, because collapsing them is how a licensed abutment
 * and a real fault come to look the same:
 *
 *  - **`pairs`** — two monuments in *different* complexes closer than `STREET_GAP`. Always a
 *    fault: it means a monument is standing in another quarter's street.
 *  - **`deepAbut`** — two monuments in the *same* complex interpenetrating deeper than
 *    `ABUT_DEPTH`. **Now genuinely a fault**, which is what this docstring claimed for two
 *    phases while the code merely printed it: a complex is a declaration that the city had
 *    continuous fabric there, and continuous fabric shares a wall rather than a volume.
 *  - **`abutments`** — the licensed ones, inside the bound. Printed with the deepest, because it
 *    is the number that will grow silently if somebody adds a row to a complex without checking.
 *
 * `soft` rows — gardens, the planted hills, the island — are landscape rather than masonry and
 * are skipped. That skip is **counted and named** in the return value rather than being silent,
 * per `MAP-METHOD.md` rule 16: a temple standing in the middle of the Horti Sallustiani is how
 * Rome worked, but "we did not look" and "there was nothing to see" must not print the same.
 */
export function assertNoFootprintOverlaps(): {
  ok: boolean;
  count: number;
  worst: number;
  pairs: { a: string; b: string; depth: number }[];
  abutments: { a: string; b: string; depth: number }[];
  deepAbut: { a: string; b: string; depth: number }[];
  worstAbut: number;
  softSkipped: string[];
} {
  const pairs: { a: string; b: string; depth: number }[] = [];
  const abutments: { a: string; b: string; depth: number }[] = [];
  const deepAbut: { a: string; b: string; depth: number }[] = [];
  const softSkipped = LANDMARKS.filter((l) => l.soft).map((l) => l.id);
  let worst = 0;
  let worstAbut = 0;
  for (let i = 0; i < LANDMARKS.length; i++) {
    for (let j = i + 1; j < LANDMARKS.length; j++) {
      const a = LANDMARKS[i];
      const b = LANDMARKS[j];
      // Gardens, hills and the island are landscape, not masonry.
      if (a.soft || b.soft) continue;
      // Divide the precinct margin back out: two precincts may touch, two buildings may not.
      const ab: Obb = { x: a.x, z: a.z, hw: a.hw / PRECINCT, hd: a.hd / PRECINCT, rot: a.rot };
      const bb: Obb = { x: b.x, z: b.z, hw: b.hw / PRECINCT, hd: b.hd / PRECINCT, rot: b.rot };
      const together = a.complex !== undefined && a.complex === b.complex;
      if (together) {
        const hit = obbOverlap(ab, bb, 0);
        if (!hit) continue;
        const rec = { a: a.id, b: b.id, depth: +hit.depth.toFixed(2) };
        if (hit.depth > ABUT_DEPTH) deepAbut.push(rec);
        else abutments.push(rec);
        worstAbut = Math.max(worstAbut, hit.depth);
        continue;
      }
      // Different complexes: the seven-metre street is owed, not merely non-intersection.
      const hit = obbOverlap(ab, bb, STREET_GAP);
      if (!hit) continue;
      pairs.push({ a: a.id, b: b.id, depth: +hit.depth.toFixed(2) });
      worst = Math.max(worst, hit.depth);
    }
  }
  return {
    ok: pairs.length === 0 && deepAbut.length === 0,
    count: pairs.length,
    worst: +worst.toFixed(2),
    pairs,
    abutments,
    deepAbut,
    worstAbut: +worstAbut.toFixed(2),
    softSkipped,
  };
}


/**
 * Ids the survey knows about, whatever the frame did with them.
 *
 * **The distinction this draws is load-bearing.** A rule naming an id that is not in `ROME` at
 * all is a typo and always a fault. A rule naming an id that *is* in `ROME` but is not placed
 * has been ruled out by the frame — at `KZ` = 0.35 six rows fall past the +Z edge (see
 * `layout.ts:offMapSouth`) — and is not a fault about the plan. Reporting the two the same way
 * is how a real typo gets read as expected noise and ignored, so they are counted separately
 * and the off-map skips are printed with their names.
 */
const SURVEY_IDS: ReadonlySet<string> = new Set(ROME.map((m) => m.id));

export function assertTopology(): {
  ok: boolean;
  checks: number;
  offMapSkips: number;
  skipped: string[];
  failures: string[];
} {
  const by = new Map(LANDMARKS.map((l) => [l.id, l]));
  const failures: string[] = [];
  const skipped: string[] = [];
  /** True if every id in the rule is a real survey row but at least one is not on this map. */
  const offMap = (...ids: string[]): boolean => {
    if (!ids.every((id) => SURVEY_IDS.has(id))) return false;
    return ids.some((id) => !by.has(id));
  };
  let checks = 0;
  for (const t of TOPOLOGY) {
    const ids = t.rule === 'between' ? [t.a, t.b, t.c] : [t.a, t.b];
    if (offMap(...ids)) {
      skipped.push(`${t.rule}(${ids.join(', ')})`);
      continue;
    }
    checks++;
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
  return { ok: failures.length === 0, checks, offMapSkips: skipped.length, skipped, failures };
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

export function assertHillRing(): {
  ok: boolean;
  checks: number;
  offMapSkips: number;
  skipped: string[];
  failures: string[];
} {
  const by = new Map(LANDMARKS.map((l) => [l.id, l]));
  const survey = new Map(ROME.map((m) => [m.id, m]));
  const hubReal = survey.get('palatine');
  const failures: string[] = [];
  if (!hubReal) return { ok: false, checks: 0, offMapSkips: 0, skipped: [], failures: ['no palatine in the survey'] };

  /**
   * **The hub is the *projected* Palatine, not the placed one, and that is stricter.**
   *
   * At `KZ` = 0.35 the Palatine is past the +Z edge and is not built (`layout.ts:offMapSouth`),
   * so there is no placement to read a hub from. Rather than let this check go dark — a dark
   * check is `MAP-METHOD.md` rule 6's whole complaint — the hub is `worldOf(e, n)` of the
   * Palatine's own survey row, which exists whether or not anything stands there.
   *
   * That is an improvement on what this used to do rather than a workaround for it. The check
   * claims to grade *"that the projection and the overlap solver preserved the real angular
   * order"*, and it used to measure every bearing from wherever the resolver had pushed the
   * Palatine to — up to 130 world metres from its survey position — so the reference moved with
   * the thing being graded. It does not now.
   */
  const hub = worldOf(hubReal.e, hubReal.n);

  // Ring members the frame put off this map are skipped by name and counted, never silently.
  const skipped = HILL_RING.filter((id) => !by.has(id));
  // Expected order: sorted by the *real* bearing from the Palatine.
  const ring = HILL_RING.filter((id) => by.has(id))
    .map((id) => {
      const l = by.get(id)!;
      const m = survey.get(id)!;
      // Real bearing, degrees clockwise from north, in the survey's own east/north frame.
      let real = (Math.atan2(m.e - hubReal.e, m.n - hubReal.n) * 180) / Math.PI;
      if (real < 0) real += 360;
      return { id, real, world: worldBearing(hub.x, hub.z, l.x, l.z) };
    })
    .sort((a, b) => a.real - b.real);

  /**
   * **A shortest-turn test cannot tell a 213° arc from a 147° inversion, and this used to be
   * one.** The bug was latent for as long as the ring had all eight members, because no two
   * adjacent-in-real-order members were then more than 180° apart. `KZ` = 0.35 takes the Caelian
   * and the Aventine off the map, which opens a **209°** real gap between the Baths of Titus and
   * the Janiculum — and the old test normalised the corresponding 213° world gap to −147° and
   * reported the ring as out of order. The plan was fine; the instrument was wrong, and it was
   * wrong in the direction that matters: it would have failed a correct build.
   *
   * So the comparison is between the **forward** turn in world space and the **forward** turn in
   * the survey, both taken the same way round. An inversion is a step the survey says to take
   * the short way and the world takes the long way. That is unambiguous at any gap size.
   */
  const fwd = (deg: number): number => ((deg % 360) + 360) % 360;
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    const worldFwd = fwd(b.world - a.world);
    const realFwd = fwd(b.real - a.real);
    // Tolerance. The map inflates every bearing toward east-west — a real 40° becomes 51°
    // under a 1.45:1 frame — and the two things pinned hardest, the Castra Praetoria at the
    // east edge of the heightfield and the Baths of Trajan wedged against it, land within
    // 13° of each other in the wrong order. This check exists to catch a hill on the wrong
    // *side* of the city, which is what makes a plan unrecognisable; a degree-level
    // inversion between two complexes in the same quarter is not visible in any frame — so a
    // backward step of up to `RING_TOLERANCE` is allowed and anything past it is not.
    const inverted = worldFwd > 180 && realFwd < 180 && 360 - worldFwd > RING_TOLERANCE;
    if (inverted) {
      failures.push(
        `hill ring out of order: ${a.id} (${a.world.toFixed(0)}°, real ${a.real.toFixed(0)}°) ` +
          `then ${b.id} (${b.world.toFixed(0)}°, real ${b.real.toFixed(0)}°) — ` +
          `the survey turns ${realFwd.toFixed(0)}° forward and the world turns ` +
          `${(360 - worldFwd).toFixed(0)}° back`
      );
    }
  }
  return {
    ok: failures.length === 0,
    checks: Math.max(0, ring.length - 1),
    offMapSkips: skipped.length,
    skipped,
    failures,
  };
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

// ---------------------------------------------------------------------------
// assertRomeFrame — ROME-FABRIC.md §4.1's post-build sanity checks
// ---------------------------------------------------------------------------

/**
 * **`CARTHAGE.md` §2.5's tail, for Rome, and instrumented this time.**
 *
 * Carthage's method ends its survey table with four numbers — 642 m of approach, 418 m of city
 * depth, 231 m from the Byrsa to the shore, 1,984 m of modelled wall — under the heading *"how
 * you find out the build went wrong while it is still cheap to fix."* `ROME-FABRIC.md` §1.1
 * step 4 then records the finding that matters about them: **they were never implemented.**
 * Grepping `418`, `642`, `231` and `1984` across `tools/probe-carthage*.mjs` returns zero hits.
 * The one part of the Carthage method that is about the whole map rather than one system is the
 * part nothing ever measured.
 *
 * This is Rome's version, and it is printed at every boot and published on `CityChecks` for the
 * same reason `assertRomeSection` is: *"a build-time `console.warn` is invisible to a probe and
 * an exception takes the page down… prose does not run."*
 *
 * ## Why the pending rows are here and not left out
 *
 * `MAP-METHOD.md` §3's verdict on the previous Rome attempt is the reason this type has a
 * `pending` field at all: *"every acceptance measurement in `ROME.md` §15 was about the wall,
 * the ground or the survey, and not one was about whether the city looked like Rome. So the
 * fabric was never graded, so it drifted."* A 2,764-line design document did not prevent that,
 * because the document had the same blind spot.
 *
 * So the fabric's measurements are written down **now**, in phase 1, before there is any fabric
 * to grade, with the value they currently have and the phase that is supposed to close them.
 * A check with a number and an owner is hard to forget. A check that does not exist yet is
 * exactly what got forgotten last time. `pending` rows are printed, are excluded from `ok`, and
 * name the phase — so the boot line reads as "not yet" rather than as either a pass or a fault.
 */
export interface RomeFrameCheck {
  name: string;
  /** What was measured, in world metres or as a count. */
  value: number;
  /** What it has to be. `null` where the check is a report rather than a target. */
  target: string;
  ok: boolean;
  /** Non-null means this cannot pass yet, and names the phase that closes it. */
  pending: string | null;
  detail: string;
}

export interface RomeFrame {
  kx: number;
  kz: number;
  anisotropy: number;
  gateX: number;
  gateZ: number;
  /** Survey rows the frame put past the +Z edge, by name. The accepted cost, made visible. */
  offMap: string[];
  checks: RomeFrameCheck[];
  faults: string[];
}

/**
 * The attacker's own deployment z, restated rather than imported from `sim/`.
 *
 * `city/` may not depend on `sim/`, and `assertRomeSection`'s `WALK_STEP_OVER` comment gives the
 * other half of the reason: *"this is an acceptance target rather than a shared input — the
 * instrument states what it is grading against so a source that drifts measures as wrong instead
 * of as itself."*
 */
const GERMAN_DEPLOY_Z = -196;

/** Real cross-street pitch in the Campus Martius, metres. `ROME-FABRIC.md` §4.3. */
const REAL_CROSS_STREET = [50, 90] as const;
/** A true-depth insula plus two frontages, world metres. §4.3, `ROME.md` §6.4. */
const INSULA_NEEDS = 30;

export function assertRomeFrame(): RomeFrame {
  const checks: RomeFrameCheck[] = [];
  const add = (
    name: string,
    value: number,
    target: string,
    ok: boolean,
    detail: string,
    pending: string | null = null
  ): void => void checks.push({ name, value, target, ok, pending, detail });

  const surveyById = new Map(ROME.map((m) => [m.id, m]));
  const placed = new Map(LANDMARKS.map((l) => [l.id, l]));

  // ---- 1. the approach ---------------------------------------------------
  // §4.1 check 1: unchanged at any KZ, because GATE_Z is the fixed point of
  // `roadCentreX(crestZAt(x))` and does not depend on the projection.
  const approach = GATE_Z - GERMAN_DEPLOY_Z;
  add(
    'approach: attacker deployment to the Porta Flaminia',
    approach,
    '>= 700 m, and invariant in KZ',
    approach >= 700,
    `${approach.toFixed(1)} m from z ${GERMAN_DEPLOY_Z} to the gate at z ${GATE_Z.toFixed(2)}`
  );

  // ---- 2. the front ------------------------------------------------------
  // §4.1 check 2. Unchanged because KX is unchanged; if any of these three moves, something
  // other than the projection changed too, and that is what this is for.
  add(
    'front: modelled length, NW angle to Castra NE',
    WALL_LENGTH,
    '1332.5 m +/- 1',
    Math.abs(WALL_LENGTH - 1332.54) <= 1,
    `x ${WALL_X_MIN.toFixed(2)} .. ${WALL_X_MAX.toFixed(2)}`
  );
  const pitch = WALL_LENGTH / BAY_COUNT;
  add(
    'front: bay pitch',
    pitch,
    '37.015 m +/- 0.05 over 36 bays',
    Math.abs(pitch - 37.015) <= 0.05 && BAY_COUNT === 36,
    `${BAY_COUNT} bays at ${pitch.toFixed(3)} m`
  );

  // ---- 3. the Campus Martius's depth ------------------------------------
  // §4.1 check 3. **Measured on the projection, not on the placement**, because the placement
  // is still the resolver's until phase 2 deletes it and this number is about the frame.
  const capitol = surveyById.get('temple-jupiter');
  const bandDepth = capitol ? worldOf(capitol.e, capitol.n).z - GATE_Z : 0;
  add(
    'Campus Martius depth, Porta Flaminia to the Capitol',
    bandDepth,
    '>= 650 world m (it was 450 at KZ 0.222)',
    bandDepth >= 650,
    `${bandDepth.toFixed(1)} world m for ${(bandDepth / KZ).toFixed(0)} real m of city`
  );

  // ---- 4. the arithmetic that makes a grid possible ---------------------
  // §4.3's decisive number, and the strongest single argument for the projection change:
  // at KZ 0.222 a true-depth insula fitted between two projected cross-streets at no point
  // in the real 50-90 m range.
  const pitchLo = REAL_CROSS_STREET[0] * KZ;
  const pitchHi = REAL_CROSS_STREET[1] * KZ;
  const pitchMed = 70 * KZ;
  add(
    'projected cross-street pitch, median',
    pitchMed,
    `>= ${INSULA_NEEDS - 8} world m, so a true-depth insula fits`,
    pitchMed >= INSULA_NEEDS - 8,
    `real ${REAL_CROSS_STREET[0]}-${REAL_CROSS_STREET[1]} m projects to ${pitchLo.toFixed(1)}-${pitchHi.toFixed(1)} m; ` +
      `an insula needs ${INSULA_NEEDS} m`
  );

  // ---- 5. every monument stands where the survey puts it ----------------
  // §4.1 check 5, and the check that proves the resolver is gone. **It is gone**, so for a row
  // placed by the affine map alone this is no longer a measurement of anything but a typo: with
  // `place()` returning `worldOf(e, n)` unmodified, the only way it can be non-zero is the z
  // clamp, which check 8 below reports separately. It was 398.9 m at phase 1.
  //
  // **And that is exactly why the version of this check that shipped was measuring nothing.**
  // It skipped `farBank` and `onRiver` rows — the only rows whose x does *not* come from the
  // affine map, which is to say the only rows that can be displaced at all — and then reported
  // *"worst 0.0 m"* over the 27 rows that cannot move. A ground judge found the Janiculum Ridge
  // standing **404 world metres** from its own survey row, having moved **715 m** between phase 1
  // and phase 2, under that headline. `MAP-METHOD.md` rule 16 is the rule it broke: *a check whose
  // exclusion list is exactly the rows a mechanism touches is a measurement of that mechanism's
  // absence.*
  //
  // So the population is now every placed row, split by how it was placed and **both halves
  // printed with their counts and their names**:
  //
  //  - `affine` — x and z both from `worldOf`. Target 0.5 m, and it is a proof.
  //  - `override` — `farBank` / `onRiver`, whose x is taken from the terrain's channel on
  //    purpose, and `atWall`, whose z is taken from the curtain the monument's own wall belongs
  //    to. Comparing those against `worldOf()` is not a fault, it is the mechanism working, so
  //    what is *reported* is the departure the override chose, by name, every run, and what is
  //    gated is its size: a row moved further than `OVERRIDE_MAX` is not "placed against the
  //    river" or "placed on the wall", it is somewhere else. That bound is the whole lesson of
  //    the Janiculum, which the shipped check could not see at 404 m.
  const OVERRIDE_MAX = 120;
  let worstDrift = 0;
  let worstDriftId = '';
  let affineCount = 0;
  const overrides: { id: string; dx: number; dz: number; why: string }[] = [];
  for (const l of LANDMARKS) {
    const m = surveyById.get(l.id);
    if (!m) continue;
    const w = worldOf(m.e, m.n);
    const dx = l.x - w.x;
    const dz = l.z - w.z;
    if (m.farBank || m.onRiver || m.atWall !== undefined) {
      overrides.push({
        id: l.id,
        dx,
        dz,
        why: m.onRiver ? 'onRiver' : m.farBank ? 'farBank' : 'atWall',
      });
      continue;
    }
    affineCount++;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > worstDrift) {
      worstDrift = d;
      worstDriftId = l.id;
    }
  }
  const worstOverride = overrides.reduce((a, o) => Math.max(a, Math.hypot(o.dx, o.dz)), 0);
  add(
    'every monument centre at worldOf(e, n)',
    worstDrift,
    '<= 0.5 m',
    worstDrift <= 0.5,
    `worst ${worstDrift.toFixed(1)} m (${worstDriftId || 'none'}) over ${affineCount} affine-placed row(s) ` +
      `— was 398.9 m before resolveOverlaps was deleted`
  );
  add(
    'declared placement overrides stay inside their bound',
    worstOverride,
    `<= ${OVERRIDE_MAX} m, over the farBank/onRiver/atWall rows`,
    worstOverride <= OVERRIDE_MAX,
    `${overrides.length} override row(s): ` +
      (overrides
        .map((o) => `${o.id} (${o.why}) dx ${o.dx.toFixed(0)} dz ${o.dz.toFixed(0)}`)
        .join('; ') || 'none') +
      ` — these are the rows check 5 above cannot see, and the Janiculum was 404 m out under it`
  );

  // ---- 6. nothing solid intersects anything solid -----------------------
  // §4.1 check 4. `assertNoFootprintOverlaps` is monument-vs-monument only and never looks at
  // an insula, which `ROME-FABRIC.md` §2.5 measures as the fault that let the others survive.
  // The whole-population version is `tools/probe-fabric.mjs`, external and going live in
  // phase 2; this row exists so the target is written down before there is anything to grade.
  //
  // **This row could not fail, and that was a bug rather than a policy.** `pending` was set
  // `fp.ok ? null : '…'` — non-null exactly when the check failed — and `faults` below filters on
  // `!c.ok && c.pending === null`. So a real monument-in-a-street regression rendered as PENDING
  // in the boot log and left `frame.faults` empty. The `pending` note is about the *insula*
  // population this check does not cover, which is true whether or not the monument population
  // passes, so it belongs in the target string. The monument half gates.
  const fp = assertNoFootprintOverlaps();
  add(
    'monuments in different complexes keep the 7 m street',
    fp.count,
    '0 pairs; insulae are phase 5 and are graded by tools/probe-fabric.mjs, not here',
    fp.ok,
    `${fp.count} pair(s) short of the street, worst ${fp.worst.toFixed(1)} m; ` +
      `${fp.abutments.length} licensed abutment(s) inside a complex, deepest ${fp.worstAbut.toFixed(1)} m ` +
      `against the ${ABUT_DEPTH.toFixed(1)} m bound; ${fp.deepAbut.length} over it` +
      (fp.deepAbut.length ? ` (${fp.deepAbut.map((d) => `${d.a}/${d.b} ${d.depth}m`).join(', ')})` : '') +
      `; ${fp.softSkipped.length} soft row(s) skipped: ${fp.softSkipped.join(', ') || 'none'}`
  );

  // ---- 6b. the relation the survey asserts on the OTHER axis of the row --
  // Phase 2 proved 0 of 860 inverted *position* relations and everybody read it as covering the
  // ground. A survey row asserts two things about a building — where it is and how big it is —
  // and the placement preserved only the one the player cannot see. See `assertSizeOrder`.
  const so = assertSizeOrder();
  add(
    'monuments in one frame keep the size order the archaeology gives them',
    so.inverted,
    `0 inverted inside ${FRAME_RANGE} m at a ${(SIZE_DEADBAND * 100).toFixed(0)} % deadband`,
    so.ok,
    `${so.inverted} of ${so.relations} inverted` +
      (so.cappedInverted ? `, plus ${so.cappedInverted} held by a drawMax` : '') +
      (so.worst
        ? `; worst ${so.worst.big} vs ${so.worst.small} really ${so.worst.real.toFixed(2)}x drawn ${so.worst.drawn.toFixed(2)}x`
        : '') +
      `; drawMax rows: ${so.capped.join(', ') || 'none'}`
  );

  // ---- 7. the fabric's own two numbers ----------------------------------
  // §4.1 checks 6 and 7. Written down at phase 1 on purpose. See this type's docstring.
  add(
    'roof coverage between street lines',
    0,
    '60-70 % per region, against the AGEA 2012 orthophoto',
    false,
    'not measured: the fabric is not rebuilt yet',
    'phase 5, graded per region and not as a city mean'
  );
  add(
    'the Campus Martius quarter builds its frontages',
    0,
    '>= 60 % (it was 2.9 %: 17 buildings from 593 frontages)',
    false,
    'not measured: the fabric is not rebuilt yet',
    'phase 5'
  );

  // ---- 8. the accepted cost, by name ------------------------------------
  /**
   * **Five, and `ROME-FABRIC.md` §4.5 predicted six.** The sixth was the Janiculum ridge, and it
   * survives — not by anyone saving it, but because it is `farBank`: its x comes from
   * `FAR_BANK(z)` off the terrain's own channel rather than from the affine map, so
   * `offMapSouth` does not apply to it and `place()`'s clamp holds it at `CITY_Z_MAX`. The ridge
   * projects to z 1382 and stands at z 1374, eight metres north of where the survey puts it, on
   * a `soft` landscape footprint 520 m long. Eight metres on a half-kilometre ridge is beneath
   * anything a camera can see, so it is kept and the clamp is reported rather than hidden — see
   * the `clamped` row below, which is the general form of the same question.
   */
  const offMap = ROME.filter((m) => !placed.has(m.id)).map((m) => m.id);
  add(
    'monuments past the +Z edge',
    offMap.length,
    '5, agreed in writing: palatine, circus-maximus, aventine-temples, baths-caracalla, ' +
      'caelian-villas (the Janiculum is far-bank and survives, clamped 8 m)',
    offMap.length === 5,
    offMap.length === 0 ? 'none' : offMap.join(', ')
  );

  /**
   * **How far `place()`'s clamp had to move anything it kept.**
   *
   * `place()` clamps every monument's z into `[CITY_Z_MIN(x) + 20, CITY_Z_MAX]`. That clamp is
   * what `offMapSouth` exists to pre-empt: without it, raising `KZ` would have stacked six
   * monuments on the single line z = 1374 instead of removing them. This row is the residual —
   * whatever the clamp still had to do to the rows it kept — so a clamp that starts quietly
   * doing real work again is a printed number rather than a surprise in a screenshot.
   */
  let worstClamp = 0;
  let worstClampId = '';
  let clampPop = 0;
  const clampSkipped: string[] = [];
  for (const l of LANDMARKS) {
    const m = surveyById.get(l.id);
    if (!m) continue;
    // Far-bank and on-river rows take their x from the channel, so only z is comparable — and z
    // is what this loop compares, which is why they belong in the population rather than out of
    // it. (The guard that used to sit here tested for them and then did nothing, so they were
    // measured anyway; the behaviour is unchanged and the intent is now written down.)
    //
    // **`atWall` rows are a different case and are genuinely excluded.** Their z is *deliberately*
    // moved off the projection — the Castra Praetoria is placed by the north wall Aurelian built
    // into the curtain, 31 m south of `worldOf` — so `|idealZ − worldOf().z|` for those rows
    // measures the override, not the clamp, and reporting it here would make a working mechanism
    // read as a frame fault. They are gated by the override check above, which bounds exactly
    // this quantity at 120 m, and they are named here so the exclusion is counted rather than
    // assumed (`MAP-METHOD.md` rule 16).
    if (m.atWall !== undefined) {
      clampSkipped.push(l.id);
      continue;
    }
    clampPop++;
    const d = Math.abs(l.idealZ - worldOf(m.e, m.n).z);
    if (d > worstClamp) {
      worstClamp = d;
      worstClampId = l.id;
    }
  }
  add(
    'z clamp applied to a monument the frame kept',
    worstClamp,
    '<= 10 m, or the row belongs in offMapSouth instead',
    worstClamp <= 10,
    `worst ${worstClamp.toFixed(1)} m (${worstClampId || 'none'}) over ${clampPop} row(s); ` +
      `${clampSkipped.length} atWall row(s) excluded and gated by the override check instead: ` +
      `${clampSkipped.join(', ') || 'none'}`
  );

  const faults = checks.filter((c) => !c.ok && c.pending === null).map((c) => `${c.name}: ${c.detail}`);
  return {
    kx: KX,
    kz: KZ,
    anisotropy: KX / KZ,
    gateX: GATE_X,
    gateZ: GATE_Z,
    offMap,
    checks,
    faults,
  };
}
