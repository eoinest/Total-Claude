# Carthage — map specification

**Status: draft 2.** Written at `fbcfe65` for the three agents building the map (terrain and
integration, walls, city fabric). Everything here is a number you can build to. Where the
sources disagree or the archaeology is thin the entry says so **and still gives the number to
use**, because a builder cannot act on "uncertain".

Draft 2 adds: the cubit module the Byrsa quarter is actually laid out on (§7.1, read off the
excavation plan); the excavated 125 m admiralty island, against the 130 m draft 1 derived (§6.2);
Appian's sixty steps verified (§5.2); the forum (§7.6) and the Megara (§7.7); and
`reference/carthage/`, 15 licence-verified files catalogued in `ASSETS.md`.

This is the counterpart to `src/city/rome.ts` + `src/city/layout.ts`. Read those two first if
you have not: this document deliberately reuses their idioms — a survey in real metres, an
anisotropic affine projection onto the battlefield, and cited dimensions — so that Carthage is
falsifiable in the same way Rome is.

---

## 0. How to read this

Every dimension carries a tag:

| tag | means |
|---|---|
| **[A]** | Appian, *Punica* (*Libyca*), Horace White tr. His source for the city description is lost Polybius, who saw Carthage in person and was present at the siege. His numbers for the wall are famously large; see §4.6. |
| **[ARCH]** | Excavated. Named dig where known. |
| **[MOD]** | Modern scholarly consensus or a measurement off modern topography/aerial imagery. |
| **[DER]** | Derived here by arithmetic from other entries. The arithmetic is shown. |
| **[GAME]** | A game decision with no ancient authority. Called out every time so nobody later cites us to ourselves. |

**Units.** All real-world dimensions are metres. All elevations are **metres above ancient mean
sea level**; if the terrain profile needs a non-negative sea bed, add one constant offset to
everything in §3 *including* `waterLevel`, and say so in the profile.

**Ancient units used in conversion.** Attic/Roman foot 0.296 m; Attic cubit 0.444 m; Punic cubit
c. 0.515 m; stade 185 m. Where a cubit choice changes the answer materially, both are given.

---

## 1. The moment: spring 146 BC

**Hold everything to 146 BC**, the fourth year of the Third Punic War and the final assault under
P. Cornelius Scipio Aemilianus.

Why this year and not another:

- **It is the only moment when both of the map's two attack routes exist at once.** In 149 BC the
  triple wall is intact and Manilius breaks himself on it, but there is no Roman lodgement
  anywhere near the harbour. In 147 BC Scipio has Megara and the blockade but not the quay. In
  spring 146 the triple wall is *still unbreached* on the isthmus — Scipio never took it — while
  the Romans hold the harbour quay and are one push from the cothon. An attacker on this map can
  therefore choose the front the Romans failed at or the flank they succeeded at, and both are
  period-correct on the same day. §8 is built on that.
- **The 147 BC siege works are on the ground and they are good props**: Scipio's mole across the
  harbour mouth, the Carthaginians' answering channel cut to the open sea, and the Roman brick
  quay-fort. [A] All three are attacker assets or defender escapes and all three are gone from a
  149 BC map.
- **The street fight is the payoff.** Appian's six days and nights from the forum up the three
  streets to the Byrsa, houses six storeys high, Romans crossing roof to roof on planks. [A] That
  fight only happens in 146.

**What 146 BC costs us, stated plainly.**

- **There are no Carthaginian war elephants in this battle, and there cannot be.** The 201 BC
  peace forbade Carthage to train them; in 149 BC the city surrendered its arms wholesale before
  refusing to abandon the site. The elephant stalls inside the wall (§4.4) are **fourth- or
  third-century architecture standing empty in 146** — which is not a problem, it is a detail: a
  wall built for an empire, held by a city that no longer has one.
- The shipped Carthage roster in `src/units/roster.ts` is dated **218–202 BC** by its own header
  comment and fields war elephants. Nothing needs changing. The engine already lets any army
  fight on any map, and a 218 BC Punic army defending its own walls is a perfectly ordinary Total
  War counterfactual. If the elephants are on the field, the stalls are period dressing for
  *them*. **Do not renumber the roster to suit the map, and do not renumber the map to suit the
  roster.** State the map's year in the blurb and let the player make the anachronism if they
  want it.

**Map metadata to register.**

| field | value | note |
|---|---|---|
| `MapId` | `'carthage'` | add to the union in `src/maps/types.ts` |
| `label` | Carthage | |
| `subtitle` | The Byrsa, spring 146 BC | |
| `blurb` | Three walls, a ditch and a citadel on a peninsula, with the sea at the defender's back and no road out. | one sentence, per `MapDefinition` |
| `site.latitudeDeg` | **36.85** | Byrsa, 36.8528 N [MOD] |
| `site.declinationDeg` | **+13** | late April [GAME] — see below |
| `site.season` | Spring, the last assault | |
| `sky.defaultHour` | **16.5** | see below |
| `terrain.waterLevel` | sea level; §3 | |
| `terrain.hasRiver` | **true** | not a river — the Gulf of Tunis, the Lake of Tunis and a sebkha. `RiverWater` or a variant has to render a large still surface, which is a different job from the Tiber. Budget for it. |
| `hidesCity` | **false** | Carthage needs its own city build, so `CitySystem` has to become map-aware. This is the `main.ts` line the Pydna handoff already flagged. |

*On the sun.* Latitude 36.85 with declination +13 puts the noon sun at 66° altitude — 32° higher
than Rome's November noon and far flatter. `docs/VISUAL-RUBRIC.md` and the blind-deck record both
say relief is load-bearing, so **do not ship a noon default**. Open at **16:30** (sun ~30°,
bearing WSW — straight down the attacker's approach and straight into the outer face of the
triple wall, which is the one surface the whole map is about). A 08:00 preset back-lights the
wall and rakes the Byrsa's west scarp; that is the second-best hour and worth having.

---

## 2. The frame, and the projection

### 2.1 What the engine fixes and we cannot move

From `src/maps/types.ts` and `src/sim/scenario.ts`, verified in the tree at `fbcfe65`:

| constant | value | consequence for Carthage |
|---|---|---|
| `HALF_EXTENT` | **1400 m** | the world is 2800 × 2800 m and this is read at module-evaluation time by `src/city/*`, `src/ai/Pathfinding.ts` and `src/ui/Minimap.ts`. It does not change. |
| attacker deployment | **z ≈ −190** | `germZ = -190` in `scenario.ts` |
| defender deployment | **z ≈ +130** | `romanZ = 130` |
| battlefield proper | **z < 250 must stay clear** | no city, no slope, no water inside that |

So the map moves the world under a fixed order of battle. −Z is the attacker's side; +Z is the
city. That is a *direction*, not a compass bearing, and Carthage uses it differently from Rome.

### 2.2 Compass orientation of the map

**Map −Z = true west. Map +Z = true east. Map +X = true north. Map −X = true south.**

Rome's map has −Z = north. Carthage's is rotated 90° anticlockwise from that, and it has to be:
the only land approach to Carthage is from the **west**, across the isthmus, and that approach
must lie along −Z where the attacker deploys. Consequences you get for free:

- the Gulf of Tunis is the **+Z map edge** — the defender's back is against the sea;
- the Lake of Tunis is the **−X (south) edge**, and the Taenia sandspit runs along it;
- the Sebkhet Ariana salt flat is the **+X (north) edge**;
- **the wall's two ends both die on water.** There is no flank march on this map.

### 2.3 Survey origin and the projection

Follow `rome.ts` exactly: author positions in **real metres from a fixed monument** and compute
the battlefield coordinates. Getting Carthage wrong should require getting the survey wrong.

```
Origin: the summit of the Byrsa, 36.8528 N, 10.3233 E   [MOD]
  e = metres EAST of the origin
  n = metres NORTH of the origin
  111,132 m per degree of latitude
   89,100 m per degree of longitude at 36.85 N   (111,320 · cos 36.8528°)

Projection (the Carthaginian analogue of worldOf):
  x = KN · n            KN = 0.45      (across the map — true north)
  z = Z0 + KE · e       KE = 0.22 ,  Z0 = 945    (into the map — true east)
```

**Why those two numbers.**

