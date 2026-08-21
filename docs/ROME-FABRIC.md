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
