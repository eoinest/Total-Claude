# Cities, Walls and Siege

*Measured against `6698e19`. Every number below is either taken from source at that commit,
read off the running simulation at that commit, or attributed to the commit that recorded it.
Where a claim could not be reproduced it is marked.*

Three maps ship. Two of them carry a city, and on those two the battle can be an assault:

| Map id | City | Garrison | Siege gate | Assault selectable |
|---|---|---|---|---|
| `campus-martius` | `ROME_PLAN` — Rome, 271 AD | `Faction.Rome` | `porta-flaminia` | yes |
| `carthage` | `CARTHAGE_PLAN` — Carthage, 146 BC | `Faction.Carthage` | `porta-byrsae` | yes |
| `pydna` | `null` | — | — | no |

This volume is about what happens on those two maps: how a city is described to the rest of
the engine, how a wall becomes ground that soldiers stand and fight on, and what the assault
does mechanically. `docs/CARTHAGE.md` is the design and build record for one of the two
cities; `docs/ARCHITECTURE.md` §3 states the `CitySystem` contract. Neither says how a siege
works.

---

## 1. The `CityPlan` seam

### 1.1 A map carries a city, or carries none

```ts
// src/main.ts
const cityPlan = getMap(config.map).city;
if (cityPlan) engine.add(new CitySystem(cityPlan));
```

`MapDefinition.city` is `CityPlan | null`. There is exactly one `CitySystem` and it builds
whichever city its plan describes.

This replaced a `hidesCity: boolean`, and the reason is a bug that shipped. Under the flag,
`CitySystem` planned the Aurelian circuit against the Tiber, built it onto whatever
heightfield was loaded, and was then made *invisible*. The geometry stayed in the world:
`Pathfinding` stamps `city.getWallSegments()` with no map guard, so **Rome's wall blocked
movement across the plain of Pydna while being nowhere on screen**. The argument written up
in `src/city/cityPlan.ts` is not that the flag was set wrong — it is that the flag's failure
mode was invisible and a third map would repeat it. A city is no longer something a map
*hides*; it is something a map *carries*, and the absence of a city is the absence of data.
`main.ts` builds what it is handed and nothing when it is handed nothing.

The same reasoning was applied a second time in the same release, to water:
`MapDefinition.terrain.water` is a `WaterProfile | null` for the same reason (`ARCHITECTURE.md`
§3). Two instances of one shape is the point — the seam is a rule, not a fix.

### 1.2 What a plan publishes

`src/city/cityPlan.ts` is the only module a new city imports from. It re-exports the wall
contract as `export type`, so a city's own wall builder gets the whole interface without
pulling Rome's `wall.ts` into the module graph.

```ts
interface CityPlan {
  readonly id: string;            // 'rome', 'carthage' — never parsed for behaviour
  readonly name: string;          // display; objectives, results screen, menu subtitle
  readonly garrison: Faction;     // whose city it is; the storming side is derived
  readonly siegeGateId: string;   // must match a WallBuildOutput.gates[].id
  readonly battlefieldZ: number;  // no city geometry below this z, at any LOD
  readonly towerChamberHeight: number;
  readonly merlonLength: number;  // must match the wall's own crenellation() exactly
  readonly crenelLength: number;
  readonly gateOpenWidth: number;
  build(heightAt: (x: number, z: number) => number): CityBuild;
}
```

The two shipped plans:

| | Rome (`src/city/rome/plan.ts`) | Carthage (`src/city/carthage/plan.ts`) |
|---|---|---|
| `garrison` | `Faction.Rome` | `Faction.Carthage` |
| `siegeGateId` | `porta-flaminia` | `porta-byrsae` |
| `battlefieldZ` | 250 | 250 |
| `merlonLength` / `crenelLength` | 1.7 / 0.95 | 1.55 / 0.8 |
| `gateOpenWidth` | 4.3 | 5.2 |
| `towerChamberHeight` | `WALL.towerChamberHeight` = 5.0 | `22.5 − 13.7 − 2.2 = 6.6` |

`merlonLength`/`crenelLength` are duplicated from the wall builder deliberately:
`masonryTopAt` alternates them per projectile per tick, so the period has to be arithmetic in
a hot path rather than a measurement off geometry. `rome/plan.ts` records the cost of getting
that wrong — **491 missile impacts on our own masonry in one minute of battle**.

`build` returns a `CityBuild`: the wall, the chunks to bake, monument and building
footprints, lanes, landmarks, and a `CityChecks` bag. Seven further fields are optional and
exist only for a multi-line fortification — `towerRise`, `outworks`, `outworkTopAt`,
`casemates`, `ditch`, `occBlockers`, `punicSection` — each read by `CitySystem` with a
default, so a one-wall city need not know they exist.

`CityChecks.assertions` carries a `detail` string per check and it is load-bearing rather than
decorative. `rome/plan.ts` explains why: `assertNoFootprintOverlaps` reads like a guarantee,
compares landmarks with landmarks only, and reported zero while the player was looking at
monuments dropped across housing. A scalar cannot carry the population it sampled.

### 1.3 Who consumes a city

Twelve call sites in `src/` resolve the city, and **every one of them goes through a
duck-typed structural view** — eleven with `ctx.tryGet('city') as unknown as <narrow shape>`,
and `Minimap` with a plain `as`:

| Consumer | What it reads |
|---|---|
| `src/sim/Siege.ts` | `getGarrisonBays`, `getGates`, `setGateOpen`, `setGateDoorBroken?`, `isGateDoorBroken?`, `getGateBlock?`, `getWallStairs?`, `breachWall?` |
| `src/sim/scenario.ts` | `getGarrisonBays`, `getGates`, `cityPlan` (name, `siegeGateId`, `garrison`) |
| `src/sim/BattleSystem.ts` | obstacle source |
| `src/sim/BattleFlow.ts` | bays, for the assault objective |
| `src/sim/deployment.ts` | bays and the plan, for the deployment zone |
| `src/sim/Projectiles.ts` | `masonryTopAt` |
| `src/ai/Pathfinding.ts` | nav provider (`getWallSegments`, `blocksMovement`, obstacles) |
| `src/ai/WallDoctrine.ts` | `getWallStairs`, `getLanes` |
| `src/ui/SelectionController.ts`, `HudSystem.ts`, `Minimap.ts` | picking, HUD, minimap |

This is what keeps `src/sim/` from importing `src/city/`. It also means the compiler checks
nothing across the seam: `as unknown as` discards the structural test. §7.2 is a live defect
that exists precisely because of that, and it is the price of the arrangement.

---

## 2. The wall as walkable terrain

### 2.1 `Siege` is not a subsystem

`src/sim/Siege.ts` (5,737 lines) is owned and driven by `BattleSystem`, not registered with
the engine. It has to interleave with the soldier tick at exactly two points:

- **`preSteer(dt)`** — before steering, to say where a man on a structure is standing and
  where he should stand;
- **`postIntegrate(dt)`** — after integration, to put him back on the ledge the crowd solver
  and the integrator have just shoved him off.

A separate subsystem could only have run before or after the whole of `BattleSystem`, and
either way a garrison would spend every other frame in mid-air. The fixed tick, from
`BattleSystem.fixedStep`:

```
savePrevious · rebuild spatial hash · refreshObstacles
elevation.preSteer(dt)        <-- Siege: armGate, interceptOrders, releaseBrokenCrews,
                                  updateGarrisons, advancePlans, updateTowers, updateRams,
                                  updateLadders, musterOwned
collectRoutes
per unit: updateUnitOrder, layTrail, updateUnitCohesion
steerSoldiers · resolveCrowding · integrate
elevation.postIntegrate(dt)   <-- Siege: advanceCrossings, advanceLinks,
                                  holdGarrisonsOnTheWalk
trackOwnedAnchors · updateAnimationState
```

Two orderings in there are load-bearing. `preSteer` runs *before* `updateUnitOrder`, which is
what lets `interceptOrders` read a player order before the sim rewrites it. `postIntegrate`
runs *before* `trackOwnedAnchors`, so a siege-owned unit's anchor is put where its men
actually ended up rather than where they were going.

`preSteer` also early-outs on `owned.size === 0 && garrisons.size === 0 && ordered.size === 0`,
so a field battle of 8,600 men pays one comparison for the whole of this. `postIntegrate`
early-outs on the first two.

### 2.2 The station spine

`Siege.buildSpine()` runs once at init and flattens every garrisonable bay into a list of
*stations* — a place a man can stand.

```
STATION_PITCH  = 0.86 m                              lateral spacing, the field spacing
STATION_CLEAR  = 0.55 m                              clear of the tower at either end
toNext = (next.x0 − bay.x0)·dx + (next.z0 − bay.z0)·dz    chord, measured not read
t0 = bay.towerHalf  + STATION_CLEAR                  first station
t1 = toNext − next.towerHalf − STATION_CLEAR         last station
count = floor((t1 − t0) / STATION_PITCH)
```

**Both ends are clipped by the tower that stands at that end, and until `2598f1e` only one
was.** `t1` was `bay.length − 0.55`, which names no tower at all, so the last four or five
stations of every bay ran into the next tower's footprint while still being levelled to their
own bay's `walkY` — and that footprint is exactly the band `CitySystem.curtainWalkAt` ramps
the drawn walk across, so `walkY` is the one number that is wrong in there. Measured at
`66b220b`: 166 of Rome's 1,673 stations inside a tower box, the worst standing **3.16 m above
the surface `CitySystem.walkableTopAt` reports under it**, and 177 of Carthage's 2,016 at up
to 0.80 m. Both are 0 now, and every station's height equals `walkableTopAt` at its own plan
point to float precision.

The knock-on is larger than the clip. A crossing is priced over the plan run between the two
stations it joins, so shortening the run on one side halved every tower gap: Rome's were
4.94–5.68 m where the tower really gives 8.71–9.52, and `stepAcross` was being asked to
carry a 7.70 m rise over 5.03 m of plan. It refused, correctly. With the run honest, all five
of Rome's refusals are flights, `unbridged` falls 8 → 3, and **43 of 45 runs are reachable
from a stair against 28**. The cost is time and standing room: Rome 1,673 → 1,486 stations,
Carthage 2,016 → 1,830, and a tower pass takes a median 9.5 s against 6.0. See `STATION_CLEAR`
and `LINK_MAX_GAP` in `Siege.ts` for the arithmetic and for the 6.02 m ceiling it puts on a
future circuit's `towerHalf`.

Fifteen parallel arrays are written per station, and their names are the whole vocabulary of
the rest of the file:

| Array | Meaning |
|---|---|
| `sx, sz, sy` | position and the walking surface height (`bay.walkY`, absolute) |
| `snx, snz` | outward normal, in plan |
| `sInner, sOuter` | the clear standing band, as offsets along that normal |
| `sFace` | the outer *face* of the masonry. Measured at `6698e19`, 1.22–1.62 m outboard of `sOuter`: a tower docks against the face and a man stands well back from it, and using one for the other drove four towers 0.70 m into the brickwork |
| `sCrest` | absolute Y of the top of the battlement |
| `sBay` | which bay |
| `sPassMid, sPassHalf` | centre and half-width of the lane cut through the tower at this bay's west end |
| `sRun` | which continuous run of walkway |
| `sDead` | 1 where the great ram has brought the walkway down |
| `sOwner` | which unit holds this station, or −1 |

Garrisoning a unit is then handing it a contiguous run of stations. This is what makes a
garrison follow a wall that steps in height, kinks in plan, is unfinished in fifteen bays of
fifty and has a hole in it — none of which a formation offset function can express.

Ranks are laid back from the parapet at `WALL_RANK_PITCH = 0.72 m`, up to
`MAX_WALL_RANKS = 5`, with odd ranks offset `WALL_RANK_STAGGER = 0.43 m` sideways. 0.72 is
below the crowd solver's 0.84 m body diameter, and the stagger is what makes the diagonal
come out at `hypot(0.43, 0.72) = 0.84` exactly, so the solver is satisfied and does not spend
every tick shoving the garrison off its own slots.

Five ranks rather than three, and the constant is the whole of that change: the curtain
workstream widened the wall from 3.5 to 6.0 m and `layOutGarrison` already computed the depth
the band would take, so the cap was the only thing holding it at three. Measured at `6698e19`,
`sOuter − sInner` runs **2.21 m to 4.06 m** across Rome's spine — four to six ranks at the
0.72 m interlocking pitch. At three, the result was one rank at the parapet with bare stone
behind, which two blind critics read as "the walk has zero width".

`slotAt` adds per-man jitter of ±0.21 m along the wall and ±0.13 m across it, plus ±0.25 rad
of facing, from `hash01(i, salt)` rather than the `Rng` — stable per man, deterministic, and
not drawn in a fixed step. It is not cosmetic: without it a blind critic picked the garrison
out of a line-up on *"every crenellation contains the same soldier in the same pose with the
same shield at the same angle — nine copies in a row"*, and an 0.86 m station pitch beats
visibly against the battlement's own period — 2.65 m nominal on Rome, 2.7308 m as the stone
is actually cut (§2.9).

### 2.3 Runs, and why the walk is not one surface

`recut()` splits the spine wherever consecutive stations are not walkable between:

```ts
if (plan > STATION_PITCH * 1.9                        // 1.63 m — a tower, or a missing bay
  || this.stepAcross(dy, plan) !== Joint.Level        // a construction step
  || this.sDead[i] !== this.sDead[i - 1]) run++;
```

`stepAcross` is shared with `buildLinks` and is the subject of §2.4a; `Joint.Level` is
`dy <= WALK_STEP_OVER = 0.62`, so this test is unchanged in behaviour from the literal it
replaced.

`walkY` is quantised in 0.55 m construction increments held over *pairs* of bays
(`src/city/wall.ts`), and over rolling ground two neighbouring bays can differ by far more
than a man can step: the joint east of Rome's gate is recorded as a **3.62 m** drop. A garrison laid
straight across it teleported men down the step the instant their slot moved past it.
Nothing — garrison layout, the standing-surface search, a lodgement spreading out from a
ramp — may cross a run boundary.

`runLo`/`runHi` are precomputed. `runBounds` used to walk outward from a station comparing
run ids, which ran twice for every garrisoned man every tick; the file records the trade as
62,000 comparisons a tick against two array reads.

