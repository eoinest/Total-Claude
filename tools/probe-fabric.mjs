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
 *     wall builder's stone — and corroborated on the drawn geometry of both.
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
 * Twenty-one checks, each with its threshold as a named constant and the reasoning beside it.
 * The verdict is `n/21` and the exit code is non-zero on any failure, so this can sit in a
 * pre-merge gate for the city rebuild.
 *
 * **It gates BOTH of Rome's two independent faults.** `docs/ROME-FABRIC.md` §2 establishes
 * that the fabric is broken twice over: monuments that must intersect because positions
 * compress 10.2x areally while footprints compress 2.07x (G1-G3, G12-G13), *and* seventeen
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
 *   G11      every sourced monument is present, and the anachronisms are absent.
 *   G12      every sourced monument has its published ASPECT RATIO. Scale-free.
 *   G13      every sourced monument is compressed by the same factor as its cohort.
 *   G14-G16  the stone the player sees is the footprint the game collides with, and it does
 *            not stand in anybody else's plot. Read from vertices; no plan involved.
 *   G17      no quarter reports itself unable to build.
 *   G18-G19  the layout REGIONS partition the ground — no overlapping pair, and claimed area
 *            over available ground = 1.00. This is the second, independent fault
 *            (`docs/ROME-FABRIC.md` §2.3): seventeen rectangles claiming 266% of the city.
 *            No footprint-overlap test can see it, because contested ground is handed to
 *            whichever quarter was planned first and the buildings come out disjoint.
 *   G20-G21  the fabric's GRAIN comes from the street network, not from `hash2`. A block's
 *            orientation against the street that bounds it, and against its own neighbours.
 *
 * **Today's Rome fails it comprehensively, and that is the point.** Those numbers are the
 * "before" column the rebuild is measured against.
 *
 *   TC_NO_HMR=1 node tools/probe-fabric.mjs --map=campus-martius --port=5951
 *   TC_NO_HMR=1 node tools/probe-fabric.mjs --map=carthage       --port=5951
 *   ... --shots            three frames of the three worst faults
 *   ... --json=<path>      the whole record
 *   ... --no-gate          always exit 0 (for taking a "before" reading in CI)
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
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
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
   * Scale consistency: each monument's modelled/published ratio must sit within this
   * fraction of the **median ratio of the cohort**.
   *
   * A map is allowed to compress plan uniformly — Rome's `PLAN_SCALE` is a documented and
   * defended decision. It is not allowed to compress one monument differently from
   * another, because that is a modelling error and not a projection. Taking the reference
   * from the cohort's own median means the gate needs no repo constant and survives a
   * change of plan scale. 0.15 catches the Iseum Campense, which `docs/ROME.md` §6.3 says
   * is "too small by a factor of three".
   */
  SCALE_SPREAD_TOL: 0.15,
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
      len: 621, wid: 118, conf: 'published', gate: true,
      src: 'Humphrey, Roman Circuses: Arenas for Chariot Racing (1986), 56-131 — the arena '
        + '621 × 118 m. This is the pair the owner\'s brief names.',
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
      len: 218, wid: 112, conf: 'repo-cited', gate: true,
      src: 'Platner & Ashby 1929 s.v. Thermae Antoninianae for the complex; DeLaine, The Baths '
        + 'of Caracalla (JRA Suppl. 25, 1997) measures the block at c. 214 × 110 m. 218 × 112 is '
        + 'the pair survey.ts states and it sits inside DeLaine\'s spread. NOTE: survey.ts\'s '
        + 'own prose says "the block is what is modelled ... 218 × 112" and then models '
        + '218 × 140. This gate is measuring that discrepancy.',
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
    + '  Pass a free --port in the 5900s.'
  );
  process.exit(2);
}
const server = spawn(
  'npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
  {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      TC_NO_HMR: '1',
      TC_VITE_CACHE_DIR: process.env.TC_VITE_CACHE_DIR ?? path.join(ROOT, '.vite', 'probe-fabric'),
    },
  }
);
if (!(await up(150000))) {
  console.error('[probe-fabric] vite did not start on', PORT);
  server.kill('SIGTERM');
  process.exit(2);
}
/*
 * An agent that starts a server owns killing it, and a `finally` block does not discharge
 * that: this tool was SIGKILLed mid-run during a machine pause and left its vite listening on
 * 5951, which the next run then correctly refused to use. Nineteen orphaned servers were swept
 * off this box in one pass, several more than a day old. So the kill is registered three ways —
 * `unref` so a forgotten handle cannot hold node open, an `exit` hook for the normal and the
 * throwing paths, and explicit signal handlers because the default SIGINT/SIGTERM disposition
 * terminates without running `exit` hooks. `tools/lib/menu-boot.mjs` documents the first two.
 */
let killed = false;
const killServer = () => {
  if (killed) return;
  killed = true;
  try { server.kill('SIGTERM'); } catch { /* already gone */ }
};
server.unref();
process.once('exit', killServer);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(sig, () => { killServer(); process.exit(130); });
}
console.log(`[probe-fabric] own vite on ${base}  map=${MAP}  tier=${TIER}  (pid ${server.pid})`);

