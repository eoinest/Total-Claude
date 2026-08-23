# Rome from 1.75 m — the ground pass

Branch `e/city/rome-eye-level`, 22 August 2026, three commits on `ef8b5c7`. It answers one
sentence of the brief that assembled the map: *"From 150–400 m, yes, convincingly. From 1.75 m,
not yet."*

This is the key to the pictures and the numbers. The method log is `MAP-METHOD.md` §3, entry of
22 Aug; the rules it earned are §1 rules 24, 25 and 26.

## Start here — the pictures

Ten before-and-after pairs at identical cameras, plus the three control frames:

```
screenshots/ROME-EYE-LEVEL/
  01a-BEFORE-r-eye-quarter-east.jpg    01b-AFTER--r-eye-quarter-east.jpg   <- start here
  02a/b  r-eye-vialata-250      on the Via Lata 250 m inside the gate
  03a/b  r-parapet-in           from the wall-walk of bay 4, looking into the city
  04a/b  r-eye-quarter-south    1.75 m in the dense fabric
  05a/b  r-eye-gate-back        70 m inside the wall, looking back at the Porta Flaminia
  06a/b  r-vialata-terminus     down the axis — the frame the landform is plainest in
  07a/b  r-oblique-campus       the 420 m oblique, to check nothing was lost from the air
  08a/b  r-plan-campus          the plan of the Campus Martius
  09a/b  r-eye-tabernae         12 m off a frontage
  10a/b  r-eye-vialata-500      500 m in
  20-CONTROL-c-parapet-in.jpg / c-eye-quarter.jpg / c-avenue-30m.jpg
```

`screenshots/**` is gitignored by design; these are build output. Reproduce the whole set, one
browser slot, one page load per map:

```
node tools/film.mjs tools/shots/rome-eye-level.shot.mjs --stills --nooverlay \
     --port=5953 --out=screenshots/eye-after
```

**The cameras are in the tree, not in this document.** `tools/shots/rome-eye-level.shot.mjs`
carries all thirteen as data that `film.mjs --check` validates, which is the fix for the previous
pass's complaint that a camera station goes stale when the frame moves and nothing marks it. Ten
of them are the previous pass's rails **unchanged**, per `VISUAL-RUBRIC.md`'s critic instruction 9;
`r-eye-tabernae` is new and is marked as new in the file.

## What changed

Three faults, in the order the brief named them.

**1. The Campus Martius had a 45-metre hill in it.** `baseHeight`'s upland terms are gated on
`onHill`, which is a function of *northing against the hill's toe* and nothing else, so the Tiber
flood plain — where `riseAmplitude` publishes exactly zero rise — took +13 m of lift and ±27.5 m
of ridged multifractal. The Pantheon stood at 37.8 m. `floodplainMask` is now the missing relation:
the toe of the Pincian–Quirinal–Capitoline scarp as a ten-vertex line in the survey's own frame,
each vertex carrying the real place, its spot height and the run of its scarp. Two more instances
of the same class fell out of the instrument: the Muro Torto's cityward terrace was **903 real
metres** deep (authored in world metres; they are northings, so they divide by `KZ`), and §3.5's
published staircase — the ground's height *at the curtain* — was being added 900 m south of it.

**2. The ground floor was already modelled and was never drawn.** `archPanel` was called on a wall
box drawn solid on all four faces, so its 0.55 m reveal opened onto that box's own painted face
40 mm behind: **every taberna in Rome was blind arcading.** The repair is an ordering, not more
geometry — decide which faces the street can see, omit them from the box, rebuild each as an
elevation with real holes and a recess behind. Doors now go on every street face rather than one,
party walls stay blank because that is what makes a terrace a terrace, and every opening gets a
travertine threshold.

**3. Nothing in `GrassField.ts` had ever heard of the city.** Its only road-shaped mask is the
*battlefield's* Via Flaminia sinusoid, which wanders on through Rome at coordinates the Via Lata
has nothing to do with. The city now reaches the terrain through the control map's B channel,
whose scale is declared where it is written — **0.34 a parade ground, 0.80 a road verge, 1.00 a
city street** — from `urbanGroundMask`, which is the district floor's own mask, so what the terrain
calls city and what the city draws a floor over are the same function of the same table. The
terrain splat stopped drawing centuriated farmland, its 94 m survey lattice and a four-metre
metalled cart track on every parcel line, under the Forum.

## The numbers

`tools/probe-eye.mjs`, both trees, same command. Every ruler is outside the thing being checked:
published spot heights in metres above sea level, published landform dimensions, the drawn
geometry read back from the live scene, and a published street gradient.