### 2.4 Links: the wall as a graph

`buildLinks()` joins the runs. Four kinds:

```ts
const enum LinkKind { TowerPass = 0, Step = 1, Stair = 2, Breach = 3 }
```

- Consecutive runs are joined when the gap between their ends is at most
  `LINK_MAX_GAP = 14 m` **and `stepAcross` says there is stone that carries the height**
  (§2.4a). `gap > STATION_PITCH * 3` classifies it a `TowerPass`, otherwise a `Step`. Beyond
  14 m the wall really is broken and no order walks a cohort across it.
- Stairs join the ground to a run, **traversable in both directions**, which is what makes
  "pull the archers back and put infantry up" one mechanism rather than two. One stair per
  run: a second flight onto a run a man can already reach adds a routing choice and no
  reachability.
- A `Breach` lane joins outside ground to inside ground. See §5.4.

Every link is a `Crossing`, and that is the design: a `Crossing` is a polyline with an
arc-length parameter per man, and a man's position is *authored* from that parameter rather
than steered toward. He cannot fall off, cannot be shoved off by the crowd solver, and cannot
teleport, because his position is a continuous function of a parameter that only ever
increases by `speed * dt`. A siege tower's ramp, a ladder, the stair inside a tower and the
route through a breach are all the same object.

Paths are built lazily (`linkPath`) because most links are never used. `advanceLinks` skips
any link with no waiters and no built path: Rome carries 50 links and Carthage 51, and a
handful are ever in use in a battle.

**Measured at `6698e19`** (`?scenario=assault`, both circuits; the spine depends only on the
heightfield, which is a fixed `FIELD_RES = 2049` lattice, so these are quality-independent):

| | Rome | Carthage |
|---|---|---|
| bays | 50 | 66 |
| garrisonable bays | 45 | 65 |
| stations | **1,695** | **2,024** |
| runs | 45 | 40 |
| `TowerPass` links | 41 (gap 4.94–5.68 m, median 5.41) | 31 (gap 7.14–7.34 m) |
| `Step` links | 0 | 7 (gap 1.30–1.85 m) |
| `Stair` links | 9 | 13 |
| stair provenance | `published` | `published` |
| runs reachable from a stair | 43 of 45 | 40 of 40 |
| unbridged run boundaries | 3 (at runs 1, 18, 24) | 1 (at run 20) |

And re-measured at `596e03b` across the `stepAcross` change, by
`tools/scratch/probe-linkstep.mjs`:

| | Rome before | Rome after | Carthage before | Carthage after |
|---|---|---|---|---|
| walk-to-walk links | 41 | **36** | 38 | **34** |
| bridging > 0.62 m | 22 | 17 | 12 | 8 |
| bridging > 3.0 m | 11 | 6 | 0 | 0 |
| worst step bridged | **7.70 m** | **4.72 m** | 2.00 m | 2.00 m |
| worst rake bridged | **56.8°** | **41.2°** | **49.2°** | **34.4°** |
| steeper than the tread module | 5 | **0** | 4 | **0** |
| unbridged boundaries | 3 | 8 | 2 | 6 |
| runs reachable from a stair | 43 of 45 | 28 of 45 | 40 of 40 | 37 of 40 |

Rome's reachability figure is the change's most conspicuous consequence and it is a *report*
of an existing defect rather than a new one. The city publishes nine flights and the
westernmost is on bay 14 at x −130: **there is no way onto the Aurelian wall-walk anywhere
west of that**, 518 m of curtain over thirteen bays. Until this change the whole of it hung off
one link — the 7.70 m joint at x −134.6, which is the boundary between the stairless west and
the first flight. §15 task 10 of `ROME.md` puts a stair inside every tower, which closes it.

Two consequences worth naming. On Rome every run is exactly one bay, so every break is a
tower and `Step` never occurs; on Carthage a run spans more than one bay and the 0.62 m
height test is what produces the seven `Step` links. And Rome's westernmost two runs carry no
stair and sit behind an unbridged boundary, so **two runs of the Aurelian wall-walk cannot be
reached on foot by anybody** — which `wallReport().reachable` reports as 43 of 45 at every
boot.

> The `LINK_MAX_GAP` comment states "the tower gaps on this circuit run 8.3–9.4 m". Measured
> at `6698e19` they run 4.94–5.68 m. The classifier still has ample daylight (the nearest
> unbridged gap is far past 14 m), but the quoted range is stale.

### 2.4a One question about a joint, asked once

`recut` used to sever on height and `buildLinks` used to rejoin on plan distance. The line
between them read:

```ts
const step = Math.abs(this.sy[b] - this.sy[a]);
// A tower is a long gap in plan; a construction step is a short one with a jump in height.
const kind = gap > STATION_PITCH * 3 ? LinkKind.TowerPass : LinkKind.Step;
void step;
```

The comment describes a classifier that uses the height; the code voided it. So a joint the
spine had cut *because* of its height was sewn back up without the height being consulted, and
the seam was walkable at a pace: a link is a `Crossing`, and a `Crossing` cannot be fallen
off. Measured on Rome at `596e03b` by `tools/scratch/probe-linkstep.mjs`, **22 of 41
walk-to-walk crossings bridged more than the 0.62 m that split the run, 11 more than a storey
and 3 more than the curtain is tall** — worst 7.70 m across 5.03 m of plan, 56.8°.

`stepAcross(rise, run)` is now the single predicate, called by both, returning one of three
answers:

| | test | meaning |
|---|---|---|
| `Joint.Level` | `dy <= WALK_STEP_OVER` (0.62 m) | walked without changing gait; not a boundary |
| `Joint.Flight` | `dy <= run * FLIGHT_PITCH` | a flight, at a rake the tread module can carry |
| `Joint.Broken` | otherwise | no stone reaches; `recut` cuts and `buildLinks` leaves it cut |

`FLIGHT_PITCH = 0.31 / 0.34` is `STAIR_SLOPE` inverted and is the pair `wall.ts` lays every
tread of the tower flight out from, so a joint this admits is one the stone can be built for.

**A bare height cap cannot do this job, and the two circuits disagree about it in opposite
directions.** Carthage joins two walks 2.00 m apart across a 7.32 m tower — a 15.3° ramp — and
two walks 1.50 m apart across 1.30 m of plan, 49.2°, which `CitySystem.walkableTopAt` reports
as running **0.91 m inside the masonry**. `STAIR_STEP_OVER = 1.2 m` refuses both; the rake test
refuses the second and keeps the first. Measured over both circuits, a 1.2 m cap refuses 21 of
Rome's 41 and 9 of Carthage's 38 and leaves 19 of Rome's 45 runs reachable from the ground; the
rake test refuses 5 and 4 and leaves 28.

There is no one-way variant. A descent-only link is the honest physical asymmetry and a trap:
`nextHop`, `runsConnected` and `walkDistance` all walk the run chain in both directions, and a
cohort that drops onto a stairless run can never leave it.

A third threshold is already in the file and the three are now ordered rather than
independent: `segmentAt`'s `dy / len > 0.6` is a **sine**, so 36.9°, and it is what puts a leg
on `CROSS_CLIMB` with the climbing clip. Walk (≤ 0.62 m), climb (> 36.9°), nothing (> 42.4°).

### 2.5 Stairs come from the city, or are synthesised and say so

`buildStairs()` asks `city.getWallStairs?()` first and believes it absolutely, rejecting only
a published flight whose head is more than 6 m from the standing surface. Only if there is no
API at all — or if every published flight is unusable — does it fall back to synthesising
one flight every fourth bay at `index % 4 === 2`, from `STAIR_MOD`, `STAIR_PHASE` and
`STAIR_SLOPE = 0.34 / 0.31`.

Those three constants are the only numbers in `Siege.ts` that duplicate a rule owned by
another workstream. `wallReport().source` prints `published` / `synthesised` / `none` so the
provenance is never a guess. **At `6698e19` both circuits publish**, so the fallback is dead
code that documents its own obsolescence.

### 2.6 Tower passes

A tower chamber occupies the walk at the west end of every bay, and the path through it is
the single most-corrected piece of geometry in the file. `GarrisonBay.passOuter`/`passInner`
publish the clear lane as offsets along the outward normal; `Siege` carries them per station
as `sPassMid`/`sPassHalf`; `linkPath` routes a `TowerPass` down the centre of that band and
falls back to the cityward lip only where the city publishes a zero-width lane.

The recorded failure: the path used to run along the lip at `innerOff − 0.15`, on the strength
of a comment in `wall.ts` that had described a *previous* tower. The hole was 1.36 m out to
the field of it, and the file walked through the chamber wall and its back wall at **73 of 73
towers across both circuits** — measured with a ray along the wall axis against the geometry
the renderer had. `ARCHITECTURE.md` §3 states the rule that came out of it: *derive the lane
once and cut the stone with the same call*. Both cities do it in one helper apiece
(`towerLane`, `punicTowerPass`), and `tools/probe-towerpass.mjs` measures the result off the
built meshes rather than off either source.

### 2.7 Rome's circuit is a building site by design

`bayStage` (`src/city/layout.ts:2321`) assigns a `BayStage` from a bay's offset `k` from the
gate bay:

```ts
export type BayStage = 'finished' | 'no-parapet' | 'half-built' | 'footing' | 'gap';

if (k === 0 || k === 1 || k === -1)       return 'finished';
if (k === 3 || k === 4)                   return 'half-built';
if (k === -3 || k === -4 || k === -5)     return 'no-parapet';
if (k === 7)                              return 'gap';
if (k === 8 || k === 9)                   return 'footing';
if (k === -9 || k === -10)                return 'half-built';
if (k === 13 || k === -14)                return 'no-parapet';
if (k === 17 || k === 18)                 return 'half-built';
if (k === -18)                            return 'footing';
return 'finished';
```

**Measured at `6698e19`**, Rome's 50 bays come out:

| Stage | Bays | Garrisonable |
|---|---|---|
| `finished` | 35 | 34 (the gate bay stands down) |
| `half-built` | 6 | 6 |
| `no-parapet` | 5 | 5 |
| `footing` | 3 (bays 2, 28, 29) | 0 |
| `gap` | 1 (bay 27) | 0 |

Carthage, by contrast, is 66 bays all `finished`.

The stages are not decoration; three separate systems read them.

- **Height.** `segments[].height` is 1.1 m for a `footing`, 3.1 for a `gap`, 3.4 for
  `half-built`, and `WALL.height` otherwise.
- **Shooting.** `masonryTopAt` returns `bay.walkY` flat on a `no-parapet` bay rather than
  running the crenellation model over it, because the dressed merlon blocks are five stacks
  waiting on the walk, not a crest. Before that, an arrow stopped 1.26 m above bare travertine
  along two thirds of every unfinished stretch — *which is where the escalade goes in*.
- **Movement.** `wall.ts` pushes a `Blocker` for every stage **except** `footing`: "a bare
  footing does not stop a man; everything else does."

That last line is the whole of §2.8.

### 2.8 The three holes, and the only way the AI ever wins

Measured at `6698e19` by driving a 32 m segment straight through the wall line at 2 m
intervals along the whole circuit and asking `CitySystem.blocksMovement`:

| Open band | Bay | Stage |
|---|---|---|
| x −550 … −536 | 2 | `footing` |
| x 372 … 390 | 28 | `footing` |
| x 404 … 426 | 29 | `footing` |

Nothing else on Rome's 1.78 km of circuit is passable. The `gap` bay at 27 is *not* a hole in
the collision surface — it carries a rampart and a blocker — it is a hole in the *walkway*,
which is a different thing and is why it is not garrisonable.

Commit `7340d02` recorded the same three bands independently, sampling at 5 m: *"of 356
stations, 14 do not block a 28 m segment driven straight through the wall line, in three runs
— x −551..−536, x 369..389 and x 404..424."* The "356 stations" there are the probe's own
5 m samples along the circuit, **not** spine stations; there are 1,695 of those.

What it was measuring: both Juthungi wins in a twelve-seed campaign came through
`stormInside >= BREAK_IN`, and one fired at t+857 in a battle where nothing had stood on the
parapet since t+219 and no ladder had crossed since t+80. Tracked at 5 s intervals,
`juthungi-riders#31` goes from **+194.6 m outside at t+0 to −9.2 m inside between t+25 and
t+30, at x 371, with 50 of 50 men alive** — no ladder, no tower, no gate. Then rides west
along the inside of the city to −68.6 m.

The census was right and the simulation was right. A footing is a course of masonry at ground
level, so the horse is not walking through stone; it is riding through the part that has not
been built. The commit's own conclusion: *"That is a legitimate route into Rome and it is the
only one the AI ever finds. Recorded here rather than acted on."*

For contrast, Carthage's circuit is passable at exactly eight points — measured the same way
at `6698e19`, eight bands about 4 m wide, each centred on one of the eight posterns at
x −772.9, −532.8, −292.7, −52.5, 187.6, 427.7, 667.8 and 907.9. Those are open on purpose: a
casemated wall is a wall you can walk through, and they are published as `GateOut`s that are
already `open`. Its three *gates* — `porta-byrsae` at x 0, `porta-uticensis` at +560 and
`porta-maritima` at −560 — are all shut at t=0, which is what `GATE_PICK_R = 55 m` (§4.4) is
sized against: 560 m apart, a 55 m pick radius cannot choose the wrong one.

### 2.9 What the parapet is worth: `masonryTopAt`

A garrison is on a wall in order to shoot from it, and the one function that decides whether a
missile gets out is `CitySystem.masonryTopAt(x, z)` — the top of solid stone at a point, called
once per projectile per tick. It is arithmetic, not a raycast, and its structure is the whole
of how a battlement behaves:

1. inside the **gatehouse block**, defer to `gateTopAt` (§5.4);
2. Carthage's **forward lines** first if the city publishes `outworkTopAt`, so a bolt lofted at
   the outer wall does not pass through two lines of masonry — one null check on Rome;
3. outside `bay.halfThickness` of the bay centreline, `-Infinity` — nothing there;
4. an **unwalkable** bay (`footing`, `gap`) reports `unfinishedTopAt` against the *local*
   ground, because the work follows terrain that can vary by ten metres across a 35.5 m bay;
