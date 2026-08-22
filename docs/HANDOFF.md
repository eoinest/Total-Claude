# Handoff — live state

A running log. The top section is current; everything below it is dated session history, newest
last. Update the top, append to the bottom, do not let it rot.

## Live state — 21 Aug 2026

`main` is **`f694ad6`**, pushed. **`r8` is live** at total-claude.vercel.app — deployment proved to be
this tree three ways: `index.html` byte-identical to a rebuild, all nine build outputs SHA-256
identical, and Vercel's own SHA-1 digest matching the rebuild for 86 of 86 files in both
directions. All three maps boot against the live URL with the clock advancing.

The full gate is green on this tree: tsc clean, lint 2/2, qa-deploy 33/33, seams PASS both maps,
**`qa-replay` 21/21**, and all three determinism arms UNCHANGED at all seven checkpoints
(8,632 / 3,074 / 3,440).

**The gate, and how to re-run it.** All green at `5f9030e`:

| check | command | expected |
|---|---|---|
| types | `npx tsc --noEmit` | clean |
| lint | `npm run lint` | 2/2 |
| deploy | `node tools/qa-deploy.mjs` | 33/33 |
| seams | `node tools/probe-seams.mjs` | PASS, both maps |
| replay | `node tools/qa-replay.mjs` | 21/21 |
| determinism | the three arms below, **spelled exactly** | 7 checkpoints each |

Determinism is pinned in `tools/determinism-baseline.json` at **t+0/30/90/150/200/250/400**, three
hashes each: the float32 pool, `uf64` (exact float64 unit state) and `uctl` (discrete state).

```
node tools/qa-determinism.mjs
node tools/qa-determinism.mjs --battle="map=campus-martius&scenario=assault"
node tools/qa-determinism.mjs --battle="map=carthage&scenario=assault"
```

Quote the value or your shell backgrounds on the `&`. **`--battle=rome` is not an arm, and neither
is `--battle=carthage`.** The flag's value is appended verbatim as query parameters *and* used as
the baseline key, so a short name appends a meaningless parameter, loads the **field battle**, and
looks up a key that does not exist — a run that measured the wrong battle against no pin at all. It
does not go red. It asserts nothing. Those three spellings above are the only three keys the
baseline holds.

Confirm every run by headcount, always: **field battle 8,632 / Rome 3,074 / Carthage 3,440.** A
Carthage run reporting 8,632 measured something else.

> This table itself printed `--battle=<default|rome|carthage>` for a day, two thousand lines above
> the passage explaining why that is wrong, and three agents were dispatched with it. **A summary
> that contradicts its own document is worse than no summary**, because the summary is what gets
> read. If you correct something here, correct it everywhere it is spelled out.

### Standing rules, all earned

- **Agents do not merge to `main`.** Leave the branch, report, integration belongs to the
  orchestrator, who is the only one who sees every branch. One agent self-merged on 20 Aug and
  tripped a security review.
- **Never `git stash` in this repo while other agents run.** The stash stack is repo-global; two
  agents pushed in the same window and each popped the other's work. *Earlier guidance in this file
  said to stash — it was wrong.* Park work on a branch.
- **`--ours` on a baseline file discards a measurement, and a measurement is not a preference.**
  A conflict in a pin file is resolved by re-measuring, never by choosing a side.
- **Never grade an A/B deck its author has not declared frozen.**
- **A self-consistent instrument can never fail.** Compare against something outside the thing
  being checked.
- Worktrees need an isolated vite `cacheDir`. **Port 5173 is the owner's.**
- Unattended agents carry: *where you would normally ask, make the call, write down what you chose
  and why, and name what would change your mind.*

### Reserved for the owner — do not decide these

- Whether battle lines should **fit** their deployment boxes rather than merely be dry. Rome's line
  is 684 m across in a 500 m box; the host is 783 m in a 760 m one. Written into `ROME.md` §15
  task 14 so it gets decided rather than rediscovered.
- **The Rome balance shift** — defenders gained roughly a cohort as a side effect of walls that
  now work.
- The host storm order, the great wall-breaking ram, and the trailer's `rome-arch` beat.

### Queued, unassigned

- **`ROME.md` §15 tasks 6–15.** Tasks 0–5 have landed. Next: the twin-arched Porta Flaminia and
  the aperture rule (task 6), which the circuit pass deliberately left because splitting a gate's
  drawn/collided/rastered triple across two passes is how a gate becomes three widths.
- **The video design studio.** The owner asked for it and answered both questions — *script format
  first, GUI on top later*, and *staged setups allowed* — and it has never been spawned.
- **The docs-site analytics toggle.** One dashboard click at
  `vercel.com/ernest-4753/total-claude-docs` → Analytics → Enable. No API exposes it.
- `Engine.dispose()` has no caller; the clipmap flattens the ditch beyond 768 m; `shoot.mjs` stamps
  `srcTree` from `HEAD:src` so uncommitted edits mislabel frames; `battleCoreMask` is still centred
  on x 0; ground outside a deployment box is never flattened or cleared of vegetation.

## The player's outstanding list, with owners

Everything below came from the player. Items not listed here are done and committed.

- **cast shadows have no silhouette** — *unowned, and it is a design decision, not a bug.*
  Diagnosed but deliberately not attempted; the lighting workstream wound down here. The cause
  is not the shadow filter. The PCSS blocker-search theory (that its disc, up to 38 cm at
  cascade 1, is wider than the gap between two men and so saturates inside a formation and
  forces the widest blur) was tested in-session across all 231 materials and moves the frame by
  **0.009-0.017/255 over 0.00% of it** — dead. The real cause is that **nothing but the crowd
  casts**, so the formation's wedge has no environment of smaller shadows to sit among. Turning
  either candidate on is real work, not a flag:
  - *Terrain* (`TerrainSystem.ts:111`) has a correct `depthMaterial` already, so it is one flag —
    but it is off because the clipmap's outer levels carry 8-32 m triangles that the outer
    cascades cannot bias against a heightfield-resolution normal, and the middle distance breaks
    out in an acne lattice. It needs **slope-scaled bias per cascade** first. That is a lighting
    job and the per-cascade ortho extents it would need are already computed in `LightingSystem`.
  - *Grass* (`GrassField.ts:723`) is **not** a flag flip. The cards are alpha-tested and
    displaced by wind in the vertex shader and there is no `customDepthMaterial`, so enabling
    casting would shadow the undeformed opaque quad — solid rectangles, not blades, and not
    matching the sway. It needs a depth material replicating both, and then the fill cost of a
    dense camera-centred mesh with `frustumCulled = false` across seven clipmap levels. Judge
    that cost against `SHADOW_CULL_MARGIN`, which was once claimed to be free and measured
    0.88-1.78 ms.
  Whoever picks this up: interleave the A/B in one session (see traps), and note the
  anti-aliasing work has since changed grass rendering — MSAA, alpha-to-coverage and
  coverage-preserving alpha mips — so any grass cost measured before `023240d` is stale.

