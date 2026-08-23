# Rome — the fabric, rebuilt from the plates

**Status: research and diagnosis. No source code was changed by this pass.** Written on
`e/docs/rome-fabric` at `58bc584`. Four reference plates were added to `reference/rome-plans/`
and catalogued in `ASSETS.md` items 9–12; three the owner supplied were rejected and the reason
for each is recorded there.

**The decision this document is written under, verbatim from the owner:**

> *"i honestly think the footprint of where the buildings are is completely wrong for rome as it
> currently stands. everything is completely off. i think we are better basically starting from
> scratch here. we can reuse the assets, but we should really follow the carthage method with the
> grid system and planning everything out from top down, not trying to make something broken
> work."*

**So this is a rebuild of the layout layer, not a repair of it.** The line to hold, stated once so
nobody re-litigates it later:

- **Assets are reused.** `src/city/rome/monuments.ts` (3,096 lines of monument geometry),
  `build.ts`, `materials.ts`, `texgen.ts`, `props.ts`, the instancing and the LOD machinery all
  stay. Nothing here asks for a new mesh.
- **Every *position* is re-derived top-down from the plates**, in the order the owner named:
  **water and terrain → the wall → landmarks → roads → a grid derived from the roads → ordinary
  buildings into the grid.** Nothing placed before the thing that constrains it.
- **`resolveOverlaps` is deleted, not tuned.** If an overlap resolver survives in any form it is
  as an *assertion* on a layout that is already correct by construction — never as the thing that
  makes it correct.

Two things are **fixed inputs**, not open questions. The owner said the river is a good start, and
today's circuit work measures well: 36 bays at a 37.015 m pitch landing 0.01 m off the survey's
fixed ends, worst walk step 5.23 m, zero projectile rays through the wall anywhere. Plan the
fabric around them. §4.5 does conclude that both must be **re-projected** — the same survey
polylines through a changed `KZ` — and states the measurement that forces it. That is a re-run of
`ROME.md` §15 tasks 1 and 3, not a redesign of them, and §5 prices it.

A separate agent is putting stairs on the circuit at Carthage's density — every second tower
rather than nine flights on 1.78 km. **Nothing below assumes the current nine.**

---

## 0. How to read this

Tags follow `CARTHAGE.md` §0 and `ROME.md` §0:

| tag | means |
|---|---|
| **[MEAS]** | Measured this pass. The script and its output are named. |
| **[SRC]** | Read out of source in the tree at `58bc584`. |
| **[PLATE]** | Read off a named reference plate in `reference/rome-plans/`. |
| **[MOD]** | Modern scholarly consensus, or a published measured dimension. Named. |
| **[DER]** | Derived here by arithmetic from other entries. The arithmetic is shown. |
| **[GAME]** | A game decision with no ancient authority. Called out every time. |
| **[?]** | **A number I could not verify this pass.** Do not cite it as a measurement. |

**Units.** All real-world dimensions are metres. "Real" coordinates are metres east (`e`) and
north (`n`) of the Temple of Jupiter Optimus Maximus, 41.8925 N 12.4823 E — the survey frame
`src/city/rome/survey.ts` already uses. "World" or "engine" coordinates are the battlefield's
`x`/`z` in world metres.

---

## 1. The Carthage method, as a procedure

Reverse-engineered from `docs/CARTHAGE.md` (1,068 lines) and from `src/city/carthage/` (3,556
lines across ten files) plus `src/maps/carthage/` (2,448 lines across four). This is what Carthage
actually did, in the order it did it, with the departures from its own document called out — because
two of those departures are the interesting part.

### 1.1 The seven steps

**Step 1 — fix the frame before anything else exists.** Read out what the engine will not move and
write it down as a table: `HALF_EXTENT = 1400`, the two deployment boxes, the z below which no city
geometry may appear. `CARTHAGE.md` §2.1. Then choose the compass orientation *from the battle* —
Carthage's only land approach is from the west, so map −Z is true west, rotated 90° from Rome.
§2.2. **A map's compass is a consequence of where the attacker deploys, not a preference.**

**Step 2 — pick a survey origin that is a real monument, and derive the projection from the
constraints rather than choosing it.** §2.3. Origin: the Byrsa summit. Then:

```
x = KN · n          KN = 0.45      (across the map — true north)
z = Z0 + KE · e     KE = 0.22 ,  Z0 = 945    (into the map — true east)
```

`KE = 0.22` is *"the largest value that fits the whole city between the wall and the sea inside the
map"*; `KN = 0.45` is *"set by the wall: the isthmus front is 4.43 km of real wall and it has to fit
across a 2800 m map with both ends on water."* Neither is a taste decision. Both are stated with
the constraint that produced them, so a later reader can tell whether the constraint still holds.

**Step 3 — state the compression rule, in three categories, before placing anything.** §2.4. This
is the step everyone skips and it is the one that decides whether the map can be built.

> **Positions compress. Cross-sections do not.**

- **Compressed** (through `KN`/`KE`): every position; the length of the wall along its own line;
  the extent of a district; the plan of the harbours; the footprint of the hill.
- **Not compressed** (true metres): wall height and thickness, ditch width and depth, tower height
  and footprint **and spacing**, street widths, storey heights, insula dimensions.
- **The third category, and it is where the rule bites:** anything whose *slope* matters cannot
  take a compressed run against an uncompressed height. Carthage has exactly two — the Byrsa's
  gradient and open spaces that have to be fought in — and **both are overridden explicitly, with
  the arithmetic printed in the file that does the overriding** (`src/maps/carthage/topography.ts`
  lines 255–290: the projected footprint would give a 30° cliff against a real 1:7, so the
  footprint is set from the gradient instead).

  *"If you find a third case, add it here rather than quietly bending the projection."*

The consequence Carthage accepts out loud: *"the wall is 4,434 real metres long and 1,984 world
metres long, but it is 9.1 metres thick in both… towers stand 59.2 world metres apart because that
is the real interval, which means the modelled stretch carries 33 towers where the real wall
carried 75."* **The modelled city carries fewer of a repeated thing than the real one did.** Hold
that sentence; §4.5 needs it.

**Step 4 — write the survey table, with a source column, and end it with sanity checks that must
hold *after* the build.** §2.5. Fifteen rows of `feature | e | n | x | z | source`. Then four
numbers:

- attacker deployment to the ditch lip = **642 m of approach**;
- wall to Byrsa summit = **418 m** of city depth;
- Byrsa to shore = **231 m**, then ~200 m of open sea;
- modelled wall length **1,984 m**.

These are how you find out the build went wrong while it is still cheap to fix. **[SRC] They are
also the one part of the Carthage method that was never implemented** — grepping `418`, `642`,
`231` and `1984` across `tools/probe-carthage*.mjs` returns zero hits. §1.3 below.

**Step 5 — rank the roads, and lay them before any block exists.** §7.2. Carthage's ranks are
narrower than Rome's and the document says why in one line: *"The widest street anywhere in the
excavated Punic city is 9 m, and it is called out in the literature as exceptional."*

| rank | width | reserved band | authority |
|---|---:|---:|---|
| processional | 20 m | 40 m | [GAME], stated as a compromise, two ways only |
| arterial | 12 m | 22 m | [GAME] from the attested 9 m sea-gate street |
| local | 7 m | 9.8 m | [ARCH], top of Lancel's 5–7 m band |
| lane | 4 m | 5.6 m | [ARCH], near the Magon quarter's 3 m |
| stepped | 6 m | — | [ARCH], on any grade over 1:8 |

In code (`src/city/carthage/layout.ts:298–347`, 427–641) that is `PUNIC_WAY_WIDTH`,
`PUNIC_FRONTAGE` and thirteen named ways as authored polylines. And the *order* is explicit in
`src/city/carthage/plan.ts:95–130`: wall and intervallum keep-out → monuments → **ways** → fabric →
street surfaces. Roads are reserved into the keep-out map **before the fabric generator runs**.

**Step 6 — author the ordinary fabric on a real module, snapped to one world lattice.** §7.1, §7.3.
This is the heart of it.

The Byrsa quarter's excavated insula is **15.5 × 31 m = 30 × 60 Punic cubits**, subdivided into
five plots of 12 × 30 cubits. So `src/city/carthage/layout.ts:66–79` declares `CUBIT = 0.515` and
the module in cubits, and `src/city/carthage/fabric.ts:377–398` lays **one lattice for the whole
city**:

```
pitchU = INSULA_FACE  + PUNIC_WAY_WIDTH.vicus   // 30.9 + 4  = 34.90 m
pitchV = INSULA_DEPTH + PUNIC_WAY_WIDTH.local   // 15.45 + 7 = 22.45 m
cellU = round((q.x - q.hw) / pitchU) * pitchU + (i + 0.5) * pitchU - q.x
cellV = round((q.z - q.hd) / pitchV) * pitchV + (j + 0.5) * pitchV - q.z
```

Two things there are load-bearing and are the reason Carthage does not read as a quilt:

1. **`CITY_BEARING = 0`** (`fabric.ts:279`) overrides every one of the sixteen quarters' authored
   rotations, so the whole city shares one grain.
2. **The lattice is snapped to *world* coordinates**, not to each quarter's own box — that is what
   the `round(...)` is for. So two adjacent quarters' blocks land on the same lines and the seam
   between them is a street, not a fault.

And where a block does not fit, **it shrinks by a plot rather than disappearing** — `fitFace()`
(`fabric.ts:320–347`) quantises the frontage to `PLOT_FACE = 6.18 m` and never trims the depth,
because *"§7.1's defining feature is a house with entrances front and back onto two streets, so `v`
is fixed at 30 cubits and all the give is in `u`."*

**Step 7 — assert on the built result, over everything, with no escape hatch.**
`src/city/carthage/assertions.ts` carries eleven checks; the relevant one is check #2, solid/solid
interpenetration (`src/city/carthage/assertions.ts:184–280`). Its properties are all deliberate and
all documented in place:

- the population is *every* solid against *every* solid — monuments, houses, quays, moles **and the
  harbour water as chords**;
- the allowance is `d > 0.4` m with **no upper escape hatch** — the comment records that an earlier
  `> 40 m` skip *"hid a real 46 m warehouse/mole overlap"*;
- one exclusion only, chord-vs-chord, because the cothon is one basin discretised into 28 chords.

### 1.2 The scope decision, which is the method's real secret

**Carthage did not model Carthage.** It modelled the isthmus front, the Byrsa, the harbours, and
**one excavated quarter**, and declared the northern half of the walled area a *third terrain
class* — the Megara, §7.7: *"not streets and insulae but a large suburb of market gardens,
orchards, hedges, ditches and irrigation channels."* Dry-stone walls 1.2–1.8 m on a 40–70 m grid,
8 % building coverage. *"It is also cheap: it is scatter and low walls, not buildings."*

That is not a shortcut. It is the decision that made the rest of the method arithmetically
possible, and **it is the one thing `ROME.md` considered and refused** (§6.1). §4.5 revisits that
refusal.

### 1.3 Where Carthage's own method is weaker than its document

Stated because a procedure copied from a document rather than from the code will inherit gaps that
are not in the document.

- **`worldOf` for Carthage is dead code.** [SRC] It is defined at
  `src/maps/carthage/topography.ts:78–81` and its own docstring says *"Author a position as
  `worldOf(e, n)`; never write an x or a z by hand"* — and it has **zero call sites**. Every one of
  the twelve entries in `MONUMENTS` (`src/city/carthage/layout.ts:196–279`) is a hand-typed world
  coordinate with the projection arithmetic surviving only as a comment. Rome's `ROME` table is
  strictly better: it holds `e`, `n`, `len`, `wid`, `bearing` and a `cite` per monument and
  projects at load. **Keep Rome's form. It is the one part of Rome that is already right.**
- **Carthage's monuments have no footprint scale at all** — no `PLAN_SCALE`, no real dimensions,
  just final world half-extents chosen by hand until nothing overlapped. That works for twelve
  monuments and would not survive thirty-four. It is also unfalsifiable in exactly the way
  `survey.ts:9–16` warns about.
- **The four §2.5 sanity checks were never instrumented.** [MEAS]
- **Nothing anywhere compares a built Carthage monument to a plan of Carthage.** Rome has
  `src/city/overlay.ts` and a georeferenced Lanciani raster; Carthage has no equivalent.

So the target is not "be Carthage". It is **Rome's survey discipline, plus Carthage's build order
and module, plus an instrument neither of them has.**

---

## 2. Diagnosis: two independent faults, and only one of them is `PLAN_SCALE`

Kept short, per the coordinator's instruction, but the arithmetic is here in full because it is
what gates the design.

All numbers below are [MEAS] this pass, re-derived independently: the survey table was parsed out
of `src/city/rome/survey.ts` and `worldOf`, `place()` and `worldRot()` were re-implemented from
`src/terrain/topography.ts:356–389` and `src/city/rome/survey.ts:525–540` rather than imported, so
the arithmetic below cannot be an echo of the code it is grading.

### 2.1 The three scales

There are **three different scale regimes in one map**, and no two of them agree. [SRC]

| what | east–west | north–south | areal |
|---|---|---|---|
| **positions** (`worldOf`) | × `KX` = 0.443 | × `KZ` = 0.222 | **10.2× compression** |
| **monument footprints** (`PLAN_SCALE × PRECINCT`) | × 0.696 | × 0.696 | 2.07× compression |
| **district extents** (`he·KX·2.05`, `hn·KZ·3.5`) | × 0.908 | × 0.777 | 1.42× compression |

`src/city/rome/layout.ts:144` and `:723–724`. The middle row is the monument fault; the bottom row
is the fabric fault. They are independent and each is sufficient on its own to produce a wrong city.

### 2.2 Fault 1 — adjacent monuments must intersect, and here is the closed form

For two monuments with half-extents `a` and `b` along one world axis, a real clear gap `G` between
them, an axis compression `K`, a footprint scale `S` and the code's `PRECINCT = 1.07` and
`STREET_GAP = 7`:

```
clear world ground = K·G − (S·PRECINCT − K)·(a + b) − STREET_GAP
```

At `S = 0.65` that is negative unless

| axis | requirement on the real gap |
|---|---|
| x, `K` = 0.443 | `G > 0.570·(a+b) + 15.8 m` |
| **z, `K` = 0.222** | **`G > 2.133·(a+b) + 31.5 m`** |

**So two monuments each 100 m long need 244 real metres of clear ground between them, on the
north–south axis, before they clear in world space.** Real gaps in the Campus Martius are 15–120 m.
The overlap is not a placement mistake. It is arithmetic.

Measured over the 31 masonry monuments in `ROME` — 465 pairs, every centre at exactly
`worldOf(e, n)`, before the resolver runs: [MEAS]

- **34 pairs are closer than the 7 m street the code itself demands. 31 of those 34
  interpenetrate. 29 of the 34 are separate in reality.**
- The worst cases are spectacular. Real gap → world gap:

  | pair | real gap | world gap |
  |---|---:|---:|
  | Stadium of Domitian / Theatre of Pompey | **+273 m** | **−49.6 m** |
  | Forum Romanum / Palatine | +294 m | −29.4 m |
  | Colosseum / Caelian villas | +262 m | −17.0 m |
  | Baths of Nero / Theatre of Pompey | +188 m | −35.8 m |
  | Trajan's Market / Imperial fora | +103 m | −31.0 m |
  | Basilica Ulpia / Imperial fora | +71 m | −56.0 m |

  A 323-metre swing between two buildings a Roman could see across.

**The hypothesis in `MAP-METHOD.md` §2 is therefore confirmed, with one correction that matters:
the fault is anisotropic, and it is 4.5× worse north–south than east–west.** Any fix that treats it
as a single scalar will half-work. `MAP-METHOD.md` §2 has been updated.

Only **four** pairs still conflict when the footprint scale is dropped all the way to `KZ`, and all
four are **modelling faults, not projection faults** — they are nested or abutting complexes that
the survey models as free-standing boxes:

| pair | real gap | what it actually is |
|---|---:|---|
| Basilica Ulpia / Trajan's Column | −27 m | both stand **inside** Trajan's Forum |
| Ludus Magnus / Baths of Titus | −27 m | one dense terrace on the Oppian |
| Porticus Octaviae / Theatre of Marcellus | −49 m | they abut; the survey's boxes already overlap in reality |
| Pantheon / Baths of Agrippa | +18 m | one Agrippan insula-block |

That is the "remodel the landmarks" the owner raised, and §4.1 does it: **five merges.**

### 2.3 Fault 2 — the districts claim 266 % of the city, and that is the quilt

This one is not caused by `PLAN_SCALE` at all, and it is the fault that actually produced the
quilt the owner is looking at. [MEAS]

| | value |
|---|---|
| 17 districts, real footprint sum | **5.46 km²** |
| honestly projected (× `KX`, × `KZ`) | 0.54 km² — 9.8 % of real |
| **as coded** (× `KX`·2.05, × `KZ`·3.5) | **3.86 km² — 70.6 % of real, 7.17× the honest projection** |
| walled ground available in world space (≈1781 × 814 m) | **1.45 km²** |
| **districts as coded, as a fraction of available ground** | **266 %** |
| district/district overlapping pairs | **79** |
| ground double-claimed | **5.18 km²** — some of it claimed three and four times |

And `src/city/rome/layout.ts` contains two comments thirty lines apart that say opposite things:
the `DISTRICT_PLAN` docstring says *"Half-extents are scaled by the map as well, because a district
is an area of fabric rather than a building: compressing it is correct"*, and the code immediately
below inflates them 2.05× and 3.5× with the justification *"a district costs nothing where it
overlaps a neighbour (the plot grid gives the ground to whichever quarter is planned first)."*

**That sentence is the quilt, in the file's own words.** The consequences, all [SRC]:

- **Ground is allocated by planning order, not by plan.** `via-lata` — the Campus Martius, the
  quarter directly behind the assaulted gate — is planned fifth of seventeen and competes for the
  same hectares with `campus-augusti`, `campus-medius`, `quirinal` and `ripa-campi`.
- **Each district lays its own lattice in its own randomly rotated frame**, `±0.35 rad = ±20°`
  (`layout.ts:746`, `hash2`-seeded), with its own independent pitch jitter and phase
  (`fabric.ts:286–319`). Two adjacent blocks on either side of an invisible district boundary
  belong to different lattices at different angles with a random offset. **That is the definition
  of a quilt.** Compare Carthage's `CITY_BEARING = 0` plus a world-snapped lattice.
- **The districts then chase the resolver.** `nearbyDrift()` (`layout.ts:770–783`) pulls each
  district toward wherever the overlap resolver moved the nearest monuments. So the fabric's
  position is a function of a collision solve.
- The published symptom, from the boot log at `3595b48` and quoted in `ROME.md` §6.2: *"via-lata
  planned only 17 buildings from 593 frontages — the quarter is buried"* — **2.9 %.** `subura`
  4.1 %, `velabrum` 6.2 %.

### 2.4 Fault 3 — roads are drawn, then bent around the buildings

The build order is inverted relative to Carthage's. [SRC] `src/city/rome/layout.ts`, at module
evaluation:

1. `LANDMARKS = ROME.map(place)` — line 263
2. **`resolveOverlaps(LANDMARKS)`** — line 524, 9,000 damped Jacobi sweeps
3. `DISTRICTS`, each pulled by `nearbyDrift` toward the resolved monuments — line 705
4. `NAMED_WAYS` from `STREET_PLAN` — line 1078
5. `WAYS` — line 1418, and every way is passed through **`deflect()`** (`layout.ts:1329–1384`),
   which resamples it every 30 m and pushes its nodes *out of the monuments the resolver just
   moved*, with a 1.08 overshoot and 40 relax passes

So: monuments are placed, collided, and solved; districts follow the solution; **streets are then
bent around the result.** Carthage reserves the ways into the keep-out map before the fabric
generator runs and never moves them.

And **blocks never derive from roads at all.** Each district cuts a spine-and-rib lattice in its
own frame; the road armature enters only as a *rejection* input via `keepOut.blockedRect`. There is
no function anywhere in `src/city/rome/` that takes street geometry, forms the enclosed polygon and
subdivides it. The measured symptom, again from `ROME.md` §6.2: **271 of 1,134 ranked street samples
lie inside a monument — 24 % of ranked street length, and 80 % on the Via Recta**, the Campus
Martius's own east–west artery.

### 2.5 Fault 4 — nothing outside the generator has ever graded the fabric

This is the fault that let the other three survive, and it is `MAP-METHOD.md` rule 6. [SRC]

| instrument | what it compares against |
|---|---|
| `assertNoFootprintOverlaps` (`assertions.ts:38`) | `LANDMARKS` × `LANDMARKS`. **Never looks at an insula.** |
| `assertNoFabricOverlaps` (`src/city/layout.ts:376`) | monument rectangles × building rectangles — the same rectangles the generator published |
| `tools/scratch/city-audit.mjs` | re-imports `src/city/rome/layout.ts` and rebuilds `KeepOut` from `L.WAYS`, `L.LANDMARKS`, `L.PLAZAS` |
| `tools/scratch/free-land.mjs` | **re-implements `districtMask` by hand**, so it can agree with a stale copy of the thing it is grading |
| `src/city/plan.ts` (SVG plan view) | `LANDMARKS`, `DISTRICTS`, `STREETS` — the plan, not the scene |
| `shoot-city.mjs --shots=aerial` | *does* composite against the georeferenced Lanciani plate and the AGEA orthophoto — but the number it prints, `aerial.json`'s `drift`, is `hypot(x − idealX, z − idealZ)`: **the resolver's displacement from its own projection.** The comparison against the plate is by eye. |

**There is no automated instrument on this project that grades the built Rome fabric against
anything outside the generator.** Every check is the plan agreeing with itself. §4.4 is the answer.

### 2.6 What is *not* wrong, and must not be redone

Said plainly, because the owner's complaint is about the fabric and it would be easy to over-read
it.

- **The circuit is sound in method and should be kept.** `ROME_CIRCUIT_SURVEY`
  (`src/terrain/topography.ts:405–424`) is fourteen waypoints held in **survey metres** and
  projected through `worldOf` — exactly the pattern Carthage's document asks for and Carthage's own
  code fails to follow. `assertRomeSection` (`src/city/rome/assertions.ts:386`) grades the section
  sum, the bay count, both ends against the survey, the worst walk rake, bays below water level and
  the tower lane, and publishes faults on the output rather than logging them. That is better than
  anything in `carthageWall.ts`. **Keep all of it.**
  - The one real gap: `SURVEY_WEST` and `SURVEY_EAST` are restated as constants in
    `assertions.ts`, and **nothing anywhere checks the fourteen waypoints against the Lanciani
    raster.** That is a Phase 2 addition, not a rebuild.
- **The Tiber is sound.** Re-authored from a twelve-point projected polyline; survey error 775.8 m
  → 0.1 m. Keep the polyline.
- **`ROME`'s survey table is the best artefact on the map** and is the foundation of the rebuild:
  34 monuments with real `e`/`n` from cited lat/long, real `len`/`wid`, a measured `bearing` and a
  `cite` per row, several of which argue against their own earlier wrong values. **The rebuild
  extends this table; it does not replace it.**
- The road *ranks* (42/24/14/8) and the *fifteen named ways* are fine. The fault is what happens to
  them, not what they are.

**What has to be redone, and why:** `resolveOverlaps` + `TOPOLOGY` + `confine` + `separation`
(`layout.ts:194–522`, ~330 lines), `DISTRICTS` + `nearbyDrift` (`layout.ts:705–783`), `deflect` +
`monumentRings` + `feeders` (`layout.ts:1156–1384`), and `planDistrict` (`fabric.ts:254–647`). About
1,400 lines, all of it layout, none of it geometry. The reason is §2.2 and §2.3: they are the
machinery that turns a survey into a collision solve.