5. a **`no-parapet`** bay reports `bay.walkY` flat — dressed merlon blocks are five stacks
   waiting on the walk, not a crest;
6. **inboard of the parapet**, `bay.walkY` — the surface a lofted shot has to land on and an
   onager stone breaks on;
7. **in the parapet band**, alternate merlon and crenel along the run.

Rule 7 is why a garrison can shoot at all. With the parapet modelled as a solid 2.05 m
barrier, a defender's own bolts — released 1.45 m above his feet — struck it on the way out,
and every stone lobbed at the garrison broke on the battlement instead of landing among them:
**491 missile impacts on our own masonry in one minute** of a battle in which the garrison
never once had a clear lane.

And rule 7 is also where the nominal period is not good enough. `crenellation()` fits a whole
number of merlons to a run and rescales — Rome's built step is **2.7308 m against a nominal
2.65**, Carthage's 2.2769 against 2.35 — and it centres each merlon in its step, so half a gap
stands at each end of a bay and a whole gap straddles every joint. Measured against the stone
at 1 mm, the nominal model agreed on **36 % of Rome's parapet**: worse than a random phase,
because 0.08 m of drift per period walks the model a whole merlon out of register by the far
end of a bay. Arrows stopped in mid-air over embrasures and passed through solid merlons.

It was invisible to every instrument aimed at it, because only the merlon *fraction* survives
the rescale exactly — anything that bins along x, or counts stone against air over a whole
bay, comes out right. `crenellationRun` is the generator's own arithmetic, resolved per bay at
build time into `crenStep[]` and `crenMerlon[]`, so the hot path stays a compare and a floor.

`embrasureAt(x, z)` is the other half of the same arithmetic, published so a shooter can *step
to a gap* rather than loose from wherever he happens to stand — 64 % of the run is tooth. It
answers on a `no-parapet` bay too, with `hasParapet: false`, because "there is no tooth here"
is an answer a shooter needs; returning null for it left a rear rank ploughing shots into its
own walkway.

---

## 3. `WallGoal` — orders about a wall

### 3.1 The five goals

```ts
const enum WallGoal {
  Hold = 0,      // nothing; a garrison standing where it stands
  Ascend = 1,    // get onto the wall at destStation, from the ground, via stair
  Traverse = 2,  // move along the wall to destStation, through whatever links are between
  Descend = 3,   // get off the wall to (gx, gz), via stair
  Storm = 4,     // storm a practicable breach: outside ground, up the rubble, down inside
}
```

A `WallPlan` is `{ goal, destStation, destRun, stair, gx, gz, age, stuck }`, held in
`plans: Map<unitId, WallPlan>`. `Hold` is the absence of a plan, not an entry in the map.

| Goal | Formed by | Refused when |
|---|---|---|
| `Ascend` | `sendToWall(u, x, z)` | the nearest station is dead, or no stair link reaches its run |
| `Traverse` | `moveAlongWall(u, x, z)` | the unit is not garrisoned, no wall there, or `runsConnected(from, to)` is false |
| `Descend` | `sendToGround(u, x, z)` | the unit is not garrisoned, or no stair is reachable |
| `Storm` | `stormBreach(u, gx, gz)` | `breachLinks` is empty — which it always is (§7.1) |

`traverseOfferAt` and `escaladeOfferAt` publish the same answers, pure, so the cursor can say
"no route" before the click. The `moveAlongWall` refusal was added against a measurement:
**152 of 152 men frozen with the plan still open at age 3,656**, with nothing said to the
player at any point.

### 3.2 Retirement

`advancePlans()` runs once per tick per plan and puts every man into exactly one of three
states: on a path (leave him alone, `advanceLinks` owns him), arrived (lay him out), or
transiting (queue him at the mouth of the next link).

A plan retires two ways:

- **`moving === 0`.** Nobody is in motion. A `Descend` or `Storm` calls `releaseToGround`,
  which clears `elevated`/`support`, hands the unit back to `steerToSlots`, and — critically
  — points `u.targetX/targetZ` at the rally point. Without that last step
  `trackOwnedAnchors` would have left the target sitting at the foot of the wall on the city
  side, which is exactly the signature the auto-ascend rule looks for, and the cohort would
  about-face and climb straight back up for ever.
- **`plan.age > PLAN_TIMEOUT`** — 18,000 ticks, ten minutes at 30 Hz. A legitimate traverse of
  six bays and five towers is about four.

Men the plan cannot move are counted in `plan.stuck` and **left standing exactly where they
are**. The first version pushed them into `arrived`, which handed them to `layOutArrived`,
which lays men out around `plan.destStation` on the *destination* run — reintroducing the
3.62 m teleport by way of a convenience.

### 3.3 How an order reaches the wall at all

Two paths, and the first one exists because of a defect that points nowhere near its cause.

**The event path.** `Siege.init` subscribes to `orderIssued` and records the clicked point in
`ordered: Map<unitId, {x, z}>`, consumed inside `preSteer` so every mutation stays in the
fixed step. Both the mouse and `src/ai/Orders.ts` emit it, so a defender told to fall back and
an attacker's lodgement told to come down into the streets are one code path.

Why it cannot read `u.targetX/targetZ` instead — logged live for a cohort of 108 men on the
parapet, immediately after a real move order to a rally point 62 m away inside the city:

```
before-click       order Garrison  target 61.2,529.4  moved 0.07  -> order===Garrison
after-applyOrder   order MoveTo    target 61.2,529.4  moved 0.07  -> moved < ORDER_JUMP
tick+1..tick+8     order Garrison  target 61.2,529.4  moved 0.00
after-120s         onWall 108, onGround 0, goal none, stair crossings 0
```

`u.order` became `MoveTo`, so `applyOrder` plainly ran, and the target did not move a
centimetre. `BattleSystem.holdShortOfSolid` is what makes both true: a garrison's anchor is
*inside* the curtain's footprint, so `clearLineFraction` from it is 0 and the order is clamped
to the unit's own position. The clamp is right for a field unit and must not change; the fix
is to stop reading the clamped value.

**The polling path**, for anything that did not arrive as an event. It compares the order
destination against `Garrison.lastTx/lastTz` and requires a jump of `ORDER_JUMP = 4 m`.
`BattleSystem.updateUnitOrder` changes `u.order` on its own every tick — coming into contact,
resuming a route, breaking off — so "the order is no longer `Garrison`" is not a proxy for
"the player clicked". Measured: a cohort sent up a stair was owned with a live `Ascend` plan
at the instant the order was given and **five seconds later had no plan and was no longer
siege-owned**, because the loop read the sim's own order flip as a fresh click, converted the
ascent into a descent, found every man already on the ground and released the unit.

A third loop catches a unit that is not on the wall and has been ordered *into* it. It is
restricted to the **city side** (`sideOf(u.x, u.z) === -1`): a besieger at the foot of the
outer face is not entitled to the defenders' stairs; he comes over a ramp, up a ladder or
through a breach. Which is `escalade` (§4.1).

### 3.4 "Is this unit on the wall" is a question about where its men are

`ON_WALL_FRACTION = 1 / 3`. A unit counts as on the wall when at least a third of its living
men are standing on stone (`standingOnWall`), not because it has an entry in `garrisons`.

The first attempt at this was a timeout, and the file is explicit that the timeout was wrong.
Rome: 152 men ordered down, 143 on the terrain, 9 still on the stone, plan open at **age
9,111** — five minutes in which the unit stayed `garrisoned`, so the next order was read as a
traverse and it could not be sent back up. Ending the descent early would have called
`releaseToGround`, which clears `elevated` and `support` for *every* man, dropping the nine
still on the parapet at **313 m/s**, and would have cut off a legitimate 106.8 s descent at
20. So the plan is left alone and the question is fixed instead. (A `DESCENT_STALL` constant
appears in commit `8277bb7`'s message; it does not exist at `6698e19` — it was superseded by
this.)

### 3.5 The queue-index trap

This is the one to know about, because it has now been paid for three times in three
different costumes and the file names the shape: **two pieces of code answering one question
with two slightly different tests.**

The wall-order instance. `advancePlans` used to hand `queueAtLink` and `footSlot` its running
`moving` tally as the queue index. That tally counts every man of the unit who is in motion —
men already on a crossing, men queued at a *different* doorway, men bound for the far end of
the curtain. `queueAtLink` parks index `q` at `floor(q / MAX_WALL_RANKS)` stations back and
rank `q % MAX_WALL_RANKS` in; `pickWaiting` admits only a man within `LINK_ADMIT = 2.00 m` of
the mouth.

> Measured on a 53-man cohort ordered off the parapet: twelve men crossed the tower pass, and
> from that moment the head of the file behind them sat at station +2, rank 4 — **2.26 m from
> a mouth with a 2.00 m admission radius** — where it stayed for the rest of the battle.
> Forty-one men, no plan failure, no timeout, nobody stuck by the geometry. It is
> self-reinforcing: every man who gets onto the path pushes the next one further back.

The fix is `fileIndex(linkId, dir)`, which reads the length of the `waiters` bucket for *that
mouth and that direction*. `waiters` is rebuilt from scratch every tick by `advancePlans`,
which is already walking exactly these men, so the count already in the bucket **is** the
man's place in the file. It is shared across units on purpose: two cohorts changing places at
one tower door form one queue, which is what `advanceLinks` already assumes when it admits by
proximity rather than by unit.

The ascent had the identical defect and it bit harder, because `footSlot` steps back 0.85 m
per row against the same 2 m radius — index 12 stands 4.2 m out. `footSlot` also carries a
second measured constraint: four abreast at 0.9 m centres put files 0 and 3 of the first row
at `hypot(0.9, 1.35) = 1.62 m` from the foot, so at the *start* nobody was in range and the
file deadlocked — *"0/160 men on the wall, men were observed on a stair path on 0 ticks"*.
Three abreast at 0.8 m and 0.7 m back puts the worst first-row man at 1.06 m.

> The inline comment in `footSlot` reasons against "the 1.5 m admission radius". `LINK_ADMIT`
> is 2.00 m at `6698e19`; `ADMIT_RADIUS`, which governs crossings rather than links, is 1.6.
> The 1.5 is stale. The arithmetic it supports (1.62 m out, 1.06 m out) is unaffected.

The same shape, elsewhere in the same file:

- `musterOwned` and `stepCrossing` used different tests for "who is in this file", so a routed
  escalade party occupied rows 0–14 at the foot of its own ladders while refusing to climb
  them, and the player's cohort was laid out behind it, **14.6 m from a 1.6 m admission
  radius**. The fix is `mayBoard`, one predicate, now also used by `updateTowers` to decide a
  file is empty.
- `machineOrderAt` (the cursor) and the order that moves the machine both call
  `resolveMachineOrder` and nothing else. `src/ui/SiegeOrders.ts` states the rule in its
  header: **one predicate, shared**.
- `escalade` and `escaladeOfferAt` both call `findEscalade`.

### 3.6 The AI is the other caller

`src/ai/WallDoctrine.ts` exists because the tactical layer was issuing wall orders *by
accident and getting them wrong*. `Siege.interceptOrders` reads a garrison's ordinary move
order as "come down off the wall", and `MarchToStation` tells every unit it commands to dress
on a station behind the curtain. Measured on the storm of Carthage with both armies on the AI:

```
t+87   garrison 448 on the parapet, eight of ten wall units carrying goal=descend
t+250  garrison  69 on the parapet
```

The Carthaginian garrison walked off its own wall, one bay at a time. It did not die on the
walk; it left.

So the doctrine does two things: it stops the field mover steering a unit the stonework owns
(`TacticalAI` returns early for any unit `wall.isGarrisoned` reports), and it puts a
deliberate `Parapet` behaviour in its place. Four rules, side-agnostic, because a defender
rolling up a lodgement and an attacker rolling up a garrison are the same manoeuvre:

1. an enemy on the parapet within `FIGHT_R = 30 m` — hold and fight where you stand;
2. an enemy on the ground **inside** the curtain with at least `BREAK_IN_MEN = 25` men, within
   `DESCEND_R = 260 m` — go down the stairs at him;
3. an enemy on the parapet within `REACH_R = 150 m` — walk the wall to him;
4. otherwise hold. A garrison with the enemy still outside is doing its job.

Rule 2 outranks rule 3 on purpose: clearing the last defender off a mile of curtain is about
four minutes a bay and is not what the player asked for.

`BREAK_IN_MEN` is a threshold rather than a trigger because the cost is asymmetric. Measured
at Carthage with no threshold, twenty-three Romans scattered inside the curtain pulled two
Punic cohorts — 63 and 46 men — off the parapet, and both descents were still open at t+250
with **one man each left on the stone**, holding the plans alive at ages 5,333 and 4,252 ticks.

`ORDER_COOLDOWN = 60` ticks exists for a reason `OrderBook` cannot cover: `reconcile` drops a
remembered move whenever the unit's own order disagrees with it, and `Siege.interceptOrders`
*always* puts a wall unit back on `UnitOrder.Garrison` the instant it has read the order. So
the book forgets on the next tick, the behaviour re-issues, and `sendToGround` builds a fresh
plan with `age = 0` six ticks later — for ever. The plan timeout can never fire and the
descent never completes.

`issueWall` emits **one point in one event**, deliberately not through `moveTo`. `moveTo`
answers with a route whenever the straight line is blocked, and the straight line off a wall
always is; `followPath` then emits the first leg unqueued and the rest queued, while `Siege`
reads the first unqueued point as the whole intent and ignores queued ones. A routed descent
would be aimed at whichever nav-grid corner the route turned at. One point in one event is
also exactly what the player's right-click produces, which is the path the feature was
verified on.

`tools/probe-wallai.mjs` grades the consequence rather than the plumbing: men on the parapet
by faction, how many of them are *frozen* (net displacement under 0.5 m over 10 s — because
the known failure is a man walking 1.4 m/s into a friendly back with zero net travel), and how
many storming men are on the ground inside the curtain.

---

## 4. The siege train

Every machine is drawn with one instanced mesh per part, however many there are. Capacities:
`MAX_TOWERS = 6`, `MAX_RAMS = 2`, `MAX_GREAT_RAMS = 2`, `MAX_LADDERS = 24`. Casting is
deliberately partial — the shaft, the deck, the ram shed and the great ram shed cast; the
ladder rungs, wheels and plank ramp do not, because every casting mesh is re-rendered once
per cascade plus the depth prepass. Measured by hiding the siege group at the worst siege
camera: 291 draws → 246.