- `KE = 0.22` is not a taste decision, it is the largest value that fits the whole city between
  the wall and the sea inside the map. The triple wall must sit forward enough that the attacker
  gets a real approach (the crest lands at z ≈ 494–615, so ~640 m of open ground from the
  deployment box — Rome's is ~620, so the two maps read at the same tempo), and the coastline
  must land inside z = 1374 with visible water behind it. The city is 2.95 km deep west-to-east
  and the budget is 650 world metres. It also happens to be **exactly Rome's `KZ`**, which means
  the two maps compress depth identically and a player's sense of distance transfers.
- `KN = 0.45` is set by the wall: the isthmus front is 4.43 km of real wall (§4.1) and it has to
  fit across a 2800 m map with both ends on water and some lagoon showing beyond each. 0.45 puts
  it at 1,984 world metres. It is also **within 1.5 % of Rome's `KX` (0.443)**.
- Anisotropy is therefore **2.05×**, against Rome's 2.00×. The two cities are distorted the same
  way by the same amount. Nobody has to learn a second mental correction.

### 2.4 The rule that stops this going wrong

**Positions compress. Cross-sections do not.**

`rome.ts` already works this way and nobody wrote it down: a monument's *position* goes through
the affine map, its *height* does not, and its *plan footprint* takes a separate `PLAN_SCALE`.
For Carthage, state it up front:

- **Compressed** (through `KN`/`KE`): every position; the length of the wall along its own line;
  the extent of a district; the plan of the harbours; the footprint of the Byrsa hill.
- **Not compressed** (true metres in world space): wall height, wall thickness, ditch width and
  depth, tower height and footprint and spacing, street widths, storey heights, insula
  dimensions, ship-shed dimensions, the height of the Byrsa above the lower town.

Concretely: the wall is 4,434 real metres long and 1,984 world metres long, but it is 9.1 metres
thick in both. Towers stand 59.2 world metres apart because that is the real interval, which
means the modelled stretch carries 33 towers where the real wall carried 75. That is exactly what
Rome does with `WALL.towerSpacing = 35.5`.

**And there is a third category, which is where this rule bites.** Anything whose *slope* matters
cannot take a compressed run against an uncompressed height, because the gradient comes out
wrong by the compression factor. There are exactly two such things on this map and both are
overridden explicitly:

- **the Byrsa** — §5.1a; the projection gives it a 30° face against a real 1:7, so its world
  footprint is set from the gradient instead. Rome already does this: `RISE_RUN = 175` is a
  chosen world number, not a projected one;
- **open spaces that have to be fought in** — the forum, the harbour quays, the wall's killing
  ground — which take world dimensions directly (§7.6), because a projected 180 × 120 m agora
  comes out 81 × 26 and is a corridor.

If you find a third case, add it here rather than quietly bending the projection.

**Plan scale for monuments.** Rome uses `PLAN_SCALE = 0.65` because a 1:1 building in a 10×-
compressed plan eats the city. Carthage's monumental load is far lighter (there is no Colosseum,
no Circus, no imperial baths — Punic Carthage's largest single structures are the harbours and
the Byrsa's temple platform) but the harbours are enormous. Recommend **`PLAN_SCALE = 0.80` for
Punic monuments**, and **1.00 (unscaled) for the two harbour basins**, which are landscape
features, not buildings, and are already compressed as areas by the projection — the same
exemption `rome.ts` gives to `soft` entries.

### 2.5 The survey — key positions

Longitude/latitude are modern site coordinates [MOD]; the ancient shoreline differs (§3.2).

| feature | e | n | **x** | **z** | source |
|---|---:|---:|---:|---:|---|
| Byrsa summit (origin) | 0 | 0 | **0** | **945** | 36.8528 N 10.3233 E |
| Triple wall, north anchor (Sebkhet Ariana) | −2050 | +2250 | **+1013** | **494** | reconstructed, §4.1 |
| Triple wall, at the Byrsa's latitude | −1900 | 0 | **0** | **527** | reconstructed |
| Triple wall, south anchor (head of the Lake of Tunis) | −1500 | −2150 | **−968** | **615** | reconstructed |
| Rectangular (commercial) harbour, centre | +125 | −1200 | **−540** | **973** | 36.8420 N 10.3247 E |
| Circular (naval) harbour, centre | +178 | −1489 | **−670** | **984** | 36.8394 N 10.3253 E |
| Tophet of Salammbô | −71 | −1645 | **−740** | **929** | 36.8380 N 10.3225 E |
| Harbour channel mouth (to the sea) | +600 | −1750 | **−788** | **1077** | reconstructed, §6.4 |
| Odeon / north ridge crest | +419 | +467 | **+210** | **1037** | 36.8570 N 10.3280 E |
| Forum / agora (§7.6) | +250 | −400 | **−180** | **1000** | position debated; §7.6 places it at x −290 for room |
| Bordj Djedid shore (Antonine Baths site) | +731 | +556 | **+250** | **1106** | 36.8578 N 10.3315 E |
| La Malga (inside the wall, W of Byrsa) | −713 | +222 | **+100** | **788** | 36.8548 N 10.3153 E |
| East shore at the Byrsa's latitude | +1050 | 0 | **0** | **1176** | [MOD] |
| Lake of Tunis, north shore | −600 | −2400 | **−1080** | **813** | [MOD] |
| Sebkhet Ariana, south edge | −1800 | +2450 | **+1103** | **549** | [MOD] |

Sanity checks that must hold after you build:

- attacker deployment (z −190) to the ditch lip (z ≈ 452 at mid-wall) = **642 m of approach**;
- wall (z 527) to Byrsa summit (z 945) = **418 m** of city depth on the main axis;
- Byrsa (z 945) to the shore (z 1176) = **231 m**, then **~200 m of open sea** to the map edge;
- modelled wall length **1,984 m** against Rome's 1,781 m (`WALL_X_MAX − WALL_X_MIN`, computed at
  `fbcfe65`: 1150 − (−631)). Rome's wall costs 216 draw calls. Carthage's is 12 % longer, three
  walls deep and casemated. **Budget for it early; this is the map's largest single risk.**

---

## 3. The ground

An attacker's options are set here before any wall exists, and Carthage's ground is the opposite
of Rome's in the one way that matters.

### 3.1 The headline

**At Rome the wall stands on a hill. At Carthage it stands on nothing.** Aurelian's curtain sits
on a 22–34 m rise (`riseAmplitude` in `topography.ts`) so an attacker climbs 175 m of slope under
fire before he reaches 6.5 m of masonry. The Carthaginian isthmus is a low, flat neck; the triple
wall has **no terrain advantage whatever** and carries all of its defence in stone. Which is
precisely why it is 16 m tall behind a 20 m ditch.

Do not "improve" this by putting the wall on a ridge. The flatness is the design.

### 3.2 The peninsula

Carthage occupies a promontory with the Gulf of Tunis east, the Lake of Tunis south-west, and the
Sebkhet Ariana (a salt flat) north-west. Land reaches it only from the west.

| feature | value | tag |
|---|---|---|
| Isthmus width | **4.0–4.8 km**. Appian's figure is rendered "about three miles" in White's translation, i.e. 25 stades ≈ 4.6 km. **Use 4.43 km**, which is what the modelled wall line in §4.1 measures — so the source and the build agree by construction. | [A] [MOD] |
| Peninsula circumference | 360 stades ≈ 66 km (Strabo) — includes the whole headland out to Sidi Bou Saïd, not the city | [MOD] |
| Punic urban area | **> 300 ha** (Tlatli); the walled circuit enclosed far more, including the Megara garden suburb | [ARCH] |
| Total wall circuit | 33–37 km is quoted, from Livy/Orosius' "23 miles". **Treat as unreliable.** A 315 ha core has a 6–7 km perimeter; the large figure can only describe a perimeter round the entire peninsula. Model what the map contains and ignore the number. | [MOD] |

### 3.3 Elevations, metres above ancient mean sea level

| where | elevation | tag |
|---|---|---|
| Sea, Lake of Tunis | **0** | |
| Sebkhet Ariana | **0 to +1**, a salt pan, not open water | [MOD] |
| Isthmus plain, outside the wall | **2 at the lagoon margins, crowning to 12 along the spine** | [GAME] from a low sandy/marly neck [MOD] |
| Ground line of the triple wall | **10–14** | [GAME] |
| Harbour district and the Taenia | **2–6** | [MOD] |
| Lower town / the forum flat between the harbours and the Byrsa | **12–18** | [MOD] |
| **Byrsa summit** | **60** | [MOD]; see §5 for the 50/57/60 spread |
| Odeon / north ridge (toward Bordj Djedid) | **40–50** | [MOD] |
| Sidi Bou Saïd headland | **100**, off-map to the east | [MOD] |

