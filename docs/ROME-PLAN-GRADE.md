# Rome from above — the grades

Graded against `docs/ROME-PLAN-RUBRIC.md`. Newest pass last. Every number here is reproducible:

```
node tools/judge/dump-plan.mjs --root=<checkout> --port=59xx --out=/tmp/judge/plan.json
node tools/judge/grade.mjs     --in=/tmp/judge/plan.json
```

`dump-plan.mjs` only reads; `grade.mjs` only compares; `control.mjs` holds the plate readings with
a stated method and error per row. The three are separate files on purpose: the defendant, the
arithmetic and the ruler should not be able to be edited in one commit.

---

## Pass 1 — 21 Aug 2026 — `e/city/rome-fabric-p1` @ `bc2e0f2`, `KZ` 0.35

**This is the state the owner looked at.** Phase 1 of `docs/ROME-FABRIC.md`: the frame changed
from `KZ` 0.222 to 0.35 and nothing else was rebuilt. No roads, no grid, no fabric, and
`resolveOverlaps` still live. Twenty-nine monuments placed, five off the +Z edge, 1,160 insulae.

### Verdict: **18 / 100 — FAIL.** All three veto criteria score zero.

*(Scored **18 under rubric v1.0** and **17 under v1.1**, which adds P3 — the channel's drawn width
— at weight 4 and P16 — the road armature — at weight 5, both funded out of criteria that already
score zero or near it. Both totals are reported so the series stays comparable across the
amendment.)*

| # | criterion | weight | score | measurement |
|---|---|---:|---:|---|
| P1 | Tiber centreline departure | 10 | **0.0** | worst **177 real m / 78 world m** at n 1414; 40 m allowed |
| P2 | Tiber bend — the shape | 9 | **0.0** ⚠ | the engine reproduces **21 %** of the plate's bend; 80 % required |
| P4 | circuit waypoints vs the inked wall | 7 | **0.0** | 0 of 6 measured gates inside 30 m; worst **361 real m** (Porta Salaria) |
| P5 | the wall meets the water | 3 | **1.1** | **40.7 world m** of dry ground where the curtain should stand on the bank |
| P6 | landmark position, as built | 20 | **0.0** ⚠ | median **294 real m** over the fourteen rows with plate evidence, worst **1,031 m** (Theatre of Pompey); 25 m allowed |
| P7 | landmark position, as surveyed | 6 | **3.4** | 8 of 14 evidence rows inside their own error bar; median **39 m**, worst 138 m |
| P8 | bearing | 7 | **7.0** | median **2.4°**, worst 3.8° over 29 monuments; 5° allowed |
| P9 | footprint vs published | 5 | **4.2** | 10 of 12 pass; compression **0.696 uniform** across the cohort |
| P10 | topology vs the plate | 4 | **0.1** | **18 of 184** plate relations inverted |
| P11 | nothing in water | 8 | **0.0** ⚠ | **74 of 1,160** insulae with their centre in the channel, **56 wholly submerged**, 87 touching it |
| P12 | nothing in a carriageway | 6 | **0.0** | **16.9 %** of 37.0 ha of carriageway covered; 24 of 29 monuments offend |
| P13 | nothing inside the curtain | 3 | **2.5** | 1 undeclared insula; the one monument north of the line declares `atWall` |
| P14 | regions partition | 5 | **0.0** | 17 districts claim **2.66×** the walled ground over **79** overlapping pairs |
| P15 | grain vs the street armature | 7 | **0.0** | median **21.3°**; a coin toss gives 22.5° |
| P3 | the channel's drawn width *(v1.1: weight 4)* | 0 | **0.0** | the drawn channel reaches **385 world m** across in x where it declares 94; 65 of 559 samples over 45° |
| P16 | the road armature *(v1.1: weight 5)* | 0 | **0.0** | **13** ways at 42 m where the design says one; carriageway **25.5 %** of the walled ground against a Roman city's 12–15 %; **43** ranked ways where the real city had hundreds |
| | **total (v1.0 / v1.1)** | **100** | **18.3 / 17.1** | |