---

## 3. The reference material

Four plates added, three rejected. `reference/` is gitignored in full and carries
`.metadata_never_index`; "added" means placed in `reference/rome-plans/` and catalogued in
`ASSETS.md` — nothing ships and nothing is loaded at runtime. Full provenance, verbatim licence
text, byte counts and SHA-256 prefixes are in **`ASSETS.md` items 9–12**. Licence verification was
done on each file's own asset page before a byte was fetched; each download was held in memory and
written only after its leading magic bytes and its trailing container bytes both matched the
declared type. No PDF, no archive, no executable.

### 3.1 Added

| file | what it is | licence | what it is *for* |
|---|---|---|---|
| `shepherd-1923-plan-of-imperial-rome-350ad-2826px.jpg` | **"Plan of Imperial Rome (Superimposed on a plan of the modern city). Scale 1:25 000. Approximate date of the plan: 350 A.D."** — W. R. Shepherd, *Historical Atlas*, Henry Holt, 1911/1923-26, pl. 22. The owner's file, 2826 × 2158. | PD: author d. 1934, first US publication 1911, i.e. before 1 Jan 1930. Commons `{{PD-old-auto-expired}}` + `{{PD-mark}}`; UT Austin *"No permissions are needed to copy them."* Credit to University of Texas Libraries preserved in `ASSETS.md`. | **§4.1 and §4.2.** Every Aurelian gate named; all fourteen Augustan regions; the consular roads outside and the named streets inside (Alta Semita, Vicus Longus, Vicus Patricius, Subura, Clivus Suburanus, "Broad Way" = Via Lata); the aqueducts; every major monument at its own plan shape in yellow. **Over the modern street grid, with a scale bar.** |
| `shepherd-1911-plate22-rome-and-athens-full-1550px.jpg` | The complete plate: Imperial Rome, **Plan of Republican Rome** (the Servian circuit), Athens, the Acropolis. 1550 × 1932. | same | licence anchor, and the Servian plan the crop above only carries as a small inset |
| `kiepert-eb1911-plan-of-ancient-rome-2430px.jpg` | **"Plan of Ancient Rome"**, after Kiepert's *Formae Orbis Antiqui*, engr. Emery Walker, *Encyclopædia Britannica* 11th ed. vol. 23 (1911), fig. 7. Full-resolution replacement for the owner's 960 px thumbnail. | `{{PD-Britannica}}` — *"first published in the US … before January 1, 1931."* | **§4.1 dimensions.** The only new plate with a **metric** scale bar — and a second in *pedes Romani antiqui*. Colour-separates Republican from Imperial fabric, which is the §6.3 "state in 271" filter. Same volume and same author as the wall-section plate already in `reference/rome-aurelian/`. |
| `coldeel-2006-rome-14-regions-and-roads-1128px.png` | Clean diagram: the fourteen regions, the roads, the river, the Aurelian circuit, 0–1 km bar. Dutch labels. Commons original PNG, replacing the owner's rescaled WebP. | `{{PD-self}}` — *"released into the public domain by its author, ColdEel."* Edited by Joris1919, **the same contributor whose Muro Torto, Porta Pinciana and Castra Praetoria photographs are already in `reference/rome-aurelian/`.** | **§4.2 and §4.3.** The road armature **as a graph**: which consular road enters which gate, which internal street links which two regions, and — the thing nothing else in the pool gives — **where the fourteen regional boundaries run.** §4.3 uses those boundaries as the fabric's partition. |

**Measured scale of the Shepherd plate.** [MEAS] The yards bar spans 800 yd (731.5 m) in 348.3 px
and the stadia bar spans 4 stadia (740.0 m at 1 stadium = 625 Roman feet = 185.0 m) in 353.3 px:
**2.100 and 2.094 m per pixel, agreeing to 0.3 %.** So the file covers ≈ 5,935 × 4,532 m and
resolves the Pantheon's rotunda as 20 px. **Use it for completeness and for names, not for
dimensions** — the already-committed `lanciani-georef-EPSG3004-…-4096px.png` is 1.71 m/px with a
worst georeference residual of 1.26 m over 7 km and is the raster `src/city/overlay.ts` is fitted
to. The two are complementary: Lanciani for *where*, Shepherd for *what it is called and what else
is next to it*.

### 3.2 Rejected — and nobody should spend a second pass on these

- **`rome city map 200 ad.jpg` is not Rome. It is Roman *London*.** The Thames, Southwark,
  Ludgate, Newgate, Bishopsgate, Aldgate, the Cripplegate fort, the Walbrook, the Temple of
  Mithras, the governor's palace. It also carries **"© 1999 Encyclopædia Britannica, Inc."** burnt
  into the plate. Rejected on subject *and* on licence. **Do not georeference it, do not measure
  it, do not re-fetch it.**
- **`rome city map.webp` — not committed, cited as external reference only.** It is a colour German
  atlas plate, *"Die Stadt Rom / Rom zur Kaiserzeit"*, 1:30 000, sheet 33, with insets of the Forum
  Romanum at 1:4 000 and the Kaiserfora at 1:8 000. Almost certainly an edition of **F. W. Putzgers
  *Historischer Schul-Atlas*** (Velhagen & Klasing) — Commons' full-text index confirms Putzger
  carries a plate of that title — but **the edition, and therefore the date, could not be
  established**, and Putzger ran from 1877 into the present. The asset rule is binding: no
  established licence, no commit.

  This is a real loss and it is worth someone's half hour, because its legend is the single most
  useful thing in the whole set: it colour-codes fabric as Republican / Augustan / AD 14–250 / late
  antique — a ready-made "standing in 271" filter — **and it shades *"vermutlich bewohntes oder
  besiedeltes Stadtgebiet"*, probably-inhabited city area.** That is exactly the layer §4.3 needs
  and nothing else in the pool has it. To land it: find the plate on Commons or the Internet
  Archive with an edition date, confirm pre-1930 publication or author-life + 70, and fetch *that*
  copy through the usual check.
- **`rome city map 3.jpg` — not committed.** An untitled 500 × 432 crop of a modern illustrated
  map. No title, no scale, no legend, no creator, no attribution, and too small to measure anything
  from.

### 3.3 What the plates change about the plan

Not "we now have references" — the repo already had georeferenced Lanciani and SITAR vector data.
Three specific things:

1. **The regional boundaries become usable.** Neither Lanciani nor the orthophoto draws them; the
   ColdEel diagram and the Shepherd plate both do. §4.3 replaces seventeen overlapping rectangles
   with fourteen **tiling** polygons because of this.
2. **The named internal streets become a checkable list.** The Shepherd plate names Alta Semita,
   Vicus Longus, Vicus Patricius, the Subura, Clivus Suburanus, Argiletum and the Via Lata as
   drawn lines with endpoints. `STREET_PLAN` has fourteen ways; the plate supports at least twenty.
3. **Every gate gets a name and a road.** The northern front on this map is Flaminia, Pinciana,
   Salaria, Nomentana plus the Castra's Praetorian and Decuman gates, and the plate shows which
   consular road runs out of each — which is what §4.2 ranks.

---

## 4. The plan

### 4.1 Landmarks — the survey, in `CARTHAGE.md` §2.5's format

**The rule for this table: a row exists only if it carries a real coordinate, a real published plan
dimension, and a source.** No row may be added from memory. Where I could not verify a dimension
this pass it is tagged **[?]** and the first job of whoever builds it is to measure it off a named
plate.

`e`/`n` are metres east/north of the Temple of Jupiter OM, 41.8925 N 12.4823 E, and are taken from
`src/city/rome/survey.ts`, whose per-row `cite` field carries the lat/long each was derived from.
**`x` is unchanged by anything in this document** (`KX` = 0.443 stays — §4.5). Two `z` columns are
given: `z₂₂₂` at today's `KZ` = 0.222, and **`z₃₅₀` at the recommended `KZ` = 0.35**. A ⚠︎ marks a
row that falls off the +Z edge at `KZ` = 0.35 and becomes off-field backdrop.

#### The circuit and the frame

| feature | e | n | **x** | z₂₂₂ | **z₃₅₀** | real plan, m | source |
|---|---:|---:|---:|---:|---:|---|---|
| Temple of Jupiter OM (origin) | 0 | 0 | **292** | 984 | **1245** | podium 63 × 53 | 41.8925 N 12.4823 E; survey.ts |
| Circuit: NW angle, Tiber left bank | −655 | 2006 | **+2** | 538 | **543** | — | `ROME_CIRCUIT_SURVEY`; Lanciani georef |
| **Porta Flaminia** | −497 | 2045 | **+72** | 530 | **530** | aperture 4.20 m clear | `GATE_X`/`GATE_Z` fixed point; Shepherd pl. 22 "Flaminian Gate" |
| Muro Torto, west foot | −273 | 2039 | **+171** | 531 | **534** | — | Piranesi 1756 tav. XI |
| Muro Torto, east / Pincio crest | +273 | 1928 | **+413** | 556 | **571** | — | ditto |
| **Porta Pinciana** | +530 | 1789 | **+527** | 587 | **620** | — | Shepherd pl. 22 "Pincian Gate" |
| **Porta Salaria** | +1036 | 1784 | **+751** | 588 | **621** | — | Shepherd pl. 22 "Salarian Gate" |
| **Porta Nomentana** | +1831 | 1784 | **+1103** | 588 | **621** | — | Shepherd pl. 22 "Nomentan Gate" |
| Castra Praetoria, NW angle | +1931 | 1711 | **+1147** | 604 | **647** | — | Piranesi 1756 tav. XXXIX |
| **Castra Praetoria, NE angle** | +2353 | 1578 | **+1335** | 633 | **693** | — | east anchor; `SURVEY_EAST` |

#### The Campus Martius — the fought-in city

| monument | e | n | **x** | z₂₂₂ | **z₃₅₀** | real plan, m | source |
|---|---:|---:|---:|---:|---:|---|---|
| **Mausoleum of Augustus** | −481 | 1500 | **+79** | 651 | **720** | **87 m diameter** (= 300 *pedes*); travertine socle 89 m; pavement 120 × 120; **c. 45 m** high | Platner & Ashby; ROME.md §6.3 |
| **Ara Pacis** (original site) | −315 | 1278 | **+153** | 700 | **798** | enclosure **11.625 × 10.55**, walls c. 6 m | P&A; ROME.md §6.3 |
| **Horologium Augusti** | −323 | 1011 | **+149** | 759 | **892** | meridian pavement **160 × 75** (Buchner) or **110 × 60** (P&A); obelisk shaft 21.79 m, gnomon 29.60 m | ROME.md §6.3 |
| **Stadium of Domitian** | −762 | 745 | **−45** | 818 | **985** | **275 × 106**; arena c. 250 m | P&A; Shepherd pl. 22 |
| **Baths of Nero / Alexandrinae** | −560 | 620 | **+44** | 846 | **1028** | **c. 190 × 120**, fronting north | ROME.md §6.3 |
| **Pantheon** | −447 | 678 | **+94** | 833 | **1008** | rotunda **43.30 m** interior dia.; drum ext. c. 58 m; portico **34 × 13.60**; overall with forecourt **84 × 58** | ROME.md §6.3; survey.ts |
| **Baths of Agrippa** | −423 | 556 | **+105** | 860 | **1051** | **c. 100–120 × 80–100**; circular hall c. 25 m dia. | ROME.md §6.3 |
| **Iseum et Serapeum Campense** | −300 | 560 | **+159** | 859 | **1049** | **c. 200 × 50** (DAR) or **240 × 60**. *The shipped `temple-isis` is 70 × 34 and is too small by a factor of three* | ROME.md §6.3 — **known-wrong in the tree** |
| **Temples of the Area Sacra** (Largo Argentina) | −464 | 333 | **+87** | 910 | **1129** | precinct c. **90 × 60**; A podium 15 × 27.5; D podium 23.5 × 37 | Severan Marble Plan; ROME.md §6.3 |
| **Theatre of Pompey** | −836 | 244 | **−78** | 930 | **1160** | cavea **156.80 m** dia. (Packer 2014); orchestra 44 m; *scaena* c. 95 m. **With the Porticus Pompei (180 × 135) the complex is c. 300 × 180** | ROME.md §6.3 |
| **Porticus Octaviae** | −300 | −60 | **+159** | 997 | **1266** | quadriportico **119 × 132** | ROME.md §6.3 |
| **Theatre of Marcellus** | −215 | −78 | **+197** | 1001 | **1273** | external dia. **129.80**, façade **32.60 m** high, 41 arches | ROME.md §6.3 |
**Six monuments missing from the tree.** `ROME.md` §6.3 publishes these as **world x/z at today's
`KZ`**, from an independent gazetteer, so their `e`/`n` are blank until Phase 2 back-converts them
(see † below). They are listed with the world coordinates as published, so the note is checkable:

| monument | x † | z₂₂₂ † | real plan, m | source and why it matters |
|---|---:|---:|---|---|
| **Saepta Iulia** | 212 | 870 | enclosure **c. 310 × 120**; pier hall 400 × 60 with piers 1.70 m sq. at 4 m centres | Severan Plan; P&A. **The largest omission on the map** — 3.7 ha of colonnaded hall directly on the Via Lata, on the gate's axis. A break-in arrives at it. |
| **Porticus Pompei** | 10 | 914 | **180 × 135**, four rows of columns, a double grove of plane trees | Severan Plan. **Undamaged in 271** while the theatre beside it is a burnt ruin from 247 — free drama |
| **Porticus Divorum** | 226 | 890 | **c. 200 × 55**, thirty-plus columns a side | Regionaries |
| **Diribitorium** | 208 | 905 | roof beams **30 m** — the largest single-roofed building in Rome | **a roofless shell for 191 years** since the fire of 80 |
| **Circus Flaminius** | 98 | 1003 | c. **260 × 100** — and **not a circus**: no stands, no barrier | a paved, encroached piazza, and the only large open ground inside the walls on the map's south half |
| **Theatre of Balbus / Crypta Balbi** | 105 | 959 | cavea c. **95 m** (Sear 2006); complex c. 1 ha | **the one excavated lived-in quarter on this map** — a bakery, a Mithraeum, a *fullonica* |
| **Hadrianeum** | 185 | 798 | eleven columns 15 m high, 1.44 m dia.; precinct **[?]** | standing; the columns are still there today |

† The gazetteer is authored on the Pantheon rotunda's centre (41.898616 N 12.476833 E) and is
**independent of `survey.ts`** — the two agree to **6 metres** on the Pantheon and 2 m on the Porta
Flaminia, which is better than the resolver's own resolution. **The x/z above must be back-converted
to `e`/`n` before use**, so that they project like every other row instead of being hand-typed world
coordinates — which is Carthage's mistake (§1.3). Inverting `worldOf` is one line. Do it in Phase 2,
not later, and do not shortcut it: a hand-typed world coordinate cannot be re-projected when `KZ`
changes, and `KZ` is changing.

#### The Capitol, the fora, and the seen city

| monument | e | n | **x** | z₂₂₂ | **z₃₅₀** | real plan, m | source |
|---|---:|---:|---:|---:|---:|---|---|
| **Capitolium** (merge: Temple of Jupiter + Tabularium) | +25 | +15 | **+303** | 981 | **1240** | temple podium **63 × 53**; Tabularium frontage **73 × 34**; merged precinct **120 × 90** | §2.2 — the Tabularium is built into the saddle *below* the temple platform |
| **Forum Romanum** | +249 | 0 | **+402** | 984 | **1245** | open area c. **200 × 90** | Lanciani tav. 29 |
| **Imperial fora** (merge: Fora + Basilica Ulpia + Column + Markets) | +262 | +290 | **+408** | 919 | **1105** | Caesar 160 × 75; Augustus 125 × 90; Pacis 145 × 100; Nerva 120 × 45; Trajan 300 × 185 incl. Basilica Ulpia 130 × 55; **merged complex c. 380 × 230** | P&A; §2.2 — the Basilica and the Column stand *inside* Trajan's Forum |
| **Temple of Serapis, Quirinal** | +381 | +645 | **+461** | 841 | **1020** | **135 × 98** | survey.ts |
| **Flavian Amphitheatre (Colosseum)** | +820 | −256 | **+655** | 1041 | **1335** | **189 × 156** external; arena 87 × 55; **48.5 m** high; major axis 115° from a least-squares fit to the surviving plan | survey.ts `cite`; Shepherd pl. 22 |
| **Ludus Magnus** | +990 | −215 | **+731** | 1031 | **1321** | c. **135 × 100**; arena 62 × 45 | survey.ts |
| **Oppian baths** (merge: Titus + Trajan) | +1040 | 0 | **+753** | 984 | **1245** | Titus c. **120 × 105**; Trajan **[?]** — survey has 230 × 170, published figures run to a 330 × 340 precinct; **merged c. 300 × 200** | **measure off Kiepert's metric bar in Phase 2** |
| **Tiber Island** | −365 | −189 | **+130** | 1026 | **1312** | **270 × 67** — *not* the 446 × 116 of the modern outline | survey.ts `cite` |
| **Mausoleum of Hadrian** | −1326 | 1178 | **−295** | 722 | **833** | podium **84 m square, 10 m high**; drum **64 m dia., 21 m high**; tomb chamber 9 × 8 | ROME.md §6.3. **Outside the circuit in 271** — Procopius V.22.12–13 |
| **Castra Praetoria** | +1939 | 1467 | **+1151** | 658 | **732** | real **437 × 377**; survey uses 400 × 377 | Piranesi tav. XXXIX; survey.ts |
| **Horti Sallustiani** (`soft`) | +887 | 1612 | **+685** | 626 | **681** | **250 × 170** | survey.ts |

#### The backdrop — and what `KZ` = 0.35 costs

| monument | e | n | **x** | z₂₂₂ | **z₃₅₀** | real plan, m | source |
|---|---:|---:|---:|---:|---:|---|---|
| **Palatine** | +381 | −422 | **+461** | 1077 | **1393 ⚠︎** | 230 × 190 | survey.ts |
| **Circus Maximus** | +249 | −733 | **+402** | 1146 | **1502 ⚠︎** | **621 × 190** overall; track 621 × 118; long axis 120°, measured 119° off the Lanciani plate | Humphrey, *Roman Circuses* (1986), 56–131 |
| **Aventine temples** | −274 | −944 | **+171** | 1193 | **1576 ⚠︎** | 150 × 110 | survey.ts |
| **Baths of Caracalla** | +845 | −1500 | **+667** | 1317 | **1770 ⚠︎** | bathing block **218 × 112**; precinct **337 × 328** | survey.ts; P&A |
| **Caelian villas** | +887 | −667 | **+685** | 1132 | **1479 ⚠︎** | 150 × 110 | survey.ts |
| **Janiculum ridge** (`soft`) | −1599 | −389 | **−416** | 1070 | **1382 ⚠︎** | 520 × 240 | survey.ts |

#### Two monuments the brief asked for that must NOT be drawn

- **The Baths of Diocletian do not exist in 271.** Begun **298**, dedicated 305–306 — 27 to 35
  years *after* this map. `survey.ts:402–404` already records the deliberate omission. The
  Shepherd plate is dated c. 350 AD and draws them at full size on the Viminal; **that is the one
  place where the best new plate is wrong for our date.** Anyone georeferencing off Shepherd must
  apply the Kiepert plate's Republican/Imperial colour separation, or `ROME.md` §6.3's
  monument-by-monument state, as a date filter. Same for the Baths of Constantine, the Basilica of
  Maxentius, and the Arch of Constantine.
- **The Stagnum Agrippae must not be drawn as open water.** No source attests it after Nero and it
  is absent from the Regionaries. `ROME.md` §6.3 and §7.2.

#### Sanity checks that must hold **after** the build

Following `CARTHAGE.md` §2.5. These are not aspirations; §4.4 names the probe that measures each.

1. attacker deployment (z −196) to the Porta Flaminia (z 530) = **726 m of approach**, unchanged at
   any `KZ`, because `GATE_Z` is the fixed point of `x = roadCentreX(crestZAt(x))` and does not
   depend on `KZ`; [DER]
2. modelled front, NW angle to Castra NE: x +2 → +1335 = **1,333 world metres**, unchanged, because
   `KX` is unchanged; **36 bays at 37.015 m**; [DER]
3. **Campus Martius depth**, the Porta Flaminia to the Capitolium: **716 world metres** at
   `KZ` = 0.35, against **454 m** today — **+58 %**; [MEAS]
4. **zero intersecting footprint pairs** and **minimum clear gap ≥ 7.0 m** over *every* solid,
   monuments and insulae together; [MEAS]
5. every monument centre within **0.5 m** of `worldOf(e, n)`; every footprint within **0.25 m** of
   its authored size; [MEAS]
6. roof coverage between street lines **60–70 %**, the figure the AGEA orthophoto gives for the
   historic core; [MEAS]
7. the Campus Martius quarter builds **≥ 60 % of its frontages**, against today's **2.9 %**. [MEAS]

### 4.2 Roads — ranked, as `CARTHAGE.md` §7.2 does it

Carthage's §7.2 exists to say *"this is where the analogy to Rome breaks, and it breaks hard"* and
to state the game compromise in the same breath as the evidence. Rome's ranks are already right and
already honest — `layout.ts:863–873` concedes that a real *via* is about 4.8 m and that 42 is a
compromise so a 35 m cohort can move. **Keep the four ranks. Add a fifth and a sixth, and fix the
membership.**