**So the Byrsa stands ~45 m above the lower town.** That is the single most important elevation
on the map and §5 spends it.

### 3.4 Ground conditions — the constraint that shapes a siege train

**Within ~300 real metres of the Lake of Tunis and the Sebkhet Ariana the ground is soft** — sabkha
margin, salt marsh and silt. [MOD] [GAME as a mechanic]

Recommendation: mark those margins in the control texture as a **`soft` channel** and have it
(a) halve movement speed for wheeled engines, (b) forbid engine placement entirely within 150
world metres of either water, and (c) render as cracked salt crust with standing brine in the
lows. Consequence: **rams, towers and heavy artillery must go up the middle of the isthmus,
where the wall is strongest and where the defender knows they must come.** Infantry can still work
the margins. That is a real decision handed to the attacker on turn one and Rome has nothing like
it.

The Sebkhet Ariana is a **seasonal** pan: dry crust in summer, impassable mud in winter. In
spring 146 call it **firm enough to walk, too soft for engines** — which is the interesting
setting and is defensible for late April.

### 3.5 The Taenia — the flank route

Appian's *taenia* ("ribbon") or *ligula*: the tongue of land between the Lake of Tunis and the
sea, running from the isthmus east toward La Goulette. [A] Censorinus assaulted along it in 149
BC. Appian names the angle where the triple wall meets it and runs on toward the harbour as
**"the only weak and low spot in the fortifications, having been neglected from the beginning."**
[A] That sentence is this map's second act.

| property | value | tag |
|---|---|---|
| Appian's width | **"about 300 feet wide"** ≈ **89 m** (White's tr., verified against Perseus) | [A] — but see below |
| Real neck south of the harbours | **~1,150 m** between lake and sea | [MOD] |
| **Modelled usable ground** between the lake shore and the south wall | **200–300 world m** (≈ 450–670 real m), narrowing to **~130 world m** at the map's −X/−Z corner | [GAME] |

Appian's 300 feet and the modern 1.1 km cannot both describe the same cross-section; the
300-foot figure is almost certainly the Catadas channel neck at what is now La Goulette, which is
off-map to the south. Use the modelled figures. They are chosen so the corridor takes a legion in
column and a battery, but **not a line of battle** — a 320-man cohort at the sim's 0.72 m pitch is
~35 m wide in line, so 200 m of corridor holds five cohorts abreast at most, with a lake on one
flank and a wall on the other and nowhere to go.

**On the map:** the Taenia enters at the **−X edge around z 300–500** and runs in +z along
x ≈ −1100 to −1400, meeting the harbour district around z 850–950.

### 3.6 The coastline

Author the shore as a polyline in the survey frame and let the projection place it. Points
measured off the modern coast [MOD]; note the ancient shoreline was somewhat further west in the
harbour quarter (the ports have silted and the land has prograded), which is why the harbour
channel in §6.4 is short.

| n | e (shore) | → x | → z |
|---:|---:|---:|---:|
| −2400 | +250 | −1080 | 1000 |
| −1750 | +600 | −788 | 1077 |
| −1200 | +775 | −540 | 1116 |
| −600 | +900 | −270 | 1143 |
| 0 | +1050 | 0 | 1176 |
| +556 | +1400 | +250 | 1253 |
| +1200 | +1755 | +540 | 1331 |

That last row is 43 m from the map edge, so the coast leaves the map to the north-east — correct,
because the peninsula continues to Sidi Bou Saïd. The open sea occupies the +Z corner and the
whole north-east of the map beyond the shore.

---

## 4. The triple wall

This is why the map is worth building. Build it first.

### 4.1 The line

| | value |
|---|---|
| Real length across the isthmus | **4,434 m** (from the survey polyline in §2.5) |
| Modelled length | **1,984 world m** |
| Modelled bearing | runs from (x +1013, z 494) through (x 0, z 527) to (x −968, z 615) — leaning so the south end sits **121 m deeper** into the map |
| North anchor | the Sebkhet Ariana shore |
| South anchor | the head of the Lake of Tunis |
| Archaeological status of the line | **not located.** Excavation has identified rampart remains on the *seaward* side, between the Bay of Kram and Bordj Djedid, but the isthmus line is under modern suburbs and is a reconstruction. Uncertainty on its distance from the Byrsa is **±400 m real** (±90 world m in z). |

Build the line with a slight bow (convex toward the attacker, sagitta ~25 world m) rather than
dead straight. It gives every bay a flanking angle onto its neighbours and it stops the wall
reading as an extruded rectangle at the strategic camera, which is the failure mode the blind
deck already names for our architecture.

### 4.2 The arrangement, front to back

Appian says only "a triple wall … the height of each 30 cubits (45 ft) without counting parapets
and towers … the depth 30 ft" [A], which read flat would give three identical 13.7 m curtains and
is not credible. The modern reading — Lancel, Goldsworthy, Miles — is a **stepped system** in which
each line is lower than the one behind it, so all three can be fought from at once and the main
wall dominates everything in front of it. Build that.

Distances are the clear gap between the works; cross-sections are **true metres, uncompressed**.

| # | element | width | height | tag |
|---|---|---|---|---|
| 0 | **Ditch**, dry, V-profile with a 2 m flat bottom | **20.0 m** | **6.0 m** deep | [MOD]; Appian's tradition gives 60 ft ≈ 17.8 m, Goldsworthy 20 m |
| 1 | **Berm** between the ditch's inner lip and the outwork | 5.0 m | — | [GAME] |
| 2 | **Outer work** — earth-and-rubble rampart, stone-revetted on the ditch face, timber palisade on the crest | 6.0 m at the crest | **4.0 m** above the berm, **10.0 m** above the ditch bottom; palisade +1.8 m | [MOD] |
| 3 | Gap | **12.0 m** | — | [GAME] |
| 4 | **Middle wall** — plain ashlar, no casemates, no towers, occasional low turrets | **4.0 m** thick | **8.0 m** to the walk, **9.8 m** to the merlons | [GAME], stepped between 2 and 5 |
| 5 | **Killing ground** | **18.0 m** | — | [GAME] |
| 6 | **Main wall** — the casemated wall, §4.3 | **9.1 m** thick | **13.7 m** to the walk, **15.9 m** to the merlons | [A] |
| 7 | **Military way** behind it | **35.0 m** clear | — | [GAME], §7.5 |
| | **Total from ditch lip to the first building** | **109.1 m**, of which **74.1 m** is the defensive belt | | [DER] |

Compare Rome: one 6.0 m curtain (`CURTAIN_T` in `wall.ts`), 6.5 m to the walk, no modelled ditch,
60 m pomerium. **Carthage is 12× the defensive depth and 2.4× the height.** Say that number out
loud in the menu blurb; it is the map.

### 4.3 The main wall — dimensions

| property | value | tag |
|---|---|---|
| Height to the wall-walk | **13.7 m** | [A] 30 cubits / 45 ft. At the Punic cubit of 0.515 m it is 15.5 m; **use 13.7** and note that a builder wanting more presence may take 15.5 with a citation. |
| Thickness | **9.1 m** | [A] 30 ft. Goldsworthy rounds to 9 m. |
| Parapet height above the walk | **2.2 m** | [GAME], scaled from Rome's 2.05 |
| Parapet thickness | **1.2 m** | [GAME] |
| **Clear standing band on the walk** | **9.1 − 1.2 (outer parapet) − 0.8 (inner kerb) = 7.1 m** | [DER] |
| Face batter | 1 in 25 | [GAME] |
| Construction | large dressed ashlar in header-and-stretcher, sandstone/limestone, on a rock-cut or rubble footing; internal fill rubble-and-mortar. Not brick — the "brick-built wall" in some secondary accounts is a mistranslation of the mud-brick superstructures Punic fortification uses *elsewhere*. Ashlar face, and the Punic pier-and-panel technique (`opus africanum`: upright ashlar piers with rubble panels between) is the right idiom for anything secondary. | [ARCH] [MOD] |

**The 7.1 m clear walk is the single most important consequence of Appian's thickness**, and it is
the wall workstream's headline. Rome's widened curtain gives a 2.21–4.06 m band — 4–6 ranks at the
sim's 0.72 m pitch. Carthage gives **9 ranks**, or four ranks plus a mounted messenger, or a
scorpion with its crew and a file passing behind it. The Carthaginian wall-walk is a *street*.

