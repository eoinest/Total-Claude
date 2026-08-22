# Map method — what worked, what didn't, and what we would do differently

A running record of *how* we build a map, kept while building one rather than remembered afterwards.
Started 21 August 2026, at the moment the owner looked at Rome's city fabric and said: *"i think we
are better basically starting from scratch here… we should really follow the carthage method with the
grid system and planning everything out from top down, not trying to make something broken work."*

**This file is not a design document and not a status report.** `CARTHAGE.md` and `ROME.md` say what
to build. `HANDOFF.md` says where we are. `CHANGELOG.md` says what shipped. **This says what the
method cost and whether it paid** — so that the fourth map is built the way the second one was and
not the way the third one was.

## How to use it

- **Read §1 before starting any map work.** It is the distilled part. If it is wrong, fix it here.
- **Append to §3 as you go**, one entry per phase, while the phase is fresh. An entry written a week
  later is a memory; an entry written the same day is a measurement.
- Every entry needs **what we expected** as well as what happened. A log of outcomes without
  predictions cannot tell you whether the method is any good — only whether the result was.
- **Record the failures at least as carefully as the successes.** On this project the corrections
  have consistently been worth more than the original findings, and the same is true of methods.
- Every agent doing map work is expected to append. Say what you actually did, not what the brief
  told you to do.

---

## 1. Rules earned

Distilled from §3. Short, and each one traceable to an entry that paid for it.

1. **Plan top-down, in this order: water and terrain → the wall → landmarks → roads → a grid derived
   from the roads → ordinary buildings into the grid.** Nothing is placed before the thing that
   constrains it. Carthage did this. Rome did not, and Rome's fabric is being thrown away.
2. **The survey table is the source of truth, and every row cites a source.** Feature, real
   coordinates, engine coordinates, source. `CARTHAGE.md` §2.5 is the format. A number in prose
   without a source is a guess that will be treated as a measurement by the next reader.
3. **State the sanity checks that must hold *after* the build, in the design, before building.**
   Carthage's §2.5 ends with approach distance, city depth, wall length. They are how you find out
   the build went wrong while you can still cheaply fix it.
4. **Positions compress. Cross-sections do not.** And there is a third category: anything whose
   *slope* matters cannot take a compressed run against an uncompressed height. Name every override
   explicitly rather than bending the projection quietly. (`CARTHAGE.md` §2.4.)
5. **A layout must be correct by construction, not corrected afterwards.** A resolver that nudges
   overlapping buildings apart is evidence the layout step was wrong. It also hides the fault from
   whoever looks next — **and hiding it is not the worst of it.** Measured on Rome: the shipped city
   has zero intersecting monument pairs and zero buildings inside a monument, and it buys that by
   displacing every monument a mean of 65 and a worst of 168 world metres from its own surveyed
   position. The resolver does not fail to fix the overlap; it fixes the overlap and *creates the
   fault the owner reported*. And it gets worse when you give it room: raising `KZ` from 0.222 to
   0.35 left it 13 conflicts to discharge instead of 22 and it moved everything **twice as far**
   (mean 142 m, worst 399 m). **A solver given more space does not do less work. It does more,
   further.**
6. **Every invariant needs an instrument, and the instrument must compare against something outside
   the thing being checked.** This project's most expensive recurring failure is a check that
   compares something against itself. Real published dimensions, a georeferenced plate, geometry read
   back from the scene — not the plan that generated the geometry.
7. **Verify a reference before you trust it.** Confirm it depicts the city you think it does, at the
   date you think it does, and that its licence permits use.
8. **A layout region must be a *partition*, not a set of rectangles.** Overlapping regions allocate
   ground by planning order rather than by plan, and planning order is invisible in the output. Rome's
   seventeen districts claimed **266 %** of the ground with 79 overlapping pairs, and the file's own
   comment justified it — *"a district costs nothing where it overlaps a neighbour."* It costs the
   whole fabric. Use a real administrative division, which tiles because that is what it is.
9. **Orientation must come from the streets, not from a hash.** A block's angle is a property of the
   lines that bound it. Rome seeded each district's rotation from `hash2(...)` at ±20°, so two blocks
   either side of an invisible boundary sit at different angles with a random offset. **That is the
   definition of a quilt**, and no amount of texture or massing hides it. Carthage's `CITY_BEARING = 0`
   plus a world-snapped lattice is the crude version of the same rule and it is why Carthage reads.