`MAX_BOARDING_UNITS = 4` caps how many units may queue at one machine, crew included.

### 4.1 Ladders and escalade

`spawnLadder(x, z, unitId)` solves the lean so the head lands on the parapet. The scenario
raises three per escalade party, spread across the bay's frontage at ±7 m.

`escalade(u, x, z)` enrols a unit on a *bank* of ladders (every ladder of one party) or on a
tower, whichever is nearest within `ESCALADE_REACH = 20` stations of the clicked one — about
17 m either side at the 0.86 m pitch, so roughly half a Roman bay. Wide enough that a click
anywhere on the frontage enrols on the right machine; narrow enough that a click at one end
of the wall cannot enrol men on a ladder out of sight at the other. A *bank* rather than one
rail because `musterOwned` round-robins a party's ladders and admission must agree with the
muster.

`findEscalade` is the one predicate, and its refusals are separate sentences because they have
separate answers:

| Refusal | Meaning |
|---|---|
| `crew` | this unit is working a machine of its own and never will be free |
| `notFoot` | `unitClass` is `artillery`, `heavy-cavalry` or `light-cavalry` |
| `noWall` | nothing to climb toward |
| `noWay` | nothing in reach — bring a ladder or a tower |
| `full` | every file at that bay already has `MAX_BOARDING_UNITS` |

`notFoot` exists because a hand run put **26 horsemen standing on the parapet**, and ballistae
were being admitted to boarding files as well. It tests `unitClass` rather than a list of type
ids so the next mounted or wheeled unit is excluded the day it is added.

Anybody may climb, but not at the same speed. `ESCALADE_PACE = 0.72` applies per soldier to
anyone who is not of the party that raised the machine — about forty seconds against thirty
on an 8 m ladder. `crossPace` is per-soldier rather than per-crossing because one ladder
carries men of two or three units at once, in one file.

`escaladeOfferAt` additionally publishes `ready`, `machineDistance` and `machineSeconds`. A
tower still crossing the glacis is a *legal* escalade target — the men walk out with it and go
up when the ramp falls — and that is why a cohort given a storm order stands in an open field
for four minutes with nothing apparently happening. The cursor now reads
`Queue at the tower — it reaches bay <n> in <t>`, with `<t>` formatted by the same `clock()`
the machine hints use.

### 4.2 Siege towers

```
TOWER_SPEED      0.42 m/s    a slow walking pace; 120 m of glacis in five minutes
TOWER_SLEW       0.09 rad/s  a right angle in seventeen seconds
TOWER_HEAVE      14 s        stationary while the gang shifts the rollers after a re-aim
TOWER_COMMIT     12 m        inside this it will not be turned
TOWER_BERTH      8.4 m       (TOWER_HALF_W * 4) minimum separation between two dock points
TOWER_IDLE_LIMIT 20 s        docked with an empty file before it is Spent
RAMP_FALL        2.2 s
```

States: `Approach → Docking → Landing → Boarding → Spent`.

`aimTowerAt(t, station)` solves every docking number in one place, so a tower the player
re-aims docks to the same standard as one the scenario placed:

- **standoff** `= sFace[station] + 0.32 + TOWER_HALF_D`. Measured from the *face*, not from the
  bay centreline. The first version used a flat 1.05 m from the centreline, which put the
  front of the machine 0.70 m inside the brickwork on all four towers.
- **`deckY` = `sy[station] + 0.55`.** Knowingly wrong, and reverted work, and the file says so:
  a blind critic observed that "the platform floor sits at the base of the merlons with the
  roof below their tops — an assaulting soldier would have to climb out and over unaided".
  Raising it to `sCrest + 0.3` docked and measured correctly (deck 45.25 against a walk at
  42.90, ramp head level to within a centimetre) and **boarding then stopped dead**: four
  towers in `boarding`, every crew alive and standing 0.5 m from the mouth of the crossing,
  not one man admitted. A tower that looks better and delivers nobody is worse than one that
  looks squat and works. The probe assertion `infantry cross the ramp onto the wall` is what
  caught it and is what should guard the retry.
- **ramp** cut to the span it actually has to bridge — `rampReach = hingeOff − sOuter`, about
  1.64 m on this curtain, not the 3.4 m the geometry is authored at. A correctly-yawed 3.4 m
  ramp overshoots the walkway's cityward lip by 1.6 m and cantilevers over the street.

A tower nobody is pushing does not roll. `t.x`/`t.z` used to advance every tick with no
reference to whether the crew existed — reported from a playtest as "the ram gets routed and
the people flee yet it keeps moving forward". The mesh follows because `writeTowers`
positions from `t.x/t.y/t.z` rather than from the crew's anchor.

`TowerState.Spent` was declared and never assigned. A machine went
`Approach → Docking → Landing → Boarding` and stayed at `Boarding` for the rest of the battle
whether its file had crossed, died or never existed — reported as four towers frozen at
`boarding` at **t+904**. It was not cosmetic: `crewsAMachine` stayed true for the gang for
ever, so the cohort that pushed it could never be given another order; `escalade` skips a
spent tower but not a boarding one; and the berth was never released. Twenty seconds rather
than one tick, because the file empties and refills between cohorts. The emptiness test is
asked with `mayBoard`, the same predicate `stepCrossing` admits by.

`buildTowerCrossing` is five legs: to the back door, up the internal zig-zag stair, forward
across the deck, out along the ramp, and one pace clear of the ramp head onto the stonework.
The climb happens inside the hide screen, which is why a straight vertical rise reads
correctly.

### 4.3 The ram

```
RAM_SPEED   0.55 m/s
RAM_HEAVE   6 s          against the tower's 14 — a shed on four wheels, not a 15 t frame
RAM_SLEW    0.16 rad/s   a right angle in nine seconds
RAM_PERIOD  4.4 s        seconds between blows at full crew
GATE_BLOWS  26           twin oak leaves, iron-bound
GATE_PICK_R 55 m         how near a gate a click must land to mean that gate
```

States: `Approach → Battering → Withdrawing → Spent`, plus `Wreck`.

Three of the five states exist to stop one outcome. A ram that breaks a gate and then sits in
the hole corks the only way in, cannot be killed and cannot be moved, so an assault stalls on
its own success — reported by the player in those terms. `Withdrawing` is the answer.
`beginWithdraw` backs it straight down its own axis by `RAM_HALF_D * 2 + 9` m. The precise
mechanism is worth stating because it is not what it looks like: the shed is not a physical
obstacle — the sim's only obstacle source is the city — so the machine never stopped anybody.
What stopped them was the *crew* — the file's own words are "eighty men mustered on a machine
standing in a 4.3 m carriageway, in a melee they could not disengage from". Backing the
machine off the threshold takes its muster points with it, which takes the crew out of the
gateway, which is what actually clears the road.

**The target is carried on the machine.** `SiegeRam.gateId` is never a literal. `armGate`,
`spawnRam` and the breach all used `getGates()[0]` while the breach itself once said
`'porta-flaminia'` out loud — and on Carthage, which has no such gate, the ram landed all
twenty-six blows into a carriageway that stayed solid for the rest of the battle. Blows are
counted in `gateBlowsBy: Map<gateId, number>` rather than one running total, because Carthage
has three gates plus eight posterns and a re-aimed ram would otherwise carry its blows across
to fresh timber.

The gate starts **shut**, and `armGate()` does it on the first tick rather than in `init`.
`CitySystem` clears the carriageway unconditionally as part of its own build and that clear
lands *after* `BattleSystem.init`, so setting the flag in `init` produced a state that
reported itself correct while being wrong: `blocksMovement` straight through the gateway
returned false at t=0 while a manual open-then-shut toggle in the same session returned true.
`armGate` therefore forces the mark rather than trusting the flag.

When the twenty-sixth blow lands: `setGateOpen(id, true)` (which re-paints the occupancy
raster and re-cuts the curtain's oriented boxes), `setGateDoorBroken(id)` (visual only — it
swaps the intact leaves for the wrecked pose, writes no raster and no obstacle, and is a
no-op on the two Carthaginian gates with no modelled leaves), an `objectiveChanged` event
naming the gate, and `beginWithdraw`.

### 4.4 Machine orders, and quoting the price before the click

`SiegeMachineOrder` is what a right-click at a point *would* do, and it is pure.
`machineOrderAt` draws it and `applyMachineOrder` carries it out; both go through
`resolveMachineOrder` and nothing else.

Ten refusals, each a sentence the player can read before committing:

`none · landed · committed · already · taken · noWall · noGate · wrongTarget · spent · unmanned`

The tower's refusals are the character of the machine — fifteen tonnes of green timber is
meant to be hard to redirect — but a silent refusal is not character, it is a broken button.
`taken` tests **by bay as well as by metres**: a click meant for "the bay that tower is
taking" resolved 94 m along the wall and was accepted, because the ray lands wherever the
parapet happens to be under the cursor and a bay is 35.5 m of curtain. A bay is the unit the
assault is echeloned in — `deployAssault` aims four towers at four *adjacent* bays, one
apiece — so one machine per bay is both what the deployment already does and what the
sentence says.

Two thresholds govern what a click means:

- `wallTargetAt` is the strict test — inside the standing band widened by
  `WALL_CLICK_BAND = 1.7 m` either side, and within `STATION_PITCH * 1.5` of a station along
  the run.
- `nearWallStation` is the loose one, `MACHINE_AIM_R = 30 m`, for the case the ray landed on
  the glacis at the foot of the masonry. Without a cap, `stationNear` — a nearest-neighbour
  search with no distance limit — always answers, and a click on open grass three hundred
  metres away resolves to "the bay at the far end".

`SiegeMachineOrder.seconds` is published by the sim rather than left to the UI, because the
divisor is a property of the machine: `distance / speed + heave`. `src/ui/SiegeOrders.ts`
renders it through `clock()`, which switches from seconds to minutes at 90 s, and the hint
reads e.g. `Roll the siege tower to bay 21 — 248 m, 10 min 4 s`.

That sentence exists because of one playtest number. A player re-aimed a tower and measured
**590 s** before it reached the new bay. At `TOWER_SPEED = 0.42 m/s` that is exactly 248 m of
rolling, and it is not a bug — the owner asked for a gang on levers and rollers moving fifteen
tonnes of green timber, and got it. What was wrong was that a cost of ten minutes was
discovered after the click instead of quoted before it.

> Commit `a06419f` quotes the resulting hint as "248 m - 9 min 50 s", which is the 590 s of
> rolling alone. `describe()` adds `TOWER_HEAVE` unconditionally for a fresh order, so the
> string a player actually sees for that order is 10 min 4 s. `machineDestinationOf`, which
> answers "where is it already going", is the call that quotes the *remaining* run plus only
> the heave still outstanding — and that one can read 9 min 50 s.

Player machine orders are queued through `requestMachineOrder` and applied at the top of
`interceptOrders` on the next tick, so every mutation happens inside `fixedUpdate` and the
battle still replays identically. They are applied *before* the move-order loop, because a
right-click with a tower party selected also emits an ordinary `orderIssued` and the tower
branch would otherwise re-decide the same order in the same tick — two heaves for one click.
They are deliberately **not** wired to `orderIssued`: `src/ai/Orders.ts` emits through the same
channel, and an AI that drags the ram off the gate every few seconds is worse than no order.

### 4.5 Recrewing and dereliction

`RECREW_RADIUS`, `DERELICT_LIMIT = 40 s`. A derelict machine looks for the nearest formed body
of the right side that is not already doing something a siege engine cannot interrupt, and
deliberately not a unit in contact.

> The constant is `95` at `6698e19`; its own comment reasons about "55 m". Stale.

---

## 5. Sim vs. picture: one class of defect, four instances

### 5.1 The ram landed nothing on Rome, in twelve runs of twelve

The symptom: on the Campus Martius the ram lands **zero** blows and the gate is never touched,
in twelve runs of twelve. The owner's first hypothesis was "perhaps they all die."

The instrument: wrap `BattleSystem.damage` and attribute every point of it to the unit that
dealt it (`tools/scratch/so-ramkill.mjs`, and `tools/probe-killcredit.mjs` for the general
case). Recorded in commit `64dfb88`:

> The crew is 32 men at t+0 and 6 by t+40, and **4,846 of the 4,846 points that killed them
> came from two units** — `ballistarii#0` and `ballistarii#1`, shooting from 53–60 m.

Those two units are 216 hand-spanned crossbowmen — of the five `ballistarii` units, 540 men,
that `GARRISON_PLANS[Faction.Rome]` fans out either side of the gate — shooting at 62 damage
and 40 armour-piercing a bolt. The ram is the nearest thing on the field because it spawns
62 m out on the gate's own axis while the towers start at 74, 83, 92 and 101 m — both figures
straight out of `deployAssault`. The same instrument on Carthage, whose garrison carries a levy
and slings, records **the identical machine taking zero damage on the identical approach** and
battering the gate down on schedule.

So it is not the ram, not the pathing, not the targeting and not the gate. It is that a
*testudo arietaria* — a shed on wheels whose entire purpose is keeping missiles off the men —
had its shed **drawn in the art and never modelled in the simulation**. The gang worked the
ropes in the open.

The fix is one constant and one function:

```ts
const RAM_SHED_COVER = 0.12;

private applyShedCover(): void {
  const want = new Set<number>();
  for (const r of this.rams) {
    if (r.wreck || r.state === RamState.Wreck || r.state === RamState.Spent) continue;
    if (!this.owned.has(r.unitId)) continue;
    want.add(r.unitId);
  }
  for (const id of this.sheltered) {
    if (want.has(id)) continue;
    modsOf(id).missileTaken = 1;
    this.sheltered.delete(id);
  }
  for (const id of want) {
    modsOf(id).missileTaken = RAM_SHED_COVER;
    this.sheltered.add(id);
  }
}
```