### 4.4 The casemates — **yes, they are enterable**

Appian, on the main wall: each wall was divided vertically by **two vaults, one above the other**;
the lower held **stables for 300 elephants** with their fodder stores alongside; the upper held
**stables for 4,000 horses** with fodder and grain; and there were **barracks for 20,000 foot and
4,000 horse**. [A]

**Make the lower level a fully enterable interior.** This is the recommendation and it is not
close. A wall a player's men can be *inside* is a different tactical object from one they stand on
top of, and no other city in this game has one.

**The arithmetic says the elephants are real.**

```
wall length (real)                        4,434 m
thickness                                     9.1 m
outer face 1.5 m + inner face 1.2 m  →  internal clear span 6.4 m
internal floor area per level        4,434 × 6.4 = 28,378 m²
300 elephants in 28,378 m²                   = 94 m² each
an elephant needs roughly                      10–15 m²
```

The lower vault holds 300 elephants at six times the space they need, which leaves ample room for
the fodder magazines Appian puts "alongside". One stall every **14.8 m of wall** [DER]. That is an
internally consistent description, and internal consistency is the strongest evidence we have that
Polybius was describing something he had walked through.

**The arithmetic says the barracks are not.**

```
upper level                              28,378 m²
4,000 horses at ~4 m² each             = 16,000 m²
remaining for 24,000 men               = 12,378 m²  →  0.52 m² per man
```

Half a square metre per soldier is not a barracks, it is a crowd. **Do not model the upper level
as a dormitory for 24,000.** Either the 24,000 are the wall's *garrison establishment* quartered
partly in rear ranges and in the towers, or the figure is Appian's inflation. Build the upper
level as what it plausibly was: **a fighting gallery** — a continuous vaulted corridor with
loopholes through the outer face, guardrooms at the tower bases, ready-magazines, and *some*
stabling and bunk ranges as dressing.

**Built dimensions to hand the wall agent.**

| property | value | tag |
|---|---|---|
| Internal clear span (both levels) | **6.4 m** | [DER] |
| Lower vault, clear height to the crown | **4.6 m** | [GAME] — an African forest elephant with a mahout needs 4 m+ |
| Floor slab / vault between levels | **1.0 m** | [GAME] |
| Upper vault, clear height | **3.6 m** | [GAME] |
| Slab under the wall-walk | **1.0 m** | [GAME] |
| Sum | 4.6 + 1.0 + 3.6 + 1.0 = **10.2 m**, leaving **3.5 m** of solid footing below the lower floor | [DER] — consistent with 13.7 m to the walk |
| Elephant stall pitch | **14.8 m real**; in world metres the wall is 2.23× shorter, so model a stall every **6.6 world m** or thin them to every other bay and say so | [DER] |
| Access from the city side | **stair-and-ramp blocks in the inner face at every second tower**, i.e. every **118 world m**; ramp gradient 1:6 so an elephant or a handcart can use it | [GAME] |
| Access to the wall-walk | inner-face stairs **parallel to the face**, per the fix already landed for Rome's wall (nine flights, 14.2–20.4 m along the face). Reuse that geometry. | |
| Vault lighting | loopholes at 3.5 m centres in the outer face of the upper level; the lower level is lit only from the inner face and from the stair wells, i.e. **it is dark**. Say so to the lighting workstream. | [GAME] |

**Passability.** The casemate corridor must be in the nav mesh at both levels, and it must be a
**one-file-plus-passing** corridor: 6.4 m of span at 0.72 m pitch is 8 men abreast, which is a
formation, not a queue. Cap it lower if it plays too easily — 8 abreast inside a wall is a very
strong defensive position — but start at the real number.

### 4.5 Towers and gates

| property | value | tag |
|---|---|---|
| Interval | **59.2 m** (200 ft at 0.296 m). At the Punic foot it is 61 m. | [A] |
| Count on the modelled stretch | **33** (1,984 / 59.2 = 33.5). The real 4.43 km wall carried **75**. | [DER] |
| Storeys | **four** | [A] |
| Height to the top storey's walk | **20.0 m** | [DER]: four storeys at ~4.2 m clear plus slabs |
| Height to the merlons | **22.5 m** | [DER] |
| Footprint | **11.0 × 11.0 m** | [GAME] |
| Projection beyond the outer face | **5.5 m** | [GAME] |
| Internal | ground storey opens into the lower casemate; second into the upper gallery; third is level with the wall-walk and gates it; fourth is the fighting top, roofed, with a bolt-shooter | [GAME], consistent with [A] |

Rome's towers stand 13.8 m and there are 50 of them across 1,781 m. **Carthage has fewer, far
bigger towers**: 33 at 22.5 m. Silhouette that difference deliberately — Rome's wall reads as a
serrated line, Carthage's as a row of keeps joined by a rampart.

**Gates.** No ancient source gives a gate count for the land wall and none has been excavated.
Recommendation, **[GAME] throughout**, three in the triple wall:

| gate | world position | serves | note |
|---|---|---|---|
| **Porta Byrsae** (main) | x ≈ **0**, z ≈ **527** | the road from Tunis and the isthmus, running straight to the forum and the Byrsa | the only gate a ram can reach across firm ground. Model it as Rome's Porta Flaminia is modelled — **shut at build time**, with a drawbar; the siege system opens it. |
| **Porta Uticensis** (north) | x ≈ **+560**, z ≈ **510** | the Utica road and the Megara | on ground that turns soft 200 m short of it |
| **Porta Maritima** (south) | x ≈ **−760**, z ≈ **595** | the Taenia and the harbour road | **this is the weak angle.** Set it where the triple wall gives way to the single south wall. |

Each gate must pass **all three** lines — so a gate is not a door, it is a **90 m tunnel through
the whole belt**: a causeway over the ditch (make it a timber bridge the defender can fire, [GAME]),
a gap in the outwork offset laterally by 8 m from the gap in the middle wall, and then the main
gate itself. **Offset the three openings so a ram cannot see daylight through them.** That single
decision is worth more to this map than any texture.

Additionally, **archaeologically attested and not in the triple wall**: a **sea gate** in the
Magon quarter on the east shore, with a **9 m street** running to it. [ARCH] Put it at
x ≈ +150, z ≈ 1200.

### 4.6 What is Appian and what is not — read this before you cite anything

Appian wrote in the second century AD, ~300 years after the event, from a source generally taken
to be Polybius, who was *there*. That makes the description first-rate by ancient standards and
still not archaeology.

**Load-bearing and probably sound:** the triple arrangement; the two-level casemate; elephant
stabling in the lower level; towers at 200 ft in four storeys; the harbour entrance of 70 ft with
chains; the island with the admiral's house; the Ionic columns; the weak angle by the harbour;
the three streets and the six days.

**Load-bearing and probably inflated:** 20,000 foot and 4,000 horse barracked *in the wall*
(§4.4 shows why); 220 ships in the sheds where archaeology finds capacity for 160–170 (§6.3); the
33–37 km circuit.

**Not located by archaeology at all:** the line of the triple wall on the isthmus; the ditch; the
gates; the tower plan. Every one of those is a reconstruction here and is tagged as such.

**Found by archaeology and *not* in Appian:** the seaward rampart between the Bay of Kram and
Bordj Djedid; the Magon-quarter sea gate and its 9 m approach street; the Byrsa's Hannibalic
housing grid; the harbour slipways.

---

## 5. The Byrsa

### 5.1 The hill

| property | value | tag |
|---|---|---|
| Summit elevation | **60 m** a.s.l. | [MOD]. Published values run 50 / 57 / 60. Wikipedia gives ~50 with Sidi Bou Saïd "twice as high"; the 1911 Britannica gives 195 ft = 59.4 m; guidebooks give 57. **Use 60** — it is inside the range, it is the roundest, and every metre of it is gameplay. |
| Lower town at its foot | **12–18 m** | [MOD] |
| **Relief above the lower town** | **~45 m** | [DER] |
| Summit plateau (Punic, before Roman truncation) | **250 × 180 m real** | [MOD] [GAME] — the Romans cut several metres off the top to build the forum platform (320 × 160 m), so the Punic summit was **higher and smaller** than what is there today. The section drawing labels the operation *arasement du sommet*. |
| Hill footprint at the 20 m contour, real | **~700 m E–W × 550 m N–S** | [MOD] |
| **Hill footprint at the 20 m contour, world — do NOT take this from the projection** | **340 m in x × 200 m in z** | [GAME], and read the next subsection before you build it |
| South-east slope, real | **1:7, 14 %** | [ARCH] Lancel |
| **South-east slope, as built** | **1:3.8, 26 %** | [DER], see below |
| North and west slopes | steeper still and partly scarped; cap them at **1:2** so they stay climbable in loose order | [GAME] |

