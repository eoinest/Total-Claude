# Rome — map specification, redesign

**Status: draft 1, complete.** Written at `3595b48` as the document a construction pass
executes from. It is the counterpart to `docs/CARTHAGE.md`, deliberately: same tags, same
discipline about what is evidence and what is a decision, same rule that a builder cannot act
on "uncertain" so every entry gives the number to build to.

This is a **redesign**, not a new map. `campus-martius` ships today with 50 bays of Aurelian
curtain, one gate and 1,673 spine stations. What it does not have is a circuit — it has a
*section*, and `probe-footing.mjs`'s own words at `3595b48` are:

```
=== around — the curtain runs x -631 .. 1144 on a map ±1400 ===
  first open crossing east of the wall: x 1154
```

From x 1304 to the map's edge the wall line is open, the nav lattice is clear across it, and
the whole 160 metres behind it is clear as well. **That is not a gap in a bay; it is a road
into the city, and it is the only thing on the map a formed cohort can walk through.**
Everything below follows from fixing it honestly rather than by extending a straight line.

**Four things changed shape while this was being written**, and each is a place a reasonable
draft would have gone wrong:

- the tower interval is **37.1 m interaxial**, not the 29.6 m of clear curtain everybody
  quotes — §2.4b;
- **the Aurelianic wall has no portcullis** (Richmond puts them at *all* gateways in 401–403)
  and **no putlog holes** (their absence is the diagnostic that separates 271 from 403) —
  §5.5, §4.9;
- **no free-standing stair ever ran up the inner face**; access was through the towers, and
  Cozza found the ground-level door and the internal double flight that make that work — which
  turns out to satisfy `Siege`'s one-stair-per-run rule exactly — §9;
- and **the whole scenario is a counterfactual**, because the wall was begun *after* the
  Juthungi were destroyed. It is also the *specific* counterfactual Aurelian names as his
  reason for building it, and it nearly happened eleven years earlier — §1.

**Read `docs/CARTHAGE.md` first if you have not.** It is the exemplar and this document reuses
its idioms on purpose. §14 lists, plainly, the places where Carthage's approach cost this
project something and Rome is built not to repeat it.

---

## 0. How to read this

Every dimension carries a tag:

| tag | means |
|---|---|
| **[HA]** | *Historia Augusta*, *Divus Aurelianus* — a fourth-century life of uncertain authorship, mixing good annalistic material with invention. Load-bearing only where a modern historian follows it. |
| **[ANC]** | Another ancient source, named: Zosimus, Dexippus, Ammianus, Procopius, the *Chronographer of 354*. |
| **[ARCH]** | Excavated, standing, or measured on the fabric. Named where known. |
| **[MOD]** | Modern scholarly consensus, or a measurement off modern topography, survey data or aerial imagery. |
| **[DER]** | Derived here by arithmetic from other entries. The arithmetic is shown. |
| **[SRC]** | Read out of this repository's own source at `3595b48`. File and symbol given. |
| **[MEAS]** | Measured by a named instrument at a named commit. If a number here has no tool beside it, it is not a measurement. |
| **[GAME]** | A decision with no ancient authority. Called out every time so nobody later cites us to ourselves. |

**Units.** All real-world dimensions are metres. Elevations are metres above sea level on
the Italian datum, which is what the 1924 survey in §3 uses; the game's own datum is
`WATER_LEVEL = 5.0` and the conversion is stated in §3.4.

**Ancient units.** The *pes monetalis* is **0.296 m**. Every Roman dimension in this document
is stated in metres and in *pedes*, because the Aurelian wall is laid out in round *pedes* and
a number that is not round in *pedes* is a number we invented. The *actus* is 120 *pedes* =
35.52 m; the *passus* is 5 *pedes* = 1.48 m; the Roman mile is 5,000 *pedes* = **1,480 m**.

**The rule Carthage wrote down and Rome inherits.** *Positions compress. Cross-sections do
not.* A monument's position goes through the affine map in §2; its height, its wall
thickness, its tower footprint, its street width and its tower interval do not. §2.4 states
the two places Rome has to override that and why.

---

## 1. The moment: autumn 271 AD

**Hold everything to the autumn of 271**, the year Aurelian's wall was begun and the year the
Juthungi were in Italy. The map is already dated there — `site.season: 'early November, 271 AD'`,
`declinationDeg: -14` **[SRC]** — and the date is right.

### 1.1 The premise is a counterfactual, and the document has to say so first

**The Aurelian Wall was begun *because* the Juthungi had been in Italy, after they were
destroyed.** The order of events is not in doubt:

1. The Juthungi cross into Italy in 270 and ravage the north — the *Historia Augusta* has them
   devastating everything around Milan. **[HA]**
2. **Placentia**, and it is a disaster: *"tanta apud Placentiam clades accepta est ut Romanum
   paene solveretur imperium"* — such a defeat that the empire of Rome was almost destroyed.
   The mechanism the source gives is a **woodland ambush at dusk**: unable to meet him in open
   battle, *"they fell back into the thickest forests, and thus as evening came on they routed
   our forces."* **[HA]** *Aurelian* 21.1–3.
3. **Panic in Rome.** *"In that fear, when the Marcomanni were laying everything waste, huge
   riots broke out at Rome, everybody dreading that the same things would happen as had
   happened under Gallienus. And so the Sibylline Books were consulted."* **[HA]** 18.4, and
   §§19–20 give the whole senatorial debate, the pontiffs unrolling the books with veiled
   hands, and the *Amburbium* proclaimed.
4. **Two more battles and the Juthungi are annihilated.** The only source that names all three
   sites is the ***Epitome de Caesaribus* 35.2** — *"iste in Italia tribus proeliis victor fuit,
   apud Placentiam, iuxta amnem Metaurum ac fanum Fortunae, postremo Ticinensibus campis"* —
   Placentia, then **the Metaurus at Fanum Fortunae (which is one battle at one place, not
   two)**, and finally the plains of Ticinum. **[ANC]**
5. **Then the wall.** *"his actis cum videret posse fieri ut aliquid tale iterum, quale sub
   Gallieno evenerat, proveniret, adhibito consilio senatus muros urbis Romae dilatavit"* —
   since it seemed possible that something might happen again such as had happened under
   Gallienus, he took the senate's advice and extended the walls of Rome. **[HA]** 21.9.
   Aurelius Victor 35.7 gives the identical reasoning independently.

**So a Juthungi assault on a half-built Aurelian wall never happened and by construction could
not have.** This map is a counterfactual and it should be labelled one — in this document, and
in one line of the blurb.

### 1.2 But it is the *specific* counterfactual the ancient sources are afraid of, and it nearly happened once

That is what makes it worth building rather than an indulgence. Aurelian's own stated reason
for the wall is *"lest what happened under Gallienus should happen again"* — and what happened
under Gallienus is on the record. **Zosimus I.37.1–2**: a barbarian host *"penetrated into Italy
as far as Rome"*; the emperor was beyond the Alps; and the **Senate** *"armed all the soldiers
that were in the city, and the strongest of the common people, and formed an army, which
exceeded the barbarians in number"*, whereupon the invaders *"left Rome, but ravaged all the
rest of Italy."* **[ANC]** That is c. 259/260 — **eleven years before this map**.

**So the scenario is: the thing Rome was afraid of in 271, happening in 271, on the wall it was
building to prevent it.** The garrison is the one Zosimus describes — the city's own troops and
its armed population (§8.4) — and the enemy is the one that had beaten a Roman field army at
Placentia three hundred kilometres north and might have kept coming.

Two consequences follow and both are in §8: the storm has **no siege train, because the
Juthungi had none and Ammianus says so of the Juthungi by name**; and the defence is a **city
garrison, not a field army**, because that is what was in Rome.

### 1.3 What the date buys and what it costs

| | |
|---|---|
| **Buys** | the wall as a **building site**, which is the map's whole identity (§4.8) and which no other year gives; the Juthungi, who are the only enemy ever to have made Rome think it needed a wall; a Rome that is **still unwalled at the start of the year**, so the fortification is a live event rather than a backdrop; and, if the mint-workers' revolt belongs to 271 rather than 274 (§8.5), a city that has just fought a pitched battle with itself across the Caelian. |
| **Costs** | the **Temple of Sol**, dedicated 274 — Aurelian's own foundation, and it is three years away (§7.6); the **Baths of Constantine**, *c.* 315; the **Pons Probi**; and the **Honorian wall**, which is what almost every photograph of this monument shows (§13). |
| **Does not cost** | the roster. The shipped Juthungi units are period-correct as *people*; what is wrong is their equipment list, and §8.2 fixes it without adding a unit type. |

**Map metadata to change.** Everything else in `CAMPUS_MARTIUS` stays.

| field | from | to | why |
|---|---|---|---|
| `subtitle` | `The Siege of Rome · 271 AD` | **`The Aurelian Wall, autumn 271`** | it is not a siege (§8.1) and it is the wall that is the subject |
| `blurb` | "The Tiber flood plain north of the city…" | **"A wall four months old and nowhere finished, between the Tiber and the Pincian. Aurelian is in the east. The Juthungi have already broken one Roman army."** | one sentence, per `MapDefinition`; it states the counterfactual by stating where Aurelian is |
| `sky.defaultHour` | 10 | **9.0** — keep 10 as a preset | §8.6 |
| `site.season` | `early November, 271 AD` | **`autumn, 271 AD`** | the campaign is autumn; November is a choice inside it |
---

## 2. The frame, the projection, and the four things the engine will not move

### 2.1 What is fixed

Read out of source at `3595b48`. **[SRC]** throughout.

| constant | value | where | consequence |
|---|---|---|---|
| `HALF_EXTENT` | **1400 m** | `src/terrain/topography.ts:26` | the world is 2800 × 2800 m, read at module-evaluation time by `src/city/*`, `src/ai/Pathfinding.ts` and `src/ui/Minimap.ts`. It does not change. |
| attacker deployment | **z ≈ −196**, half-width **490 m** | `germanDeployMask` | `rectMask(x, z, 0, −196, 490, 130, 80)` |
| defender deployment | **z ≈ +150**, half-width **490 m** | `romanDeployMask` | `rectMask(x, z, 10, 150, 490, 120, 80)` |
| `battlefieldZ` | **250** | `src/city/rome/plan.ts` | no city geometry below it, at any LOD. `assertNoStrayGeometry` walks every baked vertex. |
| `Pathfinding.CELL` | **7 m** | `src/ai/Pathfinding.ts:37` | the nav lattice is 401², `deriveCost` central-differences over 14 m |
| `OCC_CELL` | **4 m** | `src/city/CitySystem.ts` | the masonry occupancy raster is 700². **This is the floor on any aperture** — §5.4. |
| `ROUGH_SLOPE_IMPASSABLE` | **0.62** | `src/sim/Obstacles.ts:97` | a formed body cannot climb past ~32° |
| `FIELD_RES` | **2049** | heightfield | 1.367 m per lattice cell over 2800 m |
| draw-call cap | **220** whole-frame | `CitySystem.init` boot line | measured **192** at boot on the assault at ultra, `3595b48` (§4.1) |
| `crestZAt` range | **427.14 … 564.22** | `topography.ts` | `rome.ts:519`'s "the wall crest reaches z = 583" is **stale**; the maximum is 564.22 at x 485 |

Four further constraints are *not* constants and are the ones a redesign can trip over. They
are stated at the top of `src/city/cityPlan.ts` and they are load-bearing:

1. **`CitySystem.bayAt` indexes bays arithmetically in x** — `Math.floor((x − bayX0) / bayPitch)`,
   once per projectile per tick. `assertUniformBayPitch` warns past **12 %** deviation.
   *A circuit that turns a corner and runs in z cannot be a bay.* This is the single hardest
   constraint on the redesign and §4.6 is the answer to it.
2. **No geometry below `battlefieldZ`, at any detail level.**
3. **The wall's outward normal is −Z and the city is at +Z.** `Siege.ts` reads
   `GarrisonBay.nx/nz`; `scenario.ts` deploys on that assumption.
4. **`merlonLength`/`crenelLength` on the plan must equal the wall's own `crenellation()`
   call, exactly.** A mismatch is 491 missile impacts on our own masonry in one minute
   (`src/city/rome/plan.ts`).

### 2.2 Compass orientation — unchanged, and it is already right

**Map −Z = true north. Map +Z = true south. Map +X = true east. Map −X = true west.**

Carthage is rotated 90° from this because Carthage's only land approach is from the west.
Rome's approach is from the north, down the Via Flaminia, and −Z is where the attacker
deploys. **Do not touch this.** Consequences that come free and that the redesign leans on:

- the **Tiber** is a north-west to south-east diagonal across the map's western half, and at
  the wall it is the **west anchor of the circuit** (§3.2, §4.2);
- the **Pincian** and the **Quirinal** are the +X shoulders of the approach;
- the **Castra Praetoria** is the **east anchor**, at high +X, and the circuit leaves the map
  through its own east wall rather than stopping (§4.6).

### 2.3 The projection — keep it

```
Origin: the Temple of Jupiter Optimus Maximus, Capitoline, 41.8925 N, 12.4823 E   [SRC]
  e = metres EAST of the origin,  111,132 m per degree of latitude
  n = metres NORTH of the origin,  82,857 m per degree of longitude at 41.89 N

  x = X0 + KX·e      KX = 0.443,  X0 = 292.17
  z = Z0 − KZ·n      KZ = 0.222,  Z0 = 983.74
```

`X0`/`Z0` are not typed constants: they are solved from the Porta Flaminia's survey position
(`e −497, n +2045`) against `GATE_X`, which is itself the fixed point of
`x = roadCentreX(crestZAt(x))`. Recomputed here at `3595b48`: **`GATE_X = 72.0`,
`GATE_Z = 529.75`**, hence the `X0`/`Z0` above. **[DER]** from `src/city/rome.ts`.

**Keep `KX = 0.443` and `KZ = 0.222`.** Three reasons, and they are stronger after the
redesign than before it:

- `KX` was derived from an anchor pair — the Porta Flaminia to the Castra Praetoria — and the
  redesign *strengthens* that anchor rather than weakening it, because it extends the circuit
  to the camp's **east** wall, which is the wall Aurelian actually took into the circuit
  (§4.6). The 2,436 m the constant was fitted to becomes 2,850 m and the fit is unchanged;
  only the endpoint moves further along the same line.
- `KZ = 0.222` is `KE` at Carthage to three figures. Anisotropy is **2.00×** at Rome and
  **2.05×** at Carthage. A player's sense of distance transfers between the two maps and
  that property is worth more than any improvement a re-fit could buy.
- Every monument in `ROME` is already surveyed against it, and the overlap resolver, the
  bearing correction (`worldRot`, `ROT_RATIO = 1.45`) and the reference-raster affine in
  `src/city/overlay.ts` are all tuned to it. Re-fitting the projection would invalidate a
  1.26 m-worst georeference over 7 km (`ASSETS.md` §8) for no gain the battle can see.

### 2.4 The two places the projection is overridden

Carthage has two (the Byrsa's gradient, and open spaces that must be fought in). Rome has two
and they are different ones.

#### 2.4a Anything whose slope matters

Heights are not compressed and positions are, so **every
gradient steepens by 1/`KX` = 2.26× along the wall and by 1/`KZ` = 4.50× across it.** Two
consequences, and only the second needs an override:

- **Along the wall**, the Muro Torto's real 1:16 climb becomes a built **1:7.2** (§3.5) and the
  Pincian's north scarp, at a real 1:14 across the line, becomes **1:3.2**. Both are steep and
  both are *supposed* to be — `ROUGH_SLOPE_IMPASSABLE` is 1:1.6 and neither comes near it. Do
  not soften them.
- **The Vallis Sallustiana** is the case that bites, because its sides run *along* the wall and
  its fall is short: a real ~1:10 comes out near **1:4.4**, which turns a garden valley into a
  ravine and puts three or four consecutive bay boundaries past `recut`'s 0.62 m step. §3.5
  **sets its world run from the gradient rather than from the projection**, exactly as Carthage
  does for the Byrsa and as `topography.ts` already does with `RISE_RUN = 175`.

**Author the relief profile from the gradients you want, not from projected elevations.** That
is the whole rule, and §3.5 is the table.

#### 2.4b The tower interval

Carthage states the rule: a tower interval is a real length used
uncompressed, so the modelled stretch carries fewer towers than the real wall did. Rome's
current `WALL.towerSpacing = 35.5` is *one actus*, 120 *pedes*, and the comment beside it
concedes that *"parts of the circuit run at 100 pedes, 29.6 m"*.

**Both numbers are wrong, and the second is the trap.** 29.6 m is the **clear curtain between
towers**; the **interaxis — which is what a bay is spaced on — is 37.1 m**, and Dey does the
arithmetic explicitly: 14,237.5 m of land circuit ÷ 37.1 = **383.8 towers**, corroborating the
Einsiedeln count of 383. Applying "a tower every 29.6 m" to the same circuit demands **481**,
and to the whole 18.8 km about 640. **[MOD]** §4.4.

The redesign uses **37.1 world metres**, uncompressed, and accepts that the modelled 1,333 m
front carries **36 towers where the real ~4,000 m carried about 93** — the same trade Carthage
makes at 33 against 75. **[DER]**

### 2.5 The survey — the redesign's key positions

Computed at `3595b48` by `tools/scratch/rome-geo.mjs`, a scratch script that reproduces `rome.ts`'s
projection exactly (it re-solves `GATE_X` by the same fixed-point iteration and derives
`X0`/`Z0` from it, so it cannot drift from the source). Latitude/longitude are modern site
positions **[MOD]**; where the ancient position differs the entry says so.

| feature | e | n | **x** | **z** | note |
|---|---:|---:|---:|---:|---|
| Temple of Jupiter OM (origin) | 0 | 0 | **292** | **984** | |
| **Circuit: NW angle, Tiber left bank** | −655 | 2006 | **+2** | **538** | §4.2 — the west anchor |
| **Porta Flaminia** | −497 | 2045 | **+72** | **530** | = `GATE_X`, `GATE_Z`. Unchanged. |
| Muro Torto, west foot | −273 | 2039 | **+171** | **531** | §4.5 |
| Muro Torto, mid | −8 | 1995 | **+289** | **541** | |
| Muro Torto, east / Pincio crest | +273 | 1928 | **+413** | **556** | |
| **Porta Pinciana** | +530 | 1789 | **+527** | **587** | §5.2 |
| Vallis Sallustiana, west lip | +762 | 1784 | **+630** | **588** | |
| **Porta Salaria** | +1036 | 1784 | **+751** | **588** | §5.2 |
| Vallis Sallustiana, east lip | +1301 | 1756 | **+868** | **594** | |
| **Porta Nomentana** | +1831 | 1784 | **+1103** | **588** | §5.2 |
| Castra Praetoria, NW angle | +1931 | 1711 | **+1147** | **604** | ≈ today's `WALL_X_MAX` of 1150 |
| **Castra Praetoria, NE angle** | +2353 | 1578 | **+1335** | **633** | §4.6 — the east anchor |
| Castra Praetoria, SE angle | +2295 | 1256 | **+1309** | **705** | the circuit turns south here |
| Porta Tiburtina | +2709 | 333 | **+1492** | **910** | **off the map**, x > 1400 |
| Mausoleum of Augustus | −497 | 1478 | **+72** | **656** | §6 |
| Ara Pacis, original site | −423 | 1367 | **+105** | **680** | §6 |
| Pantheon | −447 | 678 | **+94** | **833** | §6 |
| Stadium of Domitian | −771 | 722 | **−49** | **823** | §6 |
| Baths of Agrippa | −439 | 545 | **+98** | **863** | §6 |
| Theatre of Pompey | −696 | 311 | **−16** | **915** | §6 |
| Theatre of Marcellus | −199 | −56 | **+204** | **996** | §6 |
| Mausoleum of Hadrian | −1301 | 1178 | **−284** | **722** | **outside the circuit** in 271 — §6.6 |

Sanity checks that must hold after the build:

- attacker deployment (z −196) to the Porta Flaminia (z 530) = **726 m of approach**, against
  Carthage's 642 and today's Rome's ~720. Unchanged tempo. **[DER]**
- **modelled front length**, NW angle to the Castra's NE angle: x +2 → +1335 = **1,333 world
  metres**, against today's `WALL_X_MAX − WALL_X_MIN` = 1150 − (−631) = **1,781**. The front
  is **448 world metres shorter** and every metre of the difference is fiction that becomes
  river (§3.2). *That saving is what pays for two extra gates, the Muro Torto, the Castra
  Praetoria and two returns inside the same draw budget.* **[DER]**
- **36 bays at a 37.03 m pitch**, against today's 50 at 35.5 m. §4.4. **[DER]**
- **The polyline under-measures the real wall by about a sixth, and that is expected.** The
  fourteen waypoints above are chords between gates; the wall itself bends round the Pincian
  and kinks at every tower. Cozza's survey gives **Tiber angle → Porta Flaminia 263 m** in nine
  towers, **Porta Flaminia → Porta Pinciana 1,063 m** in twenty-five, **Porta Pinciana → Porta
  Salaria 753 m** in twenty-three — **2,079 m for the northern land front to the Salaria**
  against the chord chain's 1,742. **[MOD]** *Use Cozza's lengths for anything that has to be
  a real length* (the reuse arithmetic in §4.8, the tower count) *and the chord chain only for
  the world positions*, which is what it is for.
- the circuit leaves the map's **east edge at z ≈ 807**, on the line from the Castra's SE
  angle to the Porta Tiburtina, and its **west return** runs into the Tiber. **There is no
  flank march on this map after the redesign**, which is the property Carthage has and Rome
  does not. **[DER]**

---

## 3. The ground

An attacker's options are set here before any wall exists, and Rome's ground is the opposite
of Carthage's in the one way that matters, exactly as `CARTHAGE.md` §3.1 says — but the
shipped map gets *which* way round wrong.

### 3.1 The headline, corrected

`CARTHAGE.md` says: *"At Rome the wall stands on a hill. At Carthage it stands on nothing."*
That is true of the eastern two-thirds of Rome's circuit and **false of the western third,
which is the third the map is named after.**

`riseAmplitude` **[SRC]** puts a 22–34 m rise under the whole 1,781 m curtain: a Pincian
shoulder of 31 m at x −300, a Quirinal shoulder of 34 m at x +360, outer shoulders of 22 m
and 26 m, and a 13 m saddle cut at x +20 so the Via Flaminia can get through. Every bay of
the shipped wall therefore stands 22–34 m above the plain in front of it.

The real ground does not do that. The Campus Martius is a **Tiber flood plain**, and the
Aurelian wall crosses it dead flat from the river to the foot of the Pincian. The wall only
gets onto high ground when it reaches the Muro Torto, some 300 real metres east of the Porta
Flaminia. **The stretch the map is named for is the one stretch with no terrain advantage at
all**, which is precisely why it is the stretch a besieger goes for, and precisely why it is
the stretch the redesign leaves unfinished (§4.7).

**Design consequence, and it is the map's spine:** replace the two Gaussian shoulders with a
**staircase**, measured in §3.3, that is flat at the Tiber, flat at the Porta Flaminia,
climbs the Pincian, holds high across the gardens, drops into the Vallis Sallustiana at the
Porta Salaria, and rises again to the Castra Praetoria. Five different kinds of ground under
one wall, instead of one hill under all of it.

### 3.2 The Tiber is in the wrong place, by 250 to 820 world metres

This is the largest single survey error on the map and it is already half-acknowledged in
source: `rome.ts`'s `FAR_BANK` exists *because* "the terrain's Tiber is a fixed two-term
meander that does not agree with a scaled real one". **[SRC]** What has never been written
down is the size of the disagreement.

`riverCentreX(z) = −760 + 130·sin(0.0023256 z) + 50·sin(0.0060606 z + 1.3)` **[SRC]**, an
almost-straight north–south channel oscillating between x −620 and x −690. Projecting the
Tiber's actual course through §2.3 gives this, computed at `3595b48` by `tools/scratch/rome-geo.mjs`:

| where | real x | `riverCentreX(z)` | error |
|---|---:|---:|---:|
| north map edge, z −312 | −526 | −874 | **−348** |
| Pons Milvius, z −70 | −269 | −743 | **−473** |
| mid-approach, z +133 | −159 | −677 | **−518** |
| z +305 | −115 | −676 | **−560** |
| **at the wall, z +478** | **−93** | **−687** | **−594** |
| Pons Neronianus reach, z +670 | −75 | −670 | **−595** |
| Pons Aelius, z +767 | −288 | −649 | **−362** |
| the great bend, z +885 | −380 | −627 | **−247** |
| Tiber Island, z +1033 | +127 | −625 | **−752** |

**The modelled river is between 250 and 820 world metres too far west at every point on the
map, and it does not bend.** [DER] [MEAS by `tools/scratch/rome-geo.mjs` at `3595b48`]

Three things follow, and together they are the reason this is task 1 in §15:

1. **The 690 world metres between the modelled bank and the real one are invented ground, and
   they are the ground the wall currently runs across.** `WALL_X_MIN` is
   `riverCentreX(crestZAt(−660)) + RIVER_HALF_WIDTH + 8`, which evaluates to **−631** at
   `3595b48` [DER]. The real north-west angle of the circuit is at **x +2**. Six hundred and
   thirty-three world metres of Aurelian curtain on this map stand where the Tiber was.
2. **The approach is a funnel and the map does not know it.** With the river where it belongs,
   the gap between the east bank and the Pincian's western toe closes from about **950 world
   metres at the attacker's deployment line to about 245 at the Porta Flaminia**. [DER] That
   is the shape of the real ground north of Rome, it is why the Porta Flaminia is where it is,
   and it hands the attacker the same kind of decision Carthage's soft ground does (§3.4
   there) without inventing a mechanic: *there is one good way to bring a mass at this gate,
   and the defender knows it.*
3. **The west flank closes for free.** The circuit ends on the river; the river is the flank;
   the far bank is the ager Vaticanus, which is outside the walls anyway and gets you nowhere.
   That is Carthage's §8.4 property — no flank, no way round — arrived at from the
   archaeology rather than by extending a line to the map edge.