⚠ = veto criterion at zero.

**Frame check passes.** `GATE_X` and `GATE_Z` re-derived from their published closed form agree
with the running page to the digit. The front is 1,332.5 world m from x +2.01 to x +1334.55, which
is what `ROME.md` asks for. `KX` 0.443, `KZ` 0.35, footprint compression 0.696 measured uniform
across twelve sourced monuments — **the projection arithmetic is honest and is not the problem.**

---

### The ranked divergences

Ranked by damage, with the cause named, because two of the top four share one.

#### 1 — Every monument is in the wrong place, by a median of 294 real metres, and the cause is one function

`resolveOverlaps` moves the twenty-nine placed monuments a **mean of 352 real metres** (median 238,
worst **1,098**) off `worldOf(e, n)`. Measured independently of the resolver, by taking the built
centre out of `LANDMARKS` and un-projecting it; agrees with the phase-1 author's own figure of
351 m, which is the useful kind of corroboration.

Against the plate rather than against the survey, the ten worst:

| monument | built vs plate, real m | of which the resolver | world m |
|---|---:|---:|---:|
| **Theatre of Pompey** | **1,031** | 1,098 | 368 |
| **Stadium of Domitian** | **887** | 887 | 359 |
| Baths of Agrippa | 756 | 752 | 333 |
| Pantheon | 624 | 628 | 275 |
| Baths of Nero | 590 | 638 | 259 |
| Castra Praetoria | 414 | 338 | 147 |
| Trajan's Column | 385 | 384 | 151 |
| Theatre of Marcellus | 260 | 260 | 114 |
| Largo Argentina | 231 | 238 | 101 |
| Temple of Jupiter OM | 201 | 201 | 88 |

*(Not in the table because they are not graded against a plate control this pass: the Iseum
Campense 755 m, the Horologium 408 m, the Ara Pacis 336 m, the Ludus Magnus 280 m, Trajan's Market
269 m, the Temple of Serapis 221 m, the Tabularium 181 m, the Imperial fora 164 m, the Basilica
Ulpia 155 m, the Porticus Octaviae 148 m. Their resolver displacement is measured; their plate
position is not.)*

**The Theatre of Pompey is drawn 368 world metres from its plate position, which on this map puts
it beside the Mausoleum of Augustus** — the two are 1.25 real kilometres apart. That is visible in
`screenshots/rome-fabric-p1/02-engine-plan-after.png` without any instrument: the two labels sit
one above the other at the top of the plan.

**And it is not only metric.** 18 of 184 spatial relations that the plate asserts are inverted in
the build. Among them:

- *the Pantheon is no longer north of the Theatre of Pompey* (it is 385 real metres north on the
  plate);
- *the Baths of Agrippa are no longer west of the Temple of Jupiter* — i.e. part of the Campus
  Martius has been pushed east of the Capitol;
- *the Stadium of Domitian is no longer west of the Tiber Island*, and no longer south of the
  Mausoleum of Hadrian, which is on the far bank;
- *the Theatre of Pompey is no longer south of Trajan's Column.*

A viewer who knows Rome will name these. They are the sharpest evidence that the fault is not
"things are a bit off" but "the plan is not Rome's plan".

**Fix:** delete `resolveOverlaps`, per `ROME-FABRIC.md` §4.5. It recovers 20 of the 20 points on P6,
most of P10's 4, and a large share of P12's 6, because 24 of 29 monuments are standing in a
carriageway *only because the solver put them there*. **This is by a wide margin the most valuable
single change available.**

#### 2 — The Tiber has a fifth of its bend, on exactly the reach the assault is fought beside

Read off the Lanciani plate at 1.02 m/px on a 100 m survey-metre grid, five stations from
n 2256 down to n 1414 — the river's frontage from above the wall's north-west angle down past the
northern Campus Martius:

| survey n | plate channel e | engine e | departure |
|---:|---:|---:|---|
| 2256 | −841 | −869 | −28 real m / −12 world |
| 2001 | −805 | −853 | −48 / −21 |
| 1747 | −754 | −838 | −84 / −37 |
| 1499 | −676 | −829 | −153 / −68 |
| 1414 | −652 | −829 | **−177 / −78** |

