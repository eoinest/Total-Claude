/**
 * probe-fabric — the acceptance gate for a city's plan. Does the fabric hold together, and
 * are its monuments the size the archaeology says they are?
 *
 * Runnable against any candidate city (`--map=`). It returns a verdict, not a report:
 * **zero intersecting footprints, every structure with its stated clearance, every sourced
 * monument within tolerance of its real published dimensions, nothing standing in a
 * carriageway and nothing standing inside the curtain.**
 *
 * ============================================================================
 * WHAT THIS COMPARES AGAINST, AND WHY THAT IS INDEPENDENT
 * ============================================================================
 *
 * This project's recurring failure is a check that compares something against itself: a
 * probe that derived a normal from a winding and then graded it against that winding, a
 * determinism gate that compared a tree against itself, six shipped features whose tests
 * could not fail. `docs/HANDOFF.md` states the rule as a standing one — *"A self-consistent
 * instrument can never fail. Compare against something outside the thing being checked."*
 *
 * A gate that reads the layout's own intentions will pass a broken city as happily as a good
 * one. So this file never asks the city whether the city is right. Its rulers are:
 *
 *  1. **Published dimensions, typed into this file, with a citation per figure.**
 *     `PUBLISHED` below is literal numbers from the archaeological literature. It is NOT
 *     read from `src/city/rome/survey.ts` or `src/city/carthage/layout.ts` — those are the
 *     *inputs* to the thing being measured, and grading a build against its own survey only
 *     re-derives `PRECINCT × PLAN_SCALE`; it can never report a wrong dimension. Every row
 *     carries `src`; rows I could not source carry `conf: 'unsourced'` and are reported
 *     without being gated on, never quoted as fact.
 *
 *  2. **The vertices that will actually be rasterised.** Monument, street and wall extents
 *     are read from `position` on the baked `BufferGeometry` under the live scene's `city`
 *     root. A plan rectangle is an intention; a vertex is what the player sees. Where the
 *     two disagree the probe prints both, and the fidelity gate has to pass on both.
 *
 *  3. **Its own polygon arithmetic.** Overlap is measured as **area** — Sutherland-Hodgman
 *     clipping of two convex rectangles, then the shoelace. The probe deliberately does not
 *     call `obbOverlap`, `assertNoFootprintOverlaps` or `assertNoFabricOverlaps`; those are
 *     the functions whose "zero overlaps" verdict is in question, and an instrument that
 *     borrows the defendant's arithmetic restates the defendant's answer. `clipArea`,
 *     `satDepth` and `polyGap` here are written from scratch.
 *
 *  4. **Scale-free geometry.** The strongest fidelity test needs no knowledge of the map's
 *     plan compression at all: a building's **aspect ratio** is invariant under uniform
 *     scaling, so `long/short` measured off the model must equal `long/short` published,
 *     whatever `PLAN_SCALE` is. The absolute-scale test is then made independent of any repo
 *     constant by grading each monument's modelled/published ratio against the **median
 *     ratio of its own cohort**: a map may compress plan uniformly, but it may not compress
 *     one monument differently from another.
 *
 *  5. **Two producers, cross-checked.** Monument-versus-wall and monument-versus-street are
 *     read as one producer's output against another's — the monument builder never sees the
 *     wall builder's stone — and corroborated on the drawn geometry of both. The block
 *     orientation test is the same idea and the sharpest instance of it: a block's angle is
 *     graded against **the road graph, which is upstream of the block generator** and does not
 *     know the fabric exists.
 *
 *  6. **A mathematical property, which is the only ruler that cannot rot.** Layout regions
 *     must *partition* the ground, so claimed area over available area is **1.00** — not a
 *     tuned constant, a definition. The denominator is sampled from the terrain and the built
 *     circuit and has the monuments' own ground subtracted out of it, so nothing the region
 *     list publishes can flatter it.
 *
 * ---------------------------------------------------------------------------
 * THE ONE BLIND SPOT, STATED RATHER THAN PAPERED OVER
 * ---------------------------------------------------------------------------
 *
 * **The georeferenced plates cannot be used as a machine ruler for footprints, and it is not
 * because they are missing.** `reference/rome-plans/` holds the Lanciani 1901 georeferenced
 * raster (EPSG:3004, fitted to 1.26 m worst-case over 7 km per `ASSETS.md` §8), the AGEA 2012
 * orthophoto, and the SITAR vector of the *Forma Urbis Severiana*. Two facts about them:
 *
 *  - **A git worktree cannot see them.** `reference/` is gitignored local-only copyrighted
 *    material, so it exists in the main checkout and in no worktree. An agent working in a
 *    worktree will conclude the plates do not exist. They do. Copy or symlink the directory
 *    in before claiming otherwise — this probe's first draft got that wrong.
 *  - **The only machine-readable one carries no names.** `sitar-forma-urbis-severiana-
 *    vector-EPSG4326.geo.json` is 8,150 features whose entire property set is
 *    `{admapkey, layer, path}` — fragments and interior wall lines, with no monument
 *    identification at all. So a probe cannot read "the Circus Maximus is 621 × 118" off it;
 *    that would need a hand-digitised outline per monument. The rasters need digitising too.
 *
 * So the machine ruler for footprint fidelity is `PUBLISHED`, and the plates stay a **visual**
 * comparator through `src/city/overlay.ts`'s plan view. That is a real limitation of this
 * gate: it can prove a footprint is the wrong SIZE and it cannot prove it is in the wrong
 * PLACE. The independent instrument for *position* is a digitised control point per monument
 * in the survey frame, and it does not exist yet. Recorded in `docs/MAP-METHOD.md` §3 as a
 * known blind spot, because a blind spot on the record is cheaper than a false pass.
 *
 * ============================================================================
 * THE GATE
 * ============================================================================
 *
 * Twenty-five checks, each with its threshold as a named constant and the reasoning beside it.
 * The verdict is `n/<applicable>` and the exit code is non-zero on any failure, so this can sit
 * in a pre-merge gate for the city rebuild.
 *
 * ----------------------------------------------------------------------------
 * READ THIS BEFORE YOU READ THE SCORE. THE SCORE WENT DOWN ON PURPOSE.
 * ----------------------------------------------------------------------------
 *
 * `docs/CITY-GROUND-JUDGE.md` §11 adjudicated this file's twenty-one checks against the
 * landmark rework and its framing is the one to read the number with:
 *
 *   > **"5/21 -> 7/25, failing checks 16 -> 18, every added check failing today. The test is
 *   > not the score; it is whether the gate can fail for reasons it could not before."**
 *
 * Measured, both maps, this file as it stands:
 *
 *   | | before | after |
 *   |---|---|---|
 *   | Rome    | 5/21, 16 failing | **7/25, 18 failing** |
 *   | Carthage| 12/21, 9 failing | **13/22, 9 failing, 3 not applicable (G8c, G8d, G13b)** |
 *
 * The judge's prediction of 7/25 and 18 is exactly right and **its composition is not**: the
 * table has G15 passing and does not score G11, and the measurement has G11 passing and G15
 * failing. Two pairs are declared one complex and stand 3.1 m apart — inside G8c's own
 * no-man's-land — so the complex licences nothing and G15's second condition refuses them. A
 * check that licensed them anyway would be the exemption with one more indirection.
 *
 * Do not read the changed denominator as a regression and revert it: **the gate now fails for
 * five reasons it was blind to** — a declared complex that is not joined, a declared complex
 * that is not one piece of fabric, a monument drawn at a fifth of its published plan, a pair of
 * monuments whose size order is inverted against the archaeology, and masonry under the Tiber.
 * And it stops failing in two places where it was wrong about Rome rather than about the build.
 *
 * **Every check this pass touched has been shown going red, on purpose.** Seven of the eight do
 * it on live data: G8c, G8d, G13a, G13b, G15 and G22 on Rome, G8 on Carthage. The eighth — G11 —
 * and the limbs live data cannot reach (G13a's upper band, G22's stale-licence limb, and G8c/G8d
 * on a map that declares no complexes) are proved by named `--inject` runs that perturb this
 * file's own reference data and exit non-zero whatever they find.
 *
 * `--inject=complex-invent` on Carthage is worth running once for its own sake: it declares one
 * pair a complex, G8c and G8d go red, **and G8 goes green on the same run** — 1 of 45 pairs short
 * becomes 0 of 44. That is the whole argument of §11.1 in one table, and it is what "treat a
 * complex as one owner" would have done to all twenty-one rows.
 *
 * What changed, and why, one line each (the argument is in `CITY-GROUND-JUDGE.md` §11 and the
 * rule is `MAP-METHOD.md` §1 rule 18):
 *
 *   - **G8 keeps its 7 m and loses the population it was wrong about.** A monument pair in one
 *     declared `complex` is not two precincts facing each other across a missing street; the
 *     Basilica Ulpia stands *inside* Trajan's Forum. G8 now asks its question of pairs in
 *     DIFFERENT complexes, which is exactly the population its own comment is right about.
 *   - **G8c and G8d are the price of that, and they are stricter than what they replace.** The
 *     repair the builder asked for — "treat a complex as one owner" — would have removed the
 *     same 21 rows from G1, G8 and G15 at once and left the 2.4 m joint bound enforced only by
 *     an offline script. That is an exemption wearing a relation's clothes. So declaring a
 *     complex now TAKES ON an obligation: its members must be *joined* (G8c) and the complex
 *     must be *one connected piece* (G8d). A row put in a complex to dodge a 3 m gap fails
 *     immediately.
 *   - **G13 is retired and replaced by two checks with an external ruler.** Its premise was one
 *     uniform plan compression and the design abolished that. The replacement the builder
 *     offered — grade the built extent against `draw x len` — is `draw` grading itself, which
 *     is the one failure mode this file's header exists to forbid. G13a is an absolute band
 *     against `PUBLISHED`; G13b is the check nobody had: the SIZE ORDER between two monuments.
 *     The previous phase proved 0 of 860 inverted *position* relations and everybody read that
 *     as covering the ground. Nothing counted inverted *size* relations, and the Castra
 *     Praetoria is drawn smaller than a mausoleum it is 4.6x the length of.
 *   - **G22 is the water check, and it is not shipped without its exclusion accounting.** A
 *     check born blind to a mechanism measures that mechanism's absence (`MAP-METHOD.md` rule
 *     16), and Carthage's Cothon is 325 m of *water* that would fail a naive test. So every
 *     excluded row is named, counted and gated against a typed-in list.
 *   - **G11 gains the off-frame category the same way.** Five survey rows are off this map's
 *     +Z edge by a decision the owner took in writing. The category is gated against those five
 *     BY NAME, so a sixth row falling off the frame fails rather than joining a category.
 *
 * **Not applicable is a third outcome, and it is not a pass.** A check whose population is
 * empty on a map — G8c and G8d on Carthage, which declares no complexes — is reported `n/a`
 * with the reason, is excluded from that map's denominator, and can never be mistaken for a
 * green light. `MAP-METHOD.md` rule 12: a statistic whose sample has collapsed returns a
 * confident number rather than an error, so every figure below prints its own sample size and
 * G13b refuses rather than reports when it has fewer than `SIZE_ORDER_MIN_PAIRS` relations.
 *
 * **It gates BOTH of Rome's two independent faults.** `docs/ROME-FABRIC.md` §2 establishes
 * that the fabric is broken twice over: monuments that must intersect because positions
 * compress 10.2x areally while footprints compress 2.07x (G1-G3, G12, G13a-G13b), *and* seventeen
 * layout regions claiming 266% of the city, each laying its own hash-rotated lattice
 * (G18-G21). The second one is invisible to every overlap test ever written on this project,
 * because contested ground is handed to whichever quarter was planned first and the buildings
 * come out disjoint. A gate that only measured intersection would pass a quilt. In outline:
 *
 *   G1-G3    no footprint intersects another — monument/monument, monument/building,
 *            building/building. Measured as AREA, and split three ways so a composite
 *            structure's own joints are not counted as faults (see `ABUT_DEPTH_M`).
 *   G4-G5    nothing stands in a carriageway. G4 from the plan, G5 from the drawn road.
 *   G6-G7    nothing stands inside the curtain, a tower or a gate. Plan, then drawn stone.
 *   G8-G10   every class keeps its stated clearance: a street between monuments, the XII
 *            Tables' *ambitus* between a monument and a house, and no negative gap anywhere.
 *   G8       ... and G8 asks it of monuments in DIFFERENT declared complexes only.
 *   G8c-G8d  a declared `complex` costs something to declare: its pairs must be JOINED
 *            (nested or abutting, never a no-man's-land in `(ABUT_DEPTH_M, CLEAR_MON_MON)`),
 *            and the complex as a whole must be ONE CONNECTED PIECE of fabric under that
 *            relation. This is the check the exemption would have hidden: three of Rome's
 *            five complexes are not one piece at any threshold under 20 m, and the Theatre of
 *            Pompey stands 17.4 m from its own porticus post scaenam.
 *   G11      every sourced monument is present, the anachronisms are absent, and the rows
 *            excluded for being off this map's frame are exactly the agreed five, by name.
 *   G12      every sourced monument has its published ASPECT RATIO. Scale-free.
 *   G13a     every gated monument's drawn long dimension is inside an ABSOLUTE band against
 *            its published figure. The last thing between a 0.57 Colosseum and a 0.19 one.
 *   G13b     no pair of monuments has its SIZE ORDER inverted against the published pair.
 *   G14-G16  the stone the player sees is the footprint the game collides with, and it does
 *            not stand in anybody else's plot. Read from vertices; no plan involved. G15
 *            licenses a trespass only inside one complex, only where the pair is joined, and
 *            only as deep as a party wall.
 *   G17      no quarter reports itself unable to build.
 *   G22      no structure's footprint stands below the water surface, with every excluded row
 *            named and the exclusion list gated.
 *   G18-G19  the layout REGIONS partition the ground — no overlapping pair, and claimed area
 *            over available ground = 1.00. This is the second, independent fault
 *            (`docs/ROME-FABRIC.md` §2.3): seventeen rectangles claiming 266% of the city.
 *            No footprint-overlap test can see it, because contested ground is handed to
 *            whichever quarter was planned first and the buildings come out disjoint.
 *   G20-G21  the fabric's GRAIN comes from the street network, not from `hash2`. A block's
 *            orientation against the street that bounds it, and against its own neighbours.
 *   G23      the ground between street lines is BUILT, at the AGEA orthophoto's 60-70%. Phase
 *            5. The denominator is the whole difficulty and it comes from the scene: region,
 *            minus carriageway, minus monument precinct — because a fabric generator is not
 *            responsible for the ground the Baths of Trajan stand on, and 21% of Rome's
 *            ground between street lines is monument precinct.
 *   G24      no block builds NOTHING while it still has room for a house. The other half of
 *            G23: a mean coverage can be met with a third of the city empty and the rest
 *            solid. A block's own inset polygon minus monument, carriageway and water is the
 *            ground it could have used; a block with a house's worth of it and no house is
 *            the failure, and a garden quarter is the one exclusion, counted and gated.
 *
 * **Today's Rome fails it comprehensively, and that is the point.** Those numbers are the
 * "before" column the rebuild is measured against.
 *
 *   TC_NO_HMR=1 node tools/probe-fabric.mjs --map=campus-martius --port=5951
 *   TC_NO_HMR=1 node tools/probe-fabric.mjs --map=carthage       --port=5951
 *   ... --shots            five frames, one per fault class, biggest first
 *   ... --json=<path>      the whole record
 *   ... --no-gate          always exit 0 (for taking a "before" reading in CI)
 *   ... --inject=a,b       break one of the probe's own inputs and prove a check goes red.
 *                          Never a clean run: an injected run always exits non-zero, and exits
 *                          3 if a check that was supposed to go red did not.
 *
 * Port 5173 belongs to the owner; use the 5900s. This tool **never reuses a server it did
 * not start** — six agents run vite on this box and a reused port serves another branch's
 * modules, which is how a probe grades a tree that is not the one it is standing in. The first
 * draft of this file did reuse one, landed on another worktree's vite, and failed with
 * `Failed to fetch dynamically imported module` — which reads as a code fault and is not one.
 * It spawns its own with `--strictPort` and a `TC_VITE_CACHE_DIR` under `.vite/` in this
 * worktree, because worktrees symlink `node_modules` at the shared checkout and vite's default
 * `node_modules/.vite` would be one dependency cache written by as many vites as there are
 * agents running a gate.
 */
import { launchBrowser, startVite } from './lib/browser-budget.mjs';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const MAP = args.get('map') ?? 'campus-martius';
const PORT = Number(args.get('port') ?? 5951);
const TIER = args.get('quality') ?? 'high';
const SHOTS = args.get('shots') === 'true';
const NO_GATE = args.get('no-gate') === 'true';
/**
 * `--inject=a,b,c` — **the instrument's own self-test, and it is not optional equipment.**
 *
 * This project has shipped several checks that had never gone red, and a check that has never
 * gone red is not a check. Six of the twenty-five below fail on Rome today, which proves those
 * six; the rest pass, and a passing check proves nothing about itself. So each injection
 * deliberately breaks ONE input to the gate — always the probe's own reference data or its own
 * thresholds, never the game, never `src/` — and names the check that must go red as a result.
 *
 * `node tools/probe-fabric.mjs --map=carthage --inject=complex-invent,water-no-exclusions`
 *
 * An injected run prints a banner, tags every check it expects to flip, records the list in the
 * JSON, and **always exits non-zero**, so an injected run can never be mistaken for a clean one
 * in a log or in CI.
 */
const INJECT = (args.get('inject') ?? '').split(',').map((v) => v.trim()).filter(Boolean);
const INJECTIONS = {
  'off-frame-sixth': {
    hits: 'G11',
    what: 'adds `pantheon` — a row that IS on the map — to OFF_FRAME_AGREED, so the agreed '
      + 'exclusion list no longer matches the build. Proves the off-frame category is gated on '
      + 'MEMBERSHIP and not on length, which is the condition CITY-GROUND-JUDGE.md §11.4 '
      + 'attached to endorsing it.',
  },
  'off-frame-drop': {
    hits: 'G11',
    what: 'drops the first agreed off-frame name, so the build excludes a row the probe has not '
      + 'agreed to. Proves a SIXTH row falling off the frame fails rather than joining a '
      + 'category — MAP-METHOD.md rule 16.',
  },
  'water-no-exclusions': {
    hits: 'G22',
    what: 'empties WATER_EXPECTED. Proves the exclusion accounting is load-bearing rather than '
      + 'decorative: without it G22 fails Carthage on thirty-three harbour solids that are '
      + 'water by definition, which is exactly a check measuring a mechanism\'s absence.',
  },
  'water-stale-licence': {
    hits: 'G22',
    what: 'grants a water licence to a structure that publishes solids and is dry. Proves the '
      + 'stale-licence limb fires: an exclusion list that describes a city that has moved is '
      + 'rule 13\'s check gone dark.',
  },
  'band-ceiling': {
    hits: 'G13a',
    what: 'halves every gated PUBLISHED dimension, so every drawn/published ratio doubles. '
      + 'Proves the UPPER limb of the absolute band fires — nothing on either map exceeds it '
      + 'today, so it is the one limb of G13a that live data cannot prove.',
  },
  'size-order-relax': {
    hits: 'G13b',
    what: 'sets SIZE_ORDER_MIN_RATIO to 1.0 and SIZE_ORDER_MIN_PAIRS to 1. Proves BOTH halves '
      + 'of G13b at once on Carthage: the refusal is a fact about the population (two harbours '
      + 'published 1.6 % apart assert no order), and the moment the check is told to grade that '
      + 'noise it goes red on it.',
  },
  'complex-invent': {
    hits: 'G8c, G8d',
    what: 'declares the closest pair of monuments in DIFFERENT complexes to be one complex. '
      + 'Proves G8c and G8d are a population fact rather than dead code on a map that declares '
      + 'no complexes — and demonstrates the hazard the adjudication refused, live: the pair '
      + 'leaves G8\'s population, so **G8 goes GREEN on the same run** that G8c and G8d go red. '
      + 'That is what "treat a complex as one owner" would have done to all twenty-one rows, '
      + 'and it is why the licence has to cost something. G8 going green here is the '
      + 'demonstration, not a miss, so it is not in `hits`.',
  },
};
for (const k of INJECT) {
  if (!(k in INJECTIONS)) {
    console.error(`[probe-fabric] unknown --inject=${k}. Known: ${Object.keys(INJECTIONS).join(', ')}`);
    process.exit(2);
  }
}
const JSON_OUT = args.get('json') ?? null;
const SHOT_DIR = path.join(ROOT, 'screenshots', 'probe-fabric');

if (PORT === 5173) {
  console.error("port 5173 is the owner's. Use the 5900s.");
  process.exit(2);
}