10. **Before choosing a projection, compute whether the module fits inside it.** Take the real
   spacing of the smallest repeated thing the map needs — an insula between two cross-streets, a
   tower interval, a plot frontage — project it, and check the uncompressed cross-section still fits
   in the projected gap. At Rome's `KZ` a true-scale insula did not fit between two projected
   cross-streets **at any point in the real range**, so the grid step was arithmetically impossible
   before anyone wrote a line of it. One division would have found this in 2019 as easily as in 2026.
11. **Measure the complaint first, in the units of the complaint.** When somebody says the map is
   wrong, the first measurement of the pass is of *that*, on the unchanged tree, before anything is
   touched. Rome's fabric was diagnosed as an overlap problem and rebuilt on that basis; the shipped
   city has **zero** overlapping monuments, and what the owner was looking at was **displacement** —
   a solver moving surveyed monuments a mean of 65 and a worst of 168 world metres to make the
   overlaps go away. Both diagnoses point at the same fix, so nothing was wasted, but for two passes
   nobody could say how big the reported fault was.
12. **When a projection constant changes, grep every expression that multiplies by it and ask whether
   that expression meant it.** A district extent written `hn * KZ * 3.5`, a lookup table bounded by
   `HALF_EXTENT + 200`, a `clamp` to the map's south edge — none of those was *about* depth, and all
   three would have shipped as silent side effects of changing `KZ`. **A constant appearing in a
   formula is not the same as a constant the formula is about.**
13. **A check that goes dark is worse than a check that fails.** Removing five monuments from Rome's
   frame silently took `assertTopology` from 44 rules to 34 and `assertHillRing` from 8 members to 6,
   and it exposed a latent bug in the second that would have failed a correct build. Any check that
   can lose part of its population must separate "excluded by design" from "missing", count the
   exclusions, and print them by name.
14. **A curve can pass through every one of its control points and still bend the wrong way, and a
   residual against those points cannot tell you.** Rome's Tiber was a cubic Hermite through twelve
   knots and its error was reported as **0.1 world metres**. The report was honest: it compared the
   transcribed table against `worldOf` of *the same twelve latitudes and longitudes*, which measures
   the projection's arithmetic. It cannot see the shape between two knots, and it cannot see whether
   a knot is in the river. Measured against the plate, **one of the twelve stood on water** and the
   median knot was 115 real metres from the channel. **Grade a shape against a source dense enough
   to have a shape**, and grade it with: lateral departure at fixed intervals, the *swing* across a
   named span, and the **sign of curvature** station by station. An inverted bend has a small mean
   error and cannot have the right sign.
15. **Sparse control interpolated into a shape is the same fault one level up, and it caught two
   instruments in one afternoon.** A sixteen-bridge river control graded the engine against the
   *chords* between bridges: over the 842 m band beside the assaulted front there are two bridges in
   the list, so the "plate" being compared to was a straight line across the very bend at issue. It
   reported a 75 m median departure and a 1.435 swing ratio on a channel within 2.4 m of a dense
   trace. And a by-northing comparison of an **east–west** reach is degenerate: one northing has
   several answers, and it inflated a **14.7 m** perpendicular error into **392 m**. Use a sparse
   control as a *point* control — perpendicular distance from each point to the curve — and use a
   dense one for shape.
16. **A representation that cannot express the thing will not be fixed by better data.** Rome's
   channel was `x = f(z)`, a single-valued function of northing. The Tiber turns, so where it ran at
   76° off the z axis the drawn river reached 385 world metres across a row against the 94 it
   declared, and the far side of the Campus Martius was reported as being *in the river*. No amount
   of digitising fixes that: feed a thousand points into `x = f(z)` and it reproduces the fault.
   **Change the representation first** — here, a polyline in the plane plus a signed distance field —
   and then the data means something. The same question is worth asking of every survey the project
   holds: can the type it is stored in say the thing it needs to say?
