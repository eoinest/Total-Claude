# Rome from above — the plan rubric

**What "as realistic as possible" means, turned into fourteen criteria that can each fail.**

Written by an independent judge on `e/judge/rome-plan`. I did not write anyone's brief, I am not
building anything, and I have changed no source. The grades live in `docs/ROME-PLAN-GRADE.md`;
this file is only the standard.

## Why this exists

A twenty-one-check geometric gate passed the Rome map. The owner then looked at one top-down
render for under a minute and found four faults it could not see: **the Tiber bending the wrong
way, buildings standing in the river, buildings in the middle of roads, and monuments far from
where they belong.**

`tools/probe-fabric.mjs` says why, in its own header: *"it can prove a footprint is the wrong
SIZE and it cannot prove it is in the wrong PLACE."* Every one of its rulers is a published
dimension, a vertex, or a mathematical identity. **Not one of them is a map of Rome.** So the map
could be internally immaculate and still not be Rome, and it was.

This rubric's rulers are maps of Rome. `docs/MAP-METHOD.md` rule 6 — *"the instrument must compare
against something outside the thing being checked"* — is satisfied here by the plate, not by a
constant typed into a probe.

## The rulers, and what each is good for

| ruler | what it is | resolution | used for |
|---|---|---|---|
| **Lanciani, *Forma Urbis Romae* (1893–1901), georectified by SITAR** — `reference/rome-plans/lanciani-georef-EPSG3004-2307658_4638583_2314671_4643263-4096px.png` | 4096 × 2734, 1.71 m/px, EPSG:3004, affine to the survey frame fitted to **1.26 m worst residual over 7 km** (`src/city/overlay.ts:LANCIANI_1901`) | ~15–25 m by eye at 0.6 m/px on a drawn 50 m grid | **the primary ruler.** Monument positions, monument long axes, the circuit's gates, the Tiber's channel |
| **Shepherd, *Historical Atlas* pl. 22 (1911/1923-26)** — `shepherd-1923-plan-of-imperial-rome-350ad-2826px.jpg` | 2.100 and 2.094 m/px measured off two scale bars agreeing to 0.3 % | ~30 m | names, gates, the fourteen regions, which consular road enters where. **Dated c. 350 AD: not admissible on its own for what stood in 271** |
| **Kiepert / EB11 "Plan of Ancient Rome" (1911)** | metric scale bar; Republican/Imperial colour separation | ~40 m | the date filter, and dimensions where Lanciani is ambiguous |
| **AGEA 2012 orthophoto**, same georeference, pixel-registered | 4096 × 2734 | — | roof coverage and block grain. **Attempted as a river classifier this pass and it failed** — see the grade's negative results |
| **Published plan dimensions** with a source per figure | — | — | footprint size and aspect only. Never position |

Everything the judge reads off a plate goes into `tools/judge/control.mjs` with a `how` field and
a stated reading error. **A row I could not better carries `how: 'survey'` and is UNGRADED, not
scored as a pass.** A rubric that silently scores unmeasured rows as passing is the fault this
whole exercise exists to correct.

## The frame

All errors are quoted in **real (survey) metres** first and **world (battlefield) metres**
second, because the two differ by 2.3× east–west and 2.9× north–south and quoting one without the
other has already misled this project. Survey metres are metres east/north of the Temple of
Jupiter Optimus Maximus, 41.8925 N 12.4823 E. World metres come from `worldOf`, **re-derived in
`tools/judge/grade.mjs` from its published closed form rather than imported**, so that a change to
the projection is measured rather than inherited.

**Anything built after 271 AD scores zero if it is drawn, whatever the plate says.** The Baths of
Diocletian were begun in 298 and Shepherd draws them at full size. The Baths of Constantine, the
Basilica of Maxentius and the Arch of Constantine are the same case. A reference can be authentic
and still wrong for the year.

---

## 1. The criteria

Fourteen. Weights sum to 100. Each names its test, its threshold, its ruler, and the scoring rule
that turns a measurement into a fraction of the weight.

### Weighting principle, stated so it can be argued with

Weight is **not** proportional to metres of error. It is proportional to *how much of the map the
error changes* and *whether a viewer who knows Rome would name the fault*. Three consequences:

1. **A topological inversion outranks a metric offset of the same size.** A monument 200 m out is
   a monument in the wrong place; a monument on the wrong *side* of its neighbour is a different
   city. The Tiber bending the wrong way is the same class of fault, which is why it has its own
   criterion (P2) separate from its displacement (P1).