### 5.1a The one place the projection must be overridden, and the arithmetic that says so

**Heights are not compressed and positions are, so every slope on this map comes out steeper than
it really was.** On the Byrsa that stops being a stylistic issue and becomes a bug. Run the real
hill through §2.3 and you get:

```
real footprint at the 20 m contour   700 m (E–W)  ×  550 m (N–S)
projected                            0.22·700 = 154 m in z   ,  0.45·550 = 248 m in x
relief, uncompressed                 45 m
resulting gradient into z            45 / 77   = 1 : 1.7   (30°)
resulting gradient across x          45 / 124  = 1 : 2.8   (20°)
the real gradients                             1 : 7.8  and  1 : 6.1
```

A 30° face is a cliff. The three streets would be unbuildable, the housing terraces would
interpenetrate, and the whole point of §5.3 would be lost.

**Fix: set the Byrsa's world footprint from the gradient you want, not from the projection.**
This is not a special case — it is exactly what `topography.ts` already does at Rome, where
`RISE_RUN = 175` is a *chosen world number* with the comment "short enough to read as a hill
front", not a projected one. State the same thing here.

Recommended: **340 m in x by 200 m in z at the 20 m contour**, which puts the built south-east
face at **170 world m of run for 45 m of rise = 1:3.8**. That is 1.8× steeper than the real
1:7 — the same order of distortion Rome accepts on its own rise — and it is a slope three
stepped streets can climb and terraced housing can sit on.

**Do not compress the 45 m.** Heights are not compressed (§2.4) and this one is the reason to
come.

### 5.2 What stood on it

| structure | note | tag |
|---|---|---|
| **Temple of Eshmun** (Gk. Asklepios, Lat. Aesculapius) | **verified.** Appian: it stood "in a place of great height and rocky nature", was **reached in peacetime by an ascent of sixty steps**, and was "much the richest and most renowned" temple of the citadel. Hasdrubal, his wife, their two boys and the **900 Roman deserters** made the last stand here on the **seventh day** and burned it over themselves. | [A] |
| **The sixty steps** | build them. At a 0.19 m rise per step that is **11.4 m of climb** on the final approach, above the 45 m the streets have already done. Make it the last chokepoint on the map: **9 m wide**, no engines, no horses. | [A] + [DER] |
| **Citadel enceinte** | a wall round the summit plateau, separate from the city wall. No dimensions survive. Recommend **4.5 m high, 2.5 m thick, with a single gate on the south-east where the three streets arrive.** | [GAME] |
| **The Hannibalic quarter** | dense housing on the **south-east slope**, not on the summit — §7 | [ARCH] |

**The stratigraphy of the south slope**, from the published section (`reference/carthage/
plan-byrsa-hill-section.png`, CC0), because it tells you what the slope *is*: a Punic necropolis
lowest, **metalworkers' workshops** above it, then the **ground floors of the apartment blocks**,
and over the lot the Roman forum platform and the levelled summit. In 146 the slope is
**housing over industry**. Put smithies, slag, kilns and workshop yards into the lower quarter
rather than making the whole hill residential — it dresses the fight and it is evidenced.

### 5.3 The approach, and why it matters

**Appian: three streets ran up from the forum to the Byrsa, lined on both sides with houses six
storeys high, and it took the Romans six days and nights to get up them.** [A]

Build exactly that:

- **Three streets**, not one, from the forum flat to the citadel gate. They run up the hill's
  **south-east face**, i.e. predominantly in **+x** on this map (from the forum at x ≈ −290 to the
  summit at x = 0), which is the map's **less compressed axis** — a piece of luck from the
  orientation choice in §2.2 and worth checking rather than assuming. Each street is
  **~170 world m long** and gains 45 m.
- Each **6.0 m wide** [ARCH] and **stepped**, because even the real 14 % could not be walked in
  formation and the built 26 % certainly cannot. Give them **treads of 1.2 m and risers of
  0.17 m** in flights of 8–12 with landings.
- **Wheeled traffic and every siege engine is excluded from all three.** There is no way to get a
  ram to the citadel gate. That is a historical fact and a superb constraint.
- Formation coherence must break on a stepped street. A cohort going up the Byrsa should arrive
  as a mob, and the defender's job is to be waiting at the top of it.

The fourth approach — round the north, up the steep scarp — should be **passable to infantry in
loose order only** and cost heavily in cohesion. Give the player the choice.

---

## 6. The harbours

### 6.1 Can a land battle meaningfully reach them?

**Yes, and the whole second half of the map is there.** Appian is explicit: the Romans took the
quay, then unexpectedly got onto the ring of the circular harbour, and from there Scipio seized
the forum. [A] The harbours are not scenery; they are the route to the Byrsa.

### 6.2 Dimensions