| | `ef8b5c7` | `17e885c` | target |
|---|---|---|---|
| E1a flood plain against its published relief, worst | **22.7 m** (Piazza del Popolo) | **5.0 m** (the Trevi) | 4 m |
| E1a median | 10.1 m | **4.0 m** | |
| E1a implied datum against sea level | **+21.9 m** | **−1.7 m** | 0 |
| E1b Capitoline / Quirinal against their published rise | 0.65× / **0.59×** FAIL | 1.37× / **0.97×** PASS | 0.6–1.6× |
| E1c flood-plain relief over a 120 m window, median | **33.69 m** | **9.26 m** | 2.5 m |
| E1c p95 / worst | 38.99 / 40.18 m | **9.89 / 9.95 m** | |
| E1d the frame can carry the published relief | FAIL | FAIL | see below |
| E2 the Janiculum's reserved ground has its published aspect | PASS 2.27 (pub. 2.17) | PASS 2.27 | ≥ 0.6× |
| E3 terrain fall across a footprint, median / p95 | 2.18 / 9.36 m | **1.78** / 9.84 m | 1.0 m p95 |
| E4 street gradient, median | 5.38 % | **2.73 %** | 17 % ceiling |
| **E5 openings per 10 m of frontage at 1.6 m** | **0.26** | **0.74** | 1.2 |
| E5 street faces with none at all | **54.6 %** | **23.6 %** | 35 % |
| E5 frontage resolvable | 1,971 m / 97 faces | **6,098 m / 382 faces** | ≥ 1,200 m / 120 |
| E6 exclusions inside their declared caps | FAIL | **PASS** | |
| **verdict** | **1/9** | **3/9** | |

Vegetation pixels in the frame — the most external measure there is, because it counts what the
player sees rather than asking a system what it drew:

| frame | before | after |
|---|---|---|
| `r-eye-quarter-east`, whole frame | **12.6 %** | **0.0 %** |
| `r-eye-quarter-east`, lower third | 5.6 % | 0.0 % |
| `r-eye-vialata-250`, lower third | 1.9 % | 1.0 % |
| **Carthage `c-eye-quarter`, lower third** | **7.0 %** | **7.0 %** |

## The control, and what it now says

Carthage is shot in the same run at the pairings `CITY-GROUND-JUDGE.md` §2 used, and is graded by
the same probe. Its **simulation is provably untouched**: `qa-determinism --battle='map=carthage…'`
gives byte-identical hashes on both trees at all seven checkpoints. Its *rendering* moves by a
hair, because the grass response is shared code and Carthage's own road verges reach B = 0.80.

The control's own number is the most useful thing this pass produced:

> **Carthage: 0 openings per 10 m over 20,637 m of frontage on 896 faces. 100 % blank.**

Carthage's fabric generator *does* cut street doors — 0.28 m recesses — and they measure zero for
the same reason Rome's did: the outer face is drawn in the wall plane. **Two independent
generators, the same mistake, and no instrument on either until now.** So the split
`CITY-GROUND-JUDGE.md` §3 named is no longer symmetrical: Rome has taken Carthage's continuity —
one unbroken ground mat, no sward between the pavement and the wall — without giving up its
painted stucco, its tile or its arcading, and Carthage now visibly has the fault Rome had.
Compare `03b-AFTER--r-parapet-in.jpg` with `20-CONTROL-c-parapet-in.jpg`.

## The cost

`tools/probe-budget.mjs --map=campus-martius --tiers=ultra`, nine cameras, worst of each:

| | before | after |
|---|---|---|
| draw calls, worst camera (`assault`) | 174 | **174** |
| triangles, worst camera | 6.63 M | **6.83 M** (+3.0 %) |
| draw calls, `terrain` | 149 | **150** |
| triangles, `city` | 4.51 M | **4.66 M** |
| whole-frame cap | 220 | 220, **46 spare at the worst camera** |

Every triangle the ground floor adds lands in the `stucco` and `stone` streams the fabric already
submits, so it buys no new draw call anywhere. The one call that moved is the `terrain` camera's,
+1.

## Scored against `VISUAL-RUBRIC.md` §H

Harsh, as instructed, and comparable with `CITY-GROUND-JUDGE.md` §12 — same rubric, same criteria,
same eye, and eight of the ten stations are that pass's rails unchanged.

| | criterion | Rome `6c975e8` | Rome **`17e885c`** | Carthage | note |
|---|---|:--:|:--:|:--:|---|
| H1 | Enclosure | 1 | **1** | 2 | **Not measured this pass and not claimed.** Nothing here widens a frontage or narrows a street. |
| H2 | Continuous frontage | 3 | **3** | 3 | The criterion's own named fail — *"grass between the pavement and the wall"* — is gone, 12.6 % → 0.0 %. Held at 3 because its other half, blocks standing with air on four sides, is untouched. |
| H3 | Nothing in the carriageway | 1 | **1** | 3 | Unchanged; no monument moved. |
| H4 | The way goes somewhere | 3 | **3** | 3 | Unchanged. |
| H5 | One grain, locally | 1 | **1** | 3 | Unchanged. The quilt is a Phase 4 property and Phase 4 has not happened. |
| H6 | Verticality | 2 | **2** | 3 | Unchanged. |
| H7 | The ground floor is inhabited | **0** | **2** | **0** | 0.26 → **0.74 openings per 10 m** measured, blank faces 54.6 % → 23.6 %, thresholds under every one. A third of Ostia's rate, on every street face rather than one. Carthage measured for the first time: **0.00**. |
| H8 | A man is the ruler | 2 | **2** | 1 | (a) and (c) unchanged. (b) is a hair worse: `probe-fabric` G13b 8 of 43 inverted → 9, from the Iseum row below. |
| H9 | The floor of the city | 2 | **3** | 2 | Continuous dark beaten earth and gravel with the travertine footways drawing the network as light lines on it, kerbs reading, weeds in the cracks and not in the middle. Not 4: §10.7.2's polygonal shards and ribbons that do not lie on the ground are still there. |
| H10 | Somebody lives here | 0 | **0** | 0 | Unchanged. Still the cheapest item on the list. |
| | **mean** | **1.5** | **1.8** | **2.0** | |