// ---------------------------------------------------------------------------
/*
 * `--use-angle=metal`, and it is not a nicety.
 *
 * A bare `chromium.launch()` on this box comes up with `--use-angle=swiftshader-webgl`: the
 * whole scene rasterised in software. Boots took four to six minutes and every screenshot
 * timed out, at 30 s and again at 180 s, on both maps — which reads as a hung page and is a
 * missing flag. `tools/shoot.mjs:1548` has carried these args since the shot harness was
 * written; nothing pointed a new tool at them. Check the GPU process's command line before
 * believing any timing taken through Playwright here:
 *   ps -A -o command | grep 'type=gpu-process'
 */
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
  ],
});
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

  const out = await page.evaluate(async ({ MAPID, PUB, TH }) => {
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
    const importNotes = [];
    try {
      if (MAPID === 'campus-martius') {
        const L = await import('/src/city/rome/layout.ts');
        armature = L.WAYS.map((w) => ({ id: w.id, cls: w.cls, path: w.path, width: w.width }));
        planLandmarks = L.LANDMARKS;
        planScaleDeclared = L.PLAN_SCALE;
        precinctDeclared = L.PRECINCT;
        owners = L.LANDMARKS.map((l) => ({ id: l.id, name: l.name, x: l.x, z: l.z, reach: Math.hypot(l.hw, l.hd), soft: !!l.soft }));
        regions = L.DISTRICTS.map((d) => ({ id: d.id, x: d.x, z: d.z, hw: d.hw, hd: d.hd, rot: d.rot }));
      } else if (MAPID === 'carthage') {
        const L = await import('/src/city/carthage/layout.ts');
        armature = L.PUNIC_WAYS.map((w) => ({ id: w.id, cls: w.cls, path: w.path, width: w.width }));
        owners = L.MONUMENTS.map((m) => ({ id: m.id, name: m.name, x: m.x, z: m.z, reach: Math.hypot(m.hw + m.clear, m.hd + m.clear), soft: false }));
        regions = L.QUARTERS.map((q) => ({ id: q.id, x: q.x, z: q.z, hw: q.hw, hd: q.hd, rot: q.rot }));
      }
    } catch (e) {
      importNotes.push(`plan import failed: ${e && e.message ? e.message : String(e)}`);
    }
    if (!owners) owners = landmarkRefs.map((l) => ({ id: l.id, name: l.name, x: l.x, z: l.z, reach: 60, soft: false }));
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
    const plots = [...mons, ...bldgs].map((e) => ({ id: e.id, name: e.name, kind: e.o.kind, poly: obPoly(erode(e.o, 0.5)), bb: e.bb }));
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
              const cur = sink.get(key) ?? { stone: c.name, standingIn: q.name, hits: 0, x: 0, z: 0 };
              cur.hits++;
              cur.x = x;
              cur.z = z;
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
        absentExpected: !!row.absentExpected,
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
    const partition = await (async () => {
      if (!regions || !terrain || circuit.length === 0) {
        return { measured: false, why: !regions ? 'no region list for this map' : 'no terrain or no built circuit' };
      }
      const TOPO = await import('/src/terrain/topography.ts');
      const EXT = TOPO.HALF_EXTENT;
      const polys = regions.map((r) => {
        const poly = planPoly(r);
        return { id: r.id, poly: ccw(poly), bb: bbox(poly), area: 4 * r.hw * r.hd };
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
          if (terrain.heightAt(x, z) < 0.2) continue;  // water
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
            if (!inPoly(r.poly, x, z)) continue;
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
          const ar = clipArea(polys[i].poly, polys[j].poly);
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
        worstOverlaps: worst.slice(0, 10).map((w) => ({ a: w.a, b: w.b, m2: r2(w.m2) })),
        perRegionInsideAvailableM2: [...perRegion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([id, m2]) => ({ id, m2: r2(m2) })),
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
      for (let i = 0; i < bldgs.length; i++) {
        const a = bldgs[i];
        gridQuery(bldgGrid, a.bb, TH.GRAIN_NEIGHBOUR_M, (j) => {
          if (j <= i) return;
          const b = bldgs[j];
          const d = Math.hypot(a.o.x - b.o.x, a.o.z - b.o.z);
          if (d > TH.GRAIN_NEIGHBOUR_M) return;
          neigh.push(foldDeg(a.o.rot - b.o.rot));
        });
      }
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
    const gate = (id, question, ok, measured, threshold) => checks.push({ id, question, ok: !!ok, measured, threshold });

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
    {
      const k = clearance.byClass['monument/monument'];
      gate('G8', 'every monument keeps its street from its neighbour',
        k ? k.minM >= TH.CLEAR_MON_MON : true, k ? `min ${k.minM} m (${k.between})` : 'no monument pairs', `>= ${TH.CLEAR_MON_MON} m`);
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
    {
      const missing = fid.filter((f) => f.gate && !f.present && !f.absentExpected).map((f) => f.name);
      const wrongPresent = fid.filter((f) => f.absentExpected && f.present).map((f) => f.name);
      gate('G11', 'every sourced monument is present, and the anachronisms are not',
        missing.length === 0 && wrongPresent.length === 0,
        missing.length || wrongPresent.length ? `missing: [${missing.join(', ')}]; present but should not be: [${wrongPresent.join(', ')}]` : `${gated.length} sourced monuments present`,
        'all present, no anachronisms');
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
    {
      const n = [...stoneInMon.values()].reduce((s, e) => s + e.hits, 0);
      gate('G15', "no monument's drawn stone stands inside another monument's footprint",
        stoneInMon.size === 0,
        `${n} sampled monument vertices across ${stoneInMon.size} monument pairs`, '0 vertices');
    }
    {
      const n = [...stoneInBld.values()].reduce((s, e) => s + e.hits, 0);
      const bset = new Set([...stoneInBld.values()].map((e) => e.standingIn));
      gate('G16', "no monument's drawn stone stands inside a building's footprint",
        stoneInBld.size === 0,
        `${n} sampled monument vertices standing in ${bset.size} buildings, over ${stoneInBld.size} monument/building pairs`, '0 vertices');
    }
    {
      const bad = gated.filter((f) => f.scaleErrPlan !== null && f.scaleErrPlan > TH.SCALE_SPREAD_TOL);
      gate('G13', 'every sourced monument is compressed by the same factor as its cohort',
        bad.length === 0,
        `cohort median modelled/published = ${r3(medPlan)} (plan) / ${r3(medDrawn)} (drawn); out of tolerance: ${bad.length} [${bad.map((f) => `${f.id} ${f.planScaleRatio}`).join('; ')}]`,
        `<= ${TH.SCALE_SPREAD_TOL} relative to the cohort median`);
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
            + ` (their declared rectangles total ${P.declaredOverAvailable}x it); ${P.coverageOverAvailable}x covered at`
            + ` least once; ${P.doubleClaimedM2} m2 claimed more than once`
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
        + ` 15 deg across a 40 m gap`,
        `median <= ${TH.GRAIN_SEAM_TOL_DEG} deg AND seams <= ${(TH.GRAIN_SEAM_FRACTION * 100).toFixed(0)}%`);
    }
    const passed = checks.filter((c) => c.ok).length;

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
    faults.sort((a, b) => b.m2 - a.m2);
    const chosen = [];
    const seen = new Set();
    for (const f of faults) {
      if (seen.has(f.cls)) continue;
      seen.add(f.cls);
      chosen.push(f);
      if (chosen.length === 3) break;
    }
    for (const f of faults) { if (chosen.length >= 3) break; if (!chosen.includes(f)) chosen.push(f); }

    return {
      map: MAPID, cityId: stats.id, triangles: stats.triangles,
      verdict: { passed, of: checks.length, ok: passed === checks.length },
      checks,
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
        totalStructureOverlapM2: r2(mm.totalM2 + mb.totalM2 + bb2.totalM2),
        pctOfBuiltArea: r2(((mm.totalM2 + mb.totalM2 + bb2.totalM2) / Math.max(1, builtArea)) * 100),
      },
      clearance,
      fidelity: { measuredPlanCompression: r3(medPlan), measuredDrawnCompression: r3(medDrawn), rows: fid },
      geometryRead: { ...geomStats, monumentsWithGeometry: drawn.size },
      fabric, partition, grain, resolver, selfReport, importNotes,
      faults: chosen.map((f) => ({ cls: f.cls, label: f.label, m2: r2(f.m2), depthM: r2(f.depth), at: { x: r2(f.cx), z: r2(f.cz) }, spanM: r2(f.span), yaw: f.pairYaw })),
    };
  }, { MAPID: MAP, PUB: PUBLISHED[MAP] ?? [], TH: T });

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
    out.verdict.passed = out.checks.filter((c) => c.ok).length;
    out.verdict.of = out.checks.length;
    out.verdict.ok = out.verdict.passed === out.verdict.of;
  }

  // ---- the verdict, first, because that is what a gate is for -----------
  console.log(`\n=== probe-fabric  ${out.map}  (city plan "${out.cityId}") ===`);
  out.checks.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  for (const c of out.checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.question}`);
    console.log(`         measured: ${c.measured}`);
    console.log(`         gate:     ${c.threshold}`);
  }
  console.log(`\n  VERDICT  ${out.verdict.passed}/${out.verdict.of}  ${out.verdict.ok ? 'PASS' : 'FAIL'}\n`);

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
      const zoom = Math.max(0.52, Math.min(0.84, 0.52 + (f.spanM ?? 60) / 900));
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

  if (!out.verdict.ok && !NO_GATE) exitCode = 1;
} catch (err) {
  console.error('[probe-fabric] failed:', err && err.stack ? err.stack : err);
  exitCode = 2;
} finally {
  await browser.close();
  killServer();
}
process.exit(exitCode);