It is applied per tick to whichever gang is working a live ram, and taken off them the tick it
stops being theirs, because `recrew` reassigns mid-battle and doing it at spawn would leave a
dead unit sheltered and a live one exposed. It multiplies into missile damage at
`src/sim/Projectiles.ts` alongside the formation's own `missileTaken`, so it stacks with
whatever formation the crew is in. It is applied to the *gang*, not to the machine, because
what a roof protects is men.

0.12 rather than 0.2, and the difference is not a feeling: at 0.2 the crew broke at 21 blows
with the gate still on 19 % hp. The number is sized against the machine finishing its work.

The commit is explicit that this **moves Rome's determinism baseline deliberately** — a battle
in which the ram now opens the gate is a different battle. Carthage is untouched, because zero
damage times any multiplier is zero.

Rome's schedule after the fix is pinned as a regression baseline in
`tools/scratch/so-ramline.mjs`. **Reproduced at `6698e19`**, driving the assault under autoplay
and sampling every 5 s, it holds to within one sample interval:

| Event | `64dfb88` (ultra) | reproduced (`quality=low`) |
|---|---|---|
| ram reaches the leaves (`Battering`) | t+100 | t+100 |
| first blow | — | t+105 |
| blows landed | 26 | 26 |
| gate open, `Withdrawing` begins | t+220 | t+215 |
| `Spent` | t+260 | t+255 |
| crew at the breach → at spend | 32 → 24 → 13 | 16 → 13 → 5 |

The crew figures differ because `fittedUnitScale` halves unit strengths at the `low` tier;
the timings do not, because they are governed by `RAM_SPEED`, `RAM_PERIOD` and `GATE_BLOWS`.
At t+280 in the same run the crew count jumps to 81 — `recrew` has put a warband on the parked
machine, which is `RECREW_RADIUS` working as designed on a machine that no longer has any work
in it.

> The comment on `RAM_SHED_COVER` still reads *"0.2 is a shade weaker than the `testudo`
> formation's own 0.16"*. The constant is 0.12, which is **stronger** than testudo's 0.16
> (`src/sim/formations.ts`). Both halves of that sentence are stale; the commit message has the
> reasoning that survived.

### The pinned schedule above no longer holds, and it stopped holding before the ladder fix

Re-run of `tools/scratch/so-ramline.mjs` against `rome`, `quality=high`, at `d128adf` with
`src/` untouched — that is *main*, with no branch applied:

| | pinned above | measured at `d128adf` | after `e/sim/ladder-queue` |
|---|---|---|---|
| blows landed | 26 | **24** | **12** |
| gate | open at t+220 | never opens, 8 % hp | never opens, 54 % hp |
| crew | 16 → 13, never routs | **routs at t+220**, 7 men | **routs at t+160**, 15 men |

Two separate findings, and they must not be merged into one:

**The first is not attributable to the ladder work.** On main today the ram lands 24 of the 26
blows it needs and its gang breaks two short, with the leaves on 8 % hp. The brief that
`so-ramline.mjs` carries — *"any movement in these figures is a regression rather than a
decision"* — is therefore already being violated by something that landed between `6698e19`
and `d128adf`. Nobody has been told. Whatever moved it did not move it far, which is exactly
why it survived: 24 blows and 8 % hp looks like the gate is about to go, and a reader watching
the battle would see the ram working and assume it finished.

**The second is.** Releasing a routed gang from its machine — the correctness fix — costs a
further twelve blows, because the gang now stops swinging the moment it breaks instead of
continuing to work the ram while routing. The gate ends the battle at 54 % rather than 8 %.
This is a real balance consequence and it is stated here rather than absorbed, because a ram
that cannot open a gate is a scenario that no longer has a second way in.

Neither figure has been "fixed" here. The table above is left as it was written so the drift
stays legible; this note records what the instrument actually reports.

### The first movement, bisected: `89e7a44`, and it is one line

`git bisect` over the 40 commits of `6698e19..d128adf`, with `tools/scratch/so-ramline.mjs`
as the test (good = 26 gate blows *and* `open=true`; the 166 ms stepping idiom held constant
across every step, because `advance(dt, 166)` is a different battle from
`advance(dt, 1000/60)` and a bisect that varies it measures the harness):

```
6698e19  good  26 blows  open  gate 0%      c6d5544  good  26 blows  open
3ff6d41  good  26 blows  open              7dfe072  bad   24 blows  8% hp
89e7a44  bad   24 blows  8% hp             8f26f7f  bad   24 blows  8% hp
first bad commit: 89e7a44
```

**The tier was constant, and the tier is not the story.** `so-ramline.mjs` pins
`quality=high` in its own URL, so every bisect step and every control below ran at one tier —
which matters, because `fittedUnitScale` makes each tier a different order of battle rather
than a quality slider. Re-measured explicitly, because "the pinned figure may simply never
have been true at the tier the game is played at" is the right question to ask:

| Rome's assault | pool | Rome alive at t+300 | blows | gate |
|---|---|---|---|---|
| `6698e19`, `quality=high` | 3,074 | 933 | 26 | open t+220 |
| `6698e19`, `quality=ultra` | 3,074 | 933 | 26 | open t+220 |
| `3ff6d41`, `quality=ultra` | 3,074 | 933 | 26 | open t+220 |
| `89e7a44`, `quality=ultra` | 3,074 | 1,014 | **24** | 8 % hp |

**`high` and `ultra` are the same battle here** — 3,074 men fits under both caps (10,000 and
12,000), and the two arms agree line for line — so `high` is a faithful proxy for the tier the
game ships at, and the boundary lands on the same commit at both. The ram did *not* already
fail at ultra at r6. `medium` and `low` genuinely are different scenarios and their numbers
are not comparable with these; the `quality=low` column in the table at the top of §5.1 is
labelled as such for that reason.

At the boundary, same probe, same port, same idiom, `quality=high`:

| | `3ff6d41` (parent) | `89e7a44` |
|---|---|---|
| crew at t+80 / t+100 | 31 / 30 | 27 / **23** |
| blows at t+200 | 22 | 22 |
| t+220 | `withdrawing`, 26 blows, gate **open**, crew 25 | `battering`, 24 blows, 8 % hp, crew **7 ROUT** |
| t+260 | `spent`, crew 8 | `wreck` |

**Of the four seam fixes in `89e7a44`, exactly one reaches the simulation, and it is the
gatehouse station clip.** Two controls, both run at one commit so nothing else can vary:

- *Negative* — at `89e7a44`, with `insideBlock` forced to `return false` (the pre-fix
  behaviour, everything else the commit did left in place): **26 blows, gate open at t+220,
  crew 25 → 22 → 8**, digit for digit the `6698e19` line. So the audio `ProjectileFeed`, the
  `WaterSurface` ordering fixes and the `src/core/seams.ts` boot check are all sim-inert.
- *Positive* — at `3ff6d41`, with nothing applied but `insideBlock` reading the block's own
  `dx/dz/nx/nz/halfRun/halfDepth` frame: **24 blows, gate never opens, 8 % hp.**

**It is a consequence, not a defect.** The mechanism, measured with
`tools/scratch/so-ramkill.mjs` at `89e7a44` with the clip on and off — same commit, same
seed, same stepping, damage attributed at `BattleSystem.damage` rather than sampled:

| to the ram crew, by t+140 | clip off | clip on |
|---|---|---|
| crew at t+100 | 30 | 23 |
| crew deaths | 2 | 9 |
| damage from `ballistarii#0` | 933 | **1,694** |
| damage from `ballistarii#1` | 583 | 559 |
| killer's range | 19–26 m | 22–36 m |

One unit, at the same range, landing 82 % more damage; its opposite number across the gate
unchanged. That is the signature of men who were standing *inside* the gatehouse — `walkY`
35.75 with the crown at 42.324, 6.574 m of masonry over their heads and the curtain cut out
from under their feet by `curtainSpans` — being re-laid on stone they can shoot from. The
clip is also geometrically sound: it removes stations within `halfRun` = `GATE_BLOCK_W/2` =
12.5 m of the gate axis, against a curtain that is absent over `GATE_CLIP_HALF` = 12.2 m, so
it over-clips by 0.3 m a side — under half a `STATION_PITCH` — and the 25 m gap it leaves
correctly severs bay 19's run at the `STATION_PITCH * 1.9` test, because there is no crown
run to walk across yet.

So `RAM_SHED_COVER = 0.12` was sized at `64dfb88` against a garrison in which a fifth of the
gate bay was firing into its own gatehouse. **The ram's 26 blows was never a property of the
ram; it was the difference between two systems, one of which was wrong.** Removing the
compensating error left the ram two blows short, and then `releaseBrokenCrews` drops the
broken gang from `owned`, `applyShedCover` puts `missileTaken` back from 0.12 to 1, and the
remnant goes 21 → 7 in twenty seconds standing in the carriageway.

> **The "16.1 % more lethal" figure has a source and it is being misused.** It is
> `89e7a44`'s own before/after — garrison kills over 240 s on Rome at seed 4265438264,
> **453 → 526** — restated at `docs/HANDOFF.md:1787` and `docs/video/SHOTLIST.md:263`. It
> describes `3ff6d41 → 89e7a44`. `58ea126` could not reproduce it because it measured a
> different delta: the *escalade* fix's own before/after, on which the sign reverses with
> sample time. Both measurements are right about different changes. Neither is a scalar to
> re-baseline on.

### What it would take to land 26 blows again — priced, not done

Measured with `tools/scratch/so-ramline.mjs` at `quality=high`, one arm each. Main moved twice
more while this was being written, which is itself the finding:

| main at | `RAM_SHED_COVER` | blows | gate | crew |
|---|---|---|---|---|
| `45dd19c` | 0.12 | 12 | 54 % hp | routs t+160 |
| `45dd19c` | **0.08** | **26** | **open at t+220** | routs t+260, wreck by t+300 |
| `88a4aa5` (after `8b8eb1f`) | 0.12 | 23 | 12 % hp | routs t+220 |
| `88a4aa5` | **0.08** | **26** | **open at t+220** | routs t+240, wreck by t+300 |

`8b8eb1f` — "men at a wall foot cannot get clear of it" — moved the ram from 12 blows back to
23 without anybody saying so. That is the *third* unannounced movement in this figure in two
days, after `89e7a44` and `b273e5b`.

0.08 is arithmetic before it is a measurement: restoring the damage integral the constant was
tuned against needs `0.12 × 1516/2253 = 0.081`. One line. It buys back four of the five
numbers this section pins — head at the leaves at t+100, 26 blows, gate open at t+220,
withdrawn by t+260 — and not the fifth: the crew still breaks during the withdrawal and the
machine ends a wreck, where at `6698e19` it reached `spent` with eight men. It also moves
Rome's determinism baseline again, exactly as `64dfb88` did deliberately, and it makes the
shed twice as strong as the `testudo` formation's own 0.16 rather than the "shade weaker"
its stale comment still claims. **It is a balance change and it is the owner's.**

The alternatives, for the same decision:

- **`RECREW_RADIUS` 95 → 125** reaches the `juthungi-warband` at 123 m, 180 men, morale 60.
  `recrew` sets `r.derelictFor = 0` at the moment of *assignment*, not of arrival, so
  `DERELICT_LIMIT = 40 s` is not a walk-time deadline and the machine is not lost — but the
  walk is ~50 s, so the gate would open around t+270 rather than t+215, and 1,080 men leave
  the reserve. **It is blocked by a defect that has to be fixed first**: `applyShedCover` has
  no distance test, so the instant a unit 123 m away is made the crew it gets
  `missileTaken = 0.12` — 180 men in the open under a roof they are nowhere near. Gate the
  cover on being at the muster (~5 lines) before widening anything.
- **The gatehouse crown run** — the "better fix" `insideBlock`'s own comment holds a place for
  — restores the 22 men *and* reconnects bay 19's severed walk, and makes the ram's position
  **worse**, because those men would then have a clear crown embrasure over the machine.
- **Neither.** With the escalade fix merged, throughput over the parapet has roughly doubled,
  and "a ram that cannot open a gate is a scenario that no longer has a second way in" may no
  longer be true. That is also a decision, and it is the only one that costs nothing.

### And then it was measured over twelve seeds, and 26 was one of them

*Added at `9eb40c8`, measured at `cc72ea6` with `tools/scratch/sf-ram-emc.mjs` and
`tools/scratch/sf-gate-emc.mjs`. Everything above this heading in §5.1 is a property of one
seed, and the seed is 4265438264.*

**The instrument that pins the schedule never asked whether the battle was still going.**
`so-ramline.mjs` boots `?harness=1&quality=high&map=campus-martius&scenario=assault`, which
is seed 4265438264, and on that seed **the Juthungi win the objective at t+134**. Every
figure the table above quotes after that point — 13 blows at t+160, 22 at t+200, 23 blows,
the crew's rout at t+215, the wreck by t+260 — is read off a tableau in which
`BattleFlow.finish` has already put every standing Juthungi unit on Hold and Rome's garrison
is shooting at a machine nobody is defending. `tools/scratch/sf-ramctx-emc.mjs` prints the
verdict beside the ram; that is the whole of the fix and it is one column.

**Over twelve seeds the ram's blows are a distribution, not a schedule.** Same battle, same
tier, one page per seed, window 420 s:

| seed | blows | gate hp | gate opened | crew routs |
|---|---|---|---|---|
| 1371652111 | 0 | 100 % | never | t+110 |
| 3638810955 | 3 | 88 % | never | t+120 |
| 3399460563 | 3 | 88 % | never | t+120 |
| 1998279420 | 9 | 65 % | never | t+150 |
| 745024802 | 19 | 27 % | never | t+190 |
| 2385556337 | 20 | 23 % | never | t+199 |
| 357747885 | 21 | 19 % | never | t+200 |
| 3012183646 | 22 | 15 % | never | t+199 |
| 4026087872 | 23 | 12 % | never | t+209 |
| 4265438264 | 23 | 12 % | never | t+210 |
| 984375194 | 25 | 4 % | never | t+219 |
| 2624906729 | **26** | 0 % | **t+220** | t+220 |

Median 20.5. The gate opens on **one seed of twelve** — it is already a thing that happens.
And the blow count is `(crewRoutTime − 100) / 4.4` to within one blow on every row, because
the crew's life is the only variable in it: the machine arrives at t+100 and swings every
4.4 s until the gang breaks. So "26 blows" is the top of a wide distribution and there is
nothing to restore. **`RAM_SHED_COVER` 0.12 → 0.08 is a curve fit to seed 4265438264.**