**Rome: FAIL, mean 1.8, with H10 at zero and five more below 2.** Up from 1.5. Carthage still
leads on urbanism at 2.0 and is now measured to be at zero on H7 as well.

## The one number that went the wrong way

`probe-fabric` **10/25 → 9/25**. One row: G12's drawn aspect for the Iseum Campense, 3.487 → 2.456
against a published 4. Its *plan* is byte-identical. What moved is the drawn geometry —
`drawnLong` 90.46 → 59.63, `drawnTopY` 57.81 → 25.71, `drawnVerts` 9,439 → 5,839 — and the 32 m
the top lost is the height of the hill that was under it. G13a's below-the-floor list grows from 3
to 5 with the two Campus Martius rows that stood on that hill.

**The best reading is that the drawn extents were inflated by foundation spreading down a
hillside a flood plain does not have, and that with it gone the monument measures its own stone —
which is 0.298 of published, the 0.339 floor `CITY-GROUND-JUDGE.md` §10.7.3 already names.** I did
not isolate it to the line and am not calling it proven. **The measurement that settles it is one
run with `buildSubstructure` disabled, comparing `drawnVerts` on the two trees.** If it is
something else, the terrain fix is not implicated either way — the plan is unchanged and no
monument moved — but the explanation in `MAP-METHOD.md` §1 rule 26 would need withdrawing.

## What is still wrong, ranked

1. **E1c: 9.26 m of relief over a 120 m window on a flood plain**, tightly clustered — median
   9.26, p95 9.89, worst 9.95, which is one broad feature and not local hills. It is the modelled
   Tiber's own valley: `riverInfluence` reaches 266 m from the centreline and the plain is
   inside it almost everywhere in the bend. Whether a flood plain should have a 266 m valley is a
   question for whoever re-surveyed the river; the probe excludes 130 m and counts the exclusion.
2. **E3: the fabric still stands on ungraded ground** — p95 9.84 m of fall across a footprint,
   worst 47.5 m, on the eastern hills where a building needs a terrace and gets none. Nothing in
   the tree cuts one. This is the next terrain pass and it is bigger than this one.
3. **E4: 811 of 5,201 street samples steeper than the Clivus Capitolinus**, worst 324 % at the
   +Z edge where lanes run off the map.
4. **E5 is 0.74 against 1.2 and Ostia's 2.5.** The shop fronts are on the principal face only and
   the pitch on the back faces is 6–10 m. Doubling it is one constant, but it should be paid for
   with a measurement rather than a preference.
5. **E1d: the frame cannot carry the Pincian's west scarp.** 31 m of height across 19.7 world
   metres is a gradient of 1.57 against the engine's own impassable slope of 0.625. No heightfield
   in this projection can do it, so two published stations are excluded and counted.
6. **The Janiculum's keep-out is still a circle** — `addCircle(moundRadius * 1.02)`, r 234.6 m, for
   a hill with a 96.4 m semi-minor axis. E2 passes because the *fabric's* hole happens to be
   elliptical for other reasons; the circle survives in `city/plan.ts` and should be replaced with
   the same OBB the mound is drawn from.
7. **H10 is still zero.** No carts, stalls, amphorae, altars or tethered animals anywhere. It is
   the cheapest item on the list and this pass did not touch it.

## What would change my mind

- **A frame from `r-eye-quarter-east` in which the ground still reads as meadow.** It reads 0.0 %
  vegetation; if a different station in the same quarter reads high, the mask is patchy and the
  district-floor coverage is the thing to look at, not the grass.
- **An opening count above 1.2 per 10 m that a person cannot see in a frame**, which would mean E5
  is counting reveals rather than openings. The check to run is the same scanline at 2.4 m, above
  every door head: it should read close to zero.
- **`buildSubstructure` disabled and the Iseum's `drawnVerts` unchanged.** That would falsify the
  reading of the G12 flip above and I would have to find the real cause.
- **A draw-call count over 190 at the assault camera on a machine with a different GPU.** The
  measurement here is one machine; the claim "no new draw call" is structural — same material
  streams — but the number is not.