2. **The fought-over ground is weighted over the backdrop.** The battle is the northern front and
   the 700 world metres of Campus Martius behind the Porta Flaminia. A 3 m offset on a temple in
   the deep south-east is worth almost nothing; the same offset on the river beside the assaulted
   gate is worth a great deal.
3. **A thing that cannot physically be there outranks a thing that is merely misplaced.** A house
   standing in the Tiber is not a fidelity error, it is a bug that happens to be visible from
   above.

### The gate criteria

**P2, P5 and P10 are vetoes.** If any of them scores zero, the map is **not passable at any total
score.** A river bending the wrong way is not compensated by a good wall; monuments a kilometre
from their plate position are not compensated by correct footprints; a city with houses in its
river is not finished. State the total anyway — a builder needs to see movement — but the verdict
is FAIL until all three are non-zero.

---

### A. Water and terrain — what everything else is placed against

#### P1 — Tiber centreline departure · weight 10

**Test.** Un-project `riverCentreX(z)` back into survey metres and compare its easting against the
channel centre read off the Lanciani plate, at stations 250 m apart in northing, over the whole
reach the map draws.

**Ruler.** `TIBER_PLATE` in `tools/judge/control.mjs`: the inked channel's two banks read on a
100 m survey-metre grid at 1.02 m/px, midpoint taken, ±25 m per station.

**Threshold.** ≤ **40 real metres** (≈18 world m, under a fifth of the modelled 94 world-metre
channel) at every station between n = 1000 and n = 2400 — the reach beside the front. ≤ 80 real
metres anywhere else on the map.

**Score.** 1.0 if the worst station is inside threshold; 0.0 at 4× threshold; linear between.

#### P2 — Tiber bend: the shape, not the offset · **VETO** · weight 9

**Test.** Over the graded reach, the total easting swing of the engine's channel divided by the
total easting swing of the plate's. Plus the sign of d²e/dn² at every station against the plate.

**Why separate from P1.** A river displaced uniformly is still the right river seen from the wrong
place. A river with a fifth of the real bend is a different river, and it is what a person notices
in under a minute from one picture. P1 can pass while P2 fails and vice versa.

**Threshold.** Swing ratio ≥ **0.80**, and **zero** sign inversions where the plate's curvature is
unambiguous.

**Score.** `clamp((ratio − 0.30) / 0.50)`, then halved if any unambiguous sign inversion survives.

#### P3 — the channel's drawn width · weight 0 in v1.0, **weight 4 from v1.1** · *see the amendment below*

Held open in v1.0 as "no ruler exists". Pass 1 found one, and it is not the one I expected.