**Over those 842 metres of northing the plate's channel swings 189 metres east. The engine's swings
40.** The engine's Tiber runs nearly parallel to the map's z axis where the real one runs plainly
diagonal, and the bend it is missing has been redistributed into a broader, later sweep further
south. Sampled every 50 m against the modern-bridge control, the second derivative changes sign
against the control at four stations in the reach n 1050–2100, sharpest at n 1100 — the Ponte
Umberto knee, the tightest turn in the whole city reach, where the engine is curving the *other
way*.

That is the owner's *"the Tiber bending the wrong way"*, quantified. **78 world metres is 83 % of
the modelled channel's own width**, and it is 78 world metres of the western Campus Martius that
the river is standing on and the city cannot use.

**And the representation itself cannot hold the river's shape.** `riverCentreX` is `x = f(z)`.
Where the channel runs at angle θ to the z axis its band measured along x is `94 / cos θ` wide.
Measured on the shipped LUT: **the worst sample is 75.9° off the z axis at z 1265, where the
channel is 385 world metres wide in x against the 94 it declares — 4.1×** — and **65 of 559 on-map
samples exceed 45°.** `topography.ts` already concedes that *"no sum of sines in z can hold"* the
66° and 78° segments; **a lookup table of x(z) cannot hold them either, it merely does not say
so.** The fix is a polyline with a real distance field, not a finer table. *(One thing in phase 1's
favour: raising `KZ` 0.222 → 0.35 stretches z and so reduces every one of these slopes by 1.58×.
At `KZ` 0.222 the worst reach was about 81° and roughly 600 world metres wide in x.)*

**Two corrections to my own working, recorded because they change what a builder should trust.**
(a) I first measured this against sixteen modern bridge midpoints recalled from memory and got a
worst departure of 297 m; the plate says 177. The bridge control is 41–125 m off the plate's channel
in this reach, because two of its points were recalled at the same longitude, which makes the
control *too straight* — and a control that is too straight cannot grade a river for being too
straight. It stays in `control.mjs`, demoted to corroboration, with its measured disagreement
printed. (b) Both attempts to digitise the channel automatically failed: Lanciani's blue does not
survive a simple threshold (the sheet mosaic has white seams across this exact reach) and the AGEA
orthophoto is too dark and mottled to segment naively. **Do not repeat either without a better
classifier.**

#### 3 — Seventy-four buildings and one island stand in the river

**74 of 1,160 insulae have their centre inside the modelled channel, 56 are wholly inside it, and
87 touch it.** Nothing in the build has ever checked for this; `assertNoFabricOverlaps` does not
know the river exists.

*(My first pass said 42 and 24. It used the bare `RIVER_HALF_WIDTH = 47`; the channel's wet band
measured **along x** is wider than that by `hypot(1, dx/dz)` wherever the river runs diagonally —
`topography.ts:riverBankX` divides by `riverPerpScale` for exactly this reason — and in the bend
that factor reaches 1.7. Corrected in `grade.mjs`. The phase-1 author's own figure, 60 of 1,259,
was taken on the smaller plan-view fabric with, I think, the same bare half-width.)*

**It is not a marginal, sub-pixel fault.** `screenshots/rome-fabric-p1/engine-after/city.png`
shows a dozen insulae standing on the open water surface in one frame, several of them entirely
surrounded by it, with no bank underneath. Look at the right-hand third of that image.

The Insula Tiberina is a separate case and worse than it looks. It carries `onRiver: true`, so it
is placed on the *modelled* river's centreline rather than by the survey — which means it inherits
the whole of fault 2. Its plate position (read off the inked island outline) is 43 real metres from
its survey row, of which 34 m is perpendicular to a 67 m wide island, so the modelled island's
centreline lies on the real island's northern shore. It is also drawn at **1.070× its published
270 × 67 m** while every other monument is drawn at 0.696× — **1.54× larger relative to the city
around it than anything else on the map.**