| element | value | tag |
|---|---|---|
| **Rectangular (commercial) basin** | **400 × 150 m** of water, long axis roughly N–S; 6.0 ha | [ARCH] [MOD]. Note the conflict: the French Wikipedia summary of the excavations gives the circular basin ~8 ha and the rectangular "about twice as large" (~16 ha), and the 1911 Britannica gives the commercial harbour "nearly 60 acres" (24 ha). **The 8 ha for the circular basin checks out exactly against its 325 m diameter, so that figure is the water; the larger rectangular figures must include quays, warehouses and the outer anchorage.** Build 400 × 150 of water and put the difference into the quay belt below. |
| Quay belt round the rectangular basin | **15 m** on the west side excavated; use **15 m west and north, 25 m east** (against the city wall) | [ARCH] |
| **Circular (naval) basin, the cothon** | **325 m outer diameter**, 8.3 ha | [ARCH] Hurst; the lagoon survives at this size |
| **Admiralty island** | **125 m diameter**, an artificial raised platform | [ARCH] Hurst, British Mission, 1970s |
| Annular water between island and ring | **100 m** | [DER] |
| Entrance from the sea | **21 m wide** (Appian's 70 ft), **closable with iron chains** | [A] |
| Water depth in both basins | **2.5–3.0 m** | [MOD] |
| Dating of the built form | **2nd century BC**, i.e. exactly our moment | [ARCH] |

**The island diameter, cross-checked.** This document first *derived* 130 m from the shed counts
before the excavated figure was found, and the excavated figure is **125 m**. The derivation is
kept because it is a useful consistency check on everything else: British excavation found **30
slipways on the island** and **135–140 round the ring**, 160–170 in total, at **5.9 m wide**
[ARCH]. A 125 m island has a 393 m circumference; 30 × 5.9 = 177 m, so the sheds occupy 45 % of
it — consistent with Hurst finding them in discrete blocks rather than a continuous ring. The
325 m ring has a 1,021 m circumference; 138 × 5.9 = 814 m, 80 % of it, leaving ~200 m for the
gate, the channel to the rectangular basin and the ramps. **Every figure in this table is
mutually consistent**, which is unusual for Punic Carthage and worth trusting.

**Warning about the aerial photographs.** In `reference/carthage/aerial-salammbo-ports.jpg` the
island looks like 55–60 % of the lagoon's width, not 125/325 = 38 %. That is modern silting and
landscaping, plus oblique foreshortening. **Build to 125 m, not to the photograph.**

### 6.3 The ship-sheds

| property | value | tag |
|---|---|---|
| Slipway width | **5.9 m** | [ARCH] |
| Slipway gradient | **1:10**, rammed earth | [ARCH] |
| Shed depth | **40 m** | [GAME] — a quinquereme is ~35–40 m |
| Ridge height | **8.5 m** | [GAME] |
| Count | **30 on the island, 138 on the ring, 168 total** | [ARCH]. Appian says the sheds held **220** ships; archaeology gives 160–170. **Model 168 and let the blurb quote Appian's 220.** |
| Frontage | **two Ionic columns in front of every shed**, reading as a continuous portico round the harbour and round the island | [A] |

That portico is the single best-looking thing on this map: a 1 km ring of columns round a circular
lagoon, doubled on the island. It also happens to be a **colonnade a fight can happen in**, which
is a kind of space this project does not currently have.

### 6.4 Connection to the sea, and the 147–146 works

- The sea entrance (21 m, chained) opens into the **rectangular** basin from the south-east.
- The **circular** basin is reached only through a controlled second channel from the rectangular
  one, behind a **double wall with a gate**, so merchants could not see into the naval yard. [A]
  Model that channel at **21 m** as well, with **a gate and a chain**.
- **The island is reached by a single timber-decked causeway, 4.0 m wide, on the north side.**
  [GAME] — flagged loudly. There is no good evidence for a causeway; the ancient accounts imply
  boats. It is here because a 4 m bridge onto a defended island is the best chokepoint on the map
  and because the alternative is that the island is unreachable in a land battle and therefore
  pointless. If the owner would rather be strict, delete the causeway and give the attacker boats.
- **Scipio's mole** [A]: an embankment thrown across the harbour mouth to blockade it. Model it as
  a rubble causeway **25 m wide at the base, 12 m at the top, 3 m above the water**, running from
  the shore across the entrance. It is an attacker asset: it carries men and light engines to the
  harbour front dry-shod.
- **The Carthaginian cut channel** [A]: with the mouth blocked, the Carthaginians dug a **new
  channel from the harbour straight out to the open sea** and sent a new fleet through it. Model
  it on the **east** side of the circular basin, **30 m wide**, freshly cut and unrevetted. It is
  a defender asset (reinforcement and escape by sea) and simultaneously **a 30 m gap in the
  city's own defences** that an attacker can exploit. Nothing else on either map does both.
- **The Roman quay-fort** [A]: on the captured quay the Romans built a brick structure **as high
  as the city wall** from which **4,000 men** shot down onto the ramparts at short range. Model it
  as a timber-and-brick siege platform, **16 m to its fighting deck**, **60 × 20 m** in plan,
  standing on the quay of the rectangular harbour. It is the attacker's answer to a 16 m wall and
  it should be buildable or pre-placed depending on scenario.

---

## 7. Street plan and housing

### 7.1 What is actually known

| finding | value | tag |
|---|---|---|
| **Insula (block) size, Byrsa quarter** | **15.5 × 31 m**, and — read straight off the excavation plan — this is a **module of 30 × 60 Punic cubits**. The plan dimensions block C as `30 coudées` deep by `60 coudées` along the street. At the Punic cubit of 0.515 m that is 15.45 × 30.9 m. | [ARCH] Lancel, from 1982; module verified on `reference/carthage/plan-byrsa-hannibal-quarter.png` |
| **House plot** | the 60-cubit block face is subdivided into **five plots of 12 × 30 cubits = 6.2 × 15.5 m**, some further split front and back into an `a` and a `b` unit | [ARCH], same plan |
| Street width, Byrsa quarter | **5–7 m**; measured off the plan's own scale bar: Rue I **6.2 m**, Rue III **5.4 m**, Rue II (the stepped one) **7.5 m**. Roadway of beaten earth and clay, **unpaved**. | [ARCH] |
| Street gradient on the Byrsa slope | **1:7 (14 %)**, with **in-situ flights of steps** to take up the slope; wheeled traffic impossible | [ARCH] |
| Street width, Magon quarter (seafront) | **~3 m**, with **one exceptional 9 m street** running to the sea gate | [ARCH] |
| Grid | **orthogonal**, laid out deliberately, blocks separated by straight streets | [ARCH] |
| House plan | elongated rectangle, **entrances front and back onto two streets**, side corridor connecting them, small courtyard for light and air, **cistern in the basement**, cesspool, ground-floor room usable as a **shop** on the street | [ARCH] |
| Floors | *pavimenta punica* — grey mortar bedding inlaid with green and yellow pottery shards; the last 50 years of the city | [ARCH] |
| Height | Appian says **six storeys**; excavated walls stand to 3 m and cannot confirm it | [A] / [ARCH] |
| Dating of the excavated quarter | **early 2nd century BC** — our moment | [ARCH] |
| Preservation | survived because the Romans buried it under the forum platform's fill; the Roman foundation piles punch through it | [ARCH] |

### 7.2 Road ranks — Carthage's answer to Rome's 42/24/14/8

**This is where the analogy to Rome breaks, and it breaks hard.**

Rome's `WAY_WIDTH` gives artery 42 / secondary 24 / local 14 / vicus 8 m, and `layout.ts` already
concedes in its own comment that a real Roman *via* is about 4.8 m and 42 is a game compromise so
a 35 m cohort can move. **Carthage has no equivalent of even the honest end of that.** The widest
street anywhere in the excavated Punic city is **9 m**, and it is called out in the literature as
exceptional. The ordinary Punic street is 3–7 m.

So: use narrower ranks than Rome, and accept fewer of them.

| rank | Carthage | Rome | authority |
|---|---|---|---|
| **processional** | **20 m** | 42 m | **[GAME], no Punic evidence at all.** Two of them only: the gate-to-forum road, and the forum's own frontage. This is the game's minimum for a formed unit and it is stated as a compromise, exactly as Rome's 42 is. |
| **arterial** | **12 m** | 24 m | [GAME], anchored on the attested 9 m sea-gate street and rounded up. The harbour road, the road behind the wall, the ring round the Byrsa's foot. |
| **local** | **7 m** | 14 m | [ARCH], the top of Lancel's 5–7 m band |
| **lane** | **4 m** | 8 m | [ARCH] near the Magon quarter's 3 m. **A formation cannot use it, and that is the point.** |
| **stepped street** | **6 m**, stepped, on any grade over 1:8 | — | [ARCH] |

**The consequence the city agent must design for, not design around:** a cohort in line is ~35 m
wide. It fits on a processional street and nowhere else. Everywhere else in Carthage the attacker
is in **column at 4–7 m frontage** or he is not moving. That is the map's infantry mechanic and it
should be *felt*, not fixed.

Rome's own audit already found that the district generator's 374 lanes at 8 m are what make the
fabric read; Carthage's are at 4–7 m and there should be **more of them**.

### 7.3 Blocks and buildings

**Author the fabric on the cubit module, not on metres.** A Punic cubit is 0.515 m; the whole
Byrsa quarter is laid out on it, and a generator that snaps to `30 × 60 cubits` with `12-cubit`
plot subdivisions will produce a Carthaginian street front by construction. This is the single
most useful thing in the archaeology and Rome has no equivalent.

| property | value | tag |
|---|---|---|
| Insula footprint | **15.5 × 31 m** = **30 × 60 Punic cubits** (480 m²) | [ARCH] |
| Long axis | **along the contour**, so the 31 m face runs across the slope and the 15.5 m depth climbs it; each block therefore steps down one terrace to the next | [ARCH] [DER] |
| Plot subdivision | **five plots of 12 × 30 cubits (6.2 × 15.5 m)** per block face; some split into a front and a back unit | [ARCH] |
| House interior | a **courtyard** for light with the **cistern mouth in its floor**, a **side corridor** running the full depth from the street door to a second door on the back street, small rooms off it, a cesspool, and a street-front room usable as a **shop** | [ARCH] |
| Storey height | **2.8 m** + 0.4 m of floor | [GAME] |
| Typical height | **ground + 3 to ground + 5**, i.e. **4–6 storeys, 12.8–19.2 m** | [A] tempered |
| The three streets to the Byrsa | **six storeys, 19.2 m**, both sides, hard on the kerb — the tallest continuous fabric in the game | [A] |
| Magon quarter / harbour district | **2–4 storeys**, workshops and warehouses, lower and coarser | [ARCH] [GAME] |
| Roofs | **flat, with parapets** — Punic and North African, not tiled and pitched like Rome's | [MOD] |
| Walls | rubble and mud-brick between **ashlar piers** (`opus africanum`), lime-rendered white or ochre | [ARCH] |
| Cisterns | one under every house; render as a dark vaulted mouth in the courtyard | [ARCH] |

**Flat roofs are a mechanic, not a look.** Appian's Romans crossed from roof to roof on planks and
fought a battle up there while a second battle went on in the street below. [A] `fbcfe65` made the
wall traversable terrain; roofs are the same problem, and a Carthage that does not let men onto
its roofs has thrown away its best scene. Specify: **flat roofs of buildings 4 storeys and up on
the three Byrsa streets are walkable**, with **2.0–4.0 m gaps** between blocks that a plank
crossing can bridge.

### 7.4 Grain — free authenticity

`docs/HANDOFF.md` records that Rome's remaining difference from the AGEA orthophoto is **grain,
not coverage**: real blocks are smaller and punched with 1–4 courts of 10–25 m, ours are larger
with one big court. Carthage's real grain is **15.5 × 31 m with a 3–5 m courtyard per house**,
which is finer than anything Rome has. Build to the archaeology and the grain problem solves
itself. Do not scale Punic blocks up toward Roman ones.

### 7.5 The military way — Carthage's pomerium

**35 m clear behind the main wall.** [GAME]

Rome's `POMERIUM = 60` is built from three needs stacked front to back: ~20 m lateral movement
corridor, ~25 m to form up facing a breach, ~15 m of slack. Carthage needs the last two and
**does not need the first**, because the lateral corridor is *inside the wall* — that is what the
casemate gallery is for. So 25 + 10 = 35.

Two consequences:

1. **`probe-nav`'s `openGroundBehindWall min 40` is a Rome number and must become per-map.** At
   Carthage the assertion is `min 35`, measured by containment against the *main* wall's inner
   face, not by nearest-centre — see the HANDOFF entry that already burned this exact instrument
   once.
2. The fabric comes 25 m closer to the wall than at Rome, so **a breach dumps you into houses
   almost immediately**. Intended.

### 7.6 The forum — the map's one open space inside the walls

Appian: with the wall round the Cothon taken, **"Scipio seized the neighbouring forum"**, and it
is from the forum that the three streets climb to the Byrsa. [A] So the forum is the hinge
between the harbour fight and the hill fight, and it is the only place inside Carthage where two
armies can actually deploy against each other.

| property | value | tag |
|---|---|---|
| Position | at the Byrsa's south-east foot, between the hill and the harbours: **e ≈ +250, n ≈ −400 → x ≈ −290, z ≈ 1000** | [MOD], the position is debated |
| Size | **120 × 80 world metres of open paving** | [GAME] |
| Enclosure | colonnaded on at least two sides, with the three street mouths on the Byrsa side and the harbour road entering opposite | [GAME] |
| Distance to the harbours | **x −290 → −670, z 1000 → 984**: **380 world m** of harbour road. That is the stretch Scipio covered between taking the cothon and taking the forum. | [DER] |

**Note the exception to §2.4.** An open square is neither a position nor a cross-section: put
through `KN`/`KE` a 180 × 120 m real agora would come out 81 × 26 world m, a corridor. Open
spaces that have to be *fought in* take **world dimensions directly**, which is the same
exemption `rome.ts` gives its `soft` entries. The forum, the harbour quays and the wall's
killing ground are the three places on this map where that applies.

### 7.7 The Megara — a walled suburb that is not city fabric

The northern half of the walled area was the **Megara**: not streets and insulae but a large
suburb of **market gardens, orchards, hedges, ditches and irrigation channels**, with scattered
villas. Scipio broke into it by night in 147 BC and Appian records that the Romans found the
enclosures and channels harder going than the wall had been. [A]

Build it as a **third terrain class**, distinct from both open ground and city:

| property | value | tag |
|---|---|---|
| Extent | the **+X (north) quarter** behind the wall — roughly x **+250 to +1100**, z **520 to 1000** | [MOD] |
| Field enclosures | dry-stone walls and thorn hedges **1.2–1.8 m** high on a **40–70 m** grid | [GAME] from [A] |
| Ditches | irrigation channels **1.5–2.5 m** wide, **1 m** deep, along one side of most enclosures | [A] |
| Planting | olive, fig, almond, pomegranate, vine; walled kitchen gardens; cypress lines | [MOD] |
| Buildings | scattered villas and farm ranges, **1–2 storeys**, at maybe 8 % coverage | [GAME] |

**Why this earns its place.** An attacker who gets over the *north* end of the triple wall does
not arrive in a city — he arrives in a chequerboard of walled gardens where a formation cannot
hold its line, every enclosure is a small strongpoint, and cavalry is useless. It is a third kind
of ground on a map that already has open plain and dense fabric, and it means the three gates in
§4.5 do not lead to the same battle. It is also cheap: it is scatter and low walls, not
buildings.

---

## 8. What makes it play differently from Rome

Two besiegeable cities that play the same are one map with two skins. Here is the list, in
descending order of how much it changes a player's decisions.

### 8.1 Depth instead of a line

Rome is one 6.0 m curtain at 6.5 m high on top of a hill. Carthage is **74 m of belt**: a 20 m
ditch, a palisaded rampart, an 8 m wall, an 18 m killing ground, and then 16 m of casemated
masonry. **There is no single bound that takes it.** A ladder party that clears the outwork is
standing in a killing ground overlooked from 16 m by a wall it has not touched. A ram that breaks
the middle wall has broken the *second* of three. The attacker has to plan a sequence, and every
stage of it is a place the defender can counter-attack into.

### 8.2 A wall you can be inside

Nothing else in this game has this. Concretely, four things a defender can do at Carthage that
they cannot at Rome:

- **Move reserves the length of the wall under cover** — invisible, immune to missiles, and
  arriving at a threatened bay without ever showing on the walk.
- **Hold a wall whose walk has been lost.** Taking the top of the Aurelian wall is taking the
  wall. Taking the top of this one leaves 6.4 m × 4,434 m of held interior underneath you and
  stairs coming up behind you.
- **Fight a breach in three dimensions.** A hole in the outer face opens into a dark vaulted
  corridor 9.1 m deep, not into the city. The attacker fights along it at 8 abreast with loopholes
  above him.
- **Burn the fodder.** The magazines are full of hay and barley. A defender who cannot hold a
  section can deny it. (Attacker's mirror: fire in the casemate is how you clear it.)

And one thing the *attacker* gets: if he takes a casemate section, he is inside the wall with
cover, and the defender has the same problem in reverse.

### 8.3 Two axes of attack, not one

Rome presents one front. Carthage presents two, both historical, both live on the same day:

- **The isthmus.** Straight at the triple wall. What Manilius tried in 149 BC and failed. Firm
  ground for engines, but only up the middle (§3.4), and the strongest fortification in the
  ancient world at the end of it.
- **The Taenia.** Along the sandspit to the weak, low angle where the triple wall gives out
  (Appian's own words), through the Porta Maritima or over the harbour quay, into the cothon, up
  to the forum, and then the three streets. What Scipio actually did. Cheap to reach, but the
  corridor is 200–300 m wide with a lake on one flank, and everything past it is street fighting.

An attacker who splits between them is weak in both. That is a decision, and Rome's map does not
offer one.

### 8.4 No flank, no retreat, no relief

Both ends of the triple wall die on water. The map's +Z edge is the open sea. There is **no way
round** and, for the defender, **no way out** — Carthage's only line of retreat is uphill to the
Byrsa, and then there is nothing. Rome's Aurelian stretch has open country past both ends of the
modelled curtain and a whole empire behind it.

### 8.5 A vertical endgame

Rome's city is a plateau: once you are through the wall the ground is flat. Carthage's last 400 m
of depth climb **45 m at 14 %** up three stepped streets between six-storey blocks, with roof
fighting overhead and a walled citadel at the top that no engine can reach. The battle gets
*harder* the deeper the attacker goes, which is the opposite shape to Rome and is what makes the
map worth finishing.

### 8.6 A fabric that will not take a formation

Rome's 42 m artery is there so a cohort can deploy. Carthage's widest ordinary street is 7 m.
Past the wall the attacker is in column, permanently, and every junction is a fight at 7 m
frontage. Cavalry is close to useless inside the walls. Elephants — if the player brings them —
cannot use the Byrsa streets at all.

### 8.7 Water in the battle

The harbours are 14 ha of water inside the defences, crossed by a 21 m chained channel, a 4 m
causeway and a 30 m freshly cut channel to the sea. A ship can arrive. A chain can be dropped. A
mole can be built. None of that exists at Rome, whose only water is a river 700 m from the wall.

### 8.8 Ground that decides the siege train

Soft margins on both flanks (§3.4) force every heavy engine into the centre of the isthmus. The
defender knows exactly where the rams are coming and can weight the wall accordingly. Rome's
approach is uniformly firm.

### 8.9 Three gates, three different battles behind them

Rome's modelled circuit has one gate and everything behind it is the same city. At Carthage the
north gate opens into the **Megara's walled gardens** (§7.7), the centre gate into the road to the
**forum**, and the south gate into the **harbour quarter**. Each is a different kind of ground
with a different unit type suited to it, and the attacker picks before he commits.

---

## 9. What nobody knows, and what we are inventing

Listed so no one later mistakes our decisions for evidence.

| item | status | our decision |
|---|---|---|
| The line of the triple wall on the isthmus | **not located** | reconstructed, ±400 real m |
| The ditch's existence and dimensions | not excavated | 20 × 6 m, from the 60-ft tradition |
| The middle and outer walls' dimensions | Appian gives none individually | stepped 4 m / earth rampart |
| Gate count and position in the land wall | **unknown** | three, invented, §4.5 |
| Tower plan and footprint | unknown | 11 × 11 m, projecting 5.5 m |
| Whether the casemates are continuous or intermittent | unknown | continuous, on Appian's plain sense |
| Whether the barracks figure is real | **almost certainly not** | gallery, not dormitory, §4.4 |
| The admiralty island's diameter | **excavated, 125 m** (Hurst) | 125 m. Our independent derivation from shed counts gave 130 — a useful check that the rest of §6.2 hangs together |
| A causeway to the island | **no evidence** | built anyway, flagged, §6.4 |
| Byrsa summit elevation | 50 / 57 / 60 in print | **60** |
| The Byrsa's *world* footprint | the projection gives a 30° cliff | **overridden to 340 × 200 world m** for a 1:3.8 built face — §2.4, §5.1a. This is a deliberate departure from the projection and the only one on the hill. |
| The Punic summit's plateau before Roman truncation | inferred | 250 × 180 m |
| Whether houses were really six storeys | Appian only | modelled 4–6, six on the three streets |
| The city's grid orientation away from Byrsa and Magon | partial | follow the coast in the Magon quarter, follow the contour on the Byrsa slope |
| The Taenia's true width at the wall | Appian ½ stade vs modern 1.1 km | modelled 200–300 world m |

Also flagged: **Appian places the triple wall "toward the south … where Byrsa stood on the
isthmus."** Both halves of that are wrong — the mainland is west, and the Byrsa is not on the
isthmus. It is a good example of a first-rate source being loose about geography, and a reason to
trust his *dimensions* more than his *directions*.

---

## 10. Sources

Primary:

- **Appian, *Roman History* VIII (*Punica* / *Libyca*)**, esp. §§95–96 (the city, the walls, the
  harbours) and §§117–131 (the mole, the cut channel, the quay assault, the six days, the Byrsa).
  Horace White's translation is public domain.
  - https://www.livius.org/sources/content/appian/appian-the-punic-wars/appian-the-punic-wars-19/ (§95–96)
  - https://www.livius.org/sources/content/appian/appian-the-punic-wars/appian-the-punic-wars-20/ (harbours)
  - https://www.livius.org/sources/content/appian/appian-the-punic-wars/appian-the-punic-wars-24/ , /-25/ , /-26/ (the siege and the fall)
  - Perseus: http://www.perseus.tufts.edu/hopper/text?doc=Perseus:text:1999.01.0230:text=Pun. (503 at the time of writing; retry)
- **Polybius** — Appian's ultimate source for the city description; Polybius was present at the
  siege. The relevant books survive only in fragments.
- **Strabo XVII** — the peninsula's circumference.

Modern:

- Serge Lancel, *Carthage: A History* — the Byrsa excavations, the Hannibalic quarter, the street
  grid and insulae. Lancel and Pierre Gros directed the Byrsa sector of the UNESCO campaign
  1974–1991.
- Henry Hurst — the British excavation of the circular harbour and the admiralty island;
  slipways, shed counts, dating.
- Lawrence E. Stager — the American excavation of the rectangular harbour and the Tophet.
  - https://isac.uchicago.edu/sites/default/files/uploads/shared/docs/ar/71-80/76-77/76-77_Punic.pdf
- Adrian Goldsworthy, *The Fall of Carthage* — the 9 m × 15–20 m wall and the 20 m ditch reading.
- Richard Miles, *Carthage Must Be Destroyed*.
- Stéphane Gsell, *Histoire ancienne de l'Afrique du Nord* II (1918) — public domain, the fullest
  nineteenth/twentieth-century topography.
  - https://www.ancientportsantiques.com/wp-content/uploads/Documents/PLACES/NorthAfrica/Carthage-Gsell1918.pdf
- 1911 *Encyclopædia Britannica*, "Carthage (ancient city)" — public domain; the taenia, the
  Byrsa at 195 ft, the harbour acreages.
  - https://en.wikisource.org/wiki/1911_Encyclop%C3%A6dia_Britannica/Carthage_(ancient_city)
- Wikipedia, *Carthage* / *Archaeological site of Carthage* / *Carthage Punic Ports* /
  *Third Punic War* — used as an index to the above, not as authority.
- romanports.org, "Carthage" — quay widths, the moles, the entrance.
  - https://www.romanports.org/en/articles/ports-in-focus/754-carthage.html

---

## 11. Reference imagery — `reference/carthage/`

**15 files, 9.9 MB, licence-verified and catalogued in `ASSETS.md`** under "Punic Carthage
reference". Full table with creator, licence, source page and SHA-256 is there; this is the
index of what each one is *for*.

| use it for | files |
|---|---|
| **§7 street grid and housing** — the cubit module, plot subdivision, the stepped street | `plan-byrsa-hannibal-quarter.png` (the plan every number in §7.1 was read off), `plan-byrsa-house.png` |
| **§5 the Byrsa** — relief, the slope, the stratigraphy, the truncated summit | `plan-byrsa-hill-section.png`, `byrsa-hill.jpg`, `byrsa-hill-cridland.jpg`, `byrsa-site-dalbera.jpg`, `byrsa-roman-foundations.jpg` |
| **§6 the harbours** — basin shapes, the island, bank profiles, the shore relationship | `aerial-salammbo-ports.jpg`, `ports-punic-oblique.jpg`, `ports-cothon-ground-1.jpg`, `ports-cothon-ground-3.jpg` |
| **§3 the ground** — coast, peninsula, how flat it all is | `aerial-carthage.jpg`, `aerial-carthage-2013.jpg` |
| **materials** — Punic ashlar and *opus africanum* | `punic-ruins-masonry.jpg` |
| dressing | `tophet.jpg` |

**Deck eligibility: none of it, ever.** This pool is **layout and accuracy reference only**.
`reference/rome2/` remains the sole blind render-quality plate pool. Mixing provenance has been
got wrong twice on this project and a photograph in a render-vs-render deck measures sensor
noise, not rendering.

**Two cautions on using these.**

1. **Everything photographed is post-146.** The Byrsa's visible stonework is largely Roman
   forum substructure standing *on* the Punic quarter, not Punic. The harbour lagoons have
   silted, been landscaped and been re-cut. Use the photographs for shape, relief, light and
   material; use §4–§7 for dimensions. Where the two disagree, the numbers win — see the
   admiralty-island warning in §6.2.
2. **No reconstruction art was fetched, and none should be.** A search for "Carthage" returns
   mostly reconstruction renders and artists' impressions of unknown provenance, and a
   significant fraction of what circulates is extracted from commercial games. Nothing of that
   kind is in this directory.

Still wanted and not yet found under an acceptable licence: a published plan of Hurst's circular
harbour excavation; any measured drawing of the Magon-quarter sea rampart; a site plan showing a
reconstructed line for the isthmus wall. Gsell (1918) has the last of these and is public domain,
but Commons carries it as PDF, which is not a permitted format here.

---

## 12. Build order

For the three agents, so nobody blocks on nobody:

1. **Terrain and integration** — §2 (the frame and the projection), §3 (the ground). Nothing else
   can be placed until the projection exists and the heightfield carries the isthmus, the two
   lagoons, the Byrsa and the coast. Also owns the `MapId`, the `MapDefinition` and making
   `CitySystem` map-aware.
2. **Walls** — §4, then the south wall and the sea wall. Start with the main wall's cross-section
   and the casemate interior, because §4.4 is the map's reason to exist and it is the highest-risk
   item in the whole build. Get one 200 m stretch right before running 2 km of it.
3. **City fabric** — §5, §6, §7. The Byrsa's relief and the three stepped streets before the
   general fabric; the harbours can come after, and the admiralty island last.

Cross-cutting and unowned: the soft-ground mechanic (§3.4), walkable roofs (§7.3), the harbour
chain, and the per-map `probe-nav` threshold (§7.5). Somebody should claim these.