// ===========================================================================
// THRESHOLDS. Named, with the reasoning, because a gate whose numbers are
// inline literals is a gate nobody can argue with.
// ===========================================================================
const T = {
  /**
   * Area below which an intersecting pair is float noise rather than a fault, m².
   *
   * Two rectangles that share an edge can clip to a sliver of a few square centimetres
   * from rounding alone. 0.25 m² is a 50 cm square — smaller than one paving slab, and two
   * orders of magnitude below the smallest fault worth a sentence.
   */
  NOISE_M2: 0.25,

  /**
   * When two intersecting footprints are two PARTS OF ONE STRUCTURE rather than two
   * buildings in the same place: shallower than this, and covering less than `ABUT_FRAC`
   * of the smaller box.
   *
   * A composite structure is published to the obstacle set as several boxes — the Cothon's
   * quay is a 28-box polygonal ring, the Byrsa is a stack of terraces — and adjacent boxes
   * meeting at a chord joint necessarily overlap a little. Measured on Carthage, every one
   * of those 28 joints is **9.93 m2 at 2.09 m, 2.08% of the smaller box**, to the
   * centimetre, twenty-eight times: a signature, not a fault.
   *
   * A REAL collision between two monuments in a compressed plan is tens of metres deep —
   * measured on Rome at the projected positions, before its resolver runs: worst 64.69 m,
   * and 31 pairs averaging 1,559 m2. So the two populations are three orders of magnitude
   * apart and this discriminator cannot hide a genuine fault. Both counts are reported
   * either way; only the fault count is gated.
   */
  ABUT_DEPTH_M: 2.5,
  ABUT_FRAC: 0.05,

  /**
   * Clear ground a monument owes its neighbouring monument, metres.
   *
   * The narrowest thing this project is willing to call a street is a *vicus* at 8 m (men
   * in file, deliberately hostile to formations). 7 m is one metre under that: a monument
   * pair sharing a party wall fails, a genuinely tight service lane passes. Roman practice
   * agrees on the direction — a monumental precinct is entered from a street, not from
   * another precinct.
   *
   * **The threshold is unchanged and its POPULATION is corrected.** That last sentence is true
   * of Rome's free-standing precincts and false of its nested ones: the Basilica Ulpia and
   * Trajan's Column stand *inside* Trajan's Forum, and the Tabularium's facade *is* the Forum
   * Romanum's west wall. A gate with one relation where the city has three fails a correct
   * build for ever. So G8 asks for 7 m between monuments in DIFFERENT declared complexes, and
   * `CLEAR_MON_MON` is also the top of G8c's no-man's-land: inside one complex a pair must be
   * joined at `ABUT_DEPTH_M` or standing apart at `CLEAR_MON_MON`, and the open interval
   * between the two is the one thing a complex cannot mean.
   *
   * This is `MAP-METHOD.md` rule 18 and `CITY-GROUND-JUDGE.md` §11.1. The repair NOT made:
   * reading `complex` and skipping those pairs, which removes the same 21 rows from G1, G8 and
   * G15 at once and leaves the joint bound enforced only by `tools/scratch/rome-landmarks.mjs`
   * — the script that also chooses `draw`. An exemption from a check is not a weaker check, it
   * is no check.
   */
  CLEAR_MON_MON: 7.0,

  /**
   * Clear ground between a monument and ordinary fabric, metres.
   *
   * The XII Tables' *ambitus* — 2½ *pedes*, 0.74 m, on each side of a building — is
   * 1.48 m between two walls, and it is the oldest surviving Roman rule on exactly this
   * question. Rounded to 1.5.
   */
  CLEAR_MON_BLD: 1.5,

  /**
   * Clear ground between two insulae, metres.
   *
   * **Zero, deliberately.** Roman insulae shared party walls; a terrace with no gap is
   * correct and `src/city/rome/fabric.ts` builds one on purpose (`PARTY_GAP = 0.35`). The
   * fault is interpenetration, not contact, so the gate is "not negative" rather than a
   * minimum gap.
   */
  CLEAR_BLD_BLD: 0.0,

  /**
   * Monument area standing in a carriageway, m². Zero.
   *
   * A temple in a road is a road that does not exist. There is no tolerance to give here:
   * the carriageway is the width a formation needs, and masonry in it is subtracted from
   * that width, not shared with it.
   */
  ROAD_INTRUSION_M2: 0.0,

  /**
   * Monument area standing inside the curtain, a tower or a gate passage, m². Zero.
   *
   * Same class of fault as the last one, one storey up. The one legitimate exception is a
   * fort whose own wall *is* the city wall — Rome's Castra Praetoria, which the survey
   * licenses with `atWall: 0.02` — so the report names the offender and the reader can
   * decide; the gate does not soften.
   */
  WALL_INTRUSION_M2: 0.0,

  /**
   * Aspect-ratio tolerance against the published pair, as a fraction. **Scale-free.**
   *
   * `long/short` does not change under uniform plan compression, so this is the one
   * fidelity test that needs to know nothing at all about the map's projection. 0.15
   * because the literature's own spread is a few percent (the Colosseum is published at
   * 188 and at 189 m; Caracalla's block at 214 × 110 and at 218 × 112) and a tolerance
   * under ~0.08 would fail on that spread alone. 0.15 still catches everything that
   * matters: the Circus Maximus modelled to its outer envelope instead of its track is
   * 3.27 against a published 5.26, off by 38%.
   */
  ASPECT_TOL: 0.15,

  /**
   * Same test against the *drawn* extent, which is looser on purpose.
   *
   * The vertices include the podium, the steps and the precinct paving. Those are real
   * parts of a monument's plan and are usually outside the published figure, and they are
   * not equally deep on every side, so the drawn aspect legitimately drifts from the
   * building's. 0.25 is wide enough for a podium and still narrow enough that a monument
   * of the wrong shape cannot hide behind one.
   */
  ASPECT_TOL_DRAWN: 0.25,

  /**
   * How far the *drawn* stone may fall short of the footprint the sim collides against,
   * as a fraction of that footprint.
   *
   * **This is the check that catches the fault this project keeps shipping: two views of
   * one object that never get compared.** A monument publishes a collision rectangle and a
   * keep-out rectangle, and a geometry builder draws stone. Nothing in the build compares
   * the second against the first, so a monument can report zero overlaps against every
   * neighbour while its drawn stone stands ten metres inside a row of houses.
   *
   * 0.15 because a collision box is legitimately a little inside the precinct — the steps
   * and the paved area round a temple are walkable, and `src/city/rome/monuments.ts`
   * publishes `hw * 0.88`, i.e. 12% in, for exactly that reason. Anything past 15% means the
   * picture and the simulation are describing different buildings.
   */
  BOX_VS_STONE_TOL: 0.15,

  /**
   * How far the layout regions' claimed area may depart from the ground they are responsible
   * for, as a fraction. A partition claims it **once**: the target is 1.00 by definition.
   *
   * This is the gate for the second of Rome's two independent faults, and it is the one no
   * overlap test can see. `docs/ROME-FABRIC.md` §2.3 measures Rome's seventeen fabric
   * districts at **266% of the available ground across 79 overlapping pairs**, inflated
   * 7.17× over an honest projection, with `layout.ts` saying in as many words that "a
   * district costs nothing where it overlaps a neighbour (the plot grid gives the ground to
   * whichever quarter is planned first)". Ground allocated by planning order rather than by
   * plan is the definition of a quilt, and the fix named there is to replace rectangles with
   * the fourteen Augustan regions **because regions tile**.
   *
   * 0.10 rather than 0: a region is not responsible for open water, for the pomerium or for a
   * monument's own precinct, and the denominator here is sampled on an 8 m grid, so a perfect
   * partition will not read exactly 1.000. It will read nothing like 2.66.
   */
  PARTITION_TOL: 0.10,

  /**
   * How far a block's plan orientation may sit from the street that bounds it, degrees.
   *
   * `docs/ROME-FABRIC.md` §4.3 step 3 is the whole of the rebuild in one sentence: take the
   * road graph's **faces** as the blocks, which "makes a block's orientation a property of
   * the streets that bound it rather than of `hash2(round(d.e), round(d.n), 0x5c1)`", and
   * §4.4 check 6 asks for 5°. That is the number, and the reference is the road graph, which
   * is **upstream of the block generator** — so this compares the fabric against something
   * that does not know the fabric exists.
   *
   * A block cut as a face of the graph is parallel to a bounding street by construction and
   * scores ~0. A lattice rotated by a hash scores a uniform draw from [0°, 45°], median
   * 22.5°. The two populations do not overlap, which is what makes this a gate rather than a
   * statistic.
   */
  BLOCK_STREET_TOL_DEG: 5,

  /**
   * How far two *neighbouring* blocks' orientations may differ, degrees. The grain test.
   *
   * Real Rome's street grain holds over patches of **150-400 m and then rotates 15-40°** —
   * measured on the AGEA 2012 orthophoto, and `src/city/rome/layout.ts` quotes exactly that
   * figure in the comment above the line that then rotates each district by a hash. So the
   * rotation is right and the *scale* of it is wrong by an order of magnitude: within 40 m,
   * neighbours must be near-parallel. A city that rotates every 40 m is a quilt however
   * carefully each patch is drawn, and this is the check that can tell a quilt from a city.
   */
  GRAIN_SEAM_TOL_DEG: 5,

  /** Radius within which two blocks count as neighbours for the grain test, metres. */
  GRAIN_NEIGHBOUR_M: 40,

  /**
   * Fraction of neighbouring block pairs allowed to rotate more than 15 degrees across a
   * 40 m gap. **The median is not enough, and Rome proved it.**
   *
   * Measured: Rome's neighbour-pair median is 4.27 deg and passes a median-only gate, because
   * most neighbours are inside one district and share its lattice. The quilt lives at the
   * *boundaries*: **335 of 1,966 pairs - 17% - rotate more than 15 deg across a 40 m gap**,
   * against **0 of 1,125 on Carthage**. So a quilt's signature is a minority of pairs
   * rotating a lot, and a gate that reads only the middle of the distribution passes it.
   * That is the exact shape of failure this file exists to prevent, found in this file.
   *
   * 1% because a real city does rotate its grain - the orthophoto's 15-40 deg across a
   * street, holding over 150-400 m patches - so at a 40 m neighbour radius a handful of pairs
   * legitimately straddle a genuine grain change. 17% is not a grain change; it is
   * seventeen lattices.
   */
  GRAIN_SEAM_FRACTION: 0.01,

  /**
   * **Roof over the ground between street lines.** `ROME-FABRIC.md` §4.4 check 4 takes
   * **60-70 %** from the AGEA 2012 orthophoto of the historic core, and this is a floor at
   * that band's bottom rather than a window at both ends. A window would be the wrong shape
   * twice over: the measurement is of *footprints* and a courtyard insula's footprint is the
   * whole block, so the number reads high against a photograph by an amount nothing here has
   * measured; and there is no failure mode in which a city is too dense that some other check
   * does not catch first — G3 and G10 fail on interpenetration, G9 on the *ambitus*, G17 on a
   * quarter with no streets left in it.
   *
   * Applied to `fabricOverAllowed`: the fabric over the ground the fabric is *allowed* —
   * a block's own inset polygon minus the monument precincts, minus everything the plan's
   * `KeepOut` reserves, minus water. On Rome, monument precinct alone is 21 % of the ground
   * between street lines, so grading the fabric against a denominator that includes it asks
   * the insulae to build the Baths of Trajan. Phase 4's 44 % was that number and it is still
   * printed, beside this one, so the two passes can be compared.
   */
  ROOF_COVERAGE_MIN: 0.6,

  /**
   * Rule 27: a gate on a distribution needs a floor on its population, and the floor belongs
   * in the gate. Ten hectares is about thirty blocks at Rome's own median inset; under it the
   * ratio is a statement about a handful of cells.
   */
  ROOF_COVERAGE_MIN_GROUND_M2: 100000,

  /**
   * How many *horti* blocks may come back with nothing on them. They are built at
   * `HORTI_COVERAGE` = 8 %, so an empty one is the design working — but the exclusion is a
   * claim and rule 16 says a claim needs a count and a gate, or the next empty quarter joins
   * a category instead of failing. Six is what the frame carries on this tree; a seventh is a
   * failure and somebody has to look at it.
   */
  HORTI_EMPTY_MAX: 8,

  /**
   * **How far a dry floor stands above the drawn water surface, metres.** The probe's own
   * copy of the requirement, and the copy is deliberate.
   *
   * G24 asks whether a block had anywhere to put a house, so it has to know what ground is
   * water — and "not submerged" is not the same as "dry". `riverProfile` models the inside of
   * a Tiber meander as a point bar whose terrace reaches `WATER_LEVEL + 0.8`; the cells this
   * catches on Rome are the last twenty centimetres of that run, ground standing 0.02 to
   * 0.25 m over the river, which is a mudflat and not a quay.
   *
   * `src/city/rome/fabric.ts` holds the same number as `QUAY_FREEBOARD` and the two are
   * **not** shared on purpose: if the generator raises its freeboard above this, the ground it
   * refuses stops being water here and G24 goes red with the blocks named, which is the
   * conversation that ought to happen. `MAP-METHOD.md` rule 6 — an instrument compares against
   * something outside the thing it grades, and a threshold typed here is outside.
   *
   * What would change it: the terrain raising Rome's right bank, which would move the ground
   * rather than the rule and is `terrain/topography.ts`'s call.
   */
  DRY_FLOOR_FREEBOARD_M: 0.45,

  /**
   * **RETIRED, and the retirement is the point.** `SCALE_SPREAD_TOL` used to gate G13 —
   * "every monument is compressed by the same factor as its cohort", against the cohort's own
   * median. Its premise was a single uniform plan compression, and `docs/ROME-FABRIC.md` §8
   * deliberately abolished that in favour of twenty-seven authored footprints. Its own
   * threshold comment said 0.15 was chosen to catch the Iseum Campense at a third of its
   * published size; that row is now 200 x 50 and the calibrating fault is fixed by other
   * means. `CITY-GROUND-JUDGE.md` §11.2 retires it and this is where it stood.
   *
   * The cohort median and its spread are still MEASURED and REPORTED — `fidelity.cohort` —
   * because `MAP-METHOD.md` rule 17 asks for the distribution a per-item authored departure
   * produces, and 0.667 with a 5.26x spread is the sentence that rule wants. It is a
   * statistic, not a gate: G13a and G13b are the gates, and both of their rulers are outside
   * the build.
   */

  /**
   * G13a, the absolute band. A gated monument's DRAWN long dimension over its PUBLISHED long
   * dimension must lie in `[SCALE_FLOOR, 1 + SCALE_CEIL_TOL]`.
   *
   * **The floor.** 0.45 is the point below which recognition fails rather than degrades.
   * `CITY-GROUND-JUDGE.md` §4.4's eye-level hierarchy is the argument and §10.6 is the
   * measurement: the Theatre of Marcellus is a 129.8 m building with a 32.6 m three-order
   * facade, drawn at 44 m, and from the ground it reads as *"a curved garden wall with a tree
   * inside it"*. At any proportion, a 44 m Theatre of Marcellus is not the Theatre of
   * Marcellus. Below about 0.45 the answer is not to shrink further but to move something
   * else, and that is a decision for the plan rather than a tolerance for the gate.
   *
   * **The reference is `PUBLISHED`, which is typed into this file.** So this cannot be
   * satisfied by agreeing with `survey.ts` — which is precisely what the replacement offered
   * for G13 ("does the built extent match `draw x len`?") would have measured. `draw` is an
   * INPUT to the build.
   *
   * **The ceiling.** 1.25, and looser than the floor on purpose, because the drawn read
   * includes the podium, the steps and the precinct paving and the published figure usually
   * does not — the same argument as `ASPECT_TOL_DRAWN`, and `PRECINCT` is 1.07 of it before a
   * single step is drawn. What the ceiling catches is a monument drawn BIGGER than published,
   * which nothing in this file gated from the plan side at all.
   *
   * 0.45 fails Rome on 2 of its 10 gated present rows today (the Castra Praetoria at 0.175,
   * which `survey.ts` documents as a deliberate compromise, and the Theatre of Marcellus at
   * 0.221, which nothing documents). It passes Carthage on both of its rows. **This is the
   * owner's number to raise or lower in one line, and lowering it is a statement about how
   * small a monument may be and still be that monument.**
   */
  SCALE_FLOOR: 0.45,
  SCALE_CEIL_TOL: 0.25,

  /**
   * G13b, the size order. How much bigger one published figure must be than another before
   * the pair is taken to ASSERT an order at all.
   *
   * 1.05, and it is not a fudge: the literature's own spread on a single monument is a few
   * percent — the Colosseum is published at 188 m and at 189, Caracalla's block at 214 x 110
   * and at 218 x 112 — so two monuments published within 5 % of each other are not making a
   * claim about which is bigger, and grading one would be grading noise. Carthage is the case
   * that proves it: the Cothon at 325 m and the merchant harbour at 320 m differ by 1.6 %,
   * which is inside every citation's own error bar.
   *
   * Rome fails at 10 of 43 asserting pairs. The count is stable across the filter — 10 of 45
   * unfiltered, 9 of 42 at a 1.10 filter — so no inversion in the list is an artefact of it.
   */
  SIZE_ORDER_MIN_RATIO: 1.05,

  /**
   * G13b's refusal floor: fewer asserting pairs than this and the check reports `n/a` with the
   * sample size instead of a verdict.
   *
   * `MAP-METHOD.md` rule 12 — a statistic whose sample has collapsed returns a confident
   * number rather than an error. "0 of 1 pairs inverted" is a green light drawn from one
   * relation and it would let a two-monument map pass a check about the order of a city.
   * Six is the smallest population in which a 10 % inversion rate — the rate the judge
   * measured among Rome's pairs close enough to share a frame — can register at all.
   *
   * Carthage lands here today: after the 1.05 filter it has NO asserting pair, so G13b is
   * not applicable there and says so rather than passing.
   */
  SIZE_ORDER_MIN_PAIRS: 6,

  /**
   * When two monuments in one declared `complex` count as NESTED rather than merely near:
   * the smaller footprint's area lying inside the larger, as a fraction of the smaller.
   *
   * 0.95 rather than 1.0 because a nested precinct's corner may legitimately poke out of its
   * container's rectangle — the Basilica Ulpia is a hall inside Trajan's Forum and the two are
   * modelled as boxes, not as the buildings. Below 0.95 the relation is an abutment or it is
   * nothing, and `ABUT_DEPTH_M` decides which.
   */
  NEST_FRAC: 0.95,
};

// ===========================================================================
// THE EXTERNAL RULER
//
// Real published plan dimensions. Typed here; never read from the repo.
//
// `conf`:
//   'published'  — a figure with a source I can name and stand behind
//   'repo-cited' — the figure the repo's own citation attributes to a work I have not
//                  independently opened. Reported and labelled; gated only where the
//                  attribution is specific enough to be checkable.
//   'derived'    — arithmetic from two sourced figures, with the arithmetic shown
//   'unsourced'  — I could not source it. Reported as unsourced. NEVER gated on.
//
// `gate: true` puts the row in the fidelity gate. `alt: true` marks a second reading of
// the same monument (track versus envelope, block versus precinct) kept for the record.
// ===========================================================================
const PUBLISHED = {
  'campus-martius': [
    {
      id: 'colosseum', name: 'Colosseum (Flavian Amphitheatre)',
      len: 188, wid: 156, conf: 'published', gate: true,
      src: 'Platner & Ashby, A Topographical Dictionary of Ancient Rome (1929), s.v. '
        + 'Amphitheatrum Flavium: major axis 188 m, minor 156 m at ground level; arena 86 × 54. '
        + 'The owner\'s brief names the same pair. (survey.ts says 189 × 156 — a 1 m difference '
        + 'inside the literature\'s own spread.)',
    },
    {
      id: 'circus-maximus', name: 'Circus Maximus (track — the published pair)',
      len: 621, wid: 118, conf: 'published', gate: true, offFrame: true,
      src: 'Humphrey, Roman Circuses: Arenas for Chariot Racing (1986), 56-131 — the arena '
        + '621 × 118 m. This is the pair the owner\'s brief names. ABSENT FROM THE MODEL AND '
        + 'CORRECTLY SO, but for a different reason from the Baths of Diocletian: it is not an '
        + 'anachronism, it is off this map\'s +Z edge. `layout.ts:offMapSouth` drops it because '
        + 'its projected centre is past `CITY_Z_MAX`, and a monument with a straight cut through '
        + 'it is worse than an absent one. See `OFF_FRAME_AGREED`: the gate checks that this row '
        + 'is absent AND that the off-frame list is exactly the five names agreed.',
    },
    {
      id: 'circus-maximus', name: 'Circus Maximus (outer envelope, with the seating banks)',
      len: 621, wid: 190, conf: 'repo-cited', gate: false, alt: true,
      src: 'The 190 m outer width is what survey.ts attributes to Humphrey 1986; I have not '
        + 'checked it in Humphrey. It is the pair the model is actually built to, which is why '
        + 'both readings are here — the aspect gate above is measuring which of the two the '
        + 'model chose.',
    },
    {
      id: 'baths-caracalla', name: 'Baths of Caracalla (bathing block)',
      len: 218, wid: 112, conf: 'repo-cited', gate: true, offFrame: true,
      src: 'Platner & Ashby 1929 s.v. Thermae Antoninianae for the complex; DeLaine, The Baths '
        + 'of Caracalla (JRA Suppl. 25, 1997) measures the block at c. 214 × 110 m. 218 × 112 is '
        + 'the pair survey.ts states and it sits inside DeLaine\'s spread. NOTE: survey.ts\'s '
        + 'own prose says "the block is what is modelled ... 218 × 112" and then models '
        + '218 × 140. This gate is measuring that discrepancy — when the row is on the map. It '
        + 'is not: like the Circus Maximus it is off the +Z edge, and it is marked `offFrame` '
        + 'rather than counted missing. See `OFF_FRAME_AGREED`.',
    },
    {
      id: 'baths-caracalla', name: 'Baths of Caracalla (whole precinct)',
      len: 337, wid: 328, conf: 'published', gate: false, alt: true,
      src: 'Platner & Ashby 1929 s.v. Thermae Antoninianae — the enclosure c. 337 × 328 m. The '
        + 'model builds the block, not the precinct, which is a documented choice.',
    },
    {
      id: 'baths-diocletian', name: 'Baths of Diocletian (precinct)',
      len: 376, wid: 361, conf: 'published', gate: false, absentExpected: true,
      src: 'Platner & Ashby 1929 s.v. Thermae Diocletianae — "the whole area ... about 376 by '
        + '361 metres". ABSENT FROM THE MODEL AND CORRECTLY SO: begun AD 298, dedicated 305/6, '
        + 'so 27-35 years AFTER this map\'s autumn 271. src/city/rome/survey.ts states the '
        + 'omission and its reason in a comment. The gate therefore checks that it is absent, '
        + 'not that it is right.',
    },
    {
      id: 'pantheon', name: 'Pantheon (rotunda drum, external)',
      len: 58, wid: 58, conf: 'published', gate: false, alt: true,
      src: 'MacDonald, The Pantheon: Design, Meaning, and Progeny (1976); Platner & Ashby s.v. '
        + 'Pantheon. Interior diameter and interior height are both 43.3 m and the drum wall is '
        + 'c. 6.2 m thick, so the external diameter is c. 58 m. Not gated because the model\'s '
        + 'box is the whole building including the pronaos; see the next row.',
    },
    {
      id: 'pantheon', name: 'Pantheon (rotunda + intermediate block + pronaos, overall)',
      len: 84, wid: 58, conf: 'derived', gate: true,
      src: 'DERIVED, and the arithmetic is: drum 58 m external (MacDonald 1976) + pronaos depth '
        + '13.6-15.5 m (Platner & Ashby; Hannah & Magli 2011 for the 354.5° axis) + the '
        + 'intermediate block, which gives c. 84-88 m front to back. I could NOT find a single '
        + 'published overall-length figure to cite, so this is a derivation and is labelled one.',
    },
    {
      id: 'theatre-pompey', name: 'Theatre of Pompey (cavea diameter)',
      len: 156.8, wid: 156.8, conf: 'repo-cited', gate: false, alt: true,
      src: 'Packer 2014 (the Theatre of Pompey excavation reports), as quoted in docs/ROME.md '
        + '§6.3. Platner & Ashby s.v. Theatrum Pompei gives the cavea as c. 150 m. Not opened in '
        + 'Packer, so repo-cited.',
    },
    {
      id: 'theatre-pompey', name: 'Theatre of Pompey (whole complex with quadriporticus)',
      len: 300, wid: 180, conf: 'derived', gate: false,
      src: 'DERIVED from survey.ts\'s own reasoning — cavea c. 150 m plus a quadriporticus '
        + 'running a further c. 150 m behind it. That is not a published pair. Reported only, '
        + 'because gating a model against a figure derived from that same model is exactly the '
        + 'self-comparison this probe exists to avoid.',
    },
    {
      id: 'castra-praetoria', name: 'Castra Praetoria',
      len: 440, wid: 380, conf: 'published', gate: true,
      src: 'Platner & Ashby 1929 s.v. Castra Praetoria — the camp of AD 23, c. 440 × 380 m; the '
        + 'surviving walls measure 437 × 377. survey.ts DELIBERATELY models 400 × 377 and says '
        + 'why: at true size it is 167,000 m², a tenth of the whole buildable city. So a scale '
        + 'failure on this row is a documented compromise, not a defect — the gate flags it and '
        + 'the reader decides.',
    },
    {
      id: 'theatre-marcellus', name: 'Theatre of Marcellus (external diameter)',
      len: 129.8, wid: 115, conf: 'published', gate: true,
      src: 'Platner & Ashby 1929 s.v. Theatrum Marcelli — external diameter 129.8 m, facade '
        + '32.6 m to the top of the attic, 41 arcade bays a storey, orchestra 37 m. The 115 m '
        + 'short axis is the cavea semicircle plus the stage building rather than a published '
        + 'figure, so the ASPECT half of this row is weaker than its LONG half.',
    },
    {
      id: 'stadium-domitian', name: 'Stadium of Domitian',
      len: 275, wid: 106, conf: 'published', gate: true,
      src: 'Platner & Ashby 1929 s.v. Stadium Domitiani — 275 × 106 m, arena c. 250 m, floor '
        + '4.5 m below the modern Piazza Navona, whose outline preserves the plan.',
    },
    {
      id: 'mausoleum-augustus', name: 'Mausoleum of Augustus (drum)',
      len: 87, wid: 87, conf: 'published', gate: true,
      src: 'Platner & Ashby 1929 s.v. Mausoleum Augusti — 87 m diameter (= 300 Roman feet), '
        + 'travertine socle 89 m, c. 45 m high.',
    },
    {
      id: 'ara-pacis', name: 'Ara Pacis Augustae (enclosure)',
      len: 11.625, wid: 10.55, conf: 'published', gate: true,
      src: 'The enclosure measures 11.625 × 10.55 m in Luna marble, walls c. 6 m — the figure '
        + 'published by the Museo dell\'Ara Pacis from Moretti\'s 1938 reconstruction, and the '
        + 'one docs/ROME.md §6.3 carries.',
    },
    {
      id: 'porticus-octaviae', name: 'Porticus Octaviae (quadriportico)',
      len: 132, wid: 119, conf: 'repo-cited', gate: true,
      src: 'The Severan Marble Plan (Forma Urbis Romae, c. AD 203-211), as read by survey.ts and '
        + 'docs/ROME.md §6.3, which gives the quadriportico as 119 × 132 m. Not checked against '
        + 'the Plan\'s own fragments.',
    },
    {
      id: 'temple-jupiter', name: 'Temple of Jupiter Optimus Maximus (podium)',
      len: 62.25, wid: 53.5, conf: 'published', gate: true,
      src: 'Platner & Ashby 1929 s.v. Iuppiter Optimus Maximus Capitolinus, Aedes — the archaic '
        + 'podium c. 53.5 × 62.25 m, which is the footprint every later rebuild kept. Mura '
        + 'Sommella\'s Capitoline excavations give the same order.',
    },
    {
      id: 'temple-isis', name: 'Iseum et Serapeum Campense',
      len: 200, wid: 50, conf: 'repo-cited', gate: true,
      src: 'Digital Augustan Rome gives c. 200 × 50 m; the Iseum Campense project gives '
        + '240 × 60. docs/ROME.md §6.3 states flatly that "the shipped temple-isis is 70 × 34 '
        + 'and is too small by a factor of three". This row is the gate for that claim.',
    },
    {
      id: 'baths-nero', name: 'Baths of Nero / Alexandrinae',
      len: 190, wid: 120, conf: 'repo-cited', gate: false,
      src: 'Platner & Ashby 1929 s.v. Thermae Neronianae; docs/ROME.md §6.3 gives c. 190 × 120 m '
        + 'fronting north. The published plan of this bath is reconstructed from Palladio\'s '
        + 'drawings rather than from excavation, so I have not gated on it.',
    },
    {
      id: 'baths-agrippa', name: 'Baths of Agrippa',
      len: 120, wid: 100, conf: 'unsourced', gate: false,
      src: 'UNSOURCED as a pair. docs/ROME.md §6.3 gives a RANGE — c. 100-120 × 80-100 m — with '
        + 'a central circular hall of c. 25 m and Hadrian\'s hall 45 × 19 m. A range is not a '
        + 'dimension to gate on, so this row is reported only.',
    },
    {
      id: 'basilica-ulpia', name: 'Basilica Ulpia',
      len: 170, wid: 60, conf: 'repo-cited', gate: false,
      src: 'Platner & Ashby 1929 s.v. Basilica Ulpia gives the hall as roughly 170 × 60 m '
        + 'including the two apses. I am confident of the order but not of the exact pair, and '
        + 'the model reserves 130 × 55, so the disagreement is reported rather than gated.',
    },
    {
      id: 'baths-trajan', name: 'Baths of Trajan (precinct)',
      len: 330, wid: 315, conf: 'repo-cited', gate: false,
      src: 'Platner & Ashby 1929 s.v. Thermae Traianae give the enclosure as roughly '
        + '330 × 315 m. The model reserves 230 × 170, i.e. the block rather than the precinct. '
        + 'Reported, not gated, because which of the two a model should carry is a design '
        + 'decision and not a fidelity failure.',
    },
    {
      id: 'mausoleum-hadrian', name: 'Mausoleum of Hadrian (podium)',
      len: 84, wid: 84, conf: 'repo-cited', gate: false,
      src: 'docs/ROME.md §6.3: podium c. 84 m square and 10 m high, drum 64 m diameter and 21 m '
        + 'high, tomb chamber 9 × 8 m. Standing today as the Castel Sant\'Angelo, so the podium '
        + 'is measurable; I have not measured it. Outside the circuit in 271, so it is scenery.',
    },
    {
      id: 'trajan-column', name: 'Column of Trajan',
      len: 5.5, wid: 5.5, conf: 'unsourced', gate: false,
      src: 'The shaft is 29.78 m and the whole monument c. 38 m with its pedestal — both well '
        + 'published — but I could not source the PEDESTAL\'s plan, which is the only figure a '
        + 'footprint test can use. The model reserves 18 × 18, which is a precinct rather than a '
        + 'plinth. Unsourced, reported only.',
    },
    {
      id: 'tabularium', name: 'Tabularium',
      len: 73.6, wid: 34, conf: 'unsourced', gate: false,
      src: 'The surviving building is often given as c. 73.6 m along its Forum front; I could '
        + 'not source the depth, and the short axis is what an aspect test needs. Unsourced.',
    },
    {
      id: 'forum-romanum', name: 'Forum Romanum (the open piazza)',
      len: 200, wid: 90, conf: 'unsourced', gate: false,
      src: 'UNSOURCED. The Forum is not one building and its "dimensions" depend entirely on '
        + 'where the precinct is judged to end. Reported so its footprint appears in the '
        + 'overlap tables, never graded for fidelity.',
    },
  ],

  carthage: [
    {
      id: 'cothon', name: 'The circular harbour (Cothon), outer basin',
      len: 325, wid: 325, conf: 'published', gate: true,
      src: 'Hurst, Excavations at Carthage: The British Mission (vol. II.1, 1994) — the circular '
        + 'harbour c. 325 m outer diameter with an admiralty island of c. 125 m. The repo cites '
        + 'the same figures to Hurst and tags them [ARCH].',
    },
    {
      id: 'merchant-harbour', name: 'The rectangular merchant harbour',
      len: 320, wid: 150, conf: 'repo-cited', gate: true,
      src: 'docs/CARTHAGE.md §6.2 gives 320 × 150 m of water, tagged [ARCH]. The rectangular '
        + 'basin is the less well excavated of the two harbours and I have not opened the '
        + 'primary report, so this is repo-cited rather than published.',
    },
  ],
};