| rank | width | reserved band | who gets it | authority |
|---|---:|---:|---|---|
| **processional** | **42 m** | 62 m | **Via Lata only** — the Via Flaminia inside the walls, dead straight from the Porta Flaminia to the foot of the Capitol, porticoed both sides. | [GAME]. A cohort in line is 35 m; this is the game's minimum for a formed unit, and it is *one* street, not five. The Via Lata really did run between continuous porticoes. |
| **consular** | **24 m** | 34 m | Outside the wall: **Via Flaminia, Via Salaria, Via Nomentana, Via Pinciana**, one per gate. Inside: **Alta Semita** (the Quirinal ridge), **Via Recta** (the Campus Martius's east–west artery), **Via Sacra**. | [GAME] anchored on the Via Lata's real c. 12 m, doubled. Named on Shepherd pl. 22. |
| **local** | **14 m** | 19 m | **Vicus Longus**, **Vicus Patricius**, **Clivus Suburanus**, **Argiletum**, **Vicus Iugarius**, **Vicus Tuscus**, **Via Tecta**, **Clivus Capitolinus**, the **Subura** itself. | [MOD] real *vici* 4.8–6 m, doubled and a bit. All nine are drawn and named on Shepherd pl. 22. |
| **vicus** | **8 m** | 11 m | **The grid's own cross-lanes** — every line §4.3 derives, several hundred of them. | [MOD], near the real 4.8 m. *A formation cannot use it, and that is the point.* |
| **pomerium way** | **42 m** | — | The `via sagularis` behind the curtain. `POMERIUM = 60` is 20 m lateral corridor + 25 m to form facing a breach + 15 m slack. | [GAME], already in the tree, unchanged |
| **clivus** | **14 m**, stepped | 19 m | Any way on a built grade over 1:8 — the Capitoline approaches, the Quirinal scarp. Risers quantised to 0.17 m, as Carthage's stepped streets are. | [GAME] from [ARCH]; Carthage `streets.ts` already does this |

**Two membership changes and one addition, all from the plates:**

1. **Demote four ways.** `STREET_PLAN` currently ranks `via-appia`, `via-triumphalis` and
   `via-sacra` as `artery` at 42 m alongside `via-lata`. On this map the Via Appia and the Via
   Triumphalis are backdrop; at 42 m they are four cohort-wide corridors where the history has one.
   Drop them to `consular`. That is 3 × 20 m × their length of ground handed back to the fabric.
2. **Add the six ways the plates name and the tree lacks:** Clivus Suburanus, Argiletum, Via Tecta,
   Clivus Capitolinus, the Subura's own line, and the Via Pinciana. All six are drawn on Shepherd
   pl. 22 with endpoints.
3. **Every gate's inner mouth must land on a way of rank `consular` or better**, and that is an
   assertion, not a hope (§4.4). Today the Porta Flaminia's does — `layout.ts:1096–1107` pins the
   Via Lata's first node to `GATE_X`. Pinciana, Salaria and Nomentana do not.

**And the order, which is the whole point:** the ranked ways are **authored in survey metres,
projected once, and reserved into the keep-out map before any block exists.** They are never
`deflect`ed. If a way runs through a monument, **the way wins and the monument's authored footprint
is the thing that changes** — because the way is a line the city was organised around and the
monument's footprint is a number in a table. That inverts today's behaviour exactly.

### 4.3 The grid — blocks as faces of the road graph

The step Rome has never had. Six operations, in order, each with an output another agent can check.

**1. Close the armature into a planar graph.** Project every ranked way through `worldOf`. Add the
regional boundaries from `coldeel-2006-…-1128px.png` and Shepherd pl. 22, traced as polylines in
survey metres, as graph edges of rank `vicus` where they do not coincide with a named way — real
regional boundaries *ran along streets*, so most will coincide, and the ones that do not are streets
the plate draws and we have not named. Add the pomerium way and the wall's inner face. **Output: a
planar graph, and an assertion that it has exactly one connected component with no dangling ends
inside the circuit.**

**2. Insert the grid's own cross-lanes, derived from the module.** For each pair of adjacent
armature edges bounding an unsubdivided region, insert `vicus`-rank lines perpendicular to the
local mean street direction at the module pitch (below). **Output: a finer planar graph.**

**3. Take the graph's faces. Those are the blocks.** Not rectangles laid over the streets — the
actual enclosed polygons. This is the one line in this document that most changes the result,
because it makes a block's **orientation a property of the streets that bound it** rather than of
`hash2(round(d.e), round(d.n), 0x5c1)`.

**4. Inset each face** by `WAY_FRONTAGE[rank]` for each bounding edge's own rank. If the inset
polygon's minimum width falls below `MIN_DEPTH = 9 m`, the face is **not a block**: it is a plaza,
a court, or a street widening. Declare it so and pave it. Rome has fourteen `PLAZAS` today, capped
at `PLAZA_CAP = 14` and found by clustering way junctions; under this scheme plazas are found by the
same operation that finds blocks, and the cap goes away.

**5. Subdivide each inset face into insulae on the module, longest-edge-first, in the face's own
frame.** Carthage's `fitFace` discipline applies verbatim: **quantise the frontage to a plot and
never trim the depth**, because a Roman insula's defining property is a street door and a back door.

**6. Only now reject against monuments**, and expect to reject almost nothing, because the
monuments were reserved into the keep-out map at step 1 of the *build* and the ways were routed
around them at authoring time.

#### The module, and the arithmetic that says the grid step is possible

`ROME.md` §6.4's measured module, which stays: **insula 30 × 45 m = 100 × 152 *pedes***, 1–3 light
wells of 8–14 m per block, storey 3.15 m on a 4.3 m ground floor, 4–5 storeys capped at the
Augustan 70 *pedes* = 20.7 m. The *pes monetalis* of 0.296 m is taken from metrology, **not** from
the Severan Plan — `tools/scratch/rome-fur-grain.mjs` tested 144,296 interior segments and the
digitiser's own metre grid dominates (χ² 181 against 0.296 m, 1,450 against a 1.000 m control).
Record that negative; do not repeat the test.

Now the number that decides everything. Real cross-street pitch in the Campus Martius is **50–90 m**
(median interior segment 0.72 m, p90 3.45 m on the Severan Plan — a dense line drawing of small
rooms, with block faces at that scale). Projected into world z:

| | `KZ` = 0.222 (today) | **`KZ` = 0.35 (recommended)** |
|---|---|---|
| real 50–90 m cross-street pitch becomes | **11.1 – 20.0 world m** | **17.5 – 31.5 world m** |
| an insula at true depth needs | 22 m (`INSULA_DEPTH_MAX`) + 2 × frontage | same |
| **does a true-scale insula fit between two projected cross-streets?** | **No. Not at any point in the range.** | **Yes, over the upper half of the range.** |

**That is the arithmetic that makes the grid step possible at all**, and it is the strongest single
argument in this document for §4.5. At `KZ` = 0.222 a generator that derives blocks from projected
streets is *forced* to drop two of every three cross-streets and then put one 22 m building in a
60 m gap — which is precisely the blobs-between-voids reading the owner is objecting to, arrived at
honestly. At `KZ` = 0.35 the same generator produces a street front.

#### Districts become regiones, and regiones tile

**Delete `DISTRICT_PLAN`'s seventeen rectangles and `nearbyDrift` entirely.** Replace them with the
**fourteen Augustan regions as polygons**, traced from `coldeel-2006-…-1128px.png` and Shepherd
pl. 22 in survey metres. The reason is one word: **regions are a partition.** Seventeen rectangles
claiming 266 % of the ground with 79 overlapping pairs cannot be made to tile by tuning; fourteen
regional polygons tile by construction, because that is what an administrative division is.

And the regions carry **attributes, not extents**: `density`, `minFloors`/`maxFloors`, `grandeur`,
`fray`, and a `terrain` class. Extents come from the road graph's faces. A block's character is
looked up from the region it falls in; its geometry comes from the streets. That separation is the
whole fix.

Region character, from `ROME.md` §6.3–6.5 and the plates:

| regio | character | density | storeys | class |
|---|---|---|---|---|
| VII Via Lata | the fought-in quarter, dense fabric between monuments, porticoed arteries | 0.84 | 3–5 | city |
| IX Circus Flaminius | monumental, the Campus Martius proper | 0.80 | 3–5 | city |
| VI Alta Semita | the Quirinal ridge and the Horti behind the Pinciana | 0.55 | 2–4 | **horti** north of the Alta Semita, city south |
| IV Templum Pacis / the Subura | the tenement valley | 0.94 | 4–6 | city |
| V Esquiliae, II Caelimontium, XIII Aventinus | quiet and grand, gardens and villa ranges | 0.56 | 2–4 | city + horti |
| the northern strip inside the wall, Pincian → Castra | **imperial *horti*** — terraces, retaining walls, planted avenues, boundary walls 1.5–2.5 m on a 50–90 m grid, **~6 % building coverage** | — | 1–2 | **horti** |

`ROME.md` §6.5 already makes the case for the *horti* as Rome's Megara and the survey already
carries one of them (`gardens-sallust`, `soft`). **Build it as a third terrain class**, exactly as
Carthage's §7.7 Megara is built: *"scatter and low walls, not buildings."* An attacker over the wall
at the Porta Pinciana arrives in somebody's garden, on terraces, with a wall every seventy metres.
It is also cheap, which matters, because the draw budget is 220 whole-frame and boot measures 192.

### 4.4 The overlap rule, and the instrument that measures it

**The invariant, stated so it can be falsified:**

> **No two solid footprints intersect, and every monument has at least 7.0 metres of clear ground
> on every side.** The population is *every* solid — monuments, insulae, warehouses, aqueduct piers,
> the wall's own footprint — and the measurement is taken on the oriented boxes the **scene**
> publishes, not on the plan that generated them.

Three clauses in that sentence are load-bearing and each closes a specific failure this project has
already paid for:

- *"every solid"* — Carthage's check #2 covers monuments, houses, quays, moles and the harbour water
  as chords, with no upper escape hatch, because an earlier `> 40 m` skip hid a real 46 m
  warehouse/mole overlap. Rome's `assertNoFootprintOverlaps` **never looks at an insula.**
- *"at least 7.0 m"* — a bare non-intersection test passes on two buildings sharing a wall face,
  which is fine for insulae and wrong for monuments. State the two allowances separately:
  `PARTY_GAP = 0.35 m` between insulae in the same block, `STREET_GAP = 7.0 m` around a monument.
- *"the scene publishes"* — `CitySystem.getObstacles()`, read back after the bake. `SIEGE.md` §5.2's
  rule: *measure the thing the picture is claiming, in the representation that has to act on it.*

**The instrument: `tools/probe-romefabric.mjs`.** This project's recurring failure is a check that
compares something against itself, so here is exactly what each of its six checks compares against,
and why that reference is **outside** the thing being checked.

| check | measures | compares against — and why it is external |
|---|---|---|
| **1. interpenetration** | every pair of solids from `CitySystem.getObstacles()`, broad-phased on a 60 m grid | **the geometry, not the plan.** The obstacles are read back from the baked scene. If a builder draws a mesh wider than its declared footprint, this catches it and `assertNoFootprintOverlaps` does not. Allowance 0.35 m insula/insula, 7.0 m anything/monument. **No upper escape hatch** — the 40 m skip that hid Carthage's warehouse overlap must not be reinvented. |
| **2. survey fidelity** | each built monument's centre and world extents | **the published dimension in the `cite` field, not the placement code.** Assert `centre == worldOf(e, n)` to 0.5 m, and `extent == real × authoredScale` to 0.25 m. This is what makes an authored footprint (§4.5) auditable instead of a free parameter: the *departure* is declared per row and the probe checks the departure, not the result. |
| **3. plate containment** | each monument's built centre | **the georeferenced Lanciani raster.** `src/city/overlay.ts` already carries the pixel→survey affine, fitted to a worst residual of **1.26 m over 7 km**. Sample the plate at each monument's centre and assert the pixel is inside the inked polygon for that monument. **This is the only check whose reference is not code at all.** It is also the check that would have caught the Roman-London plate if anyone had georeferenced it. |
| **4. roof coverage** | built roof area as a fraction of the area between street lines, on a 6 m grid | **the AGEA 2012 50 cm orthophoto's 60–70 % for the historic core.** A distribution, per region, not one city-wide number — a city-wide number can be hit by building the Esquiline and burying the Campus Martius, which is what happened. |
| **5. grain** | histogram of block orientation, and the patch size over which orientation holds | **the orthophoto's own histogram.** Real Rome's grain holds over 150–400 m patches and then rotates 15–40°. Assert the built distribution's patch size and rotation match within a stated tolerance. This is the check that fails on a quilt and passes on a city, and there is nothing else that can tell the two apart. |
| **6. blocks are faces** | each block's centroid and orientation | **the road graph, which is upstream of the block generator.** Assert each centroid lies in exactly one face, that the block's orientation is within 5° of that face's longest inset edge, and that **no block straddles a road centreline.** If blocks are not faces of the graph, §4.3 was not implemented however good the pictures look. |

**Three things the probe must not do**, because two existing tools do them:

1. **It must not re-import `fabric.ts`.** `tools/scratch/free-land.mjs` re-implements `districtMask`
   by hand and can therefore agree with a stale copy of the thing it grades.
2. **It must not report the resolver's own displacement as its error.** `aerial.json`'s `drift` is
   `hypot(x − idealX, z − idealZ)` — the distance from the plan to itself.
3. **It must not compare a target restated in its own file to a value computed in its own file.**
   Where a target has to be written down — 7.0 m, 60–70 %, 5° — the *left* side must come from the
   scene or the plate.

**And it must run in CI-shaped form from day one, before there is anything for it to pass.** A probe
written after the fabric is built grades a fait accompli.

### 4.5 Resizing, remodelling, and the projection — the recommendation

The owner raised this directly: *"you may have to also remodel potentially some of the land marks in
order to just make sure they fit. perhaps resize them."* He is right, and the answer has three
parts. All numbers [MEAS].

#### First: which levers exist, and which are already at their stop

**`KX` cannot rise.** `GATE_X` is pinned at +72 by the fixed point of
`x = roadCentreX(crestZAt(x))`, and the front runs from the Tiber angle (`e` −655) to the Castra's
NE angle (`e` +2353) — 3,008 real metres.

| `KX` | west end | east end | |
|---:|---:|---:|---|
| **0.443** | **+2** | **+1335** | fits, 65 m of headroom |
| 0.466 | −2 | **+1400** | **exactly on the map edge** |
| 0.500 | −7 | +1497 | off the map |

**So the east–west compression is within 5 % of its hard ceiling and there is nothing to win
there.** `ROME.md` §2.3's first argument for keeping the projection — the `KX` anchor pair — is
therefore not merely preserved by this recommendation, it is *unarguable*: `KX` stays at 0.443
because it cannot be anything else.

**`KZ` can rise, but only by giving up southern extent.** `GATE_Z` = 529.746 is likewise pinned and
does not depend on `KZ`, so the 726 m approach is invariant. What moves is the +Z edge:

| `KZ` | anisotropy | south edge at survey `n` | monuments off the +Z edge |
|---:|---:|---:|---|
| **0.222** (today) | 2.00× | −1758 | none |
| 0.26 | 1.70× | −1202 | Caracalla |
| 0.30 | 1.48× | −769 | Circus Maximus, Aventine temples, Caracalla |
| **0.35** | **1.27×** | **−367** | Palatine, Circus Maximus, Aventine temples, Caracalla, Caelian villas *(+ the Janiculum ridge at z 1382)* |
| 0.38 | 1.17× | +66 | the above **plus the Colosseum and the Ludus Magnus** |
| 0.413 | 1.07× | +1 | the above **plus the Forum Romanum, the Capitolium, the Oppian baths, the Porticus Octaviae and the Theatre of Marcellus** |

#### Second: no single footprint scale works, and here is the proof

Conflicting pairs — reserved boxes closer than the 7 m street the code demands — with **every
monument frozen at exactly `worldOf(e, n)`** and the five §4.1 merges applied:

| `KZ` | on-map | `PS` 0.65 | `PS` 0.80 | `PS` 1.00 |
|---:|---:|---:|---:|---:|
| 0.222 | 24 | 22 | 32 | 48 |
| 0.30 | 21 | 17 | 21 | 33 |
| **0.35** | 19 | **13** | 17 | 23 |
| 0.38 | 17 | 8 | 13 | 18 |
| 0.413 | 13 | 3 | 8 | 10 |

And the options priced individually, all measured:

| option | conflicts | what it costs |
|---|---:|---|
| `PLAN_SCALE` 0.65 + `resolveOverlaps` (today) | 34 pairs; resolver moves monuments 43 m mean, 130 m worst | the current map. Ruled out by the owner. |
| **largest uniform scale with zero conflicts** | **0** | **`PLAN_SCALE` = 0.232.** Colosseum 44 × 36 m, Pantheon 19 × 13 m, Circus 143 × 44 m. Monumental load 2.7 %. **A 44 m Colosseum at 48 m height is a tower, not an amphitheatre.** |
| anisotropic footprint scale, `(KX, KZ)` in world axes | 15 | **every round building squashed 2.00:1.** Mausoleum of Augustus 39 × 19 m; the Horologium, Trajan's Column, both Mausolea and the Pantheon's drum all become ellipses. |
| true footprints (`PS` 1.00) + cull to a non-conflicting set | 0 | **a maximal set of 11 monuments out of 25.** The cull drops the Colosseum, the Pantheon, the Forum Romanum and the Capitol. Those *are* Rome. |
| raise `KZ` alone | never 0 | even at `KZ` = 0.413, where the map is within 7 % of isotropic, **3 pairs still conflict at `PS` 0.65 and 10 at `PS` 1.00** — and that is with 14 of 34 monuments already pushed off the +Z edge. The Campus Martius's real monument *density* is high enough to defeat a near-isotropic frame. |

**Conclusion: within a 2800 m map and one affine projection, Rome's monumental core cannot be hosted
at true footprint by any combination of `KX`, `KZ` and a single `PLAN_SCALE`. Some footprint
compression is mandatory. The design question is only how much, and where it is declared.**

*And one number should not be misread, because `layout.ts:120` is easy to quote wrongly.* The 34
monuments come to **72.6 ha of true plan** against a buildable world city of about **145 ha** — so
"the monuments are half of Rome" is a statement about **the compression**, not about the real city,
where the same buildings covered about 5 % of the walled area. The real Campus Martius was dense,
but it was not half-built-over. What defeats a near-isotropic frame is not that Rome was solid
masonry; it is that in the 466-to-716 world metres the projection allots the Campus Martius, twelve
of the survey's monuments are stacked into one band.

#### Third: the recommendation

> **Raise `KZ` from 0.222 to 0.35. Keep `KX` = 0.443, keep the origin, keep the survey frame, keep
> the georeference. Abolish the single global `PLAN_SCALE` and replace it with a per-monument
> authored world footprint, held in the survey table beside the real published dimension it
> departs from, seeded at 0.65 of the real plan and adjusted only where the probe says a pair
> conflicts. Merge the five nested complexes of §4.1. Delete `resolveOverlaps`.**

What that buys:

| | today | recommended |
|---|---|---|
| anisotropy | 2.00× | **1.27×** |
| Campus Martius depth, gate → Capitolium | 454 world m | **716 world m (+58 %)** |
| projected cross-street pitch | 11–20 m | **17.5–31.5 m** — a true-scale insula fits |
| conflicting pairs at 0.65, after merges | 22 | **13**, and each one is a named authored exception |
| gradient steepening across the wall | 1/`KZ` = 4.50× | **2.86×** |
| `worldRot`'s `ROT_RATIO = 1.45` bearing correction | required | **deletable** — bearings need almost no correction at 1.27× |
| approach distance | 726 m | **726 m**, unchanged |
| front length, bay count, bay pitch, `SURVEY_WEST`/`SURVEY_EAST` | 1,333 m / 36 / 37.015 m / +2, +1335 | **all unchanged**, because `KX` is unchanged |

What it costs, stated plainly: **five monuments and one ridge fall off the +Z edge** — the Palatine,
the Circus Maximus, the Aventine temples, the Baths of Caracalla, the Caelian villas, the Janiculum.
The Colosseum, the Ludus Magnus, the Oppian baths, the Forum Romanum, the Capitolium, the Theatre of
Marcellus and the Tiber Island all survive. **The five are all 700–800 world metres behind the wall,
in `ROME.md` §6.1's "backdrop" zone, and none of them is fought over.** Whether they can be carried
as off-field silhouette geometry beyond z 1374 is **[?]** — `HALF_EXTENT` bounds the heightfield and
`assertNoStrayGeometry` polices a *minimum* z, not a maximum, so it is probably possible, but it is
unverified and Phase 0 must verify it rather than assume it.

#### Answering `ROME.md` §2.3, argument by argument

§2.3 argues hard for keeping the projection. It makes three arguments and this recommendation has to
meet all three rather than ignore them.

1. *"`KX` was derived from an anchor pair and the redesign strengthens that anchor."* — **`KX` is
   not changing.** The argument is preserved intact, and §4.5's first table shows it could not
   change even if we wanted it to.

2. *"`KZ` = 0.222 is `KE` at Carthage to three figures. Anisotropy is 2.00× at Rome and 2.05× at
   Carthage. A player's sense of distance transfers between the two maps and that property is worth
   more than any improvement a re-fit could buy."* — **This is the real cost and it is the one
   argument I am overriding.** Three reasons:
   - The transfer buys a player's *intuition about distance*. The anisotropy costs **a city that
     cannot be laid out** — §4.3's insula arithmetic. An intuition is worth less than a fabric.
   - The transfer is **not clean today anyway.** Carthage authors its monument footprints as
     hand-typed world half-extents with no plan scale at all (§1.3); Rome scales real footprints by
     0.65. The two maps already distort *buildings* by different amounts in different ways, so the
     "same distortion" claim only ever applied to positions.
   - At `KZ` = 0.35 Rome becomes **less** distorted than Carthage (1.27× against 2.05×). That is a
     defensible direction rather than an arbitrary one: **the map with the dense monumental core
     should be the less compressed of the two.** Carthage's compression is paid for by a city that
     is mostly wall, hill, water and market gardens; Rome's is paid for by the Campus Martius, and
     the Campus Martius is where the battle's second act happens.

3. *"Every monument in `ROME` is already surveyed against it, and the overlap resolver, the bearing
   correction (`worldRot`, `ROT_RATIO = 1.45`) and the reference-raster affine in
   `src/city/overlay.ts` are all tuned to it. Re-fitting the projection would invalidate a 1.26 m-worst
   georeference over 7 km for no gain the battle can see."* — **All four of those dependencies are
   either unaffected or being deleted.**
   - **The monuments are surveyed in `(e, n)`, not in world metres.** `worldOf` is one four-line
     function and `place()` calls it. Re-projecting 34 rows is a recompile, not a re-survey. This is
     precisely the property `ROME_CIRCUIT_SURVEY`'s docstring boasts of: *"Held in survey metres and
     projected below rather than stored in world metres, because the survey is the thing with a
     source."*
   - **`resolveOverlaps` is being deleted.** Its tuning is not an asset.
   - **`ROT_RATIO` is being deleted.** At 1.27× anisotropy the correction it exists to apply is
     within a few degrees of identity.
   - **The georeference is upstream of `KZ` and is untouched.** `overlay.ts`'s affine maps raster
     **pixels → survey metres (`e`, `n`)**. It contains no `KX` and no `KZ`. The 1.26 m worst-case
     residual survives verbatim, and so does the 0.0294 shear that is EPSG:3004's grid convergence
     at Rome's longitude.
   - And the last clause — *"no gain the battle can see"* — is now false on its own terms. The
     battle's second act happens in the first few hundred world metres behind the wall. Today those
     are 454 metres holding 2,117 real metres of the densest monumental quarter in the ancient
     world, and the quarter behind the assaulted gate builds 17 buildings from 593 frontages. **A
     58 % increase in that quarter's depth is the most visible thing on the map.**

   §2.3's closing argument was strongest when it was defending a *built* map against a re-fit. It is
   weakest now, for the reason the coordinator named: *"everything" is exactly what is being
   discarded.* `ROME.md` §2.3 should be revised, not deleted — its `KX` argument is correct and
   should be kept and strengthened.

#### What "remodel" means concretely

Five merges, and each one is a *correction* to the survey rather than a compromise with it, because
in each case the survey models a nested or abutting complex as free-standing boxes (§2.2):

| merged monument | absorbs | real plan | why it is one thing |
|---|---|---|---|
| **Imperial fora** | Fora + Basilica Ulpia + Trajan's Column + Trajan's Market | c. 380 × 230 | the Basilica and the Column stand **inside** Trajan's Forum |
| **Capitolium** | Temple of Jupiter OM + Tabularium | c. 120 × 90 | the Tabularium is built into the saddle **below** the temple platform |
| **Agrippan complex** | Pantheon + Baths of Agrippa (+ Basilica Neptuni) | c. 200 × 110 | Agrippa built them as one insula-block on the Via Recta |
| **Octavia–Marcellus** | Porticus Octaviae + Theatre of Marcellus | c. 230 × 150 | they abut; the survey's two boxes **already overlap by 49 real metres** |
| **Oppian baths** | Baths of Titus + Baths of Trajan | c. 300 × 200 | Titus's baths abut Trajan's on the south-west; one terraced complex |

Merging drops the conflict count at `PLAN_SCALE` 0.65 from **34 to 22** on its own, before any
projection change. It also *improves* historical fidelity, which is the rare case where the cheap
fix and the right fix are the same.

Beyond the merges, the resizing is per-monument and declared. The seed is 0.65 of the real plan; the
probe (§4.4 check 2) reports every departure from the seed; and the survey row records the departure
next to the real dimension, so a reader can always see both what the building was and what we drew.
**A monument that has been shrunk to 0.31 with the reason written beside it is honest. A monument
that has been moved 130 metres by a solver at boot is not.**

### 4.6 What would change my mind

Named per the brief, so the recommendation is falsifiable rather than merely argued.

- **If the Circus Maximus and the Palatine are load-bearing for the skyline from inside the wall** —
  if a camera at the Porta Flaminia at eye height can see them today and their absence reads as a
  hole — then `KZ` = 0.35 is too aggressive and the answer is **`KZ` = 0.30** (anisotropy 1.48×,
  band depth 610 m, 17 conflicts at 0.65, and only the Circus, the Aventine temples and Caracalla
  lost) or `KZ` = 0.26. *The measurement that decides it:* two screenshots from the gate, one with
  those five monuments hidden, graded by eye. Half an hour, and it belongs in Phase 0.
- **If off-field silhouette geometry beyond z 1374 turns out to be impossible**, the cost of raising
  `KZ` roughly doubles and `KZ` = 0.26–0.30 becomes the right call. *The measurement:* place one box
  at z 1500 and see whether it renders, whether `assertNoStrayGeometry` objects, and what the
  heightfield does under it.
- **If tracing the fourteen regional boundaries off a 2.10 m/px plate turns out to give boundaries
  that disagree with the Lanciani georeference by more than ~40 world metres**, the regiones are not
  accurate enough to be a partition and §4.3 must fall back to Voronoi cells about the fourteen
  regional centres — which still tiles, and still beats seventeen overlapping rectangles.
- **If the road-graph faces come out dominated by a few enormous polygons** (because the armature is
  only ~20 ways over 1.45 km²), then step 2's derived cross-lanes are doing all the work and the
  "blocks are faces of the graph" claim is decorative. *The measurement:* the face-area
  distribution after step 1 alone, before any derived lane. If the p50 face is over ~3 hectares, the
  armature needs more named ways off the plates before the grid step is worth attempting.

---

## 5. Build order

Six phases. Each names what it changes and **the measurement that closes it**, and — per
`MAP-METHOD.md` §3's verdict on Rome phases A and B — **the fabric gets an acceptance measurement
at the same time as the wall, not after it.** A phase without a green measurement is not done, and
the measurement is taken in the representation that has to act on the property.

Every probe runs against a dev server on its own port, never 5173, killed by PID.

### Phase 0 — settle the frame, and prove it on paper before touching code

Choose `KZ`. Write `tools/scratch/rome-frame.mjs`: project all 34 survey rows plus the 14 circuit
waypoints at a swept `KZ`, and report the off-map set, the conflicting-pair count under the §4.1
merges, the Campus Martius band depth, and the projected cross-street pitch. Run the two
[?]-resolving experiments in §4.6 (the skyline screenshots, the box at z 1500).

*Acceptance:* the chosen `KZ` gives **≤ 15 conflicting pairs**, all of them enumerated by name in
the survey as authored exceptions; **band depth ≥ 650 world m**; **projected cross-street pitch ≥
22 m at the median**; and the off-map set is agreed by the owner in writing. **No code changes in
this phase.**

### Phase 1 — re-project the water and the circuit

Same survey polylines, new `KZ`. Re-fit `riverCentreX` and the `TOPO_GLSL` mirror from the same
twelve points; re-fit `romeWallZ` from the same fourteen waypoints; re-cut the bench.

*Acceptance:* `probe-rometransect` worst river error **≤ 25 world m** (it is 0.1 m today and must
not regress past 25). `assertRomeSection` reports **36 bays**, west end within **2 m of x +2**, east
within **2 m of x +1335** — all three must be *byte-identical* to today, because `KX` is unchanged,
and if any of them moves, something else changed too. Worst bay-to-bay walk step **≤ 6 m** (5.23 m
today). **Zero** bays footed at or below `WATER_LEVEL`. **Zero** projectile rays through the
circuit. The graded bench is ≥ 40 m wide under **100 %** of stations.

### Phase 2 — landmarks, and the instrument, together

Extend `ROME` to ~45 rows: the six missing Campus Martius monuments of §4.1 back-converted from
`ROME.md` §6.3's gazetteer into `e`/`n`; the five merges; the `plan: { hw, hd }` authored footprint
field; the Iseum's corrected 200 × 50. **Delete `resolveOverlaps`, `TOPOLOGY`, `separation`,
`confine` and `nearbyDrift`.** Write `tools/probe-romefabric.mjs` with checks 1, 2 and 3 live —
**in this phase, not a later one.**

*Acceptance:* `probe-romefabric --only=landmarks` reports **0 intersecting pairs**; **minimum clear
gap ≥ 7.0 m**; **every centre within 0.5 m of `worldOf(e, n)`** (this is the check that proves the
resolver is gone); **every footprint within 0.25 m of its authored size**; and **check 3 passes for
every monument** — its built centre falls inside its own inked polygon on the georeferenced Lanciani
raster. Plus: the fourteen circuit waypoints pass check 3 as well, which is the external grade the
circuit has never had.

### Phase 3 — roads, before any block exists

Author the ranked ways of §4.2 in survey metres: the six additions, the four demotions, the regional
boundaries as `vicus`-rank edges. Project once. Reserve into `KeepOut`. **Delete `deflect`,
`monumentRings` and `feeders`.**

*Acceptance:* the armature is **one connected component with no dangling ends inside the circuit**.
**Every gate's inner mouth is on a way of rank `consular` or better** — four of four, against one of
four today. **Ranked street length inside a monument footprint ≤ 2 %** against today's 24 %, with
every remaining metre named in the output. And `probe-nav` finds a route from each gate to the
Capitolium along ways of rank `local` or better.

### Phase 4 — the grid

Implement §4.3 steps 1–4: planar graph, derived cross-lanes, faces, inset. No buildings yet. Publish
the face set and its area distribution.

*Acceptance:* `probe-romefabric --only=grid` reports **every face closed**; **no face straddles a
road centreline**; the face-area distribution published with p10/p50/p90; **the p50 face is between
0.15 and 1.2 hectares** (a real Campus Martius block with its courts); and **zero faces of negative
inset area** silently discarded — every rejected face is reported with its reason, on Carthage's
`RejectReasons` pattern.

### Phase 5 — the fabric

Subdivide faces into insulae on the 30 × 45 m module with `fitFace` frontage quantisation and fixed
depth. Regiones supply attributes only.

*Acceptance:* **0 building–building intersections** past `PARTY_GAP = 0.35 m` and **0
building–monument intersections**, over every solid, no escape hatch. **Roof coverage between street
lines 60–70 %, measured per region against the AGEA orthophoto** — and the *Campus Martius region
specifically* inside that band, not just the city mean. **The `via-lata` quarter builds ≥ 60 % of
its frontages** against today's 2.9 %. **Every block's orientation within 5° of its face's longest
inset edge** — the check that proves blocks are faces and not a lattice. **Grain histogram**: patch
size and rotation distribution within tolerance of the orthophoto's 150–400 m / 15–40°.

### Phase 6 — the *horti*, the outside, and the draw budget

The northern strip inside the wall as a third terrain class: boundary walls 1.5–2.5 m on a 50–90 m
grid, ~6 % building coverage, terraces and planted avenues. The Via Flaminia's cleared tomb
frontage outside the gate. The Mausoleum of Hadrian on the wrong side of the wall.

*Acceptance:* building coverage in the *horti* **≤ 8 %**; `probe-nav` finds **no corridor wider than
35 m** through them, i.e. a cohort cannot hold a line inside a garden; whole-frame draw calls **≤
220** with the boot line printed; and the tomb frontage is cleared to `WALL_CLEAR_OUT = 30` with
stumps left.

### The one number that says the rebuild worked

> **`probe-romefabric`: zero intersecting solids anywhere in the city, and the Campus Martius —
> the 700 world metres directly behind the gate the assault comes through — is 60–70 % built,
> measured against a 50 cm orthophoto, on a grid whose every block is a face of the road graph.**
>
> Today that quarter is 2.9 % built, its blocks are a randomly-rotated lattice, and 34 pairs of
> monuments intersect.

---

## 6. Sources

**Reference plates**, all in `reference/rome-plans/` and catalogued in `ASSETS.md`:
Shepherd, *Historical Atlas* pl. 22 (1911/1923-26), PD — the named index of the circuit;
Kiepert/EB11 "Plan of Ancient Rome" (1911), PD — the metric plate;
ColdEel/Joris1919 "Plan Rome — Regiones" (2006), PD — the road graph and the regional partition;
Lanciani, *Forma Urbis Romae* (1893–1901) georectified by SITAR — the 1.71 m/px georeference,
1.26 m worst residual;
AGEA 2012 orthophoto, CC BY 4.0 — the modern aerial and the roof-coverage reference;
SITAR *Forma Urbis Severiana* vector — the grain reference, and the source of the negative result on
the *pes* modulus.

**Modern, on dimensions:** Platner & Ashby, *A Topographical Dictionary of Ancient Rome* (1929);
Digital Augustan Rome; the Severan Marble Plan; Humphrey, *Roman Circuses* (1986), 56–131 for the
Circus Maximus; Packer (2014) for the Theatre of Pompey's cavea; Sear (2006) for the Theatre of
Balbus; Sovrintendenza Capitolina.

**In-repo:** `docs/CARTHAGE.md` §2.3–2.5, §7.1–7.7, §12; `docs/ROME.md` §2.1–2.5, §4, §6, §12–15;
`docs/MAP-METHOD.md`; `ASSETS.md`.

**Measurements taken this pass** are all reproducible from `src/city/rome/survey.ts` plus the
projection in `src/terrain/topography.ts:356–389`. The scratch scripts were run out of tree and are
not checked in; **`tools/scratch/rome-frame.mjs` in Phase 0 is the checked-in version** and should
reproduce every table in §4.5. If it does not, this document is wrong and the script is right.

---

## 7. Phase 1, as built

**Status: built, measured, and awaiting the owner's review before phase 2 starts.** Written on
`e/city/rome-fabric-p1`, based on `15e209f`. `KZ` is **0.35**. `tools/scratch/rome-frame.mjs` is the
checked-in Phase 0 script §5 asks for, and it reproduces every table in §4.5 — with four errata,
listed in §7.7.

Phase 1's scope, from §5: *"re-project the water and the circuit"*, plus Phase 0's *"settle the
frame… no code changes in this phase"*, plus the survey table and the post-build sanity checks. **The
roads, the grid and the fabric were not touched, and `resolveOverlaps` was not deleted** — §5 puts
its deletion in phase 2 coupled to the merges and the authored footprints, and doing one of the three
without the others produces a state that is neither the old city nor the new one, at exactly the
moment the owner is being asked to approve the frame.

### 7.1 What changed, and what did not

| file | change |
|---|---|
| `terrain/topography.ts` | `KZ` 0.222 → **0.35**, with the constraint that produced it in the docstring. `TIBER_PATH` re-projected — twelve `z` values, every `x` unchanged to the centimetre. `TIBER_MEAN_SLOPE` 0.238 → **0.151**, re-derived. `RIVER_LUT`'s z range now derived from `TIBER_PATH` itself rather than from the map. |
| `city/rome/survey.ts` | docstrings only. The 34 rows are untouched: they are held in survey metres, so re-projecting the whole city was one number in another file. |
| `city/rome/layout.ts` | `offMapSouth` added and `LANDMARKS` filtered by it. District depth pinned to a world scale. `PLAN_SCALE`'s docstring records that it is scheduled for deletion, not for re-tuning. |
| `city/rome/assertions.ts` | `assertRomeFrame` added — §4.1's post-build checks. `assertTopology` and `assertHillRing` now separate an off-map id from an unknown one, and `assertHillRing`'s cyclic-order test is fixed. |
| `city/rome/plan.ts`, `city/cityPlan.ts`, `city/CitySystem.ts` | print `assertRomeFrame` at boot and publish it on `CityChecks` as `romeFrame`. |
| `city/rome/monuments.ts` | the dead `baths-diocletian` builder deleted. |
| `maps/carthage.ts`, `maps/carthage/topography.ts` | comments only. Both claimed `KE` *"is exactly Rome's `KZ`"*, which is now false. |

**Nothing in `sim/`, `ai/`, `render/` or `units/` was touched.**

### 7.2 The sanity checks, measured

§4.1's closing list, as `assertRomeFrame` prints it at every boot. `PENDING` rows carry the phase
that closes them; they are printed and excluded from the fault count, because a fabric measurement
that does not exist yet is precisely what got forgotten last time (`MAP-METHOD.md` §3).

| check | target | measured | |
|---|---|---|---|
| approach, attacker box to the Porta Flaminia | ≥ 700 m, invariant in `KZ` | **725.7 m** | ok |
| front, NW angle to Castra NE | 1332.5 m ± 1 | **x 2.01 … 1334.55** | ok |
| bay pitch | 37.015 m ± 0.05 over 36 bays | **36 bays at 37.015 m** | ok |
| Campus Martius depth, gate → Capitol | ≥ 650 world m (it was 450) | **715.8 world m** | ok |
| projected cross-street pitch, median | ≥ 22 world m | **24.5 m** (range 17.5–31.5) | ok |
| monuments past the +Z edge | 5, agreed in writing | **5** | ok |
| z clamp on a monument the frame kept | ≤ 10 m | **7.6 m** (Janiculum) | ok |
| every monument centre at `worldOf(e, n)` | ≤ 0.5 m | **398.9 m** worst | PENDING phase 2 |
| zero intersecting solids, min gap 7.0 m | 0 pairs over every solid | 0 monument/monument; **insulae are not in the population at all** | PENDING phases 2 and 5 |
| roof coverage between street lines | 60–70 % per region | not measured | PENDING phase 5 |
| the Campus Martius builds its frontages | ≥ 60 % | not measured | PENDING phase 5 |

### 7.3 The circuit and the Tiber, re-projected — §5's stated acceptance

Measured by `tools/scratch/probe-rometransect.mjs` against a control checkout at `15e209f` on a
second port, so "unchanged" is a measurement rather than an argument.

| | base, `KZ` 0.222 | phase 1, `KZ` 0.35 | §5's acceptance |
|---|---|---|---|
| ~~Tiber worst survey error~~ | ~~0.1 world m~~ | ~~0.1 world m~~ | ~~≤ 25 m~~ |

**RETRACTED, 22 Aug 2026, by the branch that assembled this tree.** The row above is the
number `e/terrain/tiber-resurvey` was called into existence to argue against, and leaving it
in a table headed *"stated acceptance"* is the fault this whole document warns about. It was
honest and useless: `probe-rometransect --only=tiber` compared the transcribed world-metre
table against `worldOf` of **the same twelve latitudes and longitudes**, so it measured the
projection's arithmetic and could not see whether a knot was in the river. Measured against
the plate, **one of the twelve control points stood on water**, the median knot was **115 real
metres** from the channel and the worst was **1,166 m**. A residual against your own control
points is not an accuracy figure — see `MAP-METHOD.md` rule 19. The live figures on this tree
are median departure **2.4 real m** over the assaulted front, swing ratio **0.990**, and **0**
inverted-curvature stations, from `tools/probe-tiber.mjs`, which grades against sixteen WGS84
bridge midpoints and a 4,476-node plate trace rather than against the survey it is checking.

| bays / west end / east end | 36 / x 2.006 / x 1334.55 | **36 / x 2.006 / x 1334.55** | byte-identical |
| bay pitch | 37.01511 m | **37.01511 m** | unchanged |
| worst pitch deviation | 0.0 % | **0.0 %** | — |
| relief along the wall line | worst 1.17 m, 0 of 267 over ±1.5 | **worst 1.19 m, 0 of 267** | ±1.5 m |
| graded bench ≥ 40 m | 266/266 stations, min 60 m | **266/266, min 64 m** | 100 % |
| worst walk step, both sides at full height | 5.23 m at x 224 | **5.50 m at x 668** | ≤ 6 m |
| bays at or below `WATER_LEVEL` | 0 | **0** | 0 |
| `assertRomeSection` faults | 0 | **0** | 0 |
| projectile rays through the circuit | 0 | **0** (`probe-wall` 19/19) | 0 |

**`SURVEY_WEST`, `SURVEY_EAST`, the 36 bays and the 37.015 m pitch are unchanged, and they are
unchanged *by construction* rather than by luck.** `x = X0 + KX·e` contains no `KZ`; `GATE_X` is the
fixed point of `roadCentreX(crestZAt(x))` and `GATE_Z = crestZAt(GATE_X)`, both of them functions of
x and z alone. The 725.7 m approach is invariant for the same reason. The two numbers that *did* move
are the two that had to: the worst walk step, because the wall's own line moved 5–60 world metres
south along its length and therefore stands on different ground, and the bench's minimum width.

**And `worldRot` turned out to be scale-invariant in `KZ`** — the factor cancels inside the `atan2` —
so not one monument's bearing moved by a millidegree. §4.5 says `ROT_RATIO` becomes deletable at
1.27× anisotropy; the measurement is that the worst monument in the table differs by **3.78°**
between `ROT_RATIO` = 1.45 and the true 1.266. Deleting it is phase 2's, not phase 1's.

**One further thing had to move and it is worth naming**, because it is the only place the
re-projection reached that nothing was watching. `RIVER_LUT`'s sampled z range was
`-HALF_EXTENT - 200 … +HALF_EXTENT + 200`, which covered the twelve surveyed knots at `KZ` = 0.222
(z −311 to +1539) and did not cover them at 0.35 (z −797 to +2121). `riverCentreX` therefore clamped
past z 1600 and returned a value **161.6 world metres** from the survey at the twelfth point. That is
off the map and nothing on the ground could see it — and `probe-rometransect --only=tiber` is the
external instrument that stops this transcribed table rotting, so teaching it to look away from a
range was not an option. The LUT's range is now the union of the map and the **authored polyline**,
computed from `TIBER_PATH` itself, so it covers the survey at any `KZ` by construction.

### 7.4 The georeference survived, and it was checked rather than assumed

§4.5 predicted this and the prediction holds, for the reason it gave: `src/city/overlay.ts`'s affine
maps raster **pixels → survey metres**, and contains no `KX` and no `KZ`. `overlay.ts` is
byte-for-byte unchanged by this pass. The 1.26 m worst-case residual over 7 km and the 0.0294
EPSG:3004 shear are untouched.

One consequence is worth writing down, because it is the only thing about the georeference that *did*
change: the residual is quoted in **survey** metres, and in **world** metres it grows with `KZ`. At
0.222, 1.26 survey metres was 0.28 world m in z; at 0.35 it is **0.44 world m**. Still a third of a
heightfield sample, still inside §4.4 check 3's 0.5 m tolerance — and worth knowing before somebody
tightens that tolerance.

**It was also checked visually, which is the check that actually matters here.**
`tools/scratch/rome-plate-overlay.mjs` draws every survey row's **real published plan at its real
bearing** onto the georeferenced Lanciani raster, in survey metres, with no projection involved at
all. Every monument lands on its own inked plan. That is the first time anything on this project has
graded Rome's *positions* against a plate by more than eye, and it closes — for these rows, by
inspection — the blind spot `tools/probe-fabric.mjs` declares: that plate carries no monument names,
so the gate can prove a footprint is the wrong *size* and cannot prove it is in the wrong *place*.

### 7.5 The survey, in `CARTHAGE.md` §2.5's format, at `KZ` = 0.35

Generated by `node tools/scratch/rome-frame.mjs --table`, which **parses** `survey.ts` rather than
restating it. `e`/`n` are metres east and north of the Temple of Jupiter OM, 41.8925 N 12.4823 E.
Per-row provenance is `survey.ts`'s `cite` field, which carries the latitude and longitude each row
was derived from; the source column here names where to look rather than duplicating thirty-four
paragraphs.

| feature | e | n | x | z | real plan, m | source |
|---|---:|---:|---:|---:|---|---|
| circuit: tiber-angle | -655 | 2006 | **2** | **543** | — | ROME_CIRCUIT_SURVEY; Lanciani georef |
| circuit: porta-flaminia | -497 | 2045 | **72** | **530** | — | ROME_CIRCUIT_SURVEY; Lanciani georef |
| circuit: muro-torto-west | -273 | 2039 | **171** | **532** | — | ROME_CIRCUIT_SURVEY; Lanciani georef |
| circuit: muro-torto-mid | -8 | 1995 | **289** | **547** | — | ROME_CIRCUIT_SURVEY; Lanciani georef |
| circuit: muro-torto-east | 273 | 1928 | **413** | **571** | — | ROME_CIRCUIT_SURVEY; Lanciani georef |
| circuit: posterula-pinciana | 530 | 1789 | **527** | **619** | — | ROME_CIRCUIT_SURVEY; Lanciani georef |
| circuit: sallustiana-west | 762 | 1784 | **630** | **621** | — | ROME_CIRCUIT_SURVEY; Lanciani georef |
| circuit: porta-salaria | 1036 | 1784 | **751** | **621** | — | ROME_CIRCUIT_SURVEY; Lanciani georef |
| circuit: sallustiana-east | 1301 | 1756 | **869** | **631** | — | ROME_CIRCUIT_SURVEY; Lanciani georef |
| circuit: porta-nomentana | 1831 | 1784 | **1103** | **621** | — | ROME_CIRCUIT_SURVEY; Lanciani georef |
| circuit: castra-nw | 1931 | 1711 | **1148** | **647** | — | ROME_CIRCUIT_SURVEY; Lanciani georef |
| circuit: castra-ne | 2353 | 1578 | **1335** | **693** | — | ROME_CIRCUIT_SURVEY; Lanciani georef |
| circuit: castra-se | 2295 | 1256 | **1309** | **806** | — | ROME_CIRCUIT_SURVEY; Lanciani georef |
| circuit: porta-tiburtina | 2709 | 333 | **1492** | **1129** | — | ROME_CIRCUIT_SURVEY; Lanciani georef |

| monument | e | n | x | z | real plan, m | source |
|---|---:|---:|---:|---:|---|---|
| Mausoleum of Augustus | -481 | 1500 | **79** | **720** | 87 x 87, bearing 0 deg | survey.ts cite |
| Ara Pacis Augustae | -315 | 1278 | **153** | **798** | 11.6 x 10.6, bearing 88 deg | survey.ts cite |
| Horologium Augusti | -323 | 1011 | **149** | **892** | 20 x 20, bearing 0 deg | survey.ts cite |
| Stadium of Domitian | -762 | 745 | **-45** | **985** | 275 x 106, bearing 177 deg | survey.ts cite |
| Baths of Nero | -560 | 620 | **44** | **1028** | 190 x 120, bearing 8 deg | survey.ts cite |
| Pantheon | -447 | 678 | **94** | **1008** | 84 x 58 (long axis z), bearing 176 deg | survey.ts cite |
| Baths of Agrippa | -423 | 556 | **105** | **1051** | 120 x 100, bearing 3 deg | survey.ts cite |
| Iseum Campense | -300 | 560 | **159** | **1049** | 70 x 34 (long axis z), bearing 270 deg | survey.ts cite |
| Temples of the Area Sacra | -464 | 333 | **87** | **1129** | 90 x 60, bearing 8 deg | survey.ts cite |
| Theatre of Pompey | -836 | 244 | **-78** | **1160** | 300 x 180 (long axis z), bearing 89 deg | survey.ts cite |
| Porticus Octaviae | -300 | -60 | **159** | **1266** | 132 x 119, bearing 26.5 deg | survey.ts cite |
| Theatre of Marcellus | -215 | -78 | **197** | **1273** | 130 x 115 (long axis z), bearing 204 deg | survey.ts cite |
| Temple of Jupiter Optimus Maximus | 0 | 0 | **292** | **1245** | 63 x 53 (long axis z), bearing 333 deg | survey.ts cite |
| Tabularium | 60 | 40 | **319** | **1231** | 73 x 34, bearing 50 deg | survey.ts cite |
| Forum Romanum | 249 | 0 | **402** | **1245** | 200 x 90, bearing 117 deg | survey.ts cite |
| Basilica Ulpia | 191 | 333 | **377** | **1129** | 130 x 55, bearing 41 deg | survey.ts cite |
| Trajan's Column | 166 | 378 | **366** | **1113** | 18 x 18, bearing 0 deg | survey.ts cite |
| Trajan's Market | 262 | 400 | **408** | **1105** | 120 x 70, bearing 139 deg | survey.ts cite |
| Fora of Caesar, Augustus and Nerva | 300 | 180 | **425** | **1182** | 250 x 100, bearing 126 deg | survey.ts cite |
| Palatine Palaces [OFF MAP] | 381 | -422 | **461** | **1393** | 230 x 190, bearing 118 deg | survey.ts cite |
| Circus Maximus [OFF MAP] | 249 | -733 | **402** | **1502** | 621 x 190, bearing 120 deg | survey.ts cite |
| Flavian Amphitheatre | 820 | -256 | **655** | **1335** | 189 x 156, bearing 115 deg | survey.ts cite |
| Ludus Magnus | 990 | -215 | **731** | **1321** | 135 x 100, bearing 55 deg | survey.ts cite |
| Baths of Titus | 978 | -100 | **725** | **1280** | 120 x 105, bearing 115 deg | survey.ts cite |
| Baths of Trajan | 1085 | 60 | **773** | **1224** | 230 x 170, bearing 125 deg | survey.ts cite |
| Temple of Serapis | 381 | 645 | **461** | **1020** | 135 x 98 (long axis z), bearing 45 deg | survey.ts cite |
| Castra Praetoria | 1939 | 1467 | **1151** | **732** | 400 x 377, bearing 340 deg | survey.ts cite |
| Horti Sallustiani | 887 | 1612 | **685** | **681** | 250 x 170, bearing 60 deg | survey.ts cite |
| The Aventine [OFF MAP] | -274 | -944 | **171** | **1576** | 150 x 110, bearing 150 deg | survey.ts cite |
| Baths of Caracalla [OFF MAP] | 845 | -1500 | **667** | **1770** | 218 x 140, bearing 130 deg | survey.ts cite |
| The Caelian [OFF MAP] | 887 | -667 | **685** | **1479** | 150 x 110, bearing 100 deg | survey.ts cite |
| Insula Tiberina | -365 | -189 | **130** | **1312** | 270 x 67, bearing 121 deg | survey.ts cite |
| Mausoleum of Hadrian | -1326 | 1178 | **-295** | **833** | 89 x 89, bearing 177 deg | survey.ts cite |
| Janiculum Ridge | -1599 | -389 | **-416** | **1382** | 520 x 240, bearing 12 deg | survey.ts cite |

| missing monument | pub x@0.222 | z@0.222 | rec. e | rec. n | x | z | real plan, m | source |
|---|---:|---:|---:|---:|---:|---:|---|---|
| Saepta Iulia | 212 | 870 | -181 | 512 | **212** | **1066** | enclosure c. 310 x 120; pier hall 400 x 60, piers 1.70 m sq. at 4 m centres | Severan Plan; Platner-Ashby. The largest omission: 3.7 ha of colonnaded hall on the Via Lata, on the gate axis |
| Porticus Pompei | 10 | 914 | -637 | 314 | **10** | **1136** | 180 x 135, four rows of columns, a double grove of plane trees | Severan Plan. Undamaged in 271 while the theatre beside it is a burnt ruin from 247 |
| Porticus Divorum | 226 | 890 | -149 | 422 | **226** | **1098** | c. 200 x 55, thirty-plus columns a side | Regionaries |
| Diribitorium | 208 | 905 | -190 | 355 | **208** | **1121** | roof beams 30 m — the largest single-roofed building in Rome | Regionaries. A roofless shell for 191 years, since the fire of 80 |
| Circus Flaminius | 98 | 1003 | -438 | -87 | **98** | **1276** | c. 260 x 100 — and not a circus: no stands, no barrier | Regionaries. A paved, encroached piazza; the only large open ground inside the walls on the south half of the map |
| Theatre of Balbus / Crypta Balbi | 105 | 959 | -423 | 111 | **105** | **1206** | cavea c. 95 m; complex c. 1 ha | Sear (2006). The one excavated lived-in quarter on this map |
| Hadrianeum | 185 | 798 | -242 | 837 | **185** | **953** | eleven columns 15 m high, 1.44 m dia.; precinct [?] | Standing today. Precinct dimension UNVERIFIED — measure off the Kiepert metric bar before use |


**Four things in that table are wrong and are phase 2's first jobs.** Each is already measured by
`tools/probe-fabric.mjs`, so none of them is a matter of opinion:

- **Baths of Caracalla: the row contradicts its own citation.** `len: 218, wid: 140`, and the `cite`
  reads *"the bathing block within it 218 × 112; the block is what is modelled."* 140 is not 112. It
  is off this map now, which makes it cheap to fix and easy to forget.
- **Iseum Campense: 70 × 34 against a published c. 200 × 50.** Too small by a factor of **2.85**, and
  `survey.ts` has said so in prose for two passes. It is the worst fidelity failure the gate finds
  (G13, the only monument outside its cohort's compression).
- **Circus Maximus: modelled to its envelope rather than its track** — aspect 3.27 against a
  published 5.26. Off this map now.
- **Pantheon: the rotunda is drawn square, 48.3 × 47.7.** It is a round building.

### 7.6 Nothing on this map postdates 271, and one loaded gun was removed

Audited all thirty-four survey rows against their own citations. **The latest thing on the map is the
Temple of Serapis (Caracalla, 211–217), and the newest great monument is the Baths of Caracalla
(dedicated 216), which is off the +Z edge anyway.** The aqueducts are Marcia (144 BC), Virgo (19 BC)
and Claudia (AD 52); every named way is Republican or earlier. No row is anachronistic.

The Baths of Diocletian have been correctly absent from the survey for two passes — **and
`monuments.ts` still carried a working 376 × 361 m builder for them**, keyed on an id no survey row
supplies. A dead builder for a monument that must never be drawn is the one line that turns "somebody
adds a row" into "the map is wrong by thirty years", with nothing in between to object. Deleted, with
the reason left in place so it is not helpfully restored.

**The date filter to carry into phase 3.** The Shepherd plate is dated c. 350 and draws these baths
at full size on the Viminal. Anything traced off it has to be filtered against `ROME.md` §6.3's
monument-by-monument state, or against the Kiepert plate's Republican/Imperial colour separation. A
reference can be authentic and still wrong for your date. The same goes for the Baths of Constantine,
the Basilica of Maxentius and the Arch of Constantine, none of which is in the survey.

### 7.7 Errata against §4.5, found by the script §6 said should be able to find them

§6's instruction was: *"`tools/scratch/rome-frame.mjs` in Phase 0 is the checked-in version and
should reproduce every table in §4.5. If it does not, this document is wrong and the script is
right."* It reproduces the load-bearing numbers exactly — the `KX` ceiling table, the off-map sets at
every swept `KZ`, **34 conflicting pairs unmerged → 22 merged** at `KZ` 0.222 / `PS` 0.65, **13** at
`KZ` 0.35, **3** at 0.413, the −367 south edge, the 17.5–31.5 m projected pitch. Four small
disagreements:

1. **Campus Martius band depth is 716 world m, and §4.5's own §4.1 table says 710.** §4.1 puts the
   Porta Flaminia at z 530 and the Capitolium at z 1240. `assertRomeFrame` measures gate → Temple of
   Jupiter OM and reports **715.8**. All three are the same number to within the choice of which
   point on the Capitol, and §4.5's "454 today" is 450 by the same measurement. No consequence.
2. **The off-map criterion is the footprint, not the centre.** §4.5's off-map sets are only
   reproducible if a monument is dropped when its own half-depth crosses `HALF_EXTENT`, which is what
   `KZ`'s original docstring meant by *"its precinct clear of the edge"*. A centre test disagrees at
   `KZ` 0.30 (it keeps the Circus Maximus) and at 0.38. `offMapSouth` uses the footprint test.
3. **The Capitolium does not fall off at `KZ` = 0.413.** §4.5's last row lists it among the losses; it
   stands at z 1368 with its south edge at 1399.4 against a 1400 m bound — 0.6 m inside. Irrelevant
   to the chosen `KZ`; recorded so the table is not later cited as measured.
4. **The Janiculum ridge survives at `KZ` = 0.35, and §4.5 said it would not.** It is `farBank`, so
   its x comes from `FAR_BANK(z)` off the terrain's own channel rather than from the affine map, and
   `offMapSouth` therefore does not apply to it. It projects to z 1382 and stands at z 1374, clamped
   by 7.6 m on a 520-metre ridge, which is beneath anything a camera can see. **So the accepted cost
   is five monuments, not six.**

### 7.8 The question the fabric gate raised, answered on paper

`tools/probe-fabric.mjs` measured the real fault and it is not overlap: on the shipped city there are
**zero** intersecting monument pairs, because `resolveOverlaps` displaces monuments until there are
none. So the owner's *"the footprint of where the buildings are is completely wrong… everything is
completely off"* is a description of **displacement**. Measured on the control at `15e209f` and on
this tree, from each monument's own `idealX`/`idealZ`:

| | base, `KZ` 0.222 | phase 1, `KZ` 0.35 |
|---|---|---|
| resolver displacement, mean | 65.3 world m | **141.9 world m** |
| worst | 167.7 m (Ludus Magnus) | **398.9 m** (Theatre of Pompey) |
| monuments displaced over 50 m | 18 of 31 | **22 of 26** |
| the same, in **real** metres | mean 226, worst 672 | mean 351, worst **1,098** |

**Raising `KZ` makes the resolver work twice as hard, and that is the strongest single argument for
deleting it that this project has produced.** It is not an argument against the projection. The
resolver's job is to discharge the projected conflicts; `KZ` = 0.35 leaves it fewer of them (13
against 22) and it still moves everything further — because with the southern monuments gone and the
Campus Martius band 58 % deeper it has *more room to push into and no reason not to*. A solver given
more room does not do less work; it does more, further. **Until phase 2 removes it, the fault the
owner reported is worse than it was.** That is stated plainly here because it is visible in the
review renders and must not be read as caused by the frame.

**Can the resolver be deleted without the overlaps coming back?** `rome-frame.mjs --absorb` answers
it: freeze every centre at `worldOf(e, n)`, apply the five merges, seed every footprint at 0.65, and
shrink only monuments that are in a conflict — worst pair first, larger footprint first.

| authored floor | intersecting pairs | pairs inside the 7 m street | min clear gap | Colosseum drawn |
|---:|---:|---:|---:|---|
| 0.65 (no departures allowed) | 12 | 1 | −56.5 m | 123 × 101 m |
| 0.50 | 3 | 2 | −27.4 m | 95 × 78 m |
| 0.42 | 3 | 0 | −11.5 m | 79 × 66 m |
| **0.36** | **0** | 3 | **+0.2 m** | 68 × 56 m |
| 0.33 | 0 | 2 | +5.4 m | 62 × 51 m |

**So yes — and §4.5 is right in method and optimistic in degree.** "Nothing moved and nothing
intersects" is reachable at `KZ` 0.35 with the five merges, but only if nine of twenty-four monuments
come down from the 0.65 seed and five of them go to about a third of real plan. §4.5 itself calls a
44 m Colosseum *"a tower, not an amphitheatre"*; 68 m is better and is still a third of 189.

The residual is **three pairs**, and two of the three are **east–west** conflicts, so `KZ` cannot
touch them and `KX` is 5 % from its ceiling:

- **Colosseum / Ludus Magnus** — 170 real metres apart east–west, which is 75 world metres, against
  113 m of footprint at the seed.
- **Agrippan complex / Baths of Nero** — 125 real metres apart in `e` and 3 in `n`: 55 world metres
  against 69 m of footprint even at a third of plan. A **sixth merge** folding the Thermae Neronianae
  into the Agrippan block is historically sound — they abutted, which is §4.1's own criterion for a
  merge — and `--merge6` measures it: it does not fix the problem, it moves it to the Area Sacra.
- **Oppian baths / Ludus Magnus** — 195 real metres in `n`, with the Ludus squeezed from two sides.

**The decision phase 2 has to take is a taste decision and it belongs to the owner:** either the
Colosseum and its valley are drawn at about a third of plan, or two or three named pairs are declared
**authored abutments** and allowed to touch, with the reason written beside each. `resolveOverlaps`
currently takes that decision silently, twenty-six times, by moving the buildings.

### 7.9 Four faults this phase measured that nothing had measured before

None of them was caused by this pass. Recorded because each needs an owner.

1. **Insulae are built standing in the Tiber, and always have been.** Read off
   `CitySystem.getObstacles()` — every solid, monuments and insulae together, which is the population
   `assertNoFootprintOverlaps` has never had — against `terrain.heightAt` and `riverBankX`: at
   `15e209f`, **37 of 903 solids are entirely below `WATER_LEVEL`**; on this tree, **60 of 1,259**. As
   a rate that is 4.1 % → 4.8 %, and the absolute count grew because 39 % more city got built.
   `assertNoFabricOverlaps` reports zero, `probe-fabric` G1 and G2 report zero, and there are
   buildings in the river in both trees. **`probe-fabric` has no water check and should get one** — it
   is one line against `heightAt` and it is the cheapest check on this list. The fault itself is
   phase 5's, in `planDistrict`. `tools/scratch/rome-wet-city.mjs` is the measurement.
2. **`assertHillRing` could not survive losing a ring member.** Its cyclic-order test normalised each
   step to the shortest turn, and a shortest-turn test cannot distinguish a legitimate 213° arc from
   a 147° inversion. Latent for as long as the ring had all eight members; taking the Caelian and the
   Aventine off the map opened a 209° real gap between the Baths of Titus and the Janiculum, and the
   check failed a correct build. It now compares the **forward** turn in world space against the
   forward turn in the survey, which is unambiguous at any gap size.
3. **`place()`'s z clamp was a silent trap.** Without `offMapSouth`, raising `KZ` would not have
   removed the five southern monuments: it would have clamped all five onto the single line
   z = 1374, where they would have stacked on each other and on the Colosseum, and the resolver would
   then have pushed the pile north into the city. Nothing would have printed.
4. **The district depth factor was coupled to `KZ` for no reason.** `hd = d.hn * KZ * 3.5` would have
   made every district **57.7 % deeper** as a side effect of the projection change, taking §2.3's
   266 % over-claim past 350 %. It is pinned to the world scale it has actually had (0.777) so the
   districts did not move; `probe-fabric` G19 went 1.33× → 1.399× rather than to roughly 2×. Phase 5
   deletes `DISTRICT_PLAN` outright, so this is a hold and not a fix.

### 7.10 The external gate, before and after

`tools/probe-fabric.mjs` at `d8eef08`, run unmodified against a control checkout at `15e209f` and
against this tree. Rome goes **6/21 → 7/21**. The verdict moving by one check badly understates it;
the measured values are the story.

| check | base | phase 1 | |
|---|---|---|---|
| G4 monument in a carriageway (plan) | 60,932 m² / 121 segments / 26 monuments | **23,806 m² / 57 / 18** | −61 % |
| G5 drawn street under a monument | 29,868 of 129,228 vertices (23.1 %) | **9,153 of 123,138 (7.4 %)** | −68 % |
| G9 monument keeps the ambitus from the fabric | FAIL, min 1.02 m | **PASS, min 1.84 m** | gained |
| G14 drawn stone outside its own box | 23 of 31, worst 72.2 m per side | **13 of 26, worst 34.8 m** | −52 % |
| G15 monument stone inside another monument | FAIL, 645 vertices, 7 pairs | **PASS, 0** | gained |
| G16 monument stone inside a building | 1,153 vertices, 23 buildings | 1,478, 24 | worse |
| G17 buried quarters | **6**, including `via-lata` at 18 of 593 frontages | **2** — `emporium`, `forum-boarium` | −4 |
| G18 region overlaps | 75 pairs, 4.76 Mm² | 79 pairs, 4.55 Mm² | flat |
| G19 regions partition the ground | 1.33× | 1.399× | slightly worse |
| G20 block orientation from the street | median 9.17°, 556 of 788 out | median 8.82°, 815 of 1,150 out | flat |
| G21 grain seams inside 40 m | 17.0 % | 21.0 % | worse |
| G11 every sourced monument present | PASS | **FAIL** | the accepted cost |
| solids the collision layer publishes | 903 | **1,259** | +39 % |
| ranked-way samples inside a monument | 302 of 1,040 (29.0 %) | **98 of 956 (10.3 %)** | −65 % |

Two rows need reading carefully.

**G11 fails for an approved reason, and the gate should be told about it.** Its missing list is
*"Circus Maximus (track — the published pair), Baths of Caracalla (bathing block)"* — both off the +Z
edge by the decision this phase implements. The gate already distinguishes "absent because
anachronistic" (the Baths of Diocletian, correctly); it needs the same category for "absent because
off this map's frame", or it will fail every future Rome build for a reason that is a design
decision.

**`via-lata` is no longer a buried quarter.** It was 18 buildings from 593 frontages — the 2.9 % §2.3
publishes as the symptom, in the quarter directly behind the assaulted gate. It no longer trips the
generator's own counter, and 39 % more city is standing. That is the projection change paying for
itself in the one place the battle happens, with no fabric work done at all.

### 7.11 What phase 2 inherits

- **The frame is settled and instrumented.** `assertRomeFrame` prints at every boot and is published
  on `CityChecks.romeFrame`, so `probe-fabric` can read the builder's own arithmetic instead of
  re-deriving the projection.
- **The authored-footprint seed list is computed**, in §7.8: nine departures from the 0.65 seed, and
  the two decisions that cannot be computed are named and belong to the owner.
- **The six missing Campus Martius monuments are back-converted to `e`/`n`**, in §7.5, with the
  published world pair beside each so the arithmetic is checkable. They still need a `cite` per row
  and a plate check each before they go into `survey.ts`.
- **Four wrong dimensions are named** in §7.5, each with the figure it should be.
- **`offMapSouth` is the one place that decides what is on this map**, so a future frame change moves
  five monuments by editing one predicate rather than by hunting.
- **`ROT_RATIO` is measurably nearly identity** (3.78° worst) and can go out with the resolver.

---

## 8. Phase 2, as built — landmarks

**Status: built, measured, and awaiting the owner's review.** Written on `e/city/rome-landmarks`,
based on `bc2e0f2`. `resolveOverlaps` is deleted. Every monument now stands at exactly
`worldOf(e, n)`.

The brief's priority order was the owner's own: *"adhere to the original plans of Rome as much as
possible"* — merge first, raise the floor second, shrink only what must shrink. It survived
contact, but the biggest single lever turned out to be one nobody had listed.

### 8.1 The headline

| | phase 1 | phase 2 |
|---|---|---|
| resolver displacement, mean | 141.9 world m | **0.0 m — by construction** |
| worst | 398.9 m (Theatre of Pompey) | **0.0 m** |
| the same, in **real** metres | mean 351, worst 1,098 | **0** |
| **inverted spatial *position* relations** | **18 of 184** (the plan judge) | **0 of 860** |
| **inverted spatial *size* relations** | **0 of 345** (a uniform scale preserves order by definition) | **56 of 345 — nobody counted these.** See §9.3 |
| global `PLAN_SCALE` | 0.65, applied to everything | **abolished** |
| monument height : width | **1.54× too tall** (the ground judge) | **isotropic — `drawY` defaults to `draw`** |
| Colosseum drawn | 123 × 101 m at 48 m, **29.3 m *inside* the edge of the ground** | **108 × 89 m at 27 m, 5.5 m inside it** |
| monuments at full published plan, all three axes | 0 of 27 | **4 of 27 drawn** (nine rows carry 1.000; five are the rows `offMapSouth` drops and are never drawn) |
| authored floor | n/a (uniform 0.65 with 22 conflicts) | **0.339, with zero conflicts** |
| worst monument/monument interpenetration | 0 m (the resolver's whole job) | **2.4 m**, inside the gate's own abutment allowance |
| merged complexes | 0 (5 proposed) | **5, covering 21 rows** |
| survey rows moved to a plate control | 0 | **16** |
| survey rows | 34 | **35** |

### 8.2 The lever the plan did not have: five monuments were in the wrong place

§4.5 framed this as a geometry problem — too much footprint in too little projected ground — and
prescribed merging and shrinking. Both help. **But the largest single source of conflict was that
the survey had five monuments in the wrong place, and no amount of merging or shrinking fixes a
wrong coordinate.** Every one was found by drawing the survey's own published plans onto the
georeferenced Lanciani raster and looking (`tools/scratch/rome-landmarks.mjs --plate`).

| row | was | is | moved | what was wrong |
|---|---|---|---|---|
| **Baths of Nero** | e −560, n 620 | **e −580, n 800** | **181 m** | the row contradicted its own citation (41.8985 N is n 667, not 620) and *both* put the baths south of the Pantheon, on top of the Baths of Agrippa. The inked block — a symmetrical thermae plan with a tinted natatio and paired apsidal halls — is at n 729–869. `wid` 120 → 140 and **bearing 8 → 88**: the long axis is the 191 m east–west dimension, so the old bearing was 82° out. |
| **Theatre of Pompey** | e −836, n 244 | **e −772, n 298** | **83 m**, and split | the row's **position was the cavea's and its footprint was the whole complex's**. A 300 × 180 box centred on the cavea reaches 150 m west into open ground and stops short of the porticus it claims to include. Now the theatre proper, with `porticus-pompei` as its other half. |
| **Porticus Octaviae** | e −300, n −60 | **e −319, n 61** | **123 m** | the cited coordinate is the **propylon** — the porch under S. Angelo in Pescheria — which is the precinct's *south edge*. Centring a 132 × 119 m quadriportico on its own front door puts half of it inside the Theatre of Marcellus. **This is the whole of §4.5's "the survey's two boxes already overlap by 49 real metres."** It was not a fact about how closely they abut; it was a fact about this coordinate. Corrected, they are 177 real metres apart. |
| **Trajan's Market** | e 262, n 400 | **e 356, n 344** | **109 m** | the old coordinate put the markets north-west of Trajan's Column, on ground the Column and the libraries occupy. The great hemicycle is inked at e 332–375. |
| **Baths of Titus** | e 978, n −100 | **e 940, n −125** | **44 m** | at the old position it and the Ludus Magnus interpenetrated by **26.7 real metres** — an overlap present with no projection applied at all, which no plan scale can remove and which dominated the layout at every floor. |

Two more corrections are dimensional rather than positional, and both close a row that
contradicted its own citation or the gate:

- **Iseum Campense 70 × 34 → 200 × 50.** The worst fidelity failure the gate found, 2.85× too
  small, confessed in this file's prose for three passes. Also nudged 30 m east: the 200 m figure
  is the whole Iseum *and* Serapeum, and a 200 m box on the Iseum's own coordinate reaches through
  the Baths of Agrippa.
- **Baths of Caracalla `wid` 140 → 112** and **Circus Maximus `wid` 190 → 118.** Both rows
  contradicted their own `cite`; both are off the +Z edge, which is what made them easy to forget.

**Nine more rows moved to a digitised plate control**, which arrived mid-pass and is a better
ruler than anything this phase built: `tools/judge/control.mjs` on `e/judge/rome-plan` carries
sixteen monuments read off the georeferenced Lanciani raster with a **method and an error bar per
row**, and it is the thing `probe-fabric`'s header says cannot exist — an independent ruler for
*position*. Every row below was taken from it.

| row | moved | control's `how`, err | note |
|---|---:|---|---|
| **Castra Praetoria** | **113 m** | `plate`, 35 m | and the internal check is sharper than the external one: `ROME_CIRCUIT_SURVEY` anchors the curtain's east end on the camp's own NE angle at e 2353, and a 437 m camp centred at the old e 1939 puts that angle 124 m short of the wall that runs into it. |
| **Baths of Titus** | **110 m** | `plate-weak`, 70 m | taken over this pass's own earlier guess: a weak plate read beats a coordinate recalled from memory. It also settles the pair that dominated the layout — 196 real metres from the Ludus Magnus instead of 125. |
| **Baths of Trajan** | 109 m | `plate-weak`, 60 m | |
| **Theatre of Marcellus** | 39 m | `plate`, 30 m | the reader's own contact sheet at 1.0 m/px had reported *zero* error for this row; at 0.46 m/px it is 39 m. **A monument is not checked until it is checked at a scale that can see it.** |
| **Tiber Island** | 43 m | `plate`, 25 m | 34 m of it perpendicular to a 67 m wide island. |
| **Baths of Agrippa** | 29 m | `plate`, 30 m | |
| **Colosseum** | 20 m | `plate`, 20 m | and 7 m of it northward, which the +Z edge is grateful for. |
| **Forum Romanum** | 16 m | `plate`, 35 m | |
| **Area Sacra** | 12 m | `plate`, 25 m | |

**One control was declined, with evidence.** The table puts the Pantheon at n 655, 23 m south of
the survey's 678 and inside its own 25 m error bar. The survey is right: 41.8986 N is the rotunda,
and the **AGEA 2012 orthophoto** — pixel-registered to the same affine — shows the dome and its
oculus centred on the survey's crosshair to about 5 m. The control's own note on that row is
internally muddled about whether it is describing the rotunda or the box. Recorded rather than
silently overridden.

**And the control's own disclosure is worth repeating** because it is the sharpest methodological
finding of the day: nine of its sixteen rows turned out to restate `survey.ts`'s citations rather
than being independent reads, and are excluded from scoring. That is rule 6's failure mode
occurring *inside the instrument built to enforce rule 6*. The same thing happened to this phase's
own `--realgaps` (§8.8) and it happened for the same reason — an instrument that agrees with the
document it is checking looks corroborated and may only be inbred.

**The general lesson, and it is the one worth carrying to phase 3.** A survey row has *four*
independent things that can be wrong — the coordinate, the dimension, the bearing, and **which
part of the building the coordinate refers to** — and the fourth is the one with no natural
instrument. A propylon coordinate on a precinct footprint and a cavea coordinate on a complex
footprint are both internally consistent, both cite a real place, and both put a building 120 m
from where it stands. Nothing but a plate finds them.

### 8.3 The merges — five complexes, and what "merge" turned out to mean

§4.5 proposed merging by **replacing** each set of rows with one box carrying the merged
precinct's published dimension. That was not done, and the reason is measured rather than
aesthetic:

- `monuments.ts` dispatches its geometry on the row id, so absorbing `pantheon` into an
  `agrippan` row **stops the dome being drawn at all**;
- `probe-fabric` G11 gates twelve hardcoded monument ids, and **four of them** — `pantheon`,
  `temple-jupiter`, `theatre-marcellus`, `porticus-octaviae` — are absorbed by §4.5's five merges.
  The merge would have failed the gate that exists to notice a monument going missing.

So a merge here **declares a relation instead of collapsing the rows**: `RomeMonument.complex`.
Rows sharing it keep their own id, builder, bearing and published dimension, and what changes is
the clearance the layout owes between them — a party wall (`PARTY_GAP`) instead of a 7 m street.
That is the same statement about the ground and it costs nothing.

| complex | rows | why it is one thing |
|---|---|---|
| **forum-valley** | Temple of Jupiter, Tabularium, Forum Romanum, imperial fora, Basilica Ulpia, Trajan's Column, Trajan's Market | one continuous masonry front from the Capitoline platform to the Quirinal slope. The Tabularium is built into the saddle *below* the temple and its façade **is** the Forum's west wall; the Forum of Nerva is the *transitorium* joining the Forum Romanum to the chain; the Basilica and the Column stand **inside** Trajan's Forum; the Market's lowest storey **is** that forum's north-east retaining wall. The Clivus Capitolinus, the Argiletum and the Clivus Argentarius are internal passages of the complex, not streets between free-standing monuments. |
| **campus-medius** | Stadium of Domitian, Baths of Nero, Pantheon, Baths of Agrippa, Iseum Campense | Agrippa built the Pantheon, the Basilica Neptuni and his baths as one insula-block; Nero's baths abut it on the north-west; Domitian's stadium abuts those. The Serapeum's west wall and the Baths of Agrippa's east wall are contiguous on the Severan Marble Plan. Every consecutive pair is within 35 real metres. **This is the merge §7.8 called for as "merge 6" and rejected on the evidence then available** — it said folding the Thermae Neronianae in *"does not fix the problem, it moves it to the Area Sacra"*. It was measuring the Baths of Nero 180 m from where they stand. |
| **pompey** | Theatre of Pompey, Porticus Pompei, Area Sacra | the porticus is the theatre's own *porticus post scaenam* and they share the scaena. The Curia Pompeia — the exedra where Caesar was killed — is the porticus's east end and its back wall is the Area Sacra's west boundary; the survey's own Area Sacra `cite` already said *"the Curia of Pompey stood behind them."* Measured at −12.0 real metres. |
| **colosseum-valley** | Colosseum, Ludus Magnus, Baths of Titus, Baths of Trajan | the brief named this one. Domitian built the Ludus as part of the amphitheatre's service complex, joined to the arena by a tunnel; the Baths of Titus stand on the terrace directly above it; Trajan's platform is built over the Domus Aurea whose grid Titus's block still follows. Every member is within 39 real metres of another. |
| **octavia-marcellus** | Porticus Octaviae, Theatre of Marcellus | they abut; and see §8.2 for why they used to appear to overlap by 49 m. |

Five complexes, 21 of 35 rows — against §4.5's five complexes over 12 rows. §4.5's `capitolium`
and `imperial-fora` are folded together into `forum-valley`, because the Tabularium/Forum pair
needs the same licence and splitting them would have drawn a street through the Forum's west end.

### 8.4 The authored floor: 0.339, and what stopped it

**`PLAN_SCALE` is abolished.** In its place `RomeMonument.draw` records, per row and beside the
real published dimension, what fraction of it is drawn. A row with no `draw` is drawn at **full
published plan** — the default is now 1.00, where it used to be an invisible 0.65.

The allocation is **max-min, then raise**, and both halves matter:

1. binary-search the largest *uniform* scale at which no pair is short of what it is owed. That is
   the largest achievable value of the minimum, so no row can be raised without pushing another
   below it. **This number is the floor.**
2. then, largest real plan first, lift each row as high as it will go without creating a fault.

§7.8's solve was greedy — worst pair first, shrink the larger — and greedy is the wrong algorithm
here, because the quantity that matters is the *smallest monument on the map*. Run on this survey
it settles the Basilica Ulpia at **0.20**, a 130 m basilica drawn 26 m long, while the forum it
stands in keeps 0.47 — when both can stand at 0.46.

**The floor is 0.339**, against §7.8's 0.36 — and the two numbers are not comparable in the
direction the digits suggest. §7.8's 0.36 still had three pairs inside the 7 m street and drew a
**68 × 56 m Colosseum**; this allocation has **zero** pairs short of anything they are owed, and
nine of twenty-seven monuments are at full published plan on all three axes, which was not
possible at all under a global scale. What it costs is named in §8.5a: the Colosseum is drawn at
0.573 and the Castra Praetoria at 0.326 (0.190 as phase 2 shipped it), and neither of those is
set by a neighbour.

**A licence mechanism was built, measured, and removed, and the measurement is the useful part.**
`RomeMonument.abuts` briefly let a named pair be **skipped by the conflict solve entirely**, with
a three-limb rule for when a pair qualified. It produced a much better headline — an authored
floor of **0.444** against 0.339 — and the external gate priced it immediately:

| | with `abuts` exempting eight pairs | with the same pairs capped at 2.4 m |
|---|---|---|
| authored floor | **0.444** | 0.339 |
| worst monument/monument interpenetration | **58.0 m** (Colosseum / Ludus Magnus) | 2.4 m |
| `probe-fabric` G1, footprints intersect | **FAIL**, 8 pairs, 16,221 m² | **PASS** |
| G15, one monument's stone inside another's plot | **FAIL**, 40,412 vertices, 26 pairs | 3,205 vertices, 11 pairs |
| `probe-fabric` verdict | **2/21** | 3/21 |

**An exemption from a check is not a weaker check, it is no check** — and it bought thirty per
cent of footprint by putting fifty-eight metres of the Ludus Magnus inside the Colosseum. What
survives is the bound rather than the exemption: two rows in one `complex` may interpenetrate by
at most **2.4 m**, which is `probe-fabric`'s own `ABUT_DEPTH_M` less a tenth, so a licensed
abutment is licensed by the external instrument and not merely by this file's opinion of itself.
If a constraint has to be relaxed, relax it to a number something outside the file also believes.

**And with the ratio fixed (§8.5b) the floor stopped being worth fighting for.** Once `drawY`
defaults to `draw`, a monument at 0.34 is a correctly proportioned smaller model rather than a
squashed one, so the marginal value of the last tenth of footprint collapsed at exactly the moment
its price became visible. Both halves of that trade were measured on the same afternoon.

### 8.5 The three east–west unabsorbable pairs — all three dissolved

§7.8 named three pairs that no floor could fix because they conflict east–west, where `KX` cannot
move, and said the decision belonged to the owner. **None of them exists any more, and not one was
fixed by geometry.**

| §7.8's pair | what it really was | what it is now |
|---|---|---|
| **Colosseum / Ludus Magnus** — *"170 real metres apart east–west, which is 75 world metres, against 113 m of footprint at the seed"* | real | **a licensed authored abutment.** The Ludus is joined to the arena by a tunnel and is part of the amphitheatre's own service complex; the Colosseum is an *ellipse* modelled as a rectangle and the Ludus sits in the empty corner. The Colosseum is drawn at 108 × 89, the largest footprint the +Z edge allows it — see §8.5a. |
| **Agrippan complex / Baths of Nero** — *"125 real metres apart in `e` and 3 in `n`: 55 world metres against 69 m of footprint even at a third of plan"* | **a survey error** | the Baths of Nero were 180 m from where they stand. At the true position they are 250 m apart in `n`, they are in the same complex, and the pair does not exist. §7.8's own note that merge 6 *"does not fix the problem, it moves it to the Area Sacra"* was measuring the wrong coordinate. |
| **Oppian baths / Ludus Magnus** — *"195 real metres in `n`, with the Ludus squeezed from two sides"* | **a survey error plus a rectangle artefact** | the Baths of Titus were 44 m out; corrected, the pair goes from −26.7 to **+19.0** real metres. The residual is licensed inside `colosseum-valley`. |

**The recommendation is therefore that there is nothing here to decide.** Two of the three were
measurement faults in the survey and are gone; the third is one named licence with its reason
beside it. Nothing was shrunk to make a third monument fit, which was the thing the brief
explicitly forbade.

### 8.5a The Colosseum cannot be drawn at full size, and that is a new measurement

The allocation caps every monument's drawn footprint at the **+Z edge of the heightfield**, and
the Colosseum is the row that cap binds hardest: it is drawn at **0.573 of plan, 108 × 89 m**.
(This section shipped saying 0.548 and 104 × 85; those were a working value from an earlier
allocation and never reached `survey.ts`. Same for "the Castra Praetoria at 0.228" below, which
shipped as 0.190 and is 0.326 as of phase 3 — see §9.2.)

The arithmetic is short. Its centre projects to z **1335.1**; the ground stops at `HALF_EXTENT` =
1400; so it has **64.9 world metres** of southward room. And a 189 × 156 m plan turned 115°
reaches `|hw·sin(rot)| + |hd·cos(rot)|` = **118.4 m** south at full size — 1.42× its own local
half-depth, because the rotation swings the long axis into `z`. 64.9 / 118.4 = 0.548 on the
local half-depth; the shipped row is 0.573, which is the same cap taken against the *reserved*
box and rounded to the value the allocator returned.

**Three things about that are worth stating separately.**

1. **RETRACTED. No tree has ever drawn the Colosseum over the edge.** This item shipped as
   *"the shipped map is already over the edge and nothing measured it… the Colosseum's south
   corner stands at z 1412, twelve metres past the last row of the heightfield"*, and a ground
   judge re-derived it from the frame's own anchors: an *unresolved* 0.65 Colosseum reaches z
   **1408.7**, so the projection arithmetic is right to 3 m. **It is wrong about the map.** On
   `bc2e0f2` the Colosseum does not stand at its surveyed position at all — `resolveOverlaps`
   pushed it 33 m north, to (629, 1302) — and its drawn stone stops **29.3 m inside** the edge. On
   `main`, at `KZ` = 0.222, it is 286 m inside. The overhang describes a hypothetical tree.

   The irony is worth the sentence, because it is the only argument this retraction hands back:
   among the things the resolver was doing was keeping the map's signature building on the map.

   **What survives, and it is the part that mattered.** A cap at `HALF_EXTENT` is right;
   `maxDrawAt` is the right shape for it; and measuring the **true oriented reach** instead of the
   local half-depth is a real fix — `offMapSouth` tested the box's half-depth *in the monument's
   own frame*, 83.5 m, rather than its 118.4 m extent along world `z`, and that approximation was
   harmless under one shared plan scale and is not harmless under twenty-seven. The decision
   stands; one of the two arguments offered for it does not, and a decision the owner is invited
   to overturn in one line should not be defended with a number about no tree that exists.
2. **The membership test had to stop depending on the footprint.** With `draw` authored per row,
   `w.z + hd·draw > HALF_EXTENT` is circular — a monument would be deleted from the map for the
   crime of being drawn at its real size, which is exactly what happened on the first run of this
   allocation: the Colosseum was silently dropped and the table cheerfully reported it at 1.000.
   `offMapSouth` is now the **centre** test, which at `KZ` = 0.35 returns precisely the five
   monuments the owner agreed to lose, and the edge is a separate cap on `draw` (`maxDrawAt`).
3. **This is the sharpest measurement of what `KZ` = 0.35 costs, and §4.5 did not have it.** §4.5
   lists the Colosseum among the monuments that *survive* the frame change, and it does survive —
   at 55 % of plan. A frame that puts the map's signature building 65 metres from the edge of the
   world cannot draw it at full size, whatever else is done about footprints.

**The decision, taken here because the owner is not available and recorded so he can overturn it
in one line:** the cap stays at `HALF_EXTENT`. A monument standing on ground that does not exist
is a worse fault than a monument drawn at 55 %, the overhang is invisible from inside the city and
obvious from anywhere else, and "correct by construction" is the whole point of this phase. The
alternatives, both of which need the owner:

- **an overhang budget** — allow the drawn footprint past `HALF_EXTENT` by a stated number of
  metres. Today's map spends 12 m of one without saying so. At 55 m the Colosseum reaches full
  plan. `heightAt` clamps at the edge, so the ground query stays well defined; what is undefined
  is whether the rendered terrain mesh or `buildFarHills` covers the gap, and that is one
  screenshot to settle.
- **`KZ` = 0.30**, which §4.6 already names as the fallback. It moves the Colosseum north and
  costs the Palatine and the Caelian.

*What would change my mind on the Ludus Magnus's bearing:* a published plan giving its own axis. Its bearing is
the one number this pass changed on an argument rather than a measurement — 55° → 112°, on the
grounds that a building put up in the amphitheatre's own campaign shares the amphitheatre's grid
and the Via Labicana's line, both of which run WNW–ESE. The plate's ink in that window reads 84°
at a coherence of 0.10, which is too low to be evidence either way and is recorded so that nobody
quotes it as such.

### 8.5b Heights: `draw` was compressing two axes out of three

**The ground judge shot this branch's uncommitted work and measured the fault that mattered most,
and it was not one this phase was looking for: Rome's monuments read 1.54× too tall for their
width.**

`place()` scales the footprint; the placement matrix in `buildLandmark` left Y at 1.0. That is
inherited from `PLAN_SCALE`, and the old code said so with some pride — *"heights are not scaled,
only the plan, so the Colosseum remains six times the height of the curtain beside it."* Applied
to one shared 0.65 it is a uniform 1.54× vertical stretch on every monument in Rome. Applied to a
**per-monument** authored footprint it is worse, because the stretch then varies row by row: at
this table's floor the Pantheon would be drawn 37 × 26 m at its true 43 m height, a
height-to-width ratio of **1.65 against the real building's 0.74**. That is not a smaller
Pantheon, it is a different building — and this phase was about to author twenty-two of them.

So `RomeMonument.drawY` exists and **defaults to `draw`, not to 1**. A monument is scaled
isotropically: a smaller model of the real thing rather than a squashed one. The rows carrying no
`draw` at all were already right by accident, being 1.00 on all three axes, and this generalises
them.

**What it costs, because the objection is real.** The Colosseum comes down from a 48 m attic to
27 m. That is a visibly lower skyline, and it is the price of the proportion being right. A row
may set `drawY: 1` where a building's height genuinely is its identity; **no row does**, and any
that does has to argue for it in its own `cite`.

**It also changes the trade this phase was making.** The instruction had been to push the footprint
floor as high as it would go, on the theory that a shrunken monument reads small at eye level. The
measurement says the fault was anisotropy, not size — so a *lower* floor applied to three axes
beats a *higher* floor applied to two, and the floor stops being the thing to optimise past the
point where it costs a licence. That is why §8.4's licence list stops at seven and not at nine:
three of the nine went stale when the Baths of Titus moved to its plate control, and with the
ratio fixed there was no longer a reason to hunt for replacements.

*What would change my mind:* a render from the Porta Flaminia showing the Colosseum reading as a
drum rather than an amphitheatre at 27 m. `docs/CITY-GROUND-JUDGE.md` lists every camera's
coordinates, so this is one screenshot from a named position rather than an argument.

### 8.5c The stone the player sees now fits the box the game collides with

`probe-fabric` G14 measured **13 of 26 monuments drawing stone beyond their own collision box,
worst 34.8 m per side.** That is a different fault from everything above — nothing to do with
placement — and it was worth fixing in the same pass because a monument whose masonry overhangs
its reserved ground is a monument the fabric grows into, and the fabric is phase 5's problem
already.

**One structural cause and one class of transcription error.**

The structural one: `buildLandmarks` published each collision box at `hw * 0.88`, and combined
with `PRECINCT = 1.07` that made the box **0.9416× the surveyed rectangle**. So a builder that
honestly drew its published dimensions already read 1.062 against a 1.15 gate and had 8 % left for
steps, roofs, aprons and plinths — eleven of twenty-six sat in that band with nothing to spare.
The `0.88` was an unexplained constant doing the opposite of what its comment said. It is now
`hw / PRECINCT`: **the collision box is exactly the published building and the precinct apron is
the walkable margin**, which is what the comment always claimed.

The transcription class: builders passed literals that contradicted their own survey row. The
Baths of Trajan drew **330 × 215** against a row of `230 × 170` and a `cite` that says in as many
words *"the bathing block is what is modelled"* — a 1.435 ratio and the worst overhang on the map.
The Castra Praetoria drew 440 × 380 against a row of 400 × 377 whose `cite` says *"modelled
400 × 377"*. The imperial fora drew a width of 130 against `wid: 100`, a figure the survey has
nowhere. All three now derive their extents from the placement, so they cannot part company again.

Beyond those, seven builders drew *outward* from their own boundary: `buildPrecinct` hung its
entablature at +7.5 and its eaves at +8.2 **outside** `L × W` and, where walled, the enclosure a
further metre outside that; `buildBasilica` centred its end apses **on** the end walls, adding
39.6 m to a 130 m hall; `buildForum` put its flanking ranges at `W/2 + 20`; `buildMarket` used the
half-**length** as the hemicycle's **radius**, so a 120 m curve sat in a 70 m box. Each is a change
of datum rather than of architecture.

And `buildMound` drew a **circle** against a rectangle. The Capitol's `moundRadius: 96` on a
63 × 53 podium is a 3.85× ratio on the short axis, and the probe's nearest-owner vertex
attribution charged part of that skirt to the Tabularium 30 m away — which is how a building with
no fault of its own appeared in the failure list. The mound is elliptical now, inscribed in the
reserved rectangle by default. **It still does not pass, and cannot**: the Capitoline hill really
is twice the size of the temple on it while the collision box is only ever the temple. That is
stated in the code rather than tuned away.

**Result: G14 goes 13 of 26 → 6 of 27**, and every monument named in the original list is off it.
The six that remain all fail on the **short** axis while their long axis reads under 1.0, which is
the signature of the probe attributing a neighbour's vertices rather than of a builder drawing
outside itself — Rome emits its monuments in three depth bands (`monuments-a/c/d`) rather than one
chunk per monument, so every vertex is attributed **positionally**. Emitting one chunk per
landmark would make G12-drawn, G14, G15 and G16 exact, and it would multiply the monument draw
count by nine. **That is a draw-budget decision and it is phase 6's**, recorded here so it is not
rediscovered.

### 8.6 What was deleted, and one thing that was not

Deleted from `layout.ts`: `resolveOverlaps`, `separation`, `confine`, `nearbyDrift`, `PLAN_SCALE`,
and the solver constants `ORDER_FLOOR`, `HOLD_MARGIN`, `HOLD_WEIGHT`, `ORDER_WEIGHT`, `RELAX`,
`SPRING`, `Z_AXIS_COST`. Deleted from `survey.ts`: `ROT_RATIO`.

`idealX` and `idealZ` were **kept** and are now provably equal to `x` and `z`. Three instruments
read them — `probe-fabric`, `city/preview.ts` and `city/plan.ts` — and a displacement reported as
**0.0 m** by the instrument that was reporting 398.9 m is better evidence than a field that
quietly stopped existing.

**`TOPOLOGY` was kept, against §5's instruction, and the reason is worth writing down.** §5 lists
it for deletion because it was the solver's constraint set — the adjacency facts were fed to
`resolveOverlaps` as hard constraints, which is where its `holds` array came from. That use is
gone with the solver. But `TOPOLOGY` is also an *independently written* statement of Rome's
adjacency — the Circus in the Vallis Murcia between the Palatine and the Aventine, the Colosseum
east of the Forum — and with every position frozen at `worldOf(e, n)` it becomes exactly what
`MAP-METHOD.md` rule 6 asks for: a check on the survey whose reference is outside the survey.
**It is the only thing in the tree that would have caught this pass mistyping one of the five
corrected coordinates.** Deleting a check because a solver used to borrow it is the wrong reason
to delete a check.

`ROT_RATIO`'s deletion carries a small lesson of its own. The constant was 1.45 and the frame's
true anisotropy is 1.266, and the gap was never an error: it was an **empirical** anisotropy,
fitted to the plan *after* the resolver had spread it east–west, and it existed to correct for the
solver rather than for the projection. With the solver gone the factor cancels inside the `atan2`
entirely, so the correct correction is identity and the constant is removed rather than re-fitted.
Worst bearing change: 3.78°, toward the surveyed value.

### 8.7 The external gate: 7/21 → 5/21, and why that is not a two-check regression

`tools/probe-fabric.mjs` at `d8eef08`, carried in this branch **byte-identical** — it was on
neither `main` nor phase 1's branch, so it had to be brought in, and bringing it in unmodified is
the point. Carthage is **12/21 before and after**: nothing in this pass touched it.

| | phase 1 | phase 2 | |
|---|---|---|---|
| **G1** monument footprints intersect | PASS | **PASS** | |
| **G2** building inside a monument | PASS | **PASS** | |
| **G6** monument inside the curtain (plan) | PASS | **PASS** | 2,837 m² at one point in this pass; 0 now |
| **G7** drawn wall stone inside a monument | PASS | **PASS** | 13,651 sampled vertices at one point; 0 now |
| **G16** monument stone inside a building | 1,478 vertices, 24 buildings | **PASS, 0** | gained |
| **G8** monument keeps its street | PASS, min 11.98 m | FAIL, min **0.66 m** | **the complexes** |
| **G15** monument stone inside another monument | PASS | FAIL, 3,205 vertices / 11 pairs | **the complexes** |
| **G9** monument keeps the *ambitus* | PASS, min 1.84 m | FAIL, min **0.69 m** | Ara Pacis / insula |
| G4 monument in a carriageway (plan) | 23,806 m² / 57 / 18 | 21,815 m² / 60 / 19 | −8 % |
| G5 drawn street under a monument | 9,153 of 123,138 vertices | **3,379 of 76,973** | **−63 %** |
| G14 drawn stone outside its own box | 13 of 26, worst 34.8 m | **5 of 27**, worst 35.4 m | −62 % |
| G12 published aspect ratio | 3 out of tolerance | **1** (`stadium-domitian`, drawn) | −67 % |
| G13 one compression for the cohort | 1 out of tolerance | **7** | **by design** |
| G11 every sourced monument present | FAIL | FAIL | unchanged, approved |
| **verdict** | **7/21** | **5/21** | |

**Three of the four losses are the gate encoding an assumption this phase was told to overturn,
and they should be read as such rather than fixed.**

- **G8 and G15 are the complexes.** G8 requires 7 m of clear ground between *every* pair of
  monuments; G15 requires that no monument's stone stand inside another's plot. Both are correct
  for free-standing monuments and both are false about Rome: the Basilica Ulpia stands **in**
  Trajan's Forum, the Curia Pompeia's back wall **is** the Area Sacra's west boundary. The worst
  figures are 0.66 m of clearance and 3,205 vertices, all of them inside a declared `complex` and
  all of them within the 2.4 m the gate's own `ABUT_DEPTH_M` allows for a joint. **The gate has
  the machinery already** — it excludes "same-owner joints" where `a.id === b.id` — and what it
  needs is to read `RomeMonument.complex` and treat a complex as one owner.
- **G13 is the per-monument authored footprint.** Its premise, in its own words, is that *"a map
  may compress plan uniformly, but it may not compress one monument differently from another"* —
  which is exactly what §4.5 instructed this phase to abolish, and with reasons. It will now fail
  on every future Rome build. It should either gate the **declared** departure (does the built
  extent match `draw × len` to 0.25 m?) or be retired for Rome.
- **G9 is real and it is not mine to fix.** The Ara Pacis is 11.6 m across, is now drawn at full
  published plan for the first time, and the insula generator has left it 0.69 m instead of the
  1.5 m *ambitus* of the Twelve Tables. That is a keep-out margin in `planDistrict`, phase 5's, and
  it is one of a family: G3, G10, G17–G21 are all the fabric layer and all unchanged by this pass.

**Two changes the gate needs that this pass deliberately did not make**, on top of the two above —
because a phase that edits its own gate cannot report a before and after:

1. **G11 needs an "absent because off this map's frame" category.** It already has
   `absentExpected` for "absent because anachronistic", used once for the Baths of Diocletian. The
   Circus Maximus and the Baths of Caracalla are missing by an approved design decision.
2. **There is no water check.** `heightAt` appears once in 2,006 lines, in G19's denominator. §7.9
   measured 60 of 1,259 solids entirely below `WATER_LEVEL` and called the fix *"one line against
   `heightAt`"*. The judge's own grader does have one, and it reports **two landmarks with their
   centre in the modelled channel: the Tiber Island, which is `onRiver` by design, and the Theatre
   of Marcellus, which is 16 world metres into the water after being moved 39 m to its plate
   control.** Reported and not nudged, per the brief: the modelled channel is a fixed analytic
   curve, `e/terrain/tiber-resurvey` is re-surveying it, and a monument should not be moved off
   its plate position to satisfy a river that is about to move.

### 8.8 What phase 3 inherits

- **The plate is now an instrument, not just a picture.** `tools/scratch/rome-landmarks.mjs
  --plate` draws any window of the survey onto the georeferenced Lanciani raster or the AGEA
  orthophoto, in survey metres, with a metre grid, in about a second and with no browser and no
  dev server. Every correction in §8.2 was found with it. `--realgaps`, `--floorsweep` and
  `--audit` are its arithmetic halves; `--audit` exits non-zero on a fault and is the regression
  gate for this phase.
- **A limitation of that instrument, measured, and worth knowing before anyone trusts a reading.**
  The plate resolves 1.709 m/px, which is fine for a footprint and not fine for a label: at the
  zoom where a monument fills the frame, its inked name is illegible. Identification has to come
  from a labelled plate — Shepherd 1923 — or from the building's shape. Only the geometry comes
  from Lanciani.
- **A second limitation, and this one nearly caused a wrong answer.** `--realgaps`' first version
  had a sign error in the bearing convention that mirrored every box in `n`. It is invisible on an
  axis-aligned building and silently inverts every rotated one: it reported the Basilica Ulpia and
  Trajan's Column interpenetrating by 27.3 m when they are 8.2 m apart, and it reproduced §4.5's
  independently-computed "49 real metres" for Octavia–Marcellus closely enough to look like
  corroboration. It was caught by hand-computing one pair and comparing. **An instrument that
  agrees with the document it is checking is not thereby correct.**
- **Bearings can be measured off the plate, but not yet well enough to overturn a citation.**
  `--grain` runs a structure tensor over the black ancient ink inside a monument's footprint,
  masked away from Lanciani's red modern overlay so it measures Roman fabric rather than
  Umbertine streets. It is translation-invariant, so it is immune to any residual georeference
  offset — the one thing a *position* reading off this plate cannot be trusted about. It
  corroborates eight bearings within 6° (the Porticus Octaviae to 0.6°, the Castra Praetoria to
  2.6°, the Mausoleum of Hadrian to 3.6°), and its mean absolute error over 27 legible rows is
  **16.4° against 22.5° for a random guess**. That is real signal and it is not enough: per row it
  cannot tell a wrong bearing from a window full of the wrong ink. Masking to the monument's own
  polygon rather than its bounding box is the cheapest remaining fidelity win on this map.
- **The six missing Campus Martius monuments are still missing, deliberately.** Only
  `porticus-pompei` was added, because it is the other half of a monument the survey already
  claimed at 300 × 180 and because its position is measurable on the plate. §4.1's own rule is
  that *"a row exists only if it carries a real coordinate, a real published plan dimension, and a
  source; no row may be added from memory"*, and the Saepta Iulia, the Porticus Divorum, the
  Diribitorium, the Circus Flaminius, the Theatre of Balbus and the Hadrianeum cannot yet meet it:
  §7.5's back-conversion from `ROME.md` §6.3 inherits that gazetteer's own frame, and the plate
  cannot be read at label resolution to check them. They should be added in phase 3 from digitised
  control points — **and each one costs footprint the floor will have to pay for**, so add them
  and re-run `--floorsweep` in the same commit.
- **The digitising `MAP-METHOD.md` §3 asked for is now half done.** The five corrections in §8.2
  are, in effect, five control points read off the raster. Writing the remaining twenty into a
  table shaped like `probe-fabric`'s `PUBLISHED` turns position from a declared blind spot into a
  gate, and it is the single highest-value thing left in the fabric rebuild.

---

## 9. Phase 3, as built — the frame decision, size order, and four dead mechanisms

Phase 3 is the ground judge's own priority list, taken in its order, on
`e/city/rome-landmarks-p3` based on `e/city/rome-landmarks` at `6c975e8`. Its verdict was
**Rome 0.8 → 1.5 / 4, proceed, do not revert, not a sign-off**, and it named four things worth
the next pass. This section answers all four, plus the eight places where phase 2's record
states a number the tree does not carry.

**What did not change, because the judge said stop spending passes on it:** `KZ`, isotropy
(`drawY` defaulting to `draw`), the +Z edge cap, the deletion of `resolveOverlaps`, and every
monument's surveyed position except one declared override. The fabric's material is untouched.

### 9.1 `KZ` = 0.30 is not affordable, and the reason is that it is the wrong direction

**This was the judge's item 1 and it gates everything else, so it was measured first. The
recommendation has its sign backwards.**

`KZ` is world metres per real metre of northing: `z = Z0 − KZ·n`. **Lowering it compresses the
map further.** It was 0.222 and phase 1 *raised* it to 0.35, and `topography.ts:KZ` records why —
at 0.222 a true-depth insula did not fit between two projected cross-streets anywhere in the
Campus Martius's real 50–90 m pitch, so the fabric was arithmetically impossible to lay
(`MAP-METHOD.md` rule 10). Going to 0.30 walks back toward that.

The judge's own diagnosis is *"four of this document's findings are the same finding: the frame
is too small for the survey."* That is correct, and a frame that is too small is not repaired by
making it smaller. §4.6 is where 0.30 comes from, and it names it as the fallback for the
**opposite** contingency: *"if the Circus Maximus and the Palatine are load-bearing for the
skyline… then `KZ` = 0.35 is too aggressive and the answer is `KZ` = 0.30."* That is a trade of
fabric for backdrop, not a fix for crowding.

Measured, `node tools/scratch/rome-frame.mjs` (`--sweep=` is new, so the ceiling can be
bracketed without editing the file):

| | **0.30** | **0.35 — shipped** | 0.38 | 0.413 |
|---|---:|---:|---:|---:|
| anisotropy against `KX` = 0.443 | 1.48× | **1.27×** | 1.17× | 1.07× |
| conflicting monument pairs at PS 0.65 | 18 | **14** | 11 | 7 |
| cross-street pitch, median of the real 50–90 m | 21.0 m | **24.5 m** | 26.6 m | 28.9 m |
| **a true-depth insula (30 m) fits over…** | **0 % of the range** | **11 %** | 28 % | 43 % |
| Campus Martius band depth | 613.5 m | **715.8 m** | — | — |
| monuments on the map | 22 | 20 | 18 | 15 |

**Every column the judge expected to improve gets worse.** The 0.339 floor is set by crowding,
and 0.30 adds four conflicting pairs; the Castra Praetoria's constraint is its own projected
depth, and 0.30 takes that from 133 world metres to 114; the Mausoleum's share of the street
cross-section is a pure `KX` quantity and 0.30 does not touch `KX` at all, so the one finding it
cannot help is the one the judge ranked second. What 0.30 buys is two monuments back — the
Palatine and the Caelian villas — at the price of the insula module going arithmetically
impossible again.

**And the cost is not only geometric.** Re-run at 0.30 without re-authoring anything and the
allocator reports **22 faults**, minimum clear gap **−59.9 m**, three monuments hanging over the
heightfield: the twenty-three `draw` values in `survey.ts` are a solution to the 0.35 packing
problem. A `KZ` change also means regenerating `TIBER_PATH` and `TIBER_MEAN_SLOPE` by hand (they
are stored in world metres) and re-deriving four targets that are pinned to the current value —
the 650 m band depth, the 22 m pitch, the five named off-map rows, and `RING_TOLERANCE`'s 15°,
which is justified in its own comment by the anisotropy. Three of `assertRomeFrame`'s checks
would go red **for reasons about their own targets rather than about the map**, which is
`MAP-METHOD.md` rule 12 exactly: a constant appearing in a formula is not the same as a constant
the formula is about.

#### So which way, and how far?

Upward, and there is almost nothing there. The ceiling is the Colosseum. Bracketed at 0.005:

| `KZ` | 0.350 | 0.355 | **0.360** | 0.365 |
|---|---|---|---|---|
| Colosseum | on the map | on the map | **off the +Z edge** | off, and the Ludus with it |

**The feasible window for `KZ` is [0.3334, ~0.357].** The floor is arithmetic — a true-depth
insula needs 30 world metres and the widest real cross-street pitch is 90 m, so `KZ ≥ 0.3334` or
the module does not fit anywhere. The ceiling is the map's signature building leaving the
heightfield. **The window is 0.024 wide and 0.35 sits in the top third of it.** There is no
version of this decision that is worth a pass.

**Verdict: `KZ` stays 0.35. Not deferred — closed, with the sweep in the file that can reopen
it.**

**What would change my mind.** One thing only, and it is not `KZ`: **`HALF_EXTENT`.** The window's
upper bound is entirely the heightfield's 1400 m edge against the Colosseum's projected position.
Raising the heightfield is a terrain change that touches every map and is not this branch's to
make, but it is the only lever that buys depth without buying compression, and it is worth pricing
before anyone reaches for `KZ` again. At isotropy (`KZ` = `KX` = 0.443) the anisotropy problem
disappears entirely, the insula module fits over 43 % of the range, and conflicting pairs halve to
7. That is the frame Rome wants and it needs a bigger ground, not a different projection.

### 9.2 The Castra Praetoria: a frame problem stated as a footprint problem

The judge's sharpest single observation, and it turned out to be about a mechanism that did not
exist. `atWall` — *"fraction of the footprint's depth that may sit north of the wall crest"* —
was declared in `survey.ts`, documented at length, copied onto `LandmarkPlacement` by `place()`,
**and read by nothing**. Neither was `drawMax`, anywhere in `src/`. Neither was `maxDrawAt`,
which has no callers at all. So "no barracks stand outside the curtain" was enforced by a
hand-transcribed `draw` and by `probe-fabric` G6 noticing afterwards.

With the centre pinned at `worldOf(e, n)` the camp stands 59 world metres inside its own north
wall and needs 260 m of half-depth to stand behind it, so the largest honest footprint is
**0.1997** — measured on the true oriented outline, which makes the shipped 0.190 right to three
per cent and the arithmetic printed for it wrong three ways over (it used a centre z of 733.5
against the built 726.096, paired it with the precinct-inflated half-depth, and measured the
crest at the centre's own x). That draws a 437 m fortress at 76 × 72 m, which reads as a walled
farmyard and — the judge's point — *as smaller than the stretch of curtain in front of it*.

**The camp's north wall is the curtain.** That is the archaeology, and it is what this row's own
`cite` spends a paragraph establishing from three plate corners; the *centre* is a derived
midpoint. So `atWall` is implemented and the row is placed by that edge instead. Ceilings at the
new anchor, on the true oriented outline:

| anchored by | ceiling | drawn | binds on |
|---|---:|---|---|
| centre (as shipped) | 0.1997 | 80 × 75 m | the curtain, 2.7 m clear |
| **north edge — shipped now** | **0.326** | **130 × 123 m** | the camp's own surveyed east return |
| north edge, using `offMapEast` | 0.674 | 270 × 254 m | the heightfield's east edge |
| north edge, `CITY_Z_MAX` only | 1.301 | — | — |

**1.7× in both axes**, and the camp's `drawMax` size inversions fall from **9 to 2**. The
conservative ceiling ships because the looser one crosses the east return, which `circuit.ts` has
not built yet but will.

**One implementation note, because it cost a round of gate failures.** Anchoring at
`wallCrestZ(x_centre)` fails: the crest slopes 0.249 world metres south per metre east across
this run and a box turned 115° has its northernmost corner ~17 m east of its centre, where the
crest is already 4 m further south. `probe-fabric` G6, G7 and G16 all failed on the first
attempt. The shipped version solves the deepest incursion over all four corners; shifting `z`
translates every corner equally and moves no corner's `x`, so one pass is exact.

The 25–38 m southward shift is a **declared placement override**, printed by name with its `dx`
and `dz` at every boot and gated at 120 m — the same treatment `farBank` gets, for the reason
§9.4 gives.

### 9.3 Size order is now an invariant, and what it cost

Phase 2's headline — *"0 of 860 spatial relations inverted"* — is a **proof rather than a
measurement**: `worldOf` is strictly monotone in both axes, so with every centre frozen it
cannot invert a position. It is worth printing and it covers half the claim a survey row makes.
Nobody asked the other half. Measured independently here: **52 of 331 size relations reversed**,
one in ten among pairs close enough to share a frame, against **zero** under the uniform
`PLAN_SCALE` it replaced — because a uniform scale preserves order by definition and a per-row
allocation driven by **crowding**, which is uncorrelated with real size, has no reason to.
`MAP-METHOD.md` rule 17.

The relation is now enforced in three places, and the placement matters more than the count:

1. **`assertSizeOrder()` in `src/`**, live at every boot: **0 of 43**.
2. **The allocator's own `faultsAt`**, so the max-min floor and the raise pass are *bound* by it
   and cannot produce one. A check that only reports is what let 52 inversions ship under a
   headline of zero.
3. **`rome-landmarks.mjs --audit`**, which prints the count at five separation bands and at a
   tighter 5 % deadband, so the gate's locality cannot hide the answer.

**The gated relation is local, and that is measured rather than chosen.** `VISUAL-RUBRIC.md` H8's
own tell is *"two monuments **visible in one frame**"*. The judge's `lm2-colosseum-200m.jpg`
stands 200 m from a 108 m amphitheatre at a man's eye and **the Colosseum is not in the
picture** — a sliver of attic over a roofline. If Rome's largest monument is hidden by its own
fabric at 200 m, two monuments 400 m apart are not one view. `FRAME_RANGE` = 150 m.

Global monotonicity was tried first and is not affordable, for a measured reason: three 120 m rows
sit at the 0.339 floor inside dense complexes where they cannot grow, so global order caps *every*
shorter monument in Rome at their 41 m drawn length — the Pantheon 59 → 41 **and** the Mausoleum
of Augustus 87 → 41. That trades the pass's clearest architectural gain for a relation nobody can
see.

**The cost, stated plainly, because it is real.** Five rows re-authored:

| row | phase 2 | **phase 3** | why |
|---|---:|---:|---|
| `pantheon` | 0.704 (59 m) | **0.484 (41 m)** | capped by the Baths of Agrippa **54 m away**, real 1.43× and drawn 0.69× — the judge's own worst in-frame pair |
| `forum-romanum` | 0.731 (146 m) | **0.561 (112 m)** | the Imperial Fora, 250 real m, cannot exceed 112 |
| `porticus-octaviae` | 0.532 (70 m) | **0.462 (61 m)** | order against its own complex |
| `theatre-marcellus` | 0.339 (44 m) | **0.407 (53 m)** | *raised* — the floor was starving it |
| `castra-praetoria` | 0.190 (76 m) | **0.326 (130 m)** | §9.2 |

The Pantheon losing 18 m is the sharpest cost in this pass and it is the frame's bill, not a
preference: the Baths of Agrippa at 0.70 are **30 m short of the Theatre of Pompey**. The
Mausoleum of Augustus keeps its full 87 m and its terminus.

**And one inversion is kept deliberately.** The Tabularium (73 m real) is drawn smaller than the
Temple of Jupiter (63 m real) it is 1.16× the length of — the judge's sixth headline pair. 73
against 63 is inside the 20 % deadband, so the survey is treated as asserting no order there and
the ranking is the author's; the Capitolium is the datum the entire survey is measured from and
already reads as a warehouse with a gable. The `--audit` band table prints this at the 5 %
deadband so the choice is counted rather than absorbed.

### 9.4 Four checks that were measuring their own absence

- **The displacement check.** *"Every monument centre at `worldOf(e, n)`: worst 0.0 m"* skipped
  `farBank` and `onRiver` — the only rows whose x does **not** come from the affine map, which is
  to say the only rows that can be displaced. The Janiculum Ridge stood **404 world metres** from
  its survey row and had moved **715 m** in the phase whose headline was zero. `FAR_BANK` is now a
  **bound and not a position** (`Math.min(w.x, …)`), which returns a 520 m planted ridge to its own
  row while keeping the clearance for the 64 m drum the mechanism was built for; and every
  override — `farBank`, `onRiver`, `atWall` — prints its name and its `dx`/`dz` every run, gated at
  120 m. `MAP-METHOD.md` rule 16. `e/terrain/tiber-resurvey` reaches the same `Math.min` shape
  independently, from the other side of the same fault; that is the hunk the two branches must
  merge, and `100` against `90` is all that is left to reconcile.
- **`ABUT_DEPTH` existed nowhere in `src/`.** `assertNoFootprintOverlaps`'s docstring said the
  abutment population was *"gated at `ABUT_DEPTH`, not exempt"*; `ok` was `pairs.length === 0`,
  abutments were pushed to an array and printed, and the only place the bound lived was the
  offline script that granted the licence. It is now a real constant that gates, at
  `probe-fabric`'s own 2.5 less the allocator's reserve, and the `soft` skips are named.
- **Check 6 could not fail.** `pending` was set `fp.ok ? null : '…'` — non-null exactly when the
  check failed — and `faults` filters on `pending === null`. A real monument-in-a-street
  regression rendered as PENDING and left `frame.faults` empty. The scope note belongs in the
  target string; the monument population gates.
- **Check 8b's exclusion predicate was dead code** — it tested for `farBank`/`onRiver` and then
  did nothing, so those rows were measured anyway. That was the *correct* behaviour and the only
  reason the Janiculum's 8 m clamp was visible at all; anyone tidying it into a real `continue`
  would have taken the number to 0.0 with no test to catch it. The intent is now written down, and
  `atWall` rows are genuinely excluded there — their z is deliberately moved, so measuring it as a
  *clamp* would make a working mechanism read as a frame fault — counted and named, and gated by
  the override check instead.

### 9.5 A complex must be one piece of fabric, and three of five are not

`assertComplexJoined()` asks the judge's question of the **published plans**, in real metres, with
no projection, no `PRECINCT` and no `draw` in the arithmetic — so it grades the *declaration* and
cannot be satisfied by shrinking anything. It reproduces the judge's finding exactly:

| complex | pieces | detached |
|---|---:|---|
| `pompey` | **1** | — |
| `octavia-marcellus` | **1** | — |
| `campus-medius` | 4 | `stadium-domitian`, `baths-nero`, `pantheon` |
| `forum-valley` | 5 | `basilica-ulpia`, `trajan-column`, `forum-romanum`, `trajan-market`, `imperial-fora` |
| `colosseum-valley` | 4 | `ludus-magnus`, `baths-titus`, `baths-trajan` |

`colosseum-valley` is the clearest error: it is two groups on two different levels, the Colosseum
and the Ludus in the valley and the Baths of Titus and Trajan on the Oppian terrace 38 real metres
away. That is not one continuous masonry front and no threshold makes it one.

**It faults at every boot and is deliberately not repaired here.** Narrowing a complex makes its
former members owe each other a 7 m *projected* street, which re-opens the allocation this branch
has just settled, and a change that moves the authored floor needs its own before and after rather
than being smuggled in beside four others. The instrument is what phase 4 argues with.

One implementation note worth more than it looks: the real-metre box convention is
`rot = atan2(cos θ, sin θ)` in an `(x = e, z = −n)` frame, and the sign is load-bearing.
`atan2(−cos θ, …)` mirrors every box about its own centre — invisible on an axis-aligned building,
silently inverting every rotated one. **That same error has now been made independently three
times**: by the offline allocator, by a judge's own probe (which reported the Basilica Ulpia and
Trajan's Column interpenetrating by 13.6 m), and by the first draft of this check, which reported
all five complexes detached including the two that genuinely abut.

### 9.6 The road, and the two numbers that were being conflated

The Via Lata's armature ran `[-497, 2045] → [-470, 1560] → [-440, 1080]`, which passes **14 real
metres from the centre of an 87 m tomb**. With `resolveOverlaps` alive that was invisible: the
solver had shoved the Mausoleum off its plate position and the road went through the hole.

The judge's fix is taken as given: *"bend the last hundred metres round the tomb's eastern flank,
as the real road did… that is not deflecting a street around a solver's fiction; it is drawing the
street where the street was."* The Via Flaminia ran along the Mausoleum's eastern side and the
tomb's precinct was its west kerb. 215 real metres out of the gate are dead straight — the frame a
player sees first after a breach is 30 m in, and the tomb still closes it — then the swing east
clears the precinct by 5.4 world metres of carriageway edge.

| | phase 2 | **phase 3** |
|---|---:|---:|
| `via-lata` carriageway inside masonry | 21 % | **13 %** |
| all ranked ways | 85/883 = 9.6 % | **76/877 = 8.7 %** |
| **the gate's straight normal**, first 700 m | 32 % (the judge) | **20.6 %** |

**The axis is not the road, and only the axis had been measured.** The judge's headline walks the
Porta Flaminia's own outward normal in 5 m steps; the Via Lata is not straight and `deflect` has
bent it round its monuments since phase 1. A column follows the way graph. `assertGateAxisClear`
now re-derives the axis number at every boot beside the carriageway one — a claim in the record
that no instrument in the tree can reproduce is a claim nobody can check — and both print. Neither
is gated: clearing the axis means moving a surveyed monument, which is the practice this rebuild
exists to end, and the judge's own §13 says the same. What remains on it is
`mausoleum-augustus` 145–235 m and `porticus-pompei` 590–635 m.

The 32 % → 20.6 % fall is mostly **not** the bend. It is §9.3: the Pantheon, the Baths of Agrippa
and the Porticus Octaviae shrank off the axis. Phase 1's 18 % is nearly recovered without moving
anything.

Per-way and per-monument, so the residual is a decision rather than a percentage:

```
via-recta     27% (stadium-domitian+pantheon+baths-agrippa+temple-isis)
via-labicana  27% (colosseum+ludus-magnus+baths-trajan)
via-sacra     19% (temple-jupiter+forum-romanum+colosseum)
via-lata      13% (mausoleum-augustus+ara-pacis+horologium+baths-agrippa+temple-isis+porticus-octaviae)
```

### 9.7 A keep-out instead of a non-intersection

`probe-fabric` G9 wants the XII Tables' 1.5 m *ambitus* between a monument and the fabric and was
failing at **0.69 m**; G16 wants no monument's drawn stone inside a building and was **passing on
where an insula happened to fall**, which this pass discovered by moving the Janiculum 404 m and
watching an unrelated insula land on the Theatre of Pompey. Monuments now reserve the ambitus plus
a metre of oversail, and both pass **by construction**. `PRECINCT` = 1.07 buys a monument 3.5 % of
its own half-width, about 1.3 m on the Pantheon, and two independent instruments say that is not
enough.

This is the floor and not the answer. The judge also wants the Pantheon's 60 m paved forecourt, and
that is a **plaza** — an authored piece of the plan with its own shape and paving — not a uniform
margin. Phase 5. Cost of the margin: `forum-boarium` 13 → 11 buildings, a quarter already reported
as buried.

### 9.8 The Theatre of Marcellus: measured on the merged tree, and left alone

Phase 2 flagged it and did not move it, on the ground that `e/terrain/tiber-resurvey` owns the
channel. The judge called that reasoning correct and the handling wrong, and asked for the monument
to stop rendering until the river moves. **Measured on both trees before deciding**, by bundling
each branch's real `topography.ts` and `heightfield.ts` and running `buildTerrain` at res 2049:

| at world (180.5, 1277.3) | this branch | `e/terrain/tiber-resurvey` |
|---|---:|---:|
| terrain datum | **1.519** (reproduces the judge's 1.52) | **7.800** |
| against `WATER_LEVEL` 5.0 | 3.5 m under | **2.8 m above** |
| box corners wet | 3 of 4 | **1 of 4** |
| whole survey, centre in water | 1 | **0** |

The re-survey moves the west bank from x −164 to x −120 and the channel's drawn span from 369 m to
132 m; the point ends up 169 world metres east of the new east bank, on the cut-bank terrace.
**The fault resolves on merge and the monument keeps rendering.** Suppressing it would hide a fault
whose principal component is already fixed by a written branch.

The residual is recorded rather than fixed: the box's south-east edge still clips the re-surveyed
reach, worst −3.6 m, needing **36 real metres east**. And one uncomfortable finding — **phase 2's
own 39 m plate correction caused it.** The base row `e −215 / n −78` is 0/9 wet on the re-surveyed
terrain; the shipped `e −252 / n −91` is 3/9. That is a `survey.ts` question and it can only be
answered honestly against the merged terrain, which is where it belongs.

### 9.9 What phase 4 inherits

- **The complexes** (§9.5). Three of five are not one piece; narrowing them re-opens the
  allocation. This is the highest-value item left and the instrument is in place.
- **The Theatre of Marcellus's 36 real metres**, on the merged tree (§9.8).
- **Per-builder height fidelity**, which is what is left after isotropy: the judge's method-B
  median is **1.42**, meaning the average monument is drawn 42 % taller than its own published plan
  warrants. `buildBasilica` 1.69, the Ludus 1.63, the Mausoleum of Hadrian 2.23. That is a list of
  builders with one number each, and nothing in this pass touched it.
- **Trajan's Forum still reads as a yard with a shed in it.** The Basilica Ulpia is 130 × 55 real
  and drawn 44 × 19; it is at the 0.339 floor and the floor is the frame. Not fixable by scale —
  §4.4's own hierarchy says *below about 0.6, stop shrinking and move something else* — and with
  `KZ` closed (§9.1) the something else is the complex narrowing in §9.5.
- **A door.** H7 has been 0 on both maps for three passes and it is `plot.frontSide` being
  `1 | -1`. Still the cheapest item on the list and still not done.
- **`maxDrawAt` has no callers.** It is the right shape for the +Z cap and nothing invokes it; the
  cap is honoured only because a human transcribed the allocator's answer into `draw`. Either wire
  it in as an assertion or delete it, but a function whose docstring says *"it is asserted at boot
  rather than trusted"* and which nothing calls is worse than neither.

---

## 10. §5 phase 3, as built — the roads

Built on `e/city/rome-roads` from `main` at `d1e85c0`. This is **§5's phase 3**, the road pass —
not §9, which is the landmark work's own phase 3 and is a different numbering that nobody should
have allowed to collide.

**The one-line verdict:** the armature is now authored in survey metres off the plates, projected
once, and there is no code path left anywhere that can move a way after it is drawn. `deflect`,
`monumentRings` and `feeders` are deleted. In the survey frame — against each monument's own
published footprint — **1.5 %** of ranked street length runs through a building, and thirteen of
the sixteen offending samples are the Via Sacra crossing the Forum Romanum, which is what the Via
Sacra did. §5's acceptance asked for ≤ 2 % against the plan's 24 %.

### 10.1 The Mausoleum of Augustus was never on the Via Lata

This was posed as the one conflict phase 3 had to resolve rather than dodge: the tomb, at its
surveyed position, puts **85 unbroken metres of masonry across the carriageway**, and the same
frame is the best view the map has produced. §9.6 treated it as a genuine trade and bent the last
hundred metres of the street round the tomb's eastern flank.

**Three independent sources say the street is 140–160 real metres east of the tomb and always
was.**

| source | Via Lata's easting at the Mausoleum's northing (n 1500) |
|---|---:|
| **[PLATE AGEA]** the georectified 2012 orthophoto, Via del Corso's centreline | **e −338** |
| **[PLATE Shepherd]** the road labelled "Flaminian Way" / "Via Lata (Broad Way)", through the affine fitted in `tools/scratch/rome-roads.mjs` | **e −341** |
| **[DER]** the straight line between the two termini — the Porta Flaminia at `(−497, 2045)`, which is this projection's own anchor, and the Capitol's north foot at `(0, 367)` | **e −336** |
| the Mausoleum's surveyed centre | **e −481** |

Three readings inside **5 metres** of each other, on a plate whose own fit is good to 28.5, and
**148 metres** from the tomb. The tomb's masonry is 87 m across, so its east face is at `e −437`
and the carriageway's west kerb at `e −357`: **53 real metres of clear ground.** The road runs
past the tomb, on the east, exactly as the modern Corso runs past the Piazza Augusto Imperatore.

So the 85 metres of masonry were never a conflict between a street and a building. **The old
armature ran `[−470, 1560] → [−440, 1080]` — 100 to 150 metres west of the real street — and it
was authored, not surveyed.** The bow was a fix for a fault that did not exist, and the fault it
was fixing was in the road.

**What does not change, and is the better half of the finding.** The **gate's own outward normal**
is not the road. The circuit runs east–west at the Porta Flaminia, so its normal is due south in
world terms; the Via Lata leaves at 16.4° off it. The Mausoleum stands **16 real metres** off that
normal, 545 m in. The ground judge's frame is untouched: the tomb still closes the view straight
out of the breach, and the street is now visibly the *other* line, peeling away east round it.
`assertGateAxisClear` measures the normal (20.6 % solid over the first 700 m, blocked by
`mausoleum-augustus` 145–235 m and `porticus-pompei` 590–635 m) and `assertWaysClearOfMonuments`
measures the carriageway, both at every boot, and the record no longer quotes either as the other.

The frame that shows it is `gate-axis-tomb` in `tools/shots/rome-roads.shot.mjs`.

### 10.2 The two frames the intrusion number can be quoted in, and why they differ

Until this pass "ranked street length inside a monument" had one number. It needs two, and the
gap between them is not the road's fault.

| | world metres (what the game collides with) | survey metres (what the city was) |
|---|---:|---:|
| all ranked ways | **99 / 685 = 14.5 %** | **16 / 1037 = 1.5 %** |
| worst way | `via-sacra` 54 % (`forum-romanum`) | `via-sacra` 39 % (`forum-romanum`) |
| next | `via-labicana` 27 %, `via-recta` 24 %, `via-lata` 21 %, `alta-semita` 16 % | `via-appia` 9 % (`palatine`), `via-labicana` 2 % (`colosseum`) |
| clear | 6 of 12 | **9 of 12** |

`MAP-METHOD.md` rule 4: **positions compress, cross-sections do not.** Rome's easting compresses
by `KX` = 0.443 and its northing by `KZ` = 0.35 while a monument keeps its true size in world
metres. The Via Lata and the Mausoleum are the clean instance — **148 real metres apart, 66 world
metres apart, against a tomb still drawn 93 world metres across** — and every one of the world
column's entries above is that same arithmetic:

- **`via-recta` × `stadium-domitian`.** The Stadium is 275 real metres long and is drawn 247 world
  metres long; 275 real metres of northing projects to 96 world metres. So the drawn Stadium
  occupies **706 real metres of northing** and swallows the northern Campus Martius. The Via Recta
  ran along its north side; there is no line 200 real metres north of its centre that clears it.
  Clearing it needs the way 165 survey metres north of where three sources put it, which is six
  times the plate's own error.
- **`via-labicana` in the Colosseum valley.** The Colosseum's drawn box spans `x 599..729`, the
  Baths of Titus `699..792`, the Ludus Magnus `704..796`, the Baths of Trajan `735..907`, and their
  `z` ranges overlap throughout. **There is no ranked corridor east of the amphitheatre in this
  frame at all**, north or south, and the nearest one is at `n −480`, 340 real metres off the
  street's line.
- **`via-sacra` × `forum-romanum`.** The Via Sacra crosses the Forum Romanum because that is what
  the Via Sacra is. The Forum is a paved enclosure and the survey publishes it as a solid.

**None of the four is fixable by moving a road.** Two are fixable by the frame (§4.5) and one by
giving the survey an `open` class for a paved enclosure a street may cross — which is rule 18's
shape, is a monument change and not a road change, and is the single largest item phase 4 or 5
inherits from this pass.

### 10.3 What was authored, and off which plate

Twenty-three ways, 11.6 km, in `src/city/rome/ways.ts`, each row carrying its plate in a `cite`
field. Against **41 ways and 14.2 km** before, as `probe-fabric` reads it off the built scene — of
which 17 were `feeder-*` links at 42 m that nobody authored and the rest were monument rings.
(`layout.ts`'s own comment claimed "42 ways and 19 km"; the measured figure is 41 and 14.2, and
the comment is corrected in the same commit. A number in a comment is a claim.)

- **Identification** comes from **Shepherd pl. 22** (`ASSETS.md` item 9), the only plate in the
  pool that names the streets. It is not georeferenced; `tools/scratch/rome-roads.mjs --fit` fits
  a 6-parameter affine from its pixels to this survey frame by least squares **on eight monuments
  whose coordinates come out of `survey.ts`**, and prints the residual: **RMS 28.5 real metres,
  worst 56.7 (the Colosseum)**, plate scale 2.147 m/px against the 2.100 `ASSETS.md` measures off
  its own bars, plate rotation −1.58° off survey north.
- **Geometry** for ways that survive as modern streets comes off the **AGEA orthophoto / Lanciani
  georectified** raster (`src/city/overlay.ts`'s affine, 1.26 m over 7 km).
- **Topology** — which road enters which gate — from **ColdEel** (item 11), which `ASSETS.md`
  forbids measuring.
- **Endpoints** that must meet an engine-fixed feature are **pinned**, and the rows say so.

§4.2's four demotions are done (`via-appia`, `via-triumphalis`, `via-sacra` from `artery` to
`consular`; the `feeder-*` arteries deleted rather than demoted). §4.2's six additions are all
present: `clivus-suburanus`, `argiletum`, `via-tecta`, `clivus-capitolinus`, `subura`,
`via-pinciana`. A seventh, `clivus-argentarius`, had to be added: without it the Via Lata's
southern end stops 350 real metres short of the Forum and the graph is in two pieces.

Two rows were **deleted**, and the reason is the frame's south edge rather than the plate.
`CITY_Z_MAX` is 1374 world metres, which is survey northing **−367**; `via-ostiensis` and
`clivus-aventinus` were authored entirely south of it, so every node clamped to the same `z` and
what the map drew was two carriageways lying flat along its own boundary. Four more ways cross the
edge and are truncated at `n −365` instead. That also removed 15 % of the Via Appia's reported
intrusion: its four southern nodes were collapsing onto `z 1374` and the pile-up landed inside the
Colosseum's drawn footprint.

### 10.4 Three sign errors, and only one of them was mine

The grain work turned up three, all of the same family, and they had been invisible for the same
reason: **nothing in Rome's fabric had ever pointed at anything.**

1. **A plan rotation is not a world bearing.** `makeRotationY(r)` points a box's long axis along
   **−r**, and `CitySystem`'s `occRot` is the only place in the tree that already said so — it
   negates on the way into the obstacle list, which is why `probe-fabric` is entitled to compare
   `getObstacles().rot` with a street bearing directly. `DistrictSpec.rot = wayBearingAt(...)`
   without the minus sign pointed every quarter's lattice at the **mirror** of its own street. The
   hash it replaced was immune: a symmetric random draw is its own mirror image.
2. **`rowRotOf` added the spine slope where it had to subtract it.** A spine's world bearing works
   out to `−d.rot + atan(slope)`; a plot's drawn axis points along `−rot`; so a row written
   `d.rot + atan(slope)` draws at the reflection of the very street it fronts, off by
   `2·atan(slope)` — **up to 14.6°** at the amplitude this file used. That has been in `fabric.ts`
   since the lattice was written. It is a large part of what G20 has been reporting, and the record
   read all of it as evidence for the hash.
3. **`assertWayGraph`'s transverse test used the 90° fold.** A road crossing the curtain at 70°
   read as 20° and every gate failed. Two folds, two questions: the grain question folds modulo 90°
   because a block parallel and a block perpendicular to its street are both aligned to it, and the
   gate question must not, because perpendicular is the thing it is looking for.

### 10.5 The grain: what moved, what did not, and why it cannot close here

`DISTRICTS[].rot` was `(hash2(round(d.e), round(d.n), 0x5c1) − 0.5) * 0.7` — ±20° per quarter,
drawn from a hash. It is now `−wayBearingAt(x, z)`, the road network's own bearing field, sampled
at the quarter's centre **after** the +Z clamp (four quarters are surveyed south of the edge and
are pulled back onto it by up to 300 m; sampling before the clamp gave the Emporium a frame 75°
off the street it stands on). Each row then turns up to 12° further toward the street under it.

| | before | after |
|---|---:|---:|
| **G20** median block orientation off the nearest street | **9.17°** | **7.78°** |
| G20 p90 | 26.77° | 31.73° |
| **G21** median between neighbours within 40 m | **5.14°** | **3.22°** |
| **G21** neighbour pairs rotating > 15° across a 40 m gap | **20.9 %** | **13.6 %** |

**Both still fail, and phase 3 cannot close them.** The measurement that says why is
`ROW_TURN`, the bound on the per-row correction, swept on this tree:

| `ROW_TURN` | G20 median | G21 median | G21 seams |
|---:|---:|---:|---:|
| 0° | **6.86** | 6.34 | 24.5 % |
| 12° (shipped, with the spine amplitude halved) | 7.78 | **3.22** | **13.6 %** |

The two checks pull in opposite directions and there is a structural reason. A block's nearest
street is almost always **its own quarter's lane**, which is cut in the quarter's `(u, v)` frame;
turning the block toward the street network turns it away from that lane, which is what G20
measures. Not turning it leaves two blocks either side of a quarter boundary at their two
quarters' angles, which is what G21 measures. **Both are satisfied only when the lanes turn too —
that is, when a block is a face of the road graph rather than a rib of a lattice, which is §4.3
and phase 4.** Even at `ROW_TURN` 0 the floor is 6.86° with a p90 of 35°, because the seventeen
quarters overlap (G18: 82 pairs, 1.46× the ground claimed) and a block in one quarter is routinely
nearest a *different* quarter's lane. **G20 cannot pass while the regions do not partition.**

What phase 3 has delivered is the field those faces will be derived from, and the sharpest
evidence that it is real is the picture: `network-plan-east` shows the Alta Semita, the Vicus
Longus, the Vicus Patricius and the Clivus Suburanus running parallel up the Viminal with the
fabric between them grained the same way.

### 10.6 The armature is one graph, and every gate is on it

`assertWayGraph`, new, runs at every boot:

- **one connected component** among consular-and-above ways, against two before the Clivus
  Argentarius was added. This is a property that can now fail: `feeders` used to *manufacture* it
  by joining every loose end to its nearest neighbour with a 42 m link, so a check on it before
  this pass would have been a check that had never gone red.
- **four of four gate mouths on a way of rank consular or better**, against §4.2's one of four.
  The first version of this check reported four of four for the wrong reason — `via-sagularis` is
  a 42 m artery running the length of the curtain 30 m inside it, so its carriageway covers every
  mouth by construction. The relation it was missing is **transverse**.
- **zero dangling ends inside the circuit.** Thirteen ends are joined to nothing and every one is
  categorised and counted: 7 at the map edge, 3 outside the curtain, 2 the military road's own ends
  where the curtain ends, 1 terminating at a monument (the Clivus Capitolinus, at the Area
  Capitolina, which is where it ended).

`tools/probe-plan.mjs`, which is an external instrument and does not read the way table, agrees:
monuments standing on the **named armature** go **15 → 8**, and its P9 count of ways leaving each
gate goes `flaminia 3 / salaria 1 / nomentana 2` → `3 / 2 / 3`.

### 10.7 The gate, before and after

| | `main` `d1e85c0` | `e/city/rome-roads` |
|---|---|---|
| `probe-fabric` **Rome** | **10/25** | **10/25** |
| `probe-fabric` **Carthage** (control) | **13/22** | **13/22**, every check identical |
| G4 monument in a carriageway (plan) | 15,106.7 m² / 53 segments / 19 monuments | **12,731.3 m² / 24 / 10** |
| G5 drawn carriageway under a monument | 1,207 vertices of 75,053 | **3,478 of 68,113 — worse, see below** |
| G17 quarters that report themselves buried | 1 (`forum-boarium`) | **2 (`forum-boarium`, `emporium`) — worse** |
| G20 / G21 | 9.17° / 20.9 % | **7.78° / 13.6 %** |
| `probe-plan` | 6/9 | 6/9; P2's named-armature count 15 → 8 |
| `qa-deploy` | 33/33 | 33/33 |
| `probe-seams` | PASS both maps | PASS both maps |
| `probe-wall` | 19/19 | 19/19 |
| `tsc` / `lint` | clean / 3/3 | clean / 3/3 |
| determinism | — | `default` 8,632 **unchanged**; Carthage 3,440 **unchanged**; Rome siege 3,072 re-recorded, t+0 identical, survivors at t+400 2,284 → 2,291 |

**Two regressions, both named rather than tuned away.**

- **G5 got worse, and it is a paving bug rather than a routing one.** The reservation through a
  monument costs nothing — the monument is already there — but `buildWays` must not *pave* the
  temple's floor, and `onMonument` is tested **once per segment at its midpoint**. `deflect` used
  to resample every way to 30 m spacing, so the midpoint test was fine-grained by accident; a
  straight authored way has segments 300–400 m long, and one whose midpoint is clear paves straight
  across a monument at both ends. **The fix is to sample the paving test at the paving's own
  resolution, not the way's**, and it is four lines in `fabric.ts`'s `buildWays`. It is named here
  rather than done because it is a change to the road *mesh* and this branch is already the largest
  change to the road *plan* the project has had.
- **G17 gained a buried quarter.** `emporium` and `forum-boarium` are both `eastBank` rows whose
  `x` is overridden 300 m from their surveyed position and whose `z` is clamped to the +Z edge, so
  half of each lies off the map whatever angle it takes. Deleting `via-ostiensis` removed the
  street they fronted. Both rectangles are deleted outright by §4.3, so the honest repair is phase
  4's and not a tuning of this one.

`MON_AMBITUS` went 2.5 → 4.0 m in the same pass, and the extra 1.5 m is off a measurement rather
than off an instance: re-laying the armature moved every quarter's grain, an insula landed where
the Baths of Trajan's drawn stone oversails its own box, and G16 went red at 0.94 m. §9.7 had
already said G16 *"was passing on where an insula happened to fall"*. Tuning until that insula
cleared would be the same fault again, so the number comes from G14's own table: six of
twenty-seven monuments draw stone outside their box, by 2.52 m (the Tabularium) to 13.65 m (the
Stadium of Domitian), and below `1.5 + 2.52` the reservation is provably too small for all six.
It does not cover the Stadium and is not meant to; rule 11 owns that.

### 10.8 What phase 4 inherits

- **The regions.** G18/G19 are untouched and are the reason G20 cannot pass: seventeen rectangles
  claiming 1.46× the ground, so a block in one quarter is routinely nearest another quarter's lane.
  §4.3 deletes them for the fourteen Augustan regions as a partition, and that is now the binding
  item.
- **Faces.** The field is in place and the lattice reads it; what is left is for the lanes to be
  edges of the graph rather than ribs of a frame. The sweep in §10.5 is the evidence that nothing
  short of that closes G20 and G21 together.
- **The paving resolution** (§10.7), which is the cheapest item on this list and is worth doing
  before anybody takes another aerial.
- **An `open` class in the survey** for a paved enclosure a street may cross — the Forum Romanum,
  the Saepta, the great porticoes' courtyards. It is 39 % of the Via Sacra's survey-frame residual
  and all of `via-sacra`'s world-frame one, it is rule 18's shape rather than an exemption, and it
  will also give a cohort the Forum to march across, which it should have.
- **The stepped *clivus*.** §4.2 wants four ways quantised to 0.17 m risers as Carthage's
  `streets.ts` does. They carry `local` rank and ordinary paving here; a flag nothing reads is
  worse than no flag (§9.9 on `maxDrawAt`), so there is no flag.
- **The regional boundaries as `vicus`-rank edges** (§4.3 step 1). Not traced: without the regions
  themselves they would be streets with no consumer.
- **The Porta Salaria is in three places.** The engine puts it at `e 1036`, the geodesy of Piazza
  Fiume at `e ~1190`, and Shepherd's own ink at `e ~1390` — 350 m apart, and relative to the Castra
  Praetoria the engine's is 440 m too far west. The gate is built and the road was pinned to it,
  which is the right call for this pass and leaves a real question for the circuit's.