**The correction to build.** Author the Tiber as a polyline in the survey frame and project
it, exactly as §2.5 does for everything else, then fit the analytic form the GLSL mirror in
`TOPO_GLSL` needs against the projected points rather than against nothing. The polyline, in
world metres, from the samples above: **(−526, −312), (−269, −70), (−159, 133), (−115, 305),
(−93, 478), (−75, 670), (−288, 767), (−380, 885), (−159, 971), (+127, 1033), (+61, 1243),
(−86, 1539)**. It is *not* a two-term sinusoid and should not be forced into one; a Catmull–Rom
through those twelve points, sampled into a lookup the shader reads, is the honest shape and
is cheaper than three sine terms.

**What this breaks, priced honestly.** `riverCentreX` has eleven readers in `src/` at
`3595b48` (topography, the heightfield, the scatter profile, `RiverWater`, `rome.ts`'s
`FAR_BANK`/`EAST_BANK`, the ford). The ford at `FORD_Z = −520` is north of the wall and stays
— it is the crossing the Juthungi used to get onto this bank at all. `germanDeployMask`'s
490 m half-width no longer fits between the corrected river and the eastern high ground at
z −196 and must come in to about **±380 m about x +40**; §8 sizes the order of battle against
that. **Do not attempt this change without also moving the deployment box; a cohort deployed
in the Tiber is the failure mode.**

### 3.3 Elevations, and an honest statement about the instrument

Sampled from the **Piano Topografico di Roma e Suburbio, 1908–1924, 1 m contours**, published
as vector by ArcheoSITARproject / SSABAP-RM. Two extracts are on disk: the one already
catalogued in `ASSETS.md` §7, and a second fetched for this pass over the north-east quadrant
the first does not cover (§12.4). Sampling by `tools/scratch/rome-contour.mjs`,
`tools/scratch/rome-wallprofile.mjs` and `tools/scratch/rome-transect.mjs` at `3595b48` — nearest-vertex on two bracketing levels, with the distance to the
nearest contour reported per sample.

> **The instrument's limit, stated before its results, because the first version of this
> table was wrong.** The 1924 layer carries contours where there is relief and **nothing at
> all on the flat**. On the Campus Martius the nearest contour to any sample is 100–600 m
> away, so a naive two-nearest interpolation returns a number — it returned "10.5 m" for the
> Pincian's summit and "47.5 m" for the Porta Nomentana on the first pass — and the number
> means nothing. Every sample below carries its contour distance and **anything past 35 m is
> not a measurement.** This is the same class of defect as the 0.83 m ditch reading in
> `SIEGE.md` §5.3: the probe answered, and it was answering about somewhere else.

| where | elevation, m a.s.l. | tag |
|---|---|---|
| Tiber low water at Rome | **5–6** | [MOD] |
| **Campus Martius floor, whole plain** | **10–15 in antiquity (13–20 now)**, and **3 to 8 above the Tiber** | [MOD] Platner & Ashby, *Campus Martius*, verbatim. The plain is *c.* **250 hectares**, "a little more than two kilometres north and south from the Capitoline to the porta Flaminia, and a little less than two kilometres east and west in its widest part, between the Quirinal and the river." |
| **The northern Campus, absolutely, from the Horologium excavation** | Augustan foundation **8.65–8.91**; Augustan walking surface **9.10–9.45**; **Flavian meridian pavement 10.80**; Hadrianic bench 11.66; modern street *c.* **17.8** | [ARCH] Buchner/Rakob via Schaldach 2020. **This is the best-anchored sequence available and the terrain should be built from it.** |
| **→ the walking surface in 271** | **c. 11** | [DER] — post-Flavian re-levelling, and *c.* 8.3–8.7 m of accumulation since |
| Stadium of Domitian arena floor | *c.* **4.50 m below** Piazza Navona | [ARCH] Roma Capitale |
| Theatre of Balbus mosaic pavement | **7 m below** modern ground | [ARCH] Sear 2006, 136 |
| **Alta Semita** pavement, on the Quirinal ridge | **1.83 m below** modern | [ARCH] Platner & Ashby. *The hills barely rose; the flood plain rose enormously.* |
| Pincian summit | **c. 50**; the Pincio terrace **c. 60** | [MOD]; my own 1924-contour sampling gives 45–52 at the wall and 64–66 behind the Porta Pinciana, contours within 3–17 m [MEAS] |
| **Pincian rise above the Campus floor** | **40–50 m over a 300–400 m run — gradient 1:7 to 1:9**, steepening to a near-cliff at the Muro Torto | [DER] |
| Muro Torto height | **not established in metres.** Cozza's elevations are in *ARID* 20 (1992) and are not online. Lanciani: the substructures were *"so gigantic in size and height that no extra works of defence were added to them"*. **Build 15 m and say it is chosen.** | [MOD] / [GAME] |
| Quirinal | Royal Gardens **50**, Treasury buildings **60**. It *"slopes more gradually on the north and north-west to the campus Martius"* — **the western scarp is a ramp, not a cliff** | [MOD] Platner & Ashby |
| Vallis Sallustiana (Horti Sallustiani) floor | **c. 35** | [MOD]; the 1924 layer has no coverage here and the two figures it returned were artefacts |
| Castra Praetoria platform | **c. 50** | [MOD]; outside the layer's coverage |
| Capitoline | Arx **39** and Capitolium **38** *above mean Tiber level*, i.e. **c. 44–46 a.s.l.**; the saddle 30. The hill is **c. 460 m long, average width 180 m** | [MOD] Platner & Ashby, and see §3.4 on the datum |

### 3.4 The datum, and the one line that must not be got wrong

The game's flood plain is `PLAIN_LEVEL = 12.2` with `WATER_LEVEL = 5.0` **[SRC]**, and the
regional tilt is `PLAIN_LEVEL + 0.0020x + 0.0026z`. **Those two numbers are already the real
ones**: a Tiber low water of 5–6 m a.s.l. and an ancient Campus Martius floor of 10–13 m are
inside the [MOD] ranges above to within a metre. **Do not renumber the datum.** Take
`gameHeight ≈ a.s.l.`, and every elevation in §3.3 can be used directly.

> **The one conversion that will be got wrong, and it is already written down in source.**
> `rome.ts`'s entry for the Temple of Jupiter OM ends: *"NB Platner-Ashby elevations are above
> **mean Tiber level**: add 8.2 m for a.s.l."* **[SRC]** Platner & Ashby is the standard
> reference for this city and the single most likely source a builder will reach for, and its
> heights are **8.2 m below** the ones in §3.3. A P&A figure becomes `P&A + 8.2` a.s.l. and
> `P&A + 8.2` in game. The Capitolium's podium is 48 m a.s.l. and about 39.8 in Platner.
> Anybody who mixes the two datums on the Pincian will build a hill 8 m too short.

The consequence to check after the build is the one Carthage's ditch work found: a dry cut
taken below `WATER_LEVEL` is rendered as water by `WaterSurface`. On the Campus Martius floor
at 12.2 m there is only **7.2 m of freeboard**, and §4.7's construction trench is 2.4 m deep,
so it fits — but only just, and any deepening must be capped against the freeboard the way
`CARTHAGE_DITCH_SECTION` is.

### 3.5 The relief to build

Replace `riseAmplitude`'s two Gaussians with a piecewise profile along the circuit. Heights
are above `WATER_LEVEL`-datum ground, i.e. add them to `regionalPlain(x, z)`.

| x range | stretch | ground at the wall | rise above the plain | note |
|---|---|---|---|---|
| **+2 … +100** | the river angle and the Porta Flaminia | 12.2 | **0** | flat. The wall's whole defence here is 6.5 m of brick. |
| **+100 … +250** | the Campus neck | 12.2 → 14 | **0 → 2** | still effectively flat; the ground just begins to lift |
| **+187 … +446** | the Muro Torto | 14 → 50 | **2 → 38** | the climb. 36 m over 259 world m = **1:7.2 built**, from a real 1:16 along the wall — the standard 2.26× steepening in x, and it needs no override. |
| **+446 … +620** | the Pincian crest | 50 → 55 | **38 → 43** | high, level, and the wall stands on a garden terrace |
| **+620 … +790** | the Vallis Sallustiana | 55 → 35 | **43 → 23** | a real valley, and **the one override on this map** (§2.4a). Projected, its ~1:10 real fall comes out near **1:4.4**; set the world run from the gradient instead and build it at **1:8.5** — 20 m over 170 world m. |
| **+790 … +1050** | the east shoulder | 35 → 48 | 23 → 36 | rising back onto the Quirinal's northern spur |
| **+1050 … +1335** | the Castra Praetoria platform | 48 → 50 | **36 → 38** | level, and the camp is built on a made platform |

**Three consequences a builder must design for.** First, the **wall-walk steps**: `walkY` is
quantised in 0.55 m construction increments over pairs of bays (`src/city/wall.ts`), and
`Siege.recut()` severs a run at any step over **0.62 m**. A 38 m climb across 36 bays is
**1.06 m of average step** — **every bay boundary on the Muro Torto and in the Vallis Sallustiana
will sever a run.** That is correct behaviour and it is what §9 budgets stairs against; it is
not a bug to smooth away. Second, `crestHeightAt(x)` is the city agent's contract for where
the wall's footing sits and it must be re-derived from the new profile in the same call the
heightfield grades the bench with, or half the circuit stands off its footing — the exact
fault `cityPlan.ts` records for Carthage's three competing wall lines.

**And third, which is a live question rather than a task.** `recut` severs a run on *height*
(`dy > 0.62`) but `buildLinks` rejoins two runs on *horizontal* gap alone — at most
`LINK_MAX_GAP = 14 m`, classified `TowerPass` past `STATION_PITCH × 3` and `Step` below it.
**Nothing in the classifier looks at the height difference it is bridging.** Rome today carries
a 28.39 m bay-to-bay step and 41 `TowerPass` links across 45 runs **[MEAS]**, so either that
step is one of the three unbridged boundaries or **there is a crossing on this circuit that
walks a garrison up twenty-eight metres of air.** Which of the two it is has not been measured
and this document does not claim to know. **§15 task 3 measures it**: print, for every link,
the height difference between the two stations it joins, and assert none exceeds a step a man
can climb. On the redesigned relief the worst case is the Muro Torto's ~5 m per bay, which is
well inside `LINK_MAX_GAP` horizontally and nowhere near climbable vertically.

### 3.6 Ground conditions

| condition | extent | effect | tag |
|---|---|---|---|
| **Tiber water meadow** | within ~175 world m of the east bank, below 5.4 m of freeboard | already modelled as willow thicket in `CAMPUS_SCATTER` **[SRC]**. Make it also **`soft`**: no engine placement, half speed for anything wheeled. | [GAME] from [MOD] |
| **Flood ground** | the whole Campus Martius floor below 13 m | the Tiber flooded the Campus regularly; in autumn it is wet, not dry. Render as heavy clay and standing water in the lows, and **carry it into the control texture's `b` (trodden) channel** so the scatter already thins there. | [MOD] |
| **The Via Flaminia agger** | `roadCentreX(z) ± 5.4 m`, paving `± 2.3` **[SRC]** | the one hard road on the approach. **Keep it.** It is where a ram must travel and the only place on the north half of the map that is not soft or steep. | [ARCH] [SRC] |
| **The Pincian scarp** | x +187 … +446, outside the wall | **1:3.2 built** across the line, from a real 1:14 through `KZ` (§2.4a). Passable to infantry in loose order, closed to everything wheeled, and **cohesion must break on it**. | [DER] [GAME] |
| **The construction site** | §4.7 | `RoughGround` — already a type in `src/city/wall.ts` and already keyed to `BayStage`. This is the map's answer to Carthage's ditch and it is §4.8. | [GAME] from [HA] |

The net effect, and it is worth stating as the design intent: **an attacker on this map has
firm ground for a siege train in exactly one place, the Via Flaminia, and it leads to the one
gate that is finished.** Everything else is soft, steep, or a building site. Carthage forces
the engines into the middle of the isthmus with salt marsh; Rome forces them onto a road with
a river, a flood plain and a hill. Same decision, different evidence, and neither is invented.

---

## 4. The circuit

This is why the map is worth rebuilding. Build it second, after the river (§3.2), because
nothing can be anchored until the river is where the survey says it is.

### 4.1 What is wrong with the circuit today, stated as measurements

**Measured at `3595b48`** by `tools/scratch/probe-romeflank.mjs` and
`tools/scratch/probe-romeflank2.mjs`, two scratch instruments written for this pass. They
drive the real page on a dev server (port 5926, killed by PID), wait on `window.__game.ready`,
and read `CitySystem` and `Siege.wallReport()` directly; they refuse to run against a stale
`dist/` by fetching `/src/main.ts` first. Everything in this table is theirs unless another
provenance is given.

| | value | provenance |
|---|---|---|
| bays | **50**, spanning x **−631 … +1144** | [MEAS] `3595b48` |
| spine stations | **1,673** in **45 runs** | [MEAS] `3595b48`. `SIEGE.md` gives 1,695 at `6698e19`; the difference is real and nobody has attributed it. Quote 1,673 for this tree. |
| links | 41 `TowerPass`, 0 `Step`, **9 `Stair`**, 0 `Breach` | [MEAS] `3595b48` |
| stair provenance | `published` | [MEAS] |
| runs reachable from a stair | **43 of 45** | [MEAS]. Westernmost stair foot is at **x −119.2**; the wall begins at −631. **512 world metres and fourteen bays of the west end carry no stair at all**, of which runs 0 and 1 are also behind an unbridged boundary — 78 stations a garrison can be put on and can never leave. |
| gates | **1** (`porta-flaminia`, x 72.0, z 529.4), shut at t=0 | [MEAS] |
| declared gate clear width | **4.3 m** | [SRC] `GATE_OPEN_WIDTH` |
| **measured gate opening once opened** | **8.00 m** in the collision surface | [MEAS] `tools/scratch/probe-romeaperture.mjs` at `3595b48`, bisecting `blocksMovement` at 0.05 m. **1.86× the declared width**, and exactly two `OCC_CELL`s. §5.2. |
| posterns | **0** | [SRC] |
| ditch | **none** | [SRC] — and §7 says keep it that way |
| **open bands through the wall line** | x **−552…−534** (20 m), **+368…+390** (24 m), **+404…+426** (24 m) — all three `footing` — and **x +1148 … +1400 (254 m)** | [MEAS] `3595b48`, a 32 m segment driven through the wall line at 2 m intervals against `blocksMovement`, **swept out to both map edges**. Commit `7340d02` found the first three at `6698e19`; the fourth is what happens when the sweep does not stop at the wall. |
| the west edge | x **−1400 … −638** also reports open to `blocksMovement` | [MEAS] — but see below: `blocksMovement` is a masonry query and does not know about water. |
| walk elevation | `walkY` **20.01 … 56.65 m**, worst bay-to-bay step **28.39 m** | [MEAS] `3595b48`. Eleven boundaries step more than 3 m. `Siege.recut()` severs at 0.62, which is why 50 bays make 45 runs and every break is a tower. |
| ground under the wall line | **3.5 m at x −635, 9.1 at −515, 35.2 at −495** | [MEAS] at 20 m intervals. A **26-metre cliff in twenty world metres** at the west end. |
| whole-frame cost, assault at ultra | **192 draws, 8.54 M triangles** at boot; the city's own share is **101 draws / 2.38 M tris in 23 chunks** — wall 44, monuments 22, city 21, road 5, gate 2, aqueducts 2 | [MEAS] `tools/probe-boot-carthage.mjs --map=campus-martius --scenario=assault --quality=ultra` at `3595b48` |

#### The flank, measured by the instrument that was already written for it

`tools/probe-footing.mjs` carries an **`around`** case whose own comment states the question
exactly: *"Beyond the terminal tower, is there a crossing? … `passable` is whether a body can
get from the storm's side to the city's side at this x at all."* It samples the wall line at
20 m, reads `blocksMovement`, counts blocked cells on `Pathfinding`'s own 7 m lattice across a
28 m band, **and counts them again 20–160 m inside**. Run at `3595b48`:

```
=== around — the curtain runs x -631 .. 1144 on a map ±1400 ===
east of the last tower there are 256 m of map; west of the first there are 769 m.
  first open crossing east of the wall: x 1154
  first open crossing west of the wall: x -641
```

| x | rasterShut | navBlocked / 28 m | deepBlocked / 160 m |
|---:|---|---|---|
| 1144 (last tower) | **true** | 3/9 | 12/21 |
| 1164 | false | **0/9** | 15/21 |
| 1224 | false | **0/9** | 15/21 |
| **1304 … 1384** | false | **0/9** | **0/21** |

**East of x 1304 there are eighty world metres where the wall line is open, the nav lattice is
clear across it, and the whole 160 metres behind it is clear as well.** Not a gap in a bay — a
road into the city.

The west end is the opposite and nobody has written it down: `blocksMovement` reports open from
x −641, but `navBlocked` is **7 of 9 at x −651 and 9 of 9 at −671 and −691**. That is the
Tiber. The bed sits at **0.33–0.42 m** across 50–110 m of channel at every latitude sampled,
and `Pathfinding` refuses any cell below `waterLevel − DROWNING_DEPTH` = **1.5 m** **[SRC]**
[MEAS]. Past the water the deep band opens again — but that is Trans Tiberim, which is outside
the walls and gets you nowhere. **The west flank is already closed, by drowning depth, and
nothing in the repository says so. The east flank is closed by nothing at all.** That asymmetry
is the defect, and it is why §15 task 9's acceptance test is a `Pathfinding` query and not only
a `blocksMovement` sweep.

#### And one seam the same probe found

```
seam check: 1 bay(s) where blocksMovement and NavGrid.blocked disagree:
  2(footing) raster=false nav=true
```

**Only two of the three footings are actually routable.** Bay 2 at x −553…−532 is open to the
collision surface and *shut to the pathfinder*, so the crowd solver will let a man drift through
it and the AI can never plan through it. `SIEGE.md` §2.8 treats the three as one class; they
are two classes, and the difference is that bay 2's ground falls from 18.66 m to **6.59 m**
inside one 35.5 m bay — the west-end cliff again, arriving as a slope the nav grid refuses.

**Two more structural facts about the shipped circuit, found by the source audit at
`3595b48` and not previously written down anywhere:**

- **Rome's heightfield cuts no bench under the wall.** Carthage's grades one — stage 4d,
  `WALL_BENCH_HALF = 40` — and then cuts its ditch at stage 4h. Rome's five heightfield stages
  are macro form, erosion, detail, human marks (river, agger, field boundaries, hillside
  terraces, quarries, stream) and deployment flattening. **The Aurelian wall stands on
  ungraded natural crest, and `buildWall` levels each bay to whatever ground it finds.** That
  is the mechanism behind the 28.39 m walk step, and §3.5 and §15 task 2 fix it at the terrain
  rather than in the wall.
- **The gate bay is off by one.** `gateBay = round((72 − (−631)) / 35.5) = 20`, but `GATE_X = 72`
  lies in **bay 19**, which spans 43.5 … 79.0. The block occupies 19.2 m of bay 19 and 5.2 m of
  bay 20, while `isGate`, `garrisonable && !isGate` and the stair-cadence exception all key off
  bay 20. **This is the root cause of §5.4's 22 stations standing inside masonry** — they are
  bay 19's, and bay 19 is not the gate bay as far as the wall builder is concerned.
  **Carthage uses `Math.floor` and does not have this bug.** **[SRC]**

**And the west end should not be there at all.** Bays 0–4 stand on ground at 3.5–9.1 m — at
and below `WATER_LEVEL = 5.0` — because `WALL_X_MIN` is derived from the *modelled* river's
bank, and the modelled river is 594 world metres west of the real one at that latitude (§3.2).
The two runs with no stair, the 28.39 m step and the 26 m cliff are all one fault: **five bays
of Aurelian curtain standing in the Tiber.** The redesign deletes them.

The last row is the whole reason for this document. **A 254-world-metre gap at the end of a
wall is not a defect in the wall, it is the absence of a circuit.** The AI has never found it;
a human finds it once and never plays the map again.

Two related faults it is worth naming before designing them away:

- **The construction state is an offset table.** `bayStage(bayIndex, bayCount, gateBay)`
  keys every stage off `k = bayIndex − gateBay` and explicitly discards `bayCount`
  (`void bayCount`) **[SRC]**. Its own comment says the stages are "placed close to the gate
  on purpose, so the construction story lands in the frames that matter" — a **camera**
  rationale. Where the wall is, what it stands on, and what was already there when Aurelian's
  surveyors arrived have no bearing on it. §4.7 replaces it with a rule that has one.
- **The east end stops at the wrong side of the right building.** `WALL_X_MAX = 1150` is
  documented as "the Castra Praetoria. Aurelian took the camp's own north and east walls into
  the circuit" **[SRC]** — and x 1150 is the camp's **north-west angle** (§2.5 gives it as
  1147). The circuit therefore ends exactly where the incorporated fort *begins*, and the two
  walls Aurelian actually used are both past the end of it.

### 4.2 The line

Author the circuit as a **polyline in the survey frame** (§2.5) and project it, the way every
monument is already authored, rather than as `crestZAt(x)`. Getting Rome's circuit wrong
should then require getting the survey wrong, which is `rome.ts`'s own stated standard and
the one thing the wall line has never been held to.

| | value |
|---|---|
| Real length, NW angle to the Castra's NE angle, along the polyline | **3,438 m** [DER] |
| Modelled length, same | **1,333 world m** in x; 1,337 along the line [DER] |
| Modelled bearing | within **±20° of +X at every segment**, mean 4°, so `assertUniformBayPitch` holds by construction. The worst segment is the 44 m jog at the Castra's NW angle at 20°, which costs 6 % of a bay's x-pitch against a 12 % tolerance. [DER] |
| West anchor | the **Tiber**, x +2, z 538 |
| East anchor | the **Castra Praetoria's north-east angle**, x +1335, z 633, whence the circuit turns south and leaves the map |
| Archaeological status | **standing**. Unlike Carthage's isthmus wall, this line is not a reconstruction: the Aurelian wall survives for most of this stretch, the Muro Torto is visible, and the Castra Praetoria's north and east walls are still the circuit. Where a gate has been destroyed (Porta Salaria, 1921) its position is recorded. |

Do **not** bow it. Carthage's 25 m sagitta exists because a 4.4 km straight reads as an
extruded rectangle; Rome's line has its own kinks from the ground, and adding a bow on top
would be inventing a curvature the archaeology contradicts.

### 4.3 The cross-section

Aurelianic first phase, AD 271–275. **Not** the Honorian heightening of 401–402, which
doubled the wall and put a covered gallery over the walk; a map set in 271 must show the
lower wall or it is showing the wrong building.

| property | value | *pedes* | tag |
|---|---|---|---|
| Height to the wall-walk | **6.5 m** | 22 | [ARCH] Richmond 1930, on the surviving Aurelianic core; already the shipped `WALL.height` **[SRC]**. The published range is **6 to 7.6 m** — Dey gives *c.* 7, Platner & Ashby "not more than 25 feet" (7.62), Roma Capitale *c.* 6. **6.5 is inside it and does not need to move.** |
| Height to the merlon tops | **8.55 m** | 29 | [DER] 6.5 + 2.05; Dey gives *c.* 8 m with merlons, so this is right to within half a metre |
| The wall-walk itself | **a single open *cammino di ronda*** at the top of the masonry, merlons outward, **no covered gallery** | | [MOD] Dey. §7.4: the arcaded gallery is Honorian, 401–402, and putting it on this map shows the wrong building by 130 years. |
| Real thickness | **3.5 m** (Dey: 3.5–3.7; Platner & Ashby "about 12 feet") | 12 | [ARCH] Richmond. Kept as a citation only — see §4.3a. |
| **Built thickness** | **6.0 m** (`CURTAIN_T`) | 20 | **[GAME] [SRC]**, and it is a deliberate, documented departure — the walk was widened so an army can form on it. §4.3a. |
| Plinth (travertine/tufa footing course) | **1.35 m** high, projecting **0.42 m** | — | [SRC] |
| Parapet above the walk | **2.05 m**, **0.9 m** thick | 7 / 3 | [SRC], and it is **at the top of the measured range**: Richmond measured the breastwork at **1.07–1.35 m** (3 ft 6 in to 4 ft 5 in) with merlons **0.60 m** (2 *pedes*) on top, i.e. **1.67–1.95 m** to the merlon crown. Keep 2.05 or take 1.95; **do not take 1.2**, which is the breastwork alone. |
| **Crenel sill above the walk** | **1.35 m** — the top of the breastwork, and the height a man shoots over | 4.5 | [ARCH] Richmond, pp. 61–62 |
| Face batter | **1 in 31** (0.032) | — | [SRC] |
| **Merlon / crenel** | **1.50 m / 1.50 m**, period **3.00 m** | 5 / 5 / **10** | **[ARCH] and this is a change.** Richmond, on the two surviving original merlons north of Porta Tiburtina: *"the embrasures are of the same width as the merlons."* The shipped **1.7 / 0.95** is 64 % tooth against a measured 50 %. Change both — **and change `crenellation()`'s call in the same commit**, because `masonryTopAt` alternates the plan's pair per projectile per tick and a mismatch is 491 impacts on our own masonry in a minute **[SRC]**. |
| *and a warning that comes with it* | Richmond: *"**the spacing or setting-out of the merlons is not uniform over the whole Wall; and there are different intervals in the same curtain.**"* The level is sometimes stepped and the string-mould slopes where the wall rises. `crenellationRun` already rescales per bay to fit a whole number of merlons **[SRC]** — **that behaviour is not a compromise, it is the archaeology**, and it should be said so in the code rather than apologised for. | | [ARCH] |
| Clear standing band on the walk | **2.21–4.06 m** across the spine | — | [MEAS] at `6698e19`, `SIEGE.md` §2.2 |
| Construction | brick-faced concrete, *opus latericium*, over a tufa-aggregate core in lime and pozzolana, on a rough foundation slightly thicker than the wall; bonding courses of *bipedales* at **irregular** intervals; blind arched recesses in the inner face at 6.4 m centres, an Aurelianic economy | — | [ARCH]; `WALL.innerArchSpacing` **[SRC]** |
| One *opus testaceum* band between string courses | **1.1 m** | — | [SRC] `WALL.courseBand` |