- ~~gate chokepoint snaking~~ — **done** `ab8b957`, lateral drift 0.202 → 0.063 m/s
- ~~units standing face to face not fighting~~ — **done** `ab8b957`, 0 → 708-772 blows in 60 s
- ~~`R` run key does nothing~~ — **done** `ab8b957`, sim-side 1.55 → 3.383 m/s
- ~~stragglers stuck behind the wall~~ — **done** `ab8b957`, 94 → 30 stranded
- ~~wall much wider; stairs parallel not perpendicular; scaffolding inside~~ — **done, uncommitted
  in `src/city/wall.ts`.** Curtain 3.5 → 6.0 m (`CURTAIN_T`), clear standing band 1.57 → 2.21-4.06 m
  (4-6 ranks at the sim's 0.72 m pitch, was 2); nine flights parallel to the face, 14.2-20.4 m along
  against 3.28-3.79 m of projection; scaffold, crane and deck all on the city side. `probe-wall`
  19/19, up from 12 assertions — the seven new ones measure exactly these.
- ~~gate shut by default~~ — **done, uncommitted.** `GateOut.open` is `false` at build time, the
  leaves are modelled shut with a drawbar and a bricked lunette, and `CitySystem` no longer clears
  the carriageway out of the occupancy grid for a shut gate. Siege opens it with
  `setGateOpen('porta-flaminia', true)`.
- ~~soldiers cannot walk past the towers on the wall~~ — **done, tower-pass workstream.** The
  link was never the problem: `LinkKind.TowerPass` existed, men were admitted to it and
  crossed. There was no *hole*. `buildPunicTower` took a `walkY` and ended `void walkY;` — all
  thirty-one Punic towers were one solid 20 m prism, clear lane **0.00 m**. Rome's chamber was
  pierced, but at `doorOuter -0.35 .. doorInner +1.35`, the clear band of a **3.5 m** curtain
  that has been 6.0 m for two workstreams, and `Siege.linkPath` walked men along the cityward
  lip 1.36 m past the far jamb: **path inside masonry at 25 of Rome's 25 finished-circuit
  towers and 31 of 31 on Carthage.** The lane is now derived once (`towerLane` /
  `punicTowerPass`), published as `GarrisonBay.passOuter/passInner/passLoY/passHiY`, cut out of
  the stone and read by `linkPath` through the same accessor. Rome 1.59 → **3.22 m** median
  lane, Carthage 0.00 → **5.72 m**, headroom 2.0 / 2.2 m, path inside masonry **0/25 and
  0/31**. Draws **identical at all nine cameras on both maps** (Rome assault 202, Carthage 198)
  — no new material stream, so no new mesh; +13,530 triangles across Rome's whole city, +0.38 %.
  `tools/probe-towerpass.mjs` 12/12.
- ~~elephants just disappear when they die~~ — **done, `f4ef850` + `f061813` + `c469fb6`.**
  Three layers, each hidden by the one above it. `Ragdoll` registered the animal's death and
  `UnitRenderSystem` read that as "the ragdoll owns this body", so the beast and its four crew
  left the instance buffer on the tick of the killing blow (`f4ef850`, which also gave the
  collapse its own render-side clock — it had been running on a man's playhead, 2.6 s of fall
  crushed into 1.0 and then frozen). With the animal visible again, it **turned on the spot
  while it died**: killed from astern the drawn heading snapped a full 180 degrees on the frame
  of the blow, then swung round again over 0.6 s, because a man's death-direction turn was
  being applied to four tonnes. That also silently inverted the crew's landing side and put the
  drawn body at up to 180 degrees to the capsule `partCarcasses` pushes men out of. And the
  capsule itself did not hold against cavalry: a 57-horse squadron settled 1.8 m *inside* the
  animal, because `resolveCrowding` has no per-man radius (a rider is a 2.4 m horse around a
  0.42 m point) and because the pass ran last and got whatever separation budget the crowd had
  left. Now: deepest overlap foot **0.026 m**, horse **0.224 m**, and a 320-man cohort ordered
  over a body walks round it with a carcass-shaped hole in the block. **The whole elephant tier
  costs 5 draws — 1 colour + 4 cascades — at every camera, with 1 animal in frame or 32, alive
  or dead, so a carcass costs nothing.** `tools/probe-elefield.mjs`; frames in
  `screenshots/elephant-death/`.
- soldiers use stairs, move laterally along the wall, descend into the city — siege
- much larger wall-breaking ram — siege. **The machine is built** (`spawnGreatRam`,
  `strikeCurtain`, 74 blows at 7 s, breach lanes) and **no scenario fields one**, so
  `breachReport().lanes` is 0 on both maps and the route is unreachable in play. It is
  orderable the moment one is deployed: `resolveMachineOrder` gives it the same right-click
  the tower has, at a stretch of curtain rather than a gate.
- ~~tower drawbridge backwards (ropes forward, door opens backwards)~~ — **does not
  reproduce**, and the measurement is signed: drawn reach **+1.940 m** off the InstancedMesh
  matrix (hinge 4.38, head 2.44). Do not "fix" it without a signed measurement saying it is
  wrong.
- ~~**ram jams the gate it just broke**~~ — done. It withdraws the moment the leaves come
  down: measured on both circuits, `withdrawing` at t+220 and `spent` by t+260, 17.4 m clear
  of the threshold, and the gang is handed back to the player.
- ~~**you cannot choose where the siege towers attack, or where the ram goes**~~ — **done,
  this session.** See the session note below.
- scorpion/catapult fire arrows instead of bolts and stones — artillery
- big catapults off the walls, manned, immobile, aiming, animated — artillery
- streets read as a patched quilt; wider and more streets; monuments dropped across housing — streets
- **trampled ground receives no shadows** — artillery (owns `src/vfx/`)
- soldiers at 2-4% luminance — lighting

### Masonry: what was left on the floor

The named separator — "every recess is painted rather than modelled, the sharpest instance being
brick coursing that shows identical contrast in sunlit and shadowed regions under raking light" —
is fixed at the *material* level and the workstream was wound down there. What was found and not
chased:

- **A 55 mm course cannot resolve at the distance the deck is shot from, and never will.** At the
  `wall` camera the curtain is 90 m away at ~14 screen px/m, so a course is 0.8 px and the sampler
  is at mip 4-5. The whole brick tile contributes **1.7% of that frame's visible micro-structure**
  after the fix and 2.1% before it; the other 98% is geometry and grain. Any further work on the
  *tile* is invisible at battle range by arithmetic. What reads at 90 m in the reference
  photographs of the real wall is **metre-scale geometry** — relieving arches, string courses,
  buttress masses, patch repairs — which is `wall.ts`, not `texgen.ts`.
- **No geometry in this project carries vertex tangents.** `computeTangents` appears nowhere;
  three.js falls back to the screen-space derivative frame. That is legal and it measurably works
  (the relief channel's sunlit-to-shaded ratio is 3.5), so it was not the cause — but it is a
  standing cost on every normal-mapped surface and nobody has priced it.
- **The shipped `wall` camera is not a raking camera and its subject is not raked either.** Its
  sun-versus-camera bearing is +22 deg. Worse, the sun bears 33.2 deg and the curtain's inner face
  normal bears 21.5 deg, so the sun hits the one large brick surface in the deck **12 deg off
  normal** — the flattest light available — while the outer face bears 201.5 deg and is in shade at
  every hour, exactly as the shot table's own comment says. The surfaces that are actually raked
  are the ones turned 90 deg out of the curtain: tower flanks and merlon returns.
  `probe-masonry.mjs` carries a `walltowers` framing at +102 deg that photographs both flanks of
  the same towers, one lit and one shaded. **The deck has no masonry frame that grades masonry.**
- The de-painting in `travertineAshlar`, `basaltPaving` and `roofTiles` is **inert as shipped**:
  those keys have a `manifestId` and `public/assets/manifest.json` exists, so they take the
  photographed path. It only bites with an empty asset folder. The photographed sets get openness
  from an `ao` map when the manifest lists one, and 255 (unoccluded, a no-op) otherwise — **no
  manifest entry currently supplies one.**

Done: flags now use the median soldier (`5e5ce44`); soldier materials (`5ec90a5`).

## Session — player command of the siege train, 19 Aug 2026

Branch `e/sim/siege-orders`. `Siege.ts`, one new `src/ui/SiegeOrders.ts`, and a **40-line
pure insertion** into `HudSystem.ts` (five sites, no deletions, no modified lines).

### The one that matters most: Rome's ram had never once opened Rome's gate

Twelve runs of twelve, `gateHp` 1.00 throughout. The owner's own hypothesis — *"perhaps they
all die"* — is right, and nothing said who was killing them. Wrapping `BattleSystem.damage`
and attributing every point: the crew is 32 at t+0 and 6 by t+40, and **4,846 of the 4,846
points came from two units**, `ballistarii#0` and `ballistarii#1`, shooting from 53–60 m.
Rome's garrison plan puts **216 hand-spanned crossbowmen** on the curtain either side of the
gate at 62 damage and 40 AP a bolt, and the ram is the nearest thing on the field because it
spawns 62 m out while the towers start at 74–101.

**The same instrument on Carthage records zero damage to the identical machine on the
identical approach.** So it was never the ram, the pathing or the gate: a *testudo arietaria*
had its shed **drawn and not modelled**, and the gang worked the ropes in the open.

`RAM_SHED_COVER` is a `modsOf(unitId).missileTaken` multiplier on whichever gang is working a
live ram, taken off them the tick it stops being theirs (`recrew` reassigns mid-battle).
**0.12 against the `testudo` formation's own 0.16.** Rome now keeps the schedule Carthage
always kept: leaves at **t+100**, **26 blows**, gate open at **t+220**, spent by **t+260**,
crew **32 → 24 at the breach and 13 by t+260**. At 0.2 the crew broke at 21 blows with the
gate on 19 %, so the number is sized against the machine finishing rather than against a
feeling.

- **`modsOf` is a free lane for this.** Nothing else in `src/` writes a *per-unit*
  `missileTaken`; only formations write `f.mods`. It is a plain table written inside
  `fixedUpdate`, so it is deterministic, and `Projectiles` already multiplies both.

### What the player can now do, and what they see before the click

- **One predicate, shared.** `resolveMachineOrder` is the only thing that decides a machine
  order; `machineOrderAt` draws the cursor from it and `applyMachineOrder` acts on it. Same
  for escalade: `findEscalade` is shared by `escalade` and the pure `escaladeOfferAt`.
- The ram carries its own `gateId`, blows are counted **per gate**, and the breach opens that
  gate and calls `setGateDoorBroken` on it. Never a literal id; `gateNear` reads `getGates()`
  and skips any gate already open, which is how Carthage's eight posterns stay out of a ram's
  target list.
- Measured with a real mouse through the real menu on Carthage: cursor reads *"Break the Porta
  Uticensis — 563 m, 17 min 10 s"*, the click re-aims the machine **563 m** from the Porta
  Byrsae, it rolls 563 → 500 m in two minutes, a second click sends it back, and the gate the
  player **last** clicked comes down at t+420 with 26 blows and its leaves drawn broken —
  the other two carrying **zero** blows.
- **Refusals are sentences.** landed / committed inside 12 m / another machine's berth /
  wrong machine for that target / nothing to climb at this bay / every file here is full.
- **The 590 s re-aim is not a bug and is now priced.** 0.42 m/s is the speed a gang on levers
  moves fifteen tonnes of green timber. `SiegeMachineOrder.seconds` carries the cost, heave
  included.

### Traps this session paid for

- **A berth is a bay, not a radius.** A click meant for the bay another tower held resolved
  **94 m** along the wall and was accepted, because the ray lands wherever the parapet is
  under the cursor.
- **"End the stalled plan and give the unit back" is the wrong fix and the probe said so in
  one line.** `releaseToGround` clears `elevated`/`support` for *every* man, so the nine still
  on the parapet were dropped at **313 m/s** and a 106.8 s descent was cut off at 20 s. The
  right fix is to fix the *question*: `standingOnWall` counts men on a station or a crossing
  instead of trusting `garrisons.has(id)`. Same distinction as `standingStation` against an
  assigned station.
- **`TowerState.Spent` was declared and never assigned.** Towers sat at `boarding` for ever —
  measured at t+962 on an uncommanded run — pinning their gangs, holding their berths and
  never being skipped by `escalade`. A/B: four towers `spent` and four gangs freed by **t+361**
  against four still `boarding` at **t+962** on main.
- **A draw-call arm that never ran reports free.** The first version of `so-draws` pointed the
  mouse at **y = −21.9** — above the viewport — Playwright clamped it onto the minimap,
  `overUi` went true and the HUD correctly drew nothing. Print the live hint as proof the arm
  ran, pause the world, and carry a control selection that crews nothing.

### Cost, measured

- Siege markers **+1 draw at the assault camera** (200 base / 201 a plain cohort / 202 a tower
  party / 200 again) and **+0** at a camera where any other marker is already using the air
  batch. No new mesh, no new material — `WorldOverlay`'s two batches.
- The gate's leaves against their own wreckage, one paused frame, A/B/A: **135 / 135 / 135**.
  `setGateDoorBroken` is free.
- Determinism **unchanged on both recorded baselines**: Rome 0fa6e702 / c6ef8d38 / 02c1ae6e /
  e4489ef0 / be60dea6 at 8,632; Carthage assault ebf383b0 / 18ead7c2 / 61e21556 / 9a2faabc /
  2fe6b1d4 at 3,440. The **Rome assault moves deliberately** — it is the battle the ram fix
  changes: t+0 identical, then 308ccb88 / 079008fa / 2ac50406 / 2132a9e8 against main's
  b08662d6 / 0885b6b4 / ae6c3bbc / c7b98360, and **+169 men alive at t+200**.

## Measured facts that must not be re-derived

- **`tools/matchup.mjs` is exactly reproducible on a quiet box, and its documented ±8% is
  machine load arriving as a discrete outcome.** Run case by case with the arms alternating in
  one session, **20 of the 22 cases come back byte-identical** across a real change — same
  winner, same second, same losses, same melee peak and mean. Run as two whole suites an hour
  apart at loads 10 and 45 and **four cases flip winner on an unchanged tree**:
  `spears-vs-legionary` (A 111 s / B 90 s), `legionary-vs-warband` (A 163 s / B 175 s),
  `chosen-vs-cohort` (B 141 s / timeout) and `even-grind` (A 144 s / B 137 s). All four are
  near-even by construction, so the winner is whichever side breaks first and a few extra rAF
  ticks between round-trips decide it. **Never compare two whole-suite runs.** Alternate
  `--only=<case>` between two ports pinned to two commits; that is the instrument.
- **`cav-vs-archers` was never about the approach, and no sagittarii stat was wrong.** Sliced
  by the ten metres the horse is crossing, the charge arrives having lost **2 of 50 — the 4%
  the case is documented to produce** — both before and after the missile friendly-fire fix.
  300 arrows over 150 m of open ground buy one dead rider. Every extra loss happens *after*
  contact, because `inMelee` was `contactLock || engagedFraction > 0.18` and a hundred archers
  with a fifty-horse wedge standing in them satisfy neither: the wedge presents a tip, five or
  six men have an opponent, `engagedFraction` reads 0.05. The unit volleyed on at **1.7 m** —
  55 hits and six dead riders in one second, from arrows the lofted solve draws to **4.6 m/s**
  over a two-metre gap, doing full listed damage because damage is a roster number and not a
  function of speed. Before the friendly-fire fix those arrows were eaten by the archers' own
  front rank at the muzzle. Fixed with a 7 m front-to-front hold, which is the number
  `Abilities.shouldAuto` already used for a pilum volley.
- **`skirmish-mode` is on by default on every skirmisher** (`statesOf`: "the two toggles start
  engaged"), and `runSkirmish` gave ground to *anything* inside 30 m. Numidian cavalry ordered
  to attack `sagittarii` closed to 32.9 m, were pushed back to 44.7 m — `SKIRMISH_FALLBACK *
  0.85` exactly — and stood there sixty seconds losing 28 of 54 to a 165 m bow without a man
  reaching a man. That, and not a stat line, is why `numidian-vs-archers` read the wrong way
  before the friendly-fire fix as well as after it.
- **A javelin refusal on Carthage is not a parapet problem.** `maxRange` genuinely was a
  level-ground bound compared against a horizontal distance and it is now the launch solve's
  own discriminant envelope — but the fix is **inert on both maps**: attempts and refusals are
  3,107 / 550 on both arms, because every weapon's roster range is far inside its physical
  reach even at the **14.7 m** Carthage's garrison stands above the ditch. **No shot in 6,400
  leaves without a ballistic root**, so "the discriminant goes negative and it fires at 45°
  into the wall" cannot happen here: a 24 m/s javelin's ceiling is 29.4 m against a 13.4 m
  parapet. The 43% refusal rate is one early window — sliced it is 40.5 / 47.1 / 21.5 / 31.4 /
  5.4 / 1.1 / 0 / 0% and pools to **17.7%** — and **448 of 550 refusals are more than twelve
  metres *below* the muzzle**, with 279 inside 1.1× of the bound and 211 more inside 1.25×.
  They are the garrison throwing down at men just past a 30 m horizontal bound at the moment
  a unit acquires a formation whose centre is at the edge of its range, and **a refused shot
  costs no ammunition** (`p.ammo[i]--` is the last statement in `launch`), so it is a hold.
  Do not convert `missile.range` for height: doing it takes `punic-levy` to 43.1 m and its
  hits per attempt from 24.6% to 20.3%, and its own roster comment says the 30 m is a decision.
- **Melee never credited a kill to the wrong side, and that is now measured rather than
  argued.** `acquireVisit` and `trampleVisit` are the only two things that name a melee victim
  and both reject the shooter's own faction. Wrapping `BattleSystem.damage` in the page over
  the Rome assault, the Carthage assault and the Campus Martius — 662 s — records **2,781
  lethal blows, 1,889 of them melee, and not one same-faction credit**; the only uncredited
  deaths are the 46 the missile path gives to nobody on purpose. Kills against bodies: Rome
  618/699 and 589/612, Carthage 294/309 and 491/493. `damage` now refuses the credit at source
  and `battle.creditRefused` should stay 0.

- **The game is not slow. It hitches, and the hitch is a shader link.** On an *idle* box
  (load 9.6) Carthage at ultra runs `engine.frame()` at p50 **2.60 ms**, p99 **7.00**, with
  one frame in 2,899 over 16.7 ms and none over 33. The heaviest scenario in the game —
  the Punic army with elephants — is cheaper still at p50 **2.30**. The cleanest single
  result in the study: over 2,299 frames, **exactly four frames missed 16.7 ms, all four
  linked a shader program, and there were exactly four link frames.** Zero false positives,
  zero misses. Frames that linked: p50 49.90 ms. Frames that did not: p50 2.30, p99 5.00.
  three.js links a program the first frame a material is *drawn*, and there was no
  `renderer.compile`/`compileAsync` in the tree. Fixed in `Engine.initAll`. It is
  camera-triggered — first sight, not heavy fighting — and the program count was still
  climbing at t+88 s of battle, so it never stopped happening.
- **Every frame-time number ever taken on this box below load ~15 must be re-taken before
  it is believed, and `uptime` cannot tell you when.** Load average is a CPU run-queue
  metric; the frames here are GPU-bound. The *quietest* runs (load 9-17) initially produced
  the *worst* rAF figures and the most expensive shader links (177-290 ms against 38-75 ms
  at load 64), because other agents' Chromium instances saturate the GPU while barely
  moving the run queue. Re-run at load < 15 and the same links cost 5-57 ms. An earlier
  round of this workstream's own numbers was inflated this way and had to be retracted.
- **`engine.frame()` is blind to the resolution lever.** At dpr 2 against dpr 1 — four times
  the pixels — cost *per 1-step frame* is **11.50 vs 11.40 ms** and render p50 is 1.30 vs
  1.30, while the rAF interval goes 16.40 → 33.60 (**2.05x**) and frames over 33 ms go
  3 % → 72 %. `frame()` returns when the command buffer is submitted; the pixels are paid
  for afterwards. **Measure any resolution work on the rAF interval or it will read as a
  no-op when it is the largest lever on the project.**
- **One `PostFX` reallocation costs ~4.1 ms, and `new WebGLRenderTarget` allocates nothing.**
  Three creates the texture and framebuffer lazily on first bind, so timing `allocate()`
  alone reports 0.3 ms for nineteen 1080p targets — which cannot be true, and is the shape
  of an arm that never ran. With the materialising frame inside the timed block: best 36.8
  against a 32.7 ms control, i.e. **4.1 ms best-of-blocks, worst observed 668 ms**. A second
  workstream measured 4.3 ms in situ independently.
- **A `setPixelRatio` that does not reach `PostFX.resize` is a silent no-op.** Three's
  `setPixelRatio` internally calls `setSize(w, h, false)`, so it does resize the backing
  store and leave the CSS size alone — a real continuous lever at any dpr, including below
  1. But `PostFX.allocate` sizes all nineteen targets from `getDrawingBufferSize()` at
  allocation time, so without a reallocation the whole scene keeps rasterising at the old
  resolution. The lever moves a number and buys nothing.
- **`compileAsync` must NOT be wrapped in a force-visible traverse, and the obvious reasoning
  says it must.** It walks the scene with `traverseVisible` (`three.module.js:17385`,
  `:17403`), so every hidden LOD tier and pool mesh is skipped — which is exactly the set
  that links mid-battle. Forcing them visible first is nevertheless **worse than doing
  nothing**: 27 programs compiled against a plain call's 44, and all 22 mid-play links
  still land. Excluding lights from the forcing changes nothing either. Both guesses were
  tested and both were wrong; the mechanism is not established. Plain call on Carthage:
  links during play 22 → 5, worst frame 583.7 → 73.0 ms. **On Rome it does nothing
  measurable** (22 → 23 links, 588 → 553 ms) because it links only 27 programs there.
- **The engine has no unguarded per-frame allocation.** All 46 `update`/`preRender`/
  `fixedUpdate` bodies in `src/` were brace-matched and scanned: nine allocation-shaped
  lines, every one a growth-only guard (`DustEmitter.ts:125-129`, `LightingSystem.ts:596`)
  or trivial. **GC pressure is not the cause of any stutter here** — do not go looking.
- **`fixedUpdate` after the spatial-hash fix is healthy**: 3.00 ms/tick at 8,632 men idle,
  2.00 at 3,311, against a 4 ms budget and the 3.657 ms previously on record. The 6.05-6.20
  ms first measured was pure contention. The multi-tick amplifier (a stall fills the
  accumulator, so the next frame fires all five `maxStepsPerFrame` ticks) is real on a
  loaded box and **almost absent on an idle one** — 2,899 idle frames ran only 0-step and
  1-step frames.
- **A median frame time cannot show a stutter, and the HUD only had one.** It reported the
  median of a 48-frame ring and *discarded* every frame over 333 ms, so a distribution with
  a p50 of 9 ms and a p99 of 60 rendered as "9.0 ms/f 111 fps". It now prints p50, p99,
  worst, a stall count and `prog`, the linked-program count — a program count that climbs
  during a battle is a mid-battle compile, and it is the one stutter cause that leaves no
  other trace: draws, triangles and men are all unchanged on the frame that pays for it.
- **`.gitignore` read `node_modules/` with a trailing slash, which matches a directory and
  not a symlink to one.** Every agent working in a `git worktree` symlinks that path back
  to the main checkout, so it was never ignored by anybody: `git add -A` committed a
  mode-120000 blob holding an absolute machine path. It happened twice in one day on two
  branches after `a9227c3` had already cleaned it once. The pattern is fixed; the failure
  mode is worth remembering because the branch works perfectly in the worktree that created
  it and fails everywhere else as `Cannot find package 'three'`.
- **`EventBus` can recurse to a stack overflow through its own deferral drain.** It defers a
  re-entrant emit and then drains the queue *synchronously in its own `finally`*, where the
  drained call finds `dispatching === 0` and dispatches for real. So a handler that answers
  `qualityChanged` by writing quality recurses through the drain, and **no re-entrancy flag
  can catch it** — the flag is cleared before the deferred call runs. Guard by only emitting
  when a field actually moved.
- **`LightingSystem.resize` early-returns unless the cascade count changed, so writing
  `shadowMapSize` at runtime is a silent no-op.** Another instance of the house failure mode.
- **`quality.maxSoldiers` is sim-side and `setQuality` used to overwrite it.**
  `BattleSystem.init` sizes the `SoldierPool` and eight typed arrays from it and
  `scenario.ts:293/644` scale unit size through `fittedUnitScale`, so a runtime tier switch
  took a deployed battle's cap to 1,600. It is pinned now. **`low` is not merely a render
  tier** — it deploys 1,515 men against ultra's 8,632, which is why a low-tier frame
  photographs a different battle.
- **MSAA `medium: 2` is gone.** 4x against none is 1.18 ms and 4x against 2x is 0.07 ms, so
  2x paid 94 % of full price for half the samples. `MSAA_SAMPLES` is now a binary 0-or-4
  lever worth 1.18 ms. `low` has always run 0 and grass sets `alphaToCoverage`
  unconditionally, so medium at 0 is a path the engine already shipped.
- **Grass density is one uniform write.** `geo.instanceCount` is fixed at 168,400 whatever
  the density; `uDensity` only feeds `step(h3, cover * uDensity)` in the vertex shader and a
  rejected clump collapses to a zero-area quad. So the largest single knob in the project
  (0.55-3.71 ms) costs nothing to operate — no reallocation, no recompile. **Resolution is
  the expensive lever to operate even though it is the smooth one to look at**, so spend
  grass and `postfx.enabled` first.
- **The `radius * 0.55` chunk-LOD pin is already fixed.** `CitySystem.surfaceCorrection`
  caps at `Math.min(c.radius * 0.55, nearSwitch * 0.5)`, landed in `a974a28`. The residual
  pin is uncapped chunk *radius* in `landmarks.ts:199-200`; Carthage caps it
  (`carthage/fabric.ts:811`) and Rome does not. Still worth ~7-10 draws.

- **Rome is NOT short of roof, and "20.5 % built" was an instrument reading its own streets
  as failure.** `city-audit.mjs` built its street keep-out from `layout.ts`'s exported
  `WAYS` — the twenty-two named viae, 11 km. The district generator cuts a further **374
  lanes and 38 km**, and nothing outside `wayMix`'s running total could see them, so every
  vicus in the city was scored as unbuilt ground: 39 hectares of carriageway counted as a
  gap. With the lanes in (`CitySystem.getLanes()`), the same unchanged city reads
  ways 17.4 → **24.9 %**, free 35.6 → **28.1 %**, and **roof between street lines
  53.9 → 68.7 %** — inside the 60-70 % the AGEA orthophoto gives for the historic core.
  Do not "fix" the density; it is in band. Of the free ground that remains, **63 % lies
  under no district mask at all** (17.7 % of walled land) and only 29 % is inside a
  quarter's plateau. The real remaining difference from the orthophoto is **grain, not
  coverage**: AGEA's blocks are smaller and each is punched with 1-4 courts of 10-25 m,
  where ours are larger with one big court; their vici are 4-8 m and far more numerous.
  Aim the next pass at finer grain, not more roof.
- **The 60 m pomerium is met exactly, and `openGroundBehindWall min 40` was the instrument.**
  `probe-nav` sampled x −650..1200 against a `wallZAt` that clamps to the last segment,
  but the curtain ends at **x = 1144**. The four reported "intrusions" at x 1174-1198 are
  30-54 m *past the east end of the wall*, measuring a depth from a frozen z-line with no
  masonry near it. They were labelled `wall` by nearest-**centre** — the Castra Praetoria's
  278 × 262 m footprint has its centre 200 m from its own corner, while a curtain bay's is
  30 m away. Restricted to the wall's real span and labelled by **containment**: min
  **60.0 m** over 220 samples, zero intruders. Neither `POMERIUM` nor the curtain alignment
  was wrong. The Castra crosses the crest by **−18.6 m** (it is 18.6 m inside), so even its
  documented `atWall: 0.02` licence is unused.

- **The crowd is the only thing casting a shadow in a battle frame.** `probe-shadow.mjs`'s
  `all shadows` and `crowd shadows` arms return *identical* figures at both close cameras
  (9.768/255 over 22.80% at `romanline`, 9.851/255 over 17.73% at `raking`). `TerrainSystem`
  sets `castShadow = false` and so does `GrassField`, so there are no hill shadows and no tuft
  shadows — only men, horses, engines and some city meshes cast. This retires a critic note:
  "individual grass tufts a metre away cast crisp shadows while the formation drops one merged
  grey wedge" is comparing a cast shadow against grass **self-shading**, because grass casts
  nothing. The wedge reads as pasted on because it is the only cast shadow in the frame, with no
  environment of smaller shadows to sit among. See the missing-casters entry under the
  player's list for what each would cost.
- **The shadow noise floor is 0.000/255, not the recorded 1.42-1.47.** That figure was
  established before `Engine.advance` was found to be running five sim ticks between the two
  frames it called "no change at all". With the clock paused the floor is exactly zero, so every
  shadow result previously declared clean against 1.42 was declared against a moving world.
  Crowd shadows at `wide` measure 1.033/255 over 2.92% — under the old bar that was
  undetectable; it is real, just small.

- ~~Soldiers render at 2-4% of display luminance.~~ **RETRACTED — a unit error, and it
  misdirected three rounds of work.** `probe-units.mjs` reports *display-linear* values, as its
  own header says; 0.0354 / 0.0316 / 0.0204 linear are **0.207 / 0.196 / 0.157 display**. A second
  independent instrument agrees: soldiers 0.1745 display, ground 0.3126 (which is the "~30%
  ground" figure, so *that* one was display all along — the comparison mixed two unit systems).
  Rome II plates measure **0.2957 display / 0.1068 linear**. The true gap is soldiers ~0.17-0.21
  against ~0.25, about **1.4×, not 8-12×**. This is why three successive fixes each measured a
  real gain and each still felt like nothing: they were sized against a target 8× too far away.
  A fix sized for 8× would wreck the frame. There *is* still something to fix — a quarter of
  soldier pixels sit below 0.059 display and the median is 0.125, genuinely bottom-heavy — but
  size it for 1.4×.
- **The hemisphere fill drops a factor of π**, confirmed against three.js shader source.
  `getIBLIrradiance` returns `PI * envMapColor * envMapIntensity` — an irradiance.
  `getHemisphereLightIrradiance` returns `mix(ground, sky, w)` with **no** π, so its colour must
  already be an irradiance. We pass `skyFillColour`, which `atmosphere.ts` computes as a
  cosine-weighted mean *radiance*. Measured live, the fill delivers **10.9%** of the sky's own
  physically-derived irradiance (E(up) 0.0494 against π·L = 0.4529). The scattering integral is
  right; its application is wrong. The two ambient paths in the rig are quoted in different units.
- **Aliasing is the leading separator, and it is the only measure that has ever split the decks
  cleanly.** harshness = (full-res Laplacian energy) ÷ (Laplacian energy after a 4× low-pass); a
  ratio, so prior JPEG on the press plates cancels. **Ours 0.879-1.515 (mean 1.137), Rome II
  0.290-0.650 (mean 0.427) — 100% separation with an empty gap.** Not a detail deficit: Rome II's
  `frame-03` has the highest structural detail in the deck at 32.26, above eight of our ten. Ours
  is *inverted* — more energy at pixel scale than at structure scale, the signature of missing AA,
  mip and specular filtering. Symptoms two graders reached independently: untapered aliased spear
  lines, flat quadrilateral shields, grass legible to the horizon then stopping at a hard seam.
  **The ratio is one blur away from being gamed and must never be quoted alone.** A Gaussian of
  σ ≈ 0.6-0.8 px takes it from 1.656 to 0.464 — straight through the whole gap — because it is
  dominated by the final image's sub-pixel point-spread function and cannot tell "well filtered"
  from "slightly soft". Cross-check every movement against `tools/probe-shimmer.mjs`, which
  measures sub-pixel temporal stability and which a blur cannot fake, and **treat a sudden
  collapse in the ratio as suspicious rather than as progress.**
- **Do not raise ambient.** Darkest-quartile luminance: **ours 0.159, Rome II 0.122** — our shadows
  are already 30% brighter. Warm/cool separation, (b/r in darkest quartile) ÷ (b/r elsewhere):
  **ours 1.11, Rome II 1.85**. So the defect is *hue muddle at too high a level*, not darkness:
  our lit and shadowed pixels are nearly the same hue. The fix is more contrast between the two
  ambient hemispheres at equal or lower total, which is what the chromatic ground bounce does
  (sky-to-bounce hue contrast 3.55 → 9.3 at luminance 0.1013 → 0.1016).
- **A procedural normal map is gone by the time anything is 40 m away, and no `normalScale`
  fixes that.** Measured on the brick tile: mean tangent-space |n.xy| runs 0.271 / 0.254 / 0.237 /
  0.144 / 0.043 / 0.031 down the mip ladder — **84% of the perturbation is lost by mip 4**, because
  a bump's two slopes are equal and opposite and cancel under averaging. An albedo band has a
  non-zero mean and survives. That asymmetry is *why* every recess in this project reads as paint,
  and it applies to every generator in `texgen.ts`, not just brick. The counter is a **scalar**
  derived from the same height field: occlusion averages like brightness. `texgen.horizonOpenness`
  bakes one into the ORM texture's R channel (which was a hard-coded 255 read by nothing) and
  `materials.MICRO_RELIEF_PARS_GLSL` spends it on the direct light. Landed for masonry; **soldier
  kit, terrain and engines all have the same defect and none of them have the counter.**
- **Measuring "painted versus modelled" needs arm differencing, not a single frame.** Band-pass
  amplitude over a whole frame is dominated by geometry edges and grain — at the shipped `wall`
  camera the brick tile is only 1.7-2.4% of it — so a real change hides inside the noise.
  `tools/probe-masonry.mjs` removes one channel at a time from the live material and differences
  frames of an identical *paused* world; the reproducibility floor of that difference measures
  **0.00000**, so anything above zero is signal. That technique is general and worth reusing.
- **The crowd is NOT short of variation.** Read from the uploaded instance buffers: one 320-man
  cohort carries 57-59 kit masks, 119 statures, 229 cadences, 314/320 distinct animation phases,
  252 tunic colours. Adding variation is the wrong fix.

- **`MELEE_TEMPO = 1.5` is settled against, and the reason is `ENGAGE_PER_WIDTH`.** Josh
  Kappler's constant was declined as arithmetic (1.5x blow rate is 1.5x damage rate) and
  defended on the grounds that the acquisition-radius change would move how many men are in
  contact by enough to cancel it. Measured on pinned worktrees at `cb80afd`, both arms, three
  independent instruments: pair-level engaged men (`probe-meleegeom`) **19.5 -> 22.1** and
  **17.0 -> 24.0** for swords and **49.8 -> 50.0** for the spear control; mean men in melee
  across `matchup.mjs`'s twenty-two cases **+20 %**; men in `Fighting` in the full 8,632-man
  battle **432 -> 465 median**. Nothing halved and nothing reached 1.5x, so there is nothing
  for a flat tempo to cancel against. **The mechanism is the finding: `peakFight` is
  *identical* on both arms in every real line engagement** — 82/82, 67/67, 87/87, 75/75,
  102/102, 104/104 — because `ENGAGE_PER_WIDTH` is a hard per-unit ceiling on men in contact
  and the acquisition radius cannot raise it. It only decides how much of the time a unit sits
  at its ceiling. **No reach change can ever move contact by 1.5x in a line fight**, so the
  defence was never available, and a 1.5x tempo would land straight on the damage rate: the
  `even-grind` control is already 130 s after the reach fix and would go to about 87 s, under
  the 120 s floor. Do not adopt the constant.

- **The gate chokepoint did not regress and the old figure was not wrong — the wall got
  thicker.** `ab8b957` recorded lateral drift while fighting **0.063 m/s** and **188 per
  mille** inside masonry; a collision agent read **0.203** and **350.8** at `c20f711` and was
  disbelieved. Measured at `cb80afd` on unmodified main: **0.158 m/s** and **372.9 per
  mille** — corroborating the second reading, not the first. `Combat.ts` and
  `BattleSystem.ts` are **byte-identical between `ab8b957` and `c20f711`**, so no melee code
  changed at all. What changed is `1a56522`, which landed *after* `ab8b957` and took the
  curtain from **3.5 m to 6.0 m** (`CURTAIN_T`). `probe-melee --case=gate` measures men
  within 12 m of the gate through the passage, and that passage is now 71 % longer, so the
  window holds more stone and men queue in a tunnel nearly twice as deep. **The two numbers
  were measured through two different walls and are not comparable.** Any chokepoint figure
  quoted from before `1a56522` needs the same treatment.

- **"Units pass through the walls" was Carthage, not Rome, and no man-tick counter in this
  repo could see it.** Every penetration measure here — `probe-nav.penetration`,
  `probe-melee`'s gate window — grades the men against the *obstacle set*. When the obstacle
  set is the thing that is wrong, they all agree with it and report zero. Two faults, both
  now fixed, both found by measuring the **drawn stone** instead (`tools/probe-solid.mjs`
  casts against the baked chunks and reports mesh / boxes / raster as three independent
  views):
  - `recutWallObstacles` re-emitted only the boxes derived from `wallBlockers` after
    filtering out everything of `kind: 'wall'`. The **stairs** are `'wall'`. `Siege.armGate`
    toggles the gate open-then-shut on tick 1 of every battle, so Rome went 56 wall boxes to
    47 and Carthage 160 to 147 **before a man had moved** — all nine and all thirteen
    flights, non-solid for the rest of every battle since `27a9e85` added them.
  - ~~Carthage's **eight posterns are published as already-open gates and the stone is never
    cut**~~ — **fixed**, and the guard has retired itself. `buildPostern` set a pierced arch
    *panel* into each face while the wall's own body ran straight across behind it: a ray
    down a postern axis stopped at **8.03-8.10 m** at every height and every lateral offset,
    and `porta-byrsae` at **8.39-8.67 m** with the leaves excluded. The passage is now a
    `WallCut` hung on the bay and read by all three of the things that have to agree with it
    — the panels `buildMainBay` leaves out, the mouth `buildPostern` sets in the hole, and
    the stretch of gallery that stands down beside it. Every ray now runs clean through:
    `getUnpiercedGates()` is empty on both circuits, `probe-carthage-wall`'s E5 is green and
    its new **E7** casts 78 rays through the mouths and the carriageway against the drawn
    stone. Draws **identical at all nine Carthage cameras** (assault 198), triangles within
    0.2 %. Two things found on the way and both fixed: every `% 8 === 5` bay is also
    `% 4 === 1`, the wall-walk ramp's cadence, so **five of seven posterns opened their
    cityward mouth into the side of a 3.4 m masonry ramp** (posterns moved to `% 8 === 6`,
    same count and spacing, which also stopped `postern-13` and the Porta Maritima sharing
    bay 13 on the shipping line); and the two gate leaves stopped 30 mm short of the
    centreline apiece, so a ray went **through the shut gate** down the 60 mm slot between
    them.
  Man-ticks inside the curtain's own footprint per thousand, 45 s after a 20 s warm-up:
  Carthage infantry **16.71 -> 0**, cavalry **10.13 -> 0**, rout/engine/garrison 0 in both
  arms; Rome **0 in every class in both arms**. And measure a man's **centre**, not his
  inflated body: a man correctly stopped rests at `halfW + 0.42` and a body test counts the
  whole front rank as inside — worth a spurious 52.4 per mille on Rome.

- **56.2% of a soldier's triangles disagreed with themselves, and a battle frame could never
  have shown it.** `MeshBuilder` wrote a shading normal per vertex and a triangle order, and
  nothing tied them together. `revolve` emitted normals that were the *exact negation* of its
  own winding for every profile, so every helmet bowl, the skull, the hair, all four shield
  bosses and every lathed weapon head drew correctly and lit itself inside out — at
  `envMapIntensity: 2.9` a helmet crown sampled the ground hemisphere instead of the sky, which
  is why a bronze galea rendered as a flat cream lampshade. `box` got a left-handed basis on
  four of six faces, so ±X and ±Y were **culled** by `side: FrontSide` and a box drew as two
  facing panels with the world between them. Fixed at `5eb55f0` by deriving winding from the
  normals (`quadFacing`/`triFacing`); `tools/probe-soldiermesh.mjs` reports 0 / 4,307. Identical
  vertex and index counts, so the cost is nil. **Culling and shading disagree silently: a mesh
  can render solid and still be wrong, and only a per-triangle probe finds it.**

- **The shield boss was modelled, tinted and drawn every frame, on the wrong side of the board.**
  `boss()` is a lathe under `rotationX(+PI/2)`, and all four call sites passed a negative axial
  offset: the scutum's umbo sat 219 mm *behind* the face it should stand proud of, the oval's
  114 mm, the round's 56 mm. "No boss geometry, no rim bevel" is the cue both round-23 graders
  named first or second. Fixed at `d237d1c`; `boss()` now takes the board's own front-face Z so
  the mistake is not expressible.

- **"No smooth region anywhere in frame" is the grain pass, not the geometry.** The adversarial
  grader's strongest scalar (32px tiles with Laplacian std < 1.0; plates 0.31-15.10%, ours
  0.00-0.05%, 20/20) was attributed to "renderer dither or terrain polygon faceting". Measured
  on one isolated-model plate, switching only `uGrain` (`PostFX.ts:1140`, ships **0.016**):
  **0.016 -> 0.00%, 0.006 -> 2.21%, 0 -> 69.67%**, against Rome II soldier crops at mean 7.09%
  (range 0.48-24.03). One uniform. Re-shot at 0.016 twice for 0.00 both times, so it is stable.
  **0.006 lands inside the reference range.** Owned by the render workstream — one default.
  And the statistic itself is weaker than believed: with the backdrop flood-filled out it
  collapses from 100% to 80/70% balanced accuracy, i.e. it was largely measuring the background.

- **The separation is a one-pixel spike, and it is not the background.** On the isolated-model
  deck an adversarial grader flood-filled the backdrop, eroded the silhouette 4 px and measured
  the figure only. Octave decomposition: at **4, 8 and 16 px the two pools are statistically
  identical** (60-65% balanced accuracy = chance) — our models are not worse-proportioned,
  worse-posed or worse-lit at coarse scale. The whole separation is the **1 px ÷ 2 px energy
  ratio: ours 2.01-3.61, Rome II 1.20-1.35, no overlap.** The target is to drive it under 1.4
  **by adding energy at 2-8 px — normal maps, roughness variation, wear, cavity, grime — and
  never by blurring the 1 px band**, which lowers the ratio while making the model worse. That
  is the same trap the harshness note records, found independently by a second instrument.
  Two statistics that *fail* here and should stop being quoted at this magnification: local RMS
  contrast at 32 px (80%, and the sign is **backwards** — Rome II is higher), and a
  Gaussian-blur high-pass (70%, because the blur residual is dominated by the mid-band the two
  pools share).
- Raising metalness *darkens* armour here — verified twice. Full metal trades a sunlit diffuse
  term for a dim blue sky reflection under a sun-dominated rig with a weak probe.
- `LightingSystem.ts:87` hemisphere fill is `0x9dbcdc / 0x6b5a3e` at 0.42, set to 0.34 at line 477,
  against a sun at 2.93.
- `GroundDamage.ts:352` sets `receiveShadow = false` on a raw `ShaderMaterial` at `renderOrder 1`,
  so trampled ground paints out the terrain's shadow.
- True frame times are melee 8.31 ms, clash 8.88 ms. **Every fps figure in this project's history
  before the harness clock fix was roughly double the truth.** Confirmed from the other side at
  `a974a28`: a *real interactive* session — page-driven `requestAnimationFrame`, HUD up, camera
  panned, rotated and zoomed, units drag-selected and right-click ordered — measures
  `engine.frame()` at p50 **9.1 ms**, p90 11.0, mean 8.84, over 927 frames at machine load
  27-42 (`tools/probe-interactive.mjs`). The rAF interval in that session is p50 25 ms, but
  that is headless compositing and six other agents, not this codebase.
- `fixedUpdate` 3.657 ms at 8,632 men idle, 3.964 ms routing across the wall, against a 4 ms budget.
  The melee acquisition-radius change costs **+0.06 to +0.09 ms** on the best block, measured
  with both arms rotated inside one browser session against two pinned worktrees at `cb80afd`
  (base best 3.322/3.360, candidate 3.408/3.423, two runs, load 4.2-7.4). The medians disagree
  in *sign* between those two runs (+0.022 and −0.141), which is trap 9 doing its job: at this
  size only the best block is an estimator. Note these absolutes sit below the 3.657 above
  because the harness sets `renderOverride` to a no-op, so the sim band is not sharing the
  thread with the GPU submit — good for the delta, not comparable as a level.
- **The frame is a small colour pass and a large shadow pass, and only the second scales with
  tier.** Rome assault at ultra: 98 colour + 98 shadow + 23 post = 219. The colour pass is
  96-101 at *every* tier. **A casting mesh costs one call in the colour pass and one more per
  cascade — five on ultra.** Cascade 0 (39 m across) draws the same objects as cascade 3
  (745 m), because every caster is a merged mesh that straddles all four. Full per-camera
  per-tier table in `ARCHITECTURE.md` §4; worst is the assault at 219 against the 220 cap, and
  panning in a live session touches 226.
- **Soldier draws are 6, not 121-122.** Read off the live scene at t+72 s: the unit render
  group submits six meshes carrying 826-1,210 instances. The ≤12 target is met. The 121 figure
  is stale — it looks like a whole-frame count that got filed under soldiers.
- **The assault camera has never been inside the 220 cap, and the last forty commits cost it
  five draws.** Bisected with `tools/bisect-draws.mjs`, a worktree and a vite and a boot per
  commit: **254** at `9639c4c`, the commit that *created* the assault scenario, and **259** at
  `7a313fe`. There is no culprit commit and nobody should go looking for one.
- **MSAA costs about 1.2 ms, and 2x is not worth having.** Eight camera-measurements over two
  interleaved sessions at loads 42 and 60, wall-clock best-of-blocks. 4x against none:
  −1.56 −1.70 −0.77 −1.01 −0.55 +0.42 −2.11 −1.35, median **1.18 ms**. 4x against 2x:
  +0.36 −0.34 −1.15 +0.32 +0.15 +0.71 −0.15 −0.45, median **0.07 ms**. So the author's claimed
  +1.1 ms was right, and **the cost is in having a multisampled target at all, not in the
  sample count** — 2x pays 94 % of 4x's price for half the samples. `MSAA_SAMPLES` should read
  0 or 4 and never 2; `medium: 2` is the worst cell in that table.
- **Anisotropy 16 → 8 is not a lever**: −1.03 to +0.90 ms across four cameras, inside the
  noise, on a change already measured as worth 0.008 on image quality. Grass density 100 → 50 %
  is worth 0.55-3.71 ms and is the largest single knob at the wide and city cameras. The whole
  post chain is worth 1.6-3.5 ms and 22-25 draws.
- **The driver caps MSAA at 4 here.** `renderer.capabilities.maxSamples` is 4 under headless
  ANGLE-on-Metal, so an 8x arm silently resolves to 4x and would measure as free.

## Traps that have already cost time

1. **Probes silently fall back to a stale `dist/`** if no dev server is on their port. This made
   `probe-wall` report 5/12 when the live tree scored 12/12. Always pass a port whose server you
   started and read the tool's first line.
2. **`tsc --noEmit` goes blind to every semantic error program-wide** the moment any file has a
   syntax error. Use `node tools/typecheck.mjs --mine=<path>`; INCONCLUSIVE (exit 2) is not a pass.
3. **Vite HMR resets `window.__game` mid-measurement** when another agent saves. Run probes with
   `TC_NO_HMR=1`.
4. **Killing vite by `grep -v "port 5173"` misses the dev server**, because `npm run dev` puts no
   port on its command line. This has killed the player's server three times.
5. **`RTSCamera.jumpTo` parked the focus at y=0** — sea level — then let `update` float it up
   to terrain height at damp rate 9. A quarter-second after a jump the eye is still 10.5% of
   the terrain height low. Every graded plate was shot through a climbing camera, and the
   player got an unrequested swoop on every load. **Fixed** — `jumpTo` now samples `heightAt`.
   Any framing measured before this fix is suspect.
6. **Cross-session before/after is not a measurement on this project.** Two runs at identical
   configuration and identical shot order differ on **50-70% of pixels at a mean of 17-27/255**,
   because dust and particle VFX reseed per session even with the sim clock paused. A
   `THROW_MAX` change was nearly shipped on the strength of eyeballing two such runs; it looked
   convincing and was entirely reseeding. **A/B must be interleaved in one session, both arms
   reported.** Any past finding judged by shooting twice and comparing needs re-checking.
   Two practical notes: whole-frame gradient energy agrees to under 1% across a change that
   alters nothing, so the *metric* is not what fails — the frames genuinely are not comparable;
   and re-shoot the base arm **last** in every run as a drift check, because that is the only
   thing that distinguishes "my change did nothing" from "my arms did not restore".
13. **A working feature and a hole in the stone are two measurements, and passing the first
   proved nothing about the second.** The wall traversal shipped green — `LinkKind.TowerPass`,
   `probe-walltraffic`'s traverse arm at 13/13, `probe-siege` asserting men stay on the
   stonework — while men walked through 11 m of solid tufa at every tower on Carthage and
   0.75 m of chamber wall at every tower on Rome. Nothing in the simulation could see it: a
   man on a crossing is kinematic and `elevated`, so he is exempt from collision by design.
   The only instrument that finds it is a ray fired **along the wall axis at chest height
   against the position buffers the renderer uploaded** (`tools/probe-towerpass.mjs`). Two
   sub-traps inside that, both paid for: keep a triangle on an **AABB overlap**, not on "a
   vertex is inside the test box" — Carthage's tower is one 20 m box whose side-face triangles
   have no vertex anywhere near walk level, so the first version dropped the whole tower and
   reported 5.73 m of clear lane through it; and report the **mean Y of the blocking
   triangle**, because three rounds were spent guessing whether a blocker was a lintel, a jamb
   or a tread when the number says which.
14. **Another agent's commit will land in your A/B window.** A Carthage draw-call comparison
   read +5 at every camera including `melee`, which cannot see the city — the signature of a
   caster, not of city geometry. It was two other agents' commits that had landed between the
   baseline worktree and the working tree. **Pin both arms to explicit commits in worktrees**;
   comparing a worktree against `HEAD` in a shared checkout is not an A/B.
7. **A number that cannot be true given its neighbour is this project's best bug detector.**
   Four silent no-ops have been caught this way: a probe arm reporting 0.000 beside a sibling
   reporting 9.7 (it flipped `renderer.shadowMap.enabled` without a recompile, and
   `USE_SHADOWMAP` is compile-time); the sun scoring as a *negative* light contributor; a
   metalness delta of exactly `0.0000` (the material already shipped `metalness: 1`); and a
   stale uniform lookup after a rename. In every case the arm never ran. Check the *shape* of a
   number before its value.
8. **The 1.42-1.47/255 shadow noise floor was a moving-world artefact.** Paused, the true floor
   is **0.000/255**. Every shadow result ever declared clean against that bar was declared
   against a world moving five sim ticks between frames.
9. **A typecheck is not proof of life.** Three commits stacked on a tree that white-screened.
   `tsc` cannot see a missing runtime method behind `?.`, an ESM binding error, or a temporal
   dead zone. Load the page, read `window.__game.ready`, and **capture `pageerror` and
   `console`** — without them a dead app is indistinguishable from a slow boot, and agents have
   lost hours to unexplained 180-second timeouts.
7. **A comment on this codebase is a hypothesis, not a fact.** Three found in one session:
   `atmosphere.glsl.ts` claimed "warm up-light" from a term with no hue, `probe-shadow.mjs`
   claimed `advance(1e-6)` was a microsecond when it was 0.13 s, and `jumpTo` implied a jump
   when it was a floated climb. When a measurement disagrees with what you can see, suspect the
   instrument first — that rule has now paid out five times.
8. `git clean -fd` in a verification worktree **deletes the `node_modules` symlink**; pass
   `-e node_modules`. **`git stash push -u` takes it too**, for the same reason — it is an
   untracked entry — and the failure lands one command later as `Cannot find package
   'playwright'`. A bare `sleep` is blocked in a backgrounded Bash call (exit 144) — use an
   `until` loop, and prefer the foreground for anything that must wait on a dev server.
9. Machine load makes frame timing meaningless — an *unchanged* tree has measured slower than a
   changed one. Use in-session interleaved A/B and report both arms. **Prefer the best block
   over the median**: contention is one-sided, so it can only add time, and the minimum over
   N blocks converges on the uncontended cost while the median tracks whatever else the machine
   is doing. `tools/probe-cost.mjs` reports both and flags the run when they disagree.
10. **Clearing `castShadow` does not switch the shadow pass off, and two probes think it
   does.** `LightingSystem.update` assigns `l.castShadow = lit` to every cascade light on
   *every frame* (line ~455), and lighting has order −100, so it runs before anything else can
   see the flag. The `shadowRender` knob and the `noshadowrender` arm in
   `tools/probe-perf-ab.mjs` are therefore silent no-ops, and any conclusion drawn from them
   should be re-checked. The working switch is `renderer.shadowMap.autoUpdate = false` with
   `needsUpdate = false`; `WebGLShadowMap.render` returns immediately on that and nothing in
   this codebase touches either. Signature of the fault, again: the arm reported the shadow
   passes at *exactly zero* draw calls.
11. **`EXT_disjoint_timer_query_webgl2` is available here and it does not work.** It is
   exposed by launching Chromium with `--enable-webgl-developer-extensions`, and it looked
   like the answer to a loaded machine. At `melee` it reports 51.2 ms of GPU per frame inside
   a block whose wall clock, drained by `readPixels` at both ends, is 16.1 ms — the GPU cannot
   spend three times the elapsed time of a drained interval. Its deltas are inflated in
   proportion: the post chain reads −35.5 ms against −6.0 ms of wall. Trust it for the *sign*
   of a difference and never for a millisecond.
12. **Carthage was unreachable at `7a313fe` and is the over-budget map at `b7d8aaf`.**
   `src/maps/carthage.ts` had `city: null` until the fabric merge, so no Carthage figure
   quoted from a running game before that was taken on that map. It is wired now, and its
   assault camera renders **242** at ultra: 134 colour + 85 shadow + 23 post. The shadow pass
   is *cheaper* than Rome's and the triple wall is 25 visible meshes against Rome's 31, so the
   shared-material-stream technique works. The colour pass is the problem — `fabric` alone is
   **157 visible meshes**, about forty chunks at 5/3/1. Their LOD ladder works; there are just
   too many chunks. The lever is chunk count, and it belongs to `src/city/carthage/`.

## Round four — soldier material fidelity, and two rigs that disagreed

Branch `e/units/cloth-folds`, nine commits off `850843a`, **merged up to `bb789fe` and
re-verified there** — the bow and elephant-carcass workstreams both landed in
`src/units/soldierMesh.ts` while this was in flight and the merge was clean. Round three's critics scored mean
**0.83** with face 0 and all six criteria under 2, and handed down a ranked list: cloth folds
and silhouette, skin as vinyl, `shieldPanel`'s one tile across a 1.02 m board, a 13.1x texel
density spread, and a flat-255 regression on `praet-torso`. All five are addressed. What
follows is the part worth keeping.

### The whole result, both rigs

Ten isolated-model plates, `tools/probe-octave.mjs`, interleaved per plate against the tree
at `850843a`. Both arms shot with the same tool against two vite servers pinned to two trees.

Against `850843a`:

|  | median dR | dE1 | dE2 | dE4 | dE8 | dE16 |
|---|---|---|---|---|---|---|
| field preset (what every archived round used) | **−4.0 %** | −2.8 % | +0.8 % | +2.2 % | +2.8 % | +2.0 % |
| **Battle rig** (the product's own lighting) | **−1.7 %** | −0.4 % | +1.5 % | +1.0 % | +0.8 % | +1.1 % |

Re-run after the merge, against `bb789fe`, and it reproduces:

|  | median dR | dE1 | dE2 | dE4 | dE8 | dE16 |
|---|---|---|---|---|---|---|
| field preset | **−4.0 %** | −2.8 % | +0.8 % | +2.3 % | +2.6 % | +1.6 % |
| **Battle rig** | **−1.9 %** | −1.3 % | +0.4 % | +0.3 % | +0.5 % | +1.1 % |

Pooled R median off `850843a`: field **1.393 → 1.293**, battle **1.157 → 1.130**. Reference
pool 0.520-0.621 unchanged. **The ratio falls while every mid band rises and the 1 px band
does not**, on both rigs, which is the one pattern `--selftest` proves a Gaussian cannot
produce.

Cost, measured rather than asserted:

- **Draw calls identical at all seven cameras** — 108 / 166 / 158 / 122 / 88 / 129 / 105.
- **LOD2 280 verts / 313 tris, unchanged**, both factions.
- LOD0 Rome 5296/4786 → 5480/4822 (**+0.75 % triangles**); LOD1 2616 → 2652 (+1.4 %).
  Germanic +12 tris. Every added triangle is a modelled shield grip, twelve per board.
  Round three paid LOD0 +11.2 % and LOD1 +8.5 %. Off `bb789fe` the same figures are Rome LOD0
  5170/4824 → 5354/4860 and LOD1 3072/2620 → 3218/2656.
- Whole-frame triangles identical at six of seven cameras; `romanline`, the only one with
  LOD0 men in it, 15.56 M → 15.67 M.
- Atlas resident, bake time and texture memory unchanged — no cell was added or resized.
- `probe-soldiermesh` 0 / 4822.

**One correction against this pass's own commit messages.** `a50eb87` quotes "R median
1.393 -> 1.245". 1.245 is the *median of the per-plate ratios* at that commit; the pooled R
median `probe-octave` prints was **1.294**. The per-plate median dR of -7.0 % in the same
message is right. Read the table above, not that line.

### Three things that only the Battle rig could see, and one instrument fault

**Grade under Battle rig or you will ship the opposite of what you measured.** The first four
commits measured −5.9 % median dR under the studio `field` preset and **+6.3 % under the
Battle rig**, with dE1 +19.5 %. The mechanism is that `field` is three weak hand-rolled lights
and the battle rig is a physical sun at 2.93 through `KIT_CAVITY_PARS`, which gates *direct*
light on the cavity — so every hard edge in a height field becomes a hard-edged shadow rather
than a slightly darker patch. Three faults were invisible under the studio preset:

1. **`WoodPlank`'s seam was a binary step**, `abs(v * 6 - plank - 0.5) > 0.47 ? 0 : 1`. A step
   in a height field differences to a one-texel normal discontinuity at full amplitude.
   Survivable while one tile covered a whole board; catastrophic the moment the board tiled
   three deep. It is the critics' own "hard unbevelled creases", in the one material nobody
   thought to look at.
2. **And the bevel's *width* mattered more than its presence.** At 0.14 of a plank half-width
   the transition is three texels, which is 2.5 screen px — E1. At 0.34 it is seven texels and
   6 px — E2. That one constant moved the battle-rig median from +1.5 % to **−1.7 %**.
3. **The wood grain did not tile.** `vnoise(u * 4, v * 90, 4, 67)` is 22.5 periods against a
   lattice that wraps at 4. With one tile the discontinuity sat on the board's own edge;
   tiled three deep it put two hard lines across every scutum. 36 closes, and 90 was under the
   texture's own Nyquist at 2.8 texels a line anyway.

**`shoot-model.mjs --light=battle` is not reproducible on `juth-head`.** Two shoots of a
byte-identical tree agree to 0.0 % on nine plates and that one swings **dE1 +15.4 %, dE2
+13.2 %, dE4 +10.5 %, dR +2.0 %**. Twenty-four settle steps are not enough for it —
`LightingSystem` re-patches on a timer and the viewer builds lazily. Discard any battle-rig
delta on `juth-head` until someone fixes the settle. The `field` deck is unaffected and its
floor is still the recorded 0.11-0.30 % pooled.

### The octave arithmetic, so nobody re-derives it

A cycle count is not a screen size until the tile's world size and the plate's magnification
are in it. On this deck a man of 1.75 m fills 1056 logical px, i.e. 603 px/m, so one texel of
a 0.27 m wool tile is **0.64 screen px**. A DoG band at sigma s peaks around 2.2s to 4s:

    E1  ->  2-4 px   ->   3-6 texels   ->  40-85 cycles per 256 px tile
    E2  ->  5-9 px   ->   8-14 texels  ->  18-32 cycles
    E4  ->  9-18 px  ->  14-28 texels  ->   9-18 cycles
    E8  -> 18-35 px  ->  28-55 texels  ->   5-9 cycles

That table cost a round trip: a "nap" term at 44 cycles was added to fill the 4 px band, lands
at 3.7 px, and took R from 1.308 to 1.451.

### Findings worth carrying

- **A scalar height field can only produce an isotropic normal.** Central differences cannot
  tell a thread from a pimple. That is why every cloth surface has read as a *printed* weave
  for three rounds: `max(warp, weft)` is a lattice of bumps. `MatDef.slope` writes tangent
  slope directly, so a warp float tilts the normal in u only, which is what a cylinder does.
- **Twelve of twenty-nine tiles had a region with no roughness signal at all.**
  `roughness * (0.5 + (1 - h) * 1.05)` clamped into 0..1, and for anything authored above
  0.645 the clamp bit: elephant hide 48.7 % of its texels pinned at a flat 255, rope 43.0 %,
  fur 35.4 %, plume 23.9 %, mane 16.6 %, wool 15.3 %, hair 15.0 %, linen 11.9 %, oak 9.2 %,
  shield back 8.0 %, **shield board 6.3 %**, fine cloth 5.4 %. `praet-torso`, the plate round
  three recorded as blowing about 6 % of its area to flat 255, is more than half shield board.
  All 29 cells now measure 0.00 % at 255 in albedo, openness *and* roughness.
- **Fit a swing to the headroom symmetrically, not asymmetrically.** The first version capped
  `up` at the ceiling and spent the remainder downward, keeping the full peak-to-peak swing at
  the cost of the mean — wool 0.836 → 0.705, and hair, fur, plume and rope with it. Under the
  studio preset that looked free; under the Battle rig a glossier cloth is a sharper specular
  lobe and it cost dE1 +1.6 %.
- **`MeshBuilder.box` mapped one whole tile onto every face however small.** An 8 mm arrow
  shaft carried 31,250 texels/m against a bare leg's 570, which is most of the 13.1x spread.
  Those texels are not detail: 250 of them across the four screen pixels a shaft occupies is
  aliasing, manufactured by the mapping. `UvRect` now carries `m` from `MAT_TILE_M` and a face
  takes the share it covers, slid by a hash of its own position. **Spread 13.1x → 7.3x at
  LOD0, 14.9x → 7.5x at LOD1; total UV area per world area 133,665 M → 42,179 M.** It is a
  constructor option and only `buildSoldierGeometry` sets it, which is what keeps LOD2
  byte-identical and keeps the elephant, horse and engine builders out of it.
- **A material cell must not carry board-scale features.** The hide tile painted a handgrip at
  v = 0.5 and a turn-over at all four edges, which pinned `shieldPanel` at one tile across a
  1.06 m board — 236 texels/m along, the worst-sampled surface on the figure. The rim was a
  duplicate of binding modelled ten lines away; the grip is now twelve triangles that occlude.
- **Fold loops are free.** A radial two-harmonic modulation of a ring the tube already emits
  costs no vertex and no triangle, and a Nyquist guard drops it below six segments so the
  crowd tier cannot pay for it by accident.
- **Skin was one hue times a value ramp** and the second-flattest cell in the sheet at
  |n.xy| 0.112. A capillary-flush field driving the three channels apart is most of what
  stopped it reading as vinyl; the measured octave move is small and the visible one is not.
- **Exactly periodic armour is a *material* defect, not a variation defect.** Eighteen
  identical mail rings on a perfect grid is what a printed mail reads as, and the crowd
  already carries 57-59 kit masks. Per-ring jitter in gauge, position and tarnish, hashed
  modulo the lattice count so the tile still closes, moves the octave by 0.1 % and the
  character by a great deal.

### Still open, in the order a critic would name them

1. **Everything on an isolated plate is monochrome sepia** — helmet, shield, skin, ground and
   sky all in one narrow warm band. That is the grade and the rig, not the model, and it is
   the single loudest thing left in these frames. Rubric G2 explicitly calls a monochrome
   dust-beige frame a worse error than over-saturation.
2. **The head is a stack of hard-edged boxes.** The galea reads as blocks; the eyes are
   hard-edged cut-out ovals that stair-step on the lids; the nose is a faceted slab with a
   seam. Geometry, and the face *tile* still has a 256 px band it does not use.
3. **`praet-front` is the one plate still the wrong way under the Battle rig** (+5.5 %). It is
   scale armour and a scutum at full magnification.
4. **LOD2 still carries the 20.8x density spread** — deliberately, because byte-identity is
   the contract. Whoever is allowed to break it gets the same 3x reduction the near tiers had.
5. **`shieldPanel`'s rim UV is a diagonal line at v = 0.5**, so the binding samples a 1D slice
   of a 2D tile. It was already like that; it is now the least-authored band on the board.

## Grading

### CORRECTED — the face was inside out, and round two's fix pointed the deck at the back

**Read this before the section below it, which is wrong.** Round two's magenta measurement was
real and its conclusion was not. `revolve` derives its normal from the profile tangent as
`(-dy, dr)`, which points outward **only while y descends down the point list**. Every other
lathe on the man is written crown-first. `skullProfile` was written **jaw-first**, so its
normals pointed into the head, `quadFacing` derived matching inward winding, and
`side: FrontSide` culled the near half of every man's face — mean dot of winding with the
outward radial over the face arc **-0.324**, 76 of 123 triangles inward.

So the face was not dark, it was **inside out**: a camera in front of a man saw *through* it to
the inside of the back of his skull, at the back skull's depth, so every helmet bowl, hair dome
and beard between the two won the depth test. That is what produced "0 magenta at azimuth 0 and
121,407 at PI" — the tile was visible **only from behind him, through his own skull**. Adding
PI to `framePlate` therefore pointed all ten plates at his back *for real*, which is why every
head plate since has photographed a neck guard and a nape band, and why the deck looked
"materially harder". Reversing eight profile points takes the dot to **+0.540** and adds no
triangles; the same magenta measurement then inverts and strengthens to **466,141 face pixels
at the front against 0 at the back**. The PI is gone.

**Three passes have now got this sign wrong. The invariant is the measurement, not the sign:
paint `Mat.Face` magenta, sweep the azimuth, and the peak is the front.**

**`probe-soldiermesh` reports 0 disagreements on that piece and always did, and it is not an
all-clear.** It asks whether a shading normal opposes its own winding, and `quadFacing` derives
one from the other — so both faced the wrong way in perfect agreement. A whole class of
inside-out geometry is invisible to it. Test against an *outward radial*, not against itself.

Three more full revolutions fell out of the same audit, the same family as the four closed
domes: the **beard was a 360-degree hoop at mouth height** (82 % of Germanics and 42 % of
Romans had no mouth), the **spangenhelm brow band was a complete turn**, also at mouth height,
and the **fur cap was a full revolution** to y -0.045, so a capped Juthungi measured exactly
**0 face pixels**. All three Roman brow bands hung below the rim as 36 mm visors across the
eyes. The nose now projects 25.8 mm against a life-size 25, from 14.

Visible face-tile pixels at the shipped framing: `juth-head` **580 -> 157,649**, `legio-head`
**744 -> 84,782**. Both head plates now show eyes with whites, irises, pupils and lash lines,
brows, a nose with a shadow under it, and a mouth line. Still short: the eyes are hard-edged
cut-outs that stair-step on the lids, the nose is a faceted slab with a seam, and **the face
*tile* itself was never touched** — its low contrast against the skull's own ring creases, and
the 256 px band it now has and does not use, are the obvious next pass and are unblocked.

**Every azimuth in `shoot-model.mjs`'s plate table was picked while the camera stood behind the
man**, so anything he carries in front of himself was out of shot. `juth-head` is fixed
(-0.45 to +0.45; his javelin bundle stood between the lens and his nose, and it is the thing
that looks like pale shards across his face). **The other eight plates have the same latent
problem and nobody has audited them.**

### The isolated-model deck photographed the back of the man's head, every round

**Azimuth 0 was behind him.** `viewer/main.ts`'s `framePlate` documents "azimuth is measured
from the man's front", and `shoot-model.mjs` records that the first version of its plate table
had the convention backwards and "shot ten plates of a legionary's back" — the correction went
into the *table*, not the camera, so it swapped which plates were wrong and fixed none. With
the face tile painted magenta and one head shot at four azimuths, magenta pixels come to
**0 at azimuth 0 and 121,407 at PI**. The posed man faces **-Z**: the mesh is built facing +Z
(scutum socket z +0.20, nose z +0.075) and `iOrient.x` is 0 in the viewer, so the half-turn is
in the authored clips' root. Fixed in `framePlate`. **Every isolated-model grade before this
graded a man's back**, and the deck is materially harder now: on an unchanged model the octave
ratio goes 1.475 -> 1.734 purely from turning the camera round, because a front carries far
more pixel-scale structure than a back.

~~**`viewer.html` never loads `LightingSystem`.**~~ **CLOSED** — `Battle rig`, a third light
preset, registers the real `SkySystem` and the real `LightingSystem` through a shim
(`src/viewer/battleRig.ts`). Measured off `gl.getShaderSource` over every linked program, in
one session: studio 0 of 12 fragment programs carry `tcShadowGeom`, field 0 of 15, **battle 6
of 28**, and `shadowMap.type` is `PCFShadowMap` under all three. `studio` and `field` are
unchanged and stay — every archived plate was shot under one of them.

~~**`grade.ts` has already drifted from `PostFX`.**~~ **CLOSED** — the mirror is deleted.
`PostFX` exports `TC_TONE_GRADE_FRAG`, `TC_FINAL_FRAG`, `tcToneGradeUniforms()`,
`tcFinalUniforms()` and `MSAA_SAMPLES`; `grade.ts` imports all five. Pure hoists: the GLSL
differs only in leading indentation and every uniform default is the same literal, so the
shipping program is unchanged. The viewer binds `tBloom`/`tGod` to a 1x1 black texture at zero
strength, which is an exact no-op.

### The 12 `tcShadowGeom` errors do not reproduce at HEAD, and "12" was one program

Zero failing programs across nine arms — ultra/high/medium/low, Rome and Carthage, field and
assault, a 62 s battle, quality churn, a shadow-map recompile, the main-menu path and the
viewer — 124 fragment programs at maximum coverage, all clean. The mechanism is real and one
`shadowMap.type` away: the **declaration** of `tcShadowGeom` sits behind
`SHADOWMAP_TYPE_PCF && USE_SHADOWMAP && USE_CSM && CSM_CASCADES`
(`softShadow.glsl.ts:119`) while the **use** injected into `lights_fragment_begin`
(`LightingSystem.ts:319`) needs only the last three. Forced with `BasicShadowMap`, 14 of 25
patched materials fail — two of them soldier materials — and each failing program's log holds
exactly **12 `ERROR:` lines**: 4 unrolled cascades x 3 errors. So "12 identical errors" was one
program's dump at `CSM_CASCADES=4`, not twelve programs. It cannot fire today because
`LightingSystem.init` sets `PCFShadowMap` before any material carries `USE_CSM`. Fix it on the
*call* side — `CSM_SOFT_SHADOW_CALL` (`softShadow.glsl.ts:243`) should emit
`#if defined( SHADOWMAP_TYPE_PCF )` / the call / `#else` / stock `getShadow` / `#endif`. The
`SHADOWMAP_TYPE_PCF` term in the declaration guard is correct and must not be dropped: three
declares `directionalShadowMap` as `sampler2DShadow` only under PCF.

### Three closed domes, and no battle frame could ever have shown them

The same defect in three places, each hiding the thing under it:

- **`Piece.HairShort` was a full revolution** 4-9 mm proud of the skull running to y = -0.035 —
  below the brow, below both eye boxes, across the top of the nose. Every bare-headed man's
  face was sealed inside his own hair.
- **Every helmet bowl was a full revolution** down to y = -0.016, with the eyes at +0.024 and
  the brow at +0.050: Gallic, ridge, Coolus and spangen all enclosed both, and the reinforce
  below sat at jaw height binding nothing. The Gallic shell was also radius 0.109 over a skull
  of 0.082 — **27 mm of padding all round** against a real lining's eight or ten.
- **The "brow" box was at y = -0.012**, 55 mm below the real supraorbital ridge, so it lay
  across the eyes; the "jaw" box's front face at z = 0.0575 was *inside* a skull of radius
  0.0678 and drew nothing at all.

All three are fixed with one mechanism — `revolve` now takes an `arc`. The general lesson is
the one the inside-out normals taught: **a lathe is axisymmetric and a head is not**, so any
head part built as a full revolution is covering something.

**Still open, same family:** the Germanic `HairLong` is modelled as a curtain that closes over
the face from the fringe to the beard at every hash, which is why a Juthungi head plate cannot
photograph a face.

### A tile repeat ran backwards on every closed ring in the game

`MeshBuilder.tileUv` wrapped with `(s * repeat) % 1` **per vertex**, and a modulo between two
vertices does not wrap the surface between them — it runs the whole tile backwards, compressed
into one column. Even at `repeat = 1` every ring had one, because `tube`, `revolve` and `sweep`
close with `(s + 1) % segments` and reuse vertex 0. At `repeatU: 3` on the mail and scale
torsos, **three of ten columns** did it. `repeatStops` puts the seam on a duplicated vertex, so
it costs vertices and **not one triangle**. Two of the same family alongside it:
`box(..., repeat)` fed 0 and 1 through the same modulo, which is 0 for both, so every corner of
a repeated box face landed on **one texel** (five engine call sites); and five hand-rolled
grids outside the soldier still carry the defect, now behind the deliberately ugly name
`tileUvWrapped`.

### R measures the reference pool's upscale, not the model — stop steering by it

**This retires the target "drive R under 1.4".** `reference-crops/` is cut from the ten Rome II
press plates at **285x380 to 570x760 native** and lanczos-upscaled to 900x1200, i.e. **1.58x to
3.16x up**; our plates are shot at 1800x2400 and resampled 2x **down** to the same grid. That is
a three- to six-fold relative resolution difference between the pools, and it is most of what
R measures.

Proved by putting **our own unchanged plates through the reference pool's own chain** — no
model change at all, only the resampling:

| plate | native | up 1.58x | up 2.37x |
|---|---|---|---|
| praet-torso | 1.042 | 0.795 | **0.633** |
| legio-front | 2.411 | 1.421 | 0.859 |
| juth-front  | 1.363 | 0.848 | **0.630** |

The reference band is 0.520-0.621. Two of three of our own plates land in or beside it purely
from being resampled the way the reference was. HANDOFF already recorded that at each pool's
native size the two **overlap** (ours 1.29-2.13, Rome II 0.87-2.15); round two read the
normalisation as what "makes the separation clean". It is the other way round — the
normalisation *manufactures* it. Quote the separation as **confounded by resampling**, not as
100 % clean.

The practical consequence, measured three separate ways in one session and all agreeing:
**every change that makes our texture finer or more physically correct moves energy from E2
into E1 and R goes up.** Halving the material tile's world size: E2 -12 to -15 % on three
plates. Tripling the cloth weave toward a real 5 mm thread: E1 +21 %, E2 -8 % pooled. Moving
the weave's amplitude into an irregular slub: the same loss again. Two of those three were
reverted on the measurement, and the third was kept only because a texel-density fix was
landed underneath it. **Our atlas content already sits in the 2-4 px octaves at this
magnification; there is nowhere for added detail to go except the 1 px band, where the render's
own filtering throws it away and the upscaled reference has nothing to compare against.**

What is still worth using from this instrument: the **absolutes within our own pool**, and
`--repro`, which measured a floor here of **0.22 % worst plate and 0.05 % pooled** on this
machine — so it is a genuinely sharp differencer of our own tree against itself. What is not
worth using is R against the reference. Matching the two pools' native resolution before
measuring is the fix, and it means either shooting our plates at the crops' true pixel size or
finding press material at ours.

### "No normal map, no roughness map" was a starved sampler, not an absent one

Three independent critics named it and all three were reading the same real defect by the
wrong name. Both maps have been present for months. Arm-differencing the live material
(`tools/probe-kitmaps.mjs`, drift floor **exactly 0.00000/255**, base and base2 bit-identical)
puts numbers on it: deleting the normal map alone costs **8.8-21.5 % of E1** and changes
**33-64 % of figure pixels**; `flat-all` costs 35-47 % of E1.

The actual defect was **texel density**. At the isolated deck's magnification one atlas texel
covered **2.0 to 4.7 screen pixels** on a 128 px tile — the sampler is on mip 0 everywhere, so
nothing is mip-starved, everything is *magnified* and interpolated up. A bilinear smear and a
missing map are indistinguishable to an eye. Measured by piece at `praet-torso`:
Segmentata was at 2.0x magnification, Tunic 2.6x, Scale 4.1x, head and arms 4.7x. At 256 px
tiles that halves to 1.2-2.3x, which is where it now stands.

Two things fall out of this that are worth carrying:

- **Head and arms are the second-worst-sampled surface on the man** (1056 texels/m median),
  and that is part of why the face has no features. Texels, not paint.
- **Texel density varies 13.1x across one man's pieces** — bare legs 570 texels/m against a
  quiver at 7470 (`tools/probe-soldieruv.mjs`, which now reads the sheet size out of the live
  module rather than carrying its own stale copy). One man whose material grain changes
  thirteen-fold from piece to piece cannot read as authored.

### Every torso was tiled 1.8:1 stretched, and nothing tied a repeat to a surface

`repeatU`/`repeatV` were hand-written at each `tube` call with nothing connecting either to
the geometry. The mail body ran 3 tiles around a 0.87 m circumference and 4 along a 0.65 m
length — one tile covering **291 mm by 164 mm**, so a 9 mm riveted ring rendered as a
**16 x 9 mm oval** on every mailed man in the game, which is why a coif photographed as a
sheet of embossed lozenges. Scale ran 1.4:1, the tunic 1.5:1.

Fixed by `MAT_TILE_M` (how much of a man one tile of each material covers) plus `tileRepeat`,
which divides the surface's own mean circumference and path length by it. The segmentata torso
comes out **unchanged** at 453 x 449 mm — it was the one surface already square — which is the
check that the arithmetic is not inventing a correction. `MeshBuilder.repeatStops` clamps a
repeat to the division count on its own, so **LOD2 is untouched and still measures exactly 313
triangles / 280 vertices**.

Two traps found inside this, both now written into the code:

1. **Rounding a tile count can only go up or down, and on a small surface down is a long way.**
   A leg is 0.35 m round against a 0.27 m wool tile, so `round(1.3)` is 1 and the bracae came
   out 30 % *coarser* than authored. `tileRepeat` takes the old repeats as a floor.
2. **Correcting the size without adding texels measurably makes the plate worse** — it shrinks
   the same 128 texels into fewer screen pixels. That is why the sheet went to 2048 x 1536.

**Still open, same family, and it is the largest single surface on the man.**
`MeshBuilder.shieldPanel` maps **one tile across a whole 1.02 m board** — 4.4 screen pixels per
texel, by far the worst on the figure, and it is why a scutum's inner face photographs as a
featureless black smear across 12-20 % of two plates. It is also one of the five hand-rolled
grids still carrying the `tileUvWrapped` seam defect, so fixing the tiling and the seam is one
job. Not attempted here: seven call sites and a rim topology indexed by column, against a
shield whose boss was only just repaired.

### The metal F0 rewrite shipped half-applied

The long note above `IRON` argues that a conductor has no diffuse lobe and that its colour is
its measured F0, and the **albedos were duly raised** — iron 0.78, bronze 0.88/0.70/0.40. The
**metalness values were never moved**: iron 0.45, plate 0.5, bronze 0.74, mail 0.36, scale 0.52,
bands 0.48. That left every metal a soldier wears half dielectric with a metal's albedo, which
is the one combination that same note warns is worse than either end, and it is what
`praet-torso` photographed — a bronze squamata as one smooth extruded gold ribbon with no seam
between one scale and the next. All six are now at metalness 1, bronze at roughness 0.30.

The recorded counter-measurement ("raising metalness darkens armour, verified twice") does
reproduce as a fall in median plate luminance, largest on the two most metal-heavy plates. It
is the fix rather than the cost: what goes dark is the gutter between two scale rows and the
overlap under a girdle plate. **Moving one half of a two-variable change and leaving the other
is not the conservative choice, it is the worst point in the space** — worth remembering
generally, since it survived here for months behind a comment that described the whole fix.

### A "paused" model plate is not still

Found while building the arm probe, and it is a live hazard for anything that differences two
frames of the viewer. `viewer/main.ts` feeds the rAF delta to `soldierRig`, which advances
`uTime`, and `anim/skinShader.ts` adds a `sin(uTime * 0.55 + hash)` idle lean of +/-0.014 rad
about the feet — roughly +/-27 device px of head swing at `legio-front` — plus a cloak-hem
wave on the same clock. Two screenshots of the same plate are two different poses. Pinning
both (a constant rAF timestamp, and `uTime` pinned through
`renderer.properties.get(mat).uniforms`) takes an arm-differencing floor from **17.1/255 over
63 % of pixels to exactly 0**. Note this does **not** affect `shoot-model.mjs` decks, which
measured a `--repro` floor of 0.22 % worst plate in the same session — the harness controls it
per plate. It bites live-page probes only.

### Both viewer divergences are closed — read this before the two sections below it

`uGrain` is now **0.006**, matching `PostFX`. `uSharpen` had the same class of error and is now
**0.28**: it mirrored a *default* that `PostFX.ts:1530` overwrites from the quality tier every
frame, so the deck ran a value the product never uses. Every model deck this project has graded
before this was shot at 0.016, the level measured to leave 0.00 % of a plate reading as a
smooth region against Rome II's 7.09 %.

~~**The de-duplication was deliberately not done.**~~ **It is done now.** `PostFX` hoists both
shader bodies plus two uniform factories and `MSAA_SAMPLES` to module-level exports and
`grade.ts` imports them; the mirror is gone. `uExposure` remains pinned at 1 against `PostFX`'s
sky-driven 1.42-5.1 and is now the *only* tonal divergence left — closing it needs the battle
rig's sky, which exists, so it is a small and unblocked follow-up. The original text follows.
The right fix was to hoist `PostFX`'s two
shader bodies to module-level exports and delete the mirror — they are anonymous template
literals at `PostFX.ts:851-960` and `1095-1134`, referenced nowhere else in the file, so it is a
pure hoist. It was not attempted because the frame-budget workstream holds `src/render/PostFX.ts`
in its own worktree with 26 insertions against `b7d8aaf`, and losing that is a worse outcome
than a mirror with the drift now corrected. Two further divergences are recorded and unfixed:
`Grade` pins `uExposure` at 1 where `PostFX` drives it from the sky preset (**1.42-5.1** in
practice, the largest tonal divergence left), and `uTime` is pinned at 0 on purpose for
reproducible plates and must stay that way through any refactor.

~~**`LightingSystem` is still not loaded, and the map to load it is now complete.**~~ **Loaded.**
The map below was accurate and all four hazards were real; `src/viewer/battleRig.ts` answers
each in order and names them. Two things it found that the map did not: `Stage` set
`PCFSoftShadowMap`, which three has deprecated and warns about on every boot of the page, and
**`SkySystem.dispose` disposes the sky dome's geometry without removing the mesh from the
scene** — harmless in the game where dispose runs once at teardown, one leaked draw call and a
deleted index buffer in a viewer that can switch presets. The shim removes the dome by name;
`src/render/SkySystem.ts` should do it itself. Original map follows.

The viewer's
`Stage` builds three hand-rolled lights and sets `PCFSoftShadowMap` — a **third** shadow mode
that neither `Engine` (`PCFShadowMap` via `LightingSystem.ts:192`) nor the rig uses, so the deck
grades under fixed 3x3 PCF with one non-cascaded sun. `LightingSystem`'s constructor takes zero
arguments and `init`/`preRender` touch only `scene, camera, renderer, quality{tier,
shadowCascades, shadowMapSize}, rig.orbitRadius, tryGet('sky')`, so a five-field shim is
enough — or copy `src/city/preview.ts`, which stands up a real `Engine` with `SkySystem` and
`LightingSystem` for exactly this reason. Four hazards, in order: `TC_CLOUD_SHADOW` is defined
unconditionally but its uniforms are only bound when a sky exists, so with no sky
`directLight.color` is multiplied by garbage and `cloudShadowsEnabled` is private with no
setter; `installShaderChunks` mutates `THREE.ShaderChunk` process-wide and throws if the CSM
call text does not match; every lit material must be patched or it renders 4x too bright, which
`discoverMaterials` only fixes on a 16-frame timer; and `Stage`'s own sun, fill and bounce must
be removed or the man is double-lit and the CSM light indices shift.

### The viewer drew a horse where the war elephant is, and the carcass had never been seen

The owner's report was literally true. `pushManOrRider` branched on `isCavalry(def)`, which is
true of `war-elephants` because the **simulation** wants the animal pushed and killed like a
mount, and the viewer put a Carthaginian on a bay gelding — with a readout underneath saying
"soldier mesh + horse mesh" and a comment claiming the fallback stood "until an elephant mesh
exists". It had existed for some time. `mountKind` is what picks the geometry; `isElephantUnit`
now asks it. **The general rule: a `unitClass` is a simulation fact and a render path is not
derivable from it.** Anything else keyed off `isCavalry` should be re-read with that in mind.

**The elephant's forward axis is +Z, the same as a man's, and it was measured.** Barding
centroid Z +1.22 m against the hide's +0.39 and the tower's +0.09; and a four-azimuth sweep of
the soloed barding in the flat piece-ID view reads **53,984 px at azimuth 0, 31,007 at PI,
14-15 k at the two profiles**. Azimuth 0 is in front of the animal's face.
`__viewer.elephantGroupZ()` exposes the cheap half so nobody re-derives it.

**Four things the carcass shows that no battle frame could** — ~~all in `src/units`/`src/anim`
and none of them the viewer's~~ — **all four now fixed** (`38d7b01`, `a0892ba`, `721b37f`,
`5d8705b`). Every symptom was real. **Two of the three named causes were wrong**, and both were
wrong in the same way: they were diagnoses from reading the code rather than from measuring the
thing the eye complains about.

- ~~The four legs never move through the whole death clip.~~ **They move a lot** — the knees
  fold 128 degrees and the hocks −104. The pose was **graded on bone positions** ("the lowest
  bone sits at +0.009 m, nothing is under the ground at all"), and a bone is not a leg: every
  limb here is a 0.42–0.60 m cylinder around its bone. Skinning the real geometry over the same
  clip and reading the lowest **vertex** says the left foreleg finished **1.05 m** in the air,
  the left hind **1.27 m**, the right foreleg **0.21 m under the turf** and the right ear
  **0.35 m** under it, with a worst point of **−0.88 m** during the fall where the right hock
  ploughed through the ground. That — two rigid parallel columns in the air over a buried
  foreleg — is the toppled table. Now +0.29 / +0.57 / −0.01 / +0.08, worst −0.21.
- ~~The tower is rigid-bound to `barrel`/`loin` while the hide skins differently.~~ **That bind
  cannot move anything.** Nothing but `root` carries a rotation track on the spine in *any*
  elephant clip, and a delta accumulates unchanged down the chain, so `croup`, `loin`, `barrel`
  and `withers` hold **identical** skinning transforms on every frame. Skinning the tower's own
  vertices with `barrel 0.72 / loin 0.28` against `barrel` alone differs by **0.000000 m at all
  26 frames**. The daylight was the *caparison*: two rings and six columns — **five quads** — at
  a fixed 0.70 m radius over a barrel that tapers, hard straight ends 60–80 mm proud of the
  flank, stopping short of the tower fore and aft, and a flat 0.34 m skirt on a horizontal hem.
  Rebuilt on the hide's own six stations. Found beside it: the two "girth ropes" were **straight
  vertical ribbons 1.44 m wide** driven through the animal, so all that was ever visible of a
  rope was the slivers where a flat plate leaves a round back — on a carcass, a pair of striped
  fins.
- **At 39 % of the fall the crew tumble through the animal's own back** — true, **0.278 m** deep
  at 33.5 %, measured against the posed hide. `CREW_THROW_ARC` is *not* the cause and is
  unchanged: all three axes ran on one **smoothstep**, and a smoothstep leaves the platform at
  **zero velocity**, so for the first third of the throw the man barely moved sideways while the
  animal rolled into him. Out on `t(2−t)`, down on `t²`: **0.080 m**, which is the measurement's
  own floor (a man *standing* in the tower reads 0.097, because the howdah's floor sits 0.21 m
  inside the hide and his boots are under the planking). Raising the arc to 0.85 with the old
  easing only reaches 0.157.
- **The chest bib was a rectangle** — six columns by four rows, four square corners, a straight
  hem. Ellipse narrowed at the throat, rounded at the bottom, hem of pointed lappets.

Cost of all four: **2,993 → 3,457 triangles** (+15.5 %, +7.4 k across sixteen animals), one
material, one piece each. **The whole elephant tier is still 5 draws** — 1 colour + 4 cascades —
at all four carcass cameras, measured interleaved (tier emitted against suppressed) in one
session on both arms: 96 / 101 / 115 / 101 with, 91 / 96 / 110 / 96 without, on `850843a` and on
the fix, **identical**. Determinism unchanged at both baselines.

**The instrument is the finding.** `tools/scratch/carc-skin-entry.ts` and
`carc-explore-entry.ts` skin `buildElephantGeometry()` over a clip in node — no browser, no dev
server, 40 ms a candidate — and report the lowest vertex per limb per frame. `carc-gap-entry.ts`
does the tower/hide separation and carries the bind control. `carc-crew-entry.ts` inverts the
spine's rigid transform and tests a crewman's body capsule against the swept ellipse the hide is
built from. **Sample the throw at 200 sub-frame steps, not at the clip's 26 frames**: the same
arm reads 0.278 against 0.584 depending on which, because the crossing aliases badly.

~~**Three restatements the viewer now carries and would rather not.**~~ **Exported, and one had
already drifted.** All eight — `CREW_THROW_START`, `CREW_THROW_LEN`, `CREW_THROW_ARC`,
`CREW_LAND_OUT`, `CREW_FALL_SIDE`, `CREW_GROUND_LIFT`, `MAN_POSE_VARY`, `LOD_FRACTION` — are now
exported from `src/units/UnitRenderSystem.ts` and imported by `src/viewer/`; the copies are
deleted, not synchronised. `src/viewer/soldierRig.ts` held **`CREW_FALL_SIDE = +1`** against the
render system's `−1`, so **every carcass frame ever shot in the model viewer threw the four crew
onto the flank the animal rolls away from** — the exact sign the render system spends two
paragraphs establishing, in the copy whose own comment said "if they ever drift, the symptom is
visible in one frame".

**Not ours, reported not fixed: `SkySystem.dispose` (`src/render/SkySystem.ts:959`) disposes
`this.background.geometry` and `bgMat` but never removes the mesh from the scene.** Harmless at
teardown; in a switchable viewer it leaves a draw whose index buffer has been deleted.

### The octave instrument, and the constants that do not transfer

`tools/probe-octave.mjs` measures 1/2/4/8/16 px band energy on figure pixels only and prints
R = E1/E2 **plus the absolute bands**, because a 0.7 px Gaussian takes R down 43.9 % *and* E2
down 19.2 % — R alone is gameable and the absolutes are the guard. `--selftest` proves it.
**Round one's constants are in different units and must not be quoted against these:** the
reference pool reads **0.520-0.621** here, not 1.20-1.35, because both pools are normalised to
900x1200 first. At each pool's own native size the same decomposition gives ours 1.29-2.13
against Rome II 0.87-2.15 — *overlapping*. Normalising is what makes the separation clean.

Reproducibility floor **0.11-0.30 % pooled, 0.58 % worst plate** over three shoots of a
byte-identical tree, so unlike trap 6's battle frames **cross-session A/B is valid on this
deck**. `report.json` records the commit but not the working tree, and two decks at one commit
can be different trees — hash `git diff HEAD -- src/` beside it.

**Our absolute mid-band energy is already above the reference's** (E2 1.78x, E4 1.28x). The
excess by band is 4.5x at 1 px and ~1.3x at 4-16 px — round one's coarse-scale parity finding,
reproduced by a second instrument. Read the absolutes *within* our pool only; the cross-pool
ratios are confounded by content and key and already run the "wrong" way.

### The isolated-model deck — a strictly better instrument, and it says 20/20

`tools/shoot-model.mjs` photographs **one soldier, large**, deterministically posed and framed
on a neutral ground, driven through `/viewer.html` so it renders the game's own geometry, atlas
and shaders. `tools/model-deck.mjs` pairs those against single-soldier crops cut from the same
ten Rome II press plates, re-encodes both pools through one encoder at one quality, balances the
counts, shuffles from a seed and writes the key outside the deck.

Why it is better: every earlier round graded a battle screenshot in which a man is a few hundred
pixels among nine thousand, and both round-23 graders sorted largely on terrain, vegetation and
framing. On the isolated deck **both graders scored 20/20 and tagged 20 of 20 mechanisms
[FIGURE]** — no call rested on background, and the adversarial grader proved it rather than
asserting it (see the one-pixel-spike note above). It also found things no battle frame could:
the inside-out normals, the culled box faces and the reversed shield boss were all found this
way within an hour, after surviving twenty-three blind rounds.

**Read `screenshots/*-key.json` for what a round was.** `report.json` records commit, argv, dpr,
output size and the full plate spec; `model-deck.mjs` refuses a source whose record is missing or
says `hud: true`.

The two known limits, both open: our plates stand on a neutral ground while the crops are cut out
of a battle, so background can sort the deck in a glance even though it is not load-bearing; and
the byte ratio between the pools is **0.51-0.53** (ours 60 KB against 118 KB at identical
quantisation tables), which is not an encoder leak but an honest measure of how much less
structure our figures carry.

### The battle deck

`tools/blind-compare.mjs` against `reference/rome2/` (ten Rome II press plates), built from
`tools/shoot.mjs --set=deck`. `reference/siege/` (25 user images) and `reference/rome3d/` (YouTube
stills) are **mechanics and layout reference only, never blind-deck plates** — mixed provenance
would flatter or unfairly penalise us.

### Round 23, the final round — 40 of 40, on a deck built to be harder

Run at `fc5ed39` (which is `023240d` plus the harness work) on `--set=deck`: ten frames, no
two sharing a follow target, two maps, hours 07:30-16:24, one frame at `high` rather than
ultra. Deck at seed 8813, 10 ours against 10 Rome II plates, all three gates passed.

**Both graders scored 20/20.** A cold grader with no repo context, mean confidence 87.8, its
two least-confident calls at 58 and 68 (`deck-pydna-horizon`, which is nearly featureless
grass, and `deck-pydna-terrain`). An adversarial grader, mean confidence 91.2. Neither made
an error, and neither needed to be told the split was 10/10 — both arrived at it.

**The deck-independence fix did not move the result.** That is the useful finding. One map,
one hour and three near-duplicate pairs were suspected of inflating every earlier round;
removing all three changed nothing, so the separation was never resting on family
resemblance. Take the twenty-two earlier rounds' *accuracy* figures as unreliable and their
*direction* as confirmed.

**Neither grader led with aliasing.** Ranked cues, both graders independently:

1. **Shield and insignia authoring.** Flat discs and quads carrying crisp wear-free vector
   emblems, no boss geometry, no rim bevel, no wood grain, against press plates whose
   shields have a modelled spindle boss casting its own shadow onto the shield face. Both
   graders named this first or second and it is the one cue the cold grader said it could
   defend *mechanically* — "a canvas texture on a flat disc cannot fake wood grain plus a
   boss that casts onto the face, and I can point at those pixels."
2. **Faceless cloned characters.** "One head, one helmet, one torso, cloned across ~250 men";
   torsos read as stacked identical rings. **This is in direct tension with the measured fact
   below that the crowd carries 57-59 kit masks, 119 statures and 252 tunic colours.** Both
   are true: the variation is in the instance buffers and does not reach the screen. The
   defect is that faces and kit silhouettes do not vary, not that the data is missing, and
   "add more variation" remains the wrong fix.
3. **Untextured ground and flat-shaded architecture.** `deck-city` drew the single highest
   confidence in the deck at 98 — "untextured flat-shaded prisms, windows as painted
   rectangles, roof planes meeting in razor edges with no gutter, tile relief or dirt".
4. **No smooth region anywhere in frame.** The adversarial grader's strongest single scalar:
   percentage of 32x32 tiles with local Laplacian std < 1.0. Plates 0.31-15.10%, ours
   0.00-0.05%, **20/20 with nine of our frames at exactly 0.00**. It could not decide whether
   the mechanism is renderer dither or terrain polygon faceting, and said so.

**The honest caveat, from the adversarial grader and worth more than the score.** Nine of ten
plates are eye-level cinematic close-ups with sky, depth of field and dark blurred
backgrounds; nine of ten of ours are elevated RTS-camera field shots packed edge to edge with
vegetation. Every >90% tell it found is downstream of that. The anti-aliasing workstream
partially controlled for it — restricted to the top 20% most detailed 256px tiles the
separation *widened*, plates 0.516 against ours 1.953 — so it is not the whole story, but
**camera and subject distance are still not matched between the pools and that is now the
largest confound in the instrument.** Matching them pairwise, one class against the other at
the same angle and field of view, is the single highest-value change left.

**A protocol note nobody should have to rediscover.** The adversarial grader disclosed that
its session context automatically included a `git status` of this repository and recent
commit subjects, one of which said soldiers "read as clones" — a cue it then reported
independently. **A grader spawned inside this repo is never fully cold.** Its calls should be
treated as contaminated on any point the surrounding commits touch, and a genuinely cold read
needs an agent that has never seen the tree.

### The separation record, audited — do not quote the old number

**"Twenty-three rounds, twenty-three separations" was in every workstream's brief and it is not
a defensible claim.** It was audited frame by frame at `dd77a5f` because leak six raised the
possibility that some of those rounds had graded a UI overlay rather than a renderer. Here is
what the audit actually found, and it is a mixed answer.

**The HUD did not corrupt the record.** Every deck still on disk was measured with a detector
calibrated on a known HUD-bearing pass — per origin, the pixels static across every frame *and*
structured, minus the other origin's. The 18-shot pass with the interface up scores **0.837% of
frame**. All nineteen surviving decks score **0.000%**, and `screenshots/wallgeo-deck` was checked
by eye before its owner deleted it. So twenty decks are clean by measurement, not by assertion.

**But the denominator is wrong in three ways, and all three inflate it.**

1. **Nine of the nineteen surviving decks graded our renders against photographs**, not against
   Rome II — `eng-mech`, `mech-1/2/3`, and the engine agent's `deck-r0/r1/r2/r3/on`. A photograph
   and a render separate on sensor noise and depth of field whatever the renderer does. Those are
   real *accuracy* measurements ("does our scorpion match the archaeology") and they are not
   evidence about rendering. `blind-compare.mjs` now detects a photographic reference pool from
   source EXIF and prints `countsAsSeparationRound: false` into the key.
2. **Ten decks came from seven distinct shot passes.** `round1/2/3` are three seeds of the same
   eight siege frames; `rq-2903/5177/7331` are three seeds of the same six. Reshuffling a deck
   measures grader consistency, not the renderer.
3. **No ledger has ever existed.** There is no record anywhere in the repo of what the twenty-one
   or twenty-three rounds *were*. Roughly nine deck directories that existed at the start of this
   session — `blind-c1/c2/c3`, `blind-wall`, `critic1`, `plandeck-r1/r2/r3` — were deleted by
   their owners under the screenshot-cleanup rule and cannot be audited at all. One of them, a
   lighting deck, is independently known to be void: it was shot without `--nohud` and all three
   of its graders sorted on the faction-strength bar.

**The honest statement is: seven or eight independent render-quality passes against the Rome II
plates, every auditable one of which separated, plus one known void round and about nine rounds
with no surviving evidence either way.** That is still a real and consistent result — no
workstream has reached parity — but it is a seventh of the weight the old number implied. Quote
it that way. The named cause has moved five times: contact shadowing, material-boundary blend,
crowd clone repetition, luminance, and now **aliasing**, the first to separate cleanly as a single
scalar. A clean round does not imply parity and never has.

### The harness refuses decks now, rather than reminding people

**Seven leaks, and five were found by someone who was not looking for them.** Wordmark, camera
EXIF, a mislabelled key, file size, the quantisation tables that the file-size *fix* introduced,
the HUD, and the letterbox bars. Each was closed by a person resolving to be careful and the next
one arrived regardless, so `2cba66d` and `dd77a5f` replace care with refusal. Three gates, any of
which exits 3 and deletes the frames:

1. **Provenance.** `tools/shoot.mjs` now hides the HUD *by default* (`--hud` opts back in;
   `--nohud` still works and is a no-op) and records `hud: <bool>`, the tool, the argv, the dpr
   and the commit into `report.json`. `blind-compare` refuses any `--ours` directory whose record
   is missing or says true. **Missing is refused as firmly as true** — "nobody wrote it down" is
   exactly the state that produced leak six. Use `--pick=a,b,c` to grade a subset in place;
   copying frames to a new directory throws the record away and the deck will be refused.
2. **Overlay audit**, thresholds above. It also names the two other things that produce the same
   signature: a letterbox bar, and a side whose frames all share one camera.
3. **Invariants.** `bytes`, both quantisation-table sums and letterbox depth must be *identical*
   on every frame — an exact test, not a threshold, because with `--bytes=0` the raw sizes score
   0.850 balanced accuracy and slid under a 0.95 bar.

Leak seven was live when the audit ran: **`--fit=contain` letterboxes only the frames whose aspect
differs from 16:9**, which in `mech-1/2/3` is every reference photograph and none of our renders.
The comment claiming it "is not a tell" was wrong. Gate 3 catches it now.

**Leak eight is open and cannot be closed here.** Padding past the EOI defeats `wc -c`, not a JPEG
parser: scanning forward from SOS recovers the true compressed length in ten lines, and it sorts
the deck at **0.850** (ours 560,302 bytes against 349,225). Equalising it means either spending
fewer bits on our side — which is leak five, and manufactured the artefacts the critic was then
asked to grade — or burying the aliasing signal under matched grain. It is printed on every run
and it closes when the renderer stops carrying 1.7x the pixel-scale energy of a press plate. Note
that 1.7x and the harshness ratio of 1.137 against 0.427 are the same physical fact measured
twice; whoever closes the aliasing gap closes this leak for free.

Verified clean, so stop re-checking: the 20% bottom crop clears all ten wordmarks, and no EXIF or
ICC survives.

### Two biases in the instrument that run *against* us, both still open

- **Every graded plate in this project's history was rendered at one sample per pixel.**
  `ultra.maxPixelRatio` is 2, but the engine takes the minimum of that and
  `window.devicePixelRatio`, which headless Chromium reports as 1. The deck has been
  photographing a configuration the product does not ship, in the direction that flatters the
  reference — one sample per pixel is the worst case for the aliasing separator. `shoot.mjs
  --dpr=2` shoots the other arm; the default stays 1 so rounds stay comparable, and the value is
  recorded in `report.json` either way. **Nobody has measured the dpr-2 arm yet.**
- **The deck's 20% bottom crop removes our harshest band**, which is why the harness's own
  harshness numbers run about 1.2x lower than `tools/probe-harshness.mjs` measured on the
  uncropped frames. The crop is load-bearing for the wordmarks and must not be reduced, so the
  blind deck systematically *understates* the aliasing gap.
- **Every deck built before `f6aaaa6` was graded on a 1.25x upscale.** The 20% crop leaves
  1920x864 and the harness resized it back to 1920x1080 — a period-4.995 resampling comb an
  adversarial grader read straight out of the files. It never sorted the deck, because it was
  applied to both sides, but it means every round to date measured pixel-scale energy on
  interpolated pixels. Fixed: the output shape now follows the pools, the deck comes out
  1536x864, and the geometry is a pure crop (verified at 1.98/255 mean difference against an
  independent crop, which is q88 re-encoding and nothing else). Round 23 predates the fix.

### Known limitation, left open deliberately

`--set=deck` (`dd77a5f`) fixes deck independence on the shot side: ten frames, no two sharing a
follow target, six on the Campus Martius and four at Pydna, hours 07:30 to 16:24 against the
single 17:00 every earlier frame shared, and one frame at `high` rather than ultra. It was used
for the final round and nothing else has been. **The old sixteen-shot pool is still what every
earlier round used, so no round before this one was ten independent trials**, and their accuracy
figures are inflated by family resemblance to an unknown degree.

Two things were tried inside that set and rejected — do not retry them. Pydna at its 19:00 preset
renders at a few percent luminance with a blown sun blob and nothing else legible, which a grader
sorts as "the dark one". And the honest non-ultra frame must be `high`, not `low`: `maxSoldiers`
is 1,600 at low and 3,200 at medium against an order of battle of 8,632, so a low-tier frame
photographs a different battle and is sorted on headcount rather than filtering.

`reference/museum/` holds 41 licence-verified photographs (PD/CC0/CC BY/CC BY-SA, provenance in
`ASSETS.md`) for **accuracy only** — a grader separates photography from rendering on sensor noise
alone. `reference/rome2/` remains the sole battle-plate pool, still only ten plates, and that is
the weakest part of the instrument. Widening it was considered and not attempted: it needs
licence verification on each individual asset page, official sources only, and it is the single
highest-value thing left undone here.

### Reading a grader's answer

Ask for a label, a confidence *and the mechanism*, and then check the mechanism. A fresh critic
sorting an earlier deck gave "no normal or roughness maps" as its runner-up cue and was simply
wrong — both are present, and it was reading flatness as absence. A grader that gets the label
right for a false reason is a different result from one that names a real defect, and only the
second is a work item. Allow "I cannot tell" per frame and count it honestly; a forced binary on
twenty frames turns a coin flip into evidence.

### The atlas widening, priced

Measured with both arms interleaved in one browser session and the sim clock pinned so each
arm renders the identical men at the identical instant, on pinned detached worktrees at
`751dd0d` and `b7d8aaf`.

| | before | after |
|---|---|---|
| draws — wide / romanline / city / wall / skyline / melee | 131 / 153 / 200 / 211 / 178 / 135 | **identical** |
| whole-frame triangles, all six cameras | — | **byte-identical** |
| LOD2 triangles / vertices, all three factions | 313 / 280 | **313 / 280, bit-identical buffers** |
| LOD0 vertices, Rome / Germanic / Carthage | 5263 / 4528 / 7057 | 5297 / 4617 / 7091 |
| LOD1 vertices | 3132 / 2753 / 4388 | 3156 / 2805 / 4412 |
| soldier atlas resident | 25.17 MB | **50.33 MB** |
| asset textures, whole scene | 99.5 MB | **124.6 MB** |
| `buildSoldierAtlas` | 104 ms median | **309 ms median** |
| frame time, romanline and melee | — | **no measurable change**, every CI spans zero |

Two things the commit summary got wrong and the body got right. **"No vertex" is false** — tile
seams duplicate a vertex column, so LOD0 gains 34-89 vertices and LOD1 24-52, about +22 KB of
geometry across all nine builds. And **"texture memory only" is false**: the bake is 3.05x, so
+205 ms warm and up to +500 ms cold on a loaded machine, once at load.

**LOD2 keeping its tiling is provable rather than asserted.** Raw UVs must differ, because a
tile is now 256/1536 of the sheet and `matUv`'s 3-texel inset is 3/256 of a tile instead of
3/128. Divide both out into tile space and the LOD2 UV hashes are identical on both arms while
LOD0's and LOD1's differ, which is exactly the intended fix.

**Not this commit, but found by it: `romanline` is 153 draws against round two's recorded 139,
and it is already 153 at the merge-base.** `tools/shoot.mjs` is byte-identical between the r2
tip and `b7d8aaf`, so the camera did not move; the merge that pulled in the Carthage fabric and
the water surface is where the scene changed. `city` moved the other way, 218 to 200, for the
same reason. Neither figure is a soldier regression.

### Two more the carcass pass paid for

- **A pose graded on bone positions is not graded.** "The lowest bone sits at +0.009 m, so
  nothing is under the ground at all" was true, and the same clip had a foreleg 0.21 m and an
  ear 0.35 m into the turf and two legs 1.05–1.27 m in the air, because every limb is a
  0.42–0.60 m cylinder around its bone and the ear is a 1.05 × 0.68 m sheet hung off one. Skin
  the geometry and read the lowest **vertex** — it is forty milliseconds in node
  (`tools/scratch/carc-skin-entry.ts`), needs no browser and no dev server, and it is the only
  view that can see the thing the eye is complaining about.
- **A cause read off the code is a hypothesis; run the control.** Two of the three named causes
  in the carcass report were wrong, and each took one arm to retire: skinning the tower with the
  bind it was blamed for against a single-bone bind differs by **exactly 0.000000 m** (every
  spine bone in this rig shares one transform, because only `root` has a track), and raising
  `CREW_THROW_ARC` — the constant the crew defect was attributed to — buys 0.12 m where changing
  the easing buys 0.20 m. Same family as trap 7: a number that is exactly zero.

### Two traps the elephant-death pass paid for

- **A camera parked where a unit deployed is not a camera looking at that unit.** Every draw
  count in the elephant workstream before this was taken at the squadron's spawn point; by the
  time an animal dies the fight is a hundred metres away, so those frames photographed empty
  grass. `tools/probe-elefield.mjs` re-aims on the animal's own coordinates at every shot. The
  same probe now picks its victim by clearance from `veg-*` instance matrices, because the
  first run killed one under an olive and the close camera photographed the inside of the
  canopy — which reads exactly like "the carcass is not there".
- **`mesh.visible = false` cannot switch a soldier tier off**, and an A/B that does it reports
  a difference of exactly 0. `UnitRenderSystem.flush` assigns `t.mesh.visible = n > 0` from the
  instance count on every frame. Suppress the *emission* instead — override `pushElephant` on
  the instance — and `flush` hides the mesh itself. Same family as the `castShadow` no-op at
  trap 10 and the `shadowRender` knob, and the same tell: a number that is exactly zero.

---

## Session close — 18 Aug 2026

`main` **b255d58**, in sync with `origin/main`. **r5 deployed** at `850843a`
(https://total-claude.vercel.app); main is 8 commits past it.

### Landed since r5
- **`dc249b9` the bow.** Was 3-5 unrotated boxes per limb stepped along a curve. Now one
  continuous `MeshBuilder.sweep` with cross-sections on the curve's tangent. Three faults were
  invisible in the source: the recurve term `Math.max(0, t-0.78)` **never fired at LOD1** and
  fired once at LOD0, so there was no recurve; the bow was **strung backwards** (limbs bowed
  into the archer, string on the target side); and the string was **120 mm clear of both nocks**
  and out of the bow's plane, because the archery stance runs 26° off the man's facing. The bow
  was also the **worst-sampled surface on the man** at 12,800 tx/m. LOD2 bit-identical by hash.
- **`1573296` the elephant carcass.** Two of the four handed-down diagnoses were wrong.
  "The legs never move" — they do (knees 128°, hocks −104°); the pose had been **graded on bone
  positions, and a bone is not a leg**. Lowest *skinned vertex*: forelegs at **+1.054 m in the
  air** over a hind at **−0.213 m buried**. The howdah's "rigid bind" cause differs by
  **0.000000 m at all 26 frames** — it was the caparison, five quads as a ruled tent over a
  tapering barrel, plus two "girth ropes" that were **1.44 m wide ribbons driven through the
  animal**. The crew fix was not `CREW_THROW_ARC` but that all three axes ran on one smoothstep,
  leaving the platform at zero velocity.
- **`b255d58` cloth, skin, shield panel, texel density.** R falls while every mid band rises on
  both lighting rigs. Density variance **13.1x → 7.3x** (an 8 mm arrow shaft carried 31,250 tx/m).
  Flat-255 was **twelve of 29 tiles**, not one.

### Rules earned this session
- **Grade under the Battle rig, not a studio preset.** Four commits read −5.9 % under `field`
  and **+6.3 % under Battle rig** — opposite signs. Chasing it found `WoodPlank`'s seam was a
  **binary step**, that the bevel's *width* decides which octave it lands in (3 texels = 2.5 px
  = E1, the band we are trying to reduce; 7 texels = 6 px = E2, the band we want), and that the
  wood grain **did not tile**.
- **A bone is not a limb.** Grade a pose on skinned vertices.
- **A constant copied into the viewer will drift.** `CREW_FALL_SIDE` was `+1` there against
  `−1` in the render system, so every carcass frame ever shot in the viewer threw the crew onto
  the wrong flank. All eight are exported and imported now.
- `shoot-model --light=battle` is **not reproducible on `juth-head`** — 24 settle steps are too
  few; that plate swings dE1 +15.4 % between shoots of an identical tree. Discard its battle deltas.

### Open, nobody on them
- **Every isolated plate is monochrome sepia** — helmet, shield, skin, ground and sky in one
  narrow warm band. Rubric G2 calls this worse than over-saturation. **The next round is colour
  and head geometry, not texture.**
- **The head is a stack of hard-edged boxes** with cut-out oval eyes and a faceted nose slab.
- Rome's assault may still be unwinnable; the great wall-breaking ram is unbuilt.
- The gatehouse publishes no battlement, so men on the neighbouring bay cannot shoot.
- `SkySystem.dispose` disposes the sky dome's geometry without removing the mesh.
- Carthage's ditch is published but never cut; the heightfield does not excavate the harbours.
- `qa-interact`'s `__unitScreen` projects a unit anchor at ground+1 m — ~48 px above the men at
  some zooms — so `right-click move`/`attack` read as failing when they are not. **Harness fault.**

## Session — 19 Aug 2026: the siege made commandable, and four loose ends closed

Main went `4e3145f` → `f43f2ab` → `7340d02` → `fa0eefe`. Every merge was verified by the
integrator on the *merged* tree, not taken on the branch's word: `tsc` clean and `qa-deploy`
28/28 with both determinism arms identical, each time.

### Landed

- **`e/ui/wall-command`** (9 commits). Parapet units were unclickable for the entire
  deployment phase — `model.standY` read `battle.levelOf(id)`, and `unitY` is only written in
  `updateUnitCohesion`, i.e. inside `fixedUpdate`, which a paused deployment never runs. Now
  the median of nine living men: `standY 0 → 35.75`. The ground pick tested the *terrain point*
  under the cursor, costing 1.75/tan(pitch) ≈ 5.4 m of depth at battle zoom — more than a tower
  party is deep; both cases now test one plane at mid-body, crowd hit rate 60/180 → 77/200.
  `selectionIsStorming()` was **unreachable by construction**: a shallow field ray strikes the
  obstacle at median +4.55 against a band ending at +4.13, so `wallTargetAt` returned −1 every
  time; 45/148 → 133/148 masonry pixels now answer. Cursor `attack` was issuing a wall order.
- **`e/city/ditch-and-sky`** (8 commits). Carthage's ditch was published for four commits and
  never cut: relief 0.00 → **6.00 m median over 88 stations**, cross-checked against the field
  mean height (0.017 m predicted from the excavated volume, 0.0165 measured). The gatehouse's
  `masonryTopAt` returned merlon-top height flat across the whole footprint — 2.000 m too high
  on Rome, 2.100 m on Carthage, over 11 of 11.9 m of depth — and its merlon line was modelled
  solid; **2,832 of 2,832 straddling firing lines on Carthage opened**. `SkySystem.dispose`
  freed four resources with their owner still attached.
- **`fa0eefe`** — `TerrainSystem.dispose` carried the identical fault. Fixed for symmetry.

### Rules earned

- **A base arm pinned to the merge-base cannot distinguish a pre-existing fault from one main
  has since fixed.** A branch reported `qa-deploy` 26/28 and ran the correct control — but
  pinned it to its own branch point. Both arms failed identically, which is equally consistent
  with "not mine" and with "already fixed upstream". It was the latter: the harness fix had
  landed forty minutes earlier. Rebased, the branch was 28/28. **Pin the control to `main`.**
- **Do not grade a blind deck until its author declares it frozen.** Three graders were sent at
  a deck that looked complete — 14 pairs, README, key stored outside — and the builder tore it
  down minutes later on finding a wordmark leak. All three refused to fabricate picks, which is
  the behaviour to select for: a grader that feels obliged to find a difference will invent one.
- **Deck hygiene, from the graders' own reconnaissance:** never build a deck under `/tmp`
  (macOS reaps it, and it changed under a reader mid-run); nothing named `*key*` in the deck's
  parent directory; no sibling `report.json`; and if one side of a pair comes from a reference
  pool and the other from the live renderer, both must pass through an identical final resize
  and re-encode or resolution alone carries the answer.

### Measured, awaiting a decision

- **Rome's assault is winnable 2 of 12, and never by assault.** Both wins were cavalry riding
  through bays whose `BayStage` is `footing` — `blocksMovement` leaves 14 of 356 stations open
  by design, at x −551…−536, 369…389, 404…424. Checked, not believed: one "win" fired at t+857
  with nothing on the parapet since t+219.
- **Victory condition A is unreachable by construction.** `garrisonOnWall === 0` asks the
  attacker to empty ~50 bays of a 1.78 km circuit; Rome garrisons 810 and the best run left
  542. Scoping it to the bays the storm holds is ~20 lines in `BattleFlow.ts`.
- **The ram lands 0 blows in 12 of 12 runs.** `gateHp` 1.00, gate never touched, crew down to
  1 of 32 by t+80. The only implemented way to open Rome's gate. This is a defect, not balance.
- **The great wall-breaking ram: recommended against.** `spawnGreatRam`, `RamKind.Great`,
  `WALL_BLOWS = 74`, `strikeCurtain`, `breachBay`, `stormBreach` and the geometry all exist;
  four seams are missing (no `great-ram-crew` type, no roster entry with both sides at the
  20-unit cap, `spawnGreatRam` has zero callers, and `CityView.breachWall` is called at
  `Siege.ts:2856` but not implemented in `CitySystem`). A session across five files — and the
  *light* ram, fully wired, never lands a blow.

### Open, nobody on them
- **`Engine.dispose()` has no caller anywhere in `src` or `tools`.** Map switching is a page
  reload. Both dispose fixes above are correctness in a method the app never reaches.
- Every isolated model plate is monochrome sepia; the head is a stack of hard-edged boxes with
  cut-out oval eyes and a faceted nose slab. **Colour and head geometry, not texture.**
- A descent leaves the wall plan open and the unit `garrisoned`/`owned`, so the next order is
  read as a traverse and a unit that walked down cannot be sent back up.
- `moveAlongWall` accepts a run no link reaches and freezes the cohort until `PLAN_TIMEOUT`.
- `escalade` admits cavalry and wheeled artillery to a ladder's boarding file — 26 horsemen
  were measured standing on a parapet.
- Machine crews are offered "Storm the wall here"; the order is emitted and `escalade` discards
  it at `crewsAMachine`. The UI cannot tell — it needs a `Siege` predicate, as does the tower
  re-aim hint.
- `Siege.buildSpine` puts 22 of Rome bay 19's 36 stations inside the gatehouse footprint,
  6.574 m below the crown on curtain that was never built — 823 of 5,301 garrison shots in
  240 s, all discarded. `CitySystem.getGateBlock()` is published and waiting for it.

## Session — 19–20 Aug 2026: seven inside-out lathes, and four seams nobody typed

r6 shipped (`6698e19`, tagged, released, live). Main then ran `4e3145f` → `fa99e97`. The
technical documentation is published at **https://total-claude-docs.vercel.app** — four new
volumes (simulation, rendering, siege, tooling) plus the existing documents, built from
`docs/site/` with its own toolchain so it cannot touch the game's bundle hash.

### The largest finding: the face was being culled, and it was not alone

`revolve` derives its normal from the profile tangent as `(-dy, dr)`, which points outward
only while y **descends** the point list. Every lathe on the man is written crown-first and is
correct — except `skullProfile`, written jaw-upward. Its normals pointed into the head,
`quadFacing` derived matching winding, and **`FrontSide` culled the near half of every face**:
mean dot of winding against the outward radial **−0.324**, 76 of 123 triangles inward. A
camera in front of a man saw *through* his face to the inside of the back of his skull, with
every helmet bowl and beard between the two winning the depth test.

**Then the rewritten probe found six more.** The LOD2 skull at **−0.964** — 29 of 30 triangles
inward, on the LOD most of the army is drawn with, in `buildFarGeometry`, a different function
that reversing `skullProfile` never touched. Plus the sword pommel (−0.866), pilum head
(−0.608), sword point (−0.572), three javelin heads (−0.513) and the spear head (−0.444). A
static scan of every `revolve` literal agreed with the runtime result seven for seven.

**Why nobody could have found them.** `probe-soldiermesh` asked whether each triangle's shading
normal agreed with its own winding — and `quadFacing` derives the winding *from* the normal.
They agree by construction. It was asking whether `quadFacing` had run. It now welds vertices
by position, splits into connected components, and compares each triangle's **winding** normal
against the direction from its component's own centroid; shading normals are never read. The
bar is −0.15 rather than 0 because a flat sheet scores zero. Per *component*, not per piece:
`Piece.Head` is head and arms and hands, so the old per-piece centroid sat in the man's chest,
which is why its own `nrm.out`/`wind.out` columns gated nothing.

And one earlier "fix" was a correction *for* the bug: a pass measured "0 face pixels at azimuth
0, 121,407 at π" with the face painted magenta — visible only from behind the man, through his
own skull — and added π to the camera, pointing all ten model plates at his back. Reversed, the
measurement inverts: **466,141 face pixels at the front, 0 at the back.**

### Four cross-subsystem seams were broken, two of them for the life of the project

Consumers declare structural views of other systems to dodge import cycles, and nothing checked
that the two sides agreed. `getGateBlock` asked for `hw/hd/rot` against an implementation
publishing `nx,nz,dx,dz,halfRun,halfDepth`, so the gatehouse station clip never once fired
(0 of 22 stations clipped; now 22, and the garrison fires 3.4% less while killing 16.1% more).
`BattleAudio`'s `ProjectileView` had four of seven names wrong behind a `Partial<>` that erased
even the arity check — **fly-by arrow Doppler has never sounded**. `WeatherView` was missing
`windSpeed` and `rain` outright — **the ambience is weather-deaf**, cicadas through rainstorms.
And `WaterSurface` reads `postfx.depthTexture` at order −50 while PostFX allocates it at 900, so
**the soft-intersection fade has been compiled out of every shipped build**.

**The premise behind all of it was false.** `verbatimModuleSyntax: false` means a type-only
import is erased entirely — a graph edge for TypeScript, where circularity is legal, and no edge
in the bundle. A shared type was available for every seam the whole time at zero runtime cost.
The barrier was policy, not the module graph. There are now 15 compile-time witnesses
(`src/core/seamTypes.ts`) and a 20-seam runtime probe (`tools/probe-seams.mjs`), because three
of the four faults were invisible to a type: a lifetime, a registry name nothing answers to, and
a sparse pool iterated as dense.

### One predicate, three bug reports

The owner reported, months apart: men shuffling at a ladder foot, routed men running on the spot
at a wall, and a routed ram crew still pushing its ram. **One `broken(u)` predicate now serves
all three.** The shuffle was the whole queue rotating one rail per freed rung — `musterOwned`
dealt with `group[q % group.length]` where `q` counted only men waiting *that tick*, so every man
admitted or shot re-dealt everyone behind him: 147 reassignments in 5 s at a median 6.88 m, which
is exactly the rail pitch, men walking 5.98 m to gain 1.15 m. Now 0 reassignments, every movement
0.90 m. The rout case: `adoptBoarders` makes a party a garrison the instant one man tops the
parapet and `releaseBrokenCrews` skipped anything in `garrisons`, so a broken unit kept walking to
a slot frozen before it broke — 1.49 → 4.11 m/s, stalled man-ticks 11.1% → 0%.
**Side effect: escalade throughput roughly doubles**, 111 men over the parapet by t+40 against 47.

### Rules earned

- **Six simultaneous agent failures are one cause, not six.** The machine slept; the watchdog
  killed everything waiting on the wake-up spike, which peaked near load 100 while actual CPU use
  was about one core of sixteen. Exclude large scratch trees from Spotlight (`.metadata_never_index`)
  — 1.9 GB of trailer frames was being indexed.
- **A release body cannot pin images to its own tag.** The tag names the deployed bytes; the
  illustrations are committed after it. All fifteen of r6's raw URLs 404'd until repointed at the
  changelog commit.
- **A self-consistent instrument can never fail.** Compare against something outside the thing
  being checked — an outward radial, a rendered depth test, the other side of the seam.

### Open, nobody on them
- **`Engine.dispose()` has no caller** anywhere in `src` or `tools`; map switching is a page
  reload. Both dispose leak fixes are correctness in an unreachable method.
- **The gate breaks silently.** `Siege.ts` emits only a `cameraShake` for the collapse and
  `Synth.ts` has no `gate_*` recipe. The trailer's climax has the blows and not the break.
- **The clipmap flattens the ditch at range** — 6.0 m of relief survives to 96 m, 4.44–4.73 m at
  384–768 m, 2.31–3.12 m beyond. The ground the renderer draws diverges from the ground the men
  walk on by up to 4.3 m.
- **`shoot.mjs` labels a shot with `git rev-parse HEAD:src`**, so any frame taken with an
  uncommitted edit is stamped with the previous commit. `blind-compare` matches passes on that field.
- The environment art is now the loudest blind-grader complaint: greybox buildings, primitive
  foliage, untextured ground. Our frames are also **21% brighter than the reference plates**, and
  `lum` is the strongest single separator at 0.786.

---

## Session — 20–21 Aug 2026: the overnight pass, six reports closed, and Stage 0

64 commits since `r7`. Every item the owner reported is closed; two things nobody had asked about
turned out to matter more than any of them.

### The six reports

- **Units stuck on a wall.** A cohort is 41 m of frontage and a wall-walk is 3.25 m, so the
  formation solver put **45 men on one station** and drove them at a full walk into a crowd solver,
  forever. A unit on a wall is now a *file* the wall's depth. Worst pile 45 → 2; distinct standing
  points 17 → 104.
- **"Too late" on a tower party.** `crewsAMachine` asked *was this unit ever given a machine*, and
  the answer never changed. Once the ramp is down a tower's gang is infantry on a wall. Two more UI
  lies went with it, including a public refusal method with no caller.
- **Routed men half way up a ladder.** Rout, release and elevation were three per-man facts carried
  on one per-unit flag. Each man now resolves from where he is. Men still nailed after 10 s: 5 → 0.
- **Wall pathfinding.** `nearestStairLink` measured a straight line and ignored reachability —
  Rome's walk is four disconnected components, and runs 0–1 were handed a stair in another one.
- **Cavalry through a gate.** Routes planned for a 4.4 m corridor, executed by a 23.3 m wedge.
  Bodies in stone 30,098 → 4,615 man-ticks; crossings off the carriageway 3 → 0.
- **Catapult shot through a wall.** Not tunnelling: `masonryTopAt` had **no tower branch at all**,
  so 5 m of solid tower above every crest was transparent to projectiles. Coverage 62.3% → 99.0%.

### The two nobody asked for

**The determinism gate stopped 5.5 s before the only divergence anyone had measured**, and hashed
only the float32 pool while the float64 unit layer drifted from t+1 s unwatched. Now seven
checkpoints to t+400 and three hashes. Proof it was blind: the 222-site `Math.hypot` change moved
`uf64` at **21 of 21** checkpoints, and the old gate would have reported nothing happened.

**`buildLinks` computed the height it was bridging and wrote `void step;`.** Three of Rome's
crossings bridged more than the entire curtain — worst **7.70 m**, with **3.16 m of air** under the
men walking it.

### Rome

`ROME.md` landed at 2,764 lines. Phase A: the map into its own module; the Tiber onto the survey
(**775.8 m → 0.1 m** of survey error); the first graded bench Rome has had (worst bay step
**28.39 → 8.11 m**); reachable runs **28 of 45 → 43 of 45**; and 747 men taken back out of the
river the Tiber move had put them in, with `uctl` bit-identical at t+0 and t+30 as proof the
composition never moved.

### Multiplayer — Stage 0, roughly three and a half of five

No netcode exists and none should yet. Against `MULTIPLAYER.md` §3 Stage 0:

| # | item | state |
|---|---|---|
| 1 | `Math.hypot` → `sqrt` | **done in the simulation scope.** 222 sites. `src/sim`, `src/ai`, `src/city` clean; **27 remain in terrain and map generation**, 12 of them in `src/maps/carthage/heightfield.ts` |
| 2 | portability linter | **done, wider than designed** — `PORT_SCOPE` covers `src/city`, `src/terrain`, `src/maps`, with a ranked table (`tan` 41%, `hypot` 37%, `atan2`/`acos` 17%, `exp` 10%, `sin` 4%) |
| 3 | hash into the product | **done, 21 Aug** — `src/sim/stateHash.ts`, reached through `window.__game.hashes()` by `qa-determinism`, `qa-deploy`'s det arm and `qa-replay`. Arithmetic unchanged to the bit; no pin moved. See the next session |
| 4 | extend the gate past the cliff | **done**, t+250 and t+400 (the design asked for t+300/t+600) |
| 5 | **cross-engine arm** | **not done, and it is the one that matters** — the arm that goes red on Carthage's t+0 split and that would catch a Chrome patch |

The measurement that started it stands: all three engines run the default battle bit-identically
through every pinned checkpoint and **diverge at t+205.5**; Carthage's assault differs at t+0. The
cause is implementation-approximated `Math`; the float32 pool is a firewall holding ~6,000 ticks;
`UnitGroupState` is float64 with no firewall and had never been hashed.

~~**Next, and unstarted: Stage 1, the replay record.**~~ **Built the next morning** — see the
session below. Seed, config, and an order log stamped with execution ticks; measured at about
1.2 kB for a 226-second battle against the design's 1.1 kB; and it does catch a twenty-fourth
out-of-band mutation, which is checked rather than claimed by three arms of `qa-replay.mjs`
that break the battle on purpose.

---

## Session — 21 Aug 2026: the replay record, and the gate that watches the input paths

Branch `e/sim/replay-record`. Stage 1 of `docs/MULTIPLAYER.md`, plus Stage 0 item 3, which was
never done and which Stage 1 needed. No networking of any kind — the design is explicit that
realtime is a later decision to be re-made with better evidence, and nothing here touches it.

### What a record is

The seed, the config, and the order log with each order stamped with the tick it executed on.
`src/sim/replay.ts` holds the format, the codec and `ReplaySystem`, which sits at **order 5** —
ahead of `BattleSystem`'s 10, and therefore ahead of every `fixedUpdate` in the tree, so the
queue drains at the top of a tick and nothing a frame boundary does can move an order.

Four things ship from it and the fourth is the reason it was worth doing:

- **save** — `Save replay` on the end card writes a `.tcr`; drop it on the front door to
  watch it, which is the same string the link carries
- **share** — `Copy replay link` writes `?replay=<token>` to the clipboard
- **watch** — `?replay=<token>` boots the recorded battle and plays it
- **take command from here** — `&from=<seconds>`, or the `TAKE COMMAND` button. This one is one
  comparison in `ReplaySystem.pump`: withholding the rest of the log *is* taking over. The
  taken-over battle records itself from there, so it can be saved and shared in turn.

### `tools/qa-replay.mjs`, and why it is not another determinism gate

`qa-determinism.mjs` loads one build twice. Both of its runs take the same twenty-three
out-of-band writes in the same order and agree perfectly, so it can answer *does this battle
replay* and cannot answer *did the player's input reach the simulation through a path anybody
recorded*. The new gate boots through the front door with a real mouse, records what that
produces, and replays it in a fresh page **on a deliberately different frame schedule**.

**21/21, nine arms, port 5245.** Three of the arms are failures if they go green:

| broken on purpose | caught |
|---|---|
| one player order shifted **1 tick** later | pool hash at tick 900, the next 30 s checkpoint |
| an unrecorded `orderIssued` straight onto the bus at tick 3,203 | tick 3,600, by the product's own check |
| `UnitGroupState.width` written from outside a tick at tick 2,135 | tick 2,700 |

The design quotes four ticks of lateness as "already a different battle". **One is enough.**

### Two measurements worth keeping

**A 200-second battle is about 1.2 kB.** Measured over three runs of the same script — a real
mouse does not click the same number of times twice — 226.1 s, 2,247 men, 32/34/34 recorded
events, **1,188 / 1,219 / 1,224 B gzipped**, tokens of about 1,600 characters, 9 checkpoints
each. Scaled to exactly 200 s that is ~1.1 kB against the design's 1.1 kB estimate. Gzipped in
isolation the split is config 476 B, order log 423–451 B, checkpoints ~246 B, so **the order log
is 13.6–14.6 bytes an order** against the design's 11–13 B for a hand-rolled bit layout.
Over the same battle the `orderIssued` bus carried **3,258 AI orders against the player's 29**,
and the record has the 29 — which is what the `source` field is for.

**Frame grouping does not reach the simulation.** Three shipped comments say it does
(`Engine.ts`'s `advance`, `main.ts`'s `fastForward`, `qa-determinism.mjs`'s header). Held to an
**equal tick count** — which is what `Time.tickCeiling` and `Engine.advanceTicks` were added for
— a 6,783-tick battle carrying real recorded player input is bit-identical at 1000/6 ms (five
ticks a frame) and 1000/60 ms (one tick every two frames), at all nine checkpoints, on the
pool hash, both unit hashes
and `BattleFlow.result`. The three comments' *advice* is still right for the tools they sit in,
because those drive by seconds and a coarser step there runs a different number of ticks (900 at
1000/60, 901 at 166 ms, 899 at 1000/6). All three are now annotated with the real mechanism.

### The gate earned its keep on its first run

It found the bug `MULTIPLAYER.md` §4 warns Stage 4 about — *"round-trip your own orders through
the codec … the commonest real lockstep bug, and it appeared in none of the three designs"* —
twice, in Stage 1, in the deployment path. A right-drag placement was **recorded quantised and
applied raw**, and an absent coordinate was **encoded as zero**, which stood a whole regiment at
the world origin on playback. Both showed the exact signature the document predicts: `uctl`
matching perfectly while `hash` and `uf64` did not.

Positions in an order are therefore snapped to int16 over ±1400 m — 4.27 cm — **at the moment the
order enters the queue, in live play as well as in playback**, so the number the simulation
applies is the number the record carries. 4.27 cm against a 0.72 m rank pitch.

### What moved in the product

- **`src/sim/stateHash.ts`** — the gate's hash, in the product at last (`§1.10`'s last bullet).
  `qa-determinism.mjs`, `qa-deploy.mjs`'s det arm and `qa-replay.mjs` all read it through
  `window.__game.hashes()`. Arithmetic unchanged to the bit; all three battles, all seven
  checkpoints, `hash`/`uf64`/`uctl` unmoved. **Do not "fix" `poolHash` into real FNV-1a** — it
  multiplies with a float that rounds above 2^53 and twenty-one pins are keyed to that.
- **`orderIssued.source` is required**, so the compiler finds the sixteenth emit site. Fifteen
  today: seven in `SelectionController`, seven in `ai/Orders.ts`, one in `deployment.ts`.
- **`SelectionController`'s direct `u.width` write is gone**, as its own comment asked.
- **`issueHalt`'s two `Siege` countermands** run at the top of the tick the halt lands on,
  still before `BattleSystem` hears it — the documented ordering is not inverted.
- **`Time.tickCeiling`** and **`Engine.advanceTicks(n, stepMs)`**: run exactly n ticks at any
  frame schedule. Inert at -1, which is every other run in the project.
- **`vite.config.ts` reads `TC_VITE_CACHE_DIR`.** Every agent worktree symlinks `node_modules`
  at the shared checkout, so the default `node_modules/.vite` is one dependency cache written by
  as many vite processes as there are agents running a gate.

### The graphics tier is a simulation input, and only through one field

The video pass measured it as an outcome rather than a headcount — Campus Martius assault,
seed 4265438264, hard: **ultra 3,074 men, medium 3,009**; at ultra the ram crew dies 16 m short
of the door and lands nothing by t+520, at medium it lands 26 blows and the Porta Flaminia opens
by t+240. A record has to carry the tier or a replay watched at another one is a different
battle that will read as a determinism bug.

So the scope was checked rather than assumed, and it is narrow and well-typed:
`QualitySettings = SimQuality & RenderQuality`, **`SimQuality` has exactly one member**,
`maxSoldiers`. `Engine` freezes it at construction and re-asserts
`q.maxSoldiers = this.simQuality.maxSoldiers` after every patch, so a mid-battle tier press
cannot resize the army. Every read of `ctx.quality.*` across `src/sim`, `src/ai` and
`src/units` is either `maxSoldiers` — thirteen sites, all in `BattleSystem.init` and the two
`fittedUnitScale` calls in `scenario.ts` — or `lodFarDistance`, which is the impostor swap
distance. **Nothing else on the settings path reaches the simulation.** Pause and speed are the
other three UI writes to sim-adjacent state (`TopBar`, `HudSystem` hotkeys, `deployment`), and
they change how many ticks happen per wall second rather than what a tick does — which the
record is immune to by construction, because it is keyed to the tick index.

The record carries `quality`, the effective `unitScale` and `pool.count` at t+0; `?quality=` is
applied *before* `?replay=` is decoded so the record's answer overwrites it; and a token whose
army this run cannot field is refused by name. Two arms of the gate check exactly that.

### The other thing a gate must not be: pointable at nothing

`node tools/qa-determinism.mjs --battle=rome` appends a meaningless `&rome`, loads the
**default field battle**, looks up `baseline['rome']` which does not exist, compares nothing,
and exits 0. The three real invocations are no flag, `--battle="map=campus-martius&scenario=assault"`
and `--battle="map=carthage&scenario=assault"`; the headcount is the tell, 8,632 / 3,074 / 3,440.

`qa-replay.mjs` was written not to inherit that. An unknown flag or `--only=` arm exits 2. The
record arm asserts a headcount, a tick count and a checkpoint count before anything is compared,
because two empty checkpoint lists agree with each other. Every negative arm asserts that its
sabotage actually landed, separately from whether the battle then diverged. `remake` throws if
its edit changed nothing. A run that recorded zero checks fails.

### The playability rig had been broken for two days

`tools/scratch/pl-lib-emc.mjs` landed on 18 August clicking `[data-map=…]` as soon as the menu
appeared. The **front door** landed on 20 August (`8534b23`); `menu.css` hides `.menu-setup`
while `.menu` is `at-home`, and `startStep` only opens on the setup sheet for `?menu=battle` or
a URL naming a battle. `?autoplay=0` does neither. So all six playability scripts had been
unable to reach the setup rows, and nobody noticed **because none of them asserts anything**.

The click sequence now lives in `tools/lib/menu-boot.mjs` and is shared by the rig and by
`qa-replay.mjs`, which is the point: one menu-driving idiom, and the gate that asserts keeps the
rig that does not honest. `ensureServer` is there too — the rig never started a server, it
assumed one — and it `unref`s the child with an exit hook, because a live child handle was
holding those scripts open after their last line.

### Left on the floor

- **No build SHA.** Nothing in the bundle knows its own — `deploy-vercel.mjs` uploads a static
  tree with no build step — so a foreign build is refused by its **t+0 checkpoint** instead,
  which is a stronger test and cannot produce the link to an immutable deployment the design
  wanted. The field is in the format for whoever adds a stamp.
- **Every record commands Rome**, because `PLAYER_FACTION` is still a compile-time constant.
- **A record made at `high` is refused at `low`**, by name, rather than silently fitted to a
  smaller army. Right behaviour, bad outcome, and §7.5 of the design says so.
- The checkpoint grid is 30 s, so a playback can be up to 30 s of battle behind the fault it is
  about to report. Cheap to tighten if it ever matters; nothing suggests it does.

## Session — 21 Aug 2026: the game tells the truth about what it just did

Branch `e/fix/game-tells-the-truth`, off `main` at `58bc584`. Seven items from the gameplay
judge's round one (`docs/judge/GAMEPLAY-FINDINGS-R1.md` on `e/judge/gameplay`). Everything below
was proved by playing — the judge's own rig, `tools/judge/*`, driven at `advanceTicks(n, 1000/60)`
against a dev server on port 5901 in this worktree, with the `main` tree served on 5902 for the
before arm. Every figure is a before **and** an after.

### The rule the whole pass is an application of

**A derived number must be derived once.** Every one of these defects is a panel deciding
something the simulation had already decided:

| the panel decided | the arbiter already knew | what it printed |
|---|---|---|
| which victory condition fired | `finish()` raised it | *"The wall was carried"* under `HELD ×5` |
| whether a unit was lost | `unitsLost` counted it | **Held**, at 4 men of 160 |
| what the army was committed at | the roster at BEGIN | `−0` for a whole battle |
| whether an order would be obeyed | `Siege` refused it a tick later | nothing at all |

So four of the six fixes are the same fix: publish the decision, render it, and make the
compiler refuse a rendering that does not cover every case the arbiter can raise.
`WallCondition`, `unitOutcome`, `WallRefusal`/`WallVerb` and `Dispatch` are all `Record<>`s for
that reason — a new case does not compile until somebody writes what the screen should say
about it.

### What moved, measured

- **A routing man no longer counts as holding ground.** `censusWall` tested faction, `elevated`
  and alive; `UnitOrder.Rout` was not in it. `Siege.broken` — the predicate that already served
  the ram crew, the tower gang and the escalade party — moved to `types.ts` as **`isBroken`**
  rather than gaining a fourth private copy, and the census now excludes broken storm units from
  the run bins behind `stormHolding` (condition A) **and** from the pool walk behind `stormInside`
  (condition B). `stormOnWall` deliberately still counts them: it is a description of the parapet,
  and a man running along it is on it.

  > **This shipped half-wired at `85d6b7d` and the correction is `d61ef85`.** The `Set` of broken
  > unit ids was written and read nowhere: the exclusion was achieved by a `continue` that skipped
  > the lodgement binning, so it reached condition A — where it changes nothing, because
  > `stormHolding` has never been non-zero anywhere — and **not condition B, which is the
  > condition that decides every siege in this game.** The first write-up asserted the behaviour
  > intended rather than the behaviour shipped, which is worse than understating it, because the
  > next reader stops looking. A set with one writer and no reader is the shape of a fix that was
  > designed and not wired, and no compiler can see it: the write is legal on its own. The
  > implementation was not a one-liner *at the site* — the break-in walk iterates the soldier pool
  > and has no unit in hand — but it needed no new index either: `pool.unitId` is the canonical
  > owner of a man, written by `BattleSystem` at spawn and read by `unitOfSoldier`, `Combat`,
  > `Projectiles` and `Siege`, so the whole cost is one set lookup per living man of the storm.

  **Rome does not move, and this survives the wiring.** 8 seeds, hands-off, `jg-seeds`:
  `Defeat/objective` 8 of 8, decided 55/56/57/58 s, median 56, before, half-wired and wired — and
  `peak stormInside` is identical seed for seed (92, 68, 65, 81, 64, 71, 80, 69), which says the
  filter removed **zero** men at any point before the verdict. `jg-whoisinside` says why: at the
  deciding census **0 of 102 men inside belong to a routing unit**. The judge measured 46 of 46
  routing at t+200.9 on the integration tree, where the battle lasts long enough for the escalade
  to break; on `main` it is over at t+56, before anybody has broken. *The defect was real in the
  code and its Rome attribution does not hold on this tree.*

  **Carthage moves a great deal, and in the direction the rubric asks for.** 8 seeds, hands-off,
  same seeds, `main` against this branch:

  | | before | after |
  |---|---|---|
  | outcomes | Victory/objective 7, Victory/rout 1 | Victory/objective 6, Victory/rout 1, **Defeat/repulsed 1** |
  | decided at | 133-308, median **271** | 244-800, median **331** |
  | **first man inside** | t+92.8-95.6 | **t+236-262** |
  | gate opened | 7 of 8 | **8 of 8** |

  Seven of eight seeds land later and one is unmoved; none lands earlier, so it is a translation
  rather than a reshuffle. The line that matters is the third: the break-in used to happen at
  t+93, **123 seconds before the gate ram finishes at t+216**, and now happens after it. That is
  the judge's own "make the battle last long enough for its own machinery to arrive", arriving as
  a side effect of an honesty fix rather than of a balance knob — and the outcome mix goes from two
  values to three, with one seed now *losing* a siege that was won 8 of 8 before.
  `stormHolding` was 0 in every sample before and is 0 after: condition A has still never fired,
  and this makes it strictly harder, which is the honest direction.

  **Withdrawn: "Carthage moves 3.3 s."** That was measured on the half-wired tree, where the
  break-in count was untouched, so it cannot have been the census. The judge is isolating it at
  commit granularity; the likeliest cause is the 69-line order-refusal change in `78c164e`, which
  alters `interceptOrders` and can change what the AI does. Not re-derived here on purpose — two
  agents measuring one thing is how a number gets averaged instead of explained.

  **What would change my mind about the fix itself.** If `pool.unitId` were ever stale for a man
  whose unit had been rebuilt mid-battle, this would exclude the wrong men; `unitOfSoldier`
  guards against exactly that with an `id` check on its cache, and nothing else in the sim guards
  it, so if a unit-rebuild path is ever added the census is a site to re-check. And if a future
  pass makes `stormHolding` reachable, the condition-A half of this becomes load-bearing for the
  first time and wants its own measurement rather than inheriting this one.
- **The card no longer contradicts its own numbers.** `reason === 'objective'` covers two
  conditions and `wallBlock` named the one that never fires. `BattleFlowSystem.result.condition`
  now publishes which fired (`'parapet' | 'breakIn'`), and the sentence comes from a total map.
  Before / after on the same battle, from `jg-whoisinside`:
  > Rome, gate **never struck**, breaches **0**, 780 of mine holding the parapet, 71 inside:
  > *"The wall was carried."* → *"The wall itself was never carried — 71 of them are inside it,
  > and the fighting is in the streets."*
  > Carthage, gate **held at 73 %**, 11 storming against 1,140 holding: the same correction, at 60.
- **A refused wall order is refused out loud.** Two halves. `refreshWallOffer` turned exactly one
  of `traverseOfferAt`'s four answers into a sentence, so the cursor drew `wall` over three
  refusals it already knew about; it now covers all of them. And `interceptOrders` **discarded**
  the boolean from `moveAlongWall`/`sendToGround`/`sendToWall` and set the unit back to `Garrison`
  either way — the silence the judge measured as *0 m closed on four of four orders, `goal` never
  leaving `none`*. `Siege.refuse` now emits **`orderRefused`** and `EventFeed` prints it.
  Measured, one right-click with the army selected at Rome's west end: hint *"No way along the
  wall to bay 1 — the walk is broken in between"* **before** the button came up, then eleven
  `orderRefused` events (8 `traverse/noRoute`, 3 `ascend/noStair`) and plates reading *"Legionary
  Cohort I cannot — No steps reach bay 1 from the ground — there is no way up here"*. 6/6.
- **The casualty counter after ADD UNITS.** `initialStrength` latched on the first frame that had
  any views, which is the shipped twelve units, so a reinforced garrison read **`−0` for the whole
  battle** while men died. It now re-counts until `simTime > 0` — the deployment phase runs no
  fixed step, so the first tick is the first instant the order of battle is settled, and
  re-counting also gets *removals* right where a high-water mark would not. `jg-tryhard`, 20 units
  / 1,894 men: `−3`, `−12`, `−58` against the judge's thirteen samples of `−0`.
- **The field-battle note was dead text.** `else if (this.lastSiege)` can never be true in a
  battle with no wall, so `PHASE_UI[phase].note` had never been shown to anybody and the plaque
  read *"The lines are dressing"* from t+25 to t+1140. The guard now compares the **note** rather
  than remembering which source last spoke. `jg-pydna`: *"Ground is being closed"* → *"Arrows and
  pila in the air"* → *"Shield against shield"* → *"A line has broken"*, in step with the heading.
- **The dispatch cannot name an army that was not there.** Pydna's card said *"Macedon put her
  whole levy into one line"* and *"the pikes are still coming on in step"* in a game whose three
  armies are Rome, the Juthungi and Carthage. The cause is that **a field battle's opponent is
  chosen in the menu** — `opponentBlocked` greys that row only for a storm — so Campus Martius
  carried the same defect (*"nothing between the Juthungi and the Tiber bridges"* over a Punic
  host). Every dispatch line is now a function handed the enemy that was actually fought, and no
  line contains a faction literal. Rendered: *"The field belongs to the tribes"* → *"The field
  belongs to the Juthungi"*. `src/maps/pydna.ts` keeps its historical account of the *place*,
  which is a different claim and a true one.
- **The roll of honour agrees with its own headline.** `unitsLost` counted a unit under a quarter
  strength as lost; the roll had no word for that and printed **Held**. One function,
  `unitOutcome`, now answers both, and the missing word is **Mauled**. Rendered: *"Naked Fanatics
  I … 4/160 Mauled"* beside *"Units lost 3 of 19"*.
- **The playability rig can fail.** `tools/scratch/pl-*` polled nine class names for the end of a
  battle and the panel is `.rs-panel`, so **no playability run in this project's history had ever
  seen a battle finish**; and `fast()` advanced at 166 ms, which `Engine.advance`'s own comment
  says is a different battle. `pl-lib-emc.mjs` now carries `ledger`/`ck`, `ended()` on the real
  class, and **`mustEnd()`**, which fails a run that never reaches a verdict; `fast()` drives
  `advanceTicks(n, 1000/60)`. First run of `pl-runB` after the fix: *"result screen at t+145.6:
  Defeat — By objective"*, 2/2 checks. Deliberately the same design and the same names as
  `tools/judge/jg-lib.mjs` — **when `tools/judge/` lands, delete this rig rather than keeping two
  drivers for one menu.**

### The gate, and the one pin that moved

Green on this branch: `tsc` clean, `lint` 2/2, **`qa-deploy` 33/33**, **`probe-seams` PASS both
maps**, **`qa-replay` 21/21**, and all three determinism arms deterministic and green — headcounts
8,632 / 3,074 / 3,440, ports 5903-5907 in this worktree.

**One arm was re-recorded, in the commit that moved it: `map=carthage&scenario=assault`, t+400
only.** Pool `286731a8` -> `0c561598`, alive 2193 -> 2201, `uctl` `820eb4ff` -> `1ee7fd48`. A
`uctl` move is a real change in what the battle decided, not a portability drift. t+0 through
t+250 are unchanged to the bit on all three hashes, which locates the cause precisely: the storm
does not reach `BREAK_IN` until somewhere between t+250 and t+400, so nothing before that
checkpoint can depend on the count. Both loads of the recording run were bit-identical at all
seven checkpoints and the plain gate was re-run against the new pin afterwards — four independent
loads agreeing. The reason is written into the baseline's own `note`, as the standing rule
requires.

The other two arms are **UNCHANGED at all seven checkpoints** and were not re-recorded: the field
battle has no wall at all, and Rome's assault is decided at t+56 by men who are not routing.

**What these arms are worth as detectors, stated because their silence was nearly quoted as
evidence.** Only the Carthage arm can see a change to the break-in condition at all, and it can
only see it at **t+400** — the pinned Carthage battle is not the one the menu plays; it is still
being fought at t+400 with 2,201 of 3,440 alive, where a hands-off menu run of the same map ends
between t+244 and t+800. So "the pins did not move" was true of the half-wired commit for two
quite different reasons and would have been read as one. A pin is evidence about the battle it
pins and about nothing else.

### The replay's t+0 divergence, handed over rather than fixed

`e/net/session` owns this record. Not touched here; measured hard and written down.

`jg-replay --map=carthage` reports, identically on `main` and on this branch:

```
[replay] this record was made by a different build: the armies differ before a tick has run
(pool; recorded 8ca295e0/b835cac3/0b2dc55e, here fa60a0ea/b835cac3/0b2dc55e)
```

- **The record is right and the playback is wrong.** `8ca295e0` is also the pinned t+0 value in
  `tools/determinism-baseline.json` for `map=carthage&scenario=assault`. The playback's `fa60a0ea`
  agrees with nothing.
- Both unit hashes, `count` and `alive` are **identical**, so the two runs agree about every
  unit's anchor, facing, target, order, formation, width, alive count, membership and array order,
  and disagree only about where some men are standing inside those units — the four arrays
  `poolHash` reads.
- **Nine ordinary boots all give `8ca295e0`**: through the menu, `menu=0`, `deploy=0`, `deploy=1`,
  `autoplay=0`, `autoplay=1`, and BEGIN pressed at 0 / 60 / 200 / 900 / 2000 / 6000 ms. Only
  `?replay=` differs, and it differs stably. It is **not** dwell in the paused deployment phase,
  which was the obvious theory.
- The `BattleConfig` **round-trips through the codec byte-identical** — all 24 fields diffed,
  including the six order-of-battle tables and the seed. The record carries `deployPhase: true`,
  `quality ultra`, `unitScale 1`, `count0 3440`, and one `deploy` event; the playback is given a
  deployment phase.
- **`qa-replay.mjs` records only `campus-martius / field / high / small`** (l.246-252). No siege
  record has ever been through the gate, which is how it stays 21/21 while every shipped siege
  replay shows `DIVERGED` from the first frame. A Carthage-assault arm would have caught this.
- Consequence worth its own line: `divergedAt = 0` makes `.rp-badge` read **DIVERGED** for the
  whole playback, *including after TAKE COMMAND works perfectly* — a player who takes over a
  battle is told the entire time that it is broken.
- Probes used, all local and uncommitted: `x-poolt0`, `x-dwell`, `x-depflag`, `x-boot3` under
  `tools/judge/`. Rebuild them from this section if they are wanted.

### Rules earned

- **A finding measured past its own verdict is a finding about a different tree.** The judge's
  "both cities fall to men who are running away" was sampled at t+200.9 in a battle `main` ends
  at t+56. The defect in the code was real; the attribution was not, on this tree. Read the
  decided-at before quoting a census.
- **A collection with one writer and no reader is a fix that was designed and not wired.** The
  rout exclusion shipped reaching condition A, which has never fired anywhere, and not condition
  B, which decides every siege in the game — and the give-away was a `Set` written once and read
  nowhere, which no compiler flags because the write is legal on its own. **Grep your own diff for
  every name you introduced and count the reads.** The same test would have caught it in ten
  seconds and it took a second reader of the file instead.
- **Assert the behaviour you shipped, not the behaviour you intended.** The first write-up of that
  fix said it covered both conditions. A commit message that overstates a fix is worse than one
  that understates it: the next reader stops looking.
- **A refusal the compiler cannot see is a refusal that will not be written.** Three of
  `traverseOfferAt`'s four answers had no sentence for months because the call site tested
  `refusal !== 'noRoute'` instead of exhausting a union.
- **One reason, two verbs, two sentences.** The first cut of `orderRefused` printed *"no steps
  join bay 1 to the ground"* over three cohorts trying to climb onto it. The payload carries the
  verb now.
- `selectHard` picks a garrison off its own parapet on about half of attempts — five of eight
  units read "no pixel answers" in one run, and a marquee over the wall selected nothing at all.
  **`F` (select army) is the reliable real-input handle for a wall probe.**

### Left on the floor, with numbers

- **Rome is decided at t+56 on 8 of 8 seeds** (median 56, spread 3 s), by condition B, with the
  gate never struck and `stormHolding` at 0 in every sample. That is the owner's balance call and
  it is untouched here; the census is now honest about *who* does it, which is all this pass
  claims.
- **Carthage is now losable, and that is a balance consequence of an honesty fix.** One of eight
  seeds turns from `Victory/objective` at t+221 into `Defeat/repulsed` at t+800 — the storm gets
  45 men inside and cannot hold 60 there in order. **Reserved for the owner**: whether a siege the
  player attacks should be winnable on every seed. Nothing here was tuned to produce it; it falls
  out of requiring the sixty men to still be fighting, and the same change is what finally makes
  the gate ram matter (break-in t+93 -> t+245, against a gate that opens at t+216).
- Condition A has still never been non-zero anywhere. This change makes it harder, not easier.
- `jg-pydna` still reports `brief: null` on a field battle and first contact announced nowhere —
  both the judge's, both unowned.