#### 4 — The circuit's eastern half is 165–361 real metres from the wall Lanciani draws

Read on a 50 m grid at 0.64 m/px against the plate's hatched, *labelled* masonry:

| waypoint | survey (e, n) | plate (e, n) | error |
|---|---|---|---:|
| **porta-salaria** | 1036, 1784 | **1305, 2024** | **361 real m / 146 world m** |
| porta-nomentana | 1831, 1784 | 1633, 1788 | 198 / 88 |
| castra-nw | 1931, 1711 | 1767, 1698 | 165 / 73 |
| posterula-pinciana | 530, 1789 | 501, 1886 | 101 / 36 |
| tiber-angle | −655, 2006 | −731, 1955 | 92 / 38 (±60, the least certain row) |
| porta-flaminia | −497, 2045 | −497, 2131 | 86 / 30 |

The Porta Salaria row is the clearest and it is unambiguous without any grid at all: on the plate,
the surveyed waypoint sits **235 real metres south of the inked wall**, in open ground inside the
Horti Sallustiani, while the gate structure labelled `PORTA SALARIA` is up at the top of the crop.
`/tmp/judge/crops/g-wp-salaria.png` reproduces it.

Note the *pattern*: the four northern waypoints between Pinciana and Nomentana all carry
`n = 1784–1789`, so the survey draws that stretch of curtain dead east–west. The plate does not —
it rises to the Salaria and falls again to the Nomentana. **The surveyed circuit has flattened the
Vallis Sallustiana crossing out of existence.**

**And the structural fault behind it:** `ROME_CIRCUIT_SURVEY` is `{ id, e, n }` — **no `cite` field
on any of the fourteen rows.** It is the only survey on this map with no source per row, and it is
the line the whole battle is fought on. `MAP-METHOD.md` rule 2 exists for this.

Two secondary circuit findings. The curtain's north-west angle stands **40.7 world metres** clear
of the modelled channel's east bank, where Aurelian's wall terminated on the bank — but that number
is a *consequence of fault 2*, not an independent one, and fixing the river will move it. And of
the four gates, **only the Porta Flaminia's inner mouth lands on a way that leads into the city**
(the Via Lata, 8.0 m away). Pinciana and Salaria land on the `via-sagularis`, the military road
*behind* the curtain, and the Nomentana on a monument ring — so three of four gates open onto a
road that runs parallel to the wall and nowhere else. That is `ROME-FABRIC.md` §4.2's claim,
measured: **1 of 4.**

#### 5 — The fabric's grain is a coin toss

Block plan angle against the nearest ranked way, folded to 0–45°, over 1,064 blocks within 200 m of
a way: **median 21.3°, p90 39.9°, and 945 of 1,064 (88.8 %) more than 5° off.** A uniformly random
orientation gives a median of 22.5°. **The fabric's orientation carries essentially no information
about the street it stands on.**

`probe-fabric.mjs` reports a median of 9.17° for the same city against a different attribution
(nearest drawn street, which includes each quarter's own hash-rotated lanes and therefore partly
grades the fabric against itself). Both numbers fail; mine uses the more independent ruler and is
the one I weight, and the disagreement between them is itself worth a builder's attention.

#### 6 — Twenty-four of twenty-nine monuments stand in a carriageway

**62,564 m² of monument footprint inside a ranked carriageway — 16.9 % of the city's 37.0 ha of
road.** Worst: the Horti Sallustiani 11,090 m², the Castra Praetoria 7,773, the Janiculum 7,294,
the Forum Romanum 7,026, the Theatre of Pompey 6,563.

**Zero insulae** are in a carriageway, which is a genuine pass and worth saying: the fabric
generator reserves `WAYS` into its keep-out before it plans, and it works. The offenders are all
monuments, and they are there because the resolver moved them after the roads were drawn and
`deflect()` could not bend the roads far enough. **This is downstream of fault 1.**

#### 7 — The roads are too few and far too wide, and half the tarmac is 42 metres across

Nobody is working on this and it is on the record anyway.