17. **A constant in world metres is a variable in real metres, whenever the projection is
   anisotropic.** `RIVER_HALF_WIDTH = 47` was a true-scale cross-section, which rule 4 endorses. At
   `KX` 0.443 and `KZ` 0.35 it drew a channel **212 real metres** wide where the Tiber runs
   north–south and **269** where it runs east–west — one number, two widths, against a plate whose
   channel is 100.8 m. Cross-sections in an anisotropic frame need a *rule*, not a constant: author
   in real metres, project, and name the scale. Rule 4's override is still available and is now one
   named number (`RIVER_WIDTH_SCALE`) rather than a figure nobody could convert.
18. **When a solver stands between your change and the output, your change is not what the gate
   measures.** Re-surveying the river moved two monuments that are placed *off* the river —
   `FAR_BANK` pins far-bank landmarks to the west bank and ignores their own surveyed easting — and
   `resolveOverlaps` cascaded that into every monument on the map. `probe-fabric` lost G9 (a
   monument-to-insula clearance of 1.34 m against a 1.5 m gate) and G15, both about monuments
   nowhere near the water. The same pass, by placing far-bank monuments from their own survey and
   only clamping them with the river, took the resolver's worst displacement from **690 m to 118 m**
   — better than the frame change that preceded it managed. **A gate downstream of a solver reports
   the solver.**

---

## 2. The priors going in

Written down now so that later we can check whether we were right, rather than reconstructing our
beliefs after the fact.

- **Carthage came out well and Rome came out badly, and both had good reference material.**
  `reference/rome-plans/` already held georeferenced Lanciani 1901 plates and SITAR vector data
  before any of this. So "we did not have references" is *not* the explanation, and any diagnosis
  that stops there is wrong.
- ~~**The leading hypothesis is arithmetic, not carelessness.**~~ **CONFIRMED, 21 Aug 2026, with one
  correction that changes what the fix looks like.** `docs/ROME-FABRIC.md` §2.2 settles it. The
  closed form is

  ```
  clear world ground = K·G − (PLAN_SCALE·PRECINCT − K)·(a + b) − STREET_GAP
  ```

  for two monuments with half-extents `a`, `b`, a real clear gap `G`, and an axis compression `K`.
  At `PLAN_SCALE = 0.65` that is negative unless `G > 0.570·(a+b) + 15.8 m` east–west and
  **`G > 2.133·(a+b) + 31.5 m` north–south.** Measured over the 465 pairs in Rome's survey: **34
  pairs are closer than the 7 m street the code itself demands, 31 interpenetrate, and 29 of the 34
  are separate in reality.** The Stadium of Domitian and the Theatre of Pompey are **273 real metres
  apart and overlap by 49.6 world metres** — a 323 m swing.

  **The correction: the fault is anisotropic, and it is 4.5× worse north–south than east–west,**
  because `KX` = 0.443 and `KZ` = 0.222. The prior stated it as a single ~10× areal figure. Any fix
  that treats it as one scalar will half-work, which is exactly what `PLAN_SCALE = 0.65` is: it was
  measured and tuned against a mean, so it is roughly right in x and hopeless in z.

- **And the hypothesis was *not the whole cause*, which is the more useful finding.** It explains the
  monuments. It does not explain the quilt. There is a **second, independent** fault of comparable
  size and it is nothing to do with `PLAN_SCALE`: Rome's seventeen fabric districts are inflated
  **7.17× over the honest projection** (`he·KX·2.05`, `hn·KZ·3.5`), claim **266 % of the available
  ground** in 79 overlapping pairs, and each lays its own lattice in its own hash-seeded frame at
  ±20°. `ROME-FABRIC.md` §2.3. **A diagnosis that had stopped at `PLAN_SCALE` would have fixed the
  monuments and shipped the same quilt.** New rules 8 and 9 above are what that cost.

