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

12. **Before trusting a statistic, check that its sample and its spread have not collapsed. A
   degenerate statistic does not report an error — it reports a confident number.** This is rule 6's
   companion and it catches the case rule 6 cannot: the instrument *is* comparing against something
   outside itself, and is still lying, because the arithmetic has quietly lost the thing that made
   it meaningful. Every instance found so far had the same shape — a denominator, a sample size or a
   range went to zero, and the formula carried on and returned a number with no error and no
   warning attached.

   Measured, in one afternoon, inside the instruments built to enforce the other eleven rules:

   - A watch on `src/` compared a hash of **199 unfiltered files from the git tree** against a
     baseline hash of **192 filtered files from the worktree**. Two different functions over two
     different file sets, so the disagreement was *constant*, and it reported both branches as
     changed while both sat on the commit they had started on. It fired on its first pass and
     looked exactly like a real event.
   - A before/after comparator flagged a column as `** beyond its own spread **` because the spread
     was **`sd = 0.0`**. With a zero denominator every difference is infinitely many sigma, so the
     column that had moved by a **rounding step** was the loudest signal in the table. On Rome's
     assault, where twelve seeds break within a sixth of a second, most of the table has an `sd`
     under 0.2 — so this was not a corner case, it was the normal case.
   - The same comparator printed **"TRANSLATION (every seed moved the same way; p=1.0000)"** off a
     sample of **one seed**, and `Infinity sd` beside it. It had computed p correctly, printed it
     correctly, and named the opposite conclusion anyway.

   It is the same failure as `--battle=rome` silently loading the field battle and asserting
   nothing, as six playability scripts polling a selector the product does not render, and as every
   shipped feature here that never worked: **nothing threw.** A test that cannot fail and a
   statistic that cannot be undefined are the same object, and both feel like a passing check.

   **The remedy is a floor and a refusal, chosen in advance and written into the instrument:**

   - *Floor every spread-based threshold.* A move must clear the measured spread **and** be worth
     more than 1 % of the column's own value, so a column with no spread cannot make a rounding
     step significant.
   - *Set a minimum sample and decline below it, rather than hedging.* A sign test declines under
     **n = 5** (`2/2^5 = 0.06` is the first n at which unanimity is worth saying aloud); a
     range test declines under **n = 3**, because two points are not a range.
   - *Refuse outright when the comparison is vacuous.* If the product's own state hashes say the
     tree did not move, exit non-zero and grade nothing. Reporting "no significant change" from an
     identical tree is the same sentence as reporting it from a real one, and only one of them is
     an answer.
   - *Print the sample size and the spread next to every figure derived from them,* so the next
     reader can see the collapse without re-deriving it.

   **And the companion case, which is the same failure in the time axis: a checkpoint must lie
   inside the window in which the thing it measures exists, and that window is a property of the
   tree and the map, not of the metric.** Three faces, all measured here: sampling *after* the
   window closes and noticing (t+400 against a field battle whose median verdict is t+367 — only
   2 of 8 seeds still being fought); sampling after it closes and *not* noticing (t+200 against a
   siege that ends at **t+56**, which produced a true finding about one tree and a false
   generalisation to another); and sampling *coarser* than the window (a 10 s grid over a ~3 s
   spread, reported as **"sd 0.15 s, a range of 63 to 63 seconds"** when the real answer was
   55–58 s — the statistic lost its *resolution*, not its sample, and returned a confident number
   anyway). Print the window beside the checkpoint: *"still being fought in 2 of 8 seeds"* is the
   sentence that stops all three.

   And the generalisation that reaches past instruments into the product: **a derived number must
   be derived once.** `src/ui/siege.ts` exists because three panels each deciding for itself what
   "the breach" meant came to disagree; the result card prints *"The wall was carried"* over a
   defeat because it re-derives which victory condition fired instead of being told by the arbiter
   that fired it. Same rule, same cost, on the other side of the interface.


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

<!-- Append new entries above this line. -->