**And the prize is empty.** `sf-gate-emc.mjs` forces the Porta Flaminia open at a time you
name, with the same `setGateOpen` + `setGateDoorBroken` pair the twenty-sixth blow makes, so
the carriageway really is repainted in the occupancy raster and the obstacle set. Two live
seeds, opened at t+229 and left open for the remaining 670 s:

| seed 1998279420 | shipped | gate forced open |
|---|---|---|
| storm men ever inside | 60 | **60** |
| peak `stormInside` | 42 | **42** |
| host units still holding at t+897 | 9 | **9** |
| verdict | undecided at t+897 | undecided at t+897 |

| seed 4026087872 | shipped | gate forced open |
|---|---|---|
| storm men ever inside | 99 | **99** |
| peak `stormInside` | 42 | **42** |
| verdict | undecided at t+897 | undecided at t+897 |

Not one number moves. The Juthungi host stands 132 m out and does not use the gate it has
spent four minutes making. **Until somebody walks through it, every constant upstream of the
gate is decoration** — the shed, the recrew radius, the derelict limit, all of it. The third
arm of the same tool is the counterfactual: ordered through the carriageway at t+229, 936 men
of the host put **124** men through the gate and **132** inside against 60, and the assault
is then routed at t+495 rather than grinding to t+1454. The host is the whole question and
it is not free money.

**The same constant is inert on the other map.** On Carthage the identical machine takes
*zero* damage — `so-ramkill.mjs`: `killed by: nobody, damage by: none` over 140 s including
forty of battering — so `RAM_SHED_COVER` multiplies nothing there. The cause is in
`GARRISON_PLANS`, which carries the measurement and the reason the obvious swap is refused.

### And a gate, so there is no third time

`tools/qa-determinism.mjs` and `qa-deploy.mjs`'s Arm 4 both compare run A with run B of the
*same tree*. They answer "does this battle replay" and are structurally incapable of
answering "is this the same battle as yesterday", which is why both were 28/28 green through
all of this. The hash that would have caught `89e7a44` was already being computed, printed,
and thrown away:

| `--at=0,30`, `map=campus-martius&scenario=assault` | `3ff6d41` | `89e7a44` |
|---|---|---|
| t+0 | `113cd9f0` | `22bb3df8` |
| t+30 | `308ccb88` (3010 alive) | `cbd1213e` (2990 alive) |

**t+0** — before a tick has run, because the clip deletes 22 stations and the armies differ
on the start line. The gate then caught a live one within the hour: pinned at `45dd19c` and
re-run at `88a4aa5`, it reported t+0 `UNCHANGED` and t+30/90/150/200 `DRIFTED`
(`20fc8f42 → 8876e4c8`, alive 2575 → 2563 at t+90), which is `8b8eb1f` — a sim fix that starts
the armies in the same places and fights the battle differently. `tools/determinism-baseline.json` now pins run A's marks per battle and
`qa-determinism.mjs` asserts against them; `--record` moves a pin, and the whole point is
that moving one costs a sentence in a commit message. Rome's assault entry is pinned at
`88a4aa5` — the *regressed* battle — and says so, because pinning it stops drift and does not
bless it. The table at the top of §5.1 is deliberately still un-re-pinned.

### The circuit rebuild inverted this defect, and everything above is now history

**At `5338249` the ram lands 26 of 26 blows and opens the Porta Flaminia at t+220 on eight
seeds of eight, at `ultra` and at `medium`, taking zero damage from anybody on the wall.**
(§15 task 14 later widened both deployment boxes and moved `battleCoreMask` onto the deployment
axis, which moves the ground the storm crosses. Every conclusion below was re-taken after that
merge and none of them moved; the headcount is 3,072 rather than 3,074 for a roster reason of
this pass s own, see §7.1.) The
distribution above — 0, 3, 3, 9, 19, 20, 21, 22, 23, 23, 25, 26, one gate opened in twelve — was
measured at `cc72ea6` and does not reproduce. Neither does the tier-dependence that was reported
alongside it: `ultra` and `medium` produce the same ram schedule blow for blow, because
`SimQuality` has one member and its only route into this battle is `fittedUnitScale`, which is
1.0000 at ultra/high and 0.9785 at medium — a 2 % shave that moves a 108-man unit to 106. That
is enough to land a *marginal* battle differently and it is not a mechanism. The old split was
one draw each from a distribution whose own spread was 0 to 26.