| measure | Rome as built | what it should be | source for the target |
|---|---:|---:|---|
| ways at processional rank (42 m) | **13** | 1, plus the *via sagularis* | `ROME-FABRIC.md` §4.2: *"processional 42 m — **Via Lata only**"* |
| total carriageway | **37.0 ha, 25.5 %** of the walled world ground | 12–15 % | excavated street-area fraction at Pompeii and Ostia |
| share of carriageway at 42 m | **53.7 %** (19.9 ha) | ~9 % | the same §4.2 table |
| ranked ways in total | **43** | several hundred | a Roman city's network is dense and narrow |
| the six ways Shepherd names and the tree lacks | **0 of 6** | 6 | Shepherd pl. 22 draws Clivus Suburanus, Argiletum, Via Tecta, Clivus Capitolinus, the Subura and the Via Pinciana with endpoints |

**Eight of the thirteen 42-metre avenues are machine-generated** — seven `feeder-*` ways and one
`stitch-*`, 5.5 ha between them — so the generator is manufacturing processional boulevards that no
design asked for. `layout.ts` is honest that 42 m is a game compromise so a 35-metre cohort can
move, and that is a fair trade made **once**. Made thirteen times it is not a compromise, it is the
shape of the city.

**And the Via Lata, the one street the assault runs down, is drawn as a bow.** The Via Lata is the
Via Flaminia inside the walls and is the modern Via del Corso — 1.6 km ruler-straight from Piazza
del Popolo to Piazza Venezia, and one of the most famously straight streets in Europe. The engine's
polyline departs from that straight line by **360 real metres / 160 world metres** at its worst,
bowing east across the middle of the run:

| along the run | engine, survey (e, n) | off the Corso's line |
|---|---|---:|
| t = 0.01 | (−497, 2022) | 7 real m |
| t = 0.27 | (−488, 1560) | 130 |
| t = 0.54 | (−459, 1080) | 239 |
| t = 0.80 | (−400, 620) | **314** |
| dense worst | | **360 real / 160 world** |

The cause is `deflect()`: the way is resampled every 30 m and pushed out of the monuments the
resolver had already moved. **So this is a third consequence of fault 1**, and deleting
`resolveOverlaps` and `deflect` together should straighten it without anyone authoring a new
polyline.

#### 8 — The seventeen layout regions claim 2.66× the ground

79 overlapping pairs, 4.55 km² claimed twice or more against 1.45 km² of walled world ground. This
is `ROME-FABRIC.md` §2.3 reproduced with independent arithmetic and it is unchanged by phase 1.

#### 9 — Two footprints are wrong and one of them is wrong in the other direction

Compression measured **0.696 across twelve sourced monuments, uniform to three figures** — the
projection is honest and the exceptions are modelling faults, not projection faults.

| monument | published | modelled | ratio | aspect pub/mod | verdict |
|---|---|---|---:|---|---|
| Iseum Campense | 200 × 50 | 48.7 × 23.6 | **0.243** | 4.00 / **2.06** | **2.9× too small and the wrong shape.** Known-wrong in the tree since `ROME.md` §6.3 and still wrong |
| Insula Tiberina | 270 × 67 | 288.9 × 71.7 | **1.070** | 4.03 / 4.03 | **1.54× oversized relative to the cohort** — it is the only monument that escapes `PLAN_SCALE` |
| Castra Praetoria | 437 × 380 | 278.2 × 262.2 | 0.637 | 1.15 / 1.06 | small and squarer than it should be, but **declared** in `survey.ts` with the reason |
| the other nine | | | 0.694–0.697 | agree to 1 % | **good** |

---

### What is good, said plainly

A judge that never passes anything is useless. These are passing and should be left alone:

- **The projection arithmetic.** `GATE_X`/`GATE_Z` re-derived independently agree to the digit; the
  front is 1,332.5 world m between the two anchors; footprint compression is 0.696 uniform across
  twelve sourced monuments. **`KX`, `KZ` and `PLAN_SCALE` are not the problem and changing them
  further will not help.**
