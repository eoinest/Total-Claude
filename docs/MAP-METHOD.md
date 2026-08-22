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
   whoever looks next. **And the sharper reason, measured: Rome's resolver *works*.** It takes 31
   intersecting pairs and 48,343 m² to **zero**, and its own assertion is honest about it. What it
   cannot do is hide the bill — a mean **65.3 m** and worst **167.7 m** of displacement off the
   surveyed position, which is then paid by the street network (26 of 31 monuments standing in a
   carriageway) and by the fabric (six quarters buried, 789 insulae). **A resolver converts one
   layout error you can see into two you cannot.**
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
11. **The footprint the game collides with and the stone the player sees are two objects, and one
   instrument has to compare them.** This is rule 6 applied to the one place both maps break it, and
   it is the fault that survives every fix to the projection. A monument publishes a rectangle to the
   keep-out map and the obstacle set; a geometry builder draws stone; nothing checks the second
   against the first. Measured: **Rome draws stone outside its own published footprint on 23 of 31
   structures, worst overhang 72.2 m per side** (Circus Maximus), and **1,153 sampled monument
   vertices stand inside 23 buildings** — on a city whose footprints are provably disjoint.
   **Carthage has the same defect, 2 of 10 structures, worst 14.85 m.** So both builds can report zero overlaps, correctly, while the picture shows a bath
   house standing in a terrace of houses. Derive the reserved rectangle *from* the geometry builder's
   own extents rather than typing it into a survey table, and gate it.
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
14. **Compress a *position* anisotropically if you must; compress a *building* isotropically or not
   at all.** Rule 4 covers positions against cross-sections and misses the case that bit Rome: a
   building's own plan scaled without its own height. `PLAN_SCALE = 0.65` applied to the plan with
   height left at 1.0 multiplies the height-to-width ratio of **all 31** masonry monuments by
   **1.538** — a 45 m tumulus 87 m across becomes a 45 m tower 57 m across, and a 189 m
   amphitheatre becomes a 123 m one at its full 48.5 m. The eye has no ruler for absolute size and
   an excellent one for shape, so this is the *first* thing wrong with a monument at eye level and
   the last thing a plan view can show. Hold **one** scale per monument, applied to all three axes,
   recorded in the survey row beside the real dimension it departs from. Where isotropy is
   genuinely unaffordable, record the anisotropy as a named exception with the ratio printed —
   never as a global constant that nothing states.
15. **Grade a map from 1.75 m before grading it from 150 m.** Every visual instrument this project
   had photographs the city from a tactical camera 30–150 m up, and at that altitude a monument
   shrunk to fit, a street with a building standing in it and a quarter with no street at all all
   look acceptable. One shot script and one scene probe at a standing man's eye scored the shipped
   Rome **0.8 / 4** on the new `VISUAL-RUBRIC.md` §H, on a map that `probe-fabric`, the plan
   diagnostic, `assertNoFootprintOverlaps` and `assertNoFabricOverlaps` had all passed. **The
   altitude of the camera is part of the instrument and nobody had written it down.**
16. **Count and name every exclusion, and treat a check whose exclusion list is exactly the rows a
   mechanism touches as a measurement of that mechanism's absence.** Rule 13 covers a check that
   *loses* part of its population; this covers one that never had it. Rome's displacement
   assertion prints *"every monument centre at `worldOf(e, n)`: worst 0.0 m"* and skips `farBank`
   and `onRiver` rows — the two rows whose x is overridden by a placement rule rather than by the
   affine map, which is to say **exactly the rows that can be displaced.** The Janiculum Ridge
   stands **404 world metres** from its surveyed position and moved **715 m** between two phases
   under a headline of zero. An exclusion is a claim, so it needs a count, a list of names printed
   every run, and a gate on the count so that a sixth excluded row fails rather than joining a
   category.
17. **When you replace a constant with a table, write down what the constant was silently
   guaranteeing, and gate each guarantee separately.** A per-item authored departure must be graded
   on the **distribution** it produces and not only on each item. Rome replaced one `PLAN_SCALE` of
   0.65 with twenty-seven authored footprints; the cohort's median came out at **0.667** — the same
   number — with a **5.26× spread** around it, and **56 of 345 pairs of monuments had their size
   order reversed against the archaeology, against 0 of 345 before**, because a uniform scale
   preserves order by definition and a per-row scale has no reason to. That invariant was never
   written down, so nothing missed it, and the only instrument that could have caught it was the
   one the change asked to have retired for failing. **The list is short and it is always
   available: enumerate the invariants a scalar makes free.**