**What changed it is §15 task 3, and it is a defect rather than a fix.** The redesigned circuit
puts the Porta Flaminia at bay **1** of 36 and makes bays 0, 2, 3 and 4 `footing`/`gap`/
`footing`, because §4.8's archaeology says the Campus Martius neck is the one stretch Aurelian
had to build from nothing. `walkGeometry` gives a footing and a gap no walkway, so
`garrisonable` is false, so `holdable` rejects bay offsets −1, +1, +2 and +3 — and
`deployAssault` fanned the garrison out with `fanOut(total, 1, holdable)`, from offset **1**,
so offset **0**, the gate bay's own curtain, was never offered at all. That start value was
right for as long as a gate bay could not be garrisoned; the same task made Rome's
garrisonable on purpose (*"the curtain either side of a gatehouse is ordinary curtain a rank
can stand on"*) and nothing moved the deployment to match.

Measured at `5338249`, `tools/scratch/rm-recon-emc.mjs`:

| | at `5338249` | with `fanOut(total, 0, holdable)` |
|---|---|---|
| nearest garrison unit to the ram | `ballistarii#0` at **134 m**, bay 5 | `ballistarii#0` at **65 m**, bay 1 |
| garrison within 130 m of the Porta Flaminia | **none** | 108 ballistarii |
| damage to the gate crew, 8 seeds | **0** | 1,012–2,916 points |
| crew alive at the breach, 8 seeds | 32/32 | 30, 11, 30, 31, 30, 30, 15, 16 |
| blows / gate open | 26/26, t+220, 8 of 8 | 26/26, t+220, **8 of 8** |

So the ram still gets through at the tier the game ships at, on every seed — and
`RAM_SHED_COVER` is now measuring something on Rome for the first time. At 0.12 the gang absorbs
1,012–2,916 points; at 1.0 the same fire is 8,400–24,300 against a 32-man crew, which is the
4,846 points that killed all thirty-two by t+40 in the original finding, several times over.
Carthage is untouched — `carthageWall.ts` sets `garrisonable: !bay.isGate`, so `holdable(0)` is
false there and the picked-bay list is identical to the bit.

**And a much larger thing was found on the way, which is nobody's yet.** Rome's assault is
**decided at t+56–59 in every run**, before the ram has reached the gate and before a ladder has
been climbed, and it has been for as long as the redesigned circuit has existed. `BattleFlow`
ends a storm at `stormInside >= 60` — sixty storming men more than `INSIDE_MARGIN` = 14 m
cityward of the curtain line — and `tools/scratch/rm-inside-emc.mjs` names them at t+60:

```
t+ 50  onWall 54 holding 0 garrison 801  INSIDE 26
       juthungi-riders#31@(115,560) 29
t+ 60  onWall 92 holding 0 garrison 779  INSIDE 86  1/objective@58
       juthungi-warband#28@(181,549) 46   juthungi-warband#29@(181,547) 29
       juthungi-riders#30@(-98,580) 50    juthungi-riders#31@(111,558) 21
```

`stormHolding` is **0** — not one foot of parapet has been taken — and `garrisonOnWall` has
moved 810 → 779. Two mechanisms, and they want different answers:

- **50 of the 86 are 98 m off the west end of the circuit**, where the Tiber is and there is no
  masonry at all. `censusWall` clamps a man's bay index to the ends of the bay list, so a unit
  past the terminus is measured against bay 0's midline and reads as inside the city. That is a
  bug in the census.
- the rest walk over the `footing` and `gap` bays, which is by design (*"which is where the
  assault goes"*) and which `BattleFlow` is right to count.

Left alone deliberately: the first is `BattleFlow`'s, the second is a scenario-design decision
about what the unbuilt neck is *for*, and Rome's balance is reserved. **But every ram figure in
this document, including the new ones above, is read out of a battle `finish()` has already
ended.** They are properties of the machine, not of the battle.

### 5.2 The pattern, and three more of it

The shape is: **the art asserts a property the simulation does not implement, and every
instrument agrees with the art.** It is not a rendering bug and not a sim bug; it is a claim
made in one representation and never crossed into the other. Four instances landed in this
release alone:

| Instance | The picture said | The model said | Found by |
|---|---|---|---|
| The ram's shed | a roofed *testudo* | 32 crew in the open at 53–60 m | attributing every damage point (`64dfb88`) |
| The gatehouse's merlons | crenellated stone, laid by `crenellation()` | one flat height across the block | counting distinct heights returned by `masonryTopAt` (`0378881`) |
| Carthage's ditch | a 20 × 6 m trench, counted in a 34.1 m belt | flat ground, 0.16 m at its worst station | walking a transect of `TerrainSystem.heightAt` (`c6fdd6e`) |
| The unit standard | dyed wool under the scene's sun | a raw `ShaderMaterial` with its own hand-written sun term: no shadow received, none cast, sun *intensity* dropped, no environment, no aerial perspective | three blind graders, 14 of 14, naming it as the decisive tell (`bf75fb0`) |

The common defence is the same in all four: **measure the thing the picture is claiming, in
the representation that has to act on it.** Not "is a shed drawn" but "who killed the crew";
not "is the gatehouse crenellated" but "how many distinct heights does the collision model
return across it"; not "is a ditch in the plan" but "what does the heightfield say the ground
does"; not "does the banner look lit" but "is its material in `affectedByLights`".

### 5.3 Carthage's ditch — published for four commits, never cut

`carthageWall.ts` builds a 20 × 6 m dry ditch into its own arithmetic: `BELT_DEPTH` counts it,
`assertSection` checks it, `CARTHAGE_SECTION.beltDepth` reports **34.1 m** of landward defence,
and `CitySystem.getDitch()` hands the record to anyone who asks. What stood on the ground was
flat. Commit `c6fdd6e`:

> Measured at `4e3145f`, the ground in front of the wall fell **0.16 m at its worst station and
> 0.00 m at four of sixteen** across the 60 m of glacis. The belt an assault actually crossed
> was 14.1 m of masonry while every consumer of the plan was told 34.1.

The wall could not fix it — a 6 m cut is a heightfield edit and `src/maps/` is not the city's —
so the plan crossed the seam as a request with `built: false` on it, and nothing on the other
side had ever answered. `heightfield.ts` stage 4h answers, and `CarthageDitch.built` becomes a
fact rather than a type, carried in on `WallLine.ditchIsCut`.

Two properties of the fix are worth copying:

- **The profile is not copied.** Every number comes from `CARTHAGE_DITCH_SECTION` and every
  point on the centreline from `carthageDitchPath(CARTHAGE_WALL_LINE)` — the *same call*
  `buildCarthageWall` makes to publish the record. Two files disagreeing about one trench is
  the fault that put 84 % of the merchant basin under its own water.
- **The two places it is deliberately not 6 m deep are reported, not hidden.** The depth is
  capped by the freeboard the ground has over `SEA_LEVEL` less 0.6 m, because a dry ditch
  taken under the datum is rendered as water by `WaterSurface` and a moat on this map is a
  flank the wall was built to deny. And the Porta Byrsae keeps its causeway; the other two
  gates do not, because a city that walls a gate up breaks the bridge to it.

Measured after, over 88 stations (`c6fdd6e`, and printed by `assertDitchCut` at every boot):

| | before | after |
|---|---|---|
| relief median | 0.00 m | **6.00 m** (spec 6) |
| stations cut | 0 / 88 | 88 / 88 |
| stations under the datum | — | 0 |
| causeway fall at the gate | — | 0.03 m |
| field mean height | 8.0594 m | 8.0429 m |

That last line is an independent check on the volume: a 66 m² section over 1,743 m is
115,000 m³ spread over 6.76 km², which is 0.017 m. It moved 0.0165.

**Reproduced at `6698e19`.** The boot line reads:

```
[carthage] ditch: 88/88 stations cut, relief median 6.00 m (spec 6 x 20 m), deepest bed
3.09 m, 0 station(s) under the datum. Worst shortfall 2.49 m at x -796. Causeway at the
Porta Byrsae falls 0.03 m. Worst nav gradient 0.43 at (-504, 553) (impassable past 0.62).
```

and an independent transect of `TerrainSystem.heightAt` across the 25 published centreline
points gives min 0.014 m (the causeway), median 5.995 m, max 6.034 m.

The nav gradient is the third way a ditch can be wrong and it is checked rather than assumed.
The V's sides run 9 m for 6 m of fall — gradient 0.667, above `Pathfinding.SLOPE_IMPASSABLE`
of 0.62 — so a naive reading says the ditch is a wall no formed unit can cross. It is not,
because `Pathfinding.CELL` is 7 m and `deriveCost` central-differences over 14, which is wider
than the 9 m slope. The prediction is 6/14 = 0.43; the measurement, walking the pathfinder's
own stencil on the pathfinder's own lattice, is 0.43. The ditch slows and disorders an
assault at the foot of a wall under fire, and does not forbid it.

**A warning about the instrument, recorded because it nearly landed as a fact.** The first
version of `tools/scratch-ditch-so2.mjs` sampled only the gate bay's own outward normal and
reported **0.83 m** of relief against the 6.00 m the ditch work published. It was sampling
straight down the causeway — the one place on 1.7 km of trench that is deliberately bridged.
A ditch is bridged at its gate. The current version samples seven bays at
`KS = [-6,-4,-2,0,2,4,6]`.

### 5.4 The gatehouse

`GateBlockOut` had exactly one battlement field, `topY`, and `CitySystem.masonryTopAt` returned
it flat across the block's whole 25 × 11.9 m footprint. Two things were wrong and both were
measurable (`0378881`):

- **The roof was two metres too high.** `topY` is the merlon *tops*; the roof of the block and
  the cornice round it stand at the merlons' feet. Sampled at the bay's own parapet offset over
  the 24 m at the gate, `masonryTopAt` returned 44.324 on Rome where the stone is at 42.324,
  and 28.525 on Carthage where it is at 26.425 — 2.000 and 2.100 m, which is `GATE_MERLON_H`
  exactly, over 11 of the block's 11.9 m of depth.
- **The merlon line was solid.** `buildGate` and `buildPunicGate` both lay a real
  `crenellation()` on the crown. Over the 24 m at the gate the collision model returned **one**
  distinct height against **two** for an ordinary 25 m of curtain twenty metres away.

The block now carries `sillY`, `parapetInner`, `parapetOuter`, `crenelledCityward` and — the
detail that matters — **its own `merlonLength`/`crenelLength`**, because Rome's gate is cut at
1.5 / 0.8 while `rome/plan.ts` publishes 1.7 / 0.95 for the curtain. Resolving the block
through the plan's numbers would put the collision model a whole merlon out of register by the
block's far end.

The firing-line measurement, station-to-station rays swept against `masonryTopAt` at shoulder
height, counting the gatehouse's own contribution rather than the first thing in the way:

| | straddling pairs | stopped by the gatehouse, before → after |
|---|---|---|
| **Carthage** | 2,832 | **2,832 → 0** |
| **Rome** | 1,512 | 1,512 → 1,512 |

Rome does not move and should not. Its walk steps 7.15 m across the gate — bay 19 at 35.75,
bay 21 at 42.90 — so the ray passes the block six metres below its roof and is stopped by the
gatehouse's *body*, which is a real gatehouse standing between two walks at different levels.
Carthage's walk is continuous and the whole frontage opens.

> The "2,832 of 2,832" figure is **Carthage's**. It is easy to attach to Rome because Rome is
> the map where the gatehouse defect was first noticed.

**Verified at `6698e19`**, two ways:

- **The roof.** Sweeping `masonryTopAt` across the block's 11.9 m of depth at Rome returns
  `sillY` 42.32 everywhere except a ~1 m band at normal offsets +4.55 … +5.05, where it
  returns `topY` 44.32. The two-metre error is gone.
- **The merlons.** Sweeping the block's own fieldward merlon line
  (`(parapetInner + parapetOuter) / 2 = 5.0`) at 0.1 m over the 24 m at the gate returns **two**
  distinct heights — 44.32 on 161 samples and 42.32 on 80, a merlon fraction of 0.668 against
  the 1.5 / (1.5 + 0.8) = 0.652 the block's own lengths predict. An ordinary bay twenty metres
  away returns 44.95 and 43.50 in the same proportion. The gatehouse is crenellated to the
  collision model, as it always was to the eye.

(Sampling the block's *centreline* instead gives one height, correctly: that is the roof.)

The other half of the gatehouse story is still open — see §7.2.

---

## 6. Deployment and rosters

### 6.1 The pre-battle phase

`DeploymentSystem` (`src/sim/deployment.ts`, `name: 'deployment'`, `order: 690`) is registered
only when the phase will be used, so `tryGet('deployment')` is also the HUD's test for whether
to build the plaque. It is opened *after* `deployBattle`, in `boot()`, because its zone is
measured off where the scenario actually stood the two armies.

```ts
const deployPhase = params.has('deploy')
  ? params.get('deploy') === '1' && !autoplay
  : !skipMenu && !autoplay;
```

On for anyone who came through the menu; off under `?harness=1`, `?menu=0`, `?autoplay=1` or
`?deploy=0`, because the screenshot deck, every `probe-*` and every `?battle=` link expect a
battle that is already running.

It holds `ctx.time.paused`, and that is the entire answer to the AI problem: `Engine.frame`
runs `fixedUpdate` exactly as many times as `Time.beginFrame` returns, and a paused clock
returns zero, so during deployment the AI planner is not out-voted — it is never called.

While it is active the player can drag units into place (position, facing and frontage), drop
a unit on their own parapet to garrison it (`wallPoint` → `placeOnWall` → `Siege.garrison`),
change formation, remove a unit to a bench, and add units from a palette built from
`rosterFor`. Caps, all from `src/sim/battleConfig.ts`: `MAX_UNITS_PER_SIDE = 20`,
`MAX_PER_TYPE = 12`, soldier-pool headroom, and `PERF_VALIDATED_MEN = 9000`, which warns
rather than refuses. Placement is a teleport — `relayout` writes `x/y/z` and `px/py/pz` and
zeroes velocity.

`commit()` clears waypoints and pins `targetX/targetZ` to the current position for every
non-`Garrison` unit, unpauses and resyncs the clock, and emits `deploymentEnded`.

### 6.2 The zone

An axis-aligned rectangle plus a flag:

```ts
interface DeployZone { xMin, xMax, zMin, zMax: number; wall: boolean; label: string }

contains(x, z) {
  if (x < zone.xMin || x > zone.xMax) return false;
  if (zone.wall && battle.siege.wallTargetAt(x, z) >= 0) return true;   // the parapet counts
  return z >= zone.zMin && z <= zone.zMax;
}
```

There are **no per-map zone literals**. `computeZone()` derives the rectangle at runtime from
where the scenario put the two armies, the city plan and the heightfield: a stand-off of
`max(40, gap * 0.2)` from the midline between the two weighted army centroids, a rear limit of
`wallZHi + 60` behind your own wall or `battlefieldZ ∓ 10` against an enemy city, a front limit
of `wallZLo − 25` so a defender can stand at the foot of their own wall, a lateral half-width
of `max(250, (xHi − xLo) * 0.5 * 1.5)`, and a clamp at `halfExtent − 160` (= ±1240).

The `wall` flag is set when the map has bays *and* either the player already garrisons some
(`siege.isGarrisoned`) or `plan.garrison === playerFaction`.

The numbers that *are* hardcoded are the two army lines in `scenario.ts` — `romanZ = 130` and
`germZ = -190`, with `punZ = germZ` — and they are map-independent: `deployBattle` never reads
`config.map` for placement.

### 6.3 An order of battle

Counts are a table on `BattleConfig`; geometry is code in `scenario.ts`; and for an assault the
*jobs* are a second table.

```ts
export const GARRISON_PLANS: Partial<Record<Faction, GarrisonPlan>> = {
  [Faction.Rome]:     { wall: ['ballistarii', 'wall-slingers'], engines: ['carroballista'], reserve: ['legio-cohort'] },
  [Faction.Carthage]: { wall: ['punic-levy', 'punic-freedmen'], engines: ['punic-catapults'], reserve: ['punic-deserters'] },
};

export const STORM_PLANS: Partial<Record<Faction, StormPlan>> = {
  [Faction.Germanic]: { tower: 'tower-assault',      ladder: 'escalade-party', ram: 'ram-crew',
                        greatRam: 'great-ram-crew',
                        batteries: ['onager'], host: ['juthungi-warband'], hostFormation: 'horde', horse: ['juthungi-riders'] },
  [Faction.Rome]:     { tower: 'legio-tower-party',  ladder: 'legio-escalade', ram: 'legio-ram-crew',
                        batteries: ['legio-ballista', 'carroballista'], host: ['legio-cohort'], hostFormation: 'line', horse: ['equites'] },
};
```

`StormPlan.greatRam` is **optional**, and the asymmetry above is the point: the Juthungi field a
*testudo arietaria* at scale and Scipio's train does not. See §7.1 for why and for what it cost
at the twenty-unit cap.

`deployAssault` — which is not exported, and whose only caller is `deployBattle` when
`variant === 'assault'` — never learns a city's name:

```ts
const garrisonSide = plan?.garrison ?? Faction.Rome;
const stormSide = belligerents(config).find((f) => f !== garrisonSide) ?? Faction.Germanic;
```

Everything is placed relative to the gate bay by `fanOut(count, from, predicate)`, which walks
outward alternately either side of the gate, skipping bays the predicate rejects:

| Element | Where |
|---|---|
| garrison `wall` types | on the walk, from bay **0** outward, `garrisonable` only, then `siege.garrison()` |
| garrison `engines` | `out(k, -14)` from bay ±2 |
| garrison `reserve` | `out(k, -46)` from bay ±1 — behind the bays the towers come at, because that is where a breach will be |
| storm `tower` | `out(k, 74 + i*9)` from bay ±1; echeloned 9 m apiece so four machines do not arrive in one rank |
| storm `ladder` | `out(k, 26)` from bay ±3 (±1 if no towers are fielded), three ladders at ±7 m |
| storm `ram` | `62 + i*18` m out on the gate's own axis |
| storm `greatRam` | `out(k, 62 + i*20)` from the first **`holdable`** bay outward — bay 5 on Rome |
| `batteries` | `out(0, 196)` on 71 m centres, all types dealt into one line |
| `host` | `out(0, 132)` on 62 m centres |
| `horse` | `out(0, 178)`, flanking |

Wall troops are spawned on the ground under their bay and then *lifted* onto it, because
`spawnUnit` snaps every man to the terrain and `Siege.garrison` is the only thing in the sim
that can put him anywhere else.

The two shipped assault orders of battle (assault does not scale with the battle-size
multiplier — `scaleAppliesTo('assault')` is false — but `fittedUnitScale` may still lower it to
fit the quality tier's soldier pool):

| Rome garrisons the Aurelian Wall | | The Juthungi storm | |
|---|---|---|---|
| `ballistarii` | 5 × 108 | `tower-assault` | 4 × 72 |
| `wall-slingers` | 3 × 90 | `escalade-party` | 4 × 96 |
| `carroballista` | 2 × 12 | `ram-crew` | 1 × 32 |
| `legio-cohort` | 2 × 160 | `onager` | 3 × 12 |
| | | `juthungi-warband` | 6 × 180 |
| | | `juthungi-riders` | 2 × 50 |
| **12 units, 1,154 men** | | **20 units, 1,920 men** | |

| Carthage's garrison | | Scipio's train | |
|---|---|---|---|
| `punic-levy` | 6 × 150 | `legio-tower-party` | 4 × 80 |
| `punic-freedmen` | 4 × 110 | `legio-escalade` | 4 × 104 |
| `punic-catapults` | 2 × 12 | `legio-ram-crew` | 1 × 32 |
| `punic-deserters` | 2 × 96 | `legio-ballista` | 2 × 12 |
| | | `carroballista` | 1 × 12 |
| | | `legio-cohort` | 6 × 160 |
| | | `equites` | 2 × 60 |
| **14 units, 1,556 men** | | **20 units, 1,884 men** | |

> `battleConfig.ts`'s own comment states Carthage's garrison as "14 units and 1,616 men". The
> strengths sum to 1,556. The unit count is right.

### 6.4 The victory conditions an assault is judged by

`BattleFlowSystem` gives the besieger two ways to win:

- **A — the wall.** `WALL_FOOTHOLD = 24` men of the storming side holding a *lodgement* for
  `WALL_HOLD_SECONDS = 20`. A lodgement is a maximal block of consecutive runs the storm stands
  on, and it counts as held when no defender is on it and at least one of its runs is ground
  the garrison held at some point in the battle.
- **B — the break-in.** `BREAK_IN = 60` men loose inside the city, `INSIDE_MARGIN = 14 m` past
  the curtain's own line.

Plus the garrison's half: `STORM_STALL_SECONDS = 180` without reducing the garrison's hold on
the parapet, judged as a low-water mark rather than a rate, and `TIMEOUT_SECONDS = 2400`.

Condition A was rewritten twice in this release and both attempts are instructive.

The original asked `garrisonOnWall === 0` — a sum over the whole circuit. Rome's 810 wall men
sit in eight or nine blocks along 1,781 m of curtain, and across twelve seeded runs the
smallest that sum ever reached was **604**. One surviving Roman on a tower a mile away denied
the condition for ever.

The first scoped rewrite additionally required the run *either side* of a lodgement to be
clear, on the reasoning that a run boundary is a fact about the masonry rather than about the
fight. Sound reasoning, useless rule: it fired **nowhere** — not in twelve seeded runs of the
shipped assault, and not in any of six garrisons swept down from 810 men to 108, through
configurations where the storm put 136, 141, 144, 161 and 203 men on the wall and won by
another route. The measurement that settled it: with three wall units, the storm fights for
bay 18 from t+251 with 25 men against 57, kills the last defender by t+297, then holds it with
55–84 men for fifty seconds — while 65 defenders on bay 19 hold at exactly 65 and take **not
one casualty** between t+251 and t+347. Rome's garrison holds the bay it is given; it does not
counter-attack along the walkway. "A defender within one bay" therefore measures nothing about
contest.

The shipped rule is the run itself: no man of the garrison standing anywhere on the stretch the
storm holds, on ground the garrison held. `stormHolding` and the runs behind it are published
on `objective` so the HUD can show the storm what it is holding rather than a circuit-wide
total it can do nothing about.

### 6.5 The plaque

`src/ui/siege.ts` is the single reader; the deployment plaque, the top plaque and the
end-of-battle dispatch all print from it, and none re-derives a threshold. It exists because a
playtest could win the siege of Carthage and could not say why: at t+982, with the gate broken
and two towers docked against the parapet, the top plaque read *"MISSILE EXCHANGE · Arrows and
pila in the air · Evenly matched"*.

Five phases: `approach → ram → wall → breach → streets`, and `derivePhase` returns the furthest
thing that **is** happening, not the furthest that *has* happened. So a phase can go backwards
and does — measured on a defence of Rome, t+206 "In the Streets, 1 of them is past the
curtain", t+227 "The Approach, their engines are coming on", because the last man inside had
been killed and the storm was re-forming. The comment at `6698e19` says exactly this; an
earlier version of it asserted the opposite, which is worth knowing if you are reading an older
checkout.

---

## 7. Known-broken and absent

Stated plainly, because each of these is reachable in code and unreachable in play.

### 7.1 The breach route has no way in — **closed, 21 Aug 2026**

The four seams below were the whole of it and all four are shut. Kept as the statement of what
was wrong, because the shape of the failure is instructive: every part of the mechanic existed
and worked, and nothing joined it to a battle.

- ~~`spawnGreatRam` has **no caller in `src/`**~~ — `deployAssault` calls it, at the first
  `holdable` bay working outward from the gate, 62 m out on that bay's own normal. On Rome that
  is bay 5, the west end of the Muro Torto, 134 m along the curtain from the Porta Flaminia,
  because §4.8's four unbuilt bays either side of the gate carry no masonry to break and no
  stations to aim at.
- ~~no `great-ram-crew` unit type~~ — `src/units/siegeUnits.ts`, Faction.Germanic, **48 men**.
  The number is the machine's own layout read back, exactly as `ram-crew`'s 32 is:
  `musterRams` puts a great ram's gang six abreast, and the last row still inside
  `GREAT_RAM_HALF_D + SHED_COVER_REACH` = 10.40 m is row 7 at 9.60 m. Eight rows of six.
  Every other stat is `ram-crew`'s, unchanged, deliberately.
- ~~no roster entry, and both storming rosters are at `MAX_UNITS_PER_SIDE`~~ — `StormPlan`
  gains an **optional** `greatRam`, and `siegeJuthungi` pays for it out of the horse:
  `'juthungi-riders': 2 -> 1`, `'great-ram-crew': 1`. Still exactly twenty units. The horse is
  the unit `STORM_PLANS.horse`'s own comment calls *"nothing to do until a gate opens"*, and
  measured on the shipped assault that is literal — no cavalry unit is ever ordered at the
  wall. Headcount 3,074 → 3,072. **Scipio's train is deliberately not given one**, so the
  Carthage assault stays a bit-identical determinism control; the optional field is the seam
  for the day it is.
- ~~`CityView.breachWall?()` is not implemented on `CitySystem`~~ — implemented. It records
  the hole, clears the occupancy raster across the curtain on the bay's own outward normal
  (`halfThickness + 9` m either side, `BREACH_HALF_W` wide), and re-cuts the oriented boxes.
  `pushWallBox` now punches out **every** hole crossing a run rather than the first one it
  finds, because a bay can carry a gate and a breach and Rome's gate bay is one.

One more seam nobody had named: `stormBreach` had a caller in neither `src/` **nor** the order
path. `wallTargetAt` refuses a dead station and every station over a breach is dead, so a
right-click on the rubble read as "not the parapet" and `interceptOrders` dropped it.
`findEscalade` now answers `kind: 'breach'` for a click within `ESCALADE_REACH` of a breach
station — *ahead* of towers and ladders, because 8 m of storming front outranks one man at a
time on a rung — `escalade` routes it to `stormBreach` with a rally point 30 m inside the
curtain, and `Siege.breachAt(x, z)` is the published loose test the order path and the cursor
both read.

And a sixth that the fifth exposed: **`buildLinks` empties `this.links`, so a *second* breach
wiped the first breach’s five lanes and left `breachLinks` holding indices that now named stairs
and tower passes.** `probe-siege` spawns a great ram of its own alongside the one the scenario
now deploys, and with two breaches it reported *"-18 men climbed the rubble ... across 10 lanes"*
with a waiting man 190 m from a lane mouth. A negative count is the tell; walking a storming
column into a tower doorway is the cost. Lane construction is now `cutBreachLanes(station)`,
re-run for every entry in `breachStations` after each collapse, and what has already come
through is banked into `breachThroughBase` *before* `buildLinks` destroys the counters.

**What is still missing, and it is visual only: the curtain is drawn standing over the hole.**
The mechanic is complete — five lanes, dead stations, the garrison rehoused, the raster open,
the boxes split, men through — and the geometry is not, because a bay's masonry is baked into
one of five `wall-N` chunks at load and nothing can re-bake one. The seam is
`rome/apertures.ts curtainSpans`, already the single place that decides where curtain is *not*
laid: give it the breach list and re-bake the chunk. That is a city-workstream change.

`WALL_BLOWS` was **74 and is now 44**, timed rather than chosen. `deployAssault` starts the
machine 62 m out, which is 97 s of rolling, so the breach lands at `97 + blows x 7`: t+620 at
74 and **t+420** at 44, measured, against the gate ram s t+220. At 74 the hole opened with
nothing left of the battle to use it — three units ordered through it put 6 and 0 men inside
before an 800 s window ran out. At 44 the two nearest foot units on the field side, ordered at it,
put **412, 197 and 312** men inside the curtain on three seeds of three. 44 is still 5 min 08 s of battering against the gate ram s 1 min 54 s, so the wall
is plainly 2.7x the job the door is. Re-time it, do not re-guess it, the day the host is given
a storm order.

### 7.2 The gatehouse station clip does not fire

This one is new here and is worth stating carefully, because both halves of the intended fix
landed and the result is still broken.

`Siege.buildSpine` clips a station out where the gatehouse stands:

```ts
const gateBlock = this.city.getGateBlock?.() ?? null;
...
if (gateBlock && insideBlock(gateBlock, px, pz)) continue;

function insideBlock(b: { x, z, hw, hd, rot }, x, z): boolean {
  const dx = x - b.x, dz = z - b.z;
  const c = Math.cos(-b.rot), s = Math.sin(-b.rot);
  return Math.abs(dx * c - dz * s) <= b.hw && Math.abs(dx * s + dz * c) <= b.hd;
}
```

`Siege`'s `CityView` declares `getGateBlock?(): { x, z, hw, hd, rot, topY } | null`.
`CitySystem.getGateBlock()` returns a `GateBlockOut`, whose plan fields are `nx, nz, dx, dz,
halfRun, halfDepth` — **there is no `hw`, no `hd` and no `rot`**. `Math.abs(NaN) <= undefined`
is `false`, so `insideBlock` returns false for every point and the clip never fires.

`tsc --noEmit` is clean, because `Siege.init` obtains the city as
`ctx.tryGet('city') as unknown as Partial<CityView>` and `as unknown as` discards the
structural check. This is the cost of the duck-typing described in §1.3, paid in full.

**Measured at `6698e19` on Rome:**

| | |
|---|---|
| stations in bay 19 | 36 |
| of those, inside the gate block by the block's own fields | **22**, at x 59.89 … 77.94, `walkY` 35.75 |
| of those, clipped by `insideBlock`'s fields | **0** |
| gate block | `halfRun` 12.5, `halfDepth` 5.95, `topY` 44.324, `sillY` 42.324 |
| drop from the crown to those stations | 42.324 − 35.75 = **6.574 m** |

Which is exactly the defect `e78e169` and `8277bb7` set out to close. `8277bb7`'s message says
the clip is "inert until that accessor lands, like `getWallStairs` and `breachWall` before it".
The accessor had landed 48 minutes earlier — with different field names.

`CitySystem.embrasureAt`'s own comment describes the residue correctly and independently:
those 22 stations are 6.6 m below the gatehouse's crown, so `Projectiles.aimOverParapet` still
declines them — but now at `notOnThisWalk` rather than `noBattlement`, *"which is the true
reason. A man cannot shoot over a battlement he is standing six metres underneath, and the
defect that put him inside the block is `Siege.buildSpine`'s."*

The stated better fix, in both files, is a run laid on the block's crown at its own `topY`,
with links to the walks either side — a garrison *should* be able to stand on a gatehouse roof.
The clip is written as a clip so that deleting it is the whole of that change.

### 7.3 Only two of four map × side combinations exist

`playerFaction` is hardcoded twice — `src/main.ts` (`const playerFaction = Faction.Rome;`) and
`src/ui/theme.ts` (`export const PLAYER_FACTION = Faction.Rome;`) — and the main menu has rows
for Battlefield, Battle, Enemy, Battle size, both armies' orders of battle and Conditions, but
**no side selector**.

The side the player takes in a siege therefore derives entirely from `CityPlan.garrison`:

| Map | Garrison | Storm | Player is |
|---|---|---|---|
| `campus-martius` | Rome | Juthungi | the **garrison** |
| `carthage` | Carthage | Rome | the **besieger** |

The two that do not exist are "storm Rome" and "defend Carthage", and they are not one flag
away: there is no `GARRISON_PLANS[Faction.Germanic]` and no `STORM_PLANS[Faction.Carthage]`, so
neither has an order of battle to deploy. Assault on Pydna is blocked in the menu and
`sanitiseConfig` downgrades it anyway, so a hand-made `?battle=` token cannot reach it either.

### 7.4 The escalade cannot clear a bay on the shipped order of battle

Condition A is satisfiable, but not against the garrison the game ships with. From `9b6f8c1`,
measured over the same twelve seeds:

> the storm's own runs never fall below 40 defenders on the shipped order of battle, so no
> block is ever clear and the distribution is what it was. It changes the sweep: A becomes
> satisfiable at four wall units and below.

`tools/scratch/reach-vs.sh` is the sweep: the shipped garrison is eight wall units — **810 men**
— and across twelve seeded runs the storm never cleared a single bay. Take it down to four wall
units and the condition fires.

**The 810 reproduces exactly at `6698e19`**: at `quality=ultra`, `unitSizeScale` is 1 and
`Siege.stats()` reports `garrisoned: 8, garrisonMen: 810` at t=0 — five `ballistarii` of 108
and three `wall-slingers` of 90.

That number is also the reason to be careful with the quality tier when measuring an assault.
At `quality=low`, `fittedUnitScale` drops the same eight units to **301 men on the parapet**,
which is well inside the range the sweep says condition A becomes reachable in — and in the
low-tier run used for the ram timeline above, `BattleFlow` wrote a Juthungi victory on the
assault objective at `result.at = 92.0` — before the ram had landed a blow. That is a
legitimate result for a quarter-strength garrison and it is *not* the shipped battle. Timings
scale with the tier; outcomes do not.

So on the shipped Rome assault the besieger's realistic routes are the gate (which now opens at
t+220, §5.1) and the three unbuilt footings (§2.8) — and the AI only ever finds the second.

> A figure of "1,212 sampled pairs" is in circulation for this result. **It could not be
> sourced** — it appears in no commit message, tool or source file at `6698e19`. The two
> statements above are the ones with provenance; use those.

### 7.5 Smaller live faults

- **`porta-uticensis` is cut past the end of bay 50.** Carthage prints
  `[city:carthage] section faults: porta-uticensis is cut past the end of bay 50` at every
  boot, from `punicSection().faults`. It is surfaced, not suppressed, which is the design of
  `CityChecks` working — but it is a fault.
- **The deployment palette gives a tower party no tower.** `DeploymentSystem.add` calls
  `battle.spawnUnit` and nothing else. There is no `spawnTower`/`spawnLadder`/`spawnRam`/
  `registerArtillery` call anywhere in `deployment.ts`, so a `legio-tower-party`,
  `legio-escalade` or `legio-ram-crew` added through ADD UNITS during the Carthage assault
  arrives with no machine, and an added `legio-ballista` is never registered as artillery.
  Only the units `deployAssault` laid out get their machines.
- **`deploymentChanged` has no listener** anywhere in `src/`.
- **Two stale constant comments** in `Siege.ts`, both harmless to behaviour and both able to
  mislead a reader: `RAM_SHED_COVER`'s says 0.2 where the value is 0.12 (§5.1), and
  `RECREW_RADIUS`'s reasons about 55 m where the value is 95.
- **A stale measurement** in `LINK_MAX_GAP`'s comment: tower gaps are quoted at 8.3–9.4 m and
  measure 4.94–5.68 m at `6698e19` (§2.4).

---

## 8. Measuring any of this

There is no test runner. Every instrument is a standalone Node ESM script driving Playwright
against the real Vite dev server, reading the live simulation through `window.__game`. None is
wired into an npm script; they are run by hand:

```
node tools/probe-siege.mjs --port=5353           # the whole mechanic: gates, garrison, towers,
                                                 #   ramps, ladders, ram, ascent/traverse/descent,
                                                 #   the great ram and the breach. Owns the siege
                                                 #   screenshot cameras (--shots).
node tools/probe-wall.mjs --port=5511            # Rome's circuit, binned at 0.25 m: holes, joins,
                                                 #   see-through rays, stair rake, masonryTopAt
node tools/probe-carthage-wall.mjs --port=5733   # Carthage's, incl. the ditch record and the belt
node tools/probe-towerpass.mjs --port=5407       # the doorway is >= 0.85 m clear, and men use it
node tools/probe-walltraffic.mjs --port=5388     # ascend / traverse / descend, by real events
node tools/qa-wallmatrix.mjs --port=5477         # route x direction x unit type, by real mouse
node tools/qa-siegecommand.mjs --port=5412       # machine orders, by real mouse through the menu
node tools/probe-ram.mjs --port=5388             # the ram's timeline; a reporter, no assertions
node tools/probe-ditch-ds.mjs --port=5431 --map=carthage    # relief, nav gradient, crossability
node tools/probe-gatebattlement-ds.mjs --port=5437          # distinct heights over the gate block
node tools/probe-parapet.mjs --port=5301         # per-rank fate of every shot from a walkway
node tools/probe-killcredit.mjs --port=5715      # wraps BattleSystem.damage; attributes kills
node tools/probe-romewin-ds.mjs --port=...       # N seeded assaults, both victory conditions
node tools/probe-wallai.mjs --port=5391          # does an AI army that took the wall do anything
```

Launch Chromium with `--use-gl=angle --use-angle=metal`; `probe-ram.mjs` notes that without it
headless Chromium software-rasterises the siege.

Most of these refuse to fall through to a stale `dist/`: they fetch `/src/main.ts` first and
`exit(2)` if nothing answers, because *a probe that measures a build is not measuring this
tree*.

Four cautions the tooling records about itself, all of them earned:

1. **Sample the thing, not a special case of it.** The 0.83 m ditch reading (§5.3).
2. **`probe-siege.mjs` drives the sim on the slow `__game.advance` path** and has been killed
   after thirty minutes with no output (`AGENT-REGISTRY-siege-command.md`). Budget accordingly.
3. **`campaign-vs`'s sampling grid is not deterministic even though the battle is.** The sim
   runs at real-time pace from `ready` until the probe stops it, so the first sample lands at
   1.99 s or 2.3 s depending on machine load and every later sample inherits the offset. Two
   runs of the same seed returned `result.at = 546.7666666668267` to the last digit with peak
   `stormOnWall` of 65 and 64. *Read the verdicts; treat a peak as ±2.*
4. **`matchup.mjs` is repeatable to about ±8 %, and that is the instrument, not the sim.**

The one probe output checked into the repo is
`plans/carthage-plan-v1/probe.json`, from `probe-carthage.mjs`.