#### 4.3a The 6.0 m curtain is a lie the project has already decided to tell, and it should keep telling it

`WALL.thickness = 3.5` carries a comment that is a model of how this repository handles a
departure, and it is worth quoting because §13 asks Rome to behave this way everywhere:

> **Historical reference only. Nothing builds or collides against this number.** … The
> curtain the game actually stands on is `CURTAIN_T` in `wall.ts` — 6.0 m, widened so an army
> can form up on the walk … A live-looking constant that nothing reads is how the next person
> builds against the wrong number, so: this one is a footnote, not an input. **[SRC]**

**Keep 6.0 m.** A 3.5 m wall gives a clear band of 3.5 − 0.9 − 0.8 = **1.8 m**, which is two
ranks at the sim's 0.72 m pitch and one rank once anybody is shooting. The measured band at
6.0 m is 2.21–4.06 m, four to six ranks. The alternative to the departure is a wall nobody
can fight on, and Carthage's 7.1 m walk (nine ranks, from Appian's real 30 *pedes*) would
then be five times Rome's rather than twice it, which misrepresents both cities.

**But state the ratio honestly in the blurb and in §10.** Rome's real wall is *half* as thick
as Carthage's. The game's is 66 % of it. That is a compression of the difference, and it is
the price of a playable walk.

#### 4.3b The wall is laid out on a five-*pes* grid, and that is Rome's cubit module

`CARTHAGE.md` §7.3 calls the Punic cubit module *"the single most useful thing in the
archaeology"* and says to author on it rather than on metres, because a generator that snaps to
the module produces a Punic street front by construction. **Rome has the same gift and it has
never been written down.** Reduce every measured figure on this wall to *pedes* at 0.296 m:

| element | metres | *pedes* | round |
|---|---:|---:|---|
| Curtain bay between towers | 29.6 | 100.0 | **100** |
| **Tower interaxis — the bay pitch** | 37.1 | 125.3 | **125** |
| Curtain thickness | 3.5–3.7 | 11.8–12.5 | **12** |
| Tower width | 7.5 | 25.3 | **25** |
| Tower projection | 3.0 | 10.1 | **10** |
| Tower rise above the walk | 4.5 | 15.2 | **15** |
| Tower wall thickness | 0.60 | 2.03 | **2** |
| Merlon height | 0.60 | 2.03 | **2** |
| Merlon and embrasure period | 3.0 | 10.1 | **10** |
| Honorian solid heightening | 1.776 | 6.00 | **6** — *Dey's own conversion, and it divides by 0.296 exactly* |
| Honorian gallery outer skin | 1.20 | 4.05 | **4** — *same* |

**Every one is a multiple of five Roman feet.** No published metrological study of the circuit
exists; this reduction is the research pass's own and it is offered as such, but it is clean
enough to build on, and Asciutti's study of Porta Clausa independently *"confirms the Roman foot
as the module for the individual blocks."* **[MOD]**

**Which value of the *pes*.** Three are in live scholarly use — 0.2957, 0.296 and 0.2965 m.
**Use 0.296 m and a mile of 1,480 m**, because that is the value this monument's own
scholarship is internally consistent with: Dey converts 6 Roman feet as 177.6 cm and 4 as
1.20 m, both exact at 0.296, and Bukowiecki's theoretical brick sizes are all exact multiples of
it. **Do not mix 0.2957 into a reconstruction of this wall.**

### 4.4 Towers, and the number the shipped map nearly got right

| property | value | *pedes* | tag |
|---|---|---|---|
| **Clear interval between towers** | **29.6 m** | **100** | [ARCH] Dey 2011/2017, n. 7 |
| **Interaxis — the bay pitch** | **37.1 m** | 125 | [ARCH] same. **This is the number a bay is spaced on**, and the shipped `WALL.towerSpacing = 35.5` (one *actus*, 120 *pedes*) is **1.6 m short of it**. Change it to 37.1 and the citation in `layout.ts` stops being a guess. |
| Count on the real front | **≈ 93** over ~4,000 real m | | [DER] |
| Count on the modelled front | **36** at a 37.03 m pitch over 1,333 world m | | [DER] — so one modelled tower stands for 2.6 real ones, Carthage's 33-for-75 trade at Rome |
| Count on the whole circuit | **c. 400**; the Einsiedeln itinerary counts **383**, Lanciani/Ammon **381** | | [ANC] [MOD] |
| Plan | **square**, 7.6 m wide, projecting **3.5 m** in source; the published figure is **4–5 m** ("about 10 feet", Platner & Ashby) | 26 × 14–17 | [SRC] / [MOD]. Take **4.5 m**. |
| Rise above the curtain | **c. 6 m** ("about 20 feet") | 20 | [MOD]; the shipped 5.0 m chamber + 2.3 m roof is 7.3 and is close enough |
| Height to the tower top | **13.8 m** | | [MEAS] |
| Armament | an arched window per face at chamber level for a *ballista* | | [ARCH] |
| Tower pass | published per bay as `passOuter`/`passInner`, cut by the same helper that emits the stone. **Do not re-derive it.** | | [SRC], and `SIEGE.md` §2.6 for the 73-of-73 failure that rule came from |

**Going from 50 bays at 35.5 m to 36 at 37.1 m is the single largest saving in the redesign**
and it costs nothing historical — it is a *more* accurate pitch on a *shorter and truer* line.
Garrison capacity is not the constraint: 32 garrisonable bays at ~44 stations each is over
1,400 stations against a shipped garrison of **810 men in eight units** **[MEAS]**.

Rome's silhouette against Carthage's is worth designing deliberately, as `CARTHAGE.md` §4.5
asks: **Carthage is a row of 22.5 m keeps at 59 m centres; Rome is a 13.8 m serration at 37 m
centres.** Rome's is the longer, lower, more repetitive wall, and it should read that way.

### 4.5 The Muro Torto — the one stretch that was already gigantic

**x +187 … +446, bays 5–11.** [ARCH]

Aurelian did not build this. It is the garden terrace substruction of the **Horti Aciliorum**
on the Pincian's north face — *opus reticulatum* with tufa quoins, Julio-Claudian or early
imperial — and the surveyors ran the circuit straight into it and left it standing. Four facts,
all sourced, and each one is a mechanic:

| property | value | tag |
|---|---|---|
| Length incorporated | **550 real m**, the largest single reuse on this front | [MOD] Lanciani 1897, 72 |
| Modelled | **244 world m** — 6.6 bays at the 37.03 m pitch, so **take 7** and let the last one run a little past the crest | [DER] |
| Lean | **outward, 6°–7°** — the opposite way from the curtain's 1-in-31 inward batter | [MOD] Lanciani 1897, 74 |
| Height | **not established in metres.** Cozza's elevations are in *ARID* 20 (1992) and are not online. What the sources say is that it is the tallest thing on the northern front: Lanciani, that the substructures were *"so gigantic in size and height that no extra works of defence were added to them by Aurelian."* **Build 15 m** and say it is chosen. | [MOD] / [GAME] |
| Construction | Cozza's 1992 survey: on this stretch up to tower A18 the wall is *"completamente costruito contro terra… e non presentava le gallerie"* — **solid mass built against the hillside, with no wall-gallery**, and sentries on the crest only | [ARCH] Cozza 1992 |
| Extra works added by Aurelian | **none** | [MOD] Lanciani |

**And that last row is the design.** A stretch of circuit that was finished before the wall was
begun, needed nothing done to it, and therefore in 271 is the *only* completely finished thing
on the north front.

**The mechanic, and it is the inverse of the bug in §4.1.** Because the mass is built *against
earth*, the ground on the city side is at or near crest level. So:

- the Muro Torto **is garrisonable** — Cozza's sentries stand on the crest;
- and it needs **no stairs**, because a man walks onto it off the Pincian's own hillside. It
  publishes a **`WallStair` with a rise near zero at each end**, or a graded apron, so the
  garrison is not stranded — which is *exactly* the failure runs 0 and 1 have today, arrived
  at from the opposite direction;
- the outward lean and 15 m of leaning mass make it **unescaladable**: a ladder needs a crest
  to hook and this one overhangs;
- and because it has no inner face, it is the only stretch where a **breach is meaningless** —
  behind the stone is hillside.

Procopius records what a commander does with a wall like that. In 537 **Belisarius proposed to
pull it down and rebuild it, and the Romans stopped him**, saying St Peter had promised to
guard it himself; *"neither on that day nor throughout the whole time during which the Goths
were besieging Rome did any hostile force come to that place"* (*Gothic War* V.23.3–9). The
Romans of the sixth century already called the place ***murus ruptus*** — the broken wall —
which is where *Muro Torto* comes from. **[ANC]**

`CARTHAGE.md` gives Carthage *"the only weak and low spot in the fortifications, having been
neglected from the beginning"*. Rome gets its exact opposite, attested by name: a stretch so
strong that in one recorded siege nobody attacked it and the defender did not garrison it
properly either.

### 4.6 The west return is a real wall, and it is a different wall

**This is the correction the research forced, and it is worth the space.** The Aurelian
circuit did not stop at the Tiber and leave the bank open. It ran **down the left bank for
about 4,600 metres**, and the reason nobody thinks so is that the stretch is gone.

Hendrik Dey, restating his 2011 book (*Le Mura Aureliane nella storia di Roma* 1, 2017, p. 15):
the 18,837.5 m total *"comprende anche le mura fluviali che correvano per ca. 4600 m lungo la
riva sinistra del Tevere… queste mura erano costituite anch'esse da cementizio rivestito di
cortine laterizie ed erano scandite da torri, ma risultavano sensibilmente meno imponenti di
quelle terrestri"* — **the same brick-faced concrete, towered, but markedly lighter.** The one
surviving fragment, opposite the ex-Mattatoio at Testaccio, is **1.20 m thick and 5–6 m high**.
**[MOD]**

| | **West return — the river wall** | **East return — the Castra Praetoria** |
|---|---|---|
| From | the Tiber angle, x +2, z 538 | the camp's NE angle, x +1335, z 633 |
| To | z ≈ 900, and on off-map | the map's **east edge at z ≈ 807** [DER] |
| Real length on this map | ~800 m of the 4,600 | ~350 m of the camp's 1,050 |
| Thickness | **1.20 m** | full military wall |
| Height | **5–6 m** | circuit height |
| Towers | at the same **37.1 m** interaxis; the Einsiedeln itinerary counts **8 in sector Q and 16 in sector R**, i.e. **24 on the Campus Martius river front** | the camp's own |
| Posterns | **five or six**, named in medieval sources and matching the ferry landings — §5.3 | none |
| Bays | **none** — see below | **none** |
| Corner tower | **"of great strength, which was considered by the Romans to be haunted by the ghost of Nero: *ubi umbra Neronis diu mansitavit*. It was also called Lo Trullo"** (Lanciani 1897, 73). Two of its neighbours (A1–A2) still stand. | — |

**Why neither return carries bays, and it is an engine constraint, not a design preference.**
`CitySystem.bayAt` indexes bays arithmetically in x (§2.1). A wall that turns a corner and runs
in z cannot be a bay: two bays would share an x and every masonry query on the circuit would
answer for the wrong one — *"and the failure looks like arrows passing through stone rather
than like an index bug"* **[SRC]**. So the returns publish **`Blocker`s, `occBlockers` and
obstacle boxes, and no spine.** They are closure.

**And that is the right answer historically as well as mechanically.** Procopius, on this exact
frontage in 537: *"since that part of the circuit-wall was the least assailable of all, because
the river flows along it, he supposed that no assault would be made there, and so stationed an
insignificant garrison at that place"* (*Gothic War* V.22.15). **[ANC]** A 1.2 m screen wall
behind 94 metres of unfordable water is not a fighting front, and the map should not pretend it
is one.

**Caveats to carry into §11.** Nothing of the river wall survives in the Campus Martius; the one
standing remnant has the **Honorian** blind-arcade formula, so the *Aurelianic* river wall is an
inference from the circuit's measured total; and Platner & Ashby record that the
Porta Flaminia–Pons Aurelius stretch *"disappeared in the Middle Ages"*, with the buried
remnant finally destroyed for the **muraglioni** after 1876 — the embankments *"risultavano
incompatibili con la costruzione dei Muraglioni"* (Giovanetti 2017, 137).

**The acceptance test for §4.6 is a nav test, not a geometry test** (§15, task 9): the only
open bands on the whole wall line, swept out to both map edges, may be the gates and the
`footing` bays.

### 4.7 The Castra Praetoria — a fort inside the wall

**x +1150 … +1335 across the north, then south to z 705.** [ARCH]

Aurelian ran the circuit into the Praetorian camp and used two of its four walls, raising them
to circuit height. **Lanciani counts 1,050 m of the camp's wall as circuit** — the second
largest single reuse anywhere on the 19 km, after the Horti Sallustiani.

| property | value | tag |
|---|---|---|
| Real plan | **437 × 377 m** — the survey's own citation, from Platner & Ashby, with the *cardo maximus* on **340°/160°** and the **north and east walls on 70°/160°**. Modelled in `ROME` at 400 × 377 with `offMapEast: true`. **[SRC]** | [ARCH] |
| Date | **AD 23**, brick-faced, Tiberius/Sejanus | [ARCH] |
| Length taken into the circuit | **1,050 m** | [MOD] Lanciani 1897, 72 |
| Modelled north face | **185 world m**, bays 31–35 | [DER] |
| Garrisonable | **yes**, as ordinary bays. Its interior is not city fabric — it is a barrack grid. | [GAME] |
| Construction stage | **`finished`**: heightening 1,050 m of standing military wall is the cheapest work on the circuit, and the men who had to do it were living inside it | [DER] |
| The survey already concedes the frame cuts it | *"at true size it is 167,000 m², a tenth of the entire buildable city … The east edge of the map cuts the camp, which is the honest version of the compromise the frame makes everywhere else."* **[SRC]** | — |

**Why it earns the space.** It gives the east third of the map something that is not more
curtain: a walled enclosure *inside* the walled city, garrisoned by a different kind of
soldier. If the Juthungi get over at the Vallis Sallustiana they arrive in a garden; if they
get over at the Castra they arrive in a fort. That is `CARTHAGE.md` §8.9's "three gates, three
different battles" delivered on the east flank without inventing anything.

### 4.8 The construction state — a rule with a number behind it

Aurelian began the wall in **271** and it was finished under **Probus** (276–282). *Historia
Augusta*, *Aurelian* 21.9: *"his actis cum videret posse fieri ut aliquid tale iterum, quale
sub Gallieno evenerat, proveniret, **adhibito consilio senatus muros urbis Romae dilatavit**"* —
and 22.1 has him leave for Palmyra as soon as the arrangements were made, so **he was not in
Rome for most of the building**. Zosimus I.49: *"Rome, which before had no walls, was now
surrounded with them. This work was begun in the reign of Aurelianus, and was finished by
Probus."* **[HA] [ANC]** The line chosen was **the octroi boundary of Commodus' time**, already
marked on the ground with *cippi*.

The shipped map's unfinished-wall conceit is **historically right and stays**. What changes is
why a given bay is unfinished — because the archaeology answers it, precisely, in metres.

**The number the rule comes from.** Lanciani lists the ready-made portions Aurelian's surveyors
took into the line. On the stretch this map models:

| reuse | real length | where on this map | tag |
|---|---:|---|---|
| **Horti Aciliorum** terrace substruction (the Muro Torto) | **550 m** | x +187 … +409 | [MOD] Lanciani 1897, 72 |
| **Horti Sallustiani** enclosure | **1,200 m** | x +520 … +1040 | [MOD] same |
| **Castra Praetoria** north and east walls | **1,050 m** | x +1150 … +1335 and the east return | [MOD] same |
| **Total already standing** | **2,800 m** | | [DER] |
| Real along-wall length, Tiber angle → Castra NE | **c. 4,000 m** | | [DER]; Cozza's surveyed Tiber → Porta Salaria alone is **2,079 m** in 57 towers |

> **Seventy per cent of the wall on this map was not built by Aurelian.** It was built by
> Lucullus, by Sallust, by the Acilii Glabriones and by Sejanus, and Aurelian's engineers
> heightened it. Elsewhere on the circuit the same is true of 800 m of the Aqua Marcia's
> arcades, 475 m of the Claudia's and 100 m of the Amphitheatrum Castrense, and Lanciani
> records them encasing a decorated nymphaeum — statues and all — inside the new masonry at the
> Porta S. Lorenzo rather than stop to demolish it. **[MOD]**

**So the rule is three-way, not two-way, and each branch maps onto a `BayStage`:**

| what was there in 271 | what Aurelian's men had to do | stage |
|---|---|---|
| **nothing** | dig a trench, pour a footing, raise 7 m of brick-faced concrete | **`footing`**, **`gap`** |
| **a garden or aqueduct wall, standing but low** | heighten it, cut a walk, add towers and merlons | **`half-built`**, **`no-parapet`** |
| **a wall already at or above circuit height** — the Muro Torto, the Praetorian camp | very little, or in the Muro Torto's case *nothing at all* | **`finished`** |
| **the gate** | everything, first, because a circuit with no way through it is useless to the city inside it | **`finished`** |

**And the arithmetic falls out.** Of the ~4,000 real metres on this front, the stretch with
nothing to reuse is **Cozza's 263 m from the Tiber angle to the Porta Flaminia plus his 114 m
from the gate to the Pincian's north-west corner = 377 m** — which at `KX` is **167 world
metres, four and a half bays**, and which is **exactly the flat Campus Martius neck between the
river and the hill** (§3.5). *The only stretch of this circuit Aurelian had to build from
nothing is the stretch the map is named after, and it is the stretch with no terrain advantage,
at the end of the only road, in the funnel.*

**The 36 bays, and what stands on each.** Pitch 37.03 m from x +2.

| bays | x | stretch | what was there | stage |
|---|---|---|---|---|
| **0** | 2–39 | the Tiber angle and the corner tower *Lo Trullo* | nothing | **`footing`** |
| **1** | 39–76 | **Porta Flaminia** | nothing, but it is the gate | **`finished`** |
| **2** | 76–113 | Campus neck | nothing | **`footing`** |
| **3** | 113–150 | Campus neck | nothing | **`gap`** |
| **4** | 150–187 | the Pincian's foot | nothing | **`footing`** |
| **5–11** | 187–446 | **the Muro Torto** | 550 real m of standing terrace, gigantic | **`finished`** (§4.5) |
| **12–13** | 446–520 | the Pincian crest | *horti* enclosure walls | **`no-parapet`** ×2 |
| **14** | 520–558 | **Posterula Pinciana** at x 527 (§5.1) | garden wall | **`half-built`** |
| **15–19** | 558–743 | the Horti Sallustiani, west | 1,200 real m of standing enclosure | **`half-built`** ×2, **`finished`** ×3 |
| **20** | 743–780 | **Porta Salaria** at x 751 | — | **`finished`** |
| **21–28** | 780–1076 | the Sallustian east shoulder and the tomb frontage | standing walls and tombs | **`no-parapet`** ×2, **`finished`** ×6 |
| **29** | 1076–1113 | **Porta Nomentana** at x 1103 | — | **`half-built`** |
| **30** | 1113–1150 | the approach to the camp | little | **`no-parapet`** |
| **31–35** | 1150–1335 | **the Castra Praetoria** | 1,050 real m of standing military wall | **`finished`** |

| stage | shipped (50 bays) | redesign (36 bays) |
|---|---:|---:|
| `finished` | 35 | **23** (7 of them the Muro Torto) |
| `half-built` | 6 | **4** |
| `no-parapet` | 5 | **5** |
| `footing` | 3 | **3** |
| `gap` | 1 | **1** |
| **garrisonable** | **45** | **32**, plus three gatehouse and postern crowns (§5.4) |

**The `footing` bays keep their job and get a better one.** `SIEGE.md` §2.8 is explicit that
they are *"a legitimate route into Rome and the only one the AI ever finds"*, and `wall.ts`
pushes a `Blocker` for every stage **except** `footing`. That stays. What changes is where they
are: today they are at x −553, +369 and +405, which after the river correction is water and
hillside, and one of the three is unreachable to the pathfinder anyway (§4.1). In the redesign
they are **bays 0, 2 and 4 with a `gap` at 3** — a hundred and ninety world metres of unbuilt
wall either side of the finished gate, on the flat, at the end of the road. *The route the AI
finds becomes the route a historian would have predicted, and it is also the route the camera
is already pointed at.*

**One thing to be careful of.** Concentrating the way in also concentrates the fight, and 31 of
36 bays could become spectators. The counterweight is the **five `no-parapet` bays**, which are
spread along the reused stretches and are where a ladder goes in: `masonryTopAt` returns
`bay.walkY` flat on them because the merlon blocks are stacks waiting on the walk, so a
defender standing there has no cover and a shot from outside is not stopped 1.26 m above the
travertine. **The route is concentrated; the escalade targets are not.** §15 task 14 measures
whether that balance holds.

### 4.9 The building site, and Carthage's ditch lesson applied

The Aurelianic circuit had **no ditch** (§7.1). What it had in 271 was a construction site, and
that is Rome's outwork. Every element below is attested; two of them are corrections to what a
reasonable person would otherwise build.

| element | dimensions | evidence | tag |
|---|---|---|---|
| **Foundation trench** ahead of every `footing` and `gap` bay | **about 13 English feet = 3.96 m wide**; depth *"varied according to the nature of the ground"* and is **not attested** — take **2.4 m** and say so | Richmond, p. 60 | [ARCH] / [GAME] for the depth |
| **Timber shuttering** in the trench | uprights **kept on the inside**, proved by their impressions in the concrete; withdrawn afterwards or left in | Richmond, p. 60 | [ARCH] |
| **Stepped, exposed foundations** where the ground dips | faced with tiles or tufa blocks, their top kept level, with **one or more offsets of a single course of *bipedales* at about ground level** | Richmond, p. 60 | [ARCH] |
| **Building lifts, and they are the site's rhythm** | toothed joints show the section laid in one operation was **4.44–5.92 m long × 3.55 m wide × 1.18–1.48 m high** (15–20 × 12 × 4–5 *pedes*) — and *"in the Wall itself these joints are always regularly and carefully made, much more so than in the parapet"* | Richmond, p. 60 | [ARCH] |
| **NO PUTLOG HOLES** | **this is the correction, and it inverts the obvious.** *"Putlog holes are absent, so as to suggest either that all the work was done from the top of the Wall as it grew, or that the builders worked from double scaffolding, as shown on the Tomb of Trebius Justus."* Their **absence is the clearest single diagnostic separating Aurelianic from Honorian work**, and is used as a positive criterion for dating curtains B16–B18. **Putlogs on a 271 wall date it to 403.** | Richmond, p. 60; corroborated twice in Dey's volume | [ARCH] |
| **Free-standing double scaffolding** | therefore: pole scaffold standing clear of the face, not tied into it, on the `half-built` and `no-parapet` bays. The shipped scaffold (13 standards, lifts every 1.9 m, boarded deck, **10 putlogs**) is right in everything but the putlogs. **[SRC]** | | [ARCH] |
| **Salvage yards, not brickworks** | **there are no Aurelianic brickstamps.** In the sixth curtain east of Porta Asinaria **37.14 % of stamps are Hadrianic**, 5.17 % Antonine, 5.18 % Severan; a 1912 collapse near the Amphitheatrum Castrense yielded **464 stamped bricks**, first century to Theodoric, **mostly Hadrianic**. The site is stacked with **second-hand brick sorted by size**, not new. | Lanciani 1892; Pfeiffer/Van Buren/Armstrong via Richmond | [ARCH] |
| **Brick sizes to stack** | *bessalis* **0.197 m** square, *sesquipedalis* **0.444 m**, *bipedalis* **0.592 m**; the *bessalis* is cut into 2 or 4 triangles and the *sesquipedalis* into 8 or 16, giving faces of **0.18–0.22 m** and **0.25–0.28 m** on the wall; facing bricks *c.* **0.04 m** thick | Bukowiecki via Medri | [ARCH] |
| **Coursing** | *modulo* (5 courses + 5 beds) **0.23–0.30 m, most often 0.26–0.27 m** → **18–19 courses per metre**; bonding courses of *bipedales* at **irregular intervals**, *"rare, and the tiles thereof very thin"*; recurring *"piani di compensazione"* to bring the courses back level | Cozza via Medri; Richmond | [ARCH] |
| **Core** | tufa aggregate in **lime and pozzolana**. Aurelianic mortar is predominantly pozzolana with rare calcareous inclusions and **well-slaked** lime; the Honorian is coarser with badly-slaked lime producing gypsum — another diagnostic | Esposito/Mancini/Vitti | [ARCH] |
| **Spoil banked against the INNER face** | up to **3 m high** near Porta Tiburtina, with a **service road along the inner face** | Lanciani 1892, p. 88; 1897 | [ARCH] |
| **Demolition running just ahead of construction** | in 1884 a **shell-and-pumice nymphaeum was embedded whole in the masonry — *"the statues were not removed from their niches"***; in 1892 a first-century house was found where the engineers *"satisfied themselves with filling up the space between the sides of each room, leaving intact mosaic pavements, marble stairs, lintels, thresholds, and frescoes… then they shaved off whatever projected on either side, and went on with their work."* | Lanciani 1897, pp. 70–71 | [ARCH] |
| **Dressed merlon blocks on the walk** | already modelled: `masonryTopAt` returns `bay.walkY` flat on a `no-parapet` bay because *"the dressed merlon blocks are five stacks waiting on the walk, not a crest"* **[SRC]** | | [SRC] |
| **Who is on site** | **the city's guilds, not the army.** Malalas: Aurelian *"compelled the guilds of Rome to work at the task"*, and when it was done decreed that **all the city guilds should be styled *Aurelianic*, "receiving the distinction of the Imperial Name in return for their affliction and blows."*** Richmond accepts it, and his strongest argument is architectural: the circuit's blunders — the awkward junction at the Castra Praetoria's north-west angle, *"the complete lack of communication along the Wall at the Pyramid of Gaius Cestius"*, and **"glaring cases of bungling in the setting out of the gate in relation to the Wall" at Porta Flaminia and Porta Ostiensis East** — *"could hardly have been made by military labour."* | Malalas XII; Richmond pp. 28–29, 37, 191 | [ANC] [MOD] |