**Test.** The modelled channel's width **measured along x**, everywhere on the map, against the
94 world metres the model itself declares (`RIVER_HALF_WIDTH = 47`, which is a cross-section and so
is uncompressed, and which matches the ancient Tiber's roughly 100 real metres at Rome).

**Why it is not trivially 94.** `riverCentreX` parameterises the river as `x = f(z)`. Where the
channel runs at an angle θ to the z axis its x-band is `94 / cos θ` wide, and the real Tiber at
Rome turns nearly east–west twice — `topography.ts`'s own comment concedes *"two of these segments
run at 66 and 78 degrees to the z axis… which no sum of sines in z can hold."* **A lookup table of
`x(z)` cannot hold them either; it merely does not say so.** Consumers that take `x −
riverCentreX(z)` as a cross-channel distance are wrong by the same factor, and `riverPerpScale`
corrects only some of them.

**Threshold.** Drawn x-width within **25 %** of 94 world metres at every on-map sample; ≤ 2 % of
samples above 45° to the z axis.

**Score.** `clamp(1 − (worstRatio − 1.25) / 1.5)`, halved if more than 10 % of samples exceed 45°.

#### Amendment — rubric v1.1, effective from pass 2

P3 takes **weight 4**, and it comes from **P1 (10 → 8)** and **P12 (6 → 4)**. Announced rather than
applied silently, and pass 1 is re-scored under both: because P1, P3 and P12 all score zero at pass
1, **the total is unchanged at 18.2 either way**, so the series stays comparable. Any later
amendment must be recorded the same way and must re-score every earlier pass.

---

### B. The circuit

#### P4 — the fourteen circuit waypoints against the plate's inked wall · weight 7

**Test.** Each waypoint of `ROME_CIRCUIT_SURVEY` against Lanciani's hatched, labelled masonry.

**Ruler.** `CIRCUIT_PLATE` in `tools/judge/control.mjs`, read on a 50 m grid at 0.64 m/px, ±20–35 m.

**Threshold.** ≤ **30 real metres** per waypoint.

**Note that carries its own weight:** `ROME_CIRCUIT_SURVEY` is the only survey on this map whose
rows carry **no `cite` field at all**, and it is the line the entire battle is fought on. That is a
standing violation of `MAP-METHOD.md` rule 2 independent of whether the numbers turn out right.

**Score.** Fraction of measured waypoints inside threshold, × `clamp(2 − worst / (3 × threshold))`.

#### P5 — the wall meets the water · weight 3

**Test.** Dry world metres between the modelled channel's east bank and the circuit's north-west
angle, at that angle's own z.

**Threshold.** ≤ **15 world metres**. Aurelian's curtain terminated on the bank; a strip of dry
ground there is a strip of ground the assault can use that never existed.

**Score.** `clamp(15 / measured)`.

---

### C. Landmarks

#### P6 — landmark position, **as built**, against the plate · **VETO** · weight 20

**Test.** Take each placed monument's centre out of the layout in world metres, un-project it, and
compare against the plate. This is what the player gets, after every solver has run.

**Threshold.** Every monument ≤ **25 real metres** (the plate's own reading error); median ≤ 15 m.

**Why the largest single weight.** It is the owner's literal complaint, it is twenty-nine
independent failures rather than one, and it is upstream of the roads, the grid and the fabric —
`docs/ROME-FABRIC.md` §2.4 shows the streets are bent around wherever the monuments end up.

**Score.** `clamp(1 − (median − 25) / 100)` × `clamp(1 − (worst − 25) / 300)`.

#### P7 — landmark position, **as surveyed**, against the plate · weight 6

The same test against `ROME`'s own `e`/`n` rather than the built position. **Separate criterion
because it has a different owner and a different fix**: P6 is the layout's fault, P7 is the
survey's. A build can fail P6 with a perfect P7, and that is exactly the useful thing to know.

**Threshold.** ≤ **30 real metres** per row.

**Score.** Fraction of graded rows inside threshold.

#### P8 — bearing · weight 7

**Test.** The drawn plan rotation of each monument against its plate long axis put through the
frame's own anisotropy `KX/KZ`.

**Why it is here at all.** Nobody has been grading it, and a monument at a correct position with a
wrong bearing reads wrong from above — the Circus Maximus at the wrong angle leaves the Vallis
Murcia at both ends, and `survey.ts` records that happening once already.

**Threshold.** ≤ **5°** per monument.

**Standing objection regardless of the score:** `ROT_RATIO = 1.45` is justified in
`survey.ts` by the overlap resolver's east–west spreading. The plan is to delete the resolver. A
constant whose stated justification is a thing being deleted is a constant with no justification,
and at `KZ = 0.35` the frame's own ratio is `0.443 / 0.35 = 1.266`. **Any build that deletes
`resolveOverlaps` and leaves `ROT_RATIO` at 1.45 fails this criterion on argument even if it
passes on arithmetic**, and the judge will say so.

**Score.** Fraction inside threshold.

#### P9 — footprint against the published plan · weight 5

**Test.** Modelled long × short against published, as (a) **aspect ratio**, which is invariant
under any uniform plan compression, and (b) modelled ÷ published against the **median of the
cohort's own ratios**, so no repo constant is needed.

**Threshold.** Aspect within **5 %**; scale ratio within **10 %** of the cohort median, or a
declared per-monument exception written beside the real dimension it departs from.

**Score.** Fraction of sourced monuments passing both.

#### P10 — topology against the plate · weight 4

**Test.** For every pair of graded monuments more than 100 m apart on an axis, does the built city
preserve the plate's sign on that axis?

**Threshold.** **Zero** inversions.

**Score.** `clamp(1 − 10 × inverted / tested)`.

---

### D. The three things that cannot be there

#### P11 — nothing stands in water · **VETO** · weight 8

**Test.** Every solid — monuments and insulae — against the modelled channel.

**Threshold.** **Zero** solids with their centre in the channel and zero with any corner in it,
excepting `onRiver` monuments which must instead sit on the plate's island.

**Score.** `clamp(1 − 30 × wet / total)`.

#### P12 — nothing stands in a carriageway · weight 6

**Test.** Footprint area inside a ranked carriageway, measured with the judge's own
Sutherland–Hodgman clip, over the road population the **game** reserves (`WAYS` × `WAY_FRONTAGE`),
not the smaller set the plan-view diagnostic uses.

**Threshold.** ≤ **0.5 %** of carriageway area, and **zero monuments**.

**Score.** `clamp(1 − covered% / 5)`.

#### P13 — nothing stands inside the curtain · weight 3

**Test.** Any solid with stone north of `romeWallZ(x)`, excepting rows that declare `atWall`.

**Threshold.** Zero undeclared.

---

### E. The fabric's plan

#### P14 — the layout regions must partition the ground · weight 5

**Test.** Claimed region area ÷ available walled ground, and the count of overlapping pairs.

**Threshold.** **1.00 ± 0.10** and **zero** overlapping pairs. This is not a tuned constant; it is
the definition of a partition.

#### P15 — grain: blocks against the street armature · weight 7

**Test.** Each block's plan angle against the nearest ranked way, folded to 0–45° (a rectangle may
lie either way along its street).

**Threshold.** median ≤ **5°**, p90 ≤ 10°, and ≤ 10 % of blocks more than 5° off.

**Why 7 and not 3.** `docs/MAP-METHOD.md` §2 predicted in advance that the rebuild would live or
die on the grid step and that the grain check would be the one dropped as nice-to-have. It is the
only check that can fail on a quilt and pass on a city. A uniformly random orientation gives a
median of 22.5°; **a score near that number means the fabric is not derived from the roads at all,
whatever the generator's comments say.**

---

## 2. The weights, in one table

| # | criterion | weight | veto |
|---|---|---:|:--:|
| P1 | Tiber centreline departure | 10 → **8** (v1.1) | |
| P2 | Tiber bend — the shape | 9 | **●** |
| P3 | the channel's drawn width | 0 → **4** (v1.1) | |
| P4 | circuit waypoints vs the inked wall | 7 | |
| P5 | the wall meets the water | 3 | |
| P6 | landmark position **as built** | 20 | **●** |
| P7 | landmark position **as surveyed** | 6 | |
| P8 | bearing | 7 | |
| P9 | footprint vs published | 5 | |
| P10 | topology vs the plate | 4 | |
| P11 | nothing in water | 8 | **●** |
| P12 | nothing in a carriageway | 6 → **4** (v1.1) | |
| P13 | nothing inside the curtain | 3 | |
| P14 | regions partition | 5 | |
| P15 | grain vs the street armature | 7 | |
| | **total** | **100** | |

## 3. Verdict bands

| total | verdict |
|---|---|
| ≥ 90 and no veto at zero and no criterion below half weight | **the plate**, which is the standard the owner set |
| 75–89, no veto at zero | good; name every remaining divergence in the map's own docs |
| 50–74 | recognisably Rome from above, with faults a reader can list |
| < 50, or any veto at zero | **FAIL** — not a plan of Rome |

**A score is not a pass.** "Better than last pass" is not a verdict; the standard is the plate.

## 4. Standing rules for anyone using this rubric

1. **Quantify or mark it unquantified.** Never let an impression through as a measurement, and
   never suppress an impression you cannot yet quantify — flag it and say what would settle it.
2. **Cite the plate and the place on it.** A claim with no source is a claim a builder can dismiss.
3. **Read the plate at the scale of the thing you are measuring.** This judge's own coarse readings
   (3.1 m/px in a contact sheet) were wrong by 100–200 m and its fine readings (0.6 m/px on a drawn
   50 m grid) agree with known-good rows to under 20 m. **A reading taken at the wrong scale is not
   a measurement and must not be published as one.** Earned the hard way this pass.
4. **The plate has a date, and it is not the map's date.** Lanciani was published 1893–1901 and
   **cannot control anything excavated after it** — the Area Sacra (1926–9), the Ara Pacis
   (1937–8), the Ludus Magnus (1937), the Crypta Balbi (1980s), much of the Imperial fora. Kiepert
   and Shepherd are no later. For those rows there is no plate ruler in this repo and the survey's
   own cited coordinates are the best evidence available. **Say so; do not digitise a blank patch
   of plate and call it a control.**
5. **A gazetteer recalled from memory is not a plate.** This judge's recalled latitudes for the
   northern gates were 130–200 m out while its recalled longitudes were good to a metre. Any control
   point not confirmed on a plate carries `how: 'gazetteer'` and its error bar is 60 m, not 20.
6. **Grade the whole map every pass, including what nobody is working on**, so a fault that is
   nobody's job right now is still on the record and still ranked.