// ===========================================================================
// THE EXCLUSION REGISTRIES
//
// `MAP-METHOD.md` rule 13: a check that goes dark is worse than a check that fails. Rule 16:
// count and name every exclusion, and treat a check whose exclusion list is exactly the rows a
// mechanism touches as a measurement of that mechanism's absence.
//
// Both lists below are typed HERE, in the probe, so that the build cannot grow its own
// exemptions. Each is gated on its exact membership, not on its length: adding a row to the
// build's off-frame set, or putting a sixth monument in the river, fails the gate rather than
// joining a category.
// ===========================================================================

/**
 * The survey rows agreed, in writing, to be off this map's +Z frame.
 *
 * `src/city/rome/assertions.ts` already carries the count and the sentence — *"5, agreed in
 * writing: palatine, circus-maximus, aventine-temples, baths-caracalla, caelian-villas (the
 * Janiculum is far-bank and survives, clamped 8 m)"* — and gates `offMap.length === 5`. **It
 * gates the count and not the names**, so swapping the Palatine for the Pantheon passes the
 * build's own assertion. This list gates the names, from outside the build.
 *
 * `docs/ROME-FABRIC.md` §4.5 is the decision and `layout.ts:offMapSouth` is the mechanism: a
 * monument whose centre projects past `CITY_Z_MAX` is not built, because a monument with a
 * straight cut through it is worse than an absent one. Phase 6 may bring them back as
 * off-field silhouettes; until then their absence is a decision, not a defect, and G11
 * distinguishes the three kinds of absence — anachronism (`absentExpected`), off-frame
 * (`offFrame`), and missing (neither, which is a fault).
 */
const OFF_FRAME_AGREED = {
  'campus-martius': [
    'palatine', 'circus-maximus', 'aventine-temples', 'baths-caracalla', 'caelian-villas',
  ],
  carthage: [],
};

/**
 * Structures whose footprint is expected to stand at or below the water surface.
 *
 * **G22 is not shippable without this list, and that is the judge's condition, not a
 * convenience.** `CITY-GROUND-JUDGE.md` §11.4 endorses a water check *"conditional on
 * exclusions being counted, named and gated"*, on rule 16's ground that a check born blind to
 * a mechanism measures that mechanism's absence. The mechanism here is deliberate water
 * siting, and it exists on both maps:
 *
 *  - **Rome, `tiber-island`.** `survey.ts` places it with `onRiver: true` and `layout.ts`
 *    takes its x from `riverCentreX(z)` rather than from the affine map. An island in the
 *    Tiber whose apron is at the water surface is the correct model of the Insula Tiberina,
 *    and it is `soft` besides. The judge's own table measures its centre datum at 0.58 m and
 *    marks it *"by design, `onRiver`"*.
 *  - **Carthage, `cothon` and `merchant-harbour`.** These are not buildings near water; they
 *    are water. `docs/CARTHAGE.md` §6.2 gives the merchant basin as *"320 × 150 m of water"*
 *    and Hurst 1994 gives the Cothon as a 325 m basin. Their obstacle boxes are the basins,
 *    so a naive water check fails them by construction — which is exactly the shape of a check
 *    that measures a mechanism's absence rather than a fault.
 *
 * **What is NOT on this list, deliberately: the Theatre of Marcellus.** Its centre datum is
 * 1.52 m against a 5.0 m water surface and three of its four box corners are wet
 * (`CITY-GROUND-JUDGE.md` §10.6). The branch flagged it and left it drawn on the ground that
 * the Tiber resurvey owns the channel. That reasoning is right and it is not a licence: a
 * monument three and a half metres under the surface is visible from the ground, in the
 * quarter the assault crosses. The right handling of a fault you must not fix is to stop
 * drawing it — the `offMapSouth` treatment, with the name printed at boot — not to write it
 * down. So G22 fails on it, and it fails until either the channel moves or the row does.
 */
const WATER_EXPECTED = {
  'campus-martius': [
    { id: 'tiber-island', why: 'survey.ts `onRiver: true`; x from riverCentreX(z), soft; the Insula Tiberina is in the river' },
  ],
  carthage: [
    { id: 'cothon', why: 'the obstacle IS the basin — Hurst 1994, a 325 m circular harbour of water' },
    { id: 'merchant-harbour', why: 'the obstacle IS the basin — CARTHAGE.md 6.2, "320 x 150 m of water"' },
  ],
};