> **And that last row is a licence.** The Porta Flaminia's setting-out against the curtain is
> *attested to be botched*. The map does not have to make its gate meet its wall neatly. It
> should make it meet badly, visibly, in the way §14.3's snap test will report — and print the
> number rather than tidy it away.

**Every heightfield element above is a cut, and that is the point.** `SIEGE.md` §5.3 records
Carthage publishing a 20 × 6 m ditch that four commits' worth of consumers were told about and
which measured **0.16 m at its worst station**. **The fix has since landed** and its shape is
what Rome copies:

1. The plan publishes `RomeWorks` with **`built: false`** — a request across the seam, not an
   assertion.
2. `src/maps/heightfield.ts` answers it, and `built` becomes a fact carried back in.
3. **The profile is not copied.** Every dimension comes from one `ROME_WORKS_SECTION`, every
   centreline point from one `romeWorksPath(circuit)` — the *same call* the wall builder makes
   to publish the record.
4. The depth is **capped against the freeboard** the ground has over `WATER_LEVEL` less 0.6 m,
   because a dry cut taken under the datum renders as water. On a 12.2 m plain over a 5.0 m
   datum that is 6.6 m of budget against a 2.4 m trench — ample, and the cap is still written,
   because Carthage's was not until it had to be.
5. **`assertWorksCut` prints at every boot** — stations cut, relief median against spec, worst
   shortfall and its x, worst nav gradient. Carthage's line is the template.

The acceptance measurement is in §15, task 8, and it is a transect of `TerrainSystem.heightAt`
— *not* a read of the plan. And per `SIEGE.md`'s own warning about that instrument: **sample
several bays, not the gate bay**, or you will measure a causeway.

### 4.10 The draw budget, priced before the build rather than after it

The whole-frame cap is **220** and the assault at ultra measures **192** at `3595b48`, of which
the city is **101 draws / 2.38 M triangles in 23 chunks** — wall 44, monuments 22, city 21,
road 5, gate 2, aqueducts 2. **[MEAS]** So the redesign has about **28 draws of headroom** and
it is adding a Muro Torto, **two more gates and a posterula, six posterns**, a fort and two
returns.

Priced item by item, against the measured 44-draw wall family:

| change | draws | reasoning |
|---|---:|---|
| **1,781 → 1,333 world m of curtain, and 50 bays → 36** | **−13** | `BAYS_PER_CHUNK = 8` **[SRC]**; 50 bays make 7 chunks, **36 make 5**, and the family measures 44 over 7 |
| Two more gates and a posterula | **+4** | Rome's one gate costs 2 chunks (`gate-door` r 16, `gate-wreck` r 22) outside the wall chunks; the block itself is inside them. **And the portcullis comes out** (§5.5) — thirteen bars, three rails and a slot. |
| Six posterns | **+6**, or **+1** | Carthage pays *one `timber` stream per postern door* **[SRC]**, and says so as a cost. Merge the six leaves into one stream per chunk and it is +1. **Do the merge.** |
| The Muro Torto | **0** | it is curtain geometry in a chunk that already exists |
| The Castra Praetoria | **+5** | one chunk, walls and barrack ranges, aggressive LOD |
| Two returns | **+4** | two chunks; no towers, no parapet, no stairs |
| The construction works (§4.9) | **+2** | one dressing stream; the trench itself is heightfield, not geometry |
| **Nine external stair flights → 32 internal tower stairs** (§9.3) | **−2** | nine masonry flights with parapets and coping become geometry inside towers that are already drawn, most of it never visible |
| **Net** | **+6**, or **+1** with the postern merge | city 101 → 107 or 102; whole frame **192 → 198 or 193** |

**Under 220 with more than twenty to spare, and the redesign is very nearly draw-neutral.** The
two largest savings — 448 world metres of curtain that never existed, and fourteen fewer bays
at the true 37.1 m interaxis — are both banked before anything is added. **If it overruns, the lever is the Castra's
interior and not the wall**: a fort read as an enclosure from outside costs one chunk, and its
barrack grid is the only thing on this list a player never stands among unless the east flank
falls.

The triangle side is not the constraint: Carthage's assault camera runs **8.99–14.45 M** and
Rome's boots at **8.54 M**. **[MEAS]**

---
## 5. The gates, the posterns, and the one number an aperture is allowed to have

### 5.1 Three gates and two posterulae, and none of them invented

Carthage has three gates and eight posterns, **all of them [GAME]** — *"No ancient source gives
a gate count for the land wall and none has been excavated"* (`CARTHAGE.md` §4.5). Rome is the
opposite case and the redesign should take the free win: **every aperture below is attested,
most of them stood into the twentieth century, and their positions are recorded to the metre.**
The shipped map has one of them.

The circuit carried **sixteen main gates**, of which **four were first class with a double
archway: Flaminia, Appia, Ostiensis and Portuensis**. **[MOD]** Three of the sixteen and two
posterulae fall on this map's front.

| aperture | x | z | bay | form in 271 | the road | what is behind it |
|---|---:|---:|---:|---|---|---|
| **Porta Flaminia** | **+72** | **530** | 1 | **twin-arched, first class**, with **semicircular brick towers** — those found in 1877 are Aurelian's; the square marble bastions are Honorian **[ARCH]** | Via Flaminia, called the **Via Lata** only from the fourth century — *in 271 a Roman still calls it the Flaminia* **[MOD]** | the northern Campus Martius: the Mausoleum of Augustus, the Ara Pacis, the Horologium, and the **Trigarium and Tarentum**, open ground in the Tiber bend |
| **Posterula Pinciana** | **+527** | **587** | 14 | ***a postern, not a gate.*** It was made a gate by **Honorius**; in 271 it is a small door. **[MOD]** §5.3 | the *clivus* to the Pincian | the **Horti Aciliorum**: terraces, retaining arcades, a *piscina*, an octagonal nymphaeum. **Rome's Megara** (§6.5). |
| **Porta Salaria** | **+751** | **588** | 20 | single-arched | Via Salaria | the **Horti Sallustiani** in the valley between the Pincian and the Quirinal — a second garden estate, below the wall on both sides |
| **Porta Nomentana** | **+1103** | **588** | 29 | single-arched | Via Nomentana | the *Campus Cohortium* and the **Castra Praetoria** |
| **five or six river posterulae** | on the west return | | — | small doors onto the wharves | the ferry landings | the Ripetta quarter and the wine wharf at the **Ciconiae Nixae** |

**Porta Salaria was demolished in 1921 and is photographed**; the pool in §13 carries a *c.*
1870 plate of the ancient gate. **Porta del Popolo, by contrast, shows no ancient fabric at
all** — the outer face is Nanni di Baccio Bigio's of 1562–65, the inner Bernini's of 1655, the
flanking towers were pulled down in 1879 and the side arches cut in 1887. **The Porta Flaminia
must be built from the type**, and the type is the round-towered northern-arc gate of which
**Porta Pinciana is the best-preserved specimen**, plus the Lanciani plan for the position.
That is stated here because a builder who photographs Porta del Popolo will build a
sixteenth-century gate.

`siegeGateId` stays **`porta-flaminia`**: it is on firm ground, at the end of the one road, and
the only aperture on the map a ram can reach (§3.6).

**And there is a fourth gate that must not appear.** The **Temple of Sol**, Aurelian's own, was
dedicated in **274** — three years after this map — and its site in the *campus Agrippae* east
of the Via Flaminia is **open parkland in 271**. So are the **Baths of Constantine** on the
Quirinal (*c.* 315) and the **Pons Probi** (late 270s). §7.6 lists the rest.

### 5.2 The aperture rule — and why today's gate is three different widths

This is the constraint the brief names and it is the sharpest engineering point in the
document.

Carthage's gate is 5.2 m of drawn stone, a 6.2 m collision box and a **7.9 m occupancy
raster**. Rome's is worse in ratio and nobody had measured it: **`GATE_OPEN_WIDTH = 4.3` m
declared **[SRC]**, and `8.00 m` of clear passage the moment `setGateOpen` fires** — [MEAS] at
`3595b48` by `tools/scratch/probe-romeaperture.mjs`, bisecting `blocksMovement` across the
carriageway at 0.05 m with the gate open, and confirmed to 0 m with it shut. **1.86× the
declared width, and exactly two `OCC_CELL`s.**

Three numbers, three computations, no single source of truth. The mechanism, read out of
`CitySystem` at `3595b48`:

| # | view | Rome | Carthage | the literal |
|---|---|---|---|---|
| 1 | **drawn stone** | **4.30 m** | **5.20 m** | `archPanel(… openWidth: GATE_OPEN_WIDTH …)`, `wall.ts:2150`; `GATE_PASS_W`, `carthageWall.ts:396` |
| 2 | **plan declaration** | 4.30 m, **imported** | 5.20 m, **hand-copied** — `CARTHAGE_SECTION.gatePassageWidth` exists and is not read | `rome/plan.ts:66`; `carthage/plan.ts:92` |
| 3 | **collision box cut** | **5.30 m** | **6.20 m** | `const half = this.plan.gateOpenWidth * 0.5 + 0.5;` — `CitySystem.ts:890` |
| 4 | **occupancy raster** | **8.00 m** | **8.00 m** | `clearSegment(gate.x, gate.z − 20, gate.x, gate.z + 20, 2.4)` with `OCC_CELL = 4` — `CitySystem.ts:646` |
| 5 | **nav grid** | one **7 m** cell | one **7 m** cell | `clearStructure(…, CELL * 0.5)` along the gate's own normal — `Pathfinding.ts:1489` |

**Five independent computations, and exactly one link between any two of them** — Rome's stone
and Rome's plan share `GATE_OPEN_WIDTH` by import. The `+0.5` body margin, the `2.4` raster
clear and the `CELL*0.5` nav radius are three unrelated literals.

> **And the famous "7.9 m" is not a property of Carthage's gate.** There is no literal `7.9`
> in the tree. `markSegment`/`clearSegment` paint every cell whose *centre* lies within
> `halfW + OCC_CELL/2` = 4.4 m of the axis, on a 4 m lattice — so the cleared band is
> **8.00 m on both circuits**, and a probe stepping at 0.1 m reports 7.9. Rome's 4.3 m
> carriageway and Carthage's 5.2 m produce the identical hole. *The raster does not read
> `gateOpenWidth` at all.*

Two further disagreements ride along with it, both worth closing in the same task:

- **The two coarse clears run along different axes.** `CitySystem` clears straight along ±z
  regardless of the wall's bearing; `Pathfinding.openGates` clears along the gate's own
  `facing` normal. Rome's crest is near axis-aligned so they nearly agree; Carthage's line
  skews ~3.5° and they do not. **[SRC]**
- **A tower has three footprints.** Drawn 7.6 × 9.5 offset 1.75 m fieldward; obstacle box
  7.6 × 7.6 on the wall line; raster a circle of r 3.8 on the wall line. **The 3.5 m the tower
  projects past the outer face exists in the mesh and in neither collision view** — on both
  circuits. **[SRC]** A ladder or a siege tower docking against a curtain tower is docking
  against something the sim cannot feel.

**The direction of the error is the dangerous one.** The raster is the *widest* of the three,
and the raster is what `Pathfinding` stamps. So the route planner believes in a hole two
metres wider than the stone, sends a column at it on that frontage, and the crowd solver jams
them in the jambs. That is the mechanism behind a gate that "opens" and does not flow.

**The rule to build to, and it is three lines:**

> 1. **One number per aperture.** A gate publishes `clearWidth` and *nothing else* computes a
>    width. The drawn jambs, the obstacle boxes and the raster clear all derive from it, in one
>    helper, the way `stairSolid` already derives the stair for both the raster and the box
>    set — "`getObstacles()` and `blocksMovement()` disagreeing about the same masonry is the
>    exact bug this file produced with the gate carriageway" **[SRC]**.
> 2. **The ordering must be `raster ≤ collision ≤ drawn`.** The pathfinder is the most
>    pessimistic view and the stone the most generous. Today it is exactly inverted.
> 3. **`drawn − raster ≤ OCC_CELL`**, i.e. 4 m.

**And now the hard part, because the archaeology will not let the widths be inflated.** The
only directly published Aurelianic gate span is **Porta Latina, 4.20 m wide × 6.55 m high**
(Giovenale 1931, p. 93). Di Cola's 2017 re-measurement of **Porta Appia** — the same
first-class twin-arched type as the Porta Flaminia — gives **two arches of 4.50 m each
(≈ 15 *pedes*) with a central pier of 3.00 m (10 *pedes*)**, arch height 5.80 m, and
semicircular towers *c.* 14 m high. He explicitly rejects Richmond's 3.81 m: *"a value which
does not seem to correspond to archaeological reality, not least because the fornices of the
original gates are **all over 4 m wide**."* **[MOD]**

**So a Roman gate lane is 4.2–4.5 m and no argument makes it eight.** The rule survives anyway,
by being applied in the direction that is safe:

| aperture | form in 271 | drawn | collided | **rastered** | *pedes* |
|---|---|---|---|---|---|
| **Porta Flaminia** | **twin-arched, first class** — one of only four on the whole circuit **[MOD]** | **4.50 + 3.00 pier + 4.50 = 12.00 m** of gateway | both lanes, and **the pier is solid** | **one lane only, 4.0 m, snapped to a cell boundary** | 15 / 10 / 15 |
| **Porta Salaria** | second class: single arch, brick façade, two semicircular towers with three round-headed windows apiece | **4.30 m** | 4.30 | **4.0 m**, snapped | 14.5 |
| **Porta Nomentana** | second class. *"The only example of one of Aurelian's original gates which has not been re-faced"* **[MOD]** | **4.30 m** | 4.30 | **4.0 m**, snapped | 14.5 |
| **Posterula Pinciana** | third class — *"hardly distinguishable from the larger posterulae"* | **2.70 m**, the measured width of the Via Nomentana postern | 2.70 | **nothing** — §5.3 | 9 |

**Rastering one lane and not two is the whole trick, and it is the rule doing its job.** The
pathfinder is the most pessimistic view: it sees a single 4 m file through the Porta Flaminia,
which is what a 4.5 m arch can take, and it never plans a frontage the stone cannot deliver.
The second lane exists in the drawn geometry and in the collision boxes, so men shoved sideways
by the crowd solver flow through it, and a defender who loses one arch has not lost the gate.
Every inequality holds: **4.0 ≤ 4.30 / 4.50 ≤ 4.50**, and `drawn − raster` is 0.5 m against a
4 m budget.

**The pier must be snapped to an occupancy cell boundary at build time**, and the acceptance
test must confirm the raster shows **one** clear lane and not a 12 m hole. That single alignment
is the difference between a gate and a breach.

> **Compare the before.** Today Rome declares 4.3 m and the raster opens **8.00 m** — a hole
> **1.86× the stone, on the dangerous side** — and the identical 8.00 m appears at Carthage
> against a 5.2 m arch, because the number is a property of `clearSegment`'s 2.4 m half-width
> against a 4 m lattice and not of either gate.

**One visual note the build pass must have.** Aurelianic arches carry a ***ghiera "a
ventaglio"*** — a fan-shaped ring with **pentagonal voussoirs at the haunches**. The Honorian
narrowing inserts a ***ghiera "ad armilla"*** with **all-trapezoidal** voussoirs. **[MOD]** It
is the single most useful diagnostic an artist has for telling 271 from 403 on this monument,
it is visible at Porta Latina, Appia and Tiburtina, and getting it wrong dates every arch on
the map by a century and a half.


### 5.3 Posterns are sally ports, not passages

The Aurelianic circuit carried *posterulae* — small doors through the curtain at ground level,
for sorties, for the wall's own maintenance and, on the river front, for the wharves. **Three
have been measured**: the postern of the Via Nomentana at **2.69 m** with a monolithic
travertine lintel and two relieving arches, the postern of Vigna Casali at **2.90 m** (a
converted tomb doorway), and **Porta Ostiensis West at 3.60 m** with travertine jambs and a
**monolithic travertine threshold over four metres long**, blocked in the early fourth century
with a wall over 2 m thick and demolished in 1888. **[MOD]** The five river posterulae's *form
and size are not attested.*

**Rome's are attested and Carthage's are not**, which is the whole difference in how the two
maps should treat them. **Five or six posterulae on the Campus Martius river front are named in
medieval sources** (Dey 2017, 16, citing Corvisieri 1878 and Richmond 1930, 236–39), and their
names match the ferry-landings Lanciani lists on the same bank: the **porto di Ripetta**, the
**porto della Tinta**, the **posterula Domitia**, the **porto dell'Armata**. **[MOD]** And on the
land front, the **Pinciana was itself a posterula in 271** and only became a gate under
Honorius. **[MOD]**

**Now the engine problem, and it is the same one as §5.2 at the other end of the scale.** A
2.7 m hole is **below the resolution of every collision representation the engine has**. A 4 m
occupancy cell cannot hold it, and the two ways out are both wrong: inflate the postern until
the raster can see it — Carthage's eight measure as *"eight bands about 4 m wide"* at
`6698e19` — or draw an arch with nothing behind it, which is instance five of `SIEGE.md`
§5.2's pattern.

**The third way, and it is both honest and better:**

> A postern is a `GateOut` that is **shut**, drawn at its real 2.7 m, carrying a door the siege
> can break — and when it opens it publishes a **`Crossing`**, not a raster clear.

`Crossing` is already the right object. `SIEGE.md` §2.4: *"a `Crossing` is a polyline with an
arc-length parameter per man, and a man's position is authored from that parameter rather than
steered toward"* — and `LinkKind.Breach` lanes *"are authored paths and do not consult the nav
grid"*. A postern therefore becomes a **single-file authored route through the wall**, usable
by the garrison for a sortie and by a storm that has taken one, and invisible to the
pathfinder — which is exactly what a 2.7 m door should be.

| | value | tag |
|---|---|---|
| On the land front | **one**: the **Posterula Pinciana**, bay 14 | [MOD] |
| On the west return | **five**, at the ferry landings | [MOD] for the count and the institution; [GAME] for the exact positions |
| Width drawn | **2.70 m**, monolithic travertine lintel, two relieving arches over it | [ARCH] the measured Via Nomentana postern |
| Nav | **none.** Not in the raster, not in the obstacle gap, not a route. | [GAME] |
| Crossing throughput | **two abreast**, one pair per **1.1 s**, both directions — 2.7 m is three men at the crowd solver's 0.84 m body | [DER] |
| Doors | shut, breakable — `GateDoorOut` as the Porta Flaminia already has | [SRC] |
| Cost | Carthage pays *one `timber` stream per postern door* and names it as a cost **[SRC]**. **Merge the six leaves into one stream per chunk** — §4.10. | [DER] |

**Rome already has one of these and nobody knows.** `wall.ts` builds a **river terminus** at the
west end with a postern cut through it — `archPanel(4.2, 5.0, spring 2.0, openWidth 1.8)`
**[SRC]** — drawn, and with nothing hung in it and no crossing behind it. It is Carthage's
postern defect, on Rome, already shipped. §15 task 7 closes both.

### 5.4 The gatehouse, its doors and its crown

Three things about the shipped Porta Flaminia block, all measured:

- The block is **25 × 11 m** with a **8.4 m** passage, a **4.8 m** attic and **2.0 m** merlons,
  `topY` 44.324 and `sillY` 42.324 **[SRC]** [MEAS] at `6698e19`.
- Its merlon line is cut at **1.5 / 0.8**, deliberately *not* the curtain's 1.7 / 0.95, and it
  publishes its own pair, because "resolving the block through the plan's numbers would put
  the collision model a whole merlon out of register by the block's far end" (`SIEGE.md` §5.4).
  **Every gate in the redesign must publish its own `merlonLength`/`crenelLength`.**
- **The garrison cannot stand on the crown.** `Siege.buildSpine` clips stations inside the
  gate block, and at `6698e19` the clip **never fires**, because `Siege`'s `CityView` declares
  `{ x, z, hw, hd, rot }` and `CitySystem.getGateBlock()` returns `{ nx, nz, dx, dz, halfRun,
  halfDepth }`. `Math.abs(NaN) <= undefined` is `false`. So **22 of bay 19's 36 stations stand
  6.574 m below the gatehouse roof**, in the masonry, unable to shoot. `tsc --noEmit` is clean
  because the seam is `as unknown as`. (`SIEGE.md` §7.2, [MEAS] at `6698e19`.)

**The redesign's answer is the one both files already name as the better fix: put a run on the
crown.** A gatehouse roof is the strongest fighting platform on a wall and it is the thing a
player expects to hold. Concretely:

| | value |
|---|---|
| A gate publishes a **`GarrisonBay` for its own crown**, at `sillY`, with the block's own `merlonLength`/`crenelLength` | [GAME] |
| Its length | the block's `halfRun × 2` less the tower chambers: **~19 m at the Porta Flaminia**, ~22 stations at `STATION_PITCH = 0.86` |
| Its links | a `Step` or `TowerPass` to each neighbouring bay's walk, if the height difference is inside `LINK_MAX_GAP`; at Rome today the walk steps **7.15 m** across the gate (bay 19 at 35.75, bay 21 at 42.90) **[MEAS]**, which is far too much — so **the redesign must bring the two flanking walks to within 0.62 m of each other**, or the crown is a third island |
| Its stair | **one**, from the pomerium, inside the block |
| The clip | **delete it.** "The clip is written as a clip so that deleting it is the whole of that change" **[SRC]** |

The 7.15 m step is a consequence of `walkY`'s 0.55 m quantisation over rolling ground, and on
the redesigned circuit the Porta Flaminia is **bay 1, on flat ground** (§3.5, §4.8) — its
neighbours are bay 0 and bay 2, both `footing`, both on the 12.2 m Campus Martius plain. So the
two walks either side are naturally level. **That is not luck; it is the reason the gate is
where it is.**

### 5.5 The *cataracta* — delete it

The shipped Porta Flaminia carries a portcullis: **thirteen bars of 0.10 × 0.13 m spanning
±2.15 m, from `g + 5.30` to `g + 8.25`, in a slot 0.85–0.98 m inside the face** — and it is
**static**, permanently raised, with `wall.ts:2332-2338` saying outright that nothing in `src/`
moves it. **[SRC]** The setback is cited to the Porta Appia: `GATE_DOOR_SET = 2.2` because *"the
cataracta drops 0.85 m inside the face; the leaves hang 1.35 m behind it."*

**It is a Honorian feature on a 271 wall.** Richmond, p. 257, describing **period III — Honorius,
401–403**: *"All the new gateways were fitted with a portcullis."* And on the Aurelianic phase,
p. 190: *"It is not possible… to know whether there was a portcullis."* **A portcullis at an
Aurelianic gate is not attested anywhere**, and the popular claim that all Aurelian's gates had
a *saracinesca* is unsupported. Where the chases survive — Porta Latina, Appia, Tiburtina,
Clausa, Ostiense, Salaria — they belong to the rebuild; and at **Porta Asinaria the three
corbels are present and are *not pierced*,** which Richmond reads as vault-centring corbels
rather than pulley mounts. **[MOD]** *No published measurement of a portcullis groove exists at
all*; Richmond prints scaled plans instead of numbers and says so.

**So: remove the grille, and lose nothing.** The 271 closure is attested, is better, and is
already built:

| | value | tag |
|---|---|---|
| **Double-leaf timber doors, harr-hung** | already modelled — half-width 2.15 m, height 5.33, thickness 0.22, meeting-stile gap 0.045, 11 plank columns, four iron straps, two pintles, a 0.2 × 0.34 harr-post **[SRC]** | [ARCH] [SRC] |
| **A great bar behind them** | already modelled: `drawbar ±2.70 at g + 2.35` **[SRC]**. Attested at **Porta Latina**, where the slots for the leaves' hinges *and* **a bolt-hole for a great bar behind** both survive. | [ARCH] |
| The mechanic | **the ram breaks the leaves.** `setGateDoorBroken` already exists and already works, and `SIEGE.md` §5.1 records the release that made Rome's ram open Rome's gate for the first time. | [SRC] |
| Cost | thirteen bars, three rails and a slot come out of the gate chunk | [DER] |

**And when the leaves are gone there is still a wall behind them** — the *controporta*, a
horseshoe-shaped counter-gate court on the inner side. Whether Aurelian built any is **genuinely
open**: Richmond says he built no gate courtyards at all; **Dey (2011, pp. 41–42) argues the
courts at Porta Ostiense and Porta Appia *"seem attributable to Aurelian's time"***, because the
Ostiense court's **two fornices correspond to the two openings of the original Aurelianic
façade** which Honorius replaced with a single arch. Measured examples: Porta Tiburtina's court
is *c.* **20 × 12 m**, Porta Praenestina's a brick structure **0.30 m thick × 5.50 m long**.
**[MOD]**

**Recommendation: build the Porta Flaminia with a counter-gate court and flag it as contested.**
It is one more thing to fight through, it is the shape Vegetius describes (*Epitoma* IV.4: a
*propugnaculum* in front of the gate, *"in cuius ingressu ponitur cataracta"*), and Dey's
argument for an Aurelianic date is specific and structural rather than a guess. If it is cut,
cut it for cost and say so in §11 — not because it is unhistorical.


---

## 6. The city inside — the Campus Martius in 271

### 6.1 The scope decision, and why the survey stays

Carthage narrowed hard: one moment, one quarter, built to the excavation plan. The temptation
is to do the same at Rome — origin at the Pantheon, `KX ≈ 1.0`, the Campus Martius at something
near true scale — and it should be refused, for a reason that is arithmetic rather than
sentimental. Rome's survey is 34 monuments carrying real lat/long, checked against a
georeferenced Lanciani plate to **1.26 m worst-case over 7 km** and against a 50 cm orthophoto
to ~25 m on the Colosseum **[SRC]** `ASSETS.md`. Re-fitting the projection throws that away and
buys nothing the battle can see: the fight happens in the first 200 world metres behind the
wall, and those 200 metres are the Campus Martius either way.

**So: keep the survey, keep the projection, and re-weight the fabric.** Three zones:

| zone | z | what it is | how it is built |
|---|---|---|---|
| **The fought-in city** | wall … **~1000** (the Capitoline) | the Campus Martius: 466 world metres, every monument in §6.3, real street grid | to Campus Martius grain, at full LOD, and it is the map's second act |
| **The seen city** | 1000 … 1200 | the Forum, the Palatine, the Colosseum valley | as today |
| **The backdrop** | 1200 … 1374 | Caracalla, the Aventine, the Caelian | as today, and it may lose detail |