- **Bearings, for now.** Median 2.4°, worst 3.8°, every monument inside 5°. See the objection below.
- **The survey table, where it can be checked.** 5 of the 9 rows with genuine plate evidence are
  inside 30 real metres and the median is **23 m**. The Stadium of Domitian, the Mausoleum of
  Augustus and the Theatre of Marcellus read **zero** against the plate; the Colosseum 20 m and the
  Pantheon 23 m. `ROME`'s survey discipline is the best artefact on this map and `ROME-FABRIC.md` is
  right that the rebuild should extend it rather than replace it — but see flagged item 8, because
  two thirds of it is still ungraded and the four rows that do fail (Theatre of Pompey 138 m,
  Castra Praetoria 113 m, Baths of Nero 104 m, Insula Tiberina 43 m) are not a small tail.
- **The fabric generator's street reservation.** Zero insulae in a carriageway out of 1,160.
- **The Colosseum**, position 20 m and bearing inside 5° — measured off the plate, not asserted.
- **Nothing inside the curtain** except one insula corner and the Horti Sallustiani, which declares
  `atWall: 0.6` and is historically correct to be cut by the wall.

---

### Flagged, not yet quantified — and what would settle each

Stated rather than suppressed, per the rubric's rule 1.

1. **The review plates show a city the game does not build.** `src/city/plan.ts` (the plan-view
   diagnostic the owner's screenshots come from) reserves only `STREETS` at `width/2 + 2.5`, while
   `src/city/rome/plan.ts` (the game) reserves all 43 `WAYS` at `WAY_FRONTAGE`. Measured: the
   diagnostic builds **1,344** insulae and the game builds **1,160**. The extra 184 are standing in
   roads the diagnostic did not reserve. **Anyone producing review plates should build the game's
   keep-out.** *Settles it:* one line in `src/city/plan.ts`.
2. **`ROT_RATIO = 1.45` currently passes P8 and should not survive the next pass.** Its stated
   justification in `survey.ts` is that *"the overlap resolver spreads the plan east–west… so the
   frame is nearer 1.45:1 than 2:1."* The plan is to delete the resolver. The frame's own ratio at
   `KZ` 0.35 is `0.443 / 0.35 = 1.266`, and 1.45 over-rotates every bearing by up to 3.8°. **A
   build that deletes `resolveOverlaps` and leaves `ROT_RATIO` at 1.45 fails P8 on argument.**
3. ~~**The Porticus Octaviae's plate position is unresolved.**~~ **Withdrawn.** Re-read at
   0.46 m/px: the structure I took for the quadriportico 200 m east is on the far side of the
   Theatre of Marcellus and is the Forum Holitorium slope, not the porticus. The survey row is
   consistent with the plate to within about 60 m, which is inside my reading error at that scale
   for a feature I cannot positively identify. **The coarse reading was wrong and the claim is
   retracted.** The same crop refines the Theatre of Marcellus: its cavea's centre of curvature is
   at plate (−252, −91), 39 m from the survey row, not the 0 m the contact sheet suggested.
4. **Fifteen of twenty-nine placed monuments have no plate control at all** and their positions are
   therefore ungraded, including the Imperial fora, the Basilica Ulpia, Trajan's Market, the
   Tabularium, the Temple of Serapis, the Baths of Titus and Trajan, the Ludus Magnus, the Ara
   Pacis, the Horologium and the Iseum. *Settles it:* about two hours of crops at 0.4–0.6 m/px, and
   it should be done before the landmark rework lands, not after. **But note the ceiling:** Lanciani
   was published 1893–1901 and cannot control the Ara Pacis (excavated 1937–8), the Ludus Magnus
   (1937), the Area Sacra's full plan (1926–9), the Crypta Balbi or much of the Imperial fora. For
   those rows there is no plate in `reference/rome-plans/` that is a ruler at all, and the survey's
   own cited coordinates stand as the best evidence. That is a limit on how far this rubric can
   ever grade Rome, and it should be written into the map's own docs rather than rediscovered.
5. **Roof coverage against the AGEA orthophoto is not measured** — `ROME-FABRIC.md` §4.4 check 4
   asks for 60–70 % per region and no instrument exists. *Settles it:* a 6 m raster of built area
   between street lines, per region, against a sampled orthophoto.
6. **The five monuments off the +Z edge at `KZ` 0.35** — Palatine, Circus Maximus, Aventine, Baths
   of Caracalla, Caelian — are simply absent. This rubric scores nothing for them because they are
   an accepted cost the owner has been asked to approve, not a fidelity error. It should be said
   out loud that the map currently has **no Palatine and no Circus Maximus**, which are two of the
   half-dozen things a person naming Rome from above would look for.
8. **Only nine of the thirty-four survey rows carry genuine plate evidence.** Eight I read off
   Lanciani this pass, plus the Baths of Nero from an independent gazetteer. **Nine of the
   remainder turned out to be my own restatement of `survey.ts`'s own cited latitude and
   longitude** — see the self-correction below. Until the rest are digitised, P7 is scored on nine
   rows and the map's survey is mostly untested rather than mostly right.

7. ~~**Roads: rank membership is unchecked.**~~ **Measured — see ranked fault 7.** It is now
   criterion P16 and it scores zero.

---

### Negative results, recorded so nobody repeats them

- **Colour-threshold segmentation of Lanciani's blue channel fails.** The channel ink runs to
  (185, 205, 203) — a grey-teal within 20 of the cream page — and the georeferenced mosaic carries
  pure-white sheet seams straight across the reach that matters (e −1000 to −875 at n 1900 is
  white). `tools/judge/digitise-river.mjs` is committed *with* its failure, median run width 0.
- **The AGEA orthophoto does not segment naively either.** Samples across the channel at six
  northings are uniformly dark and mottled with no water signature separable by threshold.
- **I nearly published a check that compared the survey against itself.** Nine of my first
  control rows — the Forum Romanum, the Temple of Jupiter, Trajan's Column, the Baths of Agrippa,
  Largo Argentina, the Mausoleum of Hadrian, the Palatine, the Circus Maximus and the Baths of
  Caracalla — were WGS84 positions I believed I was supplying independently, and every one of them
  turned out to reproduce `survey.ts`'s own `cite` to four decimals. They scored 0–23 m and would
  have flattered P7 from 3.3 to 4.7 out of 6 on nothing at all. They are kept in `control.mjs`
  marked `how: 'restated'`, printed in the report, and excluded from every position score. This is
  `MAP-METHOD.md` rule 6's failure mode arriving inside the instrument written to enforce it, which
  is worth more on the record than a clean table would have been.
- **A plate reading taken at 3.1 m/px is not a measurement.** My first Castra Praetoria reading off
  a contact sheet gave a 113 m displacement; the fine reading gives 113 m too, but my first Porta
  Salaria reading off the same kind of sheet was 200 m adrift of the fine one. Read at the scale of
  the thing being measured or do not publish the number.

---

### What would change my mind

- **On fault 2 (the Tiber's bend):** if a properly digitised channel polyline off the plate showed
  the swing ratio above 0.6 rather than 0.21, this drops from a veto to a metric fault. My five
  stations carry ±25 m each, which is ±50 m on a 189 m swing — enough to move 0.21 to 0.32 at the
  extreme, not enough to reach 0.6.
- **On fault 4 (the circuit):** if someone shows that Lanciani's hatched line through the
  Sallustiana reach is not the Aurelian curtain, the Porta Salaria number collapses. I do not think
  it will: the line carries a gate symbol with the plate's own `PORTA SALARIA` legend on it, runs
  continuously from the Pincian reach into the Castra Praetoria, and is drawn in the convention
  Lanciani uses for standing masonry.
- **On the weighting:** if the owner says the Palatine and the Circus Maximus being off the map is
  the worst thing here, P1–P15 do not capture it and the rubric needs a fifteenth criterion for
  *presence*. I have deliberately not added one, because the frame decision is his to make and a
  judge should not smuggle a design vote in as a measurement.