18. **When a check is wrong about the world, give it the missing relation — never an exemption.**
   `probe-fabric` G8 demanded 7 m of street between every pair of monuments, which is right about
   free-standing precincts and false about Rome, where the Basilica Ulpia stands *inside* Trajan's
   Forum. The obvious repair — read the build's own `complex` field and skip those pairs — removes
   the same 21 rows from **three** checks at once and leaves the licence enforced only by the
   offline script that granted it. The repair that is a correction rather than a relaxation adds
   the relation the gate lacked and makes it **cost something to invoke**: a declared complex must
   be *joined* (nested or abutting, never a 3 m no-man's-land), and the complex as a whole must be
   **connected** under that relation. **Test for the difference: the new class must be able to
   fail, and declaring it must take on an obligation rather than shed one.** Three of Rome's five
   declared complexes fail the connected test at any threshold under 20 m — the Theatre of Pompey
   stands 17.4 m from its own *porticus post scaenam* — which is exactly the kind of thing an
   exemption would have hidden for ever.
19. **A curve can pass through every one of its control points and still bend the wrong way, and a
   residual against those points cannot tell you.** Rome's Tiber was a cubic Hermite through twelve
   knots and its error was reported as **0.1 world metres**. The report was honest: it compared the
   transcribed table against `worldOf` of *the same twelve latitudes and longitudes*, which measures
   the projection's arithmetic. It cannot see the shape between two knots, and it cannot see whether
   a knot is in the river. Measured against the plate, **one of the twelve stood on water** and the
   median knot was 115 real metres from the channel. **Grade a shape against a source dense enough
   to have a shape**, and grade it with: lateral departure at fixed intervals, the *swing* across a
   named span, and the **sign of curvature** station by station. An inverted bend has a small mean
   error and cannot have the right sign.
20. **Sparse control interpolated into a shape is the same fault one level up, and it caught two
   instruments in one afternoon.** A sixteen-bridge river control graded the engine against the
   *chords* between bridges: over the 842 m band beside the assaulted front there are two bridges in
   the list, so the "plate" being compared to was a straight line across the very bend at issue. It
   reported a 75 m median departure and a 1.435 swing ratio on a channel within 2.4 m of a dense
   trace. And a by-northing comparison of an **east–west** reach is degenerate: one northing has
   several answers, and it inflated a **14.7 m** perpendicular error into **392 m**. Use a sparse
   control as a *point* control — perpendicular distance from each point to the curve — and use a
   dense one for shape.
21. **A representation that cannot express the thing will not be fixed by better data.** Rome's
   channel was `x = f(z)`, a single-valued function of northing. The Tiber turns, so where it ran at
   76° off the z axis the drawn river reached 385 world metres across a row against the 94 it
   declared, and the far side of the Campus Martius was reported as being *in the river*. No amount
   of digitising fixes that: feed a thousand points into `x = f(z)` and it reproduces the fault.
   **Change the representation first** — here, a polyline in the plane plus a signed distance field —
   and then the data means something. The same question is worth asking of every survey the project
   holds: can the type it is stored in say the thing it needs to say?
22. **A constant in world metres is a variable in real metres, whenever the projection is
   anisotropic.** `RIVER_HALF_WIDTH = 47` was a true-scale cross-section, which rule 4 endorses. At
   `KX` 0.443 and `KZ` 0.35 it drew a channel **212 real metres** wide where the Tiber runs
   north–south and **269** where it runs east–west — one number, two widths, against a plate whose
   channel is 100.8 m. Cross-sections in an anisotropic frame need a *rule*, not a constant: author
   in real metres, project, and name the scale. Rule 4's override is still available and is now one
   named number (`RIVER_WIDTH_SCALE`) rather than a figure nobody could convert.
23. **When a solver stands between your change and the output, your change is not what the gate
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

- **And the confirmed fault is not what is on the screen, which took a second instrument to
  establish.** Everything above is measured at the *projected* positions, before
  `resolveOverlaps` runs. `tools/probe-fabric.mjs` measures the same city **after** it, with
  independent arithmetic, and finds **0 intersecting monument pairs and 0 buildings inside a
  monument**. The resolver discharges the whole 31 pairs / 48,343 m² / 64.69 m — at a cost of
  **mean 65.3 m and worst 167.7 m** of displacement off the surveyed position. So both statements
  are true and only together are they useful: **the arithmetic forces overlaps, the resolver removes
  them, and what the player sees is what removing them costs** — 60,932 m² of monument standing in a
  carriageway, six buried quarters, and hash-derived grain. Read §3's gate entry before concluding
  the shipped city interpenetrates; it does not.

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

### 21 Aug 2026 — the fabric got a gate: `tools/probe-fabric.mjs`, and it runs on both maps

**What we did.** Turned the fabric's acceptance measurement into a **gate** rather than a report:
twenty-one checks over any candidate city, each with its threshold as a named constant and the
reasoning in a comment beside it, `PASS`/`FAIL` per check, an `n/21` verdict and a non-zero exit. Run
on Rome and on Carthage. It covers **both** faults `ROME-FABRIC.md` §2 establishes — G1–G3 and
G12–G16 for the monument arithmetic, **G18–G21 for the quilt** — because a gate that measured only
intersection would pass a quilt, and Rome proves that below.

Four rulers, all outside the thing being checked (rule 6): published dimensions typed into the tool
with a citation per figure, never read from `survey.ts`; the vertices that will actually be
rasterised, read off the baked `BufferGeometry` in the live scene; the probe's own polygon-clip and
SAT arithmetic, so it never calls `obbOverlap` or `assertNoFabricOverlaps`; and, for fidelity,
**aspect ratio**, which is invariant under uniform plan compression and so needs to know nothing
about the projection — with the absolute-scale test taking its reference from the **median of the
cohort's own ratios**, so it needs no repo constant either.

**What we expected.** Rome filthy and Carthage clean; the visible fault to be monuments intersecting
each other and intersecting houses; the quilt checks to be the hard ones to write.

**What happened. Rome 6/21, Carthage 12/21 — and the expected fault does not exist.**

- **Rome has zero intersecting monument footprints and zero buildings inside a monument, measured
  *after* the resolver.** `ROME-FABRIC.md` §2.2 measured the *projected* positions; this measures
  the same city after `resolveOverlaps` has run, with independent arithmetic, and finds **0 pairs
  and 0 m²** — the build's own assertion agrees. The two passes are consistent, and together they
  say what neither says alone: **the arithmetic fault is real, the resolver discharges it
  completely, and the thing the owner is looking at is therefore not residual intersection.**
  Re-measured here at the ideal positions: **31 pairs, 48,343 m², worst penetration 64.69 m → 0, 0,
  0**, at a cost of **mean 65.3 m, median 68.7 m, worst 167.7 m** of displacement off the surveyed
  position. That displacement is the bill, and the streets and the fabric pay it.
- **The streets pay first.** **60,932 m²** of monument footprint stands in a carriageway, over
  **121 street segments and 26 of the 31 monuments**, and **29,868 of 129,228 sampled drawn
  carriageway vertices — 23.1 % — are drawn underneath a monument.** Carthage on the same
  instrument: 3,918 m², 7 monuments, **0.56 %**. A 41× difference on the same measure.
- **The fabric pays second.** Six quarters print *"the quarter is buried"* at every boot —
  `velabrum` at **0 buildings from 260 candidate frontages** — and the whole walled city carries
  **789 insulae** against Carthage's 685 on a smaller circuit. Clearance across all 820 Roman
  structures: median **0.68 m**, p25 0.16 m, **543 of 820 inside the XII Tables' 1.48 m *ambitus***,
  7 negative, worst −3.54 m. Carthage's 727 structures: median **4.00 m**, **zero negative, zero
  under a metre**, worst +3.36 m.
- **A fifth fault, not in `ROME-FABRIC.md`, shared with Carthage, and probably the one the owner can
  actually see: the collision footprint and the drawn stone are two different objects and nothing
  compares them.** Rome draws stone outside its own published footprint on **23 of 31 structures,
  worst overhang 72.2 m per side** (Circus Maximus), and **1,153 sampled monument vertices stand
  inside 23 buildings** — on a city whose footprints are provably disjoint. Carthage: 2 of 10, worst
  14.85 m. That is now rule 11, and it is the fault that survives every change to the projection.
- **The grain check §2's prediction said would be dropped now exists, and it separates the two
  cities with an empty gap.** This is the result worth more than the rest of the entry, because the
  prediction was explicit: *"the only check in the plan that can fail on a quilt and pass on a city,
  and the one most likely to be dropped as nice-to-have. If the rebuild goes wrong again, that is
  where."*

  | grain measure | Rome | Carthage | a hash would give |
  |---|---:|---:|---:|
  | block orientation vs the nearest street, median | **9.17°** | **0.00°** | 22.5° |
  | same, p90 / max | 25.1° / 44.1° | 0.00° / 42.3° | — |
  | blocks more than 5° off their own street | **556 of 788** | **29 of 685** | — |
  | neighbouring blocks within 40 m, median difference | 4.27° | **0.00°** | 22.5° |
  | neighbour pairs rotating > 15° across a 40 m gap | **335 of 1,966 (17.0 %)** | **0 of 1,125** | — |

  Carthage's blocks are *exactly* parallel to their streets and to each other. Rome's are drawn from
  a distribution. **Neither city needed a screenshot for this.**
- **And the regions do not partition.** Rome's **17 districts** claim **1.33×** the 2,105,600 m² of
  land inside the circuit that is not already a monument's, over **75 overlapping pairs**, with
  **1,602,624 m² claimed more than once** — while **only 0.569× of that ground is covered at all.**
  Simultaneously over-claiming and under-covering: 43 % of the land inside the walls is in no
  district, and 1.6 km² is in two or more. (Their declared rectangles total **1.831×** the same
  denominator; `ROME-FABRIC.md` §2.3's 266 % is the same fault over a smaller denominator — that
  pass measured against 1.45 km² of walled ground and this one against 2.11 km² of non-monument land
  out to the heightfield edge. The numbers agree about the city and differ about the frame; use
  whichever, and say which.) Carthage: **16 quarters, 0.824× claimed, 21 overlapping pairs,
  174,080 m² double-claimed, 0.722× covered.** The same fault, an order of magnitude milder, and
  failing on the *under*-covering side.
- **Carthage is better exactly where rule 1 predicts and is NOT a clean city.** It wins on every
  fabric measure — 0 building-versus-building overlaps against Rome's 4, 0 monument stone in a
  building against Rome's 1,153 vertices, monument-to-fabric clearance 7.68 m against 1.02 m, no
  buried quarters, and both grain checks — and it still fails monument-in-a-carriageway,
  region partition, monument-to-monument clearance (**4.07 m** between the two harbours, under the
  7 m the rule asks for) and stone-outside-its-own-footprint. **Copy the method; do not assume the
  result it produced is passing.**

**The footprint-fidelity table, which is the artefact that outlives the probe.** The published
figures and their citations live in `PUBLISHED` at the top of `tools/probe-fabric.mjs`; rows that
could not be sourced are marked `unsourced` there and are never gated on. Measured plan compression
across the sourced cohort is **0.650** — so the projection arithmetic is uniform and honest, and
every exception below is a *modelling* error rather than a projection error.

| monument | published | modelled | modelled ÷ published | published aspect | modelled aspect | verdict |
|---|---|---|---:|---:|---:|---|
| Colosseum | 188 × 156 | 122.9 × 101.4 | 0.653 | 1.205 | 1.212 | ok |
| **Circus Maximus** | **621 × 118** | 403.7 × 123.5 | 0.650 | **5.263** | **3.268** | **wrong shape — built to its outer envelope, not its track** |
| **Baths of Caracalla** | **218 × 112** | 141.7 × 91.0 | 0.650 | **1.946** | **1.557** | **wrong shape — `survey.ts` says "218 × 112, the block is what is modelled" and models 218 × 140** |
| Pantheon | 84 × 58 *(derived)* | 54.6 × 37.7 | 0.650 | 1.448 | 1.448 | ok in plan; the *drawn* rotunda is 48.3 × 47.7, i.e. square |
| Castra Praetoria | 440 × 380 | 260.0 × 245.1 | 0.591 | 1.158 | 1.061 | small, and **documented** — at true size it is a tenth of the buildable city |
| Theatre of Marcellus | 129.8 × 115 | 84.5 × 74.8 | 0.651 | 1.129 | 1.130 | ok |
| Stadium of Domitian | 275 × 106 | 178.8 × 68.9 | 0.650 | 2.594 | 2.594 | ok |
| Mausoleum of Augustus | 87 × 87 | 56.6 × 56.6 | 0.650 | 1.000 | 1.000 | ok |
| Ara Pacis | 11.625 × 10.55 | 7.54 × 6.89 | 0.649 | 1.102 | 1.094 | ok |
| Porticus Octaviae | 132 × 119 | 85.8 × 77.4 | 0.650 | 1.109 | 1.109 | ok |
| Temple of Jupiter OM | 62.25 × 53.5 | 41.0 × 34.5 | 0.658 | 1.164 | 1.189 | ok |
| **Iseum Campense** | **200 × 50** | 45.5 × 22.1 | **0.228** | **4.000** | **2.059** | **wrong size AND shape — 2.85× too small, which is the measurement of `ROME.md` §6.3's "too small by a factor of three"** |
| Baths of Diocletian | 376 × 361 | *absent* | — | — | — | **correctly absent** — begun AD 298, 27 years after this map |

**Verdict — the two passes together are worth more than either, and the order mattered.** The
research pass proved the arithmetic *must* produce overlaps; this pass proves the shipped city *has
none*, and that every visible fault is downstream: displacement into the streets, starved quarters,
hash-derived grain, regions that do not tile, and stone drawn outside its own footprint. Had only
one of the two been done, the rebuild would have begun by changing `KX`/`KZ` and would have shipped
the same city with a different projection.

**What we would do differently.**

- **Write the gate before the thing it grades.** Every number above is one boot and ~1,400 lines.
- **Prefer the geometry read.** Five of the twenty-one checks found faults no plan-side test could
  ever find (G5, G7, G14–G16), and all five came from reading vertices. Three workstreams in a row
  now: the winding probe, `probe-solid`, and this.
- **A median cannot see a quilt, and this file nearly shipped a gate that proved it.** G21's first
  version gated on the median neighbour-orientation difference. Rome's is **4.27°** and it *passed*,
  because most neighbours sit inside one district and share its lattice — the quilt lives at the
  *boundaries*, where **17 % of pairs rotate more than 15° across a 40 m gap** against Carthage's
  **0 %**. A distribution's tail is the signal; its middle is the thing the fault hides behind.
  Same lesson as the HUD's median frame time, found again in a different file.
- **Instrument bugs are product bugs. This one had four.** (i) Nearest-*centre* attribution handed
  635 of the Theatre of Pompey's vertices to Tiber Island, whose centre was nearer than the
  theatre's own — fixed by normalising distance by each claimant's own reach. (ii) A composite
  decomposed into boxes reported its own joints as overlaps: the Cothon's 28-box quay ring produced
  **28 "monument overlaps" of 9.93 m² at 2.09 m each, identical to the centimetre**, and taking one
  of those 28 boxes as "the Cothon" reported the 325 m harbour at **0.098** of its published size —
  fixed by aggregating a composite before measuring it, and by discriminating a joint from a
  collision by depth, the two populations being three orders of magnitude apart. (iii) The partition
  denominator counted monument ground as a region's responsibility until it was subtracted.
  (iv) The median-versus-tail error above. **Grade the gate as a product.**
- **A bare `chromium.launch()` on this box rasterises in software, and it costs everything.** The
  GPU process came up `--use-angle=swiftshader-webgl`; boots took four to six minutes and every
  screenshot timed out, at 30 s and again at 180 s, on both maps — which reads as a hung page and is
  a missing flag. With `--use-angle=metal` (which `tools/shoot.mjs:1548` has carried since the shot
  harness was written) the same frames advance in **35–255 ms and capture in 149–247 ms**. Before
  believing any timing taken through Playwright here, check
  `ps -A -o command | grep 'type=gpu-process'`.
- **`page.screenshot` still cannot photograph this project even on Metal.** Playwright waits for the
  page to reach a stable state and a page driving a rAF loop over a 3.1 M-triangle scene never
  does. CDP `Page.captureScreenshot` returns in milliseconds.
- **Attribute a server by its `cwd` before killing it.** Chasing an orphaned vite on 5951 I killed a
  two-minute-old process on that port without checking whose it was; a later process on the same
  port turned out to belong to another agent's worktree. `lsof -a -p <pid> -d cwd` is one command.
  The other half of the same rule earned itself the first time it fired: **never reuse a server this
  process did not start.** A run that had reused the foreign 5951 would have graded another branch's
  modules, and it failed instead with `Failed to fetch dynamically imported module`, which reads as
  a code fault and is not one.
- **One check in `ROME-FABRIC.md` §4.4 could not be written, and it is not the one anybody would
  guess.** See the next entry.

### 21 Aug 2026 — a blind spot on the record: the plates are not a machine ruler

**What we did.** Tried to make the georeferenced plates the independent ruler for footprint
fidelity, as rule 6 asks and as `ROME-FABRIC.md` §4.4 check 3 specifies, rather than published
dimensions typed into a tool.

**What happened. Two facts, both worth writing down.**

- **A git worktree cannot see `reference/`.** It is gitignored local-only material, so it exists in
  the main checkout and in no worktree — `git worktree add` does not copy untracked files. An agent
  working in a worktree will look, find nothing, and conclude the plates do not exist. They do. This
  probe's first draft said so in its own header comment. Copy or symlink the directory in.
- **The only machine-readable plate carries no names.**
  `sitar-forma-urbis-severiana-vector-EPSG4326.geo.json` is 8,150 features whose entire property set
  is `{admapkey, layer, path}` — fragments and interior wall lines, with no monument identification
  at all. A probe cannot read "the Circus Maximus is 621 × 118" off it, and the Lanciani and AGEA
  rasters would each need digitising per monument. (`ROME.md` §6.4 records a related negative: the
  same file cannot recover the *pes monetalis* either, because the digitiser's own metre grid
  dominates the signal.)

**Verdict — a real limitation, stated rather than papered over.** `probe-fabric` can prove a
footprint is the wrong **size** and cannot prove it is in the wrong **place**, so
`ROME-FABRIC.md` §4.4's check 3 is **not implemented and cannot be as written.** Until somebody
digitises an outline per monument, the plates stay a *visual* comparator through
`src/city/overlay.ts`, and the position check is a human looking at one image.

**What we would do differently:** budget the digitising. Twenty monuments' corner coordinates read
off the georeferenced Lanciani raster, in a table shaped like `PUBLISHED`, turns the whole position
question into a gate — and the rebuild is placing every monument from those plates anyway, so
somebody will read those coordinates regardless. Write them into a file instead of into a commit
message.
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

### 21 Aug 2026 — Rome fabric phase 2: the resolver is gone, and the survey was the bigger fault

**What we did.** Deleted `resolveOverlaps`, abolished the global `PLAN_SCALE`, replaced it with a
per-monument authored footprint beside the real published dimension, declared five complexes and
seven authored abutments, and froze every monument at `worldOf(e, n)`. `docs/ROME-FABRIC.md` §8.

**What happened, in the order it mattered.**

- **Displacement went from a mean of 142 world metres to zero, by construction**, and the
  eighteen inverted spatial relations the plan judge found went to **zero of 858**. The second
  number is the interesting one and it is a *proof* rather than a measurement: `worldOf` is
  strictly monotone in both axes, so with nothing moving after it, no relation can invert. All
  eighteen were the solver's.
- **The biggest single lever was not in the plan.** `ROME-FABRIC.md` §4.5 framed the problem as
  geometry — too much footprint in too little ground — and prescribed merging and shrinking.
  Both help. But **fourteen of thirty-five survey rows were in the wrong place**, five of them by
  more than 100 m, and no amount of merging or shrinking fixes a wrong coordinate. Two of the
  three "unabsorbable east–west pairs" §7.8 escalated to the owner as a taste decision turned out
  to be **measurement faults in the survey**, and they evaporated when the coordinates were
  corrected. *The rule this earns:* before optimising a layout, check that the layout's inputs are
  right. A solver's residual is only evidence about the solver if its inputs are.
- **A survey row has four independent things that can be wrong, and the fourth has no
  instrument.** The coordinate, the dimension, the bearing — and **which part of the building the
  coordinate refers to.** The Porticus Octaviae was cited at its *propylon*, which is the
  precinct's south edge, so a 132 × 119 m quadriportico centred on its own front door sat half
  inside the Theatre of Marcellus. The Theatre of Pompey was cited at its *cavea* and dimensioned
  as the *whole complex*. Both rows are internally consistent, both cite a real place, and both
  put a building 120 m from where it stands. Only a plate finds that.
- **`draw` was compressing two axes out of three, and nobody noticed for three passes.** The old
  `PLAN_SCALE` scaled plan and left height at 1:1, and the code said so as though it were a
  feature. A ground-level judge measured the result: Rome's monuments read **1.54× too tall for
  their width**. *The rule:* when a scale factor is applied to a subset of a thing's dimensions,
  say which subset in the constant's own name, and state the ratio it produces.

**What we would do differently.**

- **Digitise the plate before authoring against it, not after.** Nine of the fourteen corrections
  came from reading the georeferenced raster directly and five came from a control table another
  agent digitised mid-pass. The control table was worth more than everything this phase built for
  the purpose, and §3's own previous entry had already asked for it — *"budget the digitising"* —
  and it was not budgeted. It cost a pass.
- **Check an instrument against a hand-computed case before trusting it, especially when it
  agrees with you.** This phase's own `--realgaps` had a sign error in the bearing convention that
  mirrored every box in `n`. It is invisible on an axis-aligned building and inverts every rotated
  one, and it reproduced a figure the design document had computed independently — 49 real metres
  of Octavia–Marcellus overlap — closely enough to look like corroboration. It was wrong, and so
  was the document. Separately, the judge's own control table disclosed that nine of its sixteen
  rows restated `survey.ts` rather than reading the plate. **Two instruments built to enforce rule
  6 both broke rule 6 in the same day.** An instrument that agrees with the document it is
  checking is not thereby correct; it may only be inbred.
- **A plate is not one ruler, it is a ruler per zoom level.** The judge's contact sheet at
  1.0 m/px reported the Theatre of Marcellus at zero error; at 0.46 m/px the same reader measured
  39 m. This phase made the same mistake in the other direction, reading a 20 m Pantheon offset at
  zoom 4 that vanished at zoom 5. **Record the reading scale beside every plate-derived number**,
  and treat a reading taken at a coarser scale than the error being claimed as no reading at all.

**One thing that was kept against the plan, and the reason generalises.** §5 listed `TOPOLOGY` for
deletion with the resolver, because the solver used it as a constraint set. But it is also an
independently written statement of Rome's adjacency, and with positions frozen it becomes exactly
what rule 6 asks for: a check on the survey whose reference is outside the survey. It is the only
thing in the tree that would have caught this pass mistyping one of fourteen corrected
coordinates. **Deleting a check because a solver used to borrow it is the wrong reason to delete a
check.**

---

### 21 Aug 2026 — the city judged from a standing man's eye, on both maps

**What we did.** An independent judge, changing no source. Two shot scripts (42 eye-level cameras,
every Rome shot with a Carthage twin on identical rail numbers), one scene probe
(`tools/scratch/judge-fabric.mjs`, which reads `CitySystem.getObstacles()` and raycasts the built
scene graph and imports nothing from `src/city/**`), and a new `VISUAL-RUBRIC.md` §H of ten
criteria that only score on frames taken at 1.75 m with a near-level lens. Measured `58bc584`
(`main`) and `bc2e0f2` (the builders' base) and Carthage as the control. `docs/CITY-GROUND-JUDGE.md`.

**What we expected.** From the brief: that the monuments would read *small* next to a man, and
that the pass would end up arguing for a higher footprint floor.

**What happened.** Three things, and the first two were not on anyone's list.

1. **The monuments do not read small. They read 1.54× too tall for their width.** `place()` scales
   every masonry footprint by `PLAN_SCALE = 0.65` and `layout.ts:139` says in as many words that
   heights are not scaled; the plan diagnostic confirms 0.695 (0.65 × `PRECINCT`) for all 31 rows to
   three decimals. So the pass ended up arguing the *opposite* of what it was sent to argue: not
   "raise the floor" but "**use one scale for all three axes**". Rule 13.
2. **Carthage is better urbanism and worse architecture, and the rebuild must not copy it
   wholesale.** From the parapet, Rome is three painted blocks in a field and Carthage is an
   unbroken mat running to a citadel — but at eight metres Carthage's blocks are untextured prisms
   with no aperture of any kind, and Rome's have stucco, tile, windows, balconies and modelled
   *tabernae*. **Take Carthage's grain, continuity, module and terminus; keep Rome's buildings.**
3. **The two worst faults from the ground are both road faults, and both were already measured
   from above without anyone noticing what they meant at eye level.** 29.0 % of ranked way inside a
   monument means that a man walking in on the Porta Flaminia's own axis is **inside masonry for
   34 % of the first 700 m** — the Mausoleum of Augustus at 95, the Baths of Nero at 220, and 105
   unbroken metres of the Theatre of Pompey at 360. And a median `H/W` of **0.19** against an
   ancient street's 1.0–3.0 means Rome does not have streets at all; the narrowest long corridor in
   the whole walled city is 5 m wide, floored with turf, and stops after fifteen metres.

**Phase 1 re-graded from the ground.** Ranked way in a monument 29.0 % → **10.3 %**, axis blocked
34 % → **18 %**, p90 distance to the nearest built thing 48 m → **25 m**, buildings 789 → 1,150.
Real and visible, and `pair-kz-before-after.jpg` shows it without a table. But the axis still
carries 105 unbroken metres of monument, ranked way in a monument is still five times its own
Phase 3 acceptance, and median `H/W` **fell** from 0.19 to 0.14 — more buildings in the same space
narrowed the gaps without giving anything a taller frontage. **Enclosure is not a by-product of
density. It is a by-product of blocks that address a line.**

**Verdict — the altitude of the camera was the whole gap.** Nothing here needed a new idea; it
needed a camera 148 metres lower. Five instruments passed this city and a person did not, and the
difference was not rigour.

**What we would do differently.**

- **Write the camera height into the instrument.** `VISUAL-RUBRIC.md` A–G can all be scored from a
  tactical camera and every graded frame this project has is one. §H now says explicitly what
  height it scores at and refuses frames above it. An instrument that does not state where it
  stands is not reproducible.
- **Pair every finding with a control shot on the map that works.** Six of the ten findings only
  became arguable when the same camera was pointed at Carthage; two of them *reversed* when it was.
  Rome's `H/W` on the gate axis is 0.19 and Carthage's is 0.06 — Carthage is worse on that axis and
  better everywhere else, and a pass without the control would have published the wrong cause.
- **Aim eye-level cameras off a measured walk, not off round numbers.** Pass one parked the eye at
  20, 120, 250 and 400 m inside each gate and four of twelve interior frames came back inside
  masonry, partly because `stand` positions the *focus* and the eye sits `dist` further out. The
  fix was to walk the axis with the probe first and shoot only clear stations. **Half an hour of
  measurement bought back an hour of re-shooting, and the frames it threw away turned out to be
  the headline finding.**


---

### Phase 2 graded from the ground — the landmark rework, and three ways a good change hid its own cost

**What we expected.** The first ground pass (above) had argued for one thing: make the monument
scale isotropic. The branch did it — `RomeMonument.drawY` defaults to `draw` — so the expectation
going in was a re-score, a confirmation, and a short entry. The prediction was that the H8
criterion would move two ranks and nothing else would change much.

**What happened.** H8 moved one rank, three other criteria moved, and **two of the four things
this pass found were introduced by the change that was right.** Rome went 0.8 → 1.5 on
`VISUAL-RUBRIC.md` §H. The isotropy argument is upheld and turned out to rest on a different
foundation than either the plan or the first pass gave it. And the branch's own headline number
had a blind spot big enough to hide a 404-metre error.

**Four things worth the log.**

1. **The strongest argument for a change was found by re-using the previous pass's camera, not by
   arguing.** `docs/CITY-GROUND-JUDGE.md` §10.3 is one frame at pass one's exact rail — 90 m out,
   eye 1.75, `fov` 50 — and the finding is that at 48 m the Colosseum **does not fit in the
   frame**: no attic, no ends, no silhouette, unidentifiable. At 27 m it fits and it is
   unmistakable. Nobody had said that, because nobody had a *pair* of frames at one rail. The plan
   argued from the published ratio; the first ground pass argued that the eye reads proportion
   before size; **the thing that actually decides it is that recognition needs a silhouette and a
   silhouette needs the object to fit in the lens at a standoff a man can take.** That is now
   `VISUAL-RUBRIC.md` H8(c), and it cost one re-used camera and no new idea. **Re-use the rail.
   Move the focus, never the lens.**

2. **The pass's own headline number was wrong for two hours, and only a second method found it.**
   §10.4.1's first draft measured the median monument's proportion error at 2.37 → 2.22 — a 6 %
   gain against a claimed 35 % — reported nine rows getting *worse*, and built a mechanism on
   them: §8.5b (isotropy) and §8.5c (fit the stone to the box) pulling opposite ways. It was
   plausible, it was specific, and it was an artefact. The inherited instrument takes a monument's
   height as the maximum of an 11 × 11 grid of rays dropped from 260 m; over a 30 m box in a
   declared complex the grid hits whatever leans over it. A second method — the largest `y` among
   the monument's *own* vertices, no rays — gives **2.41 → 1.42, a 41 % gain, 22 of 25 rows
   improving**, agrees with the first to 3 % on the nine largest monuments and disagrees with it by
   up to **3.3×** on the small ones. **Pass one already knew this**: it recorded three answers for
   the Colosseum's height and refused to publish an absolute. What it did not do was extend the
   refusal to a *ratio*, which is where the same contamination hides. **Two methods, or no number.
   And prefer the method with fewer ways to be fooled: a vertex belongs to a building, a ray
   belongs to whatever it hits.**
3. **A change that is right can carry its cost in a relation nobody counted.** The branch's
   headline is *"0 of 860 spatial relations inverted"* — north-of, west-of, between — against 18 of
   184 on the shipped map. Real, and a proof rather than a measurement. Ask the same question about
   **size** and the answer is **56 of 345 pairs inverted, 16.2 %, against 0 of 345 under the global
   scale it replaced**, and a steady 10 % among pairs close enough to share a frame. The Castra
   Praetoria is drawn smaller than the Mausoleum of Augustus it is 4.6 times the length of. **A
   uniform constant is not just a compromise; it is silently guaranteeing invariants, and the
   moment you replace it with a per-item table you have to list what it was guaranteeing and gate
   each one.** Nobody did, and the instrument that would have caught it — `probe-fabric` G13 — was
   the check the branch asked to have retired. Proposed as rule 17.

4. **A check that was born blind to a mechanism is worse than a check that goes dark, because
   nothing marks the moment it stopped looking.** `assertRomeFrame` check 5 reports *"every
   monument centre at `worldOf(e, n)`: worst **0.0 m**"* and skips `farBank` and `onRiver` rows by
   construction. The Janiculum Ridge is `farBank`: a 520 × 240 m planted ridge with a 40 m mound,
   which `place()` puts at world **(−12.6, 1374)** while its own survey row projects to
   **(−416.2, 1381.6)**. It stands **404 world metres** from its surveyed position, clamped onto the
   last row of the heightfield in the middle of the map's southern edge, and it moved **715 m**
   between phase 1 and phase 2 — on the pass whose result is *"displacement is 0.0 m by
   construction"*. It is very probably also why about fifty umbrella pines are hanging in the air
   over the Campus Martius (`lm2-floating-grove.jpg`). Rule 13 covers a check that *loses* part of
   its population. This one never had it. Proposed as rule 16.

**Two more from the same afternoon, smaller and both about instruments.**

- **We reproduced the exact sign error the branch had already confessed to, in the same
  quantity.** `ROME-FABRIC.md` §8.8 records that its `--realgaps` built each oriented box with the
  bearing mirrored, which is invisible on an axis-aligned building and inverts every rotated one.
  This pass's own `judge-monuments.mjs` did the same thing and reported the Basilica Ulpia and
  Trajan's Column interpenetrating by **13.6 m** where the city's own assertion said 1.0 m. The
  recomputation using `probe-fabric`'s own `obPoly` then agreed with the city to **0.05 m**. A
  written-down failure mode is worth reading twice: **the second reader of a confession is the
  person most likely to repeat it, because they now think they understand it.**
- **Half the eye-level cameras aimed at a monument that has moved will end up inside masonry.**
  Three of twenty-five did here, one of them ninety metres from its subject. Pass one recorded the
  same thing and its own fix — walk the axis with the probe first, shoot only clear stations — was
  not applied to *monument* cameras because those are aimed at a coordinate rather than along a
  walk. **A camera aimed at a monument needs the same clearance test as one aimed down a street**,
  and it is one `solidAt(x, z)` call per rail before the browser starts.

**Verdict on the method, not the map.** The instrument that produced everything above already
existed: it is the first pass's own shot script and scene probe, run again on a different tree at
the same rail numbers. **The cost of a second opinion on this project is now about ninety minutes,
and it caught four things in a branch that had already been graded once by a plan judge, once by a
ground judge, and once by a twenty-one-check external gate.** That is the argument for the seat,
and it is an argument for making the *rails* a committed artefact rather than the frames.

---

### 21 Aug 2026 — the gate corrected against its own adjudication: 5/21 to 7/25, and every added check red

**What we did.** Implemented `docs/CITY-GROUND-JUDGE.md` §11 in `tools/probe-fabric.mjs` and
nothing else. No source under `src/` changed; the three pinned determinism hashes are unchanged at
8,632 / 3,074 / 3,440 soldiers, `tsc` is clean, `lint` is 2/2 and `qa-deploy` is 33/33. The work
was split off the build deliberately — a phase that edits its own gate cannot report a before and
an after — and the split is why there is a before column at all.

Six changes. G8 keeps its 7 m of street and loses the population its own comment was wrong
about. **G8c** and **G8d** are the price of that: a pair inside one declared `complex` must be
*joined*, and the complex as a whole must be *one connected piece*. **G13** is retired; **G13a**
(an absolute band against typed-in published dimensions) and **G13b** (no inverted size order)
replace it. **G11** gains an off-frame category gated on the five agreed names. **G22** is the
water check, shipped with the exclusion accounting the judge made a condition of endorsing it.

**What we expected.** The judge's table: 5/21 → 7/25, sixteen failing checks becoming eighteen,
every added check failing today.

**What happened.** Measured, both maps, and the control column is as informative as the subject's:

| | Rome before | Rome after | Carthage before | Carthage after |
|---|---|---|---|---|
| verdict | 5/21 | **7/25** | 12/21 | **13/22** (3 n/a) |
| failing | 16 | **18** | 9 | 9 |
| G8 street | FAIL 0.66 m | **PASS** — 0 of 310 cross-complex pairs short, closest legal 13.66 m | FAIL 4.07 m | FAIL 4.07 m, unchanged |
| G8c joined | — | **FAIL** — 3 of 41 in-complex pairs in the (2.5, 7) m no-man's-land | — | n/a, no complexes declared |
| G8d one piece | — | **FAIL** — 4 of 5 complexes are not one piece | — | n/a |
| G13a band | — | **FAIL** — 2 of 10 gated rows below the 0.45 floor | — | **PASS** — 0 of 2 |
| G13b order | — | **FAIL** — 10 of 43 asserting pairs inverted, 23 % | — | n/a, 0 asserting pairs |
| G15 trespass | FAIL 11 pairs | **FAIL 2 pairs** | FAIL 2 pairs | FAIL 2 pairs |
| G22 water | — | **FAIL** — 78 solids under a 5.0 m surface | — | **FAIL** — 1 solid under sea level |
| G11 present | FAIL | **PASS** | PASS | PASS |

**The headline number is exactly the prediction and its composition is not.** The judge's table
has G15 passing and does not score G11; the measurement has G11 passing and G15 failing. Two
pairs are declared one `complex` and stand 3.14 m and 3.17 m apart — inside G8c's own
no-man's-land — so the complex licenses nothing and G15's second condition refuses them. **The
predicted PASS does not survive the judge's own conjunction**, which is the more interesting
outcome: the three conditions were written down correctly and then scored as if the first one
implied the other two.

**Five things worth the log.**

- **The exemption hazard is now demonstrable in one run rather than arguable in prose.**
  `--inject=complex-invent` on Carthage declares the two closest monuments to be one complex.
  G8c and G8d go red, **and G8 goes green on the same run** — 1 of 45 pairs short becomes 0 of
  44. That is precisely what "treat a complex as one owner" would have done to all twenty-one
  rows, and it took four lines of injection to turn rule 18's argument into a table. **An
  argument about a check is worth much less than a run of the check with the fault in it.**
- **A third outcome was unavoidable, and the denominators now differ between maps.** G8c, G8d
  and G13b have no population on Carthage: it declares no complexes, and its two published
  monuments are 325 m and 320 m, which is 1.6 % apart and inside every citation's own error bar,
  so the pair asserts no size order at all. Counting those green would have put three checks that
  cannot fail into a passing score — the exact thing this project has shipped several times. They
  report `n/a` with the reason and the sample size and come out of that map's denominator, so
  Carthage is 13/**22** and Rome is 7/**25**. **A map is asked fewer questions because it makes
  fewer claims, and that is not a defect in the gate.** The candidate rule, offered to §1 rather
  than written into it: *a check whose population is empty must say so and leave the denominator;
  a vacuous pass is worse than a missing check because it is indistinguishable from a real one.*
- **The water check would have been wrong on the control map without its exclusion list, and
  that was measurable rather than hypothetical.** `--inject=water-no-exclusions` fails Carthage
  on **34** monument solids, of which **33 are the Cothon and the merchant basin** — 325 m and
  320 × 150 m *of water*, per Hurst 1994 and `CARTHAGE.md` §6.2. Rule 16 predicted this shape
  exactly ("a check born blind to a mechanism measures its absence") and the condition the judge
  attached to endorsing G22 was load-bearing, not procedural. With the list in place the check
  finds **one** thing on Carthage and it is real: **The Temple by the Sea, a 44 × 64 m
  `solid: true` monument standing entirely offshore with its centre 9.2 m below sea level**, three
  of four corners wet, photographed. Nothing in the tree had ever named it. On Rome it finds the
  Theatre of Marcellus at 1.52 m under a 5.0 m surface — the judge's own figure, to the
  centimetre, from an independent computation — and **77 insula solids standing in the Tiber**.
- **The external ruler is smaller than the internal one, and the size of that gap is the
  finding.** The judge measured 56 of 345 inverted size relations and 13 of 27 rows below a 0.45
  floor, both against the survey's own `len`. That is the right measurement for a judge and the
  wrong reference for a gate: `len` is an input to the build, and rule 6 forbids it. Against
  `PUBLISHED` — typed into the probe, one citation per figure — the population is **10 sourced
  rows and 43 asserting pairs**, and it fails at 10 of 43 (23 %) and 2 of 10. The direction, the
  magnitude and the worst offender all agree with the judge (the Castra Praetoria drawn 0.84x a
  Mausoleum of Augustus it is 5.06x the length of), so the small population is not hiding the
  fault. **What it cannot do is see the other seventeen monuments**, because `PUBLISHED` has no
  row for the Ludus Magnus, Trajan's Markets, the Baths of Titus or the Temple of Venus and
  Rome. Widening it is a literature task with a citation per figure, not a code task, and
  inventing the citations would be worse than the gap. The count over the wider *sourced*
  population is printed every run and not gated: 31 of 100.
- **One arithmetic correction to the adjudication, which changes nothing it concludes.** §11.1
  reports *"pairs inside one declared complex: 27"* and *"of the 27, fourteen stand 7 m or more
  apart, up to 59 m"*. Five complexes of 7, 5, 4, 3 and 2 rows have `21 + 10 + 6 + 3 + 1` = **41**
  pairs, which is forced, and **28** of them stand 7 m or more apart, **up to 165.13 m**
  (`temple-jupiter` / `trajan-market`, both filed `forum-valley`). The judge's enumeration was
  evidently bounded by a proximity query — its own maximum, 58.95 m, is the largest pair a
  neighbour search would return — so the two numbers are not comparable and the smaller one
  understates the case it is making. Every named pair and every conclusion in §11.1 survives.

- **Two of Rome's five complexes fail for opposite reasons and one number hides it.** At the
  2.5 m joint bound four of five are not one piece; at any threshold under 20 m, three are. The
  difference is `campus-medius`, which becomes one piece at **3.17 m** — the Stadium of Domitian
  is 67 cm outside the party-wall bound and 3.8 m inside the street bound, which is neither
  thing. `pompey` needs **17.36 m** (the judge measured 17.4 for the Theatre of Pompey against
  its own *porticus post scaenam*, from a different computation), `forum-valley` needs 23.72 m
  and `colosseum-valley` 27.58 m. So `connectAtM` — the longest edge in the complex's minimum
  spanning tree — is printed beside every complex, because "not one piece" is a verdict and "not
  one piece until 27.58 m" is an instruction.

**Two smaller ones, both about the instrument rather than the city.**

- **`Number('8c')` is `NaN`.** The check table sorted on `Number(id.slice(1))`, so the moment
  checks were named G8c, G8d, G13a and G13b the printed table would have come out in push order
  and read as scrambled. Found by reading the sort line before the first run, which is luck rather
  than method — no test in the tree looks at the order of a gate's own table. **A gate's own presentation
  layer is part of the gate**, and the first thing a new check id breaks is the ordering nobody
  thinks of as code.
- **The illustration budget was three frames and there are now ten fault classes.** The shot list
  ranks by area and takes one frame per class, so a class whose unit of harm is small in square
  metres can never be photographed while a larger class is unfixed: G8d's headline — a complex
  whose two halves stand 17.4 m apart — scored 301 m² against 5,688 m² of paving in the wrong
  forum and was fifth in a queue of three. Raised to five. **A gate that can fail for a reason it
  could not fail for before and cannot show that reason has only half shipped.**

**Verdict — the score fell and the instrument improved, and the only way to tell those apart is
the injection list.** Of the eight checks this pass touched, seven go red on live data — G8c,
G8d, G13a, G13b, G15 and G22 on Rome, G8 on Carthage — which proves those seven. G11 passes on
both maps, and a passing check proves nothing whatever about itself. So every limb that live data
cannot reach has a named `--inject` that breaks one of
the probe's own inputs — never the game, never `src/` — and states which check must go red:
G13a's upper band (nothing on either map exceeds it), G11's exclusion-membership limb, G22's
stale-licence limb, and G8c/G8d on a map with no complexes. All seven fired. An injected run
prints a banner, tags the checks it expects to flip, always exits non-zero, and exits **3** if a
check that was supposed to go red did not — which caught a real defect in the harness on its first
use, where `complex-invent`'s expectation string listed G8 as needing to go red when G8 going
*green* is the whole demonstration.

**What we would do differently.**

- **Type the published dimensions in before building the thing they grade, not after.**
  `PUBLISHED` has 26 rows for a city with 27 drawn monuments, and only 10 of them are both gated
  and present. Every gap in it is a monument the absolute band and the size order cannot see, and the
  gap was created by the build getting ahead of the literature rather than by anything hard.
- **Write down what a relation costs at the moment the relation is added.** `complex` was added
  to the survey with an argument, evidence per group, and a 2.4 m bound — and the bound lived in
  the offline script that granted the licence, so declaring a complex was free. The obligation
  had to be added by a separate agent two phases later, against an adjudication. **A licence and
  its price belong in the same commit.**
- **State the exclusion list's failure mode, not only its membership.** G22's first draft faulted
  Rome's `tiber-island` licence as stale, because the row is `soft` and publishes no collision
  solid at all — there was nothing to be wet. A licence can go unused two ways and only one of
  them means the list has rotted; conflating them made the probe report a fault in itself as a
  fault in the city, which is the most expensive kind of false positive a gate can produce.

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

### 21 Aug 2026 — Rome fabric phase 3: the frame decision, and four mechanisms that were never wired up

**What I did.** Took the ground judge's four-item list in its own priority order, on
`e/city/rome-landmarks-p3` off `e/city/rome-landmarks` at `6c975e8`. `docs/ROME-FABRIC.md` §9 is
the full write-up; this is what the method learned.

**What I expected.** That item 1 — *"`KZ` = 0.30, or the reason it is impossible in writing"* —
would be a half-day of sweeping and a judgement call about how much backdrop to trade for how
much depth.

**What happened.** `KZ` = 0.30 is *more* compression, not less. The judge's own diagnosis is
"the frame is too small for the survey", and 0.30 makes the frame smaller: anisotropy 1.27× →
1.48×, conflicting pairs 14 → 18, and a true-depth insula fits over **0 %** of the real
cross-street range instead of 11 %, which is precisely the arithmetic impossibility rule 10 was
written about and phase 1 existed to escape. Two independent readings of the same number reached
the same wrong sign — the judge's, and my own first reading of the brief — because "raise `KZ`"
and "raise compression" sound like the same direction and are opposites.

Then the sweep said something nobody had asked for: **the feasible window is
[0.3334, ~0.357] and it is 0.024 wide.** The floor is the insula module; the ceiling is the
Colosseum leaving the heightfield between 0.355 and 0.360. `KZ` was never a lever. It had one
notch of travel and phase 1 already used it.

**Verdict: right to demand the measurement, wrong to expect a decision. The measurement closed
the question instead of informing it, and that is the better outcome — four findings that were
all "spend a pass on `KZ`" are now one finding that says "spend it on `HALF_EXTENT` or on the
complexes".**

**What I would do differently.** Bracket the constraint *window* before pricing any single value
inside it. I swept the six points the tool shipped with, read the table, and only then thought to
ask where the walls were; had I bisected the ceiling first — two runs, four minutes — the whole
of item 1 would have been answered before I read the rest of the verdict, and it gates everything
else.

---

Four rules this pass paid for, offered for §1 in the numbering that follows the judge's 14–18.

> **19. A field that is declared, documented and never read is worse than a missing one, and the
> way to find them is to grep for readers rather than for writers.** Rome's Castra Praetoria is
> drawn at a fifth of its published plan because the camp stands 59 world metres inside a wall it
> needs 260 m of half-depth to sit behind. The survey has carried `atWall` — *"fraction of the
> footprint's depth that may sit north of the wall crest"* — for two phases, with a paragraph
> explaining it; `place()` copied it onto the placement and **nothing ever read it**. Nor
> `drawMax`, anywhere in `src/`. Nor `maxDrawAt`, which has no callers at all. Three mechanisms,
> all documented as constraints, all inert, and the constraint they describe enforced instead by a
> human transcribing an offline script's answer into a literal. Implementing one of them took the
> fortress from 76 × 72 m to 130 × 123 m and removed seven of nine size inversions. **A grep for
> the *definition* of a field finds it; only a grep for its *consumers* tells you whether the
> mechanism exists.**

> **20. A check whose failure sets its own "pending" cannot fail.** Rome's frame report filters
> faults with `!ok && pending === null` and one row set `pending` as `ok ? null : '…'` — non-null
> exactly when the check failed. So a genuine monument-in-a-street regression printed as PENDING
> and left the fault list empty. The generalisation is worth more than the bug: **an escape hatch
> whose condition is correlated with the failure it excuses is not an escape hatch, it is a
> deletion.** Same shape as rule 16's born-dark exclusion, one level up — there the population was
> chosen to exclude the fault, here the severity was.

> **21. Reproduce the other instrument's headline inside the tree before arguing with it, because
> the argument is usually about what was measured and not about the number.** A judge reported
> *"the road the assault arrives on is 32 % solid"*, walking the gate's own straight normal. The
> road is not straight — the layout has deflected ways round their monuments since phase 1 — and a
> column follows the way graph, so "the road" and "a straight line out of the gate" are two
> claims and only the second had ever been measured. Both now print at every boot, side by side,
> and the carriageway is 13 % where the axis is 20.6 %. **Neither number is wrong; the name was.** A
> claim in the record that no instrument in the tree can re-derive is a claim nobody can check,
> and the act of re-deriving it is what surfaces the definition.

> **22. When two independent agents make the same sign error in the same formula, the formula
> needs a comment more than the agents need care.** `rot = atan2(cos θ, sin θ)` in an
> `(x = e, z = −n)` frame: get the sign wrong and every box is mirrored about its own centre,
> which is **invisible on an axis-aligned building and silently inverts every rotated one**. It
> reported the Basilica Ulpia and Trajan's Column interpenetrating by 27.3 m, then 13.6 m, then
> made all five of Rome's declared complexes read as detached including the two that genuinely
> abut. Three independent occurrences: the offline allocator, a judge's own probe, and the first
> draft of the check written to catch it — each caught only by disagreeing with a hand-computed
> separation. **A geometric convention that fails silently on the symmetric case needs its
> failure mode written at the site, not its correctness asserted.**

<!-- Append new entries above this line. -->