- ~~**If the hypothesis holds, the frame itself has to change.**~~ **Half right, and the half that is
  wrong matters.** The frame does have to change — but it cannot change much, and changing it is not
  sufficient. Measured: **`KX` is within 5 % of a hard ceiling** (0.443 against 0.466, at which the
  circuit's east anchor lands exactly on the map edge), so east–west compression is not a lever at
  all. `KZ` can rise, but only by pushing the southern city off the +Z edge. And **no combination of
  `KX`, `KZ` and a single `PLAN_SCALE` gives zero overlaps**: even at `KZ` = 0.413, within 7 % of
  isotropic and with 14 of 34 monuments already off the +Z edge, three pairs still conflict at
  `PLAN_SCALE` 0.65. The largest uniform footprint scale with zero conflicts is **0.232**, which
  draws a 44 m Colosseum. The cause is monument *density in one band*, not overall coverage — twelve
  of the survey's monuments sit in the Campus Martius, and the projection allots it 454 world metres. So the answer is a frame change *plus*
  per-monument authored footprints *plus* merging the five complexes the survey wrongly models as
  free-standing boxes. `ROME-FABRIC.md` §4.5 recommends `KZ` = 0.35 and answers `ROME.md` §2.3's
  three arguments one at a time. Two of the three turn out to be preserved intact by the
  recommendation, and the third — that a player's distance intuition should transfer between Rome and
  Carthage — is the one genuine cost.

- **Prediction, confirmed in advance of the build and worth keeping:** the rebuild will succeed or
  fail on the *grid* step, not the landmark step. **I agree, and there is now evidence rather than
  intuition.** The grid step is exactly where the fabric died the first time: the districts, their
  overlap and their per-district rotation are the grid step, and they were never graded by anything.
  The landmark step, by contrast, already has the project's best artefact — a 34-row survey with
  real coordinates, real dimensions, measured bearings and a citation per row, several of which argue
  against their own earlier wrong values.

  **One refinement to the prediction.** The grid step's risk is not that it is hard to write; it is
  that **it has no natural instrument**, so it will be graded by screenshots. Non-intersection is
  easy to check and will pass on a quilt; a quilt is only detectable as a *distribution* — block
  orientation over patch size, against the orthophoto's 150–400 m / 15–40° grain.
  `ROME-FABRIC.md` §4.4 check 5 is the only check in the plan that can fail on a quilt and pass on a
  city, and it is the one most likely to be dropped as "nice to have". **If the rebuild goes wrong
  again, that is where, and the mechanism will be that check 5 was never written.**

---

## 3. The log

Newest last. One entry per phase. Format: **what we did · what we expected · what happened ·
verdict.**

### 21 Aug 2026 — Rome phase A and B, built the old way, before the decision to restart

**What we did.** Wrote `ROME.md` (2,764 lines, modelled on `CARTHAGE.md`), then built its §15 tasks 0
through 5: the map into its own module, the Tiber onto the survey, a graded bench under the wall, the
deployment ground, the circuit as a 36-bay survey polyline, the Muro Torto, and three gates plus a
postern.

**What we expected.** That following `ROME.md` task by task, each with its own acceptance
measurement, would produce a good map — the same way `CARTHAGE.md` had.

**What happened.** The *linear* work came out well and measures well: the Tiber's survey error went
775.8 m → 0.1 m, the worst bay step 28.39 m → 8.11 m → 5.23 m, reachable runs improved, zero
projectile rays pass through the circuit anywhere. Then the owner looked at the result and said the
buildings were "completely off" and the fabric should be rebuilt from scratch.

**Verdict — the method was right about the things it measured and silent about the thing that
mattered.** Every task in §15 had an acceptance measurement, and every one of those measurements was
about the wall, the ground or the survey. **Not one of them was about whether the city looked like
Rome.** The fabric had no acceptance measurement at all, so it was never graded, so it drifted — and
a 2,764-line design document did not save it, because the document inherited the same blind spot.

**What we would do differently:** give the *fabric* an acceptance measurement in the design, at the
same time as the wall gets one. If a thing has no instrument, it will be the thing that is wrong.

### 21 Aug 2026 — the reference material

**What we did.** The owner supplied six images and a saved web page. Before dispatching anyone to
use them, checked what they actually depict.

**What happened.** `rome city map 200 ad.jpg` is **Roman London** — Thames, Ludgate, Bishopsgate,
Southwark, Cripplegate. Nothing to do with Rome. The rest are sound, and one is very good: a
1:25,000 *"Plan of Imperial Rome, superimposed on a plan of the modern city, c. 350 AD"* carrying
every gate, all fourteen Augustan regions, the named roads, the aqueducts and every major monument,
**over the modern street grid with a scale bar** — which makes it georeferenceable rather than merely
illustrative.

**Verdict — cheap check, real save.** Two minutes of looking prevented at least one agent
georeferencing the wrong city, and that failure would have been slow to detect because a wrong plan
still produces a plausible-looking result. Rule 7.

---

### 21 Aug 2026 — the fabric diagnosis, and the decision to rebuild the layout layer

**What we did.** Read `CARTHAGE.md` end to end and reverse-engineered its method as a procedure from
the *code* as well as the document (`docs/ROME-FABRIC.md` §1). Then re-derived Rome's projection,
`place()` and `worldRot()` from scratch in a throwaway script rather than importing them, parsed the
34-row survey out of `survey.ts`, and measured every pair. Then priced every available lever —
`KX`, `KZ`, uniform `PLAN_SCALE`, anisotropic footprint scale, culling, and merging — against the
same measurement. Verified and catalogued four reference plates, rejected three.

**What we expected.** Honestly: that `PLAN_SCALE = 0.65` against a ~10× compressed plan would turn
out to be the cause, that the fix would be a smaller `PLAN_SCALE` or a re-fitted projection, and
that the diagnosis would take an afternoon and the recommendation would be one number.

**What happened.** Three surprises, in ascending order of how much they changed the plan.

1. **The `PLAN_SCALE` hypothesis was right and insufficient.** It is confirmed with a closed form
   and 34 measured conflicting pairs — but it explains the *monuments*, not the *quilt*. The quilt
   has a separate cause of comparable size: districts inflated 7.17× over the projection, claiming
   266 % of the ground in 79 overlapping pairs, each with its own hash-seeded rotation. Two faults,
   not one. **A diagnosis that had stopped at the confirmed hypothesis would have fixed the
   monuments and shipped the same city.**
2. **There is no single number that fixes it.** `KX` is already within 5 % of its hard ceiling. The
   largest uniform footprint scale with zero overlaps is 0.232 — a 44 m Colosseum. True footprints
   admit 11 monuments out of 25. Anisotropic footprints squash every round building 2:1. Twelve
   surveyed monuments share one 454-metre band, and no constant absorbs that.
3. **The strongest argument for the recommendation was not the one I went looking for.** I expected
   to argue about monument overlap. The decisive number turned out to be the *module*: at
   `KZ` = 0.222 a real 50–90 m cross-street pitch projects to 11–20 world metres, and a true-scale
   insula is 22 m deep — **so a grid derived from projected streets could not have worked at any
   point in the real range.** The grid step was arithmetically impossible before anyone wrote it.
   That is now rule 10.

**Verdict — the method's gap was not diagnosis, it was the *order* of diagnosis.** Reading
`CARTHAGE.md`'s §2.4 compression rule and then immediately dividing one real module by one
compression factor would have found the blocking constraint in a minute. Instead the project built
a 2,764-line design document, a survey, a projection, a circuit and a fabric generator on top of a
frame that could not host the fabric — and every acceptance measurement it wrote passed, because
every one of them was about the wall, the ground or the survey.

**One methodological thing that worked and should be repeated:** re-deriving the projection and the
placement arithmetic in a throwaway script instead of importing the module under test. It cost
twenty minutes and it is the only reason the numbers in `ROME-FABRIC.md` are evidence rather than an
echo — two existing tools in `tools/scratch/` grade the fabric by re-importing or re-implementing
the code that produced it, and one reports the resolver's distance from its own projection as its
error.

**What we would do differently.**

- **Do the module division before writing the design document, not after building it.** Rule 10.
- **Do not accept a tuned constant as a finding.** `PLAN_SCALE = 0.65` arrived with a five-row
  measured table showing that it reduced mean monument displacement from 174 m to 43 m, and that
  table is honest and correct. It was also read as a solution when it was a *symptom being
  minimised* — 43 metres of displacement is still a solver moving surveyed monuments. **A constant
  whose justification is "it makes the residual smaller" is a description of a fault, not a fix.**
- **Two minutes of looking at a reference is the highest-return work available.** One of six
  supplied plates was a different city with a live copyright notice on it. Rule 7 again.
- **Write the fabric's instrument in the same phase as the fabric's design.** `ROME-FABRIC.md` §5
  Phase 2 puts three of the six probe checks live before any block is generated, specifically so
  that the previous entry's verdict cannot repeat.

### 21 Aug 2026 — Rome fabric phase 1: the projection change, and the survey re-laid on it

**What we did.** Raised `KZ` from 0.222 to 0.35 and left `KX` alone. Re-projected the Tiber's twelve
surveyed knots and re-derived its runout slope. The Aurelian circuit re-projected itself, because it
was already held in survey metres. Wrote `tools/scratch/rome-frame.mjs` — Phase 0's checked-in script
— which re-derives the projection from the two anchors instead of importing it and **parses**
`survey.ts` instead of restating it. Added `assertRomeFrame`, printing `ROME-FABRIC.md` §4.1's
whole-map sanity checks at every boot and publishing them on `CityChecks`. Built a control checkout
at the base commit on a second port and measured everything twice.

**What we expected.** That the wall would come through untouched (`KX` unchanged), that the
georeference would survive (it is upstream of `KZ`), that the Tiber would re-fit to the same 0.1 m,
and that the visible city would improve somewhat because the Campus Martius gets 58 % more depth.

**What happened.** The first three held exactly. The fourth was half right, and the half that was
wrong is the finding.

1. **Every invariant held by construction, and "by construction" is checkable.** 36 bays, west end
   x 2.006, east end x 1334.55, pitch 37.01511 m — byte-identical, because `x = X0 + KX·e` contains
   no `KZ` and `GATE_X`/`GATE_Z` are functions of x and z alone. The 725.7 m approach likewise.
   Tiber survey error 0.1 m → 0.1 m. Bench 266/266 stations ≥ 40 m. Worst walk step 5.23 → 5.50 m, and
   that one *had* to move because the wall line moved 5–60 world m south and stands on new ground.
   **A control checkout on a second port cost fifteen minutes and turned every one of those from an
   argument into a measurement.**
2. **The fabric got measurably better with no fabric work at all.** Buried quarters 6 → 2, and
   `via-lata` — the quarter behind the assaulted gate, the 2.9 % that is the headline symptom in the
   diagnosis — stopped being one of them. Solids the collision layer publishes 903 → 1,259, +39 %.
   Ranked-way samples inside a monument 302/1,040 → 98/956. `probe-fabric` 6/21 → 7/21, with G9 and
   G15 gained.
3. **And the fault the owner actually reported got worse.** `probe-fabric` had just established that
   nothing overlaps on the shipped city because `resolveOverlaps` displaces monuments — mean 65 m,
   worst 168 m — so *displacement* is what "everything is completely off" describes. At `KZ` 0.35 the
   resolver displaces **mean 142 m, worst 399 m**; in real metres, mean 226 → 351 and worst 672 →
   1,098. It has **fewer** conflicts to discharge (13 against 22) and it moves everything further,
   because a deeper band and five fewer southern monuments give it more room to push into and no
   reason not to use it. **A solver given more room does not do less work. It does more, further.**
4. **Four faults that predate this pass and that nothing had measured.** Insulae standing in the
   Tiber — 37 of 903 solids entirely under `WATER_LEVEL` at the base commit, 60 of 1,259 here, with
   `assertNoFabricOverlaps` and `probe-fabric` G1/G2 all reporting zero. `assertHillRing`'s
   cyclic-order test, which normalised each step to the shortest turn and therefore could not
   distinguish a legitimate 213° arc from a 147° inversion — latent until two ring members went off
   the map, at which point it failed a correct build. `place()`'s z clamp, which would have stacked
   five southern monuments on the single line z = 1374 instead of removing them, silently. And a
   district depth written as `hn * KZ * 3.5`, which would have inflated every district 57.7 % as a
   side effect of a projection change.

**Verdict — the frame is right, the frame was never the visible fault, and phase 1 has made the
visible fault worse on its way to fixing it.** Every number `ROME-FABRIC.md` §4.5 promised is
delivered and measured. None of them is what the owner was looking at. He was looking at
`resolveOverlaps`, which phase 2 deletes, and which this phase provoked. That is a real cost of
splitting the work across a review gate and it was accepted deliberately: the alternative was to ship
the frame change and the landmark rebuild together, which would have made it impossible for him to
tell which of the two he was approving, and would have wasted the landmark work if he had rejected
the frame.

**What we would do differently.**

- **Measure the thing the owner complained about, on the base commit, before changing anything.** The
  displacement figures took ten minutes and they reframed the whole phase. Had they been taken at the
  start, the brief would have said "phase 1 will make the visible fault worse, here is by how much,
  here is why that is still the right order" — instead of that being a finding at the end. **The
  first measurement of any pass should be of the complaint, in the units of the complaint.**
- **When a projection constant changes, grep for every expression that multiplies by it and ask
  whether each one meant it.** Three of the four faults in point 4 were things that read `KZ` (or a
  bound derived from the map) for reasons that had nothing to do with depth: a district extent, a
  lookup table's range, a clamp. Each would have shipped as a silent side effect. **A constant that
  appears in a formula is not the same as a constant the formula is about.**
- **A check that goes dark is worse than a check that fails.** Taking five monuments off the map
  silently reduced `assertTopology` from 44 rules to 34 and `assertHillRing` from 8 members to 6.
  Both now separate "the id is off this map" from "the id is a typo", count the skips and print them
  by name. A check count that quietly falls is the shape of the fault this whole file exists about.
- **`tools/qa-determinism.mjs` reuses whatever is already serving the port, with no ownership
  check, and that can silently record a pin from another agent's branch.** `probe-fabric.mjs` and
  `probe-seams.mjs` refuse a port they did not start — *"a reused port serves another branch's
  modules, and the probe then grades a tree it is not standing in"* — and `qa-determinism.mjs`
  does not. With six agents on the box and orphaned servers accumulating, that is one collision
  away from a determinism baseline recorded against somebody else's tree, which is the most
  expensive possible version of this project's recurring "the check compared the wrong thing"
  fault. **Before recording a pin, start your own server, confirm it serves your tree by fetching
  a file and grepping for the change you made, and pass that port.** Every arm in this pass was
  re-verified that way after the fact; all three were clean, and they were clean by luck rather
  than by construction.

- **`--absorb` should have been in the design document.** `ROME-FABRIC.md` §4.5 recommends
  per-monument authored footprints *"seeded at 0.65 and adjusted only where the probe says a pair
  conflicts"* without ever running that adjustment to see where it lands. Running it takes forty
  lines and it changes the recommendation's honesty: zero intersections at frozen positions is
  reachable, but only at a 0.36 floor and a 68 m Colosseum, and three pairs are unabsorbable at any
  floor because two of the three are east–west and `KX` cannot move. **A design that proposes an
  optimisation should run it once before recommending it.**

### 21 Aug 2026 — the Tiber, re-surveyed off the plates, and the representation changed under it

**What we did.** Threw away the twelve-knot spline and re-digitised the Tiber: the centreline as a
least-cost path through gated water on the AGEA 2012 orthophoto, cross-checked against Lanciani's
inked channel; the width off Lanciani, binned and projected; the Tiber Island measured as the bar
between its two arms. 451 stations at 25 m of course length, held in **survey metres** in a new file
`src/terrain/tiberSurvey.ts` and projected by `topography.ts`. Replaced `riverCentreX`'s `x = f(z)`
distance model with a polyline plus a **signed distance field**. Fetched three orthophoto tiles from
the same WMS, layer, CRS and licence as `ASSETS.md` item 8 so the map's northern half stopped being
an extrapolation. Wrote `tools/probe-tiber.mjs`: departure, swing, the sign of curvature, the drawn
channel's width in *real* metres, and everything standing in water.

**What we expected.** That the river was sound and only its *shape between the control points* was
wrong — `ROME-FABRIC.md` §2.6 says *"The Tiber is sound… Keep the polyline"* — so a denser
digitisation through the same twelve points would fix it in an afternoon.

**What happened.** Four surprises, each bigger than the last.

1. **The control points were not on the river.** Measured against the plate, **one of the twelve
   stood on water**; the median knot was 115 real metres from the channel and the worst 1,166. The
   0.1 m residual that had blessed them compared the transcribed table against `worldOf` of the same
   twelve latitudes and longitudes. It was arithmetic, honestly reported, and it could not see the
   river. Rule 14.

2. **A denser table would not have fixed it, because the representation could not hold the answer.**
   `x = f(z)` cannot describe a channel that turns: at the Tiber Island the course runs 76° off the
   z axis, and the drawn river reached 385 world metres across a row against the 94 it declared. That
   is the mechanism behind buildings standing in water, and it is why the count kept moving depending
   on who measured it — 37, 60, 74, 71 — because the *declared* channel and the *drawn* channel
   differed by nearly 3×. Rule 16. A separate judge pass found the same thing independently the same
   afternoon and put it more sharply than we had: *"a denser table will not fix this."*

3. **The width was one number and two answers.** `RIVER_HALF_WIDTH = 47` world metres is 212 real
   metres of channel where the Tiber runs north–south and 269 where it runs east–west, against a
   plate whose channel is 100.8 m. Rule 17. **This bug caught the grading harness as well**, which
   compared 94 world metres against 100.8 real metres and reported agreement — so for one afternoon
   two independent instruments held the same wrong number for the same reason.

4. **The one thing we were told was out of scope turned out to be downstream of us.** `FAR_BANK`
   pins far-bank monuments to the river's west bank and discards their own surveyed easting, so
   moving the river moved them, and `resolveOverlaps` cascaded that into every monument on the map.
   `probe-fabric` went **7/21 → 5/21**, losing G9 and G15, both about monuments nowhere near water.
   Rule 18.

**The numbers, after.** Against the dense plate trace: departure median **2.4 m** (1.1 world m) over
the front, swing ratio **0.990**, **0 inverted curvature stations** on the front. Against the judge's
own harness: the channel is **102.1 real metres** wide against the plate's 100.8 (**ratio 1.01**, was
2.31); the bow turns at the same place (apex **−40 m** of northing, was −360); local curvature has
the plate's sign everywhere in the city; **0.00 %** of built footprint changes bank between the
plate's channel and the engine's. Water: **0 solids wholly submerged, 0 with their centre in water**,
from 41 and 62. Four solids keep an edge in the wetted band and all four are named and attributed.
Determinism re-recorded: 8,632 / **3,074** / 3,440 — Carthage byte-identical as the control.