That is exactly Carthage's split between the Byrsa slope (built to the excavation plan) and
the Megara (scatter and low walls) — the same trade, drawn at a different place, and it is what
finally makes the map's name true. **The map is called `campus-martius` and the Campus Martius
is currently the least-built quarter on it.**

### 6.2 Which is the measured problem, and it is severe

At boot, `3595b48`, `campus-martius`, assault, ultra — three warnings the city prints about
itself every time and which appear in no document:

```
[city] via-lata  planned only 17 buildings from 593 frontages — the quarter is buried
[city] subura    planned only 13 buildings from 316 frontages — the quarter is buried
[city] velabrum  planned only 16 buildings from 260 frontages — the quarter is buried
[city] 271/1134 ranked-way samples inside a monument; worst via-recta at 80%
```

**[MEAS]** `tools/probe-boot-carthage.mjs --map=campus-martius --scenario=assault --quality=ultra`.

`via-lata` is the Campus Martius quarter — the Via Lata is the Via Flaminia inside the walls,
running from the Porta Flaminia to the Capitoline, and it is the axis of everything a break-in
fights along. **It planned 17 buildings from 593 frontages: 2.9 %.** `subura` is 4.1 % and
`velabrum` 6.2 %. The three worst-served quarters in the city include the one behind the gate.

The 24 % of ranked street length inside a monument is *documented and expected*
(`layout.ts:1842`: reported, not enforced, and 90 % on the Via Appia alone), so it is not a
regression — but on the Via Recta, which is the Campus Martius's own east–west artery, it is
80 %, and that is a street the map needs.

**The mechanism is `PLAN_SCALE` fighting the overlap resolver in the one quarter with the most
monuments per hectare.** `layout.ts:306-312` tabulates it: at 1:1 the monumental load is 49 %
of the buildable ground and the resolver moves every monument a mean of 174 world metres; at
0.65 it is 21 % and 43 m. The Campus Martius is where the remaining 21 % concentrates, because
twelve of the survey's thirty-four monuments are in it and it is only 466 world metres deep.
The insula generator then finds no room and reports honestly.

### 6.3 What actually stood there in 271

Positions are in the survey frame of §2.3, converted from a gazetteer authored on the
**Pantheon rotunda's centre** (41.898616 N, 12.476833 E). **The two surveys are independent and
they agree**: the gazetteer puts the Pantheon at repo `e −453, n +680` against `rome.ts`'s
`e −447, n +678` — **6 metres apart** — and puts the Porta Flaminia at world x 74 against
`GATE_X`'s 72.

**Checked monument by monument, only two of the twelve already in `ROME` differ by more than
30 world metres in either axis: the Baths of Nero (38 in x) and the Horologium (40 in x).**
[DER] Both are well inside `resolveOverlaps`'s own displacement, which `layout.ts` measures at
a **mean of 43 world metres** at `PLAN_SCALE = 0.65` **[SRC]** — so neither is worth moving,
and the agreement is better than the resolver's own resolution. **Do not re-survey what is
already surveyed;** the entries below correct *dimensions* and *state in 271*, not positions.

Sources throughout: **Platner & Ashby 1929**, **Digital Augustan Rome**, the **Severan Marble
Plan** (dated 203–211, so a snapshot **60–68 years before this map**, and the primary
planimetric authority for the Saepta, Divorum, Hecatostylum, Porticus and Curia Pompei, Circus
Flaminius, Crypta Balbi and the Largo Argentina temples), the **Sovrintendenza Capitolina**, and
the excavation literature named per row.

**Already in `ROME`** — check the dimension, keep the position:

| monument | x | z | plan, real m | state in 271 |
|---|---:|---:|---|---|
| **Mausoleum of Augustus** | 62 | 650 | **87 m diameter** (= 300 *pedes*), **c. 45 m** high; travertine socle 89 m; pavement 120 × 120 m | **Standing, intact, and sealed for 173 years.** Last burial Nerva, AD 98; opened once more for **Julia Domna in 217**, 54 years before this map. **Draw a tall cylinder with a planted crown, not a stepped wedding cake** — the 2007–10 excavation supports *"l'elevato del muro perimetrale molto più alto"*. Two obelisks flank the entrance *c.* 22–30 m out. |
| **Ara Pacis** (original site) | 151 | 716 | enclosure **11.625 × 10.55 m**, walls **c. 6 m**, Luna marble | **Standing, drowning, derelict.** It needed **a 2 m retaining wall** against inundation; the only ancient attestation after Augustus is coins of Nero and Domitian; it is **absent from the Regionaries**. No evidence of cult for ~180 years. Its west forecourt fell nine steps to the Horologium plaza; the east entrance was level with the Via Flaminia. |
| **Horologium Augusti** | 109 | 773 | meridian pavement **160 × 75 m** (Buchner) or **110 × 60** (Platner & Ashby); obelisk shaft **21.79 m**, with ancient base **26.14 m**, effective gnomon **29.60 m** (= 100 *pedes*) | **Not working, and it must not be drawn working.** Pliny records it already wrong *c.* AD 47; the surviving pavement is a **Flavian** rebuild 1.5 m above the Augustan level; **a water basin of Hadrianic or later date was built directly over the meridian line**. Salzman: *"Though the device was no longer functioning by the time of Aurelian, the obelisk and the inscription would have remained visible."* Obelisk standing, **gilded globe on top**, dedicated to **Sol** — three years before Aurelian dedicates his own. |
| **Pantheon** | 91 | 833 | rotunda **43.30 m** interior diameter = interior height; drum **6.20 m** thick; oculus **9 m**; portico **34 × 13.60 m**; 16 monolithic granite shafts of **11.8 m** (= 40 *pedes*), **8 grey in front, 4 + 4 red behind** | **Standing and sound**, restored by Severus and Caracalla in **202** — 69 years before. **Faces north**, at the north end of Agrippa's complex. |
| **Baths of Nero / Alexandrinae** | 6 | 821 | **c. 190 × 120 m**, fronting **north** | **A working bath.** Rebuilt by Alexander Severus in **227** — 44 years before — and renamed. Listed in the Regionaries. A single-block red granite basin **6.70 m in diameter** was found there. |
| **Baths of Agrippa** | 83 | 879 | **c. 100–120 × 80–100 m**, central circular hall **c. 25 m** diameter; Hadrian's hall **45 × 19 m** with a **9 m** apse | **In use**, and still being restored in **344/5**. Rome's earliest public baths, free to the people from 12 BC. |
| **Iseum et Serapeum Campense** | 146 | 843 | **c. 200 × 50 m** (DAR) or **240 × 60** (Iseum project); Serapeum apse **c. 60 m** across | **Standing and functioning**, rebuilt by Domitian, Hadrian's hemicycle, Alexander Severus adding to it, listed in the Regionaries. **The most visually distinctive complex on the map**: colossal Nile and Tiber river-gods, sphinxes, baboons and **at least four obelisks**, two of them *c.* 6 m. The shipped `temple-isis` is 70 × 34 and is **too small by a factor of three**. |
| **Temples of the Area Sacra** (Largo Argentina) | 93 | 914 | four temples, **A** podium 15 × 27.5 m with 30 columns, **B** a tholos of 18 columns, cella 9.3 m, rebuilt to 15.5 m, with an **acrolithic Fortuna 8 m high**, **C** tetrastyle *sine postico* on a podium 3.8 m high, **D** podium **23.5 × 37 m** | **All four standing**, Domitianic reconstruction after the fire of 80, Severan restoration of Temple A. But the **Hecatostylum** on their west, running to the Theatre of Pompey, **burned in 247 and is a ruin**. |
| **Theatre of Pompey** | −94 | 917 | cavea **156.80 m** diameter (Packer 2014), orchestra **44 m**, *scaena* **c. 95 m**, a **four-storey façade** | **Fire-damaged and out of use.** It burned in **AD 247** (Jerome, *Chron.*) and the next recorded restoration is Diocletian's, **284 or later**. **Depict it scarred and partly scaffolded.** Its height is *not* established — the circulating 45 m has no traceable source; build to the four-storey façade instead. |
| **Theatre of Marcellus** | 199 | 997 | external diameter **129.80 m**, façade **32.60 m** high, **41 arches**, orchestra 37 m, *scaena* 80–90 × 20 m; **Doric, Ionic, Corinthian** in three orders | **Standing and in use** — parts of the Severan *ludi saeculares* of **204** were held in it. The first sign of decay is 370. The shipped 130 × 115 is right. |
| **Porticus Octaviae** | 155 | 983 | quadriportico **119 × 132 m**; propylon with four Corinthian columns **8.60 m** high | **68 years old in its current form.** Rebuilt in **203** by Severus and Caracalla — CIL VI 1034 is still on the architrave. Inside: **Iuppiter Stator**, Rome's first all-marble temple, and **Iuno Regina**. |
| **Stadium of Domitian** | −45 | 825 | **275 × 106 m**, arena *c.* 250 m, floor 4.50 m below Piazza Navona; brick with a travertine façade | **Standing and in use**, restored by Alexander Severus, and used for gladiatorial combat after the Colosseum fire of 217. Capacity: the Regionaries give **30,088 *loca***, which Platner & Ashby read as ~15,000 seats. |
| **Mausoleum of Hadrian** | −294 | 722 | podium **c. 84 m square, 10 m high**; drum **64 m diameter, 21 m high**; tomb chamber 9 × 8 m | **Intact, marble-clad, 132 years old — and OUTSIDE the circuit.** §6.6. |

**Missing, and they must be added.** Six of these are large:

| monument | x | z | plan, real m | why it matters |
|---|---:|---:|---|---|
| **Saepta Iulia** | 212 | 870 | **c. 310 × 120 m** enclosure; Platner & Ashby measured the pier hall at **400 × 60 m** with eight rows of travertine piers **1.70 m square at 4 m centres**. Porticus Meleagri east, **Stoa of Poseidon / Argonautarum** west. | **The largest omission on the map.** It is 3.7 hectares of colonnaded hall directly on the Via Lata, immediately behind the gate's axis, and it stood until the Middle Ages. A break-in through the Porta Flaminia arrives at it. |
| **Porticus Pompei** | 10 | 914 | **180 × 135 m**, four parallel rows of columns, a **double grove of plane trees** on the Marble Plan, exedrae on the west | **Undamaged in 271** — it burned only under Carinus, 283–285. So the portico and its groves are intact **while the Hecatostylum on its north flank and the theatre on its west are burnt ruins from 247.** Build that asymmetry; it is free drama. |
| **Porticus Divorum** | 226 | 890 | **c. 200 × 55 m**, thirty-plus columns a side, two small tetrastyle temples, a grove and an altar | Domitianic; listed in the Regionaries |
| **Theatre of Balbus and the Crypta Balbi** | 105 | 959 | cavea **c. 95 m** (Sear 2006); the whole complex *c.* **1 hectare**; the crypta a three-sided portico with a large apse, which **Hadrian converted into a public latrine** | Standing and busy; the block east of it is a dense inhabited quarter with a bakery, a Mithraeum and a *fullonica* — **the one place on this map with real lived-in fabric that is excavated** |
| **Hadrianeum** | 185 | 798 | eleven Corinthian columns **15 m high, 1.44 m diameter**, on a lofty stylobate | standing; the columns are still there today |
| **Diribitorium** | 208 | 905 | roof beams of **30 m** — the largest single-roofed building in Rome | **A roofless shell, open to the sky for 191 years** since the fire of 80. A ruin the size of a basilica, inside the walls, in 271. |
| **Circus Flaminius** | 98 | 1003 | *c.* **260 × 100 m** — but Platner & Ashby computed that for the wrong site | **Not a circus.** No stands and no barrier have ever been found; it is *"a large open space — not a formal circus"*, used for markets, *contiones* and mustering triumphs. **The Regionaries name Regio IX after it and do not list it among the region's monuments.** A paved, encroached piazza — and the only large open ground inside the walls on the south half of the map. |
| **Odeum of Domitian**, **Templum Matidiae**, **Basilica Neptuni**, **Curia Pompei** | −68 / 164 / 91 / 72 | 885 / 809 / 844 / 914 | the Odeum held **10,600 *loca*** and was *"among the most conspicuous monuments in Rome"* in the fourth century | The **Curia Pompei** is the best small detail on the map: Caesar was killed in it, the Senate **walled it up**, Dio says it was later **turned into a privy**, and the Severan Marble Plan draws it flanked by **two large public latrines**. A blocked tufa hall, *locus sceleratus* for 315 years. |
| **Stagnum Agrippae** | 6 | 855 | **c. 240 × 190 m**, walls at least 1.5 m above the water, fed by the Aqua Virgo, draining to the **Euripus** — a channel of semicircular section, **1.73 m** diameter | **Do not draw open water.** No source attests the *stagnum* after Nero; it is not in the Regionaries; the quarter was progressively built over. The **Euripus and the Virgo supply are documented late; the basin is not.** §7.2. |
| **Trigarium** and **Tarentum** | −233 | 836–860 | open precincts in the Tiber bend | **Open ground inside the river wall** — the only such on the north half, and the natural place for a garrison reserve to form |
| **Ciconiae Nixae** | −24 | 700 | an open square on the bank near Piazza Nicosia, named from a relief of storks with crossed bills | **the wine wharf**, and one of the ferry landings the river posterns serve (§5.3) |

**And the water supply, because it crosses the map.** The **Aqua Virgo** — Agrippa's, dedicated
19 BC, **103,916 m³/day** — runs the last 700 *passus* on arches, crosses the Via Lata under the
**Arch of Claudius** of AD 51/52 just north of the Saepta, runs along the Saepta's north face
and ends near S. Ignazio. It is what fills the Baths of Agrippa, the Baths of Nero, the Stagnum
and the Euripus, and it is already in `AQUEDUCTS` at 11.5 m high **[SRC]**. **No dimensions
survive for the Arch of Claudius**; if a measurable Claudian arch of the Virgo is wanted, one
still stands in the court of 14 Via del Nazareno.

### 6.4 The grain rule

`docs/HANDOFF.md` records that Rome's remaining difference from the AGEA orthophoto is **grain,
not coverage**: real blocks are smaller and punched with 1–4 courts of 10–25 m; ours are larger
with one big court. Carthage solved the same problem by authoring on the excavated cubit module
and letting the grain fall out.

**Rome's module is the *pes monetalis*, 0.296 m, and the honest finding is that the Severan
Marble Plan cannot recover it.** Measured for this pass: 144,296 interior line segments were
extracted from the SITAR vector of the *Forma Urbis Severiana* (7,870 features, `002_fum_caratt_interna`)
and their lengths tested for a modulus. Against 0.296 m the χ² over 40 bins is **181**; against
a **1.000 m** control it is **1,450**. *The digitiser's own metre grid dominates the signal.*
[MEAS] `tools/scratch/rome-fur-grain.mjs` at `3595b48`. **Take the pes from metrology, not from that file**, and
record the negative so nobody repeats the test.

What the Severan Plan *can* give is the shape of the fabric, and it says the same thing the
orthophoto does: median interior segment **0.72 m**, p75 1.68 m, p90 3.45 m — a dense line
drawing of small rooms, not a set of large courts. So:

| property | value | tag |
|---|---|---|
| Insula footprint, Campus Martius | **30 × 45 m** = 100 × 152 *pedes*, on a grid of two blocks to a *via* | [MOD] [GAME] |
| Courtyard | **1–3 light wells of 8–14 m** per block, not one large court | [MOD] from the orthophoto and the Severan Plan |
| Storey height | 3.15 m + a 4.3 m ground floor — already `insulae.ts`'s `STOREY_H`/`GROUND_H` **[SRC]** | [SRC] |
| Height | **4–5 storeys, 16–18 m**, capped at the Augustan 70 *pedes* = **20.7 m** | [ANC] the legal limit |
| Porticoes | the Via Lata and the Via Recta are **porticoed on both sides** — already `STREET_PLAN`'s `porticoed` flag on `via-lata` **[SRC]** | [ARCH] |
| Paving | *silex* polygonal basalt on the arteries; the Campus Martius floods, so the monumental precincts are raised on podia and the streets between them are not | [ARCH] |

**Do not scale Campus Martius blocks up toward the rest of the city's.** The finest grain in
the game should be in the 466 metres a player actually fights through.

### 6.5 Rome's Megara — the *horti*

`CARTHAGE.md` §7.7 makes the case for a third terrain class between open ground and city
fabric, and Rome has the same institution twice over, on the same map, behind two of the four
gates. The survey already carries one of them: **`gardens-sallust`, 250 × 170 m, `soft`,
`atWall: 0.6`, on the Pincian, at x 685, z 626** **[SRC]** — the *Horti Sallustiani*. The
*Horti Aciliorum* behind the Porta Pinciana are not in the survey and must be added.

| property | value | tag |
|---|---|---|
| Extent | **x +420 … +900, z 590 … 780** — the whole east third of the map's near band inside the wall | [MOD] |
| What is in them | terraces and retaining walls, ornamental water, a *nymphaeum*, planted avenues of plane and cypress, a *diaeta* or two, boundary walls **1.5–2.5 m** | [ARCH] |
| Enclosure grid | **50–90 m**, following the terraces rather than a lattice | [GAME] from [ARCH] |
| Buildings | scattered villa ranges, 1–2 storeys, **~6 %** coverage | [GAME] |
| Cost | scatter and low walls, not buildings — the same argument Carthage makes for the Megara | [DER] |

**Why it earns its place, in one sentence:** an attacker over the wall at the Porta Pinciana
does not arrive in Rome, he arrives in somebody's garden, on terraces, with a wall every
seventy metres and nowhere to put a line. And unlike the Megara it is not invented: the
northern strip inside the Aurelian wall from the Pincian to the Castra Praetoria was almost
entirely imperial *horti* in 271, which is precisely why Aurelian could run a wall through it.

### 6.6 What is outside the wall, and must look like it

Three things on this map are **outside** the circuit in 271 and the current build does not
distinguish them.

**The Mausoleum of Hadrian.** x −294, z 722, far bank **[SRC]**. It was not fortified and not
joined to the circuit until **Honorius and Stilicho, c. 401–403** — 130 years after this map.
The decisive text is **Procopius, *Gothic War* V.22.12–13**:

> *"The tomb of the Roman Emperor Hadrian **stands outside the Aurelian Gate**, removed about a
> stone's throw from the fortifications… But since this tomb seemed to the men of ancient times
> a fortress threatening the city, **they enclosed it by two walls, which extend to it from the
> circuit-wall**, and thus made it a part of the wall."* **[ANC]**

Lanciani dates the conversion to the Honorian survey: after the restoration of 403 there were
381 towers *"exclusive of those of the mausoleum of Hadrian, which had been converted into a
'tête du pont'"*. **[MOD]** And an Aurelianic bridgehead is not credible on the geometry either:
the Trastevere salient's northern arm met the Tiber at the **Villa Farnesina**, *c.* **1,058 m
downstream** of Castel Sant'Angelo, so it would have needed a kilometre of extra double wall up
the right bank that no source records. **In 271 it is an intact, marble-clad, statue-crowned
imperial tomb standing in a garden on the wrong side of a wall that does not reach it.**

**The ager Vaticanus** — the Vatican plain, the *prata Neronis*, the Via Triumphalis, the Circus
of Gaius and Nero, and the shrine that would become Old St Peter's. All outside, and enclosed
only by **Leo IV in 847–855**.

**The Via Flaminia's tomb frontage**, x 20 ± 40, z < 530. The road out of the gate is lined with
tombs, and Aurelian's engineers took some of them into the wall and demolished the rest inside
bowshot: Lanciani records *"a beautiful tomb, upon which the third tower left of the gate is
planted"*, and sepulchral inscriptions (CIL VI 13552, 28067, 30464, 31455, 31689, 31714, 31771)
are built into the Porta Flaminia's bastions. `WALL_CLEAR_OUT = 30` already clears vegetation
from the glacis **[SRC]**; **the tombs should be cleared and their stumps left**, which is both
the archaeology and a better-looking glacis than mown grass.


## 7. What Rome does not have, and must not be given

A redesign's largest risk is that it makes Rome into Carthage. Five things Carthage has that
Rome must not acquire, each with the reason.

### 7.1 No ditch

The Aurelianic circuit was not fronted by a *fossa*. It relied on height, on **c. 400 towers**
with artillery in them, and on the fact that it was thrown up in five years through a built-up
suburban landscape where a continuous ditch would have meant a second excavation as large as
the wall. It also **reused two thousand eight hundred metres of standing garden and barrack
wall on this front alone** (§4.8) — and you cannot dig a ditch in front of somebody's terrace
without undermining it.

**And there is one positive piece of evidence, which is the best kind.** The *Chronographus anni
354* records of **Maxentius** — forty years after this map — exactly four words on the subject:
***"fossatum aperuit, sed non perfecit."*** He opened a ditch and did not finish it. **[ANC]**
That is the only ditch anywhere in the record of this wall, it is not Aurelian's, it is not
finished, and it is not in 271. If a *fossa* had already been there, there would have been
nothing for Maxentius to open.

Three reasons not to invent one anyway, in descending order:

1. **It is the map's identity.** `CARTHAGE.md` §4.2 states the headline as **12.4×** — 74.1 m
   of belt against Rome's 6.0 m of curtain — and correctly says that is the only comparison
   worth putting in a blurb. Give Rome a ditch and the number collapses, and the two maps
   converge on being the same map with different bricks.
2. **The besieger has nothing that a ditch would stop.** A ditch's job is to hold a ram and a
   siege tower off the wall foot. §8's storm has neither. A ditch would slow an escalade by
   about the time it takes to slide down one side and climb the other, at the cost of an
   afternoon of heightfield work and 88 stations of assertion.
3. **It would be the fifth instance of the pattern.** `SIEGE.md` §5.2 lists four cases of the
   art asserting what the sim does not implement, one of them Carthage's ditch. The way to not
   produce a fifth is to not publish a trench that history does not require.

**What Rome has instead is §4.9**, and the point of §4.9 is that the construction site is
*evidenced*, it is *asymmetric* (easier to get in through than to fight in), and it is 2.4 m of
cut rather than 6.

### 7.2 No water inside the defences

Carthage's second act is 14 hectares of harbour behind the wall, a chained channel, a mole and
a causeway. Rome's Tiber is **outside** the circuit on this map, and the Stagnum Agrippae and
the Euripus — the ornamental lake and canal in the Campus Martius, which *are* inside — are
scenery of a few thousand square metres, not a theatre of operations. Model them; do not give
them a mechanic.

### 7.3 No citadel, and no vertical endgame

Stated at §10.6 and repeated here because it is the temptation a designer feels at exactly the
point the wall is finished: **do not put a fallback keep behind the Aurelian wall.** Rome in
271 had no defensible interior; that is the whole reason Aurelian built a 19 km circuit instead
of refortifying the Capitoline. The Campus Martius behind the gate is flat monumental ground
and the correct feeling on breaking in is *openness*, not another wall.

### 7.4 No casemate, and no interior to the wall

Appian's Punic wall is hollow in two storeys and `CARTHAGE.md` §8.2 is right that nothing else
in the game has one. The Aurelian wall is 3.5 m of brick-faced concrete over a rubble core and
there is nothing inside it. The **arcaded chambered gallery** that gives the later wall its
covered walk belongs to the **Honorian** rebuild of 401–402, not to 271, and putting it on this
map would be showing the wrong building by 130 years.

### 7.5 No siege train, on either side

The garrison of Rome in 271 has artillery — the towers were built with *ballista* chambers and
the shipped order of battle fields five `ballistarii` and two `carroballista` **[SRC]**. The
attackers do not. §8 is the argument; the consequence for the map is that **nothing on the
approach needs to be sized against a siege tower**, and the design should stop pretending
otherwise.

---

### 7.6 Seven things that are not there in 271, and must not be drawn

| | date | note |
|---|---|---|
| **Temple of Sol** | dedicated **274** | Aurelian's own, three years after this map. Its site in the *campus Agrippae* east of the Via Flaminia is **open parkland**. |
| **Baths of Constantine**, Quirinal | *c.* **315** | 44 years late. The site is in 271 an un-levelled aristocratic quarter with the *Domus T. Avidii Quieti* and *Domus Muciani* standing. |
| **Pons Probi** | late **270s–280s** | and it is built from the stone of the dismantled **Pons Neronianus** |
| **The Honorian doubling of the wall** | **401–403** | new walls *c.* 6 m raised over the Aurelianic walk, either solid at 1.776 m (6 *pedes*) with two archer-niches per bay or, more commonly, **a covered gallery** with a 1.20 m outer skin pierced by seven arched niches per bay; towers and gates raised a storey. In Richmond's sector F this took the structure **from 8 m to 15 m**. Recorded by CIL VI 1188–1190 and by Claudian. **In 271 the curtain is 6.5–7 m with an open walk.** |
| **The fortified Mausoleum of Hadrian, its spur walls and the Porta S. Petri** | **401–403** | §6.6 |
| **Porta Pinciana as a gate** | Honorian | it is a **postern** in 271 — §5.1 |
| **Amphitheatrum Statilii Tauri** | destroyed in the fire of **64** | never rebuilt |

**And one that is genuinely uncertain rather than absent.** Maxentius is often credited with
heightening the wall; Dey calls that attribution *"by far the greatest defect"* of Richmond's
book. The *Chronographus anni 354* says only *"fossatum aperuit, sed non perfecit"* — he opened
a ditch and did not finish it. **That is the only ditch in the record and it is forty years
after this map** (§7.1).


## 8. The battle — the Juthungi, and the storm they could actually mount

### 8.1 Who they were