// ---------------------------------------------------------------------------
// Server. Never reuse one this process did not start.
// ---------------------------------------------------------------------------
const base = `http://127.0.0.1:${PORT}`;
const up = async (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(base, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

if (await up(1200)) {
  console.error(
    `[probe-fabric] something is ALREADY serving ${base}. Refusing to use it.\n`
    + '  Six agents run vite on this box out of six different worktrees. A reused port serves\n'
    + "  another branch's modules, and the probe then grades a tree it is not standing in.\n"
    + '  Pass a free --port in the 5900s.\n'
    + '  See what is taken: node tools/browsers.mjs'
  );
  process.exit(2);
}

/*
 * ## 22 Aug 2026 — the browser is budgeted and the server is `startVite`
 *
 * This file had the best server cleanup in the repository: `unref`, an `exit` hook, and
 * explicit SIGINT/SIGTERM/SIGHUP handlers, written after this tool was SIGKILLed mid-run and
 * left its vite listening on 5951. **It still leaked**, and the header comment it replaced
 * names the reason without drawing the conclusion: `server` was `npx`, not Vite. `npx` execs a
 * shell which execs `node …/vite.js`, so all three of those careful kills signalled a wrapper
 * two processes above the one holding the port.
 *
 * `startVite` runs Vite under `node` directly — the handle is the server — and the server
 * polls this process and exits within two seconds of losing it, which is the part that
 * survives the SIGKILL that no exit hook can. The refusal above is kept, and `startVite` adds
 * the check it could not make: it asks a listener which tree it is serving rather than
 * assuming, so "grades a tree it is not standing in" is now impossible rather than merely
 * warned about.
 *
 * The browser comes from the same place and takes one of a small number of machine-wide slots.
 * On the day this comment was written, twelve agents each doing what this file does put the
 * box at load average 160 on 16 cores.
 */
const browser = await launchBrowser({
  label: 'probe-fabric', port: PORT, root: ROOT,
  args: [
    '--enable-gpu-rasterization',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
  ],
});
const { close: killServer } = await startVite({
  port: PORT,
  root: ROOT,
  label: 'probe-fabric',
  slot: browser.budgetSlot,
  cacheDir: process.env.TC_VITE_CACHE_DIR ?? path.join(ROOT, '.vite', 'probe-fabric'),
  timeoutMs: 150000,
});
console.log(`[probe-fabric] own vite on ${base}  map=${MAP}  tier=${TIER}`);

// ---------------------------------------------------------------------------
/*
 * `--use-angle=metal`, and it is not a nicety — now supplied by default.
 *
 * A bare `chromium.launch()` on this box comes up with `--use-angle=swiftshader-webgl`: the
 * whole scene rasterised in software. Boots took four to six minutes and every screenshot
 * timed out, at 30 s and again at 180 s, on both maps — which reads as a hung page and is a
 * missing flag. This file found that the hard way and `tools/shoot.mjs` had carried the right
 * args for a year; nothing pointed a new tool at them, which is precisely the failure that
 * `GPU_ARGS` in `tools/lib/browser-budget.mjs` now prevents by making the *shortest* call the
 * correct one. The four flags that were here are those four; only the two specific to this
 * tool are still passed at the call site above.
 *
 * Check the GPU process's command line before believing any timing taken through Playwright:
 *   ps -A -o command | grep 'type=gpu-process'
 * or `node tools/browsers.mjs`, which reads the value of `--use-angle` and counts them.
 */
let exitCode = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const cityLog = [];
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[city')) cityLog.push(t);
    else if (m.type() === 'error') cityLog.push(`ERROR ${t}`);
  });
  page.on('pageerror', (e) => cityLog.push(`PAGEERROR ${e.message}`));

  await page.goto(
    `${base}/?harness=1&map=${MAP}&scenario=assault&quality=${TIER}&w=1600&h=900`,
    { waitUntil: 'domcontentloaded', timeout: 240000 }
  );
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });

  const out = await page.evaluate(async ({ MAPID, PUB, TH, OFF_FRAME, WATER_OK, INJ, DRY_ROW }) => {
    // =====================================================================
    // FAULT INJECTION. See `INJECTIONS` above the browser boundary for what each one proves.
    // Every one of these perturbs the PROBE's reference data or the PROBE's thresholds. None
    // of them touches the game, the scene, or anything under `src/`.
    // =====================================================================
    const injected = new Set(INJ ?? []);
    const injectNotes = [];
    if (injected.has('off-frame-sixth')) {
      OFF_FRAME = [...OFF_FRAME, 'pantheon'];
      injectNotes.push('OFF_FRAME_AGREED += pantheon (which is on the map)');
    }
    if (injected.has('off-frame-drop')) {
      injectNotes.push(`OFF_FRAME_AGREED -= ${OFF_FRAME[0] ?? '(empty)'}`);
      OFF_FRAME = OFF_FRAME.slice(1);
    }
    if (injected.has('water-no-exclusions')) {
      injectNotes.push(`WATER_EXPECTED emptied (was ${WATER_OK.map((w) => w.id).join(', ') || 'empty'})`);
      WATER_OK = [];
    }
    if (injected.has('water-stale-licence')) {
      WATER_OK = [...WATER_OK, { id: DRY_ROW, why: 'INJECTED — this row is dry and publishes solids' }];
      injectNotes.push(`WATER_EXPECTED += ${DRY_ROW} (dry)`);
    }
    if (injected.has('band-ceiling')) {
      PUB = PUB.map((r) => (r.gate ? { ...r, len: r.len / 2, wid: r.wid / 2 } : r));
      injectNotes.push('every gated PUBLISHED dimension halved, so drawn/published doubles');
    }
    if (injected.has('size-order-relax')) {
      TH = { ...TH, SIZE_ORDER_MIN_RATIO: 1.0, SIZE_ORDER_MIN_PAIRS: 1 };
      injectNotes.push('SIZE_ORDER_MIN_RATIO 1.05 -> 1.0, SIZE_ORDER_MIN_PAIRS 6 -> 1');
    }

    // =====================================================================
    // Geometry, written here rather than imported. See the header: reusing
    // `obbOverlap` would restate the answer of the code under test.
    // =====================================================================
    const signedArea = (p) => {
      let a = 0;
      for (let i = 0; i < p.length; i++) {
        const q = p[i];
        const r = p[(i + 1) % p.length];
        a += q.x * r.z - r.x * q.z;
      }
      return a * 0.5;
    };
    const ccw = (p) => (signedArea(p) < 0 ? p.slice().reverse() : p);

    /** Sutherland-Hodgman: clip convex `subj` by convex `cl`, both CCW. */
    const clipPoly = (subj, cl) => {
      let out = subj;
      for (let i = 0; i < cl.length && out.length; i++) {
        const a = cl[i];
        const b = cl[(i + 1) % cl.length];
        const ex = b.x - a.x;
        const ez = b.z - a.z;
        const side = (p) => ex * (p.z - a.z) - ez * (p.x - a.x);
        const next = [];
        for (let j = 0; j < out.length; j++) {
          const p = out[j];
          const q = out[(j + 1) % out.length];
          const sp = side(p);
          const sq = side(q);
          if (sp >= 0) next.push(p);
          if ((sp >= 0) !== (sq >= 0)) {
            const t = sp / (sp - sq);
            next.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
          }
        }
        out = next;
      }
      return out;
    };
    const clipArea = (a, b) => {
      const p = clipPoly(ccw(a), ccw(b));
      return p.length < 3 ? 0 : Math.abs(signedArea(p));
    };

    /** Crossing number. Correct for any simple polygon; `inPoly` is convex-only. */
    const inRing = (p, x, z) => {
      let inside = false;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const a = p[i];
        const b = p[j];
        if ((a.z > z) !== (b.z > z)) {
          const t = (z - a.z) / (b.z - a.z);
          if (x < a.x + t * (b.x - a.x)) inside = !inside;
        }
      }
      return inside;
    };

    /** Ear clipping. Enough for the region rings, which are simple and hole-free. */
    const triangulate = (poly) => {
      const n = poly.length;
      if (n < 3) return [];
      if (n === 3) return [poly];
      const idx = [...Array(n).keys()];
      if (signedArea(poly) < 0) idx.reverse();
      const tris = [];
      let guard = 0;
      while (idx.length > 3 && guard++ < 4 * n) {
        let cut = false;
        for (let i = 0; i < idx.length; i++) {
          const a = poly[idx[(i + idx.length - 1) % idx.length]];
          const b = poly[idx[i]];
          const c = poly[idx[(i + 1) % idx.length]];
          const cr = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
          if (cr <= 0) continue;              // reflex under CCW winding
          let clean = true;
          for (let k = 0; k < idx.length && clean; k++) {
            if (k === i || k === (i + idx.length - 1) % idx.length || k === (i + 1) % idx.length) continue;
            const p = poly[idx[k]];
            const d1 = (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
            const d2 = (c.x - b.x) * (p.z - b.z) - (c.z - b.z) * (p.x - b.x);
            const d3 = (a.x - c.x) * (p.z - c.z) - (a.z - c.z) * (p.x - c.x);
            if (d1 >= 0 && d2 >= 0 && d3 >= 0) clean = false;
          }
          if (!clean) continue;
          tris.push([a, b, c]);
          idx.splice(i, 1);
          cut = true;
          break;
        }
        if (!cut) break;                       // degenerate; stop rather than spin
      }
      if (idx.length === 3) tris.push(idx.map((k) => poly[k]));
      return tris;
    };

    /**
     * Area of the intersection of two arbitrary simple polygons.
     *
     * `clipArea` is Sutherland-Hodgman, which is only correct when the *clip* polygon is
     * convex; a region ring is not. Triangulating both and clipping triangle against triangle
     * is exact, because a triangle is convex, and it reduces to `clipArea` when both inputs
     * already are — which is why Carthage's rectangles must read the same through it.
     */
    const polyIntersectArea = (a, b) => {
      if (a.length === 4 && b.length === 4) return clipArea(a, b);
      const ta = triangulate(ccw(a));
      const tb = triangulate(ccw(b));
      const bg = makeGrid(tb.map((t) => ({ bb: bbox(t) })));
      let sum = 0;
      for (const p of ta) {
        const pb = bbox(p);
        gridQuery(bg, pb, 0, (j) => {
          if (bbClear(pb, bbox(tb[j]))) return;
          sum += clipArea(p, tb[j]);
        });
      }
      return sum;
    };

    const axesOf = (p) => {
      const ax = [];
      for (let i = 0; i < p.length; i++) {
        const a = p[i];
        const b = p[(i + 1) % p.length];
        const ex = b.x - a.x;
        const ez = b.z - a.z;
        const l = Math.hypot(ex, ez);
        if (l > 1e-9) ax.push({ x: -ez / l, z: ex / l });
      }
      return ax;
    };
    const projOf = (p, a) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const q of p) {
        const d = q.x * a.x + q.z * a.z;
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
      return { lo, hi };
    };
    /** Minimum-translation penetration depth. Only called on pairs already known to overlap. */
    const satDepth = (pa, pb) => {
      let best = Infinity;
      for (const a of [...axesOf(pa), ...axesOf(pb)]) {
        const A = projOf(pa, a);
        const B = projOf(pb, a);
        const d = Math.min(A.hi, B.hi) - Math.max(A.lo, B.lo);
        if (d < best) best = d;
        if (best <= 0) return best;
      }
      return best;
    };
    const segDist = (p, a, b) => {
      const ex = b.x - a.x;
      const ez = b.z - a.z;
      const l2 = ex * ex + ez * ez;
      const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.z - a.z) * ez) / l2));
      return Math.hypot(p.x - (a.x + ex * t), p.z - (a.z + ez * t));
    };
    /** True euclidean gap between two disjoint convex polygons. */
    const polyGap = (pa, pb) => {
      let best = Infinity;
      for (const q of pa) for (let i = 0; i < pb.length; i++) best = Math.min(best, segDist(q, pb[i], pb[(i + 1) % pb.length]));
      for (const q of pb) for (let i = 0; i < pa.length; i++) best = Math.min(best, segDist(q, pa[i], pa[(i + 1) % pa.length]));
      return best;
    };

    /**
     * Corners of a sim obstacle box. `src/sim/Obstacles.ts` `escape()` uses
     * `u = dx·cos + dz·sin`, `v = -dx·sin + dz·cos`, so u = (cos, sin), v = (-sin, cos).
     */
    const obPoly = (o) => {
      const c = Math.cos(o.rot);
      const s = Math.sin(o.rot);
      const ux = c * o.hw;
      const uz = s * o.hw;
      const vx = -s * o.hd;
      const vz = c * o.hd;
      return [
        { x: o.x - ux - vx, z: o.z - uz - vz },
        { x: o.x + ux - vx, z: o.z + uz - vz },
        { x: o.x + ux + vx, z: o.z + uz + vz },
        { x: o.x - ux + vx, z: o.z - uz + vz },
      ];
    };
    /**
     * Corners of a *plan* box. `src/city/layout.ts` axisU/axisV follow three.js
     * `makeRotationY(r)`: local +X → (cos r, −sin r), +Z → (sin r, cos r).
     * `CitySystem.occRot` negates the yaw to reach the obstacle frame, so the two helpers
     * describe the same rectangle in two conventions and must stay distinct.
     */
    const planPoly = (o) => {
      const c = Math.cos(o.rot);
      const s = Math.sin(o.rot);
      const ux = c * o.hw;
      const uz = -s * o.hw;
      const vx = s * o.hd;
      const vz = c * o.hd;
      return [
        { x: o.x - ux - vx, z: o.z - uz - vz },
        { x: o.x + ux - vx, z: o.z + uz - vz },
        { x: o.x + ux + vx, z: o.z + uz + vz },
        { x: o.x - ux + vx, z: o.z - uz + vz },
      ];
    };
    /** A street segment as a rectangle, straight off its endpoints. No yaw convention at all. */
    const segPoly = (a, b, half) => {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l = Math.hypot(dx, dz);
      if (l < 1e-6) return null;
      const nx = -dz / l;
      const nz = dx / l;
      return [
        { x: a.x + nx * half, z: a.z + nz * half },
        { x: b.x + nx * half, z: b.z + nz * half },
        { x: b.x - nx * half, z: b.z - nz * half },
        { x: a.x - nx * half, z: a.z - nz * half },
      ];
    };
    const bbox = (p) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const q of p) {
        if (q.x < x0) x0 = q.x;
        if (q.x > x1) x1 = q.x;
        if (q.z < z0) z0 = q.z;
        if (q.z > z1) z1 = q.z;
      }
      return { x0, x1, z0, z1 };
    };
    const bbClear = (a, b) => a.x0 > b.x1 || b.x0 > a.x1 || a.z0 > b.z1 || b.z0 > a.z1;

    const CELL = 40;
    const makeGrid = (items) => {
      const g = new Map();
      for (let i = 0; i < items.length; i++) {
        const b = items[i].bb;
        for (let cz = Math.floor(b.z0 / CELL); cz <= Math.floor(b.z1 / CELL); cz++) {
          for (let cx = Math.floor(b.x0 / CELL); cx <= Math.floor(b.x1 / CELL); cx++) {
            const k = cx * 100003 + cz;
            const l = g.get(k);
            if (l) l.push(i); else g.set(k, [i]);
          }
        }
      }
      return g;
    };
    const gridQuery = (g, bb, pad, fn) => {
      const seen = new Set();
      for (let cz = Math.floor((bb.z0 - pad) / CELL); cz <= Math.floor((bb.z1 + pad) / CELL); cz++) {
        for (let cx = Math.floor((bb.x0 - pad) / CELL); cx <= Math.floor((bb.x1 + pad) / CELL); cx++) {
          const l = g.get(cx * 100003 + cz);
          if (!l) continue;
          for (const i of l) { if (!seen.has(i)) { seen.add(i); fn(i); } }
        }
      }
    };
    /** Point in a convex polygon (CCW). */
    const inPoly = (p, x, z) => {
      for (let i = 0; i < p.length; i++) {
        const a = p[i];
        const b = p[(i + 1) % p.length];
        if ((b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x) < 0) return false;
      }
      return true;
    };
    /** Shrink a rectangle toward its centre by `m` metres on each side. */
    const erode = (o, m) => ({ ...o, hw: Math.max(0.01, o.hw - m), hd: Math.max(0.01, o.hd - m) });

    /**
     * How far inside a polygon a point lies: the shortest distance from the point to any of
     * the polygon's edges. Used by G15 to tell a party wall from a building in somebody
     * else's plot — a shared wall crosses the boundary by the width of the wall, and 35 m is
     * not a wall.
     */
    const depthInside = (poly, x, z) => {
      let best = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const ex = b.x - a.x;
        const ez = b.z - a.z;
        const l2 = ex * ex + ez * ez;
        const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / l2)) : 0;
        const d = Math.hypot(x - (a.x + ex * t), z - (a.z + ez * t));
        if (d < best) best = d;
      }
      return best;
    };

    const pct = (sorted, p) => {
      if (!sorted.length) return null;
      const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
      return sorted[i];
    };
    const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : +v.toFixed(2));
    const r3 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : +v.toFixed(3));

    // =====================================================================
    // The live city
    // =====================================================================
    const eng = window.__game.engine;
    const ctx = eng.context ?? eng.ctx;
    const city = ctx.get('city');
    const stats = city.stats();
    const obstacles = city.getObstacles();
    const lanes = city.getLanes ? city.getLanes() : [];
    const landmarkRefs = city.getLandmarks();
    const assertions = city.getAssertions ? city.getAssertions() : [];

    // The street armature, per map. Imported for the *ways* only — the geometry-side road
    // test below does not use it, so the gate does not depend on it.
    let armature = [];
    let planLandmarks = null;
    let planScaleDeclared = null;
    let precinctDeclared = null;
    /**
     * Owners: id, name, centre and *reach*, used ONLY to decide which named structure a
     * published box or a drawn vertex belongs to. Not a ruler — nothing is graded against
     * it — and the fallback below works without it.
     *
     * Reach matters and its absence was an instrument bug. With a flat 60 m default,
     * nearest-centre attribution handed 635 of the Theatre of Pompey's vertices to Tiber
     * Island, and several of the Cothon's 28 quay boxes to the Tophet 90 m away, which then
     * reported the Tophet as five times its own size. Attribution is by smallest distance
     * **normalised by the claimant's own reach**, which is the structure whose footprint the
     * point is most plausibly inside.
     */
    let owners = null;
    /**
     * The layout REGIONS — Rome's `DISTRICTS`, Carthage's `QUARTERS`. Read as the object
     * under test, not as a ruler: the question asked of them ("do you partition the
     * ground?") is answered against ground sampled from the terrain and the built circuit,
     * and against the number 1.00, which is what a partition means.
     */
    let regions = null;
    /** Rows the frame cannot carry, read as a declaration and printed. `MAP-METHOD.md` rule 16. */
    let regionsOffFrame = [];
    /**
     * The build's own claim about which survey rows are off this map's frame, read as a
     * DECLARATION and graded against `OFF_FRAME_AGREED`, which is typed into the probe. Not a
     * ruler: the question asked of it is "are these the five that were agreed?".
     */
    let declaredOffFrame = null;
    /**
     * The **block plan** — the faces of the road graph, their inset polygons and whether each
     * one is a garden by design. Read as the object under test, exactly as `regions` is: the
     * question asked of it is "does every block that ends with no roof on it have somewhere
     * for the roof to have gone?", and the roof is counted from the SCENE's obstacle set,
     * which the plan has never seen. Rome only; Carthage's fabric has no face plan and G24
     * reads NOT MEASURED with that as its reason.
     */
    let blockPlan = null;
    const importNotes = [];
    try {
      if (MAPID === 'campus-martius') {
        const L = await import('/src/city/rome/layout.ts');
        armature = L.WAYS.map((w) => ({ id: w.id, cls: w.cls, path: w.path, width: w.width }));
        planLandmarks = L.LANDMARKS;
        planScaleDeclared = L.PLAN_SCALE;
        precinctDeclared = L.PRECINCT;
        owners = L.LANDMARKS.map((l) => ({
          id: l.id, name: l.name, x: l.x, z: l.z, reach: Math.hypot(l.hw, l.hd), soft: !!l.soft,
          complex: l.complex ?? null, onRiver: !!l.onRiver, farBank: !!l.farBank,
        }));
        /*
         * **Rome's regions are polygons now, and this reads them as polygons.**
         *
         * `src/city/rome/layout.ts`'s seventeen `DISTRICTS` rectangles are deleted;
         * `src/city/rome/regions.ts` publishes the ten Augustan *regiones* the frame carries,
         * as rings in world metres. It is imported by name and **not** with a fallback to the
         * old export: a silent fallback to a table that no longer exists is how G18 and G19
         * would come back green on a city with no regions at all. If the import fails,
         * `importNotes` says so and both checks read NOT MEASURED, which is a failure.
         */
        const RG = await import('/src/city/rome/regions.ts');
        regions = RG.REGIONS.map((r) => ({ id: r.id, poly: r.poly.map((p) => ({ x: p.x, z: p.z })) }));
        regionsOffFrame = (RG.OFF_FRAME_REGIONES ?? []).map((r) => `${r.numeral} ${r.name}`);
        declaredOffFrame = (L.OFF_MAP_SOUTH ?? []).map((m) => m.id);
        // `cityPlan()` is memoised and the game has already called it, so this is the same
        // object the scene was built from and not a second evaluation of it.
        const FB = await import('/src/city/rome/fabric.ts');
        blockPlan = FB.cityPlan().blocks
          .filter((b) => b.kind === 'block' && b.inset.length >= 3)
          .map((b) => ({
            index: b.index, region: b.region.numeral, horti: !!b.horti,
            cx: b.face.cx, cz: b.face.cz, insetAreaM2: b.insetAreaM2,
            inset: b.inset.map((q) => ({ x: q.x, z: q.z })),
          }));
      } else if (MAPID === 'carthage') {
        const L = await import('/src/city/carthage/layout.ts');
        armature = L.PUNIC_WAYS.map((w) => ({ id: w.id, cls: w.cls, path: w.path, width: w.width }));
        owners = L.MONUMENTS.map((m) => ({
          id: m.id, name: m.name, x: m.x, z: m.z, reach: Math.hypot(m.hw + m.clear, m.hd + m.clear),
          soft: false, complex: m.complex ?? null, onRiver: false, farBank: false,
        }));
        regions = L.QUARTERS.map((q) => ({ id: q.id, x: q.x, z: q.z, hw: q.hw, hd: q.hd, rot: q.rot }));
        declaredOffFrame = [];
      }
    } catch (e) {
      importNotes.push(`plan import failed: ${e && e.message ? e.message : String(e)}`);
    }
    if (!owners) owners = landmarkRefs.map((l) => ({ id: l.id, name: l.name, x: l.x, z: l.z, reach: 60, soft: false, complex: null, onRiver: false, farBank: false }));
    /** The owner whose own footprint a point is most plausibly inside. */
    const ownerAt = (x, z) => {
      let best = null;
      let bs = Infinity;
      for (const q of owners) {
        const s2 = ((q.x - x) ** 2 + (q.z - z) ** 2) / (q.reach * q.reach);
        if (s2 < bs) { bs = s2; best = q; }
      }
      return { owner: best, score: Math.sqrt(bs) };
    };

    // ---- the collision surface, partitioned -----------------------------
    const mk = (o, i) => {
      const poly = obPoly(o);
      return { i, o, poly, bb: bbox(poly), area: 4 * o.hw * o.hd };
    };
    const mons = [];
    const bldgs = [];
    const walls = [];
    obstacles.forEach((o, i) => {
      const e = mk(o, i);
      if (o.kind === 'monument') mons.push(e);
      else if (o.kind === 'building') bldgs.push(e);
      else walls.push(e); // wall | tower | gate
    });
    // Attribute each published monument box to a named structure. By POSITION, not by
    // index — nothing guarantees the obstacle list and the landmark list are parallel — and
    // normalised by reach, so a 28-box quay ring stays one structure. See `ownerAt`.
    for (const e of mons) {
      const a = ownerAt(e.o.x, e.o.z);
      e.id = a.owner ? a.owner.id : `mon#${e.i}`;
      e.name = a.owner ? a.owner.name : `monument #${e.i}`;
      e.soft = a.owner ? a.owner.soft : false;
    }
    bldgs.forEach((e, k) => { e.id = `insula#${k}`; e.name = `insula #${k}`; });
    walls.forEach((e, k) => { e.id = `${e.o.kind}#${k}`; e.name = e.o.kind; });

    const monArea = mons.reduce((s, e) => s + e.area, 0);
    const bldArea = bldgs.reduce((s, e) => s + e.area, 0);
    const builtArea = monArea + bldArea;

    // =====================================================================
    // STRUCTURES AND COMPLEXES
    //
    // Everything above works in published BOXES. A complex is a claim about STRUCTURES — the
    // Theatre of Pompey and its porticus post scaenam are one piece of fabric — and a
    // structure may be several boxes (Carthage's Cothon is thirty-one). So the complex tests
    // run on a structure-level table built from the same boxes, and every gap below is the
    // minimum over the two structures' boxes.
    //
    // `complex` is read from `LANDMARKS`, which is the build's own DECLARATION. That is the
    // point: `MAP-METHOD.md` rule 18 says a check that is wrong about the world gets the
    // missing relation, and the relation is only worth having if the declaration itself is
    // gradeable. What is graded is not "is this pair allowed to touch" — the build asserts
    // that — but "does the drawn city contain the relation the survey asserts".
    // =====================================================================
    const structs = new Map();
    for (const e of mons) {
      let st = structs.get(e.id);
      if (!st) {
        const o = owners.find((q) => q.id === e.id) ?? null;
        structs.set(e.id, (st = {
          id: e.id, name: e.name, soft: !!e.soft,
          complex: o ? (o.complex ?? null) : null,
          onRiver: o ? !!o.onRiver : false, farBank: o ? !!o.farBank : false,
          boxes: [], area: 0, x: e.o.x, z: e.o.z, biggest: 0,
        }));
      }
      st.boxes.push(e);
      st.area += e.area;
      if (e.area > st.biggest) { st.biggest = e.area; st.x = e.o.x; st.z = e.o.z; }
    }
    const structList = [...structs.values()];

    /**
     * The relation between two structures, measured on their boxes and nothing else.
     *
     *  `gapM`     the closest approach. Negative where they interpenetrate, and then it is the
     *             SAT depth, so `-0.9` means nine tenths of a metre of shared masonry.
     *  `nestFrac` the smaller structure's area lying inside the larger, over its own area.
     *  `joined`   nested at `NEST_FRAC`, or abutting at `ABUT_DEPTH_M`. This is G8c's relation
     *             and G8d's edge, and it is the whole cost of declaring a complex.
     */
    const relate = (a, b) => {
      let gap = Infinity;
      let inside = 0;
      for (const ea of a.boxes) {
        for (const eb of b.boxes) {
          const ar = bbClear(ea.bb, eb.bb) ? 0 : clipArea(ea.poly, eb.poly);
          inside += ar;
          const v = ar > TH.NOISE_M2 ? -satDepth(ea.poly, eb.poly) : polyGap(ea.poly, eb.poly);
          if (v < gap) gap = v;
        }
      }
      const smaller = Math.min(a.area, b.area);
      // Boxes of one composite may overlap each other, so the summed clip can exceed the
      // smaller structure's own area. Clamped, and the clamp is only reachable on a composite.
      const nestFrac = smaller > 0 ? Math.min(1, inside / smaller) : 0;
      const nested = nestFrac >= TH.NEST_FRAC;
      const abutting = Math.abs(gap) <= TH.ABUT_DEPTH_M;
      return {
        a, b, gapM: gap, overlapM2: inside, nestFrac, nested, abutting,
        joined: nested || abutting,
        sameComplex: a.complex !== null && a.complex === b.complex,
      };
    };

    /** Every unordered pair of distinct structures, related. 27 structures on Rome, so 351. */
    let structPairs = [];
    for (let i = 0; i < structList.length; i++) {
      for (let j = i + 1; j < structList.length; j++) {
        structPairs.push(relate(structList[i], structList[j]));
      }
    }
    if (injected.has('complex-invent')) {
      const cand = structPairs
        .filter((r) => !r.a.soft && !r.b.soft && !r.sameComplex)
        .sort((x, y) => x.gapM - y.gapM)[0] ?? null;
      if (cand) {
        cand.a.complex = 'INJECTED';
        cand.b.complex = 'INJECTED';
        injectNotes.push(`declared ${cand.a.id} + ${cand.b.id} one complex "INJECTED" (they stand ${cand.gapM.toFixed(2)} m apart)`);
        structPairs = [];
        for (let i = 0; i < structList.length; i++) {
          for (let j = i + 1; j < structList.length; j++) {
            structPairs.push(relate(structList[i], structList[j]));
          }
        }
      } else {
        injectNotes.push('complex-invent found no cross-complex pair to join');
      }
    }

    /**
     * The declared complexes, and whether each is ONE PIECE of fabric.
     *
     * `MAP-METHOD.md` rule 18's test for a correction rather than a relaxation: the new class
     * must be able to fail, and declaring it must take on an obligation rather than shed one.
     * This is the obligation. Union-find over the complex's own rows with an edge wherever
     * `relate().joined`, then count the components — *not* "every pair abuts", because a chain
     * of abutments is one building whose two ends do not touch, and connected is what "one
     * continuous masonry front" means.
     *
     * `connectAtM` is the diagnostic that makes the failure actionable: the smallest gap
     * threshold at which the complex WOULD be one piece, which is the longest edge in its
     * minimum spanning tree. A complex that needs 27 m is not a complex.
     */
    const complexes = (() => {
      const byName = new Map();
      for (const st of structList) {
        if (!st.complex) continue;
        if (!byName.has(st.complex)) byName.set(st.complex, []);
        byName.get(st.complex).push(st);
      }
      const out = [];
      for (const [name, rows] of byName) {
        const idx = new Map(rows.map((r, i) => [r.id, i]));
        const parent = rows.map((_, i) => i);
        const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
        const link = (i, j) => { const a = find(i); const b = find(j); if (a !== b) parent[a] = b; };
        const pairs = [];
        for (let i = 0; i < rows.length; i++) {
          for (let j = i + 1; j < rows.length; j++) {
            const r = relate(rows[i], rows[j]);
            pairs.push(r);
            if (r.joined) link(i, j);
          }
        }
        const comps = new Map();
        for (let i = 0; i < rows.length; i++) {
          const root = find(i);
          if (!comps.has(root)) comps.set(root, []);
          comps.get(root).push(rows[i].id);
        }
        // Kruskal on the gap, to find the threshold that would make it one piece.
        const p2 = rows.map((_, i) => i);
        const f2 = (i) => { while (p2[i] !== i) { p2[i] = p2[p2[i]]; i = p2[i]; } return i; };
        let joinedCount = 0;
        let connectAt = 0;
        for (const r of [...pairs].sort((x, y) => x.gapM - y.gapM)) {
          const a = f2(idx.get(r.a.id));
          const b = f2(idx.get(r.b.id));
          if (a === b) continue;
          p2[a] = b;
          joinedCount++;
          connectAt = Math.max(connectAt, r.gapM);
          if (joinedCount === rows.length - 1) break;
        }
        out.push({
          name, rows: rows.length, members: rows.map((r) => r.id),
          pieces: comps.size,
          piecesDetail: [...comps.values()].map((ids) => ids.join('+')),
          connectAtM: rows.length > 1 ? connectAt : null,
          pairs,
          degenerate: rows.length < 2,
          noMansLand: pairs.filter((r) => r.gapM > TH.ABUT_DEPTH_M && r.gapM < TH.CLEAR_MON_MON),
          apart: pairs.filter((r) => r.gapM >= TH.CLEAR_MON_MON),
          joinedPairs: pairs.filter((r) => r.joined).length,
        });
      }
      out.sort((a, b) => b.rows - a.rows);
      return out;
    })();

    // ---- 1. overlaps, by area ------------------------------------------
    /**
     * Every intersecting pair, split three ways:
     *   - `sameStructure`: two boxes of one composite (same owner id). Never a fault.
     *   - `abutment`:      shallow and small — parts meeting at a joint. See `ABUT_DEPTH_M`.
     *   - `faults`:        everything else. This is what the gate counts.
     * All three are reported; only `faults` is gated.
     */
    const pairsOf = (A, B, same) => {
      const g = makeGrid(B);
      const hits = [];
      let sameStructure = 0;
      let abutment = 0;
      let abutM2 = 0;
      let sum = 0;
      let worstDepth = 0;
      const hitA = new Set();
      const hitB = new Set();
      for (let ia = 0; ia < A.length; ia++) {
        const a = A[ia];
        gridQuery(g, a.bb, 0, (ib) => {
          if (same && ib <= ia) return;
          const b = B[ib];
          if (bbClear(a.bb, b.bb)) return;
          const ar = clipArea(a.poly, b.poly);
          if (ar <= TH.NOISE_M2) return;
          const dep = satDepth(a.poly, b.poly);
          if (a.id !== undefined && a.id === b.id) { sameStructure++; return; }
          if (dep <= TH.ABUT_DEPTH_M && ar <= TH.ABUT_FRAC * Math.min(a.area, b.area)) {
            abutment++;
            abutM2 += ar;
            return;
          }
          sum += ar;
          hitA.add(ia);
          hitB.add(ib);
          if (dep > worstDepth) worstDepth = dep;
          hits.push({
            a: a.name, b: b.name, aId: a.id, bId: b.id, m2: ar, depth: dep,
            ax: a.o.x, az: a.o.z, bx: b.o.x, bz: b.o.z,
            aArea: a.area, bArea: b.area,
          });
        });
      }
      hits.sort((p, q) => q.m2 - p.m2);
      return {
        pairs: hits.length, totalM2: sum, worstM2: hits.length ? hits[0].m2 : 0, worstDepth,
        sameStructure, abutment, abutM2,
        distinctA: hitA.size, distinctB: hitB.size,
        top: hits.slice(0, 12).map((h) => ({
          a: h.a, b: h.b, m2: r2(h.m2), depthM: r2(h.depth),
          pctOfSmaller: r2((h.m2 / Math.max(1e-6, Math.min(h.aArea, h.bArea))) * 100),
          at: { x: r2((h.ax + h.bx) / 2), z: r2((h.az + h.bz) / 2) },
        })),
        raw: hits.slice(0, 40),
      };
    };

    const mm = pairsOf(mons, mons, true);
    const mb = pairsOf(mons, bldgs, false);
    const bb2 = pairsOf(bldgs, bldgs, true);
    const monVsWall = pairsOf(mons, walls, false);

    // ---- monument vs street carriageway --------------------------------
    // Carriageway only, not the frontage setback: a monument in the setback is a tight
    // street; a monument in the carriageway is a street that does not exist.
    const roadSegs = [];
    const pushRibbon = (pathArr, half, id, cls) => {
      for (let i = 0; i + 1 < pathArr.length; i++) {
        const p = segPoly(pathArr[i], pathArr[i + 1], half);
        if (p) roadSegs.push({
          poly: p, bb: bbox(p), id, cls, half,
          len: Math.hypot(pathArr[i + 1].x - pathArr[i].x, pathArr[i + 1].z - pathArr[i].z),
        });
      }
    };
    for (const w of armature) pushRibbon(w.path, w.width * 0.5, w.id, w.cls);
    for (const l of lanes) pushRibbon(l.path, l.width * 0.5, `lane:${l.cls}`, l.cls);
    const roadArea = roadSegs.reduce((s, r) => s + 2 * r.half * r.len, 0);

    const monVsRoad = (() => {
      const g = makeGrid(roadSegs);
      const per = new Map();
      let n = 0;
      let sum = 0;
      for (const m of mons) {
        gridQuery(g, m.bb, 0, (ir) => {
          const r = roadSegs[ir];
          if (bbClear(m.bb, r.bb)) return;
          const ar = clipArea(m.poly, r.poly);
          if (ar <= TH.NOISE_M2) return;
          n++;
          sum += ar;
          const cur = per.get(m.id) ?? { id: m.id, name: m.name, m2: 0, segs: 0, ways: new Set(), x: m.o.x, z: m.o.z, area: m.area };
          cur.m2 += ar;
          cur.segs++;
          cur.ways.add(r.id);
          per.set(m.id, cur);
        });
      }
      const list = [...per.values()].sort((a, b) => b.m2 - a.m2);
      return {
        segmentHits: n, totalM2: sum, monumentsInvolved: list.length,
        carriagewayM2: roadArea,
        pctOfCarriageway: roadArea > 0 ? (sum / roadArea) * 100 : null,
        top: list.slice(0, 12).map((e) => ({
          monument: e.name, m2: r2(e.m2), pctOfOwnFootprint: r2((e.m2 / e.area) * 100),
          segments: e.segs, ways: [...e.ways].slice(0, 8), at: { x: r2(e.x), z: r2(e.z) },
        })),
        all: list,
      };
    })();

    // =====================================================================
    // The drawn stone: read the vertices that will actually be rasterised.
    // =====================================================================
    const cityRoot = ctx.scene.getObjectByName('city');
    /**
     * Per-structure frame for the drawn read: centre and yaw taken from the LARGEST published
     * box attributed to that structure, so no plan-side rotation convention is involved and a
     * composite is measured in the frame of its own main mass.
     */
    const frames = new Map();
    for (const e of mons) {
      const cur = frames.get(e.id);
      if (!cur || e.area > cur.area) frames.set(e.id, { id: e.id, name: e.name, x: e.o.x, z: e.o.z, rot: e.o.rot, area: e.area, soft: e.soft });
    }
    for (const o of owners) {
      if (!frames.has(o.id)) frames.set(o.id, { id: o.id, name: o.name, x: o.x, z: o.z, rot: 0, area: 0, soft: o.soft });
    }
    const monAcc = new Map();
    const geomStats = { monumentVerts: 0, monumentAttributed: 0, streetVerts: 0, wallVerts: 0, groups: [] };
    // Drawn carriageway / drawn wall standing inside a monument footprint.
    const roadInMon = new Map();
    const wallInMon = new Map();
    const monErodedPolys = mons.map((m) => ({ id: m.id, name: m.name, poly: obPoly(erode(m.o, 0.5)), bb: m.bb }));
    const monPolyGrid = makeGrid(monErodedPolys.map((m) => ({ bb: m.bb })));
    /**
     * Every *other* structure's footprint, for the test that asks the question the build
     * has never asked: is a monument's drawn stone standing inside somebody else's plot?
     * Eroded 0.5 m so a shared kerb line is not a hit.
     */
    const plots = [...mons, ...bldgs].map((e) => ({ id: e.id, name: e.name, kind: e.o.kind, poly: obPoly(erode(e.o, 0.5)), bb: e.bb, cx: e.o.x, cz: e.o.z }));
    const plotGrid = makeGrid(plots.map((e) => ({ bb: e.bb })));
    const stoneInMon = new Map();
    const stoneInBld = new Map();
    /** Landscape underlying masonry. Recorded, never gated. See the comment at the sink. */
    const stoneSoft = new Map();

    if (cityRoot) {
      cityRoot.traverse((n) => {
        if (!n.isMesh) return;
        const gname = n.parent ? n.parent.name : '';
        if (!/-lod0$/.test(gname)) return;          // full-detail level only
        if (/-shadow$/.test(n.name || '')) return;  // never a shadow proxy
        const pos = n.geometry && n.geometry.attributes && n.geometry.attributes.position;
        if (!pos) return;
        const arr = pos.array;
        // A monument's stone is not always filed under `monuments-`: Carthage draws its
        // harbours and its citadel in their own families and they are monuments to a man
        // walking into them.
        const isMon = /^(monuments|harbour|byrsa)(-|$)/.test(gname);
        const isStreet = /^streets(-|$)/.test(gname);
        // `gate-*` chunks are the gatehouse and its leaves: the same masonry, a different family.
        const isWall = /^(wall|gate|postern)(-|$)/.test(gname);
        if (!isMon && !isStreet && !isWall) return;
        if (!geomStats.groups.includes(gname)) geomStats.groups.push(gname);

        if (isMon) {
          // On Carthage each monument gets its own chunk (`monuments-<id>`), so attribution
          // is by name. On Rome they are merged into three depth bands, so it is
          // nearest-centre inside 1.6× the monument's own reserved circumradius; a vertex
          // beyond that is left unclaimed rather than folded into somebody's dimensions.
          const suffix = gname.replace(/^(monuments|harbour|byrsa)-/, '').replace(/-lod0$/, '');
          const direct = frames.get(suffix) ?? null;
          for (let k = 0; k + 2 < arr.length; k += 3) {
            const x = arr[k];
            const y = arr[k + 1];
            const z = arr[k + 2];
            geomStats.monumentVerts++;
            let c = direct;
            if (!c) {
              const a = ownerAt(x, z);
              // 1.6x the claimant's own reach. A vertex beyond that is left unclaimed rather
              // than folded into somebody else's dimensions.
              if (!a.owner || a.score > 1.6) continue;
              c = frames.get(a.owner.id) ?? { id: a.owner.id, name: a.owner.name, x: a.owner.x, z: a.owner.z, rot: 0, soft: a.owner.soft };
            }
            let e = monAcc.get(c.id);
            if (!e) monAcc.set(c.id, (e = { u: [], v: [], yMax: -Infinity, n: 0 }));
            const cs = Math.cos(c.rot);
            const sn = Math.sin(c.rot);
            const dx = x - c.x;
            const dz = z - c.z;
            e.u.push(dx * cs + dz * sn);
            e.v.push(-dx * sn + dz * cs);
            if (y > e.yMax) e.yMax = y;
            e.n++;
            geomStats.monumentAttributed++;
            // Subsampled 1 vertex in 4: a hit is a region, not a point.
            if ((e.n & 3) !== 0) continue;
            gridQuery(plotGrid, { x0: x, x1: x, z0: z, z1: z }, 0, (pi) => {
              const q = plots[pi];
              if (q.id === c.id) return;                 // its own plot is not a trespass
              if (!inPoly(ccw(q.poly), x, z)) return;
              // Landscape is allowed to underlie masonry, and the survey says so in as many
              // words: "a temple standing in the middle of the Horti Sallustiani is how Rome
              // actually worked". So a garden, a planted ridge or an island is recorded and
              // not gated.
              const sink = c.soft ? stoneSoft : (q.kind === 'monument' ? stoneInMon : stoneInBld);
              const key = `${c.id}>${q.id}`;
              const cur = sink.get(key) ?? {
                stone: c.name, standingIn: q.name, stoneId: c.id, intoId: q.id,
                hits: 0, x: 0, z: 0, deepestM: 0, toFarEdgeM: null,
              };
              cur.hits++;
              cur.x = x;
              cur.z = z;
              // How far past the boundary this vertex is. `q.poly` is eroded 0.5 m (see
              // `plots`), so the true depth is half a metre more and the 0.5 is added back:
              // a party wall must not be reported as a trespass by the width of the erosion.
              const dIn = depthInside(q.poly, x, z) + 0.5;
              if (dIn > cur.deepestM) { cur.deepestM = dIn; cur.x = x; cur.z = z; }
              /*
               * And how close this vertex gets to the container's FAR boundary, which is what
               * "through its far side" means. The axis is from the container's centre toward the
               * trespasser's centre; `far` is the container's own reach along the opposite
               * direction; `s` is how far past the centre this vertex has travelled that way.
               * `far - s` is what is left on the other side, and once that is a party wall's
               * thickness the stone has crossed the building.
               */
              const cx = q.cx;
              const cz = q.cz;
              let ux = c.x - cx;
              let uz = c.z - cz;
              const ul = Math.hypot(ux, uz);
              if (ul > 1e-6) {
                ux /= ul;
                uz /= ul;
                let far = 0;
                for (const v of q.poly) {
                  const t = -((v.x - cx) * ux + (v.z - cz) * uz);
                  if (t > far) far = t;
                }
                const sProj = -((x - cx) * ux + (z - cz) * uz);
                const left = far - sProj;
                if (cur.toFarEdgeM === null || left < cur.toFarEdgeM) cur.toFarEdgeM = left;
              }
              sink.set(key, cur);
            });
          }
          return;
        }

        // Street or wall geometry: is any of it drawn inside a monument's footprint?
        const sink = isStreet ? roadInMon : wallInMon;
        // Subsample: a ribbon carries several vertices per metre and a hit is a region,
        // not a point, so every 4th vertex is plenty and keeps this under a second.
        for (let k = 0; k + 2 < arr.length; k += 12) {
          const x = arr[k];
          const z = arr[k + 2];
          if (isStreet) geomStats.streetVerts++; else geomStats.wallVerts++;
          gridQuery(monPolyGrid, { x0: x, x1: x, z0: z, z1: z }, 0, (mi) => {
            const m = monErodedPolys[mi];
            if (!inPoly(ccw(m.poly), x, z)) return;
            const cur = sink.get(m.id) ?? { id: m.id, name: m.name, hits: 0 };
            cur.hits++;
            sink.set(m.id, cur);
          });
        }
      });
    }

    const drawn = new Map();
    for (const [id, e] of monAcc) {
      e.u.sort((a, b) => a - b);
      e.v.sort((a, b) => a - b);
      // 0.5/99.5 percentile rather than min/max, so one stray vertex that slipped past the
      // attribution radius cannot set a dimension.
      drawn.set(id, {
        u: pct(e.u, 0.995) - pct(e.u, 0.005),
        v: pct(e.v, 0.995) - pct(e.v, 0.005),
        yMax: e.yMax, n: e.n,
      });
    }

    // =====================================================================
    // 2. Clearance
    // =====================================================================
    const all = [...mons, ...bldgs];
    const gAll = makeGrid(all);
    const clearances = [];
    const negs = [];
    const classMin = {}; // 'monument/monument' etc -> worst clearance seen
    const noteClass = (ka, kb, v, a, b) => {
      const key = [ka, kb].sort().join('/');
      if (!(key in classMin) || v < classMin[key].m) classMin[key] = { m: v, a, b };
    };
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      let best = Infinity;
      let who = null;
      for (const pad of [0, 12, 40, 120, 400]) {
        gridQuery(gAll, a.bb, pad, (j) => {
          if (j === i) return;
          const b = all[j];
          const ar = bbClear(a.bb, b.bb) ? 0 : clipArea(a.poly, b.poly);
          if (ar > TH.NOISE_M2 && a.id !== undefined && a.id === b.id) return; // one structure
          const dep = ar > TH.NOISE_M2 ? satDepth(a.poly, b.poly) : 0;
          // A joint between two parts of one composite is not a clearance failure. Same
          // discriminator as `pairsOf`; see `ABUT_DEPTH_M`.
          if (ar > TH.NOISE_M2 && dep <= TH.ABUT_DEPTH_M && ar <= TH.ABUT_FRAC * Math.min(a.area, b.area)) return;
          const v = ar > TH.NOISE_M2 ? -dep : polyGap(a.poly, b.poly);
          noteClass(a.o.kind, b.o.kind, v, a.name, b.name);
          if (v < best) { best = v; who = b; }
        });
        if (Number.isFinite(best) && best < pad) break;
      }
      if (!Number.isFinite(best)) continue;
      clearances.push(best);
      if (best < 0) negs.push({ a: a.name, b: who ? who.name : '?', m: best, x: a.o.x, z: a.o.z, kinds: `${a.o.kind}/${who ? who.o.kind : '?'}` });
    }
    clearances.sort((p, q) => p - q);
    negs.sort((p, q) => p.m - q.m);

    const clearance = {
      structures: clearances.length,
      negative: clearances.filter((v) => v < 0).length,
      underHalfM: clearances.filter((v) => v >= 0 && v < 0.5).length,
      underOneM: clearances.filter((v) => v >= 0 && v < 1).length,
      underAmbitus: clearances.filter((v) => v >= 0 && v < TH.CLEAR_MON_BLD).length,
      min: r2(clearances[0]), p01: r2(pct(clearances, 0.01)), p05: r2(pct(clearances, 0.05)),
      p25: r2(pct(clearances, 0.25)), median: r2(pct(clearances, 0.5)),
      p75: r2(pct(clearances, 0.75)), p95: r2(pct(clearances, 0.95)),
      max: r2(clearances[clearances.length - 1]),
      byClass: Object.fromEntries(Object.entries(classMin).map(([k, v]) => [k, { minM: r2(v.m), between: `${v.a} / ${v.b}` }])),
      worstNegative: negs.slice(0, 12).map((e) => ({ a: e.a, b: e.b, m: r2(e.m), kinds: e.kinds, at: { x: r2(e.x), z: r2(e.z) } })),
    };

    // =====================================================================
    // 3. Footprint fidelity against the published dimensions
    // =====================================================================
    /**
     * One oriented extent per structure, from EVERY published box attributed to it.
     *
     * `mons.find(id)` was wrong and Carthage proved it: the Cothon is 28 quay boxes plus an
     * island, so `find` returned whichever 8 m quay segment came first and reported the
     * 325 m harbour at 0.098 of its published size. A composite has to be aggregated, and
     * the frame is its own largest box (see `frames`), so no rotation convention enters.
     */
    const aggregate = new Map();
    for (const e of mons) {
      const f = frames.get(e.id);
      if (!f) continue;
      let acc = aggregate.get(e.id);
      if (!acc) aggregate.set(e.id, (acc = { u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity, boxes: 0, x: f.x, z: f.z, rot: f.rot }));
      const cs = Math.cos(f.rot);
      const sn = Math.sin(f.rot);
      for (const q of e.poly) {
        const dx = q.x - f.x;
        const dz = q.z - f.z;
        const u = dx * cs + dz * sn;
        const v = -dx * sn + dz * cs;
        if (u < acc.u0) acc.u0 = u;
        if (u > acc.u1) acc.u1 = u;
        if (v < acc.v0) acc.v0 = v;
        if (v > acc.v1) acc.v1 = v;
      }
      acc.boxes++;
    }
    const rows = PUB ?? [];
    const fid = [];
    for (const row of rows) {
      const agg = aggregate.get(row.id) ?? null;
      const m = agg ? { o: { hw: (agg.u1 - agg.u0) / 2, hd: (agg.v1 - agg.v0) / 2, x: agg.x, z: agg.z, rot: agg.rot }, boxes: agg.boxes } : null;
      const d = drawn.get(row.id) ?? null;
      const pubLong = Math.max(row.len, row.wid);
      const pubShort = Math.min(row.len, row.wid);
      const pubAspect = pubLong / pubShort;
      // The collision box is what the sim uses. On Rome it is `hw × 0.88` of the reserved
      // precinct and the precinct is `PRECINCT` of the building, so back both out where the
      // plan declares them; where it does not, the box is reported raw and labelled.
      const shrink = MAPID === 'campus-martius' ? 0.88 : 1;
      const prec = MAPID === 'campus-martius' ? (row.prec ?? 1.07) : 1;
      const boxLong = m ? Math.max(2 * m.o.hw, 2 * m.o.hd) : null;
      const boxShort = m ? Math.min(2 * m.o.hw, 2 * m.o.hd) : null;
      const planLong = m ? boxLong / shrink / prec : null;
      const planShort = m ? boxShort / shrink / prec : null;
      const drawnLong = d ? Math.max(d.u, d.v) : null;
      const drawnShort = d ? Math.min(d.u, d.v) : null;
      fid.push({
        id: row.id, name: row.name, conf: row.conf, gate: !!row.gate, alt: !!row.alt,
        absentExpected: !!row.absentExpected, offFrame: !!row.offFrame,
        publishedLong: pubLong, publishedShort: pubShort, publishedAspect: r3(pubAspect),
        present: !!m,
        publishedBoxes: m ? m.boxes : 0,
        collisionBox: m ? `${r2(boxLong)} x ${r2(boxShort)}` : null,
        planLong: r2(planLong), planShort: r2(planShort),
        planAspect: r3(planLong === null ? null : planLong / planShort),
        planScaleRatio: r3(planLong === null ? null : planLong / pubLong),
        drawnLong: r2(drawnLong), drawnShort: r2(drawnShort),
        drawnAspect: r3(drawnLong === null ? null : drawnLong / drawnShort),
        drawnScaleRatio: r3(drawnLong === null ? null : drawnLong / pubLong),
        drawnTopY: r2(d ? d.yMax : null), drawnVerts: d ? d.n : 0,
        aspectErrPlan: r3(planLong === null ? null : Math.abs((planLong / planShort) / pubAspect - 1)),
        aspectErrDrawn: r3(drawnLong === null ? null : Math.abs((drawnLong / drawnShort) / pubAspect - 1)),
        src: row.src,
      });
    }
    // The cohort's own median scale ratio IS the measured plan compression — derived from
    // the model against the literature, not read from any constant.
    const gated = fid.filter((f) => f.gate && f.present && !f.absentExpected);
    const planRatios = gated.map((f) => f.planScaleRatio).filter((v) => v !== null).sort((a, b) => a - b);
    const drawnRatios = gated.map((f) => f.drawnScaleRatio).filter((v) => v !== null).sort((a, b) => a - b);
    const medPlan = pct(planRatios, 0.5);
    const medDrawn = pct(drawnRatios, 0.5);
    for (const f of fid) {
      f.scaleErrPlan = f.planScaleRatio === null || medPlan === null ? null : r3(Math.abs(f.planScaleRatio / medPlan - 1));
      f.scaleErrDrawn = f.drawnScaleRatio === null || medDrawn === null ? null : r3(Math.abs(f.drawnScaleRatio / medDrawn - 1));
    }
    /**
     * The cohort's distribution — REPORTED, NOT GATED. This is what retired G13 used to gate
     * and `MAP-METHOD.md` rule 17 is why it is still printed: *"a per-item authored departure
     * must be graded on the distribution it produces and not only on each item"*, and the
     * sentence that rule wants about this build is a median of 0.667 with a 5.26x spread.
     * Sample size is printed with it, because a median of three rows is not a cohort.
     */
    const cohort = {
      n: gated.length,
      medianDrawnOverPublished: r3(medDrawn),
      medianPlanOverPublished: r3(medPlan),
      minDrawnOverPublished: r3(drawnRatios[0] ?? null),
      maxDrawnOverPublished: r3(drawnRatios[drawnRatios.length - 1] ?? null),
      spreadX: drawnRatios.length > 1 && drawnRatios[0] > 0
        ? r2(drawnRatios[drawnRatios.length - 1] / drawnRatios[0]) : null,
      note: 'reported only. G13 gated this and is retired; G13a and G13b gate against PUBLISHED.',
    };

    /**
     * G13a — the ABSOLUTE band. Drawn long dimension over published long dimension, per row,
     * against `SCALE_FLOOR` and `1 + SCALE_CEIL_TOL`.
     *
     * Per-ROW, not a statistic, so a sample of two is two verdicts rather than a collapsed
     * average — which is why this reads on Carthage's two rows and G13b does not. The ruler is
     * `PUBLISHED`, typed into this file, so agreeing with `survey.ts` cannot satisfy it.
     */
    const band = (() => {
      const rowsIn = gated.filter((f) => f.drawnScaleRatio !== null);
      const lo = rowsIn.filter((f) => f.drawnScaleRatio < TH.SCALE_FLOOR);
      const hi = rowsIn.filter((f) => f.drawnScaleRatio > 1 + TH.SCALE_CEIL_TOL);
      return {
        n: rowsIn.length,
        belowFloor: lo.sort((a, b) => a.drawnScaleRatio - b.drawnScaleRatio)
          .map((f) => ({ id: f.id, ratio: f.drawnScaleRatio, drawnLong: f.drawnLong, publishedLong: f.publishedLong })),
        aboveCeiling: hi.sort((a, b) => b.drawnScaleRatio - a.drawnScaleRatio)
          .map((f) => ({ id: f.id, ratio: f.drawnScaleRatio, drawnLong: f.drawnLong, publishedLong: f.publishedLong })),
      };
    })();

    /**
     * G13b — the SIZE ORDER, which is the check nobody had.
     *
     * The previous phase proved **0 of 860 inverted position relations** and the tree read that
     * as covering the ground. It does not: a uniform plan scale preserves size order by
     * definition and twenty-seven authored footprints have no reason to. The reference is two
     * typed-in published dimensions, so this is not the survey grading its own `draw`.
     *
     * A pair only counts where the published figures differ by more than
     * `SIZE_ORDER_MIN_RATIO` — two monuments published within the literature's own spread of
     * each other are not asserting an order, and grading one would be grading noise. Below
     * `SIZE_ORDER_MIN_PAIRS` asserting pairs the check REFUSES rather than reports, per rule 12.
     */
    const order = (() => {
      const rowsIn = gated.filter((f) => f.drawnScaleRatio !== null && !f.alt);
      const seen = new Set();
      const uniq = [];
      for (const f of rowsIn) { if (!seen.has(f.id)) { seen.add(f.id); uniq.push(f); } }
      const inverted = [];
      let asserting = 0;
      for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < uniq.length; j++) {
          const a = uniq[i];
          const b = uniq[j];
          const pubR = Math.max(a.publishedLong, b.publishedLong) / Math.min(a.publishedLong, b.publishedLong);
          if (!(pubR > TH.SIZE_ORDER_MIN_RATIO)) continue;
          asserting++;
          if ((a.publishedLong - b.publishedLong) * (a.drawnLong - b.drawnLong) >= 0) continue;
          const big = a.publishedLong > b.publishedLong ? a : b;
          const small = a.publishedLong > b.publishedLong ? b : a;
          inverted.push({
            biggerPublished: big.id, smallerPublished: small.id,
            publishedRatio: r2(big.publishedLong / small.publishedLong),
            drawnRatio: r2(big.drawnLong / small.drawnLong),
            wrongByX: r2((big.publishedLong / small.publishedLong) / (big.drawnLong / small.drawnLong)),
            publishedM: `${big.publishedLong} v ${small.publishedLong}`,
            drawnM: `${big.drawnLong} v ${small.drawnLong}`,
          });
        }
      }
      inverted.sort((x, y) => y.wrongByX - x.wrongByX);
      /**
       * The same count over the wider SOURCED population — every row with a citation, gated or
       * not. Reported and never gated, because several of those rows are a documented choice
       * between two published readings of one monument (the Baths of Trajan's precinct against
       * its block), and an inversion there is a design decision rather than a fault.
       */
      const wide = (() => {
        const w = [];
        const seenW = new Set();
        for (const f of fid) {
          if (f.conf === 'unsourced' || f.alt || !f.present || f.drawnLong === null) continue;
          if (seenW.has(f.id)) continue;
          seenW.add(f.id);
          w.push(f);
        }
        let tot = 0;
        let inv = 0;
        for (let i = 0; i < w.length; i++) {
          for (let j = i + 1; j < w.length; j++) {
            const pubR = Math.max(w[i].publishedLong, w[j].publishedLong) / Math.min(w[i].publishedLong, w[j].publishedLong);
            if (!(pubR > TH.SIZE_ORDER_MIN_RATIO)) continue;
            tot++;
            if ((w[i].publishedLong - w[j].publishedLong) * (w[i].drawnLong - w[j].drawnLong) < 0) inv++;
          }
        }
        return { rows: w.length, assertingPairs: tot, inverted: inv };
      })();
      return {
        rows: uniq.length, assertingPairs: asserting, invertedPairs: inverted.length,
        pctInverted: asserting > 0 ? r2((inverted.length / asserting) * 100) : null,
        enough: asserting >= TH.SIZE_ORDER_MIN_PAIRS,
        worst: inverted.slice(0, 12),
        widerSourcedPopulation_notGated: wide,
      };
    })();

    // =====================================================================
    // 4. Where the ordinary fabric comes from
    // =====================================================================
    const laneKm = lanes.reduce((s, l) => {
      let d = 0;
      for (let i = 0; i + 1 < l.path.length; i++) d += Math.hypot(l.path[i + 1].x - l.path[i].x, l.path[i + 1].z - l.path[i].z);
      return s + d;
    }, 0) / 1000;
    const armKm = armature.reduce((s, w) => {
      let d = 0;
      for (let i = 0; i + 1 < w.path.length; i++) d += Math.hypot(w.path[i + 1].x - w.path[i].x, w.path[i + 1].z - w.path[i].z);
      return s + d;
    }, 0) / 1000;
    const fabric = {
      monuments: mons.length, monumentAreaM2: r2(monArea),
      buildings: bldgs.length, buildingAreaM2: r2(bldArea),
      wallSolids: walls.length,
      armatureWays: armature.length, armatureKm: r2(armKm),
      districtLanes: lanes.length, laneKm: r2(laneKm),
      carriagewayM2: r2(roadArea),
      wayMix: stats.ways,
      declaredPlanScale: planScaleDeclared, declaredPrecinct: precinctDeclared,
    };

    // =====================================================================
    // 5. The resolver — measured once, cheaply, because it is being demoted.
    // =====================================================================
    let resolver = null;
    if (planLandmarks) {
      const build = (useIdeal) => planLandmarks.filter((l) => !l.soft).map((l) => {
        const box = { x: useIdeal ? l.idealX : l.x, z: useIdeal ? l.idealZ : l.z, hw: l.hw, hd: l.hd, rot: l.rot };
        const poly = planPoly(box);
        return { id: l.id, name: l.name, o: box, poly, bb: bbox(poly), area: 4 * l.hw * l.hd };
      });
      const score = (list) => {
        const g = makeGrid(list);
        let sum = 0;
        let worst = 0;
        const hits = [];
        for (let i = 0; i < list.length; i++) {
          gridQuery(g, list[i].bb, 0, (j) => {
            if (j <= i) return;
            if (bbClear(list[i].bb, list[j].bb)) return;
            const ar = clipArea(list[i].poly, list[j].poly);
            if (ar <= TH.NOISE_M2) return;
            sum += ar;
            const dep = satDepth(list[i].poly, list[j].poly);
            if (dep > worst) worst = dep;
            hits.push({ a: list[i].name, b: list[j].name, m2: ar, depth: dep });
          });
        }
        hits.sort((p, q) => q.m2 - p.m2);
        return { pairs: hits.length, totalM2: r2(sum), worstDepthM: r2(worst), top: hits.slice(0, 6).map((h) => ({ a: h.a, b: h.b, m2: r2(h.m2), depthM: r2(h.depth) })) };
      };
      const drift = planLandmarks.filter((l) => !l.soft)
        .map((l) => ({ name: l.name, m: Math.hypot(l.x - l.idealX, l.z - l.idealZ), dx: l.x - l.idealX, dz: l.z - l.idealZ }))
        .sort((a, b) => b.m - a.m);
      const dv = drift.map((d) => d.m).sort((a, b) => a - b);
      resolver = {
        exists: true,
        note: 'Same rectangles, two positions: `idealX/idealZ` is the survey projection before '
          + '`resolveOverlaps` ran, `x/z` is where it left them. Nothing else differs, so the '
          + 'delta is the resolver and only the resolver.',
        monuments: drift.length,
        beforeResolver: score(build(true)),
        afterResolver: score(build(false)),
        driftMeanM: r2(drift.reduce((s, d) => s + d.m, 0) / Math.max(1, drift.length)),
        driftMedianM: r2(pct(dv, 0.5)),
        driftMaxM: r2(dv[dv.length - 1]),
        driftWorst: drift.slice(0, 8).map((d) => ({ name: d.name, m: r2(d.m), dx: r2(d.dx), dz: r2(d.dz) })),
      };
    } else {
      resolver = {
        exists: false,
        note: 'This plan has no overlap resolver. src/city/carthage/plan.ts: "Monuments, the '
          + 'citadel and the harbours - authored at final coordinates, built, and their '
          + 'footprints taken. **No resolver.**"',
      };
    }

    // =====================================================================
    // 6. Do the layout regions PARTITION the ground? And does the fabric's
    //    grain come from the streets or from a hash?
    //
    // These two measure `ROME-FABRIC.md` §2.3's second, independent fault — the
    // one that produced the quilt and that has nothing to do with PLAN_SCALE.
    // No overlap test can see it: seventeen rectangles can claim 266% of the
    // city while every *building* footprint is disjoint, because the plot grid
    // simply gives contested ground to whichever quarter was planned first.
    // =====================================================================

    /**
     * Available ground, sampled from the TERRAIN and the BUILT CIRCUIT — never from the
     * region list, so the denominator cannot flatter the numerator.
     *
     * Land inside the defended line: behind the circuit `CitySystem.getCircuitSamples()`
     * publishes (which is derived from the baked bays, not from a layout constant), above
     * water, inside the heightfield.
     */
    const circuit = city.getCircuitSamples ? city.getCircuitSamples(20) : [];
    const circuitZAt = (x) => {
      if (circuit.length === 0) return -Infinity;
      if (x <= circuit[0].x) return circuit[0].z;
      if (x >= circuit[circuit.length - 1].x) return circuit[circuit.length - 1].z;
      for (let i = 0; i + 1 < circuit.length; i++) {
        if (x >= circuit[i].x && x <= circuit[i + 1].x) {
          const t = (x - circuit[i].x) / Math.max(1e-6, circuit[i + 1].x - circuit[i].x);
          return circuit[i].z + (circuit[i + 1].z - circuit[i].z) * t;
        }
      }
      return circuit[circuit.length - 1].z;
    };
    const terrain = ctx.tryGet ? ctx.tryGet('terrain') : null;
    const terrainWaterLevel = terrain ? (terrain.waterLevel ?? 0) : null;

    // =====================================================================
    // G22 — nothing stands under the water surface.
    //
    // `heightAt` appeared ONCE in the two thousand lines of this file before this pass, in
    // G19's denominator, and the judge's §7.9 had measured sixty solids entirely below the
    // water line two phases earlier. The datum is `terrain.waterLevel` — the height the
    // renderer actually draws the water at, per map, 5.0 m on Rome and the sea level on
    // Carthage — because the question is not "where does the survey think the river is" but
    // "is this masonry under the water the player can see".
    //
    // Five samples per solid: the centre and the four corners of its own oriented box. A
    // solid is a FAULT when its centre is under the surface; `cornersWet` and `allWet` are
    // reported beside it, because a building with two wet corners is on a bank and a building
    // with five is in the channel, and the two want different fixes.
    //
    // Every exclusion is named, counted, and gated on its MEMBERSHIP against `WATER_EXPECTED`
    // — `MAP-METHOD.md` rule 16, and the condition the judge attached to endorsing this check.
    // =====================================================================
    const water = (() => {
      if (!terrain || typeof terrain.heightAt !== 'function') {
        return { measured: false, why: 'no terrain system in this context' };
      }
      const level = typeof terrain.waterLevel === 'number' ? terrain.waterLevel : null;
      if (level === null) return { measured: false, why: 'the terrain publishes no waterLevel' };
      const okIds = new Set(WATER_OK.map((w) => w.id));
      const sampled = [];
      const rowsFor = (list, kind) => {
        for (const e of list) {
          const pts = [{ x: e.o.x, z: e.o.z }, ...e.poly.map((q) => ({ x: q.x, z: q.z }))];
          const hs = pts.map((q) => terrain.heightAt(q.x, q.z));
          const centreH = hs[0];
          const cornersWet = hs.slice(1).filter((h) => h <= level).length;
          sampled.push({
            id: e.id, name: e.name, kind,
            centreDatumM: r2(centreH), cornersWet, corners: hs.length - 1,
            centreWet: centreH <= level,
            allWet: hs.every((h) => h <= level),
            areaM2: e.area, x: r2(e.o.x), z: r2(e.o.z),
          });
        }
      };
      rowsFor(mons, 'monument');
      rowsFor(bldgs, 'building');
      rowsFor(walls, 'wall');
      const wet = sampled.filter((r) => r.centreWet);
      const excluded = wet.filter((r) => okIds.has(r.id));
      const faults = wet.filter((r) => !okIds.has(r.id));
      /*
       * The exclusion accounting, gated on MEMBERSHIP rather than on length — and it
       * distinguishes two ways a licence can go unused, because the first draft of this check
       * conflated them and reported a false fault.
       *
       *  - **stale**: the row publishes solids and none of them is wet. The list is describing
       *    a city that is no longer here, which is rule 13's "check that goes dark", and it is
       *    a fault.
       *  - **not built**: the row publishes no collision solid at all. Rome's `tiber-island` is
       *    `soft` landscape and is not in `getObstacles()`, so there is nothing to be wet. That
       *    is not a stale list, it is a licence held against a row that may become solid later,
       *    and faulting it would fault the probe rather than the city. Reported, not gated.
       */
      const solidIds = new Set(sampled.map((r) => r.id));
      const excludedIds = new Set(excluded.map((r) => r.id));
      const staleLicences = WATER_OK.filter((w) => !excludedIds.has(w.id) && solidIds.has(w.id));
      const notBuilt = WATER_OK.filter((w) => !solidIds.has(w.id));
      const byName = new Map();
      for (const f of faults) {
        const cur = byName.get(f.id) ?? { id: f.id, name: f.name, kind: f.kind, solids: 0, worstDatumM: 99, allWet: 0, areaM2: 0, x: f.x, z: f.z };
        cur.solids++;
        cur.areaM2 += f.areaM2;
        if (f.centreDatumM < cur.worstDatumM) { cur.worstDatumM = f.centreDatumM; cur.x = f.x; cur.z = f.z; }
        if (f.allWet) cur.allWet++;
        byName.set(f.id, cur);
      }
      return {
        measured: true,
        waterLevelM: level,
        solidsSampled: sampled.length,
        centreWet: wet.length,
        entirelyWet: sampled.filter((r) => r.allWet).length,
        anyCornerWet: sampled.filter((r) => r.cornersWet > 0).length,
        faultSolids: faults.length,
        faultStructures: [...byName.values()].sort((a, b) => a.worstDatumM - b.worstDatumM),
        faultsByKind: {
          monument: faults.filter((r) => r.kind === 'monument').length,
          building: faults.filter((r) => r.kind === 'building').length,
          wall: faults.filter((r) => r.kind === 'wall').length,
        },
        excludedSolids: excluded.length,
        excludedNamed: WATER_OK.map((w) => ({
          id: w.id, why: w.why,
          solidsPublished: sampled.filter((r) => r.id === w.id).length,
          wetSolids: excluded.filter((r) => r.id === w.id).length,
        })),
        staleLicences: staleLicences.map((w) => w.id),
        licencesNotBuiltAsSolids: notBuilt.map((w) => w.id),
        worstWet: sampled.filter((r) => r.cornersWet > 0 || r.centreWet)
          .sort((a, b) => a.centreDatumM - b.centreDatumM).slice(0, 12),
      };
    })();
    const partition = await (async () => {
      if (!regions || !terrain || circuit.length === 0) {
        return { measured: false, why: !regions ? 'no region list for this map' : 'no terrain or no built circuit' };
      }
      const TOPO = await import('/src/terrain/topography.ts');
      const EXT = TOPO.HALF_EXTENT;
      const WATER_DATUM = terrain.waterLevel ?? 0;
      /*
       * A region is a **polygon** here, not a rectangle. Carthage still publishes
       * `{x, z, hw, hd, rot}` quarters and they go through `planPoly` exactly as before, so
       * the control's G18 and G19 must read the same numbers after this change as before it —
       * that is the test that this generalisation is not a relaxation. Rome publishes rings.
       */
      const polys = regions.map((r) => {
        const poly = r.poly ?? planPoly(r);
        return {
          id: r.id, poly: ccw(poly), bb: bbox(poly),
          area: r.poly ? Math.abs(signedArea(poly)) : 4 * r.hw * r.hd,
        };
      });
      const STEP = 8;
      const A = STEP * STEP;
      let available = 0;
      let coveredOnce = 0;
      let claimedCells = 0;
      const perRegion = new Map();
      for (let z = -EXT; z <= EXT; z += STEP) {
        for (let x = -EXT; x <= EXT; x += STEP) {
          const crest = circuitZAt(x);
          if (!(z > crest)) continue;
          /*
           * **`< 0.2` was a dead exclusion and it has never fired on Rome.** `heightAt` is
           * metres above datum and Rome's `WATER_LEVEL` is 5.0, so "water" was being tested
           * four and a half metres under the deepest point of the Tiber's own thalweg
           * (`WATER_LEVEL - 4.6 = 0.4`). Every square metre of the river counted as available
           * ground in G19's denominator. `MAP-METHOD.md` rule 13: a check that goes dark is
           * worse than a check that fails, and an exclusion that can never fire is the same
           * fault inside a denominator. The map publishes its own level and both maps have a
           * different one — Rome 5.0, Carthage's `SEA_LEVEL` — so it is read from the terrain
           * rather than typed.
           */
          if (terrain.heightAt(x, z) <= WATER_DATUM) continue;
          // A monument's own ground is not a region's responsibility, so it is not in the
          // denominator. Taken from the SCENE's obstacle set, which the region list has never
          // seen, so removing it cannot flatter the region list.
          let onMon = false;
          gridQuery(monPolyGrid, { x0: x, x1: x, z0: z, z1: z }, 0, (mi) => {
            if (!onMon && inPoly(ccw(monErodedPolys[mi].poly), x, z)) onMon = true;
          });
          if (onMon) continue;
          available += A;
          let n = 0;
          for (const r of polys) {
            if (x < r.bb.x0 || x > r.bb.x1 || z < r.bb.z0 || z > r.bb.z1) continue;
            // `inPoly` is an all-left test and is only correct for a CONVEX polygon. A regio's
            // ring is not convex, so this uses the crossing number, which is correct for any
            // simple polygon and gives the identical answer on Carthage's rectangles.
            if (!inRing(r.poly, x, z)) continue;
            n++;
            perRegion.set(r.id, (perRegion.get(r.id) ?? 0) + A);
          }
          if (n > 0) coveredOnce += A;
          claimedCells += n * A;
        }
      }
      // Region-versus-region intersection, exactly, from the polygons themselves.
      const declared = polys.reduce((t, r) => t + r.area, 0);
      let pairs = 0;
      let pairM2 = 0;
      const worst = [];
      for (let i = 0; i < polys.length; i++) {
        for (let j = i + 1; j < polys.length; j++) {
          if (bbClear(polys[i].bb, polys[j].bb)) continue;
          // Sutherland-Hodgman needs a convex clip polygon and a regio's ring is not one, so
          // this is the triangulated intersection: exact for any pair of simple polygons, and
          // identical to `clipArea` on the convex rectangles Carthage publishes.
          const ar = polyIntersectArea(polys[i].poly, polys[j].poly);
          if (ar <= TH.NOISE_M2) continue;
          pairs++;
          pairM2 += ar;
          worst.push({ a: polys[i].id, b: polys[j].id, m2: ar });
        }
      }
      worst.sort((a, b) => b.m2 - a.m2);
      return {
        measured: true,
        regions: polys.length,
        availableGroundM2: r2(available),
        declaredRegionAreaM2: r2(declared),
        claimedInsideAvailableM2: r2(claimedCells),
        coveredAtLeastOnceM2: r2(coveredOnce),
        claimedOverAvailable: r3(available > 0 ? claimedCells / available : null),
        // The declared rectangles' own total against the same denominator — the figure
        // `docs/ROME-FABRIC.md` §2.3 quotes as 266%. Larger than `claimedOverAvailable`
        // because part of every fringe district lies over water or outside the circuit.
        declaredOverAvailable: r3(available > 0 ? declared / available : null),
        coverageOverAvailable: r3(available > 0 ? coveredOnce / available : null),
        doubleClaimedM2: r2(claimedCells - coveredOnce),
        overlappingPairs: pairs,
        overlapAreaM2: r2(pairM2),
        offFrame: regionsOffFrame,
        worstOverlaps: worst.slice(0, 10).map((w) => ({ a: w.a, b: w.b, m2: r2(w.m2) })),
        perRegionInsideAvailableM2: [...perRegion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([id, m2]) => ({ id, m2: r2(m2) })),
      };
    })();

    /**
     * **How much of the ground between street lines is under a roof, whose ground the rest of
     * it is, and which block gave up.** G23 and G24, from one raster.
     *
     * `ROME-FABRIC.md` §4.4 check 4 takes 60-70 % from the AGEA 2012 orthophoto of the
     * historic core. Nothing in this file measured it until phase 5, and the reason it is
     * hard is the **denominator**, which the first draft of this check got wrong by 2.7x:
     * "the ground between street lines" is not the ground inside a *regio*. A regio contains
     * the pomerium band, the gardens, the far bank and everything beyond the armature's
     * reach. It is the ground inside a **block** — a face of the road graph, inset from its
     * own bounding streets by their setbacks — and that polygon is exactly what the plan
     * publishes.
     *
     * So the raster walks each block's own inset at 4 m and files every cell:
     *
     *   - **fabric roof** — inside a building box from the scene's obstacle set;
     *   - **monument roof** — inside a monument box from the same set. An orthophoto counts
     *     the Baths of Caracalla as roof and a fabric generator is not responsible for
     *     building them, so this is reported on both sides and taken out of the number that
     *     grades the generator;
     *   - **reserved** — the plan's own `KeepOut`, which is the *input* to the generator and
     *     not its output: monument precincts and their ambitus, the ways' setbacks, the
     *     fourteen squares, the aqueduct corridors and the soft landscape rows. Asking the
     *     keep-out rather than re-deriving it is `MAP-METHOD.md` rule 29; asking the *input*
     *     rather than the *output* is what keeps this from being circular. The generator can
     *     still fail: it did, on twelve blocks, while this was being written;
     *   - **water** — `terrain.heightAt` at or below `WATER_LEVEL`. The terrain's own answer,
     *     not the generator's, so the generator's 0.45 m quay freeboard is *visible* as
     *     disagreement rather than hidden by agreement;
     *   - **free** — what is left, and what the fabric is answerable for.
     *
     * **It is a footprint measurement, not a roof measurement, and that is stated rather than
     * hidden.** A courtyard insula's footprint is the whole block and its roof is the ring;
     * `MAP-METHOD.md` rule 11 is the same distinction one level up. So this reads high against
     * a photograph, by an amount nothing here has measured, and the honest reading of a pass
     * is the *change* in it.
     */
    const fillAndAbandon = await (async () => {
      if (!blockPlan) {
        return {
          measured: false,
          why: 'no block plan for this map: Carthage\'s fabric is not cut as faces of a road '
            + 'graph, so it publishes no ground-between-street-lines polygon to measure against',
        };
      }
      if (!terrain) return { measured: false, why: 'no terrain' };
      let planKeepOut = null;
      try {
        const L = await import('/src/city/rome/layout.ts');
        planKeepOut = L.romeKeepOut();
      } catch (e) {
        return { measured: false, why: `romeKeepOut() did not import: ${e && e.message ? e.message : String(e)}` };
      }
      // The map's own level, not Rome's constant: `terrain.waterLevel` is `map.terrain.waterLevel`.
      // Plus the freeboard a dry floor needs — see `TH.DRY_FLOOR_FREEBOARD_M`.
      const WL = (terrain.waterLevel ?? 0) + TH.DRY_FLOOR_FREEBOARD_M;
      /** `MIN_PLOT` 7.5 m by `MIN_DEPTH` 9 m: the smallest thing the generator will build. */
      const HOUSE_M2 = 68;
      const STEP = 4;
      const A = STEP * STEP;
      const monGrid = makeGrid(mons);
      const bldGrid = makeGrid(bldgs);
      const T = { all: 0, fabric: 0, monument: 0, reserved: 0, water: 0, free: 0 };
      const per = new Map();
      const rows = [];
      let hortiSkipped = 0;
      const hortiNames = [];
      for (const b of blockPlan) {
        const ring = ccw(b.inset);
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const q of ring) {
          if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
          if (q.z < z0) z0 = q.z; if (q.z > z1) z1 = q.z;
        }
        const c = { all: 0, fabric: 0, monument: 0, reserved: 0, water: 0, free: 0 };
        const nx = Math.max(1, Math.ceil((x1 - x0) / STEP));
        const nz = Math.max(1, Math.ceil((z1 - z0) / STEP));
        const freeCell = new Uint8Array(nx * nz);
        for (let jz = 0; jz < nz; jz++) {
          const z = z0 + STEP / 2 + jz * STEP;
          for (let ix = 0; ix < nx; ix++) {
            const x = x0 + STEP / 2 + ix * STEP;
            if (!inRing(ring, x, z)) continue;
            c.all += A;
            let hit = false;
            gridQuery(bldGrid, { x0: x, x1: x, z0: z, z1: z }, 0, (i) => {
              if (!hit && inRing(ccw(bldgs[i].poly), x, z)) hit = true;
            });
            if (hit) { c.fabric += A; continue; }
            gridQuery(monGrid, { x0: x, x1: x, z0: z, z1: z }, 0, (i) => {
              if (!hit && inRing(ccw(mons[i].poly), x, z)) hit = true;
            });
            if (hit) { c.monument += A; continue; }
            if (planKeepOut.blockedRect(x, z, 0.5, 0.5, 0)) { c.reserved += A; continue; }
            if (terrain.heightAt(x, z) <= WL) { c.water += A; continue; }
            c.free += A;
            freeCell[jz * nx + ix] = 1;
          }
        }
        /*
         * **Room for a house is a *window*, not a total, and the first draft of this check got
         * that wrong twice.** A block 60 % under a monument can have twelve hundred square
         * metres of free ground and no two adjacent square metres of it: the generator is then
         * right to build nothing and a gate on the total calls it a give-up. So the question
         * is asked as the generator asks it — does the smallest thing it will build actually
         * fit?
         *
         * The window is **three cells square, 12 x 12 m**, and the number is geometry rather
         * than taste: the smallest plot is `MIN_PLOT` 7.5 by `MIN_DEPTH` 9, whose diagonal is
         * 11.71 m, so a 12 m square contains it **at whatever bearing the block has** and the
         * probe never needs the block's frame. That makes the test *sufficient* and not
         * necessary — a 7.5 x 9 house can also fit in less, when it happens to line up — which
         * is the right polarity for a gate: it fires only where the generator provably could
         * have built and did not. A 2 x 2 window (8 m) was the first draft and it is 1 m
         * shorter than `MIN_DEPTH` in its own units, so it accused six blocks of giving up on
         * ground no house fits on.
         */
        let window = false;
        for (let jz = 0; jz + 2 < nz && !window; jz++) {
          for (let ix = 0; ix + 2 < nx; ix++) {
            let all = true;
            for (let a = 0; a < 3 && all; a++) for (let b2 = 0; b2 < 3; b2++) {
              if (!freeCell[(jz + a) * nx + ix + b2]) { all = false; break; }
            }
            if (all) { window = true; break; }
          }
        }
        for (const k of Object.keys(T)) T[k] += c[k];
        const e = per.get(b.region) ?? { all: 0, fabric: 0, monument: 0, reserved: 0, water: 0, free: 0 };
        for (const k of Object.keys(c)) e[k] += c[k];
        per.set(b.region, e);
        if (c.fabric > 0) continue;
        if (b.horti) {
          hortiSkipped++;
          if (hortiNames.length < 12) hortiNames.push(`${b.region} at (${r2(b.cx)}, ${r2(b.cz)})`);
          continue;
        }
        rows.push({ region: b.region, x: r2(b.cx), z: r2(b.cz), insetM2: r2(c.all), freeM2: r2(c.free), roomForAHouse: window });
      }
      const allowed = T.fabric + T.free;
      const gaveUp = rows.filter((e) => e.roomForAHouse).sort((a, b) => b.freeM2 - a.freeM2);
      return {
        measured: true,
        stepM: STEP,
        blocks: blockPlan.length,
        betweenStreetLinesM2: r2(T.all),
        fabricRoofM2: r2(T.fabric),
        monumentRoofM2: r2(T.monument),
        reservedM2: r2(T.reserved),
        waterM2: r2(T.water),
        freeGroundM2: r2(T.free),
        allowedGroundM2: r2(allowed),
        /** What grades the generator: fabric over the ground the fabric is allowed. */
        fabricOverAllowed: r3(allowed > 0 ? T.fabric / allowed : null),
        /** What an orthophoto measures: every roof over every square metre between kerbs. */
        allRoofOverAll: r3(T.all > 0 ? (T.fabric + T.monument) / T.all : null),
        /** The number phase 4 quoted, kept so the two passes can be compared. */
        fabricOverAll: r3(T.all > 0 ? T.fabric / T.all : null),
        perRegion: [...per.entries()].sort((a, b) => b[1].all - a[1].all).map(([id, e]) => ({
          id,
          betweenM2: r2(e.all),
          fabricOverAllowed: r3(e.fabric + e.free > 0 ? e.fabric / (e.fabric + e.free) : null),
          allRoofOverAll: r3(e.all > 0 ? (e.fabric + e.monument) / e.all : null),
        })),
        // ---- G24 -----------------------------------------------------------
        houseM2: HOUSE_M2,
        houseWindowM: STEP * 3,
        emptyBlocks: rows.length + hortiSkipped,
        occupiedOrWet: rows.length - gaveUp.length,
        gaveUp: gaveUp.length,
        gaveUpGroundM2: r2(gaveUp.reduce((t, e) => t + e.freeM2, 0)),
        excludedHorti: hortiSkipped,
        excludedHortiNamed: hortiNames,
        worst: gaveUp.slice(0, 15),
      };
    })();

    /**
     * Grain: where does a block's plan orientation come from?
     *
     * Two independent readings of the same question.
     *  - **against the streets**, which are upstream of the block generator: the angle between
     *    each building's own u axis and the nearest street centreline, folded into [0°, 45°]
     *    because a block parallel and a block perpendicular to its street are both "aligned".
     *  - **against its neighbours**: the same fold between blocks within `GRAIN_NEIGHBOUR_M`.
     *    This one needs no street network at all, so it works on a map whose armature this
     *    probe cannot import.
     */
    const grain = (() => {
      const foldDeg = (rad) => {
        let d = (Math.abs(rad) * 180) / Math.PI % 90;
        if (d > 45) d = 90 - d;
        return d;
      };
      // Street bearings, from the same segment rectangles the carriageway test uses.
      const segs = roadSegs.map((r) => {
        const a = r.poly[0];
        const b = r.poly[1];
        return { x: (r.poly[0].x + r.poly[2].x) / 2, z: (r.poly[0].z + r.poly[2].z) / 2, bearing: Math.atan2(b.z - a.z, b.x - a.x), bb: r.bb };
      });
      const segGrid = makeGrid(segs.map((e) => ({ bb: e.bb })));
      const toStreet = [];
      const unmatched = [];
      for (const b of bldgs) {
        // A building's u axis in the obstacle frame is (cos, sin).
        const own = Math.atan2(Math.sin(b.o.rot), Math.cos(b.o.rot));
        let best = null;
        let bd = Infinity;
        gridQuery(segGrid, b.bb, 60, (i) => {
          const sg = segs[i];
          const d = (sg.x - b.o.x) ** 2 + (sg.z - b.o.z) ** 2;
          if (d < bd) { bd = d; best = sg; }
        });
        if (!best) { unmatched.push(b.name); continue; }
        toStreet.push(foldDeg(own - best.bearing));
      }
      toStreet.sort((a, b) => a - b);

      // Its own grid over the buildings alone. `gAll` indexes `[...mons, ...bldgs]`, so an
      // index from it is not an index into `bldgs` — mixing the two is the shape of bug this
      // file is meant to catch, so it does not get to have one.
      const bldgGrid = makeGrid(bldgs);
      const neigh = [];
      /**
       * **Where the seams are, not only how many.** The threshold's own note licenses "a
       * handful of pairs [that] legitimately straddle a genuine grain change", and a grain
       * change in a real city happens where two streets meet: the AGEA figure this file
       * quotes is *15-40 degrees across a street*. A fraction alone cannot tell a city that
       * changes grain at twelve junctions from a quilt that changes it everywhere, so the
       * offenders are clustered at 60 m and each cluster's distance to the nearest crossing of
       * two carriageways is measured. Reported, **not** gated — the gate is still the
       * fraction, because a decomposition that excused the number would be an exemption.
       */
      const seams = [];
      for (let i = 0; i < bldgs.length; i++) {
        const a = bldgs[i];
        gridQuery(bldgGrid, a.bb, TH.GRAIN_NEIGHBOUR_M, (j) => {
          if (j <= i) return;
          const b = bldgs[j];
          const d = Math.hypot(a.o.x - b.o.x, a.o.z - b.o.z);
          if (d > TH.GRAIN_NEIGHBOUR_M) return;
          const f = foldDeg(a.o.rot - b.o.rot);
          neigh.push(f);
          if (f > 15) seams.push({ f, x: (a.o.x + b.o.x) / 2, z: (a.o.z + b.o.z) / 2 });
        });
      }
      // Junctions of the drawn network: every pair of carriageway segments whose rectangles
      // overlap and whose bearings differ. Taken from `roadSegs`, which is the same population
      // the street-bearing test above uses.
      const junctions = [];
      {
        const jg = makeGrid(roadSegs);
        for (let i = 0; i < roadSegs.length; i++) {
          gridQuery(jg, roadSegs[i].bb, 0, (j) => {
            if (j <= i) return;
            if (roadSegs[i].id === roadSegs[j].id) return;
            if (bbClear(roadSegs[i].bb, roadSegs[j].bb)) return;
            if (clipArea(roadSegs[i].poly, roadSegs[j].poly) <= TH.NOISE_M2) return;
            junctions.push({
              x: (roadSegs[i].poly[0].x + roadSegs[j].poly[0].x) / 2,
              z: (roadSegs[i].poly[0].z + roadSegs[j].poly[0].z) / 2,
            });
          });
        }
      }
      const clusters = [];
      for (const e of seams.slice().sort((a, b) => b.f - a.f)) {
        const near = clusters.find((c) => Math.hypot(c.x - e.x, c.z - e.z) < 60);
        if (near) { near.n++; near.worst = Math.max(near.worst, e.f); }
        else clusters.push({ x: e.x, z: e.z, n: 1, worst: e.f });
      }
      for (const c of clusters) {
        let best = Infinity;
        for (const j of junctions) {
          const q = Math.hypot(j.x - c.x, j.z - c.z);
          if (q < best) best = q;
        }
        c.toJunctionM = Number.isFinite(best) ? best : null;
      }
      clusters.sort((a, b) => b.n - a.n);
      neigh.sort((a, b) => a - b);
      return {
        blocks: bldgs.length,
        toNearestStreetDeg: {
          n: toStreet.length, unmatched: unmatched.length,
          median: r2(pct(toStreet, 0.5)), p75: r2(pct(toStreet, 0.75)), p90: r2(pct(toStreet, 0.9)),
          p95: r2(pct(toStreet, 0.95)), max: r2(toStreet[toStreet.length - 1]),
          overTolerance: toStreet.filter((v) => v > TH.BLOCK_STREET_TOL_DEG).length,
        },
        neighbourPairsDeg: {
          n: neigh.length,
          median: r2(pct(neigh, 0.5)), p75: r2(pct(neigh, 0.75)), p90: r2(pct(neigh, 0.9)),
          max: r2(neigh[neigh.length - 1]),
          over15deg: neigh.filter((v) => v > 15).length,
          overTolerance: neigh.filter((v) => v > TH.GRAIN_SEAM_TOL_DEG).length,
        },
        seamPlaces: {
          clusters: clusters.length,
          junctionsFound: junctions.length,
          atAJunctionWithin60m: clusters.filter((c) => c.toJunctionM !== null && c.toJunctionM <= 60).length,
          worst: clusters.slice(0, 12).map((c) => ({
            pairs: c.n, worstDeg: r2(c.worst), at: { x: r2(c.x), z: r2(c.z) },
            toJunctionM: c.toJunctionM === null ? null : r2(c.toJunctionM),
          })),
        },
        /**
         * The hash signature. A uniform draw over [0°, 45°] has a median of 22.5 and a mean
         * of 22.5; a face-of-the-graph block has both near zero. Printed so the reader can
         * see WHICH population the city is in rather than only whether it passed.
         */
        uniformDrawMedianWouldBe: 22.5,
      };
    })();

    // =====================================================================
    // What the build says about itself, for the record only.
    // =====================================================================
    const selfReport = {
      footprintOverlaps: stats.footprintOverlaps,
      footprintOverlapWorstM: stats.footprintOverlapWorst,
      fabricOverlaps: stats.fabricOverlaps,
      fabricOverlapWorstM: stats.fabricOverlapWorst,
      wayInsideMonument: `${stats.wayInsideMonument}/${stats.waySamples}`,
      topology: `${stats.topologyPass}/${stats.topologyChecks}`,
      strayGeometry: stats.strayGeometry,
      assertionsFailing: assertions.filter((a) => !a.ok).map((a) => a.id ?? a.name ?? '?'),
      assertionCount: assertions.length,
    };

    // =====================================================================
    // THE GATE
    // =====================================================================
    const checks = [];
    let boxStoneMismatch = [];
    let out_g15 = [];
    const gate = (id, question, ok, measured, threshold) => checks.push({ id, question, ok: !!ok, na: false, measured, threshold });
    /**
     * **Not applicable is a third outcome and it is not a pass.**
     *
     * A check whose population is empty on this map — G8c and G8d on Carthage, which declares
     * no complexes — cannot fail, and a check that cannot fail is not an instrument. Counting
     * it green would put a number on the verdict line that this project has shipped several
     * times: a gate that has never gone red. So it is reported `n/a` with the reason and the
     * sample size, it is taken OUT of this map's denominator, and the verdict line names it.
     * The denominators therefore differ between maps, which is correct: Carthage is being asked
     * fewer questions because Carthage makes fewer claims.
     */
    const skip = (id, question, why, threshold) => checks.push({ id, question, ok: false, na: true, measured: `n/a — ${why}`, threshold });

    gate('G1', 'no two monument footprints intersect',
      mm.pairs === 0, `${mm.pairs} faulting pairs, ${r2(mm.totalM2)} m2, worst depth ${r2(mm.worstDepth)} m`
        + ` (excluded as one structure: ${mm.sameStructure} same-owner joints, ${mm.abutment} abutments totalling ${r2(mm.abutM2)} m2)`, '0 pairs');
    gate('G2', 'no building stands inside a monument',
      mb.pairs === 0, `${mb.pairs} pairs across ${mb.distinctB} buildings and ${mb.distinctA} monuments, ${r2(mb.totalM2)} m2`, '0 pairs');
    gate('G3', 'no two buildings interpenetrate',
      bb2.pairs === 0, `${bb2.pairs} pairs, ${r2(bb2.totalM2)} m2, worst depth ${r2(bb2.worstDepth)} m`, '0 pairs');
    gate('G4', 'no monument stands in a carriageway (plan)',
      monVsRoad.totalM2 <= TH.ROAD_INTRUSION_M2, `${r2(monVsRoad.totalM2)} m2 over ${monVsRoad.segmentHits} segments and ${monVsRoad.monumentsInvolved} monuments`, `<= ${TH.ROAD_INTRUSION_M2} m2`);
    gate('G5', 'no DRAWN carriageway is drawn under a monument (geometry)',
      roadInMon.size === 0, `${[...roadInMon.values()].reduce((s, e) => s + e.hits, 0)} sampled street vertices inside ${roadInMon.size} monument footprints, of ${geomStats.streetVerts} sampled`, '0 vertices');
    gate('G6', 'no monument stands inside the curtain, a tower or a gate (plan)',
      monVsWall.totalM2 <= TH.WALL_INTRUSION_M2, `${monVsWall.pairs} pairs, ${r2(monVsWall.totalM2)} m2, ${monVsWall.distinctA} monuments`, `<= ${TH.WALL_INTRUSION_M2} m2`);
    gate('G7', 'no DRAWN wall stone is drawn inside a monument (geometry)',
      wallInMon.size === 0, `${[...wallInMon.values()].reduce((s, e) => s + e.hits, 0)} sampled wall vertices inside ${wallInMon.size} monument footprints, of ${geomStats.wallVerts} sampled`, '0 vertices');
    /**
     * G8 / G8c / G8d — the street, the joint, and the complex.
     *
     * One measurement, three questions, and the split is the whole of `CITY-GROUND-JUDGE.md`
     * §11.1. G8's threshold and comment are unchanged; what changed is that it is now asked of
     * the population its comment is right about. G8c and G8d are what declaring a complex now
     * costs. Sample sizes are printed on all three, per rule 12.
     */
    const monPairs = structPairs.filter((r) => !r.a.soft && !r.b.soft);
    const softPairs = structPairs.filter((r) => r.a.soft || r.b.soft);
    {
      const cross = monPairs.filter((r) => !r.sameComplex);
      const short = cross.filter((r) => r.gapM < TH.CLEAR_MON_MON).sort((x, y) => x.gapM - y.gapM);
      const softNames = [...new Set(structList.filter((st) => st.soft).map((st) => st.id))];
      const softClose = softPairs.filter((r) => r.gapM < TH.CLEAR_MON_MON).length;
      gate('G8', 'every monument keeps its street from a monument in ANOTHER complex',
        short.length === 0,
        `${short.length} of ${cross.length} cross-complex pairs short of the street`
        + (short.length ? `; worst ${r2(short[0].gapM)} m (${short[0].a.id} / ${short[0].b.id})` : '')
        + `; closest legal ${r2(cross.length ? Math.min(...cross.map((r) => r.gapM)) : null)} m`
        + ` | EXCLUSION, named: landscape (soft) ${softNames.length} rows`
        + (softNames.length
          ? ` [${softNames.join(', ')}], ${softClose} of ${softPairs.length} soft pairs inside`
            + ` ${TH.CLEAR_MON_MON} m — reported, not gated, because the survey says in as many`
            + ` words that "a temple standing in the middle of the Horti Sallustiani is how Rome`
            + ` actually worked"`
          : ' — no soft row publishes a collision box on this map, so this exclusion is EMPTY'
            + ' rather than granted, and nothing is using the licence')
        + ` | excluded, one complex: ${monPairs.length - cross.length} pairs -> G8c and G8d`,
        `0 pairs under ${TH.CLEAR_MON_MON} m`);
    }
    {
      const inC = monPairs.filter((r) => r.sameComplex);
      const bad = inC.filter((r) => r.gapM > TH.ABUT_DEPTH_M && r.gapM < TH.CLEAR_MON_MON)
        .sort((x, y) => x.gapM - y.gapM);
      if (inC.length === 0) {
        skip('G8c', 'a pair inside one declared complex is JOINED, not in a no-man\'s-land',
          `this map declares no complexes, so there are no in-complex pairs to grade`
          + ` (${structList.length} monument structures, ${structPairs.length} pairs, 0 in a complex)`,
          `0 pairs in (${TH.ABUT_DEPTH_M}, ${TH.CLEAR_MON_MON}) m`);
      } else {
        gate('G8c', 'a pair inside one declared complex is JOINED, not in a no-man\'s-land',
          bad.length === 0,
          `${bad.length} of ${inC.length} in-complex pairs stand in the`
          + ` (${TH.ABUT_DEPTH_M}, ${TH.CLEAR_MON_MON}) m no-man's-land`
          + (bad.length ? `: ${bad.map((r) => `${r.a.id}/${r.b.id} ${r2(r.gapM)} m`).join('; ')}` : '')
          + ` | joined: ${inC.filter((r) => r.joined).length}`
          + ` (nested ${inC.filter((r) => r.nested).length}, abutting ${inC.filter((r) => r.abutting && !r.nested).length})`
          + `; standing apart at >= ${TH.CLEAR_MON_MON} m: ${inC.filter((r) => r.gapM >= TH.CLEAR_MON_MON).length}`
          + ` (G8d's problem, not this one)`,
          `0 pairs in (${TH.ABUT_DEPTH_M}, ${TH.CLEAR_MON_MON}) m — a complex is a party wall or it is a street`);
      }
    }
    {
      const gradeable = complexes.filter((c) => !c.degenerate);
      const broken = gradeable.filter((c) => c.pieces > 1);
      if (gradeable.length === 0) {
        skip('G8d', 'a declared complex is ONE connected piece of fabric',
          `this map declares no complexes with more than one row`
          + ` (${complexes.length} declared, ${complexes.filter((c) => c.degenerate).length} of them single-row)`,
          '1 connected component per complex');
      } else {
        gate('G8d', 'a declared complex is ONE connected piece of fabric',
          broken.length === 0,
          `${broken.length} of ${gradeable.length} declared complexes are not one piece`
          + (broken.length
            ? `: ${broken.map((c) => `${c.name} ${c.pieces} pieces [${c.piecesDetail.join(' | ')}], one piece only at ${r2(c.connectAtM)} m`).join('; ')}`
            : '')
          + ` | all: ${complexes.map((c) => `${c.name} ${c.rows} rows ${c.pieces}p@${r2(c.connectAtM)}m`).join(', ')}`,
          '1 connected component per complex, joined at nested or <= '
          + `${TH.ABUT_DEPTH_M} m`);
      }
    }
    {
      const k = clearance.byClass['building/monument'];
      gate('G9', 'every monument keeps the ambitus from the fabric',
        k ? k.minM >= TH.CLEAR_MON_BLD : true, k ? `min ${k.minM} m (${k.between})` : 'no pairs', `>= ${TH.CLEAR_MON_BLD} m`);
    }
    {
      const k = clearance.byClass['building/building'];
      gate('G10', 'no building has negative clearance to another',
        k ? k.minM >= TH.CLEAR_BLD_BLD : true, k ? `min ${k.minM} m (${k.between})` : 'no pairs', `>= ${TH.CLEAR_BLD_BLD} m`);
    }
    /**
     * G11 — three kinds of absence, and only one of them is a fault.
     *
     * An anachronism (`absentExpected`) is absent because it did not exist in 271. A row off
     * the +Z frame (`offFrame`) is absent because the owner decided in writing that a monument
     * with a straight cut through it is worse than an absent one. Anything else absent is
     * missing, which is a fault.
     *
     * **The category is gated on its MEMBERSHIP, not its size**, which is the condition
     * `CITY-GROUND-JUDGE.md` §11.4 attached and rule 16 demands. `src/city/rome/assertions.ts`
     * gates `offMap.length === 5` and names the five only in its message, so swapping the
     * Palatine for the Pantheon passes the build's own assertion and fails this one.
     */
    {
      const missing = fid.filter((f) => f.gate && !f.present && !f.absentExpected && !f.offFrame).map((f) => f.name);
      const wrongPresent = fid.filter((f) => f.absentExpected && f.present).map((f) => f.name);
      const offFrameDrawn = fid.filter((f) => f.offFrame && f.present).map((f) => f.name);
      const declared = [...(declaredOffFrame ?? [])].sort();
      const agreed = [...OFF_FRAME].sort();
      const unexpectedOff = declared.filter((id) => !agreed.includes(id));
      const missingOff = agreed.filter((id) => !declared.includes(id));
      const listOk = declaredOffFrame !== null && unexpectedOff.length === 0 && missingOff.length === 0;
      gate('G11', 'every sourced monument is present; the anachronisms and the off-frame rows are the agreed ones, by name',
        missing.length === 0 && wrongPresent.length === 0 && offFrameDrawn.length === 0 && listOk,
        `${gated.length} of ${fid.filter((f) => f.gate).length} gated rows present`
        + `; missing (a fault): [${missing.join(', ')}]`
        + `; anachronisms drawn anyway: [${wrongPresent.join(', ')}]`
        + `; off-frame rows drawn anyway: [${offFrameDrawn.join(', ')}]`
        + ` | EXCLUSIONS, named: absent as anachronism ${fid.filter((f) => f.absentExpected).length}`
        + ` [${fid.filter((f) => f.absentExpected).map((f) => f.id).join(', ')}]`
        + `; off this map's +Z frame ${declared.length} [${declared.join(', ')}]`
        + (declaredOffFrame === null ? ' (NOT READ: the plan import failed)' : '')
        + (unexpectedOff.length ? `; NOT AGREED: [${unexpectedOff.join(', ')}]` : '')
        + (missingOff.length ? `; agreed but on the map: [${missingOff.join(', ')}]` : ''),
        `0 missing, 0 anachronisms drawn, and the off-frame set == the ${agreed.length} agreed names`);
    }
    {
      const badPlan = gated.filter((f) => f.aspectErrPlan !== null && f.aspectErrPlan > TH.ASPECT_TOL);
      const badDrawn = gated.filter((f) => f.aspectErrDrawn !== null && f.aspectErrDrawn > TH.ASPECT_TOL_DRAWN);
      gate('G12', 'every sourced monument has the published aspect ratio (scale-free)',
        badPlan.length === 0 && badDrawn.length === 0,
        `plan out of tolerance: ${badPlan.length} [${badPlan.map((f) => `${f.id} ${f.planAspect} vs ${f.publishedAspect}`).join('; ')}]`
        + ` | drawn out of tolerance: ${badDrawn.length} [${badDrawn.map((f) => `${f.id} ${f.drawnAspect} vs ${f.publishedAspect}`).join('; ')}]`,
        `plan <= ${TH.ASPECT_TOL}, drawn <= ${TH.ASPECT_TOL_DRAWN} relative error`);
    }
    {
      // The collision box against the drawn stone, per monument, over every monument with
      // geometry — not only the sourced ones, because this test needs no published figure.
      const mismatch = [];
      for (const [id, agg] of aggregate) {
        const d = drawn.get(id);
        if (!d) continue;
        const f = frames.get(id);
        if (f && f.soft) continue; // landscape has no collision box by design
        const boxLong = Math.max(agg.u1 - agg.u0, agg.v1 - agg.v0);
        const boxShort = Math.min(agg.u1 - agg.u0, agg.v1 - agg.v0);
        const dLong = Math.max(d.u, d.v);
        const dShort = Math.min(d.u, d.v);
        const rl = dLong / boxLong;
        const rs = dShort / boxShort;
        if (Math.max(rl, rs) > 1 + TH.BOX_VS_STONE_TOL) {
          mismatch.push({ name: f ? f.name : id, drawnOverBoxLong: r3(rl), drawnOverBoxShort: r3(rs), overhangM: r2(Math.max(dLong - boxLong, dShort - boxShort) / 2) });
        }
      }
      mismatch.sort((a, b) => b.overhangM - a.overhangM);
      boxStoneMismatch = mismatch;
      gate('G14', 'the stone the player sees fits the footprint the game collides with',
        mismatch.length === 0,
        `${mismatch.length} of ${aggregate.size} monuments draw stone beyond their own collision box; worst overhang ${mismatch.length ? mismatch[0].overhangM : 0} m per side (${mismatch.length ? mismatch[0].name : '-'})`,
        `drawn/box <= ${1 + TH.BOX_VS_STONE_TOL}`);
    }
    /**
     * G15 — a monument's drawn stone inside another monument's footprint.
     *
     * Licensed on THREE conjunctive conditions, per `CITY-GROUND-JUDGE.md` §11.1, and every one
     * of them has to hold:
     *
     *   (a) the two are in one declared `complex`;
     *   (b) their footprints are JOINED in G8c's sense — nested, or abutting inside
     *       `ABUT_DEPTH_M`. A pair declared one complex and standing 17 m apart licenses
     *       nothing;
     *   (c) the trespassing vertices lie INSIDE the container rather than THROUGH ITS FAR SIDE.
     *       Measured, and the measurement needs stating because "far side" is not obvious to
     *       compute: take the axis from the container's centre to the trespasser's centre, find
     *       the container's own extent along the far half of that axis, and ask how close the
     *       deepest trespassing vertex gets to that far boundary. Inside `ABUT_DEPTH_M` of it,
     *       the stone has crossed the container and what is left on the other side is a party
     *       wall's thickness — so it has gone through, and it is a fault. No new constant.
     *
     * Without (c) this is the exemption the adjudication refused, one indirection further out.
     *
     * **A second, stricter reading of (c) is measured, reported and NOT gated, and this file's
     * author thinks it is the better instrument.** `deepestM` is how far the stone runs past the
     * container's boundary. A party wall is `ABUT_DEPTH_M` of shared masonry, and on Rome today
     * four of eleven trespasses run deeper: `stadium-domitian` 13.22 m into `baths-nero`,
     * `forum-romanum` 12.47 m into `imperial-fora`, `basilica-ulpia` 4.99 m into `imperial-fora`
     * and `baths-trajan` 2.98 m into `baths-titus`. Gating on it would fail **three** pairs more
     * than (c) does — the stadium is already a fault under (b) — and it is not gated for two
     * reasons that are about the boxes rather than about the stone.
     *
     * The Basilica Ulpia's real relation to Trajan's Forum is NESTING: it is a hall standing
     * inside it, `CITY-GROUND-JUDGE.md` §11.1 says so, and the modelled boxes read as an
     * abutment instead — so a depth gate would fault the box modelling through G15 while G8c
     * and G14 already fault it directly, and two instruments for one fault is how a gate gets
     * reverted. And the Forum Romanum's "stone" is paving: two adjoining fora with continuous
     * pavement is what Rome was, and a check that cannot tell a pavement from a wall should not
     * be the one deciding. `overlaps.drawnStoneTrespassAdjudicated` carries the depth for every
     * pair, so raising it to a gate is one line the day the boxes carry the relation and the
     * geometry read distinguishes paving from masonry.
     */
    {
      const relByKey = new Map();
      for (const r of structPairs) {
        relByKey.set(`${r.a.id}>${r.b.id}`, r);
        relByKey.set(`${r.b.id}>${r.a.id}`, r);
      }
      const rows = [...stoneInMon.values()].map((e) => {
        const r = relByKey.get(`${e.stoneId}>${e.intoId}`) ?? null;
        const smaller = r ? (r.a.area <= r.b.area ? r.a.id : r.b.id) : null;
        const stoneIsNested = !!r && r.nested && smaller === e.stoneId;
        const through = e.toFarEdgeM !== null && e.toFarEdgeM <= TH.ABUT_DEPTH_M;
        const licensed = !!r && r.sameComplex && r.joined && !through;
        let why = 'no relation found';
        if (r && !r.sameComplex) why = 'not one complex';
        else if (r && !r.joined) why = `one complex but not joined (${r2(r.gapM)} m apart)`;
        else if (r && through) why = `one complex, joined, but the stone reaches within ${r2(e.toFarEdgeM)} m of the far side`;
        else if (r) why = stoneIsNested ? 'nested' : 'joined, and the stone stays inside';
        return {
          ...e, licensed, why, through,
          complex: r && r.sameComplex ? r.a.complex : null,
          gapM: r ? r2(r.gapM) : null,
          nested: stoneIsNested,
        };
      });
      const faults = rows.filter((e) => !e.licensed).sort((a, b) => b.deepestM - a.deepestM);
      const ok = rows.filter((e) => e.licensed);
      const n = faults.reduce((t, e) => t + e.hits, 0);
      gate('G15', "no monument's drawn stone stands inside another monument's footprint, unless one complex licenses it",
        faults.length === 0,
        `${faults.length} faulting pairs, ${n} sampled vertices, of ${rows.length} trespassing pairs`
        + (faults.length
          ? `; faults: ${faults.slice(0, 5).map((e) => `${e.stoneId} into ${e.intoId} (${e.why})`).join('; ')}`
          : '')
        + ` | licensed by a complex: ${ok.length}`
        + ` [${ok.map((e) => `${e.stoneId}>${e.intoId} ${e.why}, ${r2(e.deepestM)} m in`).join('; ')}]`
        + ` | NOT GATED, the depth reading: ${rows.filter((e) => e.deepestM > TH.ABUT_DEPTH_M).length}`
        + ` of ${rows.length} trespasses run deeper than a ${TH.ABUT_DEPTH_M} m party wall`
        + ` [${rows.filter((e) => e.deepestM > TH.ABUT_DEPTH_M).sort((a, b) => b.deepestM - a.deepestM).map((e) => `${e.stoneId}>${e.intoId} ${r2(e.deepestM)} m`).join('; ')}]`,
        `0 unlicensed pairs; a licence needs one complex + joined + not through the far side`);
      out_g15 = rows;
    }
    {
      const n = [...stoneInBld.values()].reduce((s, e) => s + e.hits, 0);
      const bset = new Set([...stoneInBld.values()].map((e) => e.standingIn));
      gate('G16', "no monument's drawn stone stands inside a building's footprint",
        stoneInBld.size === 0,
        `${n} sampled monument vertices standing in ${bset.size} buildings, over ${stoneInBld.size} monument/building pairs`, '0 vertices');
    }
    {
      const bad = [...band.belowFloor, ...band.aboveCeiling];
      if (band.n === 0) {
        skip('G13a', "every gated monument's drawn plan is inside an absolute band against the literature",
          'no gated monument on this map has both a published figure and drawn geometry',
          `drawn/published in [${TH.SCALE_FLOOR}, ${1 + TH.SCALE_CEIL_TOL}]`);
      } else {
        gate('G13a', "every gated monument's drawn plan is inside an absolute band against the literature",
          bad.length === 0,
          `${bad.length} of ${band.n} gated rows outside the band`
          + `; below the ${TH.SCALE_FLOOR} floor: ${band.belowFloor.length}`
          + ` [${band.belowFloor.map((f) => `${f.id} ${f.ratio} (${f.drawnLong} of ${f.publishedLong} m)`).join('; ')}]`
          + `; above ${1 + TH.SCALE_CEIL_TOL}: ${band.aboveCeiling.length}`
          + ` [${band.aboveCeiling.map((f) => `${f.id} ${f.ratio}`).join('; ')}]`
          + ` | cohort n=${cohort.n}, median ${cohort.medianDrawnOverPublished},`
          + ` range ${cohort.minDrawnOverPublished}..${cohort.maxDrawnOverPublished} (${cohort.spreadX}x spread) — reported, not gated`,
          `drawn/published in [${TH.SCALE_FLOOR}, ${1 + TH.SCALE_CEIL_TOL}] against PUBLISHED, per row`);
      }
    }
    {
      if (!order.enough) {
        skip('G13b', 'no pair of monuments has its size order inverted against the published pair',
          `${order.assertingPairs} asserting pairs from ${order.rows} gated rows, under the`
          + ` ${TH.SIZE_ORDER_MIN_PAIRS} this check refuses below — a size-order rate computed on`
          + ` ${order.assertingPairs} relation(s) is a confident number rather than a measurement`
          + ` (MAP-METHOD rule 12). The wider sourced population has`
          + ` ${order.widerSourcedPopulation_notGated.assertingPairs} asserting pairs and`
          + ` ${order.widerSourcedPopulation_notGated.inverted} inverted, reported not gated.`,
          '0 inverted pairs');
      } else {
        gate('G13b', 'no pair of monuments has its size order inverted against the published pair',
          order.invertedPairs === 0,
          `${order.invertedPairs} of ${order.assertingPairs} asserting pairs inverted`
          + ` (${order.pctInverted} %), from ${order.rows} gated rows`
          + (order.worst.length
            ? `; worst: ${order.worst.slice(0, 4).map((w) => `${w.biggerPublished} / ${w.smallerPublished} real ${w.publishedRatio}x -> drawn ${w.drawnRatio}x (${w.wrongByX}x wrong)`).join('; ')}`
            : '')
          + ` | wider sourced population, not gated: ${order.widerSourcedPopulation_notGated.inverted}`
          + ` of ${order.widerSourcedPopulation_notGated.assertingPairs} over`
          + ` ${order.widerSourcedPopulation_notGated.rows} rows`,
          `0 inverted pairs among published figures more than ${TH.SIZE_ORDER_MIN_RATIO}x apart`);
      }
    }

    {
      const P = partition;
      gate('G18', 'the layout regions do not overlap each other',
        P.measured ? P.overlappingPairs === 0 : false,
        P.measured
          ? `${P.overlappingPairs} overlapping region pairs, ${P.overlapAreaM2} m2 of double-claimed ground`
            + ` (worst: ${P.worstOverlaps.slice(0, 3).map((w) => `${w.a}/${w.b} ${w.m2} m2`).join('; ') || 'none'})`
          : `NOT MEASURED: ${P.why}`,
        '0 pairs');
      gate('G19', 'the layout regions partition the ground: claimed area / available = 1.00',
        P.measured ? Math.abs((P.claimedOverAvailable ?? 99) - 1) <= TH.PARTITION_TOL
          && Math.abs((P.coverageOverAvailable ?? 0) - 1) <= TH.PARTITION_TOL : false,
        P.measured
          ? `${P.regions} regions claim ${P.claimedOverAvailable}x the ${P.availableGroundM2} m2 of land inside the circuit`
            + ` (their authored outlines, which may run past the map edge, total ${P.declaredOverAvailable}x it); ${P.coverageOverAvailable}x covered at`
            + ` least once; ${P.doubleClaimedM2} m2 claimed more than once`
            + (P.offFrame && P.offFrame.length
              ? ` | OFF-FRAME, named and counted: ${P.offFrame.length} [${P.offFrame.join(', ')}]`
              : '')
          : `NOT MEASURED: ${P.why}`,
        `1.00 +/- ${TH.PARTITION_TOL}`);
    }
    {
      const g = grain.toNearestStreetDeg;
      gate('G20', "a block's orientation comes from the street that bounds it, not from a hash",
        g.n > 0 && (g.median ?? 99) <= TH.BLOCK_STREET_TOL_DEG,
        `${g.n} blocks: median ${g.median} deg off the nearest street, p90 ${g.p90}, max ${g.max};`
        + ` ${g.overTolerance} of ${g.n} outside tolerance. A uniform hash draw would read ~22.5 deg.`,
        `median <= ${TH.BLOCK_STREET_TOL_DEG} deg`);
    }
    {
      const g = grain.neighbourPairsDeg;
      const seamFrac = g.n > 0 ? g.over15deg / g.n : 1;
      gate('G21', 'the grain holds between neighbours: no orientation seam inside 40 m',
        g.n > 0 && (g.median ?? 99) <= TH.GRAIN_SEAM_TOL_DEG && seamFrac <= TH.GRAIN_SEAM_FRACTION,
        `${g.n} neighbouring block pairs within ${TH.GRAIN_NEIGHBOUR_M} m: median ${g.median} deg apart,`
        + ` p90 ${g.p90}, max ${g.max}; ${g.over15deg} (${(seamFrac * 100).toFixed(1)}%) rotate more than`
        + ` 15 deg across a 40 m gap`
        + (grain.seamPlaces
          ? `; in ${grain.seamPlaces.clusters} place(s), ${grain.seamPlaces.atAJunctionWithin60m} of them`
            + ` within 60 m of a crossing of two carriageways`
            + (grain.seamPlaces.worst.length
              ? `: ${grain.seamPlaces.worst.slice(0, 6).map((c) => `${c.pairs} pairs at (${c.at.x}, ${c.at.z})`
                + ` worst ${c.worstDeg} deg, ${c.toJunctionM === null ? 'no junction' : `${c.toJunctionM} m from a junction`}`).join('; ')}`
              : '')
            + ' — reported, not gated'
          : ''),
        `median <= ${TH.GRAIN_SEAM_TOL_DEG} deg AND seams <= ${(TH.GRAIN_SEAM_FRACTION * 100).toFixed(0)}%`);
    }
    {
      const F = fillAndAbandon;
      if (!F.measured) {
        skip('G23', 'the ground between street lines is built at the orthophoto\'s density',
          F.why, `fabric over the ground it is allowed >= ${(TH.ROOF_COVERAGE_MIN * 100).toFixed(0)}%`);
      } else {
        gate('G23', 'the ground between street lines is built at the orthophoto\'s density',
          F.fabricOverAllowed !== null && F.fabricOverAllowed >= TH.ROOF_COVERAGE_MIN
            && F.betweenStreetLinesM2 >= TH.ROOF_COVERAGE_MIN_GROUND_M2,
          `${(F.fabricOverAllowed * 100).toFixed(1)}% of the ground the fabric is allowed`
          + ` — ${r2(F.allowedGroundM2 / 1e4)} ha of the ${r2(F.betweenStreetLinesM2 / 1e4)} ha`
          + ` between street lines over ${F.blocks} blocks; the rest is`
          + ` ${r2(F.monumentRoofM2 / 1e4)} ha monument, ${r2(F.reservedM2 / 1e4)} ha reserved`
          + ` (setback, square, aqueduct, soft landscape) and ${r2(F.waterM2 / 1e4)} ha water`
          + ` (at or under ${r2((terrainWaterLevel ?? 0) + TH.DRY_FLOOR_FREEBOARD_M)} m, the drawn`
          + ` surface plus the ${TH.DRY_FLOOR_FREEBOARD_M} m a dry floor needs)`
          + `. Every roof over every square metre between kerbs, which is what an orthophoto`
          + ` measures: ${(F.allRoofOverAll * 100).toFixed(1)}%`
          + `; fabric over ALL the ground, the figure phase 4 quoted: ${(F.fabricOverAll * 100).toFixed(1)}%`
          + `. FOOTPRINT, not roof — a courtyard insula's footprint is the whole block, so this`
          + ` reads high against a photograph by an amount nothing here measures`
          + `. By regio (fabric/allowed, all-roof/all): `
          + F.perRegion.slice(0, 14).map((e) => `${e.id}`
            + ` ${e.fabricOverAllowed === null ? '-' : (e.fabricOverAllowed * 100).toFixed(0)}%/`
            + `${e.allRoofOverAll === null ? '-' : (e.allRoofOverAll * 100).toFixed(0)}%`).join(' '),
          `fabric over the ground it is allowed >= ${(TH.ROOF_COVERAGE_MIN * 100).toFixed(0)}%,`
          + ` over at least ${TH.ROOF_COVERAGE_MIN_GROUND_M2 / 1e4} ha of ground between street lines`);
      }
    }
    {
      const B = fillAndAbandon;
      if (!B.measured) {
        skip('G24', 'no block builds nothing while it still has room for a house',
          B.why, '0 blocks with a house\'s worth of free ground and no house');
      } else {
        gate('G24', 'no block builds nothing while it still has room for a house',
          B.gaveUp === 0 && B.excludedHorti <= TH.HORTI_EMPTY_MAX,
          `${B.gaveUp} of ${B.blocks} blocks have no roof on them and an ${B.houseWindowM} x`
          + ` ${B.houseWindowM} m square of ground that is not monument, not reserved and not`
          + ` water — the smallest thing the generator builds is ${B.houseM2} m2, and these`
          + ` blocks hold ${r2(B.gaveUpGroundM2)} m2 of free ground between them`
          + `; ${B.emptyBlocks} blocks have no roof at all, of which ${B.occupiedOrWet}`
          + ` have nowhere to put one`
          + (B.worst.length
            ? `; worst: ${B.worst.slice(0, 6).map((e) => `${e.region} at (${e.x}, ${e.z}) ${e.freeM2} m2 free of ${e.insetM2}`).join('; ')}`
            : '')
          + ` | EXCLUSIONS, named, counted and gated: ${B.excludedHorti} horti block(s), built at`
          + ` 8 per cent by design [${B.excludedHortiNamed.join(', ') || 'none'}]`,
          `0 blocks with a house's worth of free ground and no house, and at most`
          + ` ${TH.HORTI_EMPTY_MAX} empty horti blocks`);
      }
    }
    {
      const W = water;
      if (!W.measured) {
        skip('G22', 'no structure stands below the water surface',
          W.why, 'no solid with a wet centre, outside the named list');
      } else {
        const mons22 = W.faultStructures.filter((f) => f.kind === 'monument');
        gate('G22', 'no structure stands below the water surface',
          W.faultSolids === 0 && W.staleLicences.length === 0,
          `${W.faultSolids} solids with their centre under water of ${W.solidsSampled} sampled`
          + ` (water at ${W.waterLevelM} m; ${W.entirelyWet} entirely wet, ${W.anyCornerWet} with a wet corner)`
          + `; by kind: ${W.faultsByKind.monument} monument, ${W.faultsByKind.building} building,`
          + ` ${W.faultsByKind.wall} wall`
          + (mons22.length
            ? `; monuments: ${mons22.map((f) => `${f.id} at ${f.worstDatumM} m`).join('; ')}`
            : '')
          + (W.faultStructures.length
            ? `; worst overall: ${W.faultStructures.slice(0, 4).map((f) => `${f.id} at ${f.worstDatumM} m`).join('; ')}`
            : '')
          + ` | EXCLUSIONS, named and gated: ${W.excludedNamed.length}`
          + ` [${W.excludedNamed.map((e) => `${e.id}: ${e.wetSolids} wet of ${e.solidsPublished} solid(s)`).join(', ')}]`
          + (W.staleLicences.length
            ? `; STALE LICENCE — the row publishes solids and none is wet, so this list describes`
              + ` a city that is no longer here: [${W.staleLicences.join(', ')}]`
            : '')
          + (W.licencesNotBuiltAsSolids.length
            ? `; licence held against a row that publishes no solid (soft landscape), reported not`
              + ` gated: [${W.licencesNotBuiltAsSolids.join(', ')}]`
            : ''),
          'no solid with a wet centre outside WATER_EXPECTED, and no stale licence');
      }
    }
    const passed = checks.filter((c) => c.ok && !c.na).length;
    const applicable = checks.filter((c) => !c.na).length;

    // ---- the worst faults, with a camera for each -----------------------
    const faults = [];
    const push = (cls, label, m2, depth, ax, az, bx, bz) => faults.push({
      cls, label, m2, depth,
      cx: (ax + bx) / 2, cz: (az + bz) / 2,
      span: Math.hypot(ax - bx, az - bz),
      pairYaw: Math.atan2(bx - ax, bz - az),
    });
    for (const h of mm.raw.slice(0, 6)) push('monument-vs-monument', `${h.a} x ${h.b}`, h.m2, h.depth, h.ax, h.az, h.bx, h.bz);
    for (const h of mb.raw.slice(0, 6)) push('monument-vs-building', `${h.a} x ${h.b}`, h.m2, h.depth, h.ax, h.az, h.bx, h.bz);
    for (const h of monVsWall.raw.slice(0, 6)) push('monument-vs-wall', `${h.a} x ${h.b}`, h.m2, h.depth, h.ax, h.az, h.bx, h.bz);
    for (const h of bb2.raw.slice(0, 4)) push('building-vs-building', `${h.a} x ${h.b}`, h.m2, h.depth, h.ax, h.az, h.bx, h.bz);
    for (const e of monVsRoad.all.slice(0, 4)) push('monument-vs-street', `${e.name} x carriageway`, e.m2, null, e.x, e.z, e.x, e.z);
    // Geometry-side faults, weighted by how many sampled vertices trespass so they can
    // compete with an area for the three illustration slots. 4 m2 a vertex is the sampled
    // density on this fabric, measured rather than assumed: 129,228 street vertices over
    // 655,351 m2 of carriageway is one sample per 5 m2, and monument stone is denser.
    for (const e of [...stoneInBld.values()].sort((a, b) => b.hits - a.hits).slice(0, 4)) {
      push('drawn-stone-in-a-building', `${e.stone} stone standing in ${e.standingIn}`, e.hits * 4, null, e.x, e.z, e.x, e.z);
    }
    for (const e of [...stoneInMon.values()].sort((a, b) => b.hits - a.hits).slice(0, 4)) {
      push('drawn-stone-in-a-monument', `${e.stone} stone standing in ${e.standingIn}`, e.hits * 4, null, e.x, e.z, e.x, e.z);
    }
    /*
     * The two new fault classes get an illustration slot too. A gate that can fail for a reason
     * it could not fail for before and cannot PHOTOGRAPH that reason has only half shipped: the
     * judge's water finding is a photograph, and the whole of this pass's argument for G8d is a
     * complex whose two halves stand 17 m apart, which is a thing a person can see.
     */
    if (water.measured) {
      for (const f of (water.faultStructures ?? []).slice(0, 4)) {
        push('structure-under-water', `${f.id} at ${f.worstDatumM} m, water at ${water.waterLevelM} m`,
          f.areaM2, null, f.x, f.z, f.x, f.z);
      }
    }
    for (const c of complexes.filter((k) => k.pieces > 1)) {
      // The shortest link between two pieces: the gap the declaration is wrong about.
      const cross = c.pairs.filter((r) => !r.joined).sort((x, y) => x.gapM - y.gapM)[0];
      if (!cross) continue;
      push('a-complex-that-is-not-one-piece',
        `${c.name}: ${cross.a.id} stands ${r2(cross.gapM)} m from ${cross.b.id} in its own complex`,
        cross.gapM * cross.gapM, null, cross.a.x, cross.a.z, cross.b.x, cross.b.z);
    }
    faults.sort((a, b) => b.m2 - a.m2);
    /*
     * **Five frames, not three, and the reason is the two new fault classes.**
     *
     * The illustration list is ranked by area and takes one frame per CLASS, so a class whose
     * unit of harm is small in square metres can never be photographed while a bigger class is
     * unfixed. There are now ten classes. A complex whose two halves stand 27 m apart scores
     * `gap²` = 760 m² against 5,688 m² of paving in the wrong forum, so at three slots the
     * headline finding of G8d — the Theatre of Pompey standing 17.4 m from its own porticus
     * post scaenam — was fifth in the queue and never got a camera. A gate that can fail for a
     * reason it could not fail for before and cannot show that reason has only half shipped.
     */
    const SHOT_SLOTS = 5;
    const chosen = [];
    const seen = new Set();
    for (const f of faults) {
      if (seen.has(f.cls)) continue;
      seen.add(f.cls);
      chosen.push(f);
      if (chosen.length === SHOT_SLOTS) break;
    }
    for (const f of faults) { if (chosen.length >= SHOT_SLOTS) break; if (!chosen.includes(f)) chosen.push(f); }

    return {
      map: MAPID, cityId: stats.id, triangles: stats.triangles,
      verdict: {
        passed,
        of: applicable,
        failing: applicable - passed,
        notApplicable: checks.filter((c) => c.na).map((c) => c.id),
        declared: checks.length,
        ok: passed === applicable,
      },
      checks,
      injected: [...injected],
      injectNotes,
      counts: { monuments: mons.length, buildings: bldgs.length, wallSolids: walls.length, obstacles: obstacles.length },
      areas: { monumentM2: r2(monArea), buildingM2: r2(bldArea), builtM2: r2(builtArea), carriagewayM2: r2(roadArea) },
      overlaps: {
        monumentVsMonument: { pairs: mm.pairs, sameStructureJoints: mm.sameStructure, abutments: mm.abutment, abutmentM2: r2(mm.abutM2), totalM2: r2(mm.totalM2), worstM2: r2(mm.worstM2), worstDepthM: r2(mm.worstDepth), monumentsInvolved: mm.distinctA + mm.distinctB, top: mm.top },
        monumentVsBuilding: { pairs: mb.pairs, sameStructureJoints: mb.sameStructure, abutments: mb.abutment, abutmentM2: r2(mb.abutM2), totalM2: r2(mb.totalM2), worstM2: r2(mb.worstM2), worstDepthM: r2(mb.worstDepth), monumentsInvolved: mb.distinctA, buildingsHit: mb.distinctB, top: mb.top },
        buildingVsBuilding: { pairs: bb2.pairs, sameStructureJoints: bb2.sameStructure, abutments: bb2.abutment, abutmentM2: r2(bb2.abutM2), totalM2: r2(bb2.totalM2), worstM2: r2(bb2.worstM2), worstDepthM: r2(bb2.worstDepth), buildingsInvolved: bb2.distinctA + bb2.distinctB, top: bb2.top },
        monumentVsStreet: monVsRoad,
        monumentVsWall: { pairs: monVsWall.pairs, totalM2: r2(monVsWall.totalM2), worstM2: r2(monVsWall.worstM2), worstDepthM: r2(monVsWall.worstDepth), monumentsInvolved: monVsWall.distinctA, wallSolidsHit: monVsWall.distinctB, top: monVsWall.top },
        drawnRoadUnderMonument: [...roadInMon.values()].sort((a, b) => b.hits - a.hits).slice(0, 12),
        drawnWallInsideMonument: [...wallInMon.values()].sort((a, b) => b.hits - a.hits).slice(0, 12),
        drawnStoneInsideAnotherMonument: [...stoneInMon.values()].sort((a, b) => b.hits - a.hits).slice(0, 12),
        drawnStoneInsideABuilding: [...stoneInBld.values()].sort((a, b) => b.hits - a.hits).slice(0, 15),
        landscapeUnderMasonry_notGated: [...stoneSoft.values()].sort((a, b) => b.hits - a.hits).slice(0, 10),
        boxVsStoneMismatch: boxStoneMismatch.slice(0, 20),
        drawnStoneTrespassAdjudicated: out_g15
          .map((e) => ({ stone: e.stoneId, into: e.intoId, hits: e.hits, deepestM: r2(e.deepestM), toFarEdgeM: r2(e.toFarEdgeM), gapM: e.gapM, complex: e.complex, nested: e.nested, throughFarSide: e.through, licensed: e.licensed, why: e.why }))
          .sort((a, b) => b.deepestM - a.deepestM),
        totalStructureOverlapM2: r2(mm.totalM2 + mb.totalM2 + bb2.totalM2),
        pctOfBuiltArea: r2(((mm.totalM2 + mb.totalM2 + bb2.totalM2) / Math.max(1, builtArea)) * 100),
      },
      clearance,
      fidelity: {
        measuredPlanCompression: r3(medPlan), measuredDrawnCompression: r3(medDrawn),
        cohort, absoluteBand: band, sizeOrder: order, rows: fid,
      },
      complexes: complexes.map((c) => ({
        name: c.name, rows: c.rows, members: c.members, pieces: c.pieces,
        piecesDetail: c.piecesDetail, connectAtM: r2(c.connectAtM),
        joinedPairs: c.joinedPairs, pairs: c.pairs.length,
        inNoMansLand: c.noMansLand.map((r) => `${r.a.id}/${r.b.id} ${r2(r.gapM)} m`),
        standingApart: c.apart.map((r) => `${r.a.id}/${r.b.id} ${r2(r.gapM)} m`),
      })),
      structures: {
        n: structList.length,
        soft: structList.filter((st) => st.soft).map((st) => st.id),
        declaredComplexes: complexes.length,
        pairs: structPairs.length,
        crossComplexPairs: structPairs.filter((r) => !r.a.soft && !r.b.soft && !r.sameComplex).length,
        inComplexPairs: structPairs.filter((r) => r.sameComplex).length,
      },
      water,
      geometryRead: { ...geomStats, monumentsWithGeometry: drawn.size },
      fabric, partition, fill: fillAndAbandon, grain, resolver, selfReport, importNotes,
      faults: chosen.map((f) => ({ cls: f.cls, label: f.label, m2: r2(f.m2), depthM: r2(f.depth), at: { x: r2(f.cx), z: r2(f.cz) }, spanM: r2(f.span), yaw: f.pairYaw })),
    };
  }, {
    MAPID: MAP, PUB: PUBLISHED[MAP] ?? [], TH: T,
    OFF_FRAME: OFF_FRAME_AGREED[MAP] ?? [], WATER_OK: WATER_EXPECTED[MAP] ?? [],
    INJ: INJECT,
    /**
     * A dry structure that publishes collision solids, per map, for `water-stale-licence`.
     * Named here rather than found in the browser so the injection is declarative and the same
     * run is reproducible.
     */
    DRY_ROW: MAP === 'carthage' ? 'byrsa' : 'colosseum',
  });

  /**
   * G17 — the one check that reads the product's own counter, and why that is admissible.
   *
   * The generator prints `[city] <quarter> planned only N buildings from M frontages — the
   * quarter is buried` when a district fails to fill itself. That is a self-report, and this
   * file's whole argument is that self-comparison cannot fail. The exception is a check that
   * can only ever report **failure**: the generator has no incentive and no mechanism to
   * claim it was buried when it was not, so a false PASS is not reachable through it. What a
   * self-report cannot do is prove a quarter is full, and this check does not claim that.
   * The independent version of this test is a roof-coverage measure against the AGEA
   * orthophoto's 60-70% for the historic core, which needs the terrain and the wall line and
   * is a separate instrument (`tools/scratch/city-audit.mjs` is its ancestor).
   */
  {
    const buried = cityLog
      .filter((l) => /planned only .* the quarter is buried/.test(l))
      .map((l) => l.replace(/^\[city\]\s*/, ''));
    out.checks.push({
      id: 'G17',
      question: 'no quarter reports itself unable to build (the generator\'s own counter)',
      ok: buried.length === 0,
      measured: buried.length ? `${buried.length} quarters buried: ${buried.join(' | ')}` : 'no quarter reported itself buried',
      threshold: '0 buried quarters',
    });
    out.buriedQuarters = buried;
    out.verdict.passed = out.checks.filter((c) => c.ok && !c.na).length;
    out.verdict.of = out.checks.filter((c) => !c.na).length;
    out.verdict.failing = out.verdict.of - out.verdict.passed;
    out.verdict.notApplicable = out.checks.filter((c) => c.na).map((c) => c.id);
    out.verdict.declared = out.checks.length;
    out.verdict.ok = out.verdict.passed === out.verdict.of;
  }

  // ---- the verdict, first, because that is what a gate is for -----------
  console.log(`\n=== probe-fabric  ${out.map}  (city plan "${out.cityId}") ===`);
  if (INJECT.length) {
    console.log('\n  !!! FAULT INJECTION RUN — THIS IS NOT A READING OF THE CITY !!!');
    for (const k of INJECT) {
      console.log(`      --inject=${k}  must turn ${INJECTIONS[k].hits} red`);
      console.log(`          ${INJECTIONS[k].what}`);
    }
    for (const n of out.injectNotes ?? []) console.log(`      applied: ${n}`);
    console.log('');
  }
  /*
   * `Number(id.slice(1))` was the sort and `Number('8c')` is NaN, so G8c, G8d, G13a and G13b
   * would have sorted into whatever order they were pushed in and the table would have read as
   * scrambled. Sort on the numeric part and then on the suffix.
   */
  const sortKey = (id) => {
    const m = /^G(\d+)([a-z]*)$/.exec(id);
    return m ? [Number(m[1]), m[2]] : [999, id];
  };
  out.checks.sort((a, b) => {
    const ka = sortKey(a.id);
    const kb = sortKey(b.id);
    return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0);
  });
  for (const c of out.checks) {
    console.log(`  ${c.na ? 'n/a ' : c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.question}`);
    console.log(`         measured: ${c.measured}`);
    console.log(`         gate:     ${c.threshold}`);
  }
  const na = out.verdict.notApplicable;
  console.log(
    `\n  VERDICT  ${out.verdict.passed}/${out.verdict.of}  ${out.verdict.ok ? 'PASS' : 'FAIL'}`
    + `   (${out.verdict.failing} failing, ${out.verdict.declared} checks declared`
    + `${na.length ? `, ${na.length} not applicable on this map: ${na.join(', ')}` : ''})\n`
  );

  console.log(JSON.stringify(out, null, 1));
  if (cityLog.length) {
    console.log('\n--- what the city said about itself at boot ---');
    for (const l of cityLog) console.log(l);
  }
  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(path.resolve(ROOT, JSON_OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(ROOT, JSON_OUT), JSON.stringify({ thresholds: T, cityLog, ...out }, null, 1));
  }

  if (SHOTS && out.faults.length) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const cdp = await page.context().newCDPSession(page);
    for (let i = 0; i < out.faults.length; i++) {
      const f = out.faults[i];
      // Look ACROSS the pair, not along it: a yaw perpendicular to the line joining the two
      // centres puts both structures side by side in frame, which is what makes an overlap
      // legible rather than foreshortened.
      const yaw = f.yaw + Math.PI / 2;
      /*
       * High oblique, not close. The rig couples zoom to pitch and to eye height, so a low
       * zoom sits in the grass: the first version of this shot used 0.52 and photographed
       * four square metres of paving with the fault entirely outside the frame. The shot
       * table's own city framings are the calibration — `campus` 0.80, `deep` 0.86, `wide`
       * 0.95 — so a fault and the street it stands in wants the 0.84-0.90 band.
       */
      const zoom = Math.max(0.84, Math.min(0.90, 0.84 + (f.spanM ?? 0) / 2000));
      await page.evaluate(([x, z, zm, yw]) => {
        // The HUD is not the subject. Hidden once, before the first frame is asked for.
        const r = document.getElementById('hud-root');
        if (r) r.style.setProperty('display', 'none', 'important');
        window.__game.setCamera(x, z, zm, yw);
      }, [f.at.x, f.at.z, zoom, yaw]);
      // Real frames after the jump: `setCamera` is instant but TAA needs history, and the
      // rig's own note says a framing measured through a still-moving camera is suspect.
      // Timed and bounded: the first frame at a new camera links shader programs, which this
      // project has measured at 583 ms worst and 290 ms typical on a loaded box, and a probe
      // that hangs here looks identical to a probe that crashed.
      const t0 = Date.now();
      await Promise.race([
        page.evaluate(() => window.__game.advance(0.2)),
        new Promise((r) => setTimeout(r, 60000)),
      ]);
      const tAdv = Date.now() - t0;
      await page.waitForTimeout(900);
      const name = `${MAP}-${String(i + 1).padStart(2, '0')}-${f.cls}.png`;
      /*
       * CDP `Page.captureScreenshot`, not `page.screenshot`, and the reason is measured.
       *
       * `page.screenshot` timed out on BOTH maps at its 30 s default and again at 180 s.
       * Playwright's own wrapper waits for the page to reach a stable state before it asks
       * the compositor for a frame, and a page whose rAF loop is driving a 3.1 M-triangle
       * WebGL scene on a GPU shared with five other agents' Chromiums never presents as
       * stable. CDP asks the browser for the frame and nothing else, which is what a probe
       * wants: this is a diagnostic frame, not a graded plate.
       */
      const t1 = Date.now();
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(data, 'base64'));
      const tCap = Date.now() - t1;
      console.log(`[shot] ${name}  ${f.label}  ${f.m2} m2  cam x=${f.at.x} z=${f.at.z} zoom=${zoom.toFixed(2)} yaw=${yaw.toFixed(3)}  advance ${tAdv} ms, capture ${tCap} ms`);
    }
  }

  if (INJECT.length) {
    const expect = new Set();
    for (const k of INJECT) for (const id of INJECTIONS[k].hits.split(/[ ,(]+/)) if (/^G\d/.test(id)) expect.add(id);
    const red = new Set(out.checks.filter((c) => !c.ok && !c.na).map((c) => c.id));
    const missed = [...expect].filter((id) => !red.has(id));
    console.log(
      `  INJECTION RESULT  expected red: [${[...expect].join(', ')}]`
      + `  actually red: [${[...red].join(', ')}]`
      + (missed.length ? `  *** DID NOT GO RED: ${missed.join(', ')} ***` : '  — every injected check went red')
    );
    // An injected run is never a pass, whatever the checks said.
    exitCode = missed.length ? 3 : 1;
  } else if (!out.verdict.ok && !NO_GATE) {
    exitCode = 1;
  }
} catch (err) {
  console.error('[probe-fabric] failed:', err && err.stack ? err.stack : err);
  exitCode = 2;
} finally {
  await browser.close();
  killServer();
}
process.exit(exitCode);