**Verdict — the brief was right about the fault and wrong about the layer, and the correction cost
most of the pass.** We were sent to re-digitise a curve. The curve was the smallest of four faults,
and three of the other three were *type* errors rather than data errors: a function of one variable
standing in for a curve in the plane, a cross-section stored in the wrong frame, and a landmark rule
that read the river when it should have read its own survey. **Density was necessary and nowhere near
sufficient**, and the tell was available on day one: the thing being graded and the thing grading it
were the same twelve numbers.

**What we would do differently.**

- **Before digitising anything, check that the existing control points are on the feature.** It cost
  forty lines (`tools/scratch/tiber-knotcheck.mjs`) and it reframed the whole pass. Every survey in
  this repository should get the same treatment: `ROME_CIRCUIT_SURVEY`'s fourteen waypoints carry no
  citation at all, and a separate judge pass has since measured them 165–361 m off the inked wall.
- **Ask what type the survey is stored in before asking whether its numbers are right.** Rule 16.
  Three of this pass's four faults were visible from the type signature alone: `x = f(z)`,
  `RIVER_HALF_WIDTH: number` in an anisotropic frame, and `FAR_BANK(z, offset)` for a thing that has
  its own `e`.
- **Two instruments agreeing is not two instruments.** The grading harness and this pass made the
  identical world-versus-real-metres mistake within hours of each other, because both took the same
  constant at face value. Agreement between instruments that share an assumption measures the
  assumption.
- **When a solver stands between the change and the gate, measure the solver.** `resolveOverlaps`'
  worst displacement went 399 → 690 m when the river moved and 690 → 118 m when far-bank monuments
  were given their own survey back. None of that is fabric work and all of it shows up as fabric
  gates.
- **The one fabrication is named and drawn.** North of world z −300 the plate-true course turns east
  through the Pons Milvius reach, stops being a function of z at z −472, puts 0.76 km of channel
  inside the attacker's deployment box and fords the Via Flaminia unbridged. The map continues north
  on the measured local bearing instead, eased to due north — chosen over the *mean* bearing because
  that one reverses the sign of the curvature at the join, which is the fault this pass was called to
  fix, one level up, and which no residual would have shown.

<!-- Append new entries above this line. -->