| | | tag |
|---|---|---|
| Name | Latin **Iuthungi**; Greek **Ἰούθουγγοι**. The **Augsburg victory altar** of 260 is the only ancient text that equates them with anybody: *barbaros gentis **Semnonum sive Iouthungorum*** — "barbarians of the people of the Semnones, or Juthungi." | [ARCH] AE 1993, 1231 |
| What they were | *"**Iuthungi Alamannorum pars** Italicis conterminans tractibus"* — a part of the Alamanni, bordering on Italian territory | [ANC] Ammianus 17.6.1 |
| Where from | north of the upper Danube along the **Altmühl**, in what is now northern Bavaria, facing Raetia and Regensburg | [MOD] |
| What the name means | from a Germanic root for *descendants, offspring, scions* — hence the reading that they began as a **detached young-warrior group**, a war-band split off from a parent people rather than a territorial tribe | [MOD] |
| How they end | two units in the *Notitia Dignitatum*, both exiled east — *Ala prima Iuthungorum* in Syria and *Cohors quarta Iuthungorum* in Egypt | [ANC] |

**The Augsburg altar is the one hard document and it is worth the space**, because it tells you
how they moved. Battle **24–25 April 260** (the dedication is 11 September); they had crossed
the limes the previous autumn, **wintered south of the Alps**, and were caught **going home in
spring**, dragging *multis milibus Italorum captivorum* — many thousands of Italian captives.
**[ARCH]** And they were beaten by a scratch force: the province of Raetia's own garrison,
detachments from the Rhine, and ***populares*** — armed locals, veterans and militia.

*A provincial levy with militia in it destroyed a Juthungi host on its way home. That is the
measure of the thing.* And Drinkwater on those same invaders: *"Neither was a 'tribe' or even an
'army'. Unorganized and disorganized… **With no commissariat and carrying quantities of booty,
both inanimate and animate, they were vulnerable to counter-attack.**"* **[MOD]**

### 8.2 Numbers

| figure | source | status |
|---|---|---|
| **40,000 cavalry and 80,000 infantry** | **Dexippus F 6 Jacoby** — *in the mouths of Juthungi envoys*, in a composed embassy speech. *(And a correction: this is in the Constantinian* Excerpta de Legationibus*, known since the seventeenth century. It is **not** in the Vienna palimpsest, which is Decius' Gothic wars of 250–251.)* | **rhetoric** |
| **2,000 Vandal cavalry** supplied to Aurelian as auxiliaries | Dexippus F 7 | **real, negotiated — the reality check** |
| "many thousands of Italian **captives**" | the Augsburg altar | the only hard-ish number, and it counts victims |
| 35,000 Alamanni at Strasbourg, 357 | Ammianus 16.12.26 | literary |
| **Chnodomarius' personal retinue: 200 followers and three close friends** | Ammianus 16.12 | **probably real, and revealing** |
| war-band average complement *c.* **600**, striking 400–800 km | Drinkwater 2007, from the Baltic bog deposits | [MOD] |
| Strasbourg re-estimated at *c.* **15,000**, the largest Alamannic concentration on record | Drinkwater 2007, 237–239 | [MOD] |

> **Working figure: 5,000–20,000 fighting men, with a very large non-combatant tail of captives,
> drovers and wagons.** The 120,000 is a speech, and the document should say so where a player
> can read it.

### 8.3 The shipped order of battle contradicts the history, and it is not close

Read out of `src/sim/battleConfig.ts` at `3595b48`:

| side | plan | units |
|---|---|---|
| **Rome, garrison** | `wall ['ballistarii','wall-slingers']`, `engines ['carroballista']`, `reserve ['legio-cohort']` | 5 + 3 + 2 + 2 = **12 units, 1,154 men** |
| **Juthungi, storm** | `tower 'tower-assault'` ×4, `ladder 'escalade-party'` ×4, `ram 'ram-crew'` ×1, `batteries ['onager']` ×3, `host ['juthungi-warband']` ×6, `horse ['juthungi-riders']` ×2 | **20 units**, the cap |

**Four mobile siege towers, three onagers and a shedded battering ram, fielded by an
Elbe-Germanic war-host in 271.** That is the single largest historical error on the map, and it
is not a texture — it is the shape of the whole assault.

**The evidence against it is explicit, and the best of it is about the Juthungi by name.**

- **Ammianus 17.6.1**, on a Juthungi raid into Raetia: *"adeo ut etiam oppidorum temptarent
  obsidia **praeter solitum**"* — "so that they even attempted sieges of towns, **contrary to
  their custom**." A Juthungi town-siege is flagged as abnormal by the historian who says it
  happened. And it failed.
- **Ammianus 31.8.1**, of the Goths in the Haemus: they did not attempt any of the strong
  cities *"**haec et similia machinari penitus ignorantes**"* — being **wholly ignorant** of
  these and similar operations.
- **Ammianus 31.6.4**, Fritigern: seeing that his men were *"**ignaros obsidendi**"* —
  inexperienced at besieging — he advised plundering the open country instead, *"reminding them
  that **he kept peace with walls**."*
- **Ammianus 16.2.12**, and this is the one to quote: the Alamanni held the *territoria* of
  seven walled cities of Gaul and lived in them, *"for they avoid the towns themselves **as if
  they were tombs surrounded by nets**."*
- **Ammianus 16.4.2**, Alamanni blockading Julian in Sens, winter 356/7: after a month *"the
  savages withdrew crestfallen, muttering that **they had been silly and foolish to have
  contemplated the blockade of the city**."* No engine appears in the account.
- **Cologne, 355:** they *"did not take the place by siege. Rather… **they just forced their way
  into a virtually open city**, no doubt astonished by their success."* **[MOD]** Drinkwater.

**The one counter-example, carried honestly.** Zosimus I.43.1 has Goths and Heruli besieging
Cassandria and Thessalonica in 268/9 *"by means of machines which they raised against the
walls"* — and **they failed and walked away**, and the next sentence restates the norm: *"as
they were not strong enough to attack the towns which had fortified themselves… they carried
off all the men that they found in the open country."* Different people, a decade later, a
maritime campaign with captured technicians. **It does not license giving the Juthungi
artillery.**

### 8.4 What the storm should be instead

| role | shipped | redesign | reasoning |
|---|---|---|---|
| `tower` | 4 × `tower-assault` | **0** | no evidence; a mobile tower is a carpentry programme with a survey attached |
| `batteries` | 3 × `onager` | **0** | no attested Germanic torsion artillery of any date |
| `ram` | 1 × `ram-crew` | **1**, re-dressed | **not a shedded ram.** Model a hand-carried tree-trunk with the crew in the open — and note that `SIEGE.md` §5.1 already records the shed as a claim the sim never implemented, so the picture and the model would agree for the first time |
| `ladder` | 4 × `escalade-party` | **8–10** | **this is the assault.** Prepared timber and captured Roman kit. |
| `host` | 6 × `juthungi-warband` | **8**, `horde` | the freed capacity |
| `horse` | 2 × `juthungi-riders` | **2** | attested, high-status, and **useless against a wall** — which is the point, and at Strasbourg the Alamannic princes were made to dismount by their own infantry |
| **new: missile suppression** | none | **2 × thrown-spear skirmisher units** ordered onto the wall foot | the only counter-battery a Germanic host has. **And archers are attested**: the Vimose deposits show *"in the 3rd century AD bowmen became a part of the Army's infantry."* |

Twenty units either way, so `MAX_UNITS_PER_SIDE` is unchanged and no deployment code moves.

**What a Juthungi warrior carries**, from the bog deposits rather than from Tacitus alone:
**shield and spear or lance, with throwing spears** — *"the main weapon was the lance… the
sword, however, was not nearly as common, and probably it was only the officers who held a
sword"*; **mail is a leader's item**, single figures in an army-sized deposit; **helmets rarer
still**; a small mounted element of higher-status men with spurs and bridle fittings; and
**Roman blades with factory stamps circulating at the top of the hierarchy** — which is exactly
what a host that has just taken a Roman army's baggage at Placentia would be carrying.
**[ARCH]** Formation: *"acies per cuneos componitur"* — the wedge. **[ANC]** *Germania* 6.

> **And one correction to a thing everyone gets wrong.** The ***barritus*** at Strasbourg is
> raised by **the Romans** — the *Cornuti* and *Bracchiati*, Germanic-recruited *auxilia
> palatina*. The Germanic practice is *Germania* 3's ***barditus***, whose broken roar is made
> **with the shields held up against the mouth** so the voice swells by echo. If the sound
> design cites anything, cite that.

### 8.5 The assault, built from a third-century description of one

The **Vienna palimpsest** — Dexippus on Cniva's storm of a Thracian city in 250 — gives a
step-by-step Germanic escalade from a contemporary historian who had commanded troops himself.
**Build the storm out of it, in order.** **[ANC]**

| step | the text | on the map |
|---|---|---|
| 1 | *"They pretended to withdraw but stayed in the area."* | — |
| 2 | *"they built a camp as secretly as they could… **they refrained from lighting fires at night**, fearing that they might be seen."* | the pre-battle camp |
| 3 | inside the town, *"a rebellion against those in power had arisen"* which caused ***"carelessness with the guard duty"*** | **this is the mint-workers' revolt (§8.7), and it is the reason the watch is thin** |
| 4 | a man *"had stolen away from the town"* and named ***"the place where the fortifications could be climbed most easily"*** | **the `footing` bays** |
| 5 | *"**Prizes were set by the king: 500 darics for the first to climb the walls**,"* 300 for the second | — |
| 6 | five volunteers by moonlight, at a wall *"**built low upon a rock**"*, *"**climbing up this very rock and driving pointed iron pegs into the masonry at many places**"* | the half-built bays |
| 7 | the watch is cut down — *"there were not very many men, and moreover they were overcome by sleep"* | — |
| 8 | *"they **raise a torch** for their comrades as a sign that they have got over the wall"* | — |
| 9 | *"about **500 men, chosen from the bravest**… set off with **long ladders**"* | the escalade parties |
| 10 | ***"when a noise arose as the ladders were placed against the wall"***, the defenders noticed | *the alarm is the sound of the ladders* |
| 11 | the first men over *"**seize the approaches leading to the towers**; these were **narrow and not easy for a crowd to pass, so that they barely gave room for two heavy-armed men drawn up in front**"* | **§9.3** |

**Row 11 is the reason §9 is written the way it is.** A third-century historian describing a
Germanic escalade says the fight after the wall is taken is the fight for **the narrow tower
approaches, two men abreast**. §9.3 specifies the wall's only access as a **1.1 m single-file
stair inside every tower**, on Cozza's excavation of tower K1. *The archaeology and the ancient
narrative and the engine's one-stair-per-run rule all arrive at the same object.* Take it.

**A second escalade model, for the ground rather than the wall.** Zosimus I.33.2 on Trapezus:
a city with **two walls and ten thousand men above its usual complement**, so the attackers
*"did not therefore even imagine that they should succeed"* — until they saw the garrison drunk
and off the parapet. Then *"they **piled against the wall trees which they had prepared for the
purpose of scaling it**, on which their troops mounted in the night and took the city."*
**Prepared timber, built into a ramp, at night.**

**And fire, because there is no ram worth the name.** Ammianus 31.13.15, on the Goths at the
farmhouse Valens died in: they *"tried to break down the bolted doors"*, were shot at from
above, and then *"**piled up bundles of straw and firewood, put fire to them, and burned the
building with the men in it**."* **That is the gate mechanic**: no tool for the leaves, so burn
them. It is also why `setGateDoorBroken` should be reachable by something other than a ram.

**What defeats them, and it is the honest dramatic shape.** In the whole corpus an alert
garrison always wins — Pityus, Marcianopolis, Tomi, Nicopolis, Thessalonica twice, Sens, Autun,
Adrianople, Constantinople. Every successful barbarian entry in the third and fourth centuries
turns on a human failure: a drunk watch, a traitor, a garrison that ran, a gate left open.
**The wall is not the variable. The watch is.** A defence-of-Rome map in which the player *is*
the watch has its theme handed to it.

### 8.6 The garrison, and it is not a field army

Aurelian is in the east — he settled the wall's arrangements in person and then marched against
Zenobia (**[HA]** 22.1). What is in Rome is the city garrison, and the **Chronography of 354**
inventories it eighty years later:

| body | strength | where in 271 | source |
|---|---|---|---|
| **Praetorian Guard** | **10 cohorts, 10,000** | the **Castra Praetoria** — which is on this map, at x 1150–1335 | [ANC] Dio 55.24.6 |
| ***Cohortes urbanae*** | **4 cohorts, 6,000** | **also in the Castra Praetoria in 271**, before the Castra Urbana was built | [ANC] Dio; [MOD] Platner & Ashby |
| ***Vigiles*** | 7 cohorts; per-cohort strength **not attested** | 7 *stationes* and **14 *excubitoria*** across the city | [ANC] the *Breviarium* |
| ***Equites singulares Augusti*** | **~2,000** in the third century | *Castra Priora* and *Castra Nova*, both on the **Caelian** — off this map's fighting half | [MOD] Speidel |
| ***Peregrini* / *frumentarii*** | a few hundred | *Castra Peregrina*, Caelian | [MOD] |
| **Legio II Parthica** | 5,000+ | **Castra Albana, 20 km south-east** — a day's march | [ANC] Dio 55.24.4 |
| **Total in and around the city** | **~27,000–32,000** | | [DER], *not* a cited scholarly estimate |

**And the precedent adds one more contingent that the shipped order of battle has no room for.**
Zosimus I.37: under Gallienus the Senate *"armed all the soldiers that were in the city, **and
the strongest of the common people**."* An armed-populace unit on the parapet is period-correct
for the exact event Aurelian says he built the wall to prevent — and it is the natural home for
the *collegia* who were building the thing (§4.9).

**Recommended garrison**, still twelve units: 4 × praetorian cohort, 2 × urban cohort,
2 × `ballistarii` in the towers (the chambers were built for them), 1 × `carroballista`,
2 × *vigiles* as a fire-and-reserve unit, 1 × **armed *collegia*** — poor troops, plentiful, and
standing where they were working.

**What a 271 Roman looks like, and three things to *not* give him:**

| | verdict |
|---|---|
| **Ridge helmet** | **no.** Fourth-century; the earliest securely dated example is coin-dated **319/320**. Use the **Niederbieber** type. |
| ***Plumbata*** | **no.** Vegetius anchors the name to **Diocletian and Maximian**, i.e. 284 at the earliest, and no pre-284 example is verified. |
| ***Pilleus pannonicus*** | **a reconstruction, not attested for 271.** The only text is Vegetius; the iconography is all fourth-century. Two arguments for using it anyway: Vegetius says the custom *"persisted right up to almost the present day"*, and the cap is **Pannonian** — Aurelian's army is overwhelmingly Danubian. **Label it.** |
| Mail (*lorica hamata*) | yes, the default |
| Shield | **large dished oval** — but the Dura deposit of *c.* 256 contains **both** the oval and the cylindrical *scutum*, so the old shield had not vanished fifteen years before this map |
| *Spatha* on a broad baldric, ring-buckle *cingulum* | yes; the ring buckle is Severan and there is one from a hoard buried *c.* 253 |
| *Spiculum* / *verutum* | the objects exist; **the words are Vegetius' own renamings** and he says so |

### 8.7 The mint-workers' revolt, and why it belongs on this map

**[HA]** *Aurelian* 38.2, Aurelius Victor 35.6, Eutropius 9.14: the workers of the mint rebelled
under **Felicissimus**, the *rationalis*, having been caught debasing the coinage, and the
fighting was so heavy that *"**per Coelium montem congressi septem fere bellatorum milia
confecerint**"* — engaging across the Caelian, some seven thousand fighting men were destroyed.
The *Historia Augusta* turns Victor's 7,000 dead into 7,000 **of Aurelian's own soldiers**,
which is almost certainly a misreading, and Magie's Loeb note calls the figure *"of course,
greatly exaggerated."*

**The date is genuinely disputed — 271 or 274** — and Magie states the dispute rather than
resolving it. All three epitomators place it **after** the 274 triumph, which is the stronger
formal argument; Dey puts it in **271** and makes it causally prior to the wall, providing
*"paid employment for thousands of potentially idle hands."*

**Take 271, and say that the narrative order supports 274.** At 271 the city is **still
unwalled** (Zosimus I.49.2: *"Rome, which before had no walls"*), the revolt is one of the
*ingentes seditiones* the *Historia Augusta* already reports during the invasion panic, and the
map gets the thing row 3 of §8.5 asks for: **a garrison whose watch is thin because the city
has just fought a battle with itself.** The Mint stands by S. Clemente in Regio III, and the
Caelian — where the fighting went — carries the *Castra Priora*, the *Castra Nova*, the *Castra
Peregrina* and a *vigiles* station. **The praetorians and the urban cohorts are three kilometres
away in the far north-east, in the Castra Praetoria, at the east end of this map**, and would
have to march the length of the city.

### 8.8 Three consequences the map must be designed for

1. **The gate is not the route.** With one hand-carried ram against two harr-hung leaves and a
   great bar (§5.5), and a 4.5 m arch to bring it up, the Porta Flaminia is a place to die.
   `siegeGateId` stays `porta-flaminia` because the siege system needs one and the ram will
   hold a defender's attention, but the design should not expect it to open.
2. **The unfinished bays are the route, and that is now the historically correct answer.**
   `SIEGE.md` §2.8 already found that both Juthungi wins in a twelve-seed campaign came through
   `stormInside`, one by a rider unit going through bay 28 with 50 of 50 men alive. A war-host
   with no engines walking into a building site is not a defect in the AI; it is step 4 of §8.5,
   and it is what happened to Roman frontier forts through the whole of the 260s.
3. **Escalade must actually be able to clear a bay.** `SIEGE.md` §7.4 measures that it cannot on
   the shipped garrison of **810 men in eight wall units**: across twelve seeds the storm never
   cleared a single bay, and condition A becomes satisfiable only at four wall units. The
   redesign moves both sides of that ratio — a front 25 % shorter, **32 garrisonable bays
   against 45**, single-file tower stairs that quadruple the time a relief takes to arrive, and
   four to six more escalade parties. **Re-run the sweep after §15 task 14.** If condition A is
   still unreachable, the assault is unwinnable by the only route the history allows.

### 8.9 The sun

| field | value | note |
|---|---|---|
| `site.latitudeDeg` | **41.9** | unchanged **[SRC]** |
| `site.declinationDeg` | **−14** | unchanged; early November, and it caps the sun at 34° even at local noon **[SRC]** |
| `sky.defaultHour` | **10** today; **recommend 9.0**, keeping 10 as a preset | at declination −14 and latitude 41.9, 09:00 puts the sun at *c.* 19° bearing south-east — **raking down the length of the wall from the Castra Praetoria end**, which is the one condition that shows 1,333 m of curtain as a curtain rather than as a band. `VISUAL-RUBRIC.md` and the blind-deck record both say relief is load-bearing. |
| deployment | attacker box narrowed to **±380 m about x +40** | forced by §3.2's river correction; the corrected Tiber crosses the old ±490 box |
---

## 9. Stairs — and the archaeology says the shipped nine are the wrong shape

A stair looks like decoration and is not. `SIEGE.md` §2.5: `buildStairs()` asks
`city.getWallStairs?()` first and **believes it absolutely**; both circuits publish; the
synthesised fallback is dead code. So every stair on this map is a decision made in the city
plan — and the two runs of the Aurelian wall-walk that nobody can reach are a decision made by
omission.

### 9.1 What is wrong today

| | value | provenance |
|---|---|---|
| stairs published | **9**, feet at x −119.2, 28.4, 133.8, 173.4, 310.4, 450.5, 595.4, 879.6, 1019.5 | [MEAS] `3595b48` |
| geometry | free-standing inner-face flights **parallel to the face**, 2.8 m wide, 14.2–20.4 m along the face for a 2.2–6.0 m rise, rake 0.31–0.34, cadence `index % 4 === 2` | [SRC] |
| runs | **45** — one per bay, because every break on Rome is a tower | [MEAS] |
| runs reachable from a stair | **43 of 45** | [MEAS] |
| the westernmost stair foot | **x −119.2**, against a wall that begins at **−631** | [MEAS]. **512 world metres and fourteen bays of the west end carry no stair at all.** |

### 9.2 And the free-standing flight never existed

> **"Nowhere was the top of the Wall reached from the ground by means of ramps attached
> thereto. The gate-towers or postern-towers provided the only means of access."**
> — Richmond 1930, pp. 62–63 **[MOD]**

He goes further: *"no example is known of a staircase to the Wall independent of a gateway, an
indication of how strictly access thereto was controlled."* His reasoning is administrative
rather than tactical — a town wall does not enclose a wholly military population, and it was
vital both to keep *"excited and irresponsible townsfolk"* off the rampart in a crisis and, in
peacetime, to stop the guard *"pilfering or philandering in the gardens or houses behind it."*
Guard duty was run by the **Praefectus Urbi**.

**Nine external flights up the inner face are therefore not a gameplay compromise — they are
archaeologically wrong**, and this document would have to argue for keeping them.

### 9.3 It does not have to, because Cozza found the real answer and it fits the engine exactly

Cozza's survey of tower K1 established that an **ordinary curtain tower** — not just a gate
tower — carried a **ground-level door on its inner, city-side face and an internal
double-flight stair** (*scala a doppia rampa*) to the wall-walk. The low inner door is the
**original** Aurelianic entrance; the door at *c.* +7.00 m is Honorius', cut when he *"completely
filled the basement level, drowning the original access stairs to the upper floors."* **[ARCH]**
Porta Nomentana's surviving north tower has the same thing, measured: **an internal stair
rising 20 feet = 6.10 m in three flights**, in walls **2 feet = 0.61 m** thick. **[MOD]**

**So the wall's stair is the tower**, and that is the whole of §9:

> **Every tower is a stair. One tower per bay boundary. One bay boundary per run. Therefore one
> stair per run, by construction, with no cadence and no rule to get wrong.**

`Siege` builds **one stair per run** by design — *"a second flight onto a run a man can already
reach adds a routing choice and no reachability"* **[SRC]** — and the archaeology puts exactly
one access point at each end of every bay. **The engine's requirement and the excavation
coincide.** That does not happen often and it should be taken.

| | value | tag |
|---|---|---|
| Access | **an internal double flight inside every curtain tower**, from a ground-level door on the city face to the walk | [ARCH] Cozza |
| Rise | the bay's `walkY` above the ground at the tower's inner face | [DER] |
| Flights | **three**, with two landings, in a 7.4 m square tower — Porta Nomentana's does 6.10 m in three | [ARCH] |
| Width | **1.1 m** clear between 0.61 m walls, which is a **single file** | [ARCH] [DER] |
| Published as | a `WallStair` whose `footX/footZ` is the tower's inner door and whose head is the walk. `buildStairs` rejects a head more than **6 m** from the standing surface **[SRC]**, which on a circuit climbing 38 m across 36 bays is the check that catches a stair authored against the wrong `walkY`. | [SRC] |
| Count | **32**, one per garrisonable bay | [DER] |
| Foot clearance | must be routable in the occupancy raster. The 4 m raster cannot hold a 1.1 m door, so **publish an apron 4.4 m wide at the foot and clear it**, the way `stairSolid` already backs the raster off the bottom of a rake — *"measured: two of the nine feet stopped being routable"* **[SRC]** | [SRC] |
| The Muro Torto | **no tower stairs, and none needed** — the mass is built against earth and a man walks on from the hillside (§4.5). Publish a zero-rise apron at each bay instead. | [ARCH] |
| Gatehouse crowns | one internal stair each, inside the block (§5.4) | [ARCH] |

**Three consequences worth naming.**

1. **Throughput collapses, on purpose.** Nine 2.8 m flights become thirty-two 1.1 m ones. A wall
   unit relieving another goes up in file, not in line, and takes about four times as long to
   get there. That is what a Roman wall was built to do, and it makes §10.2's problem — the
   garrison's inability to reinforce laterally — bite properly rather than being a curiosity.
2. **`reachable === runs` becomes true by construction rather than by a cadence table**, which
   is the whole reason runs 0 and 1 are orphaned today.
3. **The draw cost falls.** Nine external masonry flights with parapets and coping become
   geometry *inside* a tower that is already being drawn, most of which is never visible.

### 9.4 The measurement that closes it

`Siege.wallReport()` already prints `reachable`, `source` and the unbridged boundaries at every
boot:

```
reachable === runs,  source === 'published',  every stair foot routable,
and every unbridged boundary named in advance
```

The **only** unbridged boundaries the redesign permits are the two ends of the Muro Torto and
the two ends of the Vallis Sallustiana `gap` bay. Four, each a fact about the masonry, written
down before the build. Anything else is a defect.


## 10. What makes it play differently from Carthage

Two besiegeable cities that play the same are one map with two skins. In descending order of
how much each changes a player's decisions. **Note the frame: at Rome the player is the
garrison and at Carthage the besieger** (`SIEGE.md` §7.3), so half of this list is about what
the *defender* can do.

### 10.1 A line, not a depth — and the besieger has nothing to break it with

Carthage is 74.1 m of belt: a 20 m ditch, a palisaded rampart, an 8 m wall, an 18 m killing
ground, 16 m of casemated masonry. **Rome is 6.0 m of curtain and nothing else** — the ratio
`CARTHAGE.md` §4.2 puts at **12.4×** and correctly calls the only headline worth having.

The redesign does not narrow that gap and should not try. It sharpens it in the other
direction: the besieger at Carthage is Rome, with rams, towers, artillery and engineers. **The
besieger at Rome is the Juthungi, who have none of those** (§8). So the two maps are not
"deep defence" and "shallow defence"; they are **a siege and a storm**. Carthage is a
sequence of works to be reduced in order. Rome is a wall to be got over before the garrison
can get to where you are getting over it. That is a different game and it is the redesign's
thesis.

### 10.2 A garrison that cannot reinforce along the wall, and one half that cannot reinforce at all

Carthage's answer to "move reserves along the wall" is the casemate gallery — 4.4 km of covered
corridor inside the masonry, invisible and immune to missiles (`CARTHAGE.md` §8.2). Rome's is a
2.21–4.06 m walk in the open, severed at every tower, reached only by **a 1.1 m single-file
stair inside each tower** (§9.3). Nine 2.8 m external flights become thirty-two single files:
**a relief takes about four times as long to get up.**

**And the two halves of the wall are not alike.** The Muro Torto's mass is built against the
Pincian's hillside, so its garrison walks on and off at ground level anywhere along it — the
eastern half of the circuit, on the high ground, is the *most* reinforceable stretch on the map.
The western half, on the flat Campus Martius, where the gate is and where the three `footing`
bays are and where the whole assault is coming, **is reachable only up the towers, in file, from
a pomerium the storm will be shooting across.**

*The stretch under most pressure is the one with the fewest ways up, and it is the ground that
decides it, not a designer.* That is the defender's central problem on this map and it is the
map's, not the AI's.

### 10.3 Four apertures, four kinds of ground, and two of them are gardens

`CARTHAGE.md` §7.7 argues the Megara — market gardens, hedges, irrigation ditches, scattered
villas — earns its place because an attacker who gets over the north wall "does not arrive in
a city, he arrives in a chequerboard of walled gardens where a formation cannot hold its
line". **Rome has two Megaras and they are the same institution:** the *Horti Aciliorum* behind
the Porta Pinciana and the *Horti Sallustiani* behind the Porta Salaria are imperial pleasure
estates of terraces, enclosure walls, water and planting occupying most of the map's eastern
third inside the wall. They are cheap (scatter and low walls, not buildings), they are
attested, and they mean the three gates and the Posterula Pinciana do not lead to the same
battle.

### 10.4 The building site is the outwork

Carthage's approach is crossed under fire and ends at a 20 m ditch. Rome's ends at a trench
2.4 m deep with the spoil thrown toward you, stacks of *bipedales* to break a formation on,
lime pits, and five bays where the wall is a course of masonry at ground level that a horse
rides through. **The unfinished wall is not a handicap the map carries; it is the map's
defensive depth**, and unlike a ditch it is asymmetric — it is easier to get *in* through than
to fight *in*.

### 10.5 No flank at either end, arrived at differently

Both ends of Carthage's triple wall die on water. Rome's west end dies on the Tiber and its
east end **leaves the map through a fort**. Same property, and it is the property the shipped
map is missing.

### 10.6 Vertical endgame: Rome has none, and should not be given one

Carthage's last 400 m climb 45 m at 14 % up three stepped streets between six-storey blocks to
a walled citadel no engine can reach — "the battle gets *harder* the deeper the attacker goes"
(`CARTHAGE.md` §8.5). **Rome is the opposite and that is correct.** Behind the Aurelian wall
the Campus Martius is a flat monumental plain: through it and you are in the open, among
porticoes and temples, on paving, with room to deploy. There is no Byrsa, no citadel, no last
stand. **Do not invent one** — the Capitoline is 470 world metres and a whole city further
south, it is not in this battle, and putting a fallback keep behind the Aurelian wall would be
inventing the one thing Rome conspicuously did not have in 271, which is a defensible interior.

### 10.7 Water, and what it is for

Carthage has 14 ha of harbour inside the defences, a chained channel, a mole and a causeway.
Rome has a river **outside** them: 94 m wide, unfordable on this half of the map, closing the
west flank and narrowing the approach to a funnel. Carthage's water is a theatre of operations;
Rome's is a wall that happens to be wet.

---

## 11. What nobody knows, and what we are inventing

Listed so no one later mistakes our decisions for evidence. **Rome's list is shorter than
Carthage's and that is the point of building this map**: most of the Aurelian wall is still
standing, and most of the numbers in §4 are measurements rather than reconstructions.

| item | status | our decision |
|---|---|---|
| **The whole scenario** | **a counterfactual.** The wall was begun *after* the Juthungi were destroyed, precisely so this could not happen | built, and **§1.1 says so in the first paragraph and the blurb says where Aurelian is** |
| The line of the circuit, Tiber → Castra Praetoria | **standing** for most of it | surveyed, §2.5 |
| Curtain height and thickness | **measured on the fabric.** 6.5–7 m to the walk, *c.* 8 to the merlon crown, 3.5–3.7 thick | 6.5 / 8.55 / **6.0 built** |
| **The built curtain thickness** | — | **6.0 m, a 71 % widening**, [GAME], §4.3a. Already in source, kept, and it belongs in the blurb. |
| Merlon and embrasure | **measured**: breastwork 1.07–1.35 m, merlons 0.60 m, **embrasure = merlon width**, and *"the spacing… is not uniform over the whole Wall"* | **1.50 / 1.50 on a 3.00 m period**, changed from the shipped 1.70 / 0.95, §4.3 |
| Tower interval and plan | **100 *pedes* of curtain, 37.1 m interaxis, 7.5 m wide, 3 m projection** | used uncompressed; **36 for a real 93** |
| **The five-*pes* module** | **the pass's own reduction**, offered as such | authored on, §4.3b |
| Gate positions | **recorded**; Porta Salaria demolished 1921 and photographed | surveyed |
| Gate arch spans | Porta Latina **4.20 m** measured; Porta Appia **4.50 + 3.00 pier + 4.50** | used directly, §5.2 |
| The Porta Flaminia's Aurelianic form | round towers 7.5 m (Visconti) or 8 m (Richmond); **the gate lay under 3 m of Tiber flood debris and nothing Aurelianic stands** | built **from the type**, §13 |
| **The *cataracta*** | **not attested in 271.** Richmond puts portcullises at *all* gateways in **401–403** and says of the Aurelianic phase *"it is not possible… to know"*. No groove measurement exists anywhere. | **deleted**, §5.5 |
| The counter-gate court | **genuinely open** — Richmond says Aurelian built none; Dey argues the Ostiense and Appia courts are his, on a structural argument | **built**, and flagged |
| **Access to the wall-walk** | Richmond: gate- and postern-towers only, *"no example is known of a staircase to the Wall independent of a gateway"*. Cozza: ordinary towers had a ground-level city door and an internal stair | **every tower is the stair**, §9.3 — and it happens to satisfy `Siege`'s one-stair-per-run rule exactly |
| Whether the Tiber's left bank was walled in the Campus Martius | **yes, and it is gone.** Dey: *c.* 4,600 m, 1.20 m thick, 5–6 m high, towered — but the one surviving fragment has the **Honorian** formula, so the Aurelianic river wall is an inference from the measured circuit total | modelled as a **return with no bays**, §4.6, and its modelled length is chosen |
| **The Muro Torto's height** | **not attested in metres anywhere.** Cozza's elevations are in *ARID* 20 (1992), print only. Lanciani: *"so gigantic in size and height that no extra works of defence were added"* | **15 m**, chosen, §4.5 |
| The Muro Torto's date | **late Republican**, not 2nd century — the Acilii were *owners*, not builders — and Middleton says it had **already sunk and fallen forward soon after it was built**, so **it is already leaning in 271** | built leaning |
| Postern count and position | the Einsiedeln count is **5, all on the Tiber stretches**; Dey adds *"another five or six on the north stretch along the Tiber"*, named in medieval sources and matching the ferry landings. Widths measured at **2.69, 2.90 and 3.60 m**. The river ones' form and size are **not attested** | **five on the return, one on the land front**, at 2.70 m, positions [GAME] |
| How much of the circuit reused standing work | **disputed by a factor of two.** Lanciani's itemised list sums to **4,175 m = 22 %**, which he himself calls "one-sixth"; Coates-Stephens & Parisi 1999 revise it down to *"one-tenth or less"* | **Lanciani's per-item figures are used** because they are the only itemised ones, and the dispute is stated |
| Which bays were unfinished in 271 | **unknowable — no source gives a construction sequence.** Richmond's two-phase reading "left nothing behind" in later scholarship, and Dey holds the whole circuit was substantially complete by 275 | derived from **a rule** — *what was already standing was finished first* — rather than an offset table, §4.8 |
| The foundation trench's depth | *"varied according to the nature of the ground"*; **not attested** | 2.4 m, [GAME] |
| **"Twenty-one miles"** | **not the Chronographer and not the Regionaries** — it is **Olympiodorus**, from the geometer Ammon, and it is **64 % too large** against a measured 18,837.5 m. Santangeli Valenzani's best proposal (that Ammon walked round the tower projections) still leaves seven miles unaccounted for | reported as **an unexplained ancient error** |
| The Campus Martius's ancient ground level | **10–15 m a.s.l. in antiquity** (Platner & Ashby); the Horologium sequence gives Augustan **9.1–9.5**, Flavian **10.80**, modern 17.8 | *c.* **11 m** in 271; `PLAIN_LEVEL = 12.2` unchanged |
| The Tiber's ancient width and depth at the Campus Martius | **not established.** No published figure; the banks were mobile and the *muraglioni* are 1876 | 94 m at `RIVER_HALF_WIDTH = 47`, unchanged |
| Insula footprint in the Campus Martius | the Severan Plan gives shape, not module; **the modulus test recovers the digitiser's metre grid** (§6.4) | **30 × 45 m**, [MOD] [GAME] |
| The *Horti Aciliorum*'s internal plan | partial — lofty arcades on massive piers, a hemicycle, a two-chambered *piscina*, an octagonal nymphaeum | terraces and enclosures on a 50–90 m grid, [GAME] |
| **The Juthungi's numbers** | **40,000 horse and 80,000 foot, in a speech.** Modern war-band estimates are *c.* 600, and the largest attested Alamannic concentration is *c.* 15,000 | **5,000–20,000**, and §8.2 shows the arithmetic |
| **Whether the Juthungi could assault a wall at all** | **the strongest negative in the document.** Ammianus calls a Juthungi town-siege *praeter solitum* and Germanic siege ignorance *penitus* | **no towers, no artillery, no shedded ram** — and the shipped order of battle gives them all three |
| The date of the mint-workers' revolt | **271 or 274, genuinely disputed.** All three epitomators put it after the 274 triumph; Dey puts it in 271 | **271**, and §8.7 states the argument against |
| The *pilleus pannonicus*, the *plumbata*, the ridge helmet | the first is a reconstruction, the second is Diocletianic, the third is fourth-century | §8.6 |

**Two things that are *not* on this list, and it is worth saying so.** The wall's date and its
builder are not in doubt — 271 under Aurelian, finished under Probus, by the city's guilds. And
the identity of the enemy in Italy that year is not in doubt either. **Carthage's document has
to reconstruct a wall line. Rome's has to stop inventing one.**
---

## 12. Sources

Everything below was consulted for this document. Where a fact in §1–§11 has no source here it
is tagged [GAME], [DER], [SRC] or [MEAS] and is ours. **Nothing from any game, game wiki,
modding site or reconstruction image board was used at any point**, and §13 says how that was
enforced on the imagery.

### 12.1 The open-access core, and it is the pass's most useful find

The Sovrintendenza Capitolina, with Sapienza, Tor Vergata and Roma Tre, has published three
conference volumes on this monument **free, under CC BY-NC-ND** — and **Hendrik Dey wrote two
chapters of volume 1 himself.** 907 pages. This is the definitive modern scholarship and it is
downloadable.

- ***Le Mura Aureliane nella storia di Roma 1. Da Aureliano a Onorio*** (RomaTrE-Press 2017),
  ISBN 9788894885392 —
  https://romatrepress.uniroma3.it/wp-content/uploads/2019/12/Le-Mura-Aureliane-nella-storia-di-Roma-1.-Da-Aureliano-a-Onorio.pdf
  - **H. Dey, "Verso una storia edilizia delle Mura Aureliane", pp. 13–28** — *the single best
    source for the cross-section; §4.3's 7 m / 8 m resolution is his*
  - H. Dey, "Il perché delle Mura Aureliane", pp. 29–40
  - **M. Medri, V. Di Cola, S. Mongodi, "Studio dei paramenti laterizi", pp. 41–102** — brick,
    the *modulo*, §4.9
  - R. Volpe, "Mura e acquedotti", pp. 103–113
  - D. Esposito, R. Mancini, P. Vitti, "Sulle tracce del cantiere onoriano", pp. 115–131
  - **V. Di Cola, "Appunti sulle controporte… e il caso della porta Appia", pp. 163–192** — the
    arch spans in §5.2
  - M. Canciani et al., "Due casi di studio: Porta Latina e Castro Pretorio", pp. 209–232
- ***…2. Da Onorio a Niccolò V*** (2023) —
  https://romatrepress.uniroma3.it/wp-content/uploads/2023/02/lemu-losp.pdf — **R. Santangeli
  Valenzani, "Le Mura altomedievali nelle fonti scritte", pp. 15–23** (Ammon and the Einsiedeln
  table), and the sector-by-sector survey *Tratti A–M*, which is the best account of what the
  wall physically does at each stretch.
- *…3. Dal XVI secolo all'età contemporanea* (2026) — post-medieval only.

### 12.2 Ancient

- **Historia Augusta, *Divus Aurelianus*** — 18.3–5 (the Milan devastation and the riots),
  19–20 (the Sibylline debate), **21.1–3** (Placentia), **21.9** (the wall, and the reason),
  22.1 (he leaves for Palmyra), **38.2–4** (the mint-workers), 39.2 ("nearly fifty miles"). A
  fourth-century life of uncertain authorship mixing good annalistic material with invention;
  load-bearing only where a modern historian follows it, and its letters are compositions.
- ***Epitome de Caesaribus* 35.2** — *"tribus proeliis victor… apud Placentiam, iuxta amnem
  Metaurum ac fanum Fortunae, postremo Ticinensibus campis"*. **The only source that names the
  three battle sites**, and it is not the *Historia Augusta*. 35.4 (the mint), 35.6 (the wall).
- **Aurelius Victor, *Caes.* 35.6–7** — the mint-workers *"per Coelium montem"*, and the wall
  *"lest what happened under Gallienus recur"*, independently of the HA.
- **Zosimus, *Historia Nova* I** — **I.37** (a barbarian host reaches Rome under Gallienus and
  the Senate arms the city — *the map's precedent*), I.33.2 (Trapezus), I.43 (Gothic siege
  machines that failed), I.49 (the Danube battle and the wall), **I.52.3–4** (Aurelian's order
  of battle at Emesa, 272 — the only ancient one for this army).
- **Dexippus, *Scythica*** — **F 6 Jacoby = 28 Müller = fr. 1 de Boor**, the Juthungi embassy,
  in the Constantinian *Excerpta de Legationibus*. **Not** in the Vienna palimpsest. The
  palimpsest (*Scythica Vindobonensia*, Cod. Vind. hist. gr. 73) is Decius' Gothic wars of
  250–251 and contains **§8.5's escalade**, published by **Gunther Martin & Jana Grusková**,
  *GRBS* 54 (2014) 728–754 and *Tyche* 29 (2014), 30 (2015).
- **Ammianus Marcellinus** — **16.2.12** (the Alamanni shun towns "as if tombs surrounded by
  nets"), 16.4.2 (Sens), 16.12 (Strasbourg: the wedge, the dismounted princes, the *barritus*),
  **17.6.1** (a Juthungi town-siege, *praeter solitum*), 31.6.4 and **31.8.1** (*"penitus
  ignorantes"*), 31.13.15 (burning a door they could not break).
- **Tacitus, *Germania*** 3 (the *barditus*), 6 (the wedge, the *framea*, few swords, fewer
  helmets), 13–14 (the *comitatus*, *materia munificentiae per bella et raptus*).
- **Procopius, *Wars* V (Gothic War I)** — **xxii.12–13** (Hadrian's tomb *outside* the gate),
  **xxii.15** (the river frontage is *"the least assailable of all"* and got an insignificant
  garrison), **xxiii.3–8** (the Muro Torto, *murus ruptus*, and Belisarius stopped from
  rebuilding it).
- **Vegetius, *Epitoma rei militaris*** 1.17 (the *plumbata* named under Diocletian, i.e. **not**
  in 271), 1.20 (the *pilleus pannonicus*), 2.15–16 (his own renamings), IV.4 (the *cataracta*
  in a *propugnaculum*).
- **Chronographer of 354** — *"hic muro urbem cinxit"* (no length), and of Maxentius
  ***"fossatum aperuit, sed non perfecit"***, which is §7.1's positive evidence; and the
  ***Breviarium totius urbis***, §8.6's garrison inventory.
- **Olympiodorus fr. 41 Blockley**, in Photius — **the real source of the "21 miles"**, measured
  by *"the geometer Ammon"*, and irreconcilable with the measured 18.8 km. §11.
- **The Einsiedeln *Descriptio murorum*** — 383 towers, 7,020 merlons, **5 posterns**, 116
  latrines, segment by segment. Not a snapshot of 271, and its date is undetermined.
- **Cassius Dio 55.24** (the Guard's and the urban cohorts' strengths), **Pliny, *NH* III.66–67**
  (the AD 73 circuit of 13,200 *passus*), **Suetonius, *Iulius* 88** and **Dio 47.19.1** (the
  Curia Pompei walled up and turned into a privy), **Strabo 5.3.8** (the Mausoleum of Augustus),
  **Pliny, *NH* 36.71–73** (the Horologium already wrong), **John Malalas XII** (Aurelian
  compels the *collegia*), **the Augsburg victory altar, AE 1993, 1231**.

### 12.3 Modern, on the wall and the city

- **Ian A. Richmond, *The City Wall of Imperial Rome* (Oxford 1930).** The measured survey and
  still the base text. **Full text unrestricted at archive.org, `citywallofimperi0000unse_t5t0`**
  — the `…0000rich` copy is lending-locked. Source of the 6.5 m and 3.5 m already cited in
  `src/city/layout.ts` **[SRC]**, of the parapet measurements, of "no putlog holes", and of
  §9.2's ruling on access. **His attribution of the heightening to Maxentius is wrong** and Dey
  calls it *"by far the greatest defect of his fundamental book."*
- **Hendrik W. Dey, *The Aurelian Wall and the Refashioning of Imperial Rome, AD 271–855*
  (Cambridge 2011).** Note **Appendix D, "The Aurelian Wall and the refashioning of the western
  tip of the Campus Martius", pp. 304–309** — an appendix on precisely this map's subject, which
  the research pass could not open. **It should be read before the build starts.**
- **Samuel Ball Platner & Thomas Ashby, *A Topographical Dictionary of Ancient Rome* (Oxford
  1929).** Public domain at LacusCurtius; already the survey's backbone in `src/city/rome.ts`.
  **Its elevations are above mean Tiber level — §3.4.**
- **Rodolfo Lanciani**, *The Ruins and Excavations of Ancient Rome* (1897), walls pp. 66–77, the
  incorporated-structure list p. 72, the Muro Torto p. 74; and the *Forma Urbis Romae*
  (1893–1901), public domain.
- **J. H. Middleton**, *The Remains of Ancient Rome* (1892) II, walls pp. 374–390 — the Muro
  Torto's fabric and its early collapse.
- **Lucos Cozza**, the sector monographs in *ARID* 20 (1992), 21 (1993), 25 (1997) and *PBSR* 76
  (2008) — **§9.3's tower stair and §4.5's "no galleries" both come from him**, at second hand
  through the RomaTrE volumes. Print only.
- **Giovenale**, "Le porte del recinto di Aureliano e Probo", *BCom* LIX (1931) — most of the
  arch spans, at second hand.
- **Coates-Stephens & Parisi**, *AnalRom* 26 (1999) 85–96 — the downward revision of the reuse
  fraction. **Filippo Coarelli**, *Rome and Environs*. **Malcolm Todd**, *The Walls of Rome*
  (1978) — **lending-restricted; every Todd figure here reached us at second hand and is
  unverified.**
- **The Severan Marble Plan** (AD 203–211; 18.10 × 13 m on 150 slabs at 1:240, 1,186 fragments
  surviving, 10–15 % of the whole), the **Stanford Digital Forma Urbis** project, **Digital
  Augustan Rome**, **K. Schaldach** on the Horologium levels (2020), **J. E. Packer** on the
  Theatre of Pompey (2014), **Frank Sear**, *Roman Theatres* (2006), **Rabun Taylor** on the
  Tiber bridges (IATH Virginia).

### 12.4 Modern, on the campaign and the Juthungi

- **John F. Drinkwater, *The Alamanni and Rome 213–496* (Oxford 2007).** The standard treatment;
  full text at archive.org. Source of the 600-man war-band, the Strasbourg re-estimate, and
  *"with no commissariat and carrying quantities of booty… vulnerable to counter-attack."*
- **Alaric Watson, *Aurelian and the Third Century* (Routledge 1999)** — the standard monograph
  on the campaign chronology. **Inaccessible by every route tried. Consult it before §8 is
  built to.**
- **Lothar Bakker**, *Germania* 71 (1993) 369–386 — the *editio princeps* of the Augsburg altar.
- **Timo Stickler**, *Bayerische Vorgeschichtsblätter* 60 (1995) 231–249; **Helmut Castritius**,
  "Semnonen–Juthungen–Alemannen" (1998); **Herwig Wolfram**, *The Roman Empire and Its Germanic
  Peoples* (2005); **Geuenich** and **Neumann**, "Juthungen" §§1–2, *RGA* 16 (2000).
- **Lukas de Blois**, "Invasions, Deportations, and Repopulation" (Brill 2016), and *The Policy
  of the Emperor Gallienus* (1976).
- **The National Museum of Denmark on the Vimose deposit** — over 2,500 objects, early third
  century: the lance as the main weapon, the sword an officer's, mail a leader's, and archers
  entering the Germanic infantry in the third century.
- **M. P. Speidel**, *Riding for Caesar* (1994) — the *equites singulares*.

### 12.5 Survey and raster data actually used, with licences

Four are already catalogued in `ASSETS.md`; the fifth was fetched for this pass.

| what | licence | used for |
|---|---|---|
| Lanciani, *Forma Urbis Romae*, georectified WMS (ArcheoSITARproject / SSABAP-RM) | map content PD by age (author d. 1929); georectification **CC-BY-SA 4.0** | the survey's positions; `src/city/overlay.ts`'s affine, worst residual 1.26 m over 7 km |
| AGEA 2012 colour orthophoto, Geoportale Nazionale / MASE | **CC BY 4.0** | the modern aerial check |
| *Forma Urbis Severiana* vector, SITAR | CC-BY-SA 4.0, the stricter of SITAR's two statements | §6.4's grain test, **and its negative result** |
| **Piano Topografico di Roma e Suburbio 1908–1924, 1 m contours**, SITAR | CC-BY-SA 4.0, with the required citation format in `ASSETS.md` | §3.3's elevations. **A second extract covering the north-east quadrant was fetched for this pass** — same layer, same licence, and it must be requested as **WFS 1.1.0 with `propertyName=geom,altitudine`**, because 2.0.0 JSON output errors on a server-side column mismatch. Saved as `reference/rome-plans/sitar-ptrs-1924-contours-ne-quadrant-EPSG4326.geo.json`. |
| Clarke, *Plan of Ancient Rome* (1830) | PD-old-100-expired | context |

**Deliberately not used**, for the reasons already in `ASSETS.md`: Stanford's Digital Forma
Urbis meshes (all rights reserved), Digital Augustan Rome's API (no licence statement),
mappingrome.com, Rome Reborn.

⚠ **Do not cite `digitalattic.org` for Vegetius.** That domain now serves gambling spam.
---

## 13. Reference imagery — `reference/rome-aurelian/`

**16 files, 30.4 MB, all JPEG, every licence verified on its own asset page before a byte was
fetched, and catalogued in `ASSETS.md`** under "Aurelian Rome reference". `reference/` is
gitignored in full and the directory carries `.metadata_never_index`; nothing in it ships,
nothing in it is loaded at runtime, and **none of it is deck-eligible** — `reference/rome2/`
remains the sole blind render-quality plate pool, and mixing provenance has been got wrong
twice on this project.

| use it for | files |
|---|---|
| **§4.5 the Muro Torto** — the batter, the fabric, the road cut, and **Piranesi's 1756 measured plan of its buttresses** (tav. XI) | `muro-torto-lean-and-fabric-joris-2006.jpg`, `muro-torto-viale-and-pincio-indeciso42-2024.jpg`, `piranesi-1756-tavXI-muro-torto-speroni-plan-3840px.jpg` |
| **§4.3 the cross-section** — inner-face arcading, the walk, the parapet, the merlons, string courses end to end | `wall-inner-face-arcading-via-campania-sailko.jpg`, `wall-walk-parapet-tower-museo-delle-mura-3840px.jpg`, `wall-porta-sansebastiano-to-porta-latina-lalupa.jpg` |
| **§4.4 tower rhythm** along the Corso d'Italia stretch — the Porta Pinciana–Porta Salaria run this map models | `wall-corso-ditalia-tower-interval-blackcat-2012.jpg` |
| **§4.4 a measured plan and section of one segment and its tower**, from Middleton's 1911 *Britannica* article | `middleton-1911-eb11-aurelian-wall-tower-plan.jpg` |
| **§5 gates** — the twin-tower type at Porta Appia, the round-tower northern-arc type at Porta Pinciana, and **the ancient Porta Salaria photographed *c.* 1870, before its 1921 demolition** | `porta-san-sebastiano-porta-appia-frontal-raboe-2025-3840px.jpg`, `porta-pinciana-external-face-joris-2006.jpg`, `porta-salaria-ancient-gate-photo-c1870.jpg` |
| **§4.7 the Castra Praetoria** — the standing Tiberian wall under the Aurelianic raising, and Piranesi's plan | `castra-praetoria-north-wall-joris-2006.jpg`, `piranesi-1756-tavXXXIX-castra-praetoria-plan-3840px.jpg` |
| **§4.9 the building site** — third-century *opus latericium* coursing, and a clear row of putlog holes **for what the Aurelian wall does *not* have**: the plate is Caracalla's villa, and putlogs are the diagnostic that separates 403 from 271 (§4.9). Use it for the coursing and the brick faces, and as the negative for the scaffolding. | `opus-latericium-putlog-holes-caracalla-villa-2023-1920px.jpg` |
| **§2.5, §6 the plan and the ground** — Lanciani's northern arc georectified, and the modern orthophoto of the same frame showing **the Tiber's width and bend** | `lanciani-sitar-northern-arc-campus-martius-…-4096px.jpg`, `agea-2012-ortofoto-northern-campus-martius-…-2048px.jpg` |

**Three cautions, and the third is the one that will cost a builder a day.**

1. **Almost everything photographed is later than 271.** The wall was doubled under Honorius in
   401–402 and repaired for fifteen centuries; the upper half of nearly every standing stretch
   is not the wall this map is set at. Use the photographs for **brickwork, coursing, string
   courses, tower plan and light**; use §4.3 for the dimensions. Where they disagree, the
   number wins.
2. **A search for "Aurelian Wall reconstruction" returns mostly game art**, a significant
   fraction of it extracted from commercial titles — including the one this project's blind
   decks are graded against. Nothing of that kind is in the pool. Two candidate files were
   rejected **on provenance rather than licence**: a set of CC-licensed "own work" schematics
   of the wall's dimensions citing no source, and eight historic views of Porta Salaria
   uploaded as own work in 2014.
3. **Porta del Popolo is not the Porta Flaminia.** The gate that stands there is Nanni di Baccio
   Bigio's of 1562–65 outside and Bernini's of 1655 inside; the flanking towers were pulled
   down in **1879** and the side arches cut in **1887**. **No Aurelianic fabric is standing.**
   A photograph of it will build a sixteenth-century gate. Build the Porta Flaminia from the
   **type** — Porta Pinciana is the best-preserved specimen of the same round-towered northern
   family — plus the Lanciani raster for the position.

**Wanted and not found under an acceptable licence**, recorded so nobody repeats the search:
**Richmond 1930** (author d. 1965, in copyright to 2036, and 1930 US publication misses the
pre-1930 window — *the single most wanted item*); **a measured, dimensioned elevation of the
curtain** giving course heights, arcade-pier spacing and parapet height; the
***Bullettino della Commissione Archeologica Comunale di Roma*** and the public-domain
monographs (Lanciani's *Storia degli scavi*, Rossini, Middleton, Parker, Burn), all PD but
**PDF only** and therefore excluded by the format rule; and **any nineteenth-century photograph
of the Muro Torto** — Piranesi's 1756 plate is the only pre-modern record of it that exists.


## 14. What Carthage cost this project, and how Rome is built not to repeat it

Carthage is the exemplar. It is also the map that produced, in one week, a ditch that was
published and never dug, posterns that were arches with nothing hung in them, a gate cut past
the end of its own bay, and a gatehouse whose crown the garrison could not stand on. All four
have the same shape, and `SIEGE.md` §5.2 already names it:

> **The art asserts a property the simulation does not implement, and every instrument agrees
> with the art.**

The defence is also already written down: *measure the thing the picture is claiming, in the
representation that has to act on it.* Below, each fault, the mechanism, and the specific line
in this design that closes it for Rome.

### 14.1 The ditch that was published and never cut

`carthageWall.ts` built a 20 × 6 m ditch into its own arithmetic — `BELT_DEPTH` counted it,
`assertSection` checked it, `CARTHAGE_SECTION.beltDepth` reported 34.1 m of landward defence,
`CitySystem.getDitch()` handed the record to anyone who asked — and the ground fell **0.16 m
at its worst station and 0.00 m at four of sixteen** (`c6fdd6e`, [MEAS] at `4e3145f`). The
belt an assault actually crossed was 14.1 m of masonry while every consumer was told 34.1.

**The mechanism was a seam with no far side.** A 6 m cut is a heightfield edit and
`src/maps/` is not the city's, so the plan crossed the seam as a request and nothing ever
answered it.

**It is fixed at `3595b48` and the fix is the template.** `maps/carthage/heightfield.ts`
stage 4h cuts it, `WallLine.ditchIsCut: true` carries the fact back
(`city/carthage/circuit.ts:101`), and `assertDitchCut` grades it at load. **One residue is
still live and is itself the lesson:** `CitySystem.getDitch()`'s own docstring still says
"`built` is false … the belt is 54.1 m of standing works and not the spec's 74.1". Both halves
are now false. *A comment that outlives the defect it describes is how the next reader
re-derives the wrong number.*

**Rome's version:** §4.9 is the *only* place on this map where the city asks the terrain for
anything, and it is specified with the fix's four properties already attached — one section
constant, one path function shared with the publisher, a freeboard cap, and `assertWorksCut`
printing stations-cut and relief-median at every boot. **The acceptance test in §15 task 8 is
a transect of `TerrainSystem.heightAt` and not a read of the plan.**

**And the meta-lesson, which is the more valuable one:** the ditch was not caught by any of
the instruments aimed at it, because they all read the plan. It was caught by *walking a
transect of the ground*. **For every property this document claims, §15 names an instrument
that measures the property in the representation that acts on it.** Where I could not name
one, the entry says so.

### 14.2 Posterns that were arches with nothing hung in them

Carthage's eight posterns are published as `GateOut`s that are already `open`, and they
measure at `6698e19` as "eight bands about 4 m wide" in the collision surface. An arch drawn
at 1.5 m and a hole open at 4 m are not the same door, and a *postern* that is permanently
open is not a postern at all — it is eight unguarded holes in a wall whose entire design
premise is that it cannot be got through.

**Rome's version:** §5.3. A postern is **shut**, has a **door**, is drawn at its real **1.6 m**,
and publishes **no nav passage at all** — when it opens it is an authored `Crossing`, one man
at a time. The width the eye sees, the width the collision model sees and the width the
pathfinder sees are 1.6, 1.6 and *nothing*, and all three are correct.

### 14.3 `porta-uticensis` is cut past the end of its own bay by 0.17 m

Carthage prints `section faults: porta-uticensis is cut past the end of bay 50` at every boot
**[SRC]**. `SIEGE.md` §7.5 lists it as a live fault and correctly observes that surfacing it
rather than suppressing it "is the design of `CityChecks` working". It is still a gate hanging
0.17 m off the end of the masonry it is cut through.

**The mechanism** is that the gate's x was chosen in the survey and the bay grid was laid
independently, so nothing forced them to agree.

**Rome's version:** the four gate positions in §5.1 are survey positions, and the bay grid is
`WALL_X_MIN + k × 29.6`. They will not agree either — unless the build **snaps each gate to
the nearest bay centre and reports the snap distance**. §15 task 5 requires exactly that, with
the acceptance criterion that **every gate's clear opening lies wholly within one bay, with at
least 1.0 m of masonry either side**, printed at boot. Snapping four apertures by up to 18 m is a
15 m error in a survey whose compression is already 2.26 m per world metre in x; carrying an
unreported 0.17 m overhang is a defect. Take the snap and print it.

### 14.4 A gatehouse whose crown the garrison could not stand on

Two accessors landed 48 minutes apart with different field names, `as unknown as` discarded
the structural check, `tsc --noEmit` stayed clean, and 22 stations sat 6.574 m inside solid
masonry (`SIEGE.md` §7.2, [MEAS] at `6698e19`).

**Rome's version:** §5.4 deletes the clip and puts a **run on the crown**, which is what both
source files already name as the better fix. And the *general* lesson is the one that matters
more than the gatehouse: **the `CityView` duck-typing seam has no compiler.** Twelve consumers
resolve the city through `as unknown as` (`SIEGE.md` §1.3). Any new accessor this design asks
for — `getWallReturns()`, `getWorks()`, `getPosternCrossings()` — must be added to `Siege`'s
`CityView` **and** to `CitySystem` **in the same commit, with the same field names**, and
§15 task 12 requires a probe that calls each one through `window.__game` and asserts a
non-null answer. A type that both sides declare separately is a type neither side checks.

### 14.4a `wall.ts` has no build-time self-check of any kind

This is the largest structural asymmetry between the two wall files and the most portable
thing Carthage has. `carthageWall.ts` publishes **`assertSection`** (eight identities that the
cross-section must close on), **`cutFaults`** (a void that does not fit its bay) and
**`sectionFaults`** — all as *data on the output*, not as a `console.warn` and not as a throw.
Its own comment says why: *"a build-time `console.warn` is invisible to a probe and an
exception takes the page down… prose does not run."* **[SRC]**

`wall.ts` has none. Nothing checks that Rome's section closes, that a gate fits its bay, that
`walkY` steps are survivable, or that a bay's published `passOuter`/`passInner` match the stone
it cut. Every defect in §4.1 and §5 above is one an eight-line assertion would have printed at
every boot for the last six months.

**§15 requires `assertRomeSection` before task 3 lands**, publishing at minimum: the section
sum (plinth + lifts + walk slab + parapet = height to merlons), the worst bay-to-bay `walkY`
step and its x, the gate's clearance inside its bay, the count of bays whose footing is below
`WATER_LEVEL`, and the tower-pass clear lane against `MIN_LANE`. Faults on the output, not in
the console.

### 14.5 Three definitions of one wall line

`cityPlan.ts` records that Carthage's wall line existed in three places — the terrain's
quadratic, `circuit.ts`'s bowed interpolation, and `carthageWall.ts`'s own — that agreed at
three anchors and diverged by **25 m at mid-span**, which is wider than the graded bench they
were supposed to stand on **[SRC]**.

**Rome's version:** §4.2 authors the circuit as **one polyline in the survey frame**, and the
heightfield's bench, the wall builder's line and the scatter's glacis clearance must all take
it from the same export. `crestZAt(x)` — which is currently *both* the terrain's crest and the
wall's line — must stop being the wall's line and become what its name says. §15 task 2.

### 14.6 Rome is the city that never got a directory

Carthage owns `src/city/carthage/` — ten modules, one per workstream, no shared editing.
Rome's plan is 227 lines in `src/city/rome/plan.ts` and **everything else Rome is lives in the
generic namespace**: `layout.ts` holds `WALL`, `WALL_X_MIN/MAX`, `POMERIUM`, `GATE_X`,
`bayStage` and `WAY_WIDTH`; `wall.ts` holds `CURTAIN_T` and the whole Aurelian gate; `rome.ts`
holds the survey. That is why `?fort=carthage` had to exist as a development rig, why
`probe-nav`'s `openGroundBehindWall min 40` was "a Rome number" that had to become per-map
(`CARTHAGE.md` §7.5), and why the second city's builders had to read Rome's files to find out
what a wall was.

**Rome's version, and it is a precondition for this redesign rather than a nicety:** move
Rome into `src/city/rome/` as peers of Carthage's — `circuit.ts` (§4), `apertures.ts` (§5),
`fabric.ts` (§6), `works.ts` (§4.9), `assertions.ts`, `layout.ts` — and leave in the generic
namespace only what a *third* city would also need. This is §15 task 0 and it is the only
task in the list that changes no behaviour. **Do it first anyway**: five agents cannot build
§3, §4, §5, §6 and §9 in parallel out of one 2,337-line `layout.ts`.

### 14.6a And one number in it is wrong by a factor of five

`CARTHAGE.md` §2.5, arguing for the Punic wall's cost: *"modelled wall length 1,984 m against
Rome's 1,781 m… **Rome's wall costs 216 draw calls.** Carthage's is 12 % longer, three walls
deep and casemated. **Budget for it early; this is the map's largest single risk.**"*

**Measured at `3595b48` on the assault at ultra, the whole city is 101 draws and the `wall`
family is 44 of them** — the boot line prints the breakdown at every start: *"101 draws (cap
220 whole-frame), 2.38 M tris visible, 23 chunks — wall 44, monuments 22, city 21, road 5,
gate 2, aqueducts 2."* **[MEAS]** `probe-boot-carthage.mjs --map=campus-martius
--scenario=assault --quality=ultra`. 216 is very close to the *whole-frame* figure of the era
and looks like a total that lost its label on the way into a comparison about a wall.

Two reasons this matters more than a stray digit. First, it is the number Carthage's largest
design risk was assessed against, and it made the wall look five times more expensive than it
is — which is the kind of error that gets a good feature cut. Second, it is exactly §14.7's
first bullet in miniature: **a figure with no instrument beside it reads as a measurement**,
survives review, and gets quoted forward. §4.10 of this document prices every item of the
redesign against the measured 44 and prints the arithmetic.

### 14.7 And one thing about the document itself

`CARTHAGE.md` is 1,068 lines and it earns most of them. The parts a build pass actually
executed from are §2 (the projection), §4 (the wall), §5.1a (the one override), §7.1–7.3 (the
module and the grain) and §12 (the build order) — call it 400 lines. The rest is
justification, and justification is what makes the numbers trustworthy, so it is not waste.
But five habits in it cost this project real time and Rome should not copy them:

- **A number stated without an instrument reads as a measurement.** `CARTHAGE.md` mixes
  derived, measured and chosen figures in one column with a tag that distinguishes *evidence*
  but not *provenance*. That is how `beltDepth = 34.1` sat in a table for four commits looking
  like a fact. This document adds **[MEAS]** and **[SRC]** to the tag set for exactly that
  reason, and every measured number here names the tool and the commit.
- **A build order without acceptance criteria is a wish list.** `CARTHAGE.md` §12 is four
  paragraphs of "who goes first". The ditch shipped unbuilt underneath it. §15 is a numbered
  list where **every task carries the measurement that closes it** and the instrument that
  takes it.
- **It never asks what the engine can represent.** `OCC_CELL = 4`, `Pathfinding.CELL = 7`,
  `bayAt`'s arithmetic index in x, `recut`'s 0.62 m step, `LINK_MAX_GAP = 14` — every one of
  those decided something about how Carthage turned out, and every one was discovered
  afterwards. Eight posterns became eight permanently-open four-metre holes because nobody
  asked whether a 1.5 m door could exist. **§2.1 of this document is the section
  `CARTHAGE.md` is missing**, and every feature in §4 and §5 is priced against it before it
  is specified.
- **It reaches for [GAME] before it has exhausted the archaeology.** Fair at Carthage, where
  no gate is attested. But the same instinct applied to Rome would have invented gates that
  are *standing*, a portcullis that is *Honorian*, and a stair type that *never existed*. The
  procedural rule: **exhaust the record first, and where you must invent, invent the smallest
  thing.**
- **It argues about play and never measures it.** `CARTHAGE.md` §8 is nine excellent arguments
  for how the map plays differently, and not one carries a number or names a probe. Six months
  later `SIEGE.md` §7.4 measured that the escalade *cannot clear a bay* on the shipped
  garrison — the map does not play the way §8 says it does, and nothing in §8 could have
  caught that. §10 here is the same kind of argument; **§15 task 14 is the probe that makes it
  falsifiable**, and if it comes back red the argument is wrong, not the measurement.

**And what to keep, because most of it is right:** the survey-and-projection discipline (§2),
the rule that positions compress and cross-sections do not (§2.4), the explicit
one-place-we-override section (§5.1a there, §2.4a here), the frankness about what a source can
and cannot bear (§4.6 there), and above all **authoring the fabric on the ancient module
rather than on metres** (§7.3 there, §4.3b and §6.4 here) — which is the single best idea in
the document and which Rome had available and had never used.

---

## 15. Build order — the executable summary

Fifteen tasks. Each names its owner-shaped scope, what it changes, and **the measurement that
closes it**. A task without a green measurement is not done, and the measurement is taken in
the representation that has to act on the property, not in the plan that publishes it (§14.1).

Every probe below runs against a dev server on **its own port**, never 5173, killed by PID.
Launch Chromium with `--use-gl=angle --use-angle=metal` or headless software-rasterises the
siege.

**Eight of the instruments this document used are checked in** and are the "before" side of
several of these measurements: `tools/scratch/probe-romeflank.mjs` (the open bands, the wall
report, the stairs), `probe-romeflank2.mjs` (the Tiber's bed, the crest profile, the `walkY`
steps), `probe-romeaperture.mjs` (the gate's three widths), and `rome-geo.mjs`,
`rome-contour.mjs`, `rome-wallprofile.mjs`, `rome-transect.mjs`, `rome-fur-grain.mjs` for the
survey and the ground. The two that matter most already existed: **`tools/probe-footing.mjs
--only=census,around`** and **`tools/probe-solid.mjs --case=gates`**.

### Phase A — make the work parallelisable and put the ground where it belongs

**0. Move Rome into `src/city/rome/`.** §14.6. No behaviour change. `circuit.ts`,
`apertures.ts`, `works.ts`, `fabric.ts`, `layout.ts`, `assertions.ts`, as peers of
`src/city/carthage/`. Leave in `src/city/layout.ts` and `src/city/wall.ts` only what a third
city would need.
*Acceptance:* `tsc --noEmit` clean; `node tools/probe-wall.mjs --port=PORT` returns **19/19**
and `probe-carthage-wall.mjs` **44/44**, both unchanged; the boot line
`[city:rome] N draws … M tris` is **byte-identical** before and after.

**1. Move the Tiber onto the survey.** §3.2. Re-author `riverCentreX` from the twelve-point
projected polyline; re-fit or table-drive the `TOPO_GLSL` mirror; move `germanDeployMask` to
about ±380 m about x +40; keep `FORD_Z = −520`.
*Acceptance:* a transect script that projects the twelve survey points through `worldOf` and
compares against `riverCentreX(z)` reports **worst error ≤ 25 world m** (today: 250–820).
`probe-ground.mjs` shows no water inside either deployment mask. `probe-nav.mjs` finds no
route from the attacker box to inside the city round the west end.

**2. Re-cut the relief along the circuit, and grade a bench under it.** §3.5. Replace
`riseAmplitude`'s two Gaussians with the seven-band staircase. `crestZAt` stops being the
wall's line (§14.5) and the circuit polyline becomes the single export the heightfield, the
wall builder and the scatter's glacis clearance all read. **Rome's heightfield cuts no bench
today** (§4.1) — the wall stands on ungraded natural crest and `buildWall` levels each bay to
whatever it finds, which is the mechanism behind the 28.39 m walk step. Add one, on Carthage's
`WALL_BENCH_HALF = 40` pattern.
*Acceptance:* a transect of `TerrainSystem.heightAt` along the published circuit at 5 m
intervals matches §3.5's table to **±1.5 m at every station**; the graded bench is at least
40 m wide under **100 %** of stations; the worst bay-to-bay `walkY` step, printed by
`assertRomeSection`, is **under 6 m** against today's 28.39; and `probe-ground.mjs` reports no
slope over `ROUGH_SLOPE_IMPASSABLE` inside either deployment mask.

### Phase B — the circuit

**3. Author the circuit as a survey polyline, and give `wall.ts` an `assertRomeSection`.**
§4.2, §2.5, §14.4a. Fourteen waypoints; project; lay **36 bays at a 37.03 m x-pitch** from
x +2 — the true Aurelianic interaxis, against the shipped 35.5.
*Acceptance:* `CitySystem.assertUniformBayPitch` does **not** warn (worst deviation printed,
must be **≤ 12 %**, expected 6 %); `Siege.wallReport()` reports **36 bays**; the west end is
within **2 m** of x +2 and the east within 2 m of x +1335. And **`assertRomeSection` publishes
faults on the output** — the section sum, the worst bay-to-bay `walkY` step and its x, each
gate's clearance inside its bay, the count of bays footed below `WATER_LEVEL`, and the tower
lane against `MIN_LANE`. `wall.ts` has no build-time self-check of any kind today and
`carthageWall.ts` has three.

*And one measurement that belongs here because nobody has taken it* (§3.5): **print the height
difference across every link `buildLinks` creates.** The classifier bridges on horizontal gap
alone and never looks at `dy`, while `recut` severs on `dy` alone — so the two disagree by
construction, and Rome carries a 28.39 m bay-to-bay step today. **Assert that no `TowerPass` or
`Step` link joins two stations more than 1.2 m apart in height.** If the shipped circuit fails
this at `3595b48`, that is a defect in the tree and not in the redesign, and it should be
written up before it is fixed.

**4. The Muro Torto.** §4.5. Seven bays, outward batter of 6°–7°, ~15 m, built **against
earth** so the city side is hillside: garrisonable, **no tower stairs and none needed**, a
zero-rise apron at each bay instead, and unescaladable from outside.
*Acceptance:* `Siege.wallReport()` reports **32 garrisonable bays** and exactly **four**
unbridged run boundaries, at the named x. `probe-wall.mjs`'s see-through ray sweep finds
**zero** rays passing the Muro Torto band; `masonryTopAt` returns a finite height across the
whole of it (it is stone, not a gap); and a `Pathfinding` route from the *horti* behind it to
any of its seven runs **succeeds without using a stair**.

**5. Three gates and two posterulae.** §5.1, §5.2, §5.4. **Porta Pinciana is a postern in 271
and must not be built as a gate.** Snap each aperture to a bay centre and **print the snap
distance** — and note that the setting-out of the Porta Flaminia against its curtain is
*attested to be botched* (§4.9), so print the number rather than tidy it away.
*Acceptance, and this is the §14.3 test:* at boot, for each gate, `min(distance from either
edge of the clear opening to the end of its bay) ≥ 1.0 m`, printed. Any gate that cannot
satisfy it moves a bay, and the move is recorded in §11.

**6. The aperture rule.** §5.2. One `clearWidth` per aperture; drawn jambs, obstacle boxes and
raster clear from one helper; pier centres snapped to `OCC_CELL` boundaries.
*Acceptance:* **`tools/probe-solid.mjs --case=gates` already casts exactly these three views**
— `mesh` (raycast against the baked chunks), `boxes` (`getObstacles()` through the sim's own
`ObstacleField`), `raster` (`blocksMovement()`) — along each gate's own axis and prints where
they disagree. **Do not write a new probe; add the assertion to that one:** for every aperture
on both circuits, `raster ≤ collision ≤ drawn` and `drawn − raster ≤ 4.0 m`. The before-figures
are Rome **4.30 / 5.30 / 8.00** and Carthage **5.20 / 6.20 / 8.00**, both measured at
`3595b48`. Add the tower footprint to the same case: drawn 7.6 × 9.5 offset 1.75 m fieldward
against a 7.6 × 7.6 box and an r 3.8 circle, both on the wall line.

**7. Posterns as crossings.** §5.3. Six shut, doored, **2.70 m**, publishing `Crossing`s and
no nav passage: one on the land front at bay 14, five on the west return at the ferry landings.
**And close the one Rome already has** — the river terminus at the west end carries a drawn
1.8 m postern with nothing hung in it and no crossing behind it **[SRC]**, which is Carthage's
§14.2 defect already shipped on Rome.
*Acceptance:* `probe-nav.mjs`'s wall-line sweep finds **no open band** at any postern; a
`Crossing` test drives a file through one and reports throughput within 15 % of one pair per
1.1 s; `blocksMovement` is `true` across every postern at t=0; and `probe-solid.mjs --case=gates`
reports drawn = collided = 2.70 and raster = 0 for each.

**8. The building site, cut into the heightfield.** §4.9. `RomeWorks` with `built: false`
crossing the seam; `heightfield.ts` answers; `assertWorksCut` at boot.
*Acceptance, and this is the §14.1 test:* an independent transect of `TerrainSystem.heightAt`
across the published centreline, **sampling at least seven bays and not the gate bay**,
reports relief median within **0.15 m of the 2.4 m spec**, **0 stations under the datum**, and
worst nav gradient below **0.62** on `Pathfinding`'s own 7 m lattice with its own 14 m
central difference.

**9. Close the flanks.** §4.6. Both returns as `occBlockers` and obstacle boxes, no bays. The
west one is a **1.20 m screen wall 5–6 m high, towered at 37.1 m** — not the land curtain.
*Acceptance, and this is the headline test of the whole redesign:* **`tools/probe-footing.mjs`
already has an `around` case — "can anything path round the ends".** Run it
(`--only=census,nav,around`) and make it assert rather than report. Drive a 32 m segment
through the wall line at 2 m intervals **and round both ends out to the map edge**, asking
`CitySystem.blocksMovement`: the only open bands may be the **three gates and the three
`footing` bays**. Then ask `Pathfinding` — not `blocksMovement`, because the west flank is closed by
drowning depth and masonry queries cannot see it — for a route from `(0, −196)` to
`(400, 700)` with every gate shut and every footing blocked: it must **fail**. Today it
succeeds through x +1148.

### Phase C — the garrison and the city

**10. Stairs — delete the nine external flights and put the stair inside the tower.** §9.
An internal double flight in every curtain tower, from a ground-level door on the city face,
**1.1 m clear**, published as a `WallStair` with a 4.4 m routable apron at its foot. Plus one
inside each gatehouse block, and zero-rise aprons on the Muro Torto.
*Acceptance:* `Siege.wallReport()` reports **`reachable === runs`**, `source === 'published'`,
**32 stairs**, and every foot routable — re-run the check that found *"two of the nine feet
stopped being routable"* **[SRC]**. And measure the throughput change: `probe-walltraffic.mjs`
should show a relief taking materially longer to arrive, which is the intended effect and not
a regression.

**11. The gatehouse crowns.** §5.4. A `GarrisonBay` on each block at `sillY`; delete the
clip; flanking walks within 0.62 m.
*Acceptance:* `probe-gatebattlement-ds.mjs` reports **two distinct heights** over each block's
merlon line and one over its centreline; `Siege.wallReport()` shows **no station below its own
bay's `masonryTopAt`**; and the station-to-station ray sweep over the Porta Flaminia moves off
`1,512 → 1,512` (today it does not move, correctly, because the walk steps 7.15 m; after this
it must).

**12. The `CityView` seam.** §14.4. Every new accessor added to `Siege`'s `CityView` and
`CitySystem` in one commit with identical field names.
*Acceptance:* a probe calls each accessor through `window.__game` and asserts a non-null,
correctly-shaped answer. `as unknown as` means the compiler will not; something must.

**13. The Campus Martius fabric.** §6. The 466 world metres between the wall and the
Capitoline built to Campus Martius grain and Campus Martius monuments; everything past z 1000
stays as it is.
*Acceptance:* `assertNoFabricOverlaps` and `assertWaysClearOfMonuments` at **0**, with their
`detail` strings naming the population sampled (§14.1's rule about scalars); the pomerium
clear-ground check re-run with **Rome's own** threshold rather than the shared one.

**14. The order of battle and the sun.** §8. Juthungi strengths, the escalade-heavy storm
plan, the narrowed deployment box from task 1.
*Acceptance:* `probe-romewin-ds.mjs` over **twelve seeds** reports a win distribution in which
**both** victory conditions fire at least once, and the storm's route is not exclusively the
footings; `tools/probe-budget.mjs` reports the whole-frame draw count **at or below the 180–213
band the map sits in today**, and the assault camera's triangle count at or below Carthage's
14.45 M.

### The one number that says the redesign worked

> **`probe-footing --only=around`: zero routes from the attacker's deployment box to the
> interior that do not pass a gate or a `footing` bay.** Today there is one; the instrument
> already prints where it starts — *"first open crossing east of the wall: x 1154"* — and from
> x 1304 to the map edge it is 0 blocked cells out of 9 across the wall line and 0 out of 21
> for the whole hundred and sixty metres behind it.
